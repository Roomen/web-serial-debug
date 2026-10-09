// Run: node tests/blu-serial-lane.cjs — synthetic data only.
// 覆盖: 功耗分析串口事件道 js/blu-serial-lane.js 的纯函数（二分、锚点时间映射、密集合并、日志行索引）
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const ctx = { console, Date, Math }
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/blu-serial-lane.js'), 'utf8'), ctx)
const L = ctx.BluSerialLane
assert.ok(L && typeof L.createAnchorTrack === 'function')
assert.equal(L.draw, undefined, 'node 下不挂界面')

// ---- 二分 ----
{
	const a = [1, 3, 3, 3, 7, 9]
	assert.equal(L.lowerBound(a, 3), 1)
	assert.equal(L.upperBound(a, 3), 4)
	assert.equal(L.lowerBound(a, 0), 0)
	assert.equal(L.upperBound(a, 100), 6)
	assert.equal(L.lowerBound([], 5), 0)
	assert.deepEqual(Array.from(L.visibleSlice(a, 3, 7)), [1, 5])
	assert.deepEqual(Array.from(L.visibleSlice(a, 4, 6)), [4, 4])
	assert.deepEqual(Array.from(L.visibleSlice(a, 8, 2)), [0, 0], '反向区间为空')
}

// ---- 锚点：均匀 1 kHz，墙钟偏移固定 ----
{
	const OFF = 1.7e12
	const tr = L.createAnchorTrack({ intervalMs: 200, gapMs: 20, wallOffset: () => OFF })
	assert.equal(tr.has(), false)
	assert.equal(tr.wallToLi(OFF), null)
	for (let i = 0; i < 5000; i++) tr.note(i, 1000 + i) // 1 ms/点
	assert.equal(tr.has(), true)
	assert.ok(tr.anchorCount() <= 26, '稀疏记录：约每 200 ms 一个')
	const r = tr.range()
	assert.equal(r.li0, 0)
	assert.equal(r.li1, 4999)
	assert.equal(r.wall0, OFF + 1000)
	assert.equal(r.wall1, OFF + 5999)
	assert.ok(Math.abs(tr.wallToLi(OFF + 1000 + 1234.5) - 1234.5) < 1e-6)
	assert.ok(Math.abs(tr.wallToLi(OFF + 5999) - 4999) < 1e-6, '末样点虚拟锚点')
	assert.equal(tr.wallToLi(OFF + 999), null, '采集前')
	assert.equal(tr.wallToLi(OFF + 6000), null, '采集后')
	assert.ok(Math.abs(tr.liToWall(2500) - (OFF + 3500)) < 1e-6)
	tr.reset()
	assert.equal(tr.has(), false)
	assert.equal(tr.range(), null)
}

// ---- 锚点：停采后续采的间隙不能摊到前一段 ----
{
	const tr = L.createAnchorTrack({ intervalMs: 200, gapMs: 20, wallOffset: () => 0 })
	for (let i = 0; i < 1000; i++) tr.note(i, i) // 0..999 ms
	for (let i = 1000; i < 2000; i++) tr.note(i, 10000 + (i - 1000)) // 10 s 后续采
	// 第一段末尾附近仍按 1 ms/点
	assert.ok(Math.abs(tr.wallToLi(990) - 990) < 1e-6)
	// 第二段起点
	assert.ok(Math.abs(tr.wallToLi(10000) - 1000) < 1e-6)
	// 间隙里的事件落在两段交界（999..1000 之间）
	const mid = tr.wallToLi(5000)
	assert.ok(mid > 999 && mid < 1000)
}

// ---- 锚点：毫秒级墙钟漂移不分段 ----
{
	let off = 100
	const tr = L.createAnchorTrack({ intervalMs: 10, gapMs: 50, wallOffset: () => off })
	for (let i = 0; i < 20; i++) tr.note(i, i)
	off = 97 // NTP 小幅调整：仍是同一段
	for (let i = 20; i < 40; i++) tr.note(i, i)
	assert.equal(tr.segmentCount(), 1)
	// performance 时间轴上的映射不受墙钟影响
	assert.ok(Math.abs(tr.perfToLi(25.5) - 25.5) < 1e-9)
	assert.ok(Math.abs(tr.liToPerf(12) - 12) < 1e-9)
}

// ---- 锚点：系统时钟回拨开新段，不钳位 ----
{
	let off = 1000
	const tr = L.createAnchorTrack({ intervalMs: 10, gapMs: 50, jumpMs: 5, wallOffset: () => off })
	for (let i = 0; i < 100; i++) tr.note(i, i) // 墙钟 1000..1099
	off = 950 // 回拨 50 ms：之后墙钟 1050..1149，与前段 1050..1099 重叠
	for (let i = 100; i < 200; i++) tr.note(i, i)
	assert.equal(tr.segmentCount(), 2)
	// 回拨前的事件(墙钟只在旧段里)：落回原样点
	assert.ok(Math.abs(tr.wallToLi(1020) - 20) < 1e-6)
	// 只在新段里的墙钟
	assert.ok(Math.abs(tr.wallToLi(1140) - 190) < 1e-6)
	// 重叠区取最新一段(回拨之后的实时日志)
	assert.ok(Math.abs(tr.wallToLi(1070) - 120) < 1e-6)
	// performance 时间戳(实时行走这条路)不受回拨影响：两边都精确
	assert.ok(Math.abs(tr.perfToLi(70) - 70) < 1e-9)
	assert.ok(Math.abs(tr.perfToLi(120) - 120) < 1e-9)
	assert.equal(tr.wallToPerf(1020), 20)
	assert.equal(tr.wallToPerf(1070), 120)
	// liToWall 按样点所在段的偏移
	assert.equal(tr.liToWall(50), 1050)
	assert.equal(tr.liToWall(150), 1100)
	// 钳位方案会把回拨后的样点全部压到 1099 附近；分段后墙钟保持真实值
	assert.ok(tr.liToWall(199) - tr.liToWall(100) > 90)
	// 系统时钟前跳同样开段，前跳的间隙不会摊到相邻样点上
	off = 5000
	for (let i = 200; i < 300; i++) tr.note(i, i)
	assert.equal(tr.segmentCount(), 3)
	assert.ok(Math.abs(tr.wallToLi(5250) - 250) < 1e-6)
	assert.ok(Math.abs(tr.wallToLi(1140) - 190) < 1e-6)
	const r = tr.range()
	assert.equal(r.t0, 0)
	assert.equal(r.t1, 299)
}

// ---- 日志行带 performance 时间时按它排序与对齐 ----
{
	const rows = [
		{ 'data-ts': '5000', 'data-dir': 'tx', 'data-sid': 'S', 'data-seq': '1' },
		{ 'data-ts': '4000', 'data-dir': 'rx', 'data-sid': 'S', 'data-seq': '2' }, // 回拨后的墙钟更小
	]
	const pts = [10, 20]
	const fr = (a) => ({ getAttribute(k) { return Object.prototype.hasOwnProperty.call(a, k) ? a[k] : null } })
	const es = rows.map((a, i) => L.entryFromRow(fr(a), () => pts[i]))
	assert.equal(es[0].pt, 10)
	const lanes = L.buildLanes(es, false)
	assert.deepEqual(Array.from(lanes.S.ts), [10, 20], '按 performance 时间(真实先后)排序')
	assert.equal(lanes.S.items[0].ts, 5000, '展示仍用墙钟')
}

// ---- 规模：长采集的锚点 × 大量日志，插值不复制锚点数组 ----
{
	const tr = L.createAnchorTrack({ intervalMs: 200, gapMs: 20, wallOffset: () => 1.7e12 })
	// 1 小时 @ 5 点/s 的入库节奏 ≈ 18k 锚点；末样点不是锚点(走虚拟末点分支)
	for (let i = 0; i < 18000; i++) tr.note(i * 40, i * 200)
	tr.note(18000 * 40, 18000 * 200 - 100)
	assert.ok(tr.anchorCount() >= 17999)
	const span = 18000 * 200 - 100
	const N = 10000
	let sum = 0
	const t0 = process.hrtime.bigint()
	for (let k = 0; k < N; k++) {
		const li = tr.wallToLi(1.7e12 + (k / N) * span)
		sum += li
	}
	for (let k = 0; k < N; k++) sum += tr.perfToLi((k / N) * span)
	const ms = Number(process.hrtime.bigint() - t0) / 1e6
	assert.ok(sum > 0)
	// 每次复制 18k 数组时这里是数百毫秒；二分不复制只要几毫秒。阈值放宽到 50 ms 防机器抖动
	assert.ok(ms < 50, '2 万次映射耗时 ' + ms.toFixed(1) + ' ms')
	// 末样点虚拟锚点仍然正确
	assert.ok(Math.abs(tr.perfToLi(span) - 18000 * 40) < 1e-6)
	assert.ok(Math.abs(tr.perfToLi(span - 50) - (17999 * 40 + 20)) < 1e-6)
}

// ---- 密集合并 ----
{
	const b = L.mergeMarks([10, 11, 13, 30, 31, 50], 4, 48)
	assert.equal(b.length, 3)
	assert.deepEqual(JSON.parse(JSON.stringify(b[0])), { x0: 10, x1: 13, n: 3, i0: 0, i1: 2 })
	assert.deepEqual(JSON.parse(JSON.stringify(b[1])), { x0: 30, x1: 31, n: 2, i0: 3, i1: 4 })
	assert.equal(b[2].n, 1)
	// 按相邻间距链式合并：一串紧挨的帧并成一块
	const chain = L.mergeMarks([0, 3, 6, 9, 12], 4, 48)
	assert.equal(chain.length, 1)
	assert.equal(chain[0].n, 5)
	assert.equal(L.mergeMarks([0, 5, 10], 4, 48).length, 3, '间距超过阈值不合并')
	assert.equal(L.mergeMarks([], 4, 48).length, 0)
	// 一万帧铺满 100 px：块宽封顶，块数受像素宽度约束，总数守恒
	const xs = []
	for (let i = 0; i < 10000; i++) xs.push(i / 100)
	const many = L.mergeMarks(xs, 4, 48)
	assert.ok(many.length >= 2 && many.length <= 3, String(many.length))
	assert.ok(many.every(m => m.x1 - m.x0 <= 48))
	assert.equal(many.reduce((s, x) => s + x.n, 0), 10000)
	// 不给上限时整段连成一块
	assert.equal(L.mergeMarks(xs, 4).length, 1)
}

// ---- 日志行索引 ----
function fakeRow(attrs) {
	return { getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null } }
}
{
	assert.equal(L.entryFromRow(fakeRow({ 'data-dir': 'rx' })), null, '无时间戳')
	assert.equal(L.entryFromRow(null), null)
	const e = L.entryFromRow(fakeRow({ 'data-ts': '1700000000123', 'data-dir': 'weird', 'data-sid': 'A', 'data-seq': '9' }))
	assert.equal(e.ts, 1700000000123)
	assert.equal(e.dir, 'sys')

	const rows = [
		{ 'data-ts': '100', 'data-dir': 'tx', 'data-sid': 'A', 'data-seq': '1' },
		{ 'data-ts': '105', 'data-dir': 'rx', 'data-sid': 'B', 'data-seq': '2' },
		{ 'data-ts': '103', 'data-dir': 'rx', 'data-sid': 'A', 'data-seq': '3' }, // 乱序
		{ 'data-ts': '110', 'data-dir': 'sys', 'data-sid': 'SYS', 'data-seq': '4' },
	].map(a => L.entryFromRow(fakeRow(a)))
	const dual = L.buildLanes(rows, true)
	assert.deepEqual(Array.from(dual.A.ts), [100, 103, 110])
	assert.deepEqual(Array.from(dual.B.ts), [105])
	assert.equal(dual.A.items[2].dir, 'sys')
	const single = L.buildLanes(rows, false)
	assert.deepEqual(Object.keys(single), ['S'])
	assert.deepEqual(Array.from(single.S.ts), [100, 103, 105, 110])
	assert.equal(L.laneKeyOf('B', true), 'B')
	assert.equal(L.laneKeyOf('SYS', true), 'A')
	assert.equal(L.laneKeyOf('B', false), 'S')
}

// ---- HEX 预览与格式 ----
{
	const hex = Array.from({ length: 20 }, (_, i) => ('0' + i.toString(16).toUpperCase()).slice(-2)).join(' ')
	assert.equal(L.hexByteLen(hex), 20)
	assert.equal(L.hexByteLen(''), 0)
	assert.equal(L.hexPreview(hex, 16), '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F …')
	assert.equal(L.hexPreview('AA BB', 16), 'AA BB')
	assert.match(L.fmtClock(new Date(2026, 0, 2, 3, 4, 5, 6).getTime()), /^03:04:05\.006$/)
}

console.log('blu-serial-lane: ok')
