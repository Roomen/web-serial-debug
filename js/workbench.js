// 串口调试工作台：每个工具是一个面板，停靠在右栏或底栏(与协议解析共用)，由最右侧停靠栏开合
// 面板 DOM 原样搬运(不克隆)，面板内控件的 id 与已绑定事件不受影响
// 扩展新工具：Workbench.registerPanel({ id, title, label, icon, el })，el 为面板根节点，其余由本模块接管
;(function () {
	'use strict'

	const STATE_KEY = 'workbenchState'
	// 现代布局的面板分布另存，不写经典布局的 workbenchState
	const MODERN_STATE_KEY = 'workbenchStateModern'
	// 旧版右栏是 Bootstrap tab，记忆键 activeTab 存的是 tab 按钮 id
	const LEGACY_TAB = {
		'nav-quick-send-tab': 'quick-send',
		'nav-protocol-tab': 'protocol',
		'nav-firmware-tab': 'firmware',
	}
	const DOCKS = ['right', 'bottom']
	const DOCK_NAME = { right: '右侧', bottom: '底部' }

	const panels = []
	// 当前生效的是哪套布局的面板配置；与 html[data-layout] 同步，由 serial-layout-move 事件切换
	let modern = document.documentElement.dataset.layout === 'modern'
	let state = loadState(modern)
	let ready = false

	function $(id) { return document.getElementById(id) }

	function loadState(forModern) {
		if (forModern) return loadModernState()
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

	// 现代布局没存过时从经典布局的分布起步(只读不写经典键)；解析在现代布局里固定是右栏的检查器
	function loadModernState() {
		let st = null
		try { st = JSON.parse(localStorage.getItem(MODERN_STATE_KEY) || 'null') } catch (e) { st = null }
		if (!st || typeof st !== 'object') {
			let base = null
			try { base = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') } catch (e) { base = null }
			st = { right: 'parse', bottom: null, docks: {} }
			if (base && base.docks && typeof base.docks === 'object') {
				Object.keys(base.docks).forEach(function (id) {
					if (id !== 'parse' && id !== 'firmware') st.docks[id] = base.docks[id]
				})
			}
		}
		if (!st.docks || typeof st.docks !== 'object') st.docks = {}
		return st
	}

	function saveState() {
		try { localStorage.setItem(modern ? MODERN_STATE_KEY : STATE_KEY, JSON.stringify(state)) } catch (e) { /* 忽略 */ }
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

	// hidden: 当前布局下不进停靠区的面板(现代布局的固件升级并进了固件页)
	function inDock(dock) {
		return sorted(panels.filter(function (p) { return p.dock === dock && !p.hidden }))
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
		return !p.hidden && (!p.available || !!p.available())
	}

	function isShown(p) {
		return state[p.dock] === p.id && isAvailable(p) && !isDockCollapsed(p.dock)
	}

	function registerPanel(def) {
		if (!def || !def.id || !def.el || find(def.id)) return null
		const docks = Array.isArray(def.docks) && def.docks.length ? def.docks.filter(function (d) { return DOCKS.indexOf(d) !== -1 }) : DOCKS
		// base 是经典布局下的面板定义；现代布局按 MODERN_PROFILE 覆盖其中几项(见 applyProfile)
		const base = {
			title: def.title || def.id,
			label: def.label || def.title || def.id,
			icon: def.icon || 'bi-grid',
			el: def.el,
			order: typeof def.order === 'number' ? def.order : 100 + panels.length,
			docks: docks,
			defDock: def.dock,
			// fixed: 节点本身就在停靠区里(协议解析)，不搬运
			fixed: !!def.fixed,
			hidden: false,
			view: '',
		}
		const p = {
			id: def.id,
			base: base,
			// available: 返回 false 时面板不可打开(如当前协议不支持)，停靠栏按钮禁用
			available: typeof def.available === 'function' ? def.available : null,
			unavailableHint: def.unavailableHint || '',
			// 进入现代布局时面板节点原位置的占位(注释节点)，切回经典时原样放回
			ph: null,
		}
		def.el.classList.add('wb-pane')
		def.el.dataset.dockPanel = p.id
		panels.push(p)
		applyProfile(p)
		// 现代布局下才注册的面板：节点若已在文档里，先在原位置留占位，切回经典时放回
		if (modern) markOrigin(p)
		if (ready) render()
		return { id: p.id }
	}

	// 按当前布局把面板的生效属性(节点、标题、可停靠位置、停靠位置等)从 base / 现代覆盖项里取出来
	function applyProfile(p) {
		const over = modern && MODERN_PROFILE[p.id] ? MODERN_PROFILE[p.id]() : null
		const o = over ? Object.assign({}, p.base, over) : p.base
		p.el = o.el
		p.title = o.title
		p.label = o.label
		p.icon = o.icon
		p.order = o.order
		p.docks = o.docks
		p.fixed = o.fixed
		p.hidden = o.hidden
		p.view = o.view
		const saved = state.docks[p.id]
		if (p.docks.indexOf(saved) !== -1) p.dock = saved
		else if (p.docks.indexOf(o.defDock) !== -1) p.dock = o.defDock
		else p.dock = p.docks[0]
	}

	function markOrigin(p) {
		const el = p.base.el
		if (p.base.fixed || p.ph || !el.parentNode) return
		p.ph = document.createComment('wb-origin:' + p.id)
		el.parentNode.insertBefore(p.ph, el)
	}

	function ensureSerialView() {
		const rail = document.querySelector('.rail-item[data-view="view-serial"]')
		if (rail && !rail.classList.contains('active')) rail.click()
	}

	function open(id) {
		const p = find(id)
		// 当前布局里放在别的视图上的面板(现代布局的固件升级在固件页)：切到那个视图
		if (p && p.hidden && p.view) {
			const rail = document.querySelector('.rail-item[data-view="' + p.view + '"]')
			if (rail && !rail.classList.contains('active')) rail.click()
			if (p.el.scrollIntoView) p.el.scrollIntoView({ block: 'nearest' })
			return true
		}
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
			if (p.fixed || p.hidden) return
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
		if (panel) {
			panel.classList.toggle('wb-alt', !parseActive)
			// 现代布局解析搬去了右栏检查器：底栏没有面板时整条收掉，不留空壳
			panel.classList.toggle('wb-bottom-none', modern && !inDock('bottom').some(isAvailable))
		}
		const clearBtn = $('serial-parse-clear')
		// 现代布局的清空键在检查器里，始终可用
		if (clearBtn) clearBtn.hidden = modern ? false : !parseActive
		const moveBtn = $('wb-bottom-move')
		if (moveBtn) moveBtn.hidden = !p || p.docks.indexOf('right') === -1
	}

	function renderBar() {
		const bar = $('wb-dock-bar')
		if (!bar) return
		const live = panels.filter(function (p) { return !p.hidden })
		const list = sorted(live.filter(function (p) { return !p.fixed })).concat(sorted(live.filter(function (p) { return p.fixed })))
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
		{
			// 只在现代布局的状态栏显示(经典布局状态栏保持原样)：STS 模拟启动键按下即运行/等待中
			label: 'STS 模拟',
			title: '打开 STS 模拟面板',
			modernOnly: true,
			running: function () {
				return !!document.querySelector('.sts-sim-head > .ctl-toggle[aria-pressed="true"]')
			},
			text: function () {
				const n = document.querySelectorAll('.sts-sim-head > .ctl-toggle[aria-pressed="true"]').length
				return 'STS 模拟' + (n > 1 ? ' ×' + n : '') + ' 运行中'
			},
			open: function () { open('sts-sim') },
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
			const lastRx = span('sb-last-rx')
			const rebuild = document.createElement('button')
			rebuild.type = 'button'
			rebuild.className = 'sb-receive-reset'
			rebuild.textContent = '重建接收'
			rebuild.title = '释放并重新打开此串口'
			rebuild.addEventListener('click', async function () {
				if (rebuild.disabled || !window.serialApi) return
				rebuild.disabled = true
				try { await window.serialApi.rebuildReceive(sid) }
				finally { updateStatusBar() }
			})
			seg.append(dot, name, stateEl, txWrap, rxWrap, lastRx, rebuild)
			left.appendChild(seg)
			statusRefs.sessions[sid] = { seg: seg, name: name, state: stateEl, tx: tx, rx: rx, txWrap: txWrap, rxWrap: rxWrap, lastRx: lastRx, rebuild: rebuild }
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
			r.lastRx.hidden = !st.open
			if (st.open) {
				const age = st.lastRxAt ? '上次接收 ' + Math.max(0, Math.floor((now - st.lastRxAt) / 1000)) + 's 前' : '未收到'
				r.lastRx.textContent = age + (st.receivePaused ? ' · 接收暂缓' : '')
			}
			r.rebuild.disabled = !st.open || hub.isOpening(sid)
			r.rebuild.setAttribute('aria-label', label + '：重建接收')
		})
		statusRefs.tasks.forEach(function (t) {
			const running = (modern || !t.def.modernOnly) && t.def.running()
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

	// ---------- 现代布局 ----------
	// 经典布局的 DOM 是基准：现代布局只把节点原样搬到新位置(不克隆，事件绑定与控件状态跟着节点走)，
	// 搬之前在原位置留注释占位，切回经典时按占位放回，新建的宿主节点随之删掉，经典布局的 DOM 与进入前一致

	// 现代布局对面板定义的覆盖：解析变成右栏第一个标签「检查器」，固件升级并进固件打包页
	const MODERN_PROFILE = {
		parse: function () {
			return { el: inspectorEl(), title: '检查器', label: '检查器', icon: 'bi-search', order: -1, docks: ['right'], defDock: 'right', fixed: false }
		},
		firmware: function () {
			return { hidden: true, view: 'view-fw-pack' }
		},
	}

	let inspector = null
	let parked = []
	let hosts = []

	function mk(tag, cls, text) {
		const n = document.createElement(tag)
		if (cls) n.className = cls
		if (text != null) n.textContent = text
		return n
	}

	function inspectorEl() {
		if (inspector) return inspector.pane
		const pane = mk('div', 'tab-pane d-flex flex-column wb-pane wb-inspector')
		pane.id = 'wb-pane-inspector'
		pane.setAttribute('role', 'tabpanel')
		pane.dataset.dockPanel = 'parse'
		const bar = mk('div', 'wb-inspector-bar')
		const tools = mk('span', 'wb-inspector-tools')
		bar.append(mk('span', 'wb-inspector-hint', '点选日志行即解析该行'), tools)
		const actions = mk('div', 'wb-inspector-actions')
		actions.setAttribute('role', 'group')
		actions.setAttribute('aria-label', '基于此帧')
		const resend = mk('button', 'btn btn-sm btn-outline-secondary')
		resend.type = 'button'
		resend.id = 'wb-frame-resend'
		resend.append(iconEl('bi-arrow-repeat'), document.createTextNode(' 重发此帧'))
		const save = mk('button', 'btn btn-sm btn-outline-secondary')
		save.type = 'button'
		save.id = 'wb-frame-save'
		save.append(iconEl('bi-lightning-charge'), document.createTextNode(' 存为快捷发送'))
		actions.append(mk('span', 'wb-inspector-actions-title', '基于此帧'), resend, save)
		// 结构化视图由 js/modern-inspector.js 往 view 里画；原协议解析面板(HEX 输入区 + 输出)放进可折叠的「原始输出」
		const view = mk('div', 'wb-insp-view')
		view.id = 'wb-insp-view'
		view.tabIndex = -1
		const raw = mk('details', 'wb-insp-raw')
		raw.id = 'wb-insp-raw'
		raw.appendChild(mk('summary', 'wb-insp-raw-sum', '原始输出 / 手动粘贴 HEX'))
		const rawBody = mk('div', 'wb-insp-raw-body')
		raw.appendChild(rawBody)
		pane.append(bar, view, actions, raw)
		resend.addEventListener('click', async function () {
			const api = window.serialFrameActions
			if (!api || resend.disabled) return
			// 口没开时 writeRaw 自己记错误行/弹提示，这里只兜住异常
			try { await api.resend() } catch (e) { /* 已由串口层提示 */ }
		})
		save.addEventListener('click', function () {
			const api = window.serialFrameActions
			if (api && !save.disabled) api.saveQuick()
			syncFrameActions()
		})
		inspector = { pane: pane, tools: tools, actions: actions, resend: resend, save: save, view: view, rawBody: rawBody }
		return pane
	}

	// 「基于此帧」按钮跟着日志选中行走：重发只认 TX 行
	function syncFrameActions() {
		if (!modern || !inspector) return
		const api = window.serialFrameActions
		const f = api ? api.selected() : null
		inspector.resend.disabled = !f || f.dir !== 'tx'
		inspector.save.disabled = !f
		inspector.resend.title = !f ? '先在日志里点选一行' : (f.dir === 'tx' ? '把这一帧原样发到当前主发口（不追加 CRLF）' : '只有发送(TX)行可以重发')
		inspector.save.title = f ? '把这一帧的 HEX 加入当前快捷发送分组' : '先在日志里点选一行'
	}

	function park(node, parent, before) {
		if (!node || !node.parentNode || !parent) return
		const ph = document.createComment('layout-origin:' + (node.id || node.className))
		node.parentNode.insertBefore(ph, node)
		parked.push([node, ph])
		parent.insertBefore(node, before || null)
	}

	function host(tag, id, cls) {
		const n = mk(tag, cls)
		n.id = id
		hosts.push(n)
		return n
	}

	function mountModern() {
		const views = $('views')
		// S1/S2：连接条、状态栏挪到三个视图共用的全局顶栏/底栏(#app-shell 的网格行)
		if (views) {
			const top = host('div', 'app-topbar')
			const bottom = host('div', 'app-statusbar')
			views.before(top)
			views.after(bottom)
			park($('serial-connect-bar'), top)
			park($('serial-statusbar'), bottom)
		}
		// S3：解析正文与锁定/清空进检查器
		inspectorEl()
		park($('serial-parse-lock'), inspector.tools)
		park($('serial-parse-clear'), inspector.tools)
		park($('serial-parse-body'), inspector.rawBody)
		// S4：固件升级面板放进固件打包页(原位置的占位由面板自己的 ph 负责)
		const fwView = $('view-fw-pack')
		const fw = find('firmware')
		if (fwView && fw) {
			const sec = host('section', 'fw-pack-upgrade', 'fw-pack-upgrade')
			sec.setAttribute('aria-label', '固件升级')
			const head = mk('div', 'fw-pack-upgrade-head')
			head.append(iconEl('bi-cpu'), mk('span', 'fw-pack-upgrade-title', '固件升级'), mk('span', 'view-bar-sub', '经顶部串口连接收发'))
			sec.appendChild(head)
			fwView.appendChild(sec)
			sec.appendChild(fw.base.el)
		}
	}

	function unmountModern() {
		parked.reverse().forEach(function (pair) { pair[1].replaceWith(pair[0]) })
		parked = []
		panels.forEach(function (p) {
			if (p.ph) {
				p.ph.replaceWith(p.base.el)
				p.ph = null
			} else if (!p.base.fixed && p.base.el.parentNode) {
				// 现代布局下才进文档的面板：拿掉，交给经典布局的 render 按注册顺序挂回，与直接以经典布局打开时一致
				p.base.el.remove()
			}
		})
		hosts.forEach(function (n) { n.remove() })
		hosts = []
		if (inspector) inspector.pane.remove()
	}

	// 进入现代布局前记下经典布局各节点的 class 原文：切回后若类名集合没变、只是 toggle 让顺序变了，按原文写回，
	// 让经典布局的 DOM 与进入前逐字一致(集合变了说明是用户在现代布局里的操作结果，不动)
	let classSnap = null

	function snapClasses() {
		const shell = $('app-shell')
		if (!shell) return
		classSnap = new Map()
		classSnap.set(shell, shell.getAttribute('class'))
		shell.querySelectorAll('*').forEach(function (n) { classSnap.set(n, n.getAttribute('class')) })
	}

	function restoreClassOrder() {
		if (!classSnap) return
		const tokens = function (v) { return (v || '').split(/\s+/).filter(Boolean).sort().join(' ') }
		classSnap.forEach(function (cls, n) {
			const now = n.getAttribute('class')
			if (now === cls || !n.isConnected || tokens(now) !== tokens(cls)) return
			if (cls == null) n.removeAttribute('class')
			else n.setAttribute('class', cls)
		})
		classSnap = null
	}

	function setModern(next) {
		next = !!next
		if (next === modern) return
		if (next) {
			snapClasses()
			panels.forEach(markOrigin)
			modern = true
			state = loadState(true)
			panels.forEach(applyProfile)
			mountModern()
		} else {
			unmountModern()
			modern = false
			state = loadState(false)
			panels.forEach(applyProfile)
		}
		render()
		syncFrameActions()
		updateStatusBar()
	}

	// ---------- 初始化 ----------

	function init() {
		registerBuiltins()
		// 以现代布局打开：面板已按现代覆盖项注册(原位置占位也已留好)，这里只搬非面板节点
		if (modern) mountModern()
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
		// 复用后台任务/连接状态的现有 1s 刷新，不另建接收计时器。
		// 现代布局的状态栏是三个视图共用的，不在串口视图时也要刷新
		setInterval(function () {
			if (document.hidden) return
			const view = $('view-serial')
			if (!modern && view && !view.classList.contains('active')) return
			updateStatusBar()
			syncFrameActions()
		}, 1000)

		document.addEventListener('serial-layout-move', function (e) {
			setModern(e.detail && e.detail.layout === 'modern')
		})
		// 停靠区开合/宽高由 common.js 在 serial-layout-change 里重放(先于这里注册)，之后再统一还原类名顺序
		document.addEventListener('serial-layout-change', function () {
			if (!modern) restoreClassOrder()
		})
		document.addEventListener('serial-log-select', syncFrameActions)
		syncFrameActions()
	}

	window.Workbench = {
		refreshStatus: function () { if (ready) updateStatusBar() },
		// 现代布局检查器里放结构化视图的节点(还没建过时为 null)
		inspectorView: function () { return inspector ? inspector.view : null },
		registerPanel: registerPanel,
		open: open,
		toggle: toggle,
		move: move,
		isShown: function (id) {
			const p = find(id)
			return !!(p && isShown(p))
		},
		list: function () {
			return sorted(panels.filter(function (p) { return !p.hidden })).map(function (p) {
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
