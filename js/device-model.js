// 设备面板的数据模型（纯函数，不碰 DOM 与串口，node 可测：tests/device-panel.cjs）。
// 读数按「路 + 协议」各存一份，每条读数记下来自哪一路、第几次连接（连接代次，见 serialApi.sessionGeneration）、哪一帧；
// 当前代次与读数代次不同就是过期（上次连接的值），界面灰显，不能当成当前值。
// 值的显示由协议在 device 契约里声明的显示类型决定（宿主不认识任何具体协议），协议给的 format 优先。
;(function (root) {
	'use strict'

	const MAX_FRAMES = 48
	function pad2(n) { return (n < 10 ? '0' : '') + n }

	function fmtDateTime(ms) {
		const d = new Date(ms)
		if (!Number.isFinite(d.getTime())) return ''
		return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
	}

	function fmtClock(ms) {
		const d = new Date(ms)
		if (!Number.isFinite(d.getTime())) return ''
		return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
	}

	function toHex(bytes) {
		const out = []
		for (let i = 0; i < bytes.length; i++) out.push(((bytes[i] & 0xff) < 16 ? '0' : '') + (bytes[i] & 0xff).toString(16).toUpperCase())
		return out.join(' ')
	}

	function createStore() {
		return { lanes: Object.create(null), seq: 0 }
	}

	function laneKey(sid, pid) { return sid + '|' + (pid || '') }

	function lane(store, sid, pid) {
		const k = laneKey(sid, pid)
		let L = store.lanes[k]
		if (!L) {
			L = store.lanes[k] = {
				sid: sid,
				pid: pid || '',
				readings: Object.create(null),
				drafts: Object.create(null),
				writes: Object.create(null),
				frames: [],
				groups: Object.create(null),
				unsure: Object.create(null), // rec id → 归属未确认说明
				busy: false,
				task: null,
				ui: { tab: 'status', cat: null, query: '', sel: null, more: false },
			}
		}
		return L
	}

	function findFrame(L, id) {
		for (let i = L.frames.length - 1; i >= 0; i--) if (L.frames[i].id === id) return L.frames[i]
		return null
	}

	// 只留被读数 / 组状态引用的帧，加上最近几帧
	function pruneFrames(L) {
		if (L.frames.length <= MAX_FRAMES) return
		const used = new Set()
		Object.keys(L.readings).forEach(function (k) { used.add(L.readings[k].rec) })
		Object.keys(L.groups).forEach(function (k) { if (L.groups[k].rec) used.add(L.groups[k].rec) })
		const keepTail = 8
		L.frames = L.frames.filter(function (f, i) { return used.has(f.id) || i >= L.frames.length - keepTail })
		const kept = new Set(L.frames.map(function (f) { return f.id }))
		Object.keys(L.unsure).forEach(function (id) { if (!kept.has(Number(id))) delete L.unsure[id] })
	}

	// 一帧进模型：o = { sid, pid, gen, at, bytes, parsed, device }。返回 { rec, keys, groups }，认不出就返回 null。
	// 收帧泵是唯一入口，每一帧只交来一次
	function ingest(store, o) {
		const dev = o && o.device
		if (!dev || typeof dev.extract !== 'function') return null
		const vals = dev.extract(o.parsed, o.bytes) || null
		const keys = vals ? Object.keys(vals) : []
		// 组认领：协议说这是该组的应答，且这一帧确实取到了该组的字段（组没有字段时只看认领）
		const matched = []
		if (typeof dev.matchReply === 'function') {
			dev.groups.forEach(function (g) {
				if (!dev.matchReply(g, o.parsed, o.bytes)) return
				if (groupHasFields(dev, g.id) && !keys.some(function (k) { return dev.fieldMap[k] && dev.fieldMap[k].group === g.id })) return
				matched.push(g.id)
			})
		}
		if (!keys.length && !matched.length) return null
		const L = lane(store, o.sid, o.pid)
		const bytes = Array.from(o.bytes || [])
		const hex = toHex(bytes)
		const at = typeof o.at === 'number' ? o.at : Date.now()
		// 每一帧只入账一次（收帧泵是唯一入口，请求只认领泵入账过的记录），所以这里不去重
		const rec = { id: ++store.seq, sid: o.sid, pid: o.pid || '', gen: o.gen, at: at, bytes: bytes, hex: hex, parsed: o.parsed,
			secret: keys.some(function (key) { return dev.fieldMap[key] && dev.fieldMap[key].secret }) }
		L.frames.push(rec)
		keys.forEach(function (k) {
			L.readings[k] = { raw: vals[k], at: rec.at, gen: rec.gen, rec: rec.id }
		})
		matched.forEach(function (gid) {
			const g = L.groups[gid] || (L.groups[gid] = {})
			g.at = rec.at
			g.gen = rec.gen
			g.rec = rec.id
			g.error = null
		})
		pruneFrames(L)
		return { rec: rec, keys: keys, groups: matched, values: vals }
	}

	function sameValue(left, right) {
		return left === right || (Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every(function (value, index) { return value === right[index] }))
	}

	function inputValue(dev, field, text) {
		const rule = field.write
		if (!rule) throw new Error('字段不可写')
		if (text.length > (rule.maxLen == null ? 2048 : rule.maxLen)) throw new Error('输入过长')
		if (rule.options && !Object.prototype.hasOwnProperty.call(rule.options, text)) throw new Error('请选择有效选项')
		if (rule.pattern) {
			const match = new RegExp('^(?:' + rule.pattern + ')$').exec(text)
			if (!match || match[0] !== text) throw new Error('输入格式无效')
		}
		let val = text
		const numeric = ['number', 'bits', 'hex'].includes(field.kind) || (field.kind === 'enum' && /^-?\d+(?:\.\d+)?$/.test(text)) || rule.min != null || rule.max != null || rule.step != null
		if (numeric && (rule.min != null || rule.max != null || rule.step != null || !dev.parseInput)) {
			val = field.kind === 'hex' && /^[\da-f]+$/i.test(text) ? Number('0x' + text) : Number(text)
			if (!text.trim() || !Number.isFinite(val) || (rule.min != null && val < rule.min) || (rule.max != null && val > rule.max)) throw new Error('数值超出范围')
			const steps = (val - (rule.min || 0)) / rule.step
			if (rule.step > 0 && Math.abs(steps - Math.round(steps)) > 1e-7) throw new Error('数值不符合步进')
		}
		if (dev.parseInput) val = dev.parseInput(field, text)
		else if (field.kind === 'flag') val = text === 'true' || text === '1' ? true : text === 'false' || text === '0' ? false : undefined
		if (val === undefined || val === null) throw new Error('协议无法转换此输入')
		return val
	}

	function allowsEmpty(dev, field) {
		const rule = field && field.write
		if (!rule || !rule.allowEmpty || rule.options) return false
		try { return inputValue(dev, field, '') !== undefined } catch (e) { return false }
	}

	function writeAllowed(L, field, gen) {
		const current = reading(L, field.key)
		return !!(field.write && (!field.group || (current && current.gen === gen)))
	}

	function writeResult(reply, confirmation, error, expected) {
		if (error) return { state: error.sent ? 'unknown' : 'skipped', detail: error.message }
		if (reply !== 'ok') return { state: reply }
		if (!confirmation || confirmation.unsure || confirmation.raw === undefined) return { state: 'unconfirmed', detail: confirmation && confirmation.detail }
		return { state: sameValue(expected, confirmation.raw) ? 'confirmed' : 'mismatch' }
	}

	function exportSnapshot(L, dev, draftText) {
		const values = Object.create(null)
		dev.fields.forEach(function (field) {
			const value = reading(L, field.key)
			if (!field.secret && value) values[field.key] = { raw: value.raw, at: value.at, gen: value.gen, text: field.write ? draftText(field, value.raw) : undefined }
		})
		return { version: 1, protocolId: L.pid, values: values }
	}

	function compareSnapshot(L, dev, gen, snapshot) {
		if (!snapshot || snapshot.version !== 1 || snapshot.protocolId !== L.pid || !snapshot.values || typeof snapshot.values !== 'object' || Array.isArray(snapshot.values)) throw new Error('快照格式或协议不匹配')
		return dev.fields.flatMap(function (field) {
			if (!field.write || field.secret || !Object.prototype.hasOwnProperty.call(snapshot.values, field.key)) return []
			const value = snapshot.values[field.key]
			if (!value || typeof value.text !== 'string') return []
			let raw
			try { raw = inputValue(dev, field, value.text) } catch (err) { return [] }
			if (!sameValue(raw, value.raw)) return []
			const current = reading(L, field.key)
			const state = !current || current.gen !== gen || readingUnsure(L, field.key) ? 'unread' : sameValue(current.raw, raw) ? 'same' : 'different'
			const formatted = formatValue(dev, field.key, raw, function (key) {
				const companion = dev.fieldMap[key] && !dev.fieldMap[key].secret && Object.prototype.hasOwnProperty.call(snapshot.values, key) && snapshot.values[key]
				if (!companion || companion.gen !== value.gen) return undefined
				const scalar = function (item) { return item === null || typeof item === 'string' || typeof item === 'boolean' || Number.isFinite(item) }
				if (scalar(companion.raw) || (Array.isArray(companion.raw) && companion.raw.length <= 64 && companion.raw.every(scalar))) return companion.raw
			})
			return [{ field: field, text: value.text, formatted: formatted, state: state }]
		})
	}

	function applySnapshot(L, rows) {
		rows.forEach(function (row) {
			if (row.state !== 'different') return
			L.drafts[row.field.key] = row.text
			delete L.writes[row.field.key]
		})
	}

	function setGroupBusy(L, gid, busy) {
		const g = L.groups[gid] || (L.groups[gid] = {})
		g.busy = !!busy
	}

	function setGroupError(L, gid, msg, gen, at) {
		const g = L.groups[gid] || (L.groups[gid] = {})
		g.busy = false
		g.error = { msg: String(msg || '失败'), gen: gen, at: at || Date.now() }
	}

	// 归属不明的应答：一组查询发出后没认领到应答就结束（超时、取消等），设备的应答可能还在路上，
	// 之后认领到的同组应答可能就是那条迟到应答（协议没有序号可对，宿主分不出来；同组匹配也证明不了它就是那条，
	// 所以被动收到同组应答不抵消）。保守规则：某组在某连接代次里欠过账，这一代次内这组之后的读取结果一律标归属未确认，
	// 只有连接代次变化（断开 / 重连 / 换口）才清
	function markLate(L, gid, gen) {
		const g = L.groups[gid] || (L.groups[gid] = {})
		g.late = gen
	}
	function isLate(L, gid, gen) {
		const g = L && L.groups[gid]
		return !!g && g.late != null && g.late === gen
	}
	// 标记绑定到请求实际认领的那条记录（rec id），不是该组最新的记录：同一块里认领帧之后又来同组帧时，标记仍在被认领的那条上
	function markRecUnsure(L, recId, msg) {
		if (recId == null) return
		L.unsure[recId] = String(msg || '归属未确认')
	}
	function recUnsure(L, recId) {
		return L && recId != null && L.unsure[recId] ? L.unsure[recId] : null
	}
	// 字段的读数取自被标记的记录才显示未确认
	function readingUnsure(L, key) {
		const r = L && L.readings[key]
		return r ? recUnsure(L, r.rec) : null
	}

	// 组状态：busy 读取中 / unread 未读 / ok 本次连接读到 / stale 上次连接读到 / error 本次失败（保留上次读到的时间）
	function groupView(L, gid, curGen) {
		const g = L && L.groups[gid]
		if (!g) return { state: 'unread', at: null, error: null }
		if (g.busy) return { state: 'busy', at: g.at || null, error: null, stale: !!g.at && g.gen !== curGen }
		if (g.error && g.error.gen === curGen && (!g.at || g.error.at >= g.at)) return { state: 'error', at: g.at || null, error: g.error.msg, stale: !!g.at && g.gen !== curGen }
		if (!g.at) return { state: 'unread', at: null, error: null }
		const unsure = recUnsure(L, g.rec)
		return { state: g.gen === curGen ? 'ok' : 'stale', at: g.at, gen: g.gen, error: null, stale: g.gen !== curGen, unsure: unsure }
	}

	function reading(L, key) {
		return L ? (L.readings[key] || null) : null
	}

	function isStale(r, curGen) {
		return !!r && r.gen !== curGen
	}

	function anyStale(L, curGen) {
		if (!L) return false
		return Object.keys(L.readings).some(function (k) { return L.readings[k].gen !== curGen })
	}

	// 值的读取函数（给协议的 format 用来取同一路的其它读数，例如按基准换算）
	// 给协议 format 用的取值器：只给同一路（L 本身按路分）、同一连接代次的读数，
	// 否则重连后会拿上一连接的值（如基准水量）去换算本连接的读数
	function getter(L, gen) {
		return function (key) {
			const r = L && L.readings[key]
			if (!r) return undefined
			if (gen !== undefined && r.gen !== gen) return undefined
			return r.raw
		}
	}

	function groupHasFields(dev, gid) {
		return !!(dev && dev.fields && dev.fields.some(function (f) { return f.group === gid }))
	}

	// 有没有「读取」：协议同时给了组帧与应答认领才算可查询，否则这个面板只被动更新
	function queryable(dev) {
		return !!(dev && typeof dev.buildRequest === 'function' && typeof dev.matchReply === 'function')
	}

	function trimNum(n, decimals) {
		if (!Number.isFinite(n)) return String(n)
		if (decimals != null) return n.toFixed(decimals)
		return String(Number(n.toPrecision(12)))
	}

	function parseTime(raw) {
		if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN
		if (typeof raw !== 'string') return NaN
		const m = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})/.exec(raw.trim())
		if (!m) return NaN
		const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
		const t = d.getTime()
		// 防止 13 月 / 32 日被 Date 进位成别的日期
		if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return NaN
		return t
	}

	function bitsList(field, raw) {
		const names = (field && field.bits) || []
		const v = Number(raw)
		const out = []
		names.forEach(function (nm, i) {
			if (!nm) return
			out.push({ name: nm, on: Number.isFinite(v) && Math.floor(v / Math.pow(2, i)) % 2 === 1 })
		})
		return out
	}

	function flagState(raw) {
		if (Array.isArray(raw)) return { on: !!raw[0] && raw[0] !== '0', note: raw.length > 1 && raw[1] != null ? String(raw[1]) : '' }
		if (typeof raw === 'number') return { on: raw !== 0, note: '' }
		if (typeof raw === 'string') return { on: raw !== '' && raw !== '0', note: '' }
		return { on: !!raw, note: '' }
	}

	// 默认显示：按 field.kind；协议给了 format 且返回非 null 时用协议的
	function formatValue(dev, key, raw, get) {
		if (raw === undefined) return '—'
		if (dev && typeof dev.format === 'function') {
			const s = dev.format(key, raw, get || function () { return undefined })
			if (s != null) return String(s)
		}
		const f = dev && dev.fieldMap ? dev.fieldMap[key] : null
		if (!f) return raw == null ? '—' : String(raw)
		if (raw === null) return '—'
		const unit = f.unit ? ' ' + f.unit : ''
		switch (f.kind) {
			case 'number': {
				if (f.options && f.options[String(raw)] != null) return f.options[String(raw)]
				const n = Number(raw)
				if (!Number.isFinite(n)) return String(raw)
				return trimNum(n * (f.scale || 1), f.decimals) + unit
			}
			case 'enum':
				if (f.options && f.options[String(raw)] != null) return f.options[String(raw)]
				return '未知(' + String(raw) + ')'
			case 'bits': {
				const list = bitsList(f, raw)
				const on = list.filter(function (b) { return b.on }).map(function (b) { return b.name })
				if (!list.length) return String(raw)
				if (on.length === list.length) return '全部开启'
				return on.length ? '已开 ' + on.length + '/' + list.length + '：' + on.join('、') : '全部关闭'
			}
			case 'time': {
				const t = parseTime(raw)
				return Number.isFinite(t) ? fmtDateTime(t) : String(raw)
			}
			case 'hex': {
				if (typeof raw === 'number') {
					const digits = f.digits || 2
					let s = (raw >>> 0).toString(16).toUpperCase()
					while (s.length < digits) s = '0' + s
					return '0x' + s
				}
				return String(raw)
			}
			case 'flag': {
				const st = flagState(raw)
				return (st.on ? '有' : '无') + (st.note ? ' · ' + st.note : '')
			}
			default:
				if (Array.isArray(raw)) return raw.join(' ')
				if (raw === '') return '(空)'
				return String(raw) + (typeof raw === 'number' ? unit : '')
		}
	}

	// 设备时间：读取那一刻的值与电脑的偏差（电脑时间取收到该帧的时刻）
	function deviceTimeInfo(r) {
		if (!r) return null
		const t = parseTime(r.raw)
		if (!Number.isFinite(t)) return null
		return { deviceMs: t, readAt: r.at, driftSec: Math.round((t - r.at) / 1000) }
	}

	// 按读取时的偏差推算设备现在的时间（估算，不是设备上报）
	function estimateDeviceNow(info, now) {
		if (!info) return NaN
		return now + (info.deviceMs - info.readAt)
	}

	// 日历位图：bit(firstBit + day - 1) 对应 day 日；当月今天之后的格子是「未到」
	function dayCells(widget, raw, today) {
		const days = widget.days || 31
		const first = widget.firstBit == null ? 1 : widget.firstBit
		const v = Number(raw)
		const out = []
		for (let d = 1; d <= days; d++) {
			if (today != null && d > today) { out.push({ day: d, state: 'future' }); continue }
			const set = Number.isFinite(v) && Math.floor(v / Math.pow(2, first + d - 1)) % 2 === 1
			const good = widget.setMeans === 'bad' ? !set : set
			out.push({ day: d, state: good ? 'ok' : 'bad' })
		}
		return out
	}

	// 来源帧里要高亮的字节：协议 byteMap 的分组里属于该字段的那些（由协议的 byteGroups 给出，对不上就不高亮，不猜偏移）
	function highlightIndices(byteMap, groups) {
		const out = []
		if (!Array.isArray(byteMap) || !groups || !groups.length) return out
		const set = new Set(groups)
		for (let i = 0; i < byteMap.length; i++) {
			const c = byteMap[i]
			if (c && typeof c === 'object' && c.grp != null && set.has(String(c.grp))) out.push(i)
		}
		return out
	}

	// 参数页：字段是否有对应查询（没有就是「读不到」）
	function readable(dev, key) {
		const f = dev && dev.fieldMap ? dev.fieldMap[key] : null
		return !!(f && f.group && queryable(dev))
	}

	function groupTitle(dev, gid) {
		const g = dev && dev.groups ? dev.groups.find(function (x) { return x.id === gid }) : null
		return g ? g.title : gid
	}

	function searchFields(dev, q) {
		const s = String(q || '').trim().toLowerCase()
		if (!s || !dev) return []
		const keys = []
		dev.categories.forEach(function (c) { c.keys.forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k) }) })
		return keys.filter(function (k) {
			const f = dev.fieldMap[k]
			return (f.name + ' ' + (f.addr || '') + ' ' + k).toLowerCase().indexOf(s) >= 0
		})
	}

	// 最近一次读到状态组的时间（状态页头部「读取于」）
	function latestStatusRead(dev, L) {
		let best = null
		if (!dev || !L) return null
		dev.readSets.status.forEach(function (gid) {
			const g = L.groups[gid]
			if (g && g.at && (!best || g.at > best.at)) best = { at: g.at, gen: g.gen }
		})
		return best
	}

	const lib = {
		createStore: createStore,
		laneKey: laneKey,
		lane: lane,
		inputValue: inputValue,
		allowsEmpty: allowsEmpty,
		sameValue: sameValue,
		writeAllowed: writeAllowed,
		writeResult: writeResult,
		exportSnapshot: exportSnapshot,
		compareSnapshot: compareSnapshot,
		applySnapshot: applySnapshot,
		ingest: ingest,
		findFrame: findFrame,
		setGroupBusy: setGroupBusy,
		markLate: markLate,
		isLate: isLate,
		markRecUnsure: markRecUnsure,
		recUnsure: recUnsure,
		readingUnsure: readingUnsure,
		setGroupError: setGroupError,
		groupView: groupView,
		reading: reading,
		isStale: isStale,
		anyStale: anyStale,
		getter: getter,
		queryable: queryable,
		groupHasFields: groupHasFields,
		formatValue: formatValue,
		parseTime: parseTime,
		bitsList: bitsList,
		flagState: flagState,
		deviceTimeInfo: deviceTimeInfo,
		estimateDeviceNow: estimateDeviceNow,
		dayCells: dayCells,
		highlightIndices: highlightIndices,
		readable: readable,
		groupTitle: groupTitle,
		searchFields: searchFields,
		latestStatusRead: latestStatusRead,
		fmtDateTime: fmtDateTime,
		fmtClock: fmtClock,
		toHex: toHex,
	}
	if (typeof module !== 'undefined' && module.exports) module.exports = lib
	if (typeof window !== 'undefined') window.DeviceModel = lib
})(typeof window !== 'undefined' ? window : globalThis)
