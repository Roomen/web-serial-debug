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
	function bcdEncode(digits) {
		let s = digits
		if (s.length % 2 !== 0) s = '0' + s
		const n = s.length / 2
		const a = new Uint8Array(n)
		for (let i = 0; i < n; i++) a[i] = (parseInt(s[i * 2], 10) << 4) | parseInt(s[i * 2 + 1], 10)
		return a.reverse()
	}
	function bcdTime(b) {
		const s = bcdDecode(b)
		if (s.length < 14) return s
		return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + ' ' + s.slice(8, 10) + ':' + s.slice(10, 12) + ':' + s.slice(12, 14)
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

	function renderValue(def, raw) {
		if (!raw || raw.length === 0) return ''
		const desc = def ? (def.desc || '') : ''
		const unit = unitHint(def)
		const u = unit ? (' ' + unit) : ''
		if (/YYYYMMDDhhmmss/.test(desc) || (def && def.unit === 'BCD' && raw.length === 7)) return bcdTime(raw)
		if (desc.indexOf('BCD') >= 0) {
			const s = bcdDecode(raw)
			return /^0+$/.test(s) ? '(空)' : s + u
		}
		if (desc.indexOf('ASCII') >= 0) return ascii(raw)
		if (desc.indexOf('int32 LE signed') >= 0 && raw.length === 4) return String(signed32(raw)) + u
		if (desc.indexOf('Uint32 LE') >= 0 && raw.length === 4) return String(u32leRead(raw, 0)) + u
		if (desc.indexOf('uint16') >= 0 && raw.length === 2) {
			const v = (desc.indexOf('signed') >= 0) ? signed16(raw) : u16leRead(raw, 0)
			return String(v) + u
		}
		if (desc.indexOf('int16 LE signed') >= 0 && raw.length === 2) return String(signed16(raw)) + u
		if (/bit\d/.test(desc) && raw.length <= 4) return renderBits(raw, desc)
		if (desc.indexOf('0关') >= 0 || desc.indexOf('0正常') >= 0 || /(^|\s)0无($|\s)/.test(desc)) return renderEnum(raw, desc)
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

	function resolveKey(opt) {
		if (opt && opt.keyHex) {
			return toBytes(opt.keyHex).subarray(0, 16)
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
		const k = new Uint8Array(16)
		k.set(bytes.subarray(0, 16))
		return k
	}

	function decryptData(enc, opt) {
		try {
			const k = resolveKey(opt)
			if (!k) return { ok: false, needKey: true }
			const out = W.skAes128EcbDecrypt(new Uint8Array(enc), k)
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
			厂家编码: { value: b[5], name: W.SK_MANUFACTURER[b[5]] || '其他' },
			设备类型: b[6],
			设备唯一编码: bcdDecode(b.subarray(7, 14)),
			信号质量: { rsrp: signed16(b.subarray(14, 16)), snr: signed16(b.subarray(16, 18)), ecl: b[18], csq: b[19] },
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
		const dirArrow = p.dir === 'up' ? '<span class="sk-parse-arrow">↑上行</span>' : p.dir === 'down' ? '<span class="sk-parse-arrow">↓下行</span>' : '<span class="sk-parse-arrow">未知</span>'
		const cls = p.dir === 'up' ? 'sk-parse-up' : p.dir === 'down' ? 'sk-parse-down' : 'sk-parse-error'
		let crc = p.crcOk ? '<span class="sk-parse-ok">CRC ✓</span>' : '<span class="sk-parse-bad">CRC ✗</span>'
		let lock = p.encrypted ? '<span class="sk-parse-lock" title="加密">🔒</span>' : ''
		let h = '<div class="sk-parse ' + cls + '">'
		h += '<div class="sk-parse-head">' + dirArrow + ' ' + lock + ' ' + crc + '</div>'
		h += '<dl class="sk-parse-dl">';
		const f = p.fields || {}
		const addField = (k, v) => {
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
			h += '<dt>' + escHtml(k) + '</dt><dd>' + escHtml(s) + '</dd>'
		}
		for (const k in f) addField(k, f[k])
		h += '</dl>'
		if (p.tlv && p.tlv.length) {
			h += '<div class="sk-parse-tlvs">'
			for (const t of p.tlv) {
				h += '<div class="sk-parse-tag"><span class="sk-parse-tagname">Tag' + t.tag + ' ' + escHtml(t.name || '') + '</span>'
				if (t.error) h += ' <span class="sk-parse-bad">' + escHtml(t.error) + '</span>'
				if (t.items && t.items.length) {
					h += '<table class="sk-parse-items"><tbody>'
					for (const it of t.items) {
						h += '<tr><td>ID' + it.id + '</td><td>' + escHtml(it.name || '') + '</td><td><code>' + escHtml(it.decoded || hexbytes(it.raw)) + '</code></td><td><code>' + escHtml(hexbytes(it.raw)) + '</code></td></tr>'
					}
					h += '</tbody></table>'
				}
				h += '</div>'
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
		const tlvLen = tlvBuf.length

		const ver = opt.version != null ? (opt.version & 0xff) : 0x02

		const head = []
		head.push(0xA9, 0x9A)
		u16leWrite(head, seq & 0xffff)
		head.push(ver)
		for (let i = 0; i < 7; i++) head.push(timeBytes[i])
		head.push(funcCode & 0xff)
		head.push(0x00)
		u16leWrite(head, 2 + tlvLen)
		u16leWrite(head, tlvLen)
		for (const x of tlvBuf) head.push(x)

		const crc = W.skCrc16(new Uint8Array(head))
		u16leWrite(head, crc)
		head.push(0x16)
		return new Uint8Array(head)
	}
})()