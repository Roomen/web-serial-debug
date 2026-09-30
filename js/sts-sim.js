// STS 表端 / CIU 模拟引擎（不碰 DOM / localStorage / serialApi，只通过注入的 link 与 clock 工作）
// 两层协议: 模组指令层 hostProto（hostproto-transaction.js 的 link）+ 应用层 STS-CIU（sts-ciu-protocol.js）
//   - 表端: 收 EVT 0x0280 kind=3 -> 算应答 -> 立即 WOR_SET_UPLINK，赶在锚点 +6s 上行拍之前
//   - CIU : WOR_WAKE_CIU 受理后立即 WOR_SEND 一帧 -> 等 kind=2(ACK) -> 等 kind=4(上行)；一次问答 = 一次唤醒会话
// 受理不是成功: WAKE/SEND 回 OK 只是受理，TOKEN 处理状态 0 / WRITE 结果 0xFE 只是收下，终局靠 RESULT 轮询取回
// 置备（钥表、DRN、netId）由外部工具完成，这里不下发钥表、不接触主密钥，只核对，并在角色不对且填了 PAK 时定形
// clock 约定: { now() -> 毫秒时间戳, setTimeout(fn, ms) -> 句柄, clearTimeout(句柄) }
;(function () {
	'use strict'
	const W = window
	const S = W.stsCiu
	const H = W.hostProto

	const INT32_MAX = 2147483647
	const BUDGET_MS = 60000 // 应用层总等待上限，从收到受理应答起算，跨所有会话累计
	const POLL_FIRST_MS = 1000
	const POLL_DEFAULT_S = 2
	const POLL_MIN_S = 1
	const ARCHIVE_DEPTH = 4
	const DEDUP_DEPTH = 5
	const RECORDS = 12
	const VALVE_HOLD_MS = 10 * 60 * 1000
	const STS_BLOCK_MAX_CFG = 47 // 终局载荷最长 56 = 1 + 8 + M（状态 2），M 取 47 两种形态都装得下
	const DEFAULT_BLOCK = '03 80 80 80 00'

	// ===== 通用小工具 =====
	function toU8(b) { return b instanceof Uint8Array ? b : Uint8Array.from(b || []) }
	function hexSpaced(b) { return S.hexSpaced(toU8(b)) }
	function bytesEqual(a, b) { return S.equalBytes(toU8(a), toU8(b)) }
	function abortErr() { const e = new Error('已中止'); e.code = 'aborted'; return e }
	function digitsOnly(v, max) {
		const s = String(v == null ? '' : v).trim()
		return /^\d+$/.test(s) && s.length <= max ? s : null
	}
	// DRN（IEC 62055-41）: 13 位 = 4 位厂商码 + 8 位表号 + 1 位校验，11 位 = 2 位厂商码 + 8 位表号 + 1 位校验。
	// 模组唤醒地址用完整 DRN，应用层帧里的 8 位 BCD 表号取 DRN 中间那 8 位。
	// 模组里 DRN 是 u64 整数，厂商码的前导 0 会丢（0101…存进去只剩 12 位），所以不能按位数切：
	// 表号 = (DRN / 10) mod 10^8，11 位和 13 位格式都适用。8 位以内按台架短地址，直接补零当表号；
	// 正好 9 位分不清是哪种，报错，不截断，截断会把帧悄悄发给另一只表
	function drnToMeterNo(v) {
		const n = BigInt(v)
		if (n <= 0n) throw new Error('DRN 未设置')
		if (n < 100000000n) return n.toString().padStart(8, '0')
		if (n < 1000000000n) throw new Error('DRN ' + n + ' 是 9 位：标准 DRN 为 11 或 13 位（厂商码 + 8 位表号 + 校验位），台架短地址不超过 8 位')
		if (n >= 10000000000000n) throw new Error('DRN ' + n + ' 超过 13 位')
		return ((n / 10n) % 100000000n).toString().padStart(8, '0')
	}
	// Luhn 校验（含校验位整体算，从右往左，不受厂商码前导 0 影响），只用于提示；台架短地址不校验
	function drnCheckOk(v) {
		const n = BigInt(v)
		if (n < 1000000000n) return true
		const d = n.toString()
		let sum = 0
		for (let i = 0; i < d.length; i++) {
			let x = d.charCodeAt(d.length - 1 - i) - 48
			if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9 }
			sum += x
		}
		return sum % 10 === 0
	}
	function clampInt(v, lo, hi, dflt) {
		const n = Number(v)
		if (!Number.isFinite(n)) return dflt
		return Math.min(hi, Math.max(lo, Math.trunc(n)))
	}
	function be32(v) { return Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]) }
	function statusText(r) { return r.statusName + ' (0x' + r.status.toString(16).toUpperCase().padStart(2, '0') + ')' }

	// 运行代际守卫: stop() 递增代际后，所有在途/后续请求都以 aborted 结束，
	// 每个 await 返回后、发下一条命令之前都会检查，启动中途停止的引擎不会再发命令、订阅或置 running
	function guardLink(raw, isDead) {
		const dead = function () { if (isDead()) throw abortErr() }
		return {
			request: async function (cmd, payload, o) {
				dead()
				const r = await raw.request(cmd, payload, o)
				dead()
				return r
			},
			onEvt: function (cb) { dead(); return raw.onEvt(cb) },
		}
	}

	// 可整体中止的睡眠
	function makeWaiter(clock) {
		const active = new Set()
		return {
			sleep(ms) {
				return new Promise(function (resolve, reject) {
					const w = { t: null, reject: reject }
					w.t = clock.setTimeout(function () { active.delete(w); resolve() }, ms)
					active.add(w)
				})
			},
			abortAll() {
				active.forEach(function (w) { clock.clearTimeout(w.t); w.reject(abortErr()) })
				active.clear()
			},
		}
	}

	// ===== 配置规范化 =====
	const METER_DEFAULTS = {
		drn: '', pak: '', // drn 留空 = 以模组 DEV_ID_GET 回读值为准
		tokenDelayS: 6, tokenMode: 'exec', creditAmount: 500, stsBlockHex: DEFAULT_BLOCK, valveDelayS: 3,
		remaining: 5000, totalUsed: 12345, totalPurchased: 20000, batteryCv: 328, alarmCodes: '',
		tariffCurrency: false, tariffDec: 2, protoVersion: 2,
	}
	const CIU_DEFAULTS = {
		targetDrn: '', localAddr: '2', pak: '',
		ackTimeoutS: 15, upTimeoutS: 12, busyWaitS: 30, sessionRetries: 3,
	}
	function normalizeMeterConfig(c) {
		const o = Object.assign({}, METER_DEFAULTS, c || {})
		o.drn = o.drn === '' || o.drn == null ? '' : String(o.drn).trim()
		if (o.drn !== '') {
			if (!digitsOnly(o.drn, 13)) throw new Error('DRN 需为 13 位以内十进制')
			drnToMeterNo(o.drn)
			o.drn = BigInt(o.drn).toString()
		}
		o.pak = String(o.pak || '').replace(/\s+/g, '')
		o.tokenDelayS = clampInt(o.tokenDelayS, 0, 3600, 6)
		o.valveDelayS = clampInt(o.valveDelayS, 0, 600, 3)
		o.tokenMode = o.tokenMode === 'reject' ? 'reject' : 'exec'
		o.creditAmount = clampInt(o.creditAmount, 0, INT32_MAX, 500)
		o.remaining = clampInt(o.remaining, -INT32_MAX, INT32_MAX, 5000)
		o.totalUsed = clampInt(o.totalUsed, 0, 4294967295, 12345)
		o.totalPurchased = clampInt(o.totalPurchased, 0, 4294967295, 20000)
		o.batteryCv = clampInt(o.batteryCv, 0, 65535, 328)
		o.protoVersion = clampInt(o.protoVersion, 0, 255, 2) // 仅测试用: <2 时表体对 RESULT 回 NAK 0x01
		o.tariffCurrency = !!o.tariffCurrency
		o.tariffDec = o.tariffCurrency ? clampInt(o.tariffDec, 0, 9, 2) : 1 // 体积模式下小数位恒为 1
		const blk = S.hexToBytes(o.stsBlockHex)
		if (!blk || blk.length < 1 || blk.length > STS_BLOCK_MAX_CFG) throw new Error('STS 结果块需 1..' + STS_BLOCK_MAX_CFG + ' 字节 HEX')
		o.stsBlockHex = hexSpaced(blk)
		const codes = String(o.alarmCodes || '').split(/[\s,，;；]+/).filter(Boolean)
		if (codes.length > S.ALARM_MAX_CODES) throw new Error('告警码最多 27 个')
		codes.forEach(function (c2) { if (!/^\d{4}$/.test(c2)) throw new Error('告警码需 4 位十进制: ' + c2) })
		o.alarmList = codes
		return o
	}
	function normalizeCiuConfig(c) {
		const o = Object.assign({}, CIU_DEFAULTS, c || {})
		if (!digitsOnly(o.targetDrn, 13)) throw new Error('目标表 DRN 需为 13 位以内十进制')
		o.meterNo = drnToMeterNo(o.targetDrn)
		o.targetDrn = BigInt(o.targetDrn).toString()
		if (!digitsOnly(o.localAddr, 20)) throw new Error('本机地址需为十进制数字')
		o.localAddr = String(o.localAddr).trim()
		o.pak = String(o.pak || '').replace(/\s+/g, '')
		o.ackTimeoutS = clampInt(o.ackTimeoutS, 1, 600, 15)
		o.upTimeoutS = clampInt(o.upTimeoutS, 1, 600, 12)
		o.busyWaitS = clampInt(o.busyWaitS, 0, 600, 30)
		o.sessionRetries = clampInt(o.sessionRetries, 0, 20, 3)
		return o
	}

	// ==========================================================================
	// 模组公共步骤: 探活 / 固件 / 角色 / 置备角色定形（表端与 CIU 共用）
	// ==========================================================================
	function makeModule(link, clock, waiter, log) {
		const C = H.CMD
		function need(res, what) {
			if (res.status !== H.STATUS.OK) throw new Error(what + ' 失败: ' + statusText(res))
			return res
		}
		return {
			need: need,
			async echo() {
				let r
				try {
					r = await link.request(C.ECHO, Buffer_from('PING'), { timeoutMs: 1000, retries: 2 })
				} catch (e) {
					if (e && e.code === 'timeout') throw new Error('模组无应答：请检查串口、波特率 115200 8N1，以及是否被其他工具占用同一个串口')
					throw e
				}
				need(r, 'ECHO')
				if (!bytesEqual(r.payload, Buffer_from('PING'))) log('warn', 'ECHO 回显与发送内容不一致: ' + hexSpaced(r.payload))
			},
			async fwInfo() {
				const r = need(await link.request(C.FW_INFO, []), 'FW_INFO')
				const f = H.decodeFwInfo(r.payload)
				if (f) log('info', '固件: ' + f.board + ' app=' + f.appGit + (f.appDirty ? '+dirty' : '') + ' sdk=' + f.sdkGit + ' 构建 ' + f.buildTime)
				else log('warn', 'FW_INFO 结果长度异常: ' + r.payload.length)
				return f
			},
			async roleGet() {
				const r = need(await link.request(C.PROV_ROLE_GET, []), 'ROLE_GET')
				if (r.payload.length < 1) throw new Error('ROLE_GET 结果为空')
				return r.payload[0]
			},
			async devIdGet() {
				const r = need(await link.request(C.PROV_DEV_ID_GET, []), 'DEV_ID_GET')
				const d = H.decodeDevId(r.payload)
				if (!d) throw new Error('DEV_ID_GET 结果长度异常')
				return d
			},
			async ensureRole(want, pak) {
				return (await this.provision(want, null, pak, 0)).role
			},
			// 角色或 DRN 与期望不符时才动模组，而且要有 PAK: PROV_AUTH -> DEV_ID_SET（DRN 不符）-> ROLE_SET（角色不符）。
			// ROLE_SET 应答后模组自己复位；只改了 DRN 时补一次 REBOOT，METER 上电才会用新 DRN 值守。
			// ROLE_SET / REBOOT 都不得重试，发出后轮询 ECHO 等模组回来，再回读核对
			async provision(wantRole, wantDrn, pak, devType) {
				const role = await this.roleGet()
				log('info', '模组角色 = ' + role + ' ' + (H.ROLE_NAME[role] || '未知'))
				const dev = wantDrn == null ? null : await this.devIdGet()
				const needRole = role !== wantRole
				const needDrn = dev != null && dev.drn !== wantDrn
				if (!needRole && !needDrn) return { role: role, drn: dev ? dev.drn : null }
				const wantName = H.ROLE_NAME[wantRole]
				const pakBytes = S.hexToBytes(pak)
				if (!pak) {
					const why = []
					if (needRole) why.push('模组角色为 ' + (H.ROLE_NAME[role] || role) + '，需要 ' + wantName)
					if (needDrn) why.push('模组 DRN 为 ' + dev.drn + '，与配置的 ' + wantDrn + ' 不一致')
					throw new Error(why.join('；') + '。填写 PAK（32 位十六进制）后由模拟器写入，或用 keytool 置备' + (needDrn ? '，也可以把 DRN 留空以模组为准' : ''))
				}
				if (!pakBytes || pakBytes.length !== 16) throw new Error('PAK 需为 32 位十六进制（16 字节）')
				const a = await link.request(C.PROV_AUTH, pakBytes)
				if (a.status === H.STATUS.ERR_AUTH) throw new Error('PAK 校验失败（ERR_AUTH），模组未授权')
				need(a, 'PROV_AUTH')
				if (needDrn) {
					need(await link.request(C.PROV_DEV_ID_SET, H.devIdSetPayload(devType, wantDrn)), 'DEV_ID_SET')
					log('info', 'DRN 已写入模组: ' + dev.drn + ' -> ' + wantDrn)
				}
				if (needRole) {
					need(await link.request(C.PROV_ROLE_SET, [wantRole], { noRetry: true, timeoutMs: 2000 }), 'ROLE_SET')
					log('info', 'ROLE_SET [' + wantRole + '] 已应答，模组复位中，轮询 ECHO 等待重启（最多 35s，不重试）')
				} else {
					need(await link.request(C.REBOOT, [], { noRetry: true, timeoutMs: 2000 }), 'REBOOT')
					log('info', 'REBOOT 已应答，让新 DRN 在值守中生效，轮询 ECHO 等待重启（最多 35s，不重试）')
				}
				let back = false
				for (let i = 0; i < 35 && !back; i++) {
					await waiter.sleep(1000)
					try {
						const e = await link.request(C.ECHO, Buffer_from('PING'), { timeoutMs: 300, retries: 0 })
						back = e.status === H.STATUS.OK
					} catch (e) {
						if (e && e.code === 'aborted') throw e
					}
				}
				if (!back) throw new Error('模组复位后 35s 内没有回来')
				const again = await this.roleGet()
				if (again !== wantRole) throw new Error('复位后角色仍为 ' + again + '，期望 ' + wantRole)
				const dev2 = wantDrn == null ? null : await this.devIdGet()
				if (dev2 && dev2.drn !== wantDrn) throw new Error('复位后 DRN 为 ' + dev2.drn + '，期望 ' + wantDrn)
				log('info', '模组已定形: 角色 ' + wantName + (dev2 ? '，DRN ' + dev2.drn : ''))
				return { role: again, drn: dev2 ? dev2.drn : null }
			},
		}
	}
	function Buffer_from(str) { return Uint8Array.from(Array.from(str, function (c) { return c.charCodeAt(0) & 0xff })) }

	// ==========================================================================
	// 表体协议策略（照 sts_p_meter.c）: 接收判定 + 单待办槽 + 4 条存档 FIFO
	// ==========================================================================
	function createMeterPolicy(meterNo) {
		const meter = S.meterBcd(meterNo)
		const T = S.TYPE
		const st = { pending: null, arch: [], seq: 0 }

		function reply(req, payload) {
			// 表体必须原样回显请求的 TXN，并对称携带表号
			return S.buildFrame({ dir: S.DIR_RESPONSE, type: req.type, txn: req.txn, meter: meter, payload: payload })
		}
		function nakFrame(txn, reason, echo) {
			// NAK 走 TYPE 4，被拒的 TYPE 或寄存器 id 放在载荷里回显
			return S.buildFrame({ dir: S.DIR_RESPONSE, type: T.NAK, txn: txn, meter: meter, payload: S.nakEncode(reason, echo) })
		}
		function acceptPayload(req) {
			return req.type === T.TOKEN ? Uint8Array.from([S.TOKEN_ACCEPTED]) : S.writeRspEncode(req.reg, S.WRITE_ACCEPTED)
		}
		function archFind(tgt) { return st.arch.find(function (a) { return a.tgt === tgt }) || null }

		// 3.7 规则 2: 处理中的待办优先于已完成的存档
		function answerPoll(req, tgt) {
			let r
			if (st.pending && st.pending.tgt === tgt) {
				r = { pollState: S.POLL_WORKING, tgt: tgt, etaS: st.pending.etaS() }
			} else {
				const a = archFind(tgt)
				// 取走不清除: 保留期内可反复轮询，逐次返回逐字节相同的载荷
				r = a ? { pollState: S.POLL_DONE, tgt: tgt, tail: a.payload } : { pollState: S.POLL_UNKNOWN, tgt: tgt }
			}
			return reply(req, S.resultRspEncode(r))
		}

		return {
			state: st,
			reply: reply,
			// 返回 { act, ... }: discard / nak / dup / answered 已带完整应答帧，其余交给应用层决定载荷
			onFrame(bytes) {
				const g = S.meterGate(bytes, meter)
				if (!g.ok) {
					if (g.item === 9) return { act: 'nak', item: 9, rsp: nakFrame(g.txn, g.nak.reason, g.nak.echo) }
					return { act: 'discard', item: g.item, reason: g.reason }
				}
				const req = { type: g.type, txn: g.txn, tgt: S.tgtOf(g.type, g.txn) }
				const p = g.payload
				switch (g.type) {
					case T.READ: {
						const r = S.readReqDecode(p)
						if (r.error === 'length') return { act: 'discard', item: 7, reason: 'payload-length' }
						if (r.error === 'range') return { act: 'nak', rsp: nakFrame(g.txn, S.NAK.OUT_OF_RANGE, p[0]) }
						req.start = r.start
						req.count = r.count
						return { act: 'read', req: req }
					}
					case T.STATUS:
						return { act: 'status', req: req }
					case T.RESULT: {
						const r = S.resultReqDecode(p)
						if (!r) return { act: 'discard', item: 7, reason: 'payload-length' }
						return { act: 'answered', req: req, rsp: answerPoll(req, r.tgt) }
					}
					case T.TOKEN:
					case T.WRITE: {
						if (g.type === T.TOKEN) {
							const d = S.tokenReqDecode(p)
							if (d == null) return { act: 'discard', item: 7, reason: 'token-not-bcd' } // 不是 20 位合法 BCD: 丢弃
							req.digits = d
						} else {
							const w = S.writeReqDecode(p)
							req.reg = w.reg
							req.val = w.val
						}
						req.frame = g.raw
						if (st.pending) {
							if (S.equalBytes(st.pending.req, g.raw)) {
								// 逐字节相同: 回受理应答，不新建待办，不重复执行（纯通信层去重，与表端业务幂等是两回事）
								return { act: 'dup', req: req, rsp: reply(req, acceptPayload(req)) }
							}
							// 不同: NAK 0x06 表计忙，不产生任何副作用
							return { act: 'nak', req: req, rsp: nakFrame(g.txn, S.NAK.BUSY, g.type === T.TOKEN ? g.type : req.reg) }
						}
						return { act: g.type === T.TOKEN ? 'token' : 'write', req: req }
					}
					default:
						return { act: 'discard', item: 9, reason: 'unknown-type' }
				}
			},
			acceptFrame: function (req) { return reply(req, acceptPayload(req)) },
			// 受理新待办: 先作废同 TGT 的旧存档（否则会把上一笔的结果返给这一笔的轮询，且 CIU 侧每道校验都通过）
			pendingOpen(req, etaFn) {
				if (st.pending) return false
				const stale = archFind(req.tgt)
				if (stale) st.arch.splice(st.arch.indexOf(stale), 1)
				st.pending = { tgt: req.tgt, type: req.type, req: Uint8Array.from(req.frame), etaS: etaFn }
				return true
			},
			// 完成待办并存档终局载荷（容量 4，满了淘汰最旧的一条）
			pendingClose(payload) {
				if (!st.pending) return false
				const p = toU8(payload)
				if (p.length < 1 || p.length > S.FINAL_PAYLOAD_MAX) throw new Error('终局载荷长度非法: ' + p.length)
				if (st.arch.length >= ARCHIVE_DEPTH) {
					let oldest = 0
					for (let i = 1; i < st.arch.length; i++) if (st.arch[i].seq < st.arch[oldest].seq) oldest = i
					st.arch.splice(oldest, 1)
				}
				st.arch.push({ tgt: st.pending.tgt, type: st.pending.type, payload: Uint8Array.from(p), seq: ++st.seq })
				st.pending = null
				return true
			},
			reboot() { st.pending = null; st.arch = [] },
		}
	}

	// ==========================================================================
	// 表体应用（照 meter_app.c）: 寄存器表 / 令牌去重 / 充值记录 / 阀控测试
	// ==========================================================================
	function createMeterApp(cfg, clock) {
		const R = S.REG
		const E = S.ENC_TYPE
		const L = S.ENC_LEN
		const a = {
			remaining: cfg.remaining, totalUsed: cfg.totalUsed, totalPurchased: cfg.totalPurchased,
			batteryCv: cfg.batteryCv, alarms: cfg.alarmList.slice(),
			tariffCurrency: cfg.tariffCurrency, tariffDec: cfg.tariffDec,
			valve: S.VALVE_POS_OPEN, valveTestActive: false, valvePre: S.VALVE_POS_OPEN, valveRestoreAt: 0,
			records: Array.from({ length: RECORDS }, function () { return { empty: true, minutes: S.RECORD_EPOCH_UNSET, amount: 0 } }),
			recordCount: 0, dedup: [], dedupSeq: 0, work: null, unbound: 0, drn: cfg.drn || '0',
		}
		const epoch2020 = new Date(2020, 0, 1).getTime() // 表计本地时间，自 2020-01-01 00:00 起的分钟数
		function nowMin() { return Math.max(0, Math.floor((clock.now() - epoch2020) / 60000)) }
		function tariffByte() { return (a.tariffCurrency ? 0x80 : 0) | (a.tariffDec & 0x0f) }
		function meterStatusByte() {
			// 位域只放主界面持续点亮的少数几项；告警码列表非空时置 bit6，让 CIU 知道要多读一次 0x17
			let v = 0
			if (a.remaining < 100) v |= S.MST_LOW_CREDIT
			if (a.batteryCv < 300) v |= S.MST_LOW_BATTERY
			if (a.alarms.length) v |= S.MST_ALARM_LIST
			return v
		}
		function valveByte() { return a.valve | (a.valveTestActive ? S.VALVE_TEST_ACTIVE : 0) }
		function bcdDigits(str, bytes) { return S.bcdPack(String(str).padStart(bytes * 2, '0').slice(-bytes * 2)) }
		function timeBcd() {
			const d = new Date(clock.now())
			const p2 = function (n) { return String(n).padStart(2, '0') }
			return S.bcdPack(p2(d.getFullYear() % 100) + p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()))
		}

		// 一个寄存器 -> { enc, val }，未定义或当前不可读返回 null（块读里逐个标 0xFF，READ 永不因未知寄存器回 NAK）
		function regValue(id) {
			const d = a.tariffDec
			switch (id) {
				case R.TOTAL_USED: return { enc: 0x21, val: be32(a.totalUsed) } // 0x01/0x02 恒为体积
				case R.REVERSE_USED: return { enc: 0x21, val: be32(0) }
				case R.REMAINING: return { enc: S.makeEnc(E.I, L.L4, d), val: be32(a.remaining >>> 0) }
				case R.TOTAL_PURCHASED: return { enc: S.makeEnc(E.U, L.L4, d), val: be32(a.totalPurchased) }
				case R.OVERDRAFT_USED: return { enc: S.makeEnc(E.U, L.L4, d), val: be32(0) }
				case R.OVERDRAFT_MAX: return { enc: S.makeEnc(E.U, L.L4, d), val: be32(0) }
				case R.LOW_ALERT: return { enc: S.makeEnc(E.U, L.L4, d), val: be32(100) }
				case R.HOARD_LIMIT: return { enc: S.makeEnc(E.U, L.L4, d), val: be32(4000000) }
				case R.TIME: return { enc: 0xb0, val: timeBcd() }
				case R.VALVE: return { enc: 0xc0, val: Uint8Array.from([valveByte()]) }
				case R.METER_STATUS: return { enc: 0xc0, val: Uint8Array.from([meterStatusByte()]) }
				case R.BATTERY: return { enc: 0x12, val: Uint8Array.from([a.batteryCv >> 8, a.batteryCv & 0xff]) }
				case R.WATER_TEMP: return { enc: 0x51, val: Uint8Array.from([0x00, 0xc8]) } // 20.0 ℃
				case R.FLOW: return { enc: 0x63, val: be32(0) }
				case R.PAY_MODE: return { enc: 0x00, val: Uint8Array.from([1]) }
				case R.ALARM_LIST: return { enc: 0xf0, val: S.alarmListEncode(a.alarms) }
				case R.TARIFF: return { enc: 0x00, val: Uint8Array.from([tariffByte()]) }
				case R.RECORD_COUNT: return { enc: 0x00, val: Uint8Array.from([a.recordCount]) }
				case R.SGC: return { enc: 0xb0, val: bcdDigits('123456', 3) }
				case R.KRN: return { enc: 0x00, val: Uint8Array.from([1]) }
				case R.TI: return { enc: 0x00, val: Uint8Array.from([0]) }
				case R.EA: return { enc: 0x00, val: Uint8Array.from([7]) }
				case R.KEN: return { enc: 0x00, val: Uint8Array.from([255]) }
				case R.METER_NO: return { enc: 0xb0, val: S.meterBcd(drnToMeterNo(a.drn)) } // 表号取自 DRN
				case R.FW_VER: return { enc: 0xf0, val: Buffer_from('SIM-1.0') }
				case R.PROTO_VER: return { enc: 0x00, val: Uint8Array.from([cfg.protoVersion]) }
				case R.DRN: return { enc: 0xb0, val: bcdDigits(a.drn, 7) } // 13 位十进制，最高半字节补 0
				default: break
			}
			if (id >= R.RECORD_FIRST && id < R.RECORD_FIRST + RECORDS) {
				return { enc: 0xf0, val: S.recordEncode(a.records[id - R.RECORD_FIRST]) }
			}
			return null
		}

		function recordPush(amount, acceptedMin) {
			for (let i = RECORDS - 1; i > 0; i--) a.records[i] = a.records[i - 1]
			// 时间取受理时刻的表计 RTC，不是完成时刻（受理与落账之间隔着秒到几十秒）；禁止用令牌 TID 换算
			a.records[0] = { empty: false, minutes: acceptedMin, amount: amount }
			if (a.recordCount < RECORDS) a.recordCount++ // 满 12 条循环覆盖
		}

		// 令牌去重: 最近 5 笔，按深度不按时间窗口；重复输入回放上次存下的那个结果
		// 永久结果（认证失败、已成功落账等）replayable=true 原样回放；取决于当前余额/表计状态的失败
		// （余额越界这类）replayable=false，再输同一令牌时重新判定并更新该项
		function dedupStore(digits, payload, replayable) {
			const same = a.dedup.findIndex(function (d) { return d.digits === digits })
			if (same !== -1) a.dedup.splice(same, 1)
			if (a.dedup.length >= DEDUP_DEPTH) {
				let oldest = 0
				for (let i = 1; i < a.dedup.length; i++) if (a.dedup[i].seq < a.dedup[oldest].seq) oldest = i
				a.dedup.splice(oldest, 1)
			}
			a.dedup.push({ digits: digits, payload: Uint8Array.from(payload), replayable: replayable, seq: ++a.dedupSeq })
		}

		return {
			state: a,
			cfg: cfg,
			nowMin: nowMin,
			// 块读: 装不下只回能完整装下的前 k 个（k >= 1），绝不截断某一个 TLV
			readBlock(start, count) {
				const w = S.createTlvWriter()
				for (let i = 0; i < count; i++) {
					const id = start + i
					const v = regValue(id)
					if (!v) {
						if (w.putInvalid(id) !== 0) break
						continue
					}
					if (w.put(id, v.enc, v.val) !== 0) break // 定义了但装不下: 帧满了就收尾，CIU 从这里继续读
				}
				if (w.count === 0) w.putInvalid(start) // 表体必须保证 k >= 1，否则 CIU 会陷入不前进的续读循环
				return w.bytes()
			},
			statusPayload() {
				return S.statusRspEncode({ remaining: a.remaining, valve: valveByte(), meterStatus: meterStatusByte(), batteryCv: a.batteryCv })
			},
			token(digits) {
				const hit = a.dedup.find(function (d) { return d.digits === digits })
				// 表体能当场判定时允许跳过受理应答，直接回终局结果
				if (hit && hit.replayable) return { kind: 'final', payload: hit.payload, replay: true }
				a.work = { kind: 'token', digits: digits, acceptedMin: nowMin() }
				return { kind: 'pending', delayMs: cfg.tokenDelayS * 1000 }
			},
			write(reg, val) {
				if (reg === R.VALVE_TEST) {
					if (val.length !== 1) return { kind: 'nak', reason: S.NAK.BAD_LENGTH }
					if (val[0] > 1) return { kind: 'nak', reason: S.NAK.OUT_OF_RANGE }
					// 阀门动作是机械过程，先回 0xFE 再由轮询取终局
					a.work = { kind: 'valve', open: val[0] === 1 }
					return { kind: 'pending', delayMs: cfg.valveDelayS * 1000 }
				}
				if (reg === R.UNBIND) {
					if (val.length !== 0) return { kind: 'nak', reason: S.NAK.BAD_LENGTH }
					// 不触发物理动作的写当场给终局结果，不进入待办；先发完响应，再清除绑定
					a.unbound++
					return { kind: 'final', payload: S.writeRspEncode(reg, S.WRITE_OK), unbound: true }
				}
				// 0x03 说寄存器不存在，0x04 说存在但只读，两者不能混用: 直接问寄存器表
				return { kind: 'nak', reason: regValue(reg) ? S.NAK.NOT_WRITABLE : S.NAK.UNKNOWN_REG }
			},
			// 待办完成时调用: 执行排队的操作，返回终局载荷
			finishWork() {
				const w = a.work
				a.work = null
				if (!w) return null
				if (w.kind === 'token') {
					const block = S.hexToBytes(cfg.stsBlockHex)
					let rsp
					let replayable = true
					if (cfg.tokenMode === 'exec' && a.remaining + cfg.creditAmount <= INT32_MAX) {
						a.remaining += cfg.creditAmount
						a.totalPurchased = Math.min(4294967295, a.totalPurchased + cfg.creditAmount)
						recordPush(cfg.creditAmount, w.acceptedMin)
						rsp = { procStatus: S.TOKEN_DONE_EXEC, credited: cfg.creditAmount, remaining: a.remaining, stsBlock: block }
					} else {
						// 余额是 i32，充进来会越界: 终局失败，绝不回绕成负数
						const b = Uint8Array.from(block)
						if (cfg.tokenMode === 'exec') { b[0] = 0x05; replayable = false } // 取决于当前余额，用掉一些水后应当成功
						rsp = { procStatus: S.TOKEN_DONE_NOEXEC, stsBlock: b }
					}
					const payload = S.tokenRspEncode(rsp)
					dedupStore(w.digits, payload, replayable)
					return { kind: 'token', payload: payload, executed: rsp.procStatus === S.TOKEN_DONE_EXEC }
				}
				// 阀控测试带持久化状态，不是幂等操作
				if (a.valveTestActive) {
					// 保持期内再次收到: 不覆盖测试前状态、不重设恢复截止时刻，也不再次动作，只回当前结果
					return { kind: 'valve', payload: S.writeRspEncode(R.VALVE_TEST, S.WRITE_OK), repeated: true }
				}
				a.valvePre = a.valve
				a.valveRestoreAt = clock.now() + VALVE_HOLD_MS
				a.valveTestActive = true
				a.valve = w.open ? S.VALVE_POS_OPEN : S.VALVE_POS_CLOSED
				return { kind: 'valve', payload: S.writeRspEncode(R.VALVE_TEST, S.WRITE_OK), repeated: false }
			},
			// 保持到期恢复测试前状态
			tick() {
				if (a.valveTestActive && clock.now() >= a.valveRestoreAt) {
					a.valve = a.valvePre
					a.valveTestActive = false
					a.valveRestoreAt = 0
					return true
				}
				return false
			},
			// 重启立即恢复测试前状态并清除该对值，不续计时
			reboot() {
				a.work = null
				if (a.valveTestActive) {
					a.valve = a.valvePre
					a.valveTestActive = false
					a.valveRestoreAt = 0
				}
			},
			setDrn(v) { a.drn = String(v) },
			regValue: regValue,
		}
	}

	// ==========================================================================
	// 表端引擎
	// ==========================================================================
	function createMeterSim(opts) {
		const clock = opts.clock
		let gen = 0 // 运行代际，stop() 自增
		let runGen = 0
		const link = guardLink(opts.link, function () { return gen !== runGen })
		const cfg = normalizeMeterConfig(opts.config)
		const onLogCb = opts.onLog || function () {}
		const onStateCb = opts.onState || function () {}
		const waiter = makeWaiter(clock)
		const app = createMeterApp(cfg, clock)
		// 表号取自 DRN: 配置了 DRN 就先按配置建策略，留空则等启动时读到模组 DRN 再建
		let meterNo = cfg.drn ? drnToMeterNo(cfg.drn) : null
		let policy = meterNo ? createMeterPolicy(meterNo) : null
		let running = false
		let stopped = false
		let unsubEvt = null
		let workTimer = null
		let holdTimer = null
		let lastKind3At = 0
		const info = { role: null, drn: null, fw: null, lastSession: null, sessions: 0, startedAt: 0 }

		function log(level, text) { onLogCb({ at: clock.now(), level: level, text: text }) }
		const mod = makeModule(link, clock, waiter, log)
		const C = H.CMD

		function snapshot() {
			const a = app.state
			const p = policy ? policy.state.pending : null
			return {
				running: running, meterNo: meterNo, drn: info.drn, role: info.role,
				remaining: a.remaining, totalUsed: a.totalUsed, totalPurchased: a.totalPurchased,
				tariff: { currency: a.tariffCurrency, dec: a.tariffDec },
				valve: a.valve, valveTestActive: a.valveTestActive, valveRestoreAt: a.valveRestoreAt,
				batteryCv: a.batteryCv, alarms: a.alarms.slice(),
				records: a.records.map(function (r) { return { empty: r.empty, minutes: r.minutes, amount: r.amount } }),
				recordCount: a.recordCount,
				pending: p ? { tgt: p.tgt, type: S.TYPE_NAME[p.type], etaS: p.etaS() } : null,
				archive: (policy ? policy.state.arch : []).map(function (x) { return { tgt: x.tgt, type: S.TYPE_NAME[x.type], len: x.payload.length } }),
				dedupCount: a.dedup.length, unbound: a.unbound,
				lastSession: info.lastSession, sessions: info.sessions,
			}
		}
		function pushState() { try { onStateCb(snapshot()) } catch (e) { /* 界面回调异常不影响引擎 */ } }

		function armHold() {
			if (holdTimer != null) clock.clearTimeout(holdTimer)
			holdTimer = null
			const a = app.state
			if (!a.valveTestActive) return
			holdTimer = clock.setTimeout(function () {
				holdTimer = null
				if (app.tick()) { log('info', '阀控测试保持期到，阀门恢复测试前状态'); pushState() }
			}, Math.max(0, a.valveRestoreAt - clock.now()))
		}

		function finishWork() {
			workTimer = null
			const out = app.finishWork()
			if (!out) return
			try {
				policy.pendingClose(out.payload)
			} catch (e) {
				log('error', '待办存档失败: ' + e.message)
			}
			if (out.kind === 'token') log('info', '令牌处理完成: ' + (out.executed ? '已执行，余额 ' + app.state.remaining : '未执行') + '，终局结果已存档')
			else log('info', out.repeated ? '阀控测试保持期内重复写: 不覆盖测试前状态、不重设截止时刻，只回当前结果' : '阀控测试动作完成，保持 10 分钟后恢复')
			armHold()
			pushState()
		}
		function startWork(delayMs) {
			const doneAt = clock.now() + delayMs
			const etaFn = function () { return Math.min(254, Math.max(1, Math.ceil((doneAt - clock.now()) / 1000))) }
			if (workTimer != null) clock.clearTimeout(workTimer)
			workTimer = clock.setTimeout(finishWork, delayMs)
			return etaFn
		}

		// 表体收到一帧应用层请求 -> 应答帧（或静默丢弃返回 null）
		function handleApp(data) {
			if (!policy) { log('warn', 'DRN 尚未确定，丢弃应用帧'); return null }
			const g = policy.onFrame(data)
			switch (g.act) {
				case 'discard':
					log('warn', '应用帧静默丢弃（接收判定第 ' + g.item + ' 项: ' + g.reason + '）')
					return null
				case 'nak':
					log('info', '回 NAK: ' + hexSpaced(g.rsp))
					return g.rsp
				case 'dup':
					log('info', '逐字节相同的在飞请求: 再回一次受理，不重复执行')
					return g.rsp
				case 'answered':
					// 协议版本 < 2 的表体不支持 RESULT: 回 NAK 0x01，CIU 不得继续轮询
					if (cfg.protoVersion < 2) return policy.reply({ type: S.TYPE.NAK, txn: g.req.txn }, S.nakEncode(S.NAK.UNKNOWN_TYPE, S.TYPE.RESULT))
					return g.rsp
				case 'read':
					return policy.reply(g.req, app.readBlock(g.req.start, g.req.count))
				case 'status':
					return policy.reply(g.req, app.statusPayload())
				case 'token':
				case 'write': {
					const req = g.req
					const out = g.act === 'token' ? app.token(req.digits) : app.write(req.reg, req.val)
					if (out.kind === 'nak') {
						log('info', 'WRITE 拒绝: NAK 0x' + out.reason.toString(16).toUpperCase().padStart(2, '0') + ' ' + (S.NAK_NAME[out.reason] || ''))
						return policy.reply({ type: S.TYPE.NAK, txn: req.txn }, S.nakEncode(out.reason, req.reg))
					}
					if (out.kind === 'final') {
						log('info', out.replay ? '令牌命中去重，直接回放上次终局结果（不进待办）' : '当场终局')
						if (out.unbound) log('info', '断开绑定（模拟: 仅计数）')
						pushState()
						return policy.reply(req, out.payload)
					}
					// 受理: 先登记待办（这一步会作废同 TGT 的旧存档），再回受理应答
					const etaFn = startWork(out.delayMs)
					policy.pendingOpen(req, etaFn)
					log('info', '受理 ' + S.TYPE_NAME[req.type] + ' TGT=0x' + req.tgt.toString(16).toUpperCase() + '，' + Math.round(out.delayMs / 100) / 10 + 's 后终局')
					pushState()
					return policy.acceptFrame(req)
				}
				default:
					return null
			}
		}

		async function onDownlink(d, evtAt) {
			const tRecv = clock.now()
			const dt = lastKind3At ? tRecv - lastKind3At : 0
			if (lastKind3At && dt < 10000) {
				log('warn', '同一会话内连续收到多个 kind=3（相隔 ' + dt + 'ms）: 每个都处理，信箱以最后一个为准')
			}
			lastKind3At = tRecv
			info.sessions++
			log('info', '收到 kind=3 下行 ' + d.len + 'B: ' + hexSpaced(d.data))
			const reply = handleApp(d.data)
			if (!reply) { log('info', '无应答: 信箱不更新'); pushState(); return }
			const t1 = clock.now()
			try {
				const r = await link.request(C.WOR_SET_UPLINK, H.setUplinkPayload(reply), { timeoutMs: 1000, retries: 1 })
				const t2 = clock.now()
				if (r.status !== H.STATUS.OK) {
					log('error', 'WOR_SET_UPLINK 失败: ' + statusText(r))
				} else {
					log('info', 'SET_UPLINK OK，耗时 ' + (t2 - t1) + 'ms，自 kind=3 起 ' + (t2 - tRecv) + 'ms（须赶在锚点 +6s 前）: ' + hexSpaced(reply))
				}
				info.lastSession = { at: tRecv, replyBytes: reply.length, setUplinkMs: t2 - t1, sinceKind3Ms: t2 - tRecv, ok: r.status === H.STATUS.OK }
			} catch (e) {
				if (!(e && (e.code === 'aborted' || e.code === 'closed'))) log('error', 'WOR_SET_UPLINK 失败: ' + (e && e.message ? e.message : e))
			}
			pushState()
		}

		function onEvt(evt) {
			if (stopped) return
			if (evt.cmd !== H.EVT.WOR_FRAME) {
				log('info', 'EVT ' + (evt.name || '0x' + evt.cmd.toString(16)) + ' ' + hexSpaced(evt.payload))
				return
			}
			const d = H.decodeWorFrame(evt.payload)
			if (!d) { log('warn', 'EVT 0x0280 载荷长度异常: ' + evt.payload.length); return }
			if (d.kind === 3) {
				onDownlink(d, evt.at).catch(function (e) { log('error', 'kind=3 处理异常: ' + (e && e.message ? e.message : e)) })
			} else if (d.kind !== 5) { // kind=5 信标忽略
				log('info', 'EVT 0x0280 kind=' + d.kind + ' ' + (H.KIND_NAME[d.kind] || '') + ' src=' + d.src + ' ' + d.len + 'B')
			}
		}

		async function start() {
			if (running || stopped) throw new Error('引擎已启动或已停止')
			runGen = gen
			info.startedAt = clock.now()
			await mod.echo()
			info.fw = await mod.fwInfo()
			// DRN 留空时以模组回读值为准；填了就以面板为准，不一致时（有 PAK）写入模组
			const dev0 = await mod.devIdGet()
			const want = cfg.drn ? BigInt(cfg.drn) : dev0.drn
			if (!cfg.drn) log('info', '面板 DRN 留空，从模组读取: ' + dev0.drn)
			if (want === 0n) throw new Error('DRN 未设置：已从模组读取 DRN，结果为 0（模组还没置备 DRN）。在面板填写 DRN 并填写 PAK 由模拟器写入，或用 keytool 写入')
			drnToMeterNo(want)
			if (!drnCheckOk(want)) log('warn', 'DRN ' + want + ' 的校验位不符合 Luhn 规则，仍按此地址继续')
			const pv = await mod.provision(1, want, cfg.pak, 1)
			const dev = { drn: pv.drn }
			info.role = pv.role
			info.drn = dev.drn.toString()
			if (!policy || meterNo !== drnToMeterNo(dev.drn)) {
				meterNo = drnToMeterNo(dev.drn)
				policy = createMeterPolicy(meterNo)
			}
			app.setDrn(info.drn)
			log('info', 'DRN = ' + info.drn + '，应用层表号 = ' + meterNo)

			// 稳态应为 [1 SENTRY][1 GRID]；未 WOR_INIT 时补 INIT + SENTRY_START
			let ws = await link.request(C.WOR_GET_STATUS, [])
			if (ws.status === H.STATUS.ERR_STATE) {
				log('info', 'WOR 未初始化，补 WOR_INIT(SENTRY, addr=DRN) + SENTRY_START')
				const i = await link.request(C.WOR_INIT, H.woInitPayload(1, dev.drn))
				if (i.status !== H.STATUS.OK && i.status !== H.STATUS.ERR_BUSY) throw new Error('WOR_INIT 失败: ' + statusText(i))
				const s = await link.request(C.WOR_SENTRY_START, [])
				if (s.status !== H.STATUS.OK && s.status !== H.STATUS.ERR_BUSY) throw new Error('SENTRY_START 失败: ' + statusText(s))
				ws = await link.request(C.WOR_GET_STATUS, [])
			}
			mod.need(ws, 'WOR_GET_STATUS')
			const wst = H.decodeWorStatus(ws.payload)
			if (wst && wst.role === 1 && wst.state === 1) log('info', 'WOR 稳态 [1 SENTRY][1 GRID]')
			else log('warn', 'WOR 状态不是 [1 SENTRY][1 GRID]: ' + (wst ? '[' + wst.role + '][' + wst.state + ']' : '结果异常'))

			// 预置 1 字节占位信箱: CIU 按长度门 <6 静默丢弃，绝不会被当成应答
			mod.need(await link.request(C.WOR_SET_UPLINK, H.setUplinkPayload([0x00])), 'WOR_SET_UPLINK(占位)')
			if (gen !== runGen || stopped) throw abortErr()
			unsubEvt = link.onEvt(onEvt)
			running = true
			log('info', '表端模拟运行中：DRN ' + info.drn + '，表号 ' + meterNo)
			pushState()
			return snapshot()
		}

		function stop() {
			if (stopped) return
			stopped = true
			gen++
			running = false
			if (unsubEvt) { unsubEvt(); unsubEvt = null }
			if (workTimer != null) { clock.clearTimeout(workTimer); workTimer = null }
			if (holdTimer != null) { clock.clearTimeout(holdTimer); holdTimer = null }
			waiter.abortAll() // 不给模组发任何复位类命令
			log('info', '表端模拟已停止')
			pushState()
		}

		return {
			start: start,
			stop: stop,
			getState: snapshot,
			handleApp: handleApp, // 直接喂应用帧（测试与诊断用）
			// 模拟表体重启: 清空待办与存档（去重记录视作已随余额落盘），阀控测试立即恢复
			simulateReboot() {
				if (workTimer != null) { clock.clearTimeout(workTimer); workTimer = null }
				if (policy) policy.reboot()
				app.reboot()
				if (holdTimer != null) { clock.clearTimeout(holdTimer); holdTimer = null }
				log('warn', '模拟表体重启: 待办与存档已清空')
				pushState()
			},
			app: app,
			get policy() { return policy },
		}
	}

	// ==========================================================================
	// CIU 协议策略（照 sts_p_ciu.c）: 在飞事务 / 单待办 / 预算 / 恢复只一次
	// ==========================================================================
	function createCiuPolicy(meterNo) {
		const meter = S.meterBcd(meterNo)
		const T = S.TYPE
		const st = { txnNext: 0, inflight: null, pending: null }

		function takeTxn() { const t = st.txnNext & 0x0f; st.txnNext = (st.txnNext + 1) & 0x0f; return t }
		function pendingClear() { st.pending = null }
		function sendFrame(type, payload) {
			// 同一时刻只允许一笔事务在飞；放行第二笔的代价不是报错而是静默卡死
			if (st.inflight) throw busyErr('已有事务在飞')
			const txn = takeTxn()
			const f = S.buildFrame({ dir: S.DIR_REQUEST, type: type, txn: txn, meter: meter, payload: payload })
			st.inflight = { type: type, txn: txn }
			return { frame: f, txn: txn }
		}
		function busyErr(m) { const e = new Error(m); e.code = 'busy'; return e }
		function pendingOpen(type, txn, frame) {
			// 预算不在这里起算: 从收到受理应答的那一刻起算，被直接拒绝的请求根本不会成为待办
			st.pending = { tgt: S.tgtOf(type, txn), req: Uint8Array.from(frame), armed: false, armedAt: 0, recovered: false }
		}
		function fillToken(ev, payload) {
			ev.type = T.TOKEN
			const t = S.tokenRspDecode(payload)
			if (!t) { ev.kind = 'discard'; ev.reason = 'payload-length'; return }
			ev.token = t
			ev.kind = t.known && t.procStatus === S.TOKEN_ACCEPTED ? 'accepted' : 'final'
		}
		function fillWrite(ev, payload) {
			ev.type = T.WRITE
			const w = S.writeRspDecode(payload)
			if (!w) { ev.kind = 'discard'; ev.reason = 'payload-length'; return }
			ev.write = w
			ev.kind = w.result === S.WRITE_ACCEPTED ? 'accepted' : 'final' // 0x00..0x07 与 RFU 值都终结（规则 8）
		}
		function arm(now) {
			if (st.pending && !st.pending.armed) { st.pending.armed = true; st.pending.armedAt = now }
		}

		return {
			state: st,
			sendToken(digits) {
				if (st.pending) throw busyErr('已有待办未终结') // 3.7 规则 1
				const r = sendFrame(T.TOKEN, S.tokenReqEncode(digits))
				pendingOpen(T.TOKEN, r.txn, r.frame)
				return r.frame
			},
			sendWrite(reg, val) {
				if (st.pending) throw busyErr('已有待办未终结')
				const r = sendFrame(T.WRITE, S.writeReqEncode(reg, val))
				pendingOpen(T.WRITE, r.txn, r.frame)
				return r.frame
			},
			// 即答类可以穿插在待办之间，各自用自己的 TXN
			sendRead(start, count) { return sendFrame(T.READ, S.readReqEncode(start, count)).frame },
			sendStatus() { return sendFrame(T.STATUS, []).frame },
			sendPoll() {
				if (!st.pending) throw new Error('没有待办可轮询') // RESULT 从不投机发送
				return sendFrame(T.RESULT, S.resultReqEncode(st.pending.tgt)).frame
			},
			// 总预算: 起算时刻 + armed 标志，不存 deadline
			budgetExpired(now) {
				if (!st.pending || !st.pending.armed) return false
				return now - st.pending.armedAt >= BUDGET_MS
			},
			budgetLeft(now) {
				if (!st.pending || !st.pending.armed) return null
				return Math.max(0, BUDGET_MS - (now - st.pending.armedAt))
			},
			// 放弃时同时丢掉在飞的轮询，否则下一笔请求会被永远拒绝
			abandon() { pendingClear(); st.inflight = null },
			// 链路层报告这笔发不出去: 只释放在飞槽，已受理的待办仍可继续轮询
			dropInflight() { st.inflight = null },
			hasPending() { return !!st.pending },
			// 句柄未知的恢复: 用新 TXN 重发原请求载荷（TXN 每笔递增），句柄随之移动；预算不重新起算，至多一次
			// 重发帧与原帧不是逐字节相同（TXN 变了），表体的通信层去重对不上，恢复完全靠表端的令牌级幂等
			recover() {
				const p = st.pending
				if (!p) return { ok: false, reason: '没有待办' }
				if (p.recovered) return { ok: false, reason: '本笔待办已恢复过一次' }
				const type = S.tgtType(p.tgt)
				const payload = p.req.slice(5, p.req.length - 1)
				if (type === T.WRITE && payload.length >= 1 && payload[0] === S.REG.UNBIND) {
					return { ok: false, reason: '断开绑定成功后链路可能已断，无从确认，不重发；请重新绑定' }
				}
				if (st.inflight) return { ok: false, reason: '已有事务在飞' }
				const r = sendFrame(type, payload)
				p.tgt = S.tgtOf(type, r.txn)
				p.req = Uint8Array.from(r.frame)
				p.recovered = true
				return { ok: true, frame: r.frame }
			},
			// 只跑接收判定第 1..8 项、不改任何状态: 会话层据此让不属于本轮的上行不占唯一的上行槽
			accepts(bytes) {
				return S.ciuGate(bytes, { meter: meter, inflight: st.inflight, pendingTgt: st.pending ? st.pending.tgt : null }).ok
			},
			// 完整接收路径: 判定第 1..8 项 + 结果解释。CIU 永不发 NAK，前八项一律静默丢弃
			onFrame(bytes, now) {
				// 静默丢弃不得改任何事务状态: 在飞槽先存下，返回 discard 时原样恢复
				// （待办只在非丢弃路径上才会被改），这样截断的 READ 之后，同 TXN 的完整应答仍能被接纳
				const saved = st.inflight
				const ev = this._frame(bytes, now)
				if (ev.kind === 'discard') st.inflight = saved
				return ev
			},
			_frame(bytes, now) {
				const g = S.ciuGate(bytes, { meter: meter, inflight: st.inflight, pendingTgt: st.pending ? st.pending.tgt : null })
				if (!g.ok) return { kind: 'discard', item: g.item, reason: g.reason }
				const ev = { kind: 'discard', type: g.type }
				const rejected = st.inflight.type
				st.inflight = null
				const p = g.payload
				if (g.type === T.NAK) {
					const n = S.nakDecode(p)
					ev.kind = 'nak'
					ev.nak = n
					ev.rejectedType = rejected
					// 只有对待办类请求或轮询的 NAK 才清待办: 穿插的即答类被 NAK 说明不了待办怎么样了
					if (rejected === T.TOKEN || rejected === T.WRITE || rejected === T.RESULT) pendingClear()
					return ev
				}
				switch (g.type) {
					case T.TOKEN:
						fillToken(ev, p)
						if (ev.kind === 'accepted') arm(now)
						else if (ev.kind === 'final') pendingClear() // 表体当场判定，这条路径没有受理应答
						return ev
					case T.WRITE:
						fillWrite(ev, p)
						if (ev.kind === 'accepted') arm(now)
						else if (ev.kind === 'final') pendingClear()
						return ev
					case T.READ: {
						// 第 7 项对变长载荷只校下界，TLV 结构完整性在这里检查一次：半截 TLV 不能当终局结果交上去
						const r = S.tlvParse(p)
						if (!r.ok) return { kind: 'discard', item: 7, reason: 'tlv-truncated' }
						ev.kind = 'final'
						ev.read = r.tlvs
						return ev
					}
					case T.STATUS:
						ev.kind = 'final'
						ev.status = S.statusRspDecode(p)
						return ev
					case T.RESULT: {
						const r = S.resultRspDecode(p)
						if (!r) return { kind: 'discard', item: 7, reason: 'payload-length' }
						const ptype = S.tgtType(st.pending.tgt)
						ev.type = ptype
						switch (r.pollState) {
							case S.POLL_UNKNOWN:
								ev.kind = 'handle-unknown' // 待办槽保留，由上层决定是否恢复
								return ev
							case S.POLL_WORKING: {
								ev.kind = 'working'
								const eta = r.etaS === S.ETA_UNKNOWN ? POLL_DEFAULT_S : r.etaS
								ev.pollInMs = Math.max(POLL_MIN_S, eta) * 1000 // 节奏由表体驱动，只保留下限
								return ev
							}
							case S.POLL_DONE:
								if (ptype === T.TOKEN) fillToken(ev, r.tail)
								else fillWrite(ev, r.tail)
								ev.type = ptype
								// 规则 9: 状态 2 表示这一轮问答成功、待办已终结，尾部解不出来或是受理值都是「结果本身不可用」，
								// 不是「还在处理」——继续轮询只会反复拿到同一个结果
								if (ev.kind === 'discard' || ev.kind === 'accepted') {
									ev.kind = 'final'
									ev.rawTail = Uint8Array.from(r.tail)
									ev.token = ev.token || (ptype === T.TOKEN ? { procStatus: r.tail[0], known: false } : undefined)
									ev.write = ev.write || (ptype === T.WRITE ? { reg: r.tail[0], result: r.tail[1] } : undefined)
								}
								pendingClear()
								return ev
							default:
								// 规则 7: 未知轮询状态按处理中继续，尾部整段忽略，间隔 2s
								ev.kind = 'working'
								ev.pollInMs = POLL_DEFAULT_S * 1000
								return ev
						}
					}
					default:
						return { kind: 'discard', item: 6, reason: 'type' }
				}
			},
		}
	}

	// ==========================================================================
	// CIU 引擎
	// ==========================================================================
	function createCiuSim(opts) {
		const clock = opts.clock
		let gen = 0
		let runGen = 0
		const link = guardLink(opts.link, function () { return gen !== runGen })
		const cfg = normalizeCiuConfig(opts.config)
		const onLogCb = opts.onLog || function () {}
		const onStateCb = opts.onState || function () {}
		const waiter = makeWaiter(clock)
		const policy = createCiuPolicy(cfg.meterNo)
		const target = BigInt(cfg.targetDrn)
		const C = H.CMD
		let running = false
		let stopped = false
		let busyOp = null
		let aborted = false
		const sessionWaiters = new Set() // 正在等 ACK / 上行的等待者，中止时要能立刻叫醒
		const st = {
			phase: 'idle', op: null, tariff: null, protoVersion: null, pollAllowed: true,
			lastResult: null, sessionCount: 0, lastTimeline: null, budgetLeftMs: null, role: null, fw: null,
		}

		function log(level, text) { onLogCb({ at: clock.now(), level: level, text: text }) }
		const mod = makeModule(link, clock, waiter, log)
		function snapshot() {
			return {
				running: running, phase: st.phase, op: st.op, tariff: st.tariff, protoVersion: st.protoVersion,
				pollAllowed: st.pollAllowed, lastResult: st.lastResult, sessionCount: st.sessionCount,
				lastTimeline: st.lastTimeline, budgetLeftMs: policy.budgetLeft(clock.now()), role: st.role,
				pending: policy.hasPending(),
			}
		}
		function setPhase(p) { st.phase = p; try { onStateCb(snapshot()) } catch (e) { /* 界面回调异常不影响引擎 */ } }
		function checkAborted() { if (aborted || stopped) throw abortErr() }

		// ---------- 会话层 ----------
		// 一次应用层问答 = 一次唤醒会话: WAKE_CIU 受理后立即 WOR_SEND，等 ACK(kind=2) 再等上行(kind=4)
		async function runSession(appFrame, accepts) {
			const frame = toU8(appFrame)
			const t0 = clock.now()
			const tl = { wakeMs: null, sendMs: null, ackMs: null, upMs: null }
			const fail = function (reason, stage) { return { ok: false, uplink: null, timeline: tl, reason: reason, stage: stage } }
			if (frame.length < 1 || frame.length > 64) return fail('应用帧超过 64 字节', 'send')
			// open: 只有 WAKE_CIU 请求在飞或已受理期间收到的事件才算本轮；BUSY 等待期间到达的旧 kind=2/4 只记日志
			const sess = { ack: null, up: null, open: false }
			const waiters = []
			const notify = function () { waiters.slice().forEach(function (w) { w.check() }) }
			const unsub = link.onEvt(function (evt) {
				if (evt.cmd !== H.EVT.WOR_FRAME) return
				const d = H.decodeWorFrame(evt.payload)
				if (!d) return
				if (d.src !== target) { log('info', '忽略其他来源的 EVT src=' + d.src + ' kind=' + d.kind); return }
				if (!sess.open) { log('info', '本轮 WAKE 尚未受理时收到 kind=' + d.kind + '，属于上一会话，不占本轮接收槽'); return }
				if (d.kind === 2 && !sess.ack) {
					sess.ack = { at: clock.now() }
					log('info', 'ACK (kind=2)，相对 WAKE 请求 ' + (sess.ack.at - t0) + 'ms')
				} else if (d.kind === 4) {
					// WAKE 请求在飞期间仍可能收到上一会话的迟到上行: 过不了接收判定的不占本轮唯一的上行槽，继续等本轮的
					if (accepts && !accepts(d.data)) {
						log('warn', '上行 (kind=4) 未通过接收判定，不属于本轮请求，继续等本轮上行: ' + hexSpaced(d.data))
						return
					}
					// EVT 尽力而为，ACK 事件可能被模组丢掉而上行照常到达
					if (!sess.ack) {
						sess.ack = { at: clock.now(), implied: true }
						log('warn', '收到 kind=4 时本会话还没见到 ACK 事件，按 ACK 已到处理')
					}
					if (!sess.up) {
						sess.up = { at: clock.now(), data: d.data }
						log('info', '上行 (kind=4) ' + d.len + 'B，相对 WAKE 请求 ' + (sess.up.at - t0) + 'ms: ' + hexSpaced(d.data))
					}
				}
				notify()
			})
			// 等待条件成立或超时；中止时抛 aborted
			const waitCond = function (cond, timeoutMs) {
				return new Promise(function (resolve, reject) {
					if (cond()) { resolve(true); return }
					const w = { check: function () { if (cond()) done(true) } }
					const timer = clock.setTimeout(function () { done(false) }, timeoutMs)
					function done(v) {
						clock.clearTimeout(timer)
						const i = waiters.indexOf(w)
						if (i !== -1) waiters.splice(i, 1)
						sessionWaiters.delete(w)
						if (aborted || stopped) reject(abortErr())
						else resolve(v)
					}
					w.abort = function () { done(false) }
					waiters.push(w)
					sessionWaiters.add(w)
				})
			}
			// 待办轮询阶段（已收到受理）60s 总预算约束这里所有在途等待；即答类返回 null 不受约束
			const budgetLeft = function () { return policy.budgetLeft(clock.now()) }
			const cap = function (ms) { const l = budgetLeft(); return l == null ? ms : Math.min(ms, l) }
			const budgetOut = function () { return budgetLeft() === 0 }
			// 模组请求连同事务层重发也不能越过预算: 单次超时与重发次数按剩余预算收紧
			const reqOpt = function () {
				const l = budgetLeft()
				if (l == null) return { timeoutMs: 1000 }
				const t = Math.max(1, Math.min(1000, l))
				return { timeoutMs: t, retries: Math.max(0, Math.min(2, Math.floor(l / t) - 1)) }
			}
			try {
				// 1. WAKE_CIU
				const busyDeadline = clock.now() + cfg.busyWaitS * 1000
				let tWake
				for (;;) {
					checkAborted()
					if (budgetOut()) return fail('总等待预算 60s 已用完', 'budget')
					tWake = clock.now()
					sess.ack = null; sess.up = null; sess.open = true
					const r = await link.request(C.WOR_WAKE_CIU, H.wakePayload(target, 2), reqOpt())
					if (r.status === H.STATUS.OK) break
					sess.open = false
					if (r.status === H.STATUS.ERR_BUSY) {
						if (clock.now() + 2000 > busyDeadline) return fail('模组仍在上一次会话中（BUSY），等待超过 ' + cfg.busyWaitS + 's', 'wake')
						log('info', 'WOR_WAKE_CIU 回 BUSY（上一会话未收尾），2s 后重试')
						await waiter.sleep(Math.max(1, cap(2000)))
						continue
					}
					if (r.status === H.STATUS.ERR_ROLE) return fail('模组角色不是 CIU（ERR_ROLE）', 'wake')
					if (r.status === H.STATUS.ERR_STATE) return fail('WorLink 未初始化（ERR_STATE），请重新启动模拟', 'wake')
					if (r.status === H.STATUS.ERR_AUTH) return fail('模组缺少 ciu 键面密钥（ERR_AUTH），请用 keytool 装配钥表', 'wake')
					return fail('WOR_WAKE_CIU 失败: ' + statusText(r), 'wake')
				}
				const tAcc = clock.now()
				tl.wakeMs = tAcc - tWake
				log('info', 'WOR_WAKE_CIU 已受理（受理不是成功），耗时 ' + tl.wakeMs + 'ms')
				// 2. 受理后立即 WOR_SEND；槽满(BUSY)等一拍再补
				const ackDeadline = tAcc + cfg.ackTimeoutS * 1000
				for (;;) {
					checkAborted()
					if (budgetOut()) return fail('总等待预算 60s 已用完', 'budget')
					const r = await link.request(C.WOR_SEND, H.sendPayload(frame), reqOpt())
					if (r.status === H.STATUS.OK) break
					if (r.status === H.STATUS.ERR_BUSY) {
						if (clock.now() >= ackDeadline) return fail('WOR_SEND 一直 BUSY（槽满）', 'send')
						await waiter.sleep(Math.max(1, cap(1000)))
						continue
					}
					return fail('WOR_SEND 失败: ' + statusText(r), 'send')
				}
				tl.sendMs = clock.now() - t0
				log('info', 'WOR_SEND 已入待发槽 ' + frame.length + 'B: ' + hexSpaced(frame))
				// 3. 等 ACK
				const ackOk = await waitCond(function () { return !!sess.ack }, cap(Math.max(0, ackDeadline - clock.now())))
				if (!ackOk) return fail(budgetOut() ? '总等待预算 60s 已用完' : '等 ACK 超时（' + cfg.ackTimeoutS + 's）', budgetOut() ? 'budget' : 'ack')
				tl.ackMs = sess.ack.at - t0
				// 4. 等上行，从 ACK 起算
				const upOk = await waitCond(function () { return !!sess.up }, cap(Math.max(0, sess.ack.at + cfg.upTimeoutS * 1000 - clock.now())))
				if (!upOk) return fail(budgetOut() ? '总等待预算 60s 已用完' : '等上行超时（ACK 后 ' + cfg.upTimeoutS + 's）', budgetOut() ? 'budget' : 'uplink')
				tl.upMs = sess.up.at - t0
				return { ok: true, uplink: sess.up.data, timeline: tl, reason: '' }
			} catch (e) {
				if (e && e.code === 'aborted') throw e
				return fail(e && e.message ? e.message : String(e), 'link')
			} finally {
				unsub()
				waiters.slice().forEach(function (w) { w.abort() })
			}
		}

		function fmtTimeline(tl) {
			return ['wake', 'send', 'ack', 'up'].map(function (k) { return k + '=' + (tl[k + 'Ms'] == null ? '-' : tl[k + 'Ms'] + 'ms') }).join(' ')
		}

		// ---------- 应用层单次问答: 会话失败或上行被静默丢弃 -> 重新 runSession 同一字节帧 ----------
		async function exchange(frame, label, sessions) {
			const maxAttempts = 1 + cfg.sessionRetries
			let lastReason = ''
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				checkAborted()
				if (policy.budgetExpired(clock.now())) return { kind: 'budget' }
				setPhase('session')
				st.sessionCount++
				const s = await runSession(frame, function (b) { return policy.accepts(b) })
				const rec = { label: label, attempt: attempt, ok: false, reason: '', timeline: s.timeline, at: clock.now() }
				sessions.push(rec)
				st.lastTimeline = rec
				if (!s.ok) {
					rec.reason = s.reason
					lastReason = s.reason
					if (policy.budgetExpired(clock.now())) { rec.reason = s.reason; return { kind: 'budget' } }
					log('warn', label + ' 第 ' + attempt + '/' + maxAttempts + ' 次会话失败: ' + s.reason + '（' + fmtTimeline(s.timeline) + '）')
					if (attempt < maxAttempts) log('info', '重新唤醒并重发逐字节相同的应用帧（同 TXN）')
					continue
				}
				// 已超预算的晚到终局不得报成功: 交给应用层判定之前再查一次
				if (policy.budgetExpired(clock.now())) { rec.reason = '上行到达时已超过 60s 总预算'; return { kind: 'budget' } }
				const ev = policy.onFrame(s.uplink, clock.now())
				if (ev.kind === 'discard') {
					rec.reason = '上行被接收判定静默丢弃（第 ' + ev.item + ' 项: ' + ev.reason + '）'
					lastReason = rec.reason
					log('warn', label + ' 第 ' + attempt + '/' + maxAttempts + ' 次: ' + rec.reason + ': ' + hexSpaced(s.uplink))
					continue
				}
				rec.ok = true
				log('info', label + ' 会话成功（' + fmtTimeline(s.timeline) + '）')
				return { kind: 'event', ev: ev }
			}
			policy.dropInflight()
			return { kind: 'failed', reason: lastReason || '会话失败' }
		}

		function fmtQty(v) {
			const t = st.tariff
			if (!t) return String(v)
			return t.currency ? S.fmtScaled(v, t.dec) + '（货币单位，d=' + t.dec + '）' : S.fmtScaled(v, t.dec) + ' L'
		}
		function newResult(op) {
			return { op: op, ok: false, outcome: 'failed', message: '', sessions: [], startedAt: clock.now(), durationMs: 0 }
		}
		function finalize(res) {
			res.durationMs = clock.now() - res.startedAt
			res.ok = res.outcome === 'done'
			st.lastResult = res
			setPhase('idle')
			return res
		}

		// 把终局事件翻成对外结果
		function applyFinal(res, ev) {
			if (ev.kind === 'nak') {
				res.outcome = 'nak'
				res.nak = { reason: ev.nak.reason, echo: ev.nak.echo, text: S.NAK_NAME[ev.nak.reason] || '未知' }
				res.message = '表体拒绝（NAK 0x' + ev.nak.reason.toString(16).toUpperCase().padStart(2, '0') + ' ' + res.nak.text + '，回显 0x' + ev.nak.echo.toString(16).toUpperCase().padStart(2, '0') + '）'
				if (ev.rejectedType === S.TYPE.RESULT && ev.nak.reason === S.NAK.UNKNOWN_TYPE) res.message += '：表体不支持 RESULT 轮询（协议版本 < 2），不再继续轮询'
				return
			}
			switch (ev.type) {
				case S.TYPE.TOKEN: {
					const t = ev.token
					res.token = { procStatus: t.procStatus, known: t.known }
					if (!t.known) {
						res.outcome = 'failed'
						res.message = '未知的 TOKEN 处理状态 0x' + t.procStatus.toString(16).toUpperCase().padStart(2, '0') + '，按失败结束' + (ev.rawTail ? '，原始尾部 ' + hexSpaced(ev.rawTail) : '')
						return
					}
					res.outcome = 'done'
					res.token.stsBlockHex = t.stsBlock ? hexSpaced(t.stsBlock) : ''
					if (t.procStatus === S.TOKEN_DONE_EXEC) {
						res.token.executed = true
						res.token.credited = t.credited
						res.token.remaining = t.remaining
						res.token.creditedText = fmtQty(t.credited)
						res.token.remainingText = fmtQty(t.remaining)
						res.message = '令牌已执行：充值 ' + res.token.creditedText + '，剩余 ' + res.token.remainingText
					} else {
						res.token.executed = false
						res.message = '令牌未执行（STS 结果块原样透传，含义由表体定义）'
					}
					return
				}
				case S.TYPE.WRITE: {
					const w = ev.write
					res.write = { reg: w.reg, result: w.result }
					if (w.result === S.WRITE_OK) { res.outcome = 'done'; res.message = 'WRITE 0x' + w.reg.toString(16).toUpperCase() + ' 成功' }
					else {
						res.outcome = 'failed'
						res.message = 'WRITE 0x' + w.reg.toString(16).toUpperCase() + ' 结果 0x' + w.result.toString(16).toUpperCase().padStart(2, '0') + (S.NAK_NAME[w.result] ? '（' + S.NAK_NAME[w.result] + '）' : '（未知结果，按失败）')
					}
					return
				}
				case S.TYPE.STATUS: {
					const s = ev.status
					res.outcome = 'done'
					res.status = {
						remaining: s.remaining, remainingText: fmtQty(s.remaining), valve: s.valve, valveText: S.valveText(s.valve),
						meterStatus: s.meterStatus, meterStatusText: S.meterStatusText(s.meterStatus),
						batteryCv: s.batteryCv, batteryText: S.fmtScaled(s.batteryCv, 2) + ' V', alarmListNonEmpty: !!(s.meterStatus & S.MST_ALARM_LIST),
					}
					res.message = '剩余 ' + res.status.remainingText + '，阀门' + res.status.valveText + '，电池 ' + res.status.batteryText
					return
				}
				case S.TYPE.READ:
					res.outcome = 'done'
					res.read = ev.read
					return
				default:
					res.outcome = 'failed'
					res.message = '未预期的终局类型'
			}
		}

		// ---------- 待办类: 受理后轮询 ----------
		async function driveRequest(res, frame, label) {
			const first = await exchange(frame, label, res.sessions)
			if (first.kind === 'failed') {
				policy.abandon()
				res.outcome = 'failed'
				res.message = label + ' 会话多次失败（' + first.reason + '）；表体可能已收到，请先查询状态'
				return
			}
			if (first.kind === 'budget') { budgetGiveUp(res); return }
			let ev = first.ev
			for (;;) {
				checkAborted()
				if (ev.kind === 'nak' || ev.kind === 'final') { applyFinal(res, ev); return }
				let nextAt
				if (ev.kind === 'accepted') {
					// 受理不是成功: 转入轮询，首次延迟 1s
					log('info', label + ' 已受理（只是收下），1s 后轮询终局结果；总预算 60s 已起算')
					nextAt = clock.now() + POLL_FIRST_MS
				} else if (ev.kind === 'working') {
					log('info', '表体处理中，' + ev.pollInMs / 1000 + 's 后再问')
					nextAt = clock.now() + ev.pollInMs
				} else if (ev.kind === 'handle-unknown') {
					const rc = policy.recover()
					if (!rc.ok) {
						policy.abandon()
						res.outcome = 'failed'
						res.message = '轮询状态 0（句柄未知）：' + rc.reason
						return
					}
					log('warn', '轮询状态 0（句柄未知或已过期）: 重发原请求（新 TXN，沿用原预算，至多一次）')
					const rr = await exchange(rc.frame, label + '(恢复)', res.sessions)
					if (rr.kind === 'failed') { policy.abandon(); res.outcome = 'failed'; res.message = label + ' 恢复重发的会话多次失败（' + rr.reason + '）'; return }
					if (rr.kind === 'budget') { budgetGiveUp(res); return }
					ev = rr.ev
					if (ev.kind === 'accepted') ev.kind = 'accepted-recovered'
					continue
				} else if (ev.kind === 'accepted-recovered') {
					nextAt = clock.now() + POLL_FIRST_MS
				} else {
					policy.abandon()
					res.outcome = 'failed'
					res.message = '内部状态异常: ' + ev.kind
					return
				}
				// 等到下次轮询时刻；预算到期就放弃
				for (;;) {
					checkAborted()
					if (policy.budgetExpired(clock.now())) { budgetGiveUp(res); return }
					const left = nextAt - clock.now()
					if (left <= 0) break
					setPhase('wait-poll')
					const budgetLeft = policy.budgetLeft(clock.now())
					await waiter.sleep(Math.min(left, budgetLeft == null ? left : Math.max(1, budgetLeft), 1000))
				}
				if (policy.budgetExpired(clock.now())) { budgetGiveUp(res); return }
				let pf
				try { pf = policy.sendPoll() } catch (e) { policy.abandon(); res.outcome = 'failed'; res.message = e.message; return }
				const pr = await exchange(pf, 'RESULT 轮询', res.sessions)
				if (pr.kind === 'failed') { policy.abandon(); res.outcome = 'failed'; res.message = 'RESULT 轮询会话多次失败（' + pr.reason + '）；表体并不因此停止执行'; return }
				if (pr.kind === 'budget') { budgetGiveUp(res); return }
				ev = pr.ev
			}
		}
		function budgetGiveUp(res) {
			policy.abandon()
			res.outcome = 'timeout'
			res.message = '超过 60s 总等待预算，已放弃并清空待办槽。表体并不因此停止执行——放弃只代表不再等，不代表操作被取消，请稍后查询状态'
			log('warn', res.message)
		}

		// ---------- 即答类 ----------
		async function driveImmediate(res, frame, label) {
			const r = await exchange(frame, label, res.sessions)
			if (r.kind === 'failed') {
				policy.dropInflight()
				res.outcome = 'failed'
				res.message = label + ' 会话多次失败（' + r.reason + '）'
				return null
			}
			if (r.kind === 'budget') { budgetGiveUp(res); return null }
			return r.ev
		}

		async function runOp(op, fn) {
			if (!running) throw new Error('CIU 模拟未运行')
			if (busyOp) throw new Error('已有操作在进行: ' + busyOp)
			busyOp = op
			aborted = false
			st.op = op
			const res = newResult(op)
			try {
				await fn(res)
			} catch (e) {
				if (e && e.code === 'aborted') {
					res.outcome = 'aborted'
					res.message = '已中止'
					policy.abandon()
				} else if (e && e.code === 'busy') {
					res.outcome = 'failed'
					res.message = e.message
				} else {
					res.outcome = 'failed'
					res.message = e && e.message ? e.message : String(e)
					policy.abandon()
				}
			} finally {
				busyOp = null
				st.op = null
			}
			return finalize(res)
		}

		// READ 块读: 表体装不下会只回前 k 个，按实收数量继续请求剩余部分
		async function readTlvs(res, start, count, label) {
			const all = []
			let s = start
			let left = count
			while (left > 0) {
				const n = Math.min(left, S.READ_MAX_REGS)
				const ev = await driveImmediate(res, policy.sendRead(s, n), label)
				if (!ev) return null
				if (ev.kind === 'nak') { applyFinal(res, ev); return null }
				if (ev.kind !== 'final' || !ev.read) { res.outcome = 'failed'; res.message = label + ' 得到意外事件 ' + ev.kind; return null }
				const got = ev.read.length
				if (got < 1) { res.outcome = 'failed'; res.message = label + ' 响应没有任何 TLV'; return null }
				ev.read.forEach(function (t) { all.push(t) })
				s += got
				left -= got
				if (got < n) log('info', 'READ 只回了前 ' + got + '/' + n + ' 个，继续读剩余部分')
			}
			return all
		}
		function renderTlv(t) {
			return { id: t.id, name: S.regName(t.id), text: S.tlvValueText(t), invalid: !!t.invalid, raw: t.val ? hexSpaced(t.val) : '' }
		}
		function tlvU8(tlvs, id) {
			const t = tlvs.find(function (x) { return x.id === id })
			if (!t || t.invalid || !t.val || t.val.length !== 1) return null
			return t.val[0]
		}

		// ---------- 启动 ----------
		async function start() {
			if (running || stopped) throw new Error('引擎已启动或已停止')
			runGen = gen
			await mod.echo()
			st.fw = await mod.fwInfo()
			st.role = await mod.ensureRole(2, cfg.pak)
			const i = await link.request(C.WOR_INIT, H.woInitPayload(2, BigInt(cfg.localAddr)))
			if (i.status === H.STATUS.ERR_BUSY) log('info', 'WOR_INIT 回 BUSY: 已初始化，跳过')
			else mod.need(i, 'WOR_INIT')
			if (gen !== runGen || stopped) throw abortErr()
			running = true
			log('info', 'CIU 模拟就绪：本机地址 ' + cfg.localAddr + '，目标 DRN ' + cfg.targetDrn + '，应用层表号 ' + cfg.meterNo)
			if (!drnCheckOk(cfg.targetDrn)) log('warn', '目标 DRN ' + cfg.targetDrn + ' 的校验位不符合 Luhn 规则，仍按此地址唤醒')
			setPhase('idle')
			// 连接后读一次 0x18 计价模式与 0x27 协议版本（每次读都是一次唤醒会话，需要几秒到几十秒）
			try {
				await refreshBasics()
			} catch (e) {
				if (e && e.code === 'aborted') throw e
				log('warn', '读取基本信息失败: ' + (e && e.message ? e.message : e))
			}
			// refreshBasics 经 runOp 把中止转成了普通结果，这里补查一次，启动中途停止必须以 aborted 拒绝
			if (gen !== runGen || stopped) throw abortErr()
			return snapshot()
		}
		async function refreshBasics() {
			return runOp('basics', async function (res) {
				res.message = '读取计价模式与协议版本'
				for (const id of [S.REG.TARIFF, S.REG.PROTO_VER]) {
					const tl = await readTlvs(res, id, 1, '读 0x' + id.toString(16).toUpperCase())
					if (!tl) return
					const v = tlvU8(tl, id)
					if (id === S.REG.TARIFF && v != null) {
						st.tariff = { currency: !!(v & 0x80), dec: v & 0x0f }
						log('info', '计价模式: ' + (st.tariff.currency ? '金额' : '体积') + '，小数位 d=' + st.tariff.dec)
					}
					if (id === S.REG.PROTO_VER && v != null) {
						st.protoVersion = v
						st.pollAllowed = v >= 2
						log(v >= 2 ? 'info' : 'warn', '表体协议版本 = ' + v + (v >= 2 ? '' : '（< 2，不支持 RESULT 轮询，待办类操作已禁用）'))
					}
				}
				res.outcome = 'done'
				res.message = '计价模式与协议版本已读取'
			})
		}

		function guardPoll(res) {
			if (st.pollAllowed) return true
			res.outcome = 'unsupported'
			res.message = '表体协议版本 < 2，不支持 RESULT 轮询，待办类操作已禁用'
			return false
		}

		return {
			start: start,
			stop: function () {
				if (stopped) return
				stopped = true
				gen++
				running = false
				aborted = true
				waiter.abortAll()
				sessionWaiters.forEach(function (w) { w.abort() })
				log('info', 'CIU 模拟已停止')
				setPhase('idle')
			},
			abort: function () {
				aborted = true
				waiter.abortAll()
				sessionWaiters.forEach(function (w) { w.abort() })
			},
			getState: snapshot,
			runSession: runSession,
			refreshBasics: refreshBasics,
			token(digits) {
				return runOp('token', async function (res) {
					const d = String(digits || '')
					if (!/^\d{20}$/.test(d)) { res.message = '令牌需 20 位数字，不足位数在本地提示，不上线'; return }
					if (!guardPoll(res)) return
					await driveRequest(res, policy.sendToken(d), 'TOKEN')
				})
			},
			status() {
				return runOp('status', async function (res) {
					const ev = await driveImmediate(res, policy.sendStatus(), 'STATUS')
					if (!ev) return
					if (ev.kind === 'nak' || ev.kind === 'final') applyFinal(res, ev)
					else { res.outcome = 'failed'; res.message = 'STATUS 得到意外事件 ' + ev.kind }
					// 表计状态 bit6 置位: 再读一次 0x17 取告警码全集
					if (res.outcome === 'done' && res.status && res.status.alarmListNonEmpty) {
						const tl = await readTlvs(res, S.REG.ALARM_LIST, 1, '读告警码列表 0x17')
						if (tl) {
							const t = tl[0]
							res.status.alarms = t && !t.invalid ? S.alarmListDecode(t.val) : null
							res.message += '；告警码 ' + (res.status.alarms ? res.status.alarms.join(' ') : '(无法解析)')
						}
					}
				})
			},
			read(start, count) {
				return runOp('read', async function (res) {
					if (!(count >= 1 && start >= 0 && start + count - 1 <= 0xff)) { res.message = 'READ 参数非法'; return }
					const tl = await readTlvs(res, start, count, 'READ 0x' + start.toString(16).toUpperCase())
					if (!tl) return
					res.outcome = 'done'
					res.read = tl.map(renderTlv)
					res.message = '读到 ' + tl.length + ' 个寄存器'
				})
			},
			// 充值记录: 先读 0x19 条数，再按 5 个一批读 0x30..
			records() {
				return runOp('records', async function (res) {
					const c = await readTlvs(res, S.REG.RECORD_COUNT, 1, '读记录条数 0x19')
					if (!c) return
					const n = tlvU8(c, S.REG.RECORD_COUNT)
					if (n == null) { res.message = '记录条数寄存器不可读'; return }
					const recs = []
					if (n > 0) {
						const tl = await readTlvs(res, S.REG.RECORD_FIRST, n, '读充值记录')
						if (!tl) return
						tl.forEach(function (t, i) {
							const r = t.invalid ? null : S.recordDecode(t.val)
							recs.push({ index: i + 1, empty: !r || r.empty, timeText: !r || r.empty ? '' : (r.rtcUnset ? '受理时刻未知(RTC 未校准)' : S.recordTimeStr(r.minutes)), amount: r ? r.amount : 0, amountText: r && !r.empty ? fmtQty(r.amount) : '' })
						})
					}
					res.outcome = 'done'
					res.records = recs
					res.message = '共 ' + n + ' 条充值记录'
				})
			},
			write(reg, value) {
				return runOp('write', async function (res) {
					if (!guardPoll(res)) return
					const val = value == null ? [] : [value]
					await driveRequest(res, policy.sendWrite(reg, val), 'WRITE 0x' + reg.toString(16).toUpperCase())
				})
			},
			valveTest(open) { return this.write(S.REG.VALVE_TEST, open ? 1 : 0) },
			unbind() { return this.write(S.REG.UNBIND, null) },
		}
	}

	W.stsSim = {
		createMeterSim: createMeterSim,
		createCiuSim: createCiuSim,
		createMeterPolicy: createMeterPolicy,
		createMeterApp: createMeterApp,
		createCiuPolicy: createCiuPolicy,
		normalizeMeterConfig: normalizeMeterConfig,
		normalizeCiuConfig: normalizeCiuConfig,
		drnToMeterNo: drnToMeterNo,
		drnCheckOk: drnCheckOk,
		METER_DEFAULTS: METER_DEFAULTS,
		CIU_DEFAULTS: CIU_DEFAULTS,
		BUDGET_MS: BUDGET_MS,
	}
})()
