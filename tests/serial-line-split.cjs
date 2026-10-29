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
	// 每路一套分包状态(双路两路独立)；sess 是单路 S 的，原有用例都只用它
	const sessions = {}
	const S = sid => sessions[sid] || (sessions[sid] = { packBuf: [], packStart: null, sekWait: null, timer: 0, glitch: false, rxBytes: 0 })
	const sess = S('S')
	const rows = []
	const rowSids = []
	const hub = {
		activeSendPhys: () => 'S',
		isRoutable: () => false,
		_sess: sid => S(sid),
		getPackBuf: sid => S(sid).packBuf,
		setPackBuf: (sid, b) => { S(sid).packBuf = b },
		getPackStartTime: sid => S(sid).packStart,
		setPackStartTime: (sid, t) => { S(sid).packStart = t },
		getSekWaitStart: sid => S(sid).sekWait,
		setSekWaitStart: (sid, t) => { S(sid).sekWait = t },
		getPackTimer: sid => S(sid).timer,
		setPackTimer: (sid, t) => { S(sid).timer = t },
		markPackGlitch: sid => { S(sid).glitch = true },
		takePackGlitch: sid => { const g = S(sid).glitch; S(sid).glitch = false; return g },
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
		// 帧保护按该路自己的协议；没给按路协议时各路都是顶栏协议
		protocolIdForSid: sid => (opts.laneProtocols && opts.laneProtocols[sid]) || window._activeProtocol,
		parseLogType: t => ({ parse: String(t).includes('parse') }),
		isRowLogType: () => true,
		isAllZero: b => b.every(x => x === 0),
		noteSerialRx() {},
		addLogErrSafe(msg) { throw new Error(msg) },
		addLog(buf, isReceive, t, sid) { rows.push(Buffer.from(buf).toString('latin1')); rowSids.push(sid) },
	}
	vm.createContext(ctx)
	if (opts.protocol === 'hostproto' || opts.loadHostProto) {
		ctx.window.registerProtocol = () => {}
		for (const f of ['parse-view', 'sts-ciu-protocol', 'hostproto-protocol']) {
			vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8'), ctx)
		}
	}
	vm.runInContext(source.slice(start, end) + '\nthis.dataReceived = dataReceived\nthis.flushPendingRx = flushPendingRx', ctx)
	return {
		ctx, rows, rowSids, sess, sessions,
		rx(s, sid) { ctx.dataReceived(typeof s === 'string' ? Uint8Array.from(Buffer.from(s, 'latin1')) : Uint8Array.from(s), sid || 'S') },
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
// ---- 输出抛错(如 DOM 异常)时缓冲也要先清掉，后续数据不能叠在旧包上 ----
for (const mode of ['time0', 'line']) {
	const h = harness({ log: mode === 'line' ? { splitMode: 'line', timeOut: 200, logType: 'text' } : { splitMode: 'time', timeOut: 0, logType: 'text' } })
	const realAddLog = h.ctx.addLog
	h.ctx.addLog = () => { throw new Error('dom boom') }
	assert.throws(() => h.rx('abc\n'), /dom boom/)
	assert.equal(h.sess.packBuf.length, 0, mode + ': 输出抛错后缓冲已清空')
	h.ctx.addLog = realAddLog
	h.rx('x\n')
	assert.deepEqual(h.rows, ['x\n'], mode + ': 之后的数据不带旧包')
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

// ---- 双路两路协议不同：A 路是 hostProto，半帧按 CRC 等齐、帧内 0x0A 不切；B 路是文本协议，同样的字节照常按换行切 ----
{
	const h = harness({ log: { splitMode: 'line', timeOut: 200, logType: 'hex' }, laneProtocols: { A: 'hostproto', B: 'none' }, loadHostProto: true })
	const H = h.ctx.window.hostProto
	const frame = [...H.buildFrame({ type: H.TYPE_RSP, cmd: H.CMD.ECHO, seq: 0x0A, payload: [0, 0x0A, 0x0A], preamble: false })]
	// 前 8 字节里有 seq=0x0A
	h.rx(frame.slice(0, 8), 'A')
	h.rx(frame.slice(0, 8), 'B')
	assert.equal(h.rowSids.filter(s => s === 'A').length, 0, 'A 路 hostProto 半帧不按换行切')
	assert.ok(h.rowSids.includes('B'), 'B 路不是 hostProto，0x0A 照常成行')
	h.rx(frame.slice(8), 'A')
	const aRows = h.rows.filter((r, i) => h.rowSids[i] === 'A')
	assert.equal(aRows.length, 1)
	assert.deepEqual([...Buffer.from(aRows[0], 'latin1')], frame, 'A 路整帧一行')
}
// ---- 双路：只有 B 路协议是 SEK 时，B 路的 SEK 帧不按 0x0A 切，A 路(文本协议)照常切 ----
{
	const sek = [0xA9, 0x9A, 0x0A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x00, 0x0A, 0x0A, 0x00, 0x00, 0x16]
	const h = harness({ log: { splitMode: 'line', timeOut: 50, logType: 'hex' }, laneProtocols: { A: 'none', B: 'sek' } })
	h.rx(sek, 'B')
	h.rx(sek, 'A')
	assert.equal(h.rowSids.filter(s => s === 'B').length, 0, 'B 路 SEK 帧不按换行切')
	assert.ok(h.rowSids.filter(s => s === 'A').length >= 2, 'A 路按换行切')
	h.advance(50)
	const bRows = h.rows.filter((r, i) => h.rowSids[i] === 'B')
	assert.equal(bRows.length, 1)
	assert.deepEqual([...Buffer.from(bRows[0], 'latin1')], sek)
}

// ---- 按换行: 64 KiB 全是换行时按消费游标线性切分（不是每行都复制剩余后缀），行数正确、耗时合理 ----
{
	const h = harness({ log: { splitMode: 'line', timeOut: 0, logType: 'text' } })
	const t0 = process.hrtime.bigint()
	h.rx(new Uint8Array(65536).fill(0x0A))
	const ms = Number(process.hrtime.bigint() - t0) / 1e6
	assert.equal(h.rows.length, 65536, '每个换行一行')
	assert.ok(h.rows.every((r) => r === '\n'), '每行就是一个 \\n')
	assert.equal(h.sess.packBuf.length, 0, '没有残行')
	// 每行都复制剩余后缀是平方级(约 21 亿个元素)，这里给一个宽松上限，只卡住复杂度回退
	assert.ok(ms < 200, '64 KiB 全换行应在 200 ms 内切完，实际 ' + ms.toFixed(1) + ' ms')
}
// ---- 按换行: 长短混合的行分多次读回，已输出的行与残行都与逐行切分的参考实现逐字一致 ----
{
	const parts = []
	for (let i = 0; i < 60; i++) {
		let body = ''
		if (i % 5 === 0) body = 'L'.repeat(2000 + i * 7)
		else if (i % 5 === 1) body = ''
		else if (i % 5 === 2) body = 's' + i
		else if (i % 5 === 3) body = 'tab\t' + i
		else body = 'x'.repeat(9) + i
		parts.push(body + (i % 3 === 0 ? '\r\n' : '\n'))
	}
	const stream = Buffer.from(parts.join(''), 'latin1')
	const h = harness({ log: { splitMode: 'line', timeOut: 0, logType: 'text' } })
	// 参考实现：把已收到的全部字节按 0x0A 切，行尾(含 \r\n)留在行内
	const reference = (all) => {
		const rows = []
		let start = 0
		for (let i = 0; i < all.length; i++) {
			if (all[i] !== 0x0A) continue
			rows.push(all.slice(start, i + 1).toString('latin1'))
			start = i + 1
		}
		return { rows, rest: all.slice(start).toString('latin1') }
	}
	const chunks = [1, 2, 7, 1000, 3, 4096, 55, 1, 3000, 99999]
	let fed = 0
	let round = 0
	while (fed < stream.length) {
		const n = Math.min(chunks[round++ % chunks.length], stream.length - fed)
		h.rx(stream.slice(fed, fed + n))
		fed += n
		const want = reference(stream.slice(0, fed))
		assert.deepEqual(h.rows, want.rows, '第 ' + round + ' 段读回后已输出的行一致')
		assert.equal(Buffer.from(h.sess.packBuf).toString('latin1'), want.rest, '第 ' + round + ' 段读回后残行一致')
	}
	assert.equal(h.rows.length, parts.length)
	assert.equal(h.sess.packBuf.length, 0)
}
// ---- 按换行: 输出抛错时按游标清掉已切走的行，不重复输出也不吐掉后面的残行 ----
{
	const h = harness({ log: { splitMode: 'line', timeOut: 0, logType: 'text' } })
	const realAddLog = h.ctx.addLog
	let calls = 0
	h.ctx.addLog = (buf, ...rest) => {
		calls++
		if (calls === 2) throw new Error('dom boom')
		realAddLog(buf, ...rest)
	}
	assert.throws(() => h.rx('one\ntwo\nthree\nfour'), /dom boom/)
	assert.deepEqual(h.rows, ['one\n'], '抛错那一行不算输出')
	assert.equal(Buffer.from(h.sess.packBuf).toString('latin1'), 'three\nfour', '抛错之后的残行按游标留在缓冲里，没有重复')
	h.ctx.addLog = realAddLog
	h.rx('\n')
	assert.deepEqual(h.rows.slice(1), ['three\n', 'four\n'], '后续照常输出，不重复也不丢字节')
}

console.log('serial-line-split: ok')
