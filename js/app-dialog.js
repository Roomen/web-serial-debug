// 页内对话框：替代 window.alert / confirm / prompt。桌面客户端的 WebView(wry)没有实现 JS 对话框委托，
// 原生 prompt 直接返回 null、confirm 返回 false，调用静默失败，所以全平台统一走这里。
// 都返回 Promise：alert -> undefined，confirm -> boolean，prompt -> string | null(取消)。
// 同一时刻只开一个，后来的排队；Enter 确认、Esc 取消(点遮罩也算取消)，关闭后把焦点还给打开前的元素。
// 它是最上层的模态：层级高于命令面板与登录遮罩(不支持串口的提示在未登录时也得看得见)，打开时先收起命令面板；
// 按键在 window 捕获阶段先到这里，Enter / Esc 只在焦点属于对话框时生效(焦点在外面就拉回来，不确认也不放给页面)，
// 带 ⌘/Ctrl/Alt 的组合键不再传给页面快捷键；焦点移出对话框会被拉回。命令面板与原生菜单经 isOpen() 查询，打开期间不动后台控件。
// 文本一律 textContent。opts: { title, okText, cancelText, danger(确认键红色), maxLength(prompt) }。
;(function (root) {
	'use strict'

	const queue = []
	let current = null

	function mk(tag, cls, text) {
		const el = root.document.createElement(tag)
		if (cls) el.className = cls
		if (text != null) el.textContent = text
		return el
	}

	function show(job) {
		const doc = root.document
		const opener = doc.activeElement
		const mask = mk('div', 'app-dlg-mask')
		const box = mk('div', 'app-dlg')
		box.setAttribute('role', job.kind === 'alert' ? 'alertdialog' : 'dialog')
		box.setAttribute('aria-modal', 'true')
		const titleId = 'app-dlg-title-' + Date.now().toString(36)
		const msgId = titleId + '-msg'
		box.setAttribute('aria-labelledby', titleId)
		box.setAttribute('aria-describedby', msgId)
		const title = mk('div', 'app-dlg-title', job.opts.title || '提示')
		title.id = titleId
		const msg = mk('div', 'app-dlg-msg', job.message)
		msg.id = msgId
		box.appendChild(title)
		box.appendChild(msg)

		let input = null
		if (job.kind === 'prompt') {
			input = mk('input', 'form-control form-control-sm app-dlg-input')
			input.type = 'text'
			input.value = job.defaultValue
			input.setAttribute('autocomplete', 'off')
			input.setAttribute('spellcheck', 'false')
			if (job.opts.maxLength > 0) input.maxLength = job.opts.maxLength
			input.setAttribute('aria-labelledby', msgId)
			box.appendChild(input)
		}

		const actions = mk('div', 'app-dlg-actions')
		let cancelBtn = null
		if (job.kind !== 'alert') {
			cancelBtn = mk('button', 'btn btn-sm btn-outline-secondary', job.opts.cancelText || '取消')
			cancelBtn.type = 'button'
			actions.appendChild(cancelBtn)
		}
		const okBtn = mk('button', 'btn btn-sm ' + (job.opts.danger ? 'btn-danger' : 'btn-primary'), job.opts.okText || '确定')
		okBtn.type = 'button'
		actions.appendChild(okBtn)
		box.appendChild(actions)
		mask.appendChild(box)

		let done = false
		function focusInside() {
			const t = input || okBtn
			try { t.focus() } catch (e) {}
		}
		function finish(ok) {
			if (done) return
			done = true
			root.removeEventListener('keydown', onKey, true)
			doc.removeEventListener('focusin', onFocusIn, true)
			mask.remove()
			let value
			if (job.kind === 'alert') value = undefined
			else if (job.kind === 'confirm') value = !!ok
			else value = ok ? input.value : null
			current = null
			try { if (opener && opener.focus && doc.contains(opener)) opener.focus() } catch (e) {}
			job.resolve(value)
			next()
		}
		function onFocusIn(e) {
			if (!done && e.target && !box.contains(e.target)) focusInside()
		}
		function onKey(e) {
			const inBox = !!(e.target && e.target.nodeType === 1 && box.contains(e.target))
			if (e.key === 'Escape' || (e.key === 'Enter' && !e.isComposing)) {
				e.stopPropagation()
				// 焦点不在对话框里：不替它确认 / 取消，也不让页面收到，焦点拉回来
				if (!inBox) {
					e.preventDefault()
					focusInside()
					return
				}
				// 焦点在取消键上时 Enter 交给按钮自己(按取消处理)；其余(输入框、确认键、对话框本身)都算确认
				if (e.key === 'Enter' && cancelBtn && doc.activeElement === cancelBtn) return
				e.preventDefault()
				finish(e.key === 'Enter')
			} else if (e.metaKey || e.ctrlKey || e.altKey) {
				// 页面快捷键(命令面板、发送、清空日志…)不在对话框后面执行；复制粘贴等默认动作不受影响
				e.stopPropagation()
			} else if (e.key === 'Tab') {
				// 焦点困在对话框内
				const items = Array.prototype.slice.call(box.querySelectorAll('input,button'))
				if (!items.length) return
				const first = items[0]
				const last = items[items.length - 1]
				if (e.shiftKey && (doc.activeElement === first || !box.contains(doc.activeElement))) {
					e.preventDefault()
					last.focus()
				} else if (!e.shiftKey && (doc.activeElement === last || !box.contains(doc.activeElement))) {
					e.preventDefault()
					first.focus()
				}
			}
		}
		okBtn.addEventListener('click', function () { finish(true) })
		if (cancelBtn) cancelBtn.addEventListener('click', function () { finish(false) })
		mask.addEventListener('mousedown', function (e) { if (e.target === mask && job.kind !== 'alert') finish(false) })
		root.addEventListener('keydown', onKey, true)
		doc.addEventListener('focusin', onFocusIn, true)
		current = { finish }
		const pal = root.serialCommandPalette
		if (pal && pal.close) pal.close()
		doc.body.appendChild(mask)
		if (input) {
			input.focus()
			input.select()
		} else {
			okBtn.focus()
		}
	}

	function next() {
		if (current || !queue.length) return
		show(queue.shift())
	}

	function open(kind, message, defaultValue, opts) {
		return new Promise(function (resolve) {
			queue.push({ kind, message: message == null ? '' : String(message), defaultValue: defaultValue == null ? '' : String(defaultValue), opts: opts || {}, resolve })
			next()
		})
	}

	const api = {
		// 有对话框正显示着(排队的下一个会紧接着显示，也算)
		isOpen() { return !!current || queue.length > 0 },
		alert(message, opts) { return open('alert', message, '', opts) },
		confirm(message, opts) { return open('confirm', message, '', opts) },
		prompt(message, defaultValue, opts) { return open('prompt', message, defaultValue, opts) },
	}

	if (typeof module !== 'undefined' && module.exports) module.exports = api
	if (root.document && root.navigator) root.AppDialog = api
})(typeof window !== 'undefined' ? window : globalThis)
