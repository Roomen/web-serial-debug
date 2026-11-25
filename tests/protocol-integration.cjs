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
	body.appendChild(manageMenuBtn)
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

	// 1. 加载 parse-view.js、app-dialog.js、protocol-registry.js（按 index.html 顺序）
	vm.createContext(sandbox)
	vm.runInContext(readJs('js/parse-view.js'), sandbox, { filename: 'js/parse-view.js' })
	vm.runInContext(readJs('js/app-dialog.js'), sandbox, { filename: 'js/app-dialog.js' })
	vm.runInContext(readJs('js/protocol-registry.js'), sandbox, { filename: 'js/protocol-registry.js' })

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

	// 3. 按 index.html 顺序加载：hostproto → protocol-downlink → json-protocol → js-protocol-plugin → protocol-manager → collapsible-cards → command-palette
	vm.runInContext(readJs('js/hostproto-protocol.js'), sandbox, { filename: 'js/hostproto-protocol.js' })
	vm.runInContext(readJs('js/protocol-downlink.js'), sandbox, { filename: 'js/protocol-downlink.js' })
	vm.runInContext(readJs('js/json-protocol.js'), sandbox, { filename: 'js/json-protocol.js' })
	vm.runInContext(readJs('js/js-protocol-plugin.js'), sandbox, { filename: 'js/js-protocol-plugin.js' })
	vm.runInContext(readJs('js/protocol-manager.js'), sandbox, { filename: 'js/protocol-manager.js' })
	vm.runInContext(readJs('js/collapsible-cards.js'), sandbox, { filename: 'js/collapsible-cards.js' })
	vm.runInContext(readJs('js/command-palette.js'), sandbox, { filename: 'js/command-palette.js' })

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
			'js/common.js',
			'js/wmbus-protocol.js',
			'js/gz-protocol.js',
			'js/cjt188-protocol.js',
			'js/hostproto-protocol.js',
			'js/at-modem-protocol.js',
			'js/protocol-downlink.js',
			'js/json-protocol.js',
			'js/js-protocol-plugin.js',
			'js/protocol-manager.js',
		]
		let prev = -1
		for (const s of seq) {
			const idx = html.indexOf(s)
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
		assert.equal(els.rwCard.style.display, 'none', 'SEK 专属卡片应隐藏')
		assert.equal(els.esimCard.style.display, 'none', 'eSIM 卡片应隐藏')
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

	console.log('protocol-integration: ok')
}

run().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
