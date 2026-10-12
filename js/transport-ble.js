// BLE 透传(GATT UART)传输：把「一个写特征 + 一个通知特征」的蓝牙串口模块包装成 Web Serial 形状的端口，注册成 kind=ble 的
// 串口后端，页面与协议代码照常走 SerialAdapter。在 serial-adapter.js 之后、platform-boot.js 之前加载。
// web 后端用 Web Bluetooth(Chromium 桌面与 Android Chrome 有；iOS 没有，iOS 由原生壳另注册同为 kind=ble 的后端)。
// 端口契约由 SerialAdapter.createStreamPort 守住；这里只做驱动：连 GATT、按 UUID 档位找服务、开通知推数据、按包长分片串行写。
// 串口参数(波特率等)对 BLE 没有意义，open 时忽略；GATT 断开按设备丢失(sink.lost)报给适配层。
// 纯逻辑可在 node 里跑(tests/transport-ble.cjs)。
;(function (root) {
	'use strict'

	// 常见透传模块的 UUID 档位，按顺序尝试；write 与 notify 可以是同一个特征(HM-10 / CC254x)
	const BLE_UART_PROFILES = [
		{ id: 'nus', name: 'Nordic UART', service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e' },
		{ id: 'ffe0', name: 'HM-10 / CC254x', service: 0xffe0, write: 0xffe1, notify: 0xffe1 },
	]

	// Web Bluetooth 不暴露协商后的 MTU，按 ATT 默认 23 - 3 字节分片最稳；原生后端可传更大的 chunkSize
	const DEFAULT_CHUNK = 20

	function makeError(name, message) {
		if (typeof DOMException === 'function') return new DOMException(message, name)
		const e = new Error(message)
		e.name = name
		return e
	}

	// device: Web Bluetooth BluetoothDevice 形状(id、name、gatt.connect()、gattserverdisconnected 事件)
	function createBleUartDriver(device, opts) {
		opts = opts || {}
		const profiles = opts.profiles || BLE_UART_PROFILES
		const chunkSize = opts.chunkSize > 0 ? opts.chunkSize : DEFAULT_CHUNK
		let server = null
		let txChar = null
		let rxChar = null
		let onValue = null
		let onGone = null
		// GATT 同一时刻只允许一个操作(Chromium 报 "GATT operation already in progress")，写入排队串行
		let chain = Promise.resolve()
		// 连接代次：open / close / 断开各加一。写任务绑定发起时的代次与特征，每片前核对，
		// 断线重连后旧任务剩下的分片不能写进新连接；新连接也不排在旧连接的队列后面
		let conn = 0

		function detach() {
			if (rxChar && onValue) rxChar.removeEventListener('characteristicvaluechanged', onValue)
			if (onGone) device.removeEventListener('gattserverdisconnected', onGone)
			onValue = null
			onGone = null
		}

		async function findProfile(srv) {
			for (let i = 0; i < profiles.length; i++) {
				const p = profiles[i]
				let svc = null
				try { svc = await srv.getPrimaryService(p.service) } catch (e) { continue }
				const tx = await svc.getCharacteristic(p.write)
				const rx = p.notify === p.write ? tx : await svc.getCharacteristic(p.notify)
				return { tx, rx }
			}
			throw makeError('NotFoundError', '设备上没有可识别的蓝牙透传服务')
		}

		function writeChunk(tx, bytes) {
			const props = tx.properties || {}
			if (props.writeWithoutResponse && typeof tx.writeValueWithoutResponse === 'function') return tx.writeValueWithoutResponse(bytes)
			if (typeof tx.writeValueWithResponse === 'function') return tx.writeValueWithResponse(bytes)
			return tx.writeValue(bytes)
		}

		return {
			// 全部字段进页面的设备指纹；不要放含 bluetooth 字样的键，common.js 对 web 后端的蓝牙 RFCOMM 口有拦截
			getInfo() { return { transport: 'ble', bleDeviceId: device.id || '', bleName: device.name || '' } },
			async open(options, sink) {
				conn++
				chain = Promise.resolve()
				server = await device.gatt.connect()
				try {
					const ch = await findProfile(server)
					txChar = ch.tx
					rxChar = ch.rx
					onValue = function (e) {
						const v = e && e.target && e.target.value
						if (!v) return
						// DataView 可能复用底层缓冲，拷一份再交出去
						sink.data(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)))
					}
					onGone = function () {
						conn++
						detach()
						sink.lost(makeError('NetworkError', '蓝牙连接已断开'))
					}
					rxChar.addEventListener('characteristicvaluechanged', onValue)
					device.addEventListener('gattserverdisconnected', onGone)
					await rxChar.startNotifications()
				} catch (e) {
					detach()
					try { server.disconnect() } catch (e2) {}
					server = null
					throw e
				}
			},
			write(u8) {
				const my = conn
				const tx = txChar
				const job = chain.then(async function () {
					for (let off = 0; off < u8.byteLength; off += chunkSize) {
						if (my !== conn || !tx) throw makeError('NetworkError', '蓝牙连接已断开')
						await writeChunk(tx, u8.slice(off, off + chunkSize))
					}
				})
				// 一次失败不能卡住之后的写入
				chain = job.catch(function () {})
				return job
			},
			async close() {
				conn++
				const rx = rxChar
				detach()
				if (rx) { try { await rx.stopNotifications() } catch (e) {} }
				if (server && server.connected !== false) server.disconnect()
				server = null
				txChar = null
				rxChar = null
			},
		}
	}

	// bluetooth: navigator.bluetooth 形状；adapter: SerialAdapter(取 createStreamPort)
	function createBleUartBackend(bluetooth, adapter, opts) {
		opts = opts || {}
		const profiles = opts.profiles || BLE_UART_PROFILES
		// 同一台设备始终给同一个端口对象：页面按对象身份认会话
		const ports = new Map()
		function portFor(device) {
			const key = device.id || device
			let port = ports.get(key)
			if (!port) {
				port = adapter.createStreamPort(createBleUartDriver(device, { profiles, chunkSize: opts.chunkSize }))
				ports.set(key, port)
			}
			return port
		}
		const services = profiles.map(function (p) { return p.service })
		return {
			name: opts.name || 'web-ble',
			kind: 'ble',
			supported: !!(bluetooth && typeof bluetooth.requestDevice === 'function'),
			async requestPort() {
				const device = await bluetooth.requestDevice({
					filters: services.map(function (s) { return { services: [s] } }),
					optionalServices: services,
				})
				return portFor(device)
			},
			// 已授权设备列表在 Chromium 里仍是实验接口，没有就不恢复上次的设备
			async getPorts() {
				if (typeof bluetooth.getDevices !== 'function') return []
				const devices = await bluetooth.getDevices()
				return devices.map(portFor)
			},
			// BLE 没有插拔事件；断线经端口的设备丢失(两条流置 null)交给页面的断线逻辑
		}
	}

	const lib = { BLE_UART_PROFILES, createBleUartDriver, createBleUartBackend }

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = lib
	}
	root.BleTransport = lib
	if (root.SerialAdapter && root.navigator && root.navigator.bluetooth) {
		root.SerialAdapter.register(createBleUartBackend(root.navigator.bluetooth, root.SerialAdapter))
	}
})(typeof window !== 'undefined' ? window : globalThis)
