// 默认协议（SEK）下行构建 + 通用协议下行与面板生命周期控制器：
// 1. 注册内置默认协议 'sek'（builtin: true）及其 mountPanel / unmountPanel；
// 2. 集中管理协议切换时的通用下行面板与纯解析提示（#proto-parse-only-hint）；
// 3. 复用 #sk-down-card 支持 SEK 模式与通用协议模式（hostProto、JSON 协议、无自定义面板的 JS 插件）。
;(function (root) {
	'use strict'

	function bytesToHexSpaced(bytes) {
		const out = []
		for (let i = 0; i < bytes.length; i++) {
			out.push(('0' + (bytes[i] & 0xff).toString(16).toUpperCase()).slice(-2))
		}
		return out.join(' ')
	}

	function bytesToHexCompact(bytes) {
		const out = []
		for (let i = 0; i < bytes.length; i++) {
			out.push(('0' + (bytes[i] & 0xff).toString(16).toUpperCase()).slice(-2))
		}
		return out.join('')
	}

	function asciiToHexBytes(s, fillLen) {
		const a = []
		const str = String(s == null ? '' : s)
		const n = fillLen != null ? Math.min(str.length, fillLen) : str.length
		for (let i = 0; i < n; i++) a.push(str.charCodeAt(i) & 0xff)
		if (fillLen != null) {
			while (a.length < fillLen) a.push(0x00)
		}
		return a
	}

	function bcdToBytes(s, fillLen) {
		let digits = String(s == null ? '' : s).replace(/\D/g, '')
		if (!digits) return []
		if (digits.length % 2 !== 0) digits = '0' + digits
		const a = []
		for (let i = digits.length - 2; i >= 0; i -= 2) {
			a.push((parseInt(digits.charAt(i), 10) << 4) | parseInt(digits.charAt(i + 1), 10))
		}
		if (fillLen != null) {
			while (a.length < fillLen) a.push(0x00)
		}
		return a
	}

	function bcdBeToBytes(s, fillLen) {
		let digits = String(s == null ? '' : s).replace(/\D/g, '')
		if (!digits) return []
		if (digits.length % 2 !== 0) digits = '0' + digits
		if (fillLen != null && digits.length < fillLen * 2) {
			digits = digits.padStart(fillLen * 2, '0')
		}
		const a = []
		for (let i = 0; i < digits.length; i += 2) {
			a.push((parseInt(digits.charAt(i), 10) << 4) | parseInt(digits.charAt(i + 1), 10))
		}
		if (fillLen != null && a.length > fillLen) {
			return a.slice(a.length - fillLen)
		}
		return a
	}

	// HEX 字符串（支持冒号/空格分隔或连续）→ 字节数组，不足 fillLen 补 0x00
	function hexToBytes(s, fillLen) {
		if (!s) return []
		let hex = String(s).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '')
		if (!hex) return []
		if (hex.length % 2 !== 0) hex = '0' + hex
		const a = []
		for (let i = 0; i < hex.length; i += 2) a.push(parseInt(hex.substr(i, 2), 16))
		if (fillLen != null) {
			while (a.length < fillLen) a.push(0x00)
		}
		return a
	}

	function numToBytes(val, type) {
		const n = Number(val)
		if (!Number.isFinite(n)) return []
		switch (type) {
			case 'uint8':
			case 'int8':
			case 'enum':
				return [n & 0xff]
			case 'uint16le':
			case 'int16le':
				return [n & 0xff, (n >> 8) & 0xff]
			case 'uint16be':
			case 'int16be':
				return [(n >> 8) & 0xff, n & 0xff]
			case 'uint32le':
			case 'int32le': {
				const u = n >>> 0
				return [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff]
			}
			case 'uint32be':
			case 'int32be': {
				const u = n >>> 0
				return [(u >>> 24) & 0xff, (u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff]
			}
			default:
				return []
		}
	}

	function parseNumberInput(raw) {
		const s = String(raw == null ? '' : raw).trim()
		if (!s) return NaN
		if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16)
		return parseInt(s, 10)
	}

	// BCD 一字节：十进制 0-99 → 0xNN
	function toBcdByte(n) {
		n = Math.max(0, Math.min(99, n | 0))
		return ((Math.floor(n / 10) & 0xf) << 4) | (n % 10)
	}

	// Tag10-ID9 日结：YY MM DD(各1B BCD) + 个数1B
	function dailyQueryBytes(count) {
		const d = new Date()
		const yy = d.getFullYear() % 100
		const n = Math.max(1, Math.min(60, count | 0))
		return [toBcdByte(yy), toBcdByte(d.getMonth() + 1), toBcdByte(d.getDate()), n & 0xff]
	}

	// Tag10-ID23 错误日志：YYMMDDhhmmss 6B BCD + 条数1B
	function errLogQueryBytes(count) {
		const d = new Date()
		const yy = d.getFullYear() % 100
		return [
			toBcdByte(yy), toBcdByte(d.getMonth() + 1), toBcdByte(d.getDate()),
			toBcdByte(d.getHours()), toBcdByte(d.getMinutes()), toBcdByte(d.getSeconds()),
			(count | 0) & 0xff,
		]
	}

	// Tag10-ID5 历史数据：YYYYMMDDhhmmss 7B BCD(高位在前) 当日 00:00:00
	function histDateQueryBytes(isoDate) {
		const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
		if (!m) return null
		const y = parseInt(m[1], 10)
		const mo = parseInt(m[2], 10)
		const day = parseInt(m[3], 10)
		if (mo < 1 || mo > 12 || day < 1 || day > 31) return null
		const chk = new Date(y, mo - 1, day)
		if (chk.getFullYear() !== y || chk.getMonth() !== mo - 1 || chk.getDate() !== day) return null
		return [
			toBcdByte(Math.floor(y / 100)),
			toBcdByte(y % 100),
			toBcdByte(mo),
			toBcdByte(day),
			0x00, 0x00, 0x00,
		]
	}

	function histDateBounds(maxDays) {
		const max = Math.max(1, Math.min(60, maxDays || 60))
		const pad = function (n) { return String(n).padStart(2, '0') }
		const fmt = function (d) {
			return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
		}
		const today = new Date()
		const minD = new Date(today.getFullYear(), today.getMonth(), today.getDate() - max)
		const yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
		return { min: fmt(minD), max: fmt(today), default: fmt(yest) }
	}

	function presetToTlvJson(preset) {
		const out = []
		for (const blk of (preset.tlv || [])) {
			const items = []
			for (const it of (blk.items || [])) {
				let value
				if (it.ascii != null) {
					value = bytesToHexCompact(asciiToHexBytes(it.ascii, it.fillLen))
				} else if (it.value != null) {
					value = bytesToHexCompact(it.value)
				} else {
					value = []
				}
				items.push({ id: it.id, value: value })
			}
			out.push({ tag: blk.tag, items: items })
		}
		return JSON.stringify(out, null, 0)
	}

	function paramUnitHint(type) {
		switch (type) {
			case 'uint8': return '(u8)'
			case 'int8': return '(i8)'
			case 'uint16le': return '(uint16 LE)'
			case 'uint16be': return '(uint16 BE)'
			case 'int16le': return '(int16 LE)'
			case 'int16be': return '(int16 BE)'
			case 'uint32le': return '(uint32 LE)'
			case 'uint32be': return '(uint32 BE)'
			case 'int32le': return '(int32 LE)'
			case 'int32be': return '(int32 BE)'
			case 'bcd':
			case 'bcd_le': return '(BCD LE)'
			case 'bcd_be': return '(BCD BE)'
			default: return ''
		}
	}

	function isNumericType(type) {
		return ['uint8', 'int8', 'uint16le', 'uint16be', 'int16le', 'int16be', 'uint32le', 'uint32be', 'int32le', 'int32be'].indexOf(type) !== -1
	}

	function normalizePresetGroups(presets) {
		if (!Array.isArray(presets) || !presets.length) return []
		if (presets[0] && Array.isArray(presets[0].items)) return presets
		return [{ group: '常用指令', items: presets }]
	}

	function filterGenericPresets(presets, funcCode, query) {
		const groups = normalizePresetGroups(presets)
		const q = String(query || '').trim().toLowerCase()
		const tokens = q ? q.split(/\s+/).filter(Boolean) : []
		const out = []
		for (let i = 0; i < groups.length; i++) {
			const grp = groups[i]
			const filtered = (grp.items || []).filter(function (it) {
				if (funcCode && funcCode !== '__all__' && it.func != null && String(it.func) !== String(funcCode)) {
					return false
				}
				if (!tokens.length) return true
				const hay = ((it.name || '') + ' ' + (it.desc || '') + ' ' + (it.func || '') + ' ' + (grp.group || '')).toLowerCase()
				return tokens.every(function (tk) { return hay.indexOf(tk) !== -1 })
			})
			if (filtered.length) out.push({ grp: grp, filtered: filtered })
		}
		return out
	}

	function deriveFuncTabs(proto) {
		if (!proto) return []
		if (Array.isArray(proto.funcTabs) && proto.funcTabs.length) {
			return proto.funcTabs.map(function (t) {
				return { code: String(t.code), label: String(t.label || t.code) }
			})
		}
		const groups = normalizePresetGroups(proto.presets)
		const seen = []
		groups.forEach(function (g) {
			;(g.items || []).forEach(function (it) {
				if (it.func != null && it.func !== '') {
					const code = String(it.func)
					if (seen.indexOf(code) === -1) seen.push(code)
				}
			})
		})
		return seen.map(function (c) { return { code: c, label: c } })
	}

	// 纯函数：把单个简单字段值按类型编码为字节数组，供通用下行与单元测试复用
	function encodeFieldValue(type, rawVal, opts) {
		opts = opts || {}
		const fillLen = opts.fillLen != null ? Number(opts.fillLen) : (opts.length != null ? Number(opts.length) : null)
		if (type === 'enum') {
			const n = parseNumberInput(rawVal)
			return isNaN(n) ? null : numToBytes(n, opts.valueType || 'uint8')
		}
		if (type === 'ascii') {
			const s = String(rawVal == null ? '' : rawVal)
			if (!s && !opts.allowEmpty) return null
			return asciiToHexBytes(s, fillLen)
		}
		if (type === 'bcd' || type === 'bcd_le') {
			const s = String(rawVal == null ? '' : rawVal)
			if (!s) return null
			return bcdToBytes(s, fillLen)
		}
		if (type === 'bcd_be') {
			const s = String(rawVal == null ? '' : rawVal)
			if (!s) return null
			return bcdBeToBytes(s, fillLen)
		}
		if (type === 'hex' || type === 'hexbytes') {
			const s = String(rawVal == null ? '' : rawVal).trim()
			if (!s) return opts.allowEmpty ? [] : null
			return hexToBytes(s, fillLen)
		}
		if (isNumericType(type)) {
			const scale = opts.scale != null ? Number(opts.scale) : 1
			let n
			if (scale && scale !== 1) {
				const f = Number(String(rawVal == null ? '' : rawVal).trim())
				n = Number.isFinite(f) ? Math.round(f / scale) : NaN
			} else {
				n = parseNumberInput(rawVal)
			}
			return isNaN(n) ? null : numToBytes(n, type)
		}
		return null
	}

	// 纯函数：多字段编码（支持位域 bits 与多类型独立字段）
	function encodeMultiFields(fields, values) {
		fields = fields || []
		values = values || []
		const hasBits = fields.some(function (f) { return f && f.bits != null })
		if (hasBits) {
			let maxBit = 0
			fields.forEach(function (f) {
				if (f && f.bits && f.bits[0] > maxBit) maxBit = f.bits[0]
			})
			const totalBytes = Math.floor(maxBit / 8) + 1
			const bytes = new Array(totalBytes).fill(0)
			fields.forEach(function (f, idx) {
				if (!f || !f.bits) return
				const val = parseNumberInput(values[idx])
				if (isNaN(val)) return
				const hi = f.bits[0]
				const lo = f.bits[1]
				const width = hi - lo + 1
				const mask = (1 << width) - 1
				const v = val & mask
				for (let b = 0; b < totalBytes; b++) {
					const bitLo = b * 8
					const bitHi = b * 8 + 7
					if (bitHi < lo || bitLo > hi) continue
					const shift = lo - bitLo
					const subMask = Math.min(mask, (1 << (Math.min(bitHi, hi) - Math.max(bitLo, lo) + 1)) - 1)
					bytes[b] |= (v & subMask) << shift
				}
			})
			return bytes
		}
		const bytes = []
		fields.forEach(function (f, idx) {
			if (!f) return
			const raw = values[idx]
			if ((raw == null || String(raw).trim() === '') && f.type !== 'ascii') return
			const encoded = encodeFieldValue(f.type || 'uint8', raw, f)
			if (encoded && encoded.length) bytes.push.apply(bytes, encoded)
		})
		return bytes
	}

	const SEK_FUNC_TABS = [
		{ code: '0x03', label: '信息查询' },
		{ code: '0x01', label: '参数设置' },
		{ code: '0x11', label: '指令操作' },
	]
	const SEK_ONLY_IDS = [
		'serial-protocol-advanced',
		'sk-down-card',
	]
	const SEK_TLV_PLACEHOLDER = 'TLV JSON，例如：[{"tag":10,"items":[{"id":1,"value":[]}]}]，value 可为空数组(查询) 或 十六进制字符串 或 字节数组'
	const GENERIC_PAYLOAD_PLACEHOLDER = '载荷 HEX（空格可有可无）或构建参数 JSON，例如：01 02 或 {"cmd":"0x01","payloadHex":"01"}'

	const lib = {
		asciiToHexBytes: asciiToHexBytes,
		bcdToBytes: bcdToBytes,
		bcdBeToBytes: bcdBeToBytes,
		hexToBytes: hexToBytes,
		numToBytes: numToBytes,
		encodeFieldValue: encodeFieldValue,
		encodeMultiFields: encodeMultiFields,
		filterGenericPresets: filterGenericPresets,
		deriveFuncTabs: deriveFuncTabs,
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = lib
	}

	if (typeof document === 'undefined') return
	root.ProtocolDownlink = lib

	const host = root._serialProtocolHost || {}
	const doc = document
	const $ = function (id) { return doc.getElementById(id) }

	const downCard = $('sk-down-card')
	const downTitleEl = downCard ? downCard.querySelector('.pane-section-title') : null
	const encryptInput = $('serial-protocol-down-encrypt')
	const encryptWrap = encryptInput ? encryptInput.closest('.ctl-switch') : null
	const tlvInput = $('serial-protocol-down-tlv')
	const buildBtn = $('serial-protocol-build')
	const sendProtoBtn = $('serial-protocol-send')
	const previewEl = $('serial-protocol-down-preview')
	const presetSel = $('serial-protocol-down-preset')
	const funcSel = $('serial-protocol-down-func')
	const funcTabs = $('serial-protocol-down-func-tabs')
	const presetSearch = $('serial-protocol-down-preset-search')
	const presetSearchClear = $('serial-protocol-down-preset-search-clear')
	const presetDescEl = $('serial-protocol-down-desc')
	const paramGroup = $('serial-protocol-down-param-group')
	const paramVal = $('serial-protocol-down-param-val')
	const paramSelEnum = $('serial-protocol-down-param-sel')
	const paramLabel = $('serial-protocol-down-param-label')
	const paramUnit = $('serial-protocol-down-param-unit')
	const multiContainer = $('serial-protocol-down-param-multi')

	let _downSeq = 1
	let _skipFuncEvent = false
	let _currentParamType = ''
	let _largeFlowSending = false
	let _buildWithParamRef = null

	function addLogErr(msg) {
		if (host.addLogErr) host.addLogErr(msg)
	}
	function sendHex(hex) {
		return host.sendHex ? host.sendHex(hex) : Promise.resolve()
	}
	function isSekMode() {
		return (root._activeProtocol || 'sek') === 'sek'
	}
	function activeProto() {
		return typeof root.getActiveProtocol === 'function' ? root.getActiveProtocol() : null
	}

	function ensureParseOnlyHint() {
		let hint = $('proto-parse-only-hint')
		if (hint) return hint
		const navProto = $('nav-protocol')
		if (!navProto) return null
		hint = doc.createElement('div')
		hint.id = 'proto-parse-only-hint'
		hint.className = 'protocol-down-card mb-2 proto-parse-only-hint'
		hint.style.display = 'none'
		const title = doc.createElement('h6')
		title.className = 'pane-section-title'
		const icon = doc.createElement('i')
		icon.className = 'bi bi-info-circle'
		title.appendChild(icon)
		title.appendChild(doc.createTextNode(' 仅解析模式'))
		const desc = doc.createElement('p')
		desc.className = 'sk-rw-hint mb-0'
		desc.textContent = '当前协议仅提供日志解析与字节悬停提示，可使用下方串口发送或快捷发送。'
		hint.appendChild(title)
		hint.appendChild(desc)
		if (downCard && downCard.parentNode === navProto) {
			navProto.insertBefore(hint, downCard.nextSibling)
		} else {
			navProto.appendChild(hint)
		}
		return hint
	}

	function setParseOnlyHintVisible(show) {
		const hint = show ? ensureParseOnlyHint() : $('proto-parse-only-hint')
		if (hint) hint.style.display = show ? '' : 'none'
	}

	function renderFuncTabsFor(tabs) {
		if (!funcTabs || !funcSel) return
		const list = Array.isArray(tabs) ? tabs : []
		const showTabs = list.length > 1
		funcTabs.style.display = showTabs ? '' : 'none'
		funcTabs.textContent = ''
		funcSel.textContent = ''
		if (!list.length) {
			const opt = doc.createElement('option')
			opt.value = '__all__'
			opt.textContent = '全部'
			funcSel.appendChild(opt)
			funcSel.value = '__all__'
			return
		}
		list.forEach(function (t, idx) {
			const btn = doc.createElement('button')
			btn.type = 'button'
			btn.dataset.func = t.code
			btn.setAttribute('aria-pressed', idx === 0 ? 'true' : 'false')
			btn.appendChild(doc.createTextNode(t.label))
			if (t.label !== t.code) {
				const sp = doc.createElement('span')
				sp.className = 'sk-func-code'
				sp.textContent = t.code
				btn.appendChild(sp)
			}
			funcTabs.appendChild(btn)

			const opt = doc.createElement('option')
			opt.value = t.code
			opt.textContent = t.label !== t.code ? (t.label + ' ' + t.code) : t.label
			if (idx === 0) opt.selected = true
			funcSel.appendChild(opt)
		})
		funcSel.selectedIndex = 0
		funcSel.value = list[0].code
	}

	function syncFuncTabs(funcCode) {
		if (!funcTabs) return
		funcTabs.querySelectorAll('button[data-func]').forEach(function (btn) {
			btn.setAttribute('aria-pressed', btn.dataset.func === funcCode ? 'true' : 'false')
		})
	}

	function configureCardForMode(mode, proto) {
		if (!downCard) return
		const sek = mode === 'sek'
		downCard.dataset.mode = sek ? 'sek' : 'generic'
		if (encryptWrap) encryptWrap.style.display = sek ? '' : 'none'
		if (tlvInput) tlvInput.placeholder = sek ? SEK_TLV_PLACEHOLDER : GENERIC_PAYLOAD_PLACEHOLDER
		if (downTitleEl) {
			const titleText = sek ? '下行下发' : (((proto && proto.name) || '协议') + ' 下行下发')
			const span = downTitleEl.querySelector('.sk-down-title-text')
			if (span) {
				span.textContent = titleText
			} else {
				// 保留 collapsible-cards.js 插入的折叠箭头，绝不丢失 .collapsible-chevron
				const chevron = downTitleEl.querySelector('.collapsible-chevron')
				downTitleEl.textContent = ''
				if (chevron) downTitleEl.appendChild(chevron)
				const ic = doc.createElement('i')
				ic.className = 'bi bi-arrow-down-circle'
				downTitleEl.appendChild(ic)
				downTitleEl.appendChild(doc.createTextNode(' '))
				const newSpan = doc.createElement('span')
				newSpan.className = 'sk-down-title-text'
				newSpan.textContent = titleText
				downTitleEl.appendChild(newSpan)
			}
		}
		if (presetSearch) {
			presetSearch.placeholder = sek ? '筛选指令 / Tag…' : '筛选指令…'
			presetSearch.value = ''
			if (presetSearchClear) presetSearchClear.hidden = true
		}
		const tabs = sek ? SEK_FUNC_TABS : deriveFuncTabs(proto)
		renderFuncTabsFor(tabs)
		const hasPresets = normalizePresetGroups(proto && proto.presets).some(function (g) { return g.items && g.items.length })
		const presetRow = downCard.querySelector('.sk-preset-row')
		if (presetRow) presetRow.style.display = (sek || hasPresets) ? '' : 'none'
		if (!sek && !hasPresets) {
			if (paramGroup) paramGroup.style.display = 'none'
			if (presetDescEl) { presetDescEl.textContent = ''; presetDescEl.hidden = true }
		}
	}

	function shortGroupName(name) {
		let s = String(name).replace(/\s*\(0x[0-9a-fA-F]+\)\s*$/, '')
		const opt = funcSel ? funcSel.options[funcSel.selectedIndex] : null
		const funcName = opt ? opt.textContent.replace(/\s*0x[0-9a-fA-F]+\s*$/, '').trim() : ''
		if (funcName && s.startsWith(funcName + '-')) s = s.slice(funcName.length + 1)
		return s || name
	}

	function getPresetsForActive() {
		const proto = activeProto()
		if (isSekMode()) {
			return (proto && Array.isArray(proto.presets) && proto.presets.length) ? proto.presets : (root.SK_DOWN_PRESETS || [])
		}
		return proto && Array.isArray(proto.presets) ? proto.presets : []
	}

	function presetItemByName(name) {
		const groups = normalizePresetGroups(getPresetsForActive())
		for (let i = 0; i < groups.length; i++) {
			const items = groups[i].items || []
			for (let j = 0; j < items.length; j++) {
				if (items[j].name === name) return items[j]
			}
		}
		return null
	}

	function rebuildPresets(funcCode) {
		if (!presetSel) return
		const presets = getPresetsForActive()
		const query = presetSearch ? presetSearch.value : ''
		let matchingGroups
		if (isSekMode() && root.SK_PRESET_CODEC && typeof root.SK_PRESET_CODEC.filterPresets === 'function') {
			matchingGroups = root.SK_PRESET_CODEC.filterPresets(presets, funcCode, query)
		} else {
			matchingGroups = filterGenericPresets(presets, funcCode, query)
		}
		const keep = presetSel.value
		presetSel.innerHTML = ''
		if (!matchingGroups.length) {
			const ph = doc.createElement('option')
			ph.value = ''
			ph.textContent = query && query.trim() ? '无匹配指令' : '无可用指令'
			presetSel.appendChild(ph)
		}
		for (let i = 0; i < matchingGroups.length; i++) {
			const entry = matchingGroups[i]
			const parent = matchingGroups.length > 1 ? doc.createElement('optgroup') : presetSel
			if (parent !== presetSel) {
				parent.label = isSekMode() ? shortGroupName(entry.grp.group) : (entry.grp.group || '指令')
				presetSel.appendChild(parent)
			}
			for (let j = 0; j < entry.filtered.length; j++) {
				const it = entry.filtered[j]
				const opt = doc.createElement('option')
				opt.value = it.name
				opt.textContent = it.name
				parent.appendChild(opt)
			}
		}
		const hasKeep = keep && Array.prototype.some.call(presetSel.options, function (o) { return o.value === keep })
		if (hasKeep) {
			presetSel.value = keep
		} else if (presetSel.options.length) {
			presetSel.selectedIndex = 0
			presetSel.value = presetSel.options[0].value
		} else {
			presetSel.value = ''
		}
	}

	function setParamUnit(text, isError) {
		if (!paramUnit) return
		paramUnit.textContent = text || ''
		paramUnit.style.display = text ? '' : 'none'
		paramUnit.classList.toggle('is-error', !!isError)
	}

	function renderMultiFields(fields) {
		if (!multiContainer) return
		multiContainer.style.display = ''
		multiContainer.innerHTML = ''
		;(fields || []).forEach(function (f, idx) {
			const wrap = doc.createElement('div')
			wrap.className = 'sk-param-multi-item'
			const lbl = doc.createElement('span')
			lbl.className = 'sk-param-multi-label'
			lbl.textContent = f.label || ''
			wrap.appendChild(lbl)
			if (f.type === 'enum' && f.options) {
				const sel = doc.createElement('select')
				sel.className = 'form-select form-select-sm'
				sel.style.width = f.width || '120px'
				sel.dataset.index = idx
				Object.entries(f.options).forEach(function (kv) {
					const op = doc.createElement('option')
					op.value = kv[0]
					op.textContent = kv[1]
					if (String(kv[0]) === String(f.default != null ? f.default : Object.keys(f.options)[0])) op.selected = true
					sel.appendChild(op)
				})
				sel.addEventListener('change', function () { if (_buildWithParamRef) _buildWithParamRef() })
				wrap.appendChild(sel)
			} else {
				const inp = doc.createElement('input')
				inp.type = isNumericType(f.type) ? 'number' : 'text'
				inp.className = 'form-control form-control-sm'
				inp.style.width = f.width || '100px'
				inp.dataset.index = idx
				inp.value = f.default != null ? String(f.default) : ''
				if (f.min != null) inp.min = f.min
				if (f.max != null) inp.max = f.max
				if (f.placeholder) inp.placeholder = f.placeholder
				inp.addEventListener('input', function () { if (_buildWithParamRef) _buildWithParamRef() })
				wrap.appendChild(inp)
			}
			multiContainer.appendChild(wrap)
		})
	}

	function multiParamToBytes(fields) {
		if (!multiContainer) return []
		const values = (fields || []).map(function (_f, idx) {
			const el = multiContainer.querySelector('[data-index="' + idx + '"]')
			return el ? el.value : ''
		})
		return encodeMultiFields(fields, values)
	}

	function encodeParamToBytes(preset, overrideBaseCode) {
		const p = preset && preset.param
		if (!p) return []
		if (p.type === 'enum') {
			return encodeFieldValue('enum', paramSelEnum ? paramSelEnum.value : '', p)
		}
		if (p.type === 'dailyQuery') {
			const rawVal = parseInt(paramVal ? paramVal.value.trim() : '', 10)
			if (isNaN(rawVal)) return null
			return dailyQueryBytes(rawVal)
		}
		if (p.type === 'errLogQuery') {
			const rawVal = parseInt(paramVal ? paramVal.value.trim() : '', 10)
			if (isNaN(rawVal)) return null
			return errLogQueryBytes(rawVal)
		}
		if (p.type === 'histDate') {
			const iso = paramVal ? paramVal.value.trim() : ''
			if (!iso) return null
			return histDateQueryBytes(iso)
		}
		if (p.type === 'hexbytes' || p.type === 'hex') {
			const s = paramVal ? paramVal.value.trim() : ''
			const fl = p.fillLen != null ? Number(p.fillLen) : (p.length != null ? Number(p.length) : null)
			if (!s) {
				if (fl === 7 && preset.name && preset.name.indexOf('时间') !== -1) {
					const d = new Date()
					const pad = function (n, l) { return String(n).padStart(l, '0') }
					const digits = pad(d.getFullYear(), 4) + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) +
						pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2)
					return hexToBytes(digits, 7)
				}
				return p.allowEmpty ? [] : null
			}
			return hexToBytes(s, fl)
		}
		if (p.type === 'largeFlow') {
			const s = paramVal ? paramVal.value.trim() : ''
			if (!s) {
				setParamUnit('下发前自动读当量', false)
				return null
			}
			const laneBase = overrideBaseCode != null
				? { has: true, code: overrideBaseCode }
				: (host.getActiveLaneBaseWater ? host.getActiveLaneBaseWater() : { has: false, code: null })
			const useCode = laneBase.has && laneBase.code != null ? laneBase.code : 3
			const res = root.SK_PRESET_CODEC ? root.SK_PRESET_CODEC.largeFlowM3ToBytes(s, useCode) : null
			if (!res || res.error) {
				setParamUnit(res && res.error ? res.error : '底度无效', true)
				return null
			}
			if (laneBase.has) setParamUnit(res.baseLabel + ' · ' + res.units + '圈', false)
			else setParamUnit('暂按1L预览 · 下发前自动读当量', false)
			return res.bytes
		}
		if (p.type === 'multi') {
			const bytes = multiParamToBytes(p.fields || [])
			return bytes && bytes.length ? bytes : null
		}
		return encodeFieldValue(_currentParamType || p.type, paramVal ? paramVal.value : '', p)
	}

	// 大口径底度下发前先向设备查询基准水量(Tag10-ID3 终端参数，缺失则回退 Tag10-ID2 核心数据)
	async function queryDeviceBaseWater() {
		if (!root.sekTx || typeof root.sekTx.sendAndWait !== 'function') {
			throw new Error('默认 TLV 协议事务层未就绪')
		}
		const hub = root.SerialHub
		const sid = hub ? hub.activeSendPhys() : 'S'
		if (!hub || !hub.isOpen(sid)) {
			throw new Error('串口未打开')
		}
		let code = null
		let source = null
		try {
			const res3 = await root.sekTx.sendAndWait({
				buildOpts: { funcCode: 0x03, tlv: [{ tag: 10, items: [{ id: 3, value: [] }] }] },
				expectFunc: 0x83,
				timeoutMs: 5000,
				match: function (f) { return root.sekTx.hasTag(f, 3) || root.sekTx.hasTag(f, 2) },
			})
			const it3 = root.sekTx.findTlvItem(res3.frame, 3, 29)
			const it2 = !it3 ? root.sekTx.findTlvItem(res3.frame, 2, 29) : null
			const it = it3 || it2
			if (it && it.raw && it.raw.length && it.raw[0] >= 0 && it.raw[0] <= 6) {
				code = it.raw[0] & 0xff
				source = it3 ? 'Tag3-ID29' : 'Tag2-ID29'
			}
		} catch (e) {
			// Tag10-ID3 超时或无响应时，再尝试一次 Tag10-ID2(核心数据)
		}
		if (code == null) {
			const res2 = await root.sekTx.sendAndWait({
				buildOpts: { funcCode: 0x03, tlv: [{ tag: 10, items: [{ id: 2, value: [] }] }] },
				expectFunc: 0x83,
				timeoutMs: 5000,
				match: function (f) { return root.sekTx.hasTag(f, 2) },
			})
			const it2 = root.sekTx.findTlvItem(res2.frame, 2, 29)
			if (it2 && it2.raw && it2.raw.length && it2.raw[0] >= 0 && it2.raw[0] <= 6) {
				code = it2.raw[0] & 0xff
				source = 'Tag2-ID29'
			}
		}
		if (code == null) {
			throw new Error('应答中未找到基准水量(Tag2/3-ID29)')
		}
		if (host.inLiveLane) {
			host.inLiveLane(sid, function () {
				const g = typeof root.skSess === 'function' ? root.skSess() : root.skSession
				if (g && typeof g.setBase === 'function') g.setBase(code, source)
			})
		}
		return { code: code, source: source }
	}

	function buildSekFrameFromUi() {
		if (!previewEl || !tlvInput || !funcSel) return
		previewEl.value = ''
		let tlv
		try {
			tlv = JSON.parse(tlvInput.value || '[]')
		} catch (err) {
			addLogErr('TLV JSON解析失败:' + err.toString())
			return
		}
		try {
			const opts = host.getToolOptions ? host.getToolOptions() : {}
			const encKeyResolved = host.resolveToolEncKey ? host.resolveToolEncKey() : null
			if (opts.skDownEncrypt && !encKeyResolved) {
				addLogErr('已勾选下发加密, 但密钥无效或为空(请填写高级·密钥)')
				return
			}
			const encKey = host.getDownlinkEncKey ? host.getDownlinkEncKey() : null
			const frame = root.skBuildDownFrame({
				funcCode: funcSel.value,
				version: 2,
				time: new Date(),
				frameSeq: _downSeq++,
				tlv: tlv,
				encKey: encKey,
			})
			previewEl.value = bytesToHexSpaced(frame)
			if (encKey) {
				addLogErr('已生成加密下行帧 (ctrl 加密位=1)')
			}
		} catch (err) {
			addLogErr('生成帧失败:' + err.toString())
		}
	}

	function buildGenericFrameFromUi() {
		if (!previewEl) return
		previewEl.value = ''
		const proto = activeProto()
		if (!proto || typeof proto.buildDownFrame !== 'function') {
			addLogErr('当前协议未提供下行构建能力')
			return
		}
		const preset = presetSel && presetSel.value ? presetItemByName(presetSel.value) : null
		const rawText = tlvInput ? tlvInput.value.trim() : ''
		let buildOpts = {
			seq: _downSeq++,
			frameSeq: _downSeq - 1,
			time: new Date(),
			funcCode: funcSel ? funcSel.value : '',
		}
		if (preset) {
			buildOpts.preset = preset
			buildOpts.presetName = preset.name
			if (preset.cmd != null) buildOpts.cmd = preset.cmd
			if (preset.func != null) buildOpts.func = preset.func
			if (preset.fixedBytes != null) buildOpts.fixedBytes = preset.fixedBytes
			if (preset.preamble !== undefined) buildOpts.preamble = preset.preamble
			if (preset.buildOpts && typeof preset.buildOpts === 'object') {
				buildOpts = Object.assign({}, buildOpts, preset.buildOpts)
			}
		}
		if (rawText.startsWith('{')) {
			try {
				const parsedObj = JSON.parse(rawText)
				if (parsedObj && typeof parsedObj === 'object' && !Array.isArray(parsedObj)) {
					buildOpts = Object.assign(buildOpts, parsedObj)
				}
			} catch (err) {
				addLogErr('参数 JSON 解析失败: ' + err.message)
				return
			}
		} else {
			const cleanHex = rawText.replace(/0x/gi, '').replace(/\s+/g, '')
			if (cleanHex && (!/^[0-9a-fA-F]+$/.test(cleanHex) || cleanHex.length % 2 !== 0)) {
				addLogErr('载荷 HEX 格式无效')
				return
			}
			buildOpts.payloadHex = cleanHex
			buildOpts.payload = hexToBytes(cleanHex)
		}
		try {
			const frame = proto.buildDownFrame(buildOpts)
			if (!frame || !frame.length) {
				addLogErr('生成帧为空')
				return
			}
			const arr = frame instanceof Uint8Array ? frame : Uint8Array.from(frame)
			previewEl.value = bytesToHexSpaced(arr)
		} catch (err) {
			addLogErr('生成帧失败: ' + (err && err.message ? err.message : String(err)))
		}
	}

	if (buildBtn) {
		buildBtn.addEventListener('click', function () {
			if (isSekMode()) buildSekFrameFromUi()
			else buildGenericFrameFromUi()
		})
	}

	function rebuildDownPreview() {
		if (!isSekMode()) return
		if (tlvInput && tlvInput.value.trim() && buildBtn) buildBtn.click()
	}
	root.rebuildDownPreview = rebuildDownPreview

	if (previewEl) {
		previewEl.addEventListener('click', function () {
			const text = (previewEl.value || '').trim()
			if (!text) return
			if (host.copyText) host.copyText(text)
			previewEl.classList.add('is-copied')
			clearTimeout(previewEl._copyT)
			previewEl._copyT = setTimeout(function () { previewEl.classList.remove('is-copied') }, 800)
		})
	}

	if (sendProtoBtn) {
		sendProtoBtn.addEventListener('click', async function () {
			const active = root._activeProtocol || 'sek'
			// 非默认协议（如 188 / W-MBUS 写进共享预览框后点此按钮，或通用模式已生成预览）：
			// 预览框非空时直接发帧，绝不触发 SEK 专属逻辑
			if (active !== 'sek') {
				if (previewEl && previewEl.value.trim()) {
					await sendHex(previewEl.value)
					return
				}
				if (tlvInput && tlvInput.value.trim() && buildBtn) {
					buildBtn.click()
				}
				if (!previewEl || !previewEl.value.trim()) {
					addLogErr('请先生成HEX再下发')
					return
				}
				await sendHex(previewEl.value)
				return
			}

			// 默认 TLV 协议模式：大口径底度下发前先读当量
			if (presetSel && presetSel.value) {
				const activePreset = presetItemByName(presetSel.value)
				if (activePreset && activePreset.param && activePreset.param.type === 'largeFlow') {
					if (_largeFlowSending) return
					const m3Str = paramVal ? paramVal.value.trim() : ''
					const check = root.SK_PRESET_CODEC ? root.SK_PRESET_CODEC.largeFlowM3ToBytes(m3Str, 3) : null
					if (!check || check.error) {
						addLogErr(check && check.error ? check.error : '底度输入无效')
						return
					}
					const hub = root.SerialHub
					if (!hub || !hub.isOpen(hub.activeSendPhys())) {
						addLogErr('请先打开串口再下发大口径底度（需先读取设备当量）')
						return
					}
					const targetPresetName = presetSel.value
					_largeFlowSending = true
					const origText = sendProtoBtn.textContent
					sendProtoBtn.disabled = true
					sendProtoBtn.textContent = '读取当量中…'
					try {
						const base = await queryDeviceBaseWater()
						if (root._activeProtocol !== 'sek' || presetSel.value !== targetPresetName) {
							addLogErr('读取当量期间指令或协议已切换，已中止下发')
							return
						}
						if (previewEl) previewEl.value = ''
						if (typeof _buildWithParamRef === 'function') _buildWithParamRef(base.code)
						if (!previewEl || !previewEl.value) {
							addLogErr('按当量生成大口径底度帧失败')
							return
						}
						await sendHex(previewEl.value)
					} catch (err) {
						addLogErr('读取设备当量(基准水量)失败: ' + (err && err.message ? err.message : String(err)) + '，已中止下发')
					} finally {
						_largeFlowSending = false
						sendProtoBtn.disabled = false
						sendProtoBtn.textContent = origText
					}
					return
				}
			}

			if (previewEl && !previewEl.value && tlvInput && tlvInput.value.trim() && buildBtn) {
				buildBtn.click()
			}
			if (!previewEl || !previewEl.value) {
				addLogErr('请先生成HEX再下发')
				return
			}
			await sendHex(previewEl.value)
		})
	}

	if (funcTabs && funcSel) {
		funcTabs.addEventListener('click', function (e) {
			const btn = e.target.closest('button[data-func]')
			if (!btn) return
			const nextFunc = btn.dataset.func
			if (!nextFunc || funcSel.value === nextFunc) return
			if (presetSearch && presetSearch.value) {
				presetSearch.value = ''
				if (presetSearchClear) presetSearchClear.hidden = true
			}
			funcSel.value = nextFunc
			funcSel.dispatchEvent(new Event('change'))
		})
	}

	if (presetSearch) {
		const onSearchInput = function () {
			if (presetSearchClear) presetSearchClear.hidden = !presetSearch.value
			const prev = presetSel ? presetSel.value : ''
			rebuildPresets(funcSel ? funcSel.value : '')
			if (presetSel && presetSel.value !== prev) {
				presetSel.dispatchEvent(new Event('change'))
			}
		}
		presetSearch.addEventListener('input', onSearchInput)
		if (presetSearchClear) {
			presetSearchClear.addEventListener('click', function () {
				presetSearch.value = ''
				onSearchInput()
				presetSearch.focus()
			})
		}
	}

	if (funcSel) {
		funcSel.addEventListener('change', function () {
			syncFuncTabs(funcSel.value)
			if (_skipFuncEvent) { _skipFuncEvent = false; return }
			if (presetSearch && presetSearch.value) {
				presetSearch.value = ''
				if (presetSearchClear) presetSearchClear.hidden = true
			}
			if (presetSel) presetSel.value = ''
			rebuildPresets(funcSel.value)
			if (presetSel && presetSel.value) presetSel.dispatchEvent(new Event('change'))
		})
	}

	if (presetSel) {
		function buildWithParam(overrideBaseCode) {
			const name = presetSel.value
			if (!name) return
			const preset = presetItemByName(name)
			if (!preset) return
			if (previewEl) previewEl.value = ''
			if (funcSel && preset.func != null && funcSel.value !== String(preset.func)) {
				const hasOpt = Array.prototype.some.call(funcSel.options, function (o) { return o.value === String(preset.func) })
				if (hasOpt) {
					_skipFuncEvent = true
					funcSel.value = String(preset.func)
					syncFuncTabs(String(preset.func))
				}
			}

			if (isSekMode()) {
				const tlv = JSON.parse(JSON.stringify(preset.tlv || []))
				if (preset.param) {
					const bytes = encodeParamToBytes(preset, overrideBaseCode)
					if (!bytes || !bytes.length) return
					for (let i = 0; i < tlv.length; i++) {
						const items = tlv[i].items || []
						for (let j = 0; j < items.length; j++) {
							if (!items[j].value || items[j].value.length === 0) items[j].value = bytes
						}
					}
				}
				const tlvStr = presetToTlvJson({ func: preset.func, tlv: tlv })
				if (tlvInput) tlvInput.value = tlvStr
				if (buildBtn) buildBtn.click()
				return
			}

			// 通用协议模式
			let payloadBytes = null
			if (preset.param) {
				payloadBytes = encodeParamToBytes(preset, overrideBaseCode)
				if (payloadBytes == null) return
			} else if (Array.isArray(preset.payload)) {
				payloadBytes = preset.payload.slice()
			} else if (typeof preset.payloadHex === 'string') {
				payloadBytes = hexToBytes(preset.payloadHex)
			} else {
				payloadBytes = []
			}
			if (tlvInput) tlvInput.value = bytesToHexSpaced(payloadBytes)
			if (buildBtn) buildBtn.click()
		}
		_buildWithParamRef = buildWithParam

		presetSel.addEventListener('change', function (e) {
			const name = e.target.value
			if (!name) {
				if (paramGroup) paramGroup.style.display = 'none'
				if (presetDescEl) { presetDescEl.textContent = ''; presetDescEl.hidden = true }
				return
			}
			const preset = presetItemByName(name)
			if (!preset) {
				if (paramGroup) paramGroup.style.display = 'none'
				if (presetDescEl) { presetDescEl.textContent = ''; presetDescEl.hidden = true }
				return
			}
			if (presetDescEl) {
				presetDescEl.textContent = preset.desc || ''
				presetDescEl.hidden = !preset.desc
			}
			if (preset.param && paramGroup && paramVal && paramSelEnum && paramLabel) {
				paramGroup.style.display = ''
				paramLabel.style.display = preset.param.type === 'multi' ? 'none' : ''
				paramLabel.textContent = preset.param.label || '参数'
				if (multiContainer) { multiContainer.style.display = 'none'; multiContainer.innerHTML = '' }
				paramVal.removeAttribute('inputmode')
				paramVal.removeAttribute('min')
				paramVal.removeAttribute('max')
				if (preset.param.type === 'enum') {
					paramVal.style.display = 'none'
					paramVal.type = 'text'
					paramSelEnum.style.display = ''
					paramSelEnum.innerHTML = ''
					const opts = preset.param.options || {}
					const def = preset.param.default != null ? preset.param.default : (Object.keys(opts)[0] || '0')
					Object.entries(opts).forEach(function (kv) {
						const op = doc.createElement('option')
						op.value = kv[0]
						op.textContent = kv[1] ? String(kv[1]) : String(kv[0])
						if (String(kv[0]) === String(def)) op.selected = true
						paramSelEnum.appendChild(op)
					})
					setParamUnit('', false)
					_currentParamType = 'enum'
				} else if (preset.param.type === 'ascii') {
					paramVal.type = 'text'
					paramVal.style.display = ''
					paramVal.style.width = '180px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default != null ? String(preset.param.default) : ''
					paramVal.placeholder = preset.param.placeholder || 'ASCII 字符串'
					setParamUnit(preset.param.fillLen ? ('(' + preset.param.fillLen + 'B)') : '', false)
					_currentParamType = 'ascii'
				} else if (preset.param.type === 'bcd' || preset.param.type === 'bcd_le' || preset.param.type === 'bcd_be') {
					paramVal.type = 'text'
					paramVal.style.display = ''
					paramVal.style.width = '180px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default != null ? String(preset.param.default) : ''
					paramVal.placeholder = preset.param.placeholder || '纯数字'
					setParamUnit(paramUnitHint(preset.param.type), false)
					_currentParamType = preset.param.type
				} else if (preset.param.type === 'dailyQuery') {
					paramVal.type = 'number'
					paramVal.style.display = ''
					paramVal.style.width = '80px'
					paramSelEnum.style.display = 'none'
					paramVal.min = '1'
					paramVal.max = String(preset.param.max || 60)
					paramVal.value = preset.param.default || '30'
					setParamUnit('天(日起=今天,≤60)', false)
					_currentParamType = 'dailyQuery'
				} else if (preset.param.type === 'errLogQuery') {
					paramVal.type = 'number'
					paramVal.style.display = ''
					paramVal.style.width = '80px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default || '4'
					setParamUnit('条(起点=现在)', false)
					_currentParamType = 'errLogQuery'
				} else if (preset.param.type === 'histDate') {
					const b = histDateBounds(preset.param.maxDays || 60)
					paramVal.type = 'date'
					paramVal.style.display = ''
					paramVal.style.width = '150px'
					paramSelEnum.style.display = 'none'
					paramVal.min = b.min
					paramVal.max = b.max
					paramVal.value = preset.param.default || b.default
					setParamUnit('近' + (preset.param.maxDays || 60) + '日可选', false)
					_currentParamType = 'histDate'
				} else if (preset.param.type === 'hex' || preset.param.type === 'hexbytes') {
					const fl = preset.param.fillLen != null ? preset.param.fillLen : preset.param.length
					paramVal.type = 'text'
					paramVal.style.display = ''
					paramVal.style.width = '180px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default != null ? String(preset.param.default) : ''
					paramVal.placeholder = preset.param.placeholder || 'HEX, 如 01 02 03 04'
					setParamUnit(fl ? ('(' + fl + 'B)') : '', false)
					_currentParamType = preset.param.type
				} else if (preset.param.type === 'largeFlow') {
					paramVal.type = 'text'
					paramVal.inputMode = 'decimal'
					paramVal.style.display = ''
					paramVal.style.width = '120px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default != null ? String(preset.param.default) : '0'
					paramVal.placeholder = preset.param.placeholder || '输入 m³，如 123.456'
					setParamUnit('下发前自动读当量', false)
					_currentParamType = 'largeFlow'
				} else if (preset.param.type === 'multi') {
					paramVal.style.display = 'none'
					paramSelEnum.style.display = 'none'
					setParamUnit('', false)
					renderMultiFields(preset.param.fields || [])
					_currentParamType = 'multi'
				} else {
					paramVal.type = 'text'
					paramVal.style.display = ''
					paramVal.style.width = '100px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default != null ? String(preset.param.default) : '0'
					paramVal.placeholder = preset.param.placeholder || '值'
					setParamUnit(paramUnitHint(preset.param.type) || '(u8)', false)
					_currentParamType = preset.param.type
				}
			} else {
				if (paramGroup) paramGroup.style.display = 'none'
				_currentParamType = ''
			}
			buildWithParam()
		})

		if (paramVal) {
			paramVal.addEventListener('input', function () {
				if (_currentParamType) buildWithParam()
			})
			paramVal.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') {
					e.preventDefault()
					if (sendProtoBtn) sendProtoBtn.click()
				}
			})
		}
		if (paramSelEnum) {
			paramSelEnum.addEventListener('change', function () {
				buildWithParam()
			})
		}
	}

	// ---- 协议子页控制器（如 SEK: 下行下发 / eSIM；hostProto: 命令下发 / STS 模拟；工装: 下行下发 / 工位测试） ----
	const SUBTAB_STATE_KEY = 'protocolSubTabState'
	let _subTabProtoId = ''
	let _subTabs = []
	let _activeSubTabId = ''

	function loadSubTabState() {
		try {
			const raw = localStorage.getItem(SUBTAB_STATE_KEY)
			const obj = raw ? JSON.parse(raw) : null
			return obj && typeof obj === 'object' ? obj : {}
		} catch (e) {
			return {}
		}
	}

	function saveSubTabState(protoId, tabId) {
		if (!protoId || !tabId) return
		try {
			const st = loadSubTabState()
			st[protoId] = tabId
			localStorage.setItem(SUBTAB_STATE_KEY, JSON.stringify(st))
		} catch (e) { /* 忽略 */ }
	}

	function featureEnabled(feat) {
		if (!feat) return true
		return !root.AppPlatform || typeof root.AppPlatform.has !== 'function' || !!root.AppPlatform.has(feat)
	}

	function renderSubTabBar() {
		const wrap = $('protocol-subtabs')
		const seg = $('protocol-subtabs-seg')
		if (!wrap || !seg) return
		if (_subTabs.length <= 1) {
			wrap.hidden = true
			seg.textContent = ''
			return
		}
		wrap.hidden = false
		seg.textContent = ''
		_subTabs.forEach(function (tab) {
			const btn = doc.createElement('button')
			btn.type = 'button'
			btn.setAttribute('role', 'tab')
			btn.dataset.subtab = tab.id
			btn.setAttribute('aria-pressed', String(tab.id === _activeSubTabId))
			if (tab.icon) {
				const ic = doc.createElement('i')
				ic.className = 'bi ' + tab.icon
				ic.setAttribute('aria-hidden', 'true')
				btn.appendChild(ic)
				btn.appendChild(doc.createTextNode(' '))
			}
			btn.appendChild(doc.createTextNode(tab.label || tab.id))
			btn.addEventListener('click', function () {
				selectSubTab(_subTabProtoId, tab.id)
			})
			seg.appendChild(btn)
		})
	}

	function applySubTabVisibility() {
		_subTabs.forEach(function (tab) {
			const active = tab.id === _activeSubTabId
			try {
				if (active && typeof tab.show === 'function') tab.show()
				else if (!active && typeof tab.hide === 'function') tab.hide()
			} catch (e) { /* ignore */ }
		})
		const seg = $('protocol-subtabs-seg')
		if (seg) {
			seg.querySelectorAll('button[data-subtab]').forEach(function (btn) {
				btn.setAttribute('aria-pressed', String(btn.dataset.subtab === _activeSubTabId))
			})
		}
	}

	function mountSubTabs(protoId, tabs) {
		unmountSubTabs()
		_subTabProtoId = String(protoId || '')
		_subTabs = (Array.isArray(tabs) ? tabs : []).filter(function (t) {
			return t && t.id && featureEnabled(t.feature)
		})
		if (!_subTabs.length) return
		const saved = loadSubTabState()[_subTabProtoId]
		const hit = _subTabs.some(function (t) { return t.id === saved })
		_activeSubTabId = hit ? saved : _subTabs[0].id
		renderSubTabBar()
		applySubTabVisibility()
	}

	function selectSubTab(protoId, tabId) {
		if (!_subTabs.length) return false
		if (protoId && _subTabProtoId && protoId !== _subTabProtoId) return false
		const found = _subTabs.some(function (t) { return t.id === tabId })
		if (!found) return false
		_activeSubTabId = tabId
		saveSubTabState(_subTabProtoId, tabId)
		applySubTabVisibility()
		return true
	}

	function unmountSubTabs(protoId) {
		if (protoId && _subTabProtoId && protoId !== _subTabProtoId) return
		_subTabs.forEach(function (tab) {
			try { if (typeof tab.hide === 'function') tab.hide() } catch (e) { /* ignore */ }
		})
		_subTabProtoId = ''
		_subTabs = []
		_activeSubTabId = ''
		const wrap = $('protocol-subtabs')
		const seg = $('protocol-subtabs-seg')
		if (wrap) wrap.hidden = true
		if (seg) seg.textContent = ''
	}

	root.ProtocolSubTabs = {
		mount: mountSubTabs,
		unmount: unmountSubTabs,
		select: selectSubTab,
		active: function (protoId) {
			if (protoId && protoId !== _subTabProtoId) return ''
			return _activeSubTabId
		},
	}

	// ---- 面板挂载/卸载 ----
	function setSekCardsVisible(visible) {
		const disp = visible ? '' : 'none'
		for (let i = 0; i < SEK_ONLY_IDS.length; i++) {
			const el = $(SEK_ONLY_IDS[i])
			if (el) el.style.display = disp
		}
		if (!visible) {
			const esim = $('sk-esim-card')
			if (esim) esim.style.display = 'none'
		}
	}

	function mountSekPanel() {
		setParseOnlyHintVisible(false)
		setSekCardsVisible(true)
		configureCardForMode('sek', activeProto())
		if (previewEl) previewEl.value = ''
		if (funcSel) {
			syncFuncTabs(funcSel.value)
			if (presetSel) presetSel.value = ''
			rebuildPresets(funcSel.value)
		}
		if (presetSel && presetSel.value) {
			presetSel.dispatchEvent(new Event('change'))
		}
		const esimCard = $('sk-esim-card')
		const advEl = $('serial-protocol-advanced')
		if (esimCard && $('protocol-subtabs')) {
			mountSubTabs('sek', [
				{
					id: 'downlink',
					label: '下行下发',
					icon: 'bi-arrow-down-circle',
					show: function () {
						if (downCard) downCard.style.display = ''
						if (advEl) advEl.style.display = ''
					},
					hide: function () {
						if (downCard) downCard.style.display = 'none'
						if (advEl) advEl.style.display = 'none'
					},
				},
				{
					id: 'esim',
					label: 'eSIM 管理',
					icon: 'bi-sim',
					feature: 'panel.esim',
					show: function () { esimCard.style.display = '' },
					hide: function () { esimCard.style.display = 'none' },
				},
			])
		} else if (esimCard) {
			esimCard.style.display = featureEnabled('panel.esim') ? '' : 'none'
		}
	}

	function unmountSekPanel() {
		unmountSubTabs('sek')
		setSekCardsVisible(false)
	}

	function mountGenericPanel(proto) {
		unmountSubTabs()
		setSekCardsVisible(false)
		const stsHost = $('hostproto-sts-host')
		if (stsHost) stsHost.style.display = 'none'
		const hasDownlink = !!(proto && (
			(Array.isArray(proto.presets) && proto.presets.length > 0) ||
			typeof proto.buildDownFrame === 'function'
		))
		if (hasDownlink) {
			setParseOnlyHintVisible(false)
			if (downCard) downCard.style.display = ''
			configureCardForMode('generic', proto)
			if (funcSel) {
				syncFuncTabs(funcSel.value)
				if (presetSel) presetSel.value = ''
				rebuildPresets(funcSel.value)
			}
			if (tlvInput) tlvInput.value = ''
			if (previewEl) previewEl.value = ''
			if (presetSel && presetSel.value) {
				presetSel.dispatchEvent(new Event('change'))
			}
		} else {
			if (downCard) downCard.style.display = 'none'
			setParseOnlyHintVisible(true)
		}

		// hostProto 内置 STS 模拟子页
		if (proto && proto.id === 'hostproto' && stsHost && $('protocol-subtabs')) {
			mountSubTabs('hostproto', [
				{
					id: 'downlink',
					label: '命令下发',
					icon: 'bi-arrow-down-circle',
					show: function () { if (downCard) downCard.style.display = '' },
					hide: function () { if (downCard) downCard.style.display = 'none' },
				},
				{
					id: 'sts-sim',
					label: 'STS 模拟',
					icon: 'bi-broadcast',
					feature: 'panel.sts-sim',
					show: function () { stsHost.style.display = '' },
					hide: function () { stsHost.style.display = 'none' },
				},
			])
			return
		}
		// 外部 JS 插件可声明自定义 subTabs: [{ id, label, icon, feature, show, hide }]
		if (proto && Array.isArray(proto.subTabs) && proto.subTabs.length && $('protocol-subtabs')) {
			const tabs = []
			if (hasDownlink) {
				tabs.push({
					id: 'downlink',
					label: '下行下发',
					icon: 'bi-arrow-down-circle',
					show: function () { if (downCard) downCard.style.display = '' },
					hide: function () { if (downCard) downCard.style.display = 'none' },
				})
			}
			proto.subTabs.forEach(function (t) { if (t && t.id) tabs.push(t) })
			mountSubTabs(proto.id, tabs)
		}
	}

	function unmountGenericPanel() {
		unmountSubTabs()
		if (downCard) downCard.style.display = 'none'
		const stsHost = $('hostproto-sts-host')
		if (stsHost) stsHost.style.display = 'none'
		setParseOnlyHintVisible(false)
	}

	// 兼容旧全局接口
	root.rebuildProtocolPresets = function () {
		if (!funcSel) return
		rebuildPresets(funcSel.value)
	}

	lib.mountGenericPanel = mountGenericPanel
	lib.unmountGenericPanel = unmountGenericPanel
	lib.mountSekPanel = mountSekPanel
	lib.unmountSekPanel = unmountSekPanel

	// 把通用面板钩子接入宿主桥
	if (host && typeof host.setGenericPanelHandlers === 'function') {
		host.setGenericPanelHandlers({
			mountGenericPanel: mountGenericPanel,
			unmountGenericPanel: unmountGenericPanel,
		})
	}

	// 注册内置默认协议 'sek'（使用原始 protocol.js 实现，避免进入 common.js 代理递归）
	const rawSek = host.rawSek || {}
	if (typeof root.registerProtocol === 'function' && (rawSek.parseFrame || typeof root.skParseFrame === 'function')) {
		root.registerProtocol('sek', {
			name: 'SEK',
			builtin: true,
			source: 'builtin',
			description: '默认 TLV 通信协议（支持查询 / 参数设置 / 指令操作与加解密）',
			parseFrame: rawSek.parseFrame || root.skParseFrame,
			formatFrame: rawSek.formatFrame || root.skFormatFrame,
			logView: rawSek.logView || (typeof root.skLogView === 'function' ? root.skLogView : null),
			findFrame: rawSek.findFrame || (typeof root.skFindFrame === 'function' ? root.skFindFrame : null),
			byteMap: rawSek.byteMap || (typeof root.skByteMap === 'function' ? root.skByteMap : null),
			buildDownFrame: rawSek.buildDownFrame || (typeof root.skBuildDownFrame === 'function' ? root.skBuildDownFrame : null),
			updateFrameTime: rawSek.updateFrameTime || (typeof root.skUpdateFrameTime === 'function' ? root.skUpdateFrameTime : null),
			presets: root.SK_DOWN_PRESETS || [],
			funcTabs: SEK_FUNC_TABS,
			mountPanel: mountSekPanel,
			unmountPanel: unmountSekPanel,
		})
	}

	// 启动收尾：protocol-downlink.js 位于内置协议之后、json-protocol.js / js-protocol-plugin.js 之前，
	// 使全部内置协议（含 sek）在任何自定义插件执行前完成注册锁定；启动对账延后到 DOMContentLoaded（若文档已非 loading 则通过微任务等同步脚本跑完）：
	// 1) 非桌面环境下无条件对账全部路（含双路非主发路 B），确保已删除或已隐藏的协议立即回退；
	// 2) 桌面端先按当前已知状态处理，并通过 JsProtocolPlugin.whenScanned() 等待首次目录扫描结束后再统一对账全部路（消除事件早于监听派发的竞态）。
	function finalizeStartup() {
		const reg = root.ProtocolRegistry
		if (!reg) return
		const activeId = root._activeProtocol || 'sek'
		const hasDesktopPluginDir = !!(root.AppPlatform && typeof root.AppPlatform.service === 'function' && root.AppPlatform.service('protocol-plugins'))
		if (!hasDesktopPluginDir) {
			if (reg.has(activeId) && reg.isSelectable(activeId)) {
				if (activeId !== 'sek') setSekCardsVisible(false)
				reg.activatePanel(activeId, { force: true })
			}
			reg.reconcileActiveLanes()
		} else {
			if (reg.has(activeId) && reg.isSelectable(activeId)) {
				if (activeId !== 'sek') setSekCardsVisible(false)
				reg.activatePanel(activeId, { force: true })
			} else if (activeId !== 'sek') {
				setSekCardsVisible(false)
			}
			const jsp = root.JsProtocolPlugin
			if (jsp && typeof jsp.whenScanned === 'function') {
				Promise.resolve(jsp.whenScanned()).finally(function () {
					reg.reconcileActiveLanes()
				})
			} else {
				reg.reconcileActiveLanes()
			}
		}
	}
	if (doc && doc.readyState === 'loading' && typeof doc.addEventListener === 'function') {
		doc.addEventListener('DOMContentLoaded', finalizeStartup, { once: true })
	} else if (typeof Promise === 'function') {
		Promise.resolve().then(finalizeStartup)
	} else if (typeof setTimeout === 'function') {
		setTimeout(finalizeStartup, 0)
	} else {
		finalizeStartup()
	}
})(typeof window !== 'undefined' ? window : globalThis)
