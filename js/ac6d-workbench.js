// 容积式电子水表独立左栏工作台 (#view-ac6d)：
// 单路串口连接、流量监控/LCD防回退/4倍频插值/脉冲计时/双轴曲线、20点正反向S曲线与写入自动回读校验、
// 三锚点对数误差推算、基础/计量/报警参数与日冻结自动翻页、设备内部日志、系统控制、
// 16B 固件头 & APP2(0x8000) OTA 6 步状态机，以及一键「保存全部数据 (JSON)」4 步串行绑定导出。
// 依赖 window.Ac6dProtocol、window.SerialAdapter、window.AppDialog、window.ToolPluginRegistry。
;(function (root) {
	'use strict'

	const ANCHOR_STORAGE_KEY = 'ac6dAnchorConfig'
	const LOG_MAX_ROWS = 2000
	const FLOW_HISTORY_MAX = 120
	const READ_RECOVER_WINDOW_MS = 10000
	const READ_RECOVER_MAX = 20
	const STREAM_SWAP_WAIT_MS = 2000

	const DEFAULT_TIMINGS = {
		saveTimeouts: [3000, 4000, 3000, 3000],
		saveGapMs: 300,
		saveRetryDelays: [1000, 2000],
		passthroughExtraMs: 3000,
		calibWriteAckMs: 5000,
		calibVerifyDelayMs: 3000,
		calibVerifyTimeoutMs: 5000,
		baseDegreeTimeoutMs: 5000,
		freezePageTimeoutMs: 5000,
		otaStepGapMs: 300,
		otaHandshakeMs: 3000,
		otaEraseMs: 5000,
		otaChunkMs: 5000,
		otaCrcMs: 3000,
		otaResetWaitMs: 15000,
		otaVerifyMs: 5000,
		otaRetryDelayMs: 2000,
	}

	const MODE_NAMES = {
		0: '休眠',
		1: '快速响应',
		2: '校表',
	}

	const LCD_MODES = [
		{ id: 'net_m3', label: '净累计体积 (m³)', unit: 'm³' },
		{ id: 'pos_m3', label: '正累计体积 (m³)', unit: 'm³' },
		{ id: 'rev_m3', label: '反累计体积 (m³)', unit: 'm³' },
		{ id: 'flow_m3h', label: '瞬时流速 (m³/h)', unit: 'm³/h' },
		{ id: 'pos_pulse', label: '正累计脉冲', unit: '脉冲' },
		{ id: 'rev_pulse', label: '反累计脉冲', unit: '脉冲' },
	]

	const OTA_STEPS = [
		{ idx: 0, title: '0x20 握手' },
		{ idx: 1, title: '0x24 擦除 APP2' },
		{ idx: 2, title: '0x22 分包下载' },
		{ idx: 3, title: '0x25 CRC 校验' },
		{ idx: 4, title: '0x26 OTA 完成' },
		{ idx: 5, title: '0x33 复位验证' },
	]

	function pad2(n) {
		return String(n).padStart(2, '0')
	}

	function pad3(n) {
		return String(n).padStart(3, '0')
	}

	function fmtClockMs(d) {
		const dt = d instanceof Date ? d : new Date(d || Date.now())
		return pad2(dt.getHours()) + ':' + pad2(dt.getMinutes()) + ':' + pad2(dt.getSeconds()) + '.' + pad3(dt.getMilliseconds())
	}

	function fmtDateTime(d) {
		const dt = d instanceof Date ? d : new Date(d || Date.now())
		return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()) + ' ' +
			pad2(dt.getHours()) + ':' + pad2(dt.getMinutes()) + ':' + pad2(dt.getSeconds())
	}

	function bytesToHexUpper(bytes, spaced) {
		if (!bytes || !bytes.length) return ''
		const arr = []
		for (let i = 0; i < bytes.length; i++) {
			arr.push((bytes[i] & 0xff).toString(16).toUpperCase().padStart(2, '0'))
		}
		return arr.join(spaced ? ' ' : '')
	}

	function parseHexStr(str) {
		const clean = String(str || '').replace(/0x/gi, '').replace(/[\s,:-]+/g, '')
		if (!clean) return new Uint8Array(0)
		if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null
		const out = new Uint8Array(clean.length / 2)
		for (let i = 0; i < out.length; i++) {
			out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
		}
		return out
	}

	function parseUint32Hex(str) {
		const clean = String(str || '').trim().replace(/^0x/i, '').replace(/\s+/g, '')
		if (!clean || !/^[0-9a-fA-F]{1,8}$/.test(clean)) return null
		return parseInt(clean, 16) >>> 0
	}

	function hex32(val) {
		if (val == null || !isFinite(val)) return '--'
		return '0x' + ((val >>> 0).toString(16).toUpperCase().padStart(8, '0'))
	}

	function hex16(val) {
		if (val == null || !isFinite(val)) return '--'
		return '0x' + ((val & 0xffff).toString(16).toUpperCase().padStart(4, '0'))
	}

	function numVal(v, fallback) {
		if (typeof v === 'bigint') return Number(v)
		const n = Number(v)
		return Number.isFinite(n) ? n : (fallback || 0)
	}

	function round1(v) {
		return Math.round(numVal(v, 0) * 10) / 10
	}

	function round4(v) {
		return Math.round(numVal(v, 0) * 10000) / 10000
	}

	function bytesEqual(a, b) {
		if (!a || !b || a.length !== b.length) return false
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false
		}
		return true
	}

	const MAX_U64_BI = typeof BigInt === 'function' ? 0xffffffffffffffffn : null

	function isValidUidHex7(hex) {
		const s = String(hex || '').trim().toUpperCase()
		return /^[0-9A-F]{14}$/.test(s) && s !== '00000000000000'
	}

	function parseUint64Input(val) {
		if (typeof val === 'bigint') {
			if (val < 0n || val > MAX_U64_BI) return { ok: false, error: '底度超出 uint64 范围' }
			return { ok: true, value: val, text: val.toString() }
		}
		const clean = String(val == null ? '' : val).trim()
		if (!/^\d+$/.test(clean)) {
			return { ok: false, error: '底度格式无效' }
		}
		if (typeof BigInt === 'function') {
			const bi = BigInt(clean)
			if (bi < 0n || bi > MAX_U64_BI) {
				return { ok: false, error: '底度超出 uint64 范围' }
			}
			return { ok: true, value: bi, text: clean }
		}
		const n = Number(clean)
		if (!Number.isFinite(n) || n < 0) {
			return { ok: false, error: '底度超出 uint64 范围' }
		}
		return { ok: true, value: n, text: clean }
	}

	function encodeCalib176Bytes(c) {
		const buf = new Uint8Array(176)
		const dv = new DataView(buf.buffer)
		dv.setUint32(0, (Number(c.meterPulseEq) || 0) >>> 0, true)
		dv.setUint32(4, (Number(c.calibPulseEq) || 0) >>> 0, true)
		dv.setUint32(8, (Number(c.commPulseEq) || 0) >>> 0, true)
		buf[12] = 0
		buf[13] = 0
		buf[14] = Math.max(0, Math.min(20, Number(c.fwdCount) || 0)) & 0xff
		buf[15] = Math.max(0, Math.min(20, Number(c.revCount) || 0)) & 0xff
		let off = 16
		const fp = c.fwdPoints || []
		const fc = c.fwdCoeffs || []
		const rp = c.revPoints || []
		const rc = c.revCoeffs || []
		for (let i = 0; i < 20; i++) {
			dv.setUint16(off, (Number(fp[i]) || 0) & 0xffff, true)
			dv.setUint16(off + 2, (Number(fc[i]) || 0) & 0xffff, true)
			off += 4
		}
		for (let i = 0; i < 20; i++) {
			dv.setUint16(off, (Number(rp[i]) || 0) & 0xffff, true)
			dv.setUint16(off + 2, (Number(rc[i]) || 0) & 0xffff, true)
			off += 4
		}
		return buf
	}

	function describePort(port, index) {
		if (!port) return '未选择串口'
		let info = {}
		try { info = port.getInfo ? (port.getInfo() || {}) : {} } catch (e) {}
		if (info.path) return String(info.path)
		if (info.name) return String(info.name)
		if (info.friendlyName) return String(info.friendlyName)
		if (info.displayName) return String(info.displayName)
		const vid = info.usbVendorId != null ? info.usbVendorId.toString(16).toUpperCase().padStart(4, '0') : ''
		const pid = info.usbProductId != null ? info.usbProductId.toString(16).toUpperCase().padStart(4, '0') : ''
		const sn = info.serialNumber || info.usbSerialNumber || ''
		const transport = info.transport ? ('[' + String(info.transport).toUpperCase() + '] ') : ''
		if (sn && vid && pid) return transport + sn + ' (' + vid + ':' + pid + ')'
		if (sn) return transport + sn
		if (vid && pid) return transport + 'USB ' + vid + ':' + pid + (index != null ? (' #' + (index + 1)) : '')
		return transport + '串口设备' + (index != null ? (' #' + (index + 1)) : '')
	}

	function isWirelessPort(port) {
		if (!port || typeof port.getInfo !== 'function') return false
		try {
			const info = port.getInfo() || {}
			return info.transport === 'ble' || info.transport === 'bt-classic'
		} catch (e) {
			return false
		}
	}

	function makeDefaultCalibState() {
		return {
			meterPulseEq: 17085,
			calibPulseEq: 1000,
			commPulseEq: 60000,
			fwdCount: 20,
			revCount: 20,
			fwdPoints: new Array(20).fill(0),
			fwdCoeffs: new Array(20).fill(10000),
			fwdErrors: new Array(20).fill(0),
			fwdNewCoeffs: new Array(20).fill(null),
			revPoints: new Array(20).fill(0),
			revCoeffs: new Array(20).fill(10000),
			revErrors: new Array(20).fill(0),
			revNewCoeffs: new Array(20).fill(null),
		}
	}

	function makeDefaultBaseParams() {
		return {
			onlyAddrHex: '',
			voltageAlarmV: 3.10,
			sampleIntervalMin: 60,
			baseDegree: '0',
			initFlag: 0x55,
			meterPulseEq: 17085,
			calibPulseEq: 1000,
			commPulseEq: 60000,
			calibEnable: 1,
			calibDirection: 0,
			tempCompCoef: 10000,
			tempCompBaseC: 20.0,
			crcHex: '--',
		}
	}

	function makeDefaultAnchorTables(proto) {
		if (proto && typeof proto.createAnchorTable === 'function') {
			return {
				fwd: proto.createAnchorTable('fwd'),
				rev: proto.createAnchorTable('rev'),
			}
		}
		return {
			fwd: { Q3: [], Q2: [], Q1: [] },
			rev: { Q3: [], Q2: [], Q1: [] },
		}
	}

	function fallbackBuildCalibBindFileName(userNumber, date) {
		const dt = date instanceof Date ? date : new Date(date || Date.now())
		const stamp = dt.getFullYear() + pad2(dt.getMonth() + 1) + pad2(dt.getDate()) + '_' +
			pad2(dt.getHours()) + pad2(dt.getMinutes()) + pad2(dt.getSeconds())
		const raw = String(userNumber || '').trim()
		let batch = 'N'
		let tail0 = 'N'
		if (raw.length >= 20) {
			batch = raw.slice(6, 16)
			tail0 = raw.slice(16, 20)
		} else if (raw.length >= 4) {
			batch = raw.slice(0, Math.max(1, raw.length - 4))
			tail0 = raw.slice(-4)
		}
		return batch + '_' + tail0 + '_N_N_N_N_N_N_N_N_N_校表数据_' + stamp + '.json'
	}

	function fallbackBuildCalibBindJson(payload) {
		const p = payload || {}
		const nowStr = fmtDateTime(p.date || p.savedAt || new Date())
		const portLabel = p.port != null && p.port !== '' ? String(p.port) : String(p.portName || '')
		const dev = p.device || null
		const mod = p.moduleInfo || null
		const base = p.baseParams || null
		const calib = p.calibData || null
		const io = p.serialIo || {}
		const okDev = !!dev
		const okCalib = !!calib
		const sensorStatus = (okDev && okCalib) ? '成功' : ((okDev || okCalib) ? '部分成功' : '失败')
		const basic = (mod && mod.basic) ? mod.basic : (mod || {})
		const hasModId = !!(basic.imei || basic.iccid)
		const modStatus = hasModId ? '成功' : (mod ? '部分成功' : '失败')

		const slot0 = {
			statu: {
				串口使能: '使能',
				读取传感器信息: sensorStatus,
				读取远传模组信息: modStatus,
			},
		}
		if (dev) {
			slot0.device = {
				only_addr: dev.onlyAddrHex || '',
				firmware_version: dev.firmwareVersion || '',
				user_number: p.userNumber || basic.userNumber || '',
				temperature: dev.temperatureC != null ? dev.temperatureC : '',
				voltage: dev.voltageV != null ? dev.voltageV : '',
				mode: dev.modeText || MODE_NAMES[dev.mode] || '',
			}
		}
		if (mod) {
			slot0.nb_module = {
				imei: basic.imei || '',
				imsi: basic.imsi || '',
				iccid: basic.iccid || '',
				user_number: basic.userNumber || '',
				device_code: basic.deviceCode || mod.deviceCode || '',
				firmware_version: basic.firmwareVersion || '',
				device_time: basic.deviceTime || '',
				base_meter_number: basic.baseMeterNumber || '',
				module_fw: basic.moduleFw || '',
				bluetooth_mac: basic.bluetoothMac || '',
				signal: mod.signal || {},
				query_status: hasModId ? 'ok' : 'partial',
			}
		}
		if (base) {
			slot0.basic_data = {
				'设备唯一码(onlyAddr)': base.onlyAddrHex || '',
				'电池电压报警阈值(V)': base.voltageAlarmV,
				'数据采集间隔(min)': base.sampleIntervalMin,
				'底度值(脉冲数)': Number(base.baseDegree) || 0,
				'系统参数初始化标志': '0x' + ((Number(base.initFlag) || 0) & 0xff).toString(16).toUpperCase().padStart(2, '0'),
				'计量脉冲当量(uL/脉冲)': base.meterPulseEq,
				'校准脉冲当量(uL/脉冲)': base.calibPulseEq,
				'上报脉冲当量(uL/脉冲)': base.commPulseEq,
				'校准使能': base.calibEnable ? '开启' : '关闭',
				'校准方向': base.calibDirection ? '反向' : '正向',
				'温度补偿系数': base.tempCompCoef,
				'基准温度(°C)': base.tempCompBaseC,
				'结构体CRC': base.crcHex || '--',
			}
		}
		if (calib) {
			slot0.calib_data = {
				meter_pulse_eq: calib.meterPulseEq,
				calib_pulse_eq: calib.calibPulseEq,
				comm_pulse_eq: calib.commPulseEq,
				fwd_count: calib.fwdCount,
				rev_count: calib.revCount,
				fwd_points: (calib.fwdPoints || []).slice(0, 20),
				fwd_coeffs: (calib.fwdCoeffs || []).slice(0, 20),
				rev_points: (calib.revPoints || []).slice(0, 20),
				rev_coeffs: (calib.revCoeffs || []).slice(0, 20),
			}
		}
		slot0.serial = {
			port: portLabel,
			connected: !!p.connected,
			serial_io: io,
		}

		const record = {
			schema: 'SK-CALIB-BIND',
			schema_version: 4,
			saved_at: nowStr,
			source: {
				device_slot: 0,
				port: portLabel,
			},
			serial_params: p.serialParams || { baud: 9600, parity: 'N', stopbits: 1, bytesize: 8 },
			批次: p.batch || 'N',
			台位使能: {
				数量: 1,
				台位: [0],
			},
			台位0: slot0,
		}
		for (let i = 1; i < 10; i++) {
			record['台位' + i] = {
				statu: {
					串口使能: '未使能',
					读取传感器信息: '无',
					读取远传模组信息: '无',
				},
			}
		}
		return record
	}

	async function saveFileViaPlatform(fileName, content, mimeType, appPlatform, doc) {
		const mime = mimeType || 'application/octet-stream'
		const svc = appPlatform && typeof appPlatform.service === 'function' ? appPlatform.service('file-save') : null
		if (typeof svc === 'function') {
			await svc(fileName, content, mime)
			return true
		}
		if (svc && typeof svc.save === 'function') {
			await svc.save({ fileName: fileName, content: content, mimeType: mime })
			return true
		}
		if (!doc || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
			return false
		}
		const blob = content instanceof Uint8Array
			? new Blob([content], { type: mime })
			: new Blob([String(content)], { type: mime })
		const url = URL.createObjectURL(blob)
		const a = doc.createElement('a')
		a.href = url
		a.download = fileName
		a.style.display = 'none'
		if (doc.body) doc.body.appendChild(a)
		a.click()
		setTimeout(function () {
			try { a.remove() } catch (e) {}
			try { URL.revokeObjectURL(url) } catch (e) {}
		}, 1000)
		return true
	}

	// =========================================================================
	// 核心无界面控制器（串口生命周期、协议收发与全部状态机，供 UI 与 Node 测试共用）
	// =========================================================================
	function createController(deps) {
		deps = deps || {}
		const getProto = function () { return deps.protocol || root.Ac6dProtocol }
		const getAdapter = function () { return deps.serialAdapter !== undefined ? deps.serialAdapter : root.SerialAdapter }
		const getHub = function () { return deps.serialHub !== undefined ? deps.serialHub : root.SerialHub }
		const getBlu = function () { return deps.bluApi !== undefined ? deps.bluApi : root.bluApi }
		const getRegistry = function () { return deps.toolPluginRegistry !== undefined ? deps.toolPluginRegistry : root.ToolPluginRegistry }
		const getPlatform = function () { return deps.appPlatform !== undefined ? deps.appPlatform : root.AppPlatform }
		const getDialog = function () { return deps.appDialog !== undefined ? deps.appDialog : root.AppDialog }
		const getStorage = function () {
			if (deps.storage !== undefined) return deps.storage
			try { return root.localStorage || null } catch (e) { return null }
		}
		const getDoc = function () { return deps.document !== undefined ? deps.document : (typeof document !== 'undefined' ? document : null) }
		const nowMs = function () { return typeof deps.now === 'function' ? deps.now() : Date.now() }
		const nowDate = function () { return new Date(nowMs()) }
		const schedTimeout = deps.setTimeout || setTimeout
		const cancelTimeout = deps.clearTimeout || clearTimeout
		const schedInterval = deps.setInterval || setInterval
		const cancelInterval = deps.clearInterval || clearInterval
		const timings = Object.assign({}, DEFAULT_TIMINGS, deps.timings || {})

		const listeners = new Set()
		function emit(topic, payload) {
			listeners.forEach(function (fn) {
				try { fn(topic, payload) } catch (e) {}
			})
		}
		function onChange(fn) {
			if (typeof fn !== 'function') return function () {}
			listeners.add(fn)
			return function () { listeners.delete(fn) }
		}

		// ---- 串口状态 ----
		let currentPort = null
		let heldPort = null
		let openingPort = null
		let openPromise = null
		let openOpSeq = 0
		let closeFailed = false
		let knownPorts = []
		let isOpen = false
		let isOpening = false
		let isClosing = false
		let manualClose = true
		let connGen = 0
		let activeReader = null
		let writeChain = Promise.resolve()
		let streamParser = null
		let adapterBound = false
		let onAdapterDisconnect = null
		let onAdapterChange = null
		let portEnumSeq = 0
		let destroyed = false
		let saveRunSeq = 0
		let activeSaveRun = null
		const sentDevInfoSeqs = new Set()
		const pendingBaseParamReadSeqs = new Set()

		const state = {
			baudRate: 9600,
			parity: 'none',
			passthrough: false,
			withTimeSync: true,
			seq: 1,
			iotSeq: 1,
			activeTab: 'flow',
			device: {
				onlyAddrHex: '',
				onlyAddrBytes: null,
				authCode: null,
				manualAuthCode: null,
				deviceConnGen: -1,
				firmwareVersion: '',
				mode: null,
				modeText: '--',
				temperatureC: null,
				voltageV: null,
				flags: 0,
				alarms: [],
				sensorTime: '--',
				powerResetCount: 0,
				wdtResetCount: 0,
				totalRunTimeSec: 0,
				activeRunTimeSec: 0,
			},
			flow: {
				monitorRunning: false,
				pollIntervalSec: 1,
				pollCmd: '0x31',
				lcdMode: 'net_m3',
				posPulse: 0,
				revPulse: 0,
				netPulse: 0,
				rawPosVolUl: 0,
				rawRevVolUl: 0,
				displayPosVolUl: 0,
				displayRevVolUl: 0,
				displayNetVolUl: 0,
				lastPosVolGuardUl: null,
				lastPosVolGuardUid: '',
				rollbackGuarded: false,
				flowRateM3h: 0,
				flowRateLph: 0,
				pulseIntervalMs: 0,
				isFlowing: false,
				isReverse: false,
				quadRemainder: 0,
				mode: null,
				modeText: '--',
				temperatureC: null,
				voltageV: null,
				pulseEqUl: 17085,
				flags: 0,
				alarms: [],
				deviceTime: '--',
				history: [],
			},
			pulseTiming: {
				active: false,
				auto: false,
				t0Ms: null,
				t1Ms: null,
				direction: null,
				pulseCount: 0,
				prevPosPulse: null,
				prevRevPulse: null,
			},
			calib: makeDefaultCalibState(),
			calibViewMode: 'fwd',
			calibVerify: {
				connGen: -1,
				writeSeq: null,
				readSeq: null,
				waitingWriteAck: false,
				pendingExpected: null,
				waitingDelay: false,
				waitingReadback: false,
				lastStatus: '',
				lastTone: '',
			},
			anchor: {
				direction: 'fwd',
				calibReadDone: false,
				tables: makeDefaultAnchorTables(getProto()),
			},
			params: {
				base: makeDefaultBaseParams(),
				baseLoaded: false,
				baseConnGen: -1,
				baseUidHex: '',
				detectedLayout: 'v27-40',
				layoutMode: 'auto',
				meter: null,
				alarm: null,
				baseDegreeStatus: '',
				baseDegreeTone: '',
			},
			freeze: {
				startIndex: 0,
				totalCount: 0,
				autoReading: false,
				nextIndex: 0,
				skippedCorruptCount: 0,
				entries: [],
			},
			deviceLogs: {
				logType: 0xff,
				entries: [],
			},
			ota: {
				fileName: '',
				rawBytes: null,
				inspect: null,
				chunkSize: 256,
				runChunkSize: 0,
				pendingChunkLen: 0,
				running: false,
				runGen: -1,
				step: -1,
				stepStatus: ['idle', 'idle', 'idle', 'idle', 'idle', 'idle'],
				progress: 0,
				statusText: '未开始',
				imageBytes: null,
				totalSize: 0,
				expectedCrc: 0,
				deviceCrc: null,
				currentAddr: 0x8000,
				sentBytes: 0,
				waitingAck: false,
				pendingSeq: null,
				pendingCmd: null,
				verifySeq: null,
				finishSent: false,
				finishAcked: false,
				retryCount: 0,
				maxRetries: 5,
				originalVersion: '',
				originalOnlyAddr: '',
				expectedVersion: '',
				proactiveReceived: false,
				manualPacketIndex: 0,
				lastResult: null,
			},
			saveAll: {
				running: false,
				step: -1,
				retryCount: 0,
				stepDone: false,
				progressText: '',
				deviceSnap: null,
				calibSnap: null,
				baseSnap: null,
				moduleInfo: null,
				serialIo: {},
				lastRecord: null,
				lastFileName: '',
			},
			logs: [],
			logCollapsed: false,
		}

		// 定时器句柄集中管理，关闭/卸载时全部清理
		const timers = {
			flowPoll: null,
			calibVerifyWriteAck: null,
			calibVerifyDelay: null,
			calibVerifyTimeout: null,
			baseDegreeTimeout: null,
			freezeTimeout: null,
			otaStep: null,
			otaTimeout: null,
			otaRetry: null,
			saveStepTimeout: null,
			saveGap: null,
			saveRetry: null,
		}

		function clearTimer(name) {
			if (timers[name] != null) {
				if (name === 'flowPoll') cancelInterval(timers[name])
				else cancelTimeout(timers[name])
				timers[name] = null
			}
		}

		function clearAllWorkflowTimers() {
			Object.keys(timers).forEach(clearTimer)
		}

		function addLog(dir, msg, hex) {
			const entry = {
				ts: fmtClockMs(nowDate()),
				dir: dir || 'SYS',
				msg: String(msg || ''),
				hex: hex || '',
			}
			state.logs.push(entry)
			if (state.logs.length > LOG_MAX_ROWS) {
				state.logs.splice(0, state.logs.length - LOG_MAX_ROWS)
			}
			emit('log', entry)
			return entry
		}

		function clearLogs() {
			state.logs.length = 0
			emit('log-clear')
		}

		function notifyStatusBadge() {
			const reg = getRegistry()
			if (reg && typeof reg.refreshBadges === 'function') {
				try { reg.refreshBadges() } catch (e) {}
			}
			emit('connection')
		}

		function dialogAlert(message, title) {
			const dlg = getDialog()
			if (dlg && typeof dlg.alert === 'function') {
				return dlg.alert(message, { title: title || '提示' })
			}
			return Promise.resolve()
		}

		function dialogConfirm(message, opts) {
			const dlg = getDialog()
			if (dlg && typeof dlg.confirm === 'function') {
				return dlg.confirm(message, opts || {})
			}
			return Promise.resolve(true)
		}

		function otaDelay(baseMs) {
			return state.passthrough ? (baseMs + timings.passthroughExtraMs) : baseMs
		}

		function nextSeq() {
			const s = state.seq
			state.seq = (s % 255) + 1
			return s
		}

		function nextIotSeq() {
			const s = state.iotSeq
			state.iotSeq = (s % 65535) + 1
			return s
		}

		function getEffectiveAuthCode() {
			if (state.device.manualAuthCode != null && state.device.manualAuthCode !== 0) {
				return state.device.manualAuthCode >>> 0
			}
			if (isOpen && state.device.deviceConnGen === connGen && state.device.authCode != null && state.device.authCode !== 0) {
				return state.device.authCode >>> 0
			}
			return null
		}

		function resetSessionDeviceIdentity() {
			state.device.onlyAddrHex = ''
			state.device.onlyAddrBytes = null
			state.device.authCode = null
			state.device.deviceConnGen = -1
			state.device.firmwareVersion = ''
			state.device.mode = null
			state.device.modeText = '--'
			state.device.temperatureC = null
			state.device.voltageV = null
			state.device.flags = 0
			state.device.alarms = []
			state.device.sensorTime = '--'
			state.device.powerResetCount = 0
			state.device.wdtResetCount = 0
			state.device.totalRunTimeSec = 0
			state.device.activeRunTimeSec = 0
			state.anchor.calibReadDone = false
			state.flow.lastPosVolGuardUl = null
			state.flow.lastPosVolGuardUid = ''
			state.flow.rollbackGuarded = false
			emit('device')
		}

		function setManualAuthCode(hexInput) {
			const trimmed = String(hexInput || '').trim()
			if (!trimmed) {
				state.device.manualAuthCode = null
				addLog('SYS', '已清除手动认证码覆盖，恢复跟随设备唯一号')
				emit('device')
				return { ok: true, value: null }
			}
			const v = parseUint32Hex(trimmed)
			if (v == null || v === 0) {
				return { ok: false, error: '请输入非零 1~8 位十六进制认证码（例如 12345678）' }
			}
			state.device.manualAuthCode = v
			addLog('SYS', '已启用手动认证码覆盖: ' + hex32(v))
			emit('device')
			return { ok: true, value: v }
		}

		function invalidateBaseParamsSnapshot() {
			pendingBaseParamReadSeqs.clear()
			state.params.baseLoaded = false
			state.params.baseConnGen = -1
			state.params.baseUidHex = ''
			state.params.base.onlyAddrHex = ''
			state.params.detectedLayout = 'v27-40'
			emit('params')
		}

		function isBaseParamsSnapshotValid() {
			const p = state.params
			if (!p.baseLoaded || p.baseConnGen !== connGen) return false
			if (!isValidUidHex7(p.baseUidHex)) return false
			if (state.device.onlyAddrHex && p.baseUidHex !== state.device.onlyAddrHex) return false
			return true
		}

		function updateDeviceIdentity(onlyAddrHex, onlyAddrBytes, authCodeHint) {
			const proto = getProto()
			const prevUid = state.device.onlyAddrHex
			const newUid = onlyAddrHex ? String(onlyAddrHex).toUpperCase() : ''
			if (newUid) state.device.onlyAddrHex = newUid
			if (onlyAddrBytes) state.device.onlyAddrBytes = onlyAddrBytes
			let code = authCodeHint
			if ((code == null || code === 0) && proto && typeof proto.uidBytesToAuthCode === 'function') {
				code = proto.uidBytesToAuthCode(onlyAddrBytes || onlyAddrHex)
			}
			if (code != null && code !== 0) {
				state.device.authCode = code >>> 0
			}
			if (isOpen && (newUid || (code != null && code !== 0))) {
				state.device.deviceConnGen = connGen
			}
			if (newUid && state.params.baseUidHex && newUid !== state.params.baseUidHex) {
				invalidateBaseParamsSnapshot()
			}
			if (prevUid && state.device.onlyAddrHex && prevUid !== state.device.onlyAddrHex) {
				// 更换了不同水表：自动重置正累计防回退锁，并作废旧表基础参数快照
				state.flow.lastPosVolGuardUl = null
				state.flow.lastPosVolGuardUid = state.device.onlyAddrHex
				state.flow.rollbackGuarded = false
				if (state.params.baseLoaded) {
					invalidateBaseParamsSnapshot()
				}
				addLog('SYS', '检测到设备唯一号变化（' + prevUid + ' → ' + state.device.onlyAddrHex + '），已重置正累计防回退基准并作废基础参数快照')
			}
		}

		// ---- 端口冲突检查与串口枚举 ----
		function checkPortConflict(port) {
			if (!port) return null
			const hub = getHub()
			if (hub) {
				if (typeof hub.busyOwnerOfPort === 'function') {
					const owner = hub.busyOwnerOfPort(port)
					if (owner) return '通信调试已占用'
				} else if (typeof hub.findSessionByPort === 'function') {
					const sess = hub.findSessionByPort(port)
					if (sess) return '通信调试已占用'
				}
			}
			const blu = getBlu()
			if (blu && typeof blu.ownsPort === 'function') {
				try {
					const bluBusy = !!blu.ownsPort(port)
					if (bluBusy) return '功耗分析已占用'
				} catch (e) {}
			}
			const reg = getRegistry()
			if (reg && typeof reg.findPortOwner === 'function') {
				try {
					const owner = reg.findPortOwner(port, { exceptId: 'ac6d' })
					if (owner) return (owner.name || owner.label || owner.id || '其他工具') + '已占用'
				} catch (e) {}
			}
			return null
		}

		async function refreshPorts() {
			if (destroyed) return []
			const seq = ++portEnumSeq
			const adapter = getAdapter()
			if (!adapter || typeof adapter.isSupported !== 'function' || !adapter.isSupported()) {
				if (seq !== portEnumSeq || destroyed) return []
				knownPorts = []
				emit('ports', [])
				return []
			}
			try {
				const list = (typeof adapter.canEnumerate === 'function' && adapter.canEnumerate() && typeof adapter.listPorts === 'function')
					? await adapter.listPorts()
					: await adapter.getPorts()
				if (seq !== portEnumSeq || destroyed) return []
				knownPorts = Array.isArray(list) ? list.slice() : []
				if (currentPort && knownPorts.indexOf(currentPort) < 0 && !isOpen && !isOpening && !isClosing && !closeFailed) {
					currentPort = null
				}
				if (!currentPort && knownPorts.length) {
					for (let i = 0; i < knownPorts.length; i++) {
						if (!checkPortConflict(knownPorts[i])) {
							currentPort = knownPorts[i]
							break
						}
					}
				}
				const mapped = knownPorts.map(function (p, i) {
					return {
						port: p,
						label: describePort(p, i),
						busyReason: checkPortConflict(p),
						wireless: isWirelessPort(p),
						selected: p === currentPort,
					}
				})
				emit('ports', mapped)
				return mapped
			} catch (e) {
				if (seq !== portEnumSeq || destroyed) return []
				addLog('ERR', '枚举串口失败: ' + (e && e.message ? e.message : e))
				return []
			}
		}

		function selectPort(port) {
			if (isOpen || isOpening || isClosing || closeFailed) {
				addLog('SYS', '请先断开当前串口后再切换设备')
				return false
			}
			const conflict = checkPortConflict(port)
			if (conflict) {
				addLog('ERR', '无法选择该端口：' + conflict)
				return false
			}
			const adapter = getAdapter()
			if (adapter && typeof adapter.grantPort === 'function') {
				try { adapter.grantPort(port) } catch (e) {}
			}
			currentPort = port || null
			emit('connection')
			return true
		}

		async function requestPort() {
			if (destroyed || isOpen || isOpening || isClosing || closeFailed) {
				addLog('SYS', '请先断开当前串口后再授权或切换设备')
				return null
			}
			const adapter = getAdapter()
			if (!adapter || !adapter.isSupported || !adapter.isSupported()) {
				addLog('ERR', '当前环境不支持串口访问')
				return null
			}
			const reqGen = connGen
			try {
				const port = await adapter.requestPort()
				if (!port || destroyed || isOpen || isOpening || isClosing || closeFailed || connGen !== reqGen) {
					return null
				}
				const conflict = checkPortConflict(port)
				if (conflict) {
					addLog('ERR', '所选端口冲突：' + conflict)
					await dialogAlert('所选端口已被占用（' + conflict + '），请先释放或改选其它端口。', '端口冲突')
					return null
				}
				if (!selectPort(port)) return null
				await refreshPorts()
				return port
			} catch (e) {
				if (e && e.name === 'NotFoundError') return null
				addLog('ERR', '授权串口失败: ' + (e && e.message ? e.message : e))
				return null
			}
		}

		// ---- 串口打开 / 关闭 / 读循环 ----
		function resetCalibVerify(keepStatus) {
			clearTimer('calibVerifyWriteAck')
			clearTimer('calibVerifyDelay')
			clearTimer('calibVerifyTimeout')
			state.calibVerify.connGen = -1
			state.calibVerify.writeSeq = null
			state.calibVerify.readSeq = null
			state.calibVerify.waitingWriteAck = false
			state.calibVerify.waitingDelay = false
			state.calibVerify.waitingReadback = false
			state.calibVerify.pendingExpected = null
			if (!keepStatus) {
				state.calibVerify.lastStatus = ''
				state.calibVerify.lastTone = ''
			}
		}

		function abortActiveTasks(reason) {
			if (state.flow.monitorRunning) {
				stopFlowMonitor(true)
			}
			if (state.ota.running) {
				abortOta(reason || '连接已断开')
			}
			if (state.saveAll.running || activeSaveRun) {
				cancelSaveAll(reason || '连接已断开')
			}
			if (state.freeze.autoReading) {
				clearTimer('freezeTimeout')
				state.freeze.autoReading = false
				emit('freeze')
			}
			if (state.calibVerify.waitingWriteAck || state.calibVerify.waitingDelay || state.calibVerify.waitingReadback) {
				resetCalibVerify(true)
				emit('calib')
			}
		}

		async function openPort(opts) {
			opts = opts || {}
			const target = opts.port || currentPort
			if (!target) {
				addLog('ERR', '请先选择串口设备')
				return { ok: false, error: '未选择串口' }
			}
			if (isOpen || isOpening || isClosing || closeFailed) {
				return { ok: false, error: closeFailed ? '上次关闭串口失败，请先重试断开释放端口' : '串口正在打开或已连接' }
			}
			const conflict = checkPortConflict(target)
			if (conflict) {
				addLog('ERR', '打开被阻止：' + conflict)
				await dialogAlert('该端口当前不可用：' + conflict + '。请先在对应视图关闭后再连接。', '端口占用')
				return { ok: false, error: conflict }
			}
			currentPort = target
			openingPort = target
			const adapter = getAdapter()
			if (adapter && typeof adapter.grantPort === 'function') {
				try { adapter.grantPort(target) } catch (e) {}
			}
			invalidateBaseParamsSnapshot()
			resetSessionDeviceIdentity()
			sentDevInfoSeqs.clear()
			pendingBaseParamReadSeqs.clear()
			isOpening = true
			closeFailed = false
			manualClose = false
			const gen = ++connGen
			const opId = ++openOpSeq
			notifyStatusBadge()
			const doOpen = (async function () {
				try {
					const proto = getProto()
					streamParser = proto && typeof proto.createStreamParser === 'function'
						? proto.createStreamParser()
						: null
					const openOpts = {
						baudRate: Number(opts.baudRate || state.baudRate) || 9600,
						dataBits: 8,
						stopBits: 1,
						parity: opts.parity || state.parity || 'none',
						bufferSize: 65536,
					}
					await target.open(openOpts)
					if (gen !== connGen || manualClose || opId !== openOpSeq) {
						let closeErr = null
						if (target.readable || target.writable) {
							try {
								await target.close()
							} catch (ce) {
								closeErr = ce
							}
						}
						if (opId === openOpSeq) {
							isOpening = false
							openingPort = null
							isOpen = false
							if (closeErr) {
								closeFailed = true
								heldPort = target
								currentPort = target
								addLog('ERR', '取消连接后关闭串口失败: ' + (closeErr && closeErr.message ? closeErr.message : closeErr))
							} else {
								closeFailed = false
								heldPort = null
							}
							notifyStatusBadge()
						}
						return { ok: false, error: closeErr ? ('取消后关闭失败: ' + (closeErr.message || closeErr)) : '连接已取消' }
					}
					isOpening = false
					openingPort = null
					closeFailed = false
					heldPort = target
					isOpen = true
					addLog('SYS', '已连接 ' + describePort(target) + (isWirelessPort(target) ? '' : (' · ' + openOpts.baudRate + ' 8' + openOpts.parity[0].toUpperCase() + '1')))
					notifyStatusBadge()
					startReadLoop(target, gen)
					return { ok: true }
				} catch (e) {
					if (opId === openOpSeq) {
						isOpening = false
						openingPort = null
						heldPort = null
						isOpen = false
						closeFailed = false
						addLog('ERR', '打开串口失败: ' + (e && e.message ? e.message : e))
						notifyStatusBadge()
					}
					return { ok: false, error: e && e.message ? e.message : String(e) }
				} finally {
					if (openPromise === doOpen) {
						openPromise = null
					}
				}
			})()
			openPromise = doOpen
			return doOpen
		}

		async function closePort(opts) {
			opts = opts || {}
			const isManual = opts.manual !== false
			if (isOpening && openingPort) {
				const target = openingPort
				const pending = openPromise
				manualClose = isManual
				connGen++
				sentDevInfoSeqs.clear()
				pendingBaseParamReadSeqs.clear()
				if (typeof target.abortOpen === 'function') {
					try { await target.abortOpen() } catch (e) {}
				}
				if (pending) {
					try { await pending } catch (e) {}
				}
				if (!closeFailed && target && (target.readable || target.writable)) {
					try {
						await target.close()
					} catch (ce) {
						closeFailed = true
						heldPort = target
						currentPort = target
						isOpen = false
						const msg = ce && ce.message ? ce.message : String(ce)
						addLog('ERR', '取消连接后关闭串口失败: ' + msg)
						notifyStatusBadge()
						return { ok: false, error: msg }
					}
				}
				if (closeFailed) {
					notifyStatusBadge()
					return { ok: false, error: '关闭串口失败，端口仍被占用' }
				}
				heldPort = null
				invalidateBaseParamsSnapshot()
				resetSessionDeviceIdentity()
				addLog('SYS', '已取消正在进行的连接')
				notifyStatusBadge()
				return { ok: true }
			}
			if (!isOpen && !isClosing && !closeFailed) return { ok: true }
			if (isClosing) return { ok: false, error: '正在关闭中' }

			manualClose = isManual
			connGen++
			sentDevInfoSeqs.clear()
			pendingBaseParamReadSeqs.clear()
			abortActiveTasks(isManual ? '用户断开串口' : '串口异常断开')
			invalidateBaseParamsSnapshot()
			resetSessionDeviceIdentity()
			isOpen = false
			closeFailed = false
			isClosing = true
			notifyStatusBadge()

			const port = heldPort || currentPort
			const r = activeReader
			activeReader = null
			if (r) {
				try { await r.cancel() } catch (e) {}
				try { r.releaseLock() } catch (e) {}
			}
			try { await writeChain } catch (e) {}
			let closeErr = null
			if (port && (port.readable || port.writable)) {
				try {
					await port.close()
				} catch (e) {
					closeErr = e
				}
			}
			isClosing = false
			if (closeErr) {
				closeFailed = true
				heldPort = port
				isOpen = false
				const msg = closeErr && closeErr.message ? closeErr.message : String(closeErr)
				addLog('ERR', '关闭串口失败（端口仍被占用，请重试断开）: ' + msg)
				notifyStatusBadge()
				return { ok: false, error: msg }
			}
			heldPort = null
			if (streamParser && typeof streamParser.reset === 'function') {
				try { streamParser.reset() } catch (e) {}
			}
			addLog('SYS', isManual ? '串口已断开' : '设备连接已丢失')
			notifyStatusBadge()
			return { ok: true }
		}

		async function startReadLoop(port, gen) {
			const alive = function () { return isOpen && (heldPort || currentPort) === port && connGen === gen }
			let prevStream = null
			let recoverCount = 0
			let recoverWindowTs = 0

			while (alive()) {
				if (port.readable && port.readable === prevStream) {
					const t0 = nowMs()
					while (alive() && port.readable === prevStream && (nowMs() - t0) < STREAM_SWAP_WAIT_MS) {
						await new Promise(function (resolve) { schedTimeout(resolve, 40) })
					}
					if (!alive()) return
				}
				const stream = port.readable
				if (!stream || stream === prevStream) {
					// 设备丢失后两条流均为 null，或无法获取新流
					break
				}
				prevStream = stream
				let reader = null
				try {
					reader = stream.getReader()
				} catch (e) {
					addLog('ERR', '获取接收流读取器失败: ' + (e && e.message ? e.message : e))
					break
				}
				activeReader = reader
				let readErr = null
				try {
					while (true) {
						const res = await reader.read()
						if (res.done) break
						if (!res.value || !res.value.length) continue
						if (!alive()) break
						handleIncomingChunk(res.value)
					}
				} catch (e) {
					readErr = e
				} finally {
					if (activeReader === reader) activeReader = null
					try { reader.releaseLock() } catch (e) {}
				}
				if (!alive()) return
				if (!port.readable) {
					// 设备已丢失（streams 为 null）
					break
				}
				const tNow = nowMs()
				if (tNow - recoverWindowTs > READ_RECOVER_WINDOW_MS) {
					recoverCount = 0
					recoverWindowTs = tNow
				}
				if (++recoverCount > READ_RECOVER_MAX) {
					addLog('ERR', '接收流短时间连续出错过多，停止接收')
					break
				}
				addLog('SYS', '串口读错误，等待重建接收流: ' + (readErr && readErr.message ? readErr.message : '流结束'))
			}

			if (alive()) {
				if (!port.readable && !port.writable) {
					// 意外断流/设备丢失：流均为 null 时不调 port.close()
					abortActiveTasks('接收流中断')
					invalidateBaseParamsSnapshot()
					resetSessionDeviceIdentity()
					sentDevInfoSeqs.clear()
					pendingBaseParamReadSeqs.clear()
					heldPort = null
					isOpen = false
					closeFailed = false
					connGen++
					addLog('ERR', '串口接收中断（设备可能已拔出）')
					notifyStatusBadge()
				} else {
					// 流仍然存在（如 getReader 报错或连续恢复超限）：必须调 closePort 释放底层句柄
					addLog('ERR', '接收流异常终止，正在关闭串口释放句柄')
					await closePort({ manual: false })
				}
			}
		}

		function bindAdapterEvents() {
			const adapter = getAdapter()
			if (!adapter || adapterBound || typeof adapter.addEventListener !== 'function') return
			adapterBound = true
			onAdapterDisconnect = function (ev) {
				if (destroyed) return
				if (ev && ev.port && (ev.port === heldPort || ev.port === openingPort || ev.port === currentPort) && (isOpen || isOpening || closeFailed)) {
					closePort({ manual: false })
				}
				refreshPorts()
			}
			onAdapterChange = function () {
				if (destroyed) return
				refreshPorts()
			}
			adapter.addEventListener('disconnect', onAdapterDisconnect)
			adapter.addEventListener('change', onAdapterChange)
		}

		function unbindAdapterEvents() {
			const adapter = getAdapter()
			if (adapter && typeof adapter.removeEventListener === 'function') {
				if (onAdapterDisconnect) {
					try { adapter.removeEventListener('disconnect', onAdapterDisconnect) } catch (e) {}
				}
				if (onAdapterChange) {
					try { adapter.removeEventListener('change', onAdapterChange) } catch (e) {}
				}
			}
			onAdapterDisconnect = null
			onAdapterChange = null
			adapterBound = false
		}

		function writeBytes(bytes, label, writeOpts) {
			const port = heldPort || currentPort
			if (!isOpen || !port || !port.writable) {
				addLog('ERR', '串口未连接，无法发送' + (label ? (' ' + label) : ''))
				return Promise.resolve({ ok: false, error: '串口未连接' })
			}
			const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
			const gen = connGen
			const hex = bytesToHexUpper(u8, false)
			const run = writeChain.then(async function () {
				if (!isOpen || (heldPort || currentPort) !== port || connGen !== gen || !port.writable) {
					return { ok: false, error: '串口已断开' }
				}
				if (writeOpts && typeof writeOpts.beforeWrite === 'function' && writeOpts.beforeWrite() === false) {
					return { ok: false, skipped: true, error: '发送前已过期或取消' }
				}
				if (writeOpts && typeof writeOpts.onWriteStart === 'function') {
					try { writeOpts.onWriteStart() } catch (e) {}
				}
				let writer = null
				try {
					writer = port.writable.getWriter()
					await writer.write(u8)
					addLog('TX', (label || '发送') + ' (' + u8.length + 'B)', bytesToHexUpper(u8, true))
					return { ok: true, frame: u8, hex: hex }
				} catch (e) {
					const msg = e && e.message ? e.message : String(e)
					addLog('ERR', '发送失败(' + (label || '') + '): ' + msg)
					return { ok: false, error: msg }
				} finally {
					if (writer) {
						try { writer.releaseLock() } catch (e) {}
					}
				}
			})
			writeChain = run.then(function () {}, function () {})
			return run
		}

		function buildOpts(extra) {
			return Object.assign({
				seq: nextSeq(),
				passthrough: state.passthrough,
				iotSeq: nextIotSeq(),
				now: nowDate(),
			}, extra || {})
		}

		// ---- 数据包接收与分发 ----
		function handleIncomingChunk(chunk) {
			const proto = getProto()
			if (!proto) return
			if (!streamParser && typeof proto.createStreamParser === 'function') {
				streamParser = proto.createStreamParser()
			}
			if (!streamParser) return
			let events = []
			try {
				events = streamParser.push(chunk) || []
			} catch (e) {
				addLog('ERR', '帧流解析异常: ' + (e && e.message ? e.message : e))
				return
			}
			for (let i = 0; i < events.length; i++) {
				const ev = events[i]
				if (!ev) continue
				if (ev.kind === 'ac6d' && ev.parsed) {
					handleAc6dEvent(ev)
				} else if (ev.kind === 'a99a-info' && ev.moduleInfo) {
					handleA99aInfoEvent(ev)
				}
			}
		}

		function handleAc6dEvent(ev) {
			const proto = getProto()
			const CMD = proto.CMD
			const STATUS = proto.STATUS
			const p = ev.parsed
			const rawHex = bytesToHexUpper(ev.rawFrame || new Uint8Array(0), false)
			const rawHexSpaced = bytesToHexUpper(ev.rawFrame || new Uint8Array(0), true)
			const statusLabel = p.statusText || (proto.STATUS_TEXT && proto.STATUS_TEXT[p.typeOrStatus]) || ('0x' + (p.typeOrStatus & 0xff).toString(16).toUpperCase().padStart(2, '0'))
			const cmdLabel = p.cmdName || (proto.CMD_INFO && proto.CMD_INFO[p.cmd] && proto.CMD_INFO[p.cmd].label) || ('0x' + (p.cmd & 0xff).toString(16).toUpperCase().padStart(2, '0'))
			addLog('RX', (ev.unwrappedFromIot ? '[透传] ' : '') + cmdLabel + ' · ' + statusLabel, rawHexSpaced)

			// 忽略半双工总线回显的请求帧（dir === 'req'），避免误触发 OTA / 校表 / 冻结失败
			if (p.dir === 'req') return

			const ok = p.typeOrStatus === STATUS.OK
			const d = p.detail || {}

			// 保存全部数据期间抓取 RX HEX
			if (state.saveAll.running && ok) {
				captureSaveAllAc6d(p, d, rawHex)
			}

			if (p.cmd === CMD.DEV_INFO && ok) {
				applyDevInfo(d)
			} else if (p.cmd === CMD.FLOW_FAST && ok) {
				applyFlowFast(d)
			} else if (p.cmd === CMD.FLOW_QUERY && ok) {
				applyFlowQuery(d)
			} else if (p.cmd === CMD.CALIB_READ && ok) {
				applyCalibRead(d, p.seq)
			} else if (p.cmd === CMD.CALIB_WRITE) {
				handleCalibWriteAck(p.typeOrStatus, statusLabel, p.seq)
			} else if (p.cmd === CMD.PARAM_READ && ok) {
				applyParamRead(d, p.seq)
			} else if (p.cmd === CMD.PARAM_WRITE) {
				addLog(ok ? 'SYS' : 'ERR', ok ? '基础参数写入成功 (0x43)' : ('基础参数写入失败: ' + statusLabel))
			} else if (p.cmd === CMD.DAILY_FREEZE) {
				handleDailyFreezeAck(ok, d, statusLabel)
			} else if (p.cmd === CMD.LOG_READ && ok) {
				applyLogRead(d)
			} else if (p.cmd === CMD.MODE_SET) {
				const curMode = d.mode != null ? d.mode : (p.data && p.data.length ? p.data[0] : null)
				if (curMode != null) {
					state.device.mode = curMode
					state.device.modeText = MODE_NAMES[curMode] || ('未知(' + curMode + ')')
					emit('device')
				}
				addLog(ok ? 'SYS' : 'ERR', '模式切换响应: ' + statusLabel + (curMode != null ? (' -> ' + state.device.modeText) : ''))
			} else if (p.cmd === CMD.BASE_DEGREE) {
				clearTimer('baseDegreeTimeout')
				state.params.baseDegreeStatus = ok ? '底度设置成功' : ('底度设置失败: ' + statusLabel)
				state.params.baseDegreeTone = ok ? 'ok' : 'danger'
				emit('params')
			} else if (p.cmd === CMD.TIME_SYNC) {
				addLog(ok ? 'SYS' : 'ERR', ok ? ('RTC 对时成功' + (d.deviceTime ? (': ' + d.deviceTime) : '')) : ('RTC 对时失败: ' + statusLabel))
			} else if (p.cmd === CMD.ALARM_CLEAR) {
				addLog(ok ? 'SYS' : 'ERR', ok ? '报警标志清除成功' : ('清除报警失败: ' + statusLabel))
			} else if (p.cmd === CMD.AUTH_BYPASS) {
				const bypassVal = d.bypassVal != null ? d.bypassVal : (d.value != null ? d.value : null)
				addLog(ok ? 'SYS' : 'ERR', ok ? ('旁路令牌响应成功' + (bypassVal != null ? (': ' + hex32(bypassVal)) : '')) : ('旁路令牌失败: ' + statusLabel))
			} else if (p.cmd === CMD.RESET) {
				addLog(ok ? 'SYS' : 'ERR', ok ? '系统复位指令已确认，设备即将重启' : ('系统复位失败: ' + statusLabel))
			} else if (p.cmd === CMD.PARAM_RESET) {
				addLog(ok ? 'SYS' : 'ERR', ok ? '恢复参数/出厂设置成功' : ('恢复设置失败: ' + statusLabel))
			} else if (p.cmd === CMD.HANDSHAKE && ok) {
				if (d.firmwareVersion) {
					state.device.firmwareVersion = d.firmwareVersion
					emit('device')
				}
				addLog('SYS', '握手成功，固件版本: ' + (d.firmwareVersion || '--'))
			} else if (p.cmd === CMD.OTA_CRC && ok) {
				if (d.crcAmbiguous) {
					addLog('SYS', '设备返回 CRC16 候选: ' + hex16(d.crcValueA) + '(格式A) / ' + hex16(d.crcValueB) + '(格式B，缺请求地址上下文)')
				} else {
					addLog('SYS', '设备返回 CRC16: ' + hex16(d.crcValue))
				}
			} else if (p.cmd === CMD.INIT_REPORT && ok) {
				if (d.firmwareVersion) {
					state.device.firmwareVersion = d.firmwareVersion
					emit('device')
				}
				addLog('SYS', '收到设备上电初始化上报 (0x3F)')
			}

			// 推进 OTA 自动状态机
			if (state.ota.running) {
				handleOtaResponse(p.cmd, p.typeOrStatus, d, statusLabel, p.seq)
			}
		}

		function handleA99aInfoEvent(ev) {
			const rawHex = bytesToHexUpper(ev.rawFrame || new Uint8Array(0), false)
			const rawHexSpaced = bytesToHexUpper(ev.rawFrame || new Uint8Array(0), true)
			const info = ev.moduleInfo || {}
			const basic = info.basic || {}
			addLog('RX', 'A99A 模组信息 · IMEI=' + (basic.imei || '--') + ' ICCID=' + (basic.iccid || '--'), rawHexSpaced)
			const run = activeSaveRun
			if (
				run &&
				state.saveAll.running &&
				run.step === 3 &&
				!run.stepDone &&
				connGen === run.connGen &&
				info.func === 0x83 &&
				info.seq === run.expectedIotSeq
			) {
				if (!run.serialIo.module) run.serialIo.module = {}
				run.serialIo.module.rx = rawHex
				run.moduleInfo = info
				state.saveAll.serialIo = run.serialIo
				state.saveAll.moduleInfo = info
				advanceSaveAllStep(run)
			}
			emit('module-info', info)
		}

		// ---- 设备信息 (0x33) ----
		function applyDevInfo(d) {
			updateDeviceIdentity(d.onlyAddrHex, d.onlyAddrBytes, d.authCode)
			if (d.firmwareVersion != null) state.device.firmwareVersion = String(d.firmwareVersion)
			if (d.mode != null) {
				state.device.mode = d.mode
				state.device.modeText = d.modeText || MODE_NAMES[d.mode] || ('未知(' + d.mode + ')')
			}
			if (d.temperatureC != null) state.device.temperatureC = d.temperatureC
			if (d.voltageV != null) state.device.voltageV = d.voltageV
			if (d.flags != null) state.device.flags = d.flags
			if (Array.isArray(d.alarms)) state.device.alarms = d.alarms.slice()
			if (d.sensorTime) state.device.sensorTime = d.sensorTime
			if (d.powerResetCount != null) state.device.powerResetCount = d.powerResetCount
			if (d.wdtResetCount != null) state.device.wdtResetCount = d.wdtResetCount
			if (d.totalRunTimeSec != null) state.device.totalRunTimeSec = d.totalRunTimeSec
			if (d.activeRunTimeSec != null) state.device.activeRunTimeSec = d.activeRunTimeSec
			emit('device')
		}

		// ---- 流量监控、防回退、4倍频插值与脉冲计时 ----
		function computeFlowDisplay(rawPosUl, rawRevUl, quadRemainder, pulseEqUl, isReverse) {
			const qr = Math.max(0, Math.min(3, Number(quadRemainder) || 0))
			const eq = (state.calib.meterPulseEq > 0 ? state.calib.meterPulseEq : (pulseEqUl > 0 ? pulseEqUl : 17085))
			const interpUl = Math.floor((eq * qr) / 4)
			const posInterp = numVal(rawPosUl, 0) + interpUl
			const revInterp = numVal(rawRevUl, 0) + (isReverse ? interpUl : 0)

			// 正累计防回退保护（同一设备且未手动重置时，新值 < 上次值则保持上次值）
			const uid = state.device.onlyAddrHex || ''
			if (state.flow.lastPosVolGuardUid && uid && state.flow.lastPosVolGuardUid !== uid) {
				state.flow.lastPosVolGuardUl = null
			}
			let guardedPos = posInterp
			let rollbackGuarded = false
			if (state.flow.lastPosVolGuardUl !== null && posInterp < state.flow.lastPosVolGuardUl) {
				guardedPos = state.flow.lastPosVolGuardUl
				rollbackGuarded = true
			} else {
				state.flow.lastPosVolGuardUl = posInterp
				state.flow.lastPosVolGuardUid = uid
			}

			return {
				posVolUl: guardedPos,
				revVolUl: revInterp,
				netVolUl: guardedPos - revInterp,
				interpUl: interpUl,
				rollbackGuarded: rollbackGuarded,
			}
		}

		function resetAntiRollback() {
			state.flow.lastPosVolGuardUl = null
			state.flow.rollbackGuarded = false
			emit('flow')
		}

		function pushFlowHistory(posUl, revUl, flowLph) {
			state.flow.history.push({
				ts: nowMs(),
				posM3: posUl / 1e9,
				revM3: revUl / 1e9,
				flowLph: round1(flowLph),
			})
			if (state.flow.history.length > FLOW_HISTORY_MAX) {
				state.flow.history.splice(0, state.flow.history.length - FLOW_HISTORY_MAX)
			}
		}

		function clearFlowHistory() {
			state.flow.history.length = 0
			emit('flow')
		}

		function applyFlowFast(d) {
			const rawPos = numVal(d.posVolumeUl, 0)
			const rawRev = numVal(d.revVolumeUl, 0)
			const qr = numVal(d.quadRemainder, 0)
			const flowM3h = numVal(d.flowRateM3h, 0)
			const flowLph = d.flowRateLph != null ? round1(d.flowRateLph) : round1(flowM3h * 1000)
			const disp = computeFlowDisplay(rawPos, rawRev, qr, state.flow.pulseEqUl, !!d.isReverse)

			state.flow.rawPosVolUl = rawPos
			state.flow.rawRevVolUl = rawRev
			state.flow.displayPosVolUl = disp.posVolUl
			state.flow.displayRevVolUl = disp.revVolUl
			state.flow.displayNetVolUl = disp.netVolUl
			state.flow.rollbackGuarded = disp.rollbackGuarded
			state.flow.flowRateM3h = round4(flowM3h)
			state.flow.flowRateLph = flowLph
			state.flow.isFlowing = !!d.isFlowing
			state.flow.isReverse = !!d.isReverse
			state.flow.quadRemainder = qr
			state.flow.mode = d.mode
			state.flow.modeText = d.modeText || MODE_NAMES[d.mode] || '--'
			state.flow.flags = numVal(d.flags, 0)
			state.flow.alarms = Array.isArray(d.alarms) ? d.alarms.slice() : []
			if (d.mode != null) {
				state.device.mode = d.mode
				state.device.modeText = state.flow.modeText
				emit('device')
			}
			pushFlowHistory(disp.posVolUl, disp.revVolUl, flowLph)
			onPulseTimingData(!!d.isFlowing, null, null)
			emit('flow')
		}

		function applyFlowQuery(d) {
			const posPulse = numVal(d.posPulse, 0)
			const revPulse = numVal(d.revPulse, 0)
			const rawPos = numVal(d.posVolumeUl, 0)
			const rawRev = numVal(d.revVolumeUl, 0)
			const qr = numVal(d.quadRemainder, 0)
			const pulseEq = numVal(d.pulseEqUl, state.flow.pulseEqUl)
			const flowM3h = numVal(d.flowRateM3h, 0)
			const flowLph = d.flowRateLph != null ? round1(d.flowRateLph) : round1(flowM3h * 1000)
			const disp = computeFlowDisplay(rawPos, rawRev, qr, pulseEq, !!d.isReverse)

			state.flow.posPulse = posPulse
			state.flow.revPulse = revPulse
			state.flow.netPulse = posPulse - revPulse
			state.flow.rawPosVolUl = rawPos
			state.flow.rawRevVolUl = rawRev
			state.flow.displayPosVolUl = disp.posVolUl
			state.flow.displayRevVolUl = disp.revVolUl
			state.flow.displayNetVolUl = disp.netVolUl
			state.flow.rollbackGuarded = disp.rollbackGuarded
			state.flow.flowRateM3h = round4(flowM3h)
			state.flow.flowRateLph = flowLph
			state.flow.pulseIntervalMs = numVal(d.pulseIntervalMs, 0)
			state.flow.isFlowing = !!d.isFlowing
			state.flow.isReverse = !!d.isReverse
			state.flow.quadRemainder = qr
			state.flow.mode = d.mode
			state.flow.modeText = d.modeText || MODE_NAMES[d.mode] || '--'
			state.flow.temperatureC = d.temperatureC != null ? d.temperatureC : state.flow.temperatureC
			state.flow.voltageV = d.voltageV != null ? d.voltageV : state.flow.voltageV
			state.flow.pulseEqUl = pulseEq
			state.flow.flags = numVal(d.flags, 0)
			state.flow.alarms = Array.isArray(d.alarms) ? d.alarms.slice() : []
			state.flow.deviceTime = d.deviceTime || '--'
			if (d.mode != null) {
				state.device.mode = d.mode
				state.device.modeText = state.flow.modeText
				emit('device')
			}
			pushFlowHistory(disp.posVolUl, disp.revVolUl, flowLph)
			onPulseTimingData(!!d.isFlowing, posPulse, revPulse)
			emit('flow')
		}

		function getLcdReadout() {
			const f = state.flow
			const m = f.lcdMode
			if (m === 'pos_m3') return { value: (f.displayPosVolUl / 1e9).toFixed(5), unit: 'm³' }
			if (m === 'rev_m3') return { value: (f.displayRevVolUl / 1e9).toFixed(5), unit: 'm³' }
			if (m === 'flow_m3h') return { value: f.flowRateM3h.toFixed(4), unit: 'm³/h' }
			if (m === 'pos_pulse') return { value: String(f.posPulse), unit: '脉冲' }
			if (m === 'rev_pulse') return { value: String(f.revPulse), unit: '脉冲' }
			return { value: (f.displayNetVolUl / 1e9).toFixed(5), unit: 'm³' }
		}

		// ---- 脉冲时间测量 ----
		function pulseTimingManualStart() {
			const pt = state.pulseTiming
			pt.t0Ms = nowMs()
			pt.t1Ms = null
			pt.direction = null
			pt.pulseCount = 0
			pt.prevPosPulse = null
			pt.prevRevPulse = null
			pt.active = true
			pt.auto = false
			addLog('SYS', '[脉冲计时] 手动起始 T0=' + (pt.t0Ms / 1000).toFixed(3))
			emit('pulse-timing')
		}

		function pulseTimingAutoStart() {
			const pt = state.pulseTiming
			pt.t0Ms = null
			pt.t1Ms = null
			pt.direction = null
			pt.pulseCount = 0
			pt.prevPosPulse = null
			pt.prevRevPulse = null
			pt.active = true
			pt.auto = true
			addLog('SYS', '[脉冲计时] 自动起始，等待脉冲跳变...')
			emit('pulse-timing')
		}

		function pulseTimingStop() {
			const pt = state.pulseTiming
			if (pt.active && pt.t0Ms != null && pt.t1Ms == null) {
				pt.t1Ms = nowMs()
			}
			pt.active = false
			pt.auto = false
			emit('pulse-timing')
		}

		function pulseTimingClear() {
			const pt = state.pulseTiming
			pt.active = false
			pt.auto = false
			pt.t0Ms = null
			pt.t1Ms = null
			pt.direction = null
			pt.pulseCount = 0
			pt.prevPosPulse = null
			pt.prevRevPulse = null
			emit('pulse-timing')
		}

		function onPulseTimingData(_isFlowing, posPulse, revPulse) {
			const pt = state.pulseTiming
			if (!pt.active) return
			const t = nowMs()
			if (pt.auto && pt.t0Ms == null) {
				if (posPulse != null && pt.prevPosPulse != null && posPulse > pt.prevPosPulse) {
					pt.t0Ms = t
					pt.t1Ms = t
					pt.direction = 'pos'
					pt.pulseCount = posPulse - pt.prevPosPulse
					addLog('SYS', '[脉冲计时] 检测到正向跳变 T0=' + (t / 1000).toFixed(3))
				} else if (revPulse != null && pt.prevRevPulse != null && revPulse > pt.prevRevPulse) {
					pt.t0Ms = t
					pt.t1Ms = t
					pt.direction = 'rev'
					pt.pulseCount = revPulse - pt.prevRevPulse
					addLog('SYS', '[脉冲计时] 检测到反向跳变 T0=' + (t / 1000).toFixed(3))
				}
			} else if (pt.t0Ms != null) {
				if (pt.direction === 'pos' && posPulse != null && pt.prevPosPulse != null && posPulse > pt.prevPosPulse) {
					pt.pulseCount += (posPulse - pt.prevPosPulse)
					pt.t1Ms = t
				} else if (pt.direction === 'rev' && revPulse != null && pt.prevRevPulse != null && revPulse > pt.prevRevPulse) {
					pt.pulseCount += (revPulse - pt.prevRevPulse)
					pt.t1Ms = t
				} else if (pt.direction == null) {
					if (posPulse != null && pt.prevPosPulse != null && posPulse > pt.prevPosPulse) {
						pt.direction = 'pos'
						pt.pulseCount = posPulse - pt.prevPosPulse
						pt.t1Ms = t
					} else if (revPulse != null && pt.prevRevPulse != null && revPulse > pt.prevRevPulse) {
						pt.direction = 'rev'
						pt.pulseCount = revPulse - pt.prevRevPulse
						pt.t1Ms = t
					}
				}
			}
			if (posPulse != null) pt.prevPosPulse = posPulse
			if (revPulse != null) pt.prevRevPulse = revPulse
			emit('pulse-timing')
		}

		function getPulseTimingSnapshot() {
			const pt = state.pulseTiming
			let deltaSec = null
			if (pt.t0Ms != null) {
				const endMs = pt.active ? nowMs() : (pt.t1Ms != null ? pt.t1Ms : pt.t0Ms)
				deltaSec = Math.max(0, (endMs - pt.t0Ms) / 1000)
			}
			return {
				active: pt.active,
				auto: pt.auto,
				t0Text: pt.t0Ms != null ? (pt.t0Ms / 1000).toFixed(3) : (pt.auto && pt.active ? '等待跳变' : '--'),
				t1Text: pt.t1Ms != null ? (pt.t1Ms / 1000).toFixed(3) : '--',
				deltaSec: deltaSec,
				deltaText: deltaSec != null ? deltaSec.toFixed(3) : '--',
				pulseCount: pt.pulseCount,
				direction: pt.direction,
				directionText: pt.direction === 'pos' ? '正向' : (pt.direction === 'rev' ? '反向' : '--'),
			}
		}

		// ---- 流量轮询 ----
		function sendFlowOnce(cmdOverride) {
			const proto = getProto()
			const cmd = cmdOverride || state.flow.pollCmd
			if (cmd === '0x30') {
				const frame = proto.builders.flowFast(buildOpts())
				return writeBytes(frame, '0x30 快速流量查询')
			}
			const frame = proto.builders.flowQuery(state.withTimeSync, buildOpts())
			return writeBytes(frame, '0x31 完整流量查询')
		}

		function startFlowMonitor(intervalSec, pollCmd) {
			if (!isOpen) {
				addLog('ERR', '请先连接串口再启动流量监控')
				return false
			}
			if (intervalSec != null) {
				state.flow.pollIntervalSec = Math.max(1, Math.min(3600, Math.round(Number(intervalSec) || 1)))
			}
			if (pollCmd) state.flow.pollCmd = pollCmd
			clearTimer('flowPoll')
			state.flow.monitorRunning = true
			sendFlowOnce()
			timers.flowPoll = schedInterval(function () {
				if (!isOpen || !state.flow.monitorRunning) {
					stopFlowMonitor(true)
					return
				}
				sendFlowOnce()
			}, state.flow.pollIntervalSec * 1000)
			addLog('SYS', '流量监控已启动（间隔 ' + state.flow.pollIntervalSec + 's，指令 ' + state.flow.pollCmd + '）')
			emit('flow')
			notifyStatusBadge()
			return true
		}

		function stopFlowMonitor(silent) {
			clearTimer('flowPoll')
			const wasRunning = state.flow.monitorRunning
			state.flow.monitorRunning = false
			if (wasRunning && !silent) addLog('SYS', '流量监控已停止')
			emit('flow')
			notifyStatusBadge()
		}

		// ---- S 曲线校准 (0x40 / 0x41) + 写入后 3s 自动回读比对 ----
		function applyCalibRead(d, seq) {
			const c = state.calib
			if (d.meterPulseEq != null) c.meterPulseEq = numVal(d.meterPulseEq, c.meterPulseEq)
			if (d.calibPulseEq != null) c.calibPulseEq = numVal(d.calibPulseEq, c.calibPulseEq)
			if (d.commPulseEq != null) c.commPulseEq = numVal(d.commPulseEq, c.commPulseEq)
			if (d.fwdCount != null) c.fwdCount = Math.max(0, Math.min(20, numVal(d.fwdCount, 20)))
			if (d.revCount != null) c.revCount = Math.max(0, Math.min(20, numVal(d.revCount, 20)))
			for (let i = 0; i < 20; i++) {
				if (Array.isArray(d.fwdPoints) && d.fwdPoints[i] != null) c.fwdPoints[i] = numVal(d.fwdPoints[i], 0)
				if (Array.isArray(d.fwdCoeffs) && d.fwdCoeffs[i] != null) c.fwdCoeffs[i] = numVal(d.fwdCoeffs[i], 10000)
				if (Array.isArray(d.revPoints) && d.revPoints[i] != null) c.revPoints[i] = numVal(d.revPoints[i], 0)
				if (Array.isArray(d.revCoeffs) && d.revCoeffs[i] != null) c.revCoeffs[i] = numVal(d.revCoeffs[i], 10000)
				c.fwdErrors[i] = 0
				c.fwdNewCoeffs[i] = null
				c.revErrors[i] = 0
				c.revNewCoeffs[i] = null
			}
			// 同步三锚点当前系数并清空旧误差与新系数，防跨表串扰
			syncAnchorCoeffsFromCalib()
			addLog('SYS', '已更新 20 点正反向校准表，三锚点当前系数已同步并清空旧误差')

			// 检查是否正处于 0x41 写入后的回读校验流程（须匹配 connGen 与 readSeq，且直接比对原始 raw176）
			const cv = state.calibVerify
			if (cv.waitingReadback && cv.pendingExpected && cv.connGen === connGen && seq === cv.readSeq) {
				const expectedBytes = cv.pendingExpected
				resetCalibVerify(true)
				const raw176 = (d.raw176 instanceof Uint8Array && d.raw176.length === 176) ? d.raw176 : null
				const matched = !!(raw176 && bytesEqual(expectedBytes, raw176))
				cv.lastStatus = matched ? '写入回读字节比对一致 ✓' : '回读验证不一致 ✗'
				cv.lastTone = matched ? 'ok' : 'danger'
				addLog(matched ? 'SYS' : 'ERR', matched ? '0x41 校准写入验证通过：176B 原始字节完全一致' : '0x41 校准写入验证失败：原始 176B 回读字节不一致')
				emit('calib-verify', { ok: matched })
				dialogAlert(matched ? '写入全部校准系数成功，回读 176 字节完全一致！' : '回读校验失败：设备返回的校准表与写入数据不一致，请检查后重试。', matched ? '校准验证通过' : '校准验证失败')
			}
			emit('calib')
			emit('anchor')
		}

		function handleCalibWriteAck(status, statusLabel, seq) {
			const proto = getProto()
			const cv = state.calibVerify
			const isVerifyMatch = cv.waitingWriteAck && cv.connGen === connGen && seq === cv.writeSeq && !!cv.pendingExpected
			if (!isVerifyMatch) {
				addLog(status === proto.STATUS.OK ? 'SYS' : 'ERR', status === proto.STATUS.OK ? '0x41 校准写入确认成功' : ('0x41 校准写入失败: ' + statusLabel))
				return
			}
			clearTimer('calibVerifyWriteAck')
			cv.waitingWriteAck = false
			if (status === proto.STATUS.OK) {
				cv.lastStatus = '0x41 写入成功，3秒后自动回读校验...'
				cv.lastTone = 'info'
				addLog('SYS', '0x41 校准写入确认成功')
				const expectedGen = cv.connGen
				const expectedWriteSeq = cv.writeSeq
				cv.waitingDelay = true
				clearTimer('calibVerifyDelay')
				timers.calibVerifyDelay = schedTimeout(function () {
					timers.calibVerifyDelay = null
					if (!isOpen || !cv.pendingExpected || cv.connGen !== connGen || cv.connGen !== expectedGen || cv.writeSeq !== expectedWriteSeq) return
					cv.waitingDelay = false
					const readSeq = nextSeq()
					cv.readSeq = readSeq
					cv.waitingReadback = true
					cv.lastStatus = '正在回读 0x40 校验...'
					addLog('SYS', '开始 0x40 自动回读比对写入校准表...')
					emit('calib')
					sendCalibRead(readSeq).then(function (res) {
						if (!res.ok && cv.waitingReadback && cv.readSeq === readSeq) {
							resetCalibVerify(true)
							cv.lastStatus = '0x40 回读请求发送失败'
							cv.lastTone = 'danger'
							emit('calib')
						}
					})
					clearTimer('calibVerifyTimeout')
					timers.calibVerifyTimeout = schedTimeout(function () {
						timers.calibVerifyTimeout = null
						if (!cv.waitingReadback || cv.connGen !== connGen || cv.readSeq !== readSeq) return
						resetCalibVerify(true)
						cv.lastStatus = '回读验证超时'
						cv.lastTone = 'danger'
						addLog('ERR', '校准写入回读验证超时（5s 未收到 0x40 应答）')
						emit('calib-verify', { ok: false, timeout: true })
						emit('calib')
						dialogAlert('校准表回读验证超时，请手动点击「0x40 读取校准表」确认。', '验证超时')
					}, otaDelay(timings.calibVerifyTimeoutMs))
				}, timings.calibVerifyDelayMs)
			} else {
				resetCalibVerify(true)
				cv.lastStatus = '0x41 写入失败: ' + statusLabel
				cv.lastTone = 'danger'
				addLog('ERR', '0x41 校准写入失败: ' + statusLabel)
			}
			emit('calib')
		}

		function calcAllNewCoeffs() {
			const proto = getProto()
			const c = state.calib
			for (let i = 0; i < 20; i++) {
				c.fwdNewCoeffs[i] = proto.calcNewCoeff(c.fwdCoeffs[i], c.fwdErrors[i] || 0)
				c.revNewCoeffs[i] = proto.calcNewCoeff(c.revCoeffs[i], c.revErrors[i] || 0)
			}
			addLog('SYS', '已重新计算全部 40 点（正向20 + 反向20）新校准系数')
			emit('calib')
		}

		function sendCalibRead(seqOverride) {
			const proto = getProto()
			const extra = seqOverride != null ? { seq: seqOverride } : undefined
			return writeBytes(proto.builders.calibRead(buildOpts(extra)), '0x40 读取校准表')
		}

		function writeSingleCoeff(direction, index) {
			const proto = getProto()
			const authCode = getEffectiveAuthCode()
			if (authCode == null) {
				dialogAlert('单点写入需要认证码，请先点击「读设备 0x33」或在认证弹窗输入手动认证码。', '缺少认证码')
				return Promise.resolve({ ok: false, error: '缺少认证码' })
			}
			const c = state.calib
			const newArr = direction === 'fwd' ? c.fwdNewCoeffs : c.revNewCoeffs
			const curArr = direction === 'fwd' ? c.fwdCoeffs : c.revCoeffs
			const coeff = newArr[index] != null ? Number(newArr[index]) : Number(curArr[index])
			const frame = proto.builders.calibWriteSingle(direction, index, coeff, authCode, buildOpts())
			return writeBytes(frame, '0x41 单点写入 ' + (direction === 'fwd' ? '正向' : '反向') + '#' + (index + 1) + '=' + coeff)
		}

		function writeAllCalibCoeffs() {
			const proto = getProto()
			const authCode = getEffectiveAuthCode()
			if (authCode == null) {
				dialogAlert('写入全部校准系数需要认证码，请先点击「读设备 0x33」获取。', '缺少认证码')
				return Promise.resolve({ ok: false, error: '缺少认证码' })
			}
			const c = state.calib
			const payloadObj = {
				meterPulseEq: Number(c.meterPulseEq) || 0,
				calibPulseEq: Number(c.calibPulseEq) || 0,
				commPulseEq: Number(c.commPulseEq) || 0,
				fwdCount: Math.max(0, Math.min(20, Number(c.fwdCount) || 20)),
				revCount: Math.max(0, Math.min(20, Number(c.revCount) || 20)),
				fwdPoints: c.fwdPoints.map(function (v) { return Number(v) || 0 }),
				fwdCoeffs: c.fwdCoeffs.map(function (v, i) { return c.fwdNewCoeffs[i] != null ? Number(c.fwdNewCoeffs[i]) : (Number(v) || 10000) }),
				revPoints: c.revPoints.map(function (v) { return Number(v) || 0 }),
				revCoeffs: c.revCoeffs.map(function (v, i) { return c.revNewCoeffs[i] != null ? Number(c.revNewCoeffs[i]) : (Number(v) || 10000) }),
			}
			resetCalibVerify(false)
			const writeSeq = nextSeq()
			const writeGen = connGen
			state.calibVerify.connGen = writeGen
			state.calibVerify.writeSeq = writeSeq
			state.calibVerify.readSeq = null
			state.calibVerify.waitingWriteAck = true
			state.calibVerify.waitingDelay = false
			state.calibVerify.waitingReadback = false
			state.calibVerify.pendingExpected = encodeCalib176Bytes(payloadObj)
			state.calibVerify.lastStatus = '正在下发 0x41 全部校准系数...'
			state.calibVerify.lastTone = 'info'
			emit('calib')
			const frame = proto.builders.calibWriteAll(payloadObj, authCode, buildOpts({ seq: writeSeq }))
			const armWriteAckTimer = function () {
				clearTimer('calibVerifyWriteAck')
				timers.calibVerifyWriteAck = schedTimeout(function () {
					timers.calibVerifyWriteAck = null
					const cv = state.calibVerify
					if (!cv.waitingWriteAck || cv.connGen !== writeGen || cv.writeSeq !== writeSeq || connGen !== writeGen) return
					resetCalibVerify(true)
					cv.lastStatus = '0x41 写入应答超时（写入结果未确认）'
					cv.lastTone = 'danger'
					addLog('ERR', '0x41 校准写入应答超时，写入结果未确认')
					emit('calib-verify', { ok: false, ackTimeout: true, unconfirmed: true })
					emit('calib')
					dialogAlert('未收到水表 0x41 写入应答，写入结果未确认，请检查连接并点击「0x40 读取校准表」核实。', '写入结果未确认')
				}, otaDelay(timings.calibWriteAckMs))
			}
			armWriteAckTimer()
			return writeBytes(frame, '0x41 写入全部校准系数 (176B)', {
				beforeWrite: function () {
					return state.calibVerify.waitingWriteAck && state.calibVerify.connGen === writeGen && state.calibVerify.writeSeq === writeSeq && connGen === writeGen
				},
				onWriteStart: function () {
					if (state.calibVerify.waitingWriteAck && state.calibVerify.connGen === writeGen && state.calibVerify.writeSeq === writeSeq && connGen === writeGen) {
						armWriteAckTimer()
					}
				},
			}).then(function (res) {
				if (!res.ok && !res.skipped && state.calibVerify.writeSeq === writeSeq && state.calibVerify.connGen === writeGen) {
					resetCalibVerify(false)
					state.calibVerify.lastStatus = '0x41 下发失败'
					state.calibVerify.lastTone = 'danger'
					emit('calib')
				}
				return res
			})
		}

		function exportCalibJsonObject() {
			const c = state.calib
			return {
				meter_pulse_eq: String(c.meterPulseEq),
				calib_pulse_eq: String(c.calibPulseEq),
				comm_pulse_eq: String(c.commPulseEq),
				fwd_count: String(c.fwdCount),
				rev_count: String(c.revCount),
				fwd_points: c.fwdPoints.map(String),
				fwd_coeffs: c.fwdCoeffs.map(String),
				rev_points: c.revPoints.map(String),
				rev_coeffs: c.revCoeffs.map(String),
			}
		}

		function importCalibJsonObject(data) {
			if (!data || typeof data !== 'object') return false
			const c = state.calib
			if (data.meter_pulse_eq != null) c.meterPulseEq = numVal(data.meter_pulse_eq, c.meterPulseEq)
			if (data.calib_pulse_eq != null) c.calibPulseEq = numVal(data.calib_pulse_eq, c.calibPulseEq)
			if (data.comm_pulse_eq != null) c.commPulseEq = numVal(data.comm_pulse_eq, c.commPulseEq)
			if (data.fwd_count != null) c.fwdCount = Math.max(0, Math.min(20, numVal(data.fwd_count, 20)))
			if (data.rev_count != null) c.revCount = Math.max(0, Math.min(20, numVal(data.rev_count, 20)))
			for (let i = 0; i < 20; i++) {
				if (Array.isArray(data.fwd_points) && data.fwd_points[i] != null) c.fwdPoints[i] = numVal(data.fwd_points[i], 0)
				if (Array.isArray(data.fwd_coeffs) && data.fwd_coeffs[i] != null) c.fwdCoeffs[i] = numVal(data.fwd_coeffs[i], 10000)
				if (Array.isArray(data.rev_points) && data.rev_points[i] != null) c.revPoints[i] = numVal(data.rev_points[i], 0)
				if (Array.isArray(data.rev_coeffs) && data.rev_coeffs[i] != null) c.revCoeffs[i] = numVal(data.rev_coeffs[i], 10000)
			}
			addLog('SYS', '已导入 S 曲线校准 JSON')
			emit('calib')
			return true
		}

		// ---- 三锚点曲线推算 ----
		function ensureAnchorTables() {
			const proto = getProto()
			if (!state.anchor.tables.fwd.Q3.length && proto && typeof proto.createAnchorTable === 'function') {
				state.anchor.tables = makeDefaultAnchorTables(proto)
			}
			return state.anchor.tables
		}

		function syncAnchorCoeffsFromCalib() {
			const tables = ensureAnchorTables()
			state.anchor.calibReadDone = true
			;['fwd', 'rev'].forEach(function (dir) {
				const coeffs = dir === 'fwd' ? state.calib.fwdCoeffs : state.calib.revCoeffs
				;['Q3', 'Q2', 'Q1'].forEach(function (grp) {
					const rows = tables[dir][grp] || []
					for (let i = 0; i < rows.length; i++) {
						const r = rows[i]
						r.error = 0
						r.newCoeff = null
						if (r.idx != null && r.idx < coeffs.length) {
							r.currentCoeff = coeffs[r.idx]
						}
					}
				})
			})
		}

		function setAnchorError(direction, group, errPct) {
			const tables = ensureAnchorTables()
			const rows = (tables[direction] && tables[direction][group]) || []
			const v = Number(errPct)
			for (let i = 0; i < rows.length; i++) {
				if (rows[i].isAnchor) {
					rows[i].error = Number.isFinite(v) ? v : 0
					break
				}
			}
		}

		function inferAndCalcAnchor(direction) {
			const proto = getProto()
			const dir = direction || state.anchor.direction
			const tables = ensureAnchorTables()
			const dirTbl = tables[dir]
			const targetNew = dir === 'fwd' ? state.calib.fwdNewCoeffs : state.calib.revNewCoeffs
			;['Q3', 'Q2', 'Q1'].forEach(function (grp) {
				const rows = dirTbl[grp] || []
				let anchorErr = 0
				for (let i = 0; i < rows.length; i++) {
					if (rows[i].isAnchor) {
						anchorErr = Number(rows[i].error) || 0
						break
					}
				}
				const inferred = proto.inferAnchorGroup(rows, anchorErr)
				dirTbl[grp] = inferred
				for (let i = 0; i < inferred.length; i++) {
					const r = inferred[i]
					r.newCoeff = proto.calcNewCoeff(r.currentCoeff, r.error)
					if (r.idx != null && r.idx >= 0 && r.idx < 20) {
						targetNew[r.idx] = r.newCoeff
					}
				}
			})
			addLog('SYS', '[三锚点] ' + (dir === 'fwd' ? '正向' : '反向') + '推算与新系数计算完成，已同步至 S 曲线表')
			emit('anchor')
			emit('calib')
			return dirTbl
		}

		function syncAnchorAndWriteAll() {
			if (!state.anchor.calibReadDone) {
				dialogAlert('请先点击「0x40 读取当前系数」读取当前水表系数后再推算写入。', '请先读取当前系数')
				return Promise.resolve({ ok: false, error: '未读取当前系数' })
			}
			inferAndCalcAnchor(state.anchor.direction)
			return writeAllCalibCoeffs()
		}

		function exportAnchorConfigObject() {
			const tables = ensureAnchorTables()
			const cfg = { fwd: {}, rev: {} }
			;['fwd', 'rev'].forEach(function (dir) {
				;['Q3', 'Q2', 'Q1'].forEach(function (grp) {
					const rows = tables[dir][grp] || []
					for (let i = 0; i < rows.length; i++) {
						if (rows[i].isAnchor) {
							cfg[dir][grp] = round4(rows[i].error)
							break
						}
					}
				})
			})
			return cfg
		}

		function saveAnchorConfigToStorage() {
			const cfg = exportAnchorConfigObject()
			const st = getStorage()
			if (st) {
				try { st.setItem(ANCHOR_STORAGE_KEY, JSON.stringify(cfg)) } catch (e) {}
			}
			return cfg
		}

		function importAnchorConfigObject(cfg) {
			if (!cfg || typeof cfg !== 'object') return false
			ensureAnchorTables()
			;['fwd', 'rev'].forEach(function (dir) {
				const d = cfg[dir]
				if (!d || typeof d !== 'object') return
				;['Q3', 'Q2', 'Q1'].forEach(function (grp) {
					if (d[grp] != null) setAnchorError(dir, grp, Number(d[grp]) || 0)
				})
			})
			inferAndCalcAnchor(state.anchor.direction)
			return true
		}

		function loadAnchorConfigFromStorage() {
			const st = getStorage()
			if (!st) return false
			try {
				const raw = st.getItem(ANCHOR_STORAGE_KEY)
				if (!raw) return false
				return importAnchorConfigObject(JSON.parse(raw))
			} catch (e) {
				return false
			}
		}

		// ---- 参数 (0x42 / 0x43)、日冻结 (0x37)、设备日志 (0x44) ----
		function applyParamRead(d, seq) {
			if (d.paramType === 0 && d.base) {
				const b = d.base
				const uidHex = b.onlyAddrHex != null ? String(b.onlyAddrHex).trim().toUpperCase() : ''
				const matchedReq = seq != null && pendingBaseParamReadSeqs.has(seq)
				if (matchedReq) pendingBaseParamReadSeqs.delete(seq)

				if (uidHex || b.authCode) {
					updateDeviceIdentity(uidHex, null, b.authCode)
					emit('device')
				}
				if (d.layout) state.params.detectedLayout = d.layout
				state.params.base = Object.assign({}, state.params.base, {
					onlyAddrHex: uidHex || state.params.base.onlyAddrHex,
					voltageAlarmV: b.voltageAlarmV != null ? numVal(b.voltageAlarmV, 3.1) : state.params.base.voltageAlarmV,
					sampleIntervalMin: b.sampleIntervalMin != null ? numVal(b.sampleIntervalMin, 60) : state.params.base.sampleIntervalMin,
					baseDegree: b.baseDegree != null ? String(b.baseDegree) : state.params.base.baseDegree,
					initFlag: b.initFlag != null ? numVal(b.initFlag, 0x55) : state.params.base.initFlag,
					meterPulseEq: b.meterPulseEq != null ? numVal(b.meterPulseEq, 17085) : state.params.base.meterPulseEq,
					calibPulseEq: b.calibPulseEq != null ? numVal(b.calibPulseEq, 1000) : state.params.base.calibPulseEq,
					commPulseEq: b.commPulseEq != null ? numVal(b.commPulseEq, 60000) : state.params.base.commPulseEq,
					calibEnable: b.calibEnable != null ? Number(!!b.calibEnable) : state.params.base.calibEnable,
					calibDirection: b.calibDirection != null ? Number(!!b.calibDirection) : state.params.base.calibDirection,
					tempCompCoef: b.tempCompCoef != null ? numVal(b.tempCompCoef, 10000) : state.params.base.tempCompCoef,
					tempCompBaseC: b.tempCompBaseC != null ? numVal(b.tempCompBaseC, 20.0) : state.params.base.tempCompBaseC,
					crcHex: b.crcHex || '--',
				})
				if (matchedReq && isValidUidHex7(uidHex) && (!state.device.onlyAddrHex || uidHex === state.device.onlyAddrHex)) {
					state.params.baseLoaded = true
					state.params.baseConnGen = connGen
					state.params.baseUidHex = uidHex
				} else if (!matchedReq) {
					if (isValidUidHex7(uidHex) && state.params.baseUidHex && uidHex !== state.params.baseUidHex) {
						invalidateBaseParamsSnapshot()
					} else if (!state.params.baseLoaded) {
						state.params.baseLoaded = false
						state.params.baseConnGen = -1
						state.params.baseUidHex = ''
					}
				} else {
					state.params.baseLoaded = false
					state.params.baseConnGen = -1
					state.params.baseUidHex = ''
				}
				if (b.meterPulseEq > 0) {
					state.calib.meterPulseEq = numVal(b.meterPulseEq, state.calib.meterPulseEq)
				}
				addLog('SYS', '已读取基础参数 (layout=' + state.params.detectedLayout + (matchedReq ? '' : '，被动帧未建立写入快照') + ')')
			} else if (d.paramType === 1 && d.meter) {
				state.params.meter = d.meter
				addLog('SYS', '已读取计量结构体 (0x42 type=1)')
			} else if (d.paramType === 2 && d.alarm) {
				state.params.alarm = d.alarm
				addLog('SYS', '已读取报警参数 (0x42 type=2)')
			}
			emit('params')
		}

		function sendParamRead(paramType) {
			const proto = getProto()
			const labels = { 0: '基础参数', 1: '计量结构体', 2: '报警参数' }
			const seq = nextSeq()
			if (Number(paramType) === 0) {
				pendingBaseParamReadSeqs.add(seq)
			}
			return writeBytes(proto.builders.paramRead(paramType, buildOpts({ seq: seq })), '0x42 读取' + (labels[paramType] || ('类型' + paramType)))
		}

		function sendParamWriteBase(baseObj, layoutOverride) {
			const proto = getProto()
			const authCode = getEffectiveAuthCode()
			if (authCode == null) {
				dialogAlert('写入基础参数 (0x43) 需要认证码，请先点击「读设备 0x33」获取。', '缺少认证码')
				return Promise.resolve({ ok: false, error: '缺少认证码' })
			}
			const layout = (layoutOverride && layoutOverride !== 'auto')
				? layoutOverride
				: (state.params.layoutMode !== 'auto' ? state.params.layoutMode : (state.params.detectedLayout || 'v27-40'))
			const payload = Object.assign({}, state.params.base, baseObj || {})
			if (layout === 'v27-40' || layout === 'legacy-48') {
				if (!isBaseParamsSnapshotValid()) {
					dialogAlert('请先点击「读取基础参数 (0x42)」获取当前水表的基础参数快照后，再修改写入（防止覆盖设备唯一码与未读字段）。', '请先读取基础参数')
					return Promise.resolve({ ok: false, error: '未读取当前表基础参数' })
				}
				if (baseObj && baseObj.onlyAddrHex != null && String(baseObj.onlyAddrHex).trim() !== '' &&
					String(baseObj.onlyAddrHex).trim().toUpperCase() !== state.params.baseUidHex) {
					dialogAlert('为保护水表身份，0x43 基础参数写入禁止覆盖设备唯一码。', '禁止覆盖唯一码')
					return Promise.resolve({ ok: false, error: '禁止修改水表设备唯一码 (onlyAddr)' })
				}
				payload.onlyAddrHex = state.params.baseUidHex
			}
			const degParsed = parseUint64Input(payload.baseDegree != null ? payload.baseDegree : '0')
			if (!degParsed.ok) {
				dialogAlert('底度值超出 uint64 范围 (0 ~ 18446744073709551615) 或格式无效。', '参数无效')
				return Promise.resolve({ ok: false, error: '底度超出 uint64 范围' })
			}
			payload.baseDegree = degParsed.value
			const frame = proto.builders.paramWriteBase(payload, authCode, buildOpts({ layout: layout }))
			return writeBytes(frame, '0x43 写入基础参数 (' + layout + ')')
		}

		function sendDailyFreezePage(startIndex) {
			const proto = getProto()
			const idx = Math.max(0, Math.min(61, Number(startIndex) || 0))
			state.freeze.startIndex = idx
			return writeBytes(proto.builders.dailyFreeze(idx, buildOpts()), '0x37 日冻结读取 #' + idx)
		}

		function startDailyFreezeAll() {
			if (!isOpen) {
				addLog('ERR', '请先连接串口再读取日冻结')
				return false
			}
			state.freeze.autoReading = true
			state.freeze.nextIndex = 0
			state.freeze.totalCount = 0
			state.freeze.skippedCorruptCount = 0
			state.freeze.entries = []
			addLog('SYS', '开始自动翻页读取全部日冻结数据...')
			emit('freeze')
			notifyStatusBadge()
			armFreezePageTimeout()
			sendDailyFreezePage(0)
			return true
		}

		function armFreezePageTimeout() {
			clearTimer('freezeTimeout')
			timers.freezeTimeout = schedTimeout(function () {
				timers.freezeTimeout = null
				if (!state.freeze.autoReading) return
				state.freeze.autoReading = false
				addLog('ERR', '自动读取日冻结超时，已停止（已收集 ' + state.freeze.entries.length + ' 条）')
				emit('freeze')
				notifyStatusBadge()
			}, otaDelay(timings.freezePageTimeoutMs))
		}

		function handleDailyFreezeAck(ok, d, statusLabel) {
			clearTimer('freezeTimeout')
			if (!ok) {
				addLog('ERR', '日冻结读取失败: ' + statusLabel)
				if (state.freeze.autoReading) {
					state.freeze.autoReading = false
					emit('freeze')
					notifyStatusBadge()
				}
				return
			}
			const total = numVal(d.totalCount, 0)
			const batch = numVal(d.batchCount, 0)
			const list = Array.isArray(d.entries) ? d.entries : []
			const validList = []
			let skipped = 0
			for (let i = 0; i < list.length; i++) {
				const e = list[i]
				if (e && e.magicOk !== false && e.crcOk !== false) {
					validList.push(e)
				} else {
					skipped++
				}
			}
			if (skipped > 0) {
				addLog('ERR', '日冻结本页跳过 ' + skipped + ' 条损坏记录（魔数或 CRC16 校验失败）')
			}
			state.freeze.totalCount = total
			if (state.freeze.autoReading) {
				state.freeze.skippedCorruptCount += skipped
				for (let i = 0; i < validList.length; i++) state.freeze.entries.push(validList[i])
				const nextIdx = state.freeze.nextIndex + batch
				if (batch > 0 && nextIdx < total) {
					state.freeze.nextIndex = nextIdx
					armFreezePageTimeout()
					sendDailyFreezePage(nextIdx)
				} else {
					state.freeze.autoReading = false
					addLog('SYS', '日冻结自动读取完成，共 ' + state.freeze.entries.length + ' 条有效记录' + (state.freeze.skippedCorruptCount ? ('（已跳过 ' + state.freeze.skippedCorruptCount + ' 条损坏记录）') : ''))
					notifyStatusBadge()
				}
			} else {
				state.freeze.skippedCorruptCount = skipped
				state.freeze.entries = validList
			}
			emit('freeze')
		}

		function buildFreezeCsv() {
			const header = '序号,日期,净累计(L),反流(L),正流(L),最大流速(m³/h),平均温度(°C),报警,CRC'
			const lines = [header]
			for (let i = 0; i < state.freeze.entries.length; i++) {
				const e = state.freeze.entries[i]
				if (!e || e.magicOk === false || e.crcOk === false) continue
				const alarms = Array.isArray(e.alarms) && e.alarms.length ? e.alarms.join(' ') : '无'
				lines.push([
					e.serial != null ? e.serial : i,
					e.date || '--',
					numVal(e.cumulativeL, 0).toFixed(2),
					numVal(e.reverseL, 0).toFixed(2),
					numVal(e.positiveL, 0).toFixed(2),
					numVal(e.flowRateM3h, 0).toFixed(4),
					numVal(e.temperatureC, 0).toFixed(1),
					alarms,
					e.crcHex || '--',
				].join(','))
			}
			return '\ufeff' + lines.join('\n')
		}

		function sendLogRead(logType) {
			const proto = getProto()
			const authCode = getEffectiveAuthCode()
			if (authCode == null) {
				dialogAlert('读取设备内部日志 (0x44) 需要认证码，请先读取设备信息 (0x33)。', '缺少认证码')
				return Promise.resolve({ ok: false, error: '缺少认证码' })
			}
			const t = logType != null ? Number(logType) : state.deviceLogs.logType
			state.deviceLogs.logType = t
			return writeBytes(proto.builders.logRead(t, authCode, buildOpts()), '0x44 读取设备日志 (type=' + t + ')')
		}

		function applyLogRead(d) {
			state.deviceLogs.entries = Array.isArray(d.entries) ? d.entries.slice() : []
			addLog('SYS', '收到设备内部日志 ' + state.deviceLogs.entries.length + ' 条')
			emit('device-logs')
		}

		// ---- 系统控制命令 (0x33 / 0x35 / 0x47 / 0x34 / 0x32 / 0x36 / 0x45 / 0x46) ----
		function sendDevInfo(withTimeSyncOverride, extraOpts) {
			if (state.ota.running && !(extraOpts && extraOpts._isOtaVerify)) {
				addLog('ERR', '自动 OTA 升级进行中，请等待重启验证完成')
				return Promise.resolve({ ok: false, error: '自动 OTA 升级进行中，请等待重启验证完成' })
			}
			const proto = getProto()
			const sync = withTimeSyncOverride !== undefined ? !!withTimeSyncOverride : state.withTimeSync
			const seq = (extraOpts && extraOpts.seq != null) ? extraOpts.seq : nextSeq()
			if (!(extraOpts && extraOpts._isOtaVerify)) {
				sentDevInfoSeqs.add(seq)
			}
			return writeBytes(proto.builders.devInfo(sync, buildOpts({ seq: seq })), '0x33 读取设备信息')
		}

		function sendModeSet(mode) {
			const proto = getProto()
			const m = Number(mode)
			let authCode = 0
			if (m === 2) {
				authCode = getEffectiveAuthCode()
				if (authCode == null) {
					dialogAlert('进入校表模式 (mode=2) 需要认证码，请先点击「读设备 0x33」。', '缺少认证码')
					return Promise.resolve({ ok: false, error: '缺少认证码' })
				}
			}
			return writeBytes(proto.builders.modeSet(m, authCode, buildOpts()), '0x35 模式切换 -> ' + (MODE_NAMES[m] || m))
		}

		function sendBaseDegree(valStr) {
			const proto = getProto()
			const authCode = getEffectiveAuthCode()
			if (authCode == null) {
				dialogAlert('设置底度 (0x47) 需要认证码，请先点击「读设备 0x33」。', '缺少认证码')
				return Promise.resolve({ ok: false, error: '缺少认证码' })
			}
			const parsed = parseUint64Input(valStr == null ? '0' : valStr)
			if (!parsed.ok) {
				dialogAlert('请输入 0 ~ 18446744073709551615 范围内的非负整数脉冲底度值。', '参数无效')
				return Promise.resolve({ ok: false, error: parsed.error })
			}
			state.params.baseDegreeStatus = '正在下发底度，等待设备确认...'
			state.params.baseDegreeTone = 'info'
			emit('params')
			clearTimer('baseDegreeTimeout')
			timers.baseDegreeTimeout = schedTimeout(function () {
				timers.baseDegreeTimeout = null
				state.params.baseDegreeStatus = '底度设置超时（5s 未收到应答）'
				state.params.baseDegreeTone = 'danger'
				addLog('ERR', '0x47 底度设置超时')
				emit('params')
			}, otaDelay(timings.baseDegreeTimeoutMs))
			return writeBytes(proto.builders.baseDegree(parsed.value, authCode, buildOpts()), '0x47 设置底度=' + parsed.text)
		}

		function sendTimeSync() {
			const proto = getProto()
			return writeBytes(proto.builders.timeSync(nowDate(), 0, buildOpts()), '0x34 专用 RTC 对时')
		}

		function sendAlarmClear(mask) {
			const proto = getProto()
			const authCode = getEffectiveAuthCode()
			if (authCode == null) {
				dialogAlert('清除报警标志 (0x32) 需要认证码，请先读取设备信息 (0x33)。', '缺少认证码')
				return Promise.resolve({ ok: false, error: '缺少认证码' })
			}
			return writeBytes(proto.builders.alarmClear(mask & 0x0f, authCode, buildOpts()), '0x32 清除报警 mask=0x' + (mask & 0x0f).toString(16).toUpperCase().padStart(2, '0'))
		}

		function sendAuthBypass(hexOrZero) {
			const proto = getProto()
			const val = typeof hexOrZero === 'number' ? (hexOrZero >>> 0) : parseUint32Hex(hexOrZero)
			if (val == null) {
				dialogAlert('请输入有效的 32 位十六进制旁路令牌（如 12345678 或 00000000）。', '参数无效')
				return Promise.resolve({ ok: false, error: '无效旁路值' })
			}
			return writeBytes(proto.builders.authBypass(val, buildOpts()), '0x36 认证旁路 ' + hex32(val))
		}

		async function sendSystemReset() {
			const proto = getProto()
			const authCode = getEffectiveAuthCode()
			if (authCode == null) {
				await dialogAlert('系统复位 (0x45) 需要认证码，请先读取设备信息 (0x33)。', '缺少认证码')
				return { ok: false, error: '缺少认证码' }
			}
			const yes = await dialogConfirm('确定要向水表发送 0x45 系统复位指令吗？设备将立即重启。', { title: '确认系统复位', danger: true, okText: '确认复位' })
			if (!yes) return { ok: false, cancelled: true }
			return writeBytes(proto.builders.systemReset(authCode, buildOpts()), '0x45 系统复位')
		}

		async function sendParamReset(level) {
			const proto = getProto()
			const authCode = getEffectiveAuthCode()
			if (authCode == null) {
				await dialogAlert('恢复设置 (0x46) 需要认证码，请先读取设备信息 (0x33)。', '缺少认证码')
				return { ok: false, error: '缺少认证码' }
			}
			const names = { 1: '恢复计量与基础数据 (level=1)', 2: '恢复报警参数 (level=2)', 3: '恢复全部出厂设置 (level=3)' }
			const yes = await dialogConfirm('危险操作：确定执行「' + (names[level] || level) + '」吗？该操作不可撤销！', { title: '确认恢复设置', danger: true, okText: '确认执行' })
			if (!yes) return { ok: false, cancelled: true }
			return writeBytes(proto.builders.paramReset(level, authCode, buildOpts()), '0x46 ' + (names[level] || ('level=' + level)))
		}

		// ---- OTA 固件头检测、打包与 6 步自动升级状态机 ----
		function loadFirmwareBytes(bytes, fileName) {
			const proto = getProto()
			const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0)
			const info = proto.inspectFirmwareBin(u8)
			state.ota.fileName = String(fileName || 'firmware.bin')
			state.ota.rawBytes = u8
			state.ota.inspect = info
			state.ota.manualPacketIndex = 0
			addLog('SYS', '已加载固件 ' + state.ota.fileName + ' (' + u8.length + 'B, ' + (info.hasHeader ? '含 16B 固件头' : '原始 App.bin') + ')')
			emit('ota')
			return info
		}

		function buildWrappedFirmwareForDownload() {
			const proto = getProto()
			if (!state.ota.rawBytes || !state.ota.rawBytes.length) {
				return { ok: false, error: '请先选择 .bin 固件文件' }
			}
			const info = state.ota.inspect || proto.inspectFirmwareBin(state.ota.rawBytes)
			if (info.hasHeader) {
				return { ok: false, alreadyWrapped: true, error: '当前文件已包含 16B 固件头，无需重复封装' }
			}
			const wrapped = proto.wrapFirmwareWithHeader(state.ota.rawBytes)
			const baseName = state.ota.fileName.replace(/\.bin$/i, '') || 'App'
			return {
				ok: true,
				fileName: baseName + '_new.bin',
				image: wrapped.image,
				info: wrapped.info,
			}
		}

		function getEffectiveOtaImage() {
			const proto = getProto()
			if (!state.ota.rawBytes || !state.ota.rawBytes.length) return null
			const info = state.ota.inspect || proto.inspectFirmwareBin(state.ota.rawBytes)
			if (info.hasHeader) {
				return { image: state.ota.rawBytes, info: info, autoWrapped: false }
			}
			const wrapped = proto.wrapFirmwareWithHeader(state.ota.rawBytes)
			return { image: wrapped.image, info: wrapped.info, autoWrapped: true }
		}

		function setOtaStepVisual(stepIdx, stepState) {
			for (let i = 0; i < state.ota.stepStatus.length; i++) {
				if (i < stepIdx) state.ota.stepStatus[i] = 'done'
				else if (i === stepIdx) state.ota.stepStatus[i] = stepState || 'active'
				else state.ota.stepStatus[i] = 'idle'
			}
		}

		function setOtaChunkSize(sz) {
			if (state.ota.running) {
				addLog('ERR', 'OTA 升级进行中，禁止修改分包大小')
				return false
			}
			const n = Math.trunc(Number(sz))
			if (!Number.isFinite(n) || n < 16 || n > 512) {
				return false
			}
			state.ota.chunkSize = n
			emit('ota')
			return true
		}

		function abortOta(reason) {
			clearTimer('otaStep')
			clearTimer('otaTimeout')
			clearTimer('otaRetry')
			const wasRunning = state.ota.running
			state.ota.running = false
			state.ota.runGen = -1
			state.ota.runChunkSize = 0
			state.ota.pendingChunkLen = 0
			state.ota.waitingAck = false
			state.ota.pendingSeq = null
			state.ota.pendingCmd = null
			state.ota.verifySeq = null
			state.ota.finishSent = false
			state.ota.finishAcked = false
			state.ota.retryCount = 0
			state.ota.progress = 0
			state.ota.step = -1
			state.ota.stepStatus = ['idle', 'idle', 'idle', 'idle', 'idle', 'idle']
			state.ota.statusText = reason ? ('已中止: ' + reason) : '已复位'
			if (wasRunning) {
				addLog('SYS', 'OTA 状态机已中止/复位' + (reason ? (' (' + reason + ')') : ''))
			}
			emit('ota')
			notifyStatusBadge()
		}

		function failOta(stepIdx, reason) {
			clearTimer('otaStep')
			clearTimer('otaTimeout')
			clearTimer('otaRetry')
			state.ota.running = false
			state.ota.runGen = -1
			state.ota.runChunkSize = 0
			state.ota.pendingChunkLen = 0
			state.ota.waitingAck = false
			state.ota.pendingSeq = null
			state.ota.pendingCmd = null
			state.ota.verifySeq = null
			state.ota.finishSent = false
			state.ota.finishAcked = false
			if (stepIdx >= 0 && stepIdx < state.ota.stepStatus.length) {
				state.ota.stepStatus[stepIdx] = 'error'
			}
			state.ota.statusText = '升级失败: ' + reason
			state.ota.lastResult = { ok: false, reason: reason }
			addLog('ERR', 'OTA 升级失败: ' + reason)
			emit('ota')
			emit('ota-done', state.ota.lastResult)
			notifyStatusBadge()
			dialogAlert('OTA 升级失败：\n' + reason, 'OTA 升级失败')
		}

		function finishOtaVerifyTimeout() {
			clearTimer('otaStep')
			clearTimer('otaTimeout')
			clearTimer('otaRetry')
			const o = state.ota
			o.running = false
			o.runGen = -1
			o.runChunkSize = 0
			o.pendingChunkLen = 0
			o.waitingAck = false
			o.pendingSeq = null
			o.pendingCmd = null
			o.verifySeq = null
			o.stepStatus[5] = 'error'
			const msg = 'OTA 激活指令 (0x26) 已发送，但等待重启验证 (0x33) 超时，未确认新固件是否启动，请检查设备或手动点击「读设备 0x33」核实'
			o.statusText = msg
			o.lastResult = {
				ok: false,
				unverified: true,
				stage: 'verify_timeout',
				originalVersion: o.originalVersion || '--',
				newVersion: '',
				onlyAddrHex: '',
				reason: msg,
			}
			addLog('ERR', msg)
			emit('ota')
			emit('ota-done', o.lastResult)
			notifyStatusBadge()
			dialogAlert(msg, 'OTA 验证超时（未确认）')
		}

		function finishOtaVerification(actualVersion, actualOnlyAddr) {
			clearTimer('otaStep')
			clearTimer('otaTimeout')
			clearTimer('otaRetry')
			const o = state.ota
			const oldVer = o.originalVersion || '--'
			const newVer = String(actualVersion || '').trim()
			const normActualUid = actualOnlyAddr ? String(actualOnlyAddr).trim().toUpperCase() : ''
			const normOrigUid = o.originalOnlyAddr ? String(o.originalOnlyAddr).trim().toUpperCase() : ''
			o.running = false
			o.runGen = -1
			o.runChunkSize = 0
			o.pendingChunkLen = 0
			o.waitingAck = false
			o.pendingSeq = null
			o.pendingCmd = null
			o.verifySeq = null

			if (normOrigUid && isValidUidHex7(normActualUid) && normOrigUid !== normActualUid) {
				o.stepStatus[5] = 'error'
				const mismatchMsg = 'OTA 验证失败：收到其他水表的 0x33 响应（原设备唯一号 ' + normOrigUid + '，实收 ' + normActualUid + '），未确认原设备升级成功'
				o.statusText = mismatchMsg
				o.lastResult = {
					ok: false,
					uidMismatch: true,
					stage: 'uid_mismatch',
					originalVersion: oldVer,
					newVersion: newVer,
					originalOnlyAddr: normOrigUid,
					onlyAddrHex: normActualUid,
					reason: mismatchMsg,
				}
				addLog('ERR', mismatchMsg)
				emit('ota')
				emit('ota-done', o.lastResult)
				notifyStatusBadge()
				dialogAlert(mismatchMsg, 'OTA 验证失败')
				return
			}

			if (!isValidUidHex7(normActualUid) || !newVer) {
				o.stepStatus[5] = 'error'
				const msg = 'OTA 验证未确认：收到的 0x33 缺少有效固件版本号或 7 字节设备唯一号，请手动点击「读设备 0x33」核实'
				o.statusText = msg
				o.lastResult = {
					ok: false,
					unverified: true,
					stage: 'incomplete_dev_info',
					originalVersion: oldVer,
					newVersion: newVer,
					onlyAddrHex: normActualUid,
					reason: msg,
				}
				addLog('ERR', msg)
				emit('ota')
				emit('ota-done', o.lastResult)
				notifyStatusBadge()
				dialogAlert(msg, 'OTA 验证未确认')
				return
			}

			o.progress = 100
			setOtaStepVisual(5, 'done')
			for (let i = 0; i < o.stepStatus.length; i++) o.stepStatus[i] = 'done'

			const summary = 'OTA 升级完成！版本: ' + oldVer + ' → ' + newVer
			o.statusText = summary
			o.lastResult = {
				ok: true,
				originalVersion: oldVer,
				newVersion: newVer,
				onlyAddrHex: normActualUid,
				uidMismatch: false,
			}
			addLog('SYS', summary)
			emit('ota')
			emit('ota-done', o.lastResult)
			notifyStatusBadge()
			dialogAlert(summary, 'OTA 升级完成')
		}

		function startAutoOta(opts) {
			opts = opts || {}
			const proto = getProto()
			if (!isOpen) {
				addLog('ERR', '请先连接串口再启动 OTA 升级')
				return { ok: false, error: '串口未连接' }
			}
			if (state.ota.running) {
				return { ok: false, error: 'OTA 升级正在进行中' }
			}
			const prepared = getEffectiveOtaImage()
			if (!prepared || !prepared.image || !prepared.image.length) {
				dialogAlert('请先选择有效的固件 .bin 文件。', '未选择固件')
				return { ok: false, error: '未选择固件' }
			}
			if (prepared.info && prepared.info.validForApp2 === false) {
				const err = prepared.info.reason || '固件校验未通过（不满足 APP2 要求）'
				dialogAlert(err, '固件校验失败')
				return { ok: false, error: err }
			}
			if (prepared.image.length <= proto.OTA_HEADER_SIZE || prepared.image.length > proto.OTA_APP2_SIZE) {
				const err = 'OTA 固件包大小超限（' + prepared.image.length + 'B，允许 17B ~ ' + proto.OTA_APP2_SIZE + 'B）'
				dialogAlert(err, '固件大小超限')
				return { ok: false, error: err }
			}
			if (state.flow.monitorRunning) {
				stopFlowMonitor(true)
			}

			const o = state.ota
			const runChunkSize = Number(opts.chunkSize || o.chunkSize) || 256
			o.chunkSize = runChunkSize
			o.runChunkSize = runChunkSize
			o.pendingChunkLen = 0
			o.imageBytes = prepared.image
			o.totalSize = prepared.image.length
			o.expectedCrc = prepared.info && prepared.info.totalCrc != null ? prepared.info.totalCrc : proto.crc16(prepared.image)
			o.deviceCrc = null
			o.running = true
			o.runGen = connGen
			o.step = 0
			o.progress = 2
			o.currentAddr = proto.OTA_APP2_ADDR
			o.sentBytes = 0
			o.waitingAck = false
			o.pendingSeq = null
			o.pendingCmd = null
			o.verifySeq = null
			o.finishSent = false
			o.finishAcked = false
			o.retryCount = 0
			o.maxRetries = 5
			const devFresh = state.device.deviceConnGen === -1 || state.device.deviceConnGen === connGen
			o.originalVersion = devFresh ? (state.device.firmwareVersion || '') : ''
			o.originalOnlyAddr = (devFresh && state.device.onlyAddrHex) ? String(state.device.onlyAddrHex).toUpperCase() : ''
			o.expectedVersion = o.fileName.replace(/\.bin$/i, '')
			o.proactiveReceived = false
			o.lastResult = null
			setOtaStepVisual(0, 'active')
			o.statusText = 'Step 0: 正在握手 (0x20)...'

			addLog('SYS', '开始一键 OTA 升级：' + o.fileName + (prepared.autoWrapped ? '（已自动内存封装 16B 固件头）' : '') + '，总计 ' + o.totalSize + 'B，整包 CRC=' + hex16(o.expectedCrc))
			emit('ota')
			notifyStatusBadge()
			runOtaStep()
			return { ok: true, totalSize: o.totalSize, expectedCrc: o.expectedCrc, autoWrapped: prepared.autoWrapped }
		}

		function runOtaStep() {
			const proto = getProto()
			const o = state.ota
			if (!o.running || !isOpen || connGen !== o.runGen) return
			clearTimer('otaTimeout')
			clearTimer('otaRetry')

			if (o.step === 0) {
				setOtaStepVisual(0, 'active')
				o.progress = 5
				o.statusText = 'Step 0: 发送 0x20 握手...'
				const seq = nextSeq()
				o.pendingSeq = seq
				o.pendingCmd = proto.CMD.HANDSHAKE
				o.waitingAck = true
				emit('ota')
				writeBytes(proto.builders.handshake(buildOpts({ seq: seq })), 'OTA Step0 0x20 握手')
				timers.otaTimeout = schedTimeout(function () { onOtaStepTimeout(0, '握手超时') }, otaDelay(timings.otaHandshakeMs))
			} else if (o.step === 1) {
				setOtaStepVisual(1, 'active')
				o.progress = 12
				o.statusText = 'Step 1: 擦除 APP2 (0x8000, 24KB)...'
				const seq = nextSeq()
				o.pendingSeq = seq
				o.pendingCmd = proto.CMD.OTA_ERASE
				o.waitingAck = true
				emit('ota')
				writeBytes(proto.builders.otaErase(proto.OTA_APP2_ADDR, proto.OTA_APP2_SIZE, buildOpts({ seq: seq })), 'OTA Step1 0x24 擦除 APP2')
				timers.otaTimeout = schedTimeout(function () { onOtaStepTimeout(1, '擦除超时') }, otaDelay(timings.otaEraseMs))
			} else if (o.step === 2) {
				setOtaStepVisual(2, 'active')
				sendNextOtaChunk()
			} else if (o.step === 3) {
				setOtaStepVisual(3, 'active')
				o.progress = 88
				o.statusText = 'Step 3: 整包 CRC 校验 (0x25)...'
				const seq = nextSeq()
				o.pendingSeq = seq
				o.pendingCmd = proto.CMD.OTA_CRC
				o.waitingAck = true
				if (streamParser && typeof streamParser.trackCrcReq === 'function') {
					streamParser.trackCrcReq(seq, proto.OTA_APP2_ADDR)
				}
				emit('ota')
				writeBytes(proto.builders.otaCrc(proto.OTA_APP2_ADDR, o.totalSize, buildOpts({ seq: seq, crcReqAddr: proto.OTA_APP2_ADDR })), 'OTA Step3 0x25 整包 CRC 校验')
				timers.otaTimeout = schedTimeout(function () { onOtaStepTimeout(3, 'CRC 校验超时') }, otaDelay(timings.otaCrcMs))
			} else if (o.step === 4) {
				setOtaStepVisual(4, 'active')
				o.progress = 94
				o.statusText = 'Step 4: 发送 OTA 完成 (0x26)...'
				const finSeq = nextSeq()
				o.pendingSeq = finSeq
				o.pendingCmd = proto.CMD.OTA_FINISH
				o.waitingAck = true
				o.finishSent = true
				o.finishAcked = false
				emit('ota')
				const crcForFinish = o.deviceCrc != null ? o.deviceCrc : o.expectedCrc
				writeBytes(proto.builders.otaFinish(o.totalSize, crcForFinish, buildOpts({ seq: finSeq })), 'OTA Step4 0x26 完成激活')
				o.step = 5
				o.proactiveReceived = false
				setOtaStepVisual(5, 'active')
				o.progress = 96
				o.statusText = 'Step 5: 等待设备复位重启（15s，收到主动 0x33 即刻推进）...'
				emit('ota')
				const runGenSnap = o.runGen
				timers.otaTimeout = schedTimeout(function () {
					timers.otaTimeout = null
					if (!o.running || o.step !== 5 || o.proactiveReceived || connGen !== runGenSnap) return
					o.step = 6
					o.progress = 98
					o.statusText = 'Step 5: 主动发送 0x33 查询新版本...'
					const vSeq = nextSeq()
					o.verifySeq = vSeq
					o.pendingSeq = vSeq
					o.pendingCmd = proto.CMD.DEV_INFO
					o.waitingAck = true
					emit('ota')
					sendDevInfo(state.withTimeSync, { seq: vSeq, _isOtaVerify: true })
					timers.otaTimeout = schedTimeout(function () {
						timers.otaTimeout = null
						if (!o.running || o.step !== 6 || connGen !== runGenSnap) return
						finishOtaVerifyTimeout()
					}, otaDelay(timings.otaVerifyMs))
				}, otaDelay(timings.otaResetWaitMs))
			}
		}

		function sendNextOtaChunk() {
			const proto = getProto()
			const o = state.ota
			if (!o.running || o.step !== 2 || o.waitingAck || connGen !== o.runGen) return
			const offset = o.currentAddr - proto.OTA_APP2_ADDR
			if (offset >= o.totalSize) {
				o.step = 3
				o.retryCount = 0
				clearTimer('otaStep')
				timers.otaStep = schedTimeout(runOtaStep, timings.otaStepGapMs)
				return
			}
			const stepChunkSize = o.runChunkSize || o.chunkSize || 256
			const end = Math.min(offset + stepChunkSize, o.totalSize)
			const chunk = o.imageBytes.subarray(offset, end)
			const seq = nextSeq()
			o.pendingSeq = seq
			o.pendingCmd = proto.CMD.OTA_DATA
			o.pendingChunkLen = chunk.length
			o.waitingAck = true
			o.progress = 15 + Math.floor((end / o.totalSize) * 70)
			o.statusText = 'Step 2: 下载固件 ' + end + '/' + o.totalSize + 'B (' + o.progress + '%)'
			emit('ota')
			writeBytes(proto.builders.otaData(o.currentAddr, chunk, buildOpts({ seq: seq })), 'OTA Step2 0x22 @0x' + o.currentAddr.toString(16).toUpperCase() + ' (' + chunk.length + 'B)')
			clearTimer('otaTimeout')
			timers.otaTimeout = schedTimeout(function () {
				onOtaChunkTimeout()
			}, otaDelay(timings.otaChunkMs))
		}

		function onOtaStepTimeout(stepIdx, label) {
			timers.otaTimeout = null
			const o = state.ota
			if (!o.running || o.step !== stepIdx || connGen !== o.runGen) return
			o.waitingAck = false
			o.pendingSeq = null
			o.pendingCmd = null
			o.retryCount++
			if (o.retryCount <= o.maxRetries) {
				addLog('SYS', 'OTA ' + label + '，重试 (' + o.retryCount + '/' + o.maxRetries + ')...')
				o.statusText = label + '，重试 ' + o.retryCount + '/' + o.maxRetries + '...'
				emit('ota')
				timers.otaRetry = schedTimeout(runOtaStep, otaDelay(timings.otaRetryDelayMs))
			} else {
				failOta(stepIdx, label + '（已重试 ' + o.maxRetries + ' 次）')
			}
		}

		function onOtaChunkTimeout() {
			timers.otaTimeout = null
			const o = state.ota
			if (!o.running || o.step !== 2 || connGen !== o.runGen) return
			o.waitingAck = false
			o.pendingSeq = null
			o.pendingCmd = null
			o.pendingChunkLen = 0
			o.retryCount++
			if (o.retryCount <= o.maxRetries) {
				addLog('SYS', 'OTA 数据块确认超时，重试 (' + o.retryCount + '/' + o.maxRetries + ')...')
				o.statusText = '数据块超时，重试 ' + o.retryCount + '/' + o.maxRetries + '...'
				emit('ota')
				timers.otaRetry = schedTimeout(sendNextOtaChunk, otaDelay(timings.otaRetryDelayMs))
			} else {
				failOta(2, '数据块确认超时（已重试 ' + o.maxRetries + ' 次）')
			}
		}

		function handleOtaResponse(cmd, status, d, statusLabel, seq) {
			const proto = getProto()
			const CMD = proto.CMD
			const STATUS = proto.STATUS
			const o = state.ota
			if (!o.running || connGen !== o.runGen) return

			if (cmd === CMD.HANDSHAKE && o.step === 0) {
				if (!o.waitingAck || o.pendingCmd !== CMD.HANDSHAKE || seq !== o.pendingSeq) return
				o.waitingAck = false
				o.pendingSeq = null
				o.pendingCmd = null
				if (status !== STATUS.OK) {
					failOta(0, '握手返回错误: ' + statusLabel)
					return
				}
				if (!o.originalVersion && d.firmwareVersion) {
					o.originalVersion = String(d.firmwareVersion).trim()
				}
				clearTimer('otaTimeout')
				clearTimer('otaRetry')
				o.retryCount = 0
				o.step = 1
				timers.otaStep = schedTimeout(runOtaStep, timings.otaStepGapMs)
			} else if (cmd === CMD.OTA_ERASE && o.step === 1) {
				if (!o.waitingAck || o.pendingCmd !== CMD.OTA_ERASE || seq !== o.pendingSeq) return
				o.waitingAck = false
				o.pendingSeq = null
				o.pendingCmd = null
				if (status !== STATUS.OK) {
					failOta(1, '擦除 APP2 失败: ' + statusLabel)
					return
				}
				clearTimer('otaTimeout')
				clearTimer('otaRetry')
				o.retryCount = 0
				o.step = 2
				timers.otaStep = schedTimeout(runOtaStep, timings.otaStepGapMs)
			} else if (cmd === CMD.OTA_DATA && o.step === 2) {
				if (!o.waitingAck || o.pendingCmd !== CMD.OTA_DATA || seq !== o.pendingSeq) return
				o.waitingAck = false
				o.pendingSeq = null
				o.pendingCmd = null
				if (status === STATUS.ADDR_ERROR) {
					failOta(2, '数据块写入地址越界 (0x04)')
					return
				}
				if (status !== STATUS.OK) {
					failOta(2, '数据块写入失败: ' + statusLabel)
					return
				}
				clearTimer('otaTimeout')
				clearTimer('otaRetry')
				o.retryCount = 0
				const offset = o.currentAddr - proto.OTA_APP2_ADDR
				const sentLen = o.pendingChunkLen > 0
					? o.pendingChunkLen
					: Math.min(o.runChunkSize || o.chunkSize || 256, Math.max(0, o.totalSize - offset))
				o.pendingChunkLen = 0
				o.currentAddr += sentLen
				o.sentBytes = Math.min(o.totalSize, o.currentAddr - proto.OTA_APP2_ADDR)
				if (o.sentBytes >= o.totalSize) {
					o.step = 3
					timers.otaStep = schedTimeout(runOtaStep, timings.otaStepGapMs)
				} else {
					sendNextOtaChunk()
				}
			} else if (cmd === CMD.OTA_CRC && o.step === 3) {
				if (!o.waitingAck || o.pendingCmd !== CMD.OTA_CRC || seq !== o.pendingSeq) return
				o.waitingAck = false
				o.pendingSeq = null
				o.pendingCmd = null
				if (status !== STATUS.OK) {
					failOta(3, 'CRC 校验指令失败: ' + statusLabel)
					return
				}
				clearTimer('otaTimeout')
				clearTimer('otaRetry')
				const devCrc = d.crcValue != null ? (d.crcValue & 0xffff) : null
				if (devCrc == null || devCrc !== (o.expectedCrc & 0xffff)) {
					failOta(3, '整包 CRC 不匹配（期望 ' + hex16(o.expectedCrc) + '，设备返回 ' + hex16(devCrc) + '）')
					return
				}
				o.deviceCrc = devCrc
				o.retryCount = 0
				o.step = 4
				runOtaStep()
			} else if (cmd === CMD.OTA_FINISH && (o.step === 4 || o.step === 5)) {
				if (!o.waitingAck || o.pendingCmd !== CMD.OTA_FINISH || seq !== o.pendingSeq) return
				o.waitingAck = false
				o.pendingSeq = null
				o.pendingCmd = null
				if (status !== STATUS.OK) {
					failOta(4, 'OTA 完成校验失败: ' + statusLabel)
					return
				}
				o.finishAcked = true
				addLog('SYS', '设备确认 OTA 完成，等待进入 Bootloader 升级并重启...')
			} else if (cmd === CMD.DEV_INFO && status === STATUS.OK && (o.step === 5 || o.step === 6)) {
				if (!o.finishSent) return
				const rxUid = d.onlyAddrHex ? String(d.onlyAddrHex).trim().toUpperCase() : ''
				const rxVer = String(d.firmwareVersion || '').trim()
				if (o.step === 5) {
					if (seq != null && sentDevInfoSeqs.has(seq)) {
						addLog('SYS', '忽略 OTA 前的迟到 0x33 响应 (SEQ=' + seq + ')')
						return
					}
					if (!o.finishAcked && seq !== 0) {
						return
					}
					if (o.originalOnlyAddr && isValidUidHex7(rxUid) && rxUid !== o.originalOnlyAddr) {
						o.proactiveReceived = true
						finishOtaVerification(rxVer, rxUid)
						return
					}
					if (!isValidUidHex7(rxUid) || !rxVer) {
						addLog('SYS', '忽略字段不完整的 0x33 报文，继续等待验证')
						return
					}
					o.proactiveReceived = true
					finishOtaVerification(rxVer, rxUid)
				} else if (o.step === 6) {
					const seqMatches = seq != null && seq === o.verifySeq
					const bootReport = seq === 0 && !sentDevInfoSeqs.has(0) && isValidUidHex7(rxUid) && rxVer.length > 0
					if (!seqMatches && !bootReport) return
					o.proactiveReceived = true
					finishOtaVerification(rxVer, rxUid)
				}
			}
		}

		// 手动单步 OTA 操作（自动 OTA 运行期间禁止发送）
		function guardManualOta() {
			if (state.ota.running) {
				addLog('ERR', '自动 OTA 升级进行中，禁止执行手动 OTA 操作')
				return { ok: false, error: '自动 OTA 运行中，禁止手动 OTA 操作' }
			}
			return null
		}

		function sendManualOtaHandshake() {
			const blocked = guardManualOta()
			if (blocked) return Promise.resolve(blocked)
			const proto = getProto()
			return writeBytes(proto.builders.handshake(buildOpts()), '手动 0x20 握手')
		}

		function sendManualOtaErase() {
			const blocked = guardManualOta()
			if (blocked) return Promise.resolve(blocked)
			const proto = getProto()
			return writeBytes(proto.builders.otaErase(proto.OTA_APP2_ADDR, proto.OTA_APP2_SIZE, buildOpts()), '手动 0x24 擦除 APP2')
		}

		function sendManualOtaChunk(advanceNext) {
			const blocked = guardManualOta()
			if (blocked) return Promise.resolve(blocked)
			const proto = getProto()
			const prepared = getEffectiveOtaImage()
			if (!prepared) {
				dialogAlert('请先加载固件 .bin 文件。', '提示')
				return Promise.resolve({ ok: false, error: '未加载固件' })
			}
			const idx = state.ota.manualPacketIndex
			const offset = idx * state.ota.chunkSize
			if (offset >= prepared.image.length) {
				dialogAlert('所有分包已发送完毕（共 ' + idx + ' 包）。', '提示')
				return Promise.resolve({ ok: false, error: '已到末尾' })
			}
			const chunk = prepared.image.subarray(offset, Math.min(offset + state.ota.chunkSize, prepared.image.length))
			const addr = proto.OTA_APP2_ADDR + offset
			if (advanceNext) state.ota.manualPacketIndex = idx + 1
			emit('ota')
			return writeBytes(proto.builders.otaData(addr, chunk, buildOpts()), '手动 0x22 包#' + idx + ' @0x' + addr.toString(16).toUpperCase())
		}

		function sendManualOtaCrc() {
			const blocked = guardManualOta()
			if (blocked) return Promise.resolve(blocked)
			const proto = getProto()
			const prepared = getEffectiveOtaImage()
			if (!prepared) {
				dialogAlert('请先加载固件 .bin 文件。', '提示')
				return Promise.resolve({ ok: false, error: '未加载固件' })
			}
			const seq = nextSeq()
			if (streamParser && typeof streamParser.trackCrcReq === 'function') {
				streamParser.trackCrcReq(seq, proto.OTA_APP2_ADDR)
			}
			return writeBytes(proto.builders.otaCrc(proto.OTA_APP2_ADDR, prepared.image.length, buildOpts({ seq: seq, crcReqAddr: proto.OTA_APP2_ADDR })), '手动 0x25 整包 CRC 校验')
		}

		function sendManualOtaFinish() {
			const blocked = guardManualOta()
			if (blocked) return Promise.resolve(blocked)
			const proto = getProto()
			const prepared = getEffectiveOtaImage()
			if (!prepared) {
				dialogAlert('请先加载固件 .bin 文件。', '提示')
				return Promise.resolve({ ok: false, error: '未加载固件' })
			}
			const crcVal = prepared.info && prepared.info.totalCrc != null ? prepared.info.totalCrc : proto.crc16(prepared.image)
			return writeBytes(proto.builders.otaFinish(prepared.image.length, crcVal, buildOpts()), '手动 0x26 OTA 完成')
		}

		// ---- 一键「保存全部数据 (JSON)」4 步串行状态机 ----
		// 0x33(3s) -> 300ms -> 0x40(4s) -> 300ms -> 0x42(type=0, 3s) -> 300ms -> A99A(raw, 3s)
		// 超时重试：1s -> 2s（最多 2 次），仍失败则跳过该步骤继续下一步
		function cancelSaveAll(reason) {
			clearTimer('saveStepTimeout')
			clearTimer('saveGap')
			clearTimer('saveRetry')
			const run = activeSaveRun
			activeSaveRun = null
			state.saveAll.running = false
			state.saveAll.step = -1
			state.saveAll.stepDone = false
			state.saveAll.progressText = ''
			if (reason) addLog('SYS', '保存全部数据已中止: ' + reason)
			emit('save-all')
			notifyStatusBadge()
			if (run) {
				run.settle({ ok: false, cancelled: true, error: reason || '已取消' })
			}
		}

		function startSaveAll(opts) {
			opts = opts || {}
			if (!isOpen) {
				dialogAlert('请先连接串口设备，再执行「保存全部数据」。', '串口未连接')
				return Promise.resolve({ ok: false, error: '串口未连接' })
			}
			if (state.saveAll.running || activeSaveRun) {
				return Promise.resolve({ ok: false, error: '正在读取保存中' })
			}
			if (state.ota.running) {
				dialogAlert('当前正在进行 OTA 升级，请等待完成后再保存数据。', '操作冲突')
				return Promise.resolve({ ok: false, error: 'OTA 运行中' })
			}
			if (state.flow.monitorRunning) {
				stopFlowMonitor(true)
			}
			const run = {
				id: ++saveRunSeq,
				connGen: connGen,
				step: -1,
				retryCount: 0,
				attemptSeq: 0,
				attemptId: 0,
				stepDone: false,
				expectedCmd: null,
				expectedSeq: null,
				expectedIotSeq: null,
				skipDownload: !!opts.skipDownload,
				deviceSnap: null,
				calibSnap: null,
				baseSnap: null,
				moduleInfo: null,
				serialIo: {},
				settled: false,
				resolve: null,
				settle: function (res) {
					if (run.settled) return
					run.settled = true
					const fn = run.resolve
					run.resolve = null
					if (typeof fn === 'function') fn(res)
				},
			}
			activeSaveRun = run

			const s = state.saveAll
			s.running = true
			s.step = -1
			s.retryCount = 0
			s.stepDone = false
			s.progressText = '准备中...'
			s.deviceSnap = null
			s.calibSnap = null
			s.baseSnap = null
			s.moduleInfo = null
			s.serialIo = run.serialIo
			s.lastRecord = null
			s.lastFileName = ''
			addLog('SYS', '开始一键「保存全部数据」：0x33 → 0x40 → 0x42 → A99A')
			emit('save-all')
			notifyStatusBadge()
			return new Promise(function (resolve) {
				run.resolve = resolve
				nextSaveAllStep(run)
			})
		}

		function captureSaveAllAc6d(p, detail, rawHex) {
			const proto = getProto()
			const CMD = proto.CMD
			const run = activeSaveRun
			if (!run || !state.saveAll.running || run.stepDone || connGen !== run.connGen) return
			if (p.cmd !== run.expectedCmd || p.seq !== run.expectedSeq) return

			if (run.step === 0 && p.cmd === CMD.DEV_INFO) {
				if (!run.serialIo.device_info) run.serialIo.device_info = {}
				run.serialIo.device_info.rx = rawHex
				run.deviceSnap = Object.assign({}, detail)
				state.saveAll.deviceSnap = run.deviceSnap
				advanceSaveAllStep(run)
			} else if (run.step === 1 && p.cmd === CMD.CALIB_READ) {
				if (!run.serialIo.calib) run.serialIo.calib = {}
				run.serialIo.calib.rx = rawHex
				run.calibSnap = Object.assign({}, detail)
				state.saveAll.calibSnap = run.calibSnap
				advanceSaveAllStep(run)
			} else if (run.step === 2 && p.cmd === CMD.PARAM_READ && detail.paramType === 0 && detail.base) {
				if (!run.serialIo.param) run.serialIo.param = {}
				run.serialIo.param.rx = rawHex
				run.baseSnap = Object.assign({}, detail.base)
				state.saveAll.baseSnap = run.baseSnap
				advanceSaveAllStep(run)
			}
		}

		function nextSaveAllStep(run) {
			clearTimer('saveStepTimeout')
			clearTimer('saveGap')
			clearTimer('saveRetry')
			if (activeSaveRun !== run || !state.saveAll.running || connGen !== run.connGen) return
			run.step++
			run.retryCount = 0
			run.stepDone = false
			run.expectedCmd = null
			run.expectedSeq = null
			run.expectedIotSeq = null
			state.saveAll.step = run.step
			state.saveAll.retryCount = 0
			state.saveAll.stepDone = false
			if (run.step > 3) {
				finishSaveAll(run)
				return
			}
			sendSaveAllCurrentStep(run)
		}

		function sendSaveAllCurrentStep(run) {
			const proto = getProto()
			if (activeSaveRun !== run || !state.saveAll.running || connGen !== run.connGen) return
			const stepNames = ['1/4 0x33', '2/4 0x40', '3/4 0x42', '4/4 A99A']
			const attemptId = (run.attemptSeq = (run.attemptSeq || 0) + 1)
			run.attemptId = attemptId
			state.saveAll.progressText = stepNames[run.step] + (run.retryCount > 0 ? (' 重试' + run.retryCount) : '')
			run.stepDone = false
			state.saveAll.stepDone = false
			emit('save-all')

			let frame = null
			let ioKey = ''
			let label = ''
			if (run.step === 0) {
				const seq = nextSeq()
				sentDevInfoSeqs.add(seq)
				run.expectedCmd = proto.CMD.DEV_INFO
				run.expectedSeq = seq
				run.expectedIotSeq = null
				frame = proto.builders.devInfo(true, buildOpts({ seq: seq }))
				ioKey = 'device_info'
				label = '保存全部[1/4] 0x33 设备信息'
			} else if (run.step === 1) {
				const seq = nextSeq()
				run.expectedCmd = proto.CMD.CALIB_READ
				run.expectedSeq = seq
				run.expectedIotSeq = null
				frame = proto.builders.calibRead(buildOpts({ seq: seq }))
				ioKey = 'calib'
				label = '保存全部[2/4] 0x40 校准表'
			} else if (run.step === 2) {
				const seq = nextSeq()
				pendingBaseParamReadSeqs.add(seq)
				run.expectedCmd = proto.CMD.PARAM_READ
				run.expectedSeq = seq
				run.expectedIotSeq = null
				frame = proto.builders.paramRead(0, buildOpts({ seq: seq }))
				ioKey = 'param'
				label = '保存全部[3/4] 0x42 基础参数'
			} else {
				// A99A 模组查询帧必须直接裸发，禁止外层二次封装透传！
				const iotSeq = nextIotSeq()
				run.expectedCmd = null
				run.expectedSeq = null
				run.expectedIotSeq = iotSeq
				frame = proto.buildModuleInfoQuery(0x01, iotSeq, nowDate())
				ioKey = 'module'
				label = '保存全部[4/4] A99A 模组信息(直发)'
			}
			if (!run.serialIo[ioKey]) run.serialIo[ioKey] = {}
			run.serialIo[ioKey].tx = bytesToHexUpper(frame, false)

			const timeoutMs = otaDelay(timings.saveTimeouts[run.step] || 3000)
			const armAttemptTimer = function () {
				clearTimer('saveStepTimeout')
				timers.saveStepTimeout = schedTimeout(function () {
					timers.saveStepTimeout = null
					onSaveAllStepFail(run, attemptId, '超时')
				}, timeoutMs)
			}
			armAttemptTimer()

			writeBytes(frame, label, {
				beforeWrite: function () {
					return activeSaveRun === run && state.saveAll.running && !run.stepDone && run.attemptId === attemptId && connGen === run.connGen
				},
				onWriteStart: function () {
					if (activeSaveRun === run && state.saveAll.running && !run.stepDone && run.attemptId === attemptId && connGen === run.connGen) {
						armAttemptTimer()
					}
				},
			}).then(function (res) {
				if (!res.ok && !res.skipped && activeSaveRun === run && state.saveAll.running && !run.stepDone && run.attemptId === attemptId && connGen === run.connGen) {
					clearTimer('saveStepTimeout')
					onSaveAllStepFail(run, attemptId, '发送失败')
				}
			})
		}

		function onSaveAllStepFail(run, attemptId, reason) {
			if (activeSaveRun !== run || !state.saveAll.running || run.stepDone || (attemptId != null && run.attemptId !== attemptId) || connGen !== run.connGen) return
			run.stepDone = true
			run.attemptId = -1
			run.expectedCmd = null
			run.expectedSeq = null
			run.expectedIotSeq = null
			state.saveAll.stepDone = true
			const maxRetries = timings.saveRetryDelays.length
			if (run.retryCount < maxRetries) {
				const delayMs = timings.saveRetryDelays[run.retryCount]
				run.retryCount++
				state.saveAll.retryCount = run.retryCount
				addLog('SYS', '保存全部数据第 ' + (run.step + 1) + ' 步' + reason + '，' + (delayMs / 1000) + 's 后重试 (' + run.retryCount + '/' + maxRetries + ')')
				state.saveAll.progressText = '步骤' + (run.step + 1) + ' 重试中(' + run.retryCount + '/' + maxRetries + ')'
				emit('save-all')
				clearTimer('saveRetry')
				timers.saveRetry = schedTimeout(function () {
					timers.saveRetry = null
					sendSaveAllCurrentStep(run)
				}, delayMs)
			} else {
				addLog('ERR', '保存全部数据第 ' + (run.step + 1) + ' 步重试 ' + maxRetries + ' 次仍失败，跳过该步骤')
				nextSaveAllStep(run)
			}
		}

		function advanceSaveAllStep(run) {
			clearTimer('saveStepTimeout')
			clearTimer('saveRetry')
			if (activeSaveRun !== run || !state.saveAll.running || run.stepDone || connGen !== run.connGen) return
			run.stepDone = true
			run.attemptId = -1
			run.expectedCmd = null
			run.expectedSeq = null
			run.expectedIotSeq = null
			state.saveAll.stepDone = true
			clearTimer('saveGap')
			timers.saveGap = schedTimeout(function () {
				timers.saveGap = null
				nextSaveAllStep(run)
			}, timings.saveGapMs)
		}

		async function finishSaveAll(run) {
			const proto = getProto()
			const s = state.saveAll
			if (activeSaveRun !== run || run.settled) return
			s.progressText = '正在保存文件...'
			emit('save-all')

			const now = nowDate()
			const modBasic = (run.moduleInfo && run.moduleInfo.basic) ? run.moduleInfo.basic : {}
			const userNumber = modBasic.userNumber || ''
			const fileName = (proto && typeof proto.buildCalibBindFileName === 'function')
				? proto.buildCalibBindFileName(userNumber, now)
				: fallbackBuildCalibBindFileName(userNumber, now)
			const batch = fileName.split('_')[0] || 'N'
			const parityCode = state.parity === 'even' ? 'E' : (state.parity === 'odd' ? 'O' : 'N')
			const portLabel = describePort(currentPort)
			const payload = {
				date: now,
				savedAt: now,
				port: portLabel,
				portName: portLabel,
				connected: isOpen,
				serialParams: { baud: state.baudRate, parity: parityCode, stopbits: 1, bytesize: 8 },
				userNumber: userNumber,
				batch: batch,
				fileName: fileName,
				device: run.deviceSnap,
				calibData: run.calibSnap,
				baseParams: run.baseSnap,
				moduleInfo: run.moduleInfo,
				serialIo: run.serialIo,
			}

			let record = null
			if (proto && typeof proto.buildCalibBindJson === 'function') {
				try { record = proto.buildCalibBindJson(payload) } catch (e) { record = null }
			}
			if (!record || typeof record !== 'object' || record.schema !== 'SK-CALIB-BIND') {
				record = fallbackBuildCalibBindJson(payload)
			}
			s.lastRecord = record
			s.lastFileName = fileName

			const jsonText = JSON.stringify(record, null, 2)
			if (!run.skipDownload) {
				let saveErr = null
				try {
					const saved = await saveFileViaPlatform(fileName, jsonText, 'application/json;charset=utf-8', getPlatform(), getDoc())
					if (saved === false) {
						saveErr = new Error('当前环境不支持文件保存')
					}
				} catch (e) {
					saveErr = e
				}
				if (activeSaveRun !== run || run.settled) return
				if (saveErr) {
					const errMsg = saveErr && saveErr.message ? saveErr.message : String(saveErr)
					addLog('ERR', '保存 JSON 文件失败: ' + errMsg)
					activeSaveRun = null
					s.running = false
					s.step = -1
					s.progressText = ''
					emit('save-all')
					notifyStatusBadge()
					await dialogAlert('保存校表数据文件失败：\n' + errMsg, '保存失败')
					run.settle({ ok: false, error: errMsg, fileName: fileName, record: record })
					return
				}
			}

			if (activeSaveRun !== run || run.settled) return
			const okDev = run.deviceSnap ? 1 : 0
			const okCalib = run.calibSnap ? 1 : 0
			const okBase = run.baseSnap ? 1 : 0
			const okMod = (modBasic.imei || modBasic.iccid) ? 1 : 0
			const summary = '已生成校表绑定文件：' + fileName + '\n' +
				'设备信息 (0x33): ' + (okDev ? '成功' : '未获取') + '\n' +
				'校准表 (0x40): ' + (okCalib ? '成功' : '未获取') + '\n' +
				'基础参数 (0x42): ' + (okBase ? '成功' : '未获取') + '\n' +
				'远传模组 (A99A): ' + (okMod ? '成功' : '未获取')
			addLog('SYS', '全部数据保存完成: ' + fileName)
			s.progressText = '保存完成'
			emit('save-all')
			await dialogAlert(summary, (okDev && okCalib && okBase && okMod) ? '保存全部数据成功' : '保存全部数据完成')
			if (activeSaveRun === run) {
				activeSaveRun = null
				s.running = false
				s.step = -1
				s.progressText = ''
				emit('save-all')
				notifyStatusBadge()
			}
			run.settle({ ok: true, fileName: fileName, record: record, summary: { okDev, okCalib, okBase, okMod } })
		}

		// ---- 工具插件生命周期与忙碌契约 ----
		function ownsPort(port) {
			return !!(port && (
				(isOpening && openingPort === port) ||
				((isOpen || isClosing || closeFailed) && (heldPort || currentPort) === port)
			))
		}

		function isBusy() {
			return !!(isOpen || isOpening || isClosing || closeFailed || state.ota.running || state.saveAll.running || state.freeze.autoReading || state.flow.monitorRunning)
		}

		function busyReason() {
			if (state.ota.running) return '水表校表台正在进行 OTA 升级，请先等待完成或停止'
			if (state.saveAll.running) return '水表校表台正在读取并保存全部数据，请先等待完成'
			if (state.freeze.autoReading) return '水表校表台正在自动翻页读取日冻结数据，请先等待完成'
			if (state.flow.monitorRunning) return '水表校表台正在监控实时流量，请先停止监控'
			if (closeFailed) return '水表校表台串口关闭失败，请重试断开释放端口'
			if (isOpening) return '水表校表台正在连接串口'
			if (isClosing) return '水表校表台正在关闭串口'
			if (isOpen) return '水表校表台已连接串口，请先断开连接'
			return ''
		}

		function statusBadge() {
			if (isOpen) {
				return {
					conn: 'open',
					active: true,
					state: 'open',
					title: '容积水表校表台 · 已连接',
				}
			}
			if (isOpening) {
				return {
					active: true,
					state: 'opening',
					title: '容积水表校表台 · 正在连接',
				}
			}
			if (closeFailed) {
				return {
					active: true,
					state: 'error',
					title: '容积水表校表台 · 关闭串口失败，请重试断开',
				}
			}
			return null
		}

		function sendCustomHex(hexStr) {
			const bytes = parseHexStr(hexStr)
			if (!bytes || !bytes.length) {
				addLog('ERR', '自定义 HEX 格式无效或为空')
				return Promise.resolve({ ok: false, error: 'HEX 无效' })
			}
			return writeBytes(bytes, '自定义发送')
		}

		function revive() {
			destroyed = false
			bindAdapterEvents()
		}

		function destroy() {
			destroyed = true
			portEnumSeq++
			unbindAdapterEvents()
			clearAllWorkflowTimers()
			if (isOpen || isOpening || closeFailed) {
				closePort({ manual: true })
			} else {
				abortActiveTasks('工作台已卸载')
			}
			listeners.clear()
		}

		bindAdapterEvents()
		loadAnchorConfigFromStorage()

		return {
			state: state,
			onChange: onChange,
			addLog: addLog,
			clearLogs: clearLogs,
			// 端口与连接
			getCurrentPort: function () { return currentPort },
			isOpen: function () { return isOpen },
			isOpening: function () { return isOpening },
			isClosing: function () { return isClosing },
			isCloseFailed: function () { return closeFailed },
			isBaseParamsSnapshotValid: isBaseParamsSnapshotValid,
			checkPortConflict: checkPortConflict,
			refreshPorts: refreshPorts,
			selectPort: selectPort,
			requestPort: requestPort,
			openPort: openPort,
			closePort: closePort,
			writeBytes: writeBytes,
			sendCustomHex: sendCustomHex,
			handleIncomingChunk: handleIncomingChunk,
			// 身份与认证
			getEffectiveAuthCode: getEffectiveAuthCode,
			setManualAuthCode: setManualAuthCode,
			// 流量监控 & 脉冲计时
			sendFlowOnce: sendFlowOnce,
			startFlowMonitor: startFlowMonitor,
			stopFlowMonitor: stopFlowMonitor,
			getLcdReadout: getLcdReadout,
			resetAntiRollback: resetAntiRollback,
			clearFlowHistory: clearFlowHistory,
			pulseTimingManualStart: pulseTimingManualStart,
			pulseTimingAutoStart: pulseTimingAutoStart,
			pulseTimingStop: pulseTimingStop,
			pulseTimingClear: pulseTimingClear,
			getPulseTimingSnapshot: getPulseTimingSnapshot,
			// S 曲线校准
			sendCalibRead: sendCalibRead,
			calcAllNewCoeffs: calcAllNewCoeffs,
			writeSingleCoeff: writeSingleCoeff,
			writeAllCalibCoeffs: writeAllCalibCoeffs,
			exportCalibJsonObject: exportCalibJsonObject,
			importCalibJsonObject: importCalibJsonObject,
			// 三锚点推算
			ensureAnchorTables: ensureAnchorTables,
			setAnchorError: setAnchorError,
			inferAndCalcAnchor: inferAndCalcAnchor,
			syncAnchorAndWriteAll: syncAnchorAndWriteAll,
			exportAnchorConfigObject: exportAnchorConfigObject,
			saveAnchorConfigToStorage: saveAnchorConfigToStorage,
			importAnchorConfigObject: importAnchorConfigObject,
			// 参数 / 日冻结 / 日志
			sendParamRead: sendParamRead,
			sendParamWriteBase: sendParamWriteBase,
			sendDailyFreezePage: sendDailyFreezePage,
			startDailyFreezeAll: startDailyFreezeAll,
			buildFreezeCsv: buildFreezeCsv,
			sendLogRead: sendLogRead,
			// 系统控制
			sendDevInfo: sendDevInfo,
			sendModeSet: sendModeSet,
			sendBaseDegree: sendBaseDegree,
			sendTimeSync: sendTimeSync,
			sendAlarmClear: sendAlarmClear,
			sendAuthBypass: sendAuthBypass,
			sendSystemReset: sendSystemReset,
			sendParamReset: sendParamReset,
			// OTA
			loadFirmwareBytes: loadFirmwareBytes,
			buildWrappedFirmwareForDownload: buildWrappedFirmwareForDownload,
			setOtaChunkSize: setOtaChunkSize,
			startAutoOta: startAutoOta,
			abortOta: abortOta,
			sendManualOtaHandshake: sendManualOtaHandshake,
			sendManualOtaErase: sendManualOtaErase,
			sendManualOtaChunk: sendManualOtaChunk,
			sendManualOtaCrc: sendManualOtaCrc,
			sendManualOtaFinish: sendManualOtaFinish,
			// 保存全部数据
			startSaveAll: startSaveAll,
			cancelSaveAll: cancelSaveAll,
			// 插件契约
			ownsPort: ownsPort,
			isBusy: isBusy,
			busyReason: busyReason,
			statusBadge: statusBadge,
			revive: revive,
			destroy: destroy,
		}
	}

	// =========================================================================
	// HiDPI Canvas 主题自适应绘图（流量双轴曲线 / S 曲线误差 / 三锚点 Log-X）
	// =========================================================================
	function readThemeColors(canvas) {
		const fallback = {
			bg: '#ffffff',
			grid: 'rgba(134,134,139,0.22)',
			axis: '#86868b',
			text: '#1d1d1f',
			blue: '#007aff',
			red: '#ff3b30',
			green: '#34c759',
			warn: '#ff9500',
		}
		if (!canvas || typeof getComputedStyle !== 'function') return fallback
		try {
			const cs = getComputedStyle(canvas)
			const rootCs = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : cs
			return {
				bg: (rootCs.getPropertyValue('--bg-surface') || '').trim() || fallback.bg,
				grid: (rootCs.getPropertyValue('--border-light') || '').trim() || fallback.grid,
				axis: (rootCs.getPropertyValue('--text-secondary') || '').trim() || fallback.axis,
				text: (rootCs.getPropertyValue('--text-primary') || '').trim() || fallback.text,
				blue: (rootCs.getPropertyValue('--accent') || '').trim() || fallback.blue,
				red: (rootCs.getPropertyValue('--danger') || '').trim() || fallback.red,
				green: (rootCs.getPropertyValue('--success') || '').trim() || fallback.green,
				warn: (rootCs.getPropertyValue('--warning') || '').trim() || fallback.warn,
			}
		} catch (e) {
			return fallback
		}
	}

	function prepHiDpiCanvas(canvas) {
		if (!canvas || typeof canvas.getContext !== 'function') return null
		const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 600, height: 240 }
		const w = Math.max(200, Math.floor(rect.width || 600))
		const h = Math.max(140, Math.floor(rect.height || 240))
		const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(window.devicePixelRatio, 3) : 1
		if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
			canvas.width = Math.round(w * dpr)
			canvas.height = Math.round(h * dpr)
		}
		const ctx = canvas.getContext('2d')
		if (!ctx) return null
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		return { ctx: ctx, w: w, h: h, colors: readThemeColors(canvas) }
	}

	function drawFlowChart(canvas, history) {
		const g = prepHiDpiCanvas(canvas)
		if (!g) return
		const ctx = g.ctx
		const w = g.w
		const h = g.h
		const c = g.colors
		ctx.fillStyle = c.bg
		ctx.fillRect(0, 0, w, h)

		const pad = { left: 62, right: 56, top: 26, bottom: 26 }
		const pw = Math.max(20, w - pad.left - pad.right)
		const ph = Math.max(20, h - pad.top - pad.bottom)

		// 图例
		ctx.font = '11px -apple-system, sans-serif'
		ctx.fillStyle = c.blue
		ctx.fillRect(pad.left, 8, 10, 3)
		ctx.fillStyle = c.text
		ctx.fillText('正累计(m³)', pad.left + 14, 13)
		ctx.fillStyle = c.red
		ctx.fillRect(pad.left + 90, 8, 10, 3)
		ctx.fillStyle = c.text
		ctx.fillText('反累计(m³)', pad.left + 104, 13)
		ctx.fillStyle = c.green
		ctx.fillRect(pad.left + 180, 8, 10, 3)
		ctx.fillStyle = c.text
		ctx.fillText('瞬时流量(L/h)', pad.left + 194, 13)

		// 网格
		ctx.strokeStyle = c.grid
		ctx.lineWidth = 1
		for (let i = 0; i <= 4; i++) {
			const y = pad.top + (ph * i) / 4
			ctx.beginPath()
			ctx.moveTo(pad.left, y)
			ctx.lineTo(pad.left + pw, y)
			ctx.stroke()
		}

		if (!history || !history.length) {
			ctx.fillStyle = c.axis
			ctx.textAlign = 'center'
			ctx.fillText('暂无实时流量采样数据（启动监控或单次读取后绘制）', pad.left + pw / 2, pad.top + ph / 2)
			ctx.textAlign = 'left'
			return
		}

		let minVol = Infinity
		let maxVol = -Infinity
		let maxFlow = 1
		for (let i = 0; i < history.length; i++) {
			const pt = history[i]
			if (pt.posM3 < minVol) minVol = pt.posM3
			if (pt.posM3 > maxVol) maxVol = pt.posM3
			if (pt.revM3 < minVol) minVol = pt.revM3
			if (pt.revM3 > maxVol) maxVol = pt.revM3
			if (pt.flowLph > maxFlow) maxFlow = pt.flowLph
		}
		if (!isFinite(minVol) || minVol === maxVol) {
			minVol = Math.max(0, (minVol || 0) - 0.0001)
			maxVol = minVol + 0.0005
		} else {
			const span = maxVol - minVol
			minVol = Math.max(0, minVol - span * 0.08)
			maxVol = maxVol + span * 0.12
		}
		maxFlow = maxFlow * 1.15

		// 左右 Y 轴刻度
		ctx.fillStyle = c.axis
		ctx.font = '10px ui-monospace, monospace'
		for (let i = 0; i <= 4; i++) {
			const frac = 1 - i / 4
			const y = pad.top + (ph * i) / 4
			const volTick = minVol + (maxVol - minVol) * frac
			const flowTick = maxFlow * frac
			ctx.textAlign = 'right'
			ctx.fillText(volTick.toFixed(4), pad.left - 6, y + 3)
			ctx.textAlign = 'left'
			ctx.fillText(flowTick.toFixed(1), pad.left + pw + 6, y + 3)
		}

		function xOf(i) {
			if (history.length <= 1) return pad.left + pw / 2
			return pad.left + (i / (history.length - 1)) * pw
		}
		function yVol(v) {
			return pad.top + ph - ((v - minVol) / (maxVol - minVol)) * ph
		}
		function yFlow(v) {
			return pad.top + ph - (v / maxFlow) * ph
		}

		function plotLine(getter, yFn, color) {
			ctx.strokeStyle = color
			ctx.lineWidth = 1.8
			ctx.beginPath()
			for (let i = 0; i < history.length; i++) {
				const x = xOf(i)
				const y = yFn(getter(history[i]))
				if (i === 0) ctx.moveTo(x, y)
				else ctx.lineTo(x, y)
			}
			ctx.stroke()
		}
		plotLine(function (p) { return p.posM3 }, yVol, c.blue)
		plotLine(function (p) { return p.revM3 }, yVol, c.red)
		plotLine(function (p) { return p.flowLph }, yFlow, c.green)

		ctx.fillStyle = c.axis
		ctx.textAlign = 'center'
		ctx.fillText('样本序号 (1 ~ ' + history.length + ' / ' + FLOW_HISTORY_MAX + ')', pad.left + pw / 2, h - 6)
		ctx.textAlign = 'left'
	}

	function drawSCurveChart(canvas, proto, calib, viewMode) {
		const g = prepHiDpiCanvas(canvas)
		if (!g) return
		const ctx = g.ctx
		const w = g.w
		const h = g.h
		const c = g.colors
		ctx.fillStyle = c.bg
		ctx.fillRect(0, 0, w, h)

		const pad = { left: 54, right: 20, top: 24, bottom: 28 }
		const pw = Math.max(20, w - pad.left - pad.right)
		const ph = Math.max(20, h - pad.top - pad.bottom)

		function collect(dir) {
			const pts = dir === 'fwd' ? calib.fwdPoints : calib.revPoints
			const coeffs = dir === 'fwd' ? calib.fwdCoeffs : calib.revCoeffs
			const count = dir === 'fwd' ? calib.fwdCount : calib.revCount
			const out = []
			const n = Math.min(20, Math.max(0, Number(count) || 20))
			for (let i = 0; i < n; i++) {
				const ms = Number(pts[i]) || 0
				const cf = Number(coeffs[i]) || 10000
				if (ms <= 0) continue
				const flowLph = proto && proto.calcPointFlowRateLph
					? proto.calcPointFlowRateLph(calib.meterPulseEq, ms, cf)
					: (calib.meterPulseEq * 3.6 / ms) * (cf / 10000)
				const devPct = ((cf - 10000) / 10000) * 100
				if (isFinite(flowLph) && flowLph > 0) {
					out.push({ x: flowLph, y: devPct })
				}
			}
			out.sort(function (a, b) { return a.x - b.x })
			return out
		}

		const fwdPts = (viewMode === 'fwd' || viewMode === 'dual') ? collect('fwd') : []
		const revPts = (viewMode === 'rev' || viewMode === 'dual') ? collect('rev') : []
		const all = fwdPts.concat(revPts)

		// 标题与图例
		ctx.font = '11px -apple-system, sans-serif'
		let lx = pad.left
		if (viewMode === 'fwd' || viewMode === 'dual') {
			ctx.fillStyle = c.blue
			ctx.fillRect(lx, 8, 10, 3)
			ctx.fillStyle = c.text
			ctx.fillText('正向 S 曲线 (%)', lx + 14, 13)
			lx += 116
		}
		if (viewMode === 'rev' || viewMode === 'dual') {
			ctx.fillStyle = c.red
			ctx.fillRect(lx, 8, 10, 3)
			ctx.fillStyle = c.text
			ctx.fillText('反向 S 曲线 (%)', lx + 14, 13)
		}

		if (!all.length) {
			ctx.fillStyle = c.axis
			ctx.textAlign = 'center'
			ctx.fillText('暂无有效校准点（读取 0x40 或填写脉冲间隔 ms 后绘制）', pad.left + pw / 2, pad.top + ph / 2)
			ctx.textAlign = 'left'
			return
		}

		let minX = Infinity
		let maxX = -Infinity
		let minY = -2
		let maxY = 2
		for (let i = 0; i < all.length; i++) {
			if (all[i].x < minX) minX = all[i].x
			if (all[i].x > maxX) maxX = all[i].x
			if (all[i].y < minY) minY = all[i].y
			if (all[i].y > maxY) maxY = all[i].y
		}
		if (minX === maxX) {
			minX = Math.max(0, minX - 10)
			maxX = maxX + 10
		}
		const yPad = Math.max(0.5, (maxY - minY) * 0.15)
		minY -= yPad
		maxY += yPad

		function sx(x) { return pad.left + ((x - minX) / (maxX - minX)) * pw }
		function sy(y) { return pad.top + ph - ((y - minY) / (maxY - minY)) * ph }

		// 网格 + 刻度
		ctx.strokeStyle = c.grid
		ctx.lineWidth = 1
		ctx.font = '10px ui-monospace, monospace'
		ctx.fillStyle = c.axis
		for (let i = 0; i <= 4; i++) {
			const yVal = maxY - ((maxY - minY) * i) / 4
			const y = sy(yVal)
			ctx.beginPath()
			ctx.moveTo(pad.left, y)
			ctx.lineTo(pad.left + pw, y)
			ctx.stroke()
			ctx.textAlign = 'right'
			ctx.fillText(yVal.toFixed(1) + '%', pad.left - 6, y + 3)
		}

		// 零误差参考虚线
		if (minY <= 0 && maxY >= 0) {
			const y0 = sy(0)
			ctx.save()
			ctx.strokeStyle = c.axis
			ctx.setLineDash([4, 4])
			ctx.beginPath()
			ctx.moveTo(pad.left, y0)
			ctx.lineTo(pad.left + pw, y0)
			ctx.stroke()
			ctx.restore()
		}

		function plot(pts, color) {
			if (!pts.length) return
			ctx.strokeStyle = color
			ctx.lineWidth = 1.8
			ctx.beginPath()
			for (let i = 0; i < pts.length; i++) {
				const x = sx(pts[i].x)
				const y = sy(pts[i].y)
				if (i === 0) ctx.moveTo(x, y)
				else ctx.lineTo(x, y)
			}
			ctx.stroke()
			ctx.fillStyle = color
			for (let i = 0; i < pts.length; i++) {
				ctx.beginPath()
				ctx.arc(sx(pts[i].x), sy(pts[i].y), 3, 0, Math.PI * 2)
				ctx.fill()
			}
		}
		plot(fwdPts, c.blue)
		plot(revPts, c.red)

		ctx.fillStyle = c.axis
		ctx.textAlign = 'center'
		ctx.fillText('流速 (L/h): ' + minX.toFixed(1) + ' ~ ' + maxX.toFixed(1), pad.left + pw / 2, h - 7)
		ctx.textAlign = 'left'
	}

	function drawAnchorLogChart(canvas, direction, dirTable) {
		const g = prepHiDpiCanvas(canvas)
		if (!g) return
		const ctx = g.ctx
		const w = g.w
		const h = g.h
		const c = g.colors
		ctx.fillStyle = c.bg
		ctx.fillRect(0, 0, w, h)

		const pad = { left: 54, right: 20, top: 28, bottom: 32 }
		const pw = Math.max(20, w - pad.left - pad.right)
		const ph = Math.max(20, h - pad.top - pad.bottom)
		const seriesColor = direction === 'fwd' ? c.blue : c.red

		const groups = ['Q3', 'Q2', 'Q1']
		const allPts = []
		groups.forEach(function (grp) {
			const rows = (dirTable && dirTable[grp]) || []
			for (let i = 0; i < rows.length; i++) {
				if (rows[i].flow > 0) allPts.push(rows[i])
			}
		})

		ctx.font = '11px -apple-system, sans-serif'
		ctx.fillStyle = c.text
		ctx.fillText((direction === 'fwd' ? '正向' : '反向') + '三锚点误差曲线 (Log10 X)', pad.left, 14)

		if (!allPts.length) {
			ctx.fillStyle = c.axis
			ctx.textAlign = 'center'
			ctx.fillText('暂无三锚点数据', pad.left + pw / 2, pad.top + ph / 2)
			ctx.textAlign = 'left'
			return
		}

		let minLog = Infinity
		let maxLog = -Infinity
		let minY = -1
		let maxY = 1
		for (let i = 0; i < allPts.length; i++) {
			const lx = Math.log10(allPts[i].flow)
			if (lx < minLog) minLog = lx
			if (lx > maxLog) maxLog = lx
			const ey = Number(allPts[i].error) || 0
			if (ey < minY) minY = ey
			if (ey > maxY) maxY = ey
		}
		minLog -= 0.12
		maxLog += 0.12
		const yPad = Math.max(0.5, (maxY - minY) * 0.18)
		minY -= yPad
		maxY += yPad

		function sx(flow) { return pad.left + ((Math.log10(flow) - minLog) / (maxLog - minLog)) * pw }
		function sy(err) { return pad.top + ph - ((err - minY) / (maxY - minY)) * ph }

		// Y 网格
		ctx.strokeStyle = c.grid
		ctx.lineWidth = 1
		ctx.font = '10px ui-monospace, monospace'
		ctx.fillStyle = c.axis
		for (let i = 0; i <= 4; i++) {
			const yVal = maxY - ((maxY - minY) * i) / 4
			const y = sy(yVal)
			ctx.beginPath()
			ctx.moveTo(pad.left, y)
			ctx.lineTo(pad.left + pw, y)
			ctx.stroke()
			ctx.textAlign = 'right'
			ctx.fillText(yVal.toFixed(2) + '%', pad.left - 6, y + 3)
		}

		// X 对数刻度线（0.002, 0.005, 0.01, 0.05, 0.5, 2.5, 5）
		const xTicks = [0.002, 0.005, 0.01, 0.05, 0.5, 2.5, 5]
		ctx.textAlign = 'center'
		for (let i = 0; i < xTicks.length; i++) {
			const x = sx(xTicks[i])
			if (x < pad.left || x > pad.left + pw) continue
			ctx.strokeStyle = c.grid
			ctx.beginPath()
			ctx.moveTo(x, pad.top)
			ctx.lineTo(x, pad.top + ph)
			ctx.stroke()
			ctx.fillStyle = c.axis
			ctx.fillText(String(xTicks[i]), x, pad.top + ph + 13)
		}

		// 零线
		if (minY <= 0 && maxY >= 0) {
			const y0 = sy(0)
			ctx.save()
			ctx.strokeStyle = c.axis
			ctx.setLineDash([4, 4])
			ctx.beginPath()
			ctx.moveTo(pad.left, y0)
			ctx.lineTo(pad.left + pw, y0)
			ctx.stroke()
			ctx.restore()
		}

		// 分组连线 + 推算圆点 + 锚点红菱形
		groups.forEach(function (grp) {
			const rows = (dirTable && dirTable[grp]) || []
			if (rows.length >= 2) {
				ctx.strokeStyle = seriesColor
				ctx.lineWidth = 1.5
				ctx.beginPath()
				for (let i = 0; i < rows.length; i++) {
					const x = sx(rows[i].flow)
					const y = sy(Number(rows[i].error) || 0)
					if (i === 0) ctx.moveTo(x, y)
					else ctx.lineTo(x, y)
				}
				ctx.stroke()
			}
			for (let i = 0; i < rows.length; i++) {
				const r = rows[i]
				const x = sx(r.flow)
				const y = sy(Number(r.error) || 0)
				if (r.isAnchor) {
					ctx.fillStyle = c.red
					ctx.strokeStyle = c.text
					ctx.lineWidth = 1.2
					ctx.beginPath()
					ctx.moveTo(x, y - 6)
					ctx.lineTo(x + 6, y)
					ctx.lineTo(x, y + 6)
					ctx.lineTo(x - 6, y)
					ctx.closePath()
					ctx.fill()
					ctx.stroke()
				} else {
					ctx.fillStyle = seriesColor
					ctx.beginPath()
					ctx.arc(x, y, 3.5, 0, Math.PI * 2)
					ctx.fill()
				}
			}
		})

		ctx.fillStyle = c.axis
		ctx.textAlign = 'center'
		ctx.fillText('流速 (m³/h, 对数坐标) · ◆ 红色菱形=实测锚点  ● 圆点=推算点', pad.left + pw / 2, h - 5)
		ctx.textAlign = 'left'
	}

	// =========================================================================
	// DOM 构建器（全部使用 document.createElement + textContent，绝不写拼接 HTML）
	// =========================================================================
	function createWorkbench(deps) {
		const ctrl = createController(deps)
		let hostContainer = null
		let mounted = false
		let unsubChange = null
		let pulseDisplayTimer = null
		let resizeObs = null
		let outsideClickHandler = null
		let keydownHandler = null
		const ui = {}

		const getDoc = function () { return (deps && deps.document) || (typeof document !== 'undefined' ? document : null) }
		const getProto = function () { return (deps && deps.protocol) || root.Ac6dProtocol }
		const getPlatform = function () { return (deps && deps.appPlatform !== undefined) ? deps.appPlatform : root.AppPlatform }
		const getDialog = function () { return (deps && deps.appDialog !== undefined) ? deps.appDialog : root.AppDialog }

		function el(tag, cls, text) {
			const doc = getDoc()
			const node = doc.createElement(tag)
			if (cls) node.className = cls
			if (text != null) node.textContent = String(text)
			return node
		}

		function iconEl(biClass) {
			const i = el('i', 'bi ' + biClass)
			i.setAttribute('aria-hidden', 'true')
			return i
		}

		function mkBtn(text, cls, biIcon, onClick) {
			const b = el('button', 'ac6d-btn' + (cls ? (' ' + cls) : ''))
			b.type = 'button'
			if (biIcon) b.appendChild(iconEl(biIcon))
			if (text) b.appendChild(el('span', '', text))
			if (onClick) b.addEventListener('click', onClick)
			return b
		}

		function clearNode(node) {
			if (!node) return
			while (node.firstChild) node.removeChild(node.firstChild)
		}

		function closePopovers() {
			if (ui.portPop) ui.portPop.hidden = true
			if (ui.authPop) ui.authPop.hidden = true
		}

		// ---- 1. 顶部工具条 ----
		function buildToolbar() {
			const bar = el('div', 'ac6d-toolbar')

			// 端口选择 + 连接
			const gPort = el('div', 'ac6d-tb-group')
			ui.statusDot = el('span', 'ac6d-status-dot')
			gPort.appendChild(ui.statusDot)

			const portWrap = el('div', 'ac6d-pop-wrap')
			ui.portBtn = mkBtn('选择串口', '', 'bi-usb-symbol', function (e) {
				e.stopPropagation()
				if (ctrl.isOpen() || ctrl.isOpening() || ctrl.isClosing() || ctrl.isCloseFailed()) return
				const wantOpen = ui.portPop.hidden
				closePopovers()
				if (wantOpen) {
					ctrl.refreshPorts().then(function () {
						if (ctrl.isOpen() || ctrl.isOpening() || ctrl.isClosing() || ctrl.isCloseFailed()) return
						ui.portPop.hidden = false
					})
				}
			})
			ui.portBtnText = ui.portBtn.querySelector('span')
			portWrap.appendChild(ui.portBtn)

			ui.portPop = el('div', 'ac6d-pop')
			ui.portPop.hidden = true
			const popHead = el('div', 'ac6d-pop-head')
			popHead.appendChild(el('span', '', '可用串口设备'))
			popHead.appendChild(mkBtn('刷新', 'ac6d-btn-sm', 'bi-arrow-clockwise', function () { ctrl.refreshPorts() }))
			ui.portPop.appendChild(popHead)
			ui.portList = el('div', 'ac6d-port-list')
			ui.portPop.appendChild(ui.portList)
			const popFoot = el('div', 'ac6d-pop-foot')
			popFoot.appendChild(el('span', 'ac6d-muted', '自动避开通信调试/功耗分析占用'))
			ui.authPortBtn = mkBtn('授权新端口', 'ac6d-btn-sm ac6d-btn-primary', 'bi-plus-lg', function () {
				closePopovers()
				ctrl.requestPort()
			})
			popFoot.appendChild(ui.authPortBtn)
			ui.portPop.appendChild(popFoot)
			portWrap.appendChild(ui.portPop)
			gPort.appendChild(portWrap)

			ui.serialOptsWrap = el('div', 'ac6d-tb-group ac6d-serial-opts')
			ui.baudSel = el('select', 'ac6d-select')
			;[9600, 19200, 38400, 115200].forEach(function (b) {
				const opt = el('option', '', String(b))
				opt.value = String(b)
				ui.baudSel.appendChild(opt)
			})
			ui.baudSel.value = String(ctrl.state.baudRate)
			ui.baudSel.addEventListener('change', function () {
				ctrl.state.baudRate = Number(ui.baudSel.value) || 9600
			})
			ui.paritySel = el('select', 'ac6d-select')
			;[
				{ v: 'none', t: '8N1' },
				{ v: 'even', t: '8E1' },
				{ v: 'odd', t: '8O1' },
			].forEach(function (p) {
				const opt = el('option', '', p.t)
				opt.value = p.v
				ui.paritySel.appendChild(opt)
			})
			ui.paritySel.value = ctrl.state.parity
			ui.paritySel.addEventListener('change', function () {
				ctrl.state.parity = ui.paritySel.value
			})
			ui.serialOptsWrap.appendChild(ui.baudSel)
			ui.serialOptsWrap.appendChild(ui.paritySel)
			gPort.appendChild(ui.serialOptsWrap)

			ui.connBtn = mkBtn('连接', 'ac6d-btn-primary', 'bi-plug', function () {
				if (ctrl.isOpen() || ctrl.isOpening() || ctrl.isCloseFailed()) ctrl.closePort({ manual: true })
				else ctrl.openPort({ baudRate: ctrl.state.baudRate, parity: ctrl.state.parity })
			})
			ui.connBtnText = ui.connBtn.querySelector('span')
			gPort.appendChild(ui.connBtn)
			bar.appendChild(gPort)

			bar.appendChild(el('span', 'ac6d-tb-sep'))

			// 会话开关芯片：A99A 透传 + 附带对时
			const gChips = el('div', 'ac6d-tb-group')
			ui.passthroughChip = el('button', 'ac6d-chip')
			ui.passthroughChip.type = 'button'
			ui.passthroughChip.setAttribute('aria-pressed', 'false')
			ui.passthroughChip.appendChild(iconEl('bi-layers'))
			ui.passthroughChip.appendChild(el('span', '', 'A99A 透传'))
			ui.passthroughChip.title = '开启后下行封装为 A99A Tag=0x07 透传帧，OTA/保存超时自动延长 +3s'
			ui.passthroughChip.addEventListener('click', function () {
				ctrl.state.passthrough = !ctrl.state.passthrough
				ui.passthroughChip.setAttribute('aria-pressed', String(ctrl.state.passthrough))
				ctrl.addLog('SYS', ctrl.state.passthrough ? '已开启 A99A 透传模式（超时自动 +3000ms）' : '已关闭 A99A 透传模式')
			})
			gChips.appendChild(ui.passthroughChip)

			ui.timeSyncChip = el('button', 'ac6d-chip')
			ui.timeSyncChip.type = 'button'
			ui.timeSyncChip.setAttribute('aria-pressed', 'true')
			ui.timeSyncChip.appendChild(iconEl('bi-clock'))
			ui.timeSyncChip.appendChild(el('span', '', '附带对时'))
			ui.timeSyncChip.title = '0x31 / 0x33 查询自动附带 7B BCD RTC 对时'
			ui.timeSyncChip.addEventListener('click', function () {
				ctrl.state.withTimeSync = !ctrl.state.withTimeSync
				ui.timeSyncChip.setAttribute('aria-pressed', String(ctrl.state.withTimeSync))
			})
			gChips.appendChild(ui.timeSyncChip)
			bar.appendChild(gChips)

			bar.appendChild(el('span', 'ac6d-tb-sep'))

			// 设备身份与认证状态条
			const gId = el('div', 'ac6d-tb-group')
			const idPill = el('div', 'ac6d-id-pill')
			idPill.appendChild(el('span', '', '唯一号'))
			ui.idUid = el('span', 'ac6d-id-val', '--')
			idPill.appendChild(ui.idUid)
			idPill.appendChild(el('span', '', '版本'))
			ui.idVer = el('span', 'ac6d-id-val', '--')
			idPill.appendChild(ui.idVer)
			ui.idMode = el('span', 'ac6d-badge', '模式: --')
			idPill.appendChild(ui.idMode)
			ui.idAuth = el('span', 'ac6d-badge', '认证: 未获取')
			idPill.appendChild(ui.idAuth)
			gId.appendChild(idPill)

			gId.appendChild(mkBtn('读设备 0x33', 'ac6d-btn-sm', 'bi-cpu', function () { ctrl.sendDevInfo() }))

			// 手动认证码覆盖弹出层
			const authWrap = el('div', 'ac6d-pop-wrap')
			authWrap.appendChild(mkBtn('认证码', 'ac6d-btn-sm', 'bi-key', function (e) {
				e.stopPropagation()
				const wantOpen = ui.authPop.hidden
				closePopovers()
				if (wantOpen) ui.authPop.hidden = false
			}))
			ui.authPop = el('div', 'ac6d-pop ac6d-pop-right')
			ui.authPop.hidden = true
			const ah = el('div', 'ac6d-pop-head')
			ah.appendChild(el('span', '', '手动覆盖认证码 (可选)'))
			ui.authPop.appendChild(ah)
			ui.authPop.appendChild(el('div', 'ac6d-muted', '默认自动取设备唯一号后 4B (onlyAddr[3..6])；留空恢复自动。'))
			const authRow = el('div', 'ac6d-row')
			authRow.style.marginTop = '8px'
			ui.manualAuthInput = el('input', 'ac6d-input ac6d-input-mono')
			ui.manualAuthInput.placeholder = '如 12345678'
			authRow.appendChild(ui.manualAuthInput)
			authRow.appendChild(mkBtn('应用', 'ac6d-btn-sm ac6d-btn-primary', '', function () {
				const r = ctrl.setManualAuthCode(ui.manualAuthInput.value)
				if (!r.ok) ctrl.addLog('ERR', r.error)
				else closePopovers()
			}))
			authRow.appendChild(mkBtn('清除', 'ac6d-btn-sm', '', function () {
				ui.manualAuthInput.value = ''
				ctrl.setManualAuthCode('')
				closePopovers()
			}))
			ui.authPop.appendChild(authRow)
			authWrap.appendChild(ui.authPop)
			gId.appendChild(authWrap)
			bar.appendChild(gId)

			bar.appendChild(el('div', 'ac6d-tb-spacer'))

			// 右侧主动作：一键保存全部数据 (JSON)
			ui.saveAllBtn = mkBtn('保存全部数据 (JSON)', 'ac6d-btn-primary', 'bi-download', function () {
				ctrl.startSaveAll()
			})
			ui.saveAllBadge = el('span', 'ac6d-save-badge', '')
			ui.saveAllBtn.appendChild(ui.saveAllBadge)
			bar.appendChild(ui.saveAllBtn)

			return bar
		}

		// ---- 2. 分段导航栏 ----
		function buildSubnav() {
			const nav = el('div', 'ac6d-subnav')
			const seg = el('div', 'ac6d-seg-group')
			ui.tabBtns = {}
			;[
				{ id: 'flow', label: '流量监控', icon: 'bi-activity' },
				{ id: 'calib', label: 'S 曲线校准', icon: 'bi-sliders' },
				{ id: 'anchor', label: '三锚点推算', icon: 'bi-bezier2' },
				{ id: 'params', label: '参数与冻结', icon: 'bi-table' },
				{ id: 'ota', label: '系统与 OTA', icon: 'bi-cloud-arrow-up' },
			].forEach(function (t) {
				const btn = el('button', 'ac6d-seg-btn' + (t.id === ctrl.state.activeTab ? ' active' : ''))
				btn.type = 'button'
				btn.appendChild(iconEl(t.icon))
				btn.appendChild(el('span', '', t.label))
				btn.addEventListener('click', function () { switchTab(t.id) })
				seg.appendChild(btn)
				ui.tabBtns[t.id] = btn
			})
			nav.appendChild(seg)
			ui.subnavHint = el('span', 'ac6d-subnav-hint', '单路独立校表工作台 · AC6D / A99A')
			nav.appendChild(ui.subnavHint)
			return nav
		}

		function switchTab(id) {
			ctrl.state.activeTab = id
			Object.keys(ui.tabBtns).forEach(function (k) {
				ui.tabBtns[k].classList.toggle('active', k === id)
			})
			Object.keys(ui.panes).forEach(function (k) {
				ui.panes[k].classList.toggle('active', k === id)
			})
			redrawVisibleCharts()
		}

		// ---- 3.1 子视图：流量监控 ----
		function buildFlowPane() {
			const pane = el('div', 'ac6d-pane active')

			// 轮询控制条
			const pollCard = el('div', 'ac6d-card')
			const pollRow = el('div', 'ac6d-row')
			pollRow.appendChild(el('span', 'ac6d-muted', '轮询间隔(s)'))
			ui.pollIntervalInput = el('input', 'ac6d-input ac6d-input-mono')
			ui.pollIntervalInput.type = 'number'
			ui.pollIntervalInput.min = '1'
			ui.pollIntervalInput.max = '3600'
			ui.pollIntervalInput.value = '1'
			ui.pollIntervalInput.style.width = '72px'
			pollRow.appendChild(ui.pollIntervalInput)

			pollRow.appendChild(el('span', 'ac6d-muted', '查询指令'))
			ui.pollCmdSel = el('select', 'ac6d-select')
			;[
				{ v: '0x30', t: '0x30 快速查询 (21B)' },
				{ v: '0x31', t: '0x31 完整查询 (51B)' },
			].forEach(function (o) {
				const opt = el('option', '', o.t)
				opt.value = o.v
				ui.pollCmdSel.appendChild(opt)
			})
			ui.pollCmdSel.value = ctrl.state.flow.pollCmd
			ui.pollCmdSel.addEventListener('change', function () {
				ctrl.state.flow.pollCmd = ui.pollCmdSel.value
			})
			pollRow.appendChild(ui.pollCmdSel)

			ui.flowStartBtn = mkBtn('开始监控', 'ac6d-btn-primary', 'bi-play-fill', function () {
				ctrl.startFlowMonitor(Number(ui.pollIntervalInput.value) || 1, ui.pollCmdSel.value)
			})
			ui.flowStopBtn = mkBtn('停止监控', 'ac6d-btn-danger', 'bi-stop-fill', function () {
				ctrl.stopFlowMonitor(false)
			})
			ui.flowStopBtn.disabled = true
			pollRow.appendChild(ui.flowStartBtn)
			pollRow.appendChild(ui.flowStopBtn)
			pollRow.appendChild(mkBtn('单次读取', '', 'bi-arrow-repeat', function () {
				ctrl.sendFlowOnce(ui.pollCmdSel.value)
			}))
			pollCard.appendChild(pollRow)
			pane.appendChild(pollCard)

			// LCD + KPI 双栏布局
			const topGrid = el('div', 'ac6d-grid-main')

			// 左：LCD 卡片 + 报警 + 脉冲计时
			const leftCol = el('div', 'ac6d-pane active')
			const lcdCard = el('div', 'ac6d-lcd-card')
			const lcdHead = el('div', 'ac6d-card-head')
			lcdHead.appendChild(el('h3', 'ac6d-card-title', '数字液晶读数 (LCD)'))
			ui.lcdModeSel = el('select', 'ac6d-select')
			LCD_MODES.forEach(function (m) {
				const opt = el('option', '', m.label)
				opt.value = m.id
				ui.lcdModeSel.appendChild(opt)
			})
			ui.lcdModeSel.value = ctrl.state.flow.lcdMode
			ui.lcdModeSel.addEventListener('change', function () {
				ctrl.state.flow.lcdMode = ui.lcdModeSel.value
				renderFlow()
			})
			lcdHead.appendChild(ui.lcdModeSel)
			lcdCard.appendChild(lcdHead)

			const lcdScreen = el('div', 'ac6d-lcd-screen')
			ui.lcdDigits = el('span', 'ac6d-lcd-digits', '0.00000')
			ui.lcdUnit = el('span', 'ac6d-lcd-unit', 'm³')
			lcdScreen.appendChild(ui.lcdDigits)
			lcdScreen.appendChild(ui.lcdUnit)
			lcdCard.appendChild(lcdScreen)

			const lcdMeta = el('div', 'ac6d-lcd-meta')
			ui.lcdGuardInfo = el('span', '', '4x 象限插值余数: 0 · 防回退已启用')
			lcdMeta.appendChild(ui.lcdGuardInfo)
			lcdMeta.appendChild(mkBtn('重置防回退基准', 'ac6d-btn-sm', 'bi-arrow-counterclockwise', function () {
				ctrl.resetAntiRollback()
			}))
			lcdCard.appendChild(lcdMeta)

			// 4 项报警徽章
			const alarmRow = el('div', 'ac6d-alarm-strip')
			ui.alarmBadges = {}
			;[
				{ bit: 0x01, label: '低电压' },
				{ bit: 0x02, label: '磁干扰' },
				{ bit: 0x04, label: '晶振失效' },
				{ bit: 0x08, label: 'Flash失败' },
			].forEach(function (a) {
				const b = el('span', 'ac6d-badge', a.label + ': 正常')
				b.dataset.tone = 'ok'
				ui.alarmBadges[a.bit] = b
				alarmRow.appendChild(b)
			})
			lcdCard.appendChild(alarmRow)
			leftCol.appendChild(lcdCard)

			// 脉冲计时窗口
			const ptCard = el('div', 'ac6d-card')
			const ptHead = el('div', 'ac6d-card-head')
			ptHead.appendChild(el('h3', 'ac6d-card-title', '脉冲时间测量 (脉冲计时)'))
			const ptBtns = el('div', 'ac6d-row')
			ptBtns.appendChild(mkBtn('手动起始', 'ac6d-btn-sm ac6d-btn-primary', 'bi-play', function () { ctrl.pulseTimingManualStart() }))
			ptBtns.appendChild(mkBtn('自动起始', 'ac6d-btn-sm', 'bi-lightning', function () { ctrl.pulseTimingAutoStart() }))
			ptBtns.appendChild(mkBtn('结束', 'ac6d-btn-sm', 'bi-stop', function () { ctrl.pulseTimingStop() }))
			ptBtns.appendChild(mkBtn('清零', 'ac6d-btn-sm', 'bi-eraser', function () { ctrl.pulseTimingClear() }))
			ptHead.appendChild(ptBtns)
			ptCard.appendChild(ptHead)

			const ptGrid = el('div', 'ac6d-timing-grid')
			ui.ptVals = {}
			;[
				{ k: 't0', label: 'T0 (s)' },
				{ k: 't1', label: 'T1 (s)' },
				{ k: 'delta', label: 'Δt (s)' },
				{ k: 'count', label: '脉冲计数' },
				{ k: 'dir', label: '方向' },
			].forEach(function (item) {
				const box = el('div', 'ac6d-kpi')
				box.appendChild(el('span', 'ac6d-kpi-k', item.label))
				const val = el('span', 'ac6d-kpi-v', '--')
				ui.ptVals[item.k] = val
				box.appendChild(val)
				ptGrid.appendChild(box)
			})
			ptCard.appendChild(ptGrid)
			leftCol.appendChild(ptCard)
			topGrid.appendChild(leftCol)

			// 右：遥测 KPI 网格
			const kpiCard = el('div', 'ac6d-card')
			const kpiHead = el('div', 'ac6d-card-head')
			kpiHead.appendChild(el('h3', 'ac6d-card-title', '实时计量遥测'))
			ui.flowDeviceTime = el('span', 'ac6d-muted', '设备时间: --')
			kpiHead.appendChild(ui.flowDeviceTime)
			kpiCard.appendChild(kpiHead)

			const kpiGrid = el('div', 'ac6d-kpi-grid')
			ui.kpis = {}
			;[
				{ id: 'posVol', label: '正累计体积', v: '0.000000 m³', sub: '0 uL' },
				{ id: 'revVol', label: '反累计体积', v: '0.000000 m³', sub: '0 uL' },
				{ id: 'netVol', label: '净累计体积', v: '0.000000 m³', sub: '0 uL' },
				{ id: 'flowRate', label: '瞬时流速', v: '0.0 L/h', sub: '0.0000 m³/h' },
				{ id: 'posPulse', label: '正累计脉冲', v: '0', sub: '净脉冲: 0' },
				{ id: 'revPulse', label: '反累计脉冲', v: '0', sub: '间隔: 0 ms' },
				{ id: 'flowDir', label: '水流方向与余数', v: '停水 / 正流', sub: '余数 0/4' },
				{ id: 'runMode', label: '运行模式', v: '--', sub: '脉冲当量 -- uL' },
				{ id: 'tempVolt', label: '水温 / 电压', v: '-- °C', sub: '-- V' },
			].forEach(function (k) {
				const box = el('div', 'ac6d-kpi')
				box.appendChild(el('span', 'ac6d-kpi-k', k.label))
				const v = el('span', 'ac6d-kpi-v', k.v)
				const sub = el('span', 'ac6d-kpi-sub', k.sub)
				ui.kpis[k.id] = { v: v, sub: sub }
				box.appendChild(v)
				box.appendChild(sub)
				kpiGrid.appendChild(box)
			})
			kpiCard.appendChild(kpiGrid)
			topGrid.appendChild(kpiCard)
			pane.appendChild(topGrid)

			// 双轴实时流量曲线
			const chartCard = el('div', 'ac6d-card')
			const chartHead = el('div', 'ac6d-card-head')
			chartHead.appendChild(el('h3', 'ac6d-card-title', '双轴实时流量曲线（最多 120 点）'))
			chartHead.appendChild(mkBtn('清空曲线', 'ac6d-btn-sm', 'bi-trash', function () { ctrl.clearFlowHistory() }))
			chartCard.appendChild(chartHead)
			const cWrap = el('div', 'ac6d-chart-wrap')
			ui.flowCanvas = el('canvas', 'ac6d-canvas')
			cWrap.appendChild(ui.flowCanvas)
			chartCard.appendChild(cWrap)
			pane.appendChild(chartCard)

			return pane
		}

		// ---- 3.2 子视图：S 曲线校准 ----
		function buildCalibPane() {
			const pane = el('div', 'ac6d-pane')

			// 共享头部操作栏
			const topCard = el('div', 'ac6d-card')
			const headRow = el('div', 'ac6d-row')
			headRow.appendChild(mkBtn('0x40 读取校准表', 'ac6d-btn-primary', 'bi-download', function () { ctrl.sendCalibRead() }))
			headRow.appendChild(mkBtn('全部计算新系数', '', 'bi-calculator', function () { ctrl.calcAllNewCoeffs() }))
			headRow.appendChild(mkBtn('0x41 写入全部校准系数', 'ac6d-btn-success', 'bi-upload', function () { ctrl.writeAllCalibCoeffs() }))
			headRow.appendChild(mkBtn('导入曲线 JSON', '', 'bi-folder2-open', function () {
				ui.calibImportInput.value = ''
				ui.calibImportInput.click()
			}))
			headRow.appendChild(mkBtn('导出曲线 JSON', '', 'bi-save', function () {
				const obj = ctrl.exportCalibJsonObject()
				const name = (ctrl.state.device.onlyAddrHex || '未知设备') + '曲线.json'
				saveFileViaPlatform(name, JSON.stringify(obj, null, 2), 'application/json;charset=utf-8', getPlatform(), getDoc())
			}))
			ui.calibImportInput = el('input')
			ui.calibImportInput.type = 'file'
			ui.calibImportInput.accept = '.json,application/json'
			ui.calibImportInput.hidden = true
			ui.calibImportInput.addEventListener('change', function () {
				const f = ui.calibImportInput.files && ui.calibImportInput.files[0]
				if (!f) return
				f.text().then(function (txt) {
					try { ctrl.importCalibJsonObject(JSON.parse(txt)) } catch (e) { ctrl.addLog('ERR', '曲线 JSON 解析失败: ' + e.message) }
				})
			})
			headRow.appendChild(ui.calibImportInput)

			ui.calibStatusBadge = el('span', 'ac6d-badge', '等待读取')
			headRow.appendChild(ui.calibStatusBadge)
			topCard.appendChild(headRow)

			// 脉冲当量与有效点数
			const eqGrid = el('div', 'ac6d-field-grid')
			eqGrid.style.marginTop = '10px'
			ui.calibEqInputs = {}
			;[
				{ k: 'meterPulseEq', label: '计量脉冲当量 (uL/脉冲)' },
				{ k: 'calibPulseEq', label: '校准脉冲当量 (uL/脉冲)' },
				{ k: 'commPulseEq', label: '上报脉冲当量 (uL/脉冲)' },
				{ k: 'fwdCount', label: '正向有效点数 (<=20)' },
				{ k: 'revCount', label: '反向有效点数 (<=20)' },
			].forEach(function (f) {
				const box = el('div', 'ac6d-field')
				box.appendChild(el('label', '', f.label))
				const inp = el('input', 'ac6d-input ac6d-input-mono')
				inp.type = 'number'
				inp.value = String(ctrl.state.calib[f.k])
				inp.addEventListener('change', function () {
					let v = Number(inp.value) || 0
					if (f.k === 'fwdCount' || f.k === 'revCount') v = Math.max(0, Math.min(20, Math.round(v)))
					ctrl.state.calib[f.k] = v
					renderCalib()
				})
				ui.calibEqInputs[f.k] = inp
				box.appendChild(inp)
				eqGrid.appendChild(box)
			})
			topCard.appendChild(eqGrid)

			// 方向视图切换
			const dirRow = el('div', 'ac6d-row')
			dirRow.style.marginTop = '10px'
			const dirSeg = el('div', 'ac6d-seg-group')
			ui.calibDirBtns = {}
			;[
				{ id: 'fwd', label: '正向 20 点' },
				{ id: 'rev', label: '反向 20 点' },
				{ id: 'dual', label: '双栏对照' },
			].forEach(function (m) {
				const b = el('button', 'ac6d-seg-btn' + (m.id === ctrl.state.calibViewMode ? ' active' : ''))
				b.type = 'button'
				b.textContent = m.label
				b.addEventListener('click', function () {
					ctrl.state.calibViewMode = m.id
					renderCalib()
				})
				dirSeg.appendChild(b)
				ui.calibDirBtns[m.id] = b
			})
			dirRow.appendChild(dirSeg)
			topCard.appendChild(dirRow)
			pane.appendChild(topCard)

			// 20 点可编辑表（正向 / 反向）
			ui.calibTablesWrap = el('div', '')
			ui.calibRows = { fwd: [], rev: [] }
			ui.calibTableCards = {}

			function makeCalibTableCard(dir, title) {
				const card = el('div', 'ac6d-card')
				const ch = el('div', 'ac6d-card-head')
				ch.appendChild(el('h3', 'ac6d-card-title', title))
				card.appendChild(ch)
				const tw = el('div', 'ac6d-table-wrap')
				const tbl = el('table', 'ac6d-table')
				const thead = el('thead')
				const hr = el('tr')
				;['#', '脉冲间隔(ms)', '推算流速(L/h)', '当前系数', '实测误差(%)', '状态', '新系数', '操作'].forEach(function (h) {
					hr.appendChild(el('th', '', h))
				})
				thead.appendChild(hr)
				tbl.appendChild(thead)
				const tbody = el('tbody')
				for (let i = 0; i < 20; i++) {
					const tr = el('tr')
					tr.appendChild(el('td', '', String(i + 1)))

					const ptInp = el('input', 'ac6d-input ac6d-input-xs ac6d-input-mono')
					ptInp.type = 'number'
					ptInp.style.width = '72px'
					const tdPt = el('td')
					tdPt.appendChild(ptInp)
					tr.appendChild(tdPt)

					const tdFlow = el('td', 'ac6d-input-mono', '--')
					tr.appendChild(tdFlow)

					const cfInp = el('input', 'ac6d-input ac6d-input-xs ac6d-input-mono')
					cfInp.type = 'number'
					cfInp.style.width = '72px'
					const tdCf = el('td')
					tdCf.appendChild(cfInp)
					tr.appendChild(tdCf)

					const errInp = el('input', 'ac6d-input ac6d-input-xs ac6d-input-mono')
					errInp.type = 'number'
					errInp.step = '0.01'
					errInp.style.width = '72px'
					const tdErr = el('td')
					tdErr.appendChild(errInp)
					tr.appendChild(tdErr)

					const tdGrade = el('td', '', '--')
					tr.appendChild(tdGrade)

					const newInp = el('input', 'ac6d-input ac6d-input-xs ac6d-input-mono')
					newInp.type = 'number'
					newInp.style.width = '72px'
					const tdNew = el('td')
					tdNew.appendChild(newInp)
					tr.appendChild(tdNew)

					const tdOp = el('td')
					tdOp.appendChild(mkBtn('写入', 'ac6d-btn-sm', '', (function (d, idx) {
						return function () { ctrl.writeSingleCoeff(d, idx) }
					})(dir, i)))
					tr.appendChild(tdOp)

					;(function (d, idx) {
						const pKey = d === 'fwd' ? 'fwdPoints' : 'revPoints'
						const cKey = d === 'fwd' ? 'fwdCoeffs' : 'revCoeffs'
						const eKey = d === 'fwd' ? 'fwdErrors' : 'revErrors'
						const nKey = d === 'fwd' ? 'fwdNewCoeffs' : 'revNewCoeffs'
						ptInp.addEventListener('change', function () {
							ctrl.state.calib[pKey][idx] = Number(ptInp.value) || 0
							renderCalib()
						})
						cfInp.addEventListener('change', function () {
							ctrl.state.calib[cKey][idx] = Number(cfInp.value) || 10000
							renderCalib()
						})
						errInp.addEventListener('change', function () {
							const ev = Number(errInp.value) || 0
							ctrl.state.calib[eKey][idx] = ev
							const proto = getProto()
							if (proto && proto.calcNewCoeff) {
								ctrl.state.calib[nKey][idx] = proto.calcNewCoeff(ctrl.state.calib[cKey][idx], ev)
							}
							renderCalib()
						})
						newInp.addEventListener('change', function () {
							const raw = newInp.value.trim()
							ctrl.state.calib[nKey][idx] = raw === '' ? null : (Number(raw) || 0)
						})
					})(dir, i)

					tbody.appendChild(tr)
					ui.calibRows[dir].push({ ptInp: ptInp, tdFlow: tdFlow, cfInp: cfInp, errInp: errInp, tdGrade: tdGrade, newInp: newInp })
				}
				tbl.appendChild(tbody)
				tw.appendChild(tbl)
				card.appendChild(tw)
				return card
			}

			ui.calibTableCards.fwd = makeCalibTableCard('fwd', '正向 S 曲线校准表 (20 点)')
			ui.calibTableCards.rev = makeCalibTableCard('rev', '反向 S 曲线校准表 (20 点)')
			ui.calibTablesWrap.appendChild(ui.calibTableCards.fwd)
			ui.calibTablesWrap.appendChild(ui.calibTableCards.rev)
			pane.appendChild(ui.calibTablesWrap)

			// S 曲线偏差图
			const chartCard = el('div', 'ac6d-card')
			const ch = el('div', 'ac6d-card-head')
			ch.appendChild(el('h3', 'ac6d-card-title', 'S 曲线偏差分布图 (X=流速 L/h, Y=偏差%)'))
			chartCard.appendChild(ch)
			const cw = el('div', 'ac6d-chart-wrap')
			ui.calibCanvas = el('canvas', 'ac6d-canvas')
			cw.appendChild(ui.calibCanvas)
			chartCard.appendChild(cw)
			pane.appendChild(chartCard)

			return pane
		}

		// ---- 3.3 子视图：三锚点推算 ----
		function buildAnchorPane() {
			const pane = el('div', 'ac6d-pane')

			const barCard = el('div', 'ac6d-card')
			const row = el('div', 'ac6d-row')
			const dirSeg = el('div', 'ac6d-seg-group')
			ui.anchorDirBtns = {}
			;[
				{ id: 'fwd', label: '正向' },
				{ id: 'rev', label: '反向' },
			].forEach(function (d) {
				const b = el('button', 'ac6d-seg-btn' + (d.id === ctrl.state.anchor.direction ? ' active' : ''))
				b.type = 'button'
				b.textContent = d.label
				b.addEventListener('click', function () {
					ctrl.state.anchor.direction = d.id
					renderAnchor()
				})
				dirSeg.appendChild(b)
				ui.anchorDirBtns[d.id] = b
			})
			row.appendChild(dirSeg)

			row.appendChild(mkBtn('0x40 读取当前系数', 'ac6d-btn-primary', 'bi-download', function () { ctrl.sendCalibRead() }))
			row.appendChild(mkBtn('推算并计算新系数', '', 'bi-calculator', function () { ctrl.inferAndCalcAnchor(ctrl.state.anchor.direction) }))
			row.appendChild(mkBtn('同步至 S 曲线并写入全部系数', 'ac6d-btn-success', 'bi-upload', function () { ctrl.syncAnchorAndWriteAll() }))
			row.appendChild(mkBtn('保存锚点配置', '', 'bi-save', function () {
				const cfg = ctrl.saveAnchorConfigToStorage()
				saveFileViaPlatform('anchor_curve.json', JSON.stringify(cfg, null, 2), 'application/json;charset=utf-8', getPlatform(), getDoc())
				ctrl.addLog('SYS', '已保存三锚点配置到本地存储并导出 JSON')
			}))
			row.appendChild(mkBtn('导入锚点配置', '', 'bi-folder2-open', function () {
				ui.anchorImportInput.value = ''
				ui.anchorImportInput.click()
			}))
			ui.anchorImportInput = el('input')
			ui.anchorImportInput.type = 'file'
			ui.anchorImportInput.accept = '.json,application/json'
			ui.anchorImportInput.hidden = true
			ui.anchorImportInput.addEventListener('change', function () {
				const f = ui.anchorImportInput.files && ui.anchorImportInput.files[0]
				if (!f) return
				f.text().then(function (txt) {
					try { ctrl.importAnchorConfigObject(JSON.parse(txt)) } catch (e) { ctrl.addLog('ERR', '锚点 JSON 解析失败: ' + e.message) }
				})
			})
			row.appendChild(ui.anchorImportInput)
			barCard.appendChild(row)
			pane.appendChild(barCard)

			// 左表右图
			const mainGrid = el('div', 'ac6d-grid-main')
			ui.anchorTablesCol = el('div', 'ac6d-pane active')
			mainGrid.appendChild(ui.anchorTablesCol)

			const chartCard = el('div', 'ac6d-card')
			const ch = el('div', 'ac6d-card-head')
			ch.appendChild(el('h3', 'ac6d-card-title', 'Log-X 三锚点误差曲线'))
			chartCard.appendChild(ch)
			const cw = el('div', 'ac6d-chart-wrap ac6d-chart-wrap-tall')
			ui.anchorCanvas = el('canvas', 'ac6d-canvas')
			cw.appendChild(ui.anchorCanvas)
			chartCard.appendChild(cw)
			mainGrid.appendChild(chartCard)

			pane.appendChild(mainGrid)
			return pane
		}

		// ---- 3.4 子视图：参数与冻结 ----
		function buildParamsPane() {
			const pane = el('div', 'ac6d-pane')

			// 基础参数 0x42(0) / 0x43
			const baseCard = el('div', 'ac6d-card')
			const baseHead = el('div', 'ac6d-card-head')
			baseHead.appendChild(el('h3', 'ac6d-card-title', '基础参数 (0x42 type=0 / 0x43)'))
			const baseActions = el('div', 'ac6d-row')
			ui.layoutBadge = el('span', 'ac6d-badge', '检测布局: V2.7 40B')
			baseActions.appendChild(ui.layoutBadge)
			ui.layoutSel = el('select', 'ac6d-select')
			;[
				{ v: 'auto', t: '自动跟随设备 (V2.7 40B / 旧版 48B)' },
				{ v: 'v27-40', t: 'V2.7 40B' },
				{ v: 'legacy-48', t: '旧版 48B' },
				{ v: 'legacy-24', t: '旧版 24B' },
			].forEach(function (o) {
				const opt = el('option', '', o.t)
				opt.value = o.v
				ui.layoutSel.appendChild(opt)
			})
			ui.layoutSel.addEventListener('change', function () {
				ctrl.state.params.layoutMode = ui.layoutSel.value
				renderParams()
			})
			baseActions.appendChild(ui.layoutSel)
			baseActions.appendChild(mkBtn('读取基础参数', 'ac6d-btn-primary', 'bi-download', function () { ctrl.sendParamRead(0) }))
			ui.paramWriteBaseBtn = mkBtn('写入基础参数 (0x43)', 'ac6d-btn-success', 'bi-upload', function () {
				const b = collectBaseParamInputs()
				ctrl.sendParamWriteBase(b)
			})
			baseActions.appendChild(ui.paramWriteBaseBtn)
			baseHead.appendChild(baseActions)
			baseCard.appendChild(baseHead)

			const fg = el('div', 'ac6d-field-grid')
			ui.baseInputs = {}
			;[
				{ k: 'onlyAddrHex', label: '设备唯一号 onlyAddr (只读)', ro: true },
				{ k: 'initFlag', label: '初始化标志 (只读)', ro: true },
				{ k: 'crcHex', label: '结构体 CRC (只读)', ro: true },
				{ k: 'voltageAlarmV', label: '电压报警阈值 (V)', type: 'number', step: '0.01' },
				{ k: 'sampleIntervalMin', label: '采集间隔 (min)', type: 'number' },
				{ k: 'baseDegree', label: '底度值 (脉冲数)', type: 'text' },
				{ k: 'meterPulseEq', label: '计量脉冲当量 (uL/脉冲)', type: 'number' },
				{ k: 'calibPulseEq', label: '校准脉冲当量 (uL/脉冲)', type: 'number' },
				{ k: 'commPulseEq', label: '上报脉冲当量 (uL/脉冲)', type: 'number' },
				{ k: 'calibEnable', label: '校准使能', kind: 'select', opts: [{ v: '0', t: '0 - 关闭' }, { v: '1', t: '1 - 开启' }] },
				{ k: 'calibDirection', label: '校准方向', kind: 'select', opts: [{ v: '0', t: '0 - 正向' }, { v: '1', t: '1 - 反向' }] },
				{ k: 'tempCompCoef', label: '温补系数 (×10000)', type: 'number' },
				{ k: 'tempCompBaseC', label: '基准温度 (°C)', type: 'number', step: '0.1' },
			].forEach(function (f) {
				const box = el('div', 'ac6d-field')
				box.appendChild(el('label', '', f.label))
				let inp
				if (f.kind === 'select') {
					inp = el('select', 'ac6d-select')
					f.opts.forEach(function (o) {
						const opt = el('option', '', o.t)
						opt.value = o.v
						inp.appendChild(opt)
					})
				} else {
					inp = el('input', 'ac6d-input ac6d-input-mono')
					inp.type = f.type || 'text'
					if (f.step) inp.step = f.step
					if (f.ro) inp.readOnly = true
				}
				ui.baseInputs[f.k] = inp
				box.appendChild(inp)
				fg.appendChild(box)
			})
			baseCard.appendChild(fg)
			pane.appendChild(baseCard)

			// 计量结构体 (0x42 type=1) & 报警参数 (0x42 type=2)
			const subGrid = el('div', 'ac6d-grid-2')
			const meterCard = el('div', 'ac6d-card')
			const mh = el('div', 'ac6d-card-head')
			mh.appendChild(el('h3', 'ac6d-card-title', '计量结构体 (0x42 type=1)'))
			mh.appendChild(mkBtn('读取计量结构体', 'ac6d-btn-sm ac6d-btn-primary', 'bi-download', function () { ctrl.sendParamRead(1) }))
			meterCard.appendChild(mh)
			ui.meterKv = el('div', 'ac6d-kv-list')
			ui.meterKv.appendChild(el('div', 'ac6d-muted', '点击「读取计量结构体」获取数据'))
			meterCard.appendChild(ui.meterKv)
			subGrid.appendChild(meterCard)

			const alarmCard = el('div', 'ac6d-card')
			const alh = el('div', 'ac6d-card-head')
			alh.appendChild(el('h3', 'ac6d-card-title', '报警记录 (0x42 type=2)'))
			alh.appendChild(mkBtn('读取报警记录', 'ac6d-btn-sm ac6d-btn-primary', 'bi-download', function () { ctrl.sendParamRead(2) }))
			alarmCard.appendChild(alh)
			ui.alarmKv = el('div', 'ac6d-kv-list')
			ui.alarmKv.appendChild(el('div', 'ac6d-muted', '点击「读取报警记录」获取数据'))
			alarmCard.appendChild(ui.alarmKv)
			subGrid.appendChild(alarmCard)
			pane.appendChild(subGrid)

			// 日冻结数据 (0x37)
			const freezeCard = el('div', 'ac6d-card')
			const fh = el('div', 'ac6d-card-head')
			fh.appendChild(el('h3', 'ac6d-card-title', '日冻结数据 (0x37)'))
			const fRow = el('div', 'ac6d-row')
			fRow.appendChild(el('span', 'ac6d-muted', '起始索引 (0~61)'))
			ui.freezeIdxInput = el('input', 'ac6d-input ac6d-input-mono')
			ui.freezeIdxInput.type = 'number'
			ui.freezeIdxInput.min = '0'
			ui.freezeIdxInput.max = '61'
			ui.freezeIdxInput.value = '0'
			ui.freezeIdxInput.style.width = '68px'
			fRow.appendChild(ui.freezeIdxInput)
			ui.freezeOneBtn = mkBtn('读取单页', 'ac6d-btn-sm', 'bi-file-earmark-text', function () {
				ctrl.sendDailyFreezePage(Number(ui.freezeIdxInput.value) || 0)
			})
			ui.freezeAllBtn = mkBtn('自动翻页读取全部', 'ac6d-btn-sm ac6d-btn-primary', 'bi-collection', function () {
				ctrl.startDailyFreezeAll()
			})
			fRow.appendChild(ui.freezeOneBtn)
			fRow.appendChild(ui.freezeAllBtn)
			fRow.appendChild(mkBtn('导出 CSV', 'ac6d-btn-sm', 'bi-filetype-csv', function () {
				const csv = ctrl.buildFreezeCsv()
				const name = (ctrl.state.device.onlyAddrHex || 'ac6d') + '_daily_freeze.csv'
				saveFileViaPlatform(name, csv, 'text/csv;charset=utf-8', getPlatform(), getDoc())
			}))
			ui.freezeCountBadge = el('span', 'ac6d-badge', '0 条')
			fRow.appendChild(ui.freezeCountBadge)
			fh.appendChild(fRow)
			freezeCard.appendChild(fh)

			const ftw = el('div', 'ac6d-table-wrap')
			ftw.style.maxHeight = '240px'
			const ftbl = el('table', 'ac6d-table')
			const fthead = el('thead')
			const fhr = el('tr')
			;['序号', '日期', '净累计(L)', '反流(L)', '正流(L)', '最大流速(m³/h)', '平均温度(°C)', '报警', 'CRC'].forEach(function (h) {
				fhr.appendChild(el('th', '', h))
			})
			fthead.appendChild(fhr)
			ftbl.appendChild(fthead)
			ui.freezeTbody = el('tbody')
			ftbl.appendChild(ui.freezeTbody)
			ftw.appendChild(ftbl)
			freezeCard.appendChild(ftw)
			pane.appendChild(freezeCard)

			// 设备内部日志 (0x44)
			const dlogCard = el('div', 'ac6d-card')
			const dlh = el('div', 'ac6d-card-head')
			dlh.appendChild(el('h3', 'ac6d-card-title', '设备内部日志 (0x44 · 需认证)'))
			const dlRow = el('div', 'ac6d-row')
			ui.devLogTypeSel = el('select', 'ac6d-select')
			;[
				{ v: '0', t: '系统 (0)' },
				{ v: '1', t: '复位 (1)' },
				{ v: '2', t: '升级 (2)' },
				{ v: '3', t: '报警 (3)' },
				{ v: '255', t: '全部 (0xFF)' },
			].forEach(function (o) {
				const opt = el('option', '', o.t)
				opt.value = o.v
				ui.devLogTypeSel.appendChild(opt)
			})
			ui.devLogTypeSel.value = '255'
			dlRow.appendChild(ui.devLogTypeSel)
			dlRow.appendChild(mkBtn('读取日志', 'ac6d-btn-sm ac6d-btn-primary', 'bi-journal-text', function () {
				ctrl.sendLogRead(Number(ui.devLogTypeSel.value))
			}))
			dlh.appendChild(dlRow)
			dlogCard.appendChild(dlh)

			const dltw = el('div', 'ac6d-table-wrap')
			dltw.style.maxHeight = '180px'
			const dltbl = el('table', 'ac6d-table')
			const dlthead = el('thead')
			const dlhr = el('tr')
			;['类型', '时间', '摘要', 'CRC'].forEach(function (h) { dlhr.appendChild(el('th', '', h)) })
			dlthead.appendChild(dlhr)
			dltbl.appendChild(dlthead)
			ui.devLogTbody = el('tbody')
			dltbl.appendChild(ui.devLogTbody)
			dltw.appendChild(dltbl)
			dlogCard.appendChild(dltw)
			pane.appendChild(dlogCard)

			return pane
		}

		function collectBaseParamInputs() {
			const i = ui.baseInputs
			return {
				onlyAddrHex: i.onlyAddrHex.value.trim(),
				voltageAlarmV: Number(i.voltageAlarmV.value) || 0,
				sampleIntervalMin: Number(i.sampleIntervalMin.value) || 60,
				baseDegree: i.baseDegree.value.trim() || '0',
				meterPulseEq: Number(i.meterPulseEq.value) || 17085,
				calibPulseEq: Number(i.calibPulseEq.value) || 1000,
				commPulseEq: Number(i.commPulseEq.value) || 60000,
				calibEnable: Number(i.calibEnable.value) || 0,
				calibDirection: Number(i.calibDirection.value) || 0,
				tempCompCoef: Number(i.tempCompCoef.value) || 10000,
				tempCompBaseC: Number(i.tempCompBaseC.value) || 20.0,
			}
		}

		// ---- 3.5 子视图：系统与 OTA ----
		function buildOtaPane() {
			const pane = el('div', 'ac6d-pane')

			// 固件 OTA 升级卡片
			const otaCard = el('div', 'ac6d-card')
			const oh = el('div', 'ac6d-card-head')
			oh.appendChild(el('h3', 'ac6d-card-title', '固件 OTA 升级 (0x20~0x26 · APP2 0x8000 / 24KB)'))
			ui.otaStatusBadge = el('span', 'ac6d-badge', '未开始')
			oh.appendChild(ui.otaStatusBadge)
			otaCard.appendChild(oh)

			// 文件选择与拖拽区
			const dz = el('div', 'ac6d-dropzone')
			const dzInfo = el('div', '')
			ui.otaFileLabel = el('div', '', '尚未选择固件文件（支持原始 App.bin 或已带 16B "9091" 固件头的 .bin，可拖拽至此）')
			ui.otaMetaLabel = el('div', 'ac6d-muted', 'APP2 地址 0x8000 ~ 0xDFFF，上限 24576B (24KB)')
			dzInfo.appendChild(ui.otaFileLabel)
			dzInfo.appendChild(ui.otaMetaLabel)
			dz.appendChild(dzInfo)

			const dzBtns = el('div', 'ac6d-row')
			ui.otaFileInput = el('input')
			ui.otaFileInput.type = 'file'
			ui.otaFileInput.accept = '.bin,application/octet-stream'
			ui.otaFileInput.hidden = true
			ui.otaFileInput.addEventListener('change', function () {
				const f = ui.otaFileInput.files && ui.otaFileInput.files[0]
				if (!f) return
				f.arrayBuffer().then(function (ab) {
					ctrl.loadFirmwareBytes(new Uint8Array(ab), f.name)
				})
			})
			dzBtns.appendChild(ui.otaFileInput)
			dzBtns.appendChild(mkBtn('选择固件 (.bin)', 'ac6d-btn-primary', 'bi-folder2-open', function () {
				ui.otaFileInput.value = ''
				ui.otaFileInput.click()
			}))
			dzBtns.appendChild(mkBtn('生成带 16B Header 固件 (.bin)', '', 'bi-file-earmark-binary', function () {
				const res = ctrl.buildWrappedFirmwareForDownload()
				const dlg = getDialog()
				if (!res.ok) {
					if (dlg && dlg.alert) dlg.alert(res.error, { title: '固件打包提示' })
					return
				}
				saveFileViaPlatform(res.fileName, res.image, 'application/octet-stream', getPlatform(), getDoc())
				ctrl.addLog('SYS', '已生成带 16B Header 固件: ' + res.fileName + ' (' + res.image.length + 'B)')
			}))
			dz.appendChild(dzBtns)

			dz.addEventListener('dragover', function (e) {
				e.preventDefault()
				dz.dataset.drag = 'over'
			})
			dz.addEventListener('dragleave', function () {
				delete dz.dataset.drag
			})
			dz.addEventListener('drop', function (e) {
				e.preventDefault()
				delete dz.dataset.drag
				const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
				if (!f) return
				f.arrayBuffer().then(function (ab) {
					ctrl.loadFirmwareBytes(new Uint8Array(ab), f.name)
				})
			})
			otaCard.appendChild(dz)

			// 升级动作行
			const actRow = el('div', 'ac6d-row')
			actRow.style.marginTop = '10px'
			actRow.appendChild(el('span', 'ac6d-muted', '单包大小'))
			ui.otaChunkSel = el('select', 'ac6d-select')
			;[64, 128, 256, 512].forEach(function (sz) {
				const opt = el('option', '', sz + ' B')
				opt.value = String(sz)
				ui.otaChunkSel.appendChild(opt)
			})
			ui.otaChunkSel.value = '256'
			ui.otaChunkSel.addEventListener('change', function () {
				if (ctrl.state.ota.running) {
					ui.otaChunkSel.value = String(ctrl.state.ota.runChunkSize || ctrl.state.ota.chunkSize)
					return
				}
				ctrl.setOtaChunkSize(Number(ui.otaChunkSel.value) || 256)
			})
			actRow.appendChild(ui.otaChunkSel)

			ui.otaStartBtn = mkBtn('一键自动升级', 'ac6d-btn-success', 'bi-rocket-takeoff', async function () {
				const dlg = getDialog()
				const yes = dlg && dlg.confirm
					? await dlg.confirm('确定开始一键自动 OTA 升级吗？升级期间请勿断开串口。', { title: '确认开始 OTA' })
					: true
				if (!yes) return
				ctrl.startAutoOta({ chunkSize: Number(ui.otaChunkSel.value) || 256 })
			})
			ui.otaAbortBtn = mkBtn('中止/复位状态', 'ac6d-btn-danger', 'bi-x-octagon', function () {
				ctrl.abortOta('手动中止')
			})
			actRow.appendChild(ui.otaStartBtn)
			actRow.appendChild(ui.otaAbortBtn)
			otaCard.appendChild(actRow)

			// 6 步可视化步骤条 + 进度条
			const stepper = el('div', 'ac6d-stepper')
			ui.otaStepEls = []
			OTA_STEPS.forEach(function (st) {
				const box = el('div', 'ac6d-step')
				box.dataset.state = 'idle'
				box.appendChild(el('span', '', 'Step ' + st.idx))
				box.appendChild(el('span', '', st.title))
				stepper.appendChild(box)
				ui.otaStepEls.push(box)
			})
			otaCard.appendChild(stepper)

			const track = el('div', 'ac6d-progress-track')
			ui.otaProgressFill = el('div', 'ac6d-progress-fill')
			track.appendChild(ui.otaProgressFill)
			otaCard.appendChild(track)

			// 可折叠手动单步调试
			const det = el('details', 'ac6d-details')
			det.appendChild(el('summary', '', '手动单步调试 (0x20 / 0x24 / 0x22 / 0x25 / 0x26)'))
			const db = el('div', 'ac6d-details-body')
			const mRow = el('div', 'ac6d-row')
			ui.otaManualBtns = [
				mkBtn('0x20 握手', 'ac6d-btn-sm', '', function () { ctrl.sendManualOtaHandshake() }),
				mkBtn('0x24 擦除 APP2', 'ac6d-btn-sm', '', function () { ctrl.sendManualOtaErase() }),
				mkBtn('0x22 发送当前包并进下一包', 'ac6d-btn-sm', '', function () { ctrl.sendManualOtaChunk(true) }),
				mkBtn('重置手动包号', 'ac6d-btn-sm', '', function () { ctrl.state.ota.manualPacketIndex = 0; renderOta() }),
				mkBtn('0x25 CRC 校验', 'ac6d-btn-sm', '', function () { ctrl.sendManualOtaCrc() }),
				mkBtn('0x26 OTA 完成', 'ac6d-btn-sm', '', function () { ctrl.sendManualOtaFinish() }),
			]
			ui.otaManualBtns.forEach(function (b) { mRow.appendChild(b) })
			ui.otaManualIdxLabel = el('span', 'ac6d-muted', '当前包号: #0')
			mRow.appendChild(ui.otaManualIdxLabel)
			db.appendChild(mRow)
			det.appendChild(db)
			otaCard.appendChild(det)
			pane.appendChild(otaCard)

			// 系统控制卡片
			const sysCard = el('div', 'ac6d-card')
			const sh = el('div', 'ac6d-card-head')
			sh.appendChild(el('h3', 'ac6d-card-title', '系统控制指令'))
			sysCard.appendChild(sh)

			const sysGrid = el('div', 'ac6d-grid-2')

			// 0x35 模式切换 + 0x34 对时
			const c1 = el('div', 'ac6d-card')
			c1.appendChild(el('div', 'ac6d-card-title', '0x35 运行模式切换 & 0x34 RTC 对时'))
			const m1 = el('div', 'ac6d-row')
			m1.style.marginTop = '8px'
			ui.modeSel = el('select', 'ac6d-select')
			;[
				{ v: '0', t: '0 - 强制休眠 (Sleep)' },
				{ v: '1', t: '1 - 快速响应 (Wake)' },
				{ v: '2', t: '2 - 校表模式 (Calib · 需认证)' },
			].forEach(function (o) {
				const opt = el('option', '', o.t)
				opt.value = o.v
				ui.modeSel.appendChild(opt)
			})
			m1.appendChild(ui.modeSel)
			m1.appendChild(mkBtn('切换模式', 'ac6d-btn-primary', 'bi-toggles', function () { ctrl.sendModeSet(Number(ui.modeSel.value)) }))
			m1.appendChild(mkBtn('0x34 专用对时', '', 'bi-clock-history', function () { ctrl.sendTimeSync() }))
			c1.appendChild(m1)
			sysGrid.appendChild(c1)

			// 0x47 单独设置底度
			const c2 = el('div', 'ac6d-card')
			c2.appendChild(el('div', 'ac6d-card-title', '0x47 单独设置底度 (uint64 脉冲 · 需认证)'))
			const m2 = el('div', 'ac6d-row')
			m2.style.marginTop = '8px'
			ui.baseDegInput = el('input', 'ac6d-input ac6d-input-mono')
			ui.baseDegInput.placeholder = '非负整数脉冲数，如 0'
			ui.baseDegInput.value = '0'
			m2.appendChild(ui.baseDegInput)
			m2.appendChild(mkBtn('下发底度', 'ac6d-btn-primary', 'bi-check2-circle', function () { ctrl.sendBaseDegree(ui.baseDegInput.value) }))
			ui.baseDegBadge = el('span', 'ac6d-badge', '')
			ui.baseDegBadge.hidden = true
			m2.appendChild(ui.baseDegBadge)
			c2.appendChild(m2)
			sysGrid.appendChild(c2)

			// 0x32 清除报警标志
			const c3 = el('div', 'ac6d-card')
			c3.appendChild(el('div', 'ac6d-card-title', '0x32 清除报警标志 (需认证)'))
			const m3 = el('div', 'ac6d-row')
			m3.style.marginTop = '8px'
			ui.alarmClearBoxes = []
			;[
				{ bit: 0x01, label: '低电压(bit0)' },
				{ bit: 0x02, label: '磁干扰(bit1)' },
				{ bit: 0x04, label: '晶振(bit2)' },
				{ bit: 0x08, label: 'Flash(bit3)' },
			].forEach(function (a) {
				const lbl = el('label', 'ac6d-check-row')
				const cb = el('input')
				cb.type = 'checkbox'
				cb.checked = true
				lbl.appendChild(cb)
				lbl.appendChild(el('span', '', a.label))
				ui.alarmClearBoxes.push({ bit: a.bit, cb: cb })
				m3.appendChild(lbl)
			})
			m3.appendChild(mkBtn('清除选中报警', 'ac6d-btn-primary', 'bi-shield-check', function () {
				let mask = 0
				ui.alarmClearBoxes.forEach(function (x) { if (x.cb.checked) mask |= x.bit })
				ctrl.sendAlarmClear(mask)
			}))
			c3.appendChild(m3)
			sysGrid.appendChild(c3)

			// 0x36 认证旁路
			const c4 = el('div', 'ac6d-card')
			c4.appendChild(el('div', 'ac6d-card-title', '0x36 认证旁路令牌'))
			const m4 = el('div', 'ac6d-row')
			m4.style.marginTop = '8px'
			ui.bypassInput = el('input', 'ac6d-input ac6d-input-mono')
			ui.bypassInput.placeholder = '32位 HEX，如 12345678'
			m4.appendChild(ui.bypassInput)
			m4.appendChild(mkBtn('设置旁路', 'ac6d-btn-primary', '', function () { ctrl.sendAuthBypass(ui.bypassInput.value) }))
			m4.appendChild(mkBtn('清除 (0x00000000)', '', '', function () { ctrl.sendAuthBypass(0) }))
			c4.appendChild(m4)
			sysGrid.appendChild(c4)

			sysCard.appendChild(sysGrid)

			// 危险操作区
			const dangerBox = el('div', 'ac6d-danger-box')
			dangerBox.style.marginTop = '10px'
			dangerBox.appendChild(el('strong', '', '危险指令（均需认证与二次确认）：'))
			dangerBox.appendChild(mkBtn('0x45 系统复位', 'ac6d-btn-danger', 'bi-bootstrap-reboot', function () { ctrl.sendSystemReset() }))
			dangerBox.appendChild(mkBtn('0x46 恢复数据 (1)', 'ac6d-btn-danger', 'bi-arrow-counterclockwise', function () { ctrl.sendParamReset(1) }))
			dangerBox.appendChild(mkBtn('0x46 恢复参数 (2)', 'ac6d-btn-danger', 'bi-arrow-counterclockwise', function () { ctrl.sendParamReset(2) }))
			dangerBox.appendChild(mkBtn('0x46 恢复出厂 (3)', 'ac6d-btn-danger', 'bi-exclamation-triangle', function () { ctrl.sendParamReset(3) }))
			sysCard.appendChild(dangerBox)

			pane.appendChild(sysCard)
			return pane
		}

		// ---- 4. 底部可折叠通信日志抽屉 ----
		function buildLogDrawer() {
			const drawer = el('div', 'ac6d-log-drawer')
			drawer.dataset.collapsed = String(ctrl.state.logCollapsed)
			ui.logDrawer = drawer

			const bar = el('div', 'ac6d-log-bar')
			const left = el('div', 'ac6d-row')
			ui.logToggleBtn = mkBtn('通信日志', 'ac6d-btn-sm', 'bi-terminal', function () {
				ctrl.state.logCollapsed = !ctrl.state.logCollapsed
				drawer.dataset.collapsed = String(ctrl.state.logCollapsed)
				redrawVisibleCharts()
			})
			left.appendChild(ui.logToggleBtn)
			ui.logCountBadge = el('span', 'ac6d-badge', '0 / ' + LOG_MAX_ROWS)
			left.appendChild(ui.logCountBadge)
			bar.appendChild(left)

			const right = el('div', 'ac6d-row')
			right.appendChild(mkBtn('清空日志', 'ac6d-btn-sm', 'bi-trash', function () { ctrl.clearLogs() }))
			right.appendChild(mkBtn('导出日志 (.txt)', 'ac6d-btn-sm', 'bi-download', function () {
				const txt = ctrl.state.logs.map(function (l) {
					return '[' + l.ts + '] [' + l.dir + '] ' + l.msg + (l.hex ? (' | ' + l.hex) : '')
				}).join('\n')
				saveFileViaPlatform('ac6d_log_' + Date.now() + '.txt', txt, 'text/plain;charset=utf-8', getPlatform(), getDoc())
			}))
			bar.appendChild(right)
			drawer.appendChild(bar)

			const body = el('div', 'ac6d-log-body')
			ui.logList = el('div', 'ac6d-log-list')
			body.appendChild(ui.logList)

			const sendBar = el('div', 'ac6d-log-send')
			ui.customHexInput = el('input', 'ac6d-input ac6d-input-mono')
			ui.customHexInput.placeholder = '输入原始 HEX 帧直接发送，例如 AC 6D 01 FE 02 00 30 11 15 3D'
			ui.customHexInput.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') ctrl.sendCustomHex(ui.customHexInput.value)
			})
			sendBar.appendChild(ui.customHexInput)
			sendBar.appendChild(mkBtn('发送 HEX', 'ac6d-btn-sm ac6d-btn-primary', 'bi-send', function () {
				ctrl.sendCustomHex(ui.customHexInput.value)
			}))
			body.appendChild(sendBar)
			drawer.appendChild(body)

			return drawer
		}

		// ---- 渲染同步函数 ----
		function renderPorts(list) {
			if (!ui.portList) return
			clearNode(ui.portList)
			if (!list || !list.length) {
				ui.portList.appendChild(el('div', 'ac6d-muted', '暂无已授权/在位串口，请点击下方「授权新端口」'))
				return
			}
			list.forEach(function (item) {
				const btn = el('button', 'ac6d-port-item')
				btn.type = 'button'
				btn.disabled = !!item.busyReason
				btn.dataset.selected = String(!!item.selected)
				const left = el('div', '')
				left.appendChild(el('div', '', item.label))
				if (item.wireless) left.appendChild(el('div', 'ac6d-port-meta', '无线透传通道（自动隐藏波特率）'))
				btn.appendChild(left)
				if (item.busyReason) {
					btn.appendChild(el('span', 'ac6d-port-busy', item.busyReason))
				}
				btn.addEventListener('click', function () {
					if (ctrl.selectPort(item.port)) {
						closePopovers()
						renderConnection()
					}
				})
				ui.portList.appendChild(btn)
			})
		}

		function renderConnection() {
			const port = ctrl.getCurrentPort()
			const open = ctrl.isOpen()
			const opening = ctrl.isOpening()
			const closing = ctrl.isClosing()
			const closeFailedState = ctrl.isCloseFailed()
			const busy = open || opening || closing || closeFailedState
			if (ui.statusDot) ui.statusDot.dataset.state = open ? 'open' : (opening ? 'opening' : 'closed')
			if (ui.portBtnText) ui.portBtnText.textContent = port ? describePort(port) : '选择串口'
			if (ui.portBtn) ui.portBtn.disabled = busy
			if (ui.authPortBtn) ui.authPortBtn.disabled = busy
			if (busy && ui.portPop) ui.portPop.hidden = true
			if (ui.serialOptsWrap) {
				ui.serialOptsWrap.hidden = isWirelessPort(port)
			}
			if (ui.baudSel) ui.baudSel.disabled = busy
			if (ui.paritySel) ui.paritySel.disabled = busy
			if (ui.connBtn && ui.connBtnText) {
				ui.connBtnText.textContent = closeFailedState ? '重试断开' : (open ? '断开' : (opening ? '取消连接' : '连接'))
				ui.connBtn.className = 'ac6d-btn ' + ((open || closeFailedState) ? 'ac6d-btn-danger' : 'ac6d-btn-primary')
			}
		}

		function renderDevice() {
			const d = ctrl.state.device
			if (ui.idUid) ui.idUid.textContent = d.onlyAddrHex || '--'
			if (ui.idVer) ui.idVer.textContent = d.firmwareVersion || '--'
			if (ui.idMode) {
				ui.idMode.textContent = '模式: ' + (d.modeText || '--')
				ui.idMode.dataset.tone = d.mode === 2 ? 'info' : ''
			}
			const auth = ctrl.getEffectiveAuthCode()
			if (ui.idAuth) {
				const isManual = d.manualAuthCode != null
				ui.idAuth.textContent = auth != null ? ('认证: ' + (isManual ? '手动覆盖 ' : '已就绪 ') + hex32(auth)) : '认证: 未获取'
				ui.idAuth.dataset.tone = auth != null ? 'ok' : 'warn'
			}
		}

		function renderFlow() {
			const f = ctrl.state.flow
			if (ui.flowStartBtn) ui.flowStartBtn.disabled = f.monitorRunning
			if (ui.flowStopBtn) ui.flowStopBtn.disabled = !f.monitorRunning
			const lcd = ctrl.getLcdReadout()
			if (ui.lcdDigits) ui.lcdDigits.textContent = lcd.value
			if (ui.lcdUnit) ui.lcdUnit.textContent = lcd.unit
			if (ui.lcdGuardInfo) {
				ui.lcdGuardInfo.textContent = '4x 象限插值余数: ' + f.quadRemainder + '/4 · ' + (f.rollbackGuarded ? '防回退已拦截回退' : '防回退保护就绪')
			}
			if (ui.flowDeviceTime) ui.flowDeviceTime.textContent = '设备时间: ' + f.deviceTime
			if (ui.kpis) {
				ui.kpis.posVol.v.textContent = (f.displayPosVolUl / 1e9).toFixed(6) + ' m³'
				ui.kpis.posVol.sub.textContent = f.displayPosVolUl + ' uL'
				ui.kpis.revVol.v.textContent = (f.displayRevVolUl / 1e9).toFixed(6) + ' m³'
				ui.kpis.revVol.sub.textContent = f.displayRevVolUl + ' uL'
				ui.kpis.netVol.v.textContent = (f.displayNetVolUl / 1e9).toFixed(6) + ' m³'
				ui.kpis.netVol.sub.textContent = f.displayNetVolUl + ' uL'
				ui.kpis.flowRate.v.textContent = f.flowRateLph.toFixed(1) + ' L/h'
				ui.kpis.flowRate.sub.textContent = f.flowRateM3h.toFixed(4) + ' m³/h'
				ui.kpis.posPulse.v.textContent = String(f.posPulse)
				ui.kpis.posPulse.sub.textContent = '净脉冲: ' + f.netPulse
				ui.kpis.revPulse.v.textContent = String(f.revPulse)
				ui.kpis.revPulse.sub.textContent = '间隔: ' + f.pulseIntervalMs + ' ms'
				ui.kpis.flowDir.v.textContent = (f.isFlowing ? '流水' : '停水') + ' / ' + (f.isReverse ? '逆流' : '正流')
				ui.kpis.flowDir.sub.textContent = '象限余数 ' + f.quadRemainder + '/4'
				ui.kpis.runMode.v.textContent = f.modeText || '--'
				ui.kpis.runMode.sub.textContent = '脉冲当量 ' + f.pulseEqUl + ' uL'
				ui.kpis.tempVolt.v.textContent = (f.temperatureC != null ? (f.temperatureC + ' °C') : '-- °C')
				ui.kpis.tempVolt.sub.textContent = (f.voltageV != null ? (f.voltageV.toFixed(2) + ' V') : '-- V')
			}
			if (ui.alarmBadges) {
				;[
					{ bit: 0x01, label: '低电压' },
					{ bit: 0x02, label: '磁干扰' },
					{ bit: 0x04, label: '晶振失效' },
					{ bit: 0x08, label: 'Flash失败' },
				].forEach(function (a) {
					const b = ui.alarmBadges[a.bit]
					if (!b) return
					const on = !!(f.flags & a.bit)
					b.textContent = a.label + (on ? ': 报警' : ': 正常')
					b.dataset.tone = on ? 'danger' : 'ok'
				})
			}
			if (ctrl.state.activeTab === 'flow' && ui.flowCanvas) {
				drawFlowChart(ui.flowCanvas, f.history)
			}
		}

		function renderPulseTiming() {
			if (!ui.ptVals) return
			const snap = ctrl.getPulseTimingSnapshot()
			ui.ptVals.t0.textContent = snap.t0Text
			ui.ptVals.t1.textContent = snap.t1Text
			ui.ptVals.delta.textContent = snap.deltaText
			ui.ptVals.count.textContent = String(snap.pulseCount)
			ui.ptVals.dir.textContent = snap.directionText
		}

		function renderCalib() {
			const c = ctrl.state.calib
			const proto = getProto()
			const doc = getDoc()
			const activeEl = doc ? doc.activeElement : null
			if (ui.calibStatusBadge) {
				ui.calibStatusBadge.textContent = ctrl.state.calibVerify.lastStatus || '就绪'
				ui.calibStatusBadge.dataset.tone = ctrl.state.calibVerify.lastTone || ''
			}
			if (ui.calibEqInputs) {
				Object.keys(ui.calibEqInputs).forEach(function (k) {
					if (activeEl !== ui.calibEqInputs[k]) {
						ui.calibEqInputs[k].value = String(c[k])
					}
				})
			}
			if (ui.calibDirBtns) {
				Object.keys(ui.calibDirBtns).forEach(function (k) {
					ui.calibDirBtns[k].classList.toggle('active', k === ctrl.state.calibViewMode)
				})
			}
			if (ui.calibTablesWrap && ui.calibTableCards) {
				const mode = ctrl.state.calibViewMode
				ui.calibTablesWrap.className = mode === 'dual' ? 'ac6d-dual-tables' : ''
				ui.calibTableCards.fwd.hidden = mode === 'rev'
				ui.calibTableCards.rev.hidden = mode === 'fwd'
			}
			;['fwd', 'rev'].forEach(function (dir) {
				const rows = ui.calibRows[dir]
				if (!rows) return
				const pts = dir === 'fwd' ? c.fwdPoints : c.revPoints
				const cfs = dir === 'fwd' ? c.fwdCoeffs : c.revCoeffs
				const errs = dir === 'fwd' ? c.fwdErrors : c.revErrors
				const news = dir === 'fwd' ? c.fwdNewCoeffs : c.revNewCoeffs
				for (let i = 0; i < 20; i++) {
					const r = rows[i]
					if (activeEl !== r.ptInp) r.ptInp.value = String(pts[i])
					if (activeEl !== r.cfInp) r.cfInp.value = String(cfs[i])
					if (activeEl !== r.errInp) r.errInp.value = String(errs[i])
					if (activeEl !== r.newInp) r.newInp.value = news[i] != null ? String(news[i]) : ''
					const ms = Number(pts[i]) || 0
					let flowLph = 0
					if (ms > 0) {
						flowLph = proto && proto.calcPointFlowRateLph
							? proto.calcPointFlowRateLph(c.meterPulseEq, ms, cfs[i])
							: (c.meterPulseEq * 3.6 / ms) * ((cfs[i] || 10000) / 10000)
					}
					r.tdFlow.textContent = ms > 0 && isFinite(flowLph) ? flowLph.toFixed(2) : '--'
					if (proto && proto.evalCalibErrorGrade && ms > 0) {
						const g = proto.evalCalibErrorGrade(flowLph, Number(errs[i]) || 0)
						r.tdGrade.textContent = g.symbol
						r.tdGrade.className = g.grade === 'ok' ? 'ac6d-grade-ok' : (g.grade === 'warn' ? 'ac6d-grade-warn' : 'ac6d-grade-bad')
					} else {
						r.tdGrade.textContent = '--'
						r.tdGrade.className = ''
					}
				}
			})
			if (ctrl.state.activeTab === 'calib' && ui.calibCanvas) {
				drawSCurveChart(ui.calibCanvas, proto, c, ctrl.state.calibViewMode)
			}
		}

		function renderAnchor() {
			const dir = ctrl.state.anchor.direction
			const tables = ctrl.ensureAnchorTables()
			const dirTbl = tables[dir] || { Q3: [], Q2: [], Q1: [] }
			if (ui.anchorDirBtns) {
				ui.anchorDirBtns.fwd.classList.toggle('active', dir === 'fwd')
				ui.anchorDirBtns.rev.classList.toggle('active', dir === 'rev')
			}
			if (ui.anchorTablesCol) {
				clearNode(ui.anchorTablesCol)
				;[
					{ grp: 'Q3', title: 'Q3 组（锚点 2.500 m³/h · 8 点）' },
					{ grp: 'Q2', title: 'Q2 组（锚点 0.008 m³/h · 6 点）' },
					{ grp: 'Q1', title: 'Q1 组（锚点 0.005 m³/h · 4 点）' },
				].forEach(function (meta) {
					const rows = dirTbl[meta.grp] || []
					const card = el('div', 'ac6d-card')
					const ch = el('div', 'ac6d-card-head')
					ch.appendChild(el('h3', 'ac6d-card-title', meta.title))
					card.appendChild(ch)
					const tw = el('div', 'ac6d-table-wrap')
					const tbl = el('table', 'ac6d-table')
					const thead = el('thead')
					const hr = el('tr')
					;['流速 (m³/h)', '比例', '误差 (%)', '当前系数', '新系数'].forEach(function (h) {
						hr.appendChild(el('th', '', h))
					})
					thead.appendChild(hr)
					tbl.appendChild(thead)
					const tbody = el('tbody')
					rows.forEach(function (r) {
						const tr = el('tr')
						if (r.isAnchor) tr.dataset.anchor = 'true'
						tr.appendChild(el('td', 'ac6d-input-mono', Number(r.flow).toFixed(3) + (r.isAnchor ? ' ★' : '')))
						tr.appendChild(el('td', 'ac6d-input-mono', Number(r.ratio).toFixed(4)))
						const tdErr = el('td', 'ac6d-input-mono')
						if (r.isAnchor) {
							const inp = el('input', 'ac6d-input ac6d-input-xs ac6d-input-mono')
							inp.type = 'number'
							inp.step = '0.01'
							inp.style.width = '78px'
							inp.value = String(r.error != null ? r.error : 0)
							inp.addEventListener('change', function () {
								ctrl.setAnchorError(dir, meta.grp, Number(inp.value) || 0)
							})
							tdErr.appendChild(inp)
						} else {
							tdErr.textContent = (Number(r.error) || 0).toFixed(3)
						}
						tr.appendChild(tdErr)
						tr.appendChild(el('td', 'ac6d-input-mono', String(r.currentCoeff != null ? r.currentCoeff : 10000)))
						tr.appendChild(el('td', 'ac6d-input-mono', r.newCoeff != null ? String(r.newCoeff) : '--'))
						tbody.appendChild(tr)
					})
					tbl.appendChild(tbody)
					tw.appendChild(tbl)
					card.appendChild(tw)
					ui.anchorTablesCol.appendChild(card)
				})
			}
			if (ctrl.state.activeTab === 'anchor' && ui.anchorCanvas) {
				drawAnchorLogChart(ui.anchorCanvas, dir, dirTbl)
			}
		}

		function renderKvCard(container, obj, emptyText) {
			if (!container) return
			clearNode(container)
			if (!obj || typeof obj !== 'object') {
				container.appendChild(el('div', 'ac6d-muted', emptyText))
				return
			}
			Object.keys(obj).forEach(function (k) {
				const box = el('div', 'ac6d-kv')
				box.appendChild(el('span', 'ac6d-kv-k', k))
				const v = obj[k]
				box.appendChild(el('span', 'ac6d-kv-v', Array.isArray(v) ? v.join('、') : String(v == null ? '--' : v)))
				container.appendChild(box)
			})
		}

		function renderParams() {
			const p = ctrl.state.params
			const doc = getDoc()
			const activeEl = doc ? doc.activeElement : null
			if (ui.layoutBadge) {
				const labels = { 'v27-40': 'V2.7 40B', 'legacy-48': '旧版 48B', 'legacy-24': '旧版 24B' }
				ui.layoutBadge.textContent = '检测布局: ' + (labels[p.detectedLayout] || p.detectedLayout)
			}
			if (ui.paramWriteBaseBtn) {
				const effLayout = p.layoutMode !== 'auto' ? p.layoutMode : (p.detectedLayout || 'v27-40')
				const needsSnapshot = effLayout === 'v27-40' || effLayout === 'legacy-48'
				ui.paramWriteBaseBtn.disabled = needsSnapshot && !ctrl.isBaseParamsSnapshotValid()
			}
			if (ui.baseInputs) {
				const b = p.base
				Object.keys(ui.baseInputs).forEach(function (k) {
					const inp = ui.baseInputs[k]
					if (activeEl === inp) return
					if (k === 'initFlag') {
						inp.value = '0x' + ((Number(b.initFlag) || 0) & 0xff).toString(16).toUpperCase().padStart(2, '0')
					} else {
						inp.value = b[k] != null ? String(b[k]) : ''
					}
				})
			}
			renderKvCard(ui.meterKv, p.meter, '点击「读取计量结构体」获取数据')
			renderKvCard(ui.alarmKv, p.alarm, '点击「读取报警记录」获取数据')
			if (ui.baseDegBadge) {
				ui.baseDegBadge.hidden = !p.baseDegreeStatus
				ui.baseDegBadge.textContent = p.baseDegreeStatus || ''
				ui.baseDegBadge.dataset.tone = p.baseDegreeTone || ''
			}
		}

		function renderFreeze() {
			const fr = ctrl.state.freeze
			if (ui.freezeOneBtn) ui.freezeOneBtn.disabled = fr.autoReading
			if (ui.freezeAllBtn) ui.freezeAllBtn.disabled = fr.autoReading
			if (ui.freezeCountBadge) {
				ui.freezeCountBadge.textContent = fr.autoReading
					? ('读取中 ' + fr.entries.length + '/' + (fr.totalCount || '?'))
					: (fr.entries.length + ' / ' + (fr.totalCount || fr.entries.length) + ' 条')
			}
			if (!ui.freezeTbody) return
			clearNode(ui.freezeTbody)
			fr.entries.forEach(function (e, idx) {
				const tr = el('tr')
				const alarms = Array.isArray(e.alarms) && e.alarms.length ? e.alarms.join(' ') : '无'
				;[
					String(e.serial != null ? e.serial : idx),
					e.date || '--',
					numVal(e.cumulativeL, 0).toFixed(2),
					numVal(e.reverseL, 0).toFixed(2),
					numVal(e.positiveL, 0).toFixed(2),
					numVal(e.flowRateM3h, 0).toFixed(4),
					numVal(e.temperatureC, 0).toFixed(1),
					alarms,
					e.crcHex || '--',
				].forEach(function (txt) {
					tr.appendChild(el('td', 'ac6d-input-mono', txt))
				})
				ui.freezeTbody.appendChild(tr)
			})
		}

		function renderDeviceLogs() {
			if (!ui.devLogTbody) return
			clearNode(ui.devLogTbody)
			const list = ctrl.state.deviceLogs.entries || []
			if (!list.length) {
				const tr = el('tr')
				const td = el('td', 'ac6d-muted', '暂无设备内部日志')
				td.colSpan = 4
				tr.appendChild(td)
				ui.devLogTbody.appendChild(tr)
				return
			}
			list.forEach(function (e) {
				const tr = el('tr')
				tr.appendChild(el('td', '', e.typeName || String(e.type)))
				tr.appendChild(el('td', 'ac6d-input-mono', e.time || '--'))
				tr.appendChild(el('td', '', e.summary || '--'))
				const tdCrc = el('td', 'ac6d-input-mono')
				tdCrc.appendChild(el('span', '', e.crcHex || '--'))
				if (e.crcOk === false) {
					const badge = el('span', 'ac6d-badge', '[CRC错误]')
					badge.dataset.tone = 'danger'
					tdCrc.appendChild(el('span', '', ' '))
					tdCrc.appendChild(badge)
				}
				tr.appendChild(tdCrc)
				ui.devLogTbody.appendChild(tr)
			})
		}

		function renderOta() {
			const o = ctrl.state.ota
			if (ui.otaStatusBadge) {
				ui.otaStatusBadge.textContent = o.statusText
				ui.otaStatusBadge.dataset.tone = o.running ? 'info' : (o.lastResult ? (o.lastResult.ok ? 'ok' : 'danger') : '')
			}
			if (ui.otaFileLabel && o.rawBytes) {
				const inf = o.inspect || {}
				ui.otaFileLabel.textContent = o.fileName + ' · ' + (inf.hasHeader ? '已含 16B 固件头 (ProductID=' + (inf.productId || '?') + ')' : '原始 App.bin（一键升级时自动内存封装 16B 头）')
				const app2Total = inf.hasHeader ? o.rawBytes.length : (o.rawBytes.length + 16)
				const okLimit = app2Total <= 0x6000
				ui.otaMetaLabel.textContent = '固件体 ' + (inf.bodySize || o.rawBytes.length) + 'B (BodyCRC ' + hex16(inf.bodyCrc) + ') · OTA包总长 ' + app2Total + 'B / 24576B ' + (okLimit ? '✓' : '✗ 超限!') + ' · 整包 CRC ' + hex16(inf.totalCrc)
			}
			if (ui.otaStartBtn) ui.otaStartBtn.disabled = o.running
			if (ui.otaChunkSel) ui.otaChunkSel.disabled = !!o.running
			if (ui.otaManualBtns) {
				for (let i = 0; i < ui.otaManualBtns.length; i++) {
					ui.otaManualBtns[i].disabled = o.running
				}
			}
			if (ui.otaProgressFill) ui.otaProgressFill.style.width = Math.max(0, Math.min(100, o.progress)) + '%'
			if (ui.otaStepEls) {
				for (let i = 0; i < ui.otaStepEls.length; i++) {
					ui.otaStepEls[i].dataset.state = o.stepStatus[i] || 'idle'
				}
			}
			if (ui.otaManualIdxLabel) {
				ui.otaManualIdxLabel.textContent = '当前包号: #' + o.manualPacketIndex
			}
		}

		function renderSaveAll() {
			const s = ctrl.state.saveAll
			if (ui.saveAllBtn) ui.saveAllBtn.disabled = s.running
			if (ui.saveAllBadge) {
				ui.saveAllBadge.textContent = s.running ? ('[' + s.progressText + ']') : ''
			}
		}

		function appendLogRowDom(entry) {
			if (!ui.logList) return
			const line = el('div', 'ac6d-log-line')
			line.appendChild(el('span', 'ac6d-log-ts', '[' + entry.ts + ']'))
			const dir = el('span', 'ac6d-log-dir', entry.dir)
			dir.dataset.dir = entry.dir
			line.appendChild(dir)
			line.appendChild(el('span', 'ac6d-log-msg', entry.msg + (entry.hex ? (' · ' + entry.hex) : '')))
			ui.logList.appendChild(line)
			while (ui.logList.childNodes.length > LOG_MAX_ROWS) {
				ui.logList.removeChild(ui.logList.firstChild)
			}
			ui.logList.scrollTop = ui.logList.scrollHeight
			if (ui.logCountBadge) {
				ui.logCountBadge.textContent = ctrl.state.logs.length + ' / ' + LOG_MAX_ROWS
			}
		}

		function redrawVisibleCharts() {
			const tab = ctrl.state.activeTab
			if (tab === 'flow' && ui.flowCanvas) {
				drawFlowChart(ui.flowCanvas, ctrl.state.flow.history)
			} else if (tab === 'calib' && ui.calibCanvas) {
				drawSCurveChart(ui.calibCanvas, getProto(), ctrl.state.calib, ctrl.state.calibViewMode)
			} else if (tab === 'anchor' && ui.anchorCanvas) {
				const tables = ctrl.ensureAnchorTables()
				drawAnchorLogChart(ui.anchorCanvas, ctrl.state.anchor.direction, tables[ctrl.state.anchor.direction])
			}
		}

		// ---- 挂载 / 卸载 / 激活 ----
		function mount(container) {
			if (!container || mounted) return
			hostContainer = container
			mounted = true
			clearNode(container)

			container.appendChild(buildToolbar())
			container.appendChild(buildSubnav())

			const body = el('div', 'ac6d-body')
			ui.panes = {
				flow: buildFlowPane(),
				calib: buildCalibPane(),
				anchor: buildAnchorPane(),
				params: buildParamsPane(),
				ota: buildOtaPane(),
			}
			Object.keys(ui.panes).forEach(function (k) { body.appendChild(ui.panes[k]) })
			container.appendChild(body)
			container.appendChild(buildLogDrawer())

			unsubChange = ctrl.onChange(function (topic, payload) {
				if (topic === 'ports') renderPorts(payload)
				else if (topic === 'connection') { renderConnection(); renderParams() }
				else if (topic === 'device') { renderDevice(); renderParams() }
				else if (topic === 'flow') renderFlow()
				else if (topic === 'pulse-timing') renderPulseTiming()
				else if (topic === 'calib') renderCalib()
				else if (topic === 'anchor') renderAnchor()
				else if (topic === 'params') renderParams()
				else if (topic === 'freeze') renderFreeze()
				else if (topic === 'device-logs') renderDeviceLogs()
				else if (topic === 'ota') renderOta()
				else if (topic === 'save-all') renderSaveAll()
				else if (topic === 'log') appendLogRowDom(payload)
				else if (topic === 'log-clear') {
					clearNode(ui.logList)
					if (ui.logCountBadge) ui.logCountBadge.textContent = '0 / ' + LOG_MAX_ROWS
				}
			})

			// 100ms 脉冲计时刷新
			pulseDisplayTimer = setInterval(function () {
				if (ctrl.state.pulseTiming.active) renderPulseTiming()
			}, 100)

			// 响应式图表重绘
			if (typeof ResizeObserver === 'function') {
				resizeObs = new ResizeObserver(function () { redrawVisibleCharts() })
				resizeObs.observe(container)
			}

			const doc = (deps && deps.document) || document
			outsideClickHandler = function (e) {
				if (!hostContainer || !e || !e.target) return
				if (ui.portPop && !ui.portPop.hidden && !ui.portPop.parentNode.contains(e.target)) {
					ui.portPop.hidden = true
				}
				if (ui.authPop && !ui.authPop.hidden && !ui.authPop.parentNode.contains(e.target)) {
					ui.authPop.hidden = true
				}
			}
			keydownHandler = function (e) {
				if (e && e.key === 'Escape') closePopovers()
			}
			doc.addEventListener('click', outsideClickHandler)
			doc.addEventListener('keydown', keydownHandler)

			ctrl.revive()
			renderConnection()
			renderDevice()
			renderFlow()
			renderPulseTiming()
			renderCalib()
			renderAnchor()
			renderParams()
			renderFreeze()
			renderDeviceLogs()
			renderOta()
			renderSaveAll()
			ctrl.refreshPorts()
			ctrl.addLog('SYS', '容积水表校表台已就绪（单路独立串口）')
		}

		function unmount() {
			if (!mounted) return
			mounted = false
			if (unsubChange) { unsubChange(); unsubChange = null }
			if (pulseDisplayTimer != null) { clearInterval(pulseDisplayTimer); pulseDisplayTimer = null }
			if (resizeObs) { try { resizeObs.disconnect() } catch (e) {} resizeObs = null }
			const doc = (deps && deps.document) || (typeof document !== 'undefined' ? document : null)
			if (doc && outsideClickHandler) doc.removeEventListener('click', outsideClickHandler)
			if (doc && keydownHandler) doc.removeEventListener('keydown', keydownHandler)
			outsideClickHandler = null
			keydownHandler = null
			ctrl.destroy()
			if (hostContainer) clearNode(hostContainer)
			hostContainer = null
		}

		function onActivate() {
			ctrl.refreshPorts()
			redrawVisibleCharts()
		}

		function onDeactivate() {
			closePopovers()
		}

		return {
			controller: ctrl,
			mount: mount,
			unmount: unmount,
			onActivate: onActivate,
			onDeactivate: onDeactivate,
			isBusy: ctrl.isBusy,
			busyReason: ctrl.busyReason,
			ownsPort: ctrl.ownsPort,
			statusBadge: ctrl.statusBadge,
		}
	}

	// =========================================================================
	// 单例实例、window.Ac6dToolPluginSpec 与自动注册
	// =========================================================================
	const defaultWorkbench = createWorkbench()

	const pluginSpec = {
		builtin: true,
		viewId: 'view-ac6d',
		feature: 'view.ac6d',
		hideTopbar: true,
		name: '容积水表校表台',
		label: '水表',
		icon: 'bi-droplet-half',
		description: '容积式电子水表单路监控、S曲线与三锚点校准、参数冻结查询与固件OTA',
		mount: defaultWorkbench.mount,
		unmount: defaultWorkbench.unmount,
		onActivate: defaultWorkbench.onActivate,
		onDeactivate: defaultWorkbench.onDeactivate,
		isBusy: defaultWorkbench.isBusy,
		busyReason: defaultWorkbench.busyReason,
		ownsPort: defaultWorkbench.ownsPort,
		statusBadge: defaultWorkbench.statusBadge,
	}

	const publicApi = {
		createController: createController,
		createWorkbench: createWorkbench,
		controller: defaultWorkbench.controller,
		spec: pluginSpec,
		helpers: {
			encodeCalib176Bytes: encodeCalib176Bytes,
			parseHexStr: parseHexStr,
			parseUint32Hex: parseUint32Hex,
			bytesToHexUpper: bytesToHexUpper,
			fallbackBuildCalibBindFileName: fallbackBuildCalibBindFileName,
			fallbackBuildCalibBindJson: fallbackBuildCalibBindJson,
		},
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = publicApi
	}

	if (root && typeof root === 'object') {
		root.Ac6dWorkbench = publicApi
		root.Ac6dToolPluginSpec = pluginSpec
		if (root.ToolPluginRegistry && typeof root.ToolPluginRegistry.register === 'function' && !root.ToolPluginRegistry.has('ac6d')) {
			try {
				root.ToolPluginRegistry.register('ac6d', pluginSpec)
			} catch (e) {
				console.warn('[ac6d-workbench] 注册内置工具插件 ac6d 失败:', e)
			}
		}
	}
})(typeof window !== 'undefined' ? window : globalThis)
