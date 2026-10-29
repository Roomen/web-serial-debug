// Run: node tests/transport-native-serial.cjs — synthetic data only.
// 覆盖: 桌面客户端原生串口后端(js/transport-native-serial.js)：getInfo 带设备名与口名、选口过滤与取消、授权后才进 getPorts 与插拔事件、
// 拔插给新端口对象、同一路径换设备、listPorts 列出全部在位口与 grantPort 授权、change 事件(含未授权口)、打开参数映射、通道推数据、读错误换流、设备丢失替页面释放句柄、写入、控制信号、按 kind 被 pick 选中
const assert = require('node:assert/strict')
const A = require('../js/serial-adapter.js')
const N = require('../js/transport-native-serial.js')

const tick = () => new Promise((r) => setTimeout(r, 0))

const CH340 = { path: '/dev/cu.usbserial-1410', name: 'cu.usbserial-1410', transport: 'usb', vendorId: 0x1a86, productId: 0x7523, serialNumber: null, manufacturer: 'QinHeng', product: 'USB Serial', open: false }
const CP2102 = { path: '/dev/cu.usbserial-0001', name: 'cu.usbserial-0001', transport: 'usb', vendorId: 0x10c4, productId: 0xea60, serialNumber: 'AB12', manufacturer: 'Silicon Labs', product: 'CP2102 USB to UART Bridge Controller', open: false }
const BT = { path: '/dev/cu.HC-05', name: 'cu.HC-05', transport: 'bluetooth', vendorId: null, productId: null, serialNumber: null, manufacturer: null, product: null, open: false }

class FakeChannel {
	constructor() { this.onmessage = null }
	push(m) { this.onmessage(m) }
}

function memStorage() {
	const m = new Map()
	return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }
}

function setup(opts) {
	opts = opts || {}
	const state = { list: (opts.list || [CH340, CP2102, BT]).map((d) => Object.assign({}, d)), calls: [], channels: [], nextHandle: 1, failOpen: null, failClose: 0 }
	const invoke = async (cmd, args) => {
		state.calls.push({ cmd, args })
		if (cmd === 'serial_list') return state.list.map((d) => Object.assign({}, d))
		if (cmd === 'serial_open') {
			if (state.failOpen) throw state.failOpen
			state.channels.push({ data: args.onData, event: args.onEvent })
			// 真实的 Rust 端在 serial_open 兑现之前读线程就开始推字节了，用 onOpen 模拟这个时序
			if (opts.onOpen) opts.onOpen(args)
			return state.nextHandle++
		}
		if (cmd === 'serial_close') {
			if (state.failClose > 0) { state.failClose--; throw 'close failed' }
			return null
		}
		return null
	}
	let choose = opts.choose || ((ctx) => Promise.resolve(ctx.list()[0] || null))
	const storage = opts.storage || memStorage()
	const backend = N.createNativeSerialBackend({
		invoke,
		Channel: FakeChannel,
		storage,
		choosePort: (ctx) => choose(ctx),
		setInterval: () => 1,
		clearInterval: () => {},
	})
	// connect / disconnect 与 change 分开记：前者只对授权口，后者是列表用的「在位的口变了」
	const events = []
	const changes = []
	backend.attach((type, port) => (type === 'change' ? changes : events).push({ type, port }))
	return { backend, state, events, changes, storage, setChoose(fn) { choose = fn } }
}

// timeoutMs：超时就取消这次读、释放 reader 再报错，免得等不到数据时测试静默退出
async function readAll(port, n, timeoutMs) {
	const reader = port.readable.getReader()
	const out = []
	let timer = null
	const guard = timeoutMs ? new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('读取超时：只收到 ' + out.length + '/' + n + ' 字节')), timeoutMs) }) : null
	try {
		for (;;) {
			const { value, done } = await (guard ? Promise.race([reader.read(), guard]) : reader.read())
			if (done) break
			out.push(...value)
			if (out.length >= n) break
		}
	} catch (e) {
		if (timer) clearTimeout(timer)
		await reader.cancel().catch(() => {})
		throw e
	} finally {
		if (timer) clearTimeout(timer)
		try { reader.releaseLock() } catch (e) {}
	}
	return out
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('显示用的标题与细节：产品名、厂商、VID:PID、序列号；没有产品名按连接方式给类别名', () => {
	assert.equal(N.portTitle(CP2102), 'CP2102 USB to UART Bridge Controller')
	assert.deepEqual(N.portDetails(CP2102), ['Silicon Labs', '0x10C4:0xEA60', 'SN AB12'])
	assert.equal(N.portTitle(BT), '蓝牙串口')
	assert.deepEqual(N.portDetails(BT), [])
	assert.equal(N.portTitle(Object.assign({}, CH340, { product: null })), 'USB 串口设备')
	// Windows：口名就是 COMx，产品名已在 Rust 端去掉「(COMx)」尾巴
	const win = { path: 'COM3', name: 'COM3', transport: 'usb', vendorId: 0x1a86, productId: 0x7523, product: 'USB-SERIAL CH340' }
	assert.equal(N.portInfo(win).path, 'COM3')
	assert.equal(N.portInfo(win).productName, 'USB-SERIAL CH340')
})

test('getInfo 带 Web Serial 的 VID/PID 与设备字符串，不带含 bluetooth 字样的键', async () => {
	const { backend } = setup()
	const port = await backend.requestPort()
	const info = port.getInfo()
	assert.deepEqual(info, { usbVendorId: 0x10c4, usbProductId: 0xea60, serialNumber: 'AB12', productName: 'CP2102 USB to UART Bridge Controller', manufacturerName: 'Silicon Labs', path: '/dev/cu.usbserial-0001' })
	const bt = N.portInfo(BT)
	assert.ok(!JSON.stringify(Object.keys(bt)).toLowerCase().includes('bluetooth'))
})

test('选口列表 USB 在前，按 filters 过滤；取消报 NotFoundError', async () => {
	let seen = null
	const { backend, setChoose } = setup({ choose: (ctx) => { seen = ctx.list(); return Promise.resolve(null) } })
	await assert.rejects(backend.requestPort(), (e) => e.name === 'NotFoundError')
	assert.deepEqual(seen.map((d) => d.name), ['cu.usbserial-0001', 'cu.usbserial-1410', 'cu.HC-05'])
	setChoose((ctx) => { seen = ctx.list(); return Promise.resolve(seen[0]) })
	const p = await backend.requestPort({ filters: [{ usbVendorId: 0x1a86 }] })
	assert.deepEqual(seen.map((d) => d.name), ['cu.usbserial-1410'])
	assert.equal(p.getInfo().usbVendorId, 0x1a86)
})

test('只有选过(授权)的口进 getPorts；授权存进 storage，换个后端实例仍认得', async () => {
	const t = setup()
	assert.deepEqual(await t.backend.getPorts(), [])
	const p = await t.backend.requestPort()
	assert.deepEqual(await t.backend.getPorts(), [p])
	// 同一设备再选一次是同一个端口对象
	assert.equal(await t.backend.requestPort(), p)
	const t2 = setup({ storage: t.storage })
	const ports = await t2.backend.getPorts()
	assert.equal(ports.length, 1)
	assert.equal(ports[0].getInfo().serialNumber, 'AB12')
})

test('插拔：只对授权口派发；拔掉再插回是新端口对象；有序列号的设备换了口名也认得', async () => {
	const t = setup()
	await t.backend._refresh()
	const p = await t.backend.requestPort() // CP2102
	t.state.list = t.state.list.filter((d) => d.path !== CP2102.path && d.path !== CH340.path)
	await t.backend._refresh()
	assert.deepEqual(t.events.map((e) => e.type), ['disconnect'])
	assert.equal(t.events[0].port, p)
	t.state.list.push(Object.assign({}, CP2102, { path: '/dev/cu.usbserial-0002', name: 'cu.usbserial-0002' }), Object.assign({}, CH340))
	await t.backend._refresh()
	assert.deepEqual(t.events.map((e) => e.type), ['disconnect', 'connect'])
	const np = t.events[1].port
	assert.notEqual(np, p)
	assert.equal(np.getInfo().path, '/dev/cu.usbserial-0002')
})

test('第一次列口不派发 connect：启动时已在位的口不算新插入', async () => {
	const storage = memStorage()
	storage.setItem('nativeSerialGranted', JSON.stringify([{ path: CH340.path, vid: CH340.vendorId, pid: CH340.productId }]))
	const t = setup({ storage })
	await t.backend._refresh()
	assert.equal(t.events.length, 0)
	assert.equal((await t.backend.getPorts()).length, 1)
})

test('同一路径换成另一台设备：按拔出旧的、插入新的处理', async () => {
	const t = setup({ list: [CH340] })
	await t.backend._refresh()
	const p = await t.backend.requestPort()
	t.state.list = [Object.assign({}, CH340, { vendorId: 0x0403, productId: 0x6001, product: 'FT232R' })]
	await t.backend._refresh()
	assert.deepEqual(t.events.map((e) => e.type), ['disconnect'])
	assert.equal(t.events[0].port, p)
})

test('listPorts 列出在位的全部口(不只授权过的)，顺序同选口对话框；同一设备多次调用是同一对象，与 getPorts 一致', async () => {
	const t = setup()
	const all = await t.backend.listPorts()
	assert.deepEqual(all.map((p) => p.getInfo().path), [CP2102.path, CH340.path, BT.path])
	assert.deepEqual(await t.backend.getPorts(), [])
	const again = await t.backend.listPorts()
	all.forEach((p, i) => assert.equal(again[i], p))
	// 选用(授权)后进 getPorts，给的是同一个对象
	assert.equal(t.backend.grantPort(all[1]), true)
	assert.deepEqual(await t.backend.getPorts(), [all[1]])
	// 授权存进 storage：没序列号的按路径 + VID/PID 记
	assert.deepEqual(JSON.parse(t.storage.getItem('nativeSerialGranted')), [{ path: CH340.path, vid: CH340.vendorId, pid: CH340.productId }])
	// 已拔出的旧对象不记
	t.state.list = [CP2102]
	await t.backend._refresh()
	assert.equal(t.backend.grantPort(all[2]), false)
})

test('grantPort 之后插拔事件也对它派发；与对话框里选中的效果一样', async () => {
	const t = setup({ list: [CP2102] })
	const [p] = await t.backend.listPorts()
	t.state.list = []
	await t.backend._refresh()
	assert.deepEqual(t.events, [], '没授权时拔出不派发 disconnect')
	t.state.list = [CP2102]
	await t.backend._refresh()
	const [np] = await t.backend.listPorts()
	assert.notEqual(np, p)
	t.backend.grantPort(np)
	t.state.list = []
	await t.backend._refresh()
	assert.deepEqual(t.events.map((e) => [e.type, e.port]), [['disconnect', np]])
	t.state.list = [CP2102]
	await t.backend._refresh()
	assert.deepEqual(t.events.map((e) => e.type), ['disconnect', 'connect'])
})

test('change：在位集合变了(含没授权的口、同一路径换设备)就派发，不带端口；没变不派发', async () => {
	const t = setup({ list: [CH340] })
	await t.backend._refresh()
	assert.equal(t.changes.length, 1, '第一次列口建表也通知')
	assert.equal(t.changes[0].port, null)
	await t.backend._refresh()
	assert.equal(t.changes.length, 1, '没变化不派发')
	t.state.list = [CH340, CP2102]
	await t.backend._refresh()
	assert.equal(t.changes.length, 2, '未授权的口插入')
	assert.deepEqual(t.events, [], '未授权的口不派发 connect')
	t.state.list = [Object.assign({}, CH340, { vendorId: 0x0403, productId: 0x6001 }), CP2102]
	await t.backend._refresh()
	assert.equal(t.changes.length, 3, '同一路径换设备')
	t.state.list = [CP2102]
	await t.backend._refresh()
	assert.equal(t.changes.length, 4, '拔出')
})

test('打开参数映射、通道推数据、写入与控制信号', async () => {
	const t = setup()
	const port = await t.backend.requestPort()
	await port.open({ baudRate: 115200, dataBits: 7, stopBits: 2, parity: 'even', flowControl: 'hardware', bufferSize: 4096 })
	const open = t.state.calls.find((c) => c.cmd === 'serial_open')
	assert.equal(open.args.path, CP2102.path)
	assert.deepEqual(open.args.options, { baudRate: 115200, dataBits: 7, stopBits: 2, parity: 'even', flowControl: 'hardware' })
	const ch = t.state.channels[0]
	ch.data.push(new Uint8Array([1, 2]).buffer) // Tauri 原始通道给 ArrayBuffer
	ch.data.push([3]) // 兼容 JSON 数组
	assert.deepEqual(await readAll(port, 3), [1, 2, 3])
	const w = port.writable.getWriter()
	await w.write(new Uint8Array([0xaa, 0x55]))
	w.releaseLock()
	const write = t.state.calls.find((c) => c.cmd === 'serial_write')
	assert.deepEqual(write.args, { handle: 1, data: [0xaa, 0x55] })
	await port.setSignals({ dataTerminalReady: false, requestToSend: true })
	const sig = t.state.calls.find((c) => c.cmd === 'serial_set_signals')
	assert.deepEqual(sig.args, { handle: 1, signals: { dataTerminalReady: false, requestToSend: true } })
	await port.close()
	assert.ok(t.state.calls.some((c) => c.cmd === 'serial_close' && c.args.handle === 1))
})

test('读线程在 serial_open 兑现前推的数据不丢：open 成功后按序先交付，之后推的接在后面', async () => {
	const t = setup({
		onOpen(args) {
			// Rust 端先开始推字节，句柄后到
			args.onData.onmessage(Uint8Array.of(1, 2, 3))
		},
	})
	const port = await t.backend.requestPort()
	await port.open({ baudRate: 9600 })
	t.state.channels[0].data.push(Uint8Array.of(4))
	assert.deepEqual(await readAll(port, 4, 500), [1, 2, 3, 4])
	await port.close()
})

test('打开失败报 NetworkError 并带原因，页面走「占用 / 拔出」提示与退避重试', async () => {
	const t = setup()
	const port = await t.backend.requestPort()
	t.state.failOpen = '打开 cu.usbserial-0001 失败: Device or resource busy'
	await assert.rejects(port.open({ baudRate: 9600 }), (e) => e.name === 'NetworkError' && /busy/.test(e.message))
	t.state.failOpen = null
	await port.open({ baudRate: 9600 })
	assert.ok(port.readable)
})

test('读错误换新流续读；设备丢失后两条流为 null，句柄由适配层替页面关掉', async () => {
	const t = setup()
	const port = await t.backend.requestPort()
	await port.open({ baudRate: 9600 })
	const ch = t.state.channels[0]
	const r1 = port.readable
	const reader = r1.getReader()
	ch.event.push({ type: 'error', message: 'framing' })
	await assert.rejects(reader.read(), (e) => e.name === 'FramingError')
	reader.releaseLock()
	assert.notEqual(port.readable, r1)
	ch.event.push({ type: 'lost', message: '设备已断开' })
	assert.equal(port.readable, null)
	assert.equal(port.writable, null)
	await tick()
	await tick()
	assert.ok(t.state.calls.some((c) => c.cmd === 'serial_close'))
	// 丢失后迟到的数据丢弃，重新打开拿到新句柄
	ch.data.push([9])
	await port.open({ baudRate: 9600 })
	assert.equal(t.state.channels.length, 2)
})

test('getUsbDevices 给空表：设备字符串已在 getInfo 里，页面不再按 VID/PID 猜', async () => {
	const { backend } = setup()
	assert.deepEqual(await backend.getUsbDevices(), [])
})

test('注册进 SerialAdapter 后按 kind=serial 被 pick，优先于 web 后端', async () => {
	const t = setup()
	A.register(t.backend)
	const picked = A.pick(['serial'])
	assert.equal(picked.name, 'native')
	assert.equal(A.backend, 'native')
	assert.equal(A.kind, 'serial')
})

;(async () => {
	let failed = 0
	for (const t of tests) {
		try {
			await t.fn()
			console.log('ok -', t.name)
		} catch (e) {
			failed++
			console.error('FAIL -', t.name)
			console.error(e)
		}
	}
	if (failed) {
		console.error(failed + ' failed')
		process.exit(1)
	}
	console.log('all ' + tests.length + ' passed')
})()
