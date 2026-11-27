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
	// 读取认领的归属限制：宿主只能保证认领「查询发出后才开始」的匹配帧，迟到应答分不出来
	const READ_LIMIT_SHORT = '迟到应答可能与本次应答混淆，读写期间请勿手动发送'
	const READ_LIMIT_FULL = '面板只认领请求发出后开始的匹配应答。更早命令的迟到应答可能与本次应答混淆；上次没等到应答的查询组，在本次连接内再读都标「归属未确认」，重新连接后恢复。读写期间请勿手动发送。'
	const M = window.DeviceModel
	const R = window.ProtocolRequest
	if (!M || !R) return

	const store = M.createStore()
	let view = 'comm'
	let root = null
	let fwRoot = null
	let viewbar = null
	let mounted = false
	let renderTimer = 0
	let lastSig = ''
	let writing = null
	const WRITE_LABELS = { confirmed: '回读一致 ✓', mismatch: '回读不一致', rejected: '设备拒绝', unconfirmed: '已应答未确认', processing: '设备处理中', skipped: '未执行', unknown: '已发出、结果未知' }

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

	function stopFlow(error) {
		return ['generation', 'closed', 'cancelled', 'protocol', 'foreign'].includes(error.code)
	}

	async function requestGroup(c, flow, group) {
		const gid = group.id
		const late = M.isLate(c.L, gid, flow.gen)
		M.setGroupBusy(c.L, gid, true)
		try {
			const result = await flow.readGroup(c.dev, group)
			const record = result.item.res
			if (late) M.markRecUnsure(c.L, record.rec.id, '归属未确认：这一组在本次连接里有查询没等到应答，读到的可能是那次的迟到应答')
			return { record: record, unsure: late }
		} catch (error) {
			M.setGroupError(c.L, gid, failText(error), flow.gen, Date.now())
			if (error.sent && error.code !== 'generation' && error.code !== 'closed') M.markLate(c.L, gid, flow.gen)
			throw error
		} finally {
			M.setGroupBusy(c.L, gid, false)
		}
	}

	// ---------- 读取 ----------
	async function runRead(label, gids, afterRead) {
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
			try {
				const pending = requestGroup(c, flow, g)
				render()
				const result = await pending
				if (result.unsure) unsure++
				else ok++
				if (afterRead) afterRead(result)
			} catch (e) {
				fail++
				firstErr = firstErr || failText(e)
				if (stopFlow(e)) {
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

	function writeText(field, raw) {
		if (raw == null) return ''
		if (field.kind === 'hex' && typeof raw === 'number') return raw.toString(16).toUpperCase()
		return Array.isArray(raw) ? raw.join(', ') : String(raw)
	}

	function confirmationFor(field, result) {
		return { raw: result.record.values && result.record.values[field.key], unsure: result.unsure,
			detail: result.unsure ? '回读归属未确认' : '' }
	}

	function writeStopReason(error, submitted) {
		return ({ generation: '连接变化', closed: '连接关闭', protocol: '协议变化', cancelled: '取消写入', foreign: '检测到其它发送', timeout: '等待写入应答超时' })[error.code]
			|| (submitted ? '回读中断' : '写入结果未知')
	}

	async function runWrite(c, keys) {
		if (writing || c.L.busy || !c.open || !keys.length || !c.dev.buildWrite) return
		const L = c.L
		const dev = c.dev
		const plan = keys.filter(function (key) { return dev.fieldMap[key] && dev.fieldMap[key].write && Object.prototype.hasOwnProperty.call(L.drafts, key) })
		if (!plan.length) return
		const pump = pumps[c.sid]
		const entry = protocolEntry(c.pid)
		if (!entry || entry.device !== dev || protocolOf(c.sid) !== c.pid || genOf(c.sid) !== c.gen) return
		let flow
		try { flow = R.begin(c.sid, { source: pump && pump.source, position: pump && pump.position }) }
		catch (error) {
			plan.forEach(function (key) { L.writes[key] = Object.assign(M.writeResult(null, null, error), { gen: c.gen }) })
			L.task = { kind: 'bad', text: '写入未开始：' + error.message, until: Date.now() + 8000, sid: c.sid }
			render()
			return
		}
		L.busy = true
		L.flow = flow
		writing = flow
		let stop = null
		let submitted = false
		try {
			for (const [index, key] of plan.entries()) {
				const field = dev.fieldMap[key]
				if (stop) {
					L.writes[key] = { state: 'skipped', detail: stop, gen: flow.gen }
					continue
				}
				const text = L.drafts[key]
				let expected
				submitted = false
				try {
					const before = flow.check()
					if (before) throw before
					L.task = { kind: 'run', text: '写入 ' + (index + 1) + '/' + plan.length + ' · ' + field.name, sid: c.sid }
					render()
					if (!M.writeAllowed(L, field, flow.gen)) throw new Error('先读取当前值')
					expected = M.inputValue(dev, field, text)
					const warning = !field.group ? '当前值无法从设备读取，写入后只能确认设备已应答、无法确认是否生效。' : ''
					if (warning || field.write.confirm) {
						const batchWarning = index + 1 < plan.length ? '取消此项会中止本轮，后续项不会发送。' : ''
						const confirmed = await window.AppDialog.confirm([warning, field.write.confirm, batchWarning].filter(Boolean).join('\n'), { title: '写入「' + field.name + '」？', danger: true })
						if (!confirmed) { flow.cancel('已取消写入'); throw flow.check() }
					}
					const reply = await flow.writeField(dev, field, expected, { sid: c.sid, gen: flow.gen, text: text, get: M.getter(L, flow.gen) })
					submitted = true
					const group = reply === 'ok' && field.group && dev.groups.find(function (item) { return item.id === field.group })
					const confirmation = group ? confirmationFor(field, await requestGroup(c, flow, group)) : null
					L.writes[key] = Object.assign(M.writeResult(reply, confirmation, null, expected), { expected: expected, gen: flow.gen, text: text })
					if (L.writes[key].state === 'confirmed') delete L.drafts[key]
				} catch (error) {
					L.writes[key] = Object.assign(submitted ? M.writeResult('ok', { detail: failText(error) }) : M.writeResult(null, null, error), { gen: flow.gen })
					if (field.secret && error.code === 'build') L.writes[key].detail = '保密字段编码失败'
					if ((stopFlow(error) || (!submitted && error.sent)) && index + 1 < plan.length) {
						stop = '前一项（' + field.name + '）' + writeStopReason(error, submitted) + '后中止，未发送'
						L.writes[key].detail += '；已中止本轮，后续项未发送'
					}
				}
			}
		} finally {
			flow.end()
			L.flow = null
			L.busy = false
			writing = null
			const totals = Object.create(null)
			plan.forEach(function (key) { const state = L.writes[key].state; totals[state] = (totals[state] || 0) + 1 })
			const summary = Object.keys(WRITE_LABELS).filter(function (state) { return totals[state] }).map(function (state) { return WRITE_LABELS[state] + ' ' + totals[state] })
			L.task = { kind: totals.confirmed === plan.length ? 'ok' : 'warn', text: '写入 · ' + summary.join(' · '), until: Date.now() + 10000, sid: c.sid }
			render()
		}
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
	function hasFirmwarePack() {
		const P = window.AppPlatform
		return !P || typeof P.has !== 'function' || P.has('view.firmware-pack')
	}
	function hasFirmwareView() {
		const P = window.AppPlatform
		return !!fwRoot && (!P || typeof P.has !== 'function' || P.has('panel.firmware') || P.has('view.firmware-pack'))
	}
	function firmwareInfo() {
		const hb = hub()
		const sid = hb && typeof hb.activeSendPhys === 'function' ? hb.activeSendPhys() : mainSid()
		const pid = protocolOf(sid)
		const entry = protocolEntry(pid)
		const supported = !!(entry && entry.firmware && entry.firmware.method === 'pcp')
		if (!supported) {
			return {
				ok: false,
				sid: sid,
				pid: pid,
				why: protocolName(pid) + (hasFirmwarePack()
					? ' 不支持在线升级（仍可生成固件打包、选择固件与管理本机固件库）'
					: ' 不支持固件升级（仍可选择固件、管理本机固件库）'),
			}
		}
		return { ok: true, sid: sid, pid: pid, why: isDual() ? '固件升级走主发 ' + laneWord(sid) + '（' + protocolName(pid) + '）' : '' }
	}
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
		const want = v === 'device' ? 'device' : (v === 'firmware' ? 'firmware' : 'comm')
		if (want === 'device' && !availability().ok) return false
		if (want === 'firmware' && !hasFirmwareView()) return false
		view = want
		try { sessionStorage.setItem(SUBVIEW_KEY, view) } catch (e) {}
		const vs = document.getElementById('view-serial')
		if (vs) vs.dataset.subview = view
		if (root) root.hidden = view !== 'device'
		if (fwRoot) fwRoot.hidden = view !== 'firmware'
		// 终端在通信记录条里只读：键入 / 粘贴不写主发口（common.js 的发送回调入口另有复核）
		if (window.SerialTerm && typeof window.SerialTerm.setInputEnabled === 'function') window.SerialTerm.setInputEnabled(view === 'comm')
		if (view !== 'comm') syncStrip(true)
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
		try { document.dispatchEvent(new CustomEvent('dp-subview-change', { detail: { view: view } })) } catch (e) {}
		return true
	}

	function renderViewbar() {
		if (!viewbar) return
		const av = availability()
		const devBtn = viewbar.querySelector('#dp-view-device')
		const commBtn = viewbar.querySelector('#dp-view-comm')
		const fwBtn = viewbar.querySelector('#dp-view-firmware')
		if (devBtn) {
			devBtn.disabled = !av.ok
			devBtn.title = av.ok ? '' : av.why
			devBtn.setAttribute('aria-pressed', view === 'device' ? 'true' : 'false')
		}
		if (commBtn) commBtn.setAttribute('aria-pressed', view === 'comm' ? 'true' : 'false')
		if (fwBtn) {
			fwBtn.hidden = !hasFirmwareView()
			fwBtn.setAttribute('aria-pressed', view === 'firmware' ? 'true' : 'false')
		}
		const whyEl = viewbar.querySelector('.dp-why')
		if (whyEl) whyEl.textContent = view === 'firmware' ? firmwareInfo().why : av.why
	}

	// 主发路 / 协议 / 连接代次变化时同步：协议没有 device 了就退回通信调试；固件升级子视图不踢回（遵循升级中切协议不打断本轮）
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
		if (view !== 'comm') syncStrip(false)
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
		if (r && c.dev.fieldMap[key] && c.dev.fieldMap[key].secret) return '••••'
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
					r && !f.secret && h('button', { type: 'button', class: 'dp-copy', title: '复制', 'aria-label': '复制 ' + f.name, text: '⧉', onclick: function () { copyText(valueText(c, k), f.name) } }))
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
			if (w.type === 'metric') {
				if (w.optional && !M.reading(c.L, w.key) && !(w.sub || []).some(function (k) { return !!M.reading(c.L, k) })) return
				metrics.push(renderMetric(c, w))
			}
			else if (w.type === 'identity') blocks.push(renderIdentity(c, w, narrow))
			else if (w.type === 'deviceTime') blocks.push(renderDeviceTime(c, w))
			else if (w.type === 'flags') blocks.push(renderFlags(c, w))
			else if (w.type === 'dayBitmap') blocks.push(renderDayBitmap(c, w))
			else if (w.type === 'kv') blocks.push(renderKv(c, w))
		})
		const protocol = protocolEntry(c.pid)
		const firmware = protocol && protocol.firmware
		if (firmware && (hasFirmwareView() || window.Workbench)) {
			const key = firmware.versionKey
			blocks.push(h('div', { class: 'dp-ids d-flex flex-wrap align-items-center gap-2' },
				key && c.dev.fieldMap[key] && h('span', { class: 'd-inline-flex align-items-center gap-2' },
					h('span', { class: 'dp-meta', text: '当前固件版本' }), valBtn(c, key)),
				h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', text: '固件升级', onclick: function () {
					if (!setView('firmware') && window.Workbench) window.Workbench.open('firmware')
				} })))
		}
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
		if (!readable && !r) state = h('span', { class: 'dp-ph', text: '读不到' })
		else if (!r) state = h('span', { class: 'dp-ph', text: passive ? '等上报' : '未读' })
		else if (stale) state = h('span', { class: 'dp-pill is-warn', text: '上次连接' })
		else if (M.readingUnsure(c.L, k)) state = h('span', { class: 'dp-pill is-warn', text: '归属未确认', title: M.readingUnsure(c.L, k) })
		else state = !f.group && f.write ? h('span', { class: 'dp-ph', text: '被动读数 · 仅供参考' }) : h('span', { class: 'dp-ph', 'data-dp-ago': r.at, text: ago(r.at) })
		const result = c.L.writes[k]
		const hasDraft = Object.prototype.hasOwnProperty.call(c.L.drafts, k)
		const ready = M.writeAllowed(c.L, f, c.gen)
		const disabled = !!writing || c.L.busy || !c.open
		const button = function (label, click, off) {
			return h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', text: label, onclick: click, disabled: !!off })
		}
		const rowClass = function (dirty) {
			return 'dp-row' + (stale ? ' is-stale' : '') + (dirty ? ' is-dirty' : '') + (f.write ? '' : ' is-readonly')
		}
		let rowEl = null
		const syncRowDirty = function () {
			if (!rowEl) return
			rowEl.className = rowClass(Object.prototype.hasOwnProperty.call(c.L.drafts, k))
		}
		let editor = null
		if (f.write) {
			const opts = f.write.options
			const canEmpty = M.allowsEmpty(c.dev, f)
			const attrs = { id: 'dp-set-' + k, disabled: disabled || !ready, 'aria-label': f.name + '设置值', title: f.write.hint }
			const input = opts
				? h('select', Object.assign(attrs, { class: 'form-select form-select-sm' }), h('option', { value: '', text: '请选择', disabled: true }), Object.keys(opts).map(function (value) { return h('option', { value: value, text: opts[value] }) }))
				: h('input', Object.assign(attrs, { class: 'form-control form-control-sm', type: f.secret ? 'password' : 'text', autocomplete: 'off', maxlength: f.write.maxLen, placeholder: ready ? (f.write.hint || '输入设置值') : '先读取' }))
			input.value = hasDraft ? c.L.drafts[k] : ''
			const commit = button('写入', function () { runWrite(c, [k]) }, disabled || !ready || !hasDraft)
			const preview = !f.secret && h('span', { class: 'dp-ph dp-write-preview' })
			function parseSetting(show) {
				let raw
				try { if (show) raw = M.inputValue(c.dev, f, input.value) } catch (error) {}
				if (preview) preview.textContent = raw === undefined ? '' : '预览：' + M.formatValue(c.dev, k, raw, M.getter(c.L, c.gen))
				return raw
			}
			const clearBtn = canEmpty ? button('置空', function () {
				const draftedEmpty = Object.prototype.hasOwnProperty.call(c.L.drafts, k) && c.L.drafts[k] === ''
				if (draftedEmpty) {
					delete c.L.drafts[k]
					input.value = ''
					if (preview) preview.textContent = ''
					commit.disabled = true
					syncClearBtn()
					syncRowDirty()
					syncDraftToolbar(c)
					return
				}
				input.value = ''
				applyDraft(true)
			}, true) : null
			function syncClearBtn() {
				if (!clearBtn) return
				const draftedEmpty = Object.prototype.hasOwnProperty.call(c.L.drafts, k) && c.L.drafts[k] === ''
				const alreadyEmpty = !!(r && !stale && r.raw === '')
				clearBtn.textContent = draftedEmpty ? '取消置空' : '置空'
				clearBtn.title = draftedEmpty ? '撤销置空草稿' : '将此项设为空值待写入'
				clearBtn.disabled = disabled || !ready || (!draftedEmpty && alreadyEmpty)
			}
			function applyDraft(explicitEmpty) {
				if (!explicitEmpty && input.value === '' && !canEmpty) {
					delete c.L.drafts[k]
					if (preview) preview.textContent = ''
					commit.disabled = true
					syncClearBtn()
					syncRowDirty()
					syncDraftToolbar(c)
					return
				}
				const raw = parseSetting(true)
				const changed = raw === undefined || !r || stale || !M.sameValue(r.raw, raw)
				if (changed) c.L.drafts[k] = input.value
				else {
					delete c.L.drafts[k]
					if (preview) preview.textContent = ''
				}
				commit.disabled = disabled || !ready || !changed
				syncClearBtn()
				syncRowDirty()
				syncDraftToolbar(c)
			}
			parseSetting(hasDraft)
			syncClearBtn()
			input.addEventListener('input', function () { applyDraft(false) })
			input.addEventListener('keydown', function (ev) {
				if (ev && ev.key === 'Enter' && !commit.disabled) {
					if (ev.preventDefault) ev.preventDefault()
					runWrite(c, [k])
				}
			})
			editor = h('div', { class: 'dp-row-edit' },
				h('div', { class: 'dp-row-edit-line' }, input, clearBtn, commit),
				preview)
		}
		const rowActions = result && result.state === 'mismatch' && hasDraft ? [
			button('重试', function () { runWrite(c, [k]) }, disabled || !ready),
			button('改用设备值', function () { delete c.L.drafts[k]; delete c.L.writes[k]; render() }, disabled),
		] : result && result.state === 'processing' && result.gen === c.gen && f.group ? button('稍后回读', function () {
			const finish = function (reading) {
				const next = M.writeResult('ok', confirmationFor(f, reading), null, result.expected)
				c.L.writes[k] = Object.assign(next, { gen: c.gen })
				if (next.state === 'confirmed' && c.L.drafts[k] === result.text) delete c.L.drafts[k]
			}
			runRead('稍后回读', [f.group], finish)
		}, disabled) : result && result.state === 'rejected' && hasDraft ? button('撤销', function () {
			delete c.L.drafts[k]; delete c.L.writes[k]; render()
		}, disabled) : null
		const hasWriteFooter = !!(result || rowActions)
		rowEl = h('div', { class: rowClass(hasDraft), 'data-key': k },
			h('div', { class: 'dp-card-head' },
				h('div', { class: 'dp-row-n' }, h('b', { text: f.name }), f.addr && h('span', { class: 'dp-addr', text: f.addr })),
				h('div', { class: 'dp-card-meta' }, state, !f.write && h('span', { class: 'dp-pill', text: '只读' }))),
			h('div', { class: 'dp-row-v' },
				h('span', { class: 'dp-cl', text: '当前' }),
				(readable || r) ? valBtn(c, k) : h('span', { class: 'dp-ph', text: '无对应查询' })),
			editor,
			hasWriteFooter && h('div', { class: 'dp-row-s' },
				result && h('div', { class: 'dp-write-result', 'data-state': result.state, text: (result.gen !== c.gen ? '上次连接 · ' : '') + WRITE_LABELS[result.state] + (result.detail ? '：' + result.detail : '') }),
				rowActions && h('div', { class: 'dp-row-acts' }, rowActions)),
			(f.note || !readable) && h('div', { class: 'dp-row-note', text: !readable ? '这一项协议里没有对应的查询' + (f.note ? '；' + f.note : '') : f.note }))
		return rowEl
	}

	function draftKeys(c) {
		return Object.keys(c.L.drafts).filter(function (key) { const field = c.dev.fieldMap[key]; return field && field.write })
	}

	function syncDraftToolbar(c) {
		const count = document.getElementById('dp-draft-count')
		const commit = document.getElementById('dp-write-all')
		const undo = document.getElementById('dp-undo-all')
		if (!count || !commit || !undo) return
		const keys = draftKeys(c)
		count.textContent = keys.length ? (keys.length + ' 项待写入') : '无改动'
		commit.disabled = !!writing || c.L.busy || !c.open || !keys.some(function (key) { return M.writeAllowed(c.L, c.dev.fieldMap[key], c.gen) })
		undo.disabled = !!writing || c.L.busy || !keys.length
		if (root && typeof root.querySelectorAll === 'function' && c.dev && Array.isArray(c.dev.categories)) {
			const draftSet = new Set(keys)
			const dirtyByCat = Object.create(null)
			c.dev.categories.forEach(function (cat) {
				let n = 0
				cat.keys.forEach(function (k) { if (draftSet.has(k)) n++ })
				dirtyByCat[cat.id] = n
			})
			root.querySelectorAll('.dp-rail > button[data-cat]').forEach(function (btn) {
				const n = dirtyByCat[btn.dataset.cat] || 0
				const badge = btn.querySelector('.dp-rail-dirty')
				if (badge) {
					badge.textContent = n ? String(n) : ''
					badge.hidden = !n
				}
			})
		}
	}

	function downloadSnapshot(c) {
		const data = M.exportSnapshot(c.L, c.dev, writeText)
		const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
		const link = h('a', { href: url, download: 'device-snapshot.json' })
		document.body.append(link)
		link.click()
		link.remove()
		setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
	}

	async function importSnapshot(c, file) {
		if (!file) return
		try {
			if (file.size > 1024 * 1024) throw new Error('快照文件过大')
			const data = JSON.parse(await file.text())
			const rows = M.compareSnapshot(c.L, c.dev, c.gen, data)
			const labels = { same: '一致', different: '不一致', unread: '未读或过期' }
			const diff = new Set(rows.filter(function (row) { return row.state === 'different' }).map(function (row) { return row.field.key }))
			await window.AppDialog.panel({ title: '快照对比', wide: true, build: function (body, controls) {
				const notice = h('p', { text: '仅将确认不一致的项加入草稿，不发送。' })
				body.append(notice)
				add(body, Object.keys(labels).map(function (state) {
					const subset = rows.filter(function (row) { return row.state === state })
					return h('details', { open: state === 'different' }, h('summary', { text: labels[state] + ' ' + subset.length + ' 项' }),
						h('ul', {}, subset.map(function (row) {
							const current = state !== 'unread' ? ' · 当前：' + valueText(c, row.field.key) : ''
							return h('li', { text: row.field.name + current + ' · 快照：' + row.formatted })
						})))
				}))
				if (diff.size) body.append(h('button', { type: 'button', class: 'btn btn-sm btn-primary mt-2', text: '套用', onclick: function () {
					const now = ctx()
					if (writing || now.L !== c.L || now.L.busy || now.dev !== c.dev || now.gen !== c.gen) {
						notice.textContent = '连接或协议已变化，请关闭后重新导入。'
						return
					}
					M.applySnapshot(c.L, M.compareSnapshot(c.L, c.dev, c.gen, data).filter(function (row) { return diff.has(row.field.key) }))
					controls.close()
					render()
				} }))
			} })
		} catch (error) { await window.AppDialog.alert(error.message, { title: '无法导入快照' }) }
	}

	function renderParamRows(c, wrap) {
		const q = c.L.ui.query || ''
		const cat = currentCategory(c)
		const keys = q.trim() ? M.searchFields(c.dev, q) : (cat ? cat.keys : [])
		wrap.textContent = ''
		const gids = []
		keys.forEach(function (k) { const f = c.dev.fieldMap[k]; if (f && f.group && gids.indexOf(f.group) < 0) gids.push(f.group) })
		const noQuery = keys.some(function (k) { return !M.readable(c.dev, k) })
		const info = h('div', { class: 'dp-catinfo' },
			!q.trim() && cat && h('span', { class: 'dp-cat-title', text: cat.title + '（' + keys.length + ' 项）' }),
			q.trim() && h('span', { class: 'dp-cat-title', text: '搜索结果（' + keys.length + ' 项）' }),
			gids.map(function (gid) { return groupLine(c, gid) }),
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
		add(wrap, [info, h('div', { class: 'dp-pgrid' }, keys.map(function (k) { return paramRow(c, k) }))])
	}

	function renderParams(c) {
		const cats = c.dev.categories
		const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: function () { importSnapshot(c, file.files[0]); file.value = '' } })
		const actions = h('div', { class: 'dp-write-tools' },
			h('span', { id: 'dp-draft-count', class: 'dp-draft-badge', role: 'status' }),
			h('button', { type: 'button', id: 'dp-write-all', class: 'btn btn-sm btn-primary', text: '全部写入', onclick: function () { runWrite(c, draftKeys(c)) } }),
			h('button', { type: 'button', id: 'dp-undo-all', class: 'btn btn-sm btn-outline-secondary', text: '撤销全部', onclick: function () { draftKeys(c).forEach(function (key) { delete c.L.drafts[key]; delete c.L.writes[key] }); render() } }),
			writing && c.L.flow === writing && h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', text: '取消写入', onclick: cancelRead }),
			h('span', { class: 'dp-tools-sep', 'aria-hidden': 'true' }),
			h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', text: '导出快照', onclick: function () { downloadSnapshot(c) } }),
			h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', text: '导入快照', disabled: !!writing || c.L.busy, onclick: function () { file.click() } }), file)
		if (!cats.length) return h('div', {}, actions, h('div', { class: 'dp-empty', text: '协议没有声明参数分类' }))
		const cat = currentCategory(c)
		const rows = h('div', { class: 'dp-ptable-rows' })
		const search = h('input', { class: 'form-control form-control-sm dp-search', type: 'search', id: 'dp-param-search', placeholder: '搜索全部参数（名称或 Tag-ID）', 'aria-label': '搜索参数', value: c.L.ui.query || '' })
		search.addEventListener('input', function () {
			c.L.ui.query = search.value
			renderParamRows(ctx(), rows)
		})
		const draftSet = new Set(draftKeys(c))
		const rail = h('nav', { class: 'dp-rail', 'aria-label': '参数 Tag 分类' }, cats.map(function (x) {
			const dirtyCount = x.keys.reduce(function (acc, k) { return acc + (draftSet.has(k) ? 1 : 0) }, 0)
			const dirtyBadge = h('span', { class: 'dp-rail-dirty', title: '待写入改动数', text: dirtyCount ? String(dirtyCount) : '' })
			dirtyBadge.hidden = !dirtyCount
			return h('button', {
				type: 'button',
				'data-cat': x.id,
				'aria-current': x.id === (cat && cat.id) && !(c.L.ui.query || '').trim() ? 'true' : 'false',
				onclick: function () {
					c.L.ui.cat = x.id
					c.L.ui.query = ''
					c.L.ui.sel = null
					render()
					autoReadCategory()
				},
			},
			h('span', { class: 'dp-rail-name', text: x.title }),
			h('span', { class: 'dp-rail-badges' }, dirtyBadge, h('span', { class: 'dp-rail-cnt', text: String(x.keys.length) })))
		}))
		renderParamRows(c, rows)
		const topbar = h('div', { class: 'dp-ptopbar' }, h('div', { class: 'dp-ptools' }, search), actions)
		return h('div', { class: 'dp-params-wrap' }, topbar, h('div', { class: 'dp-params' }, rail, h('div', { class: 'dp-ptable' }, rows)))
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
		if (f.secret || rec.secret) {
			box.append(h('p', { class: 'dp-fine', text: '来源帧含保密字段，不展示可复制的帧数据' }))
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
		const editor = document.activeElement && document.activeElement.id.startsWith('dp-set-') ? document.activeElement : null
		// 读取限制说明是可聚焦的：重绘（每秒的任务到期、新读数）后把焦点还给它，读屏 / 键盘用户才不会丢位置
		const focusLimit = document.activeElement && document.activeElement.id === 'dp-read-limit'
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
					writing && L.flow === writing ? '取消写入' : '取消读取', h('small', { text: '没发出的请求不再发送' }))))
		const head = h('div', { class: 'dp-head' },
			h('div', { class: 'dp-who' },
				h('b', {}, laneChip(c.sid), h('span', { text: title }), nameVal && h('span', { class: 'dp-name', text: nameVal })),
				h('span', { class: 'dp-readat', text: readText }),
				// 读取的归属限制如实写出来：宿主只能保证认领的是「查询发出后才开始」的匹配帧，迟到应答分不出来
				// 常显一行短提示，全文在 title / aria-label；点按（窄屏、触屏没有悬停）展开或收起全文，状态只认 aria-expanded
				(c.dev.queryable || c.dev.buildWrite) && h('button', {
					type: 'button',
					class: 'dp-limit',
					id: 'dp-read-limit',
					title: READ_LIMIT_FULL,
					'aria-label': READ_LIMIT_FULL,
					'aria-expanded': L.ui.limitOpen ? 'true' : 'false',
					onclick: function () { L.ui.limitOpen = !L.ui.limitOpen; render() },
				}, h('span', { class: 'dp-limit-i', 'aria-hidden': 'true', text: 'ⓘ' }), h('span', { class: 'dp-limit-t', text: L.ui.limitOpen ? READ_LIMIT_FULL : READ_LIMIT_SHORT }))),
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
		syncDraftToolbar(c)
		body.scrollTop = scroll
		if (editor) {
			const next = document.getElementById(editor.id)
			if (next && !next.disabled) {
				next.focus({ preventScroll: true })
				if (editor.selectionStart != null) next.setSelectionRange(editor.selectionStart, editor.selectionEnd)
			}
		}
		if (focusLimit) {
			const lb = document.getElementById('dp-read-limit')
			if (lb) lb.focus()
		}
		if (focusSearch) {
			const s = document.getElementById('dp-param-search')
			if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length) }
		}
	}

	// 每秒：估算的设备时间、「x 秒前」、到期的任务提示
	function tick() {
		if (document.hidden) return
		sync()
		if (view === 'comm') return
		updateStripSummary()
		if (!root || view !== 'device') return
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
		if (strip.sumTimer || view === 'comm') return
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
		if (panes) panes.inert = strip.st.collapsed && view !== 'comm'
		// 收起期间终端不 fit（否则被压成 1 行、裁掉历史），展开或离开子视图时恢复并补 fit
		const T = window.SerialTerm
		if (T && typeof T.setFitSuspended === 'function') T.setFitSuspended(strip.st.collapsed && view !== 'comm')
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
				if (view === 'comm' || roTimer) return
				roTimer = setTimeout(function () { roTimer = 0; if (view !== 'comm' && !strip.drag) applyStrip() }, 50)
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
		const allowDevice = !P || typeof P.has !== 'function' || P.has('view.device')
		const allowFwPack = !P || typeof P.has !== 'function' || P.has('view.firmware-pack')
		const allowFw = !P || typeof P.has !== 'function' || P.has('panel.firmware') || allowFwPack
		if (!allowDevice && !allowFw) return
		const vs = document.getElementById('view-serial')
		const main = document.getElementById('main')
		if (!vs || !main || main.parentNode !== vs) return
		mounted = true
		viewbar = h('div', { class: 'dp-viewbar', id: 'dp-viewbar' },
			h('div', { class: 'ctl-seg', role: 'group', 'aria-label': '通信调试视图' },
				h('button', { type: 'button', id: 'dp-view-comm', 'aria-pressed': 'true', text: '通信调试', onclick: function () { setView('comm') } }),
				allowDevice && h('button', { type: 'button', id: 'dp-view-device', 'aria-pressed': 'false', text: '设备面板', onclick: function () { setView('device') } }),
				allowFw && h('button', { type: 'button', id: 'dp-view-firmware', 'aria-pressed': 'false', 'data-feature': 'panel.firmware', title: allowFwPack ? '固件打包与升级' : '固件升级', text: allowFwPack ? '固件' : '固件升级', onclick: function () { setView('firmware') } })),
			h('span', { class: 'dp-why' }))
		root = h('section', { class: 'dp', id: 'device-panel', 'aria-label': '设备面板' })
		root.hidden = true
		vs.insertBefore(viewbar, main)
		vs.insertBefore(root, main.nextSibling)
		if (allowFw) {
			fwRoot = document.getElementById('firmware-panel')
			if (!fwRoot) {
				fwRoot = h('section', { class: 'dp dp-fw', id: 'firmware-panel', 'aria-label': '固件升级' })
				fwRoot.hidden = true
				vs.insertBefore(fwRoot, root.nextSibling)
			} else if (fwRoot.parentNode !== vs) {
				vs.insertBefore(fwRoot, root.nextSibling)
			}
		}
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
		setView(saved === 'device' ? 'device' : (saved === 'firmware' ? 'firmware' : 'comm'), true)
		lastSig = ''
		sync()
	}

	window.DevicePanel = {
		show: function () {
			const rail = document.querySelector('.rail-item[data-view="view-serial"]')
			if (rail && !rail.classList.contains('active')) rail.click()
			if (!setView('device')) toast(availability().why, 'warn')
		},
		showFirmware: function () {
			const rail = document.querySelector('.rail-item[data-view="view-serial"]')
			if (rail && !rail.classList.contains('active')) rail.click()
			return setView('firmware')
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
