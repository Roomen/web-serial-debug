// Independent Classic SPP service. All UI/MCP operations share this queue and stream contract.
;(function (root) {
	'use strict'
	const fail = (code, message) => Object.assign(new Error(message || code), { code })
	function create(deps) {
		if (!root.crypto || (!root.crypto.randomUUID && !root.crypto.getRandomValues)) throw fail('crypto_unavailable')
		const namespace = root.crypto.randomUUID ? root.crypto.randomUUID() :
			Array.from(root.crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('')
		let epoch = 0, generation = 0, port = null, reader = null, phase = 'idle', devices = [], tail = Promise.resolve(), queued = 0
		let external = null
		const lanePorts = new Set(), aliases = new Map(), lanePortByDevice = new Map()
		let next = 0, base = 0, bytes = [], error = '', releasePromise = null
		const listeners = new Set()
		const notify = () => { for (const fn of listeners) fn() }
		let nativeGeneration = null, initializing = true, closing = 0, closeFailed = false
		let ready = deps.invoke('classic_release_owned').then(value => { nativeGeneration = value }).finally(() => { initializing = false })
		ready.catch(e => { phase = 'close-failed'; error = String(e.message || e); notify() })
		function state() { return { phase: external ? (external.handle == null ? 'lane-opening' : 'lane-connected') : phase, generation, received: next, error, interactionRequired: true, laneOwned: !!external } }
		async function release() {
			if (releasePromise) return releasePromise
			epoch++; generation++; if (external && external.sink) external.sink.lost(fail('device_lost')); bytes = []; base = next = 0; phase = 'closing'; notify()
			releasePromise = (async () => {
				await ready.catch(() => {})
				// Rust invalidates pending opens/discovery and drains physical channels; failure remains retryable.
				nativeGeneration = await deps.invoke('classic_release_owned')
				ready = Promise.resolve()
				if (reader) await reader.cancel().catch(() => {})
				reader = null; port = null; external = null; lanePorts.clear(); lanePortByDevice.clear(); aliases.clear(); devices = []; bytes = []; base = next = 0; phase = 'idle'; error = ''; closeFailed = false; notify()
			})().catch(e => { phase = 'close-failed'; error = String(e.message || e); notify(); throw e }).finally(() => { releasePromise = null })
			return releasePromise
		}
		function read(p = {}) {
			if (external) throw fail('lane_owned', 'SPP 已接入通信会话，请使用 serial_read')
			const prefix = namespace + ':' + epoch + ':' + generation + ':'
			let offset = base
			if (p.cursor != null) {
				if (typeof p.cursor !== 'string' || !p.cursor.startsWith(prefix) || !/^\d+$/.test(p.cursor.slice(prefix.length))) throw fail('stale_cursor')
				offset = Number(p.cursor.slice(prefix.length))
				if (!Number.isSafeInteger(offset) || offset > next) throw fail('stale_cursor')
			}
			const dropped = Math.max(0, base - offset); offset = Math.max(base, offset)
			const data = bytes.slice(offset - base, offset - base + 4096)
			return { generation, cursor: prefix + (offset + data.length), hex: data.map(n => n.toString(16).padStart(2, '0')).join(''), dropped, hasMore: offset + data.length < next }
		}
		async function run(action, p = {}, guard) {
			if (queued >= 8) throw fail('queue_full')
			queued++; const token = epoch; let poll = null
			const task = tail.then(async () => {
				const checkConnection = () => {
					if (token !== epoch) throw fail('stale_generation')
					if (deps.blocked()) throw fail('app_unavailable')
				}
				const check = () => {
					checkConnection()
					const denied = guard && guard.step(); if (denied) throw fail(denied.code, denied.message)
				}
				await ready; check()
				if (external && deps.isPinned && deps.isPinned()) throw fail('transaction_pinned', '通信事务进行中，请先停止事务再操作 SPP')
				if (guard) { const denied = await guard.start(); if (denied) throw fail(denied.code, denied.message); check(); poll = setInterval(() => { if (token === epoch && guard.step()) release().catch(() => {}) }, 100) }
				if (action === 'discover' || action === 'pair') {
					phase = 'system-dialog'; notify()
					try {
						const chosen = await deps.invoke('classic_discover', { pair: action === 'pair', ownerGeneration: nativeGeneration }); check()
						const selected = await deps.invoke('classic_devices'); check(); devices = selected; phase = port ? 'connected' : 'idle'; notify()
						return { devices: devices.map(d => ({ ...d })), selectedDeviceId: chosen && chosen.deviceId, interactionRequired: true }
					} catch (e) { if (token === epoch) { phase = port ? 'connected' : 'idle'; error = String(e.message || e); notify() } throw e }
				}
				if (action === 'close') { await release(); return { closed: true } }
				if (action === 'connect') {
					if (port || external || phase === 'close-failed') throw fail('already_open')
					if (!devices.some(d => d.deviceId === p.deviceId && d.paired)) throw fail('pairing_required', '请先在系统窗口配对并重新选择设备')
					phase = 'opening'; generation++; bytes = []; base = next = 0; notify()
					let handle = null, alive = true
					const stream = deps.createStreamPort({
						async open(options, sink) {
							const onData = new deps.Channel(), onEvent = new deps.Channel()
							onData.onmessage = value => { if (alive && token === epoch) sink.data(deps.toBytes(value)) }
							onEvent.onmessage = e => { if (alive && token === epoch && e.type === 'lost') { sink.lost(fail('device_lost')); phase = 'disconnected'; notify() } }
							handle = await deps.invoke('classic_open', { deviceId: p.deviceId, ownerGeneration: nativeGeneration, onData, onEvent }); check()
						},
						write(data) { checkConnection(); return deps.invoke('classic_write', { handle, data: Array.from(data) }) },
						async close() {
							alive = false; closing++
							try { await deps.invoke('classic_release_owned'); closeFailed = false }
							catch (e) { closeFailed = true; throw e } finally { closing-- }
						},
					})
					try { await stream.open({ bufferSize: 1048576 }); check() }
					catch (e) { if (token === epoch) await release(); throw e }
					port = stream; phase = 'connected'; error = ''; const r = stream.readable.getReader(); reader = r; notify()
					;(async () => {
						try { while (token === epoch) { const packet = await r.read(); if (packet.done) break; if (token !== epoch) break; for (const byte of packet.value) bytes.push(byte); next += packet.value.length; if (bytes.length > 1048576) { const n = bytes.length - 1048576; bytes.splice(0, n); base += n } notify() } }
						catch (e) { if (token === epoch) { error = e.message || String(e); phase = 'disconnected'; notify() } }
						finally { r.releaseLock(); if (reader === r) reader = null }
					})()
					return state()
				}
				if (action === 'write') {
					if (p.generation !== generation || !port || !port.writable) throw fail('stale_generation')
					const hex = typeof p.hex === 'string' ? p.hex.replace(/\s/g, '') : ''
					if (!/^(?:[0-9a-f]{2})+$/i.test(hex) || hex.length > 131072) throw fail('invalid_hex')
					const w = port.writable.getWriter()
					try { await w.write(Uint8Array.from(hex.match(/../g), x => parseInt(x, 16))); check() } finally { w.releaseLock() }
					return { written: hex.length / 2, completion: 'transport-accepted' }
				}
				throw fail('unknown_action')
			}).catch(async e => { if (guard && guard.step() && token === epoch) await release(); throw e }).finally(() => { clearInterval(poll); queued-- })
			tail = task.catch(() => {}); return task
		}
		function createPort(deviceId) {
			const device = devices.find(d => d.deviceId === deviceId && d.paired)
			if (!device) throw fail('pairing_required', '请先在系统窗口选择已配对的 SPP 设备')
			if (lanePortByDevice.has(deviceId)) return lanePortByDevice.get(deviceId)
			const token = epoch
			let connection = null
			const stream = deps.createStreamPort({
				getInfo() { return { transport: 'bt-classic', productName: device.name + ' · SPP' } },
				async open(options, sink) {
					await ready
					if (token !== epoch || deps.blocked()) throw fail('stale_generation')
					if (port || external || closeFailed) throw fail('already_open', '请先关闭现有 SPP 连接')
					const live = { handle: null, alive: true, sink }; external = connection = live
					closing++
					const onData = new deps.Channel(), onEvent = new deps.Channel()
					onData.onmessage = bytes => { if (live.alive && token === epoch) sink.data(deps.toBytes(bytes)) }
					onEvent.onmessage = e => { if (live.alive && token === epoch && e.type === 'lost') sink.lost(fail('device_lost')) }
					try {
						live.handle = await deps.invoke('classic_open', { deviceId, ownerGeneration: nativeGeneration, onData, onEvent })
						if (token !== epoch || deps.blocked()) throw fail('stale_generation')
					} catch (e) {
						if (live.handle != null) {
							try { await deps.invoke('classic_close', { handle: live.handle }) }
							catch (closeError) { closeFailed = true; throw closeError }
						}
						live.alive = false; if (external === live) external = null
						throw e
					} finally { closing-- }
				},
				async write(bytes) {
					if (token !== epoch || deps.blocked() || !connection || !connection.alive) throw fail('stale_generation')
					closing++
					try { await deps.invoke('classic_write', { handle: connection.handle, data: Array.from(bytes) }) } finally { closing-- }
				},
				async close() {
					if (!connection) return
					closing++
					try {
						if (connection.handle != null) await deps.invoke('classic_close', { handle: connection.handle })
						connection.alive = false; if (external === connection) external = null
						connection = null; closeFailed = false
					} catch (e) { closeFailed = true; throw e } finally { closing-- }
				},
			})
			stream.getDisplayAlias = () => aliases.get(deviceId) || null
			stream.setDisplayAlias = alias => { if (alias) aliases.set(deviceId, alias); else aliases.delete(deviceId) }
			lanePorts.add(stream); lanePortByDevice.set(deviceId, stream)
			return stream
		}
		return { createPort, ports: () => Array.from(lanePorts), isBusyForUpdate: () => !!(initializing || queued || releasePromise || closing || closeFailed || ['system-dialog', 'opening', 'closing', 'close-failed'].includes(phase)), state, devices: () => devices.map(d => ({ ...d })), read, run, release, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
	}
	root.NativeClassic = { create }
	if (typeof module !== 'undefined' && module.exports) module.exports = { create }
})(typeof window !== 'undefined' ? window : globalThis)
