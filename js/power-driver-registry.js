// 功耗仪协议/驱动注册表：管理内置功耗仪（BLU 100k）与外部受信任 JS 插件功耗仪驱动的
// 注册、注销、显隐持久化、激活切换、能力归一化与会话异常隔离。
// 浏览器全局暴露 window.PowerDriverRegistry / window.registerPowerDriver / window.unregisterPowerDriver，
// 同时导出给 Node 回归测试（tests/power-driver-registry.cjs）。
;(function (root) {
	'use strict'

	const RESERVED_IDS = ['blu-100k']
	const RESERVED_SET = new Set(RESERVED_IDS)
	const HIDDEN_KEY = 'powerDriverHiddenIds'
	const ACTIVE_KEY = 'powerActiveDriverId'
	const CUSTOM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
	const BAD_KEYS = ['__proto__', 'constructor', 'prototype']
	const MAX_CMD_BYTES = 4096
	const PARITY_VALUES = ['none', 'even', 'odd']
	const FLOW_VALUES = ['none', 'hardware']

	function cleanText(v, max) {
		if (v == null) return ''
		const t = typeof v
		let s
		if (t === 'string') s = v
		else if ((t === 'number' && Number.isFinite(v)) || t === 'boolean') s = String(v)
		else return ''
		const lim = max || 64
		return s.length > lim ? s.slice(0, lim) : s
	}

	function finiteNum(v, fallback) {
		const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
		return Number.isFinite(n) ? n : fallback
	}

	function clamp(n, lo, hi) {
		if (n < lo) return lo
		if (n > hi) return hi
		return n
	}

	function cloneCapabilities(c) {
		return {
			nominalHz: c.nominalHz,
			voltage: {
				supported: c.voltage.supported,
				minMv: c.voltage.minMv,
				maxMv: c.voltage.maxMv,
				defaultMv: c.voltage.defaultMv,
				requiresBeforeStart: c.voltage.requiresBeforeStart,
				requiresBeforePowerOn: c.voltage.requiresBeforePowerOn,
			},
			dutPower: {
				supported: c.dutPower.supported,
				probeOnConnect: c.dutPower.probeOnConnect,
			},
			logicBits: c.logicBits,
		}
	}

	function cloneSerialOptions(s) {
		return {
			baudRate: s.baudRate,
			dataBits: s.dataBits,
			stopBits: s.stopBits,
			parity: s.parity,
			bufferSize: s.bufferSize,
			flowControl: s.flowControl,
			dtr: s.dtr,
			rts: s.rts,
		}
	}

	function cloneUsbFilters(list) {
		return list.map(function (f) {
			const out = {}
			if (f.usbVendorId != null) out.usbVendorId = f.usbVendorId
			if (f.usbProductId != null) out.usbProductId = f.usbProductId
			return out
		})
	}

	function normalizeUsbFilters(raw) {
		if (!Array.isArray(raw)) return []
		const out = []
		for (let i = 0; i < raw.length; i++) {
			const item = raw[i]
			if (!item || typeof item !== 'object') continue
			const f = {}
			let hasAny = false
			if (item.usbVendorId != null) {
				const vid = finiteNum(item.usbVendorId, NaN)
				if (Number.isInteger(vid) && vid >= 0 && vid <= 0xffff) {
					f.usbVendorId = vid
					hasAny = true
				}
			}
			if (item.usbProductId != null) {
				const pid = finiteNum(item.usbProductId, NaN)
				if (Number.isInteger(pid) && pid >= 0 && pid <= 0xffff) {
					f.usbProductId = pid
					hasAny = true
				}
			}
			if (hasAny) out.push(f)
		}
		return out
	}

	function normalizeSerialOptions(raw) {
		const s = raw && typeof raw === 'object' ? raw : {}
		const baud = Math.round(finiteNum(s.baudRate, 115200))
		const dataBits = s.dataBits === 7 ? 7 : 8
		const stopBits = s.stopBits === 2 ? 2 : 1
		const parity = PARITY_VALUES.indexOf(s.parity) >= 0 ? s.parity : 'none'
		const bufSize = Math.round(finiteNum(s.bufferSize, 1048576))
		const flowControl = FLOW_VALUES.indexOf(s.flowControl) >= 0 ? s.flowControl : 'none'
		return {
			baudRate: baud >= 1 && baud <= 12000000 ? baud : 115200,
			dataBits: dataBits,
			stopBits: stopBits,
			parity: parity,
			bufferSize: clamp(bufSize, 1024, 16 * 1024 * 1024),
			flowControl: flowControl,
			dtr: typeof s.dtr === 'boolean' ? s.dtr : true,
			rts: typeof s.rts === 'boolean' ? s.rts : true,
		}
	}

	function normalizeCapabilities(raw) {
		const c = raw && typeof raw === 'object' ? raw : {}
		const hzRaw = finiteNum(c.nominalHz, 100000)
		const nominalHz = hzRaw > 0 ? clamp(hzRaw, 1, 10000000) : 100000

		const v = c.voltage && typeof c.voltage === 'object' ? c.voltage : {}
		let minMv = finiteNum(v.minMv, 500)
		let maxMv = finiteNum(v.maxMv, 5000)
		if (minMv < 0) minMv = 0
		if (maxMv < 0) maxMv = 0
		if (minMv > maxMv) {
			const tmp = minMv
			minMv = maxMv
			maxMv = tmp
		}
		let defaultMv = null
		if (v.defaultMv != null) {
			const dmv = finiteNum(v.defaultMv, NaN)
			if (Number.isFinite(dmv) && dmv >= 0) {
				defaultMv = v.supported ? clamp(dmv, minMv, maxMv) : dmv
			}
		}

		const p = c.dutPower && typeof c.dutPower === 'object' ? c.dutPower : {}
		const lbRaw = Math.trunc(finiteNum(c.logicBits, 0))
		const logicBits = clamp(lbRaw, 0, 16)

		return {
			nominalHz: nominalHz,
			voltage: {
				supported: !!v.supported,
				minMv: minMv,
				maxMv: maxMv,
				defaultMv: defaultMv,
				requiresBeforeStart: !!v.requiresBeforeStart,
				requiresBeforePowerOn: v.requiresBeforePowerOn !== false,
			},
			dutPower: {
				supported: !!p.supported,
				probeOnConnect: !!p.probeOnConnect,
			},
			logicBits: logicBits,
		}
	}

	function toCommandBytes(v, label) {
		if (v == null) return null
		if (typeof Uint8Array !== 'undefined' && v instanceof Uint8Array) {
			if (v.length > MAX_CMD_BYTES) {
				throw new Error(label + ' 指令帧超过 ' + MAX_CMD_BYTES + ' 字节')
			}
			return Uint8Array.from(v)
		}
		if (Array.isArray(v)) {
			if (v.length > MAX_CMD_BYTES) {
				throw new Error(label + ' 指令帧超过 ' + MAX_CMD_BYTES + ' 字节')
			}
			const out = new Uint8Array(v.length)
			for (let i = 0; i < v.length; i++) {
				const b = v[i]
				if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
					throw new Error(label + ' 指令帧包含非法字节值')
				}
				out[i] = b
			}
			return out
		}
		throw new Error(label + ' 返回值必须为 Uint8Array、字节数组或 null')
	}

	function sanitizeStatsObject(raw) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
		const out = {}
		const keys = Object.keys(raw)
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i]
			if (BAD_KEYS.indexOf(k) >= 0) continue
			out[k] = raw[k]
		}
		return out
	}

	function normalizeSampleList(raw) {
		if (!raw) return []
		const isArr = Array.isArray(raw) || (ArrayBuffer.isView(raw) && !(raw instanceof DataView))
		if (!isArr) return []
		const out = []
		for (let i = 0; i < raw.length; i++) {
			const item = raw[i]
			if (typeof item === 'number') {
				if (Number.isFinite(item)) {
					out.push({ iUA: item, range: 0, logic: 0 })
				}
				continue
			}
			if (item && typeof item === 'object') {
				const iUA = typeof item.iUA === 'number' ? item.iUA : NaN
				if (!Number.isFinite(iUA)) continue
				const range = typeof item.range === 'number' && Number.isFinite(item.range) ? (item.range | 0) : 0
				const logic = typeof item.logic === 'number' && Number.isFinite(item.logic) ? (item.logic | 0) : 0
				out.push({ iUA: iUA, range: range, logic: logic })
			}
		}
		return out
	}

	function wrapSession(id, impl, rawSession) {
		const target = rawSession && typeof rawSession === 'object' ? rawSession : null
		const warn = function (method, err) {
			try { console.warn('[PowerDriverRegistry] ' + id + '.' + method + ' 异常:', err) } catch (e) {}
		}

		function pickFn(name, altName) {
			if (target && typeof target[name] === 'function') return { fn: target[name], self: target }
			if (altName && target && typeof target[altName] === 'function') return { fn: target[altName], self: target }
			if (typeof impl[name] === 'function') return { fn: impl[name], self: impl }
			if (altName && typeof impl[altName] === 'function') return { fn: impl[altName], self: impl }
			return null
		}

		const onConnectPick = pickFn('onConnect')
		const setVoltagePick = pickFn('buildSetVoltage')
		const setDutPowerPick = pickFn('buildSetDutPower')
		const startPick = pickFn('buildStart')
		const stopPick = pickFn('buildStop')
		const pushPick = pickFn('pushChunk', 'parseChunk')
		const resetPick = pickFn('resetStream')
		const statsPick = pickFn('getStreamStats')

		return {
			onConnect: async function (io) {
				if (!onConnectPick) return { ok: true }
				try {
					const res = await onConnectPick.fn.call(onConnectPick.self, io)
					if (res == null) return { ok: true }
					if (typeof res === 'object') {
						return Object.assign({ ok: res.ok !== false }, res)
					}
					return { ok: !!res }
				} catch (e) {
					warn('onConnect', e)
					return { ok: false, error: e && e.message ? e.message : String(e) }
				}
			},
			buildSetVoltage: function (mv) {
				if (!setVoltagePick) return null
				const raw = setVoltagePick.fn.call(setVoltagePick.self, mv)
				return toCommandBytes(raw, id + '.buildSetVoltage')
			},
			buildSetDutPower: function (on) {
				if (!setDutPowerPick) return null
				const raw = setDutPowerPick.fn.call(setDutPowerPick.self, !!on)
				return toCommandBytes(raw, id + '.buildSetDutPower')
			},
			buildStart: function (opts) {
				if (!startPick) return null
				const raw = startPick.fn.call(startPick.self, opts || {})
				return toCommandBytes(raw, id + '.buildStart')
			},
			buildStop: function () {
				if (!stopPick) return null
				const raw = stopPick.fn.call(stopPick.self)
				return toCommandBytes(raw, id + '.buildStop')
			},
			pushChunk: function (u8) {
				if (!pushPick) return []
				try {
					const buf = u8 instanceof Uint8Array ? u8 : (u8 ? new Uint8Array(u8) : new Uint8Array(0))
					const raw = pushPick.fn.call(pushPick.self, buf)
					return normalizeSampleList(raw)
				} catch (e) {
					warn('pushChunk', e)
					return []
				}
			},
			resetStream: function (opts) {
				if (!resetPick) return
				try {
					resetPick.fn.call(resetPick.self, opts || {})
				} catch (e) {
					warn('resetStream', e)
				}
			},
			getStreamStats: function () {
				if (!statsPick) return {}
				try {
					return sanitizeStatsObject(statsPick.fn.call(statsPick.self))
				} catch (e) {
					warn('getStreamStats', e)
					return {}
				}
			},
		}
	}

	function normalizeDriver(id, impl, isBuiltin) {
		const name = cleanText(impl.name, 64).trim() || id
		const shortRaw = cleanText(impl.shortName, 16).trim()
		const shortName = shortRaw || name.slice(0, 12)
		const source = isBuiltin ? 'builtin' : (cleanText(impl.source, 32).trim() || 'js-local')
		const version = cleanText(impl.version, 32).trim()
		const description = cleanText(impl.description, 256).trim()
		const ownerRaw = cleanText(impl.ownerPluginId, 64).trim()
		const ownerPluginId = ownerRaw || null
		const usbFilters = normalizeUsbFilters(impl.usbFilters)
		const serialOptions = normalizeSerialOptions(impl.serialOptions)
		const capabilities = normalizeCapabilities(impl.capabilities)
		const rawMatch = typeof impl.matchPort === 'function' ? impl.matchPort : null
		const rawCreateSession = typeof impl.createSession === 'function' ? impl.createSession : null

		function matchPort(info) {
			const safeInfo = info && typeof info === 'object' ? info : {}
			if (rawMatch) {
				try {
					return !!rawMatch.call(impl, safeInfo)
				} catch (e) {
					try { console.warn('[PowerDriverRegistry] ' + id + '.matchPort 异常:', e) } catch (x) {}
					return false
				}
			}
			if (!usbFilters.length) return true
			for (let i = 0; i < usbFilters.length; i++) {
				const f = usbFilters[i]
				const vOk = f.usbVendorId == null || safeInfo.usbVendorId === f.usbVendorId
				const pOk = f.usbProductId == null || safeInfo.usbProductId === f.usbProductId
				if (vOk && pOk) return true
			}
			return false
		}

		function createSession(hostCtx) {
			let rawSess = null
			if (rawCreateSession) {
				try {
					rawSess = rawCreateSession.call(impl, hostCtx || {})
				} catch (e) {
					try { console.warn('[PowerDriverRegistry] ' + id + '.createSession 异常:', e) } catch (x) {}
					rawSess = null
				}
			}
			return wrapSession(id, impl, rawSess)
		}

		return {
			id: id,
			name: name,
			shortName: shortName,
			builtin: isBuiltin,
			source: source,
			version: version,
			description: description,
			ownerPluginId: ownerPluginId,
			usbFilters: usbFilters,
			matchPort: matchPort,
			serialOptions: serialOptions,
			capabilities: capabilities,
			createSession: createSession,
		}
	}

	function createRegistry(env) {
		env = env || {}
		const win = env.window || root
		const doc = env.document !== undefined ? env.document : (typeof document !== 'undefined' ? document : null)
		let storage = null
		if (env.localStorage !== undefined) {
			storage = env.localStorage
		} else if (typeof window !== 'undefined') {
			try { storage = window.localStorage || null } catch (e) { storage = null }
		}

		const entries = new Map()
		const regOrder = []
		const hiddenSet = new Set()
		const changeListeners = new Set()
		let host = null
		let activeId = null
		let preferredActiveId = null
		let batchDepth = 0
		let batchChanges = []
		let batchUnregisteredIds = new Set()

		function loadPersisted() {
			hiddenSet.clear()
			preferredActiveId = null
			if (!storage) return
			try {
				const rawHidden = storage.getItem(HIDDEN_KEY)
				if (rawHidden) {
					const parsed = JSON.parse(rawHidden)
					if (Array.isArray(parsed)) {
						parsed.forEach(function (id) {
							if (typeof id === 'string' && id.trim()) hiddenSet.add(id.trim())
						})
					}
				}
			} catch (e) {}
			try {
				const rawActive = storage.getItem(ACTIVE_KEY)
				if (typeof rawActive === 'string' && rawActive.trim()) {
					preferredActiveId = rawActive.trim()
				}
			} catch (e) {}
		}

		function saveHidden() {
			if (!storage) return
			try {
				const arr = Array.from(hiddenSet)
				if (arr.length) storage.setItem(HIDDEN_KEY, JSON.stringify(arr))
				else storage.removeItem(HIDDEN_KEY)
			} catch (e) {}
		}

		function saveActive(id) {
			if (!storage) return
			try {
				if (id) storage.setItem(ACTIVE_KEY, id)
				else storage.removeItem(ACTIVE_KEY)
			} catch (e) {}
		}

		loadPersisted()

		function isHostBusy() {
			if (!host || typeof host.isBusy !== 'function') return false
			try { return !!host.isBusy() } catch (e) { return false }
		}

		// 排序：blu-100k 第一 → 其余内置按注册序 → 外部自定义按注册序
		function orderedIds() {
			const builtins = []
			const customs = []
			let hasBlu = false
			for (let i = 0; i < regOrder.length; i++) {
				const id = regOrder[i]
				const entry = entries.get(id)
				if (!entry) continue
				if (id === 'blu-100k') {
					hasBlu = true
				} else if (entry.builtin) {
					builtins.push(id)
				} else {
					customs.push(id)
				}
			}
			return (hasBlu ? ['blu-100k'] : []).concat(builtins, customs)
		}

		function isSelectable(id) {
			return entries.has(id) && !hiddenSet.has(id)
		}

		function fallbackDriverId() {
			if (isSelectable('blu-100k')) return 'blu-100k'
			const ids = orderedIds()
			for (let i = 0; i < ids.length; i++) {
				if (isSelectable(ids[i])) return ids[i]
			}
			return ids.length ? ids[0] : 'blu-100k'
		}

		function ensureAtLeastOneVisible() {
			const ids = orderedIds()
			if (!ids.length) return false
			for (let i = 0; i < ids.length; i++) {
				if (!hiddenSet.has(ids[i])) return false
			}
			const keep = entries.has('blu-100k') ? 'blu-100k' : ids[0]
			hiddenSet.delete(keep)
			saveHidden()
			return true
		}

		function getActiveId() {
			if (activeId && isSelectable(activeId)) return activeId
			if (preferredActiveId && isSelectable(preferredActiveId)) return preferredActiveId
			return fallbackDriverId()
		}

		function getActiveDriver() {
			const id = getActiveId()
			return entries.get(id) || null
		}

		function notifyChange(detail) {
			if (batchDepth > 0) {
				batchChanges.push(detail)
				return
			}
			changeListeners.forEach(function (fn) {
				try { fn(detail) } catch (e) { console.warn('[PowerDriverRegistry] onChange 回调异常:', e) }
			})
			if (!doc || typeof doc.dispatchEvent !== 'function') return
			try {
				const Ctor = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null)
				if (Ctor) doc.dispatchEvent(new Ctor('serial-power-driver-registry-change', { detail: detail }))
			} catch (e) {}
		}

		function emitActiveChange(nextId, prevId) {
			if (host && typeof host.onActiveChange === 'function') {
				try { host.onActiveChange(nextId, entries.get(nextId) || null, prevId) } catch (e) {}
			}
		}

		function reconcileActive(prevSnapshot) {
			const prev = prevSnapshot != null ? prevSnapshot : activeId
			ensureAtLeastOneVisible()
			const next = getActiveId()
			if (entries.has(next)) {
				activeId = next
			} else {
				activeId = null
			}
			if (prev && activeId && prev !== activeId) {
				saveActive(activeId)
				emitActiveChange(activeId, prev)
			}
		}

		function batch(fn) {
			if (typeof fn !== 'function') return undefined
			const prevActive = activeId
			batchDepth++
			let result
			try {
				result = fn()
			} finally {
				batchDepth--
				if (batchDepth === 0) {
					const changes = batchChanges
					const unregIds = Array.from(batchUnregisteredIds)
					batchChanges = []
					batchUnregisteredIds = new Set()
					let hiddenChanged = false
					for (let i = 0; i < unregIds.length; i++) {
						const uid = unregIds[i]
						if (!entries.has(uid) && hiddenSet.delete(uid)) {
							hiddenChanged = true
						}
					}
					if (hiddenChanged) saveHidden()
					reconcileActive(prevActive)
					if (changes.length) {
						notifyChange({ action: 'batch', changes: changes })
					}
				}
			}
			return result
		}

		function register(id, impl) {
			if (typeof id !== 'string' || !id.trim()) {
				throw new Error('功耗仪协议 ID 必须是非空字符串')
			}
			id = id.trim()
			if (BAD_KEYS.indexOf(id) >= 0) {
				throw new Error('非法的功耗仪协议 ID: ' + id)
			}
			if (!impl || typeof impl !== 'object') {
				throw new Error('功耗仪协议实现必须是对象')
			}
			const prev = entries.get(id)
			const isBuiltin = RESERVED_SET.has(id) && impl.builtin === true && !prev
			if (!isBuiltin) {
				if (!CUSTOM_ID_RE.test(id)) {
					throw new Error('自定义功耗仪协议 ID 格式非法（需 1-48 位小写字母/数字/_/-，且以字母或数字开头）: ' + id)
				}
				if (RESERVED_SET.has(id)) {
					throw new Error('保留的内置功耗仪协议 ID 不允许被外部覆盖: ' + id)
				}
			}
			if (prev) {
				if (prev.builtin) {
					throw new Error('不允许覆盖内置功耗仪协议: ' + id)
				}
				const nextSource = cleanText(impl.source, 32).trim() || 'js-local'
				const nextOwner = cleanText(impl.ownerPluginId, 64).trim()
				const prevOwner = prev.ownerPluginId || ''
				if (prev.source !== nextSource || prevOwner !== nextOwner) {
					throw new Error('功耗仪协议 ID "' + id + '" 已被其它来源占用（' + prev.source + '），不可覆盖')
				}
			}

			const entry = normalizeDriver(id, impl, isBuiltin)
			if (!entries.has(id)) regOrder.push(id)
			entries.set(id, entry)

			if (batchDepth === 0) {
				ensureAtLeastOneVisible()
				const prevActive = activeId
				if (!activeId && isSelectable(id)) {
					activeId = (preferredActiveId && isSelectable(preferredActiveId)) ? preferredActiveId : fallbackDriverId()
				} else if (preferredActiveId === id && activeId !== id && isSelectable(id) && !isHostBusy()) {
					activeId = id
					emitActiveChange(activeId, prevActive)
				} else if (id === 'blu-100k' && !preferredActiveId && activeId !== id && isSelectable(id) && !isHostBusy()) {
					activeId = id
					emitActiveChange(activeId, prevActive)
				}
			}
			notifyChange({ action: 'register', id: id })
			return true
		}

		function unregister(id) {
			const entry = entries.get(id)
			if (!entry) {
				return { ok: false, error: '功耗仪协议未注册: ' + id }
			}
			if (entry.builtin) {
				return { ok: false, error: '内置功耗仪协议不可删除，可设为隐藏' }
			}
			const cur = getActiveId()
			if (id === cur && isHostBusy()) {
				return { ok: false, error: '当前功耗仪协议正在连接中使用，请先断开连接后再移除' }
			}
			entries.delete(id)
			const idx = regOrder.indexOf(id)
			if (idx >= 0) regOrder.splice(idx, 1)

			if (batchDepth === 0) {
				if (hiddenSet.delete(id)) saveHidden()
				ensureAtLeastOneVisible()
				if (activeId === id || cur === id) {
					const nextId = fallbackDriverId()
					activeId = entries.has(nextId) ? nextId : null
					if (preferredActiveId === id) preferredActiveId = activeId
					if (activeId) saveActive(activeId)
					emitActiveChange(activeId, id)
				}
				if (host && typeof host.onUnavailable === 'function') {
					try { host.onUnavailable(id) } catch (e) {}
				}
			} else {
				batchUnregisteredIds.add(id)
			}
			notifyChange({ action: 'unregister', id: id })
			return { ok: true }
		}

		function setHidden(id, hidden) {
			if (!entries.has(id)) {
				return { ok: false, error: '功耗仪协议未注册: ' + id }
			}
			const want = !!hidden
			if (want) {
				let otherVisible = 0
				const ids = orderedIds()
				for (let i = 0; i < ids.length; i++) {
					if (ids[i] !== id && !hiddenSet.has(ids[i])) otherVisible++
				}
				if (otherVisible === 0) {
					return { ok: false, error: '至少需要保留一个可见功耗仪协议' }
				}
				const cur = getActiveId()
				if (id === cur && isHostBusy()) {
					return { ok: false, error: '当前功耗仪协议正在连接中使用，请先断开连接后再隐藏' }
				}
				if (hiddenSet.has(id)) return { ok: true }
				hiddenSet.add(id)
				saveHidden()
				if (id === cur) {
					const nextId = fallbackDriverId()
					activeId = nextId
					preferredActiveId = nextId
					saveActive(nextId)
					if (batchDepth === 0) {
						emitActiveChange(nextId, id)
					}
				}
				if (batchDepth === 0 && host && typeof host.onUnavailable === 'function') {
					try { host.onUnavailable(id) } catch (e) {}
				}
				notifyChange({ action: 'visibility', id: id, hidden: true })
				return { ok: true }
			}
			if (!hiddenSet.has(id)) return { ok: true }
			hiddenSet.delete(id)
			saveHidden()
			notifyChange({ action: 'visibility', id: id, hidden: false })
			return { ok: true }
		}

		function setHiddenIds(ids) {
			const prevActive = getActiveId()
			const busy = isHostBusy()
			hiddenSet.clear()
			if (Array.isArray(ids)) {
				ids.forEach(function (id) {
					if (typeof id === 'string' && id.trim()) {
						const clean = id.trim()
						if (busy && clean === prevActive) return
						hiddenSet.add(clean)
					}
				})
			}
			if (batchDepth === 0) {
				ensureAtLeastOneVisible()
				saveHidden()
				reconcileActive(prevActive)
			} else {
				saveHidden()
			}
			notifyChange({ action: 'visibility-batch' })
		}

		function getHiddenIds() {
			return Array.from(hiddenSet)
		}

		function setActiveId(id) {
			if (typeof id !== 'string' || !id.trim()) {
				return { ok: false, code: 'invalid_id', error: '功耗仪协议 ID 无效' }
			}
			id = id.trim()
			if (!entries.has(id)) {
				return { ok: false, code: 'driver_not_found', error: '功耗仪协议未注册: ' + id }
			}
			const cur = getActiveId()
			if (isHostBusy() && id !== cur) {
				return { ok: false, code: 'blu_busy', error: '请先关闭当前功耗仪连接再切换协议' }
			}
			if (hiddenSet.has(id)) {
				hiddenSet.delete(id)
				saveHidden()
			}
			const prevId = cur
			activeId = id
			preferredActiveId = id
			saveActive(id)
			if (batchDepth === 0) {
				emitActiveChange(id, prevId)
			}
			notifyChange({ action: 'active', id: id, prevId: prevId })
			return { ok: true, id: id, changed: id !== prevId, driver: entries.get(id) }
		}

		function toListItem(entry, activeNow) {
			const hidden = hiddenSet.has(entry.id)
			return {
				id: entry.id,
				name: entry.name,
				shortName: entry.shortName,
				builtin: entry.builtin,
				source: entry.source,
				version: entry.version,
				description: entry.description,
				ownerPluginId: entry.ownerPluginId,
				hidden: hidden,
				selectable: !hidden,
				active: entry.id === activeNow,
				usbFilters: cloneUsbFilters(entry.usbFilters),
				serialOptions: cloneSerialOptions(entry.serialOptions),
				capabilities: cloneCapabilities(entry.capabilities),
			}
		}

		function list(opts) {
			const includeHidden = !!(opts && opts.includeHidden === true)
			const ids = orderedIds()
			const activeNow = getActiveId()
			const out = []
			for (let i = 0; i < ids.length; i++) {
				const entry = entries.get(ids[i])
				if (!entry) continue
				if (!includeHidden && hiddenSet.has(entry.id)) continue
				out.push(toListItem(entry, activeNow))
			}
			return out
		}

		function onChange(fn) {
			if (typeof fn !== 'function') return function () {}
			changeListeners.add(fn)
			return function () { changeListeners.delete(fn) }
		}

		// 若 BluProtocol 已先加载，启动时自动注册内置 blu-100k（双向兜底加载顺序）
		if (win && win.BluProtocol && typeof win.BluProtocol.createPowerDriver === 'function' && !entries.has('blu-100k')) {
			try {
				register('blu-100k', win.BluProtocol.createPowerDriver())
			} catch (e) {
				try { console.warn('[PowerDriverRegistry] 自动注册 blu-100k 失败:', e) } catch (x) {}
			}
		}

		return {
			RESERVED_IDS: RESERVED_IDS.slice(),
			HIDDEN_KEY: HIDDEN_KEY,
			ACTIVE_KEY: ACTIVE_KEY,
			register: register,
			unregister: unregister,
			get: function (id) { return entries.get(id) || null },
			has: function (id) { return entries.has(id) },
			isBuiltin: function (id) {
				const entry = entries.get(id)
				return !!(entry && entry.builtin)
			},
			isHidden: function (id) { return hiddenSet.has(id) },
			isSelectable: isSelectable,
			setHidden: setHidden,
			getHiddenIds: getHiddenIds,
			setHiddenIds: setHiddenIds,
			fallbackDriverId: fallbackDriverId,
			getActiveId: getActiveId,
			getActiveDriver: getActiveDriver,
			setActiveId: setActiveId,
			list: list,
			batch: batch,
			onChange: onChange,
			setHost: function (h) { host = h || null },
			normalizeDriver: normalizeDriver,
		}
	}

	const api = createRegistry({ window: root })
	api.createRegistry = createRegistry
	api.RESERVED_IDS = RESERVED_IDS.slice()
	api.HIDDEN_KEY = HIDDEN_KEY
	api.ACTIVE_KEY = ACTIVE_KEY
	api.normalizeDriver = normalizeDriver

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api
	}
	if (typeof window !== 'undefined') {
		window.PowerDriverRegistry = api
		window.registerPowerDriver = function (id, impl) { return api.register(id, impl) }
		window.unregisterPowerDriver = function (id) { return api.unregister(id) }
	}
})(typeof window !== 'undefined' ? window : globalThis)
