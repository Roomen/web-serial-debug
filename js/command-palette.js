// 命令面板（Cmd+K / Ctrl+K）
// 只通过操作 DOM 执行命令，不依赖 common.js 的内部变量。
;(function () {
	'use strict'

	const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
	const MOD_LABEL = IS_MAC ? '⌘K' : 'Ctrl+K'

	//---- DOM 小工具：目标不存在时静默跳过并 warn ----
	function el(id) {
		return document.getElementById(id)
	}
	function warnMissing(what) {
		console.warn('[命令面板] 目标元素不存在，已跳过：' + what)
	}
	function clickEl(target, label) {
		const node = typeof target === 'string' ? el(target) : target
		if (!node) {
			warnMissing(label || target)
			return false
		}
		node.click()
		return true
	}
	function clickSel(selector) {
		const node = document.querySelector(selector)
		if (!node) {
			warnMissing(selector)
			return false
		}
		node.click()
		return true
	}
	function setValue(id, value) {
		const node = el(id)
		if (!node) {
			warnMissing(id)
			return false
		}
		if (node.type === 'checkbox') {
			node.checked = !!value
		} else {
			node.value = value
		}
		node.dispatchEvent(new Event('change', { bubbles: true }))
		return true
	}
	function textOf(id) {
		const node = el(id)
		return node ? (node.innerText || '').trim() : ''
	}

	//---- 模糊匹配：子序列 + 打分 ----
	// 返回 null 表示不命中，否则返回分值（越大越好）
	function fuzzyScore(query, text) {
		if (!query) return 0
		const q = query.toLowerCase()
		const t = text.toLowerCase()
		let score = 0
		let ti = 0
		let prevIdx = -1
		for (let qi = 0; qi < q.length; qi++) {
			const ch = q[qi]
			if (ch === ' ') continue
			let found = -1
			for (let i = ti; i < t.length; i++) {
				if (t[i] === ch) {
					found = i
					break
				}
			}
			if (found < 0) return null
			//连续匹配加分
			if (found === prevIdx + 1) score += 8
			//词首/串首匹配加分
			if (found === 0) score += 10
			else {
				const prevCh = t[found - 1]
				if (prevCh === ' ' || prevCh === '-' || prevCh === '·' || prevCh === '/' || prevCh === '_') score += 6
			}
			//越靠前越好
			score += Math.max(0, 4 - Math.floor(found / 6))
			prevIdx = found
			ti = found + 1
		}
		//候选越短越精确
		score += Math.max(0, 12 - Math.floor(t.length / 4))
		return score
	}
	function scoreCommand(query, cmd) {
		if (!query.trim()) return 0
		const titleScore = fuzzyScore(query, cmd.title)
		const aliasScore = cmd.alias ? fuzzyScore(query, cmd.alias) : null
		const detailScore = cmd.detail ? fuzzyScore(query, cmd.detail) : null
		let best = null
		if (titleScore !== null) best = titleScore + 20
		if (aliasScore !== null && (best === null || aliasScore + 10 > best)) best = aliasScore + 10
		if (detailScore !== null && (best === null || detailScore > best)) best = detailScore
		return best
	}

	//---- 命令收集 ----
	function serialCommands() {
		const list = []
		list.push({
			group: '串口',
			title: '选择串口',
			alias: 'xuanze chuankou select port',
			run: function () { clickEl('serial-select-port') }
		})
		const toggleText = textOf('serial-open-or-close') || '打开串口'
		list.push({
			group: '串口',
			title: toggleText.indexOf('关闭') >= 0 ? '关闭串口' : '打开串口',
			alias: 'open close serial dakai guanbi chuankou',
			run: function () { clickEl('serial-open-or-close') }
		})
		list.push({
			group: '串口',
			title: '打开串口参数面板',
			alias: 'canshu params baudrate settings',
			run: function () { clickEl('serial-params-summary') }
		})
		list.push({
			group: '串口',
			title: '切换串口模式（单路/双路）',
			alias: 'moshi mode dual single shuanglu danlu qiehuan',
			detail: '当前 ' + (window.SerialHub ? window.SerialHub.mode : 'single'),
			run: function () {
				if (!window.SerialHub) return
				if (window.SerialHub.mode === 'dual') {
					clickEl('serial-mode-single')
				} else {
					clickEl('serial-mode-dual')
				}
			}
		})
		;[9600, 115200, 230400, 460800].forEach(function (baud) {
			list.push({
				group: '串口',
				title: '波特率切换到 ' + baud,
				alias: 'botelv baud ' + baud,
				detail: '当前 ' + ((el('serial-baud') || {}).value || '-'),
				run: function () { setValue('serial-baud', String(baud)) }
			})
		})
		return list
	}

	function logCommands() {
		const list = []
		list.push({
			group: '日志',
			title: '清空日志',
			alias: 'qingkong clear log',
			run: function () { clickEl('serial-clear') }
		})
		list.push({
			group: '日志',
			title: '复制日志',
			alias: 'fuzhi copy log',
			run: function () { clickEl('serial-copy') }
		})
		list.push({
			group: '日志',
			title: '导出日志',
			alias: 'daochu export save log',
			run: function () { clickEl('serial-save') }
		})
		const typeSel = el('serial-log-type')
		if (typeSel) {
			Array.prototype.forEach.call(typeSel.options, function (opt) {
				list.push({
					group: '日志',
					title: '日志类型：' + opt.textContent,
					alias: 'rizhi leixing log type ' + opt.value,
					run: function () { setValue('serial-log-type', opt.value) }
				})
			})
		} else {
			warnMissing('serial-log-type')
		}
		const scrollText = textOf('serial-auto-scroll')
		list.push({
			group: '日志',
			title: scrollText === '自动滚动' ? '暂停日志滚动' : '恢复自动滚动',
			alias: 'gundong scroll auto pause',
			run: function () { clickEl('serial-auto-scroll') }
		})
		return list
	}

	//localStorage 里只有用户改过快捷发送后才有数据，
	//没有时退回读当前分组已渲染的 DOM 行，保证默认预设也能被搜到
	function quickSendGroupsFromDom() {
		const box = el('serial-quick-send-content')
		if (!box) return []
		const sel = el('serial-quick-send')
		const name = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : ''
		const items = []
		Array.prototype.forEach.call(box.querySelectorAll('.quick-item'), function (row) {
			const btn = row.querySelector('.quick-send')
			const contentInput = row.querySelector('input.form-control')
			const hexBox = row.querySelector('input[type="checkbox"]')
			if (!contentInput || !contentInput.value) return
			items.push({
				name: btn ? btn.textContent : contentInput.value,
				content: contentInput.value,
				hex: !!(hexBox && hexBox.checked)
			})
		})
		return items.length ? [{ name: name, list: items }] : []
	}

	function quickSendCommands() {
		const list = []
		let groups = []
		try {
			groups = JSON.parse(localStorage.getItem('quickSendList') || 'null')
		} catch (e) {
			console.warn('[命令面板] quickSendList 解析失败', e)
			groups = null
		}
		if (!Array.isArray(groups) || !groups.length) groups = quickSendGroupsFromDom()
		groups.forEach(function (grp) {
			if (!grp || !Array.isArray(grp.list)) return
			grp.list.forEach(function (item) {
				if (!item || !item.content) return
				list.push({
					group: '快捷发送',
					title: item.name || item.content,
					detail: (grp.name || '') + ' · ' + item.content + (item.hex ? ' · HEX' : ''),
					alias: 'kuaijie fasong quick send ' + item.content,
					run: function () {
						//HEX/文本模式要先切对，再填内容发送
						const hexBox = el('serial-hex-send')
						if (hexBox && hexBox.checked !== !!item.hex) {
							setValue('serial-hex-send', !!item.hex)
						} else if (!hexBox) {
							warnMissing('serial-hex-send')
						}
						if (!setValue('serial-send-content', item.content)) return
						clickEl('serial-send')
					}
				})
			})
		})
		return list
	}

	function activePresets() {
		let proto = null
		if (typeof window.getActiveProtocol === 'function') {
			try { proto = window.getActiveProtocol() } catch (e) { proto = null }
		}
		if (proto && Array.isArray(proto.presets) && proto.presets.length) return proto.presets
		return Array.isArray(window.SK_DOWN_PRESETS) ? window.SK_DOWN_PRESETS : []
	}

	function ensureSerialView() {
		const rail = document.querySelector('.rail-item[data-view="view-serial"]')
		if (rail && !rail.classList.contains('active')) rail.click()
		const main = el('main')
		if (main && main.classList.contains('right-collapsed')) {
			clickSel('.toggle-button[data-pane="right"]')
		}
	}

	function presetCommands() {
		const list = []
		activePresets().forEach(function (grp) {
			if (!grp || !Array.isArray(grp.items)) return
			grp.items.forEach(function (item) {
				if (!item || !item.name) return
				list.push({
					group: '常用指令',
					title: item.name,
					detail: (grp.group || '') + (item.desc ? ' · ' + item.desc : ''),
					alias: 'changyong zhiling preset ' + (item.func || ''),
					run: function () {
						ensureSerialView()
						if (!clickEl('nav-protocol-tab')) return
						//功能码必须先设对，否则预设下拉里没有该项
						if (item.func && !setValue('serial-protocol-down-func', item.func)) return
						setValue('serial-protocol-down-preset', item.name)
					}
				})
			})
		})
		return list
	}

	function viewCommands() {
		const list = []
		list.push({
			group: '视图',
			title: '切换到串口调试',
			alias: 'chuankou tiaoshi serial view',
			run: function () { clickSel('.rail-item[data-view="view-serial"]') }
		})
		list.push({
			group: '视图',
			title: '切换到固件打包',
			alias: 'gujian dabao firmware pack view',
			run: function () { clickSel('.rail-item[data-view="view-fw-pack"]') }
		})
		list.push({
			group: '视图',
			title: '切换到功耗分析',
			alias: 'gonghao fenxi power blu blu100k ppk view',
			run: function () { clickSel('.rail-item[data-view="view-blu"]') }
		})
		list.push({
			group: '视图',
			title: '打开设备指令',
			alias: 'shebei zhiling device command cmd sheet',
			run: function () {
				clickSel('.rail-item[data-view="view-blu"]')
				if (window.bluCmdSheet && !window.bluCmdSheet.isOpen()) window.bluCmdSheet.open()
			}
		})
		const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
		list.push({
			group: '视图',
			title: isDark ? '切换到亮色主题' : '切换到暗色主题',
			alias: 'zhuti theme dark light',
			run: function () { clickEl('theme-toggle') }
		})
		const main = el('main')
		const rightCollapsed = !!(main && main.classList.contains('right-collapsed'))
		list.push({
			group: '视图',
			title: rightCollapsed ? '展开右侧工具栏' : '折叠右侧工具栏',
			alias: 'youlan sidebar tools zhedie',
			run: function () { clickSel('.toggle-button[data-pane="right"]') }
		})
		const parsePanel = el('serial-parse-panel')
		const parseCollapsed = !!(parsePanel && parsePanel.classList.contains('collapsed'))
		list.push({
			group: '视图',
			title: parseCollapsed ? '展开协议解析面板' : '折叠协议解析面板',
			alias: 'jiexi mianban parse panel',
			run: function () {
				if (parseCollapsed && typeof window.expandParsePanel === 'function') {
					window.expandParsePanel()
					return
				}
				clickEl('serial-parse-header')
			}
		})
		const sendPanel = el('serial-send-panel')
		const sendCollapsed = !!(sendPanel && sendPanel.classList.contains('collapsed'))
		list.push({
			group: '视图',
			title: sendCollapsed ? '展开串口发送面板' : '折叠串口发送面板',
			alias: 'fasong mianban send panel',
			run: function () {
				if (sendCollapsed && typeof window.expandSendPanel === 'function') {
					window.expandSendPanel()
					return
				}
				clickEl('serial-send-header')
			}
		})
		return list
	}

	//手写的中文关键词→拼音/英文映射（不引拼音库），
	//用来给标题自动补一段可搜索的别名，主要服务预设指令这类批量条目
	const ALIAS_MAP = {
		'查询': 'chaxun query', '设置': 'shezhi set', '配置': 'peizhi config',
		'清空': 'qingkong clear', '复制': 'fuzhi copy', '导出': 'daochu export',
		'切换': 'qiehuan switch toggle', '打开': 'dakai open', '关闭': 'guanbi close',
		'展开': 'zhankai expand', '折叠': 'zhedie collapse',
		'串口': 'chuankou serial', '波特率': 'botelv baud', '日志': 'rizhi log',
		'参数': 'canshu param', '主题': 'zhuti theme', '视图': 'shitu view',
		'面板': 'mianban panel', '解析': 'jiexi parse', '协议': 'xieyi protocol',
		'固件': 'gujian firmware', '升级': 'shengji upgrade', '打包': 'dabao pack',
		'发送': 'fasong send', '滚动': 'gundong scroll', '类型': 'leixing type',
		'上报': 'shangbao report', '频率': 'pinlv freq', '平台': 'pingtai platform',
		'告警': 'gaojing alarm', '阈值': 'yuzhi threshold', '时间': 'shijian time',
		'版本': 'banben version', '电池': 'dianchi battery', '流量': 'liuliang flow',
		'蓝牙': 'lanya bluetooth', '密钥': 'miyao key', '重启': 'chongqi reboot',
		'数据': 'shuju data', '状态': 'zhuangtai status', '指令': 'zhiling command',
		'模式': 'moshi mode', '网络': 'wangluo network', '温度': 'wendu temperature',
		'阀门': 'famen valve', '冻结': 'dongjie freeze', '历史': 'lishi history',
		'读取': 'duqu read', '复位': 'fuwei reset', '间隔': 'jiange interval'
	}
	function aliasHints(text) {
		let out = ''
		for (const word in ALIAS_MAP) {
			if (text.indexOf(word) >= 0) out += ' ' + ALIAS_MAP[word]
		}
		return out
	}

	function collectCommands() {
		const all = []
		all.push.apply(all, serialCommands())
		all.push.apply(all, logCommands())
		all.push.apply(all, quickSendCommands())
		all.push.apply(all, presetCommands())
		all.push.apply(all, viewCommands())
		all.forEach(function (cmd) {
			cmd.alias = (cmd.alias || '') + aliasHints(cmd.title)
		})
		return all
	}

	//---- 面板 UI ----
	const GROUP_ORDER = ['串口', '日志', '快捷发送', '常用指令', '视图']

	let overlay = null
	let input = null
	let listBox = null
	let commands = []
	let results = []
	let activeIndex = 0

	function buildDom() {
		overlay = document.createElement('div')
		overlay.id = 'serial-cmdk-overlay'
		overlay.hidden = true
		overlay.innerHTML =
			'<div id="serial-cmdk-panel" role="dialog" aria-modal="true" aria-label="命令面板">' +
			'<div id="serial-cmdk-inputbar">' +
			'<i class="bi bi-search"></i>' +
			'<input id="serial-cmdk-input" type="text" autocomplete="off" spellcheck="false" placeholder="搜索命令…（支持拼音/英文别名）">' +
			'<span class="serial-cmdk-kbd">Esc</span>' +
			'</div>' +
			'<div id="serial-cmdk-list" role="listbox"></div>' +
			'<div id="serial-cmdk-footer"><span><b>↑↓</b> 选择</span><span><b>Enter</b> 执行</span><span><b>' +
			MOD_LABEL + '</b> 开关</span></div>' +
			'</div>'
		document.body.appendChild(overlay)
		input = el('serial-cmdk-input')
		listBox = el('serial-cmdk-list')

		overlay.addEventListener('mousedown', function (e) {
			if (e.target === overlay) close()
		})
		input.addEventListener('input', function () {
			refresh()
		})
		input.addEventListener('keydown', onInputKeydown)
		listBox.addEventListener('mousemove', function (e) {
			const row = e.target.closest('.serial-cmdk-item')
			if (!row) return
			const idx = parseInt(row.dataset.index, 10)
			if (!isNaN(idx) && idx !== activeIndex) setActive(idx, false)
		})
		listBox.addEventListener('click', function (e) {
			const row = e.target.closest('.serial-cmdk-item')
			if (!row) return
			const idx = parseInt(row.dataset.index, 10)
			if (!isNaN(idx)) execute(idx)
		})
	}

	function onInputKeydown(e) {
		//Cmd+K 之外的按键不许冒泡到全局（页面里还有别的 Esc 处理）
		const isToggle = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')
		if (!isToggle) e.stopPropagation()
		if (isToggle) return
		if (e.key === 'Escape') {
			e.preventDefault()
			close()
		} else if (e.key === 'ArrowDown') {
			e.preventDefault()
			move(1)
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			move(-1)
		} else if (e.key === 'Enter') {
			e.preventDefault()
			execute(activeIndex)
		}
	}

	function move(delta) {
		if (!results.length) return
		let next = activeIndex + delta
		if (next < 0) next = results.length - 1
		if (next >= results.length) next = 0
		setActive(next, true)
	}

	function setActive(idx, scroll) {
		activeIndex = idx
		const rows = listBox.querySelectorAll('.serial-cmdk-item')
		Array.prototype.forEach.call(rows, function (row) {
			const on = parseInt(row.dataset.index, 10) === idx
			row.classList.toggle('active', on)
			row.setAttribute('aria-selected', on ? 'true' : 'false')
			if (on && scroll) row.scrollIntoView({ block: 'nearest' })
		})
	}

	function escapeHtml(s) {
		return String(s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
		})
	}

	function refresh() {
		const query = input.value.trim()
		const scored = []
		commands.forEach(function (cmd) {
			const s = scoreCommand(query, cmd)
			if (s === null) return
			scored.push({ cmd: cmd, score: s })
		})
		if (query) {
			scored.sort(function (a, b) { return b.score - a.score })
		} else {
			scored.sort(function (a, b) {
				return GROUP_ORDER.indexOf(a.cmd.group) - GROUP_ORDER.indexOf(b.cmd.group)
			})
		}
		results = scored.map(function (x) { return x.cmd })
		render()
	}

	function render() {
		if (!results.length) {
			listBox.innerHTML = '<div class="serial-cmdk-empty">无匹配项</div>'
			activeIndex = 0
			return
		}
		let html = ''
		let lastGroup = null
		results.forEach(function (cmd, idx) {
			if (cmd.group !== lastGroup) {
				html += '<div class="serial-cmdk-group">' + escapeHtml(cmd.group) + '</div>'
				lastGroup = cmd.group
			}
			html += '<div class="serial-cmdk-item" role="option" data-index="' + idx + '">' +
				'<div class="serial-cmdk-text">' +
				'<span class="serial-cmdk-title">' + escapeHtml(cmd.title) + '</span>' +
				(cmd.detail ? '<span class="serial-cmdk-detail">' + escapeHtml(cmd.detail) + '</span>' : '') +
				'</div>' +
				(cmd.shortcut ? '<span class="serial-cmdk-kbd">' + escapeHtml(cmd.shortcut) + '</span>' : '') +
				'<span class="serial-cmdk-badge">' + escapeHtml(cmd.group) + '</span>' +
				'</div>'
		})
		listBox.innerHTML = html
		setActive(0, true)
	}

	function execute(idx) {
		const cmd = results[idx]
		close()
		if (!cmd) return
		try {
			cmd.run()
		} catch (err) {
			console.warn('[命令面板] 命令执行失败：' + cmd.title, err)
		}
	}

	function isLocked() {
		const login = el('login-overlay')
		if (!login) return false
		//登录遮罩是 position:fixed，offsetParent 恒为 null，只能看计算样式
		const cs = getComputedStyle(login)
		return cs.display !== 'none' && cs.visibility !== 'hidden'
	}

	function isOpen() {
		return overlay && !overlay.hidden
	}

	function open() {
		if (isLocked()) return
		if (!overlay) buildDom()
		commands = collectCommands()
		overlay.hidden = false
		input.value = ''
		refresh()
		input.focus()
		input.select()
	}

	function close() {
		if (!overlay || overlay.hidden) return
		overlay.hidden = true
		input.blur()
	}

	document.addEventListener('keydown', function (e) {
		if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
			if (isLocked()) return
			e.preventDefault()
			if (isOpen()) close()
			else open()
			return
		}
		if (e.key === 'Escape' && isOpen()) {
			e.preventDefault()
			close()
		}
	}, true)

	//便于外部/调试调用
	window.serialCommandPalette = {
		open: open,
		close: close,
		toggle: function () { isOpen() ? close() : open() }
	}
})()
