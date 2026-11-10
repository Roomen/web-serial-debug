'use strict'
// Real PCP framing and production receive/wait functions; synthetic versions and payloads only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../js/firmware-upgrade.js'), 'utf8')
const between = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)))
let receive
const timers = new Map()
let nextTimer = 0
const logs = []
const ctx = vm.createContext({ Uint8Array, TextEncoder, TextDecoder, Date,
	setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer }, clearTimeout(id) { timers.delete(id) },
	log(msg, level) { logs.push({ msg, level }) }, emit() {}, serialApi: { onReceive(fn) { receive = fn }, getMode: () => 'single', writeRawTo: () => Promise.resolve() },
})
ctx.window = ctx
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pcp.js'), 'utf8'), ctx)
vm.runInContext('let recvBuffer = [], recvOffset = 0, running = true, stopFlag = false;\n' +
	between('\t// 累积接收字节, 提取一个完整的 PCP 帧', '\t// 自动升级：查设备版本') +
	between('\tfunction waitForCode(', '\tfunction sleep('), ctx)
const run = s => vm.runInContext(s, ctx)
const P = ctx.PCP
const ack = P.buildMessage(0x14, [0])
const request = (idx = 0, version = 'V2') => P.buildMessage(0x15, P.versionToBytes(version).concat([idx >> 8, idx & 255]))
const join = (...parts) => Uint8Array.from(parts.flatMap(p => Array.from(p)))
function arm(version = 'V2') { ctx.targetVersion = version; run("clearTransferInbox(); stopFlag = false; beginTransferInbox(targetVersion, 3)") }
function accept() { const p = run('sendAndWait(new Uint8Array([0]), 0x14, 1000)'); receive(ack); return p }
const take = () => run('waitForCode([0x15, 0x16], 1000)')

;(async () => {
	// The exact ACK + first request race, at every fragmentation boundary (including coalescence).
	const combined = join(ack, request())
	for (let split = 0; split <= combined.length; split++) {
		arm()
		const pending = run('sendAndWait(new Uint8Array([0]), 0x14, 1000)')
		receive(combined.subarray(0, split))
		receive(combined.subarray(split))
		assert.equal((await pending)[3], 0x14)
		assert.deepEqual(Array.from(await take()), Array.from(request()))
		assert.equal(timers.size, 0)
	}
	arm()
	receive(request()) // Before current handshake acceptance: stale, even if version matches.
	await accept()
	const corrupt = request(); corrupt[9] ^= 1
	const wrongProtocol = request(); wrongProtocol[2] = 2
	wrongProtocol[4] = wrongProtocol[5] = 0
	const crc = P.calculateCrc16(wrongProtocol); wrongProtocol[4] = crc >> 8; wrongProtocol[5] = crc & 255
	receive(join(request(0, 'OLD'), request(3), P.buildMessage(0x15, [0]), corrupt, wrongProtocol))
	assert.equal(run('transferInbox.frames.length'), 0, 'reject stale version, index, type/shape and corrupt frames')
	const beforeDrops = logs.length
	for (let i = 0; i < 100; i++) receive(request(0, 'PRIVATE_WRONG_VERSION'))
	assert.equal(logs.length, beforeDrops, 'repeat drop reasons are suppressed within the round')
	assert.ok(logs.some(l => /目标版本不符/.test(l.msg)))
	assert.ok(logs.some(l => /协议版本不符/.test(l.msg)))
	assert.ok(logs.every(l => !/PRIVATE|OLD/.test(l.msg)), 'drop diagnostics contain no version contents')
	const waiting = take()
	receive(request(0, 'WRONG'))
	assert.equal(run('waiters.length'), 1, 'wrong version does not advance a pending transfer')
	receive(request())
	assert.deepEqual(Array.from(await waiting), Array.from(request()))
	// Requests arriving while a write is still pending are retained; duplicates are bounded.
	receive(join(request(1), request(1), request(2), P.buildMessage(0x16, [0])))
	assert.equal(run('transferInbox.frames.length'), 3)
	assert.deepEqual(Array.from(await take()), Array.from(request(1)))
	assert.deepEqual(Array.from(await take()), Array.from(request(2)))
	assert.equal((await take())[3], 0x16)
	// Queue remains bounded under unsolicited reports; it does not grow with input size.
	for (let i = 0; i < 100; i++) receive(P.buildMessage(0x16, [i]))
	assert.equal(run('transferInbox.frames.length'), 16)
	assert.ok(logs.filter(l => /忽略升级帧/.test(l.msg)).length <= 10)
	// Extension bytes follow the existing >= minimum parser contract; normalization follows the encoder/decoder.
	for (const version of ['V2\0suffix', '123456789012345中']) {
		arm(version)
		const pending = run('sendAndWait(new Uint8Array([0]), 0x14, 1000)')
		const extendedRequest = P.buildMessage(0x15, P.versionToBytes(version).concat([0, 1, 0xaa, 0xbb]))
		receive(join(P.buildMessage(0x14, [0, 0xaa]), extendedRequest, P.buildMessage(0x16, [0, 0xbb])))
		await pending
		assert.deepEqual(Array.from(await take()), Array.from(extendedRequest))
		assert.equal((await take())[3], 0x16)
	}
	arm()
	const pendingAck = run('sendAndWait(new Uint8Array([0]), 0x14, 1000)')
	receive(join(P.buildMessage(0x14), request()))
	assert.equal(run('waiters.length'), 1, 'short ACK cannot resolve or arm')
	receive(P.buildMessage(0x14, [0, 1]))
	await pendingAck
	receive(join(P.buildMessage(0x15), P.buildMessage(0x16)))
	assert.equal(run('transferInbox.frames.length'), 0, 'short request/result cannot enter inbox')
	const ffPaddedVersion = P.versionToBytes('V2').map(b => b === 0 ? 0xff : b)
	receive(P.buildMessage(0x15, ffPaddedVersion.concat([0, 0])))
	assert.equal(run('transferInbox.frames.length'), 0, 'FF padding is not NUL termination under the actual PCP decoder')

	// No evidence permits suppressing a later legitimate retransmission of an already served chunk.
	receive(request(1)); await take()
	receive(request(1))
	assert.deepEqual(Array.from(await take()), Array.from(request(1)))
	// Stop/disconnect clears partial framing and queued messages and promptly cancels waits.
	for (const reason of ['stopped', 'disconnected']) {
		arm(); await accept()
		const pending = take()
		const rejected = assert.rejects(pending, new RegExp(reason))
		receive(request().subarray(0, 12))
		ctx.reason = reason
		run('stopFlag = true; clearTransferInbox(); cancelFirmwareWaiters(new Error(reason))')
		await rejected
		receive(request().subarray(12))
		assert.equal(run('waiters.length'), 0)
		assert.equal(timers.size, 0)
		arm()
		receive(request()) // Restart still requires its own handshake ACK.
		assert.equal(run('transferInbox.frames.length'), 0)
		await accept()
		receive(request(2))
		assert.deepEqual(Array.from(await take()), Array.from(request(2)))
	}
	// Rejected notification cannot arm transfer, and ending a round discards queued requests.
	arm()
	const refused = run('sendAndWait(new Uint8Array([0]), 0x14, 1000)')
	receive(join(P.buildMessage(0x14, [1]), request()))
	await refused
	assert.equal(run('transferInbox.frames.length'), 0)
	run('clearTransferInbox()')
	assert.equal(run('transferInbox'), null)
	console.log('firmware-transfer-inbox: ok (all 36 split boundaries, extensions, normalized echo, drop diagnostics, bounds, cancellation/restart)')
})().catch(e => { console.error(e); process.exitCode = 1 })
