// STS-CIU 应用层协议编解码（CIU 与表体两端共用一份）
// 帧: 头字节(DIR|TYPE|TXN) + 表号4B BCD + 载荷 + CRC-8/AUTOSAR，整帧 6..64 字节，多字节整数大端
// 本模块只做编解码与接收判定，不含任何两端策略（待办、存档、轮询在 sts-sim.js）
// 接收判定顺序必须与参考实现一致：第 7 项（载荷长度）先于任何载荷字段读取
;(function () {
	'use strict'
	const W = window

	const FRAME_MIN = 6
	const FRAME_MAX = 64
	const PAYLOAD_MAX = 58
	const TLV_TOTAL_MAX = 58
	const VARLEN_VALUE_MAX = 55
	const TOKEN_DIGITS = 20
	const READ_MAX_REGS = 16
	const ALARM_MAX_CODES = 27
	const RECORD_LEN = 7
	const RECORD_EPOCH_UNSET = 0xffffff
	const ENC_INVALID = 0xff
	const ETA_UNKNOWN = 0xff
	const FINAL_PAYLOAD_MAX = PAYLOAD_MAX - 2

	const DIR_REQUEST = 0
	const DIR_RESPONSE = 1
	const TYPE = { TOKEN: 0, READ: 1, WRITE: 2, STATUS: 3, NAK: 4, RESULT: 5 }
	const TYPE_NAME = ['TOKEN', 'READ', 'WRITE', 'STATUS', 'NAK', 'RESULT']
	const NAK = { UNKNOWN_TYPE: 1, BAD_LENGTH: 2, UNKNOWN_REG: 3, NOT_WRITABLE: 4, OUT_OF_RANGE: 5, BUSY: 6, UNIMPLEMENTED: 7 }
	const NAK_NAME = {
		1: '未知报文类型', 2: '载荷长度非法', 3: '未知寄存器', 4: '寄存器不可写',
		5: '值超出范围/数量非法', 6: '表计忙(已有待办在飞)', 7: '功能未实现',
	}
	const TOKEN_ACCEPTED = 0
	const TOKEN_DONE_NOEXEC = 1
	const TOKEN_DONE_EXEC = 2
	const WRITE_OK = 0x00
	const WRITE_ACCEPTED = 0xfe
	const POLL_UNKNOWN = 0
	const POLL_WORKING = 1
	const POLL_DONE = 2

	const REG = {
		TOTAL_USED: 0x01, REVERSE_USED: 0x02, REMAINING: 0x03, TOTAL_PURCHASED: 0x04, OVERDRAFT_USED: 0x05,
		OVERDRAFT_MAX: 0x06, LOW_ALERT: 0x07, HOARD_LIMIT: 0x08, TIME: 0x10, VALVE: 0x11, METER_STATUS: 0x12,
		BATTERY: 0x13, WATER_TEMP: 0x14, FLOW: 0x15, PAY_MODE: 0x16, ALARM_LIST: 0x17, TARIFF: 0x18,
		RECORD_COUNT: 0x19, SGC: 0x20, KRN: 0x21, TI: 0x22, EA: 0x23, KEN: 0x24, METER_NO: 0x25, FW_VER: 0x26,
		PROTO_VER: 0x27, DRN: 0x28, RECORD_FIRST: 0x30, RECORD_LAST: 0x5f, VALVE_TEST: 0x80, UNBIND: 0x81,
	}
	const REG_NAME = {
		0x01: '总使用量', 0x02: '反向使用量', 0x03: '剩余量', 0x04: '总购买量', 0x05: '透支使用量',
		0x06: '最大透支量', 0x07: '低余量告警阈值', 0x08: '防囤水阈值', 0x10: '表计时间', 0x11: '阀门状态',
		0x12: '表计状态', 0x13: '电池电压', 0x14: '水温', 0x15: '瞬时流量', 0x16: '付费模式',
		0x17: '当前告警码列表', 0x18: '计价模式与标度', 0x19: '充值记录条数', 0x20: 'SGC', 0x21: 'KRN',
		0x22: 'TI', 0x23: 'EA', 0x24: 'KEN', 0x25: '表号', 0x26: '表计固件版本号', 0x27: '协议版本',
		0x28: 'DRN', 0x80: '阀控测试', 0x81: '断开绑定',
	}
	function regName(id) {
		if (REG_NAME[id]) return REG_NAME[id]
		if (id >= REG.RECORD_FIRST && id <= REG.RECORD_LAST) return '充值记录 #' + (id - REG.RECORD_FIRST + 1)
		return '寄存器'
	}

	// 位域
	const VALVE_POS_MASK = 0x03
	const VALVE_POS_CLOSED = 0x02
	const VALVE_POS_OPEN = 0x03
	const VALVE_TEST_ACTIVE = 0x04
	const VALVE_FAULT = 0x08
	const MST_LOW_CREDIT = 0x01
	const MST_LOW_BATTERY = 0x02
	const MST_MAGNETIC = 0x04
	const MST_TAMPER = 0x08
	const MST_REVERSE_FLOW = 0x10
	const MST_POSTPAID = 0x20
	const MST_ALARM_LIST = 0x40

	// ===== 基础工具 =====
	function toU8(b) {
		if (b instanceof Uint8Array) return b
		return Uint8Array.from(b || [])
	}
	function h2(b) { return ((b & 0xff) < 16 ? '0' : '') + (b & 0xff).toString(16).toUpperCase() }
	function hexSpaced(b) {
		const out = []
		for (let i = 0; i < b.length; i++) out.push(h2(b[i]))
		return out.join(' ')
	}
	function hexByte(b) { return '0x' + h2(b) }
	function hexToBytes(s) {
		const str = String(s || '').replace(/[\s:,]/g, '')
		if (str.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(str)) return null
		const a = new Uint8Array(str.length / 2)
		for (let i = 0; i < a.length; i++) a[i] = parseInt(str.substr(i * 2, 2), 16)
		return a
	}
	function escHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
	}
	function equalBytes(a, b) {
		if (a.length !== b.length) return false
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
		return true
	}
	function u32(p, o) {
		return (((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0)
	}
	function i32(p, o) { return (u32(p, o) | 0) }
	function putU32(a, v) {
		a.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
	}

	// ===== CRC-8/AUTOSAR: poly 0x2F init 0xFF xorout 0xFF 不反转 =====
	function crc8(data, len) {
		let c = 0xff
		const n = len == null ? data.length : len
		for (let i = 0; i < n; i++) {
			c ^= data[i]
			for (let k = 0; k < 8; k++) c = (c & 0x80) ? (((c << 1) ^ 0x2f) & 0xff) : ((c << 1) & 0xff)
		}
		return c ^ 0xff
	}

	// ===== BCD =====
	// 数字串 -> BCD 字节（偶数位，首位在高半字节）；非法返回 null
	function bcdPack(digits) {
		const s = String(digits)
		if (!/^\d*$/.test(s) || s.length % 2 !== 0) return null
		const out = new Uint8Array(s.length / 2)
		for (let i = 0; i < out.length; i++) out[i] = (parseInt(s[i * 2], 10) << 4) | parseInt(s[i * 2 + 1], 10)
		return out
	}
	function bcdValid(b) {
		for (let i = 0; i < b.length; i++) if ((b[i] >> 4) > 9 || (b[i] & 0x0f) > 9) return false
		return true
	}
	// BCD 字节 -> 数字串；含非法半字节返回 null
	function bcdUnpack(b) {
		if (!bcdValid(b)) return null
		let s = ''
		for (let i = 0; i < b.length; i++) s += (b[i] >> 4).toString(10) + (b[i] & 0x0f).toString(10)
		return s
	}
	function meterBcd(m) {
		if (m instanceof Uint8Array || Array.isArray(m)) {
			if (m.length !== 4) throw new Error('表号需 4 字节 BCD')
			return Uint8Array.from(m)
		}
		const b = /^\d{8}$/.test(String(m)) ? bcdPack(String(m)) : null
		if (!b) throw new Error('表号需 8 位十进制')
		return b
	}

	// ===== 帧 =====
	function buildFrame(o) {
		const payload = toU8(o.payload || [])
		const total = 6 + payload.length
		if (payload.length > PAYLOAD_MAX || total > FRAME_MAX) throw new Error('应用帧超过 64 字节，禁止分片')
		const f = new Uint8Array(total)
		f[0] = ((o.dir & 1) << 7) | ((o.type & 7) << 4) | (o.txn & 0x0f)
		f.set(meterBcd(o.meter), 1)
		f.set(payload, 5)
		f[total - 1] = crc8(f, total - 1)
		return f
	}

	// 接收判定第 1、2 项
	function parseRaw(bytes) {
		const b = toU8(bytes)
		if (b.length < FRAME_MIN || b.length > FRAME_MAX) return { ok: false, item: 1, reason: 'length' }
		if (crc8(b, b.length - 1) !== b[b.length - 1]) return { ok: false, item: 2, reason: 'crc' }
		return {
			ok: true,
			dir: (b[0] >> 7) & 1,
			type: (b[0] >> 4) & 7,
			txn: b[0] & 0x0f,
			meter: b.subarray(1, 5),
			payload: b.subarray(5, b.length - 1),
			raw: b,
		}
	}

	function tgtOf(type, txn) { return ((type & 7) << 4) | (txn & 0x0f) }
	function tgtType(tgt) { return (tgt >> 4) & 7 }
	function tgtTxn(tgt) { return tgt & 0x0f }

	// ===== 载荷编解码 =====
	// TOKEN 请求
	function tokenReqEncode(digits) {
		const s = String(digits)
		if (!/^\d{20}$/.test(s)) throw new Error('令牌需 20 位数字')
		return bcdPack(s)
	}
	function tokenReqDecode(p) {
		if (p.length !== 10) return null
		return bcdUnpack(p)
	}
	// TOKEN 响应: { procStatus, credited, remaining, stsBlock }
	function tokenRspEncode(r) {
		const a = [r.procStatus & 0xff]
		if (r.procStatus === TOKEN_ACCEPTED) return Uint8Array.from(a)
		const block = toU8(r.stsBlock || [])
		if (block.length < 1) throw new Error('终局 TOKEN 响应的 STS 结果块至少 1 字节')
		if (r.procStatus === TOKEN_DONE_EXEC) {
			putU32(a, r.credited >>> 0)
			putU32(a, r.remaining >>> 0)
		}
		if (a.length + block.length > PAYLOAD_MAX) throw new Error('TOKEN 响应超过 58 字节载荷')
		for (let i = 0; i < block.length; i++) a.push(block[i])
		return Uint8Array.from(a)
	}
	// 长度错返回 null；未知处理状态返回 known=false（无尾部，按规则 8 失败并显示原始字节）
	function tokenRspDecode(p) {
		if (p.length < 1) return null
		const st = p[0]
		if (st === TOKEN_ACCEPTED) return p.length === 1 ? { procStatus: st, known: true } : null
		if (st === TOKEN_DONE_NOEXEC) {
			if (p.length < 2) return null
			return { procStatus: st, known: true, stsBlock: p.subarray(1) }
		}
		if (st === TOKEN_DONE_EXEC) {
			if (p.length < 10) return null
			return { procStatus: st, known: true, credited: u32(p, 1), remaining: i32(p, 5), stsBlock: p.subarray(9) }
		}
		return { procStatus: st, known: false }
	}

	// STS 结果块（4.1）: 表端 STS 库的返回值 [index u16 BE][Value u32 BE]，偏移 6 起保留（忽略但照样保留上送）。
	// M < 6 是旧格式块（status_code/Auth/Validation/TokenResult 5 字节），解不出来按原始字节展示，不当错误帧。
	// 处理状态 2（已执行）配 MODE1；处理状态 1（未执行充值）配 MODE3 / MODE256。对应不上只标出，不拒帧
	const STS_RESULT_LEN = 6
	const STS_IDX = { CREDIT: 0x0001, MODE2: 0x0002, CODE: 0x0003, TEST: 0x00ff }
	const STS_IDX_NAME = { 0x0001: 'MODE1 充值', 0x0002: 'MODE2（库未定义语义）', 0x0003: 'MODE3 结果码', 0x00ff: 'MODE256 表计测试' }
	// MODE3 结果码: ok=true 表示令牌本身成功但不是充值（4、5、7..13）；1、2、3、6、0xFF 是失败
	const STS_CODE = {
		1: { name: 'OVER', text: '余额过多', ok: false }, 2: { name: 'OLD', text: '令牌过期', ok: false },
		3: { name: 'USED', text: '令牌已使用', ok: false }, 4: { name: '1ST', text: '换钥第一步', ok: true },
		5: { name: '2ND', text: '换钥第二步', ok: true }, 6: { name: 'EXPIRED', text: '密钥到期', ok: false },
		7: { name: 'SUCCESS', text: '设置参数成功', ok: true }, 8: { name: 'CLEAR_CREDIT', text: '清余额成功', ok: true },
		9: { name: 'SET_PREPAY', text: '设置预付费', ok: true }, 10: { name: 'SET_POSTPAY', text: '设置后付费', ok: true },
		11: { name: 'VALVE_OPEN', text: '打开水阀', ok: true }, 12: { name: 'VALVE_CLOSE', text: '关闭水阀', ok: true },
		13: { name: 'CLEAR_TAMPER', text: '清除窃水状态', ok: true }, 255: { name: 'REJECT', text: '错误的令牌', ok: false },
	}
	// MODE256 位图: 库只返回解析出的测试位，执行与否由表端业务层决定；未列出的位表端显示拒绝
	const STS_TEST_BIT = {
		0: '水阀开关测试', 1: '全屏显示', 2: '总用水量', 3: '显示 KRN', 4: '显示 TI', 7: '清除窃水状态',
		9: '软件版本号', 13: '显示 EA', 14: '2 串密钥替换（预留）', 16: '显示 KEN', 17: '显示 DRN',
	}
	function stsResultEncode(r) {
		const a = [(r.index >> 8) & 0xff, r.index & 0xff]
		putU32(a, r.value >>> 0)
		return Uint8Array.from(a)
	}
	function stsTestBits(v) {
		const bits = []
		for (let b = 0; b < 32; b++) if ((v >>> b) & 1) bits.push({ bit: b, text: STS_TEST_BIT[b] || '预留（表端显示拒绝）' })
		return bits
	}
	// 返回 { parsed:false, len } 或 { parsed:true, index, value, extra, kind, code?, bits?, text, mismatch }
	function stsResultDecode(block, procStatus) {
		const b = toU8(block || [])
		if (b.length < STS_RESULT_LEN) return { parsed: false, len: b.length }
		const index = (b[0] << 8) | b[1]
		const value = u32(b, 2)
		const r = { parsed: true, index: index, value: value, extra: b.length - STS_RESULT_LEN, mismatch: false }
		if (index === STS_IDX.CREDIT) {
			r.kind = 'credit'
			// Value 与 TOKEN 响应的「本次充值量」同数同单位（随寄存器 0x18），不另换算
			r.text = 'MODE1 充值成功，充值量 ' + value + '（原始整数，与本次充值量同单位）'
		} else if (index === STS_IDX.CODE) {
			r.kind = 'code'
			r.code = STS_CODE[value] || null
			r.text = 'MODE3 结果码 ' + value + (r.code ? ' ' + r.code.name + ' ' + r.code.text : ' 未知')
		} else if (index === STS_IDX.TEST) {
			r.kind = 'test'
			r.bits = stsTestBits(value)
			r.text = 'MODE256 表计测试 位图 0x' + value.toString(16).toUpperCase().padStart(8, '0') + (r.bits.length ? '：' + r.bits.map(x => 'BIT' + x.bit + ' ' + x.text).join('、') : '（无测试位）')
		} else {
			r.kind = 'unknown'
			r.text = (index === STS_IDX.MODE2 ? 'MODE2（库未定义语义）' : '未知 index 0x' + index.toString(16).toUpperCase().padStart(4, '0')) + '，Value = ' + value
		}
		if (procStatus === TOKEN_DONE_EXEC) r.mismatch = r.kind !== 'credit'
		else if (procStatus === TOKEN_DONE_NOEXEC) r.mismatch = r.kind !== 'code' && r.kind !== 'test'
		return r
	}
	function stsResultLines(block, procStatus, lines) {
		const r = stsResultDecode(block, procStatus)
		if (!r.parsed) { lines.push('STS 结果块(' + r.len + 'B，旧格式，不足 6 字节无法解析) = ' + hexSpaced(toU8(block))); return }
		lines.push('STS 结果块(' + (STS_RESULT_LEN + r.extra) + 'B) = ' + hexSpaced(toU8(block)))
		lines.push('  ' + r.text)
		if (r.extra) lines.push('  偏移 6 起 ' + r.extra + ' 字节为保留，忽略')
		if (r.mismatch) lines.push('  ⚠ 处理状态 ' + procStatus + ' 与结果块 ' + (STS_IDX_NAME[r.index] || 'index') + ' 对应不上（状态 2 应配 MODE1，状态 1 应配 MODE3/MODE256）')
	}

	// ===== 模拟令牌（测试用明文格式，不是 STS 令牌，不加密）=====
	// 20 位 = [77 标识][TT 类型][SSSS 序号][DDDDDDDDDD 数据][CC 校验]，
	// 校验 = 前 18 位按 1、3 交替加权求和 mod 97。表端模拟器据此给出对应的 STS 结果块；不带标识的令牌按普通令牌处理
	const SIM_TOKEN_MAGIC = '77'
	const SIM_TOKEN_TYPES = {
		'01': { name: '充值', data: 'amount' }, '02': { name: '清余额', code: 8 }, '03': { name: '设预付费', code: 9 },
		'04': { name: '设后付费', code: 10 }, '05': { name: '开阀', code: 11 }, '06': { name: '关阀', code: 12 },
		'07': { name: '清除窃水', code: 13 }, '08': { name: '设置参数', code: 7 }, '10': { name: '换钥第一步', code: 4 },
		'11': { name: '换钥第二步', code: 5 }, '20': { name: '表计测试', data: 'bits' }, '90': { name: '指定结果码', data: 'code' },
	}
	function simTokenCheck(d18) {
		let sum = 0
		for (let i = 0; i < 18; i++) sum += (d18.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3)
		return String(sum % 97).padStart(2, '0')
	}
	function simTokenEncode(o) {
		const type = String(o.type).padStart(2, '0')
		if (!SIM_TOKEN_TYPES[type]) throw new Error('未知的模拟令牌类型 ' + type)
		const serial = Math.trunc(Number(o.serial || 0))
		const data = Math.trunc(Number(o.data || 0))
		if (!(serial >= 0 && serial <= 9999)) throw new Error('模拟令牌序号需 0..9999')
		if (!(data >= 0 && data <= 4294967295)) throw new Error('模拟令牌数据需 0..4294967295')
		const d18 = SIM_TOKEN_MAGIC + type + String(serial).padStart(4, '0') + String(data).padStart(10, '0')
		return d18 + simTokenCheck(d18)
	}
	// 标识或校验不符返回 null，按普通令牌处理（手敲的 7777… 这类测试令牌不会被误认）；校验对但类型未知返回 { valid:false }
	function simTokenDecode(digits) {
		const s = String(digits || '')
		if (!/^\d{20}$/.test(s) || s.slice(0, 2) !== SIM_TOKEN_MAGIC || simTokenCheck(s.slice(0, 18)) !== s.slice(18)) return null
		const type = s.slice(2, 4)
		const t = SIM_TOKEN_TYPES[type]
		if (!t) return { valid: false, reason: '未知类型 ' + type }
		return { valid: true, type: type, name: t.name, code: t.code, dataKind: t.data || null, serial: Number(s.slice(4, 8)), data: Number(s.slice(8, 18)) }
	}
	// tariff 可选，给出时充值量带单位与换算值；不给时（日志解析没有计价模式）注明单位随寄存器 0x18
	function simTokenText(m, tariff) {
		if (!m) return ''
		if (!m.valid) return '模拟令牌（无效: ' + m.reason + '）'
		let x = '模拟令牌: ' + m.name + '，序号 ' + m.serial
		if (m.dataKind === 'amount') x += '，充值量 ' + qtyRawText(m.data, tariff)
		else if (m.dataKind === 'bits') x += '，测试位图 0x' + m.data.toString(16).toUpperCase().padStart(8, '0')
		else if (m.dataKind === 'code') x += '，结果码 ' + m.data
		return x
	}

	// READ 请求
	function readReqEncode(start, count) {
		if (count < 1 || count > READ_MAX_REGS || start + count - 1 > 0xff) throw new Error('READ 数量/范围非法')
		return Uint8Array.from([start & 0xff, count & 0xff])
	}
	// { error:'length' } 长度错（丢弃）；{ error:'range' } 数量/范围非法（NAK 0x05）
	function readReqDecode(p) {
		if (p.length !== 2) return { error: 'length' }
		const start = p[0]
		const count = p[1]
		if (count === 0 || count > READ_MAX_REGS || start + count - 1 > 0xff) return { error: 'range', start: start }
		return { start: start, count: count }
	}

	// ===== TLV =====
	function encFixedWidth(enc) {
		switch ((enc >> 4) & 3) {
			case 0: return 1
			case 1: return 2
			case 2: return 4
			default: return 0
		}
	}
	function makeEnc(type, len, dec) { return ((type & 3) << 6) | ((len & 3) << 4) | (dec & 0x0f) }
	const ENC_TYPE = { U: 0, I: 1, BCD: 2, BYTES: 3 }
	const ENC_LEN = { L1: 0, L2: 1, L4: 2, VAR: 3 }
	const encTypeOf = e => (e >> 6) & 3
	const encDecOf = e => e & 0x0f

	// 写入端: 装不下就停手，绝不截断某一个 TLV。put* 返回 0 成功 / 1 装不下 / 2 参数错
	function createTlvWriter(cap) {
		const limit = Math.min(cap == null ? TLV_TOTAL_MAX : cap, TLV_TOTAL_MAX)
		const buf = []
		let count = 0
		const w = {
			putInvalid(id) {
				if (buf.length + 2 > limit) return 1
				buf.push(id & 0xff, ENC_INVALID)
				count++
				return 0
			},
			put(id, enc, val) {
				if (enc === ENC_INVALID) return w.putInvalid(id)
				const v = toU8(val || [])
				const fixed = encFixedWidth(enc)
				let need
				if (fixed) {
					if (v.length !== fixed) return 2
					need = 2 + v.length
				} else {
					if (v.length > VARLEN_VALUE_MAX) return 2
					need = 3 + v.length
				}
				if (encTypeOf(enc) >= ENC_TYPE.BCD && encDecOf(enc) !== 0) return 2
				if (buf.length + need > limit) return 1
				buf.push(id & 0xff, enc)
				if (!fixed) buf.push(v.length)
				for (let i = 0; i < v.length; i++) buf.push(v[i])
				count++
				return 0
			},
			putU(id, enc, value) {
				const width = encFixedWidth(enc)
				if (!width) return 2
				const t = []
				for (let i = width - 1; i >= 0; i--) t.push((value >>> (i * 8)) & 0xff)
				return w.put(id, enc, t)
			},
			bytes() { return Uint8Array.from(buf) },
			get count() { return count },
			get used() { return buf.length },
		}
		return w
	}
	// 解析端: { ok, tlvs:[{id,enc,invalid,len,val}], error }，截断的 TLV 整段判错
	function tlvParse(payload) {
		const p = toU8(payload)
		const tlvs = []
		let i = 0
		while (i < p.length) {
			if (p.length - i < 2) return { ok: false, tlvs: tlvs, error: 'TLV 头不完整' }
			const id = p[i]
			const enc = p[i + 1]
			if (enc === ENC_INVALID) {
				tlvs.push({ id: id, enc: enc, invalid: true, len: 0, val: null, off: i })
				i += 2
				continue
			}
			const fixed = encFixedWidth(enc)
			if (fixed) {
				if (p.length - i < 2 + fixed) return { ok: false, tlvs: tlvs, error: 'TLV 值被截断' }
				tlvs.push({ id: id, enc: enc, invalid: false, len: fixed, val: p.subarray(i + 2, i + 2 + fixed), off: i })
				i += 2 + fixed
				continue
			}
			if (p.length - i < 3) return { ok: false, tlvs: tlvs, error: 'TLV 缺长度字节' }
			const len = p[i + 2]
			if (3 + len > p.length - i) return { ok: false, tlvs: tlvs, error: 'TLV 变长值被截断' }
			tlvs.push({ id: id, enc: enc, invalid: false, len: len, val: p.subarray(i + 3, i + 3 + len), off: i })
			i += 3 + len
		}
		return { ok: true, tlvs: tlvs, error: null }
	}
	// 定宽 U/I 值（I 做符号扩展）；其余类型返回 null
	function tlvInt(t) {
		if (t.invalid || !t.val) return null
		const type = encTypeOf(t.enc)
		if (type !== ENC_TYPE.U && type !== ENC_TYPE.I) return null
		if (!encFixedWidth(t.enc) || t.len < 1 || t.len > 4) return null
		let raw = 0
		for (let i = 0; i < t.len; i++) raw = raw * 256 + t.val[i]
		if (type === ENC_TYPE.I && raw >= Math.pow(2, t.len * 8 - 1)) raw -= Math.pow(2, t.len * 8)
		return raw
	}

	// 定点显示: 整数 ÷ 10^d
	function fmtScaled(v, d) {
		const neg = v < 0
		let s = String(Math.abs(v))
		if (d > 0) {
			s = s.padStart(d + 1, '0')
			s = s.slice(0, -d) + '.' + s.slice(-d)
		}
		return (neg ? '-' : '') + s
	}

	// 量值的最小单位: 原始整数即按此计数。线上不传币种（5.1），金额只能写「货币单位」
	function qtyUnit(tariff) {
		if (!tariff) return ''
		if (!tariff.currency) return 'dL'
		return tariff.dec > 0 ? '0.' + '0'.repeat(tariff.dec - 1) + '1 货币单位' : '货币单位'
	}
	// 原始整数 + 单位 + 换算后的显示值，如「500 dL（= 50.0 L）」
	function qtyRawText(v, tariff) {
		if (!tariff) return v + '（最小单位，随计价模式 0x18：体积 dL / 金额 10^-d 货币单位）'
		if (!tariff.currency) return v + ' dL（= ' + fmtScaled(v, 1) + ' L）'
		return tariff.dec > 0 ? v + ' × ' + qtyUnit(tariff) + '（= ' + fmtScaled(v, tariff.dec) + ' 货币单位）' : v + ' 货币单位'
	}

	// 告警码列表(2B BCD 逐码): 返回码字符串数组; 长度奇数/非法 BCD/超过 27 个返回 null
	function alarmListDecode(val) {
		const v = toU8(val)
		if (v.length === 0) return []
		if (v.length % 2 !== 0 || v.length / 2 > ALARM_MAX_CODES || !bcdValid(v)) return null
		const out = []
		for (let i = 0; i < v.length; i += 2) out.push(bcdUnpack(v.subarray(i, i + 2)))
		return out
	}
	function alarmListEncode(codes) {
		const list = codes || []
		if (list.length > ALARM_MAX_CODES) throw new Error('告警码最多 27 个')
		const out = []
		for (const c of list) {
			const b = /^\d{4}$/.test(String(c)) ? bcdPack(String(c)) : null
			if (!b) throw new Error('告警码需 4 位十进制: ' + c)
			out.push(b[0], b[1])
		}
		return Uint8Array.from(out)
	}

	// 充值记录 7B: u24 分钟(自 2020-01-01) + u32 量; 未写满槽整条 0xFF
	function recordEncode(rec) {
		const a = []
		if (!rec || rec.empty) return new Uint8Array(RECORD_LEN).fill(0xff)
		const m = rec.minutes >>> 0
		if (m > RECORD_EPOCH_UNSET) throw new Error('受理时刻超出 u24')
		a.push((m >>> 16) & 0xff, (m >>> 8) & 0xff, m & 0xff)
		putU32(a, rec.amount >>> 0)
		return Uint8Array.from(a)
	}
	function recordDecode(val) {
		const v = toU8(val)
		if (v.length !== RECORD_LEN) return null
		let allFF = true
		for (let i = 0; i < v.length; i++) if (v[i] !== 0xff) allFF = false
		if (allFF) return { empty: true, minutes: RECORD_EPOCH_UNSET, amount: 0, rtcUnset: true }
		const m = (v[0] << 16) | (v[1] << 8) | v[2]
		return { empty: false, minutes: m, amount: u32(v, 3), rtcUnset: m === RECORD_EPOCH_UNSET }
	}
	// 自 2020-01-01 的分钟数 -> 表计本地时间字符串（纯算术，不受浏览器时区影响）
	function recordTimeStr(minutes) {
		const d = new Date(Date.UTC(2020, 0, 1, 0, minutes))
		const p2 = n => (n < 10 ? '0' : '') + n
		return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes())
	}

	// WRITE
	function writeReqEncode(reg, val) {
		const v = toU8(val || [])
		if (1 + v.length > PAYLOAD_MAX) throw new Error('WRITE 载荷过长')
		const o = new Uint8Array(1 + v.length)
		o[0] = reg & 0xff
		o.set(v, 1)
		return o
	}
	function writeReqDecode(p) {
		if (p.length < 1) return null
		return { reg: p[0], val: p.subarray(1) }
	}
	function writeRspEncode(reg, result) { return Uint8Array.from([reg & 0xff, result & 0xff]) }
	function writeRspDecode(p) {
		if (p.length !== 2) return null
		return { reg: p[0], result: p[1] }
	}

	// STATUS
	function statusRspEncode(s) {
		const a = []
		putU32(a, s.remaining >>> 0)
		a.push(s.valve & 0xff, s.meterStatus & 0xff, (s.batteryCv >> 8) & 0xff, s.batteryCv & 0xff)
		return Uint8Array.from(a)
	}
	function statusRspDecode(p) {
		if (p.length !== 8) return null
		return { remaining: i32(p, 0), valve: p[4], meterStatus: p[5], batteryCv: (p[6] << 8) | p[7] }
	}

	// NAK: 0x00/0xFE/0xFF 不得作原因码
	function nakEncode(reason, echo) {
		if (reason === 0 || reason === 0xfe || reason === 0xff) throw new Error('NAK 原因码非法')
		return Uint8Array.from([reason & 0xff, echo & 0xff])
	}
	function nakDecode(p) {
		if (p.length !== 2) return null
		return { reason: p[0], echo: p[1] }
	}

	// RESULT
	function resultReqEncode(tgt) {
		if (tgt & 0x80) throw new Error('TGT bit7 为 RFU，必须为 0')
		return Uint8Array.from([tgt & 0x7f])
	}
	// RFU 位置位不判错，屏蔽后比较
	function resultReqDecode(p) {
		if (p.length !== 1) return null
		return { tgt: p[0] & 0x7f }
	}
	// r: { pollState, tgt, etaS, tail }
	function resultRspEncode(r) {
		const a = [r.pollState & 0xff, r.tgt & 0x7f]
		if (r.pollState === POLL_UNKNOWN) return Uint8Array.from(a)
		if (r.pollState === POLL_WORKING) {
			a.push(r.etaS & 0xff)
			return Uint8Array.from(a)
		}
		if (r.pollState === POLL_DONE) {
			const t = toU8(r.tail || [])
			if (t.length < 1 || 2 + t.length > PAYLOAD_MAX) throw new Error('RESULT 尾部长度非法')
			for (let i = 0; i < t.length; i++) a.push(t[i])
			return Uint8Array.from(a)
		}
		throw new Error('RFU 轮询状态不由本端发送')
	}
	function resultRspDecode(p) {
		if (p.length < 2) return null
		const r = { pollState: p[0], tgt: p[1] & 0x7f, etaS: ETA_UNKNOWN, tail: null }
		switch (p[0]) {
			case POLL_UNKNOWN: return p.length === 2 ? r : null
			case POLL_WORKING:
				if (p.length !== 3) return null
				r.etaS = p[2]
				return r
			case POLL_DONE:
				if (p.length < 3) return null
				r.tail = p.subarray(2)
				return r
			default:
				return r // 规则 7: 未知轮询状态整段忽略尾部
		}
	}

	// ===== 接收判定第 7 项: 载荷长度 =====
	// 返回 'ok' | 'length' | 'unknown'（'unknown' = 第 9 项，仅表体侧对请求有意义）
	// polledType: RESULT 响应状态 2 的尾部按被轮询类型校验，未知传 0xFF
	function payloadLenOk(dir, type, payload, polledType) {
		const len = payload.length
		if (dir === DIR_REQUEST) {
			switch (type) {
				case TYPE.TOKEN: return len === 10 ? 'ok' : 'length'
				case TYPE.READ: return len === 2 ? 'ok' : 'length'
				case TYPE.STATUS: return len === 0 ? 'ok' : 'length'
				case TYPE.RESULT: return len === 1 ? 'ok' : 'length'
				case TYPE.WRITE: return len >= 1 ? 'ok' : 'length'
				default: return 'unknown'
			}
		}
		switch (type) {
			case TYPE.TOKEN: {
				if (len < 1) return 'length'
				const st = payload[0]
				if (st === TOKEN_ACCEPTED) return len === 1 ? 'ok' : 'length'
				if (st === TOKEN_DONE_NOEXEC) return len >= 2 ? 'ok' : 'length' // M >= 1，不锁定为 5
				if (st === TOKEN_DONE_EXEC) return len >= 10 ? 'ok' : 'length'
				return 'ok' // 未知处理状态: 尾部布局未知，交给上层按规则 8 结束
			}
			case TYPE.READ: return len >= 2 ? 'ok' : 'length'
			case TYPE.WRITE: return len === 2 ? 'ok' : 'length'
			case TYPE.STATUS: return len === 8 ? 'ok' : 'length'
			case TYPE.NAK: return len === 2 ? 'ok' : 'length'
			case TYPE.RESULT: {
				if (len < 2) return 'length'
				const st = payload[0]
				if (st === POLL_UNKNOWN) return len === 2 ? 'ok' : 'length'
				if (st === POLL_WORKING) return len === 3 ? 'ok' : 'length'
				if (st === POLL_DONE) {
					if (polledType == null || polledType > 7) return len >= 3 ? 'ok' : 'length'
					return payloadLenOk(DIR_RESPONSE, polledType, payload.subarray(2), 0xff)
				}
				return 'ok' // 规则 7: 未知轮询状态尾部整段忽略
			}
			default: return 'unknown'
		}
	}

	// 表体侧: 1 长度 / 2 CRC / 3 方向 / 4 表号 / 7 载荷长度 / 9 未知类型(回 NAK 0x01)
	function meterGate(bytes, meter) {
		const f = parseRaw(bytes)
		if (!f.ok) return f
		if (f.dir !== DIR_REQUEST) return { ok: false, item: 3, reason: 'dir' }
		if (!equalBytes(f.meter, meterBcd(meter))) return { ok: false, item: 4, reason: 'meter' }
		const r = payloadLenOk(f.dir, f.type, f.payload, 0xff)
		if (r === 'unknown') return { ok: false, item: 9, reason: 'unknown-type', nak: { reason: NAK.UNKNOWN_TYPE, echo: f.type }, txn: f.txn, type: f.type }
		if (r !== 'ok') return { ok: false, item: 7, reason: 'payload-length' }
		return f
	}

	// CIU 侧: 1..8。ctx: { meter, inflight:{type,txn}|null, pendingTgt:number|null }
	function ciuGate(bytes, ctx) {
		const f = parseRaw(bytes)
		if (!f.ok) return f
		if (f.dir !== DIR_RESPONSE) return { ok: false, item: 3, reason: 'dir' }
		if (!equalBytes(f.meter, meterBcd(ctx.meter))) return { ok: false, item: 4, reason: 'meter' }
		if (!ctx.inflight || f.txn !== ctx.inflight.txn) return { ok: false, item: 5, reason: 'txn' }
		if (f.type !== ctx.inflight.type && f.type !== TYPE.NAK) return { ok: false, item: 6, reason: 'type' }
		const pending = ctx.pendingTgt != null
		const polled = (f.type === TYPE.RESULT && pending) ? tgtType(ctx.pendingTgt) : 0xff
		const r = payloadLenOk(f.dir, f.type, f.payload, polled)
		if (r !== 'ok') return { ok: false, item: 7, reason: r === 'unknown' ? 'type' : 'payload-length' }
		if (f.type === TYPE.RESULT) {
			// 第 7 项已保证前缀 2 字节存在；bit7 为 RFU，屏蔽后比较
			const tgt = f.payload[1] & 0x7f
			if (!pending || tgt !== ctx.pendingTgt) return { ok: false, item: 8, reason: 'tgt' }
		}
		return f
	}

	// ===== 嵌套解码入口 =====
	// 数据区恰是一个 CRC 正确的应用帧才算找到（无定界符，不做扫描）
	function findFrame(bytes) {
		const b = toU8(bytes)
		const empty = { found: false, offset: 0, length: b.length, frame: b, prefix: 0, suffix: 0 }
		const f = parseRaw(b)
		if (!f.ok || f.type > TYPE.RESULT) return empty
		return { found: true, offset: 0, length: b.length, frame: b, prefix: 0, suffix: 0 }
	}

	// ===== 解析 / 展示 =====
	function tokenRspLines(t, lines) {
		if (!t) { lines.push('TOKEN 响应载荷长度非法'); return }
		if (!t.known) { lines.push('处理状态 = ' + hexByte(t.procStatus) + '（未知，按规则 8 失败结束）'); return }
		if (t.procStatus === TOKEN_ACCEPTED) {
			lines.push('处理状态 = 0 已受理，尚未处理（不是成功，需 RESULT 轮询）')
			return
		}
		if (t.procStatus === TOKEN_DONE_NOEXEC) lines.push('处理状态 = 1 已完成，令牌未执行')
		else lines.push('处理状态 = 2 已完成，令牌已执行')
		if (t.procStatus === TOKEN_DONE_EXEC) {
			lines.push('本次充值量 = ' + t.credited + '（原始整数，标度见寄存器 0x18）')
			lines.push('剩余量 = ' + t.remaining + '（原始整数）')
		}
		stsResultLines(t.stsBlock, t.procStatus, lines)
	}
	function tlvValueText(t) {
		if (t.invalid) return '无效标记(未定义或当前不可读)'
		if (t.id >= REG.RECORD_FIRST && t.id <= REG.RECORD_LAST && t.len === RECORD_LEN) {
			const r = recordDecode(t.val)
			if (r.empty) return '空槽(未写满)'
			return (r.rtcUnset ? '受理时刻未知(RTC 未校准)' : recordTimeStr(r.minutes)) + ' 充值量 ' + r.amount
		}
		if (t.id === REG.ALARM_LIST) {
			const codes = alarmListDecode(t.val)
			if (codes === null) return '告警码列表非法: ' + hexSpaced(t.val)
			return codes.length ? codes.join(' ') + '（' + codes.length + ' 个）' : '无告警'
		}
		const type = encTypeOf(t.enc)
		const d = encDecOf(t.enc)
		if (type === ENC_TYPE.U || type === ENC_TYPE.I) {
			const v = tlvInt(t)
			if (v == null) return hexSpaced(t.val)
			return fmtScaled(v, d) + (d ? '（原始 ' + v + '，d=' + d + '）' : '')
		}
		if (type === ENC_TYPE.BCD) {
			const s = bcdUnpack(t.val)
			return s == null ? hexSpaced(t.val) : s
		}
		if (t.id === REG.VALVE) return hexByte(t.val[0]) + valveText(t.val[0])
		if (t.id === REG.METER_STATUS) return hexByte(t.val[0]) + meterStatusText(t.val[0])
		if (t.id === REG.FW_VER) return '"' + Array.from(t.val, c => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.')).join('') + '"'
		return hexSpaced(t.val)
	}
	function valveText(v) {
		const pos = v & VALVE_POS_MASK
		const s = [pos === VALVE_POS_OPEN ? '开阀' : pos === VALVE_POS_CLOSED ? '关阀' : pos === 0 ? '位置不明' : '保留']
		if (v & VALVE_TEST_ACTIVE) s.push('阀控测试中')
		if (v & VALVE_FAULT) s.push('动作故障')
		return ' (' + s.join(' ') + ')'
	}
	function meterStatusText(v) {
		const names = [[MST_LOW_CREDIT, '低余量'], [MST_LOW_BATTERY, '低电压'], [MST_MAGNETIC, '磁攻击'], [MST_TAMPER, '防拆'],
			[MST_REVERSE_FLOW, '反向流'], [MST_POSTPAID, '后付费'], [MST_ALARM_LIST, '告警列表非空']]
		const s = names.filter(x => v & x[0]).map(x => x[1])
		return s.length ? ' (' + s.join(' ') + ')' : ''
	}
	function decodePayloadLines(f, polledType) {
		const p = f.payload
		const lines = []
		const T = f.type
		if (f.dir === DIR_REQUEST) {
			switch (T) {
				case TYPE.TOKEN: {
					const d = tokenReqDecode(p)
					lines.push('令牌 = ' + (d == null ? '(非法 BCD)' : d))
					if (d != null && simTokenDecode(d)) lines.push(simTokenText(simTokenDecode(d)))
					break
				}
				case TYPE.READ: {
					const r = readReqDecode(p)
					if (r.error) lines.push('READ 请求非法(' + r.error + ')')
					else lines.push('起始寄存器 = ' + hexByte(r.start) + '，数量 = ' + r.count)
					break
				}
				case TYPE.WRITE: {
					const r = writeReqDecode(p)
					lines.push('寄存器 = ' + hexByte(r.reg) + ' ' + regName(r.reg) + '，值 = ' + (r.val.length ? hexSpaced(r.val) : '(空)'))
					break
				}
				case TYPE.STATUS:
					lines.push('STATUS 请求，载荷为空')
					break
				case TYPE.RESULT:
					lines.push('轮询目标 TGT = ' + hexByte(p[0] & 0x7f) + '（TYPE ' + (TYPE_NAME[tgtType(p[0])] || tgtType(p[0])) + ' + TXN ' + tgtTxn(p[0]) + '）')
					break
				default:
					lines.push('未知/RFU 类型，表体应回 NAK 0x01')
			}
			return lines
		}
		switch (T) {
			case TYPE.TOKEN:
				tokenRspLines(tokenRspDecode(p), lines)
				break
			case TYPE.READ: {
				const r = tlvParse(p)
				r.tlvs.forEach(t => lines.push(hexByte(t.id) + ' ' + regName(t.id) + ' = ' + tlvValueText(t)))
				if (!r.ok) lines.push('TLV 结构错误: ' + r.error)
				break
			}
			case TYPE.WRITE: {
				const r = writeRspDecode(p)
				const res = r.result
				lines.push('寄存器 = ' + hexByte(r.reg) + ' ' + regName(r.reg))
				lines.push('结果 = ' + hexByte(res) + (res === WRITE_OK ? ' 成功(终局)' : res === WRITE_ACCEPTED ? ' 已受理(不是成功，需 RESULT 轮询)' : res >= 1 && res <= 7 ? ' 失败: ' + NAK_NAME[res] : ' 未知(按规则 8 失败)'))
				break
			}
			case TYPE.STATUS: {
				const s = statusRspDecode(p)
				lines.push('剩余量 = ' + s.remaining + '（原始整数，标度见寄存器 0x18）')
				lines.push('阀门 = ' + hexByte(s.valve) + valveText(s.valve))
				lines.push('表计状态 = ' + hexByte(s.meterStatus) + meterStatusText(s.meterStatus))
				lines.push('电池 = ' + fmtScaled(s.batteryCv, 2) + ' V')
				break
			}
			case TYPE.NAK: {
				const n = nakDecode(p)
				lines.push('原因 = ' + hexByte(n.reason) + ' ' + (NAK_NAME[n.reason] || '未知') + '，回显 = ' + hexByte(n.echo))
				break
			}
			case TYPE.RESULT: {
				const r = resultRspDecode(p)
				const st = r.pollState
				lines.push('轮询状态 = ' + st + (st === POLL_UNKNOWN ? ' 句柄未知或已过期' : st === POLL_WORKING ? ' 处理中' : st === POLL_DONE ? ' 已完成' : ' 未知(按处理中继续轮询)'))
				lines.push('TGT = ' + hexByte(r.tgt) + '（' + (TYPE_NAME[tgtType(r.tgt)] || '?') + ' TXN ' + tgtTxn(r.tgt) + '）')
				if (st === POLL_WORKING) lines.push('预计剩余 = ' + (r.etaS === ETA_UNKNOWN ? '未知(0xFF)' : r.etaS + ' s'))
				if (st === POLL_DONE) {
					const pt = polledType != null && polledType <= 7 ? polledType : tgtType(r.tgt)
					lines.push('终局响应载荷(' + (TYPE_NAME[pt] || '?') + '):')
					if (pt === TYPE.TOKEN) tokenRspLines(tokenRspDecode(r.tail), lines)
					else if (pt === TYPE.WRITE) {
						const w = r.tail.length === 2 ? writeRspDecode(r.tail) : null
						lines.push(w ? '寄存器 ' + hexByte(w.reg) + ' 结果 ' + hexByte(w.result) : hexSpaced(r.tail))
					} else lines.push(hexSpaced(r.tail))
				}
				break
			}
			default:
				lines.push('未知类型')
		}
		return lines
	}

	function payloadSegs(f) {
		const segs = []
		const p = f.payload
		const base = 5
		const add = (off, len, tip, grp) => { if (len > 0) segs.push({ off: base + off, len: len, tip: tip, grp: grp }) }
		if (f.dir === DIR_REQUEST) {
			if (f.type === TYPE.TOKEN) add(0, p.length, '令牌 20 位 BCD', '令牌')
			else if (f.type === TYPE.READ && p.length === 2) { add(0, 1, '起始寄存器', '起始'); add(1, 1, '数量', '数量') }
			else if (f.type === TYPE.WRITE && p.length >= 1) { add(0, 1, '寄存器 id', '寄存器'); add(1, p.length - 1, '写入值', '值') }
			else if (f.type === TYPE.RESULT) add(0, p.length, 'TGT', 'TGT')
			else add(0, p.length, '载荷', '载荷')
			return segs
		}
		switch (f.type) {
			case TYPE.TOKEN:
				add(0, 1, '处理状态', '状态')
				if (p[0] === TOKEN_DONE_EXEC && p.length >= 10) { add(1, 4, '本次充值量', '充值量'); add(5, 4, '剩余量', '剩余量'); stsBlockSegs(add, 9, p.length - 9) }
				else if (p[0] === TOKEN_DONE_NOEXEC) stsBlockSegs(add, 1, p.length - 1)
				break
			case TYPE.READ: {
				const r = tlvParse(p)
				r.tlvs.forEach(t => {
					const total = t.invalid ? 2 : (encFixedWidth(t.enc) ? 2 + t.len : 3 + t.len)
					add(t.off, total, hexByte(t.id) + ' ' + regName(t.id) + ' = ' + tlvValueText(t), 'TLV ' + hexByte(t.id))
				})
				break
			}
			case TYPE.WRITE: add(0, 1, '寄存器 id', '寄存器'); add(1, 1, '结果', '结果'); break
			case TYPE.STATUS: add(0, 4, '剩余量', '剩余量'); add(4, 1, '阀门状态', '阀门'); add(5, 1, '表计状态', '状态'); add(6, 2, '电池 0.01V', '电池'); break
			case TYPE.NAK: add(0, 1, '原因码', '原因'); add(1, 1, '回显', '回显'); break
			case TYPE.RESULT:
				add(0, 1, '轮询状态', '状态'); add(1, 1, '回显 TGT', 'TGT')
				if (p.length > 2) add(2, p.length - 2, p[0] === POLL_WORKING ? '预计剩余秒' : '尾部', '尾部')
				break
			default: add(0, p.length, '载荷', '载荷')
		}
		return segs
	}

	function stsBlockSegs(add, off, len) {
		if (len < STS_RESULT_LEN) { add(off, len, 'STS 结果块(旧格式，无法解析)', 'STS'); return }
		add(off, 2, 'STS 结果 index u16 BE', 'STS index'); add(off + 2, 4, 'STS 结果 Value u32 BE', 'STS Value')
		if (len > STS_RESULT_LEN) add(off + STS_RESULT_LEN, len - STS_RESULT_LEN, 'STS 结果块保留字节', 'STS 保留')
	}

	// 解析一段字节: 成功返回 { ok, dir, fields, decoded, errors, raw, segs, frame }
	function parseFrame(bytes) {
		const raw = toU8(bytes)
		const result = { raw: Array.from(raw), ok: false, errors: [], fields: {}, frameOffset: 0 }
		const f = parseRaw(raw)
		if (!f.ok) {
			result.errors.push(f.item === 1 ? '长度需 6..64，实际 ' + raw.length : 'CRC-8 不符')
			return result
		}
		const polled = f.type === TYPE.RESULT && f.payload.length >= 2 ? tgtType(f.payload[1]) : null
		if (payloadLenOk(f.dir, f.type, f.payload, polled == null ? 0xff : polled) === 'length') {
			result.errors.push('载荷长度与 ' + (TYPE_NAME[f.type] || 'TYPE ' + f.type) + ' 的要求不符')
		}
		if (f.type > TYPE.RESULT) result.errors.push('TYPE ' + f.type + ' 为 RFU')
		result.dir = f.dir ? 'up' : 'down'
		result.fields = {
			方向: f.dir ? '↑ 响应(表→CIU)' : '↓ 请求(CIU→表)',
			类型: { value: hexByte(f.type), name: TYPE_NAME[f.type] || 'RFU' },
			事务号: f.txn,
			表号: bcdUnpack(f.meter) || hexSpaced(f.meter),
			长度: raw.length + 'B',
		}
		if (!result.errors.length) {
			result.decoded = decodePayloadLines(f, polled).join('\n')
			result.segs = payloadSegs(f)
		}
		result.frame = { dir: f.dir, type: f.type, txn: f.txn }
		result.ok = result.errors.length === 0
		return result
	}

	function formatFrame(r) {
		let h = '<div class="sk-parse">'
		h += '<div class="sk-parse-bar">' + (r.ok ? '✓' : '✗') + '</div>'
		const f = r.fields || {}
		const cells = []
		for (const k in f) {
			const v = f[k]
			const val = (v != null && typeof v === 'object' && v.name !== undefined) ? escHtml(v.value) + ' (' + escHtml(v.name) + ')' : escHtml(String(v))
			cells.push({ name: k, value: val })
		}
		if (cells.length) {
			const COLS = 3
			h += '<table class="sk-parse-grid"><tbody>'
			for (let i = 0; i < cells.length; i += COLS) {
				h += '<tr>'
				for (let j = 0; j < COLS; j++) h += '<td class="sk-parse-hdr">' + (cells[i + j] ? escHtml(cells[i + j].name) : '') + '</td>'
				h += '</tr><tr>'
				for (let j = 0; j < COLS; j++) h += '<td>' + (cells[i + j] ? cells[i + j].value : '') + '</td>'
				h += '</tr>'
			}
			h += '</tbody></table>'
		}
		if (r.decoded) {
			h += '<div class="sk-parse-tlvs"><details class="sk-parse-tag" open><summary>应用层数据域</summary>' +
				'<div class="sk-parse-items"><pre style="white-space:pre-wrap;margin:0;">' + escHtml(r.decoded) + '</pre></div></details></div>'
		}
		if (r.errors && r.errors.length) {
			h += '<div class="sk-parse-errors">'
			for (const e of r.errors) h += '<div>' + escHtml(e) + '</div>'
			h += '</div>'
		}
		return h + '</div>'
	}

	// 字节提示: 每字节 {tip, grp}
	function byteMap(r) {
		const bytes = Array.isArray(r.raw) ? r.raw : Array.from(r.raw || [])
		const n = bytes.length
		const map = new Array(n).fill('')
		if (!r.ok || n < FRAME_MIN) return map
		const set = (off, len, tip, grp) => { for (let k = 0; k < len; k++) if (off + k < n) map[off + k] = { tip: tip, grp: grp } }
		const b0 = bytes[0]
		set(0, 1, '帧头 ' + hexByte(b0) + ' (DIR=' + ((b0 >> 7) & 1) + ' TYPE=' + (TYPE_NAME[(b0 >> 4) & 7] || 'RFU') + ' TXN=' + (b0 & 0x0f) + ')', '帧头')
		set(1, 4, '表号 BCD ' + hexSpaced(bytes.slice(1, 5)), '表号')
		;(r.segs || []).forEach(s => set(s.off, s.len, s.tip, s.grp))
		set(n - 1, 1, 'CRC-8', 'CRC')
		return map
	}

	W.stsCiu = {
		FRAME_MIN, FRAME_MAX, PAYLOAD_MAX, TLV_TOTAL_MAX, VARLEN_VALUE_MAX, TOKEN_DIGITS, READ_MAX_REGS, ALARM_MAX_CODES,
		RECORD_LEN, RECORD_EPOCH_UNSET, ENC_INVALID, ETA_UNKNOWN, FINAL_PAYLOAD_MAX,
		DIR_REQUEST, DIR_RESPONSE, TYPE, TYPE_NAME, NAK, NAK_NAME,
		TOKEN_ACCEPTED, TOKEN_DONE_NOEXEC, TOKEN_DONE_EXEC, WRITE_OK, WRITE_ACCEPTED, POLL_UNKNOWN, POLL_WORKING, POLL_DONE,
		REG, REG_NAME, regName,
		VALVE_POS_MASK, VALVE_POS_CLOSED, VALVE_POS_OPEN, VALVE_TEST_ACTIVE, VALVE_FAULT,
		MST_LOW_CREDIT, MST_LOW_BATTERY, MST_MAGNETIC, MST_TAMPER, MST_REVERSE_FLOW, MST_POSTPAID, MST_ALARM_LIST,
		ENC_TYPE, ENC_LEN, makeEnc, encFixedWidth, encTypeOf, encDecOf,
		crc8, bcdPack, bcdUnpack, bcdValid, meterBcd, hexToBytes, hexSpaced, equalBytes,
		buildFrame, parseRaw, tgtOf, tgtType, tgtTxn,
		tokenReqEncode, tokenReqDecode, tokenRspEncode, tokenRspDecode,
		STS_RESULT_LEN, STS_IDX, STS_IDX_NAME, STS_CODE, STS_TEST_BIT, stsResultEncode, stsResultDecode,
		SIM_TOKEN_MAGIC, SIM_TOKEN_TYPES, simTokenEncode, simTokenDecode, simTokenText,
		readReqEncode, readReqDecode, createTlvWriter, tlvParse, tlvInt, fmtScaled, qtyUnit, qtyRawText,
		alarmListDecode, alarmListEncode, recordEncode, recordDecode, recordTimeStr,
		writeReqEncode, writeReqDecode, writeRspEncode, writeRspDecode,
		statusRspEncode, statusRspDecode, nakEncode, nakDecode,
		resultReqEncode, resultReqDecode, resultRspEncode, resultRspDecode,
		payloadLenOk, meterGate, ciuGate,
		findFrame, parseFrame, formatFrame, byteMap,
		valveText, meterStatusText, tlvValueText,
	}
})()
