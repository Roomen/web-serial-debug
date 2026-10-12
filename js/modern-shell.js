// 现代布局 v2 外壳：左栏「配置」菜单、全局连接栏(每路一个连接按钮)、日志工具条、快捷行 + 发送条、日志过滤与缩放。
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

	// 日志缩放：70%–200%，每档 10%；存取都过一遍，坏值回落 100%
	const ZOOM_MIN = 0.7
	const ZOOM_MAX = 2
	const ZOOM_STEP = 0.1
	function clampZoom(v) {
		const n = Number(v)
		if (!isFinite(n) || n <= 0) return 1
		return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n)) * 10) / 10
	}
	function stepZoom(v, dir) {
		return clampZoom(clampZoom(v) + (dir > 0 ? ZOOM_STEP : -ZOOM_STEP))
	}

	// 串口列表行：标题别名优先，否则产品名(同型号多口加 #n)，再否则口名；没有任何名字时按有没有 VID 给类别名
	function portRowTitle(m) {
		m = m || {}
		if (m.alias) return m.alias
		if (m.productName) return m.productName + (m.slot != null ? ' #' + (m.slot + 1) : '')
		if (m.portName) return m.portName
		return m.vid ? 'USB 串口设备' : '串口设备'
	}
	// 次行小字：口名 · VID:PID · SN(标题已经是口名时不重复)
	function portRowSub(m) {
		m = m || {}
		const out = []
		if (m.portName && portRowTitle(m) !== m.portName) out.push(m.portName)
		if (m.vid && m.pid) out.push(String(m.vid).toUpperCase() + ':' + String(m.pid).toUpperCase())
		if (m.sn) out.push('SN ' + m.sn)
		return out.join(' · ')
	}
	// 行状态：本路已连接 / 连接中 / 本路当前设备 / 被别处占用(不可选) / 已记住但未在位
	// s = { current, open, opening, failed, owner(sid | 'BLU' | null), absent }
	function portRowState(s) {
		s = s || {}
		if (s.absent) return { tag: '未在位', kind: 'absent', disabled: true }
		if (s.current && s.failed) return { tag: '关闭失败', kind: 'failed', disabled: false }
		if (s.current && s.opening) return { tag: '连接中', kind: 'opening', disabled: false }
		if (s.current && s.open) return { tag: '已连接', kind: 'open', disabled: false }
		if (s.current) return { tag: '当前设备', kind: 'current', disabled: false }
		if (s.owner) {
			const who = s.owner === 'BLU' ? '功耗分析' : (s.owner === 'S' ? '单路' : s.owner + ' 路')
			return { tag: who + '占用', kind: 'busy', disabled: true }
		}
		return { tag: '', kind: 'idle', disabled: false }
	}

	const api = { parseLogFilter: parseLogFilter, matchLogFilter: matchLogFilter, compactParams: compactParams, clampZoom: clampZoom, stepZoom: stepZoom, portRowTitle: portRowTitle, portRowSub: portRowSub, portRowState: portRowState }
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
		// 反馈 / GitHub：链接地址取自左栏原链接，不另写一份；桌面客户端由原生「帮助」菜单提供，这里按 shell.browser 隐藏。下载客户端留在左栏一级，不收进来
		const links = document.querySelectorAll('#activity-rail .rail-bottom > a.rail-item:not(#rail-download)')
		if (links.length) {
			const div = divider()
			div.setAttribute('data-feature', 'shell.browser')
			items.push(div)
			links.forEach(function (a) {
				const li = mk('li')
				li.setAttribute('data-feature', 'shell.browser')
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
		b.append(dot, letter, label, port, params)
		// 设备与配置分开：主按钮管设备(网页版本路没选口时直接弹浏览器选择框)，右侧箭头总是打开设备 / 参数菜单
		const more = btn('mdn-conn-more', '', '串口设备与参数')
		more.setAttribute('aria-haspopup', 'dialog')
		more.setAttribute('aria-expanded', 'false')
		more.setAttribute('aria-label', '打开串口设备与参数菜单')
		more.appendChild(icon('bi-chevron-down'))
		const pop = mk('div', 'mdn-pop')
		pop.hidden = true
		pop.setAttribute('role', 'dialog')
		const head = mk('div', 'mdn-pop-title')
		const dev = mk('div', 'mdn-pop-sec mdn-pop-dev')
		dev.appendChild(mk('div', 'mdn-pop-cap', '串口设备'))
		const lab = mk('div', 'mdn-pop-sec mdn-pop-label mdn-dual-only')
		lab.appendChild(mk('div', 'mdn-pop-cap', '路标签'))
		const par = mk('div', 'mdn-pop-sec mdn-pop-params')
		// 文案随模式：双路两路的参数与协议各自独立(refreshConn 里改)
		const parCap = mk('div', 'mdn-pop-cap', '串口参数')
		par.appendChild(parCap)
		pop.append(head, dev, lab, par)
		// 只有 B 路能移除：B 关闭(仍记着设备)，A 路的口、参数、协议原样交回单路(common.js 的 removeLaneB)
		if (key === 'B') {
			const foot = mk('div', 'mdn-pop-foot')
			const rm = btn('btn btn-sm btn-outline-secondary', '移除 B 路', '断开 B 路并回到单路：A 路的串口交回单路继续使用，B 路记着设备，下次加回来点一下就能连')
			rm.prepend(icon('bi-x-lg'), document.createTextNode(' '))
			foot.appendChild(rm)
			listen(rm, 'click', function () {
				closePops()
				const m = $('serial-mode-single')
				if (m) m.click()
			})
			pop.appendChild(foot)
		}
		// 本路协议：常改，所以紧贴在连接按钮右侧一键直选，不进菜单。选项抄顶栏(协议注册时只往顶栏加)，改值经 serialLanes.setProtocol，
		// 改的正好是顶栏那一路(单路、双路主发路)时由它转给顶栏派发 change
		const proto = mk('select', 'form-select form-select-sm mdn-conn-proto')
		proto.setAttribute('aria-label', key === 'B' ? 'B 路协议' : '协议')
		listen(proto, 'change', function () {
			const lanes = window.serialLanes
			if (lanes) lanes.setProtocol(sidFor(key), proto.value)
			if (refs.refreshConn) refs.refreshConn()
		})
		// 能枚举的后端(桌面客户端)点设备键直接下拉：只有串口列表(在位的全部口)，单击即选为本路设备并连接、随即收起。
		// 它是另一份列表实例(行节点各管各的)，与完整菜单里的那份共用同一路的动作队列
		const dd = mk('div', 'mdn-dd')
		dd.hidden = true
		dd.setAttribute('role', 'dialog')
		dd.setAttribute('aria-label', '选择串口设备')
		wrap.append(b, more, proto, pop, dd)
		const toggleMenu = function () {
			const open = pop.hidden
			closePops()
			if (open) openPop(key)
		}
		listen(b, 'click', function () {
			const lanes = window.serialLanes
			const A = window.SerialAdapter
			// 网页版列不出没授权的口，本路还没选口时菜单里只有空列表：直接弹浏览器选择框，选完即连接
			if (lanes && A && !A.canEnumerate() && !lanes.portOf(sidFor(key))) {
				closePops()
				lanes.requestPort(sidFor(key))
				return
			}
			// 按能力分支，不按平台名：能枚举就下拉选口，网页版(已选过口)仍打开完整菜单
			if (A && A.canEnumerate()) {
				const open = dd.hidden
				closePops()
				if (open) openDropdown(key)
				return
			}
			toggleMenu()
		})
		listen(more, 'click', toggleMenu)
		const ports = makePortList(key)
		const quick = makePortList(key, true)
		// 两份列表共用一条动作队列：一路上的选用 / 连接串行做完，不论从哪份列表发起
		Object.defineProperty(quick, 'queue', { get: function () { return ports.queue }, set: function (v) { ports.queue = v } })
		dd.appendChild(quick.box)
		return { wrap: wrap, btn: b, more: more, proto: proto, dot: dot, letter: letter, label: label, port: port, params: params, pop: pop, dd: dd, head: head, dev: dev, lab: lab, par: par, parCap: parCap, ports: ports, quick: quick }
	}

	function openPop(key) {
		const p = refs.paths[key]
		if (!p) return
		// 串口参数卡只有一份，打开哪一路就挂到哪一路的菜单里；双路下卡片同时切到这一路的参数与协议
		if (refs.paramsBox) p.par.appendChild(refs.paramsBox)
		if (isDual() && window.serialLanes) window.serialLanes.setParamsTarget(sidFor(key))
		p.pop.hidden = false
		p.btn.setAttribute('aria-expanded', 'true')
		p.more.setAttribute('aria-expanded', 'true')
		refs.openKey = key
		// 菜单一打开就重新列口；先按上次的结果画，列完再换
		renderPorts(p.ports)
		loadPorts(p.ports)
	}
	// 设备键的下拉：只有本路的串口列表，打开就把焦点放到当前设备(没有就第一行)，上下键移动、回车选用、Esc 收起
	function openDropdown(key) {
		const p = refs.paths[key]
		if (!p) return
		p.dd.hidden = false
		p.btn.setAttribute('aria-expanded', 'true')
		refs.ddKey = key
		const st = p.quick
		st.wantFocus = true
		renderPorts(st)
		const row = st.list.querySelector('.mdn-port[tabindex="0"]')
		if (row) row.focus()
		loadPorts(st)
	}
	// 选用后下拉随即收起，收起后连点的第二下会落到下面的控件上：短时间内吞掉连点(e.detail > 1)的 click
	function swallowDoubleClick() {
		const h = function (e) {
			if (e.detail > 1) {
				e.stopPropagation()
				e.preventDefault()
			}
		}
		document.addEventListener('click', h, true)
		setTimeout(function () { document.removeEventListener('click', h, true) }, 700)
	}
	function closePops() {
		if (!refs.paths) return
		Object.keys(refs.paths).forEach(function (k) {
			// 改名输入框开着就先失焦(按保存收尾)，隐藏后不一定还会派发 blur
			;[refs.paths[k].ports, refs.paths[k].quick].forEach(function (st) {
				if (st && st.editing) st.editing.input.blur()
			})
			refs.paths[k].dd.hidden = true
			refs.paths[k].pop.hidden = true
			refs.paths[k].btn.setAttribute('aria-expanded', 'false')
			refs.paths[k].more.setAttribute('aria-expanded', 'false')
		})
		refs.openKey = null
		refs.ddKey = null
	}

	// ---------- 每路菜单里的串口列表 ----------
	// 现代布局选口的主路径：直接列出串口(桌面客户端是在位的全部串口，网页版是浏览器里授权过的口)，单击或回车即选为本路设备并连接
	// (本路正连着别的口就先断开再连；本路当前设备那一行没连着就连上，连着就不动作，断开走芯片上的按钮)，行内改名。选用、连接、改名一律经 window.serialLanes
	// 走 common.js 原有的绑定与打开路径，这里不碰会话。设备字符串(产品名、序列号、别名)一律 textContent
	function makePortList(key, quick) {
		const box = mk('div', quick ? 'mdn-ports mdn-ports--quick' : 'mdn-ports')
		const list = mk('div', 'mdn-ports-list')
		list.setAttribute('role', 'listbox')
		list.setAttribute('aria-label', '串口设备')
		const empty = mk('div', 'mdn-ports-empty')
		const hint = mk('div', 'mdn-ports-hint')
		const foot = mk('div', 'mdn-ports-foot')
		const add = btn('btn btn-sm btn-outline-primary', '', '在浏览器的选择框里选一个串口设备并连接，选过的设备之后会一直列在这里')
		add.append(icon('bi-usb-plug'), document.createTextNode(' 选择串口…'))
		const reload = btn('btn btn-sm btn-outline-secondary', '', '重新列出串口')
		reload.append(icon('bi-arrow-clockwise'), document.createTextNode(' 刷新'))
		foot.append(add, reload)
		box.append(list, empty, hint, foot)
		const st = { key: key, box: box, list: list, empty: empty, hint: hint, add: add, reload: reload, foot: foot,
			quick: !!quick, ports: [], rows: [], rowEls: null, loaded: false, seq: 0, sig: '', editing: null, queue: Promise.resolve(), focusPort: null, wantFocus: false }
		listen(add, 'click', function () {
			const lanes = window.serialLanes
			if (lanes) enqueuePort(st, function () { return lanes.requestPort(sidFor(key)) })
		})
		listen(reload, 'click', function () { loadPorts(st) })
		listen(list, 'click', function (e) { onPortClick(st, e) })
		listen(list, 'keydown', function (e) { onPortKey(st, e) })
		return st
	}

	function loadPorts(st) {
		const lanes = window.serialLanes
		const A = window.SerialAdapter
		if (!lanes || !A || !mounted) return Promise.resolve()
		const seq = ++st.seq
		return A.listPorts().then(function (ports) {
			ports = (ports || []).filter(function (p) { return p && !lanes.portMeta(p).excluded })
			return lanes.resolvePorts(ports).then(function () { return ports })
		}).then(function (ports) {
			if (seq !== st.seq || !mounted) return
			st.ports = ports
			st.loaded = true
			renderPorts(st)
		}).catch(function (e) {
			console.warn('列串口失败', e)
			// 列不出来也要收起「正在查找」，按空列表显示(网页版仍可「添加设备…」)
			if (seq !== st.seq || !mounted) return
			st.loaded = true
			renderPorts(st)
		})
	}

	// 动作排队：上一下单击的选用 / 连接(异步)还没做完时，后来的动作等它做完
	function enqueuePort(st, fn) {
		st.queue = st.queue.then(fn).catch(function (e) { console.warn(e) }).then(function () {
			if (mounted) return loadPorts(st)
		})
		return st.queue
	}

	function portRowEl(st, port) {
		const i = st.rows.findIndex(function (r) { return r.port === port })
		return i < 0 ? null : st.list.querySelector('.mdn-port[data-idx="' + i + '"]')
	}

	function renderPorts(st) {
		if (!mounted || !st) return
		const lanes = window.serialLanes
		const A = window.SerialAdapter
		const h = hub()
		if (!lanes || !A || !h) return
		// 改名输入框开着时不重画，免得把输入框连同输入一起冲掉；收起时再画
		if (st.editing) return
		const sid = sidFor(st.key)
		const cur = lanes.portOf(sid)
		const enumerable = A.canEnumerate()
		const laneBusy = !!(cur && (h.isOpen(sid) || h.isOpening(sid) || h.isReleaseFailed(sid)))
		const rows = st.ports.map(function (p) { return { port: p, absent: false } })
		// 本路记着的口不在列表里(已拔出)：灰显在最后，可清除
		if (cur && st.loaded && st.ports.indexOf(cur) === -1) rows.push({ port: cur, absent: true })
		rows.forEach(function (r) {
			const m = lanes.portMeta(r.port)
			const isCur = r.port === cur
			r.meta = m
			r.title = portRowTitle(m)
			r.sub = portRowSub(m)
			r.state = portRowState({
				current: isCur,
				open: isCur && h.isOpen(sid),
				opening: isCur && h.isOpening(sid),
				failed: isCur && h.isReleaseFailed(sid),
				owner: isCur ? null : lanes.portOwner(r.port, sid),
				absent: r.absent,
			})
		})
		// 行的端口对象随时换成最新的(重插给新对象)；签名没变就什么都不动
		st.rows = rows
		const sig = JSON.stringify([sid, enumerable, laneBusy, st.loaded, rows.map(function (r) {
			return [r.absent, r.title, r.sub, !!r.meta.alias, r.meta.defaultName, r.state.kind, r.state.tag]
		})])
		if (sig === st.sig) return
		st.sig = sig
		const hadFocus = st.list.contains(document.activeElement)
		// 行节点按端口对象复用、原地更新：单击连接会改当前设备(签名跟着变)，连点的第二下要落在同一个节点上，
		// 靠 e.detail 认出是连点而不重复动作，节点被换掉的话第二下会落到别的节点上，被当成新的单击
		const reuse = st.rowEls || new Map()
		const keep = new Map()
		let tabRow = null
		rows.forEach(function (r, i) {
			let ent = reuse.get(r.port)
			if (!ent || keep.has(r.port)) {
				const el = mk('div', 'mdn-port')
				el.setAttribute('role', 'option')
				ent = { el: el, sig: '' }
			}
			keep.set(r.port, ent)
			const row = ent.el
			row.dataset.idx = String(i)
			row.dataset.kind = r.state.kind
			row.setAttribute('aria-selected', String(r.port === cur))
			if (r.state.disabled) row.setAttribute('aria-disabled', 'true')
			else row.removeAttribute('aria-disabled')
			row.tabIndex = -1
			row.title = r.title + (r.meta.alias ? '（' + r.meta.defaultName + '）' : '') + (r.state.tag ? ' · ' + r.state.tag : '')
			const csig = JSON.stringify([r.absent, r.title, r.sub, !!r.meta.alias, r.meta.persistent, r.state.tag])
			if (ent.sig !== csig) {
				ent.sig = csig
				row.textContent = ''
				fillPortRow(row, r)
			}
			// 只在位置不对时才移动，移动会让聚焦 / 按下中的行丢掉状态
			const at = st.list.children[i]
			if (at !== row) st.list.insertBefore(row, at || null)
			if (st.focusPort === r.port) tabRow = row
		})
		while (st.list.children.length > rows.length) st.list.lastChild.remove()
		st.rowEls = keep
		if (!tabRow) tabRow = (cur && portRowEl(st, cur)) || st.list.querySelector('.mdn-port')
		if (tabRow) tabRow.tabIndex = 0
		if (tabRow && (hadFocus || st.wantFocus)) tabRow.focus()
		st.wantFocus = false
		st.list.hidden = !rows.length
		st.empty.hidden = !!rows.length
		st.empty.textContent = !st.loaded ? '正在查找串口…'
			: (enumerable ? '未发现串口设备，插入后会自动出现' : '还没有选过串口设备。点「选择串口…」在浏览器的选择框里选择，之后它会一直列在这里')
		st.hint.hidden = !rows.length
		st.hint.textContent = laneBusy ? '单击其它设备即切换过去（先断开当前设备）' : '单击设备即连接'
		st.add.hidden = enumerable
		st.reload.hidden = !enumerable
	}

	// 行的内容(图标、名称、副标题、状态标签、行内动作键)；设备字符串一律 textContent
	function fillPortRow(row, r) {
		const main = mk('div', 'mdn-port-main')
		main.append(mk('div', 'mdn-port-name', r.title))
		if (r.sub) main.append(mk('div', 'mdn-port-sub', r.sub))
		row.append(icon(r.absent ? 'bi-usb-plug mdn-port-icon' : 'bi-usb-symbol mdn-port-icon'), main)
		if (r.state.tag) row.append(mk('span', 'mdn-port-tag', r.state.tag))
		const acts = mk('span', 'mdn-port-acts')
		if (r.absent) {
			const f = btn('mdn-port-act', '', '清除：本路不再记着这台设备')
			f.dataset.act = 'forget'
			f.tabIndex = -1
			f.setAttribute('aria-label', '清除 ' + r.title)
			f.append(icon('bi-x-circle'))
			acts.append(f)
		} else {
			const ren = btn('mdn-port-act', '', r.meta.persistent ? '重命名（保存在本机，下次打开仍显示）' : '重命名（设备无持久标识，仅本次有效）')
			ren.dataset.act = 'rename'
			ren.tabIndex = -1
			ren.setAttribute('aria-label', '重命名 ' + r.title)
			ren.append(icon('bi-pencil'))
			acts.append(ren)
			if (r.meta.alias) {
				const clr = btn('mdn-port-act', '', '清除别名，恢复默认名')
				clr.dataset.act = 'clear'
				clr.tabIndex = -1
				clr.setAttribute('aria-label', '清除别名 ' + r.title)
				clr.append(icon('bi-x-lg'))
				acts.append(clr)
			}
		}
		row.append(acts)
	}

	function rowOf(st, e) {
		const row = e.target.closest ? e.target.closest('.mdn-port') : null
		if (!row || !st.list.contains(row)) return null
		const r = st.rows[Number(row.dataset.idx)]
		return r ? { el: row, r: r } : null
	}

	// 单击 / 回车：选为本路设备并连接。本路正连着别的口就先断开再连(bindSessionPort 一步完成)；
	// 当前设备没连着就连上，已连着或正在连接就不动作(避免误触断开，断开走芯片上的按钮)
	function activatePort(st, r) {
		const lanes = window.serialLanes
		const h = hub()
		if (!lanes || !h || r.state.disabled) return
		const sid = sidFor(st.key)
		const cur = lanes.portOf(sid)
		// 下拉里选定就收起(下拉只负责选口)；完整菜单里的列表保持打开
		const done = function () {
			if (!st.quick) return
			closePops()
			swallowDoubleClick()
		}
		if (r.port === cur) {
			if (!h.isOpen(sid) && !h.isOpening(sid)) enqueuePort(st, function () { return lanes.toggle(sid) })
			done()
			return
		}
		// 关闭失败的口还占着句柄，换设备得先等它释放
		if (cur && h.isReleaseFailed(sid)) return
		enqueuePort(st, function () { return lanes.selectPort(sid, r.port, { open: true }) })
		done()
	}

	function onPortClick(st, e) {
		const hit = rowOf(st, e)
		if (!hit || e.target.closest('input')) return
		const r = hit.r
		const lanes = window.serialLanes
		const sid = sidFor(st.key)
		const act = e.target.closest('.mdn-port-act')
		if (act) {
			e.stopPropagation()
			if (act.dataset.act === 'rename') startPortRename(st, r)
			else if (act.dataset.act === 'clear') enqueuePort(st, function () { return lanes.setAlias(r.port, '') })
			else if (act.dataset.act === 'forget') enqueuePort(st, function () { return lanes.forget(sid) })
			return
		}
		st.focusPort = r.port
		hit.el.focus()
		// 双击的第二下不再重复动作：第一下已经在连了
		if (e.detail > 1) return
		activatePort(st, r)
	}

	function onPortKey(st, e) {
		if (e.target.closest('input')) return
		const rowsEl = Array.prototype.slice.call(st.list.querySelectorAll('.mdn-port'))
		if (!rowsEl.length) return
		const at = rowsEl.indexOf(e.target.closest('.mdn-port'))
		let next = -1
		if (e.key === 'ArrowDown') next = at < 0 ? 0 : Math.min(rowsEl.length - 1, at + 1)
		else if (e.key === 'ArrowUp') next = at < 0 ? 0 : Math.max(0, at - 1)
		else if (e.key === 'Home') next = 0
		else if (e.key === 'End') next = rowsEl.length - 1
		if (next >= 0) {
			e.preventDefault()
			rowsEl.forEach(function (n, i) { n.tabIndex = i === next ? 0 : -1 })
			rowsEl[next].focus()
			const r = st.rows[Number(rowsEl[next].dataset.idx)]
			if (r) st.focusPort = r.port
			return
		}
		if (at < 0) return
		const r = st.rows[Number(rowsEl[at].dataset.idx)]
		if (!r) return
		if (e.key === 'Enter') {
			e.preventDefault()
			activatePort(st, r)
		} else if (e.key === 'F2' && !r.absent) {
			e.preventDefault()
			startPortRename(st, r)
		}
	}

	// 行内改名：名称原位换成输入框，回车 / 失焦保存，Esc 取消；保存走 common.js 的 setPortAlias(留空 = 删除别名)
	function startPortRename(st, r) {
		const lanes = window.serialLanes
		if (st.editing || !lanes || r.absent) return
		const row = portRowEl(st, r.port)
		const nameEl = row ? row.querySelector('.mdn-port-name') : null
		if (!nameEl) return
		const orig = r.meta.alias || ''
		const input = mk('input', 'form-control form-control-sm mdn-port-input')
		input.type = 'text'
		input.maxLength = 32
		input.value = orig
		input.placeholder = r.meta.productName || r.meta.defaultName || ''
		input.setAttribute('aria-label', '设备别名（留空 = 恢复默认名）')
		nameEl.replaceWith(input)
		st.editing = { port: r.port, input: input }
		st.focusPort = r.port
		let done = false
		// refocus：键盘收尾时焦点回到这一行；失焦收尾(点了别处)不抢焦点
		const finish = function (save, refocus) {
			if (done) return
			done = true
			const v = input.value.trim().slice(0, 32)
			st.editing = null
			st.sig = ''
			// 名称节点换成了输入框：这一行的内容要重建(行节点照旧复用)
			const ent = st.rowEls && st.rowEls.get(r.port)
			if (ent) ent.sig = ''
			st.wantFocus = !!refocus
			if (save && v !== orig) enqueuePort(st, function () { return lanes.setAlias(r.port, v) })
			else renderPorts(st)
		}
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') {
				e.preventDefault()
				e.stopPropagation()
				finish(true, true)
			} else if (e.key === 'Escape') {
				// 只取消改名，不关菜单
				e.preventDefault()
				e.stopPropagation()
				finish(false, true)
			}
		})
		// 点到别处(含点到菜单外面、菜单随之关闭)也算保存
		input.addEventListener('blur', function () { finish(true, false) })
		input.focus()
		input.select()
	}

	// 插拔(含没授权过的口出现 / 消失)、授权变化后，开着的那一路菜单重新列口
	function onPortsChanged() {
		if (!mounted || !refs.paths) return
		const p = refs.openKey ? refs.paths[refs.openKey] : null
		if (p && p.ports) loadPorts(p.ports)
		const q = refs.ddKey ? refs.paths[refs.ddKey] : null
		if (q && q.quick) loadPorts(q.quick)
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
		// 串口列表接在芯片下面：芯片仍显示本路设备、状态与连接键，列表负责选口
		main.dev.appendChild(main.ports.box)
		b.dev.appendChild(b.ports.box)
		const A = window.SerialAdapter
		if (A) {
			;['change', 'connect', 'disconnect'].forEach(function (type) {
				A.addEventListener(type, onPortsChanged)
				cleanups.push(function () { A.removeEventListener(type, onPortsChanged) })
			})
		}
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
		const tools = mk('span', 'mdn-conn-tools')
		// 串口预设(单路 / 双路都有)原样搬到「+ B 路」后面：单路下也能直接套双路预设进入双路
		const presetSlot = mk('span', 'mdn-conn-preset')
		cb.append(main.wrap, b.wrap, addB, presetSlot, sendSlot, sep(), tools)
		b.wrap.classList.add('mdn-dual-only')
		park($('serial-dual-preset'), presetSlot)
		if (send) park(send, sendSlot)
		park(bar.querySelector('.connect-bar-proto'), tools)
		cb.appendChild(mk('span', 'mdn-grow'))
		park($('wb-palette-btn'), cb)

		listen(document, 'pointerdown', function (e) {
			const k = refs.openKey || refs.ddKey
			if (!k) return
			const p = refs.paths[k]
			// 改名弹窗等模态层不算「点到外面」
			if (p.wrap.contains(e.target) || e.target.closest('.modal')) return
			closePops()
		}, true)
		listen(document, 'keydown', function (e) {
			const k = refs.openKey || refs.ddKey
			if (e.key !== 'Escape' || !k) return
			const p = refs.paths[k]
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
		// 每路协议键的选项抄顶栏：协议脚本晚于本文件注册时往顶栏补选项
		const topProto = $('serial-protocol-select')
		observe(topProto, { childList: true }, refresh)
		listen(topProto, 'change', refresh)
		;['serial-chip', 'serial-chip-a', 'serial-chip-b', 'serial-status', 'serial-status-a', 'serial-status-b', 'serial-params-summary-text'].forEach(function (id) {
			observe($(id), { attributes: true, childList: true, subtree: true, characterData: true }, refresh)
		})
		observe($('serial-mode-dual'), { attributes: true, attributeFilter: ['class'] }, refresh)
		// 主发切换：协议键的提示跟着说明哪一路决定协议下发
		observe($('serial-active-send'), { attributes: true, subtree: true, attributeFilter: ['class'] }, refresh)
		// 两路参数 / 协议 / 预设套用
		listen(document, 'serial-lane-config', refresh)
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

	function syncProtoSelect(sel, sid) {
		const top = $('serial-protocol-select')
		const lanes = window.serialLanes
		if (!sel || !top) return
		const opts = Array.prototype.map.call(top.options, function (o) { return [o.value, o.textContent] })
		const have = Array.prototype.map.call(sel.options, function (o) { return [o.value, o.textContent] })
		if (JSON.stringify(opts) !== JSON.stringify(have)) {
			sel.textContent = ''
			opts.forEach(function (o) {
				const n = mk('option', '', o[1])
				n.value = o[0]
				sel.appendChild(n)
			})
		}
		const want = lanes ? lanes.protocolOf(sid) : top.value
		if (want && sel.value !== want) sel.value = want
		const h = hub()
		const main = !isDual() || (h && h.activeSendId === sid)
		sel.title = (sid === 'S' ? '协议' : sid + ' 路协议') + '：决定这一路日志的解析' + (main ? '；也是协议下发与测试面板使用的协议' + (isDual() ? '（主发路）' : '') : '')
	}

	function refreshConn() {
		const cb = refs.connbar
		if (!cb) return
		const dual = isDual()
		cb.dataset.mode = dual ? 'dual' : 'single'
		const h = hub()
		const lanes = window.serialLanes
		Object.keys(refs.paths).forEach(function (key) {
			const p = refs.paths[key]
			const sid = sidFor(key)
			// 每路自己的参数；双路两路协议可以不同，按钮上一并写出
			const params = compactParams(lanes ? lanes.summary(sid) : ($('serial-params-summary-text') || {}).textContent)
			p.parCap.textContent = dual ? '本路串口参数' : '串口参数'
			syncProtoSelect(p.proto, sid)
			const chip = chipFor(key)
			const open = h ? h.isOpen(sid) : !!(chip && chip.classList.contains('is-open'))
			const opening = h ? h.isOpening(sid) : false
			const failed = !!(h && h.isReleaseFailed(sid))
			p.wrap.dataset.state = failed ? 'close-failed' : (opening ? 'opening' : (open ? 'open' : 'closed'))
			p.wrap.dataset.sid = sid
			const nameEl = chip ? chip.querySelector('.serial-port-name') : null
			const portName = nameEl ? nameEl.textContent.trim() : ''
			const lbl = sid === 'S' ? '' : (sid === 'B' ? (h ? h.getLabelB() : 'B路') : (h ? h.getLabelA() : 'A路'))
			p.letter.textContent = sid === 'S' ? '' : sid
			// 标签改过才显示(默认就是「A路」「B路」，再写一遍是噪声)
			p.label.textContent = lbl && lbl !== sid + '路' ? lbl : ''
			p.port.textContent = portName || '未选择串口'
			p.params.textContent = params
			const st = failed ? '关闭失败，请重试' : (opening ? '正在连接' : (open ? '已连接' : '未连接'))
			const who = sid === 'S' ? '串口' : sid + ' 路' + (p.label.textContent ? '（' + p.label.textContent + '）' : '')
			p.btn.setAttribute('aria-label', who + ' ' + (portName || '未选择串口') + ' · ' + params + ' · ' + st + ' · 打开菜单')
			p.btn.title = who + ' · ' + st + ' · 选择串口 / 连接断开 / 串口参数' + (sid === 'S' ? '' : ' / 路标签')
			p.head.textContent = sid === 'S' ? '单路串口' : sid + ' 路'
		})
		// 开着的那一路菜单：状态(当前设备 / 已连接 / 被另一路占用)跟着刷新，内容没变不重建
		if (refs.openKey && refs.paths[refs.openKey]) renderPorts(refs.paths[refs.openKey].ports)
		if (refs.ddKey && refs.paths[refs.ddKey]) renderPorts(refs.paths[refs.ddKey].quick)
		// 快捷行上的「发往」分段不在连接栏里，显隐单独跟模式
		if (refs.sendTo) refs.sendTo.hidden = !dual
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
			countLater()
		})
		// 计数要数一遍全部历史行：持续收数据时每批都数一遍太贵，最多每 500ms 数一次
		let countTimer = 0
		const countLater = function () {
			if (r.f.empty || countTimer) return
			countTimer = setTimeout(function () {
				countTimer = 0
				if (mounted) updateFilterCount()
			}, 500)
		}
		cleanups.push(function () { clearTimeout(countTimer); countTimer = 0 })
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
		// 发往哪一路：原来只是显示「→ A路」的指示(#serial-send-target，经典布局由 workbench.js 写，原样留在被隐藏的标题行里)，
		// 现代布局换成可选的分段，只在双路显示
		const sendTo = hostEl(mk('span', 'mdn-send-to mdn-dual-only'), row)
		sendTo.appendChild(mk('span', 'mdn-send-to-cap', '发往'))
		const seg = mk('div', 'ctl-seg mdn-send-seg')
		seg.setAttribute('role', 'group')
		seg.setAttribute('aria-label', '发送到')
		sendTo.appendChild(seg)
		refs.sendTo = sendTo
		refs.sendSeg = seg
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

		// 发往哪一路：与连接栏的「主发」是同一状态，点击转给原主发按钮(钉扎提示等沿用)
		// 发送键搬到开关一排末尾，输入框独占前面，排成设计稿的一行
		park($('serial-send'), body.querySelector('.send-options'))
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
			const name = sid === 'S' ? '单路串口' : (h ? (sid === 'B' ? h.getLabelB() : h.getLabelA()) : sid + '路')
			b.textContent = name
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
	// ========== 6. 日志缩放(列表与时间线共用) ==========
	// 控件半透明浮在日志窗右下角，指针移上去或键盘聚焦时才显实，不挡日志；Ctrl/⌘ + 滚轮(触控板双指捏合)也能缩放。
	// 缩放是给日志容器设 CSS zoom(经 #serial-log-panes 上的变量)，不改行内容，复制、导出、持久化都不受影响
	const ZOOM_KEY = 'serialLogZoomModern'
	function mountLogZoom() {
		const panes = $('serial-log-panes')
		if (!panes) return
		const box = hostEl(mk('div', 'mdn-zoom'), panes)
		box.id = 'mdn-log-zoom'
		box.setAttribute('role', 'group')
		box.setAttribute('aria-label', '日志缩放')
		const out = btn('mdn-zoom-btn', '', '缩小日志')
		out.appendChild(icon('bi-dash'))
		out.setAttribute('aria-label', '缩小日志')
		const val = btn('mdn-zoom-val', '100%', '恢复 100%（也可 Ctrl/⌘ + 滚轮缩放）')
		const inn = btn('mdn-zoom-btn', '', '放大日志')
		inn.appendChild(icon('bi-plus'))
		inn.setAttribute('aria-label', '放大日志')
		box.append(out, val, inn)
		let zoom = 1
		try { zoom = clampZoom(localStorage.getItem(ZOOM_KEY) || 1) } catch (e) {}
		const apply = function (z) {
			zoom = clampZoom(z)
			panes.style.setProperty('--mdn-log-zoom', String(zoom))
			val.textContent = Math.round(zoom * 100) + '%'
			val.setAttribute('aria-label', '日志缩放 ' + val.textContent + '，点击恢复 100%')
			out.disabled = zoom <= ZOOM_MIN
			inn.disabled = zoom >= ZOOM_MAX
			try { localStorage.setItem(ZOOM_KEY, String(zoom)) } catch (e) {}
		}
		apply(zoom)
		listen(out, 'click', function () { apply(stepZoom(zoom, -1)) })
		listen(inn, 'click', function () { apply(stepZoom(zoom, 1)) })
		listen(val, 'click', function () { apply(1) })
		// 触控板捏合是一串很小的 deltaY，攒够一格再走一档；鼠标滚轮一格(约 100)直接一档
		let acc = 0
		listen(panes, 'wheel', function (e) {
			if (!(e.ctrlKey || e.metaKey) || !e.deltaY) return
			e.preventDefault()
			acc += e.deltaY
			if (Math.abs(acc) < 40) return
			apply(stepZoom(zoom, acc < 0 ? 1 : -1))
			acc = 0
		}, { passive: false })
		cleanups.push(function () {
			panes.style.removeProperty('--mdn-log-zoom')
			if (!panes.getAttribute('style')) panes.removeAttribute('style')
		})
	}

	function mount() {
		if (mounted) return
		mounted = true
		refs = {}
		mountRail()
		mountConnBar()
		mountLogBar()
		mountLogZoom()
		mountSendBar()
		if (refs.connbar) refreshConn()
		restyleTextareas()
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
