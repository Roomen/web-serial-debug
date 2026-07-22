(function () {
	'use strict'

	const W = window

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
	function bcdEncode(digits) {
		let s = digits
		if (s.length % 2 !== 0) s = '0' + s
		const n = s.length / 2
		const a = new Uint8Array(n)
		for (let i = 0; i < n; i++) a[i] = (parseInt(s[i * 2], 10) << 4) | parseInt(s[i * 2 + 1], 10)
		return a.reverse()
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
		let m = desc.match(/([\d.]+)([a-zA-Zμ℃%\/]+)/)
		if (m) return { scale: parseFloat(m[1]), unit: m[2] }
		const w = desc.match(/(L\/h|us\/cm|mg\/L|uA|kPa|NTU|mAH|pH|℃|L|V|秒|分钟|天|小时|次|us)/)
		if (w) return { scale: 1, unit: w[1] }
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
		if (/=/.test(desc)) {
			for (const tok of desc.split(/\s+/)) {
				const m = tok.match(/^(\d+)=(.*)$/)
				if (m) map[+m[1]] = m[2]
			}
			if (Object.keys(map).length) return map
		}
		const re = /(^|\s)(\d+)([关开正常异常报警使能未检测未知]?[\u4e00-\u9fff]+)/g
		let m
		while ((m = re.exec(desc)) !== null) map[+m[2]] = m[3]
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
					let v = readNum(raw, desc)
					if (nu.scale !== 1) v = v * nu.scale
					return fmtNum(v, nu.unit)
				}
				case 'enum': return (dec.map[raw[0]] != null) ? (raw[0] + ':' + dec.map[raw[0]]) : hexbytes(raw)
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
					const p = n => String(n).padStart(2, '0')
					return '上报时间 ' + p(raw[0]) + ':' + p(raw[1]) + ' 最大上报时长' + u16leRead(raw, 2) + '分'
				}
				case 'range': return (dec.labels ? dec.labels[0] : '起始') + ':' + raw[0] + '点 ' + (dec.labels ? dec.labels[1] : '结束') + ':' + raw[1] + '点'
				case 'upErr': {
					const linkMap = { 0: '其他', 1: 'AT失败', 2: '无SIM', 8: '驻网失败', 11: '接入失败', 13: '断网', 99: '上报无应答' }
					return '最近一次上行异常发生时间:' + bcdTimeOrEmpty(raw.subarray(0, 6)) + ' 最近一次异常发生时的CSQ:' + raw[6] + ' 异常发生的环节:' + (linkMap[raw[7]] != null ? linkMap[raw[7]] : raw[7])
				}
				case 'magSignal': return 'CH0=' + raw[0] + ' CH1=' + raw[1]
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
		if (/[关开正常异常报警使能未检测未知]/.test(desc) || /=/.test(desc)) {
			const map = parseEnumMap(desc)
			if (map[raw[0]] != null) return raw[0] + ':' + map[raw[0]]
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

	function parseTlv(data) {
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
				tlv.push({ tag, name: W.SK_TAG_NAME[tag] || ('Tag' + tag), payloadBytes: [...data.subarray(i + 3)], items: [], error: 'truncated', len })
				let j = i + 1
				let found = -1
				while (j + 3 <= data.length) {
					if (W.SK_TAGS[data[j]]) { found = j; break }
					j++
				}
				if (found < 0) break
				i = found
				continue
			}
			const payload = data.subarray(i + 3, i + 3 + len)
			i += 3 + len
			const defs = W.SK_TAGS[tag] || []
			const idMap = {}
			for (const d of defs) idMap[d.id] = d
			const items = []
			let j = 0
			while (j < payload.length) {
				const id = payload[j++]
				const def = idMap[id]
				let vlen = def ? typeLen(def.type) : null
				if (vlen === null) {
					let k = j
					while (k < payload.length && !idMap[payload[k]]) k++
					vlen = k - j
					if (vlen <= 0) vlen = 1
					const raw = payload.subarray(j, j + vlen)
					j = k
					items.push({ id, name: 'ID' + id + '(未知)', raw: Array.from(raw), decoded: hexbytes(raw) })
					continue
				}
				//定长 0 的字段(多为嵌套 TLV 容器):消费剩余字节并递归解析,避免 j+=0 死循环
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
				if (j + vlen > payload.length) vlen = payload.length - j
				const raw = payload.subarray(j, j + vlen)
				j += vlen
				items.push({
					id,
					name: def ? def.name : ('ID' + id),
					raw: Array.from(raw),
					decoded: renderValue(def, raw)
				})
			}
			tlv.push({
				tag,
				name: W.SK_TAG_NAME[tag] || ('Tag' + tag),
				payloadBytes: Array.from(payload),
				items,
				len
			})
		}
		return tlv
	}

	function extractTlv(pt) {
		if (pt.length >= 2) {
			const plainLen = u16leRead(pt, 0)
			if (2 + plainLen <= pt.length) {
				const region = pt.subarray(2, 2 + plainLen)
				const tags = parseTlv(region)
				if (tags.length && !tags[tags.length - 1].error) return tags
			}
		}
		return parseTlv(pt)
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

	function tryParseUp(b, opt) {
		if (b.length < 24) return null
		const dataLen = u16leRead(b, 22)
		const dataOffset = 24
		const crcOffset = dataOffset + dataLen
		if (crcOffset + 3 > b.length) return null
		const dataBytes = b.subarray(dataOffset, crcOffset)
		const crcRecv = u16leRead(b, crcOffset)
		const crcCalc = W.skCrc16(b.subarray(0, crcOffset))
		const endByte = b[crcOffset + 2]
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
			功能码: { value: b[20], name: (W.SK_FUNC_CODES['0x' + b[20].toString(16).toUpperCase().padStart(2, '0')] || {}).name || '' },
			控制码: { raw: ctrl, 后续帧: (ctrl & 0x80) === 0x80, 加密: encrypted },
			数据域字节数: dataLen,
			帧结束符: endByte
		}
		return {
			dir: 'up',
			crcOk: crcRecv === crcCalc,
			crcCalc,
			crcRecv,
			endOk: endByte === 0x16,
			encrypted,
			decryptOk: dec.ok,
			needKey,
			fields,
			tlv: extractTlv(tlvBytes),
			dataBytes: Array.from(dataBytes),
			plainBytes: plainBytesArr
		}
	}

	function tryParseDown(b, opt) {
		if (b.length < 16) return null
		const dataLen = u16leRead(b, 14)
		const dataOffset = 16
		const crcOffset = dataOffset + dataLen
		if (crcOffset + 3 > b.length) return null
		const dataBytes = b.subarray(dataOffset, crcOffset)
		const crcRecv = u16leRead(b, crcOffset)
		const crcCalc = W.skCrc16(b.subarray(0, crcOffset))
		const endByte = b[crcOffset + 2]
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
		const fields = {
			帧序号: u16leRead(b, 2),
			协议版本号: { value: b[4], name: W.SK_PROTOCOL_VERSION[b[4]] || '保留' },
			平台时间: bcdTime(timeBytes),
			平台时间BCD: hexbytes(timeBytes),
			功能码: { value: b[12], name: (W.SK_FUNC_CODES['0x' + b[12].toString(16).toUpperCase().padStart(2, '0')] || {}).name || '' },
			控制码: { raw: ctrl, 后续帧: (ctrl & 0x80) === 0x80, 加密: encrypted },
			数据域字节数: dataLen,
			帧结束符: endByte
		}
		return {
			dir: 'down',
			crcOk: crcRecv === crcCalc,
			crcCalc,
			crcRecv,
			endOk: endByte === 0x16,
			encrypted,
			decryptOk: dec.ok,
			needKey,
			fields,
			tlv: extractTlv(tlvBytes),
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
		let chosen = null
		if (up && up.crcOk && up.endOk) chosen = up
		else if (down && down.crcOk && down.endOk) chosen = down
		else if (up && up.endOk) chosen = up
		else if (down && down.endOk) chosen = down
		else if (up) chosen = up
		else if (down) chosen = down
		if (!chosen) {
			errors.push('无法解析')
			return result
		}
		result.dir = chosen.dir
		result.crcOk = chosen.crcOk
		result.crcCalc = chosen.crcCalc
		result.crcRecv = chosen.crcRecv
		result.encrypted = chosen.encrypted
		result.decryptOk = chosen.decryptOk
		result.needKey = !!chosen.needKey
		result.fields = chosen.fields
		result.tlv = chosen.tlv
		result.ok = chosen.crcOk && chosen.endOk
		if (chosen.needKey) errors.push('加密报文,请输入密钥')
		else if (!chosen.endOk) errors.push('帧结束符错误 期望0x16 实际0x' + chosen.fields.帧结束符.toString(16))
		if (!chosen.crcOk) errors.push('CRC校验失败 收到0x' + chosen.crcRecv.toString(16) + ' 计算0x' + chosen.crcCalc.toString(16))
		if (chosen.encrypted && !chosen.needKey && !chosen.decryptOk) errors.push('AES解密失败')
		const expectedLen = (chosen.dir === 'up' ? 24 : 16) + chosen.fields.数据域字节数 + 3
		if (b.length !== expectedLen) errors.push('报文长度不符 期望' + expectedLen + ' 实际' + b.length)
		return result
	}

	W.skFormatFrame = function (p) {
		const dirArrow = p.dir === 'up' ? '↑' : p.dir === 'down' ? '↓' : '?'
		const status = (p.crcOk ? '✓' : '✗') + (p.encrypted ? ' 🔒' : '')
		let h = '<div class="sk-parse">'
		h += '<div class="sk-parse-bar">' + dirArrow + ' ' + status + '</div>'
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
						h += '<span class="sk-parse-item" title="raw:' + escHtml(hexbytes(it.raw)) + '">ID' + it.id + ' ' + escHtml(it.name || '') + ' = ' + escHtml(it.decoded || hexbytes(it.raw)) + '</span>'
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
				else {
					const parts = []
					for (const key in v) {
						const val = v[key]
						parts.push(key + '=' + (val && typeof val === 'object' && val.name !== undefined ? (val.name ? val.value + '(' + val.name + ')' : val.value) : val))
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
		const enc = r.encrypted
		const canDecode = !enc || (r.decryptOk && !r.needKey)
		//数据域:不加密,或已用密钥成功解密时,可逐字节映射 TLV 含义
		if (canDecode && crcOffset > dataOffset && crcOffset <= n) {
			let region = null
			let prefix = ''
			if (enc) {
				region = (r.plainBytes && r.plainBytes.length) ? Uint8Array.from(r.plainBytes) : null
				prefix = '解密后-'
			} else {
				region = raw.subarray(dataOffset, crcOffset)
			}
			if (region && region.length === crcOffset - dataOffset) {
				//顶层数据域才尝试剥离 2B 明文长度前缀(与 extractTlv 一致)
				walkTlvRegion(region, dataOffset, map, prefix, true)
			}
		} else if (enc) {
			set(dataOffset, Math.max(0, crcOffset - dataOffset), '加密数据域(需密钥解密后才有含义)', 'enc' + dataOffset)
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
	//- 字段布局为 [ID 1B][Value vlen B], ID 单独消费(与 parseTlv 的 j++ 一致)
	function walkTlvRegion(region, baseOff, map, prefix, allowPlainLen) {
		const set = (off, len, tip, grp) => {
			for (let k = 0; k < len; k++) {
				if (off + k < map.length) map[off + k] = { tip: tip, grp: grp }
			}
		}
		let work = region
		let workOff = baseOff
		if (allowPlainLen && region.length >= 2) {
			const plainLen = u16leRead(region, 0)
			if (2 + plainLen <= region.length) {
				const trial = region.subarray(2, 2 + plainLen)
				const tags = parseTlv(trial)
				if (tags.length && !tags[tags.length - 1].error) {
					set(baseOff, 2, prefix + '数据域-明文长度 = ' + plainLen, 'p' + baseOff)
					if (2 + plainLen < region.length) {
						set(baseOff + 2 + plainLen, region.length - 2 - plainLen, prefix + '数据域-填充', 'pad' + (baseOff + 2 + plainLen))
					}
					work = trial
					workOff = baseOff + 2
				}
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
			if (i + 3 + len > work.length) {
				set(workOff + i, work.length - i, prefix + '数据域-截断', 'tr' + (workOff + i))
				break
			}
			const tagName = W.SK_TAG_NAME[tag] || ('Tag' + tag)
			const tagGrp = 't' + tag + 'h' + (workOff + i)
			set(workOff + i, 1, prefix + '数据域-' + tagName + ' [Tag]', tagGrp)
			set(workOff + i + 1, 2, prefix + '数据域-' + tagName + ' [长度=' + len + ']', tagGrp)
			const payload = work.subarray(i + 3, i + 3 + len)
			const pBase = workOff + i + 3
			const defs = W.SK_TAGS[tag] || []
			const idMap = {}
			for (const d of defs) idMap[d.id] = d
			let j = 0
			while (j < payload.length) {
				//与 parseTlv 一致:先取 ID,再取 Value
				const idOff = j
				const id = payload[j++]
				const def = idMap[id]
				let vlen = def ? typeLen(def.type) : null
				const name = def ? def.name : ('ID' + id)
				const itemGrp = 't' + tag + 'i' + id + 'o' + (pBase + idOff)
				if (vlen === null) {
					let k = j
					while (k < payload.length && !idMap[payload[k]]) k++
					vlen = k - j
					if (vlen < 0) vlen = 0
					const rawb = payload.subarray(j, j + vlen)
					const tip = prefix + '数据域-' + tagName + ' ID' + id + '(未知) = ' + hexbytes(rawb)
					set(pBase + idOff, 1 + vlen, tip, itemGrp)
					j = k
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
				if (j + vlen > payload.length) vlen = payload.length - j
				const rawb = payload.subarray(j, j + vlen)
				const tip = prefix + '数据域-' + tagName + ' ' + name + ' = ' + renderValue(def, rawb)
				set(pBase + idOff, 1 + vlen, tip, itemGrp)
				j += vlen
			}
			i += 3 + len
		}
	}

		W.skBuildDownFrame = function (opt) {
		opt = opt || {}
		const seq = opt.frameSeq != null ? opt.frameSeq : 1
		const funcCode = typeof opt.funcCode === 'string' ? parseInt(opt.funcCode, opt.funcCode.indexOf('0x') === 0 ? 16 : 10) : opt.funcCode
		let timeBytes
		if (opt.time instanceof Date) {
			const p = opt.time
			const pad = (n, l) => String(n).padStart(l, '0')
			const digits = pad(p.getFullYear(), 4) + pad(p.getMonth() + 1, 2) + pad(p.getDate(), 2) + pad(p.getHours(), 2) + pad(p.getMinutes(), 2) + pad(p.getSeconds(), 2)
			timeBytes = bcdEncode(digits)
		} else if (typeof opt.time === 'string') {
			const digits = opt.time.replace(/[^0-9]/g, '').padStart(14, '0').slice(-14)
			timeBytes = bcdEncode(digits)
		} else {
			const now = new Date()
			const pad = (n, l) => String(n).padStart(l, '0')
			const digits = pad(now.getFullYear(), 4) + pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2) + pad(now.getHours(), 2) + pad(now.getMinutes(), 2) + pad(now.getSeconds(), 2)
			timeBytes = bcdEncode(digits)
		}

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
			try {
				dataField = W.skAesEcbEncrypt(dataField, new Uint8Array(opt.encKey))
				ctrl |= 0x01
			} catch (e) {}
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
})()