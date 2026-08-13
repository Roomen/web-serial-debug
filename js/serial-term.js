// 串口终端：xterm.js 胶水。每个会话最多一个 Terminal。
// 通过 window.SerialTerm 暴露：ensure / write / clear / fit / setTheme / getText / dispose
;(function () {
	'use strict'

	const terms = Object.create(null)

	const CDN_XTERM = [
		'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js',
		'https://unpkg.com/@xterm/xterm@5.5.0/lib/xterm.min.js',
		'https://cdn.bootcdn.net/ajax/libs/xterm/5.5.0/lib/xterm.min.js',
	]
	const CDN_FIT = [
		'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js',
		'https://unpkg.com/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js',
		'https://cdn.bootcdn.net/ajax/libs/xterm-addon-fit/0.10.0/addon-fit.min.js',
	]
	const CDN_CSS = [
		'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css',
		'https://unpkg.com/@xterm/xterm@5.5.0/css/xterm.css',
		'https://cdn.bootcdn.net/ajax/libs/xterm/5.5.0/css/xterm.min.css',
	]

	let loadPromise = null

	function loadScript(src) {
		return new Promise(function (resolve, reject) {
			const s = document.createElement('script')
			s.src = src
			s.async = true
			s.onload = function () { resolve() }
			s.onerror = function () { reject(new Error('load fail: ' + src)) }
			document.head.appendChild(s)
		})
	}

	function ensureCss() {
		if (document.getElementById('serial-term-xterm-css')) return
		const link = document.createElement('link')
		link.id = 'serial-term-xterm-css'
		link.rel = 'stylesheet'
		link.href = CDN_CSS[0]
		link.onerror = function () {
			if (CDN_CSS[1] && link.href.indexOf('jsdelivr') !== -1) link.href = CDN_CSS[1]
			else if (CDN_CSS[2]) link.href = CDN_CSS[2]
		}
		document.head.appendChild(link)
	}

	function hasTerminal() {
		return typeof window.Terminal === 'function'
	}

	function FitCtor() {
		if (window.FitAddon && typeof window.FitAddon.FitAddon === 'function') return window.FitAddon.FitAddon
		if (typeof window.FitAddon === 'function') return window.FitAddon
		return null
	}

	function ensureLib() {
		if (hasTerminal()) return Promise.resolve(true)
		if (loadPromise) return loadPromise
		ensureCss()
		loadPromise = (async function () {
			if (!hasTerminal()) {
				let ok = false
				for (let i = 0; i < CDN_XTERM.length; i++) {
					try {
						await loadScript(CDN_XTERM[i])
						if (hasTerminal()) { ok = true; break }
					} catch (e) { /* next */ }
				}
				if (!ok) {
					console.error('[serial-term] xterm.js CDN 全部失败')
					return false
				}
			}
			if (!FitCtor()) {
				for (let i = 0; i < CDN_FIT.length; i++) {
					try {
						await loadScript(CDN_FIT[i])
						if (FitCtor()) break
					} catch (e) { /* next */ }
				}
			}
			return hasTerminal()
		})()
		return loadPromise
	}

	function themeOf() {
		const dark = document.documentElement.getAttribute('data-theme') === 'dark'
		if (dark) {
			return {
				background: '#1c1c1e',
				foreground: '#f5f5f7',
				cursor: '#f5f5f7',
				cursorAccent: '#1c1c1e',
				selectionBackground: 'rgba(10, 132, 255, 0.35)',
				black: '#1c1c1e',
				red: '#ff453a',
				green: '#30d158',
				yellow: '#ffd60a',
				blue: '#0a84ff',
				magenta: '#bf5af2',
				cyan: '#64d2ff',
				white: '#f5f5f7',
				brightBlack: '#636366',
				brightRed: '#ff6961',
				brightGreen: '#30db5b',
				brightYellow: '#ffd426',
				brightBlue: '#409cff',
				brightMagenta: '#da8fff',
				brightCyan: '#70d7ff',
				brightWhite: '#ffffff',
			}
		}
		return {
			background: '#f5f5f7',
			foreground: '#1c1c1e',
			cursor: '#1c1c1e',
			cursorAccent: '#f5f5f7',
			selectionBackground: 'rgba(0, 122, 255, 0.28)',
			black: '#1c1c1e',
			red: '#ff3b30',
			green: '#34c759',
			yellow: '#ffcc00',
			blue: '#007aff',
			magenta: '#af52de',
			cyan: '#32ade6',
			white: '#f5f5f7',
			brightBlack: '#8e8e93',
			brightRed: '#ff453a',
			brightGreen: '#30d158',
			brightYellow: '#ffd60a',
			brightBlue: '#0a84ff',
			brightMagenta: '#bf5af2',
			brightCyan: '#64d2ff',
			brightWhite: '#ffffff',
		}
	}

	function recOf(id) {
		return id ? terms[id] || null : null
	}

	function fit(sid) {
		const rec = recOf(sid)
		if (!rec || !rec.fit || !rec.host) return
		if (rec.host.hidden || rec.host.offsetWidth < 4 || rec.host.offsetHeight < 4) return
		try { rec.fit.fit() } catch (e) { /* ignore */ }
	}

	function setTheme(sid) {
		if (sid == null) {
			Object.keys(terms).forEach(function (k) { setTheme(k) })
			return
		}
		const rec = recOf(sid)
		if (!rec || !rec.term) return
		try { rec.term.options.theme = themeOf() } catch (e) { /* ignore */ }
	}

	function bindThemeWatch() {
		if (bindThemeWatch.done) return
		bindThemeWatch.done = true
		try {
			new MutationObserver(function () { setTheme() }).observe(document.documentElement, {
				attributes: true,
				attributeFilter: ['data-theme'],
			})
		} catch (e) { /* ignore */ }
	}

	function openTerm(sid, hostEl, opts) {
		if (!sid || !hasTerminal() || !hostEl) return null
		const existing = recOf(sid)
		if (existing && existing.term) {
			if (opts) {
				if (typeof opts.onSend === 'function') existing.onSend = opts.onSend
				if (typeof opts.onFocus === 'function') existing.onFocus = opts.onFocus
			}
			if (existing.host !== hostEl) {
				// 宿主未变是常态；换宿主不重建，避免丢掉缓冲
			}
			requestAnimationFrame(function () { fit(sid) })
			return existing.term
		}
		const term = new window.Terminal({
			convertEol: false,
			cursorBlink: true,
			disableStdin: false,
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
			fontSize: 13,
			lineHeight: 1.2,
			scrollback: 5000,
			theme: themeOf(),
		})
		const Ctor = FitCtor()
		let fitAddon = null
		if (Ctor) {
			fitAddon = new Ctor()
			term.loadAddon(fitAddon)
		}
		term.open(hostEl)
		const rec = {
			term: term,
			fit: fitAddon,
			host: hostEl,
			onSend: opts && typeof opts.onSend === 'function' ? opts.onSend : null,
			onFocus: opts && typeof opts.onFocus === 'function' ? opts.onFocus : null,
			ro: null,
		}
		terms[sid] = rec
		term.onData(function (str) {
			if (!rec.onSend) return
			try { rec.onSend(new TextEncoder().encode(str)) } catch (e) { /* ignore */ }
		})
		if (term.element) {
			term.element.addEventListener('focusin', function () {
				if (typeof rec.onFocus === 'function') rec.onFocus(sid)
			})
			term.element.addEventListener('mousedown', function () {
				if (typeof rec.onFocus === 'function') rec.onFocus(sid)
			})
		}
		if (typeof ResizeObserver === 'function') {
			rec.ro = new ResizeObserver(function () { fit(sid) })
			rec.ro.observe(hostEl)
		}
		bindThemeWatch()
		requestAnimationFrame(function () { fit(sid) })
		return term
	}

	function ensure(sid, hostEl, opts) {
		if (!sid) return Promise.resolve(null)
		if (hasTerminal()) return Promise.resolve(openTerm(sid, hostEl, opts))
		return ensureLib().then(function (ok) {
			if (!ok) return null
			return openTerm(sid, hostEl, opts)
		})
	}

	function write(sid, bytes) {
		const rec = recOf(sid)
		if (!rec || !rec.term || bytes == null) return
		const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
		if (!u8.length) return
		try { rec.term.write(u8) } catch (e) { /* ignore */ }
	}

	function clear(sid) {
		const rec = recOf(sid)
		if (!rec || !rec.term) return
		try { rec.term.clear() } catch (e) { /* ignore */ }
	}

	function getText(sid) {
		const rec = recOf(sid)
		if (!rec || !rec.term) return ''
		try {
			const buf = rec.term.buffer.active
			const lines = []
			for (let i = 0; i < buf.length; i++) {
				const line = buf.getLine(i)
				lines.push(line ? line.translateToString(true) : '')
			}
			return lines.join('\n').replace(/\s+$/g, '')
		} catch (e) {
			return ''
		}
	}

	function dispose(sid) {
		function drop(id) {
			const rec = recOf(id)
			if (!rec) return
			try { if (rec.ro) rec.ro.disconnect() } catch (e) { /* ignore */ }
			try { if (rec.term) rec.term.dispose() } catch (e) { /* ignore */ }
			delete terms[id]
		}
		if (sid == null) {
			Object.keys(terms).forEach(drop)
			return
		}
		drop(sid)
	}

	window.SerialTerm = {
		ensure: ensure,
		write: write,
		clear: clear,
		fit: fit,
		setTheme: setTheme,
		getText: getText,
		dispose: dispose,
	}

	window.addEventListener('beforeunload', function () {
		dispose()
	})
	window.addEventListener('resize', function () {
		Object.keys(terms).forEach(fit)
	})
})()
