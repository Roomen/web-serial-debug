// Native computer BLE service. Device selection/GATT mapping are UI; byte streams belong to SerialHub.
;(function (root) {
	'use strict'
	const STALE_MS = 15000
	const MAX_DEVICES = 256
	const MAX_SAVED_DEVICES = 128
	const SAVED_KEY = 'bleSavedDevices'
	const FFE1_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb'
	const FFE2_UUID = '0000ffe2-0000-1000-8000-00805f9b34fb'
	const fail = message => new Error(message)
	const uuid = value => {
		const s = String(value || '').trim().toLowerCase()
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : null
	}
	function shortUuid(value) {
		const s = String(value || '').trim().toLowerCase()
		const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(s)
		return m ? m[1].toUpperCase() : String(value || '').trim()
	}
	function filterDevices(devices, name, service) {
		const query = String(name || '').trim().toLowerCase(), u = service ? uuid(service) : null
		if (service && !u) throw fail('广播服务筛选须为完整 128-bit UUID')
		return devices.filter(d => (!query || d.name.toLowerCase().includes(query)) && (!u || d.services.includes(u)))
	}
	// Quick filters use advertisement metadata only; partial UUIDs are intentional here.
	function visibleDevices(devices, query = '', minimum = '', sort = 'signal', opts = null) {
		const q = String(query).trim().toLowerCase(), min = String(minimum).trim()
		const threshold = min === '' ? null : Number(min)
		if (threshold !== null && (!Number.isFinite(threshold) || threshold < -127 || threshold > 20)) throw fail('最低 RSSI 须为 -127 到 20 dBm')
		const staleMs = opts && Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 0
		const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now()
		return devices.filter(d => {
			if (staleMs > 0 && Number.isFinite(d.seen) && (now - d.seen) > staleMs) return false
			if (q) {
				const haystack = [d.name, d.alias, d.savedName, d.address, ...(d.services || []), ...(d.services || []).map(shortUuid)]
				if (!haystack.some(v => String(v || '').toLowerCase().includes(q))) return false
			}
			if (threshold !== null && !(Number.isFinite(d.rssi) && d.rssi >= threshold)) return false
			return true
		}).sort((a, b) => {
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
	// Default mapping for common FFE1/FFE2 UART services: prefer FFE1=RX, FFE2=TX; fall back to
	// reverse direction only when properties strictly force it. Ambiguous multi-service matches return null.
	function defaultMapping(chars) {
		if (!Array.isArray(chars) || !chars.length) return null
		const byService = new Map()
		for (const c of chars) {
			const svc = String(c.service || '').toLowerCase()
			if (!byService.has(svc)) byService.set(svc, [])
			byService.get(svc).push(c)
		}
		const candidates = []
		for (const list of byService.values()) {
			const ffe1 = list.filter(c => String(c.characteristic || '').toLowerCase() === FFE1_UUID)
			const ffe2 = list.filter(c => String(c.characteristic || '').toLowerCase() === FFE2_UUID)
			if (ffe1.length === 1 && ffe2.length === 1) candidates.push({ ffe1: ffe1[0], ffe2: ffe2[0] })
		}
		if (candidates.length !== 1) return null
		const { ffe1, ffe2 } = candidates[0]
		let rx = null, tx = null
		if ((ffe1.props & 48) && (ffe2.props & 12)) { rx = ffe1; tx = ffe2 }
		else if ((ffe2.props & 48) && (ffe1.props & 12)) { rx = ffe2; tx = ffe1 }
		else return null
		return { txId: tx.id, rxId: rx.id, response: !!(tx.props & 8) }
	}
	function isValidSelector(s) {
		return !!(s && typeof s.service === 'string' && typeof s.characteristic === 'string' && Number.isInteger(s.props))
	}
	function isValidProfile(p) {
		return !!(p && typeof p.response === 'boolean' && isValidSelector(p.tx) && isValidSelector(p.rx))
	}
	function create(deps) {
		let generation, epoch = 0, busy = 0, initializing = true, releaseFailed = false, releasing = null
		let selected = null, pending = null, scanning = null, deviceSeq = 0
		const devices = new Map(), preferences = new Map()
		const ports = new Set(), choices = new Map()
		const savedMap = new Map(), savedPorts = new Map()
		let latestPort = null
		const storage = deps.storage !== undefined ? deps.storage : null
		const boundPorts = () => new Set(deps.boundPorts ? deps.boundPorts() : [])

		function parseSavedList(raw) {
			const out = new Map()
			if (!raw) return out
			try {
				const parsed = JSON.parse(raw)
				if (!Array.isArray(parsed)) return out
				for (const item of parsed) {
					if (!item || typeof item.persistentId !== 'string' || !item.persistentId) continue
					out.set(item.persistentId, {
						persistentId: item.persistentId,
						address: typeof item.address === 'string' && item.address ? item.address : null,
						alias: typeof item.alias === 'string' ? item.alias.trim().slice(0, 32) : '',
						broadcastName: typeof item.broadcastName === 'string' ? item.broadcastName.trim().slice(0, 128) : '',
						profile: isValidProfile(item.profile) ? JSON.parse(JSON.stringify(item.profile)) : null,
						updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
					})
				}
			} catch (_) {}
			return out
		}
		function reloadSavedFromStorage() {
			if (!storage) return
			const latest = parseSavedList(storage.getItem(SAVED_KEY))
			savedMap.clear()
			for (const [pid, item] of latest) {
				savedMap.set(pid, item)
				if (item.profile) ensureSavedPort(pid)
			}
			prunePorts()
		}
		function mutateSaved(mutator) {
			// Reload latest snapshot before writing so multiple windows never clobber each other's saved devices.
			if (storage) {
				const latest = parseSavedList(storage.getItem(SAVED_KEY))
				savedMap.clear()
				for (const [pid, item] of latest) savedMap.set(pid, item)
			}
			const result = mutator()
			if (savedMap.size > MAX_SAVED_DEVICES) {
				const kept = Array.from(savedMap.values())
					.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
					.slice(0, MAX_SAVED_DEVICES)
				savedMap.clear()
				for (const item of kept) savedMap.set(item.persistentId, item)
			}
			if (storage) {
				try { storage.setItem(SAVED_KEY, JSON.stringify(Array.from(savedMap.values()))) } catch (_) {}
			}
			for (const [pid, item] of savedMap) {
				if (item.profile) ensureSavedPort(pid)
			}
			prunePorts()
			return result
		}
		function findScannedByPersistentId(pid) {
			if (!pid) return null
			for (const d of devices.values()) if (d.persistentId === pid) return d
			return null
		}
		function mergeDevice(d) {
			const pref = preferences.get(d.deviceId) || {}
			const saved = d.persistentId ? savedMap.get(d.persistentId) : null
			const alias = pref.alias || (saved && saved.alias) || ''
			const savedName = (saved && saved.broadcastName) || ''
			const savedProfile = pref.profile || (saved && saved.profile) || null
			const nameChanged = !!(saved && savedName && d.name && d.name !== '未命名 BLE 设备' && d.name !== savedName)
			return { ...d, ...pref, alias, savedName, savedProfile, isSaved: !!saved, nameChanged }
		}
		function prunePorts() {
			const bound = boundPorts()
			for (const [port, entry] of choices) {
				// Enumeration never closes resources or removes lane-bound/physically live entries.
				if (port !== latestPort && !bound.has(port) && !entry.active()) { choices.delete(port); ports.delete(port) }
			}
			for (const [pid, item] of savedPorts) {
				if (!savedMap.has(pid) && !bound.has(item.port) && !item.active()) savedPorts.delete(pid)
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
				const record = { device, handle: null, alive: true, sink: null, chars: [], deviceName: null, token, lost: false }
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
					const payload = { deviceId: device.deviceId, ownerGeneration: generation, onData, onEvent }
					if (device.persistentId) payload.persistentId = device.persistentId
					const result = await deps.invoke('ble_open', payload)
					record.handle = result.handle; record.chars = result.characteristics
					check(token)
					if (abort && abort.aborted) throw fail('BLE 连接已取消')
					if (record.lost) throw fail('BLE 在发现服务期间断开')
					return record
				} catch (e) { await close(record); throw e }
			})
		}
		function ensureSavedPort(pid) {
			const existing = savedPorts.get(pid)
			if (existing) return existing
			let live = null, opening = null, closed = true
			let adoptedRecord = null, adoptedIds = null
			const port = deps.createStreamPort({
				getInfo() {
					const s = savedMap.get(pid) || {}
					return {
						transport: 'ble',
						productName: (s.broadcastName || 'BLE 设备') + ' · BLE',
						bleSaved: true,
						blePersistentId: pid,
						bleAddress: s.address || '',
					}
				},
				async open(options, sink) {
					const s = savedMap.get(pid)
					if (!s || !s.profile) throw fail('已保存的 BLE 设备缺少收发映射，请通过「BLE」重新选择')
					const abort = { aborted: false, record: adoptedRecord }
					opening = abort
					return call(async () => {
						const token = epoch
						check(token)
						let initial = false, ids = null
						if (adoptedRecord) {
							live = adoptedRecord; ids = adoptedIds; initial = true
							adoptedRecord = null; adoptedIds = null
						} else {
							const scanned = findScannedByPersistentId(pid)
							const target = scanned ? { ...scanned } : { deviceId: 'saved:' + pid, persistentId: pid, address: s.address, name: s.broadcastName || 'BLE 设备' }
							live = await inspect(target, abort)
						}
						live.sink = sink
						try {
							if (abort.aborted) throw fail('BLE 连接已取消')
							if (!live.alive || live.lost || live.handle == null) throw fail('BLE 连接已失效，请重新选择')
							if (!initial) {
								// Only compare real advertisement names observed in this session; never substitute OS/GAP device names.
								const scanned = findScannedByPersistentId(pid)
								const advertisedName = scanned && scanned.name && scanned.name !== '未命名 BLE 设备' ? scanned.name : ''
								if (s.broadcastName && advertisedName && advertisedName !== s.broadcastName && deps.confirmNameChange) {
									const ok = await deps.confirmNameChange({ alias: s.alias, savedName: s.broadcastName, currentName: advertisedName, address: s.address })
									check(token)
									if (abort.aborted) throw fail('BLE 连接已取消')
									if (!ok) throw fail('已取消连接：设备广播名已变化')
									mutateSaved(() => {
										const cur = savedMap.get(pid)
										if (cur) { cur.broadcastName = advertisedName; cur.updatedAt = Date.now() }
									})
								}
								ids = match(live.chars, s.profile)
							}
							await deps.invoke('ble_start', { handle: live.handle, profile: s.profile, txId: ids.tx, rxId: ids.rx })
							check(token)
							if (abort.aborted) throw fail('BLE 连接已取消')
							if (live.lost) throw fail('BLE 订阅期间断开')
							selected = live; if (pending === live) pending = null
							closed = false
						} catch (e) { await close(live); throw e }
					}).finally(() => { if (opening === abort) opening = null })
				},
				abortOpen() {
					const abort = opening
					if (!abort) return
					abort.aborted = true
					const r = abort.record
					if (r && r.handle != null) return close(r).catch(() => {})
				},
				write(bytes) {
					if (!live || !live.alive || live.lost) return Promise.reject(fail('BLE 已断开'))
					check(live.token)
					return call(() => deps.invoke('ble_write', { handle: live.handle, data: Array.from(bytes) }))
				},
				async close() { await close(live); closed = true; prunePorts() },
			})
			port.getDisplayAlias = () => { const s = savedMap.get(pid); return (s && s.alias) || null }
			port.isPersistentAlias = () => true
			port.setDisplayAlias = alias => {
				const trimmed = String(alias || '').trim().slice(0, 32)
				mutateSaved(() => {
					const s = savedMap.get(pid)
					if (s) { s.alias = trimmed; s.updatedAt = Date.now() }
				})
			}
			const item = {
				port,
				active: () => !!(live && (live.alive || live.closing)) || !!(adoptedRecord && (adoptedRecord.alive || adoptedRecord.closing)),
				canAdopt: () => closed && !(live && (live.alive || live.closing)) && !adoptedRecord,
				adopt(next, tx, rx) {
					adoptedRecord = next; adoptedIds = { tx, rx }; closed = false
				},
				async discard(expected) {
					if (adoptedRecord === expected) { adoptedRecord = null; adoptedIds = null }
					if (live === expected && selected === live && boundPorts().has(port)) return
					await close(expected)
					closed = !port.readable && !port.writable
					prunePorts()
				},
			}
			savedPorts.set(pid, item)
			return item
		}
		function createPort(record, profile, txId, rxId) {
			// Persist UUID/property selectors only. Instance IDs apply only to this first connection.
			const saved = JSON.parse(JSON.stringify(profile))
			let device = record.device
			const keyOf = s => [s.service, s.characteristic, s.props]
			const key = JSON.stringify([device.deviceId, keyOf(saved.tx), keyOf(saved.rx), saved.response])
			check(record.token)
			if (record !== pending || !record.alive || record.lost || record.handle == null) throw fail('BLE 发现连接已失效，请重新选择')
			// If this device is saved persistently and its saved port is free, adopt it to avoid duplicate dropdown rows.
			const pid = device.persistentId
			if (pid && savedMap.has(pid) && savedMap.get(pid).profile) {
				const sp = ensureSavedPort(pid)
				const bound = boundPorts()
				if (!bound.has(sp.port) && sp.canAdopt()) {
					sp.adopt(record, txId, rxId)
					prunePorts()
					return { port: sp.port, discard: () => sp.discard(record) }
				}
			}
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
				getInfo() { return { transport: 'ble', productName: device.name + ' · BLE', blePersistentId: device.persistentId || '', bleAddress: device.address || '' } },
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
				// The lane's disconnect cancels a connect still in flight (e.g. a manual open while
				// the OS connect is pending): close the native task now instead of waiting for the
				// OS connect to give up.
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
				async close() { await close(live); closed = true; prunePorts() },
			})
			const openPort = port.open.bind(port)
			port.open = async options => { closed = false; return openPort(options) }
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
			port.getDisplayAlias = () => {
				const pref = preferences.get(device.deviceId)
				if (pref && pref.alias) return pref.alias
				const s = device.persistentId && savedMap.get(device.persistentId)
				return (s && s.alias) || null
			}
			port.isPersistentAlias = () => !!(device.persistentId && savedMap.has(device.persistentId))
			port.setDisplayAlias = alias => {
				const trimmed = String(alias || '').trim().slice(0, 32)
				preferences.set(device.deviceId, { ...preferences.get(device.deviceId), alias: trimmed })
				if (device.persistentId && savedMap.has(device.persistentId)) {
					mutateSaved(() => {
						const s = savedMap.get(device.persistentId)
						if (s) { s.alias = trimmed; s.updatedAt = Date.now() }
					})
				}
			}
			return { port, discard: () => entry.discard(record) }
		}
		function evictOldestScanned() {
			const protectedIds = new Set([selected && selected.device && selected.device.deviceId, pending && pending.device && pending.device.deviceId].filter(Boolean))
			let oldestId = null, oldestSeen = Infinity
			for (const [id, d] of devices) {
				if (protectedIds.has(id)) continue
				if ((d.seen || 0) < oldestSeen) { oldestSeen = d.seen || 0; oldestId = id }
			}
			if (oldestId !== null) { devices.delete(oldestId); return true }
			return false
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
				if (!old && devices.size >= MAX_DEVICES) {
					if (!evictOldestScanned() || devices.size >= MAX_DEVICES) return
				}
				const seq = old && old.seq ? old.seq : ++deviceSeq
				const next = { ...old, ...d, seq, name: d.name || old && old.name || '未命名 BLE 设备',
					services: Array.from(new Set([...(old && old.services || []), ...(d.services || [])])).slice(0, 64), seen: Date.now() }
				devices.set(d.deviceId, next); onDevice(mergeDevice(next))
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
		function saveDevice(device, data = {}) {
			if (!device) return null
			const trimmedAlias = data.alias !== undefined ? String(data.alias || '').trim().slice(0, 32) : undefined
			if (device.deviceId && devices.has(device.deviceId)) {
				const pref = { ...preferences.get(device.deviceId) }
				if (trimmedAlias !== undefined) pref.alias = trimmedAlias
				if (data.profile !== undefined) pref.profile = JSON.parse(JSON.stringify(data.profile))
				preferences.set(device.deviceId, pref)
			}
			const pid = device.persistentId
			if (!pid) return null
			return mutateSaved(() => {
				const prev = savedMap.get(pid) || {}
				const broadcastName = (data.broadcastName || (device.name && device.name !== '未命名 BLE 设备' ? device.name : '') || prev.broadcastName || '').trim().slice(0, 128)
				const next = {
					persistentId: pid,
					address: device.address || prev.address || null,
					alias: trimmedAlias !== undefined ? trimmedAlias : (prev.alias || ''),
					broadcastName,
					profile: data.profile !== undefined ? (data.profile ? JSON.parse(JSON.stringify(data.profile)) : null) : (prev.profile || null),
					updatedAt: Date.now(),
				}
				savedMap.set(pid, next)
				return { ...next }
			})
		}
		function removeSavedDevice(pid) {
			if (!pid) return false
			return mutateSaved(() => savedMap.delete(pid))
		}
		reloadSavedFromStorage()
		if (storage && typeof root.addEventListener === 'function') {
			root.addEventListener('storage', e => {
				if (e && e.key === SAVED_KEY) reloadSavedFromStorage()
			})
		}
		return {
			scan, stopScan,
			clearDevices: () => { devices.clear() },
			devices: () => Array.from(devices.values(), mergeDevice),
			savedDevices: () => { reloadSavedFromStorage(); return Array.from(savedMap.values(), s => ({ ...s })) },
			savedDevice: pid => { reloadSavedFromStorage(); const s = pid ? savedMap.get(pid) : null; return s ? { ...s } : null },
			saveDevice, removeSavedDevice,
			preference: id => {
				const pref = preferences.get(id) || {}
				const d = devices.get(id)
				const s = d && d.persistentId ? savedMap.get(d.persistentId) : null
				if (!s) return { ...pref }
				return { alias: pref.alias || s.alias || '', profile: pref.profile || s.profile || null }
			},
			remember(id, value) {
				if (!devices.has(id)) return
				preferences.set(id, { ...preferences.get(id), ...value })
			},
			canSelect: () => !selected && !pending && !releaseFailed,
			canRetryRelease: () => releaseFailed && !selected,
			releasePicker() { if (selected) return Promise.reject(fail('请使用本路断开关闭已连接设备')); return release() },
			inspect, createPort, close, release,
			ports: () => {
				prunePorts()
				const list = Array.from(ports)
				const activePids = new Set(list.map(p => p.getInfo && p.getInfo().blePersistentId).filter(Boolean))
				for (const [pid, item] of savedPorts) {
					if (savedMap.has(pid) && savedMap.get(pid).profile && !activePids.has(pid) && !list.includes(item.port)) list.push(item.port)
				}
				return list
			},
			isBusyForUpdate: () => !!(initializing || scanning || busy || pending || releasing || releaseFailed),
		}
	}
	const api = { STALE_MS, create, uuid, shortUuid, filterDevices, visibleDevices, selector, mapping, match, defaultMapping }
	root.NativeBle = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
