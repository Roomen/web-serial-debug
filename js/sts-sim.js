// STS 表端 / CIU 模拟引擎（不碰 DOM / localStorage / serialApi，只通过注入的 link 与 clock 工作）
// 两层协议: 模组指令层 hostProto（hostproto-transaction.js 的 link）+ 应用层 STS-CIU（sts-ciu-protocol.js）
// 会话是停等 ARQ: 锚点 +1s 起每 1.2s 一拍，发起端发一帧（数据 / 0B 征求 / END），表端拍 +600ms 回 DACK 并捎带上行队列队头一片；
// 下行排空后进入轮询相（0B 征求拍持续，表端有上行即捎带），会话由表端 END 或模组空闲看门狗（最后一次活动后约 8s）自行收尾，终结经 EVT 0x0281 通知双侧
//   - 表端: 被唤醒时模组清空上行队列并发 kind=2 通知；收 kind=3 -> 算应答 -> WOR_SET_UPLINK 追加入队，下一个 DACK 捎带
//   - CIU : 启动时 WOR_GET_STATUS，未初始化才 WOR_INIT(2, 本机 DRN)；每次会话 WOR_WAKE_CIU -> WOR_SEND 一帧（槽满 BUSY 隔 1.4s 重发）-> 等 kind=2(ACK) -> 等 kind=4(上行) -> 立即返回；
//           WAKE 回未初始化（模组中途复位）才补一次 WOR_INIT 再 WAKE；
//           不发 FINISH / ABORT，成败都不再碰会话，下一轮 WAKE 前硬等上一会话的 0x0281（有上限）再冷却；一次应用层问答 = 一次唤醒会话
//           运行期两端都不查 WOR_GET_STATUS / 统计，不做会话保活
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
	// 令牌结果模式: exec = 执行充值（状态 2 + MODE1）；1..13 / 255 = 状态 1 + MODE3 对应结果码；test = 状态 1 + MODE256 位图
	const TOKEN_MODES = ['exec', 'test'].concat(Object.keys(S.STS_CODE))
	const BEAT_MS = 1200 // 停等栅格一拍；表端上行队列满等一拍再补
	const SEND_BUSY_RETRY_MS = 1400 // WOR_SEND 槽满（模组 FIFO 深度 4）回 BUSY 后隔这么久重发同一帧，实板观测值
	const SESSION_COOLDOWN_MS = 1200 // CIU 终结后表端仍在 linger；实板表端约晚 1s 回 GRID，留一拍再唤醒
	const UPQ_RETRY = 4 // 上行队列满（BUSY）时的补发次数，超过就放弃，CIU 会按会话重发同一帧
	// 上一会话 0x0281 的硬等上限，从上一次 runSession 返回起算: 会话不再被主动结束，由模组空闲看门狗约 8s 后自行收尾
	// （实板 reason=8），加上收尾与事件延迟留余量；到点仍没等到就照常冷却后 WAKE，BUSY 重试兜底
	const PREV_END_WAIT_MS = 15000

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
	// 模组外层 DRN 用小端 BCD，解码为 BigInt 后厂商码的前导 0 会丢（0101…只剩 12 位），所以不能按位数切：
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
	// 未 WOR_INIT: 新固件回 ERR_NOT_INIT(0x09)，旧固件与「无会话」共用 ERR_STATE(0x06)，两个都认
	function notInit(r) { return r.status === H.STATUS.ERR_NOT_INIT || r.status === H.STATUS.ERR_STATE }
	function endText(e) { return 'reason=' + e.reason + ' ' + (H.END_REASON_NAME[e.reason] || '未知') + '，下行交付 ' + e.dlDelivered + '，上行交付 ' + e.upDelivered }

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
		tokenDelayS: 6, tokenMode: 'exec', creditAmount: 500, creditLimit: 0, testBits: '00000001', valveDelayS: 30,
		remaining: 5000, totalUsed: 12345, totalPurchased: 20000, batteryCv: 368, alarmCodes: '',
		tariffCurrency: false, tariffDec: 2, protoVersion: 2,
	}
	const CIU_DEFAULTS = {
		targetDrn: '', pak: '',
		ackTimeoutS: 15, upTimeoutS: 12, busyWaitS: 30, sessionRetries: 3, sendTiming: 'accept',
	}
	// 按产品错误码对照表预置，码表不在协议内枚举；CIU 原样送显，不认识的码走「其他码」输入。
	// 顺序即显示优先级（从高到低），组包进寄存器 0x17 的告警码列表时保持这个顺序
	const ALARM_PRESETS = [
		['0801', '低电告警（通讯电池，二级 10%）'], ['0803', '低电量告警（一级 20%）'], ['0802', '计量电池低电异常'],
		['1301', '空管告警'], ['1302', '换能器异常'], ['1401', '逆流告警'], ['1403', '漏水告警'], ['1405', '爆管告警'],
		['9601', '拆表告警'], ['9701', '水温高告警'], ['9702', '水温低告警'],
		['0701', '开阀超时'], ['0702', '关阀超时'], ['0703', '阀门堵转'], ['0704', '阀门开度异常'],
		['1201', '通信模块异常'], ['0301', 'Flash 存储异常'], ['0105', 'RTC 时钟异常'], ['5401', '剩余水量不足告警'],
	].map(function (x) { return { code: x[0], label: x[1] } })
	// 预置码按表内顺序在前，其他码（4 位十进制，空格分隔）追加在后
	function composeAlarmCodes(checked, otherText) {
		// 勾选和其他码合并去重后：已知预置码统一按 ALARM_PRESETS 顺序排前面（即使写在其他码框里），未知码按输入顺序在后
		const all = []
		;(checked || []).concat(String(otherText || '').split(/[\s,，;；]+/).filter(Boolean)).forEach(function (c) { if (all.indexOf(c) === -1) all.push(c) })
		const known = ALARM_PRESETS.map(function (p) { return p.code }).filter(function (c) { return all.indexOf(c) !== -1 })
		return known.concat(all.filter(function (c) { return known.indexOf(c) === -1 })).join(' ')
	}
	function splitAlarmCodes(text) {
		const list = String(text || '').split(/[\s,，;；]+/).filter(Boolean)
		const known = ALARM_PRESETS.map(function (p) { return p.code })
		return { checked: list.filter(function (c) { return known.indexOf(c) !== -1 }), other: list.filter(function (c) { return known.indexOf(c) === -1 }).join(' ') }
	}
	// 可在运行中修改的四个量值 + 告警码，配置与 setLive 共用这一套校验
	function normalizeLiveFields(o) {
		o.remaining = clampInt(o.remaining, -INT32_MAX, INT32_MAX, 5000)
		o.totalUsed = clampInt(o.totalUsed, 0, 4294967295, 12345)
		o.totalPurchased = clampInt(o.totalPurchased, 0, 4294967295, 20000)
		o.batteryCv = clampInt(o.batteryCv, 0, 65535, 368)
		const raw = Array.isArray(o.alarmCodes) ? o.alarmCodes.join(' ') : String(o.alarmCodes || '')
		const codes = []
		raw.split(/[\s,，;；]+/).filter(Boolean).forEach(function (c2) {
			if (!/^\d{4}$/.test(c2)) throw new Error('告警码需 4 位十进制: ' + c2)
			if (codes.indexOf(c2) === -1) codes.push(c2)
		})
		if (codes.length > S.ALARM_MAX_CODES) throw new Error('告警码最多 27 个')
		o.alarmCodes = codes.join(' ')
		o.alarmList = codes
		return o
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
		o.valveDelayS = clampInt(o.valveDelayS, 0, 600, 30)
		o.tokenMode = String(o.tokenMode)
		if (o.tokenMode === 'reject') o.tokenMode = '255' // 旧配置的「拒收」对应 REJECT
		if (TOKEN_MODES.indexOf(o.tokenMode) === -1) o.tokenMode = 'exec'
		const bits = String(o.testBits == null ? '' : o.testBits).replace(/^0x/i, '').trim()
		if (!/^[0-9a-fA-F]{1,8}$/.test(bits)) throw new Error('测试位图需为 1..8 位十六进制')
		o.testBits = bits.toUpperCase().padStart(8, '0')
		o.creditAmount = clampInt(o.creditAmount, 0, INT32_MAX, 500)
		o.creditLimit = clampInt(o.creditLimit, 0, INT32_MAX, 0) // 余额上限，0 = 只受 i32 限制
		normalizeLiveFields(o)
		o.protoVersion = clampInt(o.protoVersion, 0, 255, 2) // 仅测试用: <2 时表体对 RESULT 回 NAK 0x01
		o.tariffCurrency = !!o.tariffCurrency
		o.tariffDec = o.tariffCurrency ? clampInt(o.tariffDec, 0, 9, 2) : 1 // 体积模式下小数位恒为 1
		return o
	}
	function normalizeCiuConfig(c) {
		const o = Object.assign({}, CIU_DEFAULTS, c || {})
		if (!digitsOnly(o.targetDrn, 13)) throw new Error('目标表 DRN 需为 13 位以内十进制')
		o.meterNo = drnToMeterNo(o.targetDrn)
		o.targetDrn = BigInt(o.targetDrn).toString()
		delete o.localAddr // 仅回读运行地址，不采用旧配置
		o.pak = String(o.pak || '').replace(/\s+/g, '')
		o.ackTimeoutS = clampInt(o.ackTimeoutS, 1, 600, 15)
		o.upTimeoutS = clampInt(o.upTimeoutS, 1, 600, 12)
		o.busyWaitS = clampInt(o.busyWaitS, 0, 600, 30)
		o.sessionRetries = clampInt(o.sessionRetries, 0, 20, 3)
		o.sendTiming = o.sendTiming === 'ack' ? 'ack' : 'accept'
		delete o.keepAliveMs // 已移除的旧配置项，旧存档里可能还有
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
			notInit: notInit,
			async echo() {
				let r
				try {
					r = await link.request(C.ECHO, Buffer_from('PING'), { timeoutMs: 1000, retries: 2 })
				} catch (e) {
					if (e && e.code === 'timeout') {
						const error = new Error('模组无应答：请检查串口、波特率 115200 8N1，以及是否被其他工具占用同一个串口')
						error.code = 'timeout'
						throw error
					}
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
			valve: S.VALVE_POS_OPEN, valveFault: false, valveMoving: null, valveHold: null, valveWorkPending: false, valveSeq: 0, restoredPre: null,
			records: Array.from({ length: RECORDS }, function () { return { empty: true, minutes: S.RECORD_EPOCH_UNSET, amount: 0 } }),
			recordCount: 0, dedup: [], dedupSeq: 0, work: null, unbound: 0, drn: cfg.drn || '0',
			// 模拟令牌的表端状态: 已用过的令牌（超出去重深度后再输按 USED）、后付费、换钥进行到第几步
			simUsed: new Set(), postpaid: false, keyStep: 0,
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
			if (a.postpaid) v |= S.MST_POSTPAID
			return v
		}
		// 动作中位置报 00 不明；bit2 在动作中和关阀保持期内都置位（表示阀控测试进行中）
		function reportedValve() { return a.valveMoving ? 0 : a.valve }
		function valveByte() { return reportedValve() | ((a.valveMoving || a.valveHold) ? S.VALVE_TEST_ACTIVE : 0) | (a.valveFault ? S.VALVE_FAULT : 0) }
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

		// 模拟令牌（明文测试格式）: 按类型给出 STS 结果块并执行对应的表端动作。
		// 同一令牌在去重深度内再输由去重回放上次结果（协议 2.1，保证句柄恢复重发不重复执行）；
		// 超出深度后再输，按 STS 的 TID 防重放给 USED
		// 充值后余额超出上限（配置的余额上限，未配置时为 i32 上限）: 终局 OVER
		function overLimit(amount) { return a.remaining + amount > (cfg.creditLimit || INT32_MAX) }
		function overNote() { return '充值后余额超出' + (cfg.creditLimit ? '余额上限 ' + S.qtyRawText(cfg.creditLimit, tariffOf()) : ' i32 上限') + '，OVER' }
		function tariffOf() { return { currency: a.tariffCurrency, dec: a.tariffDec } }
		function finishSimToken(w) {
			const I = S.STS_IDX
			const m = S.simTokenDecode(w.digits)
			const code = function (v) { return { procStatus: S.TOKEN_DONE_NOEXEC, stsBlock: S.stsResultEncode({ index: I.CODE, value: v }) } }
			let rsp
			let replayable = true
			let executed = false
			let action = null
			let note = ''
			let consumed = true // 成功受理的令牌记为已用；指定结果码与失败结果不占用
			if (!m.valid) { rsp = code(255); consumed = false; note = '模拟令牌' + m.reason + '，按 REJECT' }
			else if (a.simUsed.has(w.digits)) { rsp = code(3); consumed = false; note = '模拟令牌已用过，按 USED' }
			else {
				switch (m.type) {
					case '01': {
						const credit = S.simTokenCredit(m, tariffOf()) // 体积: 0.1 m³ → dL
						if (overLimit(credit)) { rsp = code(1); replayable = false; consumed = false; note = overNote(); break }
						a.remaining += credit
						a.totalPurchased = Math.min(4294967295, a.totalPurchased + credit)
						recordPush(credit, w.acceptedMin)
						rsp = { procStatus: S.TOKEN_DONE_EXEC, credited: credit, remaining: a.remaining, stsBlock: S.stsResultEncode({ index: I.CREDIT, value: credit }) }
						executed = true
						break
					}
					case '02': a.remaining = 0; rsp = code(8); note = '余额已清零'; break
					case '03': a.postpaid = false; rsp = code(9); note = '切换为预付费'; break
					case '04': a.postpaid = true; rsp = code(10); note = '切换为后付费（表计状态 bit5）'; break
					case '05': action = 'open'; rsp = code(11); break
					case '06': action = 'closed'; rsp = code(12); break
					case '07': rsp = code(13); note = '清除窃水状态'; break
					case '08': rsp = code(7); break
					case '10': a.keyStep = 1; rsp = code(4); note = '换钥第一步，等第二枚'; break
					case '11': rsp = code(a.keyStep === 1 ? 7 : 5); note = a.keyStep === 1 ? '两枚换钥令牌齐全，换钥完成（SUCCESS）' : '单独第二枚，2ND'; a.keyStep = 0; break
					case '20': rsp = { procStatus: S.TOKEN_DONE_NOEXEC, stsBlock: S.stsResultEncode({ index: I.TEST, value: m.data }) }; note = '表计测试位图只回报，不执行测试动作'; break
					default: // '90'
						rsp = code(S.STS_CODE[m.data] ? m.data : 255)
						replayable = m.data !== 1
						consumed = false
						note = '指定结果码，不做任何动作'
				}
			}
			if (consumed) a.simUsed.add(w.digits)
			const payload = S.tokenRspEncode(rsp)
			dedupStore(w.digits, payload, replayable)
			return { kind: 'token', payload: payload, executed: executed, sim: m, action: action, note: note }
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
					// 阀控测试规则（需求方确认，有意偏离协议 §7 与 C 参考：阀控测试的目的只是防止产线测试后表以关阀状态出厂）：
					// 每条 WRITE 0x80 都真实动作：受理 0xFE -> 动作中（位置报 00 不明 + bit2）-> 经 valveDelayS 到位 -> 终局 0x00。
					// 关阀到位后开始 10 分钟保持期（bit2 保持），到期恢复成指令前状态，恢复本身也走动作过程；
					// 开阀到位后不设保持期，并取消关阀保持期/恢复。
					// 「是否保持期内的同方向重发」在收到指令这一刻判定并锁进这笔工作，不在完成时再判断
					const now = clock.now()
					const open = val[0] === 1
					const holdLive = !!a.valveHold && now < a.valveHold.restoreAt
					const work = { open: open, repeat: !open && holdLive, prePos: a.valve }
					const remainMs = holdLive ? a.valveHold.restoreAt - now : 0
					// 开阀受理即取消关阀保持期/延期恢复，不等到位（保持定时器到点时会发现保持已不在，自然作废）
					if (open) { a.valveHold = null; a.restoredPre = null }
					a.valveMoving = { kind: 'cmd', target: open ? S.VALVE_POS_OPEN : S.VALVE_POS_CLOSED, doneAt: now + cfg.valveDelayS * 1000, id: ++a.valveSeq, work: work }
					a.valveWorkPending = true
					return { kind: 'pending', delayMs: cfg.valveDelayS * 1000, valve: true, repeat: work.repeat, remainMs: remainMs }
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
				if (w.kind === 'token' && S.simTokenDecode(w.digits)) return finishSimToken(w)
				if (w.kind === 'token') {
					const I = S.STS_IDX
					let rsp
					let replayable = true
					if (cfg.tokenMode === 'exec' && !overLimit(cfg.creditAmount)) {
						a.remaining += cfg.creditAmount
						a.totalPurchased = Math.min(4294967295, a.totalPurchased + cfg.creditAmount)
						recordPush(cfg.creditAmount, w.acceptedMin)
						// MODE1 的 Value 与本次充值量同数同单位
						rsp = { procStatus: S.TOKEN_DONE_EXEC, credited: cfg.creditAmount, remaining: a.remaining, stsBlock: S.stsResultEncode({ index: I.CREDIT, value: cfg.creditAmount }) }
					} else if (cfg.tokenMode === 'exec') {
						// 超出余额上限（或 i32 越界）: 终局 OVER，绝不回绕成负数；取决于当前余额，用掉一些水后应当成功，不回放
						rsp = { procStatus: S.TOKEN_DONE_NOEXEC, stsBlock: S.stsResultEncode({ index: I.CODE, value: 1 }) }
						replayable = false
					} else if (cfg.tokenMode === 'test') {
						rsp = { procStatus: S.TOKEN_DONE_NOEXEC, stsBlock: S.stsResultEncode({ index: I.TEST, value: parseInt(cfg.testBits, 16) >>> 0 }) }
					} else {
						// 结果码只回报，不模拟对应的业务动作（清余额、开关阀等）；OVER 取决于余额，不回放
						const code = Number(cfg.tokenMode)
						rsp = { procStatus: S.TOKEN_DONE_NOEXEC, stsBlock: S.stsResultEncode({ index: I.CODE, value: code }) }
						replayable = code !== 1
					}
					const payload = S.tokenRspEncode(rsp)
					dedupStore(w.digits, payload, replayable)
					return { kind: 'token', payload: payload, executed: rsp.procStatus === S.TOKEN_DONE_EXEC, note: replayable || cfg.tokenMode !== 'exec' ? '' : overNote() }
				}
				return null
			},
			// 阀门动作到位（timer 到点由引擎调用）；id 不符说明已被手动改动或新指令取代，直接忽略
			completeMove(id) {
				const m = a.valveMoving
				if (!m || m.id !== id) return null
				const now = clock.now()
				a.valveMoving = null
				if (m.kind === 'restore') {
					a.valve = a.valveHold ? a.valveHold.pre : m.target
					a.valveHold = null
					return { kind: 'restore', pos: a.valve }
				}
				a.valveWorkPending = false
				a.valve = m.target
				const w = m.work
				const info = { kind: 'cmd', open: w.open, payload: S.writeRspEncode(R.VALVE_TEST, S.WRITE_OK), holdCancelled: false, holdKept: false, newHold: false, expiredRepeat: false }
				if (w.open) {
					info.holdCancelled = !!a.valveHold
					a.valveHold = null
					a.restoredPre = null
				} else if (w.repeat && a.valveHold && now < a.valveHold.restoreAt) {
					info.holdKept = true // 保持期内的同方向重发: 照样动作，指令前状态与恢复截止时刻都不重设
				} else {
					// 新的关阀指令。指令前状态: 有保持期在（恢复动作中被新指令顶掉）取它的原值；
					// 重发的保持期在动作期间已到期则取当时应恢复到的值；否则取受理时的稳定位置
					const pre = a.valveHold ? a.valveHold.pre : (a.restoredPre != null ? a.restoredPre : w.prePos)
					info.expiredRepeat = w.repeat
					a.restoredPre = null
					a.valveHold = { pre: pre, restoreAt: now + VALVE_HOLD_MS }
					info.newHold = true
				}
				return info
			},
			// 保持期到点: 动作中（一条关阀指令在走）就记下应恢复到的值、让那条指令按新指令收尾；否则开始恢复动作
			holdExpire() {
				const h = a.valveHold
				const now = clock.now()
				if (!h || now < h.restoreAt) return null
				if (a.valveMoving && a.valveMoving.kind === 'cmd') {
					a.restoredPre = h.pre
					a.valveHold = null
					return { deferred: true }
				}
				if (a.valveMoving) return null
				a.valveMoving = { kind: 'restore', target: h.pre, doneAt: now + cfg.valveDelayS * 1000, id: ++a.valveSeq }
				return { restoring: true, target: h.pre }
			},
			// 重启立即恢复到指令前状态并清掉动作/保持期，不续计时
			reboot() {
				a.work = null
				// 应恢复到的位置: 保持期原值；保持期已在动作期间到期则取延期记下的值（该值此时只存在 restoredPre 里）
				if (a.valveHold) a.valve = a.valveHold.pre
				else if (a.restoredPre != null) a.valve = a.restoredPre
				a.valveMoving = null
				a.valveHold = null
				a.valveWorkPending = false
				a.restoredPre = null
				a.valveSeq++
			},
			// 手动改阀门位置（不是协议写）: 取消正在进行的动作工作和任何保持期/恢复，完成回调靠 valveSeq 失效，不会再覆盖手动值
			setValve(pos) {
				if (pos !== 'open' && pos !== 'closed' && pos !== 'unknown') throw new Error('阀门位置需为 open / closed / unknown')
				const v = pos === 'open' ? S.VALVE_POS_OPEN : pos === 'closed' ? S.VALVE_POS_CLOSED : 0
				const cancelled = !!(a.valveMoving || a.valveHold)
				const cancelledPending = a.valveWorkPending
				a.valveMoving = null
				a.valveHold = null
				a.valveWorkPending = false
				a.restoredPre = null
				a.valveSeq++
				const changed = v !== a.valve
				a.valve = v
				return { changed: changed, cancelled: cancelled, cancelledPending: cancelledPending }
			},
			setValveFault(on) { a.valveFault = !!on },
			// 运行中改量值: 只改运行值，不回写配置；表计状态位域每次读都按当前值重算。
			// 这是唯一的写入口，合并现有状态后走 normalizeLiveFields，没有无校验路径。
			// 计价模式与小数位只允许停止时改: 存量数值（余额、记录、去重的终局载荷）都按旧标度存着，运行中换标度会让它们的含义悄悄变掉
			setLive(patch) {
				const p = patch || {}
				if ('tariffCurrency' in p || 'tariffDec' in p) throw new Error('计价模式与小数位只能在停止时修改')
				const o = normalizeLiveFields(Object.assign({
					remaining: a.remaining, totalUsed: a.totalUsed, totalPurchased: a.totalPurchased,
					batteryCv: a.batteryCv, alarmCodes: a.alarms.join(' '),
				}, p))
				a.remaining = o.remaining
				a.totalUsed = o.totalUsed
				a.totalPurchased = o.totalPurchased
				a.batteryCv = o.batteryCv
				a.alarms = o.alarmList.slice()
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
		let moveTimer = null
		let sess = null // 当前唤醒会话: kind=2 通知开始，0x0281 结束；上行队列随会话清空
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
				valve: a.valveMoving ? 0 : a.valve, valveFault: a.valveFault,
				valveTestActive: !!(a.valveMoving || a.valveHold), valveRestoreAt: a.valveHold ? a.valveHold.restoreAt : 0,
				valveMoving: a.valveMoving ? { kind: a.valveMoving.kind, target: a.valveMoving.target, remainMs: Math.max(0, a.valveMoving.doneAt - clock.now()) } : null,
				valveHold: a.valveHold ? { pre: a.valveHold.pre, remainMs: Math.max(0, a.valveHold.restoreAt - clock.now()) } : null,
				meterStatus: app.regValue(S.REG.METER_STATUS).val[0],
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

		// 阀门两个定时器各管一件事: moveTimer 管当前动作到位，holdTimer 管关阀保持期到点（动作中也要能到点）
		function armValve() {
			const a = app.state
			if (moveTimer != null) { clock.clearTimeout(moveTimer); moveTimer = null }
			if (holdTimer != null) { clock.clearTimeout(holdTimer); holdTimer = null }
			if (a.valveMoving) {
				const id = a.valveMoving.id
				moveTimer = clock.setTimeout(function () { moveTimer = null; onMoveDone(id) }, Math.max(0, a.valveMoving.doneAt - clock.now()))
			}
			if (a.valveHold) {
				holdTimer = clock.setTimeout(function () { holdTimer = null; onHoldDue() }, Math.max(0, a.valveHold.restoreAt - clock.now()))
			}
		}
		function posName(v) { return v === S.VALVE_POS_OPEN ? '开' : v === S.VALVE_POS_CLOSED ? '关' : '位置不明' }
		function onMoveDone(id) {
			const r = app.completeMove(id)
			if (!r) return
			if (r.kind === 'restore') {
				log('info', '恢复动作完成，阀门回到指令前状态（' + posName(r.pos) + '），保持期结束')
			} else {
				try { policy.pendingClose(r.payload) } catch (e) { log('error', '待办存档失败: ' + e.message) }
				if (r.open) log('info', '开阀到位，不设保持期' + (r.holdCancelled ? '；原关阀保持期已取消，之后保持开阀' : ''))
				else if (r.holdKept) log('info', '关阀到位；保持期内的同方向重发，指令前状态与恢复截止时刻都不重设')
				else if (r.expiredRepeat) log('warn', '关阀到位；这笔同方向指令收到时还在保持期内，但动作期间保持期已到期，按新的关阀指令处理：重新记录指令前状态并开始新的 10 分钟')
				else log('info', '关阀到位，保持 10 分钟后自动恢复到指令前状态')
			}
			armValve()
			pushState()
		}
		function onHoldDue() {
			const r = app.holdExpire()
			if (!r) return
			if (r.deferred) log('info', '保持期到点，但有一条阀控指令仍在动作中：稍后按新的关阀指令收尾')
			else log('info', '保持期到，开始恢复到指令前状态（' + posName(r.target) + '），恢复也需要动作时间')
			armValve()
			pushState()
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
			// 模拟令牌的开关阀: 与手动改阀门同一条路径（取消进行中的阀控测试）
			if (out.action) { app.setValve(out.action); armValve() }
			const tariff = { currency: app.state.tariffCurrency, dec: app.state.tariffDec }
			if (out.sim) log('info', S.simTokenText(out.sim, tariff) + (out.note ? '；' + out.note : '') + (out.action ? '；阀门' + (out.action === 'open' ? '已开' : '已关') : ''))
			else if (out.note) log('info', out.note)
			log('info', '令牌处理完成: ' + (out.executed ? '已执行，余额 ' + S.qtyRawText(app.state.remaining, tariff) : '未执行') + '，终局结果已存档')
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
					let etaFn
					if (out.valve) {
						const doneAt = app.state.valveMoving.doneAt
						etaFn = function () { return Math.min(254, Math.max(1, Math.ceil((doneAt - clock.now()) / 1000))) }
						armValve()
						log('info', out.repeat ? '阀控测试保持期内（剩余 ' + Math.ceil(out.remainMs / 60000) + ' 分钟）收到同方向关阀：照样动作，指令前状态与恢复截止时刻不重设' : '阀控测试受理，开始动作（位置报不明）')
					} else {
						etaFn = startWork(out.delayMs)
					}
					policy.pendingOpen(req, etaFn)
					log('info', '受理 ' + S.TYPE_NAME[req.type] + ' TGT=0x' + req.tgt.toString(16).toUpperCase() + '，' + Math.round(out.delayMs / 100) / 10 + 's 后终局')
					pushState()
					return policy.acceptFrame(req)
				}
				default:
					return null
			}
		}

		// 被唤醒: 模组已清空上行队列，此后入队的分片由本会话的 DACK 逐拍捎带
		function onWoken(d) {
			if (sess && !sess.ended) {
				sess.ended = true
				log('warn', '上一会话未见 0x0281 就收到新的唤醒通知（EVT 尽力而为，可能丢了），按新会话处理')
			}
			sess = { at: clock.now(), src: d.src, kind3: 0, queued: 0, ended: false }
			info.sessions++
			log('info', '被唤醒（kind=2 通知）src=' + d.src + '，上行队列已由模组清空')
			pushState()
		}
		function onSessionEnd(e) {
			const s = sess
			sess = null
			if (!s) { log('info', '会话终结 0x0281（' + endText(e) + '）'); return }
			s.ended = true
			// upDelivered 是表端「本侧确认交付」的片数: 收到下一新帧或 END 才算确认，未确认不等于 CIU 没收到
			const unconfirmed = s.queued - e.upDelivered
			log(unconfirmed > 0 ? 'warn' : 'info', '会话终结 0x0281（' + endText(e) + '）' + (unconfirmed > 0 ? '；本会话入队 ' + s.queued + ' 片，' + unconfirmed + ' 片未获确认（可能未送达），队列已随会话清空；CIU 没收到的话会重新唤醒并重发同一帧' : ''))
			if (info.lastSession && info.lastSession.at >= s.at) {
				info.lastSession.endReason = e.reason
				info.lastSession.upDelivered = e.upDelivered
			}
			pushState()
		}

		async function onDownlink(d) {
			const tRecv = clock.now()
			const s = sess
			if (!s) log('warn', '收到 kind=3 时没有见到本会话的唤醒通知（EVT 可能丢了），照常处理')
			else s.kind3++
			log('info', '收到 kind=3 下行 ' + d.len + 'B: ' + hexSpaced(d.data))
			const reply = handleApp(d.data)
			if (!reply) { log('info', '无应答，不入队'); pushState(); return }
			const t1 = clock.now()
			try {
				// 追加入队；队列满（深度 4）等一拍让 DACK 捎走一片再补。每次补发前都确认还在同一会话里：
				// 睡眠期间会话结束（队列已清）或已被新会话唤醒，旧应答就不能再入队，否则会被捎带进下一会话
				const alive = function () { return sess === s && !(s && s.ended) }
				let r
				for (let i = 0; ; i++) {
					r = await link.request(C.WOR_SET_UPLINK, H.setUplinkPayload(reply), { timeoutMs: 1000, retries: 1 })
					if (r.status !== H.STATUS.ERR_BUSY || i >= UPQ_RETRY) break
					log('info', '上行队列满（BUSY），等一拍再入队')
					await waiter.sleep(BEAT_MS)
					if (!alive()) {
						log('warn', '等待入队期间会话已结束，旧应答不再入队（CIU 会重新唤醒并重发同一帧）')
						pushState()
						return
					}
				}
				const t2 = clock.now()
				const ok = r.status === H.STATUS.OK
				if (!ok) log('error', 'WOR_SET_UPLINK 失败: ' + statusText(r) + (notInit(r) ? '（WorLink 未初始化）' : ''))
				else {
					if (s) s.queued++
					log('info', 'SET_UPLINK 入队 OK，耗时 ' + (t2 - t1) + 'ms，自 kind=3 起 ' + (t2 - tRecv) + 'ms，下一个 DACK 捎带: ' + hexSpaced(reply))
				}
				info.lastSession = { at: tRecv, replyBytes: reply.length, setUplinkMs: t2 - t1, sinceKind3Ms: t2 - tRecv, ok: ok, endReason: null, upDelivered: null }
			} catch (e) {
				if (!(e && (e.code === 'aborted' || e.code === 'closed'))) log('error', 'WOR_SET_UPLINK 失败: ' + (e && e.message ? e.message : e))
			}
			pushState()
		}

		function onEvt(evt) {
			if (stopped) return
			if (evt.cmd === H.EVT.WOR_SESSION_END) {
				const e = H.decodeSessionEnd(evt.payload)
				if (!e) { log('warn', 'EVT 0x0281 载荷长度异常: ' + evt.payload.length); return }
				onSessionEnd(e)
				return
			}
			if (evt.cmd !== H.EVT.WOR_FRAME) {
				log('info', 'EVT ' + (evt.name || '0x' + evt.cmd.toString(16)) + ' ' + hexSpaced(evt.payload))
				return
			}
			const d = H.decodeWorFrame(evt.payload)
			if (!d) { log('warn', 'EVT 0x0280 载荷长度异常: ' + evt.payload.length); return }
			if (d.kind === 2) onWoken(d)
			else if (d.kind === 3) {
				onDownlink(d).catch(function (e) { log('error', 'kind=3 处理异常: ' + (e && e.message ? e.message : e)) })
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
			// 面板不指定 DRN，始终回读模组；显式引擎配置仍供台架置备使用
			const dev0 = await mod.devIdGet()
			const want = cfg.drn ? BigInt(cfg.drn) : dev0.drn
			if (!cfg.drn) log('info', '从模组读取 DRN: ' + dev0.drn)
			if (want === 0n) throw new Error('DRN 未设置：已从模组读取 DRN，结果为 0（模组还没置备 DRN）。请先用 keytool 置备 DRN')
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
			if (mod.notInit(ws)) {
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
			else log('warn', 'WOR 状态不是 [1 SENTRY][1 GRID]: ' + (wst ? '[' + wst.role + '][' + wst.state + ' ' + (H.WOR_STATE_NAME[wst.state] || '') + ']' : '结果异常'))
			// 10B 版本附带运行地址: 它才是模组实际值守的唤醒地址，DRN 改了但没复位时两者会不一致
			if (wst && wst.localAddr != null && wst.localAddr !== dev.drn) log('warn', 'WOR 运行地址 ' + wst.localAddr + ' 与 DRN ' + dev.drn + ' 不一致，CIU 按 DRN 唤醒会唤不到；复位模组后重试')
			// 不预置上行: 上行队列在每次被唤醒时由模组清空，只能在收到本会话请求后入队
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
			if (moveTimer != null) { clock.clearTimeout(moveTimer); moveTimer = null }
			waiter.abortAll() // 不给模组发任何复位类命令
			log('info', '表端模拟已停止')
			pushState()
		}

		return {
			start: start,
			stop: stop,
			getState: snapshot,
			handleApp: handleApp, // 直接喂应用帧（测试与诊断用）
			// 运行中修改量值与告警码，立即生效（校验与配置同一套 normalizeLiveFields）。
			// 只改运行值，不回写配置表单（下次启动仍以表单为初值）。
			// 计价模式与小数位只允许停止时改: 存量数值（余额、记录、去重的终局载荷）都按旧标度存的，运行中换标度会让它们的含义悄悄变掉
			setLive(patch) {
				app.setLive(patch) // 合并现状并按 normalizeLiveFields 校验，非法值整体拒绝
				log('info', '运行值已修改: ' + Object.keys(patch || {}).join('、'))
				pushState()
				return snapshot()
			},
			// 手动设阀门位置: open / closed / unknown。取消正在进行的动作工作和任何保持期/恢复；
			// 有阀控待办在飞就给它终局 0x00，不留永不结束的待办；完成回调靠 app.valveSeq 失效，不会再覆盖手动值
			setValve(pos) {
				const r = app.setValve(pos)
				armValve()
				if (r.cancelledPending && policy && policy.state.pending) {
					try { policy.pendingClose(S.writeRspEncode(S.REG.VALVE_TEST, S.WRITE_OK)) } catch (e) { log('error', '待办存档失败: ' + e.message) }
				}
				if (r.cancelled) log('warn', '手动改阀门，阀控动作/测试已取消' + (r.cancelledPending ? '（在飞的阀控待办已给终局 0x00）' : ''))
				else if (r.changed) log('info', '手动设阀门位置: ' + pos)
				pushState()
				return snapshot()
			},
			setValveFault(on) {
				app.setValveFault(on)
				log('info', '手动' + (on ? '置' : '清') + '阀门动作故障位')
				pushState()
				return snapshot()
			},
			// 模拟表体重启: 清空待办与存档（去重记录视作已随余额落盘），阀控测试立即恢复
			simulateReboot() {
				if (workTimer != null) { clock.clearTimeout(workTimer); workTimer = null }
				if (policy) policy.reboot()
				app.reboot()
				armValve()
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
		let policy = createCiuPolicy(cfg.meterNo)
		let target = BigInt(cfg.targetDrn)
		let activeSessions = 0 // 正在进行的唤醒会话数；setTarget 只在为 0 时生效
		let localDrn = null // 模组 DEV_ID_GET 回读的本机 DRN（BigInt），WOR_INIT 的地址
		// CIU 不主动结束会话（不发 FINISH / ABORT），会话靠表端 END 或模组空闲看门狗自行收尾；
		// 所以 0x0281 可能在 runSession 返回很久之后才到。lastAccepted 记最近一个已受理会话的终结状态，
		// 由 CIU 级的 EVT 订阅填写（生命周期同引擎，不随单次 runSession 退订），下一轮 WAKE 前据此硬等
		let lastAccepted = null
		let unsubEnd = null
		const endWaiters = [] // 正在硬等上一会话 0x0281 的等待者，CIU 级订阅收到 0x0281 时叫醒
		const C = H.CMD
		let running = false
		let stopped = false
		let busyOp = null
		let aborted = false
		const sessionWaiters = new Set() // 正在等 ACK / 上行的等待者，中止时要能立刻叫醒
		const st = {
			phase: 'idle', op: null, tariff: null, protoVersion: null, pollAllowed: true,
			lastResult: null, sessionCount: 0, lastTimeline: null, budgetLeftMs: null, role: null, fw: null, localAddr: null,
		}

		function log(level, text) { onLogCb({ at: clock.now(), level: level, text: text }) }
		const mod = makeModule(link, clock, waiter, log)
		function snapshot() {
			return {
				running: running, phase: st.phase, op: st.op, tariff: st.tariff, protoVersion: st.protoVersion,
				pollAllowed: st.pollAllowed, lastResult: st.lastResult, sessionCount: st.sessionCount,
				lastTimeline: st.lastTimeline, budgetLeftMs: policy.budgetLeft(clock.now()), role: st.role,
				pending: policy.hasPending(), targetDrn: cfg.targetDrn, localAddr: st.localAddr,
			}
		}
		function setPhase(p) { st.phase = p; try { onStateCb(snapshot()) } catch (e) { /* 界面回调异常不影响引擎 */ } }
		function checkAborted() { if (aborted || stopped) throw abortErr() }

		// ---------- 会话层 ----------
		// 一次应用层问答 = 一次唤醒会话: WOR_WAKE_CIU -> WOR_SEND（槽满 BUSY 隔 1.4s 重发同一帧）
		// -> 等 ACK(kind=2) -> 等上行(kind=4) -> 立即返回。不发 FINISH / ABORT: 会话由表端 END 或模组空闲看门狗
		// （最后一次活动后约 8s，reason=8）自行收尾，FINISH 那时只会回 ERR_STATE；失败同样什么都不发。
		// 下一轮 runSession 开头硬等上一已受理会话的 0x0281（上限 PREV_END_WAIT_MS）再冷却 SESSION_COOLDOWN_MS，
		// 到点还没等到就照常 WAKE，BUSY 重试兜底。WOR_INIT 上电后只需一次（启动时按 WOR_GET_STATUS 判定），
		// 重复 INIT 只会回 BUSY；会话里只有 WAKE 回未初始化（模组中途复位）才补一次 INIT 再 WAKE

		// 等待条件成立或超时；中止时抛 aborted。list 是会在事件到达时被叫醒的等待者数组
		function condWait(list, cond, timeoutMs) {
			return new Promise(function (resolve, reject) {
				if (cond()) { resolve(true); return }
				const w = { check: function () { if (cond()) done(true) } }
				const timer = clock.setTimeout(function () { done(false) }, timeoutMs)
				function done(v) {
					clock.clearTimeout(timer)
					const i = list.indexOf(w)
					if (i !== -1) list.splice(i, 1)
					sessionWaiters.delete(w)
					if (aborted || stopped) reject(abortErr())
					else resolve(v)
				}
				w.abort = function () { done(false) }
				list.push(w)
				sessionWaiters.add(w)
			})
		}
		// CIU 级 0x0281 订阅: 最近一个已受理会话的终结只记在这里。runSession 返回后订阅仍在，stop() 才退订
		function onCiuEvt(evt) {
			if (evt.cmd !== H.EVT.WOR_SESSION_END) return
			const e = H.decodeSessionEnd(evt.payload)
			const rec = lastAccepted
			if (!e || !rec || rec.ended) return
			rec.ended = true
			rec.endAt = clock.now()
			rec.reason = e.reason
			endWaiters.slice().forEach(function (w) { w.check() })
		}
		function ensureEndWatch() { if (!unsubEnd) unsubEnd = link.onEvt(onCiuEvt) }
		// 本机 DRN 取自模组 DEV_ID_GET，不从 WOR_GET_STATUS 的运行地址取
		async function ensureLocalDrn() {
			if (localDrn == null) {
				const d = await mod.devIdGet()
				if (d.drn === 0n) throw new Error('CIU 模组 DRN 未置备（DEV_ID_GET 为 0），请先用 keytool 置备 DRN')
				localDrn = d.drn
				st.localAddr = d.drn.toString()
			}
			return localDrn
		}
		async function runSession(appFrame, accepts) {
			const frame = toU8(appFrame)
			const t0 = clock.now()
			const tl = { initMs: null, wakeMs: null, sendMs: null, ackMs: null, upMs: null, endMs: null, endReason: null }
			const fail = function (reason, stage) { return { ok: false, uplink: null, timeline: tl, reason: reason, stage: stage } }
			if (frame.length < 1 || frame.length > 64) return fail('应用帧超过 64 字节', 'send')
			ensureEndWatch()
			// open: 只有 WAKE_CIU 请求在飞或已受理期间收到的事件才算本轮；BUSY 等待期间到达的旧 kind=2/4 只记日志。
			// 0x0281 只在受理之后才算本轮: 上一会话的终结事件在串口上一定先于本轮的 WAKE 应答到达
			const tgt = target // 本会话开始时的目标地址副本，来源比较与唤醒都用它，中途换目标也不影响在途会话
			const sess = { ack: null, up: null, end: null, open: false, accepted: false }
			const waiters = []
			const notify = function () { waiters.slice().forEach(function (w) { w.check() }) }
			const unsub = link.onEvt(function (evt) {
				if (evt.cmd === H.EVT.WOR_SESSION_END) {
					const e = H.decodeSessionEnd(evt.payload)
					if (!e) return
					if (!sess.accepted || sess.end) { log('info', '会话终结 0x0281 不属于本轮（' + endText(e) + '）'); return }
					sess.end = { at: clock.now(), reason: e.reason, dl: e.dlDelivered, up: e.upDelivered }
					log(e.reason === 2 || e.reason === 1 || e.reason === 8 ? 'info' : 'warn', '会话终结 0x0281（' + endText(e) + '），相对 WAKE 请求 ' + (sess.end.at - t0) + 'ms')
					notify()
					return
				}
				if (evt.cmd !== H.EVT.WOR_FRAME) return
				const d = H.decodeWorFrame(evt.payload)
				if (!d) return
				// 会话帧不带地址（隐式取自当前事务），实板固件上报捎带上行(kind=4)时 src 填 0；
				// 所以 kind=4 不按 src 过滤，靠下面的应用层接收判定（表号 + TXN）认领，只有 ACK 等其余事件要求来源是目标表
				if (d.kind !== 4 && d.src !== tgt) { log('info', '忽略其他来源的 EVT src=' + d.src + ' kind=' + d.kind); return }
				if (!sess.open) { log('info', '本轮 WAKE 尚未受理时收到 kind=' + d.kind + '，属于上一会话，不占本轮接收槽'); return }
				if (d.kind === 2 && !sess.ack) {
					sess.ack = { at: clock.now() }
					log('info', 'ACK (kind=2)，相对 WAKE 请求 ' + (sess.ack.at - t0) + 'ms')
				} else if (d.kind === 4) {
					// 一个会话可以捎带多片上行: 过不了接收判定的不占本轮唯一的上行槽，继续等本轮的
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
			const waitCond = function (cond, timeoutMs) { return condWait(waiters, cond, timeoutMs) }
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
			const ended = function () { return !!sess.end }
			const endFail = function (stage) {
				const e = sess.end
				const why = e.reason === 3 ? '唤醒失败（burst 耗尽，表端未应答）' : '会话已终结（' + (H.END_REASON_NAME[e.reason] || 'reason=' + e.reason) + '）'
				return fail(why + (stage === 'uplink' ? '，没有收到本轮上行' : ''), stage)
			}
			activeSessions++
			let result = null
			let rec = null
			try {
				// 0. 上一已受理会话还没见到 0x0281: 硬等它终结，等不到就等到上限。会话靠空闲看门狗自行收尾，
				// 此时 WAKE 会撞 BUSY；等待与随后的冷却同样受应用层预算约束
				const prev = lastAccepted
				if (prev && !prev.ended && !budgetOut()) {
					const leftMs = Math.max(0, (prev.doneAt == null ? clock.now() : prev.doneAt) + PREV_END_WAIT_MS - clock.now())
					const tWait = clock.now()
					if (leftMs > 0) {
						log('info', '上一会话还没收到 0x0281（空闲看门狗约 8s 自行收尾），等它终结后再唤醒，最多再等 ' + Math.round(leftMs / 100) / 10 + 's')
						if (await condWait(endWaiters, function () { return prev.ended }, cap(leftMs))) log('info', '上一会话已终结（reason=' + prev.reason + ' ' + (H.END_REASON_NAME[prev.reason] || '未知') + '），等了 ' + (clock.now() - tWait) + 'ms')
					}
					if (!prev.ended && !budgetOut()) log('warn', '上一会话 ' + PREV_END_WAIT_MS / 1000 + 's 内没有收到 0x0281（EVT 可能丢了），照常冷却后唤醒，若回 BUSY 会等待')
				}
				// 发起端见终结时，表端还在 END linger；重新 WAKE 的部分前导可能落在收尾阶段，
				// 实板连续问答因此常要第二个 burst；终结（或硬等超时）后再等满一拍，等待同样受应用层预算约束
				const coolFrom = !prev ? null : prev.ended ? prev.endAt : clock.now()
				const coolMs = coolFrom == null ? 0 : coolFrom + SESSION_COOLDOWN_MS - clock.now()
				if (coolMs > 0 && !budgetOut()) await waiter.sleep(cap(coolMs))
				// 1. WAKE_CIU（WOR_INIT 已在启动时完成；回未初始化说明模组中途复位，补一次 INIT 再 WAKE）
				const busyDeadline = clock.now() + cfg.busyWaitS * 1000
				let tWake
				let reinit = false
				for (;;) {
					checkAborted()
					if (budgetOut()) return (result = fail('总等待预算 60s 已用完', 'budget'))
					tWake = clock.now()
					sess.ack = null; sess.up = null; sess.open = true
					const r = await link.request(C.WOR_WAKE_CIU, H.wakePayload(tgt, 2), reqOpt())
					if (r.status === H.STATUS.OK) break
					sess.open = false
					if (r.status === H.STATUS.ERR_BUSY) {
						if (clock.now() + 2000 > busyDeadline) return (result = fail('模组仍在上一次会话中（BUSY），等待超过 ' + cfg.busyWaitS + 's', 'wake'))
						log('info', 'WOR_WAKE_CIU 回 BUSY（上一会话未收尾），2s 后重试')
						await waiter.sleep(Math.max(1, cap(2000)))
						continue
					}
					if (r.status === H.STATUS.ERR_ROLE) return (result = fail('模组角色不是 CIU（ERR_ROLE）', 'wake'))
					if (notInit(r)) {
						if (reinit) return (result = fail('WorLink 未初始化（' + r.statusName + '），补 WOR_INIT 后仍未就绪，请重新启动模拟', 'wake'))
						reinit = true
						log('warn', 'WOR_WAKE_CIU 回 ' + r.statusName + '（WorLink 未初始化，模组可能复位过），补 WOR_INIT 后重试')
						const addr = await ensureLocalDrn()
						checkAborted()
						const tInit = clock.now()
						const ri = await link.request(C.WOR_INIT, H.woInitPayload(2, addr), reqOpt())
						if (ri.status === H.STATUS.ERR_ROLE) return (result = fail('模组角色不是 CIU（WOR_INIT 回 ERR_ROLE）', 'init'))
						if (ri.status !== H.STATUS.OK && ri.status !== H.STATUS.ERR_BUSY) return (result = fail('WOR_INIT 失败: ' + statusText(ri), 'init'))
						tl.initMs = clock.now() - tInit
						continue
					}
					if (r.status === H.STATUS.ERR_FMT) return (result = fail('WOR_WAKE_CIU 被拒（ERR_FMT）：模组 ciu 槽未置备（用 keytool 装配钥表），或目标 DRN 不是单播地址', 'wake'))
					return (result = fail('WOR_WAKE_CIU 失败: ' + statusText(r), 'wake'))
				}
				sess.accepted = true
				rec = { ended: false, endAt: null, reason: null, doneAt: null }
				lastAccepted = rec
				const tAcc = clock.now()
				tl.wakeMs = tAcc - tWake
				log('info', 'WOR_WAKE_CIU 已受理（受理不是成功），耗时 ' + tl.wakeMs + 'ms')
				// 3. 入队 WOR_SEND；槽满(BUSY)隔 1.4s 重发同一帧；ERR_STATE 说明事务已终结（多为唤醒已失败）。
				// 默认受理后立即入队（规范的发送门是受理不是 ACK）；sendTiming='ack' 时等 ACK 后再入队，
				// 用来在实板上排查「ACK 前入队的数据在 burst 期没被消费」这类模组问题
				const ackDeadline = tAcc + cfg.ackTimeoutS * 1000
				const sendStep = async function () {
					for (;;) {
						checkAborted()
						if (budgetOut()) return fail('总等待预算 60s 已用完', 'budget')
						if (ended()) return endFail('send')
						const r = await link.request(C.WOR_SEND, H.sendPayload(frame), reqOpt())
						if (r.status === H.STATUS.OK) break
						if (r.status === H.STATUS.ERR_BUSY) {
							if (clock.now() >= ackDeadline) return fail('WOR_SEND 一直 BUSY（槽满）', 'send')
							await waiter.sleep(Math.max(1, cap(SEND_BUSY_RETRY_MS)))
							continue
						}
						if (r.status === H.STATUS.ERR_STATE) return fail('WOR_SEND 回 ERR_STATE：会话已终结（多为唤醒失败），整轮重来', 'send')
						return fail('WOR_SEND 失败: ' + statusText(r), 'send')
					}
					tl.sendMs = clock.now() - t0
					log('info', 'WOR_SEND 已入待发槽 ' + frame.length + 'B' + (cfg.sendTiming === 'ack' ? '（ACK 后入队）' : '') + ': ' + hexSpaced(frame))
					return null
				}
				if (cfg.sendTiming !== 'ack') { const f = await sendStep(); if (f) return (result = f) }
				// 4. 等 ACK；唤醒失败由 0x0281 reason=3 通知（burst 耗尽最坏约 12.4s），超时只是兜底
				const ackOk = await waitCond(function () { return !!sess.ack || ended() }, cap(Math.max(0, ackDeadline - clock.now())))
				if (!sess.ack && ended()) return (result = endFail('ack'))
				if (!ackOk) return (result = fail(budgetOut() ? '总等待预算 60s 已用完' : '等 ACK 超时（' + cfg.ackTimeoutS + 's）', budgetOut() ? 'budget' : 'ack'))
				tl.ackMs = sess.ack.at - t0
				if (cfg.sendTiming === 'ack') { const f = await sendStep(); if (f) return (result = f) }
				// 5. 等上行，从 ACK 起算；会话先终结（重传耗尽 / 失联 / 空闲看门狗）就不必再等
				const upOk = await waitCond(function () { return !!sess.up || ended() }, cap(Math.max(0, sess.ack.at + cfg.upTimeoutS * 1000 - clock.now())))
				if (!sess.up && ended()) return (result = endFail('uplink'))
				if (!upOk) return (result = fail(budgetOut() ? '总等待预算 60s 已用完' : '等上行超时（ACK 后 ' + cfg.upTimeoutS + 's）', budgetOut() ? 'budget' : 'uplink'))
				tl.upMs = sess.up.at - t0
				result = { ok: true, uplink: sess.up.data, upAt: sess.up.at, timeline: tl, reason: '' }
				return result
			} catch (e) {
				if (e && e.code === 'aborted') throw e
				return (result = fail(e && e.message ? e.message : String(e), 'link'))
			} finally {
				// 成败都不给模组发任何收尾命令；会话由空闲看门狗 / 表端 END 自行收尾，下一轮 runSession 硬等它的 0x0281
				if (rec) rec.doneAt = clock.now()
				if (sess.end) { tl.endMs = sess.end.at - t0; tl.endReason = sess.end.reason }
				activeSessions--
				unsub()
				waiters.slice().forEach(function (w) { w.abort() })
			}
		}

		function fmtTimeline(tl) {
			return ['init', 'wake', 'send', 'ack', 'up', 'end'].map(function (k) { return k + '=' + (tl[k + 'Ms'] == null ? '-' : tl[k + 'Ms'] + 'ms') }).join(' ') + (tl.endReason != null ? ' (reason=' + tl.endReason + ')' : '')
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
				checkAborted() // 返回后被中止: 不再采用这轮结果
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
				// 预算按上行到达时刻判定与起算
				if (policy.budgetExpired(s.upAt)) { rec.reason = '上行到达时已超过 60s 总预算'; return { kind: 'budget' } }
				const ev = policy.onFrame(s.uplink, s.upAt)
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
					const sr = t.stsBlock ? S.stsResultDecode(t.stsBlock, t.procStatus) : { parsed: false, len: 0 }
					res.token.stsResult = sr
					res.token.stsResultText = sr.parsed ? sr.text + (sr.mismatch ? '（与处理状态对应不上）' : '') : '结果块 ' + sr.len + 'B 旧格式，无法解析'
					if (t.procStatus === S.TOKEN_DONE_EXEC) {
						res.token.executed = true
						res.token.credited = t.credited
						res.token.remaining = t.remaining
						res.token.creditedText = fmtQty(t.credited)
						res.token.remainingText = fmtQty(t.remaining)
						res.message = '令牌已执行：充值 ' + res.token.creditedText + '，剩余 ' + res.token.remainingText
					} else {
						res.token.executed = false
						if (sr.parsed && sr.kind === 'code' && sr.code) res.message = (sr.code.ok ? '令牌成功（非充值）：' : '令牌未执行：') + sr.code.name + ' ' + sr.code.text
						else if (sr.parsed && sr.kind === 'test') res.message = '表计测试令牌：' + (sr.bits.length ? sr.bits.map(function (x) { return 'BIT' + x.bit + ' ' + x.text }).join('、') : '无测试位')
						else res.message = '令牌未执行：' + res.token.stsResultText
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
			// 本机地址取 DEV_ID_GET 的 DRN；WOR_INIT 上电后只需一次，先 WOR_GET_STATUS，未初始化才 INIT(INITIATOR, DRN)
			const drn = await ensureLocalDrn()
			const ws = await link.request(C.WOR_GET_STATUS, [])
			if (mod.notInit(ws)) {
				log('info', 'WOR 未初始化，WOR_INIT(INITIATOR, addr=DRN)')
				const ri = await link.request(C.WOR_INIT, H.woInitPayload(2, drn))
				if (ri.status !== H.STATUS.OK && ri.status !== H.STATUS.ERR_BUSY) throw new Error('WOR_INIT 失败: ' + statusText(ri) + (ri.status === H.STATUS.ERR_ROLE ? '（模组角色不是 CIU）' : ''))
			} else {
				mod.need(ws, 'WOR_GET_STATUS')
				const wst = H.decodeWorStatus(ws.payload)
				if (wst) log('info', 'WOR 已初始化 [' + wst.role + ' ' + (H.WOR_ROLE_NAME[wst.role] || '未知') + '][' + wst.state + ' ' + (H.WOR_STATE_NAME[wst.state] || '') + ']，不再 WOR_INIT')
				if (wst && wst.role !== 2) log('warn', 'WOR 角色不是 INITIATOR（' + wst.role + '），唤醒可能被拒；复位模组后重试')
				if (wst && wst.localAddr != null && wst.localAddr !== drn) log('warn', 'WOR 运行地址 ' + wst.localAddr + ' 与 DRN ' + drn + ' 不一致；复位模组后重试')
			}
			if (gen !== runGen || stopped) throw abortErr()
			running = true
			log('info', 'CIU 模拟就绪：本机地址 ' + st.localAddr + '，目标 DRN ' + cfg.targetDrn + '，应用层表号 ' + cfg.meterNo)
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
		async function loadBasics(res) {
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
			if (st.tariff && st.protoVersion != null) {
				res.outcome = 'done'
				res.message = '计价模式与协议版本已读取'
			} else {
				res.outcome = 'failed'
				res.message = '计价模式或协议版本寄存器不可读'
			}
		}
		function refreshBasics() { return runOp('basics', loadBasics) }

		// 待办类操作（令牌、阀控）依赖 RESULT 轮询: 基础信息未知时先重读，仍读不到就拒绝，
		// 不把「未知的协议版本」当作支持轮询
		async function ensurePoll(res) {
			if (st.tariff == null || st.protoVersion == null) {
				log('info', '计价模式/协议版本未知，先重读再执行')
				await loadBasics(res)
				if (st.tariff == null || st.protoVersion == null) {
					res.outcome = 'failed'
					res.message = '计价模式/协议版本没读到（' + (res.message || '会话失败') + '），无法确认表体支持 RESULT 轮询，待办类操作已拒绝'
					return false
				}
				res.outcome = 'failed'
				res.message = ''
			}
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
				if (unsubEnd) { unsubEnd(); unsubEnd = null }
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
			// 运行中切换目标表: 只在空闲（没有操作、没有待办、没有在飞事务）时生效。
			// 应用层表号取自 DRN，所以要重建 CIU 策略（TXN 与待办状态随新表重置），
			// 并对新表重新读一次计价模式与协议版本。校验复用 normalizeCiuConfig
			async setTarget(drn) {
				if (!running) throw new Error('CIU 模拟未运行')
				const n = normalizeCiuConfig(Object.assign({}, cfg, { targetDrn: drn }))
				if (busyOp || activeSessions > 0 || policy.hasPending() || policy.state.inflight) {
					const e = new Error('当前操作结束后再切换')
					e.code = 'busy'
					throw e
				}
				if (n.targetDrn === cfg.targetDrn) return snapshot()
				cfg.targetDrn = n.targetDrn
				cfg.meterNo = n.meterNo
				target = BigInt(n.targetDrn)
				policy = createCiuPolicy(n.meterNo)
				st.tariff = null
				st.protoVersion = null
				st.pollAllowed = true
				log('info', '目标表切换为 DRN ' + n.targetDrn + '（表号 ' + n.meterNo + '）')
				setPhase('idle')
				const mine = gen
				const r = await refreshBasics()
				if (stopped || gen !== mine) throw abortErr() // 切换过程中被停止: 明确 aborted，调用方不得当作已切换
				// 基础信息读取失败: 保留新目标，由 basicsOk=false 告知；之后的待办类操作会先自动重读
				if (!r.ok) log('warn', '目标表已切换，但基础信息读取失败: ' + r.message + '（下次待办类操作前会自动重读）')
				return Object.assign(snapshot(), { basicsOk: !!r.ok })
			},
			token(digits) {
				return runOp('token', async function (res) {
					const d = String(digits || '')
					if (!/^\d{20}$/.test(d)) { res.message = '令牌需 20 位数字，不足位数在本地提示，不上线'; return }
					if (!(await ensurePoll(res))) return
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
					if (!(await ensurePoll(res))) return
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
		normalizeLiveFields: normalizeLiveFields,
		ALARM_PRESETS: ALARM_PRESETS,
		composeAlarmCodes: composeAlarmCodes,
		splitAlarmCodes: splitAlarmCodes,
		normalizeCiuConfig: normalizeCiuConfig,
		drnToMeterNo: drnToMeterNo,
		drnCheckOk: drnCheckOk,
		METER_DEFAULTS: METER_DEFAULTS,
		CIU_DEFAULTS: CIU_DEFAULTS,
		BUDGET_MS: BUDGET_MS,
	}
})()
