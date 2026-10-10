'use strict'
// 升级接收通道的真实函数片段：闲置不解析，大块/多帧/分段接收只压缩一次数组。
// 合成 PCP 头与载荷，不含设备标识或实际固件。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync(require('node:path').join(__dirname, '../js/firmware-upgrade.js'), 'utf8')
const start = source.indexOf('\t// 累积接收字节, 提取一个完整的 PCP 帧')
const end = source.indexOf('\tasync function runUpgrade()', start)
assert.ok(start >= 0 && end > start, '接收测试锚点必须存在')
let receive
let parses = 0
const timers = new Map()
let nextTimer = 0
const ctx = {
	Uint8Array,
	setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer },
	clearTimeout(id) { timers.delete(id) },
	log() {},
	serialApi: { onReceive(fn) { receive = fn } },
	PCP: { parseMessage(frame) { parses++; return { messageCode: frame[2] } } },
}
vm.createContext(ctx)
vm.runInContext(`let recvBuffer = [], recvOffset = 0, running = false, splices = 0
const arraySplice = Array.prototype.splice
Array.prototype.splice = function (...args) { splices++; return arraySplice.apply(this, args) }
` + source.slice(start, end), ctx)
const evaluate = s => vm.runInContext(s, ctx)
const frame = size => {
	const out = new Uint8Array(8 + size)
	out.set([0xFF, 0xFE, 0x15, 0, 0, 0, size >> 8, size & 0xFF])
	out.fill(0x55, 8)
	return out
}
const join = (...parts) => {
	const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
	let offset = 0
	for (const part of parts) { out.set(part, offset); offset += part.length }
	return out
}
receive(new Uint8Array(262144).fill(0x41))
assert.equal(parses, 0)
assert.equal(evaluate('recvBuffer.length'), 0)

// 超过旧缓冲上限的一次多帧读回，每帧都处理；数组只在批尾回收一次。
evaluate('running = true')
const small = frame(32)
receive(join(...Array.from({ length: 3000 }, () => small)))
assert.equal(parses, 3000)
assert.equal(evaluate('splices'), 1)
assert.equal(evaluate('recvBuffer.length'), 0)

// 大块噪声之后的半帧保留，下次读回完整后只派发一次。
const up = frame(128)
receive(join(new Uint8Array(262144).fill(0x41), up.subarray(0, 63)))
assert.equal(parses, 3000)
assert.equal(evaluate('recvBuffer.length'), 63)
let resolved
ctx.resolve = bytes => { resolved = bytes }
evaluate('waiters.push({ codes: [0x15], timer: null, resolve })')
receive(up.subarray(63))
assert.deepEqual(Array.from(resolved), Array.from(up))
assert.equal(evaluate('waiters.length'), 0)
assert.equal(evaluate('recvOffset'), 0)

// PCP 数据长为 u16，最大帧要能跨读回完整保留，而非在 65536 时截断。
const maximum = frame(65535)
receive(maximum.subarray(0, 65536))
assert.equal(parses, 3001)
assert.equal(evaluate('recvBuffer.length'), 65536)
receive(maximum.subarray(65536))
assert.equal(parses, 3002)
assert.equal(evaluate('recvBuffer.length'), 0)

;(async function () {
	// 异步写失败立即拒绝并删除自身等待，不清掉并行的其他等待。
	ctx.serialApi.writeData = () => Promise.reject(new Error('synthetic write failure'))
	let otherCalls = 0
	ctx.otherResolve = () => { otherCalls++ }
	ctx.otherTimer = ctx.setTimeout(() => {}, 2000)
	evaluate('waiters.push({ codes: [0x16], timer: otherTimer, resolve: otherResolve })')
	await assert.rejects(evaluate('sendAndWait(new Uint8Array([1]), 0x15, 1000)'), /synthetic write failure/)
	assert.equal(evaluate('waiters.length'), 1)
	assert.equal(timers.size, 1)
	assert.equal(timers.has(ctx.otherTimer), true)
	receive(small)
	assert.equal(otherCalls, 0)
	assert.equal(evaluate('waiters.length'), 1)
	evaluate('waiters.length = 0')
	ctx.clearTimeout(ctx.otherTimer)

	// 同步抛错也要回收已经注册的 timer 与 waiter。
	ctx.serialApi.writeData = () => { throw new Error('synthetic synchronous failure') }
	await assert.rejects(evaluate('sendAndWait(new Uint8Array([1]), 0x15, 1000)'), /synthetic synchronous failure/)
	assert.equal(evaluate('waiters.length'), 0)
	assert.equal(timers.size, 0)

	// 写入时同步收到应答，等待在发送前就已挂好；之后写 Promise 拒绝也已被观察。
	ctx.serialApi.writeData = () => { receive(small); return Promise.reject(new Error('synthetic late failure')) }
	const response = await evaluate('sendAndWait(new Uint8Array([1]), 0x15, 1000)')
	assert.deepEqual(Array.from(response), Array.from(small))
	await Promise.resolve()
	assert.equal(evaluate('waiters.length'), 0)
	assert.equal(timers.size, 0)

	// 已超时的写操作之后拒绝，不应产生未处理的拒绝或恢复旧等待。
	let rejectWrite
	ctx.serialApi.writeData = () => new Promise((resolve, reject) => { rejectWrite = reject })
	const pending = evaluate('sendAndWait(new Uint8Array([1]), 0x15, 1000)')
	const timedOut = assert.rejects(pending, /等待响应超时/)
	const timer = timers.keys().next().value
	const timeout = timers.get(timer)
	timers.delete(timer)
	timeout()
	await timedOut
	rejectWrite(new Error('synthetic failure after timeout'))
	await Promise.resolve()
	assert.equal(evaluate('waiters.length'), 0)
	assert.equal(timers.size, 0)
	console.log('firmware-receive: ok')
})().catch(error => { console.error(error); process.exit(1) })
