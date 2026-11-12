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
	// Quick filters use advertisement metadata only; partial UUIDs are intentional here.
	function visibleDevices(devices, query = '', minimum = '', sort = 'signal') {
		const q = String(query).trim().toLowerCase(), min = String(minimum).trim()
		const threshold = min === '' ? null : Number(min)
		if (threshold !== null && (!Number.isFinite(threshold) || threshold < -127 || threshold > 20)) throw fail('最低 RSSI 须为 -127 到 20 dBm')
		return devices.filter(d => (!q || [d.name, d.alias, ...(d.services || [])].some(v => String(v || '').toLowerCase().includes(q))) &&
			(threshold === null || Number.isFinite(d.rssi) && d.rssi >= threshold)).sort((a, b) => {
			const byName = String(a.alias || a.name).localeCompare(String(b.alias || b.name))
			return (sort === 'name' ? byName : sort === 'recent' ? b.seen - a.seen : (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity)) || byName || a.deviceId.localeCompare(b.deviceId)
		})
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
		let generation, epoch = 0, busy = 0, initializing = true, releaseFailed = false, releasing = null
		let selected = null, pending = null, scanning = null
		const devices = new Map(), preferences = new Map()
		const ports = new Set(), choices = new Map()
		let latestPort = null
		const boundPorts = () => new Set(deps.boundPorts ? deps.boundPorts() : [])
		function prunePorts() {
			const bound = boundPorts()
			for (const [port, entry] of choices) {
				// Enumeration never closes resources or removes lane-bound/physically live entries.
				if (port !== latestPort && !bound.has(port) && !entry.active()) { choices.delete(port); ports.delete(port) }
			}
		}
		let ready = deps.invoke('ble_release_owned').then(g => { generation = g }).finally(() => { initializing = false })
		ready.catch(() => { releaseFailed = true })
		function check(token) { if (token !== epoch || deps.blocked()) throw fail('BLE 操作已取消或应用不可用') }
		async function call(fn) { busy++; try { return await fn() } finally { busy-- } }
		async function release() {
			if (releasing) return releasing
			epoch++
			if (scanning) scanning.accepting = false
			if (selected && selected.sink) selected.sink.lost(fail('BLE 会话已释放'))
			if (selected) selected.alive = false
			if (pending) pending.alive = false
			releasing = (async () => {
				await ready.catch(() => {})
				generation = await deps.invoke('ble_release_owned')
				ports.clear(); choices.clear(); latestPort = null
				selected = pending = null; devices.clear(); preferences.clear(); releaseFailed = false; ready = Promise.resolve()
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
		// abort: optional { aborted } owned by a stream port open; set before the native handle exists,
		// the "opening" event closes the pending connect as soon as Rust names it.
		async function inspect(device, abort) {
			const token = epoch
			return call(async () => {
				await ready; check(token)
				await stopScan(); check(token)
				if (abort && abort.aborted) throw fail('BLE 连接已取消')
				if (selected || pending || releaseFailed) throw fail('请先关闭现有 BLE 连接，或重试释放')
				const record = { device, handle: null, alive: true, sink: null, chars: [], token, lost: false }
				pending = record
				if (abort) abort.record = record
				const onData = new deps.Channel(), onEvent = new deps.Channel()
				onData.onmessage = bytes => { if (record.alive && token === epoch && record.sink) record.sink.data(deps.toBytes(bytes)) }
				onEvent.onmessage = e => {
					if (e.type === 'opening') {
						if (!record.alive || abort && abort.aborted) deps.invoke('ble_close', { handle: e.handle }).catch(() => {})
						else if (record.handle == null) record.handle = e.handle
						return
					}
					if (!record.alive || token !== epoch || e.type !== 'lost') return
					record.lost = true
					if (record.sink) record.sink.lost(fail('BLE 连接已断开'))
				}
				try {
					const result = await deps.invoke('ble_open', { deviceId: device.deviceId, ownerGeneration: generation, onData, onEvent })
					record.handle = result.handle; record.chars = result.characteristics
					check(token)
					if (abort && abort.aborted) throw fail('BLE 连接已取消')
					if (record.lost) throw fail('BLE 在发现服务期间断开')
					return record
				} catch (e) { await close(record); throw e }
			})
		}
		function createPort(record, profile, txId, rxId) {
			// Persist UUID/property selectors only. Instance IDs apply only to this first connection.
			const saved = JSON.parse(JSON.stringify(profile))
			let device = record.device
			const keyOf = s => [s.service, s.characteristic, s.props]
			const key = JSON.stringify([device.deviceId, keyOf(saved.tx), keyOf(saved.rx), saved.response])
			check(record.token)
			if (record !== pending || !record.alive || record.lost || record.handle == null) throw fail('BLE 发现连接已失效，请重新选择')
			// Reuse only an unbound, fully closed stream and a unique mapping. Ambiguous first-use
			// instance choices must get a fresh stream instead of mutating an older choice.
			let unique = false
			try { const ids = match(record.chars, saved); unique = ids.tx === txId && ids.rx === rxId } catch (_) {}
			const bound = boundPorts()
			for (const [port, entry] of choices) {
				if (!bound.has(port) && unique && entry.key === key && entry.canAdopt()) {
					entry.adopt(record, txId, rxId); latestPort = port; prunePorts()
					return { port, discard: () => entry.discard(record) }
				}
			}
			let live = record, first = true, initialIds = { tx: txId, rx: rxId }, closed = false, opening = null
			const port = deps.createStreamPort({
				getInfo() { return { transport: 'ble', productName: device.name + ' · BLE' } },
				async open(options, sink) {
					const abort = { aborted: false, record: first ? live : null }
					opening = abort
					return call(async () => {
						check(record.token)
						if (!first) live = await inspect(device, abort)
						const initial = first; first = false
						live.sink = sink
						try {
							if (abort.aborted) throw fail('BLE 连接已取消')
							if (!live.alive || live.lost || live.handle == null) throw fail('BLE 连接已失效，请重新选择')
							const ids = initial ? initialIds : match(live.chars, saved)
							await deps.invoke('ble_start', { handle: live.handle, profile: saved, txId: ids.tx, rxId: ids.rx })
							check(record.token)
							if (abort.aborted) throw fail('BLE 连接已取消')
							if (live.lost) throw fail('BLE 订阅期间断开')
							selected = live; if (pending === live) pending = null
							ports.add(port); choices.set(port, entry); prunePorts()
						} catch (e) { await close(live); throw e }
					}).finally(() => { if (opening === abort) opening = null })
				},
				// The lane's disconnect cancels a connect still in flight (e.g. auto-reopen after loss):
				// close the native task now instead of waiting for the OS connect to give up.
				abortOpen() {
					const abort = opening
					if (!abort) return
					abort.aborted = true
					const r = abort.record
					if (r && r.handle != null) return close(r).catch(() => {})
				},
				write(bytes) {
					check(record.token)
					if (!live || !live.alive || live.lost) return Promise.reject(fail('BLE 已断开'))
					return call(() => deps.invoke('ble_write', { handle: live.handle, data: Array.from(bytes) }))
				},
				close() { return close(live) },
			})
			const openPort = port.open.bind(port), closePort = port.close.bind(port)
			port.open = async options => { closed = false; return openPort(options) }
			port.close = async () => { await closePort(); closed = true; prunePorts() }
			const entry = {
				key,
				active: () => live.alive || !!live.closing,
				canAdopt: () => closed && !live.alive && !live.closing,
				adopt(next, tx, rx) {
					// The old record is already physically closed. Transfer the freshly inspected
					// record into this driver, so open/discard owns its handle and callbacks.
					live = next; device = next.device; first = true; initialIds = { tx, rx }; closed = false
				},
				async discard(expected) {
					if (live !== expected) return
					if (selected === live && boundPorts().has(port)) return
					await close(live)
					first = false; closed = !port.readable && !port.writable
					if (latestPort === port) latestPort = null
					prunePorts()
				},
			}
			choices.set(port, entry); latestPort = port; prunePorts()
			port.getDisplayAlias = () => preferences.get(device.deviceId)?.alias || null
			port.setDisplayAlias = alias => preferences.set(device.deviceId, { ...preferences.get(device.deviceId), alias })
			return { port, discard: () => entry.discard(record) }
		}
		function scan(onDevice = () => {}) {
			if (scanning || selected || pending || releaseFailed) return Promise.reject(fail('请先停止扫描或关闭现有 BLE 连接'))
			const token = epoch, onEvent = new deps.Channel()
			let started, failed
			const state = { token, accepting: true, started: new Promise((resolve, reject) => { started = resolve; failed = reject }) }
			state.started.catch(() => {})
			scanning = state
			onEvent.onmessage = event => {
				// Registration acknowledgement is also consumed after pause, so stop cannot race registration.
				if (event.type === 'started') { started(); return }
				if (!state.accepting || token !== epoch || deps.blocked() || event.type !== 'device') return
				const d = event.device, old = devices.get(d.deviceId)
				if (!old && devices.size >= 256) return
				const next = { ...old, ...d, name: d.name || old && old.name || '未命名 BLE 设备',
					services: Array.from(new Set([...(old && old.services || []), ...(d.services || [])])).slice(0, 64), seen: Date.now() }
				devices.set(d.deviceId, next); onDevice({ ...next, ...preferences.get(d.deviceId) })
			}
			state.task = call(async () => {
				try { await ready; check(token); await deps.invoke('ble_scan', { ownerGeneration: generation, onDevice: onEvent }); check(token); started() }
				catch (e) { failed(e); throw e }
				finally { state.accepting = false; if (scanning === state) scanning = null }
			})
			return state.task
		}
		async function stopScan() {
			const state = scanning
			if (!state) return
			state.accepting = false
			return call(async () => {
				try {
					await state.started
					await deps.invoke('ble_scan_stop', { ownerGeneration: generation })
					await state.task
				} catch (e) { if (state.token === epoch) releaseFailed = true; throw e }
			})
		}
		return {
			scan, stopScan,
			devices: () => Array.from(devices.values(), d => ({ ...d, ...preferences.get(d.deviceId) })),
			preference: id => preferences.get(id) || {},
			remember(id, value) { if (devices.has(id)) preferences.set(id, { ...preferences.get(id), ...value }) },
			canSelect: () => !selected && !pending && !releaseFailed,
			canRetryRelease: () => releaseFailed && !selected,
			releasePicker() { if (selected) return Promise.reject(fail('请使用本路断开关闭已连接设备')); return release() },
			inspect, createPort, close, release, ports: () => { prunePorts(); return Array.from(ports) },
			isBusyForUpdate: () => !!(initializing || scanning || busy || pending || releasing || releaseFailed),
		}
	}
	const api = { create, uuid, filterDevices, visibleDevices, selector, mapping, match }
	root.NativeBle = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
