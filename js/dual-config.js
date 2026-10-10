// 双路按路配置：A / B 各自的串口参数与协议的存储迁移、双路预设的增删改与套用计划，以及预设菜单的界面。
// 纯函数在文件顶部，node 测试(tests/dual-config.cjs)直接 require；界面部分只经 common.js 暴露的 window.serialLanes 读写状态。
// 预设只存两路的参数、协议与路标签，不存端口身份：套到另一台电脑、另一组设备上也成立
;(function (root) {
	'use strict'

	const LANES = ['A', 'B']
	const DEFAULT_OPTIONS = {
		baudRate: 115200,
		dataBits: 8,
		stopBits: 1,
		parity: 'none',
		bufferSize: 1024,
		flowControl: 'none',
	}
	const PARITY = ['none', 'even', 'odd']
	const FLOW = ['none', 'hardware']
	const PARITY_ABBR = { none: 'N', even: 'E', odd: 'O' }
	const NAME_MAX = 24
	const LABEL_MAX = 8
	const PRESET_MAX = 50

	function parseJson(raw) {
		if (raw == null || raw === '') return null
		if (typeof raw !== 'string') return raw
		try { return JSON.parse(raw) } catch (e) { return null }
	}
	function isObj(v) {
		return !!v && typeof v === 'object' && !Array.isArray(v)
	}

	// 串口参数逐项校验：非法或缺失的项取 base(缺省为默认参数)，不让一项坏值连带整份作废
	function normalizeOptions(raw, base) {
		const b = Object.assign({}, DEFAULT_OPTIONS, isObj(base) ? base : {})
		const out = Object.assign({}, b)
		if (!isObj(raw)) return out
		const baud = parseInt(raw.baudRate, 10)
		if (baud > 0) out.baudRate = baud
		const db = parseInt(raw.dataBits, 10)
		if (db === 7 || db === 8) out.dataBits = db
		const sb = parseInt(raw.stopBits, 10)
		if (sb === 1 || sb === 2) out.stopBits = sb
		if (PARITY.indexOf(raw.parity) !== -1) out.parity = raw.parity
		const buf = parseInt(raw.bufferSize, 10)
		if (buf > 0 && buf <= 16777216) out.bufferSize = buf
		if (FLOW.indexOf(raw.flowControl) !== -1) out.flowControl = raw.flowControl
		return out
	}

	function sameOptions(a, b) {
		const x = normalizeOptions(a)
		const y = normalizeOptions(b)
		return Object.keys(DEFAULT_OPTIONS).every(function (k) { return x[k] === y[k] })
	}

	// 两路参数：新键 lanesRaw({A, B}) 优先；没有(或某一路缺)时用旧的双路共用键 legacyRaw 作初值，两路相同
	function migrateLaneOptions(lanesRaw, legacyRaw) {
		const lanes = parseJson(lanesRaw)
		const base = normalizeOptions(parseJson(legacyRaw))
		const out = {}
		LANES.forEach(function (sid) {
			out[sid] = isObj(lanes) && isObj(lanes[sid]) ? normalizeOptions(lanes[sid], base) : Object.assign({}, base)
		})
		return out
	}

	// 两路协议：新键没有时两路都取迁移前全局唯一的那个协议
	function migrateLaneProtocols(raw, fallbackId) {
		const v = parseJson(raw)
		const fb = typeof fallbackId === 'string' && fallbackId ? fallbackId : 'sek'
		const out = {}
		LANES.forEach(function (sid) {
			out[sid] = isObj(v) && typeof v[sid] === 'string' && v[sid] ? v[sid] : fb
		})
		return out
	}

	// 「115200 8-N-1」，与连接条参数摘要同一写法
	function paramsSummary(opts) {
		const o = normalizeOptions(opts)
		return o.baudRate + ' ' + o.dataBits + '-' + (PARITY_ABBR[o.parity] || 'N') + '-' + o.stopBits
	}

	function cleanName(name) {
		return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
	}
	function cleanLabel(label) {
		return String(label == null ? '' : label).trim().slice(0, LABEL_MAX)
	}

	function normalizeLane(raw) {
		const r = isObj(raw) ? raw : {}
		return {
			options: normalizeOptions(r.options),
			protocol: typeof r.protocol === 'string' && r.protocol ? r.protocol : 'sek',
			label: cleanLabel(r.label),
		}
	}

	// cfg: { A: { options, protocol, label }, B: {...} }
	function makePreset(name, cfg) {
		const n = cleanName(name)
		if (!n) throw new Error('预设名称不能为空')
		const c = isObj(cfg) ? cfg : {}
		return { name: n, A: normalizeLane(c.A), B: normalizeLane(c.B) }
	}

	// 存储格式 { v: 1, list: [...] }；坏项、空名、重名(保留先出现的)都丢掉
	function normalizePresets(raw) {
		const v = parseJson(raw)
		const arr = Array.isArray(v) ? v : (isObj(v) && Array.isArray(v.list) ? v.list : [])
		const out = []
		const seen = {}
		arr.forEach(function (p) {
			if (!isObj(p)) return
			const n = cleanName(p.name)
			if (!n || seen[n]) return
			seen[n] = true
			out.push({ name: n, A: normalizeLane(p.A), B: normalizeLane(p.B) })
		})
		return out.slice(0, PRESET_MAX)
	}
	function serializePresets(list) {
		return JSON.stringify({ v: 1, list: normalizePresets(list) })
	}

	function indexOfName(list, name) {
		const n = cleanName(name)
		for (let i = 0; i < list.length; i++) if (list[i].name === n) return i
		return -1
	}

	// 同名覆盖(原位置不动)，否则追加到末尾
	function upsertPreset(list, preset) {
		const next = (list || []).slice()
		const i = indexOfName(next, preset.name)
		if (i !== -1) {
			next[i] = preset
			return { list: next, replaced: true }
		}
		if (next.length >= PRESET_MAX) throw new Error('预设最多 ' + PRESET_MAX + ' 个，请先删除不用的')
		next.push(preset)
		return { list: next, replaced: false }
	}

	function renamePreset(list, from, to) {
		const i = indexOfName(list, from)
		if (i === -1) throw new Error('预设不存在')
		const n = cleanName(to)
		if (!n) throw new Error('预设名称不能为空')
		const j = indexOfName(list, n)
		if (j !== -1 && j !== i) throw new Error('已有同名预设「' + n + '」')
		const next = list.slice()
		next[i] = Object.assign({}, next[i], { name: n })
		return next
	}

	function removePreset(list, name) {
		const i = indexOfName(list, name)
		if (i === -1) return list.slice()
		const next = list.slice()
		next.splice(i, 1)
		return next
	}

	// 当前两路配置是否与预设一致(菜单里标出正在用的那个)。标签空与默认「A路」「B路」视为相同
	function presetMatches(preset, cur) {
		if (!preset || !cur) return false
		return LANES.every(function (sid) {
			const p = normalizeLane(preset[sid])
			const c = normalizeLane(cur[sid])
			const lp = p.label || sid + '路'
			const lc = c.label || sid + '路'
			return sameOptions(p.options, c.options) && p.protocol === c.protocol && lp === lc
		})
	}

	// 套用计划：协议未注册(比如预设来自更新的版本)时保留该路当前协议并记下来；参数变了的路标出来，由调用方决定是否重连
	function planApply(preset, cur, isKnownProtocol) {
		const known = typeof isKnownProtocol === 'function' ? isKnownProtocol : function () { return true }
		const out = { lanes: {}, unknownProtocols: [] }
		LANES.forEach(function (sid) {
			const p = normalizeLane(preset && preset[sid])
			const c = normalizeLane(cur && cur[sid])
			let protocol = p.protocol
			if (!known(protocol)) {
				out.unknownProtocols.push(protocol)
				protocol = c.protocol
			}
			out.lanes[sid] = {
				options: p.options,
				protocol: protocol,
				label: p.label,
				optionsChanged: !sameOptions(p.options, c.options),
				protocolChanged: protocol !== c.protocol,
			}
		})
		return out
	}

	const api = {
		LANES: LANES,
		DEFAULT_OPTIONS: DEFAULT_OPTIONS,
		NAME_MAX: NAME_MAX,
		normalizeOptions: normalizeOptions,
		sameOptions: sameOptions,
		migrateLaneOptions: migrateLaneOptions,
		migrateLaneProtocols: migrateLaneProtocols,
		paramsSummary: paramsSummary,
		makePreset: makePreset,
		normalizePresets: normalizePresets,
		serializePresets: serializePresets,
		upsertPreset: upsertPreset,
		renamePreset: renamePreset,
		removePreset: removePreset,
		presetMatches: presetMatches,
		planApply: planApply,
	}
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api
		return
	}
	root.DualConfig = api
	if (typeof document === 'undefined') return

	// ---------- 预设菜单(经典布局在双路控件区，现代布局由 js/modern-shell.js 原样搬进连接栏) ----------
	const PRESETS_KEY = 'serialDualPresets'
	function loadPresets() {
		try { return normalizePresets(localStorage.getItem(PRESETS_KEY)) } catch (e) { return [] }
	}
	function savePresets(list) {
		try {
			localStorage.setItem(PRESETS_KEY, serializePresets(list))
			return true
		} catch (e) {
			return false
		}
	}
	function lanes() { return root.serialLanes || null }
	function toast(msg, kind) {
		const l = lanes()
		if (l && typeof l.toast === 'function') l.toast(msg, kind)
	}
	function mk(tag, cls, text) {
		const n = document.createElement(tag)
		if (cls) n.className = cls
		if (text != null) n.textContent = text
		return n
	}
	function icon(name) {
		const i = mk('i', 'bi ' + name)
		i.setAttribute('aria-hidden', 'true')
		return i
	}

	function laneLine(sid, lane) {
		const l = lanes()
		const name = l ? l.protocolName(lane.protocol) : lane.protocol
		const label = lane.label && lane.label !== sid + '路' ? lane.label + ' ' : ''
		return sid + ' ' + label + paramsSummary(lane.options) + ' · ' + name
	}

	function render() {
		const box = document.getElementById('serial-dual-preset-list')
		if (!box) return
		const list = loadPresets()
		const l = lanes()
		const cur = l ? l.snapshot() : null
		box.textContent = ''
		if (!list.length) {
			box.appendChild(mk('div', 'dual-preset-empty', '还没有预设。设好两路的参数、协议与标签后，在下面起个名字保存。'))
			return
		}
		list.forEach(function (p, i) {
			const row = mk('div', 'dual-preset-row')
			row.setAttribute('role', 'listitem')
			const on = presetMatches(p, cur)
			const apply = mk('button', 'dual-preset-apply')
			apply.type = 'button'
			apply.dataset.idx = String(i)
			apply.dataset.act = 'apply'
			apply.title = '套用「' + p.name + '」' + (on ? '（当前两路配置与它一致）' : '')
			if (on) apply.setAttribute('aria-current', 'true')
			const head = mk('span', 'dual-preset-name')
			if (on) head.appendChild(icon('bi-check2'))
			head.appendChild(document.createTextNode(p.name))
			const sum = mk('span', 'dual-preset-sum')
			sum.appendChild(mk('span', 'dual-preset-lane', laneLine('A', p.A)))
			sum.appendChild(mk('span', 'dual-preset-lane', laneLine('B', p.B)))
			apply.append(head, sum)
			const ren = mk('button', 'dual-preset-act')
			ren.type = 'button'
			ren.dataset.idx = String(i)
			ren.dataset.act = 'rename'
			ren.title = '重命名'
			ren.setAttribute('aria-label', '重命名预设 ' + p.name)
			ren.appendChild(icon('bi-pencil'))
			const del = mk('button', 'dual-preset-act')
			del.type = 'button'
			del.dataset.idx = String(i)
			del.dataset.act = 'delete'
			del.title = '删除'
			del.setAttribute('aria-label', '删除预设 ' + p.name)
			del.appendChild(icon('bi-trash'))
			row.append(apply, ren, del)
			box.appendChild(row)
		})
	}

	async function onListClick(e) {
		const b = e.target.closest('button[data-act]')
		if (!b) return
		const list = loadPresets()
		const p = list[Number(b.dataset.idx)]
		if (!p) return
		const l = lanes()
		if (b.dataset.act === 'apply') {
			if (!l) return
			await l.apply(p)
			render()
			return
		}
		if (b.dataset.act === 'rename') {
			const to = window.prompt('预设新名称（最多 ' + NAME_MAX + ' 字）', p.name)
			if (to === null) return
			try {
				if (savePresets(renamePreset(list, p.name, to))) render()
				else toast('保存失败：浏览器存储不可用', 'error')
			} catch (err) {
				toast(err.message, 'error')
			}
			return
		}
		if (b.dataset.act === 'delete') {
			if (!window.confirm('删除预设「' + p.name + '」？')) return
			if (savePresets(removePreset(list, p.name))) render()
			else toast('删除失败：浏览器存储不可用', 'error')
		}
	}

	function onSave(e) {
		e.preventDefault()
		const input = document.getElementById('serial-dual-preset-name')
		const l = lanes()
		if (!input || !l) return
		let preset
		try {
			preset = makePreset(input.value, l.snapshot())
		} catch (err) {
			toast(err.message, 'error')
			input.focus()
			return
		}
		const list = loadPresets()
		if (indexOfName(list, preset.name) !== -1 && !window.confirm('已有预设「' + preset.name + '」，用当前两路配置覆盖它？')) return
		let res
		try {
			res = upsertPreset(list, preset)
		} catch (err) {
			toast(err.message, 'error')
			return
		}
		if (!savePresets(res.list)) {
			toast('保存失败：浏览器存储不可用', 'error')
			return
		}
		input.value = ''
		toast((res.replaced ? '已覆盖预设「' : '已保存预设「') + preset.name + '」')
		render()
	}

	function init() {
		const wrap = document.getElementById('serial-dual-preset')
		if (!wrap) return
		const menu = document.getElementById('serial-dual-preset-menu')
		const list = document.getElementById('serial-dual-preset-list')
		const form = document.getElementById('serial-dual-preset-form')
		// 打开时重读：另一个标签页可能改过，当前两路配置也可能变了
		wrap.addEventListener('show.bs.dropdown', render)
		if (list) list.addEventListener('click', onListClick)
		if (form) form.addEventListener('submit', onSave)
		// 菜单里有输入框，上下键留给它，别让 Bootstrap 的菜单键盘导航截走
		if (menu) {
			menu.addEventListener('keydown', function (e) {
				if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.stopPropagation()
			})
		}
		document.addEventListener('serial-lane-config', function () {
			if (menu && menu.classList.contains('show')) render()
		})
		render()
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
	else init()
})(typeof window !== 'undefined' ? window : globalThis)
