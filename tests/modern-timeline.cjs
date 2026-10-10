// Run: node tests/modern-timeline.cjs — synthetic data only.
// 覆盖: 现代布局双路时间线 js/modern-timeline.js 与检查器结构化视图 js/modern-inspector.js 的纯函数
// (时间/Δ/静默格式、Δ 与静默与慢应答的逐条计算、交互区间、持久化清理、视图模型拍平与摘要)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const ctx = { console, Date, Math, String, Array }
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/modern-timeline.js'), 'utf8'), ctx)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/modern-inspector.js'), 'utf8'), ctx)
// vm 上下文里造出来的数组/对象原型不同，按 JSON 比较
const J = (x) => JSON.parse(JSON.stringify(x))
const deepEqual = (a, b) => assert.deepEqual(J(a), J(b))
const T = ctx.ModernTimeline
const I = ctx.ModernInspector
assert.ok(T && typeof T.compute === 'function')
assert.ok(I && typeof I.flattenModel === 'function')

// ---- 格式 ----
{
	assert.equal(T.fmtDelta(0), '+0 ms')
	assert.equal(T.fmtDelta(31), '+31 ms')
	assert.equal(T.fmtDelta(999.4), '+999 ms')
	assert.equal(T.fmtDelta(1470), '+1.47 s')
	assert.equal(T.fmtDelta(12345), '+12.3 s')
	assert.equal(T.fmtDelta(-5), '+0 ms')
	assert.equal(T.fmtGap(4600), '4.6 s')
	assert.equal(T.fmtGap(125000), '2 min 5 s')
	assert.equal(T.fmtGap(3 * 3600000 + 5 * 60000), '3 h 5 min')
	const d = new Date(2026, 9, 9, 10, 21, 9, 20).getTime()
	assert.equal(T.fmtClock(d), '10:21:09.020')
}

const mk = (sid, dir, ts) => ({ sid, dir, ts })

// ---- compute：设计稿里的一段会话 ----
{
	const items = [
		mk('A', 'tx', 0), // 0 首条
		mk('B', 'rx', 31), // 1 B 没有待应答 TX
		mk('A', 'rx', 251), // 2 A 的第一条 RX，应答 0.251 s，不慢
		mk('A', 'tx', 4851), // 3 间隔 4.6 s -> 静默
		mk('B', 'rx', 4883),
		mk('B', 'rx', 5011),
		mk('A', 'rx', 5132), // 6 应答 281 ms
		mk('B', 'tx', 5831),
		mk('B', 'rx', 5851),
		mk('A', 'sys', 6000), // 9 系统行：不参与
		mk('A', 'tx', 8251), // 10 距上一条 2.4 s -> 静默(系统行不打断也不占 Δ)
		mk('A', 'rx', 9723), // 11 应答 1.472 s -> 慢
	]
	const r = T.compute(items)
	assert.equal(r.length, items.length)
	deepEqual([r[0].d, r[0].gap], ['', ''])
	assert.equal(r[1].d, '+31 ms')
	assert.equal(r[2].d, '+220 ms')
	assert.equal(r[2].slow, false)
	assert.equal(r[2].req, 0)
	assert.equal(r[3].gap, '4.6 s')
	assert.equal(r[3].d, '', '静默之后的第一条不显示 Δ')
	assert.equal(r[4].d, '+32 ms')
	assert.equal(r[4].req, -1, 'B 路没有待应答的 TX')
	assert.equal(r[6].req, 3)
	assert.equal(r[6].slow, false)
	assert.equal(r[8].req, 7)
	assert.equal(r[9].lane, false)
	assert.equal(r[9].t, '')
	assert.equal(r[10].gap, '2.4 s')
	assert.equal(r[11].slow, true)
	assert.equal(r[11].d, '+1.47 s', '慢应答的 Δ 显示应答耗时')
	assert.equal(r[11].req, 10)
	// 同一个 TX 之后只有第一条 RX 算应答
	assert.equal(r[5].req, -1)
}

// ---- 慢应答阈值与静默阈值 ----
{
	const items = [mk('A', 'tx', 0), mk('A', 'rx', 1000), mk('A', 'tx', 1500), mk('A', 'rx', 2501)]
	const r = T.compute(items)
	assert.equal(r[1].slow, false, '恰好等于阈值不算慢')
	assert.equal(r[3].slow, true)
	assert.equal(T.compute(items, { slowMs: 100 })[1].slow, true)
	// 距上一条恰好 2000 ms 不算静默，2001 才算
	assert.equal(T.compute([mk('A', 'tx', 0), mk('B', 'rx', 2000)])[1].gap, '')
	assert.equal(T.compute([mk('A', 'tx', 0), mk('B', 'rx', 2001)])[1].gap, '2.0 s')
	// 慢应答跨过静默：Δ 仍显示应答耗时(红)，静默胶囊也在
	const r2 = T.compute([mk('A', 'tx', 0), mk('A', 'rx', 3000)])
	assert.equal(r2[1].gap, '3.0 s')
	assert.equal(r2[1].slow, true)
	assert.equal(r2[1].d, '+3.00 s')
	// 时间戳回退按 0 处理
	assert.equal(T.compute([mk('A', 'tx', 100), mk('A', 'rx', 50)])[1].d, '+0 ms')
}

// ---- 增量：分批算与一次算一致 ----
{
	const items = []
	for (let i = 0; i < 40; i++) items.push(mk(i % 3 === 0 ? 'B' : 'A', i % 2 ? 'rx' : 'tx', i * 700 + (i % 5) * 90))
	const whole = T.compute(items)
	const st = T.newState()
	const parts = [].concat(T.compute(items.slice(0, 13), null, st), T.compute(items.slice(13, 14), null, st), T.compute(items.slice(14), null, st))
	deepEqual(parts.map((x) => [x.t, x.d, x.slow, x.gap]), whole.map((x) => [x.t, x.d, x.slow, x.gap]))
}

// ---- 交互区间 ----
{
	const items = [
		mk('A', 'tx', 0), // 0
		mk('B', 'rx', 32), // 1
		mk('A', 'sys', 40), // 2
		mk('B', 'rx', 160), // 3
		mk('A', 'rx', 281), // 4 应答
		mk('B', 'tx', 700), // 5
		mk('A', 'tx', 800), // 6 没等到应答就又发了
		mk('A', 'tx', 900), // 7
		mk('A', 'rx', 950), // 8 应答 7
		mk('A', 'rx', 960), // 9 持续上报
	]
	const r = T.compute(items)
	deepEqual(T.exchange(items, r, 0), { start: 0, end: 4 }, 'TX 到本路下一条应答，覆盖其间两路与系统行')
	deepEqual(T.exchange(items, r, 4), { start: 0, end: 4 }, 'RX 回溯到它应答的请求')
	deepEqual(T.exchange(items, r, 1), { start: 1, end: 1 }, 'B 的 RX 没有请求')
	deepEqual(T.exchange(items, r, 5), { start: 5, end: 5 }, 'B 的 TX 还没有应答')
	deepEqual(T.exchange(items, r, 6), { start: 6, end: 6 }, '又发了新请求：这一笔没有应答')
	deepEqual(T.exchange(items, r, 7), { start: 7, end: 8 })
	deepEqual(T.exchange(items, r, 9), { start: 9, end: 9 }, 'TX 后的第二条 RX 只有自己')
	assert.equal(T.exchange(items, r, 2), null, '系统行没有交互区间')
	assert.equal(T.awaitingReply(items, 0), false, '已收到应答的 TX 不再等待')
	assert.equal(T.awaitingReply(items, 5), true, '另一条路收发不终结等待')
	assert.equal(T.awaitingReply(items, 6), false, '同路新请求取代旧请求，不再扫描旧请求的区间')
	assert.equal(T.awaitingReply(items, 9), false, 'RX 不等待应答')
}

// ---- 持久化清理 ----
{
	const clean = ctx.serialLogPersistClean
	const html = '<div class="log-row selected" data-dir="tx" data-mdn-t="10:21:09.020" data-mdn-d="+31 ms" data-mdn-slow="1" data-mdn-band="1"><span class="log-time" data-mdn-gap="4.6 s">10:21</span><span class="log-body">x data-mdn-t="keep"</span></div>'
	const out = clean(html)
	assert.ok(!/ data-mdn-[a-z-]+="[^"]*"(?=[ >])/.test(out.replace('x data-mdn-t="keep"', '')), out)
	assert.ok(out.includes('class="log-row selected" data-dir="tx"'))
	assert.ok(out.includes('<span class="log-time">10:21</span>'))
	assert.equal(clean('<div class="log-row"></div>'), '<div class="log-row"></div>')
	assert.equal(clean(''), '')
}

// ---- 检查器：视图模型拍平 ----
{
	deepEqual(I.normalizeModels(null), [])
	deepEqual(I.normalizeModels([null, { title: 'a' }, 3]), [{ title: 'a' }])
	assert.equal(I.normalizeModels({ title: 'x' }).length, 1)
	const m = {
		title: '设置 · 上报周期',
		code: '0x10',
		subject: { label: '设备', value: '12907856341200' },
		badges: [{ text: 'CRC ✓', kind: 'ok' }, { text: '', kind: 'bad' }, { text: '新', kind: 'weird' }],
		meta: [['帧序号', '5'], ['空', ''], ['版本', null]],
		notes: [{ text: '提示', kind: 'warn' }, { text: '' }],
		sections: [{
			title: '数据',
			groups: [{ title: '组', pairs: [['a', '1', '说明', 'ok']] }, { title: '空组', pairs: [] }],
			pairs: [['b', 2]],
			pre: 'raw',
			html: '<b>x</b>',
			errors: ['坏'],
		}],
		errors: ['总错'],
	}
	const blocks = I.flattenModel(m)
	deepEqual(blocks.map((b) => b.type), ['kv', 'kv', 'note', 'title', 'subtitle', 'kv', 'kv', 'pre', 'html', 'err', 'err'])
	deepEqual(blocks[0], { type: 'kv', k: '设备', v: '12907856341200', hint: '', kind: '' })
	assert.equal(blocks[1].k, '帧序号')
	assert.equal(blocks[2].kind, 'warn')
	deepEqual(blocks[5], { type: 'kv', k: 'a', v: '1', hint: '说明', kind: 'ok' })
	assert.equal(blocks[6].v, '2')
	assert.equal(blocks[8].html, '<b>x</b>')
	const sum = I.buildSummary([m], { proto: 'SEK', time: '10:21:09.020', len: 26, latency: '应答耗时 281 ms' })
	assert.equal(sum.title, '设置 · 上报周期')
	assert.equal(sum.code, '0x10')
	deepEqual(sum.parts, ['SEK', '10:21:09.020', '26 字节', '应答耗时 281 ms'])
	deepEqual(sum.badges.map((b) => [b.text, b.kind]), [['CRC ✓', 'ok'], ['新', '']])
	const bare = I.buildSummary([], { proto: '', time: '', len: null, latency: '' })
	assert.equal(bare.title, '帧')
	deepEqual(bare.parts, [])
	assert.equal(I.fmtLatency(214), '应答耗时 214 ms')
	assert.equal(I.fmtLatency(1472), '应答耗时 1.47 s')
	const rows = I.chunkBytes(new Uint8Array(37), 16)
	deepEqual(rows.map((r) => [r.off, r.bytes.length]), [[0, 16], [16, 16], [32, 5]])
}

console.log('modern-timeline: ok')
