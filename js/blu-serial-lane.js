// 功耗分析的串口事件道（仅现代布局）：把串口日志行按墙钟时间画到电流波形下方，与波形共用视窗。
// 时间对齐：blu-power.js 在入库时经 createAnchorTrack().note(样点下标, tMs) 稀疏记录「样点下标 ↔ performance 时间」锚点
// (另记当时的墙钟偏移)。日志行进 DOM 时按当下偏移把 data-ts 换成 performance 时间记下(stamps)，事件按它二分锚点
// 插值成小数样点下标，再走波形的 toX；系统时钟回拨/跳变不影响实时行的对齐。页面加载前就有的行(会话恢复)没有
// 时间戳，按锚点的分段墙钟偏移换算。
// 只读串口日志 DOM（.log-row 的 data-ts/dir/sid/seq/hex），不改 common.js；悬停文本一律 textContent。
// 纯函数（二分、锚点映射、密集合并、索引构建）同时导出给 node 回归测试，不碰 DOM。
;(function () {
	'use strict'
	const root = typeof window !== 'undefined' ? window : globalThis

	// ---- 纯函数 ----

	/** 有序数组里第一个 >= v 的下标 */
	function lowerBound(arr, v) {
		let lo = 0
		let hi = arr.length
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			if (arr[mid] < v) lo = mid + 1
			else hi = mid
		}
		return lo
	}

	/** 有序数组里第一个 > v 的下标 */
	function upperBound(arr, v) {
		let lo = 0
		let hi = arr.length
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			if (arr[mid] <= v) lo = mid + 1
			else hi = mid
		}
		return lo
	}

	/** [t0, t1] 闭区间落在有序 ts 里的 [lo, hi) */
	function visibleSlice(ts, t0, t1) {
		if (!(t1 >= t0)) return [0, 0]
		return [lowerBound(ts, t0), upperBound(ts, t1)]
	}

	/**
	 * 样点下标 ↔ 时间锚点。只做记录，不影响采样数据。
	 * note(li, tMs)：每个成功入库的样点调用一次（li 严格递增，tMs 为 performance.now 时间轴，单调）。
	 * 每 intervalMs 记一个锚点；相邻样点间隔超过 gapMs（停采后续采、USB 卡顿）时把断点两侧都记下，
	 * 避免线性插值把间隙摊到前一段样点上。映射以单调的 performance 时间轴为准(perfToLi / liToPerf)；
	 * 每个锚点另记当时的墙钟偏移 Date.now() - performance.now()，偏移突变超过 jumpMs(系统时钟回拨/跳变)时
	 * 开一个新映射段，墙钟换算(wallToPerf / wallToLi / liToWall)按段查找，不把墙钟钳成单调。
	 * 插值直接在锚点数组上二分，末样点(未必是锚点)单独处理，不复制数组：每帧对每条可见日志都要调一次。
	 */
	function createAnchorTrack(opts) {
		opts = opts || {}
		const intervalMs = opts.intervalMs > 0 ? opts.intervalMs : 200
		const gapMs = opts.gapMs > 0 ? opts.gapMs : 20
		const jumpMs = opts.jumpMs > 0 ? opts.jumpMs : 500
		const wallOffset = typeof opts.wallOffset === 'function'
			? opts.wallOffset
			: function () { return Date.now() - performance.now() }
		let lis = []
		let ts = []
		let offs = []
		// 各映射段起点在锚点数组里的下标
		let segs = []
		let lastLi = -1
		let lastT = 0
		let lastOff = 0
		let lastAnchorT = -Infinity

		function pushAnchor(li, t, off) {
			const n = lis.length
			if (n && lis[n - 1] === li) {
				ts[n - 1] = t
				offs[n - 1] = off
				return
			}
			if (!n || Math.abs(off - offs[n - 1]) > jumpMs) segs.push(n)
			lis.push(li)
			ts.push(t)
			offs.push(off)
		}

		function note(li, tMs) {
			if (lastLi >= 0 && tMs - lastT > gapMs) {
				pushAnchor(lastLi, lastT, lastOff)
				lastOff = wallOffset()
				pushAnchor(li, tMs, lastOff)
				lastAnchorT = tMs
			} else if (tMs - lastAnchorT >= intervalMs) {
				lastOff = wallOffset()
				pushAnchor(li, tMs, lastOff)
				lastAnchorT = tMs
			}
			lastLi = li
			lastT = tMs
		}

		function reset() {
			lis = []
			ts = []
			offs = []
			segs = []
			lastLi = -1
			lastT = 0
			lastOff = 0
			lastAnchorT = -Infinity
		}

		function has() {
			return lastLi >= 0 && lis.length > 0
		}

		function range() {
			if (!has()) return null
			return { li0: lis[0], li1: lastLi, t0: ts[0], t1: lastT, wall0: ts[0] + offs[0], wall1: lastT + lastOff }
		}

		/** 有效点数：锚点 + 末样点虚拟锚点(末样点不是锚点时) */
		function count() {
			const n = lis.length
			return n && lis[n - 1] !== lastLi ? n + 1 : n
		}

		/** xs/ys 为锚点数组，xTail/yTail 为末样点；x 超出已采集范围返回 null */
		function interp(xs, xTail, ys, yTail, x) {
			const real = xs.length
			const n = count()
			if (!n) return null
			const xEnd = n > real ? xTail : xs[real - 1]
			if (!(x >= xs[0] && x <= xEnd)) return null
			if (n === 1) return ys[0]
			let k = n > real && x >= xs[real - 1] ? real - 1 : upperBound(xs, x) - 1
			if (k >= n - 1) k = n - 2
			if (k < 0) k = 0
			const x0 = xs[k]
			const y0 = ys[k]
			const x1 = k + 1 < real ? xs[k + 1] : xTail
			const y1 = k + 1 < real ? ys[k + 1] : yTail
			const dx = x1 - x0
			if (!(dx > 0)) return y1
			return y0 + (y1 - y0) * (x - x0) / dx
		}

		/** performance 时间 → 小数样点下标；超出已采集范围返回 null */
		function perfToLi(t) {
			if (!has()) return null
			return interp(ts, lastT, lis, lastLi, t)
		}

		/** 样点下标 → performance 时间；超出范围返回 null */
		function liToPerf(li) {
			if (!has()) return null
			return interp(lis, lastLi, ts, lastT, li)
		}

		/**
		 * 墙钟毫秒 → performance 时间。按段查：时钟回拨后新旧两段的墙钟区间可能重叠，取最新一段
		 * (实时日志行有 performance 时间戳就不走这里，见界面部分的 stamps)。落在所有段外时按最新偏移换算。
		 */
		function wallToPerf(ms) {
			if (!has()) return ms - wallOffset()
			for (let s = segs.length - 1; s >= 0; s--) {
				const i0 = segs[s]
				const last = s === segs.length - 1
				const i1 = last ? lis.length - 1 : segs[s + 1] - 1
				const wLo = ts[i0] + offs[i0]
				const wHi = last ? lastT + lastOff : ts[i1] + offs[i1]
				if (ms < wLo || ms > wHi) continue
				// 段内偏移只有毫秒级漂移：先按段首偏移估 t，再取该处锚点的偏移
				const est = ms - offs[i0]
				let k = upperBound(ts, est) - 1
				if (k < i0) k = i0
				if (k > i1) k = i1
				return ms - offs[k]
			}
			return ms - lastOff
		}

		/** 墙钟毫秒 → 小数样点下标；超出已采集范围返回 null */
		function wallToLi(ms) {
			if (!has()) return null
			return perfToLi(wallToPerf(ms))
		}

		/** 样点下标 → 墙钟毫秒(按该样点所在段的偏移)；超出范围返回 null */
		function liToWall(li) {
			const t = liToPerf(li)
			if (t == null) return null
			let k = upperBound(lis, li) - 1
			if (k < 0) k = 0
			return t + offs[k]
		}

		return {
			note: note, reset: reset, has: has, range: range,
			perfToLi: perfToLi, liToPerf: liToPerf, wallToPerf: wallToPerf,
			wallToLi: wallToLi, liToWall: liToWall,
			anchorCount: function () { return lis.length },
			segmentCount: function () { return segs.length },
		}
	}

	/**
	 * 密集合并：xs 升序像素位置。与上一帧间距不超过 gapPx 的并进同一块，块宽超过 maxSpanPx 就另起一块，
	 * 连续密集流不会糊成一整条，计数也有地方写。返回 [{ x0, x1, n, i0, i1 }]，i0..i1 为 xs 的闭区间下标。
	 */
	function mergeMarks(xs, gapPx, maxSpanPx) {
		const span = maxSpanPx > 0 ? maxSpanPx : Infinity
		const out = []
		let cur = null
		for (let i = 0; i < xs.length; i++) {
			const x = xs[i]
			if (cur && x - cur.x1 <= gapPx && x - cur.x0 <= span) {
				cur.x1 = x
				cur.n++
				cur.i1 = i
			} else {
				cur = { x0: x, x1: x, n: 1, i0: i, i1: i }
				out.push(cur)
			}
		}
		return out
	}

	/** data-sid → 道键：单路全进 'S'；双路 B 进 'B'，其余（A、SYS）进 'A' */
	function laneKeyOf(sid, dual) {
		if (!dual) return 'S'
		return sid === 'B' ? 'B' : 'A'
	}

	/**
	 * 一条日志行（或带 getAttribute 的替身）→ 事件条目；不是有效日志行返回 null。
	 * toPerf(row, ts) 给出该行的 performance 时间(对齐用)；不给时 pt 为 null，按墙钟排序
	 */
	function entryFromRow(row, toPerf) {
		if (!row || typeof row.getAttribute !== 'function') return null
		const ts = parseInt(row.getAttribute('data-ts') || '', 10)
		if (!(ts > 0)) return null
		const d = row.getAttribute('data-dir')
		const pt = typeof toPerf === 'function' ? toPerf(row, ts) : null
		return {
			ts: ts,
			pt: typeof pt === 'number' && isFinite(pt) ? pt : null,
			dir: d === 'tx' || d === 'rx' ? d : 'sys',
			sid: row.getAttribute('data-sid') || '',
			seq: row.getAttribute('data-seq') || '',
			row: row,
		}
	}

	/** 条目的对齐时间：有 performance 时间用它，否则退回墙钟 */
	function keyOf(e) {
		return e.pt != null ? e.pt : e.ts
	}

	/** 条目列表 → 各道 { ts: [], items: [] }，ts 为对齐时间(见 keyOf)，按 (对齐时间, seq) 升序 */
	function buildLanes(entries, dual) {
		const lanes = {}
		const keys = dual ? ['A', 'B'] : ['S']
		for (let i = 0; i < keys.length; i++) lanes[keys[i]] = { ts: [], items: [] }
		let sorted = true
		for (let i = 1; i < entries.length; i++) {
			if (keyOf(entries[i]) < keyOf(entries[i - 1])) { sorted = false; break }
		}
		const list = sorted ? entries : entries.slice().sort(function (a, b) {
			return keyOf(a) - keyOf(b) || (Number(a.seq) || 0) - (Number(b.seq) || 0)
		})
		for (let i = 0; i < list.length; i++) {
			const e = list[i]
			const lane = lanes[laneKeyOf(e.sid, dual)]
			lane.ts.push(keyOf(e))
			lane.items.push(e)
		}
		return lanes
	}

	/** data-hex（空格分隔）→ 字节数 */
	function hexByteLen(hex) {
		const s = String(hex || '').trim()
		if (!s) return 0
		return s.split(/\s+/).length
	}

	/** data-hex 前 n 字节，超出加省略号 */
	function hexPreview(hex, n) {
		const parts = String(hex || '').trim().split(/\s+/).filter(Boolean)
		const head = parts.slice(0, n).join(' ')
		return parts.length > n ? head + ' …' : head
	}

	function pad(n, w) {
		const s = String(n)
		return s.length >= w ? s : '0'.repeat(w - s.length) + s
	}

	/** 毫秒 epoch → 本地 HH:MM:SS.mmm */
	function fmtClock(ms) {
		const d = new Date(ms)
		return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2) + '.' + pad(d.getMilliseconds(), 3)
	}

	const api = {
		lowerBound: lowerBound,
		upperBound: upperBound,
		visibleSlice: visibleSlice,
		createAnchorTrack: createAnchorTrack,
		mergeMarks: mergeMarks,
		laneKeyOf: laneKeyOf,
		entryFromRow: entryFromRow,
		buildLanes: buildLanes,
		hexByteLen: hexByteLen,
		hexPreview: hexPreview,
		fmtClock: fmtClock,
	}

	// ---- 界面（仅浏览器）----
	if (typeof document === 'undefined' || typeof window === 'undefined') {
		root.BluSerialLane = api
		if (typeof module !== 'undefined' && module.exports) module.exports = api
		return
	}

	const MERGE_PX = 4
	const MERGE_SPAN_PX = 48
	const ROW_H = 20
	const HIT_PAD = 3

	let track = null
	let requestWaveRedraw = null
	let lastLayout = null
	let lanePending = false
	let hits = []
	let lastRows = 0
	// 日志索引缓存：增量追加 + 头部裁剪，其余变化整表重建
	const cache = { container: null, dual: false, rows: [], entries: [], pos: new Map(), lanes: null }
	// 日志行 → performance 时间：行进 DOM 时按当下的墙钟偏移换算，之后系统时钟怎么调都不变
	const stamps = new WeakMap()

	function stampRows(records) {
		const off = Date.now() - performance.now()
		for (let i = 0; i < records.length; i++) {
			const added = records[i].addedNodes
			for (let j = 0; j < added.length; j++) {
				const n = added[j]
				if (n.nodeType !== 1 || stamps.has(n) || !n.classList.contains('log-row')) continue
				const ts = parseInt(n.getAttribute('data-ts') || '', 10)
				if (ts > 0) stamps.set(n, ts - off)
			}
		}
	}

	function rowPerf(row, ts) {
		const t = stamps.get(row)
		if (t != null) return t
		return track ? track.wallToPerf(ts) : ts - (Date.now() - performance.now())
	}

	function E(id) { return document.getElementById(id) }
	function isModern() { return document.documentElement.dataset.layout === 'modern' }

	function currentContainer() {
		const dual = !!(window.SerialHub && window.SerialHub.mode === 'dual')
		return { dual: dual, el: E(dual ? 'serial-logs-dual' : 'serial-logs-single') }
	}

	function fullRebuild(el, dual) {
		cache.container = el
		cache.dual = dual
		cache.rows = []
		cache.entries = []
		cache.pos = new Map()
		if (el) {
			for (let r = el.firstElementChild; r; r = r.nextElementSibling) appendRow(r)
		}
		cache.lanes = buildLanes(cache.entries, dual)
	}

	function appendRow(r) {
		cache.pos.set(r, cache.rows.length)
		cache.rows.push(r)
		if (r.classList && r.classList.contains('log-row')) {
			const e = entryFromRow(r, rowPerf)
			if (e) cache.entries.push(e)
		}
	}

	/** 只在行集合变化时重建；常见的「尾部追加 + 头部裁剪」不重读旧行 */
	function getLanes() {
		const c = currentContainer()
		const el = c.el
		if (!el) return null
		if (cache.container !== el || cache.dual !== c.dual || !cache.lanes) {
			fullRebuild(el, c.dual)
			return cache.lanes
		}
		const n = el.childElementCount
		const first = el.firstElementChild
		const rows = cache.rows
		if (n === rows.length && first === rows[0] && el.lastElementChild === rows[rows.length - 1]) {
			return cache.lanes
		}
		const drop = first ? cache.pos.get(first) : rows.length
		const lastOld = rows.length ? rows[rows.length - 1] : null
		if (drop == null || (lastOld && lastOld.parentNode !== el) || (!lastOld && first)) {
			fullRebuild(el, c.dual)
			return cache.lanes
		}
		const keepRows = rows.slice(drop)
		for (let i = 0; i < keepRows.length; i++) {
			if (keepRows[i].parentNode !== el) {
				fullRebuild(el, c.dual)
				return cache.lanes
			}
		}
		cache.rows = []
		cache.entries = []
		cache.pos = new Map()
		for (let i = 0; i < keepRows.length; i++) appendRow(keepRows[i])
		for (let r = lastOld ? lastOld.nextElementSibling : null; r; r = r.nextElementSibling) appendRow(r)
		// 中间插入/删除（同毫秒乱序插入、清空等）：计数对不上就整表重建
		if (cache.rows.length !== n || cache.rows[0] !== first) {
			fullRebuild(el, c.dual)
			return cache.lanes
		}
		cache.lanes = buildLanes(cache.entries, c.dual)
		return cache.lanes
	}

	function cssVar(el, name, fallback) {
		const v = getComputedStyle(el).getPropertyValue(name).trim()
		return v || fallback
	}

	function setStatus(text) {
		const st = E('blu-serial-lane-status')
		if (st && st.textContent !== text) st.textContent = text
	}

	function hideTip() {
		const tip = E('blu-serial-lane-tip')
		if (tip) tip.hidden = true
	}

	/** blu-power.js 每次重绘波形后调用；layout 为 null 表示当前没有可画的波形 */
	function draw(layout) {
		if (!isModern()) {
			lastLayout = null
			hits = []
			return
		}
		lastLayout = layout || null
		paint()
	}

	function scheduleLanePaint() {
		if (lanePending) return
		lanePending = true
		requestAnimationFrame(function () {
			lanePending = false
			if (isModern()) paint()
		})
	}

	function paint() {
		const canvas = E('blu-serial-lane-canvas')
		const wrap = E('blu-serial-lane')
		if (!canvas || !wrap) return
		const c = currentContainer()
		const keys = c.dual ? ['A', 'B'] : ['S']
		if (lastRows !== keys.length) {
			lastRows = keys.length
			wrap.setAttribute('data-rows', String(keys.length))
			// 道高变化挤压波形画布：下一帧整体重绘
			if (requestWaveRedraw) requestWaveRedraw()
		}
		const rect = canvas.getBoundingClientRect()
		const w = rect.width
		const h = rect.height
		hits = []
		if (w < 8 || h < 8) return
		const dpr = window.devicePixelRatio || 1
		const cw = Math.round(w * dpr)
		const chh = Math.round(h * dpr)
		const ctx = canvas.getContext('2d')
		// 尺寸没变时用 reset() 清空复位，不重新分配画布(随波形每帧重画)
		if (canvas.width !== cw || canvas.height !== chh || typeof ctx.reset !== 'function') {
			canvas.width = cw
			canvas.height = chh
		} else {
			ctx.reset()
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

		const bg = cssVar(wrap, '--bg-surface', '#ffffff')
		const muted = cssVar(wrap, '--text-muted', '#64748b')
		const gridCol = cssVar(wrap, '--border-color', '#cbd5e1')
		const txCol = cssVar(wrap, '--blu-lane-tx', '#ea580c')
		const rxCol = cssVar(wrap, '--blu-lane-rx', '#16a34a')
		const sysCol = cssVar(wrap, '--blu-lane-sys', '#94a3b8')
		ctx.fillStyle = bg
		ctx.fillRect(0, 0, w, h)

		const layout = lastLayout
		const left = layout ? layout.margin.left : 62
		const rowH = Math.max(10, Math.min(ROW_H, h / keys.length))
		ctx.font = '10px sans-serif'
		ctx.textBaseline = 'middle'
		ctx.textAlign = 'right'
		for (let r = 0; r < keys.length; r++) {
			const y0 = r * rowH
			ctx.fillStyle = muted
			ctx.fillText(c.dual ? keys[r] + ' 路' : '串口', left - 8, y0 + rowH / 2)
			if (r > 0) {
				ctx.strokeStyle = gridCol
				ctx.lineWidth = 1
				ctx.beginPath()
				ctx.moveTo(left, Math.round(y0) + 0.5)
				ctx.lineTo(w, Math.round(y0) + 0.5)
				ctx.stroke()
			}
		}

		if (!layout) {
			setStatus('无波形')
			return
		}
		if (!track || !track.has()) {
			setStatus('无可对齐的串口数据（导入或未记录采集时刻的波形）')
			return
		}
		const lanes = getLanes()
		const rng = track.range()
		let anyInData = false
		if (lanes) {
			for (let r = 0; r < keys.length; r++) {
				const sl = visibleSlice(lanes[keys[r]].ts, rng.t0, rng.t1)
				if (sl[1] > sl[0]) { anyInData = true; break }
			}
		}
		if (!anyInData) {
			setStatus('无可对齐的串口数据')
			return
		}

		const vr = layout.vr
		const tLo = track.liToPerf(Math.max(vr.start, rng.li0))
		const tHi = track.liToPerf(Math.min(vr.end, rng.li1))
		const waveRect = layout.canvasRect
		const dx = waveRect ? waveRect.left - rect.left : 0
		const xMin = left + dx
		const xMax = left + layout.pw + dx
		let shown = 0
		for (let r = 0; r < keys.length; r++) {
			const lane = lanes[keys[r]]
			if (tLo == null || tHi == null) break
			const sl = visibleSlice(lane.ts, tLo, tHi)
			const groups = { tx: { xs: [], idx: [] }, rx: { xs: [], idx: [] }, sys: { xs: [], idx: [] } }
			for (let i = sl[0]; i < sl[1]; i++) {
				const li = track.perfToLi(lane.ts[i])
				if (li == null) continue
				const x = layout.toX(li) + dx
				if (x < xMin - 1 || x > xMax + 1) continue
				const g = groups[lane.items[i].dir]
				g.xs.push(x)
				g.idx.push(i)
			}
			const y0 = r * rowH
			const bands = {
				tx: { y: y0 + 2, hh: rowH / 2 - 2.5, col: txCol },
				rx: { y: y0 + rowH / 2 + 0.5, hh: rowH / 2 - 2.5, col: rxCol },
				sys: { y: y0 + rowH / 2 - 1, hh: 2, col: sysCol },
			}
			const order = ['sys', 'tx', 'rx']
			for (let k = 0; k < order.length; k++) {
				const dir = order[k]
				const g = groups[dir]
				if (!g.xs.length) continue
				const b = bands[dir]
				const blocks = mergeMarks(g.xs, MERGE_PX, MERGE_SPAN_PX)
				ctx.fillStyle = b.col
				for (let j = 0; j < blocks.length; j++) {
					const bl = blocks[j]
					shown += bl.n
					const bw = bl.n > 1 ? Math.max(3, bl.x1 - bl.x0 + 2) : 2
					const bx = bl.x0 - 1
					if (bl.n > 1) {
						ctx.globalAlpha = dir === 'sys' ? 0.6 : 0.35
						ctx.fillRect(bx, b.y, bw, b.hh)
						ctx.globalAlpha = 1
						ctx.fillRect(bx, b.y, 1.5, b.hh)
						ctx.fillRect(bx + bw - 1.5, b.y, 1.5, b.hh)
						const label = String(bl.n)
						if (dir !== 'sys' && bw >= ctx.measureText(label).width + 6) {
							ctx.save()
							ctx.textAlign = 'center'
							ctx.font = '9px sans-serif'
							ctx.fillStyle = muted
							ctx.fillText(label, bx + bw / 2, b.y + b.hh / 2)
							ctx.restore()
						}
					} else {
						ctx.globalAlpha = dir === 'sys' ? 0.7 : 1
						ctx.fillRect(bx, b.y, bw, b.hh)
						ctx.globalAlpha = 1
					}
					hits.push({
						x0: bx - HIT_PAD, x1: bx + bw + HIT_PAD,
						y0: dir === 'sys' ? y0 : b.y, y1: dir === 'sys' ? y0 + rowH : b.y + b.hh,
						lane: lane, key: keys[r], dir: dir,
						first: g.idx[bl.i0], last: g.idx[bl.i1], n: bl.n,
					})
				}
			}
		}
		setStatus(shown ? '' : '当前窗口无串口帧')
	}

	function hitAt(px, py) {
		let best = null
		let bestD = Infinity
		for (let i = 0; i < hits.length; i++) {
			const hb = hits[i]
			if (py < hb.y0 - 1 || py > hb.y1 + 1) continue
			if (px < hb.x0 || px > hb.x1) continue
			const d = Math.abs(px - (hb.x0 + hb.x1) / 2)
			// sys 细标优先级最低
			const dd = hb.dir === 'sys' ? d + 1000 : d
			if (dd < bestD) { bestD = dd; best = hb }
		}
		return best
	}

	const DIR_LABEL = { tx: 'TX', rx: 'RX', sys: '系统' }

	function showTip(hb, clientX, clientY) {
		const tip = E('blu-serial-lane-tip')
		if (!tip) return
		const e = hb.lane.items[hb.first]
		const row = e.row
		const hex = row && row.getAttribute ? (row.getAttribute('data-hex') || '') : ''
		const lines = []
		if (hb.n > 1) {
			const eLast = hb.lane.items[hb.last]
			lines.push([hb.n + ' 帧 ' + DIR_LABEL[hb.dir] + ' · ' + fmtClock(e.ts) + ' – ' + fmtClock(eLast.ts), 'blu-serial-lane-tip-head'])
		}
		const sidLabel = hb.key === 'S' ? '单路' : (e.sid === 'SYS' ? '系统' : e.sid + ' 路')
		lines.push([(hb.n > 1 ? '首帧 ' : '') + fmtClock(e.ts) + ' · ' + DIR_LABEL[e.dir] + ' · ' + sidLabel + (e.dir === 'sys' ? '' : ' · ' + hexByteLen(hex) + 'B'), ''])
		if (e.dir === 'sys') {
			const body = row && row.querySelector ? row.querySelector('.log-body') : null
			const msg = body ? String(body.textContent || '').slice(0, 80) : ''
			if (msg) lines.push([msg, ''])
		} else if (hex) {
			lines.push([hexPreview(hex, 16), 'blu-serial-lane-tip-hex'])
		}
		lines.push([hb.n > 1 ? '点击跳到首帧' : '点击跳到该行', 'blu-serial-lane-tip-hint'])
		tip.textContent = ''
		for (let i = 0; i < lines.length; i++) {
			const d = document.createElement('div')
			if (lines[i][1]) d.className = lines[i][1]
			d.textContent = lines[i][0]
			tip.appendChild(d)
		}
		tip.hidden = false
		const tw = tip.offsetWidth
		const th = tip.offsetHeight
		let x = clientX + 12
		let y = clientY - th - 10
		if (x + tw > window.innerWidth - 4) x = Math.max(4, clientX - tw - 12)
		if (y < 4) y = clientY + 16
		tip.style.left = x + 'px'
		tip.style.top = y + 'px'
	}

	function jumpToRow(e) {
		const row = e && e.row
		const rail = document.querySelector('.rail-item[data-view="view-serial"]')
		if (rail) rail.click()
		let target = row && row.isConnected ? row : null
		if (!target && e && e.seq) {
			const c = currentContainer()
			if (c.el) target = c.el.querySelector('.log-row[data-seq="' + String(e.seq).replace(/[^0-9]/g, '') + '"]')
		}
		if (!target) return
		requestAnimationFrame(function () {
			try { target.scrollIntoView({ block: 'center' }) } catch (err) { target.scrollIntoView() }
			target.click()
		})
	}

	function localPos(canvas, ev) {
		const r = canvas.getBoundingClientRect()
		return { x: ev.clientX - r.left, y: ev.clientY - r.top }
	}

	function bindUi() {
		const canvas = E('blu-serial-lane-canvas')
		if (!canvas) return
		canvas.addEventListener('mousemove', function (ev) {
			if (!isModern()) return
			const p = localPos(canvas, ev)
			const hb = hitAt(p.x, p.y)
			if (hb) showTip(hb, ev.clientX, ev.clientY)
			else hideTip()
		})
		canvas.addEventListener('mouseleave', hideTip)
		canvas.addEventListener('click', function (ev) {
			if (!isModern()) return
			const p = localPos(canvas, ev)
			const hb = hitAt(p.x, p.y)
			if (!hb) return
			hideTip()
			jumpToRow(hb.lane.items[hb.first])
		})
		// 布局切换不刷新页面：显隐靠 CSS，这里只负责让波形按新高度重绘
		new MutationObserver(function () {
			hideTip()
			if (!isModern()) {
				lastLayout = null
				hits = []
			}
			if (requestWaveRedraw) requestWaveRedraw()
		}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-layout'] })
		// 停采后日志仍在增减：只重画事件道（rAF 合并），不重画波形
		const onLogs = function () {
			if (!isModern() || !lastLayout) return
			const wrap = E('blu-serial-lane')
			if (!wrap || !wrap.offsetWidth) return
			scheduleLanePaint()
		}
		// 先记时间戳再重画：观察器始终开着(经典布局、别的视图也记)，否则之后切到现代布局时实时行没有 performance 时间
		const mo = new MutationObserver(function (records) {
			stampRows(records)
			onLogs()
		})
		const s = E('serial-logs-single')
		const d = E('serial-logs-dual')
		if (s) mo.observe(s, { childList: true })
		if (d) mo.observe(d, { childList: true })
	}

	/** blu-power.js 初始化时接入：锚点轨迹 + 波形重绘入口 */
	function attach(opts) {
		track = opts && opts.track ? opts.track : null
		requestWaveRedraw = opts && typeof opts.requestRedraw === 'function' ? opts.requestRedraw : null
		bindUi()
	}

	api.attach = attach
	api.draw = draw
	root.BluSerialLane = api
})()
