(function () {
	'use strict'

	const W = window

	// 基准水量: 协议码 → 升/单位(每圈)。解析会话级, 换表(唯一码变)则重置
	const BASE_WATER_LITERS = { 0: 1000, 1: 100, 2: 10, 3: 1, 4: 0.1, 5: 0.01, 6: 0.001 }
	const BASE_WATER_LABEL = {
		0: '1000L/圈', 1: '100L/圈', 2: '10L/圈', 3: '1L/圈',
		4: '100mL/圈', 5: '10mL/圈', 6: '1mL/圈'
	}
	W.skSession = {
		deviceUid: null,
		baseCode: null,
		baseLiters: 1,
		baseLabel: '1L(默认·未读基准)',
		baseSource: null,
		resetBase: function () {
			this.baseCode = null
			this.baseLiters = 1
			this.baseLabel = '1L(默认·未读基准)'
			this.baseSource = null
		},
		setBase: function (code, source) {
			if (code == null || code < 0 || code > 6) return false
			this.baseCode = code & 0xff
			this.baseLiters = BASE_WATER_LITERS[this.baseCode] != null ? BASE_WATER_LITERS[this.baseCode] : 1
			this.baseLabel = BASE_WATER_LABEL[this.baseCode] || (this.baseCode + '')
			this.baseSource = source || 'frame'
			return true
		},
		touchDevice: function (uid) {
			const u = uid != null ? String(uid) : null
			if (u && this.deviceUid && this.deviceUid !== u) {
				this.resetBase()
			}
			if (u) this.deviceUid = u
		},
		hasBase: function () {
			return this.baseCode != null
		}
	}

	function toBytes(x) {
		if (x == null) return new Uint8Array(0)
		if (x instanceof Uint8Array) return new Uint8Array(x)
		if (Array.isArray(x)) return new Uint8Array(x)
		if (typeof x === 'string') {
			let s = x.trim()
			if (s.indexOf(' ') >= 0 || s.indexOf('\n') >= 0) s = s.replace(/\s+/g, '')
			if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
				const a = new Uint8Array(s.length / 2)
				for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16)
				return a
			}
		}
		throw new Error('toBytes: unsupported input')
	}

	function u16leRead(b, o) {
		o = o || 0
		return (b[o] | (b[o + 1] << 8)) & 0xffff
	}
	function u16leWrite(arr, v) {
		arr.push(v & 0xff)
		arr.push((v >> 8) & 0xff)
	}
	function u32leRead(b, o) {
		o = o || 0
		return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0)
	}

	function hexbytes(b) {
		let s = ''
		for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16)
		return s
	}
	function ascii(b) {
		let s = ''
		for (let i = 0; i < b.length; i++) {
			const c = b[i]
			if (c === 0) break
			s += String.fromCharCode(c)
		}
		return s
	}
	function signed16(b) {
		const v = (b[0] | (b[1] << 8)) & 0xffff
		return v > 0x7fff ? v - 0x10000 : v
	}
	function signed32(b) {
		const v = u32leRead(b, 0)
		return v > 0x7fffffff ? v - 0x100000000 : v
	}
	function signed8(b) {
		const v = b[0] & 0xff
		return v > 0x7f ? v - 0x100 : v
	}

	function bcdDecode(b) {
		const r = Array.from(b).reverse()
		let s = ''
		for (let i = 0; i < r.length; i++) s += (r[i] >> 4).toString(10) + (r[i] & 0xf).toString(10)
		return s
	}
	function bcdDecodeNoReverse(b) {
		let s = ''
		for (let i = 0; i < b.length; i++) s += (b[i] >> 4).toString(10) + (b[i] & 0xf).toString(10)
		return s
	}
	// LE BCD（表号/唯一码等小端字段）
	function bcdEncode(digits) {
		let s = digits
		if (s.length % 2 !== 0) s = '0' + s
		const n = s.length / 2
		const a = new Uint8Array(n)
		for (let i = 0; i < n; i++) a[i] = (parseInt(s[i * 2], 10) << 4) | parseInt(s[i * 2 + 1], 10)
		return a.reverse()
	}
	// 平台时间等顺序 BCD：YYYYMMDDhhmmss → 7 字节高位在前（与 C writeBcdTimeToBytes / 协议一致）
	function bcdEncodeForward(digits) {
		let s = String(digits || '').replace(/\D/g, '')
		if (s.length % 2 !== 0) s = '0' + s
		const n = s.length / 2
		const a = new Uint8Array(n)
		for (let i = 0; i < n; i++) a[i] = (parseInt(s[i * 2], 10) << 4) | parseInt(s[i * 2 + 1], 10)
		return a
	}
	function platformTimeBytes(src) {
		const pad = (n, l) => String(n).padStart(l, '0')
		let digits
		if (src instanceof Date && !isNaN(src.getTime())) {
			digits = pad(src.getFullYear(), 4) + pad(src.getMonth() + 1, 2) + pad(src.getDate(), 2) +
				pad(src.getHours(), 2) + pad(src.getMinutes(), 2) + pad(src.getSeconds(), 2)
		} else if (typeof src === 'string') {
			digits = src.replace(/[^0-9]/g, '').padStart(14, '0').slice(-14)
		} else {
			const now = new Date()
			digits = pad(now.getFullYear(), 4) + pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2) +
				pad(now.getHours(), 2) + pad(now.getMinutes(), 2) + pad(now.getSeconds(), 2)
		}
		const b = bcdEncodeForward(digits)
		if (b.length >= 7) return b.subarray(0, 7)
		const out = new Uint8Array(7)
		out.set(b)
		return out
	}
	//把纯数字日期串格式化为 yyyy-MM-dd HH:mm:ss[.S…]
	function formatTimeDigits(s) {
		if (!s || !/^\d+$/.test(s)) return null
		if (/^0+$/.test(s)) return '-----'
		// 14+ : YYYYMMDDhhmmss(+frac)
		if (s.length >= 14) {
			const y = parseInt(s.slice(0, 4), 10)
			if (y < 1970 || y > 2099) return null
			let out = s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) +
				' ' + s.slice(8, 10) + ':' + s.slice(10, 12) + ':' + s.slice(12, 14)
			if (s.length > 14) out += '.' + s.slice(14)
			return out
		}
		// 12 : YYMMDDhhmmss
		if (s.length === 12) {
			const yy = parseInt(s.slice(0, 2), 10)
			const y = (yy >= 70 ? 1900 : 2000) + yy
			return y + '-' + s.slice(2, 4) + '-' + s.slice(4, 6) +
				' ' + s.slice(6, 8) + ':' + s.slice(8, 10) + ':' + s.slice(10, 12)
		}
		// 8 : YYYYMMDD
		if (s.length === 8) {
			const y = parseInt(s.slice(0, 4), 10)
			if (y < 1970 || y > 2099) return null
			return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8)
		}
		// 6 : hhmmss
		if (s.length === 6) {
			return s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6)
		}
		return null
	}
	function bcdTime(b) {
		const s1 = bcdDecodeNoReverse(b)
		const f1 = formatTimeDigits(s1)
		if (f1) return f1
		const s2 = bcdDecode(b)
		const f2 = formatTimeDigits(s2)
		if (f2) return f2
		return s1
	}
	function formatDateTime(d, msDigits) {
		if (!(d instanceof Date) || isNaN(d.getTime())) return ''
		const p = n => String(n).padStart(2, '0')
		let s = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
			' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
		if (msDigits > 0) {
			s += '.' + String(d.getMilliseconds()).padStart(3, '0').slice(0, msDigits)
		}
		return s
	}

	function escHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;')
	}

	function typeLen(t) {
		if (!t) return null
		if (t === 'NULL') return 0
		if (t === 'BYTE') return 1
		let m
		// BYTE[a+b+c+...] 单组内任意项数的定长
		m = t.match(/^BYTE\[([\d\+]+)\]$/)
		if (m) {
			return m[1].split('+').reduce((s, p) => s + parseInt(p, 10), 0)
		}
		// BYTE[a]+BYTE[b]... 多组定长拼接
		m = t.match(/^BYTE\[\d+(?:\+\d+)*\](?:\+BYTE\[\d+(?:\+\d+)*\])*$/)
		if (m) {
			let s = 0
			const groups = t.match(/BYTE\[([^\]]+)\]/g)
			for (const g of groups) {
				for (const p of g.slice(5, -1).split('+')) s += parseInt(p, 10)
			}
			return s
		}
		m = t.match(/^[Cc]har\[(\d+)\]$/)
		if (m) return parseInt(m[1], 10)
		m = t.match(/^BYTES\[(\d+)\]$/)
		if (m) return parseInt(m[1], 10)
		m = t.match(/^UINT16\[(\d+)\]$/i)
		if (m) return parseInt(m[1], 10) * 2
		m = t.match(/^BYTE\[(\d+)\*(\d+)\]$/)
		if (m) return parseInt(m[1], 10) * parseInt(m[2], 10)
		if (t.indexOf('*') >= 0 || t.indexOf('n') >= 0) return null
		m = t.match(/\[(\d+)\]/)
		if (m) return parseInt(m[1], 10)
		return null
	}

	function unitHint(def) {
		if (!def) return ''
		if (def.unit) return def.unit
		const m = (def.desc || '').match(/\s([0-9.]+[a-zA-Zμ℃/%h]+|秒|分钟|天|小时|次|L|kPa|us\/cm)$/i)
		return m ? m[1] : ''
	}

	function renderBits(raw, desc) {
		let v = 0
		for (let i = 0; i < raw.length; i++) v |= raw[i] << (8 * i)
		const map = {}
		const re = /bit(\d+)\s*([^bit\s]+)/g
		let m
		while ((m = re.exec(desc)) !== null) map[parseInt(m[1], 10)] = m[2]
		const out = []
		for (let i = 0; i < 16; i++) {
			if (v & (1 << i)) out.push('bit' + i + (map[i] ? ':' + map[i] : ''))
		}
		return out.length ? out.join(' ') : hexbytes(raw)
	}

	function renderEnum(raw, desc) {
		const map = {}
		const re = /(^|\s)(\d+)\s*([^\s\d][^\s]*)/g
		let m
		while ((m = re.exec(desc)) !== null) map[parseInt(m[2], 10)] = m[3]
		if (raw.length === 1 && map[raw[0]] != null) return raw[0] + ':' + map[raw[0]]
		return hexbytes(raw)
	}

	function f32le(b) {
		const a = new ArrayBuffer(4)
		const u = new Uint8Array(a)
		u.set(b.subarray(0, 4))
		return new DataView(a).getFloat32(0, true)
	}
	function uNle(raw, start, len) {
		let v = 0n
		const max = raw.length - start
		if (max <= 0) return 0
		const n = Math.min(len, max)
		for (let i = 0; i < n; i++) v |= BigInt(raw[start + i]) << BigInt(8 * i)
		return Number(v)
	}
	function numUnit(desc) {
		if (!desc) return { scale: 1, unit: '' }
		// 优先「系数+单位」: 0.01V / 0.1℃ / 0.1pH / 0.1NTU（勿先匹配裸 V/L）
		let m = desc.match(/(?:^|[^\d.])(\d+\.\d+)\s*(V|v|℃|pH|NTU|mAH|kPa|L\/h|mg\/L|us\/cm|uA|mm|mV|mA|%)/i)
		if (m) {
			let u = m[2]
			if (u === 'v') u = 'V'
			return { scale: parseFloat(m[1]), unit: u }
		}
		// 明确多字符单位
		const w = desc.match(/(L\/h|us\/cm|mg\/L|uA|kPa|NTU|mAH|pH|℃|分钟|小时|天|秒|次|mV|mA|kHz|MHz|%)/)
		if (w) return { scale: 1, unit: w[1] }
		// 单独 L / V（歧义较大,放最后）
		if (/单位\s*L\b|Uint32.*\bL\b|\b单位L\b/i.test(desc)) return { scale: 1, unit: 'L' }
		if (/单位\s*0\.01\s*[Vv]|0\.01\s*[Vv]/.test(desc)) return { scale: 0.01, unit: 'V' }
		if (/\b[Vv]\b|单位.*[Vv]/.test(desc)) return { scale: 1, unit: 'V' }
		return { scale: 1, unit: '' }
	}
	function readNum(raw, desc) {
		if (/int32 LE signed/.test(desc)) return signed32(raw)
		if (/int16 LE signed/.test(desc)) return signed16(raw)
		if (/int8/.test(desc)) return signed8(raw)
		if (raw.length === 4) return u32leRead(raw, 0)
		if (raw.length === 2) return u16leRead(raw, 0)
		if (raw.length === 1) return raw[0]
		return 0
	}
	function fmtNum(v, unit) {
		let s
		if (typeof v === 'number') {
			if (Number.isInteger(v)) s = String(v)
			else s = String(Math.round(v * 1e6) / 1e6)
		} else s = String(v)
		return unit ? (s + ' ' + unit) : s
	}
	function parseEnumMap(desc) {
		const map = {}
		if (!desc) return map
		if (/=/.test(desc)) {
			for (const tok of desc.split(/\s+/)) {
				const m = tok.match(/^(\d+)=(.*)$/)
				if (m) map[+m[1]] = m[2]
			}
			if (Object.keys(map).length) return map
		}
		// 0停止 1启用 2运输模式 / 1二值压缩 2标准图片 …
		// 不匹配 0-23 这类范围（数字后紧跟 -数字）
		const re = /(^|[\s,;，；])(\d+)(?!\s*-\s*\d)\s*([^\d\s=:-][^\s,;，；]*)/g
		let m
		while ((m = re.exec(desc)) !== null) {
			const label = m[3].replace(/[)）].*$/, '')
			if (!label || /^(B|字节|次|秒|分钟|天|小时|时|位|mm)$/.test(label)) continue
			if (/^[-–]/.test(label)) continue
			map[+m[2]] = label
		}
		return map
	}
	function bcdTimeOrEmpty(raw) {
		const zero = raw.every(x => x === 0)
		return zero ? '-----' : bcdTime(raw)
	}
	function renderAlarmTime(raw) {
		const flag = raw[0]
		return (flag ? '报警' : '不报警') + ' ' + bcdTimeOrEmpty(raw.subarray(1, 8))
	}
	function renderAlarmTimeVal(raw, scale, unit) {
		const flag = raw[0]
		const v = signed16(raw.subarray(8, 10)) * (scale || 1)
		return (flag ? '报警' : '不报警') + ' ' + fmtNum(v, unit) + ' ' + bcdTimeOrEmpty(raw.subarray(1, 8))
	}
	function renderAlarmObjTime(raw) {
		const flag = raw[0]
		const obj = raw[1]
		const object = (obj >> 4) & 0x0f
		const medium = obj & 0x0f
		const objMap = { 1: '数据', 2: '参数' }
		const medMap = { 1: '内FLASH', 2: '内EEPROM', 3: '外EEPROM', 4: '外部FLASH' }
		const objTxt = objMap[object] || '其他'
		const medTxt = medMap[medium] || ('未知' + medium)
		return (flag ? '报警' : '不报警') + ' 异常对象' + objTxt + '异常介质' + medTxt + ' ' + bcdTimeOrEmpty(raw.subarray(2, 9))
	}
	function renderFlowLarge(raw) {
		const abnormal = raw[0] & 0x01
		const v = uNle(raw, 1, 7)
		return fmtNum(v / 1000, '吨') + ' 状态:' + (abnormal ? '异常' : '数据正常')
	}
	function renderUtc(raw) {
		if (!raw || raw.length < 4) return ''
		// 4B 秒级；8B 时低 4B 为秒、高 4B 为微秒/保留
		const sec = u32leRead(raw, 0)
		if (sec === 0) return '-----'
		const d = new Date(sec * 1000)
		if (isNaN(d.getTime()) || d.getFullYear() < 1970 || d.getFullYear() > 2099) {
			return String(sec)
		}
		let s = formatDateTime(d, 0)
		if (raw.length >= 8) {
			const frac = u32leRead(raw, 4)
			if (frac > 0 && frac < 1000000) {
				s += '.' + String(frac).padStart(6, '0').replace(/0+$/, '')
			}
		}
		return s
	}
	function renderBitsHint(fields, raw) {
		let v = 0n
		for (let i = 0; i < raw.length; i++) v |= BigInt(raw[i]) << BigInt(8 * i)
		const parts = []
		for (const f of fields) {
			let val
			if (Array.isArray(f.bits)) {
				const hi = f.bits[0], lo = f.bits[1]
				const mask = (1n << BigInt(hi - lo + 1)) - 1n
				val = Number((v >> BigInt(lo)) & mask)
			} else val = (v & (1n << BigInt(f.bits))) ? 1 : 0
			const txt = f.map && f.map[val] != null ? f.map[val] : val
			parts.push(f.name + ':' + txt)
		}
		return parts.join(' ')
	}
	function renderBitsFromDesc(raw, desc) {
		let v = 0n
		for (let i = 0; i < raw.length; i++) v |= BigInt(raw[i]) << BigInt(8 * i)
		const map = {}
		const re = /bit(\d+)[-~]bit(\d+)\s*([^bit]+)/g
		let m
		while ((m = re.exec(desc)) !== null) {
			const hi = +m[1], lo = +m[2]
			const mask = (1n << BigInt(hi - lo + 1)) - 1n
			const val = Number((v >> BigInt(lo)) & mask)
			map[hi] = m[3].trim() + '=' + val
		}
		const out = []
		for (let i = 15; i >= 0; i--) if (map[i]) out.push('bit' + i + ':' + map[i])
		return out.length ? out.join(' ') : hexbytes(raw)
	}
	function renderValue(def, raw) {
		if (!raw || raw.length === 0) return ''
		const dec = def && def.dec
		const desc = def ? (def.desc || '') : ''
		const type = def ? (def.type || '') : ''
		if (dec) {
			switch (dec.t) {
				case 'ascii': return ascii(raw)
				case 'bcd': return bcdDecode(raw)
				case 'time7': return bcdTime(raw)
				case 'pct': return raw[0] + '%'
				case 'float': { const nu = numUnit(desc); return fmtNum(f32le(raw), nu.unit) }
				case 'num': {
					const nu = numUnit(desc)
					const scale = (dec.scale != null) ? dec.scale : nu.scale
					const unit = dec.unit || nu.unit
					let v = readNum(raw, desc)
					if (scale !== 1) v = v * scale
					return fmtNum(v, unit)
				}
				case 'enum': {
					const code = raw[0] & 0xff
					if (code === 0xff) return '未设置'
					return (dec.map[code] != null) ? (code + ':' + dec.map[code]) : ('0x' + code.toString(16).toUpperCase())
				}
				case 'bits': return renderBitsHint(dec.fields, raw)
				case 'alarmTime': return renderAlarmTime(raw)
				case 'alarmObjTime': return renderAlarmObjTime(raw)
				case 'alarmTimeVal': { const nu = numUnit(desc); return renderAlarmTimeVal(raw, nu.scale, nu.unit) }
				case 'flowLarge': return renderFlowLarge(raw)
				case 'utc': return renderUtc(raw)
				case 'resetRec': return '复位类型:' + (dec.map && dec.map[raw[0]] != null ? dec.map[raw[0]] : raw[0]) + ' 最近一次复位时间戳:' + renderUtc(raw.subarray(1, 5))
				case 'resetInfo': return '累计复位' + u16leRead(raw, 0) + ' 看门狗复位' + u16leRead(raw, 2) + ' 低电压复位' + u16leRead(raw, 4)
				case 'storageErr': {
					const total = raw[0]
					const fail = raw[1]
					const medMap = { 1: '内FLASH', 2: '内EEPROM', 3: '外EEPROM', 4: '外部FLASH' }
					const med = medMap[raw[2]] || ('未知' + raw[2])
					return '异常总次数' + total + ' 参数修复失败' + ((fail >> 4) & 0x0f) + ' 数据修复失败' + (fail & 0x0f) + ' 最近一次修复失败的存储介质:' + med + ' 时间' + bcdTimeOrEmpty(raw.subarray(3, 10))
				}
				case 'battery': return '总容量' + (u16leRead(raw, 0) * 10) + 'mAH 起始容量' + (u16leRead(raw, 2) * 10) + 'mAH'
				case 'tempThresh': return '低温' + signed8([raw[0]]) + '℃ 高温' + signed8([raw[1]]) + '℃'
				case 'reportTime': {
					// BYTE0=起始日DD, BYTE1=起始时hh, BYTE2-3=最大上报时长(分钟,预留)
					return '起始日' + raw[0] + '日 ' + raw[1] + '时 最大上报时长' + u16leRead(raw, 2) + '分'
				}
				case 'range': return (dec.labels ? dec.labels[0] : '起始') + ':' + raw[0] + '点 ' + (dec.labels ? dec.labels[1] : '结束') + ':' + raw[1] + '点'
				case 'upErr': {
					const linkMap = { 0: '其他', 1: 'AT失败', 2: '无SIM', 8: '驻网失败', 11: '接入失败', 13: '断网', 99: '上报无应答' }
					return '最近一次上行异常发生时间:' + bcdTimeOrEmpty(raw.subarray(0, 6)) + ' 最近一次异常发生时的CSQ:' + raw[6] + ' 异常发生的环节:' + (linkMap[raw[7]] != null ? linkMap[raw[7]] : raw[7])
				}
				case 'magSignal': return 'CH0=' + raw[0] + ' CH1=' + raw[1]
				case 'busMeters': return renderBusMeters(raw, dec.rec || 14)
				case 'imgPack': return renderImgPack(raw)
			}
		}
		if (/YYYYMMDDhhmmss|YYMMDDhhmmss/.test(desc) || (def && def.unit === 'BCD' && (raw.length === 7 || raw.length === 6))) return bcdTime(raw)
		if (/时间戳|UTC|unix/i.test(desc + ' ' + (def && def.name ? def.name : '')) && (raw.length === 4 || raw.length === 8)) return renderUtc(raw)
		if (desc.indexOf('ASCII') >= 0 || /^char/i.test(type)) return ascii(raw)
		if (desc.indexOf('%') >= 0 && raw.length === 1) return raw[0] + '%'
		const blob = desc + ' ' + (def && def.name ? def.name : '')
		if (/^bit\d+[-~]\d+/.test(desc.trim()) || /(运营商|协议类型|注册|通信|主站|辅助|业务)\s*:/.test(desc)) return renderBitsFromDesc(raw, desc)
		let sm
		if ((sm = type.match(/^BYTE\[1\+7\+2\]$/))) { const nu = numUnit(desc); return renderAlarmTimeVal(raw, nu.scale, nu.unit) }
		if ((sm = type.match(/^BYTE\[1\+1\+7\]$/))) return renderAlarmObjTime(raw)
		if ((sm = type.match(/^BYTE\[1\+7\]$/))) {
			if (/大口径/.test(blob)) return renderFlowLarge(raw)
			if (/时间/.test(blob)) return renderAlarmTime(raw)
			const v = uNle(raw, 1, Math.min(7, raw.length - 1))
			return (raw[0] & 0x01 ? '异常 ' : '') + fmtNum(v, numUnit(desc).unit)
		}
		if ((sm = type.match(/^BYTE\[1\+3\]$/))) {
			const status = raw[0] & 0x01 ? '异常' : '正常'
			const v = signed16(raw.subarray(1, 4))
			return status + ' ' + fmtNum(v, numUnit(desc).unit)
		}
		if ((sm = type.match(/^BYTE\[1\+1\]$/))) {
			return raw[0] + ' / ' + raw[1]
		}
		if ((sm = type.match(/^BYTE\[4\+7\]$/))) {
			return '告警位:' + hexbytes(raw.subarray(0, 4)) + ' 时间:' + bcdTimeOrEmpty(raw.subarray(4, 11))
		}
		if (desc.indexOf('BCD') >= 0) {
			// 时间类 BCD 优先格式化；表号等仍显示数字串
			const blob = ((def && def.name) ? def.name : '') + ' ' + desc
			if (/时间|日期|时刻|YYYYMMDD|YYMMDD/.test(blob)) {
				const t = bcdTime(raw)
				if (t && t !== '-----' && /[-:]/.test(t)) return t
			}
			const s = bcdDecode(raw)
			return /^0+$/.test(s) ? '(空)' : s
		}
		// 日结查询 BYTE[3+1]：起始日期3B(BCD 年月日) + 个数1B
		if (type === 'BYTE[3+1]' && raw.length >= 4) {
			const ds = bcdDecodeNoReverse(raw.subarray(0, 3))
			let dateStr = ds
			if (/^\d{6}$/.test(ds)) {
				const yy = parseInt(ds.slice(0, 2), 10)
				const y = (yy >= 70 ? 1900 : 2000) + yy
				dateStr = y + '-' + ds.slice(2, 4) + '-' + ds.slice(4, 6)
			} else if (/^\d{8}$/.test(ds)) {
				dateStr = ds.slice(0, 4) + '-' + ds.slice(4, 6) + '-' + ds.slice(6, 8)
			}
			return '起始' + dateStr + ' 个数' + raw[3]
		}
		// 指定ID数据：2B一组 tag+id，0xFF 填充
		if ((def && def.name === '指定ID数据') || (type === 'BYTE[32]' && /tag\s*\+?\s*id|每组tag/i.test(desc))) {
			const pairs = []
			for (let i = 0; i + 1 < raw.length; i += 2) {
				if (raw[i] === 0xff && raw[i + 1] === 0xff) continue
				const tn = W.SK_TAG_NAME[raw[i]] || ('Tag' + raw[i])
				pairs.push(tn + '/ID' + raw[i + 1])
			}
			return pairs.length ? pairs.join(' ') : '(空)'
		}
		if (/=/.test(desc) || /\d+\s*[\u4e00-\u9fff]/.test(desc) || /\d+[关开停启]/.test(desc)) {
			const map = parseEnumMap(desc)
			if (raw.length === 1 && map[raw[0]] != null) return raw[0] + ':' + map[raw[0]]
		}
		const nu = numUnit(desc)
		if (nu.unit || nu.scale !== 1 || /Uint32 LE|uint32 LE|int16 LE signed|uint16 LE|Uint16 LE|int8|int32 LE signed|float/i.test(desc)) {
			let v = readNum(raw, desc)
			if (nu.scale !== 1) v = v * nu.scale
			return fmtNum(v, nu.unit)
		}
		if (/^BYTE(\[\d+\])?$/.test(type) && (raw.length === 1 || raw.length === 2 || raw.length === 4)) {
			if (raw.length === 4) return String(u32leRead(raw, 0))
			if (raw.length === 2) return String(u16leRead(raw, 0))
			return String(raw[0])
		}
		return hexbytes(raw)
	}

	// 总线表状态 ST0/ST1 (协议附表)
	function renderBusStatus(st0, st1) {
		const valve = { 0: '开阀', 1: '关阀', 3: '异常' }
		const parts = []
		if (st0 & 0x80) parts.push('倒流')
		if (st0 & 0x40) parts.push('漏水')
		if (st0 & 0x20) parts.push('过流')
		if (st0 & 0x10) parts.push('磁干扰')
		if (st0 & 0x08) parts.push('机电分离')
		if (st0 & 0x04) parts.push('低压')
		parts.push('阀:' + (valve[st0 & 0x03] != null ? valve[st0 & 0x03] : (st0 & 0x03)))
		if (st1 != null) {
			if (st1 & 0x02) parts.push('采样报警')
			if (st1 & 0x01) parts.push('断线报警')
		}
		return parts.join(' ')
	}
	function renderBusMeters(raw, rec) {
		rec = rec || 14
		if (!raw || raw.length < rec) return hexbytes(raw || [])
		const n = Math.floor(raw.length / rec)
		const unitMap = { 0: '1000L', 1: '100L', 2: '10L', 3: '1L' }
		const lines = [n + '块表']
		for (let i = 0; i < n; i++) {
			const o = i * rec
			const addr = bcdDecode(raw.subarray(o, o + 7))
			const reading = u32leRead(raw, o + 7)
			const st0 = raw[o + 11]
			const st1 = raw[o + 12]
			const unit = raw[o + 13]
			let s = '#' + (i + 1) + ' 地址' + addr + ' 读数' + (reading === 0xffffffff ? '异常' : reading) +
				' 单位' + (unitMap[unit] != null ? unitMap[unit] : unit) +
				' ' + renderBusStatus(st0, st1)
			if (rec >= 18) {
				s += ' 温度' + (signed16(raw.subarray(o + 14, o + 16)) / 10) + '℃'
				s += ' 压力' + u16leRead(raw, o + 16) + 'kPa'
			}
			if (rec >= 26) {
				s += ' 环境温度' + (signed16(raw.subarray(o + 18, o + 20)) / 10) + '℃'
				s += ' 电导率' + signed16(raw.subarray(o + 20, o + 22)) + 'us/cm'
				s += ' 浊度' + (signed16(raw.subarray(o + 22, o + 24)) / 10) + 'NTU'
				s += ' 余氯' + (signed16(raw.subarray(o + 24, o + 26)) / 10) + 'mg/L'
			}
			lines.push(s)
		}
		return lines.join('\n')
	}
	function renderImgPack(raw, dataOff) {
		if (!raw || raw.length < 4) return hexbytes(raw || [])
		const total = raw[0]
		const cur = raw[1]
		const plen = u16leRead(raw, 2)
		const off = dataOff != null ? dataOff : 4
		const end = Math.min(raw.length, off + Math.min(plen, 16))
		return '包' + (cur + 1) + '/' + total + ' 本包' + plen + 'B 数据' + hexbytes(raw.subarray(off, end)) + (plen > 16 ? '…' : '')
	}

	// Tag5/6/9/20-27/94-99 记录值按「记录个数」重复 N 次
	function isSeriesValueId(tag, id) {
		if (tag === 5) return (id >= 3 && id <= 17) || id === 19
		if (tag === 6) return id === 3 || id === 4
		if (tag === 9) return id === 2
		if (tag >= 20 && tag <= 27) return id >= 3
		if (tag >= 94 && tag <= 99) return id >= 6 && id <= 21
		return false
	}

	function updateSeriesMeta(tag, id, raw, seriesMeta) {
		if (id === 0 && raw.length >= 6) seriesMeta.startStr = bcdTime(raw)
		if (tag === 5 || (tag >= 20 && tag <= 27)) {
			if (id === 1 && raw.length >= 2) seriesMeta.interval = u16leRead(raw, 0)
			if (id === 2 && raw.length >= 1) seriesMeta.count = raw[0]
		}
		if (tag === 6) {
			if (id === 1 && raw.length >= 1) seriesMeta.interval = raw[0]
			if (id === 2 && raw.length >= 1) seriesMeta.count = raw[0]
			if (seriesMeta.interval == null) seriesMeta.interval = 5
		}
		if (tag === 9) {
			if (id === 1 && raw.length >= 1) seriesMeta.count = raw[0]
		}
		if (tag >= 94 && tag <= 99) {
			if (id === 4 && raw.length >= 2) seriesMeta.interval = u16leRead(raw, 0)
			if (id === 5 && raw.length >= 1) seriesMeta.count = raw[0]
		}
		if (tag === 90 && id === 0 && raw.length >= 1) seriesMeta.count = raw[0]
	}

	function addMinutesToTimeStr(timeStr, mins) {
		const m = String(timeStr || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
		if (!m) return null
		const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
		if (isNaN(d.getTime())) return null
		d.setMinutes(d.getMinutes() + mins)
		return formatDateTime(d, 0)
	}

	function usesBaseWater(def) {
		if (!def) return false
		if (def.baseUnit) return true
		// 「基准水量」字段本身是枚举码, 不是流量读数
		if (def.name === '基准水量') return false
		const blob = (def.desc || '') + ' ' + (def.name || '') + ' ' + (def.type || '')
		if (/L\/h|℃|kPa|%|us\/cm|NTU|mg\/L|pH|分钟|秒|V\b|mA|mV|每圈/.test(blob)) return false
		// 「单位同基准水量」的流量类字段
		return /单位同.*基准水量|周期点总累积|周期累积|冻结累计|日结点总累计|密集时间点总累积|总累积流量|正累积流量|逆累积流量|净累积/.test(blob)
	}

	function rawNumeric(def, raw) {
		if (!raw || !raw.length) return null
		const desc = def ? (def.desc || '') : ''
		const type = def ? (def.type || '') : ''
		// 全 FF 视为异常
		let allFF = true
		for (let i = 0; i < raw.length; i++) if (raw[i] !== 0xff) { allFF = false; break }
		if (allFF) return null
		if (/int32 LE signed|Int32 LE signed/.test(desc) || type === 'BYTE[4]' && /带符号|signed/i.test(desc)) {
			return signed32(raw)
		}
		if (/Int16 LE signed|int16 LE signed/.test(desc) || type === 'BYTE[2]' && /signed|带符号|累积流量/.test(desc)) {
			return signed16(raw)
		}
		if (type === 'BYTE[4]' || raw.length === 4) return u32leRead(raw, 0)
		if (type === 'BYTE[2]' || raw.length === 2) return u16leRead(raw, 0)
		if (raw.length === 1) return raw[0]
		if (/BYTE\[1\+7\]/.test(type) && raw.length >= 8) {
			if (raw[0] & 1) return null
			return uNle(raw, 1, 7)
		}
		return null
	}

	function formatLiters(liters) {
		if (liters == null || !isFinite(liters)) return '—'
		const abs = Math.abs(liters)
		if (abs >= 1000) {
			const t = liters / 1000
			return (Math.round(t * 1000) / 1000) + ' m³'
		}
		if (abs > 0 && abs < 1) return (Math.round(liters * 1000) / 1000) + ' L'
		if (Number.isInteger(liters)) return liters + ' L'
		return (Math.round(liters * 1000) / 1000) + ' L'
	}

	function formatFlowWithBase(rawNum) {
		const b = W.skSession.baseLiters
		const liters = rawNum * b
		const unitNote = W.skSession.hasBase() ? '' : '·估'
		return formatLiters(liters) + unitNote + ' (×' + (W.skSession.hasBase() ? W.skSession.baseLabel : '1L默认') + ')'
	}

	function buildSeriesRows(def, raw, meta) {
		const elem = def ? typeLen(def.type) : null
		if (!elem || elem <= 0) return null
		const n = Math.floor(raw.length / elem)
		if (n <= 0) return null
		const interval = meta && meta.interval != null ? meta.interval : null
		const startStr = meta && meta.startStr
		const declared = meta && meta.count != null ? meta.count : null
		const daily = interval != null && interval >= 1440
		const base = usesBaseWater(def)
		let head = n + '条'
		if (declared != null && declared !== n) head += '(声明' + declared + '，实际' + n + ')'
		if (interval != null) {
			if (daily) head += ' · 日冻结'
			else head += ' · 间隔' + interval + '分钟'
		}
		if (startStr) head += ' · 起' + (daily ? String(startStr).slice(0, 10) : startStr)
		if (base) {
			head += W.skSession.hasBase()
				? (' · 基准' + W.skSession.baseLabel)
				: ' · ⚠未读基准(按1L)'
		}
		const rows = []
		for (let i = 0; i < n; i++) {
			const slice = raw.subarray(i * elem, (i + 1) * elem)
			const num = rawNumeric(def, slice)
			let val
			let plot = null
			if (base && num != null) {
				val = formatFlowWithBase(num)
				plot = num * W.skSession.baseLiters
			} else {
				val = renderValue(def, slice)
				plot = num
			}
			let label = '#' + (i + 1)
			if (startStr && interval != null) {
				const t = addMinutesToTimeStr(startStr, i * interval)
				if (t) label = daily ? t.slice(0, 10) : t
			}
			rows.push({ label: label, value: val, num: plot, raw: num })
		}
		// 统计
		const nums = rows.map(function (r) { return r.num }).filter(function (v) { return v != null && isFinite(v) })
		let stats = null
		if (nums.length) {
			let min = nums[0], max = nums[0], sum = 0
			for (let i = 0; i < nums.length; i++) {
				if (nums[i] < min) min = nums[i]
				if (nums[i] > max) max = nums[i]
				sum += nums[i]
			}
			const first = nums[0]
			const last = nums[nums.length - 1]
			stats = {
				min: min,
				max: max,
				avg: sum / nums.length,
				first: first,
				last: last,
				delta: last - first,
				count: nums.length
			}
			head += ' · Δ' + formatLiters(stats.delta) + ' · max' + formatLiters(stats.max)
		}
		return {
			summary: head,
			rows: rows,
			daily: daily,
			timeCol: daily ? '日期' : (interval != null ? '时间' : '序号'),
			base: base,
			stats: stats,
			chartable: nums.length >= 2
		}
	}
	function renderSeries(def, raw, meta) {
		const ser = buildSeriesRows(def, raw, meta)
		if (!ser) return hexbytes(raw)
		const lines = [ser.summary]
		const maxShow = 8
		for (let i = 0; i < ser.rows.length && i < maxShow; i++) {
			lines.push(ser.rows[i].label + ' → ' + ser.rows[i].value)
		}
		if (ser.rows.length > maxShow) lines.push('…共' + ser.rows.length + '条')
		return lines.join('\n')
	}

	function noteSessionFromParse(result) {
		if (!result || !result.fields) return
		const uid = result.fields['设备唯一编码']
		if (uid != null) W.skSession.touchDevice(uid)
		const tlv = result.tlv || []
		for (let i = 0; i < tlv.length; i++) {
			const tag = tlv[i].tag
			if (tag !== 2 && tag !== 3) continue
			const items = tlv[i].items || []
			for (let j = 0; j < items.length; j++) {
				if (items[j].id === 29 && items[j].raw && items[j].raw.length) {
					W.skSession.setBase(items[j].raw[0], tag === 2 ? 'Tag2-ID29' : 'Tag3-ID29')
				}
			}
		}
	}

	function seriesPanelHtml(it, tip) {
		const label = 'ID' + it.id + ' ' + escHtml(it.name || '')
		const serRows = it.seriesRows || []
		const chartable = it.seriesChartable !== false && serRows.length >= 2
		const payload = {
			rows: serRows.map(function (r) {
				return { t: r.label, v: r.num, s: r.value, raw: r.raw }
			}),
			daily: !!it.seriesDaily,
			summary: it.seriesSummary || '',
			baseLabel: W.skSession.hasBase() ? W.skSession.baseLabel : null
		}
		let h = '<div class="sk-series-panel' + (it.seriesDaily ? ' is-daily' : '') + '" title="' + tip + '">'
		h += '<div class="sk-series-head"><span class="sk-series-title">' + label + '</span>'
		h += '<span class="sk-parse-series-sum">' + escHtml(it.seriesSummary || '') + '</span></div>'
		if (it.seriesStats) {
			const st = it.seriesStats
			h += '<div class="sk-series-stats">'
			h += '<span>点数 ' + st.count + '</span>'
			h += '<span>最小 ' + escHtml(formatLiters(st.min)) + '</span>'
			h += '<span>最大 ' + escHtml(formatLiters(st.max)) + '</span>'
			h += '<span>起 ' + escHtml(formatLiters(st.first)) + '</span>'
			h += '<span>止 ' + escHtml(formatLiters(st.last)) + '</span>'
			h += '<span class="sk-series-delta">Δ ' + escHtml(formatLiters(st.delta)) + '</span>'
			h += '</div>'
		}
		if (chartable) {
			h += '<div class="sk-series-chart-box">'
			h += '<canvas class="sk-series-canvas" width="560" height="148" data-sk-series="' +
				escHtml(JSON.stringify(payload)) + '"></canvas>'
			h += '<div class="sk-series-tip" hidden></div>'
			h += '</div>'
		}
		const timeCol = escHtml(it.seriesTimeCol || '序号')
		h += '<details class="sk-series-details"' + (chartable ? '' : ' open') + '>'
		h += '<summary>明细表 ' + serRows.length + ' 条' + (chartable ? '（默认折叠，点开查看）' : '') + '</summary>'
		h += '<div class="sk-parse-series-wrap"><table class="sk-parse-series-table"><thead><tr><th>' +
			timeCol + '</th><th>数值</th></tr></thead><tbody>'
		for (let ri = 0; ri < serRows.length; ri++) {
			const row = serRows[ri]
			h += '<tr><td class="sk-ser-t">' + escHtml(row.label) + '</td><td class="sk-ser-v">' +
				escHtml(row.value) + '</td></tr>'
		}
		h += '</tbody></table></div></details></div>'
		return h
	}

	function resultCodeName(code) {
		const m = W.SK_RESULT_CODES && W.SK_RESULT_CODES.Tag11
		if (m && m[code] != null) return m[code]
		return '结果码' + code
	}

	// 0x81 参数设置应答 / 0x91 指令操作应答: 每个 ID 的 Value 为 1B 处理结果码(Tag11)
	function isResultValueFunc(fc) {
		if (fc == null) return false
		const key = '0x' + (fc & 0xff).toString(16).toUpperCase().padStart(2, '0')
		const def = W.SK_FUNC_CODES && W.SK_FUNC_CODES[key]
		return !!(def && def.resultValue)
	}

	function parseTagItems(tag, payload, opt) {
		const defs = W.SK_TAGS[tag] || []
		const idMap = {}
		for (const d of defs) idMap[d.id] = d
		const items = []
		const resultMode = !!(opt && opt.resultMode)
		const seriesMeta = {
			startStr: null,
			interval: tag === 9 ? 1440 : (tag === 6 ? 5 : null),
			count: null
		}
		let j = 0
		while (j < payload.length) {
			const id = payload[j++]
			const def = idMap[id]
			// 应答帧: ID(1B) + 结果码(1B), 不按参数类型取长度
			if (resultMode) {
				const name = def ? def.name : ('ID' + id)
				if (j >= payload.length) {
					items.push({ id, name, raw: [], decoded: '(缺结果码)', resultCode: null })
					break
				}
				const code = payload[j++] & 0xff
				items.push({
					id,
					name,
					raw: [code],
					decoded: resultCodeName(code),
					resultCode: code
				})
				continue
			}
			// 总线表列表: 按个数×记录长度消费
			if (def && def.dec && def.dec.t === 'busMeters') {
				const rec = def.dec.rec || 14
				let cnt = seriesMeta.count
				if (cnt == null || cnt <= 0) cnt = Math.floor((payload.length - j) / rec)
				let need = cnt * rec
				const remain = payload.length - j
				if (need > remain) need = Math.floor(remain / rec) * rec
				if (need <= 0) need = Math.min(rec, remain)
				const raw = payload.subarray(j, j + need)
				j += need
				items.push({
					id,
					name: def.name || ('ID' + id),
					raw: Array.from(raw),
					decoded: renderBusMeters(raw, rec)
				})
				continue
			}
			// 图片/音频分包头: 总包+序号+长度[+音源类型]+数据, 变长
			if (def && (def.dec && def.dec.t === 'imgPack' || /BYTE\[1\+1\+2(?:\+1)?\+n\]/.test(def.type || ''))) {
				const remain = payload.length - j
				const extra = /BYTE\[1\+1\+2\+1\+n\]/.test(def.type || '') ? 1 : 0
				const hdr = 4 + extra
				if (remain < hdr) {
					const raw = payload.subarray(j)
					j = payload.length
					items.push({ id, name: def.name, raw: Array.from(raw), decoded: hexbytes(raw) + ' (不完整)', partial: true })
					break
				}
				const plen = u16leRead(payload, j + 2)
				let need = hdr + plen
				if (need > remain) need = remain
				const raw = payload.subarray(j, j + need)
				j += need
				let decoded = renderImgPack(raw, hdr)
				if (extra && raw.length >= 5) {
					const srcMap = { 0: '正常音频', 1: '参照音频', 2: '相干音频' }
					const src = raw[4]
					decoded = (srcMap[src] != null ? srcMap[src] : ('音源' + src)) + ' ' + decoded
				}
				items.push({
					id,
					name: def.name,
					raw: Array.from(raw),
					decoded: decoded,
					partial: need < hdr + plen
				})
				continue
			}
			let vlen = def ? typeLen(def.type) : null
			if (vlen === null) {
				let k = j
				while (k < payload.length && !idMap[payload[k]]) k++
				vlen = k - j
				if (vlen <= 0) vlen = 1
				const raw = payload.subarray(j, j + vlen)
				j = k
				items.push({ id, name: def ? def.name : ('ID' + id + '(未知)'), raw: Array.from(raw), decoded: hexbytes(raw) })
				continue
			}
			// NULL: 无 Value,仅 ID(信息查询码等)
			if (vlen === 0 && def && def.type === 'NULL') {
				items.push({
					id,
					name: def.name || ('ID' + id),
					raw: [],
					decoded: '(无参数)'
				})
				continue
			}
			//定长 0 的其它字段(嵌套 TLV 容器):消费剩余字节并递归解析,避免 j+=0 死循环
			if (vlen === 0) {
				const raw = payload.subarray(j)
				items.push({
					id,
					name: def ? def.name : ('ID' + id),
					raw: Array.from(raw),
					decoded: '嵌套TLV: ' + nestedTlvText(raw)
				})
				j = payload.length
				break
			}
			// Tag5/9 记录值: Value = 记录个数 × 单条长度
			if (isSeriesValueId(tag, id) && vlen > 0) {
				const elem = vlen
				let cnt = seriesMeta.count
				if (cnt == null || cnt <= 0) cnt = Math.floor((payload.length - j) / elem)
				let need = cnt * elem
				const remain = payload.length - j
				if (need > remain) need = Math.floor(remain / elem) * elem
				if (need < elem && remain >= elem) need = elem
				if (need <= 0) need = Math.min(elem, remain)
				const raw = payload.subarray(j, j + need)
				j += need
				const ser = buildSeriesRows(def, raw, seriesMeta)
				items.push({
					id,
					name: def ? def.name : ('ID' + id),
					raw: Array.from(raw),
					decoded: ser ? ser.summary : renderSeries(def, raw, seriesMeta),
					series: true,
					seriesSummary: ser ? ser.summary : '',
					seriesRows: ser ? ser.rows : null,
					seriesTimeCol: ser ? ser.timeCol : '序号',
					seriesDaily: ser ? !!ser.daily : false,
					seriesStats: ser ? ser.stats : null,
					seriesChartable: ser ? !!ser.chartable : false,
					seriesBase: ser ? !!ser.base : false
				})
				// 截断尾渣: 不足一条记录或下一固定字段时丢弃, 避免伪 ID
				if (j < payload.length) {
					const left = payload.length - j
					if (left < elem) break
					const nid = payload[j]
					const ndef = idMap[nid]
					const nlen = ndef ? typeLen(ndef.type) : null
					if (nlen != null && nlen > 0 && 1 + nlen > left) break
					if (nlen == null && left < 2) break
				}
				continue
			}
			if (j + vlen > payload.length) {
				// 字段值被截断: 展示已有字节并停止, 避免尾部残渣再被解成伪 ID
				const raw = payload.subarray(j)
				j = payload.length
				items.push({
					id,
					name: def ? def.name : ('ID' + id),
					raw: Array.from(raw),
					decoded: (renderValue(def, raw) || hexbytes(raw)) + ' (不完整)',
					partial: true
				})
				break
			}
			const raw = payload.subarray(j, j + vlen)
			j += vlen
			let decoded = renderValue(def, raw)
			// 单点流量字段: 有基准则换算为升
			if (usesBaseWater(def) && raw && raw.length) {
				const num = rawNumeric(def, raw)
				if (num != null) decoded = formatFlowWithBase(num)
			}
			// 捕获基准水量到会话
			if ((tag === 2 || tag === 3) && id === 29 && raw && raw.length) {
				W.skSession.setBase(raw[0], tag === 2 ? 'Tag2-ID29' : 'Tag3-ID29')
			}
			items.push({
				id,
				name: def ? def.name : ('ID' + id),
				raw: Array.from(raw),
				decoded
			})
			updateSeriesMeta(tag, id, raw, seriesMeta)
		}
		return items
	}

	function parseTlv(data, opt) {
		const tlv = []
		let i = 0
		while (i + 3 <= data.length) {
			const tag = data[i]
			const len = u16leRead(data, i + 1)
			if (tag === 0 && len === 0) {
				i += 3
				continue
			}
			if (i + 3 + len > data.length) {
				const payload = data.subarray(i + 3)
				tlv.push({
					tag,
					name: W.SK_TAG_NAME[tag] || ('Tag' + tag),
					payloadBytes: Array.from(payload),
					items: parseTagItems(tag, payload, opt),
					error: 'truncated',
					len,
					actualLen: payload.length
				})
				break
			}
			const payload = data.subarray(i + 3, i + 3 + len)
			i += 3 + len
			tlv.push({
				tag,
				name: W.SK_TAG_NAME[tag] || ('Tag' + tag),
				payloadBytes: Array.from(payload),
				items: parseTagItems(tag, payload, opt),
				len
			})
		}
		return tlv
	}

	function extractTlv(pt, opt) {
		if (pt.length >= 2) {
			const plainLen = u16leRead(pt, 0)
			if (2 + plainLen <= pt.length) {
				const region = pt.subarray(2, 2 + plainLen)
				const tags = parseTlv(region, opt)
				if (tags.length) return tags
			} else if (plainLen > 0 && pt.length > 2) {
				// 明文长度超出实际数据(截断帧):仍按去掉 2B 前缀解析
				const tags = parseTlv(pt.subarray(2), opt)
				if (tags.length) return tags
			}
		}
		return parseTlv(pt, opt)
	}

	//把嵌套 TLV 区域压缩成简短文本(供 NULL 容器字段展示)
	function nestedTlvText(bytes) {
		try {
			const sub = parseTlv(bytes)
			if (!sub.length) return hexbytes(bytes)
			return sub.map((t) => {
				const parts = (t.items || []).map((it) => 'ID' + it.id + ' ' + (it.name || '') + (it.decoded ? '=' + it.decoded : '')).join('; ')
				return 'Tag' + t.tag + (t.name ? ' ' + t.name : '') + (parts ? ' [' + parts + ']' : '')
			}).join(' | ')
		} catch (e) {
			return hexbytes(bytes)
		}
	}

	function resolveKey(opt) {
		if (opt && opt.keyHex) {
			const raw = toBytes(opt.keyHex)
			const len = raw.length >= 32 ? 32 : 16
			return raw.subarray(0, len)
		}
		const asciiKey = opt && opt.keyAscii
		if (!asciiKey) return null
		let bytes
		if (typeof TextEncoder !== 'undefined') {
			bytes = new TextEncoder().encode(asciiKey)
		} else {
			bytes = new Uint8Array(asciiKey.length)
			for (let i = 0; i < asciiKey.length; i++) bytes[i] = asciiKey.charCodeAt(i) & 0xff
		}
		if (bytes.length >= 32) {
			return bytes.subarray(0, 32)
		}
		const k = new Uint8Array(16)
		k.set(bytes.subarray(0, 16))
		return k
	}

	function decryptData(enc, opt) {
		try {
			const k = resolveKey(opt)
			if (!k) return { ok: false, needKey: true }
			const out = W.skAesEcbDecrypt(new Uint8Array(enc), k)
			return { ok: true, bytes: out }
		} catch (e) {
			return { ok: false, error: String(e) }
		}
	}

	// 单帧数据域合理上限(防把噪声/半帧误判成长帧)
	const SK_MAX_DATA_LEN = 4096

	// 声明长度超出缓冲时: 有 0x16 则回退实际长度; 否则按截断帧尽量解 TLV
	function resolveFrameSpan(b, dataOffset, declaredLen) {
		const out = {
			declaredLen: declaredLen,
			dataLen: declaredLen,
			dataBytes: null,
			crcRecv: 0,
			crcCalc: 0,
			endByte: 0,
			truncated: false,
			missingTail: false
		}
		if (declaredLen < 0 || declaredLen > SK_MAX_DATA_LEN) return null
		if (b.length < dataOffset) return null
		let crcOffset = dataOffset + declaredLen
		if (crcOffset + 3 <= b.length) {
			out.dataBytes = b.subarray(dataOffset, crcOffset)
			out.crcRecv = u16leRead(b, crcOffset)
			out.crcCalc = W.skCrc16(b.subarray(0, crcOffset))
			out.endByte = b[crcOffset + 2]
			return out
		}
		// 声明超长: 末尾是结束符时按实长回退
		if (b.length >= dataOffset + 3 && b[b.length - 1] === 0x16) {
			const actual = b.length - dataOffset - 3
			if (actual < 0) return null
			crcOffset = dataOffset + actual
			out.dataLen = actual
			out.dataBytes = b.subarray(dataOffset, crcOffset)
			out.crcRecv = u16leRead(b, crcOffset)
			out.crcCalc = W.skCrc16(b.subarray(0, crcOffset))
			out.endByte = b[crcOffset + 2]
			out.truncated = actual !== declaredLen
			return out
		}
		// 真截断: 无 CRC/结束符, 剩余字节全部当作数据域尽力解析
		if (b.length > dataOffset) {
			out.dataBytes = b.subarray(dataOffset)
			out.truncated = true
			out.missingTail = true
			out.endByte = b[b.length - 1]
			return out
		}
		return null
	}

	function tryParseUp(b, opt) {
		if (b.length < 24) return null
		const declaredLen = u16leRead(b, 22)
		const span = resolveFrameSpan(b, 24, declaredLen)
		if (!span) return null
		const dataBytes = span.dataBytes
		const ctrl = b[21]
		const encrypted = (ctrl & 0x01) === 1
		let dec = { ok: true, bytes: dataBytes, needKey: false }
		if (encrypted) {
			dec = decryptData(dataBytes, opt)
		}
		let tlvBytes = new Uint8Array(0)
		let plainBytesArr = []
		const needKey = encrypted && dec.needKey === true
		if (!needKey) {
			const pt = dec.ok ? new Uint8Array(dec.bytes) : new Uint8Array(dataBytes)
			tlvBytes = pt
			plainBytesArr = Array.from(pt)
		}
		const fc = b[20]
		const tlvOpt = isResultValueFunc(fc) ? { resultMode: true } : null
		const fields = {
			帧序号: u16leRead(b, 2),
			协议版本号: { value: b[4], name: W.SK_PROTOCOL_VERSION[b[4]] || '保留' },
			厂家编号: { value: b[5], name: W.SK_MANUFACTURER[b[5]] || '其他' },
			设备类型: b[6],
			设备唯一编码: bcdDecode(b.subarray(7, 14)),
			信号强度RSRP: signed16(b.subarray(14, 16)),
			信噪比SNR: signed16(b.subarray(16, 18)),
			覆盖等级ECL: b[18],
			信号质量CSQ: b[19],
			功能码: { value: fc, name: (W.SK_FUNC_CODES['0x' + fc.toString(16).toUpperCase().padStart(2, '0')] || {}).name || '' },
			控制码: { raw: ctrl, 后续帧: (ctrl & 0x80) === 0x80, 加密: encrypted },
			// 字段展示声明长度; 截断时 actualDataLen 见返回值
			数据域字节数: declaredLen,
			帧结束符: span.endByte
		}
		return {
			dir: 'up',
			crcOk: !span.missingTail && span.crcRecv === span.crcCalc,
			crcCalc: span.crcCalc,
			crcRecv: span.crcRecv,
			endOk: !span.missingTail && span.endByte === 0x16,
			truncated: span.truncated,
			missingTail: span.missingTail,
			actualDataLen: dataBytes.length,
			encrypted,
			decryptOk: dec.ok,
			needKey,
			fields,
			tlv: extractTlv(tlvBytes, tlvOpt),
			dataBytes: Array.from(dataBytes),
			plainBytes: plainBytesArr
		}
	}

	function tryParseDown(b, opt) {
		if (b.length < 16) return null
		const declaredLen = u16leRead(b, 14)
		const span = resolveFrameSpan(b, 16, declaredLen)
		if (!span) return null
		const dataBytes = span.dataBytes
		const ctrl = b[13]
		const encrypted = (ctrl & 0x01) === 1
		let dec = { ok: true, bytes: dataBytes, needKey: false }
		if (encrypted) dec = decryptData(dataBytes, opt)
		let tlvBytes = new Uint8Array(0)
		let plainBytesArr = []
		const needKey = encrypted && dec.needKey === true
		if (!needKey) {
			const pt = dec.ok ? new Uint8Array(dec.bytes) : new Uint8Array(dataBytes)
			tlvBytes = pt
			plainBytesArr = Array.from(pt)
		}
		const timeBytes = b.subarray(5, 12)
		const fc = b[12]
		const tlvOpt = isResultValueFunc(fc) ? { resultMode: true } : null
		const fields = {
			帧序号: u16leRead(b, 2),
			协议版本号: { value: b[4], name: W.SK_PROTOCOL_VERSION[b[4]] || '保留' },
			平台时间: bcdTime(timeBytes),
			平台时间BCD: hexbytes(timeBytes),
			功能码: { value: fc, name: (W.SK_FUNC_CODES['0x' + fc.toString(16).toUpperCase().padStart(2, '0')] || {}).name || '' },
			控制码: { raw: ctrl, 后续帧: (ctrl & 0x80) === 0x80, 加密: encrypted },
			数据域字节数: declaredLen,
			帧结束符: span.endByte
		}
		return {
			dir: 'down',
			crcOk: !span.missingTail && span.crcRecv === span.crcCalc,
			crcCalc: span.crcCalc,
			crcRecv: span.crcRecv,
			endOk: !span.missingTail && span.endByte === 0x16,
			truncated: span.truncated,
			missingTail: span.missingTail,
			actualDataLen: dataBytes.length,
			encrypted,
			decryptOk: dec.ok,
			needKey,
			fields,
			tlv: extractTlv(tlvBytes, tlvOpt),
			dataBytes: Array.from(dataBytes),
			plainBytes: plainBytesArr
		}
	}

	W.skParseFrame = function (bytes, opt) {
		opt = opt || {}
		const b = toBytes(bytes)
		const errors = []
		const raw = Array.from(b)
		const result = { dir: 'unknown', raw, ok: false, crcOk: false, crcCalc: 0, crcRecv: 0, encrypted: false, decryptOk: false, needKey: false, fields: {}, tlv: [], errors }
		if (b.length < 2) {
			errors.push('报文过短')
			return result
		}
		if (b[0] !== 0xA9 || b[1] !== 0x9A) errors.push('帧起始符错误')
		const up = tryParseUp(b, opt)
		const down = tryParseDown(b, opt)
		// 短下行帧数据域末尾若为 00 00，上行 dataLen=0 会与下行 CRC 覆盖范围重合，
		// 不能简单优先 up，需按长度吻合 + 功能码语义打分。
		const scoreParse = (p) => {
			if (!p) return -1e9
			let s = 0
			if (p.endOk) s += 20
			if (p.crcOk) s += 40
			const dataLen = p.fields && p.fields['数据域字节数'] != null ? p.fields['数据域字节数'] : -1
			const exp = (p.dir === 'up' ? 24 : 16) + dataLen + 3
			if (b.length === exp) s += 50
			else if (p.truncated && b.length < exp) s += 20 // 截断帧: 长度不足是预期情况
			else s -= 30
			const fcObj = p.fields && p.fields['功能码']
			const fc = fcObj && typeof fcObj === 'object' ? fcObj.value : fcObj
			const downFc = [0x01, 0x03, 0x04, 0x11]
			const upFc = [0x02, 0x81, 0x82, 0x83, 0x84, 0x91]
			if (p.dir === 'down' && downFc.indexOf(fc) >= 0) s += 25
			if (p.dir === 'up' && upFc.indexOf(fc) >= 0) s += 25
			if (p.dir === 'down' && upFc.indexOf(fc) >= 0) s -= 15
			if (p.dir === 'up' && downFc.indexOf(fc) >= 0) s -= 15
			if (p.tlv && p.tlv.length) s += 8
			if (p.tlv && p.tlv.some(function (t) { return t.error })) s -= 12
			// 截断但仍解出 TLV 时加分, 避免被判「无法解析」
			if (p.truncated && p.tlv && p.tlv.length) s += 18
			// 退化：上行 dataLen=0 但帧明显长于空数据域最小长度时降权
			if (p.dir === 'up' && dataLen === 0 && b.length > 27) s -= 20
			// 截断且完全无 TLV 时略降权
			if (p.truncated && (!p.tlv || !p.tlv.length)) s -= 10
			return s
		}
		let chosen = null
		const su = scoreParse(up)
		const sd = scoreParse(down)
		if (up || down) {
			if (sd > su) chosen = down
			else if (su > sd) chosen = up
			else chosen = (up && up.crcOk && up.endOk) ? up : (down && down.crcOk && down.endOk) ? down : (up || down)
		}
		if (!chosen) {
			errors.push('无法解析')
			return result
		}
		result.dir = chosen.dir
		result.crcOk = chosen.crcOk
		result.crcCalc = chosen.crcCalc
		result.crcRecv = chosen.crcRecv
		result.endOk = !!chosen.endOk
		result.encrypted = chosen.encrypted
		result.decryptOk = chosen.decryptOk
		result.needKey = !!chosen.needKey
		result.truncated = !!chosen.truncated
		result.missingTail = !!chosen.missingTail
		result.actualDataLen = chosen.actualDataLen
		result.fields = chosen.fields
		result.tlv = chosen.tlv
		result.dataBytes = chosen.dataBytes || []
		result.plainBytes = chosen.plainBytes || []
		result.ok = chosen.crcOk && chosen.endOk && !chosen.truncated
		const expectedLen = (chosen.dir === 'up' ? 24 : 16) + chosen.fields.数据域字节数 + 3
		if (chosen.truncated || chosen.missingTail || b.length < expectedLen) {
			errors.push('报文截断: 声明数据域' + chosen.fields.数据域字节数 + '字节(整帧' + expectedLen + '), 实际' + b.length + '字节')
		}
		if (chosen.needKey) errors.push('加密报文,请输入密钥')
		else if (!chosen.missingTail && !chosen.endOk) {
			errors.push('帧结束符错误 期望0x16 实际0x' + (chosen.fields.帧结束符 & 0xff).toString(16))
		}
		if (!chosen.missingTail && !chosen.crcOk) {
			errors.push('CRC校验失败 收到0x' + chosen.crcRecv.toString(16) + ' 计算0x' + chosen.crcCalc.toString(16))
		} else if (chosen.missingTail) {
			errors.push('缺少CRC与帧结束符(帧未收完)')
		}
		if (chosen.encrypted && !chosen.needKey && !chosen.decryptOk) errors.push('AES解密失败')
		if (!chosen.truncated && !chosen.missingTail && b.length !== expectedLen) {
			errors.push('报文长度不符 期望' + expectedLen + ' 实际' + b.length)
		}
		// 会话: 设备唯一码 / 基准水量
		noteSessionFromParse(result)
		// 同帧基准在序列之后出现时, 回算 series 行/统计
		if (W.skSession.hasBase() && result.tlv && result.tlv.length) {
			applyBaseToSeriesTlv(result.tlv)
		}
		result.sessionBase = {
			has: W.skSession.hasBase(),
			code: W.skSession.baseCode,
			liters: W.skSession.baseLiters,
			label: W.skSession.baseLabel,
			source: W.skSession.baseSource,
			deviceUid: W.skSession.deviceUid
		}
		return result
	}

	function applyBaseToSeriesTlv(tlv) {
		const b = W.skSession.baseLiters
		for (let i = 0; i < tlv.length; i++) {
			const items = tlv[i].items || []
			for (let j = 0; j < items.length; j++) {
				const it = items[j]
				if (!it.series || !it.seriesRows || !it.seriesRows.length) continue
				if (!it.seriesBase) continue
				let min = null, max = null, sum = 0, n = 0
				for (let k = 0; k < it.seriesRows.length; k++) {
					const r = it.seriesRows[k]
					if (r.raw == null || !isFinite(r.raw)) continue
					r.num = r.raw * b
					r.value = formatFlowWithBase(r.raw)
					if (min == null || r.num < min) min = r.num
					if (max == null || r.num > max) max = r.num
					sum += r.num
					n++
				}
				if (n > 0) {
					const first = it.seriesRows.find(function (x) { return x.num != null })
					const last = it.seriesRows.slice().reverse().find(function (x) { return x.num != null })
					it.seriesStats = {
						min: min, max: max, avg: sum / n,
						first: first ? first.num : min,
						last: last ? last.num : max,
						delta: (last && first) ? (last.num - first.num) : 0,
						count: n
					}
					// 刷新摘要中的 Δ/max/基准标记
					let sumry = it.seriesSummary || ''
					sumry = sumry.replace(/⚠未读基准\(按1L\)/, '基准' + W.skSession.baseLabel)
					sumry = sumry.replace(/· 基准[^·]+/, '· 基准' + W.skSession.baseLabel)
					if (sumry.indexOf('基准') < 0) sumry += ' · 基准' + W.skSession.baseLabel
					sumry = sumry.replace(/· Δ[^·]+/, '')
					sumry = sumry.replace(/· max[^·]+/, '')
					sumry += ' · Δ' + formatLiters(it.seriesStats.delta) + ' · max' + formatLiters(it.seriesStats.max)
					it.seriesSummary = sumry
					it.decoded = sumry
				}
			}
		}
	}

	//在脏字节流中扫描 A9 9A，按声明长度+CRC+EOF 截取首个有效帧
	W.skFindFrame = function (bytes, opt) {
		opt = opt || {}
		const b = toBytes(bytes)
		const empty = { found: false, offset: 0, length: b.length, frame: b, prefix: 0, suffix: 0 }
		if (b.length < 19) return empty

		function acceptSlice(slice, offset) {
			if (!slice || slice.length < 19) return null
			const r = W.skParseFrame(slice, opt)
			// skParseFrame.ok = CRC 通过且结束符 0x16（加密缺密钥时仍可为 ok）
			if (!r || !r.ok) return null
			const dataLen = r.fields && r.fields['数据域字节数']
			if (dataLen == null || dataLen < 0) return null
			const exp = (r.dir === 'up' ? 24 : 16) + dataLen + 3
			if (exp < 19 || exp > slice.length) return null
			const frame = exp === slice.length ? new Uint8Array(slice) : new Uint8Array(slice.subarray(0, exp))
			let parse = r
			if (exp !== slice.length) {
				const r2 = W.skParseFrame(frame, opt)
				if (r2 && r2.ok) parse = r2
			}
			return { offset: offset, length: exp, frame: frame, parse: parse }
		}

		let best = null
		for (let i = 0; i + 19 <= b.length; i++) {
			if (b[i] !== 0xA9 || b[i + 1] !== 0x9A) continue
			const slices = []
			if (i + 16 <= b.length) {
				const dl = u16leRead(b, i + 14)
				const exp = 16 + dl + 3
				if (dl >= 0 && exp >= 19 && exp <= 8192 && i + exp <= b.length) {
					slices.push(b.subarray(i, i + exp))
				}
			}
			if (i + 24 <= b.length) {
				const dl = u16leRead(b, i + 22)
				const exp = 24 + dl + 3
				if (dl >= 0 && exp >= 27 && exp <= 8192 && i + exp <= b.length) {
					slices.push(b.subarray(i, i + exp))
				}
			}
			slices.push(b.subarray(i))
			for (let s = 0; s < slices.length; s++) {
				const cand = acceptSlice(slices[s], i)
				if (!cand) continue
				if (!best || cand.offset < best.offset || (cand.offset === best.offset && cand.length < best.length)) {
					best = cand
				}
			}
			if (best && best.offset === i) break
		}

		if (!best) return empty
		return {
			found: true,
			offset: best.offset,
			length: best.length,
			frame: best.frame,
			parse: best.parse,
			prefix: best.offset,
			suffix: b.length - best.offset - best.length
		}
	}

	W.skFormatFrame = function (p) {
		const dirArrow = p.dir === 'up' ? '↑' : p.dir === 'down' ? '↓' : '?'
		const status = (p.crcOk ? '✓' : '✗') + (p.encrypted ? ' 🔒' : '') + (p.truncated || p.missingTail ? ' ⚠截断' : '')
		let h = '<div class="sk-parse">'
		h += '<div class="sk-parse-bar">' + dirArrow + ' ' + status + '</div>'
		// 会话基准水量条
		const sb = p.sessionBase || {
			has: W.skSession.hasBase(),
			label: W.skSession.baseLabel,
			source: W.skSession.baseSource
		}
		if (sb.has) {
			h += '<div class="sk-base-banner is-ok">基准水量 <b>' + escHtml(sb.label) + '</b>'
			if (sb.source) h += ' <span class="sk-base-src">(' + escHtml(sb.source) + '·本会话)</span>'
			h += ' · 流量已换算为升/立方米</div>'
		} else {
			const needBase = (p.tlv || []).some(function (t) {
				return (t.items || []).some(function (it) { return it.seriesBase || (it.decoded && String(it.decoded).indexOf('1L默认') >= 0) })
			})
			if (needBase || (p.tlv || []).some(function (t) { return t.tag === 5 || t.tag === 9 || (t.tag >= 94 && t.tag <= 99) })) {
				h += '<div class="sk-base-banner is-warn">⚠ 未读到基准水量(Tag2/3 ID29)，流量暂按 <b>1L/圈</b> 显示 · 建议先「查询核心数据」或「查询终端参数」</div>'
			}
		}
		const f = p.fields || {}
		const cells = []
		const filterKeys = ['帧结束符', '数据域字节数', '平台时间BCD', '控制码']
		for (const k in f) {
			if (filterKeys.includes(k)) continue
			const v = f[k]
			let val
			if (v == null) val = ''
			else if (typeof v === 'object' && !Array.isArray(v)) {
				if (v.name !== undefined) val = v.value + (v.name ? ' (' + v.name + ')' : '')
				else {
					const parts = []
					for (const key in v) {
						if (key === '后续帧') continue
						const kv = v[key]
						parts.push(kv && typeof kv === 'object' ? (kv.value + (kv.name ? '(' + kv.name + ')' : '')) : kv)
					}
					val = parts.join(', ')
				}
			} else val = escHtml(String(v))
			cells.push({ name: k, value: val })
		}
		if (cells.length) {
			const COLS = 4
			h += '<table class="sk-parse-grid"><tbody>'
			for (let i = 0; i < cells.length; i += COLS) {
				h += '<tr>'
				for (let j = 0; j < COLS; j++) {
					const c = cells[i + j]
					h += '<td class="sk-parse-hdr">' + (c ? escHtml(c.name) : '') + '</td>'
				}
				h += '</tr><tr>'
				for (let j = 0; j < COLS; j++) {
					const c = cells[i + j]
					h += '<td>' + (c ? c.value : '') + '</td>'
				}
				h += '</tr>'
			}
			h += '</tbody></table>'
		}
		if (p.tlv && p.tlv.length) {
			h += '<div class="sk-parse-tlvs">'
			for (const t of p.tlv) {
				h += '<details class="sk-parse-tag" open><summary>Tag' + t.tag + ' ' + escHtml(t.name || '') + '</summary>'
				if (t.error) h += ' <span class="sk-parse-bad">' + escHtml(t.error) + '</span>'
				if (t.items && t.items.length) {
					h += '<div class="sk-parse-items">'
					for (const it of t.items) {
						const tip = 'raw:' + escHtml(hexbytes(it.raw))
						const label = 'ID' + it.id + ' ' + escHtml(it.name || '') + ' = '
						if (it.series && it.seriesRows && it.seriesRows.length) {
							h += seriesPanelHtml(it, tip)
						} else if (it.series) {
							const body = escHtml(it.decoded || hexbytes(it.raw))
							h += '<div class="sk-parse-series" title="' + tip + '">' + label + body + '</div>'
						} else {
							const body = escHtml(it.decoded || hexbytes(it.raw))
							h += '<span class="sk-parse-item" title="' + tip + '">' + label + body + '</span>'
						}
					}
					h += '</div>'
				}
				h += '</details>'
			}
			h += '</div>'
		}
		if (p.errors && p.errors.length) {
			h += '<div class="sk-parse-errors">'
			for (const e of p.errors) h += '<div>' + escHtml(e) + '</div>'
			h += '</div>'
		}
		h += '</div>'
		return h
	}

	//生成「字节偏移 -> {tip, grp}」映射,供日志 HEX 悬停提示使用
	//grp 相同的字节在悬停时一起高亮(同一字段 / 同一 TLV ID)
	W.skByteMap = function (r) {
		const raw = (r.raw instanceof Uint8Array) ? r.raw : Uint8Array.from(r.raw || [])
		const n = raw.length
		const map = new Array(n).fill('')
		const dir = r.dir
		if (dir !== 'up' && dir !== 'down') return map
		const hx = (b) => '0x' + (b & 0xff).toString(16).toUpperCase().padStart(2, '0')
		const set = (off, len, tip, grp) => {
			for (let k = 0; k < len; k++) {
				if (off + k < n) map[off + k] = { tip: tip, grp: grp }
			}
		}
		const fieldLabel = (name, v) => {
			let s
			if (v == null) s = ''
			else if (typeof v === 'object') {
				if (Array.isArray(v)) s = v.join(' ')
				else if (v.name !== undefined && v.value !== undefined) {
					s = v.value + (v.name ? ' (' + v.name + ')' : '')
				} else {
					const parts = []
					for (const key in v) {
						const val = v[key]
						if (val && typeof val === 'object' && val.name !== undefined) {
							parts.push(key + '=' + (val.name ? val.value + '(' + val.name + ')' : val.value))
						} else if (typeof val === 'boolean') {
							parts.push(key + '=' + (val ? '是' : '否'))
						} else {
							parts.push(key + '=' + val)
						}
					}
					s = parts.join(' ')
				}
			} else s = String(v)
			return name + (s ? ' = ' + s : '')
		}
		let dataOffset
		if (dir === 'up') {
			dataOffset = 24
			set(0, 2, '帧起始符 ' + hx(raw[0]) + ' ' + hx(raw[1]), 'h0')
			set(2, 2, fieldLabel('帧序号', r.fields['帧序号']), 'h2')
			set(4, 1, fieldLabel('协议版本号', r.fields['协议版本号']), 'h4')
			set(5, 1, fieldLabel('厂家编号', r.fields['厂家编号']), 'h5')
			set(6, 1, fieldLabel('设备类型', r.fields['设备类型']), 'h6')
			set(7, 7, fieldLabel('设备唯一编码', r.fields['设备唯一编码']), 'h7')
			set(14, 2, fieldLabel('信号强度RSRP', r.fields['信号强度RSRP']), 'h14')
			set(16, 2, fieldLabel('信噪比SNR', r.fields['信噪比SNR']), 'h16')
			set(18, 1, fieldLabel('覆盖等级ECL', r.fields['覆盖等级ECL']), 'h18')
			set(19, 1, fieldLabel('信号质量CSQ', r.fields['信号质量CSQ']), 'h19')
			set(20, 1, fieldLabel('功能码', r.fields['功能码']), 'h20')
			set(21, 1, fieldLabel('控制码', r.fields['控制码']), 'h21')
			set(22, 2, fieldLabel('数据域字节数', r.fields['数据域字节数']), 'h22')
		} else {
			dataOffset = 16
			set(0, 2, '帧起始符 ' + hx(raw[0]) + ' ' + hx(raw[1]), 'h0')
			set(2, 2, fieldLabel('帧序号', r.fields['帧序号']), 'h2')
			set(4, 1, fieldLabel('协议版本号', r.fields['协议版本号']), 'h4')
			set(5, 7, fieldLabel('平台时间', r.fields['平台时间']), 'h5')
			set(12, 1, fieldLabel('功能码', r.fields['功能码']), 'h12')
			set(13, 1, fieldLabel('控制码', r.fields['控制码']), 'h13')
			set(14, 2, fieldLabel('数据域字节数', r.fields['数据域字节数']), 'h14')
		}
		const dataLen = r.fields['数据域字节数'] || 0
		const crcOffset = dataOffset + dataLen
		// 截断帧: 只映射缓冲内实际数据域
		const dataEnd = Math.min(crcOffset, n)
		const enc = r.encrypted
		const canDecode = !enc || (r.decryptOk && !r.needKey)
		//数据域:不加密,或已用密钥成功解密时,可逐字节映射 TLV 含义
		if (canDecode && dataEnd > dataOffset) {
			let region = null
			let prefix = ''
			if (enc) {
				region = (r.plainBytes && r.plainBytes.length) ? Uint8Array.from(r.plainBytes) : null
				prefix = '解密后-'
			} else {
				region = raw.subarray(dataOffset, dataEnd)
			}
			if (region && region.length > 0) {
				//顶层数据域才尝试剥离 2B 明文长度前缀(与 extractTlv 一致)
				const fcObj = r.fields && r.fields['功能码']
				const fc = fcObj && typeof fcObj === 'object' ? fcObj.value : fcObj
				walkTlvRegion(region, dataOffset, map, prefix, true, isResultValueFunc(fc))
			}
		} else if (enc) {
			set(dataOffset, Math.max(0, dataEnd - dataOffset), '加密数据域(需密钥解密后才有含义)', 'enc' + dataOffset)
		}
		if (crcOffset + 2 <= n) {
			set(crcOffset, 2, 'CRC16校验 ' + (r.crcOk ? '✓' : '✗') + ' = ' + hx(raw[crcOffset]) + ' ' + hx(raw[crcOffset + 1]), 'crc' + crcOffset)
		}
		if (crcOffset + 2 < n) {
			set(crcOffset + 2, 1, '帧结束符 = ' + hx(raw[crcOffset + 2]) + (raw[crcOffset + 2] === 0x16 ? ' ✓' : ' ✗ 期望0x16'), 'end' + crcOffset)
		}
		return map
	}

	//与 parseTlv / extractTlv 对齐的字节标注:
	//- allowPlainLen: 仅顶层数据域为 true,嵌套容器为 false
	//- resultMode: 0x81/0x91 应答, Value 固定 1B 结果码
	//- 字段布局为 [ID 1B][Value vlen B], ID 单独消费(与 parseTlv 的 j++ 一致)
	function walkTlvRegion(region, baseOff, map, prefix, allowPlainLen, resultMode) {
		const set = (off, len, tip, grp) => {
			for (let k = 0; k < len; k++) {
				if (off + k < map.length) map[off + k] = { tip: tip, grp: grp }
			}
		}
		const tlvOpt = resultMode ? { resultMode: true } : null
		let work = region
		let workOff = baseOff
		if (allowPlainLen && region.length >= 2) {
			const plainLen = u16leRead(region, 0)
			if (2 + plainLen <= region.length) {
				const trial = region.subarray(2, 2 + plainLen)
				const tags = plainLen === 0 ? [] : parseTlv(trial, tlvOpt)
				// plainLen=0 的空数据域也要标明文长度;能解析出 TLV 则剥离前缀
				if (plainLen === 0 || tags.length) {
					set(baseOff, 2, prefix + '数据域-明文长度 = ' + plainLen, 'p' + baseOff)
					if (2 + plainLen < region.length) {
						set(baseOff + 2 + plainLen, region.length - 2 - plainLen, prefix + '数据域-填充', 'pad' + (baseOff + 2 + plainLen))
					}
					work = trial
					workOff = baseOff + 2
				}
			} else if (plainLen > 0 && region.length > 2) {
				// 截断帧:声明长度超出实际,仍剥离 2B 前缀
				set(baseOff, 2, prefix + '数据域-明文长度 = ' + plainLen + '(截断)', 'p' + baseOff)
				work = region.subarray(2)
				workOff = baseOff + 2
			}
		}
		let i = 0
		while (i + 3 <= work.length) {
			const tag = work[i]
			const len = u16leRead(work, i + 1)
			if (tag === 0 && len === 0) {
				set(workOff + i, 3, prefix + '数据域-填充', 'pad' + (workOff + i))
				i += 3
				continue
			}
			const truncated = i + 3 + len > work.length
			const tagName = W.SK_TAG_NAME[tag] || ('Tag' + tag)
			const tagGrp = 't' + tag + 'h' + (workOff + i)
			const payEnd = truncated ? work.length : i + 3 + len
			set(workOff + i, 1, prefix + '数据域-' + tagName + ' [Tag]' + (truncated ? '(截断)' : ''), tagGrp)
			set(workOff + i + 1, Math.min(2, work.length - i - 1), prefix + '数据域-' + tagName + ' [长度=' + len + ']', tagGrp)
			const payload = work.subarray(i + 3, payEnd)
			const pBase = workOff + i + 3
			const defs = W.SK_TAGS[tag] || []
			const idMap = {}
			for (const d of defs) idMap[d.id] = d
			const seriesMeta = {
				startStr: null,
				interval: tag === 9 ? 1440 : (tag === 6 ? 5 : null),
				count: null
			}
			let j = 0
			while (j < payload.length) {
				//与 parseTlv 一致:先取 ID,再取 Value
				const idOff = j
				const id = payload[j++]
				const def = idMap[id]
				const name = def ? def.name : ('ID' + id)
				const itemGrp = 't' + tag + 'i' + id + 'o' + (pBase + idOff)
				// 0x81/0x91: Value 固定 1B 处理结果码
				if (resultMode) {
					if (j >= payload.length) {
						set(pBase + idOff, 1, prefix + '数据域-' + tagName + ' ' + name + ' (缺结果码)', itemGrp)
						break
					}
					const code = payload[j++] & 0xff
					const tip = prefix + '数据域-' + tagName + ' ' + name + ' = ' + resultCodeName(code) + '(' + code + ')'
					set(pBase + idOff, 2, tip, itemGrp)
					continue
				}
				if (def && def.dec && def.dec.t === 'busMeters') {
					const rec = def.dec.rec || 14
					let cnt = seriesMeta.count
					if (cnt == null || cnt <= 0) cnt = Math.floor((payload.length - j) / rec)
					let need = cnt * rec
					const remain = payload.length - j
					if (need > remain) need = Math.floor(remain / rec) * rec
					if (need <= 0) need = Math.min(rec, remain)
					const rawb = payload.subarray(j, j + need)
					const tip = prefix + '数据域-' + tagName + ' ' + name + ' = ' + renderBusMeters(rawb, rec)
					set(pBase + idOff, 1 + need, tip, itemGrp)
					j += need
					continue
				}
				if (def && (def.dec && def.dec.t === 'imgPack' || /BYTE\[1\+1\+2(?:\+1)?\+n\]/.test(def.type || ''))) {
					const remain = payload.length - j
					const extra = /BYTE\[1\+1\+2\+1\+n\]/.test(def.type || '') ? 1 : 0
					const hdr = 4 + extra
					if (remain < hdr) {
						set(pBase + idOff, 1 + remain, prefix + '数据域-' + tagName + ' ' + name + ' (不完整)', itemGrp)
						break
					}
					const plen = u16leRead(payload, j + 2)
					let need = Math.min(hdr + plen, remain)
					const rawb = payload.subarray(j, j + need)
					let tip = renderImgPack(rawb)
					if (extra && rawb.length >= 5) tip = '音源' + rawb[4] + ' ' + tip
					set(pBase + idOff, 1 + need, prefix + '数据域-' + tagName + ' ' + name + ' = ' + tip, itemGrp)
					j += need
					continue
				}
				let vlen = def ? typeLen(def.type) : null
				if (vlen === null) {
					let k = j
					while (k < payload.length && !idMap[payload[k]]) k++
					vlen = k - j
					if (vlen < 0) vlen = 0
					const rawb = payload.subarray(j, j + vlen)
					const tip = prefix + '数据域-' + tagName + ' ' + name + ' = ' + hexbytes(rawb)
					set(pBase + idOff, 1 + vlen, tip, itemGrp)
					j = k
					continue
				}
				// NULL: 仅 ID,无 Value
				if (vlen === 0 && def && def.type === 'NULL') {
					set(pBase + idOff, 1, prefix + '数据域-' + tagName + ' ' + name + ' (无参数)', itemGrp)
					continue
				}
				//定长 0:嵌套 TLV 容器,ID 已消费,剩余全部递归(不再剥离明文长度)
				if (vlen === 0) {
					set(pBase + idOff, 1, prefix + '数据域-' + tagName + ' ' + name + ' [嵌套TLV]', itemGrp)
					const rawb = payload.subarray(j)
					if (rawb.length) walkTlvRegion(rawb, pBase + j, map, prefix, false)
					j = payload.length
					break
				}
				if (isSeriesValueId(tag, id) && vlen > 0) {
					const elem = vlen
					let cnt = seriesMeta.count
					if (cnt == null || cnt <= 0) cnt = Math.floor((payload.length - j) / elem)
					let need = cnt * elem
					const remain = payload.length - j
					if (need > remain) need = Math.floor(remain / elem) * elem
					if (need < elem && remain >= elem) need = elem
					if (need <= 0) need = Math.min(elem, remain)
					const rawb = payload.subarray(j, j + need)
					const tip = prefix + '数据域-' + tagName + ' ' + name + ' = ' + renderSeries(def, rawb, seriesMeta)
					set(pBase + idOff, 1 + need, tip, itemGrp)
					j += need
					continue
				}
				if (j + vlen > payload.length) vlen = payload.length - j
				const rawb = payload.subarray(j, j + vlen)
				const tip = prefix + '数据域-' + tagName + ' ' + name + ' = ' + renderValue(def, rawb)
				set(pBase + idOff, 1 + vlen, tip, itemGrp)
				j += vlen
				updateSeriesMeta(tag, id, rawb, seriesMeta)
			}
			if (truncated) break
			i += 3 + len
		}
	}

		W.skBuildDownFrame = function (opt) {
		opt = opt || {}
		const seq = opt.frameSeq != null ? opt.frameSeq : 1
		const funcCode = typeof opt.funcCode === 'string' ? parseInt(opt.funcCode, opt.funcCode.indexOf('0x') === 0 ? 16 : 10) : opt.funcCode
		const timeBytes = platformTimeBytes(opt.time != null ? opt.time : new Date())

		const tlvArr = []
		for (const blk of (opt.tlv || [])) {
			const items = blk.items || []
			let payloadLen = 0
			const itemBytes = []
			for (const it of items) {
				let v
				if (it.value == null) v = new Uint8Array(0)
				else if (typeof it.value === 'string') v = toBytes(it.value)
				else v = new Uint8Array(it.value)
				payloadLen += 1 + v.length
				itemBytes.push([it.id, v])
			}
			tlvArr.push(blk.tag, payloadLen, itemBytes)
		}

		const tlvBuf = []
		for (let i = 0; i < tlvArr.length; i += 3) {
			const tag = tlvArr[i]
			const payloadLen = tlvArr[i + 1]
			const itemBytes = tlvArr[i + 2]
			tlvBuf.push(tag & 0xff)
			u16leWrite(tlvBuf, payloadLen)
			for (const [id, v] of itemBytes) {
				tlvBuf.push(id & 0xff)
				for (let k = 0; k < v.length; k++) tlvBuf.push(v[k])
			}
		}

		const plainTlvLen = tlvBuf.length
		const dataBuf = []
		u16leWrite(dataBuf, plainTlvLen)
		for (const x of tlvBuf) dataBuf.push(x)
		let dataField = new Uint8Array(dataBuf)

		let ctrl = 0x00
		if (opt.encKey && dataField.length > 0) {
			dataField = W.skAesEcbEncrypt(dataField, new Uint8Array(opt.encKey))
			ctrl |= 0x01
		}

		const ver = opt.version != null ? (opt.version & 0xff) : 0x02

		const head = []
		head.push(0xA9, 0x9A)
		u16leWrite(head, seq & 0xffff)
		head.push(ver)
		for (let i = 0; i < 7; i++) head.push(timeBytes[i])
		head.push(funcCode & 0xff)
		head.push(ctrl)
		u16leWrite(head, dataField.length)
		for (const x of dataField) head.push(x)

		const crc = W.skCrc16(new Uint8Array(head))
		u16leWrite(head, crc)
		head.push(0x16)
		return new Uint8Array(head)
	}

	// 绑定历史序列图表: 折线 + 悬停显示时间/流量
	W.skBindSeriesCharts = function (root) {
		if (!root || !root.querySelectorAll) return
		const canvases = root.querySelectorAll('canvas.sk-series-canvas[data-sk-series]')
		for (let i = 0; i < canvases.length; i++) {
			bindOneChart(canvases[i])
		}
	}

	function bindOneChart(canvas) {
		if (!canvas || canvas._skBound) return
		let data
		try { data = JSON.parse(canvas.getAttribute('data-sk-series') || '{}') } catch (e) { return }
		const rows = (data.rows || []).filter(function (r) { return r.v != null && isFinite(r.v) })
		if (rows.length < 2) return
		canvas._skBound = true
		const box = canvas.parentElement
		const tip = box ? box.querySelector('.sk-series-tip') : null
		const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1

		function layout() {
			const w = Math.max(280, (box && box.clientWidth) || canvas.clientWidth || 560)
			const h = 148
			canvas.style.width = w + 'px'
			canvas.style.height = h + 'px'
			canvas.width = Math.floor(w * dpr)
			canvas.height = Math.floor(h * dpr)
			return { w: w, h: h }
		}

		function draw(hi) {
			const sz = layout()
			const ctx = canvas.getContext('2d')
			if (!ctx) return
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
			const pad = { l: 44, r: 12, t: 12, b: 28 }
			const pw = sz.w - pad.l - pad.r
			const ph = sz.h - pad.t - pad.b
			ctx.clearRect(0, 0, sz.w, sz.h)
			// 背景
			ctx.fillStyle = 'rgba(127,127,127,0.06)'
			ctx.fillRect(pad.l, pad.t, pw, ph)

			let min = rows[0].v, max = rows[0].v
			for (let i = 0; i < rows.length; i++) {
				if (rows[i].v < min) min = rows[i].v
				if (rows[i].v > max) max = rows[i].v
			}
			if (min === max) { min -= 1; max += 1 }
			const span = max - min

			function xAt(i) { return pad.l + (pw * i) / (rows.length - 1) }
			function yAt(v) { return pad.t + ph - ((v - min) / span) * ph }

			// 网格
			ctx.strokeStyle = 'rgba(127,127,127,0.2)'
			ctx.lineWidth = 1
			ctx.beginPath()
			for (let g = 0; g <= 4; g++) {
				const y = pad.t + (ph * g) / 4
				ctx.moveTo(pad.l, y)
				ctx.lineTo(pad.l + pw, y)
			}
			ctx.stroke()

			// Y 轴刻度
			ctx.fillStyle = 'rgba(120,120,120,0.9)'
			ctx.font = '10px ui-monospace, Menlo, monospace'
			ctx.textAlign = 'right'
			ctx.textBaseline = 'middle'
			for (let g = 0; g <= 4; g++) {
				const v = max - (span * g) / 4
				const y = pad.t + (ph * g) / 4
				ctx.fillText(formatLiters(v).replace(' ', ''), pad.l - 4, y)
			}

			// 折线
			ctx.strokeStyle = '#3b82f6'
			ctx.lineWidth = 2
			ctx.beginPath()
			for (let i = 0; i < rows.length; i++) {
				const x = xAt(i), y = yAt(rows[i].v)
				if (i === 0) ctx.moveTo(x, y)
				else ctx.lineTo(x, y)
			}
			ctx.stroke()
			// 面积
			ctx.lineTo(xAt(rows.length - 1), pad.t + ph)
			ctx.lineTo(xAt(0), pad.t + ph)
			ctx.closePath()
			ctx.fillStyle = 'rgba(59,130,246,0.12)'
			ctx.fill()

			// 点
			for (let i = 0; i < rows.length; i++) {
				const x = xAt(i), y = yAt(rows[i].v)
				const active = hi === i
				ctx.beginPath()
				ctx.arc(x, y, active ? 4.5 : 2.5, 0, Math.PI * 2)
				ctx.fillStyle = active ? '#ef4444' : '#3b82f6'
				ctx.fill()
				if (active) {
					ctx.strokeStyle = '#fff'
					ctx.lineWidth = 1.5
					ctx.stroke()
				}
			}

			// X 轴: 首/中/尾
			ctx.fillStyle = 'rgba(120,120,120,0.95)'
			ctx.textAlign = 'center'
			ctx.textBaseline = 'top'
			const ticks = [0, Math.floor((rows.length - 1) / 2), rows.length - 1]
			const seen = {}
			for (let ti = 0; ti < ticks.length; ti++) {
				const idx = ticks[ti]
				if (seen[idx]) continue
				seen[idx] = 1
				const lab = String(rows[idx].t || '')
				ctx.fillText(lab.length > 10 ? lab.slice(5) : lab, xAt(idx), pad.t + ph + 6)
			}

			// 悬停十字
			if (hi != null && hi >= 0 && hi < rows.length) {
				const x = xAt(hi), y = yAt(rows[hi].v)
				ctx.strokeStyle = 'rgba(239,68,68,0.45)'
				ctx.lineWidth = 1
				ctx.setLineDash([3, 3])
				ctx.beginPath()
				ctx.moveTo(x, pad.t)
				ctx.lineTo(x, pad.t + ph)
				ctx.moveTo(pad.l, y)
				ctx.lineTo(pad.l + pw, y)
				ctx.stroke()
				ctx.setLineDash([])
			}
		}

		function nearest(ev) {
			const rect = canvas.getBoundingClientRect()
			const x = ev.clientX - rect.left
			const padL = 44, padR = 12
			const pw = rect.width - padL - padR
			let best = 0, bestD = 1e9
			for (let i = 0; i < rows.length; i++) {
				const px = padL + (pw * i) / (rows.length - 1)
				const d = Math.abs(px - x)
				if (d < bestD) { bestD = d; best = i }
			}
			return best
		}

		function onMove(ev) {
			const i = nearest(ev)
			draw(i)
			if (!tip) return
			const r = rows[i]
			tip.hidden = false
			tip.innerHTML = '<b>' + escHtml(String(r.t)) + '</b><br/>' +
				escHtml(r.s || formatLiters(r.v)) +
				(r.raw != null ? '<br/><span class="sk-tip-raw">原始 ' + escHtml(String(r.raw)) + ' 单位</span>' : '')
			const rect = canvas.getBoundingClientRect()
			const boxR = box.getBoundingClientRect()
			let left = ev.clientX - boxR.left + 12
			let top = ev.clientY - boxR.top - 10
			if (left + 140 > boxR.width) left = ev.clientX - boxR.left - 150
			tip.style.left = left + 'px'
			tip.style.top = Math.max(0, top) + 'px'
		}
		function onLeave() {
			draw(null)
			if (tip) tip.hidden = true
		}

		canvas.addEventListener('mousemove', onMove)
		canvas.addEventListener('mouseleave', onLeave)
		if (typeof ResizeObserver !== 'undefined') {
			const ro = new ResizeObserver(function () { draw(null) })
			ro.observe(box || canvas)
		}
		draw(null)
	}
})()