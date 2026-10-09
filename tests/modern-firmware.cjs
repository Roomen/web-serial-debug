// Run: node tests/modern-firmware.cjs — synthetic data only.
// 覆盖: 现代布局固件流水线 js/modern-firmware.js 的纯函数（版本识别、分块状态、事件归约、四步状态推导、速率与剩余时间）
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const ctx = { console, Date, Math }
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/modern-firmware.js'), 'utf8'), ctx)
const jeq = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b))
const F = ctx.ModernFirmware
assert.ok(F && typeof F.deriveStages === 'function')
assert.equal(F.isMounted, undefined, 'node 下不挂界面')

// ---- 格式化 ----
assert.equal(F.fmtSize(0), '0 B')
assert.equal(F.fmtSize(1536), '1.5 KB')
assert.equal(F.fmtSize(3 * 1024 * 1024), '3.00 MB')
assert.equal(F.fmtSize(-1), '--')
assert.equal(F.fmtRate(0), '--')
assert.equal(F.fmtRate(512), '512 B/s')
assert.equal(F.fmtRate(2048), '2.0 KB/s')
assert.equal(F.fmtEta(31), '00:31')
assert.equal(F.fmtEta(125), '02:05')
assert.equal(F.fmtEta(NaN), '--:--')
assert.equal(F.fmtEta(Infinity), '--:--')

// ---- 裸固件内嵌版本：0x4000 起 4 字节时间戳 + 版本串 ----
function raw(ver, n) {
	const b = new Uint8Array(n || 0x4100)
	b.fill(0xff)
	b.set([1, 2, 3, 4], 0x4000)
	for (let i = 0; i < 16; i++) b[0x4004 + i] = i < ver.length ? ver.charCodeAt(i) : 0
	return b
}
assert.equal(F.embeddedVersion(raw('V2.1.0')), 'V2.1.0')
assert.equal(F.embeddedVersion(raw('1234567890123456')), '1234567890123456')
assert.equal(F.embeddedVersion(raw('')), null, '空串不显示')
assert.equal(F.embeddedVersion(new Uint8Array(0x4010)), null, '太短')
assert.equal(F.embeddedVersion(new Uint8Array(0x4100).fill(0xff)), null, '空白闪存不是版本')
const bin = raw('V1')
bin[0x4005] = 0x07
assert.equal(F.embeddedVersion(bin), null, '含不可见字符不猜')
assert.equal(F.embeddedVersion(null), null)

assert.equal(F.sameVersion('V2.1.0', ' V2.1.0 '), true)
assert.equal(F.sameVersion('V2.1.0', 'V2.1.1'), false)
assert.equal(F.sameVersion(null, 'V2.1.0'), false)
assert.equal(F.sameVersion('', ''), false)
assert.equal(F.ratioOf(50, 100), 0.5)
assert.equal(F.ratioOf(50, null), null)

// ---- 分块格子 ----
{
	const g = F.newGrid(10)
	jeq(F.gridCounts(g), { done: 0, retried: 0, active: 0, pending: 10 })
	F.gridRequest(g, 0, false)
	jeq(F.gridCounts(g), { done: 0, retried: 0, active: 1, pending: 9 })
	F.gridRequest(g, 1, false)
	jeq(F.gridCounts(g), { done: 1, retried: 0, active: 1, pending: 8 }, '设备要下一块 = 上一块已确认')
	F.gridRequest(g, 1, true)
	assert.equal(g.state[1], 1, '同一块再次请求仍是进行中')
	assert.equal(g.retried[1], 1)
	F.gridRequest(g, 2, false)
	jeq(F.gridCounts(g), { done: 1, retried: 1, active: 1, pending: 7 }, '重发过的块确认后单独计数')
	F.gridRequest(g, 0, true)
	assert.equal(g.state[0], 1, '回头重要旧块：重新进行中')
	assert.equal(g.state[2], 2, '上一进行中的块被确认')
	F.gridFinish(g)
	assert.equal(g.active, -1)
	assert.equal(F.gridCounts(g).active, 0)
	// 越界不炸
	F.gridRequest(g, 99, false)
	F.gridRequest(g, -1, false)
	F.gridFinish(null)
	assert.equal(F.gridCounts(null).pending, 0)
	// 合并成桶：含进行中 > 未完 > 含重发 > 已确认
	const h = F.newGrid(6)
	assert.equal(F.gridBucket(h, 0, 3), 0)
	F.gridRequest(h, 0, false)
	F.gridRequest(h, 1, false)
	F.gridRequest(h, 2, true)
	assert.equal(F.gridBucket(h, 0, 2), 2, '0、1 都已确认')
	assert.equal(F.gridBucket(h, 0, 3), 1, '含进行中的块')
	F.gridFinish(h)
	assert.equal(F.gridBucket(h, 0, 3), 3, '含重发过的块')
	assert.equal(F.gridBucket(h, 0, 4), 0, '含待发的块')
}

// ---- 事件归约与四步状态 ----
function stage(m) { return F.deriveStages(m).map((s) => s.key + ':' + s.state) }
{
	const m = F.newModel()
	jeq(stage(m), ['select:waiting', 'pack:waiting', 'upgrade:waiting', 'verify:waiting'])

	// 选文件：新固件内嵌版本、旧固件取名
	F.reducePack(m, { type: 'file', which: 'old', name: 'old.bin', size: 100, data: raw('V2.0.3') }, 1)
	F.reducePack(m, { type: 'file', which: 'new', name: 'new.bin', size: 200, data: raw('V2.1.0') }, 1)
	let st = F.deriveStages(m)
	assert.equal(st[0].state, 'done')
	assert.equal(st[0].summary, 'V2.0.3 → V2.1.0')
	assert.equal(st[1].summary, '待生成')

	// 生成：进行中 → 产物 → 完成，比例基准是 128 字节包头 + 新固件
	F.reducePack(m, { type: 'start' }, 2)
	assert.equal(m.pack.base, 128 + 200)
	assert.equal(F.deriveStages(m)[1].state, 'active')
	F.reducePack(m, { type: 'output', idx: 0, name: 'o.bin', size: 328, kind: 'origin' }, 2)
	F.reducePack(m, { type: 'output', idx: 1, name: 'c.bin', size: 164, kind: 'compress' }, 2)
	F.reducePack(m, { type: 'log', msg: '差分包(新→旧)失败: x', level: 'error' }, 2)
	F.reducePack(m, { type: 'end' }, 3)
	st = F.deriveStages(m)
	assert.equal(st[1].state, 'done')
	assert.equal(st[1].summary, '2 个产物 · 1 项失败')
	assert.equal(m.pack.selected, 0)
	assert.equal(F.ratioOf(m.pack.outputs[1].size, m.pack.outputs[1].base), 0.5)
	assert.equal(m.pack.notice.level, 'error')

	// 全部失败
	const m2 = F.newModel()
	F.reducePack(m2, { type: 'file', which: 'new', name: 'n.bin', size: 10, data: new Uint8Array(10) }, 1)
	F.reducePack(m2, { type: 'start' }, 1)
	F.reducePack(m2, { type: 'log', msg: '压缩包需要 BLANK.bin, 请选择 BLANK 文件', level: 'error' }, 1)
	F.reducePack(m2, { type: 'end' }, 1)
	assert.equal(F.deriveStages(m2)[1].state, 'failed')
	assert.match(F.deriveStages(m2)[0].summary, /^n\.bin/, '没有内嵌版本就显示文件名，不猜')
	// 取消目录选择
	const m3 = F.newModel()
	F.reducePack(m3, { type: 'file', which: 'new', name: 'n.bin', size: 10, data: new Uint8Array(10) }, 1)
	F.reducePack(m3, { type: 'start' }, 1)
	F.reducePack(m3, { type: 'end', aborted: true }, 1)
	assert.equal(F.deriveStages(m3)[1].state, 'waiting')
	assert.equal(F.deriveStages(m3)[1].summary, '已取消')
	// 清除新固件后 notice 清掉
	F.reducePack(m2, { type: 'file', which: 'new', name: '', size: 0, data: null }, 1)
	assert.equal(m2.pack.nw, null)
	assert.equal(m2.pack.notice, null)

	// 载入升级包 → 解析
	F.reduceUpgrade(m, { type: 'file-set', name: 'pkg.bin', size: 5000 }, 4)
	F.reduceUpgrade(m, { type: 'parsed', ok: true, raw: false, version: 'V2.1.0', pkgType: '原始包', size: 1000 }, 4)
	assert.equal(F.deriveStages(m)[2].state, 'waiting')
	assert.match(F.deriveStages(m)[2].summary, /已载入/)
	F.previewPlan(m, 128)
	assert.equal(m.up.plan.totalChunks, 8)
	assert.equal(m.up.plan.preview, true)
	assert.equal(m.up.grid.total, 8)
	const gridRef = m.up.grid
	F.previewPlan(m, 128)
	assert.equal(m.up.grid, gridRef, '参数没变不重建')
	F.previewPlan(m, 256)
	assert.equal(m.up.grid.total, 4, '分片大小变了重排')
	assert.equal(F.targetVersion(m), 'V2.1.0')

	// 升级过程
	F.reduceUpgrade(m, { type: 'start', version: 'V2.1.0', chunkSize: 128, size: 1000 }, 1000)
	F.reduceUpgrade(m, { type: 'plan', version: 'V2.1.0', chunkSize: 128, totalChunks: 8, size: 1000 }, 1000)
	assert.equal(m.up.plan.preview, undefined)
	F.reduceUpgrade(m, { type: 'phase', name: 'query' }, 1000)
	F.reduceUpgrade(m, { type: 'device-version', ok: true, source: 'upgrade', version: 'V2.0.3' }, 1100)
	assert.equal(m.up.pre, 'V2.0.3')
	F.reduceUpgrade(m, { type: 'phase', name: 'transfer' }, 2000)
	for (let i = 0; i < 4; i++) {
		F.reduceUpgrade(m, { type: 'request', index: i, resend: false, total: 8 }, 2000 + i * 1000)
		F.reduceUpgrade(m, { type: 'chunk', index: i, resend: false, sent: i + 1, total: 8, bytes: 128 }, 2000 + i * 1000)
	}
	F.reduceUpgrade(m, { type: 'request', index: 3, resend: true, total: 8 }, 6000)
	F.reduceUpgrade(m, { type: 'chunk', index: 3, resend: true, sent: 4, total: 8, bytes: 128 }, 6000)
	F.reduceUpgrade(m, { type: 'progress', percent: 38 }, 6000)
	jeq(F.gridCounts(m.up.grid), { done: 3, retried: 0, active: 1, pending: 4 })
	assert.equal(m.up.grid.retried[3], 1)
	let s3 = F.deriveStages(m)[2]
	assert.equal(s3.state, 'active')
	assert.equal(s3.summary, '传输分块 4/8 · 38%')
	// 速率：4 块 × 128 B，传输开始 2000 → 6000 ms；剩余按平均每块 1 s 算
	const stats = F.computeStats(m, 6000)
	assert.equal(stats.rate, 128)
	assert.equal(stats.eta, 4)
	assert.equal(F.computeStats(F.newModel(), 1).rate, null)

	// 结束：成功后校验页等查询
	F.reduceUpgrade(m, { type: 'phase', name: 'result' }, 9000)
	F.reduceUpgrade(m, { type: 'progress', percent: 100 }, 9500)
	F.reduceUpgrade(m, { type: 'end', ok: true, stopped: false, error: '' }, 10000)
	assert.equal(m.up.grid.active, -1)
	assert.equal(F.deriveStages(m)[2].state, 'done')
	assert.equal(F.deriveStages(m)[3].state, 'waiting')
	assert.equal(F.computeStats(m, 99999).eta, null, '结束后不再有剩余时间')
	// 升级后查询一致
	F.reduceUpgrade(m, { type: 'query-start' }, 10100)
	assert.equal(F.deriveStages(m)[3].state, 'active')
	F.reduceUpgrade(m, { type: 'device-version', ok: true, source: 'query', version: 'V2.1.0' }, 10200)
	assert.equal(m.up.post, 'V2.1.0')
	jeq(F.deriveStages(m)[3], { key: 'verify', name: '校验', state: 'done', summary: '一致 · V2.1.0' })
	// 不一致
	F.reduceUpgrade(m, { type: 'device-version', ok: true, source: 'query', version: 'V2.0.3' }, 10300)
	assert.equal(F.deriveStages(m)[3].state, 'failed')
	// 查询失败不覆盖已有结果，只记错误
	F.reduceUpgrade(m, { type: 'device-version', ok: false, source: 'query', error: '超时' }, 10400)
	assert.equal(m.up.post, 'V2.0.3')
	assert.equal(m.up.queryError, '超时')
	// 换文件：结果、版本、分块全部作废
	F.reduceUpgrade(m, { type: 'file-set', name: 'other.bin', size: 10 }, 11000)
	assert.equal(m.up.outcome, null)
	assert.equal(m.up.post, null)
	assert.equal(m.up.pre, null)
	assert.equal(m.up.grid, null)
	assert.equal(F.deriveStages(m)[3].state, 'waiting')
}

// ---- 失败 / 停止 / 升级前手动查询 ----
{
	const m = F.newModel()
	F.reduceUpgrade(m, { type: 'file-set', name: 'pkg.bin', size: 100 }, 1)
	F.reduceUpgrade(m, { type: 'parsed', ok: true, raw: true, version: 'V9', size: 100 }, 1)
	// 升级前手动查询 → 当前版本(升级前)，不是升级后
	F.reduceUpgrade(m, { type: 'device-version', ok: true, source: 'query', version: 'V8' }, 2)
	assert.equal(m.up.pre, 'V8')
	assert.equal(m.up.post, null)
	F.reduceUpgrade(m, { type: 'start', version: 'V9', chunkSize: 128, size: 100 }, 3)
	F.reduceUpgrade(m, { type: 'log', msg: '设备拒绝升级: 电量不足', level: 'error' }, 4)
	F.reduceUpgrade(m, { type: 'end', ok: false, stopped: false, error: '设备拒绝升级: 电量不足' }, 5)
	let s = F.deriveStages(m)[2]
	assert.equal(s.state, 'failed')
	assert.equal(s.summary, '设备拒绝升级: 电量不足')
	assert.equal(m.up.notice.level, 'error')
	// 失败后手动查询不算升级后结果
	F.reduceUpgrade(m, { type: 'device-version', ok: true, source: 'query', version: 'V9' }, 6)
	assert.equal(m.up.post, null)
	assert.equal(m.up.pre, 'V9')
	// 停止
	F.reduceUpgrade(m, { type: 'start', version: 'V9', chunkSize: 128, size: 100 }, 7)
	F.reduceUpgrade(m, { type: 'progress', percent: 30 }, 8)
	F.reduceUpgrade(m, { type: 'end', ok: false, stopped: true, error: '' }, 9)
	s = F.deriveStages(m)[2]
	assert.equal(s.state, 'waiting')
	assert.equal(s.summary, '已停止 · 30%')
	// 解析失败
	const m2 = F.newModel()
	F.reduceUpgrade(m2, { type: 'file-set', name: 'bad.bin', size: 5 }, 1)
	F.reduceUpgrade(m2, { type: 'parsed', ok: false, error: '魔数校验不通过' }, 1)
	assert.equal(F.deriveStages(m2)[2].state, 'failed')
	F.reduceUpgrade(m2, { type: 'file-clear' }, 2)
	assert.equal(F.deriveStages(m2)[2].state, 'waiting')
	// 不经打包直接载入升级包：第 1、2 步按「已跳过」
	const m3 = F.newModel()
	F.reduceUpgrade(m3, { type: 'file-set', name: 'pkg.bin', size: 5 }, 1)
	jeq(F.deriveStages(m3).slice(0, 2).map((x) => x.state + ':' + x.summary), ['done:直接载入升级包', 'done:已跳过'])
}

console.log('modern-firmware: ok')
