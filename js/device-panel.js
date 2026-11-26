// 设备面板（window.DevicePanel）：「通信调试」视图里与日志并列的子视图，把设备当成对象展示（状态仪表盘 + 参数当前值，只读）。
// 宿主不认识任何具体协议：有没有面板、读哪些组、状态页放哪些部件、参数分几类，全部来自主发那一路协议注册时声明的 device
// （契约与清洗见 js/protocol-registry.js 的 normalizeDevice），协议给的文本一律 textContent 渲染。
// 面板跟随主发那一路（单路即 S，双路为 SerialHub.activeSendId），读数按「路 + 协议」各存一份（js/device-model.js），
// 每条读数记下路、连接代次与来源帧，代次变了就灰显为「上次连接」。读取经 js/protocol-request.js，整个流程锁定发起时的那一路与代次。
// 这一路收到的帧只要能被该路协议的 device.extract 认出，读数就被动更新（设备自己上报、别处发的查询都算）。
;(function () {
	'use strict'

	const SUBVIEW_KEY = 'serial-debug-subview'
	const NARROW = 760
	// 通信记录条的窄屏判定与 #main 变单列的断点一致（761–768px 已是单列、整页滚动）
	const STRIP_NARROW = 768
	const M = window.DeviceModel
	const R = window.ProtocolRequest
	if (!M || !R) return

	const store = M.createStore()
	let view = 'comm'
	let root = null
	let viewbar = null
	let mounted = false
	let renderTimer = 0
	let lastSig = ''

	// ---------- 小工具 ----------
	function h(name, attrs) {
		const el = document.createElement(name)
		if (attrs) {
			for (const k in attrs) {
				const v = attrs[k]
				if (v == null || v === false) continue
				if (k === 'class') el.className = v
				else if (k === 'text') el.textContent = String(v)
				else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v)
				else el.setAttribute(k, v === true ? (k.indexOf('aria-') === 0 ? 'true' : '') : String(v))
			}
		}
		for (let i = 2; i < arguments.length; i++) add(el, arguments[i])
		return el
	}
	// 子节点可以是嵌套数组；null / false / 空串跳过（不能交给 append，它会把 null 变成文字 "null"）
	function add(el, c) {
		if (c == null || c === false || c === '') return
		if (Array.isArray(c)) { c.forEach(function (x) { add(el, x) }); return }
		el.append(c)
	}

	function hub() { return window.SerialHub || null }
	function api() { return window.serialApi || null }
	function lanes() { return window.serialLanes || null }
	function registry() { return window.ProtocolRegistry || null }

	function isDual() { const hb = hub(); return !!(hb && hb.mode === 'dual') }
	// 实际的物理主发路：单路是 S；双路是 SerialHub.activeSendId，可能是 A、B，也可能是还开着的单路口 S（「单」键）
	function mainSid() {
		const hb = hub()
		if (!hb) return 'S'
		if (hb.mode !== 'dual') return 'S'
		const id = hb.activeSendId
		return id === 'B' || id === 'S' ? id : 'A'
	}
	// 设备面板能跟随的路：单路只有 S，双路只有 A / B。双路下主发是 S 时，S 不是可见会话，
	// serialApi 不能定向写它（writeRawTo 拒绝）、按路收帧也不收它，所以不开放面板（如实禁用并说明），不能悄悄改对 A 操作
	function laneSupported(sid) {
		return isDual() ? (sid === 'A' || sid === 'B') : sid === 'S'
	}
	function protocolOf(sid) {
		const l = lanes()
		return l && typeof l.protocolOf === 'function' ? (l.protocolOf(sid) || '') : (window._activeProtocol || '')
	}
	function protocolEntry(pid) {
		const r = registry()
		return r && typeof r.get === 'function' ? r.get(pid) : null
	}
	function protocolName(pid) {
		const e = protocolEntry(pid)
		return e ? e.name : (pid || '当前协议')
	}
	function deviceOf(pid) {
		const e = protocolEntry(pid)
		return e && e.device ? e.device : null
	}
	function genOf(sid) { return R.generation(sid) }
	function laneOpen(sid) {
		const a = api()
		return !!(a && typeof a.isSessionOpen === 'function' && a.isSessionOpen(sid))
	}
	// 单路（含移动端）不出现「路」字样，连接对象就叫「设备」
	function laneLabel(sid) {
		const hb = hub()
		if (sid === 'S' || !hb) return ''
		const l = sid === 'B' ? hb.getLabelB() : hb.getLabelA()
		return l || sid
	}
	function laneWord(sid) {
		if (sid === 'S') return '设备'
		const l = laneLabel(sid)
		return /路$/.test(l) ? l : l + ' 路'
	}
	function toast(msg, kind) {
		const l = lanes()
		if (l && typeof l.toast === 'function') l.toast(msg, kind)
	}

	function ctx() {
		const sid = mainSid()
		const pid = protocolOf(sid)
		const dev = laneSupported(sid) ? deviceOf(pid) : null
		return { sid: sid, pid: pid, dev: dev, gen: genOf(sid), open: laneOpen(sid), L: dev ? M.lane(store, sid, pid) : null }
	}

	// ---------- 收帧泵（每路一个） ----------
	// 每路的字节只在泵里切帧、解析、入账一次；读取流程订阅同一个泵，只认领泵入账过的条目，不再二次解析或入账，
	// 所以同一块里「应答 → 更新上报」按到达顺序入账，最后显示的是后到的那一帧
	const pumps = Object.create(null)
	function makePump(sid) {
		return R.createPump(sid, {
			skip: function () {
				const a = api()
				if (a && a.suppressParse) return true
				return !!(a && typeof a.isRxLogSuppressed === 'function' && a.isRxLogSuppressed(sid))
			},
			accept: function (pid, entry) { return !!(entry && entry.device) },
			onFrame: function (item) {
				const dev = item.entry.device
				item.res = M.ingest(store, { sid: sid, pid: item.pid, gen: item.gen, at: item.at, bytes: item.frame, parsed: item.parsed, device: dev })
				if (item.res && sid === mainSid()) scheduleRender()
			},
		})
	}

	// 失败说明：区分「没有发出」与「已发出、结果未知」
	function failText(e) {
		const msg = e && e.message ? e.message : String(e)
		if (!e || e.code === 'build' || e.code === 'busy' || e.code === 'noproto') return msg
		return msg + (e.sent ? '（查询已发出，设备是否执行未知）' : '（查询未发出）')
	}

	// ---------- 读取 ----------
	async function runRead(label, gids) {
		const c = ctx()
		if (!c.dev || !c.L || c.L.busy || !gids.length || !c.dev.queryable) return
		const L = c.L
		const dev = c.dev
		const pump = pumps[c.sid]
		let flow
		try {
			flow = R.begin(c.sid, { source: pump ? pump.source : null, position: pump ? pump.position : null })
		} catch (e) {
			L.task = { kind: 'bad', text: label + '未开始：' + e.message, until: Date.now() + 8000, sid: c.sid }
			render()
			return
		}
		L.busy = true
		L.flow = flow
		const n = gids.length
		let ok = 0
		let fail = 0
		let skipped = 0
		let unsure = 0
		let firstErr = ''
		for (let i = 0; i < n; i++) {
			const gid = gids[i]
			const g = dev.groups.find(function (x) { return x.id === gid })
			if (!g) continue
			const pre = flow.check()
			if (pre) { skipped = n - i; firstErr = firstErr || failText(pre); break }
			L.task = { kind: 'run', text: label + ' ' + (i + 1) + '/' + n + ' · ' + g.title, sid: c.sid }
			M.setGroupBusy(L, gid, true)
			// 这一组在本连接里欠过账（上次超时等）：本次认领到的可能是那条迟到应答
			const late = M.isLate(L, gid, flow.gen)
			render()
			try {
				// 只认领泵已入账、且入账结果确实认领了这一组（协议认领 + 取到该组字段）的帧
				const res = await flow.request({
					build: function () { return dev.buildRequest(g, { sid: c.sid }) },
					match: function (parsed, frame, item) {
						return !!(item && item.res && item.res.groups.indexOf(gid) >= 0)
					},
					timeoutMs: dev.timeoutMs,
				})
				M.setGroupBusy(L, gid, false)
				if (late) {
					// 标在请求实际认领的那条记录上（同一块里之后又来的同组帧不继承，也不会把标记挪走）
					M.markRecUnsure(L, res.item && res.item.res && res.item.res.rec ? res.item.res.rec.id : null, '归属未确认：这一组在本次连接里有查询没等到应答，读到的可能是那次的迟到应答')
					unsure++
				} else ok++
			} catch (e) {
				M.setGroupError(L, gid, failText(e), flow.gen, Date.now())
				// 已发出却没认领到应答：设备的应答可能还在路上，记一笔欠账（断开 / 重连换了代次，不必记）
				if (e.sent && e.code !== 'generation' && e.code !== 'closed') M.markLate(L, gid, flow.gen)
				fail++
				firstErr = firstErr || failText(e)
				if (e.code === 'generation' || e.code === 'closed' || e.code === 'cancelled' || e.code === 'protocol' || e.code === 'foreign') {
					skipped = n - i - 1
					break
				}
			}
		}
		flow.end()
		L.busy = false
		L.flow = null
		const unsureText = unsure ? '，' + unsure + ' 组归属未确认（本次连接里这些组有查询没等到应答，读到的可能是迟到应答）' : ''
		if (fail || skipped) {
			L.task = {
				kind: 'bad',
				text: label + '：' + ok + '/' + n + ' 组完成' + unsureText + (skipped ? '，' + skipped + ' 组未发出' : '') + (firstErr ? ' · ' + firstErr : ''),
				until: Date.now() + 10000,
				sid: c.sid,
			}
		} else if (unsure) {
			L.task = { kind: 'warn', text: label + '：' + ok + '/' + n + ' 组确认' + unsureText + ' · ' + M.fmtClock(Date.now()), until: Date.now() + 10000, sid: c.sid }
		} else {
			L.task = { kind: 'ok', text: label + '完成 · ' + M.fmtClock(Date.now()), until: Date.now() + 5000, sid: c.sid }
		}
		render()
	}

	function cancelRead() {
		const c = ctx()
		if (c.L && c.L.flow) c.L.flow.cancel('已手动取消')
	}

	function readGroups(gids, label) {
		runRead(label, gids)
	}

	function autoReadCategory() {
		const c = ctx()
		if (!c.dev || !c.L || c.L.busy || !c.open || !c.dev.queryable) return
		const cat = currentCategory(c)
		if (!cat) return
		const gids = []
		cat.keys.forEach(function (k) {
			const f = c.dev.fieldMap[k]
			if (!f || !f.group || gids.indexOf(f.group) >= 0) return
			const gv = M.groupView(c.L, f.group, c.gen)
			if (gv.state === 'unread') gids.push(f.group)
		})
		if (gids.length) runRead('读取' + cat.title, gids)
	}

	// ---------- 视图切换 ----------
	function availability() {
		const sid = mainSid()
		const pid = protocolOf(sid)
		if (!laneSupported(sid)) return { ok: false, sid: sid, pid: pid, why: '主发是单路口，设备面板只跟随 A / B 路；把主发切到 A 或 B 后可用' }
		const dev = deviceOf(pid)
		if (dev) {
			const why = (isDual() ? '设备面板跟随主发 ' + laneWord(sid) + '（' + protocolName(pid) + '）' : '') + (dev.queryable ? '' : (isDual() ? '；' : '') + '该协议只声明了取值，面板只被动更新、不发查询')
			return { ok: true, sid: sid, pid: pid, why: why }
		}
		return { ok: false, sid: sid, pid: pid, why: protocolName(pid) + ' 没有声明设备面板，只能用通信调试' }
	}

	function setView(v, quiet) {
		const want = v === 'device' ? 'device' : 'comm'
		if (want === 'device' && !availability().ok) return false
		view = want
		try { sessionStorage.setItem(SUBVIEW_KEY, view) } catch (e) {}
		const vs = document.getElementById('view-serial')
		if (vs) vs.dataset.subview = view
		if (root) root.hidden = view !== 'device'
		// 终端在通信记录条里只读：键入 / 粘贴不写主发口（common.js 的发送回调入口另有复核）
		if (window.SerialTerm && typeof window.SerialTerm.setInputEnabled === 'function') window.SerialTerm.setInputEnabled(view !== 'device')
		if (view === 'device') syncStrip(true)
		else {
			const panes = document.getElementById('serial-log-panes')
			if (panes) panes.inert = false
			if (window.SerialTerm && typeof window.SerialTerm.setFitSuspended === 'function') window.SerialTerm.setFitSuspended(false)
		}
		renderViewbar()
		if (view === 'device') render()
		if (!quiet && view === 'device') {
			const c = ctx()
			if (c.L && c.L.ui.tab === 'params') autoReadCategory()
		}
		return true
	}

	function renderViewbar() {
		if (!viewbar) return
		const av = availability()
		const devBtn = viewbar.querySelector('#dp-view-device')
		const commBtn = viewbar.querySelector('#dp-view-comm')
		devBtn.disabled = !av.ok
		devBtn.title = av.ok ? '' : av.why
		devBtn.setAttribute('aria-pressed', view === 'device' ? 'true' : 'false')
		commBtn.setAttribute('aria-pressed', view === 'comm' ? 'true' : 'false')
		viewbar.querySelector('.dp-why').textContent = av.why
	}

	// 主发路 / 协议 / 连接代次变化时同步：协议没有 device 了就退回通信调试
	function sync() {
		if (!mounted) return
		const av = availability()
		if (view === 'device' && !av.ok) {
			setView('comm', true)
			toast(av.why.replace('，只能用通信调试', '') + '，已回到通信调试', 'warn')
		}
		const c = ctx()
		const sig = [view, c.sid, c.pid, c.gen, c.open, isDual(), laneLabel(c.sid)].join('|')
		renderViewbar()
		if (sig !== lastSig) {
			lastSig = sig
			if (view === 'device') render()
		}
		if (view === 'device') syncStrip(false)
	}

	// ---------- 渲染 ----------
	function scheduleRender() {
		if (renderTimer) return
		renderTimer = setTimeout(function () { renderTimer = 0; render() }, 30)
	}

	function laneChip(sid) {
		if (sid === 'S') return null
		return h('span', { class: 'dp-lchip', 'data-lane': sid, text: laneLabel(sid) })
	}

	function valueText(c, key) {
		const r = M.reading(c.L, key)
		// 换算只用同一路、同一连接代次的其它读数（重连后不拿上一连接的基准去算）
		return r ? M.formatValue(c.dev, key, r.raw, M.getter(c.L, r.gen)) : '—'
	}

	// 可点的值：点开来源帧
	function valBtn(c, key, content) {
		const r = M.reading(c.L, key)
		if (!r) return h('span', { class: 'dp-ph', text: '—' })
		const stale = M.isStale(r, c.gen)
		const unsure = M.readingUnsure(c.L, key)
		return h('button', {
			type: 'button',
			class: 'dp-val' + (c.L.ui.sel === key ? ' is-sel' : '') + (stale ? ' is-stale' : '') + (unsure ? ' is-unsure' : ''),
			title: unsure ? unsure + '。查看来源帧' : '查看来源帧',
			onclick: function () { c.L.ui.sel = key; render() },
		}, content != null ? content : valueText(c, key))
	}

	function groupLine(c, gid) {
		const g = c.dev.groups.find(function (x) { return x.id === gid })
		const gv = M.groupView(c.L, gid, c.gen)
		const st = gv.state
		const sure = st === 'ok' && gv.unsure ? 'unsure' : st
		const stText = st === 'busy' ? '读取中' : sure === 'unsure' ? '? ' + M.fmtClock(gv.at) + ' 归属未确认' : st === 'ok' ? '✓ ' + M.fmtClock(gv.at) : st === 'stale' ? '上次连接 ' + M.fmtClock(gv.at) : st === 'error' ? '✗ ' + gv.error : '未读'
		return h('span', { class: 'dp-grp', 'data-state': sure },
			h('span', { class: 'dp-grp-t', text: g ? g.title : gid }),
			h('span', { class: 'dp-grp-st', text: stText, title: st === 'error' ? gv.error : (sure === 'unsure' ? gv.unsure : null) }),
			c.dev.queryable && h('button', {
				type: 'button',
				class: 'dp-link',
				text: gv.at ? '刷新' : '读取',
				disabled: c.L.busy || !c.open,
				onclick: function () { readGroups([gid], '读取' + (g ? g.title : gid)) },
			}))
	}

	function widgetStale(c, keys) {
		return keys.some(function (k) { return M.isStale(M.reading(c.L, k), c.gen) })
	}

	function widgetHead(c, w, extra) {
		return h('div', { class: 'dp-sec-h' }, h('h3', { text: w.title || '' }), extra)
	}

	function unreadHint(c, w, text) {
		const g = w.group ? c.dev.groups.find(function (x) { return x.id === w.group }) : null
		return h('div', { class: 'dp-unread' },
			h('span', { class: 'dp-ph', text: text || (g && c.dev.queryable ? '读取' + g.title + '后显示' : (c.dev.queryable ? '未读' : '等设备上报')) }),
			g && c.dev.queryable && h('button', { type: 'button', class: 'dp-link', text: '读取', disabled: c.L.busy || !c.open, onclick: function () { readGroups([g.id], '读取' + g.title) } }))
	}

	function renderMetric(c, w) {
		const r = M.reading(c.L, w.key)
		const f = c.dev.fieldMap[w.key]
		const keys = [w.key].concat(w.sub || [])
		const box = h('div', { class: 'dp-metric' + (widgetStale(c, keys) ? ' is-stale' : '') },
			h('div', { class: 'dp-metric-l', text: w.title || f.name }),
			h('div', { class: 'dp-metric-v' }, r ? valBtn(c, w.key) : h('span', { class: 'dp-ph', text: '—' })))
		if (w.meter) {
			const mr = M.reading(c.L, w.meter)
			const pct = mr ? Math.max(0, Math.min(100, Number(mr.raw) || 0)) : null
			if (pct != null) box.append(h('div', { class: 'dp-meter', role: 'meter', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': c.dev.fieldMap[w.meter].name }, h('i', { style: 'width:' + pct + '%' })))
		}
		const subs = (w.sub || []).filter(function (k) { return M.reading(c.L, k) })
		if (subs.length) {
			box.append(h('div', { class: 'dp-metric-s' }, subs.map(function (k) {
				return h('span', {}, h('span', { class: 'dp-k', text: c.dev.fieldMap[k].name }), ' ', valBtn(c, k))
			})))
		}
		return box
	}

	function copyText(text, label) {
		const done = function (ok) { toast(ok ? '已复制 ' + label : '无法写剪贴板，请手动复制', ok ? 'success' : 'warn') }
		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text).then(function () { done(true) }, function () { done(false) })
				return
			}
		} catch (e) {}
		done(false)
	}

	function renderIdentity(c, w, narrow) {
		const have = w.keys.filter(function (k) { return M.reading(c.L, k) })
		const sum = have.slice(0, 2).map(function (k) { return c.dev.fieldMap[k].name + ' ' + valueText(c, k) }).join(' · ')
		const det = h('details', { class: 'dp-ids' + (widgetStale(c, w.keys) ? ' is-stale' : '') },
			h('summary', {}, h('span', { class: 'dp-ids-t', text: w.title || '设备标识' }), sum && h('span', { class: 'dp-ids-sum', text: sum })),
			have.length ? h('div', { class: 'dp-idstrip' }, w.keys.map(function (k) {
				const f = c.dev.fieldMap[k]
				const r = M.reading(c.L, k)
				return h('span', { class: 'dp-idchip' },
					h('span', { class: 'dp-k', text: f.name }),
					r ? valBtn(c, k) : h('span', { class: 'dp-ph', text: '—' }),
					r && h('button', { type: 'button', class: 'dp-copy', title: '复制', 'aria-label': '复制 ' + f.name, text: '⧉', onclick: function () { copyText(valueText(c, k), f.name) } }))
			})) : unreadHint(c, w))
		const key = 'ids:' + w.title
		const pref = c.L.ui[key]
		det.open = pref != null ? pref : !narrow
		det.addEventListener('toggle', function () { c.L.ui[key] = det.open })
		return det
	}

	function renderDeviceTime(c, w) {
		const r = M.reading(c.L, w.key)
		const info = M.deviceTimeInfo(r)
		if (!r || !info) return h('div', { class: 'dp-clock' }, h('span', { class: 'dp-ph', text: (w.title || '设备时间') + '：' }), unreadHint(c, w))
		const drift = info.driftSec
		const stale = M.isStale(r, c.gen)
		return h('div', { class: 'dp-clock' + (stale ? ' is-stale' : '') },
			h('span', { class: 'dp-ph', text: '读取时' + (w.title || '设备时间') }),
			valBtn(c, w.key, h('span', { class: 'dp-mono', text: M.fmtDateTime(info.deviceMs) })),
			h('span', { class: 'dp-pill ' + (Math.abs(drift) >= 3 ? 'is-warn' : 'is-ok'), text: Math.abs(drift) >= 3 ? '当时比电脑' + (drift > 0 ? '快 ' : '慢 ') + Math.abs(drift) + ' 秒' : '与电脑相差 3 秒以内' }),
			!stale && h('span', { class: 'dp-est', 'data-dp-est': w.key, text: estText(info) }))
	}

	function estText(info) {
		return '按读取时的偏差估算，设备现在约 ' + M.fmtClock(M.estimateDeviceNow(info, Date.now())) + '（估算，不是设备上报）'
	}

	function renderFlags(c, w) {
		const items = []
		w.keys.forEach(function (k) {
			const r = M.reading(c.L, k)
			if (!r) return
			const f = c.dev.fieldMap[k]
			if (f.kind === 'bits') {
				M.bitsList(f, r.raw).forEach(function (b) { items.push({ key: k, name: b.name, on: b.on, note: '' }) })
			} else {
				const st = M.flagState(r.raw)
				items.push({ key: k, name: f.name, on: st.on, note: st.note })
			}
		})
		const active = items.filter(function (x) { return x.on }).length
		return h('div', { class: 'dp-sec' },
			widgetHead(c, w, items.length ? h('span', { class: 'dp-pill ' + (active ? 'is-bad' : 'is-ok'), text: active ? active + ' 项告警中' : '无告警' }) : null),
			items.length ? h('div', { class: 'dp-flags' + (widgetStale(c, w.keys) ? ' is-stale' : '') }, items.map(function (x) {
				return h('button', { type: 'button', class: 'dp-flag' + (x.on ? ' is-on' : '') + (c.L.ui.sel === x.key ? ' is-sel' : ''), title: '查看来源帧', onclick: function () { c.L.ui.sel = x.key; render() } },
					x.name, x.on && x.note && h('span', { class: 'dp-flag-n', text: x.note }))
			})) : unreadHint(c, w))
	}

	function renderDayBitmap(c, w) {
		const r = M.reading(c.L, w.key)
		const subs = (w.sub || []).filter(function (k) { return M.reading(c.L, k) })
		const head = widgetHead(c, w, subs.length ? h('span', { class: 'dp-meta' }, subs.map(function (k, i) {
			return [i ? ' · ' : '', c.dev.fieldMap[k].name + ' ', valBtn(c, k)]
		})) : null)
		if (!r) return h('div', { class: 'dp-sec' }, head, unreadHint(c, w))
		// 「今天」取读到这一帧那天的日期（跨月读数不按今天截断）
		const readDay = new Date(r.at)
		const now = new Date()
		const sameMonth = readDay.getFullYear() === now.getFullYear() && readDay.getMonth() === now.getMonth()
		const cells = M.dayCells(w, r.raw, sameMonth ? readDay.getDate() : null)
		const label = function (st) { return st === 'future' ? '未到' : st === 'ok' ? (w.setMeans === 'bad' ? w.clearLabel : w.setLabel) : (w.setMeans === 'bad' ? w.setLabel : w.clearLabel) }
		return h('div', { class: 'dp-sec' + (M.isStale(r, c.gen) ? ' is-stale' : '') }, head,
			h('div', { class: 'dp-cal' }, cells.map(function (x) {
				return h('i', { 'data-state': x.state, title: x.day + ' 日：' + label(x.state), text: x.day })
			})),
			h('div', { class: 'dp-legend' },
				h('span', {}, h('i', { 'data-state': 'ok' }), w.setMeans === 'bad' ? w.clearLabel : w.setLabel),
				h('span', {}, h('i', { 'data-state': 'bad' }), w.setMeans === 'bad' ? w.setLabel : w.clearLabel),
				h('span', {}, h('i', { 'data-state': 'future' }), '未到'),
				valBtn(c, w.key, '原始位域')))
	}

	function renderKv(c, w) {
		const have = w.keys.filter(function (k) { return M.reading(c.L, k) })
		return h('div', { class: 'dp-sec' },
			widgetHead(c, w),
			have.length ? h('dl', { class: 'dp-kv' + (widgetStale(c, w.keys) ? ' is-stale' : '') }, w.keys.map(function (k) {
				return [h('dt', { text: c.dev.fieldMap[k].name }), h('dd', {}, valBtn(c, k))]
			})) : unreadHint(c, w))
	}

	function renderStatus(c, narrow) {
		const metrics = []
		const blocks = []
		c.dev.status.forEach(function (w) {
			if (w.type === 'metric') metrics.push(renderMetric(c, w))
			else if (w.type === 'identity') blocks.push(renderIdentity(c, w, narrow))
			else if (w.type === 'deviceTime') blocks.push(renderDeviceTime(c, w))
			else if (w.type === 'flags') blocks.push(renderFlags(c, w))
			else if (w.type === 'dayBitmap') blocks.push(renderDayBitmap(c, w))
			else if (w.type === 'kv') blocks.push(renderKv(c, w))
		})
		const groups = h('div', { class: 'dp-groups' }, c.dev.readSets.status.map(function (gid) { return groupLine(c, gid) }))
		return h('div', { class: 'dp-status' }, metrics.length && h('div', { class: 'dp-metrics' }, metrics), blocks, groups)
	}

	function currentCategory(c) {
		const cats = c.dev.categories
		if (!cats.length) return null
		return cats.find(function (x) { return x.id === c.L.ui.cat }) || cats[0]
	}

	function ago(at) {
		const s = Math.max(0, Math.round((Date.now() - at) / 1000))
		return s < 60 ? s + ' 秒前' : s < 3600 ? Math.round(s / 60) + ' 分钟前' : M.fmtClock(at)
	}

	function paramRow(c, k) {
		const f = c.dev.fieldMap[k]
		const r = M.reading(c.L, k)
		// 纯被动面板（协议没给查询）：有上报就显示，没有就是「等上报」；可查询面板里没有组的字段才是「读不到」
		const passive = !c.dev.queryable
		const readable = passive ? true : M.readable(c.dev, k)
		const stale = M.isStale(r, c.gen)
		let state
		if (!readable) state = h('span', { class: 'dp-ph', text: '读不到' })
		else if (!r) state = h('span', { class: 'dp-ph', text: passive ? '等上报' : '未读' })
		else if (stale) state = h('span', { class: 'dp-pill is-warn', text: '上次连接' })
		else if (M.readingUnsure(c.L, k)) state = h('span', { class: 'dp-pill is-warn', text: '归属未确认', title: M.readingUnsure(c.L, k) })
		else state = h('span', { class: 'dp-ph', 'data-dp-ago': r.at, text: ago(r.at) })
		return h('div', { class: 'dp-row' + (stale ? ' is-stale' : ''), 'data-key': k },
			h('div', { class: 'dp-row-n' }, h('b', { text: f.name }), f.addr && h('span', { class: 'dp-addr', text: f.addr })),
			h('div', { class: 'dp-row-v' }, h('span', { class: 'dp-cl', text: '当前' }),
				readable ? valBtn(c, k) : h('span', { class: 'dp-ph', text: '协议没有对应查询' })),
			h('div', { class: 'dp-row-s' }, state),
			(f.note || !readable) && h('div', { class: 'dp-row-note', text: !readable ? '这一项协议里没有对应的查询，读不到当前值' + (f.note ? '；' + f.note : '') : f.note }))
	}

	function renderParamRows(c, wrap) {
		const q = c.L.ui.query || ''
		const cat = currentCategory(c)
		const keys = q.trim() ? M.searchFields(c.dev, q) : (cat ? cat.keys : [])
		wrap.textContent = ''
		const gids = []
		keys.forEach(function (k) { const f = c.dev.fieldMap[k]; if (f && f.group && gids.indexOf(f.group) < 0) gids.push(f.group) })
		const noQuery = keys.some(function (k) { return !M.readable(c.dev, k) })
		const info = h('div', { class: 'dp-catinfo' }, gids.map(function (gid) { return groupLine(c, gid) }),
			noQuery && h('span', { class: 'dp-grp', 'data-state': 'none' }, h('span', { class: 'dp-grp-t', text: '部分参数协议里没有对应查询' })))
		if (!keys.length) {
			add(wrap, [info, h('div', { class: 'dp-empty', text: q.trim() ? '没有匹配「' + q.trim() + '」的参数' : '协议没有声明参数' })])
			return
		}
		const busyUnread = gids.find(function (gid) { const gv = M.groupView(c.L, gid, c.gen); return gv.state === 'busy' && !gv.at })
		if (busyUnread && !q.trim()) {
			add(wrap, [info, h('div', { class: 'dp-empty' }, h('span', { class: 'dp-spin' }), '正在读取' + M.groupTitle(c.dev, busyUnread) + '，读完后显示设备当前值')])
			return
		}
		add(wrap, [info,
			h('div', { class: 'dp-rhead' }, h('span', { text: '参数' }), h('span', { text: '设备当前值' }), h('span', { text: '状态' })),
			keys.map(function (k) { return paramRow(c, k) })])
	}

	function renderParams(c) {
		const cats = c.dev.categories
		if (!cats.length) return h('div', { class: 'dp-empty', text: '协议没有声明参数分类' })
		const cat = currentCategory(c)
		const rows = h('div', { class: 'dp-ptable-rows' })
		const search = h('input', { class: 'form-control form-control-sm dp-search', type: 'search', id: 'dp-param-search', placeholder: '搜索全部参数（名称或地址）', 'aria-label': '搜索参数', value: c.L.ui.query || '' })
		search.addEventListener('input', function () {
			c.L.ui.query = search.value
			renderParamRows(ctx(), rows)
		})
		const rail = h('nav', { class: 'dp-rail', 'aria-label': '参数类别' }, cats.map(function (x) {
			return h('button', {
				type: 'button',
				'aria-current': x.id === (cat && cat.id) && !(c.L.ui.query || '').trim() ? 'true' : 'false',
				text: x.title,
				onclick: function () {
					c.L.ui.cat = x.id
					c.L.ui.query = ''
					c.L.ui.sel = null
					render()
					autoReadCategory()
				},
			})
		}))
		renderParamRows(c, rows)
		return h('div', { class: 'dp-params' }, rail, h('div', { class: 'dp-ptable' }, h('div', { class: 'dp-ptools' }, search), rows))
	}

	function renderInspector(c) {
		const key = c.L.ui.sel
		const f = key && c.dev.fieldMap[key]
		const r = f && M.reading(c.L, key)
		if (!f || !r) return null
		const rec = M.findFrame(c.L, r.rec)
		const close = function () { c.L.ui.sel = null; render() }
		const box = h('aside', { class: 'dp-insp', 'aria-label': '来源帧' },
			h('div', { class: 'dp-insp-hd' },
				h('h4', { text: f.name }),
				h('button', { type: 'button', class: 'btn-close', 'aria-label': '关闭来源帧', onclick: close })),
			h('div', { class: 'dp-insp-val' }, h('span', { class: 'dp-k', text: '值' }), h('b', { text: valueText(c, key) })))
		if (!rec) {
			box.append(h('p', { class: 'dp-fine', text: '来源帧已不在缓存里（只保留最近的帧）' }))
			return box
		}
		const stale = rec.gen !== c.gen
		box.append(h('div', { class: 'dp-insp-src' },
			h('span', { text: '收到时间 ' + M.fmtDateTime(rec.at) }),
			h('span', { text: (rec.sid === 'S' ? '设备' : laneWord(rec.sid)) + ' · 连接代次 ' + rec.gen + (stale ? '（上次连接）' : '') }),
			h('span', { text: '协议 ' + protocolName(rec.pid) + ' · ' + rec.bytes.length + ' 字节' })))
		// 字节高亮：协议 byteMap 的分组里属于该字段的那些；对不上就只显示整帧，不猜偏移
		const proto = protocolEntry(rec.pid)
		let idx = []
		if (proto && typeof proto.byteMap === 'function' && c.dev.byteGroups) {
			let map = null
			try {
				map = R.createFramer && lanes() && typeof lanes().parseInLane === 'function'
					? lanes().parseInLane(rec.sid, function () { return proto.byteMap(rec.parsed) })
					: proto.byteMap(rec.parsed)
			} catch (e) { map = null }
			idx = M.highlightIndices(map, c.dev.byteGroups(rec.parsed, key))
		}
		const hl = new Set(idx)
		box.append(h('div', { class: 'dp-frame', 'aria-label': '整帧 HEX' }, rec.bytes.map(function (b, i) {
			return h('span', { class: hl.has(i) ? 'is-hl' : null, text: ((b & 0xff) < 16 ? '0' : '') + (b & 0xff).toString(16).toUpperCase() })
		})))
		box.append(h('p', { class: 'dp-fine', text: idx.length ? '高亮的 ' + idx.length + ' 个字节是这一项在帧里的位置（来自协议的字节分组）' : '协议没有给出这一项的字节分组，只显示整帧' }))
		const pv = window.ParseView
		if (proto && typeof proto.logView === 'function' && pv && typeof pv.render === 'function') {
			let model = null
			try { model = proto.logView(rec.parsed) } catch (e) { model = null }
			if (model) {
				const det = h('details', { class: 'dp-insp-parse' }, h('summary', { text: '整帧解析' }))
				const body = h('div', { class: 'dp-insp-parse-body' })
				// ParseView 统一转义模型文本；外部协议的 section.html 已被注册表剥离
				body.innerHTML = pv.render(model)
				det.append(body)
				box.append(det)
			}
		}
		return box
	}

	function render() {
		if (!root || view !== 'device') return
		const c = ctx()
		if (!c.dev) { root.textContent = ''; return }
		const L = c.L
		const prevBody = root.querySelector('.dp-body')
		const scroll = prevBody ? prevBody.scrollTop : 0
		const focusSearch = document.activeElement && document.activeElement.id === 'dp-param-search'
		const narrow = (root.clientWidth || window.innerWidth) < NARROW
		const read = M.latestStatusRead(c.dev, L)
		const nameKey = c.dev.nameKey
		const nameVal = nameKey && M.reading(L, nameKey) ? valueText(c, nameKey) : ''
		const title = c.dev.title || protocolName(c.pid)
		const readText = read
			? '状态读取于 ' + M.fmtClock(read.at) + (c.sid === 'S' ? '' : ' · ' + laneWord(c.sid)) + ' · 连接代次 ' + read.gen + (read.gen !== c.gen ? '（上次连接，已过期）' : '')
			: (c.dev.queryable ? '还没有读取过状态' : '还没有收到设备上报')
		const acts = !c.dev.queryable ? h('div', { class: 'dp-acts' }, h('span', { class: 'dp-ph', text: '只被动更新（协议没有声明查询）' })) : h('div', { class: 'dp-acts' },
			h('button', { type: 'button', class: 'btn btn-sm btn-primary', id: 'dp-read-status', text: L.busy ? '读取中…' : '读取状态', disabled: L.busy || !c.open, onclick: function () { readGroups(c.dev.readSets.status, '读取状态') } }),
			h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', id: 'dp-more', 'aria-expanded': L.ui.more ? 'true' : 'false', 'aria-haspopup': 'menu', text: '更多 ▾', onclick: function () { L.ui.more = !L.ui.more; render() } }),
			L.ui.more && h('div', { class: 'dp-menu', role: 'menu' },
				h('button', { type: 'button', role: 'menuitem', disabled: L.busy || !c.open, onclick: function () { L.ui.more = false; readGroups(c.dev.readSets.all, '全部读取') } },
					'全部读取', h('small', { text: '状态 + 全部参数，共 ' + c.dev.readSets.all.length + ' 组查询' })),
				h('button', { type: 'button', role: 'menuitem', disabled: !L.busy, onclick: function () { L.ui.more = false; cancelRead() } },
					'取消读取', h('small', { text: '没发出的组不再发送' }))))
		const head = h('div', { class: 'dp-head' },
			h('div', { class: 'dp-who' },
				h('b', {}, laneChip(c.sid), h('span', { text: title }), nameVal && h('span', { class: 'dp-name', text: nameVal })),
				h('span', { class: 'dp-readat', text: readText }),
				// 读取的归属限制如实写出来：宿主只能保证认领的是「查询发出后才开始」的匹配帧，迟到应答分不出来
				c.dev.queryable && h('span', { class: 'dp-limit', id: 'dp-read-limit', text: '读取认领查询发出后开始的第一条该组应答。更早命令或超时查询的迟到应答与本次应答无法区分；上次没等到应答的组，在本次连接内再读都标「归属未确认」，重新连接后恢复。读取期间请勿手动发送。' })),
			acts)
		const task = L.task && (!L.task.until || L.task.until > Date.now()) ? L.task : null
		const taskLine = task && h('div', { class: 'dp-task', 'data-kind': task.kind, role: 'status' }, task.kind === 'run' && h('span', { class: 'dp-spin' }), h('span', { text: task.text }))
		const tabs = h('div', { class: 'dp-tabs', role: 'tablist' },
			h('button', { type: 'button', role: 'tab', 'aria-selected': L.ui.tab === 'status' ? 'true' : 'false', text: '状态', onclick: function () { L.ui.tab = 'status'; L.ui.sel = null; render() } }),
			h('button', { type: 'button', role: 'tab', 'aria-selected': L.ui.tab === 'params' ? 'true' : 'false', text: '参数', onclick: function () { L.ui.tab = 'params'; L.ui.sel = null; render(); autoReadCategory() } }))
		let banner = null
		if (!c.open) {
			banner = h('div', { class: 'dp-banner is-bad' },
				h('span', { text: laneWord(c.sid) + '未连接。下面是断开前读到的值（灰色），连上后要重新读取。' }),
				h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', text: '连接', onclick: function () { const l = lanes(); if (l && l.toggle) l.toggle(c.sid) } }))
		} else if (M.anyStale(L, c.gen)) {
			const staleGroups = c.dev.groups.filter(function (g) { return M.groupView(L, g.id, c.gen).state === 'stale' }).map(function (g) { return g.id })
			banner = h('div', { class: 'dp-banner is-warn' },
				h('span', { text: '连接已重建。灰色读数来自上次连接，可能已经变了。' }),
				staleGroups.length > 0 && h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', text: '重新读取', disabled: L.busy, onclick: function () { readGroups(staleGroups, '重新读取') } }))
		}
		const body = h('div', { class: 'dp-body' }, L.ui.tab === 'params' ? renderParams(c) : renderStatus(c, narrow))
		root.textContent = ''
		root.dataset.lane = c.sid
		add(root, [head, taskLine, tabs, banner, body, renderInspector(c)])
		body.scrollTop = scroll
		if (focusSearch) {
			const s = document.getElementById('dp-param-search')
			if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length) }
		}
	}

	// 每秒：估算的设备时间、「x 秒前」、到期的任务提示
	function tick() {
		if (document.hidden) return
		sync()
		if (!root || view !== 'device') return
		updateStripSummary()
		const c = ctx()
		if (!c.L) return
		root.querySelectorAll('[data-dp-est]').forEach(function (el) {
			const info = M.deviceTimeInfo(M.reading(c.L, el.getAttribute('data-dp-est')))
			if (info) el.textContent = estText(info)
		})
		root.querySelectorAll('[data-dp-ago]').forEach(function (el) { el.textContent = ago(Number(el.getAttribute('data-dp-ago'))) })
		if (c.L.task && c.L.task.until && c.L.task.until <= Date.now()) {
			c.L.task = null
			render()
		}
	}

	// ---------- 通信记录条（设备面板子视图里，日志降为面板下方可收起的条） ----------
	// 日志节点原样不动、不克隆，也不往 #serial-logs-* 里插节点：只在 #log-main 末尾追加条头 #dp-log-head，
	// 由 #view-serial 上的 data-dplog（open / collapsed）与 --dp-log-h 交给 CSS 换布局（#main 排到面板下方并限高，
	// 右栏、停靠栏、日志工具条、协议解析与发送区隐藏），所以裁剪、导出、会话缓存、聊天视图、过滤、缩放都照旧。
	// 条的状态按主发那一路的协议 id 各存一份（js/log-layout.js），协议可用 device.log 给初始偏好，用户调整过就以用户为准。
	const LL = window.LogLayout
	const strip = { head: null, sum: null, cnt: null, tog: null, pid: undefined, dev: undefined, st: null, sumTimer: 0, drag: null }
	function storage() {
		try { return window.localStorage } catch (e) { return null }
	}
	function stripNarrow() {
		const P = window.AppPlatform
		if (P && P.profile === 'mobile') return true
		return !!(window.matchMedia && window.matchMedia('(max-width: ' + STRIP_NARROW + 'px)').matches)
	}
	// 条能用的总高度：#view-serial 去掉视图切换条（面板 + 条共分）
	function stripAvail() {
		const vs = document.getElementById('view-serial')
		if (!vs || !vs.clientHeight) return NaN
		return vs.clientHeight - (viewbar ? viewbar.offsetHeight : 0)
	}
	function fmtBytes(n) {
		n = Number(n) || 0
		if (n < 1024) return n + ' B'
		if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
		return (n / 1048576).toFixed(1) + ' MB'
	}
	function visibleLogBox() {
		return document.getElementById(isDual() ? 'serial-logs-dual' : 'serial-logs-single')
	}
	function termOn() {
		const b = document.getElementById('serial-log-view-term')
		return !!(b && b.getAttribute('aria-pressed') === 'true')
	}
	// 收起时那一行：最新一条记录的摘要 + 收发字节（只读日志行的文本，不改行）
	function updateStripSummary() {
		strip.sumTimer = 0
		if (!strip.head) return
		let text = ''
		if (termOn()) {
			text = '终端视图（切回通信调试查看完整终端）'
		} else {
			const box = visibleLogBox()
			let last = null
			if (box) {
				for (let i = box.children.length - 1; i >= 0; i--) {
					// 被日志过滤隐藏的行不算：摘要与用户在日志里看到的一致
					const r = box.children[i]
					if (r.classList.contains('log-row') && !r.classList.contains('mdn-flt-out')) { last = r; break }
				}
			}
			if (last) {
				const part = function (sel) { const el = last.querySelector(':scope > ' + sel); return el ? el.textContent.replace(/\s+/g, ' ').trim() : '' }
				text = [part('.log-time'), part('.log-dir'), part('.log-sess'), part('.log-body')].filter(Boolean).join(' ').slice(0, 240)
			} else {
				text = '还没有记录'
			}
		}
		strip.sum.textContent = text
		const hb = hub()
		const sids = isDual() ? ['A', 'B'] : ['S']
		strip.cnt.textContent = !hb || typeof hb.getStats !== 'function' ? '' : sids.map(function (sid) {
			const st = hb.getStats(sid)
			return (sid === 'S' ? '' : laneLabel(sid) + ' ') + 'TX ' + fmtBytes(st.txBytes) + ' · RX ' + fmtBytes(st.rxBytes)
		}).join('　')
	}
	function scheduleStripSummary() {
		if (strip.sumTimer || view !== 'device') return
		strip.sumTimer = setTimeout(updateStripSummary, 200)
	}
	function applyStrip() {
		const vs = document.getElementById('view-serial')
		if (!vs || !strip.st || !LL) return
		const h = LL.clampStripH(strip.st.h, stripAvail())
		const mode = strip.st.collapsed ? 'collapsed' : 'open'
		// 只在值变了时写：#view-serial 的 ResizeObserver 会因为这里改了布局再次触发
		if (vs.dataset.dplog !== mode) vs.dataset.dplog = mode
		if (vs.style.getPropertyValue('--dp-log-h') !== h + 'px') vs.style.setProperty('--dp-log-h', h + 'px')
		// 收起时日志窗只是压成 0 高（不用 display:none，导出的 innerText 才与展开时一致），inert 挡住其中控件的焦点与点击
		const panes = document.getElementById('serial-log-panes')
		if (panes) panes.inert = strip.st.collapsed && view === 'device'
		// 收起期间终端不 fit（否则被压成 1 行、裁掉历史），展开或离开设备视图时恢复并补 fit
		const T = window.SerialTerm
		if (T && typeof T.setFitSuspended === 'function') T.setFitSuspended(strip.st.collapsed && view === 'device')
		strip.tog.setAttribute('aria-expanded', strip.st.collapsed ? 'false' : 'true')
		strip.tog.title = strip.st.collapsed ? '展开通信记录' : '收起通信记录（拖动这一条可调高度）'
		updateStripSummary()
		// 自动滚动开着时，条变矮 / 展开后回到最新一行（只改滚动位置，不动行）
		const as = document.getElementById('serial-auto-scroll')
		if (!strip.st.collapsed && as && as.getAttribute('aria-pressed') === 'true') {
			setTimeout(function () {
				const box = visibleLogBox()
				if (box) box.scrollTop = box.scrollHeight
			}, 0)
		}
	}
	// 主发那一路的协议变了、或同 id 重新注册（device 声明对象换了，device.log 偏好可能变了）就重新套用；
	// 用户存档仍优先（stripStateFor）。force：窗口跨过窄屏断点等需要重新判定时
	function syncStrip(force) {
		if (!strip.head || !LL) return
		const c = ctx()
		const pid = c.dev ? c.pid : null
		const dev = c.dev || null
		if (!force && pid === strip.pid && dev === strip.dev && strip.st) return
		strip.pid = pid
		strip.dev = dev
		const st = LL.stripStateFor(LL.readStore(storage()), pid, c.dev && c.dev.log, stripNarrow())
		strip.st = { collapsed: st.collapsed, h: st.h }
		applyStrip()
	}
	function saveStrip() {
		if (strip.pid && LL) LL.saveStripState(storage(), strip.pid, strip.st)
	}
	function toggleStrip() {
		if (!strip.st) return
		strip.st.collapsed = !strip.st.collapsed
		applyStrip()
		saveStrip()
	}
	function mountStrip() {
		const logMain = document.getElementById('log-main')
		if (!logMain || !LL) return
		strip.tog = h('button', { type: 'button', class: 'dp-log-tog', 'aria-controls': 'serial-log-panes', 'aria-expanded': 'true', onclick: toggleStrip },
			h('i', { class: 'bi bi-chevron-down', 'aria-hidden': 'true' }), h('span', { text: '通信记录' }))
		strip.sum = h('span', { class: 'dp-log-sum' })
		strip.cnt = h('span', { class: 'dp-log-cnt' })
		strip.head = h('div', { class: 'dp-log-head', id: 'dp-log-head', role: 'group', 'aria-label': '通信记录' },
			strip.tog, strip.sum, strip.cnt,
			h('button', { type: 'button', class: 'dp-log-go', text: '通信调试', title: '切回通信调试：完整的日志工具、过滤与发送', onclick: function () { setView('comm') } }))
		// 追加在末尾（CSS 用 order 排到最前）：插到最前会抢走 #log-main > div:first-child 给日志工具条的样式
		logMain.appendChild(strip.head)
		const head = strip.head
		// 拖条头调高度（收起时向上拖即展开），不动就是点击：切换收起
		head.addEventListener('pointerdown', function (e) {
			if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return
			const main = document.getElementById('main')
			strip.drag = { y: e.clientY, h: main ? main.getBoundingClientRect().height : strip.st.h, moved: false }
			try { head.setPointerCapture(e.pointerId) } catch (x) {}
		})
		head.addEventListener('pointermove', function (e) {
			const d = strip.drag
			if (!d) return
			const dy = d.y - e.clientY
			if (!d.moved && Math.abs(dy) < 4) return
			d.moved = true
			strip.st.collapsed = false
			strip.st.h = LL.clampStripH(d.h + dy, stripAvail())
			applyStrip()
		})
		function end(e) {
			const d = strip.drag
			if (!d) return
			strip.drag = null
			try { head.releasePointerCapture(e.pointerId) } catch (x) {}
			if (d.moved) saveStrip()
			else if (e.type === 'pointerup') toggleStrip()
		}
		head.addEventListener('pointerup', end)
		head.addEventListener('pointercancel', end)
		// 最新记录摘要：只观察日志容器的子节点增减（读文本，不改节点）
		if (typeof MutationObserver === 'function') {
			const mo = new MutationObserver(scheduleStripSummary)
			;['serial-logs-single', 'serial-logs-dual'].forEach(function (id) {
				const box = document.getElementById(id)
				if (box) mo.observe(box, { childList: true })
			})
		}
		// 窗口变高变矮：重新钳制高度；跨过窄屏断点：没调整过的协议重新判定默认（窄屏收起成一行）
		const vs = document.getElementById('view-serial')
		// 回调里不直接改布局（改了会在同一帧再触发观察，报 ResizeObserver loop），推到下一轮再钳
		let roTimer = 0
		if (vs && typeof ResizeObserver === 'function') {
			new ResizeObserver(function () {
				if (view !== 'device' || roTimer) return
				roTimer = setTimeout(function () { roTimer = 0; if (view === 'device' && !strip.drag) applyStrip() }, 50)
			}).observe(vs)
		}
		if (window.matchMedia) {
			const mq = window.matchMedia('(max-width: ' + STRIP_NARROW + 'px)')
			const onMq = function () { syncStrip(true) }
			if (mq.addEventListener) mq.addEventListener('change', onMq)
			else if (mq.addListener) mq.addListener(onMq)
		}
	}

	// ---------- 挂载 ----------
	function mount() {
		if (mounted) return
		const P = window.AppPlatform
		if (P && typeof P.has === 'function' && !P.has('view.device')) return
		const vs = document.getElementById('view-serial')
		const main = document.getElementById('main')
		if (!vs || !main || main.parentNode !== vs) return
		mounted = true
		viewbar = h('div', { class: 'dp-viewbar', id: 'dp-viewbar' },
			h('div', { class: 'ctl-seg', role: 'group', 'aria-label': '通信调试视图' },
				h('button', { type: 'button', id: 'dp-view-comm', 'aria-pressed': 'true', text: '通信调试', onclick: function () { setView('comm') } }),
				h('button', { type: 'button', id: 'dp-view-device', 'aria-pressed': 'false', text: '设备面板', onclick: function () { setView('device') } })),
			h('span', { class: 'dp-why' }))
		root = h('section', { class: 'dp', id: 'device-panel', 'aria-label': '设备面板' })
		root.hidden = true
		vs.insertBefore(viewbar, main)
		vs.insertBefore(root, main.nextSibling)
		mountStrip()
		;['S', 'A', 'B'].forEach(function (sid) { pumps[sid] = makePump(sid) })
		document.addEventListener('serial-session', function (ev) {
			const d = ev && ev.detail
			if (d && pumps[d.sid]) pumps[d.sid].reset()
			sync()
		})
		document.addEventListener('serial-lane-config', sync)
		document.addEventListener('serial-protocol-registry-change', function () { sync(); if (view === 'device') render() })
		const sel = document.getElementById('serial-protocol-select')
		if (sel) sel.addEventListener('change', function () { setTimeout(sync, 0) })
		document.addEventListener('click', function (e) {
			// 主发 / 单双路切换没有专门的事件，点完稍后同步一次（1 s 轮询兜底）
			if (e.target && e.target.closest && e.target.closest('.dual-send-btn, .serial-mode-btn, [data-send-target]')) setTimeout(sync, 0)
			// 「更多」菜单点外面收起
			const c = ctx()
			if (c.L && c.L.ui.more && root && !(e.target.closest && e.target.closest('.dp-acts'))) {
				c.L.ui.more = false
				render()
			}
		}, true)
		document.addEventListener('keydown', function (e) {
			if (e.key !== 'Escape' || view !== 'device') return
			if (window.AppDialog && typeof window.AppDialog.isOpen === 'function' && window.AppDialog.isOpen()) return
			const c = ctx()
			if (c.L && (c.L.ui.sel || c.L.ui.more)) {
				c.L.ui.sel = null
				c.L.ui.more = false
				render()
			}
		})
		setInterval(tick, 1000)
		let saved = null
		try { saved = sessionStorage.getItem(SUBVIEW_KEY) } catch (e) {}
		setView(saved === 'device' ? 'device' : 'comm', true)
		lastSig = ''
		sync()
	}

	window.DevicePanel = {
		show: function () {
			const rail = document.querySelector('.rail-item[data-view="view-serial"]')
			if (rail && !rail.classList.contains('active')) rail.click()
			if (!setView('device')) toast(availability().why, 'warn')
		},
		showComm: function () { if (view !== 'comm') setView('comm', true) },
		view: function () { return view },
		// 通信记录条当前状态（测试与自检用）：{ pid, collapsed, h }
		logStrip: function () { return strip.st ? { pid: strip.pid, collapsed: strip.st.collapsed, h: strip.st.h } : null },
		available: function () { return availability().ok },
		// 状态栏任务芯片：主发那一路的读取进度 / 结果（结果保留几秒）
		task: function () {
			const c = ctx()
			const t = c.L && c.L.task
			if (!t) return null
			if (t.until && t.until <= Date.now()) return null
			const prefix = t.kind === 'run' ? '⟳ ' : t.kind === 'ok' ? '✓ ' : '⚠ '
			return { kind: t.kind, text: prefix + (c.sid === 'S' ? '' : laneWord(c.sid) + ' · ') + t.text }
		},
		readStatus: function () { const c = ctx(); if (c.dev) readGroups(c.dev.readSets.status, '读取状态') },
		// 测试与自检用：模型与状态只读访问
		_store: store,
		_render: render,
		_sync: sync,
		_pumps: pumps,
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(mount, 0) })
	else setTimeout(mount, 0)
})()
