// Run: node tests/hostproto-protocol.cjs — synthetic data only.
// 覆盖: CRC16 向量、规范/测试向量金帧逐字节、找帧重同步、解析展示（脱敏、嵌套）、事务层（假时钟）
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

let registered = null
const window = { registerProtocol(id, impl) { registered = { id, impl } } }
const ctx = { window, Uint8Array, BigInt, document: { getElementById() { return null } } }
vm.createContext(ctx)
for (const f of ['sts-ciu-protocol', 'hostproto-protocol', 'hostproto-transaction']) {
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8'), ctx)
}
const H = window.hostProto
const S = window.stsCiu
const J = x => JSON.parse(JSON.stringify(x)) // 沙箱里创建的对象跨 realm，深比较前先转普通对象
const hex = s => Uint8Array.from(s.split(/\s+/).filter(Boolean).map(x => parseInt(x, 16)))
const bytes = u8 => Array.from(u8)

// ---- 注册 ----
assert.equal(registered.id, 'hostproto')
for (const k of ['parseFrame', 'formatFrame', 'findFrame', 'byteMap', 'buildDownFrame', 'presets']) assert.ok(registered.impl[k], k)
assert.equal(registered.impl.name, 'hostProto 模组')
assert.equal(registered.impl.presets[0].items.length, 7)

// ---- FW_INFO 定长 ASCII: 空格垫齐（规范）与 \0 垫齐（实板固件）都要解出干净的字符串 ----
{
	const field = (s, n, pad) => { const b = new Uint8Array(n).fill(pad); b.set(Buffer.from(s)); return Array.from(b) }
	for (const pad of [0x20, 0x00]) {
		const p = Uint8Array.from([1, ...field('TEST-BOARD', 16, pad), ...field('abc1234', 8, pad), 1, ...field('def5678', 8, pad), 0, ...field('2026-01-02 03:04:05', 20, pad)])
		assert.deepEqual(J(H.decodeFwInfo(p)), { protoVer: 1, board: 'TEST-BOARD', appGit: 'abc1234', appDirty: 1, sdkGit: 'def5678', sdkDirty: 0, buildTime: '2026-01-02 03:04:05' })
	}
}

// ---- CRC16/CCITT-FALSE ----
assert.equal(H.crc16(Buffer.from('123456789')), 0x29b1)
assert.equal(H.crc16(hex('EB 90 10 01 00 5A 04 00 50 49 4E 47')), 0xdf32)
assert.equal(H.crc16(hex('EB 90 11 01 00 5A 05 00 00 50 49 4E 47')), 0x9273)
assert.equal(H.crc16(hex('EB 90 10 10 02 37 11 00 01 A0 A1 A2 A3 A4 A5 A6 A7 A8 A9 AA AB AC AD AE AF')), 0x8d2a)

// ---- 金帧: 规范 §8 与测试向量 §6 / §6.1（不含 PAK 占有与授权两行）----
// 每行: [名称, 整帧十六进制]；REQ 行由帧内解出的 CMD/SEQ/载荷重新组帧，必须逐字节相同
const A0_AF = 'A0 A1 A2 A3 A4 A5 A6 A7 A8 A9 AA AB AC AD AE AF'
const REQ_ROWS = [
	['ECHO PING', 'FF FF FF FF EB 90 10 01 00 5A 04 00 50 49 4E 47 32 DF'],
	['LW_JOIN §8.2', 'FF FF FF FF EB 90 10 03 01 12 00 00 CB A4'],
	['PROV_AUTH 错 PAK §8.6', 'FF FF FF FF EB 90 10 00 03 20 10 00 ' + 'A5 '.repeat(16) + 'F5 BF'],
	['SESSION_KEY_SET §8.7', 'FF FF FF FF EB 90 10 10 02 37 11 00 01 ' + A0_AF + ' 2A 8D'],
	['FACTORY_RESET', 'FF FF FF FF EB 90 10 04 03 2E 00 00 B3 9E'],
	['FACTORY_RESET 多 1B', 'FF FF FF FF EB 90 10 04 03 2F 01 00 00 F3 90'],
	['ROLE_SET CIU', 'FF FF FF FF EB 90 10 05 03 32 01 00 02 30 D7'],
	['KEYS_BEGIN', 'FF FF FF FF EB 90 10 10 03 03 03 00 02 01 01 56 C2'],
	['KEYS_SLOT pair#0', 'FF FF FF FF EB 90 10 11 03 04 13 00 00 00 01 ' + A0_AF + ' 44 53'],
	['KEYS_SLOT pair#1', 'FF FF FF FF EB 90 10 11 03 05 13 00 00 01 02 B0 B1 B2 B3 B4 B5 B6 B7 B8 B9 BA BB BC BD BE BF DA BA'],
	['KEYS_SLOT bcast', 'FF FF FF FF EB 90 10 11 03 06 13 00 01 00 03 30 31 32 33 34 35 36 37 38 39 3A 3B 3C 3D 3E 3F B4 38'],
	['KEYS_SLOT ciu', 'FF FF FF FF EB 90 10 11 03 07 13 00 02 00 05 C0 C1 C2 C3 C4 C5 C6 C7 C8 C9 CA CB CC CD CE CF 7C 85'],
	['KEYS_COMMIT', 'FF FF FF FF EB 90 10 12 03 08 03 00 00 00 00 22 C3'],
	['DEV_ID_SET', 'FF FF FF FF EB 90 10 02 03 09 09 00 01 01 00 00 00 00 00 00 00 A8 57'],
	['DEV_ID_GET', 'FF FF FF FF EB 90 10 01 03 0A 00 00 E2 E7'],
	['ROLE_SET METER', 'FF FF FF FF EB 90 10 05 03 0B 01 00 01 CD 38'],
	['ROLE_SET WALKBY', 'FF FF FF FF EB 90 10 05 03 0C 01 00 03 A2 49'],
	['ROLE_GET', 'FF FF FF FF EB 90 10 06 03 0D 00 00 A6 05'],
	['WOR_INIT 表', 'FF FF FF FF EB 90 10 00 02 0E 09 00 01 01 00 00 00 00 00 00 00 42 EC'],
	['WOR_INIT 发起', 'FF FF FF FF EB 90 10 00 02 0F 09 00 01 02 00 00 00 00 00 00 00 42 27'],
	['SENTRY_START', 'FF FF FF FF EB 90 10 02 02 10 00 00 26 FB'],
	['WOR_WAKE', 'FF FF FF FF EB 90 10 07 02 11 09 00 01 00 00 00 00 00 00 00 01 05 EF'],
	['SET_UPLINK', 'FF FF FF FF EB 90 10 0C 02 12 0C 00 0B 4D 54 52 2D 55 50 2D 30 30 30 31 B5 08'],
	['WOR_SEND 数据包1', 'FF FF FF FF EB 90 10 0A 02 13 06 00 04 00 41 41 41 41 22 CA'],
	['WOR_FINISH', 'FF FF FF FF EB 90 10 0B 02 14 00 00 9A 8F'],
	['BEACON_SET', 'FF FF FF FF EB 90 10 04 02 15 19 00 18 B0 B1 B2 B3 B4 B5 B6 B7 B8 B9 BA BB BC BD BE BF C0 C1 C2 C3 C4 C5 C6 C7 F3 80'],
	['BEACON_RATE', 'FF FF FF FF EB 90 10 06 02 16 01 00 00 7C 6E'],
	['BEACON_EN', 'FF FF FF FF EB 90 10 05 02 17 01 00 01 09 C6'],
	['COLLECTOR_START', 'FF FF FF FF EB 90 10 0D 02 18 00 00 7E 37'],
	['WOR_WAKE_CIU', 'FF FF FF FF EB 90 10 08 02 22 09 00 01 00 00 00 00 00 00 00 02 64 18'],
	['CIU SET_UPLINK', 'FF FF FF FF EB 90 10 0C 02 22 0C 00 0B 43 49 55 2D 55 50 2D 30 30 30 31 57 25'],
	['CIU WOR_SEND 分片1', 'FF FF FF FF EB 90 10 0A 02 22 0A 00 08 00 54 54 54 54 54 54 54 54 84 1C'],
	['LW_CFG_SET', 'FF FF FF FF EB 90 10 01 01 19 30 00 00 00 00 00 00 00 12 34 00 00 00 00 00 00 00 00 ' + '11 '.repeat(16) + '00 '.repeat(16) + 'B0 C3'],
	['LW_JOIN', 'FF FF FF FF EB 90 10 03 01 1A 00 00 6A 0D'],
	['LW_SEND', 'FF FF FF FF EB 90 10 05 01 1B 07 00 63 00 04 43 4F 45 58 46 E9'],
	['LW_TIME_REQ', 'FF FF FF FF EB 90 10 09 01 1C 00 00 64 F9'],
	['LW_TIME_GET', 'FF FF FF FF EB 90 10 0A 01 1D 00 00 86 20'],
	['LW_LINK_CHECK', 'FF FF FF FF EB 90 10 0C 01 1E 00 00 53 B4'],
	['LW_PERSIST', 'FF FF FF FF EB 90 10 0D 01 1F 00 00 32 29'],
	['REBOOT', 'FF FF FF FF EB 90 10 04 00 20 00 00 6E 1E'],
	['RTC_TIME_GET', 'FF FF FF FF EB 90 10 06 00 21 00 00 DD 6D'],
]
const OTHER_ROWS = [
	['ECHO RSP', 'FF FF FF FF EB 90 11 01 00 5A 05 00 00 50 49 4E 47 73 92'],
	['LW_JOIN RSP PENDING', 'FF FF FF FF EB 90 11 03 01 12 01 00 07 D8 C1'],
	['FACTORY_RESET RSP', 'FF FF FF FF EB 90 11 04 03 2E 01 00 00 26 5E'],
	['ROLE_SET RSP', 'FF FF FF FF EB 90 11 05 03 32 01 00 00 13 4F'],
	['AUTH RSP ERR_AUTH', 'FF FF FF FF EB 90 11 00 03 20 01 00 03 BE CA'],
	['KEY_SET RSP ERR_ROLE', 'FF FF FF FF EB 90 11 10 02 37 01 00 08 8A 81'],
	['KEY_SET RSP ERR_STATE', 'FF FF FF FF EB 90 11 10 02 38 01 00 06 AA B4'],
	['EVT LW_DOWNDATA', 'FF FF FF FF EB 90 12 83 01 00 07 00 02 9E FF 07 02 44 4C CD A1'],
]
for (const [name, h] of REQ_ROWS) {
	const golden = hex(h)
	const s = H.scan(golden, 0, true)
	assert.equal(s.status, 'frame', name)
	assert.equal(s.offset, 4, name)
	assert.equal(s.type, 0, name)
	const rebuilt = H.buildFrame({ type: 0, cmd: s.cmd, seq: s.seq, payload: s.payload })
	assert.deepEqual(bytes(rebuilt), bytes(golden), name)
	assert.deepEqual(bytes(H.buildDownFrame({ cmd: s.cmd, seq: s.seq, payload: s.payload })), bytes(golden), name + ' buildDownFrame')
	const p = H.parseFrame(golden)
	assert.equal(p.frames.length, 1, name)
	assert.equal(p.dir, 'down')
	assert.equal(H.byteMap(p).length, golden.length)
}
for (const [name, h] of OTHER_ROWS) {
	const golden = hex(h)
	const s = H.scan(golden, 0, true)
	assert.equal(s.status, 'frame', name)
	const rebuilt = H.buildFrame({ type: s.type, cmd: s.cmd, seq: s.seq, payload: s.payload })
	assert.deepEqual(bytes(rebuilt), bytes(golden), name)
}
// 用语义值独立构造（不经过帧内解码）
assert.deepEqual(bytes(H.buildFrame({ cmd: 0x0200, seq: 0x0e, payload: H.woInitPayload(1, 1) })), bytes(hex(REQ_ROWS.find(r => r[0] === 'WOR_INIT 表')[1])))
assert.deepEqual(bytes(H.buildFrame({ cmd: 0x0200, seq: 0x0f, payload: H.woInitPayload(1, 2) })), bytes(hex(REQ_ROWS.find(r => r[0] === 'WOR_INIT 发起')[1])))
assert.deepEqual(bytes(H.buildFrame({ cmd: 0x0207, seq: 0x11, payload: H.wakePayload(1, 1) })), bytes(hex(REQ_ROWS.find(r => r[0] === 'WOR_WAKE')[1])))
assert.deepEqual(bytes(H.buildFrame({ cmd: 0x0208, seq: 0x22, payload: H.wakePayload(1, 2) })), bytes(hex(REQ_ROWS.find(r => r[0] === 'WOR_WAKE_CIU')[1])))
assert.deepEqual(bytes(H.buildFrame({ cmd: 0x020c, seq: 0x12, payload: H.setUplinkPayload(Buffer.from('MTR-UP-0001')) })), bytes(hex(REQ_ROWS.find(r => r[0] === 'SET_UPLINK')[1])))
assert.deepEqual(bytes(H.buildFrame({ cmd: 0x020a, seq: 0x13, payload: H.sendPayload(Buffer.from('AAAA')) })), bytes(hex(REQ_ROWS.find(r => r[0] === 'WOR_SEND 数据包1')[1])))
assert.deepEqual(bytes(H.buildFrame({ cmd: 0x0302, seq: 0x09, payload: H.devIdSetPayload(1, 1) })), bytes(hex(REQ_ROWS.find(r => r[0] === 'DEV_ID_SET')[1])))
assert.deepEqual(bytes(H.buildFrame({ cmd: 0x0001, seq: 0x5a, payload: Buffer.from('PING'), preamble: false })), bytes(hex('EB 90 10 01 00 5A 04 00 50 49 4E 47 32 DF')))

// ---- 找帧 / 重同步 ----
{
	const good = H.buildFrame({ cmd: 0x0001, seq: 1, payload: Buffer.from('PING'), preamble: false })
	const cat = (...xs) => Uint8Array.from(xs.flatMap(x => Array.from(x)))
	// 前置噪声与 FF 前导
	let f = H.findFrame(cat([0x00, 0x13, 0xff, 0xff], good, [0xaa]))
	assert.equal(f.found, true)
	assert.equal(f.prefix, 4)
	assert.equal(f.suffix, 1)
	assert.deepEqual(bytes(f.frame), bytes(good))
	// 假 SOF: EB 90 后面 VER 不对
	f = H.findFrame(cat([0xeb, 0x90, 0x20, 0, 0, 0, 0, 0], good))
	assert.equal(f.found, true)
	assert.equal(f.offset, 8)
	// 假 SOF: LEN > 255
	f = H.findFrame(cat([0xeb, 0x90, 0x10, 0x01, 0x00, 0x01, 0x00, 0x01], good))
	assert.equal(f.found, true)
	assert.equal(f.offset, 8)
	// 帧内含 EB 90 的载荷不影响本帧
	const embedded = H.buildFrame({ cmd: 0x0001, seq: 2, payload: hex('EB 90 EB 90 FF FF'), preamble: false })
	f = H.findFrame(cat([0xff], embedded))
	assert.equal(f.found, true)
	assert.equal(f.length, embedded.length)
	// CRC 错: 跳 1 字节续扫，内嵌的好帧仍可解出
	const inner = H.buildFrame({ cmd: 0x0001, seq: 3, payload: Buffer.from('OK'), preamble: false })
	const outer = H.buildFrame({ cmd: 0x0001, seq: 4, payload: inner, preamble: false })
	const corrupted = outer.slice()
	corrupted[corrupted.length - 1] ^= 1
	f = H.findFrame(corrupted)
	assert.equal(f.found, true)
	assert.equal(f.offset, 8)
	assert.deepEqual(bytes(f.frame), bytes(inner))
	// 截断: 没有完整帧
	assert.equal(H.findFrame(good.subarray(0, good.length - 1)).found, false)
	assert.equal(H.findFrame(good.subarray(0, 5)).found, false)
	assert.equal(H.findFrame(hex('FF FF FF FF EB')).found, false)
	assert.equal(H.findFrame([]).found, false)
	// 截断的假候选后面跟着真帧: 一次性给全的数据里应能找到真帧
	f = H.findFrame(cat([0xeb, 0x90, 0x10, 0x01, 0x00, 0x01, 0xf0, 0x00], good))
	assert.equal(f.found, true)
	assert.equal(f.offset, 8)
	// 流式扫描: 未收全的候选返回 wait，保留到候选起点
	let s = H.scan(cat([0x01, 0x02], good.subarray(0, 6)), 0, false)
	assert.deepEqual(J(s), { status: 'wait', offset: 2 })
	s = H.scan(hex('01 02 EB'), 0, false)
	assert.deepEqual(J(s), { status: 'none', keep: 1 })
	s = H.scan(hex('01 02 03'), 0, false)
	assert.deepEqual(J(s), { status: 'none', keep: 0 })
	// 载荷超长的帧被拒绝组帧
	assert.throws(() => H.buildFrame({ cmd: 1, seq: 0, payload: new Uint8Array(256) }))
	assert.equal(H.buildFrame({ cmd: 1, seq: 0, payload: new Uint8Array(255), preamble: false }).length, 265)
}

// ---- 解析展示 ----
{
	// FW_INFO / DEV_ID_GET / WOR_GET_STATUS / LW_GET_STATUS 应答
	const rsp = (cmd, seq, payload) => H.buildFrame({ type: 1, cmd, seq, payload: Uint8Array.from(payload) })
	const board = Array.from(Buffer.from('TEST-BOARD      '))
	const fw = [0, 1, ...board, ...Buffer.from('abc1234 '), 0, ...Buffer.from('def5678 '), 1, ...Buffer.from('2026-09-01 10:00:00 ')]
	assert.equal(fw.length, 56)
	let p = H.parseFrame(rsp(0x0003, 1, fw))
	assert.equal(p.ok, true)
	assert.match(p.decoded, /board = "TEST-BOARD"/)
	assert.match(p.decoded, /sdkGit = def5678 \(dirty\)/)
	p = H.parseFrame(rsp(0x0301, 1, [0, 1, 0x39, 0x30, 0, 0, 0, 0, 0, 0]))
	assert.match(p.decoded, /DRN = 12345/)
	p = H.parseFrame(rsp(0x0201, 1, [0, 1, 1]))
	assert.match(p.decoded, /1 SENTRY/)
	assert.match(p.decoded, /状态 = 1 GRID/)
	p = H.parseFrame(rsp(0x0306, 1, [0, 2]))
	assert.match(p.decoded, /角色 = 2 CIU/)
	assert.equal(p.fields.状态.name.startsWith('OK'), true)
	p = H.parseFrame(rsp(0x0100, 1, [0, 1, 1, 0x33, 0xf0, 0xf1, 0xff, 0xff, 2, 0]))
	assert.match(p.decoded, /dutyMs = -3600/)
	assert.match(p.decoded, /lostCnt = 2/)
	p = H.parseFrame(rsp(0x020c, 1, [8]))
	assert.equal(p.fields.状态.value, '0x08')
	assert.match(p.fields.状态.name, /ERR_ROLE/)
	// 密钥类载荷脱敏: 展示文本与字节提示里都不出现密钥字节
	const keyReq = H.parseFrame(hex(REQ_ROWS.find(r => r[0] === 'SESSION_KEY_SET §8.7')[1]))
	assert.match(keyReq.decoded, /key = \*\*\*\*/)
	assert.doesNotMatch(keyReq.decoded + H.formatFrame(keyReq), /A0 A1|A0A1/i)
	assert.ok(H.byteMap(keyReq).every(c => !c || !/A0|AF/.test(c.tip.replace(/CRC|SEQ/g, ''))))
	const authReq = H.parseFrame(hex(REQ_ROWS.find(r => r[0] === 'PROV_AUTH 错 PAK §8.6')[1]))
	assert.match(authReq.decoded, /PAK = \*\*\*\*/)
	assert.doesNotMatch(authReq.decoded, /A5 A5/)
	const slot = H.parseFrame(hex(REQ_ROWS.find(r => r[0] === 'KEYS_SLOT bcast')[1]))
	assert.match(slot.decoded, /key = \*\*\*\*/)
	assert.doesNotMatch(slot.decoded, /30 31/)
	const cfg = H.parseFrame(hex(REQ_ROWS.find(r => r[0] === 'LW_CFG_SET')[1]))
	assert.match(cfg.decoded, /nwkKey = \*\*\*\*/)
	assert.doesNotMatch(cfg.decoded, /11 11/)
	// 多帧: RSP 与 EVT 拼在一起
	const two = Uint8Array.from([...hex(OTHER_ROWS[0][1]), ...hex(OTHER_ROWS[7][1])])
	p = H.parseFrame(two)
	assert.equal(p.frames.length, 2)
	assert.match(H.formatFrame(p), /帧 #2/)
	// 无帧
	p = H.parseFrame(hex('01 02 03'))
	assert.equal(p.ok, false)
	assert.match(H.formatFrame(p), /sk-parse-errors/)
	// EVT 0x0280 字段化 + 嵌套 STS-CIU 应用帧
	const app = S.buildFrame({ dir: 0, type: S.TYPE.STATUS, txn: 5, meter: '12345678', payload: [] })
	const evtPayload = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 3, 0x2a, 0x00, app.length, ...app, 0x9c, 0xff, 0x05])
	const evt = H.buildFrame({ type: 2, cmd: 0x0280, seq: 0, payload: evtPayload })
	p = H.parseFrame(evt)
	assert.equal(p.ok, true)
	assert.match(p.decoded, /来源地址 src = 1/)
	assert.match(p.decoded, /kind = 3 DATA/)
	assert.match(p.decoded, /rssi = -100 dBm  snr = 5 dB/)
	assert.match(p.decoded, /STS-CIU 应用帧/)
	assert.match(p.decoded, /STATUS 请求/)
	const d = H.decodeWorFrame(evtPayload)
	assert.equal(d.src, 1n)
	assert.equal(d.kind, 3)
	assert.equal(d.seq, 42)
	assert.equal(d.rssi, -100)
	assert.equal(d.snr, 5)
	assert.deepEqual(bytes(d.data), bytes(app))
	assert.ok(H.byteMap(p).some(c => c && /STS-CIU/.test(c.tip)))
	// data 不是合法应用帧就不嵌套
	const evt2 = H.buildFrame({ type: 2, cmd: 0x0280, seq: 0, payload: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 4, 1, 0, 3, 1, 2, 3, 0, 0, 0]) })
	assert.doesNotMatch(H.parseFrame(evt2).decoded, /STS-CIU/)
	// 串口数据里的 HTML 字符必须转义（ECHO 回显）
	const echo = H.parseFrame(H.buildFrame({ type: 1, cmd: 0x0001, seq: 9, payload: Buffer.from('\x00<img src=x onerror=alert(1)>') }))
	const html = H.formatFrame(echo)
	assert.doesNotMatch(html, /<img/)
	assert.match(html, /&lt;img/)
}

// ---- 事务层（假时钟）----
const flush = () => new Promise(resolve => setImmediate(resolve))
function makeClock() {
	let t = 1_700_000_000_000
	let id = 0
	const timers = new Map()
	return {
		now: () => t,
		setTimeout(fn, ms) { const h = ++id; timers.set(h, { at: t + ms, fn, h }); return h },
		clearTimeout(h) { timers.delete(h) },
		pending: () => timers.size,
		async advance(ms) {
			const end = t + ms
			for (;;) {
				await flush()
				let next = null
				for (const tm of timers.values()) if (tm.at <= end && (!next || tm.at < next.at || (tm.at === next.at && tm.h < next.h))) next = tm
				if (!next) break
				timers.delete(next.h)
				t = Math.max(t, next.at)
				next.fn()
			}
			t = end
			await flush()
		},
	}
}
function makeLink(opts) {
	const clock = makeClock()
	const writes = []
	let rxCb = null
	let unsubscribed = 0
	const link = window.createHostProtoLink(Object.assign({
		write: b => { writes.push(Uint8Array.from(b)) },
		onReceive: cb => { rxCb = cb; return () => { unsubscribed++; rxCb = null } },
		now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
	}, opts || {}))
	return { clock, writes, link, rx: b => rxCb && rxCb(Uint8Array.from(b)), unsubscribed: () => unsubscribed }
}
const rspOf = (cmd, seq, status, result) => H.buildFrame({ type: 1, cmd, seq, payload: [status, ...(result || [])] })
const evtOf = (cmd, payload) => H.buildFrame({ type: 2, cmd, seq: 0, payload })

async function transactionTests() {
	// 1. 组帧一次 write（前导+帧），SEQ 自增，RSP 去掉 STATUS
	{
		const t = makeLink()
		const p1 = t.link.request(0x0001, Buffer.from('PING'))
		await flush()
		assert.equal(t.writes.length, 1)
		assert.deepEqual(bytes(t.writes[0]), bytes(H.buildFrame({ cmd: 1, seq: 1, payload: Buffer.from('PING') })))
		assert.deepEqual(bytes(t.writes[0].subarray(0, 4)), [255, 255, 255, 255])
		t.rx(rspOf(0x0001, 1, 0, Buffer.from('PING')))
		const r = await p1
		assert.equal(r.status, 0)
		assert.equal(r.statusName, 'OK')
		assert.equal(Buffer.from(r.payload).toString(), 'PING')
		assert.equal(r.seq, 1)
		const p2 = t.link.request(0x0003, [])
		await flush()
		assert.equal(bytes(t.writes[1])[9], 2) // 4 前导 + EB 90 + VT + CMD(2) 之后是 SEQ
		t.rx(rspOf(0x0003, 2, 6))
		assert.equal((await p2).statusName, 'ERR_STATE') // 非 OK 状态也 resolve，由调用方判断
	}
	// 2. 不配对的 RSP 被忽略；半帧分片到达、前导/噪声、RSP+EVT 同包
	{
		const t = makeLink()
		const evts = []
		const off = t.link.onEvt(e => evts.push(e))
		const p = t.link.request(0x0002, [])
		await flush()
		t.rx(rspOf(0x0002, 9, 0)) // SEQ 不对
		t.rx(rspOf(0x0003, 1, 0)) // CMD 不对
		await flush()
		let settled = false
		p.then(() => { settled = true })
		await flush()
		assert.equal(settled, false)
		const good = rspOf(0x0002, 1, 0, new Uint8Array(44))
		t.rx([0x00, 0x11])
		t.rx(good.subarray(0, 7))
		t.rx(good.subarray(7, 20))
		t.rx(Uint8Array.from([...good.subarray(20), ...evtOf(0x0180, [0])]))
		assert.equal((await p).status, 0)
		assert.equal(evts.length, 1)
		assert.equal(evts[0].cmd, 0x0180)
		assert.equal(evts[0].name, 'LW_JOINED')
		assert.deepEqual(bytes(evts[0].payload), [0])
		off()
		t.rx(evtOf(0x0180, [0]))
		assert.equal(evts.length, 1) // 退订后不再收到
	}
	// 3. 超时后逐字节同帧重发；耗尽后带原因失败；重发间隔不低于 100ms
	{
		const t = makeLink()
		const p = t.link.request(0x0001, Buffer.from('X'), { timeoutMs: 20 })
		const failed = p.then(() => null, e => e)
		await flush()
		assert.equal(t.writes.length, 1)
		await t.clock.advance(99)
		assert.equal(t.writes.length, 1) // timeoutMs 被钳到 100ms
		await t.clock.advance(1)
		assert.equal(t.writes.length, 2)
		await t.clock.advance(100)
		assert.equal(t.writes.length, 3)
		assert.deepEqual(bytes(t.writes[1]), bytes(t.writes[0])) // 同 SEQ 同载荷
		assert.deepEqual(bytes(t.writes[2]), bytes(t.writes[0]))
		await t.clock.advance(100)
		const e = await failed
		assert.equal(typeof e.message, 'string')
		assert.equal(e.code, 'timeout')
		assert.match(e.message, /模组无应答/)
		assert.match(e.message, /ECHO/)
		assert.equal(t.writes.length, 3)
		assert.equal(t.link.stats.retries, 2)
		assert.equal(t.clock.pending(), 0)
	}
	// 4. 重发后才收到应答: 应答配对，随后迟到的重复应答被忽略，下一请求 SEQ 不受影响
	{
		const t = makeLink()
		const p = t.link.request(0x0003, [], { timeoutMs: 300 })
		await flush()
		await t.clock.advance(300)
		assert.equal(t.writes.length, 2)
		t.rx(rspOf(0x0003, 1, 0, [1]))
		assert.equal((await p).status, 0)
		t.rx(rspOf(0x0003, 1, 0, [1])) // 模组幂等缓存的第二份应答
		const p2 = t.link.request(0x0002, [])
		await flush()
		t.rx(rspOf(0x0002, 2, 0))
		assert.equal((await p2).seq, 2)
	}
	// 5. REBOOT / REBOOT_TO_BOOT / FACTORY_RESET / ROLE_SET 强制不重发；显式 noRetry / retries:0
	for (const cmd of [0x0004, 0x0005, 0x0304, 0x0305]) {
		const t = makeLink()
		const p = t.link.request(cmd, cmd === 0x0305 ? [1] : [], { timeoutMs: 200, retries: 5 }).then(() => null, e => e)
		await flush()
		await t.clock.advance(1000)
		assert.equal(t.writes.length, 1, 'cmd ' + cmd.toString(16))
		assert.equal((await p).code, 'timeout')
	}
	{
		const t = makeLink()
		const p = t.link.request(0x0001, [], { timeoutMs: 300, retries: 0 }).then(() => null, e => e)
		await flush()
		await t.clock.advance(400)
		assert.equal(t.writes.length, 1)
		assert.equal((await p).code, 'timeout')
	}
	// 6. 串行: 同一时刻只有一个在飞，其余排队
	{
		const t = makeLink()
		const a = t.link.request(0x0001, [1])
		const b = t.link.request(0x0001, [2])
		const c = t.link.request(0x0001, [3])
		await flush()
		assert.equal(t.writes.length, 1)
		t.rx(rspOf(0x0001, 1, 0, [1]))
		await a
		await flush()
		assert.equal(t.writes.length, 2)
		assert.equal(t.writes[1][9], 2)
		t.rx(rspOf(0x0001, 2, 0, [2]))
		await b
		await flush()
		assert.equal(t.writes.length, 3)
		t.rx(rspOf(0x0001, 3, 0, [3]))
		assert.deepEqual(bytes((await c).payload), [3])
	}
	// 7. SEQ 8 位回绕
	{
		const t = makeLink()
		for (let i = 0; i < 257; i++) {
			const p = t.link.request(0x0001, [])
			await flush()
			t.rx(rspOf(0x0001, t.writes[t.writes.length - 1][9], 0))
			await p
		}
		assert.equal(t.writes[254][9], 255)
		assert.equal(t.writes[255][9], 0)
		assert.equal(t.writes[256][9], 1)
	}
	// 8. 半帧 50ms 回收
	{
		const t = makeLink()
		const good = rspOf(0x0001, 1, 0, [1, 2, 3])
		t.rx(good.subarray(0, 9))
		assert.ok(t.link.rxBusy() > 0)
		await t.clock.advance(49)
		assert.ok(t.link.rxBusy() > 0)
		await t.clock.advance(1)
		assert.equal(t.link.rxBusy(), 0)
		assert.equal(t.link.stats.rxClear, 1)
		// 分片间隔 <50ms 不被回收，最终能解出
		const p = t.link.request(0x0001, [])
		await flush()
		t.rx(good.subarray(0, 9))
		await t.clock.advance(40)
		t.rx(good.subarray(9))
		assert.equal((await p).status, 0)
		assert.equal(t.link.rxBusy(), 0)
	}
	// 9. 缓冲防爆: 大段噪声后面的好帧仍能解出，缓冲不涨
	{
		const t = makeLink()
		const p = t.link.request(0x0001, [])
		await flush()
		const noise = new Uint8Array(100000)
		for (let i = 0; i < noise.length; i++) noise[i] = i % 7 === 0 ? 0xeb : (i * 31) & 0xff
		t.rx(noise)
		assert.ok(t.link.rxBusy() <= 265)
		t.rx(rspOf(0x0001, 1, 0, [7]))
		assert.deepEqual(bytes((await p).payload), [7])
		// 声称 LEN=255 但永远不来的假候选: 50ms 后回收
		t.rx(hex('EB 90 10 01 00 00 FF 00'))
		assert.ok(t.link.rxBusy() > 0)
		await t.clock.advance(60)
		assert.equal(t.link.rxBusy(), 0)
	}
	// 10. 写失败 / 关闭
	{
		const t = makeLink({ write: () => { throw new Error('串口未打开') } })
		const e = await t.link.request(0x0001, []).then(() => null, x => x)
		assert.equal(e.code, 'write')
		assert.match(e.message, /串口未打开/)
	}
	{
		const t = makeLink()
		const a = t.link.request(0x0001, []).then(() => null, e => e)
		const b = t.link.request(0x0001, []).then(() => null, e => e)
		await flush()
		t.link.close()
		assert.equal((await a).code, 'closed')
		assert.equal((await b).code, 'closed')
		assert.equal(t.unsubscribed(), 1)
		assert.equal(t.clock.pending(), 0)
		assert.equal((await t.link.request(0x0001, []).then(() => null, e => e)).code, 'closed')
	}
	// 12. 含密钥命令: 真实帧含密钥，日志副本按命令号脱敏且仍是合法帧
	{
		const secret = Uint8Array.from({ length: 16 }, (_, i) => 0x5a + (i & 1))
		const cases = [
			[0x0300, secret, 0], [0x0303, secret, 0],
			[0x0311, Uint8Array.from([0, 0, 3, ...secret]), 3],
			[0x0210, Uint8Array.from([1, ...secret]), 1],
			[0x0101, Uint8Array.from([...new Uint8Array(16), ...secret, ...secret]), 16],
		]
		for (const [cmd, payload, off] of cases) {
			const calls = []
			const t = makeLink({ write: (b, l) => { calls.push([Uint8Array.from(b), l ? Uint8Array.from(l) : null]) } })
			t.link.request(cmd, payload).catch(() => {})
			await flush()
			const [real, shown] = calls[0]
			assert.ok(Buffer.from(real).includes(Buffer.from(secret)), 'real ' + cmd)
			assert.ok(shown, 'log copy ' + cmd)
			assert.ok(!Buffer.from(shown).includes(Buffer.from(secret.subarray(0, 8))), 'redacted ' + cmd)
			assert.equal(shown.length, real.length)
			const sc = H.scan(shown, 0, true)
			assert.equal(sc.status, 'frame') // CRC 已重算，日志里仍是合法帧
			assert.equal(H.parseFrame(shown).ok, true)
			assert.match(H.parseFrame(shown).frames[0].lines.join('\n'), /已脱敏/)
			t.link.close()
		}
		const calls = []
		const t = makeLink({ write: (b, l) => { calls.push(l) } })
		t.link.request(0x0001, [1]).catch(() => {})
		await flush()
		assert.equal(calls[0], null) // 无密钥命令不带副本
		t.link.close()
	}
	// 11. 异步 write 拒绝
	{
		const t = makeLink({ write: () => Promise.reject(new Error('boom')) })
		const e = await t.link.request(0x0001, []).then(() => null, x => x)
		assert.equal(e.code, 'write')
	}
}

async function serialSessionTests() {
	const clock = makeClock()
	ctx.setTimeout = clock.setTimeout
	ctx.clearTimeout = clock.clearTimeout
	const sessions = { S: true, A: true, B: true }
	const subscriptions = []
	const writes = []
	let mode = 'dual'
	let active = 'A'
	let pinned = null
	let pins = 0
	let unpins = 0
	const api = {
		getMode: () => mode,
		isSessionOpen: sid => sessions[sid],
		getActiveSendSid: () => pinned || active,
		pinSession(sid) { pinned = sid; pins++ },
		unpinSession() { pinned = null; unpins++ },
		isOpen: () => sessions[pinned || active],
		writeRawTo(sid, data, opts) { writes.push({ sid, data, logData: opts.logData }) },
		writeRaw(data, opts) { this.writeRawTo(pinned || active, data, opts) },
		onReceiveFrom(sid, cb) {
			const sub = { sid, cb }
			subscriptions.push(sub)
			return () => subscriptions.splice(subscriptions.indexOf(sub), 1)
		},
		onReceive(cb) { return this.onReceiveFrom(null, cb) },
	}
	function receive(sid, data) {
		for (const sub of subscriptions.slice()) {
			if (mode === 'single' || sid === (sub.sid || pinned || active)) sub.cb(data)
		}
	}
	window.serialApi = api
	const linkA = window.hostProtoSerialLink({ sid: 'A' })
	const linkB = window.hostProtoSerialLink({ sid: 'B' })
	const linkS = window.hostProtoSerialLink({ sid: 'S' })
	assert.equal(pins, 0)
	const pendingA = linkA.request(1, [1])
	const pendingB = linkB.request(1, [2])
	await flush()
	assert.deepEqual(writes.map(call => call.sid), ['A', 'B'])
	receive('A', rspOf(1, 1, 0, [11]))
	assert.deepEqual(bytes((await pendingA).payload), [11])
	assert.equal(linkB.stats.rxRsp, 0)
	receive('B', rspOf(1, 1, 0, [22]))
	assert.deepEqual(bytes((await pendingB).payload), [22])
	const eventsA = []
	const eventsB = []
	const eventsS = []
	linkA.onEvt(evt => eventsA.push(evt))
	linkB.onEvt(evt => eventsB.push(evt))
	linkS.onEvt(evt => eventsS.push(evt))
	sessions.A = false
	receive('A', evtOf(1, [1]))
	receive('B', evtOf(1, [2]))
	assert.equal(eventsA.length, 0)
	assert.equal(eventsB.length, 1)
	const closedError = await linkA.request(1, []).catch(error => error)
	assert.equal(closedError.code, 'write')
	sessions.A = true
	mode = 'single'
	receive('S', evtOf(1, [3]))
	assert.equal(eventsA.length, 0)
	assert.equal(eventsB.length, 1)
	assert.equal(eventsS.length, 1)
	assert.equal((await linkB.request(1, []).catch(error => error)).code, 'write')
	const singleRequest = linkS.request(1, [])
	await flush()
	assert.equal(writes.at(-1).sid, 'S')
	receive('S', rspOf(1, 1, 0, [33]))
	assert.deepEqual(bytes((await singleRequest).payload), [33])
	mode = 'dual'
	receive('S', evtOf(1, [4]))
	assert.equal(eventsS.length, 1)
	assert.equal((await linkS.request(1, []).catch(error => error)).code, 'write')
	linkA.close()
	assert.equal(subscriptions.length, 2)
	assert.equal(unpins, 0)
	const sensitive = new Uint8Array(16).fill(0x5a)
	const sensitiveRequest = linkB.request(0x0300, sensitive)
	await flush()
	const sensitiveCall = writes.at(-1)
	assert.equal(sensitiveCall.sid, 'B')
	assert.ok(Buffer.from(sensitiveCall.data).includes(Buffer.from(sensitive)))
	assert.ok(!Buffer.from(sensitiveCall.logData).includes(Buffer.from(sensitive)))
	const sensitiveFrame = H.scan(sensitiveCall.data, 4, true)
	receive('B', rspOf(0x0300, sensitiveFrame.seq, 0, []))
	await sensitiveRequest
	linkB.close()
	linkS.close()
	assert.equal(subscriptions.length, 0)
	const legacy = window.hostProtoSerialLink()
	assert.equal(pins, 1)
	active = 'B'
	const legacyRequest = legacy.request(1, [])
	await flush()
	assert.equal(writes.at(-1).sid, 'A')
	receive('B', rspOf(1, 1, 0, [44]))
	assert.equal(legacy.stats.rxRsp, 0)
	receive('A', rspOf(1, 1, 0, [55]))
	assert.deepEqual(bytes((await legacyRequest).payload), [55])
	legacy.close()
	assert.equal(unpins, 1)
	assert.equal(clock.pending(), 0)
	assert.throws(() => window.hostProtoSerialLink({ sid: 'invalid' }), /无效的串口会话/)
	assert.equal(pins, 1)
	delete window.serialApi
}

async function serialApiTests() {
	const source = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
	const writeStart = source.indexOf('\tasync function writeData(data, sid, sendName, opts) {')
	const writeEnd = source.indexOf('\n\t// 终端键盘直写', writeStart)
	const apiStart = source.indexOf('\twindow.serialApi = {')
	const apiEnd = source.indexOf('\n\t\t//下行加密密钥', apiStart)
	assert.ok(writeStart >= 0 && writeEnd > writeStart && apiStart >= 0 && apiEnd > apiStart)
	let mode = 'dual'
	let failure = false
	let releases = 0
	const writes = []
	const logs = []
	const sessions = {}
	for (const sid of ['S', 'A', 'B']) {
		sessions[sid] = {
			open: true, txBytes: 0,
			port: { writable: { getWriter() {
				return {
					async write(data) {
						if (failure) throw new Error('synthetic sensitive error')
						writes.push({ sid, data: bytes(data) })
					},
					releaseLock() { releases++ },
				}
			} } },
		}
	}
	const sandbox = {
		window: {}, Uint8Array,
		SerialHub: {
			activeSendPhys: () => 'B',
			isVisible: sid => mode === 'single' ? sid === 'S' : sid === 'A' || sid === 'B',
			getPort: sid => sessions[sid].port,
			isOpen: sid => sessions[sid].open,
			_sess: sid => sessions[sid],
		},
		toolOptions: { addCRLF: true },
		addLog: (data, sent, time, sid) => logs.push({ sid, data: bytes(data) }),
		addParseLog: (data, sent, time, sid) => logs.push({ sid, data: bytes(data) }),
		addLogErr() { assert.fail('明确会话失败不应记录底层敏感错误') },
		showToast() { assert.fail('明确会话失败应抛出') },
	}
	vm.runInNewContext(source.slice(writeStart, writeEnd) + '\n' + source.slice(apiStart, apiEnd) + '\n\t}', sandbox)
	const api = sandbox.window.serialApi
	assert.equal(api.isSessionOpen('A'), true)
	assert.equal(api.isSessionOpen('B'), true)
	assert.equal(api.isSessionOpen('S'), false)
	assert.equal(api.isSessionOpen('invalid'), false)
	await assert.rejects(api.writeRawTo('invalid', new Uint8Array()), /无效的串口会话/)
	const raw = Uint8Array.from([0x5a, 0x5a])
	const shown = Uint8Array.from([0, 0])
	await api.writeRawTo('A', raw, { logData: shown })
	await api.writeRawTo('B', raw, { logData: shown })
	assert.deepEqual(writes, [{ sid: 'A', data: [0x5a, 0x5a] }, { sid: 'B', data: [0x5a, 0x5a] }])
	assert.deepEqual(logs.map(entry => entry.data), [[0, 0], [0, 0], [0, 0], [0, 0]])
	assert.equal(sandbox.toolOptions.addCRLF, true)
	sessions.A.open = false
	assert.equal(api.isSessionOpen('A'), false)
	assert.equal(api.isSessionOpen('B'), true)
	await assert.rejects(api.writeRawTo('A', raw), /未打开/)
	sessions.A.open = true
	failure = true
	await assert.rejects(api.writeRawTo('A', raw, { logData: shown }), error => error.message === '串口写入失败')
	assert.equal(releases, 3)
	assert.equal(logs.length, 4)
	failure = false
	mode = 'single'
	assert.equal(api.isSessionOpen('A'), false)
	assert.equal(api.isSessionOpen('B'), false)
	assert.equal(api.isSessionOpen('S'), true)
	await assert.rejects(api.writeRawTo('A', raw), /不可路由/)
	await assert.rejects(api.writeRawTo('B', raw), /不可路由/)
	await api.writeRawTo('S', raw, { logData: shown })
	assert.equal(writes.at(-1).sid, 'S')
	sessions.S.port.writable = null
	assert.equal(api.isSessionOpen('S'), false)
	await assert.rejects(api.writeRawTo('S', raw), /未打开/)
}

transactionTests().then(serialSessionTests).then(serialApiTests).then(() => console.log('hostProto protocol and transaction checks passed'), e => {
	console.error(e)
	process.exit(1)
})
