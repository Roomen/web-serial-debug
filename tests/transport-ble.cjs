// Run: node tests/transport-ble.cjs — synthetic data only.
// 覆盖: BLE 透传传输(js/transport-ble.js)经 SerialAdapter.createStreamPort 包出来的端口：按 UUID 档位找服务、通知推数据、
// 分片串行写、写失败不卡队列、GATT 断开按设备丢失、关闭释放、同一设备同一端口、后端按 kind 被 pick 选中
const assert = require('node:assert/strict')
const A = require('../js/serial-adapter.js')
const B = require('../js/transport-ble.js')

const tick = () => new Promise((r) => setTimeout(r, 0))

function fakeChar(props) {
	const listeners = []
	return {
		properties: props || {},
		writes: [],
		notifying: false,
		inFlight: 0,
		failNext: false,
		addEventListener(t, fn) { if (t === 'characteristicvaluechanged') listeners.push(fn) },
		removeEventListener(t, fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) },
		async startNotifications() { this.notifying = true },
		async stopNotifications() { this.notifying = false },
		async writeValueWithoutResponse(v) { return this._w(v) },
		async writeValueWithResponse(v) { return this._w(v) },
		async _w(v) {
			if (this.inFlight) throw new Error('GATT operation already in progress')
			this.inFlight++
			await tick()
			this.inFlight--
			if (this.failNext) { this.failNext = false; throw new Error('write failed') }
			this.writes.push(Array.from(v))
		},
		// 与 Chromium 一样复用底层缓冲：派发完就改写，驱动没拷贝的话页面读到的是被改过的字节
		push(bytes) {
			const u8 = new Uint8Array([0xee].concat(bytes, [0xee]))
			const value = new DataView(u8.buffer, 1, bytes.length)
			listeners.slice().forEach((fn) => fn({ target: { value } }))
			u8.fill(0x55)
		},
		listenerCount() { return listeners.length },
	}
}

function makeDevice(id, serviceMap) {
	const evs = []
	const server = {
		connected: false,
		async getPrimaryService(uuid) {
			const svc = serviceMap[String(uuid)]
			if (!svc) throw new Error('NotFoundError')
			return { async getCharacteristic(c) { const ch = svc[String(c)]; if (!ch) throw new Error('no char'); return ch } }
		},
		disconnect() {
			if (!this.connected) return
			this.connected = false
			evs.slice().forEach((fn) => fn())
		},
	}
	const device = {
		id,
		name: 'UART-' + id,
		connects: 0,
		gatt: { async connect() { device.connects++; server.connected = true; return server } },
		server,
		addEventListener(t, fn) { if (t === 'gattserverdisconnected') evs.push(fn) },
		removeEventListener(t, fn) { const i = evs.indexOf(fn); if (i >= 0) evs.splice(i, 1) },
		evCount() { return evs.length },
	}
	return device
}

async function readSome(port) {
	const reader = port.readable.getReader()
	const { value } = await reader.read()
	reader.releaseLock()
	return Array.from(value)
}

;(async function () {
	const NUS = B.BLE_UART_PROFILES[0]

	// ---- 找不到 NUS 时退到 FFE0 档(读写同一特征)；通知数据拷贝后推给页面 ----
	{
		const ch = fakeChar({ writeWithoutResponse: true })
		const dev = makeDevice('d1', { [String(0xffe0)]: { [String(0xffe1)]: ch } })
		const port = A.createStreamPort(B.createBleUartDriver(dev))
		assert.deepEqual(port.getInfo(), { transport: 'ble', bleDeviceId: 'd1', bleName: 'UART-d1' })
		assert.ok(!JSON.stringify(port.getInfo()).toLowerCase().includes('bluetooth'), '不能触发 web 后端的蓝牙 RFCOMM 拦截')
		assert.equal(port.readable, null)
		await port.open({ baudRate: 9600 })
		assert.equal(ch.notifying, true)
		ch.push([1, 2, 3])
		assert.deepEqual(await readSome(port), [1, 2, 3])

		// 分片：45 字节按 20 切成 3 片，且同一时刻只有一个 GATT 写(并发会抛错)
		const w = port.writable.getWriter()
		const big = new Uint8Array(45).map((_, i) => i)
		await Promise.all([w.write(big), w.write(new Uint8Array([0xaa]))])
		w.releaseLock()
		assert.deepEqual(ch.writes.map((x) => x.length), [20, 20, 5, 1])
		assert.deepEqual([].concat(...ch.writes.slice(0, 3)), Array.from(big))

		// 一次写失败不卡住后续写入(写队列与 writable 都不能停在报错状态)
		ch.failNext = true
		const w2 = port.writable.getWriter()
		await assert.rejects(w2.write(new Uint8Array([1])), /write failed/)
		w2.releaseLock()
		const w3 = port.writable.getWriter()
		await w3.write(new Uint8Array([2]))
		w3.releaseLock()
		assert.deepEqual(ch.writes[ch.writes.length - 1], [2])

		// 关闭：停通知、摘监听、断开 GATT；关后迟到的通知丢弃
		await port.close()
		assert.equal(ch.notifying, false)
		assert.equal(ch.listenerCount(), 0)
		assert.equal(dev.evCount(), 0)
		assert.equal(dev.server.connected, false)
		ch.push([9])
		assert.equal(port.readable, null)
		// 可重新打开
		await port.open({})
		assert.equal(dev.connects, 2)
		await port.close()
	}

	// ---- NUS：写、通知是两个特征；没有 writeWithoutResponse 属性就走带应答写 ----
	{
		const tx = fakeChar({ write: true })
		const rx = fakeChar({ notify: true })
		const dev = makeDevice('d2', { [NUS.service]: { [NUS.write]: tx, [NUS.notify]: rx } })
		const port = A.createStreamPort(B.createBleUartDriver(dev, { chunkSize: 64 }))
		await port.open({})
		rx.push([0x68, 0x16])
		assert.deepEqual(await readSome(port), [0x68, 0x16])
		const w = port.writable.getWriter()
		await w.write(new Uint8Array(100))
		w.releaseLock()
		assert.deepEqual(tx.writes.map((x) => x.length), [64, 36])

		// GATT 断开 = 设备丢失：两条流置 null，适配层替页面关掉驱动
		const reader = port.readable.getReader()
		const pending = reader.read()
		dev.server.disconnect()
		await assert.rejects(pending, { name: 'NetworkError' })
		reader.releaseLock()
		await tick(); await tick()
		assert.equal(port.readable, null)
		assert.equal(port.writable, null)
		assert.equal(rx.listenerCount(), 0)
		await port.open({})
		assert.equal(dev.connects, 2, '丢失后可重新打开')
		await port.close()
	}

	// ---- 没有可识别服务：打开失败并断开 GATT，端口回到关闭 ----
	{
		const dev = makeDevice('d3', {})
		const port = A.createStreamPort(B.createBleUartDriver(dev))
		await assert.rejects(port.open({}), { name: 'NotFoundError' })
		assert.equal(dev.server.connected, false)
		assert.equal(dev.evCount(), 0)
		assert.equal(port.readable, null)
	}

	// ---- 后端：同一设备同一端口对象；kind=ble 被 pick 选中；getDevices 缺失时列口为空 ----
	{
		const dev = makeDevice('d4', {})
		let filters = null
		const bt = {
			async requestDevice(opts) { filters = opts; return dev },
		}
		const backend = B.createBleUartBackend(bt, A)
		assert.equal(backend.kind, 'ble')
		assert.equal(backend.supported, true)
		A.register(backend)
		const before = A.backend
		assert.equal(A.pick(['bt-classic']), null, '没有该种类时不切换')
		assert.equal(A.backend, before)
		assert.equal(A.pick(['ble', 'serial']).name, 'web-ble')
		assert.equal(A.kind, 'ble')
		const p1 = await A.requestPort()
		const p2 = await A.requestPort()
		assert.equal(p1, p2)
		assert.equal(filters.filters.length, B.BLE_UART_PROFILES.length)
		assert.deepEqual(await A.getPorts(), [])
		bt.getDevices = async () => [dev]
		assert.deepEqual(await A.getPorts(), [p1])
		assert.ok(A.list().some((b) => b.name === 'web-ble' && b.kind === 'ble' && b.active))
		assert.equal(B.createBleUartBackend(null, A).supported, false)
	}

	// ---- 驱动直接并发写(不经 WritableStream)：仍串行，GATT 不会同时有两个写 ----
	{
		const ch = fakeChar({ writeWithoutResponse: true })
		const dev = makeDevice('d5', { [String(0xffe0)]: { [String(0xffe1)]: ch } })
		const drv = B.createBleUartDriver(dev)
		await drv.open({}, { data() {}, error() {}, lost() {} })
		await Promise.all([drv.write(new Uint8Array(30)), drv.write(new Uint8Array([7])), drv.write(new Uint8Array([8]))])
		assert.deepEqual(ch.writes.map((x) => x.length), [20, 10, 1, 1])
		await drv.close()
	}

	// ---- 长帧写到一半断线、随后重连：旧任务剩下的分片不能写进新连接，新连接的写入不排在旧队列后面 ----
	{
		const ch = fakeChar({ writeWithoutResponse: true })
		// 真实协议栈断线时会让在飞的 GATT 写失效；假特征里它还挂着，这里放开同时写的检查，只看分片落到哪条连接
		// 第一片挂到手动放行，用来确认新连接的写入不必等它
		let release = null
		ch._w = async function (v) {
			if (!this.writes.length && !release) await new Promise((r) => { release = r })
			else await tick()
			this.writes.push(Array.from(v))
		}
		const dev = makeDevice('d6', { [String(0xffe0)]: { [String(0xffe1)]: ch } })
		let lostSeen = 0
		const drv = B.createBleUartDriver(dev)
		await drv.open({}, { data() {}, error() {}, lost() { lostSeen++ } })
		// 第一片在飞时断开
		const old = drv.write(new Uint8Array(60).fill(1))
		await Promise.resolve()
		dev.server.disconnect()
		assert.equal(lostSeen, 1)
		await drv.close()
		await drv.open({}, { data() {}, error() {}, lost() {} })
		const fresh = drv.write(new Uint8Array([9]))
		const first = await Promise.race([fresh.then(() => 'fresh'), new Promise((r) => setTimeout(() => r('blocked'), 50))])
		assert.equal(first, 'fresh', '新连接的写入不排在旧连接的在飞写后面')
		release()
		await assert.rejects(old, { name: 'NetworkError' })
		const after = ch.writes.map((x) => x[0])
		assert.deepEqual(after, [9, 1], '旧帧只写出断线前在飞的那一片，剩余分片不进新连接')
		await drv.close()
	}

	// ---- 开通知失败：摘监听、断开 GATT，open 拒绝 ----
	{
		const ch = fakeChar({ writeWithoutResponse: true })
		ch.startNotifications = async function () { throw Object.assign(new Error('notify'), { name: 'NotSupportedError' }) }
		const dev = makeDevice('d7', { [String(0xffe0)]: { [String(0xffe1)]: ch } })
		const port = A.createStreamPort(B.createBleUartDriver(dev))
		await assert.rejects(port.open({}), { name: 'NotSupportedError' })
		assert.equal(ch.listenerCount(), 0)
		assert.equal(dev.evCount(), 0)
		assert.equal(dev.server.connected, false)
	}

	// ---- 开通知途中断开但通知 Promise 兑现：端口不能报打开成功 ----
	{
		const ch = fakeChar({ writeWithoutResponse: true })
		const dev = makeDevice('d8', { [String(0xffe0)]: { [String(0xffe1)]: ch } })
		ch.startNotifications = async function () { dev.server.disconnect(); this.notifying = true }
		const port = A.createStreamPort(B.createBleUartDriver(dev))
		await assert.rejects(port.open({}), { name: 'NetworkError' })
		assert.equal(port.readable, null)
		assert.equal(port.writable, null)
		ch.startNotifications = async function () { this.notifying = true }
		await port.open({})
		assert.ok(port.readable, '之后可以重新打开')
		await port.close()
	}

	console.log('transport-ble: ok')
})().catch((e) => { console.error(e); process.exit(1) })
