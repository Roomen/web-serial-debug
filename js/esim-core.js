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

	// EG800Z +QESIM 低 16 位常见错误码及排查建议（高 16 位恒为 0x8500，仅识别到 EG800Z 模组时启用）
	const QESIM_HTTP_TLS_ERR = { name: 'HTTP / TLS / 网络传输错误', hint: '检查蜂窝数据链路、APN、DNS 与 SM-DP+ TLS 连通性' }
	const QESIM_ERROR_HINTS = {
		0x0004: { name: '操作超时（卡无响应）', hint: '模组/eUICC 响应超时' },
		0x0005: { name: '通用错误（流程异常或服务器返回 Failed）', hint: '检查每轮 seq 是否从 0 重置，或确认服务端是否返回 Failed' },
		0x0008: { name: '消息发送错误（eUICC 休眠、飞行模式或无卡）', hint: '检查 CFUN=1 且已发送 AT+ECSIMSLEEP=0，确认 eUICC 在位' },
		0x000B: { name: 'APDU 解析错误（普通 USIM 或参数不合法）', hint: '确认设备装配的是 eUICC 而非普通 USIM，并核对指令参数' },
		0x000E: { name: '文件系统操作错误（如回灌含 HTTP 头响应）', hint: '确认只回灌纯 JSON body，不含 HTTP 响应头' },
		0x000F: QESIM_HTTP_TLS_ERR,
		0x0010: QESIM_HTTP_TLS_ERR,
		0x0011: QESIM_HTTP_TLS_ERR,
		0x0012: QESIM_HTTP_TLS_ERR,
		0x0013: QESIM_HTTP_TLS_ERR,
		0x0014: QESIM_HTTP_TLS_ERR,
		0x0015: QESIM_HTTP_TLS_ERR,
		0x0016: { name: 'SM-DP+ 返回错误（内网模式服务器侧拒绝）', hint: 'SM-DP+ 拒绝了本次请求，请核对激活码、订单状态与服务器配置' },
		0x0017: { name: '网络/连接超时', hint: '蜂窝网络或 SM-DP+ 连接超时，请检查信号质量与网络环境' },
		0x0018: { name: '网络/连接超时', hint: '蜂窝网络或 SM-DP+ 连接超时，请检查信号质量与网络环境' },
		0x0019: { name: '网络错误', hint: '检查蜂窝网络注册、PDP 激活状态与信号质量' },
		0x0102: { name: '启用失败：Profile 已处于启用态', hint: '目标卡已启用，无需重复启用' },
		0x0105: { name: '启用失败：卡应用繁忙（需整机/模组断电重启）', hint: '软复位无效，必须对模组/整机断电重启后复测' },
		0x0203: { name: '禁用失败：PPR 策略禁止禁用', hint: '该 Profile 受 eUICC PPR 保护，不允许禁用' },
		0x0204: { name: '禁用失败：卡应用繁忙', hint: '软复位无效，必须对模组/整机断电重启后复测' },
		0x0302: { name: '删除失败：目标 Profile 仍处于启用态', hint: '请先禁用该 Profile 后再删除' },
		0x0303: { name: '删除失败：PPR 策略禁止删除', hint: '该 Profile 受 eUICC PPR 保护，不允许删除' },
		0x0704: { name: '认证服务器错误：无会话上下文', hint: '会话上下文已失效，请重新发起下载流程' },
		0x0705: { name: '认证服务器错误：无效 OID（证书/OID 不匹配）', hint: '激活码含无效 OID 或证书不匹配，请向发卡侧核对 AC；勿盲目重试' },
		0x0706: { name: 'eUICC Challenge 不匹配（复用旧会话响应）', hint: '不可复用旧会话响应；请重新发起流程，勿盲目重试' },
		0x0909: { name: '安装失败：ICCID 已存在（重复下载同订单）', hint: '卡内已有相同 ICCID 的 Profile；勿盲目重试' },
		0x090C: { name: '安装失败：PE 处理错误（卡内残留同订单 Profile 或空间冲突）', hint: '卡内可能残留同订单 Profile 或空间冲突，请先清理后再下发；勿盲目重试' },
		0x0B03: { name: '客户端认证错误：eUICC 证书无效', hint: '请核对 eUICC 证书链与 SM-DP+ 环境（正式/测试 CI）是否匹配' },
		0x0B04: { name: '客户端认证错误：eUICC 证书已过期', hint: '请核对设备或证书有效期及发卡环境' },
		0x0B05: { name: '客户端认证错误：eUICC 签名无效', hint: 'eUICC 签名校验未通过，请核对证书链与卡片状态' },
		0x0B06: { name: '客户端认证错误：MatchingID 被拒绝', hint: '请向发卡侧核对激活码中的 MatchingID 及订单状态；勿盲目重试' },
		0x0B07: { name: '客户端认证错误：EID 不匹配', hint: '当前设备 EID 与订单绑定 EID 不一致，请核对 EID；勿盲目重试' },
		0x0B08: { name: '客户端认证错误：没有符合条件的 Profile', hint: '发卡平台无匹配当前设备的可下载 Profile，请核对订单' },
		0x0B09: { name: '客户端认证错误：未知的 CI 公钥', hint: 'SM-DP+ 与 eUICC 根证书（CI）不匹配，请确认测试/正式环境' },
		0x0B0A: { name: '客户端认证错误：交易 ID 未知', hint: '交易 ID 已过期或不存在，请重新发起下载' },
		0x0B0B: { name: '客户端认证错误：eUICC 存储空间不足', hint: '请先清理无用的禁用态 Profile 释放 eUICC 存储空间' },
	}

	// 0xE1xx：模组 +CME ERROR 常见数字码说明
	const CME_ERROR_HINTS = {
		10: { name: 'SIM 未插入', hint: '检查 SIM/eUICC 接触、供电或卡槽' },
		13: { name: 'SIM 故障', hint: '检查 eUICC 状态或尝试对模组断电重启' },
		53: { name: '参数非法', hint: '检查 AT 指令参数格式或长度（如大包回灌 totallen）' },
	}

	// 0xE2xx：mode=0 上电/入网与前置步骤失败
	const PRECOND_ERROR_HINTS = {
		0xE201: { name: '模组上电失败（commuEnable）', hint: '检查模组供电、电源控制引脚与硬件连接' },
		0xE202: { name: '模组未就绪或 AT+CFUN=1 失败', hint: '检查模组串口通信、启动状态与射频使能' },
		0xE203: { name: 'AT+CEREG 驻网超时/预算耗尽', hint: '检查天线、信号覆盖与当前启用 Profile 的运营商驻网能力' },
		0xE204: { name: 'AT+CGATT PS 附着超时/预算耗尽', hint: '检查当前 Profile 数据业务状态与蜂窝网络覆盖' },
		0xE205: { name: 'AT+QIACT=1 PDP 激活失败（常见于 APN 错误或未签约）', hint: '核对设备 APN 配置及当前 Profile 的数据业务签约状态' },
		0xE206: { name: 'AT+QIACT? PDP 激活查询超时/预算耗尽', hint: '检查蜂窝网络稳定性，稍后重试 PDP 激活' },
		0xE207: { name: 'AT+CSQ/AT+QENG 信号查询失败', hint: '检查模组信号质量与驻网状态' },
		0xE208: { name: 'mode=1 近端代理通道未就绪', hint: '检查近端通信通道状态及固件近端代理能力开关' },
	}

	// 0xE3se：AT+QESIM 会话状态机内部错误
	const QESIM_FSM_STATES = {
		0x0: 'IDLE',
		0x1: 'WAIT_ATE0_OK',
		0x2: 'WAIT_CMEE_OK',
		0x3: 'WAIT_CFUN_OK',
		0x4: 'WAIT_SIMSLEEP_OK',
		0x5: 'WAIT_DOWNLOAD_OK',
		0x6: 'WAIT_URC',
		0x7: 'TRANS_PENDING',
		0x8: 'REINJECTING',
		0x9: 'WAIT_FINAL_RESULT',
		0xA: 'DONE',
		0xB: 'ABORTED',
	}
	const QESIM_FSM_ERRORS = {
		0x1: { name: '参数错', hint: '核对下发参数与命令长度' },
		0x2: { name: '前置条件不满足', hint: '检查模组就绪状态与执行前提' },
		0x3: { name: 'AC 格式错', hint: '核对激活码格式 LPA:1$<host>$<matchingId>' },
		0x4: { name: '缓冲/长度溢出', hint: '响应或命令超出固件静态缓冲上限' },
		0x5: { name: '会话忙', hint: '当前已有进行中的 eSIM 会话，请等待结束后重试' },
		0x6: { name: '串口发送失败', hint: '检查 MCU 与模组之间的串口通信' },
		0x7: { name: '超时', hint: '等待模组 AT 应答或 URC 超时，检查模组与网络状态' },
		0x8: { name: 'AT 返回 ERROR', hint: '模组返回 AT ERROR，请结合中止状态排查对应 AT 指令' },
		0x9: { name: '协议格式错', hint: '模组返回 URC 或应答格式不符合预期' },
		0xA: { name: '轮次乱序', hint: 'ES9+ 四轮交互顺序异常，请重新发起下载' },
		0xB: { name: 'HTTP 状态码非法', hint: '第 1~3 轮期望 HTTP 200，第 4 轮期望 HTTP 204' },
		0xC: { name: '响应含 HTTP 头', hint: '回灌数据只能是纯 JSON body，不能包含 HTTP 响应头' },
		0xD: { name: 'EOF 长度不符', hint: '实际接收字节数与声明长度不一致，请重新传输' },
		0xE: { name: '下载错误码', hint: '模组下载流程返回错误码' },
		0xF: { name: '部分中止', hint: '流程中途异常中止，请核对 Profile 列表确认是否已落盘' },
	}

	// 0xE4rn：mode=1 近端 ZMODEM 传输失败
	const ZMODEM_ERRORS = {
		0x1: { name: '参数错', hint: '检查 ZMODEM 传输参数配置' },
		0x2: { name: '读超时', hint: '等待对端 ZMODEM 数据超时，请检查近端代理状态与链路连接' },
		0x3: { name: 'I/O 断开', hint: '近端通信链路断开（如 BLE 断连），请重连后刷新 ID4 核对终态' },
		0x4: { name: 'CRC 校验错', hint: '传输发生误码，请检查串口参数或近端信号质量' },
		0x5: { name: 'ZDLE 转义错', hint: '传输帧转义序列异常，可能存在字节丢失或链路干扰' },
		0x6: { name: '子包超长溢出', hint: '单块 ZMODEM 子包超过固件接收缓冲上限' },
		0x7: { name: 'EOF/长度错', hint: '实际传输长度与 ZFILE 声明长度不符' },
		0x8: { name: '偏移错位', hint: '传输偏移不同步，请重新发起下载' },
		0x9: { name: '不支持帧型', hint: '收到固件不支持的 ZMODEM 帧类型' },
		0xA: { name: '写入回调失败', hint: 'MCU 流式回灌写入回调失败，可能为模组返回错误或响应体异常' },
		0xB: { name: '对端 CAN 取消（如 SM-DP+ 业务失败中止）', hint: '近端代理主动中止会话，请查看上位机操作日志中的 SM-DP+ 错误原因' },
		0xC: { name: '重试耗尽', hint: '连续重传失败，请检查通信链路稳定性' },
		0xD: { name: '协议违例', hint: 'ZMODEM 交互状态违例，请重新发起下载' },
		0xE: { name: '未收到 ZFILE', hint: '未收到对端 ZFILE 文件头，请检查近端代理是否正常响应' },
	}

	const UNIDENTIFIED_MODULE_HINT = '未识别当前模组型号，暂不套用 EG800Z 专属错误码表；如需解析模组原码，请先查询基础数据（Tag1）获取模组版本号'

	function cleanModuleText(str) {
		const s = String(str == null ? '' : str).replace(/\x00/g, '').trim()
		if (!s) return ''
		for (let i = 0; i < s.length; i++) {
			const c = s.charCodeAt(i)
			if (c < 0x20 || c > 0x7e) return ''
		}
		if (/^[-_0.\s]+$/.test(s)) return ''
		return s
	}

	function extractModulePrefix(str) {
		const s = cleanModuleText(str)
		if (!s) return ''
		const stripped = s.replace(/^quectel[\s_-]+/i, '')
		const m = /^([A-Za-z]{2,4}\d{2,4}[A-Za-z]?)/.exec(stripped)
		return m ? m[1].toUpperCase() : stripped.split(/[\s_/-]/)[0].toUpperCase()
	}

	function isEg800zPrefix(ver, model) {
		const v = cleanModuleText(ver)
		const m = cleanModuleText(model)
		return /^eg800z/i.test(v) || /^(?:quectel[\s_-]*)?eg800z/i.test(m)
	}

	function detectModuleProfile(input) {
		if (!input) {
			return { known: false, isEg800z: false, family: 'unknown', modelPrefix: '', label: '', moduleVersion: '', moduleModel: '' }
		}
		if (typeof input === 'string') {
			const ver = cleanModuleText(input)
			if (!ver) return { known: false, isEg800z: false, family: 'unknown', modelPrefix: '', label: '', moduleVersion: '', moduleModel: '' }
			const isEg800z = isEg800zPrefix(ver, '')
			const modelPrefix = isEg800z ? 'EG800Z' : extractModulePrefix(ver)
			return { known: true, isEg800z, family: isEg800z ? 'eg800z' : 'other', modelPrefix, label: modelPrefix || ver, moduleVersion: ver, moduleModel: '' }
		}
		if (typeof input === 'object') {
			const src = input.moduleInfo && typeof input.moduleInfo === 'object' ? input.moduleInfo : input
			const ver = cleanModuleText(src.moduleVersion != null ? src.moduleVersion : src.version)
			const model = cleanModuleText(src.moduleModel != null ? src.moduleModel : src.model)
			if (ver || model) {
				const isEg800z = isEg800zPrefix(ver, model)
				const modelPrefix = isEg800z ? 'EG800Z' : (extractModulePrefix(model) || extractModulePrefix(ver))
				return {
					known: true,
					isEg800z,
					family: isEg800z ? 'eg800z' : 'other',
					modelPrefix,
					label: modelPrefix || model || ver,
					moduleVersion: ver,
					moduleModel: model,
				}
			}
			if (typeof src.isEg800z === 'boolean') {
				const known = src.known !== undefined ? !!src.known : src.isEg800z
				if (!known) return { known: false, isEg800z: false, family: 'unknown', modelPrefix: '', label: '', moduleVersion: '', moduleModel: '' }
				const prefix = src.isEg800z ? 'EG800Z' : cleanModuleText(src.modelPrefix || src.label)
				return {
					known: true,
					isEg800z: src.isEg800z,
					family: src.isEg800z ? 'eg800z' : 'other',
					modelPrefix: prefix,
					label: prefix,
					moduleVersion: '',
					moduleModel: '',
				}
			}
		}
		return { known: false, isEg800z: false, family: 'unknown', modelPrefix: '', label: '', moduleVersion: '', moduleModel: '' }
	}

	function decodeModuleErrCode(rawCode, moduleInput) {
		const code = (Number(rawCode) || 0) & 0xffff
		const errHex = code.toString(16).toUpperCase().padStart(4, '0')
		const hex = '0x' + errHex
		const mod = detectModuleProfile(moduleInput)

		if (code === 0) {
			return {
				code: 0,
				hex: '0x0000',
				category: 'none',
				qesimFullCode: '',
				name: '',
				hint: '',
				displayText: '0x0000',
				detail: null,
				module: mod,
			}
		}

		// 1) 0xE1xx：模组 +CME ERROR: <n>
		if ((code & 0xff00) === 0xe100) {
			const cme = code & 0xff
			const saturated = cme === 0xff
			const info = !saturated ? (CME_ERROR_HINTS[cme] || null) : null
			const name = saturated
				? '+CME ERROR: ≥255'
				: ('+CME ERROR: ' + cme + (info ? ' (' + info.name + ')' : ''))
			return {
				code,
				hex,
				category: 'cme',
				qesimFullCode: '',
				name,
				hint: info ? info.hint : '',
				displayText: hex + ' (' + name + ')',
				detail: { cmeCode: cme, saturated },
				module: mod,
			}
		}

		// 2) 0xE2xx：mode=0 上电/入网与前置步骤失败
		if ((code & 0xff00) === 0xe200) {
			const info = PRECOND_ERROR_HINTS[code] || null
			const name = info ? info.name : ('前置/入网步骤失败 (' + hex + ')')
			return {
				code,
				hex,
				category: 'precond',
				qesimFullCode: '',
				name,
				hint: info ? info.hint : '',
				displayText: hex + ' (' + name + ')',
				detail: { stepCode: code & 0xff },
				module: mod,
			}
		}

		// 3) 0xE3se：AT+QESIM 会话状态机内部错误
		if ((code & 0xff00) === 0xe300) {
			const stateCode = (code >>> 4) & 0x0f
			const statusCode = code & 0x0f
			const stateName = QESIM_FSM_STATES[stateCode] || ('STATE_0x' + stateCode.toString(16).toUpperCase())
			const errInfo = QESIM_FSM_ERRORS[statusCode] || null
			const statusName = errInfo ? errInfo.name : ('未知错误(' + statusCode + ')')
			const name = 'AT+QESIM 状态机[' + stateName + ']：' + statusName
			return {
				code,
				hex,
				category: 'qesim-fsm',
				qesimFullCode: '',
				name,
				hint: errInfo ? errInfo.hint : '',
				displayText: hex + ' (' + name + ')',
				detail: { stateCode, stateName, statusCode, statusName },
				module: mod,
			}
		}

		// 4) 0xE4rn：mode=1 近端 ZMODEM 传输失败
		if ((code & 0xff00) === 0xe400) {
			const r = (code >>> 4) & 0x0f
			const dir = (r >>> 3) & 0x01
			const round = r & 0x07
			const zCode = code & 0x0f
			const dirLabel = dir === 0 ? 'MCU→Host 发请求' : 'Host→MCU 收响应'
			const roundLabel = round >= 1 && round <= 4 ? ('第 ' + round + ' 轮') : (round === 0 ? '未知轮次' : ('轮次' + round))
			const zInfo = ZMODEM_ERRORS[zCode] || null
			const zName = zInfo ? zInfo.name : ('未知错误(0x' + zCode.toString(16).toUpperCase() + ')')
			const name = 'ZMODEM ' + roundLabel + '·' + dirLabel + '：' + zName
			return {
				code,
				hex,
				category: 'zmodem',
				qesimFullCode: '',
				name,
				hint: zInfo ? zInfo.hint : '',
				displayText: hex + ' (' + name + ')',
				detail: { dir, dirLabel, round, roundLabel, zmodemCode: zCode, zmodemName: zName },
				module: mod,
			}
		}

		// 5) 0x0001 ~ 0x117F：EG800Z +QESIM 原始 32 位码低 16 位（仅在已识别为 EG800Z 模组时映射）
		if (code >= 0x0001 && code <= 0x117f) {
			if (mod.isEg800z) {
				const qesimFullCode = '0x8500' + errHex
				const info = QESIM_ERROR_HINTS[code] || null
				const name = info ? info.name : ''
				const displayText = hex + ' (' + qesimFullCode + (name ? ' · ' + name : '') + ')'
				return {
					code,
					hex,
					category: 'qesim',
					qesimFullCode,
					name,
					hint: info ? info.hint : '',
					displayText,
					detail: { fullCode: qesimFullCode },
					module: mod,
				}
			}
			if (!mod.known) {
				return {
					code,
					hex,
					category: 'module-unidentified',
					qesimFullCode: '',
					name: '',
					hint: UNIDENTIFIED_MODULE_HINT,
					displayText: hex + '（未识别模组）',
					detail: null,
					module: mod,
				}
			}
			return {
				code,
				hex,
				category: 'module-other',
				qesimFullCode: '',
				name: '',
				hint: '',
				displayText: hex,
				detail: null,
				module: mod,
			}
		}

		// 6) 其他未定义区间
		return {
			code,
			hex,
			category: 'unknown',
			qesimFullCode: '',
			name: '',
			hint: '',
			displayText: hex,
			detail: null,
			module: mod,
		}
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

	function decodeStatus(raw, opts) {
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
		const errDecoded = decodeModuleErrCode(moduleErrCode, opts)
		return {
			state,
			stateLabel: STATE_LABELS[state] || ('未知(' + state + ')'),
			lastOp,
			lastOpLabel: LAST_OP_LABELS[lastOp] || ('未知(' + lastOp + ')'),
			failStage,
			failStageLabel: FAIL_STAGE_LABELS[failStage] || ('未知(' + failStage + ')'),
			moduleErrCode,
			moduleErrHex: errDecoded.hex,
			qesimFullCode: errDecoded.qesimFullCode,
			errCategory: errDecoded.category,
			errName: errDecoded.name,
			errHint: errDecoded.hint,
			errDisplay: errDecoded.displayText,
			errDetail: errDecoded.detail,
			moduleInfo: errDecoded.module,
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
		CME_ERROR_HINTS,
		PRECOND_ERROR_HINTS,
		QESIM_FSM_STATES,
		QESIM_FSM_ERRORS,
		ZMODEM_ERRORS,
		detectModuleProfile,
		decodeModuleErrCode,
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
