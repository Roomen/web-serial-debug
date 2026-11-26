// 声明式 JSON 协议编译器（Schema v1）：
// 校验和引擎、Schema 校验、帧查找/解析/字节映射/ParseView 渲染、通用下行组帧、本地存储与桌面目录协议管理。
;(function (root) {
	'use strict'

	const STORAGE_KEY = 'customJsonProtocols'
	const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
	const DEFAULT_RESERVED_IDS = ['sek', 'wmbus', 'gz', 'cjt188', 'sk-ultrasonic', 'hostproto', 'cellular-at']
	const FIELD_TYPES = [
		'uint8', 'int8',
		'uint16le', 'uint16be', 'int16le', 'int16be',
		'uint32le', 'uint32be', 'int32le', 'int32be',
		'hex', 'ascii', 'bcd', 'bcd_le', 'bcd_be', 'bitfield',
	]
	const FIXED_TYPE_SIZE = {
		uint8: 1, int8: 1,
		uint16le: 2, uint16be: 2, int16le: 2, int16be: 2,
		uint32le: 4, uint32be: 4, int32le: 4, int32be: 4,
	}

	function getReservedIds() {
		const reg = root.ProtocolRegistry
		if (reg && Array.isArray(reg.RESERVED_IDS)) {
			const set = new Set(DEFAULT_RESERVED_IDS)
			reg.RESERVED_IDS.forEach(id => set.add(id))
			return set
		}
		return new Set(DEFAULT_RESERVED_IDS)
	}

	// ===== 字节与 HEX 工具 =====
	function toU8(v) {
		if (v instanceof Uint8Array) return v
		if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
		if (v instanceof ArrayBuffer) return new Uint8Array(v)
		if (Array.isArray(v)) return Uint8Array.from(v)
		return new Uint8Array(0)
	}

	function h2(b) {
		return (b & 0xff).toString(16).toUpperCase().padStart(2, '0')
	}

	function bytesToHex(bytes) {
		const b = toU8(bytes)
		const out = new Array(b.length)
		for (let i = 0; i < b.length; i++) out[i] = h2(b[i])
		return out.join(' ')
	}

	function hexToBytes(str) {
		if (str == null || str === '') return new Uint8Array(0)
		if (str instanceof Uint8Array) return str.slice()
		if (Array.isArray(str)) return Uint8Array.from(str)
		const clean = String(str).replace(/0x/gi, '').replace(/[\s:,_-]/g, '')
		if (clean.length === 0) return new Uint8Array(0)
		if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null
		const out = new Uint8Array(clean.length / 2)
		for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
		return out
	}

	function parseNumber(v) {
		if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
		if (typeof v === 'string') {
			const s = v.trim()
			if (!s) return NaN
			if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16)
			if (/^[+-]?\d+(\.\d+)?$/.test(s)) return Number(s)
		}
		return NaN
	}

	function parseIntStrict(v) {
		const n = parseNumber(v)
		return Number.isInteger(n) ? n : NaN
	}

	function escHtml(s) {
		if (root.ParseView && typeof root.ParseView.esc === 'function') return root.ParseView.esc(s)
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
	}

	function matchesAt(buf, offset, pattern) {
		if (!pattern || !pattern.length) return true
		if (offset < 0 || offset + pattern.length > buf.length) return false
		for (let i = 0; i < pattern.length; i++) {
			if (buf[offset + i] !== pattern[i]) return false
		}
		return true
	}

	function resolveOffset(len, off) {
		return off < 0 ? len + off : off
	}

	function readUInt(buf, off, size, endian) {
		if (size === 1) return buf[off]
		if (size === 2) return endian === 'be' ? ((buf[off] << 8) | buf[off + 1]) : (buf[off] | (buf[off + 1] << 8))
		if (size === 4) {
			return endian === 'be'
				? (((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0)
				: ((buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0)
		}
		return 0
	}

	function writeUInt(buf, off, size, val, endian) {
		const v = val >>> 0
		if (size === 1) {
			buf[off] = v & 0xff
		} else if (size === 2) {
			if (endian === 'be') {
				buf[off] = (v >>> 8) & 0xff
				buf[off + 1] = v & 0xff
			} else {
				buf[off] = v & 0xff
				buf[off + 1] = (v >>> 8) & 0xff
			}
		} else if (size === 4) {
			if (endian === 'be') {
				buf[off] = (v >>> 24) & 0xff
				buf[off + 1] = (v >>> 16) & 0xff
				buf[off + 2] = (v >>> 8) & 0xff
				buf[off + 3] = v & 0xff
			} else {
				buf[off] = v & 0xff
				buf[off + 1] = (v >>> 8) & 0xff
				buf[off + 2] = (v >>> 16) & 0xff
				buf[off + 3] = (v >>> 24) & 0xff
			}
		}
	}

	// ===== 校验和引擎 =====
	const CHECKSUM_ALGORITHMS = [
		'none',
		'sum8', 'xor8', 'xor', 'lrc8', 'crc8',
		'crc16-modbus', 'crc16-ccitt', 'crc16-xmodem', 'crc16-ibm', 'crc16-custom',
	]

	function reflectBits(val, width) {
		let out = 0
		for (let i = 0; i < width; i++) {
			if (val & (1 << i)) out |= 1 << (width - 1 - i)
		}
		return out >>> 0
	}

	function sizeOfChecksum(alg) {
		const a = String(alg || 'none').toLowerCase()
		if (a === 'none' || a === '') return 0
		if (a === 'sum8' || a === 'xor8' || a === 'xor' || a === 'lrc8' || a === 'crc8') return 1
		if (a === 'crc16-modbus' || a === 'crc16-ccitt' || a === 'crc16-xmodem' || a === 'crc16-ibm' || a === 'crc16-custom') return 2
		return 0
	}

	function computeCrc8(bytes, cfg) {
		const poly = (cfg && cfg.poly != null ? parseIntStrict(cfg.poly) : 0x07) & 0xff
		let crc = (cfg && cfg.init != null ? parseIntStrict(cfg.init) : 0x00) & 0xff
		const refIn = !!(cfg && cfg.refIn)
		const refOut = !!(cfg && cfg.refOut)
		const xorOut = (cfg && cfg.xorOut != null ? parseIntStrict(cfg.xorOut) : 0x00) & 0xff
		for (let i = 0; i < bytes.length; i++) {
			let b = bytes[i] & 0xff
			if (refIn) b = reflectBits(b, 8)
			crc ^= b
			for (let k = 0; k < 8; k++) {
				crc = (crc & 0x80) ? (((crc << 1) ^ poly) & 0xff) : ((crc << 1) & 0xff)
			}
		}
		if (refOut) crc = reflectBits(crc, 8)
		return (crc ^ xorOut) & 0xff
	}

	function computeCrc16(bytes, poly, init, refIn, refOut, xorOut) {
		let crc = init & 0xffff
		const p = poly & 0xffff
		for (let i = 0; i < bytes.length; i++) {
			let b = bytes[i] & 0xff
			if (refIn) b = reflectBits(b, 8)
			crc ^= (b << 8)
			for (let k = 0; k < 8; k++) {
				crc = (crc & 0x8000) ? (((crc << 1) ^ p) & 0xffff) : ((crc << 1) & 0xffff)
			}
		}
		if (refOut) crc = reflectBits(crc, 16)
		return (crc ^ (xorOut & 0xffff)) & 0xffff
	}

	function computeRawChecksum(bytes, alg, cfg) {
		if (alg === 'none') return 0
		if (alg === 'sum8') {
			let s = 0
			for (let i = 0; i < bytes.length; i++) s = (s + bytes[i]) & 0xff
			return s
		}
		if (alg === 'xor8' || alg === 'xor') {
			let x = 0
			for (let i = 0; i < bytes.length; i++) x ^= bytes[i]
			return x & 0xff
		}
		if (alg === 'lrc8') {
			let s = 0
			for (let i = 0; i < bytes.length; i++) s = (s + bytes[i]) & 0xff
			return ((0x100 - s) & 0xff)
		}
		if (alg === 'crc8') return computeCrc8(bytes, cfg)
		if (alg === 'crc16-modbus') return computeCrc16(bytes, 0x8005, 0xffff, true, true, 0x0000)
		if (alg === 'crc16-ccitt') return computeCrc16(bytes, 0x1021, 0xffff, false, false, 0x0000)
		if (alg === 'crc16-xmodem') return computeCrc16(bytes, 0x1021, 0x0000, false, false, 0x0000)
		if (alg === 'crc16-ibm') return computeCrc16(bytes, 0x8005, 0x0000, true, true, 0x0000)
		if (alg === 'crc16-custom') {
			const poly = cfg && cfg.poly != null ? parseIntStrict(cfg.poly) : 0x1021
			const init = cfg && cfg.init != null ? parseIntStrict(cfg.init) : 0xffff
			const xorOut = cfg && cfg.xorOut != null ? parseIntStrict(cfg.xorOut) : 0x0000
			return computeCrc16(bytes, poly, init, !!(cfg && cfg.refIn), !!(cfg && cfg.refOut), xorOut)
		}
		throw new Error('不支持的校验算法：' + alg)
	}

	function computeChecksum(bytes, cfg) {
		const data = toU8(bytes)
		const c = typeof cfg === 'string' ? { algorithm: cfg } : (cfg || {})
		const alg = String(c.algorithm || 'none').toLowerCase()
		let slice = data
		if (c.start != null || c.end != null) {
			const start = c.start == null ? 0 : resolveOffset(data.length, c.start)
			const end = c.end == null ? data.length : resolveOffset(data.length, c.end)
			if (start < 0 || end < start || end > data.length) {
				throw new Error('校验范围越界')
			}
			slice = data.subarray(start, end)
		}
		return computeRawChecksum(slice, alg, c)
	}

	function verifyChecksumDetail(frame, cfg, tailLen) {
		const data = toU8(frame)
		const c = typeof cfg === 'string' ? { algorithm: cfg } : (cfg || null)
		const alg = c ? String(c.algorithm || 'none').toLowerCase() : 'none'
		const size = sizeOfChecksum(alg)
		if (alg === 'none' || size === 0) {
			return { ok: true, enabled: false, algorithm: 'none', size: 0, offset: -1, expected: 0, actual: 0 }
		}
		const tLen = tailLen || 0
		const rawOff = c.offset != null ? c.offset : -(size + tLen)
		const off = resolveOffset(data.length, rawOff)
		const rawStart = c.start != null ? c.start : 0
		const rawEnd = c.end != null ? c.end : rawOff
		const start = resolveOffset(data.length, rawStart)
		const end = resolveOffset(data.length, rawEnd)
		if (off < 0 || off + size > data.length || start < 0 || end < start || end > data.length) {
			return { ok: false, enabled: true, algorithm: alg, size: size, offset: off, expected: 0, actual: 0, outOfRange: true }
		}
		const endian = c.endian === 'be' ? 'be' : 'le'
		const expected = computeRawChecksum(data.subarray(start, end), alg, c)
		const actual = readUInt(data, off, size, endian)
		return { ok: expected === actual, enabled: true, algorithm: alg, size: size, offset: off, expected: expected, actual: actual }
	}

	function verifyChecksum(frame, cfg) {
		return verifyChecksumDetail(frame, cfg, 0).ok
	}

	const Checksum = {
		ALGORITHMS: CHECKSUM_ALGORITHMS.slice(),
		sizeOf: sizeOfChecksum,
		compute: computeChecksum,
		verify: verifyChecksum,
	}

	// ===== Schema v1 校验与规范化 =====
	function validateFieldSpec(f, pathLabel, errors) {
		if (!f || typeof f !== 'object' || Array.isArray(f)) {
			errors.push(pathLabel + ' 必须为对象')
			return null
		}
		const name = typeof f.name === 'string' ? f.name.trim() : ''
		if (!name) errors.push(pathLabel + '.name 不能为空')
		const offset = parseIntStrict(f.offset)
		if (Number.isNaN(offset)) errors.push(pathLabel + '.offset 必须为整数')
		const type = String(f.type || 'uint8').toLowerCase()
		if (FIELD_TYPES.indexOf(type) === -1) {
			errors.push(pathLabel + '.type 不支持：' + f.type)
		}
		let length = f.length
		if (length === undefined || length === null || length === '') {
			if (FIXED_TYPE_SIZE[type]) length = FIXED_TYPE_SIZE[type]
			else if (type === 'bitfield') length = 1
			else length = 'rest'
		} else if (length !== 'rest') {
			length = parseIntStrict(length)
			if (Number.isNaN(length) || length <= 0 || length > 1024) {
				errors.push(pathLabel + '.length 必须为正整数或 "rest"')
			} else if (FIXED_TYPE_SIZE[type] && length !== FIXED_TYPE_SIZE[type]) {
				errors.push(pathLabel + '.length 与类型 ' + type + ' 的字节宽度不匹配')
			} else if (type === 'bitfield' && [1, 2, 4].indexOf(length) === -1) {
				errors.push(pathLabel + '.length（bitfield）仅支持 1 / 2 / 4 字节')
			}
		}
		let scale = null
		if (f.scale !== undefined && f.scale !== null && f.scale !== '') {
			scale = Number(f.scale)
			if (!Number.isFinite(scale)) errors.push(pathLabel + '.scale 必须为有限数字')
		}
		let decimals = null
		if (f.decimals !== undefined && f.decimals !== null && f.decimals !== '') {
			decimals = parseIntStrict(f.decimals)
			if (Number.isNaN(decimals) || decimals < 0 || decimals > 10) {
				errors.push(pathLabel + '.decimals 必须为 0~10 的整数')
			}
		}
		const format = f.format === 'hex' || f.format === 'dec' ? f.format : ''
		const role = f.role === 'subject' || f.role === 'cmd' || f.role === 'seq' ? f.role : ''
		const mapObj = (f.map && typeof f.map === 'object' && !Array.isArray(f.map))
			? f.map
			: (f.enum && typeof f.enum === 'object' && !Array.isArray(f.enum) ? f.enum : null)
		const bits = []
		if (Array.isArray(f.bits)) {
			f.bits.forEach((b, bi) => {
				if (!b || typeof b !== 'object') {
					errors.push(pathLabel + '.bits[' + bi + '] 必须为对象')
					return
				}
				const bit = parseIntStrict(b.bit)
				const width = b.width == null ? 1 : parseIntStrict(b.width)
				const label = typeof b.label === 'string' ? b.label.trim() : ''
				if (Number.isNaN(bit) || bit < 0 || bit > 31) errors.push(pathLabel + '.bits[' + bi + '].bit 必须为 0~31 整数')
				if (Number.isNaN(width) || width < 1 || width > 16) errors.push(pathLabel + '.bits[' + bi + '].width 必须为 1~16 整数')
				if (!label) errors.push(pathLabel + '.bits[' + bi + '].label 不能为空')
				bits.push({
					bit: Number.isNaN(bit) ? 0 : bit,
					width: Number.isNaN(width) ? 1 : width,
					label: label || ('bit' + bit),
					map: b.map && typeof b.map === 'object' ? Object.assign({}, b.map) : null,
				})
			})
		}
		return {
			name: name,
			offset: Number.isNaN(offset) ? 0 : offset,
			length: length,
			type: type,
			endian: f.endian === 'be' ? 'be' : 'le',
			scale: scale,
			decimals: decimals,
			unit: typeof f.unit === 'string' ? f.unit : '',
			format: format,
			role: role,
			section: typeof f.section === 'string' ? f.section.trim() : '',
			map: mapObj ? Object.assign({}, mapObj) : null,
			bits: bits,
		}
	}

	function validateMatchRule(m, pathLabel, errors) {
		if (!m || typeof m !== 'object' || Array.isArray(m)) {
			errors.push(pathLabel + ' 必须为对象')
			return null
		}
		const offset = parseIntStrict(m.offset)
		if (Number.isNaN(offset)) {
			errors.push(pathLabel + '.offset 必须为整数')
			return null
		}
		if (m.bytes !== undefined && m.bytes !== null && m.bytes !== '') {
			const bytes = hexToBytes(m.bytes)
			if (!bytes || !bytes.length) {
				errors.push(pathLabel + '.bytes 必须为合法非空 HEX 字节')
				return null
			}
			return { offset: offset, bytes: bytes }
		}
		const value = parseIntStrict(m.value)
		if (Number.isNaN(value) || value < 0 || value > 255) {
			errors.push(pathLabel + '.value 必须为 0~255 整数或十六进制值')
			return null
		}
		let mask = 0xff
		if (m.mask !== undefined && m.mask !== null && m.mask !== '') {
			mask = parseIntStrict(m.mask)
			if (Number.isNaN(mask) || mask < 0 || mask > 255) {
				errors.push(pathLabel + '.mask 必须为 0~255 整数')
				mask = 0xff
			}
		}
		return { offset: offset, value: value & 0xff, mask: mask & 0xff }
	}

	// ===== 设备面板声明（device）=====
	// JSON 协议用声明式映射代替函数：字段按本协议解出的字段名（from）取值，读取组的请求帧走 downlink 模板或 cmd/payloadHex 组帧，
	// 应答按分支标题（reply.title）或匹配规则（reply.match，与 frames[].match 同格式）认领。编译后交给注册表按设备面板契约清洗。
	const DEVICE_KINDS = ['number', 'enum', 'text', 'bits', 'time', 'hex', 'flag']
	const DEVICE_WIDGETS = ['metric', 'identity', 'deviceTime', 'flags', 'dayBitmap', 'kv']
	const DEVICE_KEY_RE = /^[A-Za-z0-9_.:\-]{1,48}$/
	const DEVICE_BAD_KEYS = ['__proto__', 'constructor', 'prototype']
	// 校验前先限量：超限直接报错，不裁剪（裁剪会留下指向被裁掉部分的引用）。注册表还有一道总预算（js/protocol-registry.js）
	const DEVICE_LIMITS = {
		groups: 64, fields: 512, status: 32, categories: 32, list: 128, options: 256, bits: 64,
		rules: 16, // 每组 reply.match 规则数
		ruleBytes: 64, // 单条匹配规则的字节数
		hexChars: 8192 + 4096, // 单个 rawHex / payloadHex 字符串长度（请求帧最多 4096 字节，留出分隔符）
		hexTotal: 65536, // 全部请求 HEX 与匹配规则字节串的总字符数
		nodes: 20000, // 声明里的数据节点总数
		text: 512 * 1024, // 声明里字符串总长
		depth: 8,
	}
	// 解码前先量：声明总规模（节点、文本、深度、循环），以及每组请求 HEX 与应答规则的条数和长度。任何一项超限整体报错，不解码不分配
	function devicePrecheck(dev, errors) {
		let nodes = 0
		let text = 0
		const path = typeof Set !== 'undefined' ? new Set() : null
		function walk(v, depth) {
			if (++nodes > DEVICE_LIMITS.nodes) return 'device 声明过大（数据节点超过 ' + DEVICE_LIMITS.nodes + '）'
			if (v == null) return null
			if (typeof v === 'string') { text += v.length; return text > DEVICE_LIMITS.text ? 'device 声明里的文本总长超过 ' + DEVICE_LIMITS.text + ' 字符' : null }
			if (typeof v !== 'object') return null
			if (depth > DEVICE_LIMITS.depth) return 'device 声明嵌套过深（超过 ' + DEVICE_LIMITS.depth + ' 层）'
			if (path) { if (path.has(v)) return 'device 声明里有循环引用'; path.add(v) }
			let e = null
			if (Array.isArray(v)) {
				if (v.length > DEVICE_LIMITS.nodes) e = 'device 声明里的数组过长'
				for (let i = 0; !e && i < v.length; i++) e = walk(v[i], depth + 1)
			} else {
				const ks = Object.keys(v)
				if (ks.length > DEVICE_LIMITS.nodes) e = 'device 声明里的对象键过多'
				for (let i = 0; !e && i < ks.length; i++) { text += ks[i].length; e = walk(v[ks[i]], depth + 1) }
			}
			if (path) path.delete(v)
			return e
		}
		const e = walk(dev, 0)
		if (e) { errors.push(e); return false }
		let hexTotal = 0
		let ok = true
		function checkReply(rp, replyPath) {
			if (!rp || typeof rp !== 'object' || rp.match === undefined) return
			const list = Array.isArray(rp.match) ? rp.match : [rp.match]
			if (list.length > DEVICE_LIMITS.rules) { errors.push(replyPath + '.match 超过 ' + DEVICE_LIMITS.rules + ' 条'); ok = false; return }
			list.forEach((mr, index) => {
				const bytes = mr && typeof mr === 'object' ? mr.bytes : null
				if (bytes == null || bytes === '') return
				const label = replyPath + '.match[' + index + '].bytes'
				if (typeof bytes === 'string') {
					if (bytes.length > DEVICE_LIMITS.ruleBytes * 3) { errors.push(label + ' 超过 ' + DEVICE_LIMITS.ruleBytes + ' 字节'); ok = false; return }
					hexTotal += bytes.length
				} else if (Array.isArray(bytes)) {
					if (bytes.length > DEVICE_LIMITS.ruleBytes) { errors.push(label + ' 超过 ' + DEVICE_LIMITS.ruleBytes + ' 字节'); ok = false; return }
					hexTotal += bytes.length * 2
				} else { errors.push(label + ' 必须为 HEX 字符串或字节数组'); ok = false }
			})
		}
		const groups = Array.isArray(dev.groups) ? dev.groups : []
		groups.forEach((g, i) => {
			if (!g || typeof g !== 'object') return
			const p = 'device.groups[' + i + ']'
			const rq = g.request && typeof g.request === 'object' ? g.request : null
			if (rq) {
				;['payloadHex', 'rawHex'].forEach(k => {
					const v = rq[k]
					if (v == null || v === '') return
					if (typeof v !== 'string') { errors.push(p + '.request.' + k + ' 必须为 HEX 字符串'); ok = false; return }
					if (v.length > DEVICE_LIMITS.hexChars) { errors.push(p + '.request.' + k + ' 超过 ' + DEVICE_LIMITS.hexChars + ' 字符'); ok = false; return }
					hexTotal += v.length
				})
			}
			checkReply(g.reply, p + '.reply')
		})
		;(Array.isArray(dev.writes) ? dev.writes : []).forEach((entry, index) => {
			if (!entry || !entry.reply) return
			for (const state of ['ok', 'rejected', 'processing']) checkReply(entry.reply[state], 'device.writes[' + index + '].reply.' + state)
		})
		if (ok && hexTotal > DEVICE_LIMITS.hexTotal) { errors.push('device 里请求 HEX 与应答匹配字节的总量超过 ' + DEVICE_LIMITS.hexTotal + ' 字符'); ok = false }
		return ok
	}
	function deviceKeyOk(k) { return typeof k === 'string' && DEVICE_KEY_RE.test(k) && DEVICE_BAD_KEYS.indexOf(k) < 0 }
	function ownKeys(o) { return o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : [] }
	function nullMap(src, max, pathLabel, errors) {
		const ks = ownKeys(src)
		if (ks.length > max) { errors.push(pathLabel + ' 超过 ' + max + ' 项'); return null }
		const out = Object.create(null)
		ks.forEach(k => {
			if (DEVICE_BAD_KEYS.indexOf(k) >= 0) { errors.push(pathLabel + ' 不能用 ' + k + ' 作键'); return }
			const v = src[k]
			out[k] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
		})
		return out
	}

	function defaultDeviceKind(src) {
		if (!src) return 'text'
		if (src.map) return 'enum'
		if (src.type === 'bitfield') return src.bits && src.bits.length ? 'text' : 'hex'
		if (FIXED_TYPE_SIZE[src.type]) return src.format === 'hex' ? 'hex' : 'number'
		return 'text'
	}

	// device.log：设备面板里底部「通信记录」条的初始偏好（与注册表 normalizeDevice 同一白名单，非法值丢弃）
	const DEVICE_LOG_PREFS = ['collapsed', 'strip', 'tall']
	function validateDeviceSpec(dev, ctx, errors) {
		if (dev === undefined || dev === null) return null
		if (typeof dev !== 'object' || Array.isArray(dev)) {
			errors.push('device 必须为对象')
			return null
		}
		const lim = function (v, max, what) {
			if (v !== undefined && !Array.isArray(v)) return false
			if (Array.isArray(v) && v.length > max) { errors.push(what + ' 超过 ' + max + ' 项'); return true }
			return false
		}
		// 规模先查，任何解码（HEX、匹配规则）与复制都在这之后
		if (!devicePrecheck(dev, errors)) return null
		let over = lim(dev.groups, DEVICE_LIMITS.groups, 'device.groups')
		over = lim(dev.fields, DEVICE_LIMITS.fields, 'device.fields') || over
		over = lim(dev.status, DEVICE_LIMITS.status, 'device.status') || over
		over = lim(dev.categories, DEVICE_LIMITS.categories, 'device.categories') || over
		over = lim(dev.writes, DEVICE_LIMITS.fields, 'device.writes') || over
		const rsIn = dev.readSets && typeof dev.readSets === 'object' && !Array.isArray(dev.readSets) ? dev.readSets : null
		if (rsIn) {
			over = lim(rsIn.status, DEVICE_LIMITS.list, 'device.readSets.status') || over
			over = lim(rsIn.all, DEVICE_LIMITS.list, 'device.readSets.all') || over
		}
		if (over) return null
		const out = {
			title: typeof dev.title === 'string' ? dev.title.trim().slice(0, 64) : '',
			nameKey: typeof dev.nameKey === 'string' ? dev.nameKey.trim() : '',
			timeoutMs: dev.timeoutMs == null ? 5000 : parseIntStrict(dev.timeoutMs),
			log: null,
			groups: [],
			fields: [],
			readSets: rsIn ? {
				status: (Array.isArray(rsIn.status) ? rsIn.status : []).filter(x => typeof x === 'string'),
				all: (Array.isArray(rsIn.all) ? rsIn.all : []).filter(x => typeof x === 'string'),
			} : null,
			status: [],
			categories: [],
			writes: [],
		}
		if (Number.isNaN(out.timeoutMs) || out.timeoutMs < 200 || out.timeoutMs > 60000) errors.push('device.timeoutMs 必须为 200~60000 的整数')
		// 与注册表 normalizeDevice 一致：非法值丢弃、不拒绝整份协议（校验没有非阻断的提示通道）
		if (DEVICE_LOG_PREFS.indexOf(dev.log) >= 0) out.log = dev.log
		const groupIds = []
		if (!Array.isArray(dev.groups) || (!dev.groups.length && !(Array.isArray(dev.writes) && dev.writes.length))) {
			errors.push('device.groups 必须为非空数组')
		} else {
			dev.groups.forEach((g, i) => {
				const p = 'device.groups[' + i + ']'
				if (!g || typeof g !== 'object' || Array.isArray(g)) { errors.push(p + ' 必须为对象'); return }
				const id = typeof g.id === 'string' ? g.id.trim() : ''
				if (!deviceKeyOk(id)) { errors.push(p + '.id 须为 1~48 位字母、数字或 _ . : -（不能是 __proto__ / constructor / prototype）'); return }
				if (groupIds.indexOf(id) >= 0) { errors.push(p + '.id 重复：' + id); return }
				groupIds.push(id)
				const rq = g.request && typeof g.request === 'object' && !Array.isArray(g.request) ? g.request : null
				const request = {}
				if (!rq) {
					errors.push(p + '.request 必须为对象（template 或 cmd / payloadHex / rawHex）')
				} else {
					if (typeof rq.template === 'string' && rq.template.trim()) {
						request.template = rq.template.trim()
						if (ctx.templates.indexOf(request.template) < 0) errors.push(p + '.request.template 在 downlink.templates 中不存在：' + request.template)
					}
					if (rq.cmd != null && rq.cmd !== '') {
						const c = parseIntStrict(rq.cmd)
						if (Number.isNaN(c) || c < 0 || c > 0xffff) errors.push(p + '.request.cmd 必须为整数或十六进制值')
						else request.cmd = c
					}
					;['payloadHex', 'rawHex'].forEach(k => {
						if (rq[k] == null || rq[k] === '') return
						if (!hexToBytes(rq[k])) errors.push(p + '.request.' + k + ' 必须为合法 HEX')
						else request[k] = String(rq[k])
					})
					if (!Object.keys(request).length) errors.push(p + '.request 至少要有 template、cmd、payloadHex、rawHex 之一')
				}
				const reply = {}
				const rp = g.reply && typeof g.reply === 'object' && !Array.isArray(g.reply) ? g.reply : null
				if (!rp) {
					errors.push(p + '.reply 必须为对象（title 或 match）')
				} else {
					if (typeof rp.title === 'string' && rp.title.trim()) reply.title = rp.title.trim()
					if (rp.match !== undefined) {
						const list = Array.isArray(rp.match) ? rp.match : [rp.match]
						reply.match = []
						list.forEach((mr, mi) => {
							const r = validateMatchRule(mr, p + '.reply.match[' + mi + ']', errors)
							if (r) reply.match.push(r.bytes ? { offset: r.offset, bytes: Array.from(r.bytes) } : r)
						})
					}
					if (!reply.title && !(reply.match && reply.match.length)) errors.push(p + '.reply 至少要有 title 或 match')
				}
				out.groups.push({ id: id, title: typeof g.title === 'string' && g.title.trim() ? g.title.trim() : id, request: request, reply: reply })
			})
		}
		const keys = []
		if (!Array.isArray(dev.fields) || !dev.fields.length) {
			errors.push('device.fields 必须为非空数组')
		} else {
			dev.fields.forEach((f, i) => {
				const p = 'device.fields[' + i + ']'
				if (!f || typeof f !== 'object' || Array.isArray(f)) { errors.push(p + ' 必须为对象'); return }
				const key = typeof f.key === 'string' ? f.key.trim() : ''
				if (!deviceKeyOk(key)) { errors.push(p + '.key 须为 1~48 位字母、数字或 _ . : -（不能是 __proto__ / constructor / prototype）'); return }
				if (keys.indexOf(key) >= 0) { errors.push(p + '.key 重复：' + key); return }
				const from = typeof f.from === 'string' ? f.from.trim() : ''
				const src = from && Object.prototype.hasOwnProperty.call(ctx.fieldsByName, from) ? ctx.fieldsByName[from] : null
				if (!from || !src) { errors.push(p + '.from 必须是本协议 fields / frames[].fields 里的字段名：' + from); return }
				if (f.kind != null && DEVICE_KINDS.indexOf(f.kind) < 0) errors.push(p + '.kind 不支持：' + f.kind)
				const group = typeof f.group === 'string' ? f.group.trim() : ''
				if (group && groupIds.indexOf(group) < 0) errors.push(p + '.group 不是已声明的读取组：' + group)
				if (Array.isArray(f.bits) && f.bits.length > DEVICE_LIMITS.bits) { errors.push(p + '.bits 超过 ' + DEVICE_LIMITS.bits + ' 项'); return }
				const options = f.options !== undefined && f.options !== null
					? nullMap(f.options, DEVICE_LIMITS.options, p + '.options', errors)
					: (src.map ? nullMap(src.map, DEVICE_LIMITS.options, p + '.options（来自字段 map）', errors) : null)
				keys.push(key)
				out.fields.push({
					key: key,
					name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : from,
					from: from,
					group: group || null,
					kind: DEVICE_KINDS.indexOf(f.kind) >= 0 ? f.kind : defaultDeviceKind(src),
					unit: typeof f.unit === 'string' ? f.unit : (src.unit || ''),
					decimals: f.decimals != null ? parseIntStrict(f.decimals) : src.decimals,
					digits: f.digits != null ? parseIntStrict(f.digits) : null,
					options: options,
					bits: Array.isArray(f.bits) ? f.bits.map(b => typeof b === 'string' || typeof b === 'number' ? String(b) : '') : null,
					copy: f.copy === true,
					secret: f.secret === true,
					write: validateDeviceWriteRules(f.write, p, errors),
					note: typeof f.note === 'string' ? f.note : '',
					addr: typeof f.addr === 'string' ? f.addr : '',
				})
			})
		}
		if (out.nameKey && keys.indexOf(out.nameKey) < 0) errors.push('device.nameKey 不是已声明的字段：' + out.nameKey)
		const written = new Set()
		;(Array.isArray(dev.writes) ? dev.writes : []).forEach((item, index) => {
			const path = 'device.writes[' + index + ']'
			const field = item && out.fields.find(f => f.key === item.field)
			if (!field || !field.write || written.has(field.key)) { errors.push(path + '.field 必须是唯一的可写字段 key'); return }
			written.add(field.key)
			const template = ctx.writeTemplates.find(t => t.name === item.template)
			const type = template && template.param && String(template.param.type || 'uint8').toLowerCase()
			if (!type || !/^(?:(?:u?int(?:8|16(?:le|be)|32(?:le|be)))|enum|ascii|hex|hexbytes|bcd|bcd_le|bcd_be)$/.test(type)) { errors.push(path + '.template 须引用带单参数的模板'); return }
			const reply = Object.create(null)
			for (const state of ['rejected', 'processing', 'ok']) {
				const rule = item.reply && item.reply[state]
				if (!rule && state !== 'ok') continue
				if (!rule || typeof rule !== 'object' || Array.isArray(rule)) { errors.push(path + '.reply.' + state + ' 必须为对象'); continue }
				const title = typeof rule.title === 'string' ? rule.title.trim() : ''
				const match = rule.match == null ? [] : Array.isArray(rule.match) ? rule.match : [rule.match]
				if ((!title && !match.length) || match.length > DEVICE_LIMITS.rules) { errors.push(path + '.reply.' + state + ' 须声明 title 或有限的 match'); continue }
				const rules = match.map((m, mi) => validateMatchRule(m, path + '.reply.' + state + '.match[' + mi + ']', errors)).filter(Boolean)
				if (rules.some(r => r.bytes && r.bytes.length > DEVICE_LIMITS.ruleBytes)) { errors.push(path + '.reply.match 字节数过多'); continue }
				reply[state] = { title: title, match: rules.map(r => r.bytes ? { offset: r.offset, bytes: Array.from(r.bytes) } : r) }
			}
			out.writes.push({ field: field.key, template: template.name, reply: reply })
		})
		out.fields.forEach(f => { if (f.write && !written.has(f.key)) errors.push('device 字段 ' + f.key + ' 缺少写入声明') })
		const str = v => (typeof v === 'string' ? v : '')
		;(Array.isArray(dev.status) ? dev.status : []).forEach((w, i) => {
			const p = 'device.status[' + i + ']'
			if (!w || typeof w !== 'object' || Array.isArray(w) || DEVICE_WIDGETS.indexOf(w.type) < 0) { errors.push(p + '.type 必须是 ' + DEVICE_WIDGETS.join(' / ')); return }
			if ((Array.isArray(w.keys) && w.keys.length > DEVICE_LIMITS.list) || (Array.isArray(w.sub) && w.sub.length > DEVICE_LIMITS.list)) { errors.push(p + ' 的 key 列表超过 ' + DEVICE_LIMITS.list + ' 项'); return }
			const refs = [].concat(w.key != null ? [w.key] : [], Array.isArray(w.keys) ? w.keys : [], Array.isArray(w.sub) ? w.sub : [], w.meter != null ? [w.meter] : [])
			let bad = false
			refs.forEach(k => { if (typeof k !== 'string' || keys.indexOf(k) < 0) { bad = true; errors.push(p + ' 引用了未声明的字段：' + str(k)) } })
			if (bad) return
			// 只拷约定的部件字段，不整体深拷
			const nw = { type: w.type, title: str(w.title) }
			if (w.key != null) nw.key = w.key
			if (Array.isArray(w.keys)) nw.keys = w.keys.slice()
			if (Array.isArray(w.sub)) nw.sub = w.sub.slice()
			if (w.meter != null) nw.meter = w.meter
			if (w.type === 'dayBitmap') {
				if (w.days != null) nw.days = Number(w.days)
				if (w.firstBit != null) nw.firstBit = Number(w.firstBit)
				nw.setMeans = w.setMeans === 'bad' ? 'bad' : 'ok'
				nw.setLabel = str(w.setLabel)
				nw.clearLabel = str(w.clearLabel)
			}
			out.status.push(nw)
		})
		;(Array.isArray(dev.categories) ? dev.categories : []).forEach((c, i) => {
			const p = 'device.categories[' + i + ']'
			if (!c || typeof c !== 'object' || !Array.isArray(c.keys)) { errors.push(p + ' 必须为 { id, title, keys: [] }'); return }
			if (c.keys.length > DEVICE_LIMITS.list) { errors.push(p + '.keys 超过 ' + DEVICE_LIMITS.list + ' 项'); return }
			let bad = false
			c.keys.forEach(k => { if (typeof k !== 'string' || keys.indexOf(k) < 0) { bad = true; errors.push(p + ' 引用了未声明的字段：' + str(k)) } })
			if (bad) return
			const id = typeof c.id === 'string' && deviceKeyOk(c.id) ? c.id : ('c' + i)
			out.categories.push({ id: id, title: str(c.title) || id, keys: c.keys.slice() })
		})
		return out
	}

	function validateDeviceWriteRules(write, path, errors) {
		if (write == null) return null
		if (typeof write !== 'object' || Array.isArray(write)) { errors.push(path + '.write 必须为对象'); return null }
		const out = Object.create(null)
		for (const key of ['min', 'max', 'step', 'maxLen']) {
			if (write[key] == null) continue
			if (typeof write[key] !== 'number' || !Number.isFinite(write[key]) || (key === 'step' && write[key] <= 0) || (key === 'maxLen' && (!Number.isInteger(write[key]) || write[key] < 0 || write[key] > 2048))) errors.push(path + '.write.' + key + ' 不是有效约束')
			else out[key] = write[key]
		}
		if (out.min > out.max) errors.push(path + '.write.min 大于 max')
		for (const key of ['hint', 'confirm']) if (typeof write[key] === 'string') out[key] = write[key].slice(0, 200)
		if (write.pattern != null) {
			const pattern = write.pattern
			const simple = /^\^?(?:\[[^\[\]\\]{1,64}\]|\\[dsw]|[a-zA-Z0-9 _:-])(?:[+*?]|\{\d{1,4}(?:,\d{0,4})?\})?\$?$/
			try {
				if (typeof pattern !== 'string' || !simple.test(pattern)) throw new Error('仅支持单一字符组或字符及其量词')
				new RegExp(pattern)
				out.pattern = pattern
			} catch (error) { errors.push(path + '.write.pattern：' + error.message) }
		}
		if (write.options != null) {
			if (typeof write.options !== 'object' || Array.isArray(write.options) || Object.keys(write.options).length > DEVICE_LIMITS.options) errors.push(path + '.write.options 无效或选项过多')
			else {
				out.options = Object.create(null)
				Object.keys(write.options).forEach(key => {
					if (!deviceKeyOk(key) || typeof write.options[key] !== 'string') errors.push(path + '.write.options 含非法选项')
					else out.options[key] = write.options[key].slice(0, 64)
				})
			}
		}
		return out
	}

	function validateSpec(spec) {
		const errors = []
		if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
			return { ok: false, errors: ['协议定义必须为 JSON 对象'] }
		}
		const schemaVersion = spec.schemaVersion == null ? 1 : spec.schemaVersion
		if (schemaVersion !== 1) {
			errors.push('schemaVersion 仅支持 1')
		}

		const id = typeof spec.id === 'string' ? spec.id.trim() : ''
		if (!id) {
			errors.push('id 不能为空')
		} else if (!ID_RE.test(id)) {
			errors.push('id 须为小写字母或数字开头，仅含小写字母、数字、下划线或连字符，长度 1~48')
		} else if (getReservedIds().has(id)) {
			errors.push('id "' + id + '" 为系统保留内置协议 ID，不可占用')
		}

		const name = typeof spec.name === 'string' ? spec.name.trim() : ''
		if (!name) {
			errors.push('name 不能为空')
		} else if (name.length > 48) {
			errors.push('name 长度不能超过 48 个字符')
		}

		const version = spec.version == null ? '1.0.0' : String(spec.version).trim()
		if (version.length > 32) errors.push('version 长度不能超过 32 个字符')
		const description = spec.description == null ? '' : String(spec.description).trim()
		if (description.length > 256) errors.push('description 长度不能超过 256 个字符')

		// framing
		const fr = spec.framing
		let normFraming = null
		if (!fr || typeof fr !== 'object' || Array.isArray(fr)) {
			errors.push('framing 必须为对象')
		} else {
			const head = hexToBytes(fr.head)
			if (!head || head.length < 1 || head.length > 8) {
				errors.push('framing.head 必须为 1~8 字节的合法 HEX')
			}
			const preamble = fr.preamble ? hexToBytes(fr.preamble) : new Uint8Array(0)
			if (!preamble || preamble.length > 16) {
				errors.push('framing.preamble 必须为 0~16 字节的合法 HEX')
			}
			const tail = fr.tail ? hexToBytes(fr.tail) : new Uint8Array(0)
			if (!tail || tail.length > 8) {
				errors.push('framing.tail 必须为 0~8 字节的合法 HEX')
			}
			const headLen = head ? head.length : 0
			const tailLen = tail ? tail.length : 0

			let fixedLength = null
			if (fr.fixedLength !== undefined && fr.fixedLength !== null && fr.fixedLength !== '') {
				fixedLength = parseIntStrict(fr.fixedLength)
				if (Number.isNaN(fixedLength) || fixedLength < Math.max(1, headLen + tailLen) || fixedLength > 4096) {
					errors.push('framing.fixedLength 必须为 ≥ 帧头+帧尾长度 且 ≤ 4096 的整数')
				}
			}

			let lengthDesc = null
			if (fr.length !== undefined && fr.length !== null) {
				if (typeof fr.length !== 'object' || Array.isArray(fr.length)) {
					errors.push('framing.length 必须为对象')
				} else {
					const lOff = parseIntStrict(fr.length.offset)
					const lSize = fr.length.size == null ? 1 : parseIntStrict(fr.length.size)
					const lEndian = fr.length.endian == null ? 'le' : String(fr.length.endian).toLowerCase()
					const lDelta = fr.length.totalDelta == null ? 0 : parseIntStrict(fr.length.totalDelta)
					if (Number.isNaN(lOff) || lOff < 0) errors.push('framing.length.offset 必须为非负整数')
					if (lSize !== 1 && lSize !== 2) errors.push('framing.length.size 仅支持 1 或 2')
					if (lEndian !== 'le' && lEndian !== 'be') errors.push('framing.length.endian 仅支持 "le" 或 "be"')
					if (Number.isNaN(lDelta)) errors.push('framing.length.totalDelta 必须为整数')
					lengthDesc = {
						offset: Number.isNaN(lOff) ? 0 : lOff,
						size: lSize === 2 ? 2 : 1,
						endian: lEndian === 'be' ? 'be' : 'le',
						totalDelta: Number.isNaN(lDelta) ? 0 : lDelta,
					}
				}
			}

			if (fixedLength == null && !lengthDesc && tailLen === 0) {
				errors.push('framing 至少需要配置 fixedLength、length 或 tail 之一以确定帧边界')
			}

			let minLength = fr.minLength == null || fr.minLength === '' ? null : parseIntStrict(fr.minLength)
			if (minLength !== null && (Number.isNaN(minLength) || minLength < 1)) {
				errors.push('framing.minLength 必须为正整数')
			}
			let maxLength = fr.maxLength == null || fr.maxLength === '' ? 4096 : parseIntStrict(fr.maxLength)
			if (Number.isNaN(maxLength) || maxLength < 1 || maxLength > 65536) {
				errors.push('framing.maxLength 必须为 1~65536 的整数')
			}
			const autoMin = Math.max(
				headLen + tailLen,
				lengthDesc ? lengthDesc.offset + lengthDesc.size + tailLen : 0,
				fixedLength || 0
			)
			if (minLength === null) minLength = Math.max(1, autoMin)
			if (!Number.isNaN(maxLength) && minLength > maxLength) {
				errors.push('framing.minLength 不能大于 framing.maxLength')
			}

			normFraming = {
				preamble: preamble || new Uint8Array(0),
				preambleHex: bytesToHex(preamble || []),
				head: head || new Uint8Array(0),
				headHex: bytesToHex(head || []),
				tail: tail || new Uint8Array(0),
				tailHex: bytesToHex(tail || []),
				fixedLength: fixedLength,
				length: lengthDesc,
				minLength: minLength,
				maxLength: Number.isNaN(maxLength) ? 4096 : maxLength,
			}
		}

		// checksum
		const tailLen = normFraming ? normFraming.tail.length : 0
		let normChecksum = { algorithm: 'none', size: 0, endian: 'le', start: 0, end: 0, offset: 0 }
		if (spec.checksum !== undefined && spec.checksum !== null) {
			if (typeof spec.checksum !== 'object' || Array.isArray(spec.checksum)) {
				errors.push('checksum 必须为对象')
			} else {
				const alg = String(spec.checksum.algorithm || 'none').toLowerCase()
				if (CHECKSUM_ALGORITHMS.indexOf(alg) === -1) {
					errors.push('checksum.algorithm 不支持：' + spec.checksum.algorithm)
				}
				const size = sizeOfChecksum(alg)
				const endian = spec.checksum.endian == null ? 'le' : String(spec.checksum.endian).toLowerCase()
				if (endian !== 'le' && endian !== 'be') {
					errors.push('checksum.endian 仅支持 "le" 或 "be"')
				}
				const start = spec.checksum.start == null ? 0 : parseIntStrict(spec.checksum.start)
				const offset = spec.checksum.offset == null ? -(size + tailLen) : parseIntStrict(spec.checksum.offset)
				const end = spec.checksum.end == null ? offset : parseIntStrict(spec.checksum.end)
				if (Number.isNaN(start)) errors.push('checksum.start 必须为整数')
				if (Number.isNaN(end)) errors.push('checksum.end 必须为整数')
				if (Number.isNaN(offset)) errors.push('checksum.offset 必须为整数')
				normChecksum = {
					algorithm: alg,
					size: size,
					endian: endian === 'be' ? 'be' : 'le',
					start: Number.isNaN(start) ? 0 : start,
					end: Number.isNaN(end) ? offset : end,
					offset: Number.isNaN(offset) ? -(size + tailLen) : offset,
				}
				if (spec.checksum.poly != null) {
					const poly = parseIntStrict(spec.checksum.poly)
					if (Number.isNaN(poly)) errors.push('checksum.poly 必须为整数')
					else normChecksum.poly = poly
				}
				if (spec.checksum.init != null) {
					const init = parseIntStrict(spec.checksum.init)
					if (Number.isNaN(init)) errors.push('checksum.init 必须为整数')
					else normChecksum.init = init
				}
				if (spec.checksum.xorOut != null) {
					const xorOut = parseIntStrict(spec.checksum.xorOut)
					if (Number.isNaN(xorOut)) errors.push('checksum.xorOut 必须为整数')
					else normChecksum.xorOut = xorOut
				}
				if (spec.checksum.refIn != null) normChecksum.refIn = !!spec.checksum.refIn
				if (spec.checksum.refOut != null) normChecksum.refOut = !!spec.checksum.refOut
			}
		}

		if (normFraming && normChecksum.size > 0) {
			const minRequired = normFraming.head.length + normChecksum.size + normFraming.tail.length
			if (normFraming.fixedLength != null && normFraming.fixedLength < minRequired) {
				errors.push('framing.fixedLength 小于 帧头 + 校验位 + 帧尾 的最小长度')
			}
		}

		// common fields
		const normFields = []
		if (spec.fields !== undefined) {
			if (!Array.isArray(spec.fields)) {
				errors.push('fields 必须为数组')
			} else {
				spec.fields.forEach((f, i) => {
					const nf = validateFieldSpec(f, 'fields[' + i + ']', errors)
					if (nf) normFields.push(nf)
				})
			}
		}

		// frames
		const normFrames = []
		if (spec.frames !== undefined) {
			if (!Array.isArray(spec.frames)) {
				errors.push('frames 必须为数组')
			} else {
				spec.frames.forEach((fm, i) => {
					const p = 'frames[' + i + ']'
					if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
						errors.push(p + ' 必须为对象')
						return
					}
					const rules = []
					if (Array.isArray(fm.match)) {
						if (!fm.match.length) errors.push(p + '.match 数组不能为空')
						fm.match.forEach((mr, mi) => {
							const r = validateMatchRule(mr, p + '.match[' + mi + ']', errors)
							if (r) rules.push(r)
						})
					} else {
						const r = validateMatchRule(fm.match, p + '.match', errors)
						if (r) rules.push(r)
					}
					const dir = fm.dir === 'up' || fm.dir === 'down' ? fm.dir : ''
					const fFields = []
					if (fm.fields !== undefined) {
						if (!Array.isArray(fm.fields)) errors.push(p + '.fields 必须为数组')
						else fm.fields.forEach((f, fi) => {
							const nf = validateFieldSpec(f, p + '.fields[' + fi + ']', errors)
							if (nf) fFields.push(nf)
						})
					}
					normFrames.push({
						match: rules,
						title: typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : name,
						code: fm.code == null ? '' : String(fm.code).trim(),
						dir: dir,
						fields: fFields,
					})
				})
			}
		}

		// downlink
		let normDownlink = null
		if (spec.downlink !== undefined && spec.downlink !== null) {
			if (typeof spec.downlink !== 'object' || Array.isArray(spec.downlink)) {
				errors.push('downlink 必须为对象')
			} else {
				const dl = spec.downlink
				const funcTabs = []
				if (Array.isArray(dl.funcTabs)) {
					dl.funcTabs.forEach((t, ti) => {
						if (!t || typeof t !== 'object') {
							errors.push('downlink.funcTabs[' + ti + '] 必须为对象')
							return
						}
						const code = t.code == null ? '' : String(t.code).trim()
						const label = t.label == null ? code : String(t.label).trim()
						if (!code) errors.push('downlink.funcTabs[' + ti + '].code 不能为空')
						else funcTabs.push({ code: code, label: label || code })
					})
				}
				const defaultHdrSize = normFraming
					? Math.max(
						normFraming.head.length,
						normFraming.length ? normFraming.length.offset + normFraming.length.size : 0
					)
					: 0
				const headerSize = dl.headerSize == null ? defaultHdrSize : parseIntStrict(dl.headerSize)
				if (Number.isNaN(headerSize) || headerSize < 0) errors.push('downlink.headerSize 必须为非负整数')
				const cmdOffset = dl.cmdOffset == null ? null : parseIntStrict(dl.cmdOffset)
				if (cmdOffset !== null && (Number.isNaN(cmdOffset) || cmdOffset < 0)) {
					errors.push('downlink.cmdOffset 必须为非负整数')
				}
				const cmdSize = dl.cmdSize == null ? 1 : parseIntStrict(dl.cmdSize)
				if (cmdSize !== 1 && cmdSize !== 2) errors.push('downlink.cmdSize 仅支持 1 或 2')
				const cmdEndian = dl.cmdEndian === 'be' ? 'be' : 'le'
				const payloadOffset = dl.payloadOffset == null ? (Number.isNaN(headerSize) ? 0 : headerSize) : parseIntStrict(dl.payloadOffset)
				if (Number.isNaN(payloadOffset) || payloadOffset < 0) errors.push('downlink.payloadOffset 必须为非负整数')
				const fixedBytes = dl.fixedBytes ? hexToBytes(dl.fixedBytes) : null
				if (dl.fixedBytes && !fixedBytes) errors.push('downlink.fixedBytes 必须为合法 HEX')

				const templates = []
				if (dl.templates !== undefined) {
					if (!Array.isArray(dl.templates)) {
						errors.push('downlink.templates 必须为数组')
					} else {
						dl.templates.forEach((tpl, ti) => {
							const p = 'downlink.templates[' + ti + ']'
							if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) {
								errors.push(p + ' 必须为对象')
								return
							}
							const tName = typeof tpl.name === 'string' ? tpl.name.trim() : ''
							if (!tName) errors.push(p + '.name 不能为空')
							let cmd = null
							if (tpl.cmd !== undefined && tpl.cmd !== null && tpl.cmd !== '') {
								cmd = parseIntStrict(tpl.cmd)
								if (Number.isNaN(cmd) || cmd < 0 || cmd > 0xffff) errors.push(p + '.cmd 必须为合法整数或十六进制值')
							}
							const tFixed = tpl.fixedBytes ? hexToBytes(tpl.fixedBytes) : null
							if (tpl.fixedBytes && !tFixed) errors.push(p + '.fixedBytes 必须为合法 HEX')
							const tPayload = tpl.payload ? hexToBytes(tpl.payload) : null
							if (tpl.payload && !tPayload) errors.push(p + '.payload 必须为合法 HEX')
							templates.push({
								name: tName,
								group: typeof tpl.group === 'string' && tpl.group.trim() ? tpl.group.trim() : '常用指令',
								func: tpl.func == null ? '' : String(tpl.func).trim(),
								desc: typeof tpl.desc === 'string' ? tpl.desc.trim() : '',
								cmd: cmd,
								fixedBytes: tFixed,
								payload: tPayload,
								payloadHex: tPayload ? bytesToHex(tPayload) : '',
								param: tpl.param && typeof tpl.param === 'object' ? JSON.parse(JSON.stringify(tpl.param)) : null,
								preamble: tpl.preamble,
							})
						})
					}
				}
				normDownlink = {
					funcTabs: funcTabs,
					headerSize: Number.isNaN(headerSize) ? defaultHdrSize : headerSize,
					cmdOffset: cmdOffset,
					cmdSize: cmdSize === 2 ? 2 : 1,
					cmdEndian: cmdEndian,
					payloadOffset: Number.isNaN(payloadOffset) ? defaultHdrSize : payloadOffset,
					fixedBytes: fixedBytes,
					preamble: dl.preamble,
					templates: templates,
				}
			}
		}

		// device（设备面板）：字段按本协议字段名引用，模板按 downlink.templates 的名字引用
		const fieldsByName = Object.create(null)
		normFields.forEach(f => { fieldsByName[f.name] = f })
		normFrames.forEach(fm => fm.fields.forEach(f => { if (!Object.prototype.hasOwnProperty.call(fieldsByName, f.name)) fieldsByName[f.name] = f }))
		const normDevice = validateDeviceSpec(spec.device, {
			fieldsByName: fieldsByName,
			templates: normDownlink && normDownlink.templates ? normDownlink.templates.map(t => t.name) : [],
			writeTemplates: normDownlink && normDownlink.templates ? normDownlink.templates : [],
		}, errors)

		if (errors.length) return { ok: false, errors: errors }

		const normalized = {
			schemaVersion: 1,
			id: id,
			name: name,
			version: version,
			description: description,
			framing: normFraming,
			checksum: normChecksum,
			fields: normFields,
			frames: normFrames,
			downlink: normDownlink,
			device: normDevice,
		}
		return { ok: true, errors: [], normalized: normalized }
	}

	// ===== 字段解码与参数编码 =====
	function decodeBcd(slice, bigEndian) {
		let digits = ''
		let valid = true
		const start = bigEndian ? 0 : slice.length - 1
		const step = bigEndian ? 1 : -1
		for (let count = 0, idx = start; count < slice.length; count++, idx += step) {
			const b = slice[idx]
			const hi = (b >>> 4) & 0x0f
			const lo = b & 0x0f
			if (hi > 9 || lo > 9) valid = false
			digits += hi.toString(16).toUpperCase() + lo.toString(16).toUpperCase()
		}
		return { valid: valid, text: valid ? digits : '(非法BCD: ' + bytesToHex(slice) + ')' }
	}

	function encodeBcd(val, byteLen, bigEndian) {
		const raw = String(val == null ? '' : val).replace(/\s+/g, '')
		if (!/^\d*$/.test(raw)) throw new Error('BCD 参数仅允许十进制数字')
		const len = byteLen || Math.max(1, Math.ceil(raw.length / 2))
		const digits = raw.padStart(len * 2, '0').slice(-(len * 2))
		const out = new Uint8Array(len)
		for (let i = 0; i < len; i++) {
			const hi = parseInt(digits[i * 2], 10)
			const lo = parseInt(digits[i * 2 + 1], 10)
			const idx = bigEndian ? i : (len - 1 - i)
			out[idx] = (hi << 4) | lo
		}
		return out
	}

	function encodeParamValue(param, val) {
		if (val instanceof Uint8Array) return val.slice()
		if (Array.isArray(val) && (!param || param.type !== 'multi')) return Uint8Array.from(val)
		if (!param) {
			if (typeof val === 'string') {
				const b = hexToBytes(val)
				if (!b) throw new Error('载荷 HEX 格式非法')
				return b
			}
			return new Uint8Array(0)
		}
		const t = String(param.type || 'uint8').toLowerCase()
		if (t === 'multi' && Array.isArray(param.fields)) {
			const parts = []
			const srcObj = (val && typeof val === 'object' && !Array.isArray(val)) ? val : {}
			param.fields.forEach((sub, idx) => {
				const key = sub.key || sub.name || String(idx)
				const subVal = Array.isArray(val) ? val[idx] : (srcObj[key] != null ? srcObj[key] : sub.default)
				parts.push(encodeParamValue(sub, subVal))
			})
			let total = 0
			parts.forEach(p => { total += p.length })
			const out = new Uint8Array(total)
			let off = 0
			parts.forEach(p => { out.set(p, off); off += p.length })
			return out
		}
		if (t === 'hex' || t === 'hexbytes') {
			const b = hexToBytes(val == null ? (param.default || '') : val)
			if (!b) throw new Error((param.label || '参数') + ' HEX 格式非法')
			return b
		}
		if (t === 'ascii') {
			const s = String(val == null ? (param.default || '') : val)
			const len = param.length ? Number(param.length) : s.length
			const out = new Uint8Array(len)
			for (let i = 0; i < Math.min(len, s.length); i++) out[i] = s.charCodeAt(i) & 0xff
			return out
		}
		if (t === 'bcd' || t === 'bcd_le') return encodeBcd(val == null ? (param.default || '0') : val, param.length, false)
		if (t === 'bcd_be') return encodeBcd(val == null ? (param.default || '0') : val, param.length, true)

		const n = parseNumber(val == null ? param.default : val)
		if (!Number.isFinite(n)) throw new Error((param.label || '参数') + ' 需为有效数字')
		const scale = param.scale ? Number(param.scale) : 1
		const raw = Math.round(scale && scale !== 1 ? (n / scale) : n)
		if (t === 'uint8' || t === 'int8' || t === 'enum') {
			const out = new Uint8Array(1)
			out[0] = raw & 0xff
			return out
		}
		if (t === 'uint16le' || t === 'int16le') {
			const out = new Uint8Array(2)
			writeUInt(out, 0, 2, raw, 'le')
			return out
		}
		if (t === 'uint16be' || t === 'int16be') {
			const out = new Uint8Array(2)
			writeUInt(out, 0, 2, raw, 'be')
			return out
		}
		if (t === 'uint32le' || t === 'int32le') {
			const out = new Uint8Array(4)
			writeUInt(out, 0, 4, raw, 'le')
			return out
		}
		if (t === 'uint32be' || t === 'int32be') {
			const out = new Uint8Array(4)
			writeUInt(out, 0, 4, raw, 'be')
			return out
		}
		throw new Error('不支持的参数编码类型：' + t)
	}

	function decodeField(f, frame, payloadEnd) {
		const absOff = resolveOffset(frame.length, f.offset)
		let byteLen = f.length === 'rest' ? Math.max(0, payloadEnd - absOff) : f.length
		if (absOff < 0 || absOff + byteLen > frame.length) {
			return {
				ok: false,
				name: f.name,
				offset: absOff,
				length: byteLen,
				formatted: '(越界)',
				hint: '',
				kind: 'bad',
				section: f.section,
				role: f.role,
				error: '字段 "' + f.name + '" 超出帧长度',
			}
		}
		const slice = frame.subarray(absOff, absOff + byteLen)
		let value = null
		let formatted = ''
		let hint = ''
		let kind = ''
		let bitsDecoded = null

		if (f.type === 'hex') {
			value = bytesToHex(slice)
			formatted = value || '(空)'
		} else if (f.type === 'ascii') {
			let s = ''
			for (let i = 0; i < slice.length; i++) {
				const c = slice[i]
				if (c === 0) break
				s += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : '.'
			}
			value = s
			formatted = s
		} else if (f.type === 'bcd' || f.type === 'bcd_le' || f.type === 'bcd_be') {
			const r = decodeBcd(slice, f.type === 'bcd_be')
			value = r.text
			formatted = r.text
			if (!r.valid) kind = 'bad'
		} else if (f.type === 'bitfield') {
			const rawInt = readUInt(frame, absOff, byteLen, f.endian)
			value = rawInt
			const hexStr = '0x' + rawInt.toString(16).toUpperCase().padStart(byteLen * 2, '0')
			bitsDecoded = {}
			if (f.bits && f.bits.length) {
				const parts = []
				f.bits.forEach(b => {
					const mask = (1 << b.width) - 1
					const v = (rawInt >>> b.bit) & mask
					const txt = (b.map && b.map[String(v)] != null) ? String(b.map[String(v)]) : String(v)
					bitsDecoded[b.label] = { value: v, text: txt }
					parts.push(b.label + ':' + txt)
				})
				formatted = parts.join(' · ')
				hint = hexStr
			} else {
				formatted = hexStr
			}
		} else {
			let num = 0
			switch (f.type) {
				case 'uint8': num = frame[absOff]; break
				case 'int8': num = (frame[absOff] << 24) >> 24; break
				case 'uint16le': num = readUInt(frame, absOff, 2, 'le'); break
				case 'uint16be': num = readUInt(frame, absOff, 2, 'be'); break
				case 'int16le': num = (readUInt(frame, absOff, 2, 'le') << 16) >> 16; break
				case 'int16be': num = (readUInt(frame, absOff, 2, 'be') << 16) >> 16; break
				case 'uint32le': num = readUInt(frame, absOff, 4, 'le'); break
				case 'uint32be': num = readUInt(frame, absOff, 4, 'be'); break
				case 'int32le': num = readUInt(frame, absOff, 4, 'le') | 0; break
				case 'int32be': num = readUInt(frame, absOff, 4, 'be') | 0; break
				default: num = frame[absOff]
			}
			const scaled = f.scale != null ? num * f.scale : num
			value = scaled
			const hexStr = '0x' + (num >>> 0).toString(16).toUpperCase().padStart(byteLen * 2, '0')
			let numText = ''
			if (f.format === 'hex') {
				numText = hexStr
			} else if (f.decimals != null) {
				numText = scaled.toFixed(f.decimals)
			} else if (f.scale != null) {
				numText = Number(scaled.toPrecision(12)).toString()
			} else {
				numText = String(num)
			}
			if (f.map) {
				const mapped = f.map[String(num)] != null
					? f.map[String(num)]
					: (f.map[hexStr] != null ? f.map[hexStr] : (f.map[hexStr.toLowerCase()] != null ? f.map[hexStr.toLowerCase()] : null))
				if (mapped != null) {
					formatted = String(mapped)
					hint = numText
				} else {
					formatted = f.unit ? (numText + ' ' + f.unit) : numText
				}
			} else {
				formatted = f.unit ? (numText + ' ' + f.unit) : numText
			}
		}

		return {
			ok: true,
			name: f.name,
			offset: absOff,
			length: byteLen,
			raw: slice.slice(),
			value: value,
			formatted: formatted,
			hint: hint,
			unit: f.unit,
			kind: kind,
			section: f.section,
			role: f.role,
			bits: bitsDecoded,
		}
	}

	function matchFrameRule(frame, rules) {
		if (!rules || !rules.length) return false
		for (let i = 0; i < rules.length; i++) {
			const r = rules[i]
			const off = resolveOffset(frame.length, r.offset)
			if (r.bytes) {
				if (!matchesAt(frame, off, r.bytes)) return false
			} else {
				if (off < 0 || off >= frame.length) return false
				if ((frame[off] & r.mask) !== (r.value & r.mask)) return false
			}
		}
		return true
	}

	// ===== 编译器 =====
	function compile(rawSpec) {
		const checked = validateSpec(rawSpec)
		if (!checked.ok) {
			throw new Error('JSON 协议校验失败：' + checked.errors.join('；'))
		}
		const spec = checked.normalized
		const fr = spec.framing
		const cs = spec.checksum
		const dl = spec.downlink

		function findFrame(bytes) {
			const buf = toU8(bytes)
			if (buf.length < fr.minLength) {
				return { found: false, offset: 0, length: buf.length, frame: buf, prefix: 0, suffix: 0 }
			}
			for (let pos = 0; pos <= buf.length - fr.head.length; pos++) {
				if (!matchesAt(buf, pos, fr.head)) continue
				const candidates = []
				if (fr.fixedLength != null) {
					if (pos + fr.fixedLength <= buf.length) candidates.push(fr.fixedLength)
				} else if (fr.length) {
					if (pos + fr.length.offset + fr.length.size <= buf.length) {
						const lv = readUInt(buf, pos + fr.length.offset, fr.length.size, fr.length.endian)
						const total = lv + fr.length.totalDelta
						if (total >= fr.minLength && total <= fr.maxLength && pos + total <= buf.length) {
							candidates.push(total)
						}
					}
				} else if (fr.tail.length > 0) {
					const minTailPos = pos + Math.max(fr.head.length, fr.minLength - fr.tail.length)
					const maxTailPos = Math.min(buf.length, pos + fr.maxLength) - fr.tail.length
					for (let tPos = minTailPos; tPos <= maxTailPos; tPos++) {
						if (matchesAt(buf, tPos, fr.tail)) {
							candidates.push((tPos + fr.tail.length) - pos)
						}
					}
				}

				for (let ci = 0; ci < candidates.length; ci++) {
					const total = candidates[ci]
					const cand = buf.subarray(pos, pos + total)
					if (fr.tail.length > 0 && !matchesAt(cand, total - fr.tail.length, fr.tail)) continue
					if (cs.algorithm !== 'none') {
						const v = verifyChecksumDetail(cand, cs, fr.tail.length)
						if (!v.ok) continue
					}
					return {
						found: true,
						frame: cand.slice(),
						offset: pos,
						length: total,
						prefix: pos,
						suffix: buf.length - pos - total,
					}
				}
			}
			return { found: false, offset: 0, length: buf.length, frame: buf, prefix: 0, suffix: 0 }
		}

		function parseFrame(bytes) {
			const raw = toU8(bytes)
			const errors = []
			const byteRegions = []
			let baseOffset = 0

			if (raw.length < fr.head.length) {
				return {
					ok: false,
					matchedHead: false,
					crcOk: false,
					title: spec.name,
					code: '',
					dir: '',
					subject: null,
					fields: {},
					sections: [],
					byteRegions: [],
					errors: ['帧长度不足（少于帧头长度）'],
					raw: raw,
				}
			}

			// 兼容前导码：允许输入以一个或多个 preamble 开头紧接 head
			if (!matchesAt(raw, 0, fr.head) && fr.preamble.length > 0) {
				let pOff = 0
				while (pOff + fr.preamble.length <= raw.length && matchesAt(raw, pOff, fr.preamble)) {
					pOff += fr.preamble.length
				}
				if (pOff > 0 && matchesAt(raw, pOff, fr.head)) {
					baseOffset = pOff
					byteRegions.push({ offset: 0, length: pOff, grp: '前导', tip: '前导码 ' + bytesToHex(raw.subarray(0, pOff)) })
				}
			}

			if (!matchesAt(raw, baseOffset, fr.head)) {
				return {
					ok: false,
					matchedHead: false,
					crcOk: false,
					title: spec.name,
					code: '',
					dir: '',
					subject: null,
					fields: {},
					sections: [],
					byteRegions: [],
					errors: ['帧头不匹配（期望 ' + fr.headHex + '）'],
					raw: raw,
				}
			}

			const frame = baseOffset > 0 ? raw.subarray(baseOffset) : raw
			byteRegions.push({ offset: baseOffset, length: fr.head.length, grp: '帧头', tip: '帧头 ' + fr.headHex })

			if (frame.length < fr.minLength) {
				errors.push('帧长度不足：实际 ' + frame.length + ' 字节，最小 ' + fr.minLength + ' 字节')
			}
			if (frame.length > fr.maxLength) {
				errors.push('帧长度超限：实际 ' + frame.length + ' 字节，最大 ' + fr.maxLength + ' 字节')
			}
			if (fr.fixedLength != null && frame.length !== fr.fixedLength) {
				errors.push('定长帧长度不符：期望 ' + fr.fixedLength + ' 字节，实际 ' + frame.length + ' 字节')
			}
			if (fr.length) {
				if (fr.length.offset + fr.length.size <= frame.length) {
					const lv = readUInt(frame, fr.length.offset, fr.length.size, fr.length.endian)
					const expectedTotal = lv + fr.length.totalDelta
					byteRegions.push({
						offset: baseOffset + fr.length.offset,
						length: fr.length.size,
						grp: '长度',
						tip: '长度字段 = ' + lv + '（总帧长 ' + expectedTotal + ' B）',
					})
					if (expectedTotal !== frame.length) {
						errors.push('长度字段与帧长不符：期望 ' + expectedTotal + ' 字节，实际 ' + frame.length + ' 字节')
					}
				} else {
					errors.push('帧长度不足，无法读取长度字段')
				}
			}
			if (fr.tail.length > 0) {
				const tailOff = frame.length - fr.tail.length
				if (tailOff >= fr.head.length && matchesAt(frame, tailOff, fr.tail)) {
					byteRegions.push({ offset: baseOffset + tailOff, length: fr.tail.length, grp: '帧尾', tip: '帧尾 ' + fr.tailHex })
				} else {
					errors.push('帧尾不匹配（期望 ' + fr.tailHex + '）')
				}
			}

			// 校验和
			const csInfo = verifyChecksumDetail(frame, cs, fr.tail.length)
			const crcOk = csInfo.ok
			if (csInfo.enabled) {
				if (!csInfo.outOfRange) {
					const expHex = '0x' + csInfo.expected.toString(16).toUpperCase().padStart(csInfo.size * 2, '0')
					const actHex = '0x' + csInfo.actual.toString(16).toUpperCase().padStart(csInfo.size * 2, '0')
					byteRegions.push({
						offset: baseOffset + csInfo.offset,
						length: csInfo.size,
						grp: '校验',
						tip: csInfo.algorithm + ' ' + (crcOk ? '通过 ' + actHex : '失败（实际 ' + actHex + '，期望 ' + expHex + '）'),
					})
					if (!crcOk) {
						errors.push('校验失败（' + csInfo.algorithm + '：实际 ' + actHex + '，期望 ' + expHex + '）')
					}
				} else {
					errors.push('校验位偏移超出帧长度')
				}
			}

			// 匹配帧分支
			let matchedBranch = null
			for (let i = 0; i < spec.frames.length; i++) {
				if (matchFrameRule(frame, spec.frames[i].match)) {
					matchedBranch = spec.frames[i]
					break
				}
			}

			const payloadEnd = (csInfo.enabled && !csInfo.outOfRange && csInfo.offset >= 0)
				? Math.min(csInfo.offset, frame.length - fr.tail.length)
				: (frame.length - fr.tail.length)

			const allDefs = spec.fields.concat(matchedBranch ? matchedBranch.fields : [])
			const fields = {}
			const secMap = new Map()
			const sections = []
			let subject = null
			let cmdCode = matchedBranch && matchedBranch.code ? matchedBranch.code : ''

			function pushPair(secTitle, pair) {
				const key = secTitle || ''
				let sec = secMap.get(key)
				if (!sec) {
					sec = { title: key, pairs: [] }
					secMap.set(key, sec)
					sections.push(sec)
				}
				sec.pairs.push(pair)
			}

			allDefs.forEach(def => {
				const d = decodeField(def, frame, payloadEnd)
				fields[def.name] = d
				if (!d.ok && d.error) errors.push(d.error)
				if (d.ok && d.length > 0) {
					byteRegions.push({
						offset: baseOffset + d.offset,
						length: d.length,
						grp: def.name,
						tip: def.name + ' = ' + d.formatted + (d.hint ? ' (' + d.hint + ')' : ''),
					})
				}
				if (d.role === 'subject' && d.ok) {
					subject = { label: def.name, value: d.formatted }
				}
				if (d.role === 'cmd' && !cmdCode && d.ok) {
					cmdCode = d.hint || d.formatted
				}
				pushPair(d.section || '', [def.name, d.formatted, d.hint || '', d.kind || ''])
			})

			return {
				ok: errors.length === 0,
				matchedHead: true,
				crcOk: crcOk,
				checksumEnabled: csInfo.enabled,
				checksumAlgorithm: csInfo.algorithm,
				title: matchedBranch ? matchedBranch.title : spec.name,
				code: cmdCode,
				dir: matchedBranch ? matchedBranch.dir : '',
				subject: subject,
				fields: fields,
				sections: sections,
				byteRegions: byteRegions,
				errors: errors,
				raw: raw,
			}
		}

		function byteMap(parsed) {
			if (!parsed || !parsed.raw) return []
			const raw = toU8(parsed.raw)
			const map = new Array(raw.length).fill('')
			const regions = parsed.byteRegions || []
			for (let i = 0; i < regions.length; i++) {
				const r = regions[i]
				for (let k = 0; k < r.length; k++) {
					const idx = r.offset + k
					if (idx >= 0 && idx < raw.length) {
						map[idx] = { grp: r.grp, tip: r.tip }
					}
				}
			}
			return map
		}

		function logView(parsed) {
			if (!parsed || !parsed.matchedHead) return null
			const badges = []
			if (parsed.checksumEnabled) {
				badges.push({
					text: parsed.crcOk ? 'CRC ✓' : 'CRC ✗',
					kind: parsed.crcOk ? 'ok' : 'bad',
					title: parsed.checksumAlgorithm + (parsed.crcOk ? ' 校验通过' : ' 校验失败'),
				})
			}
			const sections = (parsed.sections || [])
				.filter(s => s && s.pairs && s.pairs.length)
				.map(s => ({
					title: s.title || '',
					pairs: s.pairs.map(p => [p[0], p[1], p[2] || '', p[3] || '']),
				}))
			const model = {
				title: parsed.title || spec.name,
				code: parsed.code || '',
				dir: parsed.dir || '',
				badges: badges,
				sections: sections,
				errors: (parsed.errors || []).slice(),
			}
			if (parsed.subject) model.subject = { label: parsed.subject.label, value: parsed.subject.value }
			return model
		}

		function formatFrame(parsed) {
			const model = logView(parsed)
			if (!model) {
				const errs = parsed && parsed.errors && parsed.errors.length ? parsed.errors.join('；') : '无法按当前协议解析该帧'
				return '<div class="pv-err">' + escHtml(errs) + '</div>'
			}
			if (root.ParseView && typeof root.ParseView.render === 'function') {
				return root.ParseView.render(model)
			}
			let html = '<div class="pv"><div class="pv-head"><span class="pv-title">' + escHtml(model.title) + '</span></div>'
			model.sections.forEach(sec => {
				if (sec.title) html += '<div class="pv-sec-title">' + escHtml(sec.title) + '</div>'
				sec.pairs.forEach(p => {
					html += '<div class="pv-kv"><span class="pv-k">' + escHtml(p[0]) + '</span> <span class="pv-v">' + escHtml(p[1]) + '</span></div>'
				})
			})
			model.errors.forEach(e => { html += '<div class="pv-err">' + escHtml(e) + '</div>' })
			return html + '</div>'
		}

		// 构建 presets 与 funcTabs（兼容通用下行控制器）
		const presets = []
		const templateByName = new Map()
		const funcTabs = dl && dl.funcTabs && dl.funcTabs.length ? dl.funcTabs.map(t => ({ code: t.code, label: t.label })) : []
		if (dl && dl.templates && dl.templates.length) {
			const groupMap = new Map()
			dl.templates.forEach(tpl => {
				templateByName.set(tpl.name, tpl)
				let g = groupMap.get(tpl.group)
				if (!g) {
					g = { group: tpl.group, items: [] }
					groupMap.set(tpl.group, g)
					presets.push(g)
				}
				g.items.push({
					name: tpl.name,
					func: tpl.func,
					desc: tpl.desc,
					cmd: tpl.cmd,
					payloadHex: tpl.payloadHex,
					param: tpl.param ? JSON.parse(JSON.stringify(tpl.param)) : null,
					template: tpl,
				})
			})
		}

		// 设备面板：把声明式映射编译成契约函数（buildRequest / matchReply / extract / byteGroups）
		function compileDevice(dv) {
			if (!dv) return null
			const groupById = Object.create(null)
			dv.groups.forEach(g => { groupById[g.id] = g })
			const byId = id => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(groupById, id) ? groupById[id] : null)
			const writes = new Map(dv.writes.map(item => [item.field, item]))
			function replyMatches(g, parsed, frame) {
				if (!g || !parsed || !parsed.matchedHead) return false
				const rp = g.reply || {}
				if (rp.title && parsed.title !== rp.title) return false
				if (rp.match && rp.match.length) {
					const rules = rp.match.map(r => r.bytes ? { offset: r.offset, bytes: Uint8Array.from(r.bytes) } : r)
					if (!matchFrameRule(toU8(frame || parsed.raw), rules)) return false
				}
				return true
			}
			return {
				title: dv.title,
				nameKey: dv.nameKey || null,
				timeoutMs: dv.timeoutMs,
				log: dv.log || null,
				fields: dv.fields,
				groups: dv.groups,
				readSets: dv.readSets,
				status: dv.status,
				categories: dv.categories,
				buildWrite: writes.size ? function (field, value) {
					const item = writes.get(field.key)
					if (!item) throw new Error('字段没有写入模板')
					const template = templateByName.get(item.template)
					if (!template) throw new Error('字段的写入模板不存在')
					const param = template.param
					const type = String(param.type || 'uint8').toLowerCase()
					const numeric = /^(u?)int(8|16|32)(?:[lb]e)?$/.exec(type === 'enum' ? 'uint8' : type)
					if (numeric) {
						const scale = Number(param.scale || 1)
						const raw = Number(value) / scale
						const max = 2 ** (Number(numeric[2]) - (numeric[1] ? 0 : 1))
						if (Math.abs(raw - Math.round(raw)) > 1e-7 || !Number.isFinite(raw) || Math.round(raw) >= max || Math.round(raw) < (numeric[1] ? 0 : -max)) throw new Error('写入值超出模板参数范围或精度')
					}
					if (type === 'ascii' && (typeof value !== 'string' || /[^\x20-\x7e]/.test(value) || (param.length && value.length > Number(param.length)))) throw new Error('写入值不符合模板 ASCII 约束')
					return buildDownFrame({ presetName: item.template, paramValue: value })
				} : null,
				matchWriteReply: writes.size ? function (field, parsed, frame) {
					const item = writes.get(field.key)
					if (!item || !parsed || parsed.ok === false) return null
					for (const state of ['rejected', 'processing', 'ok']) {
						if (item.reply[state] && replyMatches({ reply: item.reply[state] }, parsed, frame)) return state
					}
					return null
				} : null,
				buildRequest: function (group) {
					const g = byId(group && group.id)
					if (!g) throw new Error('未知的读取组')
					const rq = (g && g.request) || {}
					const o = {}
					if (rq.rawHex) o.rawHex = rq.rawHex
					if (rq.template) o.presetName = rq.template
					if (rq.cmd != null) o.cmd = rq.cmd
					if (rq.payloadHex != null) o.payloadHex = rq.payloadHex
					return buildDownFrame(o)
				},
				matchReply: function (group, parsed, frame) {
					return replyMatches(byId(group && group.id), parsed, frame)
				},
				extract: function (parsed, frame) {
					if (!parsed || !parsed.matchedHead || parsed.ok === false) return null
					const out = Object.create(null)
					dv.fields.forEach(f => {
						const g = f.group ? byId(f.group) : null
						if (g && !replyMatches(g, parsed, frame)) return
						const d = parsed.fields && Object.prototype.hasOwnProperty.call(parsed.fields, f.from) ? parsed.fields[f.from] : null
						if (!d || !d.ok) return
						out[f.key] = d.value
					})
					return out
				},
				byteGroups: function (parsed, key) {
					const f = dv.fields.find(x => x.key === key)
					return f ? [f.from] : []
				},
			}
		}

		function buildDownFrame(opts) {
			const o = opts || {}
			// 形态 3：直接原始帧 HEX
			if (o.rawHex != null && String(o.rawHex).trim() !== '') {
				const raw = hexToBytes(o.rawHex)
				if (!raw) throw new Error('rawHex 格式非法')
				return raw
			}

			// 定位模板（形态 1）
			let tpl = o.template || (o.preset && o.preset.template) || null
			if (!tpl && o.presetName) {
				tpl = templateByName.get(o.presetName) || null
				if (!tpl) throw new Error('未找到下行模板：' + o.presetName)
			}

			// 确定载荷字节
			let payload = null
			if (o.paramBytes != null) {
				payload = o.paramBytes instanceof Uint8Array ? o.paramBytes.slice() : hexToBytes(o.paramBytes)
				if (!payload) throw new Error('paramBytes 格式非法')
			} else if (o.payload != null) {
				payload = (o.payload instanceof Uint8Array || Array.isArray(o.payload)) ? toU8(o.payload).slice() : hexToBytes(o.payload)
				if (!payload) throw new Error('payload HEX 格式非法')
			} else if (o.payloadHex != null) {
				payload = hexToBytes(o.payloadHex)
				if (!payload) throw new Error('payloadHex 格式非法')
			} else if (o.hex != null) {
				payload = hexToBytes(o.hex)
				if (!payload) throw new Error('hex 格式非法')
			} else if (o.paramValue !== undefined) {
				payload = encodeParamValue(tpl ? tpl.param : null, o.paramValue)
			} else if (tpl && tpl.payload && tpl.payload.length) {
				payload = tpl.payload.slice()
			} else if (tpl && tpl.param && tpl.param.default !== undefined) {
				payload = encodeParamValue(tpl.param, tpl.param.default)
			} else {
				payload = new Uint8Array(0)
			}

			const headerSize = dl ? dl.headerSize : Math.max(fr.head.length, fr.length ? fr.length.offset + fr.length.size : 0)
			const payloadOffset = dl ? dl.payloadOffset : headerSize
			const bodyLen = Math.max(headerSize, payloadOffset + payload.length)
			const csSize = cs.size
			const tailLen = fr.tail.length
			let totalLen = bodyLen + csSize + tailLen

			if (fr.fixedLength != null) {
				if (totalLen > fr.fixedLength) {
					throw new Error('下行帧长度超出定长限制（' + totalLen + ' > ' + fr.fixedLength + '）')
				}
				totalLen = fr.fixedLength
			}
			if (totalLen > fr.maxLength) {
				throw new Error('下行帧长度超出上限（' + totalLen + ' > ' + fr.maxLength + '）')
			}

			const frame = new Uint8Array(totalLen)
			// 1. 写入帧头
			frame.set(fr.head, 0)

			// 2. 写入固定字节（按 downlink.fixedBytes -> tpl.fixedBytes -> opts.fixedBytes 逐层覆盖）
			const fixedSources = [
				dl && dl.fixedBytes,
				tpl && tpl.fixedBytes,
				o.fixedBytes != null ? (o.fixedBytes instanceof Uint8Array || Array.isArray(o.fixedBytes) ? toU8(o.fixedBytes) : hexToBytes(o.fixedBytes)) : null,
			]
			fixedSources.forEach(fb => {
				if (!fb || !fb.length) return
				const startOff = matchesAt(fb, 0, fr.head) ? 0 : fr.head.length
				if (startOff + fb.length > totalLen) throw new Error('fixedBytes 超出帧长')
				frame.set(fb, startOff)
			})

			// 3. 写入命令码
			const cmdRaw = o.cmd !== undefined && o.cmd !== null && o.cmd !== ''
				? parseIntStrict(o.cmd)
				: (tpl && tpl.cmd != null ? tpl.cmd : null)
			if (cmdRaw !== null && !Number.isNaN(cmdRaw)) {
				const cmdOff = dl && dl.cmdOffset != null ? dl.cmdOffset : fr.head.length
				const cmdSize = dl ? dl.cmdSize : 1
				const cmdEndian = dl ? dl.cmdEndian : 'le'
				if (cmdOff + cmdSize > totalLen) throw new Error('cmdOffset 超出帧长')
				writeUInt(frame, cmdOff, cmdSize, cmdRaw, cmdEndian)
			}

			// 4. 写入载荷
			if (payload.length) {
				if (payloadOffset + payload.length > totalLen - csSize - tailLen) {
					throw new Error('载荷超出可用帧空间')
				}
				frame.set(payload, payloadOffset)
			}

			// 5. 自动计算回填长度字段
			if (fr.length) {
				const lenVal = totalLen - fr.length.totalDelta
				const maxVal = fr.length.size === 1 ? 0xff : 0xffff
				if (lenVal < 0 || lenVal > maxVal) {
					throw new Error('计算得到的长度字段值越界：' + lenVal)
				}
				writeUInt(frame, fr.length.offset, fr.length.size, lenVal, fr.length.endian)
			}

			// 6. 写入帧尾
			if (tailLen > 0) {
				frame.set(fr.tail, totalLen - tailLen)
			}

			// 7. 计算并写入校验和
			if (cs.algorithm !== 'none' && csSize > 0) {
				const csOff = resolveOffset(totalLen, cs.offset)
				const csStart = resolveOffset(totalLen, cs.start)
				const csEnd = resolveOffset(totalLen, cs.end)
				if (csOff < 0 || csOff + csSize > totalLen || csStart < 0 || csEnd < csStart || csEnd > totalLen) {
					throw new Error('校验范围或偏移超出下行帧长度')
				}
				const csVal = computeRawChecksum(frame.subarray(csStart, csEnd), cs.algorithm, cs)
				writeUInt(frame, csOff, csSize, csVal, cs.endian)
			}

			// 8. 可选前导码
			const wantPreamble = o.preamble !== undefined
				? !!o.preamble
				: (tpl && tpl.preamble !== undefined
					? !!tpl.preamble
					: (dl && dl.preamble !== undefined ? !!dl.preamble : fr.preamble.length > 0))
			if (wantPreamble && fr.preamble.length > 0) {
				const out = new Uint8Array(fr.preamble.length + frame.length)
				out.set(fr.preamble, 0)
				out.set(frame, fr.preamble.length)
				return out
			}
			return frame
		}

		return {
			id: spec.id,
			name: spec.name,
			builtin: false,
			source: 'json',
			version: spec.version,
			description: spec.description,
			findFrame: findFrame,
			parseFrame: parseFrame,
			logView: logView,
			formatFrame: formatFrame,
			byteMap: byteMap,
			buildDownFrame: buildDownFrame,
			presets: presets,
			funcTabs: funcTabs,
			device: compileDevice(spec.device),
			rawSpec: JSON.parse(JSON.stringify(rawSpec)),
		}
	}

	// ===== 内置示例协议 =====
	const EXAMPLES = [
		{
			id: 'demo-sensor-crc16',
			label: '温湿度传感器（变长帧 + CRC16-Modbus）',
			spec: {
				schemaVersion: 1,
				id: 'demo-sensor-crc16',
				name: '温湿度传感器示例',
				version: '1.0.0',
				description: 'AA 55 + Len(1B) + Cmd(1B) + Payload + CRC16-Modbus(2B LE) + 0D',
				framing: {
					preamble: '',
					head: 'AA 55',
					tail: '0D',
					minLength: 7,
					maxLength: 256,
					length: { offset: 2, size: 1, endian: 'le', totalDelta: 7 },
				},
				checksum: {
					algorithm: 'crc16-modbus',
					endian: 'le',
					start: 0,
					end: -3,
					offset: -3,
				},
				fields: [
					{ name: '命令码', offset: 3, length: 1, type: 'uint8', format: 'hex', role: 'cmd' },
				],
				frames: [
					{
						match: { offset: 3, value: '0x01' },
						title: '读取温湿度请求',
						code: '0x01',
						dir: 'down',
						fields: [
							{ name: '通道号', offset: 4, length: 1, type: 'uint8' },
						],
					},
					{
						match: { offset: 3, value: '0x81' },
						title: '温湿度应答',
						code: '0x81',
						dir: 'up',
						fields: [
							{ name: '设备地址', offset: 4, length: 4, type: 'bcd_be', role: 'subject' },
							{ name: '温度', offset: 8, length: 2, type: 'int16le', scale: 0.1, decimals: 1, unit: '℃' },
							{ name: '湿度', offset: 10, length: 2, type: 'uint16le', scale: 0.1, decimals: 1, unit: '%' },
							{
								name: '状态位',
								offset: 12,
								length: 1,
								type: 'bitfield',
								bits: [
									{ bit: 0, width: 1, label: '电池', map: { '0': '正常', '1': '欠压' } },
									{ bit: 1, width: 1, label: '探头', map: { '0': '正常', '1': '故障' } },
								],
							},
						],
					},
					{
						match: { offset: 3, value: '0x02' },
						title: '继电器控制请求',
						code: '0x02',
						dir: 'down',
						fields: [
							{ name: '动作', offset: 4, length: 1, type: 'uint8', map: { '0': '断开', '1': '闭合' } },
						],
					},
					{
						match: { offset: 3, value: '0x82' },
						title: '继电器控制应答',
						code: '0x82',
						dir: 'up',
						fields: [
							{ name: '执行结果', offset: 4, length: 1, type: 'uint8', map: { '0': '成功', '1': '失败' } },
						],
					},
				],
				downlink: {
					funcTabs: [
						{ code: 'query', label: '查询' },
						{ code: 'ctrl', label: '控制' },
					],
					headerSize: 4,
					cmdOffset: 3,
					payloadOffset: 4,
					templates: [
						{
							name: '读取通道温湿度',
							group: '传感器查询',
							func: 'query',
							desc: 'Cmd=0x01 按通道号读取温湿度',
							cmd: '0x01',
							param: { label: '通道号', type: 'uint8', default: '1' },
						},
						{
							name: '继电器控制',
							group: '设备控制',
							func: 'ctrl',
							desc: 'Cmd=0x02 控制继电器断开或闭合',
							cmd: '0x02',
							param: { label: '动作', type: 'enum', default: '1', options: { '0': '断开', '1': '闭合' } },
						},
					],
				},
			},
		},
		{
			id: 'demo-relay-sum8',
			label: '继电器控制（定长 8B + Sum8）',
			spec: {
				schemaVersion: 1,
				id: 'demo-relay-sum8',
				name: '继电器定长示例',
				version: '1.0.0',
				description: 'FE EF + Addr(1B) + Cmd(1B) + Ch(1B) + Val(1B) + Sum8(1B) + 16',
				framing: {
					head: 'FE EF',
					tail: '16',
					fixedLength: 8,
				},
				checksum: {
					algorithm: 'sum8',
					start: 0,
					end: -2,
					offset: -2,
				},
				fields: [
					{ name: '节点地址', offset: 2, length: 1, type: 'uint8', format: 'hex', role: 'subject' },
					{ name: '命令码', offset: 3, length: 1, type: 'uint8', format: 'hex', role: 'cmd' },
				],
				frames: [
					{
						match: { offset: 3, value: '0x10' },
						title: '设置通道输出',
						code: '0x10',
						dir: 'down',
						fields: [
							{ name: '通道', offset: 4, length: 1, type: 'uint8' },
							{ name: '输出状态', offset: 5, length: 1, type: 'uint8', map: { '0': '关闭', '1': '打开' } },
						],
					},
					{
						match: { offset: 3, value: '0x90' },
						title: '通道状态上报',
						code: '0x90',
						dir: 'up',
						fields: [
							{ name: '通道', offset: 4, length: 1, type: 'uint8' },
							{ name: '当前状态', offset: 5, length: 1, type: 'uint8', map: { '0': '关闭', '1': '打开' } },
						],
					},
				],
				downlink: {
					funcTabs: [
						{ code: 'ctrl', label: '通道控制' },
					],
					headerSize: 4,
					cmdOffset: 3,
					payloadOffset: 4,
					fixedBytes: '01',
					templates: [
						{
							name: '打开通道 1',
							group: '快捷控制',
							func: 'ctrl',
							desc: '节点 0x01 通道 1 输出打开',
							cmd: '0x10',
							payload: '01 01',
						},
						{
							name: '关闭通道 1',
							group: '快捷控制',
							func: 'ctrl',
							desc: '节点 0x01 通道 1 输出关闭',
							cmd: '0x10',
							payload: '01 00',
						},
					],
				},
			},
		},
	]

	// ===== 本地存储与桌面目录协议管理 =====
	const dirSpecs = new Map()

	function getStorage() {
		try {
			return root.localStorage || null
		} catch (e) {
			return null
		}
	}

	function readSavedRaw() {
		const st = getStorage()
		if (!st) return []
		try {
			const raw = st.getItem(STORAGE_KEY)
			if (!raw) return []
			const parsed = JSON.parse(raw)
			if (!Array.isArray(parsed)) return []
			return parsed.filter(x => x && typeof x === 'object' && x.spec && typeof x.spec === 'object')
		} catch (e) {
			return []
		}
	}

	function writeSavedRaw(list) {
		const st = getStorage()
		if (!st) return
		st.setItem(STORAGE_KEY, JSON.stringify(list))
	}

	function registerInRegistry(impl) {
		if (root.ProtocolRegistry && typeof root.ProtocolRegistry.register === 'function') {
			// 交由 ProtocolRegistry 基于 logView 统一通过 ParseView.render 生成 formatFrame，避免 HTML 被外部纯文本包装双重转义
			return root.ProtocolRegistry.register(impl.id, Object.assign({}, impl, { formatFrame: null }))
		}
		if (typeof root.registerProtocol === 'function') {
			return root.registerProtocol(impl.id, impl)
		}
		return true
	}

	function unregisterFromRegistry(id) {
		if (root.ProtocolRegistry && typeof root.ProtocolRegistry.unregister === 'function') {
			return root.ProtocolRegistry.unregister(id)
		}
		if (typeof root.unregisterProtocol === 'function') {
			return root.unregisterProtocol(id)
		}
		return { ok: true }
	}

	function listSaved() {
		const out = []
		const saved = readSavedRaw()
		saved.forEach(item => {
			const s = item.spec || {}
			out.push({
				id: String(s.id || ''),
				name: String(s.name || s.id || ''),
				version: String(s.version || '1.0.0'),
				description: String(s.description || ''),
				spec: JSON.parse(JSON.stringify(s)),
				updatedAt: Number(item.updatedAt) || 0,
				source: 'json',
			})
		})
		dirSpecs.forEach(entry => {
			out.push({
				id: entry.id,
				name: entry.name,
				version: entry.version,
				description: entry.description,
				spec: entry.spec ? JSON.parse(JSON.stringify(entry.spec)) : null,
				updatedAt: entry.updatedAt || 0,
				source: 'dir-json',
				fileName: entry.fileName,
				error: entry.error || undefined,
			})
		})
		return out
	}

	function upsert(spec) {
		const checked = validateSpec(spec)
		if (!checked.ok) return { ok: false, errors: checked.errors }
		let impl
		try {
			impl = compile(spec)
		} catch (err) {
			return { ok: false, errors: [err && err.message ? err.message : String(err)] }
		}
		try {
			registerInRegistry(impl)
		} catch (err) {
			return { ok: false, errors: [err && err.message ? err.message : String(err)] }
		}
		const saved = readSavedRaw()
		const idx = saved.findIndex(x => x && x.spec && x.spec.id === impl.id)
		const entry = { spec: JSON.parse(JSON.stringify(spec)), updatedAt: Date.now() }
		if (idx >= 0) saved[idx] = entry
		else saved.push(entry)
		writeSavedRaw(saved)
		return { ok: true, id: impl.id }
	}

	function remove(id) {
		const target = String(id || '').trim()
		if (!target) return { ok: false, error: '协议 ID 不能为空' }
		const saved = readSavedRaw()
		const idx = saved.findIndex(x => x && x.spec && x.spec.id === target)
		if (idx < 0) {
			let isDir = false
			dirSpecs.forEach(entry => { if (entry.id === target) isDir = true })
			if (isDir) {
				return { ok: false, error: '该协议来自桌面插件目录，请在插件目录中移除对应 .json 文件后重新扫描' }
			}
			return { ok: false, error: '未找到本地 JSON 协议：' + target }
		}
		saved.splice(idx, 1)
		writeSavedRaw(saved)
		unregisterFromRegistry(target)
		return { ok: true }
	}

	function importJson(rawTextOrObj) {
		let parsed = rawTextOrObj
		if (typeof rawTextOrObj === 'string') {
			try {
				parsed = JSON.parse(rawTextOrObj)
			} catch (err) {
				return { ok: false, imported: [], errors: ['JSON 解析失败：' + (err && err.message ? err.message : String(err))] }
			}
		}
		let list = []
		if (Array.isArray(parsed)) {
			list = parsed
		} else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.protocols)) {
			list = parsed.protocols
		} else if (parsed && typeof parsed === 'object') {
			list = [parsed]
		} else {
			return { ok: false, imported: [], errors: ['导入内容必须为协议 JSON 对象、协议数组或 { version, protocols } 协议包'] }
		}
		if (!list.length) {
			return { ok: false, imported: [], errors: ['协议列表为空'] }
		}
		const imported = []
		const errors = []
		list.forEach((item, idx) => {
			const res = upsert(item)
			if (res.ok) imported.push(res.id)
			else errors.push('第 ' + (idx + 1) + ' 项：' + (res.errors || []).join('；'))
		})
		return { ok: imported.length > 0 && errors.length === 0, imported: imported, errors: errors }
	}

	function exportJson(idOptional) {
		const saved = readSavedRaw()
		if (idOptional != null && String(idOptional).trim() !== '') {
			const target = String(idOptional).trim()
			const found = saved.find(x => x && x.spec && x.spec.id === target)
			if (found) return JSON.stringify(found.spec, null, 2)
			let dirFound = null
			dirSpecs.forEach(entry => { if (entry.id === target && entry.spec) dirFound = entry.spec })
			if (dirFound) return JSON.stringify(dirFound, null, 2)
			return ''
		}
		return JSON.stringify({
			version: 1,
			protocols: saved.map(x => x.spec),
		}, null, 2)
	}

	function registerDirSpec(fileName, rawContent) {
		const fName = String(fileName || '').trim()
		let parsed = rawContent
		if (typeof rawContent === 'string') {
			try {
				parsed = JSON.parse(rawContent)
			} catch (err) {
				const msg = 'JSON 解析失败：' + (err && err.message ? err.message : String(err))
				dirSpecs.set(fName, {
					id: '',
					name: fName,
					version: '',
					description: '',
					spec: null,
					updatedAt: Date.now(),
					fileName: fName,
					error: msg,
				})
				return { ok: false, errors: [msg] }
			}
		}
		const checked = validateSpec(parsed)
		if (!checked.ok) {
			dirSpecs.set(fName, {
				id: parsed && typeof parsed.id === 'string' ? parsed.id : '',
				name: (parsed && typeof parsed.name === 'string' && parsed.name) || fName,
				version: (parsed && parsed.version) ? String(parsed.version) : '',
				description: (parsed && parsed.description) ? String(parsed.description) : '',
				spec: parsed && typeof parsed === 'object' ? parsed : null,
				updatedAt: Date.now(),
				fileName: fName,
				error: checked.errors.join('；'),
			})
			return { ok: false, errors: checked.errors }
		}

		const id = checked.normalized.id
		// 避免覆盖已存在的同名内置或本地/其它目录协议
		const reg = root.ProtocolRegistry
		const existing = reg && typeof reg.get === 'function' ? reg.get(id) : (root._protocols && root._protocols[id])
		if (existing && (existing.builtin === true || existing.source !== 'dir-json' || existing.fileName !== fName)) {
			const msg = '协议 ID "' + id + '" 与已注册协议冲突，已跳过'
			dirSpecs.set(fName, {
				id: id,
				name: checked.normalized.name,
				version: checked.normalized.version,
				description: checked.normalized.description,
				spec: JSON.parse(JSON.stringify(parsed)),
				updatedAt: Date.now(),
				fileName: fName,
				error: msg,
			})
			return { ok: false, errors: [msg] }
		}

		let impl
		try {
			impl = compile(parsed)
			impl.source = 'dir-json'
			impl.fileName = fName
			registerInRegistry(impl)
		} catch (err) {
			const msg = err && err.message ? err.message : String(err)
			dirSpecs.set(fName, {
				id: id,
				name: checked.normalized.name,
				version: checked.normalized.version,
				description: checked.normalized.description,
				spec: JSON.parse(JSON.stringify(parsed)),
				updatedAt: Date.now(),
				fileName: fName,
				error: msg,
			})
			return { ok: false, errors: [msg] }
		}

		dirSpecs.set(fName, {
			id: id,
			name: checked.normalized.name,
			version: checked.normalized.version,
			description: checked.normalized.description,
			spec: JSON.parse(JSON.stringify(parsed)),
			updatedAt: Date.now(),
			fileName: fName,
			error: '',
			registered: true,
		})
		return { ok: true, id: id }
	}

	function clearDirSpecs() {
		dirSpecs.forEach(entry => {
			if (entry.registered && entry.id) {
				try { unregisterFromRegistry(entry.id) } catch (e) { /* ignore */ }
			}
		})
		dirSpecs.clear()
	}

	function loadSavedIntoRegistry() {
		const saved = readSavedRaw()
		const loaded = []
		const errors = []
		saved.forEach(item => {
			if (!item || !item.spec) return
			try {
				const impl = compile(item.spec)
				registerInRegistry(impl)
				loaded.push(impl.id)
			} catch (err) {
				errors.push((item.spec.id || 'unknown') + '：' + (err && err.message ? err.message : String(err)))
			}
		})
		return { loaded: loaded, errors: errors }
	}

	const api = {
		STORAGE_KEY: STORAGE_KEY,
		EXAMPLES: EXAMPLES,
		Checksum: Checksum,
		validateSpec: validateSpec,
		compile: compile,
		listSaved: listSaved,
		upsert: upsert,
		remove: remove,
		importJson: importJson,
		exportJson: exportJson,
		registerDirSpec: registerDirSpec,
		clearDirSpecs: clearDirSpecs,
		loadSavedIntoRegistry: loadSavedIntoRegistry,
	}

	root.JsonProtocol = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api

	// 浏览器环境启动时自动加载已保存的 JSON 协议
	if (typeof window !== 'undefined' && (window.ProtocolRegistry || typeof window.registerProtocol === 'function') && getStorage()) {
		loadSavedIntoRegistry()
	}
})(typeof window !== 'undefined' ? window : globalThis)
