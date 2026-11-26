// 串口终端：xterm.js 胶水。每个会话最多一个 Terminal。
// 通过 window.SerialTerm 暴露：ensure / write / clear / fit / setTheme / getText / dispose / setInputEnabled（键盘输入总开关）/ setFitSuspended（暂停 fit）/ size
;(function () {
	'use strict'

	const terms = Object.create(null)
	const PENDING_MAX = 1024 * 1024
	const WRITE_CHUNK = 16 * 1024

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
	const SCROLLBACK = 5000
	// 宿主内容高度至少放得下这么多行才 fit；更矮（收起的通信记录条、被压扁的布局）时保持原行列数
	const MIN_FIT_ROWS = 2
	// 外部明确要求暂停 fit（设备面板收起通信记录条期间）；恢复时补 fit
	let fitSuspended = false
	// 终端键盘输入总开关：设备面板子视图里通信记录条只用来看，键入 / 粘贴不能写口（终端实例、接收与滚动照旧）
	let inputEnabled = true

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
		let next = 1
		link.onerror = function () {
			if (next < CDN_CSS.length) link.href = CDN_CSS[next++]
			else link.onerror = null
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

	// 宿主内容区（去掉内边距）的高度；宿主或祖先 display:none 时没有布局盒，返回 0
	function contentHeight(el) {
		if (!el.getClientRects().length) return 0
		const cs = getComputedStyle(el)
		return el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0)
	}
	function cellHeight(rec) {
		const o = rec.term.options || {}
		return (o.fontSize || 13) * (o.lineHeight || 1.2)
	}
	// 不可见、被暂停或高度放不下 MIN_FIT_ROWS 行时不 fit：FitAddon 会把终端缩到 1 行，
	// 而 xterm 缩行时缓冲区上限（scrollback + rows）跟着变小，超出的最早历史被裁掉，再放大也找不回。
	// 不要靠宿主内边距去碰 offsetHeight 门槛，判据是内容高度能不能放下若干行。
	function fit(sid) {
		const rec = recOf(sid)
		if (!rec || !rec.fit || !rec.host || !rec.term) return
		if (fitSuspended || rec.host.hidden || rec.host.offsetWidth < 4) return
		if (contentHeight(rec.host) < MIN_FIT_ROWS * cellHeight(rec)) return
		let next = null
		try { next = rec.fit.proposeDimensions() } catch (e) { next = null }
		if (!next || !(next.rows > 0) || !(next.cols > 0)) return
		// 缓冲区总容量（scrollback + rows）保持不变：行数变少时先把少掉的行数补进 scrollback，
		// 否则正常缩矮（通信记录条 120px 只放得下几行）也会在历史满时裁掉最早的行
		rec.maxRows = Math.max(rec.maxRows || 0, rec.term.rows, next.rows)
		const want = SCROLLBACK + (rec.maxRows - next.rows)
		try {
			if (want > rec.term.options.scrollback) rec.term.options.scrollback = want
			rec.fit.fit()
			if (rec.term.options.scrollback !== want) rec.term.options.scrollback = want
		} catch (e) { /* ignore */ }
	}

	function fitAll() {
		Object.keys(terms).forEach(function (k) { fit(k) })
	}

	function setFitSuspended(v) {
		const was = fitSuspended
		fitSuspended = !!v
		if (was && !fitSuspended) setTimeout(fitAll, 0)
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
			disableStdin: !inputEnabled,
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
			fontSize: 13,
			lineHeight: 1.2,
			scrollback: SCROLLBACK,
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
			queue: [], pending: 0, writing: false, dropped: 0, reported: 0, reportTimer: null, disposed: false,
		}
		terms[sid] = rec
		term.onData(function (str) {
			if (!inputEnabled || !rec.onSend) return
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

	function reportDrop(sid, rec, count) {
		rec.dropped += count
		if (rec.reportTimer != null) return
		rec.reportTimer = setTimeout(function () {
			rec.reportTimer = null
			if (rec.disposed) return
			const delta = rec.dropped - rec.reported
			rec.reported = rec.dropped
			window.dispatchEvent(new CustomEvent('serial-term-overflow', { detail: { sid, bytes: delta, total: rec.dropped } }))
		}, 1000)
	}
	function pump(sid, rec) {
		if (rec.disposed || rec.writing || !rec.queue.length) return
		const chunk = rec.queue.shift()
		rec.writing = true
		let done = false
		function finish() {
			if (done) return
			done = true
			rec.pending -= chunk.length
			rec.writing = false
			if (rec.clearPending && !rec.disposed) {
				rec.clearPending = false
				try { rec.term.reset() } catch (e) {}
			}
			pump(sid, rec)
		}
		try { rec.term.write(chunk, finish) } catch (e) { reportDrop(sid, rec, chunk.length); finish() }
	}
	function write(sid, bytes) {
		const rec = recOf(sid)
		if (!rec || !rec.term || bytes == null) return
		const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
		if (!u8.length) return
		const accepted = Math.min(u8.length, PENDING_MAX - rec.pending)
		for (let i = 0; i < accepted; i += WRITE_CHUNK) rec.queue.push(u8.slice(i, Math.min(accepted, i + WRITE_CHUNK)))
		rec.pending += accepted
		if (accepted < u8.length) reportDrop(sid, rec, u8.length - accepted)
		pump(sid, rec)
	}

	function clear(sid) {
		const rec = recOf(sid)
		if (!rec || !rec.term) return
		const queued = rec.queue.reduce(function (sum, chunk) { return sum + chunk.length }, 0)
		rec.queue.length = 0
		rec.pending -= queued
		rec.clearPending = rec.writing
		try { rec.term.reset() } catch (e) { /* ignore */ }
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
			rec.disposed = true
			rec.queue.length = 0
			clearTimeout(rec.reportTimer)
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

	function setInputEnabled(v) {
		inputEnabled = !!v
		Object.keys(terms).forEach(function (k) {
			const rec = terms[k]
			if (rec && rec.term) {
				try { rec.term.options.disableStdin = !inputEnabled } catch (e) { /* ignore */ }
			}
		})
	}

	window.SerialTerm = {
		setInputEnabled: setInputEnabled,
		setFitSuspended: setFitSuspended,
		// 当前行列数（自检用）：{ rows, cols }，没有实例时 null
		size: function (sid) {
			const rec = recOf(sid)
			return rec && rec.term ? { rows: rec.term.rows, cols: rec.term.cols } : null
		},
		inputEnabled: function () { return inputEnabled },
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
