// 串口接入适配层：页面与协议代码只经 window.SerialAdapter 选口、列口、听插拔，不直接碰 navigator.serial。
// 端口对象的契约是 Web Serial SerialPort 的子集：getInfo()、open(options)、close()、readable / writable(打开后是
// ReadableStream / WritableStream，未打开或设备丢失为 null)，可选 setSignals(signals)。读出错后 readable 换成一条新流
// (Chromium 的行为，读循环靠「readable 不再是上一条流」续读)，close() 在流被锁住时拒绝。
// 后端：web 直通 navigator.serial；原生壳(Tauri 2 等)用 createStreamPort 把「打开 / 写 / 关 / 推数据」包装成上述端口，
// 在 common.js 之前 register + use 切过去，页面与协议代码不变。
// 纯逻辑可在 node 里跑(tests/serial-adapter.cjs)。
;(function (root) {
	'use strict'

	const listeners = { connect: [], disconnect: [] }
	const backends = {}
	const attached = new Set()
	let active = null

	function makeError(name, message) {
		if (typeof DOMException === 'function') return new DOMException(message, name)
		const e = new Error(message)
		e.name = name
		return e
	}

	function emit(type, port) {
		const list = listeners[type]
		if (!list || !port) return
		const ev = { type, port }
		list.slice().forEach(function (fn) {
			try { fn(ev) } catch (e) { console.error(e) }
		})
	}

	// Web Serial：事件端口在 e.port；少数极旧实现曾把 SerialPort 放在 target
	function webEventPort(e) {
		if (e && e.port && typeof e.port.open === 'function') return e.port
		const t = e && e.target
		if (t && typeof t.open === 'function' && typeof t.getInfo === 'function') return t
		return null
	}

	function createWebBackend(nav) {
		const serial = nav && nav.serial
		return {
			name: 'web',
			supported: !!serial,
			requestPort(options) { return serial.requestPort(options) },
			getPorts() { return serial.getPorts() },
			// WebUSB 只用来补序列号与产品名：同 VID/PID 的 USB 设备，没授权或不支持就是空表
			getUsbDevices() {
				if (!nav.usb || !nav.usb.getDevices) return Promise.resolve([])
				return nav.usb.getDevices()
			},
			attach(fire) {
				serial.addEventListener('connect', function (e) { fire('connect', webEventPort(e)) })
				serial.addEventListener('disconnect', function (e) { fire('disconnect', webEventPort(e)) })
			},
		}
	}

	function register(backend) {
		if (!backend || !backend.name) throw new TypeError('串口后端缺少 name')
		backends[backend.name] = backend
		return backend
	}

	// 切换后端只影响之后的选口、列口与事件；页面加载后已打开的口不迁移，所以原生后端要在 common.js 之前切
	function use(name) {
		const b = backends[name]
		if (!b) throw new Error('未注册的串口后端: ' + name)
		active = b
		if (b.supported && b.attach && !attached.has(b)) {
			attached.add(b)
			b.attach(function (type, port) {
				if (active === b) emit(type, port)
			})
		}
		return b
	}

	// ---- 原生后端用：把推送式驱动包装成 Web Serial 形状的端口 ----
	// driver = {
	//   getInfo() → { usbVendorId, usbProductId, ... }(全部自有属性都会进设备指纹，序列号可直接放这里)
	//   open(options, sink) → Promise；之后驱动经 sink.data(Uint8Array) 推数据，sink.error(err) 报可恢复的读错误
	//     (当前 readable 报错、换新流续读)，sink.lost(err) 报设备丢失(两条流报错并置 null，句柄由适配层替页面关掉)
	//   write(Uint8Array) → Promise，close() → Promise，可选 setSignals(signals) → Promise
	// }
	// 读侧队列上限取 max(bufferSize, 1 MiB) 字节，超过按 Chromium 的 BufferOverrunError 处理(报错换新流)
	const MIN_READ_QUEUE = 1 << 20

	function toBytes(chunk) {
		if (chunk instanceof Uint8Array) return chunk
		if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
		if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
		throw new TypeError('串口只能写 BufferSource')
	}

	function createStreamPort(driver) {
		let state = 'closed' // closed | opening | opened | closing
		let gen = 0
		let queueLimit = MIN_READ_QUEUE
		let rs = null
		let rsCtl = null
		let ws = null

		function dropReadable(stream) {
			if (rs === stream) { rs = null; rsCtl = null }
		}
		function ensureReadable() {
			if (state !== 'opened') return null
			if (rs) return rs
			let ctl = null
			const stream = new ReadableStream({
				start(c) { ctl = c },
				cancel() { dropReadable(stream) },
			}, { highWaterMark: queueLimit, size(chunk) { return chunk.byteLength } })
			rs = stream
			rsCtl = ctl
			return stream
		}
		function errorReadable(err) {
			const ctl = rsCtl
			rs = null
			rsCtl = null
			if (ctl) { try { ctl.error(err) } catch (e) {} }
		}
		function ensureWritable() {
			if (state !== 'opened') return null
			if (ws) return ws
			const g = gen
			const stream = new WritableStream({
				write(chunk) {
					if (g !== gen || state !== 'opened') return Promise.reject(makeError('NetworkError', '串口已断开'))
					return Promise.resolve(driver.write(toBytes(chunk)))
				},
				close() { if (ws === stream) ws = null },
				abort() { if (ws === stream) ws = null },
			})
			ws = stream
			return stream
		}

		function makeSink(g) {
			const live = function () { return g === gen && state === 'opened' }
			return {
				data(bytes) {
					if (!live()) return
					const u8 = toBytes(bytes)
					if (!u8.byteLength) return
					ensureReadable()
					// 队列里已有积压且这一块放不下才算溢出；没人读时的单个大块照收
					const room = rsCtl.desiredSize
					if (room !== null && room < queueLimit && room < u8.byteLength) {
						errorReadable(makeError('BufferOverrunError', '接收缓冲溢出'))
						return
					}
					rsCtl.enqueue(u8)
				},
				error(err) {
					if (!live()) return
					errorReadable(err || makeError('FramingError', '串口读错误'))
				},
				lost(err) {
					if (!live()) return
					// 与 Chromium 一致：丢失后两条流都是 null，页面不会再调 close，所以句柄在这里替它释放
					const e = err || makeError('NetworkError', '设备已断开')
					gen++
					state = 'closing'
					errorReadable(e)
					const w = ws
					ws = null
					if (w && !w.locked) w.abort(e).catch(function () {})
					Promise.resolve().then(function () { return driver.close() }).catch(function () {}).then(function () {
						if (state === 'closing') state = 'closed'
					})
				},
			}
		}

		const port = {
			getInfo() { return driver.getInfo ? Object.assign({}, driver.getInfo()) : {} },
			get readable() { return ensureReadable() },
			get writable() { return ensureWritable() },
			async open(options) {
				if (state !== 'closed') throw makeError('InvalidStateError', '串口已打开')
				state = 'opening'
				const g = ++gen
				const buf = options && Number(options.bufferSize)
				queueLimit = Math.max(buf > 0 ? buf : 0, MIN_READ_QUEUE)
				try {
					await driver.open(options || {}, makeSink(g))
				} catch (e) {
					if (g === gen) state = 'closed'
					throw e
				}
				if (g !== gen) throw makeError('AbortError', '打开被关闭打断')
				state = 'opened'
			},
			async close() {
				if (state === 'closed' || state === 'closing') throw makeError('InvalidStateError', '串口未打开')
				if ((rs && rs.locked) || (ws && ws.locked)) throw makeError('InvalidStateError', '串口流仍被占用')
				const r = rs
				const w = ws
				rs = null
				rsCtl = null
				ws = null
				gen++
				state = 'closing'
				if (r) { try { await r.cancel() } catch (e) {} }
				if (w) { try { await w.abort() } catch (e) {} }
				try {
					await driver.close()
				} finally {
					state = 'closed'
				}
			},
		}
		if (typeof driver.setSignals === 'function') {
			port.setSignals = function (signals) {
				if (state !== 'opened') return Promise.reject(makeError('InvalidStateError', '串口未打开'))
				return Promise.resolve(driver.setSignals(signals || {}))
			}
		}
		return port
	}

	const api = {
		get backend() { return active ? active.name : null },
		isSupported() { return !!(active && active.supported) },
		requestPort(options) {
			if (!api.isSupported()) return Promise.reject(makeError('NotSupportedError', '当前环境不支持串口'))
			return active.requestPort(options)
		},
		getPorts() {
			if (!api.isSupported()) return Promise.resolve([])
			return Promise.resolve(active.getPorts())
		},
		// 返回 [{ vendorId, productId, serialNumber, productName, manufacturerName }]；原生后端不提供就是空表
		getUsbDevices() {
			if (!api.isSupported() || !active.getUsbDevices) return Promise.resolve([])
			return Promise.resolve(active.getUsbDevices()).catch(function () { return [] })
		},
		// 事件对象是 { type, port }，与 Web Serial 的 e.port 读法一致
		addEventListener(type, fn) {
			if (listeners[type] && typeof fn === 'function') listeners[type].push(fn)
		},
		removeEventListener(type, fn) {
			const list = listeners[type]
			if (!list) return
			const i = list.indexOf(fn)
			if (i >= 0) list.splice(i, 1)
		},
		register,
		use,
		createStreamPort,
		createWebBackend,
	}

	register(createWebBackend(root.navigator))
	use('web')

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api
	}
	root.SerialAdapter = api
})(typeof window !== 'undefined' ? window : globalThis)
