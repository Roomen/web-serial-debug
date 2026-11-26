// 统一协议注册表：管理内置协议与外部协议（JSON / JS 插件）的注册、注销、显隐持久化、
// 平台门控、面板生命周期与外部协议 XSS 结构化隔离。
// 浏览器全局暴露 window.ProtocolRegistry / window.registerProtocol / window.unregisterProtocol，
// 同时导出给 Node 回归测试（tests/protocol-registry.cjs）。
;(function (root) {
	'use strict'

	const RESERVED_IDS = [
		'sek',
		'wmbus',
		'gz',
		'cjt188',
		'sk-ultrasonic',
		'hostproto',
		'cellular-at',
	]
	const RESERVED_SET = new Set(RESERVED_IDS)
	const HIDDEN_KEY = 'protocolHiddenIds'
	const CUSTOM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/

	function escHtml(s, parseView) {
		const pv = parseView || root.ParseView
		if (pv && typeof pv.esc === 'function') {
			return pv.esc(s)
		}
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;')
	}

	// 外部协议 logView 清洗：严禁保留 section.html，转为纯文本追加到 section.pre 并删除 html 键
	function sanitizeSection(sec) {
		if (!sec || typeof sec !== 'object') return sec
		const out = Object.assign({}, sec)
		if (out.html != null && out.html !== '') {
			const htmlText = String(out.html)
			out.pre = out.pre != null && out.pre !== '' ? String(out.pre) + '\n' + htmlText : htmlText
		}
		delete out.html
		if (Array.isArray(out.groups)) {
			out.groups = out.groups.map(function (g) {
				if (!g || typeof g !== 'object') return g
				const ng = Object.assign({}, g)
				delete ng.html
				return ng
			})
		}
		return out
	}

	function sanitizeLogViewModel(m) {
		if (!m || typeof m !== 'object') return m
		const out = Object.assign({}, m)
		delete out.html
		if (Array.isArray(out.sections)) {
			out.sections = out.sections.map(sanitizeSection)
		}
		return out
	}

	function sanitizeLogViewOutput(out) {
		if (out == null) return out
		if (Array.isArray(out)) return out.map(sanitizeLogViewModel)
		return sanitizeLogViewModel(out)
	}

	// ===== 设备面板契约（device）=====
	// 协议在 registerProtocol 时可选声明 device，宿主据此画设备面板；宿主不认识任何具体协议。
	// 这里是契约的唯一入口：只保留约定的纯数据字段与约定的函数字段，函数一律包一层（异常吞掉、输出按约定清洗），
	// 协议给出的所有文本最终由宿主 textContent 渲染。内置与外部协议走同一套清洗，外部协议额外不能带任何未约定的键。
	const DEVICE_KINDS = ['number', 'enum', 'text', 'bits', 'time', 'hex', 'flag']
	const DEVICE_WIDGETS = ['metric', 'identity', 'deviceTime', 'flags', 'dayBitmap', 'kv']
	const DEVICE_KEY_RE = /^[A-Za-z0-9_.:\-]{1,48}$/
	const DEVICE_TEXT_MAX = 256
	const DEVICE_VALUE_TEXT_MAX = 2048
	const DEVICE_MAX_FIELDS = 512
	const DEVICE_MAX_GROUPS = 64
	const DEVICE_MAX_WIDGETS = 32

	const DEVICE_MAX_CATEGORIES = 32
	const DEVICE_MAX_LIST = 128 // 部件 / 分类里的 key 列表、readSets 每项
	const DEVICE_MAX_OPTIONS = 256
	const DEVICE_MAX_BITS = 64
	const DEVICE_MAX_NODES = 20000 // device 声明里纯数据的总节点数（对象、数组、标量都算）
	const DEVICE_MAX_TEXT = 512 * 1024 // 声明里全部字符串的总长度
	const DEVICE_MAX_REQUEST = 4096 // 单个请求帧最大字节数
	const DEVICE_MAX_EXTRACT = 512 // 单帧 extract 结果最多几项
	const DEVICE_MAX_RAW_ITEMS = 64 // 一个读数数组最多几项
	// 这几个名字在普通对象上是原型链上的特殊键，作 key 会改写或读到原型，一律拒绝
	const DEVICE_BAD_KEYS = ['__proto__', 'constructor', 'prototype']

	function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k) }

	// 只收字符串 / 有限数字 / 布尔，别的类型不调用 toString（对象的 toString 可以是任意代码）
	function devText(v, max) {
		if (v == null) return ''
		const t = typeof v
		let s
		if (t === 'string') s = v
		else if ((t === 'number' && Number.isFinite(v)) || t === 'boolean') s = String(v)
		else return ''
		const lim = max || DEVICE_TEXT_MAX
		return s.length > lim ? s.slice(0, lim) : s
	}

	function devKey(v) {
		if (typeof v !== 'string') return ''
		const s = v.trim()
		if (DEVICE_BAD_KEYS.indexOf(s) >= 0) return ''
		return DEVICE_KEY_RE.test(s) ? s : ''
	}

	function devNum(v, min, max, dflt) {
		const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
		if (!Number.isFinite(n)) return dflt
		if (min != null && n < min) return dflt
		if (max != null && n > max) return dflt
		return n
	}

	function isPlainObject(v) {
		if (!v || typeof v !== 'object' || Array.isArray(v)) return false
		// 只认普通对象（允许来自别的 realm，如 iframe / vm 里构造的字面量）
		if (Object.prototype.toString.call(v) !== '[object Object]') return false
		const proto = Object.getPrototypeOf(v)
		return proto === null || Object.getPrototypeOf(proto) === null
	}

	// 复制前先量总规模：节点数、字符串总长、深度、循环引用。超限整体拒绝并说明原因，不裁剪（裁剪会留下指向被裁掉部分的引用）。
	// 循环只看当前递归路径上的祖先：同一个对象被两处引用（如两个字段共用一张枚举表）是合法的，按实际复制次数各计一次预算
	function deviceBudget(dev) {
		let nodes = 0
		let text = 0
		const path = typeof Set !== 'undefined' ? new Set() : null
		function walk(v, depth) {
			if (++nodes > DEVICE_MAX_NODES) return '声明过大（数据节点超过 ' + DEVICE_MAX_NODES + '）'
			if (v == null) return null
			const t = typeof v
			if (t === 'string') {
				text += v.length
				return text > DEVICE_MAX_TEXT ? '声明里的文本总长超过 ' + DEVICE_MAX_TEXT + ' 字符' : null
			}
			if (t !== 'object') return null
			if (depth > 8) return '声明嵌套过深（超过 8 层）'
			if (path) {
				if (path.has(v)) return '声明里有循环引用'
				path.add(v)
			}
			const e = walkChildren(v, depth)
			if (path) path.delete(v)
			return e
		}
		function walkChildren(v, depth) {
			if (Array.isArray(v) || (typeof Uint8Array !== 'undefined' && v instanceof Uint8Array)) {
				if (v.length > DEVICE_MAX_NODES) return '声明里的数组过长'
				for (let i = 0; i < v.length; i++) { const e = walk(v[i], depth + 1); if (e) return e }
				return null
			}
			if (!isPlainObject(v)) return null
			const keys = Object.keys(v)
			if (keys.length > DEVICE_MAX_NODES) return '声明里的对象键过多'
			for (let i = 0; i < keys.length; i++) {
				const k = keys[i]
				if (typeof v[k] === 'function') continue
				text += k.length
				const e = walk(v[k], depth + 1)
				if (e) return e
			}
			return null
		}
		return walk(dev, 0)
	}

	// 纯数据深拷贝：只留 JSON 可表示的标量 / 数组 / 普通对象（无原型），丢掉函数与特殊键。规模已由 deviceBudget 限住
	function devPlain(v, depth) {
		const d = depth || 0
		if (v == null) return null
		const t = typeof v
		if (t === 'string') return devText(v, DEVICE_VALUE_TEXT_MAX)
		if (t === 'number') return Number.isFinite(v) ? v : null
		if (t === 'boolean') return v
		if (d >= 8) return null
		if (Array.isArray(v) || (typeof Uint8Array !== 'undefined' && v instanceof Uint8Array)) {
			const out = []
			for (let i = 0; i < v.length; i++) out.push(devPlain(v[i], d + 1))
			return out
		}
		if (isPlainObject(v)) {
			const out = Object.create(null)
			Object.keys(v).forEach(function (k) {
				if (DEVICE_BAD_KEYS.indexOf(k) >= 0 || typeof v[k] === 'function') return
				out[k] = devPlain(v[k], d + 1)
			})
			return out
		}
		return null
	}

	// 读数原值：标量，或一层标量数组（如「告警标志 + 说明」）。别的形状（对象、嵌套数组、超长文本）整项拒绝，返回 undefined
	function devScalar(x) {
		if (x == null) return null
		const t = typeof x
		if (t === 'number') return Number.isFinite(x) ? x : undefined
		if (t === 'boolean') return x
		if (t === 'string') return x.length > DEVICE_VALUE_TEXT_MAX ? undefined : x
		return undefined
	}
	function devRawValue(v) {
		if (Array.isArray(v)) {
			if (v.length > DEVICE_MAX_RAW_ITEMS) return undefined
			const out = []
			for (let i = 0; i < v.length; i++) {
				const x = devScalar(v[i])
				if (x === undefined) return undefined
				out.push(x)
			}
			return out
		}
		return devScalar(v)
	}

	// key 列表：只收已声明的字段；列表过长由 normalizeDevice 先行拒绝
	function devKeyList(list, fieldMap) {
		const out = []
		if (!Array.isArray(list)) return out
		for (let i = 0; i < list.length; i++) {
			const k = devKey(list[i])
			if (k && hasOwn(fieldMap, k) && out.indexOf(k) < 0) out.push(k)
		}
		return out
	}

	function normalizeDeviceField(f, errors) {
		if (!isPlainObject(f)) return null
		const key = devKey(f.key)
		if (!key) {
			errors.push('字段 key 非法：' + devText(f.key, 48))
			return null
		}
		const kind = DEVICE_KINDS.indexOf(f.kind) >= 0 ? f.kind : 'text'
		const out = {
			key: key,
			name: devText(f.name, 64) || key,
			kind: kind,
			unit: devText(f.unit, 16),
			scale: devNum(f.scale, null, null, 1) || 1,
			decimals: devNum(f.decimals, 0, 10, null),
			digits: devNum(f.digits, 1, 16, null),
			group: devKey(f.group) || null,
			copy: f.copy === true,
			note: devText(f.note, 200),
			addr: devText(f.addr, 32),
			options: null,
			bits: null,
			secret: f.secret === true,
			write: null,
		}
		if (isPlainObject(f.options)) {
			const ks = Object.keys(f.options)
			if (ks.length > DEVICE_MAX_OPTIONS) {
				errors.push('字段 ' + key + ' 的 options 超过 ' + DEVICE_MAX_OPTIONS + ' 项')
				return null
			}
			const opts = Object.create(null)
			ks.forEach(function (k) {
				if (DEVICE_BAD_KEYS.indexOf(k) >= 0) return
				opts[devText(k, 32)] = devText(f.options[k], 64)
			})
			out.options = opts
		}
		if (Array.isArray(f.bits)) {
			if (f.bits.length > DEVICE_MAX_BITS) {
				errors.push('字段 ' + key + ' 的 bits 超过 ' + DEVICE_MAX_BITS + ' 项')
				return null
			}
			out.bits = f.bits.map(function (b) { return devText(b, 32) })
		}
		if (isPlainObject(f.write)) {
			const w = f.write
			const options = isPlainObject(w.options) ? Object.create(null) : null
			if (options) {
				const keys = Object.keys(w.options)
				if (keys.length > DEVICE_MAX_OPTIONS) { errors.push('写入选项过多：' + key); return null }
				keys.forEach(function (name) {
					if (devKey(name)) options[name] = devText(w.options[name], 64)
				})
			}
			const pattern = devText(w.pattern, 200)
			try { if (pattern) new RegExp('^(?:' + pattern + ')$') } catch (e) { errors.push('写入校验表达式无效：' + key); return null }
			out.write = {
				min: devNum(w.min, null, null, null),
				max: devNum(w.max, null, null, null),
				step: devNum(w.step, 0, null, null),
				maxLen: devNum(w.maxLen, 0, 4096, null),
				pattern: pattern,
				hint: devText(w.hint, 200),
				options: options,
				confirm: devText(w.confirm, 300),
			}
			if ((out.write.min != null && out.write.max != null && out.write.min > out.write.max) || out.write.step === 0 || (out.write.maxLen != null && !Number.isInteger(out.write.maxLen))) {
				errors.push('写入约束无效：' + key)
				return null
			}
		}
		return out
	}

	function normalizeDeviceWidget(w, fieldMap, groupIds, errors) {
		if (!isPlainObject(w) || DEVICE_WIDGETS.indexOf(w.type) < 0) return null
		const lists = [w.sub, w.keys]
		for (let i = 0; i < lists.length; i++) {
			if (Array.isArray(lists[i]) && lists[i].length > DEVICE_MAX_LIST) {
				errors.push('状态部件 ' + w.type + ' 的 key 列表超过 ' + DEVICE_MAX_LIST + ' 项')
				return null
			}
		}
		const out = { type: w.type, title: devText(w.title, 64), group: groupIds.indexOf(w.group) >= 0 ? w.group : null }
		if (w.type === 'metric' || w.type === 'deviceTime' || w.type === 'dayBitmap') {
			const key = devKey(w.key)
			if (!key || !hasOwn(fieldMap, key)) return null
			out.key = key
			out.sub = devKeyList(w.sub, fieldMap)
		}
		if (w.type === 'metric') {
			const mk = devKey(w.meter)
			out.meter = mk && hasOwn(fieldMap, mk) ? mk : null
		}
		if (w.type === 'dayBitmap') {
			out.days = devNum(w.days, 1, 31, 31)
			out.firstBit = devNum(w.firstBit, 0, 1, 1)
			out.setMeans = w.setMeans === 'bad' ? 'bad' : 'ok'
			out.setLabel = devText(w.setLabel, 16) || (out.setMeans === 'bad' ? '异常' : '正常')
			out.clearLabel = devText(w.clearLabel, 16) || (out.setMeans === 'bad' ? '正常' : '异常')
		}
		if (w.type === 'identity' || w.type === 'flags' || w.type === 'kv') {
			out.keys = devKeyList(w.keys, fieldMap)
			if (!out.keys.length) return null
		}
		if (!out.group) {
			const first = out.key || (out.keys && out.keys[0])
			out.group = first && hasOwn(fieldMap, first) ? fieldMap[first].group : null
		}
		return out
	}

	// 请求帧：先看长度再分配，超过上限或有非字节值都拒绝
	function toBytesOut(v) {
		if (v == null) return null
		if (isPlainObject(v) && v.frame != null) v = v.frame
		if (typeof Uint8Array !== 'undefined' && v instanceof Uint8Array) {
			if (v.length > DEVICE_MAX_REQUEST) throw new Error('请求帧超过 ' + DEVICE_MAX_REQUEST + ' 字节')
			return Uint8Array.from(v)
		}
		if (Array.isArray(v)) {
			if (v.length > DEVICE_MAX_REQUEST) throw new Error('请求帧超过 ' + DEVICE_MAX_REQUEST + ' 字节')
			const out = new Uint8Array(v.length)
			for (let i = 0; i < v.length; i++) {
				const n = v[i]
				if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) return null
				out[i] = n
			}
			return out
		}
		return null
	}

	// opts.errors：可选数组，收集拒绝原因。返回规范化的 device，或 null（没有 / 不合格）
	// device.log：设备面板子视图里底部「通信记录」条的初始偏好（只在用户从未调整过该协议时生效，见 js/log-layout.js），非法值丢弃
	const DEVICE_LOG_PREFS = ['collapsed', 'strip', 'tall']
	function devLogPref(v) {
		return typeof v === 'string' && DEVICE_LOG_PREFS.indexOf(v) >= 0 ? v : null
	}
	function normalizeDevice(dev, opts) {
		const label = (opts && opts.id) || ''
		const errors = (opts && Array.isArray(opts.errors)) ? opts.errors : []
		const warn = function (what, e) {
			try { console.warn('[ProtocolRegistry] device.' + what + ' 异常(' + label + '):', e) } catch (x) {}
		}
		const reject = function (msg) {
			errors.push(msg)
			warn('声明', msg)
			return null
		}
		if (!isPlainObject(dev)) return null
		const over = deviceBudget(dev)
		if (over) return reject(over)
		const arr = function (v) { return Array.isArray(v) ? v : [] }
		if (arr(dev.fields).length > DEVICE_MAX_FIELDS) return reject('fields 超过 ' + DEVICE_MAX_FIELDS + ' 项')
		if (arr(dev.groups).length > DEVICE_MAX_GROUPS) return reject('groups 超过 ' + DEVICE_MAX_GROUPS + ' 项')
		if (arr(dev.status).length > DEVICE_MAX_WIDGETS) return reject('status 超过 ' + DEVICE_MAX_WIDGETS + ' 项')
		if (arr(dev.categories).length > DEVICE_MAX_CATEGORIES) return reject('categories 超过 ' + DEVICE_MAX_CATEGORIES + ' 项')
		for (const c of arr(dev.categories)) {
			if (c && Array.isArray(c.keys) && c.keys.length > DEVICE_MAX_LIST) return reject('分类的 keys 超过 ' + DEVICE_MAX_LIST + ' 项')
		}
		const rsIn = isPlainObject(dev.readSets) ? dev.readSets : {}
		if (arr(rsIn.status).length > DEVICE_MAX_LIST || arr(rsIn.all).length > DEVICE_MAX_LIST) return reject('readSets 过长')
		const fields = []
		const fieldMap = Object.create(null)
		const ferr = []
		arr(dev.fields).forEach(function (f) {
			const nf = normalizeDeviceField(f, ferr)
			if (nf && !hasOwn(fieldMap, nf.key)) {
				fieldMap[nf.key] = nf
				fields.push(nf)
			}
		})
		if (ferr.length) return reject(ferr.join('；'))
		const groups = []
		const groupIds = []
		arr(dev.groups).forEach(function (g) {
			if (!isPlainObject(g)) return
			const id = devKey(g.id)
			if (!id || groupIds.indexOf(id) >= 0) return
			groupIds.push(id)
			groups.push({ id: id, title: devText(g.title, 64) || id, request: devPlain(g.request), reply: devPlain(g.reply) })
		})
		if (!fields.length || (!groups.length && !(typeof dev.buildWrite === 'function' && typeof dev.matchWriteReply === 'function' && fields.some(function (f) { return f.write && !f.group })))) return null
		fields.forEach(function (f) { if (f.group && groupIds.indexOf(f.group) < 0) { f.group = null; f.write = null } })
		const readSets = { status: [], all: [] }
		;['status', 'all'].forEach(function (k) {
			arr(rsIn[k]).forEach(function (id) { if (typeof id === 'string' && groupIds.indexOf(id) >= 0 && readSets[k].indexOf(id) < 0) readSets[k].push(id) })
		})
		if (!readSets.all.length) readSets.all = groupIds.slice()
		if (!readSets.status.length) readSets.status = readSets.all.slice()
		const status = []
		const werr = []
		arr(dev.status).forEach(function (w) {
			const nw = normalizeDeviceWidget(w, fieldMap, groupIds, werr)
			if (nw) status.push(nw)
		})
		if (werr.length) return reject(werr.join('；'))
		const categories = []
		arr(dev.categories).forEach(function (c) {
			if (!isPlainObject(c)) return
			const id = devKey(c.id)
			const keys = devKeyList(c.keys, fieldMap)
			if (!id || !keys.length) return
			categories.push({ id: id, title: devText(c.title, 32) || id, keys: keys })
		})
		const nameKey = devKey(dev.nameKey)
		const fn = function (name) { return typeof dev[name] === 'function' ? dev[name] : null }
		const rawBuild = fn('buildRequest')
		const rawMatch = fn('matchReply')
		const rawExtract = fn('extract')
		const rawFormat = fn('format')
		const rawByteGroups = fn('byteGroups')
		const rawWrite = fn('buildWrite')
		const rawWriteMatch = fn('matchWriteReply')
		const rawInput = fn('parseInput')
		// 没有 extract 面板什么也取不到（被动更新与读取认领都靠它），整份声明拒绝并说明，不当成可用面板
		if (!rawExtract) return reject('缺少 extract：面板靠它从帧里取值，读取也要靠它确认应答里确实有该组字段')
		// 可查询 = 能组请求帧且能认领应答；缺一项这个面板只被动更新（不出现读取按键，组不发查询）
		const canQuery = !!(rawBuild && rawMatch)
		fields.forEach(function (field) { if (!rawWrite || !rawWriteMatch || (field.group && !canQuery)) field.write = null })
		const out = {
			title: devText(dev.title, 64),
			nameKey: nameKey && hasOwn(fieldMap, nameKey) ? nameKey : null,
			timeoutMs: devNum(dev.timeoutMs, 200, 60000, 5000),
			log: devLogPref(dev.log),
			queryable: canQuery,
			fields: fields,
			fieldMap: fieldMap,
			groups: groups,
			readSets: readSets,
			status: status,
			categories: categories,
			buildWrite: rawWrite && rawWriteMatch ? function (field, value, ctx) {
				if (!field || fieldMap[field.key] !== field || !field.write) throw new Error('字段不可写')
				const bytes = rawWrite.call(dev, field, value, ctx || {})
				if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== '[object Uint8Array]' || !bytes.length) throw new Error('协议没有构造出写入帧')
				if (bytes.length > DEVICE_MAX_REQUEST) throw new Error('写入帧超过 ' + DEVICE_MAX_REQUEST + ' 字节')
				return new Uint8Array(bytes)
			} : null,
			matchWriteReply: rawWrite && rawWriteMatch ? function (field, parsed, frame) {
				try {
					const result = rawWriteMatch.call(dev, field, parsed, frame)
					return ['ok', 'rejected', 'processing'].indexOf(result) >= 0 ? result : null
				} catch (e) { warn('matchWriteReply', e); return null }
			} : null,
			parseInput: rawInput ? function (field, text) {
				try {
					const value = rawInput.call(dev, field, text)
					return value === undefined ? undefined : devRawValue(value)
				}
				catch (e) { warn('parseInput', field && field.secret ? '保密字段输入转换失败' : e); return undefined }
			} : null,
			// 组请求帧：返回 Uint8Array，失败抛错（由请求层如实报告）
			buildRequest: canQuery ? function (group, ctx) {
				const r = rawBuild.call(dev, group, ctx || {})
				const bytes = toBytesOut(r)
				if (!bytes || !bytes.length) throw new Error('协议没有为「' + group.title + '」构造出请求帧')
				return bytes
			} : null,
			matchReply: canQuery ? function (group, parsed, frame) {
				try { return rawMatch.call(dev, group, parsed, frame) === true } catch (e) { warn('matchReply', e); return false }
			} : null,
			// 取值：只收 fields 里声明过的 key（自有键），原值只能是标量或一层标量数组，结果项数有上限
			extract: rawExtract ? function (parsed, frame) {
				let r = null
				try { r = rawExtract.call(dev, parsed, frame) } catch (e) { warn('extract', e); return null }
				if (!r || typeof r !== 'object' || Array.isArray(r)) return null
				const ks = Object.keys(r)
				if (ks.length > DEVICE_MAX_EXTRACT) { warn('extract', '结果超过 ' + DEVICE_MAX_EXTRACT + ' 项，整帧丢弃'); return null }
				const vals = Object.create(null)
				let n = 0
				ks.forEach(function (k) {
					if (!hasOwn(fieldMap, k)) return
					const v = devRawValue(r[k])
					if (v === undefined) return
					vals[k] = v
					n++
				})
				return n ? vals : null
			} : null,
			format: rawFormat ? function (key, raw, get) {
				try {
					const s = rawFormat.call(dev, key, raw, get)
					return typeof s === 'string' ? devText(s, DEVICE_VALUE_TEXT_MAX) : null
				} catch (e) { warn('format', e); return null }
			} : null,
			byteGroups: rawByteGroups ? function (parsed, key) {
				try {
					const r = rawByteGroups.call(dev, parsed, key)
					if (!Array.isArray(r) || r.length > 64) return []
					return r.filter(function (g) { return typeof g === 'string' && g !== '' && g.length <= 128 })
				} catch (e) { warn('byteGroups', e); return [] }
			} : null,
		}
		return out
	}

	function normalizeFirmware(firmware, device) {
		if (!isPlainObject(firmware) || !hasOwn(firmware, 'method') || firmware.method !== 'pcp') return null
		const normalized = { method: 'pcp' }
		const key = hasOwn(firmware, 'versionKey') ? devKey(firmware.versionKey) : ''
		if (key && device && hasOwn(device.fieldMap, key)) normalized.versionKey = key
		return normalized
	}

	function wrapExternalProtocol(norm, env) {
		const origLogView = typeof norm.logView === 'function' ? norm.logView : null
		const origFormatFrame = typeof norm.formatFrame === 'function' ? norm.formatFrame : null
		const getParseView = function () { return (env && env.ParseView) || root.ParseView }

		const safeLogView = origLogView
			? function (r) {
				return sanitizeLogViewOutput(origLogView(r))
			}
			: null

		const safeFormatFrame = function (r) {
			const pv = getParseView()
			if (origFormatFrame) {
				const raw = origFormatFrame(r)
				if (raw == null || raw === '') return ''
				return '<pre class="pv-pre">' + escHtml(String(raw), pv) + '</pre>'
			}
			if (safeLogView) {
				const model = safeLogView(r)
				const hasModel = Array.isArray(model) ? model.length > 0 : !!(model && typeof model === 'object')
				if (hasModel && pv && typeof pv.render === 'function') {
					return pv.render(model)
				}
				const errs = r && Array.isArray(r.errors) && r.errors.length ? r.errors.join('；') : '未识别的协议帧'
				return '<div class="pv-err">' + escHtml(errs, pv) + '</div>'
			}
			if (r == null) return ''
			try {
				return '<pre class="pv-pre">' + escHtml(JSON.stringify(r, null, 2), pv) + '</pre>'
			} catch (e) {
				return '<pre class="pv-pre">' + escHtml(String(r), pv) + '</pre>'
			}
		}

		return Object.assign({}, norm, {
			logView: safeLogView,
			formatFrame: safeFormatFrame,
		})
	}

	function createRegistry(env) {
		env = env || {}
		const win = env.window || root
		const doc = env.document !== undefined ? env.document : (typeof document !== 'undefined' ? document : null)
		let storage = null
		if (env.localStorage !== undefined) {
			storage = env.localStorage
		} else if (typeof window !== 'undefined') {
			try { storage = window.localStorage || null } catch (e) { storage = null }
		}
		const getPlatform = function () { return env.AppPlatform !== undefined ? env.AppPlatform : win.AppPlatform }

		const entries = new Map()
		const regOrder = []
		const hiddenSet = new Set()
		const changeListeners = new Set()
		let mountedId = null
		let mountedMode = 'none' // 'none' | 'custom' | 'generic'
		let host = null
		let batchDepth = 0
		let batchChanges = []
		let batchRegisteredIds = new Set()
		let batchUnregisteredIds = new Set()

		if (!win._protocols || typeof win._protocols !== 'object') {
			win._protocols = {}
		}

		function loadHidden() {
			hiddenSet.clear()
			if (!storage) return
			try {
				const raw = storage.getItem(HIDDEN_KEY)
				if (!raw) return
				const parsed = JSON.parse(raw)
				if (Array.isArray(parsed)) {
					parsed.forEach(function (id) {
						if (typeof id === 'string' && id.trim()) hiddenSet.add(id.trim())
					})
				}
			} catch (e) {}
		}

		function saveHidden() {
			if (!storage) return
			try {
				const arr = Array.from(hiddenSet)
				if (arr.length) storage.setItem(HIDDEN_KEY, JSON.stringify(arr))
				else storage.removeItem(HIDDEN_KEY)
			} catch (e) {}
		}

		loadHidden()

		function allowsProtocol(id) {
			const P = getPlatform()
			return !P || typeof P.allowsProtocol !== 'function' || !!P.allowsProtocol(id)
		}

		// 规范排序：sek 第一 → 其余内置按注册序 → 自定义按注册序
		function orderedIds() {
			const builtins = []
			const customs = []
			let hasSek = false
			for (let i = 0; i < regOrder.length; i++) {
				const id = regOrder[i]
				const entry = entries.get(id)
				if (!entry) continue
				if (id === 'sek') {
					hasSek = true
				} else if (entry.builtin) {
					builtins.push(id)
				} else {
					customs.push(id)
				}
			}
			return (hasSek ? ['sek'] : []).concat(builtins, customs)
		}

		function isSelectable(id) {
			return entries.has(id) && !hiddenSet.has(id)
		}

		function fallbackProtocolId() {
			if (isSelectable('sek')) return 'sek'
			const ids = orderedIds()
			for (let i = 0; i < ids.length; i++) {
				if (isSelectable(ids[i])) return ids[i]
			}
			return ids.length ? ids[0] : 'sek'
		}

		function ensureAtLeastOneVisible() {
			const ids = orderedIds()
			if (!ids.length) return false
			for (let i = 0; i < ids.length; i++) {
				if (!hiddenSet.has(ids[i])) return false
			}
			const keep = entries.has('sek') ? 'sek' : ids[0]
			hiddenSet.delete(keep)
			saveHidden()
			return true
		}

		function notifyChange(detail) {
			if (batchDepth > 0) {
				batchChanges.push(detail)
				return
			}
			changeListeners.forEach(function (fn) {
				try { fn(detail) } catch (e) { console.warn('[ProtocolRegistry] onChange 回调异常:', e) }
			})
			if (!doc || typeof doc.dispatchEvent !== 'function') return
			try {
				const Ctor = win.CustomEvent || (typeof CustomEvent !== 'undefined' ? CustomEvent : null)
				if (Ctor) doc.dispatchEvent(new Ctor('serial-protocol-registry-change', { detail: detail }))
			} catch (e) {}
		}

		function batch(fn) {
			if (typeof fn !== 'function') return undefined
			batchDepth++
			let result
			try {
				result = fn()
			} finally {
				batchDepth--
				if (batchDepth === 0) {
					const changes = batchChanges
					const regIds = Array.from(batchRegisteredIds)
					const unregIds = Array.from(batchUnregisteredIds)
					batchChanges = []
					batchRegisteredIds = new Set()
					batchUnregisteredIds = new Set()
					let hiddenChanged = false
					for (let i = 0; i < unregIds.length; i++) {
						const uid = unregIds[i]
						if (!entries.has(uid) && hiddenSet.delete(uid)) {
							hiddenChanged = true
						}
					}
					if (hiddenChanged) saveHidden()
					ensureAtLeastOneVisible()
					syncSelect()
					if (host && typeof host.onReconcile === 'function') {
						try { host.onReconcile() } catch (e) {}
					}
					if (host && typeof host.onRegistered === 'function') {
						for (let i = 0; i < regIds.length; i++) {
							const rid = regIds[i]
							const entry = entries.get(rid)
							if (entry) {
								try { host.onRegistered(rid, entry) } catch (e) {}
							}
						}
					}
					if (win._activeProtocol && isSelectable(win._activeProtocol)) {
						activatePanel(win._activeProtocol)
					}
					if (changes.length) {
						notifyChange({ action: 'batch', changes: changes })
					}
				}
			}
			return result
		}

		function syncSelect() {
			if (!doc || typeof doc.getElementById !== 'function') return
			const sel = doc.getElementById('serial-protocol-select')
			if (!sel) return
			const prev = sel.value
			const ids = orderedIds()
			const desired = []
			for (let i = 0; i < ids.length; i++) {
				const id = ids[i]
				if (!isSelectable(id)) continue
				const item = entries.get(id)
				desired.push([id, item ? item.name : id])
			}
			const current = Array.prototype.map.call(sel.options || [], function (o) {
				return [o.value, o.textContent]
			})
			let same = desired.length === current.length
			if (same) {
				for (let i = 0; i < desired.length; i++) {
					if (desired[i][0] !== current[i][0] || desired[i][1] !== current[i][1]) {
						same = false
						break
					}
				}
			}
			if (!same) {
				sel.textContent = ''
				desired.forEach(function (pair) {
					const opt = doc.createElement('option')
					opt.value = pair[0]
					opt.textContent = pair[1]
					sel.appendChild(opt)
				})
			}
			const active = win._activeProtocol
			if (active && isSelectable(active)) {
				if (sel.value !== active) sel.value = active
			} else if (prev && isSelectable(prev)) {
				if (sel.value !== prev) sel.value = prev
			} else if (desired.length) {
				sel.value = desired[0][0]
			}
		}

		function unmountCurrent(ctx) {
			if (!mountedId) return
			const prevEntry = entries.get(mountedId)
			const prevMode = mountedMode
			mountedId = null
			mountedMode = 'none'
			if (prevMode === 'custom') {
				if (prevEntry && typeof prevEntry.unmountPanel === 'function') {
					try { prevEntry.unmountPanel(ctx || {}) } catch (e) { console.warn('[ProtocolRegistry] unmountPanel 失败:', e) }
				}
			} else if (prevMode === 'generic') {
				if (host && typeof host.unmountGenericPanel === 'function') {
					try { host.unmountGenericPanel(ctx || {}) } catch (e) { console.warn('[ProtocolRegistry] unmountGenericPanel 失败:', e) }
				}
			}
		}

		function activatePanel(id, ctx) {
			const nextId = id || win._activeProtocol || fallbackProtocolId()
			const entry = entries.get(nextId)
			if (!entry) return false
			const force = !!(ctx && ctx.force)
			if (mountedId === nextId && !force) {
				if (mountedMode === 'generic' && host && typeof host.mountGenericPanel === 'function') {
					try { host.mountGenericPanel(entry, ctx || {}) } catch (e) { console.warn('[ProtocolRegistry] mountGenericPanel 失败:', e) }
				}
				return true
			}
			unmountCurrent(ctx)
			const panelCtx = Object.assign({ protocolId: nextId, protocol: entry }, ctx || {})
			if (typeof entry.mountPanel === 'function') {
				mountedId = nextId
				mountedMode = 'custom'
				try { entry.mountPanel(panelCtx) } catch (e) { console.warn('[ProtocolRegistry] mountPanel 失败:', e) }
			} else if (host && typeof host.mountGenericPanel === 'function') {
				mountedId = nextId
				mountedMode = 'generic'
				try { host.mountGenericPanel(entry, panelCtx) } catch (e) { console.warn('[ProtocolRegistry] mountGenericPanel 失败:', e) }
			}
			return true
		}

		function normalizeImpl(id, impl, isBuiltin) {
			const source = isBuiltin ? 'builtin' : (impl.source || 'js-local')
			const device = normalizeDevice(impl.device, { id: id })
			const norm = {
				id: id,
				name: String(impl.name || id),
				builtin: isBuiltin,
				source: source,
				version: impl.version != null ? String(impl.version) : '',
				description: impl.description != null ? String(impl.description) : '',
				ownerPluginId: impl.ownerPluginId || null,
				rawSpec: impl.rawSpec || null,
				findFrame: typeof impl.findFrame === 'function' ? impl.findFrame : null,
				parseFrame: typeof impl.parseFrame === 'function' ? impl.parseFrame : null,
				logView: typeof impl.logView === 'function' ? impl.logView : null,
				formatFrame: typeof impl.formatFrame === 'function' ? impl.formatFrame : null,
				byteMap: typeof impl.byteMap === 'function' ? impl.byteMap : null,
				buildDownFrame: typeof impl.buildDownFrame === 'function' ? impl.buildDownFrame : null,
				updateFrameTime: typeof impl.updateFrameTime === 'function' ? impl.updateFrameTime : null,
				presets: Array.isArray(impl.presets) ? impl.presets : [],
				funcTabs: Array.isArray(impl.funcTabs) ? impl.funcTabs : null,
				mountPanel: typeof impl.mountPanel === 'function' ? impl.mountPanel : null,
				unmountPanel: typeof impl.unmountPanel === 'function' ? impl.unmountPanel : null,
				device: device,
				firmware: normalizeFirmware(impl.firmware, device),
			}
			return isBuiltin ? norm : wrapExternalProtocol(norm, env)
		}

		function register(id, impl) {
			if (typeof id !== 'string' || !id.trim()) {
				throw new Error('协议 ID 必须是非空字符串')
			}
			id = id.trim()
			if (!impl || typeof impl !== 'object') {
				throw new Error('协议实现必须是对象')
			}
			const prev = entries.get(id)
			// 仅允许保留内置 ID 首次以 builtin: true 注册，注册后锁定不可被后续任何 register 覆盖
			const isBuiltin = RESERVED_SET.has(id) && impl.builtin === true && !prev
			if (!isBuiltin) {
				if (!CUSTOM_ID_RE.test(id)) {
					throw new Error('自定义协议 ID 格式非法（需 1-48 位小写字母/数字/_/-，且以字母或数字开头）: ' + id)
				}
				if (RESERVED_SET.has(id)) {
					throw new Error('保留的内置协议 ID 不允许被外部覆盖: ' + id)
				}
			}
			if (!allowsProtocol(id)) {
				return false
			}
			if (prev) {
				if (prev.builtin) {
					throw new Error('不允许覆盖内置协议: ' + id)
				}
				const nextSource = impl.source || 'js-local'
				const nextOwner = impl.ownerPluginId || ''
				const prevOwner = prev.ownerPluginId || ''
				if (prev.source !== nextSource || prevOwner !== nextOwner) {
					throw new Error('协议 ID "' + id + '" 已被其它来源占用（' + prev.source + '），不可覆盖')
				}
			}
			const entry = normalizeImpl(id, impl, isBuiltin)
			if (!entries.has(id)) regOrder.push(id)
			entries.set(id, entry)
			win._protocols[id] = entry
			if (batchDepth === 0) {
				ensureAtLeastOneVisible()
				syncSelect()
				if (host && typeof host.onRegistered === 'function') {
					try { host.onRegistered(id, entry) } catch (e) {}
				}
				if (win._activeProtocol === id && isSelectable(id)) {
					activatePanel(id)
				} else if (mountedId === id && !isSelectable(id)) {
					unmountCurrent()
				}
			} else {
				batchRegisteredIds.add(id)
			}
			notifyChange({ action: 'register', id: id })
			return true
		}

		function unregister(id) {
			const entry = entries.get(id)
			if (!entry) {
				return { ok: false, error: '协议未注册: ' + id }
			}
			if (entry.builtin) {
				return { ok: false, error: '内置协议不可删除，可设为隐藏' }
			}
			if (mountedId === id) {
				unmountCurrent()
			}
			entries.delete(id)
			const idx = regOrder.indexOf(id)
			if (idx >= 0) regOrder.splice(idx, 1)
			delete win._protocols[id]
			if (batchDepth === 0) {
				if (hiddenSet.delete(id)) saveHidden()
				ensureAtLeastOneVisible()
				syncSelect()
				if (host && typeof host.onUnavailable === 'function') {
					try { host.onUnavailable(id) } catch (e) {}
				}
			} else {
				batchUnregisteredIds.add(id)
			}
			notifyChange({ action: 'unregister', id: id })
			return { ok: true }
		}

		function setHidden(id, hidden) {
			if (!entries.has(id)) {
				return { ok: false, error: '协议未注册: ' + id }
			}
			const want = !!hidden
			if (want) {
				let otherVisible = 0
				const ids = orderedIds()
				for (let i = 0; i < ids.length; i++) {
					if (ids[i] !== id && !hiddenSet.has(ids[i])) otherVisible++
				}
				if (otherVisible === 0) {
					return { ok: false, error: '至少需要保留一个可见协议' }
				}
				if (hiddenSet.has(id)) return { ok: true }
				hiddenSet.add(id)
				saveHidden()
				if (mountedId === id) unmountCurrent()
				if (batchDepth === 0) {
					syncSelect()
					if (host && typeof host.onUnavailable === 'function') {
						try { host.onUnavailable(id) } catch (e) {}
					}
				}
				notifyChange({ action: 'visibility', id: id, hidden: true })
				return { ok: true }
			}
			if (!hiddenSet.has(id)) return { ok: true }
			hiddenSet.delete(id)
			saveHidden()
			if (batchDepth === 0) syncSelect()
			notifyChange({ action: 'visibility', id: id, hidden: false })
			return { ok: true }
		}

		function setHiddenIds(ids) {
			hiddenSet.clear()
			if (Array.isArray(ids)) {
				ids.forEach(function (id) {
					if (typeof id === 'string' && id.trim()) hiddenSet.add(id.trim())
				})
			}
			if (batchDepth === 0) {
				ensureAtLeastOneVisible()
				saveHidden()
				syncSelect()
				if (host && typeof host.onReconcile === 'function') {
					try { host.onReconcile() } catch (e) {}
				}
			} else {
				saveHidden()
			}
			notifyChange({ action: 'visibility-batch' })
		}

		function getHiddenIds() {
			return Array.from(hiddenSet)
		}

		function toListItem(entry) {
			const hidden = hiddenSet.has(entry.id)
			return {
				id: entry.id,
				name: entry.name,
				builtin: entry.builtin,
				source: entry.source,
				version: entry.version,
				description: entry.description,
				ownerPluginId: entry.ownerPluginId,
				hidden: hidden,
				selectable: !hidden,
				capabilities: {
					parse: typeof entry.parseFrame === 'function',
					downlink: typeof entry.buildDownFrame === 'function',
					presets: Array.isArray(entry.presets) && entry.presets.length > 0,
					customPanel: typeof entry.mountPanel === 'function',
					device: !!entry.device,
				},
			}
		}

		function list(opts) {
			const includeHidden = !!(opts && opts.includeHidden === true)
			const ids = orderedIds()
			const out = []
			for (let i = 0; i < ids.length; i++) {
				const entry = entries.get(ids[i])
				if (!entry) continue
				if (!includeHidden && hiddenSet.has(entry.id)) continue
				out.push(toListItem(entry))
			}
			return out
		}

		function onChange(fn) {
			if (typeof fn !== 'function') return function () {}
			changeListeners.add(fn)
			return function () { changeListeners.delete(fn) }
		}

		function reconcileActiveLanes() {
			ensureAtLeastOneVisible()
			syncSelect()
			if (host && typeof host.onReconcile === 'function') {
				try { host.onReconcile() } catch (e) {}
			}
		}

		return {
			RESERVED_IDS: RESERVED_IDS.slice(),
			HIDDEN_KEY: HIDDEN_KEY,
			register: register,
			unregister: unregister,
			get: function (id) { return entries.get(id) || null },
			has: function (id) { return entries.has(id) },
			isBuiltin: function (id) {
				const entry = entries.get(id)
				return !!(entry && entry.builtin)
			},
			isHidden: function (id) { return hiddenSet.has(id) },
			isSelectable: isSelectable,
			setHidden: setHidden,
			getHiddenIds: getHiddenIds,
			setHiddenIds: setHiddenIds,
			fallbackProtocolId: fallbackProtocolId,
			list: list,
			onChange: onChange,
			batch: batch,
			syncSelect: syncSelect,
			activatePanel: activatePanel,
			unmountCurrent: unmountCurrent,
			reconcileActiveLanes: reconcileActiveLanes,
			setHost: function (h) { host = h || null },
			getMountedId: function () { return mountedId },
			sanitizeLogViewOutput: sanitizeLogViewOutput,
			normalizeDevice: normalizeDevice,
		}
	}

	const api = createRegistry({ window: root })
	api.createRegistry = createRegistry
	api.RESERVED_IDS = RESERVED_IDS.slice()
	api.HIDDEN_KEY = HIDDEN_KEY
	api.sanitizeLogViewOutput = sanitizeLogViewOutput
	api.normalizeDevice = normalizeDevice
	api.DEVICE_KINDS = DEVICE_KINDS.slice()
	api.DEVICE_WIDGETS = DEVICE_WIDGETS.slice()

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api
	}
	if (typeof window !== 'undefined') {
		window.ProtocolRegistry = api
		window.registerProtocol = function (id, impl) { return api.register(id, impl) }
		window.unregisterProtocol = function (id) { return api.unregister(id) }
	}
})(typeof window !== 'undefined' ? window : globalThis)
