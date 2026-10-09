// 现代布局 v2 外壳：左栏「配置」菜单、全局连接栏(每路一个连接按钮)、日志工具条、快捷行 + 发送条、日志过滤。
// 只在现代布局下挂载；经典布局的 DOM 是基准：要用的原控件一律原样搬过来(原位置留注释占位，切回时放回)，
// 新控件只驱动原控件(派发 click/change)或调用现有全局 API，状态以原控件为准、经 MutationObserver 跟随。
// 过滤的纯函数在文件顶部，node 测试(tests/modern-shell.cjs)直接 require
;(function (root) {
	'use strict'

	// ---------- 纯函数：日志过滤 ----------
	// 语法：空格分隔的词，全部满足才显示(与)。tx / rx / sys 是方向词，多个方向之间是或；
	// 连续的两位十六进制词(68 10 AA)合成一段字节序列，按字节边界匹配行的 HEX，也按原文匹配行文本；
	// 其余词按不区分大小写的子串匹配行文本
	const DIRS = ['tx', 'rx', 'sys']
	const HEX_BYTE = /^[0-9a-f]{2}$/i

	function parseLogFilter(str) {
		const out = { dirs: [], seqs: [], words: [], empty: true }
		const toks = String(str == null ? '' : str).trim().split(/\s+/).filter(Boolean)
		let run = []
		const flush = function () {
			if (run.length) out.seqs.push(run.map(function (t) { return t.toUpperCase() }))
			run = []
		}
		toks.forEach(function (t) {
			const low = t.toLowerCase()
			if (DIRS.indexOf(low) !== -1) {
				flush()
				if (out.dirs.indexOf(low) === -1) out.dirs.push(low)
				return
			}
			if (HEX_BYTE.test(t)) {
				run.push(t)
				return
			}
			flush()
			out.words.push(low)
		})
		flush()
		out.empty = !out.dirs.length && !out.seqs.length && !out.words.length
		return out
	}

	// row: { dir: 'tx' | 'rx' | 其它(按 sys), text, hex: '68 10 AA' }
	function matchLogFilter(f, row) {
		if (!f || f.empty) return true
		const dir = row.dir === 'tx' || row.dir === 'rx' ? row.dir : 'sys'
		if (f.dirs.length && f.dirs.indexOf(dir) === -1) return false
		const text = String(row.text || '').toLowerCase()
		const hex = ' ' + String(row.hex || '').trim().toUpperCase().split(/\s+/).join(' ') + ' '
		for (let i = 0; i < f.seqs.length; i++) {
			const seq = f.seqs[i]
			const inHex = hex.indexOf(' ' + seq.join(' ') + ' ') !== -1
			const inText = text.indexOf(seq.join(' ').toLowerCase()) !== -1
			if (!inHex && !inText) return false
		}
		for (let j = 0; j < f.words.length; j++) {
			if (text.indexOf(f.words[j]) === -1) return false
		}
		return true
	}

	// 「115200 8-N-1」→「115200 8N1」(连接按钮上的参数摘要)
	function compactParams(s) {
		const m = /^\s*(\S+)\s+(\S)-(\S)-(\S+)\s*$/.exec(String(s || ''))
		return m ? m[1] + ' ' + m[2] + m[3] + m[4] : String(s || '').trim()
	}

	const api = { parseLogFilter: parseLogFilter, matchLogFilter: matchLogFilter, compactParams: compactParams }
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api
		return
	}
	root.ModernShell = api
	if (typeof document === 'undefined') return

	// ---------- DOM ----------
	const $ = function (id) { return document.getElementById(id) }
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
	function btn(cls, text, title) {
		const b = mk('button', cls, text)
		b.type = 'button'
		if (title) b.title = title
		return b
	}

	let mounted = false
	let parked = []
	let hosts = []
	let observers = []
	let cleanups = []
	let timer = 0
	let refs = {}

	function park(node, parent, before) {
		if (!node || !node.parentNode || !parent) return
		const ph = document.createComment('mdn-shell-origin:' + (node.id || node.className))
		node.parentNode.insertBefore(ph, node)
		parked.push([node, ph])
		parent.insertBefore(node, before || null)
	}
	function hostEl(n, parent, before) {
		hosts.push(n)
		if (parent) parent.insertBefore(n, before || null)
		return n
	}
	function observe(target, opts, fn) {
		if (!target) return
		const mo = new MutationObserver(fn)
		mo.observe(target, opts)
		observers.push(mo)
	}
	function listen(target, type, fn, opts) {
		if (!target) return
		target.addEventListener(type, fn, opts)
		cleanups.push(function () { target.removeEventListener(type, fn, opts) })
	}
	// 短时间内多次触发只刷新一次
	function batched(fn) {
		let pending = false
		return function () {
			if (pending) return
			pending = true
			// 不用 requestAnimationFrame：后台标签页里它会一直挂起，状态就跟不上了
			setTimeout(function () {
				pending = false
				if (mounted) fn()
			}, 16)
		}
	}
	function hub() { return window.SerialHub || null }
	function isDual() {
		const h = hub()
		return !!(h && h.mode === 'dual')
	}

	// ========== 1. 左栏「配置」菜单：主题三档 + 反馈 / GitHub ==========
	const THEMES = [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']]

	function mountRail() {
		const menu = document.querySelector('.rail-config-menu')
		const sw = $('theme-switch')
		if (!menu) return
		const items = []
		const divider = function () {
			const li = mk('li')
			li.appendChild(mk('hr', 'dropdown-divider'))
			return li
		}
		if (sw) {
			const li = mk('li', 'rail-config-layout mdn-cfg-theme')
			li.appendChild(mk('span', 'rail-config-layout-title', '主题'))
			const seg = mk('div', 'ctl-seg')
			seg.setAttribute('role', 'group')
			seg.setAttribute('aria-label', '主题')
			THEMES.forEach(function (t) {
				const b = btn('', t[1])
				b.dataset.mdnTheme = t[0]
				seg.appendChild(b)
			})
			li.appendChild(seg)
			listen(seg, 'click', function (e) {
				const b = e.target.closest('button')
				if (b && typeof window.setThemeChoice === 'function') window.setThemeChoice(b.dataset.mdnTheme)
			})
			// 状态源是原主题开关(aria-checked)，setThemeChoice 改完它再跟过来
			const sync = function () {
				const on = sw.querySelector('[aria-checked="true"]')
				const cur = on ? on.dataset.themeChoice : (window.getThemeChoice ? window.getThemeChoice() : 'auto')
				seg.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.mdnTheme === cur)) })
			}
			observe(sw, { attributes: true, subtree: true, attributeFilter: ['aria-checked', 'class'] }, sync)
			sync()
			items.push(divider(), li)
		}
		// 反馈 / GitHub：链接地址取自左栏原链接，不另写一份
		const links = document.querySelectorAll('#activity-rail .rail-bottom > a.rail-item')
		if (links.length) {
			items.push(divider())
			links.forEach(function (a) {
				const li = mk('li')
				const item = mk('a', 'dropdown-item')
				item.href = a.href
				item.target = '_blank'
				item.rel = 'noopener'
				const ic = a.querySelector('i')
				if (ic) item.appendChild(icon(ic.className.replace(/^bi\s+/, '')))
				const label = a.querySelector('.rail-label')
				item.appendChild(document.createTextNode(' ' + (a.title || (label ? label.textContent : ''))))
				li.appendChild(item)
				items.push(li)
			})
		}
		items.forEach(function (li) { hostEl(li, menu) })
	}

	// ========== 2. 全局连接栏 ==========
	function chipFor(key) {
		if (key === 'B') return $('serial-chip-b')
		return isDual() ? $('serial-chip-a') : $('serial-chip')
	}
	function sidFor(key) {
		if (key === 'B') return 'B'
		return isDual() ? 'A' : 'S'
	}

	function makePop(key) {
		const wrap = mk('div', 'mdn-conn')
		wrap.dataset.path = key
		const b = btn('mdn-conn-btn')
		b.setAttribute('aria-haspopup', 'dialog')
		b.setAttribute('aria-expanded', 'false')
		const dot = mk('span', 'mdn-dot')
		const letter = mk('b', 'mdn-conn-letter')
		const label = mk('span', 'mdn-conn-label')
		const port = mk('span', 'mdn-conn-port')
		const params = mk('span', 'mdn-conn-params')
		b.append(dot, letter, label, port, params, icon('bi-chevron-down'))
		const pop = mk('div', 'mdn-pop')
		pop.hidden = true
		pop.setAttribute('role', 'dialog')
		const head = mk('div', 'mdn-pop-title')
		const dev = mk('div', 'mdn-pop-sec mdn-pop-dev')
		dev.appendChild(mk('div', 'mdn-pop-cap', '串口设备'))
		const lab = mk('div', 'mdn-pop-sec mdn-pop-label mdn-dual-only')
		lab.appendChild(mk('div', 'mdn-pop-cap', '路标签'))
		const par = mk('div', 'mdn-pop-sec mdn-pop-params')
		par.appendChild(mk('div', 'mdn-pop-cap', '串口参数 · 单路 / 双路共用'))
		const foot = mk('div', 'mdn-pop-foot mdn-dual-only')
		const back = btn('btn btn-sm btn-outline-secondary', '回到单路', '切回单路模式：双路的口在后台保持连接')
		back.prepend(icon('bi-arrow-return-left'), document.createTextNode(' '))
		foot.appendChild(back)
		listen(back, 'click', function () {
			closePops()
			const m = $('serial-mode-single')
			if (m) m.click()
		})
		pop.append(head, dev, lab, par, foot)
		wrap.append(b, pop)
		listen(b, 'click', function () {
			const open = pop.hidden
			closePops()
			if (open) openPop(key)
		})
		return { wrap: wrap, btn: b, dot: dot, letter: letter, label: label, port: port, params: params, pop: pop, head: head, dev: dev, lab: lab, par: par }
	}

	function openPop(key) {
		const p = refs.paths[key]
		if (!p) return
		// 串口参数只有一份，打开哪一路就挂到哪一路的菜单里
		if (refs.paramsBox) p.par.appendChild(refs.paramsBox)
		p.pop.hidden = false
		p.btn.setAttribute('aria-expanded', 'true')
		refs.openKey = key
	}
	function closePops() {
		if (!refs.paths) return
		Object.keys(refs.paths).forEach(function (k) {
			refs.paths[k].pop.hidden = true
			refs.paths[k].btn.setAttribute('aria-expanded', 'false')
		})
		refs.openKey = null
	}

	function mountConnBar() {
		const top = $('app-topbar')
		const bar = $('serial-connect-bar')
		if (!top || !bar) return
		const cb = hostEl(mk('div', 'mdn-connbar'), top, bar)
		cb.id = 'mdn-connbar'
		cb.setAttribute('role', 'toolbar')
		cb.setAttribute('aria-label', '连接')
		refs.connbar = cb
		const main = makePop('main')
		const b = makePop('B')
		refs.paths = { main: main, B: b }
		// 设备芯片(状态 + 选口/改名 + 连接/断开)整块搬进各路菜单，里面的行为全部沿用
		park($('serial-chip'), main.dev)
		park($('serial-chip-a'), main.dev)
		park($('serial-chip-b'), b.dev)
		park($('serial-session-a-label'), main.lab)
		park($('serial-session-b-label'), b.lab)
		const card = document.querySelector('#serial-params-popover .serial-settings-card')
		refs.paramsBox = mk('div', 'mdn-params-box')
		park(card, refs.paramsBox)
		main.par.appendChild(refs.paramsBox)

		const addB = btn('mdn-conn-btn mdn-conn-add mdn-single-only', '+ B 路', '进入双路：再接一路串口')
		listen(addB, 'click', function () {
			closePops()
			const m = $('serial-mode-dual')
			if (m) m.click()
		})
		const sep = function (cls) { return mk('span', 'mdn-sep' + (cls ? ' ' + cls : '')) }
		const send = $('serial-active-send') ? $('serial-active-send').closest('.dual-active-send') : null
		const sendSlot = mk('span', 'mdn-conn-send mdn-dual-only')
		const blu = btn('mdn-conn-btn mdn-conn-blu', '', '功耗仪连接状态 · 点击打开功耗分析页')
		const bluDot = mk('span', 'mdn-dot')
		const bluText = mk('span', '', '功耗仪 未连接')
		blu.append(bluDot, bluText)
		listen(blu, 'click', function () {
			const r = document.querySelector('.rail-item[data-view="view-blu"]')
			if (r) r.click()
		})
		refs.blu = { btn: blu, dot: bluDot, text: bluText }
		const tools = mk('span', 'mdn-conn-tools')
		cb.append(main.wrap, b.wrap, addB, sendSlot, sep(), blu, sep(), tools)
		b.wrap.classList.add('mdn-dual-only')
		if (send) park(send, sendSlot)
		park(bar.querySelector('.connect-bar-proto'), tools)
		cb.appendChild(mk('span', 'mdn-grow'))
		park($('wb-palette-btn'), cb)

		listen(document, 'pointerdown', function (e) {
			if (!refs.openKey) return
			const p = refs.paths[refs.openKey]
			// 改名弹窗等模态层不算「点到外面」
			if (p.wrap.contains(e.target) || e.target.closest('.modal')) return
			closePops()
		}, true)
		listen(document, 'keydown', function (e) {
			if (e.key !== 'Escape' || !refs.openKey) return
			const p = refs.paths[refs.openKey]
			closePops()
			p.btn.focus()
		})

		// 命令面板的「串口参数」点的是原参数摘要键：现代布局下它连同空掉的浮层一起隐藏，转成打开当前路的菜单
		listen($('serial-params-summary'), 'click', function (e) {
			e.preventDefault()
			e.stopPropagation()
			// 原浮层已空且隐藏，别让 Bootstrap 把它也标成展开
			const t = e.currentTarget
			setTimeout(function () {
				if (typeof bootstrap !== 'undefined' && bootstrap.Dropdown) bootstrap.Dropdown.getOrCreateInstance(t).hide()
			}, 0)
			openPop('main')
			const baud = $('serial-baud')
			if (baud) baud.focus()
		})
		const refresh = batched(refreshConn)
		;['serial-chip', 'serial-chip-a', 'serial-chip-b', 'serial-status', 'serial-status-a', 'serial-status-b', 'serial-params-summary-text'].forEach(function (id) {
			observe($(id), { attributes: true, childList: true, subtree: true, characterData: true }, refresh)
		})
		observe($('serial-mode-dual'), { attributes: true, attributeFilter: ['class'] }, refresh)
		;['serial-session-a-label', 'serial-session-b-label'].forEach(function (id) {
			listen($(id), 'input', refresh)
			listen($(id), 'change', refresh)
		})
		;['serial-baud', 'serial-data-bits', 'serial-stop-bits', 'serial-parity'].forEach(function (id) {
			listen($(id), 'change', refresh)
		})
		refs.refreshConn = refresh
		refreshConn()
	}

	function refreshConn() {
		const cb = refs.connbar
		if (!cb) return
		const dual = isDual()
		cb.dataset.mode = dual ? 'dual' : 'single'
		const h = hub()
		const params = compactParams(($('serial-params-summary-text') || {}).textContent)
		Object.keys(refs.paths).forEach(function (key) {
			const p = refs.paths[key]
			const sid = sidFor(key)
			const chip = chipFor(key)
			const open = h ? h.isOpen(sid) : !!(chip && chip.classList.contains('is-open'))
			const opening = h ? h.isOpening(sid) : false
			p.wrap.dataset.state = opening ? 'opening' : (open ? 'open' : 'closed')
			p.wrap.dataset.sid = sid
			const nameEl = chip ? chip.querySelector('.serial-port-name') : null
			const portName = nameEl ? nameEl.textContent.trim() : ''
			const lbl = sid === 'S' ? '' : (sid === 'B' ? (h ? h.getLabelB() : 'B路') : (h ? h.getLabelA() : 'A路'))
			p.letter.textContent = sid === 'S' ? '' : sid
			// 标签改过才显示(默认就是「A路」「B路」，再写一遍是噪声)
			p.label.textContent = lbl && lbl !== sid + '路' ? lbl : ''
			p.port.textContent = portName || '未选择串口'
			p.params.textContent = params
			const st = opening ? '正在连接' : (open ? '已连接' : '未连接')
			const who = sid === 'S' ? '串口' : sid + ' 路' + (p.label.textContent ? '（' + p.label.textContent + '）' : '')
			p.btn.setAttribute('aria-label', who + ' ' + (portName || '未选择串口') + ' · ' + params + ' · ' + st + ' · 打开菜单')
			p.btn.title = who + ' · ' + st + ' · 选择串口 / 连接断开 / 串口参数' + (sid === 'S' ? '' : ' / 路标签')
			p.head.textContent = sid === 'S' ? '单路串口' : sid + ' 路'
		})
		// 发送条上的「发 A / 发 B」与快捷行不在连接栏里，显隐单独跟模式
		if (refs.sendSeg) refs.sendSeg.hidden = !dual
		const b = refs.blu
		if (b) {
			const on = !!(window.bluApi && window.bluApi.isOpen())
			b.btn.dataset.state = on ? 'open' : 'closed'
			b.text.textContent = on ? '功耗仪 已连接' : '功耗仪 未连接'
		}
	}

	// ========== 3. 日志工具条 ==========
	function mountLogBar() {
		const header = document.querySelector('.serial-log-header')
		if (!header) return
		const bar = hostEl(mk('div', 'mdn-logbar'), header.parentNode, header)
		bar.id = 'mdn-logbar'
		bar.setAttribute('role', 'toolbar')
		bar.setAttribute('aria-label', '日志工具条')
		const grp = function (cls, label) {
			const g = mk('span', 'mdn-grp ' + cls)
			if (label) g.appendChild(mk('span', 'mdn-grp-label', label))
			bar.appendChild(g)
			return g
		}
		const dualG = grp('mdn-grp-dual')
		park($('serial-dual-view-seg'), dualG)
		park($('serial-log-legend'), dualG)
		const fmt = grp('mdn-grp-fmt')
		fmt.setAttribute('role', 'group')
		fmt.setAttribute('aria-label', '显示格式')
		;['serial-log-fmt-hex', 'serial-log-fmt-text', 'serial-log-fmt-parse', 'serial-log-ansi'].forEach(function (id) { park($(id), fmt) })
		const split = grp('mdn-grp-split', '分包')
		park(document.querySelector('#serial-log-settings-popover .serial-split-seg'), split)
		const tw = mk('span', 'mdn-num')
		split.appendChild(tw)
		park($('serial-timer-out'), tw)
		tw.appendChild(mk('span', 'mdn-unit', 'ms'))
		const rows = grp('mdn-grp-rows', '行数')
		park($('serial-max-rows'), rows)
		const flt = grp('mdn-grp-filter')
		const input = mk('input', 'form-control mdn-filter')
		input.type = 'search'
		input.id = 'mdn-log-filter'
		input.placeholder = '过滤：tx / rx / 关键字 / 68 10 AA'
		input.setAttribute('aria-label', '过滤日志（方向 / 关键字 / 字节序列，空格分隔表示同时满足）')
		input.title = '只隐藏不匹配的行，不删日志；复制、导出仍是全部行'
		input.spellcheck = false
		input.autocomplete = 'off'
		const count = mk('span', 'mdn-filter-count')
		count.hidden = true
		count.setAttribute('aria-live', 'polite')
		flt.append(input, count)
		refs.filter = { input: input, count: count, f: parseLogFilter('') }
		const view = grp('mdn-grp-view')
		park($('serial-log-view-seg'), view)
		const act = grp('mdn-grp-act')
		park(header.querySelector('.serial-log-actions'), act)
		mountFilter()
		// 命令面板的「日志设置」点的是原设置键(现代布局下随标题行隐藏)：设置已平铺在工具条上，转成聚焦到格式胶囊
		listen($('serial-log-settings-btn'), 'click', function (e) {
			e.preventDefault()
			e.stopPropagation()
			const t = e.currentTarget
			setTimeout(function () {
				if (typeof bootstrap !== 'undefined' && bootstrap.Dropdown) bootstrap.Dropdown.getOrCreateInstance(t).hide()
			}, 0)
			const first = $('serial-log-fmt-hex')
			if (first) first.focus()
		})
	}

	// ---------- 日志过滤：纯视图，只给不匹配的行加隐藏类，不删行 ----------
	const FLT_CLS = 'mdn-flt-out'
	function logBoxes() {
		return [$('serial-logs-single'), $('serial-logs-dual')].filter(Boolean)
	}
	function rowInfo(row) {
		return { dir: row.getAttribute('data-dir') || '', text: row.textContent, hex: row.getAttribute('data-hex') || '' }
	}
	function applyRow(row, f) {
		if (!row.classList || !row.classList.contains('log-row')) {
			// 非数据行(分隔提示等)不参与过滤
			if (row.classList && row.classList.contains(FLT_CLS)) row.classList.remove(FLT_CLS)
			return
		}
		const hide = !f.empty && !matchLogFilter(f, rowInfo(row))
		if (row.classList.contains(FLT_CLS) !== hide) row.classList.toggle(FLT_CLS, hide)
	}
	function applyAll() {
		const f = refs.filter.f
		logBoxes().forEach(function (box) {
			for (let i = 0; i < box.children.length; i++) applyRow(box.children[i], f)
		})
		updateFilterCount()
	}
	function updateFilterCount() {
		const r = refs.filter
		if (!r) return
		const h = hub()
		const box = h ? h.getLogContainer() : null
		if (r.f.empty || !box) {
			r.count.hidden = true
			return
		}
		let total = 0
		let shown = 0
		for (let i = 0; i < box.children.length; i++) {
			const n = box.children[i]
			if (!n.classList.contains('log-row')) continue
			total++
			if (!n.classList.contains(FLT_CLS)) shown++
		}
		r.count.hidden = false
		r.count.textContent = '已过滤 ' + shown + '/' + total
		r.count.title = '显示 ' + shown + ' 行，共 ' + total + ' 行；复制、导出仍是全部行'
	}
	function mountFilter() {
		const r = refs.filter
		let t = 0
		listen(r.input, 'input', function () {
			clearTimeout(t)
			t = setTimeout(function () {
				r.f = parseLogFilter(r.input.value)
				applyAll()
			}, 120)
		})
		cleanups.push(function () { clearTimeout(t) })
		// 新行、重渲(解析格式切换会改行体)、裁剪：只重算变动的行；行数变化刷新计数
		const pending = new Set()
		let full = false
		const flush = batched(function () {
			const f = r.f
			if (full) {
				full = false
				pending.clear()
				applyAll()
				return
			}
			pending.forEach(function (row) { if (row.isConnected) applyRow(row, f) })
			pending.clear()
			updateFilterCount()
		})
		logBoxes().forEach(function (box) {
			observe(box, { childList: true, subtree: true, characterData: true }, function (muts) {
				for (let i = 0; i < muts.length; i++) {
					const m = muts[i]
					if (m.target === box) {
						if (m.addedNodes.length > 200) full = true
						else m.addedNodes.forEach(function (n) { if (n.nodeType === 1) pending.add(n) })
					} else {
						const el = m.target.nodeType === 1 ? m.target : m.target.parentNode
						const row = el && el.closest ? el.closest('.log-row') : null
						if (row && row.parentNode === box) pending.add(row)
					}
				}
				flush()
			})
		})
		// 终端视图没有行，过滤不适用
		const term = $('serial-log-view-term')
		const syncTerm = function () {
			const isTerm = !!(term && term.getAttribute('aria-pressed') === 'true')
			r.input.disabled = isTerm
			r.input.title = isTerm ? '终端视图不支持过滤' : '只隐藏不匹配的行，不删日志；复制、导出仍是全部行'
		}
		observe(term, { attributes: true, attributeFilter: ['aria-pressed'] }, syncTerm)
		syncTerm()
		// 单/双路切换后计数换成当前那一套
		observe($('serial-mode-dual'), { attributes: true, attributeFilter: ['class'] }, batched(updateFilterCount))
		// 进入时清一遍：会话缓存恢复回来的行可能带着上次的隐藏类
		applyAll()
	}

	// ========== 4. 快捷行 + 发送条 ==========
	const QUICK_MAX = 6

	function mountSendBar() {
		const panel = $('serial-send-panel')
		const body = $('serial-send-body')
		const header = $('serial-send-header')
		if (!panel || !body) return
		const row = hostEl(mk('div', 'mdn-quickrow'), panel, panel.firstChild)
		row.id = 'mdn-quickrow'
		const sel = mk('select', 'form-select form-select-sm mdn-quick-group')
		sel.setAttribute('aria-label', '快捷发送分组')
		sel.title = '快捷发送分组（与右栏「快捷发送」同一份）'
		const list = mk('span', 'mdn-quick-list')
		list.setAttribute('role', 'group')
		list.setAttribute('aria-label', '快捷发送')
		const manage = btn('mdn-chip mdn-quick-manage', '管理…', '在右栏打开「快捷发送」：编辑、增删、分组、导入导出')
		listen(manage, 'click', function () {
			if (window.Workbench) window.Workbench.open('quick-send')
		})
		const grow = mk('span', 'mdn-grow')
		const fold = btn('mdn-fold', '', '')
		fold.appendChild(icon('bi-chevron-down'))
		listen(fold, 'click', function () { if (header) header.click() })
		row.append(sel, list, manage, grow)
		park($('serial-send-target'), row)
		row.appendChild(fold)
		refs.quick = { sel: sel, list: list, fold: fold, more: manage }

		const orig = $('serial-quick-send')
		listen(sel, 'change', function () {
			if (!orig) return
			orig.value = sel.value
			orig.dispatchEvent(new Event('change', { bubbles: true }))
			refreshQuick()
		})
		listen(list, 'click', function (e) {
			const b = e.target.closest('.mdn-chip[data-idx]')
			const content = $('serial-quick-send-content')
			if (!b || !content) return
			const item = content.children[Number(b.dataset.idx)]
			const send = item && item.querySelector('.quick-send')
			// 发送走原快捷发送按钮的点击，HEX/文本、名称记录与原来一致
			if (send) send.click()
		})
		const refresh = batched(refreshQuick)
		observe(orig, { childList: true, subtree: true, characterData: true }, refresh)
		observe($('serial-quick-send-content'), { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value', 'title'] }, refresh)
		listen(orig, 'change', refresh)
		listen($('serial-quick-send-content'), 'change', refresh)
		listen($('serial-quick-send-content'), 'input', refresh)
		observe(panel, { attributes: true, attributeFilter: ['class'] }, syncFold)
		syncFold()
		refreshQuick()

		// 双路「发 A / 发 B」：与连接栏的「主发」是同一状态，点击转给原主发按钮(钉扎提示等沿用)
		// 发送键搬到开关一排末尾，输入框独占前面，排成设计稿的一行
		park($('serial-send'), body.querySelector('.send-options'))
		const seg = hostEl(mk('div', 'ctl-seg mdn-send-seg mdn-dual-only'), body, body.firstChild)
		seg.setAttribute('role', 'group')
		seg.setAttribute('aria-label', '发送到')
		refs.sendSeg = seg
		const group = $('serial-active-send')
		if (group) {
			group.querySelectorAll('.dual-send-btn').forEach(function (o) {
				const b = btn('', '')
				b.dataset.sid = o.getAttribute('data-sid')
				seg.appendChild(b)
			})
			listen(seg, 'click', function (e) {
				const b = e.target.closest('button[data-sid]')
				const o = b && group.querySelector('.dual-send-btn[data-sid="' + b.dataset.sid + '"]')
				if (o) o.click()
			})
			observe(group, { attributes: true, subtree: true, attributeFilter: ['class', 'hidden'] }, syncSendSeg)
		}
		const labelsChanged = batched(syncSendSeg)
		listen($('serial-session-a-label'), 'input', labelsChanged)
		listen($('serial-session-b-label'), 'input', labelsChanged)
		observe($('serial-mode-dual'), { attributes: true, attributeFilter: ['class'] }, labelsChanged)
		syncSendSeg()
	}

	function syncFold() {
		const q = refs.quick
		const panel = $('serial-send-panel')
		if (!q || !panel) return
		const collapsed = panel.classList.contains('collapsed')
		q.fold.setAttribute('aria-expanded', String(!collapsed))
		q.fold.setAttribute('aria-label', collapsed ? '展开发送区' : '收起发送区')
		q.fold.title = collapsed ? '展开发送区' : '收起发送区'
	}

	function syncSendSeg() {
		const seg = refs.sendSeg
		const group = $('serial-active-send')
		if (!seg || !group) return
		const h = hub()
		seg.querySelectorAll('button[data-sid]').forEach(function (b) {
			const o = group.querySelector('.dual-send-btn[data-sid="' + b.dataset.sid + '"]')
			if (!o) return
			const sid = b.dataset.sid
			b.hidden = o.hidden
			b.setAttribute('aria-pressed', String(o.classList.contains('active')))
			b.textContent = '发 ' + (sid === 'S' ? '单' : sid)
			const name = sid === 'S' ? '单路串口' : (h ? (sid === 'B' ? h.getLabelB() : h.getLabelA()) : sid + '路')
			b.title = '发送到 ' + name + '（与顶栏「主发」同一设置）'
		})
	}

	function refreshQuick() {
		const q = refs.quick
		const orig = $('serial-quick-send')
		const content = $('serial-quick-send-content')
		if (!q || !orig) return
		// 分组下拉：选项与原下拉逐项对齐(原下拉是唯一来源)
		const opts = Array.from(orig.options)
		const sig = opts.map(function (o) { return o.value + '\u0001' + o.textContent }).join('\u0002')
		if (q.sig !== sig) {
			q.sig = sig
			q.sel.textContent = ''
			opts.forEach(function (o) {
				const n = mk('option', '', o.textContent)
				n.value = o.value
				q.sel.appendChild(n)
			})
		}
		if (q.sel.value !== orig.value) q.sel.value = orig.value
		q.sel.disabled = !opts.length
		// 快捷按钮：当前分组前若干条
		const items = content ? Array.from(content.children).filter(function (n) { return n.classList.contains('quick-item') }) : []
		const want = items.slice(0, QUICK_MAX).map(function (it) {
			const s = it.querySelector('.quick-send')
			const c = it.querySelector('.quick-content')
			const hex = it.querySelector('.quick-hex input')
			return { name: s ? s.textContent.trim() : '发送', content: c ? c.value : '', hex: !!(hex && hex.checked), idx: Array.prototype.indexOf.call(content.children, it) }
		})
		const sig2 = JSON.stringify(want)
		if (q.sig2 !== sig2) {
			q.sig2 = sig2
			q.list.textContent = ''
			want.forEach(function (w) {
				const b = btn('mdn-chip' + (w.hex ? ' mdn-chip--hex' : ''), w.name || '发送', '发送: ' + (w.name || '发送') + (w.content ? '\n' + (w.hex ? 'HEX ' : '') + w.content : '（内容为空）'))
				b.dataset.idx = String(w.idx)
				q.list.appendChild(b)
			})
		}
		const more = items.length - want.length
		q.more.textContent = more > 0 ? '管理…（另 ' + more + ' 条）' : '管理…'
	}

	// ========== 挂载 / 卸载 ==========
	function mount() {
		if (mounted) return
		mounted = true
		refs = {}
		mountRail()
		mountConnBar()
		mountLogBar()
		mountSendBar()
		if (refs.connbar) refreshConn()
		restyleTextareas()
		// 功耗仪状态没有事件可挂，跟状态栏一样每秒看一次
		timer = setInterval(function () {
			if (!document.hidden && refs.refreshConn) refs.refreshConn()
		}, 1000)
	}

	function unmount() {
		if (!mounted) return
		mounted = false
		clearInterval(timer)
		observers.forEach(function (mo) { mo.disconnect() })
		observers = []
		cleanups.forEach(function (fn) { fn() })
		cleanups = []
		closePops()
		parked.reverse().forEach(function (pair) { pair[1].replaceWith(pair[0]) })
		parked = []
		hosts.forEach(function (n) { n.remove() })
		hosts = []
		// 过滤只是现代布局里的视图状态：切回经典时把隐藏类全部摘掉
		logBoxes().forEach(function (box) {
			box.querySelectorAll('.' + FLT_CLS).forEach(function (n) { n.classList.remove(FLT_CLS) })
		})
		refs = {}
		restyleTextareas()
	}

	// Chrome 偶发不给 <textarea> 重算样式：切回经典后它还留着现代布局的 min-height 等，发送区矮一截。
	// 摘下再放回渲染树逼它重算；内联 style 原来没有就删掉属性，DOM 与进入前一致
	function restyleTextareas() {
		document.querySelectorAll('#app-shell textarea').forEach(function (t) {
			const had = t.hasAttribute('style')
			const prev = t.style.display
			t.style.display = 'none'
			void t.offsetHeight
			t.style.display = prev
			if (!had && !t.getAttribute('style')) t.removeAttribute('style')
		})
	}

	function init() {
		if (document.documentElement.dataset.layout === 'modern') mount()
		// workbench.js 先注册(先建好 #app-topbar 宿主)，这里后注册，搬运顺序跟着走
		document.addEventListener('serial-layout-move', function (e) {
			if (e.detail && e.detail.layout === 'modern') mount()
			else unmount()
		})
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
	else init()
})(typeof window !== 'undefined' ? window : globalThis)
