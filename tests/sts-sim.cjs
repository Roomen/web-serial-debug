// Run: node tests/sts-sim.cjs — synthetic data only.
// 双引擎端到端: 假模组对（按 hostProto 真帧收发）+ 可控假时钟，表端引擎与 CIU 引擎经完整两层协议对话
// 假模组模型: WAKE_CIU 受理后定锚点；锚点 +250ms 给 CIU 发 ACK(kind=2)；数据帧锚点 +1s 起每秒一帧以 kind=3 送到表端；
// 锚点 +6s 把表端信箱内容以 kind=4 送给 CIU，发出即清；锚点 +6.5s 会话结束
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const window = { registerProtocol() {} }
const ctx = { window, Uint8Array, BigInt, document: { getElementById() { return null } } }
vm.createContext(ctx)
for (const f of ['sts-ciu-protocol', 'hostproto-protocol', 'hostproto-transaction', 'sts-sim']) {
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8'), ctx)
}
const S = window.stsCiu
const H = window.hostProto
const SIM = window.stsSim
const hex = s => Uint8Array.from(s.split(/\s+/).filter(Boolean).map(x => parseInt(x, 16)))
const bytes = u8 => Array.from(u8)
const hs = u8 => S.hexSpaced(Uint8Array.from(u8))

// ---------- 假时钟 ----------
const flush = () => new Promise(resolve => setImmediate(resolve))
function makeClock() {
	let t = 1_760_000_000_000
	let id = 0
	const timers = new Map()
	return {
		now: () => t,
		setTimeout(fn, ms) { const h = ++id; timers.set(h, { at: t + Math.max(0, ms), fn, h }); return h },
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
async function drive(clock, p, maxMs = 900000, step = 100) {
	let done = false
	let failed = false
	let val
	let err
	p.then(v => { done = true; val = v }, e => { done = true; failed = true; err = e })
	for (let t = 0; !done && t < maxMs; t += step) await clock.advance(step)
	if (!done) throw new Error('假时间 ' + maxMs + 'ms 内未完成')
	if (failed) throw err
	return val
}

// ---------- 假模组 ----------
// 13 位 DRN = 厂商码 0101 + 表号 12345678 + Luhn 校验位 8（合成值）
const METER_DRN = 101123456788n
const CIU_ADDR = 2n
const PAK = '000102030405060708090a0b0c0d0e0f'
function makeWorld(clock, opts) {
	const o = Object.assign({ anchorDelayMs: 2000, meterRole: 1, ciuRole: 2, meterDrn: METER_DRN, meterInit: true }, opts || {})
	const faults = { dropAck: 0, dropUplink: 0, skipUplink: 0, dropSession: 0, delayKind3: 0, beforeKind3: null, wakeStatus: null }
	const log = { kind3: [], uplinks: [], wakes: 0, sends: 0, setUplinks: [], events: [] }
	function newModule(name, role, drn, autoInit) {
		return {
			name, role, drn, authed: false, worInit: !!autoInit && role === 1 && drn !== 0n, sentry: !!autoInit && role === 1 && drn !== 0n,
			mailbox: null, session: null, cache: null, silentUntil: 0, cb: null, roleSets: 0, echoes: 0, addr: 0n,
		}
	}
	const meter = newModule('meter', o.meterRole, o.meterDrn, o.meterInit)
	const ciu = newModule('ciu', o.ciuRole, 0n, false)
	ciu.addr = CIU_ADDR
	const meter2 = o.meter2Drn ? newModule('meter2', 1, o.meter2Drn, true) : null

	function emit(mod, frame) {
		clock.setTimeout(() => { if (mod.cb) mod.cb(frame) }, 1)
	}
	function evtFrame(src, kind, seq, data, rssi, snr) {
		const d = Uint8Array.from(data || [])
		const p = new Uint8Array(12 + d.length + 3)
		p.set(H.u64Bytes(src), 0)
		p[8] = kind
		p[9] = seq & 0xff; p[10] = seq >> 8
		p[11] = d.length
		p.set(d, 12)
		p[12 + d.length] = rssi & 0xff; p[13 + d.length] = (rssi >> 8) & 0xff
		p[14 + d.length] = snr & 0xff
		return H.buildFrame({ type: 2, cmd: 0x0280, seq: 0, payload: p })
	}
	const ROLE_OK = {
		1: c => c < 0x0100 || (c >= 0x0300) || (c >= 0x0200 && c <= 0x0201) || c === 0x020f || c === 0x0202 || c === 0x0203 || (c >= 0x0204 && c <= 0x0206) || c === 0x020c || (c >= 0x0100 && c < 0x0200),
		2: c => c < 0x0100 || c >= 0x0300 || c === 0x0200 || c === 0x0201 || c === 0x020f || c === 0x0208 || c === 0x020a || c === 0x020b,
	}
	function exec(mod, cmd, p) {
		if (ROLE_OK[mod.role] && !ROLE_OK[mod.role](cmd)) return { status: H.STATUS.ERR_ROLE }
		const OK = { status: 0 }
		switch (cmd) {
			case 0x0001: mod.echoes++; return { status: 0, data: p }
			case 0x0003: return { status: 0, data: [1, ...Buffer.from('SIM-BOARD       '), ...Buffer.from('a1b2c3d4'), 0, ...Buffer.from('e5f6a7b8'), 0, ...Buffer.from('2026-09-20 10:00:00 ')] }
			case 0x0306: return { status: 0, data: [mod.role] }
			case 0x0300: if (p.length !== 16) return { status: 1 }
				if (Buffer.from(p).toString('hex') !== PAK) return { status: 3 }
				mod.authed = true
				return OK
			case 0x0305: {
				if (p.length !== 1 || p[0] > 3) return { status: 1 }
				if (!mod.authed) return { status: 3 }
				mod.roleSets++
				if (p[0] === mod.role) return OK
				return { status: 0, after: () => {
					// 应答先于复位发出；复位期间模组静默，回来后按新角色自动行为
					mod.role = p[0]
					mod.silentUntil = clock.now() + 3000
					mod.worInit = mod.role === 1 && mod.drn !== 0n
					mod.sentry = mod.worInit
					mod.session = null; mod.mailbox = null; mod.cache = null; mod.authed = false
				} }
			}
			case 0x0301: return { status: 0, data: [mod.role === 2 ? 2 : 1, ...H.u64Bytes(mod.drn)] }
			case 0x0302:
				if (p.length !== 9) return { status: 1 }
				if (!mod.authed) return { status: 3 }
				mod.drn = H.u64(p, 1)
				mod.devIdSets = (mod.devIdSets || 0) + 1
				return OK
			case 0x0004: return { status: 0, after: () => {
				// 应答先于复位；METER 上电按 DRN 自动值守
				mod.silentUntil = clock.now() + 3000
				mod.worInit = mod.role === 1 && mod.drn !== 0n
				mod.sentry = mod.worInit
				mod.addr = mod.worInit ? mod.drn : 0n
				mod.reboots = (mod.reboots || 0) + 1
				mod.session = null; mod.mailbox = null; mod.cache = null; mod.authed = false
			} }
			case 0x0200:
				if (p.length !== 9) return { status: 1 }
				if (mod.worInit) return { status: 2 }
				mod.worInit = true
				mod.addr = H.u64(p, 1)
				return OK
			case 0x0201: return mod.worInit ? { status: 0, data: [mod.role === 1 ? 1 : 2, mod.sentry ? 1 : 0] } : { status: 6 }
			case 0x0202: if (!mod.worInit) return { status: 6 }
				mod.sentry = true
				return OK
			case 0x020c:
				if (p.length < 1 || p[0] > 64 || p.length !== 1 + p[0]) return { status: 1 }
				mod.mailbox = Uint8Array.from(p.subarray(1))
				log.setUplinks.push({ at: clock.now(), data: Uint8Array.from(mod.mailbox) })
				return OK
			case 0x0208: {
				if (!mod.worInit) return { status: 6 }
				if (p.length !== 9) return { status: 1 }
				if (faults.wakeStatus != null) return { status: faults.wakeStatus }
				if (mod.session) return { status: 2 }
				log.wakes++
				startSession(mod, H.u64(p, 0))
				return OK
			}
			case 0x020a: {
				if (!mod.session) return { status: 6 }
				if (mod.session.queue.length >= 4) return { status: 2 }
				const len = p[0] | (p[1] << 8)
				if (p.length !== 2 + len) return { status: 1 }
				mod.session.queue.push(Uint8Array.from(p.subarray(2)))
				log.sends++
				return OK
			}
			default: return { status: 4 }
		}
	}
	function startSession(mod, dst) {
		const s = { queue: [], dead: false, dropAck: false, dropUplink: false, skipUplink: false, late: false }
		const take = k => { if (faults[k] > 0) { faults[k]--; return true } return false }
		s.dead = take('dropSession'); s.dropAck = take('dropAck'); s.dropUplink = take('dropUplink'); s.skipUplink = take('skipUplink'); s.late = take('delayKind3')
		mod.session = s
		const anchor = o.anchorDelayMs
		const target = [meter, meter2].find(m => m && m.drn === dst) || null
		if (!s.dead && target) {
			clock.setTimeout(() => { if (!s.dropAck) emit(mod, evtFrame(dst, 2, 1, [], -80, 7)) }, anchor + 250)
			for (let k = 0; k < 5; k++) {
				clock.setTimeout(() => {
					if (!s.queue.length) return
					deliverKind3(target, mod, s.queue.shift(), s.late)
				}, anchor + 1000 + k * 1000)
			}
			clock.setTimeout(() => {
				if (s.skipUplink) return
				const data = target.mailbox
				target.mailbox = null // 发出即清
				if (!data) return
				log.uplinks.push({ at: clock.now(), data, dropped: s.dropUplink })
				if (!s.dropUplink) emit(mod, evtFrame(dst, 4, 2, data, -80, 7))
			}, anchor + 6000)
		}
		clock.setTimeout(() => { mod.session = null }, anchor + 6500)
	}
	function deliverKind3(target, from, data, late) {
		const go = () => {
			if (faults.beforeKind3) faults.beforeKind3(data)
			log.kind3.push({ at: clock.now(), data })
			emit(target, evtFrame(from.addr, 3, 1, data, -80, 7))
		}
		if (late) clock.setTimeout(go, 7000)
		else go()
	}
	function onWrite(mod, bytesIn) {
		if (clock.now() < mod.silentUntil) return
		const s = H.scan(Uint8Array.from(bytesIn), 0, true)
		if (s.status !== 'frame' || s.type !== 0) return
		const key = s.seq + ':' + s.cmd + ':' + Buffer.from(s.payload).toString('hex')
		if (mod.cache && mod.cache.key === key) { emit(mod, mod.cache.rsp); return } // 幂等缓存深度 1
		const r = exec(mod, s.cmd, s.payload)
		const rsp = H.buildFrame({ type: 1, cmd: s.cmd, seq: s.seq, payload: [r.status, ...(r.data || [])] })
		mod.cache = { key, rsp }
		emit(mod, rsp)
		if (r.after) clock.setTimeout(r.after, 1)
	}
	function port(mod) {
		return { write: b => { onWrite(mod, b) }, onReceive: cb => { mod.cb = cb; return () => { mod.cb = null } } }
	}
	return {
		meter, meter2, ciu, faults, log, port,
		injectKind3(data) { emit(meter, evtFrame(CIU_ADDR, 3, 1, data, -80, 7)) },
	}
}
function makeLink(clock, port) {
	return window.createHostProtoLink({ write: port.write, onReceive: port.onReceive, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
}

const METER_NO = '12345678'
const TOKEN_A = '40668221845890323665'
const TOKEN_B = '11112222333344445555'
function setup(o) {
	o = o || {}
	const clock = makeClock()
	const world = makeWorld(clock, o.world)
	const logs = { meter: [], ciu: [] }
	const meterLink = makeLink(clock, world.port(world.meter))
	const ciuLink = makeLink(clock, world.port(world.ciu))
	const meter = SIM.createMeterSim({
		link: meterLink, clock, onLog: e => logs.meter.push(e),
		config: Object.assign({ tokenDelayS: 6, creditAmount: 500 }, o.meter),
	})
	const ciu = SIM.createCiuSim({
		link: ciuLink, clock, onLog: e => logs.ciu.push(e),
		config: Object.assign({ targetDrn: METER_DRN.toString(), localAddr: '2' }, o.ciu),
	})
	return { clock, world, logs, meter, ciu, meterLink, ciuLink }
}
async function ready(t) {
	await drive(t.clock, t.meter.start())
	await drive(t.clock, t.ciu.start())
}
const logText = arr => arr.map(e => e.text).join('\n')
const J = x => JSON.parse(JSON.stringify(x))

// ============================================================================
async function tests() {
	// ---- 启动与核对 ----
	{
		const t = await setup()
		await drive(t.clock, t.meter.start())
		assert.deepEqual(bytes(t.world.meter.mailbox), [0]) // 占位信箱 1 字节，CIU 按长度门静默丢弃
		await drive(t.clock, t.ciu.start())
		const ms = t.meter.getState()
		assert.equal(ms.running, true)
		assert.equal(ms.drn, METER_DRN.toString()) // 以模组 DEV_ID_GET 回读值为准
		assert.match(logText(t.logs.meter), /WOR 稳态 \[1 SENTRY\]\[1 GRID\]/)
		const cs = t.ciu.getState()
		assert.equal(cs.running, true)
		assert.deepEqual(J(cs.tariff), { currency: false, dec: 1 }) // 连接后读 0x18
		assert.equal(cs.protoVersion, 2) // 与 0x27
		assert.equal(cs.pollAllowed, true)
		assert.equal(t.world.ciu.worInit, true)
		t.meter.stop()
		t.ciu.stop()
		// 停止后不再处理 EVT，也不给模组发任何命令
		const sent = t.world.log.setUplinks.length
		t.world.injectKind3(hex('38 12 34 56 78 03'))
		await t.clock.advance(1000)
		assert.equal(t.world.log.setUplinks.length, sent)
		t.meterLink.close()
		assert.equal(t.world.meter.cb, null) // 链路关闭后串口订阅也已退订
	}
	// 启动失败路径: 模组无应答 / 角色不符无 PAK / DRN 未置备 / 补 INIT
	for (const role of ['meter', 'ciu']) {
		const t = setup()
		t.world[role].silentUntil = Infinity
		const engine = t[role]
		const link = t[role + 'Link']
		const error = await drive(t.clock, engine.start().then(() => null, failure => failure))
		assert.equal(error.code, 'timeout', role + ' 启动 ECHO 超时保留错误码')
		assert.equal(error.message, '模组无应答：请检查串口、波特率 115200 8N1，以及是否被其他工具占用同一个串口')
		assert.equal(engine.getState().running, false)
		assert.equal(link.stats.txFrames, 3)
		assert.equal(link.stats.timeouts, 1)
		engine.stop()
		t.meterLink.close()
		t.ciuLink.close()
		assert.equal(t.clock.pending(), 0)
	}
	{
		const t = setup({ world: { meterRole: 2 } })
		const e = await drive(t.clock, t.meter.start().then(() => null, x => x))
		assert.match(e.message, /keytool/)
		assert.match(e.message, /CIU/)
		assert.equal(t.world.meter.roleSets, 0)
	}
	{
		const t = setup({ world: { meterDrn: 0n } })
		const e = await drive(t.clock, t.meter.start().then(() => null, x => x))
		assert.match(e.message, /DRN 未设置/)
	}
	{
		// 角色不对且填了 PAK: PROV_AUTH + ROLE_SET（只发一次），轮询 ECHO 等模组回来，再核对
		const t = setup({ world: { meterRole: 0 }, meter: { pak: PAK } })
		await drive(t.clock, t.meter.start())
		assert.equal(t.world.meter.roleSets, 1)
		assert.equal(t.world.meter.role, 1)
		assert.equal(t.meter.getState().role, 1)
		assert.match(logText(t.logs.meter), /模组已定形: 角色 METER/)
	}
	{
		const t = setup({ world: { meterRole: 0 }, meter: { pak: 'ff'.repeat(16) } })
		const e = await drive(t.clock, t.meter.start().then(() => null, x => x))
		assert.match(e.message, /PAK 校验失败/)
		assert.equal(t.world.meter.roleSets, 0)
	}
	{
		// 模组 METER 但 WOR 未初始化: 补 WOR_INIT + SENTRY_START
		const t = setup({ world: { meterInit: false } })
		await drive(t.clock, t.meter.start())
		assert.equal(t.world.meter.worInit, true)
		assert.equal(t.world.meter.sentry, true)
	}
	{
		// CIU: 角色 ERR_ROLE 的表现 / 未初始化时 WAKE 的原因
		const t = setup()
		await drive(t.clock, t.meter.start())
		await drive(t.clock, t.ciu.start())
		t.world.faults.wakeStatus = 3
		const r = await drive(t.clock, t.ciu.runSession(hex('38 12 34 56 78 03')))
		assert.equal(r.ok, false)
		assert.match(r.reason, /ERR_AUTH/)
		t.world.faults.wakeStatus = 8
		assert.match((await drive(t.clock, t.ciu.runSession(hex('38 12 34 56 78 03')))).reason, /ERR_ROLE/)
		t.world.faults.wakeStatus = null
	}

	// ---- 充值全流程: 受理 -> 轮询处理中 -> 完成，余额与充值记录更新 ----
	{
		const t = setup({ meter: { tokenDelayS: 20 } })
		await ready(t)
		const t0 = t.clock.now()
		const res = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(res.ok, true, res.message)
		assert.equal(res.outcome, 'done')
		assert.equal(res.token.executed, true)
		assert.equal(res.token.credited, 500)
		assert.equal(res.token.remaining, 5500)
		assert.equal(res.token.remainingText, '550.0 L') // 按 0x18 标度格式化
		assert.equal(res.token.stsBlockHex, '03 80 80 80 00') // STS 结果块原样透传
		const ms = t.meter.getState()
		assert.equal(ms.remaining, 5500)
		assert.equal(ms.totalPurchased, 20500)
		assert.equal(ms.recordCount, 1)
		assert.equal(ms.records[0].amount, 500)
		assert.equal(ms.records[0].empty, false)
		assert.equal(ms.pending, null)
		assert.equal(ms.archive.length, 1)
		// 至少三轮会话: 令牌受理、轮询处理中、轮询终局
		assert.ok(res.sessions.length >= 3, 'sessions ' + res.sessions.length)
		assert.ok(res.sessions.every(s => s.ok))
		assert.equal(res.sessions[0].label, 'TOKEN')
		assert.ok(res.sessions.slice(1).every(s => s.label === 'RESULT 轮询'))
		assert.ok(t.clock.now() - t0 < 60000)
		// 每轮会话的时间线: wake 受理 <= send <= ack <= 上行，上行在锚点 +6s 附近
		const tl = res.sessions[0].timeline
		assert.ok(tl.wakeMs != null && tl.sendMs >= tl.wakeMs && tl.ackMs >= tl.sendMs && tl.upMs > tl.ackMs)
		assert.ok(Math.abs((tl.upMs - tl.ackMs) - 5750) < 20) // 上行拍在锚点 +6s，ACK 在 +250ms
		// 表端 SET_UPLINK 在 kind=3 之后立即写入（远早于 +6s）
		assert.match(logText(t.logs.meter), /SET_UPLINK OK，耗时 \d+ms/)
		const lastSess = t.meter.getState().lastSession
		assert.ok(lastSess.sinceKind3Ms < 100)
		// 之后查询剩余量与充值记录
		const rec = await drive(t.clock, t.ciu.records())
		assert.equal(rec.ok, true, rec.message)
		assert.equal(rec.records.length, 1)
		assert.equal(rec.records[0].amount, 500)
		assert.match(rec.records[0].timeText, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
	}
	// 拒绝模式: 令牌未执行，STS 结果块原样返回，余额不动
	{
		const t = setup({ meter: { tokenMode: 'reject', stsBlockHex: '06 80 20 00 00' } })
		await ready(t)
		const res = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(res.ok, true)
		assert.equal(res.token.executed, false)
		assert.equal(res.token.stsBlockHex, '06 80 20 00 00')
		assert.equal(t.meter.getState().remaining, 5000)
		assert.equal(t.meter.getState().recordCount, 0)
	}
	// 20 位以外的令牌不上线
	{
		const t = setup()
		await ready(t)
		const before = t.world.log.wakes
		const res = await drive(t.clock, t.ciu.token('12345'))
		assert.equal(res.ok, false)
		assert.match(res.message, /20 位/)
		assert.equal(t.world.log.wakes, before)
	}

	// ---- STATUS / READ 块读 ----
	{
		const t = setup({ meter: { alarmCodes: '1405 0801', batteryCv: 328 } })
		await ready(t)
		const st = await drive(t.clock, t.ciu.status())
		assert.equal(st.ok, true, st.message)
		assert.equal(st.status.remaining, 5000)
		assert.equal(st.status.remainingText, '500.0 L')
		assert.equal(st.status.batteryCv, 328)
		assert.equal(st.status.valve, S.VALVE_POS_OPEN)
		assert.equal(st.status.alarmListNonEmpty, true) // bit6 -> 再读 0x17 取全集
		assert.deepEqual(J(st.status.alarms), ['1405', '0801'])
		assert.equal(st.sessions.length, 2)
		const rd = await drive(t.clock, t.ciu.read(0x01, 4))
		assert.equal(rd.ok, true)
		assert.deepEqual(J(rd.read.map(x => x.id)), [1, 2, 3, 4])
		assert.equal(rd.read[2].text, '500.0（原始 5000，d=1）')
		// 未定义寄存器: 块内标 0xFF，不使整个请求失败
		const inv = await drive(t.clock, t.ciu.read(0x09, 2))
		assert.equal(inv.ok, true)
		assert.deepEqual(J(inv.read.map(x => x.invalid)), [true, true])
		assert.equal(t.world.log.kind3.length > 0, true)
	}
	// 12 条记录装不下一帧: 只回前 k 个，CIU 按实收数量继续读（5 + 5 + 2）
	{
		const t = setup({ meter: { tokenDelayS: 0, creditAmount: 100 } })
		await ready(t)
		for (let i = 0; i < 13; i++) {
			const tok = String(1000 + i).padStart(20, '7')
			const r = await drive(t.clock, t.ciu.token(tok))
			assert.equal(r.ok, true, 'token ' + i + ' ' + r.message)
		}
		const ms = t.meter.getState()
		assert.equal(ms.recordCount, 12) // 满 12 条循环覆盖
		assert.equal(ms.remaining, 5000 + 1300)
		const rec = await drive(t.clock, t.ciu.records())
		assert.equal(rec.ok, true, rec.message)
		assert.equal(rec.records.length, 12)
		assert.ok(rec.records.every(r => !r.empty && r.amount === 100))
		const readSessions = rec.sessions.filter(s => /充值记录/.test(s.label))
		assert.equal(readSessions.length, 3)
		assert.match(logText(t.logs.ciu), /READ 只回了前 5\/12 个/)
	}

	// ---- 阀控测试 + 保持期内重复写不覆盖 ----
	{
		const t = setup({ meter: { valveDelayS: 3 } })
		await ready(t)
		const r1 = await drive(t.clock, t.ciu.valveTest(false)) // 原本开阀，关阀指令
		assert.equal(r1.ok, true, r1.message)
		let ms = t.meter.getState()
		assert.equal(ms.valve, S.VALVE_POS_CLOSED)
		assert.equal(ms.valveTestActive, true) // 关阀保持期内 bit2 保持
		const st = await drive(t.clock, t.ciu.status())
		assert.equal(st.status.valve, S.VALVE_POS_CLOSED | S.VALVE_TEST_ACTIVE)
		// 开阀指令: 到位后不设保持期，取消关阀保持期，之后保持开阀
		const r2 = await drive(t.clock, t.ciu.valveTest(true))
		assert.equal(r2.ok, true)
		assert.equal(r2.write.result, 0)
		ms = t.meter.getState()
		assert.equal(ms.valve, S.VALVE_POS_OPEN)
		assert.equal(ms.valveTestActive, false)
		assert.equal(ms.valveHold, null)
		await t.clock.advance(11 * 60 * 1000)
		assert.equal(t.meter.getState().valve, S.VALVE_POS_OPEN) // 到期不再恢复
		// 断开绑定: 直接终局 0x00，不进待办
		const u = await drive(t.clock, t.ciu.unbind())
		assert.equal(u.ok, true)
		assert.equal(u.sessions.length, 1)
		assert.equal(t.meter.getState().unbound, 1)
		// 写不存在 / 只读寄存器: NAK 0x03 / 0x04，不进待办
		const bad = await drive(t.clock, t.ciu.write(0x50, 1))
		assert.equal(bad.outcome, 'nak')
		assert.equal(bad.nak.reason, 3)
		const ro = await drive(t.clock, t.ciu.write(0x03, 1))
		assert.equal(ro.nak.reason, 4)
	}

	// ---- 只丢 ACK 事件、上行照常到达: 按 ACK 已到处理，首轮会话即成功，不白等 ACK 超时 ----
	{
		const t = setup()
		await ready(t)
		t.world.faults.dropAck = 1
		const res = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(res.ok, true, res.message)
		assert.equal(res.sessions[0].ok, true, '丢 ACK 事件但上行到达，首轮会话成功')
		assert.equal(t.meter.getState().remaining, 5500)
		t.meter.stop(); t.ciu.stop()
	}

	// ---- 会话丢弃注入: CIU 重发逐字节相同的帧，表端不重复执行 ----
	for (const [name, fault] of [['丢上行', 'dropUplink'], ['整会话丢弃', 'dropSession']]) {
		const t = setup()
		await ready(t)
		t.world.faults[fault] = 1
		const res = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(res.ok, true, name + ': ' + res.message)
		assert.equal(res.token.executed, true)
		const ms = t.meter.getState()
		assert.equal(ms.remaining, 5500, name + ' 余额只加一次')
		assert.equal(ms.recordCount, 1, name + ' 只有一条记录')
		assert.equal(res.sessions[0].ok, false, name + ' 首轮会话应失败')
		assert.ok(res.sessions[0].reason.length > 0)
		assert.equal(res.sessions[1].label, 'TOKEN')
		assert.equal(res.sessions[1].attempt, 2) // 同一请求的第 2 次会话，重发同一帧
		if (fault !== 'dropSession') {
			// 首轮的应用帧已到表端；重发的帧与之逐字节相同
			const sent = t.world.log.kind3.filter(k => k.data.length === 16)
			assert.ok(sent.length >= 1)
			assert.ok(sent.every(k => bytes(k.data).join() === bytes(sent[0].data).join()), name + ' 重发帧逐字节相同')
		}
		t.meter.stop(); t.ciu.stop()
	}
	// 表端信箱来不及刷新: 上行是旧内容，CIU 接收判定丢弃后重新唤醒，最终成功
	{
		const t = setup({ ciu: { sessionRetries: 3 } })
		await ready(t)
		// 先做一次 STATUS，但上行全部丢在半路（信箱里留着这次的应答，未被发出）
		t.world.faults.skipUplink = 4
		const a = await drive(t.clock, t.ciu.status())
		assert.equal(a.ok, false)
		assert.match(a.message, /会话多次失败/)
		assert.equal(t.world.meter.mailbox.length, 14) // 旧 STATUS 应答还躺在信箱里
		// 再发 READ，并让这次 kind=3 晚到（在 +6s 上行拍之后）: 上行拍发出的是旧 STATUS 应答
		t.world.faults.delayKind3 = 1
		const b = await drive(t.clock, t.ciu.read(0x03, 1))
		assert.equal(b.ok, true, b.message)
		assert.equal(b.sessions[0].ok, false)
		// 旧 STATUS 应答过不了本轮接收判定，会话层不让它占上行槽，本轮等不到自己的上行而超时
		assert.match(b.sessions[0].reason, /等上行超时/)
		assert.ok(t.logs.ciu.some(e => e.text.includes('未通过接收判定')))
		assert.equal(b.sessions[1].ok, true)
		assert.equal(b.read[0].text, '500.0（原始 5000，d=1）')
	}
	// 占位信箱(1 字节)被当作应答时按长度门静默丢弃
	{
		const t = setup()
		await drive(t.clock, t.meter.start())
		await drive(t.clock, t.ciu.start())
		t.world.meter.mailbox = Uint8Array.from([0]) // 信箱里还是启动时预置的占位
		t.world.faults.delayKind3 = 1 // kind=3 晚到，+6s 上行拍发的是占位信箱
		const res = await drive(t.clock, t.ciu.status())
		assert.equal(res.ok, true, res.message)
		assert.equal(res.sessions[0].ok, false)
		assert.match(res.sessions[0].reason, /等上行超时/)
		assert.ok(t.logs.ciu.some(e => e.text.includes('未通过接收判定')))
	}

	// ---- 表端重启（清空存档）: 轮询状态 0 -> 重发令牌 -> 表端令牌去重回放终局 ----
	{
		const t = setup()
		await ready(t)
		let rebooted = false
		t.world.faults.beforeKind3 = data => {
			// 第一次收到 RESULT 轮询请求前重启（此时令牌已在 6s 处理完并存档）
			const r = S.parseRaw(data)
			if (!rebooted && r.ok && r.type === S.TYPE.RESULT) { rebooted = true; t.meter.simulateReboot() }
		}
		const res = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(rebooted, true)
		assert.equal(res.ok, true, res.message)
		assert.equal(res.token.executed, true)
		assert.equal(res.token.credited, 500)
		assert.equal(t.meter.getState().remaining, 5500, '重发令牌不重复执行')
		assert.equal(t.meter.getState().recordCount, 1)
		assert.match(logText(t.logs.ciu), /轮询状态 0（句柄未知或已过期）/)
		assert.ok(res.sessions.some(s => /恢复/.test(s.label)))
	}
	// 恢复只一次 / 断开绑定不重发: 策略层直接验证
	{
		const P = SIM.createCiuPolicy(METER_NO)
		const f1 = P.sendWrite(S.REG.UNBIND, [])
		P.onFrame(S.buildFrame({ dir: 1, type: S.TYPE.WRITE, txn: S.parseRaw(f1).txn, meter: METER_NO, payload: S.writeRspEncode(0x81, 0xfe) }), 1000)
		P.onFrame(S.buildFrame({ dir: 1, type: S.TYPE.RESULT, txn: 1, meter: METER_NO, payload: [] }), 1000) // 长度门: 丢弃
		const poll = P.sendPoll()
		const ev = P.onFrame(S.buildFrame({ dir: 1, type: S.TYPE.RESULT, txn: S.parseRaw(poll).txn, meter: METER_NO, payload: S.resultRspEncode({ pollState: 0, tgt: S.tgtOf(S.TYPE.WRITE, S.parseRaw(f1).txn) }) }), 2000)
		assert.equal(ev.kind, 'handle-unknown')
		assert.equal(P.recover().ok, false) // 0x81 不重发
		const P2 = SIM.createCiuPolicy(METER_NO)
		const g1 = P2.sendToken(TOKEN_A)
		P2.onFrame(S.buildFrame({ dir: 1, type: S.TYPE.TOKEN, txn: S.parseRaw(g1).txn, meter: METER_NO, payload: [0] }), 1000)
		const unknownPoll = () => {
			const pf = P2.sendPoll()
			return P2.onFrame(S.buildFrame({ dir: 1, type: S.TYPE.RESULT, txn: S.parseRaw(pf).txn, meter: METER_NO, payload: S.resultRspEncode({ pollState: 0, tgt: P2.state.pending.tgt }) }), 3000)
		}
		assert.equal(unknownPoll().kind, 'handle-unknown')
		const rc1 = P2.recover()
		assert.equal(rc1.ok, true)
		assert.notDeepEqual(bytes(rc1.frame), bytes(g1)) // 新 TXN，句柄跟着走
		P2.onFrame(S.buildFrame({ dir: 1, type: S.TYPE.TOKEN, txn: S.parseRaw(rc1.frame).txn, meter: METER_NO, payload: [0] }), 4000)
		assert.equal(P2.state.pending.armedAt, 1000) // 预算不重新起算
		assert.equal(unknownPoll().kind, 'handle-unknown')
		assert.equal(P2.recover().ok, false) // 每笔待办至多恢复一次
	}

	// ---- 预算耗尽放弃 ----
	{
		const t = setup({ meter: { tokenDelayS: 600 } })
		await ready(t)
		const res = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(res.ok, false)
		assert.equal(res.outcome, 'timeout')
		assert.match(res.message, /表体并不因此停止执行/)
		assert.equal(t.ciu.getState().pending, false) // 待办槽已清
		assert.ok(res.durationMs < 60000 + 2 * 9000 + 30000)
		assert.ok(res.sessions.length >= 2)
		// 表体仍在执行；放弃后 CIU 可以立刻做别的事（在飞槽没有被卡死）
		assert.notEqual(t.meter.getState().pending, null)
		const st = await drive(t.clock, t.ciu.status())
		assert.equal(st.ok, true, st.message)
		// 表体做完之后，同一令牌再输: 命中表端去重，回放上次结果
		await t.clock.advance(700000)
		const again = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(again.ok, true, again.message)
		assert.equal(again.token.executed, true)
		assert.equal(t.meter.getState().remaining, 5500)
		assert.equal(again.sessions.length, 1) // 同步终局，不进待办
	}

	// ---- 协议版本 < 2: 禁止待办类操作，不轮询 ----
	{
		const t = setup({ meter: { protoVersion: 1 } })
		await ready(t)
		assert.equal(t.ciu.getState().pollAllowed, false)
		const res = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(res.outcome, 'unsupported')
		assert.equal(t.meter.getState().remaining, 5000)
	}

	// ---- 会话层: BUSY 重试 / 同一会话内多个 kind=3 ----
	{
		const t = setup()
		await ready(t)
		const f = hex('38 12 34 56 78 03')
		const s1 = t.ciu.runSession(f)
		const s2 = t.ciu.runSession(f) // 上一会话未收尾: WAKE_CIU 回 BUSY，2s 重试
		const [r1, r2] = await drive(t.clock, Promise.all([s1, s2]))
		assert.equal(r1.ok, true)
		assert.equal(r2.ok, true)
		assert.match(logText(t.logs.ciu), /回 BUSY/)
		assert.equal(r1.uplink.length, 14) // 表端对 TXN 未知的 STATUS 请求也按帧回 (TXN 为 8)
	}
	{
		const t = setup()
		await ready(t)
		t.world.injectKind3(hex('38 12 34 56 78 03'))
		await t.clock.advance(300)
		t.world.injectKind3(S.buildFrame({ dir: 0, type: S.TYPE.READ, txn: 3, meter: METER_NO, payload: S.readReqEncode(3, 1) }))
		await t.clock.advance(300)
		assert.match(logText(t.logs.meter), /连续收到多个 kind=3/)
		// 信箱以最后一个为准
		const last = t.world.log.setUplinks[t.world.log.setUplinks.length - 1].data
		assert.equal(S.parseRaw(last).type, S.TYPE.READ)
	}

	// ---- F01: 取决于当前余额的失败不回放，重新判定并更新该项；永久结果回放 ----
	{
		const t = setup({ meter: { drn: METER_DRN.toString(), tokenDelayS: 1, remaining: 2147483600, creditAmount: 500 } }) // 不启动直接喂帧: DRN 要配上
		const m = t.meter
		const mk = (txn, d) => S.buildFrame({ dir: 0, type: S.TYPE.TOKEN, txn, meter: METER_NO, payload: S.tokenReqEncode(d) })
		const final = async txn => {
			const a = m.handleApp(mk(txn, TOKEN_A))
			if (S.parseRaw(a).payload[0] !== 0) return S.parseRaw(a) // 同步终局（命中回放）
			await t.clock.advance(1500)
			return S.parseRaw(m.handleApp(S.buildFrame({ dir: 0, type: S.TYPE.RESULT, txn: txn + 1, meter: METER_NO, payload: S.resultReqEncode(S.tgtOf(0, txn)) })))
		}
		let r = await final(1)
		assert.equal(r.payload[0], 2) // RESULT 状态 2
		assert.equal(r.payload[2], S.TOKEN_DONE_NOEXEC) // 越界: 未执行
		assert.equal(r.payload[3], 0x05)
		// 余额降回可充值范围后再输同一令牌: 必须重新判定（进待办），不能回放旧失败
		m.app.state.remaining = 5000
		const again = S.parseRaw(m.handleApp(mk(5, TOKEN_A)))
		assert.deepEqual(bytes(again.payload), [0]) // 受理，不是同步回放
		await t.clock.advance(1500)
		assert.equal(m.getState().remaining, 5500)
		assert.equal(m.getState().dedupCount, 1) // 更新同一项，不重复占位
		// 现在是永久的已执行结果: 再输回放，余额不动
		const rep = S.parseRaw(m.handleApp(mk(6, TOKEN_A)))
		assert.equal(rep.payload[0], S.TOKEN_DONE_EXEC)
		assert.equal(m.getState().remaining, 5500)
	}
	// ---- F02: 预算约束在途会话，晚到终局不得报成功 ----
	{
		const t = setup({ meter: { tokenDelayS: 55 } })
		await ready(t)
		const res = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(res.ok, false)
		assert.equal(res.outcome, 'timeout')
		assert.match(res.message, /表体并不因此停止执行/)
		// 放弃发生在受理后 60s 附近，而不是等某轮会话自然结束（会话最长 ACK15s + 上行12s）
		const accepted = res.sessions[0].at
		const gaveUp = res.startedAt + res.durationMs
		assert.ok(gaveUp - accepted <= 60000 + 200, 'gave up at +' + (gaveUp - accepted))
		assert.equal(t.ciu.getState().pending, false)
		await t.clock.advance(120000)
		assert.equal(t.meter.getState().remaining, 5500) // 表体照常执行完
	}
	// ---- F03: 丢弃路径不改事务状态，截断 READ 后同 TXN 的完整应答仍被接纳 ----
	{
		const P = SIM.createCiuPolicy(METER_NO)
		const req = P.sendRead(3, 1)
		const txn = S.parseRaw(req).txn
		const full = hex('03 61 00 00 01 F4')
		const cut = S.buildFrame({ dir: 1, type: S.TYPE.READ, txn, meter: METER_NO, payload: hex('03 61 00 00') }) // CRC 对，TLV 值被截断
		const ev1 = P.onFrame(cut, 1000)
		assert.equal(ev1.kind, 'discard')
		assert.deepEqual(J(P.state.inflight), { type: S.TYPE.READ, txn })
		const ev2 = P.onFrame(S.buildFrame({ dir: 1, type: S.TYPE.READ, txn, meter: METER_NO, payload: full }), 2000)
		assert.equal(ev2.kind, 'final')
		assert.equal(ev2.read.length, 1)
		assert.equal(P.state.inflight, null)
	}
	// ---- F04: BUSY 等待期间到达的旧 kind=4 不占本轮接收槽 ----
	{
		const t = setup()
		await ready(t)
		const f1 = hex('38 12 34 56 78 03')
		const f2 = S.buildFrame({ dir: 0, type: S.TYPE.READ, txn: 3, meter: METER_NO, payload: S.readReqEncode(3, 1) })
		const s1 = t.ciu.runSession(f1)
		const s2 = t.ciu.runSession(f2) // 会话 1 未收尾: WAKE 回 BUSY，其间会话 1 的上行到达
		const [r1, r2] = await drive(t.clock, Promise.all([s1, s2]))
		assert.equal(r1.ok, true)
		assert.equal(r2.ok, true)
		assert.equal(S.parseRaw(r1.uplink).type, S.TYPE.STATUS)
		assert.equal(S.parseRaw(r2.uplink).type, S.TYPE.READ) // 用的是本轮自己的上行
		assert.equal(S.parseRaw(r2.uplink).txn, 3)
		assert.match(logText(t.logs.ciu), /不占本轮接收槽/)
	}
	// ---- F05: 启动中停止，之后不再发任何请求、不置 running ----
	for (const which of ['meter', 'ciu']) {
		const t = setup()
		const eng = t[which]
		const link = which === 'meter' ? t.meterLink : t.ciuLink
		const p = eng.start().then(() => 'started', e => e.code)
		await flush()
		const sent = link.stats.txFrames
		assert.equal(sent, 1) // 第一个 ECHO 已发出、还没返回
		eng.stop()
		assert.equal(await drive(t.clock, p), 'aborted')
		await t.clock.advance(60000)
		assert.equal(link.stats.txFrames, sent)
		assert.equal(eng.getState().running, false)
		assert.equal(t.world.log.setUplinks.length, 0)
	}
	// ---- 运行时参数: setLive / 阀门手动控制 / 默认值 ----
	{
		assert.equal(SIM.METER_DEFAULTS.valveDelayS, 30) // 阀门动作耗时默认 30s
		assert.equal(SIM.METER_DEFAULTS.batteryCv, 368)
		const t = setup()
		await ready(t)
		const m = t.meter
		const readStatus = async () => (await drive(t.clock, t.ciu.status())).status
		// 剩余量: STATUS 与 READ 0x03 读到新值
		m.setLive({ remaining: 7777 })
		assert.equal((await readStatus()).remaining, 7777)
		const rd = await drive(t.clock, t.ciu.read(0x03, 1))
		assert.equal(rd.read[0].text, '777.7（原始 7777，d=1）')
		// 电池降到 3.00V 以下: 表计状态 bit1 置位；调回后清除
		assert.equal((await readStatus()).meterStatus & S.MST_LOW_BATTERY, 0)
		m.setLive({ batteryCv: 250 })
		assert.equal((await readStatus()).meterStatus & S.MST_LOW_BATTERY, S.MST_LOW_BATTERY)
		m.setLive({ batteryCv: 368 })
		assert.equal((await readStatus()).meterStatus & S.MST_LOW_BATTERY, 0)
		// 低余量 bit0 随剩余量重算
		m.setLive({ remaining: 50 })
		assert.equal((await readStatus()).meterStatus & S.MST_LOW_CREDIT, S.MST_LOW_CREDIT)
		// 告警码: bit6 置位，READ 0x17 按预置优先级顺序返回（与勾选顺序无关），其他码追加在后
		m.setLive({ alarmCodes: SIM.composeAlarmCodes(['1405', '0801', '0703'], '4321') })
		const st = await drive(t.clock, t.ciu.status())
		assert.equal(st.status.meterStatus & S.MST_ALARM_LIST, S.MST_ALARM_LIST)
		assert.deepEqual(J(st.status.alarms), ['0801', '1405', '0703', '4321'])
		const al = await drive(t.clock, t.ciu.read(0x17, 1))
		assert.match(al.read[0].text, /^0801 1405 0703 4321/)
		m.setLive({ alarmCodes: '' })
		assert.equal((await readStatus()).meterStatus & S.MST_ALARM_LIST, 0)
		// 校验复用配置那一套: 非法值整体拒绝且不改运行值；计价模式运行中不可改
		assert.throws(() => m.setLive({ alarmCodes: '12' }), /4 位十进制/)
		assert.throws(() => m.setLive({ tariffCurrency: true }), /停止时/)
		assert.equal(m.getState().remaining, 50)
		assert.deepEqual(J(SIM.splitAlarmCodes('1405 4321 0801')), { checked: ['1405', '0801'], other: '4321' })
		// 阀门手动: 开 / 关 / 不明 + 故障位
		for (const [pos, bits] of [['closed', S.VALVE_POS_CLOSED], ['unknown', 0], ['open', S.VALVE_POS_OPEN]]) {
			m.setValve(pos)
			assert.equal((await readStatus()).valve, bits, pos)
		}
		m.setValveFault(true)
		assert.equal((await readStatus()).valve, S.VALVE_POS_OPEN | S.VALVE_FAULT)
		m.setValveFault(false)
		assert.equal((await readStatus()).valve, S.VALVE_POS_OPEN)
		assert.throws(() => m.setValve('half'))
	}
	// ---- 阀控测试规则（需求方确认: 每条指令都真实动作）: 直接喂帧、假时钟推进，确定性 ----
	{
		const mkv = () => setup({ meter: { drn: METER_DRN.toString(), valveDelayS: 10 } })
		const wr = (txn, open) => S.buildFrame({ dir: 0, type: S.TYPE.WRITE, txn, meter: METER_NO, payload: S.writeReqEncode(0x80, [open ? 1 : 0]) })
		const poll = (m, txn, tgtTxn) => S.parseRaw(m.handleApp(S.buildFrame({ dir: 0, type: S.TYPE.RESULT, txn, meter: METER_NO, payload: S.resultReqEncode(S.tgtOf(S.TYPE.WRITE, tgtTxn)) })))
		const stat = m => S.statusRspDecode(S.parseRaw(m.handleApp(S.buildFrame({ dir: 0, type: S.TYPE.STATUS, txn: 9, meter: METER_NO, payload: [] }))).payload)
		const BIT2 = S.VALVE_TEST_ACTIVE
		const sec = ms => ms * 1000
		// A1: 受理 0xFE -> 动作中（位置报不明 + bit2）-> 到位 -> 终局 0x00
		{
			const t = mkv(); const m = t.meter
			const acc = S.parseRaw(m.handleApp(wr(1, false)))
			assert.deepEqual(bytes(acc.payload), [0x80, 0xfe])
			assert.equal(stat(m).valve, BIT2) // 位置 00 不明 + bit2
			assert.equal(m.getState().valveMoving.kind, 'cmd')
			await t.clock.advance(sec(9))
			assert.equal(poll(m, 2, 1).payload[0], 1) // 处理中
			assert.equal(stat(m).valve, BIT2)
			await t.clock.advance(sec(1))
			assert.equal(stat(m).valve, S.VALVE_POS_CLOSED | BIT2) // 关阀到位，保持期内 bit2 保持
			const done = poll(m, 3, 1)
			assert.equal(done.payload[0], 2)
			assert.deepEqual(bytes(done.payload.subarray(2)), [0x80, 0x00])
			// 动作到位后再收到指令就重新动作（开阀）
			m.handleApp(wr(4, true))
			assert.equal(stat(m).valve, BIT2)
			await t.clock.advance(sec(10))
			// A3(开阀): 不设保持期，并取消关阀保持期，之后保持开阀
			assert.equal(stat(m).valve, S.VALVE_POS_OPEN)
			assert.equal(m.getState().valveHold, null)
			await t.clock.advance(sec(700))
			assert.equal(stat(m).valve, S.VALVE_POS_OPEN)
			assert.doesNotMatch(logText(t.logs.meter), /保持期到，开始恢复/)
		}
		// A2: 关阀保持 10 分钟，到期恢复成指令前状态，恢复本身也走动作过程
		{
			const t = mkv(); const m = t.meter
			m.handleApp(wr(1, false))
			await t.clock.advance(sec(10))
			const hold = m.getState().valveHold
			assert.ok(hold && Math.abs(hold.remainMs - 600000) < 50)
			await t.clock.advance(sec(599))
			assert.equal(stat(m).valve, S.VALVE_POS_CLOSED | BIT2)
			await t.clock.advance(sec(1))
			assert.equal(stat(m).valve, BIT2) // 恢复中: 位置不明 + bit2
			assert.equal(m.getState().valveMoving.kind, 'restore')
			await t.clock.advance(sec(10))
			assert.equal(stat(m).valve, S.VALVE_POS_OPEN) // 恢复完成，bit2 清
			assert.match(logText(t.logs.meter), /恢复动作完成/)
		}
		// A4: 保持期内的同方向关阀（CIU 重发）: 照样动作，指令前状态与恢复截止时刻都不重设
		{
			const t = mkv(); const m = t.meter
			m.handleApp(wr(1, false))
			await t.clock.advance(sec(10))
			const restoreAt = m.getState().valveRestoreAt
			await t.clock.advance(sec(120))
			m.handleApp(wr(2, false))
			assert.equal(stat(m).valve, BIT2) // 照样动作
			await t.clock.advance(sec(10))
			assert.equal(m.getState().valveRestoreAt, restoreAt)
			assert.match(logText(t.logs.meter), /保持期内（剩余 \d+ 分钟）收到同方向关阀：照样动作/)
			await t.clock.advance(restoreAt - t.clock.now() + sec(10))
			assert.equal(stat(m).valve, S.VALVE_POS_OPEN) // 恢复成最初的指令前状态，不是被重发覆盖成「关」
		}
		// A5: 判定在收到指令时锁定——保持期余时(4s) < 动作耗时(10s)，动作完成时保持期已过期，
		// 按新的关阀指令处理: 重新记录指令前状态（仍是最初的开）并开始新的 10 分钟
		{
			const t = mkv(); const m = t.meter
			m.handleApp(wr(1, false))
			await t.clock.advance(sec(10))
			const restoreAt = m.getState().valveRestoreAt
			await t.clock.advance(restoreAt - t.clock.now() - sec(4))
			m.handleApp(wr(2, false)) // 收到时还在保持期内
			await t.clock.advance(sec(4))
			assert.equal(m.getState().valveMoving.kind, 'cmd') // 保持期到点时这条指令仍在动作，恢复被推迟
			await t.clock.advance(sec(6))
			const ms = m.getState()
			assert.equal(ms.valveMoving, null)
			assert.equal(ms.valve, S.VALVE_POS_CLOSED)
			assert.equal(ms.valveTestActive, true)
			assert.ok(ms.valveRestoreAt > restoreAt)
			assert.ok(Math.abs(ms.valveHold.remainMs - 600000) < 50) // 新的 10 分钟
			assert.match(logText(t.logs.meter), /按新的关阀指令处理/)
			assert.equal(poll(m, 3, 2).payload[0], 2)
			await t.clock.advance(sec(610))
			assert.equal(stat(m).valve, S.VALVE_POS_OPEN) // 指令前状态仍是最初的开
		}
		// A6: 动作中手动改位置: 待办给终局 0x00，到点不再覆盖手动值，日志写明
		{
			const t = mkv(); const m = t.meter
			m.handleApp(wr(1, false))
			await t.clock.advance(sec(3))
			m.setValve('open')
			assert.equal(m.getState().pending, null) // 没有留下永不结束的待办
			const done = poll(m, 2, 1)
			assert.equal(done.payload[0], 2)
			assert.deepEqual(bytes(done.payload.subarray(2)), [0x80, 0x00])
			await t.clock.advance(sec(30))
			assert.equal(stat(m).valve, S.VALVE_POS_OPEN) // 完成回调没有把手动值改回关
			assert.match(logText(t.logs.meter), /手动改阀门，阀控动作\/测试已取消/)
			// 保持期内手动改: 取消保持期，到期不再恢复；只改故障位不取消
			m.handleApp(wr(3, false))
			await t.clock.advance(sec(10))
			m.setValveFault(true)
			assert.equal(m.getState().valveTestActive, true)
			m.setValve('unknown')
			assert.equal(m.getState().valveTestActive, false)
			assert.equal(m.getState().valveRestoreAt, 0)
			assert.equal(stat(m).valve, S.VALVE_FAULT)
			await t.clock.advance(sec(700))
			assert.equal(m.getState().valve, 0)
			assert.doesNotMatch(logText(t.logs.meter), /保持期到，开始恢复/)
		}
		// 表体重启: 立即回到指令前状态，清掉动作与保持期
		{
			const t = mkv(); const m = t.meter
			m.handleApp(wr(1, false))
			await t.clock.advance(sec(10))
			m.simulateReboot()
			assert.equal(stat(m).valve, S.VALVE_POS_OPEN)
			await t.clock.advance(sec(700))
			assert.equal(stat(m).valve, S.VALVE_POS_OPEN)
		}
		// 表体重启发生在「保持期已在重发动作期间到期、动作尚未到位」时: 应恢复的值只存在延期记录里，仍要回到最初的开
		{
			const t = mkv(); const m = t.meter
			m.handleApp(wr(1, false))
			await t.clock.advance(sec(10))
			await t.clock.advance(m.getState().valveRestoreAt - t.clock.now() - sec(4))
			m.handleApp(wr(2, false))
			await t.clock.advance(sec(5)) // 保持期已过期，重发的关阀还剩 5s
			assert.equal(m.getState().valveHold, null)
			assert.equal(m.getState().valveMoving.kind, 'cmd')
			m.simulateReboot()
			assert.equal(stat(m).valve, S.VALVE_POS_OPEN)
			await t.clock.advance(sec(700))
			assert.equal(stat(m).valve, S.VALVE_POS_OPEN)
		}
		// 开阀一受理就取消关阀保持期，不等到位
		{
			const t = mkv(); const m = t.meter
			m.handleApp(wr(1, false))
			await t.clock.advance(sec(10))
			assert.ok(m.getState().valveHold)
			m.handleApp(wr(2, true))
			assert.equal(m.getState().valveHold, null)
			await t.clock.advance(sec(10))
			assert.equal(stat(m).valve, S.VALVE_POS_OPEN)
		}
	}
	// ---- CIU 运行中切换目标表 ----
	{
		const DRN2 = 101876543214n // 表号 87654321
		const t = setup({ world: { meter2Drn: DRN2 } })
		const link2 = makeLink(t.clock, t.world.port(t.world.meter2))
		const meter2 = SIM.createMeterSim({ link: link2, clock: t.clock, onLog() {}, config: { remaining: 4242 } })
		await drive(t.clock, t.meter.start())
		await drive(t.clock, meter2.start())
		await drive(t.clock, t.ciu.start())
		assert.equal((await drive(t.clock, t.ciu.status())).status.remaining, 5000)
		// 有操作在进行时拒绝
		const busyOp = t.ciu.status()
		await flush()
		const e = await t.ciu.setTarget(DRN2.toString()).then(() => null, x => x)
		assert.match(e.message, /当前操作结束后再切换/)
		await drive(t.clock, busyOp)
		// 空闲时生效: 新表号进帧，STATUS 读到第二只表的值，基本信息重读
		const sessBefore = t.ciu.getState().sessionCount
		await drive(t.clock, t.ciu.setTarget(DRN2.toString()))
		assert.ok(t.ciu.getState().sessionCount > sessBefore) // 0x18 / 0x27 对新表重读
		assert.match(logText(t.logs.ciu), /目标表切换为 DRN 101876543214（表号 87654321）/)
		const r2 = await drive(t.clock, t.ciu.status())
		assert.equal(r2.ok, true, r2.message)
		assert.equal(r2.status.remaining, 4242)
		const sent = t.world.log.kind3.filter(k => S.hexSpaced(k.data.subarray(1, 5)) === '87 65 43 21')
		assert.ok(sent.length >= 1)
		// 非法 DRN 拒绝
		assert.ok(await t.ciu.setTarget('123456789').then(() => null, x => x))
	}
	// ---- B4: 告警码合并去重，已知预置码不管写在哪都按预置顺序排前面 ----
	assert.equal(SIM.composeAlarmCodes(['1405'], '4321 0801 1301 4321'), '0801 1301 1405 4321')
	assert.equal(SIM.composeAlarmCodes([], '9999 0801'), '0801 9999')
	// ---- B5: 应用对象的 setLive 自带校验，没有无校验写入口 ----
	{
		const t = setup()
		assert.throws(() => t.meter.app.setLive({ alarmCodes: '12' }), /4 位十进制/)
		assert.throws(() => t.meter.app.setLive({ tariffDec: 3 }), /停止时/)
		t.meter.app.setLive({ batteryCv: 400 })
		assert.equal(t.meter.getState().batteryCv, 400)
		assert.equal(t.meter.getState().remaining, 5000) // 只改给出的字段，其余保持
	}
	// ---- B1/B2/B3: CIU 切目标表——基础信息失败、切换中停止、会话进行中被拒 ----
	{
		const DRN2 = 101876543214n
		const mk = async () => {
			const t = setup({ world: { meter2Drn: DRN2 } })
			const link2 = makeLink(t.clock, t.world.port(t.world.meter2))
			t.meter2 = SIM.createMeterSim({ link: link2, clock: t.clock, onLog() {}, config: { remaining: 4242 } })
			await drive(t.clock, t.meter.start()); await drive(t.clock, t.meter2.start()); await drive(t.clock, t.ciu.start())
			return t
		}
		// B1: 基础信息读取失败——保留新目标、basicsOk=false；待办类操作先自动重读，仍失败则拒绝且不上线
		{
			const t = await mk()
			t.world.faults.dropSession = 1000
			const r = await drive(t.clock, t.ciu.setTarget(DRN2.toString()))
			assert.equal(r.basicsOk, false)
			assert.equal(t.ciu.getState().tariff, null)
			assert.equal(t.ciu.getState().protoVersion, null)
			assert.match(logText(t.logs.ciu), /目标表已切换，但基础信息读取失败/)
			const before = t.world.log.kind3.length
			const refused = await drive(t.clock, t.ciu.token(TOKEN_A))
			assert.equal(refused.ok, false)
			assert.match(refused.message, /无法确认表体支持 RESULT 轮询/)
			assert.equal(t.world.log.kind3.filter(k => k.data.length === 16).length, 0) // 令牌没有上线
			t.world.faults.dropSession = 0
			await t.clock.advance(20000)
			const ok = await drive(t.clock, t.ciu.token(TOKEN_A)) // 现在自动重读成功后继续
			assert.equal(ok.ok, true, ok.message)
			assert.equal(t.ciu.getState().protoVersion, 2)
			assert.equal(t.meter2.getState().remaining, 4742)
		}
		// B2: 切换过程中停止——setTarget 以 aborted 拒绝，不当作已切换
		{
			const t = await mk()
			const p = t.ciu.setTarget(DRN2.toString()).then(() => 'switched', e => e.code)
			await flush()
			t.ciu.stop()
			assert.equal(await drive(t.clock, p), 'aborted')
		}
		// B3: 有会话在进行时 setTarget 被拒，且进行中的会话仍用开始时的目标
		{
			const t = await mk()
			const sess = t.ciu.runSession(hex('38 12 34 56 78 03'))
			await flush()
			const e = await t.ciu.setTarget(DRN2.toString()).then(() => null, x => x)
			assert.equal(e.code, 'busy')
			await drive(t.clock, sess)
		}
	}
	// ---- 表体协议策略: 待办槽 / 存档 FIFO / TGT 冲突 / 接收判定 ----
	{
		const t = setup({ meter: { drn: METER_DRN.toString(), tokenDelayS: 5 } }) // 不启动直接喂帧: DRN 要配上
		const m = t.meter
		const mk = (type, txn, payload) => S.buildFrame({ dir: 0, type, txn, meter: METER_NO, payload })
		const rsp = f => S.parseRaw(f)
		const tok = d => S.tokenReqEncode(d)
		// 受理令牌 A（TXN 1）
		const a1 = mk(S.TYPE.TOKEN, 1, tok('00000000000000000001'))
		let r = rsp(m.handleApp(a1))
		assert.equal(r.type, S.TYPE.TOKEN)
		assert.deepEqual(bytes(r.payload), [0])
		// 逐字节相同: 再回受理，不新建待办
		r = rsp(m.handleApp(a1))
		assert.deepEqual(bytes(r.payload), [0])
		assert.equal(m.policy.state.pending.tgt, S.tgtOf(0, 1))
		// 不同: NAK 0x06，无副作用
		r = rsp(m.handleApp(mk(S.TYPE.TOKEN, 2, tok('00000000000000000002'))))
		assert.equal(r.type, S.TYPE.NAK)
		assert.deepEqual(bytes(r.payload), [6, 0])
		r = rsp(m.handleApp(mk(S.TYPE.WRITE, 3, S.writeReqEncode(0x80, [1]))))
		assert.deepEqual(bytes(r.payload), [6, 0x80])
		assert.equal(m.getState().pending.tgt, S.tgtOf(0, 1))
		// 处理中: RESULT 状态 1 带 eta；其它 TGT 状态 0
		r = rsp(m.handleApp(mk(S.TYPE.RESULT, 4, S.resultReqEncode(S.tgtOf(0, 1)))))
		assert.equal(r.payload[0], 1)
		assert.ok(r.payload[2] >= 1 && r.payload[2] <= 5)
		r = rsp(m.handleApp(mk(S.TYPE.RESULT, 5, S.resultReqEncode(S.tgtOf(0, 7)))))
		assert.equal(r.payload[0], 0)
		await t.clock.advance(5000)
		// 完成: 状态 2，尾部 = 完整终局载荷；取走不删，逐次逐字节相同
		const p1 = m.handleApp(mk(S.TYPE.RESULT, 6, S.resultReqEncode(S.tgtOf(0, 1))))
		const p2 = m.handleApp(mk(S.TYPE.RESULT, 6, S.resultReqEncode(S.tgtOf(0, 1))))
		assert.deepEqual(bytes(p1), bytes(p2))
		assert.equal(rsp(p1).payload[0], 2)
		assert.equal(rsp(p1).payload[2], 2) // TOKEN 处理状态 2
		// 令牌 A 重复输入: 同步终局，回放上次结果，不进待办
		r = rsp(m.handleApp(mk(S.TYPE.TOKEN, 9, tok('00000000000000000001'))))
		assert.equal(r.payload[0], 2)
		assert.equal(m.getState().pending, null)
		assert.equal(m.getState().remaining, 5500)
		// 存档 4 条 FIFO: 依次再完成 4 笔（TXN 10..13 -> TGT 0x0A..0x0D），最早的 TGT 0x01 被淘汰
		for (let i = 0; i < 4; i++) {
			m.handleApp(mk(S.TYPE.TOKEN, 10 + i, tok('0000000000000000010' + i)))
			await t.clock.advance(5000)
		}
		assert.equal(m.getState().archive.length, 4)
		r = rsp(m.handleApp(mk(S.TYPE.RESULT, 6, S.resultReqEncode(S.tgtOf(0, 1)))))
		assert.equal(r.payload[0], 0)
		r = rsp(m.handleApp(mk(S.TYPE.RESULT, 6, S.resultReqEncode(S.tgtOf(0, 13)))))
		assert.equal(r.payload[0], 2)
		// TGT 冲突（3.7）: TXN 回绕到 13，新令牌处理中时轮询必须得到「处理中」，不能拿到旧存档的成功
		m.handleApp(mk(S.TYPE.TOKEN, 13, tok('99999999999999999999')))
		r = rsp(m.handleApp(mk(S.TYPE.RESULT, 6, S.resultReqEncode(S.tgtOf(0, 13)))))
		assert.equal(r.payload[0], 1)
		await t.clock.advance(5000)
		r = rsp(m.handleApp(mk(S.TYPE.RESULT, 6, S.resultReqEncode(S.tgtOf(0, 13)))))
		assert.equal(r.payload[0], 2)
		// 接收判定: 非本机表号 / CRC / 方向 / 长度全部静默丢弃；未知 TYPE 才回 NAK 0x01
		assert.equal(m.handleApp(S.buildFrame({ dir: 0, type: S.TYPE.STATUS, txn: 1, meter: '87654321', payload: [] })), null)
		const bad = mk(S.TYPE.STATUS, 1, []); bad[5] ^= 1
		assert.equal(m.handleApp(bad), null)
		assert.equal(m.handleApp(S.buildFrame({ dir: 1, type: S.TYPE.STATUS, txn: 1, meter: METER_NO, payload: new Uint8Array(8) })), null)
		assert.equal(m.handleApp(mk(S.TYPE.RESULT, 1, [])), null) // 第 7 项: 6 字节空 RESULT
		r = rsp(m.handleApp(mk(6, 5, [1, 2])))
		assert.equal(r.type, S.TYPE.NAK)
		assert.deepEqual(bytes(r.payload), [1, 6])
		assert.equal(r.txn, 5)
		// READ n=0 / 越界 -> NAK 0x05，不回绕
		r = rsp(m.handleApp(mk(S.TYPE.READ, 2, [0xff, 2])))
		assert.deepEqual(bytes(r.payload), [5, 0xff])
	}

	// ---- DRN 与应用层表号: 表号取 DRN 中间 8 位 ----
	{
		assert.equal(SIM.drnToMeterNo('0101123456788'), '12345678') // 13 位: 4 位厂商码 + 8 位表号 + 校验
		assert.equal(SIM.drnToMeterNo('01123456780'), '12345678') // 11 位: 2 位厂商码 + 8 位表号 + 校验
		assert.equal(SIM.drnToMeterNo('1'), '00000001') // 台架短地址
		// 模组里存的是整数，厂商码前导 0 丢掉后照样取对
		assert.equal(SIM.drnToMeterNo(101123456788n), '12345678')
		assert.equal(SIM.drnToMeterNo(1123456780n), '12345678')
		assert.equal(SIM.drnToMeterNo('9999123456785'), '12345678')
		for (const bad of ['123456789', '0', '12345678901234']) assert.throws(() => SIM.drnToMeterNo(bad))
		assert.equal(SIM.drnCheckOk('0101123456788'), true)
		assert.equal(SIM.drnCheckOk(101123456788n), true)
		assert.equal(SIM.drnCheckOk('0101123456789'), false)
		assert.equal(SIM.drnCheckOk('1'), true)
		assert.throws(() => SIM.normalizeCiuConfig({ targetDrn: '123456789' }), /9 位/)
		assert.equal(SIM.normalizeCiuConfig({ targetDrn: '0101123456788' }).meterNo, '12345678')
	}

	// ---- 表端 DRN 留空: 以模组回读值为准 ----
	{
		const t = setup()
		await ready(t)
		const st = t.meter.getState()
		assert.equal(st.drn, METER_DRN.toString())
		assert.equal(st.meterNo, METER_NO)
		t.meter.stop(); t.ciu.stop()
	}

	// ---- 表端配置的 DRN 与模组不同: 有 PAK 写入并 REBOOT，值守地址随之更新，CIU 按新 DRN 通信 ----
	{
		const NEW_DRN = 101876543212n
		const t = setup({ meter: { drn: NEW_DRN.toString(), pak: PAK }, ciu: { targetDrn: NEW_DRN.toString() } })
		await ready(t)
		assert.equal(t.world.meter.drn, NEW_DRN)
		assert.equal(t.world.meter.devIdSets, 1)
		assert.equal(t.world.meter.reboots, 1)
		assert.equal(t.meter.getState().meterNo, '87654321')
		const r = await drive(t.clock, t.ciu.status())
		assert.equal(r.ok, true, r.message)
		t.meter.stop(); t.ciu.stop()
	}

	// ---- DRN 不同但没有 PAK: 拒绝启动，不写模组 ----
	{
		const t = setup({ meter: { drn: '0101876543212' } })
		await assert.rejects(drive(t.clock, t.meter.start()), /不一致/)
		assert.equal(t.world.meter.drn, METER_DRN)
		assert.equal(t.world.meter.devIdSets, undefined)
	}

	// ---- 模组未置备 DRN、面板也留空: 拒绝启动 ----
	{
		const t = setup({ world: { meterDrn: 0n } })
		await assert.rejects(drive(t.clock, t.meter.start()), /DRN 未设置/)
	}

	// ---- 预算末尾模组 RSP 丢失: 事务层重发也不能把放弃拖过 60s ----
	{
		const t = setup({ meter: { tokenDelayS: 55 } })
		await ready(t)
		const original = t.ciuLink.request
		t.ciuLink.request = function (cmd, payload, opts) {
			const left = t.ciu.getState().budgetLeftMs
			if (cmd === H.CMD.WOR_WAKE_CIU && left != null && left < 6000) t.world.ciu.silentUntil = t.clock.now() + 3500
			return original(cmd, payload, opts)
		}
		const res = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(res.outcome, 'timeout')
		assert.ok(res.startedAt + res.durationMs - res.sessions[0].at <= 60200, '放弃不晚于受理后 60s')
		t.meter.stop(); t.ciu.stop(); t.meterLink.close(); t.ciuLink.close()
	}

	// ---- WAKE 请求在飞期间到达的旧上行: 过不了接收判定就不占本轮上行槽，本轮仍用自己的上行 ----
	{
		const clock = makeClock()
		const handlers = []
		const old = S.buildFrame({ dir: 1, type: S.TYPE.STATUS, txn: 1, meter: METER_NO, payload: new Uint8Array(8) })
		const fresh = S.buildFrame({ dir: 1, type: S.TYPE.STATUS, txn: 2, meter: METER_NO, payload: new Uint8Array(8) })
		const event = data => {
			const payload = new Uint8Array(15 + data.length)
			payload.set(H.u64Bytes(METER_DRN)); payload[8] = 4; payload[11] = data.length; payload.set(data, 12)
			handlers.slice().forEach(cb => cb({ cmd: H.EVT.WOR_FRAME, payload }))
		}
		const link = {
			onEvt(cb) { handlers.push(cb); return () => handlers.splice(handlers.indexOf(cb), 1) },
			request(cmd) {
				if (cmd === H.CMD.WOR_WAKE_CIU) return new Promise(resolve => {
					clock.setTimeout(() => event(old), 50)
					clock.setTimeout(() => resolve({ status: 0 }), 100)
				})
				clock.setTimeout(() => event(fresh), 200)
				return Promise.resolve({ status: 0 })
			},
		}
		const ciu = SIM.createCiuSim({ link, clock, config: { targetDrn: METER_DRN.toString(), localAddr: '2' } })
		const res = await drive(clock, ciu.runSession(S.buildFrame({ dir: 0, type: S.TYPE.STATUS, txn: 2, meter: METER_NO, payload: [] }), b => S.parseRaw(b).txn === 2))
		assert.equal(res.ok, true)
		assert.equal(S.parseRaw(res.uplink).txn, 2, '用的是本轮上行，不是 WAKE 在飞期间到达的旧上行')
	}

	// ---- CIU 启动后段（读基本信息的会话中）停止: start 以 aborted 拒绝，不报成功 ----
	{
		const t = setup()
		await drive(t.clock, t.meter.start())
		const starting = t.ciu.start().then(s => ({ settled: 'resolved', running: s.running }), e => ({ settled: 'rejected', code: e.code }))
		for (let i = 0; i < 100 && t.ciu.getState().phase !== 'session'; i++) await t.clock.advance(10)
		assert.equal(t.ciu.getState().phase, 'session')
		t.ciu.stop()
		const r = await drive(t.clock, starting)
		assert.equal(r.settled, 'rejected')
		assert.equal(r.code, 'aborted')
		assert.equal(t.ciu.getState().running, false)
		t.meter.stop(); t.meterLink.close(); t.ciuLink.close()
	}
}

tests().then(() => console.log('STS simulator end-to-end checks passed'), e => {
	console.error(e)
	process.exit(1)
})
