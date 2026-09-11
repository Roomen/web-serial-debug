// SK188 (188协议) 解析 + 下行构造
// 帧: 68 10 [表号7B] [控制码1B] [数据长度1B] [数据标识2B] [序号1B] [数据N B] [校验和1B] 16
// 控制码: bit0-5=功能码 bit6=通讯状态 bit7=方向(0=下行请求 1=上行应答)
// 校验和 = 帧头(68)起到校验和前所有字节按字节求和取低8位; 应答帧比请求帧多3字节 FE FE FE 前导(不参与校验)
// 本工具扮演平台/主机角色: 构造读/写/阀控请求下发给设备, 解析设备应答。
// 依据: /Users/logan/Documents/code/SECK/FlowLogic/Protocol/SK188/sk188.{h,c} (未随本仓库分发)
// cmd=0x09(读密钥版本) 设备端未实现应答分支, 本模块不支持。
;(function () {
	'use strict'
	const W = window

	function toBytesHex(s) {
		let str = String(s || '').trim().replace(/\s+/g, '')
		if (str.length % 2 !== 0) str = '0' + str
		if (!/^[0-9a-fA-F]*$/.test(str)) return new Uint8Array(0)
		const a = new Uint8Array(str.length / 2)
		for (let i = 0; i < a.length; i++) a[i] = parseInt(str.substr(i * 2, 2), 16)
		return a
	}
	function hexByte(b) { return '0x' + ((b & 0xff) < 16 ? '0' : '') + (b & 0xff).toString(16).toUpperCase() }
	function hexbytes(b) {
		let s = ''
		for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16).toUpperCase()
		return s
	}
	function hexBytesSpaced(b) {
		const out = []
		for (let i = 0; i < b.length; i++) out.push(((b[i] < 16 ? '0' : '') + b[i].toString(16).toUpperCase()))
		return out.join(' ')
	}
	function escHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
	}
	// BCD 大端: 每字节高4位+低4位各一位十进制数字, 数组顺序即字符串顺序(与地址/表号字段一致)
	function bcdDecodeBE(b) {
		let s = ''
		for (let i = 0; i < b.length; i++) s += ((b[i] >> 4) & 0xf).toString(10) + (b[i] & 0xf).toString(10)
		return s
	}
	// 小端 BCD 数组 -> 十进制整数(4字节以内, 用于流量/底度字段); 数组从低位字节开始
	function bcdLeToInt(b) {
		let s = ''
		for (let i = b.length - 1; i >= 0; i--) s += ((b[i] >> 4) & 0xf).toString(10) + (b[i] & 0xf).toString(10)
		return parseInt(s.replace(/^0+(?=\d)/, ''), 10) || 0
	}
	function intToBcdLe(v, len) {
		let digits = String(Math.max(0, Math.trunc(v)) || 0)
		while (digits.length < len * 2) digits = '0' + digits
		digits = digits.slice(-len * 2)
		const out = new Uint8Array(len)
		for (let i = 0; i < len; i++) {
			const hi = parseInt(digits[digits.length - 2 - i * 2], 10)
			const lo = parseInt(digits[digits.length - 1 - i * 2], 10)
			out[i] = (hi << 4) | lo
		}
		return out
	}

	const HEADER = [0x68, 0x10]
	const END_BYTE = 0x16
	const ADDR_SIZE = 7
	const BROADCAST_ADDR = 'AA AA AA AA AA AA AA'

	const CMD_TABLE = {
		0x01: { name: '读数据' },
		0x03: { name: '读表号' },
		0x04: { name: '阀控' },
		0x15: { name: '写表号' },
		0x16: { name: '写底度' },
	}
	// 数据标识: 请求/应答共用同一对, 部分设备固件接受两种字节序
	const IDENT = {
		0x01: [0x90, 0x1f],
		0x03: [0x0a, 0x81],
		0x04: [0xa0, 0x17],
		0x15: [0xa0, 0x18],
		0x16: [0xa0, 0x16],
	}
	function identMatches(cmd, id0, id1) {
		if (cmd === 0x01 && id0 === 0x1e && id1 === 0x90) return true
		const p = IDENT[cmd]
		if (!p) return false
		return (id0 === p[0] && id1 === p[1]) || (id0 === p[1] && id1 === p[0])
	}
	const VALVE_OP = { 0x55: '开阀', 0x99: '关阀', 0x77: '除锈' }
	const VALVE_STATE = { 0: '开', 1: '关', 3: '异常/未知' }

	function decodeStatus2(b) {
		// 线序: byte0=厂内预留(factoryReserved1) byte1=打包位: bit0-1阀门状态 bit2电量状态
		if (!b || b.length < 2) return '(数据不足)'
		const packed = b[1]
		const valve = packed & 0x3
		const battery = (packed >> 2) & 0x1
		return '阀门状态=' + (VALVE_STATE[valve] || ('未知(' + valve + ')')) + ' 电量状态=' + (battery ? '低电' : '正常')
	}

	function isBroadcastAddr(addr) {
		for (let i = 0; i < addr.length; i++) if (addr[i] !== 0xaa) return false
		return true
	}
	function describeAddr(addr) {
		return hexbytes(addr) + (isBroadcastAddr(addr) ? ' (广播,全部通配)' : ' (BCD=' + bcdDecodeBE(addr) + ')')
	}

	function checksum(bytes, len) {
		let s = 0
		for (let i = 0; i < len; i++) s = (s + bytes[i]) & 0xff
		return s
	}

	// ===== 请求内容构造 (dataLen = 2标识 + 1序号 + content.length) =====
	function buildContent(cmd, seq, opt) {
		switch (cmd) {
			case 0x01: // 读数据: 无请求参数
			case 0x03: // 读表号: 无请求参数
				return new Uint8Array(0)
			case 0x04: { // 阀控: 1字节操作码
				const op = (opt.valveOp != null ? opt.valveOp : 0x55) & 0xff
				if (!VALVE_OP[op]) throw new Error('阀控操作码非法(需 0x55/0x99/0x77)')
				return new Uint8Array([op])
			}
			case 0x15: { // 写表号: 新表号7字节
				const addr = toBytesHex(opt.newAddr || '')
				if (addr.length !== ADDR_SIZE) throw new Error('新表号需 ' + ADDR_SIZE + ' 字节 HEX')
				return addr
			}
			case 0x16: { // 写底度: 4字节小端BCD, 帧上单位为10L(见 sk188.c comToLittleEndianBCDArrayToUnsignedInt(...)×10); 面板按 m³ 输入,这里转换
				const m3 = Number(opt.degreeM3)
				if (!Number.isFinite(m3) || m3 < 0) throw new Error('底度需为非负数字(单位m³)')
				const literL = Math.round(m3 * 1000)
				return intToBcdLe(Math.round(literL / 10), 4)
			}
			default:
				throw new Error('不支持的功能码 ' + hexByte(cmd))
		}
	}

	// ===== 下行构造 =====
	W.sk188BuildDownFrame = function (opt) {
		opt = opt || {}
		const cmd = (typeof opt.cmd === 'string') ? parseInt(opt.cmd, 16) : opt.cmd
		if (!CMD_TABLE[cmd]) throw new Error('不支持的功能码 ' + opt.cmd)
		const addr = toBytesHex(opt.addr || '')
		if (addr.length !== ADDR_SIZE) throw new Error('表号需 ' + ADDR_SIZE + ' 字节 HEX (全 AA = 广播,所有设备都会应答)')
		const seq = (opt.seq != null ? opt.seq : 0) & 0xff
		const commuStatus = opt.commuStatus ? 1 : 0
		const content = buildContent(cmd, seq, opt)
		const ident = cmd === 0x01 && opt.extendedRead ? [0x1e, 0x90] : IDENT[cmd]
		const dataLen = 2 + 1 + content.length

		const frame = new Uint8Array(13 + dataLen)
		frame.set(HEADER, 0)
		frame.set(addr, 2)
		frame[9] = (cmd & 0x3f) | ((commuStatus & 1) << 6) // dataFrom=0(下行请求)
		frame[10] = dataLen
		frame[11] = ident[0]
		frame[12] = ident[1]
		frame[13] = seq
		frame.set(content, 14)
		const cs = checksum(frame, 14 + content.length)
		frame[14 + content.length] = cs
		frame[15 + content.length] = END_BYTE
		return frame
	}

	W.skUltrasonicBuildDownFrame = function (opt) {
		return W.sk188BuildDownFrame(Object.assign({}, opt, { extendedRead: true }))
	}

	// 901E: TLV; 累计量为小端 uint32 m³ + uint16 L + 单位码。
	function decodeExtended(content, errors) {
		const names = ['软件版本', '正向累计流量', '反向累计流量', '瞬时流量', '水温', '环境温度', '压力', '电池电压', '状态', '净累计流量', '净流量方向']
		const lengths = [8, 7, 7, 5, 2, 2, 2, 2, 3, 7, 3]
		const lines = []
		if (!content.length) errors.push('拓展读数据应答内容为空')
		for (let pos = 0; pos < content.length;) {
			if (pos + 2 > content.length) { errors.push('拓展字段头长度不足'); break }
			const tag = content[pos++], len = content[pos++]
			const name = names[tag] || ('未知字段 ' + hexByte(tag))
			if (pos + len > content.length) { errors.push(name + '内容长度不足'); break }
			const data = content.subarray(pos, pos + len)
			pos += len
			if (lengths[tag] !== undefined && len !== lengths[tag]) {
				errors.push(name + '长度错误(需' + lengths[tag] + '字节)')
				continue
			}
			const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
			let value = hexBytesSpaced(data)
			if (tag === 1 || tag === 2 || tag === 9) {
				const m3 = view.getUint32(0, true), liters = view.getUint16(4, true)
				if (liters > 999) errors.push(name + '余量升超出0–999')
				if (data[6] !== 0x29) errors.push(name + '单位标识不支持: ' + hexByte(data[6]))
				value = m3 + '.' + String(liters).padStart(3, '0') + ' m³'
			} else if (tag === 3) {
				value = view.getInt32(0, true) + ' (单位标识=' + hexByte(data[4]) + ')'
			} else if (tag === 4 || tag === 5) {
				value = (view.getInt16(0, true) / 10).toFixed(1) + ' °C'
			} else if (tag === 6) {
				value = String(view.getUint16(0, true)) + ' (原始值)'
			} else if (tag === 7) {
				value = (view.getUint16(0, true) / 100).toFixed(2) + ' V'
			} else if (tag === 8) {
				value += ' (低电=' + !!(data[2] & 0x40) + ' 空管=' + !!(data[2] & 0x10)
					+ ' 计量异常=' + !!(data[2] & 0x08) + ' 电池拆卸=' + !!(data[2] & 0x04) + ')'
			} else if (tag === 10) {
				value = data[0] === 0 ? '正向' : data[0] === 1 ? '反向' : '未知(' + data[0] + ')'
			}
			lines.push(name + ' = ' + value)
		}
		return lines.join('\n')
	}

	// ===== 查找帧 (跳过应答帧可能带的 FE FE FE 前导) =====
	W.sk188FindFrame = function (bytes, opt) {
		const b = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || [])
		const empty = { found: false, offset: 0, length: b.length, frame: b, prefix: 0, suffix: 0 }
		for (let i = 0; i + 11 <= b.length; i++) {
			if (b[i] !== HEADER[0] || b[i + 1] !== HEADER[1]) continue
			const dataLen = b[i + 10]
			if (dataLen < 3) continue
			const total = 13 + dataLen
			if (i + total > b.length) continue
			if (b[i + total - 1] !== END_BYTE) continue
			if (checksum(b.subarray(i), total - 2) !== b[i + total - 2]) continue
			const frame = new Uint8Array(b.subarray(i, i + total))
			return { found: true, offset: i, length: total, frame, prefix: i, suffix: b.length - i - total }
		}
		return empty
	}

	// ===== 解析 =====
	W.sk188ParseFrame = function (bytes, opt) {
		const raw = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || [])
		let frameOffset = 0
		while (raw[frameOffset] === 0xfe) frameOffset++
		const b = raw.subarray(frameOffset)
		const result = { raw: Array.from(raw), frameOffset, ok: false, errors: [], fields: {} }
		const errors = result.errors
		if (b.length < 2) { errors.push('长度不足,缺少帧头 68 10'); return result }
		if (b[0] !== HEADER[0] || b[1] !== HEADER[1]) {
			errors.push('帧头不匹配(需 68 10,实际 ' + hexBytesSpaced(b.subarray(0, 2)) + ')')
			if (b.length >= 16 && b[0] === 0x68 && b[9] === 0x95 && b[10] === 3 &&
				b[11] === 0xa0 && b[12] === 0x18 && b[15] === END_BYTE && checksum(b, 14) === b[14]) {
				errors.push('疑似写表号应答地址偏移错误：0x10 被表号覆盖，请检查设备固件；此报文不能作为有效帧')
			}
			return result
		}
		if (b.length < 11) { errors.push('长度不足,缺少数据长度字段'); return result }
		const dataLen = b[10]
		if (dataLen < 3) { errors.push('数据长度不足,至少需3字节(数据标识2字节+序号1字节)'); return result }
		const total = 13 + dataLen
		if (b.length < total) { errors.push('长度不足,需 ' + total + ' 字节,实际 ' + b.length); return result }
		if (b[total - 1] !== END_BYTE) errors.push('帧尾非 0x16')
		const csCalc = checksum(b, total - 2)
		const csGot = b[total - 2]
		if (csCalc !== csGot) errors.push('校验和不符,计算=' + hexByte(csCalc) + ' 实际=' + hexByte(csGot))

		const addr = b.subarray(2, 9)
		const ctrl = b[9]
		const cmd = ctrl & 0x3f
		const commuStatus = (ctrl >> 6) & 1
		const dataFrom = (ctrl >> 7) & 1
		const id0 = b[11], id1 = b[12]
		const seq = b[13]
		const content = b.subarray(14, 14 + Math.max(0, dataLen - 3))
		const cmdDef = CMD_TABLE[cmd]
		if (cmdDef && !identMatches(cmd, id0, id1)) errors.push('数据标识与功能码不匹配')

		result.dir = dataFrom ? 'up' : 'down'
		result.fields = {
			方向: dataFrom ? '↑ 应答(设备→平台)' : '↓ 请求(平台→设备)',
			表号: describeAddr(addr),
			功能码: { value: hexByte(cmd), name: cmdDef ? cmdDef.name : '未知' },
			通讯状态: commuStatus,
			数据标识: hexByte(id0) + ' ' + hexByte(id1),
			序号: seq,
		}

		if (cmdDef) {
			switch (cmd) {
				case 0x01:
					if (id0 === 0x1e && id1 === 0x90) {
						result.decoded = dataFrom ? decodeExtended(content, errors) : '(拓展读数据请求 901E, 无参数)'
					} else if (dataFrom && content.length >= 19) {
						const f1 = bcdLeToInt(content.subarray(0, 4)), u1 = content[4]
						const f2 = bcdLeToInt(content.subarray(5, 9)), u2 = content[9]
						const status = content.subarray(17, 19)
						result.decoded = '当前累计流量 BCD值=' + f1 + ' 单位标识=' + hexByte(u1)
							+ '\n日结算流量 BCD值=' + f2 + ' 单位标识=' + hexByte(u2)
							+ '\n(单位标识→实际数值的换算需按现场协议约定, 本工具只还原 BCD 原始值)'
							+ '\n' + decodeStatus2(status)
					} else if (!dataFrom) {
						result.decoded = '(读数据请求, 无参数)'
					} else {
						errors.push('读数据应答内容长度不足(需≥19字节)')
					}
					break
				case 0x03:
					result.decoded = dataFrom ? '表号即上方地址字段' : '(读表号请求, 无参数)'
					break
				case 0x04:
					if (!dataFrom && content.length >= 1) {
						result.decoded = '阀控操作 = ' + (VALVE_OP[content[0]] || ('未知(' + hexByte(content[0]) + ')'))
					} else if (dataFrom && content.length >= 2) {
						result.decoded = decodeStatus2(content)
					} else {
						result.decoded = dataFrom ? '(应答内容长度不足)' : '(请求内容长度不足)'
					}
					break
				case 0x15:
					result.decoded = !dataFrom
						? (content.length >= ADDR_SIZE ? '新表号 = ' + hexbytes(content.subarray(0, ADDR_SIZE)) : '(内容长度不足)')
						: '写入后表号即上方地址字段'
					break
				case 0x16:
					if (!dataFrom) {
						if (content.length >= 4) {
							const literL = bcdLeToInt(content.subarray(0, 4)) * 10
							result.decoded = '底度 = ' + literL + ' L (' + (literL / 1000).toFixed(3) + ' m³)'
						} else {
							result.decoded = '(内容长度不足)'
						}
					} else {
						result.decoded = '(写底度应答, 无数据内容)'
					}
					break
			}
		}

		result.ok = errors.length === 0
		return result
	}

	W.sk188FormatFrame = function (r) {
		let h = '<div class="sk-parse">'
		h += '<div class="sk-parse-bar">' + (r.ok ? '✓' : '✗') + '</div>'
		const f = r.fields || {}
		const cells = []
		for (const k in f) {
			const v = f[k]
			const val = (v != null && typeof v === 'object' && v.name !== undefined) ? (v.value + ' (' + escHtml(v.name) + ')') : escHtml(String(v))
			cells.push({ name: k, value: val })
		}
		if (cells.length) {
			const COLS = 3
			h += '<table class="sk-parse-grid"><tbody>'
			for (let i = 0; i < cells.length; i += COLS) {
				h += '<tr>'
				for (let j = 0; j < COLS; j++) h += '<td class="sk-parse-hdr">' + (cells[i + j] ? escHtml(cells[i + j].name) : '') + '</td>'
				h += '</tr><tr>'
				for (let j = 0; j < COLS; j++) h += '<td>' + (cells[i + j] ? cells[i + j].value : '') + '</td>'
				h += '</tr>'
			}
			h += '</tbody></table>'
		}
		if (r.decoded) {
			h += '<div class="sk-parse-tlvs"><details class="sk-parse-tag" open><summary>数据域解析</summary>' +
				'<div class="sk-parse-items"><pre style="white-space:pre-wrap;margin:0;">' + escHtml(r.decoded) + '</pre></div></details></div>'
		}
		if (r.errors && r.errors.length) {
			h += '<div class="sk-parse-errors">'
			for (const e of r.errors) h += '<div>' + escHtml(e) + '</div>'
			h += '</div>'
		}
		h += '</div>'
		return h
	}

	W.sk188ByteMap = function (r) {
		const bytes = (r.raw instanceof Uint8Array) ? r.raw : Uint8Array.from(r.raw || [])
		const offset = r.frameOffset || 0
		const raw = bytes.subarray(offset)
		const n = raw.length
		const map = new Array(bytes.length).fill('')
		for (let i = 0; i < offset; i++) map[i] = '前导 = FE (不参与校验)'
		if (n < 13 || raw[0] !== HEADER[0] || raw[1] !== HEADER[1] || raw[10] < 3) return map
		const dataLen = raw[10]
		const set = (off, len, tip) => { for (let k = 0; k < len; k++) if (off + k < n) map[offset + off + k] = tip }
		set(0, 2, '帧头 = 68 10')
		set(2, ADDR_SIZE, '表号 = ' + describeAddr(raw.subarray(2, 9)))
		set(9, 1, '控制码 = ' + hexByte(raw[9]) + ' (功能码=' + hexByte(raw[9] & 0x3f) + ', 方向=' + ((raw[9] >> 7) & 1 ? '应答' : '请求') + ')')
		set(10, 1, '数据长度 = ' + dataLen)
		set(11, 2, '数据标识 = ' + hexByte(raw[11]) + ' ' + hexByte(raw[12]))
		set(13, 1, '序号 = ' + raw[13])
		const contentLen = Math.max(0, dataLen - 3)
		if (contentLen > 0) set(14, contentLen, '数据内容')
		const total = 13 + dataLen
		if (total - 2 < n) set(total - 2, 1, '校验和')
		if (total - 1 < n) set(total - 1, 1, '帧尾 = 16')
		return map
	}

	// ===== 协议注册 =====
	function tryRegister() {
		if (typeof W.registerProtocol !== 'function') { setTimeout(tryRegister, 50); return }
		W.registerProtocol('sk188', {
			name: '188协议',
			parseFrame: W.sk188ParseFrame,
			formatFrame: W.sk188FormatFrame,
			findFrame: W.sk188FindFrame,
			byteMap: W.sk188ByteMap,
			buildDownFrame: W.sk188BuildDownFrame,
			presets: [],
		})
		W.registerProtocol('sk-ultrasonic', {
			name: '188协议（超声）',
			parseFrame: W.sk188ParseFrame,
			formatFrame: W.sk188FormatFrame,
			findFrame: W.sk188FindFrame,
			byteMap: W.sk188ByteMap,
			buildDownFrame: W.skUltrasonicBuildDownFrame,
			presets: [],
		})
		const sel = document.getElementById('serial-protocol-select')
		if (sel && ['sk188', 'sk-ultrasonic'].includes(W._activeProtocol)) sel.value = W._activeProtocol
		initDownUi()
	}

	// ===== 下行下发面板 =====
	function initDownUi() {
		const cmdSel = document.getElementById('sk188-down-cmd')
		if (!cmdSel || cmdSel.dataset.sk188Init) return
		cmdSel.dataset.sk188Init = '1'

		const addrEl = document.getElementById('sk188-down-addr')
		const addrResetBtn = document.getElementById('sk188-down-addr-reset')
		const seqEl = document.getElementById('sk188-down-seq')
		const paramGroup = document.getElementById('sk188-down-param-group')
		const paramLabel = document.getElementById('sk188-down-param-label')
		const paramVal = document.getElementById('sk188-down-param-val')
		const paramSel = document.getElementById('sk188-down-param-sel')
		const errEl = document.getElementById('sk188-down-err')
		const buildBtn = document.getElementById('sk188-down-build')
		const sendBtn = document.getElementById('sk188-down-send')
		const preview = document.getElementById('sk188-down-preview')

		addrEl.value = localStorage.getItem('sk188DownAddr') || BROADCAST_ADDR
		seqEl.value = localStorage.getItem('sk188DownSeq') || '1'

		if (addrResetBtn) {
			addrResetBtn.addEventListener('click', () => {
				addrEl.value = BROADCAST_ADDR
				localStorage.setItem('sk188DownAddr', BROADCAST_ADDR)
			})
		}

		function showErr(msg) { if (errEl) errEl.textContent = msg || '' }

		function onCmdChange() {
			const cmd = parseInt(cmdSel.value, 16)
			paramVal.style.display = 'none'
			paramSel.style.display = 'none'
			paramGroup.style.display = ''
			switch (cmd) {
				case 0x04:
					paramLabel.textContent = '阀控操作'
					paramSel.style.display = ''
					paramSel.innerHTML = ''
					for (const k in VALVE_OP) {
						const o = document.createElement('option')
						o.value = k
						o.textContent = hexByte(k) + ' ' + VALVE_OP[k]
						paramSel.appendChild(o)
					}
					break
				case 0x15:
					paramLabel.textContent = '新表号(7字节HEX)'
					paramVal.style.display = ''
					paramVal.placeholder = '如 01 02 03 04 05 06 07'
					paramVal.value = ''
					break
				case 0x16:
					paramLabel.textContent = '底度(m³)'
					paramVal.style.display = ''
					paramVal.placeholder = '非负数字, 单位m³, 如 12.345'
					paramVal.value = '0'
					break
				default:
					paramGroup.style.display = 'none'
			}
		}
		cmdSel.addEventListener('change', onCmdChange)
		onCmdChange()

		function buildFrame() {
			showErr('')
			try {
				const cmd = parseInt(cmdSel.value, 16)
				const opt = {
					addr: addrEl.value,
					cmd: cmdSel.value,
					seq: parseInt(seqEl.value, 10) || 0,
				}
				if (cmd === 0x04) opt.valveOp = parseInt(paramSel.value, 16)
				if (cmd === 0x15) opt.newAddr = paramVal.value
				if (cmd === 0x16) opt.degreeM3 = parseFloat(paramVal.value)
				const ultrasonic = document.getElementById('serial-protocol-select').value === 'sk-ultrasonic'
				const frame = ultrasonic ? W.skUltrasonicBuildDownFrame(opt) : W.sk188BuildDownFrame(opt)
				localStorage.setItem('sk188DownAddr', addrEl.value)
				const nextSeq = ((opt.seq + 1) & 0xff)
				seqEl.value = String(nextSeq)
				localStorage.setItem('sk188DownSeq', String(nextSeq))
				return frame
			} catch (e) {
				showErr(e.message)
				return null
			}
		}

		buildBtn.addEventListener('click', () => {
			const frame = buildFrame()
			if (frame && preview) preview.value = hexBytesSpaced(frame)
		})
		sendBtn.addEventListener('click', () => {
			const frame = buildFrame()
			if (!frame) return
			if (preview) preview.value = hexBytesSpaced(frame)
			const globalPreview = document.getElementById('serial-protocol-down-preview')
			if (globalPreview) globalPreview.value = hexBytesSpaced(frame)
			const sendEl = document.getElementById('serial-protocol-send')
			if (sendEl) sendEl.click()
		})

		// 与其余协议卡片互斥显示; SEK 专属卡片集中在 sekOnly
		function applyVisibility() {
			const sel = document.getElementById('serial-protocol-select')
			const v = sel ? sel.value : 'sek'
			const isSk188 = v === 'sk188' || v === 'sk-ultrasonic'
			const title = document.getElementById('sk188-down-title')
			if (title) title.textContent = v === 'sk-ultrasonic' ? '188协议（超声）下行下发' : '188协议下行下发'
			const readOption = cmdSel.querySelector('option[value="0x01"]')
			if (readOption) readOption.textContent = v === 'sk-ultrasonic' ? '0x01 拓展读流量 (901E)' : '0x01 读数据'
			if (preview) preview.value = ''
			const isSek = v === 'sek'
			const card = document.getElementById('sk188-down-card')
			if (card) card.style.display = isSk188 ? '' : 'none'
			;['sk-down-card', 'sk-rw-card', 'sk-batch-card', 'serial-protocol-advanced'].forEach(function (id) {
				const el = document.getElementById(id)
				if (el) el.style.display = isSek ? '' : 'none'
			})
		}
		const protoSel = document.getElementById('serial-protocol-select')
		if (protoSel) protoSel.addEventListener('change', applyVisibility)
		applyVisibility()
	}

	tryRegister()
})()
