// USB BLE bridge protocol and controller. No global SerialAdapter selection, DOM or native API.
;(function (root) {
	'use strict'
	const LIMIT = 1 << 20
	const error = (code, message) => Object.assign(new Error(message || code), { code })
	function uuid(v) {
		const key = String(v || '').trim().toLowerCase().replace(/^0x/, '').replace(/-/g, '').replace(/^0000([0-9a-f]{4})00001000800000805f9b34fb$/, '$1')
		return /^(?:[0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{32})$/.test(key) ? key : ''
	}
	// Advertising UUIDs stay separate from GATT discovery; canonical full UUIDs.
	function advertisingUuid(value) {
		if (typeof value !== 'string') return ''
		const v = value.trim().toLowerCase()
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) return v
		let h = v.replace(/^0x/, '')
		if (/^[0-9a-f]{4}$/.test(h)) h = '0000' + h + '00001000800000805f9b34fb'
		else if (/^[0-9a-f]{8}$/.test(h)) h += '00001000800000805f9b34fb'
		else if (!/^[0-9a-f]{32}$/.test(h)) return ''
		return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20)
	}
	function scanFilter(p = {}) {
		if (p.name != null && (typeof p.name !== 'string' || p.name.length > 128)) throw error('invalid_filter', '广播名须为不超过 128 字符的文本')
		if (p.serviceUuid != null && typeof p.serviceUuid !== 'string') throw error('invalid_filter', '服务 UUID 须为 128-bit UUID')
		const v = (p.serviceUuid || '').trim()
		if (v && !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(v)) throw error('invalid_filter', '服务 UUID 须为标准连字符格式或 32 位十六进制的 128-bit UUID')
		return { name: (p.name || '').trim().toLowerCase(), serviceUuid: v ? advertisingUuid(v) : '' }
	}
	const validHandle = h => Number.isInteger(h) && h > 0 && h <= 65535
	function codec(write, event, fault, timeoutMs = 5000) {
		let buffer = new Uint8Array(LIMIT), used = 0, dropping = false, next = 0, closed = false
		const pending = new Map(), decoder = new TextDecoder(), encoder = new TextEncoder()
		function finish(id, err, msg) {
			const p = pending.get(id)
			if (!p) return
			pending.delete(id); clearTimeout(p.timer)
			err ? p.reject(err) : p.resolve(msg)
		}
		return {
			get pending() { return pending.size },
			feed(bytes) {
				if (closed) return
				for (const b of bytes) {
					if (b === 10) {
						if (!dropping && used) {
							let m
							try { m = JSON.parse(decoder.decode(buffer.subarray(0, used))) } catch (_) { fault(error('bad_frame')) }
							if (m && typeof m === 'object' && !Array.isArray(m)) {
								if (m.t === 'rsp') finish(m.id, m.ok ? null : error('bridge_error', String(m.err && m.err.msg || '桥拒绝命令')), m.d || {})
								else if (m.t === 'evt') event(m)
							}
						}
						used = 0; dropping = false
					} else if (!dropping) {
						if (used === LIMIT) { used = 0; dropping = true; fault(error('rx_overflow')) }
						else buffer[used++] = b
					}
				}
			},
			request(op, p, check) {
				if (closed) return Promise.reject(error('bridge_closed'))
				if (pending.size >= 16) return Promise.reject(error('pending_limit'))
				const id = ++next
				return new Promise((resolve, reject) => {
					pending.set(id, { resolve, reject, timer: setTimeout(() => finish(id, error('response_timeout')), timeoutMs) })
					Promise.resolve().then(() => { if (check) check(); if (!pending.has(id)) throw error('aborted'); return write(encoder.encode(JSON.stringify({ t: 'cmd', id, op, p }) + '\n')) })
						.catch(e => finish(id, e))
				})
			},
			resync() { if (!closed) { used = 0; dropping = true; fault(error('framing_error')) } },
			close(reason = error('bridge_closed')) { closed = true; used = 0; for (const id of pending.keys()) finish(id, reason) },
		}
	}

	function create(deps) {
		let link = null, protocol = null, epoch = 0, generation = 0, phase = 'closed', scanning = false, paired = false
		let tail = Promise.resolve(), depth = 0, operation = null, deviceCounter = 0, seq = 0, dropped = 0
		let synchronized = false
		let scanWanted = false, discovery = false, currentService = null, connectedOnce = false, challenge = null
		let streamLease = null, profileWrites = 0, io = 0, releasing = 0, releaseFailed = false
		const STREAM = Symbol('profile-stream')
		const namespace = deps.namespace || Math.random().toString(36).slice(2)
		const devices = new Map(), services = [], chars = [], logs = [], listeners = new Set()
		const notify = () => listeners.forEach(f => f())
		function log(kind, data) {
			// Deliberately exclude addresses, passkeys and raw protocol frames from logs.
			logs.push({ sequence: ++seq, generation, kind, data })
			while (logs.length > 256 || logs.reduce((n, x) => n + JSON.stringify(x).length, 0) > 65536) { logs.shift(); dropped++ }
			notify()
		}
		function clearGatt() {
			const lease = streamLease; streamLease = null
			if (lease) lease.sink.lost(error('stale_generation'))
			services.length = 0; chars.length = 0; currentService = null; discovery = false; paired = false; challenge = null }
		function settle(err, value) { if (operation) { const o = operation; operation = null; clearTimeout(o.timer); clearInterval(o.poll); err ? o.reject(err) : o.resolve(value) } }
		function onEvent(e, token) {
			if (token !== epoch || !protocol) return
			if (e.e === 'ready') {
				// Firmware boot event, not a serial-open event. Never infer reset from ping/open.
				generation++; clearGatt(); devices.clear(); scanWanted = scanning = false
				settle(error('firmware_reset')); synchronized = true; connectedOnce = false
				phase = 'idle'; log('firmware_ready'); return
			}
			if (e.e === 'scan') { scanning = scanWanted && e.state === 'scanning'; log('scan', scanning); return }
			if (e.e === 'dev' && scanWanted) {
				for (const d of (Array.isArray(e.items) ? e.items : []).slice(0, 512)) {
					if (!d || typeof d.addr !== 'string' || d.addr.length > 64) continue
					const key = d.addr + '/' + Number(d.at || 0), old = devices.get(key)
					if (!old && devices.size >= 512) continue
					const uuids = new Set(old ? old.uuids : [])
					for (const v of (Array.isArray(d.uuids) ? d.uuids : []).slice(0, 64)) { const u = advertisingUuid(v); if (u && uuids.size < 64) uuids.add(u) }
					devices.set(key, { id: old ? old.id : namespace + ':' + epoch + ':d' + (++deviceCounter), addr: d.addr, at: Number(d.at || 0), name: typeof d.name === 'string' && d.name ? d.name.slice(0, 128) : old ? old.name : '', uuids: [...uuids], rssi: Number.isFinite(d.rssi) ? d.rssi : old ? old.rssi : null, connectable: typeof d.conn === 'boolean' || d.conn === 0 || d.conn === 1 ? !!d.conn : old ? old.connectable : false })
				}
				notify(); return
			}
			if (e.e === 'conn') {
				if (e.state === 'connected') {
					if (phase !== 'connecting' || !operation || operation.kind !== 'connect' || e.addr !== operation.addr) return
					generation++; clearGatt(); phase = 'connected'; connectedOnce = true; scanWanted = scanning = false
					settle(null, { generation, connected: true }); log('connected'); return
				}
				if (phase !== 'connected' && phase !== 'connecting' && phase !== 'disconnecting') return
				const wasDisconnect = operation && operation.kind === 'disconnect'
				generation++; clearGatt(); synchronized = false; phase = 'idle'
				settle(wasDisconnect ? null : error('disconnected'), { disconnected: true }); log('disconnected'); return
			}
			if (phase !== 'connected') return
			if (e.e === 'svc' && !discovery && services.length < 256 && uuid(e.uuid) && validHandle(e.handle) && validHandle(e.end) && e.end >= e.handle) {
				currentService = { uuid: uuid(e.uuid), handle: Number(e.handle), end: Number(e.end) }; services.push(currentService)
			} else if (e.e === 'chr' && !discovery && chars.length < 1024 && currentService) {
				const handle = Number(e.handle)
				if (uuid(e.uuid) && validHandle(handle) && Number.isInteger(e.props) && e.props >= 0 && e.props <= 255 && handle >= currentService.handle && handle <= currentService.end && !chars.some(c => c.handle === handle)) chars.push({ id: namespace + ':' + generation + ':c' + handle, uuid: uuid(e.uuid), handle, props: Number(e.props), service: currentService, descriptors: [] })
			} else if (e.e === 'dsc' && !discovery) {
				const c = chars.find(c => c.handle === Number(e.chr_handle))
				if (c && uuid(e.uuid) && validHandle(e.handle) && c.descriptors.length < 32) c.descriptors.push({ uuid: uuid(e.uuid), handle: Number(e.handle) })
			} else if (e.e === 'disc_done') { discovery = true; log('discovery_complete', chars.length) }
			else if (e.e === 'passkey' && operation && operation.kind === 'pair') { challenge = { action: e.action, value: Number(e.value) }; notify() }
			else if (e.e === 'sec' && operation && operation.kind === 'pair') {
				paired = !!e.encrypted; challenge = null; settle(paired ? null : error('pair_failed'), { paired }); log('security', paired)
			} else if (e.e === 'value') {
				const c = chars.find(c => c.handle === Number(e.handle))
				if (!c || typeof e.b64 !== 'string' || e.b64.length > 8192) return
				log('value', { characteristicId: c.id, source: e.src, base64: e.b64 })
				if (streamLease && streamLease.generation === generation && streamLease.rx === c.id && typeof e.src === 'string' && e.src !== 'read') {
					try { streamLease.sink.data(Uint8Array.from(root.atob(e.b64), x => x.charCodeAt(0))) } catch (_) { streamLease.sink.error(error('bad_base64')) }
				}
				if (operation && operation.kind === 'read' && operation.handle === c.handle && e.src === 'read') settle(null, { base64: e.b64, generation })
			} else if (e.e === 'write' && operation && operation.kind === 'write' && Number(e.handle) === operation.handle) {
				settle(e.status ? error('write_failed') : null, { written: true, generation })
			}
			notify()
		}
		function assert(guard, expected) {
			if (deps.blocked && deps.blocked()) throw error('update_preparing')
			if (expected != null && expected !== epoch) throw error('generation_changed')
			const denied = guard && guard.step && guard.step()
			if (denied) throw error(denied.code, denied.message)
		}
		function enqueue(fn, guard) {
			if (depth >= 8) return Promise.reject(error('queue_full'))
			const expected = epoch
			depth++
			const p = tail.then(async () => {
				assert(guard, expected)
				if (guard && guard.start) { const denied = await guard.start(); if (denied) throw error(denied.code, denied.message) }
				assert(guard, expected)
				return fn(() => assert(guard, expected))
			})
			tail = p.catch(() => {}).finally(() => { depth-- })
			return p
		}
		async function release() {
			releasing++
			try {
				epoch++; generation++; synchronized = false; scanWanted = scanning = false; clearGatt(); devices.clear(); phase = 'closed'
				settle(error('bridge_closed'))
				if (protocol) protocol.close()
				protocol = null
				const old = link
				if (old) {
					// Best-effort firmware disconnect; closing USB itself never implies BLE disconnect.
					for (const op of ['scan.stop', 'disconnect']) {
						try { await old.write(new TextEncoder().encode(JSON.stringify({ t: 'cmd', id: 0, op }) + '\n')) } catch (_) {}
					}
					await old.close(); if (link === old) link = null
				}
				if (deps.closeOrphan) await deps.closeOrphan()
				releaseFailed = false
				notify()
			} catch (e) { releaseFailed = true; throw e } finally { releasing-- }
		}
		async function request(op, p, check) {
			if (!protocol) throw error('bridge_closed')
			check()
			let timer
			const cancelled = new Promise((resolve, reject) => {
				timer = setInterval(() => { try { check() } catch (e) { reject(e) } }, 40)
			})
			try {
				const result = await Promise.race([protocol.request(op, p, check), cancelled])
				check(); return result
			} catch (e) {
				// A stopped MCP service does not own the UI connection. Only a request that
				// reached this I/O path and now has an uncertain result invalidates the link.
				if (e.code !== 'bridge_error' && e.code !== 'bridge_closed') await release()
				throw e
			} finally { clearInterval(timer) }
		}

		async function completed(kind, op, p, check, extra) {
			if (operation) throw error('operation_busy')
			const done = new Promise((resolve, reject) => {
				operation = Object.assign({ kind, resolve, reject,
					timer: setTimeout(() => settle(error('event_timeout')), deps.eventTimeout || 15000),
					poll: setInterval(() => { try { check() } catch (e) { settle(e) } }, 40),
				}, extra)
			})
			done.catch(() => {})
			// Install event waiter before writing: events may precede the command response.
			try { const both = await Promise.all([request(op, p, check), done]); check(); return both[1] }
			catch (e) { settle(e); await release(); throw e }
		}
		function characteristic(p, bits) {
			if (phase !== 'connected' || !discovery || p.generation !== generation) throw error('stale_generation', '请重新发现 GATT 并选择特征')
			const c = chars.find(c => c.id === p.characteristicId)
			if (!c) throw error('characteristic_not_found')
			if (!(c.props & bits)) throw error('unsupported_property')
			return c
		}
		function selector(c) {
			// No instance indices or handles in persistence. Structural signature disambiguates only when unique.
			return { service: c.service.uuid, characteristic: c.uuid, props: c.props,
				serviceShape: chars.filter(x => x.service === c.service).map(x => x.uuid + ':' + x.props).sort().join(','),
				descriptors: c.descriptors.map(d => d.uuid).sort().join(',') }
		}
		function resolveSelector(s) {
			const keys = ['service', 'characteristic', 'props', 'serviceShape', 'descriptors']
			const matches = s ? chars.filter(c => { const current = selector(c); return keys.every(k => current[k] === s[k]) }) : []
			if (matches.length !== 1) throw error('ambiguous_profile', '特征实例无法唯一辨认，请重新选择')
			return matches[0]
		}
		const api = {
			subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
			isBusyForUpdate() {
				return !!(depth || operation || profileWrites || io || releasing || releaseFailed || scanWanted || scanning ||
					(phase === 'connected' && !discovery) || ['opening', 'connecting', 'disconnecting'].includes(phase) ||
					(protocol && protocol.pending) || (deps.isBusyForUpdate && deps.isBusyForUpdate()))
			},
			state() { return { phase, synchronized, scanning, paired, generation, discovery, pending: protocol ? protocol.pending : 0, busy: depth > 0, challenge: challenge && { ...challenge } } },
			devices(p = {}) {
				const f = scanFilter(p)
				return Array.from(devices.values()).filter(d => (!f.name || d.name.toLowerCase().includes(f.name)) && (!f.serviceUuid || d.uuids.includes(f.serviceUuid))).map(d => ({ deviceId: d.id, name: d.name || '未命名设备', rssi: d.rssi, connectable: d.connectable, uuids: [...d.uuids] }))
			},
			gatt() { return { generation, complete: discovery, characteristics: chars.map(c => ({ characteristicId: c.id, uuid: c.uuid, service: c.service.uuid, props: c.props, selector: selector(c) })) } },
			logs() { return { events: logs.slice(), dropped } },
			ports: () => deps.ports(),
			release,
			async run(action, p = {}, guard) {
				if (streamLease && p[STREAM] !== streamLease && deps.isPinned && deps.isPinned()) throw error('transaction_pinned', '通信事务进行中，请先停止事务再操作 BLE 桥')
				// Pairing input must bypass the waiting pair operation, but still commits immediately before I/O.
				if (action === 'passkey') {
					assert(guard)
					if (guard && guard.start) { const denied = await guard.start(); if (denied) throw error(denied.code, denied.message) }
					assert(guard)
					if (!challenge || !operation || operation.kind !== 'pair' || p.generation !== generation || !Number.isInteger(p.passkey) || p.passkey < 0 || p.passkey > (challenge.action === 'confirm' ? 1 : 999999) || challenge.action === 'display') throw error('invalid_passkey')
					challenge = null
					return request('pair.passkey', { passkey: p.passkey }, () => assert(guard))
				}
				return enqueue(async check => {
					if (streamLease && p[STREAM] !== streamLease && deps.isPinned && deps.isPinned()) throw error('transaction_pinned', '通信事务进行中，请先停止事务再操作 BLE 桥')
					if (action === 'open') {
						if (link || phase !== 'closed') throw error('bridge_busy')
						phase = 'opening'; const token = epoch
						protocol = codec(async bytes => { io++; try { return await link.write(bytes) } finally { io-- } }, e => onEvent(e, token), e => log(e.code), deps.timeout)
						try {
							const opened = await deps.open(p.deviceId, bytes => protocol && token === epoch && protocol.feed(bytes), () => { if (token === epoch) release().catch(() => {}) }, check, () => { if (protocol && token === epoch) protocol.resync() })
							if (token !== epoch) { await opened.close(); throw error('generation_changed') }
							link = opened; check(); phase = 'idle'
							await request('ping', {}, check); return api.state()
						} catch (e) { await release(); throw e }
					}
					if (action === 'close') { await release(); return api.state() }
					if (!protocol || phase === 'closed') throw error('bridge_closed')
					if (action === 'scan_start' || action === 'scan_stop') {
						if (phase !== 'idle') throw error('not_idle')
						scanWanted = action === 'scan_start'; if (scanWanted) devices.clear()
						try { await request(scanWanted ? 'scan.start' : 'scan.stop', scanWanted ? { active: true, interval_ms: 50, window_ms: 30, min_rssi: -127 } : {}, check) }
						catch (e) { scanWanted = scanning = false; throw e }
						if (!scanWanted) scanning = false
						return api.state()
					}
					if (action === 'connect') {
						if (phase !== 'idle' || connectedOnce || !synchronized) throw error('firmware_reset_required', '固件事件无连接代次：请保持桥口打开并复位桥固件，收到 ready 后再连接；重开串口不能复位 BLE 会话')
						const d = Array.from(devices.values()).find(d => d.id === p.deviceId)
						if (!d || !d.connectable) throw error('stale_device_id')
						phase = 'connecting'; scanWanted = scanning = false
						return completed('connect', 'connect', { addr: d.addr, addr_type: d.at }, check, { addr: d.addr })
					}
					if (p.generation !== generation || phase !== 'connected') throw error('stale_generation')
					if (action === 'disconnect') { phase = 'disconnecting'; return completed('disconnect', 'disconnect', {}, check) }
					if (action === 'pair') return completed('pair', 'pair', {}, check)
					if (action === 'read') { const c = characteristic(p, 2); return completed('read', 'gatt.read', { handle: c.handle }, check, { handle: c.handle }) }
					if (action === 'write') {
						if (streamLease && streamLease.tx === p.characteristicId && p[STREAM] !== streamLease) throw error('profile_port_busy')
						const c = characteristic(p, p.response === false ? 4 : 8)
						const hex = String(p.hex || '').replace(/\s/g, '')
						if (!/^(?:[0-9a-f]{2})+$/i.test(hex) || hex.length > 1024) throw error('invalid_payload', 'HEX 长度须为 1..512 字节')
						const value = root.btoa(hex.match(/../g).map(x => String.fromCharCode(parseInt(x, 16))).join(''))
						if (p.response === false) { await request('gatt.write', { handle: c.handle, value, resp: false }, check); return { accepted: true, completion: 'unacknowledged', generation } }
						return completed('write', 'gatt.write', { handle: c.handle, value, resp: true }, check, { handle: c.handle })
					}
					if (action === 'subscribe') {
						if (streamLease && streamLease.rx === p.characteristicId && p[STREAM] !== streamLease) throw error('profile_port_busy')
						const c = characteristic(p, 0x30), ds = c.descriptors.filter(d => d.uuid === '2902')
						if (ds.length !== 1) throw error('ambiguous_cccd')
						await request('gatt.subscribe', { handle: ds[0].handle, on: p.on !== false }, check); return { accepted: true, generation }
					}
					throw error('unknown_action')
				}, guard)
			},
			createProfilePort(profile) {
				if (!deps.createStreamPort) throw error('stream_adapter_unavailable')
				// Freeze a serializable selector, never a handle; resolve again on every open.
				const saved = JSON.parse(JSON.stringify(profile))
				let lease = null
				function current() {
					if (!lease || streamLease !== lease || generation !== lease.generation || phase !== 'connected') throw error('stale_generation')
					return lease
				}
				return deps.createStreamPort({
					getInfo() { return { transport: 'ble-bridge', productName: 'USB BLE 桥', serialNumber: namespace + ':' + generation } },
					async open(options, sink) {
						if (streamLease) throw error('profile_port_busy')
						const resolved = api.resolveProfile(saved)
						lease = { ...resolved, sink }; streamLease = lease
						try { await api.run('subscribe', { generation: lease.generation, characteristicId: lease.rx, on: true, [STREAM]: lease }); current() }
						catch (e) { if (streamLease === lease) streamLease = null; lease = null; throw e }
					},
					async write(bytes) {
						if (bytes.byteLength > 65536) throw error('payload_too_large')
						const live = current()
						profileWrites++
						try {
							for (let offset = 0; offset < bytes.length; offset += saved.chunkSize) {
								current()
								const hex = Array.from(bytes.subarray(offset, offset + saved.chunkSize), b => b.toString(16).padStart(2, '0')).join('')
								await api.run('write', { generation: live.generation, characteristicId: live.tx, hex, response: saved.response, [STREAM]: live })
							}
						} finally { profileWrites-- }
					},
					async close() {
						const old = lease
						if (!old) return
						if (streamLease === old && generation === old.generation && phase === 'connected') {
							await api.run('subscribe', { generation: old.generation, characteristicId: old.rx, on: false, [STREAM]: old })
							if (streamLease === old) streamLease = null
						}
						lease = null
					},
				})
			},

			profile(txId, rxId, response = true, chunkSize = 20) {
				const tx = characteristic({ characteristicId: txId, generation }, response ? 8 : 4), rx = characteristic({ characteristicId: rxId, generation }, 0x30)
				if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 512) throw error('invalid_chunk_size')
				const profile = { version: 1, tx: selector(tx), rx: selector(rx), response, chunkSize }
				resolveSelector(profile.tx); resolveSelector(profile.rx)
				return profile
			},
			resolveProfile(p) {
				if (!discovery || !p || p.version !== 1) throw error('invalid_profile')
				const tx = resolveSelector(p.tx), rx = resolveSelector(p.rx)
				api.profile(tx.id, rx.id, p.response, p.chunkSize)
				return { tx: tx.id, rx: rx.id, generation }
			},
		}
		return api
	}
	const lib = { codec, create, uuid, LIMIT }
	if (typeof module !== 'undefined' && module.exports) module.exports = lib
	root.BleBridge = lib
})(typeof window !== 'undefined' ? window : globalThis)
