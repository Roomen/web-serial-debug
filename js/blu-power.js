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
		let mn = Infinity
		let mx = -Infinity
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
					if (!got) { first = ch.minI; got = true }
					last = ch.maxI
					if (ch.minI < mn) mn = ch.minI
					if (ch.maxI > mx) mx = ch.maxI
				} else {
					const buf = getChunkBuf(ch)
					if (buf) {
						for (let p = a; p <= b; p++) {
							const v = buf[p - ch0]
							if (!got) { first = v; got = true }
							last = v
							if (v < mn) mn = v
							if (v > mx) mx = v
						}
					} else {
						requestHydrate(ch)
						if (!got) { first = ch.minI; got = true }
						last = ch.maxI
						if (ch.minI < mn) mn = ch.minI
						if (ch.maxI > mx) mx = ch.maxI
					}
				}
			}
			base = ch1
			if (base > hi) break
		}
		return { min: mn, max: mx, first: first, last: last, loAbs: lo, hiAbs: hi }
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
		const entry = bucketMinMaxGlobal(aLo, aHi)
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
		bluLog((startOk ? 'AVERAGE_START' : 'AVERAGE_START 可能失败') +
			' · 目标 ' + getRatePreset().label +
			' · ' + (recordMode === 'long' ? '长期统计' : '波形') +
			' · Live 滚动' +
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
		stopStallWatch()
		updateSampleBtn()
		try { await bluWrite(PROTO.cmdAverageStop(), 'AVERAGE_STOP') } catch (e) {}
		parser.reset()
		releaseWakeLock()
		bluLog(storageStop ? '已停止采样（存储限制）' : '已停止采样')
		updateStorageUsage()
		scheduleUIUpdate()
	}

	function updateSampleBtn() {
		const el = E('blu-start')
		if (!el) return
		if (bluSampling) {
			el.className = 'btn btn-sm btn-danger'
			el.innerHTML = '<i class="bi bi-stop-fill"></i> 停止'
		} else {
			el.className = 'btn btn-sm btn-success'
			el.innerHTML = '<i class="bi bi-play-fill"></i> 采样'
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
					continue
				}
				ingestStored(o.tMs, o.iUA)
				stored++
			}
		}

		// 暂停滚动：新样本入库后钉住历史视口（顺序存储，旧下标不左移）
		if (bluSampling && stored > 0 && scrollPaused) {
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
		// 顺序存储：全局逻辑下标即绝对下标（0 .. totalCount-1）
		const ringBase = 0
		const ringLastAbs = Math.max(0, dataCount() - 1)
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
				['U', (setVoltageMv != null && isFinite(setVoltageMv)) ? (setVoltageMv + ' mV') : '--'],
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
			downloadText(lines.join('\n'), 'blu100k_longstats_')
			return
		}
		const nAll = dataCount()
		if (nAll < 1) {
			bluLog('无数据可导出', 'warn')
			return
		}
		const maxExport = 2000000
		const step = nAll > maxExport ? Math.ceil(nAll / maxExport) : 1
		const lines = ['timestamp_s,current_uA,voltage_mV']
		// 按块导出，冷数据先解压，保证不丢细节（抽稀仅在超 maxExport 时）
		let base = 0
		for (let ci = 0; ci < waveChunks.length; ci++) {
			const ch = waveChunks[ci]
			let buf = getChunkBuf(ch)
			if (!buf && ch.state !== 'hot' && Store && ch.diskBytes) {
				try {
					buf = await Store.readChunk(ch.id, ch.n)
					touchHydrateCache(ch.id, buf)
				} catch (e) {
					bluLog('导出时回读冷块失败 ' + ch.id + '：' + (e && e.message ? e.message : e), 'warn')
				}
			}
			for (let off = 0; off < ch.n; off++) {
				const li = base + off
				if (step > 1 && (li % step) !== 0) continue
				const t = indexToTime(li)
				const i = buf ? buf[off] : ringIAt(li)
				lines.push(t.toFixed(9) + ',' + i + ',' +
					((setVoltageMv != null && isFinite(setVoltageMv)) ? setVoltageMv : ''))
			}
			base += ch.n
		}
		downloadText(lines.join('\n'), 'blu100k_')
		bluLog('已导出 ' + Math.ceil(nAll / step) + ' 点 CSV' + (step > 1 ? '（抽稀 1/' + step + '）' : ''))
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
		view.xZoom = clampXZoom(view.xZoom * factor)
		scheduleUIUpdate()
	}

	function zoomXAt(factor, px) {
		const layout = plotLayout
		if (!layout) { zoomX(factor); return }
		const liBefore = layout.fromX(px)
		view.xZoom = clampXZoom(view.xZoom * factor)
		// Live 时只改倍率、继续贴最新端；已暂停时尽量让指针下数据点保持在原位置
		const n = dataCount()
		if (scrollPaused && liBefore != null && n > 1) {
			const viewPts = Math.max(MIN_VIEW_POINTS, Math.round(DEFAULT_VIEW_POINTS / view.xZoom))
			const half = Math.floor(Math.min(n, viewPts) / 2)
			let end = Math.min(n - 1, liBefore + half)
			const start = Math.max(0, end - Math.min(n, viewPts) + 1)
			if (start === 0) end = Math.min(n - 1, start + Math.min(n, viewPts) - 1)
			view.xOffset = Math.max(0, n - 1 - end)
		}
		scheduleUIUpdate()
	}

	function isOverYAxis(canvasX) {
		const layout = plotLayout
		const marginLeft = layout && layout.margin ? layout.margin.left : 62
		return canvasX <= marginLeft + Y_AXIS_HIT_PAD_PX
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
				const cx = e.clientX - rect.left
				// 指针在左侧 Y 轴刻度区，或按住 Shift：缩放 Y；否则缩放 X
				if (e.shiftKey || isOverYAxis(cx)) zoomY(factor)
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
