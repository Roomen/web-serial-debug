// hostProto 模组指令层：帧编解码 + 日志解析协议
// 帧: [FF×4 唤醒前导][EB 90][VT: 高4位 VER=1 低4位 TYPE][CMD u16 LE][SEQ u8][LEN u16 LE ≤255][载荷][CRC16/CCITT-FALSE u16 LE]
// CRC 覆盖 EB 90 到载荷末尾，前导不入 CRC；载荷含 EB/90/FF 免转义；多字节字段小端
// 解析器与设备端同构: 扫描 EB 90，VER≠1 / LEN>255 / CRC 败 → 前进 1 字节续扫，0xFF 与噪声同路径跳过
// PAK、钥表密钥、会话钥、LoRaWAN 密钥在解析展示里一律脱敏为 ****（原始 HEX 日志不受影响）
;(function () {
	'use strict'
	const W = window

	const SOF0 = 0xeb
	const SOF1 = 0x90
	const VER = 1
	const OVERHEAD = 10
	const MAX_PAY = 255
	const MAX_FRAME = MAX_PAY + OVERHEAD
	const WAKE_LEN = 4
	const TYPE_REQ = 0
	const TYPE_RSP = 1
	const TYPE_EVT = 2
	const TYPE_NAME = ['REQ', 'RSP', 'EVT']

	const STATUS = { OK: 0, ERR_FMT: 1, ERR_BUSY: 2, ERR_AUTH: 3, ERR_CMD: 4, ERR_SIZE: 5, ERR_STATE: 6, PENDING: 7, ERR_ROLE: 8 }
	const STATUS_NAME = ['OK', 'ERR_FMT', 'ERR_BUSY', 'ERR_AUTH', 'ERR_CMD', 'ERR_SIZE', 'ERR_STATE', 'PENDING', 'ERR_ROLE']
	const STATUS_DESC = [
		'成功', '载荷格式非法', '忙(在途/槽满/角色被占)', '密钥材料缺失/鉴权失败', '未知命令', '载荷超限',
		'状态不允许', '已受理，结果经同 CMD 的 EVT 补发', '角色白名单拒绝',
	]
	const ROLE_NAME = ['TEST', 'METER', 'CIU', 'WALKBY']
	const WOR_ROLE_NAME = ['NONE', 'SENTRY', 'INITIATOR', 'COLLECTOR']
	// 规范只给出 0=IDLE、1=GRID 两个数值（稳态 [1 SENTRY][1 GRID]、未活动 [0 0]），其余瞬态的数值编号不在文档里，不猜
	const WOR_STATE_NAME = { 0: 'IDLE', 1: 'GRID' }
	const KIND_NAME = { 2: 'ACK', 3: 'DATA', 4: 'UPLINK', 5: 'BEACON' }

	const CMD = {
		ECHO: 0x0001, LINK_STAT: 0x0002, FW_INFO: 0x0003, REBOOT: 0x0004, REBOOT_TO_BOOT: 0x0005, RTC_TIME_GET: 0x0006,
		LW_GET_STATUS: 0x0100, LW_CFG_SET: 0x0101, LW_DEV_EUI_GET: 0x0102, LW_JOIN: 0x0103, LW_LEAVE: 0x0104,
		LW_SEND: 0x0105, LW_CLASS_SET: 0x0106, LW_ADR_SET: 0x0107, LW_NBTRANS_SET: 0x0108, LW_TIME_REQ: 0x0109,
		LW_TIME_GET: 0x010a, LW_BEACON_GET: 0x010b, LW_LINK_CHECK: 0x010c, LW_PERSIST: 0x010d, LW_BATTERY_SET: 0x010e,
		WOR_INIT: 0x0200, WOR_GET_STATUS: 0x0201, WOR_SENTRY_START: 0x0202, WOR_SENTRY_STOP: 0x0203,
		WOR_BEACON_SET: 0x0204, WOR_BEACON_EN: 0x0205, WOR_BEACON_RATE: 0x0206, WOR_WAKE: 0x0207, WOR_WAKE_CIU: 0x0208,
		WOR_PROBE: 0x0209, WOR_SEND: 0x020a, WOR_FINISH: 0x020b, WOR_SET_UPLINK: 0x020c, WOR_COLLECTOR_START: 0x020d,
		WOR_COLLECTOR_STOP: 0x020e, WOR_STATS_GET: 0x020f, WOR_SESSION_KEY_SET: 0x0210,
		PROV_AUTH: 0x0300, PROV_DEV_ID_GET: 0x0301, PROV_DEV_ID_SET: 0x0302, PROV_PAK_SET: 0x0303,
		PROV_FACTORY_RESET: 0x0304, PROV_ROLE_SET: 0x0305, PROV_ROLE_GET: 0x0306,
		PROV_KEYS_BEGIN: 0x0310, PROV_KEYS_SLOT_SET: 0x0311, PROV_KEYS_COMMIT: 0x0312, PROV_KEYS_QUERY: 0x0313,
	}
	const EVT = {
		LW_JOINED: 0x0180, LW_JOIN_FAIL: 0x0181, LW_TX_DONE: 0x0182, LW_DOWNDATA: 0x0183, LW_CLASSB: 0x0184,
		LW_TIME_SYNCED: 0x0185, LW_LINK_CHECK: 0x0186, LW_PERSIST: 0x0187, WOR_FRAME: 0x0280,
	}
	const CMD_NAME = {}
	Object.keys(CMD).forEach(k => { CMD_NAME[CMD[k]] = k })
	const EVT_NAME = {}
	Object.keys(EVT).forEach(k => { EVT_NAME[EVT[k]] = k })
	// 这四条 RSP OK 之后模组即复位，重试会在新固件上再执行一次
	const NO_RETRY = [CMD.REBOOT, CMD.REBOOT_TO_BOOT, CMD.PROV_FACTORY_RESET, CMD.PROV_ROLE_SET]

	const LINK_STAT_FIELDS = ['rxFrames', 'rxReq', 'rxCrcErr', 'rxVerErr', 'rxLenErr', 'rxOvf', 'rxIgnored', 'reqReplays', 'txFrames', 'txEvt', 'txBusy']
	const WOR_STATS_FIELDS = [
		'worTx', 'wakeOk', 'ackErr', 'bcastTx', 'probeTx', 'dataTx', 'dataFail', 'endTx', 'upRx', 'upErr',
		'wakes', 'uniWakes', 'bcastWakes', 'ciuWakes', 'dupWakes', 'foreignIg', 'ackTx', 'ackFail', 'dataRx', 'dataErr',
		'serveIdleExit', 'capExit', 'endRx', 'upTx', 'upFail',
		'hopHist0', 'hopHist1', 'hopHist2', 'hopHist3', 'hopHist4', 'hopHist5', 'hopHist6', 'hopHist7', 'hopHist8',
		'gridBeats', 'gridCb', 'fpBursts', 'beaconTx', 'beaconRx', 'beaconErr', 'bcWin',
		'micFail', 'keyMiss', 'replay', 'sessReplay', 'evtDrop', 'evtLatched',
	]

	// ===== 工具 =====
	function toU8(b) {
		if (b instanceof Uint8Array) return b
		return Uint8Array.from(b || [])
	}
	function h2(b) { return ((b & 0xff) < 16 ? '0' : '') + (b & 0xff).toString(16).toUpperCase() }
	function hexSpaced(b) {
		const out = []
		for (let i = 0; i < b.length; i++) out.push(h2(b[i]))
		return out.join(' ')
	}
	function hexByte(b) { return '0x' + h2(b) }
	function hex4(v) { return '0x' + (v & 0xffff).toString(16).toUpperCase().padStart(4, '0') }
	function escHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
	}
	function asciiSafe(b) {
		let s = ''
		for (let i = 0; i < b.length; i++) s += (b[i] >= 0x20 && b[i] < 0x7f) ? String.fromCharCode(b[i]) : '.'
		return s
	}
	function u16(p, o) { return p[o] | (p[o + 1] << 8) }
	function u32(p, o) { return ((p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0) }
	function u64(p, o) {
		let v = 0n
		for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(p[o + i])
		return v
	}
	function u64Bytes(v) {
		let x = BigInt(v)
		if (x < 0n || x > 0xffffffffffffffffn) throw new Error('u64 超出范围')
		const out = new Uint8Array(8)
		for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n }
		return out
	}
	function hexToBytes(s) {
		const str = String(s || '').replace(/[\s:,]/g, '')
		if (str.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(str)) return null
		const a = new Uint8Array(str.length / 2)
		for (let i = 0; i < a.length; i++) a[i] = parseInt(str.substr(i * 2, 2), 16)
		return a
	}
	function allZero(b) {
		for (let i = 0; i < b.length; i++) if (b[i]) return false
		return true
	}
	function cmdName(cmd) { return CMD_NAME[cmd] || EVT_NAME[cmd] || null }

	// ===== CRC-16/CCITT-FALSE: poly 0x1021 init 0xFFFF 不反转 无异或 =====
	function crc16(data, len) {
		let c = 0xffff
		const n = len == null ? data.length : len
		for (let i = 0; i < n; i++) {
			c ^= (data[i] << 8)
			for (let k = 0; k < 8; k++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xffff) : ((c << 1) & 0xffff)
		}
		return c
	}

	// ===== 组帧 =====
	// o: { type=0, cmd, seq, payload, preamble=true }
	function buildFrame(o) {
		const payload = toU8(o.payload || [])
		if (payload.length > MAX_PAY) throw new Error('载荷超过 255 字节')
		const pre = o.preamble === false ? 0 : WAKE_LEN
		const type = o.type == null ? TYPE_REQ : o.type
		const f = new Uint8Array(pre + OVERHEAD + payload.length)
		f.fill(0xff, 0, pre)
		let n = pre
		f[n++] = SOF0
		f[n++] = SOF1
		f[n++] = (VER << 4) | (type & 0x0f)
		f[n++] = o.cmd & 0xff
		f[n++] = (o.cmd >> 8) & 0xff
		f[n++] = o.seq & 0xff
		f[n++] = payload.length & 0xff
		f[n++] = (payload.length >> 8) & 0xff
		f.set(payload, n)
		n += payload.length
		const crc = crc16(f.subarray(pre, n), n - pre)
		f[n++] = crc & 0xff
		f[n++] = (crc >> 8) & 0xff
		return f
	}

	// ===== 扫描 =====
	// 从 from 起找下一个合法帧。返回:
	//   { status:'frame', offset, total, type, cmd, seq, payload }
	//   { status:'wait', offset }  候选帧还没收全，offset 之前的字节可以丢弃（流式用）
	//   { status:'none', keep }    没有候选，只需保留末尾 keep(0/1) 个字节（半个 EB）
	// final=true（一次性给全的整段数据）时，收不全的候选按无效处理，继续往后找
	function scan(b, from, final) {
		const n = b.length
		let i = from || 0
		for (;;) {
			while (i < n && b[i] !== SOF0) i++
			if (i >= n) return { status: 'none', keep: 0 }
			if (i + 1 >= n) return final ? { status: 'none', keep: 0 } : { status: 'none', keep: 1 }
			if (b[i + 1] !== SOF1) { i++; continue }
			if (n - i < 8) {
				if (final) { i++; continue }
				return { status: 'wait', offset: i }
			}
			const vt = b[i + 2]
			const len = u16(b, i + 6)
			if ((vt >> 4) !== VER || len > MAX_PAY) { i++; continue }
			const total = len + OVERHEAD
			if (n - i < total) {
				if (final) { i++; continue }
				return { status: 'wait', offset: i }
			}
			const crcCalc = crc16(b.subarray(i), total - 2)
			const crcRx = u16(b, i + total - 2)
			if (crcCalc !== crcRx) { i++; continue }
			return {
				status: 'frame', offset: i, total: total, type: vt & 0x0f, cmd: u16(b, i + 3), seq: b[i + 5],
				payload: b.subarray(i + 8, i + 8 + len),
			}
		}
	}

	// 日志/剪贴板用: 在一段数据里找第一个合法帧（帧本体不含前导）
	function findFrame(bytes) {
		const b = toU8(bytes)
		const s = scan(b, 0, true)
		if (s.status !== 'frame') return { found: false, offset: 0, length: b.length, frame: b, prefix: 0, suffix: 0 }
		return {
			found: true, offset: s.offset, length: s.total, frame: b.slice(s.offset, s.offset + s.total),
			prefix: s.offset, suffix: b.length - s.offset - s.total,
		}
	}

	// ===== 载荷构造 / 解码 =====
	function woInitPayload(role, addr) {
		const a = u64Bytes(addr)
		const p = new Uint8Array(9)
		p[0] = role
		p.set(a, 1)
		return p
	}
	function wakePayload(dst, reason) {
		const p = new Uint8Array(9)
		p.set(u64Bytes(dst), 0)
		p[8] = reason
		return p
	}
	function sendPayload(data) {
		const d = toU8(data)
		if (d.length > 64) throw new Error('WOR_SEND 数据最长 64 字节')
		const p = new Uint8Array(2 + d.length)
		p[0] = d.length & 0xff
		p[1] = (d.length >> 8) & 0xff
		p.set(d, 2)
		return p
	}
	function setUplinkPayload(data) {
		const d = toU8(data)
		if (d.length > 64) throw new Error('WOR_SET_UPLINK 数据最长 64 字节')
		const p = new Uint8Array(1 + d.length)
		p[0] = d.length
		p.set(d, 1)
		return p
	}
	function devIdSetPayload(devType, drn) {
		const p = new Uint8Array(9)
		p[0] = devType
		p.set(u64Bytes(drn), 1)
		return p
	}
	function decodeDevId(p) {
		if (p.length !== 9) return null
		return { devType: p[0], drn: u64(p, 1) }
	}
	function decodeWorStatus(p) {
		if (p.length < 2) return null
		return { role: p[0], state: p[1] }
	}
	// 规范写的是空格垫齐，实板固件用 \0 垫齐：遇到 \0 截断，不把垫字节显示成 '.'
	function fixedAscii(b) {
		const z = b.indexOf(0)
		return asciiSafe(z === -1 ? b : b.subarray(0, z)).trim()
	}
	function decodeFwInfo(p) {
		if (p.length < 55) return null
		return {
			protoVer: p[0],
			board: fixedAscii(p.subarray(1, 17)),
			appGit: fixedAscii(p.subarray(17, 25)),
			appDirty: p[25],
			sdkGit: fixedAscii(p.subarray(26, 34)),
			sdkDirty: p[34],
			buildTime: fixedAscii(p.subarray(35, 55)),
		}
	}
	// EVT 0x0280: [src u64][kind u8][seq u16][len u8][data][rssi i16][snr i8]
	function decodeWorFrame(p) {
		if (p.length < 12) return null
		const len = p[11]
		if (p.length < 12 + len + 3) return null
		const rssi = u16(p, 12 + len)
		return {
			src: u64(p, 0), kind: p[8], seq: u16(p, 9), len: len,
			data: p.slice(12, 12 + len),
			rssi: rssi >= 0x8000 ? rssi - 0x10000 : rssi,
			snr: p[14 + len] >= 0x80 ? p[14 + len] - 0x100 : p[14 + len],
		}
	}

	// ===== 解析展示 =====
	function nestedSts(data, indent) {
		const S = W.stsCiu
		if (!S || !data || data.length < 6) return null
		const found = S.findFrame(data)
		if (!found.found) return null
		const r = S.parseFrame(data)
		if (!r.ok) return null
		return { result: r, lines: ['STS-CIU 应用帧（' + r.fields.表号 + ' ' + r.fields.类型.name + ' TXN ' + r.fields.事务号 + '）:'].concat((r.decoded || '').split('\n').map(l => indent + l)) }
	}

	// 返回 { lines, segs, masked }，segs 的 off 相对载荷起点
	function decodeReqPayload(cmd, p) {
		const lines = []
		const segs = []
		const seg = (off, len, tip, grp) => { if (len > 0 && off < p.length) segs.push({ off: off, len: Math.min(len, p.length - off), tip: tip, grp: grp }) }
		const need = (n, name) => {
			if (p.length !== n) { lines.push(name + ' 载荷长度应为 ' + n + '，实际 ' + p.length); return false }
			return true
		}
		switch (cmd) {
			case CMD.ECHO:
				lines.push('回显数据 = ' + hexSpaced(p) + ' "' + asciiSafe(p) + '"')
				break
			case CMD.WOR_INIT:
				if (need(9, 'WOR_INIT')) {
					lines.push('WOR 角色 = ' + p[0] + ' ' + (WOR_ROLE_NAME[p[0]] || '未知') + '（建议值）')
					lines.push('本机地址 = ' + u64(p, 1))
					seg(0, 1, 'WOR 角色', '角色'); seg(1, 8, '本机地址 u64 LE', '地址')
				}
				break
			case CMD.WOR_WAKE:
			case CMD.WOR_WAKE_CIU:
				if (need(9, 'WOR_WAKE')) {
					lines.push('目标地址 = ' + u64(p, 0))
					lines.push('reason = ' + p[8] + '（台架惯例 1=读表 2=参数）')
					seg(0, 8, '目标地址 u64 LE', '地址'); seg(8, 1, 'reason', 'reason')
				}
				break
			case CMD.WOR_PROBE:
				if (need(8, 'WOR_PROBE')) { lines.push('目标地址 = ' + u64(p, 0)); seg(0, 8, '目标地址 u64 LE', '地址') }
				break
			case CMD.WOR_SEND: {
				if (p.length < 2) { lines.push('WOR_SEND 载荷不足'); break }
				const len = u16(p, 0)
				lines.push('数据长度 = ' + len + (p.length - 2 === len ? '' : '（与实际 ' + (p.length - 2) + ' 不符）'))
				const data = p.subarray(2)
				lines.push('数据 = ' + hexSpaced(data))
				seg(0, 2, '数据长度 u16 LE', '长度'); seg(2, data.length, '下行数据', '数据')
				const n = nestedSts(data, '  ')
				if (n) {
					n.lines.forEach(l => lines.push(l))
					nestedSegs(n.result, 2, segs)
				}
				break
			}
			case CMD.WOR_SET_UPLINK: {
				if (p.length < 1) { lines.push('WOR_SET_UPLINK 载荷不足'); break }
				lines.push('数据长度 = ' + p[0] + (p.length - 1 === p[0] ? '' : '（与实际 ' + (p.length - 1) + ' 不符）'))
				const data = p.subarray(1)
				lines.push('信箱数据 = ' + hexSpaced(data))
				seg(0, 1, '数据长度', '长度'); seg(1, data.length, '上行信箱数据', '数据')
				const n = nestedSts(data, '  ')
				if (n) {
					n.lines.forEach(l => lines.push(l))
					nestedSegs(n.result, 1, segs)
				}
				break
			}
			case CMD.WOR_SESSION_KEY_SET:
				if (need(17, 'WOR_SESSION_KEY_SET')) {
					lines.push('id = ' + p[0]); lines.push('key = ' + (allZero(p.subarray(1)) ? '已脱敏' : '****'))
					seg(0, 1, '会话钥 id', 'id'); seg(1, 16, '会话钥(已脱敏)', 'key')
				}
				break
			case CMD.PROV_AUTH:
			case CMD.PROV_PAK_SET:
				lines.push((cmd === CMD.PROV_AUTH ? 'PAK' : '新 PAK') + ' = ' + (allZero(p) ? '已脱敏' : '****') + (p.length === 16 ? '' : '（长度 ' + p.length + '，应为 16）'))
				seg(0, p.length, 'PAK(已脱敏)', 'PAK')
				break
			case CMD.PROV_DEV_ID_SET:
				if (need(9, 'DEV_ID_SET')) {
					lines.push('devType = ' + p[0] + ' ' + (ROLE_NAME[p[0]] || ''))
					lines.push('DRN = ' + u64(p, 1))
					seg(0, 1, 'devType', 'devType'); seg(1, 8, 'DRN u64 LE', 'DRN')
				}
				break
			case CMD.PROV_ROLE_SET:
				if (need(1, 'ROLE_SET')) { lines.push('角色 = ' + p[0] + ' ' + (ROLE_NAME[p[0]] || '非法')); seg(0, 1, '角色', '角色') }
				break
			case CMD.PROV_KEYS_BEGIN:
				if (need(3, 'KEYS_BEGIN')) lines.push('pairCnt = ' + p[0] + ' bcastCnt = ' + p[1] + ' ciuCnt = ' + p[2])
				break
			case CMD.PROV_KEYS_SLOT_SET:
				if (need(19, 'KEYS_SLOT_SET')) {
					lines.push('plane = ' + p[0] + ' idx = ' + p[1] + ' id = ' + p[2] + ' key = ' + (allZero(p.subarray(3)) ? '已脱敏' : '****'))
					seg(0, 3, 'plane/idx/id', '槽位'); seg(3, 16, '密钥(已脱敏)', 'key')
				}
				break
			case CMD.PROV_KEYS_COMMIT:
				if (need(3, 'KEYS_COMMIT')) lines.push('activePair = ' + p[0] + ' activeBcast = ' + p[1] + ' activeCiu = ' + p[2])
				break
			case CMD.LW_CFG_SET:
				if (need(48, 'LW_CFG_SET')) {
					lines.push('devEui = ' + hexSpaced(p.subarray(0, 8)) + '  joinEui = ' + hexSpaced(p.subarray(8, 16)))
					{ const m = allZero(p.subarray(16)) ? '已脱敏' : '****'; lines.push('nwkKey = ' + m + '  appKey = ' + m) }
					seg(0, 16, 'devEui/joinEui', 'EUI'); seg(16, 32, '密钥(已脱敏)', 'key')
				}
				break
			default:
				if (p.length) lines.push('载荷 = ' + hexSpaced(p))
				else lines.push('（无载荷）')
		}
		return { lines: lines, segs: segs }
	}

	// 嵌套的应用帧字节提示，平移到外层帧的偏移
	function nestedSegs(inner, baseOff, segs) {
		const S = W.stsCiu
		const bm = S.byteMap(inner)
		for (let i = 0; i < bm.length; i++) {
			if (bm[i] && bm[i].tip) segs.push({ off: baseOff + i, len: 1, tip: 'STS-CIU: ' + bm[i].tip, grp: 'STS ' + bm[i].grp, nested: true })
		}
	}

	function decodeRspResult(cmd, r) {
		const lines = []
		const segs = []
		const seg = (off, len, tip, grp) => { if (len > 0 && off < r.length) segs.push({ off: off, len: Math.min(len, r.length - off), tip: tip, grp: grp }) }
		switch (cmd) {
			case CMD.ECHO:
				lines.push('回显 = ' + hexSpaced(r) + ' "' + asciiSafe(r) + '"')
				break
			case CMD.LINK_STAT:
				if (r.length < 44) { lines.push('LINK_STAT 结果不足 44 字节'); break }
				lines.push(LINK_STAT_FIELDS.map((n, i) => n + '=' + u32(r, i * 4)).join('  '))
				break
			case CMD.FW_INFO: {
				const f = decodeFwInfo(r)
				if (!f) { lines.push('FW_INFO 结果不足 55 字节'); break }
				lines.push('protoVer = ' + f.protoVer + '  board = "' + f.board + '"')
				lines.push('appGit = ' + f.appGit + (f.appDirty ? ' (dirty)' : '') + '  sdkGit = ' + f.sdkGit + (f.sdkDirty ? ' (dirty)' : ''))
				lines.push('buildTime = ' + f.buildTime)
				break
			}
			case CMD.RTC_TIME_GET:
				if (r.length >= 8) lines.push('RTC 计数 = ' + u32(r, 0) + ' s ' + u32(r, 4) + ' ms（原始计数，非墙钟）')
				break
			case CMD.PROV_ROLE_GET:
				if (r.length >= 1) { lines.push('角色 = ' + r[0] + ' ' + (ROLE_NAME[r[0]] || '未知')); seg(0, 1, '角色', '角色') }
				break
			case CMD.PROV_ROLE_SET:
				if (r.length >= 1) lines.push('角色 = ' + r[0] + ' ' + (ROLE_NAME[r[0]] || '未知'))
				break
			case CMD.PROV_DEV_ID_GET: {
				const d = decodeDevId(r)
				if (!d) { lines.push('DEV_ID_GET 结果应为 9 字节'); break }
				lines.push('devType = ' + d.devType + ' ' + (ROLE_NAME[d.devType] || '') + '  DRN = ' + d.drn)
				seg(0, 1, 'devType', 'devType'); seg(1, 8, 'DRN u64 LE', 'DRN')
				break
			}
			case CMD.WOR_GET_STATUS: {
				const d = decodeWorStatus(r)
				if (!d) { lines.push('WOR_GET_STATUS 结果不足 2 字节'); break }
				lines.push('WOR 角色 = ' + d.role + ' ' + (WOR_ROLE_NAME[d.role] || '未知') + '  状态 = ' + d.state + (WOR_STATE_NAME[d.state] ? ' ' + WOR_STATE_NAME[d.state] : ''))
				seg(0, 1, 'WOR 运行时角色', '角色'); seg(1, 1, 'WOR 状态', '状态')
				break
			}
			case CMD.WOR_STATS_GET: {
				if (r.length < 2) { lines.push('WOR_STATS_GET 结果不足'); break }
				const len = u16(r, 0)
				const nz = []
				for (let i = 0; i < WOR_STATS_FIELDS.length && 2 + i * 4 + 4 <= r.length; i++) {
					const v = u32(r, 2 + i * 4)
					if (v) nz.push(WOR_STATS_FIELDS[i] + '=' + v)
				}
				lines.push('统计长度 = ' + len + ' B  非零项: ' + (nz.length ? nz.join('  ') : '(全 0)'))
				break
			}
			case CMD.LW_GET_STATUS:
				if (r.length >= 9) {
					const duty = u32(r, 3) | 0
					lines.push('joined = ' + r[0] + '  class = ' + 'ABC'[r[1]] + '  maxPay = ' + r[2] + '  dutyMs = ' + duty + '  lostCnt = ' + u16(r, 7))
				}
				break
			default:
				if (r.length) lines.push('结果 = ' + hexSpaced(r))
		}
		return { lines: lines, segs: segs }
	}

	function decodeEvt(cmd, p) {
		const lines = []
		const segs = []
		const seg = (off, len, tip, grp) => { if (len > 0 && off < p.length) segs.push({ off: off, len: Math.min(len, p.length - off), tip: tip, grp: grp }) }
		if (cmd === EVT.WOR_FRAME) {
			const d = decodeWorFrame(p)
			if (!d) { lines.push('WOR 帧事件载荷长度不足'); return { lines: lines, segs: segs } }
			lines.push('来源地址 src = ' + d.src)
			lines.push('kind = ' + d.kind + ' ' + (KIND_NAME[d.kind] || '未知') + '  seq = ' + d.seq + '  len = ' + d.len)
			lines.push('data = ' + hexSpaced(d.data))
			lines.push('rssi = ' + d.rssi + ' dBm  snr = ' + d.snr + ' dB')
			seg(0, 8, '来源地址 u64 LE', '地址'); seg(8, 1, 'kind ' + (KIND_NAME[d.kind] || ''), 'kind'); seg(9, 2, 'seq', 'seq'); seg(11, 1, 'data 长度', '长度')
			seg(12, d.len, 'data', '数据'); seg(12 + d.len, 2, 'rssi i16', 'rssi'); seg(14 + d.len, 1, 'snr i8', 'snr')
			const n = nestedSts(d.data, '  ')
			if (n) {
				n.lines.forEach(l => lines.push(l))
				nestedSegs(n.result, 12, segs)
			}
			return { lines: lines, segs: segs }
		}
		switch (cmd) {
			case EVT.LW_JOINED: lines.push('reason = ' + p[0] + '（0=OTAA 新入网 2=暖启动恢复）'); break
			case EVT.LW_JOIN_FAIL: lines.push('reason = ' + p[0]); break
			case EVT.LW_TX_DONE: lines.push('status = ' + p[0] + '（0=WAITING 1=SENT 2=CONFIRMED 3=NO_ACK 4=FAILED）'); break
			case EVT.LW_DOWNDATA:
				if (p.length >= 5) lines.push('fport = ' + p[0] + '  rssi = ' + ((u16(p, 1) << 16) >> 16) + '  snr = ' + ((p[3] << 24) >> 24) + '  len = ' + p[4] + '  data = ' + hexSpaced(p.subarray(5)))
				break
			default:
				if (p.length) lines.push('载荷 = ' + hexSpaced(p))
		}
		return { lines: lines, segs: segs }
	}

	// 解一个已通过 CRC 的帧: { fields, lines, segs, errors }
	function analyzeFrame(f) {
		const errors = []
		const p = f.payload
		const dirTxt = f.type === TYPE_REQ ? '↓ 请求(主机→模组)' : f.type === TYPE_RSP ? '↑ 应答(模组→主机)' : f.type === TYPE_EVT ? '↑ 事件(模组→主机)' : '未知类型'
		const name = cmdName(f.cmd)
		const fields = {
			方向: dirTxt,
			类型: { value: String(f.type), name: TYPE_NAME[f.type] || '未知' },
			命令: { value: hex4(f.cmd), name: name || '未知命令' },
			SEQ: f.seq,
			载荷长度: p.length,
		}
		let body = { lines: [], segs: [] }
		let base = 8 // 载荷在帧内的起点（相对 EB）
		if (f.type === TYPE_REQ) {
			body = decodeReqPayload(f.cmd, p)
		} else if (f.type === TYPE_RSP) {
			if (p.length < 1) {
				errors.push('RSP 载荷缺少 STATUS 字节')
			} else {
				fields.状态 = { value: hexByte(p[0]), name: (STATUS_NAME[p[0]] || '未知') + (STATUS_DESC[p[0]] ? ' ' + STATUS_DESC[p[0]] : '') }
				if (p[0] === STATUS.OK) body = decodeRspResult(f.cmd, p.subarray(1))
				else if (p.length > 1) body.lines.push('附加数据 = ' + hexSpaced(p.subarray(1)))
				body.segs = (body.segs || []).map(s => ({ off: s.off + 1, len: s.len, tip: s.tip, grp: s.grp }))
				body.segs.unshift({ off: 0, len: 1, tip: 'STATUS ' + (STATUS_NAME[p[0]] || ''), grp: 'STATUS' })
			}
		} else if (f.type === TYPE_EVT) {
			body = decodeEvt(f.cmd, p)
			if (f.seq !== 0) errors.push('EVT 的 SEQ 应恒为 0')
		} else {
			errors.push('TYPE ' + f.type + ' 未定义')
		}
		body.segs = body.segs.map(s => ({ off: base + s.off, len: s.len, tip: s.tip, grp: s.grp, nested: s.nested }))
		return { fields: fields, lines: body.lines, segs: body.segs, errors: errors }
	}

	// 解析一段数据（可含前导、多个帧、噪声）: 帧本体解出来，多帧依次展示
	function parseFrame(bytes) {
		const raw = toU8(bytes)
		const result = { raw: Array.from(raw), ok: false, errors: [], fields: {}, frameOffset: 0, frames: [] }
		let pos = 0
		while (pos < raw.length) {
			const s = scan(raw, pos, true)
			if (s.status !== 'frame') break
			const a = analyzeFrame(s)
			a.offset = s.offset
			a.total = s.total
			a.type = s.type
			result.frames.push(a)
			pos = s.offset + s.total
		}
		if (!result.frames.length) {
			result.errors.push('未找到有效的 hostProto 帧（需 EB 90 起始、VER=1、LEN≤255 且 CRC16 正确）')
			return result
		}
		const first = result.frames[0]
		result.frameOffset = first.offset
		result.fields = first.fields
		result.decoded = first.lines.join('\n')
		result.errors = first.errors.slice()
		result.dir = first.type === TYPE_REQ ? 'down' : 'up'
		result.ok = result.errors.length === 0
		return result
	}

	function fieldsGrid(f) {
		const cells = []
		for (const k in f) {
			const v = f[k]
			const val = (v != null && typeof v === 'object' && v.name !== undefined) ? escHtml(v.value) + ' (' + escHtml(v.name) + ')' : escHtml(String(v))
			cells.push({ name: k, value: val })
		}
		let h = ''
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
		return h
	}

	function formatFrame(r) {
		let h = '<div class="sk-parse">'
		h += '<div class="sk-parse-bar">' + (r.ok ? '✓' : '✗') + '</div>'
		const frames = r.frames && r.frames.length ? r.frames : null
		if (!frames) {
			h += fieldsGrid(r.fields || {})
			if (r.errors && r.errors.length) {
				h += '<div class="sk-parse-errors">' + r.errors.map(e => '<div>' + escHtml(e) + '</div>').join('') + '</div>'
			}
			return h + '</div>'
		}
		frames.forEach((fr, idx) => {
			if (idx > 0) h += '<div class="sk-parse-note">帧 #' + (idx + 1) + '</div>'
			h += fieldsGrid(fr.fields)
			if (fr.lines.length) {
				h += '<div class="sk-parse-tlvs"><details class="sk-parse-tag" open><summary>载荷解析</summary>' +
					'<div class="sk-parse-items"><pre style="white-space:pre-wrap;margin:0;">' + escHtml(fr.lines.join('\n')) + '</pre></div></details></div>'
			}
			if (fr.errors.length) h += '<div class="sk-parse-errors">' + fr.errors.map(e => '<div>' + escHtml(e) + '</div>').join('') + '</div>'
		})
		return h + '</div>'
	}

	function byteMap(r) {
		const bytes = Array.isArray(r.raw) ? r.raw : Array.from(r.raw || [])
		const n = bytes.length
		const map = new Array(n).fill('')
		const frames = r.frames || []
		let cursor = 0
		frames.forEach(fr => {
			const set = (off, len, tip, grp) => { for (let k = 0; k < len; k++) if (fr.offset + off + k < n) map[fr.offset + off + k] = { tip: tip, grp: grp } }
			// 帧前的 FF 是唤醒前导
			for (let i = cursor; i < fr.offset; i++) if (bytes[i] === 0xff) map[i] = { tip: '唤醒前导 FF（不参与解析与 CRC）', grp: '前导' }
			set(0, 2, '帧起始 EB 90', '帧头')
			set(2, 1, 'VT: VER=1 TYPE=' + (TYPE_NAME[fr.type] || fr.type), 'VT')
			set(3, 2, '命令 ' + hex4(bytes[fr.offset + 3] | (bytes[fr.offset + 4] << 8)) + ' ' + (cmdName(bytes[fr.offset + 3] | (bytes[fr.offset + 4] << 8)) || ''), '命令')
			set(5, 1, 'SEQ', 'SEQ')
			set(6, 2, '载荷长度 u16 LE', '长度')
			fr.segs.forEach(s => set(s.off, s.len, s.tip, s.grp))
			set(fr.total - 2, 2, 'CRC16/CCITT-FALSE (LE)', 'CRC')
			cursor = fr.offset + fr.total
		})
		return map
	}

	function buildDownFrame(opt) {
		const o = opt || {}
		const cmd = typeof o.cmd === 'string' ? parseInt(o.cmd, 16) : o.cmd
		if (!Number.isFinite(cmd) || cmd < 0 || cmd > 0xffff) throw new Error('命令号非法')
		let payload = o.payload
		if (o.payloadHex != null) {
			payload = hexToBytes(o.payloadHex)
			if (!payload) throw new Error('载荷需为 HEX')
		}
		return buildFrame({ type: TYPE_REQ, cmd: cmd, seq: o.seq == null ? 0 : o.seq, payload: payload || [], preamble: o.preamble !== false })
	}

	const PRESET_ITEMS = [
		['ECHO', CMD.ECHO, '50494E47', '探活，载荷 "PING"'],
		['固件信息 FW_INFO', CMD.FW_INFO, '', '读固件信息'],
		['链路统计 LINK_STAT', CMD.LINK_STAT, '', '11×u32 计数'],
		['读角色 ROLE_GET', CMD.PROV_ROLE_GET, '', '0=TEST 1=METER 2=CIU 3=WALKBY'],
		['读身份 DEV_ID_GET', CMD.PROV_DEV_ID_GET, '', '[devType][DRN u64 LE]'],
		['WOR 状态 WOR_GET_STATUS', CMD.WOR_GET_STATUS, '', '[role][state]'],
		['WOR 统计 WOR_STATS_GET', CMD.WOR_STATS_GET, '', '47×u32'],
	]
	const PRESETS = [{
		group: 'hostProto 常用无参命令',
		items: PRESET_ITEMS.map(x => ({ name: x[0], func: '0x00', desc: x[3], cmd: x[1], payloadHex: x[2] })),
	}]

	W.hostProto = {
		SOF0, SOF1, VER, OVERHEAD, MAX_PAY, MAX_FRAME, WAKE_LEN, TYPE_REQ, TYPE_RSP, TYPE_EVT, TYPE_NAME,
		STATUS, STATUS_NAME, STATUS_DESC, ROLE_NAME, WOR_ROLE_NAME, WOR_STATE_NAME, KIND_NAME,
		CMD, EVT, CMD_NAME, EVT_NAME, NO_RETRY, LINK_STAT_FIELDS, WOR_STATS_FIELDS, cmdName,
		crc16, buildFrame, scan, findFrame, parseFrame, formatFrame, byteMap, buildDownFrame,
		u64, u64Bytes, hexToBytes, hexSpaced, asciiSafe,
		woInitPayload, wakePayload, sendPayload, setUplinkPayload, devIdSetPayload,
		decodeDevId, decodeWorStatus, decodeFwInfo, decodeWorFrame,
	}

	function tryRegister(retry) {
		if (typeof W.registerProtocol === 'function') {
			W.registerProtocol('hostproto', {
				name: 'hostProto 模组',
				parseFrame: parseFrame,
				formatFrame: formatFrame,
				findFrame: findFrame,
				byteMap: byteMap,
				buildDownFrame: buildDownFrame,
				presets: PRESETS,
			})
			const sel = typeof document !== 'undefined' ? document.getElementById('serial-protocol-select') : null
			if (sel && W._activeProtocol === 'hostproto') sel.value = 'hostproto'
			return
		}
		if (typeof setTimeout === 'function' && retry < 100) setTimeout(function () { tryRegister(retry + 1) }, 50)
	}
	tryRegister(0)
})()
