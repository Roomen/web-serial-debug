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

		// 种类：缺省 serial；pick 按种类优先顺序选第一个受支持的，没有就不动当前后端
		assert.equal(A.kind, 'serial')
		A.register({ name: 'ble-off', kind: 'ble', supported: false })
		A.register({ name: 'spp', kind: 'bt-classic', supported: true, requestPort: async () => port, getPorts: async () => [] })
		assert.equal(A.pick(['ble']), null)
		assert.equal(A.backend, 'native')
		assert.equal(A.pick(['ble', 'bt-classic', 'serial']).name, 'spp')
		assert.equal(A.kind, 'bt-classic')
		assert.deepEqual(A.list().filter((b) => b.active).map((b) => b.name), ['spp'])
		assert.equal(A.pick([]), null)
		assert.equal(A.pick(['serial']).name, 'native', 'node 里 web 后端不受支持，取同种类里下一个受支持的')
		// 同种类按 priority 取大的，不看注册先后
		A.register({ name: 'spp-native', kind: 'bt-classic', supported: true, priority: 10, requestPort: async () => port, getPorts: async () => [] })
		assert.equal(A.pick(['bt-classic']).name, 'spp-native')
		A.use('native')
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

		// 写失败：这条流报错，writable 换新流，端口仍打开、后续写入照常
		const wsPrev = port.writable
		const origWrite = d.write
		d.write = async function () { throw Object.assign(new Error('tx'), { name: 'NetworkError' }) }
		const wf = port.writable.getWriter()
		await assert.rejects(wf.write(new Uint8Array([1])), { name: 'NetworkError' })
		wf.releaseLock()
		d.write = origWrite
		assert.notEqual(port.writable, wsPrev)
		const wn = port.writable.getWriter()
		await wn.write(new Uint8Array([2]))
		wn.releaseLock()
		assert.deepEqual(d.written, [[0xAA, 0x55], [2]])
		// 驱动同步抛错走同一条换流路径
		const wsPrev2 = port.writable
		d.write = function () { throw Object.assign(new Error('sync'), { name: 'NetworkError' }) }
		const ws2 = port.writable.getWriter()
		await assert.rejects(ws2.write(new Uint8Array([3])), { message: 'sync' })
		ws2.releaseLock()
		d.write = origWrite
		assert.notEqual(port.writable, wsPrev2)
		const wn2 = port.writable.getWriter()
		await wn2.write(new Uint8Array([4]))
		wn2.releaseLock()
		assert.deepEqual(d.written, [[0xAA, 0x55], [2], [4]])

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

	// ---- 驱动关闭失败：不能报成已关闭，流仍可取、数据照收，重试 close 会再调驱动，成功前不放行重新打开 ----
	{
		const d = fakeDriver({})
		let failClose = true
		d.close = async function () { this.closes++; if (failClose) throw new Error('close failed') }
		const port = A.createStreamPort(d)
		await port.open({})
		await assert.rejects(port.close(), /close failed/)
		assert.ok(port.readable, '关闭失败后仍是打开态，页面重试时会再调 close')
		await assert.rejects(port.open({}), { name: 'InvalidStateError' }, '句柄没释放前不能重新打开')
		const r = port.readable.getReader()
		d.sink.data(new Uint8Array([7]))
		assert.deepEqual(Array.from((await r.read()).value), [7], '关闭失败后驱动的数据照常送达')
		await r.cancel()
		r.releaseLock()
		failClose = false
		await port.close()
		assert.equal(d.closes, 2)
		assert.equal(port.readable, null)
	}

	// ---- 打开中关闭：拒绝，不与驱动的 open 赛跑；open 完成后句柄归页面，照常能关 ----
	{
		const d = fakeDriver({})
		let finishOpen = null
		d.open = function (o, sink) { this.sink = sink; return new Promise((r) => { finishOpen = r }) }
		const port = A.createStreamPort(d)
		const opening = port.open({})
		assert.equal(port.readable, null, '打开中没有流')
		await assert.rejects(port.close(), { name: 'InvalidStateError' })
		assert.equal(d.closes, 0, '打开中不调驱动的 close')
		finishOpen()
		await opening
		assert.ok(port.readable)
		await port.close()
		assert.equal(d.closes, 1, '迟到完成的句柄照常释放')
	}

	// ---- 打开中设备丢失：驱动 open 照样兑现也要报失败、释放句柄、端口回到关闭，之后可重新打开 ----
	{
		const d = fakeDriver({})
		d.open = async function (options, sink) {
			this.opens++
			this.sink = sink
			sink.lost()
			sink.data(new Uint8Array([1]))
		}
		const port = A.createStreamPort(d)
		await assert.rejects(port.open({}), { name: 'NetworkError' })
		assert.equal(d.closes, 1, '替页面关掉驱动')
		assert.equal(port.readable, null)
		assert.equal(port.writable, null)
		await assert.rejects(port.close(), { name: 'InvalidStateError' })
		d.open = async function (options, sink) { this.opens++; this.sink = sink }
		await port.open({})
		assert.ok(port.readable)
		d.sink.lost()
		await tick(); await tick()
		assert.equal(port.readable, null, '打开后的丢失仍按原路径处理')
		assert.equal(d.closes, 2)
	}

	// ---- 替页面释放时驱动 close 失败：不能放行在未释放的句柄上重新打开，下一次 open 先重试释放 ----
	{
		const d = fakeDriver({})
		let closeFails = 2
		d.close = async function () { this.closes++; if (closeFails > 0) { closeFails--; throw new Error('close busy') } }
		d.open = async function (options, sink) { this.opens++; this.sink = sink; if (this.opens === 1) sink.lost() }
		const port = A.createStreamPort(d)
		await assert.rejects(port.open({}), { name: 'NetworkError' })
		assert.equal(d.closes, 1)
		await assert.rejects(port.open({}), { name: 'InvalidStateError' }, '释放仍失败就拒绝打开')
		assert.equal(d.opens, 1, '没有在未释放的句柄上再开')
		assert.equal(d.closes, 2)
		await port.open({})
		assert.equal(d.closes, 3)
		assert.equal(d.opens, 2)
		assert.ok(port.readable)
		// 打开后的丢失同样：释放失败记下，下次 open 先释放
		closeFails = 1
		d.sink.lost()
		await tick(); await tick()
		assert.equal(d.closes, 4)
		await port.open({})
		assert.equal(d.closes, 5, '重新打开前先补释放')
		assert.equal(d.opens, 3)
		await port.close()
	}

	// ---- 写入在核对代次之后、调驱动之前遇到设备丢失：驱动收不到这次写 ----
	{
		const d = fakeDriver({})
		const port = A.createStreamPort(d)
		await port.open({})
		const w = port.writable.getWriter()
		const p = w.write(new Uint8Array([1]))
		d.sink.lost()
		await assert.rejects(p)
		assert.deepEqual(d.written, [])
		w.releaseLock()
	}

	console.log('serial-adapter: ok')
})().catch((e) => { console.error(e); process.exit(1) })
