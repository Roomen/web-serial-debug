// Native assembly helper. All device handles use the existing Rust serial owner/lease registry.
;(function (root) {
	'use strict'
	function toBytes(value) {
		if (value instanceof Uint8Array) return value
		if (value instanceof ArrayBuffer) return new Uint8Array(value)
		if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
		return Array.isArray(value) ? Uint8Array.from(value) : new Uint8Array(0)
	}
	function create(deps) {
		const ids = new Map(), namespace = Math.random().toString(36).slice(2)
		let count = 0, orphan = null, initializing = true, readyFailed = false
		const ready = Promise.resolve().then(() => deps.ready()).then(() => { initializing = false }, e => { initializing = false; readyFailed = true; throw e })
		ready.catch(() => {})
		async function closeOrphan() { if (orphan != null) { await deps.invoke('serial_close', { handle: orphan }); orphan = null } }
		const identity = d => JSON.stringify([d.path, d.vendorId, d.productId, d.serialNumber || ''])
		async function ports() {
			const list = await deps.invoke('serial_list'), present = new Set(list.map(identity))
			for (const [id, d] of ids) if (!present.has(identity(d))) ids.delete(id)
			return list.map(d => {
				let found = Array.from(ids).find(([, old]) => identity(old) === identity(d))
				if (!found) { found = [namespace + ':bridge:' + (++count), d]; ids.set(...found) }
				return { deviceId: found[0], name: d.product || d.name || 'USB 串口桥', portName: d.name, vid: d.vendorId, pid: d.productId }
			})
		}
		return deps.BleBridge.create({
			isBusyForUpdate: () => initializing || readyFailed || orphan != null,
			namespace, ports, blocked: deps.blocked, closeOrphan, createStreamPort: deps.createStreamPort,
			async open(id, data, lost, check, recover) {
				await ready; check()
				await closeOrphan(); check()
				await ports(); check()
				const desc = ids.get(id)
				if (!desc) throw Object.assign(new Error('桥口已变化，请重新枚举'), { code: 'stale_device_id' })
				const onData = new deps.Channel(), onEvent = new deps.Channel()
				let alive = true, handle = null
				onData.onmessage = bytes => { if (alive) data(toBytes(bytes)) }
				onEvent.onmessage = event => {
					if (!alive || !event) return
					if (event.type === 'lost') lost()
					else if (event.type === 'error') recover()
				}
				try {
					handle = await deps.invoke('serial_open', { path: desc.path, options: { baudRate: 2000000, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }, onData, onEvent })
					check()
					await deps.invoke('serial_set_signals', { handle, signals: { dataTerminalReady: false, requestToSend: false } }); check()
				} catch (e) {
					alive = false
					if (handle != null) { orphan = handle; await closeOrphan() }
					throw e
				}
				return {
					write(bytes) { return deps.invoke('serial_write', { handle, data: Array.from(bytes) }) },
					async close() { alive = false; orphan = handle; await closeOrphan() },
				}
			},
		})
	}
	root.NativeBleBridge = { create, toBytes }
	if (typeof module !== 'undefined' && module.exports) module.exports = { create, toBytes }
})(typeof window !== 'undefined' ? window : globalThis)
