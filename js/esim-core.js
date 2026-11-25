// eSIM (Tag=66) 核心编解码、状态字典与 mode=1 四轮 ES9+ ZMODEM 代理状态机
// 纯逻辑模块：不碰 DOM、localStorage 或 serialApi，可在 Node 直接单测并在浏览器挂到 window.EsimCore
;(function (root) {
	'use strict'

	const ES9_ROUNDS = [
		{ index: 0, path: '/gsma/rsp2/es9plus/initiateAuthentication', label: '第 1 轮 · initiateAuthentication', expectStatus: 200, initialWaitMs: 90000 },
		{ index: 1, path: '/gsma/rsp2/es9plus/authenticateClient', label: '第 2 轮 · authenticateClient', expectStatus: 200, initialWaitMs: 60000 },
		{ index: 2, path: '/gsma/rsp2/es9plus/getBoundProfilePackage', label: '第 3 轮 · getBoundProfilePackage (BPP)', expectStatus: 200, initialWaitMs: 60000 },
		{ index: 3, path: '/gsma/rsp2/es9plus/handleNotification', label: '第 4 轮 · handleNotification', expectStatus: 204, initialWaitMs: 180000 },
	]

	const ES9_HEADERS = Object.freeze({
		'X-Admin-Protocol': 'gsma/rsp/v2.2.0',
		'Content-Type': 'application/json',
		'User-Agent': 'gsma-rsp-lpad',
		'Connection': 'close',
	})

	const PROFILE_CLASS_LABELS = { 0: '运营', 1: '预置/引导', 2: '测试', 3: '保留' }
	const MODE_LABELS = { 0: '模组内联网 (mode=0)', 1: '近端外部代理 (mode=1)', 2: 'MCU自建HTTPS (mode=2)' }
	const OP_LABELS = { 1: '启用(切卡)', 2: '禁用', 3: '删除' }
	const STATE_LABELS = { 0: '空闲', 1: '执行中', 2: '成功', 3: '失败', 4: '部分成功' }
	const LAST_OP_LABELS = { 0: '无', 1: '下载(内网)', 2: '下载(外部代理)', 3: '下载(MCU-HTTPS)', 4: '启用Profile', 5: '禁用Profile', 6: '删除Profile' }
	const FAIL_STAGE_LABELS = {
		0: '无错误',
		1: '参数错',
		2: '前置条件不满足',
		3: 'AT错误',
		4: '超时',
		5: 'HTTP/网络错误',
		6: '模组下载错误码',
		7: 'ZMODEM/近端中断',
	}

	// EG800Z +QESIM 低 16 位常见错误码及排查建议（高 16 位恒为 0x8500）
	const QESIM_ERROR_HINTS = {
		0x0004: { name: '操作超时', hint: '模组/eUICC 响应超时' },
		0x0005: { name: '参数/序号或业务状态错误', hint: '检查每轮 seq 是否从 0 重置，或服务端已返回 Failed' },
		0x0008: { name: 'eUICC 休眠/无卡', hint: '检查 CFUN=1 且已发送 AT+ECSIMSLEEP=0' },
		0x000E: { name: '文件系统/响应体格式错误', hint: '确认只回灌纯 JSON body，不含 HTTP 响应头' },
		0x0102: { name: 'Profile 已处于启用态', hint: '目标卡已启用，无需重复启用' },
		0x0105: { name: 'eUICC 卡应用繁忙', hint: '软复位无效，必须对模组/整机断电重启后复测' },
		0x0203: { name: 'PPR 策略禁止禁用', hint: '该 Profile 受 eUICC PPR 保护，不允许禁用' },
		0x0204: { name: 'eUICC 卡应用繁忙', hint: '软复位无效，必须对模组/整机断电重启后复测' },
		0x0302: { name: '启用态不可删除', hint: '请先禁用该 Profile 后再删除' },
		0x0303: { name: 'PPR 策略禁止删除', hint: '该 Profile 受 eUICC PPR 保护，不允许删除' },
		0x0705: { name: '无效 OID', hint: '激活码不得包含无效 OID 段，请向发卡侧核对 AC；勿盲目重试' },
		0x0706: { name: 'Challenge 不匹配', hint: '不可复用旧会话响应；勿盲目重试' },
		0x0909: { name: 'ICCID 已存在', hint: '卡内已有相同 ICCID 的 Profile；勿盲目重试' },
		0x090C: { name: 'PE 处理错误', hint: '卡内可能残留同订单 Profile，请先清理后再下发；勿盲目重试' },
	}

	function mapAtProfileClassToId1(atClass) {
		if (atClass === 2) return 0 // 操作文件 -> 运营
		if (atClass === 1) return 1 // 预置文件 -> 预置/引导
		if (atClass === 0) return 2 // 测试文件 -> 测试
		return 3 // 保留
	}

	function decodeProfileFlags(flags) {
		const f = flags & 0xffff
		const profileClass = (f >>> 1) & 0x03
		return {
			raw: f,
			enabled: (f & 0x01) !== 0,
			profileClass,
			profileClassLabel: PROFILE_CLASS_LABELS[profileClass] || '保留',
			pprDisableBlocked: (f & 0x08) !== 0,
			pprDeleteBlocked: (f & 0x10) !== 0,
			fallback: (f & 0x20) !== 0,
		}
	}

	function encodeProfileFlags(info) {
		info = info || {}
		let f = 0
		if (info.enabled) f |= 0x01
		f |= ((info.profileClass & 0x03) << 1)
		if (info.pprDisableBlocked) f |= 0x08
		if (info.pprDeleteBlocked) f |= 0x10
		if (info.fallback) f |= 0x20
		return f & 0xffff
	}

	function isPrintableAscii(str) {
		for (let i = 0; i < str.length; i++) {
			const c = str.charCodeAt(i)
			if (c < 0x20 || c > 0x7e) return false
		}
		return true
	}

	function parseActivationCode(ac) {
		const s = String(ac || '').trim()
		if (!s) return { ok: false, error: '激活码 (AC) 不能为空' }
		if (!s.startsWith('LPA:1$')) return { ok: false, error: '激活码必须以 LPA:1$ 开头' }
		if (!isPrintableAscii(s)) return { ok: false, error: '激活码只能包含可见 ASCII 字符' }
		if (s.length > 255) return { ok: false, error: '激活码长度不能超过 255 字节' }
		const parts = s.split('$')
		const smdpHost = (parts[1] || '').trim()
		const matchingId = (parts[2] || '').trim()
		const oid = (parts[3] || '').trim()
		if (!smdpHost || /\s|\/|\\/.test(smdpHost)) {
			return { ok: false, error: '激活码中的 SM-DP+ 域名无效' }
		}
		const warning = oid ? '检测到激活码含 OID 段（实机 EG800Z 可能在第 1 轮报 85000705，请确认发卡侧要求）' : ''
		return { ok: true, ac: s, smdpHost, matchingId, oid, warning }
	}

	function encodeDownloadTrigger(opts) {
		opts = opts || {}
		const mode = Number(opts.mode)
		if (!Number.isInteger(mode) || mode < 0 || mode > 2) {
			throw new Error('下载模式必须为 0、1 或 2')
		}
		const acInfo = parseActivationCode(opts.ac)
		if (!acInfo.ok) throw new Error(acInfo.error)
		const cc = String(opts.cc || '').trim()
		if (cc.length > 64) throw new Error('确认码 (CC) 长度不能超过 64 字节')
		if (cc && !isPrintableAscii(cc)) throw new Error('确认码只能包含可见 ASCII 字符')

		const acLen = acInfo.ac.length
		const ccLen = cc.length
		const out = new Uint8Array(1 + 1 + acLen + 1 + ccLen)
		let off = 0
		out[off++] = mode & 0xff
		out[off++] = acLen & 0xff
		for (let i = 0; i < acLen; i++) out[off++] = acInfo.ac.charCodeAt(i) & 0xff
		out[off++] = ccLen & 0xff
		for (let i = 0; i < ccLen; i++) out[off++] = cc.charCodeAt(i) & 0xff
		return out
	}

	// 脱敏 Tag=66 ID=2 载荷：保留 mode/acLen/ccLen 结构，AC/CC 字节全清零，供日志 logData 使用
	function redactDownloadValue(valBytes) {
		const u8 = valBytes instanceof Uint8Array ? new Uint8Array(valBytes) : Uint8Array.from(valBytes || [])
		if (u8.length < 2) return u8
		const acLen = u8[1] & 0xff
		for (let i = 2; i < Math.min(u8.length, 2 + acLen); i++) u8[i] = 0x2A // '*'
		const ccOff = 2 + acLen
		if (ccOff < u8.length) {
			const ccLen = u8[ccOff] & 0xff
			for (let i = ccOff + 1; i < Math.min(u8.length, ccOff + 1 + ccLen); i++) u8[i] = 0x2A
		}
		return u8
	}

	function encodeProfileManage(opts) {
		opts = opts || {}
		const op = Number(opts.op)
		if (op !== 1 && op !== 2 && op !== 3) throw new Error('Profile 管理操作码必须为 1(启用)、2(禁用) 或 3(删除)')
		const iccid = String(opts.iccid || '').trim()
		if (!iccid || iccid.length > 20 || !/^[0-9A-Fa-f]{10,20}$/.test(iccid)) {
			throw new Error('ICCID 格式无效（需为 10~20 位数字/十六进制字符）')
		}
		const out = new Uint8Array(21)
		out[0] = op & 0xff
		for (let i = 0; i < iccid.length; i++) out[1 + i] = iccid.charCodeAt(i) & 0xff
		return out
	}

	function decodeEid(raw) {
		const u8 = raw instanceof Uint8Array ? raw : Uint8Array.from(raw || [])
		if (u8.length < 16) return { valid: false, ready: false, eid: '' }
		let s = ''
		let allZero = true
		for (let i = 0; i < 16; i++) {
			const b = u8[i] & 0xff
			if (b !== 0) allZero = false
			const hi = (b >>> 4) & 0x0f
			const lo = b & 0x0f
			if (hi > 9 || lo > 9) return { valid: false, ready: false, eid: '' }
			s += String(hi) + String(lo)
		}
		return { valid: true, ready: !allZero, eid: allZero ? '' : s }
	}

	function decodeProfileList(raw) {
		const u8 = raw instanceof Uint8Array ? raw : Uint8Array.from(raw || [])
		if (u8.length < 1) return { count: 0, profiles: [], truncated: true }
		const count = u8[0] & 0xff
		const profiles = []
		let truncated = false
		for (let i = 0; i < count; i++) {
			const off = 1 + i * 22
			if (off + 22 > u8.length) {
				truncated = true
				break
			}
			let iccid = ''
			for (let k = 0; k < 20; k++) {
				const c = u8[off + k] & 0xff
				if (c === 0) break
				iccid += String.fromCharCode(c)
			}
			const flags = (u8[off + 20] | (u8[off + 21] << 8)) & 0xffff
			profiles.push(Object.assign({ index: i, iccid }, decodeProfileFlags(flags)))
		}
		return { count, profiles, truncated }
	}

	function decodeStatus(raw) {
		const u8 = raw instanceof Uint8Array ? raw : Uint8Array.from(raw || [])
		if (u8.length < 12) return null
		const state = u8[0] & 0xff
		const lastOp = u8[1] & 0xff
		const failStage = u8[2] & 0xff
		const moduleErrCode = (u8[3] | (u8[4] << 8)) & 0xffff
		let allZeroTime = true
		let validBcd = true
		let d = ''
		for (let i = 5; i < 12; i++) {
			const b = u8[i] & 0xff
			if (b !== 0) allZeroTime = false
			const hi = (b >>> 4) & 0x0f
			const lo = b & 0x0f
			if (hi > 9 || lo > 9) validBcd = false
			d += String(hi) + String(lo)
		}
		const timeText = (!allZeroTime && validBcd)
			? (d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + ' ' + d.slice(8, 10) + ':' + d.slice(10, 12) + ':' + d.slice(12, 14))
			: ''
		const errHex = moduleErrCode.toString(16).toUpperCase().padStart(4, '0')
		const errInfo = moduleErrCode ? (QESIM_ERROR_HINTS[moduleErrCode] || null) : null
		return {
			state,
			stateLabel: STATE_LABELS[state] || ('未知(' + state + ')'),
			lastOp,
			lastOpLabel: LAST_OP_LABELS[lastOp] || ('未知(' + lastOp + ')'),
			failStage,
			failStageLabel: FAIL_STAGE_LABELS[failStage] || ('未知(' + failStage + ')'),
			moduleErrCode,
			moduleErrHex: moduleErrCode ? ('0x' + errHex) : '0x0000',
			qesimFullCode: moduleErrCode ? ('0x8500' + errHex) : '',
			errName: errInfo ? errInfo.name : '',
			errHint: errInfo ? errInfo.hint : '',
			timeText,
		}
	}

	function validateProfileAction(op, target, allProfiles) {
		if (!target || !target.iccid) return { allowed: false, reason: '未指定目标 Profile' }
		const list = Array.isArray(allProfiles) ? allProfiles : []
		if (op === 3) {
			if (target.enabled) {
				return { allowed: false, reason: '只能删除禁用态 Profile，请先禁用该卡后再删除（否则模组会拒绝并返回 85000302）' }
			}
			if (target.pprDeleteBlocked) {
				return { allowed: false, reason: '该 Profile 标记为禁止删除 (PPR)' }
			}
			return { allowed: true, confirm: '确认永久删除禁用态 Profile（ICCID: ' + target.iccid + '）？删除操作最长可能耗时 60 秒。' }
		}
		if (op === 1) {
			if (target.enabled) {
				return { allowed: true, confirm: '该 Profile 当前已处于启用态，模组执行启用会返回失败码 85000102。仍要继续发送吗？' }
			}
			return { allowed: true, confirm: '确认切卡并启用 Profile（ICCID: ' + target.iccid + '）？' }
		}
		if (op === 2) {
			if (target.pprDisableBlocked) {
				return { allowed: false, reason: '该 Profile 标记为禁止禁用 (PPR)' }
			}
			const enabledCount = list.filter(p => p && p.enabled).length
			if (target.enabled && enabledCount <= 1) {
				return { allowed: true, confirm: '警告：该卡是当前唯一启用的 Profile，禁用后设备将无可用蜂窝卡（远端通道会拒绝此操作）。确认继续禁用吗？' }
			}
			return { allowed: true, confirm: '确认禁用 Profile（ICCID: ' + target.iccid + '）？' }
		}
		return { allowed: false, reason: '未知操作码: ' + op }
	}

	function utf8Decode(bytes) {
		if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes)
		let s = ''
		for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
		return s
	}

	function extractSmdpFailure(parsedJson) {
		const fes = parsedJson && parsedJson.header && parsedJson.header.functionExecutionStatus
		if (!fes) return { ok: false, status: 'UNKNOWN', subjectCode: '', reasonCode: '', message: '响应缺少 header.functionExecutionStatus' }
		if (fes.status === 'Executed-Success') return { ok: true, status: fes.status }
		const sc = fes.statusCodeData || {}
		return {
			ok: false,
			status: String(fes.status || 'Failed'),
			subjectCode: String(sc.subjectCode || ''),
			reasonCode: String(sc.reasonCode || ''),
			message: String(sc.message || ''),
		}
	}

	function buildSmdpUrl(host, path, proxyBaseUrl) {
		const cleanPath = String(path || '').trim()
		if (!cleanPath.startsWith('/gsma/rsp2/es9plus/') || cleanPath.includes('..') || /\s/.test(cleanPath)) {
			throw new Error('非法的 ES9+ 相对路径: ' + cleanPath)
		}
		if (proxyBaseUrl) {
			const base = String(proxyBaseUrl).replace(/\/+$/, '')
			return base + cleanPath
		}
		const cleanHost = String(host || '').trim()
		if (!cleanHost || /\s|\/|\\/.test(cleanHost)) {
			throw new Error('缺少有效的 SM-DP+ 域名')
		}
		return 'https://' + cleanHost + cleanPath
	}

	function normalizeHost(h) {
		return String(h || '').trim().toLowerCase().replace(/\.+$/, '')
	}

	function raceWithSignal(promise, signal, abortedStatus) {
		if (!signal) return promise
		if (signal.aborted) {
			const err = new Error('用户已取消操作')
			err.zmodemCode = abortedStatus
			return Promise.reject(err)
		}
		return new Promise(function (resolve, reject) {
			function onAbort() {
				const err = new Error('用户已取消操作')
				err.zmodemCode = abortedStatus
				reject(err)
			}
			signal.addEventListener('abort', onAbort, { once: true })
			Promise.resolve(promise).then(
				function (v) {
					signal.removeEventListener('abort', onAbort)
					resolve(v)
				},
				function (e) {
					signal.removeEventListener('abort', onAbort)
					reject(e)
				}
			)
		})
	}

	// mode=1 近端外部代理 + ZMODEM 四轮 ES9+ 透传状态机
	// 严格契约：
	// - 第 1~3 轮：ZMODEM 收 MCU 请求 -> HTTPS POST SM-DP+ -> 校验 HTTP 200 且 Executed-Success -> ZMODEM 回传纯 JSON 原始字节 (expectedSize > 0)
	// - 第 4 轮 handleNotification：ZMODEM 收 MCU 通知 -> HTTPS POST SM-DP+ -> 校验 HTTP 204 -> ZMODEM 发空传输 (expectedSize == 0)
	// - 任一失败、主机不一致或用户中止，链路仍在时立即发 CAN*5 中止序列，绝不把失败响应回灌给模组
	async function runMode1ProxySession(opts) {
		opts = opts || {}
		const zmodem = opts.zmodem || root.Zmodem
		if (!zmodem) throw new Error('Zmodem 模块未就绪')
		const io = opts.io
		const httpPost = opts.httpPost
		if (!io || typeof httpPost !== 'function') throw new Error('缺少 ZMODEM I/O 或 HTTPS 代理实现')
		const lockedHost = String(opts.smdpHost || '').trim()
		const lockedHostNorm = normalizeHost(lockedHost)
		const proxyBaseUrl = String(opts.proxyBaseUrl || '').trim()
		const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {}
		const zOpts = Object.assign({ readTimeoutMs: 5000, sessionTimeoutMs: 120000, maxRetries: 5 }, opts.zmodemOpts || {})
		if (opts.signal) zOpts.signal = opts.signal
		const roundWaitOverrides = Array.isArray(opts.roundInitialWaitMs) ? opts.roundInitialWaitMs : null

		const roundResults = []

		async function abortAndThrow(roundIdx, stage, message, extra) {
			await zmodem.sendAbort(io)
			const err = new Error(message)
			err.round = roundIdx
			err.stage = stage
			if (extra) Object.assign(err, extra)
			onEvent({ type: 'error', round: roundIdx, stage, message, extra: extra || null })
			throw err
		}

		for (let i = 0; i < ES9_ROUNDS.length; i++) {
			const spec = ES9_ROUNDS[i]
			onEvent({ type: 'round-start', round: i, path: spec.path, label: spec.label })

			// 1) ZMODEM 接收 MCU 发来的本轮 ES9+ 请求（按轮次配置独立 initialWaitMs，不计入 maxRetries）
			const initWait = roundWaitOverrides && roundWaitOverrides[i] != null
				? roundWaitOverrides[i]
				: (zOpts.initialWaitMs != null ? zOpts.initialWaitMs : spec.initialWaitMs)
			const rxOpts = Object.assign({}, zOpts, { initialWaitMs: initWait })
			let rx
			try {
				rx = await zmodem.receive(io, rxOpts)
			} catch (e) {
				if (!e || e.zmodemCode !== zmodem.STATUS.ERR_IO) {
					await zmodem.sendAbort(io)
				}
				const msg = '第 ' + (i + 1) + ' 轮接收 MCU 请求失败: ' + (e && e.message ? e.message : e)
				onEvent({ type: 'error', round: i, stage: 'zmodem-rx', message: msg })
				throw e
			}
			if (rx.fileName !== spec.path) {
				await abortAndThrow(i, 'round-order', '第 ' + (i + 1) + ' 轮路径不匹配: 期望 ' + spec.path + '，实际 ' + rx.fileName)
			}

			// 整次会话锁定 AC 中的 SM-DP+ 主机；若第 1 轮 smdpAddress 与 AC 主机不一致直接中止
			let reqSmdpAddress = ''
			try {
				const reqObj = JSON.parse(utf8Decode(rx.data))
				if (reqObj && typeof reqObj.smdpAddress === 'string') {
					reqSmdpAddress = reqObj.smdpAddress.trim()
				}
			} catch (e) {}

			if (i === 0 && reqSmdpAddress && lockedHostNorm && normalizeHost(reqSmdpAddress) !== lockedHostNorm) {
				await abortAndThrow(i, 'host-mismatch', '第 1 轮 SM-DP+ 主机不一致：激活码为 ' + lockedHost + '，设备请求为 ' + reqSmdpAddress, {
					expectedHost: lockedHost,
					actualHost: reqSmdpAddress,
				})
			}

			const host = lockedHost || reqSmdpAddress
			let url
			try {
				url = buildSmdpUrl(host, rx.fileName, proxyBaseUrl)
			} catch (e) {
				await abortAndThrow(i, 'url', e.message)
			}

			onEvent({ type: 'http-start', round: i, path: spec.path, reqBytes: rx.data.length })

			// 2) HTTPS POST 转发给 SM-DP+（逐字节转发，不重排 JSON；经 Promise.race 响应 signal 取消并立刻发 CAN*5）
			let resp
			try {
				resp = await raceWithSignal(httpPost({
					url,
					smdpHost: host,
					path: rx.fileName,
					headers: ES9_HEADERS,
					bodyBytes: rx.data,
					signal: opts.signal,
				}), opts.signal, zmodem.STATUS.ERR_ABORTED)
			} catch (e) {
				const isAbort = (opts.signal && opts.signal.aborted) || (e && e.zmodemCode === zmodem.STATUS.ERR_ABORTED)
				await abortAndThrow(i, isAbort ? 'aborted' : 'http-network', isAbort
					? '第 ' + (i + 1) + ' 轮请求 SM-DP+ 已被用户取消'
					: '第 ' + (i + 1) + ' 轮请求 SM-DP+ 失败: ' + (e && e.message ? e.message : e))
			}

			const httpStatus = Number(resp && resp.status)
			const bodyBytes = resp && resp.bodyBytes
				? (resp.bodyBytes instanceof Uint8Array ? resp.bodyBytes : Uint8Array.from(resp.bodyBytes))
				: new Uint8Array(0)

			onEvent({ type: 'http-done', round: i, path: spec.path, httpStatus, respBytes: bodyBytes.length })

			// 3) 严格校验 HTTP 状态码与业务执行状态
			if (i < 3) {
				if (httpStatus !== 200) {
					await abortAndThrow(i, 'http-status', '第 ' + (i + 1) + ' 轮 SM-DP+ 返回非 200 状态码: HTTP ' + httpStatus, { httpStatus })
				}
				if (bodyBytes.length === 0) {
					await abortAndThrow(i, 'http-body', '第 ' + (i + 1) + ' 轮 SM-DP+ 返回空响应体', { httpStatus })
				}
				let parsedJson
				try {
					parsedJson = JSON.parse(utf8Decode(bodyBytes))
				} catch (e) {
					await abortAndThrow(i, 'http-json', '第 ' + (i + 1) + ' 轮 SM-DP+ 响应不是合法 JSON', { httpStatus })
				}
				const fes = extractSmdpFailure(parsedJson)
				if (!fes.ok) {
					const detail = [fes.status, fes.subjectCode ? ('subjectCode=' + fes.subjectCode) : '', fes.reasonCode ? ('reasonCode=' + fes.reasonCode) : '', fes.message].filter(Boolean).join(' / ')
					await abortAndThrow(i, 'smdp-status', '第 ' + (i + 1) + ' 轮 SM-DP+ 业务失败: ' + detail, {
						httpStatus,
						subjectCode: fes.subjectCode,
						reasonCode: fes.reasonCode,
						smdpMessage: fes.message,
					})
				}

				// 4) ZMODEM 回传原始 JSON body 字节（expectedSize > 0，不含 HTTP 头）
				onEvent({ type: 'zmodem-tx-start', round: i, totalBytes: bodyBytes.length })
				try {
					await zmodem.send(io, { fileName: spec.path, data: bodyBytes }, Object.assign({}, zOpts, {
						onProgress: function (p) {
							onEvent({ type: 'zmodem-tx-progress', round: i, transferredBytes: p.transferredBytes, totalBytes: p.totalBytes })
						}
					}))
				} catch (e) {
					if (!e || e.zmodemCode !== zmodem.STATUS.ERR_IO) {
						await zmodem.sendAbort(io)
					}
					const msg = '第 ' + (i + 1) + ' 轮回传响应给 MCU 失败: ' + (e && e.message ? e.message : e)
					onEvent({ type: 'error', round: i, stage: 'zmodem-tx', message: msg })
					throw e
				}
				roundResults.push({ round: i, path: spec.path, httpStatus, reqBytes: rx.data.length, respBytes: bodyBytes.length })
			} else {
				// 第 4 轮 handleNotification：期望 HTTP 204，发 expectedSize == 0 空 ZMODEM 传输
				if (httpStatus !== 204) {
					await abortAndThrow(i, 'http-status', '第 4 轮 handleNotification 期望 HTTP 204，实际 HTTP ' + httpStatus, { httpStatus })
				}
				onEvent({ type: 'zmodem-tx-start', round: i, totalBytes: 0 })
				try {
					await zmodem.send(io, { fileName: spec.path, data: new Uint8Array(0) }, zOpts)
				} catch (e) {
					if (!e || e.zmodemCode !== zmodem.STATUS.ERR_IO) {
						await zmodem.sendAbort(io)
					}
					const msg = '第 4 轮空传输确认失败: ' + (e && e.message ? e.message : e)
					onEvent({ type: 'error', round: i, stage: 'zmodem-tx', message: msg })
					throw e
				}
				roundResults.push({ round: i, path: spec.path, httpStatus: 204, reqBytes: rx.data.length, respBytes: 0 })
			}

			onEvent({ type: 'round-done', round: i, path: spec.path, httpStatus })
		}

		onEvent({ type: 'session-done', rounds: roundResults })
		return { ok: true, rounds: roundResults }
	}

	const api = {
		ES9_ROUNDS,
		ES9_HEADERS,
		PROFILE_CLASS_LABELS,
		MODE_LABELS,
		OP_LABELS,
		STATE_LABELS,
		LAST_OP_LABELS,
		FAIL_STAGE_LABELS,
		QESIM_ERROR_HINTS,
		mapAtProfileClassToId1,
		decodeProfileFlags,
		encodeProfileFlags,
		parseActivationCode,
		encodeDownloadTrigger,
		redactDownloadValue,
		encodeProfileManage,
		decodeEid,
		decodeProfileList,
		decodeStatus,
		validateProfileAction,
		extractSmdpFailure,
		buildSmdpUrl,
		runMode1ProxySession,
	}

	if (typeof module !== 'undefined' && module.exports) module.exports = api
	root.EsimCore = api
})(typeof window !== 'undefined' ? window : globalThis)
