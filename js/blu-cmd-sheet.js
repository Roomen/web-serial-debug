/**
 * BLU 串口发送覆盖面板
 * 在功耗分析页底部以 overlay 形式提供串口发送能力
 * 走 DUT 串口（window.serialApi），不走 BLU 分析仪口
 */

;(function () {
	'use strict'

	const STORAGE_KEY = 'bluCmdSheetOpen'
	let isOpen = false

	// DOM refs
	let wrap, tab, backdrop, sheet, statusEl, noSerialEl, hasSerialEl
	let presetSel, sendBtn, customInput, hexCheck, crlfCheck, sendCustomBtn, resultEl, closeBtn

	function E(id) { return document.getElementById(id) }

	function init() {
		if (E('blu-cmd-sheet-wrap')) return
		buildDOM()
		bindEvents()

		// 恢复上次展开状态
		let startOpen = false
		try { startOpen = localStorage.getItem(STORAGE_KEY) === '1' } catch (e) {}
		setOpen(startOpen, true)

		observeFullscreen()
	}

	function buildDOM() {
		const viewBlu = E('view-blu')
		if (!viewBlu) return

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
						'<div class="blu-cmd-row">' +
							'<select id="blu-cmd-preset" class="form-select form-select-sm" title="从快捷发送列表选择">' +
								'<option value="">-- 选择发送内容 --</option>' +
							'</select>' +
							'<button class="btn btn-sm btn-primary blu-cmd-send-btn" id="blu-cmd-send-btn" title="发送选中内容">下发</button>' +
						'</div>' +
						'<div class="blu-cmd-row blu-cmd-custom-row">' +
							'<div class="blu-cmd-custom-input-wrap">' +
								'<input type="text" id="blu-cmd-custom" class="form-control form-control-sm" placeholder="或输入 HEX / 文本…" autocomplete="off" spellcheck="false">' +
								'<div class="form-check form-switch blu-cmd-hex-switch">' +
									'<input class="form-check-input" type="checkbox" id="blu-cmd-hex-mode" checked>' +
									'<label class="form-check-label" for="blu-cmd-hex-mode">HEX</label>' +
								'</div>' +
								'<div class="form-check form-switch blu-cmd-hex-switch">' +
									'<input class="form-check-input" type="checkbox" id="blu-cmd-add-crlf">' +
									'<label class="form-check-label" for="blu-cmd-add-crlf">末尾加回车换行</label>' +
								'</div>' +
							'</div>' +
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
		presetSel = E('blu-cmd-preset')
		sendBtn = E('blu-cmd-send-btn')
		customInput = E('blu-cmd-custom')
		hexCheck = E('blu-cmd-hex-mode')
		crlfCheck = E('blu-cmd-add-crlf')
		sendCustomBtn = E('blu-cmd-send-custom')
		resultEl = E('blu-cmd-result')
		closeBtn = E('blu-cmd-close')
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

		// Esc 关闭（不干扰全屏 Esc；先于全屏 handler 是因为 capture:true 且 sheet 先关）
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && isOpen) {
				setOpen(false)
			}
		}, true)
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
		if (connected) populatePresets()
	}

	function populatePresets() {
		const keep = presetSel.value
		presetSel.innerHTML = '<option value="">-- 选择发送内容 --</option>'
		let groups = []
		try {
			const raw = localStorage.getItem('quickSendList')
			if (raw) groups = JSON.parse(raw)
		} catch (e) {}
		if (!Array.isArray(groups) || !groups.length) {
			presetSel.innerHTML = '<option value="">无快捷发送数据</option>'
			return
		}
		for (const grp of groups) {
			if (!grp.list || !grp.list.length) continue
			const og = document.createElement('optgroup')
			og.label = grp.name || '未命名分组'
			for (const item of grp.list) {
				const opt = document.createElement('option')
				opt.value = JSON.stringify({ c: item.content, h: !!item.hex })
				const label = (item.name || item.content || '未命名').slice(0, 40)
				opt.textContent = label
				og.appendChild(opt)
			}
			presetSel.appendChild(og)
		}
		if (keep) presetSel.value = keep
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
		await doSend(text, hexCheck.checked)
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
			// 与串口页 writeData 一致：TEXT/HEX 转换后的字节末尾追加 0D 0A
			if (crlfCheck && crlfCheck.checked) {
				const withCrlf = new Uint8Array(bytes.length + 2)
				withCrlf.set(bytes)
				withCrlf[bytes.length] = 0x0d
				withCrlf[bytes.length + 1] = 0x0a
				bytes = withCrlf
			}
			await window.serialApi.writeData(bytes)
			showResult('发送成功', 'ok')
		} catch (err) {
			showResult('发送失败: ' + (err.message || err), 'error')
		}
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
