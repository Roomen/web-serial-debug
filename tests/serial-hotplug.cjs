// Run: node tests/serial-hotplug.cjs — synthetic data only.
// 覆盖: 串口热插拔(SerialAdapter 的 connect / disconnect)对会话的认领。关着的口不能被随后插入的别的设备顶替，
// 重插得到的新 SerialPort 对象接回原会话(双路按型号各回各路)，空会话认领新口后开关键要显示；
// 口带路径/序列号(原生后端)时按强身份接回(序列号优先、其次路径)，对不上(同型号另一台)的会话不认领，
// 两边都没有强身份(网页版只有 VID/PID)照旧按 VID/PID；reload 自动重连按已存身份找口(findPortByKey)：
// 强身份排异后序列号 → 路径，唯一候选才自动连，歧义与找不到一样不连
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
const hotplugSrc = slice("\tSerialAdapter.addEventListener('connect'", '\tfunction serialStatuChange(')
// connect 之前紧挨着的声明(如已拔出口的记录)也要带上：从上一个函数结束处开始
const preStart = source.lastIndexOf('\n\t}\n', source.indexOf("\tSerialAdapter.addEventListener('connect'")) + 3
const preSrc = source.slice(preStart, source.indexOf("\tSerialAdapter.addEventListener('connect'"))
// 别名/身份段：findRebindSession 用 syncPortIdentity + strongIdentity 判强身份，锚点与 port-alias.cjs 相同
const aliasStart = source.indexOf('\t// ===== 串口设备别名 v2')
const aliasEnd = source.indexOf('\t/** 检查端口是否有持久化 key', aliasStart)
assert.ok(aliasStart > 0 && aliasEnd > aliasStart, 'common.js 别名段的锚点不见了')
const aliasSrc = source.slice(aliasStart, aliasEnd)
// reload 自动重连按已存身份找口，按锚点注释截取(别删)
const reloadStart = source.indexOf('// ===== reload 自动重连按已存身份找口（tests/serial-hotplug.cjs 按此锚点截取，别删）')
const reloadEnd = source.indexOf('// ===== reload 自动重连按已存身份找口到此为止（别删）', reloadStart)
assert.ok(reloadStart > 0 && reloadEnd > reloadStart, 'common.js reload 找口段的锚点不见了')
const reloadSrc = source.slice(reloadStart, reloadEnd)

let nextId = 0
function makePort(vid, pid) {
	return { id: ++nextId, open() {}, getInfo() { return { usbVendorId: vid, usbProductId: pid } } }
}
// 原生后端风格的口：getInfo 直接带路径与序列号(桌面客户端)
function nativePort(desc) {
	return { id: ++nextId, open() {}, getInfo() { return Object.assign({ usbVendorId: 0x10c4, usbProductId: 0xea60, productName: 'SYNTHETIC USB UART' }, desc) } }
}

function harness(mode) {
	const listeners = {}
	const events = []
	const ctx = {
		window: {},
		document: { getElementById() { return null } },
		SerialAdapter: { addEventListener(type, fn) { listeners[type] = fn } },
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		pinSid: null,
		readGenBySid: { S: 0, A: 0, B: 0 },
		rxWatch() { return { lastRxAt: 0, backoff: 0 } },
		WeakSet, Map, Promise,
	}
	vm.createContext(ctx)
	vm.runInContext(hubSrc + '\n' + aliasSrc + '\nthis.SerialHub = SerialHub', ctx)
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

// reload 自动重连按已存身份找口：身份 keys 走真实的 resolvePortIdentity(别名段，与页面同一套)，
// 串口表 getPorts / 已存身份 getSerialWantPortKey 打桩；identKeysOverride 可手工指定已解析的 keys
function reloadHarness(ports, identKeysOverride) {
	let want = null
	const ctx = {
		ports,
		SerialAdapter: { getPorts: async () => ports.slice(), getUsbDevices: async () => [] },
		getSerialWantPortKey: () => want,
		WeakSet, Map, Promise, console,
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	}
	vm.createContext(ctx)
	vm.runInContext(
		aliasSrc + '\n' +
		(identKeysOverride ? 'globalThis.identKeys = ' + JSON.stringify(identKeysOverride) + '\n' : '') +
		reloadSrc +
		'\nglobalThis.ready = (async function () {' +
		'\n\tif (!globalThis.identKeys) {' +
		'\n\t\tconst keys = []' +
		'\n\t\tfor (let i = 0; i < ports.length; i++) {' +
		'\n\t\t\tconst ident = await resolvePortIdentity(ports[i])' +
		'\n\t\t\tkeys.push(ident ? ident.keys : [])' +
		'\n\t\t}' +
		'\n\t\tglobalThis.identKeys = keys' +
		'\n\t}' +
		'\n\tglobalThis.keysOf = function (p) { return resolvePortIdentity(p).then(function (x) { return x.keys }) }' +
		'\n\tglobalThis.match = function (sid) { return findPortByKey(sid) }' +
		'\n})()',
		ctx
	)
	return {
		ctx,
		ready: ctx.ready,
		setWant(keys) { want = keys },
		keysOf(p) { return ctx.keysOf(p) },
		match(sid) { return ctx.match(sid) },
	}
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

test('双路：两台同型号原生设备(序列号不同)都拔出，B 的设备先插回也回到 B', async () => {
	const h = harness('dual')
	const x = nativePort({ path: 'COM12', serialNumber: 'SYN-X' })
	const y = nativePort({ path: 'COM11', serialNumber: 'SYN-Y' })
	h.openBy('A', x)
	h.openBy('B', y)
	await h.unplug(x)
	await h.unplug(y)
	const y2 = nativePort({ path: 'COM11', serialNumber: 'SYN-Y' })
	await h.plug(y2)
	assert.equal(h.hub.getPort('A'), x)
	assert.equal(h.hub.getPort('B'), y2, '序列号对上 B 的设备回 B，不串到 A')
	assert.deepEqual(h.events.filter((e) => e[0] === 'open'), [['open', 'B', y2.id]])
})

test('单路：同型号另一台(序列号不同)插回，不认领强身份对不上的会话', async () => {
	const h = harness('single')
	const x = nativePort({ path: 'COM12', serialNumber: 'SYN-X' })
	h.openBy('S', x)
	await h.unplug(x)
	const y = nativePort({ path: 'COM11', serialNumber: 'SYN-Y' })
	await h.plug(y)
	assert.equal(h.hub.getPort('S'), x, '序列号对不上的是另一台，不能接回')
	assert.equal(h.events.filter((e) => e[0] === 'open').length, 0)
})

test('单路：同设备换了 USB 口(路径变、序列号同)，按序列号接回', async () => {
	const h = harness('single')
	const x = nativePort({ path: 'COM12', serialNumber: 'SYN-X' })
	h.openBy('S', x)
	await h.unplug(x)
	const x2 = nativePort({ path: 'COM14', serialNumber: 'SYN-X' })
	await h.plug(x2)
	assert.equal(h.hub.getPort('S'), x2)
	assert.deepEqual(h.events.filter((e) => e[0] === 'open'), [['open', 'S', x2.id]])
})

test('单路：同型号都没序列号、路径不同的另一台插回，不认领', async () => {
	const h = harness('single')
	const x = nativePort({ path: 'COM12' })
	h.openBy('S', x)
	await h.unplug(x)
	const y = nativePort({ path: 'COM11' })
	await h.plug(y)
	assert.equal(h.hub.getPort('S'), x, '路径对不上又没有序列号：按另一台处理')
	assert.equal(h.events.filter((e) => e[0] === 'open').length, 0)
})

test('双路：网页版只有 VID/PID 的口，两台同型号都拔出后先插回的照旧进 A', async () => {
	const h = harness('dual')
	const a = makePort(0x1a86, 0x7523)
	const b = makePort(0x1a86, 0x7523)
	h.openBy('A', a)
	h.openBy('B', b)
	await h.unplug(a)
	await h.unplug(b)
	const a2 = makePort(0x1a86, 0x7523)
	await h.plug(a2)
	assert.equal(h.hub.getPort('A'), a2)
	assert.equal(h.hub.getPort('B'), b)
})

test('reload：两台同型号原生设备在位，按已存身份选中序列号对上的那台，不被共享键命中错设备', async () => {
	const y = nativePort({ path: 'COM11', serialNumber: 'SYN-Y' })
	const x = nativePort({ path: 'COM12', serialNumber: 'SYN-X' })
	for (const ports of [[y, x], [x, y]]) {
		const h = reloadHarness(ports)
		await h.ready
		h.setWant(await h.keysOf(x))
		const hit = h.match('S')
		assert.ok(hit, '应认出原设备')
		assert.equal(hit.getInfo().path, 'COM12')
	}
})

test('reload：原设备不在位(在位的是同型号另一台)，不自动连', async () => {
	const y = nativePort({ path: 'COM11', serialNumber: 'SYN-Y' })
	const x = nativePort({ path: 'COM12', serialNumber: 'SYN-X' })
	const h = reloadHarness([y])
	await h.ready
	h.setWant(await h.keysOf(x))
	assert.equal(h.match('S'), null)
})

test('reload：同设备换了 USB 口(路径变、序列号同)仍按序列号认回', async () => {
	const x = nativePort({ path: 'COM12', serialNumber: 'SYN-X' })
	const x2 = nativePort({ path: 'COM14', serialNumber: 'SYN-X' })
	const h = reloadHarness([x2])
	await h.ready
	h.setWant(await h.keysOf(x))
	const hit = h.match('S')
	assert.ok(hit)
	assert.equal(hit.getInfo().path, 'COM14')
})

test('reload：同序列号复合设备的两个接口，按路径分清是哪个接口', async () => {
	const if0 = nativePort({ path: 'COM21', serialNumber: 'SYN-C' })
	const if1 = nativePort({ path: 'COM22', serialNumber: 'SYN-C' })
	const h = reloadHarness([if1, if0])
	await h.ready
	h.setWant(await h.keysOf(if0))
	const hit = h.match('S')
	assert.ok(hit)
	assert.equal(hit.getInfo().path, 'COM21')
})

test('reload：网页版唯一候选(只有 VID/PID)照旧认回', async () => {
	const p = makePort(0x1a86, 0x7523)
	const h = reloadHarness([p])
	await h.ready
	h.setWant(await h.keysOf(p))
	assert.equal(h.match('S'), p)
})

test('reload：只剩弱键命中且不止一台(歧义)，不自动连', async () => {
	const p0 = makePort(0x1a86, 0x7523)
	const p1 = makePort(0x1a86, 0x7523)
	const h = reloadHarness([p0, p1], [['usb:1a86:7523'], ['usb:1a86:7523']])
	await h.ready
	h.setWant(['usb:1a86:7523'])
	assert.equal(h.match('S'), null, '认不出是哪台，保持会话记着的身份不连')
})

test('reload：不同 VID/PID 只共享产品名 / 标签时按 VID/PID 认回，不算歧义', async () => {
	const p0 = makePort(0x1a86, 0x7523)
	const p1 = makePort(0x10c4, 0xea60)
	const h = reloadHarness([p1, p0], [['usb:10c4:ea60', 'label:usb serial'], ['usb:1a86:7523', 'label:usb serial']])
	await h.ready
	h.setWant(['usb:1a86:7523', 'label:usb serial'])
	assert.equal(h.match('S'), p0)
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
