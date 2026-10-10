// Run: node tests/at-modem-protocol.cjs
// 测试蜂窝模组 AT 协议解析器 (驻网、校时、通信上报、多行合包、ParseView 渲染)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

let registered = null
const window = {
	registerProtocol(id, impl) {
		registered = { id, impl }
	}
}
const ctx = {
	window,
	Uint8Array,
	TextDecoder,
	console,
	document: { getElementById() { return null } }
}
vm.createContext(ctx)

// 依次加载 parse-view 和 at-modem-protocol
for (const f of ['parse-view', 'at-modem-protocol']) {
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8'), ctx)
}

const M = window.atModem
const PV = window.ParseView

// 1. 协议注册检查
assert.ok(registered, '协议应成功注册')
assert.equal(registered.id, 'cellular-at')
assert.equal(registered.impl.name, '蜂窝模组 AT')
for (const k of ['parseFrame', 'formatFrame', 'logView', 'findFrame', 'byteMap']) {
	assert.ok(typeof registered.impl[k] === 'function', '缺少接口: ' + k)
}

// 辅助函数: 解析并生成 logView 模型
function parseAndModel(text) {
	const r = M.parseFrame(text)
	return M.logView(r)
}

// 2. 驻网阶段测试
{
	// SIM 卡查询与响应
	const m1 = parseAndModel('AT+CPIN?\r\n')
	assert.equal(m1.title, '查询 SIM 卡状态')
	assert.equal(m1.dir, 'up')

	const m2 = parseAndModel('+CPIN: READY\r\n')
	assert.equal(m2.title, 'SIM 卡状态')
	assert.equal(m2.dir, 'down')
	assert.ok(m2.badges.some(b => b.text === '正常就绪' && b.kind === 'ok'))

	const m3 = parseAndModel('+CPIN: SIM PIN\r\n')
	assert.ok(m3.badges.some(b => b.kind === 'warn'))

	const m4 = parseAndModel('+CME ERROR: 10\r\n')
	assert.equal(m4.title, '设备执行错误 (+CME ERROR)')
	assert.ok(m4.badges.some(b => b.text.includes('SIM 卡未插入') && b.kind === 'bad'))

	// 信号强度 CSQ
	const mCsq = parseAndModel('+CSQ: 24,99\r\n')
	assert.equal(mCsq.title, '信号质量上报')
	assert.ok(mCsq.badges.some(b => b.text.includes('CSQ 24 (-65 dBm)') && b.kind === 'ok'))
	assert.ok(mCsq.badges.some(b => b.text.includes('极好') || b.text.includes('良好')))

	const mCsqBad = parseAndModel('+CSQ: 99,99\r\n')
	assert.ok(mCsqBad.badges.some(b => b.text.includes('无信号 / 未知') && b.kind === 'bad'))

	// CESQ
	const mCesq = parseAndModel('+CESQ: 99,99,255,255,20,15\r\n')
	assert.equal(mCesq.title, '扩展信号质量上报 (CESQ)')
	assert.ok(mCesq.badges.some(b => b.text.includes('RSRP -125 dBm')))
	assert.ok(mCesq.badges.some(b => b.text.includes('RSRQ -9.5 dB')))

	// 网络注册 CEREG / CREG
	const mReg1 = parseAndModel('+CEREG: 0,1\r\n')
	assert.equal(mReg1.title, '网络注册状态 (CEREG)')
	assert.ok(mReg1.badges.some(b => b.text.includes('已注册 (本地网络)') && b.kind === 'ok'))

	const mRegUrc = parseAndModel('+CEREG: 2\r\n')
	assert.ok(mRegUrc.badges.some(b => b.text.includes('搜网注册中...') && b.kind === 'warn'))
	assert.ok(mRegUrc.badges.some(b => b.text === 'URC'))

	const mRegReject = parseAndModel('+CEREG: 3\r\n')
	assert.ok(mRegReject.badges.some(b => b.text.includes('注册被网络拒绝') && b.kind === 'bad'))

	// PS 附着 CGATT
	const mAtt1 = parseAndModel('+CGATT: 1\r\n')
	assert.ok(mAtt1.badges.some(b => b.text.includes('已附着网络') && b.kind === 'ok'))

	const mAtt0 = parseAndModel('+CGATT: 0\r\n')
	assert.ok(mAtt0.badges.some(b => b.text.includes('未附着网络') && b.kind === 'bad'))

	// 运营商 COPS
	const mCops = parseAndModel('+COPS: 0,0,"CHINA MOBILE",7\r\n')
	assert.ok(mCops.badges.some(b => b.text === '中国移动'))
	assert.ok(mCops.badges.some(b => b.text.includes('LTE')))

	const mCops2 = parseAndModel('+COPS: 0,2,"46001",9\r\n')
	assert.ok(mCops2.badges.some(b => b.text === '中国联通'))
	assert.ok(mCops2.badges.some(b => b.text.includes('NB-IoT')))
}

// 3. 校时阶段测试
{
	// CCLK 读取
	const mCclkQ = parseAndModel('AT+CCLK?\r\n')
	assert.equal(mCclkQ.title, '读取模组系统时钟')
	assert.equal(mCclkQ.dir, 'up')

	// CCLK 响应 (正常时间)
	const mCclk = parseAndModel('+CCLK: "26/10/10,14:30:00+32"\r\n')
	assert.equal(mCclk.title, '模组系统时钟')
	assert.equal(mCclk.subject.value, '2026-10-10 14:30:00')
	assert.ok(mCclk.badges.some(b => b.text === 'UTC+8'))
	assert.ok(mCclk.badges.some(b => b.text.includes('已校正时钟') && b.kind === 'ok'))

	// CCLK 初始时间未校准
	const mCclkOld = parseAndModel('+CCLK: "80/01/06,00:00:15+00"\r\n')
	assert.ok(mCclkOld.badges.some(b => b.text.includes('未同步初始时间') && b.kind === 'warn'))

	// NTP 网络校时
	const mNtpReq = parseAndModel('AT+QNTP=1,"ntp.aliyun.com"\r\n')
	assert.equal(mNtpReq.title, '发起 NTP 网络校时')
	assert.equal(mNtpReq.subject.value, 'ntp.aliyun.com')

	const mNtpOk = parseAndModel('+QNTP: 0,"2026/10/10,14:30:01"\r\n')
	assert.equal(mNtpOk.title, 'NTP 网络校时结果 (URC)')
	assert.ok(mNtpOk.badges.some(b => b.text.includes('校时成功') && b.kind === 'ok'))

	const mNtpFail = parseAndModel('+QNTP: 61\r\n')
	assert.ok(mNtpFail.badges.some(b => b.text.includes('校时失败') && b.kind === 'bad'))
}

// 4. 通信与数据上报测试
{
	// Socket: 建连
	const mOpen = parseAndModel('AT+QIOPEN=1,0,"TCP","121.40.74.63",8084\r\n')
	assert.equal(mOpen.title, 'Socket 建连请求')
	assert.equal(mOpen.subject.value, '121.40.74.63:8084')
	assert.ok(mOpen.badges.some(b => b.text === 'TCP'))

	const mOpenRsp = parseAndModel('+QIOPEN: 0,0\r\n')
	assert.equal(mOpenRsp.title, 'Socket 建连完成 (URC)')
	assert.equal(mOpenRsp.subject.value, '0')
	assert.ok(mOpenRsp.badges.some(b => b.text.includes('连接成功') && b.kind === 'ok'))

	// Socket: 上报流程
	const mSend = parseAndModel('AT+QISEND=0,32\r\n')
	assert.equal(mSend.title, 'Socket 数据上报')
	assert.equal(mSend.subject.value, '0')
	assert.ok(mSend.badges.some(b => b.text.includes('32 字节')))

	const mPrompt = parseAndModel('>\r\n')
	assert.equal(mPrompt.title, '输入提示符 (>)')
	assert.ok(mPrompt.badges.some(b => b.text.includes('等待数据输入')))

	const mSendOk = parseAndModel('SEND OK\r\n')
	assert.equal(mSendOk.title, '数据发送完成')
	assert.ok(mSendOk.badges.some(b => b.text.includes('SEND OK') && b.kind === 'ok'))

	// Socket: 下行数据到达
	const mRecv = parseAndModel('+QIURC: "recv",0,16\r\n')
	assert.equal(mRecv.title, 'Socket 接收下行数据 (URC)')
	assert.equal(mRecv.subject.value, '0')
	assert.ok(mRecv.badges.some(b => b.text.includes('16 字节')))

	// Socket: 发送统计
	const mStat = parseAndModel('+QISEND: 100,100,0\r\n')
	assert.equal(mStat.title, 'Socket 发送缓冲统计')
	assert.ok(mStat.badges.some(b => b.text.includes('已确认 100B')))

	// MQTT 流程
	const mMqttPub = parseAndModel('AT+QMTPUB=0,1,1,0,"v1/telemetry",24\r\n')
	assert.equal(mMqttPub.title, 'MQTT 消息发布')
	assert.equal(mMqttPub.subject.value, 'v1/telemetry')

	const mMqttPubOk = parseAndModel('+QMTPUB: 0,1,0\r\n')
	assert.equal(mMqttPubOk.title, 'MQTT 发布确认 (URC)')
	assert.ok(mMqttPubOk.badges.some(b => b.text.includes('发布成功') && b.kind === 'ok'))

	// HTTP POST 流程
	const mHttp = parseAndModel('+QHTTPPOST: 0,200,64\r\n')
	assert.equal(mHttp.title, 'HTTP POST 响应结果 (URC)')
	assert.ok(mHttp.badges.some(b => b.text.includes('HTTP 200') && b.kind === 'ok'))

	// NB-IoT 报文
	const mNmgs = parseAndModel('AT+NMGS=5,0102030405\r\n')
	assert.equal(mNmgs.title, 'NB-IoT 报文上报')

	const mNnmi = parseAndModel('+NNMI: 4,AABBCCDD\r\n')
	assert.equal(mNnmi.title, 'NB-IoT 下行数据报文 (URC)')
}

// 5. 多行合包与 OK 融合
{
	// +CSQ: 24,99 紧随 OK
	const mCombo = parseAndModel('+CSQ: 24,99\r\n\r\nOK\r\n')
	assert.equal(mCombo.title, '信号质量上报')
	assert.ok(mCombo.badges.some(b => b.text === 'OK' && b.kind === 'ok'))

	// 多条独立 URC
	const rMulti = M.parseFrame('+CEREG: 1\r\n+QIURC: "recv",0,10\r\n')
	const models = M.logView(rMulti)
	assert.ok(Array.isArray(models))
	assert.equal(models.length, 2)
	assert.equal(models[0].title, '网络注册状态 (CEREG)')
	assert.equal(models[1].title, 'Socket 接收下行数据 (URC)')
}

// 6. 载荷识别测试
{
	const mJson = parseAndModel('{"status": "ok", "value": 12.3}\r\n')
	assert.equal(mJson.title, '数据载荷 (JSON)')
	assert.ok(mJson.sections[0].pre.includes('"status": "ok"'))

	const mHex = parseAndModel('68 10 01 02 03 04 05 16\r\n')
	assert.equal(mHex.title, '数据载荷 (十六进制流)')
	assert.ok(mHex.badges.some(b => b.text.includes('8 字节')))
}

// 7. ParseView HTML 渲染兼容性验证
{
	const testCases = [
		'+CSQ: 24,99\r\n',
		'+CEREG: 0,1\r\n',
		'+CCLK: "26/10/10,14:30:00+32"\r\n',
		'AT+QISEND=0,32\r\n',
		'SEND OK\r\n',
		'+CME ERROR: 10\r\n'
	]
	for (const tc of testCases) {
		const model = parseAndModel(tc)
		const html = PV.render(model, { dir: model.dir })
		assert.ok(html.includes("pv-head"), "生成的 HTML 应包含 pv-head: " + tc)
		assert.ok(html.includes(model.title), '生成的 HTML 应包含标题: ' + tc)
	}
}

// 7.1 TLS / SSL 安全通信测试
{
	const mCfgVer = parseAndModel('AT+QSSLCFG="sslversion",0,3\r\n')
	assert.equal(mCfgVer.title, '配置 SSL/TLS 安全参数 (QSSLCFG)')
	assert.ok(mCfgVer.badges.some(b => b.text.includes('TLS 1.2')))

	const mCfgSec = parseAndModel('AT+QSSLCFG="seclevel",0,1\r\n')
	assert.ok(mCfgSec.badges.some(b => b.text.includes('单向认证')))

	const mCfgTime = parseAndModel('AT+QSSLCFG="ignorelocaltime",0,1\r\n')
	assert.ok(mCfgTime.pairs.some(p => p[0].includes('忽略本地时钟') && p[1].includes('已启用')))

	const mSslOpen = parseAndModel('AT+QSSLOPEN=1,0,0,"iot.aliyun.com",8883\r\n')
	assert.equal(mSslOpen.title, 'SSL/TLS 安全 Socket 建连请求')
	assert.ok(mSslOpen.badges.some(b => b.text === 'SSL/TLS'))

	const mSslOpenOk = parseAndModel('+QSSLOPEN: 0,0\r\n')
	assert.equal(mSslOpenOk.title, 'SSL/TLS 建连完成 (URC)')
	assert.ok(mSslOpenOk.badges.some(b => b.text.includes('加密连接成功') && b.kind === 'ok'))

	const mSslOpenFail = parseAndModel('+QSSLOPEN: 0,1\r\n')
	assert.ok(mSslOpenFail.badges.some(b => b.text.includes('握手/连接失败') && b.kind === 'bad'))

	const mSslSend = parseAndModel('AT+QSSLSEND=0,48\r\n')
	assert.equal(mSslSend.title, 'SSL/TLS 加密数据上报')
	assert.ok(mSslSend.badges.some(b => b.text.includes('48 字节')))

	const mSslRecv = parseAndModel('+QSSLURC: "recv",0,24\r\n')
	assert.equal(mSslRecv.title, 'SSL/TLS 接收加密数据 (URC)')
	assert.ok(mSslRecv.badges.some(b => b.text.includes('24 字节')))

	const mSslClose = parseAndModel('+QSSLURC: "closed",0\r\n')
	assert.equal(mSslClose.title, 'SSL/TLS 连接被服务端关闭 (URC)')

	const mMqttSsl = parseAndModel('AT+QMTCFG="ssl",0,1,0\r\n')
	assert.equal(mMqttSsl.title, '配置 MQTT SSL/TLS 加密')
	assert.ok(mMqttSsl.badges.some(b => b.text.includes('启用 MQTTS') && b.kind === 'ok'))

	const mHttpSsl = parseAndModel('AT+QHTTPCFG="sslctxid",1\r\n')
	assert.equal(mHttpSsl.title, '配置 HTTPS SSL/TLS 证书上下文')
}

// 7.2 TSL (Thing Specification Language 物模型) 测试
{
	const tslPostJson = JSON.stringify({
		id: '1001',
		version: '1.0',
		method: 'thing.event.property.post',
		params: {
			temperature: 25.4,
			battery: 98,
			flow: 1.25
		}
	}) + '\r\n'
	const mTslPost = parseAndModel(tslPostJson)
	assert.equal(mTslPost.title, '物模型属性上报 (TSL Property Post)')
	assert.ok(mTslPost.badges.some(b => b.text === 'TSL 物模型'))
	assert.ok(mTslPost.badges.some(b => b.text === '属性 3 项' && b.kind === 'ok'))
	assert.ok(mTslPost.pairs.some(p => p[0] === '属性: temperature' && p[1] === '25.4'))
	assert.ok(mTslPost.pairs.some(p => p[0] === '属性: flow' && p[1] === '1.25'))

	const tslSetJson = JSON.stringify({
		id: '1002',
		version: '1.0',
		method: 'thing.service.property.set',
		params: {
			valve: 0
		}
	}) + '\r\n'
	const mTslSet = parseAndModel(tslSetJson)
	assert.equal(mTslSet.title, '物模型属性下发 (TSL Property Set)')
	assert.ok(mTslSet.pairs.some(p => p[0] === '属性: valve' && p[1] === '0'))

	const tslReplyJson = JSON.stringify({
		id: '1001',
		code: 200,
		method: 'thing.event.property.post_reply',
		data: {}
	}) + '\r\n'
	const mTslReply = parseAndModel(tslReplyJson)
	assert.equal(mTslReply.title, '物模型服务响应 (TSL Reply)')
}

// 8. findFrame 边界测试
{
	const textEncoder = new (require('node:util').TextEncoder)()
	const bytes1 = textEncoder.encode('AT+CSQ\r\n+CSQ: 24,99\r\n')
	const f1 = M.findFrame(bytes1)
	assert.equal(f1.found, true)
	assert.equal(f1.length, 8) // 'AT+CSQ\r\n'.length = 8

	const bytesPrompt = textEncoder.encode('> ')
	const f2 = M.findFrame(bytesPrompt)
	assert.equal(f2.found, true)
	assert.equal(f2.length, 1)
}


// 7.1.1 扩展 SSL/TLS 指令与状态测试 (QSSLRECV, QSSLSTATE, DTLS, SNI)
{
	const mNego = parseAndModel('AT+QSSLCFG="negotiatetime",0,120\r\n')
	assert.ok(mNego.pairs.some(p => p[0].includes('握手超时时间') && p[1].includes('120 秒')))

	const mDtls = parseAndModel('AT+QSSLCFG="dtls",0,1\r\n')
	assert.ok(mDtls.pairs.some(p => p[0].includes('DTLS 模式') && p[1].includes('启用 DTLS')))

	const mSni = parseAndModel('AT+QSSLCFG="snienable",0,1\r\n')
	assert.ok(mSni.pairs.some(p => p[0].includes('SNI') && p[1].includes('已启用')))

	const mRecvCmd = parseAndModel('AT+QSSLRECV=0,1024\r\n')
	assert.equal(mRecvCmd.title, '读取 SSL/TLS 接收缓存')
	assert.ok(mRecvCmd.badges.some(b => b.text.includes('1024 字节')))

	const mStateCmd = parseAndModel('AT+QSSLSTATE\r\n')
	assert.equal(mStateCmd.title, '查询 SSL/TLS 连接状态')

	const mStateResp = parseAndModel('+QSSLSTATE: 0,"SSL CLIENT","180.101.147.115",8883,54321,2,0\r\n')
	assert.equal(mStateResp.title, 'SSL/TLS Socket 连接状态')
	assert.ok(mStateResp.badges.some(b => b.text.includes('已连接') && b.kind === 'ok'))
	assert.ok(mStateResp.pairs.some(p => p[0] === '远端地址' && p[1] === '180.101.147.115:8883'))

	const mRecvResp = parseAndModel('+QSSLRECV: 128\r\n')
	assert.equal(mRecvResp.title, 'SSL/TLS 读出缓存数据')
	assert.ok(mRecvResp.badges.some(b => b.text === '读取 128 字节'))
}


// 9. 安全转义 (XSS 防护) 与 HTML 结构回归测试
{
	const xssPayload = "+QMTRECV: 0,0,\"topic\",\"<img src=x onerror=alert(1)>\"\r\n"
	const rXss = M.parseFrame(xssPayload)
	const fmt = M.formatFrame(rXss)
	assert.ok(!fmt.includes("<img"), "formatFrame 输出不应包含未经转义的 HTML 标签: " + fmt)
	assert.ok(fmt.includes("&lt;img src=x onerror=alert(1)&gt;"), "formatFrame 必须进行 HTML 实体转义")
	assert.ok(fmt.includes("sk-parse"), "formatFrame 应包含结构化容器 sk-parse")

	// 空内容或原始文本的转义
	const rRawXss = { rawText: "<script>alert(1)</script>" }
	const fmtRaw = M.formatFrame(rRawXss)
	assert.ok(!fmtRaw.includes("<script>"), "rawText 必须被转义")
	assert.ok(fmtRaw.includes("&lt;script&gt;"), "rawText 实体转义正确")
}

// 10. findFrame 边界强化 (行内存在 > 字符时不误截断，独立提示符 > 正常识别)
{
	const textEncoder = new (require("node:util").TextEncoder)()
	// 行内包含 > (如 MQTT 接收报文、物模型或文本)
	const textWithGt = '+QMTRECV: 0,0,"topic","a>b"\r\n'
	const bytesWithGt = textEncoder.encode(textWithGt)
	const fGt = M.findFrame(bytesWithGt)
	assert.equal(fGt.found, true)
	assert.equal(fGt.offset, 0, "offset 应为 0，不能把前段截掉")
	assert.equal(fGt.prefix, 0, "prefix 应为 0")
	assert.equal(fGt.length, bytesWithGt.length, "应取完整行长度")

	// 提示符单独成帧
	const promptBytes = textEncoder.encode("> ")
	const fPrompt = M.findFrame(promptBytes)
	assert.equal(fPrompt.found, true)
	assert.equal(fPrompt.length, 1)

	// 普通未换行命令 (未收齐) 不应截取
	const incomplete = textEncoder.encode("AT+QISEND=0,10")
	const fInc = M.findFrame(incomplete)
	assert.equal(fInc.found, false, "未遇到 \n 时普通命令不应判定为成帧")
}

// 11. 版本号校验
{
	const verFile = fs.readFileSync(path.join(__dirname, "../js/version.js"), "utf8")
	assert.ok(verFile.includes("1.67.0"), "版本号应为 1.67.0")
}

console.log("All cellular AT protocol regression tests passed!");
