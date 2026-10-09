// Run: node tests/sts-sim.cjs — synthetic data only.
// 双引擎端到端: 假模组对（按 hostProto 真帧收发）+ 可控假时钟，表端引擎与 CIU 引擎经完整两层协议对话
// 假模组模型（停等 ARQ）: WAKE_CIU 受理后 anchorDelayMs 到锚点，表端清空上行队列并收到 kind=2 唤醒通知，锚点 +250ms 给 CIU 发 ACK；
// 锚点 +1s 起每 1.2s 一拍: 有下行就发一帧（拍 +450ms 以 kind=3 到表端），否则征求拍；拍 +600ms DACK 捎带表端上行队列队头，以 kind=4 给 CIU；
// 下行排空后无活动 8s 由空闲看门狗收尾（reason=8，两侧各报），END 的 DACK 到达时双侧各报 EVT 0x0281；唤醒失败 12.4s 后报 reason=3；
// CIU 不发 FINISH / ABORT（模型仍支持这两条命令，用来数「发了几次」）；WOR_INIT 在已初始化的模组上回 ERR_BUSY
// CIU 模组带 DRN（本机地址，DEV_ID_GET 回读）；CIU 只在启动时查一次 WOR_GET_STATUS，运行期任何一端都不应再查 WOR_GET_STATUS / 统计
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
const WAKE_FAIL_MS = 12400
const IDLE_WATCHDOG_MS = 8000 // 最后一次活动后空闲这么久，发起端 / 表端各报 reason=8
function makeWorld(clock, opts) {
	const o = Object.assign({ anchorDelayMs: 3350, meterRole: 1, ciuRole: 2, meterDrn: METER_DRN, meterInit: true, ciuInit: true, ciuDrn: CIU_ADDR, notInitStatus: 9 }, opts || {})
	// dropAck: 丢 ACK 事件；dropUplink: 丢 CIU 侧 kind=4 事件（空口已交付）；dropSession: 唤醒失败；
	// killAfterData: 数据拍之后 DACK 全丢，发起端重传耗尽、表端失联；delayKind3: 表端 kind=3 晚 kind3DelayMs 到；upqBusy: SET_UPLINK 回 BUSY 的次数
	// sendBusy: 前 n 次 WOR_SEND 回 BUSY（FIFO 满）；initStatus: CIU 的 WOR_INIT 固定回这个状态；dropEnd: 丢掉发起端的前 n 个 0x0281 事件
	const faults = { dropAck: 0, dropUplink: 0, dropSession: 0, killAfterData: 0, delayKind3: 0, kind3DelayMs: 3000, upqBusy: 0, sendBusy: 0, dropEnd: 0, initStatus: null, beforeKind3: null, wakeStatus: null }
	const log = { kind3: [], uplinks: [], wakes: 0, sends: 0, setUplinks: [], events: [], requests: [], inits: [], finishes: 0, aborts: 0, ends: [] }
	function newModule(name, role, drn, autoInit) {
		const on = !!autoInit && role === 1 && drn !== 0n
		return {
			name, role, drn, authed: false, worInit: on, sentry: on,
			upq: [], inSession: null, session: null, cache: null, silentUntil: 0, cb: null, roleSets: 0, echoes: 0, addr: on ? drn : 0n,
			stats: {},
		}
	}
	const meter = newModule('meter', o.meterRole, o.meterDrn, o.meterInit)
	const ciu = newModule('ciu', o.ciuRole, o.ciuDrn, false)
	ciu.addr = o.ciuDrn
	ciu.worInit = o.ciuInit
	const meter2 = o.meter2Drn ? newModule('meter2', 1, o.meter2Drn, true) : null

	function emit(mod, frame) {
		clock.setTimeout(() => {
			if (!mod.cb) return
			const f = H.scan(frame, 0, true)
			if (f.status === 'frame' && f.type === H.TYPE_EVT && f.cmd === H.EVT.WOR_SESSION_END && mod === ciu && faults.dropEnd > 0) { faults.dropEnd--; return }
			if (f.status === 'frame' && f.type === H.TYPE_EVT) {
				const d = f.cmd === H.EVT.WOR_FRAME ? H.decodeWorFrame(f.payload) : null
				const e = f.cmd === H.EVT.WOR_SESSION_END ? H.decodeSessionEnd(f.payload) : null
				log.events.push({ at: clock.now(), role: mod.name, cmd: f.cmd, kind: d && d.kind, reason: e && e.reason })
			}
			mod.cb(frame)
		}, 1)
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
	function endFrame(reason, dl, up) { return H.buildFrame({ type: 2, cmd: 0x0281, seq: 0, payload: [reason, dl & 0xff, dl >> 8, up] }) }
	const ROLE_OK = {
		1: c => c < 0x0100 || (c >= 0x0300) || (c >= 0x0200 && c <= 0x0201) || c === 0x020f || c === 0x0202 || c === 0x0203 || (c >= 0x0204 && c <= 0x0206) || c === 0x020c || c === 0x0211 || (c >= 0x0100 && c < 0x0200),
		2: c => c < 0x0100 || c >= 0x0300 || c === 0x0200 || c === 0x0201 || c === 0x020f || c === 0x0208 || c === 0x020a || c === 0x020b || c === 0x0211,
	}
	function resetRuntime(mod) {
		mod.worInit = mod.role === 1 && mod.drn !== 0n
		mod.sentry = mod.worInit
		mod.addr = mod.worInit ? mod.drn : 0n
		if (mod.session) mod.session.ended = true
		mod.session = null; mod.inSession = null; mod.upq = []; mod.cache = null; mod.authed = false
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
					resetRuntime(mod)
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
				mod.reboots = (mod.reboots || 0) + 1
				resetRuntime(mod)
			} }
			case 0x0200:
				if (p.length !== 9) return { status: 1 }
				log.inits.push({ at: clock.now(), role: mod.name, payloadRole: p[0], addr: H.u64(p, 1) })
				if (faults.initStatus != null && mod === ciu) return { status: faults.initStatus }
				if (mod.worInit) return { status: 2 } // 已初始化: ERR_BUSY
				mod.worInit = true
				mod.addr = H.u64(p, 1)
				return OK
			case 0x0201: return mod.worInit ? { status: 0, data: [mod.role === 1 ? 1 : 2, mod.role === 1 ? (mod.sentry ? 1 : 0) : (mod.session ? 9 : 0), ...H.u64Bytes(mod.addr)] } : { status: o.notInitStatus }
			case 0x020f: { // 53×u32，只填假模组维护的几个计数
				const out = [212, 0]
				H.WOR_STATS_FIELDS.forEach(f => { const v = mod.stats[f] || 0; out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff) })
				return { status: 0, data: out }
			}
			case 0x0202: if (!mod.worInit) return { status: o.notInitStatus }
				mod.sentry = true
				return OK
			case 0x020c:
				if (!mod.worInit) return { status: o.notInitStatus }
				if (p.length === 0) { mod.upq = []; return OK } // 空载荷 = 清空未发送队列
				if (p[0] > 64 || p.length !== 1 + p[0]) return { status: 5 }
				if (faults.upqBusy > 0) { faults.upqBusy--; return { status: 2 } }
				if (mod.upq.length >= 4) return { status: 2 }
				mod.upq.push(Uint8Array.from(p.subarray(1)))
				log.setUplinks.push({ at: clock.now(), data: Uint8Array.from(p.subarray(1)) })
				return OK
			case 0x0208: {
				if (!mod.worInit) return { status: o.notInitStatus }
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
				if (faults.sendBusy > 0) { faults.sendBusy--; return { status: 2 } }
				const len = p[0] | (p[1] << 8)
				if (p.length !== 2 + len) return { status: 5 }
				mod.session.queue.push(Uint8Array.from(p.subarray(2)))
				log.sends++
				return OK
			}
			case 0x020b:
				if (!mod.session) return { status: 6 }
				mod.session.finish = true
				log.finishes++
				return OK
			case 0x0211: {
				if (!mod.session) return { status: 6 }
				const s = mod.session
				s.abort = true
				log.aborts++
				if (!s.anchored) clock.setTimeout(() => endSession(mod, s, 4, null), 10) // burst 期闩锁，立即终结
				return OK
			}
			default: return { status: 4 }
		}
	}
	function startSession(mod, dst) {
		const take = k => { if (faults[k] > 0) { faults[k]--; return true } return false }
		const target = [meter, meter2].find(m => m && m.drn === dst && m.sentry) || null
		const s = {
			dst, target, queue: [], finish: false, abort: false, ended: false, anchored: false, dl: 0, up: 0, lastPayloadAt: 0,
			dead: take('dropSession'), dropAck: take('dropAck'), dropUplink: take('dropUplink'), kill: take('killAfterData'), late: take('delayKind3'),
		}
		mod.session = s
		if (s.dead || !target) {
			clock.setTimeout(() => endSession(mod, s, 3, null), WAKE_FAIL_MS)
			return
		}
		clock.setTimeout(() => {
			if (s.ended) return
			s.anchored = true
			s.lastPayloadAt = clock.now()
			if (target.inSession) target.inSession.ended = true
			target.upq = [] // 被唤醒即清空上行队列并通知表务主机
			target.inSession = s
			emit(target, evtFrame(mod.addr, 2, 1, [], -80, 7))
			const bump = (m, f) => { m.stats[f] = (m.stats[f] || 0) + 1 }
			bump(target, 'wakes'); bump(target, 'ciuWakes')
			clock.setTimeout(() => { s.acked = true; bump(mod, 'wakeOk'); if (!s.dropAck && !s.ended) emit(mod, evtFrame(dst, 2, 1, [], -80, 7)) }, 250)
			clock.setTimeout(() => {
				beat(mod, s)
			}, 1000)
		}, o.anchorDelayMs)
	}
	function beat(mod, s) {
		if (s.ended) return
		const target = s.target
		if (s.abort) { clock.setTimeout(() => endSession(mod, s, 4, 4), 600); return }
		if (s.queue.length) {
			const d = s.queue.shift()
			s.dl++
			s.lastPayloadAt = clock.now()
			mod.stats.dataTx = (mod.stats.dataTx || 0) + 1
			target.stats.dataRx = (target.stats.dataRx || 0) + 1
			clock.setTimeout(() => deliverKind3(target, mod, d, s.late), 450)
			if (s.kill) { clock.setTimeout(() => endSession(mod, s, 7, 5), 600); return } // DACK 全丢: 发起端重传耗尽，表端失联早退
		} else if (s.finish || clock.now() - s.lastPayloadAt >= IDLE_WATCHDOG_MS) {
			clock.setTimeout(() => endSession(mod, s, s.finish ? 2 : 8, s.finish ? 1 : 8), 600) // END 经 DACK 确认后终结
			return
		}
		clock.setTimeout(() => {
			if (s.ended || target.inSession !== s || !target.upq.length) return
			const data = target.upq.shift() // DACK 捎带队头一片
			s.up++
			s.lastPayloadAt = clock.now()
			log.uplinks.push({ at: clock.now(), data, dropped: s.dropUplink })
			if (!s.dropUplink) emit(mod, evtFrame(0n, 4, 2, data, -80, 7)) // 实板固件: 捎带上行的 src 为 0
		}, 600)
		clock.setTimeout(() => beat(mod, s), 1200)
	}
	function endSession(mod, s, initReason, meterReason) {
		if (s.ended) return
		s.ended = true
		if (mod.session === s) mod.session = null
		log.ends.push({ at: clock.now(), reason: initReason, dl: s.dl, up: s.up })
		emit(mod, endFrame(initReason, s.dl, s.up))
		const target = s.target
		if (meterReason != null && target && target.inSession === s) {
			target.inSession = null
			target.upq = [] // 任何断开都清空上行队列
			emit(target, endFrame(meterReason, s.dl, s.up))
		}
	}
	function deliverKind3(target, from, data, late) {
		const go = () => {
			if (faults.beforeKind3) faults.beforeKind3(data)
			log.kind3.push({ at: clock.now(), data })
			emit(target, evtFrame(from.addr, 3, 1, data, -80, 7))
		}
		if (late) clock.setTimeout(go, faults.kind3DelayMs)
		else go()
	}
	function onWrite(mod, bytesIn) {
		if (clock.now() < mod.silentUntil) return
		const s = H.scan(Uint8Array.from(bytesIn), 0, true)
		if (s.status !== 'frame' || s.type !== 0) return
		log.requests.push({ at: clock.now(), role: mod.name, cmd: s.cmd, payload: Uint8Array.from(s.payload) })
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
		link: o.ciuLinkWrap ? o.ciuLinkWrap(ciuLink) : ciuLink, clock: o.ciuClock ? o.ciuClock(clock) : clock, onLog: e => logs.ciu.push(e),
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
		assert.equal(t.world.log.setUplinks.length, 0) // 不预置上行: 队列每次被唤醒都会清空
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

	// ---- CIU 本机地址与 WOR_INIT: 地址取自 DEV_ID_GET 的 DRN，不采用旧配置；启动查一次 WOR_GET_STATUS，未初始化才 INIT ----
	for (const localAddr of ['7', 'invalid old value', '']) {
		const t = setup({ ciu: { localAddr }, world: { ciuDrn: 11n, ciuInit: false } })
		await ready(t)
		assert.equal(t.ciu.getState().localAddr, '11')
		const cr = t.world.log.requests.filter(r => r.role === 'ciu')
		assert.ok(cr.filter(r => r.cmd === H.CMD.PROV_DEV_ID_GET).length >= 1)
		assert.equal(cr.filter(r => r.cmd === H.CMD.WOR_GET_STATUS).length, 1, 'CIU 只在启动时查一次 WOR_GET_STATUS')
		const inits = t.world.log.inits.filter(i => i.role === 'ciu')
		assert.equal(inits.length, 1, '上电后只 INIT 一次，会话前不再 INIT')
		assert.ok(inits.every(i => i.payloadRole === 2 && i.addr === 11n), 'WOR_INIT(role=2, addr=本机 DRN)')
		t.meter.stop(); t.ciu.stop()
	}
	{
		// 全新发起端: 启动时 GET_STATUS 回未初始化 -> INIT 回 OK 并采用该地址；之后的会话不再 INIT
		const t = setup({ world: { ciuInit: false } })
		await ready(t)
		assert.equal(t.world.ciu.worInit, true)
		assert.equal(t.world.ciu.addr, CIU_ADDR)
		assert.equal((await drive(t.clock, t.ciu.status())).ok, true)
		assert.equal(t.world.log.inits.filter(i => i.role === 'ciu').length, 1)
		t.meter.stop(); t.ciu.stop()
	}
	{
		// 已初始化的发起端（ERR_STATE 旧固件同理）: 启动只查 GET_STATUS，不发 INIT
		const t = setup()
		await ready(t)
		assert.equal((await drive(t.clock, t.ciu.status())).ok, true)
		assert.equal(t.world.log.inits.filter(i => i.role === 'ciu').length, 0, '已初始化不再 INIT')
		assert.match(logText(t.logs.ciu), /WOR 已初始化 \[2 INITIATOR\]/)
		t.meter.stop(); t.ciu.stop()
	}
	{
		const t = setup({ world: { ciuInit: false, notInitStatus: H.STATUS.ERR_STATE } })
		await ready(t)
		assert.equal(t.world.log.inits.filter(i => i.role === 'ciu').length, 1, '旧固件 ERR_STATE 也认作未初始化')
		t.meter.stop(); t.ciu.stop()
	}
	{
		const t = setup({ world: { ciuDrn: 0n } })
		await assert.rejects(drive(t.clock, t.ciu.start()), /DRN 未置备.*keytool/)
		assert.equal(t.ciu.getState().running, false)
		assert.equal(t.ciu.getState().localAddr, null)
		assert.equal(t.world.log.inits.filter(i => i.role === 'ciu').length, 0)
		t.ciu.stop()
	}
	{
		const t = setup({ world: { ciuInit: false } })
		t.world.faults.initStatus = H.STATUS.ERR_ROLE
		await assert.rejects(drive(t.clock, t.ciu.start()), /WOR_INIT 失败.*ERR_ROLE.*模组角色不是 CIU/)
		assert.equal(t.ciu.getState().running, false)
		t.ciu.stop()
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
		assert.equal(res.token.stsBlockHex, '00 01 00 00 01 F4') // STS 结果块: MODE1，Value 与本次充值量同为 500
		assert.equal(res.token.stsResult.kind, 'credit')
		assert.equal(res.token.stsResult.mismatch, false)
		assert.match(res.token.stsResultText, /MODE1 充值成功，充值量 500/)
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
		// 每轮会话的时间线: wake 受理 <= send <= ack <= 上行（不等终结）；首拍数据的 DACK（锚点 +1.6s）就捎带了应答
		const tl = res.sessions[0].timeline
		assert.ok(tl.wakeMs != null && tl.sendMs >= tl.wakeMs && tl.ackMs >= tl.sendMs && tl.upMs > tl.ackMs)
		assert.ok(Math.abs((tl.upMs - tl.ackMs) - 1350) < 20, 'up-ack ' + (tl.upMs - tl.ackMs)) // ACK 在锚点 +250ms
		assert.equal(tl.initMs, null) // 会话里不 INIT，只有补 INIT 时才记
		assert.equal(tl.endReason, null) // 成功后立即返回，不等 0x0281
		assert.equal(tl.endMs, null)
		assert.equal(t.world.log.finishes, 0)
		assert.equal(t.world.log.aborts, 0)
		await t.clock.advance(15000) // 会话由空闲看门狗自行收尾，双侧各报一次 reason=8
		assert.ok(t.world.log.ends.length >= 3 && t.world.log.ends.length === t.world.log.wakes)
		assert.ok(t.world.log.ends.every(e => e.reason === 8))
		assert.match(logText(t.logs.ciu), /上一会话已终结（reason=8 空闲看门狗）/)
		assert.match(logText(t.logs.meter), /SET_UPLINK 入队 OK，耗时 \d+ms/)
		assert.match(logText(t.logs.meter), /被唤醒（kind=2 通知）src=2/)
		assert.match(logText(t.logs.meter), /会话终结 0x0281（reason=8 空闲看门狗/)
		const lastSess = t.meter.getState().lastSession
		assert.ok(lastSess.sinceKind3Ms < 100)
		// 之后查询剩余量与充值记录
		const rec = await drive(t.clock, t.ciu.records())
		assert.equal(rec.ok, true, rec.message)
		assert.equal(rec.records.length, 1)
		assert.equal(rec.records[0].amount, 500)
		assert.match(rec.records[0].timeText, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
	}
	// 结果码模式: 处理状态 1 + MODE3，余额不动；旧配置 'reject' 按 REJECT
	for (const [mode, block, msg] of [['reject', '00 03 00 00 00 FF', /令牌未执行：REJECT 错误的令牌/], ['3', '00 03 00 00 00 03', /令牌未执行：USED/], ['8', '00 03 00 00 00 08', /令牌成功（非充值）：CLEAR_CREDIT 清余额成功/]]) {
		const t = setup({ meter: { tokenMode: mode } })
		await ready(t)
		const res = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(res.ok, true)
		assert.equal(res.token.executed, false)
		assert.equal(res.token.stsBlockHex, block)
		assert.match(res.message, msg)
		assert.equal(t.meter.getState().remaining, 5000)
		assert.equal(t.meter.getState().recordCount, 0)
	}
	// 表计测试模式: MODE256 位图逐位解释
	{
		const t = setup({ meter: { tokenMode: 'test', testBits: '20001' } })
		await ready(t)
		const res = await drive(t.clock, t.ciu.token(TOKEN_A))
		assert.equal(res.token.stsBlockHex, '00 FF 00 02 00 01')
		assert.match(res.message, /表计测试令牌：BIT0 水阀开关测试、BIT17 显示 DRN/)
		assert.throws(() => SIM.normalizeMeterConfig({ tokenMode: 'test', testBits: 'xyz' }), /十六进制/)
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
	// 会话在应答捎带前中断（重传耗尽）: CIU 收到 0x0281 立即判失败，表端队列随会话清空；重发同一帧后成功
	{
		const t = setup()
		await ready(t)
		t.world.faults.killAfterData = 1
		const res = await drive(t.clock, t.ciu.status())
		assert.equal(res.ok, true, res.message)
		assert.equal(res.sessions[0].ok, false)
		assert.match(res.sessions[0].reason, /会话已终结（重传耗尽），没有收到本轮上行/)
		assert.equal(res.sessions[0].timeline.endReason, 7)
		assert.ok(res.sessions[0].timeline.endMs - res.sessions[0].timeline.ackMs < 3000, '不白等上行超时')
		assert.equal(res.sessions[1].ok, true)
		assert.match(logText(t.logs.meter), /1 片未获确认（可能未送达），队列已随会话清空/)
		assert.equal(t.world.log.aborts, 0) // 会话已终结
	}
	// C3: 上行队列满等一拍期间会话结束，旧应答不得再入队（否则会被捎带进下一会话）
	{
		const t = setup()
		await ready(t)
		t.world.faults.killAfterData = 1
		t.world.faults.upqBusy = 1
		const before = t.world.log.setUplinks.length
		const res = await drive(t.clock, t.ciu.status())
		assert.equal(res.ok, true, res.message)
		assert.match(logText(t.logs.meter), /等待入队期间会话已结束，旧应答不再入队/)
		assert.equal(t.world.log.setUplinks.length - before, 1) // 只有第二轮会话的应答入队
		assert.equal(res.sessions[1].ok, true)
	}
	// kind=3 晚到 3s: 应答在轮询相的征求拍里捎带，同一会话内完成
	{
		const t = setup()
		await ready(t)
		t.world.faults.delayKind3 = 1
		const res = await drive(t.clock, t.ciu.status())
		assert.equal(res.ok, true, res.message)
		assert.equal(res.sessions.length, 1)
		assert.ok(res.sessions[0].timeline.upMs - res.sessions[0].timeline.ackMs > 3000)
	}
	// kind=3 晚到超过空闲看门狗 8s: 会话已按空闲收尾，应答没赶上；重新唤醒后成功
	{
		const t = setup()
		await ready(t)
		t.world.faults.delayKind3 = 1
		t.world.faults.kind3DelayMs = 10000
		const res = await drive(t.clock, t.ciu.status())
		assert.equal(res.ok, true, res.message)
		assert.equal(res.sessions[0].ok, false)
		assert.match(res.sessions[0].reason, /空闲看门狗/)
		assert.equal(res.sessions[1].ok, true)
	}
	// CIU 等上行超时（会话还活着）: 什么都不发，下一轮硬等这个会话的 0x0281（空闲看门狗）再唤醒，不撞 BUSY
	{
		const t = setup({ ciu: { upTimeoutS: 2 } })
		await ready(t)
		t.world.faults.delayKind3 = 1
		const res = await drive(t.clock, t.ciu.status())
		assert.equal(res.ok, true, res.message)
		assert.match(res.sessions[0].reason, /等上行超时/)
		assert.equal(res.sessions[0].timeline.endReason, null)
		assert.equal(t.world.log.aborts, 0)
		assert.equal(t.world.log.finishes, 0)
		assert.equal(res.sessions[1].ok, true)
		assert.doesNotMatch(logText(t.logs.ciu), /WOR_WAKE_CIU 回 BUSY/)
		assert.match(logText(t.logs.ciu), /上一会话已终结/)
	}
	// 表端上行队列满（BUSY）: 等一拍再入队，轮询相捎带，同一会话内完成
	{
		const t = setup()
		await ready(t)
		t.world.faults.upqBusy = 2
		const res = await drive(t.clock, t.ciu.status())
		assert.equal(res.ok, true, res.message)
		assert.equal(res.sessions.length, 1)
		assert.match(logText(t.logs.meter), /上行队列满（BUSY），等一拍再入队/)
	}
	// 唤醒失败: 0x0281 reason=3 立即判失败，不等 ACK 超时
	{
		const t = setup({ ciu: { ackTimeoutS: 60, sessionRetries: 0 } })
		await ready(t)
		t.world.faults.dropSession = 1
		const r = await drive(t.clock, t.ciu.runSession(hex('38 12 34 56 78 03')))
		assert.equal(r.ok, false)
		assert.match(r.reason, /唤醒失败（burst 耗尽/)
		assert.equal(r.stage, 'ack')
		const wake = t.world.log.requests.filter(e => e.role === 'ciu' && e.cmd === H.CMD.WOR_WAKE_CIU).at(-1)
		const end = t.world.log.events.filter(e => e.role === 'ciu' && e.cmd === H.EVT.WOR_SESSION_END).at(-1)
		assert.ok(end.at - wake.at < 13000, 'burst 耗尽从实际 WAKE 起算，冷却不计入唤醒预算')
	}
	// ---- 模拟令牌: 各类型的表端解析与结果块 ----
	{
		const t = setup({ meter: { tokenDelayS: 0 } })
		await ready(t)
		let serial = 100
		const sim = (type, data) => S.simTokenEncode({ type, serial: serial++, data: data || 0 })
		const run = async tok => drive(t.clock, t.ciu.token(tok))
		// 充值: 数据按 STS 单位 0.1 m³，体积模式落账 ×1000 dL；状态 2 + MODE1，Value 与充值量同数
		let r = await run(sim('01', 2))
		assert.equal(r.token.executed, true)
		assert.equal(r.token.credited, 2000)
		assert.equal(r.token.stsBlockHex, '00 01 00 00 07 D0')
		assert.equal(t.meter.getState().remaining, 7000)
		assert.match(logText(t.logs.meter), /模拟令牌: 充值，序号 100，充值量 2 × 0\.1 m³（= 0\.2 m³ = 200 L，线上 2000 dL）/)
		// 后付费: 表计状态 bit5；预付费清掉
		r = await run(sim('04'))
		assert.match(r.message, /令牌成功（非充值）：SET_POSTPAY 设置后付费/)
		assert.equal(t.meter.getState().meterStatus & S.MST_POSTPAID, S.MST_POSTPAID)
		await run(sim('03'))
		assert.equal(t.meter.getState().meterStatus & S.MST_POSTPAID, 0)
		// 关阀 / 开阀: 阀门真实变化
		r = await run(sim('06'))
		assert.match(r.message, /VALVE_CLOSE/)
		assert.equal(t.meter.getState().valve, S.VALVE_POS_CLOSED)
		await run(sim('05'))
		assert.equal(t.meter.getState().valve, S.VALVE_POS_OPEN)
		// 换钥: 第一枚 1ST，接着第二枚 SUCCESS；单独第二枚 2ND
		assert.match((await run(sim('10'))).message, /1ST 换钥第一步/)
		assert.match((await run(sim('11'))).message, /SUCCESS/)
		assert.match((await run(sim('11'))).message, /2ND 换钥第二步/)
		// 表计测试位图 / 指定结果码 / 清余额
		assert.match((await run(sim('20', 0x20001))).message, /表计测试令牌：BIT0 水阀开关测试、BIT17 显示 DRN/)
		assert.match((await run(sim('90', 2))).message, /令牌未执行：OLD 令牌过期/)
		assert.match((await run(sim('90', 255))).message, /REJECT/)
		r = await run(sim('02'))
		assert.match(r.message, /CLEAR_CREDIT 清余额成功/)
		assert.equal(t.meter.getState().remaining, 0)
		// 去重深度内再输: 回放上次结果；超出深度（5 笔）后再输: USED
		const tok = sim('01', 1)
		assert.equal((await run(tok)).token.executed, true)
		assert.equal((await run(tok)).token.executed, true) // 回放，不重复充值
		assert.equal(t.meter.getState().remaining, 1000)
		for (let i = 0; i < 5; i++) await run(sim('08'))
		r = await run(tok)
		assert.match(r.message, /令牌未执行：USED 令牌已使用/)
		assert.equal(t.meter.getState().remaining, 1000)
		// 余额上限另见下一段；校验对但类型未知: REJECT
		const d18 = '77' + '55' + '0001' + '0000000000'
		let sum = 0; for (let i = 0; i < 18; i++) sum += (d18.charCodeAt(i) - 48) * (i % 2 ? 3 : 1)
		assert.match((await run(d18 + String(sum % 97).padStart(2, '0'))).message, /REJECT/)
	}
	// ---- 余额上限: 充值后超出即 OVER（模拟令牌与「已执行」普通令牌一致），不占用、不回放 ----
	{
		const t = setup({ meter: { tokenDelayS: 0, remaining: 8000, creditLimit: 10000, creditAmount: 200 } })
		await ready(t)
		const run = async tok => drive(t.clock, t.ciu.token(tok))
		const over = S.simTokenEncode({ type: '01', serial: 1, data: 3 })
		let r = await run(over)
		assert.equal(r.token.executed, false)
		assert.match(r.message, /令牌未执行：OVER 余额过多/)
		assert.equal(r.token.stsBlockHex, '00 03 00 00 00 01')
		assert.equal(t.meter.getState().remaining, 8000)
		assert.match(logText(t.logs.meter), /充值量 3 × 0\.1 m³（= 0\.3 m³ = 300 L，线上 3000 dL）；充值后余额超出余额上限 10000 dL/)
		r = await run(S.simTokenEncode({ type: '01', serial: 2, data: 2 })) // 恰好到上限: 成功
		assert.equal(r.token.executed, true)
		assert.equal(t.meter.getState().remaining, 10000)
		assert.match(logText(t.logs.meter), /已执行，余额 10000 dL（= 1000\.0 L）/)
		r = await run('12345678901234567890') // 普通令牌按 creditAmount 200: 超上限
		assert.match(r.message, /OVER 余额过多/)
		t.meter.setLive({ remaining: 5000 })
		r = await run(over) // 余额降下来后同一令牌重新判定，不回放旧的 OVER
		assert.equal(r.token.executed, true)
		assert.equal(t.meter.getState().remaining, 8000)
	}
	// 模拟令牌编解码与日志解析
	{
		const tok = S.simTokenEncode({ type: '01', serial: 1, data: 500 })
		assert.equal(tok, '77010001000000050049')
		assert.equal(S.simTokenDecode(tok).data, 500)
		assert.equal(S.simTokenDecode(tok.slice(0, 19) + '0'), null) // 校验不符按普通令牌
		assert.equal(S.simTokenDecode('77777777777777771000'), null)
		assert.throws(() => S.simTokenEncode({ type: '99' }), /未知/)
		const f = S.buildFrame({ dir: 0, type: S.TYPE.TOKEN, txn: 1, meter: METER_NO, payload: S.tokenReqEncode(tok) })
		assert.match(S.parseFrame(f).decoded, /模拟令牌: 充值，序号 1，充值量 500（体积: × 0\.1 m³ = 100 L；金额: × 10\^-d 货币单位）/)
		assert.equal(S.simTokenCredit(S.simTokenDecode(tok), { currency: false, dec: 1 }), 500000)
		assert.equal(S.simTokenCredit(S.simTokenDecode(tok), { currency: true, dec: 2 }), 500) // 金额模式不换算
		assert.equal(S.qtyRawText(500, { currency: false, dec: 1 }), '500 dL（= 50.0 L）')
		assert.equal(S.qtyRawText(500, { currency: true, dec: 2 }), '500 × 0.01 货币单位（= 5.00 货币单位）')
		assert.equal(S.qtyRawText(500, { currency: true, dec: 0 }), '500 货币单位')
		assert.equal(S.qtyUnit({ currency: true, dec: 3 }), '0.001 货币单位')
	}
	// 冷却 / 硬等上一会话 0x0281 的等待可立即中止；取消后不能迟到发出 WAKE。
	{
		const t = setup()
		await ready(t)
		const requestAt = t.world.log.requests.length
		const p = t.ciu.status()
		await t.clock.advance(10)
		t.ciu.abort()
		assert.equal((await drive(t.clock, p)).outcome, 'aborted')
		await t.clock.advance(1500)
		assert.equal(t.world.log.requests.slice(requestAt).filter(r => r.role === 'ciu' && r.cmd === H.CMD.WOR_WAKE_CIU).length, 0, '等待期间取消后不发出唤醒')
		t.ciu.stop(); t.meter.stop(); t.ciuLink.close(); t.meterLink.close()
	}
	// 会话前不再 WOR_INIT；WAKE 回未初始化（模组中途复位）才补一次 INIT 再 WAKE
	{
		const t = setup()
		await ready(t)
		const at = t.world.log.requests.length
		for (let i = 0; i < 3; i++) assert.equal((await drive(t.clock, t.ciu.status())).ok, true)
		const reqs = t.world.log.requests.slice(at).filter(r => r.role === 'ciu')
		assert.ok(reqs.filter(r => r.cmd === H.CMD.WOR_WAKE_CIU).length >= 3)
		assert.equal(reqs.filter(r => r.cmd === H.CMD.WOR_INIT).length, 0, '会话前不 INIT')
		// 模组复位丢了 WorLink 初始化: WAKE 回 ERR_NOT_INIT -> INIT(role=2, 本机 DRN) -> 再 WAKE 成功
		t.world.ciu.worInit = false
		const i0 = t.world.log.inits.length
		assert.equal((await drive(t.clock, t.ciu.status())).ok, true)
		const ni = t.world.log.inits.slice(i0)
		assert.equal(ni.length, 1)
		assert.equal(ni[0].payloadRole, 2, 'role = INITIATOR')
		assert.equal(ni[0].addr, CIU_ADDR)
		assert.match(logText(t.logs.ciu), /补 WOR_INIT 后重试/)
		assert.equal((await drive(t.clock, t.ciu.status())).ok, true)
		assert.equal(t.world.log.inits.length, i0 + 1, '补过之后不再 INIT')
		// 补 INIT 的其它状态: ERR_ROLE 给出明确原因；别的错误带状态名；都不再 WAKE
		t.world.ciu.worInit = false
		t.world.faults.initStatus = H.STATUS.ERR_ROLE
		const w0 = t.world.log.wakes
		const r1 = await drive(t.clock, t.ciu.runSession(hex('38 12 34 56 78 03')))
		assert.equal(r1.ok, false)
		assert.equal(r1.stage, 'init')
		assert.match(r1.reason, /模组角色不是 CIU/)
		t.world.faults.initStatus = H.STATUS.ERR_FMT
		const r2 = await drive(t.clock, t.ciu.runSession(hex('38 12 34 56 78 03')))
		assert.match(r2.reason, /WOR_INIT 失败: ERR_FMT/)
		assert.equal(t.world.log.wakes, w0, 'INIT 失败不 WAKE')
		// INIT 回 OK 但 WAKE 仍未初始化: 只补一次，不循环
		t.world.faults.initStatus = H.STATUS.OK
		const i1 = t.world.log.inits.length
		const r3 = await drive(t.clock, t.ciu.runSession(hex('38 12 34 56 78 03')))
		assert.equal(r3.ok, false)
		assert.match(r3.reason, /补 WOR_INIT 后仍未就绪/)
		assert.equal(t.world.log.inits.length, i1 + 1)
		t.ciu.stop(); t.meter.stop(); t.ciuLink.close(); t.meterLink.close()
	}
	// 不发 FINISH / ABORT，运行期两端都不查 WOR_GET_STATUS / 统计（成功、各种失败、重试都一样）
	{
		const t = setup({ ciu: { sessionRetries: 2, upTimeoutS: 3 } })
		await ready(t)
		const at = t.world.log.requests.length
		await drive(t.clock, t.ciu.status())
		t.world.faults.dropSession = 1
		await drive(t.clock, t.ciu.status())
		t.world.faults.killAfterData = 1
		await drive(t.clock, t.ciu.token(TOKEN_A))
		t.world.faults.dropUplink = 1
		await drive(t.clock, t.ciu.read(0x03, 1))
		t.world.faults.delayKind3 = 1
		await drive(t.clock, t.ciu.status())
		t.world.faults.dropAck = 1
		await drive(t.clock, t.ciu.status())
		const banned = [H.CMD.WOR_GET_STATUS, H.CMD.WOR_STATS_GET, H.CMD.WOR_FINISH, H.CMD.WOR_ABORT]
		assert.equal(t.world.log.requests.slice(at).filter(r => banned.includes(r.cmd)).length, 0, '运行期没有 GET_STATUS / 统计 / FINISH / ABORT')
		assert.equal(t.world.log.requests.filter(r => r.role === 'ciu' && banned.includes(r.cmd) && r.cmd !== H.CMD.WOR_GET_STATUS).length, 0, 'CIU 从启动起就不发统计 / FINISH / ABORT')
		assert.equal(t.world.log.requests.filter(r => r.role === 'ciu' && r.cmd === H.CMD.WOR_GET_STATUS).length, 1, 'CIU 只在启动时查一次 WOR_GET_STATUS')
		assert.equal(t.world.log.finishes, 0)
		assert.equal(t.world.log.aborts, 0)
		assert.doesNotMatch(logText(t.logs.ciu), /诊断:/)
		assert.doesNotMatch(logText(t.logs.meter), /诊断:/)
		t.ciu.stop(); t.meter.stop(); t.ciuLink.close(); t.meterLink.close()
	}
	// 相邻会话: 下一轮 WAKE 在上一会话 0x0281 之后（再冷却一拍），正常情况不撞 BUSY
	{
		const t = setup()
		await ready(t)
		const f = hex('38 12 34 56 78 03')
		const at = t.world.log.requests.length
		const evAt = t.world.log.events.length
		for (let i = 0; i < 3; i++) assert.equal((await drive(t.clock, t.ciu.runSession(f))).ok, true)
		const wakes = t.world.log.requests.slice(at).filter(r => r.role === 'ciu' && r.cmd === H.CMD.WOR_WAKE_CIU)
		assert.equal(wakes.length, 3)
		// 起点之前（读基本信息）的会话终结也在窗口外，所以把终结事件按时间排好，逐个核对「WAKE 前有一个终结 + 1.2s」
		const ends = t.world.log.events.slice(evAt).filter(e => e.role === 'ciu' && e.cmd === H.EVT.WOR_SESSION_END)
		assert.ok(ends.length >= 3)
		wakes.forEach((w, i) => {
			const before = ends.filter(e => e.at <= w.at).at(-1)
			assert.ok(before && w.at - before.at >= 1200, '第 ' + i + ' 次 WAKE 在上一会话终结后至少一拍')
			assert.ok(before.reason === 8)
		})
		assert.doesNotMatch(logText(t.logs.ciu), /WOR_WAKE_CIU 回 BUSY/)
		assert.equal(t.world.log.wakes, wakes.length + 2) // 启动读基本信息 2 次 WAKE 之外只有这 3 次
		t.ciu.stop(); t.meter.stop(); t.ciuLink.close(); t.meterLink.close()
	}
	// 上一会话的 0x0281 丢了: 硬等到上限（从上一次 runSession 返回起算）再冷却才 WAKE，模组早已收尾所以不撞 BUSY
	{
		const t = setup()
		await ready(t)
		await t.clock.advance(20000) // 先让启动读基本信息的会话收尾，不干扰计时
		const f = hex('38 12 34 56 78 03')
		t.world.faults.dropEnd = 1
		const r1 = await drive(t.clock, t.ciu.runSession(f))
		assert.equal(r1.ok, true)
		const done = t.clock.now()
		const r2 = await drive(t.clock, t.ciu.runSession(f))
		assert.equal(r2.ok, true)
		const wake2 = t.world.log.requests.filter(r => r.role === 'ciu' && r.cmd === H.CMD.WOR_WAKE_CIU).at(-1)
		const gap = wake2.at - done
		assert.ok(gap >= 15000 + 1200 - 100 && gap <= 15000 + 1200 + 300, 'WAKE 间隔 ' + gap)
		assert.match(logText(t.logs.ciu), /上一会话 15s 内没有收到 0x0281/)
		assert.doesNotMatch(logText(t.logs.ciu), /WOR_WAKE_CIU 回 BUSY/)
		t.ciu.stop(); t.meter.stop(); t.ciuLink.close(); t.meterLink.close()
	}
	// WOR_SEND 回 BUSY（FIFO 满）: 隔 1400ms 重发同一帧
	{
		const t = setup()
		await ready(t)
		const f = hex('38 12 34 56 78 03')
		const at = t.world.log.requests.length
		t.world.faults.sendBusy = 3
		const r = await drive(t.clock, t.ciu.runSession(f))
		assert.equal(r.ok, true, r.reason)
		const sends = t.world.log.requests.slice(at).filter(x => x.role === 'ciu' && x.cmd === H.CMD.WOR_SEND)
		assert.equal(sends.length, 4)
		for (let i = 1; i < sends.length; i++) {
			const gap = sends[i].at - sends[i - 1].at
			assert.ok(gap >= 1400 && gap <= 1410, '重发间隔 ' + gap)
			assert.equal(hs(sends[i].payload), hs(sends[0].payload), '重发的是同一帧')
		}
		t.ciu.stop(); t.meter.stop(); t.ciuLink.close(); t.meterLink.close()
	}
	// 硬等上一会话 0x0281 期间中止 / 停止: 立即以 aborted 结束，不发 WAKE，引擎的定时器与订阅都清掉
	{
		const timers = new Set()
		let subs = 0
		const t = setup({
			ciuClock: c => ({
				now: c.now,
				setTimeout(fn, ms) { const h = c.setTimeout(() => { timers.delete(h); fn() }, ms); timers.add(h); return h },
				clearTimeout(h) { timers.delete(h); c.clearTimeout(h) },
			}),
			ciuLinkWrap: l => ({
				request: (...a) => l.request(...a),
				onEvt: cb => { subs++; const u = l.onEvt(cb); return () => { subs--; u() } },
			}),
		})
		await ready(t)
		assert.equal(timers.size, 0, '启动后引擎没有挂着定时器')
		assert.equal(subs, 1, '只有 CIU 级的 0x0281 订阅')
		const wakes = () => t.world.log.requests.filter(r => r.role === 'ciu' && r.cmd === H.CMD.WOR_WAKE_CIU).length
		const w0 = wakes()
		const p = t.ciu.status() // 启动读基本信息的会话还没收尾 -> 进入硬等
		await t.clock.advance(100)
		assert.match(logText(t.logs.ciu), /上一会话还没收到 0x0281/)
		assert.ok(timers.size > 0)
		t.ciu.abort()
		assert.equal((await drive(t.clock, p, 300)).outcome, 'aborted')
		assert.equal(timers.size, 0)
		assert.equal(subs, 1)
		await t.clock.advance(30000)
		assert.equal(wakes(), w0, '取消后不发 WAKE')
		// 停止: 同样立即结束，并退订 CIU 级订阅（先做完一轮，让模组里有一个新的在途会话再进入硬等）
		assert.equal((await drive(t.clock, t.ciu.status())).ok, true)
		const w1 = wakes()
		const q = t.ciu.status()
		await t.clock.advance(100)
		assert.match(logText(t.logs.ciu.slice(-3)), /上一会话还没收到 0x0281/)
		assert.ok(timers.size > 0)
		t.ciu.stop()
		assert.equal((await drive(t.clock, q, 300)).outcome, 'aborted')
		assert.equal(timers.size, 0)
		assert.equal(subs, 0)
		await t.clock.advance(30000)
		assert.equal(wakes(), w1)
		t.meter.stop(); t.ciuLink.close(); t.meterLink.close()
	}
	// WOR_SEND 时机 = ACK 后: 等到 ACK 才入队
	{
		const t = setup({ ciu: { sendTiming: 'ack' } })
		await ready(t)
		const ok = await drive(t.clock, t.ciu.status())
		assert.equal(ok.ok, true, ok.message)
		assert.match(logText(t.logs.ciu), /WOR_SEND 已入待发槽 6B（ACK 后入队）/)
		assert.ok(ok.sessions[0].timeline.sendMs > ok.sessions[0].timeline.ackMs)
	}
	// 旧固件未 WOR_INIT 回 ERR_STATE(0x06): 表端照样识别并补 INIT
	{
		const t = setup({ world: { meterInit: false, notInitStatus: 6 } })
		await drive(t.clock, t.meter.start())
		assert.equal(t.world.meter.worInit, true)
		assert.equal(t.world.meter.sentry, true)
	}
	// 运行地址与 DRN 不一致（DRN 改了没复位）: 启动时提示
	{
		const t = setup()
		t.world.meter.addr = 5n
		await drive(t.clock, t.meter.start())
		assert.match(logText(t.logs.meter), /WOR 运行地址 5 与 DRN 101123456788 不一致/)
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

	// ---- 会话层: BUSY 重试 / 同一会话内多个 kind=3 依次入队 ----
	{
		const t = setup()
		await ready(t)
		const f = hex('38 12 34 56 78 03')
		const s1 = t.ciu.runSession(f)
		const s2 = t.ciu.runSession(f) // 上一会话未收尾: WAKE_CIU 回 BUSY，2s 重试
		const [r1, r2] = await drive(t.clock, Promise.all([s1, s2]))
		assert.equal(r1.ok, true)
		assert.equal(r2.ok, true)
		assert.match(logText(t.logs.ciu), /WOR_WAKE_CIU 回 BUSY/)
		assert.equal(r1.uplink.length, 14) // 表端对 TXN 未知的 STATUS 请求也按帧回 (TXN 为 8)
	}
	{
		const t = setup()
		await ready(t)
		t.world.injectKind3(hex('38 12 34 56 78 03'))
		await t.clock.advance(300)
		t.world.injectKind3(S.buildFrame({ dir: 0, type: S.TYPE.READ, txn: 3, meter: METER_NO, payload: S.readReqEncode(3, 1) }))
		await t.clock.advance(300)
		// 上行是追加队列: 两个应答按到达顺序各占一片，后一个不覆盖前一个
		assert.deepEqual(t.world.log.setUplinks.slice(-2).map(u => S.parseRaw(u.data).type), [S.TYPE.STATUS, S.TYPE.READ])
		assert.equal(t.world.meter.upq.length, 2)
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
		assert.deepEqual(bytes(r.payload.subarray(3)), [0, 3, 0, 0, 0, 1]) // MODE3 OVER 余额过多
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
		// 预算从受理上行到达时刻起算（不是收尾完成时刻）: rec.at 是收尾完成时刻，减去收尾耗时得到上行到达时刻
		const tl0 = res.sessions[0].timeline
		const accepted = res.sessions[0].at - (tl0.endMs - tl0.upMs)
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
				if (cmd === H.CMD.PROV_DEV_ID_GET) return Promise.resolve({ status: 0, payload: Uint8Array.of(2, ...H.u64Bytes(CIU_ADDR)) })
				if (cmd === H.CMD.WOR_INIT) return Promise.resolve({ status: 0 })
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
