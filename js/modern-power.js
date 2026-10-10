/**
 * 功耗分析页的现代布局（仅 html[data-layout='modern']）
 *
 * 不复制任何业务逻辑：经典布局的控件节点原样搬进新结构（原位置留注释占位，切回经典按占位放回），
 * 新增的只有分组外壳、记录/触发两个弹出层的入口、右栏标签条和「命令表」入口，它们只驱动原控件（click/读值）。
 * 读数、统计、分析面板的刷新仍由 js/blu-power.js 按原节奏写进被搬走的原节点，这里不另起定时器，
 * 也不碰采样数据路径；切标签、显隐画布只调用原有的重绘入口（原分析标签的 click、窗口 resize）。
 */
;(function () {
	'use strict'

	const ASIDE_KEY = 'bluModernAsideTab'
	// 右栏标签：an = 对应原分析面板的 data-tab
	const TABS = [
		{ id: 'measure', label: '测量' },
		{ id: 'events', label: '事件', an: 'events' },
		{ id: 'fft', label: 'FFT', an: 'fft' },
		{ id: 'overlay', label: '叠加', an: 'overlay' },
		{ id: 'battery', label: '电池', an: 'battery' },
		{ id: 'readout', label: '读数', an: 'readout' },
		{ id: 'cmd', label: '命令表' },
		{ id: 'log', label: '日志' },
	]
	const EDGE = { off: '关', rise: '↑', fall: '↓', either: '↕' }
	// 静态文案按设计稿改名；blu-power.js 不改写这些按钮，切回经典时按原文还原
	const RENAME = {
		'blu-cursor-snap-a': '吸附 A',
		'blu-cursor-snap-b': '吸附 B',
		'blu-cursor-period': '一个周期',
		'blu-cursor-zoom': '缩放到光标',
	}

	let mounted = false
	let parked = []
	let hosts = []
	let renamed = []
	let observers = []
	let docListeners = []
	let ui = null

	function E(id) { return document.getElementById(id) }

	function isModern() { return document.documentElement.dataset.layout === 'modern' }

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

	function sep() {
		const s = mk('span', 'mp-sep')
		s.setAttribute('aria-hidden', 'true')
		return s
	}

	function park(node, parent, before) {
		if (!node || !node.parentNode || !parent) return null
		const ph = document.createComment('layout-origin:' + (node.id || node.className))
		node.parentNode.insertBefore(ph, node)
		parked.push([node, ph])
		parent.insertBefore(node, before || null)
		return node
	}

	function host(node) {
		hosts.push(node)
		return node
	}

	function onDoc(type, fn, cap) {
		document.addEventListener(type, fn, !!cap)
		docListeners.push([type, fn, !!cap])
	}

	function observe(target, opts, fn) {
		if (!target) return
		const mo = new MutationObserver(fn)
		mo.observe(target, opts)
		observers.push(mo)
	}

	function group(label, cls) {
		const g = mk('div', 'mp-group' + (cls ? ' ' + cls : ''))
		g.setAttribute('role', 'group')
		if (label) g.setAttribute('aria-label', label)
		return g
	}

	function cap(text) {
		return mk('span', 'mp-cap', text)
	}

	// ---------- 顶部工具条 ----------

	// 记录 / 触发：设计稿里是一枚芯片，点开是弹出层，层里放原来的下拉(原节点)
	function popChip(id, iconName, popLabel) {
		const wrap = mk('div', 'mp-pop-wrap')
		const btn = mk('button', 'btn btn-sm btn-outline-secondary mp-chip')
		btn.type = 'button'
		btn.id = id + '-btn'
		btn.setAttribute('aria-haspopup', 'dialog')
		btn.setAttribute('aria-expanded', 'false')
		btn.setAttribute('aria-controls', id + '-pop')
		const text = mk('span', 'mp-chip-text')
		btn.append(icon(iconName), text, icon('bi-chevron-down mp-chip-caret'))
		const pop = mk('div', 'mp-pop')
		pop.id = id + '-pop'
		pop.setAttribute('role', 'dialog')
		pop.setAttribute('aria-label', popLabel)
		pop.hidden = true
		wrap.append(btn, pop)
		btn.addEventListener('click', function () { setPopOpen(wrap, pop.hidden) })
		return { wrap: wrap, btn: btn, text: text, pop: pop }
	}

	function setPopOpen(wrap, open) {
		if (!ui) return
		ui.pops.forEach(function (p) {
			const on = open && p.wrap === wrap
			p.pop.hidden = !on
			p.btn.setAttribute('aria-expanded', String(on))
		})
		syncChips()
	}

	function popRow(label, node) {
		const row = mk('div', 'mp-pop-row')
		if (label) row.append(mk('span', 'mp-pop-k', label))
		if (node) row.append(node)
		return row
	}

	function optText(sel) {
		if (!sel) return ''
		const o = sel.options[sel.selectedIndex]
		return o ? o.textContent.trim() : ''
	}

	function syncChips() {
		if (!ui) return
		const mode = E('blu-record-mode')
		const ram = E('blu-ram-gb')
		const disk = E('blu-disk-gb')
		const rec = mode && mode.value === 'long'
			? '记录：长期统计'
			: '记录：RAM ' + optText(ram) + ' · 磁盘 ' + optText(disk)
		if (ui.rec.text.textContent !== rec) ui.rec.text.textContent = rec
		const s = E('blu-acq-trig-start')
		const t = E('blu-acq-trig-stop')
		const sv = s ? s.value : 'off'
		const tv = t ? t.value : 'off'
		let trig = '触发：关'
		if (sv !== 'off' || tv !== 'off') {
			trig = '触发：' + [sv !== 'off' ? '开始' + EDGE[sv] : '', tv !== 'off' ? '停止' + EDGE[tv] : ''].filter(Boolean).join(' ')
		}
		if (ui.trig.text.textContent !== trig) ui.trig.text.textContent = trig
		const grp = E('blu-acq-trig-group')
		const st = grp && grp.classList.contains('is-waiting') ? 'waiting' : (grp && grp.classList.contains('is-active') ? 'active' : 'off')
		if (ui.trig.btn.dataset.state !== st) ui.trig.btn.dataset.state = st
		if (grp && ui.trig.btn.title !== grp.title) ui.trig.btn.title = grp.title
		const stor = E('blu-storage-set')
		if (stor && ui.rec.btn.title !== stor.title) ui.rec.btn.title = stor.title
	}

	function buildToolbar(bar) {
		const tb = host(mk('div', 'mp-toolbar'))
		tb.id = 'mp-toolbar'
		tb.setAttribute('role', 'toolbar')
		tb.setAttribute('aria-label', '功耗采集')
		bar.insertBefore(tb, bar.firstChild)

		const gDev = group('设备', 'mp-g-dev')
		tb.append(gDev, sep())
		park(E('blu-device-menu'), gDev)
		park(E('blu-port-select'), gDev)
		park(E('blu-open'), gDev)

		const gPwr = group('供电', 'mp-g-pwr')
		tb.append(gPwr, sep())
		const vl = mk('label', 'mp-field')
		vl.append(mk('span', 'mp-field-k', '电压'))
		gPwr.append(vl)
		park(E('blu-voltage-wrap'), vl)
		park(E('blu-dut-power'), gPwr)

		const gAcq = group('采集参数', 'mp-g-acq')
		tb.append(gAcq, sep())
		const rl = mk('label', 'mp-field')
		rl.append(mk('span', 'mp-field-k', '采样'))
		gAcq.append(rl)
		park(E('blu-sample-rate'), rl)
		const rec = popChip('mp-rec', 'bi-hdd', '记录模式与存储预算')
		gAcq.append(rec.wrap)
		const modeRow = popRow('模式')
		rec.pop.append(modeRow)
		park(E('blu-record-mode'), modeRow)
		const storRow = popRow('存储')
		rec.pop.append(storRow, mk('div', 'mp-pop-note', '波形模式：内存放热数据，满了转存磁盘（关 = 内存满即停）；长期模式只记累计统计，不存波形。'))
		park(E('blu-storage-set'), storRow)
		const trig = popChip('mp-trig', 'bi-bullseye', '采集触发')
		gAcq.append(trig.wrap)
		const trigRow = popRow('')
		trig.pop.append(trigRow, mk('div', 'mp-pop-note', '点「采样」后设备先启动，命中开始沿才写入波形；写入后命中停止沿自动停止。电平与波形「触发」共用。'))
		park(E('blu-acq-trig-group'), trigRow)

		const gAct = group('采样动作', 'mp-g-act')
		tb.append(gAct)
		park(E('blu-start'), gAct)
		park(E('blu-clear'), gAct)
		park(E('blu-export'), gAct)
		park(bar.querySelector('.blu-tb-tools .dropdown'), gAct)

		tb.append(mk('div', 'mp-flex'))
		const cmd = mk('button', 'btn btn-sm btn-outline-secondary mp-cmd-btn')
		cmd.type = 'button'
		cmd.id = 'mp-cmd-btn'
		cmd.title = '在右栏打开命令表（向 DUT 串口发送指令）'
		cmd.append(icon('bi-send'), document.createTextNode(' 命令表'))
		cmd.addEventListener('click', function () { selectTab('cmd', true) })
		tb.append(cmd)

		// 弹出层里的下拉改值、触发组状态变化时同步芯片文字
		tb.addEventListener('change', syncChips)
		return { rec: rec, trig: trig, pops: [rec, trig] }
	}

	// ---------- 主区 ----------

	function readout(label, node, mod, subLabel, subNode) {
		const cell = mk('div', 'mp-ro' + (mod ? ' mp-ro--' + mod : ''))
		cell.append(cap(label))
		const v = mk('div', 'mp-ro-v')
		cell.append(v)
		park(node, v)
		if (subNode) {
			const sub = mk('div', 'mp-ro-sub')
			if (subLabel) sub.append(mk('span', null, subLabel + ' '))
			cell.append(sub)
			park(subNode, sub)
		}
		return cell
	}

	function buildMain(view, main) {
		const vb = mk('div', 'mp-viewbar')
		vb.id = 'mp-viewbar'
		vb.setAttribute('role', 'toolbar')
		vb.setAttribute('aria-label', '波形视图')
		main.append(vb)
		park(E('blu-span-group'), vb)
		vb.append(sep())
		park(view.querySelector('.blu-y-scale-group'), vb)
		vb.append(sep())
		park(E('blu-scope-trig-group'), vb)
		vb.append(mk('div', 'mp-flex'))
		const gView = group('显示', 'mp-g-view')
		vb.append(gView)
		;['blu-wave-band', 'blu-wave-sigma', 'blu-pause-scroll', 'blu-view-reset', 'blu-fullscreen'].forEach(function (id) {
			park(E(id), gView)
		})

		const ro = mk('div', 'mp-readouts')
		ro.id = 'mp-readouts'
		ro.append(
			readout('电流', E('blu-current'), 'current'),
			readout('电压', E('blu-voltage'), null, '设备保存', E('blu-deviceset')),
			readout('功率', E('blu-power')),
			readout('时长', E('blu-duration')),
			readout('速率', E('blu-rate'), null, null, E('blu-rate-raw')),
			readout('样本数', E('blu-count'))
		)
		main.append(ro)

		const wave = mk('div', 'mp-wave')
		wave.id = 'mp-wave'
		main.append(wave)
		park(view.querySelector('.blu-waveform-area'), wave)

		const cb = mk('div', 'mp-cursorbar')
		cb.id = 'mp-cursorbar'
		cb.setAttribute('role', 'toolbar')
		cb.setAttribute('aria-label', '光标')
		cb.append(cap('光标'))
		main.append(cb)
		park(view.querySelector('.blu-cursor-group'), cb)
		Object.keys(RENAME).forEach(function (id) {
			const b = E(id)
			if (!b) return
			renamed.push([b, b.innerHTML])
			b.textContent = RENAME[id]
		})
	}

	// ---------- 右栏 ----------

	function origTab(an) {
		return document.querySelector('.blu-analysis-tab[data-tab="' + an + '"]')
	}

	function analysisOpen() {
		const t = E('blu-analysis-toggle')
		return !!t && t.getAttribute('aria-expanded') === 'true'
	}

	// 只在不改变任何状态时借原标签的 click 强制重绘(同一标签 + 已展开 = 只有 refreshAnalysis(true))
	function redrawAnalysis(an) {
		const b = origTab(an)
		if (b && analysisOpen() && b.getAttribute('aria-selected') === 'true') b.click()
	}

	function cmdOpen() {
		const b = E('blu-cmd-open')
		return !!b && b.getAttribute('aria-pressed') === 'true'
	}

	function openCmd() {
		const sheet = E('blu-cmd-sheet')
		if (ui && sheet && sheet.parentNode !== ui.pages.cmd) park(sheet, ui.pages.cmd, ui.cmdEmpty)
		const b = E('blu-cmd-open')
		if (b && !cmdOpen()) b.click()
	}

	function buildAside(view, aside) {
		const tabs = mk('div', 'mp-tabs')
		tabs.id = 'mp-tabs'
		tabs.setAttribute('role', 'tablist')
		tabs.setAttribute('aria-label', '功耗分析')
		aside.append(tabs)

		const anHead = mk('div', 'mp-an-head')
		anHead.id = 'mp-an-head'
		park(E('blu-analysis-toggle'), anHead)
		park(view.querySelector('.blu-analysis-scope-label'), anHead)
		park(E('blu-analysis-scope-hint'), anHead)
		park(view.querySelector('.blu-analysis-info'), anHead)
		const collapsed = mk('div', 'mp-an-collapsed')
		const expand = mk('button', 'btn btn-sm btn-outline-secondary')
		expand.type = 'button'
		expand.textContent = '展开分析'
		expand.addEventListener('click', function () {
			const t = E('blu-analysis-toggle')
			if (t && !analysisOpen()) t.click()
		})
		collapsed.append(mk('span', null, '分析已收起（收起时不计算）'), expand)

		// 收起/展开时 blu-power.js 会同步重画面板画布：在它的 click 处理之前(捕获阶段)先把右栏的收起态切好，
		// 否则面板仍是 display:none，画布按 8px 画完才显示出来
		anHead.addEventListener('click', function (e) {
			const t = E('blu-analysis-toggle')
			if (t && e.target.closest('#blu-analysis-toggle')) aside.dataset.collapsed = analysisOpen() ? 'true' : 'false'
		}, true)

		const pagesBox = mk('div', 'mp-pages')
		aside.append(anHead, pagesBox)

		const btns = {}
		const pages = {}
		TABS.forEach(function (t) {
			const b = mk('button', 'mp-tab', t.label)
			b.type = 'button'
			b.id = 'mp-tab-' + t.id
			b.dataset.tab = t.id
			b.setAttribute('role', 'tab')
			b.setAttribute('aria-controls', 'mp-page-' + t.id)
			tabs.append(b)
			btns[t.id] = b
			const p = mk('div', 'mp-page')
			p.id = 'mp-page-' + t.id
			p.setAttribute('role', 'tabpanel')
			p.setAttribute('aria-labelledby', b.id)
			p.hidden = true
			pagesBox.append(p)
			pages[t.id] = p
		})

		// 测量：选择(A–B) / 窗口 / 总体 三组统计卡，原节点
		park(view.querySelector('.blu-stat-card-cursor'), pages.measure)
		park(view.querySelector('.blu-stat-card-window'), pages.measure)
		park(view.querySelector('.blu-stat-card-overall'), pages.measure)
		// 分析：每个原面板进自己的标签页；收起提示共用一份，随当前分析页移动
		TABS.forEach(function (t) {
			if (t.an) park(E('blu-panel-' + t.an), pages[t.id])
		})
		// 命令表：原「串口发送」面板停靠在这里；收起时显示入口
		const cmdEmpty = mk('div', 'mp-cmd-empty')
		const cmdBtn = mk('button', 'btn btn-sm btn-outline-secondary')
		cmdBtn.type = 'button'
		cmdBtn.append(icon('bi-send'), document.createTextNode(' 打开串口发送'))
		cmdBtn.addEventListener('click', openCmd)
		cmdEmpty.append(mk('span', null, '串口发送面板已收起'), cmdBtn)
		pages.cmd.append(cmdEmpty)
		park(E('blu-cmd-sheet'), pages.cmd, cmdEmpty)
		// 采集日志
		park(E('blu-log-card'), pages.log)

		tabs.addEventListener('click', function (e) {
			const b = e.target.closest('.mp-tab')
			if (b) selectTab(b.dataset.tab, true)
		})
		tabs.addEventListener('keydown', function (e) {
			if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
			const ids = TABS.map(function (t) { return t.id })
			let i = ids.indexOf(ui.tab)
			if (e.key === 'ArrowRight') i = (i + 1) % ids.length
			else if (e.key === 'ArrowLeft') i = (i - 1 + ids.length) % ids.length
			else if (e.key === 'Home') i = 0
			else i = ids.length - 1
			e.preventDefault()
			selectTab(ids[i], true)
			btns[ids[i]].focus()
		})
		return { tabs: btns, pages: pages, anHead: anHead, collapsed: collapsed, cmdEmpty: cmdEmpty }
	}

	function selectTab(id, user) {
		if (!ui) return
		const t = TABS.find(function (x) { return x.id === id }) || TABS[0]
		ui.tab = t.id
		if (user) {
			try { localStorage.setItem(ASIDE_KEY, t.id) } catch (e) { /* 只是便利项 */ }
		}
		TABS.forEach(function (x) {
			const on = x.id === t.id
			ui.tabs[x.id].setAttribute('aria-selected', String(on))
			ui.tabs[x.id].tabIndex = on ? 0 : -1
			ui.pages[x.id].hidden = !on
		})
		ui.aside.dataset.tab = t.id
		ui.aside.dataset.an = t.an ? 'true' : 'false'
		if (t.an) {
			ui.pages[t.id].insertBefore(ui.collapsed, ui.pages[t.id].firstChild)
			// 用户点的：交给原标签(切面板 + 收起时展开 + 强制按新尺寸重绘)；否则只在不改状态时重绘
			const b = origTab(t.an)
			if (user && b) {
				// 原标签会顺带展开分析并同步重画，先把收起态切好(理由同上)
				ui.aside.dataset.collapsed = 'false'
				b.click()
				syncCollapsed()
			}
			else redrawAnalysis(t.an)
		}
		if (t.id === 'cmd' && user) openCmd()
		if (t.id === 'log') {
			const box = E('blu-log')
			if (box) box.scrollTop = box.scrollHeight
		}
	}

	function syncCollapsed() {
		if (ui) ui.aside.dataset.collapsed = analysisOpen() ? 'false' : 'true'
	}

	function initialTab() {
		let saved = null
		try { saved = localStorage.getItem(ASIDE_KEY) } catch (e) { /* 忽略 */ }
		const t = TABS.find(function (x) { return x.id === saved })
		if (!t) return 'measure'
		// 进入现代布局不能改分析面板的状态：保存的分析页与原面板当前标签不一致时退回「测量」
		if (t.an) {
			const b = origTab(t.an)
			if (!b || b.getAttribute('aria-selected') !== 'true') return 'measure'
		}
		return t.id
	}

	// ---------- 挂载 / 卸载 ----------

	function mount() {
		if (mounted) return
		const view = E('view-blu')
		const bar = view && view.querySelector('.blu-connect-bar')
		const wrapper = view && view.querySelector('.blu-wrapper')
		if (!view || !bar || !wrapper) return
		mounted = true

		const tb = buildToolbar(bar)
		const body = host(mk('div', 'mp-body'))
		body.id = 'mp-body'
		wrapper.insertBefore(body, wrapper.firstChild)
		const main = mk('div', 'mp-main')
		main.id = 'mp-main'
		const aside = mk('aside', 'mp-aside')
		aside.id = 'mp-aside'
		aside.setAttribute('aria-label', '测量与分析')
		body.append(main, aside)
		buildMain(view, main)
		const side = buildAside(view, aside)

		ui = {
			rec: tb.rec, trig: tb.trig, pops: tb.pops,
			aside: aside, tabs: side.tabs, pages: side.pages, anHead: side.anHead,
			collapsed: side.collapsed, cmdEmpty: side.cmdEmpty, tab: 'measure',
		}

		observe(E('blu-analysis-toggle'), { attributes: true, attributeFilter: ['aria-expanded'] }, syncCollapsed)
		observe(E('blu-acq-trig-group'), { attributes: true, attributeFilter: ['class', 'title'] }, syncChips)
		// blu-power.js 改值不派发 change(导入、切模式、读配置)：借读数的原有刷新节拍顺带核对芯片文字
		observe(E('blu-count'), { childList: true, characterData: true, subtree: true }, syncChips)
		observe(view, { attributes: true, attributeFilter: ['class'] }, function () {
			if (!view.classList.contains('active') || !ui) return
			const t = TABS.find(function (x) { return x.id === ui.tab })
			if (t && t.an) redrawAnalysis(t.an)
		})
		onDoc('pointerdown', function (e) {
			if (!ui) return
			ui.pops.forEach(function (p) {
				if (!p.pop.hidden && !p.wrap.contains(e.target)) setPopOpen(null, false)
			})
		}, true)
		onDoc('keydown', function (e) {
			if (e.key !== 'Escape' || !ui) return
			const open = ui.pops.find(function (p) { return !p.pop.hidden })
			if (!open) return
			setPopOpen(null, false)
			open.btn.focus()
		})

		syncCollapsed()
		syncChips()
		selectTab(initialTab(), false)
	}

	function unmount() {
		if (!mounted) return
		observers.forEach(function (o) { o.disconnect() })
		observers = []
		docListeners.forEach(function (l) { document.removeEventListener(l[0], l[1], l[2]) })
		docListeners = []
		renamed.forEach(function (r) { r[0].innerHTML = r[1] })
		renamed = []
		parked.reverse().forEach(function (pair) { pair[1].replaceWith(pair[0]) })
		parked = []
		hosts.forEach(function (n) { n.remove() })
		hosts = []
		ui = null
		mounted = false
		// 画布回到经典布局的容器：已展开的分析面板按经典尺寸重画一次(不改任何状态)
		const cur = document.querySelector('.blu-analysis-tab[aria-selected="true"]')
		if (cur && analysisOpen()) cur.click()
	}

	function init() {
		if (isModern()) mount()
		document.addEventListener('serial-layout-move', function (e) {
			if (e.detail && e.detail.layout === 'modern') mount()
			else unmount()
		})
	}

	window.ModernPower = {
		selectTab: function (id) { selectTab(id, true) },
		isMounted: function () { return mounted },
	}

	// 排在 blu-cmd-sheet.js 之后：它在 DOMContentLoaded 才建「串口发送」面板
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init)
	} else {
		init()
	}
})()
