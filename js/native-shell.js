// 桌面客户端(Tauri 2)的页面侧外壳胶水：只在 AppPlatform 判定为 tauri 运行时生效，网页版什么也不做。
// 1. 下载提示：页面的导出、固件产物都是 <a download> + blob，Rust 端(desktop/src-tauri/src/lib.rs)存进系统「下载」目录后派发 app-download，
//    这里提示保存位置并给「在访达中显示」(WebView 没有下载栏，不提示用户就不知道文件去哪了)。
// 2. 原生菜单：Rust 端(menu.rs)把菜单动作以 app-menu 事件发给聚焦窗口，这里按 id 点原控件或调现有 API，不另写业务；当前视图做不了就安静忽略。
//    菜单的勾选 / 可用状态与窗口标题由这里定时报回(menu_sync / setTitle)。
// 3. 去网页味：macOS 一体化标题栏的拖动与双击、页面默认右键菜单换成日志区的自定义菜单、拦住没人接的文件拖放与整页捏合缩放。
;(function (root) {
	'use strict'
	const P = root.AppPlatform
	const T = root.__TAURI__
	if (!P || P.runtime !== 'tauri' || !T || !T.event || !T.core) return

	const doc = document
	const $ = function (id) { return doc.getElementById(id) }
	const win = T.window && T.window.getCurrentWindow ? T.window.getCurrentWindow() : null
	// 页面只认平台服务，更新插件与原生事件都封装在桌面组装点。
	let updatePreparing = false
	P.provide('app-update', {
		check: function () { return T.core.invoke('app_update_check') },
		install: function (version) { return T.core.invoke('app_update_install', { version: version }) },
		ack: function (operationId, ready, session) { return T.core.invoke('app_update_ack', { operationId: operationId, ready: ready, session: session || {} }) },
		listen: function (name, cb) { return T.event.listen(name, function (e) { cb(e.payload || {}) }) },
		isPreparing: function () { return updatePreparing },
		setPreparing: function (value) { updatePreparing = !!value },
	})

	// ---------- 提示条 ----------
	let timer = 0
	function notify(text, isError, action) {
		let tip = $('native-toast')
		if (!tip) {
			tip = doc.createElement('div')
			tip.id = 'native-toast'
			tip.setAttribute('role', 'status')
			tip.addEventListener('click', function (e) {
				const b = e.target.closest('button[data-act]')
				if (b && tip._act) tip._act()
				tip.classList.remove('is-show')
			})
			doc.body.appendChild(tip)
		}
		tip.className = 'serial-toast native-toast' + (isError ? ' is-error' : '')
		tip.textContent = ''
		tip.title = '点击关闭'
		tip.appendChild(doc.createElement('span')).textContent = text
		tip._act = action ? action.run : null
		if (action) {
			const b = doc.createElement('button')
			b.type = 'button'
			b.className = 'native-toast-act'
			b.dataset.act = '1'
			b.textContent = action.label
			tip.appendChild(b)
		}
		tip.classList.remove('is-show')
		void tip.offsetWidth
		tip.classList.add('is-show')
		clearTimeout(timer)
		timer = setTimeout(function () { tip.classList.remove('is-show') }, action ? 8000 : 4000)
	}

	function reveal(path) {
		const o = T.opener
		const p = o && o.revealItemInDir ? o.revealItemInDir(path) : T.core.invoke('plugin:opener|reveal_item_in_dir', { paths: [path] })
		Promise.resolve(p).catch(function (e) { notify('无法打开所在文件夹：' + (e && e.message ? e.message : e), true) })
	}

	T.event.listen('app-download', function (e) {
		const p = e && e.payload ? e.payload : {}
		const path = String(p.path || '')
		const name = path.split(/[\\/]/).pop()
		if (p.success === false) notify('保存失败' + (name ? '：' + name : ''), true)
		else notify('已保存到「下载」' + (name ? '：' + name : ''), false, path ? { label: P.os === 'macos' ? '在访达中显示' : '在资源管理器中显示', run: function () { reveal(path) } } : null)
	})

	// ---------- 原生菜单 → 页面动作 ----------
	function currentView() {
		const a = doc.querySelector('#activity-rail .rail-item.active[data-view]')
		return a ? a.getAttribute('data-view') : ''
	}
	function inSerial() { return currentView() === 'view-serial' }
	function hub() { return root.SerialHub || null }
	function mainSid() {
		const h = hub()
		return h ? h.activeSendPhys() : 'S'
	}
	function shown(el) { return !!(el && el.getClientRects().length) }
	function click(el) {
		if (el && !el.disabled) el.click()
	}
	function gotoView(id) {
		const r = doc.querySelector('#activity-rail .rail-item[data-view="' + id + '"]')
		if (shown(r) && !r.classList.contains('active')) r.click()
	}
	// 打开某一路的连接菜单(现代布局连接栏)；没有连接栏时退回该路的「选择串口」键
	function openLaneMenu(sid) {
		const b = doc.querySelector('#mdn-connbar .mdn-conn[data-sid="' + sid + '"] > .mdn-conn-more')
		if (b) {
			if (b.getAttribute('aria-expanded') !== 'true') b.click()
			return
		}
		click($(sid === 'S' ? 'serial-select-port' : 'serial-select-port-' + sid.toLowerCase()))
	}
	function toggleConnect() {
		const sid = mainSid()
		const t = $(sid === 'S' ? 'serial-open-or-close' : 'serial-open-or-close-' + sid.toLowerCase())
		// 没选过设备时连接键是隐藏的：转成打开这一路的菜单去选口
		if (t && !t.hidden) t.click()
		else openLaneMenu(sid)
	}
	function zoomBtn(which) {
		const box = $('mdn-log-zoom')
		if (!box || !shown(box)) return null
		if (which === 'reset') return box.querySelector('.mdn-zoom-val')
		const bs = box.querySelectorAll('.mdn-zoom-btn')
		return which === 'out' ? bs[0] : bs[bs.length - 1]
	}
	function railLink(issues) {
		const links = doc.querySelectorAll('#activity-rail .rail-bottom > a.rail-item[href]')
		for (let i = 0; i < links.length; i++) {
			if ((links[i].getAttribute('href').indexOf('/issues') !== -1) === issues) return links[i].href
		}
		return ''
	}
	function openExternal(url) {
		if (!url) return
		const o = T.opener
		const p = o && o.openUrl ? o.openUrl(url) : T.core.invoke('plugin:opener|open_url', { url: url })
		Promise.resolve(p).catch(function (e) { console.warn('打开链接失败', e) })
	}
	function openPrefs() {
		const b = $('rail-config-btn')
		if (!b || !shown(b)) return
		if (root.bootstrap && root.bootstrap.Dropdown) root.bootstrap.Dropdown.getOrCreateInstance(b).show()
		else b.click()
	}

	const ACTIONS = {
		'check-update': function () { if (root.AppUpdate) root.AppUpdate.check(true) },
		'preferences': openPrefs,
		'save-log': function () { if (inSerial()) click($('serial-save')) },
		'find-log': function () {
			const f = $('mdn-log-filter')
			if (!inSerial() || !shown(f) || f.disabled) return
			f.focus()
			f.select()
		},
		'toggle-connect': toggleConnect,
		'pick-port': function () { openLaneMenu(mainSid()) },
		'send': function () { if (inSerial()) click($('serial-send')) },
		'clear-log': function () { if (inSerial()) click($('serial-clear')) },
		'auto-scroll': function () { if (inSerial()) click($('serial-auto-scroll')) },
		'view-serial': function () { gotoView('view-serial') },
		'view-firmware': function () { gotoView('view-fw-pack') },
		'view-power': function () { gotoView('view-blu') },
		'command-palette': function () { if (root.serialCommandPalette) root.serialCommandPalette.toggle() },
		'toggle-right-pane': function () {
			const r = root.serialRightPane
			if (inSerial() && r) r.setCollapsed(!r.isCollapsed())
		},
		'log-zoom-in': function () { if (inSerial()) click(zoomBtn('in')) },
		'log-zoom-out': function () { if (inSerial()) click(zoomBtn('out')) },
		'log-zoom-reset': function () { if (inSerial()) click(zoomBtn('reset')) },
		'theme-auto': function () { if (root.setThemeChoice) root.setThemeChoice('auto') },
		'theme-light': function () { if (root.setThemeChoice) root.setThemeChoice('light') },
		'theme-dark': function () { if (root.setThemeChoice) root.setThemeChoice('dark') },
		'help-feedback': function () { openExternal(railLink(true)) },
		'help-homepage': function () { openExternal(railLink(false)) },
	}

	// 页面自己也认的快捷键(发送框的 ⌘/Ctrl+Enter、命令面板的 ⌘/Ctrl+K)：WebView 可能先把按键交给页面再交给菜单，
	// 页面已经处理过的就不再执行一遍。prevented: 只有页面 preventDefault 了才算处理过(发送键只在发送框里生效)
	const PAGE_KEYS = {
		'send': { test: function (e) { return e.key === 'Enter' && (e.metaKey || e.ctrlKey) }, prevented: true },
		// 只认不带 Shift / Alt 的 ⌘/Ctrl+K(与 command-palette.js 一致)；⇧⌘K 是清空日志，页面不处理
		'command-palette': { test: function (e) { return (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey }, prevented: false },
	}
	let lastKey = null
	let lastKeyAt = 0
	root.addEventListener('keydown', function (e) {
		lastKey = e
		lastKeyAt = Date.now()
	}, true)
	function handledByPage(id) {
		const k = PAGE_KEYS[id]
		if (!k || !lastKey || Date.now() - lastKeyAt > 400 || !k.test(lastKey)) return false
		return k.prevented ? lastKey.defaultPrevented : true
	}

	T.event.listen('app-menu', function (e) {
		const id = String(e && e.payload != null ? e.payload : '')
		const fn = ACTIONS[id]
		// 页内对话框(js/app-dialog.js)开着时它是模态：菜单动作一律不执行，免得在确认框背后点了后台控件
		const dlg = root.AppDialog
		const modal = !!(dlg && dlg.isOpen && dlg.isOpen())
		try {
			if (fn && !modal && !updatePreparing && !handledByPage(id)) fn()
		} finally {
			// 勾选项被点后菜单自己翻了勾，以页面状态为准再报一次
			setTimeout(function () { syncMenu(true) }, 60)
		}
	})

	// ---------- 菜单状态 / 窗口标题 ----------
	let lastSync = ''
	function syncMenu(force) {
		if (!doc.hasFocus() && !force) return
		const h = hub()
		const auto = $('serial-auto-scroll')
		const state = {
			serialView: inSerial(),
			connected: !!(h && h.isOpen(mainSid())),
			autoScroll: !!(auto && auto.getAttribute('aria-pressed') === 'true'),
			theme: root.getThemeChoice ? root.getThemeChoice() : 'auto',
		}
		const sig = JSON.stringify(state)
		if (!force && sig === lastSync) return
		lastSync = sig
		T.core.invoke('menu_sync', { state: state }).catch(function () {})
	}

	let lastTitle = ''
	function portName(chipId) {
		const chip = $(chipId)
		const n = chip && !chip.classList.contains('is-empty') ? chip.querySelector('.serial-port-name') : null
		return n ? n.textContent.trim() : ''
	}
	function syncTitle() {
		if (!win || !win.setTitle) return
		const h = hub()
		let desc = ''
		if (h && h.mode === 'dual') {
			const a = portName('serial-chip-a')
			const b = portName('serial-chip-b')
			if (a || b) desc = h.getLabelA() + ' ' + (a || '未选择') + ' · ' + h.getLabelB() + ' ' + (b || '未选择')
		} else {
			desc = portName('serial-chip')
		}
		const title = 'Serial Debug' + (desc ? ' — ' + desc : '')
		if (title === lastTitle) return
		lastTitle = title
		win.setTitle(title).catch(function () {})
	}

	function tick() {
		syncMenu(false)
		syncTitle()
	}
	setInterval(tick, 1000)
	root.addEventListener('focus', function () { syncMenu(true) })
	if (win && win.onFocusChanged) win.onFocusChanged(function (e) { if (e && e.payload) syncMenu(true) })
	if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', tick)
	else tick()

	// ---------- macOS 一体化标题栏：左侧导航栏与顶栏的空白处拖动窗口，双击按系统设置缩放 / 最小化 ----------
	const INTERACTIVE = 'button, a, input, select, textarea, label, summary, [role="button"], [role="tab"], [role="menu"], [role="dialog"], [role="listbox"], [contenteditable=""], [contenteditable="true"], .dropdown-menu, .mdn-pop, .mdn-conn, .mdn-zoom'
	if (P.os === 'macos' && win) {
		doc.addEventListener('mousedown', function (e) {
			if (e.button !== 0 || e.defaultPrevented) return
			const t = e.target
			if (!t || !t.closest || !t.closest('#activity-rail, #app-topbar') || t.closest(INTERACTIVE)) return
			if (e.detail === 2) T.core.invoke('titlebar_double_click').catch(function () {})
			else if (e.detail === 1) win.startDragging().catch(function () {})
		})
		// 全屏时红绿灯收起，页面不再给它留空位
		let fsTimer = 0
		const syncFs = function () {
			win.isFullscreen().then(function (fs) {
				if (fs) doc.documentElement.dataset.fullscreen = ''
				else delete doc.documentElement.dataset.fullscreen
			}).catch(function () {})
		}
		root.addEventListener('resize', function () {
			clearTimeout(fsTimer)
			fsTimer = setTimeout(syncFs, 150)
		})
		syncFs()
	}

	// ---------- 右键菜单：页面默认的「重新载入 / 检查元素」不给；输入框保留系统菜单，日志区换成复制 / 全选 / 清空 ----------
	let ctx = null
	function closeCtx() {
		if (ctx) ctx.hidden = true
	}
	function logBox() {
		const h = hub()
		return h && h.getLogContainer ? h.getLogContainer() : null
	}
	function selectionText() {
		const s = root.getSelection ? root.getSelection() : null
		return s ? String(s) : ''
	}
	function copySelection() {
		const text = selectionText()
		if (!text) return
		const fallback = function () { try { doc.execCommand('copy') } catch (e) {} }
		if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(fallback)
		else fallback()
	}
	function selectLog() {
		const box = logBox()
		const s = root.getSelection ? root.getSelection() : null
		if (!box || !s) return
		const r = doc.createRange()
		r.selectNodeContents(box)
		s.removeAllRanges()
		s.addRange(r)
	}
	function showCtx(x, y) {
		if (!ctx) {
			ctx = doc.createElement('div')
			ctx.id = 'native-ctx'
			ctx.className = 'native-ctx'
			ctx.setAttribute('role', 'menu')
			;[['copy', '拷贝'], ['all', '全选日志'], ['sep'], ['clear', '清空日志']].forEach(function (d) {
				if (d[0] === 'sep') {
					ctx.appendChild(doc.createElement('hr'))
					return
				}
				const b = doc.createElement('button')
				b.type = 'button'
				b.setAttribute('role', 'menuitem')
				b.dataset.act = d[0]
				b.textContent = d[1]
				ctx.appendChild(b)
			})
			// mousedown 不抢焦点、不清选区，拷贝要用到当前选区
			ctx.addEventListener('mousedown', function (e) { e.preventDefault() })
			ctx.addEventListener('click', function (e) {
				const b = e.target.closest('button[data-act]')
				if (!b) return
				closeCtx()
				if (b.dataset.act === 'copy') copySelection()
				else if (b.dataset.act === 'all') selectLog()
				else if (b.dataset.act === 'clear') click($('serial-clear'))
			})
			doc.body.appendChild(ctx)
			doc.addEventListener('mousedown', function (e) { if (ctx && !ctx.hidden && !ctx.contains(e.target)) closeCtx() }, true)
			doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeCtx() }, true)
			root.addEventListener('blur', closeCtx)
			root.addEventListener('resize', closeCtx)
			// 只在用户滚动时关：日志自动滚到底也会派发 scroll，不能因此把菜单关掉
			doc.addEventListener('wheel', closeCtx, { capture: true, passive: true })
		}
		ctx.querySelector('[data-act="copy"]').disabled = !selectionText()
		ctx.hidden = false
		const w = ctx.offsetWidth
		const h = ctx.offsetHeight
		ctx.style.left = Math.max(4, Math.min(x, root.innerWidth - w - 4)) + 'px'
		ctx.style.top = Math.max(4, Math.min(y, root.innerHeight - h - 4)) + 'px'
	}
	doc.addEventListener('contextmenu', function (e) {
		const t = e.target
		if (!t || !t.closest) return
		// 输入框、可编辑区：系统菜单(剪切 / 拷贝 / 粘贴)照常
		if (t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return
		e.preventDefault()
		closeCtx()
		// 终端视图有自己的选区，不在这里
		if (t.closest('.serial-logs') && !t.closest('.serial-term-host')) showCtx(e.clientX, e.clientY)
	})

	// ---------- 拖放与缩放 ----------
	// 关掉 Tauri 的拖放处理后，文件拖到没人接的地方 WebView 会把页面导航成那个文件：拦住，拖拽卡等自己处理的(已 preventDefault)不受影响；
	// 只管文件，文字拖进输入框照常
	function isFileDrag(e) {
		const types = e.dataTransfer ? e.dataTransfer.types : null
		return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1
	}
	doc.addEventListener('dragover', function (e) {
		if (e.defaultPrevented || !isFileDrag(e)) return
		e.preventDefault()
		e.dataTransfer.dropEffect = 'none'
	})
	doc.addEventListener('drop', function (e) {
		if (!e.defaultPrevented && isFileDrag(e)) e.preventDefault()
	})
	// WebKit 的触控板捏合手势：整页不缩放(日志缩放走 Ctrl/⌘ + 滚轮，不受影响)
	doc.addEventListener('gesturestart', function (e) { e.preventDefault() }, { passive: false })
})(typeof window !== 'undefined' ? window : globalThis)
