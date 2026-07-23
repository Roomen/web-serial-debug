;// EMK850+ 协议核心（纯逻辑，无 DOM）— 对照反编译 MainWindow/Protocol
(function () {
	'use strict'

	const PROTO_SIZE = 64
	const MAGIC = 0x33
	const PAYLOAD_OFFSET = 4
	const PAYLOAD_LEN = 60
	const SAMPLES_PER_FRAME = 14
	const SAMPLE_SIZE = 4
	const SAMPLE_SKIP = 4

	const CMD = {
		REQ_VERSION: 0x10,
		RES_VERSION: 0x11,
		REQ_POWERON: 0x12,
		RES_POWERON: 0x13,
		REQ_POWEROFF: 0x14,
		// 上位机下电 Toggle 实际发送的是 0x15（常量名 RES_POWEROFF）
		DO_POWEROFF: 0x15,
		RES_POWEROFF: 0x15,
		REQ_START: 0x16,
		REQ_STOP: 0x18,
		RES_STOP: 0x19,
		RESULT: 0x21,
		SYNC: 0x23,
		REQ_WRITE_CONFIG: 0x30,
		RES_WRITE_CONFIG: 0x31,
		REQ_READ_CONFIG: 0x32,
		RES_READ_CONFIG: 0x33,
		BIG_DATA: 0x40,
		BIG_DATA_ACK: 0x41,
		BIG_DATA_FIRST: 0x42,
		BIG_DATA_LAST: 0x44,
		USER_STOP: 0x5F,
		USER_START: 0x60,
		// AM 机设压：payload u16 = volt*10（0.1V 步进），0=下电
		USER_CONFIG_VOLT: 0x61,
		USER_CURRENT_RESULT: 0x62,
		USER_VOLT_RESULT: 0x63,
		REQ_100K: 0x82,
		REQ_10K: 0x83,
		REQ_HIGH_SPEED_DATA: 0x84,
		REQ_READ_ALARMCONFIG: 0x68,
		// 自动保护限值配置：payload float 过流(mA) + float 过压(V)
		AUTO_PROTECT: 0x72,
		ALARM1: 0x66,
		ALARM2: 0x67,
	}

	function buildFrame(cmd, payload) {
		const buf = new Uint8Array(PROTO_SIZE)
		buf[0] = MAGIC
		buf[1] = cmd
		if (payload && payload.length) {
			const n = Math.min(payload.length, PAYLOAD_LEN)
			buf[2] = n
			buf.set(payload.subarray(0, n), PAYLOAD_OFFSET)
		}
		return buf
	}

	function buildSendCmd(cmd) {
		return buildFrame(cmd, null)
	}

	function FrameParser() {
		this._buf = new Uint8Array(0)
	}

	FrameParser.prototype.push = function (data) {
		const merged = new Uint8Array(this._buf.length + data.length)
		merged.set(this._buf)
		merged.set(data, this._buf.length)
		this._buf = merged

		const frames = []
		let offset = 0

		// 上位机不校验 zero：BIG_DATA 续包 zero=序号(1,2,…)
		while (offset <= this._buf.length - PROTO_SIZE) {
			if (this._buf[offset] !== MAGIC) {
				offset++
				continue
			}
			const candidate = this._buf.subarray(offset, offset + PROTO_SIZE)
			const cmd = candidate[1]
			const len = candidate[2]
			const payloadCopy = new Uint8Array(PAYLOAD_LEN)
			payloadCopy.set(candidate.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + PAYLOAD_LEN))
			frames.push({
				magic: candidate[0],
				cmd: cmd,
				len: len > PAYLOAD_LEN ? PAYLOAD_LEN : len,
				zero: candidate[3],
				payload: payloadCopy,
				raw: new Uint8Array(candidate),
			})
			offset += PROTO_SIZE
		}

		if (offset > 0) {
			this._buf = this._buf.slice(offset)
		}
		if (this._buf.length > PROTO_SIZE * 32) {
			this._buf = this._buf.slice(this._buf.length - PROTO_SIZE * 4)
		}
		return frames
	}

	FrameParser.prototype.reset = function () {
		this._buf = new Uint8Array(0)
	}

	// ---- 采样解析 ----
	// isHave5A=false: voltage u16 + current i16
	// isHave5A=true:  voltage u16 + current u16
	function parseSamples(payload, opts) {
		opts = opts || {}
		const isHave5A = !!opts.isHave5A || !!opts.unsigned
		const samples = []
		const start = typeof opts.offset === 'number' ? opts.offset : SAMPLE_SKIP
		for (let i = start; i + SAMPLE_SIZE <= payload.length && samples.length < SAMPLES_PER_FRAME; i += SAMPLE_SIZE) {
			const voltageRaw = payload[i] | (payload[i + 1] << 8)
			let currentRaw = payload[i + 2] | (payload[i + 3] << 8)
			if (!isHave5A) {
				// signed i16 current
				if (currentRaw > 0x7fff) currentRaw -= 0x10000
			}
			const grade = (voltageRaw & 0xF000) >>> 14
			samples.push({ voltageRaw: voltageRaw, currentRaw: currentRaw, grade: grade })
		}
		return samples
	}

	// 高速帧（0x84 / CMD_REQ_HIGH_SPEED_DATA）：仅激活了 100K/10µs 档的机器才会上报。
	// 布局（对照 HandleSampleHighSpeed）：
	//   payload[0..8]  每采样 3bit 的档位表（getChNumberToServer）
	//   payload[9..]   25 × u16：第 1 个是电压 raw，其余 24 个是电流 raw
	//   payload[59]    模式：2 = 无符号(SampleUint_HighSpeed)，否则有符号
	const HS_HEADER_LEN = 9
	const HS_ENTRIES = 25

	function hsChannel(header, index) {
		let ch = 0
		let byteIdx = (index * 3 / 8) | 0
		let bitIdx = (index * 3) % 8
		for (let b = 0; b < 3; b++) {
			if (byteIdx < header.length && (header[byteIdx] & (1 << bitIdx))) ch += (1 << b)
			bitIdx++
			if (bitIdx >= 8) {
				byteIdx++
				bitIdx = 0
			}
		}
		return ch
	}

	function parseHighSpeedSamples(payload, opts) {
		opts = opts || {}
		if (!payload || payload.length < HS_HEADER_LEN + 4) return []
		const mode = payload[59]
		const unsigned = mode === 2 || !!opts.isHave5A
		const samples = []
		let voltageRaw = 0
		for (let n = 0; n < HS_ENTRIES; n++) {
			const i = HS_HEADER_LEN + n * 2
			if (i + 1 >= payload.length) break
			let raw = payload[i] | (payload[i + 1] << 8)
			if (n === 0) {
				voltageRaw = raw & 0xffff
				continue
			}
			if (!unsigned && raw > 0x7fff) raw -= 0x10000
			samples.push({
				voltageRaw: voltageRaw,
				currentRaw: raw,
				ch: hsChannel(payload, n - 1),
				highSpeed: true,
			})
		}
		return samples
	}

	// 内部电流单位：mA（与上位机 FormatCurrent0 一致，显示前 /1000 得 A）
	function convertSample(sample, conf) {
		const c = conf || defaultConf()
		const grade = sample.grade | 0
		const currentRaw = sample.currentRaw
		const voltageRaw = sample.voltageRaw

		let om = c.om1 || 1
		let o = c.o1 || 0
		let p = c.p1 || 0
		if (grade === 1) {
			om = c.om3 || 1
			o = c.o3 || 0
			p = c.p3 || 0
		} else if (grade === 2) {
			om = c.om2 || 1
			o = c.o2 || 0
			p = c.p2 || 0
		} else if (grade === 3) {
			// 特殊通道，近似用 om2
			om = c.om2 || 1
			o = c.o2 || 0
			p = c.p2 || 0
		}

		// 高速帧的档位来自 3bit 通道表，映射与 HandleSampleHighSpeed 一致：
		// ch0→om1 ch1→om2 ch2→om3；ch3/ch4 是 Channel5 配置（本工具未解析），退回 om3
		if (sample.highSpeed) {
			const ch = sample.ch | 0
			if (ch === 1) {
				om = c.om2 || 1; o = c.o2 || 0; p = c.p2 || 0
			} else if (ch === 2 || ch >= 3) {
				om = c.om3 || 1; o = c.o3 || 0; p = c.p3 || 0
			} else {
				om = c.om1 || 1; o = c.o1 || 0; p = c.p1 || 0
			}
		}

		const vref = c.voltage != null && c.voltage !== 0 ? c.voltage : 3.3
		let g1 = c.g1
		if (g1 == null || !isFinite(g1) || Math.abs(g1) < 1e-30) g1 = 1
		if (!isFinite(om) || Math.abs(om) < 1e-30) om = 1

		const adcMag = c.adc_magnification != null && c.adc_magnification !== 0
			? c.adc_magnification
			: 7.8

		// mA = (raw+offset) * Vref / 65536 / g1 / om * 1000
		let currentMA = (currentRaw + (c.offset || 0)) * vref / 65536.0 / g1 / om * 1000.0
		currentMA = currentMA + currentMA * p + o

		// 高速帧电压是完整 u16（上位机 /65535），普通帧取低 12bit
		const vraw = sample.highSpeed ? (voltageRaw & 0xFFFF) : (voltageRaw & 0x0FFF)
		let voltageV = sample.highSpeed
			? vraw * vref / 65535.0 * adcMag
			: vraw * vref / 4096.0 * adcMag
		// 上位机：volt = volt + volt * pv + ov
		voltageV = voltageV + voltageV * (c.pv != null ? c.pv : 0) + (c.ov || 0)

		const currentUA = currentMA * 1000.0
		// P(W) = I_mA * V / 1000  →  µW = I_mA * V * 1000 = I_µA * V
		const powerUW = currentUA * voltageV

		return {
			currentMA: currentMA,
			currentUA: currentUA,
			voltageV: voltageV,
			powerUW: powerUW,
			powerW: powerUW / 1e6,
			grade: grade,
		}
	}

	function defaultConf() {
		return {
			voltage: 3.3,
			offset: 0,
			max: 0,
			g1: 1,
			om1: 1, o1: 0, p1: 0,
			g2: 0,
			om2: 1, o2: 0, p2: 0,
			g3: 0,
			om3: 1, o3: 0, p3: 0,
			o4: 0, p4: 0,
			o5: 0, p5: 0,
			ov: 0,
			pv: 0,
			ch2_min: 0, ch2_max: 0,
			ch4_min: 0, ch4_max: 0,
			ch5_min: 0, ch5_max: 0,
			adc_magnification: 7.8,
			loaded: false,
		}
	}

	const CONF_FIELDS = [
		'voltage', 'offset', 'max', 'g1',
		'om1', 'o1', 'p1',
		'g2', 'om2', 'o2', 'p2',
		'g3', 'om3', 'o3', 'p3',
		'o4', 'p4', 'o5', 'p5',
		'ov', 'pv',
		'ch2_min', 'ch2_max', 'ch4_min', 'ch4_max', 'ch5_min', 'ch5_max',
	]

	function parseConfigBytes(bytes) {
		if (!bytes || bytes.length < 8) return null
		const conf = defaultConf()
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const n = Math.min(Math.floor(bytes.length / 8), CONF_FIELDS.length)
		let ok = 0
		for (let i = 0; i < n; i++) {
			const v = view.getFloat64(i * 8, true)
			if (isFinite(v)) {
				conf[CONF_FIELDS[i]] = v
				ok++
			}
		}
		if (ok < 4 || !isFinite(conf.voltage) || conf.voltage === 0) return null
		if (!isFinite(conf.g1) || Math.abs(conf.g1) < 1e-30) conf.g1 = 1
		conf.adc_magnification = conf.adc_magnification || 7.8
		conf.loaded = true
		return conf
	}

	function tryParseConfig(payload) {
		return parseConfigBytes(payload)
	}

	// BIG_DATA 组装：FIRST(0x42) + 续包(0x40)
	function BigDataAssembler() {
		this.reset()
	}

	BigDataAssembler.prototype.reset = function () {
		this._buf = null
		this._len = 0
		this._sum = 0
		this._recv = 0
		this._active = false
	}

	// WriteData 格式：payload[0]=what, [4]=dataLen, [8]=byteSum, [12..]=首 48B 数据
	// 续包 cmd=0x40，zero=序号，len=本包数据长（可能 60）
	BigDataAssembler.prototype.onFrame = function (frame) {
		if (frame.cmd === CMD.BIG_DATA_FIRST) {
			const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength)
			const what = view.getUint32(0, true)
			const dataLen = view.getUint32(4, true)
			const sum = view.getUint32(8, true)
			if (dataLen === 0 || dataLen > 10240) {
				this.reset()
				return { error: 'bad_len', dataLen: dataLen, what: what }
			}
			this._buf = new Uint8Array(dataLen)
			this._len = dataLen
			this._sum = sum >>> 0
			this._what = what
			this._active = true
			if (dataLen <= 48) {
				// 与上位机小包分支一致（历史写法）
				const n = Math.min(dataLen, 48)
				this._buf.set(frame.payload.subarray(12, 12 + n), 0)
				this._recv = n
				return this._finish()
			}
			this._buf.set(frame.payload.subarray(12, 12 + 48), 0)
			this._recv = 48
			return { partial: true, recv: this._recv, total: this._len, what: what }
		}
		if (frame.cmd === CMD.BIG_DATA && this._active && this._buf) {
			// len=0 时仍可能带满 60B（与 RESULT 类似）；优先用 len，否则尽量填满剩余
			let n = frame.len | 0
			if (n <= 0 || n > PAYLOAD_LEN) n = Math.min(PAYLOAD_LEN, this._len - this._recv)
			if (n <= 0) return null
			if (this._recv + n > this._len) n = this._len - this._recv
			this._buf.set(frame.payload.subarray(0, n), this._recv)
			this._recv += n
			if (this._recv >= this._len) return this._finish()
			return { partial: true, recv: this._recv, total: this._len }
		}
		return null
	}

	BigDataAssembler.prototype._finish = function () {
		let sum = 0
		for (let i = 0; i < this._buf.length; i++) sum = (sum + this._buf[i]) >>> 0
		const ok = sum === this._sum
		const data = this._buf
		const what = this._what
		this.reset()
		const conf = parseConfigBytes(data)
		if (!conf) {
			return { error: 'parse_fail', dataLen: data.length, sumOk: ok, what: what, data: data }
		}
		conf._sumMismatch = !ok
		conf._what = what
		conf._dataLen = data.length
		return conf
	}

	// da = base + (3.0 - V - compensate) / 0.1 * 25
	// C# 用 (ushort)截断；pv/ov 命中特殊值时换 base
	function voltToDa(volt, opts) {
		opts = opts || {}
		let v = volt
		if (v < 0) v = 0
		if (v > 24) v = 24
		let base = opts.baseDa != null ? opts.baseDa : 3320
		const compensate = opts.compensate != null ? opts.compensate : 0
		const pv = opts.pv
		const ov = opts.ov
		if (pv === -0.000510204 || (typeof pv === 'number' && Math.abs(pv + 0.000510204) < 1e-9)) {
			base = 3300
		} else if (typeof ov === 'number' && Math.abs(ov + 0.78) < 0.05) {
			// 本机 ov≈-0.79，上位机写死 == -0.78 → 3340
			base = 3340
		}
		// 与 C# (ushort)(double) 一致：向 0 截断
		let da = (base + (3.0 - v - compensate) / 0.1 * 25) | 0
		if (da < 0) da = 0
		if (da > 4095) da = 4095
		return da
	}

	function daToApproxVolt(da, baseDa) {
		const b = baseDa != null ? baseDa : 3320
		return 3.0 - (da - b) / 25 * 0.1
	}

	function buildPowerOn(voltV, conf, opts) {
		const c = conf || {}
		opts = opts || {}
		const da = opts.da != null ? opts.da : voltToDa(voltV, {
			pv: c.pv,
			ov: c.ov,
			compensate: opts.compensate,
			baseDa: opts.baseDa,
		})
		const payload = new Uint8Array(6)
		const view = new DataView(payload.buffer)
		view.setUint16(0, da & 0xffff, true)
		view.setFloat32(2, voltV, true)
		return buildFrame(CMD.REQ_POWERON, payload)
	}

	// AM/用户模式设压：FactoryVoltConfig.volt = (ushort)(V*10)
	function buildUserConfigVolt(voltV) {
		let v = isFinite(voltV) ? voltV : 0
		if (v < 0) v = 0
		if (v > 24) v = 24
		// AM 机型实机验证：u16 = V*10，固件上限 code=130 (13.00V)
		// 0x69 回报是 0.01V 单位（i0/100），但设值口只有 0.1V 分辨率
		const code = Math.round(v * 10)
		const payload = new Uint8Array(2)
		new DataView(payload.buffer).setUint16(0, code & 0xffff, true)
		return buildFrame(CMD.USER_CONFIG_VOLT, payload)
	}

	function buildPowerOff() {
		// 经典机型 Toggle 关发 0x15；AM 机无效，调用方应优先 buildUserConfigVolt(0)
		return buildSendCmd(CMD.DO_POWEROFF)
	}

	function buildStart(threshold1, threshold2) {
		const t1 = threshold1 != null ? threshold1 : 32000
		const t2 = threshold2 != null ? threshold2 : 0
		const payload = new Uint8Array(4)
		const view = new DataView(payload.buffer)
		view.setInt16(0, t1, true)
		view.setInt16(2, t2, true)
		return buildFrame(CMD.REQ_START, payload)
	}

	function buildStop(stopOutputVolt) {
		const buf = buildSendCmd(CMD.REQ_STOP)
		if (stopOutputVolt) buf[2] = 1
		return buf
	}

	// 解析 alarm1 帧中的 adc_magnification（avg_1）
	// 仅接受合理范围；本机 avg_1=0.05 是阈值不是放大系数
	function tryParseAlarmAdcMag(frame) {
		if (!frame || frame.cmd !== CMD.ALARM1) return null
		if (frame.len < 12) return null
		const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength)
		const avg1 = view.getFloat32(8, true)
		if (!isFinite(avg1)) return null
		if (avg1 === 0) return 7.8
		if (avg1 < 1 || avg1 > 30) return null
		return avg1
	}

	// 0x69 VOLTSET 状态：int32 序列（isAutoProtect 路径）
	function parseVoltSetStatus(frame) {
		if (!frame || frame.cmd !== 0x69) return null
		const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength)
		if (frame.payload.length < 12) return null
		const i0 = view.getInt32(0, true)
		const i1 = view.getInt32(4, true)
		const i2 = view.getInt32(8, true)
		const out = {
			voltageSet: i0 / 100,
			currentClear: i1 / 100000,
			voltMcuSend: i2 / 100,
		}
		// AM 机型实机验证：i4/i5 = 自动保护过流(µA)/过压(mV)，未配置时为 0
		if (frame.payload.length >= 24) {
			out.protectCurrentMA = view.getInt32(16, true) / 1000
			out.protectVoltV = view.getInt32(20, true) / 1000
		}
		return out
	}

	// 0x72 自动保护配置（isAutoProtect 固件，日期 ≥ 22083001）
	// 实机验证：未配置（过流/过压均为 0）时设备一启动采样就自我保护下电，
	// 只发一帧 0x21 后再无波形。上位机在「用户设置」里用本帧下发限值。
	function buildAutoProtect(currentMA, voltV) {
		const payload = new Uint8Array(60)
		const view = new DataView(payload.buffer)
		view.setFloat32(0, isFinite(currentMA) ? currentMA : 0, true)
		view.setFloat32(4, isFinite(voltV) ? voltV : 0, true)
		return buildFrame(CMD.AUTO_PROTECT, payload)
	}

	window.EmkProtocol = {
		CMD,
		PROTO_SIZE,
		MAGIC,
		buildFrame,
		buildSendCmd,
		FrameParser,
		BigDataAssembler,
		parseSamples,
		parseHighSpeedSamples,
		convertSample,
		defaultConf,
		tryParseConfig,
		parseConfigBytes,
		voltToDa,
		daToApproxVolt,
		buildPowerOn,
		buildUserConfigVolt,
		buildPowerOff,
		buildStart,
		buildStop,
		tryParseAlarmAdcMag,
		parseVoltSetStatus,
		buildAutoProtect,
	}
})()
