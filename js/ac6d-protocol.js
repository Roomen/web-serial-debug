// AC6D 容积式电子水表协议引擎（LPUART0 V2.7/V2.8 + 旧固件 48B/24B 双向自适应 + A99A 透传/模组信息 + 校准算法）
// 浏览器暴露 window.Ac6dProtocol 并自动向 ProtocolRegistry 注册内置协议 'ac6d-meter'；
// CommonJS / Node 环境导出 Ac6dProtocol 供单元测试直接加载。
;(function (root) {
	'use strict'

	const PROTOCOL_ID = 'ac6d-meter'
	const FRAME_HEAD_H = 0xac
	const FRAME_HEAD_L = 0x6d
	const MAX_FRAME_SIZE = 530
	const MAX_PACKET_SIZE = MAX_FRAME_SIZE - 8

	const OTA_APP2_ADDR = 0x8000
	const OTA_APP2_SIZE = 0x6000
	const OTA_HEADER_SIZE = 16
	const OTA_HEADER_MAGIC = 0x5a5aa5a5
	const OTA_PRODUCT_ID = '9091'

	const IOT_HEAD_H = 0xa9
	const IOT_HEAD_L = 0x9a
	const IOT_TAIL = 0x16
	const IOT_PROTO_VER = 0x02
	const IOT_FUNC_INFO_REQ = 0x03
	const IOT_FUNC_INFO_RSP = 0x83
	const IOT_FUNC_PASS_REQ = 0x04
	const IOT_FUNC_PASS_RSP = 0x84
	const IOT_TAG_PASSTHROUGH = 0x07
	const IOT_TAG_INFO_QUERY = 0x0a

	const CMD = {
		HANDSHAKE: 0x20,
		OTA_DATA: 0x22,
		OTA_ERASE: 0x24,
		OTA_CRC: 0x25,
		OTA_FINISH: 0x26,
		FLOW_FAST: 0x30,
		FLOW_QUERY: 0x31,
		ALARM_CLEAR: 0x32,
		DEV_INFO: 0x33,
		TIME_SYNC: 0x34,
		MODE_SET: 0x35,
		AUTH_BYPASS: 0x36,
		DAILY_FREEZE: 0x37,
		INIT_REPORT: 0x3f,
		CALIB_READ: 0x40,
		CALIB_WRITE: 0x41,
		PARAM_READ: 0x42,
		PARAM_WRITE: 0x43,
		LOG_READ: 0x44,
		RESET: 0x45,
		PARAM_RESET: 0x46,
		BASE_DEGREE: 0x47,
	}

	const REQ_TYPE = {
		CONTROL: 0x11,
		DATA: 0x12,
	}

	const STATUS = {
		OK: 0x00,
		ERROR: 0x01,
		TIMEOUT: 0x03,
		ADDR_ERROR: 0x04,
		FLASH_SIZE_ERROR: 0x05,
		CRC_ERROR: 0x06,
		INVALID_CMD: 0x07,
		ALREADY_MODE: 0x08,
	}

	const STATUS_TEXT = {
		0x00: '成功',
		0x01: '错误/参数非法',
		0x03: 'Flash 擦写超时',
		0x04: '地址越界/认证失败',
		0x05: '数据大小越界',
		0x06: 'CRC 校验错误',
		0x07: '非法命令码',
		0x08: '已在目标运行模式',
	}

	const CMD_INFO = {
		0x20: { name: 'HANDSHAKE', label: '握手', needsAuth: false },
		0x22: { name: 'OTA_DATA', label: 'OTA 数据下载', needsAuth: false },
		0x24: { name: 'OTA_ERASE', label: 'OTA 擦除扇区', needsAuth: false },
		0x25: { name: 'OTA_CRC', label: 'OTA CRC 校验', needsAuth: false },
		0x26: { name: 'OTA_FINISH', label: 'OTA 完成', needsAuth: false },
		0x30: { name: 'FLOW_FAST', label: '流量快速查询', needsAuth: false },
		0x31: { name: 'FLOW_QUERY', label: '流量完整查询', needsAuth: false },
		0x32: { name: 'ALARM_CLEAR', label: '清除报警标志', needsAuth: true },
		0x33: { name: 'DEV_INFO', label: '设备信息查询', needsAuth: false },
		0x34: { name: 'TIME_SYNC', label: 'RTC 时间同步', needsAuth: false },
		0x35: { name: 'MODE_SET', label: '运行模式切换', needsAuth: false },
		0x36: { name: 'AUTH_BYPASS', label: '认证旁路设置', needsAuth: false },
		0x37: { name: 'DAILY_FREEZE', label: '日冻结分页读取', needsAuth: false },
		0x3f: { name: 'INIT_REPORT', label: '初始化上报', needsAuth: false },
		0x40: { name: 'CALIB_READ', label: '读取校准表', needsAuth: false },
		0x41: { name: 'CALIB_WRITE', label: '写入校准表', needsAuth: true },
		0x42: { name: 'PARAM_READ', label: '读取参数', needsAuth: false },
		0x43: { name: 'PARAM_WRITE', label: '写入参数', needsAuth: true },
		0x44: { name: 'LOG_READ', label: '读取日志', needsAuth: true },
		0x45: { name: 'RESET', label: '系统复位', needsAuth: true },
		0x46: { name: 'PARAM_RESET', label: '恢复出厂', needsAuth: true },
		0x47: { name: 'BASE_DEGREE', label: '设置底度', needsAuth: true },
	}

	const DATA_TYPE_CMDS = new Set([
		CMD.OTA_DATA,
		CMD.TIME_SYNC,
		CMD.CALIB_WRITE,
		CMD.PARAM_WRITE,
		CMD.BASE_DEGREE,
	])

	const MODE_TEXT = {
		0: '休眠',
		1: '快速响应',
		2: '校表',
	}

	const ALARM_BITS = [
		[0x01, '低电压'],
		[0x02, '磁干扰'],
		[0x04, '晶振失效'],
		[0x08, 'Flash失败'],
	]

	const LOG_TYPE_TEXT = {
		0: '系统',
		1: '复位',
		2: '升级',
		3: '报警',
		0xff: '全部',
	}

	const SYS_LOG_SUB_TEXT = {
		0x01: '参数CRC失败',
		0x02: '校准表RAM CRC失败(Flash自动恢复)/参数写入失败',
		0x03: '校准表Flash双备份失败/XTL起振失败',
		0x04: '基础参数RAM CRC失败(Flash自动恢复)',
		0x05: '基础参数Flash双备份失败→复位',
	}

	const PARAM_RESET_LEVEL_TEXT = {
		1: 'INIT_DATA (计量+基础参数)',
		2: 'INIT_PARAMS (报警参数)',
		3: 'INIT_ALL (全部出厂)',
	}

	// CRC16-CCITT (0x1021, init 0xFFFF, refin=false, refout=false, xorout=0x0000)
	const CRC16_TABLE = new Uint16Array([
		0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
		0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef,
		0x1231, 0x0210, 0x3273, 0x2252, 0x52b5, 0x4294, 0x72f7, 0x62d6,
		0x9339, 0x8318, 0xb37b, 0xa35a, 0xd3bd, 0xc39c, 0xf3ff, 0xe3de,
		0x2462, 0x3443, 0x0420, 0x1401, 0x64e6, 0x74c7, 0x44a4, 0x5485,
		0xa56a, 0xb54b, 0x8528, 0x9509, 0xe5ee, 0xf5cf, 0xc5ac, 0xd58d,
		0x3653, 0x2672, 0x1611, 0x0630, 0x76d7, 0x66f6, 0x5695, 0x46b4,
		0xb75b, 0xa77a, 0x9719, 0x8738, 0xf7df, 0xe7fe, 0xd79d, 0xc7bc,
		0x48c4, 0x58e5, 0x6886, 0x78a7, 0x0840, 0x1861, 0x2802, 0x3823,
		0xc9cc, 0xd9ed, 0xe98e, 0xf9af, 0x8948, 0x9969, 0xa90a, 0xb92b,
		0x5af5, 0x4ad4, 0x7ab7, 0x6a96, 0x1a71, 0x0a50, 0x3a33, 0x2a12,
		0xdbfd, 0xcbdc, 0xfbbf, 0xeb9e, 0x9b79, 0x8b58, 0xbb3b, 0xab1a,
		0x6ca6, 0x7c87, 0x4ce4, 0x5cc5, 0x2c22, 0x3c03, 0x0c60, 0x1c41,
		0xedae, 0xfd8f, 0xcdec, 0xddcd, 0xad2a, 0xbd0b, 0x8d68, 0x9d49,
		0x7e97, 0x6eb6, 0x5ed5, 0x4ef4, 0x3e13, 0x2e32, 0x1e51, 0x0e70,
		0xff9f, 0xefbe, 0xdfdd, 0xcffc, 0xbf1b, 0xaf3a, 0x9f59, 0x8f78,
		0x9188, 0x81a9, 0xb1ca, 0xa1eb, 0xd10c, 0xc12d, 0xf14e, 0xe16f,
		0x1080, 0x00a1, 0x30c2, 0x20e3, 0x5004, 0x4025, 0x7046, 0x6067,
		0x83b9, 0x9398, 0xa3fb, 0xb3da, 0xc33d, 0xd31c, 0xe37f, 0xf35e,
		0x02b1, 0x1290, 0x22f3, 0x32d2, 0x4235, 0x5214, 0x6277, 0x7256,
		0xb5ea, 0xa5cb, 0x95a8, 0x8589, 0xf56e, 0xe54f, 0xd52c, 0xc50d,
		0x34e2, 0x24c3, 0x14a0, 0x0481, 0x7466, 0x6447, 0x5424, 0x4405,
		0xa7db, 0xb7fa, 0x8799, 0x97b8, 0xe75f, 0xf77e, 0xc71d, 0xd73c,
		0x26d3, 0x36f2, 0x0691, 0x16b0, 0x6657, 0x7676, 0x4615, 0x5634,
		0xd94c, 0xc96d, 0xf90e, 0xe92f, 0x99c8, 0x89e9, 0xb98a, 0xa9ab,
		0x5844, 0x4865, 0x7806, 0x6827, 0x18c0, 0x08e1, 0x3882, 0x28a3,
		0xcb7d, 0xdb5c, 0xeb3f, 0xfb1e, 0x8bf9, 0x9bd8, 0xabbb, 0xbb9a,
		0x4a75, 0x5a54, 0x6a37, 0x7a16, 0x0af1, 0x1ad0, 0x2ab3, 0x3a92,
		0xfd2e, 0xed0f, 0xdd6c, 0xcd4d, 0xbdaa, 0xad8b, 0x9de8, 0x8dc9,
		0x7c26, 0x6c07, 0x5c64, 0x4c45, 0x3ca2, 0x2c83, 0x1ce0, 0x0cc1,
		0xef1f, 0xff3e, 0xcf5d, 0xdf7c, 0xaf9b, 0xbfba, 0x8fd9, 0x9ff8,
		0x6e17, 0x7e36, 0x4e55, 0x5e74, 0x2e93, 0x3eb2, 0x0ed1, 0x1ef0,
	])

	// 三锚点比例推算表（与参考上位机一致：fwd/rev 各 Q3/Q2/Q1 三组，锚点比例 1.0）
	const ANCHOR_RATIOS = {
		fwd: {
			Q3: {
				'5.125': 1.18627,
				'3.125': 1.068293,
				'2.5': 1.0,
				'1.759': 0.866279,
				'0.881': 0.466321,
				'0.05': -0.587719,
				'0.04': -0.409756,
				'0.031': -0.127193,
			},
			Q2: {
				'0.025': 0.053640,
				'0.016': 0.291793,
				'0.013': 0.459921,
				'0.01': 0.729701,
				'0.008': 1.0,
				'0.006': 1.448718,
			},
			Q1: {
				'0.005': 1.0,
				'0.004': 1.308235,
				'0.003': 1.844093,
				'0.002': 2.4330025,
			},
		},
		rev: {
			Q3: {
				'5.125': 1.52486,
				'3.125': 1.126852,
				'2.5': 1.0,
				'1.759': 0.850620,
				'0.881': 0.464002,
				'0.05': -0.402006,
				'0.04': -0.311988,
				'0.031': -0.162193,
			},
			Q2: {
				'0.025': 0.022171,
				'0.016': 0.266381,
				'0.013': 0.435608,
				'0.01': 0.725101,
				'0.008': 1.0,
				'0.006': 1.481685,
			},
			Q1: {
				'0.005': 1.0,
				'0.004': 1.318274,
				'0.003': 1.818428,
				'0.002': 2.4012698,
			},
		},
	}

	const TAG1_FIELD_LENGTH = {
		0x00: 15, // IMEI
		0x01: 15, // IMSI
		0x02: 20, // ICCID
		0x03: 10, // 用户表号
		0x04: 7,  // 设备唯一编码
		0x05: 16, // 固件版本信息
		0x06: 7,  // 终端实时时间
		0x07: 8,  // 超声波水表主机版本
		0x08: 8,  // 摄像表主机版本
		0x09: 10, // 基表号
		0x0a: 32, // NB模组固件版本号
		0x0b: 6,  // 蓝牙表MAC地址
		0x0c: 16, // 备用模组版本字段
	}

	let _ac6dSeq = 0
	let _iotSeq = 0

	function nextAc6dSeq() {
		_ac6dSeq = (_ac6dSeq % 255) + 1
		return _ac6dSeq
	}

	function nextIotSeq() {
		_iotSeq = (_iotSeq % 65535) + 1
		return _iotSeq
	}

	// ===== 字节与数值辅助 =====
	function toU8(v) {
		if (v instanceof Uint8Array) return v
		if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
		if (v instanceof ArrayBuffer) return new Uint8Array(v)
		if (Array.isArray(v)) return Uint8Array.from(v)
		return new Uint8Array(0)
	}

	function concatBytes(parts) {
		let total = 0
		const list = parts.map(toU8)
		for (let i = 0; i < list.length; i++) total += list[i].length
		const out = new Uint8Array(total)
		let off = 0
		for (let i = 0; i < list.length; i++) {
			out.set(list[i], off)
			off += list[i].length
		}
		return out
	}

	function h2(b) {
		return ((b & 0xff) < 16 ? '0' : '') + (b & 0xff).toString(16).toUpperCase()
	}

	function hex4(v) {
		return (v & 0xffff).toString(16).toUpperCase().padStart(4, '0')
	}

	function hex8(v) {
		return ((v >>> 0) & 0xffffffff).toString(16).toUpperCase().padStart(8, '0')
	}

	function bytesToHex(bytes, spaced) {
		const b = toU8(bytes)
		const out = new Array(b.length)
		for (let i = 0; i < b.length; i++) out[i] = h2(b[i])
		return spaced ? out.join(' ') : out.join('')
	}

	function hexToBytes(hexStr) {
		if (hexStr == null || hexStr === '') return new Uint8Array(0)
		if (hexStr instanceof Uint8Array) return hexStr.slice()
		if (Array.isArray(hexStr)) return Uint8Array.from(hexStr)
		const clean = String(hexStr).replace(/0x/gi, '').replace(/[\s:,_-]/g, '')
		if (!clean) return new Uint8Array(0)
		if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null
		const out = new Uint8Array(clean.length / 2)
		for (let i = 0; i < out.length; i++) {
			out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
		}
		return out
	}

	function reverseBytes(bytes) {
		const b = toU8(bytes)
		const out = new Uint8Array(b.length)
		for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i]
		return out
	}

	function i8(b, o) {
		const v = b[o] & 0xff
		return v >= 0x80 ? v - 0x100 : v
	}

	function u16le(b, o) {
		return (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8)
	}

	function i16le(b, o) {
		const v = u16le(b, o)
		return v >= 0x8000 ? v - 0x10000 : v
	}

	function u32le(b, o) {
		return (
			(b[o] & 0xff) |
			((b[o + 1] & 0xff) << 8) |
			((b[o + 2] & 0xff) << 16) |
			((b[o + 3] & 0xff) << 24)
		) >>> 0
	}

	function u64leBigInt(b, o) {
		let v = 0n
		for (let i = 7; i >= 0; i--) {
			v = (v << 8n) | BigInt(b[o + i] & 0xff)
		}
		return v
	}

	const MAX_SAFE_BI = BigInt(Number.MAX_SAFE_INTEGER)
	const MIN_SAFE_BI = BigInt(Number.MIN_SAFE_INTEGER)

	function u64leSafe(b, o) {
		const v = u64leBigInt(b, o)
		return v <= MAX_SAFE_BI ? Number(v) : v
	}

	function i64leSafe(b, o) {
		let v = u64leBigInt(b, o)
		if (v >= 0x8000000000000000n) v -= 0x10000000000000000n
		return v >= MIN_SAFE_BI && v <= MAX_SAFE_BI ? Number(v) : v
	}

	function packU16le(v) {
		const n = Number(v) & 0xffff
		return new Uint8Array([n & 0xff, (n >> 8) & 0xff])
	}

	function packI16le(v) {
		const n = (Number(v) | 0) & 0xffff
		return new Uint8Array([n & 0xff, (n >> 8) & 0xff])
	}

	function packU32le(v) {
		const u = (Number(v) >>> 0) & 0xffffffff
		return new Uint8Array([
			u & 0xff,
			(u >>> 8) & 0xff,
			(u >>> 16) & 0xff,
			(u >>> 24) & 0xff,
		])
	}

	const MAX_U64_BI = 0xffffffffffffffffn

	function packU64le(v) {
		let bi
		if (typeof v === 'bigint') {
			bi = v
		} else if (typeof v === 'string') {
			const clean = v.trim()
			if (!clean || !/^\d+$/.test(clean)) {
				throw new RangeError('uint64 超出范围 (0 ~ 18446744073709551615)')
			}
			bi = BigInt(clean)
		} else if (typeof v === 'number') {
			if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
				throw new RangeError('uint64 超出范围 (0 ~ 18446744073709551615)')
			}
			bi = BigInt(v)
		} else {
			throw new RangeError('uint64 超出范围 (0 ~ 18446744073709551615)')
		}
		if (bi < 0n || bi > MAX_U64_BI) {
			throw new RangeError('uint64 超出范围 (0 ~ 18446744073709551615)')
		}
		const out = new Uint8Array(8)
		for (let i = 0; i < 8; i++) {
			out[i] = Number(bi & 0xffn)
			bi >>= 8n
		}
		return out
	}

	function decodeAscii(bytes) {
		const b = toU8(bytes)
		let end = b.length
		while (end > 0 && b[end - 1] === 0) end--
		let s = ''
		for (let i = 0; i < end; i++) {
			const c = b[i]
			if (c === 0) break
			if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c)
		}
		return s.trim()
	}

	function parseAlarms(flags) {
		const list = []
		const f = flags & 0xff
		for (let i = 0; i < ALARM_BITS.length; i++) {
			if (f & ALARM_BITS[i][0]) list.push(ALARM_BITS[i][1])
		}
		return list
	}

	function getModeText(mode) {
		return Object.prototype.hasOwnProperty.call(MODE_TEXT, mode) ? MODE_TEXT[mode] : ('未知(0x' + h2(mode) + ')')
	}

	function pad2(n) {
		return String(n).padStart(2, '0')
	}

	function pad4(n) {
		return String(n).padStart(4, '0')
	}

	function toBcdByte(n) {
		const v = Math.max(0, Math.min(99, Math.trunc(Number(n) || 0)))
		return ((Math.floor(v / 10) & 0x0f) << 4) | (v % 10)
	}

	function fromBcdByte(b) {
		return ((b >> 4) & 0x0f) * 10 + (b & 0x0f)
	}

	// ===== 校验和与 BCD / UID 辅助 =====
	function crc16(bytes) {
		const b = toU8(bytes)
		let crc = 0xffff
		for (let i = 0; i < b.length; i++) {
			crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ b[i]) & 0xff]) & 0xffff
		}
		return crc
	}

	function dateToBcd7(date) {
		const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date()
		const year = d.getFullYear()
		return new Uint8Array([
			toBcdByte(Math.floor(year / 100)),
			toBcdByte(year % 100),
			toBcdByte(d.getMonth() + 1),
			toBcdByte(d.getDate()),
			toBcdByte(d.getHours()),
			toBcdByte(d.getMinutes()),
			toBcdByte(d.getSeconds()),
		])
	}

	function bcdToDateStr(bytes) {
		const b = toU8(bytes)
		if (b.length < 6) return '格式错误'
		let year, mo, day, hh, mi, ss
		if (b.length >= 7) {
			year = fromBcdByte(b[0]) * 100 + fromBcdByte(b[1])
			mo = fromBcdByte(b[2])
			day = fromBcdByte(b[3])
			hh = fromBcdByte(b[4])
			mi = fromBcdByte(b[5])
			ss = fromBcdByte(b[6])
		} else {
			year = 2000 + fromBcdByte(b[0])
			mo = fromBcdByte(b[1])
			day = fromBcdByte(b[2])
			hh = fromBcdByte(b[3])
			mi = fromBcdByte(b[4])
			ss = fromBcdByte(b[5])
		}
		return pad4(year) + '-' + pad2(mo) + '-' + pad2(day) + ' ' + pad2(hh) + ':' + pad2(mi) + ':' + pad2(ss)
	}

	function sensorTimeToStr(bytes8) {
		const b = toU8(bytes8)
		if (b.length < 6) return '格式错误'
		let year = fromBcdByte(b[0])
		if (year < 100) year += 2000
		const mo = fromBcdByte(b[1])
		const day = fromBcdByte(b[2])
		const hh = fromBcdByte(b[3])
		const mi = fromBcdByte(b[4])
		const ss = fromBcdByte(b[5])
		return pad4(year) + '-' + pad2(mo) + '-' + pad2(day) + ' ' + pad2(hh) + ':' + pad2(mi) + ':' + pad2(ss)
	}

	function uidBytesToAuthCode(uid7BytesOrHex) {
		let b
		if (typeof uid7BytesOrHex === 'string') {
			b = hexToBytes(uid7BytesOrHex)
		} else {
			b = toU8(uid7BytesOrHex)
		}
		if (!b || b.length < 7) return null
		const code = u32le(b, 3)
		return code !== 0 ? code : null
	}

	// ===== 校准数学辅助 =====
	function createAnchorTable(direction) {
		const dir = direction === 'rev' ? 'rev' : 'fwd'
		const src = ANCHOR_RATIOS[dir]
		const out = {}
		let idx = 0
		const groups = ['Q3', 'Q2', 'Q1']
		for (let g = 0; g < groups.length; g++) {
			const grp = groups[g]
			const ratios = src[grp]
			const flows = Object.keys(ratios).map(Number).sort(function (a, b) { return b - a })
			const rows = []
			for (let i = 0; i < flows.length; i++) {
				const flow = flows[i]
				const ratio = ratios[String(flow)]
				rows.push({
					flow: flow,
					ratio: ratio,
					isAnchor: Math.abs(ratio - 1.0) < 1e-9,
					idx: idx,
					error: 0,
					currentCoeff: 10000,
					newCoeff: null,
				})
				idx++
			}
			out[grp] = rows
		}
		return out
	}

	function inferAnchorGroup(rows, anchorError) {
		if (!Array.isArray(rows)) return []
		let baseErr = anchorError
		if (baseErr == null || !Number.isFinite(Number(baseErr))) {
			baseErr = 0
			for (let i = 0; i < rows.length; i++) {
				if (rows[i] && rows[i].isAnchor) {
					baseErr = Number(rows[i].error || 0)
					break
				}
			}
		} else {
			baseErr = Number(baseErr)
		}
		return rows.map(function (r) {
			const err = r.isAnchor ? baseErr : (Math.round(baseErr * Number(r.ratio) * 10000) / 10000)
			return Object.assign({}, r, { error: err })
		})
	}

	function calcNewCoeff(currentCoeff, errorPct) {
		const cur = Number(currentCoeff)
		const err = Number(errorPct)
		if (!Number.isFinite(cur) || !Number.isFinite(err) || (100 + err) === 0) return null
		return Math.trunc(cur * (100 / (100 + err)))
	}

	function calcPointFlowRateLph(pulseEqUl, deltaMs, coeff) {
		const eq = Number(pulseEqUl)
		const dt = Number(deltaMs)
		if (!(eq > 0) || !(dt > 0)) return 0
		const c = coeff != null && Number.isFinite(Number(coeff)) && Number(coeff) > 0 ? Number(coeff) : 10000
		return eq * 3.6 / dt * (c / 10000)
	}

	function evalCalibErrorGrade(flowRateLph, errorPct) {
		const flow = Number(flowRateLph)
		const absErr = Math.abs(Number(errorPct || 0))
		if (flow >= 10) {
			if (absErr > 1.5) return { grade: 'bad', symbol: '✗' }
			if (absErr <= 1.0) return { grade: 'ok', symbol: '✓' }
			return { grade: 'warn', symbol: '⚠' }
		}
		if (absErr > 3.0) return { grade: 'bad', symbol: '✗' }
		if (absErr <= 2.0) return { grade: 'ok', symbol: '✓' }
		return { grade: 'warn', symbol: '⚠' }
	}

	// ===== AC6D 帧构造 =====
	function buildFrame(seq, packetBytes) {
		const s = Number(seq)
		if (!Number.isInteger(s) || s < 0 || s > 255) {
			throw new Error('序列号必须在 0~255 之间')
		}
		const pkt = toU8(packetBytes)
		if (pkt.length > MAX_PACKET_SIZE) {
			throw new Error('PACKET 长度超出上限 (' + pkt.length + ' > ' + MAX_PACKET_SIZE + ')')
		}
		const body = new Uint8Array(6 + pkt.length)
		body[0] = FRAME_HEAD_H
		body[1] = FRAME_HEAD_L
		body[2] = s & 0xff
		body[3] = (s ^ 0xff) & 0xff
		body[4] = pkt.length & 0xff
		body[5] = (pkt.length >> 8) & 0xff
		body.set(pkt, 6)
		const c = crc16(body)
		const frame = new Uint8Array(body.length + 2)
		frame.set(body, 0)
		frame[body.length] = c & 0xff
		frame[body.length + 1] = (c >> 8) & 0xff
		return frame
	}

	function buildCommandFrame(cmd, opts) {
		const o = opts || {}
		const c = Number(cmd) & 0xff
		const seq = o.seq != null ? (Number(o.seq) & 0xff) : nextAc6dSeq()
		const reqType = o.reqType != null
			? (Number(o.reqType) & 0xff)
			: (DATA_TYPE_CMDS.has(c) ? REQ_TYPE.DATA : REQ_TYPE.CONTROL)

		let dataBytes = o.data != null ? toU8(o.data) : new Uint8Array(0)
		if (dataBytes.length === 0 && o.withTimeSync && (c === CMD.FLOW_QUERY || c === CMD.DEV_INFO)) {
			dataBytes = concatBytes([[0x01], dateToBcd7(o.now)])
		}

		const omitAddr = c === CMD.FLOW_FAST || o.omitAddr === true
		let pkt
		if (omitAddr) {
			pkt = new Uint8Array(2 + dataBytes.length)
			pkt[0] = c
			pkt[1] = reqType
			pkt.set(dataBytes, 2)
		} else {
			const addrVal = o.addr != null ? Number(o.addr) : (o.authCode != null ? Number(o.authCode) : 0)
			pkt = new Uint8Array(6 + dataBytes.length)
			pkt[0] = c
			pkt[1] = reqType
			pkt.set(packU32le(addrVal), 2)
			pkt.set(dataBytes, 6)
		}

		const frame = buildFrame(seq, pkt)
		if (o.passthrough) {
			return wrapPassthrough(frame, o.iotSeq, o.now)
		}
		return frame
	}

	function encodeBaseParamsStruct(baseObj, layout) {
		const b = baseObj || {}
		let onlyAddr = new Uint8Array(7)
		let hasOnlyAddr = false
		if (b.onlyAddrBytes != null) {
			const raw = toU8(b.onlyAddrBytes)
			if (raw.length === 7) {
				onlyAddr.set(raw, 0)
				hasOnlyAddr = true
			}
		} else if (typeof b.onlyAddrHex === 'string' && b.onlyAddrHex.trim()) {
			const raw = hexToBytes(b.onlyAddrHex)
			if (raw && raw.length === 7) {
				onlyAddr.set(raw, 0)
				hasOnlyAddr = true
			}
		}
		if (layout !== 'legacy-24') {
			let nonZero = false
			for (let i = 0; i < 7; i++) {
				if (onlyAddr[i] !== 0) { nonZero = true; break }
			}
			if (!hasOnlyAddr || !nonZero) {
				throw new Error('写入完整基础参数必须提供有效的 7 字节非零设备唯一号 (onlyAddr)')
			}
		}

		const thresholdRaw = b.voltageAlarmThreshold != null
			? Math.round(Number(b.voltageAlarmThreshold))
			: (b.voltageAlarmV != null ? Math.round(Number(b.voltageAlarmV) * 100) : 300)
		const sampleIntervalMin = b.sampleIntervalMin != null ? Number(b.sampleIntervalMin) : 60
		const baseDegree = b.baseDegree != null ? b.baseDegree : 0
		const initFlag = b.initFlag != null ? (Number(b.initFlag) & 0xff) : 0x55
		const meterPulseEq = b.meterPulseEq != null ? Number(b.meterPulseEq) : 17085
		const calibPulseEq = b.calibPulseEq != null ? Number(b.calibPulseEq) : 1000
		const commPulseEq = b.commPulseEq != null ? Number(b.commPulseEq) : 60000
		const calibEnable = b.calibEnable != null ? (b.calibEnable ? 1 : 0) : 1
		const calibDirection = b.calibDirection === 'rev' ? 1 : (b.calibDirection === 'fwd' ? 0 : (Number(b.calibDirection || 0) & 0xff))
		const tempCompCoef = b.tempCompCoef != null ? Number(b.tempCompCoef) : 10000
		const tempCompBaseRaw = b.tempCompBase != null
			? Math.round(Number(b.tempCompBase))
			: (b.tempCompBaseC != null ? Math.round(Number(b.tempCompBaseC) * 10) : 200)

		if (layout === 'legacy-24') {
			return concatBytes([
				packU16le(thresholdRaw),
				packU16le(sampleIntervalMin),
				packU64le(baseDegree),
				packU32le(meterPulseEq),
				packU32le(calibPulseEq),
				packU32le(commPulseEq),
			])
		}

		if (layout === 'legacy-48') {
			const st = new Uint8Array(48)
			st.set(onlyAddr, 0)
			// [7] pad 0
			st.set(packU16le(thresholdRaw), 8)
			st.set(packU16le(sampleIntervalMin), 10)
			// [12..15] pad 0
			st.set(packU64le(baseDegree), 16)
			st[24] = initFlag
			// [25..27] pad 0
			st.set(packU32le(meterPulseEq), 28)
			st.set(packU32le(calibPulseEq), 32)
			st.set(packU32le(commPulseEq), 36)
			st[40] = calibEnable
			st[41] = calibDirection
			st.set(packI16le(tempCompCoef), 42)
			st.set(packU16le(tempCompBaseRaw), 44)
			const stCrc = crc16(st.subarray(0, 46))
			st.set(packU16le(stCrc), 46)
			return concatBytes([[0x00], st])
		}

		// 默认 'v27-40': type(0x00) + 40B packed struct
		const st = new Uint8Array(40)
		st.set(onlyAddr, 0)
		st.set(packU16le(thresholdRaw), 7)
		st.set(packU16le(sampleIntervalMin), 9)
		st.set(packU64le(baseDegree), 11)
		st[19] = initFlag
		st.set(packU32le(meterPulseEq), 20)
		st.set(packU32le(calibPulseEq), 24)
		st.set(packU32le(commPulseEq), 28)
		st[32] = calibEnable
		st[33] = calibDirection
		st.set(packI16le(tempCompCoef), 34)
		st.set(packU16le(tempCompBaseRaw), 36)
		const stCrc = crc16(st.subarray(0, 38))
		st.set(packU16le(stCrc), 38)
		return concatBytes([[0x00], st])
	}

	const builders = {
		handshake: function (opts) {
			return buildCommandFrame(CMD.HANDSHAKE, Object.assign({ reqType: REQ_TYPE.CONTROL, addr: 0 }, opts))
		},
		otaErase: function (addr, size, opts) {
			const targetAddr = addr != null ? Number(addr) : OTA_APP2_ADDR
			const eraseSize = size != null ? Number(size) : OTA_APP2_SIZE
			return buildCommandFrame(CMD.OTA_ERASE, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: targetAddr,
				data: packU32le(eraseSize),
			}))
		},
		otaData: function (addr, chunkBytes, opts) {
			return buildCommandFrame(CMD.OTA_DATA, Object.assign({}, opts, {
				reqType: REQ_TYPE.DATA,
				addr: Number(addr),
				data: toU8(chunkBytes),
			}))
		},
		otaCrc: function (addr, length, opts) {
			const startAddr = addr != null ? Number(addr) : OTA_APP2_ADDR
			return buildCommandFrame(CMD.OTA_CRC, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: startAddr,
				data: packU32le(Number(length)),
			}))
		},
		otaFinish: function (totalSize, totalCrc, opts) {
			return buildCommandFrame(CMD.OTA_FINISH, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: 0,
				data: concatBytes([packU32le(totalSize), packU16le(totalCrc)]),
			}))
		},
		flowFast: function (opts) {
			return buildCommandFrame(CMD.FLOW_FAST, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				omitAddr: true,
				data: new Uint8Array(0),
			}))
		},
		flowQuery: function (withTimeSync, opts) {
			const o = opts || {}
			const data = withTimeSync ? concatBytes([[0x01], dateToBcd7(o.now)]) : new Uint8Array(0)
			return buildCommandFrame(CMD.FLOW_QUERY, Object.assign({}, o, {
				reqType: REQ_TYPE.CONTROL,
				addr: 0,
				data: data,
			}))
		},
		alarmClear: function (mask, authCode, opts) {
			return buildCommandFrame(CMD.ALARM_CLEAR, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: authCode != null ? Number(authCode) : 0,
				data: new Uint8Array([Number(mask || 0) & 0xff]),
			}))
		},
		devInfo: function (withTimeSync, opts) {
			const o = opts || {}
			const data = withTimeSync ? concatBytes([[0x01], dateToBcd7(o.now)]) : new Uint8Array(0)
			return buildCommandFrame(CMD.DEV_INFO, Object.assign({}, o, {
				reqType: REQ_TYPE.CONTROL,
				addr: 0,
				data: data,
			}))
		},
		timeSync: function (date, authCode, opts) {
			const o = opts || {}
			return buildCommandFrame(CMD.TIME_SYNC, Object.assign({}, o, {
				reqType: REQ_TYPE.DATA,
				addr: authCode != null ? Number(authCode) : 0,
				data: dateToBcd7(date || o.now),
			}))
		},
		modeSet: function (mode, authCode, opts) {
			const m = Number(mode) & 0xff
			return buildCommandFrame(CMD.MODE_SET, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: m === 2 ? (authCode != null ? Number(authCode) : 0) : 0,
				data: new Uint8Array([m]),
			}))
		},
		authBypass: function (bypassVal, opts) {
			return buildCommandFrame(CMD.AUTH_BYPASS, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: Number(bypassVal || 0) >>> 0,
				data: new Uint8Array(0),
			}))
		},
		dailyFreeze: function (startIndex, opts) {
			return buildCommandFrame(CMD.DAILY_FREEZE, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: 0,
				data: packU16le(Number(startIndex || 0)),
			}))
		},
		calibRead: function (opts) {
			return buildCommandFrame(CMD.CALIB_READ, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: 0,
				data: new Uint8Array(0),
			}))
		},
		calibWriteAll: function (calibObj, authCode, opts) {
			const c = calibObj || {}
			const meterPulseEq = c.meterPulseEq != null ? c.meterPulseEq : (c.meter_pulse_eq != null ? c.meter_pulse_eq : 17085)
			const calibPulseEq = c.calibPulseEq != null ? c.calibPulseEq : (c.calib_pulse_eq != null ? c.calib_pulse_eq : 1000)
			const commPulseEq = c.commPulseEq != null ? c.commPulseEq : (c.comm_pulse_eq != null ? c.comm_pulse_eq : 60000)
			const fwdCount = Math.max(0, Math.min(20, Number(c.fwdCount != null ? c.fwdCount : (c.fwd_count != null ? c.fwd_count : 20))))
			const revCount = Math.max(0, Math.min(20, Number(c.revCount != null ? c.revCount : (c.rev_count != null ? c.rev_count : 20))))
			const fwdPoints = c.fwdPoints || c.fwd_points || []
			const fwdCoeffs = c.fwdCoeffs || c.fwd_coeffs || []
			const revPoints = c.revPoints || c.rev_points || []
			const revCoeffs = c.revCoeffs || c.rev_coeffs || []

			const data = new Uint8Array(176)
			data.set(packU32le(meterPulseEq), 0)
			data.set(packU32le(calibPulseEq), 4)
			data.set(packU32le(commPulseEq), 8)
			data[12] = 0
			data[13] = 0
			data[14] = fwdCount & 0xff
			data[15] = revCount & 0xff

			let off = 16
			for (let i = 0; i < 20; i++) {
				data.set(packU16le(fwdPoints[i] || 0), off)
				off += 2
				data.set(packU16le(fwdCoeffs[i] != null ? fwdCoeffs[i] : 10000), off)
				off += 2
			}
			for (let i = 0; i < 20; i++) {
				data.set(packU16le(revPoints[i] || 0), off)
				off += 2
				data.set(packU16le(revCoeffs[i] != null ? revCoeffs[i] : 10000), off)
				off += 2
			}

			return buildCommandFrame(CMD.CALIB_WRITE, Object.assign({}, opts, {
				reqType: REQ_TYPE.DATA,
				addr: authCode != null ? Number(authCode) : 0,
				data: data,
			}))
		},
		calibWriteSingle: function (direction, index, coeff, authCode, opts) {
			const dirByte = (direction === 'rev' || direction === 2) ? 0x02 : 0x01
			const data = concatBytes([
				[dirByte, Number(index || 0) & 0xff],
				packU32le(Number(coeff || 10000)),
			])
			return buildCommandFrame(CMD.CALIB_WRITE, Object.assign({}, opts, {
				reqType: REQ_TYPE.DATA,
				addr: authCode != null ? Number(authCode) : 0,
				data: data,
			}))
		},
		paramRead: function (paramType, opts) {
			return buildCommandFrame(CMD.PARAM_READ, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: 0,
				data: new Uint8Array([Number(paramType || 0) & 0xff]),
			}))
		},
		paramWriteBase: function (baseObj, authCode, opts) {
			const o = opts || {}
			const layout = o.layout || 'v27-40'
			const data = encodeBaseParamsStruct(baseObj, layout)
			return buildCommandFrame(CMD.PARAM_WRITE, Object.assign({}, o, {
				reqType: REQ_TYPE.DATA,
				addr: authCode != null ? Number(authCode) : 0,
				data: data,
			}))
		},
		logRead: function (logType, authCode, opts) {
			const lt = logType == null ? 0xff : (Number(logType) & 0xff)
			return buildCommandFrame(CMD.LOG_READ, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: authCode != null ? Number(authCode) : 0,
				data: new Uint8Array([lt]),
			}))
		},
		systemReset: function (authCode, opts) {
			return buildCommandFrame(CMD.RESET, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: authCode != null ? Number(authCode) : 0,
				data: new Uint8Array(0),
			}))
		},
		paramReset: function (level, authCode, opts) {
			const lv = level == null ? 1 : (Number(level) & 0xff)
			return buildCommandFrame(CMD.PARAM_RESET, Object.assign({}, opts, {
				reqType: REQ_TYPE.CONTROL,
				addr: authCode != null ? Number(authCode) : 0,
				data: new Uint8Array([lv]),
			}))
		},
		baseDegree: function (valueBigIntOrNum, authCode, opts) {
			return buildCommandFrame(CMD.BASE_DEGREE, Object.assign({}, opts, {
				reqType: REQ_TYPE.DATA,
				addr: authCode != null ? Number(authCode) : 0,
				data: packU64le(valueBigIntOrNum),
			}))
		},
	}

	// ===== A99A 透传封装/解包 & NB 模组信息 =====
	function wrapPassthrough(payloadBytes, iotSeq, now) {
		const payload = toU8(payloadBytes)
		const seq = iotSeq != null ? (Number(iotSeq) & 0xffff) : nextIotSeq()
		const tlvValue = concatBytes([[0x00], payload])
		const tlv = concatBytes([[IOT_TAG_PASSTHROUGH], packU16le(tlvValue.length), tlvValue])
		const timeBytes = dateToBcd7(now)
		const body = concatBytes([
			[IOT_HEAD_H, IOT_HEAD_L],
			packU16le(seq),
			[IOT_PROTO_VER],
			timeBytes,
			[IOT_FUNC_PASS_REQ, 0x00],
			packU16le(tlv.length + 2),
			packU16le(tlv.length),
			tlv,
		])
		const c = crc16(body)
		return concatBytes([body, packU16le(c), [IOT_TAIL]])
	}

	function tryUnwrapPassthroughAt(buf, funcOff) {
		if (buf.length < funcOff + 9) return null
		const func = buf[funcOff]
		if (func !== IOT_FUNC_PASS_REQ && func !== IOT_FUNC_PASS_RSP) return null
		const unencLen = u16le(buf, funcOff + 4)
		const tlvStart = funcOff + 6
		const crcStart = tlvStart + unencLen
		const total = crcStart + 3
		if (unencLen < 4 || total > buf.length) return null
		if (buf[crcStart + 2] !== IOT_TAIL) return null
		const crcRx = u16le(buf, crcStart)
		const crcCalc = crc16(buf.subarray(0, crcStart))
		if (crcRx !== crcCalc) return null
		const tlv = buf.subarray(tlvStart, crcStart)
		if (tlv.length < 4 || tlv[0] !== IOT_TAG_PASSTHROUGH) return null
		const tlvValLen = u16le(tlv, 1)
		if (tlvValLen < 1 || 3 + tlvValLen > tlv.length) return null
		const tlvVal = tlv.subarray(3, 3 + tlvValLen)
		if (tlvVal[0] !== 0x00) return null
		return {
			frame: buf.slice(0, total),
			payload: tlvVal.slice(1),
			rest: buf.slice(total),
			func: func,
			funcOffset: funcOff,
		}
	}

	function unwrapPassthrough(rawBytes) {
		const b = toU8(rawBytes)
		if (b.length < 21 || b[0] !== IOT_HEAD_H || b[1] !== IOT_HEAD_L) return null
		// 上行 A99A 透传 func 在 offset 20；下行 A99A 透传 func 在 offset 12
		return tryUnwrapPassthroughAt(b, 20) || tryUnwrapPassthroughAt(b, 12)
	}

	function buildModuleInfoQuery(queryId, iotSeq, now) {
		const qid = queryId == null ? 0x01 : (Number(queryId) & 0xff)
		const seq = iotSeq != null ? (Number(iotSeq) & 0xffff) : nextIotSeq()
		const tlv = concatBytes([[IOT_TAG_INFO_QUERY], packU16le(1), [qid]])
		const dataDomain = concatBytes([packU16le(tlv.length), tlv])
		const body = concatBytes([
			[IOT_HEAD_H, IOT_HEAD_L],
			packU16le(seq),
			[0x01],
			dateToBcd7(now),
			[IOT_FUNC_INFO_REQ, 0x00],
			packU16le(dataDomain.length),
			dataDomain,
		])
		const c = crc16(body)
		return concatBytes([body, packU16le(c), [IOT_TAIL]])
	}

	function parseTlvItems(data) {
		const b = toU8(data)
		const items = []
		let off = 0
		while (off + 3 <= b.length) {
			const tag = b[off]
			const len = u16le(b, off + 1)
			if (off + 3 + len > b.length) break
			items.push({ tag: tag, value: b.subarray(off + 3, off + 3 + len) })
			off += 3 + len
		}
		return items
	}

	function parseTag1BasicInfo(value) {
		const b = toU8(value)
		const info = {}
		let off = 0
		while (off < b.length) {
			const dataId = b[off++]
			const len = TAG1_FIELD_LENGTH[dataId]
			if (len == null || off + len > b.length) break
			const item = b.subarray(off, off + len)
			off += len
			if (dataId === 0x00) info.imei = decodeAscii(item)
			else if (dataId === 0x01) info.imsi = decodeAscii(item)
			else if (dataId === 0x02) info.iccid = decodeAscii(item)
			else if (dataId === 0x03) info.userNumber = bytesToHex(reverseBytes(item), false)
			else if (dataId === 0x04) info.deviceCode = bytesToHex(reverseBytes(item), false)
			else if (dataId === 0x05) info.firmwareVersion = decodeAscii(item)
			else if (dataId === 0x06) info.deviceTime = bcdToDateStr(item)
			else if (dataId === 0x09) info.baseMeterNumber = bytesToHex(reverseBytes(item), false)
			else if (dataId === 0x0a) info.moduleFw = decodeAscii(item)
			else if (dataId === 0x0b) info.bluetoothMac = bytesToHex(item, false)
			else if (dataId === 0x0c) {
				const alt = decodeAscii(item)
				if (alt) info.moduleFwAlt = alt
			}
		}
		return info
	}

	function parseModuleInfoUplink(rawBytes) {
		const b = toU8(rawBytes)
		if (b.length < 27 || b[0] !== IOT_HEAD_H || b[1] !== IOT_HEAD_L) return null
		const func = b[20]
		if (func !== IOT_FUNC_INFO_REQ && func !== IOT_FUNC_INFO_RSP) return null
		const dataLen = u16le(b, 22)
		const total = 24 + dataLen + 3
		if (b.length < total) return null
		const frame = b.subarray(0, total)
		if (frame[total - 1] !== IOT_TAIL) return null
		const crcRx = u16le(frame, total - 3)
		const crcCalc = crc16(frame.subarray(0, total - 3))
		if (crcRx !== crcCalc) return null
		const dataDomain = frame.subarray(24, 24 + dataLen)
		if (dataDomain.length < 2) return null
		const innerLen = u16le(dataDomain, 0)
		const tlvBytes = dataDomain.subarray(2, Math.min(dataDomain.length, 2 + innerLen))
		const tlvs = parseTlvItems(tlvBytes)

		const basic = {
			imei: '',
			imsi: '',
			iccid: '',
			userNumber: '',
			deviceCode: '',
			firmwareVersion: '',
			deviceTime: '',
			baseMeterNumber: '',
			moduleFw: '',
			bluetoothMac: '',
		}
		for (let i = 0; i < tlvs.length; i++) {
			if (tlvs[i].tag === 0x01) {
				const parsed = parseTag1BasicInfo(tlvs[i].value)
				Object.keys(parsed).forEach(function (k) {
					if (parsed[k]) basic[k] = parsed[k]
				})
			}
		}
		if (!basic.moduleFw && basic.moduleFwAlt) {
			basic.moduleFw = basic.moduleFwAlt
		}

		const headerDeviceCode = bytesToHex(reverseBytes(frame.subarray(7, 14)), false)
		return {
			ok: true,
			kind: 'a99a-info',
			dir: 'rsp',
			seq: u16le(frame, 2),
			version: frame[4],
			vendor: frame[5],
			deviceType: frame[6],
			func: func,
			control: frame[21],
			deviceCode: basic.deviceCode || headerDeviceCode,
			headerDeviceCode: headerDeviceCode,
			signal: {
				rsrp: i16le(frame, 14),
				snr: i16le(frame, 16),
				coverage: frame[18],
				csq: frame[19],
			},
			basic: basic,
			rawHex: bytesToHex(frame, false),
			raw: frame.slice(),
			frameLen: total,
		}
	}

	function parseModuleInfoDownlink(rawBytes) {
		const b = toU8(rawBytes)
		if (b.length < 19 || b[0] !== IOT_HEAD_H || b[1] !== IOT_HEAD_L) return null
		if (b[12] !== IOT_FUNC_INFO_REQ) return null
		const dataLen = u16le(b, 14)
		const total = 16 + dataLen + 3
		if (b.length < total) return null
		const frame = b.subarray(0, total)
		if (frame[total - 1] !== IOT_TAIL) return null
		const crcRx = u16le(frame, total - 3)
		const crcCalc = crc16(frame.subarray(0, total - 3))
		if (crcRx !== crcCalc) return null
		const dataDomain = frame.subarray(16, 16 + dataLen)
		let queryId = null
		if (dataDomain.length >= 6) {
			const innerLen = u16le(dataDomain, 0)
			const tlvs = parseTlvItems(dataDomain.subarray(2, Math.min(dataDomain.length, 2 + innerLen)))
			for (let i = 0; i < tlvs.length; i++) {
				if (tlvs[i].tag === IOT_TAG_INFO_QUERY && tlvs[i].value.length >= 1) {
					queryId = tlvs[i].value[0]
				}
			}
		}
		return {
			ok: true,
			kind: 'a99a-query',
			dir: 'req',
			seq: u16le(frame, 2),
			version: frame[4],
			platformTime: bcdToDateStr(frame.subarray(5, 12)),
			func: frame[12],
			control: frame[13],
			queryId: queryId,
			rawHex: bytesToHex(frame, false),
			raw: frame.slice(),
			frameLen: total,
		}
	}

	// ===== AC6D 帧查找与解析 =====
	function findFrame(bytes) {
		const b = toU8(bytes)
		for (let i = 0; i + 1 < b.length; i++) {
			if (b[i] === IOT_HEAD_H && b[i + 1] === IOT_HEAD_L) {
				const sub = b.subarray(i)
				const upInfo = parseModuleInfoUplink(sub)
				if (upInfo) {
					return {
						found: true,
						offset: i,
						length: upInfo.frameLen,
						frame: b.slice(i, i + upInfo.frameLen),
						prefix: i,
						suffix: b.length - i - upInfo.frameLen,
						frameKind: 'a99a-info',
					}
				}
				const pass = unwrapPassthrough(sub)
				if (pass) {
					return {
						found: true,
						offset: i,
						length: pass.frame.length,
						frame: pass.frame,
						prefix: i,
						suffix: b.length - i - pass.frame.length,
						frameKind: 'a99a-passthrough',
					}
				}
				const downQ = parseModuleInfoDownlink(sub)
				if (downQ) {
					return {
						found: true,
						offset: i,
						length: downQ.frameLen,
						frame: b.slice(i, i + downQ.frameLen),
						prefix: i,
						suffix: b.length - i - downQ.frameLen,
						frameKind: 'a99a-query',
					}
				}
			}
			if (b[i] === FRAME_HEAD_H && b[i + 1] === FRAME_HEAD_L) {
				if (i + 8 > b.length) continue
				const seq = b[i + 2]
				const seqXor = b[i + 3]
				if (seqXor !== ((seq ^ 0xff) & 0xff)) continue
				const len = u16le(b, i + 4)
				if (len < 2 || len > MAX_PACKET_SIZE) continue
				const total = 8 + len
				if (i + total > b.length) continue
				const crcRx = u16le(b, i + 6 + len)
				const crcCalc = crc16(b.subarray(i, i + 6 + len))
				if (crcRx !== crcCalc) continue
				return {
					found: true,
					offset: i,
					length: total,
					frame: b.slice(i, i + total),
					prefix: i,
					suffix: b.length - i - total,
					frameKind: 'ac6d',
				}
			}
		}
		return {
			found: false,
			offset: 0,
			length: b.length,
			frame: b,
			prefix: 0,
			suffix: 0,
		}
	}

	function parseBaseParamsPayload(p) {
		if (p.length >= 48) {
			const uid = p.subarray(0, 7)
			return {
				layout: 'legacy-48',
				base: {
					onlyAddrHex: bytesToHex(uid, false),
					authCode: uidBytesToAuthCode(uid),
					voltageAlarmV: Math.round(u16le(p, 8) * 0.01 * 100) / 100,
					sampleIntervalMin: u16le(p, 10),
					baseDegree: u64leSafe(p, 16),
					initFlag: p[24],
					meterPulseEq: u32le(p, 28),
					calibPulseEq: u32le(p, 32),
					commPulseEq: u32le(p, 36),
					calibEnable: p[40],
					calibDirection: p[41],
					tempCompCoef: i16le(p, 42),
					tempCompBaseC: Math.round(u16le(p, 44) * 0.1 * 10) / 10,
					crcHex: '0x' + hex4(u16le(p, 46)),
				},
			}
		}
		if (p.length >= 40) {
			const uid = p.subarray(0, 7)
			return {
				layout: 'v27-40',
				base: {
					onlyAddrHex: bytesToHex(uid, false),
					authCode: uidBytesToAuthCode(uid),
					voltageAlarmV: Math.round(u16le(p, 7) * 0.01 * 100) / 100,
					sampleIntervalMin: u16le(p, 9),
					baseDegree: u64leSafe(p, 11),
					initFlag: p[19],
					meterPulseEq: u32le(p, 20),
					calibPulseEq: u32le(p, 24),
					commPulseEq: u32le(p, 28),
					calibEnable: p[32],
					calibDirection: p[33],
					tempCompCoef: i16le(p, 34),
					tempCompBaseC: Math.round(u16le(p, 36) * 0.1 * 10) / 10,
					crcHex: '0x' + hex4(u16le(p, 38)),
				},
			}
		}
		return null
	}

	function parseMeterParamsPayload(p) {
		if (p.length >= 64) {
			const flowRaw = u16le(p, 52)
			return {
				layout: 'v24-64',
				meter: {
					meterHard: p[0],
					status: p[1],
					temperatureC: i8(p, 2),
					isFlowing: !!(p[3] & 0x01),
					isReverse: !!(p[3] & 0x02),
					flowStatusByte: p[3],
					serialNumber: u32le(p, 4),
					posVolumeUl: u64leSafe(p, 8),
					revVolumeUl: u64leSafe(p, 16),
					netVolumeUl: i64leSafe(p, 24),
					posPulse: u64leSafe(p, 32),
					revPulse: u64leSafe(p, 40),
					devLiveTotalTimeSec: u32le(p, 48),
					flowRateM3h: Math.round(flowRaw * 0.0001 * 1e6) / 1e6,
					flowRateLph: Math.round(flowRaw * 0.1 * 1e3) / 1e3,
					deviceTime: bcdToDateStr(p.subarray(54, 61)),
					crcHex: '0x' + hex4(u16le(p, 62)),
				},
			}
		}
		if (p.length >= 61) {
			const flowRaw = u16le(p, 48)
			return {
				layout: 'v23-61',
				meter: {
					meterHard: p[0],
					status: p[1],
					temperatureC: i8(p, 2),
					isFlowing: !!(p[3] & 0x01),
					isReverse: !!(p[3] & 0x02),
					flowStatusByte: p[3],
					serialNumber: u32le(p, 4),
					posVolumeUl: u64leSafe(p, 8),
					revVolumeUl: u64leSafe(p, 16),
					netVolumeUl: i64leSafe(p, 24),
					posPulse: u64leSafe(p, 32),
					revPulse: u64leSafe(p, 40),
					flowRateM3h: Math.round(flowRaw * 0.0001 * 1e6) / 1e6,
					flowRateLph: Math.round(flowRaw * 0.1 * 1e3) / 1e3,
					deviceTime: bcdToDateStr(p.subarray(50, 57)),
					crcHex: '0x' + hex4(u16le(p, 59)),
				},
			}
		}
		return null
	}

	function parseAlarmParamsPayload(p) {
		if (p.length < 35) return null
		const crcOff = p.length === 35 ? 33 : (p.length - 2)
		return {
			layout: p.length >= 36 ? 'legacy-36' : 'v27-35',
			alarm: {
				powerFlag: p[0],
				powerTime: bcdToDateStr(p.subarray(1, 8)),
				magneticFlag: p[8],
				magneticTime: bcdToDateStr(p.subarray(9, 16)),
				memoryFlag: p[16],
				memoryType: p[17],
				memoryTime: bcdToDateStr(p.subarray(18, 25)),
				xtlFlag: p[25],
				xtlTime: bcdToDateStr(p.subarray(26, 33)),
				crcHex: '0x' + hex4(u16le(p, crcOff)),
			},
		}
	}

	function parseLogEntry(entry) {
		const type = entry[0]
		const typeName = LOG_TYPE_TEXT[type] || ('未知(' + type + ')')
		const timeSlice = entry.subarray(1, 8)
		const time = timeSlice[0] === 0x20
			? bcdToDateStr(timeSlice)
			: bcdToDateStr(timeSlice.subarray(0, 6))
		const payload = entry.subarray(8, 30)
		const rxCrc = u16le(entry, 30)
		const calcCrc = crc16(entry.subarray(0, 30))
		const crcOk = calcCrc === rxCrc
		const crcHex = '0x' + hex4(rxCrc)
		let summary = bytesToHex(payload.subarray(0, 8), true)
		if (type === 0) {
			const sub = payload[0]
			summary = SYS_LOG_SUB_TEXT[sub] || ('子类型 0x' + h2(sub))
		} else if (type === 1) {
			summary = '累计复位次数 ' + payload[0]
		} else if (type === 2) {
			const fwCrc = u16le(payload, 0)
			const fwSize = u16le(payload, 2)
			summary = '固件CRC 0x' + hex4(fwCrc) + ', 大小 ' + fwSize + ' B'
		} else if (type === 3) {
			if (payload[0] === 0xff && payload[1] === 0x36) {
				summary = '电压>3.6V 自动恢复清除'
			} else if (payload[0] === 0x32) {
				summary = '0x32 指令清除报警 (掩码 0x' + h2(payload[1]) + ')'
			} else {
				const volt = (u16le(payload, 0) * 0.01).toFixed(2)
				summary = '触发时电压 ' + volt + 'V'
			}
		}
		if (!crcOk) {
			summary = summary + ' [CRC校验失败]'
		}
		return {
			type: type,
			typeName: typeName,
			time: time,
			summary: summary,
			crcHex: crcHex,
			calcCrcHex: '0x' + hex4(calcCrc),
			crcOk: crcOk,
		}
	}

	function parseCalibTableData(data) {
		const hasMagic = data.length >= 4 && u32le(data, 0) === 0xaa55aa55
		const offset = hasMagic ? 8 : 0
		if (data.length < offset + 176) return null
		const raw176 = data.slice(offset, offset + 176)
		const meterPulseEq = u32le(data, offset)
		const calibPulseEq = u32le(data, offset + 4)
		const commPulseEq = u32le(data, offset + 8)
		const fwdCount = data[offset + 14]
		const revCount = data[offset + 15]
		const fwdPoints = []
		const fwdCoeffs = []
		const revPoints = []
		const revCoeffs = []
		let pos = offset + 16
		for (let i = 0; i < 20; i++) {
			fwdPoints.push(u16le(data, pos))
			fwdCoeffs.push(u16le(data, pos + 2))
			pos += 4
		}
		for (let i = 0; i < 20; i++) {
			revPoints.push(u16le(data, pos))
			revCoeffs.push(u16le(data, pos + 2))
			pos += 4
		}
		const detail = {
			meterPulseEq: meterPulseEq,
			calibPulseEq: calibPulseEq,
			commPulseEq: commPulseEq,
			fwdCount: fwdCount,
			revCount: revCount,
			fwdPoints: fwdPoints,
			fwdCoeffs: fwdCoeffs,
			revPoints: revPoints,
			revCoeffs: revCoeffs,
			raw176: raw176,
		}
		if (hasMagic) {
			detail.memwPos = u32le(data, 4)
			if (data.length >= 192) {
				detail.crcHex = '0x' + hex4(u16le(data, 190))
			}
		}
		return detail
	}

	function createCrcReqTracker(maxEntries) {
		const limit = maxEntries || 32
		const map = new Map()
		return {
			set: function (seq, addr) {
				const k = Number(seq) & 0xff
				const v = Number(addr) >>> 0
				if (map.has(k)) map.delete(k)
				map.set(k, v)
				while (map.size > limit) {
					const oldest = map.keys().next().value
					map.delete(oldest)
				}
			},
			get: function (seq) {
				const k = Number(seq) & 0xff
				return map.has(k) ? map.get(k) : null
			},
			clear: function () {
				map.clear()
			},
			clone: function () {
				const copy = createCrcReqTracker(limit)
				map.forEach(function (v, k) { copy.set(k, v) })
				return copy
			},
		}
	}

	function extractPacketAddrAndData(cmd, dir, packet, ctx, seq) {
		const opts = ctx || {}
		if (dir === 'req') {
			if (cmd === CMD.FLOW_FAST) {
				return { hasAddr: false, addr: null, data: packet.subarray(2) }
			}
			if (packet.length < 6) {
				return { hasAddr: false, addr: null, data: packet.subarray(2) }
			}
			// 兼容旧上位机 0x33 带时间同步但未带 ADDR (LEN=10: CMD+TYPE+0x01+0x20...)
			if (cmd === CMD.DEV_INFO && packet.length === 10 && packet[2] === 0x01 && packet[3] === 0x20) {
				return { hasAddr: false, addr: null, data: packet.subarray(2) }
			}
			return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
		}

		// 应答帧兼容处理（含带 4B ADDR 与不带 ADDR 两种实机形态）
		if (cmd === CMD.FLOW_FAST) {
			return { hasAddr: false, addr: null, data: packet.subarray(2) }
		}
		if (cmd === CMD.HANDSHAKE) {
			if (packet.length >= 22) {
				return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			}
			return { hasAddr: false, addr: null, data: packet.subarray(2) }
		}
		if (cmd === CMD.OTA_CRC) {
			const raw = packet.subarray(2)
			if (raw.length >= 6) {
				const headU32 = u32le(raw, 0)
				let expectedAddr = null
				if (opts.crcReqAddr != null) {
					expectedAddr = Number(opts.crcReqAddr) >>> 0
				} else if (opts.crcReqTracker && typeof opts.crcReqTracker.get === 'function' && seq != null) {
					expectedAddr = opts.crcReqTracker.get(seq)
				}
				if (expectedAddr != null) {
					if (headU32 === expectedAddr) {
						return { hasAddr: true, addr: headU32, data: raw.subarray(4), crcFormat: 'B', crcValue: u16le(raw, 4), crcAmbiguous: false }
					}
					return { hasAddr: false, addr: null, data: raw, crcFormat: 'A', crcValue: u16le(raw, 0), crcAmbiguous: false }
				}
				if (headU32 === OTA_APP2_ADDR && raw.length === 6) {
					return { hasAddr: true, addr: headU32, data: raw.subarray(4), crcFormat: 'B', crcValue: u16le(raw, 4), crcAmbiguous: false }
				}
				if (raw.length === 6) {
					return {
						hasAddr: false,
						addr: null,
						data: raw,
						crcFormat: 'ambiguous',
						crcValue: null,
						crcAmbiguous: true,
						crcValueA: u16le(raw, 0),
						crcValueB: u16le(raw, 4),
					}
				}
				return { hasAddr: false, addr: null, data: raw, crcFormat: 'A', crcValue: u16le(raw, 0), crcAmbiguous: false }
			}
			return {
				hasAddr: false,
				addr: null,
				data: raw,
				crcFormat: 'A',
				crcValue: raw.length >= 2 ? u16le(raw, 0) : null,
				crcAmbiguous: false,
			}
		}
		if (cmd === CMD.FLOW_QUERY || cmd === CMD.DEV_INFO) {
			if (packet.length >= 57) {
				return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			}
			if (packet.length >= 53) {
				return { hasAddr: false, addr: null, data: packet.subarray(2) }
			}
			return packet.length >= 6
				? { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
				: { hasAddr: false, addr: null, data: packet.subarray(2) }
		}
		if (cmd === CMD.AUTH_BYPASS) {
			if (packet.length >= 10) {
				return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			}
			return { hasAddr: false, addr: null, data: packet.subarray(2) }
		}
		if (cmd === CMD.CALIB_READ) {
			if (packet.length >= 198) {
				return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			}
			if (packet.length >= 194) {
				return { hasAddr: false, addr: null, data: packet.subarray(2) }
			}
			if (packet.length >= 188 && u32le(packet, 6) === 0xaa55aa55) {
				return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			}
			if (packet.length >= 186 && u32le(packet, 2) === 0xaa55aa55) {
				return { hasAddr: false, addr: null, data: packet.subarray(2) }
			}
			if (packet.length >= 182) {
				return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			}
			return { hasAddr: false, addr: null, data: packet.subarray(2) }
		}
		if (cmd === CMD.PARAM_READ) {
			const n = packet.length
			if (n === 47 || n === 55 || n === 68 || n === 71 || n === 42) {
				return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			}
			if (n === 43) {
				if (packet[6] === 2 && u32le(packet, 2) === 0) {
					return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
				}
				if (packet[2] === 0) {
					return { hasAddr: false, addr: null, data: packet.subarray(2) }
				}
				return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			}
			if (n === 38 || n === 39 || n === 51 || n === 64 || n === 67) {
				return { hasAddr: false, addr: null, data: packet.subarray(2) }
			}
			return n >= 6
				? { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
				: { hasAddr: false, addr: null, data: packet.subarray(2) }
		}
		if (cmd === CMD.TIME_SYNC) {
			if (packet.length === 13) return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			if (packet.length === 9) return { hasAddr: false, addr: null, data: packet.subarray(2) }
		}
		if (cmd === CMD.MODE_SET) {
			if (packet.length === 7) return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			if (packet.length === 3) return { hasAddr: false, addr: null, data: packet.subarray(2) }
		}
		if (cmd === CMD.DAILY_FREEZE) {
			if (packet.length >= 10 && (packet.length - 10) % 32 === 0 && u16le(packet, 8) * 32 === (packet.length - 10)) {
				return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			}
			if (packet.length >= 6 && (packet.length - 6) % 32 === 0 && u16le(packet, 4) * 32 === (packet.length - 6)) {
				return { hasAddr: false, addr: null, data: packet.subarray(2) }
			}
		}
		if (cmd === CMD.LOG_READ) {
			if (packet.length >= 7 && (packet.length - 7) % 32 === 0) {
				return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			}
			if (packet.length >= 3 && (packet.length - 3) % 32 === 0) {
				return { hasAddr: false, addr: null, data: packet.subarray(2) }
			}
		}
		if (cmd === CMD.INIT_REPORT) {
			if (packet.length >= 33 && packet[6] === 0x01) {
				return { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			}
			if (packet.length >= 29 && packet[2] === 0x01) {
				return { hasAddr: false, addr: null, data: packet.subarray(2) }
			}
		}
		return packet.length >= 6
			? { hasAddr: true, addr: u32le(packet, 2), data: packet.subarray(6) }
			: { hasAddr: false, addr: null, data: packet.subarray(2) }
	}

	function parseReqDetail(cmd, addr, data) {
		const detail = {}
		switch (cmd) {
			case CMD.OTA_ERASE:
				detail.targetAddr = addr
				if (data.length >= 4) detail.eraseSize = u32le(data, 0)
				break
			case CMD.OTA_DATA:
				detail.targetAddr = addr
				detail.chunkSize = data.length
				break
			case CMD.OTA_CRC:
				detail.startAddr = addr
				if (data.length >= 4) detail.length = u32le(data, 0)
				break
			case CMD.OTA_FINISH:
				if (data.length >= 6) {
					detail.totalSize = u32le(data, 0)
					detail.totalCrc = u16le(data, 4)
				}
				break
			case CMD.FLOW_QUERY:
			case CMD.DEV_INFO:
				detail.withTimeSync = data.length >= 8 && data[0] === 0x01
				if (detail.withTimeSync) detail.syncTime = bcdToDateStr(data.subarray(1, 8))
				break
			case CMD.ALARM_CLEAR:
				if (data.length >= 1) {
					detail.mask = data[0]
					detail.alarms = parseAlarms(data[0])
				}
				break
			case CMD.TIME_SYNC:
				if (data.length >= 6) detail.syncTime = bcdToDateStr(data.subarray(0, Math.min(7, data.length)))
				break
			case CMD.MODE_SET:
				if (data.length >= 1) {
					detail.mode = data[0]
					detail.modeText = getModeText(data[0])
				}
				break
			case CMD.AUTH_BYPASS:
				detail.bypassVal = addr
				break
			case CMD.DAILY_FREEZE:
				if (data.length >= 2) detail.startIndex = u16le(data, 0)
				break
			case CMD.CALIB_WRITE:
				if (data.length >= 176) {
					Object.assign(detail, parseCalibTableData(data) || {})
					detail.writeMode = 'all'
				} else if (data.length >= 6) {
					detail.writeMode = 'single'
					detail.direction = data[0] === 0x02 ? 'rev' : 'fwd'
					detail.index = data[1]
					detail.coeff = u32le(data, 2)
				}
				break
			case CMD.PARAM_READ:
				if (data.length >= 1) detail.paramType = data[0]
				break
			case CMD.PARAM_WRITE:
				if (data.length >= 41 && data[0] === 0x00) {
					detail.paramType = 0
					Object.assign(detail, parseBaseParamsPayload(data.subarray(1)) || {})
				} else if (data.length === 24) {
					detail.paramType = 0
					detail.layout = 'legacy-24'
					detail.base = {
						voltageAlarmV: Math.round(u16le(data, 0) * 0.01 * 100) / 100,
						sampleIntervalMin: u16le(data, 2),
						baseDegree: u64leSafe(data, 4),
						meterPulseEq: u32le(data, 12),
						calibPulseEq: u32le(data, 16),
						commPulseEq: u32le(data, 20),
					}
				}
				break
			case CMD.LOG_READ:
				if (data.length >= 1) {
					detail.logType = data[0]
					detail.logTypeName = LOG_TYPE_TEXT[data[0]] || ('0x' + h2(data[0]))
				}
				break
			case CMD.PARAM_RESET:
				if (data.length >= 1) {
					detail.level = data[0]
					detail.levelText = PARAM_RESET_LEVEL_TEXT[data[0]] || ('级别 ' + data[0])
				}
				break
			case CMD.BASE_DEGREE:
				if (data.length >= 8) detail.baseDegree = u64leSafe(data, 0)
				break
			default:
				break
		}
		return detail
	}

	function parseRspDetail(cmd, status, data, meta, ctx) {
		const detail = {}
		if (cmd === CMD.MODE_SET) {
			if (data.length >= 1) {
				detail.mode = data[0]
				detail.modeText = getModeText(data[0])
			}
			return detail
		}
		if (status !== STATUS.OK) return detail

		switch (cmd) {
			case CMD.HANDSHAKE:
				detail.firmwareVersion = decodeAscii(data.subarray(0, Math.min(16, data.length)))
				break
			case CMD.OTA_CRC:
				detail.crcAmbiguous = !!meta.crcAmbiguous
				if (meta.crcAmbiguous) {
					detail.crcValue = null
					detail.crcValueA = meta.crcValueA
					detail.crcValueB = meta.crcValueB
					detail.crcFormat = 'ambiguous'
				} else {
					detail.crcValue = meta.crcValue != null ? meta.crcValue : (data.length >= 2 ? u16le(data, 0) : null)
					detail.crcFormat = meta.crcFormat || 'A'
				}
				break
			case CMD.FLOW_FAST:
				if (data.length >= 21) {
					const mode = data[0]
					const posUl = u64leSafe(data, 1)
					const revUl = u64leSafe(data, 9)
					const netUl = (typeof posUl === 'bigint' || typeof revUl === 'bigint')
						? (BigInt(posUl) - BigInt(revUl))
						: (posUl - revUl)
					const flowRaw = u16le(data, 17)
					const flowByte = data[19]
					const flags = data[20]
					detail.mode = mode
					detail.modeText = getModeText(mode)
					detail.posVolumeUl = posUl
					detail.revVolumeUl = revUl
					detail.netVolumeUl = netUl
					detail.flowRateM3h = Math.round(flowRaw * 0.0001 * 1e6) / 1e6
					detail.flowRateLph = Math.round(flowRaw * 0.1 * 1e3) / 1e3
					detail.isFlowing = !!(flowByte & 0x01)
					detail.isReverse = !!(flowByte & 0x02)
					detail.quadRemainder = (flowByte >> 4) & 0x03
					detail.flags = flags
					detail.alarms = parseAlarms(flags)
					if (ctx && ctx.meterPulseEq > 0) {
						const addUl = Math.floor(Number(ctx.meterPulseEq) * detail.quadRemainder / 4)
						detail.posVolumeInterpUl = typeof posUl === 'bigint' ? posUl + BigInt(addUl) : posUl + addUl
						detail.revVolumeInterpUl = typeof revUl === 'bigint' ? revUl + BigInt(addUl) : revUl + addUl
					}
				}
				break
			case CMD.FLOW_QUERY:
				if (data.length >= 51) {
					const posPulse = u64leSafe(data, 0)
					const revPulse = u64leSafe(data, 8)
					const posUl = u64leSafe(data, 16)
					const revUl = u64leSafe(data, 24)
					const netUl = (typeof posUl === 'bigint' || typeof revUl === 'bigint')
						? (BigInt(posUl) - BigInt(revUl))
						: (posUl - revUl)
					const flowRaw = u16le(data, 32)
					const mode = data[34]
					const flowByte = data[40]
					const flags = data[41]
					detail.posPulse = posPulse
					detail.revPulse = revPulse
					detail.posVolumeUl = posUl
					detail.revVolumeUl = revUl
					detail.netVolumeUl = netUl
					detail.flowRateM3h = Math.round(flowRaw * 0.0001 * 1e6) / 1e6
					detail.flowRateLph = Math.round(flowRaw * 0.1 * 1e3) / 1e3
					detail.mode = mode
					detail.modeText = getModeText(mode)
					detail.temperatureC = i8(data, 35)
					detail.voltageV = Math.round(u16le(data, 36) * 0.01 * 100) / 100
					detail.pulseEqUl = u16le(data, 38)
					detail.isFlowing = !!(flowByte & 0x01)
					detail.isReverse = !!(flowByte & 0x02)
					detail.quadRemainder = (flowByte >> 4) & 0x03
					detail.flags = flags
					detail.alarms = parseAlarms(flags)
					detail.pulseIntervalMs = u16le(data, 42)
					detail.deviceTime = bcdToDateStr(data.subarray(44, 51))
				}
				break
			case CMD.DEV_INFO:
				if (data.length >= 51) {
					const uid = data.slice(0, 7)
					const mode = data[35]
					const flags = data[26]
					detail.onlyAddrBytes = uid
					detail.onlyAddrHex = bytesToHex(uid, false)
					detail.authCode = uidBytesToAuthCode(uid)
					detail.firmwareVersion = decodeAscii(data.subarray(7, 23))
					detail.temperatureC = i8(data, 23)
					detail.voltageV = Math.round(u16le(data, 24) * 0.01 * 100) / 100
					detail.flags = flags
					detail.alarms = parseAlarms(flags)
					detail.sensorTime = sensorTimeToStr(data.subarray(27, 35))
					detail.mode = mode
					detail.modeText = getModeText(mode)
					detail.powerResetCount = u16le(data, 36)
					detail.wdtResetCount = u16le(data, 38)
					detail.totalRunTimeSec = u32le(data, 40)
					detail.activeRunTimeSec = u32le(data, 44)
				}
				break
			case CMD.TIME_SYNC:
				if (data.length >= 6) {
					detail.deviceTime = bcdToDateStr(data.subarray(0, Math.min(7, data.length)))
				}
				break
			case CMD.AUTH_BYPASS:
				if (data.length >= 4) {
					detail.bypassVal = u32le(data, 0)
				}
				break
			case CMD.DAILY_FREEZE:
				if (data.length >= 4) {
					const totalCount = u16le(data, 0)
					const batchCount = u16le(data, 2)
					const entries = []
					const rawEntries = data.subarray(4)
					const count = Math.min(batchCount, Math.floor(rawEntries.length / 32))
					for (let i = 0; i < count; i++) {
						const e = rawEntries.subarray(i * 32, (i + 1) * 32)
						const magic = u16le(e, 0)
						const magicOk = magic === 0x5a5a
						const rxCrc = u16le(e, 28)
						const calcCrc = crc16(e.subarray(0, 28))
						const crcOk = calcCrc === rxCrc
						const year = fromBcdByte(e[4]) * 100 + fromBcdByte(e[5])
						const month = fromBcdByte(e[6])
						const day = fromBcdByte(e[7])
						const alarmFlags = e[24]
						entries.push({
							serial: u16le(e, 2),
							date: pad4(year) + '-' + pad2(month) + '-' + pad2(day),
							cumulativeL: Math.round(u32le(e, 8)) / 100,
							reverseL: Math.round(u32le(e, 12)) / 100,
							positiveL: Math.round(u32le(e, 16)) / 100,
							flowRateM3h: Math.round(u16le(e, 20) * 0.0001 * 1e6) / 1e6,
							temperatureC: Math.round(i16le(e, 22) * 0.1 * 10) / 10,
							alarmFlags: alarmFlags,
							alarms: parseAlarms(alarmFlags),
							crcHex: '0x' + hex4(rxCrc),
							calcCrcHex: '0x' + hex4(calcCrc),
							magicOk: magicOk,
							crcOk: crcOk,
							valid: magicOk && crcOk,
						})
					}
					detail.totalCount = totalCount
					detail.batchCount = batchCount
					detail.entries = entries
				}
				break
			case CMD.INIT_REPORT:
				if (data.length >= 27 && data[0] === 0x01) {
					detail.firmwareVersion = decodeAscii(data.subarray(1, 17))
					detail.deviceTime = bcdToDateStr(data.subarray(17, 24))
					detail.powerResetCount = data[24]
					detail.wdtResetCount = data[25]
					detail.lvdResetCount = data[26]
				}
				break
			case CMD.CALIB_READ: {
				const cal = parseCalibTableData(data)
				if (cal) Object.assign(detail, cal)
				break
			}
			case CMD.PARAM_READ:
				if (data.length >= 1) {
					const paramType = data[0]
					const p = data.subarray(1)
					detail.paramType = paramType
					if (paramType === 0) {
						const parsed = parseBaseParamsPayload(p)
						if (parsed) Object.assign(detail, parsed)
					} else if (paramType === 1) {
						const parsed = parseMeterParamsPayload(p)
						if (parsed) Object.assign(detail, parsed)
					} else if (paramType === 2) {
						const parsed = parseAlarmParamsPayload(p)
						if (parsed) Object.assign(detail, parsed)
					}
				}
				break
			case CMD.LOG_READ:
				if (data.length >= 1) {
					const logType = data[0]
					const entries = []
					const rawEntries = data.subarray(1)
					const n = Math.floor(rawEntries.length / 32)
					for (let i = 0; i < n; i++) {
						entries.push(parseLogEntry(rawEntries.subarray(i * 32, (i + 1) * 32)))
					}
					detail.logType = logType
					detail.logTypeName = LOG_TYPE_TEXT[logType] || ('0x' + h2(logType))
					detail.entries = entries
				}
				break
			default:
				break
		}
		return detail
	}

	function parseFrame(bytes, ctx) {
		const rawIn = toU8(bytes)
		if (rawIn.length === 0) {
			return { ok: false, kind: 'ac6d', errors: ['空数据'], raw: rawIn }
		}

		// 若输入直接为 A99A 帧，按透传解包或模组信息解析
		if (rawIn.length >= 2 && rawIn[0] === IOT_HEAD_H && rawIn[1] === IOT_HEAD_L) {
			const pass = unwrapPassthrough(rawIn)
			if (pass && pass.payload.length >= 8 && pass.payload[0] === FRAME_HEAD_H && pass.payload[1] === FRAME_HEAD_L) {
				const inner = parseFrame(pass.payload, ctx)
				if (inner && inner.ok) {
					inner.unwrappedFromIot = true
					inner.outerIotFrame = pass.frame
					inner.iotFunc = pass.func
					inner.iotFuncOffset = pass.funcOffset
					inner.raw = rawIn.slice()
					return inner
				}
			}
			const info = parseModuleInfoUplink(rawIn)
			if (info) return info
			const downQ = parseModuleInfoDownlink(rawIn)
			if (downQ) return downQ
		}

		// 若前面带噪声，先定位首个合法帧
		let b = rawIn
		let offset = 0
		if (rawIn.length >= 2 && (rawIn[0] !== FRAME_HEAD_H || rawIn[1] !== FRAME_HEAD_L)) {
			const found = findFrame(rawIn)
			if (found && found.found) {
				if (found.frameKind !== 'ac6d') {
					const res = parseFrame(found.frame, ctx)
					if (res) {
						res.offset = found.offset
						res.raw = rawIn.slice()
					}
					return res
				}
				b = found.frame
				offset = found.offset
			} else {
				return { ok: false, kind: 'ac6d', errors: ['未找到合法 AC6D/A99A 帧'], raw: rawIn }
			}
		}

		if (b.length < 8) {
			return { ok: false, kind: 'ac6d', errors: ['帧长度不足(至少8字节)'], raw: rawIn }
		}
		if (b[0] !== FRAME_HEAD_H || b[1] !== FRAME_HEAD_L) {
			return { ok: false, kind: 'ac6d', errors: ['帧头不是 AC 6D'], raw: rawIn }
		}

		const seq = b[2]
		const seqXor = b[3]
		if (seqXor !== ((seq ^ 0xff) & 0xff)) {
			return { ok: false, kind: 'ac6d', errors: ['SEQ 异或校验失败'], seq: seq, raw: rawIn }
		}

		const len = u16le(b, 4)
		if (len < 2 || len > MAX_PACKET_SIZE) {
			return { ok: false, kind: 'ac6d', errors: ['PACKET 长度非法: ' + len], seq: seq, len: len, raw: rawIn }
		}
		const total = 8 + len
		if (b.length < total) {
			return { ok: false, kind: 'ac6d', errors: ['帧长度不足: 声明 ' + total + 'B，实际 ' + b.length + 'B'], seq: seq, len: len, raw: rawIn }
		}

		const crcRx = u16le(b, 6 + len)
		const crcCalc = crc16(b.subarray(0, 6 + len))
		if (crcRx !== crcCalc) {
			return {
				ok: false,
				kind: 'ac6d',
				errors: ['CRC16 校验失败: 收=0x' + hex4(crcRx) + ' 算=0x' + hex4(crcCalc)],
				seq: seq,
				len: len,
				crc: crcRx,
				crcCalc: crcCalc,
				raw: rawIn,
			}
		}

		const packet = b.subarray(6, 6 + len)
		const cmd = packet[0]
		const typeOrStatus = packet[1]
		const dir = (typeOrStatus === 0x10 || typeOrStatus === REQ_TYPE.CONTROL || typeOrStatus === REQ_TYPE.DATA) ? 'req' : 'rsp'
		const info = CMD_INFO[cmd] || { name: 'CMD_0x' + h2(cmd), label: '未知命令', needsAuth: false }
		const statusText = dir === 'req'
			? (typeOrStatus === REQ_TYPE.DATA ? 'DATA 请求' : (typeOrStatus === REQ_TYPE.CONTROL ? 'CONTROL 请求' : 'LEGACY 请求(0x' + h2(typeOrStatus) + ')'))
			: (STATUS_TEXT[typeOrStatus] || ('未知状态(0x' + h2(typeOrStatus) + ')'))

		const extracted = extractPacketAddrAndData(cmd, dir, packet, ctx, seq)
		if (cmd === CMD.OTA_CRC && dir === 'req' && extracted.hasAddr) {
			if (ctx && ctx.crcReqTracker && typeof ctx.crcReqTracker.set === 'function') {
				ctx.crcReqTracker.set(seq, extracted.addr)
			}
		}
		const detail = dir === 'req'
			? parseReqDetail(cmd, extracted.addr, extracted.data)
			: parseRspDetail(cmd, typeOrStatus, extracted.data, extracted, ctx)

		return {
			ok: true,
			kind: 'ac6d',
			dir: dir,
			seq: seq,
			len: len,
			cmd: cmd,
			cmdName: info.name,
			cmdLabel: info.label,
			typeOrStatus: typeOrStatus,
			statusText: statusText,
			hasAddr: extracted.hasAddr,
			addr: extracted.addr,
			data: extracted.data.slice(),
			crc: crcRx,
			detail: detail,
			frameLen: total,
			offset: offset,
			raw: rawIn.slice(),
		}
	}

	// ===== 流式拆包器（统一处理纯 AC6D、A99A 透传 AC6D 与 A99A 模组上报） =====
	function createStreamParser(opts) {
		const MAX_BUF = 65536
		const KEEP_TAIL = 4096
		let buf = new Uint8Array(0)
		const crcReqTracker = createCrcReqTracker(32)
		const parseOpts = Object.assign({ crcReqTracker: crcReqTracker }, opts || {})

		function push(chunkUint8Array) {
			const chunk = toU8(chunkUint8Array)
			if (chunk.length) {
				buf = concatBytes([buf, chunk])
				if (buf.length > MAX_BUF) {
					buf = buf.slice(buf.length - KEEP_TAIL)
				}
			}
			const events = []

			while (buf.length >= 2) {
				if (buf[0] === IOT_HEAD_H && buf[1] === IOT_HEAD_L) {
					// 1) 检查 A99A 模组上行信息帧 (func at offset 20 in {0x03, 0x83})
					if (buf.length >= 24 && (buf[20] === IOT_FUNC_INFO_REQ || buf[20] === IOT_FUNC_INFO_RSP)) {
						const dataLen = u16le(buf, 22)
						const total = 24 + dataLen + 3
						if (dataLen <= 2048) {
							if (buf.length < total) break
							const info = parseModuleInfoUplink(buf.subarray(0, total))
							if (info) {
								events.push({
									kind: 'a99a-info',
									rawFrame: info.raw,
									moduleInfo: info,
								})
								buf = buf.slice(total)
								continue
							}
						}
					}

					// 2) 检查 A99A 上行透传帧 (func at offset 20 in {0x04, 0x84})
					if (buf.length >= 26 && (buf[20] === IOT_FUNC_PASS_REQ || buf[20] === IOT_FUNC_PASS_RSP)) {
						const unencLen = u16le(buf, 24)
						const total = 26 + unencLen + 3
						if (unencLen >= 4 && unencLen <= 1024) {
							if (buf.length < total) break
							const pass = tryUnwrapPassthroughAt(buf.subarray(0, total), 20)
							if (pass) {
								if (pass.payload.length >= 8 && pass.payload[0] === FRAME_HEAD_H && pass.payload[1] === FRAME_HEAD_L) {
									const parsed = parseFrame(pass.payload, parseOpts)
									if (parsed && parsed.ok) {
										parsed.unwrappedFromIot = true
										parsed.outerIotFrame = pass.frame
										events.push({
											kind: 'ac6d',
											seq: parsed.seq,
											rawFrame: pass.payload,
											unwrappedFromIot: true,
											outerIotFrame: pass.frame,
											parsed: parsed,
										})
									}
								}
								buf = buf.slice(total)
								continue
							}
						}
					}

					// 3) 检查 A99A 下行透传帧 (func at offset 12 in {0x04, 0x84})
					if (buf.length >= 18 && (buf[12] === IOT_FUNC_PASS_REQ || buf[12] === IOT_FUNC_PASS_RSP)) {
						const unencLen = u16le(buf, 16)
						const total = 18 + unencLen + 3
						if (unencLen >= 4 && unencLen <= 1024) {
							if (buf.length < total) break
							const pass = tryUnwrapPassthroughAt(buf.subarray(0, total), 12)
							if (pass) {
								if (pass.payload.length >= 8 && pass.payload[0] === FRAME_HEAD_H && pass.payload[1] === FRAME_HEAD_L) {
									const parsed = parseFrame(pass.payload, parseOpts)
									if (parsed && parsed.ok) {
										parsed.unwrappedFromIot = true
										parsed.outerIotFrame = pass.frame
										events.push({
											kind: 'ac6d',
											seq: parsed.seq,
											rawFrame: pass.payload,
											unwrappedFromIot: true,
											outerIotFrame: pass.frame,
											parsed: parsed,
										})
									}
								}
								buf = buf.slice(total)
								continue
							}
						}
					}

					// 帧头匹配但尚未收齐 26B 头部，继续等待更多字节
					if (buf.length < 26) break
					buf = buf.slice(1)
					continue
				}

				if (buf[0] === FRAME_HEAD_H && buf[1] === FRAME_HEAD_L) {
					if (buf.length < 8) break
					const seq = buf[2]
					const seqXor = buf[3]
					if (seqXor !== ((seq ^ 0xff) & 0xff)) {
						buf = buf.slice(1)
						continue
					}
					const len = u16le(buf, 4)
					if (len < 2 || len > MAX_PACKET_SIZE) {
						buf = buf.slice(1)
						continue
					}
					const total = 8 + len
					if (buf.length < total) break
					const crcRx = u16le(buf, 6 + len)
					const crcCalc = crc16(buf.subarray(0, 6 + len))
					if (crcRx !== crcCalc) {
						buf = buf.slice(1)
						continue
					}
					const frame = buf.slice(0, total)
					const parsed = parseFrame(frame, parseOpts)
					if (parsed && parsed.ok) {
						events.push({
							kind: 'ac6d',
							seq: parsed.seq,
							rawFrame: frame,
							unwrappedFromIot: false,
							parsed: parsed,
						})
					}
					buf = buf.slice(total)
					continue
				}

				buf = buf.slice(1)
			}

			// 仅保留可能构成帧头首字节的单个尾部字节
			if (buf.length === 1 && buf[0] !== FRAME_HEAD_H && buf[0] !== IOT_HEAD_H) {
				buf = new Uint8Array(0)
			}

			return events
		}

		function reset() {
			buf = new Uint8Array(0)
			crcReqTracker.clear()
		}

		function trackCrcReq(seq, startAddr) {
			crcReqTracker.set(seq, startAddr)
		}

		return { push: push, reset: reset, trackCrcReq: trackCrcReq }
	}

	// ===== OTA 16B 固件头检查与封装 =====
	function inspectFirmwareBin(uint8Array) {
		const buf = toU8(uint8Array)
		const totalSize = buf.length
		const totalCrc = crc16(buf)

		if (buf.length >= OTA_HEADER_SIZE && u32le(buf, 0) === OTA_HEADER_MAGIC) {
			const hdrBodySize = u32le(buf, 4)
			const hdrBodyCrc = u16le(buf, 8)
			const upgradeFlag = buf[10]
			const productId = decodeAscii(buf.subarray(11, 15))
			const body = buf.subarray(OTA_HEADER_SIZE)
			const actualBodyCrc = crc16(body)
			let reason = ''
			if (totalSize <= OTA_HEADER_SIZE) reason = '固件体为空'
			else if (totalSize > OTA_APP2_SIZE) reason = '固件总大小超过 APP2 上限 (24KB / 0x6000)'
			else if (productId !== OTA_PRODUCT_ID) reason = '产品识别码不匹配: ' + productId + ' (期望 ' + OTA_PRODUCT_ID + ')'
			else if (hdrBodySize !== body.length) reason = '头部声明体长 (' + hdrBodySize + ') 与实际 (' + body.length + ') 不一致'
			else if (hdrBodyCrc !== actualBodyCrc) reason = '头部声明体 CRC (0x' + hex4(hdrBodyCrc) + ') 与实际 (0x' + hex4(actualBodyCrc) + ') 不一致'

			const res = {
				hasHeader: true,
				magicOk: true,
				productId: productId,
				upgradeFlag: upgradeFlag,
				bodySize: body.length,
				bodyCrc: actualBodyCrc,
				totalSize: totalSize,
				totalCrc: totalCrc,
				validForApp2: !reason,
			}
			if (reason) res.reason = reason
			return res
		}

		let reason = ''
		if (totalSize === 0) reason = '固件文件为空'
		else if (totalSize + OTA_HEADER_SIZE > OTA_APP2_SIZE) reason = '附加 16B 固件头后总大小超过 APP2 上限 (24KB / 0x6000)'

		const res = {
			hasHeader: false,
			magicOk: false,
			productId: '',
			bodySize: totalSize,
			bodyCrc: totalCrc,
			totalSize: totalSize,
			totalCrc: totalCrc,
			validForApp2: !reason,
		}
		if (reason) res.reason = reason
		return res
	}

	function wrapFirmwareWithHeader(rawBodyUint8Array, opts) {
		const o = opts || {}
		const buf = toU8(rawBodyUint8Array)
		const existing = inspectFirmwareBin(buf)
		if (existing.hasHeader && existing.magicOk && !o.force) {
			return {
				image: buf.slice(),
				info: existing,
				alreadyWrapped: true,
			}
		}

		const productStr = String(o.productId || OTA_PRODUCT_ID).slice(0, 4).padEnd(4, '\0')
		const productBytes = new Uint8Array(4)
		for (let i = 0; i < 4; i++) productBytes[i] = productStr.charCodeAt(i) & 0xff
		const upgradeFlag = o.upgradeFlag != null ? (Number(o.upgradeFlag) & 0xff) : 0xaa

		const header = concatBytes([
			packU32le(OTA_HEADER_MAGIC),
			packU32le(buf.length),
			packU16le(crc16(buf)),
			[upgradeFlag],
			productBytes,
			[0x00],
		])
		const image = concatBytes([header, buf])
		return {
			image: image,
			info: inspectFirmwareBin(image),
			alreadyWrapped: false,
		}
	}

	// ===== 校表数据绑定导出 (SK-CALIB-BIND v4) =====
	function formatTimestampFile(date) {
		const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date()
		return pad4(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
			pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
	}

	function formatTimestampIso(date) {
		const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date()
		return pad4(d.getFullYear()) + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
			pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
	}

	function extractBatchAndTail(userNumber) {
		const s = String(userNumber == null ? '' : userNumber).trim()
		if (s.length >= 20) {
			return { batch: s.slice(6, 16), tail: s.slice(-4) }
		}
		return { batch: '', tail: 'N' }
	}

	function buildCalibBindFileName(userNumber, date) {
		let batch = ''
		const tails = []
		if (Array.isArray(userNumber)) {
			for (let st = 0; st < 10; st++) {
				const parsed = extractBatchAndTail(userNumber[st])
				if (!batch && parsed.batch) batch = parsed.batch
				tails.push(parsed.tail)
			}
		} else {
			const parsed = extractBatchAndTail(userNumber)
			batch = parsed.batch
			tails.push(parsed.tail)
			for (let st = 1; st < 10; st++) tails.push('N')
		}
		if (!batch) batch = 'N'
		return batch + '_' + tails.join('_') + '_校表数据_' + formatTimestampFile(date) + '.json'
	}

	function buildCalibBindJson(payload) {
		const p = payload || {}
		const rawDate = p.date != null ? p.date : p.savedAt
		const d = rawDate instanceof Date && !isNaN(rawDate.getTime()) ? rawDate : new Date()
		const slot = Number.isInteger(p.slot) && p.slot >= 0 && p.slot < 10 ? p.slot : 0
		const port = String(p.port != null && p.port !== '' ? p.port : (p.portName || ''))
		const connected = p.connected !== false
		const sp = p.serialParams || p.serial_params || {}
		const serialParams = {
			baud: sp.baud != null ? sp.baud : (sp.baudRate != null ? sp.baudRate : 9600),
			parity: sp.parity || 'N',
			stopbits: sp.stopbits != null ? sp.stopbits : (sp.stopBits != null ? sp.stopBits : 1),
			bytesize: sp.bytesize != null ? sp.bytesize : (sp.dataBits != null ? sp.dataBits : 8),
		}

		const dev = p.deviceInfo || p.device || null
		const mod = p.moduleInfo || p.nbModule || p.nb_module || null
		const base = p.baseParams || p.basicData || p.basic_data || null
		const calib = p.calibData || p.calib || p.calib_data || null
		const serialIo = p.serialIo || p.serial_io || {}

		const modBasic = (mod && mod.basic) ? mod.basic : (mod || {})
		const userNumber = String(p.userNumber || modBasic.userNumber || modBasic.user_number || (dev && dev.user_number) || '').trim()
		const bt = extractBatchAndTail(userNumber)
		const batch = p.batch || bt.batch || 'N'

		const record = {
			schema: 'SK-CALIB-BIND',
			schema_version: 4,
			saved_at: formatTimestampIso(d),
			source: {
				device_slot: slot,
				port: port,
			},
			serial_params: serialParams,
			批次: batch,
			台位使能: {
				数量: 1,
				台位: [slot],
			},
		}

		for (let st = 0; st < 10; st++) {
			if (st !== slot) {
				record['台位' + st] = {
					statu: {
						串口使能: '未使能',
						读取传感器信息: '无',
						读取远传模组信息: '无',
					},
				}
				continue
			}

			const okDev = !!dev
			const okCalib = !!calib
			const sensorText = (okDev && okCalib) ? '成功' : ((okDev || okCalib) ? '部分成功' : '失败')
			const imei = String(modBasic.imei || '')
			const iccid = String(modBasic.iccid || '')
			const modStatus = (mod && mod.query_status) || (mod && mod.queryStatus) || (imei || iccid ? 'ok' : (mod ? 'partial' : 'timeout'))
			const moduleText = (imei || iccid) ? '成功' : (modStatus === 'partial' ? '部分成功' : '失败')

			const block = {
				statu: {
					串口使能: '使能',
					读取传感器信息: sensorText,
					读取远传模组信息: moduleText,
				},
			}

			if (dev) {
				block.device = {
					only_addr: dev.only_addr || dev.onlyAddrHex || '',
					firmware_version: dev.firmware_version || dev.firmwareVersion || '',
					user_number: userNumber,
					temperature: dev.temperature != null ? dev.temperature : (dev.temperatureC != null ? dev.temperatureC : ''),
					voltage: dev.voltage != null ? dev.voltage : (dev.voltageV != null ? dev.voltageV : ''),
					mode: dev.modeText || (typeof dev.mode === 'string' ? dev.mode : (dev.mode != null ? getModeText(dev.mode) : '')),
				}
			}

			if (mod) {
				block.nb_module = {
					imei: imei,
					imsi: String(modBasic.imsi || ''),
					iccid: iccid,
					user_number: String(modBasic.userNumber || modBasic.user_number || ''),
					module_fw: String(modBasic.moduleFw || modBasic.module_fw || ''),
					device_code: String(modBasic.deviceCode || modBasic.device_code || mod.deviceCode || mod.device_code || ''),
					device_time: String(modBasic.deviceTime || modBasic.device_time || ''),
					base_meter_number: String(modBasic.baseMeterNumber || modBasic.base_meter_number || ''),
					firmware_version: String(modBasic.firmwareVersion || modBasic.firmware_version || ''),
					bluetooth_mac: String(modBasic.bluetoothMac || modBasic.bluetooth_mac || ''),
					signal: mod.signal ? Object.assign({}, mod.signal) : {},
					query_status: modStatus,
				}
			}

			if (base) {
				const bSrc = base.base || base
				if (Object.prototype.hasOwnProperty.call(bSrc, '设备唯一码(onlyAddr)')) {
					block.basic_data = Object.assign({}, bSrc)
				} else {
					block.basic_data = {
						'设备唯一码(onlyAddr)': bSrc.onlyAddrHex || '',
						'电池电压报警阈值(V)': bSrc.voltageAlarmV != null ? bSrc.voltageAlarmV : 0,
						'数据采集间隔(min)': bSrc.sampleIntervalMin != null ? bSrc.sampleIntervalMin : 0,
						'底度值(脉冲数)': typeof bSrc.baseDegree === 'bigint' ? Number(bSrc.baseDegree) : (bSrc.baseDegree != null ? bSrc.baseDegree : 0),
						'系统参数初始化标志': bSrc.initFlag != null ? ('0x' + h2(bSrc.initFlag)) : '0x00',
						'计量脉冲当量(uL/脉冲)': bSrc.meterPulseEq != null ? bSrc.meterPulseEq : 0,
						'校准脉冲当量(uL/脉冲)': bSrc.calibPulseEq != null ? bSrc.calibPulseEq : 0,
						'上报脉冲当量(uL/脉冲)': bSrc.commPulseEq != null ? bSrc.commPulseEq : 0,
						'校准使能': bSrc.calibEnable ? '开启' : '关闭',
						'校准方向': bSrc.calibDirection ? '反向' : '正向',
						'温度补偿系数': bSrc.tempCompCoef != null ? bSrc.tempCompCoef : 10000,
						'基准温度(°C)': bSrc.tempCompBaseC != null ? bSrc.tempCompBaseC : 20,
						'结构体CRC': bSrc.crcHex || '0x0000',
					}
				}
			}

			if (calib) {
				block.calib_data = {
					meter_pulse_eq: calib.meter_pulse_eq != null ? calib.meter_pulse_eq : (calib.meterPulseEq || 0),
					calib_pulse_eq: calib.calib_pulse_eq != null ? calib.calib_pulse_eq : (calib.calibPulseEq || 0),
					comm_pulse_eq: calib.comm_pulse_eq != null ? calib.comm_pulse_eq : (calib.commPulseEq || 0),
					fwd_count: calib.fwd_count != null ? calib.fwd_count : (calib.fwdCount != null ? calib.fwdCount : 20),
					rev_count: calib.rev_count != null ? calib.rev_count : (calib.revCount != null ? calib.revCount : 20),
					fwd_points: Array.from(calib.fwd_points || calib.fwdPoints || []),
					fwd_coeffs: Array.from(calib.fwd_coeffs || calib.fwdCoeffs || []),
					rev_points: Array.from(calib.rev_points || calib.revPoints || []),
					rev_coeffs: Array.from(calib.rev_coeffs || calib.revCoeffs || []),
				}
			}

			block.serial = {
				port: port,
				connected: connected,
				serial_io: serialIo,
			}

			record['台位' + st] = block
		}

		return record
	}

	// ===== ProtocolRegistry 视图、字节映射、下行预设与设备面板 =====
	function escHtml(s) {
		if (root.ParseView && typeof root.ParseView.esc === 'function') return root.ParseView.esc(s)
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
	}

	function formatUlVolume(ul) {
		const n = Number(ul)
		if (!Number.isFinite(n)) return String(ul) + ' uL'
		return String(ul) + ' uL (' + (n / 1e9).toFixed(6) + ' m³)'
	}

	function logView(r) {
		if (!r || typeof r !== 'object') return null

		if (r.kind === 'a99a-info' && r.ok) {
			const b = r.basic || {}
			const sig = r.signal || {}
			const basicPairs = []
			if (b.imei) basicPairs.push(['IMEI', b.imei])
			if (b.imsi) basicPairs.push(['IMSI', b.imsi])
			if (b.iccid) basicPairs.push(['ICCID', b.iccid])
			if (b.userNumber) basicPairs.push(['用户表号', b.userNumber])
			if (b.deviceCode) basicPairs.push(['设备编码', b.deviceCode])
			if (b.firmwareVersion) basicPairs.push(['固件版本', b.firmwareVersion])
			if (b.moduleFw) basicPairs.push(['模组版本', b.moduleFw])
			if (b.deviceTime) basicPairs.push(['终端时间', b.deviceTime])
			if (b.baseMeterNumber) basicPairs.push(['基表号', b.baseMeterNumber])
			if (b.bluetoothMac) basicPairs.push(['蓝牙 MAC', b.bluetoothMac])
			const sections = [
				{
					title: '信号质量',
					pairs: [
						['RSRP', String(sig.rsrp) + ' dBm'],
						['SNR', String(sig.snr) + ' dB'],
						['覆盖等级', String(sig.coverage)],
						['CSQ', String(sig.csq)],
					],
				},
			]
			if (basicPairs.length) sections.push({ title: '模组基础信息', pairs: basicPairs })
			return {
				title: 'NB 模组信息上报',
				code: '0x' + h2(r.func),
				dir: 'up',
				subject: r.deviceCode ? { label: '设备码', value: r.deviceCode } : null,
				badges: [
					{ text: 'A99A', kind: 'info' },
					{ text: 'CRC ✓', kind: 'ok' },
				],
				meta: [['SEQ', String(r.seq)], ['版本', '0x' + h2(r.version)]],
				sections: sections,
			}
		}

		if (r.kind === 'a99a-query' && r.ok) {
			return {
				title: 'NB 模组信息查询',
				code: '0x' + h2(r.func),
				dir: 'down',
				badges: [
					{ text: 'A99A', kind: 'info' },
					{ text: 'CRC ✓', kind: 'ok' },
				],
				meta: [['SEQ', String(r.seq)], ['平台时间', r.platformTime || '']],
				sections: [{ title: '查询参数', pairs: [['查询项 ID', r.queryId != null ? String(r.queryId) : '--']] }],
			}
		}

		if (!r.ok || r.kind !== 'ac6d') return null

		const d = r.detail || {}
		const badges = []
		if (r.unwrappedFromIot) badges.push({ text: 'A99A 透传', kind: 'info' })
		badges.push({ text: r.dir === 'req' ? 'REQ' : 'RSP', kind: 'info' })
		if (r.dir === 'rsp') {
			badges.push({
				text: r.typeOrStatus === STATUS.OK ? 'OK' : ('0x' + h2(r.typeOrStatus) + ' ' + r.statusText),
				kind: r.typeOrStatus === STATUS.OK ? 'ok' : (r.typeOrStatus === STATUS.ALREADY_MODE ? 'warn' : 'bad'),
			})
		}
		badges.push({ text: 'CRC ✓', kind: 'ok' })

		const meta = [['SEQ', String(r.seq)], ['PACKET', r.len + ' B']]
		if (r.hasAddr && r.addr != null) meta.push(['ADDR', '0x' + hex8(r.addr)])

		const pairs = []
		let subject = null

		if (r.dir === 'rsp' && r.typeOrStatus === STATUS.OK) {
			switch (r.cmd) {
				case CMD.HANDSHAKE:
					pairs.push(['固件版本', d.firmwareVersion || '(空)'])
					break
				case CMD.OTA_CRC:
					if (d.crcAmbiguous) {
						pairs.push(['CRC 候选', '0x' + hex4(d.crcValueA) + '(格式A) / 0x' + hex4(d.crcValueB) + '(格式B，缺请求地址上下文)', '', 'warn'])
					} else {
						pairs.push(['设备 CRC16', d.crcValue != null ? ('0x' + hex4(d.crcValue)) : '--'])
						if (d.crcFormat) pairs.push(['响应格式', '格式 ' + d.crcFormat])
					}
					break
				case CMD.FLOW_FAST:
					if (d.mode != null) {
						pairs.push(['运行模式', d.modeText])
						pairs.push(['正向累计', formatUlVolume(d.posVolumeUl)])
						pairs.push(['反向累计', formatUlVolume(d.revVolumeUl)])
						pairs.push(['净累计', formatUlVolume(d.netVolumeUl)])
						pairs.push(['瞬时流速', d.flowRateM3h.toFixed(4) + ' m³/h', d.flowRateLph.toFixed(1) + ' L/h'])
						pairs.push(['水流状态', (d.isFlowing ? '流水' : '停水') + '/' + (d.isReverse ? '逆流' : '正流'), '象限余数=' + d.quadRemainder])
						pairs.push(['报警状态', d.alarms.length ? d.alarms.join('、') : '无报警', '', d.alarms.length ? 'warn' : 'ok'])
					}
					break
				case CMD.FLOW_QUERY:
					if (d.mode != null) {
						pairs.push(['运行模式', d.modeText])
						pairs.push(['正/反脉冲', String(d.posPulse) + ' / ' + String(d.revPulse)])
						pairs.push(['正向累计', formatUlVolume(d.posVolumeUl)])
						pairs.push(['反向累计', formatUlVolume(d.revVolumeUl)])
						pairs.push(['净累计', formatUlVolume(d.netVolumeUl)])
						pairs.push(['瞬时流速', d.flowRateM3h.toFixed(4) + ' m³/h', d.flowRateLph.toFixed(1) + ' L/h'])
						pairs.push(['温度 / 电压', d.temperatureC + ' °C / ' + d.voltageV.toFixed(2) + ' V'])
						pairs.push(['输出脉冲当量', d.pulseEqUl + ' uL'])
						pairs.push(['脉冲间隔', d.pulseIntervalMs + ' ms'])
						pairs.push(['水流状态', (d.isFlowing ? '流水' : '停水') + '/' + (d.isReverse ? '逆流' : '正流'), '象限余数=' + d.quadRemainder])
						pairs.push(['报警状态', d.alarms.length ? d.alarms.join('、') : '无报警', '', d.alarms.length ? 'warn' : 'ok'])
						pairs.push(['设备时间', d.deviceTime])
					}
					break
				case CMD.DEV_INFO:
					if (d.onlyAddrHex) {
						subject = { label: 'UID', value: d.onlyAddrHex }
						pairs.push(['设备唯一号', d.onlyAddrHex])
						if (d.authCode != null) pairs.push(['认证码', '0x' + hex8(d.authCode)])
						pairs.push(['固件版本', d.firmwareVersion || '(空)'])
						pairs.push(['运行模式', d.modeText])
						pairs.push(['温度 / 电压', d.temperatureC + ' °C / ' + d.voltageV.toFixed(2) + ' V'])
						pairs.push(['传感器时间', d.sensorTime])
						pairs.push(['报警状态', d.alarms.length ? d.alarms.join('、') : '无报警', '', d.alarms.length ? 'warn' : 'ok'])
						pairs.push(['复位计数', '掉电 ' + d.powerResetCount + ' / 看门狗 ' + d.wdtResetCount])
						pairs.push(['运行时间', '总 ' + d.totalRunTimeSec + 's / 活动 ' + d.activeRunTimeSec + 's'])
					}
					break
				case CMD.TIME_SYNC:
					if (d.deviceTime) pairs.push(['回显时间', d.deviceTime])
					break
				case CMD.MODE_SET:
					if (d.mode != null) pairs.push(['当前模式', d.modeText])
					break
				case CMD.AUTH_BYPASS:
					if (d.bypassVal != null) pairs.push(['当前旁路码', '0x' + hex8(d.bypassVal)])
					break
				case CMD.DAILY_FREEZE:
					if (d.totalCount != null) {
						pairs.push(['总条数 / 本帧', d.totalCount + ' / ' + d.batchCount])
						if (d.entries && d.entries.length) {
							const first = d.entries[0]
							const last = d.entries[d.entries.length - 1]
							const badCount = d.entries.filter(function (x) { return x.valid === false }).length
							pairs.push(['日期范围', first.date + ' ~ ' + last.date])
							pairs.push(['首条净累计', first.cumulativeL.toFixed(2) + ' L', '温度 ' + first.temperatureC.toFixed(1) + '°C'])
							pairs.push(['条目 CRC16', badCount ? (badCount + ' 条校验失败') : '全部通过', '', badCount ? 'bad' : 'ok'])
						}
					}
					break
				case CMD.CALIB_READ:
					if (d.meterPulseEq != null) {
						pairs.push(['计量/校准/上报当量', d.meterPulseEq + ' / ' + d.calibPulseEq + ' / ' + d.commPulseEq + ' uL'])
						pairs.push(['有效点数(正/反)', d.fwdCount + ' / ' + d.revCount])
						if (d.crcHex) pairs.push(['结构体 CRC', d.crcHex])
					}
					break
				case CMD.PARAM_READ:
					pairs.push(['参数类型', d.paramType === 0 ? '0 基础参数' : (d.paramType === 1 ? '1 计量数据' : '2 报警参数')])
					if (d.layout) pairs.push(['结构布局', d.layout])
					if (d.base) {
						subject = { label: 'UID', value: d.base.onlyAddrHex }
						pairs.push(['电压报警阈值', d.base.voltageAlarmV.toFixed(2) + ' V'])
						pairs.push(['采集间隔', d.base.sampleIntervalMin + ' min'])
						pairs.push(['底度(脉冲)', String(d.base.baseDegree)])
						pairs.push(['脉冲当量(计/校/报)', d.base.meterPulseEq + ' / ' + d.base.calibPulseEq + ' / ' + d.base.commPulseEq + ' uL'])
						pairs.push(['校准开关/方向', (d.base.calibEnable ? '开启' : '关闭') + ' / ' + (d.base.calibDirection ? '反向' : '正向')])
						pairs.push(['温补系数/基准温度', d.base.tempCompCoef + ' / ' + d.base.tempCompBaseC.toFixed(1) + ' °C'])
					} else if (d.meter) {
						pairs.push(['正向累计', formatUlVolume(d.meter.posVolumeUl)])
						pairs.push(['反向累计', formatUlVolume(d.meter.revVolumeUl)])
						pairs.push(['水温 / 流速', d.meter.temperatureC + ' °C / ' + d.meter.flowRateLph.toFixed(1) + ' L/h'])
						pairs.push(['更新时间', d.meter.deviceTime])
					} else if (d.alarm) {
						pairs.push(['低电压报警', d.alarm.powerFlag ? ('触发 ' + d.alarm.powerTime) : '正常'])
						pairs.push(['磁干扰报警', d.alarm.magneticFlag ? ('触发 ' + d.alarm.magneticTime) : '正常'])
						pairs.push(['存储故障', d.alarm.memoryFlag ? ('类型' + d.alarm.memoryType + ' ' + d.alarm.memoryTime) : '正常'])
						pairs.push(['晶振故障', d.alarm.xtlFlag ? ('触发 ' + d.alarm.xtlTime) : '正常'])
					}
					break
				case CMD.LOG_READ:
					pairs.push(['日志类型', d.logTypeName || String(d.logType)])
					pairs.push(['返回条数', String((d.entries || []).length)])
					if (d.entries && d.entries.length) {
						const e0 = d.entries[0]
						const badLogs = d.entries.filter(function (x) { return x.crcOk === false }).length
						pairs.push(['最新条目', '[' + e0.time + '] ' + e0.typeName + ': ' + e0.summary])
						if (badLogs) pairs.push(['条目 CRC16', badLogs + ' 条校验失败', '', 'bad'])
					}
					break
				default:
					if (r.data.length) pairs.push(['DATA', bytesToHex(r.data, true)])
					break
			}
		} else if (r.dir === 'req') {
			switch (r.cmd) {
				case CMD.OTA_ERASE:
					if (d.targetAddr != null) pairs.push(['目标地址', '0x' + hex4(d.targetAddr)])
					if (d.eraseSize != null) pairs.push(['擦除大小', d.eraseSize + ' B (0x' + hex4(d.eraseSize) + ')'])
					break
				case CMD.OTA_DATA:
					if (d.targetAddr != null) pairs.push(['写入地址', '0x' + hex4(d.targetAddr)])
					pairs.push(['块大小', d.chunkSize + ' B'])
					break
				case CMD.OTA_CRC:
					if (d.startAddr != null) pairs.push(['起始地址', '0x' + hex4(d.startAddr)])
					if (d.length != null) pairs.push(['校验长度', d.length + ' B'])
					break
				case CMD.OTA_FINISH:
					if (d.totalSize != null) pairs.push(['包总大小', d.totalSize + ' B'])
					if (d.totalCrc != null) pairs.push(['整包 CRC', '0x' + hex4(d.totalCrc)])
					break
				case CMD.FLOW_QUERY:
				case CMD.DEV_INFO:
					pairs.push(['时间同步', d.withTimeSync ? ('携带 ' + d.syncTime) : '仅查询'])
					break
				case CMD.ALARM_CLEAR:
					if (d.mask != null) pairs.push(['清除掩码', '0x' + h2(d.mask), (d.alarms || []).join('、') || '空'])
					break
				case CMD.TIME_SYNC:
					if (d.syncTime) pairs.push(['目标时间', d.syncTime])
					break
				case CMD.MODE_SET:
					if (d.mode != null) pairs.push(['目标模式', d.mode + ' ' + d.modeText])
					break
				case CMD.AUTH_BYPASS:
					if (d.bypassVal != null) pairs.push(['旁路参数', '0x' + hex8(d.bypassVal)])
					break
				case CMD.DAILY_FREEZE:
					if (d.startIndex != null) pairs.push(['起始索引', String(d.startIndex)])
					break
				case CMD.CALIB_WRITE:
					if (d.writeMode === 'all') {
						pairs.push(['写入模式', '全表 176B'])
						pairs.push(['当量(计/校/报)', d.meterPulseEq + ' / ' + d.calibPulseEq + ' / ' + d.commPulseEq + ' uL'])
						pairs.push(['有效点数(正/反)', d.fwdCount + ' / ' + d.revCount])
					} else if (d.writeMode === 'single') {
						pairs.push(['写入模式', '单点'])
						pairs.push(['方向 / 索引 / 系数', (d.direction === 'rev' ? '反向' : '正向') + ' / #' + d.index + ' / ' + d.coeff])
					}
					break
				case CMD.PARAM_READ:
					if (d.paramType != null) {
						pairs.push(['参数类型', d.paramType === 0 ? '0 基础参数' : (d.paramType === 1 ? '1 计量数据' : '2 报警参数')])
					}
					break
				case CMD.PARAM_WRITE:
					if (d.layout) pairs.push(['写入布局', d.layout])
					if (d.base) {
						pairs.push(['电压阈值 / 间隔', d.base.voltageAlarmV.toFixed(2) + ' V / ' + d.base.sampleIntervalMin + ' min'])
						pairs.push(['底度 / 计量当量', String(d.base.baseDegree) + ' / ' + d.base.meterPulseEq + ' uL'])
					}
					break
				case CMD.LOG_READ:
					if (d.logType != null) pairs.push(['日志类型', d.logTypeName])
					break
				case CMD.PARAM_RESET:
					if (d.level != null) pairs.push(['恢复级别', d.level + ' ' + d.levelText])
					break
				case CMD.BASE_DEGREE:
					if (d.baseDegree != null) pairs.push(['底度值(脉冲)', String(d.baseDegree)])
					break
				default:
					if (r.data.length) pairs.push(['DATA', bytesToHex(r.data, true)])
					break
			}
		} else if (r.cmd === CMD.MODE_SET && d.mode != null) {
			pairs.push(['当前模式', d.modeText])
		}

		const sections = pairs.length ? [{ title: r.dir === 'req' ? '请求参数' : '应答内容', pairs: pairs }] : []
		return {
			title: r.cmdLabel + ' (' + r.cmdName + ')',
			code: '0x' + h2(r.cmd),
			dir: r.dir === 'req' ? 'down' : 'up',
			subject: subject,
			badges: badges,
			meta: meta,
			sections: sections,
		}
	}

	function formatFrame(r) {
		const m = logView(r)
		if (m && root.ParseView && typeof root.ParseView.render === 'function') {
			return root.ParseView.render(m)
		}
		if (!m) {
			const errs = r && Array.isArray(r.errors) && r.errors.length ? r.errors.join('；') : '未识别的 AC6D/A99A 帧'
			return '<div class="pv-err">' + escHtml(errs) + '</div>'
		}
		const lines = [m.title + (m.code ? ' ' + m.code : '')]
		;(m.sections || []).forEach(function (sec) {
			;(sec.pairs || []).forEach(function (p) {
				lines.push(p[0] + ': ' + p[1] + (p[2] ? ' (' + p[2] + ')' : ''))
			})
		})
		return '<pre class="pv-pre">' + escHtml(lines.join('\n')) + '</pre>'
	}

	function byteMap(r) {
		if (!r || !r.raw) return []
		const raw = toU8(r.raw)
		const n = raw.length
		const map = new Array(n).fill('')
		const set = function (off, len, tip, grp) {
			for (let k = 0; k < len; k++) {
				if (off + k >= 0 && off + k < n) map[off + k] = { tip: tip, grp: grp }
			}
		}

		if (r.kind === 'a99a-info' && r.ok) {
			const base = r.offset || 0
			set(base, 2, 'A99A 帧头', '帧头')
			set(base + 2, 2, '帧序号 SEQ (u16 LE)', 'SEQ')
			set(base + 4, 1, '协议版本', '版本')
			set(base + 5, 1, '厂家编码', '厂家')
			set(base + 6, 1, '设备类型', '类型')
			set(base + 7, 7, '设备唯一编码 (反序)', '设备码')
			set(base + 14, 6, '信号质量 (RSRP/SNR/覆盖/CSQ)', '信号')
			set(base + 20, 1, '功能码 0x' + h2(r.func), '功能码')
			set(base + 21, 1, '控制码', '控制码')
			set(base + 22, 2, '数据域长度 (u16 LE)', '长度')
			const total = r.frameLen || n
			if (total > 27) set(base + 24, total - 27, 'TLV 数据域', '数据域')
			set(base + total - 3, 2, 'CRC16-CCITT (LE)', 'CRC')
			set(base + total - 1, 1, '帧尾 0x16', '帧尾')
			return map
		}

		if (r.kind === 'a99a-query' && r.ok) {
			const base = r.offset || 0
			const total = r.frameLen || n
			set(base, 2, 'A99A 帧头', '帧头')
			set(base + 2, 2, '帧序号 SEQ (u16 LE)', 'SEQ')
			set(base + 4, 1, '协议版本', '版本')
			set(base + 5, 7, '平台时间 (7B BCD)', '时间')
			set(base + 12, 1, '功能码 0x03', '功能码')
			set(base + 13, 1, '控制码', '控制码')
			set(base + 14, 2, '数据域长度 (u16 LE)', '长度')
			if (total > 19) set(base + 16, total - 19, 'TLV 查询项', '数据域')
			set(base + total - 3, 2, 'CRC16-CCITT (LE)', 'CRC')
			set(base + total - 1, 1, '帧尾 0x16', '帧尾')
			return map
		}

		if (r.kind !== 'ac6d' || !r.ok) return map

		// 如果是 A99A 透传包装帧，先标外层再标内层 AC6D
		let acBase = r.offset || 0
		if (r.unwrappedFromIot && r.outerIotFrame) {
			const outerLen = r.outerIotFrame.length
			const fOff = r.iotFuncOffset || 20
			set(0, 2, 'A99A 透传帧头', 'A99A帧头')
			set(2, 2, 'A99A 帧序号', 'A99A-SEQ')
			set(fOff, 1, 'A99A 透传功能码 0x' + h2(r.iotFunc || 0x04), 'A99A功能码')
			set(outerLen - 3, 2, 'A99A CRC16 (LE)', 'A99A-CRC')
			set(outerLen - 1, 1, 'A99A 帧尾 0x16', 'A99A帧尾')
			acBase = fOff + 6 + 4 // TLV header 3B + id 1B
		}

		set(acBase, 2, 'AC6D 帧头', '帧头')
		set(acBase + 2, 1, '帧序号 SEQ = ' + r.seq, 'SEQ')
		set(acBase + 3, 1, '序号异或校验 ~SEQ', 'XOR')
		set(acBase + 4, 2, 'PACKET 长度 = ' + r.len + ' B (u16 LE)', '长度')
		set(acBase + 6, 1, '命令码 CMD 0x' + h2(r.cmd) + ' ' + r.cmdName, 'CMD')
		set(acBase + 7, 1, (r.dir === 'req' ? '请求类型 ' : '应答状态 ') + '0x' + h2(r.typeOrStatus) + ' (' + r.statusText + ')', 'RSLT')
		let dataOff = acBase + 8
		if (r.hasAddr) {
			set(acBase + 8, 4, 'ADDR = 0x' + hex8(r.addr) + ' (u32 LE)', 'ADDR')
			dataOff = acBase + 12
		}
		const dataLen = r.data ? r.data.length : 0
		if (dataLen > 0) {
			set(dataOff, dataLen, '数据段 DATA (' + dataLen + 'B)', 'DATA')
			if (r.dir === 'rsp' && r.typeOrStatus === STATUS.OK) {
				if (r.cmd === CMD.FLOW_FAST && dataLen >= 21) {
					set(dataOff, 1, '运行模式', '模式')
					set(dataOff + 1, 8, '正累计体积 uL (u64 LE)', '正累计')
					set(dataOff + 9, 8, '反累计体积 uL (u64 LE)', '反累计')
					set(dataOff + 17, 2, '瞬时流速 0.0001m³/h (u16 LE)', '流速')
					set(dataOff + 19, 1, '水流状态 + 4倍频象限余数', '流态')
					set(dataOff + 20, 1, '报警标志位', '报警')
				} else if (r.cmd === CMD.FLOW_QUERY && dataLen >= 51) {
					set(dataOff, 8, '正累计脉冲 (u64 LE)', '正脉冲')
					set(dataOff + 8, 8, '反累计脉冲 (u64 LE)', '反脉冲')
					set(dataOff + 16, 8, '正累计体积 uL (u64 LE)', '正累计')
					set(dataOff + 24, 8, '反累计体积 uL (u64 LE)', '反累计')
					set(dataOff + 32, 2, '瞬时流速 0.0001m³/h (u16 LE)', '流速')
					set(dataOff + 34, 1, '运行模式', '模式')
					set(dataOff + 35, 1, '温度 °C (i8)', '温度')
					set(dataOff + 36, 2, '电压 0.01V (u16 LE)', '电压')
					set(dataOff + 38, 2, '输出脉冲当量 uL (u16 LE)', '当量')
					set(dataOff + 40, 1, '水流状态 + 4倍频象限余数', '流态')
					set(dataOff + 41, 1, '报警标志位', '报警')
					set(dataOff + 42, 2, '脉冲间隔 ms (u16 LE)', '间隔')
					set(dataOff + 44, 7, 'BCD 时间戳 (7B)', '时间')
				} else if (r.cmd === CMD.DEV_INFO && dataLen >= 51) {
					set(dataOff, 7, '设备唯一号 onlyAddr (7B)', 'UID')
					set(dataOff + 7, 16, '固件版本 (ASCII 16B)', '版本')
					set(dataOff + 23, 1, '温度 °C (i8)', '温度')
					set(dataOff + 24, 2, '电压 0.01V (u16 LE)', '电压')
					set(dataOff + 26, 1, '报警标志位', '报警')
					set(dataOff + 27, 8, '传感器内部时间 (8B)', '时间')
					set(dataOff + 35, 1, '运行模式', '模式')
					set(dataOff + 36, 4, '复位次数 (掉电/看门狗)', '复位')
					set(dataOff + 40, 8, '运行时间 (总/活动, 秒)', '运行时间')
				}
			}
		}
		set(acBase + 6 + r.len, 2, 'CRC16-CCITT (LE)', 'CRC')
		return map
	}

	function buildDownFrame(opt) {
		const o = opt || {}
		const cmd = typeof o.cmd === 'string' ? parseInt(o.cmd, 16) : Number(o.cmd)
		if (!Number.isFinite(cmd) || cmd < 0 || cmd > 0xff) {
			throw new Error('AC6D 命令码非法')
		}
		let dataBytes = new Uint8Array(0)
		if (o.data != null) {
			dataBytes = toU8(o.data)
		} else if (o.payloadHex != null && String(o.payloadHex).trim() !== '') {
			const parsed = hexToBytes(o.payloadHex)
			if (!parsed) throw new Error('载荷 HEX 格式无效')
			dataBytes = parsed
		} else if (Array.isArray(o.payload) && o.payload.length) {
			dataBytes = toU8(o.payload)
		} else if (cmd === CMD.TIME_SYNC) {
			dataBytes = dateToBcd7(o.now)
		}
		return buildCommandFrame(cmd, {
			seq: o.seq,
			reqType: o.reqType,
			addr: o.addr,
			authCode: o.authCode,
			data: dataBytes,
			withTimeSync: o.withTimeSync,
			now: o.now || o.time,
			passthrough: o.passthrough,
			iotSeq: o.iotSeq,
		})
	}

	const PRESETS = [
		{
			group: 'AC6D 核心查询',
			items: [
				{ name: '握手 HANDSHAKE (0x20)', func: 'query', cmd: CMD.HANDSHAKE, payloadHex: '', desc: '链路检测并读取固件版本号' },
				{ name: '流量快速查询 FLOW_FAST (0x30)', func: 'query', cmd: CMD.FLOW_FAST, payloadHex: '', desc: '10B 极简无 ADDR 帧，适合高频轮询' },
				{ name: '流量完整查询 FLOW_QUERY (0x31)', func: 'query', cmd: CMD.FLOW_QUERY, payloadHex: '', desc: '查询 51B 完整流量、脉冲、温压与状态' },
				{ name: '设备信息查询 DEV_INFO (0x33)', func: 'query', cmd: CMD.DEV_INFO, payloadHex: '', desc: '读取 7B UID、版本、温压、复位与运行时间' },
				{ name: 'RTC 时间同步 TIME_SYNC (0x34)', func: 'ctrl', cmd: CMD.TIME_SYNC, payloadHex: '', desc: '使用当前本机时间构造 7B BCD 同步设备 RTC' },
				{ name: '日冻结第 0 页 DAILY_FREEZE (0x37)', func: 'query', cmd: CMD.DAILY_FREEZE, payloadHex: '00 00', desc: '从索引 0 开始分页读取日冻结数据' },
			],
		},
		{
			group: 'AC6D 校准与参数',
			items: [
				{ name: '读取校准表 CALIB_READ (0x40)', func: 'calib', cmd: CMD.CALIB_READ, payloadHex: '', desc: '读取 192B 校准表与正反向 S 曲线' },
				{ name: '读基础参数 PARAM_READ(0)', func: 'param', cmd: CMD.PARAM_READ, payloadHex: '00', desc: '读取 baseParams 基础参数 (兼容 40B/48B)' },
				{ name: '读计量结构 PARAM_READ(1)', func: 'param', cmd: CMD.PARAM_READ, payloadHex: '01', desc: '读取 meter 计量结构体 (兼容 64B/61B)' },
				{ name: '读报警参数 PARAM_READ(2)', func: 'param', cmd: CMD.PARAM_READ, payloadHex: '02', desc: '读取 alarmParams 报警记录 (兼容 35B/36B)' },
			],
		},
	]

	const DEVICE_SPEC = {
		title: '容积式电子水表',
		nameKey: 'onlyAddr',
		timeoutMs: 3000,
		fields: [
			{ key: 'onlyAddr', name: '设备唯一号', kind: 'text', group: 'devInfo', copy: true },
			{ key: 'firmwareVersion', name: '固件版本', kind: 'text', group: 'devInfo', copy: true },
			{ key: 'mode', name: '运行模式', kind: 'enum', options: { 0: '休眠', 1: '快速响应', 2: '校表' }, group: 'devInfo' },
			{ key: 'voltageV', name: '电池电压', kind: 'number', unit: 'V', decimals: 2, group: 'devInfo' },
			{ key: 'temperatureC', name: '温度', kind: 'number', unit: '°C', decimals: 0, group: 'devInfo' },
			{ key: 'sensorTime', name: '传感器时间', kind: 'time', group: 'devInfo' },
			{ key: 'alarms', name: '报警标志', kind: 'bits', bits: ['低电压', '磁干扰', '晶振失效', 'Flash失败'], group: 'devInfo' },
			{ key: 'powerResetCount', name: '掉电复位次数', kind: 'number', unit: '次', group: 'devInfo' },
			{ key: 'wdtResetCount', name: '看门狗复位次数', kind: 'number', unit: '次', group: 'devInfo' },
			{ key: 'totalRunTimeSec', name: '总运行时间', kind: 'number', unit: 's', group: 'devInfo' },
			{ key: 'activeRunTimeSec', name: '活动运行时间', kind: 'number', unit: 's', group: 'devInfo' },
			{ key: 'posVolumeM3', name: '正向累计体积', kind: 'number', unit: 'm³', decimals: 6, group: 'flow' },
			{ key: 'revVolumeM3', name: '反向累计体积', kind: 'number', unit: 'm³', decimals: 6, group: 'flow' },
			{ key: 'netVolumeM3', name: '净累计体积', kind: 'number', unit: 'm³', decimals: 6, group: 'flow' },
			{ key: 'flowRateLph', name: '瞬时流速', kind: 'number', unit: 'L/h', decimals: 1, group: 'flow' },
			{ key: 'posPulse', name: '正向累计脉冲', kind: 'number', group: 'flow' },
			{ key: 'revPulse', name: '反向累计脉冲', kind: 'number', group: 'flow' },
			{ key: 'pulseEqUl', name: '输出脉冲当量', kind: 'number', unit: 'uL', group: 'flow' },
			{ key: 'pulseIntervalMs', name: '脉冲间隔', kind: 'number', unit: 'ms', group: 'flow' },
			{ key: 'flowState', name: '水流状态', kind: 'text', group: 'flow' },
			{ key: 'deviceTime', name: '设备时间', kind: 'time', group: 'flow' },
			{ key: 'voltageAlarmV', name: '电压报警阈值', kind: 'number', unit: 'V', decimals: 2, group: 'baseParams' },
			{ key: 'sampleIntervalMin', name: '采集间隔', kind: 'number', unit: 'min', group: 'baseParams' },
			{ key: 'baseDegree', name: '底度(脉冲)', kind: 'number', group: 'baseParams' },
			{ key: 'meterPulseEq', name: '计量脉冲当量', kind: 'number', unit: 'uL', group: 'baseParams' },
			{ key: 'calibPulseEq', name: '校准脉冲当量', kind: 'number', unit: 'uL', group: 'baseParams' },
			{ key: 'commPulseEq', name: '上报脉冲当量', kind: 'number', unit: 'uL', group: 'baseParams' },
			{ key: 'calibEnable', name: '校准使能', kind: 'enum', options: { 0: '关闭', 1: '开启' }, group: 'baseParams' },
			{ key: 'calibDirection', name: '校准方向', kind: 'enum', options: { 0: '正向', 1: '反向' }, group: 'baseParams' },
			{ key: 'tempCompCoef', name: '温度补偿系数', kind: 'number', group: 'baseParams' },
			{ key: 'tempCompBaseC', name: '基准温度', kind: 'number', unit: '°C', decimals: 1, group: 'baseParams' },
			{ key: 'alarmPowerFlag', name: '低电压报警', kind: 'enum', options: { 0: '正常', 1: '报警' }, group: 'alarmParams' },
			{ key: 'alarmPowerTime', name: '低电压报警时间', kind: 'text', group: 'alarmParams' },
			{ key: 'alarmMagneticFlag', name: '磁干扰报警', kind: 'enum', options: { 0: '正常', 1: '报警' }, group: 'alarmParams' },
			{ key: 'alarmMagneticTime', name: '磁干扰报警时间', kind: 'text', group: 'alarmParams' },
			{ key: 'alarmMemoryFlag', name: '存储故障报警', kind: 'enum', options: { 0: '正常', 1: '报警' }, group: 'alarmParams' },
			{ key: 'alarmXtlFlag', name: '晶振故障报警', kind: 'enum', options: { 0: '正常', 1: '报警' }, group: 'alarmParams' },
		],
		groups: [
			{ id: 'devInfo', title: '设备信息 (0x33)', request: { cmd: CMD.DEV_INFO } },
			{ id: 'flow', title: '实时流量 (0x31)', request: { cmd: CMD.FLOW_QUERY } },
			{ id: 'baseParams', title: '基础参数 (0x42-0)', request: { cmd: CMD.PARAM_READ, paramType: 0 } },
			{ id: 'alarmParams', title: '报警参数 (0x42-2)', request: { cmd: CMD.PARAM_READ, paramType: 2 } },
		],
		readSets: {
			status: ['devInfo', 'flow'],
			all: ['devInfo', 'flow', 'baseParams', 'alarmParams'],
		},
		status: [
			{ type: 'identity', title: '设备标识', keys: ['onlyAddr', 'firmwareVersion', 'mode'] },
			{ type: 'metric', title: '正向累计体积', key: 'posVolumeM3', sub: ['revVolumeM3', 'netVolumeM3', 'flowState'] },
			{ type: 'metric', title: '瞬时流速', key: 'flowRateLph', sub: ['pulseIntervalMs', 'pulseEqUl'] },
			{ type: 'metric', title: '电池电压', key: 'voltageV', sub: ['temperatureC', 'voltageAlarmV'] },
			{ type: 'deviceTime', title: '传感器时间', key: 'sensorTime', sub: ['deviceTime'] },
			{ type: 'flags', title: '报警状态', keys: ['alarms'] },
		],
		categories: [
			{ id: 'flow', title: '计量数据', keys: ['posVolumeM3', 'revVolumeM3', 'netVolumeM3', 'flowRateLph', 'posPulse', 'revPulse', 'pulseEqUl', 'pulseIntervalMs', 'flowState', 'deviceTime'] },
			{ id: 'info', title: '设备状态', keys: ['onlyAddr', 'firmwareVersion', 'mode', 'voltageV', 'temperatureC', 'sensorTime', 'alarms', 'powerResetCount', 'wdtResetCount', 'totalRunTimeSec', 'activeRunTimeSec'] },
			{ id: 'params', title: '基础参数', keys: ['voltageAlarmV', 'sampleIntervalMin', 'baseDegree', 'meterPulseEq', 'calibPulseEq', 'commPulseEq', 'calibEnable', 'calibDirection', 'tempCompCoef', 'tempCompBaseC'] },
			{ id: 'alarm', title: '报警记录', keys: ['alarmPowerFlag', 'alarmPowerTime', 'alarmMagneticFlag', 'alarmMagneticTime', 'alarmMemoryFlag', 'alarmXtlFlag'] },
		],
		buildRequest: function (group) {
			if (!group || !group.request) return null
			if (group.request.cmd === CMD.DEV_INFO) return builders.devInfo(false)
			if (group.request.cmd === CMD.FLOW_QUERY) return builders.flowQuery(false)
			if (group.request.cmd === CMD.PARAM_READ) return builders.paramRead(group.request.paramType || 0)
			return null
		},
		matchReply: function (group, parsed) {
			if (!group || !group.request || !parsed || !parsed.ok || parsed.kind !== 'ac6d' || parsed.dir !== 'rsp') return false
			if (parsed.typeOrStatus !== STATUS.OK) return false
			if (parsed.cmd !== group.request.cmd) return false
			if (parsed.cmd === CMD.PARAM_READ) {
				return parsed.detail && parsed.detail.paramType === (group.request.paramType || 0)
			}
			return true
		},
		extract: function (parsed) {
			if (!parsed || !parsed.ok || parsed.kind !== 'ac6d' || parsed.dir !== 'rsp' || parsed.typeOrStatus !== STATUS.OK) return null
			const d = parsed.detail || {}
			if (parsed.cmd === CMD.DEV_INFO && d.onlyAddrHex) {
				return {
					onlyAddr: d.onlyAddrHex,
					firmwareVersion: d.firmwareVersion || '',
					mode: d.mode,
					voltageV: d.voltageV,
					temperatureC: d.temperatureC,
					sensorTime: d.sensorTime,
					alarms: d.flags,
					powerResetCount: d.powerResetCount,
					wdtResetCount: d.wdtResetCount,
					totalRunTimeSec: d.totalRunTimeSec,
					activeRunTimeSec: d.activeRunTimeSec,
				}
			}
			if (parsed.cmd === CMD.FLOW_QUERY && d.mode != null) {
				return {
					mode: d.mode,
					posVolumeM3: Number(d.posVolumeUl) / 1e9,
					revVolumeM3: Number(d.revVolumeUl) / 1e9,
					netVolumeM3: Number(d.netVolumeUl) / 1e9,
					flowRateLph: d.flowRateLph,
					posPulse: Number(d.posPulse),
					revPulse: Number(d.revPulse),
					pulseEqUl: d.pulseEqUl,
					pulseIntervalMs: d.pulseIntervalMs,
					flowState: (d.isFlowing ? '流水' : '停水') + '/' + (d.isReverse ? '逆流' : '正流'),
					deviceTime: d.deviceTime,
					temperatureC: d.temperatureC,
					voltageV: d.voltageV,
					alarms: d.flags,
				}
			}
			if (parsed.cmd === CMD.FLOW_FAST && d.mode != null) {
				return {
					mode: d.mode,
					posVolumeM3: Number(d.posVolumeUl) / 1e9,
					revVolumeM3: Number(d.revVolumeUl) / 1e9,
					netVolumeM3: Number(d.netVolumeUl) / 1e9,
					flowRateLph: d.flowRateLph,
					flowState: (d.isFlowing ? '流水' : '停水') + '/' + (d.isReverse ? '逆流' : '正流'),
					alarms: d.flags,
				}
			}
			if (parsed.cmd === CMD.PARAM_READ && d.paramType === 0 && d.base) {
				return {
					onlyAddr: d.base.onlyAddrHex,
					voltageAlarmV: d.base.voltageAlarmV,
					sampleIntervalMin: d.base.sampleIntervalMin,
					baseDegree: Number(d.base.baseDegree),
					meterPulseEq: d.base.meterPulseEq,
					calibPulseEq: d.base.calibPulseEq,
					commPulseEq: d.base.commPulseEq,
					calibEnable: d.base.calibEnable,
					calibDirection: d.base.calibDirection,
					tempCompCoef: d.base.tempCompCoef,
					tempCompBaseC: d.base.tempCompBaseC,
				}
			}
			if (parsed.cmd === CMD.PARAM_READ && d.paramType === 2 && d.alarm) {
				return {
					alarmPowerFlag: d.alarm.powerFlag ? 1 : 0,
					alarmPowerTime: d.alarm.powerTime,
					alarmMagneticFlag: d.alarm.magneticFlag ? 1 : 0,
					alarmMagneticTime: d.alarm.magneticTime,
					alarmMemoryFlag: d.alarm.memoryFlag ? 1 : 0,
					alarmXtlFlag: d.alarm.xtlFlag ? 1 : 0,
				}
			}
			return null
		},
	}

	const Ac6dProtocol = {
		PROTOCOL_ID: PROTOCOL_ID,
		OTA_APP2_ADDR: OTA_APP2_ADDR,
		OTA_APP2_SIZE: OTA_APP2_SIZE,
		OTA_HEADER_SIZE: OTA_HEADER_SIZE,
		OTA_HEADER_MAGIC: OTA_HEADER_MAGIC,
		OTA_PRODUCT_ID: OTA_PRODUCT_ID,

		CMD: CMD,
		REQ_TYPE: REQ_TYPE,
		STATUS: STATUS,
		STATUS_TEXT: STATUS_TEXT,
		CMD_INFO: CMD_INFO,

		ANCHOR_RATIOS: ANCHOR_RATIOS,
		createAnchorTable: createAnchorTable,
		inferAnchorGroup: inferAnchorGroup,
		calcNewCoeff: calcNewCoeff,
		calcPointFlowRateLph: calcPointFlowRateLph,
		evalCalibErrorGrade: evalCalibErrorGrade,

		crc16: crc16,
		packU64le: packU64le,
		dateToBcd7: dateToBcd7,
		bcdToDateStr: bcdToDateStr,
		sensorTimeToStr: sensorTimeToStr,
		uidBytesToAuthCode: uidBytesToAuthCode,
		hexToBytes: hexToBytes,
		bytesToHex: bytesToHex,

		buildFrame: buildFrame,
		buildCommandFrame: buildCommandFrame,
		builders: builders,

		wrapPassthrough: wrapPassthrough,
		unwrapPassthrough: unwrapPassthrough,
		buildModuleInfoQuery: buildModuleInfoQuery,
		parseModuleInfoUplink: parseModuleInfoUplink,

		createStreamParser: createStreamParser,
		createCrcReqTracker: createCrcReqTracker,

		findFrame: findFrame,
		parseFrame: parseFrame,
		formatFrame: formatFrame,
		logView: logView,
		byteMap: byteMap,
		buildDownFrame: buildDownFrame,
		presets: PRESETS,
		device: DEVICE_SPEC,

		inspectFirmwareBin: inspectFirmwareBin,
		wrapFirmwareWithHeader: wrapFirmwareWithHeader,

		buildCalibBindFileName: buildCalibBindFileName,
		buildCalibBindJson: buildCalibBindJson,
	}

	root.Ac6dProtocol = Ac6dProtocol

	function registerBuiltinProtocol() {
		if (typeof root.registerProtocol !== 'function') return false
		root.registerProtocol(PROTOCOL_ID, {
			name: '容积水表 (AC6D)',
			builtin: true,
			source: 'builtin',
			description: 'LPUART0 AC6D 容积式电子水表通信协议（支持流量查询、S曲线校准、参数冻结、OTA升级与 A99A 透传解析）',
			findFrame: findFrame,
			parseFrame: parseFrame,
			formatFrame: formatFrame,
			logView: logView,
			byteMap: byteMap,
			buildDownFrame: buildDownFrame,
			presets: PRESETS,
			device: DEVICE_SPEC,
		})
		const sel = typeof document !== 'undefined' ? document.getElementById('serial-protocol-select') : null
		if (sel && root._activeProtocol === PROTOCOL_ID) sel.value = PROTOCOL_ID
		return true
	}

	if (!registerBuiltinProtocol() && typeof setTimeout === 'function' && typeof window !== 'undefined') {
		let retries = 0
		const retryRegister = function () {
			if (registerBuiltinProtocol() || ++retries >= 100) return
			setTimeout(retryRegister, 50)
		}
		setTimeout(retryRegister, 50)
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = Ac6dProtocol
	}
})(typeof window !== 'undefined' ? window : globalThis)
