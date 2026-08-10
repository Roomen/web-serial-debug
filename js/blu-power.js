;// BLU 100k 功耗分析 — Web Serial + 波形/统计/长期模式
// 协议：js/blu-protocol.js；波形策略参考 Nordic pc-nrfconnect-ppk（min/max 包络、Live、minimap、log Y）
(function () {
	'use strict'

	const PROTO = window.BluProtocol
	if (!PROTO) {
		console.error('[blu-power] 依赖 BluProtocol 未加载')
		return
	}
	const ANAL = window.BluAnalysis
	if (!ANAL) {
		console.warn('[blu-power] BluAnalysis 未加载：分析面板不可用')
	}

	const DEFAULT_VIEW_POINTS = 2000
	// 顶部大数字刷新：过快会看不清，约 2 次/秒足够
	const DIGIT_UI_HZ = 2
	// X 缩小下限按时长算：旧 X_ZOOM_MIN=0.005 → 约 4s@100k；现默认可缩到约 2 分钟窗口
	const MAX_VIEW_DURATION_SEC = 120
	const X_ZOOM_MIN_HARD = 1e-6
	const X_ZOOM_MAX = 2000
	const MIN_VIEW_POINTS = 4
	const Y_ZOOM_MIN = 0.1
	const Y_ZOOM_MAX = 100
	// 左侧 Y 轴命中宽度（相对 plot margin.left，略放宽便于滚轮）
	const Y_AXIS_HIT_PAD_PX = 6
	const DRAG_THRESHOLD_PX = 4
	const PERIOD_LOCK_SEC = 10
	// Log Y：默认 floor 1 nA（优于 PPK 固定 ~200 nA，睡眠电流可分辨）
	const LOG_FLOOR_DEFAULT_UA = 1e-3 // 1 nA
	const LOG_FLOOR_MIN_UA = 1e-4 // 0.1 nA
	const LOG_FLOOR_MAX_UA = 1 // 1 µA 上限，避免 floor 跟到线性区
	const SYMLOG_LINTHRESH_DEFAULT_UA = 1 // 1 µA：近 0 近似线性
	const LOG_SUGGEST_RATIO = 100 // 窗口 max/min+ 超过此值 → 建议 Log
	const LOG_SUGGEST_EXIT = 50 // 建议 Log 退出阈值（滞回，防闪）
	const LOG_LINEAR_HINT_RATIO = 10 // Log 下动态范围过小 → 建议线性
	const LOG_LINEAR_HINT_EXIT = 25 // 建议线性退出阈值（滞回）
	// 软建议时间域防抖：Live 脉冲进出会让 ratio 在阈值两侧抖，仅靠比值滞回不够
	const HINT_RATIO_EMA_ALPHA = 0.12 // ratio EMA 平滑系数（越小越稳）
	const HINT_ENTER_HOLD_MS = 450 // 目标建议需持续这么久才显示
	const HINT_EXIT_HOLD_MS = 1600 // 目标清空需持续这么久才关掉
	const HINT_MIN_SHOW_MS = 2800 // 一旦显示，至少保持这么久
	const HINT_INVALID_KEEP_MS = 900 // 窗口 lo/hi 短暂无效时沿用上一 ratio
	// 示波器式显示触发：沿对齐视口，周期信号看起来钉住
	const SCOPE_TRIG_POS_FRAC = 0.25 // 触发点在视口内水平位置（左→右）
	const SCOPE_TRIG_SCAN_MAX = 80000 // 单批最大扫描点数，防卡 UI
	const SCOPE_TRIG_HOLDOFF_MIN_PTS = 16
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
	// 对照 Python BLU2_MP：STOP 后 / START 前丢弃串口残留样点，避免半帧与旧数据进波形
	let dropSampleStream = false
	// 修正参数 = API get_modifiers()（设备内 R/O 等），连接时自动读取；无 EMK 式人工校准
	let modifiers = PROTO.defaultModifiers()
	let modifiersOk = false
	// 源电压 mV（API REGULATOR_SET）。未打开设备时不显示；打开后从 get_modifiers(VDD) 回填
	let setVoltageMv = null // null = 尚未从设备读到 / 用户未设定
	let wakeLockSentinel = null
	// 排空等待：设备 STOP 后 USB 上仍可能有尾包（API 用 while get_data 抽空）
	const RX_DRAIN_MS = 50

	function setVoltageV() {
		return (setVoltageMv != null && isFinite(setVoltageMv) ? setVoltageMv : 0) / 1000
	}

	function syncVoltageInput() {
		const el = E('blu-voltage-set')
		if (!el) return
		if (setVoltageMv != null && isFinite(setVoltageMv)) {
			el.value = String(setVoltageMv)
		} else {
			el.value = ''
		}
	}

	function clearVoltageUi() {
		setVoltageMv = null
		const el = E('blu-voltage-set')
		if (el) {
			el.value = ''
			delete el.dataset.userTouched
		}
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
	// Y 刻度：'linear' | 'log' | 'symlog'（Symlog 为 asinh，近 0 可读、容忍负噪声）
	let yScaleMode = 'linear'
	let logFloorUA = LOG_FLOOR_DEFAULT_UA
	let symlogLinthreshUA = SYMLOG_LINTHRESH_DEFAULT_UA
	let yAxisLocked = false // Lock Y：冻结自动量程，Live 不再跟
	let yScaleHint = '' // '' | 'log' | 'linear' — 工具条轻提示，不自动硬切
	let yScaleHintRatioEma = null // 平滑后的 max/min+ 比值
	let yScaleHintLastValidAt = 0 // 最近一次有效 ratio 时间
	let yScaleHintChangedAt = 0 // 当前 yScaleHint 写入时间（MIN_SHOW）
	let yScaleHintCandidate = '' // 待切换目标
	let yScaleHintCandidateAt = 0 // 候选开始持续的时间
	let liveMode = true // PPK Live：视口贴着最新数据
	// 示波器显示触发（不控制采样启停；只钉视口）
	// mode: 'off' | 'rise' | 'fall' | 'either'
	let scopeTrigMode = 'off'
	let scopeTrigLevelUA = null // 手动电平 µA；auto 时每次刷新估算
	let scopeTrigLevelAuto = true
	let scopeTrigState = 0 // -1 below / 1 above / 0 unknown（跨批滞回）
	let scopeTrigLockLi = null // 当前钉住的触发逻辑下标
	let scopeTrigLastLi = null // 上一触发点（holdoff / 估周期）
	let scopeTrigPeriodPts = null // EMA 边沿间隔（点）
	let scopeTrigUserOverride = false // 用户平移/缩放时暂时不强制钉视口
	let scopeTrigUiKey = ''
	// 采样沿触发（门控入库 / 自动停采；与显示触发独立，可共用电平）
	// 'off' | 'rise' | 'fall' | 'either'
	let acqTrigStart = 'off' // 开始采样后等沿再入库
	let acqTrigStop = 'off' // 入库后等沿自动 STOP
	let acqTrigStoreEnabled = true // false=已 START 但在等启动沿
	let acqTrigStartState = 0 // 启动沿滞回 -1/0/1
	let acqTrigStopState = 0 // 停止沿滞回
	let acqTrigStopPending = false // 批末异步 stopSampling
	let acqTrigStartLatched = false // 本会话已触发过启动沿
	let acqTrigUiKey = ''
	let acqPreMin = Infinity // 等启动沿期间的 min（Auto 电平）
	let acqPreMax = -Infinity

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

	// <<< 波形存储：RAM 预算内热数据；超额分块压缩落盘（不丢细节）>>>
	const CHUNK_BITS = 16
	const CHUNK_SIZE = 1 << CHUNK_BITS
	const BYTES_PER_SAMPLE = 4 // Float32 电流
	const STORAGE_CFG_KEY = 'blu-storage-config'
	const LEGACY_CAP_KEY = 'blu-ring-capacity'
	const DEFAULT_RAM_GB = 2
	const DEFAULT_DISK_GB = 4
	const RAM_GB_MIN = 0.25
	const RAM_GB_MAX = 8
	const DISK_GB_MIN = 0
	const DISK_GB_MAX = 64
	const HYDRATE_CACHE_MAX = 24 // 热回读缓存块数（约 24×256KB）
	const Store = typeof window !== 'undefined' ? window.BluWaveStore : null

	function clampNum(v, lo, hi, fallback) {
		v = parseFloat(v)
		if (!isFinite(v)) v = fallback
		return Math.max(lo, Math.min(hi, v))
	}

	function roundGb(v) {
		// 显示/存储用 2 位小数，避免 0.30000000004
		return Math.round(v * 100) / 100
	}

	function loadStorageConfig() {
		let ramGB = DEFAULT_RAM_GB
		let diskGB = DEFAULT_DISK_GB
		try {
			const raw = localStorage.getItem(STORAGE_CFG_KEY)
			if (raw) {
				const o = JSON.parse(raw)
				if (o && typeof o === 'object') {
					if (o.ramGB != null) ramGB = o.ramGB
					else if (o.ramMB != null) ramGB = parseFloat(o.ramMB) / 1024
					if (o.diskGB != null) diskGB = o.diskGB
					else if (o.diskMB != null) diskGB = parseFloat(o.diskMB) / 1024
				}
			} else {
				// 兼容旧环缓点数配置 → 粗算 RAM GB
				const legacy = parseInt(localStorage.getItem(LEGACY_CAP_KEY), 10)
				if (isFinite(legacy) && legacy > 0) {
					ramGB = Math.max(RAM_GB_MIN, legacy * BYTES_PER_SAMPLE / (1024 * 1024 * 1024))
				}
			}
		} catch (e) { /* 默认 */ }
		return {
			ramGB: roundGb(clampNum(ramGB, RAM_GB_MIN, RAM_GB_MAX, DEFAULT_RAM_GB)),
			diskGB: roundGb(clampNum(diskGB, DISK_GB_MIN, DISK_GB_MAX, DEFAULT_DISK_GB)),
		}
	}

	function saveStorageConfig(cfg) {
		try {
			localStorage.setItem(STORAGE_CFG_KEY, JSON.stringify({
				ramGB: cfg.ramGB,
				diskGB: cfg.diskGB,
			}))
		} catch (e) { /* 忽略 */ }
	}

	function samplesFromRamGB(ramGB) {
		const bytes = Math.max(0, ramGB) * 1024 * 1024 * 1024
		let n = Math.floor(bytes / BYTES_PER_SAMPLE)
		n = Math.floor(n / CHUNK_SIZE) * CHUNK_SIZE
		return Math.max(CHUNK_SIZE * 2, n)
	}

	function bytesFromDiskGB(diskGB) {
		return Math.max(0, diskGB) * 1024 * 1024 * 1024
	}

	function fmtGb(n) {
		if (!isFinite(n)) return '--'
		if (n === 0) return '0'
		if (n < 1) return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 'G'
		if (Number.isInteger(n)) return n + 'G'
		return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 'G'
	}

	let storageCfg = loadStorageConfig()
	let RING_CAP_MAX = samplesFromRamGB(storageCfg.ramGB)
	let diskBudgetBytes = bytesFromDiskGB(storageCfg.diskGB)

	// 顺序分块：hot 有 buf；cold/pending 落盘后可释放 buf
	// { id, buf, n, sumI, sumP, minI, maxI, state, diskBytes }
	const waveChunks = []
	let totalCount = 0 // 全部保留样点（冷+热）
	let hotCount = 0
	let coldCount = 0
	let sampleCount = 0 // 与 totalCount 同步（波形模式）
	let ringCount = 0 // 兼容旧变量名：= totalCount（可回看总点数）
	let growBlocked = false
	let storageStop = false
	let ramArchiveNoted = false
	let chunkIdSeq = 0
	const archiveQueue = []
	let archiveRunning = false
	const hydrateCache = new Map() // id -> Float32Array
	const hydratePending = new Set()

	function dataCount() {
		return totalCount
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

	function fmtBytes(n) {
		if (!isFinite(n) || n < 0) n = 0
		if (n < 1024) return n + ' B'
		if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
		if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
		return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
	}

	function estimateDurationSec(samples, hz) {
		if (!hz || hz <= 0 || !samples) return 0
		return samples / hz
	}

	function ensureSelectHasValue(sel, value, label) {
		if (!sel) return
		const s = String(value)
		for (let i = 0; i < sel.options.length; i++) {
			if (sel.options[i].value === s) {
				sel.value = s
				return
			}
		}
		// 自定义值（迁移/手改 localStorage）补一条选项
		const opt = document.createElement('option')
		opt.value = s
		opt.textContent = label || (s + 'G')
		sel.appendChild(opt)
		sel.value = s
	}

	function applyStorageConfig(cfg, opts) {
		opts = opts || {}
		storageCfg = {
			ramGB: roundGb(clampNum(cfg.ramGB, RAM_GB_MIN, RAM_GB_MAX, DEFAULT_RAM_GB)),
			diskGB: roundGb(clampNum(cfg.diskGB, DISK_GB_MIN, DISK_GB_MAX, DEFAULT_DISK_GB)),
		}
		RING_CAP_MAX = samplesFromRamGB(storageCfg.ramGB)
		diskBudgetBytes = bytesFromDiskGB(storageCfg.diskGB)
		if (opts.persist !== false) saveStorageConfig(storageCfg)
		syncStorageUi()
	}

	function syncStorageUi() {
		const elRam = E('blu-ram-gb')
		const elDisk = E('blu-disk-gb')
		if (elRam && document.activeElement !== elRam) {
			ensureSelectHasValue(elRam, storageCfg.ramGB, fmtGb(storageCfg.ramGB))
		}
		if (elDisk && document.activeElement !== elDisk) {
			ensureSelectHasValue(elDisk, storageCfg.diskGB, storageCfg.diskGB === 0 ? '0' : fmtGb(storageCfg.diskGB))
		}
		updateStorageHint()
	}

	/** 存储详情放在 title（悬停），不占工具条宽度 */
	function updateStorageHint() {
		const el = E('blu-storage-hint')
		const wrap = E('blu-storage-set')
		const hz = targetRateHz > 0 ? targetRateHz : 100000
		const ramSec = estimateDurationSec(RING_CAP_MAX, hz)
		const hotBytes = hotCount * BYTES_PER_SAMPLE
		const diskBytes = Store ? Store.getDiskUsed() : 0
		const diskSamplesEst = diskBudgetBytes > 0
			? Math.floor(diskBudgetBytes / (BYTES_PER_SAMPLE * 0.35))
			: 0
		const diskSec = estimateDurationSec(diskSamplesEst, hz)
		const tip = 'RAM ' + fmtGb(storageCfg.ramGB) + ' 约 ' + fmtDuration(ramSec) +
			' @' + fmtHz(hz) +
			(diskBudgetBytes > 0
				? (' · 磁盘 ' + fmtGb(storageCfg.diskGB) + ' 压后约 +' + fmtDuration(diskSec))
				: ' · 磁盘 0（RAM 满即停）') +
			' · 热 ' + fmtBytes(hotBytes) + '/' + fmtGb(storageCfg.ramGB) +
			(diskBudgetBytes > 0 ? (' · 盘 ' + fmtBytes(diskBytes) + '/' + fmtGb(storageCfg.diskGB)) : '') +
			(coldCount > 0 ? (' · 冷 ' + coldCount + ' 点') : '')
		if (wrap) wrap.title = tip
		if (el) {
			el.textContent = ''
			el.title = tip
		}
	}

	function updateStorageUsage() {
		// 占用合并进 hint 单行显示
		updateStorageHint()
	}

	function allocHotBuf() {
		try {
			return new Float32Array(CHUNK_SIZE)
		} catch (e) {
			growBlocked = true
			bluLog('内存不足，无法分配波形块：' + (e.message || e), 'warn')
			return null
		}
	}

	function newHotChunk() {
		const buf = allocHotBuf()
		if (!buf) return null
		chunkIdSeq++
		return {
			id: 'c' + chunkIdSeq,
			buf: buf,
			n: 0,
			sumI: 0,
			sumP: 0,
			minI: Infinity,
			maxI: -Infinity,
			// 包络连线用：整块回退时 first/last 必须是端点样值，不能用 min/max
			firstI: 0,
			lastI: 0,
			state: 'hot',
			diskBytes: 0,
		}
	}

	function getChunkBuf(ch) {
		if (!ch) return null
		if (ch.buf) return ch.buf
		if (hydrateCache.has(ch.id)) return hydrateCache.get(ch.id)
		return null
	}

	function touchHydrateCache(id, buf) {
		if (hydrateCache.has(id)) hydrateCache.delete(id)
		hydrateCache.set(id, buf)
		while (hydrateCache.size > HYDRATE_CACHE_MAX) {
			const first = hydrateCache.keys().next().value
			hydrateCache.delete(first)
		}
	}

	function requestHydrate(ch) {
		if (!ch || ch.state === 'hot' || !ch.diskBytes) return
		if (getChunkBuf(ch) || hydratePending.has(ch.id)) return
		if (!Store) return
		hydratePending.add(ch.id)
		Store.readChunk(ch.id, ch.n).then(function (buf) {
			touchHydrateCache(ch.id, buf)
			hydratePending.delete(ch.id)
			// 包络缓存可能是 min/max 近似，回读后失效以便重绘细节
			clearBucketCache()
			scheduleUIUpdate()
		}).catch(function (e) {
			hydratePending.delete(ch.id)
			bluLog('冷数据回读失败 ' + ch.id + '：' + (e && e.message ? e.message : e), 'warn')
		})
	}

	function findChunkAt(li) {
		if (li < 0 || li >= totalCount) return null
		let off = li
		for (let i = 0; i < waveChunks.length; i++) {
			const ch = waveChunks[i]
			if (off < ch.n) return { ch: ch, off: off, index: i }
			off -= ch.n
		}
		return null
	}

	/** 全局逻辑下标 → 电流 µA（冷块未回读时用 min/max 中点占位并触发回读） */
	function ringIAt(li) {
		const loc = findChunkAt(li)
		if (!loc) return 0
		const buf = getChunkBuf(loc.ch)
		if (buf) return buf[loc.off]
		requestHydrate(loc.ch)
		const ch = loc.ch
		if (isFinite(ch.minI) && isFinite(ch.maxI)) return (ch.minI + ch.maxI) * 0.5
		return 0
	}

	function diskUsedBytes() {
		return Store ? Store.getDiskUsed() : 0
	}

	/** 将最老的完整热块压缩归档；失败返回 false（磁盘满/无后端/内存） */
	function enqueueOldestHotArchive() {
		let idx = -1
		for (let i = 0; i < waveChunks.length; i++) {
			const ch = waveChunks[i]
			if (ch.state === 'hot' && ch.buf && ch.n > 0) {
				// 优先归档已写满的块；仅当热数据已顶满预算时才归档未满尾块
				if (ch.n >= CHUNK_SIZE || hotCount >= RING_CAP_MAX) {
					idx = i
					break
				}
			}
		}
		if (idx < 0) return false
		const ch = waveChunks[idx]
		if (ch.state !== 'hot' || !ch.buf) return false

		// 磁盘预算：用未压缩体积作上限预检（压缩后会更小，写入后再按实际计）
		const rawBytes = ch.n * BYTES_PER_SAMPLE
		if (diskBudgetBytes <= 0) {
			// 不允许落盘：RAM 满即停
			return false
		}
		if (!Store) {
			return false
		}
		if (diskUsedBytes() + rawBytes > diskBudgetBytes) {
			return false
		}

		const samples = ch.buf.subarray(0, ch.n)
		// 拷贝后再释放热引用，避免异步压缩期间被改写
		let copy
		try {
			copy = new Float32Array(samples)
		} catch (e) {
			growBlocked = true
			bluLog('归档拷贝失败（内存不足）', 'warn')
			return false
		}
		ch.state = 'pending'
		ch.buf = null
		hotCount -= ch.n
		coldCount += ch.n
		archiveQueue.push({ ch: ch, samples: copy })
		if (!ramArchiveNoted) {
			ramArchiveNoted = true
			bluLog('RAM 预算已满，开始压缩归档到磁盘（不丢细节）', 'warn')
		}
		pumpArchiveQueue()
		return true
	}

	function pumpArchiveQueue() {
		if (archiveRunning) return
		if (!archiveQueue.length) return
		archiveRunning = true
		const job = archiveQueue.shift()
		const ch = job.ch
		const samples = job.samples
		const run = async function () {
			try {
				if (!Store) throw new Error('BluWaveStore 未加载')
				await Store.init()
				if (!Store.getBackend()) throw new Error('浏览器不支持 OPFS/IndexedDB 落盘')
				// 再次检查磁盘（队列等待期间可能已占满）
				const rawBytes = samples.length * BYTES_PER_SAMPLE
				if (diskUsedBytes() + Math.ceil(rawBytes * 0.15) > diskBudgetBytes) {
					// 预留一点最小写入空间；若几乎满则停止
					throw new Error('DISK_FULL')
				}
				const res = await Store.writeChunk(ch.id, samples)
				ch.diskBytes = res.byteSize
				ch.state = 'cold'
				if (diskUsedBytes() > diskBudgetBytes) {
					// 已写入但超预算：删掉磁盘副本，避免不可达垃圾 + RAM 双份
					try {
						await Store.removeChunk(ch.id, ch.diskBytes)
					} catch (eRm) { /* 忽略 */ }
					ch.diskBytes = 0
					throw new Error('DISK_FULL')
				}
				updateStorageUsage()
			} catch (e) {
				const msg = e && e.message ? e.message : String(e)
				// 写失败：尽量把数据救回 RAM，避免丢细节
				if (!ch.buf) {
					try {
						ch.buf = samples
						ch.state = 'hot'
						hotCount += ch.n
						coldCount = Math.max(0, coldCount - ch.n)
					} catch (e2) {
						ch.state = 'lost'
						bluLog('归档失败且无法回灌 RAM，部分数据可能丢失', 'error')
					}
				}
				if (msg === 'DISK_FULL' || (diskBudgetBytes > 0 && diskUsedBytes() >= diskBudgetBytes)) {
					triggerStorageStop('磁盘预算已满（' + fmtGb(storageCfg.diskGB) + '），已停止采样')
				} else {
					bluLog('波形归档失败：' + msg, 'error')
					triggerStorageStop('波形归档失败，已停止采样以防丢数据')
				}
			} finally {
				archiveRunning = false
				if (archiveQueue.length) pumpArchiveQueue()
				updateStorageUsage()
				scheduleUIUpdate()
			}
		}
		run()
	}

	function triggerStorageStop(reason) {
		if (storageStop) return
		storageStop = true
		bluLog(reason, 'error')
		if (bluSampling) {
			// 异步停止，避免在 ingest 栈内重入
			setTimeout(function () {
				stopSampling()
			}, 0)
		}
	}

	/** 保证热区有空间再写入；失败则停录 */
	function ensureHotRoom(needSamples) {
		needSamples = needSamples || 1
		while (hotCount + needSamples > RING_CAP_MAX && !growBlocked) {
			if (!enqueueOldestHotArchive()) {
				if (diskBudgetBytes <= 0) {
					triggerStorageStop('RAM 已满且磁盘预算为 0，已停止采样（不覆盖旧数据）')
				} else {
					triggerStorageStop('RAM 已满且磁盘无法继续归档（预算满或不可用），已停止采样')
				}
				return false
			}
		}
		if (growBlocked && hotCount + needSamples > RING_CAP_MAX) {
			triggerStorageStop('内存不足且无法继续归档，已停止采样')
			return false
		}
		return true
	}

	function ringPush(curUA) {
		if (storageStop) return false
		// 非有限值会污染 min/max/包络并导致 canvas 路径断裂（在占预算前丢弃）
		if (!isFinite(curUA)) return true
		if (!ensureHotRoom(1)) return false

		let ch = waveChunks.length ? waveChunks[waveChunks.length - 1] : null
		if (!ch || ch.state !== 'hot' || !ch.buf || ch.n >= CHUNK_SIZE) {
			ch = newHotChunk()
			if (!ch) {
				// 尝试腾出一块再分配
				if (enqueueOldestHotArchive()) ch = newHotChunk()
				if (!ch) {
					triggerStorageStop('无法分配新波形块，已停止采样')
					return false
				}
			}
			waveChunks.push(ch)
		}

		const off = ch.n
		ch.buf[off] = curUA
		ch.n++
		const vset = setVoltageV()
		ch.sumI += curUA
		ch.sumP += curUA * vset
		if (off === 0) ch.firstI = curUA
		ch.lastI = curUA
		if (curUA < ch.minI) ch.minI = curUA
		if (curUA > ch.maxI) ch.maxI = curUA

		totalCount++
		hotCount++
		sampleCount = totalCount
		ringCount = totalCount
		return true
	}

	function ringReset() {
		// 清空会话时丢弃未落盘队列（调用方本意是丢数据）；记日志避免 silent drop
		if (archiveQueue.length > 0) {
			const nPend = archiveQueue.length
			let pts = 0
			for (let i = 0; i < archiveQueue.length; i++) {
				const j = archiveQueue[i]
				if (j && j.ch) pts += j.ch.n || 0
			}
			bluLog('清空数据：丢弃 ' + nPend + ' 个未落盘归档块（约 ' + pts + ' 点）', 'warn')
			archiveQueue.length = 0
		}
		waveChunks.length = 0
		totalCount = 0
		hotCount = 0
		coldCount = 0
		sampleCount = 0
		ringCount = 0
		growBlocked = false
		storageStop = false
		ramArchiveNoted = false
		chunkIdSeq = 0
		hydrateCache.clear()
		hydratePending.clear()
		if (Store) {
			Store.clearSession().catch(function () { /* 忽略 */ })
		}
		updateStorageUsage()
	}

	function addChunkStatRange(ch, lo, hi, acc) {
		// [lo, hi) 块内半开区间
		if (hi <= lo) return
		const len = hi - lo
		if (lo === 0 && hi === ch.n && ch.n > 0) {
			acc.sumI += ch.sumI
			acc.sumP += ch.sumP
			if (ch.minI < acc.minI) acc.minI = ch.minI
			if (ch.maxI > acc.maxI) acc.maxI = ch.maxI
			acc.n += ch.n
			return
		}
		const buf = getChunkBuf(ch)
		const vset = setVoltageV()
		if (buf) {
			for (let i = lo; i < hi; i++) {
				const v = buf[i]
				acc.sumI += v
				acc.sumP += v * vset
				if (v < acc.minI) acc.minI = v
				if (v > acc.maxI) acc.maxI = v
				acc.n++
			}
			return
		}
		// 冷块未回读：用块级统计按比例近似（选区边界可能略偏，完整块仍精确）
		requestHydrate(ch)
		if (ch.n > 0 && len === ch.n) {
			acc.sumI += ch.sumI
			acc.sumP += ch.sumP
			if (ch.minI < acc.minI) acc.minI = ch.minI
			if (ch.maxI > acc.maxI) acc.maxI = ch.maxI
			acc.n += ch.n
		} else if (ch.n > 0) {
			const ratio = len / ch.n
			acc.sumI += ch.sumI * ratio
			acc.sumP += ch.sumP * ratio
			if (ch.minI < acc.minI) acc.minI = ch.minI
			if (ch.maxI > acc.maxI) acc.maxI = ch.maxI
			acc.n += len
		}
	}

	function calcStats(start, end) {
		const nTotal = dataCount()
		if (nTotal < 1 || end <= start) return emptyStats()
		start = Math.max(0, start)
		end = Math.min(nTotal, end)
		const n = end - start
		if (n <= 0) return emptyStats()
		const acc = { n: 0, sumI: 0, sumP: 0, minI: Infinity, maxI: -Infinity }
		let base = 0
		for (let i = 0; i < waveChunks.length; i++) {
			const ch = waveChunks[i]
			const ch0 = base
			const ch1 = base + ch.n
			const lo = Math.max(start, ch0)
			const hi = Math.min(end, ch1)
			if (hi > lo) addChunkStatRange(ch, lo - ch0, hi - ch0, acc)
			base = ch1
			if (base >= end) break
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

	function bucketMinMaxGlobal(lo, hi) {
		// 全局逻辑下标闭区间 [lo, hi]
		// minPos：桶内最小正电流（供 Log floor / 建议 Log；与包络 min 分离，负/零不污染）
		let mn = Infinity
		let mx = -Infinity
		let minPos = Infinity
		let first = 0
		let last = 0
		let got = false
		let base = 0
		for (let i = 0; i < waveChunks.length; i++) {
			const ch = waveChunks[i]
			const ch0 = base
			const ch1 = base + ch.n
			const a = Math.max(lo, ch0)
			const b = Math.min(hi, ch1 - 1)
			if (b >= a) {
				if (a === ch0 && b === ch1 - 1 && ch.n > 0) {
					// 整块：用端点样值作 first/last（min/max 作端点会在列间画出假尖峰）
					const f = isFinite(ch.firstI) ? ch.firstI : ch.minI
					const l = isFinite(ch.lastI) ? ch.lastI : ch.maxI
					if (!got) { first = f; got = true }
					last = l
					if (ch.minI < mn) mn = ch.minI
					if (ch.maxI > mx) mx = ch.maxI
					// 整块无逐点：仅当 minI>0 可知 minPos；minI≤0 时无法从块级统计推断
					if (ch.minI > 0 && ch.minI < minPos) minPos = ch.minI
				} else {
					const buf = getChunkBuf(ch)
					if (buf) {
						for (let p = a; p <= b; p++) {
							const v = buf[p - ch0]
							if (!isFinite(v)) continue
							if (!got) { first = v; got = true }
							last = v
							if (v < mn) mn = v
							if (v > mx) mx = v
							if (v > 0 && v < minPos) minPos = v
						}
					} else {
						// 冷块未回读：包络用块级 min/max；部分区间端点用中点，避免整块 first/last 造成假跳变
						requestHydrate(ch)
						const mid = (isFinite(ch.minI) && isFinite(ch.maxI))
							? (ch.minI + ch.maxI) * 0.5
							: 0
						if (!got) { first = mid; got = true }
						last = mid
						if (ch.minI < mn) mn = ch.minI
						if (ch.maxI > mx) mx = ch.maxI
						if (ch.minI > 0 && ch.minI < minPos) minPos = ch.minI
					}
				}
			}
			base = ch1
			if (base > hi) break
		}
		if (!got || !isFinite(mn) || !isFinite(mx)) {
			return { min: 0, max: 0, first: 0, last: 0, minPos: Infinity, loAbs: lo, hiAbs: hi }
		}
		return {
			min: mn, max: mx, first: first, last: last,
			minPos: minPos, loAbs: lo, hiAbs: hi,
		}
	}

	// 绘制用 min/max 分桶（PPK dataAccumulator：每像素 min/max 包络）
	// 仅缓存「完整」桶；尾部未写满的桶每次重算，避免 Live 时右缘偶发错包络
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

	function getBucketEntry(bucketIdx, bucketSize, base, lastAbs) {
		if (bucketCache.size !== bucketSize || bucketCache.base !== base || !bucketCache.map) {
			bucketCache.size = bucketSize
			bucketCache.base = base
			bucketCache.map = new Map()
		}
		const lo = bucketIdx * bucketSize
		const hi = Math.min(lastAbs, lo + bucketSize - 1)
		if (hi < base || lo > lastAbs) return null
		const complete = (hi - lo + 1) >= bucketSize
		if (complete && bucketCache.map.has(bucketIdx)) return bucketCache.map.get(bucketIdx)
		const aLo = Math.max(lo, base)
		const aHi = hi
		const entry = bucketMinMaxGlobal(aLo, aHi)
		// 未写满的尾桶不入缓存，否则 Live 增长时右缘会用旧 min/max 闪一下假波形
		if (complete) bucketCache.map.set(bucketIdx, entry)
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
	// 示波器式游标吸附：free | rise | fall | either（测频用边沿间隔，不需要 FFT）
	let cursorSnapMode = 'free'
	const EDGE_SEARCH_MAX = 80000 // 单次边沿搜索上限，防卡 UI（全选大缓冲时抽稀）
	// 选择测量缓存：供画布浮标用，避免每帧重扫边沿
	let cursorMeasureCache = null
	// 分析面板：读数 / 事件 / FFT / 电池 / 叠画（默认可折叠，不占波形高度）
	let analysisTab = 'readout'
	let analysisScope = 'auto' // auto | selection | window
	let analysisCollapsed = true
	let analysisCache = null // { key, source, samples, … }
	let analysisPending = false
	let analysisTimer = null
	let analysisLastRenderKey = '' // 避免 digit 定时器反复重绘 DOM
	let analysisHadRange = false
	const ANALYSIS_CFG_KEY = 'blu-analysis-ui'
	const ANALYSIS_MAX_SAMPLES = 262144 // 区间抽取上限，防卡 UI
	const ANALYSIS_DEBOUNCE_MS = 80

	function loadAnalysisUiCfg() {
		try {
			const raw = localStorage.getItem(ANALYSIS_CFG_KEY)
			if (!raw) return
			const o = JSON.parse(raw)
			if (o && (o.scope === 'auto' || o.scope === 'selection' || o.scope === 'window')) {
				analysisScope = o.scope
			}
			if (o && typeof o.collapsed === 'boolean') analysisCollapsed = o.collapsed
		} catch (e) { /* 忽略 */ }
	}

	function saveAnalysisUiCfg() {
		try {
			localStorage.setItem(ANALYSIS_CFG_KEY, JSON.stringify({
				scope: analysisScope,
				collapsed: analysisCollapsed,
			}))
		} catch (e) { /* 忽略 */ }
	}

	loadAnalysisUiCfg()
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

	/** 连接状态合并进「打开/关闭」按钮（不再单独显示未连接/已连接） */
	function setStatus(text, connected) {
		const toggle = E('blu-open')
		if (!toggle) return
		const on = !!connected
		toggle.classList.toggle('is-open', on)
		toggle.classList.toggle('btn-primary', !on)
		toggle.classList.toggle('btn-outline-danger', on)
		toggle.innerHTML = on
			? '<i class="bi bi-plug-fill"></i> 关闭'
			: '<i class="bi bi-plug"></i> 打开'
		toggle.title = on ? (text || '已连接 · 点击关闭') : (text || '未连接 · 点击打开')
	}

	function setDeviceMenuOpen(open) {
		const menu = E('blu-device-menu')
		const pop = E('blu-device-pop')
		const btn = E('blu-device-btn')
		if (!pop || !btn) return
		const on = !!open
		pop.hidden = !on
		btn.classList.toggle('is-open', on)
		btn.setAttribute('aria-expanded', on ? 'true' : 'false')
		if (menu) menu.classList.toggle('is-open', on)
	}

	function shortDeviceLabel(port, index) {
		if (!port) return '未选设备'
		let info = {}
		try { info = port.getInfo ? port.getInfo() : {} } catch (e) {}
		const sn = getPortSn(port)
		const vp = formatVidPid(info, true)
		if (sn) return sn
		if (vp) return 'BLU · <span class="blu-vp">' + vp + '</span>'
		return bluKnownPorts.length > 1 ? ('设备 #' + (index + 1)) : 'BLU'
	}

	function renderDeviceList() {
		const list = E('blu-device-list')
		const label = E('blu-device-label')
		if (label) {
			const idx = bluPort ? bluKnownPorts.indexOf(bluPort) : -1
			const html = shortDeviceLabel(bluPort, idx >= 0 ? idx : 0)
			// 允许短 VID/PID 用 span
			if (html.indexOf('<') >= 0) label.innerHTML = html
			else label.textContent = html
			label.title = bluPort ? bluPortLabel(bluPort, idx >= 0 ? idx : 0) : '点击选择或添加设备'
		}
		if (!list) return
		list.innerHTML = ''
		if (!bluKnownPorts.length) {
			const empty = document.createElement('div')
			empty.className = 'blu-device-empty'
			empty.textContent = '未检测到设备，请添加'
			list.appendChild(empty)
			return
		}
		for (let i = 0; i < bluKnownPorts.length; i++) {
			const p = bluKnownPorts[i]
			const item = document.createElement('button')
			item.type = 'button'
			item.className = 'blu-device-item' + (p === bluPort ? ' is-active' : '')
			item.setAttribute('role', 'option')
			item.dataset.index = String(i)
			let info = {}
			try { info = p.getInfo ? p.getInfo() : {} } catch (e) {}
			const sn = getPortSn(p)
			const vp = formatVidPid(info, true)
			const name = document.createElement('span')
			name.className = 'blu-device-item-name'
			name.textContent = sn || ('BLU' + (bluKnownPorts.length > 1 ? ' #' + (i + 1) : ''))
			const meta = document.createElement('span')
			meta.className = 'blu-device-item-meta'
			meta.textContent = vp || '已授权串口'
			item.appendChild(name)
			item.appendChild(meta)
			item.addEventListener('click', function () {
				const ii = parseInt(item.dataset.index, 10)
				if (!isFinite(ii) || ii < 0 || ii >= bluKnownPorts.length) return
				const next = bluKnownPorts[ii]
				if (bluOpen && next !== bluPort) {
					bluLog('请先关闭当前设备再切换', 'warn')
					return
				}
				bluPort = next
				const sel = E('blu-port-select')
				if (sel) sel.value = String(ii)
				bluLog('已选中 ' + bluPortLabel(next, ii))
				renderDeviceList()
				setDeviceMenuOpen(false)
			})
			list.appendChild(item)
		}
	}

	function fmtCurrent(ua) {
		if (!isFinite(ua)) return '--'
		const a = Math.abs(ua)
		if (a >= 1e6) return (ua / 1e6).toFixed(3) + ' A'
		if (a >= 1e3) return (ua / 1e3).toFixed(3) + ' mA'
		if (a >= 1) return ua.toFixed(2) + ' µA'
		if (a >= 1e-3) return (ua * 1e3).toFixed(2) + ' nA'
		if (a > 0) return (ua * 1e3).toFixed(3) + ' nA'
		return '0'
	}

	/** 刻度标签：1/2/5×10ⁿ 风格，自动 nA/µA/mA/A（无空格，省左侧宽度） */
	function fmtCurrentTick(ua) {
		if (!isFinite(ua)) return ''
		if (ua === 0) return '0'
		const sign = ua < 0 ? '-' : ''
		const a = Math.abs(ua)
		let unit, scaled
		if (a >= 1e6) { unit = 'A'; scaled = a / 1e6 }
		else if (a >= 1e3) { unit = 'mA'; scaled = a / 1e3 }
		else if (a >= 1) { unit = 'µA'; scaled = a }
		else { unit = 'nA'; scaled = a * 1e3 }
		let text
		if (scaled >= 100) text = scaled.toFixed(0)
		else if (scaled >= 10) text = (Math.abs(scaled - Math.round(scaled)) < 0.05)
			? String(Math.round(scaled)) : scaled.toFixed(1)
		else if (scaled >= 1) text = (Math.abs(scaled - Math.round(scaled)) < 0.05)
			? String(Math.round(scaled)) : scaled.toFixed(1)
		else text = scaled.toPrecision(2)
		return sign + text + unit
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

	/** 读 UI 源电压（mV 整数，对齐上位机）；无效则返回 null */
	function readSetVoltageMv() {
		const el = E('blu-voltage-set')
		if (!el) return setVoltageMv
		const raw = String(el.value == null ? '' : el.value).trim()
		if (!raw) return setVoltageMv
		let mv = parseInt(raw, 10)
		if (!isFinite(mv)) return setVoltageMv
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
		// 默认 100k；波形模式提示 RAM/磁盘预算
		if (p.hz >= 50000 && recordMode === 'wave') {
			const sec = estimateDurationSec(RING_CAP_MAX, p.hz)
			bluLog('100k 波形：RAM 约可存 ' + fmtDuration(sec) +
				'，超出后压缩落盘（磁盘 ' + fmtGb(storageCfg.diskGB) + '）', 'warn')
		}
		updateStorageHint()
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
		const btn = E('blu-dut-power')
		if (!btn) return
		btn.classList.toggle('is-on', bluPowered)
		btn.innerHTML = bluPowered
			? '<i class="bi bi-lightning-charge-fill"></i> 下电'
			: '<i class="bi bi-lightning-charge"></i> 上电'
		btn.title = bluPowered ? 'DUT 已上电 · 点击下电' : 'DUT 已下电 · 点击上电'
	}

	async function toggleDutPower() {
		if (!bluOpen) {
			bluLog('请先打开设备再上下电', 'warn')
			return
		}
		if (bluPowered) await doPowerOff()
		else await doPowerOn()
	}

	async function applyVoltageMv(mv) {
		if (mv == null || !isFinite(mv)) {
			bluLog('请先设定源电压 mV', 'error')
			return false
		}
		const clamped = Math.max(PROTO.VDD_LOW_MV, Math.min(PROTO.VDD_HIGH_MV, Math.round(mv)))
		setVoltageMv = clamped
		syncVoltageInput()
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
		const mv = readSetVoltageMv()
		if (mv == null || !isFinite(mv) || mv < PROTO.VDD_LOW_MV) {
			bluLog('请先设定源电压 mV（打开设备后会从设备读取）', 'error')
			return
		}
		await applyVoltageMv(mv)
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
			// 打开/识别后以设备 VDD 为准回填；用户本会话已手改则不覆盖
			const el = E('blu-voltage-set')
			if (saved >= PROTO.VDD_LOW_MV && saved <= PROTO.VDD_HIGH_MV) {
				if (!el || !el.dataset.userTouched) {
					setVoltageMv = Math.round(saved)
					syncVoltageInput()
				}
			} else if (!el || !el.dataset.userTouched) {
				// 设备未报 VDD：保持空白，不写内部默认
				setVoltageMv = null
				syncVoltageInput()
				bluLog('设备未返回 VDD，请手动设定源电压', 'warn')
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
		analysisCache = null
		resetYAuto()
		view.xOffset = 0
		view.cursorA = null
		view.cursorB = null
		cursorMeasureCache = null
		dispInit = false
		firstStoredTs = 0
		sessionT0Ms = 0
		lastPointTMs = 0
		periodLocked = false
		periodLogged = false
		deviceStreamHz = 0
		rawStreamCount = 0
		rawStreamFirstTs = 0
		resetYScaleHintState()
		syncYScaleUi() // 无数据时 updateCanvas early return，须直接刷 DOM
		resetScopeTriggerState()
		if (scopeTrigMode !== 'off') syncScopeTrigUi()
		if (log) bluLog('数据已清空')
		scheduleUIUpdate()
	}

	/** 对照 API：在丢弃窗口内让读循环吃掉残留字节，并清 parser 半帧 */
	async function drainSampleRx(ms) {
		dropSampleStream = true
		parser.reset()
		const wait = Math.max(0, ms == null ? RX_DRAIN_MS : ms)
		if (wait > 0) {
			await new Promise(function (r) { setTimeout(r, wait) })
		}
		parser.reset()
	}

	async function startSampling() {
		if (!bluOpen || bluSampling) return
		// API：start_measuring 要求已 set_source_voltage（current_vdd，单位 mV）
		const mv = readSetVoltageMv()
		if (!isFinite(mv) || mv < PROTO.VDD_LOW_MV) {
			bluLog('请先设定源电压 mV（API 要求 current_vdd）', 'error')
			return
		}
		// 对照 BLU2_MP.start_measuring：先 STOP → 排空残留 → 再 START
		dropSampleStream = true
		try { await bluWrite(PROTO.cmdAverageStop(), 'AVERAGE_STOP') } catch (e) {}
		await drainSampleRx(RX_DRAIN_MS)

		applyRatePreset()
		// clearAllData 会清 deviceStreamHz，基速先记下再清会话
		const baseHz = deviceStreamHz > 1000 ? deviceStreamHz : PROTO.NOMINAL_BASE_HZ
		clearAllData(false)
		storageStop = false
		if (recordMode === 'wave' && Store) {
			try {
				await Store.init()
				const be = Store.getBackend()
				if (!be && storageCfg.diskGB > 0) {
					bluLog('当前浏览器无法落盘（需 OPFS 或 IndexedDB），磁盘预算将无法使用', 'warn')
				}
			} catch (e) {
				bluLog('初始化波形磁盘存储失败：' + (e && e.message ? e.message : e), 'warn')
			}
		}
		parser.reset()
		converter.resetFilter()
		rateAdj = new PROTO.RateAdjuster(targetRateHz, baseHz)
		// 预热：按目标输出率 × 秒数，并封顶，避免 100k×2s 丢 20 万点才出波形
		warmupLeft = Math.max(0, Math.min(WARMUP_MAX_SAMPLES, Math.round(targetRateHz * WARMUP_SEC)))
		metaCollecting = false
		metaCollectBuf = ''
		// 每次开始采样默认 Live 滚动（贴最新波形），清掉上次暂停/平移状态
		view.xOffset = 0
		view.yPanOffset = 0
		setScrollPaused(false)
		// 采样沿触发：Arm 后先 START 设备，等沿再入库；停沿在入库后生效
		acqTrigStopPending = false
		acqTrigStartLatched = false
		acqTrigStartState = 0
		acqTrigStopState = 0
		acqPreMin = Infinity
		acqPreMax = -Infinity
		if (acqTrigStart !== 'off') {
			acqTrigStoreEnabled = false
			bluLog('采样沿启动已 Arm：等待 ' + acqEdgeLabel(acqTrigStart) +
				' 后开始入库（电平 ' + (scopeTrigLevelAuto ? 'Auto' : fmtCurrent(scopeTrigLevelUA)) + '）')
		} else {
			acqTrigStoreEnabled = true
		}
		bluSampling = true
		updateSampleBtn()
		startStallWatch()
		// 先发 START，再异步要 WakeLock，避免多等一拍
		const startOk = await bluWrite(PROTO.cmdAverageStart(), 'AVERAGE_START')
		// START 已下发后再接收样点（此前 drop 挡住 STOP 尾包与竞态）
		dropSampleStream = false
		requestWakeLock() // 不 await，不挡采样
		const warmMs = targetRateHz > 0 ? Math.round(warmupLeft / targetRateHz * 1000) : 0
		const ramSec = estimateDurationSec(RING_CAP_MAX, targetRateHz)
		const acqTag = (acqTrigStart !== 'off' ? ' · 等' + acqEdgeLabel(acqTrigStart) + '入库' : '') +
			(acqTrigStop !== 'off' ? ' · 遇' + acqEdgeLabel(acqTrigStop) + '停采' : '')
		bluLog((startOk ? 'AVERAGE_START' : 'AVERAGE_START 可能失败') +
			' · 目标 ' + getRatePreset().label +
			' · ' + (recordMode === 'long' ? '长期统计' : '波形') +
			' · Live 滚动' +
			acqTag +
			' · 预热约 ' + warmMs + ' ms（' + warmupLeft + ' 点）' +
			(recordMode === 'wave'
				? (' · RAM ' + fmtGb(storageCfg.ramGB) + '≈' + fmtDuration(ramSec) +
					' · 磁盘 ' + fmtGb(storageCfg.diskGB))
				: '') +
			(modifiersOk ? '' : ' · 默认修正参数'))
	}

	async function stopSampling() {
		if (!bluSampling) return
		// 先停入库，再 STOP；对照 API stop_measuring：发 STOP 后 get_data 丢弃残留
		bluSampling = false
		dropSampleStream = true
		acqTrigStoreEnabled = true
		acqTrigStopPending = false
		acqTrigStartLatched = false
		stopStallWatch()
		updateSampleBtn()
		try { await bluWrite(PROTO.cmdAverageStop(), 'AVERAGE_STOP') } catch (e) {}
		parser.reset()
		releaseWakeLock()
		bluLog(storageStop ? '已停止采样（存储限制）' : '已停止采样')
		updateStorageUsage()
		scheduleUIUpdate()
	}

	function acqEdgeLabel(mode) {
		if (mode === 'rise') return '↑沿'
		if (mode === 'fall') return '↓沿'
		if (mode === 'either') return '任意沿'
		return '关'
	}

	function updateSampleBtn() {
		const el = E('blu-start')
		if (!el) return
		if (bluSampling) {
			el.className = 'btn btn-sm btn-danger'
			if (!acqTrigStoreEnabled && acqTrigStart !== 'off') {
				el.innerHTML = '<i class="bi bi-hourglass-split"></i> 等沿…'
				el.title = '已 Arm：等待 ' + acqEdgeLabel(acqTrigStart) + ' 开始入库 · 点击取消'
			} else {
				el.innerHTML = '<i class="bi bi-stop-fill"></i> 停止'
				el.title = acqTrigStop !== 'off'
					? ('采样中 · 遇' + acqEdgeLabel(acqTrigStop) + '自动停 · 点击立即停')
					: '停止采样'
			}
		} else {
			el.className = 'btn btn-sm btn-success'
			el.innerHTML = '<i class="bi bi-play-fill"></i> 采样'
			el.title = (acqTrigStart !== 'off' || acqTrigStop !== 'off')
				? ('开始采样' +
					(acqTrigStart !== 'off' ? '（等' + acqEdgeLabel(acqTrigStart) + '入库）' : '') +
					(acqTrigStop !== 'off' ? '（遇' + acqEdgeLabel(acqTrigStop) + '停）' : ''))
				: '开始 / 停止采样'
		}
		// 等待态边框等与按钮同步
		acqTrigUiKey = ''
		syncAcqTrigUi()
	}

	function setScrollPaused(on) {
		scrollPaused = !!on
		liveMode = !scrollPaused
		// 继续滚动：必须贴最新端，清掉历史 offset / 平移残留
		if (!scrollPaused) {
			view.xOffset = 0
			liveMode = true
		} else if (analysisScope !== 'selection') {
			// 暂停后窗口冻结，允许分析用当前视口重算
			if (analysisCache && analysisCache.source === 'window') {
				analysisCache = null
				analysisLastRenderKey = ''
			}
			scheduleAnalysisRefresh(true)
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
		// 长期模式无波形：关闭显示触发，避免「等待」误解
		if (recordMode === 'long' && scopeTrigMode !== 'off') {
			setScopeTrigMode('off')
		}
		const trigSel = E('blu-scope-trig')
		const trigLvl = E('blu-scope-trig-level')
		if (trigSel) trigSel.disabled = recordMode === 'long'
		if (trigLvl) trigLvl.disabled = recordMode === 'long'
		scheduleUIUpdate()
	}

	function isLogLikeY() {
		return yScaleMode === 'log' || yScaleMode === 'symlog'
	}

	/** 复位软建议状态（切换 Y 刻度 / 清空数据时） */
	function resetYScaleHintState() {
		yScaleHint = ''
		yScaleHintRatioEma = null
		yScaleHintLastValidAt = 0
		yScaleHintChangedAt = 0
		yScaleHintCandidate = ''
		yScaleHintCandidateAt = 0
		yScaleUiKey = ''
	}

	/**
	 * 把「想要的建议」经时间滞回落到 yScaleHint。
	 * - 进入：需持续 HINT_ENTER_HOLD_MS
	 * - 退出：需持续 HINT_EXIT_HOLD_MS，且已显示 ≥ HINT_MIN_SHOW_MS
	 */
	function commitYScaleHintWant(want, now) {
		if (want == null) want = ''
		if (want === yScaleHint) {
			yScaleHintCandidate = ''
			yScaleHintCandidateAt = 0
			return
		}
		// 已显示时强制最短展示，避免脉冲一闪就灭
		if (yScaleHint && want === '' && yScaleHintChangedAt > 0 &&
			(now - yScaleHintChangedAt) < HINT_MIN_SHOW_MS) {
			return
		}
		if (want !== yScaleHintCandidate) {
			yScaleHintCandidate = want
			yScaleHintCandidateAt = now
			return
		}
		const hold = want === '' ? HINT_EXIT_HOLD_MS : HINT_ENTER_HOLD_MS
		if ((now - yScaleHintCandidateAt) < hold) return
		yScaleHint = want
		yScaleHintChangedAt = now
		yScaleHintCandidate = ''
		yScaleHintCandidateAt = 0
	}

	function setYScaleMode(mode) {
		const next = (mode === 'log' || mode === 'symlog') ? mode : 'linear'
		if (next === yScaleMode) {
			syncYScaleUi()
			return
		}
		yScaleMode = next
		// 切换刻度时清空自动量程与平移/缩放，避免炸轴
		view.yZoom = 1
		view.yPanOffset = 0
		view.yMode = 'auto'
		yAxisLocked = false
		lockSnapFloorUA = null
		lockSnapLinthreshUA = null
		resetYScaleHintState()
		if (next === 'symlog') symlogLinthreshUA = SYMLOG_LINTHRESH_DEFAULT_UA
		if (next === 'log') logFloorUA = LOG_FLOOR_DEFAULT_UA
		resetYAuto()
		syncYScaleUi()
		scheduleUIUpdate()
	}

	// Lock 时一并冻结的映射参数（避免 span 锁住但 floor/linthresh 仍变 → 曲线漂移）
	let lockSnapFloorUA = null
	let lockSnapLinthreshUA = null
	let yScaleUiKey = ''

	/** 把当前可见 Y 映射域（含 zoom/pan）烘焙进 auto disp，并清零 zoom/pan */
	function bakeVisibleYRangeToLock() {
		let mapMin = null
		let mapMax = null
		if (plotLayout && isFinite(plotLayout.yMin) && isFinite(plotLayout.yMax)) {
			mapMin = plotLayout.yMin
			mapMax = plotLayout.yMax
		} else if (yAutoDispMin != null && yAutoDispMax != null) {
			mapMin = yAutoDispMin
			mapMax = yAutoDispMax
			if (view.yZoom !== 1) {
				const mid = (mapMin + mapMax) / 2
				const half = (mapMax - mapMin) / 2 / view.yZoom
				mapMin = mid - half
				mapMax = mid + half
			}
			if (view.yPanOffset) {
				mapMin += view.yPanOffset
				mapMax += view.yPanOffset
			}
		}
		if (mapMin == null || mapMax == null || !(mapMax > mapMin)) return false
		yAutoTargetMin = mapMin
		yAutoTargetMax = mapMax
		yAutoDispMin = mapMin
		yAutoDispMax = mapMax
		view.yZoom = 1
		view.yPanOffset = 0
		return true
	}

	function setYAxisLocked(on) {
		const next = !!on
		if (next && !yAxisLocked) {
			// 快照映射参数 + 尽量烘焙当前可见范围（无 plotLayout 时退回 yAutoDisp*）
			lockSnapFloorUA = logFloorUA > 0 ? logFloorUA : LOG_FLOOR_DEFAULT_UA
			lockSnapLinthreshUA = symlogLinthreshUA > 0
				? symlogLinthreshUA
				: SYMLOG_LINTHRESH_DEFAULT_UA
			bakeVisibleYRangeToLock()
		}
		if (!next) {
			lockSnapFloorUA = null
			lockSnapLinthreshUA = null
			// 解锁：保留当前 yAutoDisp* 作起点，下一帧继续跟
		}
		yAxisLocked = next
		yScaleUiKey = ''
		syncYScaleUi()
		scheduleUIUpdate()
	}

	function syncYScaleUi() {
		// 脏检查：Live 每帧 paint 时避免无意义 DOM 写
		const key = yScaleMode + '|' + (yAxisLocked ? '1' : '0') + '|' + yScaleHint
		if (key === yScaleUiKey) return
		yScaleUiKey = key
		const sel = E('blu-y-scale')
		if (sel && sel.value !== yScaleMode) sel.value = yScaleMode
		// 兼容旧 checkbox（若仍存在）
		const legacy = E('blu-y-log')
		if (legacy) legacy.checked = yScaleMode === 'log'
		const lockBtn = E('blu-y-lock')
		if (lockBtn) {
			lockBtn.classList.toggle('active', yAxisLocked)
			lockBtn.setAttribute('aria-pressed', yAxisLocked ? 'true' : 'false')
			lockBtn.title = yAxisLocked
				? 'Y 轴已锁定（Live 不再自动跟范围）· 点击解锁'
				: '锁定当前 Y 范围（Live 不再自动跟）'
			const icon = lockBtn.querySelector('i')
			if (icon) icon.className = yAxisLocked ? 'bi bi-lock-fill' : 'bi bi-lock'
		}
		const hint = E('blu-y-scale-hint')
		if (hint) {
			if (yScaleHint === 'log' && yScaleMode === 'linear') {
				hint.hidden = false
				hint.textContent = '建议 Log'
				hint.title = '窗口动态范围大，对数 Y 更易看清 nA 睡眠与 mA 脉冲'
				hint.dataset.action = 'log'
			} else if (yScaleHint === 'linear' && isLogLikeY()) {
				hint.hidden = false
				hint.textContent = '建议线性'
				hint.title = '窗口动态范围较小，线性 Y 通常更易读'
				hint.dataset.action = 'linear'
			} else {
				hint.hidden = true
				hint.textContent = ''
				hint.dataset.action = ''
			}
		}
	}

	/** @deprecated 兼容旧调用；请用 setYScaleMode */
	function setYAxisLog(on) {
		setYScaleMode(on ? 'log' : 'linear')
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
			setStatus('已连接', true)
			bluLog('设备已打开（USB CDC）', 'success')
			modifiersOk = false
			// 打开前不显示电压；识别后由 get_modifiers 回填设备 VDD
			clearVoltageUi()
			bluReadLoop()
			await new Promise(function (r) { setTimeout(r, 80) })
			// 对照 example_auto：get_modifiers →（用户设压/上电）→ start
			await fetchAndApplyModifiers()
			scheduleUIUpdate()
		} catch (e) {
			bluOpen = false
			clearVoltageUi()
			setStatus('打开失败', false)
			bluLog('打开失败：' + (e.message || e), 'error')
		} finally {
			bluOpening = false
		}
	}

	async function bluClosePort(opts) {
		opts = opts || {}
		if (opts.manual !== false) bluManualClose = true
		// 采样中关闭：先 AVERAGE_STOP 停采，再关串口；不改上下电、不改电压
		if (bluSampling) {
			try {
				await stopSampling()
			} catch (e) {
				// 停采失败仍继续关口，避免卡在「采样中」
				bluSampling = false
				dropSampleStream = true
				stopStallWatch()
				updateSampleBtn()
				try {
					if (bluOpen) await bluWrite(PROTO.cmdAverageStop(), 'AVERAGE_STOP')
				} catch (e2) {}
				try { parser.reset() } catch (e3) {}
				releaseWakeLock()
			}
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
		releaseWakeLock()
		// 关闭后清空电压显示，下次打开再从设备读取
		clearVoltageUi()
		// 手动点「关闭」：不碰 DUT 上下电 UI（设备侧供电状态仍由用户控制）
		// 意外断开：连接已失，复位上电按钮避免误显示
		if (opts.manual === false) markPowered(false)
		if (opts.manual !== false) bluLog('设备已关闭')
		scheduleUIUpdate()
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

		// 非采样或排空窗口：读循环仍消费串口字节，但不解析/入库/刷新瞬时值
		// 对照 API stop_measuring 后 get_data 丢弃、start 前 while get_data 抽空
		if (!bluSampling || dropSampleStream) {
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
			if (!isFinite(iUA)) continue
			latestCurrentUA = iUA
			// 显示用慢 EMA，避免大数字狂跳
			if (!dispInit) {
				dispCurrentUA = iUA
				dispInit = true
			} else {
				dispCurrentUA = dispCurrentUA * 0.92 + iUA * 0.08
			}

			const outs = rateAdj.push(iUA, tMs)
			for (let k = 0; k < outs.length; k++) {
				const o = outs[k]
				if (warmupLeft > 0) {
					warmupLeft--
					// 预热阶段也推进启动沿状态机，避免预热结束瞬间假沿
					if (!acqTrigStoreEnabled && acqTrigStart !== 'off') {
						feedAcqEdgeState(o.iUA, 'start')
					}
					continue
				}
				// 沿启动：未命中前不入库（设备已 START，只是门控存储）
				if (!acqTrigStoreEnabled) {
					if (acqTrigStart === 'off') {
						acqTrigStoreEnabled = true
					} else if (feedAcqEdgeState(o.iUA, 'start')) {
						acqTrigStoreEnabled = true
						acqTrigStartLatched = true
						acqTrigStopState = 0 // 启动后重新 seed 停沿
						bluLog('沿触发：开始入库（' + acqEdgeLabel(acqTrigStart) +
							' @ ' + fmtCurrent(o.iUA) + '）', 'success')
						updateSampleBtn()
					} else {
						continue
					}
				}
				ingestStored(o.tMs, o.iUA)
				stored++
				// 沿停止：命中后批末异步 STOP（避免在读循环里 await）
				if (acqTrigStop !== 'off' && !acqTrigStopPending &&
					feedAcqEdgeState(o.iUA, 'stop')) {
					acqTrigStopPending = true
					bluLog('沿触发：停止采样（' + acqEdgeLabel(acqTrigStop) +
						' @ ' + fmtCurrent(o.iUA) + '）', 'success')
				}
			}
		}

		if (acqTrigStopPending && bluSampling) {
			acqTrigStopPending = false
			stopSampling()
		}

		// 暂停滚动：新样本入库后钉住历史视口（顺序存储，旧下标不左移）
		// 显示触发激活且已锁定时由 getViewRange 钉触发点，不再累加 xOffset
		if (bluSampling && stored > 0 && scrollPaused &&
			!(scopeTrigMode !== 'off' && scopeTrigLockLi != null && !scopeTrigUserOverride)) {
			const maxOff = Math.max(0, dataCount() - 1)
			if (drag && drag.liAnchor != null) {
				// 跟手：用当前指针位置重算视口，使抓取点仍在指针下
				if (typeof drag.lastX === 'number') {
					panViewSoLiAtPixel(drag.liAnchor, drag.lastX)
				}
			} else {
				view.xOffset = Math.min(maxOff, view.xOffset + stored)
			}
		}

		// 示波器显示触发：扫描本批新点，命中则钉视口
		if (stored > 0 && scopeTrigMode !== 'off' && recordMode === 'wave') {
			const n = dataCount()
			const from = Math.max(1, n - stored)
			scanScopeTrigger(from, n - 1)
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
		// 丢弃 NaN/Inf，防止 Y 轴与路径偶发崩坏
		if (!isFinite(iUA) || !isFinite(tMs)) return
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
		if (!ringPush(iUA)) {
			// RAM/磁盘触顶：已触发停采，本点不入库
			return
		}
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

	/** 当前采样周期下，X 轴允许的最小 xZoom（视口最宽 ≈ MAX_VIEW_DURATION_SEC） */
	function xZoomMin() {
		const period = samplePeriodSec > 0 ? samplePeriodSec : (1 / Math.max(1, targetRateHz))
		const maxPts = Math.max(DEFAULT_VIEW_POINTS, Math.ceil(MAX_VIEW_DURATION_SEC / period))
		return Math.max(X_ZOOM_MIN_HARD, DEFAULT_VIEW_POINTS / maxPts)
	}

	function clampXZoom(z) {
		return Math.max(xZoomMin(), Math.min(X_ZOOM_MAX, z))
	}

	function currentViewPts() {
		const n = Math.max(2, dataCount())
		let viewPts = Math.max(MIN_VIEW_POINTS, Math.round(DEFAULT_VIEW_POINTS / view.xZoom))
		return Math.min(n, viewPts)
	}

	function isScopeTrigViewLocked() {
		// 拖动跟手中不强制钉视口；用户平移后 override 直到下次触发
		return scopeTrigMode !== 'off' &&
			scopeTrigLockLi != null &&
			!scopeTrigUserOverride &&
			!(drag && drag.moved)
	}

	function getViewRange() {
		const n = ringCount
		if (n < 2) return { start: 0, end: 0, count: 0 }
		const viewPts = currentViewPts()
		// 示波器显示触发：把触发点钉在视口固定水平位置
		if (isScopeTrigViewLocked()) {
			const pre = Math.max(0, Math.min(viewPts - 1, Math.round(viewPts * SCOPE_TRIG_POS_FRAC)))
			let start = scopeTrigLockLi - pre
			let end = start + viewPts - 1
			if (start < 0) {
				start = 0
				end = Math.min(n - 1, viewPts - 1)
			}
			if (end >= n) {
				end = n - 1
				start = Math.max(0, end - viewPts + 1)
			}
			if (end < start) end = start
			view.xOffset = Math.max(0, n - 1 - end)
			return { start: start, end: end, count: end - start + 1 }
		}
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

	/** 自动触发电平：近期窗口 min/max 中点（µA） */
	function getScopeTrigLevelUA() {
		if (!scopeTrigLevelAuto && scopeTrigLevelUA != null && isFinite(scopeTrigLevelUA)) {
			return scopeTrigLevelUA
		}
		const n = ringCount
		if (n < 2) return scopeTrigLevelUA != null && isFinite(scopeTrigLevelUA) ? scopeTrigLevelUA : 0
		const win = Math.min(n, Math.max(currentViewPts() * 4, 2000))
		const mm = rangeMinMax(n - win, n - 1)
		if (!mm) return 0
		const thr = (mm.min + mm.max) * 0.5
		scopeTrigLevelUA = thr // 供 UI 只读展示
		return thr
	}

	function getScopeTrigHyst(thr) {
		const n = ringCount
		const win = Math.min(n, Math.max(currentViewPts() * 2, 1000))
		const mm = n >= 2 ? rangeMinMax(n - win, n - 1) : null
		if (mm) {
			const span = Math.abs(mm.max - mm.min)
			return Math.max(span * 0.03, Math.abs(thr) * 0.01, 1e-9)
		}
		return Math.max(Math.abs(thr) * 0.05, 1e-9)
	}

	function getScopeHoldoffPts() {
		if (scopeTrigPeriodPts != null && scopeTrigPeriodPts > 4) {
			return Math.max(SCOPE_TRIG_HOLDOFF_MIN_PTS, Math.floor(scopeTrigPeriodPts * 0.55))
		}
		return Math.max(SCOPE_TRIG_HOLDOFF_MIN_PTS, Math.floor(currentViewPts() * 0.05))
	}

	/**
	 * 在 [from,to] 扫描边沿；命中则更新 scopeTrigLockLi。
	 * 跨批保持 scopeTrigState 滞回，降低噪声假触发。
	 */
	function scanScopeTrigger(from, to) {
		if (scopeTrigMode === 'off' || recordMode !== 'wave') return
		const n = ringCount
		if (n < 3) return
		let scanLo = Math.max(1, from | 0)
		let scanHi = Math.min(n - 1, to | 0)
		if (scanHi < scanLo) return
		// 边沿检测必须逐步；超长区间只扫尾部，避免漏沿 + 卡 UI
		let truncated = false
		if (scanHi - scanLo + 1 > SCOPE_TRIG_SCAN_MAX) {
			scanLo = scanHi - SCOPE_TRIG_SCAN_MAX + 1
			truncated = true
		}

		const thr = getScopeTrigLevelUA()
		const hyst = getScopeTrigHyst(thr)
		const thrHi = thr + hyst
		const thrLo = thr - hyst
		// 截断后批前 state 已过期，必须用扫窗前一点重 seed，防假沿
		let state = truncated ? 0 : scopeTrigState
		if (state === 0) {
			const v0 = ringIAt(Math.max(0, scanLo - 1))
			if (isFinite(v0)) {
				if (v0 >= thrHi) state = 1
				else if (v0 <= thrLo) state = -1
			}
		}
		const holdoff = getScopeHoldoffPts()
		let fired = null
		for (let i = scanLo; i <= scanHi; i++) {
			const v = ringIAt(i)
			if (!isFinite(v)) continue
			let edge = null
			if (state <= 0 && v >= thrHi) {
				edge = 'rise'
				state = 1
			} else if (state >= 0 && v <= thrLo) {
				edge = 'fall'
				state = -1
			} else if (state === 0) {
				if (v >= thrHi) state = 1
				else if (v <= thrLo) state = -1
			}
			if (!edge) continue
			if (scopeTrigMode === 'rise' && edge !== 'rise') continue
			if (scopeTrigMode === 'fall' && edge !== 'fall') continue
			if (scopeTrigLastLi != null && (i - scopeTrigLastLi) < holdoff) continue
			fired = i
			// 继续扫到本批最后一个合格沿，钉住最新周期（示波器连续触发）
		}
		scopeTrigState = state
		if (fired == null) return

		if (scopeTrigLastLi != null) {
			const dp = fired - scopeTrigLastLi
			if (dp > 4) {
				scopeTrigPeriodPts = scopeTrigPeriodPts == null
					? dp
					: (scopeTrigPeriodPts * 0.65 + dp * 0.35)
			}
		}
		scopeTrigLastLi = fired
		scopeTrigLockLi = fired
		scopeTrigUserOverride = false
		// 退出 Live 滚动，由 getViewRange 钉触发点
		liveMode = false
	}

	function resetScopeTriggerState() {
		scopeTrigState = 0
		scopeTrigLockLi = null
		scopeTrigLastLi = null
		scopeTrigPeriodPts = null
		scopeTrigUserOverride = false
		scopeTrigUiKey = ''
	}

	/** 用户主动改视口（平移/minimap/跳转/缩放到选择）时暂时放开触发钉住 */
	function beginScopeTrigUserOverride() {
		if (scopeTrigMode === 'off') return
		scopeTrigUserOverride = true
	}

	/** 在已有缓冲上按当前模式重扫并尽量钉住 */
	function rescanScopeTriggerRecent() {
		if (scopeTrigMode === 'off' || recordMode !== 'wave' || ringCount < 10) return
		scopeTrigLastLi = null
		scopeTrigLockLi = null
		scopeTrigPeriodPts = null
		scopeTrigState = 0
		scopeTrigUserOverride = false
		const from = Math.max(1, ringCount - Math.max(currentViewPts() * 3, 4000))
		scanScopeTrigger(from, ringCount - 1)
	}

	function setScopeTrigMode(mode) {
		const next = (mode === 'rise' || mode === 'fall' || mode === 'either') ? mode : 'off'
		if (next === scopeTrigMode) {
			syncScopeTrigUi()
			return
		}
		scopeTrigMode = next
		resetScopeTriggerState()
		if (next === 'off') {
			// 回到 Live（若用户未手动暂停）
			if (!scrollPaused) {
				liveMode = true
				view.xOffset = 0
			}
		} else if (recordMode === 'long') {
			// 长期模式无波形可钉
			scopeTrigMode = 'off'
			bluLog('长期统计模式不支持显示触发', 'warn')
		} else {
			// 开启：先扫近期数据，尽快钉住；未命中则保持当前/Live 直到新沿
			rescanScopeTriggerRecent()
			if (scopeTrigLockLi == null && !scrollPaused) {
				// 等待触发期间仍 Live，便于看到信号
				liveMode = true
			}
		}
		syncScopeTrigUi()
		scheduleUIUpdate()
	}

	function setScopeTrigLevelFromInput(raw) {
		const s = (raw == null ? '' : String(raw)).trim()
		if (!s) {
			scopeTrigLevelAuto = true
			scopeTrigLevelUA = null
			scopeTrigState = 0
			if (scopeTrigMode !== 'off') rescanScopeTriggerRecent()
			syncScopeTrigUi()
			scheduleUIUpdate()
			return
		}
		// 支持 1.2 / 1.2mA / 500uA / 500µA / 1nA
		let m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(nA|uA|µA|mA|A)?$/i)
		if (!m) {
			bluLog('触发电平格式无效（示例：100、1.5mA、200uA）', 'warn')
			syncScopeTrigUi()
			return
		}
		let v = parseFloat(m[1])
		const unit = (m[2] || 'uA').toLowerCase()
		if (unit === 'a') v *= 1e6
		else if (unit === 'ma') v *= 1e3
		else if (unit === 'na') v *= 1e-3
		// uA / µA：已是 µA
		if (!isFinite(v)) {
			bluLog('触发电平数值无效', 'warn')
			return
		}
		scopeTrigLevelAuto = false
		scopeTrigLevelUA = v
		// 重扫近期以新电平对齐（并清 override）
		if (scopeTrigMode !== 'off') rescanScopeTriggerRecent()
		else scopeTrigState = 0
		syncScopeTrigUi()
		scheduleUIUpdate()
	}

	function syncScopeTrigUi() {
		const thrKey = (scopeTrigLevelUA != null && isFinite(scopeTrigLevelUA))
			? scopeTrigLevelUA.toPrecision(4)
			: ''
		const key = scopeTrigMode + '|' + (scopeTrigLevelAuto ? 'a' : 'm') + '|' + thrKey
		if (key === scopeTrigUiKey) return
		scopeTrigUiKey = key
		const sel = E('blu-scope-trig')
		if (sel && sel.value !== scopeTrigMode) sel.value = scopeTrigMode
		const inp = E('blu-scope-trig-level')
		if (inp && document.activeElement !== inp) {
			if (scopeTrigLevelAuto) {
				inp.value = ''
				inp.placeholder = thrKey
					? ('Auto ' + fmtCurrent(scopeTrigLevelUA))
					: 'Auto µA'
			} else {
				inp.value = String(scopeTrigLevelUA)
				inp.placeholder = 'µA'
			}
		}
		const grp = E('blu-scope-trig-group')
		if (grp) grp.classList.toggle('is-active', scopeTrigMode !== 'off')
	}

	/** 采样沿电平：手动 / 已入库窗口 Auto / 等待期 pre-range Auto */
	function getAcqTrigLevelUA(iUA) {
		if (!scopeTrigLevelAuto && scopeTrigLevelUA != null && isFinite(scopeTrigLevelUA)) {
			return scopeTrigLevelUA
		}
		if (ringCount >= 8) return getScopeTrigLevelUA()
		// 等启动沿：用尚未入库的 pre min/max 估中点
		if (isFinite(acqPreMin) && isFinite(acqPreMax) && acqPreMax > acqPreMin) {
			const thr = (acqPreMin + acqPreMax) * 0.5
			scopeTrigLevelUA = thr
			return thr
		}
		if (isFinite(iUA)) return iUA // 冷启动退化
		return 0
	}

	/**
	 * 采样沿状态机（逐点）。kind: 'start' | 'stop'
	 * 返回 true 表示本点产生了匹配边沿。
	 * 电平复用显示触发的手动值，或 Auto（窗口 / 等待期 pre-range）。
	 */
	function feedAcqEdgeState(iUA, kind) {
		if (!isFinite(iUA)) return false
		const mode = kind === 'stop' ? acqTrigStop : acqTrigStart
		if (mode === 'off') return false
		// 等待入库阶段累计 pre-range，供 Auto 电平
		if (!acqTrigStoreEnabled) {
			if (iUA < acqPreMin) acqPreMin = iUA
			if (iUA > acqPreMax) acqPreMax = iUA
		}
		const thr = getAcqTrigLevelUA(iUA)
		// 无波形缓冲时用相对滞回；有数据时用窗口 span
		let hyst
		if (ringCount >= 8) {
			hyst = getScopeTrigHyst(thr)
		} else if (isFinite(acqPreMin) && acqPreMax > acqPreMin) {
			hyst = Math.max((acqPreMax - acqPreMin) * 0.05, Math.abs(thr) * 0.02, 1e-6)
		} else {
			hyst = Math.max(Math.abs(thr) * 0.05, Math.abs(iUA) * 0.03, 1e-6)
		}
		const thrHi = thr + hyst
		const thrLo = thr - hyst
		let state = kind === 'stop' ? acqTrigStopState : acqTrigStartState
		let edge = null
		// unknown 只 seed、不产生沿，避免启动瞬间/停沿复位时「已在高电平」假触发
		if (state === 0) {
			if (iUA >= thrHi) state = 1
			else if (iUA <= thrLo) state = -1
		} else if (state < 0 && iUA >= thrHi) {
			edge = 'rise'
			state = 1
		} else if (state > 0 && iUA <= thrLo) {
			edge = 'fall'
			state = -1
		}
		if (kind === 'stop') acqTrigStopState = state
		else acqTrigStartState = state
		if (!edge) return false
		if (mode === 'rise' && edge !== 'rise') return false
		if (mode === 'fall' && edge !== 'fall') return false
		// either：rise/fall 均可
		// 配置了启动沿但尚未命中启动：忽略停沿
		if (kind === 'stop' && acqTrigStart !== 'off' && !acqTrigStartLatched) {
			return false
		}
		return true
	}

	function setAcqTrigStart(mode) {
		const next = (mode === 'rise' || mode === 'fall' || mode === 'either') ? mode : 'off'
		acqTrigStart = next
		// 采样中途改「启动沿」只影响下次；停沿可热改
		if (!bluSampling) {
			acqTrigStoreEnabled = true
			acqTrigStartState = 0
		}
		syncAcqTrigUi()
		updateSampleBtn()
	}

	function setAcqTrigStop(mode) {
		const next = (mode === 'rise' || mode === 'fall' || mode === 'either') ? mode : 'off'
		acqTrigStop = next
		if (bluSampling) acqTrigStopState = 0
		syncAcqTrigUi()
		updateSampleBtn()
	}

	function syncAcqTrigUi() {
		const key = acqTrigStart + '|' + acqTrigStop + '|' +
			(bluSampling ? (acqTrigStoreEnabled ? 'r' : 'w') : '0')
		if (key === acqTrigUiKey) return
		acqTrigUiKey = key
		const elS = E('blu-acq-trig-start')
		if (elS && elS.value !== acqTrigStart) elS.value = acqTrigStart
		const elT = E('blu-acq-trig-stop')
		if (elT && elT.value !== acqTrigStop) elT.value = acqTrigStop
		const grp = E('blu-acq-trig-group')
		if (grp) {
			grp.classList.toggle('is-active', acqTrigStart !== 'off' || acqTrigStop !== 'off')
			grp.classList.toggle('is-waiting', bluSampling && !acqTrigStoreEnabled)
		}
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

	/** 区间 min/max（有限点）；失败返回 null */
	function rangeMinMax(lo, hi) {
		lo = Math.max(0, Math.min(ringCount - 1, lo | 0))
		hi = Math.max(0, Math.min(ringCount - 1, hi | 0))
		if (hi < lo) return null
		// 优先块级统计
		const st = calcStats(lo, hi + 1)
		if (st && st.n && isFinite(st.minI) && isFinite(st.maxI)) {
			return { min: st.minI, max: st.maxI }
		}
		return null
	}

	function edgeThreshold(lo, hi) {
		const mm = rangeMinMax(lo, hi)
		if (!mm) return 0
		return (mm.min + mm.max) * 0.5
	}

	function edgeHysteresis(lo, hi) {
		const mm = rangeMinMax(lo, hi)
		if (!mm) return 0
		const span = Math.abs(mm.max - mm.min)
		return Math.max(span * 0.02, Math.abs(mm.min + mm.max) * 0.005, 1e-9)
	}

	/**
	 * 在 [searchLo, searchHi] 内找离 want 最近的边沿下标。
	 * kind: 'rise' | 'fall' | 'either'
	 * 带滞回，降低噪声假触发；测频/吸附都不走 FFT。
	 */
	function findNearestEdge(want, kind, searchLo, searchHi) {
		if (ringCount < 3) return clampLogical(want)
		want = clampLogical(want)
		if (want == null) return null
		searchLo = Math.max(1, searchLo == null ? 0 : searchLo | 0)
		searchHi = Math.min(ringCount - 1, searchHi == null ? ringCount - 1 : searchHi | 0)
		if (searchHi - searchLo < 2) return want

		const thr = edgeThreshold(searchLo, searchHi)
		const hyst = edgeHysteresis(searchLo, searchHi)
		const thrHi = thr + hyst
		const thrLo = thr - hyst

		let best = null
		let bestDist = Infinity
		let state = 0 // -1 below, 1 above, 0 unknown
		const v0 = ringIAt(searchLo)
		if (isFinite(v0)) {
			if (v0 >= thrHi) state = 1
			else if (v0 <= thrLo) state = -1
		}
		const maxScan = Math.min(EDGE_SEARCH_MAX, searchHi - searchLo + 1)
		const step = Math.max(1, Math.ceil((searchHi - searchLo + 1) / maxScan))
		for (let i = searchLo + step; i <= searchHi; i += step) {
			const v = ringIAt(i)
			if (!isFinite(v)) continue
			let edge = null
			if (state <= 0 && v >= thrHi) {
				edge = 'rise'
				state = 1
			} else if (state >= 0 && v <= thrLo) {
				edge = 'fall'
				state = -1
			} else if (state === 0) {
				if (v >= thrHi) state = 1
				else if (v <= thrLo) state = -1
			}
			if (!edge) continue
			if (kind === 'rise' && edge !== 'rise') continue
			if (kind === 'fall' && edge !== 'fall') continue
			const d = Math.abs(i - want)
			if (d < bestDist) {
				bestDist = d
				best = i
			}
		}
		return best != null ? best : want
	}

	function snapLogicalToEdge(li) {
		li = clampLogical(li)
		if (li == null || cursorSnapMode === 'free') return li
		const kind = cursorSnapMode === 'rise' ? 'rise'
			: cursorSnapMode === 'fall' ? 'fall' : 'either'
		// 优先在当前视口内找沿，找不到再扩大到全数据
		const vr = getViewRange()
		let found = findNearestEdge(li, kind, vr.start, vr.end)
		if (found === li && ringCount > vr.count) {
			found = findNearestEdge(li, kind, 0, ringCount - 1)
		}
		return found
	}

	/**
	 * 选择区间内按上升沿估计周期/频率（时域边沿，非频谱 FFT）。
	 * 返回 { nRise, nFall, periodSec, freqHz, duty, deltaI, thr }
	 */
	function measureSelectionTiming(a, b) {
		const out = {
			nRise: 0, nFall: 0,
			periodSec: null, freqHz: null, duty: null,
			deltaI: null, thr: null, nPeriod: 0,
		}
		if (a == null || b == null || b <= a || ringCount < 3) return out
		const ia = ringIAt(a)
		const ib = ringIAt(b)
		if (isFinite(ia) && isFinite(ib)) out.deltaI = ib - ia

		const thr = edgeThreshold(a, b)
		const hyst = edgeHysteresis(a, b)
		out.thr = thr
		const thrHi = thr + hyst
		const thrLo = thr - hyst
		const rises = []
		const falls = []
		let state = 0
		const v0 = ringIAt(a)
		if (isFinite(v0)) {
			if (v0 >= thrHi) state = 1
			else if (v0 <= thrLo) state = -1
		}
		const span = b - a
		const step = span > EDGE_SEARCH_MAX ? Math.ceil(span / EDGE_SEARCH_MAX) : 1
		for (let i = a + step; i <= b; i += step) {
			const v = ringIAt(i)
			if (!isFinite(v)) continue
			if (state <= 0 && v >= thrHi) {
				rises.push(i)
				state = 1
			} else if (state >= 0 && v <= thrLo) {
				falls.push(i)
				state = -1
			} else if (state === 0) {
				if (v >= thrHi) state = 1
				else if (v <= thrLo) state = -1
			}
		}
		out.nRise = rises.length
		out.nFall = falls.length
		if (rises.length >= 2 && samplePeriodSec > 0) {
			let sumP = 0
			let nP = 0
			for (let k = 1; k < rises.length; k++) {
				const dp = rises[k] - rises[k - 1]
				if (dp > 0) {
					sumP += dp
					nP++
				}
			}
			if (nP > 0) {
				const periodPts = sumP / nP
				out.periodSec = periodPts * samplePeriodSec
				out.freqHz = out.periodSec > 0 ? (1 / out.periodSec) : null
				out.nPeriod = nP
				// 占空比：相邻上升沿内高电平时间
				if (falls.length && rises.length >= 2) {
					let sumDuty = 0
					let nD = 0
					for (let k = 0; k < rises.length - 1; k++) {
						const r0 = rises[k]
						const r1 = rises[k + 1]
						let f = null
						for (let j = 0; j < falls.length; j++) {
							if (falls[j] > r0 && falls[j] < r1) { f = falls[j]; break }
						}
						if (f != null && r1 > r0) {
							sumDuty += (f - r0) / (r1 - r0)
							nD++
						}
					}
					if (nD > 0) out.duty = sumDuty / nD
				}
			}
		}
		return out
	}

	function fmtFreq(hz) {
		if (hz == null || !isFinite(hz) || hz <= 0) return '--'
		if (hz >= 1e6) return (hz / 1e6).toFixed(3) + ' MHz'
		if (hz >= 1e3) return (hz / 1e3).toFixed(3) + ' kHz'
		if (hz >= 1) return hz.toFixed(3) + ' Hz'
		if (hz >= 1e-3) return (hz * 1e3).toFixed(3) + ' mHz'
		return hz.toExponential(2) + ' Hz'
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

	/**
	 * 从逻辑下标 [a,b] 抽取样点（可均匀抽稀）。
	 * 返回 { samples, step, rateHz, a, b, nRaw, periodSec }
	 */
	function extractRangeSamples(a, b, maxPts) {
		a = clampLogical(a)
		b = clampLogical(b)
		if (a == null || b == null) return null
		if (a > b) { const t = a; a = b; b = t }
		const nRaw = b - a + 1
		if (nRaw < 1) return null
		maxPts = maxPts != null ? maxPts : ANALYSIS_MAX_SAMPLES
		const step = nRaw > maxPts ? Math.ceil(nRaw / maxPts) : 1
		const nOut = Math.floor((nRaw - 1) / step) + 1
		const samples = new Float32Array(nOut)
		let j = 0
		for (let li = a; li <= b; li += step) {
			const v = ringIAt(li)
			samples[j++] = isFinite(v) ? v : 0
		}
		const baseHz = samplePeriodSec > 0 ? (1 / samplePeriodSec) : targetRateHz
		return {
			samples: samples,
			step: step,
			rateHz: baseHz / step,
			inputRateHz: baseHz,
			a: a,
			b: b,
			nRaw: nRaw,
			periodSec: samplePeriodSec * step,
			samplePeriodSec: samplePeriodSec,
		}
	}

	/** 跳到逻辑下标并暂停 Live，可选设为选择中心 */
	function jumpToLogical(li, opts) {
		opts = opts || {}
		li = clampLogical(li)
		if (li == null || ringCount < 2) return
		beginScopeTrigUserOverride()
		setScrollPaused(true)
		liveMode = false
		let viewPts = Math.max(MIN_VIEW_POINTS, Math.round(DEFAULT_VIEW_POINTS / view.xZoom))
		viewPts = Math.min(ringCount, viewPts)
		if (opts.viewPts) viewPts = Math.min(ringCount, Math.max(MIN_VIEW_POINTS, opts.viewPts | 0))
		const half = Math.floor(viewPts / 2)
		let end = Math.min(ringCount - 1, li + half)
		let start = end - viewPts + 1
		if (start < 0) {
			start = 0
			end = Math.min(ringCount - 1, start + viewPts - 1)
		}
		view.xOffset = Math.max(0, ringCount - 1 - end)
		if (opts.selectSpan && opts.selectSpan > 0) {
			const halfSel = Math.floor(opts.selectSpan / 2)
			view.cursorA = Math.max(0, li - halfSel)
			view.cursorB = Math.min(ringCount - 1, li + halfSel)
		} else if (opts.setCursor) {
			view.cursorA = li
			if (view.cursorB == null) view.cursorB = li
		}
		updateCursorInfo()
		scheduleUIUpdate()
	}

	/**
	 * 分析区间：selection | window | auto（有选择用选择，否则窗口）
	 * 返回 { a, b, source } 或 null
	 */
	function getAnalysisRange() {
		if (recordMode !== 'wave' || ringCount < 2) return null
		const sel = getSelectionRange()
		if (analysisScope === 'selection') {
			return sel ? { a: sel.a, b: sel.b, source: 'selection' } : null
		}
		if (analysisScope === 'window') {
			const vr = getViewRange()
			if (vr.count < 2) return null
			return { a: vr.start, b: vr.end, source: 'window' }
		}
		// auto
		if (sel) return { a: sel.a, b: sel.b, source: 'selection' }
		const vr = getViewRange()
		if (vr.count < 2) return null
		return { a: vr.start, b: vr.end, source: 'window' }
	}

	function analysisSourceLabel(src) {
		if (src === 'selection') return '选择'
		if (src === 'window') return '窗口'
		return src || '--'
	}

	function analysisCacheKey(a, b, source) {
		return (source || '') + '|' + a + '|' + b + '|' + samplePeriodSec + '|' + (setVoltageMv || '')
	}

	function scheduleAnalysisRefresh(force) {
		if (analysisCollapsed && !force) return
		if (analysisTimer) clearTimeout(analysisTimer)
		analysisTimer = setTimeout(function () {
			analysisTimer = null
			refreshAnalysis(force)
		}, ANALYSIS_DEBOUNCE_MS)
	}

	function syncAnalysisScopeHint(pack) {
		const el = E('blu-analysis-scope-hint')
		if (!el) return
		if (!pack) {
			el.textContent = analysisScope === 'selection' ? '无选择' : '无区间'
			return
		}
		el.textContent = analysisSourceLabel(pack.source) + ' · ' +
			fmtDuration((pack.b - pack.a) * samplePeriodSec)
	}

	function getOrBuildAnalysisPack(force) {
		const range = getAnalysisRange()
		if (!range) {
			// Live 窗口滚动态：保留上一份 window 缓存，避免半空
			if (!force && analysisCache && analysisCache.source === 'window' &&
				analysisScope !== 'selection' && !scrollPaused) {
				return analysisCache
			}
			// 选择模式无框选：丢弃旧缓存，避免显示过期区间
			if (analysisScope === 'selection') analysisCache = null
			syncAnalysisScopeHint(null)
			return null
		}
		// Live 贴最新端时窗口端点一直动：非强制且未暂停则沿用缓存，避免 60fps 重算
		if (range.source === 'window' && !scrollPaused && !force &&
			analysisCache && analysisCache.source === 'window') {
			return analysisCache
		}
		const key = analysisCacheKey(range.a, range.b, range.source)
		if (!force && analysisCache && analysisCache.key === key) return analysisCache
		const ext = extractRangeSamples(range.a, range.b, ANALYSIS_MAX_SAMPLES)
		if (!ext) {
			analysisCache = null
			syncAnalysisScopeHint(null)
			return null
		}
		const timing = measureSelectionTiming(range.a, range.b)
		const basic = ANAL ? ANAL.basicStats(ext.samples) : null
		const thr = timing.thr != null ? timing.thr : (basic ? (basic.min + basic.max) * 0.5 : 0)
		const levels = ANAL ? ANAL.twoLevelStats(ext.samples, thr, Math.abs(basic ? basic.pp * 0.02 : 0)) : null
		let qCycle = null
		if (timing.periodSec != null && timing.periodSec > 0 && basic && basic.n) {
			qCycle = basic.avg * timing.periodSec
		} else if (basic && basic.n && ext.nRaw > 1 && timing.nPeriod > 0) {
			const st = calcStats(range.a, range.b + 1)
			if (st && st.chargeUC != null) qCycle = st.chargeUC / timing.nPeriod
		}
		const pack = {
			key: key,
			source: range.source,
			a: range.a,
			b: range.b,
			ext: ext,
			basic: basic,
			levels: levels,
			timing: timing,
			qCycle: qCycle,
			spikes: null,
			segs: null,
			fft: null,
			cycles: null,
		}
		analysisCache = pack
		return pack
	}

	function updateReadoutPanel(pack) {
		const empty = E('blu-readout-empty')
		const body = E('blu-readout-body')
		if (!pack) {
			if (empty) empty.hidden = false
			if (body) body.hidden = true
			return
		}
		if (empty) empty.hidden = true
		if (body) body.hidden = false
		const set = function (id, t) {
			const el = E(id)
			if (el) el.textContent = t
		}
		const ia = ringIAt(pack.a)
		const ib = ringIAt(pack.b)
		const dt = (pack.b - pack.a) * samplePeriodSec
		set('blu-ro-src', analysisSourceLabel(pack.source) +
			(pack.ext && pack.ext.step > 1 ? ' · 抽稀1/' + pack.ext.step : ''))
		set('blu-ro-ab',
			fmtTimeAxis(indexToTime(pack.a)) + ' → ' + fmtTimeAxis(indexToTime(pack.b)))
		set('blu-ro-dt', fmtDuration(dt))
		set('blu-ro-iab', (isFinite(ia) ? fmtCurrent(ia) : '--') + ' / ' + (isFinite(ib) ? fmtCurrent(ib) : '--'))
		set('blu-ro-di', isFinite(ia) && isFinite(ib) ? fmtCurrent(ib - ia) : '--')
		const tm = pack.timing || {}
		set('blu-ro-freq', tm.freqHz != null ? (fmtFreq(tm.freqHz) + (tm.nPeriod ? '  n=' + tm.nPeriod : '')) : (dt > 0 ? '1/Δt ' + fmtFreq(1 / dt) : '--'))
		set('blu-ro-period', (tm.periodSec != null ? fmtDuration(tm.periodSec) : '--') +
			' / ' + (tm.duty != null ? (tm.duty * 100).toFixed(1) + '%' : (pack.levels && pack.levels.duty != null ? (pack.levels.duty * 100).toFixed(1) + '%' : '--')))
		const lv = pack.levels
		set('blu-ro-levels', (lv && lv.lowAvg != null ? fmtCurrent(lv.lowAvg) : '--') + ' / ' +
			(lv && lv.highAvg != null ? fmtCurrent(lv.highAvg) : '--'))
		const b = pack.basic
		set('blu-ro-rms', (b ? fmtCurrent(b.rms) : '--') + ' / ' + (b ? fmtCurrent(b.pp) : '--'))
		set('blu-ro-qcycle', pack.qCycle != null ? fmtCharge(pack.qCycle) : '--')
	}

	function ensureEventsInPack(pack, force) {
		if (!pack || !ANAL) return pack
		if (!force && pack.spikes && pack.segs) return pack
		const thrEl = E('blu-spike-thr')
		const minwEl = E('blu-spike-minw')
		let thr = thrEl && thrEl.value !== '' ? parseFloat(thrEl.value) : null
		if (!isFinite(thr)) thr = null
		const minW = minwEl ? Math.max(1, parseInt(minwEl.value, 10) || 2) : 2
		// thr 相对抽稀后样点；若用户输入绝对阈值则直接用
		pack.spikes = ANAL.findSpikes(pack.ext.samples, {
			thr: thr,
			minWidthPts: Math.max(1, Math.round(minW / pack.ext.step)),
			maxCount: 150,
		})
		const thrSeg = pack.timing && pack.timing.thr != null
			? pack.timing.thr
			: (pack.basic ? (pack.basic.min + pack.basic.max) * 0.5 : 0)
		pack.segs = ANAL.segmentByThreshold(pack.ext.samples, thrSeg, {
			minSegPts: 2,
			maxCount: 200,
		})
		return pack
	}

	function renderEventsPanel(pack) {
		const listSp = E('blu-spike-list')
		const listSeg = E('blu-seg-list')
		const meta = E('blu-events-meta')
		const cSp = E('blu-spike-count')
		const cSeg = E('blu-seg-count')
		if (!pack || !pack.ext) {
			if (listSp) listSp.innerHTML = '<div class="blu-analysis-empty">无可用区间</div>'
			if (listSeg) listSeg.innerHTML = '<div class="blu-analysis-empty">无可用区间</div>'
			if (meta) meta.textContent = ''
			if (cSp) cSp.textContent = '0'
			if (cSeg) cSeg.textContent = '0'
			return
		}
		ensureEventsInPack(pack, false)
		const step = pack.ext.step
		const baseA = pack.a
		const spikes = pack.spikes || []
		const segs = (pack.segs && pack.segs.segments) || []
		if (cSp) cSp.textContent = String(spikes.length)
		if (cSeg) cSeg.textContent = String(segs.length)
		if (meta) {
			meta.textContent = (pack.ext.step > 1 ? '抽稀 1/' + pack.ext.step + ' · ' : '') +
				pack.ext.samples.length + ' 点 · thr≈' +
				(pack.segs ? fmtCurrent(pack.segs.thr) : '--')
		}
		if (listSp) {
			if (!spikes.length) {
				listSp.innerHTML = '<div class="blu-analysis-empty">未检出尖峰</div>'
			} else {
				listSp.innerHTML = ''
				spikes.slice(0, 80).forEach(function (sp, idx) {
					const li = baseA + sp.peakIdx * step
					const btn = document.createElement('button')
					btn.type = 'button'
					btn.className = 'blu-event-item'
					btn.innerHTML = '<span class="blu-ev-tag">#' + (idx + 1) + '</span>' +
						'<span>' + fmtCurrent(sp.peak) + '</span>' +
						'<span class="blu-ev-meta">' + fmtDuration(sp.widthPts * pack.ext.periodSec) +
						' · t=' + fmtTimeAxis(indexToTime(li)) + '</span>'
					btn.title = '跳转到尖峰'
					btn.addEventListener('click', function () {
						jumpToLogical(li, { viewPts: Math.max(200, sp.widthPts * step * 8) })
					})
					listSp.appendChild(btn)
				})
			}
		}
		if (listSeg) {
			if (!segs.length) {
				listSeg.innerHTML = '<div class="blu-analysis-empty">无分段</div>'
			} else {
				listSeg.innerHTML = ''
				// 按电荷（|sum|）降序，便于找「最耗电段」
				const ranked = segs.slice().sort(function (a, b) {
					return Math.abs(b.sum) - Math.abs(a.sum)
				})
				ranked.slice(0, 80).forEach(function (sg, idx) {
					const li0 = baseA + sg.start * step
					const li1 = baseA + sg.end * step
					const dur = (sg.end - sg.start) * pack.ext.periodSec
					const q = ANAL.chargeFromSum(sg.sum, pack.ext.periodSec)
					const btn = document.createElement('button')
					btn.type = 'button'
					btn.className = 'blu-event-item'
					const tag = sg.kind === 'high' ? '高' : '低'
					btn.innerHTML = '<span class="blu-ev-tag ' + (sg.kind === 'high' ? 'is-high' : 'is-low') + '">' + tag + '</span>' +
						'<span>' + fmtCurrent(sg.avgI) + '</span>' +
						'<span class="blu-ev-meta">' + fmtDuration(dur) + ' · Q ' + fmtCharge(q) + '</span>'
					btn.title = '选中该段并跳转'
					btn.addEventListener('click', function () {
						view.cursorA = li0
						view.cursorB = li1
						jumpToLogical(Math.round((li0 + li1) / 2), {
							viewPts: Math.max(MIN_VIEW_POINTS, li1 - li0 + 1),
						})
					})
					listSeg.appendChild(btn)
				})
			}
		}
	}

	function ensureFftInPack(pack, force) {
		if (!pack || !ANAL) return null
		const winEl = E('blu-fft-window')
		const dcEl = E('blu-fft-remove-dc')
		const win = winEl ? winEl.value : 'hann'
		const removeDc = dcEl ? !!dcEl.checked : true
		const fkey = win + '|' + removeDc
		if (!force && pack.fft && pack.fft._fkey === fkey) return pack.fft
		const fft = ANAL.fftAnalysis(pack.ext.samples, pack.ext.rateHz, {
			window: win,
			removeDc: removeDc,
			topK: 10,
			maxNfft: 65536,
		})
		fft._fkey = fkey
		pack.fft = fft
		return fft
	}

	function drawFftCanvas(fft) {
		const canvas = E('blu-fft-canvas')
		if (!canvas) return
		const ctx = canvas.getContext('2d')
		const dpr = window.devicePixelRatio || 1
		const rect = canvas.getBoundingClientRect()
		const w = Math.max(8, rect.width)
		const h = Math.max(8, rect.height)
		canvas.width = Math.round(w * dpr)
		canvas.height = Math.round(h * dpr)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		const cs = getComputedStyle(document.documentElement)
		const bg = cs.getPropertyValue('--bg-body').trim() || '#0f172a'
		const accent = cs.getPropertyValue('--accent').trim() || '#3b82f6'
		const muted = cs.getPropertyValue('--text-muted').trim() || '#64748b'
		const border = cs.getPropertyValue('--border-color').trim() || '#334155'
		ctx.fillStyle = bg
		ctx.fillRect(0, 0, w, h)
		if (!fft || !fft.ok || !fft.mags) {
			ctx.fillStyle = muted
			ctx.font = '12px sans-serif'
			ctx.textAlign = 'center'
			ctx.fillText(fft && fft.reason ? ('FFT: ' + fft.reason) : '框选后点「计算」', w / 2, h / 2)
			return
		}
		const mags = fft.mags
		const n = mags.length
		// 跳过 DC 画交流
		let maxM = 0
		for (let i = 1; i < n; i++) if (mags[i] > maxM) maxM = mags[i]
		if (maxM <= 0) maxM = 1
		const padL = 36
		const padR = 8
		const padT = 8
		const padB = 18
		const pw = w - padL - padR
		const ph = h - padT - padB
		// 对数幅度
		const logMax = Math.log10(maxM)
		const logMin = logMax - 4
		ctx.strokeStyle = border
		ctx.lineWidth = 1
		ctx.beginPath()
		ctx.moveTo(padL, padT)
		ctx.lineTo(padL, padT + ph)
		ctx.lineTo(padL + pw, padT + ph)
		ctx.stroke()
		ctx.strokeStyle = accent
		ctx.globalAlpha = 0.9
		ctx.beginPath()
		for (let i = 1; i < n; i++) {
			const x = padL + ((i - 1) / Math.max(1, n - 2)) * pw
			const lv = Math.log10(Math.max(mags[i], 1e-18))
			const t = (lv - logMin) / (logMax - logMin)
			const y = padT + ph - Math.max(0, Math.min(1, t)) * ph
			if (i === 1) ctx.moveTo(x, y)
			else ctx.lineTo(x, y)
		}
		ctx.stroke()
		ctx.globalAlpha = 1
		// 标注 Nyquist / 主峰
		ctx.fillStyle = muted
		ctx.font = '10px sans-serif'
		ctx.textAlign = 'left'
		ctx.fillText('0', padL, h - 4)
		ctx.textAlign = 'right'
		ctx.fillText(fmtFreq(fft.nyquistHz), padL + pw, h - 4)
		if (fft.peaks && fft.peaks[0]) {
			const p0 = fft.peaks[0]
			const bi = Math.max(1, Math.min(n - 1, p0.bin || 1))
			const x = padL + ((bi - 1) / Math.max(1, n - 2)) * pw
			ctx.strokeStyle = '#f59e0b'
			ctx.setLineDash([3, 3])
			ctx.beginPath()
			ctx.moveTo(x, padT)
			ctx.lineTo(x, padT + ph)
			ctx.stroke()
			ctx.setLineDash([])
			ctx.fillStyle = '#f59e0b'
			ctx.textAlign = 'center'
			ctx.fillText(fmtFreq(p0.freqHz), x, padT + 10)
		}
	}

	function renderFftPanel(pack) {
		const meta = E('blu-fft-meta')
		const list = E('blu-fft-peak-list')
		if (!pack) {
			if (meta) meta.textContent = ''
			if (list) list.innerHTML = '<div class="blu-analysis-empty">无可用区间</div>'
			drawFftCanvas(null)
			return
		}
		const fft = ensureFftInPack(pack, false)
		if (meta) {
			if (!fft || !fft.ok) {
				meta.textContent = fft ? (fft.reason || '失败') : '—'
			} else {
				meta.textContent = 'fs=' + fmtFreq(fft.sampleRateHz) +
					' · Nyquist ' + fmtFreq(fft.nyquistHz) +
					' · Δf ' + fmtFreq(fft.binHz) +
					' · N=' + fft.nfft +
					(fft.step > 1 ? ' · 抽稀' + fft.step : '') +
					(fft.removeDc ? ' · 去DC' : '')
			}
		}
		drawFftCanvas(fft)
		if (list) {
			if (!fft || !fft.ok || !fft.peaks.length) {
				list.innerHTML = '<div class="blu-analysis-empty">无显著谱峰</div>'
			} else {
				list.innerHTML = ''
				fft.peaks.forEach(function (pk, idx) {
					const btn = document.createElement('button')
					btn.type = 'button'
					btn.className = 'blu-event-item'
					btn.innerHTML = '<span class="blu-ev-tag">#' + (idx + 1) + '</span>' +
						'<span>' + fmtFreq(pk.freqHz) + '</span>' +
						'<span class="blu-ev-meta">' + fmtCurrent(pk.magUA) +
						(pk.periodSec != null ? ' · T=' + fmtDuration(pk.periodSec) : '') + '</span>'
					btn.title = '时域缩放到约 5 个周期'
					btn.addEventListener('click', function () {
						zoomToFreqPeriod(pk.freqHz, pack)
					})
					list.appendChild(btn)
				})
			}
		}
	}

	function zoomToFreqPeriod(freqHz, pack) {
		if (!freqHz || freqHz <= 0 || !pack) return
		const periodSec = 1 / freqHz
		const periodPts = Math.max(4, Math.round(periodSec / samplePeriodSec))
		const viewPts = Math.min(ringCount, Math.max(MIN_VIEW_POINTS, periodPts * 5))
		// 视口中心：选择区中心
		const mid = Math.round((pack.a + pack.b) / 2)
		view.xZoom = clampXZoom(DEFAULT_VIEW_POINTS / viewPts)
		jumpToLogical(mid, { viewPts: viewPts })
	}

	function updateBatteryPanel() {
		const box = E('blu-bat-result')
		if (!box || !ANAL) return
		const mahEl = E('blu-bat-mah')
		const derEl = E('blu-bat-derate')
		const srcEl = E('blu-bat-src')
		const mah = mahEl ? parseFloat(mahEl.value) : NaN
		const derate = derEl ? parseFloat(derEl.value) : 0.9
		const src = srcEl ? srcEl.value : 'analysis'
		let avgI = null
		let label = ''
		if (src === 'selection') {
			const sel = getSelectionRange()
			if (sel) {
				const ext = extractRangeSamples(sel.a, sel.b, ANALYSIS_MAX_SAMPLES)
				if (ext && ANAL) {
					const basic = ANAL.basicStats(ext.samples)
					if (basic && basic.n) {
						avgI = basic.avg
						label = '选择区'
					}
				}
			}
		} else if (src === 'analysis') {
			const pack = getOrBuildAnalysisPack(false)
			if (pack && pack.basic) {
				avgI = pack.basic.avg
				label = '分析区间(' + analysisSourceLabel(pack.source) + ')'
			}
		} else if (src === 'window') {
			const vr = getViewRange()
			const st = calcStats(vr.start, vr.end + 1)
			if (st && st.n) {
				avgI = st.avgI
				label = '窗口'
			}
		} else {
			if (recordMode === 'long') {
				avgI = longStats.n ? longStats.sumI / longStats.n : null
			} else {
				const st = overallStatCache || calcStats(0, ringCount)
				if (st && st.n) avgI = st.avgI
			}
			label = '总体'
		}
		if (avgI == null || !isFinite(avgI)) {
			box.innerHTML = '<div class="blu-analysis-empty">无有效平均电流（' + label + '）</div>'
			return
		}
		const est = ANAL.estimateBatteryLife(avgI, mah, { derate: derate })
		if (!est.ok) {
			box.innerHTML = '<div class="blu-analysis-empty">无法估算：' + (est.reason || '') + '</div>'
			return
		}
		function fmtLife(days) {
			if (days >= 365) return (days / 365.25).toFixed(2) + ' 年'
			if (days >= 1) return days.toFixed(2) + ' 天'
			return (days * 24).toFixed(1) + ' 小时'
		}
		box.innerHTML =
			'<div>源：' + label + ' · I<sub>avg</sub> = <strong>' + fmtCurrent(avgI) + '</strong></div>' +
			'<div>可用 ' + est.usableMah.toFixed(3) + ' mAh（容量×' + derate + '）</div>' +
			'<div>预估续航 <strong>' + fmtLife(est.days) + '</strong>（' + est.hours.toFixed(1) + ' h）</div>'
	}

	function ensureOverlayInPack(pack, force) {
		if (!pack || !ANAL) return null
		const srcEl = E('blu-ov-src')
		const perEl = E('blu-ov-period')
		const maxEl = E('blu-ov-max')
		const src = srcEl ? srcEl.value : 'edge'
		const maxC = maxEl ? Math.max(2, Math.min(64, parseInt(maxEl.value, 10) || 24)) : 24
		let periodSec = null
		if (src === 'manual') {
			periodSec = perEl && perEl.value !== '' ? parseFloat(perEl.value) : null
		} else if (src === 'fft') {
			const fft = ensureFftInPack(pack, false)
			if (fft && fft.ok && fft.peaks[0]) periodSec = fft.peaks[0].periodSec
		} else {
			if (pack.timing && pack.timing.periodSec) periodSec = pack.timing.periodSec
		}
		if (periodSec == null || !isFinite(periodSec) || periodSec <= 0) return null
		if (perEl && src !== 'manual') perEl.placeholder = periodSec.toFixed(6)
		const periodPtsRaw = Math.max(4, Math.round(periodSec / samplePeriodSec))
		// 叠画用未抽稀提取（限长度）
		const maxRaw = periodPtsRaw * maxC
		const extFull = extractRangeSamples(pack.a, pack.b, Math.min(ANALYSIS_MAX_SAMPLES, maxRaw))
		if (!extFull) return null
		const periodPts = Math.max(4, Math.round(periodSec / extFull.periodSec))
		const okey = src + '|' + periodPts + '|' + maxC + '|' + pack.key
		if (!force && pack.cycles && pack.cycles._okey === okey) return pack.cycles
		const cycles = ANAL.extractCycles(extFull.samples, periodPts, maxC)
		cycles._okey = okey
		cycles._periodSec = periodSec
		cycles._rateHz = extFull.rateHz
		pack.cycles = cycles
		return cycles
	}

	function drawOverlayCanvas(cycles) {
		const canvas = E('blu-ov-canvas')
		if (!canvas) return
		const ctx = canvas.getContext('2d')
		const dpr = window.devicePixelRatio || 1
		const rect = canvas.getBoundingClientRect()
		const w = Math.max(8, rect.width)
		const h = Math.max(8, rect.height)
		canvas.width = Math.round(w * dpr)
		canvas.height = Math.round(h * dpr)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		const cs = getComputedStyle(document.documentElement)
		const bg = cs.getPropertyValue('--bg-body').trim() || '#0f172a'
		const accent = cs.getPropertyValue('--accent').trim() || '#3b82f6'
		const muted = cs.getPropertyValue('--text-muted').trim() || '#64748b'
		ctx.fillStyle = bg
		ctx.fillRect(0, 0, w, h)
		if (!cycles || !cycles.nCycles || !cycles.mean) {
			ctx.fillStyle = muted
			ctx.font = '12px sans-serif'
			ctx.textAlign = 'center'
			ctx.fillText('需有效周期（边沿测频 / FFT 主峰 / 手动）', w / 2, h / 2)
			return
		}
		const periodPts = cycles.periodPts
		let yMin = Infinity
		let yMax = -Infinity
		for (let c = 0; c < cycles.cycles.length; c++) {
			const sl = cycles.cycles[c]
			for (let i = 0; i < sl.length; i++) {
				if (sl[i] < yMin) yMin = sl[i]
				if (sl[i] > yMax) yMax = sl[i]
			}
		}
		if (!(yMax > yMin)) {
			yMin -= 1
			yMax += 1
		}
		const pad = 8
		const pw = w - pad * 2
		const ph = h - pad * 2
		// 各周期浅色
		ctx.globalAlpha = 0.25
		ctx.strokeStyle = muted
		ctx.lineWidth = 1
		for (let c = 0; c < cycles.cycles.length; c++) {
			const sl = cycles.cycles[c]
			ctx.beginPath()
			for (let i = 0; i < periodPts; i++) {
				const x = pad + (i / Math.max(1, periodPts - 1)) * pw
				const y = pad + ph - ((sl[i] - yMin) / (yMax - yMin)) * ph
				if (i === 0) ctx.moveTo(x, y)
				else ctx.lineTo(x, y)
			}
			ctx.stroke()
		}
		// 平均
		ctx.globalAlpha = 1
		ctx.strokeStyle = accent
		ctx.lineWidth = 2
		ctx.beginPath()
		for (let i = 0; i < periodPts; i++) {
			const x = pad + (i / Math.max(1, periodPts - 1)) * pw
			const y = pad + ph - ((cycles.mean[i] - yMin) / (yMax - yMin)) * ph
			if (i === 0) ctx.moveTo(x, y)
			else ctx.lineTo(x, y)
		}
		ctx.stroke()
	}

	function renderOverlayPanel(pack) {
		const meta = E('blu-ov-meta')
		if (!pack) {
			if (meta) meta.textContent = ''
			drawOverlayCanvas(null)
			return
		}
		const cycles = ensureOverlayInPack(pack, false)
		if (meta) {
			if (!cycles || !cycles.nCycles) {
				meta.textContent = '无有效周期'
			} else {
				meta.textContent = cycles.nCycles + ' 周期 · T≈' +
					fmtDuration(cycles._periodSec) + ' · ' + periodPtsLabel(cycles.periodPts, cycles._rateHz)
			}
		}
		drawOverlayCanvas(cycles)
	}

	function periodPtsLabel(pts, rateHz) {
		if (!rateHz) return pts + ' pt'
		return pts + ' pt @ ' + fmtFreq(rateHz)
	}

	function refreshAnalysis(force) {
		if (analysisCollapsed) {
			// 收起时只更新 bar 上的区间提示，不占高度、不重绘面板
			if (!analysisPending) syncAnalysisScopeHint(getOrBuildAnalysisPack(false))
			return
		}
		if (analysisPending) return
		analysisPending = true
		try {
			const pack = getOrBuildAnalysisPack(!!force)
			syncAnalysisScopeHint(pack)
			const rkey = (pack ? pack.key : 'none') + '|' + analysisTab + '|' + analysisScope
			// 区间未变且非强制：跳过 DOM/canvas 重绘
			if (!force && rkey === analysisLastRenderKey && pack) {
				return
			}
			if (!force && !pack && !analysisHadRange && analysisLastRenderKey.indexOf('none|') === 0) {
				return
			}
			analysisLastRenderKey = pack ? rkey : ('none|' + analysisTab + '|' + analysisScope)
			analysisHadRange = !!pack
			updateReadoutPanel(pack)
			if (analysisTab === 'events') renderEventsPanel(pack)
			else if (analysisTab === 'fft') renderFftPanel(pack)
			else if (analysisTab === 'battery') updateBatteryPanel()
			else if (analysisTab === 'overlay') renderOverlayPanel(pack)
		} finally {
			analysisPending = false
		}
	}

	function setAnalysisCollapsed(collapsed) {
		analysisCollapsed = !!collapsed
		const root = E('blu-analysis')
		const body = E('blu-analysis-body')
		const btn = E('blu-analysis-toggle')
		if (root) root.classList.toggle('is-collapsed', analysisCollapsed)
		if (body) body.hidden = analysisCollapsed
		if (btn) {
			btn.setAttribute('aria-expanded', analysisCollapsed ? 'false' : 'true')
			btn.title = analysisCollapsed ? '展开分析面板' : '收起分析面板（不占高度）'
		}
		saveAnalysisUiCfg()
		if (!analysisCollapsed) {
			analysisLastRenderKey = ''
			refreshAnalysis(true)
		}
	}

	function setAnalysisScope(scope) {
		if (scope !== 'selection' && scope !== 'window') scope = 'auto'
		if (scope === analysisScope) return
		analysisScope = scope
		analysisCache = null
		analysisLastRenderKey = ''
		const el = E('blu-analysis-scope')
		if (el && el.value !== analysisScope) el.value = analysisScope
		saveAnalysisUiCfg()
		scheduleAnalysisRefresh(true)
	}

	function setAnalysisTab(tab, opts) {
		opts = opts || {}
		const tabs = ['readout', 'events', 'fft', 'battery', 'overlay']
		if (tabs.indexOf(tab) < 0) tab = 'readout'
		const changed = analysisTab !== tab
		analysisTab = tab
		document.querySelectorAll('.blu-analysis-tab').forEach(function (btn) {
			const on = btn.getAttribute('data-tab') === tab
			btn.classList.toggle('is-active', on)
			btn.setAttribute('aria-selected', on ? 'true' : 'false')
		})
		document.querySelectorAll('.blu-analysis-panel').forEach(function (panel) {
			const on = panel.getAttribute('data-panel') === tab
			panel.hidden = !on
			panel.classList.toggle('is-active', on)
		})
		// 用户点 tab 时若收起则展开；初始化 silent 不强制展开
		if (analysisCollapsed && opts.expandIfCollapsed !== false && !opts.silent) {
			setAnalysisCollapsed(false)
			return
		}
		if (changed) analysisLastRenderKey = ''
		if (!analysisCollapsed) refreshAnalysis(true)
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
			if (elV) {
				elV.textContent = (setVoltageMv != null && isFinite(setVoltageMv))
					? (setVoltageMv + ' mV')
					: '--'
			}
			if (elSet) {
				elSet.textContent = modifiers.savedVddMv
					? (modifiers.savedVddMv + ' mV')
					: (modifiersOk ? '--' : (bluOpen ? '默认表' : '--'))
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
				if (elCount) elCount.textContent = String(dataCount())
				if (elDur) elDur.textContent = fmtDuration(dataCount() > 1 ? (dataCount() - 1) * samplePeriodSec : 0)
			}
			updateStats()
			updateCursorInfo()
			updateStorageUsage()
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

	function asinh(x) {
		// 稳定 asinh：大负值用 |x| 路径，避免 x+sqrt(x²+1) 相消
		if (typeof Math.asinh === 'function') return Math.asinh(x)
		const ax = Math.abs(x)
		if (ax === 0) return 0
		if (ax > 1e8) return (x < 0 ? -1 : 1) * (Math.log(ax) + Math.LN2)
		const a = Math.log(ax + Math.sqrt(ax * ax + 1))
		return x < 0 ? -a : a
	}

	function sinh(x) {
		const e = Math.exp(x)
		return (e - 1 / e) / 2
	}

	/**
	 * 按窗口 minPositive 自适应 log floor（µA），钳在 [MIN, MAX]。
	 * 策略：floor ≈ 10^floor(log10(min+ * 0.5))，默认 1 nA。
	 * Lock 时返回快照，不随窗口抖动。
	 */
	function adaptLogFloor(minPositive) {
		if (yAxisLocked && lockSnapFloorUA != null) return lockSnapFloorUA
		if (!(minPositive > 0) || !isFinite(minPositive)) {
			return logFloorUA > 0 ? logFloorUA : LOG_FLOOR_DEFAULT_UA
		}
		// 略低于窗口最小正值，便于谷底不贴轴
		let f = minPositive * 0.5
		if (f < LOG_FLOOR_MIN_UA) f = LOG_FLOOR_MIN_UA
		if (f > LOG_FLOOR_MAX_UA) f = LOG_FLOOR_MAX_UA
		// 贴到 1×10ⁿ
		const exp = Math.floor(Math.log10(f))
		f = Math.pow(10, exp)
		if (f < LOG_FLOOR_MIN_UA) f = LOG_FLOOR_MIN_UA
		if (f > LOG_FLOOR_MAX_UA) f = LOG_FLOOR_MAX_UA
		// 轻度滞回：抬高 floor 需 min+ 明显更高，避免 Live 噪声台阶跳
		const cur = logFloorUA > 0 ? logFloorUA : LOG_FLOOR_DEFAULT_UA
		if (f > cur && minPositive < cur * 8) return cur
		return f
	}

	/** Pure log：y = log10(max(floor, v))；负/零 clamp 到 floor（不污染线性统计） */
	function logMap(v) {
		const floor = logFloorUA > 0 ? logFloorUA : LOG_FLOOR_DEFAULT_UA
		if (!isFinite(v) || v <= floor) return Math.log10(floor)
		return Math.log10(v)
	}

	function logUnmap(lv) {
		if (!isFinite(lv)) return logFloorUA
		return Math.pow(10, lv)
	}

	/** Symlog（asinh）：近 0 近似线性、大电流压缩、容忍少量负噪声 */
	function symlogMap(v) {
		const th = symlogLinthreshUA > 0 ? symlogLinthreshUA : SYMLOG_LINTHRESH_DEFAULT_UA
		if (!isFinite(v)) return 0
		return asinh(v / th)
	}

	function symlogUnmap(mv) {
		const th = symlogLinthreshUA > 0 ? symlogLinthreshUA : SYMLOG_LINTHRESH_DEFAULT_UA
		if (!isFinite(mv)) return 0
		return th * sinh(mv)
	}

	function mapYValue(v) {
		if (yScaleMode === 'log') return logMap(v)
		if (yScaleMode === 'symlog') return symlogMap(v)
		return v
	}

	function unmapYValue(mv) {
		if (yScaleMode === 'log') return logUnmap(mv)
		if (yScaleMode === 'symlog') return symlogUnmap(mv)
		return mv
	}

	/**
	 * 在线性值空间生成 decade 主刻度 + 2/5（及 3–9 淡线）次刻度，再由调用方 map→像素。
	 * @returns {{ major: number[], minor: number[], faint: number[] }}
	 */
	function buildLogTicks(linMin, linMax, floor) {
		const lo = Math.max(floor > 0 ? floor : LOG_FLOOR_DEFAULT_UA, Math.min(linMin, linMax))
		const hi = Math.max(lo * 1.0001, Math.max(linMin, linMax))
		const exp0 = Math.floor(Math.log10(lo))
		const exp1 = Math.ceil(Math.log10(hi))
		const major = []
		const minor = [] // 2、5
		const faint = [] // 3,4,6,7,8,9
		for (let e = exp0; e <= exp1; e++) {
			const base = Math.pow(10, e)
			if (base >= lo * 0.999 && base <= hi * 1.001) major.push(base)
			for (let m = 2; m <= 9; m++) {
				const v = m * base
				if (v < lo * 0.999 || v > hi * 1.001) continue
				if (m === 2 || m === 5) minor.push(v)
				else faint.push(v)
			}
		}
		return { major: major, minor: minor, faint: faint }
	}

	/**
	 * Symlog 刻度：0 附近线性步长 + 外侧 decade。
	 */
	function buildSymlogTicks(linMin, linMax, linthresh) {
		const th = linthresh > 0 ? linthresh : SYMLOG_LINTHRESH_DEFAULT_UA
		const lo = Math.min(linMin, linMax)
		const hi = Math.max(linMin, linMax)
		const major = []
		const minor = []
		const faint = []
		// 线性区：±th 内用 nice 步长
		const linLo = Math.max(lo, -th)
		const linHi = Math.min(hi, th)
		if (linHi > linLo) {
			const step = niceNumber((linHi - linLo) / 4) || th / 2
			const g0 = Math.floor(linLo / step) * step
			for (let v = g0; v <= linHi + step * 0.01; v += step) {
				if (v >= lo - step * 0.01 && v <= hi + step * 0.01) {
					if (Math.abs(v) < step * 1e-9) major.push(0)
					else major.push(v)
				}
			}
		}
		// 外侧正负 decade（|v| > th）
		function outer(sign) {
			const a0 = Math.max(th, sign > 0 ? Math.max(th, lo) : Math.max(th, -hi))
			const a1 = sign > 0 ? Math.max(a0, hi) : Math.max(a0, -lo)
			if (!(a1 > th * 0.5)) return
			const ticks = buildLogTicks(Math.max(th, a0), a1, th)
			for (let i = 0; i < ticks.major.length; i++) major.push(sign * ticks.major[i])
			for (let i = 0; i < ticks.minor.length; i++) minor.push(sign * ticks.minor[i])
			for (let i = 0; i < ticks.faint.length; i++) faint.push(sign * ticks.faint[i])
		}
		if (hi > th) outer(1)
		if (lo < -th) outer(-1)
		// 去重并排序
		function uniq(arr) {
			arr.sort(function (a, b) { return a - b })
			const out = []
			for (let i = 0; i < arr.length; i++) {
				if (!out.length || Math.abs(arr[i] - out[out.length - 1]) > 1e-15 * Math.max(1, Math.abs(arr[i]))) {
					out.push(arr[i])
				}
			}
			return out
		}
		return { major: uniq(major), minor: uniq(minor), faint: uniq(faint) }
	}

	/**
	 * Log 自动量程：decade snap + 半 decade 边距；返回映射域 [mapMin, mapMax]。
	 */
	function computeLogAutoMapRange(yMinRaw, yMaxRaw, minPositive) {
		logFloorUA = adaptLogFloor(minPositive)
		const floor = logFloorUA
		let loLin = (minPositive > 0 && isFinite(minPositive)) ? minPositive : floor
		let hiLin = isFinite(yMaxRaw) ? yMaxRaw : floor * 10
		if (!(hiLin > 0) || !isFinite(hiLin)) hiLin = floor * 10
		loLin = Math.max(floor, loLin)
		hiLin = Math.max(hiLin, loLin * 1.01)
		// decade snap：下取 floor decade，上取 ceil decade；半 decade 边距
		let mapMin = Math.floor(Math.log10(loLin))
		let mapMax = Math.ceil(Math.log10(hiLin))
		// 至少 1 decade，避免贴死
		if (mapMax - mapMin < 1) mapMax = mapMin + 1
		// 数据贴近边界时加半 decade 边距
		const loM = Math.log10(loLin)
		const hiM = Math.log10(hiLin)
		if (loM - mapMin < 0.15) mapMin -= 0.5
		if (mapMax - hiM < 0.15) mapMax += 0.5
		if (mapMax <= mapMin) mapMax = mapMin + 1
		return { mapMin: mapMin, mapMax: mapMax, floor: floor }
	}

	/**
	 * Symlog 自动量程（映射域）。
	 * Lock 时不改 linthresh；未锁时 linthresh 带滞回，避免 Live 边界抖。
	 */
	function computeSymlogAutoMapRange(yMinRaw, yMaxRaw) {
		let th
		if (yAxisLocked && lockSnapLinthreshUA != null) {
			th = lockSnapLinthreshUA
			symlogLinthreshUA = th
		} else {
			const span = Math.max(Math.abs(yMinRaw), Math.abs(yMaxRaw), 1e-9)
			const cur = symlogLinthreshUA > 0 ? symlogLinthreshUA : SYMLOG_LINTHRESH_DEFAULT_UA
			// 默认 1 µA；全窗口很小时才收紧；span 明显变大再抬回默认
			if (span < SYMLOG_LINTHRESH_DEFAULT_UA * 0.2) {
				const proposed = Math.max(LOG_FLOOR_DEFAULT_UA, niceNumber(span / 2))
				if (proposed < cur * 0.5) th = proposed
				else th = cur
			} else if (span > cur * 4 && cur < SYMLOG_LINTHRESH_DEFAULT_UA) {
				th = SYMLOG_LINTHRESH_DEFAULT_UA
			} else {
				th = cur
			}
			symlogLinthreshUA = th
		}
		let lo = isFinite(yMinRaw) ? yMinRaw : -th
		let hi = isFinite(yMaxRaw) ? yMaxRaw : th
		if (hi < lo) { const t = lo; lo = hi; hi = t }
		// 边距 8%
		const pad = (hi - lo) * 0.08 || th * 0.2
		lo -= pad
		hi += pad
		// 保证跨过一点线性区
		if (hi - lo < th * 0.5) {
			const mid = (hi + lo) / 2
			lo = mid - th * 0.25
			hi = mid + th * 0.25
		}
		return { mapMin: symlogMap(lo), mapMax: symlogMap(hi), linthresh: th }
	}

	/**
	 * Live 自动量程滞回：越界立即扩、显著偏小才缩（防脉冲狂跳）。
	 * expand: target+disp 同步外扩（立即看得见）；shrink: 仅 target 收，disp 缓跟。
	 * Lock: 完全冻结 target/disp 与映射参数（floor/linthresh 另有快照）。
	 */
	function applyYAutoHysteresis(qMin, qMax, opts) {
		opts = opts || {}
		const expandPad = opts.expandPad != null ? opts.expandPad : 0
		const shrinkRatio = opts.shrinkRatio != null ? opts.shrinkRatio : 0.55
		if (yAxisLocked) {
			if (yAutoTargetMin == null) {
				yAutoTargetMin = qMin
				yAutoTargetMax = qMax
			}
			if (yAutoDispMin == null) {
				yAutoDispMin = yAutoTargetMin
				yAutoDispMax = yAutoTargetMax
			}
			return { mapMin: yAutoDispMin, mapMax: yAutoDispMax }
		}
		if (yAutoTargetMin == null) {
			yAutoTargetMin = qMin
			yAutoTargetMax = qMax
			yAutoDispMin = qMin
			yAutoDispMax = qMax
			return { mapMin: yAutoDispMin, mapMax: yAutoDispMax }
		}
		const curRange = yAutoTargetMax - yAutoTargetMin || 1
		const needExpandLo = qMin < yAutoTargetMin - expandPad
		const needExpandHi = qMax > yAutoTargetMax + expandPad
		const needShrink = (qMax - qMin) < curRange * shrinkRatio
		if (needExpandLo || needExpandHi) {
			// 只外扩越界侧，避免脉冲把另一侧一并拉开后难收回
			if (needExpandLo) yAutoTargetMin = qMin
			if (needExpandHi) yAutoTargetMax = qMax
		} else if (needShrink) {
			yAutoTargetMin = qMin
			yAutoTargetMax = qMax
		}
		if (yAutoDispMin == null) {
			yAutoDispMin = yAutoTargetMin
			yAutoDispMax = yAutoTargetMax
		} else {
			const alpha = opts.alpha != null ? opts.alpha : 0.3
			// 外扩：disp 立即贴齐 target，脉冲顶不被裁一帧
			if (yAutoTargetMin < yAutoDispMin) yAutoDispMin = yAutoTargetMin
			if (yAutoTargetMax > yAutoDispMax) yAutoDispMax = yAutoTargetMax
			// 内收：缓跟
			yAutoDispMin += (yAutoTargetMin - yAutoDispMin) * alpha
			yAutoDispMax += (yAutoTargetMax - yAutoDispMax) * alpha
		}
		return { mapMin: yAutoDispMin, mapMax: yAutoDispMax }
	}

	/**
	 * 建议 Log / 建议线性：
	 * 1) 比值进入/退出滞回（LOG_SUGGEST_* / LOG_LINEAR_*）
	 * 2) ratio EMA 平滑，压住 Live 脉冲进出视口的毛刺
	 * 3) 时间域进入/退出 hold + 最短展示，避免按钮 hidden 抖动
	 * 4) 窗口 lo/hi 短暂无效时沿用上一有效 ratio，不立刻清掉建议
	 */
	function updateYScaleHint(yMin, yMax, minPositive) {
		const now = performance.now()
		const pos = (minPositive > 0 && isFinite(minPositive)) ? minPositive : null
		const hi = isFinite(yMax) ? Math.abs(yMax) : 0
		const lo = pos != null ? pos : (isFinite(yMin) && yMin > 0 ? yMin : null)
		const valid = (lo > 0) && (hi > 0)

		if (valid) {
			const ratio = hi / lo
			yScaleHintLastValidAt = now
			if (!(yScaleHintRatioEma > 0) || !isFinite(yScaleHintRatioEma)) {
				yScaleHintRatioEma = ratio
			} else {
				yScaleHintRatioEma += (ratio - yScaleHintRatioEma) * HINT_RATIO_EMA_ALPHA
			}
		} else if (!(yScaleHintRatioEma > 0) ||
			!isFinite(yScaleHintRatioEma) ||
			(now - yScaleHintLastValidAt) > HINT_INVALID_KEEP_MS) {
			// 长时间无有效比值：走时间滞回清空（不硬切）
			commitYScaleHintWant('', now)
			return
		}
		// else：短暂无效，继续用 EMA

		const r = yScaleHintRatioEma
		let want = ''
		if (yScaleMode === 'linear') {
			if (yScaleHint === 'log') {
				// 已显示「建议 Log」：仅当动态范围明显收窄才想关掉
				want = (r < LOG_SUGGEST_EXIT) ? '' : 'log'
			} else if (r >= LOG_SUGGEST_RATIO) {
				want = 'log'
			}
		} else if (isLogLikeY()) {
			if (yScaleHint === 'linear') {
				// 已显示「建议线性」：仅当动态范围明显变大才想关掉
				want = (r > LOG_LINEAR_HINT_EXIT) ? '' : 'linear'
			} else if (r > 0 && r < LOG_LINEAR_HINT_RATIO) {
				want = 'linear'
			}
		}
		// 非 linear/log-like：want 保持 ''，经时间滞回灭掉
		commitYScaleHintWant(want, now)
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
			// early return 不跑 updateYScaleHint：硬清建议并同步 DOM，避免按钮残留
			if (yScaleHint || yScaleHintCandidate || yScaleHintRatioEma != null) {
				resetYScaleHintState()
			}
			syncYScaleUi()
			drawMinimapStrip()
			return
		}

		if (ringCount < 2) {
			ctx.fillStyle = muted
			ctx.font = '13px sans-serif'
			ctx.textAlign = 'center'
			ctx.fillText('等待采样数据…（仅电流波形）', w / 2, h / 2)
			plotLayout = null
			if (yScaleHint || yScaleHintCandidate || yScaleHintRatioEma != null) {
				resetYScaleHintState()
			}
			syncYScaleUi()
			drawMinimapStrip()
			return
		}

		const vr = getViewRange()
		// 顺序存储：全局逻辑下标即绝对下标（0 .. totalCount-1）
		const ringBase = 0
		const ringLastAbs = Math.max(0, dataCount() - 1)
		const bucketSize = computeBucketSize(vr.count, pw)
		let yMin = Infinity
		let yMax = -Infinity
		let minPositive = Infinity // 窗口最小正电流（自适应 floor / 建议 Log）
		let cols = null
		if (bucketSize <= 1) {
			for (let li = vr.start; li <= vr.end; li++) {
				const v = ringIAt(li)
				if (!isFinite(v)) continue
				if (v < yMin) yMin = v
				if (v > yMax) yMax = v
				if (v > 0 && v < minPositive) minPositive = v
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
				// 优先桶内精确 minPos；回退到 min>0（整块无逐点时 minPos 可能未知）
				if (entry.minPos > 0 && isFinite(entry.minPos) && entry.minPos < minPositive) {
					minPositive = entry.minPos
				} else if (entry.min > 0 && entry.min < minPositive) {
					minPositive = entry.min
				}
				cols.push({ x: (entry.loAbs + entry.hiAbs) / 2 - ringBase, entry: entry })
			}
		}
		if (!isFinite(yMin) || !isFinite(yMax)) {
			const vv = ringIAt(vr.end)
			yMin = (isFinite(vv) ? vv : 0) - 1
			yMax = (isFinite(vv) ? vv : 0) + 1
		}
		if (yMax === yMin) {
			yMax += 1
			yMin -= 1
		}
		if (!(minPositive > 0) || !isFinite(minPositive)) minPositive = Infinity

		updateYScaleHint(yMin, yMax, minPositive)

		// ---- 映射域自动量程 ----
		let mapYMin
		let mapYMax
		if (view.yMode === 'manual') {
			// 手工范围（线性值）→ 映射
			if (yScaleMode === 'log') {
				if (!yAxisLocked) logFloorUA = adaptLogFloor(minPositive)
				else if (lockSnapFloorUA != null) logFloorUA = lockSnapFloorUA
				mapYMin = logMap(Math.max(logFloorUA, view.yMin))
				mapYMax = logMap(Math.max(logFloorUA, view.yMax))
			} else if (yScaleMode === 'symlog') {
				if (yAxisLocked && lockSnapLinthreshUA != null) symlogLinthreshUA = lockSnapLinthreshUA
				mapYMin = symlogMap(view.yMin)
				mapYMax = symlogMap(view.yMax)
			} else {
				mapYMin = view.yMin
				mapYMax = view.yMax
			}
			if (mapYMax <= mapYMin) mapYMax = mapYMin + 1
		} else if (yAxisLocked && yAutoDispMin != null && yAutoDispMax != null) {
			// Lock：整段跳过 auto 重算，避免 floor/linthresh/span 任一漂移
			if (yScaleMode === 'log' && lockSnapFloorUA != null) logFloorUA = lockSnapFloorUA
			if (yScaleMode === 'symlog' && lockSnapLinthreshUA != null) {
				symlogLinthreshUA = lockSnapLinthreshUA
			}
			mapYMin = yAutoDispMin
			mapYMax = yAutoDispMax
		} else if (yScaleMode === 'log') {
			const lr = computeLogAutoMapRange(yMin, yMax, minPositive)
			// Log：decade 滞回更强（shrink 需缩到半 decade 级），减少脉冲狂跳
			const hy = applyYAutoHysteresis(lr.mapMin, lr.mapMax, {
				shrinkRatio: 0.5,
				alpha: 0.35,
			})
			mapYMin = hy.mapMin
			mapYMax = hy.mapMax
		} else if (yScaleMode === 'symlog') {
			const sr = computeSymlogAutoMapRange(yMin, yMax)
			const hy = applyYAutoHysteresis(sr.mapMin, sr.mapMax, {
				shrinkRatio: 0.55,
				alpha: 0.3,
			})
			mapYMin = hy.mapMin
			mapYMax = hy.mapMax
		} else {
			// 线性：nice 等分 + 原有滞回
			let rawMin = yMin
			let rawMax = yMax
			const padLin = (rawMax - rawMin) * 0.08 || 1
			rawMin -= padLin
			rawMax += padLin
			const rawRange = rawMax - rawMin || 1
			const step5 = niceNumber(rawRange / 4)
			const qMin = Math.floor(rawMin / step5) * step5
			const qMax = Math.ceil(rawMax / step5) * step5
			const hy = applyYAutoHysteresis(qMin, qMax, {
				shrinkRatio: 0.6,
				alpha: 0.3,
			})
			mapYMin = hy.mapMin
			mapYMax = hy.mapMax
		}

		// 用户 Y 缩放（映射域中心缩放 = Log 下倍率语义正确）
		if (view.yMode !== 'manual' && view.yZoom !== 1) {
			const mid = (mapYMin + mapYMax) / 2
			const half = (mapYMax - mapYMin) / 2 / view.yZoom
			mapYMin = mid - half
			mapYMax = mid + half
		}
		if (view.yPanOffset) {
			mapYMin += view.yPanOffset
			mapYMax += view.yPanOffset
		}

		// 线性自动轴：把 0 µA 纳入可见范围；用户已 Y 缩放/平移时不强制贴 0
		if (yScaleMode === 'linear' && view.yMode !== 'manual' && view.yZoom === 1 && !view.yPanOffset && !yAxisLocked) {
			if (mapYMin > 0) mapYMin = 0
			if (mapYMax < 0) mapYMax = 0
			if (mapYMax === mapYMin) {
				mapYMax += 1
				mapYMin -= 1
			}
		}
		if (!(mapYMax > mapYMin)) mapYMax = mapYMin + 1

		const t0 = indexToTime(vr.start)
		const t1 = indexToTime(vr.end)

		function toX(li) {
			const t = vr.count <= 1 ? 0 : (li - vr.start) / (vr.count - 1)
			return margin.left + t * pw
		}
		function mapVal(v) {
			return mapYValue(v)
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
		/** 像素 Y → 线性电流（悬停/调试用；浮标始终显示线性） */
		function fromYPixel(py) {
			const frac = (py - margin.top) / ph
			const mv = mapYMax - frac * (mapYMax - mapYMin)
			return unmapYValue(mv)
		}

		plotLayout = {
			margin: margin, pw: pw, ph: ph, w: w, h: h,
			vr: vr, yMin: mapYMin, yMax: mapYMax, toX: toX, toY: toY, fromX: fromX,
			fromYPixel: fromYPixel,
			t0: t0, t1: t1,
			yAxisLog: yScaleMode === 'log',
			yScaleMode: yScaleMode,
			logFloorUA: logFloorUA,
			symlogLinthreshUA: symlogLinthreshUA,
		}

		// ---- Y 网格：Log/Symlog 在线性值空间选 tick 再映射；线性仍 nice 等分 ----
		function drawYGridLine(valLin, style) {
			const y = toY(valLin)
			if (!isFinite(y) || y < margin.top - 1 || y > margin.top + ph + 1) return null
			ctx.beginPath()
			ctx.moveTo(margin.left, y)
			ctx.lineTo(w - margin.right, y)
			if (style === 'major') {
				ctx.strokeStyle = grid
				ctx.lineWidth = 0.7
				ctx.globalAlpha = 1
			} else if (style === 'minor') {
				ctx.strokeStyle = grid
				ctx.lineWidth = 0.5
				ctx.globalAlpha = 0.55
			} else {
				ctx.strokeStyle = grid
				ctx.lineWidth = 0.4
				ctx.globalAlpha = 0.28
			}
			ctx.stroke()
			ctx.globalAlpha = 1
			return y
		}

		if (yScaleMode === 'log') {
			const linLo = unmapYValue(mapYMin)
			const linHi = unmapYValue(mapYMax)
			const ticks = buildLogTicks(linLo, linHi, logFloorUA)
			for (let i = 0; i < ticks.faint.length; i++) drawYGridLine(ticks.faint[i], 'faint')
			for (let i = 0; i < ticks.minor.length; i++) {
				const y = drawYGridLine(ticks.minor[i], 'minor')
				if (y == null) continue
				// 2/5 仅在跨 decade 较少时标数字，避免挤
				if (ticks.major.length <= 3) {
					ctx.fillStyle = muted
					ctx.font = '9px monospace'
					ctx.textAlign = 'right'
					ctx.fillText(fmtCurrentTick(ticks.minor[i]), margin.left - 4, y + 3)
				}
			}
			for (let i = 0; i < ticks.major.length; i++) {
				const y = drawYGridLine(ticks.major[i], 'major')
				if (y == null) continue
				ctx.fillStyle = muted
				ctx.font = '10px monospace'
				ctx.textAlign = 'right'
				ctx.fillText(fmtCurrentTick(ticks.major[i]), margin.left - 4, y + 3)
			}
		} else if (yScaleMode === 'symlog') {
			const linLo = unmapYValue(mapYMin)
			const linHi = unmapYValue(mapYMax)
			const ticks = buildSymlogTicks(linLo, linHi, symlogLinthreshUA)
			for (let i = 0; i < ticks.faint.length; i++) drawYGridLine(ticks.faint[i], 'faint')
			for (let i = 0; i < ticks.minor.length; i++) drawYGridLine(ticks.minor[i], 'minor')
			for (let i = 0; i < ticks.major.length; i++) {
				const y = drawYGridLine(ticks.major[i], 'major')
				if (y == null) continue
				ctx.fillStyle = muted
				ctx.font = '10px monospace'
				ctx.textAlign = 'right'
				ctx.fillText(fmtCurrentTick(ticks.major[i]), margin.left - 4, y + 3)
			}
		} else {
			ctx.strokeStyle = grid
			ctx.lineWidth = 0.6
			for (let g = 0; g <= 4; g++) {
				const y = margin.top + (g / 4) * ph
				ctx.beginPath()
				ctx.moveTo(margin.left, y)
				ctx.lineTo(w - margin.right, y)
				ctx.stroke()
				const mv = mapYMax - (g / 4) * (mapYMax - mapYMin)
				const val = mv
				ctx.fillStyle = muted
				ctx.font = '10px monospace'
				ctx.textAlign = 'right'
				ctx.fillText(fmtCurrent(val).replace(' ', ''), margin.left - 4, y + 3)
			}
		}

		// 0 µA 参考线：线性轴；Symlog 也可画 0（真正穿过 0）
		if ((yScaleMode === 'linear' || yScaleMode === 'symlog') && mapYMin <= 0 && mapYMax >= 0) {
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
				ctx.fillStyle = fg
				ctx.font = 'bold 10px monospace'
				ctx.textAlign = 'right'
				ctx.fillText('0', margin.left - 4, y0 + 3)
				ctx.textAlign = 'left'
				ctx.font = '10px monospace'
				ctx.fillStyle = muted
				ctx.fillText('0', margin.left + 4, y0 - 3)
				ctx.restore()
			}
		}

		// Log / Symlog 角标：模式 + floor / linthresh
		if (isLogLikeY()) {
			ctx.save()
			ctx.font = '10px monospace'
			ctx.textAlign = 'left'
			ctx.fillStyle = muted
			let badge
			if (yScaleMode === 'log') {
				badge = 'Log I · floor ' + fmtCurrentTick(logFloorUA)
			} else {
				badge = 'Symlog · linthresh ' + fmtCurrentTick(symlogLinthreshUA)
			}
			if (yAxisLocked) badge += ' · Y-Lock'
			ctx.fillText(badge, margin.left + 6, margin.top + 12)
			ctx.restore()
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
				const v = ringIAt(li)
				if (!isFinite(v)) {
					// 断点：避免 NaN 路径把整段 stroke 弄没
					started = false
					continue
				}
				const x = toX(li)
				const y = toY(v)
				if (!isFinite(x) || !isFinite(y)) { started = false; continue }
				if (!started) { ctx.moveTo(x, y); started = true }
				else ctx.lineTo(x, y)
				drawnPts.push(x, y)
			}
		} else {
			for (let k = 0; k < cols.length; k++) {
				const e = cols[k].entry
				if (!e || !isFinite(e.min) || !isFinite(e.max)) {
					started = false
					continue
				}
				const x = toX(cols[k].x)
				const yFirst = toY(isFinite(e.first) ? e.first : e.min)
				const yMinPx = toY(e.min)
				const yMaxPx = toY(e.max)
				const yLast = toY(isFinite(e.last) ? e.last : e.max)
				if (!isFinite(x) || !isFinite(yFirst) || !isFinite(yLast)) {
					started = false
					continue
				}
				if (!started) { ctx.moveTo(x, yFirst); started = true }
				else ctx.lineTo(x, yFirst)
				// Nordic：同一 x 上画 min 再 max，形成包络
				if (Math.abs(e.min - e.first) <= Math.abs(e.max - e.first)) {
					if (isFinite(yMinPx)) ctx.lineTo(x, yMinPx)
					if (isFinite(yMaxPx)) ctx.lineTo(x, yMaxPx)
				} else {
					if (isFinite(yMaxPx)) ctx.lineTo(x, yMaxPx)
					if (isFinite(yMinPx)) ctx.lineTo(x, yMinPx)
				}
				ctx.lineTo(x, yLast)
			}
		}
		ctx.stroke()

		// 示波器显示触发：电平线 + 触发点竖线
		if (scopeTrigMode !== 'off') {
			const thr = getScopeTrigLevelUA()
			if (isFinite(thr)) {
				const yThr = toY(thr)
				if (isFinite(yThr) && yThr >= margin.top - 2 && yThr <= margin.top + ph + 2) {
					ctx.save()
					ctx.strokeStyle = 'rgba(236, 72, 153, 0.75)'
					ctx.lineWidth = 1
					ctx.setLineDash([5, 4])
					ctx.beginPath()
					ctx.moveTo(margin.left, yThr)
					ctx.lineTo(margin.left + pw, yThr)
					ctx.stroke()
					ctx.setLineDash([])
					ctx.fillStyle = 'rgba(236, 72, 153, 0.9)'
					ctx.font = '10px monospace'
					ctx.textAlign = 'left'
					ctx.fillText(
						'Trig ' + (scopeTrigMode === 'rise' ? '↑' : scopeTrigMode === 'fall' ? '↓' : '↕') +
						' ' + fmtCurrent(thr) + (scopeTrigLevelAuto ? ' auto' : ''),
						margin.left + 6,
						Math.max(margin.top + 10, Math.min(margin.top + ph - 4, yThr - 4))
					)
					ctx.restore()
				}
			}
			if (scopeTrigLockLi != null &&
				scopeTrigLockLi >= vr.start && scopeTrigLockLi <= vr.end) {
				const xT = toX(scopeTrigLockLi)
				if (isFinite(xT)) {
					ctx.save()
					ctx.strokeStyle = 'rgba(236, 72, 153, 0.55)'
					ctx.lineWidth = 1
					ctx.setLineDash([2, 3])
					ctx.beginPath()
					ctx.moveTo(xT, margin.top)
					ctx.lineTo(xT, margin.top + ph)
					ctx.stroke()
					ctx.restore()
				}
			}
		}

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
		/** 画布浮标：多行 label/value，锚在 (ax, ay) 附近 */
		function drawFloatBox(rows, ax, ay, opts) {
			opts = opts || {}
			if (!rows || !rows.length) return
			ctx.font = '11px monospace'
			let labelW = 0
			let valW = 0
			for (let r = 0; r < rows.length; r++) {
				const lw = ctx.measureText(rows[r][0]).width
				const vw = ctx.measureText(rows[r][1]).width
				if (lw > labelW) labelW = lw
				if (vw > valW) valW = vw
			}
			const padX = 8
			const gap = 8
			const boxW = Math.ceil(padX * 2 + labelW + gap + valW)
			const rowH = 14
			const boxH = rows.length * rowH + 8
			let bx = ax + (opts.offsetX != null ? opts.offsetX : 12)
			if (bx + boxW > margin.left + pw) bx = ax - 12 - boxW
			if (bx < margin.left) bx = margin.left
			let by = ay - (opts.centerY ? boxH / 2 : 0)
			if (opts.offsetY != null) by = ay + opts.offsetY
			by = Math.min(Math.max(margin.top, by), margin.top + ph - boxH)
			ctx.globalAlpha = 0.94
			ctx.fillStyle = bg
			ctx.fillRect(bx, by, boxW, boxH)
			ctx.globalAlpha = 1
			ctx.strokeStyle = opts.border || grid
			ctx.lineWidth = 1
			ctx.strokeRect(bx, by, boxW, boxH)
			ctx.textAlign = 'left'
			const valX = bx + padX + labelW + gap
			for (let r = 0; r < rows.length; r++) {
				const ty = by + 4 + rowH * r + 11
				ctx.fillStyle = muted
				ctx.fillText(rows[r][0], bx + padX, ty)
				ctx.fillStyle = opts.valueColor || fg
				ctx.fillText(rows[r][1], valX, ty)
			}
		}

		if (selectDrag && selectDrag.li0 != null && selectDrag.li1 != null) {
			drawSelectionFill(selectDrag.li0, selectDrag.li1, 0.22)
			drawEdgeLine(toX(selectDrag.li0), true, 'A', cursorCol)
			drawEdgeLine(toX(selectDrag.li1), true, 'B', '#ec4899')
			// 拖选预览：只显示瞬时 Δt / ΔI（边沿扫描留给松手后缓存）
			const m = buildSelectionMeasure(selectDrag.li0, selectDrag.li1, { light: true })
			if (m && m.rows.length) {
				const xa = toX(Math.min(selectDrag.li0, selectDrag.li1))
				const xb = toX(Math.max(selectDrag.li0, selectDrag.li1))
				drawFloatBox(m.rows, (xa + xb) / 2, margin.top + 8, {
					offsetX: 0, offsetY: 0, border: cursorCol,
				})
			}
		} else if (view.cursorA != null && view.cursorB != null) {
			const ca = clampLogical(view.cursorA)
			const cb = clampLogical(view.cursorB)
			drawSelectionFill(ca, cb, 0.15)
			const actA = cursorEdgeDrag && cursorEdgeDrag.edge === 'a'
			const actB = cursorEdgeDrag && cursorEdgeDrag.edge === 'b'
			drawEdgeLine(toX(ca), actA, 'A', cursorCol)
			drawEdgeLine(toX(cb), actB, 'B', '#ec4899')
			// 选择测量浮标（Δt / 频率 / ΔI / 占空…）；拖边界时只算轻量 Δt/ΔI
			const m = cursorEdgeDrag
				? buildSelectionMeasure(ca, cb, { light: true })
				: ensureCursorMeasureCache(ca, cb)
			if (m && m.rows.length) {
				const xa = toX(Math.min(ca, cb))
				const xb = toX(Math.max(ca, cb))
				const midX = (xa + xb) / 2
				drawFloatBox(m.rows, midX, margin.top + 8, {
					offsetX: 0, offsetY: 0, border: cursorCol,
				})
			}
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
			// 悬停点浮标：仅当前点信息（选择测量见上方选择浮标，避免重复长串）
			const rows = [
				['t', fmtTimeAxis(indexToTime(hli))],
				['I', fmtCurrent(hi)],
				['U', (setVoltageMv != null && isFinite(setVoltageMv)) ? (setVoltageMv + ' mV') : '--'],
				['P', fmtPower(hi * setVoltageV())],
			]
			drawFloatBox(rows, px, hover.y, { offsetX: 12, centerY: true })
		}

		ctx.fillStyle = muted
		ctx.font = '10px monospace'
		ctx.textAlign = 'center'
		const winDur = (vr.count > 1) ? (vr.count - 1) * samplePeriodSec : 0
		const totalDur = ringCount > 1 ? (ringCount - 1) * samplePeriodSec : 0
		const scaleTag = yScaleMode === 'log' ? ' · LogY'
			: (yScaleMode === 'symlog' ? ' · Symlog' : '')
		let trigTag = ''
		if (scopeTrigMode !== 'off') {
			const edgeCh = scopeTrigMode === 'rise' ? '↑' : scopeTrigMode === 'fall' ? '↓' : '↕'
			if (scopeTrigLockLi != null && !scopeTrigUserOverride) {
				trigTag = ' · Trig' + edgeCh + '钉住'
			} else if (scopeTrigUserOverride) {
				trigTag = ' · Trig' + edgeCh + '手移'
			} else {
				trigTag = ' · Trig' + edgeCh + '等待'
			}
		}
		ctx.fillText(
			'窗口 ' + fmtDuration(winDur) + ' / 总 ' + fmtDuration(totalDur) +
			' · 实测 ' + fmtHz(samplePeriodSec > 0 ? 1 / samplePeriodSec : 0) +
			'Hz/目标 ' + fmtHz(targetRateHz) + 'Hz' +
			scaleTag +
			(yAxisLocked ? ' · Y-Lock' : '') +
			(liveMode && !scrollPaused && scopeTrigMode === 'off' ? ' · Live' : '') +
			(scrollPaused && !(scopeTrigMode !== 'off' && scopeTrigLockLi != null) ? ' · 已暂停滚动' : '') +
			trigTag,
			margin.left + pw / 2,
			h - 6
		)

		// 同步工具条「建议 Log/线性」与触发控件（脏检查，避免每帧 DOM 写）
		syncYScaleUi()
		if (scopeTrigMode !== 'off') syncScopeTrigUi()

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

	/**
	 * 构建选择区间测量行（画布浮标用）。
	 * light=true 时跳过边沿扫描，仅 Δt/ΔI（拖选预览）。
	 */
	function buildSelectionMeasure(a, b, opts) {
		opts = opts || {}
		a = clampLogical(a)
		b = clampLogical(b)
		if (a == null || b == null || a === b) return null
		if (a > b) { const t = a; a = b; b = t }
		const dt = (b - a) * samplePeriodSec
		const ia = ringIAt(a)
		const ib = ringIAt(b)
		const rows = [
			['A', fmtTimeAxis(indexToTime(a))],
			['B', fmtTimeAxis(indexToTime(b))],
			['Δt', fmtDuration(dt)],
		]
		if (!opts.light) {
			const timing = measureSelectionTiming(a, b)
			// 优先边沿频率；不足两沿时退回 1/Δt
			if (timing.freqHz != null) {
				rows.push(['f', fmtFreq(timing.freqHz) + (timing.nPeriod ? ' n=' + timing.nPeriod : '')])
			} else if (dt > 0) {
				rows.push(['1/Δt', fmtFreq(1 / dt)])
			}
			if (timing.duty != null) {
				rows.push(['占空', (timing.duty * 100).toFixed(1) + '%'])
			}
		} else if (dt > 0) {
			rows.push(['1/Δt', fmtFreq(1 / dt)])
		}
		if (isFinite(ia) && isFinite(ib)) {
			rows.push(['ΔI', fmtCurrent(ib - ia)])
		}
		return { a: a, b: b, dt: dt, rows: rows }
	}

	function ensureCursorMeasureCache(a, b) {
		a = clampLogical(a)
		b = clampLogical(b)
		if (a == null || b == null) {
			cursorMeasureCache = null
			return null
		}
		if (a > b) { const t = a; a = b; b = t }
		const key = a + '|' + b + '|' + ringCount + '|' + samplePeriodSec
		if (cursorMeasureCache && cursorMeasureCache.key === key) return cursorMeasureCache
		const m = buildSelectionMeasure(a, b, { light: false })
		if (!m) {
			cursorMeasureCache = null
			return null
		}
		cursorMeasureCache = { key: key, a: m.a, b: m.b, dt: m.dt, rows: m.rows }
		return cursorMeasureCache
	}

	function updateCursorInfo() {
		// 测量改画在画布浮标；区间变化时刷新分析（收起则只更新 hint）
		const sel = getSelectionRange()
		if (!sel) {
			cursorMeasureCache = null
		} else {
			ensureCursorMeasureCache(sel.a, sel.b)
		}
		// auto/selection 依赖选择；window 依赖视口（暂停后才重算）
		if (analysisCollapsed) {
			syncAnalysisScopeHint(getOrBuildAnalysisPack(false))
			return
		}
		const range = getAnalysisRange()
		if (!range) {
			if (analysisHadRange || analysisCache) {
				// 选择清空且 scope=selection 时丢缓存
				if (analysisScope === 'selection') {
					analysisCache = null
					analysisLastRenderKey = ''
				}
				scheduleAnalysisRefresh(true)
			}
			return
		}
		const key = analysisCacheKey(range.a, range.b, range.source)
		if (!analysisCache || analysisCache.key !== key) {
			scheduleAnalysisRefresh(range.source === 'window' ? true : false)
		}
	}

	function clearSelection() {
		view.cursorA = null
		view.cursorB = null
		selectDrag = null
		cursorEdgeDrag = null
		updateCursorInfo()
		scheduleUIUpdate()
	}

	function setCursorEdge(edge, li, opts) {
		opts = opts || {}
		li = clampLogical(li)
		if (li == null) return
		// 拖动中不吸附（跟手），松手/显式 snap 时再贴边沿
		if (opts.snap && cursorSnapMode !== 'free') {
			li = snapLogicalToEdge(li)
		}
		if (edge === 'a') view.cursorA = li
		else view.cursorB = li
		// 允许交叉后交换语义：始终保持 A/B 可独立拖
		updateCursorInfo()
	}

	/** 将 A 或 B 吸附到最近边沿（工具栏按钮） */
	function snapCursorEdgeNow(edge) {
		const li = edge === 'a' ? view.cursorA : view.cursorB
		if (li == null) {
			// 无选择时：在视口中心放一条游标再吸附
			const vr = getViewRange()
			if (vr.count < 2) return
			const mid = Math.round((vr.start + vr.end) / 2)
			if (edge === 'a') {
				view.cursorA = snapLogicalToEdge(mid)
				if (view.cursorB == null) view.cursorB = view.cursorA
			} else {
				view.cursorB = snapLogicalToEdge(mid)
				if (view.cursorA == null) view.cursorA = view.cursorB
			}
		} else {
			setCursorEdge(edge, li, { snap: true })
		}
		setScrollPaused(true)
		updateCursorInfo()
		scheduleUIUpdate()
	}

	/** A→最近上升/设定沿，B→同类型下一沿，便于测一个周期 */
	function snapCursorsToPeriod() {
		if (ringCount < 4) return
		const kind = cursorSnapMode === 'fall' ? 'fall'
			: (cursorSnapMode === 'either' ? 'either' : 'rise')
		const vr = getViewRange()
		const start = vr.count > 1 ? vr.start : 0
		const end = vr.count > 1 ? vr.end : ringCount - 1
		const a0 = view.cursorA != null ? clampLogical(view.cursorA) : Math.round((start + end) / 2)
		const a = findNearestEdge(a0, kind === 'either' ? 'rise' : kind, start, end)
		// 从 A 右侧找下一沿
		const b = findNearestEdge(
			Math.min(end, a + 2),
			kind === 'either' ? 'rise' : kind,
			a + 1,
			Math.min(ringCount - 1, end + Math.floor((end - start) * 2))
		)
		view.cursorA = a
		view.cursorB = (b != null && b > a) ? b : Math.min(ringCount - 1, a + Math.max(2, Math.floor((end - start) / 4)))
		// 若视口内找不到第二沿，扩大搜索
		if (view.cursorB <= view.cursorA) {
			const b2 = findNearestEdge(a + 2, kind === 'either' ? 'rise' : kind, a + 1, ringCount - 1)
			if (b2 != null && b2 > a) view.cursorB = b2
		}
		setScrollPaused(true)
		updateCursorInfo()
		scheduleUIUpdate()
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
		beginScopeTrigUserOverride()
		// 使视口约等于选择宽度
		view.xZoom = clampXZoom(DEFAULT_VIEW_POINTS / n)
		liveMode = false
		setScrollPaused(true)
		// 视口中心对齐选择中心
		const center = (sel.a + sel.b) / 2
		const half = Math.floor(n / 2)
		const end = Math.min(ringCount - 1, Math.round(center + half))
		view.xOffset = Math.max(0, ringCount - 1 - end)
		scheduleUIUpdate()
	}

	async function exportCSVRange(start, end, prefix) {
		const nAll = dataCount()
		if (nAll < 1) {
			bluLog('无数据可导出', 'warn')
			return
		}
		start = Math.max(0, start | 0)
		end = Math.min(nAll, end | 0)
		if (end <= start) {
			bluLog('导出区间无效', 'warn')
			return
		}
		const nRange = end - start
		const maxExport = 2000000
		const step = nRange > maxExport ? Math.ceil(nRange / maxExport) : 1
		const lines = ['timestamp_s,current_uA,voltage_mV']
		let base = 0
		for (let ci = 0; ci < waveChunks.length; ci++) {
			const ch = waveChunks[ci]
			const ch0 = base
			const ch1 = base + ch.n
			const lo = Math.max(start, ch0)
			const hi = Math.min(end, ch1)
			if (hi > lo) {
				let buf = getChunkBuf(ch)
				if (!buf && ch.state !== 'hot' && Store && ch.diskBytes) {
					try {
						buf = await Store.readChunk(ch.id, ch.n)
						touchHydrateCache(ch.id, buf)
					} catch (e) {
						bluLog('导出时回读冷块失败 ' + ch.id + '：' + (e && e.message ? e.message : e), 'warn')
					}
				}
				for (let off = lo - ch0; off < hi - ch0; off++) {
					const li = ch0 + off
					if (step > 1 && ((li - start) % step) !== 0) continue
					const t = indexToTime(li)
					const i = buf ? buf[off] : ringIAt(li)
					lines.push(t.toFixed(9) + ',' + i + ',' +
						((setVoltageMv != null && isFinite(setVoltageMv)) ? setVoltageMv : ''))
				}
			}
			base = ch1
			if (base >= end) break
		}
		downloadText(lines.join('\n'), prefix || 'blu100k_', 'text/csv;charset=utf-8', '.csv')
		bluLog('已导出 ' + Math.ceil(nRange / step) + ' 点 CSV' + (step > 1 ? '（抽稀 1/' + step + '）' : ''))
	}

	async function exportCSV() {
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
			downloadText(lines.join('\n'), 'blu100k_longstats_', 'text/csv;charset=utf-8', '.csv')
			return
		}
		await exportCSVRange(0, dataCount(), 'blu100k_')
	}

	async function exportSelectionCSV() {
		const sel = getSelectionRange()
		if (!sel) {
			bluLog('请先框选区间再导出选区', 'warn')
			return
		}
		await exportCSVRange(sel.a, sel.b + 1, 'blu100k_sel_')
	}

	function exportAnalysisReport() {
		const pack = getOrBuildAnalysisPack(true)
		const overall = recordMode === 'long'
			? {
				mode: 'long',
				n: longStats.n,
				avgI: longStats.n ? longStats.sumI / longStats.n : 0,
				minI: longStats.minI,
				maxI: longStats.maxI,
				energyUAs: longStats.energyUAs,
			}
			: (overallStatCache || calcStats(0, ringCount))
		if (pack) {
			ensureEventsInPack(pack, true)
			ensureFftInPack(pack, true)
		}
		const report = {
			version: (typeof window !== 'undefined' && window.APP_VERSION) || '',
			exportedAt: new Date().toISOString(),
			voltageMv: setVoltageMv,
			samplePeriodSec: samplePeriodSec,
			targetRateHz: targetRateHz,
			deviceStreamHz: deviceStreamHz,
			recordMode: recordMode,
			overall: overall,
			selection: pack ? {
				a: pack.a,
				b: pack.b,
				tA: indexToTime(pack.a),
				tB: indexToTime(pack.b),
				basic: pack.basic,
				levels: pack.levels,
				timing: pack.timing,
				qCycle: pack.qCycle,
				spikeCount: pack.spikes ? pack.spikes.length : 0,
				spikes: (pack.spikes || []).slice(0, 50).map(function (sp) {
					return {
						peak: sp.peak,
						widthPts: sp.widthPts,
						t: indexToTime(pack.a + sp.peakIdx * pack.ext.step),
					}
				}),
				segCount: pack.segs && pack.segs.segments ? pack.segs.segments.length : 0,
				fft: pack.fft && pack.fft.ok ? {
					sampleRateHz: pack.fft.sampleRateHz,
					nyquistHz: pack.fft.nyquistHz,
					binHz: pack.fft.binHz,
					nfft: pack.fft.nfft,
					window: pack.fft.window,
					dc: pack.fft.dc,
					peaks: pack.fft.peaks,
				} : null,
			} : null,
		}
		downloadText(JSON.stringify(report, null, 2), 'blu100k_report_', 'application/json;charset=utf-8', '.json')
		bluLog('已导出分析报告 JSON')
	}

	function downloadText(text, prefix, mime, ext) {
		mime = mime || 'text/csv;charset=utf-8'
		ext = ext || '.csv'
		const blob = new Blob([text], { type: mime })
		const a = document.createElement('a')
		a.href = URL.createObjectURL(blob)
		a.download = prefix + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + ext
		a.click()
		URL.revokeObjectURL(a.href)
	}

	/**
	 * 导入 CSV 回放：支持 timestamp_s,current_uA[,voltage_mV]
	 * 会清空当前波形（需确认未在采样）。
	 */
	async function importCSVFile(file) {
		if (!file) return
		if (bluSampling) {
			bluLog('请先停止采样再导入', 'warn')
			return
		}
		let text
		try {
			text = await file.text()
		} catch (e) {
			bluLog('读取文件失败：' + (e && e.message ? e.message : e), 'error')
			return
		}
		const lines = text.split(/\r?\n/)
		const currents = []
		let times = []
		let vMv = null
		let start = 0
		if (lines.length && /timestamp|current|time/i.test(lines[0])) start = 1
		for (let i = start; i < lines.length; i++) {
			const line = lines[i].trim()
			if (!line || line[0] === '#') continue
			const parts = line.split(/[,;\t]/)
			if (parts.length < 2) continue
			const t = parseFloat(parts[0])
			const c = parseFloat(parts[1])
			if (!isFinite(c)) continue
			times.push(isFinite(t) ? t : currents.length)
			currents.push(c)
			if (parts.length >= 3 && vMv == null) {
				const vv = parseFloat(parts[2])
				if (isFinite(vv) && vv > 0) vMv = vv
			}
		}
		if (currents.length < 2) {
			bluLog('CSV 有效点不足（需要 timestamp_s,current_uA）', 'warn')
			return
		}
		// 回放必须波形模式，否则统计/分析/画布走长期路径
		if (recordMode !== 'wave') setRecordMode('wave')
		// 估采样周期
		let dtSum = 0
		let dtN = 0
		for (let i = 1; i < times.length; i++) {
			const d = times[i] - times[i - 1]
			if (d > 0 && isFinite(d)) {
				dtSum += d
				dtN++
			}
		}
		const dt = dtN ? (dtSum / dtN) : (1 / targetRateHz)
		clearAllData(false)
		analysisLastRenderKey = ''
		samplePeriodSec = dt > 0 ? dt : (1 / targetRateHz)
		periodLocked = true
		deviceStreamHz = samplePeriodSec > 0 ? (1 / samplePeriodSec) : targetRateHz
		if (vMv != null && isFinite(vMv)) {
			setVoltageMv = Math.round(vMv)
			syncVoltageInput()
		}
		// 写入环
		for (let i = 0; i < currents.length; i++) {
			if (!ringPush(currents[i])) {
				bluLog('导入时存储不足，已写入 ' + i + ' / ' + currents.length, 'warn')
				break
			}
		}
		sampleCount = totalCount
		ringCount = totalCount
		firstStoredTs = performance.now()
		sessionT0Ms = firstStoredTs
		// 重建 minimap（FoldingBuffer: addData(valueUA, timestampSec)）
		minimap.reset()
		try {
			const stepMm = Math.max(1, Math.floor(currents.length / 8000))
			for (let i = 0; i < currents.length; i += stepMm) {
				minimap.addData(currents[i], indexToTime(i))
			}
		} catch (e) { /* 忽略 */ }
		liveMode = false
		setScrollPaused(true)
		view.xOffset = 0
		view.cursorA = 0
		view.cursorB = ringCount - 1
		// 导入后若显示触发开启，重扫钉住（clearAllData 已清锁）
		if (scopeTrigMode !== 'off') rescanScopeTriggerRecent()
		invalidateOverallStat()
		analysisCache = null
		updateCursorInfo()
		updateStats()
		scheduleUIUpdate()
		bluLog('已导入 ' + ringCount + ' 点 · Δt≈' + (samplePeriodSec * 1e6).toFixed(2) + ' µs · ' +
			fmtFreq(1 / samplePeriodSec) + (file.name ? ' · ' + file.name : ''))
	}

	function zoomX(factor) {
		// Live：只改倍率继续贴最新端；暂停：以视口中心为锚
		if (!scrollPaused || !plotLayout || plotLayout.pw < 1 || ringCount < 2) {
			view.xZoom = clampXZoom(view.xZoom * factor)
			scheduleUIUpdate()
			return
		}
		const midPx = plotLayout.margin.left + plotLayout.pw * 0.5
		zoomXAt(factor, midPx)
	}

	/**
	 * X 轴缩放。
	 * - Live / 继续滚动：只改倍率，不暂停、不跟鼠标（视口右端始终最新）
	 * - 已暂停：以画布像素 px 下的数据点为锚（跟手缩放）
	 */
	function zoomXAt(factor, px) {
		const prev = view.xZoom
		view.xZoom = clampXZoom(view.xZoom * factor)
		if (view.xZoom === prev) {
			scheduleUIUpdate()
			return
		}
		// 滚动模式下无需锚点：getViewRange 会贴最新端
		if (!scrollPaused) {
			scheduleUIUpdate()
			return
		}
		const layout = plotLayout
		const n = dataCount()
		if (!layout || layout.pw < 1 || n < 2) {
			scheduleUIUpdate()
			return
		}
		const marginLeft = layout.margin.left
		const pw = layout.pw
		let t = (px - marginLeft) / pw
		if (t < 0) t = 0
		if (t > 1) t = 1
		const vr = layout.vr || getViewRange()
		// 用连续逻辑下标作锚，避免 fromX 取整导致锚点跳动
		const liBefore = vr.count <= 1
			? vr.start
			: (vr.start + t * (vr.count - 1))
		panViewSoLiAtPixel(liBefore, px)
		scheduleUIUpdate()
	}

	function isOverYAxis(canvasX) {
		const layout = plotLayout
		const marginLeft = layout && layout.margin ? layout.margin.left : 62
		return canvasX <= marginLeft + Y_AXIS_HIT_PAD_PX
	}

	function zoomY(factor) {
		// 工具栏：以视口垂直中心为锚
		const layout = plotLayout
		if (layout && layout.ph > 1) {
			zoomYAt(factor, layout.margin.top + layout.ph * 0.5)
			return
		}
		view.yZoom = Math.max(Y_ZOOM_MIN, Math.min(Y_ZOOM_MAX, view.yZoom * factor))
		scheduleUIUpdate()
	}

	/** Y 轴缩放并以画布 py 处的映射值为锚 */
	function zoomYAt(factor, py) {
		const layout = plotLayout
		if (!layout || !layout.ph || layout.ph < 1) {
			zoomY(factor)
			return
		}
		const oldZoom = view.yZoom
		const newZoom = Math.max(Y_ZOOM_MIN, Math.min(Y_ZOOM_MAX, oldZoom * factor))
		if (newZoom === oldZoom) return

		let frac = (py - layout.margin.top) / layout.ph
		if (frac < 0) frac = 0
		if (frac > 1) frac = 1
		// 画布上→下对应 mapYMax→mapYMin
		const oldMin = layout.yMin
		const oldMax = layout.yMax
		const oldSpan = oldMax - oldMin || 1
		const mv = oldMax - frac * oldSpan
		const oldMid = (oldMin + oldMax) / 2
		const oldHalf = oldSpan / 2
		const newHalf = oldHalf * (oldZoom / newZoom)
		// 保持 mv 仍在 frac 位置 → 新中点
		const newMid = mv + newHalf * (2 * frac - 1)
		view.yZoom = newZoom
		view.yPanOffset = view.yPanOffset + (newMid - oldMid)
		scheduleUIUpdate()
	}

	function resetX() {
		view.xZoom = 1
		view.xOffset = 0
		view.yPanOffset = 0
		scopeTrigUserOverride = false
		if (scopeTrigMode !== 'off') {
			// 触发模式：清锁并重扫，尽快重新钉住
			rescanScopeTriggerRecent()
			if (scopeTrigLockLi == null) setScrollPaused(false)
			else {
				liveMode = false
				scheduleUIUpdate()
			}
			return
		}
		// 复位 X 并回到最新波形（Live）
		setScrollPaused(false)
	}

	function resetY() {
		view.yZoom = 1
		view.yPanOffset = 0
		view.yMode = 'auto'
		yAxisLocked = false
		lockSnapFloorUA = null
		lockSnapLinthreshUA = null
		yScaleUiKey = ''
		resetYAuto()
		syncYScaleUi()
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

	/** short=true 时用 15A2:300A（工具条/列表小字）；完整日志仍可用 0x 前缀 */
	function formatVidPid(info, short) {
		const vid = info && info.usbVendorId != null
			? info.usbVendorId.toString(16).toUpperCase().padStart(4, '0')
			: null
		const pid = info && info.usbProductId != null
			? info.usbProductId.toString(16).toUpperCase().padStart(4, '0')
			: null
		if (vid && pid) return short ? (vid + ':' + pid) : ('VID 0x' + vid + ' · PID 0x' + pid)
		if (vid) return short ? vid : ('VID 0x' + vid)
		return ''
	}

	function bluPortLabel(port, index) {
		let info = {}
		try { info = port && port.getInfo ? port.getInfo() : {} } catch (e) {}
		const sn = getPortSn(port)
		const vp = formatVidPid(info, false)
		const vpShort = formatVidPid(info, true)
		// 优先 SN；否则 BLU + 规范 VID/PID
		if (sn && vpShort) return sn + '（' + vpShort + '）'
		if (sn) return sn
		if (isBluUsbInfo(info) || vp) {
			const n = bluKnownPorts.length > 1 ? (' #' + (index + 1)) : ''
			return 'BLU' + n + (vpShort ? ' · ' + vpShort : '')
		}
		return bluKnownPorts.length > 1 ? ('设备 #' + (index + 1)) : '串口设备'
	}

	function syncPortSelectUI() {
		const sel = E('blu-port-select')
		const prev = bluPort
		if (sel) {
			sel.innerHTML = ''
			if (!bluKnownPorts.length) {
				const opt = document.createElement('option')
				opt.value = ''
				opt.textContent = '未检测到设备'
				sel.appendChild(opt)
				if (!bluOpen) bluPort = null
				renderDeviceList()
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
		} else if (bluKnownPorts.length) {
			let idx = 0
			if (prev) {
				const found = bluKnownPorts.indexOf(prev)
				if (found >= 0) idx = found
			}
			bluPort = bluKnownPorts[idx]
		} else if (!bluOpen) {
			bluPort = null
		}
		renderDeviceList()
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
		const elDeviceBtn = E('blu-device-btn')
		if (elDeviceBtn) {
			elDeviceBtn.addEventListener('click', function (e) {
				e.stopPropagation()
				const pop = E('blu-device-pop')
				const open = pop && pop.hidden
				if (open) {
					refreshBluPorts({ log: false }).then(function () {
						renderDeviceList()
						setDeviceMenuOpen(true)
					})
				} else {
					setDeviceMenuOpen(false)
				}
			})
		}
		document.addEventListener('click', function (e) {
			const menu = E('blu-device-menu')
			if (!menu || menu.contains(e.target)) return
			setDeviceMenuOpen(false)
		})
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape') setDeviceMenuOpen(false)
		})

		const elPortSel = E('blu-port-select')
		if (elPortSel) {
			elPortSel.addEventListener('change', function () {
				const i = parseInt(this.value, 10)
				if (!isFinite(i) || i < 0 || i >= bluKnownPorts.length) {
					if (!bluOpen) bluPort = null
					renderDeviceList()
					return
				}
				const next = bluKnownPorts[i]
				if (bluOpen && next !== bluPort) {
					bluLog('请先关闭当前设备再切换', 'warn')
					const cur = bluKnownPorts.indexOf(bluPort)
					this.value = cur >= 0 ? String(cur) : ''
					return
				}
				bluPort = next
				bluLog('已选中 ' + bluPortLabel(next, i))
				renderDeviceList()
			})
		}

		const elSelect = E('blu-select-port')
		if (elSelect) {
			elSelect.addEventListener('click', async function (e) {
				e.stopPropagation()
				try {
					const port = await navigator.serial.requestPort({
						filters: PROTO.USB_FILTERS,
					})
					if (bluOpen) await bluClosePort({ manual: true })
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
					renderDeviceList()
					setDeviceMenuOpen(false)
					bluLog('已添加并填入 BLU 设备（USB 15A2:300A）')
				} catch (err) {
					if (err && err.name !== 'NotFoundError') bluLog('添加设备：' + (err.message || err), 'error')
				}
			})
		}

		const elOpen = E('blu-open')
		if (elOpen) {
			elOpen.addEventListener('click', async function () {
				if (bluOpening) return
				if (!bluPort) await refreshBluPorts({ log: false })
				if (!bluPort) {
					bluLog('未检测到设备，请点「BLU」→ 添加设备', 'error')
					setDeviceMenuOpen(true)
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

		const elDutPower = E('blu-dut-power')
		if (elDutPower) elDutPower.addEventListener('click', function () { toggleDutPower() })

		const elVolt = E('blu-voltage-set')
		if (elVolt) {
			// 打开前不显示电压，连接后由设备 VDD 回填
			clearVoltageUi()
			// 失焦 / 回车写入，去掉单独「设压」按钮
			elVolt.addEventListener('change', function () {
				elVolt.dataset.userTouched = '1'
				const mv = readSetVoltageMv()
				if (mv == null) {
					bluLog('请输入源电压 mV', 'warn')
					return
				}
				applyVoltageMv(mv)
			})
			elVolt.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') {
					e.preventDefault()
					elVolt.dataset.userTouched = '1'
					const mv = readSetVoltageMv()
					if (mv == null) {
						bluLog('请输入源电压 mV', 'warn')
						return
					}
					applyVoltageMv(mv)
					elVolt.blur()
				}
			})
		}

		// 初始连接按钮态
		setStatus('未连接', false)
		markPowered(false)

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

		function commitStorageInputs() {
			const elRam = E('blu-ram-gb')
			const elDisk = E('blu-disk-gb')
			const next = {
				ramGB: elRam ? elRam.value : storageCfg.ramGB,
				diskGB: elDisk ? elDisk.value : storageCfg.diskGB,
			}
			if (bluSampling) {
				// 采样中只允许调磁盘上限（立即生效）；RAM 下次开始采样生效
				const diskOnly = {
					ramGB: storageCfg.ramGB,
					diskGB: next.diskGB,
				}
				applyStorageConfig(diskOnly)
				if (elRam) ensureSelectHasValue(elRam, storageCfg.ramGB, fmtGb(storageCfg.ramGB))
				bluLog('磁盘预算已更新为 ' + fmtGb(storageCfg.diskGB) + '（RAM 请停止采样后再改）')
				return
			}
			applyStorageConfig(next)
			bluLog('存储预算：RAM ' + fmtGb(storageCfg.ramGB) + '（约 ' +
				fmtDuration(estimateDurationSec(RING_CAP_MAX, targetRateHz)) +
				'@' + fmtHz(targetRateHz) + '）· 磁盘 ' + fmtGb(storageCfg.diskGB))
		}
		const elRam = E('blu-ram-gb')
		const elDisk = E('blu-disk-gb')
		if (elRam) elRam.addEventListener('change', commitStorageInputs)
		if (elDisk) elDisk.addEventListener('change', commitStorageInputs)
		syncStorageUi()
		if (Store) {
			Store.init().then(function (be) {
				if (be) {
					bluLog('波形冷存储就绪（' + be +
						(Store.isCompressionSupported() ? '+deflate' : '') +
						'，多标签心跳保护 / 过期会话回收）')
				}
			}).catch(function () { /* 忽略 */ })
		}

		const elYScale = E('blu-y-scale')
		if (elYScale) {
			elYScale.value = yScaleMode
			elYScale.addEventListener('change', function () {
				setYScaleMode(elYScale.value)
			})
		}
		// 兼容旧 Log checkbox
		const elYLog = E('blu-y-log')
		if (elYLog) {
			elYLog.addEventListener('change', function () {
				setYAxisLog(this.checked)
			})
		}
		const elYLock = E('blu-y-lock')
		if (elYLock) {
			elYLock.addEventListener('click', function () {
				setYAxisLocked(!yAxisLocked)
			})
		}
		const elYHint = E('blu-y-scale-hint')
		if (elYHint) {
			elYHint.addEventListener('click', function () {
				const act = elYHint.dataset.action
				if (act === 'log') setYScaleMode('log')
				else if (act === 'linear') setYScaleMode('linear')
			})
		}
		syncYScaleUi()

		const elScopeTrig = E('blu-scope-trig')
		if (elScopeTrig) {
			elScopeTrig.value = scopeTrigMode
			elScopeTrig.addEventListener('change', function () {
				setScopeTrigMode(elScopeTrig.value)
			})
		}
		const elScopeLvl = E('blu-scope-trig-level')
		if (elScopeLvl) {
			const applyLvl = function () { setScopeTrigLevelFromInput(elScopeLvl.value) }
			elScopeLvl.addEventListener('change', applyLvl)
			elScopeLvl.addEventListener('keydown', function (e) {
				if (e.key === 'Enter') {
					e.preventDefault()
					applyLvl()
					elScopeLvl.blur()
				}
			})
		}
		syncScopeTrigUi()

		const elAcqStart = E('blu-acq-trig-start')
		if (elAcqStart) {
			elAcqStart.value = acqTrigStart
			elAcqStart.addEventListener('change', function () {
				setAcqTrigStart(elAcqStart.value)
			})
		}
		const elAcqStop = E('blu-acq-trig-stop')
		if (elAcqStop) {
			elAcqStop.value = acqTrigStop
			elAcqStop.addEventListener('change', function () {
				setAcqTrigStop(elAcqStop.value)
			})
		}
		syncAcqTrigUi()

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
		const elExportSel = E('blu-export-sel')
		if (elExportSel) elExportSel.addEventListener('click', exportSelectionCSV)
		const elExportReport = E('blu-export-report')
		if (elExportReport) elExportReport.addEventListener('click', exportAnalysisReport)
		const elImport = E('blu-import')
		if (elImport) {
			elImport.addEventListener('change', function () {
				const f = elImport.files && elImport.files[0]
				elImport.value = ''
				if (f) importCSVFile(f)
			})
		}

		const elClear = E('blu-clear')
		if (elClear) elClear.addEventListener('click', function () {
			clearAllData(true)
			analysisCache = null
			scheduleAnalysisRefresh(true)
		})

		const elClearLog = E('blu-clear-log')
		if (elClearLog) {
			elClearLog.addEventListener('click', function () {
				const box = E('blu-log')
				if (box) box.innerHTML = ''
			})
		}

		// 分析面板：折叠 / 区间 / tabs
		const elAnToggle = E('blu-analysis-toggle')
		if (elAnToggle) {
			elAnToggle.addEventListener('click', function () {
				setAnalysisCollapsed(!analysisCollapsed)
			})
		}
		const elAnScope = E('blu-analysis-scope')
		if (elAnScope) {
			elAnScope.value = analysisScope
			elAnScope.addEventListener('change', function () {
				setAnalysisScope(elAnScope.value)
			})
		}
		document.querySelectorAll('.blu-analysis-tab').forEach(function (btn) {
			btn.addEventListener('click', function () {
				setAnalysisTab(btn.getAttribute('data-tab') || 'readout')
			})
		})
		const elEvRef = E('blu-events-refresh')
		if (elEvRef) elEvRef.addEventListener('click', function () {
			if (analysisCollapsed) setAnalysisCollapsed(false)
			analysisCache = null
			analysisLastRenderKey = ''
			const pack = getOrBuildAnalysisPack(true)
			if (pack) {
				pack.spikes = null
				pack.segs = null
			}
			renderEventsPanel(getOrBuildAnalysisPack(false))
			syncAnalysisScopeHint(analysisCache)
		})
		const elFftRef = E('blu-fft-refresh')
		if (elFftRef) elFftRef.addEventListener('click', function () {
			if (analysisCollapsed) setAnalysisCollapsed(false)
			if (analysisCache) analysisCache.fft = null
			analysisLastRenderKey = ''
			renderFftPanel(getOrBuildAnalysisPack(true))
			syncAnalysisScopeHint(analysisCache)
		})
		const elFftWin = E('blu-fft-window')
		if (elFftWin) elFftWin.addEventListener('change', function () {
			if (analysisCache) analysisCache.fft = null
			if (!analysisCollapsed && analysisTab === 'fft') renderFftPanel(getOrBuildAnalysisPack(false))
		})
		const elFftDc = E('blu-fft-remove-dc')
		if (elFftDc) elFftDc.addEventListener('change', function () {
			if (analysisCache) analysisCache.fft = null
			if (!analysisCollapsed && analysisTab === 'fft') renderFftPanel(getOrBuildAnalysisPack(false))
		})
		const elBatCalc = E('blu-bat-calc')
		if (elBatCalc) elBatCalc.addEventListener('click', updateBatteryPanel)
		;['blu-bat-mah', 'blu-bat-derate', 'blu-bat-src'].forEach(function (id) {
			const el = E(id)
			if (el) el.addEventListener('change', updateBatteryPanel)
		})
		const elOvRef = E('blu-ov-refresh')
		if (elOvRef) elOvRef.addEventListener('click', function () {
			if (analysisCollapsed) setAnalysisCollapsed(false)
			if (analysisCache) analysisCache.cycles = null
			analysisLastRenderKey = ''
			renderOverlayPanel(getOrBuildAnalysisPack(true))
			syncAnalysisScopeHint(analysisCache)
		})
		const fftCanvas = E('blu-fft-canvas')
		if (fftCanvas) {
			fftCanvas.addEventListener('click', function (e) {
				const pack = analysisCache
				const fft = pack && pack.fft
				if (!fft || !fft.ok || !fft.mags) return
				const rect = fftCanvas.getBoundingClientRect()
				const x = e.clientX - rect.left
				const padL = 36
				const padR = 8
				const pw = Math.max(1, rect.width - padL - padR)
				const t = (x - padL) / pw
				if (t < 0 || t > 1) return
				const n = fft.mags.length
				const bin = Math.max(1, Math.min(n - 1, Math.round(1 + t * (n - 2))))
				const freq = (bin * fft.sampleRateHz) / fft.nfft
				zoomToFreqPeriod(freq, pack)
			})
		}
		// 恢复折叠/区间偏好；tabs 默认读数（silent 不强制展开）
		setAnalysisTab('readout', { silent: true })
		setAnalysisCollapsed(analysisCollapsed)

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
		bindClick('blu-cursor-snap-a', function () { snapCursorEdgeNow('a') })
		bindClick('blu-cursor-snap-b', function () { snapCursorEdgeNow('b') })
		bindClick('blu-cursor-period', snapCursorsToPeriod)

		const elSnap = E('blu-cursor-snap')
		if (elSnap) {
			elSnap.value = cursorSnapMode
			elSnap.addEventListener('change', function () {
				const v = elSnap.value
				cursorSnapMode = (v === 'rise' || v === 'fall' || v === 'either') ? v : 'free'
				// 已有选择时切换模式立即贴沿，便于测频
				if (cursorSnapMode !== 'free' && view.cursorA != null && view.cursorB != null) {
					view.cursorA = snapLogicalToEdge(view.cursorA)
					view.cursorB = snapLogicalToEdge(view.cursorB)
					updateCursorInfo()
					scheduleUIUpdate()
				}
			})
		}

		const canvas = E('blu-canvas')
		if (canvas) {
			canvas.addEventListener('wheel', function (e) {
				e.preventDefault()
				const factor = e.deltaY > 0 ? (1 / 1.15) : 1.15
				const rect = canvas.getBoundingClientRect()
				const cx = e.clientX - rect.left
				const cy = e.clientY - rect.top
				// 指针在左侧 Y 轴刻度区，或按住 Shift：缩放 Y；否则缩放 X
				// 均以指针位置为锚（非视口中心）
				if (e.shiftKey || isOverYAxis(cx)) zoomYAt(factor, cy)
				else zoomXAt(factor, cx)
			}, { passive: false })

			canvas.addEventListener('pointermove', function (e) {
				// 仅在无拖拽时提示 Y 轴可滚轮缩放
				if (drag || selectDrag || cursorEdgeDrag || minimapDrag) return
				const rect = canvas.getBoundingClientRect()
				const cx = e.clientX - rect.left
				if (isOverYAxis(cx)) {
					canvas.style.cursor = 'ns-resize'
				} else if (canvas.style.cursor === 'ns-resize') {
					canvas.style.cursor = ''
				}
			})

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

				// 悬停：Y 轴 ns-resize · 游标线 ew-resize · 其余 crosshair
				if (!cursorEdgeDrag && !selectDrag && !drag && plotLayout) {
					if (isOverYAxis(x)) canvas.style.cursor = 'ns-resize'
					else if (hitTestCursorEdge(x)) canvas.style.cursor = 'ew-resize'
					else canvas.style.cursor = 'crosshair'
				}

				if (cursorEdgeDrag && plotLayout) {
					const li = plotLayout.fromX(x)
					// 拖动中跟手，不吸附
					setCursorEdge(cursorEdgeDrag.edge, li, { snap: false })
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
						// 用户平移：暂时退出触发钉视口，直到下一次沿
						beginScopeTrigUserOverride()
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
					// 松手时按模式吸附边沿
					if (cursorSnapMode !== 'free' && cursorEdgeDrag.edge) {
						const cur = cursorEdgeDrag.edge === 'a' ? view.cursorA : view.cursorB
						setCursorEdge(cursorEdgeDrag.edge, cur, { snap: true })
					}
					cursorEdgeDrag = null
					canvas.style.cursor = 'crosshair'
					updateCursorInfo()
					scheduleUIUpdate()
					return
				}
				if (selectDrag) {
					let a = selectDrag.li0
					let b = selectDrag.li1
					selectDrag = null
					if (a != null && b != null && a !== b) {
						a = clampLogical(a)
						b = clampLogical(b)
						if (cursorSnapMode !== 'free') {
							const a0 = a
							const b0 = b
							a = snapLogicalToEdge(a)
							b = snapLogicalToEdge(b)
							// 两端贴到同一沿时，B 向右再找下一同向沿，避免选择塌缩
							if (a != null && b != null && a === b) {
								const kind = cursorSnapMode === 'fall' ? 'fall'
									: (cursorSnapMode === 'either' ? 'rise' : 'rise')
								const b2 = findNearestEdge(a + 2, kind, a + 1, ringCount - 1)
								if (b2 != null && b2 > a) b = b2
								else { a = a0; b = b0 }
							}
						}
						view.cursorA = a
						view.cursorB = b
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
				beginScopeTrigUserOverride()
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
