;// BLU 100k 功耗分析 — Web Serial + 波形/统计/长期模式
// 协议：js/blu-protocol.js；波形策略参考 Nordic pc-nrfconnect-ppk（min/max 包络、Live、minimap、log Y）
(function () {
	'use strict'

	const PROTO = window.BluProtocol
	if (!PROTO) {
		console.error('[blu-power] 依赖 BluProtocol 未加载')
		return
	}

	const DEFAULT_VIEW_POINTS = 2000
	// 顶部大数字刷新：过快会看不清，约 2 次/秒足够
	const DIGIT_UI_HZ = 2
	const X_ZOOM_MIN = 0.005
	const X_ZOOM_MAX = 2000
	const MIN_VIEW_POINTS = 4
	const Y_ZOOM_MIN = 0.1
	const Y_ZOOM_MAX = 100
	const DRAG_THRESHOLD_PX = 4
	const PERIOD_LOCK_SEC = 10
	const LOG_FLOOR_UA = 0.2 // PPK log 友好下限 0.2 µA
	// 预热：丢掉上电/切档瞬态。原先 targetHz*2s 在 100k 下约 2s 才见波形，过长；
	// 改为约 0.25s 输出点（与 Python「约 2s@200Hz」同量级的短瞬态，但不再拖数秒）
	const WARMUP_SEC = 0.25
	const WARMUP_MAX_SAMPLES = 5000 // 高采样率上限，避免再积压十几万点
	const GAP_LOG_MS = 50 // 批间隙超过此值打日志

	const RATE_PRESETS = {
		'100k': { hz: 100000, label: '100K (尽量不抽稀)' },
		'10k': { hz: 10000, label: '10K' },
		'1k': { hz: 1000, label: '1K' },
		'100': { hz: 100, label: '100 Hz' },
		'10': { hz: 10, label: '10 Hz' },
		'1': { hz: 1, label: '1 Hz' },
	}

	function E(id) {
		return document.getElementById(id)
	}

	// ---- 串口 / 设备状态 ----
	let bluPort = null
	let bluKnownPorts = [] // getPorts() 检测到的 BLU 端口
	// SerialPort → SN（WebUSB / metadata / getInfo 扩展字段）；不再展示无意义的 VID:PID
	const bluPortSn = typeof WeakMap !== 'undefined' ? new WeakMap() : null
	const BLU_SN_STORE_KEY = 'blu-device-sn-list'
	let bluOpen = false
	let bluOpening = false
	let bluManualClose = true
	let bluSampling = false
	let bluPowered = false
	let bluReader = null
	// 修正参数 = API get_modifiers()（设备内 R/O 等），连接时自动读取；无 EMK 式人工校准
	let modifiers = PROTO.defaultModifiers()
	let modifiersOk = false
	// 源电压按 mV 配置（API REGULATOR_SET / 上位机一致），500–5000
	let setVoltageMv = 3000
	let wakeLockSentinel = null

	function setVoltageV() {
		return setVoltageMv / 1000
	}

	const converter = new PROTO.Converter(modifiers)
	const parser = new PROTO.SampleParser(converter)
	let rateAdj = new PROTO.RateAdjuster(100000, PROTO.NOMINAL_BASE_HZ)
	const minimap = new PROTO.FoldingBuffer(10000)

	let targetRateHz = 100000
	let samplePeriodSec = 1 / 100000
	let deviceStreamHz = 0
	let periodLocked = false
	let periodLogged = false
	let firstStoredTs = 0 // performance.now of first stored sample
	let sessionT0Ms = 0
	let lastPointTMs = 0
	let warmupLeft = 0
	let recordMode = 'wave' // 'wave' | 'long'
	let yAxisLog = false
	let liveMode = true // PPK Live：视口贴着最新数据

	// 原始流统计
	let rawStreamCount = 0
	let rawStreamFirstTs = 0
	let rawWinCount = 0
	let rawWinTs = 0
	let rawRateEst = 0
	let sampleRateCount = 0
	let sampleRateLastTs = 0
	let sampleRateEst = 0
	let lastSampleFrameTs = 0
	let stallTimer = 0
	let stallReported = false
	let gapLogged = false

	// 显示 EMA
	let latestCurrentUA = 0
	let dispCurrentUA = 0
	let dispInit = false
	let lastDigitTs = 0

	// 长期统计
	const longStats = {
		n: 0,
		sumI: 0,
		minI: Infinity,
		maxI: -Infinity,
		energyUAs: 0, // µA·s
		t0: 0,
		tLast: 0,
	}

	// <<< RINGBUF：仅电流 Float32；电压用设定值算功率 >>>
	const CHUNK_BITS = 16
	const CHUNK_SIZE = 1 << CHUNK_BITS
	const CHUNK_MASK = CHUNK_SIZE - 1
	const CAP_TIERS = [2097152, 8388608, 33554432]
	const CAP_HARD_MAX = 67108864
	const CAP_STORE_KEY = 'blu-ring-capacity'

	function pickCapacity() {
		let cap = CAP_TIERS[1]
		let dm = 0
		try {
			if (typeof navigator !== 'undefined' && navigator && isFinite(navigator.deviceMemory)) {
				dm = navigator.deviceMemory
			}
		} catch (e) {}
		if (dm > 0 && dm <= 2) cap = CAP_TIERS[0]
		try {
			if (typeof localStorage !== 'undefined' && localStorage) {
				const raw = parseInt(localStorage.getItem(CAP_STORE_KEY), 10)
				if (isFinite(raw) && raw > 0) cap = Math.min(CAP_HARD_MAX, raw)
			}
		} catch (e) {}
		cap = Math.floor(cap / CHUNK_SIZE) * CHUNK_SIZE
		return Math.max(CHUNK_SIZE * 2, Math.min(CAP_HARD_MAX, cap))
	}

	const RING_CAP_MAX = pickCapacity()
	const MAX_CHUNKS = RING_CAP_MAX / CHUNK_SIZE
	const chunkI = []
	const statSumI = new Float64Array(MAX_CHUNKS)
	const statSumP = new Float64Array(MAX_CHUNKS)
	const statMin = new Float64Array(MAX_CHUNKS)
	const statMax = new Float64Array(MAX_CHUNKS)
	const statN = new Float64Array(MAX_CHUNKS)
	let ringCap = 0
	let ringHead = 0
	let ringCount = 0
	let sampleCount = 0
	let growBlocked = false
	let ringEvictNoted = false

	function statResetSlot(slot) {
		statSumI[slot] = 0
		statSumP[slot] = 0
		statMin[slot] = Infinity
		statMax[slot] = -Infinity
		statN[slot] = 0
	}

	function allocChunk(slot) {
		try {
			chunkI[slot] = new Float32Array(CHUNK_SIZE)
			statResetSlot(slot)
			return true
		} catch (e) {
			growBlocked = true
			bluLog('内存不足，环缓停止扩容：' + (e.message || e), 'warn')
			return false
		}
	}

	function ringPush(curUA) {
		// 扩容到 RING_CAP_MAX，之后环形覆盖
		while (ringHead >= ringCap && ringCap < RING_CAP_MAX && !growBlocked) {
			if (!allocChunk(chunkI.length)) break
			ringCap = chunkI.length * CHUNK_SIZE
		}
		if (ringCap === 0) {
			if (!allocChunk(0)) return false
			ringCap = CHUNK_SIZE
		}
		const phys = ringHead % ringCap
		const slot = phys >> CHUNK_BITS
		const off = phys & CHUNK_MASK
		if (!chunkI[slot]) {
			if (!allocChunk(slot)) return false
			ringCap = Math.max(ringCap, chunkI.length * CHUNK_SIZE)
		}
		if (off === 0 && ringCount >= ringCap) {
			statResetSlot(slot)
			if (!ringEvictNoted) {
				ringEvictNoted = true
				bluLog('环缓已满，开始覆盖最旧数据（可降采样率或切长期统计）', 'warn')
			}
		}
		chunkI[slot][off] = curUA
		const vset = setVoltageV()
		statSumI[slot] += curUA
		statSumP[slot] += curUA * vset
		if (curUA < statMin[slot]) statMin[slot] = curUA
		if (curUA > statMax[slot]) statMax[slot] = curUA
		statN[slot]++
		ringHead++
		if (ringCount < ringCap) ringCount++
		else ringCount = ringCap
		sampleCount++
		return true
	}

	function logicalToPhys(li) {
		if (li < 0 || li >= ringCount) return -1
		return (ringHead - ringCount + li + ringCap * 4) % ringCap
	}

	function ringIAt(li) {
		const p = logicalToPhys(li)
		if (p < 0) return 0
		return chunkI[p >> CHUNK_BITS][p & CHUNK_MASK]
	}

	function ringReset() {
		ringHead = 0
		ringCount = 0
		sampleCount = 0
		ringEvictNoted = false
		for (let s = 0; s < chunkI.length; s++) statResetSlot(s)
	}

	function emptyStats() {
		return {
			n: 0, avgI: 0, avgP: 0, minI: 0, maxI: 0,
			energyUAh: 0, chargeUC: 0, chargeUAh: 0, dur: 0,
		}
	}

	// PPK: charge(µC) = average(µA) * time(s)
	function enrichStats(st) {
		if (!st || !st.n) return emptyStats()
		st.chargeUC = st.avgI * st.dur
		st.chargeUAh = st.avgI * st.dur / 3600
		st.energyUAh = st.avgI * setVoltageV() * st.dur / 3600
		// energy 用 µWh 更贴功率：E(µWh) = P_avg(µW) * t(h) = avgP * dur/3600
		st.energyUWh = st.avgP * st.dur / 3600
		return st
	}

	function fmtCharge(uC) {
		const a = Math.abs(uC)
		if (a >= 1e6) return (uC / 1e6).toFixed(3) + ' C'
		if (a >= 1e3) return (uC / 1e3).toFixed(3) + ' mC'
		if (a >= 1) return uC.toFixed(2) + ' µC'
		if (a >= 1e-3) return (uC * 1e3).toFixed(2) + ' nC'
		return uC.toFixed(2) + ' µC'
	}

	function fmtEnergyWh(uWh) {
		const a = Math.abs(uWh)
		if (a >= 1e6) return (uWh / 1e6).toFixed(3) + ' Wh'
		if (a >= 1e3) return (uWh / 1e3).toFixed(3) + ' mWh'
		if (a >= 1) return uWh.toFixed(2) + ' µWh'
		return (uWh * 1e3).toFixed(2) + ' nWh'
	}

	function scanAbs(a0, a1, acc) {
		const vset = setVoltageV()
		for (let a = a0; a < a1; a++) {
			const p = a % ringCap
			const v = chunkI[p >> CHUNK_BITS][p & CHUNK_MASK]
			acc.sumI += v
			acc.sumP += v * vset
			if (v < acc.minI) acc.minI = v
			if (v > acc.maxI) acc.maxI = v
			acc.n++
		}
	}

	function addSlotStat(slot, acc) {
		if (statN[slot] <= 0) return
		acc.sumI += statSumI[slot]
		acc.sumP += statSumP[slot]
		if (statMin[slot] < acc.minI) acc.minI = statMin[slot]
		if (statMax[slot] > acc.maxI) acc.maxI = statMax[slot]
		acc.n += statN[slot]
	}

	function calcStats(start, end) {
		if (ringCount < 1 || end <= start) return emptyStats()
		start = Math.max(0, start)
		end = Math.min(ringCount, end)
		const n = end - start
		if (n <= 0) return emptyStats()
		const base = (ringHead - ringCount + ringCap * 4) % ringCap
		const a0 = base + start
		const a1 = base + end
		const acc = { n: 0, sumI: 0, sumP: 0, minI: Infinity, maxI: -Infinity }
		let a = a0
		while (a < a1) {
			const p = a % ringCap
			const slot = p >> CHUNK_BITS
			const off = p & CHUNK_MASK
			const slotEnd = (slot + 1) * CHUNK_SIZE
			const runEnd = Math.min(a1, a + (slotEnd - p))
			if (off === 0 && runEnd - a === CHUNK_SIZE && statN[slot] === CHUNK_SIZE) {
				addSlotStat(slot, acc)
				a = runEnd
			} else {
				scanAbs(a, runEnd, acc)
				a = runEnd
			}
		}
		const dur = n > 1 ? (n - 1) * samplePeriodSec : 0
		const avgI = acc.n ? acc.sumI / acc.n : 0
		const avgP = acc.n ? acc.sumP / acc.n : 0
		return enrichStats({
			n: acc.n,
			avgI: avgI,
			avgP: avgP,
			minI: isFinite(acc.minI) ? acc.minI : 0,
			maxI: isFinite(acc.maxI) ? acc.maxI : 0,
			dur: dur,
		})
	}

	// 绘制用 min/max 分桶（PPK dataAccumulator：每像素 min/max 包络）
	const bucketCache = { size: 0, base: 0, map: null }
	function clearBucketCache() {
		bucketCache.size = 0
		bucketCache.map = null
	}

	function computeBucketSize(count, pw) {
		if (pw < 1 || count <= pw) return 1
		let bs = Math.ceil(count / pw)
		// 2 的幂，滚动相位稳定（沿用 EMK 策略）
		let p = 1
		while (p < bs) p <<= 1
		return p
	}

	function bucketMinMaxAbs(aLo, aHi) {
		let mn = Infinity
		let mx = -Infinity
		let first = 0
		let last = 0
		let got = false
		for (let a = aLo; a <= aHi; a++) {
			const p = ((a % ringCap) + ringCap) % ringCap
			const v = chunkI[p >> CHUNK_BITS][p & CHUNK_MASK]
			if (!got) { first = v; got = true }
			last = v
			if (v < mn) mn = v
			if (v > mx) mx = v
		}
		return { min: mn, max: mx, first: first, last: last, loAbs: aLo, hiAbs: aHi }
	}

	function getBucketEntry(bucketIdx, bucketSize, base, lastAbs) {
		if (bucketCache.size !== bucketSize || bucketCache.base !== base || !bucketCache.map) {
			bucketCache.size = bucketSize
			bucketCache.base = base
			bucketCache.map = new Map()
		}
		if (bucketCache.map.has(bucketIdx)) return bucketCache.map.get(bucketIdx)
		const lo = bucketIdx * bucketSize
		const hi = Math.min(lastAbs, lo + bucketSize - 1)
		if (hi < base || lo > lastAbs) return null
		const aLo = Math.max(lo, base)
		const aHi = hi
		const entry = bucketMinMaxAbs(aLo, aHi)
		bucketCache.map.set(bucketIdx, entry)
		return entry
	}

	// ---- 视图状态 ----
	const view = {
		xZoom: 1,
		xOffset: 0, // 从最新往左的逻辑偏移（live 时为 0）
		yMode: 'auto',
		yMin: 0,
		yMax: 1000,
		yZoom: 1,
		yPanOffset: 0,
		// 选择区间：绑定数据下标（PPK Selection）；Shift+拖动设置
		cursorA: null,
		cursorB: null,
	}
	let selectDrag = null // { x0, li0, x1, li1 } Shift 拖选预览
	let cursorEdgeDrag = null // { edge: 'a'|'b' } 拖游标边界微调
	let minimapDrag = false // 总览条拖动定位中
	let scrollPaused = false
	let waveFullscreen = false
	const CURSOR_HIT_PX = 8 // 游标线可点选/拖动的半宽
	let yAutoTargetMin = null
	let yAutoTargetMax = null
	let yAutoDispMin = null
	let yAutoDispMax = null
	let plotLayout = null
	let hover = null
	let drag = null
	let logPinned = false
	let overallStatCache = null
	let overallStatDirty = true

	function resetYAuto() {
		yAutoTargetMin = null
		yAutoTargetMax = null
		yAutoDispMin = null
		yAutoDispMax = null
	}

	// ---- 日志 / 状态 ----
	function bluLog(msg, level) {
		const box = E('blu-log')
		const last = E('blu-log-last')
		const line = document.createElement('div')
		line.className = 'blu-log-line' + (level ? ' blu-log-' + level : '')
		const ts = new Date().toLocaleTimeString()
		line.textContent = '[' + ts + '] ' + msg
		if (box) {
			box.appendChild(line)
			if (logPinned || (box.parentElement && box.parentElement.matches(':hover'))) {
				box.scrollTop = box.scrollHeight
			}
			while (box.childNodes.length > 400) box.removeChild(box.firstChild)
		}
		if (last) last.textContent = msg
		if (level === 'error') console.error('[blu]', msg)
		else if (level === 'warn') console.warn('[blu]', msg)
	}

	function setStatus(text, connected) {
		const root = E('blu-status')
		if (!root) return
		const ind = root.querySelector('.serial-status-indicator')
		const txt = root.querySelector('.serial-status-text')
		if (txt) txt.textContent = text
		if (ind) {
			ind.classList.toggle('connected', !!connected)
			ind.classList.toggle('disconnected', !connected)
		}
	}

	function fmtCurrent(ua) {
		const a = Math.abs(ua)
		if (a >= 1e6) return (ua / 1e6).toFixed(3) + ' A'
		if (a >= 1e3) return (ua / 1e3).toFixed(3) + ' mA'
		if (a >= 1) return ua.toFixed(2) + ' µA'
		if (a >= 1e-3) return (ua * 1e3).toFixed(2) + ' nA'
		return ua.toFixed(2) + ' µA'
	}

	function fmtPower(uw) {
		// uw = µA * V = µW
		const a = Math.abs(uw)
		if (a >= 1e6) return (uw / 1e6).toFixed(3) + ' W'
		if (a >= 1e3) return (uw / 1e3).toFixed(3) + ' mW'
		if (a >= 1) return uw.toFixed(2) + ' µW'
		return (uw * 1e3).toFixed(2) + ' nW'
	}

	function fmtEnergy(uAh) {
		const a = Math.abs(uAh)
		if (a >= 1e6) return (uAh / 1e6).toFixed(3) + ' Ah'
		if (a >= 1e3) return (uAh / 1e3).toFixed(3) + ' mAh'
		if (a >= 1) return uAh.toFixed(2) + ' µAh'
		return (uAh * 1e3).toFixed(2) + ' nAh'
	}

	function fmtDuration(sec) {
		if (!isFinite(sec) || sec < 0) return '--'
		if (sec < 1e-3) return (sec * 1e6).toFixed(0) + ' µs'
		if (sec < 1) return (sec * 1e3).toFixed(2) + ' ms'
		if (sec < 60) return sec.toFixed(2) + ' s'
		const m = Math.floor(sec / 60)
		const s = sec - m * 60
		if (m < 60) return m + 'm ' + s.toFixed(1) + 's'
		const h = Math.floor(m / 60)
		return h + 'h ' + (m % 60) + 'm'
	}

	function fmtTimeAxis(sec) {
		if (!isFinite(sec)) return '--'
		if (sec < 0) sec = 0
		if (sec < 1) return (sec * 1e3).toFixed(2) + 'ms'
		if (sec < 60) return sec.toFixed(3) + 's'
		const m = Math.floor(sec / 60)
		const s = sec - m * 60
		return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2)
	}

	function fmtHz(hz) {
		if (!isFinite(hz) || hz <= 0) return '0'
		if (hz >= 1000) return (hz / 1000).toFixed(hz >= 10000 ? 0 : 1) + 'k'
		return hz.toFixed(hz < 10 ? 2 : 0)
	}

	/** 读 UI 源电压（mV 整数，对齐上位机） */
	function readSetVoltageMv() {
		const el = E('blu-voltage-set')
		if (!el) return setVoltageMv
		let mv = parseInt(el.value, 10)
		if (!isFinite(mv)) mv = setVoltageMv
		mv = Math.round(mv)
		mv = Math.max(PROTO.VDD_LOW_MV, Math.min(PROTO.VDD_HIGH_MV, mv))
		setVoltageMv = mv
		el.value = String(mv)
		return mv
	}

	function getRatePreset() {
		const el = E('blu-sample-rate')
		const key = el ? el.value : '100k'
		return RATE_PRESETS[key] || RATE_PRESETS['100k']
	}

	function applyRatePreset() {
		const p = getRatePreset()
		targetRateHz = p.hz
		rateAdj.setTargetRateHz(targetRateHz)
		// 默认 100k；仅在波形模式下提示长录占用
		if (p.hz >= 50000 && recordMode === 'wave') {
			bluLog('100k 入库量大，长录请改较低采样率或「长期统计」', 'warn')
		}
		return p
	}

	async function bluWrite(data, note) {
		if (!bluPort || !bluOpen || !bluPort.writable) {
			if (note) bluLog('写入失败（未打开）：' + note, 'error')
			return false
		}
		try {
			const w = bluPort.writable.getWriter()
			try {
				await w.write(data)
			} finally {
				w.releaseLock()
			}
			return true
		} catch (e) {
			bluLog('写入错误' + (note ? '（' + note + '）' : '') + '：' + (e.message || e), 'error')
			return false
		}
	}

	function markPowered(on) {
		bluPowered = !!on
		const onBtn = E('blu-poweron')
		const offBtn = E('blu-poweroff')
		if (onBtn) onBtn.classList.toggle('active', bluPowered)
		if (offBtn) offBtn.disabled = !bluPowered
	}

	async function applyVoltageMv(mv) {
		const clamped = Math.max(PROTO.VDD_LOW_MV, Math.min(PROTO.VDD_HIGH_MV, Math.round(mv)))
		setVoltageMv = clamped
		const el = E('blu-voltage-set')
		if (el) el.value = String(clamped)
		if (!bluOpen) {
			bluLog('电压已设为 ' + clamped + ' mV（打开设备后写入）')
			scheduleUIUpdate()
			return false
		}
		const ok = await bluWrite(PROTO.cmdRegulatorSet(clamped), 'REGULATOR ' + clamped + ' mV')
		if (ok) bluLog('设定电压 ' + clamped + ' mV', 'success')
		scheduleUIUpdate()
		return ok
	}

	async function doPowerOn() {
		await applyVoltageMv(readSetVoltageMv())
		await bluWrite(PROTO.cmdDutPower(true), 'DUT 上电')
		markPowered(true)
		bluLog('DUT 已上电', 'success')
	}

	async function doPowerOff() {
		await bluWrite(PROTO.cmdDutPower(false), 'DUT 下电')
		markPowered(false)
		bluLog('DUT 已下电')
	}

	// 对照 API get_modifiers()：发 0x19，收文本至 END，解析 R/O/VDD
	async function fetchAndApplyModifiers() {
		metaCollecting = true
		metaCollectBuf = ''
		await bluWrite(PROTO.cmdMeta(), 'GET_META_DATA')
		const deadline = performance.now() + 3000
		let text = metaCollectBuf
		while (performance.now() < deadline) {
			if (text && text.indexOf('END') >= 0) break
			await new Promise(function (r) { setTimeout(r, 50) })
			text = metaCollectBuf
		}
		metaCollecting = false
		if (text && text.indexOf('END') >= 0) {
			modifiers = PROTO.parseMetadata(text)
			converter.setModifiers(modifiers)
			modifiersOk = true
			metaCollectBuf = ''
			const saved = modifiers.savedVddMv || 0
			if (modifiers.deviceSn && bluPort) {
				rememberPortSn(bluPort, modifiers.deviceSn)
				syncPortSelectUI()
			}
			bluLog('get_modifiers 完成' +
				(modifiers.deviceSn ? ' · SN ' + modifiers.deviceSn : '') +
				(saved ? ' · VDD ' + saved + ' mV' : '') +
				(modifiers.Calibrated != null ? ' · Calibrated=' + modifiers.Calibrated : ''), 'success')
			// 与 example 一致：若 UI 未改过且设备有保存 VDD，则回填
			if (saved >= PROTO.VDD_LOW_MV && saved <= PROTO.VDD_HIGH_MV) {
				const el = E('blu-voltage-set')
				if (el && !el.dataset.userTouched) {
					setVoltageMv = Math.round(saved)
					el.value = String(setVoltageMv)
				}
			}
			return true
		}
		// API 内置默认 R 表；读失败仍可用默认修正，不阻断
		modifiers = PROTO.defaultModifiers()
		converter.setModifiers(modifiers)
		modifiersOk = false
		metaCollectBuf = ''
		bluLog('get_modifiers 超时，使用默认 R/O 表', 'warn')
		return false
	}

	let metaCollecting = false
	let metaCollectBuf = ''

	function resetLongStats() {
		longStats.n = 0
		longStats.sumI = 0
		longStats.minI = Infinity
		longStats.maxI = -Infinity
		longStats.energyUAs = 0
		longStats.t0 = 0
		longStats.tLast = 0
	}

	function clearAllData(log) {
		ringReset()
		clearBucketCache()
		minimap.reset()
		resetLongStats()
		parser.reset()
		rateAdj.reset()
		overallStatDirty = true
		overallStatCache = null
		resetYAuto()
		view.xOffset = 0
		view.cursorA = null
		view.cursorB = null
		dispInit = false
		firstStoredTs = 0
		sessionT0Ms = 0
		lastPointTMs = 0
		periodLocked = false
		periodLogged = false
		deviceStreamHz = 0
		rawStreamCount = 0
		rawStreamFirstTs = 0
		if (log) bluLog('数据已清空')
		scheduleUIUpdate()
	}

	async function startSampling() {
		if (!bluOpen || bluSampling) return
		// API：start_measuring 要求已 set_source_voltage（current_vdd，单位 mV）
		const mv = readSetVoltageMv()
		if (!isFinite(mv) || mv < PROTO.VDD_LOW_MV) {
			bluLog('请先设定源电压 mV（API 要求 current_vdd）', 'error')
			return
		}
		applyRatePreset()
		clearAllData(false)
		parser.reset()
		converter.resetFilter()
		// 立刻用当前已知基速；未知时用标称 100k，避免 RateAdjuster 分母不对拖输出
		const baseHz = deviceStreamHz > 1000 ? deviceStreamHz : PROTO.NOMINAL_BASE_HZ
		rateAdj = new PROTO.RateAdjuster(targetRateHz, baseHz)
		// 预热：按目标输出率 × 秒数，并封顶，避免 100k×2s 丢 20 万点才出波形
		warmupLeft = Math.max(0, Math.min(WARMUP_MAX_SAMPLES, Math.round(targetRateHz * WARMUP_SEC)))
		metaCollecting = false
		metaCollectBuf = ''
		// 每次开始采样默认 Live 滚动（贴最新波形），清掉上次暂停/平移状态
		view.xOffset = 0
		view.yPanOffset = 0
		setScrollPaused(false)
		bluSampling = true
		updateSampleBtn()
		startStallWatch()
		// 先发 START，再异步要 WakeLock，避免多等一拍
		const startOk = await bluWrite(PROTO.cmdAverageStart(), 'AVERAGE_START')
		requestWakeLock() // 不 await，不挡采样
		const warmMs = targetRateHz > 0 ? Math.round(warmupLeft / targetRateHz * 1000) : 0
		bluLog((startOk ? 'AVERAGE_START' : 'AVERAGE_START 可能失败') +
			' · 目标 ' + getRatePreset().label +
			' · ' + (recordMode === 'long' ? '长期统计' : '波形') +
			' · Live 滚动' +
			' · 预热约 ' + warmMs + ' ms（' + warmupLeft + ' 点）' +
			(modifiersOk ? '' : ' · 默认修正参数'))
	}

	async function stopSampling() {
		if (!bluSampling) return
		bluSampling = false
		stopStallWatch()
		updateSampleBtn()
		try { await bluWrite(PROTO.cmdAverageStop(), 'AVERAGE_STOP') } catch (e) {}
		releaseWakeLock()
		bluLog('已停止采样')
		scheduleUIUpdate()
	}

	function updateSampleBtn() {
		const el = E('blu-start')
		if (!el) return
		if (bluSampling) {
			el.className = 'btn btn-sm btn-danger'
			el.innerHTML = '<i class="bi bi-stop-fill"></i> 停止采样'
		} else {
			el.className = 'btn btn-sm btn-success'
			el.innerHTML = '<i class="bi bi-play-fill"></i> 开始采样'
		}
	}

	function setScrollPaused(on) {
		scrollPaused = !!on
		liveMode = !scrollPaused
		// 继续滚动：必须贴最新端，清掉历史 offset / 平移残留
		if (!scrollPaused) {
			view.xOffset = 0
			liveMode = true
		}
		const el = E('blu-pause-scroll')
		if (el) {
			el.innerHTML = scrollPaused
				? '<i class="bi bi-play-fill"></i> 继续滚动'
				: '<i class="bi bi-pause-fill"></i> 暂停滚动'
			el.classList.toggle('active', scrollPaused)
		}
		scheduleUIUpdate()
	}

	function setWaveFullscreen(on) {
		waveFullscreen = !!on
		const wrap = E('view-blu')
		if (wrap) wrap.classList.toggle('blu-wave-fullscreen', waveFullscreen)
	}

	function setRecordMode(mode) {
		recordMode = mode === 'long' ? 'long' : 'wave'
		const el = E('blu-record-mode')
		if (el) el.value = recordMode
		bluLog('录制模式：' + (recordMode === 'long' ? '长期统计（不存波形）' : '波形'))
		if (bluSampling) clearAllData(false)
		scheduleUIUpdate()
	}

	function setYAxisLog(on) {
		yAxisLog = !!on
		const el = E('blu-y-log')
		if (el) el.checked = yAxisLog
		resetYAuto()
		scheduleUIUpdate()
	}

	async function requestWakeLock() {
		try {
			if (navigator.wakeLock && navigator.wakeLock.request) {
				wakeLockSentinel = await navigator.wakeLock.request('screen')
				wakeLockSentinel.addEventListener('release', function () { wakeLockSentinel = null })
			}
		} catch (e) {}
	}

	async function releaseWakeLock() {
		try {
			if (wakeLockSentinel) await wakeLockSentinel.release()
		} catch (e) {}
		wakeLockSentinel = null
	}

	async function bluOpenPort() {
		if (!bluPort || bluOpen || bluOpening) return
		bluOpening = true
		bluManualClose = false
		try {
			try { await bluPort.close() } catch (e) {}
			// CDC 虚拟串口：baudRate 仅为 Web Serial API 占位，无实际意义
			await bluPort.open({
				baudRate: 1000000,
				dataBits: 8,
				stopBits: 1,
				parity: 'none',
				bufferSize: 1024 * 1024,
				flowControl: 'none',
			})
			try {
				if (bluPort.setSignals) {
					await bluPort.setSignals({ dataTerminalReady: true, requestToSend: true })
				}
			} catch (e) {}
			bluOpen = true
			setStatus('BLU 100k', true)
			const toggle = E('blu-open')
			if (toggle) toggle.innerHTML = '<i class="bi bi-stop-circle"></i> 关闭'
			bluLog('设备已打开（USB CDC）', 'success')
			modifiersOk = false
			bluReadLoop()
			await new Promise(function (r) { setTimeout(r, 80) })
			// 对照 example_auto：get_modifiers →（用户设压/上电）→ start
			await fetchAndApplyModifiers()
			// 电压 / 上电 始终可见，打开后可直接配置
			scheduleUIUpdate()
		} catch (e) {
			bluOpen = false
			setStatus('打开失败', false)
			bluLog('打开失败：' + (e.message || e), 'error')
			const toggle = E('blu-open')
			if (toggle) toggle.innerHTML = '<i class="bi bi-play-circle"></i> 打开'
		} finally {
			bluOpening = false
		}
	}

	async function bluClosePort(opts) {
		opts = opts || {}
		if (opts.manual !== false) bluManualClose = true
		if (bluSampling) {
			bluSampling = false
			stopStallWatch()
			updateSampleBtn()
			if (bluOpen && opts.manual !== false) {
				try { await bluWrite(PROTO.cmdAverageStop()) } catch (e) {}
			}
			releaseWakeLock()
		}
		bluOpen = false
		const r = bluReader
		bluReader = null
		if (r) {
			try { await r.cancel() } catch (e) {}
			try { r.releaseLock() } catch (e) {}
		}
		if (bluPort) {
			try { await bluPort.close() } catch (e) {}
		}
		setStatus(opts.manual === false ? '已断开' : '已关闭', false)
		const toggle = E('blu-open')
		if (toggle) toggle.innerHTML = '<i class="bi bi-play-circle"></i> 打开'
		releaseWakeLock()
		markPowered(false)
		if (opts.manual !== false) bluLog('设备已关闭')
	}

	async function bluReadLoop() {
		while (bluOpen && bluPort && bluPort.readable) {
			const r = bluPort.readable.getReader()
			bluReader = r
			let streamError = false
			try {
				while (true) {
					const { value, done } = await r.read()
					if (done) break
					if (value && value.length) handleBluChunk(value, performance.now())
				}
			} catch (e) {
				if (bluOpen) {
					bluLog('读取错误：' + (e.message || e), 'error')
					streamError = true
				}
			} finally {
				if (bluReader === r) bluReader = null
				try { r.releaseLock() } catch (e) {}
			}
			if (streamError || !bluOpen) break
		}
		if (bluOpen) {
			bluOpen = false
			setStatus('读取中断', false)
			const toggle = E('blu-open')
			if (toggle) toggle.innerHTML = '<i class="bi bi-play-circle"></i> 打开'
			releaseWakeLock()
			if (!bluManualClose) bluLog('读取中断，可重开', 'warn')
		}
	}

	function noteSampleFrame() {
		lastSampleFrameTs = performance.now()
		if (stallReported) {
			stallReported = false
			bluLog('采样流已恢复', 'success')
		}
	}

	function startStallWatch() {
		stopStallWatch()
		stallReported = false
		lastSampleFrameTs = performance.now()
		stallTimer = setInterval(function () {
			if (!bluSampling) return
			const dt = performance.now() - lastSampleFrameTs
			if (dt > 2000 && !stallReported) {
				stallReported = true
				bluLog('采样流中断 >2s（设备停发或 USB 卡顿）', 'warn')
			}
		}, 500)
	}

	function stopStallWatch() {
		if (stallTimer) clearInterval(stallTimer)
		stallTimer = 0
	}

	function handleBluChunk(u8, tBatch) {
		// 打开后 metadata 阶段：尝试当文本收集（采样中绝不走此路径）
		if (metaCollecting && !bluSampling) {
			try {
				const dec = new TextDecoder('utf-8', { fatal: false })
				metaCollectBuf += dec.decode(u8)
				if (metaCollectBuf.length > 65536) {
					metaCollectBuf = metaCollectBuf.slice(-32768)
				}
			} catch (e) {}
			return
		}

		const samples = parser.push(u8)
		if (!samples.length) return
		noteSampleFrame()

		const N = samples.length
		// 实测原始流速
		const now = tBatch
		if (!rawStreamFirstTs) rawStreamFirstTs = now
		rawStreamCount += N
		const rawElapsed = (now - rawStreamFirstTs) / 1000
		if (rawStreamCount >= 2000 && rawElapsed > 0.5) {
			const hz = rawStreamCount / rawElapsed
			deviceStreamHz = hz
			if (!periodLocked && hz > 100) {
				rateAdj.setBaseRateHz(hz)
			}
		}
		if (!rawWinTs) rawWinTs = now
		else {
			rawWinCount += N
			const we = now - rawWinTs
			if (we >= 1000) {
				rawRateEst = rawWinCount / we * 1000
				rawWinCount = 0
				rawWinTs = now
			}
		}

		const baseHz = deviceStreamHz > 1000 ? deviceStreamHz : PROTO.NOMINAL_BASE_HZ
		const dtMs = 1000 / baseHz
		// 批末对齐到达时刻，批内等间隔回推
		let t0 = tBatch - (N - 1) * dtMs
		if (lastPointTMs > 0 && t0 < lastPointTMs) {
			const gap = t0 - lastPointTMs
			if (gap < -GAP_LOG_MS && !gapLogged) {
				// 重叠：单调钳制
			} else if (gap > GAP_LOG_MS) {
				bluLog('采样批间隙 ' + gap.toFixed(1) + ' ms（USB 抖动）', 'warn')
				gapLogged = true
				setTimeout(function () { gapLogged = false }, 2000)
			}
			t0 = Math.max(t0, lastPointTMs + 0.001)
		}

		let stored = 0
		for (let i = 0; i < N; i++) {
			let tMs = t0 + i * dtMs
			if (lastPointTMs > 0 && tMs <= lastPointTMs) tMs = lastPointTMs + 0.001
			lastPointTMs = tMs
			const iUA = samples[i].iUA
			latestCurrentUA = iUA
			// 显示用慢 EMA，避免大数字狂跳
			if (!dispInit) {
				dispCurrentUA = iUA
				dispInit = true
			} else {
				dispCurrentUA = dispCurrentUA * 0.92 + iUA * 0.08
			}

			if (!bluSampling) continue

			const outs = rateAdj.push(iUA, tMs)
			for (let k = 0; k < outs.length; k++) {
				const o = outs[k]
				if (warmupLeft > 0) {
					warmupLeft--
					continue
				}
				ingestStored(o.tMs, o.iUA)
				stored++
			}
		}

		// 暂停滚动：新样本入库后钉住历史视口
		if (bluSampling && stored > 0 && scrollPaused) {
			const maxOff = Math.max(0, ringCount - 1)
			// 环缓已满时最旧点被覆盖，逻辑下标整体左移
			const ringFull = ringCap > 0 && ringCount >= ringCap
			if (drag && drag.liAnchor != null) {
				if (ringFull) {
					drag.liAnchor = Math.max(0, drag.liAnchor - stored)
				}
				// 跟手：用当前指针位置重算视口，使抓取点仍在指针下
				if (typeof drag.lastX === 'number') {
					panViewSoLiAtPixel(drag.liAnchor, drag.lastX)
				}
			} else {
				view.xOffset = Math.min(maxOff, view.xOffset + stored)
			}
		}

		if (bluSampling) {
			if (!sampleRateLastTs) sampleRateLastTs = now
			sampleRateCount += stored
			const elapsed = now - sampleRateLastTs
			if (elapsed >= 1000) {
				sampleRateEst = Math.round(sampleRateCount / elapsed * 1000)
				sampleRateCount = 0
				sampleRateLastTs = now
			}
			// 实测入库周期
			if (!periodLocked && firstStoredTs && sampleCount > 200) {
				const span = (now - firstStoredTs) / 1000
				if (span > 0 && sampleCount > 1) {
					samplePeriodSec = span / (sampleCount - 1)
				}
			}
			if (!periodLocked && firstStoredTs &&
				(now - firstStoredTs) / 1000 >= PERIOD_LOCK_SEC && samplePeriodSec > 0) {
				periodLocked = true
				bluLog('时间基准已锁定：' + (1 / samplePeriodSec).toFixed(2) + ' Hz（' +
					(samplePeriodSec * 1e6).toFixed(1) + ' µs/点）')
			}
			if (!periodLogged && deviceStreamHz > 0 && sampleCount > 50) {
				periodLogged = true
				bluLog('实测设备流 ' + Math.round(deviceStreamHz) + ' Hz · 入库目标 ' +
					targetRateHz + ' Hz · 当前约 ' + Math.round(1 / samplePeriodSec) + ' Hz')
			}
		}
		scheduleUIUpdate()
	}

	function ingestStored(tMs, iUA) {
		if (!firstStoredTs) {
			firstStoredTs = tMs
			sessionT0Ms = tMs
		}
		const tSec = (tMs - sessionT0Ms) / 1000
		const prevT = longStats.tLast || tSec
		const dt = Math.max(0, tSec - prevT)

		if (recordMode === 'long') {
			if (!longStats.t0) longStats.t0 = tSec
			longStats.tLast = tSec
			longStats.n++
			longStats.sumI += iUA
			if (iUA < longStats.minI) longStats.minI = iUA
			if (iUA > longStats.maxI) longStats.maxI = iUA
			longStats.energyUAs += iUA * dt
			sampleCount = longStats.n
			if (sampleCount === 1 && samplePeriodSec <= 0) samplePeriodSec = 1 / targetRateHz
			return
		}

		// 波形模式
		ringPush(iUA)
		minimap.addData(iUA, tSec)
		overallStatDirty = true
		// 长期旁路累计（总体能量仍可用块统计；此处仅 minimap）
		if (!longStats.t0) longStats.t0 = tSec
		longStats.tLast = tSec
	}

	function indexToTime(li) {
		if (li < 0) return 0
		return li * samplePeriodSec
	}

	function currentViewPts() {
		const n = Math.max(2, ringCount)
		let viewPts = Math.max(MIN_VIEW_POINTS, Math.round(DEFAULT_VIEW_POINTS / view.xZoom))
		return Math.min(n, viewPts)
	}

	function getViewRange() {
		const n = ringCount
		if (n < 2) return { start: 0, end: 0, count: 0 }
		const viewPts = currentViewPts()
		// Live / 继续滚动：视口右端永远是最新样点
		if (liveMode && !scrollPaused) {
			view.xOffset = 0
			const end = n - 1
			const start = Math.max(0, end - viewPts + 1)
			return { start: start, end: end, count: end - start + 1 }
		}
		let end = n - 1 - Math.max(0, Math.round(view.xOffset))
		let start = end - viewPts + 1
		if (start < 0) {
			start = 0
			end = Math.min(n - 1, start + viewPts - 1)
		}
		if (end >= n) end = n - 1
		if (end < 0) end = 0
		return { start: start, end: end, count: end - start + 1 }
	}

	/**
	 * 跟手平移：让逻辑下标 li 出现在画布像素 px 处（鼠标拖哪，该点跟到哪）
	 * 鼠标右移 → 波形右移（看更旧）；左移 → 波形左移（看更新）
	 */
	function panViewSoLiAtPixel(li, px) {
		const n = ringCount
		if (n < 2) return
		const viewPts = currentViewPts()
		const layout = plotLayout
		const marginLeft = layout && layout.margin ? layout.margin.left : 62
		const pw = layout && layout.pw > 1 ? layout.pw : 1
		let t = (px - marginLeft) / pw
		if (t < 0) t = 0
		if (t > 1) t = 1
		// li = start + t * (viewPts - 1)  →  start = li - t * (viewPts - 1)
		let start = Math.round(li - t * Math.max(1, viewPts - 1))
		const maxStart = Math.max(0, n - viewPts)
		if (start < 0) start = 0
		if (start > maxStart) start = maxStart
		const end = Math.min(n - 1, start + viewPts - 1)
		view.xOffset = Math.max(0, n - 1 - end)
	}

	/** 命中测试：返回靠近哪条游标 'a'|'b'|null */
	function hitTestCursorEdge(px) {
		if (!plotLayout) return null
		const ca = clampLogical(view.cursorA)
		const cb = clampLogical(view.cursorB)
		if (ca == null || cb == null) return null
		const xa = plotLayout.toX(ca)
		const xb = plotLayout.toX(cb)
		const da = Math.abs(px - xa)
		const db = Math.abs(px - xb)
		if (da <= CURSOR_HIT_PX && da <= db) return 'a'
		if (db <= CURSOR_HIT_PX) return 'b'
		return null
	}

	/** 选择区间绑定数据下标；始终 clamp 到 ring */
	function clampLogical(li) {
		if (li == null || ringCount < 1) return null
		return Math.max(0, Math.min(ringCount - 1, Math.round(li)))
	}

	function getSelectionRange() {
		let a = clampLogical(view.cursorA)
		let b = clampLogical(view.cursorB)
		if (a == null || b == null) return null
		if (a > b) { const t = a; a = b; b = t }
		return { a: a, b: b }
	}

	function fillStatRow(prefix, st, opts) {
		opts = opts || {}
		const set = function (suffix, text) {
			const el = E(prefix + suffix)
			if (el) el.textContent = text
		}
		const emptyEl = E(prefix + '-empty')
		const gridEl = E(prefix + '-grid')
		if (!st || !st.n) {
			set('-dur', '--')
			set('-energy', '--')
			set('-charge', '--')
			set('-charge-mah', '--')
			set('-avg', '--')
			set('-pwr', '--')
			set('-max', '--')
			set('-min', '--')
			set('-n', '')
			if (opts.showEmpty) {
				if (emptyEl) emptyEl.style.display = ''
				if (gridEl) gridEl.style.display = 'none'
			}
			return
		}
		if (opts.showEmpty) {
			if (emptyEl) emptyEl.style.display = 'none'
			if (gridEl) gridEl.style.display = ''
		}
		set('-dur', fmtDuration(st.dur))
		set('-energy', fmtEnergyWh(st.energyUWh != null ? st.energyUWh : 0))
		set('-charge', fmtCharge(st.chargeUC != null ? st.chargeUC : 0))
		set('-charge-mah', fmtEnergy(st.chargeUAh != null ? st.chargeUAh : 0))
		set('-avg', fmtCurrent(st.avgI))
		set('-pwr', fmtPower(st.avgP))
		set('-max', fmtCurrent(st.maxI))
		set('-min', fmtCurrent(st.minI))
		set('-n', st.n ? (st.n + ' 点') : '')
	}

	function invalidateOverallStat() {
		overallStatDirty = true
	}

	function updateStats() {
		if (recordMode === 'long') {
			const n = longStats.n
			const dur = Math.max(0, longStats.tLast - longStats.t0)
			const avgI = n ? longStats.sumI / n : 0
			const st = enrichStats({
				n: n,
				avgI: avgI,
				avgP: avgI * setVoltageV(),
				minI: isFinite(longStats.minI) ? longStats.minI : 0,
				maxI: isFinite(longStats.maxI) ? longStats.maxI : 0,
				dur: dur,
			})
			// 长期模式能量用积分 µA·s
			if (n) {
				st.chargeUC = longStats.energyUAs // µA·s = µC
				st.chargeUAh = longStats.energyUAs / 3600
				st.energyUWh = avgI * setVoltageV() * dur / 3600
			}
			fillStatRow('blu-stat-overall', st)
			fillStatRow('blu-stat-window', emptyStats())
			fillStatRow('blu-stat-cursor', emptyStats(), { showEmpty: true })
			return
		}
		if (overallStatDirty || !overallStatCache) {
			overallStatCache = calcStats(0, ringCount)
			overallStatDirty = false
		}
		fillStatRow('blu-stat-overall', overallStatCache)
		const vr = getViewRange()
		fillStatRow('blu-stat-window', calcStats(vr.start, vr.end + 1))
		const sel = getSelectionRange()
		if (sel) {
			fillStatRow('blu-stat-cursor', calcStats(sel.a, sel.b + 1), { showEmpty: true })
		} else {
			fillStatRow('blu-stat-cursor', emptyStats(), { showEmpty: true })
		}
	}

	function updateDigits(force) {
		const now = performance.now()
		const digitDue = force || (now - lastDigitTs >= 1000 / DIGIT_UI_HZ)
		const elI = E('blu-current')
		const elV = E('blu-voltage')
		const elP = E('blu-power')
		const elRate = E('blu-rate')
		const elRateRaw = E('blu-rate-raw')
		const elCount = E('blu-count')
		const elDur = E('blu-duration')
		const elSet = E('blu-deviceset')

		// 电流 / 功率：限速刷新，避免顶部数字闪得看不清
		if (digitDue) {
			lastDigitTs = now
			if (elI) elI.textContent = dispInit ? fmtCurrent(dispCurrentUA) : '--'
			if (elP) elP.textContent = dispInit ? fmtPower(dispCurrentUA * setVoltageV()) : '--'
			if (elV) elV.textContent = setVoltageMv + ' mV'
			if (elSet) {
				elSet.textContent = modifiers.savedVddMv
					? (modifiers.savedVddMv + ' mV')
					: (modifiersOk ? '--' : '默认表')
			}
			if (elRate) elRate.textContent = fmtHz(sampleRateEst || (samplePeriodSec > 0 ? 1 / samplePeriodSec : 0))
			if (elRateRaw) {
				elRateRaw.textContent = deviceStreamHz > 0
					? ('设备 ' + fmtHz(rawRateEst || deviceStreamHz) + 'Hz')
					: ''
			}
			if (recordMode === 'long') {
				if (elCount) elCount.textContent = String(longStats.n)
				if (elDur) elDur.textContent = fmtDuration(Math.max(0, longStats.tLast - longStats.t0))
			} else {
				if (elCount) elCount.textContent = String(ringCount)
				if (elDur) elDur.textContent = fmtDuration(ringCount > 1 ? (ringCount - 1) * samplePeriodSec : 0)
			}
			updateStats()
			updateCursorInfo()
		}
	}

	function niceNumber(raw) {
		const exp = Math.floor(Math.log10(Math.abs(raw) || 1))
		const f = raw / Math.pow(10, exp)
		let nf
		if (f < 1.5) nf = 1
		else if (f < 3) nf = 2
		else if (f < 7) nf = 5
		else nf = 10
		return nf * Math.pow(10, exp)
	}

	function logMap(v) {
		return Math.log10(Math.max(LOG_FLOOR_UA, v))
	}

	function logUnmap(lv) {
		return Math.pow(10, lv)
	}

	function updateCanvas() {
		const canvas = E('blu-canvas')
		if (!canvas) return
		const ctx = canvas.getContext('2d')
		const dpr = window.devicePixelRatio || 1
		const rect = canvas.getBoundingClientRect()
		const w = rect.width
		const h = rect.height
		if (w < 8 || h < 8) return

		canvas.width = Math.round(w * dpr)
		canvas.height = Math.round(h * dpr)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

		const margin = { top: 14, right: 14, bottom: 36, left: 62 }
		const pw = w - margin.left - margin.right
		const ph = h - margin.top - margin.bottom

		const cs = getComputedStyle(document.documentElement)
		const bg = cs.getPropertyValue('--bg-surface').trim() || '#1e293b'
		const muted = cs.getPropertyValue('--text-muted').trim() || '#64748b'
		const fg = cs.getPropertyValue('--text-primary').trim() || '#e2e8f0'
		const accent = cs.getPropertyValue('--accent').trim() || '#3b82f6'
		const grid = cs.getPropertyValue('--border-color').trim() || '#334155'
		const cursorCol = '#f59e0b'

		ctx.fillStyle = bg
		ctx.fillRect(0, 0, w, h)

		if (recordMode === 'long') {
			ctx.fillStyle = muted
			ctx.font = '13px sans-serif'
			ctx.textAlign = 'center'
			const avg = longStats.n ? longStats.sumI / longStats.n : 0
			ctx.fillText('长期统计模式 · 不缓存波形', w / 2, h / 2 - 12)
			ctx.fillText(
				'n=' + longStats.n +
				' · 平均 ' + fmtCurrent(avg) +
				' · 最大 ' + fmtCurrent(isFinite(longStats.maxI) ? longStats.maxI : 0) +
				' · 最小 ' + fmtCurrent(isFinite(longStats.minI) ? longStats.minI : 0) +
				' · 累计 ' + fmtEnergy(longStats.energyUAs / 3600),
				w / 2, h / 2 + 12
			)
			plotLayout = null
			drawMinimapStrip()
			return
		}

		if (ringCount < 2) {
			ctx.fillStyle = muted
			ctx.font = '13px sans-serif'
			ctx.textAlign = 'center'
			ctx.fillText('等待采样数据…（仅电流波形）', w / 2, h / 2)
			plotLayout = null
			drawMinimapStrip()
			return
		}

		const vr = getViewRange()
		const ringBase = sampleCount - ringCount
		const ringLastAbs = sampleCount - 1
		const bucketSize = computeBucketSize(vr.count, pw)
		let yMin = Infinity
		let yMax = -Infinity
		let cols = null
		if (bucketSize <= 1) {
			for (let li = vr.start; li <= vr.end; li++) {
				const v = ringIAt(li)
				if (v < yMin) yMin = v
				if (v > yMax) yMax = v
			}
		} else {
			const absStart = ringBase + vr.start
			const absEnd = ringBase + vr.end
			const firstBucket = Math.floor(absStart / bucketSize)
			const lastBucket = Math.floor(absEnd / bucketSize)
			cols = []
			for (let bi = firstBucket; bi <= lastBucket; bi++) {
				const entry = getBucketEntry(bi, bucketSize, ringBase, ringLastAbs)
				if (!entry) continue
				if (entry.min < yMin) yMin = entry.min
				if (entry.max > yMax) yMax = entry.max
				cols.push({ x: (entry.loAbs + entry.hiAbs) / 2 - ringBase, entry: entry })
			}
		}
		if (!isFinite(yMin) || !isFinite(yMax)) {
			const vv = ringIAt(vr.end)
			yMin = vv - 1
			yMax = vv + 1
		}
		if (yMax === yMin) {
			yMax += 1
			yMin -= 1
		}

		// log 映射范围
		let mapYMin = yMin
		let mapYMax = yMax
		if (yAxisLog) {
			mapYMin = logMap(Math.max(LOG_FLOOR_UA, yMin))
			mapYMax = logMap(Math.max(LOG_FLOOR_UA, yMax))
			if (mapYMax <= mapYMin) mapYMax = mapYMin + 1
		}

		const pad = (mapYMax - mapYMin) * 0.08 || 1
		mapYMin -= pad
		mapYMax += pad

		if (view.yMode === 'manual') {
			if (yAxisLog) {
				mapYMin = logMap(Math.max(LOG_FLOOR_UA, view.yMin))
				mapYMax = logMap(Math.max(LOG_FLOOR_UA, view.yMax))
			} else {
				mapYMin = view.yMin
				mapYMax = view.yMax
			}
		} else {
			const rawRange = mapYMax - mapYMin || 1
			const step5 = niceNumber(rawRange / 4)
			const qMin = Math.floor(mapYMin / step5) * step5
			const qMax = Math.ceil(mapYMax / step5) * step5
			if (yAutoTargetMin == null) {
				yAutoTargetMin = qMin
				yAutoTargetMax = qMax
			} else {
				const curRange = yAutoTargetMax - yAutoTargetMin || 1
				const needExpand = qMin < yAutoTargetMin || qMax > yAutoTargetMax
				const needShrink = (qMax - qMin) < curRange * 0.6
				if (needExpand || needShrink) {
					yAutoTargetMin = qMin
					yAutoTargetMax = qMax
				}
			}
			if (yAutoDispMin == null) {
				yAutoDispMin = yAutoTargetMin
				yAutoDispMax = yAutoTargetMax
			} else {
				yAutoDispMin += (yAutoTargetMin - yAutoDispMin) * 0.3
				yAutoDispMax += (yAutoTargetMax - yAutoDispMax) * 0.3
			}
			mapYMin = yAutoDispMin
			mapYMax = yAutoDispMax
			if (view.yZoom !== 1) {
				const mid = (mapYMin + mapYMax) / 2
				const half = (mapYMax - mapYMin) / 2 / view.yZoom
				mapYMin = mid - half
				mapYMax = mid + half
			}
		}
		if (view.yPanOffset) {
			mapYMin += view.yPanOffset
			mapYMax += view.yPanOffset
		}

		// 线性自动轴：把 0 µA 纳入可见范围，便于画零线基准
		if (!yAxisLog && view.yMode !== 'manual') {
			if (mapYMin > 0) mapYMin = 0
			if (mapYMax < 0) mapYMax = 0
			if (mapYMax === mapYMin) {
				mapYMax += 1
				mapYMin -= 1
			}
		}

		const t0 = indexToTime(vr.start)
		const t1 = indexToTime(vr.end)

		function toX(li) {
			const t = vr.count <= 1 ? 0 : (li - vr.start) / (vr.count - 1)
			return margin.left + t * pw
		}
		function mapVal(v) {
			return yAxisLog ? logMap(v) : v
		}
		function toY(v) {
			const mv = mapVal(v)
			return margin.top + ph - ((mv - mapYMin) / (mapYMax - mapYMin)) * ph
		}
		function fromX(px) {
			const t = (px - margin.left) / pw
			const li = Math.round(vr.start + t * (vr.count - 1))
			return Math.max(vr.start, Math.min(vr.end, li))
		}

		plotLayout = {
			margin: margin, pw: pw, ph: ph, w: w, h: h,
			vr: vr, yMin: mapYMin, yMax: mapYMax, toX: toX, toY: toY, fromX: fromX,
			t0: t0, t1: t1, yAxisLog: yAxisLog,
		}

		// Y grid
		ctx.strokeStyle = grid
		ctx.lineWidth = 0.6
		for (let g = 0; g <= 4; g++) {
			const y = margin.top + (g / 4) * ph
			ctx.beginPath()
			ctx.moveTo(margin.left, y)
			ctx.lineTo(w - margin.right, y)
			ctx.stroke()
			const mv = mapYMax - (g / 4) * (mapYMax - mapYMin)
			const val = yAxisLog ? logUnmap(mv) : mv
			ctx.fillStyle = muted
			ctx.font = '10px monospace'
			ctx.textAlign = 'right'
			ctx.fillText(fmtCurrent(val).replace(' ', ''), margin.left - 4, y + 3)
		}

		// 0 µA 参考线：贯穿绘图区的虚线 + 左侧刻度标记（线性轴；Log 无真正 0）
		if (!yAxisLog && mapYMin <= 0 && mapYMax >= 0) {
			const y0 = toY(0)
			if (y0 >= margin.top - 0.5 && y0 <= margin.top + ph + 0.5) {
				ctx.save()
				ctx.strokeStyle = 'rgba(148, 163, 184, 0.95)'
				ctx.lineWidth = 1.1
				ctx.setLineDash([6, 4])
				ctx.beginPath()
				ctx.moveTo(margin.left, y0)
				ctx.lineTo(w - margin.right, y0)
				ctx.stroke()
				ctx.setLineDash([])
				// 左侧刻度强调
				ctx.fillStyle = fg
				ctx.font = 'bold 10px monospace'
				ctx.textAlign = 'right'
				ctx.fillText('0 µA', margin.left - 4, y0 + 3)
				// 途中短标签
				ctx.textAlign = 'left'
				ctx.font = '10px monospace'
				ctx.fillStyle = muted
				ctx.fillText('0', margin.left + 4, y0 - 3)
				ctx.restore()
			}
		}

		const xTicks = 6
		for (let g = 0; g <= xTicks; g++) {
			const x = margin.left + (g / xTicks) * pw
			ctx.strokeStyle = grid
			ctx.beginPath()
			ctx.moveTo(x, margin.top)
			ctx.lineTo(x, margin.top + ph)
			ctx.stroke()
			const t = t0 + (t1 - t0) * (g / xTicks)
			ctx.fillStyle = muted
			ctx.font = '10px monospace'
			ctx.textAlign = 'center'
			ctx.fillText(fmtTimeAxis(t), x, margin.top + ph + 14)
		}

		// 波形：PPK 风格 min/max 包络（缩放时）/ 逐点折线（放大时）
		ctx.strokeStyle = accent
		ctx.lineWidth = 1.3
		ctx.beginPath()
		let started = false
		const drawnPts = []
		if (bucketSize <= 1) {
			for (let li = vr.start; li <= vr.end; li++) {
				const x = toX(li)
				const y = toY(ringIAt(li))
				if (!started) { ctx.moveTo(x, y); started = true }
				else ctx.lineTo(x, y)
				drawnPts.push(x, y)
			}
		} else {
			for (let k = 0; k < cols.length; k++) {
				const e = cols[k].entry
				const x = toX(cols[k].x)
				const yFirst = toY(e.first)
				const yMinPx = toY(e.min)
				const yMaxPx = toY(e.max)
				const yLast = toY(e.last)
				if (!started) { ctx.moveTo(x, yFirst); started = true }
				else ctx.lineTo(x, yFirst)
				// Nordic：同一 x 上画 min 再 max，形成包络
				if (Math.abs(e.min - e.first) <= Math.abs(e.max - e.first)) {
					ctx.lineTo(x, yMinPx)
					ctx.lineTo(x, yMaxPx)
				} else {
					ctx.lineTo(x, yMaxPx)
					ctx.lineTo(x, yMinPx)
				}
				ctx.lineTo(x, yLast)
			}
		}
		ctx.stroke()

		if (bucketSize <= 1 && vr.count <= 60) {
			ctx.fillStyle = accent
			for (let k = 0; k < drawnPts.length; k += 2) {
				ctx.beginPath()
				ctx.arc(drawnPts[k], drawnPts[k + 1], 2.2, 0, Math.PI * 2)
				ctx.fill()
			}
		}

		// 选择区间：阴影 + A/B 可拖边界
		function drawEdgeLine(x, isActive, label, col) {
			const c = isActive ? (col || cursorCol) : '#64748b'
			ctx.strokeStyle = c
			ctx.lineWidth = isActive ? 2 : 1.2
			ctx.setLineDash(isActive ? [] : [4, 4])
			ctx.beginPath()
			ctx.moveTo(x, margin.top)
			ctx.lineTo(x, margin.top + ph)
			ctx.stroke()
			ctx.setLineDash([])
			const hw = 5
			ctx.fillStyle = c
			ctx.beginPath()
			ctx.moveTo(x - hw, margin.top)
			ctx.lineTo(x + hw, margin.top)
			ctx.lineTo(x, margin.top + 7)
			ctx.closePath()
			ctx.fill()
			ctx.fillStyle = isActive ? c : muted
			ctx.font = '10px sans-serif'
			ctx.textAlign = 'center'
			ctx.fillText(label, x, margin.top - 2)
		}
		function drawSelectionFill(aLi, bLi, fillAlpha) {
			if (aLi == null || bLi == null) return
			let a = aLi
			let b = bLi
			if (a > b) { const t = a; a = b; b = t }
			const x0 = toX(Math.max(vr.start, Math.min(vr.end, a)))
			const x1 = toX(Math.max(vr.start, Math.min(vr.end, b)))
			ctx.fillStyle = 'rgba(148, 163, 184, ' + (fillAlpha != null ? fillAlpha : 0.18) + ')'
			ctx.fillRect(Math.min(x0, x1), margin.top, Math.abs(x1 - x0), ph)
		}
		if (selectDrag && selectDrag.li0 != null && selectDrag.li1 != null) {
			drawSelectionFill(selectDrag.li0, selectDrag.li1, 0.22)
			drawEdgeLine(toX(selectDrag.li0), true, 'A', cursorCol)
			drawEdgeLine(toX(selectDrag.li1), true, 'B', '#ec4899')
		} else if (view.cursorA != null && view.cursorB != null) {
			const ca = clampLogical(view.cursorA)
			const cb = clampLogical(view.cursorB)
			drawSelectionFill(ca, cb, 0.15)
			const actA = cursorEdgeDrag && cursorEdgeDrag.edge === 'a'
			const actB = cursorEdgeDrag && cursorEdgeDrag.edge === 'b'
			drawEdgeLine(toX(ca), actA, 'A', cursorCol)
			drawEdgeLine(toX(cb), actB, 'B', '#ec4899')
		}

		if (hover && !(drag && drag.moved)) {
			const hx = Math.max(margin.left, Math.min(margin.left + pw, hover.x))
			const hli = fromX(hx)
			const hi = ringIAt(hli)
			const px = toX(hli)
			const py = toY(hi)
			ctx.strokeStyle = muted
			ctx.lineWidth = 1
			ctx.setLineDash([3, 3])
			ctx.beginPath()
			ctx.moveTo(px, margin.top)
			ctx.lineTo(px, margin.top + ph)
			ctx.stroke()
			ctx.setLineDash([])
			ctx.fillStyle = accent
			ctx.beginPath()
			ctx.arc(px, py, 3, 0, Math.PI * 2)
			ctx.fill()
			const rows = [
				['t', fmtTimeAxis(indexToTime(hli))],
				['I', fmtCurrent(hi)],
				['U', setVoltageMv + ' mV'],
				['P', fmtPower(hi * setVoltageV())],
			]
			ctx.font = '11px monospace'
			let boxW = 0
			for (let r = 0; r < rows.length; r++) {
				const wpx = ctx.measureText(rows[r][0] + ' ' + rows[r][1]).width
				if (wpx > boxW) boxW = wpx
			}
			boxW += 16
			const rowH = 14
			const boxH = rows.length * rowH + 8
			let bx = px + 12
			if (bx + boxW > margin.left + pw) bx = px - 12 - boxW
			if (bx < margin.left) bx = margin.left
			let by = Math.min(Math.max(margin.top, hover.y - boxH / 2), margin.top + ph - boxH)
			ctx.globalAlpha = 0.94
			ctx.fillStyle = bg
			ctx.fillRect(bx, by, boxW, boxH)
			ctx.globalAlpha = 1
			ctx.strokeStyle = grid
			ctx.strokeRect(bx, by, boxW, boxH)
			ctx.textAlign = 'left'
			for (let r = 0; r < rows.length; r++) {
				const ty = by + 4 + rowH * r + 11
				ctx.fillStyle = muted
				ctx.fillText(rows[r][0], bx + 8, ty)
				ctx.fillStyle = fg
				ctx.fillText(rows[r][1], bx + 8 + 14, ty)
			}
		}

		ctx.fillStyle = muted
		ctx.font = '10px monospace'
		ctx.textAlign = 'center'
		const winDur = (vr.count > 1) ? (vr.count - 1) * samplePeriodSec : 0
		const totalDur = ringCount > 1 ? (ringCount - 1) * samplePeriodSec : 0
		ctx.fillText(
			'窗口 ' + fmtDuration(winDur) + ' / 总 ' + fmtDuration(totalDur) +
			' · 实测 ' + fmtHz(samplePeriodSec > 0 ? 1 / samplePeriodSec : 0) +
			'Hz/目标 ' + fmtHz(targetRateHz) + 'Hz' +
			(yAxisLog ? ' · LogY' : '') +
			(liveMode && !scrollPaused ? ' · Live' : '') +
			(scrollPaused ? ' · 已暂停滚动' : ''),
			margin.left + pw / 2,
			h - 6
		)

		drawMinimapStrip()
	}

	function drawMinimapStrip() {
		const canvas = E('blu-minimap')
		if (!canvas) return
		const ctx = canvas.getContext('2d')
		const dpr = window.devicePixelRatio || 1
		const rect = canvas.getBoundingClientRect()
		const w = rect.width
		const h = rect.height
		if (w < 8 || h < 4) return
		canvas.width = Math.round(w * dpr)
		canvas.height = Math.round(h * dpr)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		const cs = getComputedStyle(document.documentElement)
		const bg = cs.getPropertyValue('--bg-surface').trim() || '#1e293b'
		const accent = cs.getPropertyValue('--accent').trim() || '#3b82f6'
		const muted = cs.getPropertyValue('--text-muted').trim() || '#64748b'
		ctx.fillStyle = bg
		ctx.fillRect(0, 0, w, h)
		const data = minimap.getData()
		if (data.length < 2) {
			ctx.fillStyle = muted
			ctx.font = '10px sans-serif'
			ctx.textAlign = 'center'
			ctx.fillText('Minimap', w / 2, h / 2 + 3)
			return
		}
		let xMin = data[0].x
		let xMax = data[0].x
		let yMin = data[0].y
		let yMax = data[0].y
		for (let i = 1; i < data.length; i++) {
			if (data[i].x < xMin) xMin = data[i].x
			if (data[i].x > xMax) xMax = data[i].x
			if (data[i].y < yMin) yMin = data[i].y
			if (data[i].y > yMax) yMax = data[i].y
		}
		if (xMax <= xMin) xMax = xMin + 1
		if (yMax <= yMin) yMax = yMin + 1
		ctx.strokeStyle = accent
		ctx.globalAlpha = 0.85
		ctx.lineWidth = 1
		ctx.beginPath()
		for (let i = 0; i < data.length; i++) {
			const x = ((data[i].x - xMin) / (xMax - xMin)) * w
			const y = h - ((data[i].y - yMin) / (yMax - yMin)) * (h - 2) - 1
			if (i === 0) ctx.moveTo(x, y)
			else ctx.lineTo(x, y)
		}
		ctx.stroke()
		ctx.globalAlpha = 1
		// 视口框
		if (recordMode === 'wave' && ringCount > 1 && samplePeriodSec > 0) {
			const vr = getViewRange()
			const t0 = indexToTime(vr.start)
			const t1 = indexToTime(vr.end)
			const totalT = indexToTime(ringCount - 1)
			const tx0 = xMin
			const tx1 = Math.max(xMax, totalT)
			const span = tx1 - tx0 || 1
			const px0 = ((t0 - tx0) / span) * w
			const px1 = ((t1 - tx0) / span) * w
			ctx.fillStyle = 'rgba(59, 130, 246, 0.15)'
			ctx.fillRect(px0, 0, Math.max(2, px1 - px0), h)
			ctx.strokeStyle = accent
			ctx.strokeRect(px0, 0, Math.max(2, px1 - px0), h)
		}
	}

	let uiPending = false
	function scheduleUIUpdate() {
		if (uiPending) return
		uiPending = true
		requestAnimationFrame(function () {
			uiPending = false
			updateDigits()
			updateCanvas()
		})
	}

	function updateCursorInfo() {
		const el = E('blu-cursor-info')
		if (!el) return
		const sel = getSelectionRange()
		if (!sel) {
			el.textContent = ''
			return
		}
		el.textContent = fmtTimeAxis(indexToTime(sel.a)) + ' – ' + fmtTimeAxis(indexToTime(sel.b)) +
			' (' + fmtDuration((sel.b - sel.a) * samplePeriodSec) + ')'
	}

	function clearSelection() {
		view.cursorA = null
		view.cursorB = null
		selectDrag = null
		cursorEdgeDrag = null
		updateCursorInfo()
		scheduleUIUpdate()
	}

	function setCursorEdge(edge, li) {
		li = clampLogical(li)
		if (li == null) return
		if (edge === 'a') view.cursorA = li
		else view.cursorB = li
		// 允许交叉后交换语义：始终保持 A/B 可独立拖
		updateCursorInfo()
	}

	function selectAllData() {
		if (ringCount < 2) return
		view.cursorA = 0
		view.cursorB = ringCount - 1
		liveMode = false
		setScrollPaused(true)
		updateCursorInfo()
		scheduleUIUpdate()
	}

	function zoomToSelection() {
		const sel = getSelectionRange()
		if (!sel) return
		const n = sel.b - sel.a + 1
		if (n < MIN_VIEW_POINTS) return
		// 使视口约等于选择宽度
		view.xZoom = Math.max(X_ZOOM_MIN, Math.min(X_ZOOM_MAX, DEFAULT_VIEW_POINTS / n))
		liveMode = false
		setScrollPaused(true)
		// 视口中心对齐选择中心
		const center = (sel.a + sel.b) / 2
		const half = Math.floor(n / 2)
		const end = Math.min(ringCount - 1, Math.round(center + half))
		view.xOffset = Math.max(0, ringCount - 1 - end)
		scheduleUIUpdate()
	}

	function exportCSV() {
		if (recordMode === 'long') {
			const avg = longStats.n ? longStats.sumI / longStats.n : 0
			const lines = [
				'timestamp_s,current_uA,note',
				'0,' + avg + ',long_stats_avg',
				'0,' + (isFinite(longStats.minI) ? longStats.minI : 0) + ',min',
				'0,' + (isFinite(longStats.maxI) ? longStats.maxI : 0) + ',max',
				'0,' + (longStats.energyUAs / 3600) + ',energy_uAh',
				'0,' + longStats.n + ',count',
			]
			downloadText(lines.join('\n'), 'blu100k_longstats_')
			return
		}
		if (ringCount < 1) {
			bluLog('无数据可导出', 'warn')
			return
		}
		const maxExport = 2000000
		const step = ringCount > maxExport ? Math.ceil(ringCount / maxExport) : 1
		const lines = ['timestamp_s,current_uA,voltage_mV']
		for (let li = 0; li < ringCount; li += step) {
			const t = indexToTime(li)
			const i = ringIAt(li)
			lines.push(t.toFixed(9) + ',' + i + ',' + setVoltageMv)
		}
		downloadText(lines.join('\n'), 'blu100k_')
		bluLog('已导出 ' + Math.ceil(ringCount / step) + ' 点 CSV' + (step > 1 ? '（抽稀 1/' + step + '）' : ''))
	}

	function downloadText(text, prefix) {
		const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
		const a = document.createElement('a')
		a.href = URL.createObjectURL(blob)
		a.download = prefix + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.csv'
		a.click()
		URL.revokeObjectURL(a.href)
	}

	function zoomX(factor) {
		// 缩放不退出 Live / 不暂停滚动，仅改变视口宽度
		view.xZoom = Math.max(X_ZOOM_MIN, Math.min(X_ZOOM_MAX, view.xZoom * factor))
		scheduleUIUpdate()
	}

	function zoomXAt(factor, px) {
		const layout = plotLayout
		if (!layout) { zoomX(factor); return }
		const liBefore = layout.fromX(px)
		view.xZoom = Math.max(X_ZOOM_MIN, Math.min(X_ZOOM_MAX, view.xZoom * factor))
		// Live 时只改倍率、继续贴最新端；已暂停时尽量让指针下数据点保持在原位置
		if (scrollPaused && liBefore != null && ringCount > 1) {
			const viewPts = Math.max(MIN_VIEW_POINTS, Math.round(DEFAULT_VIEW_POINTS / view.xZoom))
			const half = Math.floor(Math.min(ringCount, viewPts) / 2)
			let end = Math.min(ringCount - 1, liBefore + half)
			const start = Math.max(0, end - Math.min(ringCount, viewPts) + 1)
			if (start === 0) end = Math.min(ringCount - 1, start + Math.min(ringCount, viewPts) - 1)
			view.xOffset = Math.max(0, ringCount - 1 - end)
		}
		scheduleUIUpdate()
	}

	function zoomY(factor) {
		view.yZoom = Math.max(Y_ZOOM_MIN, Math.min(Y_ZOOM_MAX, view.yZoom * factor))
		scheduleUIUpdate()
	}

	function resetX() {
		view.xZoom = 1
		view.xOffset = 0
		view.yPanOffset = 0
		// 复位 X 并回到最新波形（Live）
		setScrollPaused(false)
	}

	function resetY() {
		view.yZoom = 1
		view.yPanOffset = 0
		view.yMode = 'auto'
		resetYAuto()
		scheduleUIUpdate()
	}

	function isBluUsbInfo(info) {
		if (!info) return false
		const vid = info.usbVendorId
		const pid = info.usbProductId
		// 与 Python API 一致：VID 0x15A2 PID 0x300A（仅内部过滤，不展示给用户）
		return vid === 0x15A2 && pid === 0x300A
	}

	function normalizeSn(sn) {
		if (sn == null) return ''
		return String(sn).trim().toUpperCase()
	}

	function rememberPortSn(port, sn) {
		sn = normalizeSn(sn)
		if (!port || !sn) return
		if (bluPortSn) bluPortSn.set(port, sn)
		// 持久化最近见过的 SN 列表，刷新后单设备时可回填
		try {
			let list = []
			const raw = localStorage.getItem(BLU_SN_STORE_KEY)
			if (raw) list = JSON.parse(raw)
			if (!Array.isArray(list)) list = []
			list = list.filter(function (s) { return normalizeSn(s) !== sn })
			list.unshift(sn)
			if (list.length > 8) list = list.slice(0, 8)
			localStorage.setItem(BLU_SN_STORE_KEY, JSON.stringify(list))
		} catch (e) {}
	}

	function getPortSn(port) {
		if (!port) return ''
		if (bluPortSn && bluPortSn.has(port)) return bluPortSn.get(port)
		try {
			const info = port.getInfo ? port.getInfo() : {}
			// 标准 Web Serial 无此字段；部分环境/未来规范可能提供
			if (info.serialNumber) return normalizeSn(info.serialNumber)
			if (info.usbSerialNumber) return normalizeSn(info.usbSerialNumber)
		} catch (e) {}
		return ''
	}

	/** WebUSB：已授权同 VID/PID 设备可读 serialNumber（与 pyserial 的 sn 同源） */
	async function fetchBluUsbSerials() {
		const out = []
		if (!navigator.usb || !navigator.usb.getDevices) return out
		try {
			const devices = await navigator.usb.getDevices()
			for (let i = 0; i < devices.length; i++) {
				const d = devices[i]
				if (d.vendorId === 0x15A2 && d.productId === 0x300A) {
					const sn = normalizeSn(d.serialNumber)
					if (sn) out.push(sn)
				}
			}
		} catch (e) {}
		return out
	}

	function loadStoredSns() {
		try {
			const raw = localStorage.getItem(BLU_SN_STORE_KEY)
			const list = raw ? JSON.parse(raw) : []
			if (!Array.isArray(list)) return []
			return list.map(normalizeSn).filter(Boolean)
		} catch (e) {
			return []
		}
	}

	/** 把 SN 绑到端口：优先 WebUSB；数量一致时按下标对应；单设备时用缓存 SN */
	function assignSnsToPorts(ports, usbSns) {
		const stored = loadStoredSns()
		const sns = (usbSns && usbSns.length) ? usbSns : stored
		for (let i = 0; i < ports.length; i++) {
			const p = ports[i]
			let sn = getPortSn(p)
			if (!sn && sns.length === 1 && ports.length === 1) sn = sns[0]
			else if (!sn && i < sns.length && ports.length === sns.length) sn = sns[i]
			else if (!sn && i < sns.length && ports.length === 1) sn = sns[i]
			if (sn) rememberPortSn(p, sn)
		}
	}

	function formatVidPid(info) {
		const vid = info && info.usbVendorId != null
			? ('0x' + info.usbVendorId.toString(16).toUpperCase().padStart(4, '0'))
			: null
		const pid = info && info.usbProductId != null
			? ('0x' + info.usbProductId.toString(16).toUpperCase().padStart(4, '0'))
			: null
		if (vid && pid) return 'VID ' + vid + ' · PID ' + pid
		if (vid) return 'VID ' + vid
		return ''
	}

	function bluPortLabel(port, index) {
		let info = {}
		try { info = port && port.getInfo ? port.getInfo() : {} } catch (e) {}
		const sn = getPortSn(port)
		const vp = formatVidPid(info)
		// 优先 SN；否则 BLU + 规范 VID/PID（带 0x，避免 "15A2:300A" 难读）
		if (sn && vp) return sn + '（' + vp + '）'
		if (sn) return sn
		if (isBluUsbInfo(info) || vp) {
			const n = bluKnownPorts.length > 1 ? (' #' + (index + 1)) : ''
			return 'BLU' + n + (vp ? ' · ' + vp : '')
		}
		return bluKnownPorts.length > 1 ? ('设备 #' + (index + 1)) : '串口设备'
	}

	function syncPortSelectUI() {
		const sel = E('blu-port-select')
		if (!sel) return
		const prev = bluPort
		sel.innerHTML = ''
		if (!bluKnownPorts.length) {
			const opt = document.createElement('option')
			opt.value = ''
			opt.textContent = '未检测到设备'
			sel.appendChild(opt)
			if (!bluOpen) bluPort = null
			return
		}
		for (let i = 0; i < bluKnownPorts.length; i++) {
			const opt = document.createElement('option')
			opt.value = String(i)
			opt.textContent = bluPortLabel(bluKnownPorts[i], i)
			sel.appendChild(opt)
		}
		// 保持当前已打开/已选端口；否则默认第一项（填入，不自动打开）
		let idx = 0
		if (prev) {
			const found = bluKnownPorts.indexOf(prev)
			if (found >= 0) idx = found
		}
		sel.value = String(idx)
		bluPort = bluKnownPorts[idx]
	}

	/** 打开/刷新页面：自动检测已授权 BLU 并填入下拉框（不自动打开） */
	async function refreshBluPorts(opts) {
		opts = opts || {}
		if (!navigator.serial || !navigator.serial.getPorts) {
			const sel = E('blu-port-select')
			if (sel) {
				sel.innerHTML = ''
				const opt = document.createElement('option')
				opt.value = ''
				opt.textContent = '浏览器不支持 Web Serial'
				sel.appendChild(opt)
			}
			return
		}
		try {
			const ports = await navigator.serial.getPorts()
			const matched = []
			const unknown = []
			for (let i = 0; i < ports.length; i++) {
				const p = ports[i]
				let info = {}
				try { info = p.getInfo ? p.getInfo() : {} } catch (e) {}
				if (isBluUsbInfo(info)) matched.push(p)
				else if (info.usbVendorId == null && info.usbProductId == null) unknown.push(p)
			}
			// 优先严格 VID/PID；部分环境 getInfo 为空时退回全部已授权口
			bluKnownPorts = matched.length ? matched : unknown
			const usbSns = await fetchBluUsbSerials()
			assignSnsToPorts(bluKnownPorts, usbSns)
			syncPortSelectUI()
			if (opts.log !== false) {
				if (bluKnownPorts.length) {
					const labels = bluKnownPorts.map(function (p, i) { return bluPortLabel(p, i) })
					bluLog('已检测 ' + bluKnownPorts.length + ' 个设备：' + labels.join(', ') + '（未自动打开）')
				} else {
					bluLog('未检测到已授权 BLU，请点「添加」授权', 'warn')
				}
			}
		} catch (e) {
			bluLog('检测设备失败：' + (e.message || e), 'error')
		}
	}

	function bind() {
		const elPortSel = E('blu-port-select')
		if (elPortSel) {
			elPortSel.addEventListener('change', function () {
				const i = parseInt(this.value, 10)
				if (!isFinite(i) || i < 0 || i >= bluKnownPorts.length) {
					if (!bluOpen) bluPort = null
					return
				}
				const next = bluKnownPorts[i]
				if (bluOpen && next !== bluPort) {
					bluLog('请先关闭当前设备再切换', 'warn')
					// 还原选中
					const cur = bluKnownPorts.indexOf(bluPort)
					this.value = cur >= 0 ? String(cur) : ''
					return
				}
				bluPort = next
				bluLog('已选中 ' + bluPortLabel(next, i))
			})
		}

		const elSelect = E('blu-select-port')
		if (elSelect) {
			elSelect.addEventListener('click', async function () {
				try {
					const port = await navigator.serial.requestPort({
						filters: PROTO.USB_FILTERS,
					})
					if (bluOpen) await bluClosePort({ manual: true })
					// 授权后重新扫描并选中新口
					await refreshBluPorts({ log: false })
					const idx = bluKnownPorts.indexOf(port)
					if (idx < 0) {
						bluKnownPorts.push(port)
						syncPortSelectUI()
						bluPort = port
						const sel = E('blu-port-select')
						if (sel) sel.value = String(bluKnownPorts.length - 1)
					} else {
						bluPort = port
						const sel = E('blu-port-select')
						if (sel) sel.value = String(idx)
					}
					bluLog('已添加并填入 BLU 设备（USB 15A2:300A）')
				} catch (e) {
					if (e && e.name !== 'NotFoundError') bluLog('添加设备：' + (e.message || e), 'error')
				}
			})
		}

		const elOpen = E('blu-open')
		if (elOpen) {
			elOpen.addEventListener('click', async function () {
				if (bluOpening) return
				// 打开前再扫一次，保证列表最新
				if (!bluPort) await refreshBluPorts({ log: false })
				if (!bluPort) {
					bluLog('未检测到设备，请先点「添加」授权 BLU', 'error')
					return
				}
				if (bluOpen) {
					bluOpening = true
					try { await bluClosePort({ manual: true }) } finally { bluOpening = false }
				} else {
					await bluOpenPort()
				}
			})
		}

		// 插拔热更新列表（不自动打开）
		if (navigator.serial) {
			navigator.serial.addEventListener('connect', function () {
				refreshBluPorts({ log: true })
			})
			navigator.serial.addEventListener('disconnect', function (e) {
				const gone = e && e.port
				if (gone && bluPort === gone) {
					if (bluOpen) {
						bluClosePort({ manual: false })
					}
					bluPort = null
				}
				refreshBluPorts({ log: true })
			})
		}

		// 页面打开/刷新：自动检测并填入
		refreshBluPorts({ log: true })

		const elStart = E('blu-start')
		if (elStart) {
			elStart.addEventListener('click', async function () {
				if (bluSampling) await stopSampling()
				else await startSampling()
			})
		}

		const elPowerOn = E('blu-poweron')
		if (elPowerOn) elPowerOn.addEventListener('click', function () { doPowerOn() })

		const elPowerOff = E('blu-poweroff')
		if (elPowerOff) elPowerOff.addEventListener('click', function () { doPowerOff() })

		const elApplyVolt = E('blu-apply-volt')
		if (elApplyVolt) elApplyVolt.addEventListener('click', function () {
			const el = E('blu-voltage-set')
			if (el) el.dataset.userTouched = '1'
			applyVoltageMv(readSetVoltageMv())
		})

		const elVolt = E('blu-voltage-set')
		if (elVolt) {
			// 失焦 / 回车：按 mV 写入（设备未开则只记本地）
			elVolt.addEventListener('change', function () {
				elVolt.dataset.userTouched = '1'
				applyVoltageMv(readSetVoltageMv())
			})
			elVolt.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') {
					e.preventDefault()
					elVolt.dataset.userTouched = '1'
					applyVoltageMv(readSetVoltageMv())
					elVolt.blur()
				}
			})
		}

		const elRate = E('blu-sample-rate')
		if (elRate) {
			elRate.addEventListener('change', function () {
				const p = applyRatePreset()
				if (bluSampling) {
					clearAllData(false)
					warmupLeft = Math.max(0, Math.min(WARMUP_MAX_SAMPLES, Math.round(targetRateHz * WARMUP_SEC)))
					bluLog('采样率已切换为 ' + p.label)
				} else {
					bluLog('采样率目标 ' + p.label + '（下次开始采样生效）')
				}
				scheduleUIUpdate()
			})
		}

		const elMode = E('blu-record-mode')
		if (elMode) {
			elMode.addEventListener('change', function () {
				setRecordMode(this.value)
			})
		}

		const elYLog = E('blu-y-log')
		if (elYLog) {
			elYLog.addEventListener('change', function () {
				setYAxisLog(this.checked)
			})
		}

		const elPause = E('blu-pause-scroll')
		if (elPause) elPause.addEventListener('click', function () {
			setScrollPaused(!scrollPaused)
		})

		const elFull = E('blu-fullscreen')
		if (elFull) elFull.addEventListener('click', function () {
			setWaveFullscreen(!waveFullscreen)
		})

		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && waveFullscreen) setWaveFullscreen(false)
		})

		const elLogToggle = E('blu-log-toggle')
		if (elLogToggle) elLogToggle.addEventListener('click', function () {
			logPinned = !logPinned
			const card = E('blu-log-card')
			if (card) card.classList.toggle('pinned', logPinned)
			const box = E('blu-log')
			if (box && logPinned) box.scrollTop = box.scrollHeight
		})

		const elExport = E('blu-export')
		if (elExport) elExport.addEventListener('click', exportCSV)

		const elClear = E('blu-clear')
		if (elClear) elClear.addEventListener('click', function () { clearAllData(true) })

		const elClearLog = E('blu-clear-log')
		if (elClearLog) {
			elClearLog.addEventListener('click', function () {
				const box = E('blu-log')
				if (box) box.innerHTML = ''
			})
		}

		const bindClick = function (id, fn) {
			const el = E(id)
			if (el) el.addEventListener('click', fn)
		}
		bindClick('blu-zoom-x-in', function () { zoomX(1.6) })
		bindClick('blu-zoom-x-out', function () { zoomX(1 / 1.6) })
		bindClick('blu-zoom-x-reset', resetX)
		bindClick('blu-zoom-y-in', function () { zoomY(1.6) })
		bindClick('blu-zoom-y-out', function () { zoomY(1 / 1.6) })
		bindClick('blu-zoom-y-reset', resetY)
		bindClick('blu-cursor-clear', clearSelection)
		bindClick('blu-cursor-all', selectAllData)
		bindClick('blu-cursor-zoom', zoomToSelection)

		const canvas = E('blu-canvas')
		if (canvas) {
			canvas.addEventListener('wheel', function (e) {
				e.preventDefault()
				const factor = e.deltaY > 0 ? (1 / 1.15) : 1.15
				const rect = canvas.getBoundingClientRect()
				// Shift+滚轮：Y 缩放；普通滚轮：X 缩放（与选择的 Shift+拖动不冲突）
				if (e.shiftKey) zoomY(factor)
				else zoomXAt(factor, e.clientX - rect.left)
			}, { passive: false })

			canvas.addEventListener('pointerdown', function (e) {
				if (e.button !== 0) return
				const rect = canvas.getBoundingClientRect()
				const x = e.clientX - rect.left
				const y = e.clientY - rect.top
				// 1) 拖游标边界微调（已有选择时，优先于平移）
				if (!e.shiftKey && plotLayout) {
					const edge = hitTestCursorEdge(x)
					if (edge) {
						cursorEdgeDrag = { edge: edge }
						try { canvas.setPointerCapture(e.pointerId) } catch (err) {}
						canvas.style.cursor = 'ew-resize'
						scheduleUIUpdate()
						return
					}
				}
				// 2) PPK：Shift + 左键拖动 = 新建选择区间
				if (e.shiftKey && plotLayout) {
					const li = plotLayout.fromX(x)
					selectDrag = { x0: x, li0: li, x1: x, li1: li }
					view.cursorA = null
					view.cursorB = null
					try { canvas.setPointerCapture(e.pointerId) } catch (err) {}
					scheduleUIUpdate()
					return
				}
				// 3) 平移：立刻暂停 Live；抓住指针下的数据点做跟手拖拽
				if (!scrollPaused) setScrollPaused(true)
				const liGrab = plotLayout ? plotLayout.fromX(x) : 0
				drag = {
					x0: x, y0: y,
					lastX: x, lastY: y,
					liAnchor: liGrab,
					yPan0: view.yPanOffset,
					moved: false,
					ptr: e.pointerId,
				}
				try { canvas.setPointerCapture(e.pointerId) } catch (err) {}
			})
			canvas.addEventListener('pointermove', function (e) {
				const rect = canvas.getBoundingClientRect()
				const x = e.clientX - rect.left
				const y = e.clientY - rect.top
				hover = { x: x, y: y }

				// 悬停在游标线上显示 ew-resize
				if (!cursorEdgeDrag && !selectDrag && !drag && plotLayout) {
					canvas.style.cursor = hitTestCursorEdge(x) ? 'ew-resize' : 'crosshair'
				}

				if (cursorEdgeDrag && plotLayout) {
					const li = plotLayout.fromX(x)
					setCursorEdge(cursorEdgeDrag.edge, li)
					scheduleUIUpdate()
					return
				}
				if (selectDrag && plotLayout) {
					selectDrag.x1 = x
					selectDrag.li1 = plotLayout.fromX(x)
					scheduleUIUpdate()
					return
				}
				if (drag) {
					const dx = x - drag.x0
					const dy = y - drag.y0
					drag.lastX = x
					drag.lastY = y
					if (!drag.moved && (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX)) {
						drag.moved = true
						// 开始移动瞬间重新抓点，避免阈值抖动
						if (plotLayout) drag.liAnchor = plotLayout.fromX(drag.x0)
					}
					if (drag.moved) {
						// 跟手：抓取的数据点始终停在当前鼠标 X 下
						panViewSoLiAtPixel(drag.liAnchor, x)
						if (plotLayout && plotLayout.ph > 0) {
							const ySpan = plotLayout.yMax - plotLayout.yMin
							view.yPanOffset = drag.yPan0 + (dy / plotLayout.ph) * ySpan
						}
					}
				}
				scheduleUIUpdate()
			})
			canvas.addEventListener('pointerup', function (e) {
				if (cursorEdgeDrag) {
					cursorEdgeDrag = null
					canvas.style.cursor = 'crosshair'
					updateCursorInfo()
					scheduleUIUpdate()
					return
				}
				if (selectDrag) {
					const a = selectDrag.li0
					const b = selectDrag.li1
					selectDrag = null
					if (a != null && b != null && a !== b) {
						view.cursorA = clampLogical(a)
						view.cursorB = clampLogical(b)
						setScrollPaused(true)
					}
					updateCursorInfo()
					scheduleUIUpdate()
					return
				}
				drag = null
				scheduleUIUpdate()
			})
			canvas.addEventListener('pointerleave', function () {
				hover = null
				if (!cursorEdgeDrag) canvas.style.cursor = 'crosshair'
				scheduleUIUpdate()
			})
		}

		// minimap（总览）：点击 / 拖动实时定位主波形窗口
		const mm = E('blu-minimap')
		if (mm) {
			function minimapSeekToClientX(clientX) {
				if (recordMode !== 'wave' || ringCount < 2) return
				const rect = mm.getBoundingClientRect()
				const w = rect.width || 1
				let t = (clientX - rect.left) / w
				if (t < 0) t = 0
				if (t > 1) t = 1
				const center = Math.round(t * (ringCount - 1))
				// 用当前缩放对应的视口宽度（不走 getViewRange，避免 live 逻辑干扰）
				let viewPts = Math.max(MIN_VIEW_POINTS, Math.round(DEFAULT_VIEW_POINTS / view.xZoom))
				viewPts = Math.min(ringCount, viewPts)
				const half = Math.floor(viewPts / 2)
				let end = Math.min(ringCount - 1, center + half)
				let start = end - viewPts + 1
				if (start < 0) {
					start = 0
					end = Math.min(ringCount - 1, start + viewPts - 1)
				}
				liveMode = false
				if (!scrollPaused) setScrollPaused(true)
				view.xOffset = Math.max(0, ringCount - 1 - end)
				scheduleUIUpdate()
			}

			mm.addEventListener('pointerdown', function (e) {
				if (e.button !== 0) return
				if (recordMode !== 'wave' || ringCount < 2) return
				minimapDrag = true
				try { mm.setPointerCapture(e.pointerId) } catch (err) {}
				minimapSeekToClientX(e.clientX)
				e.preventDefault()
			})
			mm.addEventListener('pointermove', function (e) {
				if (!minimapDrag) return
				minimapSeekToClientX(e.clientX)
			})
			function endMmDrag(e) {
				if (!minimapDrag) return
				minimapDrag = false
				if (e && e.pointerId != null) {
					try { mm.releasePointerCapture(e.pointerId) } catch (err) {}
				}
			}
			mm.addEventListener('pointerup', endMmDrag)
			mm.addEventListener('pointercancel', endMmDrag)
			mm.addEventListener('lostpointercapture', function () { minimapDrag = false })
		}

		window.addEventListener('resize', function () { scheduleUIUpdate() })

		if (!navigator.serial) {
			bluLog('当前浏览器不支持 Web Serial（请用 Chrome / Edge）', 'error')
		} else {
			bluLog('BLU 100k 就绪 · USB CDC · 选设备过滤 15A2:300A · 速率以实测为准')
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', bind)
	} else {
		bind()
	}
})()
