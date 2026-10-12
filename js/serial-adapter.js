// 串口接入适配层：页面与协议代码只经 window.SerialAdapter 选口、列口、听插拔，不直接碰 navigator.serial。
// 端口对象的契约是 Web Serial SerialPort 的子集：getInfo()、open(options)、close()、readable / writable(打开后是
// ReadableStream / WritableStream，未打开或设备丢失为 null)，可选 setSignals(signals)。读出错后 readable 换成一条新流
// (Chromium 的行为，读循环靠「readable 不再是上一条流」续读)，写出错后 writable 同样换新流，close() 在流被锁住时拒绝。
// 后端：web 直通 navigator.serial；BLE(js/transport-ble.js)与原生壳(Tauri 2 等)用 createStreamPort 把「打开 / 写 / 关 / 推数据」
// 包装成上述端口，在 common.js 之前 register，由 js/platform-boot.js 按平台画像的传输优先顺序 pick 一个，页面与协议代码不变。
// 每个后端带 kind(serial | ble | bt-classic)，与 AppPlatform.transports 的取值一致；同一时刻只有一个当前后端(单路够用，
// 移动端也只有一路)，选口、列口、插拔事件都只走它。
// 列口有两种：getPorts 只给用户选用过(授权过)的口，与 Web Serial 一致，热插拔认领与刷新后自动重连都只认它；能枚举的后端(原生壳)
// 另给 listPorts 列出当前在位的全部串口，供现代布局连接栏的串口列表「直接列出、选了就用」，选用时由页面调 grantPort 记为已授权。
// 不能枚举的后端(web)listPorts 退化为 getPorts。在位集合变化另派发 change 事件(port 为 null)，connect / disconnect 仍只对已授权的口派发。
// 纯逻辑可在 node 里跑(tests/serial-adapter.cjs)。
;(function (root) {
	'use strict'

	const listeners = { connect: [], disconnect: [], change: [] }
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
		// change 只说「在位的口变了」，不带端口；connect / disconnect 必须带端口
		if (!list || (!port && type !== 'change')) return
		const ev = { type, port: port || null }
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
			kind: 'serial',
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
		if (!backend.kind) backend.kind = 'serial'
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

	// 按传输种类的优先顺序选第一个已注册且受支持的后端；同种类取 priority 大的(缺省 0，原生壳的后端给正数，
	// 免得依赖注册先后输给更早注册的 web / Web Bluetooth)，再同则按注册先后。都不可用时保持当前后端不变，返回 null
	function pick(kinds) {
		const list = Array.isArray(kinds) ? kinds : []
		for (let i = 0; i < list.length; i++) {
			let best = null
			for (const name in backends) {
				const b = backends[name]
				if (b.kind !== list[i] || !b.supported) continue
				if (!best || (b.priority || 0) > (best.priority || 0)) best = b
			}
			if (best) return use(best.name)
		}
		return null
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
		// 适配层替页面释放(设备丢失)时驱动 close 失败：句柄可能还在。页面看到两条流为 null 不会再调 close，
		// 所以由下一次 open 先重试释放，释放不掉就拒绝打开，不能在没释放的句柄上再开一次
		let staleHandle = false
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
					// 写失败后这条流已报错；与 Chromium 一致，writable 之后换一条新流，端口仍是打开的。
					// 在 then 里核对代次并调驱动：驱动同步抛错走同一条换流路径，核对与调用之间也插不进设备丢失
					return Promise.resolve().then(function () {
						if (g !== gen || state !== 'opened') throw makeError('NetworkError', '串口已断开')
						return driver.write(toBytes(chunk))
					}).catch(function (e) {
						if (ws === stream) ws = null
						throw e
					})
				},
				close() { if (ws === stream) ws = null },
				abort() { if (ws === stream) ws = null },
			})
			ws = stream
			return stream
		}

		// pending：这次 open 的暂存，打开中报的设备丢失记在 pending.lost，由 open 收尾时处理
		function makeSink(g, pending) {
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
					// 打开中丢失(如 BLE 开通知时断开)：驱动的 open 可能照样兑现，不能让 open 报成功
					if (g === gen && state === 'opening') {
						if (!pending.lost) pending.lost = err || makeError('NetworkError', '设备已断开')
						return
					}
					if (!live()) return
					// 与 Chromium 一致：丢失后两条流都是 null，页面不会再调 close，所以句柄在这里替它释放
					const e = err || makeError('NetworkError', '设备已断开')
					gen++
					state = 'closing'
					errorReadable(e)
					const w = ws
					ws = null
					if (w && !w.locked) w.abort(e).catch(function () {})
					Promise.resolve().then(function () { return driver.close() }).catch(function () { staleHandle = true }).then(function () {
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
				if (staleHandle) {
					try {
						await driver.close()
					} catch (e) {
						state = 'closed'
						throw makeError('InvalidStateError', '上次断开的设备句柄未能释放')
					}
					staleHandle = false
				}
				const g = ++gen
				const buf = options && Number(options.bufferSize)
				queueLimit = Math.max(buf > 0 ? buf : 0, MIN_READ_QUEUE)
				const pending = { lost: null }
				try {
					await driver.open(options || {}, makeSink(g, pending))
				} catch (e) {
					state = 'closed'
					throw e
				}
				if (pending.lost) {
					// 驱动已打开但设备在途中丢失：替页面释放句柄，open 报失败，端口回到关闭
					gen++
					try { await driver.close() } catch (e) { staleHandle = true }
					state = 'closed'
					throw pending.lost
				}
				state = 'opened'
			},
			// 只有已打开才能关：打开中关闭会与驱动的 open 赛跑，后完成的 open 留下没人释放的句柄。
			// 与 Chromium 一致，打开中两条流都是 null，页面本就不会在这时调 close
			async close() {
				if (state !== 'opened') throw makeError('InvalidStateError', '串口未打开')
				if ((rs && rs.locked) || (ws && ws.locked)) throw makeError('InvalidStateError', '串口流仍被占用')
				const r = rs
				const w = ws
				rs = null
				rsCtl = null
				ws = null
				state = 'closing'
				if (r) { try { await r.cancel() } catch (e) {} }
				if (w) { try { await w.abort() } catch (e) {} }
				// 驱动没关掉就回到已打开：句柄仍在，流照常可取，页面重试 close 会再调驱动，不能报成已释放、放行重新打开
				try {
					await driver.close()
				} catch (e) {
					state = 'opened'
					throw e
				}
				gen++
				state = 'closed'
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
		// 当前后端的传输种类(serial | ble | bt-classic)；页面里只对 Chromium Web Serial 才有的现象(如蓝牙 RFCOMM 口)按后端名判断
		get kind() { return active ? active.kind : null },
		list() {
			return Object.keys(backends).map(function (name) {
				const b = backends[name]
				return { name, kind: b.kind, supported: !!b.supported, active: b === active }
			})
		},
		isSupported() { return !!(active && active.supported) },
		requestPort(options) {
			if (!api.isSupported()) return Promise.reject(makeError('NotSupportedError', '当前环境不支持串口'))
			return active.requestPort(options)
		},
		getPorts() {
			if (!api.isSupported()) return Promise.resolve([])
			return Promise.resolve(active.getPorts())
		},
		// 能否列出当前在位的全部串口(不只授权过的)：原生后端能；Web Serial 只看得到用户在浏览器选择框里授权过的口
		canEnumerate() { return !!(api.isSupported() && typeof active.listPorts === 'function') },
		// 能枚举时返回在位的全部端口(同一设备在位期间多次调用给同一对象，与 getPorts、插拔事件给的对象一致)；否则同 getPorts
		listPorts() {
			if (!api.isSupported()) return Promise.resolve([])
			if (typeof active.listPorts === 'function') return Promise.resolve(active.listPorts())
			return api.getPorts()
		},
		// 页面选用了 listPorts 里的某个口：记为已授权，之后 getPorts、插拔事件、刷新后自动重连都认它。后端不需要(web 由浏览器授权)时返回 false
		grantPort(port) {
			if (!port || !api.isSupported() || typeof active.grantPort !== 'function') return false
			return !!active.grantPort(port)
		},
		// 返回 [{ vendorId, productId, serialNumber, productName, manufacturerName }]；原生后端不提供就是空表
		getUsbDevices() {
			if (!api.isSupported() || !active.getUsbDevices) return Promise.resolve([])
			return Promise.resolve(active.getUsbDevices()).catch(function () { return [] })
		},
		// 事件对象是 { type, port }，与 Web Serial 的 e.port 读法一致；change 的 port 为 null
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
		pick,
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
