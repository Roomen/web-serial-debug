// 左栏工具视图插件注册表：管理内置工具视图（如功耗分析 power -> #view-blu）与受信任外部 JS 工具视图的
// 注册、注销、显隐持久化、忙碌态拦截、平台门控、DOM 宿主挂载、视图切换与待信任提示点同步。
// 浏览器全局暴露 window.ToolPluginRegistry / window.registerToolPlugin / window.unregisterToolPlugin，
// 同时导出给 Node 回归测试（tests/tool-plugin-registry.cjs）。
;(function (root) {
	'use strict'

	const RESERVED_IDS = ['power', 'ac6d']
	const RESERVED_SET = new Set(RESERVED_IDS)
	const HIDDEN_KEY = 'toolPluginHiddenIds'
	const ACTIVE_VIEW_KEY = 'serial-debug-active-view'
	const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
	const ICON_RE = /^bi-[a-z0-9-]+$/
	const BAD_KEYS = ['__proto__', 'constructor', 'prototype']
	const DEFAULT_BUSY_MSG = '该工具正在运行或已连接设备，请先断开后再隐藏'

	function cleanText(v, maxLen) {
		if (v == null) return ''
		const t = typeof v
		let s = ''
		if (t === 'string') s = v.trim()
		else if ((t === 'number' && Number.isFinite(v)) || t === 'boolean') s = String(v)
		else return ''
		if (maxLen && s.length > maxLen) return s.slice(0, maxLen)
		return s
	}

	function cleanIcon(v) {
		const s = cleanText(v, 64)
		return ICON_RE.test(s) ? s : 'bi-puzzle'
	}

	function isSafeId(id) {
		return typeof id === 'string' && ID_RE.test(id) && BAD_KEYS.indexOf(id) < 0
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
		let activeViewId = 'view-serial'
		let pendingRestoreView = null
		let batchDepth = 0
		let batchChanges = []
		let batchUnregisteredIds = new Set()
		let domInitialized = false
		let pluginChangeHandler = null

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

		function hasFeatures(featureStr) {
			const f = cleanText(featureStr, 128)
			if (!f) return true
			const P = getPlatform()
			if (!P || typeof P.has !== 'function') return true
			return f.split(/\s+/).every(function (x) { return !x || !!P.has(x) })
		}

		function allowsEntry(isBuiltin, feature) {
			const P = getPlatform()
			if (!P || typeof P.has !== 'function') return true
			if (isBuiltin) {
				return feature ? hasFeatures(feature) : true
			}
			return !!P.has('protocol.manage')
		}

		function orderedIds() {
			const builtins = []
			const externals = []
			for (let i = 0; i < regOrder.length; i++) {
				const id = regOrder[i]
				const entry = entries.get(id)
				if (!entry) continue
				if (entry.builtin) builtins.push(id)
				else externals.push(id)
			}
			return builtins.concat(externals)
		}

		function findByViewId(viewId) {
			if (!viewId) return null
			let found = null
			entries.forEach(function (entry) {
				if (!found && entry.viewId === viewId) found = entry
			})
			return found
		}

		function notifyChange(detail) {
			if (batchDepth > 0) {
				batchChanges.push(detail)
				return
			}
			changeListeners.forEach(function (fn) {
				try { fn(detail) } catch (e) { console.warn('[ToolPluginRegistry] onChange 回调异常:', e) }
			})
			if (!doc || typeof doc.dispatchEvent !== 'function') return
			try {
				const Ctor = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null)
				if (Ctor) doc.dispatchEvent(new Ctor('serial-tool-plugin-registry-change', { detail: detail }))
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
					if (changes.length) {
						notifyChange({ action: 'batch', changes: changes })
					}
				}
			}
			return result
		}

		function queryRailButton(viewId) {
			if (!doc) return null
			if (typeof doc.querySelector === 'function') {
				const hit = doc.querySelector('.rail-item[data-view="' + viewId + '"]')
				if (hit) return hit
			}
			const rail = doc.getElementById ? doc.getElementById('activity-rail') : null
			if (rail && typeof rail.querySelectorAll === 'function') {
				const items = rail.querySelectorAll('.rail-item')
				for (let i = 0; i < items.length; i++) {
					if (items[i].dataset && items[i].dataset.view === viewId) return items[i]
				}
			}
			return null
		}

		function getRailTop() {
			if (!doc) return null
			const rail = doc.getElementById ? doc.getElementById('activity-rail') : null
			if (!rail) return null
			if (typeof rail.querySelector === 'function') {
				const top = rail.querySelector('.rail-top')
				if (top) return top
			}
			if (Array.isArray(rail.children)) {
				for (let i = 0; i < rail.children.length; i++) {
					const c = rail.children[i]
					if (c.classList && c.classList.contains('rail-top')) return c
				}
			}
			return null
		}

		function findRailInsertAnchor(railTop) {
			if (!railTop || !railTop.children) return null
			const kids = railTop.children
			for (let i = 0; i < kids.length; i++) {
				const c = kids[i]
				if (!c) continue
				if (c.id === 'rail-plugin-manage' || c.id === 'serial-protocol-manage') return c
				if (c.classList && c.classList.contains('rail-divider')) return c
				if (c.dataset && c.dataset.railAnchor === 'plugin-manage') return c
			}
			return null
		}

		function syncRailButtonState(entry) {
			if (!entry) return
			const btn = entry._railBtn || queryRailButton(entry.viewId)
			if (!btn) return
			entry._railBtn = btn
			if (btn.dataset) btn.dataset.toolPlugin = entry.id
			const isHidden = hiddenSet.has(entry.id)
			btn.hidden = isHidden
			if (btn.dataset) {
				if (isHidden) btn.dataset.pluginHidden = '1'
				else delete btn.dataset.pluginHidden
			}
		}

		function ensureMounted(entry) {
			if (!entry || !doc) return
			const viewsRoot = doc.getElementById ? doc.getElementById('views') : null
			let container = doc.getElementById ? doc.getElementById(entry.viewId) : null

			if (!container && viewsRoot && typeof doc.createElement === 'function') {
				container = doc.createElement('div')
				container.id = entry.viewId
				container.className = 'app-view plugin-view'
				if (container.dataset) {
					container.dataset.toolPlugin = entry.id
					if (entry.hideTopbar) container.dataset.hideTopbar = 'true'
					if (entry.feature) container.dataset.feature = entry.feature
				}
				viewsRoot.appendChild(container)
				entry._ownsContainer = true
			} else if (container && container.dataset) {
				if (entry.hideTopbar && !container.dataset.hideTopbar) container.dataset.hideTopbar = 'true'
				if (entry.feature && !container.dataset.feature) container.dataset.feature = entry.feature
			}
			entry._container = container

			let btn = entry._railBtn || queryRailButton(entry.viewId)
			const railTop = getRailTop()
			if (!btn && railTop && typeof doc.createElement === 'function') {
				btn = doc.createElement('button')
				btn.type = 'button'
				btn.className = 'rail-item'
				if (btn.dataset) {
					btn.dataset.view = entry.viewId
					btn.dataset.toolPlugin = entry.id
					if (entry.feature) btn.dataset.feature = entry.feature
				}
				btn.title = entry.name
				if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-label', entry.name)

				const ic = doc.createElement('i')
				ic.className = 'bi ' + entry.icon
				if (typeof ic.setAttribute === 'function') ic.setAttribute('aria-hidden', 'true')
				const lbl = doc.createElement('span')
				lbl.className = 'rail-label'
				lbl.textContent = entry.label
				btn.appendChild(ic)
				btn.appendChild(lbl)

				const anchor = findRailInsertAnchor(railTop)
				if (anchor && typeof railTop.insertBefore === 'function') {
					railTop.insertBefore(btn, anchor)
				} else {
					railTop.appendChild(btn)
				}
				entry._ownsRailBtn = true
			} else if (btn && entry._ownsRailBtn) {
				btn.title = entry.name
				if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-label', entry.name)
				const kids = btn.children || []
				for (let i = 0; i < kids.length; i++) {
					const k = kids[i]
					if (k.tagName === 'I') k.className = 'bi ' + entry.icon
					else if (k.classList && k.classList.contains('rail-label')) k.textContent = entry.label
				}
			}
			entry._railBtn = btn

			syncRailButtonState(entry)

			if (!entry._mounted && entry._container && typeof entry.mount === 'function') {
				entry._mounted = true
				try {
					entry.mount(entry._container, { id: entry.id, viewId: entry.viewId })
				} catch (e) {
					console.warn('[ToolPluginRegistry] mount 失败(' + entry.id + '):', e)
				}
			}
		}

		function unmountDom(entry) {
			if (!entry) return
			if (typeof entry.unmount === 'function' && (entry._mounted || !entry._container)) {
				try {
					entry.unmount({ id: entry.id, viewId: entry.viewId })
				} catch (e) {
					console.warn('[ToolPluginRegistry] unmount 失败(' + entry.id + '):', e)
				}
			}
			entry._mounted = false
			if (entry._ownsContainer && entry._container) {
				if (typeof entry._container.remove === 'function') entry._container.remove()
				else if (entry._container.parentNode && typeof entry._container.parentNode.removeChild === 'function') {
					entry._container.parentNode.removeChild(entry._container)
				}
				entry._container = null
				entry._ownsContainer = false
			}
			if (entry._ownsRailBtn && entry._railBtn) {
				if (typeof entry._railBtn.remove === 'function') entry._railBtn.remove()
				else if (entry._railBtn.parentNode && typeof entry._railBtn.parentNode.removeChild === 'function') {
					entry._railBtn.parentNode.removeChild(entry._railBtn)
				}
				entry._railBtn = null
				entry._ownsRailBtn = false
			}
		}

		function isViewAllowed(viewId) {
			if (!viewId) return false
			if (viewId === 'view-serial') {
				return !doc || !doc.getElementById || !!doc.getElementById('view-serial')
			}
			if (doc && doc.getElementById && !doc.getElementById(viewId)) return false
			const entry = findByViewId(viewId)
			if (entry) {
				if (hiddenSet.has(entry.id)) return false
				if (!allowsEntry(entry.builtin, entry.feature)) return false
			}
			const btn = queryRailButton(viewId)
			if (btn) {
				if (btn.hidden) return false
				const feat = btn.dataset && btn.dataset.feature
				if (feat && !hasFeatures(feat)) return false
			} else if (!entry) {
				return false
			}
			return true
		}

		function activateView(viewId, opts) {
			let nextId = cleanText(viewId, 96) || 'view-serial'
			if (nextId === 'view-emk') nextId = 'view-blu'
			if (!isViewAllowed(nextId)) nextId = 'view-serial'

			const prevId = activeViewId
			const prevEntry = prevId && prevId !== nextId ? findByViewId(prevId) : null
			if (prevEntry && typeof prevEntry.onDeactivate === 'function') {
				try { prevEntry.onDeactivate({ id: prevEntry.id, viewId: prevEntry.viewId }) } catch (e) {
					console.warn('[ToolPluginRegistry] onDeactivate 失败(' + prevEntry.id + '):', e)
				}
			}

			const nextEntry = findByViewId(nextId)
			if (nextEntry) ensureMounted(nextEntry)

			if (doc && typeof doc.querySelectorAll === 'function') {
				const views = doc.querySelectorAll('.app-view')
				for (let i = 0; i < views.length; i++) {
					if (views[i].classList) views[i].classList.toggle('active', views[i].id === nextId)
				}
				const railItems = doc.querySelectorAll('.rail-item[data-view]')
				for (let i = 0; i < railItems.length; i++) {
					if (railItems[i].classList && railItems[i].dataset) {
						railItems[i].classList.toggle('active', railItems[i].dataset.view === nextId)
					}
				}
			}

			activeViewId = nextId
			if (!(opts && opts.preserveStorage)) {
				pendingRestoreView = null
				if (storage) {
					try { storage.setItem(ACTIVE_VIEW_KEY, nextId) } catch (e) {}
				}
			}

			if (nextEntry && typeof nextEntry.onActivate === 'function') {
				try { nextEntry.onActivate({ id: nextEntry.id, viewId: nextEntry.viewId }) } catch (e) {
					console.warn('[ToolPluginRegistry] onActivate 失败(' + nextEntry.id + '):', e)
				}
			}

			if (prevId !== activeViewId && doc && typeof doc.dispatchEvent === 'function') {
				try {
					const Ctor = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null)
					if (Ctor) doc.dispatchEvent(new Ctor('serial-active-view-change', { detail: { viewId: activeViewId, prevViewId: prevId } }))
				} catch (e) {}
			}

			return activeViewId
		}

		function getActiveView() {
			return activeViewId
		}

		function isEntryBusy(entry) {
			if (!entry) return false
			if (typeof entry.isBusy === 'function') {
				try { return !!entry.isBusy() } catch (e) { return false }
			}
			if (entry.id === 'power' && win.bluApi) {
				try {
					if (typeof win.bluApi.isOpen === 'function' && win.bluApi.isOpen()) return true
					if (typeof win.bluApi.isBusyForUpdate === 'function' && win.bluApi.isBusyForUpdate()) return true
				} catch (e) {}
			}
			return false
		}

		function getEntryBusyReason(entry) {
			if (entry && typeof entry.busyReason === 'function') {
				try {
					const r = cleanText(entry.busyReason(), 240)
					if (r) return r
				} catch (e) {}
			}
			return DEFAULT_BUSY_MSG
		}

		function normalizeImpl(id, impl, isBuiltin, isPlaceholder) {
			const name = cleanText(impl.name, 48) || id
			const label = cleanText(impl.label, 12) || name.slice(0, 6)
			const icon = cleanIcon(impl.icon)
			const description = cleanText(impl.description, 240)
			const version = cleanText(impl.version, 32)
			const feature = isBuiltin ? cleanText(impl.feature, 64) : ''
			const viewId = isBuiltin && cleanText(impl.viewId, 64)
				? cleanText(impl.viewId, 64)
				: ('view-plugin-' + id)
			return {
				id: id,
				name: name,
				label: label,
				icon: icon,
				viewId: viewId,
				builtin: isBuiltin,
				_placeholder: !!isPlaceholder,
				source: isBuiltin ? 'builtin' : (cleanText(impl.source, 32) || 'js-local'),
				version: version,
				description: description,
				ownerPluginId: isBuiltin ? null : (cleanText(impl.ownerPluginId, 128) || null),
				feature: feature,
				hideTopbar: impl.hideTopbar === true,
				mount: typeof impl.mount === 'function' ? impl.mount : null,
				unmount: typeof impl.unmount === 'function' ? impl.unmount : null,
				onActivate: typeof impl.onActivate === 'function' ? impl.onActivate : null,
				onDeactivate: typeof impl.onDeactivate === 'function' ? impl.onDeactivate : null,
				isBusy: typeof impl.isBusy === 'function' ? impl.isBusy : null,
				busyReason: typeof impl.busyReason === 'function' ? impl.busyReason : null,
				ownsPort: typeof impl.ownsPort === 'function' ? impl.ownsPort : null,
				statusBadge: typeof impl.statusBadge === 'function' ? impl.statusBadge : null,
				_mounted: false,
				_container: null,
				_railBtn: null,
				_ownsContainer: false,
				_ownsRailBtn: false,
			}
		}

		function register(id, impl) {
			if (typeof id !== 'string' || !id.trim()) {
				throw new Error('工具插件 ID 必须是非空字符串')
			}
			id = id.trim()
			if (!impl || typeof impl !== 'object') {
				throw new Error('工具插件实现必须是对象')
			}
			if (!isSafeId(id)) {
				throw new Error('工具插件 ID 格式非法（需 1-48 位小写字母/数字/_/-，且以字母或数字开头）: ' + id)
			}
			const prev = entries.get(id)
			const upgradingPlaceholder = !!(prev && prev._placeholder && impl.builtin === true)
			const isBuiltin = RESERVED_SET.has(id) && impl.builtin === true && (!prev || upgradingPlaceholder)
			if (!isBuiltin) {
				if (RESERVED_SET.has(id)) {
					throw new Error('保留的内置工具 ID 不允许被覆盖: ' + id)
				}
			}
			const feature = isBuiltin ? cleanText(impl.feature, 64) : ''
			if (!allowsEntry(isBuiltin, feature)) {
				return false
			}
			if (prev && !upgradingPlaceholder) {
				if (prev.builtin) {
					throw new Error('不允许覆盖内置工具插件: ' + id)
				}
				const nextSource = cleanText(impl.source, 32) || 'js-local'
				const nextOwner = cleanText(impl.ownerPluginId, 128) || ''
				const prevOwner = prev.ownerPluginId || ''
				if (prev.source !== nextSource || prevOwner !== nextOwner) {
					throw new Error('工具插件 ID "' + id + '" 已被其它来源占用（' + prev.source + '），不可覆盖')
				}
				unmountDom(prev)
			}
			const entry = normalizeImpl(id, impl, isBuiltin, impl._placeholder === true)
			if (upgradingPlaceholder && prev) {
				entry._railBtn = prev._railBtn
				entry._container = prev._container
			}
			if (!entries.has(id)) regOrder.push(id)
			entries.set(id, entry)
			ensureMounted(entry)
			if (domInitialized && !hiddenSet.has(entry.id) && isViewAllowed(entry.viewId)) {
				let savedView = pendingRestoreView
				if (!savedView && storage) {
					try { savedView = storage.getItem(ACTIVE_VIEW_KEY) } catch (e) {}
				}
				if (savedView === entry.viewId && activeViewId !== entry.viewId) {
					pendingRestoreView = null
					activateView(entry.viewId)
				}
			}
			notifyChange({ action: 'register', id: id })
			return true
		}

		function unregister(id) {
			const entry = entries.get(id)
			if (!entry) {
				return { ok: false, error: '工具插件未注册: ' + id }
			}
			if (entry.builtin) {
				return { ok: false, error: '内置工具不可删除，可设为隐藏' }
			}
			if (activeViewId === entry.viewId) {
				activateView('view-serial')
			}
			unmountDom(entry)
			entries.delete(id)
			const idx = regOrder.indexOf(id)
			if (idx >= 0) regOrder.splice(idx, 1)
			if (batchDepth === 0) {
				if (hiddenSet.delete(id)) saveHidden()
			} else {
				batchUnregisteredIds.add(id)
			}
			notifyChange({ action: 'unregister', id: id })
			return { ok: true }
		}

		function setHidden(id, hidden) {
			const entry = entries.get(id)
			if (!entry) {
				return { ok: false, error: '工具插件未注册: ' + id }
			}
			const want = !!hidden
			if (want) {
				if (isEntryBusy(entry)) {
					return { ok: false, error: getEntryBusyReason(entry) }
				}
				if (hiddenSet.has(id)) {
					syncRailButtonState(entry)
					return { ok: true }
				}
				hiddenSet.add(id)
				saveHidden()
				syncRailButtonState(entry)
				if (activeViewId === entry.viewId) {
					activateView('view-serial')
				}
				notifyChange({ action: 'visibility', id: id, hidden: true })
				return { ok: true }
			}
			if (!hiddenSet.has(id)) {
				syncRailButtonState(entry)
				return { ok: true }
			}
			hiddenSet.delete(id)
			saveHidden()
			ensureMounted(entry)
			syncRailButtonState(entry)
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
			saveHidden()
			entries.forEach(function (entry) {
				syncRailButtonState(entry)
			})
			const cur = findByViewId(activeViewId)
			if (cur && hiddenSet.has(cur.id)) {
				activateView('view-serial')
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
				label: entry.label,
				icon: entry.icon,
				viewId: entry.viewId,
				builtin: entry.builtin,
				source: entry.source,
				version: entry.version,
				description: entry.description,
				ownerPluginId: entry.ownerPluginId,
				feature: entry.feature,
				hideTopbar: entry.hideTopbar,
				hidden: hidden,
				visible: !hidden,
				selectable: !hidden,
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

		function refreshBadges() {
			entries.forEach(function (entry) {
				const btn = entry._railBtn || queryRailButton(entry.viewId)
				if (!btn) return
				entry._railBtn = btn
				if (typeof entry.statusBadge !== 'function') return
				let res = null
				try { res = entry.statusBadge() } catch (e) { res = null }
				const isOpen = !!(res && (res.conn === 'open' || (res.active && (res.state === 'open' || res.state === 'sampling'))))
				if (isOpen) {
					const title = cleanText(res.title, 120) || (entry.name + ' · 已连接')
					if (btn.dataset) btn.dataset.conn = 'open'
					btn.title = title
					if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-label', title)
				} else if (btn.dataset && btn.dataset.conn) {
					delete btn.dataset.conn
					btn.title = entry.name
					if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-label', entry.name)
				}
			})
		}

		function getUntrustedPluginCount() {
			const jsp = win.JsProtocolPlugin
			if (!jsp) return 0
			if (typeof jsp.getUntrustedCount === 'function') {
				try { return Math.max(0, Number(jsp.getUntrustedCount()) || 0) } catch (e) { return 0 }
			}
			if (typeof jsp.listPlugins === 'function') {
				try {
					const all = jsp.listPlugins() || []
					let n = 0
					for (let i = 0; i < all.length; i++) {
						if (all[i] && !all[i].trusted) n++
					}
					return n
				} catch (e) { return 0 }
			}
			return 0
		}

		function updatePluginManageDot(btn, count) {
			if (!btn || !doc) return
			if (btn.dataset && !btn.dataset.baseTitle) {
				btn.dataset.baseTitle = btn.title || '插件与协议'
			}
			const baseTitle = (btn.dataset && btn.dataset.baseTitle) || '插件与协议'
			let dot = null
			if (typeof btn.querySelector === 'function') {
				dot = btn.querySelector('.rail-status-dot')
			}
			if (!dot && Array.isArray(btn.children)) {
				for (let i = 0; i < btn.children.length; i++) {
					if (btn.children[i].classList && btn.children[i].classList.contains('rail-status-dot')) {
						dot = btn.children[i]
						break
					}
				}
			}
			if (!dot && typeof doc.createElement === 'function') {
				dot = doc.createElement('span')
				dot.className = 'rail-status-dot'
				if (typeof dot.setAttribute === 'function') dot.setAttribute('aria-hidden', 'true')
				btn.appendChild(dot)
			}
			if (count > 0) {
				if (dot) dot.hidden = false
				if (btn.dataset) {
					btn.dataset.state = 'waiting'
					btn.dataset.untrustedCount = String(count)
				}
				const nextTitle = baseTitle + '（' + count + ' 个外部 JS 插件待确认信任）'
				btn.title = nextTitle
				if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-label', nextTitle)
			} else {
				if (dot) dot.hidden = true
				if (btn.dataset) {
					delete btn.dataset.state
					delete btn.dataset.untrustedCount
				}
				btn.title = baseTitle
				if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-label', baseTitle)
			}
		}

		function refreshPluginDot() {
			if (!doc || typeof doc.getElementById !== 'function') return 0
			const count = getUntrustedPluginCount()
			;['rail-plugin-manage', 'serial-protocol-manage'].forEach(function (id) {
				const btn = doc.getElementById(id)
				if (btn) updatePluginManageDot(btn, count)
			})
			return count
		}

		function findPortOwner(port, opts) {
			if (!port) return null
			const exceptId = opts && opts.exceptId ? String(opts.exceptId) : ''
			const ids = orderedIds()
			for (let i = 0; i < ids.length; i++) {
				const id = ids[i]
				if (exceptId && id === exceptId) continue
				const entry = entries.get(id)
				if (!entry) continue
				if (typeof entry.ownsPort === 'function') {
					try {
						if (entry.ownsPort(port)) {
							return { id: entry.id, name: entry.name, label: entry.label }
						}
					} catch (e) {}
				} else if (entry.id === 'power' && win.bluApi) {
					try {
						if (typeof win.bluApi.ownsPort === 'function' && win.bluApi.ownsPort(port)) {
							return { id: entry.id, name: entry.name, label: entry.label }
						}
					} catch (e) {}
				}
			}
			return null
		}

		function updateBlockers(opts) {
			const except = opts && Array.isArray(opts.exceptIds) ? new Set(opts.exceptIds) : null
			const out = []
			const ids = orderedIds()
			for (let i = 0; i < ids.length; i++) {
				const id = ids[i]
				if (except && except.has(id)) continue
				const entry = entries.get(id)
				if (!entry) continue
				if (isEntryBusy(entry)) {
					const label = entry.name || entry.label || entry.id
					if (out.indexOf(label) < 0) out.push(label)
				}
			}
			return out
		}

		function initDom() {
			if (!doc || domInitialized) return
			domInitialized = true

			const rail = doc.getElementById ? doc.getElementById('activity-rail') : null
			if (rail && typeof rail.addEventListener === 'function' && (!rail.dataset || rail.dataset.tprBound !== '1')) {
				if (rail.dataset) rail.dataset.tprBound = '1'
				rail.addEventListener('click', function (e) {
					const target = e && e.target
					const btn = target && typeof target.closest === 'function' ? target.closest('.rail-item[data-view]') : null
					if (btn && btn.dataset && btn.dataset.view) {
						activateView(btn.dataset.view)
					}
				})
			}

			if (!entries.has('power')) {
				if (win.BluPowerToolPluginSpec && typeof win.BluPowerToolPluginSpec === 'object') {
					try {
						register('power', Object.assign({ builtin: true, viewId: 'view-blu', feature: 'view.power' }, win.BluPowerToolPluginSpec))
					} catch (e) {}
				} else if (doc.getElementById && doc.getElementById('view-blu')) {
					try {
						register('power', {
							builtin: true,
							_placeholder: true,
							name: '功耗分析',
							label: '功耗分析',
							icon: 'bi-speedometer2',
							viewId: 'view-blu',
							feature: 'view.power',
							description: '功耗仪实时电流波形、程控供电与区间统计',
						})
					} catch (e) {}
				}
			}

			if (!entries.has('ac6d') && win.Ac6dToolPluginSpec && typeof win.Ac6dToolPluginSpec === 'object') {
				try {
					register('ac6d', Object.assign({ builtin: true, viewId: 'view-ac6d', feature: 'view.ac6d' }, win.Ac6dToolPluginSpec))
				} catch (e) {}
			}

			entries.forEach(function (entry) {
				ensureMounted(entry)
			})

			let saved = null
			if (storage) {
				try { saved = storage.getItem(ACTIVE_VIEW_KEY) } catch (e) {}
			}
			if (saved) {
				const norm = saved === 'view-emk' ? 'view-blu' : saved
				if (isViewAllowed(norm)) {
					activateView(norm)
				} else if (norm === 'view-ac6d' || norm.indexOf('view-plugin-') === 0) {
					pendingRestoreView = norm
					activateView('view-serial', { preserveStorage: true })
				} else {
					activateView(norm)
				}
			} else {
				const curEntry = findByViewId(activeViewId)
				if (curEntry && hiddenSet.has(curEntry.id)) activateView('view-serial')
			}

			if (typeof doc.addEventListener === 'function') {
				pluginChangeHandler = function () { refreshPluginDot() }
				doc.addEventListener('serial-protocol-plugins-change', pluginChangeHandler)
			}
			refreshPluginDot()
		}

		function onChange(fn) {
			if (typeof fn !== 'function') return function () {}
			changeListeners.add(fn)
			return function () { changeListeners.delete(fn) }
		}

		return {
			RESERVED_IDS: RESERVED_IDS.slice(),
			HIDDEN_KEY: HIDDEN_KEY,
			ACTIVE_VIEW_KEY: ACTIVE_VIEW_KEY,
			register: register,
			unregister: unregister,
			get: function (id) { return entries.get(id) || null },
			has: function (id) { return entries.has(id) },
			isBuiltin: function (id) {
				const entry = entries.get(id)
				return !!(entry && entry.builtin)
			},
			isHidden: function (id) { return hiddenSet.has(id) },
			setHidden: setHidden,
			getHiddenIds: getHiddenIds,
			setHiddenIds: setHiddenIds,
			list: list,
			onChange: onChange,
			batch: batch,
			activateView: activateView,
			getActiveView: getActiveView,
			findPortOwner: findPortOwner,
			updateBlockers: updateBlockers,
			refreshBadges: refreshBadges,
			refreshPluginDot: refreshPluginDot,
			initDom: initDom,
		}
	}

	const api = createRegistry({ window: root })
	api.createRegistry = createRegistry
	api.RESERVED_IDS = RESERVED_IDS.slice()
	api.HIDDEN_KEY = HIDDEN_KEY
	api.ACTIVE_VIEW_KEY = ACTIVE_VIEW_KEY

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api
	}
	root.ToolPluginRegistry = api
	if (typeof window !== 'undefined') {
		window.ToolPluginRegistry = api
		window.registerToolPlugin = function (id, impl) { return api.register(id, impl) }
		window.unregisterToolPlugin = function (id) { return api.unregister(id) }
	}

	if (typeof document !== 'undefined' && document) {
		if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
			document.addEventListener('DOMContentLoaded', function () { api.initDom() })
		} else {
			api.initDom()
		}
	}
})(typeof window !== 'undefined' ? window : globalThis)
