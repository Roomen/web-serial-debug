// Run: node tests/device-panel.cjs — synthetic data only（虚构的标识与数值，不含真实设备日志）。
// 覆盖: 设备面板模型（js/device-model.js：按路 + 协议存读数、连接代次与过期、组状态、来源帧去重与上限）、
// 注册表 device 契约（js/protocol-registry.js：内置透传、外部清洗）、SEK 声明（js/sek-device.js：合成帧取值、应答认领、字节分组）、
// 请求层（js/protocol-request.js，假 serialApi：认领、超时、取消、代次变化丢弃、单双路订阅隔离）、JSON 协议的 device 声明式映射。
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const M = require('../js/device-model.js')
const Reg = require('../js/protocol-registry.js')
const Req = require('../js/protocol-request.js')
const JP = require('../js/json-protocol.js')

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

// ---------- 合成协议：AA len cmd payload sum ----------
function synthFrame(cmd, payload) {
	const body = [0xaa, payload.length + 1, cmd].concat(payload)
	let s = 0
	body.forEach((b) => { s = (s + b) & 0xff })
	return Uint8Array.from(body.concat([s]))
}
function synthProto() {
	return {
		findFrame(buf) {
			for (let i = 0; i < buf.length; i++) {
				if (buf[i] !== 0xaa || i + 1 >= buf.length) continue
				const total = buf[i + 1] + 3
				if (i + total > buf.length) return null
				return { found: true, offset: i, length: total, frame: buf.slice(i, i + total) }
			}
			return null
		},
		parseFrame(f) { return { ok: true, cmd: f[2], payload: Array.from(f.slice(3, f.length - 1)) } },
	}
}
const synthDevice = {
	title: '合成设备',
	nameKey: 'sn',
	fields: [
		{ key: 'sn', name: '序号', kind: 'text', group: 'id' },
		{ key: 'volt', name: '电压', kind: 'number', scale: 0.01, unit: 'V', decimals: 2, group: 'live' },
		{ key: 'valve', name: '阀门', kind: 'enum', options: { 0: '关', 1: '开' }, group: 'live' },
		{ key: 'cfg', name: '只能写的参数', kind: 'number' },
	],
	groups: [
		{ id: 'id', title: '标识', request: { cmd: 0x01 } },
		{ id: 'live', title: '实时', request: { cmd: 0x02 } },
	],
	readSets: { status: ['live'], all: ['id', 'live'] },
	status: [{ type: 'metric', title: '电压', key: 'volt', sub: ['valve'] }, { type: 'identity', keys: ['sn', 'nope'] }],
	categories: [{ id: 'c', title: '参数', keys: ['volt', 'cfg'] }],
	buildRequest(g) { return [0xaa, 1, g.request.cmd, (0xaa + 1 + g.request.cmd) & 0xff] },
	matchReply(g, parsed) { return parsed.cmd === (g.request.cmd | 0x80) },
	extract(parsed) {
		if (parsed.cmd === 0x81) return { sn: parsed.payload.map((b) => String.fromCharCode(b)).join('') }
		if (parsed.cmd === 0x82 && parsed.payload.length >= 3) return { volt: parsed.payload[0] | (parsed.payload[1] << 8), valve: parsed.payload[2] }
		return null
	},
}

// ---------- 1. 模型 ----------
test('model: 按路 + 协议各存一份，代次变化后过期', () => {
	const dev = Reg.normalizeDevice(synthDevice, { id: 't' })
	const store = M.createStore()
	const p = synthProto()
	const fA = synthFrame(0x82, [0x69, 0x01, 1])
	const r = M.ingest(store, { sid: 'A', pid: 't', gen: 3, at: 1000, bytes: fA, parsed: p.parseFrame(fA), device: dev })
	assert.ok(r)
	assert.deepEqual(r.keys.sort(), ['valve', 'volt'])
	assert.deepEqual(r.groups, ['live'])
	const LA = M.lane(store, 'A', 't')
	const LB = M.lane(store, 'B', 't')
	assert.equal(M.reading(LA, 'volt').raw, 361)
	assert.equal(M.reading(LB, 'volt'), null, 'A 路读数不能出现在 B 路')
	assert.equal(M.formatValue(dev, 'volt', 361, M.getter(LA)), '3.61 V')
	assert.equal(M.formatValue(dev, 'valve', 1, M.getter(LA)), '开')
	assert.equal(M.isStale(M.reading(LA, 'volt'), 3), false)
	assert.equal(M.isStale(M.reading(LA, 'volt'), 4), true, '代次变了就过期')
	assert.equal(M.anyStale(LA, 4), true)
	assert.equal(M.groupView(LA, 'live', 3).state, 'ok')
	assert.equal(M.groupView(LA, 'live', 4).state, 'stale')
	assert.equal(M.groupView(LA, 'id', 3).state, 'unread')
	const rec = M.findFrame(LA, M.reading(LA, 'volt').rec)
	assert.equal(rec.sid, 'A')
	assert.equal(rec.gen, 3)
	assert.equal(rec.hex, Array.from(fA).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '))
	// 收帧泵是唯一入账入口：同一内容的帧再到一次就是新的一帧，照记（不按内容去重，否则相同应答的第二次读取认领不到）
	const r2 = M.ingest(store, { sid: 'A', pid: 't', gen: 3, at: 1500, bytes: fA, parsed: p.parseFrame(fA), device: dev })
	assert.equal(LA.frames.length, 2)
	assert.notEqual(r2.rec.id, r.rec.id)
	// 换协议是另一份
	assert.equal(M.reading(M.lane(store, 'A', 'other'), 'volt'), null)
})

test('model: 组认领要求确实取到该组字段；format 取值器只给同代次读数', () => {
	const dev = Reg.normalizeDevice(synthDevice, { id: 't' })
	const store = M.createStore()
	const p = synthProto()
	// 协议认为是 live 组的应答，但载荷不够、extract 什么也没取到：不算认领
	const short = synthFrame(0x82, [])
	assert.equal(M.ingest(store, { sid: 'S', pid: 't', gen: 1, at: 1, bytes: short, parsed: p.parseFrame(short), device: dev }), null)
	assert.equal(M.groupView(M.lane(store, 'S', 't'), 'live', 1).state, 'unread')
	const L = M.lane(store, 'S', 't')
	const f1 = synthFrame(0x82, [1, 0, 1])
	M.ingest(store, { sid: 'S', pid: 't', gen: 1, at: 10, bytes: f1, parsed: p.parseFrame(f1), device: dev })
	const fsn = synthFrame(0x81, [0x41])
	M.ingest(store, { sid: 'S', pid: 't', gen: 2, at: 20, bytes: fsn, parsed: p.parseFrame(fsn), device: dev })
	assert.equal(M.getter(L, 2)('volt'), undefined, '上一连接（代次 1）的读数不给代次 2 的换算用')
	assert.equal(M.getter(L, 1)('volt'), 1)
	assert.equal(M.getter(L, 2)('sn'), 'A')
})

test('model: 欠账按连接代次保守保留，无关同组应答不清，换代次才清', () => {
	const dev = Reg.normalizeDevice(synthDevice, { id: 't' })
	const store = M.createStore()
	const L = M.lane(store, 'S', 't')
	const p = synthProto()
	M.markLate(L, 'live', 1)
	assert.equal(M.isLate(L, 'live', 1), true)
	// 被动收到一条同组应答（可能是无关的上报）：不抵消
	const f = synthFrame(0x82, [1, 0, 1])
	M.ingest(store, { sid: 'S', pid: 't', gen: 1, at: 10, bytes: f, parsed: p.parseFrame(f), device: dev })
	M.ingest(store, { sid: 'S', pid: 't', gen: 1, at: 20, bytes: f, parsed: p.parseFrame(f), device: dev })
	assert.equal(M.isLate(L, 'live', 1), true, '同组匹配证明不了是那条迟到应答，欠账保留')
	assert.equal(M.isLate(L, 'id', 1), false, '别的组不受影响')
	// 连接代次变化（断开 / 重连 / 换口）才清
	assert.equal(M.isLate(L, 'live', 2), false)
	M.markLate(L, 'live', 2)
	assert.equal(M.isLate(L, 'live', 2), true)
	assert.equal(M.isLate(L, 'live', 1), false)
	assert.equal(typeof M.settleLate, 'undefined', '没有按被动应答抵消的接口')
})

test('unsure: 同一块「认领帧 → 同组帧」时标记落在被认领的那条，字段按实际来源显示', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	// 0x82 三字节载荷给 volt + valve，两字节载荷只给 volt（同组的另一种上报）
	const dev = Reg.normalizeDevice(Object.assign({}, synthDevice, {
		extract(parsed) {
			if (parsed.cmd === 0x82 && parsed.payload.length >= 3) return { volt: parsed.payload[0], valve: parsed.payload[2] }
			if (parsed.cmd === 0x82 && parsed.payload.length === 2) return { volt: parsed.payload[0] }
			return null
		},
	}), { id: 't' })
	const store = M.createStore()
	const L = M.lane(store, 'S', 't')
	const pump = R.createPump('S', {
		accept: () => true,
		onFrame(item) { item.res = M.ingest(store, { sid: 'S', pid: item.pid, gen: item.gen, at: item.at, bytes: item.frame, parsed: item.parsed, device: dev }) },
	})
	M.markLate(L, 'live', 1)
	const flow = R.begin('S', { source: pump.source, position: pump.position })
	const p = flow.request({
		build: dev.buildRequest(dev.groups[1]),
		match: (parsed, frame, item) => !!(item && item.res && item.res.groups.indexOf('live') >= 0),
		timeoutMs: 1000,
	})
	await flush()
	const claimed = synthFrame(0x82, [0x10, 0, 1])
	const later = synthFrame(0x82, [0x20, 0])
	F.advance(5) // 假时钟从 0 起，组状态把 at=0 当成未读
	F.rx('S', [...claimed, ...later])
	const res = await p
	flow.end()
	// 面板做法：标在 res.item.res.rec.id，不是该组最新的 g.rec
	assert.equal(M.isLate(L, 'live', 1), true)
	const recId = res.item.res.rec.id
	M.markRecUnsure(L, recId, '归属未确认')
	assert.deepEqual(Array.from(res.frame), Array.from(claimed))
	assert.notEqual(L.groups.live.rec, recId, '同组最新记录是后到的那帧')
	assert.equal(M.recUnsure(L, recId), '归属未确认', '标记跟随被认领的记录')
	assert.equal(M.recUnsure(L, L.groups.live.rec), null, '后到的帧不继承标记')
	assert.equal(M.readingUnsure(L, 'valve'), '归属未确认', 'valve 取自被认领的记录：未确认')
	assert.equal(M.readingUnsure(L, 'volt'), null, 'volt 已被后到的帧更新：按它自己的来源显示')
	assert.equal(M.reading(L, 'volt').raw, 0x20)
	assert.equal(M.groupView(L, 'live', 1).unsure, null, '组状态按该组最新记录')
	pump.stop()
})

test('model: 组状态 busy / error，读不到的字段与搜索', () => {
	const dev = Reg.normalizeDevice(synthDevice, { id: 't' })
	const store = M.createStore()
	const L = M.lane(store, 'S', 't')
	M.setGroupBusy(L, 'id', true)
	assert.equal(M.groupView(L, 'id', 1).state, 'busy')
	M.setGroupError(L, 'id', '等待应答超时', 1, 2000)
	const gv = M.groupView(L, 'id', 1)
	assert.equal(gv.state, 'error')
	assert.match(gv.error, /超时/)
	assert.equal(M.readable(dev, 'volt'), true)
	assert.equal(M.readable(dev, 'cfg'), false, '没有组的字段标成读不到')
	assert.deepEqual(M.searchFields(dev, '电压'), ['volt'])
})

test('model: 来源帧缓存有上限', () => {
	const dev = Reg.normalizeDevice(synthDevice, { id: 't' })
	const store = M.createStore()
	const p = synthProto()
	for (let i = 0; i < 120; i++) {
		const f = synthFrame(0x82, [i, 0, i & 1])
		M.ingest(store, { sid: 'S', pid: 't', gen: 1, at: i * 3000, bytes: f, parsed: p.parseFrame(f), device: dev })
	}
	const L = M.lane(store, 'S', 't')
	assert.ok(L.frames.length <= 48)
	assert.ok(M.findFrame(L, M.reading(L, 'volt').rec), '当前读数引用的帧保留')
})

test('model: 设备时间偏差与估算、日历位图', () => {
	const r = { raw: '2026-01-02 03:04:05', at: new Date(2026, 0, 2, 3, 4, 15).getTime(), gen: 1 }
	const info = M.deviceTimeInfo(r)
	assert.equal(info.driftSec, -10)
	assert.equal(M.estimateDeviceNow(info, r.at + 60000) - info.deviceMs, 60000)
	const cells = M.dayCells({ days: 31, firstBit: 1, setMeans: 'bad' }, 0b100, 5)
	assert.equal(cells[1].state, 'bad', 'bit2 = 2 号置位，setMeans=bad')
	assert.equal(cells[0].state, 'ok')
	assert.equal(cells[5].state, 'future')
})

// ---------- 2. 注册表 ----------
function makeRegistry() {
	const doc = { getElementById() { return null }, dispatchEvent() {}, addEventListener() {} }
	const store = {}
	const storage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v) }, removeItem: (k) => { delete store[k] } }
	return Reg.createRegistry({ window: { _protocols: {}, _activeProtocol: 'sek' }, document: doc, localStorage: storage })
}

test('registry: 内置协议 device 透传为规范化对象', () => {
	const reg = makeRegistry()
	reg.register('wmbus', Object.assign({ name: 'W', builtin: true, parseFrame: () => ({}) }, { device: synthDevice }))
	const e = reg.get('wmbus')
	assert.ok(e.device)
	assert.equal(e.device.title, '合成设备')
	assert.deepEqual(e.device.readSets, { status: ['live'], all: ['id', 'live'] })
	assert.deepEqual(e.device.status[1].keys, ['sn'], '未声明的 key 被丢掉')
	assert.equal(e.device.status[0].group, 'live', '部件的组由首个字段推出')
	assert.deepEqual(Array.from(e.device.buildRequest(e.device.groups[0])), [0xaa, 1, 1, 0xac])
	assert.equal(reg.list({ includeHidden: true }).find((x) => x.id === 'wmbus').capabilities.device, true)
	const plain = makeRegistry()
	plain.register('gz', { name: 'G', builtin: true, parseFrame: () => ({}) })
	assert.equal(plain.get('gz').device, null)
})

test('registry: 外部协议 device 只留约定的数据与函数', () => {
	const reg = makeRegistry()
	const opts = { '0': '关', '1': '开' }
	Object.defineProperty(opts, '__proto__', { value: 'x', enumerable: true })
	let toStringCalled = false
	const sneaky = { toString() { toStringCalled = true; return 'x' } }
	const evil = {
		title: '<img src=x onerror=alert(1)>',
		fields: [
			{ key: 'a', name: 'A', kind: 'weird', group: 'g', options: opts, secret: true, write: { min: 0, max: 10, options: opts, confirm: '先确认', junk: () => 1 }, onRender: () => 1 },
			{ key: 'b', name: sneaky, group: 'missing' },
		],
		groups: [{ id: 'g', title: 'G', request: { cmd: 1, fn: () => 1, nested: { deep: { deeper: { deepest: { x: 1 } } } } } }],
		status: [{ type: 'script', key: 'a' }, { type: 'metric', key: 'nope' }, { type: 'kv', keys: ['a', 'b'] }],
		categories: [{ id: 'c', title: 'C', keys: ['a', 'zz'] }],
		extract() { return { a: sneaky, b: [1, 'two', { o: 1 }], c: 5 } },
		format(k) { return k === 'a' ? sneaky : null },
		buildRequest() { return [1, 2, 300] },
		matchReply() { return 'yes' },
		buildWrite() { throw new Error('编码错误') },
		matchWriteReply() { throw new Error('匹配错误') },
		parseInput() { throw new Error('转换错误') },
		html: '<b>x</b>',
	}
	reg.register('ext-dev', { name: 'Ext', source: 'js-local', parseFrame: () => ({}), device: evil })
	const d = reg.get('ext-dev').device
	assert.ok(d)
	assert.equal(d.html, undefined)
	assert.equal(typeof d.title, 'string', '文本只是字符串，渲染一律 textContent')
	assert.deepEqual(d.fields.map((f) => f.key), ['a', 'b'])
	assert.equal(d.fields[0].kind, 'text', '未知类型退回 text')
	assert.equal(d.fields[0].onRender, undefined)
	assert.equal(Object.getPrototypeOf(d.fields[0].options), null, '键表无原型')
	assert.equal(Object.prototype.hasOwnProperty.call(d.fields[0].options, '__proto__'), false, '__proto__ 不进键表')
	assert.deepEqual(Object.keys(d.fields[0].write).sort(), ['allowEmpty', 'confirm', 'hint', 'max', 'maxLen', 'min', 'options', 'pattern', 'step'])
	assert.equal(d.fields[0].secret, true)
	assert.equal(d.fields[0].write.confirm, '先确认')
	assert.equal(Object.getPrototypeOf(d.fields[0].write.options), null)
	assert.equal(Object.hasOwn(d.fields[0].write.options, '__proto__'), false)
	assert.throws(() => d.buildWrite(d.fields[0], 1), /编码错误/)
	assert.equal(d.matchWriteReply(d.fields[0], {}), null)
	assert.equal(d.parseInput(d.fields[0], '1'), undefined)
	assert.equal(d.fields[1].group, null, '指向不存在的组时清掉')
	assert.equal(d.fields[1].name, 'b', '非字符串名称不调用 toString，退回 key')
	assert.notEqual(typeof d.groups[0].request.fn, 'function', '请求描述里的函数被丢掉')
	assert.deepEqual(d.status.map((w) => w.type), ['kv'])
	assert.deepEqual(d.categories[0].keys, ['a'])
	const vals = d.extract({})
	assert.equal(vals, null, '对象值、含对象的数组整项拒绝；未声明的 key 不收')
	assert.equal(d.format('a', 1, () => null), null, 'format 返回非字符串按无格式处理')
	assert.equal(toStringCalled, false, '任何地方都没有调用协议给的对象的 toString')
	assert.equal(d.matchReply(d.groups[0], {}, null), false, '只认 === true')
	assert.throws(() => d.buildRequest(d.groups[0]), /请求帧/)
})

test('registry: 预算超限与特殊键明确拒绝，不静默裁剪', () => {
	const base = () => ({ fields: [{ key: 'a', group: 'g' }], groups: [{ id: 'g' }], buildRequest: () => [1], matchReply: () => true, extract: () => ({}) })
	const errs = []
	const big = base()
	big.fields = Array.from({ length: 600 }, (_, i) => ({ key: 'k' + i }))
	assert.equal(Reg.normalizeDevice(big, { id: 'x', errors: errs }), null)
	assert.match(errs.join(), /fields 超过 512/)
	const huge = base()
	huge.groups[0].request = { blob: Array.from({ length: 30000 }, () => 1) }
	const e2 = []
	assert.equal(Reg.normalizeDevice(huge, { id: 'x', errors: e2 }), null)
	assert.match(e2.join(), /节点|数组过长/)
	const longText = base()
	longText.groups[0].request = { t: 'x'.repeat(600 * 1024) }
	const e3 = []
	assert.equal(Reg.normalizeDevice(longText, { id: 'x', errors: e3 }), null)
	assert.match(e3.join(), /文本总长/)
	const cyc = base()
	cyc.groups[0].request = {}
	cyc.groups[0].request.self = cyc.groups[0].request
	const e4 = []
	assert.equal(Reg.normalizeDevice(cyc, { id: 'x', errors: e4 }), null)
	assert.match(e4.join(), /循环/)
	for (const bad of ['__proto__', 'constructor', 'prototype']) {
		const d = base()
		d.fields.push({ key: bad })
		const e = []
		assert.equal(Reg.normalizeDevice(d, { id: 'x', errors: e }), null, bad + ' 作字段 key 被拒绝')
		assert.match(e.join(), /key 非法/)
	}
	const opt = base()
	opt.fields[0].options = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [String(i), 'v']))
	assert.equal(Reg.normalizeDevice(opt, { id: 'x' }), null, 'options 超限拒绝')
	const req = base()
	req.buildRequest = () => new Array(5000).fill(0)
	assert.throws(() => Reg.normalizeDevice(req, { id: 'x' }).buildRequest({ id: 'g', title: 'g' }), /4096/)
	const many = base()
	many.extract = () => Object.fromEntries(Array.from({ length: 600 }, (_, i) => ['a' + i, 1]).concat([['a', 1]]))
	assert.equal(Reg.normalizeDevice(many, { id: 'x' }).extract({}), null, 'extract 结果项数超限整帧丢弃')
	const okd = Reg.normalizeDevice(base(), { id: 'x' })
	assert.equal(Object.getPrototypeOf(okd.fieldMap), null)
	const ex = Reg.normalizeDevice(Object.assign(base(), { extract: () => ({ a: [1, 2, 3] }) }), { id: 'x' }).extract({})
	assert.equal(Object.getPrototypeOf(ex), null)
	assert.deepEqual(ex.a, [1, 2, 3])
})

test('registry: 共用同一张枚举表的两个字段不算循环，按复制次数计预算', () => {
	const shared = { '0': '关', '1': '开' }
	const d = Reg.normalizeDevice({
		fields: [{ key: 'a', group: 'g', options: shared }, { key: 'b', group: 'g', options: shared }],
		groups: [{ id: 'g' }], buildRequest: () => [1], matchReply: () => true, extract: () => ({}),
	}, { id: 'x' })
	assert.ok(d, '共享的合法对象被接受')
	assert.equal(d.fieldMap.b.options['1'], '开')
	assert.notEqual(d.fieldMap.a.options, d.fieldMap.b.options, '各自复制一份')
	// 共享引用每处都算：同一个大对象被引用多次，按实际复制次数超出节点预算
	const big = { list: Array.from({ length: 6000 }, () => 1) }
	const e = []
	assert.equal(Reg.normalizeDevice({
		fields: [{ key: 'a', group: 'g' }],
		groups: [{ id: 'g', request: big }, { id: 'h', request: big }, { id: 'i', request: big }, { id: 'j', request: big }],
		buildRequest: () => [1], matchReply: () => true, extract: () => ({}),
	}, { id: 'x', errors: e }), null)
	assert.match(e.join(), /节点超过/)
	// 真正的循环仍然拒绝
	const cyc = { a: {} }
	cyc.a.b = cyc
	const e2 = []
	assert.equal(Reg.normalizeDevice({ fields: [{ key: 'a' }], groups: [{ id: 'g', request: cyc }], extract: () => ({}) }, { id: 'x', errors: e2 }), null)
	assert.match(e2.join(), /循环/)
})

test('registry: 缺 extract 的声明整份拒绝并说明原因', () => {
	const e = []
	assert.equal(Reg.normalizeDevice({ fields: [{ key: 'a', group: 'g' }], groups: [{ id: 'g' }], buildRequest: () => [1], matchReply: () => true }, { id: 'x', errors: e }), null)
	assert.match(e.join(), /缺少 extract/)
	const reg = makeRegistry()
	reg.register('noext', { name: 'N', source: 'js-local', parseFrame: () => ({}), device: { fields: [{ key: 'a' }], groups: [{ id: 'g' }], buildRequest: () => [1], matchReply: () => true } })
	assert.equal(reg.get('noext').device, null, '没有面板，不会出现可查询的空面板')
})

test('registry: 只给取值没给查询的声明是纯被动面板', () => {
	const pas = Reg.normalizeDevice({ fields: [{ key: 'a', group: 'g' }], groups: [{ id: 'g' }], extract: () => ({ a: 1 }) }, { id: 'p' })
	assert.ok(pas)
	assert.equal(pas.queryable, false)
	assert.equal(pas.buildRequest, null)
	assert.equal(pas.matchReply, null)
	assert.equal(M.queryable(pas), false)
	assert.equal(M.readable(pas, 'a'), false, '被动面板不提供读取')
	const half = Reg.normalizeDevice({ fields: [{ key: 'a', group: 'g' }], groups: [{ id: 'g' }], buildRequest: () => [1], extract: () => ({ a: 1 }) }, { id: 'h' })
	assert.equal(half.queryable, false, '有组帧没有应答认领：也不能查询（否则任意帧都会被当成应答）')
	assert.equal(half.buildRequest, null)
})

// ---------- 3. SEK 声明 ----------
function loadSek() {
	const sb = { console, BigInt, Math, Number, String, Array, Object, Date, JSON, Uint8Array, parseInt, isNaN, TextDecoder, TextEncoder }
	sb.window = sb
	sb.globalThis = sb
	sb.serialApi = { onReceive() {}, getEncKey: () => null }
	sb.ProtocolDownlink = require('../js/protocol-downlink.js')
	for (const f of ['js/protocol-schema.js', 'js/protocol-crypto.js', 'js/protocol.js', 'js/protocol-presets.js', 'js/sek-device.js', 'js/sek-transaction.js']) {
		vm.runInNewContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f })
	}
	return sb
}
// 合成 SEK 上行帧：24 字节头 + 明文长度 + TLV + CRC16 + 0x16（数据全为虚构）
function sekUp(W, fc, tlv) {
	const t = []
	for (const [tag, items] of tlv) {
		const p = []
		for (const [id, bytes] of items) p.push(id, ...bytes)
		t.push(tag, p.length & 255, p.length >> 8, ...p)
	}
	const data = [t.length & 255, t.length >> 8, ...t]
	const h = [0xA9, 0x9A, 1, 0, 2, 1, 0x10, 0x34, 0x12, 0, 0, 2, 0x83, 0, 0xA4, 0xFF, 8, 0, 0, 21, fc, 0, data.length & 255, data.length >> 8, ...data]
	const crc = W.skCrc16(new Uint8Array(h))
	h.push(crc & 255, crc >> 8, 0x16)
	return h
}
const ascii = (s) => Array.from(Buffer.from(s, 'ascii'))

test('sek: 组与查询 ID 从 SK_TAGS 派生，合成帧取值与格式化', () => {
	const W = loadSek()
	const dev = Reg.normalizeDevice(W.SekDevice, { id: 'sek' })
	assert.ok(dev)
	const q = {}
	dev.groups.forEach((g) => { q[g.id] = Object.assign({}, g.request) })
	assert.deepEqual(q.base, { tag: 1, query: 1 })
	assert.deepEqual(q.uplink, { tag: 92, query: 8 })
	assert.deepEqual(q.run, { tag: 91, query: 7 })
	assert.deepEqual(q.valve, { tag: 36, query: 15 })
	assert.deepEqual(q.ultra, { tag: 30, query: 30 })
	assert.deepEqual(q.cam, { tag: 32, query: 10 })
	assert.deepEqual(q.bus, { tag: 33, query: 11 })
	assert.deepEqual(q.mag, { tag: 34, query: 34 })
	assert.deepEqual(q.lora, { tag: 35, query: 35 })
	assert.deepEqual(q.auth, { tag: 38, query: 22 })
	assert.deepEqual(q.leak, { tag: 64, query: 19 })
	assert.equal(dev.groups.length, 15, '5 个状态组 + 10 个可查询参数组')
	assert.equal(dev.categories.length, 11, '按协议 Tag 划分为 11 个参数分类')
	assert.deepEqual(dev.categories.map((c) => c.id), ['tag3', 'tag30', 'tag32', 'tag33', 'tag34', 'tag35', 'tag36', 'tag37', 'tag38', 'tag39', 'tag64'], '参数分类直接按协议 Tag 升序排列')
	dev.categories.forEach((cat) => {
		const tagNum = Number(cat.id.replace(/^tag/, ''))
		assert.ok(cat.title.startsWith('Tag ' + tagNum), '分类标题应带 Tag 编号: ' + cat.title)
		const ids = cat.keys.map((k) => {
			const [t, id] = k.split(':').map(Number)
			assert.equal(t, tagNum, '分类 ' + cat.id + ' 仅含本 Tag 字段')
			return id
		})
		const sorted = ids.slice().sort((a, b) => a - b)
		assert.deepEqual(ids, sorted, '分类 ' + cat.id + ' 内字段按 ID 升序排列')
	})
	const allCatKeys = dev.categories.flatMap((c) => c.keys)
	assert.equal(allCatKeys.length, 141, '覆盖全部 141 个 0x01 参数预设')
	assert.equal(new Set(allCatKeys).size, 141, '各分类之间无重复字段')
	assert.equal(dev.status.find((w) => w.key === '2:12').optional, true, '阀门卡片标为 optional')
	assert.equal(dev.status.find((w) => w.key === '2:9').optional, false, '核心卡片默认非 optional')
	assert.equal(dev.fieldMap['1:0'].name, W.SK_TAGS['1'].find((d) => d.id === 0).name, '名称来自 SK_TAGS')
	assert.equal(M.readable(dev, '39:3'), false, '没有查询的 Tag 标成读不到')
	assert.equal(M.readable(dev, '34:2'), true, 'Tag34 接入 mag 查询组')
	assert.equal(M.readable(dev, '30:8'), true, 'Tag30 接入 ultra 查询组')
	assert.equal(M.readable(dev, '64:1'), true, 'Tag64 接入 leak 查询组')
	const f = sekUp(W, 0x83, [
		[2, [[9, [0x87, 0xD6, 0x12, 0]], [29, [3]], [10, [0x69, 1]], [12, [1]]]],
		[1, [[6, [0x20, 0x26, 0x01, 0x02, 0x03, 0x04, 0x05]], [0, ascii('000000000000001')]]],
		[4, [[1, [1, 0x20, 0x26, 0x01, 0x02, 0x08, 0x12, 0x00]], [0, [0, 0, 0, 0, 0, 0, 0, 0]]]],
		[92, [[7, [0xa4, 0xff]]]],
	])
	const parsed = W.skParseFrame(f, {})
	assert.equal(parsed.ok, true)
	const vals = dev.extract(parsed, f)
	assert.equal(vals['2:9'], 1234567)
	assert.equal(vals['1:0'], '000000000000001')
	assert.equal(vals['1:6'], '2026-01-02 03:04:05')
	assert.deepEqual(vals['4:0'], [false, ''])
	assert.equal(vals['4:1'][0], true)
	assert.equal(vals['92:7'], -92)
	const get = (k) => vals[k]
	assert.equal(M.formatValue(dev, '2:9', vals['2:9'], get), '1234.567 m³', '累计流量按读到的基准水量换算')
	assert.equal(M.formatValue(dev, '2:9', vals['2:9'], () => undefined), '1234567 圈（未读基准水量）')
	assert.equal(M.formatValue(dev, '2:10', vals['2:10'], get), '3.61 V')
	assert.equal(M.formatValue(dev, '92:7', -92, get), '-92 dBm')
	assert.equal(dev.matchReply(dev.groups.find((g) => g.id === 'core'), parsed, f), true)
	assert.equal(dev.matchReply(dev.groups.find((g) => g.id === 'param'), parsed, f), false)
	const grp = dev.byteGroups(parsed, '2:9')
	assert.equal(grp.length, 1)
	assert.match(grp[0], /^t2i9o\d+$/)
	const idx = M.highlightIndices(W.skByteMap(parsed), grp)
	assert.equal(idx.length, 5, 'ID + 4 字节值')
	assert.deepEqual(idx.map((i) => f[i]), [9, 0x87, 0xD6, 0x12, 0])
})

test('sek: 重连后的累计流量不沿用上一连接的基准水量', () => {
	const W = loadSek()
	const dev = Reg.normalizeDevice(W.SekDevice, { id: 'sek' })
	const store = M.createStore()
	const ing = (gen, f) => M.ingest(store, { sid: 'S', pid: 'sek', gen, at: gen * 1000, bytes: f, parsed: W.skParseFrame(f, {}), device: dev })
	ing(1, sekUp(W, 0x83, [[2, [[29, [3]]]]])) // 代次 1：基准水量 1 L/圈
	ing(2, sekUp(W, 0x83, [[2, [[9, [0x87, 0xD6, 0x12, 0]]]]])) // 代次 2：只读到圈数
	const L = M.lane(store, 'S', 'sek')
	const r = M.reading(L, '2:9')
	assert.equal(M.formatValue(dev, '2:9', r.raw, M.getter(L, r.gen)), '1234567 圈（未读基准水量）')
	ing(2, sekUp(W, 0x83, [[2, [[29, [3]]]]]))
	assert.equal(M.formatValue(dev, '2:9', r.raw, M.getter(L, r.gen)), '1234.567 m³', '同一连接读到基准后才换算')
})

test('sek: 下行结果帧与查询帧不当成取值来源', () => {
	const W = loadSek()
	const dev = Reg.normalizeDevice(W.SekDevice, { id: 'sek' })
	const ack = sekUp(W, 0x81, [[2, [[9, [0x87, 0xD6, 0x12, 0]]]]])
	assert.equal(dev.extract(W.skParseFrame(ack, {}), ack), null)
	const req = dev.buildRequest(dev.groups.find((g) => g.id === 'core'), {})
	assert.ok(req instanceof Uint8Array && req.length > 24)
	const pr = W.skParseFrame(Array.from(req), {})
	assert.equal(pr.ok, true)
	assert.equal(dev.extract(pr, req), null)
	assert.equal(pr.tlv[0].tag, 10)
	assert.equal(pr.tlv[0].items[0].id, 2)
})

// ---------- 4. 请求层 ----------
function fakeEnv(opts) {
	opts = opts || {}
	const listeners = []
	const docListeners = {}
	const timers = []
	let now = 0
	const state = { gen: { S: 1, A: 1, B: 1 }, open: { S: true, A: true, B: true }, mode: opts.mode || 'single', pinned: null, writes: [], proto: { S: 't', A: 't', B: 't' } }
	const entries = { t: synthProto() }
	const reg = { get: (id) => entries[id] || null }
	let txc = { S: 0, A: 0, B: 0 }
	let writeGate = null
	const api = {
		sessionGeneration: (sid) => state.gen[sid],
		isSessionOpen: (sid) => state.open[sid],
		getMode: () => state.mode,
		isPinned: () => state.pinned != null,
		pinSession: (sid) => { state.pinned = sid },
		unpinSession: () => { state.pinned = null },
		getParseOpts: () => ({}),
		onReceiveFrom: (sid, cb) => { const l = { sid, cb }; listeners.push(l); return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1) } },
		txCount: opts.noTx ? undefined : (sid) => txc[sid],
		writeRawTo: (sid, bytes) => {
			txc[sid]++
			state.writes.push({ sid, bytes: Array.from(bytes) })
			if (opts.onWrite) opts.onWrite(sid, bytes)
			if (writeGate) return writeGate.promise
			return Promise.resolve({})
		},
	}
	const lanes = { protocolOf: (sid) => state.proto[sid] }
	const doc = {
		addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn) },
		removeEventListener: (t, fn) => { const a = docListeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) },
	}
	// 与 serialApi 单路一致：单路时 onReceiveFrom 不按 sid 过滤，收到的都交给所有订阅者
	function rx(sid, bytes) {
		listeners.slice().forEach((l) => { if (state.mode === 'single' || l.sid === sid) l.cb(Uint8Array.from(bytes)) })
	}
	function session(sid, s) {
		state.gen[sid]++
		;(docListeners['serial-session'] || []).slice().forEach((fn) => fn({ detail: { sid, state: s, generation: state.gen[sid] } }))
	}
	const env = {
		serialApi: api, serialLanes: lanes, registry: reg, document: doc,
		setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t },
		clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) },
		now: () => now,
	}
	function advance(ms) {
		now += ms
		timers.filter((t) => t.at <= now).forEach((t) => { const i = timers.indexOf(t); if (i >= 0) { timers.splice(i, 1); t.fn() } })
	}
	// 手动发送等其它写入路径：只计数，不经请求层
	function foreignWrite(sid) { txc[sid]++ }
	// 让下一次写入挂起，直到 release(ok)
	function holdWrites() {
		let res, rej
		writeGate = { promise: new Promise((a, b) => { res = a; rej = b }) }
		return { release: (ok) => { const g = writeGate; writeGate = null; ok === false ? rej(new Error('断线')) : res({}) ; return g } }
	}
	function emit(type, detail) {
		;(docListeners[type] || []).slice().forEach((fn) => fn({ detail }))
	}
	return { env, state, rx, session, advance, listeners, entries, foreignWrite, holdWrites, emit, docListeners }
}
const flush = () => new Promise((r) => setImmediate(r))

test('request: 认领应答、跳过不相干的帧、结束时解锁', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	const flow = R.begin('S')
	assert.equal(F.state.pinned, 'S')
	const p = flow.request({ build: () => [0xaa, 1, 2, 0xad], match: (parsed) => parsed.cmd === 0x82, timeoutMs: 1000 })
	await flush()
	assert.deepEqual(F.state.writes[0], { sid: 'S', bytes: [0xaa, 1, 2, 0xad] })
	const other = synthFrame(0x90, [1])
	const ans = synthFrame(0x82, [1, 2, 3])
	F.rx('S', [0x00, ...other, ...ans.slice(0, 3)])
	F.rx('S', ans.slice(3))
	const res = await p
	assert.deepEqual(Array.from(res.frame), Array.from(ans))
	assert.equal(res.gen, 1)
	assert.equal(F.listeners.length, 0, '完成后退订')
	flow.end()
	assert.equal(F.state.pinned, null)
})

test('request: 超时、取消、关闭与忙', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	const flow = R.begin('S')
	const p = flow.request({ build: [1], match: () => true, timeoutMs: 500 })
	await flush()
	F.advance(500)
	await assert.rejects(p, (e) => e.code === 'timeout')
	const p2 = flow.request({ build: [1], match: () => true, timeoutMs: 500 })
	await flush()
	flow.cancel('用户取消')
	await assert.rejects(p2, (e) => e.code === 'cancelled')
	await assert.rejects(flow.request({ build: [1] }), (e) => e.code === 'cancelled', '取消后不再发送')
	assert.equal(F.state.writes.length, 2)
	flow.end()
	F.state.open.S = false
	assert.throws(() => R.begin('S'), (e) => e.code === 'closed')
	F.state.open.S = true
	F.state.pinned = 'B'
	assert.throws(() => R.begin('S'), (e) => e.code === 'busy')
})

test('request: 连接代次变化后不再发送，迟到的应答丢弃', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	const flow = R.begin('S')
	const p = flow.request({ build: [1], match: () => true, timeoutMs: 1000 })
	await flush()
	F.session('S', 'disconnected')
	await assert.rejects(p, (e) => e.code === 'generation')
	F.rx('S', synthFrame(0x82, [1]))
	assert.equal(flow.check().code, 'generation')
	await assert.rejects(flow.request({ build: [1] }), (e) => e.code === 'generation')
	assert.equal(F.state.writes.length, 1, '代次变了之后一帧都不发')
	flow.end()
	// 换协议同样中止
	const flow2 = R.begin('S')
	F.state.proto.S = 'x'
	await assert.rejects(flow2.request({ build: [1] }), (e) => e.code === 'protocol')
	flow2.end()
})

test('request: 双路只收本路，单路不收 A/B', async () => {
	const F = fakeEnv({ mode: 'dual' })
	const R = Req.create(F.env)
	const got = { S: 0, A: 0, B: 0 }
	;['S', 'A', 'B'].forEach((sid) => R.subscribeLane(sid, () => { got[sid]++ }))
	F.rx('A', [1])
	assert.deepEqual(got, { S: 0, A: 1, B: 0 })
	F.state.mode = 'single'
	F.rx('S', [1])
	assert.deepEqual(got, { S: 1, A: 1, B: 0 }, '单路时 serialApi 不按 sid 过滤，这里挡掉 A/B')
	const flowB = (F.state.mode = 'dual', R.begin('B'))
	const pB = flowB.request({ build: [1], match: () => true, timeoutMs: 1000 })
	await flush()
	F.rx('A', synthFrame(0x82, [1]))
	let settled = false
	pB.then(() => { settled = true }, () => { settled = true })
	await flush()
	assert.equal(settled, false, 'A 路的帧不能认领 B 路的请求')
	F.rx('B', synthFrame(0x82, [2]))
	const res = await pB
	assert.equal(res.sid, 'B')
	flowB.end()
})

test('request: 等待中切协议立即失败，之后到达的匹配帧不算成功（首组与末组）', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	// 首组：发出后切协议 id
	let flow = R.begin('S')
	let p = flow.request({ build: [1], match: () => true, timeoutMs: 5000 })
	await flush()
	F.state.proto.S = 'x'
	F.advance(200)
	await assert.rejects(p, (e) => e.code === 'protocol' && e.sent === true)
	F.rx('S', synthFrame(0x82, [1, 2, 3]))
	flow.end()
	// 末组：第一组成功，第二组等待中同 id 协议被重新注册（注册表条目换了）
	F.state.proto.S = 't'
	flow = R.begin('S')
	p = flow.request({ build: [1], match: () => true, timeoutMs: 5000 })
	await flush()
	F.rx('S', synthFrame(0x82, [1, 2, 3]))
	await p
	const p2 = flow.request({ build: [2], match: () => true, timeoutMs: 5000 })
	await flush()
	F.entries.t = synthProto()
	// 匹配帧在定时重查之前就到了：认领前的检查同样拦下
	F.rx('S', synthFrame(0x82, [4, 5, 6]))
	await assert.rejects(p2, (e) => e.code === 'protocol')
	await assert.rejects(flow.request({ build: [3] }), (e) => e.code === 'protocol' && e.sent === false)
	assert.equal(F.state.writes.length, 3, '协议换了之后不再发送')
	flow.end()
})

test('request: 取消发生在写入之前不发送；已发送的失败标明结果未知', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	const flow = R.begin('S')
	const p = flow.request({ build: [1], match: () => true, timeoutMs: 1000 })
	flow.cancel('用户取消') // 写入排在微任务里，还没开始
	await assert.rejects(p, (e) => e.code === 'cancelled' && e.sent === false)
	await flush()
	assert.equal(F.state.writes.length, 0, '排队中的写入在真正写之前被拦下')
	flow.end()
	const flow2 = R.begin('S')
	const p2 = flow2.request({ build: [1], match: () => true, timeoutMs: 1000 })
	await flush()
	flow2.cancel('用户取消')
	await assert.rejects(p2, (e) => e.code === 'cancelled' && e.sent === true)
	flow2.end()
})

test('request: 写入完成前收到的应答等写完再交付；写失败报写入错误', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	const flow = R.begin('S')
	const gate = F.holdWrites()
	const p = flow.request({ build: [1], match: () => true, timeoutMs: 1000 })
	await flush()
	F.rx('S', synthFrame(0x82, [1, 2, 3]))
	let settled = false
	p.then(() => { settled = true }, () => { settled = true })
	await flush()
	assert.equal(settled, false, '写入还没完成，不交付')
	gate.release(false)
	await assert.rejects(p, (e) => e.code === 'write' && e.sent === true)
	flow.end()
})

test('request: 等待期间这一路有其它发送，不认领应答', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	const flow = R.begin('S')
	const p = flow.request({ build: [1], match: () => true, timeoutMs: 1000 })
	await flush()
	F.foreignWrite('S') // 手动发送（钉扎挡不住）
	F.rx('S', synthFrame(0x82, [1, 2, 3]))
	await assert.rejects(p, (e) => e.code === 'foreign' && e.sent === true)
	flow.end()
	// 另一路的发送不影响
	const flow2 = R.begin('S')
	const p2 = flow2.request({ build: [1], match: () => true, timeoutMs: 1000 })
	await flush()
	F.foreignWrite('B')
	F.rx('S', synthFrame(0x82, [1, 2, 3]))
	await p2
	flow2.end()
})

test('pump: 同一块里「应答 → 更新上报」只入账一次，最终值与来源帧都是后者', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	const dev = Reg.normalizeDevice(synthDevice, { id: 't' })
	const store = M.createStore()
	let ingests = 0
	const pump = R.createPump('S', {
		accept: () => true,
		onFrame(item) {
			ingests++
			item.res = M.ingest(store, { sid: 'S', pid: item.pid, gen: item.gen, at: item.at, bytes: item.frame, parsed: item.parsed, device: dev })
		},
	})
	const flow = R.begin('S', { source: pump.source })
	const p = flow.request({
		build: dev.buildRequest(dev.groups[1]),
		match: (parsed, frame, item) => !!(item && item.res && item.res.groups.indexOf('live') >= 0),
		timeoutMs: 1000,
	})
	await flush()
	const reply = synthFrame(0x82, [0x10, 0x00, 0])
	const report = synthFrame(0x82, [0x20, 0x00, 1])
	F.rx('S', [...reply, ...report])
	const res = await p
	assert.deepEqual(Array.from(res.frame), Array.from(reply), '请求认领的是先到的应答')
	assert.equal(ingests, 2, '两帧各入账一次，请求不再二次入账')
	const L = M.lane(store, 'S', 't')
	assert.equal(L.frames.length, 2)
	const r = M.reading(L, 'volt')
	assert.equal(r.raw, 0x20, '最终值是后到的上报')
	assert.deepEqual(M.findFrame(L, r.rec).bytes, Array.from(report), '来源帧是后到的上报')
	flow.end()
	// 协议换了，旧协议留下的半帧不和新数据拼
	F.rx('S', reply.slice(0, 2))
	F.entries.t = synthProto()
	F.rx('S', reply.slice(2))
	assert.equal(ingests, 2, '半帧被丢弃')
	pump.stop()
})

test('pump: 协议实际变更时立即清半帧（同一路 X→Y→X 期间没有 RX）', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	let frames = 0
	const pump = R.createPump('S', { accept: () => true, onFrame() { frames++ } })
	const ans = synthFrame(0x82, [1, 2, 3])
	F.rx('S', ans.slice(0, 3))
	assert.equal(pump.pending(), 3, '收帧器里有半帧')
	F.state.proto.S = 'y'
	F.emit('serial-lane-config')
	assert.equal(pump.pending(), 0, '换协议的事件一到就清掉')
	F.state.proto.S = 't'
	F.emit('serial-lane-config')
	F.rx('S', ans.slice(3))
	assert.equal(frames, 0, '回到原协议后旧半帧不和新数据拼')
	// 注册表重注册（同 id 换条目）同样立即清
	F.rx('S', ans.slice(0, 3))
	F.entries.t = synthProto()
	F.emit('serial-protocol-registry-change')
	assert.equal(pump.pending(), 0)
	// 换代次（重连）同样
	F.rx('S', ans.slice(0, 3))
	F.session('S', 'open')
	assert.equal(pump.pending(), 0)
	F.rx('S', ans)
	assert.equal(frames, 1, '完整新帧照常')
	pump.stop()
	assert.equal((F.docListeners['serial-lane-config'] || []).length, 0, 'stop 后退订')
})

test('request: 查询发出前已缓存的旧应答前缀，写入后补齐也不认领（泵与自带收帧两条路径）', async () => {
	for (const viaPump of [true, false]) {
		const F = fakeEnv()
		const R = Req.create(F.env)
		let ingested = 0
		const pump = viaPump ? R.createPump('S', { accept: () => true, onFrame() { ingested++ } }) : null
		const old = synthFrame(0x82, [9, 9, 9])
		F.rx('S', old.slice(0, 3)) // 上一条命令应答的前半段，在本次查询发出前就到了
		const flow = R.begin('S', viaPump ? { source: pump.source, position: pump.position } : {})
		const p = flow.request({ build: [1], match: () => true, timeoutMs: 1000 })
		await flush()
		assert.equal(F.state.writes.length, 1)
		F.rx('S', old.slice(3)) // 写入后补齐
		if (viaPump) assert.equal(ingested, 1, '被动入账不受影响')
		const fresh = synthFrame(0x82, [1, 2, 3])
		F.rx('S', fresh)
		const res = await p
		assert.deepEqual(Array.from(res.frame), Array.from(fresh), (viaPump ? '泵' : '自带收帧') + '：认领的是写入之后才开始的帧')
		flow.end()
		if (pump) pump.stop()
	}
})

test('request: 等待中有其它发送且一直没有匹配帧，定时检查与超时出口都报 foreign', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	const flow = R.begin('S')
	const p = flow.request({ build: [1], match: () => true, timeoutMs: 5000 })
	await flush()
	F.foreignWrite('S')
	F.advance(200)
	await assert.rejects(p, (e) => e.code === 'foreign' && e.sent === true, '定时检查发现，不等超时')
	flow.end()
	// 只有超时出口（检查间隔比超时长时）也不报成普通超时
	const F2 = fakeEnv()
	const R2 = Req.create(F2.env)
	const flow2 = R2.begin('S')
	const p2 = flow2.request({ build: [1], match: () => false, timeoutMs: 100 })
	await flush()
	F2.foreignWrite('S')
	F2.advance(100)
	await assert.rejects(p2, (e) => e.code === 'foreign')
	flow2.end()
})

test('request: 写入未完成时锁存第一条合格候选，后到的匹配帧不覆盖', async () => {
	const F = fakeEnv()
	const R = Req.create(F.env)
	const flow = R.begin('S')
	const gate = F.holdWrites()
	const p = flow.request({ build: [1], match: () => true, timeoutMs: 1000 })
	await flush()
	const first = synthFrame(0x82, [1, 1, 1])
	const second = synthFrame(0x82, [2, 2, 2])
	F.rx('S', first)
	F.rx('S', second)
	gate.release(true)
	const res = await p
	assert.deepEqual(Array.from(res.frame), Array.from(first))
	flow.end()
})

// ---------- 5. JSON 协议 device ----------
const jsonSpec = {
	schemaVersion: 1,
	id: 'synth-json-dev',
	name: '合成 JSON 设备',
	framing: { head: 'AA', length: { offset: 1, size: 1, totalDelta: 3 }, minLength: 4, maxLength: 64 },
	checksum: { algorithm: 'sum8', offset: -1, start: 0, end: -1 },
	fields: [{ name: '命令', offset: 2, type: 'uint8', format: 'hex' }],
	frames: [
		{ title: '状态应答', match: { offset: 2, value: '0x82' }, fields: [
			{ name: '电压', offset: 3, type: 'uint16le', scale: 0.01, decimals: 2, unit: 'V' },
			{ name: '阀门', offset: 5, type: 'uint8', map: { 0: '关', 1: '开' } },
		] },
	],
	downlink: { headerSize: 3, cmdOffset: 2, payloadOffset: 3, templates: [{ name: '读状态', cmd: '0x02' }] },
	device: {
		title: '合成表',
		groups: [{ id: 'live', title: '实时', request: { template: '读状态' }, reply: { title: '状态应答' } }],
		fields: [
			{ key: 'volt', from: '电压', group: 'live' },
			{ key: 'valve', from: '阀门', group: 'live' },
		],
		status: [{ type: 'metric', title: '电压', key: 'volt', sub: ['valve'] }],
		categories: [{ id: 'all', title: '全部', keys: ['volt', 'valve'] }],
	},
}

test('json: device 声明式映射可用', () => {
	const chk = JP.validateSpec(jsonSpec)
	assert.equal(chk.ok, true, chk.errors && chk.errors.join('；'))
	const proto = JP.compile(jsonSpec)
	const dev = Reg.normalizeDevice(proto.device, { id: jsonSpec.id })
	assert.ok(dev)
	assert.equal(dev.fieldMap.valve.kind, 'enum', '有 map 的字段默认 enum')
	assert.equal(dev.fieldMap.volt.unit, 'V', '单位来自字段定义')
	const req = dev.buildRequest(dev.groups[0])
	assert.equal(req[0], 0xaa)
	assert.equal(req[2], 0x02)
	const reply = proto.buildDownFrame({ cmd: 0x82, payloadHex: '69 01 01' })
	const parsed = proto.parseFrame(reply)
	assert.equal(parsed.ok, true)
	assert.equal(dev.matchReply(dev.groups[0], parsed, reply), true)
	const vals = dev.extract(parsed, reply)
	assert.ok(Math.abs(vals.volt - 3.61) < 1e-9, '取的是协议解出的值（已按系数）')
	assert.equal(vals.valve, 1)
	assert.equal(M.formatValue(dev, 'valve', 1, () => null), '开')
	assert.deepEqual(dev.byteGroups(parsed, 'volt'), ['电压'])
	assert.deepEqual(M.highlightIndices(proto.byteMap(parsed), dev.byteGroups(parsed, 'volt')), [3, 4], '按协议 byteMap 的分组高亮，不猜偏移')
	const other = proto.buildDownFrame({ cmd: 0x90, payloadHex: '00' })
	const po = proto.parseFrame(other)
	assert.equal(dev.matchReply(dev.groups[0], po, other), false)
	assert.equal(dev.extract(po, other), null)
})

test('json: device 校验报错', () => {
	const bad = JSON.parse(JSON.stringify(jsonSpec))
	bad.device.fields.push({ key: 'x', from: '不存在' })
	bad.device.groups[0].request = { template: '没有这个模板' }
	bad.device.status.push({ type: 'metric', key: 'nope' })
	const chk = JP.validateSpec(bad)
	assert.equal(chk.ok, false)
	const msg = chk.errors.join('\n')
	assert.match(msg, /device\.fields\[2\]\.from/)
	assert.match(msg, /request\.template/)
	assert.match(msg, /未声明的字段：nope/)
	const none = JSON.parse(JSON.stringify(jsonSpec))
	delete none.device
	assert.equal(JP.compile(none).device, null)
})

test('device.log: 注册表与 JSON 协议同一白名单，非法值两边都丢弃、不拒绝整份声明', () => {
	for (const v of ['collapsed', 'strip', 'tall']) {
		assert.equal(Reg.normalizeDevice(Object.assign({}, synthDevice, { log: v }), { id: 't' }).log, v)
	}
	for (const v of [undefined, null, 'TALL', 'hidden', 1, {}, ['tall']]) {
		const dev = Reg.normalizeDevice(Object.assign({}, synthDevice, { log: v }), { id: 't' })
		assert.ok(dev, '非法 log 不拒绝整份声明')
		assert.equal(dev.log, null, '非法 log 丢弃：' + JSON.stringify(v))
	}
	const LL = require('../js/log-layout.js')
	assert.deepEqual(LL.PREFS, ['collapsed', 'strip', 'tall'], '布局与注册表同一白名单')
	const ok = JSON.parse(JSON.stringify(jsonSpec))
	ok.device.log = 'collapsed'
	assert.equal(JP.validateSpec(ok).ok, true)
	const dev = Reg.normalizeDevice(JP.compile(ok).device, { id: ok.id })
	assert.equal(dev.log, 'collapsed', 'JSON 协议的 device.log 透传到注册表')
	assert.equal(Reg.normalizeDevice(JP.compile(jsonSpec).device, { id: jsonSpec.id }).log, null, '没写就是 null')
	for (const v of ['huge', 3, ['tall'], { a: 1 }]) {
		const bad = JSON.parse(JSON.stringify(jsonSpec))
		bad.device.log = v
		const chk = JP.validateSpec(bad)
		assert.equal(chk.ok, true, 'JSON 非法 device.log 不拒绝整份协议：' + JSON.stringify(v) + ' ' + (chk.errors || []).join('；'))
		assert.equal(Reg.normalizeDevice(JP.compile(bad).device, { id: bad.id }).log, null, '非法值丢弃')
	}
})

test('json: 可查询必须有应答规则；特殊键与超限明确拒绝', () => {
	const noReply = JSON.parse(JSON.stringify(jsonSpec))
	delete noReply.device.groups[0].reply
	assert.match(JP.validateSpec(noReply).errors.join('\n'), /reply 必须为对象/)
	for (const bad of ['__proto__', 'constructor', 'prototype']) {
		const d = JSON.parse(JSON.stringify(jsonSpec))
		d.device.fields[0].key = bad
		assert.equal(JP.validateSpec(d).ok, false, bad + ' 不能作字段 key')
		const g = JSON.parse(JSON.stringify(jsonSpec))
		g.device.groups[0].id = bad
		assert.equal(JP.validateSpec(g).ok, false, bad + ' 不能作组 id')
	}
	const opt = JSON.parse(JSON.stringify(jsonSpec))
	opt.device.fields[1].options = JSON.parse('{"0":"关","__proto__":"x"}')
	assert.match(JP.validateSpec(opt).errors.join('\n'), /不能用 __proto__ 作键/)
	const many = JSON.parse(JSON.stringify(jsonSpec))
	many.device.fields = Array.from({ length: 600 }, (_, i) => ({ key: 'k' + i, from: '电压' }))
	const e = JP.validateSpec(many).errors.join('\n')
	assert.match(e, /device\.fields 超过 512 项/)
	assert.doesNotMatch(e, /k599/, '超限时整体拒绝，不逐项校验')
	const fromProto = JSON.parse(JSON.stringify(jsonSpec))
	fromProto.device.fields[0].from = 'constructor'
	assert.match(JP.validateSpec(fromProto).errors.join('\n'), /from 必须是本协议/, '字段名表无原型，不会认出 constructor')
	const proto = JP.compile(jsonSpec)
	const dev = Reg.normalizeDevice(proto.device, { id: jsonSpec.id })
	assert.equal(dev.queryable, true)
	assert.equal(Object.getPrototypeOf(dev.fieldMap.valve.options), null)
	assert.throws(() => proto.device.buildRequest({ id: 'nope' }), /未知的读取组/)
	assert.equal(proto.device.matchReply({ id: '__proto__' }, { matchedHead: true }, null), false)
})

test('json: 请求 HEX 与应答规则在解码前限量，非字符串不调用 toString', () => {
	const clone = () => JSON.parse(JSON.stringify(jsonSpec))
	const big = clone()
	big.device.groups[0].request = { rawHex: 'AA'.repeat(10000) }
	assert.match(JP.validateSpec(big).errors.join('\n'), /rawHex 超过/)
	const rules = clone()
	rules.device.groups[0].reply = { match: Array.from({ length: 40 }, () => ({ offset: 0, value: 1 })) }
	const re = JP.validateSpec(rules).errors.join('\n')
	assert.match(re, /reply\.match 超过 16 条/)
	assert.doesNotMatch(re, /match\[39\]/, '超限时不逐条校验')
	const longRule = clone()
	longRule.device.groups[0].reply = { match: [{ offset: 0, bytes: Array.from({ length: 500 }, () => 1) }] }
	assert.match(JP.validateSpec(longRule).errors.join('\n'), /超过 64 字节/)
	let called = false
	const obj = clone()
	obj.device.groups[0].request = { rawHex: { toString() { called = true; return 'AA' } } }
	assert.match(JP.validateSpec(obj).errors.join('\n'), /必须为 HEX 字符串/)
	assert.equal(called, false)
	const total = clone()
	total.device.groups = Array.from({ length: 10 }, (_, i) => ({ id: 'g' + i, request: { rawHex: 'AA'.repeat(4000) }, reply: { title: 'x' } }))
	assert.match(JP.validateSpec(total).errors.join('\n'), /总量超过/)
	const nodes = clone()
	nodes.device.junk = Array.from({ length: 30000 }, () => 0)
	assert.match(JP.validateSpec(nodes).errors.join('\n'), /节点超过|数组过长/)
	assert.equal(JP.validateSpec(jsonSpec).ok, true, '正常声明不受影响')
})

// 用例里等的 promise 永远不结束时（假时钟不再推进），事件循环会排空、进程以 0 退出且不打印汇总；按卡住失败处理
function synthWriteDevice() {
	return Reg.normalizeDevice(Object.assign({}, synthDevice, {
		fields: synthDevice.fields.map(field => Object.assign({}, field, { write: { min: 0, max: 65535, step: 1 }, secret: field.key === 'sn' })),
		buildWrite(field, value) {
			if (value === 999) throw new Error('合成编码失败')
			return synthFrame(0x10, [value & 255, value >> 8])
		},
		matchWriteReply(field, parsed) { return parsed.cmd === 0x90 ? ['ok', 'rejected', 'processing'][parsed.payload[0]] : null },
	}))
}

test('write model: 草稿隔离、过期禁写、无组允许写、结果与快照三态', () => {
	const dev = synthWriteDevice()
	const store = M.createStore()
	const lane = M.lane(store, 'A', 't')
	const parser = synthProto()
	const ingest = (cmd, payload, gen) => {
		const bytes = synthFrame(cmd, payload)
		return M.ingest(store, { sid: 'A', pid: 't', gen, at: 10, bytes, parsed: parser.parseFrame(bytes), device: dev })
	}
	const record = ingest(0x81, [49], 1)
	assert.equal(record.rec.secret, true)
	ingest(0x82, [16, 0, 1], 1)
	lane.readings.cfg = { raw: 6, at: 9, gen: 0 }
	assert.equal(M.writeAllowed(lane, dev.fieldMap.volt, 1), true)
	assert.equal(M.writeAllowed(lane, dev.fieldMap.volt, 2), false)
	assert.equal(M.writeAllowed(lane, dev.fieldMap.cfg, 2), true)
	assert.throws(() => M.inputValue(dev, dev.fieldMap.volt, '1.5'), /步进/)
	const snapshot = M.exportSnapshot(lane, dev, (field, raw) => String(raw))
	assert.deepEqual(snapshot.values.volt, { raw: 16, text: '16', at: 10, gen: 1 })
	assert.equal(Object.hasOwn(snapshot.values, 'sn'), false)
	assert.throws(() => M.compareSnapshot(lane, dev, 1, { ...snapshot, protocolId: 'wrong' }), /协议/)
	ingest(0x82, [17, 0, 1], 1)
	snapshot.values.constructor = { raw: 1, text: '1' }
	const rows = M.compareSnapshot(lane, dev, 1, snapshot)
	assert.deepEqual(rows.map(row => [row.field.key, row.state]), [['volt', 'different'], ['valve', 'same'], ['cfg', 'unread']])
	assert.deepEqual(rows.map(row => row.formatted), ['0.16 V', '开', '6'])
	dev.format = (key, raw, get) => key === 'volt' ? raw + ' / ' + get('valve') : null
	ingest(0x82, [17, 0, 0], 1)
	assert.equal(M.formatValue(dev, 'volt', lane.readings.volt.raw, M.getter(lane, 1)), '17 / 0')
	assert.equal(M.compareSnapshot(lane, dev, 1, snapshot)[0].formatted, '16 / 1')
	M.applySnapshot(lane, rows)
	assert.deepEqual(Object.entries(lane.drafts), [['volt', '16']])
	assert.deepEqual(Object.keys(M.lane(store, 'B', 't').drafts), [])
	assert.deepEqual(Object.keys(M.lane(store, 'A', 'other').drafts), [])
	assert.equal(M.writeResult('ok', { raw: [1, 2] }, null, [1, 2]).state, 'confirmed')
	assert.equal(M.writeResult('ok', { raw: 17 }, null, 16).state, 'mismatch')
	assert.equal(M.writeResult('rejected').state, 'rejected')
	assert.equal(M.writeResult('ok').state, 'unconfirmed')
	assert.equal(M.writeResult('ok', { raw: 16, unsure: true }, null, 16).state, 'unconfirmed')
	assert.equal(M.writeResult('processing').state, 'processing')
	assert.equal(M.writeResult(null, null, { sent: false }).state, 'skipped')
	assert.equal(M.writeResult(null, null, { sent: true }).state, 'unknown')
})

test('write request: 编码失败、发送边界、原始回读认领、foreign 和代次锁定', async () => {
	const fake = fakeEnv()
	const request = Req.create(fake.env)
	const dev = synthWriteDevice()
	const store = M.createStore()
	const field = dev.fieldMap.volt
	const pump = request.createPump('S', { onFrame(item) {
		item.res = M.ingest(store, { sid: 'S', pid: 't', gen: item.gen, at: item.at, bytes: item.frame, parsed: item.parsed, device: dev })
	} })
	const flow = request.begin('S', { source: pump.source, position: pump.position })
	await assert.rejects(flow.writeField(dev, field, 999), error => error.code === 'build' && !error.sent)
	assert.equal(fake.state.writes.length, 0)
	const old = synthFrame(0x90, [1])
	fake.rx('S', old.slice(0, 3))
	const write = flow.writeField(dev, field, 16)
	await flush()
	fake.rx('S', old.slice(3))
	fake.rx('S', synthFrame(0x90, [0]))
	assert.equal(await write, 'ok')
	const read = flow.readGroup(dev, dev.groups.find(group => group.id === field.group))
	await flush()
	fake.rx('S', synthFrame(0x82, []))
	fake.rx('S', [...synthFrame(0x82, [16, 0, 1]), ...synthFrame(0x82, [17, 0, 1])])
	assert.equal((await read).item.res.values.volt, 16)
	assert.equal(M.reading(M.lane(store, 'S', 't'), 'volt').raw, 17)
	const foreign = flow.writeField(dev, field, 18)
	await flush()
	fake.foreignWrite('S')
	fake.rx('S', synthFrame(0x90, [0]))
	await assert.rejects(foreign, error => error.code === 'foreign' && error.sent)
	fake.session('S', 'open')
	await assert.rejects(flow.writeField(dev, field, 20), error => error.code === 'generation' && !error.sent)
	assert.equal(fake.state.writes.length, 3)
	flow.end()
	pump.stop()
})

test('write request: 写入前传输拒绝标为未发出，保密字段不把发送数据交给日志', async () => {
	const fake = fakeEnv()
	const request = Req.create(fake.env)
	const flow = request.begin('S')
	const dev = synthWriteDevice()
	const field = dev.fieldMap.sn
	const realWrite = fake.env.serialApi.writeRawTo
	let shown
	fake.env.serialApi.writeRawTo = async () => { throw new Error('没有拿到写锁') }
	await assert.rejects(flow.writeField(dev, field, 16), error => error.code === 'write' && !error.sent)
	fake.env.serialApi.writeRawTo = (sid, bytes, opts) => {
		shown = opts.logData
		return realWrite(sid, bytes)
	}
	const pending = flow.writeField(dev, field, 16)
	await flush()
	fake.rx('S', synthFrame(0x90, [0]))
	assert.equal(await pending, 'ok')
	assert.equal(shown.length, fake.state.writes[0].bytes.length)
	assert.ok(Array.from(shown).every(value => value === 0))
	flow.end()
})

test('write panel: 确认合并、处理中不自动回读、组归属不明、批写中换代停止', async () => {
	const dev = synthWriteDevice()
	dev.fieldMap.cfg.write.confirm = '合成操作确认'
	const fake = fakeEnv()
	fake.entries.t.device = dev
	const request = Req.create(fake.env)
	const messages = []
	let accept = true
	const fakeElement = name => ({ name, children: [], events: {}, attrs: {}, textContent: '',
		append(child) { this.children.push(child) },
		addEventListener(type, listener) { this.events[type] = listener },
		setAttribute(key, value) { this.attrs[key] = value },
	})
	const walk = node => [node, ...(node.children || []).flatMap(walk)]
	const sandbox = {
		window: { DeviceModel: M, ProtocolRequest: request, ProtocolRegistry: fake.env.registry, serialApi: fake.env.serialApi, serialLanes: fake.env.serialLanes,
			AppDialog: { confirm: async message => { messages.push(message); return accept } } },
		document: { readyState: 'loading', addEventListener() {}, createElement: fakeElement, getElementById: () => null },
	}
	const source = fs.readFileSync(path.join(ROOT, 'js/device-panel.js'), 'utf8')
	const exportPoint = 'window.DevicePanel = {'
	assert.ok(source.includes(exportPoint))
	vm.runInNewContext(source.replace(exportPoint, 'window.DevicePanel = { _testWrite: runWrite, _testCtx: ctx, _testPump: makePump, _testRow: paramRow,'), sandbox)
	const panel = sandbox.window.DevicePanel
	const pump = panel._pumps.S = panel._testPump('S')
	const context = () => panel._testCtx()
	const lane = context().L
	const receive = (cmd, payload) => fake.rx('S', synthFrame(cmd, payload))
	const write = (...keys) => panel._testWrite(context(), keys)
	const commands = () => fake.state.writes.map(item => item.bytes[2])
	const clear = () => fake.state.writes.splice(0)
	const read = () => receive(0x82, [15, 0, 1])
	read()
	lane.drafts.cfg = '4'
	let job = write('cfg')
	await flush()
	assert.equal(messages.length, 1)
	assert.match(messages[0], /无法从设备读取[\s\S]*合成操作确认/)
	receive(0x90, [0])
	await job
	assert.deepEqual(commands(), [0x10])
	assert.equal(lane.writes.cfg.state, 'unconfirmed')
	clear()
	lane.drafts.volt = '16'
	const row = walk(panel._testRow(context(), 'volt'))
	const preview = row.find(node => node.className && node.className.includes('dp-write-preview'))
	const input = row.find(node => node.name === 'input')
	assert.equal(preview.textContent, '预览：0.16 V')
	input.value = '48'
	input.events.input()
	assert.equal(preview.textContent, '预览：0.48 V')
	input.value = 'invalid'
	input.events.input()
	assert.equal(preview.textContent, '')
	lane.drafts.volt = '16'
	job = write('volt')
	await flush()
	receive(0x90, [2])
	await job
	assert.deepEqual(commands(), [0x10])
	assert.equal(lane.writes.volt.state, 'processing')
	clear()
	M.markLate(lane, 'live', 1)
	job = write('volt')
	await flush()
	receive(0x90, [0])
	await flush()
	receive(0x82, [16, 0, 1])
	await job
	assert.deepEqual(commands(), [0x10, 0x02])
	assert.equal(lane.writes.volt.state, 'unconfirmed')
	assert.match(M.readingUnsure(lane, 'volt'), /归属未确认/)
	clear()
	job = write('volt', 'cfg')
	await flush()
	fake.session('S', 'open')
	await job
	assert.deepEqual(commands(), [0x10])
	assert.equal(lane.writes.volt.state, 'unknown')
	assert.equal(lane.writes.cfg.state, 'skipped')
	assert.equal(lane.writes.cfg.detail, '前一项（电压）连接变化后中止，未发送')
	assert.match(lane.writes.volt.detail, /后续项未发送/)
	clear()
	read()
	job = write('volt', 'cfg')
	await flush()
	fake.advance(dev.timeoutMs + 1)
	await job
	assert.deepEqual(commands(), [0x10])
	assert.equal(lane.writes.volt.state, 'unknown')
	assert.equal(lane.writes.cfg.detail, '前一项（电压）等待写入应答超时后中止，未发送')
	clear()
	accept = false
	job = write('cfg', 'volt')
	await job
	assert.deepEqual(commands(), [])
	assert.match(messages[messages.length - 1], /取消此项会中止本轮/)
	assert.equal(lane.writes.cfg.state, 'skipped')
	assert.equal(lane.writes.volt.detail, '前一项（只能写的参数）取消写入后中止，未发送')
	assert.equal(fake.state.pinned, null)
	pump.stop()
})

test('sek write: 按预设编码与解析往返（含 bcd/hexbytes/Tag34），密钥禁写，Tag39 仅应答', () => {
	const win = loadSek()
	const dev = Reg.normalizeDevice(win.SekDevice, { id: 'sek' })
	const roundTrip = (key, text, base, expectedBytes) => {
		const field = dev.fieldMap[key]
		assert.ok(field.write, key + ' 应可写')
		const expected = M.inputValue(dev, field, text)
		const bytes = dev.buildWrite(field, expected, { get: name => name === '3:29' ? base : undefined })
		const [tag, id] = key.split(':').map(Number)
		const parsed = win.skParseFrame(bytes, {})
		const encoded = parsed.tlv.find(block => block.tag === tag).items.find(item => item.id === id)
		assert.deepEqual(Array.from(encoded.raw), Array.from(expectedBytes))
		const settings = [[id, Array.from(encoded.raw)]]
		if (base != null && tag === 3) settings.unshift([29, [base]])
		const read = win.skParseFrame(sekUp(win, 0x83, [[tag, settings]]), {})
		assert.equal(M.sameValue(dev.extract(read)[key], expected), true)
		for (const [code, result] of [[0, 'processing'], [1, 'ok'], [2, 'rejected'], [3, 'rejected'], [4, 'rejected']]) {
			const ack = win.skParseFrame(sekUp(win, 0x81, [[tag, [[id, [code]]]]]), {})
			assert.equal(dev.matchWriteReply(field, ack), result)
		}
		return expected
	}
	roundTrip('3:0', '300', null, [44, 1, 0, 0])
	roundTrip('3:23', '1, 2', null, [34])
	roundTrip('3:35', '123.456', 3, win.SK_PRESET_CODEC.largeFlowM3ToBytes('123.456', 3).bytes)
	roundTrip('39:3', '30, 5', null, [30, 0, 5, 0])
	// Tag34 无磁传感器读写与回读
	roundTrip('34:2', '2', null, [2])
	roundTrip('34:3', '10, 20, 3, 0, 500', null, [10, 20, 3, 0, 0xf4, 0x01])
	roundTrip('34:5', '12', null, [12])
	assert.equal(dev.fieldMap['34:2'].group, 'mag')
	// BCD 类型（短输入自动左侧补零到定长以与回读对齐）
	const bcdUid = roundTrip('3:25', '123456', null, [0x56, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00])
	assert.equal(bcdUid, '00000000123456')
	assert.equal(M.formatValue(dev, '3:25', bcdUid), '00000000123456')
	roundTrip('3:19', '202600001234', null, [0x34, 0x12, 0x00, 0x00, 0x26, 0x20, 0x00, 0x00, 0x00, 0x00])
	roundTrip('33:1', '9876543210', null, [0x10, 0x32, 0x54, 0x76, 0x98, 0x00, 0x00])
	assert.throws(() => M.inputValue(dev, dev.fieldMap['3:25'], '12a4'), /格式|转换/)
	assert.throws(() => M.inputValue(dev, dev.fieldMap['3:25'], '1'.repeat(15)), /过长|转换/)
	// 非 BCD 字节（如全 FF 删除标记）安全可读不崩溃
	const deletedAddr = win.skParseFrame(sekUp(win, 0x83, [[33, [[1, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]]]]]), {})
	assert.equal(dev.extract(deletedAddr)['33:1'], 'FF FF FF FF FF FF FF')
	// hexbytes 类型（支持冒号/空格/连续，短输入右侧补 0x00）
	const freq = roundTrip('35:1', '07:66:88', null, [0x07, 0x66, 0x88])
	assert.equal(freq, '07 66 88')
	assert.equal(M.formatValue(dev, '35:1', freq), '07 66 88')
	roundTrip('37:3', '00:1a:2b:3c:4d:5e', null, [0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e])
	roundTrip('3:44', '0800 1200', null, [0x08, 0x00, 0x12, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])
	roundTrip('35:3', '00 01', null, [0x00, 0x01])
	const rtc = roundTrip('3:20', '20260102030405', null, [0x20, 0x26, 0x01, 0x02, 0x03, 0x04, 0x05])
	assert.equal(rtc, '20 26 01 02 03 04 05')
	assert.equal(M.formatValue(dev, '3:20', rtc), '2026-01-02 03:04:05')
	assert.throws(() => M.inputValue(dev, dev.fieldMap['35:1'], '076'), /转换/)
	assert.throws(() => M.inputValue(dev, dev.fieldMap['35:1'], '07 GG 88'), /格式|转换/)
	assert.throws(() => M.inputValue(dev, dev.fieldMap['35:1'], '07 66 88 99'), /转换/)
	// 密钥类字段脱敏且禁写，普通枚举开关不误判为密钥
	assert.equal(dev.fieldMap['3:16'].secret, true)
	assert.equal(dev.fieldMap['3:16'].write, null)
	assert.equal(dev.fieldMap['38:1'].secret, true)
	assert.equal(dev.fieldMap['38:1'].write, null)
	assert.equal(dev.fieldMap['38:5'].secret, true)
	assert.equal(dev.fieldMap['38:5'].write, null)
	assert.equal(dev.fieldMap['38:6'].secret, false)
	assert.ok(dev.fieldMap['38:6'].write, '38:6 动态密钥加密功能是开关，应可写')
	// 既有规则（LIMITS / DANGER / DISPLAY）保留
	assert.equal(dev.fieldMap['3:9'].write.step, 30)
	assert.ok(dev.fieldMap['3:6'].write.confirm)
	assert.ok(dev.fieldMap['3:7'].note)
	assert.equal(dev.fieldMap['39:3'].group, null)
	const operationAck = win.skParseFrame(sekUp(win, 0x91, [[39, [[3, [1]]]]]), {})
	assert.equal(dev.matchWriteReply(dev.fieldMap['39:3'], operationAck), 'ok')
	assert.equal(dev.matchWriteReply(dev.fieldMap['3:0'], operationAck), null)
	const legacy = win.skParseFrame(sekUp(win, 0x81, [[11, [[1, [1]]]]]), {})
	assert.equal(dev.matchWriteReply(dev.fieldMap['39:3'], legacy), 'ok')
	assert.equal(M.writeResult('ok', null).state, 'unconfirmed')
})

test('status panel: optional metric（阀门卡片）未上报相关 ID 时隐藏，主字段或任一 sub 有读数即显示', () => {
	const win = loadSek()
	const dev = Reg.normalizeDevice(win.SekDevice, { id: 'sek' })
	const fake = fakeEnv()
	fake.entries.sek = {
		findFrame: win.skFindFrame,
		parseFrame: (bytes) => win.skParseFrame(bytes, {}),
		device: dev,
	}
	fake.state.proto.S = 'sek'
	const request = Req.create(fake.env)
	const fakeElement = (name) => ({
		name, children: [], events: {}, attrs: {}, textContent: '',
		append(child) { this.children.push(child) },
		addEventListener(type, listener) { this.events[type] = listener },
		setAttribute(key, value) { this.attrs[key] = value },
	})
	const walk = (node) => [node, ...(node && node.children ? node.children.flatMap(walk) : [])]
	const metricTitles = (tree) => walk(tree).filter((n) => n && n.className === 'dp-metric-l').map((n) => n.textContent)
	const sandbox = {
		window: {
			DeviceModel: M,
			ProtocolRequest: request,
			ProtocolRegistry: fake.env.registry,
			serialApi: fake.env.serialApi,
			serialLanes: fake.env.serialLanes,
		},
		document: { readyState: 'loading', addEventListener() {}, createElement: fakeElement, getElementById: () => null },
	}
	const source = fs.readFileSync(path.join(ROOT, 'js/device-panel.js'), 'utf8')
	const exportPoint = 'window.DevicePanel = {'
	vm.runInNewContext(source.replace(exportPoint, 'window.DevicePanel = { _testStatus: renderStatus, _testCtx: ctx, _testPump: makePump,'), sandbox)
	const panel = sandbox.window.DevicePanel
	const pump = panel._pumps.S = panel._testPump('S')
	const renderTitles = () => metricTitles(panel._testStatus(panel._testCtx(), false))

	// 1. 初始无读数：非 optional 卡片仍显示，阀门卡片隐藏
	const initial = renderTitles()
	assert.ok(initial.includes('累计流量') && initial.includes('电池') && initial.includes('信号'))
	assert.equal(initial.includes('阀门'), false, '未收到 2:12/2:3/2:11 时不渲染阀门卡片')

	// 2. 仅收到其它核心字段（如累计流量 2:9、电池 2:10）：阀门卡片仍隐藏
	fake.rx('S', sekUp(win, 0x02, [[2, [[9, [0x01, 0, 0, 0]], [10, [0x69, 1]]]]]))
	assert.equal(renderTitles().includes('阀门'), false, '仅收到非阀门字段时阀门卡片仍隐藏')

	// 3. 收到 sub 字段之一（2:3 当前水温，主动上报 0x02）：阀门卡片立即显示
	fake.rx('S', sekUp(win, 0x02, [[2, [[3, [0xfa, 0x00]]]]]))
	assert.equal(renderTitles().includes('阀门'), true, '任一 sub 字段有读数即渲染阀门卡片')

	// 4. 新建隔离状态，验证仅收到主字段 2:12（查询应答 0x83）时也渲染阀门卡片
	const lane = panel._testCtx().L
	delete lane.readings['2:3']
	assert.equal(renderTitles().includes('阀门'), false, '清空相关读数后隐藏')
	fake.rx('S', sekUp(win, 0x83, [[2, [[12, [1]]]]]))
	assert.equal(renderTitles().includes('阀门'), true, '主字段 2:12 有读数即渲染阀门卡片')

	// 5. 仅收到另一 sub 字段 2:11（工作电流）：同样渲染阀门卡片
	delete lane.readings['2:12']
	assert.equal(renderTitles().includes('阀门'), false)
	fake.rx('S', sekUp(win, 0x83, [[2, [[11, [0x10, 0x00]]]]]))
	assert.equal(renderTitles().includes('阀门'), true, 'sub 字段 2:11 有读数即渲染阀门卡片')
	pump.stop()

	// 6. JSON 协议声明 metric.optional 同样经注册表透传
	const spec = JSON.parse(JSON.stringify(jsonSpec))
	spec.device.status[0].optional = true
	assert.equal(JP.validateSpec(spec).ok, true)
	const jsonDev = Reg.normalizeDevice(JP.compile(spec).device, { id: spec.id })
	assert.equal(jsonDev.status[0].optional, true)
})

test('json write: 模板输入和应答分流，拒绝有歧义或超限的声明', () => {
	const spec = JSON.parse(JSON.stringify(jsonSpec))
	spec.device.fields[1].write = { min: 0, max: 1, step: 1, options: { 0: '关', 1: '开' } }
	spec.downlink.templates.push({ name: '写阀门', cmd: 0x12, param: { type: 'uint8' } })
	spec.device.writes = [{ field: 'valve', template: '写阀门', reply: {
		ok: { match: [{ offset: 2, value: 0x92 }, { offset: 3, value: 1 }] },
		processing: { match: [{ offset: 2, value: 0x92 }, { offset: 3, value: 0 }] },
		rejected: { match: [{ offset: 2, value: 0x92 }, { offset: 3, value: 2 }] },
	} }]
	assert.equal(JP.validateSpec(spec).ok, true)
	const proto = JP.compile(spec)
	const dev = Reg.normalizeDevice(proto.device)
	const field = dev.fieldMap.valve
	const value = M.inputValue(dev, field, '1')
	assert.deepEqual(Array.from(dev.buildWrite(field, value).slice(2, 4)), [0x12, 1])
	for (const [code, state] of [[0, 'processing'], [1, 'ok'], [2, 'rejected'], [3, null]]) {
		const bytes = proto.buildDownFrame({ cmd: 0x92, payload: [code] })
		assert.equal(dev.matchWriteReply(field, proto.parseFrame(bytes), bytes), state)
	}
	spec.device.fields[1].write.pattern = '(a+)+b'
	assert.equal(JP.validateSpec(spec).ok, false)

	// JSON 协议支持 write.allowEmpty 布尔声明并拒绝非布尔值
	const emptySpec = JSON.parse(JSON.stringify(jsonSpec))
	emptySpec.frames[0].fields.push({ name: 'apn', offset: 6, type: 'ascii', length: 32 })
	emptySpec.device.fields.push({ key: 'apn', name: 'APN', group: 'live', from: 'apn', kind: 'text', write: { maxLen: 32, pattern: '[ -~]*', allowEmpty: true } })
	emptySpec.downlink.templates.push({ name: '写APN', cmd: 0x13, param: { type: 'ascii', length: 32 } })
	emptySpec.device.writes = [{ field: 'apn', template: '写APN', reply: {
		ok: { match: [{ offset: 2, value: 0x93 }, { offset: 3, value: 1 }] },
	} }]
	const emptyChk = JP.validateSpec(emptySpec)
	assert.equal(emptyChk.ok, true, emptyChk.errors && emptyChk.errors.join('；'))
	const emptyDev = Reg.normalizeDevice(JP.compile(emptySpec).device)
	assert.equal(M.allowsEmpty(emptyDev, emptyDev.fieldMap.apn), true)
	const builtEmpty = emptyDev.buildWrite(emptyDev.fieldMap.apn, M.inputValue(emptyDev, emptyDev.fieldMap.apn, ''))
	assert.deepEqual(Array.from(builtEmpty.slice(3, 35)), new Array(32).fill(0))
	emptySpec.device.fields[emptySpec.device.fields.length - 1].write.allowEmpty = 'yes'
	assert.equal(JP.validateSpec(emptySpec).ok, false)
})

test('write panel: APN 等允许写空字段可通过「置空」草稿并写空回读确认，非可空字段删空撤回草稿', async () => {
	const win = loadSek()
	const dev = Reg.normalizeDevice(win.SekDevice, { id: 'sek' })
	assert.equal(M.allowsEmpty(dev, dev.fieldMap['3:7']), true, 'APN 允许写空')
	assert.equal(M.allowsEmpty(dev, dev.fieldMap['38:4']), true, '用户账号允许写空')
	assert.equal(M.allowsEmpty(dev, dev.fieldMap['3:9']), false, '数值字段不允许写空')
	assert.equal(M.allowsEmpty(dev, dev.fieldMap['3:19']), false, 'BCD 字段不允许写空')
	assert.equal(M.allowsEmpty(dev, dev.fieldMap['35:1']), false, 'hexbytes 字段不允许写空')

	const fake = fakeEnv()
	fake.entries.sek = {
		findFrame: win.skFindFrame,
		parseFrame: (bytes) => win.skParseFrame(bytes, {}),
		device: dev,
	}
	fake.state.proto.S = 'sek'
	const request = Req.create(fake.env)
	const fakeElement = name => ({ name, children: [], events: {}, attrs: {}, textContent: '', disabled: false,
		append(child) { this.children.push(child) },
		addEventListener(type, listener) { this.events[type] = listener },
		setAttribute(key, value) { this.attrs[key] = value; if (key === 'disabled') this.disabled = true },
	})
	const walk = node => [node, ...(node.children || []).flatMap(walk)]
	const sandbox = {
		window: { DeviceModel: M, ProtocolRequest: request, ProtocolRegistry: fake.env.registry, serialApi: fake.env.serialApi, serialLanes: fake.env.serialLanes,
			AppDialog: { confirm: async () => true } },
		document: { readyState: 'loading', addEventListener() {}, createElement: fakeElement, getElementById: () => null },
	}
	const source = fs.readFileSync(path.join(ROOT, 'js/device-panel.js'), 'utf8')
	const exportPoint = 'window.DevicePanel = {'
	vm.runInNewContext(source.replace(exportPoint, 'window.DevicePanel = { _testWrite: runWrite, _testCtx: ctx, _testPump: makePump, _testRow: paramRow,'), sandbox)
	const panel = sandbox.window.DevicePanel
	const pump = panel._pumps.S = panel._testPump('S')
	const context = () => panel._testCtx()
	const lane = context().L

	// 1. 设备当前 APN 为 "stmiot"（32B），置空按钮可用，写入按钮初始禁用
	const apn32 = s => { const a = new Array(32).fill(0); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a }
	fake.rx('S', sekUp(win, 0x83, [[3, [[7, apn32('stmiot')], [9, [0xa0, 0x05]]]]]))
	assert.equal(M.reading(lane, '3:7').raw, 'stmiot')
	const apnRow = walk(panel._testRow(context(), '3:7'))
	const buttons = apnRow.filter(n => n.name === 'button')
	const clearBtn = buttons.find(n => n.textContent === '置空')
	const commitBtn = buttons.find(n => n.textContent === '写入')
	const preview = apnRow.find(n => n.className && n.className.includes('dp-write-preview'))
	assert.ok(clearBtn, '允许写空字段应渲染置空按钮')
	assert.equal(clearBtn.disabled, false)
	assert.equal(commitBtn.disabled, true)

	// 2. 点击「置空」→ 记入空草稿、预览 (空)、启用写入、按钮切为「取消置空」
	clearBtn.events.click()
	assert.equal(lane.drafts['3:7'], '')
	assert.equal(preview.textContent, '预览：(空)')
	assert.equal(commitBtn.disabled, false)
	assert.equal(clearBtn.textContent, '取消置空')

	// 3. 再点「取消置空」→ 撤回草稿、禁用写入
	clearBtn.events.click()
	assert.equal(Object.prototype.hasOwnProperty.call(lane.drafts, '3:7'), false)
	assert.equal(preview.textContent, '')
	assert.equal(commitBtn.disabled, true)
	assert.equal(clearBtn.textContent, '置空')

	// 4. 再次点击「置空」并执行写入 → 下发 Tag3-ID7 全0 32B，回读全0 确认 confirmed
	clearBtn.events.click()
	const job = panel._testWrite(context(), ['3:7'])
	await flush()
	assert.equal(fake.state.writes.length, 1)
	const sentParsed = win.skParseFrame(fake.state.writes[0].bytes, {})
	assert.equal(sentParsed.tlv[0].tag, 3)
	assert.equal(sentParsed.tlv[0].items[0].id, 7)
	assert.deepEqual(sentParsed.tlv[0].items[0].raw, new Array(32).fill(0))
	fake.rx('S', sekUp(win, 0x81, [[3, [[7, [1]]]]]))
	await flush()
	fake.rx('S', sekUp(win, 0x83, [[3, [[7, new Array(32).fill(0)]]]]))
	await job
	assert.equal(lane.writes['3:7'].state, 'confirmed')
	assert.equal(Object.prototype.hasOwnProperty.call(lane.drafts, '3:7'), false)

	// 5. 设备值已为空后，「置空」按钮应禁用
	const apnRowAfter = walk(panel._testRow(context(), '3:7'))
	const clearBtnAfter = apnRowAfter.filter(n => n.name === 'button').find(n => n.textContent === '置空')
	assert.equal(clearBtnAfter.disabled, true)

	// 6. 非可空字段（3:9 上报频率）不渲染置空按钮，输入后删空撤回草稿
	const freqRow = walk(panel._testRow(context(), '3:9'))
	assert.equal(freqRow.filter(n => n.name === 'button').some(n => n.textContent === '置空'), false)
	const freqInput = freqRow.find(n => n.name === 'input')
	const freqCommit = freqRow.filter(n => n.name === 'button').find(n => n.textContent === '写入')
	freqInput.value = '60'
	freqInput.events.input()
	assert.equal(lane.drafts['3:9'], '60')
	assert.equal(freqCommit.disabled, false)
	freqInput.value = ''
	freqInput.events.input()
	assert.equal(Object.prototype.hasOwnProperty.call(lane.drafts, '3:9'), false)
	assert.equal(freqCommit.disabled, true)
	pump.stop()
})

test('rail subnav & firmwareAvailable: 按协议动态显隐左栏二级子导航、折叠持久化与固件回退', () => {
	const win = loadSek()
	const fake = fakeEnv()
	const minDev = Reg.normalizeDevice(win.SekDevice, { id: 'sek' })
	assert.ok(minDev)
	fake.entries.sek = { name: 'SEK', device: minDev, firmware: { method: 'pcp', versionKey: '2:13' } }
	fake.entries.hostproto = { name: 'HostProto', device: minDev }
	fake.entries.wmbus = { name: 'W-MBUS' }
	fake.state.proto.S = 'sek'

	const toasts = []
	fake.env.serialLanes.toast = (msg, kind) => toasts.push({ msg, kind })
	const request = Req.create(fake.env)

	class MiniEl {
		constructor(tag) {
			this.tagName = String(tag).toUpperCase()
			this.id = ''
			this.className = ''
			this._text = ''
			this.title = ''
			this.hidden = false
			this.disabled = false
			this.dataset = {}
			this.attrs = {}
			this.children = []
			this.parentNode = null
			this.listeners = {}
			this.style = { setProperty() {}, getPropertyValue: () => '' }
			this.classList = {
				toggle: (n, on) => {
					const s = new Set(this.className.split(/\s+/).filter(Boolean))
					if (on === undefined) { if (s.has(n)) s.delete(n); else s.add(n) }
					else if (on) s.add(n); else s.delete(n)
					this.className = Array.from(s).join(' ')
				},
				contains: (n) => this.className.split(/\s+/).includes(n),
			}
		}
		get textContent() { return this._text }
		set textContent(v) {
			this._text = String(v == null ? '' : v)
			this.children.forEach((c) => { c.parentNode = null })
			this.children = []
		}
		get nextSibling() {
			if (!this.parentNode) return null
			const idx = this.parentNode.children.indexOf(this)
			return idx >= 0 && idx + 1 < this.parentNode.children.length ? this.parentNode.children[idx + 1] : null
		}
		append(...nodes) { for (const n of nodes) if (n) this.appendChild(n) }
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
			if (idx >= 0) { this.children.splice(idx, 1); c.parentNode = null }
			return c
		}
		setAttribute(k, v) {
			this.attrs[k] = String(v)
			if (k === 'id') this.id = String(v)
			if (k.startsWith('data-')) {
				const key = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())
				this.dataset[key] = String(v)
			}
		}
		getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null }
		removeAttribute(k) { delete this.attrs[k] }
		addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
		click() { (this.listeners.click || []).slice().forEach((fn) => fn({ target: this })) }
		querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
		querySelectorAll(sel) {
			const out = []
			const match = (n) => {
				if (sel === '#activity-rail .rail-top') return n.classList.contains('rail-top') && n.parentNode && n.parentNode.id === 'activity-rail'
				if (sel === '.rail-item[data-view="view-serial"]') return n.classList.contains('rail-item') && n.dataset.view === 'view-serial'
				if (sel === '.rail-subitem') return n.classList.contains('rail-subitem')
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

	const body = new MiniEl('body')
	const rail = new MiniEl('nav')
	rail.id = 'activity-rail'
	const railTop = new MiniEl('div')
	railTop.className = 'rail-top'
	const serialBtn = new MiniEl('button')
	serialBtn.className = 'rail-item active'
	serialBtn.dataset.view = 'view-serial'
	railTop.appendChild(serialBtn)
	rail.appendChild(railTop)
	body.appendChild(rail)

	const viewSerial = new MiniEl('div')
	viewSerial.id = 'view-serial'
	viewSerial.className = 'app-view active'
	const main = new MiniEl('div')
	main.id = 'main'
	viewSerial.appendChild(main)
	body.appendChild(viewSerial)

	const fwStop = new MiniEl('button')
	fwStop.id = 'fw-stop'
	fwStop.disabled = true
	body.appendChild(fwStop)

	const findById = (n, id) => {
		if (n.id === id) return n
		for (const c of n.children) {
			const hit = findById(c, id)
			if (hit) return hit
		}
		return null
	}

	const lsMap = new Map()
	const ssMap = new Map()
	const docListeners = {}
	const timers = []
	const doc = {
		readyState: 'complete',
		hidden: false,
		createElement: (tag) => new MiniEl(tag),
		getElementById: (id) => findById(body, id),
		querySelector: (sel) => body.querySelector(sel),
		querySelectorAll: (sel) => body.querySelectorAll(sel),
		addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn) },
		dispatchEvent: (ev) => { (docListeners[ev.type] || []).slice().forEach((fn) => fn(ev)); return true },
	}
	const sandbox = {
		window: {
			DeviceModel: M,
			ProtocolRequest: request,
			ProtocolRegistry: fake.env.registry,
			serialApi: fake.env.serialApi,
			serialLanes: fake.env.serialLanes,
			localStorage: {
				getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
				setItem: (k, v) => lsMap.set(k, String(v)),
			},
			AppPlatform: { has: () => true },
		},
		document: doc,
		sessionStorage: {
			getItem: (k) => (ssMap.has(k) ? ssMap.get(k) : null),
			setItem: (k, v) => ssMap.set(k, String(v)),
		},
		CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail },
		setTimeout: (fn) => { timers.push(fn); return timers.length },
		clearTimeout: () => {},
		setInterval: () => 1,
		clearInterval: () => {},
	}
	const source = fs.readFileSync(path.join(ROOT, 'js/device-panel.js'), 'utf8')
	vm.runInNewContext(source, sandbox)
	while (timers.length) timers.shift()()

	const panel = sandbox.window.DevicePanel
	// 不再生成顶部 .dp-viewbar
	assert.equal(findById(body, 'dp-viewbar'), null, '已移除顶部 .dp-viewbar')
	const subnav = findById(body, 'rail-serial-subnav')
	assert.ok(subnav, '应在左栏创建 #rail-serial-subnav')
	assert.equal(serialBtn.nextSibling, subnav, '#rail-serial-subnav 应紧接在串口按钮之后')

	// 1. SEK（device + pcp firmware）：firmwareAvailable = true，子项 3 个且展开
	assert.equal(panel.firmwareAvailable(), true)
	assert.equal(subnav.hidden, false)
	assert.equal(serialBtn.dataset.hasSub, 'true')
	assert.equal(serialBtn.dataset.subOpen, 'true')
	assert.equal(serialBtn.title, '通信调试 · SEK')
	assert.deepEqual(subnav.querySelectorAll('.rail-subitem').map((b) => b.dataset.subview), ['comm', 'device', 'firmware'])

	// 2. 点击「固件」子项切到 firmware；再切协议到 hostproto（仅有 device，无 firmware）：自动回退 comm 且子项只剩 2 个
	subnav.querySelectorAll('.rail-subitem')[2].click()
	assert.equal(panel.view(), 'firmware')
	fake.state.proto.S = 'hostproto'
	panel._sync()
	assert.equal(panel.firmwareAvailable(), false)
	assert.equal(panel.view(), 'comm', '切到不支持固件的协议时自动回退到通信调试')
	assert.ok(toasts.some((t) => t.kind === 'warn' && t.msg.includes('不支持 PCP 固件升级')))
	assert.deepEqual(subnav.querySelectorAll('.rail-subitem').map((b) => b.dataset.subview), ['comm', 'device'])

	// 3. 切协议到 wmbus（无 device 也无 firmware）：子菜单自动隐藏，无折叠标记，showFirmware 提示并返回 false
	fake.state.proto.S = 'wmbus'
	panel._sync()
	assert.equal(panel.available(), false)
	assert.equal(panel.firmwareAvailable(), false)
	assert.equal(subnav.hidden, true, '仅剩 1 项时自动隐藏二级子导航')
	assert.equal(serialBtn.dataset.hasSub, undefined)
	assert.equal(panel.showFirmware(), false)

	// 4. 升级进行中（#fw-stop 可用）即使协议为 wmbus 仍保留 firmwareAvailable = true
	fwStop.disabled = false
	panel._sync()
	assert.equal(panel.firmwareAvailable(), true, '升级进行中保留固件视图可用')
	assert.equal(subnav.hidden, false)
	fwStop.disabled = true

	// 5. 切回 sek：再次点击已激活的「串口」切换折叠并持久化；切到其它视图自动收起，切回恢复
	fake.state.proto.S = 'sek'
	panel._sync()
	assert.equal(subnav.hidden, false)
	serialBtn.click()
	assert.equal(lsMap.get('railSerialSubnavCollapsed'), '1')
	assert.equal(subnav.hidden, true)
	serialBtn.click()
	assert.equal(lsMap.get('railSerialSubnavCollapsed'), '0')
	assert.equal(subnav.hidden, false)

	viewSerial.classList.toggle('active', false)
	doc.dispatchEvent(new sandbox.CustomEvent('serial-active-view-change', { detail: { viewId: 'view-blu', prevViewId: 'view-serial' } }))
	assert.equal(subnav.hidden, true, '切到其它左栏视图时自动收起串口子菜单')
	viewSerial.classList.toggle('active', true)
	doc.dispatchEvent(new sandbox.CustomEvent('serial-active-view-change', { detail: { viewId: 'view-serial', prevViewId: 'view-blu' } }))
	assert.equal(subnav.hidden, false, '切回串口视图时恢复展开')
})

let current = null
let finished = false
process.on('exit', (code) => {
	if (!finished && code === 0) {
		console.log('FAIL ' + (current || '?') + '：用例没有结束（等待的 promise 一直没有兑现）')
		process.exitCode = 1
	}
})
;(async () => {
	let failed = 0
	for (const t of tests) {
		current = t.name
		try {
			await t.fn()
			console.log('ok   ' + t.name)
		} catch (e) {
			failed++
			console.log('FAIL ' + t.name)
			console.log(e && e.stack ? e.stack : e)
		}
	}
	if (failed) {
		console.log(failed + ' failed')
		process.exit(1)
	}
	finished = true
	console.log('device-panel: all ' + tests.length + ' passed')
})()
