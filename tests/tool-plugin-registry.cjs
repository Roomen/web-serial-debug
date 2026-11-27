// Run: node tests/tool-plugin-registry.cjs — synthetic data only.
// 覆盖: js/tool-plugin-registry.js 左栏工具视图插件注册表：
// 1) 内置 'power' 锁定、保留 ID 保护、占位升级与非法 ID 拦截；
// 2) 忙碌态（含 bluApi 回退）拒绝隐藏并返回原因；
// 3) 隐藏或注销当前激活插件视图自动切回 'view-serial'、触发 onDeactivate / unmount 并清理动态 DOM；
// 4) 非法图标回退 bi-puzzle、恶意 <img onerror=...> 文本经 textContent 安全渲染、零 innerHTML；
// 5) 移动端画像（protocol.manage 关闭 / view.power 关闭）门控拦截外部工具与内置视图；
// 6) 待信任外部 JS 插件在左栏入口（#rail-plugin-manage / #serial-protocol-manage）展示 .rail-status-dot 与 title 联动；
// 7) refreshBadges、view-emk 兼容与 batch 批处理。
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const registrySrc = fs.readFileSync(path.join(__dirname, '../js/tool-plugin-registry.js'), 'utf8')

class FakeEl {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase()
		this.nodeType = 1
		this.id = ''
		this.className = ''
		this.textContent = ''
		this.title = ''
		this.type = ''
		this.hidden = false
		this.dataset = {}
		this.attrs = {}
		this.children = []
		this.parentNode = null
		this.listeners = {}
		this._forbidInnerHTML = true
		this.classList = {
			toggle: (name, on) => {
				const set = new Set(this.className.split(/\s+/).filter(Boolean))
				if (on === undefined) {
					if (set.has(name)) set.delete(name)
					else set.add(name)
				} else if (on) set.add(name)
				else set.delete(name)
				this.className = Array.from(set).join(' ')
			},
			contains: (name) => this.className.split(/\s+/).includes(name),
		}
	}
	get innerHTML() { return '' }
	set innerHTML(v) {
		if (this._forbidInnerHTML) throw new Error('tool-plugin-registry 禁止使用 innerHTML')
	}
	appendChild(c) {
		if (c.parentNode) c.parentNode.removeChild(c)
		c.parentNode = this
		this.children.push(c)
		return c
	}
	insertBefore(c, ref) {
		if (c.parentNode) c.parentNode.removeChild(c)
		c.parentNode = this
		const idx = this.children.indexOf(ref)
		if (idx < 0) this.children.push(c)
		else this.children.splice(idx, 0, c)
		return c
	}
	removeChild(c) {
		const idx = this.children.indexOf(c)
		if (idx >= 0) {
			this.children.splice(idx, 1)
			c.parentNode = null
		}
		return c
	}
	remove() {
		if (this.parentNode) this.parentNode.removeChild(this)
	}
	setAttribute(k, v) {
		this.attrs[k] = String(v)
		if (k === 'id') this.id = String(v)
	}
	getAttribute(k) {
		return this.attrs[k] !== undefined ? this.attrs[k] : null
	}
	addEventListener(t, f) {
		;(this.listeners[t] = this.listeners[t] || []).push(f)
	}
	dispatchEvent(ev) {
		const type = ev && ev.type ? ev.type : String(ev)
		const e = Object.assign({ target: this, currentTarget: this }, typeof ev === 'object' ? ev : { type })
		;(this.listeners[type] || []).slice().forEach((f) => f(e))
		return true
	}
	closest(sel) {
		let cur = this
		while (cur) {
			if (sel === '.rail-item[data-view]') {
				if (cur.classList.contains('rail-item') && cur.dataset.view) return cur
			} else if (sel.startsWith('.') && cur.classList.contains(sel.slice(1))) {
				return cur
			}
			cur = cur.parentNode
		}
		return null
	}
	querySelector(sel) {
		return this.querySelectorAll(sel)[0] || null
	}
	querySelectorAll(sel) {
		const out = []
		const match = (n) => {
			if (sel === '.app-view') return n.classList.contains('app-view')
			if (sel === '.rail-item') return n.classList.contains('rail-item')
			if (sel === '.rail-top') return n.classList.contains('rail-top')
			if (sel === '.rail-status-dot') return n.classList.contains('rail-status-dot')
			if (sel === '.rail-item[data-view]') return n.classList.contains('rail-item') && !!n.dataset.view
			const m = /^\.rail-item\[data-view="([^"]+)"\]$/.exec(sel)
			if (m) return n.classList.contains('rail-item') && n.dataset.view === m[1]
			return false
		}
		const walk = (n) => {
			for (const c of n.children) {
				if (match(c)) out.push(c)
				walk(c)
			}
		}
		walk(this)
		return out
	}
}

function makeHarness(opts) {
	opts = opts || {}
	const store = new Map()
	if (opts.initialStorage) {
		Object.keys(opts.initialStorage).forEach((k) => store.set(k, String(opts.initialStorage[k])))
	}
	const localStorage = {
		getItem(k) { return store.has(k) ? store.get(k) : null },
		setItem(k, v) { store.set(k, String(v)) },
		removeItem(k) { store.delete(k) },
	}

	const rootEl = new FakeEl('body')
	const rail = new FakeEl('nav')
	rail.id = 'activity-rail'
	const railTop = new FakeEl('div')
	railTop.className = 'rail-top'

	const btnSerial = new FakeEl('button')
	btnSerial.className = 'rail-item active'
	btnSerial.dataset.view = 'view-serial'
	btnSerial.title = '通信调试'
	railTop.appendChild(btnSerial)

	const btnBlu = new FakeEl('button')
	btnBlu.className = 'rail-item'
	btnBlu.dataset.view = 'view-blu'
	btnBlu.dataset.feature = 'view.power'
	btnBlu.title = '功耗分析'
	railTop.appendChild(btnBlu)

	const divider = new FakeEl('div')
	divider.className = 'rail-divider'
	railTop.appendChild(divider)

	const btnPluginManage = new FakeEl('button')
	btnPluginManage.id = 'rail-plugin-manage'
	btnPluginManage.className = 'rail-item'
	btnPluginManage.title = '插件与协议'
	railTop.appendChild(btnPluginManage)

	const btnLegacyManage = new FakeEl('button')
	btnLegacyManage.id = 'serial-protocol-manage'
	btnLegacyManage.title = '协议管理'

	rail.appendChild(railTop)
	rootEl.appendChild(rail)
	rootEl.appendChild(btnLegacyManage)

	const views = new FakeEl('div')
	views.id = 'views'
	const viewSerial = new FakeEl('div')
	viewSerial.id = 'view-serial'
	viewSerial.className = 'app-view active'
	views.appendChild(viewSerial)

	const viewBlu = new FakeEl('div')
	viewBlu.id = 'view-blu'
	viewBlu.className = 'app-view'
	if (opts.withBluView !== false) views.appendChild(viewBlu)

	rootEl.appendChild(views)

	const docListeners = {}
	const docEvents = []
	function findById(node, id) {
		if (node.id === id) return node
		for (const c of node.children) {
			const hit = findById(c, id)
			if (hit) return hit
		}
		return null
	}

	const doc = {
		readyState: 'complete',
		body: rootEl,
		createElement: (tag) => new FakeEl(tag),
		getElementById: (id) => findById(rootEl, id),
		querySelector: (sel) => rootEl.querySelector(sel),
		querySelectorAll: (sel) => rootEl.querySelectorAll(sel),
		addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f) },
		removeEventListener: (t, f) => { docListeners[t] = (docListeners[t] || []).filter((x) => x !== f) },
		dispatchEvent: (ev) => {
			docEvents.push(ev)
			;(docListeners[ev.type] || []).slice().forEach((f) => f(ev))
			return true
		},
	}

	const features = Object.assign({
		'protocol.manage': true,
		'view.power': true,
	}, opts.features || {})

	const AppPlatform = {
		has: (id) => (Object.prototype.hasOwnProperty.call(features, id) ? !!features[id] : true),
	}

	let untrustedCount = opts.untrustedCount || 0
	const win = {
		document: doc,
		localStorage,
		AppPlatform,
		CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail },
		JsProtocolPlugin: {
			getUntrustedCount: () => untrustedCount,
		},
	}
	if (opts.bluApi) win.bluApi = opts.bluApi
	if (opts.bluSpec) win.BluPowerToolPluginSpec = opts.bluSpec

	const ctx = {
		window: win,
		document: doc,
		localStorage,
		CustomEvent: win.CustomEvent,
		console,
	}
	vm.createContext(ctx)
	vm.runInContext(registrySrc, ctx)

	return {
		win,
		doc,
		store,
		docEvents,
		rail,
		railTop,
		views,
		viewSerial,
		viewBlu,
		btnBlu,
		btnPluginManage,
		btnLegacyManage,
		divider,
		reg: win.ToolPluginRegistry,
		setUntrustedCount(n) { untrustedCount = n },
	}
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('内置 power 锁定、占位升级、保留 ID 保护与非法 ID 拦截', () => {
	const h = makeHarness()
	// 启动兜底会注册占位内置 power，可被正式 builtin:true 升级一次
	assert.equal(h.reg.has('power'), true)
	assert.equal(h.reg.isBuiltin('power'), true)

	// 外部插件企图覆盖 power 必须抛错
	assert.throws(() => h.reg.register('power', { name: '恶意功耗' }), /保留/)

	// 正式内置规格升级后彻底锁定，再次注册即便是 builtin:true 也抛错
	assert.equal(h.reg.register('power', {
		builtin: true,
		name: '功耗分析',
		label: '功耗分析',
		icon: 'bi-speedometer2',
		viewId: 'view-blu',
		feature: 'view.power',
	}), true)
	assert.throws(() => h.reg.register('power', { builtin: true, name: '二次覆盖' }), /保留|覆盖/)

	// 内置项不可注销
	const unreg = h.reg.unregister('power')
	assert.equal(unreg.ok, false)
	assert.ok(unreg.error.includes('内置'))

	// 非法 ID（大写、空格、原型特殊键）拦截
	for (const bad of ['', 'BadId', 'has space', '__proto__', 'constructor', 'prototype', '-leading']) {
		assert.throws(() => h.reg.register(bad, { name: 'bad' }), /ID/)
	}
})

test('忙碌态拒绝隐藏并返回原因（含自定义 busyReason 与 power 的 bluApi 回退）', () => {
	let bluOpen = true
	const h = makeHarness({
		bluApi: { isOpen: () => bluOpen, isBusyForUpdate: () => false },
	})
	// 未连接时可隐藏，已连接时拦截
	const denyBlu = h.reg.setHidden('power', true)
	assert.equal(denyBlu.ok, false)
	assert.ok(denyBlu.error.includes('断开'))
	assert.equal(h.reg.isHidden('power'), false)

	bluOpen = false
	assert.equal(h.reg.setHidden('power', true).ok, true)
	assert.equal(h.reg.isHidden('power'), true)
	assert.equal(h.btnBlu.hidden, true)
	assert.equal(h.btnBlu.dataset.pluginHidden, '1')

	// 自定义外部工具插件忙碌态拦截
	let busy = true
	h.reg.register('busy-tool', {
		name: '采集工装',
		isBusy: () => busy,
		busyReason: () => '正在录制工装数据，请先停止录制',
	})
	const denyTool = h.reg.setHidden('busy-tool', true)
	assert.equal(denyTool.ok, false)
	assert.equal(denyTool.error, '正在录制工装数据，请先停止录制')
	assert.equal(h.reg.isHidden('busy-tool'), false)

	busy = false
	assert.equal(h.reg.setHidden('busy-tool', true).ok, true)
	assert.equal(h.reg.isHidden('busy-tool'), true)
})

test('隐藏或注销当前激活插件视图时自动切回 view-serial 并触发完整生命周期与 DOM 清理', () => {
	const h = makeHarness()
	const log = []
	h.reg.register('calc', {
		name: '校验计算器',
		label: '计算器',
		icon: 'bi-calculator',
		hideTopbar: true,
		mount(container, ctx) {
			log.push('mount:' + ctx.id + ':' + ctx.viewId)
			const p = h.doc.createElement('p')
			p.textContent = '已挂载'
			container.appendChild(p)
		},
		onActivate(ctx) { log.push('activate:' + ctx.id) },
		onDeactivate(ctx) { log.push('deactivate:' + ctx.id) },
		unmount(ctx) { log.push('unmount:' + ctx.id) },
	})

	// 动态 DOM 创建与插入位置（位于 .rail-divider / #rail-plugin-manage 之前）
	const viewEl = h.doc.getElementById('view-plugin-calc')
	assert.ok(viewEl)
	assert.equal(viewEl.dataset.hideTopbar, 'true')
	const btnIdx = h.railTop.children.findIndex((c) => c.dataset && c.dataset.toolPlugin === 'calc')
	const divIdx = h.railTop.children.indexOf(h.divider)
	assert.ok(btnIdx >= 0 && btnIdx < divIdx, '外部工具按钮应插入在分隔线与插件入口之前')

	// 激活插件视图
	assert.equal(h.reg.activateView('view-plugin-calc'), 'view-plugin-calc')
	assert.equal(h.reg.getActiveView(), 'view-plugin-calc')
	assert.equal(viewEl.classList.contains('active'), true)
	assert.equal(h.store.get('serial-debug-active-view'), 'view-plugin-calc')

	// 隐藏当前激活插件 -> 自动切回 view-serial
	assert.equal(h.reg.setHidden('calc', true).ok, true)
	assert.equal(h.reg.getActiveView(), 'view-serial')
	assert.equal(h.viewSerial.classList.contains('active'), true)
	assert.equal(h.store.get('serial-debug-active-view'), 'view-serial')
	// 隐藏状态下再次激活应回退 view-serial
	assert.equal(h.reg.activateView('view-plugin-calc'), 'view-serial')

	// 恢复显示并再次激活，然后注销 -> 切回 view-serial、调用 unmount 并移除 DOM
	assert.equal(h.reg.setHidden('calc', false).ok, true)
	assert.equal(h.reg.activateView('view-plugin-calc'), 'view-plugin-calc')
	assert.equal(h.reg.unregister('calc').ok, true)
	assert.equal(h.reg.getActiveView(), 'view-serial')
	assert.equal(h.doc.getElementById('view-plugin-calc'), null)
	assert.equal(h.railTop.children.some((c) => c.dataset && c.dataset.toolPlugin === 'calc'), false)
	assert.deepEqual(log, [
		'mount:calc:view-plugin-calc',
		'activate:calc',
		'deactivate:calc',
		'activate:calc',
		'deactivate:calc',
		'unmount:calc',
	])
})

test('非法图标回退 bi-puzzle 且恶意 XSS 文本经 textContent 安全清洗（零 innerHTML）', () => {
	const h = makeHarness()
	const xss = '<img src=x onerror=alert(1)>'
	h.reg.register('xss-tool', {
		name: xss + '非常长的工具名称用来验证截断边界',
		label: xss,
		icon: 'bi-bad" onclick="alert(1)',
		description: xss,
	})
	const item = h.reg.list().find((x) => x.id === 'xss-tool')
	assert.ok(item)
	assert.equal(item.icon, 'bi-puzzle')
	assert.ok(item.name.length <= 48)
	assert.ok(item.label.length <= 12)

	const btn = h.railTop.children.find((c) => c.dataset && c.dataset.toolPlugin === 'xss-tool')
	assert.ok(btn)
	const iconEl = btn.children.find((c) => c.tagName === 'I')
	const labelEl = btn.children.find((c) => c.classList.contains('rail-label'))
	assert.equal(iconEl.className, 'bi bi-puzzle')
	assert.equal(labelEl.textContent, xss.slice(0, 12))
	assert.equal(btn.children.some((c) => c.tagName === 'IMG' || c.tagName === 'SCRIPT'), false)
})

test('移动端画像门控拦截外部工具视图，view.power 关闭拦截功耗视图', () => {
	const h = makeHarness({
		features: { 'protocol.manage': false, 'view.power': false },
	})
	assert.equal(h.reg.has('power'), false, 'view.power 关闭时不得注册内置 power')
	assert.equal(h.reg.register('ext-tool', { name: '外部工具' }), false, '移动端不得注册外部工具')
	assert.equal(h.reg.has('ext-tool'), false)
	assert.equal(h.doc.getElementById('view-plugin-ext-tool'), null)
	assert.equal(h.reg.activateView('view-emk'), 'view-serial', 'view-emk 在无 view.power 权限时应回退 view-serial')
})

test('待信任外部 JS 插件在左栏入口展示 .rail-status-dot 与 title 提醒，信任后清除', () => {
	const h = makeHarness({ untrustedCount: 2 })
	const dot = h.btnPluginManage.querySelector('.rail-status-dot')
	assert.ok(dot, '应在 #rail-plugin-manage 下创建 .rail-status-dot')
	assert.equal(dot.hidden, false)
	assert.equal(h.btnPluginManage.dataset.untrustedCount, '2')
	assert.ok(h.btnPluginManage.title.includes('2 个外部 JS 插件待确认信任'))

	const legacyDot = h.btnLegacyManage.querySelector('.rail-status-dot')
	assert.ok(legacyDot)
	assert.equal(legacyDot.hidden, false)

	// 模拟全部信任后触发 serial-protocol-plugins-change
	h.setUntrustedCount(0)
	h.doc.dispatchEvent(new h.win.CustomEvent('serial-protocol-plugins-change'))
	assert.equal(dot.hidden, true)
	assert.equal(h.btnPluginManage.dataset.untrustedCount, undefined)
	assert.equal(h.btnPluginManage.title, '插件与协议')
	assert.equal(legacyDot.hidden, true)
})

test('refreshBadges 同步外部插件连接角标，view-emk 兼容映射至 view-blu', () => {
	const h = makeHarness()
	assert.equal(h.reg.activateView('view-emk'), 'view-blu')
	assert.equal(h.reg.getActiveView(), 'view-blu')

	let connected = true
	h.reg.register('scope', {
		name: '示波器',
		statusBadge: () => (connected ? { conn: 'open', title: '示波器 · 采样中' } : null),
	})
	h.reg.refreshBadges()
	const btn = h.railTop.children.find((c) => c.dataset && c.dataset.toolPlugin === 'scope')
	assert.equal(btn.dataset.conn, 'open')
	assert.equal(btn.title, '示波器 · 采样中')

	connected = false
	h.reg.refreshBadges()
	assert.equal(btn.dataset.conn, undefined)
	assert.equal(btn.title, '示波器')
})

let failed = 0
for (const t of tests) {
	try {
		t.fn()
		console.log('ok   ' + t.name)
	} catch (e) {
		failed++
		console.error('FAIL ' + t.name)
		console.error(e)
	}
}
if (failed) {
	console.error(failed + ' failed')
	process.exit(1)
}
console.log('all ' + tests.length + ' passed')
