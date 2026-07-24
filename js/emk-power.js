;// EMK850+ 功耗分析仪 — 独立 Web Serial + 电流波形/统计/时间轴
(function () {
	'use strict'

	const PROTO = window.EmkProtocol
	if (!PROTO) {
		console.error('[emk-power] 依赖 EmkProtocol 未加载')
		return
	}

	// 主界面 OpenDevice 为 115200；若设备无响应可改 230400
	const BAUD = 115200
	const DEFAULT_VIEW_POINTS = 2000
	const DIGIT_UI_HZ = 5 // 大数字刷新率，避免肉眼跟不住
	const NOMINAL_STREAM_HZ = 10000 // 档位标称流速，仅在实测出来之前用
	const X_ZOOM_MIN = 0.005 // 更大时间窗
	const X_ZOOM_MAX = 2000  // 更细时间窗
	const MIN_VIEW_POINTS = 4 // X 轴最少可见点数（放到最大倍数时）
	const Y_ZOOM_MIN = 0.1
	const Y_ZOOM_MAX = 100
	const DRAG_THRESHOLD_PX = 4 // 小于此位移算点击（放游标），大于则算拖动平移
	const PERIOD_LOCK_SEC = 10 // 采样间隔实测收敛时间，之后锁死时间基准
	// 开始采样瞬间（继电器/供电切换、ADC 尚未稳定）常见一两个异常尖峰，与真实电流无关；
	// 若不丢弃，这几个点会长期停在波形最左边（getViewRange 在总点数不足视口宽度、
	// 或用户缩到查看整段录制时，start 会钳在逻辑下标 0，也就是这几个坏点上）。
	const STARTUP_DROP_SAMPLES = 3

	// 采样率预设：设备侧 10K 流 + 客户端抽稀（对照上位机 100us/1ms/10ms/100ms 档）
	const RATE_PRESETS = {
		'100k': { hz: 100000, label: '100K (10µs)', send100k: true },
		'10k':  { hz: 10000, label: '10K (100µs)', send10k: true },
		'1k':   { hz: 1000,  label: '1K (1ms)',    send10k: true },
		'100':  { hz: 100,   label: '100Hz (10ms)', send10k: true },
		'10':   { hz: 10,    label: '10Hz (100ms)', send10k: true },
		'1':    { hz: 1,     label: '1Hz (1s)',     send10k: true },
	}

	function E(id) {
		return document.getElementById(id)
	}

	let emkPort = null
	let emkOpen = false
	let emkOpening = false
	let emkManualClose = true
	let emkSampling = false
	let emkPowered = false
	let emkReader = null
	let conf = PROTO.defaultConf()
	let useConverted = true
	let isHave5A = false
	let setVoltageV = 3.7
	let deviceVoltageSet = null // 设备 0x69 上报的设定电压
	let deviceProtectCurrentMA = 0 // 0x69 上报的过流保护值 mA（出厂 6000）
	let deviceProtectVoltV = 0 // 0x69 上报的过压保护值 V（出厂 13）
	let protectInputsSynced = false // 是否已把设备当前限值回填到输入框
	let lastVoltSetLogTs = 0
	let isAM = false // AM 机用 0x61 设压/下电
	let wakeLockSentinel = null
	let targetRateHz = 1000
	let samplePeriodSec = 0.001 // 实测值：入库点的真实间隔（时间轴/时长/CSV 都用它）
	let decimFactor = 10
	let decimCounter = 0
	// 100K/10µs 高速档：只有激活了该功能的机器才会上报 0x84 帧。
	// null = 未知，true/false = 已探测。未激活的机器照常收 0x21，功能自动降级。
	let supports100K = null
	let highSpeedFrames = 0
	let hsProbeTimer = 0
	// 采样帧断流监控：设备停发 0x21/0x84 时点名说出来，而不是波形静悄悄不动
	let lastSampleFrameTs = 0
	let sampleFrameCount = 0
	let stallTimer = 0
	let stallReported = false
	let startSampleTs = 0
	let startupDropRemaining = 0 // 见 STARTUP_DROP_SAMPLES：开始采样后还要丢弃的入库点数
	// 设备原始流速：档位标称 10K，实测本机约 8.4K，测到后即以实测为准
	let deviceStreamHz = 0
	let rawStreamCount = 0
	let rawStreamFirstTs = 0
	// 1 秒滑窗的原始流速，供实时显示（deviceStreamHz 是累计均值，用于时间基准）
	let rawWinCount = 0
	let rawWinTs = 0
	let rawRateEst = 0
	let firstSampleTs = 0
	let periodLogged = false
	let periodLocked = false

	// <<< RINGBUF BEGIN >>> 分块环形缓冲 + 块摘要（scratchpad 的 node 对拍脚本按此标记抽取本段）
	// 数据源：电流 16 位有符号、电压最宽 16 位，Float32 的 24 位尾数余量充足；
	// 统计累加从 TypedArray 读出后在 JS 里天然是 double，精度不受影响。
	const CHUNK_BITS = 16
	const CHUNK_SIZE = 1 << CHUNK_BITS // 65536 点/块，Float32 每块 256KB（I+V 共 512KB）
	const CHUNK_MASK = CHUNK_SIZE - 1
	const CAP_TIERS = [2097152, 8388608, 33554432] // 2M / 8M / 32M 点
	const CAP_HARD_MAX = 67108864 // 调试覆盖的上限：64M 点
	const CAP_STORE_KEY = 'emk-ring-capacity' // 仅调试用的 localStorage 覆盖，无界面入口

	// 容量档位自动判断：有 deviceMemory 就按内存选，没有（Safari/Firefox 返回 undefined）用默认 8M 点
	function pickCapacity() {
		let cap = CAP_TIERS[1]
		let dm = 0
		try {
			if (typeof navigator !== 'undefined' && navigator && isFinite(navigator.deviceMemory)) {
				dm = navigator.deviceMemory
			}
		} catch (e) {}
		// deviceMemory 只用于「降档」：Chrome 出于指纹防护把它封顶在 8，几乎所有桌面机都报 8，
		// 拿它升到 32M 档等于默认吃 256MB。高档只走下面的 localStorage 显式覆盖。
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

	const chunkI = [] // Float32Array[] µA，懒分配
	const chunkV = [] // Float32Array[] V（回读）
	// 每块摘要：块被复用（off 归零）时整块重置。min/max 在环形淘汰下无法增量回退，
	// 只能靠「完整块摘要 + 首尾不完整块逐点」重算，绝不做增量退让。
	const statSumI = new Float64Array(MAX_CHUNKS)
	const statSumP = new Float64Array(MAX_CHUNKS)
	const statMin = new Float64Array(MAX_CHUNKS)
	const statMax = new Float64Array(MAX_CHUNKS)
	const statN = new Float64Array(MAX_CHUNKS)

	let ringCap = 0 // 已分配容量（点）= chunkI.length * CHUNK_SIZE，涨到 RING_CAP_MAX 为止
	let ringHead = 0
	let ringCount = 0
	let sampleCount = 0
	let growBlocked = false
	const ringPair = [0, 0] // 同时取 I/V 的复用出参，避免算两次块索引

	function statResetSlot(slot) {
		statSumI[slot] = 0
		statSumP[slot] = 0
		statMin[slot] = Infinity
		statMax[slot] = -Infinity
		statN[slot] = 0
	}

	function allocChunk(slot) {
		try {
			const ci = new Float32Array(CHUNK_SIZE)
			const cv = new Float32Array(CHUNK_SIZE)
			chunkI[slot] = ci
			chunkV[slot] = cv
			statResetSlot(slot)
			return true
		} catch (e) {
			return false
		}
	}

	// 需要新块时才分配；到达上限或分配失败就地回绕（块粒度淘汰），稳态零分配、内存有界。
	// 只有「尚未回绕过」的首填阶段才会扩容，所以容量变化不会打乱已存数据的物理映射。
	function ensureHeadChunk() {
		if (ringHead < ringCap) return
		const slot = ringHead / CHUNK_SIZE
		if (!growBlocked && slot < MAX_CHUNKS) {
			if (allocChunk(slot)) {
				ringCap = (slot + 1) * CHUNK_SIZE
				return
			}
			growBlocked = true
			emkLog('缓冲扩容失败（内存不足），容量停在 ' + ringCap.toLocaleString() + ' 点，开始复用最旧块', 'warn')
		}
		ringHead = 0
	}

	function ringPush(cur, volt) {
		ensureHeadChunk()
		if (ringCap < 1) return // 连第一块都分配不出来（极端内存不足），丢点也不能抛异常打断读串口
		const slot = ringHead >> CHUNK_BITS
		const off = ringHead & CHUNK_MASK
		if (off === 0) statResetSlot(slot) // 新块或复用最旧块：摘要整块重置
		const ci = chunkI[slot]
		const cv = chunkV[slot]
		ci[off] = cur
		cv[off] = volt
		// 回读 Float32 存储值再累加，保证摘要与逐点遍历的结果口径一致
		const fi = ci[off]
		const fv = cv[off]
		statSumI[slot] += fi
		statSumP[slot] += fi * fv
		if (fi < statMin[slot]) statMin[slot] = fi
		if (fi > statMax[slot]) statMax[slot] = fi
		statN[slot]++
		ringHead++
		if (ringCount < ringCap) ringCount++
		else noteRingEvict() // 满了：每新增 1 点淘汰 1 点，sampleCount - ringCount 即累计淘汰数
		sampleCount++
	}

	// 逻辑下标（0 = 缓冲内最旧点）→ 物理下标
	function logicalToPhys(li) {
		if (ringCap < 1) return 0
		const p = (ringHead - ringCount + li) % ringCap
		return p < 0 ? p + ringCap : p
	}

	function ringIAt(li) {
		const p = logicalToPhys(li)
		const c = chunkI[p >> CHUNK_BITS]
		return c ? c[p & CHUNK_MASK] : NaN
	}

	function ringVAt(li) {
		const p = logicalToPhys(li)
		const c = chunkV[p >> CHUNK_BITS]
		return c ? c[p & CHUNK_MASK] : NaN
	}

	// 同一逻辑点同时要 I 和 V 时用它，块索引只算一次；结果写进复用数组 ringPair
	function ringPairAt(li) {
		const p = logicalToPhys(li)
		const s = p >> CHUNK_BITS
		const o = p & CHUNK_MASK
		ringPair[0] = chunkI[s] ? chunkI[s][o] : NaN
		ringPair[1] = chunkV[s] ? chunkV[s][o] : NaN
		return ringPair
	}

	// 清空：保留已分配的块（避免反复 alloc/GC），只重置游标与摘要
	function ringReset() {
		ringHead = 0
		ringCount = 0
		sampleCount = 0
		for (let s = 0; s < chunkI.length; s++) statResetSlot(s)
	}

	function emptyStats() {
		return { avg: NaN, max: NaN, min: NaN, pwr: NaN, n: 0, dur: 0 }
	}

	// 逐点扫描绝对序号闭区间 [a0, a1]
	function scanAbs(a0, a1, acc) {
		if (a1 < a0 || ringCap < 1) return
		let p = logicalToPhys(a0 - (sampleCount - ringCount))
		for (let a = a0; a <= a1; a++) {
			const s = p >> CHUNK_BITS
			const ci = chunkI[s]
			if (ci) {
				const o = p & CHUNK_MASK
				const i = ci[o]
				const v = chunkV[s][o]
				acc.sumI += i
				acc.sumP += i * v // µA * V = µW（用回读电压）
				if (i < acc.mn) acc.mn = i
				if (i > acc.mx) acc.mx = i
				acc.n++
			}
			p++
			if (p >= ringCap) p = 0
		}
	}

	function addSlotStat(slot, acc) {
		acc.sumI += statSumI[slot]
		acc.sumP += statSumP[slot]
		if (statMin[slot] < acc.mn) acc.mn = statMin[slot]
		if (statMax[slot] > acc.mx) acc.mx = statMax[slot]
		acc.n += statN[slot]
	}

	// 区间统计：完整块走摘要 O(块数)，首尾不完整块逐点（各 < 一个块）。
	// 全缓冲统计因此不再是 O(N)，24h 长跑每帧开销恒定。
	function calcStats(start, end) {
		if (ringCount < 1) return emptyStats()
		if (start < 0) start = 0
		if (end > ringCount - 1) end = ringCount - 1
		if (end < start) return emptyStats()
		const base = sampleCount - ringCount
		const aLo = base + start
		const aHi = base + end
		const acc = { sumI: 0, sumP: 0, mn: Infinity, mx: -Infinity, n: 0 }
		const fullLo = Math.ceil(aLo / CHUNK_SIZE) * CHUNK_SIZE
		const fullHi = Math.floor((aHi + 1) / CHUNK_SIZE) * CHUNK_SIZE // 不含
		if (fullHi <= fullLo) {
			scanAbs(aLo, aHi, acc)
		} else {
			scanAbs(aLo, fullLo - 1, acc)
			for (let a = fullLo; a < fullHi; a += CHUNK_SIZE) {
				addSlotStat((a % ringCap) / CHUNK_SIZE, acc)
			}
			if (aHi >= fullHi) {
				// 尾段若正好是当前写入块的已写部分，直接用在线摘要，省掉每帧最多 6.5 万点扫描
				const s = (fullHi % ringCap) / CHUNK_SIZE
				if (aHi === sampleCount - 1 && statN[s] === aHi - fullHi + 1) addSlotStat(s, acc)
				else scanAbs(fullHi, aHi, acc)
			}
		}
		if (!acc.n) return emptyStats()
		const dur = acc.n > 1 ? (acc.n - 1) * samplePeriodSec : samplePeriodSec
		return { avg: acc.sumI / acc.n, max: acc.mx, min: acc.mn, pwr: acc.sumP / acc.n, n: acc.n, dur: dur }
	}

	// 逐点扫描绝对序号闭区间 [a0, a1] 求 min/max（供波形每像素列包络用，calcStats 的精简版）
	function scanAbsMinMax(a0, a1, out) {
		if (a1 < a0 || ringCap < 1) return
		let p = logicalToPhys(a0 - (sampleCount - ringCount))
		for (let a = a0; a <= a1; a++) {
			const s = p >> CHUNK_BITS
			const ci = chunkI[s]
			if (ci) {
				const v = ci[p & CHUNK_MASK]
				if (v < out.mn) out.mn = v
				if (v > out.mx) out.mx = v
			}
			p++
			if (p >= ringCap) p = 0
		}
	}

	function addSlotMinMax(slot, out) {
		if (statMin[slot] < out.mn) out.mn = statMin[slot]
		if (statMax[slot] > out.mx) out.mx = statMax[slot]
	}

	// 绝对区间 [aLo, aHi] 的 min/max：与 calcStats 同样的「完整块走摘要、首尾逐点」策略，
	// 波形每像素列包络在缩得很小时（bucketSize 达到/超过 CHUNK_SIZE）直接命中块摘要，
	// 避免几十万点的逐点扫描。
	function bucketMinMaxAbs(aLo, aHi) {
		const out = { mn: Infinity, mx: -Infinity }
		if (aHi < aLo || ringCap < 1) return out
		const fullLo = Math.ceil(aLo / CHUNK_SIZE) * CHUNK_SIZE
		const fullHi = Math.floor((aHi + 1) / CHUNK_SIZE) * CHUNK_SIZE // 不含
		if (fullHi <= fullLo) {
			scanAbsMinMax(aLo, aHi, out)
		} else {
			scanAbsMinMax(aLo, fullLo - 1, out)
			for (let a = fullLo; a < fullHi; a += CHUNK_SIZE) {
				addSlotMinMax((a % ringCap) / CHUNK_SIZE, out)
			}
			if (aHi >= fullHi) {
				const s = (fullHi % ringCap) / CHUNK_SIZE
				if (aHi === sampleCount - 1 && statN[s] === aHi - fullHi + 1) addSlotMinMax(s, out)
				else scanAbsMinMax(fullHi, aHi, out)
			}
		}
		return out
	}
	// <<< RINGBUF END >>>

	let sampleRateLastTs = 0
	let sampleRateCount = 0
	let sampleRateEst = 0
	let latestCurrentUA = 0
	let latestVoltageV = 0
	// 显示用平滑值（EMA），降低数字跳动
	let dispCurrentUA = 0
	let dispVoltageV = 0
	let dispInit = false
	let lastDigitUiTs = 0
	let confLoaded = false

	const parser = new PROTO.FrameParser()
	const bigData = new PROTO.BigDataAssembler()

	const view = {
		xZoom: 1,
		xOffset: 0,
		yMode: 'auto',
		yMin: 0,
		yMax: 1,
		yZoom: 1,
		yPanOffset: 0, // Y 轴手动上下平移量（数据单位 µA），叠加在 auto/manual 算出的 yMin/yMax 之上
		// 游标：默认窗口比例 [0,1] 固定在视口；可选 data 模式绑逻辑下标
		cursorMode: 'window', // 'window' | 'data'
		cursorA: null,
		cursorB: null,
		baseViewPoints: DEFAULT_VIEW_POINTS,
	}

	let drag = null
	let hover = null // { x, y, li } 鼠标悬停十字线
	let plotLayout = null

	// 波形每像素列 min/max 包络缓存：key 是绝对列号（abs 下标 / bucketSize，bucketSize 为
	// 2 的幂），value 是 { min, max, first, last }。列划分锚定绝对采样序号，同一列在滚动时
	// physical 内容不变，因此「完整写入、未被淘汰」的列可以跨帧复用，只有视口最新一端仍在
	// 写入的列、以及最旧一端被环形淘汰临界的列需要每帧重算。bucketSize 变化（缩放）整体清空。
	let bucketCache = new Map()
	let bucketCacheSize = 0
	let bucketCacheStride = 0 // 缓存内容对应的 bucketSize，变了必须整体清空
	const BUCKET_CACHE_MAX = 8192 // 足够覆盖若干屏宽度的列数，超过后按插入顺序淘汰最旧

	function clearBucketCache() {
		bucketCache.clear()
		bucketCacheSize = 0
		bucketCacheStride = 0
	}

	// 把可见区间 vr.count 个点分摊到 pw 个像素列所需的最小 2 的幂列宽
	function computeBucketSize(count, pw) {
		if (pw < 1) return 1
		const raw = Math.ceil(count / pw)
		if (raw <= 1) return 1
		let b = 1
		while (b < raw) b <<= 1
		return b
	}

	// 计算单个绝对列号的 min/max/首尾样本；loAbs/hiAbs 已按当前环形缓冲有效区间裁剪
	function computeBucketEntry(bucketIdx, bucketSize, base, lastAbs) {
		const bStart = bucketIdx * bucketSize
		const bEnd = bStart + bucketSize - 1
		const loAbs = bStart < base ? base : bStart
		const hiAbs = bEnd > lastAbs ? lastAbs : bEnd
		if (hiAbs < loAbs) return null
		const mm = bucketMinMaxAbs(loAbs, hiAbs)
		const loLi = loAbs - base
		const hiLi = hiAbs - base
		const first = ringIAt(loLi)
		const last = hiLi === loLi ? first : ringIAt(hiLi)
		return { min: mm.mn, max: mm.mx, first: first, last: last, loAbs: loAbs, hiAbs: hiAbs, bStart: bStart, bEnd: bEnd }
	}

	// 取一列的包络，能缓存则缓存：只有「列的绝对范围完全落在当前有效数据区间内
	// （不含被淘汰的旧端、不含仍在写入的新端）」才写入缓存，否则该列内容本帧后还会变，
	// 每帧都得重算（正常情况下这样的列最多两个：视口两端各一个）。
	function getBucketEntry(bucketIdx, bucketSize, base, lastAbs) {
		// key 只有列号，不含列宽：缩放改变 bucketSize 后旧列号会与新列号碰撞，必须先整体清空
		if (bucketCacheStride !== bucketSize) {
			clearBucketCache()
			bucketCacheStride = bucketSize
		}
		const cacheable = (bucketIdx * bucketSize) >= base && (bucketIdx * bucketSize + bucketSize - 1) <= lastAbs
		if (cacheable) {
			const hit = bucketCache.get(bucketIdx)
			if (hit) return hit
		}
		const entry = computeBucketEntry(bucketIdx, bucketSize, base, lastAbs)
		if (cacheable && entry) {
			if (bucketCacheSize >= BUCKET_CACHE_MAX) {
				const oldestKey = bucketCache.keys().next().value
				bucketCache.delete(oldestKey)
				bucketCacheSize--
			}
			bucketCache.set(bucketIdx, entry)
			bucketCacheSize++
		}
		return entry
	}
	let scrollPaused = false // 暂停波形滚动（仅冻结视口，采集继续）
	let waveFullscreen = false
	let logPinned = false

	// Y 自适应量化 + 迟滞状态：target 是量化后、带迟滞更新的目标区间；
	// disp 是朝 target 做 EMA 平滑后的实际渲染区间。二者分离，避免平滑值
	// 反过来触发新一轮量化判定形成抖动闭环。
	let yAutoTargetMin = null
	let yAutoTargetMax = null
	let yAutoDispMin = null
	let yAutoDispMax = null

	function resetYAuto() {
		yAutoTargetMin = null
		yAutoTargetMax = null
		yAutoDispMin = null
		yAutoDispMax = null
	}

	function emkLog(msg, level) {
		const box = E('emk-log')
		if (!box) return
		const time = new Date().toLocaleTimeString()
		const cls = { info: '', success: 'text-success', error: 'text-danger', warn: 'text-warning' }[level || 'info'] || ''
		const line = document.createElement('div')
		if (cls) line.className = cls
		line.textContent = '[' + time + '] ' + msg
		box.appendChild(line)
		while (box.childElementCount > 300) box.removeChild(box.firstChild)
		box.scrollTop = box.scrollHeight
		// 日志默认收起，标题栏保留最后一条摘要
		const last = E('emk-log-last')
		if (last) {
			last.textContent = msg.length > 42 ? msg.slice(0, 42) + '…' : msg
			last.className = 'emk-log-last' + (cls ? ' ' + cls : '')
		}
	}

	function setStatus(text, connected) {
		const el = E('emk-status')
		if (!el) return
		const dot = connected ? 'connected' : 'disconnected'
		const label = connected ? '已连接' : '未连接'
		el.innerHTML = '<div class="serial-status-indicator ' + dot + '"><span class="serial-status-dot"></span><span class="serial-status-text">' + label + (text ? ' · ' + text : '') + '</span></div>'
	}

	function fmtCurrent(ua) {
		if (!isFinite(ua)) return '--'
		if (!useConverted) return Math.round(ua) + ' raw'
		const a = Math.abs(ua)
		if (a >= 1e6) return (ua / 1e6).toFixed(3) + ' A'
		if (a >= 1e3) return (ua / 1e3).toFixed(3) + ' mA'
		if (a >= 1) return ua.toFixed(2) + ' µA'
		if (a >= 1e-3) return (ua * 1e3).toFixed(2) + ' nA'
		return ua.toFixed(3) + ' µA'
	}

	function fmtPower(uw) {
		if (!isFinite(uw)) return '--'
		const a = Math.abs(uw)
		if (a >= 1e6) return (uw / 1e6).toFixed(3) + ' W'
		if (a >= 1e3) return (uw / 1e3).toFixed(2) + ' mW'
		if (a >= 1) return uw.toFixed(2) + ' µW'
		if (a >= 1e-3) return (uw * 1e3).toFixed(2) + ' nW'
		return uw.toFixed(3) + ' µW'
	}

	function fmtEnergy(uAh) {
		if (!isFinite(uAh) || uAh < 0) return '--'
		const a = Math.abs(uAh)
		if (a >= 1e6) return (uAh / 1e6).toFixed(3) + ' Ah'
		if (a >= 1e3) return (uAh / 1e3).toFixed(2) + ' mAh'
		if (a >= 1) return uAh.toFixed(1) + ' µAh'
		if (a >= 1e-3) return (uAh * 1e3).toFixed(2) + ' nAh'
		return uAh.toFixed(3) + ' µAh'
	}

	function fmtDuration(sec) {
		if (!isFinite(sec) || sec < 0) return '--'
		if (sec < 1e-3) return (sec * 1e6).toFixed(1) + ' µs'
		if (sec < 1) return (sec * 1e3).toFixed(2) + ' ms'
		if (sec < 60) return sec.toFixed(3) + ' s'
		const m = Math.floor(sec / 60)
		const s = sec - m * 60
		if (m < 60) return m + 'm ' + s.toFixed(2) + 's'
		const h = Math.floor(m / 60)
		return h + 'h ' + (m % 60) + 'm'
	}

	function fmtTimeAxis(sec) {
		if (!isFinite(sec)) return ''
		const sign = sec < 0 ? '-' : ''
		const t = Math.abs(sec)
		if (t < 1e-3) return sign + (t * 1e6).toFixed(0) + 'µs'
		if (t < 1) return sign + (t * 1e3).toFixed(t < 0.01 ? 2 : 1) + 'ms'
		if (t < 60) return sign + t.toFixed(t < 10 ? 2 : 1) + 's'
		return sign + (t / 60).toFixed(1) + 'm'
	}

	function fmtHz(hz) {
		if (!isFinite(hz) || hz <= 0) return '--'
		if (hz >= 1000) return (hz / 1000).toFixed(hz >= 10000 ? 1 : 2) + 'k'
		return Math.round(hz) + ''
	}

	function readSetVoltage() {
		const el = E('emk-voltage-set')
		let v = el ? parseFloat(el.value) : setVoltageV
		if (!isFinite(v)) v = 3.3
		if (v < 0) v = 0
		if (v > 24) v = 24
		setVoltageV = v
		return v
	}

	// 设备一上报 0x69 就把当前限值回填到输入框，避免用户误按「保护」时
	// 把设备的过流/过压保护值改小（改小会连设备本机旋钮一起限死）。
	function syncProtectInputs() {
		if (protectInputsSynced) return
		if (!(deviceProtectCurrentMA > 0)) return
		protectInputsSynced = true
		const elC = E('emk-protect-current')
		const elV = E('emk-protect-volt')
		if (elC) elC.value = String(deviceProtectCurrentMA)
		// 本机过压位回读为 0（未设过），保持 0 才是原状，不要拿 13 去覆盖
		if (elV) elV.value = String(deviceProtectVoltV)
		emkLog('设备保护限值回读：过流 ' + deviceProtectCurrentMA + ' mA · 过压 ' + deviceProtectVoltV + ' V')
	}

	function readProtectLimits() {
		const elC = E('emk-protect-current')
		const elV = E('emk-protect-volt')
		let ma = elC ? parseFloat(elC.value) : 6000
		let v = elV ? parseFloat(elV.value) : 13
		if (!isFinite(ma) || ma <= 0) ma = 6000
		if (!isFinite(v) || v <= 0) v = 13
		return { currentMA: ma, voltV: v }
	}

	// 0x72 写的是设备持久化的过流/过压保护值，同时限制设备本机旋钮的可调范围
	// （出厂 6000 mA / 13 V）。只在用户点「保护」按钮时下发，绝不自动补发。
	// 上位机在「用户设置」里同样连发 3 次。
	async function applyAutoProtect(manual) {
		if (!emkOpen) {
			if (manual) emkLog('请先打开设备', 'error')
			return false
		}
		const lim = readProtectLimits()
		if (deviceProtectCurrentMA > 0 && lim.currentMA < deviceProtectCurrentMA) {
			emkLog('过流保护值将由设备当前的 ' + deviceProtectCurrentMA + ' mA 调低到 ' + lim.currentMA + ' mA', 'warn')
		}
		if (deviceProtectVoltV > 0 && lim.voltV < deviceProtectVoltV) {
			emkLog('过压保护值将由设备当前的 ' + deviceProtectVoltV + ' V 调低到 ' + lim.voltV +
				' V —— 设备本机旋钮也调不过这个值', 'warn')
		}
		const frame = PROTO.buildAutoProtect(lim.currentMA, lim.voltV)
		const ok = await emkWrite(frame, '写保护限值 0x72 过流 ' + lim.currentMA + ' mA · 过压 ' + lim.voltV + ' V')
		for (let i = 0; i < 2; i++) {
			await new Promise(function (r) { setTimeout(r, 150) })
			await emkWrite(frame)
		}
		await new Promise(function (r) { setTimeout(r, 200) })
		return ok
	}

	function getRatePreset() {
		const el = E('emk-sample-rate')
		const key = el ? el.value : '1k'
		return RATE_PRESETS[key] || RATE_PRESETS['1k']
	}

	function applyRatePreset() {
		const p = getRatePreset()
		targetRateHz = p.hz
		// 档位名义 10K 流；实测本机只有约 8.4K，所以抽稀比和时间基准都用实测流速，
		// 没测到（首次采样）才退回名义值。档位显示仍沿用 10K/1K/… 命名。
		const streamHz = deviceStreamHz > 0 ? deviceStreamHz : NOMINAL_STREAM_HZ
		decimFactor = Math.max(1, Math.round(streamHz / targetRateHz))
		samplePeriodSec = decimFactor / streamHz
		periodLocked = false // 换档就是换时间基准，需要重新实测收敛
		decimCounter = 0
		return p
	}

	async function emkWrite(data, note) {
		if (!emkPort || !emkPort.writable || !emkOpen) {
			emkLog('设备未打开，无法发送', 'error')
			return false
		}
		let writer
		try {
			writer = emkPort.writable.getWriter()
			await writer.write(data)
			if (note) {
				const head = []
				const n = Math.min(10, data.length)
				for (let i = 0; i < n; i++) head.push(('0' + data[i].toString(16).toUpperCase()).slice(-2))
				emkLog(note + ' [' + head.join(' ') + (data.length > 10 ? ' …' : '') + ']', 'success')
			}
			return true
		} catch (e) {
			emkLog('写入失败：' + (e.message || e), 'error')
			return false
		} finally {
			if (writer) {
				try { writer.releaseLock() } catch (e) {}
			}
		}
	}

	async function emkSendCmd(cmd, note) {
		const frame = PROTO.buildSendCmd(cmd)
		return await emkWrite(frame, note || ('发送 0x' + cmd.toString(16).toUpperCase().padStart(2, '0')))
	}

	function computeSendVoltage(v) {
		let sendV = v
		// 上位机：max 非 65535/65536 时作为电压校准偏置相加；0 表示无偏置
		if (confLoaded && conf.max != null && isFinite(conf.max) &&
			conf.max !== 0 && conf.max !== 65535 && conf.max !== 65536) {
			sendV = v + conf.max
			emkLog('电压校准偏置 max=' + conf.max + ' → 下发 ' + sendV.toFixed(4) + ' V')
		}
		if (sendV < 0) sendV = 0
		if (sendV > 24) sendV = 24
		return sendV
	}

	function markPowered(on) {
		emkPowered = !!on
		const btn = E('emk-poweron')
		if (!btn) return
		if (on) {
			btn.classList.add('btn-success')
			btn.classList.remove('btn-outline-success')
			btn.innerHTML = '<i class="bi bi-lightning-fill"></i> 已上电'
		} else {
			btn.classList.remove('btn-success')
			btn.classList.add('btn-outline-success')
			btn.innerHTML = '<i class="bi bi-lightning"></i> 上电'
		}
	}

	// 实机验证：AM 机 0x12/0x15 无效；0x61 + u16(V*10) 设压（0.1V 步进，≤13.0V），0 下电
	async function applyVoltage(volt) {
		if (!emkOpen) {
			emkLog('请先打开设备', 'error')
			return false
		}
		const v = isFinite(volt) ? volt : readSetVoltage()
		const sendV = computeSendVoltage(v)
		const before = deviceVoltageSet
		let ok = false
		if (isAM) {
			const code = Math.round(sendV * 10)
			if (Math.abs(code / 10 - sendV) > 0.001) {
				emkLog('0x61 仅 0.1V 分辨率：' + sendV.toFixed(2) + ' V → 取整 ' + (code / 10).toFixed(1) + ' V', 'warn')
			}
			if (code > 130) emkLog('目标超出固件上限 13.0V，设备会钳位', 'warn')
			const frame = PROTO.buildUserConfigVolt(sendV)
			ok = await emkWrite(frame, '设电压 0x61 ' + (code / 10).toFixed(1) + ' V (code=' + code + ')')
			await new Promise(function (r) { setTimeout(r, 30) })
			await emkWrite(frame)
		} else {
			const da = PROTO.voltToDa(sendV, { pv: conf.pv, ov: conf.ov })
			const frame = PROTO.buildPowerOn(sendV, conf)
			ok = await emkWrite(frame, '设电压/上电 0x12 ' + sendV.toFixed(3) + ' V DA=' + da)
			await new Promise(function (r) { setTimeout(r, 30) })
			await emkWrite(frame)
		}
		if (ok) {
			markPowered(true)
			setVoltageV = v
			await new Promise(function (r) { setTimeout(r, 250) })
			if (deviceVoltageSet != null) {
				const delta = Math.abs(deviceVoltageSet - Math.round(sendV * 10) / 10)
				if (delta <= 0.05) {
					emkLog('设备确认设定电压 ' + deviceVoltageSet.toFixed(2) + ' V', 'success')
				} else {
					emkLog('设备回报 ' + deviceVoltageSet.toFixed(2) + ' V（目标 ' + sendV.toFixed(1) +
						(before != null ? '，此前 ' + before.toFixed(2) : '') + '）', 'warn')
				}
			}
		}
		return ok
	}

	async function doPowerOff() {
		if (!emkOpen) {
			emkLog('请先打开设备', 'error')
			return
		}
		if (emkSampling) {
			emkSampling = false
			stopStallWatch()
			updateSampleBtn()
			await emkWrite(PROTO.buildStop(false), '停止采样')
			await new Promise(function (r) { setTimeout(r, 80) })
		}
		let ok = false
		if (isAM) {
			// 实机：0x61 code=0 下电（Vset→0）
			const frame = PROTO.buildUserConfigVolt(0)
			ok = await emkWrite(frame, '下电 0x61 code=0')
			await new Promise(function (r) { setTimeout(r, 30) })
			await emkWrite(frame)
		} else {
			ok = await emkWrite(PROTO.buildPowerOff(), '下电 CMD=0x15')
		}
		if (ok) {
			markPowered(false)
			emkLog('已下电', 'success')
		}
	}

	async function requestConfig() {
		// 上位机连发 3 次 READ_CONFIG
		await emkSendCmd(PROTO.CMD.REQ_READ_CONFIG, '读校准配置')
		await new Promise(function (r) { setTimeout(r, 200) })
		await emkSendCmd(PROTO.CMD.REQ_READ_CONFIG)
		await new Promise(function (r) { setTimeout(r, 200) })
		await emkSendCmd(PROTO.CMD.REQ_READ_CONFIG)
	}

	async function startSampling() {
		if (!emkOpen) {
			emkLog('请先打开设备', 'error')
			return
		}
		if (emkSampling) return

		clearRing(false)
		parser.reset()
		const rate = applyRatePreset()
		decimCounter = 0

		if (!confLoaded) {
			await requestConfig()
			await new Promise(function (r) { setTimeout(r, 300) })
		}

		if (rate.send100k) {
			await emkSendCmd(PROTO.CMD.REQ_100K, '采样流 100K')
			await new Promise(function (r) { setTimeout(r, 40) })
		} else if (rate.send10k) {
			await emkSendCmd(PROTO.CMD.REQ_10K, '采样流 10K')
			await new Promise(function (r) { setTimeout(r, 40) })
		}

		emkSampling = true
		highSpeedFrames = 0
		startupDropRemaining = STARTUP_DROP_SAMPLES
		startSampleTs = performance.now()
		startStallWatch()
		updateSampleBtn()
		// START 带 threshold payload（默认 32000, 0）
		const startFrame = PROTO.buildStart(32000, 0)
		await emkWrite(startFrame, '开始采样 ' + rate.label)
		requestWakeLock()
		emkLog('采样中 · 目标 ' + targetRateHz + ' Hz · 周期 ' + fmtDuration(samplePeriodSec) + (confLoaded ? '' : ' · 校准未加载，数值可能不准'), confLoaded ? 'info' : 'warn')
		if (rate.send100k) probe100KSupport()
	}

	function setScrollPaused(on) {
		scrollPaused = !!on
		const btn = E('emk-pause-scroll')
		if (btn) {
			btn.innerHTML = scrollPaused
				? '<i class="bi bi-play-fill"></i> 继续滚动'
				: '<i class="bi bi-pause-fill"></i> 暂停滚动'
			btn.classList.toggle('btn-warning', scrollPaused)
			btn.classList.toggle('btn-outline-secondary', !scrollPaused)
		}
		// 继续滚动时回到最新数据
		if (!scrollPaused) {
			view.xOffset = 0
			pauseTopWarned = false
		}
		scheduleUIUpdate()
	}

	function setWaveFullscreen(on) {
		waveFullscreen = !!on
		const area = document.querySelector('.emk-wave-wrap')
		if (area) area.classList.toggle('emk-wave-fullscreen', waveFullscreen)
		document.body.classList.toggle('emk-wave-fullscreen-open', waveFullscreen)
		const btn = E('emk-fullscreen')
		if (btn) {
			btn.innerHTML = waveFullscreen
				? '<i class="bi bi-fullscreen-exit"></i>'
				: '<i class="bi bi-arrows-fullscreen"></i>'
			btn.title = waveFullscreen ? '退出放大（Esc）' : '放大波形区（Esc 退出）'
		}
		// 尺寸变化后重画（ResizeObserver 也会兜底）
		setTimeout(updateCanvas, 60)
	}

	// 选了 100K 档就等 2s 看有没有 0x84；没有就是本机没激活高速档，降级到普通流
	function probe100KSupport() {
		clearTimeout(hsProbeTimer)
		hsProbeTimer = setTimeout(function () {
			if (!emkSampling) return
			if (highSpeedFrames > 0) {
				if (supports100K !== true) {
					supports100K = true
					emkLog('本机支持 100K/10µs 高速档（收到 0x84 高速帧）', 'success')
					markRateSupport()
				}
			} else if (supports100K !== false) {
				supports100K = false
				emkLog('本机未激活 100K/10µs 高速档：无 0x84 帧，已按普通流采样', 'warn')
				markRateSupport()
			}
		}, 2000)
	}

	// 探测结果反映到档位下拉（不支持的机器保留选项但标注，避免误以为坏了）
	function markRateSupport() {
		const el = E('emk-sample-rate')
		if (!el) return
		for (let i = 0; i < el.options.length; i++) {
			const opt = el.options[i]
			if (opt.value !== '100k') continue
			const base = RATE_PRESETS['100k'].label
			opt.textContent = supports100K === false ? base + ' · 本机不支持' : base
		}
	}

	async function stopSampling() {
		if (!emkSampling) return
		emkSampling = false
		stopStallWatch()
		updateSampleBtn()
		await emkWrite(PROTO.buildStop(false), '停止采样')
		releaseWakeLock()
		emkLog('采样已停止 · 本次收到 ' + sampleFrameCount + ' 帧')
		invalidateOverallStat()
		scheduleUIUpdate()
	}

	function updateSampleBtn() {
		const btn = E('emk-start')
		if (!btn) return
		if (emkSampling) {
			btn.innerHTML = '<i class="bi bi-stop-fill"></i> 停止采样'
			btn.classList.remove('btn-success')
			btn.classList.add('btn-danger')
		} else {
			btn.innerHTML = '<i class="bi bi-play-fill"></i> 开始采样'
			btn.classList.remove('btn-danger')
			btn.classList.add('btn-success')
		}
	}

	// 缓冲写满开始丢最旧数据、以及暂停滚动时视口被追上，都只提示一次（清空后重新武装）
	let evictWarned = false
	let pauseTopWarned = false

	function noteRingEvict() {
		if (evictWarned) return
		evictWarned = true
		emkLog('缓冲已写满 ' + ringCount.toLocaleString() + ' 点，开始覆盖最旧数据 · 可回看约 ' +
			fmtDuration(ringCount * samplePeriodSec) + '（累计计数继续增长，与缓冲内时长不再一致）', 'warn')
	}

	function notePauseTop() {
		if (pauseTopWarned) return
		pauseTopWarned = true
		emkLog('暂停滚动的视口已到缓冲最旧端，正在查看的波形开始被新数据覆盖', 'warn')
	}

	function clearRing(log) {
		ringReset()
		evictWarned = false
		pauseTopWarned = false
		invalidateOverallStat()
		clearBucketCache()
		sampleRateLastTs = performance.now()
		sampleRateCount = 0
		sampleRateEst = 0
		latestCurrentUA = 0
		latestVoltageV = setVoltageV
		dispCurrentUA = 0
		dispVoltageV = setVoltageV
		dispInit = false
		decimCounter = 0
		// 每次重新采样都重测时间基准（deviceStreamHz 保留，供本次抽稀比使用）
		firstSampleTs = 0
		rawStreamCount = 0
		rawStreamFirstTs = 0
		rawWinCount = 0
		rawWinTs = 0
		rawRateEst = 0
		periodLogged = false
		periodLocked = false
		view.xOffset = 0
		view.cursorA = null
		view.cursorB = null
		resetYAuto()
		updateCursorInfo()
		if (log !== false) {
			scheduleUIUpdate()
			emkLog('数据已清空')
		}
	}

	async function requestWakeLock() {
		try {
			if (navigator.wakeLock && !wakeLockSentinel) {
				wakeLockSentinel = await navigator.wakeLock.request('screen')
				wakeLockSentinel.addEventListener('release', function () { wakeLockSentinel = null })
			}
		} catch (e) {}
	}

	async function releaseWakeLock() {
		if (wakeLockSentinel) {
			try { await wakeLockSentinel.release() } catch (e) {}
			wakeLockSentinel = null
		}
	}

	async function emkOpenPort() {
		if (!emkPort || emkOpen || emkOpening) return
		emkOpening = true
		emkManualClose = false
		try {
			try { await emkPort.close() } catch (e) {}
			await emkPort.open({
				baudRate: BAUD,
				dataBits: 8,
				stopBits: 1,
				parity: 'none',
				bufferSize: 1024 * 1024,
				flowControl: 'none',
			})
			emkOpen = true
			setStatus('EMK850+', true)
			const toggle = E('emk-open')
			if (toggle) toggle.innerHTML = '<i class="bi bi-stop-circle"></i> 关闭设备'
			emkLog('设备已打开 ' + BAUD + ' 8N1', 'success')
			emkReadLoop()
			// 上位机开串口后：STOP + VERSION，VERSION 应答后再读配置
			await new Promise(function (r) { setTimeout(r, 50) })
			await emkSendCmd(PROTO.CMD.REQ_STOP, 'STOP')
			await new Promise(function (r) { setTimeout(r, 30) })
			await emkSendCmd(PROTO.CMD.REQ_VERSION, '读版本')
			await new Promise(function (r) { setTimeout(r, 80) })
			await requestConfig()
		} catch (e) {
			emkOpen = false
			setStatus('打开失败', false)
			emkLog('打开失败：' + (e.message || e), 'error')
			const toggle = E('emk-open')
			if (toggle) toggle.innerHTML = '<i class="bi bi-play-circle"></i> 打开设备'
		} finally {
			emkOpening = false
		}
	}

	async function emkClosePort(opts) {
		opts = opts || {}
		if (opts.manual !== false) emkManualClose = true
		if (emkSampling) {
			emkSampling = false
			stopStallWatch()
			updateSampleBtn()
			if (emkOpen && opts.manual !== false) {
				try { await emkWrite(PROTO.buildStop(false)) } catch (e) {}
			}
			releaseWakeLock()
		}
		emkOpen = false
		const r = emkReader
		emkReader = null
		if (r) {
			try { await r.cancel() } catch (e) {}
			try { r.releaseLock() } catch (e) {}
		}
		if (emkPort) {
			try { await emkPort.close() } catch (e) {}
		}
		setStatus(opts.manual === false ? '已断开' : '已关闭', false)
		const toggle = E('emk-open')
		if (toggle) toggle.innerHTML = '<i class="bi bi-play-circle"></i> 打开设备'
		releaseWakeLock()
		if (opts.manual !== false) emkLog('设备已关闭')
	}

	async function emkReadLoop() {
		while (emkOpen && emkPort && emkPort.readable) {
			const r = emkPort.readable.getReader()
			emkReader = r
			let streamError = false
			try {
				while (true) {
					const { value, done } = await r.read()
					if (done) break
					handleEmkData(value)
				}
			} catch (e) {
				if (emkOpen) {
					emkLog('读取错误：' + (e.message || e), 'error')
					streamError = true
				}
			} finally {
				if (emkReader === r) emkReader = null
				try { r.releaseLock() } catch (e) {}
			}
			if (streamError || !emkOpen) break
		}
		if (emkOpen) {
			emkOpen = false
			setStatus('读取中断', false)
			const toggle = E('emk-open')
			if (toggle) toggle.innerHTML = '<i class="bi bi-play-circle"></i> 打开设备'
			releaseWakeLock()
			if (!emkManualClose) emkLog('读取中断，可重开或等待重连', 'warn')
		}
	}

	function applyConf(parsed, src) {
		if (!parsed || parsed.error || parsed.partial) return false
		if (parsed.voltage == null && !parsed.loaded) return false
		const prevMag = conf.adc_magnification
		conf = parsed
		if (!conf.adc_magnification) conf.adc_magnification = prevMag || 7.8
		confLoaded = true
		const msg = '校准已加载' + (src ? ' (' + src + ')' : '') +
			' Vref=' + conf.voltage +
			' g1=' + conf.g1 +
			' om1=' + conf.om1 +
			' om2=' + conf.om2 +
			' max=' + conf.max +
			' pv=' + conf.pv +
			' ov=' + conf.ov +
			' adc×' + conf.adc_magnification +
			(parsed._sumMismatch ? ' [sum宽松]' : '')
		emkLog(msg, 'success')
		// 读 alarm 取 adc_magnification
		emkSendCmd(PROTO.CMD.REQ_READ_ALARMCONFIG, '读 Alarm 配置')
		return true
	}

	function noteSampleFrame() {
		lastSampleFrameTs = performance.now()
		sampleFrameCount++
		stallReported = false
	}

	function startStallWatch() {
		clearInterval(stallTimer)
		lastSampleFrameTs = 0
		sampleFrameCount = 0
		stallReported = false
		stallTimer = setInterval(function () {
			if (!emkSampling) return
			const now = performance.now()
			// 还没收到第一帧的时间从「开始采样」算起
			const base = lastSampleFrameTs || startSampleTs
			if (!base || now - base < 1500 || stallReported) return
			stallReported = true
			emkLog('设备已停止上报采样帧：最后一帧在 ' + ((now - base) / 1000).toFixed(1) +
				' s 前，本次共收到 ' + sampleFrameCount + ' 帧 —— 这是设备侧断流，不是页面卡住', 'error')
		}, 500)
	}

	function stopStallWatch() {
		clearInterval(stallTimer)
		stallTimer = 0
	}

	// 0x81 CMD_RESULT_PROCESS：payload int16 模块号 + int16 错误码（上位机会弹框）
	const ERR_MODULES = { 1: 'SAMPLE', 2: 'PROTECTION', 3: 'SECURITY' }

	function logResultProcess(f) {
		const view = new DataView(f.payload.buffer, f.payload.byteOffset, f.payload.byteLength)
		const moduleId = view.getInt16(0, true)
		const code = view.getInt16(2, true)
		const mod = ERR_MODULES[moduleId] || ('模块' + moduleId)
		let desc = '未知异常'
		if (code === 0) desc = '无异常'
		else if (code === -1) desc = '设置计算参数出错，存储芯片存在问题'
		else if (code === -2) desc = '设置计算参数出错，存储芯片大小过小'
		emkLog('设备异常上报 0x81 ' + mod + ' code=' + code + ' · ' + desc, code === 0 ? 'info' : 'error')
	}

	function hexHead(u8, n) {
		const a = []
		const m = Math.min(n || 12, u8.length)
		for (let i = 0; i < m; i++) a.push(('0' + u8[i].toString(16).toUpperCase()).slice(-2))
		return a.join(' ')
	}

	function handleEmkData(data) {
		const frames = parser.push(data)
		for (let i = 0; i < frames.length; i++) {
			const f = frames[i]
			if (f.cmd === PROTO.CMD.RESULT) {
				noteSampleFrame()
				handleSampleFrame(f)
				continue
			}
			// 0x84：100K/10µs 高速帧（仅激活了该档的机器上报）
			if (f.cmd === PROTO.CMD.REQ_HIGH_SPEED_DATA) {
				noteSampleFrame()
				highSpeedFrames++
				ingestSamples(PROTO.parseHighSpeedSamples(f.payload, { isHave5A: isHave5A }))
				continue
			}
			// 非采样/非周期状态帧：打日志便于排查（0x69 电压状态另处理）
			if (f.cmd !== PROTO.CMD.BIG_DATA && f.cmd !== 0x69 && f.cmd !== PROTO.CMD.RESULT) {
				emkLog('RX cmd=0x' + f.cmd.toString(16).toUpperCase().padStart(2, '0') +
					' len=' + f.len + ' z=' + f.zero + ' [' + hexHead(f.raw, 12) + '…]')
			}

			// BIG_DATA 配置（FIRST 0x42 / 续 0x40）
			if (f.cmd === PROTO.CMD.BIG_DATA_FIRST || f.cmd === PROTO.CMD.BIG_DATA) {
				const r = bigData.onFrame(f)
				if (!r) continue
				if (r.partial) {
					if (f.cmd === PROTO.CMD.BIG_DATA_FIRST) {
						emkLog('BIG_DATA 开始 what=' + r.what + ' ' + r.recv + '/' + r.total)
					}
					continue
				}
				if (r.error) {
					emkLog('BIG_DATA 失败: ' + r.error +
						(r.dataLen != null ? ' len=' + r.dataLen : '') +
						(r.sumOk === false ? ' sum≠' : ''), 'error')
					// 若有原始 data，dump 前几个 double
					if (r.data && r.data.length >= 32) {
						const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength)
						const vals = []
						for (let k = 0; k < 4; k++) vals.push(dv.getFloat64(k * 8, true).toFixed(6))
						emkLog('data[0..3] double: ' + vals.join(', '))
					}
					continue
				}
				if (r.loaded || r.voltage != null) applyConf(r, 'BIG_DATA')
				continue
			}

			if (f.cmd === 0x81) {
				logResultProcess(f)
			} else if (f.cmd === PROTO.CMD.RES_READ_CONFIG) {
				const parsed = PROTO.tryParseConfig(f.payload)
				if (parsed) applyConf(parsed, 'RES_CONFIG')
			} else if (f.cmd === PROTO.CMD.RES_POWERON) {
				emkPowered = true
				emkLog('设备上电应答', 'success')
			} else if (f.cmd === PROTO.CMD.RES_POWEROFF || f.cmd === PROTO.CMD.DO_POWEROFF) {
				emkPowered = false
				emkLog('设备下电应答', 'success')
			} else if (f.cmd === PROTO.CMD.RES_VERSION) {
				try {
					const n = Math.min(f.len || 48, f.payload.length)
					let s = new TextDecoder().decode(f.payload.subarray(0, n))
					s = s.replace(/\0+$/g, '').trim()
					if (s) {
						emkLog('版本: ' + s, 'success')
						parseVersionFlags(s)
					}
				} catch (e) {}
			} else if (f.cmd === PROTO.CMD.ALARM1 || f.cmd === 0x66) {
				const mag = PROTO.tryParseAlarmAdcMag(f)
				if (mag != null) {
					conf.adc_magnification = mag
					emkLog('ADC 放大系数 ' + mag, 'success')
				} else {
					// 忽略不合理 avg_1（如 0.05）
				}
			} else if (f.cmd === 0x69) {
				const st = PROTO.parseVoltSetStatus(f)
				if (st && isFinite(st.voltageSet)) {
					deviceVoltageSet = st.voltageSet
					if (isFinite(st.protectCurrentMA)) deviceProtectCurrentMA = st.protectCurrentMA
					if (isFinite(st.protectVoltV)) deviceProtectVoltV = st.protectVoltV
					syncProtectInputs()
					const now = performance.now()
					if (now - lastVoltSetLogTs > 3000) {
						lastVoltSetLogTs = now
						emkLog('设备设定电压 ' + st.voltageSet.toFixed(2) + ' V' +
							(isFinite(st.voltMcuSend) ? ' · MCU ' + st.voltMcuSend.toFixed(2) + ' V' : ''))
					}
				}
			}
		}
	}

	function parseVersionFlags(ver) {
		// 换了设备就重新探测 100K 支持情况
		supports100K = null
		markRateSupport()
		// 版本串格式：PA-EMK850+-<机型>-<日期码>-<序列号>，parts[3] 是日期码
		const parts = ver.split('-')
		if (parts.length >= 5) {
			const date = parts[3]
			if (date >= '21052001') emkLog('机型标志 isHaveCh4')
			if (date >= '21102501') emkLog('机型标志 isAlarmConfig')
		}
		isAM = ver.indexOf('-AM-') >= 0 || ver.indexOf('-BM-') >= 0 ||
			ver.indexOf('-CM-') >= 0 || ver.indexOf('-DM-') >= 0
		if (isAM) emkLog('机型 AM 系：设压/下电走 0x61 (0.1V 步进，上限 13.0V)', 'success')
		if (ver.indexOf('-5A-') >= 0 || /5A/i.test(ver)) {
			isHave5A = true
			emkLog('采样格式 SampleUint (5A)')
		}
		const elUn = E('emk-toggle-unsigned')
		if (elUn) elUn.checked = isHave5A
	}

	let rawLogTs = 0
	function handleSampleFrame(f) {
		ingestSamples(PROTO.parseSamples(f.payload, { isHave5A: isHave5A }))
	}

	// 普通帧(0x21)与高速帧(0x84)共用的入库路径
	function ingestSamples(samples) {
		if (!samples || !samples.length) return
		const now = performance.now()
		let storedThisBatch = 0
		if (!sampleRateLastTs) sampleRateLastTs = now

		for (let i = 0; i < samples.length; i++) {
			const s = samples[i]
			let curUA = s.currentRaw
			let volt = latestVoltageV || setVoltageV
			if (useConverted) {
				try {
					const conv = PROTO.convertSample(s, conf)
					curUA = conv.currentUA
					if (isFinite(conv.voltageV) && conv.voltageV > 0.05) volt = conv.voltageV
					// 每 2s 打一条 raw，便于对照屏显
					if (now - rawLogTs > 2000) {
						rawLogTs = now
						emkLog('raw V=' + s.voltageRaw + (s.highSpeed ? '(hs ch' + s.ch + ')' : '(g' + s.grade + ')') + ' I=' + s.currentRaw +
							' → ' + volt.toFixed(3) + 'V ' + fmtCurrent(curUA) +
							(confLoaded ? '' : ' [无校准]'))
					}
				} catch (e) {}
			}
			latestCurrentUA = curUA
			latestVoltageV = volt
			// EMA 平滑显示（α≈0.15 @1k 抽稀后仍跟手但不乱跳）
			if (!dispInit) {
				dispCurrentUA = curUA
				dispVoltageV = volt
				dispInit = true
			} else {
				dispCurrentUA = dispCurrentUA * 0.85 + curUA * 0.15
				if (isFinite(volt) && volt > 0.05) {
					dispVoltageV = dispVoltageV * 0.9 + volt * 0.1
				}
			}

			if (!emkSampling) continue

			// 设备约 10K 流，按 decimFactor 抽稀入库
			decimCounter++
			if (decimCounter < decimFactor) continue
			decimCounter = 0

			if (startupDropRemaining > 0) {
				startupDropRemaining--
				continue
			}

			ringPush(curUA, volt)
			sampleRateCount++
			storedThisBatch++
			if (!firstSampleTs) firstSampleTs = now
		}

		// 暂停滚动：视口跟着新数据后退，停在同一段波形上（采集不受影响）
		if (scrollPaused && storedThisBatch > 0) {
			const maxOff = Math.max(0, ringCount - 1)
			const want = view.xOffset + storedThisBatch
			view.xOffset = Math.min(maxOff, want)
			if (want > maxOff) notePauseTop()
		}

		if (emkSampling) {
			// 原始流速与入库间隔都按墙钟实测，时间轴/时长/功率统计/CSV 因此是真实值
			if (!rawStreamFirstTs) {
				rawStreamFirstTs = now
			} else {
				rawStreamCount += samples.length
				const rawElapsed = (now - rawStreamFirstTs) / 1000
				if (rawStreamCount >= 2000 && rawElapsed > 0.5) {
					deviceStreamHz = rawStreamCount / rawElapsed
					// 入库点还太少（低速档）时，先用流速换算，别用名义 10K
					if (!periodFrozen() && sampleCount <= 200) samplePeriodSec = decimFactor / deviceStreamHz
				}
			}
			// 时间基准只在收敛期重估：重估会把已采到的历史整体拉伸，锁定后不再改动
			if (!periodFrozen() && firstSampleTs && sampleCount > 200) {
				const span = (now - firstSampleTs) / 1000
				if (span > 0) samplePeriodSec = span / (sampleCount - 1)
			}
			if (!periodLocked && !scrollPaused && firstSampleTs && samplePeriodSec > 0 &&
				(now - firstSampleTs) / 1000 >= PERIOD_LOCK_SEC) {
				periodLocked = true
				emkLog('时间基准已锁定：' + (1 / samplePeriodSec).toFixed(2) + ' Hz（' +
					(samplePeriodSec * 1e6).toFixed(1) + ' µs/点）')
			}
			if (!periodLogged && deviceStreamHz > 0 && sampleCount > 200) {
				periodLogged = true
				emkLog('实测设备流速 ' + Math.round(deviceStreamHz) + ' Hz · 抽稀 1/' + decimFactor +
					' → 实际 ' + (1 / samplePeriodSec).toFixed(1) + ' Hz（目标 ' + targetRateHz + ' Hz）')
			}
			// 原始流速的 1 秒滑窗值，仪表实时显示用
			if (!rawWinTs) rawWinTs = now
			else {
				rawWinCount += samples.length
				const rawWinElapsed = now - rawWinTs
				if (rawWinElapsed >= 1000) {
					rawRateEst = rawWinCount / rawWinElapsed * 1000
					rawWinCount = 0
					rawWinTs = now
				}
			}
			const elapsed = now - sampleRateLastTs
			if (elapsed >= 1000) {
				sampleRateEst = Math.round(sampleRateCount / elapsed * 1000)
				sampleRateCount = 0
				sampleRateLastTs = now
			}
			scheduleUIUpdate()
		} else {
			// 未采样时也刷新实时数字
			scheduleUIUpdate()
		}
	}

	// 时间基准是否已冻结：锁定后、或暂停滚动期间都不许再改，否则历史时间轴会整体漂移
	function periodFrozen() {
		return periodLocked || scrollPaused
	}

	function indexToTime(li) {
		// 用绝对采样序号，环形缓冲淘汰旧点后逻辑 0 不再是采样起点
		return (sampleCount - ringCount + li) * samplePeriodSec
	}

	function getViewRange() {
		if (ringCount < 1) return { start: 0, end: 0, count: 0 }
		// xZoom 大 = 放大（更少点）；xZoom 小 = 缩小（更长时间）
		const maxPts = Math.max(MIN_VIEW_POINTS, Math.min(ringCount, Math.round(view.baseViewPoints / view.xZoom)))
		let end = ringCount - 1 - Math.floor(view.xOffset)
		if (end < 0) end = 0
		if (end > ringCount - 1) end = ringCount - 1
		let start = end - maxPts + 1
		if (start < 0) start = 0
		return { start: start, end: end, count: end - start + 1 }
	}

	// 游标：window 模式存视口比例 0..1；data 模式存逻辑下标
	function cursorToLogical(c, vr) {
		if (c == null || !vr || vr.count < 1) return null
		if (view.cursorMode === 'data') {
			return Math.max(0, Math.min(ringCount - 1, Math.round(c)))
		}
		const t = Math.max(0, Math.min(1, c))
		return Math.round(vr.start + t * (vr.count - 1))
	}

	function logicalToCursor(li, vr) {
		if (li == null || !vr || vr.count < 2) return 0
		if (view.cursorMode === 'data') return li
		return (li - vr.start) / (vr.count - 1)
	}

	function fillStatRow(prefix, st) {
		const set = function (suffix, text) {
			const el = E('emk-stat-' + prefix + '-' + suffix)
			if (el) el.textContent = text
		}
		if (!st || !st.n) {
			set('avg', '--')
			set('max', '--')
			set('min', '--')
			set('pwr', '--')
			set('energy', '--')
			set('dur', '--')
			return
		}
		set('avg', fmtCurrent(st.avg))
		set('max', fmtCurrent(st.max))
		set('min', fmtCurrent(st.min))
		set('pwr', fmtPower(st.pwr))
		set('energy', fmtEnergy(st.avg * st.dur / 3600))
		set('dur', fmtDuration(st.dur))
	}

	// 全量统计走块摘要，成本恒定；这里只是省掉「数据没变还重算」的空转
	let overallStat = null
	let overallStatKey = ''

	function invalidateOverallStat() {
		overallStat = null
		overallStatKey = ''
	}

	function updateStats() {
		if (ringCount < 1) {
			fillStatRow('overall', null)
			fillStatRow('window', null)
			fillStatRow('cursor', null)
			return
		}
		const key = sampleCount + '/' + ringCount + '/' + samplePeriodSec
		if (!overallStat || key !== overallStatKey) {
			overallStat = calcStats(0, ringCount - 1)
			overallStatKey = key
		}
		fillStatRow('overall', overallStat)
		const vr = getViewRange()
		fillStatRow('window', calcStats(vr.start, vr.end))
		if (view.cursorA != null && view.cursorB != null) {
			let a = cursorToLogical(view.cursorA, vr)
			let b = cursorToLogical(view.cursorB, vr)
			if (a != null && b != null) {
				if (a > b) { const t = a; a = b; b = t }
				fillStatRow('cursor', calcStats(a, b))
			} else fillStatRow('cursor', null)
		} else {
			fillStatRow('cursor', null)
		}
	}

	function updateDigits(force) {
		const now = performance.now()
		// 大数字限频，避免肉眼跟不住；统计单独刷新
		const digitDue = force || (now - lastDigitUiTs >= 1000 / DIGIT_UI_HZ)
		if (digitDue) {
			lastDigitUiTs = now
			const showI = dispInit ? dispCurrentUA : latestCurrentUA
			const showV = dispInit ? dispVoltageV : latestVoltageV

			const elCur = E('emk-current')
			if (elCur) elCur.textContent = fmtCurrent(showI)

			const elVolt = E('emk-voltage')
			if (elVolt) {
				if (useConverted && isFinite(showV) && showV > 0.05) {
					elVolt.textContent = showV.toFixed(3) + ' V'
				} else if (deviceVoltageSet != null) {
					elVolt.textContent = deviceVoltageSet.toFixed(2) + ' V'
				} else elVolt.textContent = '--'
			}

			const elPwr = E('emk-power')
			if (elPwr) {
				if (useConverted && isFinite(showI) && isFinite(showV)) {
					elPwr.textContent = fmtPower(showI * showV)
				} else elPwr.textContent = '--'
			}

			const elCount = E('emk-count')
			if (elCount) elCount.textContent = sampleCount.toLocaleString()

			const elRate = E('emk-rate')
			if (elRate) {
				// 存储率取 1 秒滑窗实测值；采样中用实测采样间隔兜底（滑窗尚未出结果时）
				let stored = sampleRateEst
				if (!stored && emkSampling && samplePeriodSec > 0) stored = 1 / samplePeriodSec
				const tgt = targetRateHz >= 1000 ? (targetRateHz / 1000) + 'k' : String(targetRateHz)
				elRate.textContent = fmtHz(stored) + ' / ' + tgt + ' Hz'
				const raw = rawRateEst || deviceStreamHz
				const elRawRate = E('emk-rate-raw')
				if (elRawRate) {
					elRawRate.textContent = raw > 0 ? ('设备流 ' + fmtHz(raw) + ' Hz · 1/' + decimFactor) : ''
				}
				elRate.title = raw > 0
					? ('设备原始流速 ' + Math.round(raw) + ' Hz，抽稀 1/' + decimFactor +
						'，实际入库 ' + (stored > 0 ? Math.round(stored) : 0) + ' Hz（目标 ' + targetRateHz + ' Hz）')
					: '实际入库速率 / 目标速率'
			}

			const elDur = E('emk-duration')
			if (elDur) {
				elDur.textContent = ringCount > 1 ? fmtDuration((ringCount - 1) * samplePeriodSec) : '--'
			}

			const elSet = E('emk-deviceset')
			if (elSet) {
				elSet.textContent = deviceVoltageSet != null ? deviceVoltageSet.toFixed(2) + ' V' : '--'
			}
		}

		updateStats()
	}

	// 把任意正数取整到最近的「好看」刻度：1/2/5 × 10^n（Y 轴自适应量化用）
	function niceNumber(raw) {
		if (!(raw > 0) || !isFinite(raw)) return 1
		const exp = Math.floor(Math.log10(raw))
		const base = Math.pow(10, exp)
		const frac = raw / base
		let nice
		if (frac <= 1) nice = 1
		else if (frac <= 2) nice = 2
		else if (frac <= 5) nice = 5
		else nice = 10
		return nice * base
	}

	function updateCanvas() {
		const canvas = E('emk-canvas')
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

		if (ringCount < 2) {
			ctx.fillStyle = muted
			ctx.font = '13px sans-serif'
			ctx.textAlign = 'center'
			ctx.fillText('等待采样数据…（仅电流波形）', w / 2, h / 2)
			plotLayout = null
			return
		}

		const vr = getViewRange()
		// 每像素列 min/max 包络：列边界锚定在绝对采样序号（sampleCount - ringCount + li），
		// 列宽取 2 的幂且 >= 该视口每像素分摊到的点数，保证同一采样点在同一缩放档下永远落在
		// 同一列——滚动时尖刺高度不再因窗口相位变化而忽隐忽现。bucketSize<=1（放大到每点
		// 都能占到至少 1 像素）时退回逐点折线。Y 自适应扫描复用同一批列的 min/max，不再单独
		// 跳点扫一遍。
		const ringBase = sampleCount - ringCount
		const ringLastAbs = sampleCount - 1
		const bucketSize = computeBucketSize(vr.count, pw)
		let yMin = Infinity
		let yMax = -Infinity
		let cols = null // 仅 bucketSize > 1 时使用：[{ x: <li 坐标（可为小数）>, entry }]
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
		const pad = (yMax - yMin) * 0.08 || 1
		yMin -= pad
		yMax += pad

		if (view.yMode === 'manual') {
			yMin = view.yMin
			yMax = view.yMax
		} else {
			// nice-number 量化 + 迟滞 + 轻度 EMA：滚动时同一量级的数据不应该让
			// Y 刻度每帧都跳动，只有数据量级真正变化（超出当前范围，或收缩到
			// 当前范围的 60% 以下）才重新量化出新的刻度边界。
			const rawRange = yMax - yMin || 1
			const step5 = niceNumber(rawRange / 4)
			const qMin = Math.floor(yMin / step5) * step5
			const qMax = Math.ceil(yMax / step5) * step5
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
			yMin = yAutoDispMin
			yMax = yAutoDispMax
			if (view.yZoom !== 1) {
				const mid = (yMin + yMax) / 2
				const half = (yMax - yMin) / 2 / view.yZoom
				yMin = mid - half
				yMax = mid + half
			}
		}

		// Y 手动上下平移：叠加在 auto/manual 算出的区间之上
		if (view.yPanOffset) {
			yMin += view.yPanOffset
			yMax += view.yPanOffset
		}

		const t0 = indexToTime(vr.start)
		const t1 = indexToTime(vr.end)

		function toX(li) {
			const t = vr.count <= 1 ? 0 : (li - vr.start) / (vr.count - 1)
			return margin.left + t * pw
		}
		function toY(v) {
			return margin.top + ph - ((v - yMin) / (yMax - yMin)) * ph
		}
		function fromX(px) {
			const t = (px - margin.left) / pw
			const li = Math.round(vr.start + t * (vr.count - 1))
			return Math.max(vr.start, Math.min(vr.end, li))
		}

		plotLayout = {
			margin: margin, pw: pw, ph: ph, w: w, h: h,
			vr: vr, yMin: yMin, yMax: yMax, toX: toX, toY: toY, fromX: fromX,
			t0: t0, t1: t1,
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
			const val = yMax - (g / 4) * (yMax - yMin)
			ctx.fillStyle = muted
			ctx.font = '10px monospace'
			ctx.textAlign = 'right'
			ctx.fillText(fmtCurrent(val).replace(' ', ''), margin.left - 4, y + 3)
		}

		// X grid + time labels
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

		// current waveform only（列划分锚定绝对采样序号，滚动时同一根尖刺永远落在同一列，
		// 不会因为窗口相位变化而忽隐忽现）
		ctx.strokeStyle = accent
		ctx.lineWidth = 1.3
		ctx.beginPath()
		let started = false
		const drawnPts = [] // 点数很少时用于画样本点标记（仅逐点模式）
		if (bucketSize <= 1) {
			for (let li = vr.start; li <= vr.end; li++) {
				const x = toX(li)
				const y = toY(ringIAt(li))
				if (!started) { ctx.moveTo(x, y); started = true }
				else ctx.lineTo(x, y)
				drawnPts.push(x, y)
			}
		} else {
			// 每列依次连 first → 较近的极值 → 较远的极值 → last，
			// 既画出 min/max 包络（尖刺不丢），又保持趋势线连续、少折返
			for (let k = 0; k < cols.length; k++) {
				const e = cols[k].entry
				const x = toX(cols[k].x)
				const yFirst = toY(e.first)
				const yMinPx = toY(e.min)
				const yMaxPx = toY(e.max)
				const yLast = toY(e.last)
				if (!started) { ctx.moveTo(x, yFirst); started = true }
				else ctx.lineTo(x, yFirst)
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

		// 放到很大倍数（可见点很少）时，光有折线不容易看清具体样本，叠加圆点标记
		// （仅逐点模式会触发：vr.count<=60 时 bucketSize 必为 1）
		if (bucketSize <= 1 && vr.count <= 60) {
			ctx.fillStyle = accent
			for (let k = 0; k < drawnPts.length; k += 2) {
				ctx.beginPath()
				ctx.arc(drawnPts[k], drawnPts[k + 1], 2.2, 0, Math.PI * 2)
				ctx.fill()
			}
		}

		function drawCursorAt(cVal, label, col) {
			if (cVal == null) return
			const li = cursorToLogical(cVal, vr)
			if (li == null || li < vr.start || li > vr.end) return
			const x = toX(li)
			ctx.strokeStyle = col
			ctx.lineWidth = 1.2
			ctx.setLineDash([4, 3])
			ctx.beginPath()
			ctx.moveTo(x, margin.top)
			ctx.lineTo(x, margin.top + ph)
			ctx.stroke()
			ctx.setLineDash([])
			ctx.fillStyle = col
			ctx.font = '10px sans-serif'
			ctx.textAlign = 'center'
			const tLabel = view.cursorMode === 'window'
				? (label + ' ' + Math.round((cVal) * 100) + '%')
				: (label + ' ' + fmtTimeAxis(indexToTime(li)))
			ctx.fillText(tLabel, x, margin.top - 2)
			// 数值标注：电流 + 功耗
			const iv = ringIAt(li)
			const vv = ringVAt(li)
			const hasV = isFinite(vv) && vv > 0.05
			const pwrText = hasV ? ('P ' + fmtPower(iv * vv).replace(' ', '')) : 'P --'
			ctx.fillText(fmtCurrent(iv).replace(' ', ''), x, margin.top + ph + 12)
			ctx.fillText(pwrText, x, margin.top + ph + 24)
		}
		drawCursorAt(view.cursorA, 'A', cursorCol)
		drawCursorAt(view.cursorB, 'B', '#ec4899')

		// 游标区间阴影
		if (view.cursorA != null && view.cursorB != null) {
			let a = cursorToLogical(view.cursorA, vr)
			let b = cursorToLogical(view.cursorB, vr)
			if (a != null && b != null) {
				if (a > b) { const t = a; a = b; b = t }
				const x0 = toX(a)
				const x1 = toX(b)
				ctx.fillStyle = 'rgba(245, 158, 11, 0.08)'
				ctx.fillRect(x0, margin.top, x1 - x0, ph)
			}
		}

		// 悬停十字线 + 数值气泡
		if (hover && !(drag && drag.moved)) {
			const hx = Math.max(margin.left, Math.min(margin.left + pw, hover.x))
			const hli = fromX(hx)
			const hpair = ringPairAt(hli)
			const hi = hpair[0]
			const hv = hpair[1]
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

			const hasV = isFinite(hv) && hv > 0.05
			const rows = [
				['t', fmtTimeAxis(indexToTime(hli))],
				['I', fmtCurrent(hi)],
				['U', hasV ? hv.toFixed(3) + ' V' : '--'],
				['P', hasV ? fmtPower(hi * hv) : '--'],
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
			ctx.beginPath()
			ctx.rect(bx, by, boxW, boxH)
			ctx.fill()
			ctx.globalAlpha = 1
			ctx.strokeStyle = grid
			ctx.lineWidth = 1
			ctx.stroke()

			ctx.textAlign = 'left'
			for (let r = 0; r < rows.length; r++) {
				const ty = by + 4 + rowH * r + 11
				ctx.fillStyle = muted
				ctx.fillText(rows[r][0], bx + 8, ty)
				ctx.fillStyle = fg
				ctx.fillText(rows[r][1], bx + 8 + 14, ty)
			}
		}

		// footer
		ctx.fillStyle = muted
		ctx.font = '10px monospace'
		ctx.textAlign = 'center'
		const winDur = (vr.count > 1) ? (vr.count - 1) * samplePeriodSec : 0
		const totalDur = ringCount > 1 ? (ringCount - 1) * samplePeriodSec : 0
		ctx.fillText(
			'窗口 ' + fmtDuration(winDur) + ' / 总 ' + fmtDuration(totalDur) +
			' · 实测 ' + fmtHz(samplePeriodSec > 0 ? 1 / samplePeriodSec : 0) +
			'Hz/目标 ' + fmtHz(targetRateHz) + 'Hz · X×' + view.xZoom.toFixed(2) +
			' · 游标' + (view.cursorMode === 'window' ? '固定视口' : '绑定数据') +
			(scrollPaused ? ' · 已暂停滚动' : ''),
			margin.left + pw / 2,
			h - 6
		)
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
		const el = E('emk-cursor-info')
		if (!el) return
		const modeTip = view.cursorMode === 'window' ? '视口%' : '数据'
		if (view.cursorA == null && view.cursorB == null) {
			el.textContent = '单击放 A/B · 拖动游标 · 拖动平移 · 滚轮以鼠标为心缩放 · ' + modeTip
			return
		}
		const vr = getViewRange()
		const parts = []
		if (view.cursorA != null) {
			const la = cursorToLogical(view.cursorA, vr)
			parts.push(view.cursorMode === 'window'
				? ('A ' + Math.round(view.cursorA * 100) + '%')
				: ('A@' + fmtTimeAxis(indexToTime(la))))
		}
		if (view.cursorB != null) {
			const lb = cursorToLogical(view.cursorB, vr)
			parts.push(view.cursorMode === 'window'
				? ('B ' + Math.round(view.cursorB * 100) + '%')
				: ('B@' + fmtTimeAxis(indexToTime(lb))))
		}
		if (view.cursorA != null && view.cursorB != null) {
			const a = cursorToLogical(view.cursorA, vr)
			const b = cursorToLogical(view.cursorB, vr)
			if (a != null && b != null) {
				const n = Math.abs(b - a)
				const dur = n * samplePeriodSec
				parts.push('Δt=' + fmtDuration(dur))
				const st = calcStats(Math.min(a, b), Math.max(a, b))
				if (st && st.n) parts.push('Σ=' + fmtEnergy(st.avg * st.dur / 3600))
			}
		}
		el.textContent = parts.join('  ')
	}

	function exportCSV() {
		if (ringCount === 0) {
			emkLog('无数据可导出', 'warn')
			return
		}
		// 分片累积：几百万点时单个巨型字符串会直接把页面撑爆，Blob 接受字符串数组
		const CSV_CHUNK_LINES = 50000
		const parts = []
		let lines = ['index,time_s,current_uA,voltage_V,power_uW\n']
		for (let li = 0; li < ringCount; li++) {
			const pair = ringPairAt(li)
			const i = pair[0]
			const v = pair[1]
			const t = indexToTime(li)
			lines.push(li + ',' + t.toFixed(6) + ',' + i.toFixed(6) + ',' + v.toFixed(6) + ',' + (i * v).toFixed(6) + '\n')
			if (lines.length >= CSV_CHUNK_LINES) {
				// 每片单独包成 Blob，浏览器把它放在 JS 堆外（必要时落盘），避免堆里堆着几百 MB 字符串
				parts.push(new Blob([lines.join('')]))
				lines = []
			}
		}
		if (lines.length) parts.push(new Blob([lines.join('')]))
		lines = null
		const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = 'emk850_' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.csv'
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
		emkLog('CSV 已导出 ' + ringCount + ' 点', 'success')
	}

	function zoomX(factor) {
		view.xZoom = Math.min(X_ZOOM_MAX, Math.max(X_ZOOM_MIN, view.xZoom * factor))
		scheduleUIUpdate()
	}
	// 以画布 px 处的数据点为锚点缩放：该点缩放前后停在同一屏幕位置。
	// 例外：当前处于「未暂停 + 实时右端（xOffset===0）」时，滚轮缩放只改倍数、
	// 保持右端锚定，不触发暂停——否则锚点计算把 xOffset 推离 0 会误触发暂停，
	// 导致实时状态下光缩放也会"卡住"波形。只有用户已经暂停/平移过，才用锚点缩放。
	function zoomXAt(factor, px) {
		const lay = plotLayout
		const oldZoom = view.xZoom
		const newZoom = Math.min(X_ZOOM_MAX, Math.max(X_ZOOM_MIN, oldZoom * factor))
		if (newZoom === oldZoom) return
		const isRealtimeEdge = !scrollPaused && view.xOffset === 0
		if (isRealtimeEdge) {
			view.xZoom = newZoom
			view.xOffset = 0
			scheduleUIUpdate()
			return
		}
		if (!lay || !lay.vr || lay.vr.count < 2 || px == null || ringCount < 2) {
			view.xZoom = newZoom
			scheduleUIUpdate()
			return
		}
		const vr = lay.vr
		const t = Math.max(0, Math.min(1, (px - lay.margin.left) / lay.pw))
		const anchor = vr.start + t * (vr.count - 1) // 鼠标下的逻辑下标（不取整）
		view.xZoom = newZoom
		const newCount = Math.max(MIN_VIEW_POINTS, Math.min(ringCount, Math.round(view.baseViewPoints / newZoom)))
		const newEnd = anchor + (1 - t) * (newCount - 1)
		const maxOff = Math.max(0, ringCount - MIN_VIEW_POINTS)
		view.xOffset = Math.max(0, Math.min(maxOff, (ringCount - 1) - newEnd))
		// 已经在暂停/平移状态下再缩放，视口仍然离开右端 = 保持暂停
		if (!scrollPaused && emkSampling && view.xOffset > 0) setScrollPaused(true)
		scheduleUIUpdate()
	}
	function zoomY(factor) {
		view.yZoom = Math.min(Y_ZOOM_MAX, Math.max(Y_ZOOM_MIN, view.yZoom * factor))
		view.yMode = 'auto'
		scheduleUIUpdate()
	}
	function resetX() {
		view.xZoom = 1
		view.xOffset = 0
		// X 复位 = 回到实时，顺带解除暂停滚动
		if (scrollPaused) setScrollPaused(false)
		scheduleUIUpdate()
	}
	function resetY() {
		view.yZoom = 1
		view.yMode = 'auto'
		view.yPanOffset = 0
		resetYAuto()
		scheduleUIUpdate()
	}
	function resetView() {
		resetX()
		resetY()
		view.cursorA = null
		view.cursorB = null
		updateCursorInfo()
	}

	function setCursorMode(mode) {
		const vr = getViewRange()
		// 切换时尽量保持屏幕位置
		if (mode === 'window' && view.cursorMode === 'data') {
			if (view.cursorA != null) view.cursorA = logicalToCursor(view.cursorA, vr)
			if (view.cursorB != null) view.cursorB = logicalToCursor(view.cursorB, vr)
		} else if (mode === 'data' && view.cursorMode === 'window') {
			if (view.cursorA != null) view.cursorA = cursorToLogical(view.cursorA, vr)
			if (view.cursorB != null) view.cursorB = cursorToLogical(view.cursorB, vr)
		}
		view.cursorMode = mode
		const el = E('emk-cursor-mode')
		if (el) el.value = mode
		updateCursorInfo()
		scheduleUIUpdate()
	}

	function bind() {
		const elSelect = E('emk-select-port')
		if (elSelect) {
			elSelect.addEventListener('click', async function () {
				try {
					const port = await navigator.serial.requestPort()
					if (emkOpen) await emkClosePort({ manual: true })
					emkPort = port
					emkLog('设备已选择')
				} catch (e) {
					if (e && e.name !== 'NotFoundError') emkLog('选择设备：' + (e.message || e), 'error')
				}
			})
		}

		const elOpen = E('emk-open')
		if (elOpen) {
			elOpen.addEventListener('click', async function () {
				if (emkOpening) return
				if (!emkPort) {
					emkLog('请先选择设备', 'error')
					return
				}
				if (emkOpen) {
					emkOpening = true
					try { await emkClosePort({ manual: true }) } finally { emkOpening = false }
				} else {
					await emkOpenPort()
				}
			})
		}

		const elStart = E('emk-start')
		if (elStart) {
			elStart.addEventListener('click', async function () {
				if (emkSampling) await stopSampling()
				else await startSampling()
			})
		}

		const elPowerOn = E('emk-poweron')
		if (elPowerOn) elPowerOn.addEventListener('click', async function () {
			await applyVoltage(readSetVoltage())
		})

		const elApplyVolt = E('emk-apply-volt')
		if (elApplyVolt) elApplyVolt.addEventListener('click', async function () {
			await applyVoltage(readSetVoltage())
		})

		const elApplyProtect = E('emk-apply-protect')
		if (elApplyProtect) elApplyProtect.addEventListener('click', async function () {
			const lim = readProtectLimits()
			// 持久化写设备，且会限制设备本机旋钮的可调范围，必须显式确认
			if (!window.confirm('将设备的过流/过压保护值改写为 ' + lim.currentMA + ' mA / ' + lim.voltV + ' V？\n' +
				'这会写入设备并同时限制设备本机旋钮的可调范围（出厂值 6000 mA / 13 V）。')) return
			await applyAutoProtect(true)
		})

		const elVolt = E('emk-voltage-set')
		if (elVolt) {
			elVolt.addEventListener('change', function () { readSetVoltage() })
			elVolt.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') {
					e.preventDefault()
					applyVoltage(readSetVoltage())
				}
			})
		}

		const elPowerOff = E('emk-poweroff')
		if (elPowerOff) elPowerOff.addEventListener('click', function () { doPowerOff() })

		const elRate = E('emk-sample-rate')
		if (elRate) {
			elRate.addEventListener('change', function () {
				const p = applyRatePreset()
				if (emkSampling) {
					clearRing(false)
					parser.reset()
					startupDropRemaining = STARTUP_DROP_SAMPLES
					startSampleTs = performance.now()
					invalidateOverallStat()
					if (p.send100k) {
						emkSendCmd(PROTO.CMD.REQ_100K, '采样流 100K').then(function () {
							probe100KSupport()
						})
					} else if (p.send10k) {
						emkSendCmd(PROTO.CMD.REQ_10K, '采样流 10K')
					}
					emkLog('采样率已切换为 ' + p.label +
						' · 抽稀 1/' + decimFactor +
						' · 周期 ' + fmtDuration(samplePeriodSec))
				} else {
					emkLog('采样率目标 ' + p.label + '（下次开始采样生效）')
				}
				scheduleUIUpdate()
			})
		}

		const elPause = E('emk-pause-scroll')
		if (elPause) elPause.addEventListener('click', function () { setScrollPaused(!scrollPaused) })

		const elFull = E('emk-fullscreen')
		if (elFull) elFull.addEventListener('click', function () { setWaveFullscreen(!waveFullscreen) })

		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && waveFullscreen) setWaveFullscreen(false)
		})

		const elLogToggle = E('emk-log-toggle')
		if (elLogToggle) elLogToggle.addEventListener('click', function () {
			logPinned = !logPinned
			const card = E('emk-log-card')
			if (card) card.classList.toggle('pinned', logPinned)
			const box = E('emk-log')
			if (box && logPinned) box.scrollTop = box.scrollHeight
		})

		const elExport = E('emk-export')
		if (elExport) elExport.addEventListener('click', exportCSV)

		const elClear = E('emk-clear')
		if (elClear) {
			elClear.addEventListener('click', function () {
				clearRing(true)
				parser.reset()
				updateDigits()
				updateCanvas()
			})
		}

		const elClearLog = E('emk-clear-log')
		if (elClearLog) {
			elClearLog.addEventListener('click', function () {
				const box = E('emk-log')
				if (box) box.innerHTML = ''
			})
		}

		const elConv = E('emk-toggle-converted')
		if (elConv) elConv.addEventListener('change', function () {
			useConverted = this.checked
			scheduleUIUpdate()
		})

		const elUn = E('emk-toggle-unsigned')
		if (elUn) elUn.addEventListener('change', function () {
			isHave5A = this.checked
			emkLog('采样格式: ' + (isHave5A ? 'SampleUint(5A)' : 'Sample(signed I)'))
		})

		const elResetConf = E('emk-reset-config')
		if (elResetConf) {
			elResetConf.addEventListener('click', function () {
				conf = PROTO.defaultConf()
				confLoaded = false
				emkLog('校准配置已重置')
			})
		}

		const elReadConf = E('emk-read-config')
		if (elReadConf) {
			elReadConf.addEventListener('click', async function () {
				if (!emkOpen) { emkLog('请先打开设备', 'error'); return }
				await requestConfig()
			})
		}

		const bindClick = function (id, fn) {
			const el = E(id)
			if (el) el.addEventListener('click', fn)
		}
		bindClick('emk-zoom-x-in', function () { zoomX(1.6) })
		bindClick('emk-zoom-x-out', function () { zoomX(1 / 1.6) })
		bindClick('emk-zoom-x-reset', resetX)
		bindClick('emk-zoom-y-in', function () { zoomY(1.6) })
		bindClick('emk-zoom-y-out', function () { zoomY(1 / 1.6) })
		bindClick('emk-zoom-y-reset', resetY)
		bindClick('emk-cursor-clear', function () {
			view.cursorA = null
			view.cursorB = null
			updateCursorInfo()
			scheduleUIUpdate()
		})
		const elCurMode = E('emk-cursor-mode')
		if (elCurMode) {
			elCurMode.value = view.cursorMode
			elCurMode.addEventListener('change', function () {
				setCursorMode(this.value === 'data' ? 'data' : 'window')
			})
		}

		const canvas = E('emk-canvas')
		if (canvas) {
			canvas.addEventListener('wheel', function (e) {
				e.preventDefault()
				const factor = e.deltaY > 0 ? (1 / 1.15) : 1.15
				const rect = canvas.getBoundingClientRect()
				const x = e.clientX - rect.left
				const y = e.clientY - rect.top
				if (plotLayout) {
					const m = plotLayout.margin
					const inYAxis = x < m.left && y >= m.top && y <= m.top + plotLayout.ph
					const inXAxis = y > m.top + plotLayout.ph
					if (inYAxis) {
						// 左侧 Y 刻度区：只缩放 Y
						zoomY(factor)
						return
					}
					if (inXAxis) {
						// 底部 X 刻度区：只缩放 X，遵循实时右端不暂停的规则
						zoomXAt(factor, x)
						return
					}
				}
				// 绘图区内：默认缩放 X，Shift 缩放 Y
				if (e.shiftKey) zoomY(factor)
				else zoomXAt(factor, x)
			}, { passive: false })

			// 双击只吃掉浏览器默认选中，不动视图（复位请用 X/Y 复位按钮）
			canvas.addEventListener('dblclick', function (e) {
				e.preventDefault()
			})

			const inPlot = function (x, y) {
				if (!plotLayout) return false
				const m = plotLayout.margin
				return x >= m.left && x <= m.left + plotLayout.pw &&
					y >= m.top && y <= m.top + plotLayout.ph
			}

			const placeCursor = function (x) {
				const li = plotLayout.fromX(x)
				const cVal = view.cursorMode === 'window'
					? logicalToCursor(li, plotLayout.vr)
					: li
				if (view.cursorA == null || (view.cursorA != null && view.cursorB != null)) {
					view.cursorA = cVal
					view.cursorB = null
				} else {
					view.cursorB = cVal
				}
				updateCursorInfo()
				scheduleUIUpdate()
			}

			const inYAxisArea = function (x, y) {
				if (!plotLayout) return false
				const m = plotLayout.margin
				return x < m.left && y >= m.top && y <= m.top + plotLayout.ph
			}

			canvas.addEventListener('mousedown', function (e) {
				if (!plotLayout || ringCount < 2) return
				const rect = canvas.getBoundingClientRect()
				const x = e.clientX - rect.left
				const y = e.clientY - rect.top
				if (e.button !== 0 && e.button !== 1) return
				e.preventDefault()
				// 左键在左侧 Y 刻度区按下、或中键按下、或绘图区内 Alt+左键，都是 Y 平移；
				// 其余左键按下走原有的 X 平移 / 点击放游标逻辑
				const wantPanY = e.button === 1 ||
					(e.button === 0 && (inYAxisArea(x, y) || (e.altKey && inPlot(x, y))))
				if (wantPanY) {
					drag = {
						type: 'pany',
						y0: e.clientY,
						panOffset0: view.yPanOffset,
						moved: false,
					}
					canvas.style.cursor = 'ns-resize'
					return
				}
				// 点击在现有游标附近 → 拖拽游标
				const CURSOR_HIT_PX = 8
				if (e.button === 0 && inPlot(x, y) && !e.altKey) {
					const near = function (c) {
						if (c == null) return false
						const li = cursorToLogical(c, plotLayout.vr)
						if (li == null) return false
						return Math.abs(x - plotLayout.toX(li)) <= CURSOR_HIT_PX
					}
					if (near(view.cursorB)) {
						drag = { type: 'cursor', which: 'B', moved: false }
						canvas.style.cursor = 'ew-resize'
						return
					}
					if (near(view.cursorA)) {
						drag = { type: 'cursor', which: 'A', moved: false }
						canvas.style.cursor = 'ew-resize'
						return
					}
				}
				// 左键按下即准备拖动；移动超过阈值才算平移，没移动就当点击放游标
				drag = {
					type: 'pan',
					x0: e.clientX,
					off0: view.xOffset,
					moved: false,
					canClick: e.button === 0 && !e.altKey && inPlot(x, y),
					clickX: x,
				}
				canvas.style.cursor = 'grabbing'
			})

			window.addEventListener('mousemove', function (e) {
				if (!drag || !plotLayout) return
				if (drag.type === 'pany') {
					const dy = e.clientY - drag.y0
					if (!drag.moved && Math.abs(dy) < DRAG_THRESHOLD_PX) return
					drag.moved = true
					const range = (plotLayout.yMax - plotLayout.yMin) || 1
					const perPx = range / Math.max(1, plotLayout.ph)
					view.yPanOffset = drag.panOffset0 + dy * perPx
					scheduleUIUpdate()
					return
				}
				if (drag.type === 'cursor') {
					const rect = canvas.getBoundingClientRect()
					const x = e.clientX - rect.left
					const y = e.clientY - rect.top
					if (!inPlot(x, y)) return
					drag.moved = true
					const li = plotLayout.fromX(x)
					const cVal = view.cursorMode === 'window'
						? logicalToCursor(li, plotLayout.vr)
						: li
					if (drag.which === 'A') view.cursorA = cVal
					else view.cursorB = cVal
					updateCursorInfo()
					scheduleUIUpdate()
					return
				}
				if (drag.type !== 'pan') return
				const dx = e.clientX - drag.x0
				if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return
				drag.moved = true
				const vr = plotLayout.vr
				const ptsPerPx = vr.count / Math.max(1, plotLayout.pw)
				view.xOffset = Math.max(0, drag.off0 + dx * ptsPerPx)
				const maxOff = Math.max(0, ringCount - MIN_VIEW_POINTS)
				if (view.xOffset > maxOff) view.xOffset = maxOff
				// 手动平移即视为要停住看，自动进入暂停滚动
				if (!scrollPaused && emkSampling && view.xOffset > 0) setScrollPaused(true)
				scheduleUIUpdate()
			})

			window.addEventListener('mouseup', function () {
				if (drag && !drag.moved && drag.canClick && plotLayout && ringCount >= 2) {
					placeCursor(drag.clickX)
				}
				drag = null
				canvas.style.cursor = ''
			})

			// 悬停十字线：显示该点时间 / 电流 / 电压 / 功率；不在拖动中时，
			// 鼠标落在 Y 刻度区给出 ns-resize 提示（可上下拖动平移 Y），
			// 鼠标在游标附近给出 ew-resize 提示（可拖动游标）
			canvas.addEventListener('mousemove', function (e) {
				const rect = canvas.getBoundingClientRect()
				const x = e.clientX - rect.left
				const y = e.clientY - rect.top
				if (!drag) {
					const nearCur = function () {
						if (!plotLayout || ringCount < 2) return false
						const CURSOR_HIT_PX = 8
						const n = function (c) {
							if (c == null) return false
							const li = cursorToLogical(c, plotLayout.vr)
							if (li == null) return false
							return Math.abs(x - plotLayout.toX(li)) <= CURSOR_HIT_PX
						}
						return n(view.cursorB) || n(view.cursorA)
					}
					canvas.style.cursor = inYAxisArea(x, y) ? 'ns-resize'
						: nearCur() ? 'ew-resize' : ''
				}
				if (!plotLayout || ringCount < 2 || !inPlot(x, y)) {
					if (hover) { hover = null; scheduleUIUpdate() }
					return
				}
				hover = { x: x, y: y, li: plotLayout.fromX(x) }
				scheduleUIUpdate()
			})

			canvas.addEventListener('mouseleave', function () {
				if (hover) { hover = null; scheduleUIUpdate() }
			})
			canvas.addEventListener('contextmenu', function (e) { e.preventDefault() })
		}
	}

	function setupSerialEvents() {
		if (!navigator.serial) return
		navigator.serial.addEventListener('connect', function (e) {
			const port = e && e.port && typeof e.port.open === 'function' ? e.port : null
			if (!port || emkManualClose || emkOpening || emkOpen || !emkPort) return
			emkPort = port
			emkLog('设备重连，自动打开')
			emkOpenPort()
		})
		navigator.serial.addEventListener('disconnect', async function (e) {
			const port = e && e.port ? e.port : null
			if (port && emkPort && port !== emkPort) return
			if (!emkPort && !emkOpen) return
			emkLog('设备断开', 'warn')
			const want = !emkManualClose
			await emkClosePort({ manual: false })
			if (want) {
				emkManualClose = false
				emkLog('重新插入后将自动重连', 'warn')
			}
		})
	}

	function setupVisibility() {
		document.addEventListener('visibilitychange', function () {
			if (document.visibilityState === 'hidden') return
			if (emkSampling) requestWakeLock()
			if (emkOpen) scheduleUIUpdate()
		})
		window.addEventListener('pageshow', function () {
			if (emkSampling) requestWakeLock()
		})
	}

	function setupCanvasResize() {
		const canvas = E('emk-canvas')
		const area = canvas && canvas.parentElement
		const target = area || canvas
		if (!target || typeof ResizeObserver === 'undefined') return
		let t = 0
		const ro = new ResizeObserver(function () {
			clearTimeout(t)
			t = setTimeout(function () { updateCanvas() }, 50)
		})
		ro.observe(target)
	}

	// 主题切换重绘：updateCanvas() 每次绘制时都从 CSS 变量取色，采样中/UI 有更新时天然跟得上；
	// 但空闲时切主题不会触发任何重绘，画布会停留在旧配色，看起来像"不支持暗色模式"。
	// data-theme 是显式切换（common.js 里 #theme-toggle 设置），没有它时跟随系统 prefers-color-scheme。
	// 只在 init() 里绑定一次，避免重复 observe/listen。
	function setupThemeWatch() {
		if (typeof MutationObserver !== 'undefined') {
			const mo = new MutationObserver(function () { scheduleUIUpdate() })
			mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
		}
		try {
			const mq = window.matchMedia('(prefers-color-scheme: dark)')
			const onChange = function () { scheduleUIUpdate() }
			if (mq.addEventListener) mq.addEventListener('change', onChange)
			else if (mq.addListener) mq.addListener(onChange) // 老 Safari
		} catch (e) {}
	}

	// 启动只打这一条容量信息（无界面控件，档位由 deviceMemory 自动判断）
	function logCapacity() {
		const mb = RING_CAP_MAX * 4 * 2 / 1024 / 1024
		const spans = []
		const rates = [1000, 100, 10]
		for (let i = 0; i < rates.length; i++) {
			spans.push(fmtHz(rates[i]) + 'Hz→' + fmtDuration(RING_CAP_MAX / rates[i]))
		}
		let dm = ''
		try {
			if (typeof navigator !== 'undefined' && navigator && isFinite(navigator.deviceMemory)) {
				dm = ' · 设备内存 ' + navigator.deviceMemory + 'GB'
			}
		} catch (e) {}
		emkLog('采样缓冲 ' + RING_CAP_MAX.toLocaleString() + ' 点上限（' + mb.toFixed(0) + ' MB，' +
			MAX_CHUNKS + ' × ' + CHUNK_SIZE.toLocaleString() + ' 点分块懒分配）' + dm +
			' · 可记录 ' + spans.join(' / '))
	}

	function init() {
		if (!navigator.serial) emkLog('请使用 Chrome / Edge（需 Web Serial）', 'error')
		readSetVoltage()
		applyRatePreset()
		bind()
		setupSerialEvents()
		setupVisibility()
		setupCanvasResize()
		setupThemeWatch()
		updateSampleBtn()
		updateCursorInfo()
		updateCanvas()
		emkLog('EMK850+ 就绪 · ' + BAUD + ' 8N1 · DA公式/下电0x15/校准BIG_DATA 已对齐上位机')
		logCapacity()
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init)
	} else {
		init()
	}
})()
