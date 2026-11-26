// Run: node tests/log-layout.cjs — js/log-layout.js 的纯函数回归：右栏宽度按日志区保底宽度钳制、
// 设备面板「通信记录」条的高度钳制、按协议 id 的布局存档（读写、非法存档、条目上限）与初始偏好的优先级。
'use strict'

const assert = require('node:assert/strict')
const LL = require('../js/log-layout.js')

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

function memStorage(init) {
	const m = new Map(Object.entries(init || {}))
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => { m.set(k, String(v)) },
		removeItem: (k) => { m.delete(k) },
		_m: m,
	}
}

test('clampRightPane: 上限 = 可用宽度 - 日志区下限，没有固定 760 上限', () => {
	assert.equal(LL.LOG_MIN, 240)
	assert.equal(LL.PANE_MIN, 280)
	// 1920 宽：#main 去掉停靠栏约 1800，右栏可到 1560
	assert.equal(LL.clampRightPane(5000, 1800), 1800 - 240)
	assert.equal(LL.clampRightPane(1200, 1800), 1200, '旧上限 760 以上的宽度照常生效')
	assert.equal(LL.clampRightPane(600, 1800), 600, '旧存档 ≤760 照常生效')
	assert.equal(LL.clampRightPane(100, 1800), 280, '不窄于右栏下限')
	assert.equal(LL.clampRightPane(920, 1000), 760, '窗口缩小后重新钳制，日志区留 240')
})

test('clampRightPane: 两个下限冲突时日志区优先；可用宽度未知时只钳下限', () => {
	assert.equal(LL.clampRightPane(400, 400), 160, '放不下右栏下限时右栏让步')
	assert.equal(LL.clampRightPane(400, 100), 0)
	assert.equal(LL.clampRightPane(900, NaN), 900, '#main 没布局（隐藏）时不按 0 宽钳成 0')
	assert.equal(LL.clampRightPane(900, 0), 900)
	assert.equal(LL.clampRightPane('abc', 1800), 280, '非数字按下限')
	assert.equal(LL.clampRightPane(900, 1000, { logMin: 300, paneMin: 200 }), 700)
})

test('clampStripH: 下限 72，上限给设备面板留 160', () => {
	assert.equal(LL.clampStripH(10, 800), LL.STRIP_MIN)
	assert.equal(LL.clampStripH(5000, 800), 800 - LL.PANEL_MIN)
	assert.equal(LL.clampStripH(300, 800), 300)
	assert.equal(LL.clampStripH(300, NaN), 300, '高度未知只钳下限')
	assert.equal(LL.clampStripH(300, 100), LL.STRIP_MIN, '视图太矮时仍保留最小条')
	assert.equal(LL.clampStripH(undefined, 800), LL.STRIP_DEFAULT)
})

test('stripStateFor: 用户存档 > 窄屏收起 > 协议 device.log > 默认矮条', () => {
	const none = Object.create(null)
	assert.deepEqual(LL.stripStateFor(none, 'p', null, false), { collapsed: false, h: 120, source: 'default' })
	assert.deepEqual(LL.stripStateFor(none, 'p', 'tall', false), { collapsed: false, h: LL.STRIP_TALL, source: 'protocol' })
	assert.deepEqual(LL.stripStateFor(none, 'p', 'collapsed', false), { collapsed: true, h: 120, source: 'protocol' })
	assert.deepEqual(LL.stripStateFor(none, 'p', 'strip', false), { collapsed: false, h: 120, source: 'protocol' })
	assert.equal(LL.stripStateFor(none, 'p', 'bogus', false).source, 'default', '非法偏好不生效')
	assert.deepEqual(LL.stripStateFor(none, 'p', 'tall', true), { collapsed: true, h: LL.STRIP_TALL, source: 'narrow' }, '窄屏默认收起，展开后用协议偏好的高度')
	const saved = Object.create(null)
	saved.p = { collapsed: false, h: 250 }
	assert.deepEqual(LL.stripStateFor(saved, 'p', 'collapsed', true), { collapsed: false, h: 250, source: 'user' }, '用户调整过就以用户为准（窄屏与协议偏好都让位）')
	assert.equal(LL.stripStateFor(saved, 'q', 'tall', false).source, 'protocol', '按协议 id 各存一份')
	assert.equal(LL.stripStateFor(saved, null, 'tall', false).source, 'protocol', '没有协议 id 不读存档')
})

test('readStore / saveStripState: 按协议存档，非法存档与非法条目忽略，条目有上限', () => {
	const st = memStorage()
	assert.equal(LL.saveStripState(st, 'sek', { collapsed: false, h: 320 }), true)
	assert.equal(LL.saveStripState(st, 'demo', { collapsed: true, h: 210.4 }), true)
	assert.equal(LL.saveStripState(st, '', { collapsed: true, h: 100 }), false, '没有协议 id 不写')
	assert.equal(LL.saveStripState(st, 'x', { h: -1 }), false, '非法状态不写')
	const raw = JSON.parse(st.getItem(LL.STRIP_KEY))
	assert.equal(raw.v, 1)
	assert.deepEqual(raw.byPid, { sek: { collapsed: false, h: 320 }, demo: { collapsed: true, h: 210 } })
	assert.deepEqual(raw.order, ['sek', 'demo'], '显式记写入顺序')
	const r = LL.readStore(st)
	assert.deepEqual(Object.assign({}, r), raw.byPid)
	assert.equal(Object.getPrototypeOf(r), null, '键表无原型，__proto__ 之类的协议 id 不会串到原型上')
	assert.equal(LL.STRIP_KEY, 'deviceLogStripModern')
	// 坏存档
	assert.deepEqual(Object.assign({}, LL.readStore(memStorage({ deviceLogStripModern: '{bad' }))), {})
	assert.deepEqual(Object.assign({}, LL.readStore(memStorage({ deviceLogStripModern: '{"v":2,"byPid":{"a":{"h":100}}}' }))), {}, '版本不对不读')
	assert.deepEqual(Object.assign({}, LL.readStore(memStorage({ deviceLogStripModern: '{"v":1,"byPid":{"a":{"h":"x"},"b":{"h":90,"collapsed":"yes"}}}' }))), { b: { collapsed: false, h: 90 } })
	assert.deepEqual(Object.assign({}, LL.readStore(null)), {}, '没有 localStorage 也能用')
	const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
	assert.deepEqual(Object.assign({}, LL.readStore(throwing)), {})
	assert.equal(LL.saveStripState(throwing, 'p', { collapsed: false, h: 100 }), false, '写失败不抛')
	// 上限：超出时丢最早写入的；重写的移到最后
	const big = memStorage()
	for (let i = 0; i < 70; i++) LL.saveStripState(big, 'p' + i, { collapsed: false, h: 100 + i })
	LL.saveStripState(big, 'p10', { collapsed: true, h: 99 })
	const keys = Object.keys(JSON.parse(big.getItem(LL.STRIP_KEY)).byPid)
	assert.equal(keys.length, 64)
	assert.equal(keys[keys.length - 1], 'p10')
	assert.ok(keys.indexOf('p0') < 0 && keys.indexOf('p5') < 0 && keys.indexOf('p6') >= 0, '丢掉的是最早写入的 p0..p5')
})

test('saveStripState: 数字协议 id 按显式写入顺序淘汰，不按 Object.keys 的整数键优先顺序', () => {
	const st = memStorage()
	// 先写字母 id，再写一批数字 id：Object.keys 会把数字键排到最前，按它淘汰会先删掉最新写入的数字 id
	for (let i = 0; i < 4; i++) LL.saveStripState(st, 'a' + i, { collapsed: false, h: 100 })
	for (let i = 0; i < 61; i++) LL.saveStripState(st, String(1000 + i), { collapsed: false, h: 100 })
	let raw = JSON.parse(st.getItem(LL.STRIP_KEY))
	assert.equal(raw.order.length, 64)
	assert.equal(raw.order[0], 'a1', '最早写入的 a0 被淘汰')
	assert.equal(raw.order[63], '1060')
	assert.ok(!('a0' in raw.byPid) && '1060' in raw.byPid && '1000' in raw.byPid)
	// 重写一个数字 id 移到最后；再写新条目时淘汰的是当前最早的 a1，而不是数值最小的 1000 之外的错误目标
	LL.saveStripState(st, '1000', { collapsed: true, h: 150 })
	LL.saveStripState(st, 'z', { collapsed: false, h: 100 })
	raw = JSON.parse(st.getItem(LL.STRIP_KEY))
	assert.equal(raw.order.length, 64)
	assert.ok(!('a1' in raw.byPid), '淘汰 a1')
	assert.deepEqual(raw.order.slice(-2), ['1000', 'z'])
	assert.deepEqual(LL.readStore(st)['1000'], { collapsed: true, h: 150 })
	// 旧存档没有 order：按对象键顺序视为更早，不报错
	const old = memStorage({ deviceLogStripModern: JSON.stringify({ v: 1, byPid: { '7': { collapsed: false, h: 90 }, b: { collapsed: true, h: 100 } } }) })
	LL.saveStripState(old, 'c', { collapsed: false, h: 110 })
	assert.deepEqual(JSON.parse(old.getItem(LL.STRIP_KEY)).order, ['7', 'b', 'c'])
	// order 里有不存在 / 重复 / 非字符串的项要清掉
	const messy = memStorage({ deviceLogStripModern: JSON.stringify({ v: 1, byPid: { x: { h: 100 } }, order: ['x', 'x', 'ghost', 5] }) })
	LL.saveStripState(messy, 'y', { collapsed: false, h: 100 })
	assert.deepEqual(JSON.parse(messy.getItem(LL.STRIP_KEY)).order, ['x', 'y'])
})

test('normPref: 白名单', () => {
	assert.deepEqual(LL.PREFS, ['collapsed', 'strip', 'tall'])
	for (const v of LL.PREFS) assert.equal(LL.normPref(v), v)
	for (const v of ['', 'Tall', null, undefined, 3, {}]) assert.equal(LL.normPref(v), null)
})

;(async () => {
	let failed = 0
	for (const t of tests) {
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
	console.log('log-layout: all ' + tests.length + ' passed')
})()
