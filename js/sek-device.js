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
		{ id: 'meter', title: '计量参数', keys: [[3, 18], [3, 17], [3, 29], [3, 24], [3, 28], [3, 30], [3, 12], [3, 15]] },
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
		const opts = { funcCode: '0x03', tlv: [{ tag: 10, items: [{ id: req.query, value: [] }] }] }
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

	// 只覆盖默认显示做不到的：累计流量按同一路读到的基准水量换算成 m³
	function format(k, raw, get) {
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
	}
})(typeof window !== 'undefined' ? window : globalThis)
