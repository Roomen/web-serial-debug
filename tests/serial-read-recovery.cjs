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
const statsStart = source.indexOf('\t\tresetStats(sid) {')
const statsEnd = source.indexOf('\n\n\t\tisManualClose', statsStart)
const settle = () => new Promise(resolve => setImmediate(resolve))

function harness() {
	let now = 100000
	let timerId = 0
	const sessions = Object.fromEntries(['S', 'A', 'B'].map(sid => [sid, {
		open: true, opening: false, manualClose: false, reader: null, port: null, packBuf: [], packGlitch: false,
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
		getPackBuf: sid => sessions[sid].packBuf,
		getPackStartTime: () => null,
		getPackTimer: () => null,
		setPackTimer: () => {}, setPackBuf: () => {}, setPackStartTime: () => {}, setSekWaitStart: () => {}
	}
	const context = vm.createContext({
		SerialHub: hub, window: {}, Date: { now: () => now },
		setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, due: now + ms }); return id },
		clearTimeout: id => timers.delete(id),
		setInterval: () => { throw new Error('unexpected interval') }, clearInterval: () => {},
		addLogErr: (msg, sid) => logs.push({ msg, sid }),
		dataReceived: (value, sid, meta) => { received.push({ value, sid, meta: meta && { ...meta } }); rxNotes.push(sid); context.api.noteSerialRx(sid) },
		closeSerial: async sid => { sessions[sid].open = false; closed.push(sid) },
		flushSerialPack: () => {},
		portHeldByOther: () => false, serialStatuChange: () => {}, updateOpenButton: () => {},
		openSerial: async (sid, opts) => { opened.push({ sid, opts, port: sessions[sid].port }); sessions[sid].open = true; return true }
	})
	vm.runInContext(source.slice(start, end) + source.slice(releaseStart, releaseEnd) + `
		recoverDeadReadLoop = async sid => recovered.push(sid)
		Object.assign(SerialHub, { ${source.slice(statsStart, statsEnd)} })
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

// 手动驱动的接收流：push 一个动作就结算当前挂起的 read，错误时先换出新的 readable（与浏览器重建一致）。
function liveStream(h, sid) {
	let pending
	const port = { readable: null, close: async () => {} }
	function next() {
		return { getReader: () => ({
			read: () => new Promise((resolve, reject) => { pending = { resolve, reject } }),
			releaseLock: () => {},
			cancel: async () => { if (pending) pending.resolve({ done: true }) }
		}) }
	}
	port.readable = next()
	h.sessions[sid].port = port
	return { push: async action => {
		await settle()
		if (typeof action === 'string') {
			port.readable = next()
			pending.reject(Object.assign(new Error('synthetic'), { name: action }))
		} else pending.resolve({ done: false, value: action })
		await settle()
	} }
}

async function testLineErrorQuiet() {
	// 每秒一次 FramingError 加两字节 00，持续 30 秒：不提示、不计数，无红色错误、无退避。
	const h = harness()
	const device = liveStream(h, 'A')
	const pending = h.api.readData('A')
	for (let i = 0; i < 30; i++) {
		await h.advance(1000)
		await device.push('FramingError')
		await device.push(Uint8Array.of(0, 0))
	}
	await device.push('BreakError')
	await device.push('ParityError')
	assert.deepEqual(h.logs, [])
	assert.equal('lineErrors' in h.hub.getStats('A'), false)
	assert.equal(h.hub.getStats('A').receivePaused, false)
	assert.equal(h.api.rxWatch('A').backoff, 0)
	assert.equal(h.received.length, 30)
	// 全 0 且紧随错误：每块都带毛刺元数据，字节原样进入 dataReceived
	for (const r of h.received) {
		assert.deepEqual([...r.value], [0, 0])
		assert.deepEqual(r.meta, { lineGlitch: true })
	}
	await stop(h, 'A', pending)

	// BufferOverrunError 是真丢数据：照常红色报错
	const overrun = harness()
	const overrunDevice = liveStream(overrun, 'A')
	const overrunRead = overrun.api.readData('A')
	await overrunDevice.push('BufferOverrunError')
	assert.equal(overrun.logs.length, 1)
	assert.ok(overrun.logs[0].msg.includes('BufferOverrunError'))
	await stop(overrun, 'A', overrunRead)

	// 线路错误风暴进入退避时，汇总仍是红色日志并带次数
	const storm = harness()
	stream(storm, 'A', failures(24))
	const stormRead = storm.api.readData('A')
	await settle()
	assert.deepEqual(pauses(storm), [1])
	assert.ok(storm.logs[0].msg.includes('读取错误 21 次'))
	await stop(storm, 'A', stormRead)
}

async function testLineGlitchMeta() {
	const cases = [
		// [名称, 错误后延迟 ms, 数据, 是否标注]
		['2 字节 00 立即到达', 0, [0, 0], true],
		['50ms 边界', 50, [0, 0, 0], true],
		['超过 50ms', 51, [0, 0], false],
		['含非 0 字节', 0, [0, 1], false],
		['超过 8 字节', 0, new Array(9).fill(0), false],
		['恰好 8 字节', 0, new Array(8).fill(0), true]
	]
	for (const [name, delay, bytes, expected] of cases) {
		const h = harness()
		const device = liveStream(h, 'A')
		const pending = h.api.readData('A')
		await device.push('FramingError')
		await h.advance(delay)
		await device.push(Uint8Array.from(bytes))
		assert.equal(h.received.length, 1, name)
		assert.deepEqual([...h.received[0].value], bytes, name + ': 字节被改动')
		assert.deepEqual(h.received[0].meta, expected ? { lineGlitch: true } : undefined, name)
		await stop(h, 'A', pending)
	}
	// 只有线路错误后重建出的 reader 的第一次读取才可能被标注
	const h = harness()
	const device = liveStream(h, 'A')
	const pending = h.api.readData('A')
	await device.push('FramingError')
	await device.push(Uint8Array.of(1))
	await device.push(Uint8Array.of(0, 0))
	assert.deepEqual(h.received.map(r => r.meta), [undefined, undefined])
	// 非线路错误之后的全 0 块不标注
	await device.push('NetworkError')
	await device.push(Uint8Array.of(0, 0))
	assert.equal(h.received[2].meta, undefined)
	await stop(h, 'A', pending)
}

function packHarness(timeOut, protocol) {
	let now = 100000
	let timerId = 0
	const timers = new Map()
	const flushed = []
	const parsed = []
	let addLogResult
	const makeSession = () => ({ packBuf: [], packTimer: null, packStartTime: null, sekWaitStart: null, rxBytes: 0, packGlitch: false })
	const sessions = Object.fromEntries(['S', 'A', 'B'].map(sid => [sid, makeSession()]))
	const sidFlushed = []
	const times = []
	const hub = {
		_sess: sid => sessions[sid], mode: 'single',
		getPackBuf: sid => sessions[sid].packBuf, setPackBuf: (sid, a) => { sessions[sid].packBuf = a },
		getPackStartTime: sid => sessions[sid].packStartTime, setPackStartTime: (sid, t) => { sessions[sid].packStartTime = t },
		getPackTimer: sid => sessions[sid].packTimer, setPackTimer: (sid, t) => { sessions[sid].packTimer = t },
		getSekWaitStart: sid => sessions[sid].sekWaitStart, setSekWaitStart: (sid, t) => { sessions[sid].sekWaitStart = t },
		activeSendPhys: () => 'S', isRoutable: () => false, logModeOf: () => 'single',
		getPort: () => null, getReader: () => null, setReader: () => {}
	}
	const context = vm.createContext({
		SerialHub: hub, window: { _activeProtocol: protocol }, toolOptions: {}, logType: 'hex',
		// 分包帧保护按该路协议；这里各路都跟随 window._activeProtocol(单路就是顶栏协议)
		protocolIdForSid: () => context.window._activeProtocol,
		Uint8Array, Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } },
		SEK_INCOMPLETE_WAIT_MAX_MS: 3000,
		setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, fn); return id },
		clearTimeout: id => timers.delete(id),
		addLogErrSafe: () => {}, noteSerialRx: () => {}, getLogTypeForSid: () => context.logType, logOptionsForSid: () => ({ timeOut }),
		isRowLogType: () => true, schedulePersistLogs: () => {},
		addLog: (buf, isReceive, startTime, sid, glitch) => { flushed.push({ bytes: [...buf], glitch }); sidFlushed.push(sid); times.push(Number(startTime)); parsed.push([...buf]); return addLogResult },
		parseLogType: t => ({ parse: /parse/.test(t) }), SERIAL_PACK_MAX_BYTES: 65536, readGenBySid: { S: 0 }, resetRxWatch: () => {}, portHeldByOther: () => false
	})
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/hostproto-protocol.js'), 'utf8'), context)
	const peekStart = source.indexOf('\tfunction peekSekIncompleteNeed(')
	const peekEnd = source.indexOf('\n\t}\n', peekStart) + 4
	const flushStart = source.indexOf('\tfunction hostProtoLogging(')
	const flushEnd = source.indexOf('\t//对外暴露的串口接口', flushStart)
	const zeroStart = source.indexOf('\tfunction isAllZero(')
	const zeroEnd = source.indexOf('\n\t}\n', zeroStart) + 4
	vm.runInContext(`Object.assign(SerialHub, { ${source.slice(statsStart, statsEnd)} })
		${source.slice(zeroStart, zeroEnd)}
		${source.slice(peekStart, peekEnd)}
		${source.slice(flushStart, flushEnd)}
		${source.slice(releaseStart, releaseEnd)}
		globalThis.api = { dataReceived, flushPendingRx, releasePort }`, context)
	return { api: context.api, flushed, parsed, hub, context, sidFlushed, times, H: context.window.hostProto, setAddLogResult: v => { addLogResult = v }, fire: (ms = 50) => { now += ms; const all = [...timers.values()]; timers.clear(); all.forEach(fn => fn()) } }
}

async function testPackGlitch() {
	// 合包：整包全 0 且含毛刺块才按毛刺行处理；混有真实数据的包照常显示
	const merge = packHarness(50)
	merge.api.dataReceived(Uint8Array.of(0xAA, 0xBB), 'S')
	merge.api.dataReceived(Uint8Array.of(0, 0), 'S', { lineGlitch: true })
	merge.api.dataReceived(Uint8Array.of(0xCC), 'S')
	merge.fire()
	assert.deepEqual(merge.flushed, [{ bytes: [0xAA, 0xBB, 0, 0, 0xCC], glitch: false }])
	merge.api.dataReceived(Uint8Array.of(0, 0), 'S', { lineGlitch: true })
	merge.api.dataReceived(Uint8Array.of(0), 'S')
	merge.fire()
	assert.deepEqual(merge.flushed[1], { bytes: [0, 0, 0], glitch: true })
	merge.api.dataReceived(Uint8Array.of(0, 0), 'S')
	merge.fire()
	assert.equal(merge.flushed[2].glitch, false)

	// 不分包：立即输出
	const direct = packHarness(0)
	direct.api.dataReceived(Uint8Array.of(0, 0), 'S', { lineGlitch: true })
	direct.api.dataReceived(Uint8Array.of(0, 0), 'S')
	assert.deepEqual(direct.flushed, [{ bytes: [0, 0], glitch: true }, { bytes: [0, 0], glitch: false }])

	// 并入上一条毛刺行时 addLog 返回 merged，不再新增行
	const parse = packHarness(0)
	parse.api.dataReceived(Uint8Array.of(0, 0), 'S', { lineGlitch: true })
	parse.setAddLogResult('merged')
	parse.api.dataReceived(Uint8Array.of(0, 0), 'S', { lineGlitch: true })
	assert.equal(parse.flushed.length, 2)

	// 日志格式含「解析」时，未收满声明长度的 SEK 帧在分包超时后继续等；不含解析且当前协议不是 SEK 时照常输出
	const half = Uint8Array.from([0xA9, 0x9A, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 0])
	for (const [type, waits] of [['hex', false], ['hex&parse', true], ['parse', true], ['text', false]]) {
		const h = packHarness(50)
		h.context.logType = type
		h.context.window._activeProtocol = 'gz'
		h.api.dataReceived(half, 'S')
		h.fire()
		assert.equal(h.flushed.length, waits ? 0 : 1, type)
	}

	// releasePort 输出最后的残包并清毛刺标记：新连接的第一包不得带上旧连接的标记
	const released = packHarness(50)
	released.api.dataReceived(Uint8Array.of(0, 0), 'S', { lineGlitch: true })
	await released.api.releasePort('S')
	released.api.dataReceived(Uint8Array.of(0), 'S')
	released.fire()
	assert.deepEqual(released.flushed, [{ bytes: [0, 0], glitch: true }, { bytes: [0], glitch: false }])

	// 发送前提前 flush(flushPendingRx)同样带走标记，且不残留到下一包
	const early = packHarness(50)
	early.api.dataReceived(Uint8Array.of(0, 0), 'S', { lineGlitch: true })
	early.api.flushPendingRx('S')
	early.api.dataReceived(Uint8Array.of(0), 'S')
	early.fire()
	assert.deepEqual(early.flushed, [{ bytes: [0, 0], glitch: true }, { bytes: [0], glitch: false }])
}

function testHostProtoPack() {
	for (const timeout of [0, 50]) {
		const h = packHarness(timeout, 'hostproto')
		const frame = h.H.buildFrame({ type: h.H.TYPE_EVT, cmd: 0x0280, seq: 0, payload: [1, 2, 3] })
		const response = h.H.buildFrame({ type: h.H.TYPE_RSP, cmd: 0x020c, seq: 7, payload: [0] })
		// A 的最后一字节未到，B 的完整帧和发送前 flush 都不得切掉 A 的半帧。
		h.api.dataReceived(frame.slice(0, -1), 'A')
		h.api.dataReceived(response, 'B')
		h.fire()
		h.api.flushPendingRx('A')
		assert.deepEqual(h.sidFlushed, ['B'])
		h.api.dataReceived(Uint8Array.from([frame.at(-1), ...response]), 'A')
		assert.deepEqual(h.sidFlushed, ['B', 'A', 'A'])
		assert.deepEqual(h.parsed, [[...response], [...frame], [...response]])
		assert.ok(h.parsed.every(bytes => h.H.parseFrame(bytes).ok))
		assert.equal(h.hub.getPackBuf('A').length, 0)

		// 每一个可能的 read 边界，包括单独 EB，都能还原完整帧。
		for (let split = 1; split < frame.length; split++) {
			const before = h.parsed.length
			h.api.dataReceived(frame.slice(0, split), 'A')
			h.api.flushPendingRx('A')
			h.api.dataReceived(frame.slice(split), 'A')
			// 只有 FF 前导的块允许提前作为原始日志输出。
			assert.ok(h.H.parseFrame(h.parsed.at(-1)).ok, 'split ' + split)
			assert.deepEqual(h.parsed.slice(before).flat(), [...frame])
		}

		// 真实订阅者同步 TX 的顺序：完整 RX 已进入日志，不会把尾字节留到下一行。
		h.hub.mode = 'dual'
		h.hub.isRoutable = () => true
		h.hub.activeSendSid = () => 'B'
		const callbacks = []
		h.context.window.serialApi = { _receivers: [{ sid: 'A', cb: bytes => {
			callbacks.push([...bytes])
			h.api.flushPendingRx('A')
		} }] }
		h.api.dataReceived(frame.slice(0, -1), 'A')
		const before = h.parsed.length
		h.api.dataReceived(frame.slice(-1), 'A')
		assert.deepEqual(h.parsed.slice(before), [[...frame]])
		assert.equal(callbacks.length, 2)
		assert.equal(h.hub.getPackBuf('A').length, 0)

		// 前帧补齐时同块开始的下一帧，使用本次 RX 的时间。
		h.api.dataReceived(frame.slice(0, -1), 'A')
		h.fire(10)
		h.api.dataReceived(Uint8Array.from([frame.at(-1), ...response.slice(0, -1)]), 'A')
		const firstTime = h.times.at(-1)
		h.api.dataReceived(response.slice(-1), 'A')
		assert.equal(h.times.at(-1), firstTime + 10)

		// 日志显示异常也不能阻止原始字节进入协议订阅者。
		const beforeError = callbacks.length
		const originalLog = h.context.addLog
		h.context.addLog = () => { throw new Error('synthetic render failure') }
		h.api.dataReceived(response, 'A')
		assert.equal(callbacks.length, beforeError + 1)
		assert.deepEqual(callbacks.at(-1), [...response])
		h.context.addLog = originalLog

		// 半帧永久缺尾也必须有界输出，后续完整帧可重新同步。
		h.api.dataReceived(frame.slice(0, -1), 'A')
		h.fire()
		h.fire(3000)
		assert.equal(h.hub.getPackBuf('A').length, 0)
		h.api.dataReceived(response, 'A')
		assert.deepEqual(h.parsed.at(-1), [...response])
	}
}

function renderHarness() {
	const rows = []
	function element() {
		return { attrs: {}, children: [], className: '', textContent: '', innerHTML: '',
			setAttribute(k, v) { this.attrs[k] = v }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null },
			appendChild(c) { this.children.push(c) } }
	}
	const context = vm.createContext({
		textdecoder: new TextDecoder(), toolOptions: { showTime: false },
		HTMLEncode: t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
		attrEscape: t => t, ansi_up: { ansi_to_html: t => t }, logSeq: 0, formatDate: () => '',
		AnsiUp: function () { this.ansi_to_html = t => t },
		// 按路解析状态：各路协议由用例指定(缺省都跟随顶栏)
		laneLive: { A: null, B: null }, sessionResetSeq: { S: 0, A: 0, B: 0 },
		protocolIdForSid: sid => (context.laneProto && context.laneProto[sid]) || context.window._activeProtocol,
		document: { createElement: element }, window: {}, getProtocolParseOpts: () => ({}),
		skParseFrame: data => ({ raw: Array.from(data) }),
		SerialHub: { activeSendPhys: () => 'A', logModeOf: () => 'dual', getSessionLabel: () => 'A路',
			getLogContainerFor: () => ({ children: rows }) },
		logType: 'hex', getLogTypeForSid: () => context.logType,
		appendLogNode: (row) => rows.push(row), isRowLogType: () => true
	})
	const a = source.indexOf('\tfunction bytesToHexArr(')
	const b = source.indexOf('\t//日志正文渲染到此为止', a)
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/parse-view.js'), 'utf8'), context)
	context.window.getActiveProtocol = () => (context.protoById && context.protoById[context.window._activeProtocol]) || context.proto
	vm.runInContext(source.slice(a, b) + '\nglobalThis.api = { renderLogBody, addLog, parseLogType }', context)
	return { context, rows, api: context.api }
}

async function testLogRendering() {
	const { context, rows, api } = renderHarness()
	const bytes = (...x) => Uint8Array.from(x)
	// HEX 并排：整块全 00 才省略 TEXT 段，也不留换行
	assert.equal(api.renderLogBody(bytes(0, 0), 'hex&text'), 'HEX:00 00')
	assert.equal(api.renderLogBody(bytes(0, 0, 0), 'hex&ansi'), 'HEX:00 00 00')
	// 含任何非 0 字节(包括控制字符、空白、0xFF)都照旧显示
	assert.equal(api.renderLogBody(bytes(0x41, 0), 'hex&text'), 'HEX:41 00<br/>TEXT:A\0')
	assert.equal(api.renderLogBody(bytes(0, 0x01), 'hex&text'), 'HEX:00 01<br/>TEXT:\0\x01')
	assert.equal(api.renderLogBody(bytes(0x20, 0x0D), 'hex&text'), 'HEX:20 0D<br/>TEXT: \r')
	assert.ok(api.renderLogBody(bytes(0xFF, 0xFE), 'hex&text').includes('<br/>TEXT:'))
	assert.equal(api.renderLogBody(bytes(0xE4, 0xB8, 0xAD), 'hex&text'), 'HEX:E4 B8 AD<br/>TEXT:中')
	assert.equal(api.renderLogBody(bytes(0x3C, 0x62, 0x3E), 'hex&text'), 'HEX:3C 62 3E<br/>TEXT:&lt;b&gt;')
	assert.equal(api.renderLogBody(bytes(0x1B, 0x5B, 0x33, 0x31, 0x6D, 0x41), 'hex&ansi'), 'HEX:1B 5B 33 31 6D 41<br/>TEXT:\x1B[31mA')
	// 单独 TEXT / ANSI 不变：全 00 也保留正文
	assert.equal(api.renderLogBody(bytes(0, 0), 'text'), '\0\0')
	assert.equal(api.renderLogBody(bytes(0, 0), 'ansi'), '\0\0')
	assert.equal(api.renderLogBody(bytes(0x41), 'text'), 'A')

	// 毛刺行：第一条照常出行并带 data-glitch；同一路紧接着的毛刺包直接并入，不新增行也不改那一行
	for (const type of ['hex', 'text', 'hex&text', 'ansi', 'hex&ansi']) {
		rows.length = 0
		context.logType = type
		assert.equal(api.addLog(bytes(0, 0), true, new Date(0), 'A', true), undefined, type)
		const row = rows[0]
		const html = row.innerHTML
		assert.equal(row.attrs['data-hex'], '00 00', type)
		assert.equal(row.attrs['data-glitch'], '1', type)
		assert.equal(api.addLog(bytes(0, 0, 0), true, new Date(1), 'A', true), 'merged', type)
		assert.equal(rows.length, 1, type)
		assert.equal(row.innerHTML, html, type)
		assert.equal(row.attrs['data-hex'], '00 00', type)
		// 另一路的行夹在中间不打断合并
		rows.push({ attrs: { 'data-sid': 'B' }, getAttribute(k) { return this.attrs[k] || null } })
		assert.equal(api.addLog(bytes(0), true, new Date(2), 'A', true), 'merged', type)
		assert.equal(rows.length, 2, type)
		// 同一路来了正常数据之后，下一次毛刺重新开一行
		api.addLog(bytes(0x41), true, new Date(3), 'A')
		assert.equal(rows[2].attrs['data-glitch'], undefined, type)
		api.addLog(bytes(0, 0), true, new Date(4), 'A', true)
		assert.equal(rows.length, 4, type)
		assert.equal(rows[3].attrs['data-glitch'], '1', type)
		assert.ok(!rows[3].innerHTML.includes('毛刺'), type)
	}

	// logType 拆解：'&' 也出现在 &parse 后缀里，并排判断只看 hex 与 text 是否同时存在
	assert.deepEqual(JSON.parse(JSON.stringify(api.parseLogType('hex&ansi&parse'))), { hex: true, text: true, ansi: true, parse: true })
	assert.deepEqual(JSON.parse(JSON.stringify(api.parseLogType('parse'))), { hex: false, text: false, ansi: false, parse: true })
	assert.deepEqual(JSON.parse(JSON.stringify(api.parseLogType('term'))), { hex: false, text: false, ansi: false, parse: false })
	assert.equal(api.renderLogBody(bytes(0x41, 0x42), 'hex&parse'), '41 42')
	assert.equal(api.renderLogBody(bytes(0x41, 0x42), 'text&parse'), 'AB')

	// 解析段：协议 logView 出模型，ParseView 统一转义
	const model = { title: '<b>标题</b>', dir: 'up', subject: { label: '设备', value: '<script>x</script>' }, sections: [{ pairs: [['<k>', '<v>']] }] }
	context.proto = { logView: () => model }
	const html = api.renderLogBody(bytes(0x41, 0x42), 'hex&text&parse', { isReceive: true })
	assert.ok(html.startsWith('HEX:41 42<br/>TEXT:AB<div class="pv pv-up">'), html)
	assert.ok(!html.includes('<script>') && !html.includes('<b>') && !html.includes('<k>'), html)
	assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'))
	// TX 只留头部一行，其余折叠进 <details>
	assert.ok(api.renderLogBody(bytes(0x41), 'parse', { isReceive: false, sendName: '读取' }).startsWith('<details class="pv pv-up pv-fold">'))
	// 不是本协议的帧：与 HEX/TEXT 同显时只是没有解析段；只选「解析」回退 HEX 并标未识别
	context.proto = { logView: () => null }
	assert.equal(api.renderLogBody(bytes(0x41, 0x42), 'hex&parse', { isReceive: true }), '41 42')
	assert.equal(api.renderLogBody(bytes(0x41, 0x42), 'parse', { isReceive: true }).replace(/<span[^>]*>/, '<span>'), '<span>未识别</span> 41 42')
	// logView 抛异常按未识别处理；固件升级期间(noParse)不解析
	context.proto = { logView: () => { throw new Error('boom') } }
	assert.equal(api.renderLogBody(bytes(0x41), 'hex&parse', { isReceive: true }), '41')
	context.proto = { logView: () => model }
	assert.equal(api.renderLogBody(bytes(0x41), 'hex&parse', { isReceive: true, noParse: true }), '41')
	assert.ok(api.renderLogBody(bytes(0x41), 'parse', { isReceive: true, noParse: true }).includes('未识别'))
	// 没有 logView 的协议退回 formatFrame 老样式
	context.proto = { formatFrame: () => '<div class="sk-parse">legacy</div>' }
	assert.equal(api.renderLogBody(bytes(0x41), 'parse', { isReceive: true }), '<div class="pv pv-legacy"><div class="sk-parse">legacy</div></div>')

	// 行上记录升级期间不解析与快捷发送名称，供重渲使用
	rows.length = 0
	context.logType = 'hex&parse'
	context.proto = { logView: () => model }
	context.window.serialApi = { suppressParse: true }
	api.addLog(bytes(0x41), false, new Date(5), 'A', false, '读取')
	assert.equal(rows[0].attrs['data-noparse'], '1')
	assert.equal(rows[0].attrs['data-name'], '读取')
	assert.ok(!rows[0].innerHTML.includes('class="pv'))
	context.window.serialApi = { suppressParse: false }
	api.addLog(bytes(0x41), true, new Date(6), 'A')
	assert.equal(rows[1].attrs['data-noparse'], undefined)
	assert.ok(rows[1].innerHTML.includes('class="pv pv-up"'))
}

// 分批重渲在隔离的会话里重放历史：批次间的实时基准、连接重置都不能被剩余历史批次覆盖
async function testParseRerenderIsolation() {
	const { context, api } = renderHarness()
	let clock = 0
	const timers = []
	class FakeDate extends Date { static now() { return clock } }
	const session = {
		deviceUid: null, baseCode: null,
		resetBase() { this.baseCode = null },
		setBase(code) { this.baseCode = code },
		snapshot() { return { deviceUid: this.deviceUid, baseCode: this.baseCode } },
		restore(s) { this.deviceUid = s.deviceUid; this.baseCode = s.baseCode },
	}
	Object.assign(context, {
		Date: FakeDate, setTimeout: fn => timers.push(fn), AnsiUp: function () {},
		PARSE_RERENDER_SYNC_ROWS: 150, PARSE_RERENDER_SLICE_MS: 12, rerenderGen: 0,
		logOptionsSingle: { autoScroll: false }, logOptionsDual: { autoScroll: false },
		// B0 xx 帧在解析时设置会话基准，其余帧只是读出当前基准，与 SEK 的 Tag2/3-ID29 行为一致
		skParseFrame: data => { clock += 5; if (data[0] === 0xB0) session.setBase(data[1]); return {} },
	})
	context.SerialHub.getLogContainerFor = () => null
	context.window.skSession = session
	context.proto = { logView: () => ({ title: 'base' + session.baseCode }) }
	function makeRow(hex) {
		const body = { innerHTML: '' }
		return { attrs: { 'data-hex': hex, 'data-dir': 'rx' }, classList: { contains: c => c === 'log-row' },
			getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }, querySelector: () => body, body }
	}
	function makeContainer() {
		const children = [makeRow('B0 01')]
		for (let i = 0; i < 159; i++) children.push(makeRow('01 02'))
		return { children, get lastElementChild() { return children[children.length - 1] } }
	}
	const runTimers = () => { while (timers.length) timers.shift()() }
	const vmApi = vm.runInContext('({ rerenderLogBodies })', context)

	// 批次之间实时收到新基准 2，并追加了一行：历史重放仍按自己的基准 1，实时基准保持 2
	session.setBase(2)
	let box = makeContainer()
	vmApi.rerenderLogBodies(box, 'parse')
	assert.ok(timers.length, '160 行应分批')
	assert.equal(session.baseCode, 2)
	session.setBase(2)
	box.children.push(makeRow('01 02'))
	runTimers()
	assert.equal(session.baseCode, 2)
	assert.ok(box.children[159].body.innerHTML.includes('base1'), box.children[159].body.innerHTML)

	// 批次之间连接重置清空了基准：剩余批次与收尾都不能把历史基准恢复回实时会话
	session.setBase(2)
	box = makeContainer()
	vmApi.rerenderLogBodies(box, 'parse')
	session.resetBase()
	context.sessionResetSeq.S++
	runTimers()
	assert.equal(session.baseCode, null)

	// 期间没有实时活动：重放末态交给实时会话，与同步重渲的行为一致
	session.resetBase()
	box = makeContainer()
	vmApi.rerenderLogBodies(box, 'parse')
	runTimers()
	assert.equal(session.baseCode, 1)
	assert.ok(api.parseLogType('parse').parse)
}

// 双路两路协议各自独立：每行按所属那一路(data-sid)的协议与会话状态重放，A 路读到的基准不会套到 B 路；
// 收尾把各路重放末态交给各自的实时状态，单路(全局)会话不受影响；实时新行同样按路取协议与 ansi 状态
async function testDualLaneParseIsolation() {
	const { context, rows, api } = renderHarness()
	const session = {
		deviceUid: null, baseCode: null,
		resetBase() { this.baseCode = null },
		setBase(code) { this.baseCode = code },
		snapshot() { return { deviceUid: this.deviceUid, baseCode: this.baseCode } },
		restore(s) { this.deviceUid = s.deviceUid; this.baseCode = s.baseCode },
	}
	let ansiSeq = 0
	Object.assign(context, {
		setTimeout: fn => fn(), PARSE_RERENDER_SYNC_ROWS: 150, PARSE_RERENDER_SLICE_MS: 12, rerenderGen: 0,
		logOptionsSingle: { autoScroll: false }, logOptionsDual: { autoScroll: false },
		AnsiUp: function () { const id = ++ansiSeq; this.ansi_to_html = t => 'ansi' + id + ':' + t },
		skParseFrame: data => { if (data[0] === 0xB0) session.setBase(data[1]); return {} },
		laneProto: { A: 'pa', B: 'pb' },
		protoById: {
			pa: { logView: () => ({ title: 'PA base' + session.baseCode }) },
			pb: { logView: () => ({ title: 'PB base' + session.baseCode }) },
		},
	})
	context.window._activeProtocol = 'top'
	context.window.skSession = session
	session.setBase(9)
	function makeRow(sid, hex) {
		const body = { innerHTML: '' }
		return { attrs: { 'data-hex': hex, 'data-dir': 'rx', 'data-sid': sid }, classList: { contains: c => c === 'log-row' },
			getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }, querySelector: () => body, body }
	}
	const children = [makeRow('A', 'B0 01'), makeRow('B', '01 02'), makeRow('A', '01 02'), makeRow('B', 'B0 02'), makeRow('B', '01 02'), makeRow('A', '01 02')]
	const box = { children, get lastElementChild() { return children[children.length - 1] } }
	context.SerialHub.getLogContainerFor = m => (m === 'dual' ? box : null)
	const vmApi = vm.runInContext('({ rerenderLogBodies })', context)
	vmApi.rerenderLogBodies(box, 'parse')
	const titles = children.map(r => (/PA base\w+|PB base\w+/.exec(r.body.innerHTML) || [''])[0])
	assert.deepEqual(titles, ['PA base1', 'PB basenull', 'PA base1', 'PB base2', 'PB base2', 'PA base1'])
	assert.equal(session.baseCode, 9, '单路(全局)会话不被双路重放改动')
	assert.equal(context.window._activeProtocol, 'top', '重放结束顶栏协议还原')
	assert.equal(context.laneLive.A.sess.baseCode, 1)
	assert.equal(context.laneLive.B.sess.baseCode, 2)

	// 实时新行：B 路用 B 的协议与基准，ansi 状态两路各一份
	rows.length = 0
	context.logType = 'ansi&parse'
	api.addLog(Uint8Array.of(0x41), true, new Date(1), 'B')
	api.addLog(Uint8Array.of(0x42), true, new Date(2), 'A')
	api.addLog(Uint8Array.of(0x43), true, new Date(3), 'B')
	assert.ok(rows[0].innerHTML.includes('PB base2'), rows[0].innerHTML)
	assert.ok(rows[1].innerHTML.includes('PA base1'), rows[1].innerHTML)
	const ansiId = html => /ansi(\d+):/.exec(html)[1]
	assert.notEqual(ansiId(rows[0].innerHTML), ansiId(rows[1].innerHTML))
	assert.equal(ansiId(rows[0].innerHTML), ansiId(rows[2].innerHTML))
	assert.equal(session.baseCode, 9)

	// B 路重新连接清空 B 的基准，A 不受影响
	vm.runInContext('resetLaneParseSession("B")', context)
	api.addLog(Uint8Array.of(0x44), true, new Date(4), 'B')
	api.addLog(Uint8Array.of(0x45), true, new Date(5), 'A')
	assert.ok(rows[3].innerHTML.includes('PB basenull'), rows[3].innerHTML)
	assert.ok(rows[4].innerHTML.includes('PA base1'), rows[4].innerHTML)
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
	assert.equal(a.seg.children.some(c => c.className === 'sb-line-err'), false)
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
		assert.ok(h.logs.find(x => x.msg.includes('接收暂缓')).msg.includes(kind === 'done' ? '接收流关闭 21 次' : '读取错误 21 次'))
		// 线路类错误直接忽略，不出红色错误；流关闭仍是红色错误
		assert.equal(h.logs.some(x => x.msg.includes('接收流已关闭')), kind === 'done')
		assert.equal(h.logs.some(x => x.msg.includes('串口读取错误')), false)
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
	await testLineErrorQuiet()
	await testLineGlitchMeta()
	await testPackGlitch()
	testHostProtoPack()
	await testLogRendering()
	await testParseRerenderIsolation()
	await testDualLaneParseIsolation()
	await testStatusBar()
	console.log('serial read recovery: passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
