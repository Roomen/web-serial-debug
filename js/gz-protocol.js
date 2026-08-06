// 工装通信协议 — 红外空口产测帧解析 / 下行构造 / 一键工位测试
// 帧: A5 | Len | DevType | Cmd | Info[N] | XOR(Len~Info)
// 方向约定: 工装(本工具)→被测件 = 下行 cmd 0x01~0x0D；被测件→工装 = 上行 cmd 0x81~0x8D
;(function () {
	'use strict'
	const W = window

	// ===== 设备类型（工位分组；名称去品牌化，仅保留技术描述）=====
	const DEV_TYPES = {
		0x01: { name: '无磁传感器工位1(全功能)', station: 1, flow: 's1_legacy' },
		0x02: { name: '无磁传感器工位1(无内存)', station: 1, flow: 's1_legacy' },
		0x03: { name: '无磁传感器工位2(全功能)', station: 2, flow: 's2_legacy' },
		0x05: { name: '无磁传感器工位2(模组组合A)', station: 2, flow: 's2_legacy' },
		0x06: { name: '无磁传感器工位1(模组组合A)', station: 1, flow: 's1_legacy' },
		0x07: { name: '无磁传感器工位2(无磁模块A)', station: 2, flow: 's2_legacy' },
		0x08: { name: '无磁传感器工位2(无磁模块B)', station: 2, flow: 's2_legacy' },
		0x09: { name: '厚膜传感器工位1', station: 1, flow: 's1_legacy' },
		0x0A: { name: '厚膜传感器工位2', station: 2, flow: 's2_legacy' },
		0x0B: { name: '超声波传感器工位1', station: 1, flow: 's1_legacy' },
		0x0C: { name: '无磁/脉冲阀控工位1', station: 1, flow: 's1_legacy' },
		0x0D: { name: '无磁/脉冲阀控工位2', station: 2, flow: 's2_legacy' },
		0x0E: { name: '蜂窝三合工位2', station: 2, flow: 's2_legacy' },
		0x0F: { name: '蓝牙小表工位2', station: 2, flow: 's2_legacy' },
		0x10: { name: '蓝牙通信盒工位2', station: 2, flow: 's2_legacy' },
		0x12: { name: '大表监控器工位2(旧)', station: 2, flow: 's2_legacy' },
		0x20: { name: '大表监控器工位1', station: 1, flow: 's1_legacy' },
		0x21: { name: '大表监控器工位2', station: 2, flow: 's2_legacy' },
		0x23: { name: '超声波通讯盒工位1', station: 1, flow: 's1_legacy' },
		0x30: { name: '蜂窝/摄像/超声/MBUS工位1(唯一码)', station: 1, flow: 's1_uid' },
		0x31: { name: '蜂窝/摄像传感器工位2(唯一码)', station: 2, flow: 's2_uid' },
		0x32: { name: '蜂窝/摄像/MBUS工位2(唯一码·有卡)', station: 2, flow: 's2_uid' },
		0x33: { name: '大表监控器工位2(唯一码)', station: 2, flow: 's2_uid' },
		0x34: { name: '蓝牙传感器工位1(唯一码)', station: 1, flow: 's1_uid' },
	}

	// 工装发出(下行) / 被测件应答(上行)
	// station: 1=仅工位1, 2=仅工位2, 0=两工位通用
	const CMD_TABLE = {
		0x01: { name: '测试确认包', dir: 'down', expect: null, station: 0 },
		0x02: { name: '数据查询包', dir: 'down', expect: 0x82, station: 1 },
		0x03: { name: '休眠包', dir: 'down', expect: 0x83, station: 0 },
		0x04: { name: '流量检测查询包', dir: 'down', expect: 0x84, station: 2 },
		0x05: { name: '0.4V AD校准开始', dir: 'down', expect: 0x85, station: 0 },
		0x06: { name: '4V AD校准开始', dir: 'down', expect: 0x86, station: 0 },
		0x07: { name: '2.0V AD校准开始', dir: 'down', expect: 0x87, station: 0 },
		0x08: { name: '数据查询包(唯一码)', dir: 'down', expect: 0x88, station: 1 },
		0x09: { name: '流量检测查询包(唯一码)', dir: 'down', expect: 0x89, station: 2 },
		0x0A: { name: '设置唯一码', dir: 'down', expect: 0x8A, station: 0 },
		0x0B: { name: '初始化开始/图片查询', dir: 'down', expect: 0x8B, station: 2 },
		0x0C: { name: '读取MAC地址', dir: 'down', expect: 0x8C, station: 0 },
		0x0D: { name: '读取图片数据', dir: 'down', expect: 0x8D, station: 2 },
		0x81: { name: '测试包', dir: 'up', expect: null, station: 0 },
		0x82: { name: '数据包', dir: 'up', expect: null, station: 1 },
		0x83: { name: '休眠确认包', dir: 'up', expect: null, station: 0 },
		0x84: { name: '流量检测数据包', dir: 'up', expect: null, station: 2 },
		0x85: { name: '0.4V AD校准确认', dir: 'up', expect: null, station: 0 },
		0x86: { name: '4V AD校准确认', dir: 'up', expect: null, station: 0 },
		0x87: { name: '2.0V AD校准确认', dir: 'up', expect: null, station: 0 },
		0x88: { name: '数据包(唯一码)', dir: 'up', expect: null, station: 1 },
		0x89: { name: '流量检测数据包(唯一码)', dir: 'up', expect: null, station: 2 },
		0x8A: { name: '设置唯一码应答', dir: 'up', expect: null, station: 0 },
		0x8B: { name: '初始化结束/图片数据', dir: 'up', expect: null, station: 2 },
		0x8C: { name: '读取MAC地址应答', dir: 'up', expect: null, station: 0 },
		0x8D: { name: '读取图片数据应答', dir: 'up', expect: null, station: 2 },
	}

	const UID_OP = { 0: '不操作', 1: '强制写入', 2: '自动写入' }

	// 一键测试流程（按工位类型）
	const FLOW_STEPS = {
		s1_legacy: [
			{ cmd: 0x02, name: '数据查询', expect: 0x82 },
			{ cmd: 0x03, name: '休眠', expect: 0x83 },
		],
		s1_uid: [
			{ cmd: 0x08, name: '数据查询(唯一码)', expect: 0x88 },
			{ cmd: 0x03, name: '休眠', expect: 0x83 },
		],
		s2_legacy: [
			{ cmd: 0x04, name: '流量检测查询', expect: 0x84 },
			{ cmd: 0x03, name: '休眠', expect: 0x83 },
		],
		s2_uid: [
			{ cmd: 0x09, name: '流量检测查询(唯一码)', expect: 0x89 },
			{ cmd: 0x03, name: '休眠', expect: 0x83 },
		],
	}

	// ===== 字节工具 =====
	function hexByte(b) {
		return (b & 0xff).toString(16).toUpperCase().padStart(2, '0')
	}
	function hexbytes(arr) {
		if (!arr || !arr.length) return ''
		const a = []
		for (let i = 0; i < arr.length; i++) a.push(hexByte(arr[i]))
		return a.join(' ')
	}
	function escHtml(s) {
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
	}
	function asciiPrintable(arr) {
		let s = ''
		for (let i = 0; i < arr.length; i++) {
			const c = arr[i] & 0xff
			s += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : '.'
		}
		return s
	}
	function u16be(b, o) {
		return ((b[o] & 0xff) << 8) | (b[o + 1] & 0xff)
	}
	function u32be(b, o) {
		return (((b[o] & 0xff) << 24) | ((b[o + 1] & 0xff) << 16) |
			((b[o + 2] & 0xff) << 8) | (b[o + 3] & 0xff)) >>> 0
	}
	function parseHexBytes(str) {
		const hex = String(str || '').replace(/[^0-9a-fA-F]/g, '')
		const out = []
		for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16) & 0xff)
		return out
	}
	function padBytes(arr, n, fill) {
		const out = new Array(n)
		const f = fill == null ? 0 : fill & 0xff
		for (let i = 0; i < n; i++) out[i] = i < arr.length ? (arr[i] & 0xff) : f
		return out
	}
	// 7 字节唯一码按大端整数 +1（末字节进位）
	function incrementUidBytes(bytes) {
		const out = padBytes(bytes || [], 7, 0)
		for (let i = 6; i >= 0; i--) {
			out[i] = ((out[i] & 0xff) + 1) & 0xff
			if (out[i] !== 0) break
		}
		return out
	}
	function formatUidHex(bytes) {
		return hexbytes(padBytes(bytes || [], 7, 0))
	}
	function cmdNeedsUid(cmd) {
		return cmd === 0x08 || cmd === 0x0A
	}
	function flowUsesQueryUid(flowKey) {
		return flowKey === 's1_uid'
	}
	function bitOn(byte, bit) {
		return ((byte >> bit) & 1) === 1
	}
	function flagLine(name, ok, okText, badText) {
		const good = !!ok
		return name + '=' + (good ? (okText || '正常') : (badText || '异常')) + (good ? ' ✓' : ' ✗')
	}

	function xorRange(bytes, from, toExcl) {
		let x = 0
		for (let i = from; i < toExcl; i++) x ^= (bytes[i] & 0xff)
		return x & 0xff
	}

	// ===== 帧构造 / 解析 =====
	function buildFrame(devType, cmd, info) {
		const infoArr = info ? Array.from(info).map(function (x) { return x & 0xff }) : []
		// Len = DevType + Cmd + Info + XOR；单字节长度上限 255 ⇒ Info 最多 252
		if (infoArr.length > 252) throw new Error('信息域过长(' + infoArr.length + '), 最多 252 字节')
		const len = 1 + 1 + infoArr.length + 1
		const body = [len & 0xff, devType & 0xff, cmd & 0xff].concat(infoArr)
		const xor = xorRange(body, 0, body.length)
		const frame = new Uint8Array(1 + body.length + 1)
		frame[0] = 0xA5
		frame.set(body, 1)
		frame[frame.length - 1] = xor
		return frame
	}

	function parseFrame(data) {
		const b = data instanceof Uint8Array ? data : Uint8Array.from(data || [])
		const result = {
			ok: false,
			errors: [],
			raw: b,
			dir: null,
			fields: {},
			decoded: '',
			devType: null,
			cmd: null,
			info: [],
			xorOk: false,
		}
		if (b.length < 5) {
			result.errors.push('帧过短(至少5字节)')
			return result
		}
		if (b[0] !== 0xA5) {
			result.errors.push('帧头不是 0xA5')
			return result
		}
		const len = b[1] & 0xff
		const total = 2 + len // A5 + Len + (Len 字节内容, 含 XOR)
		if (b.length < total) {
			result.errors.push('长度不足: 声明' + total + ' 实有' + b.length)
			return result
		}
		const xorRecv = b[total - 1] & 0xff
		const xorCalc = xorRange(b, 1, total - 1)
		result.xorOk = xorRecv === xorCalc
		if (!result.xorOk) result.errors.push('XOR校验失败 收=' + hexByte(xorRecv) + ' 算=' + hexByte(xorCalc))

		const devType = b[2] & 0xff
		const cmd = b[3] & 0xff
		const info = Array.from(b.subarray(4, total - 1))
		const cmdDef = CMD_TABLE[cmd]
		const devDef = DEV_TYPES[devType]
		const dir = cmdDef ? cmdDef.dir : ((cmd & 0x80) ? 'up' : 'down')

		result.devType = devType
		result.cmd = cmd
		result.info = info
		result.dir = dir
		result.frameLen = total
		result.fields = {
			方向: dir === 'up' ? '↑ 上行(被测→工装)' : '↓ 下行(工装→被测)',
			设备类型: { value: '0x' + hexByte(devType), name: devDef ? devDef.name : '未知' },
			命令字: { value: '0x' + hexByte(cmd), name: cmdDef ? cmdDef.name : '未知' },
			信息长度: info.length,
			XOR校验: result.xorOk ? '通过' : '失败',
		}
		if (devDef) {
			result.fields['工位'] = '工位' + devDef.station
		}
		result.decoded = decodeInfo(devType, cmd, info)
		result.ok = result.xorOk
		return result
	}

	function findFrame(data) {
		const b = data instanceof Uint8Array ? data : Uint8Array.from(data || [])
		for (let i = 0; i < b.length; i++) {
			if (b[i] !== 0xA5) continue
			if (i + 1 >= b.length) break
			const len = b[i + 1] & 0xff
			const total = 2 + len
			if (total < 5 || total > 257) continue
			if (i + total > b.length) {
				// 可能还没收齐
				if (i === 0) return null
				continue
			}
			const xorRecv = b[i + total - 1] & 0xff
			const xorCalc = xorRange(b, i + 1, i + total - 1)
			if (xorRecv !== xorCalc) continue
			const frame = b.subarray(i, i + total)
			const parse = parseFrame(frame)
			return {
				found: true,
				offset: i,
				length: total,
				frame: frame,
				parse: parse,
				prefix: i > 0 ? b.subarray(0, i) : new Uint8Array(0),
				suffix: b.subarray(i + total),
			}
		}
		return null
	}

	// ===== 信息域解码 =====
	function decodeBitsNamed(byte, defs) {
		// defs: [{bit, name, inv?}]  inv=true 时 0=正常
		const lines = []
		for (let i = 0; i < defs.length; i++) {
			const d = defs[i]
			const on = bitOn(byte, d.bit)
			const ok = d.inv ? !on : on
			if (d.raw) {
				lines.push(d.name + '=' + (on ? (d.onText || '1') : (d.offText || '0')))
			} else {
				lines.push(flagLine(d.name, ok, d.okText, d.badText))
			}
		}
		return lines
	}

	function decodeBeFlags(bytes, bitDefs) {
		// bitDefs: [{bit, name}] — bit0 = 末字节 LSB（与文档多字节大端字段的 bit 编号一致）
		const n = bytes.length
		let word = 0
		for (let i = 0; i < n; i++) word = (word << 8) | (bytes[i] & 0xff)
		const lines = []
		for (let i = 0; i < bitDefs.length; i++) {
			const d = bitDefs[i]
			const on = ((word >>> d.bit) & 1) === 1
			const ok = d.inv ? !on : on
			if (d.raw) lines.push(d.name + '=' + (on ? '1' : '0'))
			else lines.push(flagLine(d.name, ok, d.okText, d.badText))
		}
		return lines
	}

	function decodeInfo(devType, cmd, info) {
		const lines = []
		const pushHex = function (label) {
			if (info.length) lines.push(label + ': ' + hexbytes(info))
			else lines.push(label + ': (空)')
		}

		// 下行参数
		if (cmd === 0x08) {
			if (info.length >= 1) {
				const op = info[0] & 0xff
				lines.push('唯一码操作: ' + op + ' (' + (UID_OP[op] || '未知') + ')')
			}
			if (info.length >= 8) lines.push('唯一码: ' + hexbytes(info.slice(1, 8)))
			else if (info.length > 1) lines.push('唯一码(不完整): ' + hexbytes(info.slice(1)))
			return lines.join('\n')
		}
		if (cmd === 0x0A) {
			lines.push('写入唯一码: ' + hexbytes(info.slice(0, 7)))
			return lines.join('\n')
		}
		if (cmd === 0x05 || cmd === 0x06 || cmd === 0x07) {
			if (info.length >= 1) {
				const ch = info[0] & 0xff
				const chName = ch === 0 ? '低电压0.4V' : ch === 1 ? '高电压4V' : ch === 0xAA ? '2.0V' : ('0x' + hexByte(ch))
				lines.push('通道: ' + chName)
			}
			if (info.length >= 3) lines.push('电压: ' + u16be(info, 1) + ' mV')
			return lines.join('\n') || '(无信息域)'
		}

		// 上行应答
		if (cmd === 0x8A) {
			if (info.length >= 1) {
				const r = info[0] & 0xff
				lines.push(r === 0 ? '设置成功 ✓' : ('设置失败/结果=' + r + ' ✗'))
			} else pushHex('应答')
			return lines.join('\n')
		}
		if (cmd === 0x8C) {
			lines.push('MAC: ' + hexbytes(info.slice(0, 6)))
			const allFf = info.slice(0, 6).every(function (x) { return (x & 0xff) === 0xff })
			if (allFf) lines.push('(全 FF 视为无效)')
			return lines.join('\n')
		}
		if (cmd === 0x8D) {
			if (info.length >= 11) {
				lines.push('唯一码: ' + hexbytes(info.slice(0, 7)))
				lines.push('图片长度: ' + u16be(info, 7))
				lines.push('总包数: ' + (info[9] & 0xff) + ' 当前包: ' + (info[10] & 0xff))
				if (info.length > 11) lines.push('图片数据: ' + (info.length - 11) + ' 字节')
			} else pushHex('图片应答')
			return lines.join('\n')
		}
		if (cmd === 0x85 || cmd === 0x86 || cmd === 0x87) {
			if (info.length) lines.push('通道号: 0x' + hexByte(info[0]))
			return lines.join('\n') || '(空)'
		}
		if (cmd === 0x81 || cmd === 0x01 || cmd === 0x83 || cmd === 0x03) {
			return info.length ? hexbytes(info) : '(无信息域)'
		}

		// 数据包 / 流量包按设备类型
		if (cmd === 0x88) return decodeUidDataPacket(devType, info).join('\n')
		if (cmd === 0x89) return decodeUidFlowPacket(devType, info).join('\n')
		if (cmd === 0x82) return decodeLegacyDataPacket(devType, info).join('\n')
		if (cmd === 0x84) return decodeLegacyFlowPacket(devType, info).join('\n')

		if (info.length) {
			lines.push('原始: ' + hexbytes(info))
			const asc = asciiPrintable(info)
			if (/[A-Za-z0-9]/.test(asc)) lines.push('ASCII: ' + asc)
		} else {
			lines.push('(无信息域)')
		}
		return lines.join('\n')
	}

	function decodeUidDataPacket(devType, info) {
		const lines = []
		if (devType === 0x30) {
			// 55 字节
			if (info.length < 43) {
				lines.push('(长度' + info.length + ', 期望≥43/55)')
				if (info.length) lines.push(hexbytes(info))
				return lines
			}
			lines.push('唯一码: ' + hexbytes(info.slice(0, 7)))
			lines.push('CCID: ' + asciiPrintable(info.slice(7, 27)).replace(/\.+$/, ''))
			lines.push('IMEI: ' + asciiPrintable(info.slice(27, 42)).replace(/\.+$/, ''))
			lines.push('CSQ: ' + (info[42] & 0xff))
			if (info.length >= 45) lines.push('供电电压: ' + (u16be(info, 43) / 100).toFixed(2) + ' V')
			if (info.length >= 46) {
				const b45 = info[45] & 0xff
				lines.push('蓝牙使能: ' + (bitOn(b45, 3) ? '有效' : '无效'))
				lines.push('CCID使能: ' + (bitOn(b45, 2) ? '有效' : '无效'))
				lines.push('IMEI使能: ' + (bitOn(b45, 1) ? '有效' : '无效'))
				lines.push('磁开关状态: ' + (bitOn(b45, 0) ? '有磁' : '无磁'))
			}
			if (info.length >= 47) {
				const irMap = { 0: 10, 1: 50, 2: 100, 3: 150, 4: 200, 5: 256, 6: 512, 7: 1024 }
				const ir = info[46] & 0xff
				lines.push('红外有效通讯长度: ' + (ir === 0xff ? '非检测' : (irMap[ir] != null ? irMap[ir] + ' BYTE' : ('code=' + ir))))
			}
			if (info.length >= 48) lines.push('RS485供电电压: ' + ((info[47] & 0xff) / 10).toFixed(1) + ' V')
			if (info.length >= 55) {
				const flags = info.slice(51, 55)
				lines.push('--- 检测结果 ---')
				lines.push.apply(lines, decodeBeFlags(flags, [
					{ bit: 23, name: '超声计量总线' },
					{ bit: 22, name: 'RS485供电电压' },
					{ bit: 21, name: '蓝牙模组通讯' },
					{ bit: 20, name: '脉冲计量线S4' },
					{ bit: 19, name: '脉冲计量线S3' },
					{ bit: 18, name: '脉冲计量线S2' },
					{ bit: 17, name: '脉冲计量线S1' },
					{ bit: 16, name: 'AD采样' },
					{ bit: 15, name: 'MBUS模块' },
					{ bit: 14, name: 'MBUS供电电压' },
					{ bit: 13, name: 'RTC晶振' },
					{ bit: 12, name: 'MBUS串口通信' },
					{ bit: 11, name: 'RS485' },
					{ bit: 10, name: '模板识别' },
					{ bit: 9, name: '摄像头' },
					{ bit: 8, name: 'DSP程序' },
					{ bit: 7, name: '触摸开关' },
					{ bit: 6, name: '电池电压' },
					{ bit: 5, name: '磁开关' },
					{ bit: 4, name: 'Flash' },
					{ bit: 3, name: 'I2C' },
					{ bit: 2, name: '阀控' },
					{ bit: 1, name: 'SIM卡' },
					{ bit: 0, name: '蜂窝模组通讯' },
				]))
			}
			return lines
		}
		if (devType === 0x34) {
			if (info.length < 16) {
				lines.push('(长度' + info.length + ', 期望28)')
				if (info.length) lines.push(hexbytes(info))
				return lines
			}
			lines.push('唯一码: ' + hexbytes(info.slice(0, 7)))
			lines.push('供电电压: ' + (u16be(info, 7) / 100).toFixed(2) + ' V')
			if (info.length >= 16) lines.push('MAC: ' + hexbytes(info.slice(10, 16)))
			if (info.length >= 18) lines.push('蓝牙频偏: ' + u16be(info, 16))
			if (info.length >= 19) lines.push('匹配电容: ' + (info[18] & 0xff))
			if (info.length >= 28) {
				lines.push('--- 检测结果 ---')
				lines.push.apply(lines, decodeBeFlags(info.slice(24, 28), [
					{ bit: 4, name: '电池电压' },
					{ bit: 3, name: '蓝牙模组通讯' },
					{ bit: 2, name: '磁开关' },
					{ bit: 1, name: 'Flash' },
					{ bit: 0, name: '阀控' },
				]))
			}
			return lines
		}
		// 通用 fallback
		if (info.length >= 7) lines.push('唯一码: ' + hexbytes(info.slice(0, 7)))
		if (info.length > 7) lines.push('数据: ' + hexbytes(info.slice(7)))
		else if (!info.length) lines.push('(空)')
		return lines
	}

	function decodeUidFlowPacket(devType, info) {
		const lines = []
		if (devType === 0x31) {
			if (info.length < 15) {
				lines.push('(长度' + info.length + ', 期望25)')
				if (info.length) lines.push(hexbytes(info))
				return lines
			}
			lines.push('唯一码: ' + hexbytes(info.slice(0, 7)))
			lines.push('正向流量: ' + u16be(info, 7))
			lines.push('反向流量: ' + u16be(info, 9))
			lines.push('无磁信号1: ' + (info[11] & 0xff) + '  信号2: ' + (info[12] & 0xff))
			lines.push('供电电压: ' + (u16be(info, 13) / 100).toFixed(2) + ' V')
			if (info.length >= 25) {
				lines.push('--- 检测结果 ---')
				lines.push.apply(lines, decodeBeFlags(info.slice(21, 25), [
					{ bit: 5, name: '模板识别' },
					{ bit: 4, name: '摄像头' },
					{ bit: 3, name: 'DSP程序' },
					{ bit: 2, name: '触摸开关' },
					{ bit: 1, name: '阀控' },
					{ bit: 0, name: '磁开关' },
				]))
			}
			return lines
		}
		if (devType === 0x32) {
			if (info.length < 36) {
				lines.push('(长度' + info.length + ', 期望46)')
				if (info.length) lines.push(hexbytes(info))
				return lines
			}
			lines.push('唯一码: ' + hexbytes(info.slice(0, 7)))
			lines.push('CCID: ' + asciiPrintable(info.slice(7, 27)).replace(/\.+$/, ''))
			lines.push('CSQ: ' + (info[27] & 0xff))
			lines.push('正向流量: ' + u16be(info, 28) + '  反向: ' + u16be(info, 30))
			lines.push('无磁信号1: ' + (info[32] & 0xff) + '  信号2: ' + (info[33] & 0xff))
			lines.push('供电电压: ' + (u16be(info, 34) / 100).toFixed(2) + ' V')
			if (info.length >= 37) {
				const b36 = info[36] & 0xff
				lines.push('CCID使能: ' + (bitOn(b36, 2) ? '有效' : '无效'))
				lines.push('IMEI使能: ' + (bitOn(b36, 1) ? '有效' : '无效'))
				lines.push('磁开关状态: ' + (bitOn(b36, 0) ? '有磁' : '无磁'))
			}
			if (info.length >= 38) lines.push('RS485供电电压: ' + ((info[37] & 0xff) / 10).toFixed(1) + ' V')
			if (info.length >= 46) {
				lines.push('--- 检测结果 ---')
				lines.push.apply(lines, decodeBeFlags(info.slice(42, 46), [
					{ bit: 17, name: 'RS485供电电压' },
					{ bit: 16, name: '脉冲计量线S4' },
					{ bit: 15, name: '脉冲计量线S3' },
					{ bit: 14, name: '脉冲计量线S2' },
					{ bit: 13, name: '脉冲计量线S1' },
					{ bit: 12, name: 'AD采样' },
					{ bit: 11, name: 'RS485' },
					{ bit: 10, name: 'MBUS通道2' },
					{ bit: 9, name: 'MBUS通道1' },
					{ bit: 8, name: '气体压力传感器', okText: '合格', badText: '不合格' },
					{ bit: 7, name: 'SAS传感器', okText: '合格', badText: '不合格' },
					{ bit: 6, name: 'SIM卡' },
					{ bit: 5, name: '模板识别' },
					{ bit: 4, name: '摄像头' },
					{ bit: 3, name: 'DSP程序' },
					{ bit: 2, name: '触摸开关' },
					{ bit: 1, name: '阀控' },
					{ bit: 0, name: '磁开关' },
				]))
			}
			return lines
		}
		if (devType === 0x33) {
			if (info.length < 43) {
				lines.push('(长度' + info.length + ', 期望72)')
				if (info.length) lines.push(hexbytes(info))
				return lines
			}
			lines.push('唯一码: ' + hexbytes(info.slice(0, 7)))
			lines.push('CCID: ' + asciiPrintable(info.slice(7, 27)).replace(/\.+$/, ''))
			lines.push('IMEI: ' + asciiPrintable(info.slice(27, 42)).replace(/\.+$/, ''))
			lines.push('CSQ: ' + (info[42] & 0xff))
			if (info.length >= 51) {
				const pulses = []
				for (let i = 0; i < 8; i++) pulses.push(info[43 + i] & 0xff)
				lines.push('脉冲1-8: ' + pulses.join(', '))
			}
			if (info.length >= 57) {
				lines.push('AD1: ' + (u16be(info, 51) / 1000).toFixed(3) + '  AD2: ' + (u16be(info, 53) / 1000).toFixed(3))
				lines.push('供电电压: ' + (u16be(info, 55) / 100).toFixed(2) + ' V')
			}
			if (info.length >= 72) {
				lines.push('--- 检测结果 ---')
				lines.push.apply(lines, decodeBeFlags(info.slice(68, 72), [
					{ bit: 6, name: 'RS485' },
					{ bit: 5, name: 'AD2采样' },
					{ bit: 4, name: 'AD1采样' },
					{ bit: 3, name: '电池电压', okText: '合格', badText: '不合格' },
					{ bit: 2, name: 'SIM卡', okText: '合格', badText: '不合格' },
					{ bit: 1, name: '磁开关' },
					{ bit: 0, name: '蜂窝模组通讯' },
				]))
			}
			return lines
		}
		if (info.length >= 7) lines.push('唯一码: ' + hexbytes(info.slice(0, 7)))
		if (info.length > 7) lines.push('数据: ' + hexbytes(info.slice(7)))
		return lines
	}

	function decodeLegacyDataPacket(devType, info) {
		const lines = []
		// 常见 37 字节: CCID20 + IMEI15 + CSQ + flags
		if (info.length >= 37 && (devType === 0x01 || devType === 0x02 || devType === 0x06 ||
			devType === 0x0B || devType === 0x0C)) {
			lines.push('CCID: ' + asciiPrintable(info.slice(0, 20)).replace(/\.+$/, ''))
			lines.push('IMEI: ' + asciiPrintable(info.slice(20, 35)).replace(/\.+$/, ''))
			lines.push('信号强度: ' + (info[35] & 0xff))
			const f = info[36] & 0xff
			if (devType === 0x01) {
				lines.push.apply(lines, decodeBitsNamed(f, [
					{ bit: 5, name: '磁开关' }, { bit: 3, name: 'I2C' },
					{ bit: 1, name: 'SIM卡' }, { bit: 0, name: '蜂窝模组' },
				]))
			} else if (devType === 0x0B) {
				lines.push.apply(lines, decodeBitsNamed(f, [
					{ bit: 7, name: 'Flash' }, { bit: 6, name: '阀控' },
					{ bit: 5, name: '磁开关' }, { bit: 4, name: '电池电压' },
					{ bit: 3, name: 'I2C' }, { bit: 2, name: '上报生命周期' },
					{ bit: 1, name: 'SIM卡' }, { bit: 0, name: '蜂窝模组' },
				]))
			} else if (devType === 0x0C) {
				lines.push.apply(lines, decodeBitsNamed(f, [
					{ bit: 7, name: '触摸开关' }, { bit: 6, name: '阀控' },
					{ bit: 5, name: '磁开关' }, { bit: 4, name: '电池电压' },
					{ bit: 3, name: 'I2C' }, { bit: 1, name: 'SIM卡' },
					{ bit: 0, name: '蜂窝模组' },
				]))
			} else {
				lines.push('状态字节: 0x' + hexByte(f))
			}
			return lines
		}
		if (devType === 0x20 && info.length >= 15) {
			lines.push('UUID: ' + hexbytes(info.slice(0, 12)))
			lines.push('电池电压: ' + ((info[12] & 0xff) / 10).toFixed(1) + ' V')
			// 13-14 flags in 2 bytes — take low bits of last
			const fl = info[14] & 0xff
			lines.push.apply(lines, decodeBitsNamed(fl, [
				{ bit: 3, name: 'EEPROM' }, { bit: 2, name: '电池电压检测' },
				{ bit: 1, name: 'SPI Flash' }, { bit: 0, name: '磁开关' },
			]))
			return lines
		}
		if (info.length) lines.push(hexbytes(info))
		else lines.push('(空)')
		return lines
	}

	function decodeLegacyFlowPacket(devType, info) {
		const lines = []
		if (info.length >= 19 && (devType === 0x03 || devType === 0x05 || devType === 0x0D ||
			devType === 0x07 || devType === 0x08)) {
			lines.push('IMEI: ' + asciiPrintable(info.slice(0, 15)).replace(/\.+$/, ''))
			lines.push('正向流量: ' + u16be(info, 15) + '  反向: ' + u16be(info, 17))
			if (info.length >= 22) {
				lines.push('无磁信号1: ' + (info[19] & 0xff) + '  信号2: ' + (info[20] & 0xff))
				const f = info[21] & 0xff
				lines.push(flagLine('磁开关', bitOn(f, 5)))
				if (devType === 0x0D) {
					lines.push(flagLine('触摸开关', bitOn(f, 7)))
					lines.push(flagLine('阀控', bitOn(f, 6)))
				}
			} else if (info.length >= 20) {
				lines.push(flagLine('磁开关', bitOn(info[19], 5)))
			}
			return lines
		}
		if (devType === 0x0F && info.length >= 13) {
			lines.push('MAC: ' + hexbytes(info.slice(0, 6)))
			lines.push('正向流量: ' + u16be(info, 6) + '  反向: ' + u16be(info, 8))
			lines.push('无磁信号1: ' + (info[10] & 0xff) + '  信号2: ' + (info[11] & 0xff))
			lines.push(flagLine('磁开关', bitOn(info[12], 5)))
			return lines
		}
		if (info.length) lines.push(hexbytes(info))
		else lines.push('(空)')
		return lines
	}

	function formatFrame(r) {
		const dirArrow = r.dir === 'up' ? '↑' : r.dir === 'down' ? '↓' : '?'
		const status = r.xorOk ? '✓' : '✗'
		let h = '<div class="sk-parse">'
		h += '<div class="sk-parse-bar">' + dirArrow + ' ' + status + ' 工装</div>'
		const f = r.fields || {}
		const cells = []
		for (const k in f) {
			const v = f[k]
			let val
			if (v == null) val = ''
			else if (typeof v === 'object' && v.name !== undefined) val = escHtml(String(v.value)) + ' (' + escHtml(v.name) + ')'
			else val = escHtml(String(v))
			cells.push({ name: k, value: val })
		}
		if (cells.length) {
			const COLS = 3
			h += '<table class="sk-parse-grid"><tbody>'
			for (let i = 0; i < cells.length; i += COLS) {
				h += '<tr>'
				for (let j = 0; j < COLS; j++) {
					const c = cells[i + j]
					h += '<td class="sk-parse-hdr">' + (c ? escHtml(c.name) : '') + '</td>'
				}
				h += '</tr><tr>'
				for (let j = 0; j < COLS; j++) {
					const c = cells[i + j]
					h += '<td>' + (c ? c.value : '') + '</td>'
				}
				h += '</tr>'
			}
			h += '</tbody></table>'
		}
		if (r.decoded) {
			h += '<div class="sk-parse-tlvs"><details class="sk-parse-tag" open><summary>信息域解析</summary>' +
				'<div class="sk-parse-items"><pre style="white-space:pre-wrap;margin:0;">' + escHtml(r.decoded) + '</pre></div></details></div>'
		}
		if (r.errors && r.errors.length) {
			h += '<div class="sk-parse-errors">'
			for (let i = 0; i < r.errors.length; i++) h += '<div>' + escHtml(r.errors[i]) + '</div>'
			h += '</div>'
		}
		h += '</div>'
		return h
	}

	function byteMap(r) {
		const raw = (r.raw instanceof Uint8Array) ? r.raw : Uint8Array.from(r.raw || [])
		const n = raw.length
		const map = new Array(n).fill('')
		if (n < 5) return map
		map[0] = '帧头 A5'
		map[1] = '长度'
		if (n > 2) map[2] = '设备类型'
		if (n > 3) map[3] = '命令字'
		const total = r.frameLen || n
		for (let i = 4; i < total - 1 && i < n; i++) map[i] = '信息域'
		if (total - 1 < n) map[total - 1] = 'XOR校验'
		return map
	}

	function buildDownFrame(opts) {
		opts = opts || {}
		const devType = opts.devType != null ? (opts.devType & 0xff) : 0x30
		let cmd = opts.cmd
		if (typeof cmd === 'string') cmd = parseInt(cmd, 16) || parseInt(cmd, 10) || 0
		cmd = cmd & 0xff
		let info = []
		if (opts.infoBytes) info = Array.from(opts.infoBytes).map(function (x) { return x & 0xff })
		else if (opts.infoHex) info = parseHexBytes(opts.infoHex)
		else if (cmd === 0x08) {
			const op = opts.uidOp != null ? (opts.uidOp & 0xff) : 1
			const uid = padBytes(parseHexBytes(opts.uidHex || ''), 7, 0)
			info = [op].concat(uid)
		} else if (cmd === 0x0A) {
			info = padBytes(parseHexBytes(opts.uidHex || ''), 7, 0)
		} else if (cmd === 0x05 || cmd === 0x06 || cmd === 0x07) {
			const ch = opts.adCh != null ? (opts.adCh & 0xff) : (cmd === 0x05 ? 0 : cmd === 0x06 ? 1 : 0xAA)
			const mv = opts.adMv != null ? (opts.adMv & 0xffff) : 0
			info = [ch, (mv >> 8) & 0xff, mv & 0xff]
		}
		const frame = buildFrame(devType, cmd, info)
		return { frame: frame, hex: hexbytes(frame), devType: devType, cmd: cmd, info: info }
	}

	// 暴露核心 API
	W.gzBuildFrame = buildFrame
	W.gzParseFrame = parseFrame
	W.gzFindFrame = findFrame
	W.gzFormatFrame = formatFrame
	W.gzByteMap = byteMap
	W.gzBuildDownFrame = buildDownFrame
	W.GZ_DEV_TYPES = DEV_TYPES
	W.GZ_CMD_TABLE = CMD_TABLE
	W.GZ_FLOW_STEPS = FLOW_STEPS

	// ===== 协议注册 =====
	function tryRegister() {
		if (typeof W.registerProtocol !== 'function') { setTimeout(tryRegister, 50); return }
		W.registerProtocol('gz', {
			name: '工装通信协议',
			parseFrame: parseFrame,
			formatFrame: formatFrame,
			findFrame: findFrame,
			byteMap: byteMap,
			buildDownFrame: function (opts) {
				const r = buildDownFrame(opts)
				return r.frame
			},
			presets: [],
		})
		const sel = document.getElementById('serial-protocol-select')
		if (sel && W._activeProtocol === 'gz' && sel.value !== 'gz') sel.value = 'gz'
		initUi()
	}

	// ===== UI =====
	function $(id) { return document.getElementById(id) }

	function fillDevSelect(sel, station, pref) {
		if (!sel) return 0
		const st = parseInt(station, 10) === 2 ? 2 : 1
		const prefer = pref != null ? (pref & 0xff) : 0
		sel.innerHTML = ''
		const keys = Object.keys(DEV_TYPES).map(Number).sort(function (a, b) { return a - b })
		for (let i = 0; i < keys.length; i++) {
			const dt = keys[i]
			const def = DEV_TYPES[dt]
			if (def.station !== st) continue
			const opt = document.createElement('option')
			opt.value = '0x' + hexByte(dt)
			opt.textContent = '0x' + hexByte(dt) + ' ' + def.name
			sel.appendChild(opt)
		}
		const prefHex = '0x' + hexByte(prefer)
		if (prefer && Array.from(sel.options).some(function (o) { return o.value === prefHex })) {
			sel.value = prefHex
		} else if (sel.options.length) {
			// 工位默认：工位1 优先 0x30，工位2 优先 0x31/0x32
			const defaults = st === 1 ? [0x30, 0x34, 0x01] : [0x31, 0x32, 0x33, 0x03]
			let picked = false
			for (let i = 0; i < defaults.length; i++) {
				const h = '0x' + hexByte(defaults[i])
				if (Array.from(sel.options).some(function (o) { return o.value === h })) {
					sel.value = h
					picked = true
					break
				}
			}
			if (!picked) sel.selectedIndex = 0
		}
		return sel.value ? (parseInt(sel.value, 16) & 0xff) : 0
	}

	function initUi() {
		const card = $('gz-down-card')
		if (!card || card.dataset.gzInit) return
		card.dataset.gzInit = '1'

		const stationSel = $('gz-down-station')
		const devSel = $('gz-down-dev')
		const cmdSel = $('gz-down-cmd')
		const uidGroup = $('gz-down-uid-group')
		const uidOpWrap = $('gz-down-uid-op-wrap')
		const uidOpSel = $('gz-down-uid-op')
		const uidHexEl = $('gz-down-uid')
		const adGroup = $('gz-down-ad-group')
		const adMvEl = $('gz-down-ad-mv')
		const infoEl = $('gz-down-info')
		const errEl = $('gz-down-err')
		const previewEl = $('gz-down-preview')
		const buildBtn = $('gz-down-build')
		const sendBtn = $('gz-down-send')

		const autoStationSel = $('gz-auto-station')
		const autoDevSel = $('gz-auto-dev')
		const autoBtn = $('gz-auto-start')
		const autoStopBtn = $('gz-auto-stop')
		const autoSetUid = $('gz-auto-set-uid')
		const autoUidGroup = $('gz-auto-uid-group')
		const autoUidOpWrap = $('gz-auto-uid-op-wrap')
		const autoUidOpSel = $('gz-auto-uid-op')
		const autoUidEl = $('gz-auto-uid')
		const autoTimeout = $('gz-auto-timeout')
		const autoGap = $('gz-auto-gap')
		const autoStatus = $('gz-auto-status')
		const autoLog = $('gz-auto-log')
		const autoProgress = $('gz-auto-progress-bar')
		const autoSummary = $('gz-auto-summary')

		// 恢复本地
		let saved = {}
		try { saved = JSON.parse(localStorage.getItem('gzDownUi') || '{}') || {} } catch (e) { saved = {} }
		// 旧版 'all' 迁移为工位1
		if (saved.station === 'all' || saved.station == null) saved.station = '1'
		if (saved.station !== '1' && saved.station !== '2') saved.station = '1'
		if (saved.autoStation === 'all' || saved.autoStation == null) saved.autoStation = saved.station || '1'
		if (saved.autoStation !== '1' && saved.autoStation !== '2') saved.autoStation = '1'

		if (stationSel) stationSel.value = saved.station
		if (autoStationSel) autoStationSel.value = saved.autoStation
		if (saved.uidOp != null && uidOpSel) uidOpSel.value = String(saved.uidOp)
		if (saved.uid && uidHexEl) uidHexEl.value = saved.uid
		if (saved.autoUid && autoUidEl) autoUidEl.value = saved.autoUid
		else if (saved.uid && autoUidEl) autoUidEl.value = saved.uid
		if (saved.autoUidOp != null && autoUidOpSel) autoUidOpSel.value = String(saved.autoUidOp)
		if (saved.doSetUid != null && autoSetUid) autoSetUid.checked = !!saved.doSetUid
		if (saved.timeout != null && autoTimeout) autoTimeout.value = saved.timeout
		if (saved.gap != null && autoGap) autoGap.value = saved.gap

		function saveUi() {
			try {
				localStorage.setItem('gzDownUi', JSON.stringify({
					station: stationSel ? stationSel.value : '1',
					dev: devSel && devSel.value ? parseInt(devSel.value, 16) : 0x30,
					uidOp: uidOpSel ? parseInt(uidOpSel.value, 10) : 1,
					uid: uidHexEl ? uidHexEl.value : '',
					autoStation: autoStationSel ? autoStationSel.value : '1',
					autoDev: autoDevSel && autoDevSel.value ? parseInt(autoDevSel.value, 16) : 0x30,
					autoUid: autoUidEl ? autoUidEl.value : '',
					autoUidOp: autoUidOpSel ? parseInt(autoUidOpSel.value, 10) : 1,
					doSetUid: autoSetUid ? autoSetUid.checked : false,
					timeout: autoTimeout ? parseInt(autoTimeout.value, 10) : 3000,
					gap: autoGap ? parseInt(autoGap.value, 10) : 200,
				}))
			} catch (e) { /* */ }
		}

		function showErr(msg) {
			if (errEl) errEl.textContent = msg || ''
		}

		function refreshDevOptions() {
			const st = stationSel ? stationSel.value : '1'
			const pref = saved.dev != null ? saved.dev
				: (devSel && devSel.value ? parseInt(devSel.value, 16) : 0x30)
			const cur = fillDevSelect(devSel, st, pref)
			if (devSel) devSel.dataset.pref = String(cur)
			saved.dev = cur
		}

		function refreshAutoDevOptions() {
			const st = autoStationSel ? autoStationSel.value : '1'
			const pref = saved.autoDev != null ? saved.autoDev
				: (autoDevSel && autoDevSel.value ? parseInt(autoDevSel.value, 16) : 0x30)
			const cur = fillDevSelect(autoDevSel, st, pref)
			if (autoDevSel) autoDevSel.dataset.pref = String(cur)
			saved.autoDev = cur
			updateAutoUidVisibility()
		}

		function refreshCmdOptions() {
			const prev = cmdSel.value
			// 按当前工位过滤命令: station=0 通用, 1/2 仅对应工位
			const station = stationSel ? (parseInt(stationSel.value, 10) === 2 ? 2 : 1) : 1
			cmdSel.innerHTML = ''
			const keys = Object.keys(CMD_TABLE).map(Number).sort(function (a, b) { return a - b })
			for (let i = 0; i < keys.length; i++) {
				const c = keys[i]
				const def = CMD_TABLE[c]
				if (def.dir !== 'down') continue
				const st = def.station != null ? def.station : 0
				if (st !== 0 && st !== station) continue
				const opt = document.createElement('option')
				opt.value = '0x' + hexByte(c)
				opt.textContent = '0x' + hexByte(c) + ' ' + def.name
				cmdSel.appendChild(opt)
			}
			if (prev && Array.from(cmdSel.options).some(function (o) { return o.value === prev })) {
				cmdSel.value = prev
			} else {
				const dt = devSel && devSel.value ? parseInt(devSel.value, 16) : 0
				const def = DEV_TYPES[dt]
				const flow = def && FLOW_STEPS[def.flow]
				const defCmd = flow && flow[0] ? flow[0].cmd : (station === 2 ? 0x09 : 0x08)
				const defHex = '0x' + hexByte(defCmd)
				if (Array.from(cmdSel.options).some(function (o) { return o.value === defHex })) {
					cmdSel.value = defHex
				} else if (cmdSel.options.length) {
					cmdSel.selectedIndex = 0
				}
			}
			onCmdChange()
		}

		// 仅 0x08/0x0A 需要唯一码控件；0x08 额外显示操作标志
		function onCmdChange() {
			const cmd = parseInt(cmdSel.value, 16) & 0xff
			const needUid = cmdNeedsUid(cmd)
			if (uidGroup) uidGroup.style.display = needUid ? '' : 'none'
			if (uidOpWrap) uidOpWrap.style.display = (cmd === 0x08) ? '' : 'none'
			if (adGroup) adGroup.style.display = (cmd === 0x05 || cmd === 0x06 || cmd === 0x07) ? '' : 'none'
			autoFillInfo()
			rebuild()
		}

		function getDownDevType() {
			return devSel && devSel.value ? (parseInt(devSel.value, 16) & 0xff) : 0x30
		}

		function getAutoDevType() {
			return autoDevSel && autoDevSel.value ? (parseInt(autoDevSel.value, 16) & 0xff) : 0x30
		}

		function updateAutoUidVisibility() {
			const devType = getAutoDevType()
			const def = DEV_TYPES[devType]
			const flowKey = def ? def.flow : ''
			const setUid = !!(autoSetUid && autoSetUid.checked)
			const queryUid = flowUsesQueryUid(flowKey)
			// 先写唯一码 或 工位1唯一码查询(0x08) 才需要唯一码输入
			const show = setUid || queryUid
			if (autoUidGroup) autoUidGroup.style.display = show ? '' : 'none'
			// 查询写码操作仅 s1_uid 的 0x08 用到
			if (autoUidOpWrap) autoUidOpWrap.style.display = queryUid ? '' : 'none'
		}

		function autoFillInfo() {
			const cmd = parseInt(cmdSel.value, 16) & 0xff
			if (!infoEl) return
			if (cmd === 0x08 || cmd === 0x0A || cmd === 0x05 || cmd === 0x06 || cmd === 0x07) {
				infoEl.readOnly = true
			} else {
				infoEl.readOnly = false
			}
		}

		function collectBuildOpts() {
			const cmd = parseInt(cmdSel.value, 16) & 0xff
			const opts = { devType: getDownDevType(), cmd: cmd }
			if (cmd === 0x08) {
				opts.uidOp = uidOpSel ? (parseInt(uidOpSel.value, 10) & 0xff) : 1
				opts.uidHex = uidHexEl ? uidHexEl.value : ''
			} else if (cmd === 0x0A) {
				opts.uidHex = uidHexEl ? uidHexEl.value : ''
			} else if (cmd === 0x05 || cmd === 0x06 || cmd === 0x07) {
				opts.adMv = adMvEl ? (parseInt(adMvEl.value, 10) || 0) : 0
			} else if (infoEl && infoEl.value.trim()) {
				opts.infoHex = infoEl.value
			}
			return opts
		}

		function rebuild() {
			showErr('')
			try {
				const built = buildDownFrame(collectBuildOpts())
				if (previewEl) previewEl.value = built.hex
				if (infoEl && (built.cmd === 0x08 || built.cmd === 0x0A ||
					built.cmd === 0x05 || built.cmd === 0x06 || built.cmd === 0x07)) {
					infoEl.value = hexbytes(built.info)
				}
				return built
			} catch (e) {
				showErr(e.message || String(e))
				return null
			}
		}

		async function sendOnce() {
			showErr('')
			const built = rebuild()
			if (!built) return
			if (!W.serialApi || !W.serialApi.isOpen()) {
				showErr('请先打开串口')
				return
			}
			try {
				await W.serialApi.writeData(built.frame)
			} catch (e) {
				showErr('发送失败: ' + (e.message || e))
			}
		}

		// ----- 一键测试 -----
		let autoRunning = false
		let autoStopFlag = false

		function setAutoUi(running) {
			autoRunning = running
			if (autoBtn) autoBtn.disabled = running
			if (autoStopBtn) autoStopBtn.disabled = !running
			if (sendBtn) sendBtn.disabled = running
			if (autoStationSel) autoStationSel.disabled = running
			if (autoDevSel) autoDevSel.disabled = running
			if (autoSetUid) autoSetUid.disabled = running
			if (autoUidEl) autoUidEl.disabled = running
			if (autoUidOpSel) autoUidOpSel.disabled = running
		}

		function autoLogLine(msg, cls) {
			if (!autoLog) return
			const div = document.createElement('div')
			div.className = 'sk-rw-log-line' + (cls ? ' sk-rw-' + cls : '')
			div.textContent = msg
			autoLog.appendChild(div)
			autoLog.scrollTop = autoLog.scrollHeight
		}

		function setAutoStatus(msg, cls) {
			if (!autoStatus) return
			autoStatus.textContent = msg
			autoStatus.className = 'sk-rw-status' + (cls ? ' ' + cls : '')
		}

		function setAutoProgress(done, total) {
			if (!autoProgress) return
			autoProgress.textContent = done + '/' + total
			const pct = total > 0 ? Math.round(done * 100 / total) : 0
			autoProgress.style.width = Math.max(pct, 8) + '%'
		}

		function sleep(ms) {
			return new Promise(function (resolve) { setTimeout(resolve, ms) })
		}

		function bumpAutoUid() {
			if (!autoUidEl) return
			const next = formatUidHex(incrementUidBytes(parseHexBytes(autoUidEl.value)))
			autoUidEl.value = next
			// 同步下行唯一码，方便对照
			if (uidHexEl) uidHexEl.value = next
			saveUi()
			autoLogLine('唯一码已 +1 → ' + next, 'info')
		}

		async function runAutoTest() {
			if (autoRunning) return
			if (!W.serialApi || !W.serialApi.isOpen()) {
				setAutoStatus('请先打开串口', 'err')
				return
			}
			if (!W.gzTx) {
				setAutoStatus('事务层未加载', 'err')
				return
			}
			const devType = getAutoDevType()
			const def = DEV_TYPES[devType]
			if (!def) {
				setAutoStatus('未知设备类型', 'err')
				return
			}
			const station = autoStationSel ? parseInt(autoStationSel.value, 10) : def.station
			if (def.station !== station) {
				setAutoStatus('设备类型与工位不匹配', 'err')
				return
			}
			const flowKey = def.flow
			// 流程固定以休眠收尾（不可跳过）
			let steps = (FLOW_STEPS[flowKey] || []).slice()
			// 确保末步是休眠
			if (!steps.length || steps[steps.length - 1].cmd !== 0x03) {
				steps = steps.filter(function (s) { return s.cmd !== 0x03 })
				steps.push({ cmd: 0x03, name: '休眠', expect: 0x83 })
			}
			// 可选：先设置唯一码(0x0A)
			if (autoSetUid && autoSetUid.checked) {
				steps.unshift({ cmd: 0x0A, name: '设置唯一码', expect: 0x8A })
			}
			if (!steps.length) {
				setAutoStatus('无测试步骤', 'err')
				return
			}

			const timeoutMs = autoTimeout ? (parseInt(autoTimeout.value, 10) || 3000) : 3000
			const gapMs = autoGap ? (parseInt(autoGap.value, 10) || 0) : 0
			const uidHex = autoUidEl ? autoUidEl.value : ''
			const uidOp = autoUidOpSel ? (parseInt(autoUidOpSel.value, 10) & 0xff) : 1
			const uidBytes = parseHexBytes(uidHex)
			const needsUid = steps.some(function (s) { return cmdNeedsUid(s.cmd) })
			if (needsUid) {
				if (!uidBytes.length) {
					setAutoStatus('请填写唯一码(7 字节 HEX)', 'err')
					return
				}
				if (uidBytes.length < 7) {
					setAutoStatus('唯一码不足 7 字节(当前 ' + uidBytes.length + ')', 'err')
					return
				}
			}

			autoStopFlag = false
			setAutoUi(true)
			if (autoLog) autoLog.innerHTML = ''
			if (autoSummary) {
				autoSummary.textContent = ''
				autoSummary.className = 'sk-rw-summary'
			}
			setAutoProgress(0, steps.length)
			setAutoStatus('测试中 · 工位' + station + ' · ' + def.name, 'run')
			autoLogLine('开始一键测试: 工位' + station + ' · 0x' + hexByte(devType) + ' ' + def.name, 'info')
			autoLogLine('步骤: ' + steps.map(function (s) { return s.name }).join(' → '), 'info')
			if (needsUid) autoLogLine('唯一码: ' + formatUidHex(uidBytes), 'info')
			W.gzTx.clearBuffer()

			let pass = 0
			let fail = 0
			let cancelled = false

			for (let i = 0; i < steps.length; i++) {
				if (autoStopFlag) {
					autoLogLine('用户停止', 'warn')
					cancelled = true
					break
				}
				if (!W.serialApi.isOpen()) {
					autoLogLine('串口已关闭', 'fail')
					fail++
					break
				}
				const step = steps[i]
				const label = '[' + (i + 1) + '/' + steps.length + '] ' + step.name + ' (0x' + hexByte(step.cmd) + ')'
				setAutoStatus(label, 'run')
				W.gzTx.clearBuffer()
				const opts = { devType: devType, cmd: step.cmd }
				if (step.cmd === 0x08) {
					opts.uidOp = uidOp
					opts.uidHex = uidHex
				} else if (step.cmd === 0x0A) {
					opts.uidHex = uidHex
				}
				let built
				try {
					built = buildDownFrame(opts)
				} catch (e) {
					autoLogLine('✗ ' + label + ' 构造失败: ' + e.message, 'fail')
					fail++
					break
				}
				const expectCmd = step.expect
				const t0 = Date.now()
				try {
					const res = await W.gzTx.sendAndWait({
						frame: built.frame,
						timeoutMs: timeoutMs,
						match: function (parsed) {
							if (!parsed || !parsed.xorOk) return false
							if (expectCmd != null && parsed.cmd !== expectCmd) return false
							if (parsed.devType != null && parsed.devType !== devType) return false
							return true
						},
					})
					const ms = Date.now() - t0
					const p = res.frame
					let extra = ''
					if (p.cmd === 0x8A && p.info && p.info.length) {
						const r = p.info[0] & 0xff
						if (r !== 0) throw new Error('设置唯一码失败 result=' + r)
						extra = ' 设置成功'
					}
					if (p.decoded) {
						const first = String(p.decoded).split('\n')[0]
						if (first) extra += ' · ' + first
					}
					autoLogLine('✓ ' + label + ' (' + ms + 'ms) 应答0x' + hexByte(p.cmd) + extra, 'pass')
					pass++
				} catch (e) {
					const ms = Date.now() - t0
					const msg = e && e.message ? e.message : String(e)
					if (autoStopFlag || /用户停止|已取消/.test(msg)) {
						autoLogLine('○ ' + label + ' 已取消', 'warn')
						cancelled = true
						break
					}
					autoLogLine('✗ ' + label + ' (' + ms + 'ms) ' + msg, 'fail')
					fail++
					break
				}
				setAutoProgress(i + 1, steps.length)
				if (gapMs > 0 && i + 1 < steps.length) await sleep(gapMs)
			}

			setAutoProgress(pass + fail, steps.length)
			const stopped = cancelled || autoStopFlag
			const allPass = !fail && !stopped && pass === steps.length
			const summary = (stopped ? '已停止' : (fail ? '失败' : '通过')) +
				': 通过' + pass + ' 失败' + fail + ' / 共' + steps.length + '步'
			if (autoSummary) {
				autoSummary.textContent = summary
				autoSummary.className = 'sk-rw-summary ' + (fail ? 'is-fail' : (stopped ? '' : 'is-pass'))
			}
			setAutoStatus(summary, fail ? 'err' : (stopped ? 'warn' : 'ok'))
			autoLogLine(summary, fail ? 'fail' : (stopped ? 'warn' : 'pass'))
			// 整轮通过后唯一码自动 +1（便于连测下一台）
			if (allPass && needsUid) bumpAutoUid()
			setAutoUi(false)
		}

		// 事件 — 下行
		if (stationSel) stationSel.addEventListener('change', function () {
			saved.dev = null
			refreshDevOptions()
			refreshCmdOptions()
			saveUi()
		})
		if (devSel) devSel.addEventListener('change', function () {
			saved.dev = parseInt(devSel.value, 16)
			refreshCmdOptions()
			saveUi()
		})
		if (cmdSel) cmdSel.addEventListener('change', function () { onCmdChange(); saveUi() })
		if (uidOpSel) uidOpSel.addEventListener('change', function () { rebuild(); saveUi() })
		if (uidHexEl) uidHexEl.addEventListener('input', function () { rebuild(); saveUi() })
		if (adMvEl) adMvEl.addEventListener('input', rebuild)
		if (infoEl) infoEl.addEventListener('input', function () {
			if (!infoEl.readOnly) rebuild()
		})
		if (buildBtn) buildBtn.addEventListener('click', rebuild)
		if (sendBtn) sendBtn.addEventListener('click', sendOnce)

		// 事件 — 一键测试
		if (autoStationSel) autoStationSel.addEventListener('change', function () {
			saved.autoDev = null
			refreshAutoDevOptions()
			saveUi()
		})
		if (autoDevSel) autoDevSel.addEventListener('change', function () {
			saved.autoDev = parseInt(autoDevSel.value, 16)
			updateAutoUidVisibility()
			saveUi()
		})
		if (autoSetUid) autoSetUid.addEventListener('change', function () {
			updateAutoUidVisibility()
			saveUi()
		})
		if (autoUidEl) autoUidEl.addEventListener('input', saveUi)
		if (autoUidOpSel) autoUidOpSel.addEventListener('change', saveUi)
		if (autoTimeout) autoTimeout.addEventListener('change', saveUi)
		if (autoGap) autoGap.addEventListener('change', saveUi)
		if (autoBtn) autoBtn.addEventListener('click', runAutoTest)
		if (autoStopBtn) autoStopBtn.addEventListener('click', function () {
			autoStopFlag = true
			if (W.gzTx) W.gzTx.cancelAll('用户停止')
		})

		// 协议面板互斥显隐
		function applyVisibility() {
			const sel = document.getElementById('serial-protocol-select')
			const v = sel ? sel.value : 'sek'
			const isGz = v === 'gz'
			const isSek = v === 'sek'
			const isWmbus = v === 'wmbus'
			const down = $('gz-down-card')
			const auto = $('gz-auto-card')
			if (down) down.style.display = isGz ? '' : 'none'
			if (auto) auto.style.display = isGz ? '' : 'none'
			;['sk-down-card', 'sk-rw-card', 'sk-batch-card', 'serial-protocol-advanced'].forEach(function (id) {
				const el = document.getElementById(id)
				if (el) el.style.display = isSek ? '' : 'none'
			})
			const wm = document.getElementById('wmbus-down-card')
			if (wm) wm.style.display = isWmbus ? '' : 'none'
		}
		const protoSel = document.getElementById('serial-protocol-select')
		if (protoSel) protoSel.addEventListener('change', applyVisibility)
		applyVisibility()

		refreshDevOptions()
		refreshCmdOptions()
		refreshAutoDevOptions()
		if (uidHexEl && !String(uidHexEl.value || '').trim()) {
			uidHexEl.value = '01 02 03 04 05 06 07'
		}
		if (autoUidEl && !String(autoUidEl.value || '').trim()) {
			autoUidEl.value = uidHexEl && uidHexEl.value ? uidHexEl.value : '01 02 03 04 05 06 07'
		}
		updateAutoUidVisibility()
		rebuild()
	}

	tryRegister()
})()
