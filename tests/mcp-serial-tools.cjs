// Run: node tests/mcp-serial-tools.cjs — synthetic data only, no serial port, no hardware.
// 覆盖 MCP 新工具 serial_ports_list / serial_select / serial_configure 的端到端路径：
// 执行真实 js/mcp-bridge.js 与 js/common.js 的共享片段(按锚点截取)——
// SerialHub、findPortConflict/portConflictMsg、参数读写(laneParams/configureLane)、reopenWithNewParams、
// selectPortFor/bindSessionPort/bindClaimedPort、openSerial、laneBlockReason/openLane/closeLane/handleToggleClick、
// lanePortOwner/laneSelectBlock/selectLanePort、portListMeta、window.serialLanes。
// mock 只在设备/传输边界：端口对象、SerialAdapter、closeSerial/releasePort 时序、serialApi I/O、localStorage、DOM。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const commonSrc = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
const dualSrc = fs.readFileSync(path.join(__dirname, '../js/dual-config.js'), 'utf8')
const ringSrc = fs.readFileSync(path.join(__dirname, '../js/mcp-ring.js'), 'utf8')
const bridgeSrc = fs.readFileSync(path.join(__dirname, '../js/mcp-bridge.js'), 'utf8')

function slice(startMark, endMark) {
	const start = commonSrc.indexOf(startMark)
	const end = commonSrc.indexOf(endMark, start)
	assert.ok(start > 0 && end > start, 'common.js 锚点不见了: ' + startMark.trim())
	return commonSrc.slice(start, end)
}
function sliceFn(startMark) {
	const start = commonSrc.indexOf(startMark)
	const end = commonSrc.indexOf('\n\t}\n', start)
	assert.ok(start > 0 && end > start, 'common.js 函数锚点不见了: ' + startMark.trim())
	return commonSrc.slice(start, end + 4)
}
const hubStart = commonSrc.indexOf('\tfunction makeSerialSession(')
const hubEnd = commonSrc.indexOf('\n\t}\n', commonSrc.indexOf('\tconst SerialHub = {'))
assert.ok(hubStart > 0 && hubEnd > hubStart, 'SerialHub 段锚点不见了')
const hubSrc = commonSrc.slice(hubStart, hubEnd + 4)
const conflictSrc = slice('\tfunction findPortConflict(', '\tfunction portHeldByOther(')
const paramsSrc = slice("\tconst SERIAL_OPTIONS_KEY = 'serialOptions'", "\tconst SERIAL_WANT_OPEN_KEY = 'serialWantOpen'")
const reopenSrc = sliceFn('\tasync function reopenWithNewParams(sid, opts) {')
const bindSrc = slice('\t// opts.openAfterSelect: 无口时点', '\t//屏幕唤醒锁')
const openSerialSrc = sliceFn('\tasync function openSerial(sid, opts) {')
const laneOpsSrc = slice('\tfunction laneBlockReason(sid, port) {', '\tserialToggle.addEventListener')
const laneSrc = slice('\t// ===== 现代布局连接栏的串口列表', '\t// 列表行要显示的东西')
const metaSrc = sliceFn('\tfunction portListMeta(port) {')
const lanesApiStart = commonSrc.indexOf('\twindow.serialLanes = {')
const lanesApiEnd = commonSrc.indexOf('\n\t}', lanesApiStart)
assert.ok(lanesApiStart > 0 && lanesApiEnd > lanesApiStart, 'window.serialLanes 段锚点不见了')
const lanesApiSrc = commonSrc.slice(lanesApiStart, lanesApiEnd + 3)

const enc = (s) => new TextEncoder().encode(s)
const flush = async (n) => { for (let i = 0; i < (n || 6); i++) await new Promise((r) => setImmediate(r)) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
function deferred() { let resolve; const p = new Promise((r) => { resolve = r }); return { p, resolve } }

// ---------- 设备边界 mock：端口对象 ----------
let portSeq = 0
function makePort(meta) {
	meta = meta || {}
	const port = {
		_portSeq: ++portSeq,
		meta: meta,
		openCalls: [],
		openGate: null,
		openError: null,
		open(opts) {
			port.openCalls.push(opts)
			const step = function () {
				if (port.openError) throw port.openError
			}
			return (port.openGate ? port.openGate.p : Promise.resolve()).then(step)
		},
		close() { return Promise.resolve() },
		getInfo() {
			return {
				path: meta.path || ('/dev/cu.usb-' + port._portSeq),
				serialNumber: meta.sn,
				usbVendorId: meta.vid != null ? meta.vid : 0x10c4,
				usbProductId: meta.pid != null ? meta.pid : 0xea60,
				productName: meta.productName,
			}
		},
	}
	return port
}

function harness(opts) {
	opts = opts || {}
	const order = []
	const docListeners = {}
	const winListeners = {}
	const svcListeners = {}
	const replies = []
	const commits = []
	const unregistered = []
	const writes = []
	const msgs = []
	const granted = []
	const state = {
		authed: true,
		running: true,
		updatePreparing: false,
		pinned: false,
		gen: { S: 0, A: 0, B: 0 },
		ports: opts.ports || [],
		closeGates: {},
		releaseGates: {},
		commitResult: opts.commitResult || { ok: true },
		commitHook: opts.commitHook || null,
	}
	// 身份元数据(端口边界：身份解析本身由 port-alias/serial-hotplug 测试覆盖，这里按口给定)
	function identityOf(port) {
		const m = port.meta || {}
		const keys = []
		if (m.sn) keys.push('sn:' + m.sn)
		if (m.path) keys.push('path:' + m.path)
		return {
			keys: keys,
			fingerprint: {
				sn: m.sn || null,
				path: m.path || null,
				vid: m.vid != null ? m.vid : 0x10c4,
				pid: m.pid != null ? m.pid : 0xea60,
				productName: m.productName || null,
				slot: m.slot != null ? m.slot : null,
				siblingCount: m.siblingCount || 1,
			},
		}
	}
	const elements = {}
	function el(id) {
		if (!elements[id]) elements[id] = { value: '', addEventListener() {}, dispatchEvent() {} }
		return elements[id]
	}
	function CustomEvent(type, init) {
		this.type = type
		if (init) Object.assign(this, init)
	}
	const doc = {
		readyState: 'complete',
		addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f) },
		dispatchEvent(ev) {
			for (const f of (docListeners[ev.type] || []).slice()) f(ev)
			return true
		},
		getElementById(id) { return elements[id] || null },
		querySelectorAll() { return [] },
	}
	const win = {
		document: doc,
		navigator: {},
		APP_VERSION: '9.9.9',
		addEventListener(t, f) { (winListeners[t] = winListeners[t] || []).push(f) },
		__auth: { authed: () => state.authed },
		Workbench: { refreshStatus() {}, updateBlockers: () => [] },
	}
	const serialApi = {
		updatePreparing: false,
		onReceiveFrom(sid, cb) {
			subs['rx:' + sid] = cb
			return function () { delete subs['rx:' + sid] }
		},
		sessionGeneration(sid) { return state.gen[sid] || 0 },
		isSessionOpen(sid) { return ctx.__T.SerialHub.isOpen(sid) },
		isPinned() { return state.pinned },
		writeRawTo(sid, bytes) {
			writes.push({ sid, bytes: Array.from(bytes) })
			ctx.__T.SerialHub._sess(sid).txBytes += bytes.length
			return Promise.resolve()
		},
	}
	const subs = {}
	const localStore = new Map()
	const localStorage = {
		getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
		setItem: (k, v) => localStore.set(k, String(v)),
		removeItem: (k) => localStore.delete(k),
	}

	const ctx = {
		window: win,
		document: doc,
		console, setTimeout, clearTimeout, setInterval, clearInterval,
		CustomEvent, TextEncoder, TextDecoder,
		localStorage,
		sessionStorage: localStorage,
		pinSid: null,
		laneMoving: false,
		readGenBySid: { S: 0, A: 0, B: 0 },
		reopenAttemptBySid: { S: 0, A: 0, B: 0 },
		sessionResetSeq: { S: 0, A: 0, B: 0 },
		_portIdentityCache: new WeakMap(),
		_sessionAliasByPort: new Map(),
		OPEN_RETRY_ERRORS: ['NotFoundError', 'NetworkError', 'InvalidStateError'],
		OPEN_RETRY_DELAYS: [5],
		SERIAL_OPEN_FAIL_MSG: '打开串口失败',
		platformHas: () => true,
		platformHasSid: () => true,
		showToast(m) { msgs.push(m) },
		showMsg(m) { msgs.push(m) },
		addLogErr(m) { msgs.push(m) },
		addLogErrSafe(m) { msgs.push(m) },
		isBluetoothSerialPort: (p) => !!(p && p.meta && p.meta.bluetooth),
		isBluAnalyzerPort: (p) => !!(p && p.meta && p.meta.blu),
		isExcludedSerialPort: () => false,
		strongIdentity: () => ({ conflict: false, snMatch: false }),
		keyPaths: () => [],
		anyShared: () => false,
		rxWatch: () => ({ lastRxAt: 0, backoff: 0, openedAt: 0 }),
		get: (id) => el(id).value,
		set: (id, v) => { el(id).value = v },
		getPortIdentityKey: (port) => {
			const ident = identityOf(port)
			ctx._portIdentityCache.set(port, ident)
			return Promise.resolve(ident)
		},
		syncPortIdentity: (port) => identityOf(port),
		getPortAlias: (port) => (port.meta && port.meta.alias) || null,
		defaultPortDisplayName: () => 'USB 串口',
		setPortAlias: () => Promise.resolve(true),
		refreshPortDisplayNames() {},
		updateOpenButton() {},
		updatePortButtonDisplay() {},
		releaseWakeLock() {},
		requestWakeLock() {},
		setSerialWantOpen() {},
		setSerialWantPortKey() {},
		resetLaneParseSession() {},
		refreshActiveSendSButton() {},
		readData: () => new Promise(() => {}),
		recoverDeadReadLoop: () => Promise.resolve(),
		forgetPort: () => Promise.resolve(),
		singlePresetTarget: () => 'S',
		laneSnapshot: () => null,
		addLaneB() {},
		removeLaneB() {},
		protocolIdForSid: () => 'sek',
		protocolName: () => 'SEK',
		setLaneProtocol() {},
		dualSnapshot: () => ({}),
		applySerialPreset: () => Promise.resolve({ ok: true }),
		SerialAdapter: {
			isSupported: () => true,
			canEnumerate: () => true,
			listPorts: () => Promise.resolve(state.ports.slice()),
			getPorts: () => Promise.resolve(granted.slice()),
			grantPort: (p) => { if (granted.indexOf(p) === -1) granted.push(p) },
			requestPort: () => Promise.reject(Object.assign(new Error('none'), { name: 'NotFoundError' })),
			addEventListener() {},
		},
		serialStatuChange(statu, sid) {
			if (statu === 'connecting') return
			state.gen[sid] = (state.gen[sid] || 0) + 1
			doc.dispatchEvent(new CustomEvent('serial-session', { detail: { sid: sid, state: statu, generation: state.gen[sid] } }))
		},
		releasePort(sid) {
			const gate = state.releaseGates[sid]
			return gate ? gate.p.then(() => true) : Promise.resolve(true)
		},
		closeSerial(sid) {
			const gate = state.closeGates[sid]
			const done = function (ok) {
				if (ok === false) { ctx.__T.SerialHub._sess(sid).releaseFailed = true; return false }
				ctx.__T.SerialHub.setOpen(sid, false)
				ctx.__T.SerialHub.setManualClose(sid, true)
				ctx.serialStatuChange(false, sid)
				return true
			}
			return gate ? gate.p.then(done) : Promise.resolve(done())
		},
	}
	win.serialApi = serialApi
	win.bluApi = { ownsPort: () => false }
	win.AppPlatform = {
		has: (id) => true,
		service: (name) => (name === 'mcp' ? svc : null),
	}
	const svc = {
		status: () => Promise.resolve({ running: state.running, enabled: state.running, port: 38991 }),
		enable: () => Promise.resolve({}),
		disable: () => Promise.resolve({}),
		revealToken: () => Promise.resolve('t'.repeat(64)),
		regenerateToken: () => Promise.resolve({}),
		listen(name, cb) { order.push('listen:' + name); svcListeners[name] = cb; return Promise.resolve() },
		register(info) { order.push('register'); order.registration = info; return Promise.resolve({ running: state.running }) },
		windowState: () => Promise.resolve(),
		unregister(epoch) { unregistered.push(epoch); return Promise.resolve() },
		commit(args) {
			commits.push(args)
			if (state.commitHook) state.commitHook(args)
			return Promise.resolve(state.commitResult)
		},
		reply(args) { replies.push(args); return Promise.resolve() },
	}

	vm.createContext(ctx)
	vm.runInContext(dualSrc, ctx)
	const script = [hubSrc, conflictSrc, paramsSrc, reopenSrc, bindSrc, openSerialSrc, laneOpsSrc, laneSrc, metaSrc, lanesApiSrc].join('\n') +
		'\nthis.__T = { SerialHub: SerialHub, selectLanePort: selectLanePort, bindSessionPort: bindSessionPort, configureLane: configureLane, laneParams: laneParams, reopenWithNewParams: reopenWithNewParams, openSerial: openSerial, openLane: openLane, closeLane: closeLane, lanePortOwner: lanePortOwner, laneSelectBlock: laneSelectBlock, portListMeta: portListMeta, selectPortFor: selectPortFor, _portClaims: _portClaims }' +
		'\nwindow.SerialHub = SerialHub' // 与 common.js 的导出一致(桥接读 root.SerialHub)
	vm.runInContext(script, ctx)
	vm.runInContext(ringSrc, ctx)
	vm.runInContext(bridgeSrc, ctx)

	let seq = 0
	const h = {
		ctx, win, state, order, replies, commits, writes, msgs, granted, svcListeners, unregistered, elements, localStore,
		T: ctx.__T,
		hub: ctx.__T.SerialHub,
		async boot() { await flush() },
		msg(tool, params, extra) {
			seq += 1
			return Object.assign({ id: 'req-' + seq, tool, params: params || {}, deadlineMs: 5000 }, extra || {})
		},
		send(msg) { svcListeners['mcp-request'](msg); return msg.id },
		async call(tool, params, extra) {
			const msg = h.msg(tool, params, extra)
			h.send(msg)
			const until = Date.now() + 3000
			while (Date.now() < until) {
				const r = h.replyFor(msg.id)
				if (r) return r
				await wait(2)
			}
			throw new Error('没有回执：' + tool + ' ' + JSON.stringify(replies))
		},
		replyFor(id) { return replies.find((r) => r.id === id) || null },
		cancel(id) { if (svcListeners['mcp-cancel']) svcListeners['mcp-cancel']({ id }) },
		serviceOff() { if (svcListeners['mcp-service']) svcListeners['mcp-service']({ running: false }) },
		receive(sid, bytes) {
			const sub = subs['rx:' + sid]
			assert.ok(sub, '没有订阅 ' + sid)
			sub(bytes instanceof Uint8Array ? bytes : enc(bytes))
		},
		setMode(m) {
			h.hub.mode = m
			doc.dispatchEvent(new CustomEvent('serial-lane-config'))
		},
		gateClose(sid) { state.closeGates[sid] = deferred(); return state.closeGates[sid] },
		gateRelease(sid) { state.releaseGates[sid] = deferred(); return state.releaseGates[sid] },
	}
	return h
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('wireless lane parameters are inapplicable; MCP cannot reconnect it with a fake baud rate', async () => {
	const p = makePort(); const info = p.getInfo(); p.getInfo = () => Object.assign({}, info, { transport: 'ble' })
	const h = harness({ ports: [p] }); await h.boot(); h.hub.setPort('S', p)
	const read = await h.call('serial_configure', { lane: 'S' })
	assert.equal(read.ok, true); assert.equal(read.result.options, null); assert.equal(read.result.transport, 'ble')
	const change = await h.call('serial_configure', { lane: 'S', options: { baudRate: 9600 } })
	assert.equal(change.ok, false); assert.equal(change.result.code, 'unsupported_transport'); assert.equal(p.openCalls.length, 0)
})

test('serial_ports_list：枚举不授权，deviceId 不透明、selectedBy 反映占用', async () => {
	const p1 = makePort({ sn: 'SN-1', productName: 'WidgetA' })
	const p2 = makePort({ sn: 'SN-2' })
	const h = harness({ ports: [p1, p2] })
	await h.boot()
	h.hub.setPort('S', p1)
	const r = await h.call('serial_ports_list', {})
	assert.equal(r.ok, true)
	assert.equal(r.result.canEnumerate, true)
	assert.equal(r.result.count, 2)
	assert.ok(h.granted.length === 0, '枚举不能授权')
	for (const it of r.result.ports) {
		assert.ok(/^b.+-d\d+$/.test(it.deviceId), 'deviceId 应是文档内不透明 id: ' + it.deviceId)
	}
	assert.deepEqual(Array.from(r.result.ports[0].selectedBy), ['S']) // 结果在 vm 域里生成，先取回本域再比
	assert.equal(r.result.ports[0].sn, 'SN-1')
	assert.equal(r.result.ports[0].productName, 'WidgetA')
})

test('端到端：枚举→deviceId 选口→参数读写→开→读写→关', async () => {
	const p1 = makePort({ sn: 'SN-1', productName: 'WidgetA', path: '/dev/cu.w1' })
	const h = harness({ ports: [p1] })
	await h.boot()
	const list = await h.call('serial_ports_list', {})
	const deviceId = list.result.ports[0].deviceId

	const sel = await h.call('serial_select', { lane: 'S', deviceId })
	assert.equal(sel.ok, true, JSON.stringify(sel.result))
	assert.equal(sel.result.selected, true)
	assert.equal(h.granted.length, 1, '选口才授权')
	assert.equal(h.hub.getPort('S'), p1)
	assert.equal(h.hub.isOpen('S'), false, 'selectOnly 不能偷开')

	const read0 = await h.call('serial_configure', { lane: 'S' })
	assert.equal(read0.ok, true)
	assert.equal(read0.result.options.baudRate, 115200)
	assert.ok(read0.result.summary.indexOf('115200') === 0)

	const cfg = await h.call('serial_configure', { lane: 'S', options: { baudRate: 9600, parity: 'even' } })
	assert.equal(cfg.ok, true, JSON.stringify(cfg.result))
	assert.equal(cfg.result.reopened, false, '未打开时只落盘不重连')
	const saved = JSON.parse(h.localStore.get('serialOptions'))
	assert.equal(saved.baudRate, 9600)
	assert.equal(saved.parity, 'even')
	// 参数卡同步：UI 值与落盘一致，打开读的就是这份
	assert.equal(h.elements['serial-baud'].value, 9600)

	const opened = await h.call('serial_open', { lane: 'S' })
	assert.equal(opened.ok, true, JSON.stringify(opened.result))
	assert.equal(p1.openCalls.length, 1)
	assert.equal(p1.openCalls[0].baudRate, 9600, '打开要用刚配置的参数')
	assert.equal(h.hub.isOpen('S'), true)

	const w = await h.call('serial_write', { lane: 'S', data: '00ff' })
	assert.equal(w.ok, true)
	assert.deepEqual(h.writes[0].bytes, [0, 255])

	h.receive('S', enc('ok'))
	const rd = await h.call('serial_read', { lane: 'S' })
	assert.equal(rd.result.data, '6f6b')

	const cls = await h.call('serial_close', { lane: 'S' })
	assert.equal(cls.ok, true)
	assert.equal(h.hub.isOpen('S'), false)

	const st = await h.call('serial_state', {})
	assert.equal(st.result.lanes[0].device.portName, 'cu.w1')
	assert.equal(st.result.lanes[0].device.productName, 'WidgetA')
})

test('deviceId 前缀不属于本文档：stale_device_id，不枚举不授权', async () => {
	const h = harness({ ports: [makePort({ sn: 'SN-1' })] })
	await h.boot()
	const r = await h.call('serial_select', { lane: 'S', deviceId: 'old-doc-d9' })
	assert.equal(r.ok, false)
	assert.equal(r.result.code, 'stale_device_id')
	assert.equal(h.granted.length, 0)
	assert.equal(h.hub.getPort('S'), null)
})

test('同 epoch 但认不出的 deviceId：device_not_found，不按序号猜', async () => {
	const h = harness({ ports: [makePort({ sn: 'SN-1' })] })
	await h.boot()
	const list = await h.call('serial_ports_list', {})
	const forged = list.result.ports[0].deviceId.replace(/d(\d+)$/, 'd99')
	const r = await h.call('serial_select', { lane: 'S', deviceId: forged })
	assert.equal(r.result.code, 'device_not_found')
	assert.equal(h.hub.getPort('S'), null)
	// deviceId 与 sn 同时给 / 都不给：bad_params
	const both = await h.call('serial_select', { lane: 'S', deviceId: list.result.ports[0].deviceId, sn: 'SN-1' })
	assert.equal(both.result.code, 'bad_params')
	const none = await h.call('serial_select', { lane: 'S' })
	assert.equal(none.result.code, 'bad_params')
})

test('重插产生新端口对象：旧 deviceId 失效；sn 仍可选回', async () => {
	const p1 = makePort({ sn: 'SN-1', path: '/dev/cu.w1' })
	const h = harness({ ports: [p1] })
	await h.boot()
	const id1 = (await h.call('serial_ports_list', {})).result.ports[0].deviceId
	assert.equal((await h.call('serial_select', { lane: 'S', deviceId: id1 })).ok, true)
	// 重插：同型号同路径但新对象
	const p2 = makePort({ sn: 'SN-1', path: '/dev/cu.w1' })
	h.state.ports = [p2]
	const again = await h.call('serial_select', { lane: 'S', deviceId: id1 })
	assert.equal(again.result.code, 'device_not_found')
	const bySn = await h.call('serial_select', { lane: 'S', sn: 'SN-1' })
	assert.equal(bySn.ok, true)
	assert.equal(h.hub.getPort('S'), p2)
})

test('多台同 sn：ambiguous_device 并给出候选，不猜不选', async () => {
	const p1 = makePort({ sn: 'SN-1' })
	const p2 = makePort({ sn: 'SN-1' })
	const h = harness({ ports: [p1, p2] })
	await h.boot()
	const r = await h.call('serial_select', { lane: 'S', sn: 'SN-1' })
	assert.equal(r.ok, false)
	assert.equal(r.result.code, 'ambiguous_device')
	assert.equal(r.result.candidates.length, 2)
	assert.ok(r.result.candidates[0].deviceId !== r.result.candidates[1].deviceId)
	assert.equal(h.hub.getPort('S'), null)
	assert.equal(h.granted.length, 0)
})

test('已连接态 serial_select：只选不偷重开(关旧口、不打开新口)', async () => {
	const p0 = makePort({ sn: 'SN-0' })
	const p1 = makePort({ sn: 'SN-1' })
	const h = harness({ ports: [p0, p1] })
	await h.boot()
	h.hub.setPort('S', p0)
	h.hub.setOpen('S', true)
	const id1 = (await h.call('serial_ports_list', {})).result.ports.find((x) => x.sn === 'SN-1').deviceId
	const r = await h.call('serial_select', { lane: 'S', deviceId: id1 })
	assert.equal(r.ok, true, JSON.stringify(r.result))
	assert.equal(h.hub.getPort('S'), p1)
	assert.equal(h.hub.isOpen('S'), false, 'selectOnly：换上新口后保持未连接')
	assert.equal(p1.openCalls.length, 0, '不能偷偷打开新口')
})

test('serial_configure：已打开时按新参数重连成功(reopened:true)', async () => {
	const p1 = makePort({ sn: 'SN-1' })
	const h = harness({ ports: [p1] })
	await h.boot()
	h.hub.setPort('S', p1)
	h.hub.setOpen('S', true)
	const r = await h.call('serial_configure', { lane: 'S', options: { baudRate: 9600 } })
	assert.equal(r.ok, true, JSON.stringify(r.result))
	assert.equal(r.result.reopened, true)
	assert.equal(p1.openCalls.length, 1)
	assert.equal(p1.openCalls[0].baudRate, 9600)
	assert.equal(h.hub.isOpen('S'), true)
})

test('serial_configure：落盘成功但重连失败 → reopen_failed + executed:partial', async () => {
	const p1 = makePort({ sn: 'SN-1' })
	p1.openError = Object.assign(new Error('boom'), { name: 'BoomError' })
	const h = harness({ ports: [p1] })
	await h.boot()
	h.hub.setPort('S', p1)
	h.hub.setOpen('S', true)
	const r = await h.call('serial_configure', { lane: 'S', options: { baudRate: 9600 } })
	assert.equal(r.ok, false)
	assert.equal(r.result.code, 'reopen_failed')
	assert.equal(r.result.executed, 'partial')
	assert.equal(JSON.parse(h.localStore.get('serialOptions')).baudRate, 9600, '参数已落盘要如实反映')
	assert.equal(h.hub.isOpen('S'), false)
})

test('serial_configure：重连最后一步打开期被取消 → aborted(取消码不丢)', async () => {
	const p1 = makePort({ sn: 'SN-1' })
	const h = harness({ ports: [p1] })
	await h.boot()
	h.hub.setPort('S', p1)
	h.hub.setOpen('S', true)
	p1.openGate = deferred()
	const msg = h.msg('serial_configure', { lane: 'S', options: { baudRate: 9600 } })
	h.send(msg)
	await wait(180) // 过 closeSerial 与 100ms 间隔，停在 port.open
	assert.equal(p1.openCalls.length, 1, '应已进打开')
	h.cancel(msg.id)
	p1.openGate.resolve()
	const r = await h.call('serial_state', {}) // 先让队列有下一条不算
	const reply = h.replyFor(msg.id)
	assert.ok(reply, '要有回执')
	assert.equal(reply.result.code, 'aborted', JSON.stringify(reply.result))
	assert.equal(reply.result.executed, 'partial')
	assert.equal(h.hub.isOpen('S'), false, '取消后不能留下已连接')
})

test('serial_select：关旧口等待期被取消 → aborted partial', async () => {
	const p0 = makePort({ sn: 'SN-0' })
	const p1 = makePort({ sn: 'SN-1' })
	const h = harness({ ports: [p0, p1] })
	await h.boot()
	h.hub.setPort('S', p0)
	h.hub.setOpen('S', true)
	const gate = h.gateClose('S')
	const msg = h.msg('serial_select', { lane: 'S', sn: 'SN-1' })
	h.send(msg)
	await wait(30)
	h.cancel(msg.id)
	gate.resolve()
	await wait(60)
	const r = h.replyFor(msg.id)
	assert.ok(r)
	assert.equal(r.result.code, 'aborted')
	assert.equal(r.result.executed, 'partial')
	assert.equal(h.hub.getPort('S'), p0, '取消后不能换绑新口')
})

test('ownAccept 放行自有形态、仍拒外部变化：换口/切模式都是 lane_changed', async () => {
	const p0 = makePort({ sn: 'SN-0' })
	const p1 = makePort({ sn: 'SN-1' })
	const other = makePort({ sn: 'SN-9' })
	const h = harness({ ports: [p0, p1, other] })
	await h.boot()
	h.hub.setPort('S', p0)
	h.hub.setOpen('S', true)
	// 关旧口途中外部把口换成了第三台：不是本次操作自己的形态
	const gate = h.gateClose('S')
	const msg = h.msg('serial_select', { lane: 'S', sn: 'SN-1' })
	h.send(msg)
	await wait(30)
	h.hub.setPort('S', other)
	gate.resolve()
	await wait(60)
	const r = h.replyFor(msg.id)
	assert.ok(r)
	assert.equal(r.result.code, 'lane_changed', JSON.stringify(r.result))

	// 参数重连途中外部切模式：lane_changed(不是 aborted)
	const p2 = makePort({ sn: 'SN-2' })
	const h2 = harness({ ports: [p2] })
	await h2.boot()
	h2.hub.setPort('S', p2)
	h2.hub.setOpen('S', true)
	const gate2 = h2.gateClose('S')
	const msg2 = h2.msg('serial_configure', { lane: 'S', options: { baudRate: 9600 } })
	h2.send(msg2)
	await wait(30)
	h2.hub.mode = 'dual' // 外部切模式
	gate2.resolve()
	await wait(80)
	const r2 = h2.replyFor(msg2.id)
	assert.ok(r2)
	assert.equal(r2.result.code, 'lane_changed', JSON.stringify(r2.result))
})

test('等待期服务停用 / 应用更新准备 → 如实回报，不继续执行', async () => {
	const p0 = makePort({ sn: 'SN-0' })
	const p1 = makePort({ sn: 'SN-1' })
	const h = harness({ ports: [p0, p1] })
	await h.boot()
	h.hub.setPort('S', p0)
	h.hub.setOpen('S', true)
	const gate = h.gateClose('S')
	const msg = h.msg('serial_select', { lane: 'S', sn: 'SN-1' })
	h.send(msg)
	await wait(30)
	h.serviceOff()
	gate.resolve()
	await wait(60)
	const r = h.replyFor(msg.id)
	// 服务停用会清 active，等待期回 aborted(请求不继续执行)；终态 service_stopped 由 Rust 侧补发
	assert.equal(r.result.code, 'aborted')

	const h2 = harness({ ports: [makePort({ sn: 'SN-1' })] })
	await h2.boot()
	h2.hub.setPort('S', h2.state.ports[0])
	h2.hub.setOpen('S', true)
	const gate2 = h2.gateClose('S')
	const msg2 = h2.msg('serial_configure', { lane: 'S', options: { baudRate: 9600 } })
	h2.send(msg2)
	await wait(30)
	h2.win.serialApi.updatePreparing = true
	gate2.resolve()
	await wait(80)
	const r2 = h2.replyFor(msg2.id)
	assert.equal(r2.result.code, 'update_preparing')
})

test('拒绝发生在落盘 / I/O 前：钉扎、非法参数、未知键、opening、moving、不可见路', async () => {
	const p1 = makePort({ sn: 'SN-1' })
	const h = harness({ ports: [p1] })
	await h.boot()
	h.hub.setPort('S', p1)

	// 事务钉扎：不落盘
	h.state.pinned = true
	let r = await h.call('serial_configure', { lane: 'S', options: { baudRate: 9600 } })
	assert.equal(r.result.code, 'transaction_pinned')
	assert.equal(h.localStore.has('serialOptions'), false)
	h.state.pinned = false

	// 非法值：不落盘
	r = await h.call('serial_configure', { lane: 'S', options: { baudRate: 'abc' } })
	assert.equal(r.result.code, 'invalid_options')
	r = await h.call('serial_configure', { lane: 'S', options: { dataBits: 9 } })
	assert.equal(r.result.code, 'invalid_options')
	r = await h.call('serial_configure', { lane: 'S', options: { baudRate: 9600, bogus: 1 } })
	assert.equal(r.result.code, 'bad_params')
	assert.equal(h.localStore.has('serialOptions'), false)

	// 正在打开 / 正在增减路：不落盘
	h.hub.setOpening('S', true)
	r = await h.call('serial_configure', { lane: 'S', options: { baudRate: 9600 } })
	assert.equal(r.result.code, 'lane_busy')
	h.hub.setOpening('S', false)
	h.ctx.laneMoving = true
	r = await h.call('serial_configure', { lane: 'S', options: { baudRate: 9600 } })
	assert.equal(r.result.code, 'lane_moving')
	h.ctx.laneMoving = false
	assert.equal(h.localStore.has('serialOptions'), false)

	// 不可见路：单路下的 A/B、双路下的 S
	r = await h.call('serial_configure', { lane: 'A', options: { baudRate: 9600 } })
	assert.equal(r.result.code, 'lane_not_visible')
	r = await h.call('serial_select', { lane: 'A', sn: 'SN-1' })
	assert.equal(r.result.code, 'lane_not_visible')
})

test('另一路已选着的口：lane_blocked，不授予不绑定', async () => {
	const p1 = makePort({ sn: 'SN-1' })
	const p2 = makePort({ sn: 'SN-2' })
	const h = harness({ ports: [p1, p2], })
	await h.boot()
	h.hub.mode = 'dual'
	h.hub.setPort('B', p2)
	const list = await h.call('serial_ports_list', {})
	const id2 = list.result.ports.find((x) => x.sn === 'SN-2').deviceId
	const r = await h.call('serial_select', { lane: 'A', deviceId: id2 })
	assert.equal(r.result.code, 'lane_blocked')
	assert.equal(h.hub.getPort('A'), null)
	// 蓝牙口：unsupported_port
	const pb = makePort({ sn: 'SN-B', bluetooth: true })
	h.state.ports.push(pb)
	const idb = (await h.call('serial_ports_list', {})).result.ports.find((x) => x.sn === 'SN-B').deviceId
	const r2 = await h.call('serial_select', { lane: 'A', deviceId: idb })
	assert.equal(r2.result.code, 'unsupported_port')
})

test('serial_select 等待期换口已预留：第三方口顶不掉预留', async () => {
	const p0 = makePort({ sn: 'SN-0' })
	const p1 = makePort({ sn: 'SN-1' })
	const h = harness({ ports: [p0, p1] })
	await h.boot()
	h.hub.mode = 'dual'
	h.hub.setPort('A', p0)
	const gate = h.gateClose('A')
	const msg = h.msg('serial_select', { lane: 'A', sn: 'SN-1' })
	h.send(msg)
	await wait(30)
	// A 正在换 p1 的途中，B 选同一个口要被拒绝(预留)
	const b = await h.call('serial_select', { lane: 'B', sn: 'SN-1' })
	assert.equal(b.result.code, 'lane_blocked', JSON.stringify(b.result))
	gate.resolve()
	await wait(60)
	const r = h.replyFor(msg.id)
	assert.ok(r)
	assert.equal(r.ok, true)
	assert.equal(h.hub.getPort('A'), p1)
})

test('共享层直调：selectLanePort open:true 在最终打开期被取消 → opts.cancelled 置位', async () => {
	const p0 = makePort({ sn: 'SN-0' })
	const p1 = makePort({ sn: 'SN-1' })
	const h = harness({ ports: [p0, p1] })
	await h.boot()
	h.hub.setPort('S', p0)
	h.hub.setOpen('S', true)
	p1.openGate = deferred()
	let denyNow = false
	const selOpts = { open: true, guard: () => (denyNow ? { ok: false, code: 'aborted' } : null) }
	const run = h.T.selectLanePort('S', p1, selOpts)
	await wait(200)
	assert.equal(p1.openCalls.length, 1, '已进入最终打开')
	denyNow = true
	p1.openGate.resolve()
	assert.equal(await run, false)
	assert.equal(selOpts.cancelled, true, '取消标志要回传给调用方')
	assert.equal(h.hub.isOpen('S'), false)
})

test('serial_read：真实 serial-session 事件换代次，旧游标 invalid_cursor', async () => {
	const h = harness({ ports: [makePort({ sn: 'SN-1' })] })
	await h.boot()
	h.receive('S', enc('ab'))
	const first = await h.call('serial_read', { lane: 'S' })
	assert.equal(first.result.data, '6162')
	// 真实断连路径：closeSerial → serialStatuChange(false) → serial-session 事件 → 环重置
	await h.ctx.closeSerial('S')
	await flush()
	const stale = await h.call('serial_read', { lane: 'S', cursor: first.result.nextCursor })
	assert.equal(stale.result.code, 'invalid_cursor')
})

test('serial_open：无口 no_device_selected；打开冲突 lane_blocked', async () => {
	const p1 = makePort({ sn: 'SN-1' })
	const h = harness({ ports: [p1] })
	await h.boot()
	let r = await h.call('serial_open', { lane: 'S' })
	assert.equal(r.result.code, 'no_device_selected')
	// 已授权但另一路正开着同一口：lane 级拒绝
	h.hub.mode = 'dual'
	h.hub.setPort('A', p1)
	h.hub.setOpen('A', true)
	h.hub.setPort('B', p1)
	r = await h.call('serial_open', { lane: 'B' })
	assert.equal(r.ok, false)
	assert.ok(r.result.code === 'lane_conflict' || r.result.code === 'lane_blocked', r.result.code)
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
