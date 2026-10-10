'use strict'
// 协议事务层(js/wmbus-transaction.js、js/gz-transaction.js)常驻接收的回归：
// 没有事务在等时不扫描、缓冲有界；有事务在等时混在普通流量里的应答照样认出来，且找帧开销不随流量平方增长。
// 只用合成数据。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const src = function (f) { return fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8') }

function makeWorld() {
	const receivers = []
	const scans = { gz: 0, wmbus: 0, sek: 0 }
	let writes = 0
	let pins = 0
	let writer = function () { return Promise.resolve() }
	const window = {
		registerProtocol() {},
		serialApi: {
			onReceive(cb) { receivers.push(cb) },
			isOpen() { return true },
			pinSession() { pins++ },
			unpinSession() { pins-- },
			getActiveSendSid() { return 'S' },
			writeData(bytes) { writes++; return writer(bytes) },
		},
	}
	const ctx = { window, Uint8Array, Float32Array, BigInt, TextDecoder, TextEncoder, console, setTimeout, clearTimeout, Date, performance,
		localStorage: { getItem() { return null }, setItem() {} },
		document: { getElementById() { return null }, addEventListener() {} } }
	vm.createContext(ctx)
	for (const f of ['parse-view', 'protocol-schema', 'protocol-crypto', 'protocol', 'gz-protocol', 'gz-transaction', 'wmbus-protocol', 'wmbus-transaction', 'sek-transaction']) {
		vm.runInContext(src(f), ctx)
	}
	for (const name of ['gz', 'wmbus']) {
		const find = window[name + 'FindFrame']
		window[name + 'FindFrame'] = function (...args) { scans[name]++; return find(...args) }
	}
	// SEK 生命周期测试使用合成解析模型；真实 CRC/组帧由协议回归覆盖。
	ctx.skBuildDownFrame = function () { return new Uint8Array([1]) }
	ctx.skFindFrame = function (bytes) {
		scans.sek++
		const offset = bytes.indexOf(0xA9)
		if (offset < 0 || bytes.length - offset < 27) return { found: false }
		const frame = bytes.slice(offset, offset + 27)
		return { found: true, offset, length: 27, frame, parse: { dir: 'up', ok: true,
			fields: { '功能码': 0x81, '帧序号': frame[2] }, tlv: [{ tag: 11, items: [{ resultCode: frame[3] }] }] } }
	}
	return { window, scans, get writes() { return writes }, get pins() { return pins },
		setWriter(fn) { writer = fn }, feed(bytes) { for (const cb of receivers) cb(bytes) } }
}

// 上行帧：把下行构造器的 CI 换成上行再组帧。MAC 只覆盖帧头与密文，与 IV 的方向位无关，真实解析器能验过
function buildWmbusUp(opt) {
	const ctx = { window: { registerProtocol() {} }, Uint8Array, BigInt, TextDecoder, TextEncoder, console, setTimeout,
		localStorage: { getItem() { return null }, setItem() {} }, document: { getElementById() { return null } } }
	vm.createContext(ctx)
	for (const f of ['parse-view', 'protocol-schema', 'protocol-crypto', 'protocol']) vm.runInContext(src(f), ctx)
	const swapped = src('wmbus-protocol').replace('const CI_DOWN = 0x5B, CI_UP = 0x7A', 'const CI_DOWN = 0x7A, CI_UP = 0x5B')
	assert.notEqual(swapped, src('wmbus-protocol'), '构造上行帧要靠替换 CI 常量')
	vm.runInContext(swapped, ctx)
	return ctx.window.wmbusBuildDownFrame(opt)
}

const line = '[12:34:56.789] [INFO] sensor z=1234 temp=25.3 ok\r\n'
const text = function (n) { return new Uint8Array(Buffer.from(line.repeat(Math.ceil(n / line.length))).subarray(0, n)) }
const cat = function (...parts) {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let o = 0
	for (const p of parts) { out.set(p, o); o += p.length }
	return out
}
const feedChunks = function (w, data, size) { for (let o = 0; o < data.length; o += size) w.feed(data.subarray(o, o + size)) }

;(async function () {
	{
		const w = makeWorld()
		const up = buildWmbusUp({ addr: '01 02 03 04 05 06 07 08', keyId: 0, mcnt: 9, cmd: 0x10, payloadHex: '01 02' })
		const parsed = w.window.wmbusParseFrame(up)
		assert.equal(parsed.dir, 'up')
		assert.equal(parsed.macOk, true)

		// 闲置：115200 满速文本 1 秒、1024B 一块，不能再逐个候选算 CMAC
		feedChunks(w, text(11520), 1024)
		assert.deepEqual(w.scans, { gz: 0, wmbus: 0, sek: 0 }, '闲置普通流量不调用找帧器')

		// 有事务在等：应答混在文本里，前后都有噪声，照样认出
		const p = w.window.wmbusTx.waitFor(function (f) { return f.dir === 'up' }, 1000)
		feedChunks(w, cat(text(5000), up, text(5000)), 1024)
		const res = await p
		assert.deepEqual(Array.from(res.raw), Array.from(up))
		assert.ok(w.scans.wmbus < 30, '每块噪声只找一遍，不逐个失败候选重扫')

		// 应答在等待开始前刚到(尾巴里)也能认出
		w.feed(up)
		const late = await w.window.wmbusTx.waitFor(function (f) { return f.dir === 'up' }, 1000)
		assert.deepEqual(Array.from(late.raw), Array.from(up))

		// 应答被拆成多块
		const p2 = w.window.wmbusTx.waitFor(function (f) { return f.dir === 'up' }, 1000)
		feedChunks(w, cat(text(300), up), 7)
		assert.deepEqual(Array.from((await p2).raw), Array.from(up))
	}

	{
		// 找帧：噪声中的合法帧照样找到，未知角色继续支持旧的默认零密钥与显式密钥。
		const w = makeWorld()
		const up = buildWmbusUp({ addr: '11 22 33 44 55 66 77 88', keyId: 0, mcnt: 3, cmd: 0x11 })
		const found = w.window.wmbusFindFrame(cat(text(2000), up, text(100)), {})
		assert.equal(found.found, true)
		assert.equal(found.parse && found.parse.macOk, true)
		assert.deepEqual(Array.from(found.frame), Array.from(up))

		// 显式传入自定义角色密钥仍能找到该角色的合法帧。
		const custom = buildWmbusUp({ addr: '01 02 03 04 05 06 07 08', keyId: 3, mcnt: 4, cmd: 0x10,
			roleKeys: { 3: '00000000000000000000000000000000' } })
		assert.equal(w.window.wmbusFindFrame(custom, {}).parse.macOk, true)
		assert.equal(w.window.wmbusFindFrame(custom, { roleKeys: { 3: '00000000000000000000000000000000' } }).parse.macOk, true)
	}

	{
		// 工装：闲置不扫描；等待时应答混在没有 A5 的噪声里照样认出
		const w = makeWorld()
		const resp = w.window.gzBuildFrame(0x30, 0x82, [1, 2, 3, 4])
		assert.equal(w.window.gzParseFrame(resp).dir, 'up')
		feedChunks(w, text(65536), 1024)
		const p = w.window.gzTx.waitFor(function (f) { return f.dir === 'up' }, 1000)
		feedChunks(w, cat(text(3000), resp, text(10)), 256)
		assert.deepEqual(Array.from((await p).raw), Array.from(resp))
	}

	{
		const w = makeWorld()
		const resp = w.window.gzBuildFrame(0x30, 0x82, [1, 2, 3, 4])
		const p = w.window.gzTx.waitFor(function () { return true }, 1000)
		// 重复的坏 A5 候选不应触发逐个候选的整段重扫。
		const bad = new Uint8Array(12000)
		for (let i = 0; i < bad.length; i += 5) bad.set([0xA5, 3, 0, 0, 0], i)
		w.feed(cat(bad, resp.subarray(0, 4)))
		assert.equal(w.scans.gz, 1)
		w.feed(resp.subarray(4))
		assert.deepEqual(Array.from((await p).raw), Array.from(resp))
	}

	// 新请求必须等待新应答；公共被动等待仍保留接收先于等待的语义。
	for (const name of ['gz', 'wmbus', 'sek']) {
		const w = makeWorld()
		const tx = w.window[name + 'Tx']
		const response = name === 'gz' ? w.window.gzBuildFrame(0x30, 0x82, [1]) : name === 'wmbus'
			? buildWmbusUp({ addr: '01 02 03 04 05 06 07 08', keyId: 0, mcnt: 1, cmd: 0x10 })
			: new Uint8Array([0xA9, 0x9A, 1, 1, ...new Array(23).fill(0)])
		const opts = { frame: new Uint8Array([1]), timeoutMs: 1000, match() { return true } }
		w.feed(response)
		assert.deepEqual(Array.from((await tx.waitFor(function () { return true }, 1000)).raw), Array.from(response))
		w.feed(response)
		let matched = false
		const p = tx.sendAndWait(opts).then(function (res) { matched = true; return res })
		await Promise.resolve()
		await Promise.resolve()
		assert.equal(matched, false, name + ' 不用发送前的旧应答完成新请求')
		w.feed(response)
		assert.deepEqual(Array.from((await p).raw), Array.from(response))
		assert.equal(w.pins, 0)

		// 同步写回快速应答：等待必须在写入前已经挂好。
		w.setWriter(function () { w.feed(response); return Promise.resolve() })
		assert.deepEqual(Array.from((await tx.sendAndWait(opts)).raw), Array.from(response))

		// 写失败只撤掉这笔等待，后续接收不能再触发旧匹配器。
		let oldMatches = 0
		w.setWriter(function () { return Promise.reject(new Error('synthetic write failure')) })
		await assert.rejects(tx.sendAndWait({ ...opts, match() { oldMatches++; return true } }), /synthetic write failure/)
		w.feed(response)
		assert.equal(oldMatches, 0)
		assert.equal(w.pins, 0)
		assert.equal(w.writes, 3)
		// 写操作还没完成时等待超时，拒绝已被观察，最终仍向调用方报告超时。
		w.setWriter(function () { return new Promise(resolve => setTimeout(resolve, 15)) })
		await assert.rejects(tx.sendAndWait({ ...opts, timeoutMs: 1 }), /超时/)
		assert.equal(w.pins, 0)

		let finishWrite
		w.setWriter(function () { return new Promise(resolve => { finishWrite = resolve }) })
		const canceled = tx.sendAndWait(opts)
		const canceledCheck = assert.rejects(canceled, /synthetic cancellation/)
		tx.cancelAll('synthetic cancellation')
		finishWrite()
		await canceledCheck
		assert.equal(w.pins, 0)
	}

	console.log('protocol-transactions: ok')
})().catch(function (e) { console.error(e); process.exit(1) })
