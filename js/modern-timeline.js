// 现代布局的双路时间线(双路视图选「气泡」时)：两列气泡 + 中间时间轴列(时间戳、距上一条的 Δ、静默分隔)。
// 派生数据只写成日志行上的 data-mdn-* 属性，由 css 的伪元素显示：行本身的 DOM 结构不变，容器里不插任何兄弟节点，
// 所以裁剪行数(按子节点数)、复制/保存(逐子节点读文本)、历史重渲都不受影响。
// 持久化：日志整份 innerHTML 会存进 sessionStorage，common.js 的 paneHtml 经 window.serialLogPersistClean 去掉全部 data-mdn-* 再存，
// 刷新后恢复的行没有这些属性，进入本模块时整体重算。切回经典布局时把属性清干净，DOM 与进入前一致。
// 纯函数(时间格式、Δ/静默/慢应答/应答区间)同时导出给 node 回归测试，不碰 DOM。
;(function () {
	'use strict'
	const root = typeof window !== 'undefined' ? window : globalThis

	// ---- 纯函数 ----

	const SLOW_MS = 1000 // RX 距本路待应答 TX 超过它算慢应答
	const GAP_MS = 2000 // 相邻两条(A/B 收发行)间隔超过它插入「静默」分隔

	function pad(n, w) {
		let s = String(n)
		while (s.length < w) s = '0' + s
		return s
	}

	/** 本地时间 HH:MM:SS.mmm */
	function fmtClock(ts) {
		const d = new Date(ts)
		return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3)
	}

	/** Δ：+31 ms / +1.47 s / +12.3 s */
	function fmtDelta(ms) {
		ms = Math.max(0, Math.round(ms))
		if (ms < 1000) return '+' + ms + ' ms'
		if (ms < 10000) return '+' + (ms / 1000).toFixed(2) + ' s'
		return '+' + (ms / 1000).toFixed(1) + ' s'
	}

	/** 静默时长：4.6 s / 2 min 5 s */
	function fmtGap(ms) {
		ms = Math.max(0, ms)
		if (ms < 60000) return (ms / 1000).toFixed(1) + ' s'
		const t = Math.round(ms / 1000)
		const m = Math.floor(t / 60)
		if (m < 60) return m + ' min ' + (t % 60) + ' s'
		return Math.floor(m / 60) + ' h ' + (m % 60) + ' min'
	}

	function isLane(it, lanes) {
		return !!it && lanes.indexOf(it.sid) !== -1 && (it.dir === 'tx' || it.dir === 'rx')
	}

	function newState() {
		return { n: 0, prevTs: null, pending: {} }
	}

	/**
	 * 逐条算时间轴派生数据。items: [{ sid, dir, ts }]；只有 A/B 路的 tx/rx 行参与(系统行等 lane=false，不占 Δ 也不打断)。
	 * 返回与 items 等长的数组：{ lane, t, d, slow, gap, req }
	 *  t: 时钟；d: 距上一条(参与的行)的 Δ，空串表示第一条或紧跟静默之后；gap: 与上一条间隔超过 gapMs 时的静默文本
	 *  slow: RX 是本路待应答 TX 之后的第一条 RX 且距该 TX 超过 slowMs，此时 d 改显应答耗时(而不是距上一条)
	 *  req: 该 RX 对应的请求 TX 在 items 里的下标(只有「TX 后的第一条 RX」有)，否则 -1
	 * state 可跨批次传入，给增量计算用(req 为 state.n 起算的绝对序号，整段重算时就是下标)
	 */
	function compute(items, opts, state) {
		opts = opts || {}
		const lanes = opts.lanes || ['A', 'B']
		const slowMs = opts.slowMs != null ? opts.slowMs : SLOW_MS
		const gapMs = opts.gapMs != null ? opts.gapMs : GAP_MS
		const st = state || newState()
		const out = []
		for (let i = 0; i < items.length; i++) {
			const it = items[i]
			const abs = st.n++
			const r = { lane: false, t: '', d: '', slow: false, gap: '', req: -1 }
			out.push(r)
			if (!isLane(it, lanes)) continue
			r.lane = true
			r.t = fmtClock(it.ts)
			if (st.prevTs != null) {
				const dt = Math.max(0, it.ts - st.prevTs)
				if (dt > gapMs) r.gap = fmtGap(dt)
				else r.d = fmtDelta(dt)
			}
			if (it.dir === 'tx') {
				st.pending[it.sid] = { ts: it.ts, idx: abs }
			} else {
				const p = st.pending[it.sid]
				if (p) {
					st.pending[it.sid] = null
					r.req = p.idx
					const lat = Math.max(0, it.ts - p.ts)
					if (lat > slowMs) {
						r.slow = true
						r.d = fmtDelta(lat)
					}
				}
			}
			st.prevTs = it.ts
		}
		return out
	}

	/**
	 * 选中第 idx 条时的「一次交互」区间(含两端，覆盖其间两路所有行，包括系统行)：
	 *  TX：到本路下一条应答(TX 之后第一条 RX)；还没等到应答就只有它自己
	 *  RX：从它所应答的请求 TX 到它；不是 TX 后第一条 RX(持续上报等)就只有它自己
	 * 非 A/B 收发行返回 null。res 是 compute(items) 的整段结果
	 */
	function exchange(items, res, idx, opts) {
		opts = opts || {}
		const lanes = opts.lanes || ['A', 'B']
		const it = items[idx]
		if (!isLane(it, lanes) || !res[idx]) return null
		if (it.dir === 'rx') {
			const q = res[idx].req
			return q >= 0 && q <= idx ? { start: q, end: idx } : { start: idx, end: idx }
		}
		for (let j = idx + 1; j < items.length; j++) {
			if (res[j] && res[j].req === idx) return { start: idx, end: j }
			// 本路又发了新请求：这一笔没有应答
			if (items[j] && items[j].dir === 'tx' && items[j].sid === it.sid && lanes.indexOf(items[j].sid) !== -1) break
		}
		return { start: idx, end: idx }
	}

	const api = {
		SLOW_MS, GAP_MS, fmtClock, fmtDelta, fmtGap, newState, compute, exchange,
	}
	root.ModernTimeline = api

	// 去掉持久化文本里的派生属性(common.js 的 paneHtml 在存 sessionStorage 前调用)
	root.serialLogPersistClean = function (html) {
		return typeof html === 'string' && html.indexOf('data-mdn-') !== -1 ? html.replace(/ data-mdn-[a-z-]+="[^"]*"/g, '') : html
	}

	// ---- 界面：只在浏览器里挂 ----
	if (typeof document === 'undefined') return

	const ATTRS = ['data-mdn-t', 'data-mdn-d', 'data-mdn-slow', 'data-mdn-gap', 'data-mdn-band']
	let container = null
	let observer = null
	let head = null
	let headTimer = 0
	let sizeObserver = null
	let active = false
	// 增量计算的进度：处理到哪一行、当时的跨行状态
	let tailRow = null
	let tailState = null
	let bandRows = []
	let bandOpen = false // 选中的是还在等应答的 TX：新行到达时要重算区间
	let raf = 0

	function isModern() {
		return document.documentElement.dataset.layout === 'modern'
	}

	function laneRows() {
		const out = []
		if (!container) return out
		for (let i = 0; i < container.children.length; i++) {
			const n = container.children[i]
			if (n.classList && n.classList.contains('log-row')) out.push(n)
		}
		return out
	}

	function itemOf(row) {
		return { sid: row.getAttribute('data-sid') || '', dir: row.getAttribute('data-dir') || '', ts: parseInt(row.getAttribute('data-ts'), 10) || 0 }
	}

	function setAttr(el, name, v) {
		if (v) {
			if (el.getAttribute(name) !== v) el.setAttribute(name, v)
		} else if (el.hasAttribute(name)) {
			el.removeAttribute(name)
		}
	}

	function writeRow(row, r) {
		// 非 A/B 收发行(系统行等)不挂派生属性
		setAttr(row, 'data-mdn-t', r.lane ? r.t : '')
		setAttr(row, 'data-mdn-d', r.d)
		setAttr(row, 'data-mdn-slow', r.slow ? '1' : '')
		// 静默文本挂在行首的 .log-time 上：它的 ::before 在气泡上方的轴列里画分隔胶囊(伪元素只能读自己宿主的属性)
		const tm = row.firstElementChild
		if (tm && tm.classList.contains('log-time')) setAttr(tm, 'data-mdn-gap', r.gap)
	}

	function clearRow(row) {
		ATTRS.forEach(function (a) { row.removeAttribute(a) })
		const tm = row.firstElementChild
		if (tm) tm.removeAttribute('data-mdn-gap')
	}

	function clearAll() {
		if (!container) return
		for (let i = 0; i < container.children.length; i++) clearRow(container.children[i])
		tailRow = null
		tailState = null
		bandRows = []
	}

	function fullCompute() {
		const rows = laneRows()
		tailState = newState()
		const res = compute(rows.map(itemOf), null, tailState)
		for (let i = 0; i < rows.length; i++) writeRow(rows[i], res[i])
		tailRow = rows.length ? rows[rows.length - 1] : null
	}

	// 尾部追加走增量；中间插入(按时间戳排序到前面)、头部之外的删除、整体重绘都整段重算
	function process(records) {
		if (!active || !container) return
		let full = !tailRow || !tailRow.isConnected || tailRow.parentNode !== container || !tailState
		if (!full) {
			for (let i = 0; i < records.length && !full; i++) {
				const added = records[i].addedNodes
				for (let j = 0; j < added.length; j++) {
					const n = added[j]
					if (n.nodeType === 1 && n.isConnected && !(tailRow.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) { full = true; break }
				}
			}
		}
		if (full) {
			fullCompute()
		} else {
			const fresh = []
			for (let n = tailRow.nextElementSibling; n; n = n.nextElementSibling) {
				if (n.classList.contains('log-row')) fresh.push(n)
			}
			if (fresh.length) {
				const res = compute(fresh.map(itemOf), null, tailState)
				for (let i = 0; i < fresh.length; i++) writeRow(fresh[i], res[i])
				tailRow = fresh[fresh.length - 1]
			}
		}
		// 头部被裁剪后，现在的第一条没有「上一条」：去掉它指向已删行的 Δ / 静默
		const first = container.firstElementChild
		if (first && first.classList.contains('log-row')) {
			first.removeAttribute('data-mdn-d')
			first.removeAttribute('data-mdn-slow')
			const tm = first.firstElementChild
			if (tm) tm.removeAttribute('data-mdn-gap')
		}
		if (full || bandOpen) scheduleBand()
	}

	// ---- 选中帧的底带 ----

	function applyBand() {
		raf = 0
		bandRows.forEach(function (r) { r.removeAttribute('data-mdn-band') })
		bandRows = []
		bandOpen = false
		if (!active || !container) return
		const sel = container.querySelector('.log-row.selected')
		if (!sel) return
		const rows = laneRows()
		const items = rows.map(itemOf)
		const res = compute(items)
		const idx = rows.indexOf(sel)
		const ex = idx >= 0 ? exchange(items, res, idx) : null
		if (!ex) return
		for (let i = ex.start; i <= ex.end; i++) {
			rows[i].setAttribute('data-mdn-band', '1')
			bandRows.push(rows[i])
		}
		bandOpen = items[idx].dir === 'tx' && ex.end === ex.start
	}

	function scheduleBand() {
		if (raf) return
		raf = requestAnimationFrame(applyBand)
	}

	// ---- 吸顶列头 ----

	function laneLabel(sid) {
		const hub = root.SerialHub
		try {
			return hub ? (sid === 'A' ? hub.getLabelA() : hub.getLabelB()) : sid
		} catch (e) { return sid }
	}

	// 「A · 协议口」；路名本身就以 A 开头(默认的「A路」)时不再重复路标
	function laneText(sid) {
		const l = String(laneLabel(sid) || '')
		return !l ? sid : (l.charAt(0).toUpperCase() === sid ? l : sid + ' · ' + l)
	}

	function buildHead() {
		if (head || !container || !container.parentNode) return
		head = document.createElement('div')
		head.id = 'mdn-tl-head'
		head.setAttribute('aria-hidden', 'true')
		const a = document.createElement('span')
		a.className = 'mdn-tl-a'
		const m = document.createElement('span')
		m.className = 'mdn-tl-m'
		m.textContent = '时间 / Δ'
		const b = document.createElement('span')
		b.className = 'mdn-tl-b'
		head.append(a, m, b)
		container.parentNode.insertBefore(head, container)
		syncHead()
		headTimer = setInterval(syncHead, 1000)
		if (typeof ResizeObserver !== 'undefined') {
			sizeObserver = new ResizeObserver(syncHead)
			sizeObserver.observe(container)
		}
	}

	function syncHead() {
		if (!head || !container) return
		const a = head.firstElementChild
		const b = head.lastElementChild
		const ta = laneText('A')
		const tb = laneText('B')
		if (a.textContent !== ta) a.textContent = ta
		if (b.textContent !== tb) b.textContent = tb
		// 列头与日志区的网格对齐：右侧让出滚动条宽度
		const sbw = Math.max(0, container.offsetWidth - container.clientWidth)
		head.style.setProperty('--mdn-sbw', sbw + 'px')
	}

	function destroyHead() {
		clearInterval(headTimer)
		headTimer = 0
		if (sizeObserver) sizeObserver.disconnect()
		sizeObserver = null
		if (head) head.remove()
		head = null
	}

	// ---- 启停：只在现代布局里工作 ----

	function start() {
		if (active) return
		container = document.getElementById('serial-logs-dual')
		if (!container) return
		active = true
		buildHead()
		fullCompute()
		scheduleBand()
		observer = new MutationObserver(process)
		observer.observe(container, { childList: true })
	}

	function stop() {
		if (!active) return
		active = false
		if (observer) observer.disconnect()
		observer = null
		if (raf) cancelAnimationFrame(raf)
		raf = 0
		clearAll()
		destroyHead()
		container = null
	}

	function sync() {
		if (isModern()) start()
		else stop()
	}

	// serial-layout-move 在 DOM 搬运阶段派发，此时 data-layout 已是新值
	document.addEventListener('serial-layout-move', sync)
	document.addEventListener('serial-log-select', function () { if (active) scheduleBand() })
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync)
	else sync()
})()
