// Run: node tests/protocol-registry.cjs — synthetic data only.
// 覆盖: 协议注册表契约(js/protocol-registry.js)、保留 ID 与合法 ID 校验、移动端 AppPlatform 门控、
// 显隐持久化与至少保留一个可见协议保底、单双路与预设安全回退、程序化切换自动取消隐藏、
// 外部协议 logView/formatFrame 的 XSS 结构化隔离、通用下行参数编码与面板生命周期切换。
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const P = require('../js/platform.js')
const DualCfg = require('../js/dual-config.js')
const ProtocolRegistryMod = require('../js/protocol-registry.js')
const ProtocolDownlink = require('../js/protocol-downlink.js')

// 加载 ParseView（浏览器风格 IIFE）
const pvSandbox = { window: {}, globalThis: null }
pvSandbox.globalThis = pvSandbox.window
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/parse-view.js'), 'utf8'), pvSandbox, { filename: 'js/parse-view.js' })
const ParseView = pvSandbox.window.ParseView
assert.ok(ParseView && typeof ParseView.render === 'function' && typeof ParseView.esc === 'function')

function makeStorage(initial) {
	const map = Object.assign({}, initial || {})
	return {
		_map: map,
		getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null },
		setItem(k, v) { map[k] = String(v) },
		removeItem(k) { delete map[k] },
	}
}

function makeSelect(id) {
	const el = {
		id,
		options: [],
		_value: '',
		listeners: {},
		get value() { return this._value },
		set value(v) { this._value = String(v) },
		set textContent(v) { if (v === '') this.options = [] },
		appendChild(opt) {
			this.options.push(opt)
			if (this.options.length === 1 && !this._value) this._value = opt.value
			return opt
		},
		addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
		dispatchEvent(ev) {
			const list = this.listeners[ev.type] || []
			list.forEach((fn) => fn.call(this, ev))
		},
	}
	return el
}

function makeDoc(selectEl) {
	const events = []
	return {
		events,
		getElementById(id) { return id === 'serial-protocol-select' ? selectEl : null },
		createElement(tag) { return { tagName: tag.toUpperCase(), value: '', textContent: '' } },
		dispatchEvent(ev) { events.push(ev) },
	}
}

class FakeCustomEvent {
	constructor(type, init) {
		this.type = type
		this.detail = init ? init.detail : null
	}
}

// ---- 1. 常量、规范排序（sek 第一 → 其余内置按注册序 → 自定义按注册序）与 list capabilities ----
{
	assert.deepEqual(ProtocolRegistryMod.RESERVED_IDS, ['sek', 'wmbus', 'gz', 'cjt188', 'sk-ultrasonic', 'hostproto', 'cellular-at'])
	assert.equal(ProtocolRegistryMod.HIDDEN_KEY, 'protocolHiddenIds')

	const sel = makeSelect('serial-protocol-select')
	const doc = makeDoc(sel)
	const storage = makeStorage()
	const win = { _protocols: {}, _activeProtocol: 'sek', CustomEvent: FakeCustomEvent }
	const reg = ProtocolRegistryMod.createRegistry({ window: win, document: doc, localStorage: storage, ParseView })

	const changes = []
	const unsub = reg.onChange((d) => changes.push(d))

	// 故意先注册其他内置协议和自定义协议，最后才注册 sek（模拟 index.html 实际加载顺序）
	assert.equal(reg.register('wmbus', { name: 'W-MBUS', builtin: true, parseFrame: () => ({}), mountPanel: () => {} }), true)
	assert.equal(reg.register('demo-json', { name: '自定义传感器', builtin: false, source: 'json', version: '1.0.0', description: 'demo', parseFrame: () => ({}), buildDownFrame: () => new Uint8Array([1]), presets: [{ group: 'G', items: [{ name: 'A' }] }] }), true)
	assert.equal(reg.register('gz', { name: '工装通信协议', builtin: true, parseFrame: () => ({}), mountPanel: () => {} }), true)
	assert.equal(reg.register('sek', { name: 'SEK', builtin: true, parseFrame: () => ({}), buildDownFrame: () => new Uint8Array([1]), presets: [{ group: 'G', items: [{ name: 'Q' }] }], mountPanel: () => {} }), true)
	assert.equal(reg.register('alpha-js', { name: 'Alpha JS', source: 'js-local', ownerPluginId: 'p1', parseFrame: () => ({}) }), true)

	assert.deepEqual(sel.options.map((o) => o.value), ['sek', 'wmbus', 'gz', 'demo-json', 'alpha-js'], '下拉框排序必须固定：sek 第一 → 其余内置 → 自定义')
	assert.equal(reg.isBuiltin('sek'), true)
	assert.equal(reg.isBuiltin('demo-json'), false)
	assert.equal(reg.has('alpha-js'), true)
	assert.equal(reg.get('alpha-js').ownerPluginId, 'p1')

	const listAll = reg.list({ includeHidden: true })
	assert.deepEqual(listAll.map((x) => x.id), ['sek', 'wmbus', 'gz', 'demo-json', 'alpha-js'])
	const demoItem = listAll.find((x) => x.id === 'demo-json')
	assert.deepEqual(demoItem.capabilities, { parse: true, downlink: true, presets: true, customPanel: false })
	const alphaItem = listAll.find((x) => x.id === 'alpha-js')
	assert.deepEqual(alphaItem.capabilities, { parse: true, downlink: false, presets: false, customPanel: false })
	assert.equal(changes.length, 5)
	assert.deepEqual(changes[0], { action: 'register', id: 'wmbus' })
	assert.equal(doc.events[0].type, 'serial-protocol-registry-change')
	assert.deepEqual(doc.events[0].detail, { action: 'register', id: 'wmbus' })

	unsub()
	reg.register('beta-js', { name: 'Beta', parseFrame: () => ({}) })
	assert.equal(changes.length, 5, '取消订阅后不再收到通知')
}

// ---- 2. 保留内置 ID 防覆盖、自定义 ID 合法性校验、内置不可注销 ----
{
	const sel = makeSelect('serial-protocol-select')
	const doc = makeDoc(sel)
	const win = { _protocols: {}, _activeProtocol: 'sek', CustomEvent: FakeCustomEvent }
	const reg = ProtocolRegistryMod.createRegistry({ window: win, document: doc, localStorage: makeStorage(), ParseView })
	reg.register('sek', { name: 'SEK', builtin: true, parseFrame: () => ({}) })

	for (const rid of ProtocolRegistryMod.RESERVED_IDS) {
		assert.throws(() => reg.register(rid, { name: 'spoof' }), /保留/, '外部不得占用保留 ID: ' + rid)
		assert.throws(() => reg.register(rid, { name: 'spoof', builtin: false }), /保留/)
	}
	for (const badId of ['', '   ', 'UpperCase', '-leading-dash', '_leading_under', 'bad id', 'a/b', 'a'.repeat(49)]) {
		assert.throws(() => reg.register(badId, { name: 'bad' }), '非法自定义 ID 应抛错: ' + badId)
	}
	const builtUnreg = reg.unregister('sek')
	assert.deepEqual(builtUnreg, { ok: false, error: '内置协议不可删除，可设为隐藏' })
	assert.equal(reg.has('sek'), true)
}

// ---- 3. 移动端 AppPlatform.allowsProtocol 白名单门控 ----
{
	const mobileDesc = P.resolve({ os: 'android', runtime: 'tauri' })
	const mobilePlatform = {
		allowsProtocol: (id) => mobileDesc.protocols === '*' || mobileDesc.protocols.includes(id),
	}
	const sel = makeSelect('serial-protocol-select')
	const doc = makeDoc(sel)
	const win = { _protocols: {}, _activeProtocol: 'sek', CustomEvent: FakeCustomEvent }
	const reg = ProtocolRegistryMod.createRegistry({ window: win, document: doc, localStorage: makeStorage(), AppPlatform: mobilePlatform, ParseView })

	assert.equal(reg.register('sek', { name: 'SEK', builtin: true, parseFrame: () => ({}) }), true)
	assert.equal(reg.register('gz', { name: '工装', builtin: true, parseFrame: () => ({}) }), false)
	assert.equal(reg.register('wmbus', { name: 'W-MBUS', builtin: true, parseFrame: () => ({}) }), false)
	assert.equal(reg.register('custom-sensor', { name: '外部传感器', parseFrame: () => ({}) }), false)
	assert.throws(() => reg.register('sek', { name: '恶意覆盖' }), /保留/, '移动端也严禁外部覆盖 sek')
	assert.deepEqual(sel.options.map((o) => o.value), ['sek'])
	assert.equal(Object.keys(win._protocols).length, 1)
}

// ---- 4. protocolHiddenIds 持久化、至少保留 1 个可见协议保底、list 过滤 ----
{
	const sel = makeSelect('serial-protocol-select')
	const doc = makeDoc(sel)
	// 模拟存储中把所有协议都藏掉了
	const storage = makeStorage({ protocolHiddenIds: JSON.stringify(['sek', 'hostproto']) })
	const win = { _protocols: {}, _activeProtocol: 'sek', CustomEvent: FakeCustomEvent }
	const reg = ProtocolRegistryMod.createRegistry({ window: win, document: doc, localStorage: storage, ParseView })

	reg.register('sek', { name: 'SEK', builtin: true, parseFrame: () => ({}) })
	// 存储里隐藏了 sek，但由于它是唯一已注册协议，保底机制应自动取消隐藏 sek
	assert.equal(reg.isHidden('sek'), false, '全部被隐藏时自动为 sek 解除隐藏')
	assert.equal(reg.isSelectable('sek'), true)

	reg.register('hostproto', { name: 'hostProto', builtin: true, parseFrame: () => ({}) })
	assert.equal(reg.isHidden('hostproto'), true, '存储里已隐藏的其它协议保持隐藏')
	assert.deepEqual(reg.list().map((x) => x.id), ['sek'])
	assert.deepEqual(reg.list({ includeHidden: true }).map((x) => x.id), ['sek', 'hostproto'])

	// 尝试隐藏最后一个可见协议 sek：必须拒绝
	const deny = reg.setHidden('sek', true)
	assert.deepEqual(deny, { ok: false, error: '至少需要保留一个可见协议' })
	assert.equal(reg.isHidden('sek'), false)

	// 先显示 hostproto，再隐藏 sek -> 成功，fallbackProtocolId 应变为 hostproto
	assert.deepEqual(reg.setHidden('hostproto', false), { ok: true })
	assert.deepEqual(reg.setHidden('sek', true), { ok: true })
	assert.equal(reg.fallbackProtocolId(), 'hostproto')
	assert.deepEqual(JSON.parse(storage.getItem('protocolHiddenIds')), ['sek'])
	assert.deepEqual(sel.options.map((o) => o.value), ['hostproto'])

	// 批量 setHiddenIds 把所有协议都放进隐藏列表 -> 自动保底保留 sek
	reg.setHiddenIds(['sek', 'hostproto'])
	assert.equal(reg.isHidden('sek'), false)
	assert.equal(reg.isHidden('hostproto'), true)
}

// ---- 5. 删除或隐藏当前单/双路协议时的安全回退 + 程序化切换自动取消隐藏 + 预设回退 ----
{
	const sel = makeSelect('serial-protocol-select')
	const doc = makeDoc(sel)
	const storage = makeStorage()
	const win = { _protocols: {}, _activeProtocol: 'demo-p', CustomEvent: FakeCustomEvent }
	const reg = ProtocolRegistryMod.createRegistry({ window: win, document: doc, localStorage: storage, ParseView })

	const state = {
		mode: 'dual',
		activeSendId: 'A',
		singleProtocolId: 'demo-p',
		toolOptions: { skProtocol: 'demo-p' },
		laneProtocols: { A: 'demo-p', B: 'hostproto' },
		rerenderCount: 0,
		laneConfigCount: 0,
		unmounted: [],
		mounted: [],
	}

	function reconcile(unavailableId) {
		const fb = reg.fallbackProtocolId()
		const bad = (id) => !!id && ((unavailableId && id === unavailableId) || !reg.isSelectable(id))
		let changed = false
		if (bad(state.singleProtocolId)) {
			state.singleProtocolId = fb
			state.toolOptions.skProtocol = fb
			changed = true
		}
		for (const sid of ['A', 'B']) {
			if (bad(state.laneProtocols[sid])) {
				state.laneProtocols[sid] = fb
				changed = true
			}
		}
		const target = state.mode === 'dual' ? state.laneProtocols[state.activeSendId] : state.singleProtocolId
		win._activeProtocol = bad(target) ? fb : target
		sel.value = win._activeProtocol
		reg.activatePanel(win._activeProtocol)
		if (changed) {
			state.rerenderCount++
			state.laneConfigCount++
		}
	}

	function setLaneProtocol(sid, id) {
		if (reg.has(id) && reg.isHidden(id)) reg.setHidden(id, false)
		if (sid === 'A' || sid === 'B') state.laneProtocols[sid] = id
		else { state.singleProtocolId = id; state.toolOptions.skProtocol = id }
		if ((state.mode === 'dual' && sid === state.activeSendId) || (state.mode === 'single' && sid === 'S')) {
			win._activeProtocol = id
			sel.value = id
			reg.activatePanel(id)
		}
	}

	reg.setHost({
		onUnavailable: reconcile,
		onReconcile: () => reconcile(null),
	})

	reg.register('sek', { name: 'SEK', builtin: true, mountPanel: () => state.mounted.push('sek'), unmountPanel: () => state.unmounted.push('sek') })
	reg.register('hostproto', { name: 'hostProto', builtin: true, mountPanel: () => state.mounted.push('hostproto'), unmountPanel: () => state.unmounted.push('hostproto') })
	reg.register('demo-p', { name: 'Demo', source: 'json', mountPanel: () => state.mounted.push('demo-p'), unmountPanel: () => state.unmounted.push('demo-p') })

	assert.equal(reg.getMountedId(), 'demo-p')
	// 注销当前正在单路和 A 路使用的 demo-p
	const unregRes = reg.unregister('demo-p')
	assert.deepEqual(unregRes, { ok: true })
	assert.deepEqual(state.unmounted, ['demo-p'], '注销前应先 unmountPanel')
	assert.equal(state.singleProtocolId, 'sek', '单路应回退到 sek')
	assert.equal(state.laneProtocols.A, 'sek', '双路 A 应回退到 sek')
	assert.equal(state.laneProtocols.B, 'hostproto', '未受影响的 B 路保持 hostproto')
	assert.equal(win._activeProtocol, 'sek')
	assert.equal(sel.value, 'sek')
	assert.equal(state.rerenderCount, 1)
	assert.equal(state.laneConfigCount, 1)

	// 隐藏 B 路正在使用的 hostproto -> B 路自动回退到 sek
	assert.deepEqual(reg.setHidden('hostproto', true), { ok: true })
	assert.equal(state.laneProtocols.B, 'sek')
	assert.equal(state.rerenderCount, 2)

	// 串口预设引用已隐藏/已删除协议时，DualCfg.planApply 使用 reg.isSelectable 保留原协议并报告 unknownProtocols
	const preset = {
		name: '测试预设',
		A: { options: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', bufferSize: 1024, flowControl: 'none' }, protocol: 'demo-p', label: 'A路' },
		B: { options: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', bufferSize: 1024, flowControl: 'none' }, protocol: 'hostproto', label: 'B路' },
	}
	const curSnap = {
		A: { options: preset.A.options, protocol: 'sek', label: 'A路' },
		B: { options: preset.B.options, protocol: 'sek', label: 'B路' },
	}
	const plan = DualCfg.planApply(preset, curSnap, (id) => reg.isSelectable(id))
	assert.equal(plan.lanes.A.protocol, 'sek', '已删除协议保留原协议')
	assert.equal(plan.lanes.B.protocol, 'sek', '已隐藏协议保留原协议')
	assert.deepEqual(plan.unknownProtocols.sort(), ['demo-p', 'hostproto'])

	// 程序化切换（如 STS 模拟）请求切到已隐藏的 hostproto -> 自动取消隐藏并切换成功
	setLaneProtocol('B', 'hostproto')
	assert.equal(reg.isHidden('hostproto'), false, '程序化切换应自动取消隐藏')
	assert.equal(state.laneProtocols.B, 'hostproto')
	assert.ok(sel.options.some((o) => o.value === 'hostproto'))
}

// ---- 6. 外部协议 XSS 结构化隔离（logView 剥离 section.html、formatFrame 转义） ----
{
	const sel = makeSelect('serial-protocol-select')
	const doc = makeDoc(sel)
	const win = { _protocols: {}, _activeProtocol: 'sek', CustomEvent: FakeCustomEvent }
	const reg = ProtocolRegistryMod.createRegistry({ window: win, document: doc, localStorage: makeStorage(), ParseView })

	const xssPayload = '<img src=x onerror="window.__xss=1"><script>alert(1)</script>'

	// 内置协议保留 section.html 与原始 formatFrame
	reg.register('sek', {
		name: 'SEK',
		builtin: true,
		logView: () => ({ title: '内置', sections: [{ title: '图', html: '<div class="chart">ok</div>' }] }),
		formatFrame: () => '<div class="sk-ok">builtin</div>',
	})
	const sekEntry = reg.get('sek')
	assert.equal(sekEntry.logView({}).sections[0].html, '<div class="chart">ok</div>')
	assert.equal(sekEntry.formatFrame({}), '<div class="sk-ok">builtin</div>')

	// 外部协议带 section.html 和恶意 formatFrame
	reg.register('ext-xss', {
		name: '外部测试',
		source: 'js-local',
		logView: () => ([{
			title: xssPayload,
			sections: [{ title: '段1', html: xssPayload, pre: '已有文本', pairs: [['键', xssPayload]] }],
		}]),
		formatFrame: () => xssPayload,
	})
	const ext = reg.get('ext-xss')
	const sanitized = ext.logView({})
	assert.equal(Array.isArray(sanitized), true)
	assert.equal('html' in sanitized[0].sections[0], false, '外部协议 section.html 必须被彻底删除')
	assert.ok(sanitized[0].sections[0].pre.includes(xssPayload), '原 html 内容降级到 section.pre')
	const renderedLog = ParseView.render(sanitized)
	assert.ok(!renderedLog.includes('<img'), 'ParseView 渲染不得含未转义 <img>')
	assert.ok(!renderedLog.includes('<script>'), 'ParseView 渲染不得含未转义 <script>')
	assert.ok(renderedLog.includes('&lt;img src=x onerror='), '应被 HTML 转义为纯文本')

	const renderedFmt = ext.formatFrame({})
	assert.ok(renderedFmt.startsWith('<pre class="pv-pre">') && renderedFmt.endsWith('</pre>'))
	assert.ok(!renderedFmt.includes('<img') && !renderedFmt.includes('<script>'))
	assert.ok(renderedFmt.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))

	// 外部协议仅提供 logView（未提供 formatFrame）时自动回退 ParseView.render 且安全转义
	reg.register('ext-logonly', {
		name: '仅 logView',
		source: 'json',
		logView: (r) => r && r.ok ? { title: '温湿度', sections: [{ html: xssPayload, pairs: [['温度', '23.5℃']] }] } : null,
	})
	const extLogOnly = reg.get('ext-logonly')
	const okHtml = extLogOnly.formatFrame({ ok: true })
	assert.ok(okHtml.includes('温湿度') && okHtml.includes('23.5℃'))
	assert.ok(!okHtml.includes('<img') && okHtml.includes('&lt;img'))
	const badHtml = extLogOnly.formatFrame({ ok: false, errors: [xssPayload] })
	assert.ok(badHtml.includes('pv-err') && !badHtml.includes('<script>') && badHtml.includes('&lt;script&gt;'))
}

// ---- 7. 通用下行参数编码（js/protocol-downlink.js 纯函数回归） ----
{
	assert.deepEqual(ProtocolDownlink.numToBytes(0x1234, 'uint16le'), [0x34, 0x12])
	assert.deepEqual(ProtocolDownlink.numToBytes(0x1234, 'uint16be'), [0x12, 0x34])
	assert.deepEqual(ProtocolDownlink.numToBytes(-1, 'int16be'), [0xff, 0xff])
	assert.deepEqual(ProtocolDownlink.numToBytes(0x12345678, 'uint32le'), [0x78, 0x56, 0x34, 0x12])
	assert.deepEqual(ProtocolDownlink.numToBytes(0x12345678, 'uint32be'), [0x12, 0x34, 0x56, 0x78])
	assert.deepEqual(ProtocolDownlink.bcdToBytes('123456', 4), [0x56, 0x34, 0x12, 0x00])
	assert.deepEqual(ProtocolDownlink.bcdBeToBytes('123456', 4), [0x00, 0x12, 0x34, 0x56])
	assert.deepEqual(ProtocolDownlink.asciiToHexBytes('AB', 4), [0x41, 0x42, 0x00, 0x00])
	assert.deepEqual(ProtocolDownlink.hexToBytes('AA:55:0D', 4), [0xaa, 0x55, 0x0d, 0x00])

	// multi 位域打包与多字段独立编码
	const bitBytes = ProtocolDownlink.encodeMultiFields(
		[{ bits: [0, 0] }, { bits: [3, 1] }, { bits: [7, 4] }],
		['1', '5', '10']
	)
	assert.deepEqual(bitBytes, [0xab]) // (10 << 4) | (5 << 1) | 1 = 0xA0 | 0x0A | 0x01 = 0xAB
	const seqBytes = ProtocolDownlink.encodeMultiFields(
		[{ type: 'uint16be' }, { type: 'ascii', fillLen: 3 }, { type: 'bcd_be', fillLen: 2 }],
		['0x0102', 'HI', '2026']
	)
	assert.deepEqual(seqBytes, [0x01, 0x02, 0x48, 0x49, 0x00, 0x20, 0x26])

	// funcTabs 推导与搜索过滤
	const tabs = ProtocolDownlink.deriveFuncTabs({
		presets: [{ group: '传感器', items: [{ name: '读温度', func: 'query', desc: 'Temp' }, { name: '控阀', func: 'ctrl', desc: 'Valve' }] }],
	})
	assert.deepEqual(tabs, [{ code: 'query', label: 'query' }, { code: 'ctrl', label: 'ctrl' }])
	const filtered = ProtocolDownlink.filterGenericPresets(
		[{ group: '传感器', items: [{ name: '读温度', func: 'query', desc: 'Temp' }, { name: '读湿度', func: 'query', desc: 'Hum' }] }],
		'query',
		'温度'
	)
	assert.equal(filtered.length, 1)
	assert.deepEqual(filtered[0].filtered.map((x) => x.name), ['读温度'])
}

// ---- 8. 面板切换生命周期（SEK / 自定义面板 / 通用下行 hostProto / 纯解析 cellular-at + 动态 #proto-parse-only-hint / cjt188 共享预览发送） ----
{
	function makeFakeElement(id, tag) {
		const attrs = {}
		const listeners = {}
		const el = {
			id: id || '',
			tagName: (tag || 'DIV').toUpperCase(),
			style: { display: '' },
			dataset: {},
			children: [],
			parentNode: null,
			options: [],
			value: '',
			checked: false,
			hidden: false,
			disabled: false,
			className: '',
			placeholder: '',
			selectedIndex: 0,
			_text: '',
			get textContent() { return this._text },
			set textContent(v) {
				this._text = String(v == null ? '' : v)
				if (this._text === '') { this.children = []; this.options = [] }
			},
			get innerHTML() { return this._text },
			set innerHTML(v) {
				this._text = String(v == null ? '' : v)
				if (this._text === '') { this.children = []; this.options = [] }
			},
			get nextSibling() {
				if (!this.parentNode) return null
				const idx = this.parentNode.children.indexOf(this)
				return idx >= 0 ? (this.parentNode.children[idx + 1] || null) : null
			},
			classList: {
				_set: new Set(),
				add(c) { this._set.add(c) },
				remove(c) { this._set.delete(c) },
				toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c) },
			},
			appendChild(child) {
				child.parentNode = this
				this.children.push(child)
				if (child.tagName === 'OPTION') {
					this.options.push(child)
					if (this.options.length === 1 && !this.value) this.value = child.value
				} else if (child.tagName === 'OPTGROUP') {
					child._parentSelect = this
				}
				return child
			},
			insertBefore(child, ref) {
				child.parentNode = this
				const idx = ref ? this.children.indexOf(ref) : -1
				if (idx >= 0) this.children.splice(idx, 0, child)
				else this.children.push(child)
				return child
			},
			setAttribute(k, v) { attrs[k] = String(v) },
			getAttribute(k) { return attrs[k] || null },
			removeAttribute(k) { delete attrs[k] },
			closest(sel) {
				if (sel === '.ctl-switch') return this._switchWrap || null
				return null
			},
			querySelector(sel) {
				if (sel === '.pane-section-title') return this._titleEl || null
				if (sel === '.sk-preset-row') return this._presetRow || null
				return null
			},
			querySelectorAll() { return this.children.filter((c) => c.dataset && c.dataset.func) },
			addEventListener(type, fn) { (listeners[type] ||= []).push(fn) },
			dispatchEvent(ev) {
				ev.target = this
				;(listeners[ev.type] || []).forEach((fn) => fn.call(this, ev))
			},
			click() { this.dispatchEvent({ type: 'click' }) },
			focus() {},
		}
		return el
	}

	const els = {}
	const navProto = makeFakeElement('nav-protocol', 'DIV')
	const downCard = makeFakeElement('sk-down-card', 'DIV')
	downCard._titleEl = makeFakeElement('', 'H6')
	downCard._presetRow = makeFakeElement('', 'DIV')
	const encWrap = makeFakeElement('', 'DIV')
	const encInput = makeFakeElement('serial-protocol-down-encrypt', 'INPUT')
	encInput._switchWrap = encWrap

	const ids = [
		'serial-protocol-select', 'serial-protocol-advanced', 'sk-rw-card', 'sk-batch-card', 'sk-esim-card',
		'cjt188-down-card', 'cjt188-down-title', 'cjt188-down-preview',
		'serial-protocol-down-tlv', 'serial-protocol-build', 'serial-protocol-send', 'serial-protocol-down-preview',
		'serial-protocol-down-preset', 'serial-protocol-down-func', 'serial-protocol-down-func-tabs',
		'serial-protocol-down-preset-search', 'serial-protocol-down-preset-search-clear', 'serial-protocol-down-desc',
		'serial-protocol-down-param-group', 'serial-protocol-down-param-val', 'serial-protocol-down-param-sel',
		'serial-protocol-down-param-label', 'serial-protocol-down-param-unit', 'serial-protocol-down-param-multi',
	]
	ids.forEach((id) => { els[id] = makeFakeElement(id, id.includes('select') || id.includes('preset') || id.includes('func') ? 'SELECT' : 'DIV') })
	els['nav-protocol'] = navProto
	els['sk-down-card'] = downCard
	els['serial-protocol-down-encrypt'] = encInput
	navProto.appendChild(downCard)

	const fakeDoc = {
		getElementById(id) { return els[id] || navProto.children.find((c) => c.id === id) || null },
		createElement(tag) {
			const node = makeFakeElement('', tag)
			if (tag.toUpperCase() === 'OPTGROUP') {
				const origAppend = node.appendChild.bind(node)
				node.appendChild = (opt) => {
					origAppend(opt)
					if (node._parentSelect && opt.tagName === 'OPTION') node._parentSelect.options.push(opt)
					return opt
				}
			}
			return node
		},
		createTextNode(t) { return { nodeType: 3, textContent: String(t) } },
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent() {},
	}

	const sentHexList = []
	const errors = []
	let genericHandlers = {}
	const sandbox = {
		window: null,
		document: fakeDoc,
		localStorage: makeStorage(),
		console,
		Event: function (type) { this.type = type },
		CustomEvent: FakeCustomEvent,
		Uint8Array,
		Date,
		Math,
		JSON,
		Object,
		Array,
		String,
		Number,
		Set,
		Map,
		parseInt,
		isNaN,
		setTimeout,
		clearTimeout,
	}
	sandbox.window = sandbox
	sandbox.globalThis = sandbox
	sandbox._protocols = {}
	sandbox._activeProtocol = 'sek'
	sandbox.getActiveProtocol = () => sandbox._protocols[sandbox._activeProtocol] || null
	sandbox.SK_DOWN_PRESETS = [{ group: '查询 (0x03)', items: [{ name: '查基本', func: '0x03', tlv: [{ tag: 10, items: [{ id: 1, value: [] }] }] }] }]
	sandbox.skParseFrame = () => ({ ok: true })
	sandbox.skFormatFrame = () => '<div>sek</div>'
	sandbox.skBuildDownFrame = () => new Uint8Array([0x68, 0x01, 0x16])
	sandbox._serialProtocolHost = {
		rawSek: { parseFrame: sandbox.skParseFrame, formatFrame: sandbox.skFormatFrame, buildDownFrame: sandbox.skBuildDownFrame },
		sendHex: (hex) => { sentHexList.push(hex); return Promise.resolve() },
		addLogErr: (msg) => errors.push(msg),
		getToolOptions: () => ({ skDownEncrypt: false }),
		resolveToolEncKey: () => null,
		getDownlinkEncKey: () => null,
		setGenericPanelHandlers: (h) => { genericHandlers = h },
	}

	// 加载真实的 protocol-registry.js 与 protocol-downlink.js
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/protocol-registry.js'), 'utf8'), sandbox, { filename: 'js/protocol-registry.js' })
	sandbox.ProtocolRegistry.setHost({
		mountGenericPanel: (p, c) => genericHandlers.mountGenericPanel && genericHandlers.mountGenericPanel(p, c),
		unmountGenericPanel: (c) => genericHandlers.unmountGenericPanel && genericHandlers.unmountGenericPanel(c),
	})
	// 先注册 hostproto、cellular-at、cjt188（模拟真实加载顺序：在 protocol-downlink.js 之前）
	sandbox.registerProtocol('hostproto', {
		name: 'hostProto 模组',
		builtin: true,
		buildDownFrame: (o) => new Uint8Array([0xaa, 0x55, (o.cmd || 0) & 0xff, ...(o.payload || [])]),
		presets: [{ group: '常用', items: [{ name: 'ECHO', func: '0x00', desc: '探活', cmd: 0x01, payloadHex: '50494E47' }] }],
	})
	sandbox.registerProtocol('cellular-at', {
		name: '蜂窝模组 AT',
		builtin: true,
		parseFrame: () => ({ ok: true }),
		presets: [],
	})
	sandbox.registerProtocol('cjt188', {
		name: '188协议',
		builtin: true,
		parseFrame: () => ({ ok: true }),
		mountPanel: () => { els['cjt188-down-card'].style.display = '' },
		unmountPanel: () => { els['cjt188-down-card'].style.display = 'none' },
	})
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/protocol-downlink.js'), 'utf8'), sandbox, { filename: 'js/protocol-downlink.js' })

	// 初始为 SEK：5 个 SEK 元素可见
	assert.equal(downCard.style.display, '')
	assert.equal(els['sk-rw-card'].style.display, '')
	assert.equal(els['sk-esim-card'].style.display, '')
	assert.equal(encWrap.style.display, '')

	// 切到 hostproto：隐藏 SEK 专属（eSIM 与高级加解密）和加密开关，通用批量/随机卡片不受 SEK 隐藏；复用 #sk-down-card 通用模式并自动生成预览
	sandbox._activeProtocol = 'hostproto'
	sandbox.ProtocolRegistry.activatePanel('hostproto')
	assert.equal(els['sk-rw-card'].style.display, '')
	assert.equal(els['sk-batch-card'].style.display, '')
	assert.equal(els['sk-esim-card'].style.display, 'none')
	assert.equal(els['serial-protocol-advanced'].style.display, 'none')
	assert.equal(downCard.style.display, '')
	assert.equal(downCard.dataset.mode, 'generic')
	assert.equal(encWrap.style.display, 'none')
	assert.equal(els['serial-protocol-down-preview'].value, 'AA 55 01 50 49 4E 47', 'hostproto 应自动生成下行 HEX 帧')

	// 切到 cellular-at：隐藏 #sk-down-card，动态创建并显示 #proto-parse-only-hint
	sandbox._activeProtocol = 'cellular-at'
	sandbox.ProtocolRegistry.activatePanel('cellular-at')
	assert.equal(downCard.style.display, 'none')
	const hint = fakeDoc.getElementById('proto-parse-only-hint')
	assert.ok(hint, '纯解析协议应动态创建 #proto-parse-only-hint')
	assert.equal(hint.style.display, '')

	// 切到 cjt188：隐藏 hint，显示 #cjt188-down-card；模拟 188 立即下发写入共享预览并点击 #serial-protocol-send
	sandbox._activeProtocol = 'cjt188'
	sandbox.ProtocolRegistry.activatePanel('cjt188')
	assert.equal(hint.style.display, 'none')
	assert.equal(els['cjt188-down-card'].style.display, '')
	els['serial-protocol-down-preview'].value = 'FE FE 68 10 AA AA AA AA AA AA AA 01 03 90 1F 00 D1 16'
	els['serial-protocol-send'].click()
	assert.equal(sentHexList.length, 1)
	assert.equal(sentHexList[0], 'FE FE 68 10 AA AA AA AA AA AA AA 01 03 90 1F 00 D1 16', '非 SEK 协议写共享预览并点击立即下发必须原样发帧')

	// 切回 sek：卸载 cjt188 卡片，恢复 5 个 SEK 元素
	sandbox._activeProtocol = 'sek'
	sandbox.ProtocolRegistry.activatePanel('sek')
	assert.equal(els['cjt188-down-card'].style.display, 'none')
	assert.equal(downCard.style.display, '')
	assert.equal(downCard.dataset.mode, 'sek')
	assert.equal(els['sk-esim-card'].style.display, '')
	assert.equal(encWrap.style.display, '')
	assert.equal(errors.length, 0)
}

// ---- 9. common.js 导入/导出/重置键覆盖检查 ----
{
	const commonSrc = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
	assert.ok(commonSrc.includes("localStorage.removeItem('protocolHiddenIds')"))
	assert.ok(commonSrc.includes("localStorage.removeItem('customJsonProtocols')"))
	assert.ok(commonSrc.includes("localStorage.removeItem('customJsProtocols')"))
	assert.ok(commonSrc.includes("localStorage.removeItem('trustedJsPluginHashes')"))
	assert.ok(commonSrc.includes("protocolHiddenIds: localStorage.getItem('protocolHiddenIds')"))
	assert.ok(commonSrc.includes("customJsonProtocols: localStorage.getItem('customJsonProtocols')"))
	assert.ok(commonSrc.includes('enabled: false') && commonSrc.includes("localStorage.removeItem('trustedJsPluginHashes')"))
}

// ---- 10. batch(fn) 批量事务：结束补调 onRegistered 且清理真正移除协议的 protocolHiddenIds ----
{
	const sel = makeSelect('serial-protocol-select')
	const doc = makeDoc(sel)
	const storage = makeStorage()
	const win = { _protocols: {}, _activeProtocol: 'sek', CustomEvent: FakeCustomEvent }
	const reg = ProtocolRegistryMod.createRegistry({ window: win, document: doc, localStorage: storage, ParseView })
	const registeredLog = []
	let reconcileCount = 0
	reg.setHost({
		onRegistered: (id) => registeredLog.push(id),
		onReconcile: () => { reconcileCount++ },
	})
	reg.register('sek', { name: 'SEK', builtin: true, source: 'builtin' })
	reg.register('dir-keep', { name: 'Keep', source: 'dir-json' })
	reg.register('dir-gone', { name: 'Gone', source: 'dir-json' })
	assert.equal(reg.setHidden('dir-keep', true).ok, true)
	assert.equal(reg.setHidden('dir-gone', true).ok, true)
	registeredLog.length = 0

	reg.batch(() => {
		reg.unregister('dir-keep')
		reg.unregister('dir-gone')
		reg.register('dir-keep', { name: 'Keep v2', source: 'dir-json' })
		reg.register('dir-new', { name: 'New', source: 'dir-json' })
		reg.register('dir-temp', { name: 'Temp', source: 'dir-json' })
		reg.unregister('dir-temp')
		assert.equal(registeredLog.length, 0, '批处理期间不应提前触发 onRegistered')
		assert.equal(reconcileCount, 0, '批处理期间不应提前触发 onReconcile')
	})

	assert.equal(reconcileCount, 1)
	assert.deepEqual(registeredLog, ['dir-keep', 'dir-new'], '批结束后应对仍在注册表内的批内注册项补调 onRegistered，排除批内已删项')
	assert.equal(reg.isHidden('dir-keep'), true, '重注册回来的目录协议应保持原隐藏态')
	assert.equal(reg.isHidden('dir-gone'), false, '真正移除的目录协议应清理隐藏态')
	const persistedHidden = JSON.parse(storage.getItem('protocolHiddenIds') || '[]')
	assert.deepEqual(persistedHidden, ['dir-keep'])
}

console.log('protocol-registry: ok')
