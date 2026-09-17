// 串口调试工作台：每个工具是一个面板，停靠在右栏或底栏(与协议解析共用)，由最右侧停靠栏开合
// 面板 DOM 原样搬运(不克隆)，面板内控件的 id 与已绑定事件不受影响
// 扩展新工具：Workbench.registerPanel({ id, title, label, icon, el })，el 为面板根节点，其余由本模块接管
;(function () {
	'use strict'

	const STATE_KEY = 'workbenchState'
	// 旧版右栏是 Bootstrap tab，记忆键 activeTab 存的是 tab 按钮 id
	const LEGACY_TAB = {
		'nav-quick-send-tab': 'quick-send',
		'nav-protocol-tab': 'protocol',
		'nav-firmware-tab': 'firmware',
	}
	const DOCKS = ['right', 'bottom']
	const DOCK_NAME = { right: '右侧', bottom: '底部' }

	const panels = []
	const state = loadState()
	let ready = false

	function $(id) { return document.getElementById(id) }

	function loadState() {
		let st = null
		try { st = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') } catch (e) { st = null }
		if (!st || typeof st !== 'object') {
			st = { right: 'quick-send', bottom: 'parse', docks: {} }
			try {
				const legacy = LEGACY_TAB[localStorage.getItem('activeTab')]
				if (legacy) st.right = legacy
				localStorage.removeItem('activeTab')
			} catch (e) { /* 忽略 */ }
		}
		if (!st.docks || typeof st.docks !== 'object') st.docks = {}
		return st
	}

	function saveState() {
		try { localStorage.setItem(STATE_KEY, JSON.stringify(state)) } catch (e) { /* 忽略 */ }
	}

	function find(id) {
		for (let i = 0; i < panels.length; i++) {
			if (panels[i].id === id) return panels[i]
		}
		return null
	}

	function sorted(list) {
		return list.slice().sort(function (a, b) { return a.order - b.order })
	}

	function inDock(dock) {
		return sorted(panels.filter(function (p) { return p.dock === dock }))
	}

	// 两个停靠区的开合沿用 common.js 里已有的右栏拖拽条 / 协议解析面板状态
	function dockApi(dock) {
		return dock === 'right' ? window.serialRightPane : window.parsePanelDock
	}

	function isDockCollapsed(dock) {
		const api = dockApi(dock)
		return api ? api.isCollapsed() : false
	}

	function setDockCollapsed(dock, v) {
		const api = dockApi(dock)
		if (api) api.setCollapsed(v)
	}

	function isAvailable(p) {
		return !p.available || !!p.available()
	}

	function isShown(p) {
		return state[p.dock] === p.id && isAvailable(p) && !isDockCollapsed(p.dock)
	}

	function registerPanel(def) {
		if (!def || !def.id || !def.el || find(def.id)) return null
		const docks = Array.isArray(def.docks) && def.docks.length ? def.docks.filter(function (d) { return DOCKS.indexOf(d) !== -1 }) : DOCKS
		const p = {
			id: def.id,
			title: def.title || def.id,
			label: def.label || def.title || def.id,
			icon: def.icon || 'bi-grid',
			el: def.el,
			order: typeof def.order === 'number' ? def.order : 100 + panels.length,
			docks: docks,
			// fixed: 节点本身就在停靠区里(协议解析)，不搬运
			fixed: !!def.fixed,
			// available: 返回 false 时面板不可打开(如当前协议不支持)，停靠栏按钮禁用
			available: typeof def.available === 'function' ? def.available : null,
			unavailableHint: def.unavailableHint || '',
		}
		const saved = state.docks[p.id]
		if (docks.indexOf(saved) !== -1) p.dock = saved
		else if (docks.indexOf(def.dock) !== -1) p.dock = def.dock
		else p.dock = docks[0]
		p.el.classList.add('wb-pane')
		p.el.dataset.dockPanel = p.id
		panels.push(p)
		if (ready) render()
		return { id: p.id }
	}

	function ensureSerialView() {
		const rail = document.querySelector('.rail-item[data-view="view-serial"]')
		if (rail && !rail.classList.contains('active')) rail.click()
	}

	function open(id) {
		const p = find(id)
		if (!p || !isAvailable(p)) return false
		ensureSerialView()
		state[p.dock] = p.id
		render()
		setDockCollapsed(p.dock, false)
		renderBar()
		return true
	}

	function toggle(id) {
		const p = find(id)
		if (!p) return
		if (isShown(p)) {
			setDockCollapsed(p.dock, true)
			renderBar()
		} else {
			open(id)
		}
	}

	function move(id, dock) {
		const p = find(id)
		if (!p || !isAvailable(p) || p.docks.indexOf(dock) === -1 || p.dock === dock) return
		const from = p.dock
		p.dock = dock
		state.docks[p.id] = dock
		state[dock] = p.id
		render()
		setDockCollapsed(dock, false)
		// 右栏搬空了就收起，免得留一块空白
		if (from === 'right' && !inDock('right').length) setDockCollapsed('right', true)
		renderBar()
	}

	// ---------- 渲染 ----------

	function render() {
		const hosts = { right: $('nav-tabContent'), bottom: $('wb-bottom-body') }
		DOCKS.forEach(function (dock) {
			const list = inDock(dock).filter(isAvailable)
			const has = list.some(function (p) { return p.id === state[dock] })
			if (!has) state[dock] = list.length ? list[0].id : null
		})
		panels.forEach(function (p) {
			if (p.fixed) return
			const host = hosts[p.dock]
			if (host && p.el.parentElement !== host) host.appendChild(p.el)
			const active = state[p.dock] === p.id
			p.el.classList.toggle('active', active)
			p.el.classList.toggle('show', active)
		})
		renderRightHead()
		renderBottomHead()
		renderBar()
		saveState()
	}

	function iconEl(icon) {
		const i = document.createElement('i')
		i.className = 'bi ' + icon
		i.setAttribute('aria-hidden', 'true')
		return i
	}

	function renderRightHead() {
		const title = $('wb-right-title')
		const moveBtn = $('wb-right-move')
		const p = find(state.right)
		if (title) {
			title.textContent = ''
			if (p) title.append(iconEl(p.icon), document.createTextNode(p.title))
		}
		if (moveBtn) moveBtn.hidden = !p || p.docks.indexOf('bottom') === -1
	}

	function renderBottomHead() {
		const box = $('wb-bottom-tabs')
		const panel = $('serial-parse-panel')
		const p = find(state.bottom)
		if (box) {
			box.textContent = ''
			inDock('bottom').filter(isAvailable).forEach(function (q) {
				const b = document.createElement('button')
				b.type = 'button'
				b.className = 'wb-bottom-tab'
				b.dataset.dockPanel = q.id
				b.setAttribute('role', 'tab')
				b.setAttribute('aria-selected', String(q.id === state.bottom))
				b.append(iconEl(q.icon), document.createTextNode(q.title))
				box.appendChild(b)
			})
		}
		const parseActive = !p || p.id === 'parse'
		if (panel) panel.classList.toggle('wb-alt', !parseActive)
		const clearBtn = $('serial-parse-clear')
		if (clearBtn) clearBtn.hidden = !parseActive
		const moveBtn = $('wb-bottom-move')
		if (moveBtn) moveBtn.hidden = !p || p.docks.indexOf('right') === -1
	}

	function renderBar() {
		const bar = $('wb-dock-bar')
		if (!bar) return
		const list = sorted(panels.filter(function (p) { return !p.fixed })).concat(sorted(panels.filter(function (p) { return p.fixed })))
		const sig = list.map(function (p) { return p.id + ':' + p.dock + ':' + isAvailable(p) }).join('|')
		if (bar.dataset.sig !== sig) {
			bar.dataset.sig = sig
			bar.textContent = ''
			list.forEach(function (p, idx) {
				if (p.fixed && idx > 0 && !list[idx - 1].fixed) {
					const sep = document.createElement('div')
					sep.className = 'wb-dock-sep'
					bar.appendChild(sep)
				}
				const b = document.createElement('button')
				b.type = 'button'
				b.className = 'wb-dock-btn'
				b.dataset.dockPanel = p.id
				b.dataset.dock = p.dock
				const ok = isAvailable(p)
				b.disabled = !ok
				b.title = ok ? p.title + '（' + DOCK_NAME[p.dock] + '）' : (p.unavailableHint || p.title + '当前不可用')
				const label = document.createElement('span')
				label.className = 'wb-dock-label'
				label.textContent = p.label
				b.append(iconEl(p.icon), label)
				bar.appendChild(b)
			})
		}
		bar.querySelectorAll('.wb-dock-btn').forEach(function (b) {
			const p = find(b.dataset.dockPanel)
			b.setAttribute('aria-pressed', String(!!(p && isShown(p))))
		})
	}

	// ---------- 内置面板 ----------

	// 独立成面板的卡片：协议不支持时卡片被协议模块隐藏，面板里显示说明
	function standalonePanel(id, title, label, icon, cardId, order, hint) {
		const card = $(cardId)
		if (!card) return
		const pane = document.createElement('div')
		pane.className = 'tab-pane d-flex flex-column wb-pane-scroll'
		pane.id = 'wb-pane-' + id
		pane.setAttribute('role', 'tabpanel')
		const tip = document.createElement('div')
		tip.className = 'wb-pane-unavailable'
		tip.append(iconEl('bi-info-circle'), document.createTextNode(hint))
		pane.append(tip, card)
		registerPanel({
			id: id, title: title, label: label, icon: icon, el: pane, order: order,
			// 协议模块切协议时用 style.display 隐藏不支持的卡片，以此为准
			available: function () { return card.style.display !== 'none' },
			unavailableHint: hint,
		})
		// 协议模块改卡片显隐后同步：禁用按钮，正在显示的面板让位给同停靠区的其它面板
		new MutationObserver(refreshAvailability).observe(card, { attributes: true, attributeFilter: ['style'] })
	}

	function refreshAvailability() {
		if (!ready) return
		const collapse = DOCKS.filter(function (dock) {
			const p = find(state[dock])
			return p && !isAvailable(p) && !isDockCollapsed(dock) && !inDock(dock).some(isAvailable)
		})
		render()
		collapse.forEach(function (dock) { setDockCollapsed(dock, true) })
		renderBar()
	}

	function registerBuiltins() {
		const qs = $('nav-quick-send')
		if (qs) registerPanel({ id: 'quick-send', title: '快捷发送', icon: 'bi-lightning-charge', el: qs, order: 10 })
		const proto = $('nav-protocol')
		if (proto) registerPanel({ id: 'protocol', title: '协议设置与下发', label: '协议', icon: 'bi-braces', el: proto, order: 20 })
		standalonePanel('rw', '随机读写测试', '随机读写', 'bi-shuffle', 'sk-rw-card', 30, '当前协议不支持随机读写测试，在顶栏把协议切换到 SEK 后可用')
		standalonePanel('batch', '批量配置写入', '批量配置', 'bi-list-check', 'sk-batch-card', 40, '当前协议不支持批量配置写入，在顶栏把协议切换到 SEK 后可用')
		const fw = $('nav-firmware')
		if (fw) registerPanel({ id: 'firmware', title: '固件升级', icon: 'bi-cpu', el: fw, order: 50 })
		const parse = $('serial-parse-body')
		if (parse) registerPanel({ id: 'parse', title: '协议解析', label: '解析', icon: 'bi-diagram-3', el: parse, order: 0, docks: ['bottom'], fixed: true })
	}

	// ---------- 顶栏：命令面板入口 ----------

	function initConnectBarTools() {
		const pal = $('wb-palette-btn')
		if (pal) {
			pal.addEventListener('click', function () {
				if (window.serialCommandPalette) window.serialCommandPalette.open()
			})
		}
	}

	// ---------- 状态栏 ----------

	// 后台任务：面板任务以停止键可用视为运行中；循环发送看勾选框
	function panelTask(panel, stopId, progressId, label) {
		return {
			label: label,
			title: '打开' + label + '面板',
			running: function () {
				const stop = $(stopId)
				return !!(stop && !stop.disabled)
			},
			text: function () {
				const prog = $(progressId)
				const txt = prog ? prog.textContent.trim() : ''
				return label + (txt ? ' ' + txt : '') + ' 运行中'
			},
			open: function () { open(panel) },
		}
	}
	const TASKS = [
		panelTask('rw', 'sk-rw-stop', 'sk-rw-progress-bar', '随机读写'),
		panelTask('batch', 'sk-batch-stop', 'sk-batch-progress-bar', '批量配置'),
		panelTask('protocol', 'gz-auto-stop', 'gz-auto-progress-bar', '工位测试'),
		panelTask('firmware', 'fw-stop', 'fw-progress', '固件升级'),
		{
			label: '循环发送',
			title: '定位到串口发送',
			running: function () {
				const cb = $('serial-loop-send')
				return !!(cb && cb.checked)
			},
			text: function () {
				const t = $('serial-loop-send-time')
				return '循环发送 每 ' + (t ? t.value : '?') + ' ms'
			},
			open: function () {
				ensureSerialView()
				if (typeof window.expandSendPanel === 'function') window.expandSendPanel()
				const input = $('serial-send-content')
				if (input) input.focus()
			},
		},
	]

	function fmtBytes(n) {
		if (n < 1024) return n + ' B'
		if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
		return (n / 1024 / 1024).toFixed(2) + ' MB'
	}

	function fmtDuration(ms) {
		const t = Math.max(0, Math.floor(ms / 1000))
		const h = Math.floor(t / 3600)
		const m = Math.floor(t / 60) % 60
		const s = t % 60
		const pad = function (v) { return (v < 10 ? '0' : '') + v }
		return (h ? h + ':' : '') + pad(m) + ':' + pad(s)
	}

	function span(cls, text) {
		const el = document.createElement('span')
		if (cls) el.className = cls
		if (text != null) el.textContent = text
		return el
	}

	const statusRefs = { sig: '', sessions: {}, tasks: [] }

	function buildStatusBar(bar, sids) {
		bar.textContent = ''
		statusRefs.sessions = {}
		const left = span('sb-group')
		sids.forEach(function (sid) {
			const seg = span('sb-session')
			const dot = span('sb-dot')
			const name = span('sb-name')
			const stateEl = span('sb-state')
			const tx = span('sb-num')
			const rx = span('sb-num')
			const txWrap = span('sb-metric')
			txWrap.append(span('sb-k', 'TX'), tx)
			const rxWrap = span('sb-metric')
			rxWrap.append(span('sb-k', 'RX'), rx)
			seg.append(dot, name, stateEl, txWrap, rxWrap)
			left.appendChild(seg)
			statusRefs.sessions[sid] = { seg: seg, name: name, state: stateEl, tx: tx, rx: rx, txWrap: txWrap, rxWrap: rxWrap }
		})
		const tasks = span('sb-group sb-tasks')
		statusRefs.tasks = TASKS.map(function (t, idx) {
			const b = document.createElement('button')
			b.type = 'button'
			b.className = 'sb-task'
			b.hidden = true
			b.dataset.task = String(idx)
			b.title = t.title
			const text = span('', '')
			b.append(span('sb-spin'), text)
			tasks.appendChild(b)
			return { def: t, btn: b, text: text }
		})
		const hint = span('sb-hint')
		hint.append(span('', 'Ctrl/⌘+Enter 发送'), span('', 'Ctrl/⌘+K 命令'))
		bar.append(left, tasks, hint)
	}

	function updateStatusBar() {
		const bar = $('serial-statusbar')
		const hub = window.SerialHub
		if (!bar || !hub || typeof hub.getStats !== 'function') return
		const sids = hub.mode === 'dual' ? ['A', 'B'] : ['S']
		const sig = sids.join(',')
		if (statusRefs.sig !== sig) {
			statusRefs.sig = sig
			buildStatusBar(bar, sids)
		}
		const now = Date.now()
		const logMain = $('log-main')
		if (logMain) logMain.classList.toggle('wb-connected', sids.some(function (sid) { return hub.getStats(sid).open }))
		sids.forEach(function (sid) {
			const r = statusRefs.sessions[sid]
			const st = hub.getStats(sid)
			const label = sid === 'S' ? '串口' : (sid === 'A' ? hub.getLabelA() : hub.getLabelB())
			r.seg.classList.toggle('is-open', !!st.open)
			r.seg.dataset.sid = sid
			r.name.textContent = label
			r.state.textContent = st.open ? fmtDuration(now - st.openedAt) : '未连接'
			const showNums = st.open || st.txBytes > 0 || st.rxBytes > 0
			r.txWrap.hidden = !showNums
			r.rxWrap.hidden = !showNums
			r.tx.textContent = fmtBytes(st.txBytes)
			r.rx.textContent = fmtBytes(st.rxBytes)
		})
		statusRefs.tasks.forEach(function (t) {
			const running = t.def.running()
			t.btn.hidden = !running
			if (running) t.text.textContent = t.def.text()
		})
		// 双路时标出串口发送区当前发往哪个口
		const target = $('serial-send-target')
		if (target) {
			const dual = hub.mode === 'dual'
			target.hidden = !dual
			if (dual) {
				const sid = hub.activeSendPhys()
				target.textContent = '→ ' + (sid === 'S' ? '单路串口' : (sid === 'B' ? hub.getLabelB() : hub.getLabelA()))
				target.dataset.sid = sid
			}
		}
	}

	// ---------- 初始化 ----------

	function init() {
		registerBuiltins()
		ready = true
		render()
		// 右栏没有面板时不保留空栏
		if (!inDock('right').length) setDockCollapsed('right', true)

		const bar = $('wb-dock-bar')
		if (bar) {
			bar.addEventListener('click', function (e) {
				const b = e.target.closest('.wb-dock-btn')
				if (b) toggle(b.dataset.dockPanel)
			})
		}
		const tabs = $('wb-bottom-tabs')
		if (tabs) {
			tabs.addEventListener('click', function (e) {
				const b = e.target.closest('.wb-bottom-tab')
				if (b) open(b.dataset.dockPanel)
			})
		}
		const on = function (id, fn) {
			const el = $(id)
			if (el) el.addEventListener('click', fn)
		}
		on('wb-right-close', function () { setDockCollapsed('right', true); renderBar() })
		on('wb-right-move', function () { move(state.right, 'bottom') })
		on('wb-bottom-close', function () { setDockCollapsed('bottom', true); renderBar() })
		on('wb-bottom-move', function () { move(state.bottom, 'right') })
		const sb = $('serial-statusbar')
		if (sb) {
			sb.addEventListener('click', function (e) {
				const b = e.target.closest('.sb-task')
				const def = b && TASKS[Number(b.dataset.task)]
				if (def) def.open()
			})
		}

		// 拖拽条 / 解析面板标题栏 / 命令面板也会开合停靠区，按钮高亮跟着走
		const watch = new MutationObserver(function () { renderBar() })
		const main = $('main')
		const parsePanel = $('serial-parse-panel')
		if (main) watch.observe(main, { attributes: true, attributeFilter: ['class'] })
		if (parsePanel) watch.observe(parsePanel, { attributes: true, attributeFilter: ['class'] })

		initConnectBarTools()
		updateStatusBar()
		setInterval(function () {
			if (document.hidden) return
			const view = $('view-serial')
			if (view && !view.classList.contains('active')) return
			updateStatusBar()
		}, 1000)
	}

	window.Workbench = {
		registerPanel: registerPanel,
		open: open,
		toggle: toggle,
		move: move,
		isShown: function (id) {
			const p = find(id)
			return !!(p && isShown(p))
		},
		list: function () {
			return sorted(panels).map(function (p) {
				return { id: p.id, title: p.title, dock: p.dock, docks: p.docks.slice(), shown: isShown(p), available: isAvailable(p) }
			})
		},
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init)
	} else {
		init()
	}
})()
