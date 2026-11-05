// 页面侧 MCP 桥：把 Rust 投递过来的工具调用转成既有业务路径上的操作。
// 只有桌面客户端提供了平台服务(AppPlatform.service('mcp'))时才加载，网页版 / 移动端什么都不做。
// 关键约定：
// 1. 每个变更类调用先排进「该资源的串行队列」，在队列内部再 await commit(存活/未冻结/已登录)，之后才动设备；
//    提交点由 Rust 记下，超时后按「未执行 / 结果未知」如实回报。
// 2. 功耗仪的操作队列在 js/blu-power.js 里(与 UI 共用)，这里只把 commit 与取消检查作为 guard 传进去，
//    不另起一层队列，否则取消/超时后仍可能排在 UI 操作后面悄悄执行。
// 3. 串口读走 js/mcp-ring.js 的有界环，按「文档 + 路 + 连接代次 + 字节游标」取数，不读日志 DOM。
;(function (root) {
	'use strict'
	const P = root.AppPlatform
	if (!P || !P.service || (P.has && !P.has('service.mcp'))) return
	const svc = P.service('mcp')
	if (!svc) return
	const Ring = root.McpRing
	if (!Ring) return

	const doc = root.document
	const bridgeEpoch = makeEpoch()
	const active = new Map() // id -> { deadline, tool }
	const rings = {} // sid -> ring
	const subs = {} // sid -> unsubscribe
	const queues = new Map() // resource -> promise tail
	const queueDepth = new Map() // resource -> 排队中的操作数(含正在执行的那条)
	// 每路最多排 4 条：第一条卡住时后续超时请求会被拒绝，而不是无限堆积(Rust 的 pending 上限会随超时释放)
	const MAX_QUEUE_DEPTH = 4
	let enabled = false
	let lastMode = ''

	function noop() {}
	function makeEpoch() {
		const rnd = Math.random().toString(36).slice(2, 10)
		return 'b' + Date.now().toString(36) + rnd
	}
	function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
	function hub() { return root.SerialHub || null }
	function api() { return root.serialApi || null }
	function mode() { return hub() ? hub().mode : 'single' }
	function authed() { return !!(root.__auth && root.__auth.authed && root.__auth.authed()) }
	function visibleLanes() { return mode() === 'dual' ? ['A', 'B'] : ['S'] }
	function isVisibleLane(sid) { return visibleLanes().indexOf(sid) !== -1 }
	function blockers() {
		return root.Workbench && root.Workbench.updateBlockers ? root.Workbench.updateBlockers() : []
	}
	function fail(code, message, extra) {
		return { ok: false, result: Object.assign({ code: code, message: message }, extra || {}) }
	}
	function pass(value) { return { ok: true, result: value } }
	// 业务函数(bluApi / guard)返回 { ok, code, message, ... }：剥掉 ok 变成工具结果
	function fromApi(r) {
		if (!r || typeof r !== 'object') return fail('internal_error', '没有结果')
		const out = Object.assign({}, r)
		delete out.ok
		return { ok: !!r.ok, result: out }
	}
	function laneNs(lane) { return bridgeEpoch + '-' + lane }

	// ---------- 接收环 ----------
	function laneRing(sid) {
		if (!rings[sid]) rings[sid] = Ring.createRing()
		return rings[sid]
	}
	function ensureSub(sid) {
		if (subs[sid] || !api() || !api().onReceiveFrom) return
		subs[sid] = api().onReceiveFrom(sid, function (data) {
			// 登录态丢失 / 服务停了：立刻停止缓冲，别在后台留设备数据
			if (!authed() || !enabled) {
				dropAll()
				return
			}
			if (rings[sid]) rings[sid].push(data)
		})
	}
	function dropSub(sid) {
		if (subs[sid]) {
			try { subs[sid]() } catch (e) {}
			delete subs[sid]
		}
		// 代次 +1：旧游标作废，旧数据不留
		if (rings[sid]) rings[sid].reset()
	}
	function dropAll() {
		Object.keys(subs).forEach(dropSub)
		Object.keys(rings).forEach(function (sid) { rings[sid].reset() })
	}
	function syncSubs() {
		const want = enabled && authed() ? visibleLanes() : []
		Object.keys(subs).forEach(function (sid) { if (want.indexOf(sid) === -1) dropSub(sid) })
		want.forEach(function (sid) { laneRing(sid); ensureSub(sid) })
	}

	// ---------- 资源串行队列（串口操作） ----------
	function enqueue(key, fn) {
		const depth = queueDepth.get(key) || 0
		if (depth >= MAX_QUEUE_DEPTH) {
			return Promise.resolve(fail('lane_busy', '这一路的 MCP 操作排队过多，请等前一个操作结束'))
		}
		queueDepth.set(key, depth + 1)
		const prev = queues.get(key) || Promise.resolve()
		const run = prev.then(fn, fn)
		const tail = run.then(noop, noop)
		queues.set(key, tail)
		tail.then(function () {
			const left = (queueDepth.get(key) || 1) - 1
			if (left <= 0) queueDepth.delete(key)
			else queueDepth.set(key, left)
			if (queues.get(key) === tail) queues.delete(key)
		})
		return run
	}

	function live(id) {
		const rec = active.get(id)
		if (!rec) return false
		return Date.now() <= rec.deadline
	}

	// 提交守卫：返回 null 或业务形状的拒绝结果 { ok:false, code, message, executed? }
	function makeGuard(id) {
		function deny(code, message, executed) {
			return { ok: false, code: code, message: message, executed: executed == null ? false : executed }
		}
		return {
			start: async function () {
				if (!active.has(id)) return deny('aborted', '请求已取消，未执行')
				if (!live(id)) return deny('expired_before_commit', '请求已超时，未执行')
				if (!enabled) return deny('service_not_running', '本地 MCP 服务未运行，未执行')
				if (!authed()) return deny('window_locked', '窗口未登录，未执行')
				if (api() && api().updatePreparing) return deny('update_preparing', '正在准备应用更新，未执行')
				const c = await svc.commit({ id: id, bridgeEpoch: bridgeEpoch })
				if (!c || !c.ok) return deny((c && c.code) || 'aborted', '请求已取消或状态已变化，未执行')
				if (!active.has(id)) return deny('aborted', '请求已取消，未执行')
				if (!authed()) return deny('window_locked', '窗口未登录，未执行')
				if (api() && api().updatePreparing) return deny('update_preparing', '正在准备应用更新，未执行')
				return null
			},
			// 同步检查：每个 await 之后、下一段 I/O 之前
			step: function () {
				if (!active.has(id)) return deny('aborted', '请求已取消，后续步骤未执行', 'partial')
				if (!live(id)) return deny('expired_before_commit', '请求已超时，后续步骤未执行', 'partial')
				if (!enabled) return deny('service_not_running', '本地 MCP 服务已停止，后续步骤未执行', 'partial')
				if (!authed()) return deny('window_locked', '窗口未登录，后续步骤未执行', 'partial')
				if (api() && api().updatePreparing) return deny('update_preparing', '正在准备应用更新，后续步骤未执行', 'partial')
				return null
			},
		}
	}

	// 这一路的快照：模式 / 端口对象 / 连接代次。等待期间任何一项变了就不执行(不能让 A 路的请求落到 S 路)
	function laneSnapshot(lane) {
		const h = hub()
		const a = api()
		return {
			lane: lane,
			mode: h ? h.mode : '',
			port: h ? h.getPort(lane) : null,
			gen: a && a.sessionGeneration ? a.sessionGeneration(lane) : 0,
		}
	}
	function sameSnapshot(a, b) {
		return !!a && !!b && a.lane === b.lane && a.mode === b.mode && a.port === b.port && a.gen === b.gen
	}

	// 串口变更：队列内 commit → 复查这一路 → 执行；取消/超时停在下一步
	async function mutate(id, lane, run) {
		// 快照在排队之前取：排队期间换了端口/模式/连接也要算变化
		const before = laneSnapshot(lane)
		return enqueue('serial:' + lane, async function () {
			const guard = makeGuard(id)
			const denied = await guard.start()
			if (denied) return fromApi(denied)
			if (!sameSnapshot(before, laneSnapshot(lane))) {
				return fail('lane_changed', '等待期间这一路的串口或模式发生变化，未执行')
			}
			const step = guard.step()
			if (step) return fromApi(step)
			// 传给业务层的取消检查：除了请求是否还活着，也复查「还是原来那一路上、原来的设备/模式」。
			// 打开串口可能在等旧口释放/退避重试里耗很久，业务层会在这些等待之后回调它。
			const cancelCheck = function () {
				if (!sameSnapshot(before, laneSnapshot(lane))) {
					return { ok: false, code: 'lane_changed', message: '这一路的串口或模式在等待期间发生变化，已取消' }
				}
				return guard.step()
			}
			try {
				return await run(guard, cancelCheck)
			} catch (e) {
				return fail('internal_error', String((e && e.message) || e))
			}
		})
	}

	// ---------- 参数校验 ----------
	function laneOf(p) {
		const lane = String((p && p.lane) || '')
		if (!isVisibleLane(lane)) return { error: fail('lane_not_visible', '这一路当前不可用(单路是 S，双路是 A/B)') }
		return { lane: lane }
	}

	function deviceOf(lane) {
		const h = hub()
		const port = h ? h.getPort(lane) : null
		if (!port || !root.serialLanes || !root.serialLanes.portMeta) return null
		const meta = root.serialLanes.portMeta(port)
		return { portName: meta.portName, productName: meta.productName, alias: meta.alias, vid: meta.vid, pid: meta.pid }
	}

	// ---------- 工具实现 ----------
	async function serialState() {
		const h = hub()
		const a = api()
		if (!h) return fail('internal_error', '串口模块未就绪')
		const lanes = visibleLanes().map(function (sid) {
			const stats = h.getStats(sid)
			const protoId = root.serialLanes ? root.serialLanes.protocolOf(sid) : ''
			return {
				lane: sid,
				visible: h.isVisible(sid),
				open: h.isOpen(sid),
				opening: h.isOpening(sid),
				device: deviceOf(sid),
				protocol: { id: protoId, name: root.serialLanes ? root.serialLanes.protocolName(protoId) : '' },
				stats: { txBytes: stats.txBytes, rxBytes: stats.rxBytes, openedAt: stats.openedAt },
				receivePaused: !!stats.receivePaused,
			}
		})
		return pass({
			mode: h.mode,
			pinned: !!(a && a.isPinned && a.isPinned()),
			updatePreparing: !!(a && a.updatePreparing),
			blockers: blockers(),
			lanes: lanes,
		})
	}

	async function serialOpen(id, p) {
		const r = laneOf(p)
		if (r.error) return r.error
		return mutate(id, r.lane, async function (guard, cancelCheck) {
			const running = blockers()
			if (running.length) return fail('app_busy', '有后台任务正在运行：' + running.join('、'))
			// 打开可能在等旧口释放/退避重试里耗很久：把取消检查(含设备/模式快照)交给共享打开路径
			const res = await root.serialLanes.open(r.lane, cancelCheck)
			return res && res.ok
				? pass({ lane: r.lane, open: true, changed: !!res.changed, device: deviceOf(r.lane) })
				: fail((res && res.code) || 'open_failed', (res && res.message) || '打开串口失败')
		})
	}

	async function serialClose(id, p) {
		const r = laneOf(p)
		if (r.error) return r.error
		return mutate(id, r.lane, async function () {
			const res = await root.serialLanes.close(r.lane)
			return res && res.ok
				? pass({ lane: r.lane, open: false, changed: !!res.changed })
				: fail((res && res.code) || 'close_failed', (res && res.message) || '关闭串口失败')
		})
	}

	async function serialWrite(id, p) {
		const r = laneOf(p)
		if (r.error) return r.error
		const encoding = p.encoding == null ? 'hex' : String(p.encoding)
		if (encoding !== 'hex' && encoding !== 'text') return fail('invalid_encoding', 'encoding 必须是 hex 或 text')
		let bytes
		if (encoding === 'hex') {
			const parsed = Ring.parseHex(p.data)
			if (!parsed.ok) return fail('bad_hex', parsed.message)
			bytes = parsed.bytes
		} else {
			if (typeof p.data !== 'string' || !p.data.length) return fail('bad_params', 'data 不能为空')
			bytes = new TextEncoder().encode(p.data)
		}
		if (!bytes.length) return fail('bad_params', 'data 不能为空')
		if (bytes.length > Ring.MAX_WRITE_BYTES) return fail('payload_too_large', '单次写入最多 ' + Ring.MAX_WRITE_BYTES + ' 字节')
		const appendCrlf = !!p.appendCrlf
		if (appendCrlf) {
			const joined = new Uint8Array(bytes.length + 2)
			joined.set(bytes)
			joined[bytes.length] = 0x0d
			joined[bytes.length + 1] = 0x0a
			bytes = joined
		}
		return mutate(id, r.lane, async function () {
			const a = api()
			if (!a || !a.isSessionOpen || !a.isSessionOpen(r.lane)) return fail('serial_not_open', '串口未打开')
			if (a.isPinned && a.isPinned() && hub().activeSendPhys() === r.lane) {
				return fail('transaction_pinned', '协议事务进行中，暂不能从 MCP 发送')
			}
			try {
				await a.writeRawTo(r.lane, bytes, {})
			} catch (e) {
				return fail('write_failed', String((e && e.message) || e))
			}
			return pass({
				lane: r.lane,
				bytesWritten: bytes.length,
				txTotal: hub().getStats(r.lane).txBytes,
				crlfAppended: appendCrlf,
				note: '写入完成只表示本机写入成功，不代表设备已处理',
			})
		})
	}

	async function serialRead(id, p) {
		const r = laneOf(p)
		if (r.error) return r.error
		const maxBytes = Ring.readInt(p.maxBytes, 1, Ring.MAX_READ_BYTES, Ring.DEFAULT_READ_BYTES)
		if (maxBytes == null) return fail('bad_params', 'maxBytes 必须在 1..' + Ring.MAX_READ_BYTES + ' 之间')
		const timeoutMs = Ring.readInt(p.timeoutMs, 0, Ring.MAX_READ_TIMEOUT_MS, 0)
		if (timeoutMs == null) return fail('bad_params', 'timeoutMs 必须在 0..' + Ring.MAX_READ_TIMEOUT_MS + ' 之间')
		const ring = laneRing(r.lane)
		const ns = laneNs(r.lane)
		const generation = ring.generation
		let from = null
		if (p.cursor != null) {
			const parsed = Ring.parseCursor(p.cursor)
			if (!parsed || parsed.ns !== ns || parsed.generation !== generation) {
				const stats = ring.stats()
				return fail('invalid_cursor', '游标不属于这一路当前连接，请不带 cursor 重新读取', {
					generation: generation,
					cursor: Ring.encodeCursor(ns, generation, stats.oldestCursor),
				})
			}
			if (parsed.offset > ring.stats().total) {
				return fail('invalid_cursor', '游标超出已接收范围，请不带 cursor 重新读取', {
					generation: generation,
					cursor: Ring.encodeCursor(ns, generation, ring.stats().oldestCursor),
				})
			}
			from = parsed.offset
		}
		const until = Date.now() + timeoutMs
		for (;;) {
			if (!active.has(id)) return fail('aborted', '请求已取消')
			if (!live(id)) return fail('expired_before_commit', '请求已超时')
			if (!authed()) return fail('window_locked', '窗口未登录')
			// 等待期间重连 / 换模式 / 换设备：环已换代次，旧游标的数据不能当成这一路的新数据返回
			if (ring.generation !== generation) {
				const stats = ring.stats()
				return fail('invalid_cursor', '读取等待期间连接已变化，请不带 cursor 重新读取', {
					generation: ring.generation,
					cursor: Ring.encodeCursor(ns, ring.generation, stats.oldestCursor),
				})
			}
			const got = ring.read(from, maxBytes)
			const timedOut = !got.data.length && Date.now() >= until
			if (got.data.length || timedOut) {
				const stats = ring.stats()
				return pass({
					lane: r.lane,
					generation: ring.generation,
					cursor: Ring.encodeCursor(ns, ring.generation, got.cursor),
					nextCursor: Ring.encodeCursor(ns, ring.generation, got.nextCursor),
					dropped: got.dropped,
					encoding: 'hex',
					data: Ring.encodeHex(got.data),
					retainedBytes: stats.retained,
					totalReceived: stats.total,
					timedOut: timedOut,
				})
			}
			await sleep(100)
		}
	}

	function bluApiOrFail() {
		const b = root.bluApi
		if (!b || !b.powerState) return { error: fail('blu_unavailable', '功耗分析模块未加载') }
		return { api: b }
	}

	async function bluState() {
		const r = bluApiOrFail()
		if (r.error) return r.error
		const st = r.api.powerState()
		return pass({
			connected: st.connected,
			opening: st.opening,
			sampling: st.sampling,
			powered: st.powered,
			voltageMv: st.voltageMv,
			recordMode: st.recordMode,
			sampleRateHz: st.sampleRateHz,
			sampleCount: st.sampleCount,
		})
	}

	async function bluSummary() {
		const r = bluApiOrFail()
		if (r.error) return r.error
		return pass(r.api.captureSummary())
	}

	// 功耗仪变更：commit 由 blu-power.js 的共享队列在真正执行前回调(guard.start)，
	// 这里不另排一层队列，避免「先 commit 再排队」让超时的命令事后执行
	async function bluMutate(id, call) {
		const r = bluApiOrFail()
		if (r.error) return r.error
		const guard = makeGuard(id)
		const out = await call(r.api, guard)
		return fromApi(out)
	}

	async function bluSetPower(id, p) {
		if (typeof p.on !== 'boolean') return fail('bad_params', 'on 必须是布尔值')
		return bluMutate(id, function (b, guard) { return b.setPower(!!p.on, guard) })
	}

	async function bluSetVoltage(id, p) {
		const mv = Number(p.millivolts)
		if (!isFinite(mv) || Math.floor(mv) !== mv) return fail('bad_params', 'millivolts 必须是整数')
		return bluMutate(id, function (b, guard) { return b.setVoltage(mv, guard) })
	}

	async function bluStart(id) {
		return bluMutate(id, function (b, guard) { return b.startCapture(guard) })
	}

	async function bluStop(id) {
		return bluMutate(id, function (b, guard) { return b.stopCapture(guard) })
	}

	const HANDLERS = {
		serial_state: serialState,
		serial_open: serialOpen,
		serial_close: serialClose,
		serial_write: serialWrite,
		serial_read: serialRead,
		blu_state: bluState,
		blu_set_power: bluSetPower,
		blu_set_voltage: bluSetVoltage,
		blu_capture_start: bluStart,
		blu_capture_stop: bluStop,
		blu_capture_summary: bluSummary,
	}

	// ---------- 请求分发 ----------
	async function onRequest(msg) {
		if (!msg || typeof msg.id !== 'string' || typeof msg.tool !== 'string') return
		// 投给别的文档(刷新前)的事件：不处理，也不覆盖同 id 的活动请求
		if (msg.epoch != null && String(msg.epoch) !== bridgeEpoch) return
		if (active.has(msg.id)) return
		const id = msg.id
		const deadlineMs = Number(msg.deadlineMs)
		const ttl = isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 20000
		active.set(id, { deadline: Date.now() + ttl, tool: msg.tool })
		let out
		try {
			if (!enabled) out = fail('service_not_running', '本地 MCP 服务未运行')
			else if (!authed()) out = fail('window_locked', '窗口未登录，MCP 不代登录')
			else if (!HANDLERS[msg.tool]) out = fail('unknown_tool', '不支持的工具：' + msg.tool)
			else out = await HANDLERS[msg.tool](id, msg.params || {})
		} catch (e) {
			out = fail('internal_error', String((e && e.message) || e))
		}
		active.delete(id)
		try {
			await svc.reply({ id: id, bridgeEpoch: bridgeEpoch, ok: !!out.ok, result: out.result })
		} catch (e) {}
	}

	// ---------- 注册与状态同步 ----------
	function pushState() {
		if (mode() !== lastMode) {
			lastMode = mode()
			dropAll()
		}
		if (!authed()) {
			active.clear()
			dropAll()
		}
		syncSubs()
		try { svc.windowState({ bridgeEpoch: bridgeEpoch, authed: authed(), mode: mode() }).catch(noop) } catch (e) {}
	}

	async function register() {
		lastMode = mode()
		try {
			const status = await svc.register({
				bridgeEpoch: bridgeEpoch,
				authed: authed(),
				mode: mode(),
				appVersion: String(root.APP_VERSION || ''),
			})
			enabled = !!(status && status.running)
		} catch (e) {
			enabled = false
		}
		syncSubs()
	}

	// 先装好监听再登记：否则登记成功后第一批请求可能落在没人听的窗口里
	async function boot() {
		try {
			await svc.listen('mcp-request', onRequest)
			await svc.listen('mcp-cancel', function (msg) {
				if (msg && msg.id != null) active.delete(String(msg.id))
			})
			await svc.listen('mcp-service', function (status) {
				enabled = !!(status && status.running)
				if (!enabled) {
					active.clear()
					dropAll()
				} else {
					syncSubs()
				}
			})
		} catch (e) {}
		doc.addEventListener('serial-session', function (e) {
			const sid = e && e.detail && e.detail.sid
			if (!sid) return
			dropSub(sid)
			if (enabled && authed() && isVisibleLane(sid)) {
				laneRing(sid)
				ensureSub(sid)
			}
		})
		doc.addEventListener('serial-lane-config', pushState)
		root.addEventListener('pagehide', function () {
			active.clear()
			dropAll()
			try { svc.unregister(bridgeEpoch).catch(noop) } catch (e) {}
		})
		await register()
	}

	boot()
})(typeof window !== 'undefined' ? window : globalThis)
