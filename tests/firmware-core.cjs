// Run: node tests/firmware-core.cjs — synthetic data only.
// 覆盖: 固件核心(js/firmware-core.js)的包头与 pcp.js FirmwareParser 互认、原始固件 / 升级包识别、自动升级的差分 / 压缩判定、
// 差分被拒后的回退条件、内存里生成压缩包 / 差分包、差分 Worker 调度；本机固件库(js/firmware-library.js)的去重、按版本查找、淘汰
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const C = require('../js/firmware-core.js')
const L = require('../js/firmware-library.js')

// pcp.js 是挂 window 的 IIFE，放进隔离上下文取 FirmwareParser
const pcpCtx = { window: {}, TextDecoder, TextEncoder, Uint8Array, DataView, console }
vm.createContext(pcpCtx)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pcp.js'), 'utf8'), pcpCtx)
const FirmwareParser = pcpCtx.window.FirmwareParser

// 合成原始固件：0x4000 起 4 字节时间戳 + 版本串
function rawFirmware(version, size, seed) {
	const d = new Uint8Array(size || 0x5000)
	for (let i = 0; i < d.length; i++) d[i] = (i * 31 + (seed || 0)) & 0xff
	d.fill(0, 0x4000, 0x4020)
	d.set([0x10, 0x20, 0x30, 0x40], 0x4000)
	d.set(Buffer.from(version, 'ascii'), 0x4004)
	return d
}
const fakePatch = async (oldData, newData) => {
	// 「补丁」= 旧长度(4B) + 新数据，足够检验组包，不依赖 WASM
	const out = new Uint8Array(4 + newData.length)
	out.set([oldData.length & 0xff, (oldData.length >> 8) & 0xff, (oldData.length >> 16) & 0xff, 0])
	out.set(newData, 4)
	return out
}
const tick = () => new Promise((r) => setTimeout(r, 0))

;(async function () {
	// ---- 识别：内嵌版本、原始固件、升级包、未知 ----
	{
		const raw = rawFirmware('V1.2.3')
		assert.equal(C.embeddedVersion(raw), 'V1.2.3')
		const k = C.classify(raw)
		assert.equal(k.kind, 'raw')
		assert.equal(k.version, 'V1.2.3')
		assert.equal(k.crc, C.crc32(raw))
		assert.equal(k.size, raw.length)
		assert.equal(C.classify(new Uint8Array(100)).kind, 'unknown', '太短')
		const bad = rawFirmware('V1')
		bad[0x4005] = 0x07
		assert.equal(C.embeddedVersion(bad), null, '非可见 ASCII 不猜')
		assert.equal(C.classify(bad).kind, 'unknown')
		const header = C.packFirmware({ firmwareData: raw, pkgType: C.PKG_ORIGIN })
		assert.deepEqual(C.classify(C.joinPackage(header, raw)), { kind: 'package', pkgType: 1 })
		assert.equal(C.crc32(new Uint8Array(Buffer.from('123456789'))), 0xCBF43926)
	}

	// ---- 自动升级判定：唯一一份才差分；没有设备版本 / 库里没有 / 多份不同构建都压缩；同一份重复不算多份 ----
	{
		const a = { key: 'a', crc: 1, size: 10 }
		const b = { key: 'b', crc: 2, size: 10 }
		assert.deepEqual(C.planUpgrade({ deviceVersion: '', candidates: [a] }), { mode: 'compress', reason: 'no-device-version' })
		assert.deepEqual(C.planUpgrade({ deviceVersion: '  ', candidates: [a] }), { mode: 'compress', reason: 'no-device-version' })
		assert.deepEqual(C.planUpgrade({ deviceVersion: 'V1', candidates: [] }), { mode: 'compress', reason: 'not-found' })
		assert.deepEqual(C.planUpgrade({ deviceVersion: 'V1', candidates: [a, b] }), { mode: 'compress', reason: 'ambiguous', count: 2 })
		assert.deepEqual(C.planUpgrade({ deviceVersion: 'V1', candidates: [a, Object.assign({}, a)] }).mode, 'diff')
		assert.equal(C.planUpgrade({ deviceVersion: 'V1', candidates: [a] }).base, a)
		assert.equal(C.shouldFallbackToCompress('diff', 0x07), true)
		assert.equal(C.shouldFallbackToCompress('diff', 0x08), true)
		assert.equal(C.shouldFallbackToCompress('diff', 0x05), false, '空间不足等其它原因不回退')
		assert.equal(C.shouldFallbackToCompress('compress', 0x07), false, '压缩包被拒不再回退')
		assert.equal(C.shouldFallbackToCompress('diff', null), false)
	}

	// ---- 内存里生成升级包：包头被 FirmwareParser 认可，类型、旧/新 CRC、版本都对 ----
	{
		const oldFw = rawFirmware('V1.0.0', 0x5000, 1)
		const newFw = rawFirmware('V1.1.0', 0x5100, 2)
		const diff = await C.buildPackage('diff', newFw, oldFw, fakePatch)
		const pd = FirmwareParser.parse(diff.buffer)
		assert.equal(pd.ok, true, pd.error)
		assert.equal(pd.header.pkgType, 3)
		assert.equal(pd.version, 'V1.1.0')
		assert.equal(pd.header.oldFileCRC32, C.crc32(oldFw))
		assert.equal(pd.header.oldFileSize, oldFw.length)
		assert.equal(pd.header.newFileCRC32, C.crc32(newFw))
		assert.equal(pd.header.newFileSize, newFw.length)
		assert.equal(pd.firmwareData.length, 128 + 4 + newFw.length)

		const comp = await C.buildPackage('compress', newFw, C.BLANK_BUILTIN, fakePatch)
		const pc = FirmwareParser.parse(comp.buffer)
		assert.equal(pc.ok, true, pc.error)
		assert.equal(pc.header.pkgType, 2)
		assert.equal(pc.header.oldFileCRC32, C.crc32(C.BLANK_BUILTIN))
		assert.equal(pc.version, 'V1.1.0')

		await assert.rejects(C.buildPackage('origin', newFw, oldFw, fakePatch), /未知的升级包类型/)
		await assert.rejects(C.buildPackage('diff', newFw, null, fakePatch), /差分基准/)
		await assert.rejects(C.buildPackage('compress', new Uint8Array(0), C.BLANK_BUILTIN, fakePatch), /新固件/)
		await assert.rejects(C.buildPackage('diff', newFw, oldFw, async () => { throw new Error('wasm oom') }), /wasm oom/)
	}

	// ---- 差分 Worker 调度：只转移副本、一次一个任务、出错与超时都释放、dispose 拒绝在途任务 ----
	{
		const made = []
		class FakeWorker {
			constructor(url) { this.url = url; this.terminated = false; made.push(this) }
			postMessage(msg, transfer) { this.msg = msg; this.transfer = transfer }
			terminate() { this.terminated = true }
			reply(data) { this.onmessage({ data }) }
		}
		let done = null
		const r = C.createDiffRunner('w.js', { Worker: FakeWorker, timeoutMs: 30, onDone: (x) => { done = x } })
		const oldD = new Uint8Array([1, 2, 3])
		const newD = new Uint8Array([4, 5])
		const p = r.createPatch(oldD, newD)
		assert.equal(made.length, 1)
		assert.equal(made[0].url, 'w.js')
		assert.deepEqual(Array.from(oldD), [1, 2, 3], '输入不被转移')
		await assert.rejects(r.createPatch(oldD, newD), /正在执行/)
		made[0].reply({ patch: new Uint8Array([9, 9]).buffer, ms: 12 })
		assert.deepEqual(Array.from(await p), [9, 9])
		assert.deepEqual(done, { ms: 12, size: 2 })
		// 复用同一个 Worker
		const p2 = r.createPatch(oldD, newD)
		assert.equal(made.length, 1)
		made[0].reply({ error: 'bad input' })
		await assert.rejects(p2, /bad input/)
		// Worker 出错：释放并拒绝，下次重建
		const p3 = r.createPatch(oldD, newD)
		made[0].onerror()
		await assert.rejects(p3, /加载或执行失败/)
		assert.equal(made[0].terminated, true)
		const p4 = r.createPatch(oldD, newD)
		assert.equal(made.length, 2)
		// 超时
		await assert.rejects(p4, /超时/)
		assert.equal(made[1].terminated, true)
		// dispose 拒绝在途任务
		const p5 = r.createPatch(oldD, newD)
		r.dispose()
		await assert.rejects(p5, /已结束/)
		assert.equal(made[2].terminated, true)
		r.dispose()
	}

	// ---- 固件库：没有内嵌版本不收、按 crc+大小去重、按版本找、按最近使用淘汰且不淘汰刚加入的 ----
	{
		let t = 1000
		const lib = L.createLibrary(L.memoryStore(), { maxEntries: 3, maxBytes: 1 << 30, now: () => t++ })
		assert.equal(await lib.add('x.bin', new Uint8Array(64)), null)
		const v1 = rawFirmware('V1.0.0', 0x5000, 1)
		const r1 = await lib.add('V1.0.0_a.bin', v1)
		assert.equal(r1.version, 'V1.0.0')
		assert.equal(r1.key, L.keyOf(C.crc32(v1), v1.length))
		const again = await lib.add('renamed.bin', v1)
		assert.equal(again.key, r1.key)
		assert.equal((await lib.summary()).count, 1, '同一份只存一次')
		v1[0] ^= 0xff
		const stored = (await lib.findByVersion('V1.0.0'))[0]
		assert.equal(C.crc32(stored.data), r1.crc, '库里存的是副本，调用方改原数组不影响')
		v1[0] ^= 0xff
		const v1b = rawFirmware('V1.0.0', 0x5000, 7)
		await lib.add('V1.0.0_b.bin', v1b)
		assert.equal((await lib.findByVersion('V1.0.0')).length, 2, '同版本不同构建都留着(判定时算多份)')
		assert.equal((await lib.findByVersion(' V1.0.0 ')).length, 2)
		assert.equal((await lib.findByVersion('V9')).length, 0)
		const v2 = rawFirmware('V2.0.0', 0x5000, 3)
		await lib.add('v2.bin', v2)
		await lib.touch(r1.key) // r1 变成最近使用，最旧的是 v1b
		const v3 = rawFirmware('V3.0.0', 0x5000, 4)
		const r3 = await lib.add('v3.bin', v3)
		assert.equal(r3.evicted, 1)
		const versions = (await Promise.all(['V1.0.0', 'V2.0.0', 'V3.0.0'].map((v) => lib.findByVersion(v)))).map((l) => l.length)
		assert.deepEqual(versions, [1, 1, 1])
		assert.equal((await lib.findByVersion('V1.0.0'))[0].key, r1.key, '淘汰的是最久未用的 v1b')
		await lib.clear()
		assert.deepEqual(await lib.summary(), { count: 0, bytes: 0 })

		// 字节上限：单份超上限时也保留刚加入的那份
		const tiny = L.createLibrary(L.memoryStore(), { maxEntries: 10, maxBytes: 0x5000, now: () => t++ })
		await tiny.add('a', rawFirmware('A', 0x5000, 1))
		const rb = await tiny.add('b', rawFirmware('B', 0x6000, 2))
		assert.equal(rb.evicted, 1)
		assert.equal((await tiny.findByVersion('B')).length, 1)
		assert.deepEqual(L.selectEvictions([{ key: 'k', size: 1, usedAt: 0 }], { maxEntries: 0.5, maxBytes: 1 }, 'k'), [], 'keepKey 永不淘汰')
	}

	// ---- 信息区边界：0x401F 太短不识别；恰好 0x4020 识别且包头版本不丢 ----
	{
		const mk = (len) => { const d = rawFirmware('V7.7.7', 0x5000, 5).slice(0, len); return d }
		assert.equal(C.classify(mk(0x401f)).kind, 'unknown')
		for (const len of [0x4020, 0x4021]) {
			const raw = mk(len)
			assert.equal(C.classify(raw).version, 'V7.7.7')
			const p = FirmwareParser.parse((await C.buildPackage('compress', raw, C.BLANK_BUILTIN, fakePatch)).buffer)
			assert.equal(p.ok, true)
			assert.equal(p.version, 'V7.7.7', '长度 ' + len.toString(16) + ' 的包头版本')
		}
	}

	// ---- 固件库并发：修改是原子读改写，并发加入不超上限；淘汰后迟到的 touch 不写回；clear 与 add 按发起顺序生效 ----
	{
		let t = 1
		const lib = L.createLibrary(L.memoryStore(), { maxEntries: 20, maxBytes: 1 << 30, now: () => t++ })
		for (let i = 0; i < 19; i++) await lib.add('f' + i, rawFirmware('P' + i, 0x4100, i))
		await Promise.all([lib.add('x', rawFirmware('X', 0x4100, 101)), lib.add('y', rawFirmware('Y', 0x4100, 102))])
		assert.equal((await lib.summary()).count, 20, '19 + 并发 2 份 → 仍是 20')
		await Promise.all([lib.add('z1', rawFirmware('Z1', 0x4100, 103)), lib.add('z2', rawFirmware('Z2', 0x4100, 104))])
		assert.equal((await lib.summary()).count, 20, '满 20 时并发 2 份 → 仍是 20')
		assert.equal((await lib.findByVersion('Z1')).length + (await lib.findByVersion('Z2')).length, 2, '新加入的都在')
		const victim = (await lib.findByVersion('P3'))[0]
		assert.ok(victim)
		const victimKey = victim.key
		// 再挤掉最旧的几份(P3 在其中)，之后对它 touch 不能把它写回来
		for (let i = 0; i < 3; i++) await lib.add('w' + i, rawFirmware('W' + i, 0x4100, 200 + i))
		assert.equal((await lib.findByVersion('P3')).length, 0)
		await lib.touch(victimKey)
		assert.equal((await lib.findByVersion('P3')).length, 0, '已淘汰的记录不被 touch 写回')
		assert.equal((await lib.summary()).count, 20)
		// clear 与 add 并发：按发起顺序，先清后加 → 只剩新加的一份
		await Promise.all([lib.clear(), lib.add('after', rawFirmware('AFTER', 0x4100, 300))])
		assert.equal((await lib.summary()).count, 1)
		assert.equal((await lib.findByVersion('AFTER')).length, 1)
		// planAdd 纯函数：同一份重复加入保留原数据与加入时间
		const e = { key: 'k', crc: 1, size: 3, version: 'V', name: 'n2', data: new Uint8Array([9]) }
		const first = { key: 'k', crc: 1, size: 3, version: 'V', name: 'n1', addedAt: 5, usedAt: 5, data: new Uint8Array([1]) }
		const pl = L.planAdd([first], e, { maxEntries: 5, maxBytes: 100 }, 9)
		assert.equal(pl.rec.addedAt, 5)
		assert.equal(pl.rec.usedAt, 9)
		assert.equal(pl.rec.data, first.data)
		assert.equal(pl.rec.name, 'n2')
		assert.deepEqual(pl.remove, [])
	}

	console.log('firmware-core: ok')
})().catch((e) => { console.error(e); process.exit(1) })
