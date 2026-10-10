// Synthetic timer/write backpressure and log budget tests; no real ports or logs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync(require('node:path').join(__dirname, '../js/common.js'), 'utf8')

async function main() {
	const timers = new Map()
	let seq = 0, sends = 0, resolveSend
	const port = { writable: { locked: false } }
	const ctx = vm.createContext({
		toolOptions: { loopSend: true, loopSendTime: 1 }, DEFAULT_TOOL_OPTIONS: { loopSendTime: 1000 },
		LOOP_SEND_MIN_MS: 10, serialloopSendTimer: null, loopSendBusy: false,
		SerialHub: { activeSendPhys: () => 'S', isOpen: () => true, getPort: () => port },
		setInterval(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id },
		clearInterval(id) { timers.delete(id) }, addLogErr() {},
		send() { sends++; return new Promise(resolve => { resolveSend = resolve }) }
	})
	const a = source.indexOf('\tfunction normalizeLoopSendTime(')
	const b = source.indexOf('\n\t//日志纯文本', a)
	vm.runInContext(source.slice(a, b) + '\nglobalThis.api = { resetLoopSend, normalizeLoopSendTime }', ctx)
	for (const value of ['', null, 'invalid']) assert.equal(ctx.api.normalizeLoopSendTime(value), 1000)
	assert.equal(ctx.api.normalizeLoopSendTime(-5), 10)
	assert.equal(ctx.api.normalizeLoopSendTime('9999999999999'), 2147483647)
	ctx.api.resetLoopSend()
	let timer = [...timers.values()][0]
	assert.equal(timer.ms, 10)
	timer.fn()
	for (let i = 0; i < 100; i++) timer.fn()
	assert.equal(sends, 1, 'slow writes must not trigger overlapping loop sends')
	ctx.api.resetLoopSend()
	timer = [...timers.values()][0]
	timer.fn()
	assert.equal(sends, 1, 'changing interval while a write is pending must keep backpressure')
	resolveSend()
	await new Promise(resolve => setImmediate(resolve))
	port.writable.locked = true
	timer.fn()
	assert.equal(sends, 1, 'manual/protocol writer must not be raced by loop send')
	port.writable.locked = false
	timer.fn()
	assert.equal(sends, 2)
	resolveSend()
	await new Promise(resolve => setImmediate(resolve))

	const children = []
	const container = {
		children, scrollTop: 0, clientHeight: 10,
		get childElementCount() { return children.length },
		get firstElementChild() { return children[0] || null },
		get firstChild() { return children[0] || null },
		get scrollHeight() { return children.length * 10 },
		appendChild(n) { children.push(n) },
		removeChild(n) { children.splice(children.indexOf(n), 1) }
	}
	const row = hex => ({
		getAttribute(k) { return k === 'data-hex' ? hex : null },
		get nextElementSibling() { return children[children.indexOf(this) + 1] || null }
	})
	const microtasks = [], disposed = []
	const opts = { maxLogRows: 100, autoScroll: true }
	Object.assign(ctx, {
		logHexStats: new WeakMap(), LOG_HEX_CHARS_MAX: 12, logLayoutPending: new Map(),
		logOptionsSingle: opts, logOptionsDual: opts,
		queueMicrotask: fn => microtasks.push(fn), schedulePersistLogs() {},
		disposeSeriesCharts: n => disposed.push(n),
		SerialHub: { logModeOf: () => 'single', getLogContainer: () => container, getLogContainerFor: () => container }
	})
	const ta = source.indexOf('\tfunction rowHexChars('), tb = source.indexOf('\n\tfunction isPageReload(', ta)
	const aa = source.indexOf('\tfunction appendLogNode('), ab = source.indexOf('\n\t//字节数组转16进制', aa)
	vm.runInContext(source.slice(ta, tb) + source.slice(aa, ab) + '\nglobalThis.logs = { appendLogNode, trimLogRows }', ctx)
	for (let i = 0; i < 5; i++) ctx.logs.appendLogNode(row('AA BB'), 'S')
	assert.equal(microtasks.length, 1, 'one read yielding multiple lines must schedule one layout flush')
	microtasks.shift()()
	assert.equal(children.length, 2, 'byte budget must trim history even below row cap')
	assert.equal(disposed.length, 3, 'removed chart-bearing rows must release observers')
	assert.equal(container.scrollTop, 10)
	children.length = 0
	ctx.logs.appendLogNode(row('CC'), 'S')
	microtasks.shift()()
	assert.equal(children.length, 1, 'clearing then receiving must recompute byte accounting')
	console.log('serial-resources: ok')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
