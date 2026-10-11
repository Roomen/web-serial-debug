// 桌面客户端(Tauri 2)的原生串口后端：WebView(macOS WKWebView 等)没有 Web Serial，串口由 Rust 端(desktop/src-tauri/src/serial.rs)
// 经 serialport 打开，这里把它包装成 SerialAdapter 的后端(kind=serial，priority 1，排在 web 前)。在 serial-adapter.js 之后、
// platform-boot.js 之前加载；只在 AppPlatform 判定为 tauri 运行时的桌面画像里注册，Tauri 接口取自原生壳注入的 window.__TAURI__.core。
// 与 Chromium 的对应关系：
// - requestPort 弹本页自己的选口对话框(浏览器那个系统选择框在 WebView 里没有)，列出产品名、厂商、口名(macOS cu.*，Windows COMx)、
//   VID:PID 与序列号，供用户分清同型号的多台设备；按 filters(usbVendorId / usbProductId)过滤。
// - 选过的口记为「已授权」(存 localStorage nativeSerialGranted，跨实例共享，与浏览器的串口权限一样)，getPorts 只返回已授权且在位的口，
//   connect / disconnect 也只对已授权的口派发：页面的热插拔认领逻辑假定事件只来自用户选过的设备。
// - 插拔靠每 1.5 s 列一次口比对；同一路径在位期间端口对象不变，拔掉再插回给新对象(与 Chromium 重插给新 SerialPort 一致)。
// - getInfo 带 path、productName、manufacturerName、serialNumber，页面据此显示设备名并生成别名指纹；不放含 bluetooth 字样的键。
// 纯逻辑可在 node 里跑(tests/transport-native-serial.cjs)。
;(function (root) {
	'use strict'

	const POLL_MS = 1500
	const GRANT_KEY = 'nativeSerialGranted'
	const MAX_GRANTS = 64

	function makeError(name, message) {
		if (typeof DOMException === 'function') return new DOMException(message, name)
		const e = new Error(message)
		e.name = name
		return e
	}

	function hex4(n) { return '0x' + Number(n).toString(16).toUpperCase().padStart(4, '0') }

	// Rust 端的 PortDesc → 端口 getInfo()：Web Serial 的 usbVendorId / usbProductId 加上原生能给的设备字符串
	function portInfo(d) {
		const info = {}
		if (d.vendorId != null) info.usbVendorId = d.vendorId
		if (d.productId != null) info.usbProductId = d.productId
		if (d.serialNumber) info.serialNumber = d.serialNumber
		if (d.product) info.productName = d.product
		if (d.manufacturer) info.manufacturerName = d.manufacturer
		info.path = d.path
		return info
	}

	// 对话框与页面用的标题：有产品名用产品名，否则按连接方式给一个类别名
	function portTitle(d) {
		if (d.product) return d.product
		if (d.transport === 'bluetooth') return '蓝牙串口'
		if (d.transport === 'pci') return 'PCI 串口'
		if (d.transport === 'usb') return 'USB 串口设备'
		return '串口'
	}

	// 第二行的细节：厂商 · VID:PID · SN
	function portDetails(d) {
		const out = []
		if (d.manufacturer) out.push(d.manufacturer)
		if (d.vendorId != null && d.productId != null) out.push(hex4(d.vendorId) + ':' + hex4(d.productId))
		if (d.serialNumber) out.push('SN ' + d.serialNumber)
		return out
	}

	function matchesFilters(d, filters) {
		if (!Array.isArray(filters) || !filters.length) return true
		return filters.some(function (f) {
			if (!f) return false
			if (f.usbVendorId != null && f.usbVendorId !== d.vendorId) return false
			if (f.usbProductId != null && f.usbProductId !== d.productId) return false
			return true
		})
	}

	// USB 设备在前(有产品名的排前)，同类按口名
	function sortPorts(list) {
		return list.slice().sort(function (a, b) {
			const ra = a.transport === 'usb' ? 0 : 1
			const rb = b.transport === 'usb' ? 0 : 1
			if (ra !== rb) return ra - rb
			return String(a.name).localeCompare(String(b.name))
		})
	}

	// 授权记录：有序列号按 VID/PID/SN 认(重插换了口名也认得)；没有序列号按路径 + VID/PID 认，同一个口换插另一种设备不算已授权
	function grantRecord(d) {
		if (d.serialNumber && d.vendorId != null) return { vid: d.vendorId, pid: d.productId, sn: d.serialNumber }
		return { path: d.path, vid: d.vendorId == null ? null : d.vendorId, pid: d.productId == null ? null : d.productId }
	}
	function grantMatches(g, d) {
		if (!g) return false
		const vid = d.vendorId == null ? null : d.vendorId
		const pid = d.productId == null ? null : d.productId
		if (g.sn) return g.sn === d.serialNumber && g.vid === vid && g.pid === pid
		return !!g.path && g.path === d.path && (g.vid == null ? null : g.vid) === vid && (g.pid == null ? null : g.pid) === pid
	}

	function toBytes(m) {
		if (m instanceof Uint8Array) return m
		if (m instanceof ArrayBuffer) return new Uint8Array(m)
		if (ArrayBuffer.isView(m)) return new Uint8Array(m.buffer, m.byteOffset, m.byteLength)
		if (Array.isArray(m)) return Uint8Array.from(m)
		return new Uint8Array(0)
	}

	// Rust 命令出错只回一段字符串；打开、写失败都按 Web Serial 的 NetworkError 报，页面据此走「占用 / 拔出」的提示与退避重试
	function nativeError(e, name) {
		if (e && e.name && e.message) return e
		return makeError(name || 'NetworkError', typeof e === 'string' ? e : (e && e.message) || String(e))
	}

	// deps = { invoke(cmd, args) → Promise, Channel(构造器，实例有 onmessage), choosePort(ctx) → Promise<desc | null>,
	//          storage(localStorage 形状，可缺)，setInterval / clearInterval(可缺，默认全局) }
	function createNativeSerialBackend(deps) {
		const invoke = deps.invoke
		const Channel = deps.Channel
		const storage = deps.storage || null
		const setIv = deps.setInterval || root.setInterval
		const clearIv = deps.clearInterval || root.clearInterval
		const pollMs = deps.pollMs || POLL_MS

		const present = new Map() // path → { desc, port }
		let fire = null
		let timer = null
		let refreshing = null
		let listed = false
		const watchers = new Set() // 选口对话框开着时订阅列表变化

		function loadGrants() {
			if (!storage) return []
			try {
				const v = JSON.parse(storage.getItem(GRANT_KEY) || '[]')
				return Array.isArray(v) ? v : []
			} catch (e) { return [] }
		}
		function isGranted(d) {
			return loadGrants().some(function (g) { return grantMatches(g, d) })
		}
		function grant(d) {
			if (!storage || isGranted(d)) return
			const list = loadGrants()
			list.push(grantRecord(d))
			try { storage.setItem(GRANT_KEY, JSON.stringify(list.slice(-MAX_GRANTS))) } catch (e) {}
		}

		function createDriver(entry) {
			let handle = null
			return {
				getInfo() { return portInfo(entry.desc) },
				async open(options, sink) {
					const onData = new Channel()
					onData.onmessage = function (m) { sink.data(toBytes(m)) }
					const onEvent = new Channel()
					onEvent.onmessage = function (ev) {
						const msg = ev && ev.message ? String(ev.message) : ''
						if (ev && ev.type === 'lost') sink.lost(makeError('NetworkError', msg || '设备已断开'))
						else sink.error(makeError('FramingError', msg || '串口读错误'))
					}
					const o = options || {}
					try {
						handle = await invoke('serial_open', {
							path: entry.desc.path,
							options: {
								baudRate: Number(o.baudRate) || 9600,
								dataBits: o.dataBits != null ? Number(o.dataBits) : 8,
								stopBits: o.stopBits != null ? Number(o.stopBits) : 1,
								parity: o.parity || 'none',
								flowControl: o.flowControl || 'none',
							},
							onData,
							onEvent,
						})
					} catch (e) {
						throw nativeError(e)
					}
				},
				write(bytes) {
					if (handle == null) return Promise.reject(makeError('NetworkError', '串口未打开'))
					// 写入走 JSON 数组：Tauri 的 Vec<u8> 参数按数组反序列化，单次发送量(快捷发送、固件分片)不大
					return invoke('serial_write', { handle, data: Array.from(bytes) }).catch(function (e) { throw nativeError(e) })
				},
				async close() {
					const h = handle
					if (h == null) return
					await invoke('serial_close', { handle: h }).catch(function (e) { throw nativeError(e, 'InvalidStateError') })
					if (handle === h) handle = null
				},
				setSignals(s) {
					if (handle == null) return Promise.reject(makeError('InvalidStateError', '串口未打开'))
					const signals = {}
					if (s.dataTerminalReady != null) signals.dataTerminalReady = !!s.dataTerminalReady
					if (s.requestToSend != null) signals.requestToSend = !!s.requestToSend
					if (s.break != null) signals.break = !!s.break
					return invoke('serial_set_signals', { handle, signals }).catch(function (e) { throw nativeError(e) })
				},
			}
		}

		function makeEntry(desc) {
			const entry = { desc, port: null }
			entry.port = root.SerialAdapter.createStreamPort(createDriver(entry))
			return entry
		}

		async function doRefresh() {
			const list = await invoke('serial_list')
			const seen = new Set()
			const added = []
			;(Array.isArray(list) ? list : []).forEach(function (d) {
				if (!d || !d.path) return
				seen.add(d.path)
				const cur = present.get(d.path)
				// 同一路径换了一台设备(序列号或 VID/PID 变了)：按拔出旧的、插入新的处理
				if (cur && (cur.desc.vendorId !== d.vendorId || cur.desc.productId !== d.productId || cur.desc.serialNumber !== d.serialNumber)) {
					present.delete(d.path)
					if (fire && isGranted(cur.desc)) fire('disconnect', cur.port)
				} else if (cur) {
					cur.desc = d
					return
				}
				const entry = makeEntry(d)
				present.set(d.path, entry)
				added.push(entry)
			})
			const removed = []
			present.forEach(function (entry, path) {
				if (!seen.has(path)) removed.push(entry)
			})
			removed.forEach(function (entry) { present.delete(entry.desc.path) })
			// 第一次列口只建表：启动时已经在位的口不算新插入
			if (listed && fire) {
				removed.forEach(function (entry) { if (isGranted(entry.desc)) fire('disconnect', entry.port) })
				added.forEach(function (entry) { if (isGranted(entry.desc)) fire('connect', entry.port) })
			}
			listed = true
			watchers.forEach(function (fn) { try { fn(snapshot()) } catch (e) {} })
		}

		function refresh() {
			if (!refreshing) {
				refreshing = doRefresh().catch(function (e) {
					console.warn('列串口失败', e)
				}).then(function () { refreshing = null })
			}
			return refreshing
		}

		function snapshot() {
			return sortPorts(Array.from(present.values()).map(function (e) { return e.desc }))
		}

		const backend = {
			name: 'native',
			kind: 'serial',
			priority: 1,
			supported: true,
			async requestPort(options) {
				await refresh()
				const filters = options && options.filters
				const desc = await deps.choosePort({
					filters,
					list() { return snapshot().filter(function (d) { return matchesFilters(d, filters) }) },
					refresh,
					watch(fn) {
						const w = function (all) { fn(all.filter(function (d) { return matchesFilters(d, filters) })) }
						watchers.add(w)
						return function () { watchers.delete(w) }
					},
				})
				if (!desc) throw makeError('NotFoundError', '未选择串口设备')
				const entry = present.get(desc.path)
				if (!entry) throw makeError('NotFoundError', '所选设备已拔出')
				grant(entry.desc)
				return entry.port
			},
			async getPorts() {
				await refresh()
				const out = []
				present.forEach(function (entry) { if (isGranted(entry.desc)) out.push(entry.port) })
				return out
			},
			// 网页版靠 WebUSB 设备表按 VID/PID 补产品名与序列号；原生口的 getInfo 已经带上，这里给空表，
			// 免得页面再按 VID/PID 去猜(同型号多台时会猜错)
			getUsbDevices() { return Promise.resolve([]) },
			attach(f) {
				fire = f
				if (!timer) timer = setIv(refresh, pollMs)
				refresh()
			},
			// 测试用：立即比对一次
			_refresh: refresh,
			_stop() { if (timer) { clearIv(timer); timer = null } },
		}
		return backend
	}

	// ---- 选口对话框(Bootstrap modal 外观，自己管显隐，不依赖 bootstrap.Modal) ----
	// 设备字符串来自设备本身(USB 描述符)，是不可信输入，一律 textContent
	function createPortPicker(doc) {
		let busy = null

		function el(tag, cls, text) {
			const n = doc.createElement(tag)
			if (cls) n.className = cls
			if (text != null) n.textContent = text
			return n
		}

		function build(ctx) {
			const overlay = el('div', 'native-port-overlay')
			overlay.setAttribute('role', 'dialog')
			overlay.setAttribute('aria-modal', 'true')
			overlay.setAttribute('aria-labelledby', 'native-port-title')
			const box = el('div', 'native-port-dialog modal-content')
			const head = el('div', 'modal-header')
			const title = el('h5', 'modal-title', '选择串口设备')
			title.id = 'native-port-title'
			const x = el('button', 'btn-close')
			x.type = 'button'
			x.setAttribute('aria-label', '取消')
			head.append(title, x)
			const body = el('div', 'modal-body native-port-body')
			const hint = el('div', 'native-port-hint', ctx.filters && ctx.filters.length ? '只列出本功能支持的设备' : '设备插拔后列表会自动刷新')
			const list = el('div', 'native-port-list')
			list.setAttribute('role', 'listbox')
			list.setAttribute('aria-label', '串口设备')
			body.append(hint, list)
			const foot = el('div', 'modal-footer')
			const refreshBtn = el('button', 'btn btn-sm btn-outline-secondary me-auto')
			refreshBtn.type = 'button'
			refreshBtn.append(el('i', 'bi bi-arrow-clockwise'), doc.createTextNode(' 刷新'))
			const cancel = el('button', 'btn btn-sm btn-outline-secondary', '取消')
			cancel.type = 'button'
			const ok = el('button', 'btn btn-sm btn-primary', '连接')
			ok.type = 'button'
			ok.disabled = true
			foot.append(refreshBtn, cancel, ok)
			box.append(head, body, foot)
			overlay.append(box)
			return { overlay, list, x, cancel, ok, refreshBtn }
		}

		function renderRow(d, selected) {
			const row = el('div', 'native-port-row' + (selected ? ' is-selected' : ''))
			row.setAttribute('role', 'option')
			row.setAttribute('aria-selected', selected ? 'true' : 'false')
			row.tabIndex = selected ? 0 : -1
			row.dataset.path = d.path
			const icon = el('i', 'native-port-icon bi ' + (d.transport === 'bluetooth' ? 'bi-bluetooth' : d.transport === 'usb' ? 'bi-usb-symbol' : 'bi-hdd'))
			const main = el('div', 'native-port-main')
			const line1 = el('div', 'native-port-line1')
			line1.append(el('span', 'native-port-name', portTitle(d)))
			if (d.open) line1.append(el('span', 'native-port-badge', '已打开'))
			main.append(line1)
			const details = portDetails(d)
			if (details.length) main.append(el('div', 'native-port-details', details.join(' · ')))
			const path = el('div', 'native-port-path', d.name)
			path.title = d.path
			row.append(icon, main, path)
			return row
		}

		return function choosePort(ctx) {
			// 同一时刻只开一个对话框(双击连接键等)：后来的直接按取消处理
			if (busy) return Promise.resolve(null)
			busy = new Promise(function (resolve) {
				const ui = build(ctx)
				let items = ctx.list()
				let selected = items.length === 1 ? items[0].path : null
				const prevFocus = doc.activeElement

				function render() {
					ui.list.textContent = ''
					if (!items.length) {
						const empty = el('div', 'native-port-empty')
						empty.append(el('div', 'native-port-empty-title', '没有找到串口设备'))
						empty.append(el('div', 'native-port-empty-text', '请插入设备后稍等片刻。CH340、CP210x 等 USB 转串口芯片在部分系统上需要先安装厂商驱动。'))
						ui.list.append(empty)
					}
					items.forEach(function (d) { ui.list.append(renderRow(d, d.path === selected)) })
					ui.ok.disabled = !items.some(function (d) { return d.path === selected })
				}
				function finish(result) {
					unwatch()
					doc.removeEventListener('keydown', onKey, true)
					ui.overlay.remove()
					busy = null
					if (prevFocus && prevFocus.focus) { try { prevFocus.focus() } catch (e) {} }
					resolve(result)
				}
				function choose() {
					const d = items.find(function (it) { return it.path === selected })
					if (d) finish(d)
				}
				function select(path, focus) {
					selected = path
					render()
					if (focus) {
						const row = ui.list.querySelector('.native-port-row.is-selected')
						if (row) row.focus()
					}
				}
				function onKey(e) {
					if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null) }
					else if (e.key === 'Enter' && selected && !ui.ok.disabled && (e.target === doc.body || ui.overlay.contains(e.target)) && e.target !== ui.cancel && e.target !== ui.x && e.target !== ui.refreshBtn) {
						e.preventDefault()
						e.stopPropagation()
						choose()
					} else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
						e.preventDefault()
						let i = items.findIndex(function (d) { return d.path === selected })
						i = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)
						select(items[i].path, true)
					}
				}
				const unwatch = ctx.watch(function (next) {
					items = next
					render()
				})

				ui.list.addEventListener('click', function (e) {
					const row = e.target.closest('.native-port-row')
					if (row) select(row.dataset.path, true)
				})
				ui.list.addEventListener('dblclick', function (e) {
					const row = e.target.closest('.native-port-row')
					if (row) { selected = row.dataset.path; choose() }
				})
				ui.overlay.addEventListener('mousedown', function (e) { if (e.target === ui.overlay) finish(null) })
				ui.x.addEventListener('click', function () { finish(null) })
				ui.cancel.addEventListener('click', function () { finish(null) })
				ui.ok.addEventListener('click', choose)
				ui.refreshBtn.addEventListener('click', function () { ctx.refresh() })
				doc.addEventListener('keydown', onKey, true)

				render()
				doc.body.append(ui.overlay)
				const first = ui.list.querySelector('.native-port-row.is-selected') || ui.cancel
				first.focus()
			})
			return busy
		}
	}

	const lib = { createNativeSerialBackend, createPortPicker, portInfo, portTitle, portDetails, matchesFilters, sortPorts, grantRecord, grantMatches }

	if (typeof module !== 'undefined' && module.exports) module.exports = lib

	// ---- 浏览器里：只在桌面客户端注册 ----
	const P = root.AppPlatform
	const tauri = root.__TAURI__ && root.__TAURI__.core
	if (root.document && root.SerialAdapter && P && P.runtime === 'tauri' && !P.mobile && tauri && P.has('transport.serial')) {
		const invoke = tauri.invoke
		// 先收回本窗口刷新前留下的句柄：pagehide 里的关闭不等完成，刷新后立刻重连会撞上独占锁。
		// 打开一律等它完成再发，免得刷新后的自动重连跑在收回前面
		const released = invoke('serial_release_owned').catch(function () {})
		root.SerialAdapter.register(createNativeSerialBackend({
			invoke(cmd, args) {
				return cmd === 'serial_open' ? released.then(function () { return invoke(cmd, args) }) : invoke(cmd, args)
			},
			Channel: tauri.Channel,
			storage: (function () { try { return root.localStorage } catch (e) { return null } })(),
			choosePort: createPortPicker(root.document),
		}))
	}
})(typeof window !== 'undefined' ? window : globalThis)
