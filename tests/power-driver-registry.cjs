// Run: node tests/power-driver-registry.cjs — synthetic data only, no hardware.
// 覆盖：功耗仪驱动注册表契约（内置 blu-100k 锁定防覆盖、跨源冲突拦截、至少保留一个可见驱动、
// 连接中禁止切换/隐藏当前驱动、自定义被动流与指令型驱动 pushChunk 归一化与异常隔离、
// BLU 100k 内置驱动握手与供电探测、不支持调压/上下电时的 UI 与 API 能力门控、
// BluPowerToolPluginSpec 繁忙判定与 modern-power.js 工具栏协议选择器）。
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const PowerDriverRegistryMod = require('../js/power-driver-registry.js')
const bluProtocolSrc = fs.readFileSync(path.join(__dirname, '../js/blu-protocol.js'), 'utf8')
const bluPowerSrc = fs.readFileSync(path.join(__dirname, '../js/blu-power.js'), 'utf8')
const modernPowerSrc = fs.readFileSync(path.join(__dirname, '../js/modern-power.js'), 'utf8')

function makeStorage(initial) {
	const map = Object.assign({}, initial || {})
	return {
		_map: map,
		getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null },
		setItem(k, v) { map[k] = String(v) },
		removeItem(k) { delete map[k] },
	}
}

class FakeCustomEvent {
	constructor(type, init) {
		this.type = type
		this.detail = init ? init.detail : null
	}
}

function loadBluProtocol(winObj) {
	const sandbox = {
		window: winObj || {},
		globalThis: null,
		console,
		Uint8Array,
		Float32Array,
		Float64Array,
		Math,
		Number,
		isFinite,
		parseFloat,
		parseInt,
		Date,
	}
	sandbox.globalThis = sandbox.window
	vm.runInNewContext(bluProtocolSrc, sandbox, { filename: 'js/blu-protocol.js' })
	return sandbox.window.BluProtocol
}

// 轻量 DOM 模拟：用于验证 blu-power.js + modern-power.js 能力门控、XSS 安全渲染与插件繁忙态
function makeMiniDom() {
	const byId = new Map()
	const docListeners = {}
	const dispatched = []

	function makeClassList(el) {
		const set = new Set()
		return {
			add(...xs) { xs.forEach((x) => { if (x) set.add(x) }) },
			remove(...xs) { xs.forEach((x) => set.delete(x)) },
			contains(x) { return set.has(x) },
			toggle(x, force) {
				if (force === undefined) {
					if (set.has(x)) { set.delete(x); return false }
					set.add(x); return true
				}
				if (force) set.add(x)
				else set.delete(x)
				return !!force
			},
			toString() { return Array.from(set).join(' ') },
		}
	}

	function createEl(tag, id, cls) {
		const el = {
			tagName: String(tag || 'div').toUpperCase(),
			_id: '',
			_text: '',
			_html: '',
			_value: '',
			children: [],
			parentNode: null,
			dataset: {},
			attrs: {},
			listeners: {},
			style: {},
			disabled: false,
			hidden: false,
			title: '',
			placeholder: '',
			min: '',
			max: '',
			classList: makeClassList(),
			get id() { return this._id },
			set id(v) {
				if (this._id && byId.get(this._id) === this) byId.delete(this._id)
				this._id = String(v || '')
				if (this._id) byId.set(this._id, this)
			},
			get className() { return this.classList.toString() },
			set className(v) {
				this.classList = makeClassList()
				String(v || '').split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c))
			},
			get textContent() {
				if (this.children.length) {
					return this.children.map((c) => c.textContent != null ? c.textContent : (c.nodeValue || '')).join('')
				}
				return this._text
			},
			set textContent(v) {
				this.children = []
				this._text = String(v == null ? '' : v)
				this._html = ''
			},
			get innerHTML() { return this._html },
			set innerHTML(v) {
				this.children = []
				this._html = String(v == null ? '' : v)
				this._text = this._html
			},
			get childNodes() { return this.children },
			get firstChild() { return this.children[0] || null },
			get options() { return this.children.filter((c) => c.tagName === 'OPTION') },
			get selectedIndex() {
				const opts = this.options
				const idx = opts.findIndex((o) => o.value === this._value)
				return idx >= 0 ? idx : 0
			},
			get value() { return this._value },
			set value(v) { this._value = String(v == null ? '' : v) },
			appendChild(child) {
				if (!child) return child
				if (child.parentNode && child.parentNode.children) {
					const idx = child.parentNode.children.indexOf(child)
					if (idx >= 0) child.parentNode.children.splice(idx, 1)
				}
				child.parentNode = this
				this.children.push(child)
				if (this.tagName === 'SELECT' && child.tagName === 'OPTION' && this.options.length === 1 && !this._value) {
					this._value = child.value
				}
				return child
			},
			append(...nodes) { nodes.forEach((n) => this.appendChild(n)) },
			insertBefore(node, ref) {
				if (!node) return node
				if (node.parentNode && node.parentNode.children) {
					const old = node.parentNode.children.indexOf(node)
					if (old >= 0) node.parentNode.children.splice(old, 1)
				}
				node.parentNode = this
				const idx = ref ? this.children.indexOf(ref) : -1
				if (idx >= 0) this.children.splice(idx, 0, node)
				else this.children.push(node)
				return node
			},
			removeChild(child) {
				const idx = this.children.indexOf(child)
				if (idx >= 0) this.children.splice(idx, 1)
				child.parentNode = null
				return child
			},
			setAttribute(k, v) { this.attrs[k] = String(v) },
			getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null },
			removeAttribute(k) { delete this.attrs[k] },
			addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
			dispatchEvent(ev) {
				const list = this.listeners[ev.type] || []
				list.forEach((fn) => fn.call(this, ev))
				if (this.parentNode && this.parentNode.dispatchEvent) this.parentNode.dispatchEvent(ev)
			},
			contains(node) {
				let cur = node
				while (cur) {
					if (cur === this) return true
					cur = cur.parentNode
				}
				return false
			},
			closest() { return null },
			blur() {},
			focus() {},
			click() { this.dispatchEvent({ type: 'click', target: this, stopPropagation() {}, preventDefault() {} }) },
			querySelector(sel) {
				const all = this.querySelectorAll(sel)
				return all[0] || null
			},
			querySelectorAll(sel) {
				const out = []
				const clsMatch = sel.match(/\.([A-Za-z0-9_-]+)$/)
				const targetCls = clsMatch ? clsMatch[1] : null
				function walk(node) {
					if (!node || !node.children) return
					for (const c of node.children) {
						if (targetCls && c.classList && c.classList.contains(targetCls)) out.push(c)
						walk(c)
					}
				}
				walk(this)
				return out
			},
		}
		if (id) el.id = id
		if (cls) el.className = cls
		return el
	}

	const rootEl = createEl('div', 'root')
	const view = createEl('div', 'view-blu')
	const bar = createEl('div', null, 'blu-connect-bar')
	const wrapper = createEl('div', null, 'blu-wrapper')
	const devMenu = createEl('div', 'blu-device-menu')
	const devBtn = createEl('button', 'blu-device-btn')
	const bannerTitle = createEl('span', null, 'blu-banner-title')
	bannerTitle.textContent = 'BLU'
	const devLabel = createEl('span', 'blu-device-label')
	const devPop = createEl('div', 'blu-device-pop')
	devPop.hidden = true
	const devList = createEl('div', 'blu-device-list')
	const selPortBtn = createEl('button', 'blu-select-port')
	devBtn.append(bannerTitle, devLabel)
	devPop.append(devList, selPortBtn)
	devMenu.append(devBtn, devPop)
	const portSel = createEl('select', 'blu-port-select')
	const openBtn = createEl('button', 'blu-open')
	const voltWrap = createEl('div', 'blu-voltage-wrap')
	const voltInput = createEl('input', 'blu-voltage-set')
	voltWrap.append(voltInput)
	const dutPowerBtn = createEl('button', 'blu-dut-power')
	const rateSel = createEl('select', 'blu-sample-rate')
	;[['100k', '100K'], ['10k', '10K'], ['1k', '1K'], ['100', '100Hz'], ['10', '10Hz'], ['1', '1Hz']].forEach(([v, t]) => {
		const o = createEl('option')
		o.value = v
		o.textContent = t
		rateSel.appendChild(o)
	})
	rateSel.value = '100k'
	const modeSel = createEl('select', 'blu-record-mode')
	const oWave = createEl('option'); oWave.value = 'wave'; oWave.textContent = '波形'
	modeSel.appendChild(oWave); modeSel.value = 'wave'
	const curEl = createEl('span', 'blu-current')
	curEl.textContent = '--'
	const startBtn = createEl('button', 'blu-start')

	bar.append(devMenu, portSel, openBtn, voltWrap, dutPowerBtn, rateSel, modeSel, startBtn)
	wrapper.append(curEl)
	view.append(bar, wrapper)
	rootEl.append(view)

	const doc = {
		readyState: 'complete',
		dispatched,
		getElementById(id) { return byId.get(id) || null },
		createElement(tag) { return createEl(tag) },
		createTextNode(text) { return { nodeType: 3, nodeValue: String(text), textContent: String(text) } },
		querySelector(sel) {
			if (sel === '#view-blu .blu-banner-title') return bannerTitle
			return rootEl.querySelector(sel)
		},
		querySelectorAll(sel) { return rootEl.querySelectorAll(sel) },
		addEventListener(type, fn) { (docListeners[type] ||= []).push(fn) },
		dispatchEvent(ev) {
			dispatched.push(ev)
			const list = docListeners[ev.type] || []
			list.forEach((fn) => fn(ev))
		},
	}

	return {
		doc,
		els: { view, bar, bannerTitle, devLabel, devBtn, voltInput, dutPowerBtn, rateSel, openBtn, curEl },
	}
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('常量与双向加载顺序：BluProtocol 先加载或 PowerDriverRegistry 先加载都能自动注册 blu-100k', () => {
	assert.deepEqual(PowerDriverRegistryMod.RESERVED_IDS, ['blu-100k'])
	assert.equal(PowerDriverRegistryMod.HIDDEN_KEY, 'powerDriverHiddenIds')
	assert.equal(PowerDriverRegistryMod.ACTIVE_KEY, 'powerActiveDriverId')

	// 顺序 A：BluProtocol 先加载，再创建注册表
	const protoA = loadBluProtocol({})
	const regA = PowerDriverRegistryMod.createRegistry({ window: { BluProtocol: protoA }, document: null, localStorage: null })
	assert.equal(regA.has('blu-100k'), true)
	assert.equal(regA.isBuiltin('blu-100k'), true)
	assert.equal(regA.getActiveId(), 'blu-100k')

	// 顺序 B：注册表先创建，再加载 BluProtocol
	const winB = {}
	const regB = PowerDriverRegistryMod.createRegistry({ window: winB, document: null, localStorage: null })
	winB.PowerDriverRegistry = regB
	assert.equal(regB.has('blu-100k'), false)
	loadBluProtocol(winB)
	assert.equal(regB.has('blu-100k'), true)
	assert.equal(regB.isBuiltin('blu-100k'), true)
	assert.equal(regB.getActiveDriver().shortName, 'BLU')
})

test('内置 blu-100k 锁定防覆盖、非法 ID 拒绝与跨源冲突拦截', () => {
	const proto = loadBluProtocol({})
	const reg = PowerDriverRegistryMod.createRegistry({ window: { BluProtocol: proto }, document: null, localStorage: null })

	// 外部尝试覆盖内置 blu-100k
	assert.throws(() => reg.register('blu-100k', { name: 'Fake BLU' }), /不允许被外部覆盖|不允许覆盖/)
	assert.throws(() => reg.register('blu-100k', { builtin: true, name: 'Second Builtin' }), /不允许被外部覆盖|不允许覆盖/)
	assert.equal(reg.unregister('blu-100k').ok, false)

	// 首次非 builtin 注册保留 ID 也拒绝
	const emptyReg = PowerDriverRegistryMod.createRegistry({ window: {}, document: null, localStorage: null })
	assert.throws(() => emptyReg.register('blu-100k', { name: 'Hijack' }), /不允许被外部覆盖/)

	// 原型键与非法格式拒绝
	for (const bad of ['', '   ', '__proto__', 'constructor', 'prototype', 'BadUpper', '-dash', 'a'.repeat(49)]) {
		assert.throws(() => reg.register(bad, { name: 'Bad' }))
	}

	// 同源热更新允许，跨源或跨 owner 拒绝
	assert.equal(reg.register('ppk2-demo', { name: 'PPK2 v1', source: 'js-local', ownerPluginId: 'plugin-a' }), true)
	assert.equal(reg.register('ppk2-demo', { name: 'PPK2 v2', source: 'js-local', ownerPluginId: 'plugin-a' }), true)
	assert.equal(reg.get('ppk2-demo').name, 'PPK2 v2')
	assert.throws(() => reg.register('ppk2-demo', { name: 'PPK2 hijack', source: 'js-local', ownerPluginId: 'plugin-b' }), /已被其它来源占用/)
	assert.throws(() => reg.register('ppk2-demo', { name: 'PPK2 hijack2', source: 'js-remote', ownerPluginId: 'plugin-a' }), /已被其它来源占用/)

	// 排序：blu-100k 始终第一，自定义按注册序
	reg.register('ina226', { name: 'INA226', source: 'js-local' })
	assert.deepEqual(reg.list().map((x) => x.id), ['blu-100k', 'ppk2-demo', 'ina226'])
})

test('显隐持久化、至少保留一个可见驱动与程序化激活自动取消隐藏', () => {
	const proto = loadBluProtocol({})
	const storage = makeStorage()
	const events = []
	const doc = { dispatchEvent(ev) { events.push(ev) } }
	const reg = PowerDriverRegistryMod.createRegistry({
		window: { BluProtocol: proto, CustomEvent: FakeCustomEvent },
		document: doc,
		localStorage: storage,
	})

	// 仅有一个驱动时不能隐藏
	const onlyOne = reg.setHidden('blu-100k', true)
	assert.equal(onlyOne.ok, false)

	reg.register('ina226', { name: 'INA226 电流表', shortName: 'INA226' })
	assert.equal(reg.setHidden('ina226', true).ok, true)
	assert.equal(reg.isHidden('ina226'), true)
	assert.deepEqual(reg.list().map((x) => x.id), ['blu-100k'])
	assert.deepEqual(reg.list({ includeHidden: true }).map((x) => x.id), ['blu-100k', 'ina226'])
	assert.deepEqual(JSON.parse(storage.getItem(reg.HIDDEN_KEY)), ['ina226'])

	// 激活一个隐藏驱动：自动取消隐藏并持久化 ACTIVE_KEY
	const activeChanges = []
	reg.setHost({
		isBusy: () => false,
		onActiveChange: (id, drv, prev) => activeChanges.push({ id, prev, name: drv && drv.name }),
	})
	const sw = reg.setActiveId('ina226')
	assert.equal(sw.ok, true)
	assert.equal(reg.isHidden('ina226'), false)
	assert.equal(reg.getActiveId(), 'ina226')
	assert.equal(storage.getItem(reg.ACTIVE_KEY), 'ina226')
	assert.equal(activeChanges.length, 1)
	assert.equal(activeChanges[0].id, 'ina226')
	assert.ok(events.some((e) => e.type === 'serial-power-driver-registry-change' && e.detail.action === 'active'))

	// 未连接时隐藏当前激活项 → 自动切回 blu-100k
	const hideActive = reg.setHidden('ina226', true)
	assert.equal(hideActive.ok, true)
	assert.equal(reg.getActiveId(), 'blu-100k')

	// setHiddenIds 企图全部隐藏时保底保留 blu-100k
	reg.setHiddenIds(['blu-100k', 'ina226'])
	assert.equal(reg.isHidden('blu-100k'), false)
	assert.equal(reg.isHidden('ina226'), true)
})

test('连接中（host.isBusy）禁止切换、隐藏或移除当前激活驱动', () => {
	const proto = loadBluProtocol({})
	const reg = PowerDriverRegistryMod.createRegistry({ window: { BluProtocol: proto }, document: null, localStorage: null })
	reg.register('jig-meter', { name: '工装电流表', shortName: 'JIG' })

	let busy = true
	reg.setHost({ isBusy: () => busy })

	const swFail = reg.setActiveId('jig-meter')
	assert.equal(swFail.ok, false)
	assert.equal(swFail.error, '请先关闭当前功耗仪连接再切换协议')
	assert.equal(reg.getActiveId(), 'blu-100k')

	const hideFail = reg.setHidden('blu-100k', true)
	assert.equal(hideFail.ok, false)
	assert.equal(hideFail.error, '当前功耗仪协议正在连接中使用，请先断开连接后再隐藏')

	// 隐藏非激活项仍允许
	assert.equal(reg.setHidden('jig-meter', true).ok, true)

	// 切到自定义驱动并置忙，禁止移除与隐藏
	busy = false
	assert.equal(reg.setActiveId('jig-meter').ok, true)
	busy = true
	assert.equal(reg.setHidden('jig-meter', true).ok, false)
	assert.equal(reg.unregister('jig-meter').ok, false)
	// setHiddenIds 也不能偷偷隐藏正在使用的激活项
	reg.setHiddenIds(['jig-meter'])
	assert.equal(reg.isHidden('jig-meter'), false)

	busy = false
	assert.equal(reg.unregister('jig-meter').ok, true)
	assert.equal(reg.getActiveId(), 'blu-100k')
})

test('自定义被动流与指令型驱动：pushChunk 归一化、字节校验、能力清洗与异常隔离', async () => {
	const reg = PowerDriverRegistryMod.createRegistry({ window: {}, document: null, localStorage: null })

	// 1) 被动流驱动（顶层方法，无需 createSession）
	reg.register('passive-ina', {
		name: 'INA226 被动流',
		shortName: 'INA226',
		usbFilters: [{ usbVendorId: 0x1A86, usbProductId: 0x7523 }, { bad: true }],
		capabilities: {
			nominalHz: 1000,
			voltage: { supported: false, minMv: 5000, maxMv: 1000, defaultMv: 3300, requiresBeforeStart: false },
			dutPower: { supported: false },
			logicBits: 99,
		},
		parseChunk(u8) {
			return [10.5, NaN, Infinity, { iUA: 25.25, range: 2, logic: 0x5a }, { iUA: -Infinity }, { iUA: 'bad' }]
		},
		getStreamStats() {
			const o = { frames: 7 }
			Object.defineProperty(o, 'constructor', { value: 'evil', enumerable: true })
			return o
		},
	})

	const passive = reg.get('passive-ina')
	assert.equal(passive.usbFilters.length, 1)
	assert.equal(passive.matchPort({ usbVendorId: 0x1A86, usbProductId: 0x7523 }), true)
	assert.equal(passive.matchPort({ usbVendorId: 0x15A2, usbProductId: 0x300A }), false)
	assert.equal(passive.capabilities.voltage.minMv, 1000, 'minMv > maxMv 自动规范交换')
	assert.equal(passive.capabilities.voltage.maxMv, 5000)
	assert.equal(passive.capabilities.logicBits, 16, 'logicBits 钳位到 0..16')

	const ps = passive.createSession()
	assert.equal(ps.buildStart(), null)
	assert.equal(ps.buildStop(), null)
	assert.deepEqual(ps.pushChunk(new Uint8Array([1, 2])), [
		{ iUA: 10.5, range: 0, logic: 0 },
		{ iUA: 25.25, range: 2, logic: 0x5a },
	])
	const stats = ps.getStreamStats()
	assert.equal(stats.frames, 7)
	assert.equal(Object.prototype.hasOwnProperty.call(stats, 'constructor'), false)

	// 2) 指令型驱动 + 异常隔离
	reg.register('faulty-cmd', {
		name: '指令型异常测试驱动',
		matchPort() { throw new Error('match boom') },
		createSession() {
			return {
				async onConnect() { throw new Error('handshake boom') },
				buildSetVoltage(mv) { return [0x01, (mv >> 8) & 0xff, mv & 0xff] },
				buildSetDutPower(on) { return on ? new Array(5000).fill(0) : [0x02, 0x00] },
				buildStart() { return [0x03] },
				buildStop() { return [0x04] },
				pushChunk() { throw new Error('parse boom') },
				resetStream() { throw new Error('reset boom') },
				getStreamStats() { throw new Error('stats boom') },
			}
		},
	})
	const faulty = reg.get('faulty-cmd')
	assert.equal(faulty.matchPort({}), false, 'matchPort 抛错被隔离为 false')
	const fsess = faulty.createSession()
	const conn = await fsess.onConnect({})
	assert.equal(conn.ok, false)
	assert.match(conn.error, /handshake boom/)
	assert.deepEqual(Array.from(fsess.buildSetVoltage(3300)), [0x01, 0x0c, 0xe4])
	assert.throws(() => fsess.buildSetDutPower(true), /超过 4096 字节/)
	assert.deepEqual(Array.from(fsess.buildSetDutPower(false)), [0x02, 0x00])
	assert.deepEqual(fsess.pushChunk(new Uint8Array([1])), [], 'pushChunk 抛错被隔离为 []')
	assert.doesNotThrow(() => fsess.resetStream())
	assert.deepEqual(fsess.getStreamStats(), {})
})

test('BLU 100k 内置驱动：onConnect 元数据解析与 250ms 供电探测', async () => {
	const proto = loadBluProtocol({})
	const drv = proto.createPowerDriver()
	const sess = drv.createSession()

	const written = []
	const fakeSampleWord = ((2 << 14) | 2000) >>> 0 // range=2, adc=2000*4
	const chunk = new Uint8Array(250 * 4)
	const dv = new DataView(chunk.buffer)
	for (let i = 0; i < 250; i++) dv.setUint32(i * 4, fakeSampleWord, true)

	const res = await sess.onConnect({
		isAlive: () => true,
		write: async (bytes) => { written.push(Array.from(bytes)); return true },
		collectText: async () => 'Calibrated:1\nR2:10.15\nVDD:3300\nSN:BLU-9988\nEND\n',
		probeSamples: async ({ parseChunk }) => {
			const samples = parseChunk(chunk)
			return { samples, count: samples.length }
		},
	})

	assert.equal(res.ok, true)
	assert.equal(res.modifiersOk, true)
	assert.equal(res.savedVddMv, 3300)
	assert.equal(res.deviceSn, 'BLU-9988')
	assert.ok(res.dutPower && res.dutPower.on === true && res.dutPower.n === 250)
	assert.deepEqual(written[0], Array.from(proto.cmdMeta()))
})

test('完整集成：能力门控 UI、XSS 安全文本、modern-power 下拉切换与 BluPowerToolPluginSpec 繁忙判定', async () => {
	const { doc, els } = makeMiniDom()
	const storage = makeStorage()
	const toolPlugins = new Map()
	const writes = []
	let readController = null

	function makeFakePort(info) {
		return {
			getInfo: () => info,
			open: async (opts) => { fakePort.lastOpenOpts = opts },
			close: async () => {},
			setSignals: async () => {},
			readable: {
				getReader() {
					return {
						read() {
							return new Promise((resolve) => {
								readController = resolve
							})
						},
						cancel: async () => {
							if (readController) {
								const fn = readController
								readController = null
								fn({ value: undefined, done: true })
							}
						},
						releaseLock() {},
					}
				},
			},
			writable: {
				getWriter() {
					return {
						write: async (b) => { writes.push(Array.from(b)) },
						releaseLock() {},
					}
				},
			},
		}
	}
	const fakePort = makeFakePort({ usbVendorId: 0x1A86, usbProductId: 0x7523 })

	const win = {
		APP_VERSION: 'test',
		CustomEvent: FakeCustomEvent,
		localStorage: storage,
		AppPlatform: { has: (f) => f === 'view.power' },
		ToolPluginRegistry: {
			has: (id) => toolPlugins.has(id),
			register: (id, spec) => { toolPlugins.set(id, spec); return true },
		},
		SerialAdapter: {
			isSupported: () => true,
			getPorts: async () => [fakePort],
			getUsbDevices: async () => [],
			addEventListener: () => {},
		},
		addEventListener: () => {},
	}
	win.PowerDriverRegistry = PowerDriverRegistryMod.createRegistry({ window: win, document: doc, localStorage: storage })

	const sandbox = {
		window: win,
		globalThis: win,
		document: doc,
		localStorage: storage,
		SerialAdapter: win.SerialAdapter,
		CustomEvent: FakeCustomEvent,
		MutationObserver: class { observe() {} disconnect() {} },
		TextDecoder,
		performance: { now: () => Date.now() },
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		console,
		Uint8Array,
		Float32Array,
		Float64Array,
		Math,
		Number,
		isFinite,
		parseInt,
		parseFloat,
		Date,
		Promise,
	}

	vm.runInNewContext(bluProtocolSrc, sandbox, { filename: 'js/blu-protocol.js' })
	vm.runInNewContext(bluPowerSrc, sandbox, { filename: 'js/blu-power.js' })
	vm.runInNewContext(modernPowerSrc, sandbox, { filename: 'js/modern-power.js' })

	// 1) BluPowerToolPluginSpec 声明与自动注册
	const spec = win.BluPowerToolPluginSpec
	assert.ok(spec, '暴露 window.BluPowerToolPluginSpec')
	assert.equal(spec.id, 'power')
	assert.equal(spec.name, '功耗分析')
	assert.equal(spec.label, '功耗分析')
	assert.equal(spec.icon, 'bi-speedometer2')
	assert.equal(spec.builtin, true)
	assert.equal(spec.feature, 'view.power')
	assert.equal(spec.viewId, 'view-blu')
	assert.equal(toolPlugins.get('power'), spec)
	assert.equal(spec.isBusy(), false)
	assert.equal(spec.busyReason(), '')
	assert.equal(spec.statusBadge(), null)

	// 2) 注册带 XSS 字符的外部被动流驱动（验证 textContent 隔离 + 能力门控 UI）
	const xssShort = '<img src=x onerror=1>'
	win.PowerDriverRegistry.register('ina-passive', {
		name: 'INA226 串口电流表',
		shortName: xssShort,
		usbFilters: [{ usbVendorId: 0x1A86, usbProductId: 0x7523 }],
		serialOptions: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
		capabilities: {
			nominalHz: 1000,
			voltage: { supported: false, requiresBeforeStart: false },
			dutPower: { supported: false },
		},
		buildStart: () => null,
		buildStop: () => null,
		pushChunk: () => [{ iUA: 1234.5 }],
	})

	const drvSel = doc.getElementById('blu-driver-select')
	assert.ok(drvSel, 'modern-power 工具栏已插入 #blu-driver-select')
	assert.deepEqual(drvSel.options.map((o) => o.value), ['blu-100k', 'ina-passive'])
	assert.equal(drvSel.disabled, false)

	// 通过下拉框切换到 ina-passive
	drvSel.value = 'ina-passive'
	drvSel.dispatchEvent({ type: 'change', target: drvSel })
	assert.equal(win.bluApi.getActiveDriverId(), 'ina-passive')
	assert.equal(els.bannerTitle.textContent, xssShort.slice(0, 16), 'shortName 经 textContent 渲染且限长 16')
	assert.equal(els.bannerTitle.innerHTML, '', '不通过 innerHTML 注入外部驱动名称')
	assert.equal(els.voltInput.placeholder, '参考')
	assert.match(els.voltInput.title, /参考电压/)
	assert.equal(els.dutPowerBtn.disabled, true)
	assert.equal(els.dutPowerBtn.title, '当前功耗仪协议不支持 DUT 上下电控制')
	assert.deepEqual(els.rateSel.options.map((o) => o.value), ['1k', '100', '10', '1'])

	// 3) 打开连接后：繁忙判定为真、下拉禁用、拒绝切协议、被动流采样无串口写
	els.openBtn.click()
	await new Promise((r) => setTimeout(r, 150))
	assert.equal(win.bluApi.isOpen(), true)
	assert.equal(fakePort.lastOpenOpts.baudRate, 115200, '按当前驱动 serialOptions 打开串口')
	assert.equal(drvSel.disabled, true, '连接中禁用协议下拉框')
	assert.equal(spec.isBusy(), true)
	assert.equal(spec.busyReason(), '功耗仪已连接')
	assert.equal(spec.statusBadge().state, 'open')

	const rejectSwitch = win.bluApi.setActiveDriver('blu-100k')
	assert.equal(rejectSwitch.ok, false)
	assert.equal(rejectSwitch.code, 'blu_busy')

	const startRes = await win.bluApi.startCapture()
	assert.equal(startRes.ok, true)
	assert.equal(spec.busyReason(), '功耗仪正在采样')
	assert.equal(spec.statusBadge().state, 'sampling')
	assert.equal(writes.length, 0, '被动流开始采样不写任何指令帧')

	const stopRes = await win.bluApi.stopCapture()
	assert.equal(stopRes.ok, true)
	assert.equal(writes.length, 0, '被动流停止采样不写任何指令帧')

	// 关闭连接后恢复空闲
	els.openBtn.click()
	await new Promise((r) => setTimeout(r, 50))
	assert.equal(win.bluApi.isOpen(), false)
	assert.equal(drvSel.disabled, false)
	assert.equal(spec.isBusy(), false)
	assert.equal(spec.statusBadge(), null)
})

;(async () => {
	let failed = 0
	for (const t of tests) {
		try {
			await t.fn()
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
})()
