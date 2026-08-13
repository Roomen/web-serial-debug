// W-MBUS (EN13757-3/-7 私有 profile) 协议解析 + 下行构造
// 帧: CI(1) ADDR(8) KeyID(1) MCNT(4LE) LEN(1) ENC(roundup16(LEN)) CMAC(8)
// 安全层: AES-128-CBC 加密 + AES-128-CMAC(RFC4493, 截断8字节) 认证; IV = ADDR(8)||MCNT(4LE)||0,0,0||dir(1)
// 注意: 空表(未配置表号)设备的 ADDR 后4字节现由固件用硬件UID兜底,不再固定为 00000000,
// 且写表号(0x80)成功后 ADDR 会立即变化 — 不要把 ADDR 当作长期稳定的设备唯一标识来缓存,一律以设备实际返回的帧为准。
// MCNT 防重放: 0x10/0x11/0x13~0x15(公开读,role=0)不校验新鲜度、任意值可用、不推进 last_mc;
// 0x12(读当前下行计数器,要求 role>0)、0x16 及所有写类(≥0x80)命令仍要求 MCNT > last_mc ——
// 0x12 需要角色鉴权, 实测其新鲜度校验行为与写命令一致, 不能当作纯公开读那样固定填任意值探测。
;(function () {
	'use strict'
	const W = window

	// ===== 基础字节工具 (protocol.js 中的同名函数是文件内闭包,未挂 window,这里自带一份) =====
	function toBytesAny(x) {
		if (x == null) return new Uint8Array(0)
		if (x instanceof Uint8Array) return x
		if (Array.isArray(x)) return new Uint8Array(x)
		if (typeof x === 'string') return toBytesHex(x)
		return new Uint8Array(0)
	}
	function toBytesHex(s) {
		let str = String(s || '').trim().replace(/\s+/g, '')
		if (str.length % 2 !== 0) str = '0' + str
		if (!/^[0-9a-fA-F]*$/.test(str)) return new Uint8Array(0)
		const a = new Uint8Array(str.length / 2)
		for (let i = 0; i < a.length; i++) a[i] = parseInt(str.substr(i * 2, 2), 16)
		return a
	}
	function hexByte(b) { return '0x' + ((b & 0xff) < 16 ? '0' : '') + (b & 0xff).toString(16).toUpperCase() }
	function hexbytes(b) {
		let s = ''
		for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16).toUpperCase()
		return s
	}
	function hexBytesSpaced(b) {
		const out = []
		for (let i = 0; i < b.length; i++) out.push(((b[i] < 16 ? '0' : '') + b[i].toString(16).toUpperCase()))
		return out.join(' ')
	}
	function escHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;')
	}
	function bytesEq(a, b) {
		if (a.length !== b.length) return false
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
		return true
	}
	function u32le(b, o) { o = o || 0; return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0) }
	function u16le(b, o) { o = o || 0; return (b[o] | (b[o + 1] << 8)) & 0xffff }
	function u64le(b, o) { o = o || 0; let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i] || 0); return v }
	function signed16(b, o) { o = o || 0; const v = u16le(b, o); return v > 0x7fff ? v - 0x10000 : v }
	function signed32le(b, o) { o = o || 0; return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) }
	function signed48le(b) {
		let v = 0n
		for (let i = 5; i >= 0; i--) v = (v << 8n) | BigInt(b[i])
		if (v >= (1n << 47n)) v -= (1n << 48n)
		return v
	}
	function u32leBytes(v) { v = v >>> 0; return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff] }
	function u64leBytes(v) {
		let bv = typeof v === 'bigint' ? v : BigInt(Math.trunc(v) || 0)
		if (bv < 0n) bv = 0n
		const out = []
		for (let i = 0; i < 8; i++) { out.push(Number(bv & 0xffn)); bv >>= 8n }
		return out
	}
	function bcdBytesBE(s, fillLen) {
		let digits = String(s || '').replace(/\D/g, '')
		const totalDigits = fillLen * 2
		while (digits.length < totalDigits) digits = '0' + digits
		digits = digits.slice(-totalDigits)
		const out = []
		for (let i = 0; i < digits.length; i += 2) out.push((parseInt(digits[i], 10) << 4) | parseInt(digits[i + 1], 10))
		return out
	}
	function bcdDecodeBE(b) {
		let s = ''
		for (let i = 0; i < b.length; i++) s += ((b[i] >> 4) & 0xf).toString(10) + (b[i] & 0xf).toString(10)
		return s
	}
	// 表号/基表号在设备存储与 LCD 显示上按字节反序(与 protocol.js 的 bcdEncode/bcdDecode 一致),
	// 仅用于 0x80/0x82 命令的 payload 编解码,不用于 ADDR(ADDR 按 wmbus_ids.h 固件约定,保持 bcdBytesBE 不反序)。
	function bcdBytesLE(s, fillLen) { return bcdBytesBE(s, fillLen).reverse() }
	function bcdDecodeLE(b) { return bcdDecodeBE(Array.from(b).reverse()) }
	// 设备时间戳一律按 UTC 字段解读, 不套浏览器时区。
	// 固件 bsp_common_func.c 用 mktime 把 RTC 的本地墙钟直接转 epoch、反向用 gmtime(嵌入式 newlib 无时区),
	// 即这个 4 字节字段装的是「本地时间冒充 UTC」。按浏览器本地时区渲染会再叠加一次时区偏移
	// (实测东八区显示比设备屏上快 8 小时), 用 UTC 渲染出来的才等于设备自己的钟。
	function fmtUnix(ts) {
		if (!ts) return '-----'
		const d = new Date(ts * 1000)
		if (isNaN(d.getTime())) return String(ts)
		const p = (n) => String(n).padStart(2, '0')
		return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds())
	}
	// 与设备口径一致的「当前时间」: 本地墙钟当作 UTC 取 epoch, 供下发时间戳类参数(如 0x16 dayTs)使用
	function deviceEpochNow() {
		return Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 1000)
	}
	// 本 profile 固件在 VIF 0x6D(4字节)里填的是 unix 秒, 不是 EN13757-3 标称的 Type-F 位域
	// (实测同一台设备相隔 42 s 的两帧只差 42, 按 Type-F 解会得到 2051 年这类伪值), 因此统一按 unix 秒显示。
	function fmtDeviceTime4(b) {
		if (!b || b.length < 4) return '(数据不足)'
		const ts = u32le(b, 0)
		return fmtUnix(ts) + ' (设备本地钟, unix秒=' + ts + ')'
	}
	function decodeDateTimeT(b) {
		// 设备时间结构体: 8 x uint32 LE (year,month,day,hour,minute,second,weekday,zone)
		if (!b || b.length < 32) return '(数据不足)'
		const year = u32le(b, 0), month = u32le(b, 4), day = u32le(b, 8)
		const hour = u32le(b, 12), minute = u32le(b, 16), second = u32le(b, 20)
		const p = (n) => String(n).padStart(2, '0')
		return year + '-' + p(month) + '-' + p(day) + ' ' + p(hour) + ':' + p(minute) + ':' + p(second)
	}

	// ===== AES-128 CBC / CMAC (基于 protocol-crypto.js 已有的 ECB 单块原语搭建) =====
	function aesEncBlock(block, rk) { return W.skAes128EcbEncryptBlock(block, rk) }
	function aesDecBlock(block, rk) { return W.skAes128EcbDecryptBlock(block, rk) }
	function xorBlock(a, b) { const o = new Uint8Array(16); for (let i = 0; i < 16; i++) o[i] = a[i] ^ b[i]; return o }
	function leftShift1(block) {
		const out = new Uint8Array(16)
		for (let i = 0; i < 16; i++) out[i] = ((block[i] << 1) & 0xff) | (i < 15 ? (block[i + 1] >> 7) : 0)
		return out
	}
	function cbcEncrypt(key, iv, data) {
		const rk = W.skAesKeyExpansion(key)
		const out = new Uint8Array(data.length)
		let prev = iv
		for (let o = 0; o < data.length; o += 16) {
			const blk = xorBlock(data.subarray(o, o + 16), prev)
			const enc = aesEncBlock(blk, rk)
			out.set(enc, o)
			prev = enc
		}
		return out
	}
	function cbcDecrypt(key, iv, data) {
		const rk = W.skAesKeyExpansion(key)
		const out = new Uint8Array(data.length)
		let prev = iv
		for (let o = 0; o < data.length; o += 16) {
			const cblk = data.subarray(o, o + 16)
			const dec = aesDecBlock(cblk, rk)
			for (let i = 0; i < 16; i++) out[o + i] = dec[i] ^ prev[i]
			prev = cblk
		}
		return out
	}
	function cmac(key, msg, tagLen) {
		const rk = W.skAesKeyExpansion(key)
		const zero = new Uint8Array(16)
		const L = aesEncBlock(zero, rk)
		let K1 = leftShift1(L)
		if (L[0] & 0x80) K1[15] ^= 0x87
		let K2 = leftShift1(K1)
		if (K1[0] & 0x80) K2[15] ^= 0x87
		const n = msg.length === 0 ? 1 : Math.ceil(msg.length / 16)
		const complete = msg.length !== 0 && (msg.length % 16 === 0)
		let lastBlock
		if (complete) {
			const start = (n - 1) * 16
			lastBlock = xorBlock(msg.subarray(start, start + 16), K1)
		} else {
			const start = (n - 1) * 16
			const rem = msg.subarray(start)
			const padded = new Uint8Array(16)
			padded.set(rem)
			padded[rem.length] = 0x80
			lastBlock = xorBlock(padded, K2)
		}
		let X = new Uint8Array(16)
		for (let i = 0; i < n - 1; i++) {
			X = aesEncBlock(xorBlock(X, msg.subarray(i * 16, (i + 1) * 16)), rk)
		}
		X = aesEncBlock(xorBlock(X, lastBlock), rk)
		return X.subarray(0, tagLen)
	}
	// RFC 4493 §4 自测向量 (key=2b7e151628aed2a6abf7158809cf4f3c, M="" => Mac=bb1d6929e95937287fa37d129b756746)
	;(function selfTest() {
		try {
			const key = toBytesHex('2b7e151628aed2a6abf7158809cf4f3c')
			const tag = cmac(key, new Uint8Array(0), 16)
			const expect = toBytesHex('bb1d6929e95937287fa37d129b756746')
			if (!bytesEq(tag, expect)) console.error('[wmbus] AES-CMAC 自测失败,请检查 protocol-crypto.js AES-ECB 字节序实现')
		} catch (e) { console.error('[wmbus] AES-CMAC 自测异常', e) }
	})()

	// ===== 协议常量 =====
	const CI_DOWN = 0x5B, CI_UP = 0x7A
	const HDR = 15, MACLEN = 8

	const CMD_TABLE = {
		0x10: { name: '读计量数据(抄表)' },
		0x11: { name: '读干预证据' },
		0x12: { name: '读当前下行计数器' },
		0x13: { name: '读故障运行时间段' },
		0x14: { name: '读存储状态' },
		0x15: { name: '读设备参数全集' },
		0x16: { name: '平台确认周期上报(REPORT_ACK)' },
		0x20: { name: '周期数据主动上报(仅上行)' },
		0x80: { name: '写表号' },
		0x81: { name: '写底度' },
		0x82: { name: '写基表号' },
		0x83: { name: '写角色密钥' },
		0x84: { name: '阀门控制' },
		0x85: { name: '配置应用平台网络地址' },
		0x86: { name: '配置APN' },
		0x87: { name: '立即上报(REPORT_NOW)' },
	}
	const RESULT_TABLE = {
		0: 'OK 成功', 1: 'AUTH_FAIL 鉴权失败(MAC不匹配)', 2: 'REPLAY 重放(计数器≤last_mc)',
		3: 'PERM_DENY 权限不足', 4: 'CMD_UNSUP 命令不支持', 5: 'FW_CRC_BAD 固件完整性门控拒绝',
		6: 'PARAM_ERR 参数非法/写失败', 7: 'FRAME_ERR 帧格式错误',
	}
	W.wmbusResultTable = RESULT_TABLE // 供 wmbus-transaction.js 探测计数器时给失败结果码配文案
	const ROLE_NAMES = { 0: '公开读(PUBLIC)', 1: '操作员(OPERATOR)', 2: '管理员(ADMIN)' }
	// 写底度(0x81)的约定上限: 10 个 9。协议字段本身是 uint64, 但表位数放不下更大的值,
	// 下发面板按此校验, 解析侧对超限值只做提示(可能来自别的上位机)。
	const DEGREE_MAX = 9999999999n
	const VALVE_CMD_NAMES = { 0: '关阀(CLOSE)', 1: '开阀(OPEN)', 3: '除锈(RUST)' }
	// 二级地址固定段, 与固件 Protocol/wmbus/wmbus_ids.h 一致(WMBUS_MANUFACTURER_ID/WMBUS_ID_VERSION/WMBUS_DEVICE_TYPE):
	// 厂商码临时用"SEK"(SECK 未注册,量产前需向 FLAG 核定 3 字母码后替换), 设备类型 0x07=水表。
	const ADDR_MANUF_LE = [0xAB, 0x4C] // WMBUS_MANUFACTURER_ID=0x4CAB, 存储为小端2字节
	const ADDR_VERSION = 0x01
	const ADDR_DEVICE_TYPE = 0x07

	// DIF 低4位 -> 数据长度(标准 M-Bus 表, 仅列出本协议用到及常见项)
	const DIF_LEN = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 4, 6: 6, 7: 8, 9: 1, 10: 2, 11: 3, 12: 4, 14: 6 }
	const VIF_TABLE = {
		0x11: { name: '净累计体积(10⁻⁵m³)', dec: (b) => (Number(signed48le(b)) * 1e-5).toFixed(5) + ' m³' },
		// 只含正向累计, 不减反向; 表屏主界面显示的是示值(正-反), 有反向流量时会比这里小, 属正常
		0x13: {
			name: '累计正向体积(10⁻³m³)',
			// 固件 260803 起 0x10 应答此字段为 DIF06(48位), 与 0x20 上报的净累计同宽;
			// 更早的固件是 DIF04(32位), 把 uint64 的 f->forward 强转 uint32, 累计量超过
			// 4294967.295 m³ 后高位丢失。按数据域实际长度解析, 两种固件都读得对。
			dec: (b) => {
				const raw = b.length >= 6 ? signed48le(b) : BigInt(u32le(b, 0))
				return (Number(raw) * 1e-3).toFixed(3) + ' m³ (= ' + raw.toString() + ' L, 仅正向,屏显为正-反示值)'
					+ (b.length < 6 ? ' ⚠ 旧固件(<260803)4字节字段, 超过 4294967.295 m³ 的部分设备侧已丢弃高位' : '')
			},
		},
		// 有符号: 反向流量为负值(固件按 int32 饱和填入, 不回绕)
		0x3B: { name: '瞬时流量', dec: (b) => signed32le(b, 0) + ' L/h' },
		// EN13757-3 里 VIF 0x5A 标称 10⁻¹℃, 但本 profile 固件(wmbus.c 组 0x10 应答处)直接把整数℃
		// 的 waterTempGet() 填进 0x5A, 没有乘 10 —— 固件已送检不再改, 这里按设备实际语义当整数℃解。
		// 若后续固件改用 0x5B(标准 1℃) 上报, 下面 0x5B 一条同样能解出正确值。
		0x5A: { name: '水温', dec: (b) => signed16(b, 0) + ' ℃' },
		0x5B: { name: '水温', dec: (b) => signed16(b, 0) + ' ℃' },
		0x6D: { name: '日期时间', dec: (b) => fmtDeviceTime4(b) },
		0x71: { name: '平均时长(采样间隔)', dec: (b) => u16le(b, 0) + ' 分钟' },
	}

	function tryDecodeDifVifStream(payload) {
		let o = 0
		const lines = []
		while (o < payload.length) {
			const dif = payload[o], vif = payload[o + 1]
			const len = DIF_LEN[dif & 0x0f]
			if (len == null || vif == null || !VIF_TABLE[vif] || o + 2 + len > payload.length) return { ok: false, lines }
			const raw = payload.subarray(o + 2, o + 2 + len)
			lines.push(VIF_TABLE[vif].name + ' = ' + VIF_TABLE[vif].dec(raw))
			o += 2 + len
		}
		return { ok: o > 0, lines }
	}

	// 0x20 周期上报明文解码, plain 不含 CMD 字节
	function decodeReportMeter(plain) {
		if (plain.length < 13) return { ok: false, lines: ['数据不足(至少13字节头)'] }
		let o = 0
		if (plain[o] !== 0x04 || plain[o + 1] !== 0x6D) return { ok: false, lines: ['基准时间 DIF/VIF 不匹配,原始=' + hexbytes(plain)] }
		o += 2
		const baseTime = fmtDeviceTime4(plain.subarray(o, o + 4)); o += 4
		if (plain[o] !== 0x02 || plain[o + 1] !== 0x71) return { ok: false, lines: ['采样间隔 DIF/VIF 不匹配'] }
		o += 2
		const interval = u16le(plain, o); o += 2
		const num = plain[o++]
		const more = plain[o++]
		const records = []
		for (let i = 0; i < num; i++) {
			if (o + 8 > plain.length) { records.push('(数据不足,缺第' + (i + 1) + '条起)'); break }
			if (plain[o] !== 0x06 || plain[o + 1] !== 0x11) { records.push('#' + (i + 1) + ' DIF/VIF不匹配 raw=' + hexbytes(plain.subarray(o, o + 8))); o += 8; continue }
			const m3 = Number(signed48le(plain.subarray(o + 2, o + 8))) * 1e-5
			records.push('#' + (i + 1) + ' 净累计(正-反) = ' + m3.toFixed(5) + ' m³')
			o += 8
		}
		//固件新增的实时尾块(12字节): DIF04 VIF3B 瞬时流量(有符号) + DIF04 VIF6D 采样时刻unix秒,老固件报文没有这一段
		let flowRate = null, sampleTs = null, tailNote = null
		if (o + 12 <= plain.length) {
			if (plain[o] === 0x04 && plain[o + 1] === 0x3B && plain[o + 6] === 0x04 && plain[o + 7] === 0x6D) {
				flowRate = signed32le(plain, o + 2)
				sampleTs = u32le(plain, o + 8)
				o += 12
			} else {
				tailNote = '实时尾块 DIF/VIF 不匹配,原始=' + hexbytes(plain.subarray(o, o + 12))
			}
		}
		return { ok: true, baseTime, interval, num, more, records, flowRate, sampleTs, tailNote }
	}

	function decodeDownPayload(cmd, payload) {
		switch (cmd) {
			case 0x16:
				if (payload.length < 4) return '(payload过短,需≥4字节 dayTs)'
				return 'dayTs = ' + u32le(payload, 0) + ' (' + fmtUnix(u32le(payload, 0)) + ')'
			case 0x80:
				return '表号(BCD) = ' + bcdDecodeLE(payload.subarray(0, Math.min(10, payload.length)))
			case 0x81: {
				let v = 0n
				const n = Math.min(payload.length, 8)
				for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(payload[i])
				// 固件写底度时把当前计量值一并置为该值(wmbus.c s_degreeFlow.forward = degree)。
				// 260803 起抄表(VIF 0x13)是48位, 大底度能原样读回; 更早固件只有32位, 回读是低32位截断值。
				return '底度 = ' + v.toString() + ' (设备原始单位, 详见 samplingDegreeSet 语义)'
					+ (v > 0xFFFFFFFFn ? ' ⚠ 超过4字节上限4294967295, 旧固件(<260803)抄表会显示为 ' + (v & 0xFFFFFFFFn).toString() + ' L; 可用0x15核对写入是否成功' : '')
					+ (v > DEGREE_MAX ? ' ⚠ 超过约定上限 ' + DEGREE_MAX.toString() + '(本工具不允许下发这么大的底度)' : '')
			}
			case 0x82:
				return '基表号(BCD) = ' + bcdDecodeLE(payload.subarray(0, Math.min(10, payload.length)))
			case 0x83:
				if (payload.length < 17) return '(payload过短,需1+16字节)'
				return '角色 = ' + (ROLE_NAMES[payload[0]] || ('未知' + payload[0])) + '  密钥 = ' + hexbytes(payload.subarray(1, 17))
			case 0x84:
				if (payload.length < 1) return '(payload过短,需子命令1字节)'
				return '子命令 = ' + (VALVE_CMD_NAMES[payload[0]] || ('未知(' + payload[0] + ')'))
			case 0x85: {
				if (payload.length < 1) return '(payload过短,需至少1字节类型)'
				const type = payload[0]
				const rest = payload.subarray(1)
				if (type === 0x00) {
					if (rest.length < 8) return 'IPv4 数据不足(需8字节 ip4+port4)'
					const ip = Array.from(rest.subarray(0, 4)).join('.')
					return '类型 = IPv4  IP = ' + ip + '  端口 = ' + u32le(rest, 4)
				}
				if (type === 0x01) {
					if (rest.length < 20) return 'IPv6 数据不足(需20字节 ip16+port4)'
					const groups = []
					for (let i = 0; i < 16; i += 2) groups.push((rest[i] | (rest[i + 1] << 8)).toString(16))
					return '类型 = IPv6  IP = ' + groups.join(':') + '  端口 = ' + u32le(rest, 16)
				}
				if (type === 0x02) {
					if (rest.length < 5) return 'URL 数据不足(需≥5字节 port4+url≥1)'
					let url
					try { url = new TextDecoder().decode(rest.subarray(4)) } catch (e) { url = hexbytes(rest.subarray(4)) }
					return '类型 = URL  端口 = ' + u32le(rest, 0) + '  URL = ' + url
				}
				return '未知类型 = ' + type + '  原始 = ' + hexbytes(rest)
			}
			case 0x86: {
				let apn
				try { apn = new TextDecoder().decode(payload) } catch (e) { apn = hexbytes(payload) }
				return 'APN = ' + apn
			}
			default:
				return payload.length ? ('原始载荷 = ' + hexbytes(payload)) : '(无参数)'
		}
	}

	// 上行应答: 首字节为结果码(0-7), 其余为 payload; 具体对应哪个读命令无法从帧本身确定,按长度+DIF/VIF结构给出最可能的解释
	function decodeUpPayload(payload) {
		const guesses = []
		const len = payload.length
		if (len === 0) { guesses.push('无 payload(纯结果码应答)'); return guesses }
		const generic = tryDecodeDifVifStream(payload)
		if (generic.ok) guesses.push('DIF/VIF 记录解析(如为「读计量数据」应答): ' + generic.lines.join('; '))
		if (len === 4) guesses.push('若为「读当前下行计数器」应答: downMc = ' + u32le(payload, 0))
		if (len === 36) {
			guesses.push('若为「读干预证据」应答: 次数 = ' + u32le(payload, 0) + '  最近时间 = ' + decodeDateTimeT(payload.subarray(4, 36)))
		}
		if (len === 65) {
			guesses.push('若为「读故障运行时间段」应答: 运行中 = ' + payload[0] + '  start = ' + decodeDateTimeT(payload.subarray(1, 33)) + '  end = ' + decodeDateTimeT(payload.subarray(33, 65)))
		}
		if (len === 35) {
			guesses.push('若为「读存储状态」应答: 已满 = ' + payload[0] + '  时间 = ' + decodeDateTimeT(payload.subarray(1, 33)) + '  保留天数 = ' + u16le(payload, 33))
		}
		if (len === 32 && !generic.ok) {
			// 固件 wmbus.c WMBUS_CMD_READ_PARAMS: meterId(10) || baseMeterId(10) || samplingDegree(8 LE) || samplingMeterFreq(4 LE)
			// 这里的底度是完整 64 位; 0x10 抄表的累计正向体积是另一个量(48位, 旧固件 32 位), 写大底度后可用本命令核对。
			const degree = u64le(payload, 20)
			guesses.push('若为「读设备参数全集」应答: 表号(BCD) = ' + bcdDecodeLE(payload.subarray(0, 10))
				+ '  基表号(BCD) = ' + bcdDecodeLE(payload.subarray(10, 20))
				+ '\n  底度 = ' + degree.toString() + ' L (' + (Number(degree) * 1e-3).toFixed(3) + ' m³, 安装时写入的起始值, 完整64位)'
				+ '\n  (底度≠抄表值: 写底度时当前计量值被置为该值, 之后随水流累加; 0x10 抄的是累加后的当前值)'
				+ '\n  采样频率 = ' + u32le(payload, 28))
		}
		if (!guesses.length) guesses.push('未识别出已知结构,原始载荷 = ' + hexbytes(payload))
		return guesses
	}

	// ===== 密钥 =====
	// 公开读(role 0)固定使用内置默认密钥,不然无人知道该填什么、公开读将无法使用。
	// 操作员/管理员(role 1/2)不内置默认密钥: 未输入时回落全 0 密钥,与设备未注入密钥时的全 0 兜底一致。
	const BUILTIN_KEY_BASE = new Uint8Array([0x53, 0x45, 0x43, 0x4B, 0x2D, 0x4D, 0x49, 0x44, 0x2D, 0x54, 0x45, 0x4D, 0x50, 0x4B, 0x45, 0x59])
	function defaultKey(role) {
		if (role === 0) return BUILTIN_KEY_BASE
		return new Uint8Array(16)
	}
	// 三个角色各有独立密钥(公开读/操作员/管理员互不相同), 因此不能像 SK 那样用单一密钥字段覆盖全部角色。
	// 公开读(role 0)按协议固定使用内置默认密钥,不接受用户输入(下发面板不显示其密钥框)。
	// 操作员/管理员取值优先级: 显式传入的 opt.roleKeys[role] > localStorage 中该角色的 HEX 输入 > ASCII 输入(UTF-8 取前16字节,不足补0)
	// > 全 0 密钥(未输入时的兜底,不内置默认)。
	// 密钥存于 localStorage 而非直接读 DOM: 下发面板同一时刻只显示当前选中角色的密钥框(见 initDownUi),
	// 但上行报文解析可能遇到任意角色, resolveRoleKey 需要能取到未在框中显示的角色的已保存密钥。
	const ROLE_KEY_STORAGE_ID = { 1: 'wmbusKeyRole1', 2: 'wmbusKeyRole2' }
	function loadRoleKeyStore(role) {
		if (typeof localStorage === 'undefined' || !ROLE_KEY_STORAGE_ID[role]) return { ascii: '', hex: '' }
		try {
			const raw = localStorage.getItem(ROLE_KEY_STORAGE_ID[role])
			return raw ? JSON.parse(raw) : { ascii: '', hex: '' }
		} catch (e) { return { ascii: '', hex: '' } }
	}
	function saveRoleKeyStore(role, data) {
		if (typeof localStorage === 'undefined' || !ROLE_KEY_STORAGE_ID[role]) return
		try { localStorage.setItem(ROLE_KEY_STORAGE_ID[role], JSON.stringify(data)) } catch (e) { /* 忽略存储失败 */ }
	}
	function asciiKeyToBytes(s) {
		if (!s) return null
		let bytes
		if (typeof TextEncoder !== 'undefined') bytes = new TextEncoder().encode(s)
		else { bytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff }
		if (!bytes.length) return null
		const k = new Uint8Array(16)
		k.set(bytes.subarray(0, 16))
		return k
	}
	function resolveRoleKey(opt, role) {
		if (opt && opt.roleKeys && opt.roleKeys[role]) {
			const raw = toBytesHex(opt.roleKeys[role])
			if (raw.length >= 16) return raw.subarray(0, 16)
		}
		if (role === 0) return defaultKey(0)
		const store = loadRoleKeyStore(role)
		if (store.hex) {
			const raw = toBytesHex(store.hex)
			if (raw.length >= 16) return raw.subarray(0, 16)
		}
		const asciiBytes = asciiKeyToBytes(store.ascii)
		if (asciiBytes) return asciiBytes
		return defaultKey(role)
	}

	function ivBuild(addr, mcnt, dir) {
		const iv = new Uint8Array(16)
		iv.set(addr.subarray(0, 8), 0)
		iv[8] = mcnt & 0xff; iv[9] = (mcnt >>> 8) & 0xff; iv[10] = (mcnt >>> 16) & 0xff; iv[11] = (mcnt >>> 24) & 0xff
		iv[12] = iv[13] = iv[14] = 0
		iv[15] = dir & 0xff
		return iv
	}

	// ===== 解析 =====
	W.wmbusParseFrame = function (bytes, opt) {
		opt = opt || {}
		const b = toBytesAny(bytes)
		const result = { dir: 'unknown', raw: Array.from(b), ok: false, macOk: false, decryptOk: false, needKey: false, errors: [], fields: {}, tlv: [] }
		const errors = result.errors
		if (b.length < HDR + 16 + MACLEN) { errors.push('报文过短'); return result }
		const ci = b[0]
		if (ci !== CI_DOWN && ci !== CI_UP) errors.push('CI字段非法(期望0x5B下行/0x7A上行), 实际0x' + ci.toString(16).toUpperCase())
		const dir = ci === CI_UP ? 'up' : 'down'
		const addr = b.subarray(1, 9)
		const keyId = b[9]
		const mcnt = u32le(b, 10)
		const plainLen = b[14]
		if (plainLen === 0) errors.push('明文长度 LEN = 0')
		const encLen = (plainLen + 15) & ~15
		const need = HDR + encLen + MACLEN
		if (b.length !== need) errors.push('报文长度不符 期望' + need + ' 实际' + b.length)
		const encEnd = Math.min(HDR + encLen, b.length)
		const enc = b.subarray(HDR, encEnd)
		const mac = b.subarray(encEnd, Math.min(encEnd + MACLEN, b.length))
		const key = resolveRoleKey(opt, keyId)

		let plain = null, macOk = false, decryptOk = false
		if (enc.length === encLen && mac.length === MACLEN) {
			const macCalc = cmac(key, b.subarray(0, encEnd), MACLEN)
			macOk = bytesEq(macCalc, mac)
			const iv = ivBuild(addr, mcnt, dir === 'up' ? 1 : 0)
			const dec = cbcDecrypt(key, iv, enc)
			plain = dec.subarray(0, Math.min(plainLen, dec.length))
			decryptOk = true
		} else {
			errors.push('密文/CMAC 字段不完整,无法校验解密(报文被截断?)')
		}

		result.dir = dir
		result.macOk = macOk
		result.decryptOk = decryptOk
		result.dataBytes = plain ? Array.from(plain) : []
		result.plainBytes = result.dataBytes
		result.fields = {
			方向: dir === 'up' ? '↑ 上行(表→平台)' : '↓ 下行(平台→表)',
			设备地址ADDR: hexbytes(addr),
			密钥角色KeyID: { value: keyId, name: ROLE_NAMES[keyId] || '未知' },
			消息计数器MCNT: mcnt,
			明文长度LEN: plainLen,
			CMAC校验: macOk ? '通过' : '失败(密钥角色不匹配 或 数据被篡改/重放)',
		}

		if (plain && plain.length > 0) {
			if (dir === 'down') {
				const cmd = plain[0]
				const payload = plain.subarray(1)
				const cmdDef = CMD_TABLE[cmd]
				// 命令码按十六进制展示: 十进制的 16 与协议里真实存在的 0x16(平台确认周期上报)撞脸, 看日志极易误读
				result.fields['命令CMD'] = { value: hexByte(cmd), name: cmdDef ? cmdDef.name : '未知命令' }
				result.decoded = decodeDownPayload(cmd, payload)
			} else if (plain[0] === 0x20) {
				const rm = decodeReportMeter(plain.subarray(1))
				result.fields['命令CMD'] = { value: hexByte(0x20), name: '周期数据主动上报' }
				result.decoded = rm.ok
					? ('基准时间=' + rm.baseTime + '  采样间隔=' + rm.interval + '分钟  条数(声明)=' + rm.num + '  more=' + rm.more + '\n' + rm.records.join('\n')
						+ (rm.flowRate != null ? ('\n瞬时流量 = ' + rm.flowRate + ' L/h  采样时间 = ' + fmtUnix(rm.sampleTs)) : '')
						+ (rm.tailNote ? ('\n' + rm.tailNote) : ''))
					: ('结构解析失败: ' + rm.lines.join('; '))
			} else {
				const rc = plain[0]
				const payload = plain.subarray(1)
				result.fields['结果码'] = { value: rc, name: RESULT_TABLE[rc] || '未知' }
				result.decoded = decodeUpPayload(payload).join('\n')
			}
		} else if (plain) {
			result.decoded = '(空载荷)'
		}

		result.ok = macOk
		return result
	}

	W.wmbusFormatFrame = function (r) {
		const dirArrow = r.dir === 'up' ? '↑' : r.dir === 'down' ? '↓' : '?'
		const status = (r.macOk ? '✓' : '✗') + ' 🔒'
		let h = '<div class="sk-parse">'
		h += '<div class="sk-parse-bar">' + dirArrow + ' ' + status + '</div>'
		const f = r.fields || {}
		const cells = []
		for (const k in f) {
			const v = f[k]
			let val
			if (v == null) val = ''
			else if (typeof v === 'object' && v.name !== undefined) val = v.value + ' (' + escHtml(v.name) + ')'
			else val = escHtml(String(v))
			cells.push({ name: k, value: val })
		}
		if (cells.length) {
			const COLS = 3
			h += '<table class="sk-parse-grid"><tbody>'
			for (let i = 0; i < cells.length; i += COLS) {
				h += '<tr>'
				for (let j = 0; j < COLS; j++) { const c = cells[i + j]; h += '<td class="sk-parse-hdr">' + (c ? escHtml(c.name) : '') + '</td>' }
				h += '</tr><tr>'
				for (let j = 0; j < COLS; j++) { const c = cells[i + j]; h += '<td>' + (c ? c.value : '') + '</td>' }
				h += '</tr>'
			}
			h += '</tbody></table>'
		}
		if (r.decoded) {
			h += '<div class="sk-parse-tlvs"><details class="sk-parse-tag" open><summary>数据域解析</summary>' +
				'<div class="sk-parse-items"><pre style="white-space:pre-wrap;margin:0;">' + escHtml(r.decoded) + '</pre></div></details></div>'
		}
		if (r.errors && r.errors.length) {
			h += '<div class="sk-parse-errors">'
			for (const e of r.errors) h += '<div>' + escHtml(e) + '</div>'
			h += '</div>'
		}
		h += '</div>'
		return h
	}

	W.wmbusByteMap = function (r) {
		const raw = (r.raw instanceof Uint8Array) ? r.raw : Uint8Array.from(r.raw || [])
		const n = raw.length
		const map = new Array(n).fill('')
		if (r.dir !== 'up' && r.dir !== 'down') return map
		const hx = (b) => '0x' + (b & 0xff).toString(16).toUpperCase().padStart(2, '0')
		const set = (off, len, tip, grp) => { for (let k = 0; k < len; k++) if (off + k < n) map[off + k] = { tip, grp } }
		set(0, 1, 'CI = ' + hx(raw[0]) + (r.dir === 'up' ? ' (上行)' : ' (下行)'), 'ci')
		set(1, 8, '设备地址ADDR = ' + hexbytes(raw.subarray(1, Math.min(9, n))), 'addr')
		set(9, 1, '密钥角色KeyID = ' + raw[9], 'keyid')
		set(10, 4, '消息计数器MCNT', 'mcnt')
		set(14, 1, '明文长度LEN = ' + raw[14], 'len')
		const encLen = (raw[14] + 15) & ~15
		set(15, Math.max(0, Math.min(encLen, n - 15)), '加密区(AES-128-CBC)', 'enc')
		const macOff = 15 + encLen
		if (macOff < n) set(macOff, Math.min(8, n - macOff), 'CMAC(AES-128-CMAC,截8字节) = ' + (r.macOk ? '✓' : '✗'), 'mac')
		return map
	}

	W.wmbusFindFrame = function (bytes, opt) {
		opt = opt || {}
		const b = toBytesAny(bytes)
		const empty = { found: false, offset: 0, length: b.length, frame: b, prefix: 0, suffix: 0 }
		if (b.length < HDR + 16 + MACLEN) return empty
		let firstStruct = null
		for (let i = 0; i + HDR <= b.length; i++) {
			if (b[i] !== CI_DOWN && b[i] !== CI_UP) continue
			const plainLen = b[i + 14]
			if (plainLen === 0) continue
			const encLen = (plainLen + 15) & ~15
			const total = HDR + encLen + MACLEN
			if (i + total > b.length) continue
			const frame = new Uint8Array(b.subarray(i, i + total))
			const cand = { found: true, offset: i, length: total, frame, prefix: i, suffix: b.length - i - total }
			if (!firstStruct) firstStruct = cand
			try {
				const p = W.wmbusParseFrame(frame, opt)
				if (p.macOk) { cand.parse = p; return cand }
			} catch (e) { /* 继续扫描 */ }
		}
		return firstStruct || empty
	}

	// ===== 下行构造 =====
	W.wmbusBuildDownFrame = function (opt) {
		opt = opt || {}
		const addrBytes = toBytesHex(opt.addr || '')
		const addr = new Uint8Array(8)
		addr.set(addrBytes.subarray(0, Math.min(8, addrBytes.length)))
		const keyId = (opt.keyId != null ? opt.keyId : 0) & 0xff
		const mcnt = (opt.mcnt >>> 0) || 1
		const cmd = (typeof opt.cmd === 'string') ? parseInt(opt.cmd, opt.cmd.indexOf('0x') === 0 ? 16 : 10) : opt.cmd
		const payload = toBytesHex(opt.payloadHex || '')
		const plain = new Uint8Array(1 + payload.length)
		plain[0] = cmd & 0xff
		plain.set(payload, 1)
		if (plain.length < 1 || plain.length > 64) throw new Error('明文长度超出下行上限(1-64字节): ' + plain.length)

		const encLen = (plain.length + 15) & ~15
		const padded = new Uint8Array(encLen)
		padded.set(plain)
		const key = resolveRoleKey(opt, keyId)

		const head = new Uint8Array(HDR)
		head[0] = CI_DOWN
		head.set(addr, 1)
		head[9] = keyId
		head[10] = mcnt & 0xff; head[11] = (mcnt >>> 8) & 0xff; head[12] = (mcnt >>> 16) & 0xff; head[13] = (mcnt >>> 24) & 0xff
		head[14] = plain.length

		const iv = ivBuild(addr, mcnt, 0)
		const enc = cbcEncrypt(key, iv, padded)
		const headEnc = new Uint8Array(HDR + encLen)
		headEnc.set(head, 0)
		headEnc.set(enc, HDR)
		const mac = cmac(key, headEnc, MACLEN)
		const out = new Uint8Array(HDR + encLen + MACLEN)
		out.set(headEnc, 0)
		out.set(mac, HDR + encLen)
		return out
	}

	// ===== 协议注册 (common.js 的 window.registerProtocol 挂表, 供协议下拉框选择) =====
	function tryRegister() {
		if (typeof W.registerProtocol !== 'function') { setTimeout(tryRegister, 50); return }
		W.registerProtocol('wmbus', {
			name: 'W-MBUS',
			parseFrame: W.wmbusParseFrame,
			formatFrame: W.wmbusFormatFrame,
			findFrame: W.wmbusFindFrame,
			byteMap: W.wmbusByteMap,
			buildDownFrame: W.wmbusBuildDownFrame,
			presets: [],
		})
		// common.js 在恢复 toolOptions.skProtocol 时可能早于本模块注册执行(见下方脚本加载顺序),
		// 此时下拉框里还没有 wmbus 选项、_activeProtocol 却已被置为 'wmbus'；这里补一次同步。
		const sel = document.getElementById('serial-protocol-select')
		if (sel && W._activeProtocol === 'wmbus' && sel.value !== 'wmbus') sel.value = 'wmbus'
		initDownUi()
	}

	// ===== 下行下发面板 (独立卡片 #wmbus-down-card, 与 SK 的 #sk-down-card 互斥显示) =====
	function initDownUi() {
		const cmdSel = document.getElementById('wmbus-down-cmd')
		if (!cmdSel || cmdSel.dataset.wmbusInit) return
		cmdSel.dataset.wmbusInit = '1'

		const SEND_CMDS = [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87]
		//0x87(立即上报)是写类命令里的权限例外: 只需 PUBLIC 角色即可触发,不是 ADMIN
		//0x84(阀控)不属于该例外, 仍要求 role>=1(操作员/管理员), 公开读不可下发
		//0x12(读当前下行计数器)是读命令里的权限例外: 需要 role>0(操作员/管理员),公开读不可用
		//未列出的其余命令(0x10/0x11/0x13~0x16,纯读)按协议要求最低角色 0(公开读)即可执行
		const MIN_ROLE = { 0x12: 1, 0x84: 1, 0x80: 2, 0x81: 2, 0x82: 2, 0x83: 2, 0x85: 2, 0x86: 2, 0x87: 0 }

		// 收→发间隔(固定): 仅「已收到应答 → 下次发送」, 不插在发送后等应答路上。
		// 实测 0.7s 常丢、约 850ms 较稳。写命令每次先 0x12, 探测应答后 / 无应答重发前走这段。
		const RX_TO_TX_GAP_MS = 850

		const keyIdSel = document.getElementById('wmbus-down-keyid')
		const meterIdEl = document.getElementById('wmbus-down-meterid')
		const mcntEl = document.getElementById('wmbus-down-mcnt')
		const payloadEl = document.getElementById('wmbus-down-payload')
		const paramGroup = document.getElementById('wmbus-down-param-group')
		const paramLabel = document.getElementById('wmbus-down-param-label')
		const paramVal = document.getElementById('wmbus-down-param-val')
		const paramSel = document.getElementById('wmbus-down-param-sel')
		const errEl = document.getElementById('wmbus-down-err')
		const buildBtn = document.getElementById('wmbus-down-build')
		const sendBtn = document.getElementById('wmbus-down-send')
		const keyGroup = document.getElementById('wmbus-down-key-group')
		const keyLabel = document.getElementById('wmbus-down-key-label')
		const keyAsciiEl = document.getElementById('wmbus-down-key-ascii')
		const keyHexEl = document.getElementById('wmbus-down-key-hex')
		const ipGroup = document.getElementById('wmbus-down-ip-group')
		const ipTypeSel = document.getElementById('wmbus-down-ip-type')
		const ipAddrLabel = document.getElementById('wmbus-down-ip-addr-label')
		const ipAddrEl = document.getElementById('wmbus-down-ip-addr')
		const ipPortEl = document.getElementById('wmbus-down-ip-port')

		meterIdEl.value = localStorage.getItem('wmbusDownMeterId') || ''
		mcntEl.value = localStorage.getItem('wmbusDownMcnt') || '1'

		// 密钥角色0(公开读)固定用内置默认密钥,不展示密钥框;1/2 展示对应角色已保存的 ASCII/HEX 密钥
		function updateKeyUi() {
			const role = parseInt(keyIdSel.value, 10)
			if (role === 0) { keyGroup.style.display = 'none'; return }
			keyGroup.style.display = ''
			keyLabel.textContent = '密钥·' + (ROLE_NAMES[role] || role)
			const store = loadRoleKeyStore(role)
			keyAsciiEl.value = store.ascii || ''
			keyHexEl.value = store.hex || ''
		}
		function saveKeyUi() {
			const role = parseInt(keyIdSel.value, 10)
			if (role === 0) return
			saveRoleKeyStore(role, { ascii: keyAsciiEl.value, hex: keyHexEl.value })
		}
		// 命令下拉框只展示当前选中角色能执行的命令(角色越高可执行的命令越多,ADMIN 可执行全部)
		function refreshCmdOptions() {
			const role = parseInt(keyIdSel.value, 10)
			const prevCmd = cmdSel.value
			cmdSel.innerHTML = ''
			for (const c of SEND_CMDS) {
				const minRole = MIN_ROLE[c] != null ? MIN_ROLE[c] : 0
				if (minRole > role) continue
				const opt = document.createElement('option')
				opt.value = '0x' + c.toString(16).toUpperCase().padStart(2, '0')
				opt.textContent = opt.value + ' ' + CMD_TABLE[c].name
				cmdSel.appendChild(opt)
			}
			if (prevCmd && Array.from(cmdSel.options).some((o) => o.value === prevCmd)) cmdSel.value = prevCmd
		}

		keyIdSel.addEventListener('change', () => { updateKeyUi(); refreshCmdOptions(); onCmdChange() })
		keyAsciiEl.addEventListener('input', saveKeyUi)
		keyHexEl.addEventListener('input', saveKeyUi)
		updateKeyUi()
		refreshCmdOptions()

		function showErr(msg) { if (errEl) errEl.textContent = msg || '' }

		function fillEnumOptions(map, def) {
			paramSel.innerHTML = ''
			for (const k in map) {
				const o = document.createElement('option')
				o.value = k
				o.textContent = k + ':' + map[k]
				if (String(k) === String(def)) o.selected = true
				paramSel.appendChild(o)
			}
		}

		function onCmdChange() {
			const cmd = parseInt(cmdSel.value, 16)
			paramVal.style.display = 'none'
			paramSel.style.display = 'none'
			paramGroup.style.display = ''
			ipGroup.style.display = 'none'
			paramVal.placeholder = '值' // 各分支按需覆盖, 切换命令时先还原成通用占位符
			switch (cmd) {
				case 0x16:
					paramLabel.textContent = 'dayTs(unix秒)'
					paramVal.style.display = ''
					// 设备的时间戳是「本地墙钟当 UTC」, 下发 dayTs 要用同一口径, 否则与设备自己的钟差一个时区
					paramVal.value = String(deviceEpochNow())
					break
				case 0x80:
					paramLabel.textContent = '表号(纯数字BCD,10B)'
					paramVal.style.display = ''
					paramVal.value = ''
					break
				case 0x81:
					paramLabel.textContent = '底度(0~' + DEGREE_MAX.toString() + ')'
					paramVal.style.display = ''
					paramVal.placeholder = '0 ~ ' + DEGREE_MAX.toString()
					paramVal.value = '0'
					break
				case 0x82:
					paramLabel.textContent = '基表号(纯数字BCD,10B)'
					paramVal.style.display = ''
					paramVal.value = ''
					break
				case 0x83:
					paramLabel.textContent = '角色+密钥HEX(16B)'
					paramSel.style.display = ''
					paramVal.style.display = ''
					fillEnumOptions(ROLE_NAMES, '1')
					paramVal.placeholder = '32位HEX密钥'
					paramVal.value = ''
					break
				case 0x84:
					paramLabel.textContent = '阀门子命令'
					paramSel.style.display = ''
					fillEnumOptions(VALVE_CMD_NAMES, '1')
					break
				case 0x85:
					paramGroup.style.display = 'none'
					ipGroup.style.display = 'flex'
					onIpTypeChange()
					break
				case 0x86:
					paramLabel.textContent = 'APN(1-32字节ASCII,不补零)'
					paramVal.style.display = ''
					paramVal.placeholder = 'APN'
					paramVal.value = ''
					break
				default:
					paramGroup.style.display = 'none'
			}
			computePayload()
		}

		// IPv4: 点分十进制4字节, 原始字节序(不反转)。IPv6: 8组16bit, 每组按 LE 存2字节(与固件约定一致,非常规网络字节序)。
		function ipv4ToBytes(s) {
			const parts = String(s || '').trim().split('.')
			if (parts.length !== 4) throw new Error('IPv4 格式错误,需 a.b.c.d')
			return parts.map((p) => {
				if (!/^\d{1,3}$/.test(p)) throw new Error('IPv4 格式错误: ' + p)
				const n = parseInt(p, 10)
				if (n < 0 || n > 255) throw new Error('IPv4 段超出范围: ' + p)
				return n
			})
		}
		function ipv6ToBytesLE(s) {
			const str = String(s || '').trim()
			if (!str) throw new Error('IPv6 地址不能为空')
			const dc = str.split('::')
			if (dc.length > 2) throw new Error('IPv6 格式错误')
			const parseGroups = (x) => (x ? x.split(':').filter((g) => g.length) : [])
			const head = parseGroups(dc[0])
			let groups
			if (dc.length === 1) {
				groups = head
				if (groups.length !== 8) throw new Error('IPv6 需完整8组,或用 :: 省略连续0段')
			} else {
				const tail = parseGroups(dc[1])
				const missing = 8 - head.length - tail.length
				if (missing < 0) throw new Error('IPv6 格式错误')
				groups = head.concat(new Array(missing).fill('0')).concat(tail)
			}
			const out = []
			for (const g of groups) {
				const v = parseInt(g, 16)
				if (isNaN(v) || v < 0 || v > 0xffff) throw new Error('IPv6 分组非法: ' + g)
				out.push(v & 0xff, (v >> 8) & 0xff)
			}
			return out
		}
		function asciiBytesStrict(s, min, max, label) {
			const bytes = typeof TextEncoder !== 'undefined'
				? Array.from(new TextEncoder().encode(s || ''))
				: Array.from(String(s || '')).map((c) => c.charCodeAt(0) & 0xff)
			if (bytes.length < min || bytes.length > max) throw new Error(label + '长度需 ' + min + '-' + max + ' 字节,当前' + bytes.length)
			return bytes
		}
		function onIpTypeChange() {
			const type = parseInt(ipTypeSel.value, 10)
			if (type === 0) { ipAddrLabel.textContent = '地址(IPv4)'; ipAddrEl.placeholder = '如 192.168.1.1' }
			else if (type === 1) { ipAddrLabel.textContent = '地址(IPv6)'; ipAddrEl.placeholder = '如 fe80::1' }
			else { ipAddrLabel.textContent = 'URL'; ipAddrEl.placeholder = '域名或URL,1-58字节ASCII' }
			computePayload()
		}

		// 最近一次参数编码是否失败(null=正常), 供 buildFrame 拦截非法参数的下发
		let payloadErr = null
		function computePayload() {
			const cmd = parseInt(cmdSel.value, 16)
			let bytes = []
			try {
				switch (cmd) {
					case 0x16:
						bytes = u32leBytes(parseInt(paramVal.value || '0', 10))
						break
					case 0x80:
					case 0x82:
						bytes = bcdBytesLE(paramVal.value || '', 10)
						break
					case 0x81: {
						// 底度是无符号 64 位(固件 samplingDegreeSet(uint64_t)), 负数/小数/空值一律拒绝 ——
						// 之前负数会被 u64leBytes 静默钳成 0, 等于把底度清零, 属于危险的静默行为
						const raw = String(paramVal.value == null ? '' : paramVal.value).trim()
						if (!/^\d+$/.test(raw)) throw new Error('底度需为非负整数(不接受负数/小数/空值)')
						const deg = BigInt(raw)
						// 上限取 10 个 9(约定值, 比 uint64 与 LCD 8位整数位都严): 表位数放不下更大的数
						// (10个9 < 2^47, 260803 起 0x10 抄表的 48 位字段可原样回读)
						if (deg > DEGREE_MAX) throw new Error('底度最大 ' + DEGREE_MAX.toString() + ',当前 ' + raw)
						bytes = u64leBytes(deg)
						break
					}
					case 0x83: {
						const role = parseInt(paramSel.value || '0', 10)
						const keyBytes = toBytesHex((paramVal.value || '').padEnd(32, '0').slice(0, 32))
						bytes = [role, ...Array.from(keyBytes.subarray(0, 16))]
						break
					}
					case 0x84:
						bytes = [parseInt(paramSel.value || '0', 10)]
						break
					case 0x85: {
						const type = parseInt(ipTypeSel.value, 10)
						const port = u32leBytes(parseInt(ipPortEl.value || '0', 10))
						if (type === 0) bytes = [type, ...ipv4ToBytes(ipAddrEl.value), ...port]
						else if (type === 1) bytes = [type, ...ipv6ToBytesLE(ipAddrEl.value), ...port]
						else bytes = [type, ...port, ...asciiBytesStrict(ipAddrEl.value, 1, 58, 'URL')]
						break
					}
					case 0x86:
						bytes = asciiBytesStrict(paramVal.value, 1, 32, 'APN')
						break
					default:
						bytes = []
				}
				payloadErr = null
				showErr('')
			} catch (e) {
				bytes = []
				// 记下参数错误, 由 buildFrame 拦住下发: 否则载荷被清空后照样能发出去 ——
				// 例如写底度(0x81)的空载荷会让固件按 valLen=0 解出 degree=0, 等于静默把底度清零
				payloadErr = e.message
				showErr(e.message)
			}
			payloadEl.value = bytes.map((b) => ((b & 0xff) < 16 ? '0' : '') + (b & 0xff).toString(16).toUpperCase()).join(' ')
		}

		cmdSel.addEventListener('change', onCmdChange)
		paramVal.addEventListener('input', computePayload)
		paramSel.addEventListener('change', computePayload)
		ipTypeSel.addEventListener('change', onIpTypeChange)
		ipAddrEl.addEventListener('input', computePayload)
		ipPortEl.addEventListener('input', computePayload)
		onCmdChange()

		// ADDR = 厂商码(2 LE,固定) || 表号后8位BCD(4) || 版本(1,固定) || 类型(1,固定), 与固件 wmbus_ids.h 一致
		function computeAddrHex() {
			const meterId = (meterIdEl.value || '').trim()
			if (!/^\d{1,8}$/.test(meterId)) throw new Error('表号后8位需为1-8位数字')
			const addrBytes = new Uint8Array(8)
			addrBytes.set(ADDR_MANUF_LE, 0)
			addrBytes.set(bcdBytesBE(meterId, 4), 2)
			addrBytes[6] = ADDR_VERSION
			addrBytes[7] = ADDR_DEVICE_TYPE
			return hexbytes(addrBytes)
		}

		function buildFrame() {
			showErr('')
			if (payloadErr) { showErr(payloadErr); return null }
			let addr
			try { addr = computeAddrHex() } catch (e) { showErr(e.message); return null }
			const mcnt = parseInt(mcntEl.value, 10)
			if (!mcnt || mcnt < 1) { showErr('计数器MCNT需为正整数,且需大于设备当前已接受值'); return null }
			try {
				// 密钥按 keyId 对应角色, 从上方「密钥」框读取(角色0固定内置默认密钥, 操作员/管理员未输入时回落全0, 见 resolveRoleKey)
				const frame = W.wmbusBuildDownFrame({
					addr,
					keyId: parseInt(keyIdSel.value, 10),
					mcnt,
					cmd: cmdSel.value,
					payloadHex: payloadEl.value,
				})
				localStorage.setItem('wmbusDownMeterId', (meterIdEl.value || '').trim())
				mcntEl.value = String(mcnt + 1)
				localStorage.setItem('wmbusDownMcnt', String(mcnt + 1))
				return frame
			} catch (e) {
				showErr('生成失败: ' + e.message)
				return null
			}
		}

		function sendFrame(frame) {
			const preview = document.getElementById('serial-protocol-down-preview')
			if (preview) preview.value = hexBytesSpaced(frame)
			const sendEl = document.getElementById('serial-protocol-send')
			if (sendEl) sendEl.click()
		}

		buildBtn.addEventListener('click', () => {
			const frame = buildFrame()
			if (!frame) return
			const preview = document.getElementById('serial-protocol-down-preview')
			if (preview) preview.value = hexBytesSpaced(frame)
		})

		// 写类命令(0x80~0x86)现在仍要求 MCNT > 设备 last_mc, 但 0x10~0x15(读)已不再校验新鲜度(见文件头注释)。
		// 于是"下发"写命令前可以先用 0x12(读当前下行计数器)探测 last_mc, 再用 last_mc+1 重新构造并签名
		// 真正要发的帧, 免去用户手动猜/管理 MCNT。
		// 探测帧的 MCNT 由 wmbus-transaction.js 内部固定取一个足够大的值, 不依赖这里的 mcntEl.value ——
		// 本地跟踪的计数器一旦与设备 last_mc 不同步就会导致探测本身被当重放丢弃、死锁(见该文件注释),
		// 固定大值可保证任何情况下都能探测成功。
		// 0x87(立即上报)不校验 MCNT 新鲜度(与纯读命令一样), 无需探测计数器, 可直接下发。
		const AUTO_PROBE_CMDS = { 0x80: 1, 0x81: 1, 0x82: 1, 0x83: 1, 0x84: 1, 0x85: 1, 0x86: 1 }
		// 收到探测应答后紧接着就发写命令, 红外半双工还没切回接收, 写命令会被吞。
		// 收→发间隔只卡在 收→发 之间(整帧已由 findFrame 收齐后再计时), 不插在 发→等应答 路上。
		// 无应答则原样重发(MCNT 不变; 设备没收到不算重放, 已执行会回结果码2, 不重复写)。
		const WRITE_ACK_TIMEOUT_MS = 5000
		const WRITE_MAX_ATTEMPTS = 3
		const PROBE_MAX_ATTEMPTS = 3
		const SEND_IDLE_LABEL = '立即下发'
		const CANCEL_MSG = '用户取消'

		// 写命令探测/重试进行中: 再次点击「立即下发」即取消(不 disabled, 可点)
		let sendBusy = false
		let sendJob = null
		function makeSendJob() {
			const job = { cancelled: false, sleepTimer: null }
			job.cancel = function () {
				if (job.cancelled) return
				job.cancelled = true
				if (job.sleepTimer != null) {
					clearTimeout(job.sleepTimer)
					job.sleepTimer = null
				}
				if (window.wmbusTx) {
					try { window.wmbusTx.cancelAll(CANCEL_MSG) } catch (e) { /* */ }
				}
			}
			job.throwIfCancelled = function () {
				if (job.cancelled) throw new Error(CANCEL_MSG)
			}
			job.isCancelErr = function (e) {
				return job.cancelled || (e && String(e.message || e) === CANCEL_MSG)
			}
			// 可被 cancel 打断的 sleep(收→发间隔)
			job.sleep = function (ms) {
				return new Promise(function (resolve, reject) {
					if (job.cancelled) { reject(new Error(CANCEL_MSG)); return }
					job.sleepTimer = setTimeout(function () {
						job.sleepTimer = null
						if (job.cancelled) reject(new Error(CANCEL_MSG))
						else resolve()
					}, ms)
				})
			}
			job.waitRxToTxGap = function () { return job.sleep(RX_TO_TX_GAP_MS) }
			return job
		}

		// 写命令每次都先 0x12 探测 last_mc, 再用 last_mc+1 构造下发。
		// 不缓存免探测: 分支目标是修「探测后立刻写被吞」, 不是取消查询序列; 探测帧本身也是联调可见的下行。
		// 红外半双工衔接不稳时, 靠「固定收→发间隔 + 无应答原样重发」兜底, 不靠跳过探测绕开。
		sendBtn.addEventListener('click', async () => {
			// 进行中再次点击 = 取消当前探测/等待/重试
			if (sendBusy) {
				if (sendJob) sendJob.cancel()
				return
			}
			const cmd = parseInt(cmdSel.value, 16)
			if (!AUTO_PROBE_CMDS[cmd]) {
				const frame = buildFrame()
				if (!frame) return
				sendFrame(frame)
				return
			}
			if (!window.wmbusTx) { showErr('wmbus-transaction 模块未加载,无法自动探测计数器'); return }
			if (!window.serialApi || !window.serialApi.isOpen()) { showErr('请先打开串口'); return }
			let addrHex
			try { addrHex = computeAddrHex() } catch (e) { showErr(e.message); return }

			const job = makeSendJob()
			sendJob = job
			sendBusy = true
			sendBtn.textContent = '探测计数器中...(点此取消)'
			showErr('')
			try {
				const keyId = parseInt(keyIdSel.value, 10)
				// 发一次写命令并等应答, 无应答就原样重发; 返回结果码, 全程无应答返回 null
				// 首次: 探测应答后先 RX→TX 间隔再发; 重试: 超时后同样隔一段再发(给红外端恢复)
				// 发出后立刻 waitFor, 不在 发→收 路径上额外 sleep
				async function sendWriteAndWaitAck(frame, usedMcnt) {
					// 应答匹配: 同地址同角色、MCNT 与本次下发的一致; db[0]=0x20 是周期上报帧, 不是本次要等的应答
					const matchAck = function (f) {
						const kid = f.fields && f.fields['密钥角色KeyID']
						if ((f.fields && f.fields['设备地址ADDR']) !== addrHex) return false
						if ((kid && typeof kid === 'object' ? kid.value : kid) !== keyId) return false
						if ((f.fields && f.fields['消息计数器MCNT']) !== usedMcnt) return false
						const db = f.dataBytes || []
						return db.length > 0 && db[0] !== 0x20
					}
					for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt++) {
						job.throwIfCancelled()
						sendBtn.textContent = (attempt === 1
							? ('等待红外就绪(' + RX_TO_TX_GAP_MS + 'ms)')
							: ('无应答,重发第' + (attempt - 1) + '次')) + '...(点此取消)'
						await job.waitRxToTxGap()
						job.throwIfCancelled()
						// 先挂等待再发, 避免应答比 waitFor 注册更快到达
						const ack = window.wmbusTx.waitFor(matchAck, WRITE_ACK_TIMEOUT_MS)
						sendBtn.textContent = '已下发,等应答...(点此取消)'
						sendFrame(frame)
						try {
							const res = await ack
							job.throwIfCancelled()
							const db = (res.frame && res.frame.dataBytes) || []
							return db.length ? db[0] : 0
						} catch (e) {
							if (job.isCancelErr(e)) throw e
							// 超时: 红外端多半没收到, 原样重发
						}
					}
					return null
				}
				// 探测帧本身也会被红外端吞掉(实测有一次 0x12 发出去毫无回应), 同样重发
				async function probe() {
					for (let attempt = 1; ; attempt++) {
						job.throwIfCancelled()
						sendBtn.textContent = (attempt === 1 ? '探测计数器中' : ('探测无应答,重试第' + (attempt - 1) + '次')) + '...(点此取消)'
						try {
							return await window.wmbusTx.probeCounter({ addr: addrHex, keyId: keyId })
						} catch (e) {
							if (job.isCancelErr(e)) throw e
							if (attempt >= PROBE_MAX_ATTEMPTS) throw e
							// 无应答重探: 同样只卡在「下一发」前, 不拖 发→等收
							await job.waitRxToTxGap()
						}
					}
				}

				const lastMc = await probe()
				job.throwIfCancelled()
				const usedMcnt = (lastMc + 1) >>> 0
				mcntEl.value = String(usedMcnt)
				const frame = buildFrame()
				if (!frame) return
				const rc = await sendWriteAndWaitAck(frame, usedMcnt)
				job.throwIfCancelled()
				if (rc == null) {
					showErr('已下发' + WRITE_MAX_ATTEMPTS + '次仍无应答,请检查红外探头对位/设备是否在线')
				} else if (rc !== 0) {
					const table = W.wmbusResultTable || {}
					showErr('设备应答结果码=' + rc + (table[rc] ? '(' + table[rc] + ')' : ''))
				}
			} catch (e) {
				if (job.isCancelErr(e)) {
					showErr('已取消发送')
				} else {
					showErr('自动探测计数器失败,已中止下发(未发送写命令): ' + e.message)
				}
			} finally {
				if (sendJob === job) {
					sendJob = null
					sendBusy = false
					sendBtn.textContent = SEND_IDLE_LABEL
				}
			}
		})

		// 与 SK/工装卡片互斥: 仅当前协议为 wmbus 时显示本卡片; SEK 卡片仅 sek 显示
		function applyVisibility() {
			const sel = document.getElementById('serial-protocol-select')
			const v = sel ? sel.value : 'sek'
			const isWmbus = v === 'wmbus'
			const isSek = v === 'sek'
			const sekOnly = ['sk-down-card', 'sk-rw-card', 'sk-batch-card', 'serial-protocol-advanced']
			for (const id of sekOnly) { const el = document.getElementById(id); if (el) el.style.display = isSek ? '' : 'none' }
			const wm = document.getElementById('wmbus-down-card')
			if (wm) wm.style.display = isWmbus ? '' : 'none'
		}
		const protoSel = document.getElementById('serial-protocol-select')
		if (protoSel) protoSel.addEventListener('change', applyVisibility)
		applyVisibility()
	}

	tryRegister()
})()
