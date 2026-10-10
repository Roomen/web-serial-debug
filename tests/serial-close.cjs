// Synthetic streams, bytes and timers only: no real device identities or captured logs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
const settle = () => new Promise(resolve => setImmediate(resolve))
function section(start, end) {
	const a = source.indexOf(start)
	const b = source.indexOf(end, a)
	assert.ok(a >= 0 && b > a, 'production source extraction anchors exist')
	return source.slice(a, b)
}
function deferred() {
	let resolve, reject
	const promise = new Promise((a, b) => { resolve = a; reject = b })
	return { promise, resolve, reject }
}
function harness() {
	let now = 100000, timerId = 0
	const timers = new Map(), logs = [], errors = [], statuses = [], wants = []
	const sessions = Object.fromEntries(['S', 'A', 'B'].map(sid => [sid, {
		open: true, opening: false, manualClose: true, port: null, reader: null,
		writer: null, writeTask: null, releaseTask: null, packBuf: [],
		packTimer: null, packStartTime: null, packGlitch: false, sekWaitStart: null, txBytes: 0
	}]))
	const hub = {
		mode: 'single', activeSendId: 'S', activeSendPhys: () => 'S', uiSid: sid => sid, allPhys: () => ['S', 'A', 'B'], _sess: sid => sessions[sid],
		isManualClose: sid => sessions[sid].manualClose,
		isReleaseFailed: sid => sessions[sid].releaseFailed,
		setManualClose: (sid, v) => { sessions[sid].manualClose = v },
		getStats: sid => sessions[sid], resetStats: () => {}, takePackGlitch: sid => {
			const v = sessions[sid].packGlitch; sessions[sid].packGlitch = false; return v
		}
	}
	for (const [name, key] of Object.entries({ Port: 'port', Reader: 'reader', Open: 'open', Opening: 'opening', PackBuf: 'packBuf', PackTimer: 'packTimer', PackStartTime: 'packStartTime', SekWaitStart: 'sekWaitStart' })) {
		hub['get' + name] = sid => sessions[sid][key]
		hub['is' + name] = sid => sessions[sid][key]
		hub['set' + name] = (sid, v) => { sessions[sid][key] = v }
	}
	const recovered = []
	const context = vm.createContext({
		SerialHub: hub, window: {}, Uint8Array, Date,
		setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, due: now + ms }); return id },
		clearTimeout: id => timers.delete(id),
		readGenBySid: { S: 0, A: 0, B: 0 }, resetRxWatch: () => {},
		addLog: (data, rx, time, sid, glitch) => logs.push({ data: Array.from(data), rx, time, sid, glitch }),
		addLogErr: (msg, sid) => errors.push({ msg, sid }),
		addLogErrSafe: (msg, sid) => errors.push({ msg, sid }),
		serialStatuChange: (state, sid) => statuses.push({ state, sid }), updateOpenButton: () => {},
		releaseWakeLock: () => {}, requestWakeLock: () => {},
		setSerialWantOpen: (v, sid) => wants.push({ v, sid }), setSerialWantPortKey: () => {},
		refreshActiveSendSButton: () => {}, showToast: () => {}, showMsg: () => {},
		isAllZero: data => data.every(v => v === 0), isRowLogType: () => true, getLogTypeForSid: () => 'hex',
		toolOptions: { addCR: false, addLF: false }, flushPendingRx: () => {},
		isBluetoothSerialPort: () => false, isBluAnalyzerPort: () => false, findPortConflict: () => null,
		collectSerialParamsFromUI: () => ({ baudRate: 9600 }), readSerialOptions: () => ({}),
		laneOptions: { A: {}, B: {} }, SERIAL_OPTIONS_KEY: 'synthetic-options',
		resetLaneParseSession: () => {}, sessionResetSeq: { S: 0, A: 0, B: 0 },
		getPortIdentityKey: async () => null, localStorage: { setItem: () => {} }, persistLaneOptions: () => {},
		recoverDeadReadLoop: async sid => { recovered.push(sid) }, rxWatch: () => ({}), reopenAttemptBySid: {}, readData: async () => {}
	})
	vm.runInContext(
		section('\tfunction portHeldByOther(', '\tfunction randAliasId(') +
		section('\tasync function releasePort(sid) {', '\t//页面销毁时释放串口句柄') +
		section('\tasync function closeSerial(sid)', '\tfunction chipElFor(sid)') +
		section('\tasync function writeData(data,', '\t// 接收流异常先尝试重建') +
		section('\tasync function handleToggleClick(sid)', '\tserialToggle.addEventListener') +
		section('\tfunction flushSerialPack(', '\t// 发送前先把本口') +
		'\nglobalThis.api = { releasePort, closeSerial, openSerial, writeData, writeTermBytes, handleToggleClick }', context)
	async function advance(ms) {
		const end = now + ms
		await settle()
		while (true) {
			const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0]
			if (!next || next[1].due > end) break
			now = next[1].due; timers.delete(next[0]); next[1].fn(); await settle()
		}
		now = end; await settle()
	}
	return { recovered, sessions, hub, logs, errors, statuses, wants, timers, api: context.api, advance }
}
async function testFlushAndIsolation() {
	for (const bytes of [[0x68, 0x01], [0, 0]]) {
		const h = harness(), s = h.sessions.A, b = h.sessions.B
		const timestamp = new Date(1234)
		s.packBuf = bytes.slice(); s.packStartTime = timestamp; s.packGlitch = true; s.sekWaitStart = 123
		b.packBuf = [0x42]; b.packStartTime = new Date(5678); b.packGlitch = true
		let closes = 0
		s.port = { close: async () => { closes++ } }
		assert.equal(await h.api.closeSerial('A'), true)
		assert.equal(closes, 1)
		assert.equal(h.logs.length, 1)
		assert.deepEqual(h.logs[0], { data: bytes, rx: true, time: timestamp, sid: 'A', glitch: bytes[0] === 0 })
		assert.equal(s.packBuf.length, 0); assert.equal(s.packStartTime, null); assert.equal(s.packGlitch, false)
		assert.equal(s.sekWaitStart, null)
		assert.deepEqual(b.packBuf, [0x42]); assert.equal(b.open, true); assert.equal(b.packGlitch, true)
		await h.api.releasePort('A')
		assert.equal(h.logs.length, 1, 'repeat release does not repeat final RX')
	}
}
async function testRejectedClose() {
	const h = harness()
	h.sessions.S.port = { close: async () => { throw new Error('synthetic close refusal') } }
	assert.equal(await h.api.closeSerial('S'), false)
	assert.equal(h.sessions.S.open, false)
	assert.ok(h.statuses.some(v => v.state === 'close-failed' && v.sid === 'S'))
	assert.ok(h.errors.length > 0, 'close failure has visible error')
	assert.equal(h.wants.length, 0, 'failed close preserves reconnect intent')
	h.sessions.S.port.close = async () => {}
	await h.api.handleToggleClick('S')
	assert.equal(h.sessions.S.opening, false)
	assert.equal(h.sessions.S.releaseFailed, false)
	assert.equal(h.sessions.S.open, false)
	assert.ok(h.statuses.some(v => v.state === false))
}
async function testHangingClose() {
	const h = harness(), gate = deferred()
	let closes = 0, opens = 0
	h.sessions.S.port = { close: () => { closes++; return gate.promise }, open: async () => { opens++ } }
	const closing = h.api.handleToggleClick('S')
	await settle()
	assert.equal(h.sessions.S.opening, true)
	await h.advance(10000)
	await closing
	assert.equal(h.sessions.S.opening, false)
	assert.equal(h.sessions.S.open, false)
	assert.ok(h.sessions.S.releaseTask, 'pending OS close remains tracked after timeout')
	h.sessions.S.open = false
	const opening = h.api.openSerial('S')
	await h.advance(10000)
	assert.equal(await opening, false)
	assert.equal(closes, 1, 'retry joins pending OS close instead of starting another')
	assert.equal(opens, 0)
	gate.resolve(); await settle()
	assert.equal(h.sessions.S.releaseTask, null)
	assert.equal(await h.api.openSerial('S'), true)
	assert.equal(opens, 1)
}
async function testHangingReader() {
	const h = harness(), gate = deferred()
	let released = 0, closes = 0
	h.sessions.S.reader = { cancel: () => gate.promise, releaseLock: () => { released++ } }
	h.sessions.S.port = { close: async () => { closes++ } }
	const closing = h.api.handleToggleClick('S')
	await settle()
	assert.equal(h.sessions.S.opening, true)
	await h.advance(10000)
	await closing
	assert.equal(h.sessions.S.opening, false)
	assert.ok(released > 0, 'reader lock is released even when cancellation hangs')
	gate.resolve(); await settle()
	assert.ok(closes <= 1)
}
async function testPendingWrite() {
	for (const terminal of [false, true]) {
		const h = harness(), write = deferred(), order = []
		let locked = false
		const writer = {
			write: () => { order.push('write'); return write.promise },
			abort: async () => { order.push('abort'); write.reject(new Error('synthetic cancellation')) },
			releaseLock: () => { order.push('unlock'); locked = false }
		}
		h.sessions.S.port = { writable: { getWriter: () => { locked = true; return writer } },
			close: async () => { assert.equal(locked, false); order.push('close') } }
		const writing = terminal ? h.api.writeTermBytes('S', Uint8Array.of(1)) : h.api.writeData(Uint8Array.of(1), 'S')
		await settle()
		assert.equal(h.sessions.S.writer, writer)
		assert.ok(h.sessions.S.writeTask)
		assert.equal(await h.api.closeSerial('S'), true)
		await writing
		assert.ok(order.indexOf('abort') < order.indexOf('unlock'))
		assert.ok(order.indexOf('unlock') < order.indexOf('close'))
		assert.equal(h.sessions.S.writer, null)
		assert.equal(h.logs.filter(v => !v.rx).length, 0)
	}
}
async function testLateSuccessfulWrite() {
	const h = harness(), gate = deferred()
	let unlocked = false
	h.sessions.S.port = { writable: { getWriter: () => ({ write: () => gate.promise, abort: async () => {}, releaseLock: () => { unlocked = true } }) }, close: async () => {} }
	const writing = h.api.writeData(Uint8Array.of(0x41), 'S')
	await settle()
	const closing = h.api.closeSerial('S')
	await h.advance(10000)
	assert.equal(await closing, false)
	gate.resolve(); await writing; await settle()
	assert.equal(unlocked, true)
	assert.equal(h.logs.filter(v => !v.rx).length, 0, 'invalidated write cannot append TX after close')
	assert.equal(h.sessions.S.txBytes, 0)
}
async function testWriteNetworkErrorRecovers() {
	// 写入遇到 NetworkError(设备拔出)要触发读循环死亡同款恢复；其它错误不触发
	for (const [name, expect] of [['NetworkError', 1], ['AbortError', 0]]) {
		const h = harness()
		h.sessions.S.port = { writable: { getWriter: () => ({ write: async () => { const e = new Error('x'); e.name = name; throw e }, releaseLock: () => {} }) }, close: async () => {} }
		await h.api.writeData(Uint8Array.of(1), 'S')
		assert.equal(h.recovered.length, 0, name + ': 拔线时 disconnect 晚于写入失败，确认窗口内不恢复')
		await h.advance(600)
		assert.equal(h.recovered.length, expect, name)
	}
	{
		// 确认窗口内 disconnect 已把这一路关掉：不再对拔走的口重开
		const h = harness()
		h.sessions.S.port = { writable: { getWriter: () => ({ write: async () => { const e = new Error('x'); e.name = 'NetworkError'; throw e }, releaseLock: () => {} }) }, close: async () => {} }
		await h.api.writeData(Uint8Array.of(1), 'S')
		h.sessions.S.open = false
		await h.advance(600)
		assert.equal(h.recovered.length, 0, 'closed before confirm')
	}
	const h = harness()
	h.sessions.S.port = { writable: { getWriter: () => ({ write: async () => { const e = new Error('x'); e.name = 'NetworkError'; throw e }, releaseLock: () => {} }) }, close: async () => {} }
	await assert.rejects(h.api.writeData(Uint8Array.of(1), 'S', null, { throwOnError: true }))
	await h.advance(600)
	assert.equal(h.recovered.length, 1, 'throwOnError 路径同样触发恢复')
}
async function testRealWritableStream() {
	const h = harness(), gate = deferred()
	const writable = new WritableStream({ write: () => gate.promise, abort: () => {} })
	let closes = 0
	h.sessions.S.port = { writable, close: async () => { assert.equal(writable.locked, false); closes++ } }
	const writing = h.api.writeData(Uint8Array.of(0x41), 'S')
	await settle()
	const closing = h.api.closeSerial('S')
	await settle()
	gate.resolve()
	await writing
	assert.equal(await closing, true)
	assert.equal(closes, 1)
	assert.equal(writable.locked, false)
	assert.equal(h.logs.filter(v => !v.rx).length, 0)
}

async function testSharedPortAndStuckWrite() {
	// 页面退出时多会话可能仍记着同一个口，只允许一笔 close，且不能互相跳过导致漏关。
	const h = harness(), gate = deferred()
	let closes = 0
	const port = { close: () => { closes++; return gate.promise } }
	h.sessions.S.port = port
	h.sessions.A.port = port
	h.sessions.S.open = false
	h.sessions.A.open = false
	const first = h.api.releasePort('S')
	const second = h.api.releasePort('A')
	await settle()
	assert.equal(closes, 1)
	gate.resolve()
	assert.equal(await first, true)
	assert.equal(await second, true)
	// 卡住的写入也不能阻止读锁被释放。
	const stuck = harness(), write = deferred(), abort = deferred()
	let readerReleased = false
	stuck.sessions.S.reader = { cancel: async () => {}, releaseLock: () => { readerReleased = true } }
	stuck.sessions.S.port = { writable: { getWriter: () => ({ write: () => write.promise, abort: () => abort.promise, releaseLock: () => {} }) }, close: async () => {} }
	const writing = stuck.api.writeData(Uint8Array.of(1), 'S')
	const closing = stuck.api.handleToggleClick('S')
	await stuck.advance(1500)
	await closing
	assert.equal(readerReleased, true)
	assert.equal(stuck.sessions.S.opening, false)
	write.resolve()
	abort.resolve()
	await writing
	await settle()
	assert.equal(stuck.sessions.S.releaseTask, null)
}
;(async () => {
	await testFlushAndIsolation()
	await testRejectedClose()
	await testHangingClose()
	await testHangingReader()
	await testPendingWrite()
	await testLateSuccessfulWrite()
	await testWriteNetworkErrorRecovers()
	await testRealWritableStream()
	await testSharedPortAndStuckWrite()
	console.log('serial-close: all synthetic close regressions passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
