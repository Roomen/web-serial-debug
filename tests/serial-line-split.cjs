// Run: node tests/serial-line-split.cjs — synthetic data only.
// 覆盖: 接收分包的「按换行」方式（完整行立即成行、残行兜底超时 / 0 只等换行）与原「按超时」方式，以及二进制协议帧不被 0x0A 拆开
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
const start = source.indexOf('\t//单个合并包的字节上限')
const end = source.indexOf('\t//对外暴露的串口接口', start)
assert.ok(start > 0 && end > start, 'common.js 接收分包段的锚点注释不见了')

function harness(opts) {
	let now = 100000
	let timerId = 0
	const timers = new Map()
	const sess = { packBuf: [], packStart: null, sekWait: null, timer: 0, glitch: false, rxBytes: 0 }
	const rows = []
	const hub = {
		activeSendPhys: () => 'S',
		isRoutable: () => false,
		_sess: () => sess,
		getPackBuf: () => sess.packBuf,
		setPackBuf: (sid, b) => { sess.packBuf = b },
		getPackStartTime: () => sess.packStart,
		setPackStartTime: (sid, t) => { sess.packStart = t },
		getSekWaitStart: () => sess.sekWait,
		setSekWaitStart: (sid, t) => { sess.sekWait = t },
		getPackTimer: () => sess.timer,
		setPackTimer: (sid, t) => { sess.timer = t },
		markPackGlitch: () => { sess.glitch = true },
		takePackGlitch: () => { const g = sess.glitch; sess.glitch = false; return g },
	}
	const window = { _activeProtocol: opts.protocol || '' }
	const ctx = {
		window, Uint8Array, BigInt,
		document: { getElementById() { return null } },
		Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now])) } static now() { return now } },
		setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id },
		clearTimeout(id) { timers.delete(id) },
		SerialHub: hub,
		toolOptions: { skHoverEnable: false },
		logOptionsForSid: () => opts.log,
		getLogTypeForSid: () => opts.log.logType || 'text',
		parseLogType: t => ({ parse: String(t).includes('parse') }),
		isRowLogType: () => true,
		isAllZero: b => b.every(x => x === 0),
		noteSerialRx() {},
		addLogErrSafe(msg) { throw new Error(msg) },
		addLog(buf) { rows.push(Buffer.from(buf).toString('latin1')) },
	}
	vm.createContext(ctx)
	if (opts.protocol === 'hostproto') {
		ctx.window.registerProtocol = () => {}
		for (const f of ['parse-view', 'sts-ciu-protocol', 'hostproto-protocol']) {
			vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8'), ctx)
		}
	}
	vm.runInContext(source.slice(start, end) + '\nthis.dataReceived = dataReceived\nthis.flushPendingRx = flushPendingRx', ctx)
	return {
		ctx, rows, sess,
		rx(s) { ctx.dataReceived(typeof s === 'string' ? Uint8Array.from(Buffer.from(s, 'latin1')) : Uint8Array.from(s), 'S') },
		advance(ms) {
			now += ms
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0]
				if (!due) break
				timers.delete(due[0])
				due[1].fn()
			}
		},
	}
}

// ---- 按换行: 一次读回里的多行各成一行，\r\n 留在行内；残行等后续字节拼完整 ----
{
	const h = harness({ log: { splitMode: 'line', timeOut: 200, logType: 'text' } })
	h.rx('[I] boot ok\r\n[I] rssi=-71\r\n[W] ret')
	assert.deepEqual(h.rows, ['[I] boot ok\r\n', '[I] rssi=-71\r\n'])
	h.advance(150)
	h.rx('ry 1\r\n')
	assert.deepEqual(h.rows.slice(2), ['[W] retry 1\r\n'], '间隔小于兜底超时的残行要拼成一行')
	h.advance(1000)
	assert.equal(h.rows.length, 3)
	assert.equal(h.sess.packBuf.length, 0)
}
// ---- 按换行: 只有 \n 也算行尾；行在读回块中间断开时不按块边界切 ----
{
	const h = harness({ log: { splitMode: 'line', timeOut: 200, logType: 'text' } })
	h.rx('a\nb')
	h.rx('c\nd')
	assert.deepEqual(h.rows, ['a\n', 'bc\n'])
	h.advance(199)
	assert.equal(h.rows.length, 2)
	h.advance(1)
	assert.deepEqual(h.rows.slice(2), ['d'], '没有换行的残行到兜底超时才输出')
}
// ---- 按换行 + 超时 0: 残行一直等换行，发送前 flushPendingRx 仍会输出（提示符回显） ----
{
	const h = harness({ log: { splitMode: 'line', timeOut: 0, logType: 'text' } })
	h.rx('AT+VER\r\nOK\r\n> ')
	assert.deepEqual(h.rows, ['AT+VER\r\n', 'OK\r\n'])
	h.advance(60000)
	assert.equal(h.rows.length, 2, '超时 0 不兜底')
	h.ctx.flushPendingRx('S')
	assert.deepEqual(h.rows.slice(2), ['> '])
}
// ---- 按超时(原行为): 整段间隔内的字节合成一包，不看换行；超时 0 每块立即输出 ----
{
	const h = harness({ log: { splitMode: 'time', timeOut: 200, logType: 'text' } })
	h.rx('x\r\ny\r\n')
	h.advance(100)
	h.rx('z\r\n')
	assert.equal(h.rows.length, 0)
	h.advance(200)
	assert.deepEqual(h.rows, ['x\r\ny\r\nz\r\n'])
	const h0 = harness({ log: { timeOut: 0, logType: 'text' } })
	h0.rx('p\r\nq')
	assert.deepEqual(h0.rows, ['p\r\nq'], '旧配置没有 splitMode 时按超时处理')
}
// ---- 按换行时 SEK 帧（要按协议分包）不按 0x0A 切 ----
{
	const sek = [0xA9, 0x9A, 0x0A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x00, 0x0A, 0x0A, 0x00, 0x00, 0x16]
	const h = harness({ log: { splitMode: 'line', timeOut: 50, logType: 'hex&parse' } })
	h.rx(sek)
	assert.equal(h.rows.length, 0)
	h.advance(50)
	assert.equal(h.rows.length, 1)
	assert.deepEqual([...Buffer.from(h.rows[0], 'latin1')], sek)
}
// ---- 按换行时 hostProto 帧按 CRC 边界整帧输出，帧内 0x0A 不切，帧后的文本行照常按行 ----
{
	const h = harness({ log: { splitMode: 'line', timeOut: 200, logType: 'hex' }, protocol: 'hostproto' })
	const H = h.ctx.window.hostProto
	const frame = [...H.buildFrame({ type: H.TYPE_RSP, cmd: H.CMD.ECHO, seq: 0x0A, payload: [0, 0x0A, 0x0A], preamble: false })]
	h.rx(frame.slice(0, 5))
	assert.equal(h.rows.length, 0, '半帧不按换行切')
	h.rx([...frame.slice(5), ...Buffer.from('log\r\n', 'latin1')])
	assert.equal(h.rows.length, 2)
	assert.deepEqual([...Buffer.from(h.rows[0], 'latin1')], frame)
	assert.equal(h.rows[1], 'log\r\n')
}

console.log('serial-line-split: ok')
