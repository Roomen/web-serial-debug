// Run: node tests/sts-ciu-protocol.cjs — synthetic data only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const window = {}
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/sts-ciu-protocol.js'), 'utf8'), { window, Uint8Array })
const S = window.stsCiu
const hex = s => Uint8Array.from(s.split(' ').filter(Boolean).map(x => parseInt(x, 16)))
const METER = '12345678'
const T = S.TYPE
const J = x => JSON.parse(JSON.stringify(x)) // 沙箱里创建的对象跨 realm，深比较前先转普通对象

// ---- CRC-8/AUTOSAR ----
assert.equal(S.crc8(Buffer.from('123456789')), 0xdf)
assert.equal(S.crc8([]), 0x00)

// ---- 报文示例：每一条都逐字节往返 ----
// 每项: [帧十六进制, 用类型化编码器重建该帧的函数]
const frame = (dir, type, txn, payload) => S.buildFrame({ dir, type, txn, meter: METER, payload })
const block5 = hex('03 80 80 80 00')
const tlv = (id, enc, val) => { const w = S.createTlvWriter(); assert.equal(w.put(id, enc, val), 0); return w.bytes() }
const rec = (min, amt) => S.recordEncode({ minutes: min, amount: amt })
const cat = (...parts) => Uint8Array.from(parts.flatMap(p => Array.from(p)))
const vectors = [
	['01 12 34 56 78 40 66 82 21 84 58 90 32 36 65 3E', () => frame(0, T.TOKEN, 1, S.tokenReqEncode('40668221845890323665'))],
	['81 12 34 56 78 00 46', () => frame(1, T.TOKEN, 1, S.tokenRspEncode({ procStatus: 0 }))],
	['52 12 34 56 78 01 01', () => frame(0, T.RESULT, 2, S.resultReqEncode(S.tgtOf(T.TOKEN, 1)))],
	['D2 12 34 56 78 01 01 05 57', () => frame(1, T.RESULT, 2, S.resultRspEncode({ pollState: 1, tgt: 1, etaS: 5 }))],
	['53 12 34 56 78 01 55', () => frame(0, T.RESULT, 3, S.resultReqEncode(1))],
	// 协议 10.1 / 10.2: STS 结果块为 6 字节 [index u16 BE][Value u32 BE]
	['D3 12 34 56 78 02 01 02 00 00 01 F4 00 00 01 F4 00 01 00 00 00 05 2B', () => frame(1, T.RESULT, 3, S.resultRspEncode({
		pollState: 2, tgt: 1, tail: S.tokenRspEncode({ procStatus: 2, credited: 500, remaining: 500, stsBlock: S.stsResultEncode({ index: 1, value: 5 }) }) }))],
	['54 12 34 56 78 01 D6', () => frame(0, T.RESULT, 4, S.resultReqEncode(1))],
	['D4 12 34 56 78 00 01 00', () => frame(1, T.RESULT, 4, S.resultRspEncode({ pollState: 0, tgt: 1 }))],
	['81 12 34 56 78 01 00 03 00 00 00 01 76', () => frame(1, T.TOKEN, 1, S.tokenRspEncode({ procStatus: 1, stsBlock: S.stsResultEncode({ index: 3, value: 1 }) }))],
	['0D 12 34 56 78 40 66 82 21 84 58 90 32 36 66 F4', () => frame(0, T.TOKEN, 13, S.tokenReqEncode('40668221845890323666'))],
	['CD 12 34 56 78 06 00 44', () => frame(1, T.NAK, 13, S.nakEncode(6, 0))],
	['25 12 34 56 78 80 01 99', () => frame(0, T.WRITE, 5, S.writeReqEncode(0x80, [1]))],
	['A5 12 34 56 78 80 FE E9', () => frame(1, T.WRITE, 5, S.writeRspEncode(0x80, 0xfe))],
	['56 12 34 56 78 25 B1', () => frame(0, T.RESULT, 6, S.resultReqEncode(0x25))],
	['D6 12 34 56 78 02 25 80 00 80', () => frame(1, T.RESULT, 6, S.resultRspEncode({ pollState: 2, tgt: 0x25, tail: S.writeRspEncode(0x80, 0) }))],
	['2C 12 34 56 78 50 01 B6', () => frame(0, T.WRITE, 12, S.writeReqEncode(0x50, [1]))],
	['CC 12 34 56 78 03 50 C4', () => frame(1, T.NAK, 12, S.nakEncode(3, 0x50))],
	['17 12 34 56 78 03 01 0C', () => frame(0, T.READ, 7, S.readReqEncode(3, 1))],
	['97 12 34 56 78 03 61 00 00 01 F4 79', () => frame(1, T.READ, 7, tlv(3, 0x61, hex('00 00 01 F4')))],
	['38 12 34 56 78 03', () => frame(0, T.STATUS, 8, [])],
	['B8 12 34 56 78 00 00 01 F4 03 41 01 48 ED', () => frame(1, T.STATUS, 8, S.statusRspEncode({ remaining: 500, valve: 3, meterStatus: 0x41, batteryCv: 328 }))],
	['19 12 34 56 78 17 01 F7', () => frame(0, T.READ, 9, S.readReqEncode(0x17, 1))],
	['99 12 34 56 78 17 F0 04 14 05 08 01 F6', () => frame(1, T.READ, 9, tlv(0x17, 0xf0, S.alarmListEncode(['1405', '0801'])))],
	['1A 12 34 56 78 19 01 69', () => frame(0, T.READ, 10, S.readReqEncode(0x19, 1))],
	['9A 12 34 56 78 19 00 0C D1', () => frame(1, T.READ, 10, tlv(0x19, 0x00, [12]))],
	['1B 12 34 56 78 30 05 07', () => frame(0, T.READ, 11, S.readReqEncode(0x30, 5))],
	['9B 12 34 56 78 30 F0 07 35 AB A8 00 00 01 F4 31 F0 07 34 DF EB 00 00 03 E8 32 F0 07 33 F0 1C 00 00 09 C4 33 F0 07 32 D5 63 00 00 01 F4 34 F0 07 31 C0 F4 00 00 0B B8 DF', () => {
		const w = S.createTlvWriter()
		;[[0x35ABA8, 500], [0x34DFEB, 1000], [0x33F01C, 2500], [0x32D563, 500], [0x31C0F4, 3000]].forEach(([m, a], i) => assert.equal(w.put(0x30 + i, 0xf0, rec(m, a)), 0))
		return frame(1, T.READ, 11, w.bytes())
	}],
]
for (const [h, rebuild] of vectors) {
	const want = hex(h)
	assert.deepEqual(Array.from(rebuild()), Array.from(want), '重建 ' + h)
	const r = S.parseRaw(want)
	assert.equal(r.ok, true, 'CRC ' + h)
	const p = S.parseFrame(want)
	assert.equal(p.ok, true, '解析 ' + h + ' ' + p.errors.join())
	assert.equal(S.findFrame(want).found, true)
	assert.equal(S.byteMap(p).length, want.length)
	assert.match(S.formatFrame(p), /sk-parse/)
}

// 关键字段抽查
const parsed = S.parseFrame(hex('D3 12 34 56 78 02 01 02 00 00 01 F4 00 00 01 F4 03 80 80 80 00 A6'))
assert.match(parsed.decoded, /本次充值量 = 500/)
assert.match(parsed.decoded, /STS 结果块\(5B/)
assert.equal(S.recordTimeStr(3465195), '2026-08-03 09:15')
{
	const w = S.tlvParse(hex('30 F0 07 35 AB A8 00 00 01 F4'))
	assert.equal(w.ok, true)
	assert.equal(S.recordDecode(w.tlvs[0].val).amount, 500)
}
assert.equal(S.fmtScaled(500, 1), '50.0')
assert.equal(S.fmtScaled(-5, 2), '-0.05')
assert.equal(S.fmtScaled(7, 0), '7')

// ---- 接收判定：表体侧 1 2 3 4 7 9 ----
const okReq = hex('01 12 34 56 78 40 66 82 21 84 58 90 32 36 65 3E')
assert.equal(S.meterGate(okReq, METER).ok, true)
assert.equal(S.meterGate(okReq.subarray(0, 5), METER).item, 1) // 长度 <6
assert.equal(S.meterGate(new Uint8Array(65), METER).item, 1) // 长度 >64
{
	const bad = okReq.slice()
	bad[6] ^= 1
	assert.equal(S.meterGate(bad, METER).item, 2)
	assert.equal(S.meterGate(hex('81 12 34 56 78 00 46'), METER).item, 3) // 表体收到响应
	assert.equal(S.meterGate(okReq, '87654321').item, 4)
	// 第 7 项: 空的 RESULT 请求（6 字节）不得去读 TGT
	const emptyResult = frame(0, T.RESULT, 1, [])
	assert.equal(emptyResult.length, 6)
	assert.equal(S.meterGate(emptyResult, METER).item, 7)
	assert.equal(S.meterGate(frame(0, T.TOKEN, 1, new Uint8Array(9)), METER).item, 7)
	assert.equal(S.meterGate(frame(0, T.STATUS, 1, [1]), METER).item, 7)
	assert.equal(S.meterGate(frame(0, T.WRITE, 1, []), METER).item, 7)
	// 第 9 项: 未知 TYPE（含 NAK 当请求、RFU 6/7）回 NAK 0x01 并回显 TYPE
	for (const ty of [4, 6, 7]) {
		const g = S.meterGate(frame(0, ty, 3, [1, 2]), METER)
		assert.equal(g.item, 9)
		assert.deepEqual(J(g.nak), { reason: 1, echo: ty })
		assert.equal(g.txn, 3)
	}
	// 前八项不产生 NAK
	assert.equal(S.meterGate(bad, METER).nak, undefined)
}

// ---- CIU 侧 1..8 ----
{
	const ctx = (inflight, pendingTgt) => ({ meter: METER, inflight, pendingTgt: pendingTgt == null ? null : pendingTgt })
	const rsp = hex('D3 12 34 56 78 02 01 02 00 00 01 F4 00 00 01 F4 03 80 80 80 00 A6') // RESULT txn3 tgt1
	const good = ctx({ type: T.RESULT, txn: 3 }, 1)
	assert.equal(S.ciuGate(rsp, good).ok, true)
	assert.equal(S.ciuGate(rsp.subarray(0, 4), good).item, 1)
	const bad = rsp.slice(); bad[7] ^= 1
	assert.equal(S.ciuGate(bad, good).item, 2)
	assert.equal(S.ciuGate(okReq, good).item, 3) // CIU 收到请求
	assert.equal(S.ciuGate(rsp, { ...good, meter: '87654321' }).item, 4)
	assert.equal(S.ciuGate(rsp, ctx({ type: T.RESULT, txn: 4 }, 1)).item, 5)
	assert.equal(S.ciuGate(rsp, ctx(null, 1)).item, 5)
	assert.equal(S.ciuGate(rsp, ctx({ type: T.READ, txn: 3 }, 1)).item, 6)
	// NAK 可以通过第 6 项
	const nak = hex('CD 12 34 56 78 06 00 44')
	assert.equal(S.ciuGate(nak, ctx({ type: T.TOKEN, txn: 13 }, null)).ok, true)
	// 第 7 项: RESULT 状态 2 的尾部按被轮询类型校验
	assert.equal(S.ciuGate(frame(1, T.RESULT, 3, hex('02 01 02')), good).item, 7) // TOKEN 状态 2 需 >=10 字节
	assert.equal(S.ciuGate(frame(1, T.RESULT, 3, []), good).item, 7)
	// 第 8 项: 比对待办 TGT，不是在飞事务
	assert.equal(S.ciuGate(rsp, ctx({ type: T.RESULT, txn: 3 }, 0x02)).item, 8)
	assert.equal(S.ciuGate(rsp, ctx({ type: T.RESULT, txn: 3 }, null)).item, 8)
	// 第 7 项先于第 8 项: 载荷长度不符的帧不会去读 TGT
	assert.equal(S.ciuGate(frame(1, T.RESULT, 3, hex('01')), good).item, 7)
	// TGT bit7 (RFU) 置位不判错
	const rfu = frame(1, T.RESULT, 3, hex('00 81'))
	assert.equal(S.ciuGate(rfu, good).ok, true)
	// 未知轮询状态: 尾部整段忽略，不判长度错
	assert.equal(S.ciuGate(frame(1, T.RESULT, 3, hex('09 01 AA BB CC')), good).ok, true)
}

// ---- 边界 ----
// STS 结果块 M=57（TOKEN 状态 1: 1+57=58 字节载荷，整帧 64 字节）
{
	const block = new Uint8Array(57).map((_, i) => i)
	const pl = S.tokenRspEncode({ procStatus: 1, stsBlock: block })
	assert.equal(pl.length, 58)
	const f = frame(1, T.TOKEN, 2, pl)
	assert.equal(f.length, 64)
	const d = S.tokenRspDecode(S.parseRaw(f).payload)
	assert.equal(d.stsBlock.length, 57)
	assert.deepEqual(Array.from(d.stsBlock), Array.from(block))
	assert.throws(() => S.tokenRspEncode({ procStatus: 1, stsBlock: new Uint8Array(58) }))
	assert.throws(() => S.tokenRspEncode({ procStatus: 2, credited: 1, remaining: 1, stsBlock: new Uint8Array(50) }))
	assert.throws(() => S.tokenRspEncode({ procStatus: 1, stsBlock: [] })) // M >= 1
	// 状态 2 最长 M=49
	assert.equal(S.tokenRspEncode({ procStatus: 2, credited: 1, remaining: -1, stsBlock: new Uint8Array(49) }).length, 58)
	assert.equal(S.ciuGate(f, { meter: METER, inflight: { type: T.TOKEN, txn: 2 }, pendingTgt: null }).ok, true)
	// 65 字节整帧禁止
	assert.throws(() => frame(1, T.TOKEN, 2, new Uint8Array(59)))
	// 终局载荷最长 56（被 RESULT 前缀 2 字节占掉）
	assert.equal(S.resultRspEncode({ pollState: 2, tgt: 1, tail: new Uint8Array(56) }).length, 58)
	assert.throws(() => S.resultRspEncode({ pollState: 2, tgt: 1, tail: new Uint8Array(57) }))
	// 负剩余量
	const neg = S.tokenRspDecode(S.tokenRspEncode({ procStatus: 2, credited: 1, remaining: -5, stsBlock: block5 }))
	assert.equal(neg.remaining, -5)
}
// TOKEN 请求：非法 BCD 半字节
assert.equal(S.tokenReqDecode(hex('40 66 82 21 84 58 90 32 36 6A')), null)
assert.equal(S.tokenReqDecode(hex('40 66')), null)
assert.throws(() => S.tokenReqEncode('123'))
// READ 请求范围: n=0/>16、start+n-1 超过 0xFF 不回绕
assert.equal(S.readReqDecode(hex('03 00')).error, 'range')
assert.equal(S.readReqDecode(hex('03 11')).error, 'range')
assert.equal(S.readReqDecode(hex('FF 02')).error, 'range')
assert.equal(S.readReqDecode(hex('FF 01')).count, 1)
assert.equal(S.readReqDecode(hex('F0 10')).count, 16)
assert.equal(S.readReqDecode(hex('03')).error, 'length')
assert.throws(() => S.readReqEncode(0xff, 2))
// READ 块读装不下：只回能完整装下的前 k 个，绝不截断某一个
{
	const w = S.createTlvWriter()
	let k = 0
	for (let id = 0x30; id < 0x30 + 8; id++) {
		if (w.put(id, 0xf0, S.recordEncode({ minutes: 1, amount: 2 })) !== 0) break
		k++
	}
	assert.equal(k, 5)
	assert.ok(w.used <= 58)
	assert.equal(w.putInvalid(0x35), 0) // 还能放下 2 字节的无效标记（50+2<=58）
	const back = S.tlvParse(w.bytes())
	assert.equal(back.ok, true)
	assert.equal(back.tlvs.length, 6)
	assert.equal(S.createTlvWriter().put(1, 0x61, [0, 0, 0]), 2) // 定长值长度不符
	assert.equal(S.createTlvWriter().put(1, 0xf0, new Uint8Array(56)), 2) // 变长上限 55
	assert.equal(S.createTlvWriter().put(1, 0xf0, new Uint8Array(55)), 0)
	assert.equal(S.createTlvWriter().put(1, 0xb1, [1]), 2) // BCD/字节串的小数位必须为 0
}
// TLV 0xFF 无效标记: 无长度字节、无值，占 2 字节
{
	const t = S.tlvParse(hex('05 FF 06 FF 07 61 00 00 00 01'))
	assert.equal(t.ok, true)
	assert.deepEqual(J(t.tlvs.map(x => [x.id, x.invalid])), [[5, true], [6, true], [7, false]])
	assert.equal(S.tlvInt(t.tlvs[2]), 1)
	assert.equal(S.tlvParse(hex('05')).ok, false)
	assert.equal(S.tlvParse(hex('30 F0 07 01 02')).ok, false)
	assert.equal(S.tlvParse(hex('03 61 00 00')).ok, false)
	assert.equal(S.tlvInt(S.tlvParse(hex('03 61 FF FF FF FE')).tlvs[0]), -2)
	assert.equal(S.tlvInt(S.tlvParse(hex('03 21 FF FF FF FE')).tlvs[0]), 4294967294)
}
// 告警码: 27 个上限（3+2n<=58）、奇数长度/非法 BCD 拒绝
{
	const codes = Array.from({ length: 27 }, (_, i) => String(1000 + i))
	const enc = S.alarmListEncode(codes)
	assert.equal(enc.length, 54)
	assert.deepEqual(J(S.alarmListDecode(enc)), codes)
	assert.throws(() => S.alarmListEncode(codes.concat('9999')))
	assert.deepEqual(J(S.alarmListDecode([])), [])
	assert.equal(S.alarmListDecode(hex('14 05 08')), null)
	assert.equal(S.alarmListDecode(hex('1A 05')), null)
	assert.equal(S.alarmListDecode(new Uint8Array(56)), null)
	// 一帧装 27 码：READ 响应 TLV 3+54=57<=58
	assert.equal(S.createTlvWriter().put(0x17, 0xf0, enc), 0)
	// 不认识的码原样显示，不判错
	assert.deepEqual(J(S.alarmListDecode(hex('99 99'))), ['9999'])
}
// 充值记录: 空槽、RTC 未校准
assert.equal(S.recordDecode(new Uint8Array(7).fill(0xff)).empty, true)
assert.equal(S.recordDecode(hex('FF FF FF 00 00 00 05')).rtcUnset, true)
assert.equal(S.recordDecode(hex('FF FF FF 00 00 00 05')).empty, false)
assert.equal(S.recordDecode(hex('00 00 01 00 00 00 05')).minutes, 1)
assert.equal(S.recordDecode(hex('00 00')), null)
assert.deepEqual(Array.from(S.recordEncode({ empty: true })), Array(7).fill(0xff))
// NAK 原因码 0xFE/0xFF 不得使用
assert.throws(() => S.nakEncode(0xfe, 0))
assert.throws(() => S.nakEncode(0xff, 0))
// RESULT 请求 bit7
assert.throws(() => S.resultReqEncode(0x81))
assert.equal(S.resultReqDecode(hex('81')).tgt, 0x01)
// 未知处理状态：不锁定尾部，标 known=false
assert.equal(S.tokenRspDecode(hex('07 11 22')).known, false)
assert.equal(S.tokenRspDecode(hex('00 01')), null)
assert.equal(S.tokenRspDecode(hex('01')), null)
assert.equal(S.tokenRspDecode(hex('02 00 00 00 01 00 00 00 02')), null)
assert.equal(S.tokenRspDecode(hex('02 00 00 00 01 00 00 00 02 55')).stsBlock.length, 1)
// 展示：串口数据里的 HTML 特殊字符必须转义
{
	const bad = S.parseFrame(hex('01 12 34 56 78 00')) // CRC 错
	assert.equal(bad.ok, false)
	const html = S.formatFrame({ ok: false, errors: ['<img src=x onerror=1>'], fields: { '<b>': '<script>' } })
	for (const raw of ['<img src=x onerror=1>', '<b>', '<script>']) assert.ok(!html.includes(raw), '原样出现: ' + raw)
	for (const escaped of ['&lt;img src=x onerror=1&gt;', '&lt;b&gt;', '&lt;script&gt;']) assert.ok(html.includes(escaped), '缺少转义: ' + escaped)
}
// ---- STS 结果块: [index u16 BE][Value u32 BE]，偏移 6 起保留，M<6 旧格式 ----
{
	assert.deepEqual(Array.from(S.stsResultEncode({ index: 1, value: 1000 })), [0, 1, 0, 0, 3, 0xe8])
	let r = S.stsResultDecode(hex('00 01 00 00 03 E8'), 2)
	assert.equal(r.kind, 'credit'); assert.equal(r.value, 1000); assert.equal(r.mismatch, false)
	assert.match(r.text, /即 10\.00 kL/)
	r = S.stsResultDecode(hex('00 03 00 00 00 07 AA BB'), 1)
	assert.equal(r.kind, 'code'); assert.equal(r.code.name, 'SUCCESS'); assert.equal(r.code.ok, true); assert.equal(r.extra, 2)
	r = S.stsResultDecode(hex('00 03 00 00 00 FF'), 2)
	assert.equal(r.mismatch, true) // 状态 2 应配 MODE1
	r = S.stsResultDecode(hex('00 01 00 00 00 05'), 1)
	assert.equal(r.mismatch, true) // 状态 1 不应配 MODE1
	r = S.stsResultDecode(hex('00 FF 00 02 00 21'), 1)
	assert.deepEqual(J(r.bits.map(b => b.bit)), [0, 5, 17])
	assert.match(r.bits[1].text, /预留/)
	assert.equal(S.stsResultDecode(hex('00 02 00 00 00 01'), 1).kind, 'unknown')
	assert.equal(S.stsResultDecode(hex('00 02 00 00 00 01'), 1).mismatch, true) // 状态 1 只配 MODE3 / MODE256
	assert.equal(S.stsResultDecode(hex('00 FF 00 00 00 01'), 1).mismatch, false)
	assert.equal(S.stsResultDecode(hex('12 34 00 00 00 01'), 1).kind, 'unknown')
	assert.deepEqual(J(S.stsResultDecode(hex('03 80 80 80 00'), 2)), { parsed: false, len: 5 })
	// 解析展示与字节提示
	const f = S.buildFrame({ dir: 1, type: S.TYPE.TOKEN, txn: 1, meter: '12345678', payload: S.tokenRspEncode({ procStatus: 1, stsBlock: hex('00 03 00 00 00 03') }) })
	const p = S.parseFrame(f)
	assert.equal(p.ok, true)
	assert.match(p.decoded, /MODE3 结果码 3 USED 令牌已使用/)
	const bm = S.byteMap(p)
	assert.match(bm[6 + 1].tip, /index/)
	assert.match(bm[6 + 3].tip, /Value/)
	assert.match(S.parseFrame(S.buildFrame({ dir: 1, type: S.TYPE.TOKEN, txn: 1, meter: '12345678', payload: S.tokenRspEncode({ procStatus: 1, stsBlock: hex('06 80 20 00 00') }) })).decoded, /旧格式，不足 6 字节无法解析/)
}
console.log('STS-CIU protocol checks passed')
