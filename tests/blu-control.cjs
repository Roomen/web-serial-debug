// Run: node tests/blu-control.cjs — synthetic data only, no BLU hardware.
// 直接截取 js/blu-power.js 里的生产函数(队列 / 写绑定 / 上下电 / 电压 / 采样启停 / 摘要)在假 DOM 与假设备上跑，
// 覆盖：电压写失败绝不上电、写失败把供电标成 unknown、电压写失败不把请求值当成已生效、
// 写入完成后连接已变化(重连/换设备)不算到新连接、取消在电压与上电之间生效、
// 存储初始化(Store.init)期间断开或取消不再开始采样、摘要按模式取样点数与能量口径。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../js/blu-power.js'), 'utf8')
const protocolSrc = fs.readFileSync(path.join(__dirname, '../js/blu-protocol.js'), 'utf8')

function slice(start, end) {
	const a = source.indexOf(start)
	const b = source.indexOf(end, a)
	assert.ok(a >= 0 && b > a, 'anchor exists: ' + start)
	return source.slice(a, b)
}

const parts = [
	slice('\twindow.bluApi = {', '\t// SerialPort → SN'),
	slice('\tlet bluOpChain = Promise.resolve()', '\t// 连接代次：打开与关闭都会推进'),
	slice('\tfunction bluConnGen() {', '\tlet bluReader = null'),
	slice('\tasync function bluWriteOn(port, gen, data, note) {', '\tasync function bluWrite(data, note) {'),
	slice('\tasync function bluWrite(data, note) {', '\t// on: true/false = 已知状态'),
	slice('\tfunction markPowered(on, source) {', '\t// 打开设备时判定 DUT 是否在供电。'),
	slice('\tasync function guardStart(guard) {', '\tfunction powerPayload() {'),
	slice('\tfunction powerPayload() {', '\tasync function fetchAndApplyModifiers() {'),
	slice('\tasync function startSampling(guard) {', '\tfunction acqEdgeLabel(mode) {'),
	slice('\tfunction overallStats() {', '\tfunction updateStats() {'),
].join('\n')

function makeHarness(opts) {
	opts = opts || {}
	const logs = []
	const writes = []
	const calls = []
	const state = {
		bluOpen: true,
		bluPort: null,
		bluReadGen: 7,
		bluSampling: false,
		setVoltageMv: 3300,
		captureVoltageChanges: 0,
		recordMode: 'wave',
		targetRateHz: 1000,
		deviceStreamHz: 100000,
		samplePeriodSec: 0.001,
		storageStop: false,
		ringCount: 0,
		totalCount: 0,
		overallStatDirty: true,
		overallStatCache: null,
		longStats: { n: 0, sumI: 0, minI: Infinity, maxI: -Infinity, energyUAs: 0, t0: 0, tLast: 0 },
		writeDelay: 0,
		writeResult: 'ok',
		bluPower: { on: null, source: 'unknown' },
		bluPowered: false,
	}

	function makePort(id) {
		return {
			id,
			writable: {
				getWriter() {
					return {
						write(bytes) {
							writes.push({ id, bytes: Array.from(bytes) })
							return new Promise((resolve, reject) => {
								const finish = () => {
									if (state.writeResult === 'throw') reject(new Error('synthetic write failure'))
									else resolve()
								}
								if (state.writeDelay > 0) setTimeout(finish, state.writeDelay)
								else finish()
							})
						},
						releaseLock() {},
					}
				},
			},
		}
	}
	state.port = makePort('p1')

	const win = { APP_VERSION: 'test' }
	const ctx = {
		window: win,
		console,
		setTimeout,
		clearTimeout,
		Promise,
		Math,
		Number,
		isFinite,
		Uint8Array,
		Float32Array,
		Float64Array,
		Date,
		E: () => null,
		bluLog: (msg, level) => logs.push({ msg, level: level || '' }),
		get bluOpen() { return state.bluOpen },
		set bluOpen(v) { state.bluOpen = v },
		get bluPort() { return state.bluPort },
		set bluPort(v) { state.bluPort = v },
		get bluReadGen() { return state.bluReadGen },
		set bluReadGen(v) { state.bluReadGen = v },
		get bluSampling() { return state.bluSampling },
		set bluSampling(v) { state.bluSampling = v },
		get bluPowered() { return state.bluPowered },
		set bluPowered(v) { state.bluPowered = v },
		get bluPower() { return state.bluPower },
		set bluPower(v) { state.bluPower = v },
		get setVoltageMv() { return state.setVoltageMv },
		set setVoltageMv(v) { state.setVoltageMv = v },
		get captureVoltageChanges() { return state.captureVoltageChanges },
		set captureVoltageChanges(v) { state.captureVoltageChanges = v },
		get recordMode() { return state.recordMode },
		set recordMode(v) { state.recordMode = v },
		get targetRateHz() { return state.targetRateHz },
		set targetRateHz(v) { state.targetRateHz = v },
		get deviceStreamHz() { return state.deviceStreamHz },
		set deviceStreamHz(v) { state.deviceStreamHz = v },
		get samplePeriodSec() { return state.samplePeriodSec },
		set samplePeriodSec(v) { state.samplePeriodSec = v },
		get storageStop() { return state.storageStop },
		set storageStop(v) { state.storageStop = v },
		get ringCount() { return state.ringCount },
		set ringCount(v) { state.ringCount = v },
		get overallStatDirty() { return state.overallStatDirty },
		set overallStatDirty(v) { state.overallStatDirty = v },
		get overallStatCache() { return state.overallStatCache },
		set overallStatCache(v) { state.overallStatCache = v },
		get longStats() { return state.longStats },
		set longStats(v) { state.longStats = v },
		get bluOpening() { return false },
		readSetVoltageMv: () => state.setVoltageMv,
		syncVoltageInput: () => {},
		scheduleUIUpdate: () => {},
		setVoltageV: () => (state.setVoltageMv || 0) / 1000,
		dataCount: () => state.totalCount,
		calcStats: () => Object.assign({ n: 0, avgI: 0, avgP: 0, minI: 0, maxI: 0, dur: 0 }, state.statsOverride || {}),
		enrichStats: (st) => st,
		emptyStats: () => ({ n: 0, avgI: 0, avgP: 0, minI: 0, maxI: 0, dur: 0 }),
		// 采样启停依赖的波形/存储状态：全部做成空实现，只关心 guard / 代次 / 命令顺序
		applyRatePreset: () => ({ label: 'test' }),
		clearAllData: () => { calls.push('clearAllData') },
		drainSampleRx: () => Promise.resolve(),
		dropSampleStream: false,
		parser: { reset() {}, resetStats() {} },
		converter: { resetFilter() {} },
		rateAdj: { reset() {}, setTargetRateHz() {} },
		view: {},
		setScrollPaused: () => {},
		updateSampleBtn: () => {},
		startStallWatch: () => {},
		stopStallWatch: () => {},
		requestWakeLock: () => {},
		releaseWakeLock: () => {},
		updateStorageUsage: () => {},
		getRatePreset: () => ({ label: 'test' }),
		estimateDurationSec: () => 1,
		fmtGb: (n) => String(n),
		fmtDuration: () => '1s',
		fmtCurrent: (v) => String(v),
		acqTrigStart: 'off',
		acqTrigStop: 'off',
		acqTrigStoreEnabled: true,
		acqTrigStopPending: false,
		acqTrigStartLatched: false,
		acqTrigStartState: 0,
		acqTrigStopState: 0,
		acqPreMin: Infinity,
		acqPreMax: -Infinity,
		scopeTrigLevelAuto: true,
		scopeTrigLevelUA: 0,
		warmupLeft: 0,
		warmupLeftSet: 0,
		RX_DRAIN_MS: 50,
		WARMUP_MAX_SAMPLES: 1000,
		WARMUP_SEC: 0.1,
		RING_CAP_MAX: 1000,
		metaCollecting: false,
		metaCollectBuf: '',
		modifiersOk: true,
		storageCfg: { ramGB: 1, diskGB: 0 },
		resyncSeen: 0,
		resyncLogTs: 0,
		lockLogged: false,
		lossLogged: false,
		rawCapLen: 0,
		rawCapArm: () => 0,
		rawCapDump: () => null,
		rawCapStats: () => ({}),
	}
	ctx.warmupLeft = 0
	ctx.Store = opts.store || null
	ctx.localStorage = { getItem: () => null, setItem: () => {} }
	vm.createContext(ctx)
	vm.runInContext(protocolSrc, ctx)
	ctx.PROTO = ctx.window.BluProtocol
	ctx.bluPort = state.port
	vm.runInContext(parts, ctx)
	ctx.bluPort = state.port

	return {
		ctx,
		state,
		writes,
		logs,
		calls,
		api: ctx.window.bluApi,
		async run(fn) { return fn() },
	}
}

const settle = () => new Promise((r) => setImmediate(r))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('上电：电压写失败时绝不下发上电命令', async () => {
	const h = makeHarness()
	h.state.writeResult = 'throw'
	const r = await h.ctx.doPowerOn()
	assert.equal(r.ok, false)
	assert.equal(r.code, 'voltage_write_failed')
	assert.equal(h.writes.length, 1, '只尝试过电压写入')
	assert.equal(h.ctx.powerPayload().state, 'unknown')
})

test('上电：电压成功后写 DUT 上电，状态记为 commanded', async () => {
	const h = makeHarness()
	const r = await h.ctx.doPowerOn()
	assert.equal(r.ok, true)
	assert.equal(h.writes.length, 2)
	assert.equal(h.writes[0].bytes[0], h.ctx.PROTO.cmdRegulatorSet(3300)[0])
	assert.deepEqual(h.writes[1].bytes, Array.from(h.ctx.PROTO.cmdDutPower(true)))
	assert.equal(h.ctx.powerPayload().state, 'on')
	assert.equal(h.ctx.powerPayload().source, 'commanded')
})

test('上电写失败：不谎称已上电，状态标成 unknown', async () => {
	const h = makeHarness()
	h.state.writeResult = 'ok'
	// 第一次(电压)成功，第二次(上电)失败
	let n = 0
	const port = h.state.port
	port.writable.getWriter = () => ({
		write(bytes) {
			h.writes.push({ id: port.id, bytes: Array.from(bytes) })
			n++
			return n === 1 ? Promise.resolve() : Promise.reject(new Error('synthetic power write failure'))
		},
		releaseLock() {},
	})
	const r = await h.ctx.doPowerOn()
	assert.equal(r.ok, false)
	assert.equal(r.code, 'power_write_failed')
	assert.equal(r.executed, 'unknown')
	assert.equal(h.ctx.powerPayload().state, 'unknown')
	assert.equal(h.ctx.powerPayload().source, 'unknown')
})

test('下电写失败：同样标 unknown，不保留上一次 commanded', async () => {
	const h = makeHarness()
	h.ctx.markPowered(true, 'commanded')
	h.state.writeResult = 'throw'
	const r = await h.ctx.doPowerOff()
	assert.equal(r.ok, false)
	assert.equal(r.executed, 'unknown')
	assert.equal(h.ctx.powerPayload().state, 'unknown')
})

test('电压写失败：不把请求值当成已生效', async () => {
	const h = makeHarness()
	h.state.writeResult = 'throw'
	const r = await h.ctx.applyVoltageMv(1800)
	assert.equal(r.ok, false)
	assert.equal(r.stale, false)
	assert.equal(h.state.setVoltageMv, 3300, '仍保持上一次有效电压')
})

test('写入完成后连接已变化：不把结果算到新连接，也不改它的供电状态', async () => {
	const h = makeHarness()
	h.state.writeDelay = 20
	const port = h.state.port
	const pending = h.ctx.doPowerOn()
	await wait(5)
	// 写入还没完成时断开并换到新设备(代次推进)，新连接自己的供电状态是「已知下电」
	h.state.bluReadGen += 1
	h.state.bluPort = { id: 'p2', writable: port.writable }
	h.ctx.markPowered(false, 'commanded')
	const r = await pending
	assert.equal(r.ok, false)
	assert.equal(r.code, 'disconnected')
	assert.equal(r.executed, 'unknown')
	// 新连接的状态必须原样保留，不能被旧连接的上电失败改成 unknown
	assert.equal(h.ctx.powerPayload().state, 'off')
	assert.equal(h.ctx.powerPayload().source, 'commanded')
})

test('取消发生在电压与上电之间：不再上电', async () => {
	const h = makeHarness()
	let step = 0
	const guard = {
		start: () => Promise.resolve(null),
		step: () => {
			step++
			return step >= 2 ? { ok: false, code: 'aborted', message: '请求已取消，未上电', executed: false } : null
		},
	}
	const r = await h.ctx.doPowerOn(guard)
	assert.equal(r.ok, false)
	assert.equal(r.code, 'aborted')
	assert.equal(h.writes.length, 1, '只写入了电压')
	assert.equal(h.ctx.powerPayload().state, 'unknown')
})

test('存储初始化期间断开：不开始采样、不发 START', async () => {
	const store = { init: () => { h.state.bluReadGen += 1; return Promise.resolve() } }
	const h = makeHarness({ store: store })
	h.ctx.Store = store
	h.state.recordMode = 'wave'
	const r = await h.ctx.startSampling()
	assert.equal(r.ok, false)
	assert.equal(r.code, 'disconnected')
	assert.equal(h.state.bluSampling, false)
	assert.equal(h.writes.filter((w) => w.bytes[0] === h.ctx.PROTO.cmdAverageStart()[0]).length, 0)
})

test('存储初始化期间取消：不开始采样', async () => {
	let step = 0
	const store = { init: () => Promise.resolve() }
	const h = makeHarness({ store: store })
	h.ctx.Store = store
	h.state.recordMode = 'wave'
	const guard = {
		start: () => Promise.resolve(null),
		step: () => {
			step++
			return step >= 2 ? { ok: false, code: 'aborted', message: '请求已取消，未开始采样', executed: false } : null
		},
	}
	const r = await h.ctx.startSampling(guard)
	assert.equal(r.ok, false)
	assert.equal(r.code, 'aborted')
	assert.equal(h.state.bluSampling, false)
	assert.equal(h.writes.filter((w) => w.bytes[0] === h.ctx.PROTO.cmdAverageStart()[0]).length, 0)
})

test('正常开始采样：STOP 排空 → START，状态为采样中', async () => {
	const h = makeHarness()
	const r = await h.ctx.startSampling()
	assert.equal(r.ok, true)
	assert.equal(h.state.bluSampling, true)
	assert.deepEqual(h.writes.map((w) => w.bytes[0]), [h.ctx.PROTO.cmdAverageStop()[0], h.ctx.PROTO.cmdAverageStart()[0]])
})

test('摘要：长期模式样点数取 longStats，能量不拿当前电压凑', async () => {
	const h = makeHarness()
	h.state.recordMode = 'long'
	h.state.totalCount = 0
	h.state.longStats = { n: 5, sumI: 500, minI: 10, maxI: 200, energyUAs: 250, t0: 0, tLast: 0.4 }
	const s = h.ctx.captureSummary()
	assert.equal(s.ready, true, '长期模式样点不进波形环，也要能出摘要')
	assert.equal(s.totalSamples, 5)
	assert.equal(s.retainedSamples, 5)
	assert.equal(s.span, 'full_session')
	assert.equal(s.energyUWh, null)
	assert.equal(s.energySource, 'unavailable')
	assert.equal(s.chargeUC, 250)
})

test('摘要：波形模式被淘汰时标 retained，能量来自存储累加', async () => {
	const h = makeHarness()
	h.state.recordMode = 'wave'
	h.state.totalCount = 200
	h.state.ringCount = 100
	h.state.statsOverride = { n: 100, avgI: 1000, avgP: 3300, minI: 10, maxI: 2000, dur: 1, energyUWh: 3300 }
	const s = h.ctx.captureSummary()
	assert.equal(s.ready, true)
	assert.equal(s.totalSamples, 200)
	assert.equal(s.retainedSamples, 100)
	assert.equal(s.span, 'retained')
	assert.equal(s.energyUWh, 3300)
	assert.equal(s.energySource, 'stored_chunk_sums')
})

test('摘要：没采到样点时 ready=false 且说明原因', async () => {
	const h = makeHarness()
	h.state.totalCount = 0
	h.state.ringCount = 0
	h.ctx.overallStatCache = { n: 0, avgI: 0, avgP: 0, minI: 0, maxI: 0, dur: 0 }
	const s = h.ctx.captureSummary()
	assert.equal(s.ready, false)
	assert.equal(s.reason, 'no_samples')
	h.state.bluOpen = false
	assert.equal(h.ctx.captureSummary().reason, 'blu_not_connected')
})

test('setPower 幂等只认「上次命令」：实测/未知状态照样下发命令', async () => {
	const h = makeHarness()
	h.ctx.markPowered(true, 'probed')
	const r = await h.api.setPower(true)
	assert.equal(r.ok, true)
	assert.ok(h.writes.some((w) => w.bytes[0] === h.ctx.PROTO.cmdDutPower(true)[0]), 'probed 不足以跳过命令')
	assert.equal(h.ctx.powerPayload().state, 'on')
	assert.equal(h.ctx.powerPayload().source, 'commanded')
	const again = await h.api.setPower(true)
	assert.equal(again.changed, false, 'commanded 相同状态才跳过')
	assert.equal(h.writes.filter((w) => w.bytes[0] === h.ctx.PROTO.cmdDutPower(true)[0]).length, 1)
})

test('功耗仪队列：MCP 的 failFast 不会排在正在执行的操作后面', async () => {
	const h = makeHarness()
	h.state.writeDelay = 30
	const slow = h.api.setVoltage(3500, { start: () => Promise.resolve(null), step: () => null })
	await wait(2)
	const busy = await h.api.setPower(false, { start: () => Promise.resolve(null), step: () => null })
	assert.equal(busy.ok, false)
	assert.equal(busy.code, 'blu_busy')
	await slow
})

;(async () => {
	let failed = 0
	for (const t of tests) {
		try {
			await t.fn()
			console.log('ok   ' + t.name)
		} catch (e) {
			failed++
			console.error('FAIL ' + t.name)
			console.error(e)
		}
	}
	if (failed) {
		console.error(failed + ' failed')
		process.exit(1)
	}
	console.log('all ' + tests.length + ' passed')
})()
