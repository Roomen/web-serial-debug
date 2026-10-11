// Run: node tests/serial-adapter.cjs — synthetic data only.
// 覆盖: 串口接入适配层(js/serial-adapter.js)的后端切换与事件转发，以及 createStreamPort 包出来的端口是否守住
// Web Serial 的契约：打开前后流的有无、读错误换新流、设备丢失置 null 并释放句柄、锁住时拒绝 close、写入与控制线
const assert = require('node:assert/strict')
const A = require('../js/serial-adapter.js')

function fakeDriver(info) {
	const d = {
		info, sink: null, written: [], signals: [], opens: 0, closes: 0,
		getInfo() { return this.info },
		async open(options, sink) { this.opens++; this.options = options; this.sink = sink },
		async write(u8) { this.written.push(Array.from(u8)) },
		async close() { this.closes++ },
		async setSignals(s) { this.signals.push(s) },
	}
	return d
}
const tick = () => new Promise((r) => setTimeout(r, 0))

;(async function () {
	// ---- 后端：未支持时选口拒绝、列口为空；切到原生后端后事件只来自当前后端 ----
	{
		A.register({ name: 'none', supported: false })
		A.use('none')
		assert.equal(A.isSupported(), false)
		await assert.rejects(A.requestPort(), { name: 'NotSupportedError' })
		assert.deepEqual(await A.getPorts(), [])
		assert.deepEqual(await A.getUsbDevices(), [])

		let fireNative = null
		const port = A.createStreamPort(fakeDriver({ usbVendorId: 0x1a86, usbProductId: 0x7523 }))
		A.register({
			name: 'native',
			supported: true,
			requestPort: async () => port,
			getPorts: async () => [port],
			attach(fire) { fireNative = fire },
		})
		const seen = []
		const onConnect = (e) => seen.push(e.type + ':' + (e.port === port))
		A.addEventListener('connect', onConnect)
		A.use('native')
		assert.equal(A.backend, 'native')
		assert.equal(await A.requestPort(), port)
		assert.deepEqual(await A.getPorts(), [port])
		fireNative('connect', port)
		fireNative('connect', null)
		assert.deepEqual(seen, ['connect:true'], '无端口的事件不转发')
		A.use('none')
		fireNative('connect', port)
		assert.deepEqual(seen, ['connect:true'], '非当前后端的事件不转发')
		A.use('native')
		A.removeEventListener('connect', onConnect)
		fireNative('connect', port)
		assert.equal(seen.length, 1)
		assert.deepEqual(port.getInfo(), { usbVendorId: 0x1a86, usbProductId: 0x7523 })
	}

	// ---- 端口：未打开没有流；打开后读到驱动推的数据，写入透传驱动 ----
	{
		const d = fakeDriver({})
		const port = A.createStreamPort(d)
		assert.equal(port.readable, null)
		assert.equal(port.writable, null)
		await assert.rejects(port.close(), { name: 'InvalidStateError' })
		await port.open({ baudRate: 9600 })
		await assert.rejects(port.open({ baudRate: 9600 }), { name: 'InvalidStateError' })
		assert.equal(d.options.baudRate, 9600)
		assert.equal(port.readable, port.readable, '同一条流')
		const r = port.readable.getReader()
		d.sink.data(new Uint8Array([1, 2, 3]))
		assert.deepEqual(Array.from((await r.read()).value), [1, 2, 3])
		await assert.rejects(port.close(), { name: 'InvalidStateError' }, '流锁住时拒绝 close')

		const w = port.writable.getWriter()
		await w.write(new Uint8Array([0xAA, 0x55]))
		w.releaseLock()
		assert.deepEqual(d.written, [[0xAA, 0x55]])

		await port.setSignals({ dataTerminalReady: true })
		assert.deepEqual(d.signals, [{ dataTerminalReady: true }])

		// 可恢复的读错误：当前流报错，readable 换成新流继续收
		const prev = port.readable
		d.sink.error()
		await assert.rejects(r.read(), { name: 'FramingError' })
		r.releaseLock()
		assert.notEqual(port.readable, prev)
		const r2 = port.readable.getReader()
		d.sink.data(new Uint8Array([4]))
		assert.deepEqual(Array.from((await r2.read()).value), [4])

		// 读循环的关闭顺序：cancel → releaseLock → close；关闭后流为 null，迟到的数据丢弃
		await r2.cancel()
		r2.releaseLock()
		const oldSink = d.sink
		await port.close()
		assert.equal(d.closes, 1)
		assert.equal(port.readable, null)
		oldSink.data(new Uint8Array([9]))
		await port.open({})
		assert.equal(d.opens, 2)
		const r3 = port.readable.getReader()
		d.sink.data(new Uint8Array([5]))
		assert.deepEqual(Array.from((await r3.read()).value), [5], '旧会话的数据不会混进新会话')
		r3.releaseLock()
		await port.close()
	}

	// ---- 设备丢失：两条流报错、置 null，适配层替页面关掉驱动，之后能重新打开 ----
	{
		const d = fakeDriver({})
		const port = A.createStreamPort(d)
		await port.open({})
		const r = port.readable.getReader()
		const w = port.writable.getWriter()
		d.sink.lost()
		await assert.rejects(r.read(), { name: 'NetworkError' })
		await assert.rejects(w.write(new Uint8Array([1])))
		assert.equal(port.readable, null)
		assert.equal(port.writable, null)
		await tick()
		assert.equal(d.closes, 1)
		r.releaseLock()
		w.releaseLock()
		await port.open({})
		assert.ok(port.readable)
		await port.close()
	}

	// ---- 积压溢出：没人读时的单个大块照收；已有积压且放不下才报 BufferOverrunError 换新流 ----
	{
		const d = fakeDriver({})
		const port = A.createStreamPort(d)
		await port.open({ bufferSize: 16 })
		const big = new Uint8Array((1 << 20) + 10)
		d.sink.data(big)
		const first = port.readable
		d.sink.data(new Uint8Array([1]))
		assert.notEqual(port.readable, first, '积压超限后换新流')
		const r = first.getReader()
		await assert.rejects(r.read(), { name: 'BufferOverrunError' })
		r.releaseLock()
		await port.close()
	}

	// ---- 打开失败回到关闭态，可以再试 ----
	{
		const d = fakeDriver({})
		let fail = true
		d.open = async function (o, sink) { if (fail) throw new Error('busy'); this.sink = sink }
		const port = A.createStreamPort(d)
		await assert.rejects(port.open({}), /busy/)
		assert.equal(port.readable, null)
		fail = false
		await port.open({})
		assert.ok(port.readable)
		assert.equal(typeof A.createStreamPort({ getInfo() { return {} } }).setSignals, 'undefined', '驱动没有控制线就不暴露 setSignals')
		await port.close()
	}

	console.log('serial-adapter: ok')
})().catch((e) => { console.error(e); process.exit(1) })
