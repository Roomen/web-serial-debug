// 统一协议注册表：管理内置协议与外部协议（JSON / JS 插件）的注册、注销、显隐持久化、
// 平台门控、面板生命周期与外部协议 XSS 结构化隔离。
// 浏览器全局暴露 window.ProtocolRegistry / window.registerProtocol / window.unregisterProtocol，
// 同时导出给 Node 回归测试（tests/protocol-registry.cjs）。
;(function (root) {
	'use strict'

	const RESERVED_IDS = [
		'sek',
		'wmbus',
		'gz',
		'cjt188',
		'sk-ultrasonic',
		'hostproto',
		'cellular-at',
	]
	const RESERVED_SET = new Set(RESERVED_IDS)
	const HIDDEN_KEY = 'protocolHiddenIds'
	const CUSTOM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/

	function escHtml(s, parseView) {
		const pv = parseView || root.ParseView
		if (pv && typeof pv.esc === 'function') {
			return pv.esc(s)
		}
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;')
	}

	// 外部协议 logView 清洗：严禁保留 section.html，转为纯文本追加到 section.pre 并删除 html 键
	function sanitizeSection(sec) {
		if (!sec || typeof sec !== 'object') return sec
		const out = Object.assign({}, sec)
		if (out.html != null && out.html !== '') {
			const htmlText = String(out.html)
			out.pre = out.pre != null && out.pre !== '' ? String(out.pre) + '\n' + htmlText : htmlText
		}
		delete out.html
		if (Array.isArray(out.groups)) {
			out.groups = out.groups.map(function (g) {
				if (!g || typeof g !== 'object') return g
				const ng = Object.assign({}, g)
				delete ng.html
				return ng
			})
		}
		return out
	}

	function sanitizeLogViewModel(m) {
		if (!m || typeof m !== 'object') return m
		const out = Object.assign({}, m)
		delete out.html
		if (Array.isArray(out.sections)) {
			out.sections = out.sections.map(sanitizeSection)
		}
		return out
	}

	function sanitizeLogViewOutput(out) {
		if (out == null) return out
		if (Array.isArray(out)) return out.map(sanitizeLogViewModel)
		return sanitizeLogViewModel(out)
	}

	function wrapExternalProtocol(norm, env) {
		const origLogView = typeof norm.logView === 'function' ? norm.logView : null
		const origFormatFrame = typeof norm.formatFrame === 'function' ? norm.formatFrame : null
		const getParseView = function () { return (env && env.ParseView) || root.ParseView }

		const safeLogView = origLogView
			? function (r) {
				return sanitizeLogViewOutput(origLogView(r))
			}
			: null

		const safeFormatFrame = function (r) {
			const pv = getParseView()
			if (origFormatFrame) {
				const raw = origFormatFrame(r)
				if (raw == null || raw === '') return ''
				return '<pre class="pv-pre">' + escHtml(String(raw), pv) + '</pre>'
			}
			if (safeLogView) {
				const model = safeLogView(r)
				const hasModel = Array.isArray(model) ? model.length > 0 : !!(model && typeof model === 'object')
				if (hasModel && pv && typeof pv.render === 'function') {
					return pv.render(model)
				}
				const errs = r && Array.isArray(r.errors) && r.errors.length ? r.errors.join('；') : '未识别的协议帧'
				return '<div class="pv-err">' + escHtml(errs, pv) + '</div>'
			}
			if (r == null) return ''
			try {
				return '<pre class="pv-pre">' + escHtml(JSON.stringify(r, null, 2), pv) + '</pre>'
			} catch (e) {
				return '<pre class="pv-pre">' + escHtml(String(r), pv) + '</pre>'
			}
		}

		return Object.assign({}, norm, {
			logView: safeLogView,
			formatFrame: safeFormatFrame,
		})
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
		const getPlatform = function () { return env.AppPlatform !== undefined ? env.AppPlatform : win.AppPlatform }

		const entries = new Map()
		const regOrder = []
		const hiddenSet = new Set()
		const changeListeners = new Set()
		let mountedId = null
		let mountedMode = 'none' // 'none' | 'custom' | 'generic'
		let host = null
		let batchDepth = 0
		let batchChanges = []
		let batchRegisteredIds = new Set()
		let batchUnregisteredIds = new Set()

		if (!win._protocols || typeof win._protocols !== 'object') {
			win._protocols = {}
		}

		function loadHidden() {
			hiddenSet.clear()
			if (!storage) return
			try {
				const raw = storage.getItem(HIDDEN_KEY)
				if (!raw) return
				const parsed = JSON.parse(raw)
				if (Array.isArray(parsed)) {
					parsed.forEach(function (id) {
						if (typeof id === 'string' && id.trim()) hiddenSet.add(id.trim())
					})
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

		loadHidden()

		function allowsProtocol(id) {
			const P = getPlatform()
			return !P || typeof P.allowsProtocol !== 'function' || !!P.allowsProtocol(id)
		}

		// 规范排序：sek 第一 → 其余内置按注册序 → 自定义按注册序
		function orderedIds() {
			const builtins = []
			const customs = []
			let hasSek = false
			for (let i = 0; i < regOrder.length; i++) {
				const id = regOrder[i]
				const entry = entries.get(id)
				if (!entry) continue
				if (id === 'sek') {
					hasSek = true
				} else if (entry.builtin) {
					builtins.push(id)
				} else {
					customs.push(id)
				}
			}
			return (hasSek ? ['sek'] : []).concat(builtins, customs)
		}

		function isSelectable(id) {
			return entries.has(id) && !hiddenSet.has(id)
		}

		function fallbackProtocolId() {
			if (isSelectable('sek')) return 'sek'
			const ids = orderedIds()
			for (let i = 0; i < ids.length; i++) {
				if (isSelectable(ids[i])) return ids[i]
			}
			return ids.length ? ids[0] : 'sek'
		}

		function ensureAtLeastOneVisible() {
			const ids = orderedIds()
			if (!ids.length) return false
			for (let i = 0; i < ids.length; i++) {
				if (!hiddenSet.has(ids[i])) return false
			}
			const keep = entries.has('sek') ? 'sek' : ids[0]
			hiddenSet.delete(keep)
			saveHidden()
			return true
		}

		function notifyChange(detail) {
			if (batchDepth > 0) {
				batchChanges.push(detail)
				return
			}
			changeListeners.forEach(function (fn) {
				try { fn(detail) } catch (e) { console.warn('[ProtocolRegistry] onChange 回调异常:', e) }
			})
			if (!doc || typeof doc.dispatchEvent !== 'function') return
			try {
				const Ctor = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null)
				if (Ctor) doc.dispatchEvent(new Ctor('serial-protocol-registry-change', { detail: detail }))
			} catch (e) {}
		}

		function batch(fn) {
			if (typeof fn !== 'function') return undefined
			batchDepth++
			let result
			try {
				result = fn()
			} finally {
				batchDepth--
				if (batchDepth === 0) {
					const changes = batchChanges
					const regIds = Array.from(batchRegisteredIds)
					const unregIds = Array.from(batchUnregisteredIds)
					batchChanges = []
					batchRegisteredIds = new Set()
					batchUnregisteredIds = new Set()
					let hiddenChanged = false
					for (let i = 0; i < unregIds.length; i++) {
						const uid = unregIds[i]
						if (!entries.has(uid) && hiddenSet.delete(uid)) {
							hiddenChanged = true
						}
					}
					if (hiddenChanged) saveHidden()
					ensureAtLeastOneVisible()
					syncSelect()
					if (host && typeof host.onReconcile === 'function') {
						try { host.onReconcile() } catch (e) {}
					}
					if (host && typeof host.onRegistered === 'function') {
						for (let i = 0; i < regIds.length; i++) {
							const rid = regIds[i]
							const entry = entries.get(rid)
							if (entry) {
								try { host.onRegistered(rid, entry) } catch (e) {}
							}
						}
					}
					if (win._activeProtocol && isSelectable(win._activeProtocol)) {
						activatePanel(win._activeProtocol)
					}
					if (changes.length) {
						notifyChange({ action: 'batch', changes: changes })
					}
				}
			}
			return result
		}

		function syncSelect() {
			if (!doc || typeof doc.getElementById !== 'function') return
			const sel = doc.getElementById('serial-protocol-select')
			if (!sel) return
			const prev = sel.value
			const ids = orderedIds()
			const desired = []
			for (let i = 0; i < ids.length; i++) {
				const id = ids[i]
				if (!isSelectable(id)) continue
				const item = entries.get(id)
				desired.push([id, item ? item.name : id])
			}
			const current = Array.prototype.map.call(sel.options || [], function (o) {
				return [o.value, o.textContent]
			})
			let same = desired.length === current.length
			if (same) {
				for (let i = 0; i < desired.length; i++) {
					if (desired[i][0] !== current[i][0] || desired[i][1] !== current[i][1]) {
						same = false
						break
					}
				}
			}
			if (!same) {
				sel.textContent = ''
				desired.forEach(function (pair) {
					const opt = doc.createElement('option')
					opt.value = pair[0]
					opt.textContent = pair[1]
					sel.appendChild(opt)
				})
			}
			const active = win._activeProtocol
			if (active && isSelectable(active)) {
				if (sel.value !== active) sel.value = active
			} else if (prev && isSelectable(prev)) {
				if (sel.value !== prev) sel.value = prev
			} else if (desired.length) {
				sel.value = desired[0][0]
			}
		}

		function unmountCurrent(ctx) {
			if (!mountedId) return
			const prevEntry = entries.get(mountedId)
			const prevMode = mountedMode
			mountedId = null
			mountedMode = 'none'
			if (prevMode === 'custom') {
				if (prevEntry && typeof prevEntry.unmountPanel === 'function') {
					try { prevEntry.unmountPanel(ctx || {}) } catch (e) { console.warn('[ProtocolRegistry] unmountPanel 失败:', e) }
				}
			} else if (prevMode === 'generic') {
				if (host && typeof host.unmountGenericPanel === 'function') {
					try { host.unmountGenericPanel(ctx || {}) } catch (e) { console.warn('[ProtocolRegistry] unmountGenericPanel 失败:', e) }
				}
			}
		}

		function activatePanel(id, ctx) {
			const nextId = id || win._activeProtocol || fallbackProtocolId()
			const entry = entries.get(nextId)
			if (!entry) return false
			const force = !!(ctx && ctx.force)
			if (mountedId === nextId && !force) {
				if (mountedMode === 'generic' && host && typeof host.mountGenericPanel === 'function') {
					try { host.mountGenericPanel(entry, ctx || {}) } catch (e) { console.warn('[ProtocolRegistry] mountGenericPanel 失败:', e) }
				}
				return true
			}
			unmountCurrent(ctx)
			const panelCtx = Object.assign({ protocolId: nextId, protocol: entry }, ctx || {})
			if (typeof entry.mountPanel === 'function') {
				mountedId = nextId
				mountedMode = 'custom'
				try { entry.mountPanel(panelCtx) } catch (e) { console.warn('[ProtocolRegistry] mountPanel 失败:', e) }
			} else if (host && typeof host.mountGenericPanel === 'function') {
				mountedId = nextId
				mountedMode = 'generic'
				try { host.mountGenericPanel(entry, panelCtx) } catch (e) { console.warn('[ProtocolRegistry] mountGenericPanel 失败:', e) }
			}
			return true
		}

		function normalizeImpl(id, impl, isBuiltin) {
			const source = isBuiltin ? 'builtin' : (impl.source || 'js-local')
			const norm = {
				id: id,
				name: String(impl.name || id),
				builtin: isBuiltin,
				source: source,
				version: impl.version != null ? String(impl.version) : '',
				description: impl.description != null ? String(impl.description) : '',
				ownerPluginId: impl.ownerPluginId || null,
				rawSpec: impl.rawSpec || null,
				findFrame: typeof impl.findFrame === 'function' ? impl.findFrame : null,
				parseFrame: typeof impl.parseFrame === 'function' ? impl.parseFrame : null,
				logView: typeof impl.logView === 'function' ? impl.logView : null,
				formatFrame: typeof impl.formatFrame === 'function' ? impl.formatFrame : null,
				byteMap: typeof impl.byteMap === 'function' ? impl.byteMap : null,
				buildDownFrame: typeof impl.buildDownFrame === 'function' ? impl.buildDownFrame : null,
				updateFrameTime: typeof impl.updateFrameTime === 'function' ? impl.updateFrameTime : null,
				presets: Array.isArray(impl.presets) ? impl.presets : [],
				funcTabs: Array.isArray(impl.funcTabs) ? impl.funcTabs : null,
				mountPanel: typeof impl.mountPanel === 'function' ? impl.mountPanel : null,
				unmountPanel: typeof impl.unmountPanel === 'function' ? impl.unmountPanel : null,
			}
			return isBuiltin ? norm : wrapExternalProtocol(norm, env)
		}

		function register(id, impl) {
			if (typeof id !== 'string' || !id.trim()) {
				throw new Error('协议 ID 必须是非空字符串')
			}
			id = id.trim()
			if (!impl || typeof impl !== 'object') {
				throw new Error('协议实现必须是对象')
			}
			const prev = entries.get(id)
			// 仅允许保留内置 ID 首次以 builtin: true 注册，注册后锁定不可被后续任何 register 覆盖
			const isBuiltin = RESERVED_SET.has(id) && impl.builtin === true && !prev
			if (!isBuiltin) {
				if (!CUSTOM_ID_RE.test(id)) {
					throw new Error('自定义协议 ID 格式非法（需 1-48 位小写字母/数字/_/-，且以字母或数字开头）: ' + id)
				}
				if (RESERVED_SET.has(id)) {
					throw new Error('保留的内置协议 ID 不允许被外部覆盖: ' + id)
				}
			}
			if (!allowsProtocol(id)) {
				return false
			}
			if (prev) {
				if (prev.builtin) {
					throw new Error('不允许覆盖内置协议: ' + id)
				}
				const nextSource = impl.source || 'js-local'
				const nextOwner = impl.ownerPluginId || ''
				const prevOwner = prev.ownerPluginId || ''
				if (prev.source !== nextSource || prevOwner !== nextOwner) {
					throw new Error('协议 ID "' + id + '" 已被其它来源占用（' + prev.source + '），不可覆盖')
				}
			}
			const entry = normalizeImpl(id, impl, isBuiltin)
			if (!entries.has(id)) regOrder.push(id)
			entries.set(id, entry)
			win._protocols[id] = entry
			if (batchDepth === 0) {
				ensureAtLeastOneVisible()
				syncSelect()
				if (host && typeof host.onRegistered === 'function') {
					try { host.onRegistered(id, entry) } catch (e) {}
				}
				if (win._activeProtocol === id && isSelectable(id)) {
					activatePanel(id)
				} else if (mountedId === id && !isSelectable(id)) {
					unmountCurrent()
				}
			} else {
				batchRegisteredIds.add(id)
			}
			notifyChange({ action: 'register', id: id })
			return true
		}

		function unregister(id) {
			const entry = entries.get(id)
			if (!entry) {
				return { ok: false, error: '协议未注册: ' + id }
			}
			if (entry.builtin) {
				return { ok: false, error: '内置协议不可删除，可设为隐藏' }
			}
			if (mountedId === id) {
				unmountCurrent()
			}
			entries.delete(id)
			const idx = regOrder.indexOf(id)
			if (idx >= 0) regOrder.splice(idx, 1)
			delete win._protocols[id]
			if (batchDepth === 0) {
				if (hiddenSet.delete(id)) saveHidden()
				ensureAtLeastOneVisible()
				syncSelect()
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
				return { ok: false, error: '协议未注册: ' + id }
			}
			const want = !!hidden
			if (want) {
				let otherVisible = 0
				const ids = orderedIds()
				for (let i = 0; i < ids.length; i++) {
					if (ids[i] !== id && !hiddenSet.has(ids[i])) otherVisible++
				}
				if (otherVisible === 0) {
					return { ok: false, error: '至少需要保留一个可见协议' }
				}
				if (hiddenSet.has(id)) return { ok: true }
				hiddenSet.add(id)
				saveHidden()
				if (mountedId === id) unmountCurrent()
				if (batchDepth === 0) {
					syncSelect()
					if (host && typeof host.onUnavailable === 'function') {
						try { host.onUnavailable(id) } catch (e) {}
					}
				}
				notifyChange({ action: 'visibility', id: id, hidden: true })
				return { ok: true }
			}
			if (!hiddenSet.has(id)) return { ok: true }
			hiddenSet.delete(id)
			saveHidden()
			if (batchDepth === 0) syncSelect()
			notifyChange({ action: 'visibility', id: id, hidden: false })
			return { ok: true }
		}

		function setHiddenIds(ids) {
			hiddenSet.clear()
			if (Array.isArray(ids)) {
				ids.forEach(function (id) {
					if (typeof id === 'string' && id.trim()) hiddenSet.add(id.trim())
				})
			}
			if (batchDepth === 0) {
				ensureAtLeastOneVisible()
				saveHidden()
				syncSelect()
				if (host && typeof host.onReconcile === 'function') {
					try { host.onReconcile() } catch (e) {}
				}
			} else {
				saveHidden()
			}
			notifyChange({ action: 'visibility-batch' })
		}

		function getHiddenIds() {
			return Array.from(hiddenSet)
		}

		function toListItem(entry) {
			const hidden = hiddenSet.has(entry.id)
			return {
				id: entry.id,
				name: entry.name,
				builtin: entry.builtin,
				source: entry.source,
				version: entry.version,
				description: entry.description,
				ownerPluginId: entry.ownerPluginId,
				hidden: hidden,
				selectable: !hidden,
				capabilities: {
					parse: typeof entry.parseFrame === 'function',
					downlink: typeof entry.buildDownFrame === 'function',
					presets: Array.isArray(entry.presets) && entry.presets.length > 0,
					customPanel: typeof entry.mountPanel === 'function',
				},
			}
		}

		function list(opts) {
			const includeHidden = !!(opts && opts.includeHidden === true)
			const ids = orderedIds()
			const out = []
			for (let i = 0; i < ids.length; i++) {
				const entry = entries.get(ids[i])
				if (!entry) continue
				if (!includeHidden && hiddenSet.has(entry.id)) continue
				out.push(toListItem(entry))
			}
			return out
		}

		function onChange(fn) {
			if (typeof fn !== 'function') return function () {}
			changeListeners.add(fn)
			return function () { changeListeners.delete(fn) }
		}

		function reconcileActiveLanes() {
			ensureAtLeastOneVisible()
			syncSelect()
			if (host && typeof host.onReconcile === 'function') {
				try { host.onReconcile() } catch (e) {}
			}
		}

		return {
			RESERVED_IDS: RESERVED_IDS.slice(),
			HIDDEN_KEY: HIDDEN_KEY,
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
			fallbackProtocolId: fallbackProtocolId,
			list: list,
			onChange: onChange,
			batch: batch,
			syncSelect: syncSelect,
			activatePanel: activatePanel,
			unmountCurrent: unmountCurrent,
			reconcileActiveLanes: reconcileActiveLanes,
			setHost: function (h) { host = h || null },
			getMountedId: function () { return mountedId },
			sanitizeLogViewOutput: sanitizeLogViewOutput,
		}
	}

	const api = createRegistry({ window: root })
	api.createRegistry = createRegistry
	api.RESERVED_IDS = RESERVED_IDS.slice()
	api.HIDDEN_KEY = HIDDEN_KEY
	api.sanitizeLogViewOutput = sanitizeLogViewOutput

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api
	}
	if (typeof window !== 'undefined') {
		window.ProtocolRegistry = api
		window.registerProtocol = function (id, impl) { return api.register(id, impl) }
		window.unregisterProtocol = function (id) { return api.unregister(id) }
	}
})(typeof window !== 'undefined' ? window : globalThis)
