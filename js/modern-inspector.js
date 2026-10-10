// 现代布局右栏「检查器」的结构化视图：头部(方向、帧标题、协议·时间·长度·应答耗时·校验徽标)、键值表、字节视图、
// 「从请求到应答」相关行。数据来自 common.js 解析完一帧后派发的 serial-parse-frame 事件(detail: { bytes, result, byteMap, dir, note, protocol }，
// null 表示已清空)，字段用 detail.protocol(解析这一帧时那一路的协议)的 logView(r) 视图模型，没有 logView 或不识别的帧不在这里重画，改为展开下方「原始输出」
// (就是原来的协议解析面板 #serial-parse-body：HEX 输入区 + formatFrame 输出)。
// 模型里的文本一律 textContent；只有 section.html 原样插入(协议自己拼且已转义，同 js/parse-view.js 的约定)。
// 视图宿主 #wb-insp-view 由 js/workbench.js 建在检查器面板里；字段模型没有字节偏移，所以字段悬停不做字节高亮，
// 字节视图只用 byteMap 的分组：悬停某字节高亮同组字节，分组说明放 title。
// buildSummary 等纯函数导出给 node 回归测试，不碰 DOM。
;(function () {
	'use strict'
	const root = typeof window !== 'undefined' ? window : globalThis

	// ---- 纯函数 ----

	const KINDS = { ok: 1, bad: 1, warn: 1, info: 1 }
	function kindOf(k) {
		return KINDS[k] ? k : ''
	}

	/** logView 的返回(单个模型 / 数组 / null)规整成模型数组 */
	function normalizeModels(m) {
		const list = Array.isArray(m) ? m : (m ? [m] : [])
		return list.filter(function (x) { return x && typeof x === 'object' })
	}

	/** 把一个模型拍平成键值行：[{ section, group, k, v, hint, kind }]，另给 notes / errors / pre / html 块，渲染器逐块出节点 */
	function flattenModel(m) {
		const blocks = []
		const s = m.subject
		const meta = []
		if (s && s.value != null && s.value !== '') meta.push([s.label || '对象', s.value])
		;(m.meta || []).forEach(function (x) {
			if (x && x[1] != null && x[1] !== '') meta.push([x[0], x[1]])
		})
		meta.forEach(function (x) { blocks.push({ type: 'kv', k: String(x[0] == null ? '' : x[0]), v: String(x[1]), hint: '', kind: '' }) })
		;(m.notes || []).forEach(function (n) {
			if (n && n.text) blocks.push({ type: 'note', text: String(n.text), kind: kindOf(n.kind) })
		})
		function pairs(list) {
			;(list || []).forEach(function (p) {
				if (!p) return
				blocks.push({
					type: 'kv', k: String(p[0] == null ? '' : p[0]), v: String(p[1] == null ? '' : p[1]),
					hint: p[2] ? String(p[2]) : '', kind: kindOf(p[3]),
				})
			})
		}
		;(m.sections || []).forEach(function (sec) {
			if (!sec) return
			if (sec.title) blocks.push({ type: 'title', text: String(sec.title) })
			;(sec.groups || []).forEach(function (g) {
				if (!g || !g.pairs || !g.pairs.length) return
				if (g.title) blocks.push({ type: 'subtitle', text: String(g.title) })
				pairs(g.pairs)
			})
			pairs(sec.pairs)
			if (sec.pre) blocks.push({ type: 'pre', text: String(sec.pre) })
			if (sec.html) blocks.push({ type: 'html', html: String(sec.html) })
			;(sec.errors || []).forEach(function (e) { blocks.push({ type: 'err', text: String(e) }) })
		})
		;(m.errors || []).forEach(function (e) { blocks.push({ type: 'err', text: String(e) }) })
		return blocks
	}

	/** 头部摘要：标题 + 徽标 + 副信息各段(协议名、时间、长度、应答耗时)，空段不出 */
	function buildSummary(models, info) {
		const first = models[0] || null
		const parts = []
		if (info.proto) parts.push(info.proto)
		if (info.time) parts.push(info.time)
		if (info.len != null) parts.push(info.len + ' 字节')
		if (info.latency) parts.push(info.latency)
		const badges = []
		models.forEach(function (m) {
			;(m.badges || []).forEach(function (b) {
				if (b && b.text != null && b.text !== '') badges.push({ text: String(b.text), kind: kindOf(b.kind), title: b.title ? String(b.title) : '' })
			})
		})
		return { title: first && first.title ? String(first.title) : '帧', code: first && first.code ? String(first.code) : '', parts: parts, badges: badges }
	}

	/** 应答耗时文本：<1000 ms 用毫秒，否则秒 */
	function fmtLatency(ms) {
		ms = Math.max(0, Math.round(ms))
		return '应答耗时 ' + (ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s')
	}

	/** 字节数组按 cols 个一行切开 */
	function chunkBytes(bytes, cols) {
		const rows = []
		for (let i = 0; i < bytes.length; i += cols) rows.push({ off: i, bytes: Array.prototype.slice.call(bytes, i, i + cols) })
		return rows
	}

	root.ModernInspector = { normalizeModels, flattenModel, buildSummary, fmtLatency, chunkBytes }

	// ---- 界面 ----
	if (typeof document === 'undefined') return

	const RAW_OPEN_KEY = 'serial-debug-inspector-raw-open'
	let cur = null // 最近一次解析：{ bytes, result, byteMap, dir, note } 或 null
	let curFrame = null // 解析时选中的日志行信息(serialFrameActions.selected)

	function el(tag, cls, text) {
		const n = document.createElement(tag)
		if (cls) n.className = cls
		if (text != null) n.textContent = text
		return n
	}

	function hostView() {
		const wb = root.Workbench
		return wb && typeof wb.inspectorView === 'function' ? wb.inspectorView() : null
	}

	function isModern() {
		return document.documentElement.dataset.layout === 'modern'
	}

	function hex2(b) {
		return ('0' + (b & 255).toString(16).toUpperCase()).slice(-2)
	}

	function laneLabel(sid) {
		const hub = root.SerialHub
		if (!hub || hub.mode !== 'dual') return ''
		try {
			if (sid === 'A') return hub.getLabelA()
			if (sid === 'B') return hub.getLabelB()
		} catch (e) { /* 取不到就不带路名 */ }
		return ''
	}

	// ---- 同一次交互(请求→应答)的相关行 ----

	function rowTitle(row) {
		const t = row.querySelector('.pv-title')
		if (t && t.textContent.trim()) return t.textContent.trim()
		const nm = row.getAttribute('data-name')
		if (nm) return nm
		const hex = (row.getAttribute('data-hex') || '').trim()
		return hex ? hex.split(/\s+/).length + ' 字节' : '日志'
	}

	function exchangeInfo(frame) {
		const TL = root.ModernTimeline
		const row = frame && frame.row
		if (!TL || !row || !row.isConnected || !row.parentNode) return null
		const box = row.parentNode
		const rows = []
		for (let i = 0; i < box.children.length; i++) {
			if (box.children[i].classList && box.children[i].classList.contains('log-row')) rows.push(box.children[i])
		}
		const items = rows.map(function (r) {
			return { sid: r.getAttribute('data-sid') || '', dir: r.getAttribute('data-dir') || '', ts: parseInt(r.getAttribute('data-ts'), 10) || 0 }
		})
		// 单路容器里只有 S：把它也当成一路
		const lanes = box.id === 'serial-logs-dual' ? ['A', 'B'] : ['S']
		const res = TL.compute(items, { lanes: lanes })
		const idx = rows.indexOf(row)
		if (idx < 0) return null
		const ex = TL.exchange(items, res, idx, { lanes: lanes })
		if (!ex) return { latency: '', list: [] }
		let latency = ''
		if (items[idx].dir === 'rx' && res[idx].req >= 0) latency = items[idx].ts - items[res[idx].req].ts
		else if (items[idx].dir === 'tx' && ex.end > ex.start) latency = items[ex.end].ts - items[idx].ts
		const list = []
		for (let i = ex.start; i <= ex.end; i++) {
			list.push({
				dir: items[i].dir, sid: items[i].sid, name: rowTitle(rows[i]), d: items[i].ts - items[ex.start].ts,
				self: i === idx, label: laneLabel(items[i].sid),
			})
		}
		return { latency: latency === '' ? '' : fmtLatency(latency), list: list }
	}

	// ---- 渲染 ----

	function dirTag(frame, dir) {
		const d = frame ? frame.dir : dir
		if (d !== 'tx' && d !== 'rx') return { cls: 'manual', text: '手动解析' }
		const lane = frame ? laneLabel(frame.sid) : ''
		const sid = frame ? frame.sid : ''
		const base = d === 'tx' ? '↑ TX' : '↓ RX'
		const tail = lane ? (d === 'tx' ? ' · 发给 ' : ' · 来自 ') + lane : ''
		return { cls: d + (sid === 'A' || sid === 'B' ? ' lane-' + sid.toLowerCase() : ''), text: base + tail }
	}

	function emptyView() {
		const box = el('div', 'mi-empty')
		const icon = el('i', 'bi bi-search')
		icon.setAttribute('aria-hidden', 'true')
		box.append(icon, el('div', 'mi-empty-main', '点选日志行查看这一帧'), el('div', 'mi-empty-sub', '也可从剪贴板读取一段 HEX 来解析'))
		const btn = el('button', 'btn btn-sm btn-outline-secondary mi-paste', '读取剪贴板 HEX')
		btn.type = 'button'
		btn.addEventListener('click', function () {
			// 驱动原 HEX 输入区的点击处理(权限判断、读剪贴板、解析)
			const hv = document.getElementById('serial-protocol-hexview')
			if (hv) hv.click()
		})
		box.appendChild(btn)
		return box
	}

	function kvNode(b) {
		const row = el('div', 'mi-kv')
		row.title = b.k
		row.appendChild(el('span', 'mi-k', b.k))
		const v = el('span', 'mi-v' + (b.kind ? ' mi-v--' + b.kind : ''), b.v)
		row.appendChild(v)
		if (b.hint) row.appendChild(el('span', 'mi-h', b.hint))
		return row
	}

	function fieldsView(models) {
		const box = el('div', 'mi-fields')
		models.forEach(function (m, i) {
			if (models.length > 1) box.appendChild(el('div', 'mi-frame-title', '帧 ' + (i + 1) + ' / ' + models.length + ' · ' + (m.title || '帧')))
			flattenModel(m).forEach(function (b) {
				if (b.type === 'kv') box.appendChild(kvNode(b))
				else if (b.type === 'title') box.appendChild(el('div', 'mi-sec', b.text))
				else if (b.type === 'subtitle') box.appendChild(el('div', 'mi-sub-sec', b.text))
				else if (b.type === 'note') box.appendChild(el('div', 'mi-note' + (b.kind ? ' mi-note--' + b.kind : ''), b.text))
				else if (b.type === 'err') box.appendChild(el('div', 'mi-err', b.text))
				else if (b.type === 'pre') box.appendChild(el('pre', 'mi-pre', b.text))
				else if (b.type === 'html') {
					// 协议自己拼且已转义的片段，同 ParseView 的 section.html 约定
					const h = el('div', 'mi-html')
					h.innerHTML = b.html
					box.appendChild(h)
				}
			})
		})
		return box
	}

	function bytesView(bytes, bm) {
		const sec = el('section', 'mi-bytes')
		sec.appendChild(el('div', 'mi-cap', '字节视图'))
		const grid = el('div', 'mi-hex')
		grid.setAttribute('role', 'group')
		grid.setAttribute('aria-label', '帧字节，每行 16 个')
		// 分组底色交替，肉眼可见分段
		const tone = {}
		let nextTone = 0
		chunkBytes(bytes, 16).forEach(function (row) {
			const line = el('div', 'mi-hex-row')
			line.appendChild(el('span', 'mi-hex-off', ('000' + row.off.toString(16).toUpperCase()).slice(-4)))
			row.bytes.forEach(function (b, j) {
				const cell = bm && bm[row.off + j]
				const s = el('span', 'mi-byte', hex2(b))
				if (cell && cell.grp != null && cell.tip) {
					const g = String(cell.grp)
					if (!(g in tone)) tone[g] = nextTone++ % 2
					s.classList.add('has-grp', 'tone-' + tone[g])
					s.setAttribute('data-grp', g)
					s.title = String(cell.tip)
				}
				line.appendChild(s)
			})
			grid.appendChild(line)
		})
		let hot = []
		function clearHot() {
			hot.forEach(function (n) { n.classList.remove('is-hot') })
			hot = []
		}
		grid.addEventListener('mouseover', function (e) {
			const t = e.target.closest ? e.target.closest('.mi-byte[data-grp]') : null
			clearHot()
			if (!t) return
			const g = t.getAttribute('data-grp')
			grid.querySelectorAll('.mi-byte[data-grp]').forEach(function (n) {
				if (n.getAttribute('data-grp') === g) { n.classList.add('is-hot'); hot.push(n) }
			})
		})
		grid.addEventListener('mouseleave', clearHot)
		sec.appendChild(grid)
		return sec
	}

	function relatedView(info) {
		if (!info || info.list.length < 2) return null
		const sec = el('section', 'mi-rel')
		sec.appendChild(el('div', 'mi-cap', '从这条请求到应答'))
		info.list.forEach(function (x) {
			const row = el('div', 'mi-rel-row' + (x.self ? ' is-self' : ''))
			const tag = el('span', 'mi-rel-tag ' + x.dir + (x.sid === 'A' || x.sid === 'B' ? ' lane-' + x.sid.toLowerCase() : ''),
				(x.dir === 'tx' ? '↑ TX' : '↓ RX') + (x.sid === 'A' || x.sid === 'B' ? ' ' + x.sid : ''))
			if (x.label) tag.title = x.label
			row.append(tag, el('span', 'mi-rel-name', x.name), el('span', 'mi-rel-d', x.d ? (x.d < 1000 ? '+' + x.d + ' ms' : '+' + (x.d / 1000).toFixed(2) + ' s') : '0'))
			sec.appendChild(row)
		})
		return sec
	}

	function openRaw() {
		const raw = document.getElementById('wb-insp-raw')
		if (raw && !raw.open) raw.open = true
	}

	function render() {
		const view = hostView()
		if (!view || !isModern()) return
		view.textContent = ''
		if (!cur) {
			view.appendChild(emptyView())
			return
		}
		// 用解析这一帧时的协议(双路两路协议可以不同，点的是另一路的行时与顶栏不同)，没带就按顶栏
		const p = cur.protocol && root._protocols && root._protocols[cur.protocol]
			? root._protocols[cur.protocol]
			: (typeof root.getActiveProtocol === 'function' ? root.getActiveProtocol() : null)
		let models = []
		let viewErr = ''
		if (p && typeof p.logView === 'function') {
			try { models = normalizeModels(p.logView(cur.result)) } catch (e) { viewErr = String(e && e.message ? e.message : e) }
		}
		const frame = cur.dir && curFrame && curFrame.dir === cur.dir ? curFrame : null
		const info = exchangeInfo(frame)
		const TL = root.ModernTimeline
		const sum = buildSummary(models, {
			proto: p && p.name ? p.name : '',
			time: frame && frame.ts && TL ? TL.fmtClock(frame.ts) : '',
			len: cur.bytes.length,
			latency: info ? info.latency : '',
		})
		// 头部
		const head = el('header', 'mi-head')
		const tag = dirTag(frame, cur.dir)
		head.appendChild(el('span', 'mi-dir mi-dir--' + tag.cls, tag.text))
		const title = el('div', 'mi-title', sum.title)
		if (sum.code) title.appendChild(el('span', 'mi-code', sum.code))
		head.appendChild(title)
		const sub = el('div', 'mi-subline')
		sub.appendChild(el('span', 'mi-subtext', sum.parts.join(' · ')))
		sum.badges.forEach(function (b) {
			const bd = el('span', 'mi-badge' + (b.kind ? ' mi-badge--' + b.kind : ''), b.text)
			if (b.title) bd.title = b.title
			sub.appendChild(bd)
		})
		head.appendChild(sub)
		if (cur.note) head.appendChild(el('div', 'mi-note mi-note--info', cur.note))
		view.appendChild(head)
		// 字段
		if (models.length) {
			view.appendChild(fieldsView(models))
		} else {
			const msg = viewErr
				? '结构化视图出错：' + viewErr
				: (p && typeof p.logView === 'function' ? '当前协议没有识别出这一帧，原始解析见下方「原始输出」。' : '当前协议没有结构化视图，完整解析见下方「原始输出」。')
			view.appendChild(el('div', 'mi-fallback', msg))
			openRaw()
		}
		view.appendChild(bytesView(cur.bytes, cur.byteMap))
		const rel = relatedView(info)
		if (rel) view.appendChild(rel)
	}

	// ---- 事件 ----

	document.addEventListener('serial-parse-frame', function (e) {
		const d = e.detail
		if (!d || !d.bytes || !d.bytes.length) {
			cur = null
			curFrame = null
		} else {
			cur = d
			const api = root.serialFrameActions
			curFrame = api ? api.selected() : null
		}
		render()
	})
	// 切到现代布局后补画一次(宿主是现代布局才建的)；原始输出展开状态按用户偏好
	document.addEventListener('serial-layout-move', function () {
		render()
		bindRaw()
	})

	function bindRaw() {
		const raw = document.getElementById('wb-insp-raw')
		if (!raw || raw.dataset.miBound) return
		raw.dataset.miBound = '1'
		try { raw.open = localStorage.getItem(RAW_OPEN_KEY) === '1' } catch (e) { /* 默认收起 */ }
		raw.addEventListener('toggle', function () {
			try {
				if (raw.open) localStorage.setItem(RAW_OPEN_KEY, '1')
				else localStorage.removeItem(RAW_OPEN_KEY)
			} catch (err) { /* 仅本次会话 */ }
		})
	}

	function init() {
		bindRaw()
		render()
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
	else init()
})()
