// Run: node tests/firmware-auto-upgrade.cjs — synthetic data only.
// 覆盖: 固件升级面板(js/firmware-upgrade.js)的自动升级端到端：假 DOM + 假串口 + 模拟 PCP 设备(按收到的分片拼回升级包，
// 差分包校验旧文件 CRC 是否等于自己当前固件)。原始固件 → 查设备版本 → 本机固件库找原固件 → 内存里生成差分 / 压缩包 → 升级；
// 差分被拒(0x07 / 0x08)改用压缩包重来一次；导入的升级包照旧直接升级；原始固件导入即存库
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Core = require('../js/firmware-core.js')

function rawFirmware(version, size, seed) {
	const d = new Uint8Array(size || 0x4100)
	for (let i = 0; i < d.length; i++) d[i] = (i * 13 + (seed || 0) * 7) & 0xff
	d.fill(0, 0x4000, 0x4020)
	d.set(Buffer.from(version, 'ascii'), 0x4004)
	return d
}
const fakePatchWorker = class {
	constructor() { this.terminated = false }
	postMessage(msg) {
		const nw = new Uint8Array(msg.nw)
		const out = new Uint8Array(4 + nw.length)
		out.set([1, 2, 3, 4])
		out.set(nw, 4)
		setTimeout(() => this.onmessage({ data: { patch: out.buffer, ms: 1 } }), 0)
	}
	terminate() { this.terminated = true }
}

function stubEl(id) {
	const handlers = {}
	const el = {
		id, value: '', checked: false, disabled: false, textContent: '', innerHTML: '', title: '', className: '',
		dataset: {}, style: {}, scrollTop: 0, scrollHeight: 0, children: [],
		classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
		addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn) },
		setAttribute() {}, getAttribute() { return null },
		appendChild(c) { this.children.push(c); return c },
		removeChild(c) { this.children.splice(this.children.indexOf(c), 1) },
		get childElementCount() { return this.children.length },
		get firstElementChild() { return this.children[0] },
		click() { (handlers.click || []).forEach((fn) => fn({ stopPropagation() {}, preventDefault() {} })) },
	}
	return el
}

function makeHarness(device, opts) {
	opts = opts || {}
	const els = {}
	const events = []
	const logs = []
	let receive = null
	const ctx = {
		console, Uint8Array, DataView, ArrayBuffer, TextEncoder, TextDecoder, URL, Promise, Error, Map, Set, Math, JSON, Date, Number, String, Array, Object,
		// 只压缩协议里固定的 200ms 分片间隔与 500ms 执行前等待，应答超时保持原值(只在出错时才会走到)
		setTimeout: (fn, ms) => setTimeout(fn, ms === 200 || ms === 500 ? 0 : ms),
		// 真定时器(unref，不拖住进程)：面板的连接轮询与准备阶段的断线监视都靠它
		clearTimeout, setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t }, clearInterval,
		fetch: opts.fetch || (() => Promise.reject(new Error('offline'))),
		AbortController,
		localStorage: { getItem: () => null, setItem() {} },
		CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail } },
	}
	ctx.window = ctx
	ctx.document = {
		currentScript: { src: 'http://localhost/js/firmware-upgrade.js' },
		getElementById(id) { return els[id] || (els[id] = stubEl(id)) },
		createElement() { return stubEl('') },
		dispatchEvent(e) {
			events.push(e.detail)
			if (e.detail && e.detail.type === 'log') logs.push(e.detail.msg)
		},
	}
	ctx.confirm = () => true
	ctx.Worker = opts.Worker || fakePatchWorker
	vm.createContext(ctx)
	// 与页面一样按顺序加载：pcp → firmware-core → firmware-library(没有 indexedDB，换成内存库) → firmware-upgrade
	;['pcp.js', 'firmware-core.js', 'firmware-library.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + f), 'utf8'), ctx))
	ctx.FirmwareLibrary = ctx.FirmwareLibraryLib.createLibrary(ctx.FirmwareLibraryLib.memoryStore())
	if (opts.wrapLibrary) ctx.FirmwareLibrary = opts.wrapLibrary(ctx.FirmwareLibrary)
	const pins = { depth: 0 }
	const hostCodes = []
	const link = { open: true }
	ctx.serialApi = {
		suppressParse: false,
		isOpen: () => link.open,
		onReceive(fn) { receive = fn },
		pinSession() { pins.depth++ }, unpinSession() { pins.depth-- }, getActiveSendSid: () => 'S',
		writeData(bytes) { hostCodes.push(bytes[3]); device.onHost(bytes); return Promise.resolve() },
	}
	device.send = (bytes) => setTimeout(() => receive(bytes), 0)
	device.PCP = ctx.PCP
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/firmware-upgrade.js'), 'utf8'), ctx)
	els['fw-chunk-size'].value = '500'
	return {
		ctx, els, events, logs, pins, hostCodes, link, library: ctx.FirmwareLibrary,
		async waitFor(pred, ms) {
			for (let i = 0; i < (ms || 2000); i++) { if (pred()) return true; await new Promise((r) => setTimeout(r, 1)) }
			return false
		},
		load(bytes, name) { ctx.setFwUpgradeFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name) },
		async upgrade(during) {
			const before = events.length
			els['fw-start'].click()
			if (during) await during()
			for (let i = 0; i < 4000; i++) {
				const end = events.slice(before).find((e) => e && e.type === 'end')
				if (end) return end
				await new Promise((r) => setTimeout(r, 1))
			}
			throw new Error('升级没有结束')
		},
	}
}

// 模拟设备：current 是它当前运行的原始固件；supportsDiff=false 时差分包报 0x08
function makeDevice(current, opts) {
	opts = opts || {}
	const dev = { current, received: [], packages: [], runs: 0 }
	let chunks = null
	let total = 0
	let target = ''
	let awaitingAck = false
	dev.onHost = function (bytes) {
		const P = dev.PCP
		const m = P.parseMessage(bytes)
		if (!m) return
		if (m.messageCode === 0x16) { awaitingAck = false; dev.acks = (dev.acks || 0) + 1; return }
		if (m.messageCode === 0x14 && awaitingAck) { dev.send(P.buildMessage(0x14, [0x01])); return }
		if (m.messageCode === 0x13) {
			const ver = P.versionToBytes(Core.embeddedVersion(dev.current))
			dev.send(P.buildMessage(0x13, [0].concat(ver)))
		} else if (m.messageCode === 0x14) {
			target = P.bytesToVersion(Array.from(m.data.slice(0, 16)))
			const chunkSize = (m.data[16] << 8) | m.data[17]
			total = (m.data[18] << 8) | m.data[19]
			chunks = new Array(total)
			dev.chunkSize = chunkSize
			dev.runs++
			dev.send(P.buildMessage(0x14, [0]))
			dev.send(P.buildMessage(0x15, P.versionToBytes(target).concat([0, 0])))
		} else if (m.messageCode === 0x15) {
			const idx = (m.data[1] << 8) | m.data[2]
			chunks[idx] = m.data.slice(3)
			const next = chunks.findIndex((c) => !c)
			if (next >= 0) {
				dev.send(P.buildMessage(0x15, P.versionToBytes(target).concat([next >> 8, next & 0xff])))
				return
			}
			const all = new Uint8Array(total * dev.chunkSize)
			chunks.forEach((c, i) => all.set(c, i * dev.chunkSize))
			const r = dev.parser.parse(all.buffer)
			let status = 0
			if (!r.ok) status = 0x07
			else if (r.header.pkgType === 3 && opts.supportsDiff === false) status = 0x08
			else if (r.header.pkgType !== 1 && r.header.oldFileCRC32 !== (r.header.pkgType === 3 ? Core.crc32(dev.current) : Core.crc32(opts.blank || Core.BLANK_BUILTIN))) status = 0x07
			dev.packages.push({ pkgType: r.ok ? r.header.pkgType : 0, status, version: r.ok ? r.version : '' })
			awaitingAck = true
			dev.send(P.buildMessage(0x16, [status]))
		}
	}
	return dev
}

;(async function () {
	const V1 = rawFirmware('V1.0.0', 0x4100, 1)
	const V1other = rawFirmware('V1.0.0', 0x4100, 9) // 同版本另一份构建
	const V2 = rawFirmware('V2.0.0', 0x4180, 2)

	// ---- 库里没有原固件：压缩包；原始固件导入即存库 ----
	{
		const dev = makeDevice(V1)
		const h = makeHarness(dev)
		dev.parser = h.ctx.FirmwareParser
		h.load(V2, 'V2.0.0.bin')
		await new Promise((r) => setTimeout(r, 5))
		assert.ok(h.events.some((e) => e.type === 'parsed' && e.auto && e.version === 'V2.0.0'))
		assert.equal((await h.library.findByVersion('V2.0.0')).length, 1, '导入即存库')
		const end = await h.upgrade()
		assert.equal(end.ok, true, end.error)
		assert.deepEqual(dev.packages.map((p) => [p.pkgType, p.status]), [[2, 0]])
		assert.equal(dev.packages[0].version, 'V2.0.0')
		assert.ok(h.logs.some((l) => /没有 V1\.0\.0 的原固件，生成压缩包/.test(l)))
		assert.equal(h.events.filter((e) => e.type === 'output' || e.type === 'zip').length, 0, '不输出中间产物')
	}

	// ---- 库里有设备上那份原固件：差分包，设备接受 ----
	{
		const dev = makeDevice(V1)
		const h = makeHarness(dev)
		dev.parser = h.ctx.FirmwareParser
		h.load(V1, 'V1.0.0.bin') // 先导入旧固件(存库)
		await new Promise((r) => setTimeout(r, 5))
		h.load(V2, 'V2.0.0.bin')
		await new Promise((r) => setTimeout(r, 5))
		const end = await h.upgrade()
		assert.equal(end.ok, true, end.error)
		assert.deepEqual(dev.packages.map((p) => [p.pkgType, p.status]), [[3, 0]])
		assert.ok(h.logs.some((l) => /找到原固件 V1\.0\.0\.bin，生成差分包/.test(l)))
	}

	// ---- 库里同版本的是另一份构建：差分被设备拒(0x07)，改用压缩包重来一次 ----
	{
		const dev = makeDevice(V1)
		const h = makeHarness(dev)
		dev.parser = h.ctx.FirmwareParser
		h.load(V1other, 'V1.0.0-other.bin')
		await new Promise((r) => setTimeout(r, 5))
		h.load(V2, 'V2.0.0.bin')
		await new Promise((r) => setTimeout(r, 5))
		const usedBefore = (await h.library.findByVersion('V1.0.0'))[0].usedAt
		const end = await h.upgrade()
		assert.equal(end.ok, true, end.error)
		assert.deepEqual(dev.packages.map((p) => [p.pkgType, p.status]), [[3, 7], [2, 0]])
		await new Promise((r) => setTimeout(r, 5))
		assert.equal((await h.library.findByVersion('V1.0.0'))[0].usedAt, usedBefore, '被拒的差分基准不记成最近使用')
		assert.ok(h.logs.some((l) => /拒收差分包，改用压缩包/.test(l)))
		assert.equal(end.error, '', '回退成功不带上一轮的失败')
		assert.ok(h.events.some((e) => e.type === 'retry' && e.status === 7))
		assert.equal(dev.acks, 2, '失败结果与成功结果都应答了')
		assert.equal(h.pins.depth, 0)
	}

	// ---- 设备不支持差分(0x08)：同样回退一次 ----
	{
		const dev = makeDevice(V1, { supportsDiff: false })
		const h = makeHarness(dev)
		dev.parser = h.ctx.FirmwareParser
		h.load(V1, 'V1.0.0.bin')
		await new Promise((r) => setTimeout(r, 5))
		h.load(V2, 'V2.0.0.bin')
		await new Promise((r) => setTimeout(r, 5))
		const end = await h.upgrade()
		assert.equal(end.ok, true, end.error)
		assert.deepEqual(dev.packages.map((p) => [p.pkgType, p.status]), [[3, 8], [2, 0]])
	}

	// ---- 同版本有两份不同构建：不猜，直接压缩 ----
	{
		const dev = makeDevice(V1)
		const h = makeHarness(dev)
		dev.parser = h.ctx.FirmwareParser
		h.load(V1, 'a.bin')
		await new Promise((r) => setTimeout(r, 5))
		h.load(V1other, 'b.bin')
		await new Promise((r) => setTimeout(r, 5))
		h.load(V2, 'V2.0.0.bin')
		await new Promise((r) => setTimeout(r, 5))
		const end = await h.upgrade()
		assert.equal(end.ok, true, end.error)
		assert.deepEqual(dev.packages.map((p) => [p.pkgType, p.status]), [[2, 0]])
		assert.ok(h.logs.some((l) => /有 2 份不同构建/.test(l)))
	}

	// ---- 导入的升级包照旧直接升级，不查库、不重新生成 ----
	{
		const dev = makeDevice(V1)
		const h = makeHarness(dev)
		dev.parser = h.ctx.FirmwareParser
		const pkg = await Core.buildPackage('diff', V2, V1, async (o, n) => { const out = new Uint8Array(4 + n.length); out.set(n, 4); return out })
		h.load(pkg, 'V1.0.0_to_V2.0.0.bin')
		await new Promise((r) => setTimeout(r, 5))
		assert.ok(h.events.some((e) => e.type === 'parsed' && e.ok && !e.auto && e.pkgType === '差分包'))
		assert.equal((await h.library.summary()).count, 0, '升级包不进固件库')
		const end = await h.upgrade()
		assert.equal(end.ok, true, end.error)
		assert.deepEqual(dev.packages.map((p) => [p.pkgType, p.status]), [[3, 0]])
		assert.ok(!h.logs.some((l) => /生成(差分|压缩)包/.test(l)))
	}

	// ---- 刚导入旧固件、存库还没写完就开始：先等存库再查，仍然走差分 ----
	{
		const dev = makeDevice(V1)
		const wrapLibrary = (lib) => Object.assign({}, lib, { add: (n, d) => new Promise((r) => setTimeout(r, 40)).then(() => lib.add(n, d)) })
		const h = makeHarness(dev, { wrapLibrary })
		dev.parser = h.ctx.FirmwareParser
		h.load(V1, 'V1.0.0.bin')
		h.load(V2, 'V2.0.0.bin')
		const end = await h.upgrade()
		assert.equal(end.ok, true, end.error)
		assert.deepEqual(dev.packages.map((p) => [p.pkgType, p.status]), [[3, 0]])
	}

	// ---- 停止：准备阶段(差分计算挂住 / BLANK 请求挂住 / 查库很慢)点停止都立即收尾，不再发升级帧 ----
	async function stopScenario(name, opts, prep, how) {
		const dev = makeDevice(V1)
		const h = makeHarness(dev, opts)
		dev.parser = h.ctx.FirmwareParser
		if (prep) await prep(h)
		h.load(V2, 'V2.0.0.bin')
		await new Promise((r) => setTimeout(r, 5))
		const t0 = Date.now()
		const end = await h.upgrade(async () => {
			assert.ok(await h.waitFor(() => h.logs.some((l) => /生成(差分|压缩)包$/.test(l)) || opts.stopWhen && opts.stopWhen()), name + ': 进入准备阶段')
			await new Promise((r) => setTimeout(r, 5))
			if (how === 'disconnect') h.link.open = false
			else h.els['fw-stop'].click()
		})
		assert.equal(end.ok, false, name)
		if (how === 'disconnect') {
			assert.equal(end.stopped, false, name + ': 断线记为失败')
			assert.match(end.error, /串口已断开/, name)
		} else {
			assert.equal(end.stopped, true, name + ': 记为停止，不是失败')
		}
		assert.ok(Date.now() - t0 < 1500, name + ': 及时收尾')
		assert.ok(!h.hostCodes.includes(0x14), name + ': 停止后不发新版本通知')
		assert.equal(h.pins.depth, 0, name + ': 钉扎已释放')
		assert.equal(h.ctx.serialApi.suppressParse, false, name + ': 解析已恢复')
		assert.ok(!h.logs.some((l) => /生成失败/.test(l)), name + ': 停止不记成生成失败')
		return h
	}
	{
		const made = []
		class HangWorker { constructor() { this.terminated = false; made.push(this) } postMessage() {} terminate() { this.terminated = true } }
		await stopScenario('差分计算中停止', { Worker: HangWorker }, async (h) => {
			h.load(V1, 'V1.0.0.bin')
			await new Promise((r) => setTimeout(r, 5))
		})
		assert.equal(made.length, 1)
		assert.equal(made[0].terminated, true, '在途差分 Worker 被结束')
	}
	{
		let aborted = false
		const hangFetch = (url, init) => new Promise((resolve, reject) => {
			if (init && init.signal) init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
		})
		await stopScenario('取 BLANK 时停止', { fetch: hangFetch })
		assert.equal(aborted, true, 'BLANK 请求被中止')
	}
	{
		let slow = false
		const wrapLibrary = (lib) => Object.assign({}, lib, { findByVersion: (v) => { slow = true; return new Promise(() => {}) } })
		await stopScenario('查固件库时停止', { wrapLibrary, stopWhen: () => slow })
	}

	// ---- 准备阶段断线(没人点停止)：同样及时收尾，记为失败 ----
	{
		const made = []
		class HangWorker { constructor() { this.terminated = false; made.push(this) } postMessage() {} terminate() { this.terminated = true } }
		await stopScenario('差分计算中断线', { Worker: HangWorker }, async (h) => {
			h.load(V1, 'V1.0.0.bin')
			await new Promise((r) => setTimeout(r, 5))
		}, 'disconnect')
		assert.equal(made[0].terminated, true)
	}
	{
		let aborted = false
		const hangFetch = (url, init) => new Promise((resolve, reject) => {
			if (init && init.signal) init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
		})
		const h = await stopScenario('取 BLANK 时断线', { fetch: hangFetch }, null, 'disconnect')
		assert.equal(aborted, true)
		assert.ok(!h.logs.some((l) => /压缩包已生成/.test(l)), '中止的请求不被当成「取不到就用内置」继续生成')
	}
	{
		let slow = false
		const wrapLibrary = (lib) => Object.assign({}, lib, { findByVersion: () => { slow = true; return new Promise(() => {}) } })
		await stopScenario('查固件库时断线', { wrapLibrary, stopWhen: () => slow }, null, 'disconnect')
	}

	// ---- 取 BLANK 时断线后重连再升级：被中止的那次不能把「内置 BLANK」缓存下来，下一轮照常取 imgs/BLANK.BIN ----
	{
		const realBlank = new Uint8Array(32).fill(0xee)
		const dev = makeDevice(V1, { blank: realBlank })
		const hangFetch = (url, init) => new Promise((resolve, reject) => {
			if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')))
		})
		const h = makeHarness(dev, { fetch: hangFetch })
		dev.parser = h.ctx.FirmwareParser
		h.load(V2, 'V2.0.0.bin')
		await new Promise((r) => setTimeout(r, 5))
		const end1 = await h.upgrade(async () => {
			assert.ok(await h.waitFor(() => h.logs.some((l) => /生成压缩包$/.test(l))))
			h.link.open = false
		})
		assert.equal(end1.ok, false)
		h.link.open = true
		h.ctx.fetch = async () => ({ ok: true, arrayBuffer: async () => realBlank.slice().buffer })
		const end2 = await h.upgrade()
		assert.equal(end2.ok, true, end2.error)
		assert.deepEqual(dev.packages.map((p) => [p.pkgType, p.status]), [[2, 0]], '第二轮用的是取到的 BLANK')
	}

	console.log('firmware-auto-upgrade: ok')
})().catch((e) => { console.error(e); process.exit(1) })
