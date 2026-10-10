// 蜂窝模组 AT 指令协议解析器（支持 EG800Z / BC660K / EG800K 及通用 4G / NB-IoT 模组）
// 核心关注场景：驻网与信号、系统校时、各类通信方式上报（Socket、MQTT、HTTP、NB-IoT报文）与通用错误码
// 解析结果直接聚焦业务与物理量语义，无需指明具体模组或厂商型号，输出适配 ParseView 与检查器。
;(function () {
	'use strict'

	const root = typeof window !== 'undefined' ? window : globalThis

	// ---- 3GPP & 模组错误码字典 ----

	const CME_ERRORS = {
		0: '电话或模组硬件故障',
		1: '与模组连接异常',
		2: '适配器链路保留',
		3: '操作不允许 (Operation not allowed)',
		4: '操作不支持 (Operation not supported)',
		5: '需要 PH-SIM PIN 密码',
		6: '需要 PH-FSIM PIN 密码',
		7: '需要 PH-FSIM PUK 密码',
		10: 'SIM 卡未插入 (SIM not inserted)',
		11: '需要输入 SIM PIN',
		12: '需要输入 SIM PUK',
		13: 'SIM 卡硬件故障 (SIM failure)',
		14: 'SIM 卡忙 (SIM busy)',
		15: 'SIM 卡被拒绝或错误 (SIM wrong)',
		16: '密码错误 (Incorrect password)',
		17: '需要输入 SIM PIN2',
		18: '需要输入 SIM PUK2',
		20: '存储空间已满 (Memory full)',
		21: '无效的索引 (Invalid index)',
		22: '未找到指定条目 (Not found)',
		23: '存储器硬件故障 (Memory failure)',
		24: '文本长度超限',
		25: '包含无效文本字符',
		26: '拨号串过长',
		27: '包含无效拨号字符',
		30: '找不到网络服务 (No network service)',
		31: '网络服务搜索超时 (Network timeout)',
		32: '当前仅限紧急呼叫',
		40: '网络个性化 PIN 需求',
		100: '未知错误 (Unknown error)',
		103: 'GPRS 业务不被允许',
		107: 'GPRS 业务被网络拒绝',
		111: 'PLMN 运营商不被允许',
		112: '当前位置区域 (LAC) 不被允许',
		113: '漫游在此区域不被允许',
		132: '服务选项不支持',
		133: '未订阅该网络服务选项',
		134: '服务选项暂时不可用',
		148: '未指定的 GPRS 异常',
		149: 'PDP 鉴权失败',
	}

	const CMS_ERRORS = {
		1: '未分配的号码',
		8: '运营商拦截',
		10: '呼叫或连接被拒绝',
		21: '短消息被拒绝',
		27: '目标网络地址不可达',
		30: '未知订阅用户',
		38: '网络脱网/失步',
		41: '临时性网络故障',
		42: '网络拥塞',
		301: 'SMS 业务保留',
		302: '操作不允许',
		303: '操作不支持',
		304: '短信中心地址未知',
		305: 'SIM 卡存储已满',
		500: '未知网络错误',
	}

	const REG_STAT_MAP = {
		0: { text: '未注册 (未在搜网)', kind: 'warn' },
		1: { text: '已注册 (本地网络)', kind: 'ok' },
		2: { text: '搜网注册中...', kind: 'warn' },
		3: { text: '注册被网络拒绝', kind: 'bad' },
		4: { text: '未知网络状态', kind: 'warn' },
		5: { text: '已注册 (漫游网络)', kind: 'ok' },
		6: { text: '仅限 SMS 业务 (本地)', kind: 'info' },
		7: { text: '仅限 SMS 业务 (漫游)', kind: 'info' },
		8: { text: '仅允许紧急呼叫', kind: 'bad' },
		9: { text: '已注册 (CSFB 不适用)', kind: 'info' },
		10: { text: '仅允许紧急呼叫 (仅E-UTRAN)', kind: 'bad' },
	}

	const ACT_MAP = {
		0: 'GSM (2G)',
		1: 'GSM Compact',
		2: 'UTRAN (3G)',
		3: 'GSM w/EGPRS',
		4: 'UTRAN w/HSDPA',
		5: 'UTRAN w/HSUPA',
		6: 'UTRAN w/HSPA',
		7: 'LTE (4G Cat 1 / Cat 4)',
		8: 'eMTC (Cat M)',
		9: 'NB-IoT',
	}

	function cmeDesc(code) {
		const num = parseInt(code, 10)
		return CME_ERRORS[num] || ('设备错误 0x' + num.toString(16).toUpperCase() + ' (' + num + ')')
	}

	function cmsDesc(code) {
		const num = parseInt(code, 10)
		return CMS_ERRORS[num] || ('网络错误 ' + num)
	}

	// 识别运营商名称与格式化
	function formatOperator(raw) {
		if (!raw) return '未知运营商'
		const clean = raw.replace(/["']/g, '').trim()
		if (/^46000|^46002|^46004|^46007|^46008|CMCC|CHINA MOBILE/i.test(clean)) return '中国移动'
		if (/^46001|^46006|^46009|^46010|UNICOM|CHINA UNICOM/i.test(clean)) return '中国联通'
		if (/^46003|^46005|^46011|CT|CHINA TELECOM/i.test(clean)) return '中国电信'
		if (/^46015|CBN|BROADNET/i.test(clean)) return '中国广电'
		return clean
	}

	// ---- 物理量换算函数 ----

	function parseCsq(argStr) {
		const parts = argStr.split(',').map(function (s) { return s.trim() })
		const rssi = parseInt(parts[0], 10)
		const ber = parts.length > 1 ? parseInt(parts[1], 10) : 99
		if (isNaN(rssi)) return null
		let dbm = null
		let rating = '未知'
		let kind = 'bad'
		if (rssi === 99) {
			rating = '无信号 / 未知'
			kind = 'bad'
		} else if (rssi === 0) {
			dbm = -113
			rating = '极弱 (≤ -113 dBm)'
			kind = 'bad'
		} else if (rssi >= 1 && rssi <= 31) {
			dbm = -113 + rssi * 2
			if (rssi >= 20) {
				rating = '极好 (≥ -73 dBm)'
				kind = 'ok'
			} else if (rssi >= 15) {
				rating = '良好 (-83 ~ -75 dBm)'
				kind = 'ok'
			} else if (rssi >= 10) {
				rating = '中等 (-93 ~ -85 dBm)'
				kind = 'info'
			} else {
				rating = '微弱 (≤ -95 dBm)'
				kind = 'warn'
			}
		}
		return { rssi: rssi, ber: ber, dbm: dbm, rating: rating, kind: kind }
	}

	function parseCesq(argStr) {
		const parts = argStr.split(',').map(function (s) { return parseInt(s.trim(), 10) })
		if (parts.length < 6) return null
		const rxlev = parts[0]
		const ber = parts[1]
		const rscp = parts[2]
		const ecno = parts[3]
		const rsrq = parts[4]
		const rsrp = parts[5]

		let rsrpStr = '未知'
		let rsrpKind = 'bad'
		if (rsrp !== 255 && !isNaN(rsrp)) {
			const dbm = -140 + rsrp
			rsrpStr = dbm + ' dBm'
			rsrpKind = dbm >= -95 ? 'ok' : (dbm >= -110 ? 'info' : 'warn')
		}
		let rsrqStr = '未知'
		let rsrqKind = 'info'
		if (rsrq !== 255 && !isNaN(rsrq)) {
			const db = -19.5 + rsrq * 0.5
			rsrqStr = db.toFixed(1) + ' dB'
			rsrqKind = db >= -10 ? 'ok' : (db >= -15 ? 'info' : 'warn')
		}
		return { rxlev: rxlev, ber: ber, rscp: rscp, ecno: ecno, rsrq: rsrq, rsrp: rsrp, rsrpStr: rsrpStr, rsrpKind: rsrpKind, rsrqStr: rsrqStr, rsrqKind: rsrqKind }
	}

	function parseCclk(str) {
		// "yy/MM/dd,hh:mm:ss±zz"
		const match = str.match(/["']?(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})([+-]\d{1,2})?["']?/)
		if (!match) return null
		const yy = match[1]
		const MM = match[2]
		const dd = match[3]
		const hh = match[4]
		const mm = match[5]
		const ss = match[6]
		const zz = match[7]

		const yearNum = parseInt(yy, 10)
		const fullYear = (yearNum >= 70 ? 1900 : 2000) + yearNum
		const isoDate = fullYear + '-' + MM + '-' + dd + ' ' + hh + ':' + mm + ':' + ss
		let tzDesc = 'UTC+8'
		if (zz) {
			const tzQuarter = parseInt(zz, 10)
			const tzHour = tzQuarter * 15 / 60
			tzDesc = 'UTC' + (tzHour >= 0 ? '+' + tzHour : String(tzHour))
		}
		const isCalibrated = fullYear >= 2024
		return {
			isoDate: isoDate,
			tzDesc: tzDesc,
			isCalibrated: isCalibrated,
			fullYear: fullYear,
		}
	}

	// 辅助解析双引号括起的参数列表或逗号分隔列表
	function splitCsvArgs(str) {
		const res = []
		let cur = ''
		let inQuote = false
		for (let i = 0; i < str.length; i++) {
			const c = str[i]
			if (c === '"') {
				inQuote = !inQuote
			} else if (c === ',' && !inQuote) {
				res.push(cur.trim())
				cur = ''
			} else {
				cur += c
			}
		}
		res.push(cur.trim())
		return res
	}

	function cleanQuotes(s) {
		return String(s || '').replace(/^["']|["']$/g, '').trim()
	}

	// ---- 单行识别与语义提取 ----

	function parseLine(line) {
		const raw = line.trim()
		if (!raw) return null

		// 1. 提示符 >
		if (raw === '>' || raw.startsWith('> ')) {
			return {
				type: 'prompt',
				title: '输入提示符 (>)',
				code: '>',
				dir: 'down',
				badges: [{ text: '等待数据输入', kind: 'warn' }],
				pairs: [['提示符', '> (模组已准备好接收数据载荷)']],
			}
		}

		// 2. 标准结果码
		if (raw === 'OK') {
			return {
				type: 'result',
				title: '执行成功 (OK)',
				code: 'OK',
				dir: 'down',
				badges: [{ text: 'OK', kind: 'ok' }],
			}
		}
		if (raw === 'ERROR') {
			return {
				type: 'result',
				title: '执行失败 (ERROR)',
				code: 'ERROR',
				dir: 'down',
				badges: [{ text: 'ERROR', kind: 'bad' }],
			}
		}
		if (raw === 'SEND OK') {
			return {
				type: 'send_result',
				title: '数据发送完成',
				code: 'SEND OK',
				dir: 'down',
				badges: [{ text: '发送成功 (SEND OK)', kind: 'ok' }],
			}
		}
		if (raw === 'SEND FAIL') {
			return {
				type: 'send_result',
				title: '数据发送失败',
				code: 'SEND FAIL',
				dir: 'down',
				badges: [{ text: '发送失败 (SEND FAIL)', kind: 'bad' }],
			}
		}

		// 3. CME / CMS 错误
		let m = raw.match(/^\+CME ERROR:\s*(\d+)/i)
		if (m) {
			const code = m[1]
			const desc = cmeDesc(code)
			return {
				type: 'cme_error',
				title: '设备执行错误 (+CME ERROR)',
				code: '+CME ERROR: ' + code,
				dir: 'down',
				badges: [{ text: desc, kind: 'bad' }],
				pairs: [
					['错误码', code],
					['错误说明', desc],
				],
			}
		}
		m = raw.match(/^\+CMS ERROR:\s*(\d+)/i)
		if (m) {
			const code = m[1]
			const desc = cmsDesc(code)
			return {
				type: 'cms_error',
				title: '网络业务错误 (+CMS ERROR)',
				code: '+CMS ERROR: ' + code,
				dir: 'down',
				badges: [{ text: desc, kind: 'bad' }],
				pairs: [
					['错误码', code],
					['错误说明', desc],
				],
			}
		}

		// 4. 系统启动与事件上报
		if (raw === 'RDY') {
			return {
				type: 'urc',
				title: '模组上电就绪 (RDY)',
				code: 'RDY',
				dir: 'down',
				badges: [{ text: '开机就绪', kind: 'info' }, { text: 'URC', kind: 'info' }],
				pairs: [['事件', '模组完成基础初始化，串口就绪']],
			}
		}
		if (raw === 'POWERED DOWN' || raw === 'NORMAL POWER DOWN') {
			return {
				type: 'urc',
				title: '模组已关机',
				code: raw,
				dir: 'down',
				badges: [{ text: '已关机', kind: 'warn' }, { text: 'URC', kind: 'info' }],
				pairs: [['事件', raw === 'NORMAL POWER DOWN' ? '正常软件下电完成' : '断电关机']],
			}
		}

		// 5. AT 指令发起 (MCU -> MOD)
		if (/^AT/i.test(raw)) {
			return parseAtCommand(raw)
		}

		// 6. 模组响应或主动上报 (+CMD: ...)
		if (/^\+[A-Z0-9_]+:/i.test(raw)) {
			return parseAtResponseOrUrc(raw)
		}

		// 7. 载荷数据行 (Payload fallback)
		return parsePayloadLine(raw)
	}

	// ---- 解析 AT 命令 (MCU 下发) ----

	function parseAtCommand(raw) {
		const cmd = raw.trim()
		const upDir = 'up'

		// 纯握手
		if (/^AT\r?$/i.test(cmd)) {
			return {
				type: 'cmd_handshake',
				title: '通信握手测试',
				code: 'AT',
				dir: upDir,
				badges: [{ text: 'AT 测试', kind: 'info' }],
				pairs: [['功能', '测试串口通信与波特率自适应']],
			}
		}
		// 回显设置
		if (/^ATE[01]/i.test(cmd)) {
			const echoOn = cmd.toUpperCase().indexOf('ATE1') !== -1
			return {
				type: 'cmd_echo',
				title: '命令回显配置',
				code: cmd,
				dir: upDir,
				badges: [{ text: echoOn ? '回显开启' : '回显关闭', kind: 'info' }],
				pairs: [['功能', echoOn ? '开启串口输入回显 (ATE1)' : '关闭串口输入回显 (ATE0)']],
			}
		}
		// 产品信息
		if (/^ATI/i.test(cmd)) {
			return {
				type: 'cmd_info',
				title: '查询模组产品信息',
				code: 'ATI',
				dir: upDir,
				badges: [{ text: '查询信息', kind: 'info' }],
			}
		}
		// IMEI / IMSI / ICCID
		if (/^AT\+GSN/i.test(cmd) || /^AT\+CGSN/i.test(cmd)) {
			return { type: 'cmd_imei', title: '查询 IMEI 串号', code: cmd, dir: upDir }
		}
		if (/^AT\+CIMI/i.test(cmd)) {
			return { type: 'cmd_imsi', title: '查询 IMSI 国际移动用户识别码', code: cmd, dir: upDir }
		}
		if (/^AT\+CCID/i.test(cmd) || /^AT\+QCCID/i.test(cmd)) {
			return { type: 'cmd_iccid', title: '查询 SIM 卡 ICCID 识别码', code: cmd, dir: upDir }
		}

		// 驻网：SIM 状态
		if (/^AT\+CPIN\?/i.test(cmd)) {
			return {
				type: 'cmd_cpin',
				title: '查询 SIM 卡状态',
				code: 'AT+CPIN?',
				dir: upDir,
				badges: [{ text: '查询 SIM', kind: 'info' }],
			}
		}
		// 驻网：信号 CSQ / CESQ
		if (/^AT\+CSQ/i.test(cmd)) {
			return {
				type: 'cmd_csq',
				title: '查询信号质量 (CSQ)',
				code: 'AT+CSQ',
				dir: upDir,
				badges: [{ text: '查询信号', kind: 'info' }],
			}
		}
		if (/^AT\+CESQ/i.test(cmd)) {
			return {
				type: 'cmd_cesq',
				title: '查询扩展信号质量 (CESQ)',
				code: 'AT+CESQ',
				dir: upDir,
				badges: [{ text: '查询 LTE 信号', kind: 'info' }],
			}
		}
		// 驻网：网络注册
		if (/^AT\+(CREG|CEREG|CGREG)\?/i.test(cmd)) {
			const tag = cmd.match(/\+(CREG|CEREG|CGREG)/i)[1].toUpperCase()
			return {
				type: 'cmd_reg',
				title: '查询网络注册状态 (' + tag + ')',
				code: cmd,
				dir: upDir,
				badges: [{ text: '查询注册', kind: 'info' }],
			}
		}
		if (/^AT\+(CREG|CEREG|CGREG)=/i.test(cmd)) {
			const tag = cmd.match(/\+(CREG|CEREG|CGREG)/i)[1].toUpperCase()
			return {
				type: 'cmd_reg_cfg',
				title: '配置网络注册上报 (' + tag + ')',
				code: cmd,
				dir: upDir,
			}
		}
		// 驻网：PS 附着
		if (/^AT\+CGATT\?/i.test(cmd)) {
			return {
				type: 'cmd_cgatt',
				title: '查询 PS 数据附着状态',
				code: 'AT+CGATT?',
				dir: upDir,
				badges: [{ text: '查询附着', kind: 'info' }],
			}
		}
		if (/^AT\+CGATT=(\d)/i.test(cmd)) {
			const attach = cmd.match(/=(\d)/)[1] === '1'
			return {
				type: 'cmd_cgatt_set',
				title: attach ? '请求 PS 数据附着' : '请求分离 PS 业务',
				code: cmd,
				dir: upDir,
				badges: [{ text: attach ? '附着网络' : '脱网分离', kind: attach ? 'ok' : 'warn' }],
			}
		}
		// 驻网：运营商
		if (/^AT\+COPS\?/i.test(cmd)) {
			return {
				type: 'cmd_cops',
				title: '查询当前驻留运营商',
				code: 'AT+COPS?',
				dir: upDir,
				badges: [{ text: '查询运营商', kind: 'info' }],
			}
		}
		// 驻网：工程小区
		if (/^AT\+QENG/i.test(cmd)) {
			return {
				type: 'cmd_qeng',
				title: '查询服务小区工程参数',
				code: cmd,
				dir: upDir,
			}
		}
		// 模组功能状态 CFUN
		if (/^AT\+CFUN\?/i.test(cmd)) {
			return { type: 'cmd_cfun', title: '查询模组功能状态', code: 'AT+CFUN?', dir: upDir }
		}
		if (/^AT\+CFUN=(\d)/i.test(cmd)) {
			const mode = cmd.match(/=(\d)/)[1]
			const modeName = mode === '1' ? '全功能 (正常射频)' : (mode === '4' ? '飞行模式' : '最小功能')
			return {
				type: 'cmd_cfun_set',
				title: '设置模组功能模式',
				code: cmd,
				dir: upDir,
				badges: [{ text: modeName, kind: mode === '1' ? 'ok' : 'warn' }],
			}
		}
		// 信令连接 CSCON
		if (/^AT\+CSCON\?/i.test(cmd)) {
			return { type: 'cmd_cscon', title: '查询无线信令连接状态', code: 'AT+CSCON?', dir: upDir }
		}

		// 校时：读取时钟 CCLK
		if (/^AT\+CCLK\?/i.test(cmd)) {
			return {
				type: 'cmd_cclk',
				title: '读取模组系统时钟',
				code: 'AT+CCLK?',
				dir: upDir,
				badges: [{ text: '读取时钟', kind: 'info' }],
			}
		}
		if (/^AT\+CCLK=/i.test(cmd)) {
			const timeStr = cmd.replace(/^AT\+CCLK=/i, '').trim()
			return {
				type: 'cmd_cclk_set',
				title: '手动校正模组时钟',
				code: cmd,
				dir: upDir,
				pairs: [['欲设置时间', timeStr]],
			}
		}
		// 校时：NTP 网络校时
		if (/^AT\+(Q|C)?NTP=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+(Q|C)?NTP=/i, ''))
			const server = cleanQuotes(args.length > 1 ? args[1] : args[0])
			return {
				type: 'cmd_ntp',
				title: '发起 NTP 网络校时',
				code: cmd,
				dir: upDir,
				subject: { label: '服务器', value: server || '默认 NTP 服务器' },
				badges: [{ text: 'NTP 校时', kind: 'info' }],
			}
		}

		// 通信：Socket 数据激活 QIACT
		if (/^AT\+QIACT\?/i.test(cmd)) {
			return { type: 'cmd_qiact_q', title: '查询数据场景激活状态', code: 'AT+QIACT?', dir: upDir }
		}
		if (/^AT\+QIACT=(\d+)/i.test(cmd)) {
			const cid = cmd.match(/=(\d+)/)[1]
			return {
				type: 'cmd_qiact',
				title: '激活数据场景 (PDP)',
				code: cmd,
				dir: upDir,
				subject: { label: '场景 ID', value: cid },
				badges: [{ text: '激活网络场景', kind: 'info' }],
			}
		}
		if (/^AT\+QIDEACT=(\d+)/i.test(cmd)) {
			const cid = cmd.match(/=(\d+)/)[1]
			return {
				type: 'cmd_qideact',
				title: '去激活数据场景 (PDP)',
				code: cmd,
				dir: upDir,
				subject: { label: '场景 ID', value: cid },
			}
		}
		// 通信：Socket 建连 QIOPEN
		if (/^AT\+QIOPEN=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QIOPEN=/i, ''))
			// <cid>,<sid>,"TCP"/"UDP","<host>",<port>
			const sid = args[1] != null ? args[1] : '0'
			const proto = cleanQuotes(args[2] || 'TCP').toUpperCase()
			const host = cleanQuotes(args[3] || '')
			const port = cleanQuotes(args[4] || '')
			return {
				type: 'cmd_qiopen',
				title: 'Socket 建连请求',
				code: cmd,
				dir: upDir,
				subject: { label: 'Socket ' + sid, value: host + (port ? ':' + port : '') },
				badges: [{ text: proto, kind: 'info' }],
				pairs: [
					['Socket 编号', sid],
					['传输协议', proto],
					['目标服务器', host],
					['目标端口', port],
				],
			}
		}
		// 通信：Socket 上报 QISEND
		if (/^AT\+QISEND=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QISEND=/i, ''))
			const sid = args[0] || '0'
			const len = args[1]
			if (len === '0') {
				return {
					type: 'cmd_qisend_query',
					title: '查询 Socket 发送确认',
					code: cmd,
					dir: upDir,
					subject: { label: 'Socket', value: sid },
				}
			}
			return {
				type: 'cmd_qisend',
				title: 'Socket 数据上报',
				code: cmd,
				dir: upDir,
				subject: { label: 'Socket', value: sid },
				badges: [{ text: len ? '计划发送 ' + len + ' 字节' : '发送数据', kind: 'info' }],
				pairs: [
					['Socket 编号', sid],
					['上报长度', len ? len + ' 字节' : '可变长度'],
				],
			}
		}
		// 通信：关闭 Socket QICLOSE
		if (/^AT\+QICLOSE=/i.test(cmd)) {
			const sid = cmd.replace(/^AT\+QICLOSE=/i, '').trim()
			return {
				type: 'cmd_qiclose',
				title: '关闭 Socket 连接',
				code: cmd,
				dir: upDir,
				subject: { label: 'Socket', value: sid },
			}
		}

		// 通信：MQTT
		if (/^AT\+QMTCFG="ssl"/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QMTCFG="ssl",?/i, ""))
			const clientIdx = args[0] || "0"
			const enable = args[1] === "1"
			const ctxId = args[2] || "0"
			return {
				type: "cmd_qmtcfg_ssl",
				title: "配置 MQTT SSL/TLS 加密",
				code: cmd,
				dir: upDir,
				badges: [{ text: enable ? "启用 MQTTS (加密)" : "关闭 SSL", kind: enable ? "ok" : "info" }],
				pairs: [["客户端", clientIdx], ["SSL 状态", enable ? "启用 (使用 SSL 上下文 " + ctxId + ")" : "禁用"]],
			}
		}
		if (/^AT\+QMTCFG=/i.test(cmd)) {
			return { type: 'cmd_qmtcfg', title: '配置 MQTT 参数', code: cmd, dir: upDir }
		}
		if (/^AT\+QMTOPEN=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QMTOPEN=/i, ''))
			const clientIdx = args[0] || '0'
			const host = cleanQuotes(args[1] || '')
			const port = cleanQuotes(args[2] || '1883')
			return {
				type: 'cmd_qmtopen',
				title: '打开 MQTT 网络连接',
				code: cmd,
				dir: upDir,
				subject: { label: '客户端 ' + clientIdx, value: host + ':' + port },
				pairs: [['Broker 地址', host], ['端口', port]],
			}
		}
		if (/^AT\+QMTCONN=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QMTCONN=/i, ''))
			const clientIdx = args[0] || '0'
			const clientId = cleanQuotes(args[1] || '')
			return {
				type: 'cmd_qmtconn',
				title: 'MQTT 客户端连接认证',
				code: cmd,
				dir: upDir,
				subject: { label: '客户端 ' + clientIdx, value: clientId },
			}
		}
		if (/^AT\+QMTPUB=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QMTPUB=/i, ''))
			const clientIdx = args[0] || '0'
			const msgId = args[1] || '0'
			const qos = args[2] || '0'
			const topic = cleanQuotes(args[4] || '')
			const len = args[5]
			return {
				type: 'cmd_qmtpub',
				title: 'MQTT 消息发布',
				code: cmd,
				dir: upDir,
				subject: { label: '主题', value: topic || 'Topic' },
				badges: [{ text: 'QoS ' + qos, kind: 'info' }, { text: len ? len + ' 字节' : '发布', kind: 'info' }],
				pairs: [['Client ID', clientIdx], ['报文序号', msgId], ['QoS 等级', qos], ['主题 (Topic)', topic]],
			}
		}
		if (/^AT\+QMTSUB=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QMTSUB=/i, ''))
			const topic = cleanQuotes(args[2] || '')
			return {
				type: 'cmd_qmtsub',
				title: 'MQTT 订阅主题',
				code: cmd,
				dir: upDir,
				subject: { label: '主题', value: topic },
			}
		}

		// 通信：SSL / TLS 安全通信 (QSSLCFG, QSSLOPEN, QSSLSEND, QSSLCLOSE)
		if (/^AT\+QSSLCFG=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QSSLCFG=/i, ''))
			const paramName = cleanQuotes(args[0] || '').toLowerCase()
			const ctxId = args[1] || '0'
			const val1 = cleanQuotes(args[2] || '')
			const pairs = [['参数类型', paramName], ['SSL 上下文 ID', ctxId]]
			let badgeText = 'SSL/TLS 配置'
			if (paramName === 'sslversion') {
				const verMap = { '0': 'SSL 3.0', '1': 'TLS 1.0', '2': 'TLS 1.1', '3': 'TLS 1.2', '4': '全部支持' }
				pairs.push(['TLS/SSL 版本', verMap[val1] || val1])
				badgeText = '配置 ' + (verMap[val1] || 'TLS')
			} else if (paramName === 'seclevel') {
				const secMap = { '0': '不认证', '1': '单向认证 (校验服务器)', '2': '双向认证 (校验服务器与客户端)' }
				pairs.push(['认证安全级别', secMap[val1] || val1])
				badgeText = secMap[val1] || '安全认证'
			} else if (paramName === 'ignorelocaltime') {
				pairs.push(['忽略本地时钟校验', val1 === '1' ? '已启用 (证书不校验本地时间)' : '未启用'])
			} else if (paramName === 'negotiatetime') {
				pairs.push(['握手超时时间', val1 + ' 秒'])
			} else if (paramName === 'dtls') {
				pairs.push(['DTLS 模式', val1 === '1' ? '启用 DTLS' : '标准 TLS'])
			} else if (paramName === 'snienable') {
				pairs.push(['SNI (服务器名称指示)', val1 === '1' ? '已启用' : '未启用'])
			} else if (paramName === 'ciphersuite') {
				pairs.push(['密码套件', val1])
			} else if (paramName === 'cacert' || paramName === 'clientcert' || paramName === 'clientkey') {
				pairs.push(['证书/私钥文件路径', val1])
			}
			return {
				type: 'cmd_qsslcfg',
				title: '配置 SSL/TLS 安全参数 (QSSLCFG)',
				code: cmd,
				dir: upDir,
				subject: { label: 'SSL ' + ctxId, value: paramName },
				badges: [{ text: badgeText, kind: 'info' }],
				pairs: pairs,
			}
		}
		if (/^AT\+QSSLOPEN=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QSSLOPEN=/i, ''))
			const cid = args[0] || '1'
			const sslCtx = args[1] || '0'
			const sid = args[2] || '0'
			const host = cleanQuotes(args[3] || '')
			const port = cleanQuotes(args[4] || '')
			return {
				type: 'cmd_qsslopen',
				title: 'SSL/TLS 安全 Socket 建连请求',
				code: cmd,
				dir: upDir,
				subject: { label: 'SSL ' + sid, value: host + (port ? ':' + port : '') },
				badges: [{ text: 'SSL/TLS', kind: 'info' }, { text: host + ':' + port }],
				pairs: [
					['Socket 编号', sid],
					['SSL 上下文 ID', sslCtx],
					['PDP 场景 ID', cid],
					['目标服务器', host],
					['目标端口', port],
				],
			}
		}
		if (/^AT\+QSSLSEND=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QSSLSEND=/i, ''))
			const sid = args[0] || '0'
			const len = args[1]
			return {
				type: 'cmd_qsslsend',
				title: 'SSL/TLS 加密数据上报',
				code: cmd,
				dir: upDir,
				subject: { label: 'SSL Socket', value: sid },
				badges: [{ text: len ? '加密发送 ' + len + ' 字节' : '加密发送', kind: 'info' }],
				pairs: [
					['Socket 编号', sid],
					['上报长度', len ? len + ' 字节' : '可变长度'],
				],
			}
		}
		if (/^AT\+QSSLCLOSE=/i.test(cmd)) {
			const sid = cmd.replace(/^AT\+QSSLCLOSE=/i, '').trim()
			return {
				type: 'cmd_qsslclose',
				title: '关闭 SSL/TLS 连接',
				code: cmd,
				dir: upDir,
				subject: { label: 'SSL Socket', value: sid },
			}
		}
		if (/^AT\+QSSLRECV=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QSSLRECV=/i, ''))
			const sid = args[0] || '0'
			const len = args[1]
			return {
				type: 'cmd_qsslrecv',
				title: '读取 SSL/TLS 接收缓存',
				code: cmd,
				dir: upDir,
				subject: { label: 'SSL Socket', value: sid },
				badges: [{ text: len ? '请求 ' + len + ' 字节' : '读取缓存', kind: 'info' }],
				pairs: [['Socket 编号', sid], ['请求读取长度', len ? len + ' 字节' : '全部数据']],
			}
		}
		if (/^AT\+QSSLSTATE/i.test(cmd)) {
			return {
				type: 'cmd_qsslstate',
				title: '查询 SSL/TLS 连接状态',
				code: cmd,
				dir: upDir,
				badges: [{ text: '状态查询', kind: 'info' }],
			}
		}
		if (/^AT\+QHTTPCFG="sslctxid"/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QHTTPCFG="sslctxid",?/i, ''))
			const ctxId = args[0] || '1'
			return {
				type: 'cmd_qhttpcfg_ssl',
				title: '配置 HTTPS SSL/TLS 证书上下文',
				code: cmd,
				dir: upDir,
				badges: [{ text: 'HTTPS SSL', kind: 'info' }],
				pairs: [['关联 SSL 上下文 ID', ctxId]],
			}
		}

		// 通信：HTTP
		if (/^AT\+QHTTPPOST=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+QHTTPPOST=/i, ''))
			const len = args[0]
			return {
				type: 'cmd_qhttppost',
				title: '发起 HTTP POST 请求',
				code: cmd,
				dir: upDir,
				badges: [{ text: len ? 'Body ' + len + ' 字节' : 'POST 请求', kind: 'info' }],
			}
		}
		if (/^AT\+QHTTPURL=/i.test(cmd)) {
			return { type: 'cmd_qhttpurl', title: '配置 HTTP 请求 URL', code: cmd, dir: upDir }
		}
		if (/^AT\+QHTTPREAD/i.test(cmd)) {
			return { type: 'cmd_qhttpread', title: '读取 HTTP 响应正文', code: cmd, dir: upDir }
		}

		// 通信：NB-IoT 报文 (NMGS)
		if (/^AT\+NMGS=/i.test(cmd)) {
			const args = splitCsvArgs(cmd.replace(/^AT\+NMGS=/i, ''))
			const len = args[0]
			const payload = args[1] || ''
			return {
				type: 'cmd_nmgs',
				title: 'NB-IoT 报文上报',
				code: cmd,
				dir: upDir,
				badges: [{ text: len + ' 字节', kind: 'info' }],
				pairs: [['数据长度', len + ' 字节'], ['十六进制内容', payload]],
			}
		}

		// 默认通用 AT 指令
		return {
			type: 'cmd_generic',
			title: '下发 AT 指令',
			code: cmd,
			dir: upDir,
			pairs: [['指令全文', cmd]],
		}
	}

	// ---- 解析模组响应与 URC (+CMD: ...) ----

	function parseAtResponseOrUrc(raw) {
		const line = raw.trim()
		const colonIdx = line.indexOf(':')
		const tag = line.slice(1, colonIdx).toUpperCase()
		const valStr = line.slice(colonIdx + 1).trim()
		const downDir = 'down'

		// 1. 驻网：SIM 卡就绪
		if (tag === 'CPIN') {
			const status = cleanQuotes(valStr).toUpperCase()
			const isReady = status === 'READY'
			return {
				type: 'resp_cpin',
				title: 'SIM 卡状态',
				code: '+CPIN',
				dir: downDir,
				badges: [{ text: isReady ? '正常就绪' : status, kind: isReady ? 'ok' : 'warn' }],
				pairs: [
					['SIM 状态', isReady ? '正常就绪 (READY)' : status],
					['状态含义', isReady ? 'SIM 卡已识别，PIN 验证通过' : '需要解锁或检查 SIM 卡插槽'],
				],
			}
		}

		// 2. 驻网：信号 CSQ
		if (tag === 'CSQ') {
			const q = parseCsq(valStr)
			if (q) {
				const badges = [{ text: 'CSQ ' + q.rssi + (q.dbm != null ? ' (' + q.dbm + ' dBm)' : ''), kind: q.kind }, { text: q.rating, kind: q.kind }]
				return {
					type: 'resp_csq',
					title: '信号质量上报',
					code: '+CSQ',
					dir: downDir,
					badges: badges,
					pairs: [
						['信号强度 (RSSI)', q.rssi + (q.dbm != null ? ' (' + q.dbm + ' dBm)' : '')],
						['信号质量评价', q.rating],
						['信道误码率 (BER)', q.ber === 99 ? '99 (未测量 / 未知)' : String(q.ber)],
					],
				}
			}
		}

		// 3. 驻网：扩展信号 CESQ
		if (tag === 'CESQ') {
			const q = parseCesq(valStr)
			if (q) {
				return {
					type: 'resp_cesq',
					title: '扩展信号质量上报 (CESQ)',
					code: '+CESQ',
					dir: downDir,
					badges: [{ text: 'RSRP ' + q.rsrpStr, kind: q.rsrpKind }, { text: 'RSRQ ' + q.rsrqStr, kind: q.rsrqKind }],
					pairs: [
						['参考信号接收功率 (RSRP)', q.rsrpStr],
						['参考信号接收质量 (RSRQ)', q.rsrqStr],
						['信噪比/误码率', q.ber === 99 ? '未知' : String(q.ber)],
					],
				}
			}
		}

		// 4. 驻网：网络注册 CREG / CEREG / CGREG
		if (tag === 'CREG' || tag === 'CEREG' || tag === 'CGREG') {
			const args = splitCsvArgs(valStr)
			// 参数可能为 <stat> (单参数 URC)，或 <n>,<stat>[,<lac>,<ci>[,<act>]]
			const statVal = args.length === 1 ? parseInt(args[0], 10) : parseInt(args[1], 10)
			const info = REG_STAT_MAP[statVal] || { text: '未知代码 ' + statVal, kind: 'warn' }
			const lac = args.length >= 3 ? cleanQuotes(args[2]) : null
			const ci = args.length >= 4 ? cleanQuotes(args[3]) : null
			const actCode = args.length >= 5 ? parseInt(args[4], 10) : null
			const actName = actCode != null ? (ACT_MAP[actCode] || ('模式 ' + actCode)) : null

			const badges = [{ text: info.text, kind: info.kind }]
			if (actName) badges.push({ text: actName, kind: 'info' })
			if (args.length === 1) badges.push({ text: 'URC', kind: 'info' })

			const pairs = [['网络注册状态', info.text]]
			if (lac) pairs.push(['基站区域码 (TAC/LAC)', lac])
			if (ci) pairs.push(['小区 ID (CellID)', ci])
			if (actName) pairs.push(['网络制式 (AcT)', actName])

			return {
				type: 'resp_reg',
				title: '网络注册状态 (' + tag + ')',
				code: '+' + tag,
				dir: downDir,
				badges: badges,
				pairs: pairs,
			}
		}

		// 5. 驻网：PS 附着 CGATT
		if (tag === 'CGATT') {
			const attached = valStr.trim() === '1'
			return {
				type: 'resp_cgatt',
				title: '数据附着状态 (CGATT)',
				code: '+CGATT',
				dir: downDir,
				badges: [{ text: attached ? '已附着网络' : '未附着网络', kind: attached ? 'ok' : 'bad' }],
				pairs: [['PS 业务状态', attached ? '已附着 (正常分组数据就绪)' : '未附着 (无法进行 IP 数据传输)']],
			}
		}

		// 6. 驻网：运营商 COPS
		if (tag === 'COPS') {
			const args = splitCsvArgs(valStr)
			// <mode>[,<format>,"<oper>"[,<act>]]
			const operRaw = args.length >= 3 ? cleanQuotes(args[2]) : ''
			const operName = formatOperator(operRaw)
			const actCode = args.length >= 4 ? parseInt(args[3], 10) : null
			const actName = actCode != null ? (ACT_MAP[actCode] || '') : ''

			const badges = [{ text: operName, kind: 'ok' }]
			if (actName) badges.push({ text: actName, kind: 'info' })
			return {
				type: 'resp_cops',
				title: '当前驻留运营商',
				code: '+COPS',
				dir: downDir,
				badges: badges,
				pairs: [
					['运营商名称', operName],
					['原始标识 (MCC/MNC)', operRaw || '无'],
					['接入制式', actName || '未知'],
				],
			}
		}

		// 7. 驻网：工程小区 QENG
		if (tag === 'QENG') {
			return {
				type: 'resp_qeng',
				title: '服务小区工程参数 (QENG)',
				code: '+QENG',
				dir: downDir,
				pairs: [['参数行', valStr]],
			}
		}

		// 8. 校时：时钟 CCLK
		if (tag === 'CCLK') {
			const c = parseCclk(valStr)
			if (c) {
				const badges = [{ text: c.tzDesc, kind: 'info' }]
				if (c.isCalibrated) {
					badges.push({ text: '已校正时钟', kind: 'ok' })
				} else {
					badges.push({ text: '未同步初始时间', kind: 'warn' })
				}
				return {
					type: 'resp_cclk',
					title: '模组系统时钟',
					code: '+CCLK',
					dir: downDir,
					subject: { label: '时间', value: c.isoDate },
					badges: badges,
					pairs: [
						['系统时间', c.isoDate + ' (' + c.tzDesc + ')'],
						['时区', c.tzDesc],
						['有效性', c.isCalibrated ? '正常有效 (已由基站或NTP校准)' : '异常 (仍为模组初始时间，需校时)'],
					],
				}
			}
		}

		// 9. 校时：NTP 校时结果 (QNTP / CNTP)
		if (tag === 'QNTP' || tag === 'CNTP') {
			const args = splitCsvArgs(valStr)
			const res = parseInt(args[0], 10)
			const timeStr = args.length > 1 ? cleanQuotes(args[1]) : ''
			const isSuccess = res === 0
			return {
				type: 'resp_ntp',
				title: 'NTP 网络校时结果 (URC)',
				code: '+' + tag,
				dir: downDir,
				subject: isSuccess ? { label: '校准时间', value: timeStr } : null,
				badges: [{ text: isSuccess ? '校时成功' : '校时失败 (码 ' + res + ')', kind: isSuccess ? 'ok' : 'bad' }, { text: 'URC', kind: 'info' }],
				pairs: [
					['执行结果', isSuccess ? '校时成功' : '校时失败 (错误码 ' + res + ')'],
					['同步时钟', timeStr || '无'],
				],
			}
		}

		// 10. 基站时钟广播 NITZ / CTZV
		if (tag === 'NITZ' || tag === 'CTZV' || tag === 'CTZR') {
			return {
				type: 'resp_nitz',
				title: '基站时间与时区更新 (URC)',
				code: '+' + tag,
				dir: downDir,
				badges: [{ text: '基站授时', kind: 'ok' }, { text: 'URC', kind: 'info' }],
				pairs: [['基站广播时间', valStr]],
			}
		}

		// 11. 通信：Socket 建连应答 QIOPEN (URC)
		if (tag === 'QIOPEN') {
			const args = splitCsvArgs(valStr)
			// <sid>,<err>
			const sid = args[0] || '0'
			const err = args[1]
			const isSuccess = err === '0'
			return {
				type: 'resp_qiopen',
				title: 'Socket 建连完成 (URC)',
				code: '+QIOPEN',
				dir: downDir,
				subject: { label: 'Socket', value: sid },
				badges: [
					{ text: isSuccess ? '连接成功' : '连接失败 (码 ' + err + ')', kind: isSuccess ? 'ok' : 'bad' },
					{ text: 'URC', kind: 'info' },
				],
				pairs: [
					['Socket 编号', sid],
					['建连状态', isSuccess ? '成功 (网络通道建立完成)' : '失败 (错误码 ' + err + ')'],
				],
			}
		}

		// 12. 通信：Socket 发送状态统计 QISEND
		if (tag === 'QISEND') {
			const args = splitCsvArgs(valStr)
			// <total>,<acked>,<unacked>
			const total = args[0] || '0'
			const acked = args[1] || '0'
			const unacked = args[2] || '0'
			return {
				type: 'resp_qisend_stat',
				title: 'Socket 发送缓冲统计',
				code: '+QISEND',
				dir: downDir,
				badges: [{ text: '已确认 ' + acked + 'B', kind: 'ok' }, { text: '待确认 ' + unacked + 'B', kind: unacked === '0' ? 'ok' : 'warn' }],
				pairs: [
					['累计写入字节', total + ' 字节'],
					['网络确认 (ACK)', acked + ' 字节'],
					['未确认字节', unacked + ' 字节'],
				],
			}
		}

		// 13. 通信：Socket 下行与异常 QIURC
		if (tag === 'QIURC') {
			const args = splitCsvArgs(valStr)
			const eventType = cleanQuotes(args[0] || '').toLowerCase()
			if (eventType === 'recv') {
				const sid = args[1] || '0'
				const len = args[2]
				return {
					type: 'resp_qiurc_recv',
					title: 'Socket 接收下行数据 (URC)',
					code: '+QIURC: "recv"',
					dir: downDir,
					subject: { label: 'Socket', value: sid },
					badges: [{ text: len ? '到达 ' + len + ' 字节' : '下行数据', kind: 'info' }, { text: 'URC', kind: 'info' }],
					pairs: [
						['Socket 编号', sid],
						['接收数据长度', len ? len + ' 字节' : '未指定'],
					],
				}
			}
			if (eventType === 'closed') {
				const sid = args[1] || '0'
				return {
					type: 'resp_qiurc_closed',
					title: 'Socket 服务端已断开 (URC)',
					code: '+QIURC: "closed"',
					dir: downDir,
					subject: { label: 'Socket', value: sid },
					badges: [{ text: '连接已关闭', kind: 'warn' }, { text: 'URC', kind: 'info' }],
					pairs: [['说明', '远端服务器主动关闭了此 Socket 连接']],
				}
			}
			return {
				type: 'resp_qiurc_generic',
				title: 'Socket 异步通知 (QIURC)',
				code: '+QIURC',
				dir: downDir,
				badges: [{ text: eventType || '通知', kind: 'info' }, { text: 'URC', kind: 'info' }],
				pairs: [['事件类型', eventType], ['参数', valStr]],
			}
		}

		// 13.1 通信：SSL/TLS 建连完成 QSSLOPEN (URC)
		if (tag === 'QSSLOPEN') {
			const args = splitCsvArgs(valStr)
			const sid = args[0] || '0'
			const err = args[1]
			const isSuccess = err === '0'
			return {
				type: 'resp_qsslopen',
				title: 'SSL/TLS 建连完成 (URC)',
				code: '+QSSLOPEN',
				dir: downDir,
				subject: { label: 'SSL Socket', value: sid },
				badges: [
					{ text: isSuccess ? '加密连接成功' : 'SSL 握手/连接失败 (码 ' + err + ')', kind: isSuccess ? 'ok' : 'bad' },
					{ text: 'URC', kind: 'info' },
				],
				pairs: [
					['Socket 编号', sid],
					['SSL 状态', isSuccess ? '握手成功，安全加密通道就绪' : '握手失败 (错误码 ' + err + ')'],
				],
			}
		}

		// 13.2 通信：SSL/TLS 下行与异常 QSSLURC
		if (tag === 'QSSLURC') {
			const args = splitCsvArgs(valStr)
			const eventType = cleanQuotes(args[0] || '').toLowerCase()
			if (eventType === 'recv') {
				const sid = args[1] || '0'
				const len = args[2]
				return {
					type: 'resp_qsslurc_recv',
					title: 'SSL/TLS 接收加密数据 (URC)',
					code: '+QSSLURC: "recv"',
					dir: downDir,
					subject: { label: 'SSL Socket', value: sid },
					badges: [{ text: len ? '到达 ' + len + ' 字节' : '加密下行数据', kind: 'info' }, { text: 'URC', kind: 'info' }],
					pairs: [
						['Socket 编号', sid],
						['接收数据长度', len ? len + ' 字节' : '未指定'],
					],
				}
			}
			if (eventType === 'closed') {
				const sid = args[1] || '0'
				return {
					type: 'resp_qsslurc_closed',
					title: 'SSL/TLS 连接被服务端关闭 (URC)',
					code: '+QSSLURC: "closed"',
					dir: downDir,
					subject: { label: 'SSL Socket', value: sid },
					badges: [{ text: '加密连接已关闭', kind: 'warn' }, { text: 'URC', kind: 'info' }],
					pairs: [['说明', '远端服务器主动关闭了该 SSL/TLS 加密通道']],
				}
			}
			return {
				type: 'resp_qsslurc_generic',
				title: 'SSL 异步通知 (QSSLURC)',
				code: '+QSSLURC',
				dir: downDir,
				badges: [{ text: eventType || '通知', kind: 'info' }, { text: 'URC', kind: 'info' }],
			}
		}

		// 13.3 通信：SSL 缓存读取与状态响应 QSSLRECV / QSSLSTATE
		if (tag === 'QSSLRECV') {
			const len = parseInt(valStr.trim() || '0', 10)
			return {
				type: 'resp_qsslrecv',
				title: 'SSL/TLS 读出缓存数据',
				code: '+QSSLRECV',
				dir: downDir,
				badges: [{ text: '读取 ' + len + ' 字节', kind: 'ok' }],
				pairs: [['读出数据长度', len + ' 字节']],
			}
		}
		if (tag === 'QSSLSTATE') {
			const args = splitCsvArgs(valStr)
			const sid = args[0] || '0'
			const serviceType = cleanQuotes(args[1] || '')
			const ip = cleanQuotes(args[2] || '')
			const port = cleanQuotes(args[3] || '')
			const localPort = cleanQuotes(args[4] || '')
			const stateCode = args[5] || ''
			const sslCtxId = args[6] || '0'
			const stateMap = { '0': '初始状态 (Initial)', '1': '正在建连 (Opening)', '2': '已连接 (Connected)', '3': '正在监听 (Listening)', '4': '正在关闭 (Closing)' }
			const stateText = stateMap[stateCode] || ('状态码 ' + stateCode)
			const isConnected = stateCode === '2'
			return {
				type: 'resp_qsslstate',
				title: 'SSL/TLS Socket 连接状态',
				code: '+QSSLSTATE',
				dir: downDir,
				subject: { label: 'SSL ' + sid, value: ip ? ip + ':' + port : stateText },
				badges: [{ text: stateText, kind: isConnected ? 'ok' : 'info' }],
				pairs: [
					['Socket 编号', sid],
					['服务类型', serviceType],
					['远端地址', ip ? ip + ':' + port : '未连接'],
					['本地端口', localPort || '自动'],
					['链路状态', stateText],
					['SSL 上下文 ID', sslCtxId]
				],
			}
		}

		// 14. 通信：MQTT 结果
		if (tag === 'QMTOPEN') {
			const args = splitCsvArgs(valStr)
			const clientIdx = args[0] || '0'
			const res = args[1]
			const isSuccess = res === '0'
			return {
				type: 'resp_qmtopen',
				title: 'MQTT 网络连接结果 (URC)',
				code: '+QMTOPEN',
				dir: downDir,
				subject: { label: '客户端', value: clientIdx },
				badges: [{ text: isSuccess ? '连接成功' : '连接失败 (' + res + ')', kind: isSuccess ? 'ok' : 'bad' }, { text: 'URC', kind: 'info' }],
			}
		}
		if (tag === 'QMTCONN') {
			const args = splitCsvArgs(valStr)
			const clientIdx = args[0] || '0'
			const res = args[1]
			const isSuccess = res === '0'
			return {
				type: 'resp_qmtconn',
				title: 'MQTT 登录认证结果 (URC)',
				code: '+QMTCONN',
				dir: downDir,
				subject: { label: '客户端', value: clientIdx },
				badges: [{ text: isSuccess ? '登录成功' : '登录失败 (' + res + ')', kind: isSuccess ? 'ok' : 'bad' }, { text: 'URC', kind: 'info' }],
			}
		}
		if (tag === 'QMTPUB') {
			const args = splitCsvArgs(valStr)
			const clientIdx = args[0] || '0'
			const msgId = args[1] || '0'
			const res = args[2]
			const isSuccess = res === '0'
			return {
				type: 'resp_qmtpub',
				title: 'MQTT 发布确认 (URC)',
				code: '+QMTPUB',
				dir: downDir,
				badges: [{ text: isSuccess ? '发布成功' : '发布失败 (' + res + ')', kind: isSuccess ? 'ok' : 'bad' }],
				pairs: [['Client ID', clientIdx], ['报文序号', msgId]],
			}
		}
		if (tag === 'QMTRECV') {
			const args = splitCsvArgs(valStr)
			const clientIdx = args[0] || '0'
			const msgId = args[1] || '0'
			const topic = cleanQuotes(args[2] || '')
			const payload = args.length >= 4 ? cleanQuotes(args[3]) : ''
			return {
				type: 'resp_qmtrecv',
				title: 'MQTT 下行消息到达 (URC)',
				code: '+QMTRECV',
				dir: downDir,
				subject: { label: '主题', value: topic },
				badges: [{ text: 'MQTT 消息', kind: 'info' }, { text: 'URC', kind: 'info' }],
				pairs: [['主题 (Topic)', topic], ['客户端', clientIdx], ['报文 ID', msgId], ['载荷内容', payload]],
			}
		}
		if (tag === 'QMTSTAT') {
			const args = splitCsvArgs(valStr)
			const clientIdx = args[0] || '0'
			const err = args[1]
			const errMap = { 1: '连接被远端断开', 2: 'Ping 保活超时', 3: '连接重置', 4: '网络不可用' }
			const errDesc = errMap[err] || ('状态码 ' + err)
			return {
				type: 'resp_qmtstat',
				title: 'MQTT 链路状态变动 (URC)',
				code: '+QMTSTAT',
				dir: downDir,
				badges: [{ text: errDesc, kind: 'bad' }, { text: 'URC', kind: 'info' }],
				pairs: [['客户端', clientIdx], ['异常原因', errDesc]],
			}
		}

		// 15. 通信：HTTP 结果
		if (tag === 'QHTTPPOST') {
			const args = splitCsvArgs(valStr)
			const err = args[0]
			const status = parseInt(args[1] || '0', 10)
			const len = args[2]
			const isHttpOk = status >= 200 && status < 300
			return {
				type: 'resp_qhttppost',
				title: 'HTTP POST 响应结果 (URC)',
				code: '+QHTTPPOST',
				dir: downDir,
				badges: [
					{ text: 'HTTP ' + status, kind: isHttpOk ? 'ok' : 'bad' },
					{ text: isHttpOk ? '请求成功' : '请求异常', kind: isHttpOk ? 'ok' : 'bad' },
					{ text: 'URC', kind: 'info' },
				],
				pairs: [
					['HTTP 状态码', String(status)],
					['内部错误码', err],
					['响应内容长度', len ? len + ' 字节' : '未知'],
				],
			}
		}

		// 16. 通信：NB-IoT 报文下行 (NNMI)
		if (tag === 'NNMI') {
			const args = splitCsvArgs(valStr)
			const len = args[0]
			const payload = args[1] || ''
			return {
				type: 'resp_nnmi',
				title: 'NB-IoT 下行数据报文 (URC)',
				code: '+NNMI',
				dir: downDir,
				badges: [{ text: len + ' 字节', kind: 'info' }, { text: 'URC', kind: 'info' }],
				pairs: [['报文长度', len + ' 字节'], ['数据载荷', payload]],
			}
		}

		// 17. 其它通用响应
		return {
			type: 'resp_generic',
			title: '响应 / 事件上报',
			code: '+' + tag,
			dir: downDir,
			pairs: [['标识', '+' + tag], ['参数内容', valStr]],
		}
	}

	// ---- 载荷内容 (Payload) 行识别 ----

	function parsePayloadLine(raw) {
		const s = raw.trim()
		if (!s) return null

		// 检查是否为 JSON 串 (含 TSL 物模型识别)
		if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
			try {
				const obj = JSON.parse(s)
				const pretty = JSON.stringify(obj, null, 2)

				// 识别 TSL (Thing Specification Language 物模型)
				const method = typeof obj.method === 'string' ? obj.method : ''
				const isTslPost = method === 'thing.event.property.post' || method === 'thing.property.post'
				const isTslSet = method === 'thing.service.property.set'
				const isTslReply = method.includes('reply') || (typeof obj.code === 'number' && method && method.includes('thing.'))
				const paramsObj = (obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)) ? obj.params : null
				const propObj = (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) ? obj.properties : null
				const tslAttrs = paramsObj || propObj

				if (isTslPost || isTslSet || isTslReply || (tslAttrs && Object.keys(tslAttrs).length > 0 && (obj.id != null || obj.version || method))) {
					let title = '物模型数据 (TSL)'
					if (isTslPost) title = '物模型属性上报 (TSL Property Post)'
					else if (isTslSet) title = '物模型属性下发 (TSL Property Set)'
					else if (isTslReply) title = '物模型服务响应 (TSL Reply)'

					const pairs = []
					if (method) pairs.push(['方法 (Method)', method])
					if (obj.id != null) pairs.push(['消息 ID', String(obj.id)])
					if (obj.version) pairs.push(['TSL 版本', String(obj.version)])

					const badges = [{ text: 'TSL 物模型', kind: 'info' }]
					if (tslAttrs) {
						const keys = Object.keys(tslAttrs)
						badges.push({ text: '属性 ' + keys.length + ' 项', kind: 'ok' })
						keys.forEach(function (k) {
							let val = tslAttrs[k]
							if (val && typeof val === 'object' && val.value !== undefined) {
								val = val.value
							}
							pairs.push(['属性: ' + k, typeof val === 'object' ? JSON.stringify(val) : String(val)])
						})
					}

					return {
						type: 'payload_tsl',
						title: title,
						code: 'TSL',
						dir: '',
						badges: badges,
						pairs: pairs,
						sections: [
							{ title: '物模型属性列表', pairs: pairs },
							{ title: '原始 JSON 报文', pre: pretty },
						],
					}
				}

				return {
					type: 'payload_json',
					title: '数据载荷 (JSON)',
					code: 'JSON',
					dir: '',
					badges: [{ text: 'JSON 格式', kind: 'info' }],
					sections: [{ title: '载荷内容', pre: pretty }],
				}
			} catch (e) { /* 不是合法 json */ }
		}

		// 检查是否为纯 Hex 串 (如 "68 10 01 ..." 或连续 16 进制)
		const hexOnly = s.replace(/\s+/g, '')
		if (hexOnly.length >= 4 && hexOnly.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hexOnly)) {
			const byteLen = hexOnly.length / 2
			return {
				type: 'payload_hex',
				title: '数据载荷 (十六进制流)',
				code: 'HEX',
				dir: '',
				badges: [{ text: byteLen + ' 字节', kind: 'info' }],
				pairs: [['字节数', byteLen + ' 字节'], ['数据 Hex', s]],
			}
		}

		// 默认作为纯文本行
		return {
			type: 'payload_text',
			title: '数据载荷 (纯文本)',
			code: 'DATA',
			dir: '',
			pairs: [['正文', s]],
		}
	}

	// ---- 解析多行数据包并生成结果 ----

	function parseFrame(data, opt) {
		let text = ''
		if (typeof data === 'string') {
			text = data
		} else if (data instanceof Uint8Array || Array.isArray(data)) {
			try {
				text = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(data))
			} catch (e) {
				text = String.fromCharCode.apply(null, Array.from(data))
			}
		} else {
			text = String(data || '')
		}

		// 切分行，保留有效内容
		const lines = text.split(/[\r\n]+/).map(function (s) { return s.trim() }).filter(Boolean)
		// 特例：如果是单独的提示符 '>' (可能不带换行)
		if (lines.length === 0 && text.indexOf('>') !== -1) {
			lines.push('>')
		}

		const items = []
		for (let i = 0; i < lines.length; i++) {
			const it = parseLine(lines[i])
			if (it) items.push(it)
		}

		return {
			rawText: text,
			items: items,
			ok: items.length > 0,
		}
	}

	// ---- 渲染视图模型 logView ----

	function itemToModel(it) {
		if (!it) return null
		const m = {
			title: it.title || 'AT 报文',
			code: it.code || '',
			dir: it.dir || '',
			badges: it.badges || [],
			pairs: it.pairs || [],
		}
		if (it.subject) m.subject = it.subject

		const sec = {}
		if (it.pairs && it.pairs.length) {
			sec.pairs = it.pairs
		}
		if (it.sections) {
			m.sections = it.sections
		} else if (sec.pairs) {
			m.sections = [sec]
		}
		return m
	}

	function logView(r) {
		if (!r || !r.items || !r.items.length) return null

		// 特殊优化：如果一个数据包里有多个行（如 +CSQ: 24,99 紧跟 OK）
		if (r.items.length === 2 && r.items[1].code === 'OK') {
			const m0 = itemToModel(r.items[0])
			m0.badges = (m0.badges || []).concat([{ text: 'OK', kind: 'ok' }])
			return m0
		}

		if (r.items.length === 1) {
			return itemToModel(r.items[0])
		}

		// 多个独立行：返回数组
		const models = []
		for (let i = 0; i < r.items.length; i++) {
			const m = itemToModel(r.items[i])
			if (m) models.push(m)
		}
		return models.length ? models : null
	}

	// 格式化输出 (底栏旧面板/检查器原始输出 fallback)
	function formatFrame(r) {
		if (!r || !r.items || !r.items.length) return r ? (r.rawText || '') : ''
		const out = []
		for (let i = 0; i < r.items.length; i++) {
			const it = r.items[i]
			out.push('[' + it.title + '] ' + (it.code || ''))
			if (it.pairs && it.pairs.length) {
				for (let j = 0; j < it.pairs.length; j++) {
					out.push('  ' + it.pairs[j][0] + ': ' + it.pairs[j][1])
				}
			}
		}
		return out.join('\n')
	}

	// 查找帧边界 (以 \n 为行界，或独立提示符 >)
	function findFrame(bytes, opt) {
		const b = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || [])
		const empty = { found: false, offset: 0, length: b.length, frame: b, prefix: 0, suffix: 0 }
		if (!b.length) return empty

		for (let i = 0; i < b.length; i++) {
			// 单独提示符 > (0x3E)
			if (b[i] === 0x3e) {
				const frame = new Uint8Array(b.subarray(i, i + 1))
				return { found: true, offset: i, length: 1, frame: frame, prefix: i, suffix: b.length - i - 1 }
			}
			// 换行符 \n (0x0A)
			if (b[i] === 0x0a) {
				const len = i + 1
				const frame = new Uint8Array(b.subarray(0, len))
				return { found: true, offset: 0, length: len, frame: frame, prefix: 0, suffix: b.length - len }
			}
		}
		return empty
	}

	// 字节标注映射
	function byteMap(r) {
		if (!r || !r.items) return null
		return null
	}

	// ---- 导出与注册 ----

	root.atModem = {
		parseFrame: parseFrame,
		formatFrame: formatFrame,
		logView: logView,
		findFrame: findFrame,
		byteMap: byteMap,
		parseCsq: parseCsq,
		parseCesq: parseCesq,
		parseCclk: parseCclk,
	}

	function tryRegister(retry) {
		if (typeof root.registerProtocol === 'function') {
			root.registerProtocol('cellular-at', {
				name: '蜂窝模组 AT',
				parseFrame: parseFrame,
				formatFrame: formatFrame,
				logView: logView,
				findFrame: findFrame,
				byteMap: byteMap,
				presets: [],
			})
			return
		}
		if (typeof setTimeout === 'function' && retry < 100) {
			setTimeout(function () { tryRegister(retry + 1) }, 50)
		}
	}

	function applyVisibility() {
		if (typeof document === "undefined") return
		const sel = document.getElementById("serial-protocol-select")
		const v = sel ? sel.value : "sek"
		if (v === "cellular-at") {
			const sekOnly = ["sk-down-card", "sk-rw-card", "sk-batch-card", "serial-protocol-advanced"]
			for (let i = 0; i < sekOnly.length; i++) {
				const el = document.getElementById(sekOnly[i])
				if (el) el.style.display = "none"
			}
		}
	}
	if (typeof document !== "undefined") {
		const protoSel = document.getElementById("serial-protocol-select")
		if (protoSel) protoSel.addEventListener("change", applyVisibility)
		applyVisibility()
	}

	tryRegister(0)
})()
