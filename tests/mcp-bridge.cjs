// Run: node tests/mcp-bridge.cjs — synthetic data only, no serial port, no hardware.
// 覆盖 js/mcp-bridge.js：只有桌面服务存在才挂载、先装监听再登记、提交点(commit)在真正执行之前、
// 提交被拒/取消/端口变化时不执行、按路的串行队列、读游标的代次与命名空间、功耗仪 guard 由共享队列调用、
// 迟到/重复/错代次的事件被忽略。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ringSrc = fs.readFileSync(path.join(__dirname, '../js/mcp-ring.js'), 'utf8')
const bridgeSrc = fs.readFileSync(path.join(__dirname, '../js/mcp-bridge.js'), 'utf8')

const enc = (s) => new TextEncoder().encode(s)
const flush = async (n) => {
	for (let i = 0; i < (n || 6); i++) await new Promise((r) => setImmediate(r))
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function makeHarness(opts) {
	opts = opts || {}
	const order = []
	const docListeners = {}
	const winListeners = {}
	const svcListeners = {}
	const replies = []
	const commits = []
	const unregistered = []
	const writes = []
	const bluCalls = []
	const state = {
		authed: opts.authed !== false,
		running: opts.running !== false,
		preparing: false,
		mode: 'single',
		lanes: {},
		commitResult: opts.commitResult || { ok: true },
		commitHook: opts.commitHook || null,
		writeImpl: opts.writeImpl || null,
		openImpl: opts.openImpl || null,
	}

	function lane(sid) {
		if (!state.lanes[sid]) {
			state.lanes[sid] = { port: { id: sid }, open: false, gen: 1, sub: null, stats: { txBytes: 0, rxBytes: 0, openedAt: 1 } }
		}
		return state.lanes[sid]
	}

	const doc = {
		readyState: 'complete',
		addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f) },
	}
	const win = {
		document: doc,
		navigator: {},
		APP_VERSION: '9.9.9',
		addEventListener(t, f) { (winListeners[t] = winListeners[t] || []).push(f) },
		__auth: { authed: () => state.authed },
	}
	const serialApi = {
		updatePreparing: false,
		onReceiveFrom(sid, cb) {
			lane(sid).sub = cb
			return function () { lane(sid).sub = null }
		},
		sessionGeneration(sid) { return lane(sid).gen },
		isSessionOpen(sid) { return lane(sid).open },
		isPinned() { return false },
		writeRawTo(sid, bytes) {
			writes.push({ sid, bytes: Array.from(bytes) })
			if (state.writeImpl) return state.writeImpl(sid, bytes)
			lane(sid).stats.txBytes += bytes.length
			return Promise.resolve()
		},
	}
	const hub = {
		mode: 'single',
		activeSendPhys() { return 'S' },
		isVisible(sid) { return hub.mode === 'dual' ? sid !== 'S' : sid === 'S' },
		isOpen(sid) { return lane(sid).open },
		isOpening() { return false },
		getPort(sid) { return lane(sid).port },
		getStats(sid) { return lane(sid).stats },
	}
	const serialLanes = {
		open(sid, guard) {
			if (state.openImpl) return state.openImpl(sid, guard)
			// 与真实 openLane 一样：打开过程中会回调业务层传下来的取消检查
			const denied = typeof guard === 'function' ? guard() : null
			if (denied) return Promise.resolve({ ok: false, code: denied.code, message: denied.message })
			lane(sid).open = true
			return Promise.resolve({ ok: true, changed: true, open: true })
		},
		close(sid) {
			lane(sid).open = false
			return Promise.resolve({ ok: true, changed: true, open: false })
		},
		portMeta() { return { portName: 'COM7', productName: 'Widget', alias: null, vid: 0x1234, pid: 0x5678 } },
		protocolOf() { return 'sek' },
		protocolName() { return 'SEK' },
		toast() {},
	}
	const bluApi = {
		powerState() {
			return { connected: true, opening: false, sampling: false, powered: { state: 'off', source: 'commanded' }, voltageMv: 3300, recordMode: 'wave', sampleRateHz: 1000, sampleCount: 0 }
		},
		captureSummary() { return { ready: false, reason: 'no_samples' } },
		setPower(on, guard) {
			bluCalls.push('start:' + on)
			return Promise.resolve(guard.start()).then(function (denied) {
				if (denied) return denied
				bluCalls.push('work:' + on)
				return { ok: true, changed: true, powered: { state: on ? 'on' : 'off', source: 'commanded' } }
			})
		},
		setVoltage(mv, guard) {
			return Promise.resolve(guard.start()).then(function (denied) {
				if (denied) return denied
				bluCalls.push('volt:' + mv)
				return { ok: true, requestedMv: mv, appliedMv: mv, clamped: false }
			})
		},
		startCapture(guard) {
			return Promise.resolve(guard.start()).then(function (denied) {
				if (denied) return denied
				return { ok: true, changed: true, sampling: true }
			})
		},
		stopCapture() { return Promise.resolve({ ok: true, changed: false, sampling: false }) },
	}
	const svc = opts.service === null ? null : {
		status() { return Promise.resolve({ running: state.running, enabled: state.running, port: 38991, url: 'http://127.0.0.1:38991/mcp' }) },
		enable() { return Promise.resolve({}) },
		disable() { return Promise.resolve({}) },
		revealToken() { return Promise.resolve('t'.repeat(64)) },
		regenerateToken() { return Promise.resolve({}) },
		listen(name, cb) {
			order.push('listen:' + name)
			svcListeners[name] = cb
			return Promise.resolve()
		},
		register(info) {
			order.push('register')
			order.registration = info
			return Promise.resolve({ running: state.running })
		},
		windowState() { order.push('windowState'); return Promise.resolve() },
		unregister(epoch) { h.unregistered.push(epoch); return Promise.resolve() },
		commit(args) {
			commits.push(args)
			if (state.commitHook) state.commitHook(args)
			return Promise.resolve(state.commitResult)
		},
		reply(args) {
			replies.push(args)
			return Promise.resolve()
		},
	}
	const platform = {
		has: (id) => id !== 'service.mcp' || opts.service !== null,
		service: (name) => (name === 'mcp' ? svc : null),
	}
	win.AppPlatform = platform
	win.SerialHub = hub
	win.serialApi = serialApi
	win.serialLanes = serialLanes
	win.bluApi = bluApi
	win.Workbench = { updateBlockers: () => [] }

	const ctx = { window: win, console, setTimeout, clearTimeout, setInterval, clearInterval }
	vm.createContext(ctx)
	vm.runInContext(ringSrc, ctx)
	vm.runInContext(bridgeSrc, ctx)

	let seq = 0
	function nextId() { seq += 1; return 'req-' + seq }

	function dispatch(t, list, ev) {
		for (const f of (list[t] || []).slice()) f(ev)
	}

	const h = {
		win, state, order, replies, commits, writes, bluCalls, svcListeners, unregistered,
		lane,
		async boot() { await flush() },
		msg(tool, params, extra) {
			return Object.assign({ id: nextId(), tool, params: params || {}, deadlineMs: 5000 }, extra || {})
		},
		send(msg) {
			if (!svcListeners['mcp-request']) throw new Error('请求监听未注册')
			svcListeners['mcp-request'](msg)
			return msg.id
		},
		async call(tool, params, extra) {
			const msg = h.msg(tool, params, extra)
			h.send(msg)
			const until = Date.now() + 2000
			while (Date.now() < until) {
				const r = h.replyFor(msg.id)
				if (r) return r
				await wait(2)
			}
			throw new Error('没有回执：' + tool)
		},
		replyFor(id) { return replies.find((r) => r.id === id) || null },
		cancel(id) { if (svcListeners['mcp-cancel']) svcListeners['mcp-cancel']({ id }) },
		receive(sid, text) {
			const sub = lane(sid).sub
			assert.ok(sub, '没有订阅 ' + sid + ' 的接收')
			sub(enc(text))
		},
		session(sid) {
			lane(sid).gen += 1
			dispatch('serial-session', docListeners, { detail: { sid } })
		},
		setMode(m) {
			hub.mode = m
			dispatch('serial-lane-config', docListeners, {})
		},
		pagehide() { dispatch('pagehide', winListeners, {}) },
	}
	return h
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('没有桌面 MCP 服务时不注册监听、不登记', async () => {
	const h = makeHarness({ service: null })
	await h.boot()
	assert.equal(h.order.length, 0)
	assert.equal(h.svcListeners['mcp-request'], undefined)
})

test('先装请求/取消/服务监听，再登记；登记带 authed/mode/appVersion', async () => {
	const h = makeHarness()
	await h.boot()
	assert.deepEqual(h.order.slice(0, 3), ['listen:mcp-request', 'listen:mcp-cancel', 'listen:mcp-service'])
	assert.equal(h.order[3], 'register')
	assert.equal(h.order.registration.authed, true)
	assert.equal(h.order.registration.mode, 'single')
	assert.equal(h.order.registration.appVersion, '9.9.9')
	assert.ok(typeof h.order.registration.bridgeEpoch === 'string' && h.order.registration.bridgeEpoch.length > 4)
	assert.ok(h.order.registration.bridgeEpoch.length > 4)
})

test('serial_write：commit 在真正写入之前，成功后回报字节数', async () => {
	const h = makeHarness()
	await h.boot()
	h.lane('S').open = true
	const r = await h.call('serial_write', { window: 'main', lane: 'S', data: '00ff', encoding: 'hex' })
	assert.equal(h.commits.length, 1)
	assert.equal(h.writes.length, 1)
	assert.deepEqual(h.writes[0].bytes, [0, 255])
	assert.equal(r.ok, true)
	assert.equal(r.result.bytesWritten, 2)
	assert.equal(r.result.crlfAppended, false)
	assert.ok(r.result.note.indexOf('不代表设备') !== -1)
})

test('commit 被拒：直接回领域错误(带 code)，不写入', async () => {
	const h = makeHarness({ commitResult: { ok: false, code: 'update_preparing' } })
	await h.boot()
	h.lane('S').open = true
	const r = await h.call('serial_write', { window: 'main', lane: 'S', data: '00' })
	assert.equal(r.ok, false)
	assert.equal(r.result.code, 'update_preparing')
	assert.equal(h.writes.length, 0)
})

test('commit 期间被取消：不写入，回 aborted', async () => {
	let cancelledId = null
	const h = makeHarness({
		// commit 还没返回时取消(模拟超时/停用事件插在提交点中间)
		commitHook: (args) => {
			cancelledId = args.id
			h.svcListeners['mcp-cancel']({ id: args.id })
		},
	})
	await h.boot()
	h.lane('S').open = true
	const msg = h.msg('serial_write', { window: 'main', lane: 'S', data: '01' })
	h.send(msg)
	await wait(30)
	const r = h.replyFor(msg.id)
	assert.ok(r, '应当有回执')
	assert.equal(r.ok, false)
	assert.equal(r.result.code, 'aborted')
	assert.equal(h.writes.length, 0)
	assert.equal(cancelledId, msg.id)
})

test('未登录：window_locked，不提交也不写入', async () => {
	const h = makeHarness({ authed: false })
	await h.boot()
	h.lane('S').open = true
	const r = await h.call('serial_write', { window: 'main', lane: 'S', data: '00' })
	assert.equal(r.result.code, 'window_locked')
	assert.equal(h.commits.length, 0)
	assert.equal(h.writes.length, 0)
})

test('双路下 S 路不可见：lane_not_visible', async () => {
	const h = makeHarness()
	await h.boot()
	h.setMode('dual')
	const r = await h.call('serial_write', { window: 'main', lane: 'S', data: '00' })
	assert.equal(r.result.code, 'lane_not_visible')
	assert.equal(h.writes.length, 0)
})

test('等待期间换了设备对象：lane_changed，不写入', async () => {
	const h = makeHarness({
		commitHook: () => { h.lane('S').port = { id: 'other' } },
	})
	await h.boot()
	h.lane('S').open = true
	const r = await h.call('serial_write', { window: 'main', lane: 'S', data: '00' })
	assert.equal(r.result.code, 'lane_changed')
	assert.equal(h.writes.length, 0)
})

test('同一路串行：第二个写入等第一个完成，顺序不乱', async () => {
	const order = []
	const h = makeHarness({
		writeImpl: (sid, bytes) => wait(20).then(() => { order.push(bytes[0]) }),
	})
	await h.boot()
	h.lane('S').open = true
	const a = h.call('serial_write', { window: 'main', lane: 'S', data: 'aa' })
	const b = h.call('serial_write', { window: 'main', lane: 'S', data: 'bb' })
	const [ra, rb] = await Promise.all([a, b])
	assert.equal(ra.ok, true)
	assert.equal(rb.ok, true)
	assert.deepEqual(order, [0xaa, 0xbb])
})

test('读游标：按字节推进，重连后旧游标 invalid_cursor', async () => {
	const h = makeHarness()
	await h.boot()
	h.receive('S', 'hello')
	const first = await h.call('serial_read', { window: 'main', lane: 'S', maxBytes: 3 })
	assert.equal(first.result.data, '68656c')
	const second = await h.call('serial_read', { window: 'main', lane: 'S', cursor: first.result.nextCursor })
	assert.equal(second.result.data, '6c6f')
	assert.equal(second.result.dropped, 0)
	// 重连：代次变化，旧游标一律拒绝
	h.session('S')
	const stale = await h.call('serial_read', { window: 'main', lane: 'S', cursor: second.result.nextCursor })
	assert.equal(stale.result.code, 'invalid_cursor')
	assert.equal(stale.result.generation, 2)
})

test('读等待期间重连：不把新连接的字节当成旧游标的数据', async () => {
	const h = makeHarness()
	await h.boot()
	const pending = h.call('serial_read', { window: 'main', lane: 'S', timeoutMs: 800 })
	await wait(120)
	h.session('S')
	h.receive('S', 'new')
	const r = await pending
	assert.equal(r.result.code, 'invalid_cursor', JSON.stringify(r.result))
	assert.equal(r.result.data, undefined)
})

test('别的路 / 别的文档的游标不被接受', async () => {
	const h = makeHarness()
	await h.boot()
	h.receive('S', 'abc')
	const s = await h.call('serial_read', { window: 'main', lane: 'S' })
	h.setMode('dual')
	h.receive('A', 'xyz')
	const other = await h.call('serial_read', { window: 'main', lane: 'A', cursor: s.result.nextCursor })
	assert.equal(other.result.code, 'invalid_cursor')
	// 编造的命名空间
	const forged = await h.call('serial_read', { window: 'main', lane: 'A', cursor: 'bogus:1:0' })
	assert.equal(forged.result.code, 'invalid_cursor')
})

test('功耗仪：commit 由共享业务队列在开工前调用；被拒则不执行', async () => {
	const h = makeHarness()
	await h.boot()
	const ok = await h.call('blu_set_power', { window: 'main', on: true })
	assert.equal(h.commits.length, 1)
	assert.deepEqual(h.bluCalls, ['start:true', 'work:true'])
	assert.equal(ok.ok, true)

	const denied = makeHarness({ commitResult: { ok: false, code: 'aborted' } })
	await denied.boot()
	const r = await denied.call('blu_set_power', { window: 'main', on: true })
	assert.equal(r.result.code, 'aborted')
	assert.deepEqual(denied.bluCalls, ['start:true'])
})

test('功耗仪不受串口队列阻塞（不是同一层队列）', async () => {
	const h = makeHarness({ writeImpl: () => new Promise(() => {}) })
	await h.boot()
	h.lane('S').open = true
	h.send(h.msg('serial_write', { window: 'main', lane: 'S', data: '00' }))
	await wait(10)
	const r = await h.call('blu_set_power', { window: 'main', on: false })
	assert.equal(r.ok, true)
})

test('串口状态：带模式、事务钉扎与后台任务信息，不返回窗口标题', async () => {
	const h = makeHarness()
	await h.boot()
	h.lane('S').open = true
	const r = await h.call('serial_state', { window: 'main' })
	assert.equal(r.result.mode, 'single')
	assert.equal(r.result.lanes.length, 1)
	assert.equal(r.result.lanes[0].lane, 'S')
	assert.equal(r.result.lanes[0].device.portName, 'COM7')
	assert.equal(r.result.lanes[0].protocol.id, 'sek')
	assert.equal(r.result.pinned, false)
	assert.equal(r.result.window, undefined)
})

test('错代次 / 重复 id 的请求被忽略', async () => {
	const h = makeHarness()
	await h.boot()
	const stale = h.msg('serial_state', {}, { epoch: 'other-document' })
	h.send(stale)
	await flush()
	assert.equal(h.replyFor(stale.id), null)

	const msg = h.msg('serial_state', {})
	h.send(msg)
	h.send(msg)
	await flush(10)
	const same = h.replies.filter((r) => r.id === msg.id)
	assert.equal(same.length, 1, '同一 id 只回执一次')
})

test('pagehide：注销桥并停止缓冲', async () => {
	const h = makeHarness()
	await h.boot()
	assert.ok(h.lane('S').sub, '登记后应当已订阅接收')
	h.pagehide()
	await flush(10)
	assert.equal(h.unregistered.length, 1, 'pagehide 应当注销桥')
	assert.equal(h.lane('S').sub, null, 'pagehide 后不再订阅接收')
})

test('排队等待期间换了设备对象：排队的那条不执行', async () => {
	let releaseFirst = null
	const h = makeHarness({ writeImpl: () => new Promise((r) => { releaseFirst = r }) })
	await h.boot()
	h.lane('S').open = true
	const first = h.msg('serial_write', { window: 'main', lane: 'S', data: 'aa' })
	const second = h.msg('serial_write', { window: 'main', lane: 'S', data: 'bb' })
	h.send(first)
	h.send(second)
	await wait(10)
	// 第一条还在写的时候换了端口对象：第二条的快照(排队前取)已经对不上
	h.lane('S').port = { id: 'swapped' }
	releaseFirst()
	await wait(40)
	const r = h.replyFor(second.id)
	assert.ok(r, '第二条应当有回执')
	assert.equal(r.result.code, 'lane_changed')
	assert.equal(h.writes.length, 1, '只有第一条真正写入')
})

test('功耗仪：存储初始化等 await 期间取消，不再开始采样', async () => {
	let releaseStorage = null
	const calls = []
	const h = makeHarness()
	await h.boot()
	// 模拟 blu-power.startSampling：commit 之后还有一段 await(Store.init)，之后必须复查 guard
	h.win.bluApi.startCapture = function (guard) {
		return Promise.resolve(guard.start()).then(function (denied) {
			if (denied) return denied
			calls.push('storage')
			return new Promise(function (r) { releaseStorage = r }).then(function () {
				const step = guard.step()
				if (step) return step
				calls.push('start')
				return { ok: true, changed: true, sampling: true }
			})
		})
	}
	const msg = h.msg('blu_capture_start', { window: 'main' })
	h.send(msg)
	await wait(20)
	assert.deepEqual(calls, ['storage'])
	h.cancel(msg.id)
	releaseStorage()
	await wait(30)
	const r = h.replyFor(msg.id)
	assert.ok(r, '应当有回执')
	assert.equal(r.result.code, 'aborted')
	assert.deepEqual(calls, ['storage'], '取消后不再进入 START')
})

test('排队上限：第一条卡住时后来的请求立刻 busy，不无限堆积', async () => {
	const h = makeHarness({ writeImpl: () => new Promise(() => {}) })
	await h.boot()
	h.lane('S').open = true
	const first = h.msg('serial_write', { window: 'main', lane: 'S', data: '01' })
	h.send(first)
	await wait(5)
	// 上限 4(含正在执行的第一条)：再排 3 条成功，第 4 条起直接 busy
	const accepted = []
	for (let i = 0; i < 3; i++) {
		const m = h.msg('serial_write', { window: 'main', lane: 'S', data: '0' + (i + 2) })
		h.send(m)
		accepted.push(m)
	}
	const extra = []
	for (let i = 0; i < 3; i++) {
		const m = h.msg('serial_write', { window: 'main', lane: 'S', data: 'ff' })
		h.send(m)
		extra.push(m)
	}
	await wait(30)
	for (const m of extra) {
		const r = h.replyFor(m.id)
		assert.ok(r, '超出上限的请求应当立刻回执')
		assert.equal(r.ok, false)
		assert.equal(r.result.code, 'lane_busy')
	}
	for (const m of accepted) assert.equal(h.replyFor(m.id), null, '排队中的请求还没回执')
	// 另一路不受影响(队列按资源隔离)
	h.setMode('dual')
	const other = await h.call('serial_write', { window: 'main', lane: 'A', data: '00' })
	assert.equal(other.result.code, 'serial_not_open')
})

test('serial_open：打开过程中被取消 → aborted，不留下已连接状态', async () => {
	const h = makeHarness()
	await h.boot()
	h.lane('S').open = false
	h.win.serialLanes.open = function (sid, guard) {
		return new Promise(function (resolve) {
			setTimeout(function () {
				const denied = typeof guard === 'function' ? guard() : null
				if (denied) return resolve({ ok: false, code: denied.code, message: denied.message })
				h.lane(sid).open = true
				resolve({ ok: true, changed: true, open: true })
			}, 15)
		})
	}
	const msg = h.msg('serial_open', { window: 'main', lane: 'S' })
	h.send(msg)
	await wait(5)
	h.cancel(msg.id)
	await wait(40)
	const r = h.replyFor(msg.id)
	assert.ok(r, '应当有回执')
	assert.equal(r.result.code, 'aborted')
	assert.equal(h.lane('S').open, false, '取消后不能报已连接')
})

test('serial_open：打开过程中换了设备对象 → lane_changed', async () => {
	const h = makeHarness()
	await h.boot()
	h.lane('S').open = false
	h.win.serialLanes.open = function (sid, guard) {
		h.lane(sid).port = { id: 'swapped-during-open' }
		const denied = typeof guard === 'function' ? guard() : null
		if (denied) return Promise.resolve({ ok: false, code: denied.code, message: denied.message })
		h.lane(sid).open = true
		return Promise.resolve({ ok: true, changed: true, open: true })
	}
	const r = await h.call('serial_open', { window: 'main', lane: 'S' })
	assert.equal(r.result.code, 'lane_changed')
	assert.equal(h.lane('S').open, false)
})

;(async () => {
	let failed = 0
	for (const t of tests) {
		try {
			await t.fn()
			console.log('ok   ' + t.name)
		} catch (e) {
			failed++
			console.error('FAIL ' + t.name)
			console.error(e)
		}
	}
	if (failed) {
		console.error(failed + ' failed')
		process.exit(1)
	}
	console.log('all ' + tests.length + ' passed')
})()
