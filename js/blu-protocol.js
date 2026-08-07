;// BLU 100k 协议核心（纯逻辑，无 DOM）— 对照 blu_api_python / Nordic PPK2 数据路径
(function () {
	'use strict'

	const NOMINAL_BASE_HZ = 100000
	const ADC_MULT = 1.8 / 163840
	const SAMPLE_BYTES = 4
	const VDD_LOW_MV = 500
	const VDD_HIGH_MV = 5000

	const CMD = {
		NO_OP: 0x00,
		TRIGGER_SET: 0x01,
		AVG_NUM_SET: 0x02,
		AVERAGE_START: 0x06,
		AVERAGE_STOP: 0x07,
		RANGE_SET: 0x08,
		DEVICE_RUNNING_SET: 0x0C,
		REGULATOR_SET: 0x0D,
		SET_POWER_MODE: 0x11,
		SPIKE_FILTERING_ON: 0x15,
		SPIKE_FILTERING_OFF: 0x16,
		GET_META_DATA: 0x19,
		RESET: 0x20,
	}

	const MODE = {
		AMPERE: 'AMPERE',
		SOURCE: 'SOURCE',
	}

	// 14-bit ADC @0, 3-bit range @14, 8-bit logic @24（与 Python MEAS_* 一致）
	const MASK_ADC = 0x3fff
	const MASK_RANGE = 0x7
	const POS_RANGE = 14
	const MASK_LOGIC = 0xff
	const POS_LOGIC = 24

	const DEFAULT_R = {
		'0': 1031.64, '1': 101.65, '2': 10.15,
		'3': 0.94, '4': 0.113, '5': 0.013,
	}

	function packBytes(bytes) {
		return new Uint8Array(bytes)
	}

	function cmdMeta() {
		return packBytes([CMD.GET_META_DATA])
	}

	function cmdAverageStart() {
		return packBytes([CMD.AVERAGE_START])
	}

	function cmdAverageStop() {
		return packBytes([CMD.AVERAGE_STOP])
	}

	function cmdRegulatorSet(mV) {
		mV = Math.max(VDD_LOW_MV, Math.min(VDD_HIGH_MV, mV | 0))
		const hi = (mV >> 8) & 0xff
		const lo = mV & 0xff
		return packBytes([CMD.REGULATOR_SET, hi, lo])
	}

	function cmdDutPower(on) {
		return packBytes([CMD.DEVICE_RUNNING_SET, on ? CMD.TRIGGER_SET : CMD.NO_OP])
	}

	// 示例默认不调 SET_POWER_MODE；保留命令常量，需要时再发
	function cmdSourceMode() {
		return packBytes([CMD.SET_POWER_MODE, CMD.AVG_NUM_SET])
	}

	function cmdAmpereMode() {
		return packBytes([CMD.SET_POWER_MODE, CMD.TRIGGER_SET])
	}

	function defaultModifiers() {
		const ones = function () {
			return { '0': 1, '1': 1, '2': 1, '3': 1, '4': 1, '5': 1 }
		}
		const zeros = function () {
			return { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
		}
		return {
			Calibrated: null,
			R: Object.assign({}, DEFAULT_R),
			GS: ones(),
			GI: ones(),
			O: zeros(),
			S: zeros(),
			I: zeros(),
			UG: ones(),
			HW: null,
			IA: null,
			deviceSn: '',
			savedVddMv: 0,
			rawText: '',
		}
	}

	function parseMetadata(text) {
		const mod = defaultModifiers()
		if (!text || typeof text !== 'string') return mod
		mod.rawText = text
		const lines = text.split(/\r?\n/)
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].replace(/=/g, ':')
			const idx = line.indexOf(':')
			if (idx < 0) continue
			const k = line.slice(0, idx).trim()
			const v = line.slice(idx + 1).trim()
			if (!k) continue
			if (k === 'Calibrated' || k === 'HW' || k === 'IA') {
				mod[k] = v
				continue
			}
			// 若固件 metadata 带序列号字段
			if (/^(SN|SERIAL|SERIAL_NUMBER|SERIALNUMBER|DEVICE_ID|BOARD_ID)$/i.test(k) && v) {
				mod.deviceSn = v
				continue
			}
			const m = /^(R|GS|GI|O|S|I|UG)([0-5])$/.exec(k)
			if (m) {
				const key = m[1]
				const ind = m[2]
				const num = parseFloat(v)
				if (!isFinite(num)) continue
				if (key === 'R') {
					if (num !== 0) mod.R[ind] = num
				} else {
					mod[key][ind] = num
				}
				continue
			}
			if (/^VDD/i.test(k)) {
				const digits = v.replace(/\D/g, '')
				if (digits) {
					const mv = parseInt(digits, 10)
					if (isFinite(mv) && mv > 0) mod.savedVddMv = mv
				}
			}
		}
		return mod
	}

	// ---- 档位切换 spike 滤波 + 电流换算（对照 Python get_adc_result / _handle_raw_data）----
	function Converter(modifiers) {
		this.modifiers = modifiers || defaultModifiers()
		this.adcMult = ADC_MULT
		this.rollingAvg = null
		this.rollingAvg4 = null
		this.prevRange = null
		this.consecutiveRangeSamples = 0
		this.spikeFilterAlpha = 0.18
		this.spikeFilterAlpha5 = 0.06
		this.spikeFilterSamples = 3
		this.afterSpike = 0
	}

	Converter.prototype.setModifiers = function (mod) {
		this.modifiers = mod || defaultModifiers()
		this.resetFilter()
	}

	Converter.prototype.resetFilter = function () {
		this.rollingAvg = null
		this.rollingAvg4 = null
		this.prevRange = null
		this.consecutiveRangeSamples = 0
		this.afterSpike = 0
	}

	Converter.prototype.getAdcResult = function (rangeIdx, adcValue) {
		const r = String(rangeIdx)
		const O = this.modifiers.O[r] || 0
		const R = this.modifiers.R[r]
		if (!R || R === 0) return 0
		let adc = (adcValue - O) * (this.adcMult / R)

		const prevRolling = this.rollingAvg
		const prevRolling4 = this.rollingAvg4

		if (this.rollingAvg == null) this.rollingAvg = adc
		else this.rollingAvg = this.spikeFilterAlpha * adc + (1 - this.spikeFilterAlpha) * this.rollingAvg

		if (this.rollingAvg4 == null) this.rollingAvg4 = adc
		else this.rollingAvg4 = this.spikeFilterAlpha5 * adc + (1 - this.spikeFilterAlpha5) * this.rollingAvg4

		if (this.prevRange == null) this.prevRange = r

		if (this.prevRange !== r || this.afterSpike > 0) {
			if (this.prevRange !== r) {
				this.consecutiveRangeSamples = 0
				this.afterSpike = this.spikeFilterSamples
			} else {
				this.consecutiveRangeSamples++
			}
			if (r === '5') {
				if (this.consecutiveRangeSamples < 2) {
					this.rollingAvg = prevRolling
					this.rollingAvg4 = prevRolling4
				}
				adc = this.rollingAvg4
			} else {
				adc = this.rollingAvg
			}
			this.afterSpike--
		}
		this.prevRange = r
		return adc
	}

	/** raw uint32 → { iUA, range, logic }；iUA 单位 µA */
	Converter.prototype.handleRaw = function (rawU32) {
		const range = Math.min((rawU32 >> POS_RANGE) & MASK_RANGE, 5)
		const adc = (rawU32 & MASK_ADC) * 4
		const logic = (rawU32 >> POS_LOGIC) & MASK_LOGIC
		const amps = this.getAdcResult(range, adc)
		return {
			iUA: amps * 1e6,
			range: range,
			logic: logic,
		}
	}

	// ---- 流式 4 字节拆包 ----
	function SampleParser(converter) {
		this.converter = converter || new Converter()
		this.remainder = new Uint8Array(0)
	}

	SampleParser.prototype.reset = function () {
		this.remainder = new Uint8Array(0)
		this.converter.resetFilter()
	}

	/**
	 * @param {Uint8Array} buf
	 * @returns {{ iUA: number, range: number, logic: number }[]}
	 */
	SampleParser.prototype.push = function (buf) {
		if (!buf || !buf.length) return []
		let data
		if (this.remainder.length) {
			data = new Uint8Array(this.remainder.length + buf.length)
			data.set(this.remainder)
			data.set(buf, this.remainder.length)
		} else {
			data = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
		}
		const out = []
		let off = 0
		const n = data.length
		while (off + SAMPLE_BYTES <= n) {
			const raw =
				data[off] |
				(data[off + 1] << 8) |
				(data[off + 2] << 16) |
				(data[off + 3] << 24)
			// >>> 0 保证无符号
			out.push(this.converter.handleRaw(raw >>> 0))
			off += SAMPLE_BYTES
		}
		this.remainder = off < n ? data.subarray(off) : new Uint8Array(0)
		return out
	}

	// ---- 主机重采样（对照 Python RateAdjuster；基速可换实测）----
	function RateAdjuster(targetHz, baseHz) {
		this.baseRateHz = Math.max(1, baseHz | 0 || NOMINAL_BASE_HZ)
		this._accSum = 0
		this._accCount = 0
		this._accumulator = 0
		this._tSum = 0
		this.setTargetRateHz(targetHz || 1000)
	}

	RateAdjuster.prototype.setBaseRateHz = function (hz) {
		const h = Math.max(1, Math.round(hz))
		if (h === this.baseRateHz) return
		this.baseRateHz = h
		// 目标不变，分母变了需同步 step
		this.setTargetRateHz(this.targetRateHz)
	}

	RateAdjuster.prototype.setTargetRateHz = function (hz) {
		const tr = Math.max(1, Math.min(NOMINAL_BASE_HZ, Math.round(hz)))
		this.targetRateHz = tr
		this._stepNum = tr
		this._stepDen = this.baseRateHz
		// 若目标 >= 基速则 1:1
		if (this._stepNum >= this._stepDen) {
			this._stepNum = this._stepDen
		}
	}

	RateAdjuster.prototype.reset = function () {
		this._accSum = 0
		this._accCount = 0
		this._accumulator = 0
		this._tSum = 0
	}

	/**
	 * @param {number} valueUA
	 * @param {number} tMs performance.now 风格
	 * @returns {{ tMs: number, iUA: number }[]}
	 */
	RateAdjuster.prototype.push = function (valueUA, tMs) {
		this._accSum += valueUA
		this._tSum += tMs
		this._accCount++
		this._accumulator += this._stepNum
		const outs = []
		while (this._accumulator >= this._stepDen && this._accCount > 0) {
			const avg = this._accSum / this._accCount
			const tOut = this._tSum / this._accCount
			outs.push({ tMs: tOut, iUA: avg })
			this._accumulator -= this._stepDen
			this._accSum = 0
			this._tSum = 0
			this._accCount = 0
		}
		return outs
	}

	RateAdjuster.prototype.appliedRateHz = function () {
		if (this._stepNum >= this._stepDen) return this.baseRateHz
		return this.baseRateHz * (this._stepNum / this._stepDen)
	}

	// ---- Folding minimap（对照 Nordic FoldingBuffer，定长 min/max 总览）----
	function FoldingBuffer(maxElements) {
		this.maxNumberOfElements = maxElements || 10000
		this.numberOfTimesToFold = 1
		this.lastElementFoldCount = 0
		this.length = 0
		this.minX = new Float64Array(this.maxNumberOfElements)
		this.minY = new Float64Array(this.maxNumberOfElements)
		this.maxX = new Float64Array(this.maxNumberOfElements)
		this.maxY = new Float64Array(this.maxNumberOfElements)
	}

	FoldingBuffer.prototype.reset = function () {
		this.numberOfTimesToFold = 1
		this.lastElementFoldCount = 0
		this.length = 0
	}

	FoldingBuffer.prototype._addDefault = function (ts) {
		const i = this.length
		this.minX[i] = ts
		this.minY[i] = Number.MAX_VALUE
		this.maxX[i] = ts
		this.maxY[i] = -Number.MAX_VALUE
		this.length++
	}

	FoldingBuffer.prototype._fold = function () {
		this.numberOfTimesToFold *= 2
		const n = this.length >> 1
		for (let i = 0; i < n; i++) {
			const a = i * 2
			const b = a + 1
			this.minX[i] = (this.minX[a] + this.minX[b]) / 2
			this.minY[i] = Math.min(this.minY[a], this.minY[b])
			this.maxX[i] = (this.maxX[a] + this.maxX[b]) / 2
			this.maxY[i] = Math.max(this.maxY[a], this.maxY[b])
		}
		this.length = n
	}

	/** @param valueUA µA  @param timestampSec 会话相对秒 */
	FoldingBuffer.prototype.addData = function (valueUA, timestampSec) {
		if (this.lastElementFoldCount === 0) {
			this._addDefault(timestampSec)
		}
		let v = valueUA
		// log 友好：过小值抬到 0.2 µA（PPK 用 200 nA）
		if (v < 0.2) v = 0.2

		this.lastElementFoldCount++
		const alpha = 1 / this.lastElementFoldCount
		const i = this.length - 1
		this.minX[i] = timestampSec * alpha + this.minX[i] * (1 - alpha)
		this.maxX[i] = timestampSec * alpha + this.maxX[i] * (1 - alpha)
		if (isFinite(v)) {
			if (v < this.minY[i]) this.minY[i] = v
			if (v > this.maxY[i]) this.maxY[i] = v
		}

		if (this.lastElementFoldCount === this.numberOfTimesToFold) {
			this.lastElementFoldCount = 0
		}
		if (this.length === this.maxNumberOfElements) {
			this._fold()
		}
	}

	/** 返回交错 min/max 点 [{x,y},…] 供总览绘制 */
	FoldingBuffer.prototype.getData = function () {
		const out = []
		for (let i = 0; i < this.length; i++) {
			if (this.maxY[i] < this.minY[i]) continue
			out.push({ x: this.minX[i], y: this.minY[i] })
			out.push({ x: this.maxX[i], y: this.maxY[i] })
		}
		return out
	}

	window.BluProtocol = {
		CMD: CMD,
		MODE: MODE,
		NOMINAL_BASE_HZ: NOMINAL_BASE_HZ,
		SAMPLE_BYTES: SAMPLE_BYTES,
		VDD_LOW_MV: VDD_LOW_MV,
		VDD_HIGH_MV: VDD_HIGH_MV,
		USB_FILTERS: [{ usbVendorId: 0x15A2, usbProductId: 0x300A }],
		packBytes: packBytes,
		cmdMeta: cmdMeta,
		cmdAverageStart: cmdAverageStart,
		cmdAverageStop: cmdAverageStop,
		cmdRegulatorSet: cmdRegulatorSet,
		cmdDutPower: cmdDutPower,
		cmdSourceMode: cmdSourceMode,
		cmdAmpereMode: cmdAmpereMode,
		defaultModifiers: defaultModifiers,
		parseMetadata: parseMetadata,
		Converter: Converter,
		SampleParser: SampleParser,
		RateAdjuster: RateAdjuster,
		FoldingBuffer: FoldingBuffer,
	}
})()
