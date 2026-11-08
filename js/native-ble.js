// Native computer BLE service. Device selection/GATT mapping are UI; byte streams belong to SerialHub.
;(function (root) {
	'use strict'
	const fail = message => new Error(message)
	const uuid = value => {
		const s = String(value || '').trim().toLowerCase()
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : null
	}
	function filterDevices(devices, name, service) {
		const query = String(name || '').trim().toLowerCase(), u = service ? uuid(service) : null
		if (service && !u) throw fail('广播服务筛选须为完整 128-bit UUID')
		return devices.filter(d => (!query || d.name.toLowerCase().includes(query)) && (!u || d.services.includes(u)))
	}
	function selector(c) { return { service: c.service, characteristic: c.characteristic, props: c.props } }
	function mapping(chars, txId, rxId, response) {
		const tx = chars.find(c => String(c.id) === String(txId)), rx = chars.find(c => String(c.id) === String(rxId))
		if (!tx || !rx || !(tx.props & (response ? 8 : 4)) || !(rx.props & 48)) throw fail('请选择支持当前写模式的 TX 和支持通知 / 指示的 RX')
		return { tx: selector(tx), rx: selector(rx), response: !!response }
	}
	function match(chars, saved) {
		const find = s => {
			const list = s && chars.filter(c => c.service === s.service && c.characteristic === s.characteristic && c.props === s.props)
			if (!list || list.length !== 1) throw fail('保存的 UUID / 属性不匹配或实例不唯一，请重新选择 TX/RX')
			return list[0].id
		}
		if (!saved || typeof saved.response !== 'boolean') throw fail('没有有效的已保存映射')
		const tx = find(saved.tx), rx = find(saved.rx)
		mapping(chars, tx, rx, saved.response)
		return { tx, rx }
	}
	function create(deps) {
		const namespace = root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Math.random().toString(36).slice(2)
		let generation, epoch = 0, busy = 0, initializing = true, releaseFailed = false, releasing = null
		let selected = null, pending = null
		const ports = new Set()
		let ready = deps.invoke('ble_release_owned').then(g => { generation = g }).finally(() => { initializing = false })
		ready.catch(() => { releaseFailed = true })
		function check(token) { if (token !== epoch || deps.blocked()) throw fail('BLE 操作已取消或应用不可用') }
		async function call(fn) { busy++; try { return await fn() } finally { busy-- } }
		async function release() {
			if (releasing) return releasing
			epoch++
			if (selected && selected.sink) selected.sink.lost(fail('BLE 会话已释放'))
			if (selected) selected.alive = false
			if (pending) pending.alive = false
			releasing = (async () => {
				await ready.catch(() => {})
				generation = await deps.invoke('ble_release_owned')
				ports.clear()
				selected = pending = null; releaseFailed = false; ready = Promise.resolve()
			})().catch(e => { releaseFailed = true; throw e }).finally(() => { releasing = null })
			return releasing
		}
		async function close(record) {
			if (!record) return
			if (record.closing) return record.closing
			record.closing = call(async () => {
				if (record.handle != null) await deps.invoke('ble_close', { handle: record.handle })
				record.alive = false; record.handle = null
				releaseFailed = false
				if (selected === record) selected = null
				if (pending === record) pending = null
			}).catch(e => { releaseFailed = true; throw e }).finally(() => { record.closing = null })
			return record.closing
		}
		async function inspect(device) {
			const token = epoch
			return call(async () => {
				await ready; check(token)
				if (selected || pending || releaseFailed) throw fail('请先关闭现有电脑 BLE 连接，或重试释放')
				const record = { device, handle: null, alive: true, sink: null, chars: [], token, lost: false }
				pending = record
				const onData = new deps.Channel(), onEvent = new deps.Channel()
				onData.onmessage = bytes => { if (record.alive && token === epoch && record.sink) record.sink.data(deps.toBytes(bytes)) }
				onEvent.onmessage = e => {
					if (!record.alive || token !== epoch || e.type !== 'lost') return
					record.lost = true
					if (record.sink) record.sink.lost(fail('BLE 连接已断开'))
				}
				try {
					const result = await deps.invoke('ble_open', { deviceId: device.deviceId, ownerGeneration: generation, onData, onEvent })
					record.handle = result.handle; record.chars = result.characteristics
					check(token)
					if (record.lost) throw fail('BLE 在发现服务期间断开')
					return record
				} catch (e) { await close(record); throw e }
			})
		}
		function createPort(record, profile, txId, rxId) {
			// Persist UUID/property selectors only. Instance IDs apply only to this first connection.
			const saved = JSON.parse(JSON.stringify(profile)), device = record.device
			let live = record, first = true
			const port = deps.createStreamPort({
				getInfo() { return { transport: 'ble', productName: device.name + ' · 电脑 BLE', serialNumber: namespace + ':' + device.deviceId } },
				async open(options, sink) {
					return call(async () => {
						check(record.token)
						if (!first) live = await inspect(device)
						const initial = first; first = false
						live.sink = sink
						try {
							if (!live.alive || live.lost || live.handle == null) throw fail('BLE 连接已失效，请重新选择')
							const ids = initial ? { tx: txId, rx: rxId } : match(live.chars, saved)
							await deps.invoke('ble_start', { handle: live.handle, profile: saved, txId: ids.tx, rxId: ids.rx })
							check(record.token)
							if (live.lost) throw fail('BLE 订阅期间断开')
							selected = live; if (pending === live) pending = null
							ports.add(port)
						} catch (e) { await close(live); throw e }
					})
				},
				write(bytes) {
					check(record.token)
					if (!live || !live.alive || live.lost) return Promise.reject(fail('BLE 已断开'))
					return call(() => deps.invoke('ble_write', { handle: live.handle, data: Array.from(bytes) }))
				},
				close() { return close(live) },
			})
			return { port, discard: async () => { await close(live); ports.delete(port) } }
		}
		return {
			async scan() {
				const token = epoch
				return call(async () => { await ready; check(token); const list = await deps.invoke('ble_scan', { ownerGeneration: generation }); check(token); return list })
			},
			canSelect: () => !selected && !pending && !releaseFailed,
			inspect, createPort, close, release, ports: () => Array.from(ports),
			isBusyForUpdate: () => !!(initializing || busy || pending || releasing || releaseFailed),
		}
	}
	const api = { create, uuid, filterDevices, selector, mapping, match }
	root.NativeBle = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
