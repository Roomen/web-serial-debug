/**
 * BLU 串口发送覆盖面板
 * 在功耗分析页底部以 overlay 形式提供串口发送能力
 * 走 DUT 串口（window.serialApi），不走 BLU 分析仪口
 */

;(function () {
	'use strict'

	const STORAGE_KEY = 'bluCmdSheetOpen'
	const AUTO_CLOSE_KEY = 'bluCmdSheetAutoClose'
	const AUTO_CLOSE_DELAY = 1800
	let isOpen = false
	let presetGroups = []
	let autoCloseTimer = null

	// DOM refs
	let wrap, tab, backdrop, sheet, statusEl, noSerialEl, hasSerialEl
	let groupSel, presetSel, sendBtn, customInput, hexCheck, crlfCheck, sendCustomBtn, resultEl, closeBtn, autoCloseCheck

	function E(id) { return document.getElementById(id) }

	function init() {
		if (E('blu-cmd-sheet-wrap')) return
		// buildDOM 在缺少 #view-blu 时会直接 return, 模块级 tab/wrap 等仍是 undefined;
		// 此时必须停在这里, 否则 bindEvents 第一行就对 undefined 取属性抛 TypeError,
		// 报错信息与真实原因(找不到 #view-blu)无关, 排查成本高。
		if (!buildDOM()) return
		bindEvents()

		// 恢复上次展开状态
		let startOpen = false
		try { startOpen = localStorage.getItem(STORAGE_KEY) === '1' } catch (e) {}
		setOpen(startOpen, true)

		observeFullscreen()
	}

	function buildDOM() {
		const viewBlu = E('view-blu')
		if (!viewBlu) return false

		const html =
		'<div class="blu-cmd-sheet-wrap" id="blu-cmd-sheet-wrap">' +
			'<button class="blu-cmd-tab" id="blu-cmd-tab" title="串口发送">' +
				'<span class="blu-cmd-tab-caret">^</span>' +
				'<span class="blu-cmd-tab-text">串口发送</span>' +
			'</button>' +
			'<div class="blu-cmd-backdrop" id="blu-cmd-backdrop" hidden></div>' +
			'<div class="blu-cmd-sheet" id="blu-cmd-sheet" hidden>' +
				'<div class="blu-cmd-sheet-bar">' +
					'<span class="blu-cmd-sheet-title"><i class="bi bi-terminal"></i> 串口发送</span>' +
					'<div class="blu-cmd-sheet-actions">' +
						'<span class="blu-cmd-status" id="blu-cmd-status">--</span>' +
						'<div class="form-check form-switch blu-cmd-auto-close-switch" title="发送成功后自动收起面板">' +
							'<input class="form-check-input" type="checkbox" id="blu-cmd-auto-close">' +
							'<label class="form-check-label" for="blu-cmd-auto-close">自动收起</label>' +
						'</div>' +
						'<button class="blu-cmd-sheet-close" id="blu-cmd-close" title="收起 (Esc)">∨</button>' +
					'</div>' +
				'</div>' +
				'<div class="blu-cmd-sheet-body">' +
					'<div id="blu-cmd-no-serial" hidden>' +
						'<div class="blu-cmd-hint">串口未打开，无法发送</div>' +
						'<button class="btn btn-sm btn-outline-secondary" id="blu-cmd-goto-serial">' +
							'<i class="bi bi-box-arrow-up-right"></i> 打开串口调试' +
						'</button>' +
					'</div>' +
					'<div id="blu-cmd-has-serial" hidden>' +
						'<div class="blu-cmd-row blu-cmd-preset-row">' +
							'<select id="blu-cmd-group" class="form-select form-select-sm" title="选择快捷发送分组">' +
								'<option value="">-- 选择分组 --</option>' +
							'</select>' +
							'<select id="blu-cmd-preset" class="form-select form-select-sm" title="从快捷发送列表选择">' +
								'<option value="">-- 选择发送内容 --</option>' +
							'</select>' +
							'<button class="btn btn-sm btn-primary blu-cmd-send-btn" id="blu-cmd-send-btn" title="发送选中内容">发送</button>' +
						'</div>' +
						'<div class="blu-cmd-row blu-cmd-custom-row">' +
							'<input type="text" id="blu-cmd-custom" class="form-control form-control-sm" placeholder="或输入 HEX / 文本…" autocomplete="off" spellcheck="false">' +
							'<button type="button" class="blu-cmd-pill is-on" id="blu-cmd-hex-mode" aria-pressed="true" title="HEX 发送">HEX</button>' +
							'<button type="button" class="blu-cmd-pill" id="blu-cmd-add-crlf" aria-pressed="false" title="末尾加回车换行">CRLF</button>' +
							'<button class="btn btn-sm btn-outline-secondary" id="blu-cmd-send-custom" title="发送自定义内容">发送</button>' +
						'</div>' +
						'<div class="blu-cmd-result" id="blu-cmd-result"></div>' +
					'</div>' +
				'</div>' +
			'</div>' +
		'</div>'

		viewBlu.insertAdjacentHTML('beforeend', html)

		wrap = E('blu-cmd-sheet-wrap')
		tab = E('blu-cmd-tab')
		backdrop = E('blu-cmd-backdrop')
		sheet = E('blu-cmd-sheet')
		statusEl = E('blu-cmd-status')
		noSerialEl = E('blu-cmd-no-serial')
		hasSerialEl = E('blu-cmd-has-serial')
		groupSel = E('blu-cmd-group')
		presetSel = E('blu-cmd-preset')
		sendBtn = E('blu-cmd-send-btn')
		customInput = E('blu-cmd-custom')
		hexCheck = E('blu-cmd-hex-mode')
		crlfCheck = E('blu-cmd-add-crlf')
		sendCustomBtn = E('blu-cmd-send-custom')
		resultEl = E('blu-cmd-result')
		closeBtn = E('blu-cmd-close')
		autoCloseCheck = E('blu-cmd-auto-close')
		return true
	}

	function bindEvents() {
		tab.addEventListener('click', function () { setOpen(true) })
		closeBtn.addEventListener('click', function () { setOpen(false) })
		backdrop.addEventListener('click', function () { setOpen(false) })

		// 跳转串口调试页
		E('blu-cmd-goto-serial').addEventListener('click', function () {
			const rail = document.querySelector('.rail-item[data-view="view-serial"]')
			if (rail) rail.click()
		})

		sendBtn.addEventListener('click', sendPreset)
		sendCustomBtn.addEventListener('click', sendCustom)
		customInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') sendCustom()
		})

		// 分组切换 → 重建条目下拉
		groupSel.addEventListener('change', function () {
			populatePresetItems()
		})

		// Esc 关闭（不干扰全屏 Esc；先于全屏 handler 是因为 capture:true 且 sheet 先关）
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && isOpen) {
				setOpen(false)
			}
		}, true)

		function pillOn(el) {
			return !!(el && el.getAttribute('aria-pressed') === 'true')
		}
		function setPill(el, on) {
			if (!el) return
			el.setAttribute('aria-pressed', on ? 'true' : 'false')
			el.classList.toggle('is-on', !!on)
		}

		// CRLF 开关写全局 addCRLF（与串口页共用同一偏好，两页联动）
		crlfCheck.addEventListener('click', function () {
			const next = !pillOn(crlfCheck)
			setPill(crlfCheck, next)
			if (window.serialApi && typeof window.serialApi.setAddCRLF === 'function') {
				window.serialApi.setAddCRLF(next)
			}
		})

		// HEX 开关绑定全局 hexSend（与串口页 #serial-hex-send 联动；预设发送不受影响）
		hexCheck.addEventListener('click', function () {
			const next = !pillOn(hexCheck)
			setPill(hexCheck, next)
			if (window.serialApi && typeof window.serialApi.setHexSend === 'function') {
				window.serialApi.setHexSend(next)
			}
		})

		// 自动收起开关持久化
		autoCloseCheck.addEventListener('change', function () {
			setAutoClose(autoCloseCheck.checked)
		})

		// 倒计时内用户与面板交互 → 取消自动收起
		sheet.addEventListener('pointerdown', cancelAutoClose, true)
		sheet.addEventListener('keydown', cancelAutoClose, true)
		sheet.addEventListener('focusin', cancelAutoClose, true)
	}

	function observeFullscreen() {
		const viewBlu = E('view-blu')
		if (!viewBlu) return
		const observer = new MutationObserver(function (mutations) {
			for (const m of mutations) {
				if (m.attributeName === 'class') {
					if (viewBlu.classList.contains('blu-wave-fullscreen') && isOpen) {
						setOpen(false, true)
					}
				}
			}
		})
		observer.observe(viewBlu, { attributes: true, attributeFilter: ['class'] })
	}

	function setOpen(open, silent) {
		isOpen = open
		if (open) {
			wrap.classList.add('is-open')
			tab.hidden = true
			backdrop.hidden = false
			sheet.hidden = false
			refreshUI()
		} else {
			wrap.classList.remove('is-open')
			tab.hidden = false
			backdrop.hidden = true
			sheet.hidden = true
		}
		if (!silent) {
			try { localStorage.setItem(STORAGE_KEY, open ? '1' : '0') } catch (e) {}
		}
	}

	function refreshUI() {
		const connected = !!(window.serialApi && window.serialApi.isOpen())
		statusEl.textContent = connected ? '已连接' : '未连接'
		statusEl.className = 'blu-cmd-status ' + (connected ? 'is-connected' : 'is-disconnected')
		noSerialEl.hidden = connected
		hasSerialEl.hidden = !connected
		resultEl.innerHTML = ''
		resultEl.className = 'blu-cmd-result'
		function setPill(el, on) {
			if (!el) return
			el.setAttribute('aria-pressed', on ? 'true' : 'false')
			el.classList.toggle('is-on', !!on)
		}
		// CRLF 开关绑定全局 addCRLF（与串口页共用同一偏好）
		if (crlfCheck && window.serialApi && typeof window.serialApi.getAddCRLF === 'function') {
			setPill(crlfCheck, !!window.serialApi.getAddCRLF())
		}
		// HEX 开关绑定全局 hexSend（与串口页 #serial-hex-send 联动）
		if (hexCheck && window.serialApi && typeof window.serialApi.getHexSend === 'function') {
			setPill(hexCheck, !!window.serialApi.getHexSend())
		}
		// 自动收起开关状态（localStorage 持久化，默认开）
		if (autoCloseCheck) autoCloseCheck.checked = getAutoClose()
		if (connected) populatePresets()
	}

	function populatePresets() {
		let groups = []
		try {
			const raw = localStorage.getItem('quickSendList')
			if (raw) groups = JSON.parse(raw)
		} catch (e) {}
		presetGroups = Array.isArray(groups) ? groups.filter(function (g) { return g && g.list && g.list.length }) : []
		if (!presetGroups.length) {
			groupSel.innerHTML = '<option value="">无快捷发送数据</option>'
			presetSel.innerHTML = '<option value="">无快捷发送数据</option>'
			return
		}
		// 分组下拉（localStorage quickSendList 的组名）
		const keepGroup = groupSel.value
		groupSel.innerHTML = ''
		for (let i = 0; i < presetGroups.length; i++) {
			const opt = document.createElement('option')
			opt.value = String(i)
			opt.textContent = (presetGroups[i].name || '未命名分组').slice(0, 20)
			groupSel.appendChild(opt)
		}
		if (keepGroup !== '' && parseInt(keepGroup, 10) < presetGroups.length) groupSel.value = keepGroup
		populatePresetItems()
	}

	function populatePresetItems() {
		if (!presetGroups.length) return
		const idx = parseInt(groupSel.value, 10)
		const grp = presetGroups[idx >= 0 ? idx : 0] || presetGroups[0]
		const keep = presetSel.value
		presetSel.innerHTML = '<option value="">-- 选择发送内容 --</option>'
		for (const item of grp.list) {
			const opt = document.createElement('option')
			opt.value = JSON.stringify({ c: item.content, h: !!item.hex })
			const label = (item.name || item.content || '未命名').slice(0, 40)
			// 标注格式（来自快捷发送条目自身的 hex 字段）
			opt.textContent = label + (item.hex ? ' (HEX)' : ' (TEXT)')
			presetSel.appendChild(opt)
		}
		if (keep) {
			presetSel.value = keep
			if (presetSel.value !== keep) presetSel.value = ''
		}
	}

	async function sendPreset() {
		const val = presetSel.value
		if (!val) {
			showResult('请先选择发送内容', 'error')
			return
		}
		let parsed
		try { parsed = JSON.parse(val) } catch (e) {
			showResult('发送内容解析失败', 'error')
			return
		}
		if (!parsed.c) {
			showResult('发送内容为空', 'error')
			return
		}
		await doSend(parsed.c, parsed.h)
	}

	async function sendCustom() {
		const text = customInput.value.trim()
		if (!text) {
			showResult('请输入内容', 'error')
			return
		}
		// 自定义发送跟随全局 hexSend（预设发送不受该开关影响）
		const hexOn = !!(window.serialApi && typeof window.serialApi.getHexSend === 'function'
			? window.serialApi.getHexSend()
			: hexCheck && hexCheck.getAttribute('aria-pressed') === 'true')
		await doSend(text, hexOn)
	}

	async function doSend(content, hexMode) {
		if (!window.serialApi || !window.serialApi.isOpen()) {
			showResult('串口未连接', 'error')
			refreshUI()
			return
		}
		try {
			let bytes
			if (hexMode) {
				const cleaned = content.replace(/\s+/g, '')
				if (!/^[0-9A-Fa-f]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
					showResult('HEX 格式错误', 'error')
					return
				}
				const arr = []
				for (let i = 0; i < cleaned.length; i += 2)
					arr.push(parseInt(cleaned.substring(i, i + 2), 16))
				bytes = new Uint8Array(arr)
			} else {
				bytes = new TextEncoder().encode(content)
			}
			// CRLF 不再在此追加: 串口层 writeData 统一按全局 addCRLF 追加（避免双重 0D 0A）
			await window.serialApi.writeData(bytes)
			showResult('发送成功', 'ok')
			armAutoClose()
		} catch (err) {
			showResult('发送失败: ' + (err.message || err), 'error')
		}
	}

	function getAutoClose() {
		try { return localStorage.getItem(AUTO_CLOSE_KEY) !== '0' } catch (e) { return true }
	}

	function setAutoClose(v) {
		try { localStorage.setItem(AUTO_CLOSE_KEY, v ? '1' : '0') } catch (e) {}
		if (!v) cancelAutoClose()
	}

	function cancelAutoClose() {
		if (autoCloseTimer) {
			clearTimeout(autoCloseTimer)
			autoCloseTimer = null
		}
	}

	function armAutoClose() {
		cancelAutoClose()
		if (!autoCloseCheck || !autoCloseCheck.checked) return
		autoCloseTimer = setTimeout(function () {
			autoCloseTimer = null
			setOpen(false)
		}, AUTO_CLOSE_DELAY)
	}

	function showResult(msg, type) {
		if (!resultEl) return
		resultEl.textContent = msg
		resultEl.className = 'blu-cmd-result is-' + (type || 'ok')
		clearTimeout(resultEl._timeout)
		resultEl._timeout = setTimeout(function () {
			resultEl.innerHTML = ''
			resultEl.className = 'blu-cmd-result'
		}, 4000)
	}

	// 公开 API
	window.bluCmdSheet = {
		open: function () { setOpen(true) },
		close: function () { setOpen(false) },
		toggle: function () { setOpen(!isOpen) },
		isOpen: function () { return isOpen }
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init)
	} else {
		init()
	}
})()
