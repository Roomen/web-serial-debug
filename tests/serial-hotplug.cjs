// Run: node tests/serial-hotplug.cjs — synthetic data only.
// 覆盖: 串口热插拔(navigator.serial 的 connect / disconnect)对会话的认领。关着的口不能被随后插入的别的设备顶替，
// 重插得到的新 SerialPort 对象接回原会话(双路按型号各回各路)，空会话认领新口后开关键要显示
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')

function slice(startMark, endMark) {
	const start = source.indexOf(startMark)
	const end = source.indexOf(endMark, start)
	assert.ok(start > 0 && end > start, 'common.js 锚点不见了: ' + startMark.trim())
	return source.slice(start, end)
}
// SerialHub 会话对象，到对象字面量结束为止
const hubStart = source.indexOf('\tfunction makeSerialSession(')
const hubEnd = source.indexOf('\n\t}\n', source.indexOf('\tconst SerialHub = {'))
assert.ok(hubStart > 0 && hubEnd > hubStart, 'common.js 的 SerialHub 段不见了')
const hubSrc = source.slice(hubStart, hubEnd + 3)
// 热插拔事件处理，到 serialStatuChange 之前
const hotplugSrc = slice("\tnavigator.serial.addEventListener('connect'", '\tfunction serialStatuChange(')
// connect 之前紧挨着的声明(如已拔出口的记录)也要带上：从上一个函数结束处开始
const preStart = source.lastIndexOf('\n\t}\n', source.indexOf("\tnavigator.serial.addEventListener('connect'")) + 3
const preSrc = source.slice(preStart, source.indexOf("\tnavigator.serial.addEventListener('connect'"))

let nextId = 0
function makePort(vid, pid) {
	return { id: ++nextId, open() {}, getInfo() { return { usbVendorId: vid, usbProductId: pid } } }
}

function harness(mode) {
	const listeners = {}
	const events = []
	const ctx = {
		window: {},
		document: { getElementById() { return null } },
		navigator: { serial: { addEventListener(type, fn) { listeners[type] = fn } } },
		pinSid: null,
		readGenBySid: { S: 0, A: 0, B: 0 },
		rxWatch() { return { lastRxAt: 0, backoff: 0 } },
		WeakSet, Promise,
	}
	vm.createContext(ctx)
	vm.runInContext(hubSrc + '\nthis.SerialHub = SerialHub', ctx)
	const hub = ctx.SerialHub
	hub.mode = mode
	Object.assign(ctx, {
		serialEventPort: (e) => e.port,
		isBluetoothSerialPort: () => false,
		isBluAnalyzerPort: () => false,
		getPortIdentityKey: () => Promise.resolve(null),
		refreshPortDisplayNames() {},
		getPortDisplayName: (p) => 'port' + p.id,
		sidName: (sid) => sid,
		addLogErr(msg, sid) { events.push(['log', sid, msg]) },
		updateOpenButton(sid) { events.push(['button', sid]) },
		openSerial(sid) {
			hub.setOpen(sid, true)
			hub.setManualClose(sid, false)
			events.push(['open', sid, hub.getPort(sid).id])
			return Promise.resolve(true)
		},
		closeSerial(sid) {
			hub.setOpen(sid, false)
			return Promise.resolve()
		},
	})
	vm.runInContext(preSrc + hotplugSrc, ctx)
	assert.ok(listeners.connect && listeners.disconnect, '热插拔监听没有挂上')
	const api = {
		hub, events,
		// 用户选口并打开(与 selectPortFor + openSerial 的结果一致)
		openBy(sid, port) {
			hub.setPort(sid, port)
			hub.setOpen(sid, true)
			hub.setManualClose(sid, false)
		},
		closeByUser(sid) {
			hub.setManualClose(sid, true)
			hub.setOpen(sid, false)
		},
		async plug(port) {
			listeners.connect({ port })
			await new Promise((r) => setImmediate(r))
		},
		async unplug(port) {
			await listeners.disconnect({ port })
		},
	}
	return api
}

const tests = []
function test(name, fn) { tests.push([name, fn]) }

test('单路：关着的口不被随后插入的另一台设备顶替', async () => {
	const h = harness('single')
	const x = makePort(0x1a86, 0x7523)
	h.openBy('S', x)
	h.closeByUser('S')
	await h.plug(makePort(0x0403, 0x6001))
	assert.equal(h.hub.getPort('S'), x)
	await h.plug(makePort(0x1a86, 0x7523))
	assert.equal(h.hub.getPort('S'), x, '同型号的第二台设备也不能顶替')
	assert.equal(h.events.filter((e) => e[0] === 'open').length, 0)
})

test('单路：开着时拔出，重插的新对象接回并自动重开', async () => {
	const h = harness('single')
	const x = makePort(0x1a86, 0x7523)
	h.openBy('S', x)
	await h.unplug(x)
	assert.equal(h.hub.isOpen('S'), false)
	const x2 = makePort(0x1a86, 0x7523)
	await h.plug(x2)
	assert.equal(h.hub.getPort('S'), x2)
	assert.deepEqual(h.events.filter((e) => e[0] === 'open'), [['open', 'S', x2.id]])
})

test('单路：关着时拔出再插，接回但不自动开', async () => {
	const h = harness('single')
	const x = makePort(0x1a86, 0x7523)
	h.openBy('S', x)
	h.closeByUser('S')
	await h.unplug(x)
	const x2 = makePort(0x1a86, 0x7523)
	await h.plug(x2)
	assert.equal(h.hub.getPort('S'), x2)
	assert.equal(h.events.filter((e) => e[0] === 'open').length, 0)
})

test('单路：拔出后插入的是别的型号，不接到原会话', async () => {
	const h = harness('single')
	const x = makePort(0x1a86, 0x7523)
	h.openBy('S', x)
	await h.unplug(x)
	await h.plug(makePort(0x0403, 0x6001))
	assert.equal(h.hub.getPort('S'), x)
	assert.equal(h.events.filter((e) => e[0] === 'open').length, 0)
})

test('单路：同一对象重新出现(重插后对象未换)照旧接回重开', async () => {
	const h = harness('single')
	const x = makePort(0x1a86, 0x7523)
	h.openBy('S', x)
	await h.unplug(x)
	await h.plug(x)
	assert.deepEqual(h.events.filter((e) => e[0] === 'open'), [['open', 'S', x.id]])
})

test('单路：空会话认领新插入的口，并刷新开关键', async () => {
	const h = harness('single')
	const y = makePort(0x0403, 0x6001)
	await h.plug(y)
	assert.equal(h.hub.getPort('S'), y)
	assert.ok(h.events.some((e) => e[0] === 'button' && e[1] === 'S'))
	assert.equal(h.events.filter((e) => e[0] === 'open').length, 0, '从未打开过的会话不自动开')
})

test('双路：两路都拔出，B 的设备先回来也回到 B', async () => {
	const h = harness('dual')
	const a = makePort(0x1a86, 0x7523)
	const b = makePort(0x0403, 0x6001)
	h.openBy('A', a)
	h.openBy('B', b)
	await h.unplug(a)
	await h.unplug(b)
	const b2 = makePort(0x0403, 0x6001)
	await h.plug(b2)
	assert.equal(h.hub.getPort('B'), b2)
	assert.equal(h.hub.getPort('A'), a)
	const a2 = makePort(0x1a86, 0x7523)
	await h.plug(a2)
	assert.equal(h.hub.getPort('A'), a2)
	assert.deepEqual(h.events.filter((e) => e[0] === 'open'), [['open', 'B', b2.id], ['open', 'A', a2.id]])
})

test('双路：A 有口关着、B 空着，新设备进 B 不顶掉 A', async () => {
	const h = harness('dual')
	const a = makePort(0x1a86, 0x7523)
	h.openBy('A', a)
	h.closeByUser('A')
	const y = makePort(0x0403, 0x6001)
	await h.plug(y)
	assert.equal(h.hub.getPort('A'), a)
	assert.equal(h.hub.getPort('B'), y)
})

test('双路：不认领到隐藏的单路会话', async () => {
	const h = harness('dual')
	h.openBy('A', makePort(1, 1))
	h.openBy('B', makePort(2, 2))
	await h.plug(makePort(3, 3))
	assert.equal(h.hub.getPort('S'), null)
})

;(async () => {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log('ok   ' + name)
		} catch (e) {
			failed++
			console.log('FAIL ' + name + '\n     ' + (e && e.message))
		}
	}
	console.log(failed ? failed + ' failed' : 'all ' + tests.length + ' passed')
	if (failed) process.exitCode = 1
})()
