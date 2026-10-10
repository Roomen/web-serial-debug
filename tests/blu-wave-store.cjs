'use strict'
// 功耗波形分块存储(js/blu-power.js 里 `// <<< 波形存储` 到 `// ---- 视图状态 ----` 一段，按这两个锚点截取，别删)的资源回归：
// 停采后宽视图不再反复读盘、归档队列受内存上限约束、包络与原始数据一致、包络缓存只留视口附近的桶。
// 磁盘存储是假的，只用合成数据。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '../js/blu-power.js'), 'utf8')
const a = source.indexOf('\t// <<< 波形存储')
const b = source.indexOf('\t// ---- 视图状态 ----', a)
assert.ok(a > 0 && b > a, '找不到波形存储段的锚点')
const body = source.slice(a, b).replace('function updateStorageHint() {', 'function updateStorageHint() { return')

function makeStore() {
	const disk = new Map()
	const st = {
		reads: 0,
		gate: null,
		readGate: null,
		clearGate: null,
		disk,
		events: [],
		init: async () => {},
		getBackend: () => 'opfs',
		getDiskUsed: () => { let n = 0; disk.forEach(function (v) { n += v.length * 4 }); return n },
		writeChunk: async (id, s) => {
			st.events.push('write:' + id)
			if (st.gate) await st.gate
			disk.set(id, new Float32Array(s))
			return { byteSize: s.length * 4 }
		},
		readChunk: async (id) => { st.reads++; const buf = disk.get(id); if (st.readGate) await st.readGate; return buf },
		removeChunk: async (id) => { disk.delete(id) },
		clearSession: async () => { st.events.push('clear'); if (st.clearGate) await st.clearGate; disk.clear() },
	}
	return st
}

function load(store) {
	const logs = []
	let stops = 0
	const ctx = {
		window: { BluWaveStore: store }, localStorage: { getItem: () => JSON.stringify({ ramGB: 0.25, diskGB: 4 }), setItem() {} },
		Float32Array, Float64Array, Map, Set, Math, console, setTimeout, Promise, isFinite, Infinity, JSON, String, parseInt, parseFloat, Number,
		E: () => null, bluLog: (m) => logs.push(m), scheduleUIUpdate() {}, setVoltageV: () => 3.3, stopSampling() { stops++ },
		recordMode: 'wave', longStats: { n: 0 }, samplePeriodSec: 1e-5, bluSampling: true, fmtGb: (x) => x,
	}
	vm.createContext(ctx)
	vm.runInContext(body + `
		globalThis.T = { ringPush, ringReset, ringIAt, findChunkAt, calcStats, getBucketEntry,
			chunks: waveChunks, queue: archiveQueue, bucketCache, pruneBucketCache,
			cache: hydrateCache, pending: hydratePending,
			state: function () { return { totalCount, hotCount, coldCount, archiveQueuedSamples, storageStop } },
			setCap: function (n) { RING_CAP_MAX = n }, frameReset: function () { frameHydrateIds.clear() } }`, ctx)
	return { T: ctx.T, logs, stops: () => stops }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const wave = (i) => Math.sin((i % 65536) / 50) * 100 + 200
const CHUNK = 65536
const deferred = () => {
	let resolve, reject
	const promise = new Promise((res, rej) => { resolve = res; reject = rej })
	return { promise, resolve, reject }
}
const settle = async () => { for (let k = 0; k < 5; k++) await tick() }

;(async function () {
	{
		const store = makeStore()
		const { T } = load(store)
		T.setCap(CHUNK * 4)
		// 按批到达(批间让出，归档才能写盘)，64 块里 60 块落盘
		for (let c = 0; c < 64; c++) {
			for (let i = 0; i < CHUNK; i++) T.ringPush(wave(i))
			for (let k = 0; k < 5; k++) await tick()
		}
		for (let k = 0; k < 50; k++) await tick()
		assert.equal(T.chunks.filter((c) => c.state === 'cold').length, 60)
		const count = CHUNK * 60

		const frames = async function (bs, n) {
			const before = store.reads
			const out = []
			for (let f = 0; f < n; f++) {
				T.frameReset()
				for (let bi = 0; bi * bs < count; bi++) T.getBucketEntry(bi, bs, 0, count - 1)
				for (let k = 0; k < 5; k++) await tick()
				out.push(store.reads - before)
			}
			return out
		}
		// 桶不比包络组细：直接用包络，不读盘
		assert.deepEqual(await frames(4096, 6), [0, 0, 0, 0, 0, 0], '宽视图不该回读冷块')
		let maxErr = 0
		for (let bi = 0; bi * 4096 < count; bi += 37) {
			const e = T.getBucketEntry(bi, 4096, 0, count - 1)
			let mn = Infinity, mx = -Infinity, sum = 0, sumSq = 0
			for (let i = bi * 4096; i < (bi + 1) * 4096; i++) {
				const v = Math.fround(wave(i))
				if (v < mn) mn = v
				if (v > mx) mx = v
				sum += v
				sumSq += v * v
			}
			maxErr = Math.max(maxErr, Math.abs(e.min - mn), Math.abs(e.max - mx))
			assert.equal(e.first, Math.fround(wave(bi * 4096)))
			assert.equal(e.last, Math.fround(wave((bi + 1) * 4096 - 1)))
			assert.ok(Math.abs(e.mean - sum / 4096) < 1e-8, '包络均值必须保留组统计')
			assert.ok(Math.abs(e.sd - Math.sqrt(sumSq / 4096 - (sum / 4096) ** 2)) < 1e-8, '包络标准差必须保留组统计')
		}
		assert.ok(maxErr < 1e-3, '包络 min/max 与原始数据偏差 ' + maxErr)
		// 桶比包络组细、横跨的冷块比回读缓存多：读满本帧额度后稳定，不再越读越多
		const fine = await frames(512, 8)
		assert.ok(fine[0] > 0, '细桶应回读一部分冷块')
		assert.deepEqual(fine.slice(1), fine.slice(1).map(() => fine[0]), '回读次数应在首帧后稳定: ' + fine.join(','))

		// 缓存命中的前半视口也必须占回读额度。仅后半有新桶时不能一批批挤出仍可见的块。
		const beforePan = store.reads
		const panReads = []
		for (let f = 0; f < 6; f++) {
			T.frameReset()
			for (let bi = 5 * CHUNK / 512; bi < 35 * CHUNK / 512; bi++) T.getBucketEntry(bi, 512, 0, count - 1)
			await settle()
			panReads.push(store.reads - beforePan)
		}
		assert.ok(panReads[0] > 0 && panReads[0] <= 5, '平移应只回读新进入额度的块')
		assert.ok(panReads.every((n) => n === panReads[0]), '部分桶命中缓存时回读也应稳定: ' + panReads)

		// 包络缓存只留视口附近
		T.bucketCache.size = 0
		T.bucketCache.map = null
		for (let start = 0; start + 1500 < count / 64; start += 300) {
			for (let bi = start; bi < start + 1500; bi++) T.getBucketEntry(bi, 64, 0, count - 1)
			T.pruneBucketCache(start, start + 1499)
		}
		assert.ok(T.bucketCache.map.size <= 1500 * 3 + 256 + 1500, '包络缓存应随视口裁剪，现有 ' + T.bucketCache.map.size)
	}

	{
		// 写盘卡住：队列到上限就停采，不能无限排队
		const store = makeStore()
		const { T, logs, stops } = load(store)
		T.setCap(CHUNK * 4)
		store.gate = new Promise(() => {})
		let pushed = 0
		for (let i = 0; i < CHUNK * 40; i++) { if (!T.ringPush(1)) break; pushed++ }
		const queued = T.state().archiveQueuedSamples
		assert.ok(queued <= 8 * CHUNK, '含正在写入的队列 ' + queued + ' 点超过上限')
		assert.equal(queued, (T.queue.length + 1) * CHUNK, '正在写入的缓冲也必须占预算')
		assert.ok(pushed < CHUNK * 40, '写盘卡住时应停采')
		assert.ok(logs.some((m) => /写盘跟不上/.test(m)), '应记录停采原因')
		T.ringReset()
		T.ringPush(19)
		await tick()
		assert.equal(stops(), 0, '清空前排队的停采回调不能停止新采集')
	}

	for (const failOldWrite of [false, true]) {
		// 清空期间旧写盘成功/失败都不能改变新会话；清盘完成之前，新写盘不得开始。
		const store = makeStore()
		const { T, stops } = load(store)
		T.setCap(CHUNK * 2)
		const oldWrite = deferred()
		const clear = deferred()
		store.gate = oldWrite.promise
		store.clearGate = clear.promise
		for (let i = 0; i < CHUNK * 3; i++) T.ringPush(7)
		await settle()
		const oldId = T.chunks[0].id
		T.ringReset()
		for (let i = 0; i < CHUNK * 3; i++) T.ringPush(19)
		const newId = T.chunks[0].id
		assert.notEqual(newId, oldId, '清空后不能复用还在飞的块 ID')
		store.gate = null
		if (failOldWrite) oldWrite.reject(new Error('synthetic write failure'))
		else oldWrite.resolve()
		await settle()
		assert.deepEqual(store.events, ['write:' + oldId, 'clear'], '清盘未完成时新归档须等待')
		assert.equal(T.state().hotCount, CHUNK * 2)
		assert.equal(T.state().coldCount, CHUNK)
		assert.equal(T.state().storageStop, false)
		assert.equal(stops(), 0, '旧归档失败不能停止新采集')
		clear.resolve()
		await settle()
		assert.deepEqual([...store.disk.keys()], [newId], '旧归档不能残留在新磁盘会话')
		assert.equal(store.disk.get(newId)[0], 19)
		assert.equal(T.state().archiveQueuedSamples, 0)
		assert.equal(T.ringIAt(CHUNK * 2), 19)
	}

	{
		const store = makeStore()
		const { T } = load(store)
		T.setCap(CHUNK * 2)
		for (let i = 0; i < CHUNK * 3; i++) T.ringPush(7)
		await settle()
		const oldId = T.chunks[0].id
		const read = deferred()
		store.readGate = read.promise
		T.ringIAt(0)
		assert.ok(T.pending.has(oldId))
		T.ringReset()
		T.ringPush(19)
		read.resolve()
		await settle()
		assert.equal(T.cache.size, 0, '清空前的回读不能重新填进缓存')
		assert.equal(T.pending.size, 0)
		assert.equal(T.ringIAt(0), 19)
	}

	{
		// 未满块归档产生不同块长；索引必须按 base 而非固定 CHUNK_SIZE 推断。
		const store = makeStore()
		const { T } = load(store)
		T.setCap(31)
		for (let k = 0; k < 4; k++) {
			for (let i = 0; i < 31; i++) T.ringPush(k * 100 + i)
			await settle()
		}
		for (const i of [0, 30, 31, 61, 62, 92, 93, 123]) {
			const loc = T.findChunkAt(i)
			assert.equal(loc.index, Math.floor(i / 31))
			assert.equal(loc.off, i % 31)
		}
		assert.equal(T.findChunkAt(124), null)
		assert.equal(T.calcStats(93, 124).avgI, 315)
		const env = T.getBucketEntry(0, 16, 0, 123)
		assert.equal(env.min, 0)
		assert.equal(env.max, 30, '未回读的小桶应保留组包络极值')
		await settle()
		T.frameReset()
		const precise = T.getBucketEntry(0, 16, 0, 123)
		assert.equal(precise.max, 15, '回读后应替换近似包络')
	}

	console.log('blu-wave-store: ok')
})().catch(function (e) { console.error(e); process.exit(1) })
