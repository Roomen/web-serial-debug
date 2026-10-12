// Run: node tests/port-select-guard.cjs — synthetic data only.
// 覆盖: 选口入口的统一检查与跨路预留。按锚点截取 js/common.js：SerialHub(`function makeSerialSession(` 到对象字面量结束)、
// `function findPortConflict(` 到 `function portHeldByOther(`、`// opts.openAfterSelect: 无口时点` 到 `//屏幕唤醒锁`(selectPortFor / bindSessionPort)、
// `// ===== 现代布局连接栏的串口列表` 到 `// 列表行要显示的东西`(lanePortOwner / laneSelectBlock / selectLanePort)，这几行注释是锚点，别删。
// 选择框路径(「添加设备…」、芯片)与列表路径都要拒绝：事务钉扎的这一路、正在增减路、另一路已选着(哪怕关着)的口；
// 关旧口期间目标口被预留，另一路选不到；关完再查一次才绑定
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
const hubStart = source.indexOf('\tfunction makeSerialSession(')
const hubEnd = source.indexOf('\n\t}\n', source.indexOf('\tconst SerialHub = {'))
assert.ok(hubStart > 0 && hubEnd > hubStart, 'common.js 的 SerialHub 段不见了')
const hubSrc = source.slice(hubStart, hubEnd + 3)
const conflictSrc = slice('\tfunction findPortConflict(', '\tfunction portHeldByOther(')
const bindSrc = slice('\t// opts.openAfterSelect: 无口时点', '\t//屏幕唤醒锁')
const laneSrc = slice('\t// ===== 现代布局连接栏的串口列表', '\t// 列表行要显示的东西')

let nextId = 0
function makePort() {
	return { id: ++nextId, getInfo() { return { usbVendorId: 0x10c4, usbProductId: 0xea60 } } }
}
function deferred() {
	let resolve
	const p = new Promise((r) => { resolve = r })
	return { p, resolve }
}

function harness(mode) {
	const msgs = []
	const opens = []
	const closeGates = {}
	let pickNext = null
	const ctx = {
		window: { serialApi: { pinned: false, isPinned() { return this.pinned } } },
		document: { getElementById() { return null } },
		pinSid: null,
		laneMoving: false,
		readGenBySid: { S: 0, A: 0, B: 0 },
		rxWatch() { return { lastRxAt: 0, backoff: 0 } },
		WeakSet, Map, Promise, console,
		platformHasSid: () => true,
		showToast(m) { msgs.push(m) },
		showMsg(m) { msgs.push(m) },
		addLogErr(m) { msgs.push(m) },
		sidName: (sid) => (sid === 'S' ? '单路' : sid + '路'),
		isBluetoothSerialPort: () => false,
		isBluAnalyzerPort: () => false,
		_portIdentityCache: new Map(),
		getPortIdentityKey: () => Promise.resolve({ keys: ['k'], fingerprint: {} }),
		refreshPortDisplayNames() {},
		updateOpenButton() {},
		handleToggleClick() { return Promise.resolve() },
		SerialAdapter: {
			grantPort() {},
			requestPort() { return pickNext ? pickNext.p : Promise.reject(Object.assign(new Error('none'), { name: 'NotFoundError' })) },
		},
	}
	vm.createContext(ctx)
	vm.runInContext([hubSrc, conflictSrc, bindSrc, laneSrc].join('\n') + '\nthis.SerialHub = SerialHub; this.api = { selectPortFor, selectLanePort, lanePortOwner, laneSelectBlock }', ctx)
	const hub = ctx.SerialHub
	hub.mode = mode
	ctx.closeSerial = function (sid) {
		const gate = closeGates[sid]
		const done = () => { hub.setOpen(sid, false); return true }
		return gate ? gate.p.then(done) : Promise.resolve(done())
	}
	ctx.openSerial = function (sid) {
		hub.setOpen(sid, true)
		opens.push([sid, hub.getPort(sid).id])
		return Promise.resolve(true)
	}
	return {
		hub, msgs, opens, ctx, api: ctx.api,
		gateClose(sid) { closeGates[sid] = deferred(); return closeGates[sid] },
		pick(port) { pickNext = deferred(); pickNext.resolve(port) },
		pickLater() { pickNext = deferred(); return pickNext },
	}
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('事务钉扎在这一路：选择框路径不弹框、不关旧口；列表路径同样拒绝', async () => {
	const h = harness('dual')
	const old = makePort()
	const p = makePort()
	h.hub.setPort('A', old)
	h.hub.setOpen('A', true)
	h.hub.activeSendId = 'A'
	h.ctx.window.serialApi.pinned = true
	h.pick(p)
	await h.api.selectPortFor('A', { openAfterSelect: false })
	assert.equal(h.hub.getPort('A'), old)
	assert.equal(h.hub.isOpen('A'), true, '钉扎中不能关旧口')
	assert.equal(await h.api.selectLanePort('A', p, { open: true }), false)
	assert.equal(h.hub.getPort('A'), old)
	assert.ok(h.msgs.some((m) => m.indexOf('事务进行中') !== -1))
})

test('选择框兑现时才钉上事务：绑定前再查一次，旧口不关', async () => {
	const h = harness('dual')
	const old = makePort()
	const p = makePort()
	h.hub.setPort('A', old)
	h.hub.setOpen('A', true)
	h.hub.activeSendId = 'A'
	const later = h.pickLater()
	const run = h.api.selectPortFor('A', { openAfterSelect: false })
	h.ctx.window.serialApi.pinned = true
	later.resolve(p)
	await run
	assert.equal(h.hub.getPort('A'), old)
	assert.equal(h.hub.isOpen('A'), true)
})

test('正在增减路：选择框路径与列表路径都拒绝', async () => {
	const h = harness('dual')
	const p = makePort()
	h.ctx.laneMoving = true
	h.pick(p)
	await h.api.selectPortFor('B', { openAfterSelect: true })
	assert.equal(h.hub.getPort('B'), null)
	assert.equal(await h.api.selectLanePort('B', p, { open: true }), false)
	assert.equal(h.hub.getPort('B'), null)
})

test('另一路已选着(关着)的口：经选择框也选不进这一路', async () => {
	const h = harness('dual')
	const p = makePort()
	h.hub.setPort('A', p)
	h.pick(p)
	await h.api.selectPortFor('B', { openAfterSelect: true })
	assert.equal(h.hub.getPort('B'), null)
	assert.deepEqual(h.opens, [])
	assert.ok(h.msgs.some((m) => m.indexOf('A路') !== -1))
})

test('不可见的路(单路模式下的 B)：直接拒绝', async () => {
	const h = harness('single')
	const p = makePort()
	h.pick(p)
	await h.api.selectPortFor('B', { openAfterSelect: true })
	assert.equal(h.hub.getPort('B'), null)
})

test('A 关旧口换到 P 的途中，B 选 P 被拒；A 关完才绑定 P', async () => {
	const h = harness('dual')
	const oldA = makePort()
	const p = makePort()
	h.hub.setPort('A', oldA)
	h.hub.setOpen('A', true)
	const gate = h.gateClose('A')
	const runA = h.api.selectLanePort('A', p, { open: true })
	await Promise.resolve()
	assert.equal(h.api.lanePortOwner(p, 'B'), 'A', '预留期间列表要把 P 显示成被 A 占用')
	assert.equal(await h.api.selectLanePort('B', p, { open: false }), false)
	h.pick(p)
	await h.api.selectPortFor('B', { openAfterSelect: false })
	assert.equal(h.hub.getPort('B'), null)
	gate.resolve()
	assert.equal(await runA, true)
	assert.equal(h.hub.getPort('A'), p)
	assert.equal(h.hub.isOpen('A'), true)
	assert.equal(h.api.lanePortOwner(p, 'B'), 'A')
})

test('关旧口途中换了模式：关完不再绑定，预留随之释放', async () => {
	const h = harness('dual')
	const oldA = makePort()
	const p = makePort()
	h.hub.setPort('A', oldA)
	h.hub.setOpen('A', true)
	const gate = h.gateClose('A')
	const runA = h.api.selectLanePort('A', p, { open: true })
	await Promise.resolve()
	h.hub.mode = 'single'
	gate.resolve()
	assert.equal(await runA, false)
	assert.equal(h.hub.getPort('A'), oldA)
	assert.equal(h.api.lanePortOwner(p, 'S'), null, '失败后预留要释放')
})

test('预留在失败(关旧口失败)后也释放', async () => {
	const h = harness('dual')
	const oldA = makePort()
	const p = makePort()
	h.hub.setPort('A', oldA)
	h.hub.setOpen('A', true)
	const realClose = h.ctx.closeSerial
	h.ctx.closeSerial = () => Promise.resolve(false)
	assert.equal(await h.api.selectLanePort('A', p, { open: true }), false)
	h.ctx.closeSerial = realClose
	assert.equal(h.api.lanePortOwner(p, 'B'), null)
	assert.equal(await h.api.selectLanePort('B', p, { open: false }), true)
	assert.equal(h.hub.getPort('B'), p)
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
