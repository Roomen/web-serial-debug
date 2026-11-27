// Run: node tests/protocol-integration.cjs — synthetic data only.
// 跨模块真实联调测试：加载真实 parse-view.js + app-dialog.js + protocol-registry.js +
// json-protocol.js + js-protocol-plugin.js + protocol-downlink.js + protocol-manager.js + command-palette.js，
// 覆盖：
// 1) index.html 实际脚本加载顺序核查；
// 2) 启动恢复已保存自定义 JSON / 已信任 JS 协议及桌面目录异步扫描恢复/失败回退；
// 3) JSON 协议 ↔ protocol-downlink.js 通用下行面板（funcTabs / 参数输入 / 构建 / parseFrame / logView / formatFrame 无双重转义）全闭环；
// 4) JS 插件 ↔ ProtocolManager（真实 AppDialog.panel 内联信任，零嵌套 confirm）↔ ProtocolRegistry ↔ command-palette.js 动态切换命令 ↔ XSS 单次转义 ↔ 停用/删除自动回退。
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const REPO = path.resolve(__dirname, '..')
const readJs = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

// ---- 最小真实行为 DOM 适配层（供全部真实模块协同运行） ----
class DomNode {
	constructor(tag, id) {
		this.tagName = String(tag || 'DIV').toUpperCase()
		this.nodeType = 1
		this.id = id || ''
		this.className = ''
		this.style = { display: '' }
		this.dataset = {}
		this.attrs = {}
		this.children = []
		this.parentNode = null
		this.listeners = {}
		this._value = ''
		this._text = ''
		this._innerHTML = ''
		this.checked = false
		this.hidden = false
		this.disabled = false
		this.readOnly = false
		this.type = ''
		this.placeholder = ''
		this.title = ''
		this.selectedIndex = 0
		this.selected = false
		this.files = []
		this.classList = {
			add: (...cls) => {
				const s = new Set(this.className.split(/\s+/).filter(Boolean))
				cls.forEach((c) => s.add(c))
				this.className = Array.from(s).join(' ')
			},
			remove: (...cls) => {
				const s = new Set(this.className.split(/\s+/).filter(Boolean))
				cls.forEach((c) => s.delete(c))
				this.className = Array.from(s).join(' ')
			},
			toggle: (c, on) => {
				const s = new Set(this.className.split(/\s+/).filter(Boolean))
				const has = s.has(c)
				if (on === undefined ? !has : !!on) s.add(c)
				else s.delete(c)
				this.className = Array.from(s).join(' ')
			},
			contains: (c) => this.className.split(/\s+/).includes(c),
		}
	}
	get firstChild() { return this.children[0] || null }
	get nextSibling() {
		if (!this.parentNode) return null
		const i = this.parentNode.children.indexOf(this)
		return i >= 0 ? (this.parentNode.children[i + 1] || null) : null
	}
	get options() {
		const out = []
		const walk = (n) => {
			for (const c of n.children) {
				if (c.tagName === 'OPTION') out.push(c)
				else if (c.tagName === 'OPTGROUP') walk(c)
			}
		}
		walk(this)
		return out
	}
	get value() {
		if (this.tagName === 'SELECT') {
			const opts = this.options
			if (!opts.length) return ''
			if (this._value && opts.some((o) => o.value === this._value)) return this._value
			const selOpt = opts.find((o) => o.selected) || opts[this.selectedIndex] || opts[0]
			return selOpt ? selOpt.value : ''
		}
		return this._value
	}
	set value(v) {
		const s = v == null ? '' : String(v)
		if (this.tagName === 'SELECT') {
			const opts = this.options
			const idx = opts.findIndex((o) => o.value === s)
			if (idx >= 0) {
				this._value = s
				this.selectedIndex = idx
				opts.forEach((o, i) => { o.selected = i === idx })
			} else {
				this._value = ''
				this.selectedIndex = -1
				opts.forEach((o) => { o.selected = false })
			}
		} else {
			this._value = s
		}
	}
	get textContent() {
		if (this.children.length) {
			return this.children.map((c) => c.textContent || '').join('')
		}
		return this._text
	}
	set textContent(v) {
		this._text = v == null ? '' : String(v)
		this._innerHTML = ''
		if (this.children.length) {
			this.children.forEach((c) => { c.parentNode = null })
			this.children = []
		}
	}
	get innerText() { return this.textContent }
	set innerText(v) { this.textContent = v }
	get innerHTML() { return this._innerHTML }
	set innerHTML(v) {
		this._innerHTML = v == null ? '' : String(v)
		if (this._innerHTML === '') {
			this.children.forEach((c) => { c.parentNode = null })
			this.children = []
			this._text = ''
		}
	}
	appendChild(child) {
		if (child.parentNode && child.parentNode.removeChild) child.parentNode.removeChild(child)
		child.parentNode = this
		this.children.push(child)
		if (this.tagName === 'SELECT' && child.tagName === 'OPTION') {
			if (child.selected || this.options.length === 1) {
				this._value = child.value
				this.selectedIndex = this.options.indexOf(child)
			}
		}
		return child
	}
	insertBefore(child, ref) {
		if (child.parentNode && child.parentNode.removeChild) child.parentNode.removeChild(child)
		child.parentNode = this
		const idx = ref ? this.children.indexOf(ref) : -1
		if (idx >= 0) this.children.splice(idx, 0, child)
		else this.children.push(child)
		return child
	}
	removeChild(child) {
		const idx = this.children.indexOf(child)
		if (idx >= 0) {
			this.children.splice(idx, 1)
			child.parentNode = null
		}
		return child
	}
	remove() {
		if (this.parentNode) this.parentNode.removeChild(this)
	}
	contains(node) {
		let cur = node
		while (cur) {
			if (cur === this) return true
			cur = cur.parentNode
		}
		return false
	}
	setAttribute(k, v) {
		this.attrs[k] = String(v)
		if (k === 'id') this.id = String(v)
	}
	getAttribute(k) {
		if (k === 'id') return this.id
		return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null
	}
	removeAttribute(k) { delete this.attrs[k] }
	matches(sel) {
		const parts = sel.split(',').map((x) => x.trim()).filter(Boolean)
		return parts.some((p) => {
			if (p === ':scope > .protocol-down-card:not([data-dock-own])') {
				return this.classList.contains('protocol-down-card') && this.getAttribute('data-dock-own') == null
			}
			if (p === ':scope > h6.pane-section-title') {
				return this.tagName === 'H6' && this.classList.contains('pane-section-title')
			}
			if (p === 'button' || p === 'input' || p === 'select' || p === 'textarea') return this.tagName === p.toUpperCase()
			if (p.startsWith('#')) return this.id === p.slice(1)
			if (p === '.rail-item[data-view]') return this.classList.contains('rail-item') && !!this.dataset.view
			if (p.startsWith('.rail-item[data-view="')) {
				const m = p.match(/^\.rail-item\[data-view="([^"]+)"\]$/)
				return !!m && this.classList.contains('rail-item') && this.dataset.view === m[1]
			}
			if (p.startsWith('.')) return this.classList.contains(p.slice(1))
			if (p === 'button[data-func]') return this.tagName === 'BUTTON' && this.dataset.func != null
			if (p.startsWith('[data-index="')) {
				const m = p.match(/^\[data-index="(.+)"\]$/)
				return !!m && String(this.dataset.index) === m[1]
			}
			return false
		})
	}
	closest(sel) {
		let cur = this
		while (cur) {
			if (cur.matches && cur.matches(sel)) return cur
			cur = cur.parentNode
		}
		return null
	}
	querySelectorAll(sel) {
		if (sel.startsWith(':scope > ')) {
			return this.children.filter((c) => c.nodeType === 1 && c.matches(sel))
		}
		const out = []
		const walk = (n) => {
			for (const c of n.children) {
				if (c.nodeType === 1) {
					if (c.matches(sel)) out.push(c)
					walk(c)
				}
			}
		}
		walk(this)
		return out
	}
	querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
	addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
	removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((x) => x !== fn) }
	dispatchEvent(ev) {
		const e = typeof ev === 'string' ? { type: ev } : Object.assign({}, ev)
		e.target = this
		e.currentTarget = this
		e.preventDefault = e.preventDefault || (() => {})
		e.stopPropagation = e.stopPropagation || (() => {})
		;(this.listeners[e.type] || []).slice().forEach((fn) => fn.call(this, e))
		return true
	}
	click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }) }
	focus() {}
	blur() {}
	select() {}
	scrollIntoView() {}
}

function createIntegrationEnv(opts) {
	opts = opts || {}
	const store = new Map(Object.entries(opts.initialStorage || {}))
	const localStorage = {
		getItem(k) { return store.has(k) ? store.get(k) : null },
		setItem(k, v) { store.set(k, String(v)) },
		removeItem(k) { store.delete(k) },
	}

	const body = new DomNode('BODY')
	const docListeners = {}
	const docEvents = []

	// 构建与 index.html 一致的协议面板核心 DOM
	const protoSelect = new DomNode('SELECT', 'serial-protocol-select')
	const defaultOpt = new DomNode('OPTION')
	defaultOpt.value = 'sek'
	defaultOpt.textContent = 'SEK（默认）'
	protoSelect.appendChild(defaultOpt)
	body.appendChild(protoSelect)

	const manageMenuBtn = new DomNode('BUTTON', 'serial-protocol-manage')
	const manageInlineBtn = new DomNode('BUTTON', 'serial-protocol-manage-inline')
	if (opts.withRailAndPower) {
		const rail = new DomNode('NAV', 'activity-rail')
		const railTop = new DomNode('DIV')
		railTop.className = 'rail-top'
		const btnSerial = new DomNode('BUTTON')
		btnSerial.className = 'rail-item active'
		btnSerial.dataset.view = 'view-serial'
		btnSerial.title = '通信调试'
		railTop.appendChild(btnSerial)
		const btnBlu = new DomNode('BUTTON')
		btnBlu.className = 'rail-item'
		btnBlu.dataset.view = 'view-blu'
		btnBlu.dataset.feature = 'view.power'
		btnBlu.title = '功耗分析'
		railTop.appendChild(btnBlu)
		const sep = new DomNode('DIV')
		sep.className = 'rail-sep rail-divider'
		sep.dataset.railAnchor = 'plugin-manage'
		railTop.appendChild(sep)
		manageMenuBtn.className = 'rail-item rail-plugin-btn'
		manageMenuBtn.title = '插件与协议'
		railTop.appendChild(manageMenuBtn)
		rail.appendChild(railTop)
		body.appendChild(rail)

		const views = new DomNode('DIV', 'views')
		const viewSerial = new DomNode('DIV', 'view-serial')
		viewSerial.className = 'app-view active'
		const viewBlu = new DomNode('DIV', 'view-blu')
		viewBlu.className = 'app-view'
		views.appendChild(viewSerial)
		views.appendChild(viewBlu)
		body.appendChild(views)
	} else {
		body.appendChild(manageMenuBtn)
	}
	body.appendChild(manageInlineBtn)

	const navProtocol = new DomNode('DIV', 'nav-protocol')
	const adv = new DomNode('DETAILS', 'serial-protocol-advanced')
	navProtocol.appendChild(adv)

	const downCard = new DomNode('DIV', 'sk-down-card')
	downCard.className = 'protocol-down-card mb-2'
	const downTitle = new DomNode('H6')
	downTitle.className = 'pane-section-title'
	const downTitleIcon = new DomNode('I')
	downTitleIcon.className = 'bi bi-arrow-down-circle'
	const downTitleSpan = new DomNode('SPAN')
	downTitleSpan.className = 'sk-down-title-text'
	downTitleSpan.textContent = '下行下发'
	downTitle.appendChild(downTitleIcon)
	downTitle.appendChild(downTitleSpan)
	downCard.appendChild(downTitle)

	const funcTabs = new DomNode('DIV', 'serial-protocol-down-func-tabs')
	const funcSel = new DomNode('SELECT', 'serial-protocol-down-func')
	downCard.appendChild(funcTabs)
	downCard.appendChild(funcSel)

	const presetRow = new DomNode('DIV')
	presetRow.className = 'sk-preset-row'
	const presetSearch = new DomNode('INPUT', 'serial-protocol-down-preset-search')
	const presetSearchClear = new DomNode('BUTTON', 'serial-protocol-down-preset-search-clear')
	const presetSel = new DomNode('SELECT', 'serial-protocol-down-preset')
	presetRow.appendChild(presetSearch)
	presetRow.appendChild(presetSearchClear)
	presetRow.appendChild(presetSel)
	downCard.appendChild(presetRow)

	const presetDesc = new DomNode('DIV', 'serial-protocol-down-desc')
	const paramGroup = new DomNode('DIV', 'serial-protocol-down-param-group')
	const paramLabel = new DomNode('SPAN', 'serial-protocol-down-param-label')
	const paramVal = new DomNode('INPUT', 'serial-protocol-down-param-val')
	const paramSelEnum = new DomNode('SELECT', 'serial-protocol-down-param-sel')
	const paramUnit = new DomNode('SPAN', 'serial-protocol-down-param-unit')
	const paramMulti = new DomNode('DIV', 'serial-protocol-down-param-multi')
	paramGroup.appendChild(paramLabel)
	paramGroup.appendChild(paramVal)
	paramGroup.appendChild(paramSelEnum)
	paramGroup.appendChild(paramUnit)
	paramGroup.appendChild(paramMulti)
	downCard.appendChild(presetDesc)
	downCard.appendChild(paramGroup)

	const tlvInput = new DomNode('TEXTAREA', 'serial-protocol-down-tlv')
	const encWrap = new DomNode('DIV')
	encWrap.className = 'form-check form-switch ctl-switch'
	const encInput = new DomNode('INPUT', 'serial-protocol-down-encrypt')
	encWrap.appendChild(encInput)
	const buildBtn = new DomNode('BUTTON', 'serial-protocol-build')
	const sendBtn = new DomNode('BUTTON', 'serial-protocol-send')
	const previewEl = new DomNode('TEXTAREA', 'serial-protocol-down-preview')
	downCard.appendChild(tlvInput)
	downCard.appendChild(encWrap)
	downCard.appendChild(buildBtn)
	downCard.appendChild(sendBtn)
	downCard.appendChild(previewEl)

	navProtocol.appendChild(downCard)
	const parseHint = new DomNode('DIV', 'proto-parse-only-hint')
	parseHint.className = 'protocol-down-card mb-2 proto-parse-only-hint'
	parseHint.style.display = 'none'
	navProtocol.appendChild(parseHint)

	const rwCard = new DomNode('DIV', 'sk-rw-card')
	const batchCard = new DomNode('DIV', 'sk-batch-card')
	const esimCard = new DomNode('DIV', 'sk-esim-card')
	navProtocol.appendChild(rwCard)
	navProtocol.appendChild(batchCard)
	navProtocol.appendChild(esimCard)
	body.appendChild(navProtocol)

	// 兼容 command-palette 解析 HTML 创建弹层时的最小元素集合
	const cmdkOverlay = new DomNode('DIV', 'serial-cmdk-overlay')
	const cmdkInput = new DomNode('INPUT', 'serial-cmdk-input')
	const cmdkList = new DomNode('DIV', 'serial-cmdk-list')

	const document = {
		readyState: 'complete',
		body,
		activeElement: null,
		createElement(tag) { return new DomNode(tag) },
		createTextNode(t) { return { nodeType: 3, textContent: String(t), parentNode: null } },
		getElementById(id) {
			if (id === 'serial-cmdk-input') return cmdkInput
			if (id === 'serial-cmdk-list') return cmdkList
			const walk = (n) => {
				if (n.id === id) return n
				for (const c of n.children) {
					if (c.nodeType === 1) {
						const hit = walk(c)
						if (hit) return hit
					}
				}
				return null
			}
			return walk(body)
		},
		querySelector(sel) { return body.querySelector(sel) },
		querySelectorAll(sel) { return body.querySelectorAll(sel) },
		addEventListener(type, fn) { (docListeners[type] ||= []).push(fn) },
		removeEventListener(type, fn) { docListeners[type] = (docListeners[type] || []).filter((x) => x !== fn) },
		dispatchEvent(ev) {
			docEvents.push(ev)
			;(docListeners[ev.type] || []).slice().forEach((fn) => fn(ev))
			return true
		},
	}

	const services = new Map()
	if (opts.desktopPluginService) services.set('protocol-plugins', opts.desktopPluginService)

	const AppPlatform = {
		os: opts.mobile ? 'android' : 'web',
		profile: opts.mobile ? 'mobile' : 'desktop',
		has(fid) {
			if (opts.mobile) return ['view.serial', 'panel.protocol', 'panel.parse', 'panel.firmware'].includes(fid)
			return true
		},
		allowsProtocol(id) {
			if (opts.mobile) return id === 'sek'
			return true
		},
		service(name) { return services.get(name) || null },
		provide(name, impl) { services.set(name, impl) },
	}

	class FakeEvent {
		constructor(type, init) {
			this.type = type
			this.bubbles = !!(init && init.bubbles)
		}
	}
	class FakeCustomEvent extends FakeEvent {
		constructor(type, init) {
			super(type, init)
			this.detail = init ? init.detail : null
		}
	}

	const sentHex = []
	const logErrors = []
	let rerenderCount = 0
	let laneConfigCount = 0
	let genericHandlers = {}

	const sandbox = {
		window: null,
		globalThis: null,
		document,
		localStorage,
		navigator: { platform: 'MacIntel', userAgent: 'Chrome/130' },
		AppPlatform,
		Event: FakeEvent,
		CustomEvent: FakeCustomEvent,
		console,
		Uint8Array,
		Uint32Array,
		ArrayBuffer,
		DataView,
		TextEncoder,
		TextDecoder,
		Date,
		Math,
		JSON,
		Object,
		Array,
		String,
		Number,
		Set,
		Map,
		Promise,
		parseInt,
		isNaN,
		setTimeout,
		clearTimeout,
		getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
	}
	sandbox.window = sandbox
	sandbox.globalThis = sandbox
	sandbox.addEventListener = () => {}
	sandbox.removeEventListener = () => {}

	// 1. 加载 parse-view.js、app-dialog.js、protocol-registry.js（可选 power-driver-registry / tool-plugin-registry）
	vm.createContext(sandbox)
	vm.runInContext(readJs('js/parse-view.js'), sandbox, { filename: 'js/parse-view.js' })
	vm.runInContext(readJs('js/app-dialog.js'), sandbox, { filename: 'js/app-dialog.js' })
	vm.runInContext(readJs('js/protocol-registry.js'), sandbox, { filename: 'js/protocol-registry.js' })
	if (opts.withRailAndPower) {
		vm.runInContext(readJs('js/power-driver-registry.js'), sandbox, { filename: 'js/power-driver-registry.js' })
		vm.runInContext(readJs('js/tool-plugin-registry.js'), sandbox, { filename: 'js/tool-plugin-registry.js' })
		vm.runInContext(readJs('js/blu-protocol.js'), sandbox, { filename: 'js/blu-protocol.js' })
	}
	if (opts.withAc6d) {
		sandbox.BigInt = BigInt
		sandbox.Uint16Array = Uint16Array
		sandbox.setInterval = (fn, ms) => {
			const h = setInterval(fn, ms)
			if (h && typeof h.unref === 'function') h.unref()
			return h
		}
		sandbox.clearInterval = clearInterval
	}

	// 记录是否发生过嵌套 AppDialog.confirm/alert/prompt 调用
	let nestedDialogCalls = 0
	for (const m of ['confirm', 'alert', 'prompt']) {
		const orig = sandbox.AppDialog[m].bind(sandbox.AppDialog)
		sandbox.AppDialog[m] = function () {
			if (sandbox.AppDialog.isOpen()) nestedDialogCalls++
			return orig.apply(sandbox.AppDialog, arguments)
		}
	}

	// 2. 按锚点截取并运行 js/common.js 真实的按路协议段（reconcileProtocolFallback / setLaneProtocol / syncTopProtocol）
	const commonSrc = readJs('js/common.js')
	const laneStart = commonSrc.indexOf('// ---- 按路协议 ----')
	const laneEnd = commonSrc.indexOf('// 按路协议到此为止（别删）')
	assert.ok(laneStart > 0 && laneEnd > laneStart, 'js/common.js 按路协议锚点缺失')
	const laneSlice = commonSrc.slice(laneStart, laneEnd)

	const savedToolOptions = (() => {
		try { return JSON.parse(localStorage.getItem('toolOptions') || '{}') || {} } catch (e) { return {} }
	})()
	const savedDual = (() => {
		try { return JSON.parse(localStorage.getItem('serialProtocolDual') || 'null') } catch (e) { return null }
	})()
	const initialMode = opts.mode || 'single'
	const initialActiveSend = opts.activeSendId || (initialMode === 'dual' ? 'A' : 'S')
	const initialSingle = savedToolOptions.skProtocol || 'sek'

	sandbox.SerialHub = {
		mode: initialMode,
		activeSendId: initialActiveSend,
		logModeOf: (sid) => (sid === 'S' ? 'single' : 'dual'),
	}
	sandbox.toolOptions = savedToolOptions
	sandbox.logModeKey = () => sandbox.SerialHub.mode
	sandbox.rerenderParseRows = () => { rerenderCount++ }
	sandbox.notifyLaneConfig = () => { laneConfigCount++ }
	sandbox._activeProtocol = initialMode === 'dual' && savedDual ? (savedDual[initialActiveSend] || initialSingle) : initialSingle
	sandbox.getActiveProtocol = () => sandbox._protocols[sandbox._activeProtocol] || null
	sandbox.SK_DOWN_PRESETS = [{ group: '信息查询 (0x03)', items: [{ name: '查询基本参数', func: '0x03', tlv: [{ tag: 10, items: [{ id: 1, value: [] }] }] }] }]
	sandbox.skParseFrame = () => ({ ok: true })
	sandbox.skFormatFrame = () => '<div class="sk-ok">sek</div>'
	sandbox.skBuildDownFrame = () => new Uint8Array([0x68, 0x03, 0x16])

	vm.runInContext(
		laneSlice +
		'\n;(function () {' +
		'\n  singleProtocolId = ' + JSON.stringify(initialSingle) +
		'\n  laneProtocols = ' + JSON.stringify(savedDual || { A: initialSingle, B: initialSingle }) +
		'\n  window.__laneBridge = {' +
		'\n    reconcileProtocolFallback: reconcileProtocolFallback,' +
		'\n    setLaneProtocol: setLaneProtocol,' +
		'\n    syncTopProtocol: syncTopProtocol,' +
		'\n    writeLaneProtocol: writeLaneProtocol,' +
		'\n    getSingleProtocolId: function () { return singleProtocolId },' +
		'\n    getLaneProtocols: function () { return Object.assign({}, laneProtocols) }' +
		'\n  }' +
		'\n})()',
		sandbox,
		{ filename: 'js/common.js#lane-protocols' }
	)

	let scheduledRerenderCount = 0
	const onRegisteredCalls = []
	sandbox.ProtocolRegistry.setHost({
		onRegistered(id) {
			onRegisteredCalls.push(id)
			const lp = sandbox.__laneBridge ? sandbox.__laneBridge.getLaneProtocols() : null
			if (id === sandbox._activeProtocol || (lp && (lp.A === id || lp.B === id))) {
				scheduledRerenderCount++
			}
		},
		onUnavailable: (id) => sandbox.__laneBridge.reconcileProtocolFallback(id),
		onReconcile: () => sandbox.__laneBridge.reconcileProtocolFallback(null),
		mountGenericPanel: (proto, ctx) => genericHandlers.mountGenericPanel && genericHandlers.mountGenericPanel(proto, ctx),
		unmountGenericPanel: (ctx) => genericHandlers.unmountGenericPanel && genericHandlers.unmountGenericPanel(ctx),
	})

	protoSelect.addEventListener('change', function () {
		if (sandbox.SerialHub.mode === 'dual') {
			sandbox._activeProtocol = this.value
			sandbox.__laneBridge.writeLaneProtocol(sandbox.SerialHub.activeSendId, this.value)
			sandbox.notifyLaneConfig()
		} else {
			sandbox._activeProtocol = this.value
			sandbox.__laneBridge.writeLaneProtocol('S', this.value)
			sandbox.rerenderParseRows()
		}
		previewEl.value = ''
		sandbox.ProtocolRegistry.activatePanel(this.value)
	})

	sandbox.serialLanes = {
		singleTarget: () => (sandbox.SerialHub.mode === 'dual' ? sandbox.SerialHub.activeSendId : 'S'),
		protocolOf: (sid) => sandbox.protocolIdForSid(sid),
		setProtocol: (sid, id) => sandbox.__laneBridge.setLaneProtocol(sid, id),
	}

	sandbox._serialProtocolHost = {
		rawSek: {
			parseFrame: sandbox.skParseFrame,
			formatFrame: sandbox.skFormatFrame,
			buildDownFrame: sandbox.skBuildDownFrame,
		},
		sendHex: (hex) => { sentHex.push(hex); return Promise.resolve() },
		addLogErr: (msg) => logErrors.push(msg),
		getToolOptions: () => savedToolOptions,
		resolveToolEncKey: () => null,
		getDownlinkEncKey: () => null,
		setGenericPanelHandlers: (h) => { genericHandlers = h },
	}

	// 3. 按 index.html 顺序加载：hostproto → (可选 ac6d-protocol) → protocol-downlink → json-protocol → js-protocol-plugin → protocol-manager → collapsible-cards → command-palette → (可选 ac6d-workbench)
	vm.runInContext(readJs('js/hostproto-protocol.js'), sandbox, { filename: 'js/hostproto-protocol.js' })
	if (opts.withAc6d) {
		vm.runInContext(readJs('js/ac6d-protocol.js'), sandbox, { filename: 'js/ac6d-protocol.js' })
	}
	vm.runInContext(readJs('js/protocol-downlink.js'), sandbox, { filename: 'js/protocol-downlink.js' })
	vm.runInContext(readJs('js/json-protocol.js'), sandbox, { filename: 'js/json-protocol.js' })
	vm.runInContext(readJs('js/js-protocol-plugin.js'), sandbox, { filename: 'js/js-protocol-plugin.js' })
	vm.runInContext(readJs('js/protocol-manager.js'), sandbox, { filename: 'js/protocol-manager.js' })
	vm.runInContext(readJs('js/collapsible-cards.js'), sandbox, { filename: 'js/collapsible-cards.js' })
	vm.runInContext(readJs('js/command-palette.js'), sandbox, { filename: 'js/command-palette.js' })
	if (opts.withAc6d) {
		vm.runInContext(readJs('js/ac6d-workbench.js'), sandbox, { filename: 'js/ac6d-workbench.js' })
	}

	return {
		sandbox,
		document,
		localStorage,
		els: {
			protoSelect, downCard, funcTabs, funcSel, presetSel, paramGroup, paramVal, paramSelEnum,
			tlvInput, buildBtn, sendBtn, previewEl, parseHint, rwCard, batchCard, esimCard, adv,
			cmdkInput, cmdkList,
		},
		sentHex,
		logErrors,
		onRegisteredCalls,
		getNestedDialogCalls: () => nestedDialogCalls,
		getRerenderCount: () => rerenderCount,
		getScheduledRerenderCount: () => scheduledRerenderCount,
		getLaneConfigCount: () => laneConfigCount,
	}
}

function hexToU8(hexStr) {
	const clean = String(hexStr || '').replace(/\s+/g, '')
	const out = new Uint8Array(clean.length / 2)
	for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
	return out
}

async function run() {
	// ---- 1. 验证 index.html 实际脚本加载顺序符合共享契约第 1 节 ----
	{
		const html = readJs('index.html')
		const seq = [
			'js/dual-config.js',
			'js/text-byte-encoder.js',
			'js/protocol-registry.js',
			'js/power-driver-registry.js',
			'js/tool-plugin-registry.js',
			'js/common.js',
			'js/wmbus-protocol.js',
			'js/gz-protocol.js',
			'js/cjt188-protocol.js',
			'js/hostproto-protocol.js',
			'js/at-modem-protocol.js',
			'js/ac6d-protocol.js',
			'js/protocol-downlink.js',
			'js/json-protocol.js',
			'js/js-protocol-plugin.js',
			'js/protocol-manager.js',
			'js/blu-protocol.js',
			'js/blu-power.js',
			'js/modern-power.js',
			'js/ac6d-workbench.js',
			'js/app-update.js',
		]
		let prev = -1
		for (const s of seq) {
			const idx = html.indexOf('src="' + s + '"')
			assert.ok(idx > prev, 'index.html 脚本顺序不满足契约：' + s)
			prev = idx
		}
	}

	// ---- 2. 启动自举：刷新恢复已保存的自定义 JSON 协议（不误回退 sek，正确挂载通用下行面板） ----
	{
		// 先用临时环境拿真实 EXAMPLES[0].spec
		const tmp = createIntegrationEnv()
		const sensorSpec = tmp.sandbox.JsonProtocol.EXAMPLES[0].spec
		const env = createIntegrationEnv({
			initialStorage: {
				toolOptions: JSON.stringify({ skProtocol: sensorSpec.id }),
				customJsonProtocols: JSON.stringify([{ spec: sensorSpec, updatedAt: Date.now() }]),
			},
		})
		const { sandbox, els } = env
		assert.equal(sandbox._activeProtocol, sensorSpec.id, '刷新后应保持自定义 JSON 协议')
		assert.equal(els.protoSelect.value, sensorSpec.id, '顶栏下拉框应同步选中自定义 JSON 协议')
		assert.equal(els.downCard.style.display, '', '通用下行卡片应显示')
		assert.equal(els.downCard.dataset.mode, 'generic', '应进入通用下行模式而非 SEK 模式')
		assert.equal(els.rwCard.style.display, '', '跨协议随机测试卡片不应随 SEK 隐藏')
		assert.equal(els.esimCard.style.display, 'none', 'SEK 专属 eSIM 卡片应隐藏')
		assert.equal(els.adv.style.display, 'none', 'SEK 高级加解密应隐藏')
		assert.ok(els.previewEl.value.length > 0, '启动挂载自定义 JSON 协议时应自动生成初始下行 HEX')
	}

	// ---- 3. 启动自举：刷新恢复已信任且启用的 JS 插件协议；以及桌面目录异步加载与失败回退 ----
	{
		const tmp = createIntegrationEnv()
		const code = tmp.sandbox.JsProtocolPlugin.EXAMPLE_CODE
		const hash = tmp.sandbox.JsProtocolPlugin.hashCode(code)
		const env = createIntegrationEnv({
			initialStorage: {
				toolOptions: JSON.stringify({ skProtocol: 'demo-js-echo' }),
				customJsProtocols: JSON.stringify([{ pluginId: 'echo1', name: '回声', fileName: 'echo.js', code, enabled: true, updatedAt: Date.now() }]),
				trustedJsPluginHashes: JSON.stringify({ 'local:echo1': hash }),
			},
		})
		assert.equal(env.sandbox._activeProtocol, 'demo-js-echo')
		assert.equal(env.els.protoSelect.value, 'demo-js-echo')
		assert.equal(env.els.downCard.dataset.mode, 'generic')
		assert.ok(env.els.previewEl.value.startsWith('5A A5 01 04 50 49 4E 47'))

		// 桌面插件目录异步扫描恢复 dir-json 协议
		const sensorSpec = tmp.sandbox.JsonProtocol.EXAMPLES[0].spec
		const dirEnv = createIntegrationEnv({
			initialStorage: { toolOptions: JSON.stringify({ skProtocol: sensorSpec.id }) },
			desktopPluginService: {
				async list() {
					return {
						dir: '/synthetic/protocols',
						files: [{ fileName: 'sensor.json', kind: 'json', size: 1200, content: JSON.stringify(sensorSpec) }],
					}
				},
				async openDir() { return '/synthetic/protocols' },
			},
		})
		await new Promise((r) => setTimeout(r, 20))
		assert.equal(dirEnv.sandbox._activeProtocol, sensorSpec.id, '桌面目录异步加载后应保留 dir-json 活动协议')
		assert.equal(dirEnv.els.protoSelect.value, sensorSpec.id)
		assert.equal(dirEnv.els.downCard.dataset.mode, 'generic')

		// 桌面目录扫描报错且先前保存的协议不存在 -> 自动安全回退到 sek
		const failDirEnv = createIntegrationEnv({
			initialStorage: { toolOptions: JSON.stringify({ skProtocol: 'missing-dir-proto' }) },
			desktopPluginService: {
				async list() { throw new Error('disk io error') },
				async openDir() { return '' },
			},
		})
		await new Promise((r) => setTimeout(r, 20))
		assert.equal(failDirEnv.sandbox._activeProtocol, 'sek', '目录扫描失败且协议不存在时应安全回退 sek')
		assert.equal(failDirEnv.els.protoSelect.value, 'sek')
		assert.equal(failDirEnv.els.downCard.dataset.mode, 'sek')
	}

	{
		const { sandbox } = createIntegrationEnv()
		const reg = sandbox.ProtocolRegistry
		const JP = sandbox.JsonProtocol
		const JS = sandbox.JsProtocolPlugin
		const optIn = { method: 'pcp', versionKey: 'absent', extra: true }
		const spec = { ...JP.EXAMPLES[0].spec, id: 'json-pcp', firmware: optIn }
		assert.equal(JP.importJson(JSON.stringify(spec)).ok, true)
		assert.equal(JP.upsert({ ...spec, id: 'json-not-pcp', firmware: { method: 'wrong' } }).ok, true)
		const code = 'registerProtocol("js-pcp", { firmware: ' + JSON.stringify(optIn) + ' }); registerProtocol("js-not-pcp", { firmware: { method: "wrong" } })'
		const saved = JS.saveLocalPlugin({ pluginId: 'firmware-contract', name: 'Firmware contract', code })
		assert.equal(saved.ok, true)
		assert.equal(JS.trustAndEnable(saved.pluginKey, JS.hashCode(code)).ok, true)
		assert.equal(reg.get('sek').firmware.method, 'pcp')
		assert.equal(JSON.stringify(reg.get('json-pcp').firmware), '{"method":"pcp"}')
		assert.deepEqual(reg.get('json-pcp').firmware, reg.get('js-pcp').firmware)
		assert.equal(reg.get('json-not-pcp').firmware, null)
		assert.equal(reg.get('js-not-pcp').firmware, null)
	}

	// ---- 4. JSON 协议 ↔ protocol-downlink.js 通用下行全链路闭环（含 formatFrame 无双重转义） ----
	{
		const env = createIntegrationEnv()
		const { sandbox, els } = env
		const spec = sandbox.JsonProtocol.EXAMPLES[0].spec
		const upRes = sandbox.JsonProtocol.upsert(spec)
		assert.equal(upRes.ok, true)

		// 切换到该 JSON 协议
		els.protoSelect.value = spec.id
		els.protoSelect.dispatchEvent(new sandbox.Event('change'))
		assert.equal(els.downCard.dataset.mode, 'generic')
		assert.deepEqual(els.funcTabs.children.map((b) => b.dataset.func), ['query', 'ctrl'])

		// 模板 1：「读取通道温湿度」，修改参数通道号为 5 → 生成 HEX → parseFrame + logView + formatFrame 闭环验证
		assert.equal(els.presetSel.value, '读取通道温湿度')
		els.paramVal.value = '5'
		els.paramVal.dispatchEvent(new sandbox.Event('input'))
		els.buildBtn.click()
		assert.ok(els.previewEl.value.length > 0)

		const downBytes = hexToU8(els.previewEl.value)
		const proto = sandbox.ProtocolRegistry.get(spec.id)
		const parsed = proto.parseFrame(downBytes)
		assert.equal(parsed.ok, true, '通用下行生成的帧必须通过 parseFrame 校验')
		assert.equal(parsed.crcOk, true, 'CRC16-Modbus 校验必须通过')
		assert.equal(parsed.title, '读取温湿度请求')
		assert.equal(parsed.fields['通道号'].value, 5)

		const lv = proto.logView(parsed)
		const renderedLv = sandbox.ParseView.render(lv)
		const renderedFmt = proto.formatFrame(parsed)
		assert.ok(renderedLv.includes('读取温湿度请求') && renderedLv.includes('通道号'))
		assert.ok(renderedFmt.includes('pv-grid') && renderedFmt.includes('读取温湿度请求'), '经 ProtocolRegistry 包装的 JSON 协议 formatFrame 应输出正常 .pv 结构')
		assert.ok(!renderedFmt.includes('&lt;div class=&quot;pv'), '严禁出现 HTML 双重转义')

		// 切到「控制」Tab → 「继电器控制」→ 选枚举 '0'(断开) → 构建 → 解析闭环
		els.funcSel.value = 'ctrl'
		els.funcSel.dispatchEvent(new sandbox.Event('change'))
		assert.equal(els.presetSel.value, '继电器控制')
		els.paramSelEnum.value = '0'
		els.paramSelEnum.dispatchEvent(new sandbox.Event('change'))
		els.buildBtn.click()
		const ctrlBytes = hexToU8(els.previewEl.value)
		const parsedCtrl = proto.parseFrame(ctrlBytes)
		assert.equal(parsedCtrl.ok, true)
		assert.equal(parsedCtrl.crcOk, true)
		assert.equal(parsedCtrl.fields['动作'].formatted, '断开')
	}

	// ---- 5. JS 插件 ↔ ProtocolManager (真实 AppDialog.panel) ↔ ProtocolRegistry ↔ command-palette.js ↔ XSS 单次转义 ↔ 删除自动回退 ----
	{
		const env = createIntegrationEnv()
		const { sandbox, els } = env

		// 打开协议管理 → JS 插件 Tab
		assert.equal(sandbox.ProtocolManager.open('js'), true)
		assert.equal(sandbox.ProtocolManager.isOpen(), true)

		const findBtn = (text) => {
			const btns = sandbox.document.body.querySelectorAll('button')
			return btns.find((b) => b.textContent.trim() === text)
		}

		// 新建示例插件 → 保存源码
		const newJsBtn = findBtn('新建示例插件')
		assert.ok(newJsBtn, '应有「新建示例插件」按钮')
		newJsBtn.click()
		const saveJsBtn = findBtn('保存源码')
		assert.ok(saveJsBtn, '应有「保存源码」按钮')
		saveJsBtn.click()

		// 未点内联信任前：绝不可注册进 ProtocolRegistry、下拉框或命令面板
		assert.equal(sandbox.ProtocolRegistry.has('demo-js-echo'), false, '未信任前协议不得注册')
		assert.equal(els.protoSelect.options.some((o) => o.value === 'demo-js-echo'), false)

		// 点击内联「信任并启用…」→ 点击内联「我已知晓风险，信任并启用」
		const trustBtn = findBtn('信任并启用…')
		assert.ok(trustBtn, '应展示「信任并启用…」按钮')
		trustBtn.click()
		const trustConfirmBtn = findBtn('我已知晓风险，信任并启用')
		assert.ok(trustConfirmBtn, '应展示内联风险确认按钮')
		trustConfirmBtn.click()
		assert.equal(env.getNestedDialogCalls(), 0, '面板内信任确认严禁嵌套调用 AppDialog.confirm/alert/prompt')

		// 验证进入 ProtocolRegistry、#serial-protocol-select 与命令面板「切换协议：JS 回声协议示例」
		assert.equal(sandbox.ProtocolRegistry.has('demo-js-echo'), true)
		assert.ok(sandbox.ProtocolRegistry.list().some((x) => x.id === 'demo-js-echo'))
		assert.ok(els.protoSelect.options.some((o) => o.value === 'demo-js-echo'))

		// 关闭协议管理面板后打开真实命令面板验证动态切换协议命令
		const closeDlgBtn = findBtn('关闭')
		assert.ok(closeDlgBtn)
		closeDlgBtn.click()
		await Promise.resolve()
		assert.equal(sandbox.ProtocolManager.isOpen(), false)

		sandbox.serialCommandPalette.open()
		assert.ok(els.cmdkList.innerHTML.includes('切换协议：JS 回声协议示例'), '命令面板应动态列出新启用的 JS 协议切换命令')
		assert.ok(els.cmdkList.innerHTML.includes('协议管理'), '命令面板应包含协议管理入口')
		sandbox.serialCommandPalette.close()

		// 切换到该 JS 协议并验证通用下行构建 + 解析往返
		els.protoSelect.value = 'demo-js-echo'
		els.protoSelect.dispatchEvent(new sandbox.Event('change'))
		assert.equal(els.downCard.dataset.mode, 'generic')
		assert.ok(els.previewEl.value.length > 0)
		const echoBytes = hexToU8(els.previewEl.value)
		const echoProto = sandbox.ProtocolRegistry.get('demo-js-echo')
		const parsedEcho = echoProto.parseFrame(echoBytes)
		assert.equal(parsedEcho.ok, true)
		assert.equal(parsedEcho.crcOk, true)

		// 停用/删除当前使用中的 JS 插件 → 自动安全回退到 'sek'
		const plugin = sandbox.JsProtocolPlugin.listPlugins().find((p) => p.registeredIds.includes('demo-js-echo'))
		assert.ok(plugin)
		const disRes = sandbox.JsProtocolPlugin.setEnabled(plugin.pluginKey, false)
		assert.equal(disRes.ok, true)
		assert.equal(sandbox.ProtocolRegistry.has('demo-js-echo'), false)
		assert.equal(sandbox._activeProtocol, 'sek', '停用当前使用中的 JS 插件后必须自动回退到 sek')
		assert.equal(els.protoSelect.value, 'sek')
		assert.equal(els.downCard.dataset.mode, 'sek')
		assert.equal(els.rwCard.style.display, '')

		// XSS 单次转义验证（严禁双重转义 &amp;lt;）
		const xssCode = [
			"registerProtocol('xss-single-escape', {",
			"  name: 'XSS单次转义测试',",
			"  parseFrame(b) { return { ok: true, matchedHead: true, raw: b } },",
			"  logView() { return { title: 'a < b', sections: [{ title: '段', html: '<img src=x onerror=alert(1)>' }] } },",
			"  formatFrame() { return 'a < b <img src=x onerror=alert(1)>' },",
			'})',
		].join('\n')
		const savedXss = sandbox.JsProtocolPlugin.saveLocalPlugin({ pluginId: 'xss-test', name: 'XSS测试', code: xssCode })
		assert.equal(savedXss.ok, true)
		const trXss = sandbox.JsProtocolPlugin.trustAndEnable(savedXss.pluginKey)
		assert.equal(trXss.ok, true)

		const xssProto = sandbox.ProtocolRegistry.get('xss-single-escape')
		const fmtOut = xssProto.formatFrame({})
		assert.ok(fmtOut.includes('a &lt; b &lt;img src=x onerror=alert(1)&gt;'), 'formatFrame 应准确转义一次')
		assert.ok(!fmtOut.includes('&amp;lt;'), 'formatFrame 严禁双重转义')
		assert.ok(!fmtOut.includes('<img'), 'formatFrame 不得保留原始 <img>')

		const lvOut = xssProto.logView({})
		assert.equal('html' in lvOut.sections[0], false, 'logView 不得保留 section.html')
		const renderedLv = sandbox.ParseView.render(lvOut)
		assert.ok(renderedLv.includes('a &lt; b') && renderedLv.includes('&lt;img src=x onerror=alert(1)&gt;'))
		assert.ok(!renderedLv.includes('&amp;lt;') && !renderedLv.includes('<img'))

		// 删除该插件后完全清理
		assert.equal(sandbox.JsProtocolPlugin.removeLocalPlugin('xss-test').ok, true)
		assert.equal(sandbox.ProtocolRegistry.has('xss-single-escape'), false)
	}

	// ---- 6. Major-1：重扫桌面插件目录时单路与双路 B 路使用中的目录协议保持不变；文件删除后才安全回退 ----
	{
		const tmp = createIntegrationEnv()
		const sensorSpec = tmp.sandbox.JsonProtocol.EXAMPLES[0].spec
		const jsCode = tmp.sandbox.JsProtocolPlugin.EXAMPLE_CODE
		const jsHash = tmp.sandbox.JsProtocolPlugin.hashCode(jsCode)
		let files = [
			{ fileName: 'sensor.json', kind: 'json', size: 1200, content: JSON.stringify(sensorSpec) },
			{ fileName: 'echo.js', kind: 'js', size: jsCode.length, content: jsCode },
		]
		const env = createIntegrationEnv({
			mode: 'dual',
			activeSendId: 'A',
			initialStorage: {
				toolOptions: JSON.stringify({ skProtocol: sensorSpec.id }),
				serialProtocolDual: JSON.stringify({ A: sensorSpec.id, B: 'demo-js-echo' }),
				trustedJsPluginHashes: JSON.stringify({ 'dir:echo.js': jsHash }),
			},
			desktopPluginService: {
				async list() { return { dir: '/synthetic/protocols', files: files.slice(), truncated: false } },
				async openDir() { return '/synthetic/protocols' },
			},
		})
		await env.sandbox.JsProtocolPlugin.whenScanned()
		await new Promise((r) => setTimeout(r, 10))
		assert.equal(env.sandbox.__laneBridge.getSingleProtocolId(), sensorSpec.id)
		assert.deepEqual({ ...env.sandbox.__laneBridge.getLaneProtocols() }, { A: sensorSpec.id, B: 'demo-js-echo' })
		assert.ok(env.onRegisteredCalls.includes(sensorSpec.id) && env.onRegisteredCalls.includes('demo-js-echo'), '启动桌面目录扫描注册后必须补调 onRegistered')
		assert.ok(env.getScheduledRerenderCount() >= 2, '桌面目录协议晚到后必须调度解析重渲以刷新历史日志')
		const rerendersBefore = env.getRerenderCount()
		const schedBefore = env.getScheduledRerenderCount()

		// 再次重扫（两个文件仍在）→ 单路、双路 A/B 均不得被改成 sek，不走同步回退重渲，同时补调 onRegistered 调度异步解析重渲
		await env.sandbox.JsProtocolPlugin.scanDesktopDir()
		assert.equal(env.sandbox.__laneBridge.getSingleProtocolId(), sensorSpec.id, '重扫后单路目录 JSON 协议必须保持不变')
		assert.equal(JSON.parse(env.localStorage.getItem('toolOptions')).skProtocol, sensorSpec.id)
		assert.deepEqual({ ...env.sandbox.__laneBridge.getLaneProtocols() }, { A: sensorSpec.id, B: 'demo-js-echo' }, '重扫后双路目录协议必须保持不变')
		assert.equal(env.getRerenderCount(), rerendersBefore, '协议仍在时重扫不应误触发同步回退重渲')
		assert.ok(env.getScheduledRerenderCount() > schedBefore, '重扫更新在用目录协议后必须经 onRegistered 调度异步重渲')

		// 删除 echo.js 后重扫 → 仅双路 B 回退到 sek，A 和单路仍保持 sensorSpec.id
		files = [{ fileName: 'sensor.json', kind: 'json', size: 1200, content: JSON.stringify(sensorSpec) }]
		await env.sandbox.JsProtocolPlugin.scanDesktopDir()
		assert.equal(env.sandbox.__laneBridge.getSingleProtocolId(), sensorSpec.id)
		assert.deepEqual({ ...env.sandbox.__laneBridge.getLaneProtocols() }, { A: sensorSpec.id, B: 'sek' }, '删除目录 JS 文件后仅受影响的 B 路回退 sek')

		// 再删除 sensor.json 后重扫 → 单路与 A 路回退到 sek 并清空下发预览框
		env.els.previewEl.value = 'AA 55 01 01 05 00 00 0D'
		files = []
		await env.sandbox.JsProtocolPlugin.scanDesktopDir()
		assert.equal(env.sandbox.__laneBridge.getSingleProtocolId(), 'sek')
		assert.deepEqual({ ...env.sandbox.__laneBridge.getLaneProtocols() }, { A: 'sek', B: 'sek' })
		assert.equal(env.sandbox._activeProtocol, 'sek')
		assert.equal(env.els.previewEl.value, '68 03 16', '回退到 sek 后预览框由 sek 重建，不残留旧协议帧')

		// N-2：隐藏某目录协议后重扫（文件仍在）保持隐藏；文件删除再重扫后从 protocolHiddenIds 清理残留
		files = [{ fileName: 'sensor.json', kind: 'json', size: 1200, content: JSON.stringify(sensorSpec) }]
		await env.sandbox.JsProtocolPlugin.scanDesktopDir()
		assert.equal(env.sandbox.ProtocolRegistry.setHidden(sensorSpec.id, true).ok, true)
		assert.equal(env.sandbox.ProtocolRegistry.isHidden(sensorSpec.id), true)
		await env.sandbox.JsProtocolPlugin.scanDesktopDir()
		assert.equal(env.sandbox.ProtocolRegistry.isHidden(sensorSpec.id), true, '隐藏的目录协议重扫且文件仍在时应保留隐藏态')
		assert.ok(JSON.parse(env.localStorage.getItem('protocolHiddenIds') || '[]').includes(sensorSpec.id))
		files = []
		await env.sandbox.JsProtocolPlugin.scanDesktopDir()
		assert.equal(JSON.parse(env.localStorage.getItem('protocolHiddenIds') || '[]').includes(sensorSpec.id), false, '目录文件删除后再重扫应清除 protocolHiddenIds 残留')
	}

	// ---- 7. Major-2：加载真实 collapsible-cards.js 后连续切换协议，.collapsible-chevron 始终保留且折叠正常 ----
	{
		const env = createIntegrationEnv()
		const { sandbox, els } = env
		const spec = sandbox.JsonProtocol.EXAMPLES[0].spec
		sandbox.JsonProtocol.upsert(spec)

		const header = els.downCard.querySelector(':scope > h6.pane-section-title')
		assert.ok(header)
		const chevron = header.querySelector('.collapsible-chevron')
		assert.ok(chevron, 'collapsible-cards.js 应已插入折叠箭头')
		assert.equal(header.children[0], chevron)

		// 连续切换 sek → hostproto → JSON 协议 → sek
		for (const nextId of ['hostproto', spec.id, 'sek']) {
			els.protoSelect.value = nextId
			els.protoSelect.dispatchEvent(new sandbox.Event('change'))
			const curChevron = header.querySelector('.collapsible-chevron')
			assert.equal(curChevron, chevron, '切到 ' + nextId + ' 后原折叠箭头节点必须仍在标题内')
			assert.equal(header.children[0], chevron, '折叠箭头必须仍在标题首位')
		}
		assert.equal(els.downCard.classList.contains('is-collapsed'), false)
		header.click()
		assert.equal(els.downCard.classList.contains('is-collapsed'), true, '点击标题应正常折叠')
		assert.equal(chevron.classList.contains('bi-chevron-right'), true)
		header.click()
		assert.equal(els.downCard.classList.contains('is-collapsed'), false, '再次点击标题应正常展开')
		assert.equal(chevron.classList.contains('bi-chevron-down'), true)
	}

	// ---- 8. Minor-2/3/4/5/6/8：双路非主发路启动回退、跨来源 ID 冲突防护、移动端禁执行 JS 插件、TOCTOU 哈希绑定、builtin 锁、隐藏主发路清空预览 ----
	{
		// Minor-2：非桌面启动时主发路 A 为 sek，但双路非主发路 B 指向已删除协议 → 启动收尾自动回退 B 为 sek
		const dualStartup = createIntegrationEnv({
			mode: 'dual',
			activeSendId: 'A',
			initialStorage: {
				toolOptions: JSON.stringify({ skProtocol: 'sek' }),
				serialProtocolDual: JSON.stringify({ A: 'sek', B: 'deleted-proto' }),
			},
		})
		await Promise.resolve()
		assert.deepEqual({ ...dualStartup.sandbox.__laneBridge.getLaneProtocols() }, { A: 'sek', B: 'sek' }, '双路非主发路 B 启动时必须自动回退')

		// N-3：启动时已信任的本地 JS 插件尝试直接调 ProtocolRegistry.register('sek', { builtin: true }) 抢注，因 sek 已先锁定必须被拒且内置 sek 完好
		const hijackCode = "ProtocolRegistry.register('sek', { builtin: true, name: 'Hijacked SEK', parseFrame() { return { ok: true } } })"
		const hijackHash = dualStartup.sandbox.JsProtocolPlugin.hashCode(hijackCode)
		const hijackEnv = createIntegrationEnv({
			initialStorage: {
				customJsProtocols: JSON.stringify([{ pluginId: 'hijack', name: 'Hijack', fileName: 'hijack.js', code: hijackCode, enabled: true, updatedAt: Date.now() }]),
				trustedJsPluginHashes: JSON.stringify({ 'local:hijack': hijackHash }),
			},
		})
		await Promise.resolve()
		assert.equal(hijackEnv.sandbox.ProtocolRegistry.get('sek').name, 'SEK', 'sek 在自定义插件执行前已锁定，不得被已信任插件抢注')
		const hijackEntry = hijackEnv.sandbox.JsProtocolPlugin.listPlugins().find((p) => p.pluginId === 'hijack')
		assert.ok(hijackEntry && /保留|内置/.test(hijackEntry.error), '抢注 sek 应报错并被插件加载器记录错误')

		// Minor-8：隐藏主发路 hostproto 时清空残留的 hostproto 预览框
		const env = createIntegrationEnv()
		env.els.protoSelect.value = 'hostproto'
		env.els.protoSelect.dispatchEvent(new env.sandbox.Event('change'))
		env.els.previewEl.value = 'AA 55 DE AD BE EF'
		// 注册一个无 presets 的自定义协议作 fallback 场景：若把 hostproto 隐藏回退到 sek（sek 有预设会重写），验证不残留 AA 55 DE AD BE EF
		assert.equal(env.sandbox.ProtocolRegistry.setHidden('hostproto', true).ok, true)
		assert.notEqual(env.els.previewEl.value, 'AA 55 DE AD BE EF', '主发路回退后严禁残留旧协议下发 HEX')

		// Minor-4：跨来源外部协议 ID 冲突防护（JSON 已占 shared-id，JS 插件不得覆盖）
		const customSpec = JSON.parse(JSON.stringify(env.sandbox.JsonProtocol.EXAMPLES[0].spec))
		customSpec.id = 'shared-id'
		assert.equal(env.sandbox.JsonProtocol.upsert(customSpec).ok, true)
		const conflictJs = "registerProtocol('shared-id', { name: '恶意抢注', parseFrame() { return { ok: true } } })"
		const sConflict = env.sandbox.JsProtocolPlugin.saveLocalPlugin({ pluginId: 'conflict-js', name: '冲突测试', code: conflictJs })
		assert.equal(sConflict.ok, true)
		const tConflict = env.sandbox.JsProtocolPlugin.trustAndEnable(sConflict.pluginKey)
		assert.equal(tConflict.ok, false, 'JS 插件不得覆盖同名 JSON 协议')
		assert.equal(env.sandbox.ProtocolRegistry.get('shared-id').source, 'json', '原 JSON 协议必须保持完好')
		env.sandbox.JsProtocolPlugin.removeLocalPlugin('conflict-js')
		assert.equal(env.sandbox.ProtocolRegistry.has('shared-id'), true, '移除冲突 JS 插件绝不可误删原 JSON 协议')

		// Minor-5：trustAndEnable 绑定 expectedHash 防 TOCTOU
		const pCode1 = "registerProtocol('toctou-demo', { name: 'V1', parseFrame() { return { ok: true } } })"
		const pCode2 = "registerProtocol('toctou-demo', { name: 'V2', parseFrame() { return { ok: true } } })"
		const sToc = env.sandbox.JsProtocolPlugin.saveLocalPlugin({ pluginId: 'toctou', name: 'TOCTOU', code: pCode1 })
		const hashV1 = env.sandbox.JsProtocolPlugin.hashCode(pCode1)
		// 在用户确认前源码被修改为 V2
		env.sandbox.JsProtocolPlugin.saveLocalPlugin({ pluginId: 'toctou', name: 'TOCTOU', code: pCode2 })
		const badTrust = env.sandbox.JsProtocolPlugin.trustAndEnable(sToc.pluginKey, hashV1)
		assert.equal(badTrust.ok, false, '源码已变但传入旧 hash 时必须拒绝信任')
		assert.equal(env.sandbox.ProtocolRegistry.has('toctou-demo'), false)

		// Minor-6：收紧 builtin 判定（保留 ID 首次注册后锁定不可再以 builtin:true 覆盖；非保留 ID 自报 builtin:true 仍按外部隔离）
		assert.throws(
			() => env.sandbox.ProtocolRegistry.register('sek', { builtin: true, name: 'Spoof SEK' }),
			/保留|内置/,
			'sek 注册后不得再被 builtin:true 覆盖'
		)
		env.sandbox.ProtocolRegistry.register('fake-builtin', {
			builtin: true,
			name: '伪造内置',
			formatFrame: () => '<img src=x onerror=1>',
		})
		assert.equal(env.sandbox.ProtocolRegistry.isBuiltin('fake-builtin'), false, '非保留 ID 自报 builtin:true 不得被认作内置')
		assert.ok(!env.sandbox.ProtocolRegistry.get('fake-builtin').formatFrame({}).includes('<img'), '伪造内置仍受外部转义隔离')

		// Minor-4 移动端：即使 localStorage 中存在已信任且启用的 JS 插件，移动端也不得执行其代码
		const mobCode = 'window.__mobileRan = true; registerProtocol("mob-p", { name: "Mob" })'
		const mobHash = env.sandbox.JsProtocolPlugin.hashCode(mobCode)
		const mobEnv = createIntegrationEnv({
			mobile: true,
			initialStorage: {
				customJsProtocols: JSON.stringify([{ pluginId: 'mob', name: 'Mob', fileName: 'mob.js', code: mobCode, enabled: true, updatedAt: Date.now() }]),
				trustedJsPluginHashes: JSON.stringify({ 'local:mob': mobHash }),
			},
		})
		assert.equal(mobEnv.sandbox.__mobileRan, undefined, '移动端画像下绝不可执行任何外部 JS 插件代码')
		assert.equal(mobEnv.sandbox.ProtocolRegistry.has('mob-p'), false)
	}

	// ---- 9. 端到端多能力插件联调：单个受信任 JS 插件同时注册通信协议 + 功耗仪驱动 + 左栏工具视图，停用后三处同步卸载并安全回退 ----
	{
		const env = createIntegrationEnv({ withRailAndPower: true })
		const { sandbox, document, els } = env
		const PR = sandbox.ProtocolRegistry
		const PDR = sandbox.PowerDriverRegistry
		const TPR = sandbox.ToolPluginRegistry
		const JSP = sandbox.JsProtocolPlugin

		assert.equal(PDR.has('blu-100k'), true, '内置 blu-100k 功耗仪驱动应已就绪')
		assert.equal(PDR.getActiveId(), 'blu-100k')
		assert.equal(TPR.has('power'), true, '内置 power 左栏工具应已就绪')

		sandbox.__e2eLog = []
		const multiCode = [
			"registerProtocol('e2e-multi-proto', {",
			"  name: '联调三合一协议',",
			"  version: '1.0.0',",
			"  parseFrame(b) { return { ok: true, matchedHead: true, raw: b } },",
			"  logView() { return { title: '联调帧' } },",
			"})",
			"registerPowerDriver('e2e-multi-meter', {",
			"  name: '联调 CSV 电流表',",
			"  shortName: '联调表',",
			"  version: '1.0.0',",
			"  serialOptions: { baudRate: 115200 },",
			"  capabilities: { nominalHz: 200, voltage: { supported: false }, dutPower: { supported: false }, logicBits: 0 },",
			"  createSession() {",
			"    let buf = ''",
			"    const dec = new TextDecoder()",
			"    return {",
			"      pushChunk(u8) {",
			"        buf += dec.decode(u8, { stream: true })",
			"        const lines = buf.split(/\\r?\\n/)",
			"        buf = lines.pop() || ''",
			"        return lines.map(s => Number(s.trim())).filter(Number.isFinite)",
			"      },",
			"      resetStream() { buf = '' },",
			"    }",
			"  },",
			"})",
			"registerToolPlugin('e2e-multi-tool', {",
			"  name: '联调校验工装',",
			"  label: '工装',",
			"  icon: 'bi-tools',",
			"  hideTopbar: true,",
			"  mount(container, ctx) {",
			"    window.__e2eLog.push('mount:' + ctx.id)",
			"    const p = document.createElement('div')",
			"    p.textContent = '联调工具已挂载'",
			"    container.appendChild(p)",
			"  },",
			"  onActivate(ctx) { window.__e2eLog.push('activate:' + ctx.id) },",
			"  onDeactivate(ctx) { window.__e2eLog.push('deactivate:' + ctx.id) },",
			"  unmount(ctx) { window.__e2eLog.push('unmount:' + ctx.id) },",
			"})",
		].join('\n')

		const saved = JSP.saveLocalPlugin({ pluginId: 'e2e-tri', name: '三合一联调插件', fileName: 'e2e-tri.js', code: multiCode })
		assert.equal(saved.ok, true)
		assert.equal(saved.needsTrust, true)
		assert.equal(PR.has('e2e-multi-proto'), false)
		assert.equal(PDR.has('e2e-multi-meter'), false)
		assert.equal(TPR.has('e2e-multi-tool'), false)

		// 待信任时左栏插件按钮应亮起提示圆点
		const manageBtn = document.getElementById('serial-protocol-manage')
		const dotBefore = manageBtn && manageBtn.querySelector('.rail-status-dot')
		assert.ok(dotBefore && dotBefore.hidden === false, '待信任插件应在左栏 #serial-protocol-manage 显示提示点')

		// 显式信任并启用（绑定哈希防 TOCTOU）
		const tr = JSP.trustAndEnable(saved.pluginKey, JSP.hashCode(multiCode))
		assert.equal(tr.ok, true)
		assert.deepEqual([...tr.registeredIds], ['e2e-multi-proto'])
		assert.deepEqual([...tr.registeredPowerIds], ['e2e-multi-meter'])
		assert.deepEqual([...tr.registeredToolIds], ['e2e-multi-tool'])
		assert.equal(dotBefore.hidden, true, '信任后待确认提示点应隐藏')

		// 1) ProtocolRegistry 生效并切到该协议
		assert.equal(PR.has('e2e-multi-proto'), true)
		els.protoSelect.value = 'e2e-multi-proto'
		els.protoSelect.dispatchEvent(new sandbox.Event('change'))
		assert.equal(sandbox._activeProtocol, 'e2e-multi-proto')

		// 2) PowerDriverRegistry 生效、会话解析正常并切到该驱动
		assert.equal(PDR.has('e2e-multi-meter'), true)
		const drv = PDR.get('e2e-multi-meter')
		const sess = drv.createSession()
		const samples = sess.pushChunk(new TextEncoder().encode('12.5\n34.0\n'))
		assert.deepEqual([...samples.map((x) => x.iUA)], [12.5, 34])
		assert.equal(PDR.setActiveId('e2e-multi-meter').ok, true)
		assert.equal(PDR.getActiveId(), 'e2e-multi-meter')

		// 3) ToolPluginRegistry 生效、按钮插在分隔线上方、容器建好并可激活
		assert.equal(TPR.has('e2e-multi-tool'), true)
		const toolItem = TPR.list().find((x) => x.id === 'e2e-multi-tool')
		assert.ok(toolItem && toolItem.visible === true && toolItem.selectable === true)
		const railTop = document.querySelector('.rail-top')
		const toolBtnIdx = railTop.children.findIndex((c) => c.dataset && c.dataset.toolPlugin === 'e2e-multi-tool')
		const sepIdx = railTop.children.findIndex((c) => c.classList && c.classList.contains('rail-divider'))
		assert.ok(toolBtnIdx >= 0 && toolBtnIdx < sepIdx, '外部工具按钮必须位于左栏分隔线上方')
		const toolView = document.getElementById('view-plugin-e2e-multi-tool')
		assert.ok(toolView && toolView.dataset.hideTopbar === 'true')
		assert.equal(TPR.activateView('view-plugin-e2e-multi-tool'), 'view-plugin-e2e-multi-tool')
		assert.equal(TPR.getActiveView(), 'view-plugin-e2e-multi-tool')

		// 4) 停用插件 → 三处注册表同步卸载并全部安全回退到默认项
		const disRes = JSP.setEnabled(saved.pluginKey, false)
		assert.equal(disRes.ok, true)
		assert.equal(PR.has('e2e-multi-proto'), false)
		assert.equal(sandbox._activeProtocol, 'sek', '停用多能力插件后通信协议应安全回退 sek')
		assert.equal(els.protoSelect.value, 'sek')

		assert.equal(PDR.has('e2e-multi-meter'), false)
		assert.equal(PDR.getActiveId(), 'blu-100k', '停用多能力插件后功耗仪驱动应安全回退 blu-100k')

		assert.equal(TPR.has('e2e-multi-tool'), false)
		assert.equal(TPR.getActiveView(), 'view-serial', '停用多能力插件后左栏活动视图应安全回退 view-serial')
		assert.equal(document.getElementById('view-plugin-e2e-multi-tool'), null, '动态工具视图 DOM 必须清理干净')
		assert.equal(railTop.children.some((c) => c.dataset && c.dataset.toolPlugin === 'e2e-multi-tool'), false, '动态左栏按钮必须清理干净')
		assert.deepEqual([...sandbox.__e2eLog], ['mount:e2e-multi-tool', 'activate:e2e-multi-tool', 'deactivate:e2e-multi-tool', 'unmount:e2e-multi-tool'])
	}

	// ---- 10. 真实 AC6D 协议 + 真实 AC6D 校表工作台 + 真实 ToolPluginRegistry + 真实 ProtocolManager + 真实命令面板全链路联调 ----
	{
		const SerialAdapter = require('../js/serial-adapter.js')
		const Ac6dProtoReal = require('../js/ac6d-protocol.js')
		const Ac6dWbReal = require('../js/ac6d-workbench.js')

		const env = createIntegrationEnv({ withRailAndPower: true, withAc6d: true })
		const { sandbox, document, els } = env
		const PR = sandbox.ProtocolRegistry
		const TPR = sandbox.ToolPluginRegistry
		const JSP = sandbox.JsProtocolPlugin

		// 10.1 注册表与保留 ID 防护
		assert.equal(PR.has('ac6d-meter'), true, '内置 ac6d-meter 通信协议应自动注册')
		assert.equal(PR.get('ac6d-meter').name, '容积水表 (AC6D)')
		assert.equal(PR.get('ac6d-meter').builtin, true)
		assert.equal(TPR.has('ac6d'), true, '内置 ac6d 左栏工具应自动注册')
		assert.equal(TPR.get('ac6d').name, '容积水表校表台')
		assert.equal(TPR.get('ac6d').viewId, 'view-ac6d')
		assert.equal(TPR.get('ac6d').builtin, true)

		const spoofTool = JSP.saveLocalPlugin({ pluginId: 'spoof-ac6d-tool', name: '伪造水表', code: "registerToolPlugin('ac6d', { name: '假水表' })" })
		assert.equal(JSP.trustAndEnable(spoofTool.pluginKey).ok, false, '外部 JS 插件不得抢注保留工具 ID ac6d')
		const spoofProto = JSP.saveLocalPlugin({ pluginId: 'spoof-ac6d-proto', name: '伪造协议', code: "registerProtocol('ac6d-meter', { name: '假协议' })" })
		assert.equal(JSP.trustAndEnable(spoofProto.pluginKey).ok, false, '外部 JS 插件不得抢注保留协议 ID ac6d-meter')

		// 10.2 ProtocolManager 列出 ac6d-meter（通信协议）与 ac6d（左栏工具，含打开与显隐开关）
		assert.equal(sandbox.ProtocolManager.open('installed'), true)
		const allRows = document.body.querySelectorAll('.pm-item')
		const ac6dProtoRow = allRows.find((r) => r.dataset && r.dataset.protocolId === 'ac6d-meter')
		const ac6dToolRow = allRows.find((r) => r.dataset && r.dataset.toolPluginId === 'ac6d')
		const powerToolRow = allRows.find((r) => r.dataset && r.dataset.toolPluginId === 'power')
		assert.ok(ac6dProtoRow && ac6dProtoRow.textContent.includes('容积水表 (AC6D)'), 'ProtocolManager 通信协议列表应包含 ac6d-meter')
		assert.ok(ac6dToolRow && ac6dToolRow.textContent.includes('容积水表校表台'), 'ProtocolManager 左栏工具列表应包含 ac6d')
		assert.ok(powerToolRow && powerToolRow.textContent.includes('功耗分析'), 'ProtocolManager 左栏工具列表应并列包含 power')
		const ac6dSwitch = document.getElementById('pm-tool-vis-ac6d')
		assert.ok(ac6dSwitch && ac6dSwitch.checked === true, 'ac6d 左栏工具开关应默认启用')
		const openAc6dBtn = ac6dToolRow.querySelectorAll('button').find((b) => b.textContent.trim() === '打开视图')
		assert.ok(openAc6dBtn && !openAc6dBtn.disabled, 'ac6d 左栏工具应提供可用的「打开视图」按钮')
		openAc6dBtn.click()
		await Promise.resolve()
		assert.equal(TPR.getActiveView(), 'view-ac6d', '点击「打开视图」应激活 view-ac6d')
		assert.equal(sandbox.ProtocolManager.isOpen(), false, '打开视图后管理对话框应自动关闭')

		// 10.3 Command Palette 列出 容积水表校表台 一次且不重复功耗分析，隐藏后消失
		sandbox.serialCommandPalette.open()
		const cmdHtml = els.cmdkList.innerHTML
		assert.equal(cmdHtml.split('切换到：容积水表校表台').length - 1, 1, '命令面板应恰好列出一次「容积水表校表台」')
		assert.equal(cmdHtml.split('切换到功耗分析').length - 1, 1, '命令面板应恰好列出一次「功耗分析」')
		assert.equal(cmdHtml.includes('切换到：功耗分析'), false, '命令面板不得重复列出功耗分析')
		sandbox.serialCommandPalette.close()

		assert.equal(TPR.setHidden('ac6d', true).ok, true)
		assert.equal(TPR.getActiveView(), 'view-serial', '隐藏当前激活的 ac6d 视图后应回退 view-serial')
		sandbox.serialCommandPalette.open()
		assert.equal(els.cmdkList.innerHTML.includes('容积水表校表台'), false, '隐藏 ac6d 后命令面板不应再显示它')
		sandbox.serialCommandPalette.close()
		assert.equal(TPR.setHidden('ac6d', false).ok, true)

		// 10.4 真实二进制帧端到端联调：Real Ac6dProtocol + Real Ac6dWorkbench + Real SerialAdapter.createStreamPort
		const packU16 = (v) => [v & 0xff, (v >> 8) & 0xff]
		const packI16 = (v) => [(v & 0xff), ((v >> 8) & 0xff)]
		const packU32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
		const packU64 = (v) => {
			let bi = typeof v === 'bigint' ? v : BigInt(v)
			const out = []
			for (let i = 0; i < 8; i++) { out.push(Number(bi & 0xffn)); bi >>= 8n }
			return out
		}
		const asciiPad = (s, n) => {
			const out = new Array(n).fill(0)
			for (let i = 0; i < Math.min(s.length, n); i++) out[i] = s.charCodeAt(i) & 0xff
			return out
		}
		const makeAc6dRsp = (seq, cmd, status, addr, dataBytes) => {
			const pkt = addr == null
				? Uint8Array.from([cmd & 0xff, status & 0xff, ...(dataBytes || [])])
				: Uint8Array.from([cmd & 0xff, status & 0xff, ...packU32(addr), ...(dataBytes || [])])
			return Ac6dProtoReal.buildFrame(seq, pkt)
		}
		const makeA99aUplink = (userNumberHex, imei, iccid, seqOverride) => {
			const revBytes = (hex) => {
				const b = Ac6dProtoReal.hexToBytes(hex)
				const r = new Uint8Array(b.length)
				for (let i = 0; i < b.length; i++) r[i] = b[b.length - 1 - i]
				return Array.from(r)
			}
			const tlv1Val = [
				0x00, ...asciiPad(imei, 15),
				0x02, ...asciiPad(iccid, 20),
				0x03, ...revBytes(userNumberHex),
				0x04, ...revBytes('08091011121314'),
			]
			const tlv1 = [0x01, ...packU16(tlv1Val.length), ...tlv1Val]
			const dataDom = [...packU16(tlv1.length), ...tlv1]
			const seqNum = seqOverride != null ? seqOverride : 7
			const body = Uint8Array.from([
				0xa9, 0x9a, ...packU16(seqNum), 0x02, 0x01, 0x10,
				...revBytes('08091011121314'),
				...packI16(-860), ...packI16(110), 1, 22,
				0x83, 0x00, ...packU16(dataDom.length), ...dataDom,
			])
			const crc = Ac6dProtoReal.crc16(body)
			return Uint8Array.from([...body, ...packU16(crc), 0x16])
		}

		// 确定性虚拟时钟 + 真实 SerialAdapter.createStreamPort
		let fakeNow = new Date(2026, 10, 27, 12, 30, 45).getTime()
		let timerSeq = 1
		const timerQ = new Map()
		const clock = {
			now: () => fakeNow,
			setTimeout(fn, ms) {
				const id = timerSeq++
				timerQ.set(id, { id, at: fakeNow + Math.max(0, Number(ms) || 0), fn })
				return id
			},
			clearTimeout(id) { timerQ.delete(id) },
			async flush() { for (let i = 0; i < 32; i++) await Promise.resolve() },
			async advance(ms) {
				await this.flush()
				const end = fakeNow + ms
				while (true) {
					let next = null
					timerQ.forEach((t) => { if (t.at <= end && (!next || t.at < next.at)) next = t })
					if (!next) break
					fakeNow = next.at
					timerQ.delete(next.id)
					next.fn()
					await this.flush()
				}
				fakeNow = end
				await this.flush()
			},
		}

		let pushRx = null
		const txFrames = []
		let deviceResponder = null
		const realPort = SerialAdapter.createStreamPort({
			getInfo: () => ({ path: 'COM88', usbVendorId: 0x1a86, usbProductId: 0x7523 }),
			open: async (_opts, sink) => { pushRx = (u8) => sink.data(u8) },
			write: async (u8) => {
				const copy = u8.slice()
				txFrames.push(copy)
				if (deviceResponder) deviceResponder(copy)
			},
			close: async () => { pushRx = null },
		})
		const fakeAdapter = {
			isSupported: () => true,
			canEnumerate: () => true,
			listPorts: async () => [realPort],
			getPorts: async () => [realPort],
			grantPort: () => {},
			addEventListener: () => {},
		}
		const ctrl = Ac6dWbReal.createController({
			protocol: Ac6dProtoReal,
			serialAdapter: fakeAdapter,
			appDialog: { alert: async () => {}, confirm: async () => true },
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			timings: {
				saveTimeouts: [300, 400, 300, 300],
				saveGapMs: 30,
				saveRetryDelays: [100, 200],
				otaStepGapMs: 20,
				otaHandshakeMs: 300,
				otaEraseMs: 300,
				otaChunkMs: 300,
				otaCrcMs: 300,
				otaResetWaitMs: 500,
				otaVerifyMs: 300,
				otaRetryDelayMs: 100,
			},
		})
		await ctrl.refreshPorts()
		assert.equal((await ctrl.openPort({ port: realPort })).ok, true)

		// 构造真实 0x33 / 0x31 / 0x40 / 0x42(0) / 0x37 应答载荷
		const uidBytes = [0xaa, 0xbb, 0xcc, 0x78, 0x56, 0x34, 0x12] // authCode = 0x12345678
		const dev33Payload = Uint8Array.from([
			...uidBytes,
			...asciiPad('V2.7.0', 16),
			24, ...packU16(365), 0x01,
			0x26, 0x11, 0x27, 0x12, 0x30, 0x00, 0x05, 0x00,
			2, ...packU16(3), ...packU16(1), ...packU32(86400), ...packU32(1200),
			0, 0, 0,
		])
		const flow31Payload = Uint8Array.from([
			...packU64(100), ...packU64(5),
			...packU64(1708500), ...packU64(85425),
			...packU16(1250), // 0.1250 m3/h = 125.0 L/h
			1, 22, ...packU16(362), ...packU16(17085),
			0x21, // flowing + quadRemainder=2
			0x00, ...packU16(450),
			0x20, 0x26, 0x11, 0x27, 0x12, 0x30, 0x05,
		])
		const calib192Payload = new Uint8Array(192)
		calib192Payload.set(packU32(0xaa55aa55), 0)
		calib192Payload.set(packU32(1), 4)
		calib192Payload.set(packU32(17085), 8)
		calib192Payload.set(packU32(1000), 12)
		calib192Payload.set(packU32(60000), 16)
		calib192Payload[22] = 18
		calib192Payload[23] = 18
		for (let i = 0; i < 20; i++) {
			calib192Payload.set(packU16(100 + i * 10), 24 + i * 4)
			calib192Payload.set(packU16(10000 + i), 24 + i * 4 + 2)
			calib192Payload.set(packU16(120 + i * 10), 104 + i * 4)
			calib192Payload.set(packU16(9950 + i), 104 + i * 4 + 2)
		}
		calib192Payload.set(packU16(Ac6dProtoReal.crc16(calib192Payload.subarray(0, 190))), 190)

		const base40Body = new Uint8Array(40)
		base40Body.set(uidBytes, 0)
		base40Body.set(packU16(310), 7) // 3.10V
		base40Body.set(packU16(60), 9)
		base40Body.set(packU64(9007199254740993n), 11)
		base40Body[19] = 0x55
		base40Body.set(packU32(17085), 20)
		base40Body.set(packU32(1000), 24)
		base40Body.set(packU32(60000), 28)
		base40Body[32] = 1
		base40Body[33] = 0
		base40Body.set(packI16(10000), 34)
		base40Body.set(packU16(200), 36) // 20.0C
		base40Body.set(packU16(Ac6dProtoReal.crc16(base40Body.subarray(0, 38))), 38)
		const param42Type0Payload = Uint8Array.from([0x00, ...base40Body])

		const makeFreezeEntry = (serial, dayBcd, cumL100) => {
			const e = new Uint8Array(32)
			e.set(packU16(0x5a5a), 0)
			e.set(packU16(serial), 2)
			e.set([0x20, 0x26, 0x11, dayBcd], 4)
			e.set(packU32(cumL100), 8)
			e.set(packU32(50), 12)
			e.set(packU32(cumL100 + 50), 16)
			e.set(packU16(800), 20)
			e.set(packI16(215), 22)
			e[24] = 0x00
			e.set(packU16(Ac6dProtoReal.crc16(e.subarray(0, 28))), 28)
			return e
		}

		// 验证 0x33 -> 0x31 -> 0x40 -> 被动 0x42(0) 不建立快照 -> 主动 sendParamRead(0) + uint64 字符串写回 -> 0x37 自动翻页
		pushRx(makeAc6dRsp(1, 0x33, 0x00, 0, dev33Payload))
		pushRx(makeAc6dRsp(2, 0x31, 0x00, 0, flow31Payload))
		pushRx(makeAc6dRsp(3, 0x40, 0x00, 0, calib192Payload))
		pushRx(makeAc6dRsp(4, 0x42, 0x00, 0, param42Type0Payload))
		await clock.flush()
		assert.equal(ctrl.isBaseParamsSnapshotValid(), false, '被动 0x42(0) 不得建立可写快照')

		// 主动发起 0x42(0) 并回匹配 SEQ -> 建立当前表快照
		const paramReadRes = await ctrl.sendParamRead(0)
		const pReq42 = Ac6dProtoReal.parseFrame(paramReadRes.frame)
		pushRx(makeAc6dRsp(pReq42.seq, 0x42, 0x00, 0, param42Type0Payload))
		await clock.flush()
		assert.equal(ctrl.isBaseParamsSnapshotValid(), true)

		assert.equal(ctrl.state.device.onlyAddrHex, 'AABBCC78563412')
		assert.equal(ctrl.getEffectiveAuthCode(), 0x12345678)
		assert.equal(ctrl.state.device.firmwareVersion, 'V2.7.0')
		assert.equal(ctrl.state.flow.posPulse, 100)
		assert.equal(ctrl.state.flow.displayPosVolUl, 1708500 + Math.floor(17085 * 2 / 4), '真实 0x31 帧应触发 4x 象限余数插值')
		assert.equal(ctrl.state.flow.flowRateLph, 125)
		assert.equal(ctrl.state.calib.fwdCoeffs[0], 10000)
		assert.equal(ctrl.state.calib.fwdCoeffs[5], 10005)
		assert.equal(ctrl.state.params.detectedLayout, 'v27-40')
		assert.equal(ctrl.state.params.base.baseDegree, '9007199254740993')

		// 验证大整数 uint64 baseDegree 写回经真实 Ac6dProtocol 编解码无精度丢失
		const writeRes = await ctrl.sendParamWriteBase({ baseDegree: '9007199254740993' })
		assert.equal(writeRes.ok, true)
		const parsedWrite = Ac6dProtoReal.parseFrame(writeRes.frame)
		assert.equal(parsedWrite.ok, true)
		assert.equal(parsedWrite.detail.base.baseDegree, 9007199254740993n, '大整数 uint64 baseDegree 写回必须保持精确 BigInt')

		// 验证 0x37 日冻结两页自动翻页
		deviceResponder = (tx) => {
			const p = Ac6dProtoReal.parseFrame(tx)
			if (p.ok && p.cmd === 0x37) {
				if (p.detail.startIndex === 0) {
					pushRx(makeAc6dRsp(p.seq, 0x37, 0x00, 0, Uint8Array.from([...packU16(2), ...packU16(1), ...makeFreezeEntry(0, 0x25, 12345)])))
				} else if (p.detail.startIndex === 1) {
					pushRx(makeAc6dRsp(p.seq, 0x37, 0x00, 0, Uint8Array.from([...packU16(2), ...packU16(1), ...makeFreezeEntry(1, 0x26, 23456)])))
				}
			}
		}
		ctrl.startDailyFreezeAll()
		await clock.advance(50)
		assert.equal(ctrl.state.freeze.autoReading, false)
		assert.equal(ctrl.state.freeze.entries.length, 2)
		assert.equal(ctrl.state.freeze.entries[0].cumulativeL, 123.45)
		assert.equal(ctrl.state.freeze.entries[1].date, '2026-11-26')

		// 10.5 Save-All 4 步实帧联调（0x33 -> 0x40 -> 0x42(0) -> 裸发 A99A）
		deviceResponder = (tx) => {
			const p = Ac6dProtoReal.parseFrame(tx)
			if (!p.ok) return
			if (p.kind === 'ac6d' && p.cmd === 0x33) pushRx(makeAc6dRsp(p.seq, 0x33, 0x00, 0, dev33Payload))
			else if (p.kind === 'ac6d' && p.cmd === 0x40) pushRx(makeAc6dRsp(p.seq, 0x40, 0x00, 0, calib192Payload))
			else if (p.kind === 'ac6d' && p.cmd === 0x42) pushRx(makeAc6dRsp(p.seq, 0x42, 0x00, 0, param42Type0Payload))
			else if (p.kind === 'a99a-query') pushRx(makeA99aUplink('00000003115261005007', '861234567890123', '89860412345678901234', p.seq))
		}
		const savePromise = ctrl.startSaveAll({ skipDownload: true })
		await clock.advance(300)
		const saveRes = await savePromise
		assert.equal(saveRes.ok, true)
		assert.equal(saveRes.fileName, '0311526100_5007_N_N_N_N_N_N_N_N_N_校表数据_20261127_123045.json')
		assert.equal(saveRes.record.schema, 'SK-CALIB-BIND')
		assert.equal(saveRes.record.schema_version, 4)
		assert.equal(saveRes.record.saved_at, '2026-11-27 12:30:45', 'buildCalibBindJson 必须使用传入的确定性日期')
		assert.equal(saveRes.record.source.port, 'COM88', 'buildCalibBindJson 必须写入真实端口名')
		assert.equal(saveRes.record['台位0'].serial.port, 'COM88')
		assert.equal(saveRes.record['台位0'].statu['读取传感器信息'], '成功')
		assert.equal(saveRes.record['台位0'].statu['读取远传模组信息'], '成功')
		assert.equal(saveRes.record['台位0'].nb_module.imei, '861234567890123')
		assert.equal(saveRes.record['台位0'].nb_module.user_number, '00000003115261005007')
		assert.ok(saveRes.record['台位0'].serial.serial_io.device_info.rx && saveRes.record['台位0'].serial.serial_io.module.rx)

		// 10.6 OTA 6 步实帧联调（原始 App.bin 自动加 16B 头 + 半双工回显免疫 + 0x25 格式B + 主动 0x33 验证）
		const rawApp = new Uint8Array(300)
		for (let i = 0; i < rawApp.length; i++) rawApp[i] = (i * 7 + 3) & 0xff
		ctrl.loadFirmwareBytes(rawApp, 'App_V280.bin')
		const writtenFlash = new Uint8Array(rawApp.length + 16)
		const newDev33Payload = dev33Payload.slice()
		newDev33Payload.set(asciiPad('V2.8.0', 16), 7)

		deviceResponder = (tx) => {
			// 先模拟半双工 TX 回显（验证 handleAc6dEvent 忽略 dir==='req' 不误中断 OTA）
			pushRx(tx)
			const p = Ac6dProtoReal.parseFrame(tx)
			if (!p.ok || p.kind !== 'ac6d') return
			if (p.cmd === 0x20) {
				pushRx(makeAc6dRsp(p.seq, 0x20, 0x00, 0, asciiPad('V2.7.0', 16)))
			} else if (p.cmd === 0x24) {
				pushRx(makeAc6dRsp(p.seq, 0x24, 0x00, 0x8000, []))
			} else if (p.cmd === 0x22) {
				const off = p.addr - 0x8000
				writtenFlash.set(p.data, off)
				pushRx(makeAc6dRsp(p.seq, 0x22, 0x00, p.addr, []))
			} else if (p.cmd === 0x25) {
				const crcCalc = Ac6dProtoReal.crc16(writtenFlash.subarray(0, p.detail.length))
				// 返回格式 B（含 4B 起始地址 0x8000 + 2B CRC）
				pushRx(makeAc6dRsp(p.seq, 0x25, 0x00, 0x8000, packU16(crcCalc)))
			} else if (p.cmd === 0x26) {
				pushRx(makeAc6dRsp(p.seq, 0x26, 0x00, 0, []))
				// 模拟重启后主动上报新版本 0x33
				clock.setTimeout(() => {
					pushRx(makeAc6dRsp(99, 0x33, 0x00, 0, newDev33Payload))
				}, 100)
			}
		}
		const otaStart = ctrl.startAutoOta({ chunkSize: 128 })
		assert.equal(otaStart.ok, true)
		assert.equal(otaStart.autoWrapped, true)
		await clock.advance(600)
		assert.equal(ctrl.state.ota.running, false)
		assert.equal(ctrl.state.ota.lastResult && ctrl.state.ota.lastResult.ok, true, '真实二进制帧 6 步 OTA 必须成功完成')
		assert.equal(ctrl.state.ota.lastResult.newVersion, 'V2.8.0')

		// 10.7 实帧回归：0x41 写入后 3s 回读 raw176 字节比对（匹配 SEQ）、0x37 跳过 CRC 损坏条目、0x43 未读新表 0x42 被拦截
		const verifyLog = []
		ctrl.onChange((topic, payload) => {
			if (topic === 'calib-verify') verifyLog.push(payload)
		})
		let writtenCalibBytes = null
		deviceResponder = (tx) => {
			const p = Ac6dProtoReal.parseFrame(tx)
			if (!p.ok || p.kind !== 'ac6d') return
			if (p.cmd === 0x41) {
				writtenCalibBytes = p.data.slice()
				// 先发错误 SEQ 的 0x41 ACK（必须被忽略）
				pushRx(makeAc6dRsp((p.seq + 50) & 0xff, 0x41, 0x01, 0, []))
				// 再发正确 SEQ 的 0x41 OK
				pushRx(makeAc6dRsp(p.seq, 0x41, 0x00, 0, []))
			} else if (p.cmd === 0x40) {
				const rsp192 = new Uint8Array(192)
				rsp192.set(packU32(0xaa55aa55), 0)
				rsp192.set(packU32(2), 4)
				rsp192.set(writtenCalibBytes, 8)
				rsp192.set(packU16(Ac6dProtoReal.crc16(rsp192.subarray(0, 190))), 190)
				pushRx(makeAc6dRsp(p.seq, 0x40, 0x00, 0, rsp192))
			}
		}
		await ctrl.writeAllCalibCoeffs()
		await clock.advance(3100)
		assert.equal(verifyLog.length, 1)
		assert.equal(verifyLog[0].ok, true, '实帧 0x41 -> 3s -> 0x40 raw176 比对应通过')

		// 0x37 混入 1 条 CRC 损坏条目，分页按 batchCount 推进但跳过损坏记录
		const corruptFreeze = makeFreezeEntry(9, 0x27, 9999)
		corruptFreeze[28] ^= 0x55
		deviceResponder = (tx) => {
			const p = Ac6dProtoReal.parseFrame(tx)
			if (p.ok && p.cmd === 0x37) {
				if (p.detail.startIndex === 0) {
					pushRx(makeAc6dRsp(p.seq, 0x37, 0x00, 0, Uint8Array.from([...packU16(3), ...packU16(2), ...makeFreezeEntry(0, 0x25, 1000), ...corruptFreeze])))
				} else if (p.detail.startIndex === 2) {
					pushRx(makeAc6dRsp(p.seq, 0x37, 0x00, 0, Uint8Array.from([...packU16(3), ...packU16(1), ...makeFreezeEntry(2, 0x26, 2000)])))
				}
			}
		}
		ctrl.startDailyFreezeAll()
		await clock.advance(50)
		assert.equal(ctrl.state.freeze.autoReading, false)
		assert.equal(ctrl.state.freeze.entries.length, 2, '损坏 CRC 日冻结条目必须跳过，保留 2 条有效记录')
		assert.equal(ctrl.state.freeze.skippedCorruptCount, 1)

		// 切表（不同 UID）后 0x43 必须被拒绝
		const otherDev33 = dev33Payload.slice()
		otherDev33[0] = 0xee
		pushRx(makeAc6dRsp(12, 0x33, 0x00, 0, otherDev33))
		await clock.flush()
		const blocked43 = await ctrl.sendParamWriteBase({ voltageAlarmV: 3.2 })
		assert.equal(blocked43.ok, false)

		await ctrl.closePort({ manual: true })
		ctrl.destroy()
	}

	// 10.8 P2-A: common.js 双路 A/B 同 SEQ 0x25 独立 crcReqTracker 隔离验证（含 resetLaneParseSession）
	{
		const Ac6dProtoReal = require('../js/ac6d-protocol.js')
		const commonSrc = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
		const parseViewSrc = fs.readFileSync(path.join(__dirname, '../js/parse-view.js'), 'utf8')
		const a = commonSrc.indexOf('\tfunction bytesToHexArr(')
		const b = commonSrc.indexOf('\t//日志正文渲染到此为止', a)
		assert.ok(a > 0 && b > a, 'common.js 日志渲染锚点应存在')
		const laneCtx = vm.createContext({
			Map, Set, Array, Object, Number, String, Uint8Array, ArrayBuffer, DataView, Math, Date,
			textdecoder: new TextDecoder(),
			toolOptions: { showTime: false },
			HTMLEncode: (t) => String(t),
			attrEscape: (t) => String(t),
			ansi_up: { ansi_to_html: (t) => t },
			AnsiUp: function () { this.ansi_to_html = (t) => t },
			logSeq: 0,
			formatDate: () => '',
			laneLive: { A: null, B: null },
			sessionResetSeq: { S: 0, A: 0, B: 0 },
			protocolIdForSid: () => 'ac6d-meter',
			document: { createElement: () => ({ attrs: {}, children: [], setAttribute() {}, getAttribute() { return null }, appendChild() {} }) },
			window: {
				_activeProtocol: 'ac6d-meter',
				Ac6dProtocol: Ac6dProtoReal,
				getActiveProtocol: () => Ac6dProtoReal,
			},
			getProtocolParseOpts: () => ({}),
			skParseFrame: (data, opts) => Ac6dProtoReal.parseFrame(data, opts),
			SerialHub: { activeSendPhys: () => 'A', logModeOf: () => 'dual', getSessionLabel: () => 'A路', getLogContainerFor: () => ({ children: [] }) },
			logType: 'parse',
			getLogTypeForSid: () => 'parse',
			appendLogNode: () => {},
			isRowLogType: () => true,
		})
		vm.runInContext(parseViewSrc, laneCtx)
		vm.runInContext(commonSrc.slice(a, b) + '\nglobalThis.laneApi = { inLiveLane, renderParseSegment, resetLaneParseSession }', laneCtx)

		const reqA = Ac6dProtoReal.builders.otaCrc(0x8000, 0x400, { seq: 0x33 })
		const reqB = Ac6dProtoReal.builders.otaCrc(0x9000, 0x400, { seq: 0x33 })
		const rspA = Ac6dProtoReal.buildFrame(0x33, Uint8Array.from([0x25, 0x00, 0x00, 0x80, 0x00, 0x00, 0x34, 0x12]))
		const rspB = Ac6dProtoReal.buildFrame(0x33, Uint8Array.from([0x25, 0x00, 0x00, 0x90, 0x00, 0x00, 0x78, 0x56]))

		// A 路发 0x8000，B 路同 seq 发 0x9000
		laneCtx.laneApi.inLiveLane('A', () => laneCtx.laneApi.renderParseSegment(reqA, { isReceive: false }))
		laneCtx.laneApi.inLiveLane('B', () => laneCtx.laneApi.renderParseSegment(reqB, { isReceive: false }))
		const htmlA = laneCtx.laneApi.inLiveLane('A', () => laneCtx.laneApi.renderParseSegment(rspA, { isReceive: true }))
		const htmlB = laneCtx.laneApi.inLiveLane('B', () => laneCtx.laneApi.renderParseSegment(rspB, { isReceive: true }))
		assert.ok(htmlA.includes('0x1234') && htmlA.includes('格式 B'), 'A 路同 seq 应正确解析格式 B 0x1234')
		assert.ok(htmlB.includes('0x5678') && htmlB.includes('格式 B'), 'B 路同 seq 应正确解析格式 B 0x5678 且不被 A 路污染')

		// 重置 A 路不得清空 B 路的 tracker
		laneCtx.laneApi.resetLaneParseSession('A')
		const htmlBAfterResetA = laneCtx.laneApi.inLiveLane('B', () => laneCtx.laneApi.renderParseSegment(rspB, { isReceive: true }))
		assert.ok(htmlBAfterResetA.includes('0x5678') && !htmlBAfterResetA.includes('缺请求地址上下文'))
		// 重置 B 路后，非 0x8000 应答回退为候选模糊态
		laneCtx.laneApi.resetLaneParseSession('B')
		const htmlBAfterResetB = laneCtx.laneApi.inLiveLane('B', () => laneCtx.laneApi.renderParseSegment(rspB, { isReceive: true }))
		assert.ok(htmlBAfterResetB.includes('缺请求地址上下文'))
	}

	// 10.9 启动回归：启用解析(hex&parse)且存在缓存日志时，整份 js/common.js 不踩 TDZ 崩溃，serialLanes / serialApi 正常导出且切协议生效不回弹
	{
		const lsMap = new Map()
		const ssMap = new Map()
		lsMap.set('toolOptions', JSON.stringify({ logType: 'hex&parse', skProtocol: 'sek' }))
		ssMap.set('serialLogCache', JSON.stringify({
			v: 2,
			seq: 1,
			single: '<div class="log-row" data-dir="rx" data-hex="68 01 16" data-sid="S"><span class="log-body">68 01 16</span></div>',
			dual: '',
		}))
		const makeStorage = (map) => ({
			getItem(k) { return map.has(k) ? map.get(k) : null },
			setItem(k, v) { map.set(k, String(v)) },
			removeItem(k) { map.delete(k) },
		})

		const byId = new Map()
		const makeStubNode = (tag, id) => {
			const n = new DomNode(tag, id)
			n.scrollTop = 0
			n.scrollHeight = 0
			n.clientHeight = 0
			n.offsetWidth = 0
			n.offsetHeight = 0
			n.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })
			n.insertAdjacentHTML = () => { n.appendChild(makeStubNode('DIV')) }
			n.scrollTo = () => {}
			const styleProps = new Map()
			n.style.getPropertyValue = (k) => styleProps.get(k) || ''
			n.style.setProperty = (k, v) => styleProps.set(k, String(v))
			n.style.removeProperty = (k) => styleProps.delete(k)
			Object.defineProperty(n, 'childElementCount', { get() { return this.children.length } })
			Object.defineProperty(n, 'firstElementChild', { get() { return this.children[0] || null } })
			Object.defineProperty(n, 'lastElementChild', { get() { return this.children[this.children.length - 1] || null } })
			Object.defineProperty(n, 'nextElementSibling', { get() { return this.nextSibling } })
			const origMatches = n.matches.bind(n)
			n.matches = (sel) => {
				if (/^[a-z]+$/i.test(sel)) return n.tagName === sel.toUpperCase()
				return origMatches(sel)
			}
			return n
		}
		const ensureId = (id, tag) => {
			if (!byId.has(id)) {
				const inferred = tag || (id.includes('select') || id === 'serial-quick-send' || id === 'serial-protocol-decrypt' || id === 'serial-protocol-enc-type' ? 'SELECT' : 'DIV')
				const n = makeStubNode(inferred, id)
				byId.set(id, n)
			}
			return byId.get(id)
		}
		ensureId('rail-theme-btn', 'BUTTON').appendChild(makeStubNode('I'))
		ensureId('serial-parse-lock', 'BUTTON').appendChild(makeStubNode('I'))

		// 让 serial-logs-single 在 innerHTML 赋入缓存行时构造真实 .log-row / .log-body 子节点，确保 rerenderLogBodies 走过 inLane 与 finish
		const singleLogsEl = ensureId('serial-logs-single', 'DIV')
		Object.defineProperty(singleLogsEl, 'innerHTML', {
			get() { return this._innerHTML },
			set(v) {
				this._innerHTML = v == null ? '' : String(v)
				this.children = []
				if (this._innerHTML.includes('class="log-row"')) {
					const row = makeStubNode('DIV')
					row.className = 'log-row'
					row.setAttribute('data-dir', 'rx')
					row.setAttribute('data-hex', '68 01 16')
					row.setAttribute('data-sid', 'S')
					const bodySpan = makeStubNode('SPAN')
					bodySpan.className = 'log-body'
					bodySpan.innerHTML = '68 01 16'
					row.appendChild(bodySpan)
					this.appendChild(row)
				}
			},
		})
		const protoSel = ensureId('serial-protocol-select', 'SELECT')
		const optSek = makeStubNode('OPTION')
		optSek.value = 'sek'
		optSek.textContent = 'SEK（默认）'
		protoSel.appendChild(optSek)

		const docBody = makeStubNode('BODY')
		const docEl = makeStubNode('HTML')
		const docListeners = {}
		const timers = []
		const fakeDoc = {
			readyState: 'complete',
			body: docBody,
			documentElement: docEl,
			activeElement: null,
			createElement(tag) { return makeStubNode(tag) },
			createTextNode(t) { return { nodeType: 3, textContent: String(t), parentNode: null } },
			getElementById(id) { return ensureId(id) },
			querySelector(sel) {
				if (sel.startsWith('#')) return ensureId(sel.slice(1))
				return docBody.querySelector(sel)
			},
			querySelectorAll() { return [] },
			addEventListener(type, fn) { (docListeners[type] ||= []).push(fn) },
			removeEventListener(type, fn) { docListeners[type] = (docListeners[type] || []).filter((x) => x !== fn) },
			dispatchEvent(ev) {
				;(docListeners[ev.type] || []).slice().forEach((fn) => fn(ev))
				return true
			},
		}
		const winListeners = {}
		const fakeWin = {
			document: fakeDoc,
			localStorage: makeStorage(lsMap),
			sessionStorage: makeStorage(ssMap),
			matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
			addEventListener(type, fn) { (winListeners[type] ||= []).push(fn) },
			removeEventListener(type, fn) { winListeners[type] = (winListeners[type] || []).filter((x) => x !== fn) },
			getSelection: () => ({ toString: () => '' }),
			scrollX: 0,
			scrollY: 0,
			AppDialog: { alert() {}, confirm: async () => true },
			skParseFrame: (data) => ({ raw: Array.from(data || []) }),
		}
		fakeWin.window = fakeWin
		const bootCtx = vm.createContext({
			window: fakeWin,
			self: fakeWin,
			globalThis: fakeWin,
			document: fakeDoc,
			localStorage: fakeWin.localStorage,
			sessionStorage: fakeWin.sessionStorage,
			navigator: { clipboard: { writeText: async () => {}, readText: async () => '' } },
			performance: { getEntriesByType: (t) => (t === 'navigation' ? [{ type: 'reload' }] : []) },
			SerialAdapter: {
				isSupported: () => true,
				getPorts: async () => [],
				canEnumerate: () => false,
				listPorts: async () => [],
				getUsbDevices: async () => [],
				addEventListener() {},
				removeEventListener() {},
			},
			AnsiUp: function () { this.ansi_to_html = (t) => String(t) },
			bootstrap: {
				Modal: function () { this.show = () => {}; this.hide = () => {} },
				Dropdown: Object.assign(function () { this.hide = () => {}; this.show = () => {} }, {
					getOrCreateInstance: () => ({ hide() {}, show() {}, toggle() {} }),
				}),
			},
			Event: function (type, init) { this.type = type; Object.assign(this, init || {}) },
			CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail },
			TextDecoder,
			TextEncoder,
			URL,
			Blob,
			Uint8Array,
			ArrayBuffer,
			DataView,
			Map,
			Set,
			WeakMap,
			WeakSet,
			Promise,
			Date,
			Math,
			JSON,
			Number,
			String,
			Array,
			Object,
			RegExp,
			Error,
			console,
			queueMicrotask,
			setTimeout(fn) { timers.push(fn); return timers.length },
			clearTimeout() {},
			setInterval() { return 1 },
			clearInterval() {},
		})
		// 与 index.html 保持一致：在 common.js 之前加载 dual-config / parse-view / protocol-registry
		vm.runInContext(readJs('js/dual-config.js'), bootCtx, { filename: 'js/dual-config.js' })
		vm.runInContext(readJs('js/parse-view.js'), bootCtx, { filename: 'js/parse-view.js' })
		vm.runInContext(readJs('js/protocol-registry.js'), bootCtx, { filename: 'js/protocol-registry.js' })
		// 执行完整 js/common.js：启用解析且带缓存日志时不得抛 ReferenceError（ac6dCrcTracker TDZ）
		assert.doesNotThrow(() => {
			vm.runInContext(readJs('js/common.js'), bootCtx, { filename: 'js/common.js' })
		}, '启用 hex&parse 且带缓存日志启动时 js/common.js 不得抛 TDZ 异常')

		assert.ok(fakeWin.serialLanes && typeof fakeWin.serialLanes.setProtocol === 'function', 'window.serialLanes 必须正常导出')
		assert.ok(fakeWin.serialApi && typeof fakeWin.serialApi.writeRaw === 'function' && typeof fakeWin.serialApi.isOpen === 'function', 'window.serialApi 必须正常导出')
		assert.equal(singleLogsEl.children.length, 1, '应已从 serialLogCache 恢复缓存日志行并完成重渲')

		// 注册 sek 与 wmbus 协议（与运行时 protocol-downlink.js / wmbus-protocol.js 一致）并切换，验证生效、持久化且不回弹回 sek
		fakeWin.registerProtocol('sek', {
			builtin: true,
			name: 'SEK（默认）',
			parseFrame: (d) => ({ raw: Array.from(d || []) }),
			logView: () => null,
		})
		fakeWin.registerProtocol('wmbus', {
			builtin: true,
			name: 'W-MBUS',
			parseFrame: (d) => ({ raw: Array.from(d || []) }),
			logView: () => null,
		})
		assert.equal(protoSel.value, 'sek', '切换前协议下拉应停在 sek')
		fakeWin.serialLanes.setProtocol('S', 'wmbus')
		// 执行期间排队的定时器回调，确认不会把协议冲回 sek
		while (timers.length) {
			const fn = timers.shift()
			try { fn() } catch (e) {}
		}
		assert.equal(fakeWin._activeProtocol, 'wmbus', '切换协议后 window._activeProtocol 应保持为 wmbus')
		assert.equal(fakeWin.serialLanes.protocolOf('S'), 'wmbus', '单路协议应保持为 wmbus')
		assert.equal(protoSel.value, 'wmbus', '协议下拉值应保持为 wmbus 不回弹')
		assert.equal(JSON.parse(lsMap.get('toolOptions')).skProtocol, 'wmbus', '切换后的协议应持久化到 toolOptions.skProtocol')
	}

	console.log('protocol-integration: ok')
}

run().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
