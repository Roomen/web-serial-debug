// 聊天视图(日志工具条选「聊天」时的气泡)：双路 A 靠左、B 靠右；单路 RX(接收)靠左、TX(发送)靠右，系统行居中。
// 时间戳与 Δ 在气泡旁，静默分隔在气泡上方。单路与双路两个日志容器都挂(各自一份 observer / tail / 选中底带状态)。
// 派生数据只写成日志行上的 data-mdn-* 属性，由 css 的伪元素显示：行本身的 DOM 结构不变，容器里不插任何兄弟节点，
// 所以裁剪行数(按子节点数)、复制/保存(逐子节点读文本)、历史重渲都不受影响。
// 持久化：日志整份 innerHTML 会存进 sessionStorage，common.js 的 paneHtml 经 window.serialLogPersistClean 去掉全部 data-mdn-* 再存，
// 刷新后恢复的行没有这些属性，启动时整体重算。
// 纯函数(时间格式、Δ/静默/慢应答/应答区间)同时导出给 node 回归测试，不碰 DOM。
;(function () {
	'use strict'
	const root = typeof window !== 'undefined' ? window : globalThis

	// ---- 纯函数 ----

	const SLOW_MS = 1000 // RX 距本路待应答 TX 超过它算慢应答
	const GAP_MS = 2000 // 相邻两条(收发行)间隔超过它插入「静默」分隔

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

	// 参与派生计算的路：双路 A/B、单路 S。其余行(系统行等)不占 Δ 也不打断静默
	const DUAL_LANES = ['A', 'B']
	const SINGLE_LANES = ['S']

	/** 按行所属的容器推参与路：双路容器 A/B、单路容器 S(外部不再写死) */
	function lanesForSid(sid) {
		return sid === 'A' || sid === 'B' ? DUAL_LANES : SINGLE_LANES
	}

	function isLane(it, lanes) {
		return !!it && lanes.indexOf(it.sid) !== -1 && (it.dir === 'tx' || it.dir === 'rx')
	}

	function newState() {
		return { n: 0, prevTs: null, pending: {} }
	}

	/**
	 * 逐条算时间轴派生数据。items: [{ sid, dir, ts }]；只有参与路的 tx/rx 行算(系统行等 lane=false，不占 Δ 也不打断)。
	 * 返回与 items 等长的数组：{ lane, t, d, slow, gap, req }
	 *  t: 时钟；d: 距上一条(参与的行)的 Δ，空串表示第一条或紧跟静默之后；gap: 与上一条间隔超过 gapMs 时的静默文本
	 *  slow: RX 是本路待应答 TX 之后的第一条 RX 且距该 TX 超过 slowMs，此时 d 改显应答耗时(而不是距上一条)
	 *  req: 该 RX 对应的请求 TX 在 items 里的下标(只有「TX 后的第一条 RX」有)，否则 -1
	 * state 可跨批次传入，给增量计算用(req 为 state.n 起算的绝对序号，整段重算时就是下标)
	 */
	function compute(items, opts, state) {
		opts = opts || {}
		const lanes = opts.lanes || DUAL_LANES
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
	 * 选中第 idx 条时的「一次交互」区间(含两端，覆盖其间所有行，包括系统行)：
	 *  TX：到本路下一条应答(TX 之后第一条 RX)；还没等到应答就只有它自己
	 *  RX：从它所应答的请求 TX 到它；不是 TX 后第一条 RX(持续上报等)就只有它自己
	 * 非参与路的收发行返回 null。res 是 compute(items) 的整段结果。lanes 省略时按行归属推(双/单路)。
	 */
	function exchange(items, res, idx, opts) {
		opts = opts || {}
		const it = items[idx]
		const lanes = opts.lanes || (it ? lanesForSid(it.sid) : DUAL_LANES)
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

	/** 只有本路最后一条收发是选中的 TX 时，后续 RX 才会延长它的交互区间。lanes 省略时按行归属推(双/单路)。 */
	function awaitingReply(items, idx, opts) {
		const it = items[idx]
		if (!it) return false
		const lanes = (opts && opts.lanes) || lanesForSid(it.sid)
		if (!isLane(it, lanes) || it.dir !== 'tx') return false
		for (let j = idx + 1; j < items.length; j++) {
			if (items[j].sid === it.sid && isLane(items[j], lanes)) return false
		}
		return true
	}

	const api = {
		SLOW_MS, GAP_MS, fmtClock, fmtDelta, fmtGap, newState, compute, exchange, awaitingReply,
		DUAL_LANES, SINGLE_LANES,
	}
	root.ModernTimeline = api

	// 去掉持久化文本里的派生属性(common.js 的 paneHtml 在存 sessionStorage 前调用)
	root.serialLogPersistClean = function (html) {
		return typeof html === 'string' && html.indexOf('data-mdn-') !== -1 ? html.replace(/ data-mdn-[a-z-]+="[^"]*"/g, '') : html
	}

	// ---- 界面：只在浏览器里挂 ----
	if (typeof document === 'undefined') return

	// 每个容器一份完整状态(观察器、增量进度、选中底带、吸顶列头)。
	// 单路与双路的日志容器互不相干，各自的行集不串；容器一直被观察(隐藏模式的容器没有行进来)，
	// 切模式(addLaneB / removeLaneB)只换容器可见性，不搬行，所以两份状态天然不串
	function makeWatch(container) {
		const lanes = container.id === 'serial-logs-dual' ? DUAL_LANES : SINGLE_LANES
		const w = {
			container: container,
			lanes: lanes,
			observer: null,
			head: null,
			headTimer: 0,
			headRo: null,
			tailRow: null,
			tailState: null,
			bandRows: new Set(),
			bandOpen: false, // 选中的是还在等应答的 TX：新行到达时要重算区间
			bandSelectedRow: null,
			bandSid: '',
			bandTimer: 0,
		}

		function laneRows() {
			const out = []
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
			// 非收发行(系统行等)不挂派生属性
			setAttr(row, 'data-mdn-t', r.lane ? r.t : '')
			setAttr(row, 'data-mdn-d', r.d)
			setAttr(row, 'data-mdn-slow', r.slow ? '1' : '')
			// 静默文本挂在行首的 .log-time 上：它的 ::before 在气泡上方的轴列里画分隔胶囊(伪元素只能读自己宿主的属性)
			const tm = row.firstElementChild
			if (tm && tm.classList.contains('log-time')) setAttr(tm, 'data-mdn-gap', r.gap)
		}

		function fullCompute() {
			const rows = laneRows()
			w.tailState = newState()
			const res = compute(rows.map(itemOf), { lanes: lanes }, w.tailState)
			for (let i = 0; i < rows.length; i++) writeRow(rows[i], res[i])
			w.tailRow = rows.length ? rows[rows.length - 1] : null
		}

		// 尾部追加走增量；中间插入(按时间戳排序到前面)、头部之外的删除、整体重绘都整段重算
		function process(records) {
			let full = !w.tailRow || !w.tailRow.isConnected || w.tailRow.parentNode !== container || !w.tailState
			if (!full) {
				for (let i = 0; i < records.length && !full; i++) {
					const added = records[i].addedNodes
					for (let j = 0; j < added.length; j++) {
						const n = added[j]
						if (n.nodeType === 1 && n.isConnected && !(w.tailRow.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) { full = true; break }
					}
				}
			}
			if (full) {
				fullCompute()
			} else {
				const fresh = []
				for (let n = w.tailRow.nextElementSibling; n; n = n.nextElementSibling) {
					if (n.classList.contains('log-row')) fresh.push(n)
				}
				if (fresh.length) {
					const res = compute(fresh.map(itemOf), { lanes: lanes }, w.tailState)
					for (let i = 0; i < fresh.length; i++) writeRow(fresh[i], res[i])
					w.tailRow = fresh[fresh.length - 1]
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
			let bandChanged = full
			for (let i = 0; i < records.length; i++) {
				records[i].removedNodes.forEach(function (n) {
					w.bandRows.delete(n)
					if (n === w.bandSelectedRow) bandChanged = true
				})
				if (w.bandOpen) records[i].addedNodes.forEach(function (n) {
					if (n.nodeType === 1 && n.getAttribute('data-sid') === w.bandSid && /^(tx|rx)$/.test(n.getAttribute('data-dir'))) bandChanged = true
				})
			}
			if (bandChanged) scheduleBand()
		}

		// ---- 选中帧的底带 ----

		function applyBand() {
			w.bandTimer = 0
			w.bandRows.forEach(function (r) { r.removeAttribute('data-mdn-band') })
			w.bandRows.clear()
			w.bandOpen = false
			w.bandSelectedRow = null
			const sel = container.querySelector('.log-row.selected')
			if (!sel) return
			w.bandSelectedRow = sel
			const rows = laneRows()
			const items = rows.map(itemOf)
			const res = compute(items, { lanes: lanes })
			const idx = rows.indexOf(sel)
			const ex = idx >= 0 ? exchange(items, res, idx, { lanes: lanes }) : null
			if (!ex) return
			for (let i = ex.start; i <= ex.end; i++) {
				rows[i].setAttribute('data-mdn-band', '1')
				w.bandRows.add(rows[i])
			}
			w.bandOpen = awaitingReply(items, idx, { lanes: lanes })
			w.bandSid = items[idx].sid
		}

		// 用定时器而不是 requestAnimationFrame：底带不是逐帧动画，后台标签页里 rAF 会一直挂起(项目里镜像刷新同样避开 rAF)
		function scheduleBand() {
			if (w.bandTimer) return
			w.bandTimer = setTimeout(applyBand, 0)
		}
		w.scheduleBand = scheduleBand

		// ---- 吸顶列头 ----

		function laneLabel(sid) {
			const hub = root.SerialHub
			try {
				if (!hub) return sid
				return sid === 'A' ? hub.getLabelA() : hub.getLabelB()
			} catch (e) { return sid }
		}

		// 双路「A · 协议口」；路名本身就以 A 开头(默认的「A路」)时不再重复路标
		function laneText(sid) {
			const l = String(laneLabel(sid) || '')
			return !l ? sid : (l.charAt(0).toUpperCase() === sid ? l : sid + ' · ' + l)
		}

		function buildHead() {
			if (w.head || !container.parentNode) return
			w.head = document.createElement('div')
			// 双路沿用原 id(既有选择器)，单路用 .mdn-tl-single 区分列头配色
			w.head.className = 'mdn-tl-head'
			if (container.id === 'serial-logs-dual') w.head.id = 'mdn-tl-head'
			else w.head.classList.add('mdn-tl-single')
			w.head.setAttribute('aria-hidden', 'true')
			const a = document.createElement('span')
			a.className = 'mdn-tl-a'
			const b = document.createElement('span')
			b.className = 'mdn-tl-b'
			w.head.append(a, b)
			container.parentNode.insertBefore(w.head, container)
			syncHead()
			// 路标签改名没有事件可挂，每秒对一次；不在串口视图(日志区量不出宽度)或标签页在后台时不读布局
			w.headTimer = setInterval(function () {
				if (!document.hidden && container && container.offsetParent) syncHead()
			}, 1000)
			if (typeof ResizeObserver !== 'undefined') {
				w.headRo = new ResizeObserver(syncHead)
				w.headRo.observe(container)
			}
		}

		function syncHead() {
			if (!w.head || !container) return
			const a = w.head.firstElementChild
			const b = w.head.lastElementChild
			let ta
			let tb
			if (lanes === DUAL_LANES) {
				ta = laneText('A')
				tb = laneText('B')
			} else {
				// 单路：接收在左、发送在右(与气泡的左右一致)
				ta = '接收 RX'
				tb = '发送 TX'
			}
			if (a.textContent !== ta) a.textContent = ta
			if (b.textContent !== tb) b.textContent = tb
			// 路标与日志区的左右边缘对齐：右侧让出滚动条宽度
			const sbw = Math.max(0, container.offsetWidth - container.clientWidth)
			w.head.style.setProperty('--mdn-sbw', sbw + 'px')
		}

		w.start = function () {
			buildHead()
			fullCompute()
			scheduleBand()
			w.observer = new MutationObserver(process)
			w.observer.observe(container, { childList: true })
		}
		return w
	}

	// ---- 启动：两个容器各一份观察 ----
	const watches = []
	function start() {
		;['serial-logs-dual', 'serial-logs-single'].forEach(function (id) {
			const container = document.getElementById(id)
			if (!container) return
			const w = makeWatch(container)
			watches.push(w)
			w.start()
		})
		document.addEventListener('serial-log-select', function () {
			watches.forEach(function (w) { w.scheduleBand() })
		})
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
	else start()
})()
