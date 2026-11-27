// Run: node tests/ac6d-workbench.cjs — synthetic mock protocol & SerialAdapter stream ports.
// 覆盖: js/ac6d-workbench.js 与 css/ac6d-workbench.css：
// 1) Ac6dToolPluginSpec 契约字段与 ToolPluginRegistry 自动注册；
// 2) 端口冲突检测（SerialHub / bluApi / ToolPluginRegistry.findPortOwner）、ownsPort / isBusy / busyReason / statusBadge、
//    SerialAdapter.createStreamPort 读错换流恢复、设备丢失清理、abortOpen 取消连接；
// 3) 一键「保存全部数据」4 步串行状态机（0x33 -> 0x40 -> 0x42 -> 裸发 A99A）、超时重试(1s/2s)跳过、透传 +3000ms 延长、
//    SK-CALIB-BIND schema_version 4 JSON 输出与文件名；
// 4) OTA 6 步自动升级状态机（原始 App.bin 自动内存封装 16B 头、0x20 -> 0x24 -> 0x22 分包 -> 0x25 CRC -> 0x26 完成 ->
//    主动 0x33 验证 / 15s 超时回退查询 / 透传 +3000ms 延长 / CRC 失配中止）；
// 5) 流量监控：正累计防回退保护（切换唯一号/手动重置解除）、4 倍频象限余数插值、脉冲计时 T0/T1/Δt/方向；
// 6) S 曲线 & 三锚点推算：0x40 清空旧锚点误差、推算同步至 S 曲线、0x41 写入后 3s 自动 0x40 回读 176B 字节比对（一致/不一致）；
// 7) 日冻结 0x37 自动翻页与 CSV 导出 + 无 innerHTML 模拟 DOM 挂载冒烟验证。
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SerialAdapter = require('../js/serial-adapter.js')
const WorkbenchMod = require('../js/ac6d-workbench.js')

// ---------------- 合成确定性虚拟时钟 ----------------
function createFakeClock(startMs) {
	let now = startMs || 1700000000000
	let nextId = 1
	const queue = new Map()
	const recordedTimeouts = []

	function setTimeoutFn(fn, delay) {
		const id = nextId++
		const ms = Math.max(0, Number(delay) || 0)
		recordedTimeouts.push(ms)
		queue.set(id, { id: id, at: now + ms, fn: fn, interval: null })
		return id
	}
	function clearTimeoutFn(id) {
		queue.delete(id)
	}
	function setIntervalFn(fn, delay) {
		const id = nextId++
		const ms = Math.max(1, Number(delay) || 1)
		queue.set(id, { id: id, at: now + ms, fn: fn, interval: ms })
		return id
	}
	function clearIntervalFn(id) {
		queue.delete(id)
	}
	async function flushMicrotasks() {
		for (let i = 0; i < 8; i++) await Promise.resolve()
	}
	async function advance(ms) {
		await flushMicrotasks()
		const target = now + ms
		while (true) {
			let earliest = null
			queue.forEach(function (item) {
				if (item.at <= target && (!earliest || item.at < earliest.at)) {
					earliest = item
				}
			})
			if (!earliest) break
			now = earliest.at
			if (earliest.interval != null) {
				earliest.at = now + earliest.interval
			} else {
				queue.delete(earliest.id)
			}
			earliest.fn()
			await flushMicrotasks()
		}
		now = target
		await flushMicrotasks()
	}

	return {
		now: function () { return now },
		setTimeout: setTimeoutFn,
		clearTimeout: clearTimeoutFn,
		setInterval: setIntervalFn,
		clearInterval: clearIntervalFn,
		advance: advance,
		flushMicrotasks: flushMicrotasks,
		recordedTimeouts: recordedTimeouts,
		clearRecorded: function () { recordedTimeouts.length = 0 },
	}
}

// ---------------- 合成 Ac6dProtocol 模拟（严格对齐 contract.md Section 3） ----------------
function crc16Ccitt(bytes) {
	let crc = 0xffff
	for (let i = 0; i < bytes.length; i++) {
		crc ^= (bytes[i] & 0xff) << 8
		for (let b = 0; b < 8; b++) {
			crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xffff) : ((crc << 1) & 0xffff)
		}
	}
	return crc & 0xffff
}

function createMockProtocol() {
	const CMD = {
		HANDSHAKE: 0x20,
		OTA_DATA: 0x22,
		OTA_ERASE: 0x24,
		OTA_CRC: 0x25,
		OTA_FINISH: 0x26,
		FLOW_FAST: 0x30,
		FLOW_QUERY: 0x31,
		ALARM_CLEAR: 0x32,
		DEV_INFO: 0x33,
		TIME_SYNC: 0x34,
		MODE_SET: 0x35,
		AUTH_BYPASS: 0x36,
		DAILY_FREEZE: 0x37,
		INIT_REPORT: 0x3f,
		CALIB_READ: 0x40,
		CALIB_WRITE: 0x41,
		PARAM_READ: 0x42,
		PARAM_WRITE: 0x43,
		LOG_READ: 0x44,
		RESET: 0x45,
		PARAM_RESET: 0x46,
		BASE_DEGREE: 0x47,
	}
	const STATUS = {
		OK: 0x00,
		ERROR: 0x01,
		TIMEOUT: 0x03,
		ADDR_ERROR: 0x04,
		FLASH_SIZE_ERROR: 0x05,
		CRC_ERROR: 0x06,
		INVALID_CMD: 0x07,
		ALREADY_MODE: 0x08,
	}

	const sentRecords = []

	function encodeMockEventFrame(evObj) {
		// 使用 JSON 载荷包在 0xEE / 0xEF 标记内供模拟 streamParser 无损拆包
		const body = Buffer.from(JSON.stringify(evObj), 'utf8')
		const frame = new Uint8Array(body.length + 4)
		frame[0] = 0xee
		frame[1] = (body.length) & 0xff
		frame[2] = (body.length >> 8) & 0xff
		frame.set(body, 3)
		frame[frame.length - 1] = 0xef
		return frame
	}

	function makeReqBytes(tag, opts) {
		const meta = { tag: tag, passthrough: !!(opts && opts.passthrough), opts: opts || {} }
		sentRecords.push(meta)
		// 首两字节区分：透传 A99A 开头，裸发 AC6D 开头，A99A 模组查询固定 A99A + 0x03
		if (tag === 'A99A_MODULE_QUERY') {
			return new Uint8Array([0xa9, 0x9a, 0x01, 0x00, 0x01, 0x03, 0x0a, 0x16])
		}
		if (meta.passthrough) {
			return new Uint8Array([0xa9, 0x9a, 0x02, 0x04, 0x07, 0xac, 0x6d, tag & 0xff, 0x16])
		}
		return new Uint8Array([0xac, 0x6d, (opts && opts.seq ? opts.seq : 1) & 0xff, 0x00, 0x02, 0x00, tag & 0xff, 0x11])
	}

	function createAnchorTable(direction) {
		const ratios = direction === 'rev'
			? {
				Q3: [[5.125, 1.52486], [3.125, 1.126852], [2.500, 1.0], [1.759, 0.85062], [0.881, 0.464002], [0.050, -0.402006], [0.040, -0.311988], [0.031, -0.162193]],
				Q2: [[0.025, 0.022171], [0.016, 0.266381], [0.013, 0.435608], [0.010, 0.725101], [0.008, 1.0], [0.006, 1.481685]],
				Q1: [[0.005, 1.0], [0.004, 1.318274], [0.003, 1.818428], [0.002, 2.4012698]],
			}
			: {
				Q3: [[5.125, 1.18627], [3.125, 1.068293], [2.500, 1.0], [1.759, 0.866279], [0.881, 0.466321], [0.050, -0.587719], [0.040, -0.409756], [0.031, -0.127193]],
				Q2: [[0.025, 0.05364], [0.016, 0.291793], [0.013, 0.459921], [0.010, 0.729701], [0.008, 1.0], [0.006, 1.448718]],
				Q1: [[0.005, 1.0], [0.004, 1.308235], [0.003, 1.844093], [0.002, 2.4330025]],
			}
		let idx = 0
		const out = {}
		;['Q3', 'Q2', 'Q1'].forEach(function (g) {
			out[g] = ratios[g].map(function (pair) {
				return {
					flow: pair[0],
					ratio: pair[1],
					isAnchor: pair[1] === 1.0,
					idx: idx++,
					error: 0,
					currentCoeff: 10000,
					newCoeff: null,
				}
			})
		})
		return out
	}

	function inspectFirmwareBin(u8) {
		const hasMagic = u8.length >= 16 && u8[0] === 0xa5 && u8[1] === 0xa5 && u8[2] === 0x5a && u8[3] === 0x5a
		if (hasMagic) {
			const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
			const bodySize = dv.getUint32(4, true)
			const bodyCrc = dv.getUint16(8, true)
			const productId = String.fromCharCode(u8[11], u8[12], u8[13], u8[14])
			return {
				hasHeader: true,
				magicOk: true,
				productId: productId,
				bodySize: bodySize,
				bodyCrc: bodyCrc,
				totalSize: u8.length,
				totalCrc: crc16Ccitt(u8),
				validForApp2: productId === '9091' && u8.length <= 0x6000,
			}
		}
		const bodyCrc = crc16Ccitt(u8)
		return {
			hasHeader: false,
			magicOk: false,
			productId: '',
			bodySize: u8.length,
			bodyCrc: bodyCrc,
			totalSize: u8.length + 16,
			totalCrc: bodyCrc,
			validForApp2: (u8.length + 16) <= 0x6000,
		}
	}

	function wrapFirmwareWithHeader(rawBody) {
		const image = new Uint8Array(rawBody.length + 16)
		const dv = new DataView(image.buffer)
		dv.setUint32(0, 0x5a5aa5a5, true)
		dv.setUint32(4, rawBody.length >>> 0, true)
		dv.setUint16(8, crc16Ccitt(rawBody), true)
		image[10] = 0xaa
		image[11] = 0x39 // '9'
		image[12] = 0x30 // '0'
		image[13] = 0x39 // '9'
		image[14] = 0x31 // '1'
		image[15] = 0x00
		image.set(rawBody, 16)
		return { image: image, info: inspectFirmwareBin(image) }
	}

	return {
		PROTOCOL_ID: 'ac6d-meter',
		OTA_APP2_ADDR: 0x8000,
		OTA_APP2_SIZE: 0x6000,
		OTA_HEADER_SIZE: 16,
		OTA_HEADER_MAGIC: 0x5a5aa5a5,
		OTA_PRODUCT_ID: '9091',
		CMD: CMD,
		STATUS: STATUS,
		STATUS_TEXT: { 0: '成功', 1: '失败', 3: '超时', 4: '地址/认证错误', 6: 'CRC错误' },
		CMD_INFO: {},
		sentRecords: sentRecords,
		encodeMockEventFrame: encodeMockEventFrame,
		crc16: crc16Ccitt,
		uidBytesToAuthCode: function (uid) {
			const hex = typeof uid === 'string' ? uid.replace(/\s+/g, '') : ''
			if (hex.length < 14) return null
			const b3 = parseInt(hex.slice(6, 8), 16)
			const b4 = parseInt(hex.slice(8, 10), 16)
			const b5 = parseInt(hex.slice(10, 12), 16)
			const b6 = parseInt(hex.slice(12, 14), 16)
			return ((b3) | (b4 << 8) | (b5 << 16) | (b6 << 24)) >>> 0
		},
		createAnchorTable: createAnchorTable,
		inferAnchorGroup: function (rows, anchorErr) {
			return rows.map(function (r) {
				const next = Object.assign({}, r)
				next.error = r.isAnchor ? anchorErr : Math.round(anchorErr * r.ratio * 10000) / 10000
				return next
			})
		},
		calcNewCoeff: function (cur, errPct) {
			return Math.trunc(cur * (100 / (100 + errPct)))
		},
		calcPointFlowRateLph: function (eq, deltaMs, coeff) {
			if (!deltaMs) return 0
			return (eq * 3.6 / deltaMs) * ((coeff || 10000) / 10000)
		},
		evalCalibErrorGrade: function (flowLph, errPct) {
			const lim = flowLph >= 30 ? 2 : 5
			const abs = Math.abs(errPct)
			if (abs <= lim) return { grade: 'ok', symbol: '✓' }
			if (abs <= lim * 1.5) return { grade: 'warn', symbol: '⚠' }
			return { grade: 'bad', symbol: '✗' }
		},
		inspectFirmwareBin: inspectFirmwareBin,
		wrapFirmwareWithHeader: wrapFirmwareWithHeader,
		buildModuleInfoQuery: function (_id, iotSeq, _now) {
			return makeReqBytes('A99A_MODULE_QUERY', { passthrough: false, iotSeq: iotSeq })
		},
		buildCalibBindFileName: function (userNumber, date) {
			return WorkbenchMod.helpers.fallbackBuildCalibBindFileName(userNumber, date)
		},
		buildCalibBindJson: function (payload) {
			return WorkbenchMod.helpers.fallbackBuildCalibBindJson(payload)
		},
		builders: {
			handshake: function (opts) { return makeReqBytes(CMD.HANDSHAKE, opts) },
			otaErase: function (addr, size, opts) { return makeReqBytes(CMD.OTA_ERASE, Object.assign({ addr: addr, size: size }, opts)) },
			otaData: function (addr, chunk, opts) { return makeReqBytes(CMD.OTA_DATA, Object.assign({ addr: addr, chunk: new Uint8Array(chunk) }, opts)) },
			otaCrc: function (addr, length, opts) { return makeReqBytes(CMD.OTA_CRC, Object.assign({ addr: addr, length: length }, opts)) },
			otaFinish: function (totalSize, totalCrc, opts) { return makeReqBytes(CMD.OTA_FINISH, Object.assign({ totalSize: totalSize, totalCrc: totalCrc }, opts)) },
			flowFast: function (opts) { return makeReqBytes(CMD.FLOW_FAST, opts) },
			flowQuery: function (sync, opts) { return makeReqBytes(CMD.FLOW_QUERY, Object.assign({ withTimeSync: sync }, opts)) },
			alarmClear: function (mask, authCode, opts) { return makeReqBytes(CMD.ALARM_CLEAR, Object.assign({ mask: mask, authCode: authCode }, opts)) },
			devInfo: function (sync, opts) { return makeReqBytes(CMD.DEV_INFO, Object.assign({ withTimeSync: sync }, opts)) },
			timeSync: function (d, authCode, opts) { return makeReqBytes(CMD.TIME_SYNC, Object.assign({ authCode: authCode }, opts)) },
			modeSet: function (mode, authCode, opts) { return makeReqBytes(CMD.MODE_SET, Object.assign({ mode: mode, authCode: authCode }, opts)) },
			authBypass: function (val, opts) { return makeReqBytes(CMD.AUTH_BYPASS, Object.assign({ bypassVal: val }, opts)) },
			dailyFreeze: function (startIndex, opts) { return makeReqBytes(CMD.DAILY_FREEZE, Object.assign({ startIndex: startIndex }, opts)) },
			calibRead: function (opts) { return makeReqBytes(CMD.CALIB_READ, opts) },
			calibWriteAll: function (obj, authCode, opts) { return makeReqBytes(CMD.CALIB_WRITE, Object.assign({ calibObj: obj, authCode: authCode }, opts)) },
			calibWriteSingle: function (dir, idx, coeff, authCode, opts) { return makeReqBytes(CMD.CALIB_WRITE, Object.assign({ dir: dir, idx: idx, coeff: coeff, authCode: authCode }, opts)) },
			paramRead: function (pt, opts) { return makeReqBytes(CMD.PARAM_READ, Object.assign({ paramType: pt }, opts)) },
			paramWriteBase: function (baseObj, authCode, opts) { return makeReqBytes(CMD.PARAM_WRITE, Object.assign({ baseObj: baseObj, authCode: authCode }, opts)) },
			logRead: function (lt, authCode, opts) { return makeReqBytes(CMD.LOG_READ, Object.assign({ logType: lt, authCode: authCode }, opts)) },
			systemReset: function (authCode, opts) { return makeReqBytes(CMD.RESET, Object.assign({ authCode: authCode }, opts)) },
			paramReset: function (level, authCode, opts) { return makeReqBytes(CMD.PARAM_RESET, Object.assign({ level: level, authCode: authCode }, opts)) },
			baseDegree: function (val, authCode, opts) { return makeReqBytes(CMD.BASE_DEGREE, Object.assign({ value: val, authCode: authCode }, opts)) },
		},
		createStreamParser: function () {
			let buf = new Uint8Array(0)
			return {
				reset: function () { buf = new Uint8Array(0) },
				push: function (chunk) {
					const merged = new Uint8Array(buf.length + chunk.length)
					merged.set(buf, 0)
					merged.set(chunk, buf.length)
					buf = merged
					const events = []
					while (buf.length >= 4) {
						if (buf[0] !== 0xee) {
							buf = buf.subarray(1)
							continue
						}
						const len = buf[1] | (buf[2] << 8)
						if (buf.length < len + 4) break
						const jsonBytes = buf.subarray(3, 3 + len)
						const rawFrame = buf.slice(0, len + 4)
						buf = buf.subarray(len + 4)
						const ev = JSON.parse(Buffer.from(jsonBytes).toString('utf8'))
						if (ev && ev.parsed && ev.parsed.detail && Array.isArray(ev.parsed.detail.raw176)) {
							ev.parsed.detail.raw176 = Uint8Array.from(ev.parsed.detail.raw176)
						}
						ev.rawFrame = rawFrame
						events.push(ev)
					}
					return events
				},
			}
		},
	}
}

function createMockPort(info, opts) {
	opts = opts || {}
	let sink = null
	let openResolve = null
	let openReject = null
	let closedCount = 0
	let failClose = !!opts.failClose
	const written = []
	const port = SerialAdapter.createStreamPort({
		getInfo: function () { return Object.assign({ path: '/dev/cu.usbserial-test' }, info || {}) },
		open: function (_options, s) {
			sink = s
			if (opts.hangOpen) {
				return new Promise(function (resolve, reject) {
					openResolve = resolve
					openReject = reject
				})
			}
			return Promise.resolve()
		},
		abortOpen: function () {
			if (opts.deferAbortSettle) return
			if (openReject) {
				const r = openReject
				openReject = null
				r(new Error('Aborted'))
			}
		},
		write: function (u8) {
			written.push(new Uint8Array(u8))
			if (typeof opts.onWrite === 'function') {
				const ret = opts.onWrite(u8)
				if (ret && typeof ret.then === 'function') return ret
			}
			return Promise.resolve()
		},
		close: function () {
			closedCount++
			if (failClose) return Promise.reject(new Error('Driver close busy'))
			return Promise.resolve()
		},
	})
	return {
		port: port,
		written: written,
		getSink: function () { return sink },
		getClosedCount: function () { return closedCount },
		setFailClose: function (v) { failClose = !!v },
		resolveOpen: function () { if (openResolve) { const r = openResolve; openResolve = null; openReject = null; r() } },
		rejectOpen: function (err) { if (openReject) { const r = openReject; openResolve = null; openReject = null; r(err || new Error('Aborted')) } },
	}
}

function createMockSerialAdapter(ports, opts) {
	opts = opts || {}
	const listeners = { disconnect: [], change: [] }
	return {
		isSupported: function () { return true },
		canEnumerate: function () { return true },
		listPorts: opts.listPorts || function () { return Promise.resolve(ports.slice()) },
		getPorts: opts.getPorts || function () { return Promise.resolve(ports.slice()) },
		grantPort: function () { return true },
		requestPort: opts.requestPort || function () { return Promise.resolve(ports[0] || null) },
		addEventListener: function (type, fn) { if (listeners[type]) listeners[type].push(fn) },
		removeEventListener: function (type, fn) {
			if (!listeners[type]) return
			const idx = listeners[type].indexOf(fn)
			if (idx >= 0) listeners[type].splice(idx, 1)
		},
		getListenerCount: function (type) { return listeners[type] ? listeners[type].length : 0 },
		emit: function (type, port) {
			(listeners[type] || []).slice().forEach(function (fn) { fn({ type: type, port: port || null }) })
		},
	}
}

// =========================================================================
// 执行全部回归测试
// =========================================================================
async function runTests() {
	let passed = 0
	async function test(name, fn) {
		await fn()
		passed++
		console.log('PASS:', name)
	}

	// ---- 测试 1: 插件规范契约 ----
	await test('Ac6dToolPluginSpec 字段与 ToolPluginRegistry 集成契约', async function () {
		const spec = WorkbenchMod.spec
		assert.equal(spec.builtin, true)
		assert.equal(spec.viewId, 'view-ac6d')
		assert.equal(spec.feature, 'view.ac6d')
		assert.equal(spec.hideTopbar, true)
		assert.equal(spec.icon, 'bi-droplet-half')
		assert.equal(typeof spec.mount, 'function')
		assert.equal(typeof spec.unmount, 'function')
		assert.equal(typeof spec.onActivate, 'function')
		assert.equal(typeof spec.onDeactivate, 'function')
		assert.equal(typeof spec.isBusy, 'function')
		assert.equal(typeof spec.busyReason, 'function')
		assert.equal(typeof spec.ownsPort, 'function')
		assert.equal(typeof spec.statusBadge, 'function')

		// 在独立 VM 沙箱验证自动注册到 ToolPluginRegistry
		let registeredId = null
		let registeredSpec = null
		const sandbox = {
			console: console,
			setTimeout: setTimeout,
			clearTimeout: clearTimeout,
			setInterval: setInterval,
			clearInterval: clearInterval,
			ToolPluginRegistry: {
				has: function () { return false },
				register: function (id, sp) { registeredId = id; registeredSpec = sp; return true },
			},
		}
		sandbox.window = sandbox
		const src = fs.readFileSync(path.join(__dirname, '../js/ac6d-workbench.js'), 'utf8')
		vm.runInNewContext(src, sandbox)
		assert.equal(registeredId, 'ac6d')
		assert.equal(registeredSpec, sandbox.Ac6dToolPluginSpec)
		assert.ok(sandbox.Ac6dWorkbench)
	})

	// ---- 测试 2: 端口冲突保护、ownsPort/isBusy/statusBadge、流错误恢复、断线与 abortOpen ----
	await test('端口冲突拦截（SerialHub/bluApi/ToolPluginRegistry）与串口流生命周期恢复', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const pHub = createMockPort({ path: 'COM1' })
		const pBlu = createMockPort({ path: 'COM2' })
		const pOther = createMockPort({ path: 'COM3' })
		const pFree = createMockPort({ path: 'COM4' })
		const pHang = createMockPort({ path: 'COM5', transport: 'ble' }, { hangOpen: true })
		const adapter = createMockSerialAdapter([pHub.port, pBlu.port, pOther.port, pFree.port, pHang.port])

		const alerts = []
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: adapter,
			serialHub: { busyOwnerOfPort: function (p) { return p === pHub.port ? { id: 'A' } : null } },
			bluApi: { ownsPort: function (p) { return p === pBlu.port }, isOpen: function () { return true } },
			toolPluginRegistry: {
				findPortOwner: function (p, opts) {
					assert.equal(opts.exceptId, 'ac6d')
					return p === pOther.port ? { id: 'custom-tool', name: '自定义工具' } : null
				},
			},
			appDialog: { alert: function (m) { alerts.push(m); return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})

		assert.match(ctrl.checkPortConflict(pHub.port), /通信调试/)
		assert.match(ctrl.checkPortConflict(pBlu.port), /功耗分析/)
		assert.match(ctrl.checkPortConflict(pOther.port), /自定义工具/)
		assert.equal(ctrl.checkPortConflict(pFree.port), null)

		const blocked = await ctrl.openPort({ port: pHub.port })
		assert.equal(blocked.ok, false)
		assert.equal(ctrl.ownsPort(pHub.port), false)
		assert.equal(ctrl.isBusy(), false)
		assert.equal(ctrl.statusBadge(), null)
		assert.equal(alerts.length, 1)

		// 正常打开空闲口
		const opened = await ctrl.openPort({ port: pFree.port })
		assert.equal(opened.ok, true)
		assert.equal(ctrl.ownsPort(pFree.port), true)
		assert.equal(ctrl.isBusy(), true)
		assert.equal(ctrl.statusBadge().conn, 'open')

		// 读流瞬态错误 -> Chromium 换流续读，连接不断开且后续数据照常解析
		pFree.getSink().error(new Error('FramingError'))
		await clock.advance(60)
		assert.equal(ctrl.isOpen(), true)
		pFree.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.DEV_INFO,
				typeOrStatus: proto.STATUS.OK,
				detail: { onlyAddrHex: '01020378563412', firmwareVersion: 'V3.1.0', mode: 1, modeText: '快速响应' },
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.device.onlyAddrHex, '01020378563412')
		assert.equal(ctrl.getEffectiveAuthCode(), 0x12345678)

		// 设备物理丢失（streams -> null），读循环安全收尾
		pFree.getSink().lost(new Error('Device lost'))
		await clock.advance(60)
		assert.equal(ctrl.isOpen(), false)
		assert.equal(ctrl.ownsPort(pFree.port), false)

		// 连接过程中取消（abortOpen）
		const openP = ctrl.openPort({ port: pHang.port })
		assert.equal(ctrl.isOpening(), true)
		assert.equal(ctrl.ownsPort(pHang.port), true)
		await ctrl.closePort({ manual: true })
		const resHang = await openP
		assert.equal(resHang.ok, false)
		assert.equal(ctrl.isOpening(), false)
		assert.equal(ctrl.ownsPort(pHang.port), false)
		ctrl.destroy()
	})

	// ---- 测试 3: 保存全部数据 4 步串行状态机 + 重试 + 透传延长 + SK-CALIB-BIND v4 JSON ----
	await test('保存全部数据 4 步串行状态机（0x33->0x40->0x42->裸发 A99A）、超时重试与 v4 JSON', async function () {
		const clock = createFakeClock(Date.UTC(2026, 10, 27, 4, 0, 0))
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM162' })
		const savedFiles = []
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			appPlatform: {
				service: function (name) {
					if (name === 'file-save') {
						return function (fileName, content) { savedFiles.push({ fileName: fileName, content: content }) }
					}
					return null
				},
			},
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})

		await ctrl.openPort({ port: mockPort.port })
		ctrl.state.passthrough = true // 透传开启：每步超时 +3000ms，但 A99A 必须裸发不二次封装！
		clock.clearRecorded()

		const savePromise = ctrl.startSaveAll()
		await clock.flushMicrotasks()
		assert.equal(ctrl.isBusy(), true)
		assert.match(ctrl.busyReason(), /保存全部数据/)
		// Step 0: 0x33，透传下超时应为 3000 + 3000 = 6000ms
		assert.equal(proto.sentRecords[0].tag, proto.CMD.DEV_INFO)
		assert.equal(proto.sentRecords[0].passthrough, true)
		assert.equal(clock.recordedTimeouts[0], 6000)

		// 应答 0x33（带匹配 seq）
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.DEV_INFO,
				seq: proto.sentRecords[0].opts.seq,
				typeOrStatus: proto.STATUS.OK,
				detail: { onlyAddrHex: '11223344556677', firmwareVersion: 'V3.1.2', temperatureC: 24, voltageV: 3.62, mode: 2, modeText: '校表' },
			},
		}))
		await clock.advance(300) // 步骤间 300ms 间隔
		// Step 1: 0x40，透传下超时应为 4000 + 3000 = 7000ms
		assert.equal(proto.sentRecords[1].tag, proto.CMD.CALIB_READ)
		assert.ok(clock.recordedTimeouts.includes(7000))

		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.CALIB_READ,
				seq: proto.sentRecords[1].opts.seq,
				typeOrStatus: proto.STATUS.OK,
				detail: {
					meterPulseEq: 17085, calibPulseEq: 1000, commPulseEq: 60000, fwdCount: 20, revCount: 20,
					fwdPoints: new Array(20).fill(100), fwdCoeffs: new Array(20).fill(10000),
					revPoints: new Array(20).fill(100), revCoeffs: new Array(20).fill(10000),
				},
			},
		}))
		await clock.advance(300)
		// Step 2: 0x42(0) -> 模拟连续超时，验证 1s 重试第 1 次 + 2s 重试第 2 次后跳过
		assert.equal(proto.sentRecords[2].tag, proto.CMD.PARAM_READ)
		await clock.advance(6000) // 第 1 次超时
		await clock.advance(1000) // 1s 后第 1 次重试
		assert.equal(proto.sentRecords[3].tag, proto.CMD.PARAM_READ)
		await clock.advance(6000) // 第 2 次超时
		await clock.advance(2000) // 2s 后第 2 次重试
		assert.equal(proto.sentRecords[4].tag, proto.CMD.PARAM_READ)
		await clock.advance(6000) // 第 3 次超时 -> 跳过 0x42 直接进入 Step 3 (A99A)

		// Step 3: A99A 裸发（passthrough=false）
		assert.equal(proto.sentRecords[5].tag, 'A99A_MODULE_QUERY')
		assert.equal(proto.sentRecords[5].passthrough, false)
		// 期间若收到无关 AC6D 帧，不得误推进 A99A 步骤
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.FLOW_FAST, seq: 99, typeOrStatus: proto.STATUS.OK, detail: { posVolumeUl: 1000 } },
		}))
		await clock.advance(500)
		assert.equal(ctrl.state.saveAll.running, true)

		// 收到真正的 A99A 模组信息应答（func=0x83 且 seq 匹配）
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'a99a-info',
			moduleInfo: {
				ok: true,
				func: 0x83,
				seq: proto.sentRecords[5].opts.iotSeq,
				deviceCode: '03115261005007',
				signal: { rsrp: -85, snr: 12, coverage: 0, csq: 24 },
				basic: { imei: '860000000000001', iccid: '89860000000000000001', userNumber: '00000003115261005007' },
			},
		}))
		await clock.advance(350)
		const res = await savePromise
		assert.equal(res.ok, true)
		assert.equal(savedFiles.length, 1)
		assert.match(res.fileName, /^0311526100_5007_N_N_N_N_N_N_N_N_N_校表数据_\d{8}_\d{6}\.json$/)
		assert.equal(res.record.schema, 'SK-CALIB-BIND')
		assert.equal(res.record.schema_version, 4)
		assert.equal(res.record['台位0'].statu['串口使能'], '使能')
		assert.equal(res.record['台位0'].statu['读取传感器信息'], '成功')
		assert.equal(res.record['台位0'].statu['读取远传模组信息'], '成功')
		assert.ok(res.record['台位0'].serial.serial_io.device_info.tx)
		assert.ok(res.record['台位0'].serial.serial_io.device_info.rx)
		assert.ok(res.record['台位0'].serial.serial_io.module.rx)
		assert.equal(res.record['台位1'].statu['串口使能'], '未使能')
		assert.equal(res.record['台位9'].statu['串口使能'], '未使能')
		ctrl.destroy()
	})

	// ---- 测试 4: OTA 6 步自动升级（原始 App.bin 自动封装 16B 头 + 透传 +3000ms + 主动 0x33 验证） ----
	await test('OTA 6 步自动升级状态机（含原始 App.bin 自动封装 16B 头与透传 +3000ms）', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM8' })
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		await ctrl.openPort({ port: mockPort.port })
		ctrl.state.device.firmwareVersion = 'V3.0.0'
		ctrl.state.device.onlyAddrHex = 'AA112233445566'
		ctrl.state.passthrough = true // 验证 OTA 超时全部 +3000ms

		// 构造 300 字节原始 App.bin（无 16B 头）
		const rawApp = new Uint8Array(300)
		for (let i = 0; i < rawApp.length; i++) rawApp[i] = (i * 7 + 3) & 0xff
		const inspect = ctrl.loadFirmwareBytes(rawApp, 'V3.1.5.bin')
		assert.equal(inspect.hasHeader, false)
		const wrappedDl = ctrl.buildWrappedFirmwareForDownload()
		assert.equal(wrappedDl.ok, true)
		assert.equal(wrappedDl.fileName, 'V3.1.5_new.bin')
		assert.equal(wrappedDl.image.length, 316)

		clock.clearRecorded()
		const startRes = ctrl.startAutoOta({ chunkSize: 128 })
		assert.equal(startRes.ok, true)
		assert.equal(startRes.autoWrapped, true)
		assert.equal(startRes.totalSize, 316) // 16B header + 300B body
		assert.equal(ctrl.isBusy(), true)
		assert.match(ctrl.busyReason(), /OTA/)
		await clock.flushMicrotasks()

		// Step 0: 0x20 握手（透传超时 3000+3000 = 6000ms）
		assert.equal(proto.sentRecords[0].tag, proto.CMD.HANDSHAKE)
		assert.equal(clock.recordedTimeouts[0], 6000)
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.HANDSHAKE, seq: proto.sentRecords[0].opts.seq, typeOrStatus: proto.STATUS.OK, detail: { firmwareVersion: 'V3.0.0' } },
		}))
		await clock.advance(300)

		// Step 1: 0x24 擦除 APP2 (0x8000, 0x6000)，透传超时 5000+3000 = 8000ms
		assert.equal(proto.sentRecords[1].tag, proto.CMD.OTA_ERASE)
		assert.equal(proto.sentRecords[1].opts.addr, 0x8000)
		assert.equal(proto.sentRecords[1].opts.size, 0x6000)
		assert.ok(clock.recordedTimeouts.includes(8000))
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_ERASE, seq: proto.sentRecords[1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(300)

		// Step 2: 0x22 分包下载（316B / 128B = 3 包：128 + 128 + 60）
		const chunksSeen = []
		for (let k = 0; k < 3; k++) {
			const rec = proto.sentRecords[proto.sentRecords.length - 1]
			assert.equal(rec.tag, proto.CMD.OTA_DATA)
			chunksSeen.push({ addr: rec.opts.addr, len: rec.opts.chunk.length, first4: Array.from(rec.opts.chunk.slice(0, 4)) })
			mockPort.getSink().data(proto.encodeMockEventFrame({
				kind: 'ac6d',
				parsed: { cmd: proto.CMD.OTA_DATA, seq: rec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
			}))
			await clock.flushMicrotasks()
		}
		assert.deepEqual(chunksSeen[0].first4, [0xa5, 0xa5, 0x5a, 0x5a]) // 首包必为 16B Header Magic
		assert.equal(chunksSeen[0].addr, 0x8000)
		assert.equal(chunksSeen[1].addr, 0x8080)
		assert.equal(chunksSeen[2].addr, 0x8100)
		assert.equal(chunksSeen[2].len, 60)

		await clock.advance(300)
		// Step 3: 0x25 整包 CRC 校验
		const crcRec = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(crcRec.tag, proto.CMD.OTA_CRC)
		assert.equal(crcRec.opts.addr, 0x8000)
		assert.equal(crcRec.opts.length, 316)
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_CRC, seq: crcRec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: { crcValue: startRes.expectedCrc } },
		}))
		await clock.flushMicrotasks()

		// Step 4: 0x26 OTA 完成 ACK 后进入 Step 5 等待 15s+3s=18s 复位
		const finRec = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(finRec.tag, proto.CMD.OTA_FINISH)
		assert.equal(finRec.opts.totalSize, 316)
		assert.equal(finRec.opts.totalCrc, startRes.expectedCrc)
		assert.ok(clock.recordedTimeouts.includes(18000)) // 15000 + 3000 透传延长
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_FINISH, seq: finRec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.flushMicrotasks()

		// Step 5 期间收到设备主动上报 0x33 -> 立即完成验证
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.DEV_INFO,
				seq: 0,
				typeOrStatus: proto.STATUS.OK,
				detail: { onlyAddrHex: 'AA112233445566', firmwareVersion: 'V3.1.5', mode: 1 },
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.running, false)
		assert.equal(ctrl.state.ota.progress, 100)
		assert.equal(ctrl.state.ota.lastResult.ok, true)
		assert.equal(ctrl.state.ota.lastResult.originalVersion, 'V3.0.0')
		assert.equal(ctrl.state.ota.lastResult.newVersion, 'V3.1.5')
		ctrl.destroy()
	})

	// ---- 测试 5: 正累计防回退、4 倍频象限插值与脉冲计时 ----
	await test('正累计防回退保护、4x 象限余数插值与脉冲计时 (T0/T1/Δt)', async function () {
		const clock = createFakeClock(1000000)
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM9' })
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		await ctrl.openPort({ port: mockPort.port })
		ctrl.state.calib.meterPulseEq = 16000 // 16000 / 4 = 4000 uL 每象限
		ctrl.state.device.onlyAddrHex = '00000000000001'

		// 开启自动脉冲计时
		ctrl.pulseTimingAutoStart()
		// 第 1 帧基准脉冲 = 100，体积 100000 uL，quadRemainder = 2 -> 插值 +8000 = 108000 uL
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.FLOW_QUERY,
				typeOrStatus: proto.STATUS.OK,
				detail: { posPulse: 100, revPulse: 0, posVolumeUl: 100000, revVolumeUl: 0, flowRateM3h: 0.1234, flowRateLph: 123.4, quadRemainder: 2, isFlowing: true, isReverse: false, pulseEqUl: 16000, flags: 0, mode: 1 },
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.flow.displayPosVolUl, 108000)
		assert.equal(ctrl.state.flow.rollbackGuarded, false)

		// 1.5s 后收到回退值（104000 < 108000）且脉冲跳变 100 -> 105
		await clock.advance(1500)
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.FLOW_QUERY,
				typeOrStatus: proto.STATUS.OK,
				detail: { posPulse: 105, revPulse: 0, posVolumeUl: 100000, revVolumeUl: 0, flowRateM3h: 0.1234, flowRateLph: 123.4, quadRemainder: 1, isFlowing: true, isReverse: false, pulseEqUl: 16000, flags: 0, mode: 1 },
			},
		}))
		await clock.flushMicrotasks()
		// 防回退生效：保持 108000 uL
		assert.equal(ctrl.state.flow.displayPosVolUl, 108000)
		assert.equal(ctrl.state.flow.rollbackGuarded, true)
		// 自动脉冲计时捕捉到正向跳变，记录 T0 且 pulseCount = 5
		let ptSnap = ctrl.getPulseTimingSnapshot()
		assert.equal(ptSnap.direction, 'pos')
		assert.equal(ptSnap.pulseCount, 5)

		// 再过 2.5s 脉冲到 112 -> Δt = 2.500s, pulseCount = 12
		await clock.advance(2500)
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.FLOW_QUERY,
				typeOrStatus: proto.STATUS.OK,
				detail: { posPulse: 112, revPulse: 0, posVolumeUl: 120000, revVolumeUl: 0, flowRateM3h: 0.2, flowRateLph: 200.0, quadRemainder: 0, isFlowing: true, isReverse: false, pulseEqUl: 16000, flags: 0, mode: 1 },
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.flow.displayPosVolUl, 120000)
		assert.equal(ctrl.state.flow.rollbackGuarded, false)
		ptSnap = ctrl.getPulseTimingSnapshot()
		assert.equal(ptSnap.pulseCount, 12)
		assert.equal(ptSnap.deltaText, '2.500')

		// 切换不同设备唯一号 -> 自动释放防回退基准，允许更低体积
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.DEV_INFO, typeOrStatus: proto.STATUS.OK, detail: { onlyAddrHex: '00000000000002', firmwareVersion: 'V3.1', mode: 1 } },
		}))
		await clock.flushMicrotasks()
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.FLOW_FAST, typeOrStatus: proto.STATUS.OK, detail: { posVolumeUl: 5000, revVolumeUl: 0, flowRateM3h: 0, quadRemainder: 0, isFlowing: false, isReverse: false, flags: 0, mode: 1 } },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.flow.displayPosVolUl, 5000)
		ctrl.destroy()
	})

	// ---- 测试 6: S 曲线、三锚点推算与 0x41 写入后 3s 自动 0x40 回读字节校验 ----
	await test('S 曲线 & 三锚点推算（0x40 清空旧误差）与 0x41 后 3s 自动 0x40 回读比对', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM10' })
		const verifyEvents = []
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		ctrl.onChange(function (topic, payload) {
			if (topic === 'calib-verify') verifyEvents.push(payload)
		})
		await ctrl.openPort({ port: mockPort.port })
		ctrl.setManualAuthCode('12345678')

		// 先人为填一个脏锚点误差，再收 0x40 -> 必须被清空防跨表串扰
		ctrl.setAnchorError('fwd', 'Q3', 2.5)
		const baseCalib = {
			meterPulseEq: 17085, calibPulseEq: 1000, commPulseEq: 60000, fwdCount: 18, revCount: 18,
			fwdPoints: new Array(20).fill(500), fwdCoeffs: new Array(20).fill(10000),
			revPoints: new Array(20).fill(500), revCoeffs: new Array(20).fill(10000),
		}
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.CALIB_READ, typeOrStatus: proto.STATUS.OK, detail: baseCalib },
		}))
		await clock.flushMicrotasks()
		const q3Anchor = ctrl.state.anchor.tables.fwd.Q3.find(function (r) { return r.isAnchor })
		assert.equal(q3Anchor.error, 0) // 旧误差已清空

		// 设定 Q3 锚点误差 = +2.0% 并推算
		ctrl.setAnchorError('fwd', 'Q3', 2.0)
		ctrl.inferAndCalcAnchor('fwd')
		// 5.125 点比例 1.18627 -> 误差 2.3725 -> newCoeff = trunc(10000 * 100 / 102.3725) = 9768
		assert.equal(ctrl.state.calib.fwdNewCoeffs[0], 9768)

		// 写入全部系数 (0x41)
		clock.clearRecorded()
		await ctrl.syncAnchorAndWriteAll()
		const writeRec = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(writeRec.tag, proto.CMD.CALIB_WRITE)
		const writtenObj = writeRec.opts.calibObj

		// 设备回 0x41 OK（匹配 writeSeq）-> 3000ms 后自动发 0x40
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.CALIB_WRITE, seq: writeRec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.flushMicrotasks()
		assert.ok(clock.recordedTimeouts.includes(3000))
		await clock.advance(3000)
		const readRec1 = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(readRec1.tag, proto.CMD.CALIB_READ)

		// 回读完全一致（raw176 与 readSeq 匹配）-> verify ok: true
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.CALIB_READ,
				seq: readRec1.opts.seq,
				typeOrStatus: proto.STATUS.OK,
				detail: Object.assign({}, writtenObj, { raw176: Array.from(WorkbenchMod.helpers.encodeCalib176Bytes(writtenObj)) }),
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(verifyEvents.length, 1)
		assert.equal(verifyEvents[0].ok, true)

		// 再次写入，但回读篡改 1 个系数 -> verify ok: false
		await ctrl.writeAllCalibCoeffs()
		const writeRec2 = proto.sentRecords[proto.sentRecords.length - 1]
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.CALIB_WRITE, seq: writeRec2.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(3000)
		const readRec2 = proto.sentRecords[proto.sentRecords.length - 1]
		const mismatch = JSON.parse(JSON.stringify(writtenObj))
		mismatch.fwdCoeffs[0] = 9999
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.CALIB_READ,
				seq: readRec2.opts.seq,
				typeOrStatus: proto.STATUS.OK,
				detail: Object.assign({}, mismatch, { raw176: Array.from(WorkbenchMod.helpers.encodeCalib176Bytes(mismatch)) }),
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(verifyEvents.length, 2)
		assert.equal(verifyEvents[1].ok, false)
		ctrl.destroy()
	})

	// ---- 测试 7: 日冻结自动翻页 + 无 innerHTML DOM 挂载冒烟 ----
	await test('日冻结 0x37 自动翻页与无 innerHTML 模拟 DOM 挂载', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM11' })
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		await ctrl.openPort({ port: mockPort.port })
		ctrl.startDailyFreezeAll()
		await clock.flushMicrotasks()
		assert.equal(ctrl.isBusy(), true)
		assert.equal(proto.sentRecords[0].tag, proto.CMD.DAILY_FREEZE)
		assert.equal(proto.sentRecords[0].opts.startIndex, 0)

		// 第 1 页（共 3 条，本页 2 条）
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.DAILY_FREEZE,
				typeOrStatus: proto.STATUS.OK,
				detail: {
					totalCount: 3, batchCount: 2,
					entries: [
						{ serial: 1, date: '2026-11-25', cumulativeL: 10.5, reverseL: 0, positiveL: 10.5, flowRateM3h: 0.5, temperatureC: 20.1, alarms: [], crcHex: '0x1111' },
						{ serial: 2, date: '2026-11-26', cumulativeL: 20.5, reverseL: 0, positiveL: 20.5, flowRateM3h: 0.6, temperatureC: 20.2, alarms: [], crcHex: '0x2222' },
					],
				},
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(proto.sentRecords[1].opts.startIndex, 2)

		// 第 2 页（末页 1 条）
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.DAILY_FREEZE,
				typeOrStatus: proto.STATUS.OK,
				detail: {
					totalCount: 3, batchCount: 1,
					entries: [
						{ serial: 3, date: '2026-11-27', cumulativeL: 30.5, reverseL: 0, positiveL: 30.5, flowRateM3h: 0.7, temperatureC: 20.3, alarms: ['低电压'], crcHex: '0x3333' },
					],
				},
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.freeze.autoReading, false)
		assert.equal(ctrl.state.freeze.entries.length, 3)
		const csv = ctrl.buildFreezeCsv()
		assert.match(csv, /2026-11-27,30\.50,0\.00,30\.50,0\.7000,20\.3,低电压,0x3333/)
		ctrl.destroy()

		// 模拟 DOM 挂载，严格禁止 innerHTML
		function mkNode(tag) {
			const node = {
				tagName: String(tag).toUpperCase(),
				className: '',
				textContent: '',
				value: '',
				title: '',
				type: '',
				hidden: false,
				disabled: false,
				checked: false,
				readOnly: false,
				dataset: {},
				style: {},
				childNodes: [],
				get firstChild() { return this.childNodes[0] || null },
				parentNode: null,
				classList: {
					toggle: function () {},
				},
				setAttribute: function () {},
				addEventListener: function () {},
				removeEventListener: function () {},
				contains: function () { return false },
				querySelector: function (sel) {
					if (sel === 'span') return this.childNodes.find(function (c) { return c.tagName === 'SPAN' }) || null
					return null
				},
				appendChild: function (c) {
					c.parentNode = this
					this.childNodes.push(c)
					return c
				},
				removeChild: function (c) {
					const i = this.childNodes.indexOf(c)
					if (i >= 0) this.childNodes.splice(i, 1)
					c.parentNode = null
					return c
				},
			}
			Object.defineProperty(node, 'innerHTML', {
				get: function () { return '' },
				set: function () { throw new Error('禁止在工作台 DOM 中使用 innerHTML') },
			})
			return node
		}
		const fakeDoc = {
			activeElement: null,
			createElement: mkNode,
			addEventListener: function () {},
			removeEventListener: function () {},
		}
		const host = mkNode('div')
		const wb = WorkbenchMod.createWorkbench({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([]),
			document: fakeDoc,
		})
		wb.mount(host)
		assert.equal(host.childNodes.length, 4) // toolbar, subnav, body, log-drawer
		wb.unmount()
		assert.equal(host.childNodes.length, 0)
	})

	// ---- 测试 8 (P1-1): OTA 重复/陈旧 0x22 ACK 忽略、自动 OTA 期间拒绝手动 OTA、0x26 非 OK 立即失败 ----
	await test('P1-1: OTA SEQ 独占消费（忽略旧重试/重复 0x22 ACK）、阻断手动 OTA 与 0x26 错误立即失败', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM20' })
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		await ctrl.openPort({ port: mockPort.port })
		const rawApp = new Uint8Array(240)
		for (let i = 0; i < rawApp.length; i++) rawApp[i] = i & 0xff
		ctrl.loadFirmwareBytes(rawApp, 'V3.2.0.bin')
		const startRes = ctrl.startAutoOta({ chunkSize: 128 }) // 256B -> 2 包
		assert.equal(startRes.ok, true)
		await clock.flushMicrotasks()

		// 自动 OTA 期间所有手动 OTA 方法必须被拒绝
		for (const fn of [
			() => ctrl.sendManualOtaHandshake(),
			() => ctrl.sendManualOtaErase(),
			() => ctrl.sendManualOtaChunk(true),
			() => ctrl.sendManualOtaCrc(),
			() => ctrl.sendManualOtaFinish(),
		]) {
			const r = await fn()
			assert.equal(r.ok, false)
		}

		// Step 0 & Step 1 正常通过
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.HANDSHAKE, seq: proto.sentRecords[0].opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(300)
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_ERASE, seq: proto.sentRecords[1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(300)

		// Step 2: 第 1 包超时触发重试，获得新 seq
		const chunk0Try1 = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(chunk0Try1.tag, proto.CMD.OTA_DATA)
		await clock.advance(5000) // chunk0 try1 超时
		await clock.advance(2000) // 2s 后重试
		const chunk0Try2 = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(chunk0Try2.tag, proto.CMD.OTA_DATA)
		assert.notEqual(chunk0Try2.opts.seq, chunk0Try1.opts.seq)

		// 此时收到 chunk0 try1 的迟到 ACK -> 必须被忽略，不得推进 currentAddr
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_DATA, seq: chunk0Try1.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.currentAddr, 0x8000)

		// 收到 chunk0 try2 正确 ACK -> 推进到 0x8080 并发送第 2 包
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_DATA, seq: chunk0Try2.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.currentAddr, 0x8080)
		const chunk1 = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(chunk1.opts.addr, 0x8080)

		// 再发一次 chunk0 try2 的重复 ACK -> 必须被忽略，不得跳过 chunk1
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_DATA, seq: chunk0Try2.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.currentAddr, 0x8080)

		// 正常确认 chunk1 & 0x25 CRC
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_DATA, seq: chunk1.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(300)
		const crcRec = proto.sentRecords[proto.sentRecords.length - 1]
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_CRC, seq: crcRec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: { crcValue: startRes.expectedCrc } },
		}))
		await clock.flushMicrotasks()

		// Step 4: 0x26 返回非 OK 错误码 0x06 -> 必须立即在 Step 4 失败而非傻等 15s
		const finRec = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(finRec.tag, proto.CMD.OTA_FINISH)
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_FINISH, seq: finRec.opts.seq, typeOrStatus: proto.STATUS.CRC_ERROR, detail: {} },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.running, false)
		assert.equal(ctrl.state.ota.lastResult.ok, false)
		assert.equal(ctrl.state.ota.stepStatus[4], 'error')
		ctrl.destroy()
	})

	// ---- 测试 9 (P1-2): OTA Step 6 0x33 超时绝不伪造成功、外表 onlyAddrHex 拒绝 ----
	await test('P1-2: OTA Step 6 0x33 超时报未确认失败（不用缓存版本）且外机 UID 0x33 被拒绝', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM21' })
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		await ctrl.openPort({ port: mockPort.port })
		ctrl.state.device.firmwareVersion = 'V2.9.9-OLD'
		ctrl.state.device.onlyAddrHex = 'AA112233445566'

		async function driveToStep5() {
			const rawApp = new Uint8Array(64).fill(0x55)
			ctrl.loadFirmwareBytes(rawApp, 'V3.3.0.bin')
			const startRes = ctrl.startAutoOta({ chunkSize: 128 })
			await clock.flushMicrotasks()
			mockPort.getSink().data(proto.encodeMockEventFrame({
				kind: 'ac6d', parsed: { cmd: proto.CMD.HANDSHAKE, seq: proto.sentRecords[proto.sentRecords.length - 1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
			}))
			await clock.advance(300)
			mockPort.getSink().data(proto.encodeMockEventFrame({
				kind: 'ac6d', parsed: { cmd: proto.CMD.OTA_ERASE, seq: proto.sentRecords[proto.sentRecords.length - 1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
			}))
			await clock.advance(300)
			mockPort.getSink().data(proto.encodeMockEventFrame({
				kind: 'ac6d', parsed: { cmd: proto.CMD.OTA_DATA, seq: proto.sentRecords[proto.sentRecords.length - 1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
			}))
			await clock.advance(300)
			mockPort.getSink().data(proto.encodeMockEventFrame({
				kind: 'ac6d', parsed: { cmd: proto.CMD.OTA_CRC, seq: proto.sentRecords[proto.sentRecords.length - 1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: { crcValue: startRes.expectedCrc } },
			}))
			await clock.flushMicrotasks()
		}

		// 场景 A: Step 5 (15s) + Step 6 (5s) 均无 0x33 响应 -> unverified: true, ok: false, 不得沿用旧版本
		await driveToStep5()
		await clock.advance(15000)
		assert.equal(ctrl.state.ota.step, 6)
		await clock.advance(5000)
		assert.equal(ctrl.state.ota.running, false)
		assert.equal(ctrl.state.ota.lastResult.ok, false)
		assert.equal(ctrl.state.ota.lastResult.unverified, true)
		assert.equal(ctrl.state.ota.lastResult.stage, 'verify_timeout')
		assert.equal(ctrl.state.ota.lastResult.newVersion, '')
		assert.equal(ctrl.state.ota.stepStatus[5], 'error')

		// 场景 B: Step 5（收到 0x26 ACK 后）收到另一块水表（不同 onlyAddrHex）的 0x33 -> uidMismatch: true, ok: false
		await driveToStep5()
		const finRecB = proto.sentRecords[proto.sentRecords.length - 1]
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_FINISH, seq: finRecB.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.flushMicrotasks()
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.DEV_INFO,
				seq: 88,
				typeOrStatus: proto.STATUS.OK,
				detail: { onlyAddrHex: 'FF998877665544', firmwareVersion: 'V3.3.0', mode: 1 },
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.running, false)
		assert.equal(ctrl.state.ota.lastResult.ok, false)
		assert.equal(ctrl.state.ota.lastResult.uidMismatch, true)
		assert.equal(ctrl.state.ota.stepStatus[5], 'error')
		ctrl.destroy()
	})

	// ---- 测试 10 (P1-3 & P1-4): abortOpen 等待 settle、close 失败保留所有权并可重试、流未空断流关闭端口、bluOpening 占口 ----
	await test('P1-3 & P1-4: abortOpen 等待 open 落定、close 失败保留 ownsPort、非空流异常退出调 close 与 bluOpening 拦截', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const pBluOpening = createMockPort({ path: 'COM22' })
		const pSlowAbort = createMockPort({ path: 'COM23' }, { hangOpen: true, deferAbortSettle: true })
		const pFailClose = createMockPort({ path: 'COM24' }, { failClose: true })
		const pErrCap = createMockPort({ path: 'COM25' })
		const adapter = createMockSerialAdapter([pBluOpening.port, pSlowAbort.port, pFailClose.port, pErrCap.port])
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: adapter,
			bluApi: { ownsPort: function (p) { return p === pBluOpening.port }, isOpen: function () { return false } },
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})

		// P1-4: bluOpening (ownsPort=true, isOpen=false) 必须阻止占用
		assert.match(ctrl.checkPortConflict(pBluOpening.port), /功耗分析/)
		const openBluRes = await ctrl.openPort({ port: pBluOpening.port })
		assert.equal(openBluRes.ok, false)

		// P1-3a: abortOpen 后若底层 openPromise 尚未 settle，ownsPort 必须保持 true 直到 settle
		const openP = ctrl.openPort({ port: pSlowAbort.port })
		await clock.flushMicrotasks()
		assert.equal(ctrl.ownsPort(pSlowAbort.port), true)
		let closeFinished = false
		const closeP = ctrl.closePort({ manual: true }).then(function (r) { closeFinished = true; return r })
		await clock.flushMicrotasks()
		assert.equal(closeFinished, false, 'openPromise 未落定时 closePort 不得提前结束')
		assert.equal(ctrl.ownsPort(pSlowAbort.port), true, 'openPromise 未落定时 ownsPort 必须保持 true')
		pSlowAbort.rejectOpen(new Error('Aborted late'))
		const closeRes = await closeP
		const openRes = await openP
		assert.equal(closeRes.ok, true)
		assert.equal(openRes.ok, false)
		assert.equal(ctrl.ownsPort(pSlowAbort.port), false)

		// P1-3b: close() 抛出异常时保留 ownsPort & isBusy & 返回 ok:false；允许重试 closePort 成功后释放
		await ctrl.openPort({ port: pFailClose.port })
		const failCloseRes = await ctrl.closePort({ manual: true })
		assert.equal(failCloseRes.ok, false)
		assert.equal(ctrl.isCloseFailed(), true)
		assert.equal(ctrl.ownsPort(pFailClose.port), true)
		assert.equal(ctrl.isBusy(), true)
		const reopenBlocked = await ctrl.openPort({ port: pFailClose.port })
		assert.equal(reopenBlocked.ok, false)
		// 修复底层后重试 closePort 成功释放
		pFailClose.setFailClose(false)
		const retryCloseRes = await ctrl.closePort({ manual: true })
		assert.equal(retryCloseRes.ok, true)
		assert.equal(ctrl.isCloseFailed(), false)
		assert.equal(ctrl.ownsPort(pFailClose.port), false)

		// P1-3c: 读循环因连续错误超限退出时流仍存在 -> 必须调 port.close() 防止句柄泄漏
		await ctrl.openPort({ port: pErrCap.port })
		const beforeClose = pErrCap.getClosedCount()
		for (let i = 0; i < 22; i++) {
			pErrCap.getSink().error(new Error('BurstError #' + i))
			await clock.advance(10)
		}
		await clock.advance(100)
		assert.equal(ctrl.isOpen(), false)
		assert.equal(pErrCap.getClosedCount(), beforeClose + 1, '非空流异常退出必须调用底层 port.close()')
		ctrl.destroy()
	})

	// ---- 测试 11 (P1-5 & P2-4): 0x43 基础参数快照绑定 (connGen, onlyAddrHex) + uint64 越界拦截 ----
	await test('P1-5 & P2-4: 0x43 须先读当前表 0x42(0) 快照且切表作废 + uint64 越界拒绝', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM26' })
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		await ctrl.openPort({ port: mockPort.port })
		// 仅通过 0x33 获取 authCode，尚未读 0x42(0) -> 0x43 必须被拒
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.DEV_INFO, seq: 1, typeOrStatus: proto.STATUS.OK, detail: { onlyAddrHex: '01020378563412', firmwareVersion: 'V2.7' } },
		}))
		await clock.flushMicrotasks()
		const rejBeforeRead = await ctrl.sendParamWriteBase({ voltageAlarmV: 3.2 })
		assert.equal(rejBeforeRead.ok, false)
		assert.equal(proto.sentRecords.length, 0)

		// 被动收到 0x42(0)（未主动发 sendParamRead(0)）-> 不得建立可写快照
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.PARAM_READ,
				seq: 99,
				typeOrStatus: proto.STATUS.OK,
				detail: { paramType: 0, layout: 'v27-40', base: { onlyAddrHex: '01020378563412', voltageAlarmV: 3.1, sampleIntervalMin: 60, baseDegree: '100' } },
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.isBaseParamsSnapshotValid(), false, '被动 0x42(0) 不得建立可写快照')

		// 主动发起 sendParamRead(0) 并收到匹配 SEQ -> 快照绑定当前连接与 UID
		await ctrl.sendParamRead(0)
		const paramReadRec = proto.sentRecords[proto.sentRecords.length - 1]
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.PARAM_READ,
				seq: paramReadRec.opts.seq,
				typeOrStatus: proto.STATUS.OK,
				detail: { paramType: 0, layout: 'v27-40', base: { onlyAddrHex: '01020378563412', voltageAlarmV: 3.1, sampleIntervalMin: 60, baseDegree: '100' } },
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.isBaseParamsSnapshotValid(), true)
		// P2-B: 禁止在 sendParamWriteBase 覆盖 onlyAddrHex 为其它合法 7B UID
		const spoofUidRes = await ctrl.sendParamWriteBase({ onlyAddrHex: '11223344556677', voltageAlarmV: 3.2 })
		assert.equal(spoofUidRes.ok, false)
		assert.match(spoofUidRes.error, /禁止修改/)
		// P2-4: baseDegree 越界 (2^64) 在 sendParamWriteBase 和 sendBaseDegree 中都被拒绝
		const sentBeforeBad = proto.sentRecords.length
		const badDegParam = await ctrl.sendParamWriteBase({ baseDegree: '18446744073709551616' })
		assert.equal(badDegParam.ok, false)
		const badDeg47 = await ctrl.sendBaseDegree('18446744073709551616')
		assert.equal(badDeg47.ok, false)
		assert.equal(proto.sentRecords.length, sentBeforeBad)

		// 合法写入成功且强制使用 snapshot baseUidHex
		const okWrite = await ctrl.sendParamWriteBase({ voltageAlarmV: 3.25 })
		assert.equal(okWrite.ok, true)
		assert.equal(proto.sentRecords[proto.sentRecords.length - 1].opts.baseObj.onlyAddrHex, '01020378563412')

		// 换成另一块水表（0x33 返回新 UID）-> 快照立即作废，0x43 再次被拒
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.DEV_INFO, seq: 3, typeOrStatus: proto.STATUS.OK, detail: { onlyAddrHex: '99887766554433', firmwareVersion: 'V2.7' } },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.isBaseParamsSnapshotValid(), false)
		const rejAfterSwap = await ctrl.sendParamWriteBase({ voltageAlarmV: 3.3 })
		assert.equal(rejAfterSwap.ok, false)
		ctrl.destroy()
	})

	// ---- 测试 12 (P1-6): Save-All 严格 SEQ/0x83 匹配、cancelSaveAll 落定 Promise、file-save 失败传播 ----
	await test('P1-6: Save-All 忽略错 SEQ 与非 0x83 A99A、取消必落定 Promise、保存异常不伪造成功', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM27' })
		let saveThrows = true
		let runningInsideSave = null
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			appPlatform: {
				service: function (name) {
					if (name === 'file-save') {
						return async function () {
							runningInsideSave = ctrl.state.saveAll.running
							if (saveThrows) throw new Error('磁盘已满')
						}
					}
					return null
				},
			},
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		await ctrl.openPort({ port: mockPort.port })

		// 1) cancelSaveAll / 断开必须立即落定 startSaveAll Promise
		const pCancel = ctrl.startSaveAll()
		await clock.flushMicrotasks()
		ctrl.cancelSaveAll('测试取消')
		const cancelRes = await pCancel
		assert.equal(cancelRes.ok, false)
		assert.equal(cancelRes.cancelled, true)

		// 2) 错 SEQ 0x33 与错 func/SEQ A99A 不得污染快照或误推进；file-save 失败返回 ok:false
		const pRun = ctrl.startSaveAll()
		await clock.flushMicrotasks()
		const r0 = proto.sentRecords[proto.sentRecords.length - 1]
		// 注入错 SEQ 的 0x33 -> 忽略
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.DEV_INFO, seq: (r0.opts.seq + 10) & 0xff, typeOrStatus: proto.STATUS.OK, detail: { onlyAddrHex: 'DEADBEEF000001' } },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.saveAll.step, 0)
		assert.equal(ctrl.state.saveAll.deviceSnap, null)

		// 注入正确 SEQ 完成前 3 步
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.DEV_INFO, seq: r0.opts.seq, typeOrStatus: proto.STATUS.OK, detail: { onlyAddrHex: '11223344556677' } },
		}))
		await clock.advance(300)
		const r1 = proto.sentRecords[proto.sentRecords.length - 1]
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.CALIB_READ, seq: r1.opts.seq, typeOrStatus: proto.STATUS.OK, detail: { meterPulseEq: 17085 } },
		}))
		await clock.advance(300)
		const r2 = proto.sentRecords[proto.sentRecords.length - 1]
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.PARAM_READ, seq: r2.opts.seq, typeOrStatus: proto.STATUS.OK, detail: { paramType: 0, base: { onlyAddrHex: '11223344556677' } } },
		}))
		await clock.advance(300)
		const r3 = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(r3.tag, 'A99A_MODULE_QUERY')

		// 错 func (0x03) 或错 iotSeq -> 忽略
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'a99a-info',
			moduleInfo: { ok: true, func: 0x03, seq: r3.opts.iotSeq, basic: { imei: 'WRONG' } },
		}))
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'a99a-info',
			moduleInfo: { ok: true, func: 0x83, seq: r3.opts.iotSeq + 9, basic: { imei: 'WRONG2' } },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.saveAll.step, 3)
		assert.equal(ctrl.state.saveAll.moduleInfo, null)

		// 正确 func=0x83 + seq -> 进入保存，期间 running 保持 true，保存抛错返回 ok:false
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'a99a-info',
			moduleInfo: { ok: true, func: 0x83, seq: r3.opts.iotSeq, basic: { imei: '860000000000009' } },
		}))
		await clock.advance(350)
		const failSaveRes = await pRun
		assert.equal(runningInsideSave, true, 'file-save 执行期间 saveAll.running 必须保持 true')
		assert.equal(failSaveRes.ok, false)
		assert.match(failSaveRes.error, /磁盘已满/)
		assert.equal(ctrl.state.saveAll.running, false)
		ctrl.destroy()
	})

	// ---- 测试 13 (P2-1 & P2-5): 0x41 错 SEQ 忽略与 raw176 原始校验 + destroy 解绑监听器与作废在飞 refreshPorts ----
	await test('P2-1 & P2-5: 0x41/0x40 SEQ 匹配与 raw176 原始字节比对 + destroy 解绑 SerialAdapter 并作废在飞 refreshPorts', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM28' })
		let resolveListPorts = null
		const adapter = createMockSerialAdapter([mockPort.port], {
			listPorts: function () {
				return new Promise(function (resolve) { resolveListPorts = resolve })
			},
		})
		const verifyEvents = []
		const portEvents = []
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: adapter,
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		ctrl.onChange(function (t, p) {
			if (t === 'calib-verify') verifyEvents.push(p)
			if (t === 'ports') portEvents.push(p)
		})
		assert.equal(adapter.getListenerCount('disconnect'), 1)
		assert.equal(adapter.getListenerCount('change'), 1)

		await ctrl.openPort({ port: mockPort.port })
		ctrl.setManualAuthCode('12345678')
		await ctrl.writeAllCalibCoeffs()
		const wRec = proto.sentRecords[proto.sentRecords.length - 1]
		// 错 SEQ 的 0x41 ACK 不得启动 3s 回读
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.CALIB_WRITE, seq: (wRec.opts.seq + 5) & 0xff, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(3500)
		assert.equal(proto.sentRecords.length, 1)

		// 正确 SEQ 的 0x41 ACK 启动 3s 回读
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.CALIB_WRITE, seq: wRec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(3000)
		const rRec = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(rRec.tag, proto.CMD.CALIB_READ)

		// 错 SEQ 的 0x40 忽略
		const exactRaw = Array.from(WorkbenchMod.helpers.encodeCalib176Bytes(wRec.opts.calibObj))
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.CALIB_READ, seq: (rRec.opts.seq + 3) & 0xff, typeOrStatus: proto.STATUS.OK, detail: Object.assign({}, wRec.opts.calibObj, { raw176: exactRaw }) },
		}))
		await clock.flushMicrotasks()
		assert.equal(verifyEvents.length, 0)

		// 正确 SEQ 但 raw176 保留位被改（UI 钳制/重编码无法发现的原始字节差异）-> 必须判不一致！
		const tamperedRaw = exactRaw.slice()
		tamperedRaw[12] = 0x99 // reserved byte diff
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.CALIB_READ, seq: rRec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: Object.assign({}, wRec.opts.calibObj, { raw176: tamperedRaw }) },
		}))
		await clock.flushMicrotasks()
		assert.equal(verifyEvents.length, 1)
		assert.equal(verifyEvents[0].ok, false)

		// P2-5: 发起在飞 refreshPorts -> destroy() -> 解绑监听器 + 落定的旧 refreshPorts 结果被丢弃
		const inflight = ctrl.refreshPorts()
		ctrl.destroy()
		assert.equal(adapter.getListenerCount('disconnect'), 0)
		assert.equal(adapter.getListenerCount('change'), 0)
		resolveListPorts([mockPort.port])
		const staleRes = await inflight
		assert.deepEqual(staleRes, [])
		assert.equal(portEvents.length, 0)
	})

	// ---- 测试 14 (P1-A): requestPort 忙态拦截、heldPort 隔离与 UI 端口按钮禁用 ----
	await test('P1-A: requestPort 在 open/opening/closeFailed 均被拒且不污染 heldPort，UI 端口按钮联动禁用', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const pA = createMockPort({ path: 'COM30' }, { failClose: true })
		const pB = createMockPort({ path: 'COM31' })
		let reqResolve = null
		let reqCalls = 0
		const adapter = createMockSerialAdapter([pA.port, pB.port], {
			requestPort: function () {
				reqCalls++
				return new Promise(function (resolve) { reqResolve = resolve })
			},
		})
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: adapter,
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})

		// 在关闭状态下发起 requestPort，中途打开 pA，再让 requestPort 落定返回 pB -> 不得覆盖 currentPort / heldPort
		const pendingReq = ctrl.requestPort()
		assert.equal(reqCalls, 1)
		await ctrl.openPort({ port: pA.port })
		assert.equal(ctrl.ownsPort(pA.port), true)
		reqResolve(pB.port)
		const midRes = await pendingReq
		assert.equal(midRes, null)
		assert.equal(ctrl.getCurrentPort(), pA.port)
		assert.equal(ctrl.ownsPort(pA.port), true)
		assert.equal(ctrl.ownsPort(pB.port), false)

		// 已连接态直接调 requestPort -> 立即拒绝且不调 adapter.requestPort
		assert.equal(await ctrl.requestPort(), null)
		assert.equal(reqCalls, 1)

		// closeFailed 态直接调 requestPort -> 同样拒绝且保持 ownsPort(pA)
		const failClose = await ctrl.closePort({ manual: true })
		assert.equal(failClose.ok, false)
		assert.equal(ctrl.isCloseFailed(), true)
		assert.equal(await ctrl.requestPort(), null)
		assert.equal(ctrl.ownsPort(pA.port), true)

		pA.setFailClose(false)
		assert.equal((await ctrl.closePort({ manual: true })).ok, true)
		assert.equal(ctrl.ownsPort(pA.port), false)
		ctrl.destroy()

		// UI 验证：挂载工作台后，打开串口时 portBtn 和 authPortBtn 均被 disabled
		function mkNode(tag) {
			const node = {
				tagName: String(tag).toUpperCase(),
				className: '', textContent: '', value: '', title: '', type: '',
				hidden: false, disabled: false, checked: false, readOnly: false,
				dataset: {}, style: {}, childNodes: [], parentNode: null,
				get firstChild() { return this.childNodes[0] || null },
				classList: { toggle: function () {} },
				setAttribute: function () {},
				addEventListener: function () {},
				removeEventListener: function () {},
				contains: function () { return false },
				querySelector: function (sel) {
					if (sel === 'span') return this.childNodes.find(function (c) { return c.tagName === 'SPAN' }) || null
					return null
				},
				appendChild: function (c) { c.parentNode = this; this.childNodes.push(c); return c },
				removeChild: function (c) {
					const i = this.childNodes.indexOf(c)
					if (i >= 0) this.childNodes.splice(i, 1)
					c.parentNode = null
					return c
				},
			}
			return node
		}
		function findBtnByText(rootNode, text) {
			if (rootNode.tagName === 'BUTTON' && rootNode.childNodes.some(function (c) { return c.textContent === text })) return rootNode
			for (let i = 0; i < rootNode.childNodes.length; i++) {
				const hit = findBtnByText(rootNode.childNodes[i], text)
				if (hit) return hit
			}
			return null
		}
		const fakeDoc = { activeElement: null, createElement: mkNode, addEventListener: function () {}, removeEventListener: function () {} }
		const host = mkNode('div')
		const pUi = createMockPort({ path: 'COM32' })
		const wb = WorkbenchMod.createWorkbench({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([pUi.port]),
			document: fakeDoc,
		})
		wb.mount(host)
		const portBtn = findBtnByText(host, '选择设备')
		const authBtn = findBtnByText(host, '选择串口…')
		assert.ok(portBtn && authBtn)
		assert.equal(portBtn.disabled, false)
		assert.equal(authBtn.disabled, false)
		await wb.controller.openPort({ port: pUi.port })
		assert.equal(portBtn.disabled, true, '连接后必须禁用端口选择按钮')
		assert.equal(authBtn.disabled, true, '连接后必须禁用串口授权按钮')
		wb.unmount()
	})

	// ---- 测试 15 (P1-B & P1-C): OTA Step 5/6 严格 0x33 验证 + 运行期禁止修改 chunkSize ----
	await test('P1-B & P1-C: OTA 忽略 OTA 前 0x33 与空版本/错 SEQ 0x33、拒绝运行期改 chunkSize 并按 pendingChunkLen 推进', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM33' })
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		await ctrl.openPort({ port: mockPort.port })
		ctrl.state.device.firmwareVersion = 'V3.0.0'
		ctrl.state.device.onlyAddrHex = 'AA112233445566'

		// OTA 前发送过一条 0x33 查询，记录其 SEQ（模拟晚到的响应）
		await ctrl.sendDevInfo(false)
		const preOta33Seq = proto.sentRecords[proto.sentRecords.length - 1].opts.seq

		// 300B 原始固件 -> 加 16B 头共 316B，以 128B 分包（128 + 128 + 60）
		const rawApp = new Uint8Array(300).fill(0x33)
		ctrl.loadFirmwareBytes(rawApp, 'V3.4.0.bin')
		const startRes = ctrl.startAutoOta({ chunkSize: 128 })
		assert.equal(startRes.ok, true)
		await clock.flushMicrotasks()

		// P1-B: 自动 OTA 期间手动 sendDevInfo 必须被阻断
		const blocked33 = await ctrl.sendDevInfo(false)
		assert.equal(blocked33.ok, false)

		// P1-C: 自动 OTA 期间 setOtaChunkSize 必须拒绝
		assert.equal(ctrl.setOtaChunkSize(64), false)
		assert.equal(ctrl.state.ota.chunkSize, 128)

		// 推进 Step 0 & Step 1
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.HANDSHAKE, seq: proto.sentRecords[proto.sentRecords.length - 1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(300)
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.OTA_ERASE, seq: proto.sentRecords[proto.sentRecords.length - 1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(300)

		// P1-C: 即使外部直接篡改 state.ota.chunkSize，第 1 包 ACK 仍须严格按 pendingChunkLen (128) 推进，后续分包按锁定的 runChunkSize (128) 发送
		const c0 = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(c0.opts.chunk.length, 128)
		ctrl.state.ota.chunkSize = 512
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.OTA_DATA, seq: c0.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.currentAddr, 0x8080)
		assert.equal(ctrl.state.ota.sentBytes, 128)
		const c1 = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(c1.opts.chunk.length, 128)
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.OTA_DATA, seq: c1.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.flushMicrotasks()
		const c2 = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(c2.opts.chunk.length, 60)
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.OTA_DATA, seq: c2.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(300)

		// Step 3 CRC -> Step 4/5
		const crcRec = proto.sentRecords[proto.sentRecords.length - 1]
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.OTA_CRC, seq: crcRec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: { crcValue: startRes.expectedCrc } },
		}))
		await clock.flushMicrotasks()
		const finRec = proto.sentRecords[proto.sentRecords.length - 1]

		// Step 5 未收到 0x26 ACK 前，非 seq=0 的 0x33 必须忽略
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.DEV_INFO, seq: 77, typeOrStatus: proto.STATUS.OK, detail: { onlyAddrHex: 'AA112233445566', firmwareVersion: 'V3.4.0' } },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.running, true)

		// 收到 0x26 ACK
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.OTA_FINISH, seq: finRec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.flushMicrotasks()

		// Step 5 收到 OTA 前查询的迟到 0x33 (seq === preOta33Seq) -> 必须忽略
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.DEV_INFO, seq: preOta33Seq, typeOrStatus: proto.STATUS.OK, detail: { onlyAddrHex: 'AA112233445566', firmwareVersion: 'V3.0.0' } },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.running, true)

		// Step 5 收到版本号为空的 0x33 -> 忽略并继续等待
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.DEV_INFO, seq: 0, typeOrStatus: proto.STATUS.OK, detail: { onlyAddrHex: 'AA112233445566', firmwareVersion: '' } },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.running, true)

		// 15s 后进入 Step 6 主动查询 0x33
		await clock.advance(15000)
		assert.equal(ctrl.state.ota.step, 6)
		const verifyRec = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(verifyRec.tag, proto.CMD.DEV_INFO)

		// Step 6 收到 UID 匹配但 seq !== verifySeq 的 0x33 -> 必须忽略！
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.DEV_INFO, seq: (verifyRec.opts.seq + 5) & 0xff, typeOrStatus: proto.STATUS.OK, detail: { onlyAddrHex: 'AA112233445566', firmwareVersion: 'V3.4.0' } },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.running, true)

		// Step 6 收到匹配 verifySeq 但版本号为空的 0x33 -> 必须结束为 ok:false, unverified:true, stage:'incomplete_dev_info'（绝不 ok:true）
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d', parsed: { cmd: proto.CMD.DEV_INFO, seq: verifyRec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: { onlyAddrHex: 'AA112233445566', firmwareVersion: '' } },
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.running, false)
		assert.equal(ctrl.state.ota.lastResult.ok, false)
		assert.equal(ctrl.state.ota.lastResult.unverified, true)
		assert.equal(ctrl.state.ota.lastResult.stage, 'incomplete_dev_info')
		assert.notEqual(ctrl.state.ota.progress, 100)
		assert.equal(ctrl.state.ota.stepStatus[5], 'error')
		ctrl.destroy()
	})

	// ---- 测试 16 (P1-D & P2-C): Save-All 排队阻塞时 Attempt 1 过期跳过且不破坏 Attempt 2 + 0x41 无 ACK 超时未确认 ----
	await test('P1-D & P2-C: Save-All 写队列阻塞下陈旧尝试自动跳过不误杀重试 + 0x41 写入无 ACK 超时解卡并报 unconfirmed', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		let unblockStall = null
		let stallNextWrite = false
		const mockPort = createMockPort({ path: 'COM34' }, {
			onWrite: function () {
				if (stallNextWrite) {
					stallNextWrite = false
					return new Promise(function (resolve) { unblockStall = resolve })
				}
				return Promise.resolve()
			},
		})
		const verifyEvents = []
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		ctrl.onChange(function (t, p) {
			if (t === 'calib-verify') verifyEvents.push(p)
		})
		await ctrl.openPort({ port: mockPort.port })

		// P1-D: 先放一条卡住 writeChain 的前置写入，然后启动 Save-All
		stallNextWrite = true
		const blockerWrite = ctrl.sendFlowOnce('0x30')
		await clock.flushMicrotasks()
		assert.equal(mockPort.written.length, 1)

		const saveP = ctrl.startSaveAll({ skipDownload: true })
		await clock.flushMicrotasks()
		const attempt1Rec = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(attempt1Rec.tag, proto.CMD.DEV_INFO)
		// Attempt 1 还在 writeChain 里排队时就超时（3000ms）-> 1000ms 后进入 Attempt 2
		await clock.advance(3000)
		await clock.advance(1000)
		const attempt2Rec = proto.sentRecords[proto.sentRecords.length - 1]
		assert.equal(attempt2Rec.tag, proto.CMD.DEV_INFO)
		assert.notEqual(attempt2Rec.opts.seq, attempt1Rec.opts.seq)

		// 解除 writeChain 阻塞：Attempt 1 的 beforeWrite 必须返回 false 跳过发送，只发出 Attempt 2！
		const writtenBeforeUnblock = mockPort.written.length
		unblockStall()
		await blockerWrite
		await clock.flushMicrotasks()
		assert.equal(mockPort.written.length, writtenBeforeUnblock + 1, '已过期的 Attempt 1 不得再向串口写出重复帧')
		assert.equal(mockPort.written[mockPort.written.length - 1][2], attempt2Rec.opts.seq & 0xff)

		// Attempt 2 在 onWriteStart 重置计时，收到 Attempt 2 对应 SEQ 的 0x33 顺利推进
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.DEV_INFO, seq: attempt2Rec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: { onlyAddrHex: '11223344556677' } },
		}))
		await clock.advance(300)
		assert.equal(ctrl.state.saveAll.step, 1)
		ctrl.cancelSaveAll('清理测试')
		await saveP

		// P2-C: writeAllCalibCoeffs 下发成功但水表不回 0x41 ACK -> calibWriteAckMs (5000ms) 后超时清理 waitingWriteAck 并报 unconfirmed
		ctrl.setManualAuthCode('12345678')
		await ctrl.writeAllCalibCoeffs()
		assert.equal(ctrl.state.calibVerify.waitingWriteAck, true)
		await clock.advance(5000)
		assert.equal(ctrl.state.calibVerify.waitingWriteAck, false)
		assert.equal(ctrl.state.calibVerify.pendingExpected, null)
		assert.equal(verifyEvents.length, 1)
		assert.equal(verifyEvents[0].ok, false)
		assert.equal(verifyEvents[0].ackTimeout, true)
		assert.equal(verifyEvents[0].unconfirmed, true)
		ctrl.destroy()
	})

	// ---- 测试 17 (fix3): 多表重连清空旧表身份，换接水表 B 直接 OTA 不误报 uid_mismatch ----
	await test('fix3: 断开重连换接水表 B 自动清空水表 A 身份/认证码，直接 OTA 不误报 uid_mismatch 且由握手采集原版本', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const portA = createMockPort({ path: 'COM40' })
		const portB = createMockPort({ path: 'COM41' })
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([portA.port, portB.port]),
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})

		// 1) 连接水表 A，接收 0x33（UID A, authCode A, V1.0）
		await ctrl.openPort({ port: portA.port })
		portA.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.DEV_INFO,
				seq: 1,
				typeOrStatus: proto.STATUS.OK,
				detail: { onlyAddrHex: 'AA000078563412', firmwareVersion: 'V1.0', mode: 1 },
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.device.onlyAddrHex, 'AA000078563412')
		assert.equal(ctrl.getEffectiveAuthCode(), 0x12345678)
		assert.equal(ctrl.state.device.firmwareVersion, 'V1.0')

		// 2) 断开水表 A -> 身份与认证码立即清空
		await ctrl.closePort({ manual: true })
		assert.equal(ctrl.state.device.onlyAddrHex, '')
		assert.equal(ctrl.getEffectiveAuthCode(), null)
		assert.equal(ctrl.state.device.firmwareVersion, '')

		// 3) 连接水表 B，不先点 0x33，直接一键自动升级
		await ctrl.openPort({ port: portB.port })
		assert.equal(ctrl.state.device.onlyAddrHex, '')
		assert.equal(ctrl.getEffectiveAuthCode(), null)
		const rawApp = new Uint8Array(100).fill(0x42)
		ctrl.loadFirmwareBytes(rawApp, 'MeterB_V2.1.bin')
		const startRes = ctrl.startAutoOta({ chunkSize: 128 })
		assert.equal(startRes.ok, true)
		await clock.flushMicrotasks()

		// Step 0: 0x20 握手返回 V2.0 -> 自动作为 originalVersion
		portB.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.HANDSHAKE, seq: proto.sentRecords[proto.sentRecords.length - 1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: { firmwareVersion: 'V2.0' } },
		}))
		await clock.advance(300)
		// Step 1: 0x24
		portB.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_ERASE, seq: proto.sentRecords[proto.sentRecords.length - 1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(300)
		// Step 2: 0x22
		portB.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_DATA, seq: proto.sentRecords[proto.sentRecords.length - 1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.advance(300)
		// Step 3: 0x25
		portB.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_CRC, seq: proto.sentRecords[proto.sentRecords.length - 1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: { crcValue: startRes.expectedCrc } },
		}))
		await clock.flushMicrotasks()
		// Step 4: 0x26 OK ACK
		portB.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.OTA_FINISH, seq: proto.sentRecords[proto.sentRecords.length - 1].opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.flushMicrotasks()

		// Step 5: 水表 B 重启上报 UID B 与新版本 V2.1 -> 必须成功，不误报 uid_mismatch
		portB.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.DEV_INFO,
				seq: 0,
				typeOrStatus: proto.STATUS.OK,
				detail: { onlyAddrHex: 'BB000011223344', firmwareVersion: 'V2.1', mode: 1 },
			},
		}))
		await clock.flushMicrotasks()
		assert.equal(ctrl.state.ota.running, false)
		assert.equal(ctrl.state.ota.lastResult.ok, true)
		assert.equal(ctrl.state.ota.lastResult.originalVersion, 'V2.0')
		assert.equal(ctrl.state.ota.lastResult.newVersion, 'V2.1')
		assert.equal(ctrl.state.ota.lastResult.onlyAddrHex, 'BB000011223344')
		assert.equal(ctrl.state.ota.lastResult.uidMismatch, false)
		ctrl.destroy()
	})

	// ---- 测试 18 (Issue #3): 串口与 BLE 友好名称展示、BLU 端口排除与无线 connection-source 自动连接 ----
	await test('Issue #3: 串口/BLE 名称与副标题展示、别名优先、排除 BLU 端口及无线选口自动连接', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const pSerial = createMockPort({
			path: '/dev/cu.usbserial-1410',
			productName: 'CP2102 USB to UART Bridge',
			usbVendorId: 0x10c4,
			usbProductId: 0xea60,
		})
		const pBleRaw = createMockPort({
			path: '',
			transport: 'ble',
			productName: 'WM-AC6D-01 · BLE',
			bleAddress: 'AA:BB:CC:11:22:33',
			bleSaved: true,
		})
		const pBleAliased = createMockPort({
			path: '',
			transport: 'ble',
			productName: 'WM-AC6D-01 · BLE',
			bleAddress: 'AA:BB:CC:11:22:33',
			bleSaved: true,
		})
		pBleAliased.port.getDisplayAlias = function () { return '测试水表1' }

		const pBlu = createMockPort({
			path: '/dev/cu.usbmodem-BLU',
			productName: 'Power Analyzer',
			usbVendorId: 0x15a2,
			usbProductId: 0x300a,
		})
		const pPickedBle = createMockPort({
			path: '',
			transport: 'ble',
			productName: 'WM-AC6D-02 · BLE',
			bleAddress: '11:22:33:44:55:66',
			bleSaved: false,
		})
		const pBusyBle = createMockPort({
			path: '',
			transport: 'ble',
			productName: 'WM-BUSY · BLE',
			bleAddress: '99:88:77:66:55:44',
		})

		let discardCount = 0
		let reqSourceCalled = null
		let nextPicked = pPickedBle.port
		const connSvc = {
			availableSources: function () {
				return [{ id: 'computer-ble', label: 'BLE' }, { id: 'classic', label: '经典蓝牙 SPP' }]
			},
			requestPort: async function (sourceId) {
				reqSourceCalled = sourceId
				return {
					port: nextPicked,
					discard: async function () { discardCount++ },
				}
			},
		}
		const appPlatform = {
			service: function (name) {
				if (name === 'connection-source') return connSvc
				return null
			},
		}

		// 1) 验证 getPortMeta 对串口、无别名 BLE、带别名 BLE 与 BLU 端口的处理
		const serialMeta = WorkbenchMod.helpers.getPortMeta(pSerial.port, 0)
		assert.equal(serialMeta.title, 'CP2102 USB to UART Bridge')
		assert.equal(serialMeta.sub, 'cu.usbserial-1410 · 10C4:EA60')
		assert.equal(serialMeta.buttonLabel, 'CP2102 USB to UART Bridge (cu.usbserial-1410)')
		assert.equal(serialMeta.excluded, false)

		const bleMeta = WorkbenchMod.helpers.getPortMeta(pBleRaw.port, 1)
		assert.equal(bleMeta.title, 'WM-AC6D-01 · BLE')
		assert.equal(bleMeta.sub, '已保存 BLE · AA:BB:CC:11:22:33')
		assert.equal(bleMeta.wireless, true)
		assert.doesNotMatch(bleMeta.title, /串口设备/)

		const bleAliasMeta = WorkbenchMod.helpers.getPortMeta(pBleAliased.port, 2)
		assert.equal(bleAliasMeta.title, '测试水表1')
		assert.equal(bleAliasMeta.sub, '已保存 BLE · WM-AC6D-01 · AA:BB:CC:11:22:33')

		const bluMeta = WorkbenchMod.helpers.getPortMeta(pBlu.port, 3)
		assert.equal(bluMeta.excluded, true)

		// 2) 验证 refreshPorts 过滤 BLU 端口，requestPort('computer-ble') 自动打开连接，冲突时调 discard
		const allPorts = [pSerial.port, pBleRaw.port, pBleAliased.port, pBlu.port]
		const adapter = createMockSerialAdapter(allPorts)
		const ctrl = WorkbenchMod.createController({
			protocol: proto,
			serialAdapter: adapter,
			serialHub: { busyOwnerOfPort: function (p) { return p === pBusyBle.port ? { id: 'S' } : null } },
			appPlatform: appPlatform,
			appDialog: { alert: function () { return Promise.resolve() } },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})

		const listed = await ctrl.refreshPorts()
		assert.equal(listed.length, 3, 'BLU 端口 15A2:300A 必须被排除')
		assert.equal(listed[0].title, 'CP2102 USB to UART Bridge')
		assert.equal(listed[0].sub, 'cu.usbserial-1410 · 10C4:EA60')
		assert.equal(listed[1].title, 'WM-AC6D-01 · BLE')
		assert.equal(listed[2].title, '测试水表1')

		// 冲突的 BLE 端口返回 null 且必须触发 selection.discard()
		nextPicked = pBusyBle.port
		const conflictRes = await ctrl.requestPort('computer-ble')
		assert.equal(conflictRes, null)
		assert.equal(reqSourceCalled, 'computer-ble')
		assert.equal(discardCount, 1, '冲突被拒时必须调用 selection.discard() 释放 BLE 句柄')
		assert.equal(ctrl.isOpen(), false)

		// 正常选择 BLE 端口 -> 自动连接且不触发 discard
		nextPicked = pPickedBle.port
		allPorts.push(pPickedBle.port)
		const picked = await ctrl.requestPort('computer-ble')
		assert.equal(picked, pPickedBle.port)
		assert.equal(ctrl.getCurrentPort(), pPickedBle.port)
		assert.equal(ctrl.isOpen(), true, '无线 BLE 选口确认后必须自动连接')
		assert.equal(discardCount, 1)
		await ctrl.closePort({ manual: true })
		ctrl.destroy()

		// 3) UI 下拉渲染验证：包含 BLE 扫描入口、显示串口/BLE 标题和副标题、enumerable 下隐藏选择串口按钮
		function mkNode(tag) {
			const listeners = {}
			return {
				tagName: String(tag).toUpperCase(),
				className: '', textContent: '', value: '', title: '', type: '',
				hidden: false, disabled: false, checked: false, readOnly: false,
				dataset: {}, style: {}, childNodes: [], parentNode: null,
				get firstChild() { return this.childNodes[0] || null },
				classList: { toggle: function () {} },
				setAttribute: function () {},
				addEventListener: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
				removeEventListener: function () {},
				dispatchEvent: function (ev) { (listeners[ev.type || ev] || []).forEach(function (fn) { fn(ev) }) },
				contains: function () { return false },
				querySelector: function (sel) {
					if (sel === 'span') return this.childNodes.find(function (c) { return c.tagName === 'SPAN' }) || null
					return null
				},
				appendChild: function (c) { c.parentNode = this; this.childNodes.push(c); return c },
				removeChild: function (c) {
					const i = this.childNodes.indexOf(c)
					if (i >= 0) this.childNodes.splice(i, 1)
					c.parentNode = null
					return c
				},
			}
		}
		function collectText(node, out) {
			out = out || []
			if (node.textContent) out.push(node.textContent)
			node.childNodes.forEach(function (c) { collectText(c, out) })
			return out
		}
		const fakeDoc = { activeElement: null, createElement: mkNode, addEventListener: function () {}, removeEventListener: function () {} }
		const host = mkNode('div')
		const wb = WorkbenchMod.createWorkbench({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([pSerial.port, pBleRaw.port, pBlu.port]),
			appPlatform: appPlatform,
			document: fakeDoc,
		})
		wb.mount(host)
		await wb.controller.refreshPorts()
		const allTexts = collectText(host)
		assert.ok(allTexts.includes('CP2102 USB to UART Bridge'), '下拉应展示串口产品名')
		assert.ok(allTexts.includes('cu.usbserial-1410 · 10C4:EA60'), '下拉应展示串口副标题')
		assert.ok(allTexts.includes('WM-AC6D-01 · BLE'), '下拉应展示 BLE 设备名')
		assert.ok(allTexts.includes('扫描连接 BLE 蓝牙设备…'), '下拉应展示 BLE 无线扫描入口')
		assert.ok(allTexts.includes('连接经典蓝牙 SPP…'), '下拉应展示经典蓝牙 SPP 入口')
		wb.unmount()
	})

	// ---- 测试 19 (Issue #4): 基础参数编辑双向绑定、按钮不禁用与冷连接自动读取 0x33 + 0x42(0) 后写入 0x43 ----
	await test('Issue #4: 基础参数双向绑定抗重渲、按钮可点击与冷连接一键自动读 0x33/0x42 后写 0x43', async function () {
		const clock = createFakeClock()
		const proto = createMockProtocol()
		const mockPort = createMockPort({ path: 'COM50' })
		const alerts = []

		function mkNode(tag) {
			const listeners = {}
			return {
				tagName: String(tag).toUpperCase(),
				className: '', textContent: '', value: '', title: '', type: '',
				hidden: false, disabled: false, checked: false, readOnly: false,
				dataset: {}, style: {}, childNodes: [], parentNode: null,
				get firstChild() { return this.childNodes[0] || null },
				classList: { toggle: function () {} },
				setAttribute: function () {},
				addEventListener: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
				removeEventListener: function () {},
				dispatchEvent: function (ev) {
					const name = typeof ev === 'string' ? ev : ev.type
					;(listeners[name] || []).slice().forEach(function (fn) { fn(typeof ev === 'string' ? { type: ev, stopPropagation: function () {} } : ev) })
				},
				contains: function () { return false },
				querySelector: function (sel) {
					if (sel === 'span') return this.childNodes.find(function (c) { return c.tagName === 'SPAN' }) || null
					return null
				},
				appendChild: function (c) { c.parentNode = this; this.childNodes.push(c); return c },
				removeChild: function (c) {
					const i = this.childNodes.indexOf(c)
					if (i >= 0) this.childNodes.splice(i, 1)
					c.parentNode = null
					return c
				},
			}
		}
		function findAll(node, pred, out) {
			out = out || []
			if (pred(node)) out.push(node)
			node.childNodes.forEach(function (c) { findAll(c, pred, out) })
			return out
		}

		const fakeDoc = { activeElement: null, createElement: mkNode, addEventListener: function () {}, removeEventListener: function () {} }
		const host = mkNode('div')
		const wb = WorkbenchMod.createWorkbench({
			protocol: proto,
			serialAdapter: createMockSerialAdapter([mockPort.port]),
			appDialog: { alert: function (m) { alerts.push(m); return Promise.resolve() } },
			document: fakeDoc,
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			setInterval: clock.setInterval,
			clearInterval: clock.clearInterval,
		})
		wb.mount(host)

		// 1) 挂载即验证：写入基础参数按钮绝不被初始禁用
		const writeBtn = findAll(host, function (n) {
			return n.tagName === 'BUTTON' && n.childNodes.some(function (c) { return c.textContent === '写入基础参数 (0x43)' })
		})[0]
		assert.ok(writeBtn)
		assert.equal(writeBtn.disabled, false, '挂载时「写入基础参数 (0x43)」必须可点击')

		// 2) 验证基础参数卡片内的 .ac6d-field-grid 的 10 个基础参数控件均非 readOnly，且修改后立即同步至 state 并抗 layoutSel 切换重渲
		const fieldGrid = findAll(host, function (n) {
			return n.className === 'ac6d-field-grid' && n.parentNode && n.parentNode.childNodes.some(function (c) { return c.className === 'ac6d-base-info-bar' })
		})[0]
		assert.ok(fieldGrid)
		assert.equal(fieldGrid.childNodes.length, 10, '基础参数编辑网格应仅含 10 个可编辑配置项')
		const fieldMap = {}
		fieldGrid.childNodes.forEach(function (box) {
			const lbl = box.childNodes[0].textContent
			const ctrlEl = box.childNodes[1]
			assert.equal(ctrlEl.readOnly, false, lbl + ' 不应为只读')
			fieldMap[lbl] = ctrlEl
		})

		fieldMap['采集间隔 (min)'].value = '15'
		fieldMap['采集间隔 (min)'].dispatchEvent('input')
		fieldMap['电压报警阈值 (V)'].value = '3.25'
		fieldMap['电压报警阈值 (V)'].dispatchEvent('input')
		fieldMap['底度值 (脉冲数)'].value = '123456'
		fieldMap['底度值 (脉冲数)'].dispatchEvent('input')

		assert.equal(wb.controller.state.params.base.sampleIntervalMin, 15)
		assert.equal(wb.controller.state.params.base.voltageAlarmV, 3.25)
		assert.equal(wb.controller.state.params.base.baseDegree, '123456')

		// 切换布局下拉触发 renderParams() -> 用户修改必须完整保留不被冲回默认值！
		const layoutSel = findAll(host, function (n) {
			return n.tagName === 'SELECT' && n.childNodes.some(function (o) { return o.value === 'v27-40' })
		})[0]
		assert.ok(layoutSel)
		layoutSel.value = 'legacy-48'
		layoutSel.dispatchEvent('change')
		assert.equal(fieldMap['采集间隔 (min)'].value, '15', 'renderParams 不得覆盖用户修改的采集间隔')
		assert.equal(fieldMap['电压报警阈值 (V)'].value, '3.25', 'renderParams 不得覆盖用户修改的电压阈值')
		assert.equal(fieldMap['底度值 (脉冲数)'].value, '123456', 'renderParams 不得覆盖用户修改的底度值')
		layoutSel.value = 'auto'
		layoutSel.dispatchEvent('change')

		// 3) 冷连接后直接点击「写入基础参数 (0x43)」：自动先发 0x33 -> 再发 0x42(0) -> 保留用户编辑并保留水表真实 onlyAddrHex 和未修改字段 -> 发送 0x43！
		await wb.controller.openPort({ port: mockPort.port })
		assert.equal(wb.controller.getEffectiveAuthCode(), null)
		assert.equal(wb.controller.isBaseParamsSnapshotValid(), false)

		writeBtn.dispatchEvent('click')
		await clock.flushMicrotasks()

		// 应自动发出 0x33
		assert.equal(proto.sentRecords.length, 1)
		assert.equal(proto.sentRecords[0].tag, proto.CMD.DEV_INFO)
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.DEV_INFO,
				seq: proto.sentRecords[0].opts.seq,
				typeOrStatus: proto.STATUS.OK,
				detail: { onlyAddrHex: '01020378563412', firmwareVersion: 'V2.7.1', mode: 1 },
			},
		}))
		await clock.flushMicrotasks()

		// 收到 0x33 后应自动发出 0x42(0)
		assert.equal(proto.sentRecords.length, 2)
		assert.equal(proto.sentRecords[1].tag, proto.CMD.PARAM_READ)
		assert.equal(proto.sentRecords[1].opts.paramType, 0)
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: {
				cmd: proto.CMD.PARAM_READ,
				seq: proto.sentRecords[1].opts.seq,
				typeOrStatus: proto.STATUS.OK,
				detail: {
					paramType: 0,
					layout: 'v27-40',
					base: {
						onlyAddrHex: '01020378563412',
						voltageAlarmV: 3.1,
						sampleIntervalMin: 60,
						baseDegree: '100',
						meterPulseEq: 25000,
						initFlag: 0x55,
						crcHex: '0xABCD',
					},
				},
			},
		}))
		await clock.flushMicrotasks()

		// 收到 0x42(0) 后应自动发出 0x43，且保留用户的 3 个修改 + 水表真实 onlyAddrHex + 水表原有的 meterPulseEq=25000
		assert.equal(proto.sentRecords.length, 3)
		const writeRec = proto.sentRecords[2]
		assert.equal(writeRec.tag, proto.CMD.PARAM_WRITE)
		assert.equal(writeRec.opts.baseObj.onlyAddrHex, '01020378563412')
		assert.equal(writeRec.opts.baseObj.sampleIntervalMin, 15)
		assert.equal(writeRec.opts.baseObj.voltageAlarmV, 3.25)
		assert.equal(writeRec.opts.baseObj.baseDegree, 123456n)
		assert.equal(writeRec.opts.baseObj.meterPulseEq, 25000)

		// 收到 0x43 OK 应答 -> 状态更新为成功且 dirtyKeys 清空
		mockPort.getSink().data(proto.encodeMockEventFrame({
			kind: 'ac6d',
			parsed: { cmd: proto.CMD.PARAM_WRITE, seq: writeRec.opts.seq, typeOrStatus: proto.STATUS.OK, detail: {} },
		}))
		await clock.flushMicrotasks()
		assert.equal(wb.controller.state.params.writeStatus, '基础参数写入成功 ✓')
		assert.equal(wb.controller.state.params.writeTone, 'ok')
		assert.equal(wb.controller.state.params.dirtyKeys.length, 0)
		assert.equal(alerts.length, 0)
		wb.unmount()
	})

	console.log('\nALL ' + passed + ' TESTS PASSED.')
}

runTests().catch(function (err) {
	console.error(err)
	process.exit(1)
})
