// Run: node tests/dual-config.cjs — synthetic data only.
// 覆盖: 双路两路参数 / 两路协议的存储迁移，双路预设的规范化、增删改、匹配与套用计划(js/dual-config.js 的纯函数)
const assert = require('node:assert/strict')
const D = require('../js/dual-config.js')

const DEF = D.DEFAULT_OPTIONS

// ---- 参数逐项校验：坏项回落 base，好项保留 ----
{
	assert.deepEqual(D.normalizeOptions(null), DEF)
	const o = D.normalizeOptions({ baudRate: '2400', dataBits: 7, stopBits: '2', parity: 'even', bufferSize: 4096, flowControl: 'hardware' })
	assert.deepEqual(o, { baudRate: 2400, dataBits: 7, stopBits: 2, parity: 'even', bufferSize: 4096, flowControl: 'hardware' })
	const bad = D.normalizeOptions({ baudRate: 'abc', dataBits: 9, stopBits: 3, parity: 'mark', bufferSize: -1, flowControl: 'xon' }, o)
	assert.deepEqual(bad, o, '非法项取 base')
	assert.ok(D.sameOptions({ baudRate: '9600' }, { baudRate: 9600 }))
	assert.ok(!D.sameOptions({ parity: 'even' }, { parity: 'none' }))
	assert.equal(D.paramsSummary({ baudRate: 2400, parity: 'even' }), '2400 8-E-1')
}

// ---- 两路参数迁移：新键优先；缺失时两路都用旧的双路共用键；都没有用默认 ----
{
	const legacy = JSON.stringify({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', bufferSize: 1024, flowControl: 'none' })
	const m1 = D.migrateLaneOptions(null, legacy)
	assert.equal(m1.A.baudRate, 9600)
	assert.equal(m1.B.baudRate, 9600)
	assert.notEqual(m1.A, m1.B, '两路是独立对象，改一路不影响另一路')
	const m2 = D.migrateLaneOptions(JSON.stringify({ A: { baudRate: 2400, parity: 'none' }, B: { baudRate: 2400, parity: 'even' } }), legacy)
	assert.equal(m2.A.parity, 'none')
	assert.equal(m2.B.parity, 'even')
	assert.equal(m2.B.baudRate, 2400)
	// 新键只有一路：缺的那路用旧键
	const m3 = D.migrateLaneOptions({ A: { baudRate: 4800 } }, legacy)
	assert.equal(m3.A.baudRate, 4800)
	assert.equal(m3.B.baudRate, 9600)
	// 坏 JSON / 都没有：默认
	assert.deepEqual(D.migrateLaneOptions('{oops', '{oops'), { A: DEF, B: DEF })
}

// ---- 两路协议迁移：缺失时两路都取迁移前的全局协议 ----
{
	assert.deepEqual(D.migrateLaneProtocols(null, 'hostproto'), { A: 'hostproto', B: 'hostproto' })
	assert.deepEqual(D.migrateLaneProtocols(JSON.stringify({ A: 'gz', B: 'wmbus' }), 'sek'), { A: 'gz', B: 'wmbus' })
	assert.deepEqual(D.migrateLaneProtocols({ A: '', B: 7 }, ''), { A: 'sek', B: 'sek' })
}

// ---- 预设：创建、规范化、存取往返 ----
const cfg = {
	A: { options: { baudRate: 2400, parity: 'none' }, protocol: 'sek', label: '红外' },
	B: { options: { baudRate: 2400, parity: 'even' }, protocol: 'hostproto', label: ' RS485 ' },
}
{
	assert.throws(() => D.makePreset('   ', cfg), /不能为空/)
	const p = D.makePreset('  产线   红外 ', cfg)
	assert.equal(p.name, '产线 红外')
	assert.equal(p.A.label, '红外')
	assert.equal(p.B.label, 'RS485')
	assert.equal(p.B.options.parity, 'even')
	assert.equal(p.B.options.dataBits, 8, '缺省项补默认')
	assert.ok(!('port' in p.A), '不存端口身份')
	const round = D.normalizePresets(D.serializePresets([p]))
	assert.deepEqual(round, [p])
	// 坏项、空名、重名(留先出现的)都丢掉；兼容直接存数组
	const list = D.normalizePresets(JSON.stringify([p, null, { name: '' }, { name: '产线 红外', A: {} }, { name: 'x' }]))
	assert.deepEqual(list.map(x => x.name), ['产线 红外', 'x'])
	assert.equal(list[1].A.protocol, 'sek')
	assert.deepEqual(D.normalizePresets('not json'), [])
}

// ---- 增删改 ----
{
	const a = D.makePreset('A', cfg)
	const b = D.makePreset('B', cfg)
	let r = D.upsertPreset([], a)
	assert.equal(r.replaced, false)
	r = D.upsertPreset(r.list, b)
	const a2 = D.makePreset('A', { A: { options: { baudRate: 115200 } }, B: {} })
	r = D.upsertPreset(r.list, a2)
	assert.equal(r.replaced, true)
	assert.deepEqual(r.list.map(x => x.name), ['A', 'B'], '同名覆盖原位置不动')
	assert.equal(r.list[0].A.options.baudRate, 115200)
	assert.throws(() => D.renamePreset(r.list, 'A', 'B'), /同名/)
	assert.throws(() => D.renamePreset(r.list, 'A', ' '), /不能为空/)
	assert.throws(() => D.renamePreset(r.list, 'Z', 'Y'), /不存在/)
	const renamed = D.renamePreset(r.list, 'A', 'C')
	assert.deepEqual(renamed.map(x => x.name), ['C', 'B'])
	assert.deepEqual(r.list.map(x => x.name), ['A', 'B'], '不改原列表')
	assert.deepEqual(D.renamePreset(r.list, 'A', 'A').map(x => x.name), ['A', 'B'], '改成原名不算重名')
	assert.deepEqual(D.removePreset(renamed, 'C').map(x => x.name), ['B'])
	assert.deepEqual(D.removePreset(renamed, 'nope').map(x => x.name), ['C', 'B'])
}

// ---- 匹配当前配置：标签空等同默认 A路/B路 ----
{
	const p = D.makePreset('p', cfg)
	assert.ok(D.presetMatches(p, cfg))
	assert.ok(!D.presetMatches(p, Object.assign({}, cfg, { B: Object.assign({}, cfg.B, { protocol: 'sek' }) })))
	const plain = D.makePreset('plain', { A: { label: '' }, B: { label: 'B路' } })
	assert.ok(D.presetMatches(plain, { A: { label: 'A路' }, B: { label: '' } }))
}

// ---- 套用计划：未注册协议保留当前；标出参数变了的路 ----
{
	const p = D.makePreset('p', cfg)
	const cur = {
		A: { options: { baudRate: 2400, parity: 'none' }, protocol: 'gz', label: 'A路' },
		B: { options: { baudRate: 115200 }, protocol: 'sek', label: 'B路' },
	}
	const plan = D.planApply(p, cur, id => id !== 'hostproto')
	assert.equal(plan.lanes.A.optionsChanged, false)
	assert.equal(plan.lanes.A.protocol, 'sek')
	assert.equal(plan.lanes.A.protocolChanged, true)
	assert.equal(plan.lanes.B.optionsChanged, true)
	assert.equal(plan.lanes.B.protocol, 'sek', '未注册的协议保留该路当前协议')
	assert.equal(plan.lanes.B.protocolChanged, false)
	assert.deepEqual(plan.unknownProtocols, ['hostproto'])
	assert.equal(plan.lanes.B.label, 'RS485')
	assert.equal(plan.lanes.B.options.parity, 'even')
}

console.log('dual-config: ok')
