#!/usr/bin/env node
/**
 * Tag5-ID20 正逆累计历史解析测试：node tools/sk-period20-test/run_period20_test.js
 * 报文由本文件按协议自行编码（与设备端编码器同规则），再喂给网页解析器比对。
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '../..')

// 时间轴必须与浏览器时区无关：同一套断言在夏令时/非夏令时/东八区下各跑一遍。
// 纽约是关键用例——2026-03-08 02:00 在本地墙钟算术里不存在，会被悄悄挪成 03:00。
if (!process.env.P20_TZ_CHILD) {
	const { spawnSync } = require('child_process')
	let bad = 0
	for (const tz of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
		const r = spawnSync(process.execPath, [__filename], {
			env: Object.assign({}, process.env, { TZ: tz, P20_TZ_CHILD: '1' }),
			encoding: 'utf8'
		})
		process.stdout.write('TZ=' + tz + ': ' + (r.stdout || '').trim() + '\n')
		if (r.stderr) process.stderr.write(r.stderr)
		if (r.status !== 0) bad++
	}
	process.exit(bad ? 1 : 0)
}

function loadWeb() {
	const ctx = {
		window: {}, console, TextEncoder, TextDecoder, Uint8Array, Array,
		parseInt, String, Number, Date, Error, Math, JSON, BigInt, DataView, ArrayBuffer, Set, isFinite
	}
	ctx.window = ctx
	for (const f of ['js/protocol-schema.js', 'js/protocol-crypto.js', 'js/protocol.js']) {
		vm.runInNewContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f })
	}
	return ctx
}

const INT64_MAX = (1n << 63n) - 1n

/* ---------- 编码侧（镜像固件规则，用于造测试报文） ---------- */
function u16le(v) { return [v & 0xff, (v >> 8) & 0xff] }
function u64le(v) {
	const out = []
	let x = BigInt(v)
	for (let i = 0; i < 8; i++) { out.push(Number(x & 0xffn)); x >>= 8n }
	return out
}
function wallSeconds(s) { // 'YYYYMMDDhhmmss' 当墙钟读数，按 UTC 解释成秒
	return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)) / 1000
}
function bcd7(s) { // 'YYYYMMDDhhmmss'
	const out = []
	for (let i = 0; i < 14; i += 2) out.push((+s[i] << 4) | +s[i + 1])
	return out
}
function varint(z) {
	const out = []
	let x = BigInt(z)
	do {
		let b = Number(x & 0x7fn)
		x >>= 7n
		if (x !== 0n) b |= 0x80
		out.push(b)
	} while (x !== 0n)
	return out
}
function zigzag(d) { return d >= 0n ? d * 2n : -d * 2n - 1n }
function channel(value, prev) {
	if (value === prev) return { mode: 0, bytes: [] }
	const v = varint(zigzag(value - prev))
	if (v.length >= 8) return { mode: 2, bytes: u64le(value) }
	return { mode: 1, bytes: v }
}
/** points: [[forward, reverse], ...]（BigInt），opt 可覆盖头部字段以构造非法报文 */
function buildTag5Id20(points, opt) {
	opt = opt || {}
	const unitCode = opt.unitCode != null ? opt.unitCode : 4
	const interval = opt.interval != null ? opt.interval : 30
	const start = opt.start || '20260315081500'
	// 设备墙钟按 UTC 解释后减去设备时区偏移 = 8B UTC 秒时间戳（与固件 comConvTimestampToBcd 一致）
	const wall = wallSeconds(start)
	const ts = opt.ts != null ? opt.ts : BigInt(wall - (opt.tzOffsetSec || 0))
	const fmt = opt.fmt != null ? opt.fmt : (unitCode << 5)
	const body = []
	body.push(20)
	body.push(...bcd7(start))
	body.push(...u64le(ts))
	body.push(...u16le(interval))
	body.push(fmt)
	body.push(...u64le(points[0][0]))
	body.push(...u64le(points[0][1]))
	body.push(...u16le(opt.declaredN != null ? opt.declaredN : points.length - 1))
	let pf = points[0][0], pr = points[0][1]
	for (let i = 1; i < points.length; i++) {
		const f = channel(points[i][0], pf)
		const r = channel(points[i][1], pr)
		let status = f.mode | (r.mode << 2)
		if (opt.resetAt != null && opt.resetAt === i) status |= 0x10
		body.push(status, ...f.bytes, ...r.bytes)
		pf = points[i][0]; pr = points[i][1]
	}
	if (opt.extraRecordBytes) body.push(...opt.extraRecordBytes)
	return new Uint8Array([5, ...u16le(body.length), ...body])
}

/* ---------- 断言 ---------- */
let pass = 0, fail = 0
function check(name, cond, extra) {
	if (cond) { pass++; return }
	fail++
	console.error('FAIL ' + name + (extra ? '\n      ' + extra : ''))
}
function eq(name, got, want) { check(name, got === want, 'got  ' + got + '\n      want ' + want) }

const W = loadWeb()
function parse(bytes) {
	const tlv = W.skParseTlv ? W.skParseTlv(bytes) : null
	if (!tlv) throw new Error('skParseTlv 未导出')
	return tlv
}
function id20(bytes) {
	const tlv = parse(bytes)
	check('单个 Tag5', tlv.length === 1 && tlv[0].tag === 5, JSON.stringify(tlv.map(t => t.tag)))
	const it = (tlv[0].items || []).find(x => x.id === 20)
	if (!it) throw new Error('未解析出 ID20: ' + JSON.stringify(tlv[0].items))
	return it
}
function cells(it) { return (it.seriesRows || []).map(r => r.cells) }

/* 1. 说明里给出的已知记录序列 */
{
	const pts = [[1000n, 20n], [1000n, 20n], [1005n, 20n], [1010n, 23n], [21010n, 23n]]
	const frame = buildTag5Id20(pts)
	const recs = Array.from(frame.slice(40))
	eq('已知记录字节', recs.join(' '), '0 1 10 5 10 6 1 192 184 2')
	eq('总长 = 40 + 10', frame.length, 50)
	const it = id20(frame)
	check('无错误', !it.partial, it.decoded)
	eq('行数 = 1 起始 + 4 后续', it.seriesRows.length, 5)
	eq('列头', it.seriesCols.join(','), '时间,正累计,逆累计,说明')
	const c = cells(it)
	eq('起始时间标签', c[0][0], '2026-03-15 08:15:00')
	eq('第4点时间 = T0+4*30min', c[4][0], '2026-03-15 10:15:00')
	eq('起始正累计', c[0][1], '1 m³')
	eq('起始逆累计', c[0][2], '20 L')
	eq('第2点正累计', c[2][1], '1.005 m³')
	eq('第3点逆累计', c[3][2], '23 L')
	eq('第4点正累计换算 m³', c[4][1], '21.01 m³')
	check('摘要含当量', /当量1L/.test(it.seriesSummary), it.seriesSummary)
	check('摘要含点数', /起始点\+4 后续点\(实得 4\)/.test(it.seriesSummary), it.seriesSummary)
	check('摘要含间隔', /间隔30分钟/.test(it.seriesSummary), it.seriesSummary)
	check('摘要含 UTC', it.seriesSummary.indexOf('UTC ' + wallSeconds('20260315081500')) >= 0, it.seriesSummary)
	eq('消费整段', it.span, frame.length - 3)
}

/* 2. 两路均不变：状态 00，不消费任何数据字节 */
{
	const pts = [[500n, 7n], [500n, 7n], [500n, 7n]]
	const frame = buildTag5Id20(pts)
	eq('两路不变每点 1B', frame.length, 40 + 2)
	const c = cells(id20(frame))
	eq('不变点仍有行', c.length, 3)
	eq('不变点正累计', c[2][1], '500 L')
	eq('不变点说明', c[2][3], '正不变 逆不变')
}

/* 3. 负差（读数下降）忠实还原，且不伪造设底度事件 */
{
	const pts = [[1000n, 0n], [995n, 0n]]
	const frame = buildTag5Id20(pts)
	eq('负差记录字节', Array.from(frame.slice(40)).join(' '), '1 9')
	const it = id20(frame)
	eq('负差后读数', cells(it)[1][1], '995 L')
	eq('负差说明', cells(it)[1][3], '正-5 逆不变')
	check('未伪造设底度', !/设底度/.test(it.seriesSummary + cells(it)[1][3]), it.seriesSummary)
}

/* 4. 绝对值回退 + int64 边界精度 */
{
	const pts = [[0n, INT64_MAX], [INT64_MAX, 0n], [INT64_MAX - 5n, 5n]]
	const frame = buildTag5Id20(pts)
	eq('边界帧长', frame.length, 60)
	eq('首条状态 = 两路绝对值', frame[40], 0x0a)
	const c = cells(id20(frame))
	eq('起始逆 = INT64_MAX', c[0][2], '9223372036854775.807 m³')
	eq('第1点正 = INT64_MAX', c[1][1], '9223372036854775.807 m³')
	eq('第2点正 = INT64_MAX-5', c[2][1], '9223372036854775.802 m³')
	eq('绝对值说明', c[1][3], '正绝对值 逆绝对值')
	eq('第2点回到 varint', c[2][3], '正-5 逆+5')
}

/* 5. 当量 1..7 全覆盖（含固件不发的 1..3） */
{
	const want = {
		1: ['1.234 L', '0.001L'], 2: ['12.34 L', '0.01L'], 3: ['123.4 L', '0.1L'],
		4: ['1.234 m³', '1L'], 5: ['12.34 m³', '10L'], 6: ['123.4 m³', '100L'], 7: ['1234 m³', '1000L']
	}
	for (const code of [1, 2, 3, 4, 5, 6, 7]) {
		const it = id20(buildTag5Id20([[1234n, 0n], [1234n, 0n]], { unitCode: code }))
		eq('当量码' + code + ' 数值', cells(it)[0][1], want[code][0])
		check('当量码' + code + ' 标签', it.seriesSummary.indexOf('当量' + want[code][1]) >= 0, it.seriesSummary)
	}
}

/* 6. 设底度事件 0x1A：显示事件，差值不当真实用水 */
{
	const pts = [[0n, 0n], [500n, 0n]]
	const frame = buildTag5Id20(pts, { resetAt: 1 })
	// 0→500 的 varint 只要 2B，这里按协议预留形态强制两路绝对值
	const forced = Array.from(frame)
	const body = [0x1a, ...u64le(500n), ...u64le(0n)]
	const head = forced.slice(0, 40)
	const rebuilt = new Uint8Array([...head, ...body])
	rebuilt[1] = (rebuilt.length - 3) & 0xff
	rebuilt[2] = (rebuilt.length - 3) >> 8
	eq('0x1A 记录形态', Array.from(rebuilt.slice(40, 43)).join(' '), '26 244 1')
	const it = id20(rebuilt)
	eq('设底度点正累计', cells(it)[1][1], '500 L')
	check('行标记 reset', it.seriesRows[1].reset === true)
	check('说明含设底度', /设底度事件/.test(cells(it)[1][3]), cells(it)[1][3])
	check('摘要计数设底度', /设底度事件1次/.test(it.seriesSummary), it.seriesSummary)
	check('非事件点不标记', it.seriesRows[0].reset === false)
}

/* 7. 错误报文 */
function errItem(bytes) { return id20(bytes) }
{
	// 7a 头部长度不足
	const short = buildTag5Id20([[1n, 1n]])
	const cut = short.slice(0, 3 + 30)
	cut[1] = 30
	const it = errItem(cut)
	check('短头报错', it.partial && /头部不足 36 字节\(实际 29\)/.test(it.decoded), it.decoded)

	// 7b 声明点数多于实际
	const f2 = buildTag5Id20([[1n, 1n], [2n, 1n]], { declaredN: 5 })
	const it2 = errItem(f2)
	check('点数不足报错', it2.partial && /第 2 点缺少状态字节\(声明 5 点\)/.test(it2.decoded), it2.decoded)

	// 7c 声明点数少于实际 → 尾部未消费告警
	const f3 = buildTag5Id20([[1n, 1n], [2n, 1n], [3n, 1n]], { declaredN: 1 })
	const it3 = errItem(f3)
	check('尾部残留告警', /未消费/.test(it3.seriesSummary), it3.seriesSummary)

	// 7d 保留编码 11
	const f4 = Array.from(buildTag5Id20([[1n, 1n], [2n, 1n]]))
	f4[40] = 0x03
	const it4 = errItem(new Uint8Array(f4))
	check('保留编码报错', it4.partial && /编码 11 为保留值/.test(it4.decoded), it4.decoded)

	// 7e varint 超过 10 字节
	const head = Array.from(buildTag5Id20([[1n, 1n]], { declaredN: 1 })).slice(0, 40)
	const over = new Uint8Array([...head, 0x01, ...new Array(10).fill(0xff), 0x01])
	over[1] = (over.length - 3) & 0xff
	const it5 = errItem(over)
	check('varint 超长报错', it5.partial && /varint 超过 10 字节/.test(it5.decoded), it5.decoded)

	// 7f varint 第 10 字节超出 64 位
	const over64 = new Uint8Array([...head, 0x01, ...new Array(9).fill(0xff), 0x7f])
	over64[1] = (over64.length - 3) & 0xff
	const it6 = errItem(over64)
	check('varint 溢出报错', it6.partial && /varint 超出 64 位/.test(it6.decoded), it6.decoded)

	// 7g 累加后为负
	const neg = new Uint8Array([...Array.from(buildTag5Id20([[0n, 0n], [0n, 0n]])).slice(0, 40), 0x01, 0x03])
	neg[1] = (neg.length - 3) & 0xff
	const it7 = errItem(neg)
	check('负累计报错', it7.partial && /累加后超出 0\.\.INT64_MAX/.test(it7.decoded), it7.decoded)

	// 7h 数据格式保留位非 0 + 当量码 0
	const it8 = errItem(buildTag5Id20([[1n, 1n], [1n, 1n]], { fmt: 0x07 }))
	check('保留位告警', /保留应为 0/.test(it8.seriesSummary), it8.seriesSummary)
	check('当量码 0 告警', /当量码 0 为非法值/.test(it8.seriesSummary), it8.seriesSummary)

	// 7i 状态 bit7-5 非 0
	const f9 = Array.from(buildTag5Id20([[1n, 1n], [1n, 1n]]))
	f9[40] = 0x20
	const it9 = errItem(new Uint8Array(f9))
	check('状态保留位告警', /状态 bit7-5 保留应为 0/.test(it9.seriesSummary), it9.seriesSummary)
}

/* 11. 夏令时跳变点：按 UTC 时间戳步进，不被浏览器本地墙钟算术抹平 */
{
	// 设备在纽约(EST, UTC-5)，起始 2026-03-08 01:30:00，间隔 30 分钟。
	// 本地 Date 加分钟会把 02:00 挪成 03:00（该墙钟时刻在 NY 不存在）。
	const pts = [[0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]]
	const it = id20(buildTag5Id20(pts, { start: '20260308013000', interval: 30, tzOffsetSec: -5 * 3600 }))
	const got = cells(it).map(c => c[0]).join(' | ')
	eq('夏令时跳变点逐点递增 30 分钟', got,
		'2026-03-08 01:30:00 | 2026-03-08 02:00:00 | 2026-03-08 02:30:00 | 2026-03-08 03:00:00')
	check('摘要标出设备时区', /设备时区UTC-05:00/.test(it.seriesSummary), it.seriesSummary)

	// 秋令时回拨同样不重复 01:00（2026-11-01 纽约 02:00 EDT → 01:00 EST）
	const it2 = id20(buildTag5Id20(pts, { start: '20261101013000', interval: 30, tzOffsetSec: -4 * 3600 }))
	eq('秋令时回拨不重复', cells(it2).map(c => c[0]).join(' | '),
		'2026-11-01 01:30:00 | 2026-11-01 02:00:00 | 2026-11-01 02:30:00 | 2026-11-01 03:00:00')

	// 设备报 UTC（BCD 与时间戳一致）时不加偏移、也不标时区
	const it3 = id20(buildTag5Id20(pts, { start: '20260308013000', interval: 30 }))
	eq('零偏移仍按墙钟', cells(it3)[1][0], '2026-03-08 02:00:00')
	check('零偏移不标时区', !/设备时区/.test(it3.seriesSummary), it3.seriesSummary)
}

/* 12. 时间戳异常时的降级 */
{
	const pts = [[0n, 0n], [0n, 0n]]
	// 时间戳为 0：改按 BCD 推算并告警
	const it = id20(buildTag5Id20(pts, { start: '20260308013000', interval: 30, ts: 0n }))
	eq('时间戳为 0 时降级到 BCD', cells(it)[1][0], '2026-03-08 02:00:00')
	check('降级告警', /UTC 时间戳不在 2000-2100 范围/.test(it.seriesSummary), it.seriesSummary)

	// BCD 与时间戳相差超过 14 小时：不信 BCD，按 UTC 显示并告警
	const it2 = id20(buildTag5Id20(pts, { start: '20260308013000', interval: 30, ts: BigInt(wallSeconds('20260310013000')) }))
	eq('偏移超 14 小时按 UTC', cells(it2)[0][0], '2026-03-10 01:30:00')
	check('偏移异常告警', /相差超过 14 小时/.test(it2.seriesSummary), it2.seriesSummary)
}

/* 8. 不破坏 ID18/19 与其它 Tag5 字段 */
{
	// ID0 起始时间 + ID1 间隔 + ID2 个数 + ID4 记录值 ×3
	const legacy = new Uint8Array([
		5, 0, 0,
		0, ...bcd7('20260315081500'),
		1, ...u16le(30),
		2, 3,
		4, 0xe8, 3, 0, 0, 0xed, 3, 0, 0, 0xf2, 3, 0, 0
	])
	legacy[1] = legacy.length - 3
	const tlv = parse(legacy)
	const ids = (tlv[0].items || []).map(x => x.id)
	eq('旧 Tag5 字段完整', ids.join(','), '0,1,2,4')
	const rec = tlv[0].items.find(x => x.id === 4)
	eq('旧记录值仍按 3 条', rec.seriesRows.length, 3)
	check('旧记录值仍是两列', !rec.seriesCols, JSON.stringify(rec.seriesCols))

	// ID18 仍走原有(未专门解码)路径, 不被 ID20 逻辑吃掉
	const id18 = new Uint8Array([5, 0, 0, 18, ...bcd7('20260315081500'), ...u64le(1773533700n), ...u16le(30), 0x80, ...u64le(1000n), ...u16le(0)])
	id18[1] = id18.length - 3
	const t18 = parse(id18)
	eq('ID18 仍被识别', t18[0].items[0].id, 18)
	check('ID18 未走 ID20 渲染', !t18[0].items[0].seriesCols)
}

/* 9. 一帧内 ID20 与其它 Tag 共存 */
{
	const t5 = buildTag5Id20([[1000n, 20n], [1005n, 20n]])
	const t1 = new Uint8Array([1, 2, 0, 0, 0x01])
	const both = new Uint8Array([...t5, ...t1])
	const tlv = parse(both)
	eq('两个 Tag', tlv.map(t => t.tag).join(','), '5,1')
	eq('ID20 未吞掉后续 Tag', tlv[0].items.find(x => x.id === 20).seriesRows.length, 2)
}

/* 10. 满批 128 点往返一致 */
{
	const pts = []
	let seed = 1n
	const M = (1n << 64n) - 1n
	for (let i = 0; i < 128; i++) {
		seed = (seed * 6364136223846793005n + 1n) & M
		const f = seed & INT64_MAX
		seed = (seed * 6364136223846793005n + 1n) & M
		pts.push([f, seed & INT64_MAX])
	}
	const it = id20(buildTag5Id20(pts))
	check('128 点无错误', !it.partial, it.decoded)
	eq('128 行', it.seriesRows.length, 128)
	// 独立实现的期望值：1L 当量下 >=1000L 记为 m³
	function expectLiters(v) {
		const s = v.toString()
		if (s.length < 4) return s + ' L'
		const i = s.slice(0, s.length - 3).replace(/^0+(?=\d)/, '')
		const f = s.slice(s.length - 3).replace(/0+$/, '')
		return (f ? i + '.' + f : i) + ' m³'
	}
	let bad = null
	const cc = cells(it)
	for (let i = 0; i < 128; i++) {
		if (cc[i][1] !== expectLiters(pts[i][0]) || cc[i][2] !== expectLiters(pts[i][1])) {
			bad = '#' + i + ' got ' + cc[i][1] + '/' + cc[i][2] + ' want ' + expectLiters(pts[i][0]) + '/' + expectLiters(pts[i][1])
			break
		}
	}
	check('128 点逐点精确还原', bad === null, bad || '')
}

console.log((fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
