// SEK 协议的设备面板声明（device 契约，见 AGENTS.md「设备面板」段与 js/protocol-registry.js 的 normalizeDevice）。
// 由 js/protocol-downlink.js 注册 SEK 时作为 device 带上；宿主（js/device-panel.js 等）不认识这里的任何 Tag / ID。
// 字段名称与类型从 SK_TAGS 派生（系数、单位、枚举走 protocol.js 的 skDescCodec，与解析页同一套规则），
// 这里只写：读哪些组、哪些字段上哪个部件、参数分几类，以及少数描述里没有的显示单位。
// 请求帧走 SEK 现有组帧（sekTx.buildDown：帧序号、协议版本、平台时间、下行加密与现有下发一致）。
;(function (root) {
	'use strict'
	const W = root
	const TAGS = W.SK_TAGS || {}
	const TAG_NAME = W.SK_TAG_NAME || {}
	const QUERY_FUNC = 0x03
	const QUERY_ACK = 0x83
	const REPORT_FUNC = 0x02

	// 读取组：组 id → 应答 Tag。查询 ID 从 Tag10 的描述「响应返回tagN」派生
	const GROUP_TAGS = [
		['base', 1], ['core', 2], ['alarm', 4], ['uplink', 92], ['run', 91],
		['param', 3], ['valve', 36], ['ble', 37],
	]
	const STATUS_GROUPS = ['base', 'core', 'alarm', 'uplink', 'run']

	// 描述里没写成可解析单位、或要换成更合适显示的少数字段（只影响显示）
	const DISPLAY = {
		'2:5': { unit: 'L/h' },
		'2:30': { unit: '%' },
		'2:31': { unit: '%' },
		'92:0': { unit: '次' },
		'92:1': { unit: '次' },
		'92:7': { unit: 'dBm' },
		'92:8': { unit: 'dB' },
		'92:4': { kind: 'hex', digits: 8 },
		'3:10': { unit: '次' },
		'3:11': { unit: '分钟' },
		'3:12': { unit: '分钟' },
		'3:30': { unit: '位' },
		'36:4': { unit: '小时' },
		'36:5': { unit: '次' },
		'36:8': { unit: '天' },
		'36:1': { unit: '天' },
		'1:0': { copy: true }, '1:1': { copy: true }, '1:2': { copy: true }, '1:4': { copy: true },
		'1:5': { copy: true }, '1:10': { copy: true }, '1:12': { copy: true },
		'3:7': { note: '驻网后由模组回填，写入值可能被模组覆盖' },
		'3:18': { note: '设置口径会按口径重置过流 / 反流阈值' },
	}

	const IDENTITY = [[1, 0], [1, 1], [1, 2], [1, 4], [1, 5], [1, 10], [1, 12]]
	const STATUS_KEYS = [[2, 9], [2, 29], [2, 5], [2, 10], [2, 30], [2, 15], [2, 31], [2, 12], [2, 3], [2, 11], [1, 6],
		[92, 7], [92, 8], [92, 6], [92, 9], [92, 0], [92, 1], [92, 4], [91, 0]]
	const CATEGORIES = [
		{ id: 'biz', title: '业务平台', keys: [[3, 9], [3, 6], [3, 7], [3, 8], [3, 10], [3, 11], [3, 23]] },
		{ id: 'maint', title: '维护平台', keys: [[3, 22], [3, 21], [3, 40]] },
		{ id: 'alarm', title: '告警阈值', keys: [[3, 0], [3, 1], [3, 2], [3, 3], [3, 4], [3, 5]] },
		{ id: 'usage', title: '用水告警', keys: [[39, 3]] },
		{ id: 'meter', title: '计量参数', keys: [[3, 18], [3, 17], [3, 35], [3, 36], [3, 29], [3, 24], [3, 28], [3, 30], [3, 12], [3, 15]] },
		{ id: 'valve', title: '阀控', keys: [[36, 13], [36, 6], [36, 4], [36, 5], [36, 7], [36, 8], [36, 1]] },
		{ id: 'ble', title: '蓝牙', keys: [[37, 0], [37, 1]] },
	]
	// 基准水量（每圈升数），与 protocol.js 的 skSession 同一张表
	const BASE_LITERS = { 0: 1000, 1: 100, 2: 10, 3: 1, 4: 0.1, 5: 0.01, 6: 0.001 }

	function key(tag, id) { return tag + ':' + id }

	function schemaDef(tag, id) {
		const list = TAGS[String(tag)] || []
		for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
		return null
	}

	// Tag10 里「响应返回tagN」的查询 ID；同一 Tag 有多个查询 ID 时取与 Tag 同号的那条，否则取第一条
	function queryIdFor(tag) {
		const list = TAGS['10'] || []
		const hits = []
		const re = /响应返回\s*tag\s*(\d+)/i
		for (let i = 0; i < list.length; i++) {
			const d = list[i]
			if (d.type !== 'NULL') continue
			const m = re.exec(d.desc || '')
			if (m && +m[1] === tag) hits.push(d.id)
		}
		if (!hits.length) return null
		return hits.indexOf(tag) >= 0 ? tag : hits[0]
	}

	function codec() { return W.skDescCodec || null }

	// 从 SK_TAGS 的一项派生显示类型与取值方式（decode：u/i + 字节数 → 数值；text → 用 SEK 自己的解码文本；flag → 告警标志）
	function deriveDisplay(tag, d) {
		const t = d.type || ''
		const desc = d.desc || ''
		const dec = d.dec || {}
		if (tag === 4 && /^BYTE\[1\+/.test(t)) return { kind: 'flag', decode: 'flag' }
		if (dec.t === 'enum' && dec.map) return { kind: 'enum', options: dec.map, decode: 'u1' }
		if (dec.t === 'bits' && Array.isArray(dec.fields) && dec.fields.every(function (x) { return typeof x.bits === 'number' })) {
			const bits = []
			dec.fields.forEach(function (x) { bits[x.bits] = x.name })
			for (let i = 0; i < bits.length; i++) if (bits[i] == null) bits[i] = ''
			const size = /^BYTE\[(\d)\]$/.exec(t)
			return { kind: 'bits', bits: bits, decode: 'u' + (size ? size[1] : 1) }
		}
		// 多位字段、复合结构（如「起始日+时」「持续时间+阈值」）用 SEK 自己的解码文本
		if (dec.t && dec.t !== 'num') return { kind: 'text', decode: 'text' }
		if (/\+/.test(desc) && !/^BYTE(\[1\])?$/.test(t)) return { kind: 'text', decode: 'text' }
		const m = /^BYTE(?:\[(\d)\])?$/.exec(t)
		const size = m ? (m[1] ? +m[1] : 1) : 0
		const isText = /^char\[/i.test(t) || /ASCII/.test(desc) || /BCD/.test(desc) || /YYYYMMDDhhmmss/.test(desc)
		if (isText) return { kind: /YYYYMMDDhhmmss/.test(desc) && size === 7 ? 'time' : 'text', decode: 'text' }
		if (size === 1 || size === 2 || size === 4) {
			const c = codec()
			if (size === 1 && c) {
				const map = c.parseEnumMap(desc)
				if (Object.keys(map).length >= 2) return { kind: 'enum', options: map, decode: 'u1' }
			}
			const nu = c ? c.numUnit(desc) : { scale: 1, unit: '' }
			const scale = dec.scale != null ? dec.scale : nu.scale
			const unit = dec.unit || nu.unit || ''
			const dot = String(scale).split('.')[1]
			return { kind: 'number', scale: scale, unit: unit === 'uA' ? 'µA' : unit, decimals: scale !== 1 && dot ? dot.length : null, decode: 'n' + size }
		}
		return { kind: 'text', decode: 'text' }
	}

	const GROUP_OF_TAG = {}
	GROUP_TAGS.forEach(function (g) { GROUP_OF_TAG[g[0]] = g[1] })
	const TAG_GROUP = {}
	GROUP_TAGS.forEach(function (g) { if (queryIdFor(g[1]) != null) TAG_GROUP[g[1]] = g[0] })

	const FIELD_DECODE = {}
	const FIELD_DESC = {}
	const FIELD_SETTING = Object.create(null)
	const SETTINGS = Object.create(null)
	const LIMITS = { '3:9': { step: 30 }, '3:10': { max: 4 }, '3:12': { min: 30, max: 1440, step: 30 }, '3:15': { step: 5 }, '3:22': { step: 1440 }, '36:1': { max: 31 }, '36:8': { min: 1, max: 45 } }
	const DANGER = { '3:6': '更改服务器地址可能使设备无法上报。', '3:7': '更改 APN 可能使设备无法联网。', '3:17': '这会改写设备累计底度。', '3:35': '这会改写设备正累计底度。', '3:36': '这会改写设备逆累计底度。', '3:18': '变更口径会重置部分告警阈值。', '3:21': '更改维护服务器地址可能导致失联。', '3:23': '更改通信方式可能导致失联。', '3:29': '这会更改流量换算基准。', '36:6': '这会更改阀门的应急开阀行为。', '36:7': '这会更改低电压关阀行为。', '37:1': '关闭广播可能影响蓝牙连接。' }
	const SECRET_FIELDS = [[3, 16], [38, 1]]
	const presetCodec = W.SK_PRESET_CODEC
	if (presetCodec) (W.SK_DOWN_PRESETS || []).forEach(function (category) {
		category.items.forEach(function (preset) {
			const block = preset.tlv && preset.tlv.length === 1 && preset.tlv[0]
			const item = block && block.items.length === 1 && block.items[0]
			if (!item || !preset.param || preset.func !== '0x01' || block.tag === 34) return
			const name = key(block.tag, item.id)
			const param = name === '3:5' ? { type: 'uint16le', label: '16 位告警位域（十进制）' } : preset.param
			if (!presetCodec.settingRange(param) && !['multi', 'ascii', 'largeFlow'].includes(param.type)) return
			SETTINGS[name] = { tag: block.tag, id: item.id, param: param }
		})
	})

	function rulesFor(k, param) {
		const range = presetCodec.settingRange(param)
		if (range) return Object.assign({ step: 1, hint: param.label, options: param.options, confirm: DANGER[k] }, range, LIMITS[k])
		if (param.type === 'ascii') return { maxLen: param.fillLen || param.length, pattern: '[ -~]*', hint: param.placeholder || param.label, confirm: DANGER[k] }
		if (param.type === 'largeFlow') return { maxLen: 32, pattern: '[0-9]+(?:\\.[0-9]+)?', hint: '底度 (m³)，先读取当量', confirm: DANGER[k] }
		return { maxLen: 96, hint: param.fields.map(function (part) { return part.label }).join('，'), confirm: DANGER[k] }
	}

	function makeField(tag, id) {
		const d = schemaDef(tag, id)
		if (!d) return null
		const k = key(tag, id)
		const disp = deriveDisplay(tag, d)
		FIELD_DECODE[k] = disp.decode
		FIELD_DESC[k] = d.desc || ''
		const f = {
			key: k,
			name: d.name,
			addr: 'Tag' + tag + '-ID' + id,
			kind: disp.kind,
			unit: disp.unit || '',
			scale: disp.scale != null ? disp.scale : 1,
			decimals: disp.decimals,
			options: disp.options || null,
			bits: disp.bits || null,
			group: TAG_GROUP[tag] || null,
			secret: SECRET_FIELDS.some(function (pair) { return pair[0] === tag && pair[1] === id }) || /PAK|密钥/i.test(d.name),
		}
		const setting = SETTINGS[k]
		if (setting && !f.secret) {
			FIELD_SETTING[k] = setting.param
			f.write = rulesFor(k, setting.param)
			if (setting.param.type === 'largeFlow') f.unit = 'm³'
		}
		return Object.assign(f, DISPLAY[k] || {})
	}

	const fields = []
	const seen = {}
	function addField(tag, id) {
		const k = key(tag, id)
		if (seen[k]) return k
		const f = makeField(tag, id)
		if (!f) return null
		seen[k] = true
		fields.push(f)
		return k
	}
	const ALARM_KEYS = (TAGS['4'] || []).filter(function (d) { return /^BYTE\[1\+/.test(d.type || '') }).map(function (d) { return addField(4, d.id) }).filter(Boolean)
	const IDENTITY_KEYS = IDENTITY.map(function (p) { return addField(p[0], p[1]) }).filter(Boolean)
	STATUS_KEYS.forEach(function (p) { addField(p[0], p[1]) })
	SECRET_FIELDS.forEach(function (pair) { addField(pair[0], pair[1]) })
	const categories = CATEGORIES.map(function (c) {
		return { id: c.id, title: c.title, keys: c.keys.map(function (p) { return addField(p[0], p[1]) }).filter(Boolean) }
	})

	const groups = GROUP_TAGS.filter(function (g) { return queryIdFor(g[1]) != null }).map(function (g) {
		return { id: g[0], title: TAG_NAME[g[1]] || ('Tag' + g[1]), request: { tag: g[1], query: queryIdFor(g[1]) } }
	})

	function funcOf(parsed) {
		const f = parsed && parsed.fields ? parsed.fields['功能码'] : null
		return f && typeof f === 'object' ? f.value : f
	}

	function isValueFrame(parsed) {
		if (!parsed || parsed.dir !== 'up' || !Array.isArray(parsed.tlv)) return false
		const fc = funcOf(parsed)
		return fc === QUERY_ACK || fc === REPORT_FUNC
	}

	function decodeItem(k, item) {
		const how = FIELD_DECODE[k]
		const raw = item.raw || []
		if (FIELD_SETTING[k]) return settingRaw(FIELD_SETTING[k], raw, item.baseCode)
		if (how === 'flag') {
			const on = raw.length > 0 && raw[0] !== 0 && raw[0] !== 0xff
			let note = ''
			if (on) note = String(item.decoded || '').replace(/^(不)?报警\s*/, '').trim()
			return [on, note]
		}
		if (how === 'text') return item.decoded != null ? String(item.decoded) : ''
		if (how && (how[0] === 'u' || how[0] === 'n')) {
			const size = +how.slice(1)
			if (raw.length < size) return undefined
			const c = codec()
			if (how[0] === 'n' && c) return c.readNum(Uint8Array.from(raw.slice(0, size)), FIELD_DESC[k])
			let v = 0
			for (let i = size - 1; i >= 0; i--) v = v * 256 + (raw[i] & 0xff)
			return v
		}
		return item.decoded != null ? String(item.decoded) : undefined
	}

	function settingRaw(param, raw, base) {
		if (param.type === 'ascii') return String.fromCharCode.apply(null, raw).replace(/\x00+$/, '')
		if (param.type === 'largeFlow') {
			if (raw.length !== 8 || (raw[0] & 1) || base == null) return undefined
			let units = 0n
			for (let index = 7; index > 0; index--) units = (units << 8n) | BigInt(raw[index])
			return presetCodec.unitsToM3(units, base)
		}
		let offset = 0
		function number(part) {
			if (part.bits) return (raw[0] >> part.bits[1]) & ((1 << (part.bits[0] - part.bits[1] + 1)) - 1)
			const type = part.type === 'enum' ? part.valueType || 'uint8' : part.type
			const size = +(/(8|16|32)/.exec(type) || [0, 8])[1] / 8
			if (offset + size > raw.length) return undefined
			const view = new DataView(Uint8Array.from(raw.slice(offset, offset + size)).buffer)
			offset += size
			const read = 'get' + (type[0] === 'u' ? 'Uint' : 'Int') + size * 8
			return view[read](0, !type.endsWith('be'))
		}
		if (param.type !== 'multi') return number(param)
		const values = param.fields.map(number)
		return values.every(function (value) { return value !== undefined }) ? values : undefined
	}

	function parseInput(field, text) {
		const param = SETTINGS[field.key].param
		if (param.type === 'ascii') return text
		if (param.type === 'largeFlow') {
			const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
			if (!match) return undefined
			const fraction = (match[2] || '').replace(/0+$/, '')
			return BigInt(match[1]).toString() + (fraction ? '.' + fraction : '')
		}
		if (param.type === 'multi') {
			const parts = text.split(/[,，]/)
			if (parts.length !== param.fields.length) return undefined
			return param.fields.map(function (part, index) { return presetCodec.settingNumber(part, parts[index]) })
		}
		return presetCodec.settingNumber(param, text)
	}

	function buildWrite(field, value, ctx) {
		const setting = SETTINGS[field.key]
		let bytes
		if (setting.param.type === 'largeFlow') {
			const parameterBase = ctx.get('3:29')
			const base = parameterBase == null ? ctx.get('2:29') : parameterBase
			if (base == null) throw new Error('先读取本连接的基准水量')
			const result = presetCodec.largeFlowM3ToBytes(value, base)
			if (result.error) throw new Error(result.error)
			if (presetCodec.unitsToM3(result.units, result.baseCode) !== value) throw new Error('底度不能按当前基准精确表示')
			bytes = result.bytes
		} else bytes = presetCodec.settingBytes(setting.param, value)
		return buildDown({ funcCode: '0x01', tlv: [{ tag: setting.tag, items: [{ id: setting.id, value: bytes }] }] })
	}

	function matchWriteReply(field, parsed) {
		const setting = SETTINGS[field.key]
		if (!setting || !parsed || parsed.ok === false || parsed.dir !== 'up' || ![0x81, 0x91].includes(funcOf(parsed))) return null
		const blocks = parsed.tlv || []
		let result = null
		const matching = blocks.find(function (block) { return block.tag === setting.tag && !block.error })
		const item = matching && (matching.items || []).find(function (candidate) { return candidate.id === setting.id && candidate.resultCode != null })
		if (item) result = item.resultCode
		else if (blocks.length === 1 && blocks[0].tag === 11 && !blocks[0].error && W.sekTx && typeof W.sekTx.tag11Result === 'function') result = W.sekTx.tag11Result(parsed)
		return result == null ? null : result === 1 ? 'ok' : result === 0 ? 'processing' : 'rejected'
	}

	function extract(parsed) {
		if (!isValueFrame(parsed)) return null
		const out = {}
		parsed.tlv.forEach(function (blk) {
			if (blk.error) return
			;(blk.items || []).forEach(function (it) {
				if (it.partial) return
				const k = key(blk.tag, it.id)
				if (!seen[k]) return
				const v = decodeItem(k, it)
				if (v !== undefined) out[k] = v
			})
		})
		return out
	}

	function buildRequest(group) {
		const req = group && group.request
		if (!req || req.query == null) throw new Error('该组没有查询 ID')
		return buildDown({ funcCode: '0x03', tlv: [{ tag: 10, items: [{ id: req.query, value: [] }] }] })
	}

	function buildDown(opts) {
		if (W.sekTx && typeof W.sekTx.buildDown === 'function') return W.sekTx.buildDown(opts).frame
		if (typeof W.skBuildDownFrame !== 'function') throw new Error('SEK 组帧不可用')
		const api = W.serialApi
		return W.skBuildDownFrame(Object.assign({ encKey: api && typeof api.getEncKey === 'function' ? api.getEncKey() : null }, opts))
	}

	function matchReply(group, parsed) {
		const req = group && group.request
		if (!req || !parsed || parsed.dir !== 'up' || funcOf(parsed) !== QUERY_ACK) return false
		return (parsed.tlv || []).some(function (blk) { return blk.tag === req.tag && !blk.error })
	}

	function baseLitersFrom(get) {
		const c = get('2:29')
		const code = c != null ? c : get('3:29')
		return code != null && BASE_LITERS[code] != null ? BASE_LITERS[code] : null
	}

	function format(k, raw, get) {
		const param = FIELD_SETTING[k]
		if (param && param.type === 'largeFlow' && typeof raw === 'string') return raw + ' m³'
		if (param && param.type === 'multi' && Array.isArray(raw)) {
			return param.fields.map(function (part, index) {
				const value = raw[index]
				return part.label + '：' + (part.options && Object.prototype.hasOwnProperty.call(part.options, value) ? part.options[value] : value)
			}).join(' · ')
		}
		if (k === '2:9' && typeof raw === 'number') {
			if (raw === 0xffffffff) return '异常(全FF)'
			const liters = baseLitersFrom(get)
			if (liters == null) return raw + ' 圈（未读基准水量）'
			return (raw * liters / 1000).toFixed(3) + ' m³'
		}
		return null
	}

	// 来源帧高亮：skByteMap 的分组名是 't<tag>i<id>o<偏移>'，同一帧内唯一，这里按 Tag + ID 前缀挑出该字段的分组
	function byteGroups(parsed, k) {
		if (typeof W.skByteMap !== 'function' || !parsed) return []
		const parts = String(k).split(':')
		if (parts.length !== 2) return []
		const prefix = 't' + parts[0] + 'i' + parts[1] + 'o'
		let map = null
		try { map = W.skByteMap(parsed) } catch (e) { return [] }
		const out = []
		;(map || []).forEach(function (c) {
			if (c && typeof c.grp === 'string' && c.grp.indexOf(prefix) === 0 && out.indexOf(c.grp) < 0) out.push(c.grp)
		})
		return out
	}

	const has = function (k) { return !!seen[k] }
	const status = [
		{ type: 'metric', title: '累计流量', key: '2:9', sub: ['2:29', '2:5'] },
		{ type: 'metric', title: '电池', key: '2:10', sub: ['2:30', '2:15', '2:31'], meter: '2:30' },
		{ type: 'metric', title: '信号', key: '92:7', sub: ['92:8', '92:6', '92:9'] },
		{ type: 'metric', title: '阀门', key: '2:12', sub: ['2:3', '2:11'] },
		{ type: 'identity', title: '设备标识', keys: IDENTITY_KEYS },
		{ type: 'deviceTime', title: '设备时间', key: '1:6' },
		{ type: 'flags', title: '告警', keys: ALARM_KEYS },
		{ type: 'dayBitmap', title: '本月上报', key: '92:4', sub: ['92:0', '92:1'], days: 31, firstBit: 1, setMeans: 'bad', setLabel: '未上报', clearLabel: '已上报' },
		{ type: 'kv', title: '运行信息', keys: ['91:0'] },
	].filter(function (w) { return w.key ? has(w.key) : true })

	W.SekDevice = {
		title: '水表终端',
		nameKey: has('1:4') ? '1:4' : null,
		timeoutMs: 5000,
		fields: fields,
		groups: groups,
		readSets: { status: STATUS_GROUPS.filter(function (g) { return GROUP_OF_TAG[g] != null && TAG_GROUP[GROUP_OF_TAG[g]] }), all: groups.map(function (g) { return g.id }) },
		status: status,
		categories: categories,
		buildRequest: buildRequest,
		matchReply: matchReply,
		extract: extract,
		format: format,
		byteGroups: byteGroups,
		buildWrite: buildWrite,
		matchWriteReply: matchWriteReply,
		parseInput: parseInput,
	}
})(typeof window !== 'undefined' ? window : globalThis)
