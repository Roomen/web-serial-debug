// Synthetic Web Serial streams and a fake clock: no device identifiers or real logs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
const start = source.indexOf('\tconst READ_RECOVER_WINDOW_MS =')
const end = source.indexOf('\t//单个合并包的字节上限', start)
const releaseStart = source.indexOf('\tasync function releasePort(sid) {')
const releaseEnd = source.indexOf('\t//页面销毁时释放串口句柄', releaseStart)
const statsStart = source.indexOf('\t\tgetStats(sid) {')
const statsEnd = source.indexOf('\n\n\t\tisManualClose', statsStart)
const settle = () => new Promise(resolve => setImmediate(resolve))

function harness() {
	let now = 100000
	let timerId = 0
	const sessions = Object.fromEntries(['S', 'A', 'B'].map(sid => [sid, {
		open: true, opening: false, manualClose: false, reader: null, port: null,
		wantOpen: true, wantPortKey: 'synthetic', openedAt: now, rxBytes: 0, txBytes: 0
	}]))
	const logs = []
	const received = []
	const rxNotes = []
	const timers = new Map()
	const recovered = []
	const closed = []
	const opened = []
	let manualChanges = 0
	const hub = {
		_sess: sid => sessions[sid],
		isOpen: sid => sessions[sid].open,
		setOpen: (sid, value) => { sessions[sid].open = value },
		isManualClose: sid => sessions[sid].manualClose,
		setManualClose: (sid, value) => { manualChanges++; sessions[sid].manualClose = value },
		isOpening: sid => sessions[sid].opening,
		setOpening: (sid, value) => { sessions[sid].opening = value },
		getPort: sid => sessions[sid].port,
		getReader: sid => sessions[sid].reader,
		setReader: (sid, r) => { sessions[sid].reader = r },
		getPackTimer: () => null,
		setPackTimer: () => {}, setPackBuf: () => {}, setPackStartTime: () => {}, setSekWaitStart: () => {}
	}
	const context = vm.createContext({
		SerialHub: hub, window: {}, Date: { now: () => now },
		setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, due: now + ms }); return id },
		clearTimeout: id => timers.delete(id),
		setInterval: () => { throw new Error('unexpected interval') }, clearInterval: () => {},
		addLogErr: (msg, sid) => logs.push({ msg, sid }),
		dataReceived: (value, sid) => { received.push({ value, sid }); rxNotes.push(sid); context.api.noteSerialRx(sid) },
		closeSerial: async sid => { sessions[sid].open = false; closed.push(sid) },
		portHeldByOther: () => false, serialStatuChange: () => {}, updateOpenButton: () => {},
		openSerial: async (sid, opts) => { opened.push({ sid, opts, port: sessions[sid].port }); sessions[sid].open = true; return true }
	})
	vm.runInContext(source.slice(start, end) + source.slice(releaseStart, releaseEnd) + `
		recoverDeadReadLoop = async sid => recovered.push(sid)
		SerialHub.getStats = ({ ${source.slice(statsStart, statsEnd)} }).getStats
		globalThis.api = { readData, kickReaderOnForeground, resetRxWatch, rxWatch, noteSerialRx,
			releasePort, rebuildSerialReceive,
			invalidate: sid => ++readGenBySid[sid],
			attempts: (sid, value) => value === undefined ? reopenAttemptBySid[sid] : (reopenAttemptBySid[sid] = value),
			opened: sid => { rxWatch(sid).openedAt = Date.now() - 10000 } }
	`, Object.assign(context, { recovered }))
	async function advance(ms) {
		const target = now + ms
		await settle()
		while (true) {
			const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0]
			if (!next || next[1].due > target) break
			now = next[1].due
			timers.delete(next[0])
			next[1].fn()
			await settle()
		}
		now = target
		await settle()
	}
	return { sessions, hub, logs, received, rxNotes, timers, recovered, closed, opened, api: context.api, advance,
		manualChanges: () => manualChanges, now: () => now }
}

function stream(h, sid, actions) {
	const queue = actions.slice()
	let pending
	let reads = 0
	let cancels = 0
	let portCloses = 0
	const port = { readable: null, close: async () => { portCloses++ } }
	function next() {
		return { getReader: () => ({
			read: async () => {
				reads++
				const action = queue.shift()
				if (!action) return new Promise(resolve => { pending = resolve })
				if (action === 'done') { port.readable = next(); return { done: true } }
				if (typeof action === 'string') {
					port.readable = next()
					throw Object.assign(new Error('synthetic'), { name: action })
				}
				return { done: false, value: action }
			},
			releaseLock: () => {},
			cancel: async () => { cancels++; if (pending) pending({ done: true }) }
		}) }
	}
	port.readable = next()
	h.sessions[sid].port = port
	return { port, reads: () => reads, cancels: () => cancels, closes: () => portCloses,
		finish: value => pending({ done: false, value }) }
}
// Cancellation may finish before a pending Windows read settles. Keep its completion independently controllable.
function delayedStream(h, sid) {
	let resolveRead
	let rejectRead
	let reads = 0
	const reader = {
		read: () => {
			if (++reads > 1) return Promise.resolve({ done: true })
			return new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject })
		},
		cancel: async () => {}, releaseLock: () => {}
	}
	const port = { readable: { getReader: () => reader }, close: async () => {} }
	h.sessions[sid].port = port
	return { resolve: result => resolveRead(result), reject: error => rejectRead(error) }
}

async function testLateReads() {
	for (const viaRelease of [false, true]) {
		for (const result of ['data', 'error']) {
			const h = harness()
			const device = delayedStream(h, 'A')
			let finished = false
			const pending = h.api.readData('A').then(() => { finished = true })
			await settle()
			if (viaRelease) {
				h.sessions.A.open = false
				await h.api.releasePort('A')
				// Reopened before the new loop starts: only releasePort can have invalidated the old generation.
				h.sessions.A.open = true
			} else h.api.invalidate('A')
			const currentReader = {}
			h.sessions.A.reader = currentReader
			h.api.attempts('A', 2)
			if (result === 'data') device.resolve({ done: false, value: Uint8Array.of(7, 8) })
			else {
				h.sessions.A.port.readable = null
				device.reject(Object.assign(new Error('synthetic late error'), { name: 'NetworkError' }))
			}
			await settle()
			const scenario = (viaRelease ? 'releasePort' : 'invalidate') + ' / late ' + result
			assert.deepEqual(h.received, [], scenario + ': stale bytes reached dataReceived')
			assert.deepEqual(h.rxNotes, [], scenario + ': stale bytes reached noteSerialRx')
			assert.equal(h.api.rxWatch('A').lastRxAt, 0, scenario + ': stale RX timestamp')
			assert.equal(h.api.attempts('A'), 2, scenario + ': stale RX reset recovery attempts')
			assert.deepEqual(h.logs, [], scenario + ': stale result entered logs')
			assert.deepEqual(h.recovered, [], scenario + ': stale error reopened the current connection')
			assert.equal(h.sessions.A.reader, currentReader, scenario + ': current reader was cleared')
			assert.equal(finished, true, scenario + ': old loop failed to exit')
			await pending
		}
	}

	// A 500ms confirmation belongs to its original generation, even if the new connection has no reader yet.
	const foreground = harness()
	stream(foreground, 'B', [])
	foreground.api.kickReaderOnForeground('B')
	assert.equal(foreground.timers.size, 1)
	await foreground.advance(200)
	foreground.sessions.B.open = false
	await foreground.api.releasePort('B')
	foreground.sessions.B.open = true
	assert.equal(foreground.sessions.B.reader, null)
	await foreground.advance(300)
	assert.deepEqual(foreground.logs, [], 'foreground confirmation leaked across generations')
	assert.deepEqual(foreground.recovered, [], 'foreground confirmation reopened the new connection')
}

async function testFailureHints() {
	for (const type of ['NetworkError', 'DeviceLostError', 'SecurityError']) {
		const h = harness()
		stream(h, 'A', [type])
		const pending = h.api.readData('A')
		await settle()
		assert.equal(h.logs.length, 2)
		assert.ok(h.logs[0].msg.includes(type))
		assert.ok(!h.logs[0].msg.includes('正在重新建立接收流'))
		assert.equal(h.logs[1].msg, type === 'SecurityError' ? '串口权限错误，请重新授权' : '设备可能已断开连接')
		assert.equal(h.sessions.A.open, true)
		assert.deepEqual(h.recovered, [])
		await stop(h, 'A', pending)
	}
}

const failures = (n, type = 'FramingError') => Array(n).fill(type)
const pauses = h => h.logs.filter(x => x.msg.includes('接收暂缓')).map(x => Number(x.msg.match(/暂缓 (\d+)s/)[1]))

async function stop(h, sid, pending) {
	h.sessions[sid].open = false
	await h.api.releasePort(sid)
	await h.advance(50)
	await pending
}

async function testStatusBar() {
	const workbench = fs.readFileSync(path.join(__dirname, '../js/workbench.js'), 'utf8')
	function element() {
		return { children: [], dataset: {}, attrs: {}, listeners: {},
			classList: { toggle: () => {} },
			append(...items) { this.children.push(...items) },
			appendChild(item) { this.children.push(item) },
			setAttribute(key, value) { this.attrs[key] = value },
			addEventListener(type, fn) { this.listeners[type] = fn }
		}
	}
	const bar = element()
	const elements = { 'serial-statusbar': bar }
	const states = {
		S: { open: false, openedAt: 0, txBytes: 0, rxBytes: 0, lastRxAt: 0 },
		A: { open: true, openedAt: 10000, txBytes: 1, rxBytes: 0, lastRxAt: 0 },
		B: { open: true, openedAt: 10000, txBytes: 0, rxBytes: 2, lastRxAt: 95000, receivePaused: true }
	}
	const calls = []
	let opening = false
	const hub = { mode: 'dual', getStats: sid => states[sid], isOpening: () => opening,
		getLabelA: () => '<synthetic>', getLabelB: () => 'B路' }
	const context = vm.createContext({
		window: { SerialHub: hub, serialApi: { rebuildReceive: async sid => calls.push(sid) } },
		document: { createElement: element }, Date: { now: () => 100000 }, TASKS: [],
		$: id => elements[id] || null
	})
	vm.runInContext(workbench.slice(workbench.indexOf('	function fmtBytes'), workbench.indexOf('	// ---------- 初始化 ----------')) + `
		globalThis.status = { updateStatusBar, refs: statusRefs }
	`, context)
	context.status.updateStatusBar()
	const a = context.status.refs.sessions.A
	const b = context.status.refs.sessions.B
	assert.equal(a.lastRx.textContent, '未收到')
	assert.equal(a.lastRx.hidden, false)
	assert.equal(b.lastRx.textContent, '上次接收 5s 前 · 接收暂缓')
	assert.equal(a.name.textContent, '<synthetic>')
	assert.equal(a.rebuild.attrs['aria-label'], '<synthetic>：重建接收')
	assert.equal(b.rebuild.disabled, false)
	await b.rebuild.listeners.click()
	assert.deepEqual(calls, ['B'])
	opening = true
	context.status.updateStatusBar()
	assert.equal(a.rebuild.disabled, true)
	await a.rebuild.listeners.click()
	assert.deepEqual(calls, ['B'])
	opening = false
	states.A.open = false
	context.status.updateStatusBar()
	assert.equal(a.lastRx.hidden, true)
	assert.equal(a.rebuild.disabled, true)
	hub.mode = 'single'
	context.status.updateStatusBar()
	assert.equal(context.status.refs.sessions.S.lastRx.hidden, true)
	assert.equal(context.status.refs.sessions.S.rebuild.disabled, true)
}

async function run() {
	await testLateReads()
	await testFailureHints()
	// Error storms keep the same port and connection intent, with bounded logs and 1/3/10/10 pauses.
	for (const kind of ['FramingError', 'BreakError', 'done']) {
		const h = harness()
		const device = stream(h, 'A', failures(24, kind))
		const pending = h.api.readData('A')
		await settle()
		assert.deepEqual(pauses(h), [1])
		assert.equal(device.reads(), 21)
		assert.equal(h.api.rxWatch('A').backoff > 0, true)
		assert.equal(h.hub.getStats('A').receivePaused, true)
		h.api.kickReaderOnForeground('A')
		assert.equal(h.timers.size, 1) // Only the 50ms backoff tick; no foreground reopen timer.
		await h.advance(999)
		assert.equal(device.reads(), 21)
		await h.advance(1)
		assert.deepEqual(pauses(h), [1, 3])
		await h.advance(2999)
		assert.equal(device.reads(), 22)
		await h.advance(1)
		assert.deepEqual(pauses(h), [1, 3, 10])
		await h.advance(9999)
		assert.equal(device.reads(), 23)
		await h.advance(1)
		assert.deepEqual(pauses(h), [1, 3, 10, 10])
		await h.advance(10000)
		assert.equal(h.sessions.A.open, true)
		assert.equal(h.sessions.A.manualClose, false)
		assert.equal(h.manualChanges(), 0)
		assert.equal(h.sessions.A.wantOpen, true)
		assert.equal(h.sessions.A.wantPortKey, 'synthetic')
		assert.equal(h.sessions.A.port, device.port)
		assert.equal(h.sessions.B.open, true)
		assert.deepEqual(h.closed, [])
		assert.deepEqual(h.recovered, [])
		assert.equal(device.closes(), 0)
		assert.ok(h.logs.length <= 5)
		assert.ok(h.logs[1].msg.includes(kind === 'done' ? '接收流关闭 21 次' : '读取错误 21 次'))
		await stop(h, 'A', pending)
	}

	const prolonged = harness()
	const prolongedDevice = stream(prolonged, 'A', failures(1000))
	const prolongedRead = prolonged.api.readData('A')
	await prolonged.advance(120000)
	assert.ok(prolonged.logs.length <= 16)
	assert.ok(prolongedDevice.reads() <= 40)
	assert.equal(prolonged.sessions.A.open, true)
	assert.deepEqual(prolonged.recovered, [])
	await stop(prolonged, 'A', prolongedRead)

	// The foreground delayed confirmation must also respect a pause entered after scheduling it.
	const foreground = harness()
	stream(foreground, 'A', failures(21))
	foreground.api.opened('A')
	const foregroundRead = foreground.api.readData('A')
	await settle()
	const pauseMarker = foreground.api.rxWatch('A').backoff
	foreground.api.rxWatch('A').backoff = 0
	foreground.api.kickReaderOnForeground('A')
	foreground.api.rxWatch('A').backoff = pauseMarker
	await foreground.advance(500)
	assert.deepEqual(foreground.recovered, [])
	await stop(foreground, 'A', foregroundRead)

	// Closing/reopening during a pause invalidates the old loop, which must not clear the new pause marker.
	const stale = harness()
	const oldDevice = stream(stale, 'A', failures(21))
	const oldRead = stale.api.readData('A')
	await settle()
	stale.sessions.A.open = false
	await stale.api.releasePort('A')
	assert.equal(stale.api.rxWatch('A').backoff, 0)
	stale.sessions.A.open = true
	stream(stale, 'A', failures(21))
	const newRead = stale.api.readData('A')
	await settle()
	const newMarker = stale.api.rxWatch('A').backoff
	await stale.advance(50)
	await oldRead
	assert.equal(oldDevice.reads(), 21)
	assert.equal(stale.api.rxWatch('A').backoff, newMarker)
	assert.deepEqual(stale.recovered, [])
	await stop(stale, 'A', newRead)

	// Nonempty data clears both the level and the error budget. Empty data must not clear them.
	const restored = harness()
	stream(restored, 'S', [...failures(21), new Uint8Array(), Uint8Array.of(1, 2), ...failures(21)])
	const restoredRead = restored.api.readData('S')
	await settle()
	await restored.advance(1000)
	assert.deepEqual(pauses(restored), [1, 1])
	assert.equal(restored.received.length, 1)
	assert.equal(restored.hub.getStats('S').lastRxAt, restored.now())
	assert.equal(restored.logs.filter(x => x.msg.includes('接收已恢复')).length, 1)
	await stop(restored, 'S', restoredRead)
	const empty = harness()
	stream(empty, 'S', [...failures(21), new Uint8Array(), 'FramingError'])
	const emptyRead = empty.api.readData('S')
	await settle()
	await empty.advance(1000)
	assert.deepEqual(pauses(empty), [1, 3])
	assert.equal(empty.logs.filter(x => x.msg.includes('接收已恢复')).length, 0)
	await stop(empty, 'S', emptyRead)

	// Healthy idle readers do not get cancelled or gain an inactivity timer on foregrounding.
	const idle = harness()
	const idleDevice = stream(idle, 'A', ['FramingError'])
	idle.api.opened('A')
	const idleRead = idle.api.readData('A')
	await settle()
	await idle.advance(30000)
	idle.api.kickReaderOnForeground('A')
	assert.equal(idleDevice.cancels(), 0)
	assert.equal(idle.timers.size, 0)
	assert.deepEqual(idle.recovered, [])
	idle.api.invalidate('A')
	const newReader = {}
	idle.sessions.A.reader = newReader
	idleDevice.finish(Uint8Array.of(3))
	await idleRead
	assert.deepEqual(idle.received, [])
	assert.equal(idle.sessions.A.reader, newReader)

	// Structural stream failures retain full-reopen recovery.
	for (const shape of ['absent', 'getReader', 'unchanged']) {
		const broken = harness()
		broken.sessions.A.port = { readable: shape === 'absent' ? null : {
			getReader: () => {
				if (shape === 'getReader') throw new Error('synthetic lock failure')
				return { read: async () => ({ done: true }), releaseLock: () => {} }
			}
		} }
		const brokenRead = broken.api.readData('A')
		await settle()
		if (shape === 'unchanged') await broken.advance(2000)
		await brokenRead
		assert.deepEqual(broken.recovered, ['A'])
		assert.deepEqual(broken.closed, [])
	}

	// The manual fallback releases the original port and preserves connection intent, using silent open.
	const manual = harness()
	const manualDevice = stream(manual, 'B', failures(21))
	const manualRead = manual.api.readData('B')
	await settle()
	manual.api.attempts('B', 3)
	assert.equal(await manual.api.rebuildSerialReceive('B'), true)
	assert.equal(manualDevice.closes(), 1)
	assert.equal(manual.api.rxWatch('B').backoff, 0)
	assert.equal(manual.api.attempts('B'), 0)
	assert.equal(manual.manualChanges(), 0)
	assert.equal(manual.sessions.B.wantOpen, true)
	assert.equal(manual.sessions.B.wantPortKey, 'synthetic')
	assert.equal(manual.opened[0].port, manualDevice.port)
	assert.equal(manual.opened[0].opts.reason, 'receive-rebuild')
	assert.equal(manual.sessions.B.opening, false)
	await manual.advance(50)
	await manualRead
	manual.sessions.B.opening = true
	assert.equal(await manual.api.rebuildSerialReceive('B'), false)
	manual.sessions.B.opening = false
	manual.sessions.B.open = false
	assert.equal(await manual.api.rebuildSerialReceive('B'), false)
	assert.equal(manual.opened.length, 1)
	await testStatusBar()
	console.log('serial read recovery: passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
