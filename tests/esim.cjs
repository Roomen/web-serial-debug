// Run: node tests/esim.cjs — synthetic data only.
// 覆盖: SEK Tag=66 / Tag=10 ID=66 编解码与 logView 脱敏、profile_class 反转与位域解码、
// ID4 模组码/时间戳解析、Profile 防误操作校验、ZMODEM 停等 CRC32 环回、mode=1 四轮 ES9+ 状态机(HTTP 200/204/CAN*5)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const Zmodem = require('../js/zmodem.js')
const EsimCore = require('../js/esim-core.js')

// 加载 SEK 协议脚本做帧编解码与 logView 回归（同步注入 EsimCore，与浏览器一致）
const window = { registerProtocol() {}, EsimCore }
const ctx = {
	window,
	Uint8Array,
	BigInt,
	TextDecoder,
	TextEncoder,
	console,
	localStorage: { getItem() { return null }, setItem() {} },
	document: { getElementById() { return null } },
}
vm.createContext(ctx)
for (const f of ['parse-view', 'protocol-schema', 'protocol-crypto', 'protocol']) {
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8'), ctx)
}

function sekUpWithUid(fc, tlv, uidBytes) {
	const uid = uidBytes || [0x00, 0x12, 0x34, 0x56, 0x78, 0x90, 0x12]
	const head = [
		0xA9, 0x9A, 0x11, 0x00, 0x02, 0x01, 0x10,
	].concat(uid, [
		0x9C, 0xFF, 0x0A, 0x00, 0x00, 0x1A, fc, 0x00,
	])
	const data = [tlv.length & 255, tlv.length >> 8].concat(tlv)
	const f = head.concat([data.length & 255, data.length >> 8]).concat(data)
	const c = window.skCrc16(Uint8Array.from(f))
	return Uint8Array.from(f.concat([c & 255, c >> 8, 0x16]))
}

function sekUp(fc, tlv) {
	return sekUpWithUid(fc, tlv)
}

function tlvBlock(tag, items) {
	let payload = []
	for (const it of items) payload = payload.concat(Array.from(it))
	return [tag, payload.length & 255, payload.length >> 8].concat(payload)
}

function asciiPadded(s, len) {
	const out = new Array(len).fill(0)
	for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.charCodeAt(i) & 0xff
	return out
}

// 1. profile_class 反转映射与状态位域编解码
{
	assert.equal(EsimCore.mapAtProfileClassToId1(2), 0, 'AT 操作文件(2) -> ID1 运营(0)')
	assert.equal(EsimCore.mapAtProfileClassToId1(1), 1, 'AT 预置文件(1) -> ID1 预置/引导(1)')
	assert.equal(EsimCore.mapAtProfileClassToId1(0), 2, 'AT 测试文件(0) -> ID1 测试(2)')
	assert.equal(EsimCore.mapAtProfileClassToId1(9), 3, '其他 -> 保留(3)')

	const f1 = EsimCore.encodeProfileFlags({ enabled: true, profileClass: 0, pprDisableBlocked: false, pprDeleteBlocked: true, fallback: true })
	assert.equal(f1, 0x0031)
	const d1 = EsimCore.decodeProfileFlags(f1)
	assert.equal(d1.enabled, true)
	assert.equal(d1.profileClass, 0)
	assert.equal(d1.profileClassLabel, '运营')
	assert.equal(d1.pprDisableBlocked, false)
	assert.equal(d1.pprDeleteBlocked, true)
	assert.equal(d1.fallback, true)
}

// 2. SEK Tag=10 ID=66 查询帧与 0x83 Tag=66 (ID0 + ID1 + ID4) 解码与 logView
{
	const qFrame = window.skBuildDownFrame({
		frameSeq: 7,
		version: 2,
		funcCode: 0x03,
		tlv: [{ tag: 10, items: [{ id: 66, value: null }] }],
	})
	const qParsed = window.skParseFrame(qFrame)
	assert.equal(qParsed.ok, true)
	assert.equal(qParsed.tlv[0].tag, 10)
	assert.equal(qParsed.tlv[0].items[0].id, 66)
	assert.equal(qParsed.tlv[0].items[0].name, 'eSIM信息')

	// 构造 0x83 + Tag66 (ID0 EID + ID1 2个Profile + ID4 严格12B: 状态/操作/阶段/0x090C模组码/7B BCD时间)
	const eidBytes = [0x89, 0x04, 0x90, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78]
	const p1Flags = EsimCore.encodeProfileFlags({ enabled: true, profileClass: 0 })
	const p2Flags = EsimCore.encodeProfileFlags({ enabled: false, profileClass: 1, pprDeleteBlocked: true })
	const id1Val = [2]
		.concat(asciiPadded('89860011223344556677', 20), [p1Flags & 0xff, p1Flags >> 8])
		.concat(asciiPadded('89860099887766554433', 20), [p2Flags & 0xff, p2Flags >> 8])
	const id4Val = [3, 2, 6, 0x0C, 0x09, 0x20, 0x26, 0x11, 0x24, 0x19, 0x30, 0x00]

	const up = sekUp(0x83, tlvBlock(66, [
		[0].concat(eidBytes),
		[1].concat(id1Val),
		[4].concat(id4Val),
	]))
	// 2a. 未查过模组版本时，0x090C 仅显示原始十六进制并标注未识别模组，不套用 EG800Z 0x8500xxxx 文案
	window.skSession.resetModule()
	const parsedUnknown = window.skParseFrame(up)
	assert.equal(parsedUnknown.ok, true)
	assert.equal(parsedUnknown.tlv.length, 1)
	assert.equal(parsedUnknown.tlv[0].tag, 66)
	assert.equal(parsedUnknown.tlv[0].name, 'eSIM管理')
	assert.equal(parsedUnknown.tlv[0].items.length, 3)
	assert.equal(parsedUnknown.tlv[0].items[0].decoded, '89049032000000000000000012345678')
	assert.ok(parsedUnknown.tlv[0].items[1].decoded.includes('89860011223344556677'))
	assert.ok(parsedUnknown.tlv[0].items[1].decoded.includes('启用,运营'))
	assert.ok(parsedUnknown.tlv[0].items[1].decoded.includes('禁用,预置/引导,禁删PPR'))
	assert.ok(parsedUnknown.tlv[0].items[2].decoded.includes('0x090C（未识别模组）'))
	assert.ok(!parsedUnknown.tlv[0].items[2].decoded.includes('0x8500090C'), '未识别模组时绝不可套用 EG800Z 0x8500xxxx')
	assert.ok(!parsedUnknown.tlv[0].items[2].decoded.includes('PE 处理错误'), '未识别模组时绝不可套用 EG800Z 文案')
	const lvUnknown = window.skLogView(parsedUnknown)
	assert.ok(lvUnknown && lvUnknown.sections.length === 1)
	assert.equal(lvUnknown.sections[0].title, 'Tag66 eSIM管理')
	assert.equal(lvUnknown.sections[0].pairs.length, 3)
	assert.ok(lvUnknown.notes.some((n) => n.kind === 'warn' && n.text.includes('未识别模组')), '未识别模组遇到 0x0001~0x117F 时 logView 应给出提示')

	// 2b. 通过 Tag=1 ID=10 识别到 EG800Z 模组后，启用 EG800Z +QESIM 专属码表与 0x8500xxxx
	const tag1Eg800z = sekUp(0x83, tlvBlock(1, [
		[10].concat(asciiPadded('EG800ZEULAR09A01M04_BETA261020_E', 32)),
	]))
	const parsedTag1 = window.skParseFrame(tag1Eg800z)
	assert.equal(parsedTag1.ok, true)
	assert.equal(window.skSession.isEg800z(), true)
	assert.equal(window.skSession.moduleVersion, 'EG800ZEULAR09A01M04_BETA261020_E')

	const parsed = window.skParseFrame(up)
	assert.equal(parsed.ok, true)
	assert.ok(parsed.tlv[0].items[2].decoded.includes('失败'))
	assert.ok(parsed.tlv[0].items[2].decoded.includes('0x8500090C'))
	assert.ok(parsed.tlv[0].items[2].decoded.includes('PE 处理错误'))
	assert.ok(parsed.tlv[0].items[2].decoded.includes('2026-11-24 19:30:00'))

	const lv = window.skLogView(parsed)
	assert.ok(lv && lv.sections.length === 1)
	assert.equal(lv.sections[0].title, 'Tag66 eSIM管理')
	assert.equal(lv.sections[0].pairs.length, 3)
	assert.ok(!lv.notes.some((n) => n.text.includes('未识别模组')), '已识别 EG800Z 不应再提示未识别模组')

	// 2c. 识别到非 EG800Z 模组（如 EG800K / BC660K）时，0x090C 仅保留原始十六进制码，不套用 EG800Z 文案也不提示未识别
	const tag1Other = sekUp(0x83, tlvBlock(1, [
		[10].concat(asciiPadded('BC660KGLAAR01A05', 32)),
		[12].concat(asciiPadded('BC660K', 16)),
	]))
	assert.equal(window.skParseFrame(tag1Other).ok, true)
	assert.equal(window.skSession.isEg800z(), false)
	const parsedOther = window.skParseFrame(up)
	assert.ok(parsedOther.tlv[0].items[2].decoded.includes('模组码:0x090C '))
	assert.ok(!parsedOther.tlv[0].items[2].decoded.includes('0x8500090C'))
	assert.ok(!parsedOther.tlv[0].items[2].decoded.includes('PE 处理错误'))
	assert.ok(!parsedOther.tlv[0].items[2].decoded.includes('未识别模组'))
	const lvOther = window.skLogView(parsedOther)
	assert.ok(!lvOther.notes.some((n) => n.text.includes('未识别模组')), '已识别非 EG800Z 时不应提示未识别模组')

	// 2d. 换表（设备唯一码变更）必须重置模组识别状态，避免上一台 EG800Z 的识别泄漏到新设备；snapshot/restore 保持一致
	assert.equal(window.skParseFrame(tag1Eg800z).ok, true)
	const snapEg = window.skSession.snapshot()
	assert.equal(snapEg.moduleVersion, 'EG800ZEULAR09A01M04_BETA261020_E')
	const upOtherDevice = sekUpWithUid(0x83, tlvBlock(66, [[4].concat(id4Val)]), [0x00, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44])
	const parsedOtherDev = window.skParseFrame(upOtherDevice)
	assert.equal(window.skSession.hasModule(), false, '切换设备唯一码必须清空模组版本缓存')
	assert.ok(parsedOtherDev.tlv[0].items[0].decoded.includes('0x090C（未识别模组）'))
	assert.ok(!parsedOtherDev.tlv[0].items[0].decoded.includes('0x8500090C'))
	window.skSession.restore(snapEg)
	assert.equal(window.skSession.isEg800z(), true, 'restore 应恢复会话快照中的模组版本')
	window.skSession.resetModule()

	// 结构化解码器测试（严格 12B：含空闲全 0 时间戳与 9B 截断拒绝）
	assert.equal(EsimCore.decodeEid(new Uint8Array(16)).ready, false)
	const stUnknown = EsimCore.decodeStatus(id4Val)
	assert.equal(stUnknown.state, 3)
	assert.equal(stUnknown.failStage, 6)
	assert.equal(stUnknown.moduleErrCode, 0x090C)
	assert.equal(stUnknown.errCategory, 'module-unidentified')
	assert.equal(stUnknown.qesimFullCode, '')
	assert.equal(stUnknown.errName, '')
	assert.ok(stUnknown.errDisplay.includes('0x090C'))
	assert.ok(stUnknown.errHint.includes('Tag1'))

	const stEg = EsimCore.decodeStatus(id4Val, { moduleVersion: 'EG800ZEULAR08A02M04_ESIM_01.001.01.001' })
	assert.equal(stEg.state, 3)
	assert.equal(stEg.failStage, 6)
	assert.equal(stEg.moduleErrCode, 0x090C)
	assert.equal(stEg.errCategory, 'qesim')
	assert.equal(stEg.qesimFullCode, '0x8500090C')
	assert.ok(stEg.errName.includes('PE 处理错误'))
	assert.equal(stEg.timeText, '2026-11-24 19:30:00')
	assert.ok(stEg.errHint.length > 0)

	const stOther = EsimCore.decodeStatus(id4Val, { moduleVersion: 'EG800KEULAR08A01M04' })
	assert.equal(stOther.errCategory, 'module-other')
	assert.equal(stOther.qesimFullCode, '')
	assert.equal(stOther.errName, '')
	assert.equal(stOther.errHint, '')
	assert.equal(stOther.errDisplay, '0x090C')

	const id4Idle = [0, 0, 0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
	const upIdle = sekUp(0x83, tlvBlock(66, [[4].concat(id4Idle)]))
	const parsedIdle = window.skParseFrame(upIdle)
	assert.equal(parsedIdle.ok, true)
	assert.equal(parsedIdle.tlv[0].items.length, 1, '全0空闲12B ID4不得误判为9B把末尾3B拆成伪ID')
	assert.equal(parsedIdle.tlv[0].items[0].raw.length, 12)
	const stIdle = EsimCore.decodeStatus(id4Idle)
	assert.equal(stIdle.state, 0)
	assert.equal(stIdle.errCategory, 'none')
	assert.equal(stIdle.timeText, '')

	// 9B 截断 ID4 必须判不完整 / 返回 null
	assert.equal(EsimCore.decodeStatus([3, 2, 6, 0x0C, 0x09, 0x00, 0x00, 0x00, 0x00]), null)
	const upTrunc = sekUp(0x83, tlvBlock(66, [[4, 3, 2, 6, 0x0C, 0x09, 0x00, 0x00, 0x00, 0x00]]))
	const parsedTrunc = window.skParseFrame(upTrunc)
	assert.equal(parsedTrunc.tlv[0].items[0].partial, true)
}

// 2.5. EG800Z 识别、完整 +QESIM 码表与 0xE1xx / 0xE2xx / 0xE3se / 0xE4rn 细分子错误码全分区测试
{
	// 模组识别边界（按型号前缀判断）
	const egProf1 = EsimCore.detectModuleProfile('EG800ZEULAR09A01M04_BETA261020_E')
	assert.equal(egProf1.isEg800z, true)
	assert.equal(egProf1.modelPrefix, 'EG800Z')
	assert.equal(EsimCore.detectModuleProfile('EG800ZEULAR08A02M04_ESIM_01.001.01.001').isEg800z, true)
	assert.equal(EsimCore.detectModuleProfile('eg800z-eu').isEg800z, true)
	assert.equal(EsimCore.detectModuleProfile({ moduleModel: 'EG800Z' }).isEg800z, true)
	assert.equal(EsimCore.detectModuleProfile({ moduleModel: 'Quectel EG800Z' }).isEg800z, true)
	assert.equal(EsimCore.detectModuleProfile('OTHER_EG800Z_TEST').isEg800z, false, '仅识别开头型号前缀，不误匹配中间子串')
	const egkProf = EsimCore.detectModuleProfile('EG800KEULAR08A01M04')
	assert.equal(egkProf.isEg800z, false)
	assert.equal(egkProf.known, true)
	assert.equal(egkProf.modelPrefix, 'EG800K')
	const bcProf = EsimCore.detectModuleProfile('BC660KGLAAR01A05')
	assert.equal(bcProf.isEg800z, false)
	assert.equal(bcProf.modelPrefix, 'BC660K')
	assert.equal(EsimCore.detectModuleProfile('').known, false)
	assert.equal(EsimCore.detectModuleProfile('\x00\x00\x00').known, false)
	assert.equal(EsimCore.detectModuleProfile('00000000').known, false)

	// 完整 EG800Z +QESIM 码表（含 0x000F~0x0015 区间与 0x0B03~0x0B0B）
	const egMod = { moduleVersion: 'EG800ZEULAR09A01M04_BETA261020_E' }
	const qesimCases = [
		[0x0004, '操作超时'],
		[0x0005, '通用错误'],
		[0x0008, '消息发送错误'],
		[0x000B, 'APDU 解析错误'],
		[0x000E, '文件系统操作错误'],
		[0x000F, 'HTTP / TLS'],
		[0x0012, 'HTTP / TLS'],
		[0x0015, 'HTTP / TLS'],
		[0x0016, 'SM-DP+ 返回错误'],
		[0x0017, '网络/连接超时'],
		[0x0018, '网络/连接超时'],
		[0x0019, '网络错误'],
		[0x0102, 'Profile 已处于启用态'],
		[0x0105, '卡应用繁忙'],
		[0x0203, 'PPR 策略禁止禁用'],
		[0x0204, '卡应用繁忙'],
		[0x0302, '仍处于启用态'],
		[0x0303, 'PPR 策略禁止删除'],
		[0x0704, '无会话上下文'],
		[0x0705, '无效 OID'],
		[0x0706, 'Challenge 不匹配'],
		[0x0909, 'ICCID 已存在'],
		[0x090C, 'PE 处理错误'],
		[0x0B03, 'eUICC 证书无效'],
		[0x0B04, 'eUICC 证书已过期'],
		[0x0B05, 'eUICC 签名无效'],
		[0x0B06, 'MatchingID 被拒绝'],
		[0x0B07, 'EID 不匹配'],
		[0x0B08, '没有符合条件的 Profile'],
		[0x0B09, '未知的 CI 公钥'],
		[0x0B0A, '交易 ID 未知'],
		[0x0B0B, 'eUICC 存储空间不足'],
	]
	for (const [code, keyword] of qesimCases) {
		const r = EsimCore.decodeModuleErrCode(code, egMod)
		assert.equal(r.category, 'qesim', 'code 0x' + code.toString(16))
		assert.equal(r.qesimFullCode, '0x8500' + code.toString(16).toUpperCase().padStart(4, '0'))
		assert.ok(r.name.includes(keyword), '0x' + code.toString(16) + ' name=' + r.name)
		assert.ok(r.displayText.includes(r.qesimFullCode) && r.displayText.includes(keyword))
		// 非 EG800Z 绝不套用 EG800Z 文案
		const rOther = EsimCore.decodeModuleErrCode(code, { moduleVersion: 'BC660KGLAAR01A05' })
		assert.equal(rOther.category, 'module-other')
		assert.equal(rOther.qesimFullCode, '')
		assert.equal(rOther.name, '')
	}
	// 区间内未收录的 EG800Z 原始码仍保留 0x8500xxxx
	const rUnmappedEg = EsimCore.decodeModuleErrCode(0x0501, egMod)
	assert.equal(rUnmappedEg.category, 'qesim')
	assert.equal(rUnmappedEg.qesimFullCode, '0x85000501')
	assert.equal(rUnmappedEg.displayText, '0x0501 (0x85000501)')

	// 0xE1xx：模组 +CME ERROR（不依赖模组识别）
	const cme53 = EsimCore.decodeModuleErrCode(0xE135)
	assert.equal(cme53.category, 'cme')
	assert.equal(cme53.qesimFullCode, '')
	assert.equal(cme53.name, '+CME ERROR: 53 (参数非法)')
	assert.equal(cme53.displayText, '0xE135 (+CME ERROR: 53 (参数非法))')
	assert.equal(EsimCore.decodeModuleErrCode(0xE10A).name, '+CME ERROR: 10 (SIM 未插入)')
	assert.equal(EsimCore.decodeModuleErrCode(0xE10D).name, '+CME ERROR: 13 (SIM 故障)')
	assert.equal(EsimCore.decodeModuleErrCode(0xE11E).name, '+CME ERROR: 30')
	const cmeSat = EsimCore.decodeModuleErrCode(0xE1FF)
	assert.equal(cmeSat.detail.saturated, true)
	assert.equal(cmeSat.name, '+CME ERROR: ≥255')

	// 0xE2xx：mode=0 上电/入网与前置步骤失败（不依赖模组识别）
	const precondCases = [
		[0xE201, 'commuEnable'],
		[0xE202, 'AT+CFUN=1'],
		[0xE203, 'AT+CEREG'],
		[0xE204, 'AT+CGATT'],
		[0xE205, 'AT+QIACT=1'],
		[0xE206, 'AT+QIACT?'],
		[0xE207, 'AT+CSQ'],
		[0xE208, 'mode=1'],
	]
	for (const [code, kw] of precondCases) {
		const r = EsimCore.decodeModuleErrCode(code)
		assert.equal(r.category, 'precond')
		assert.equal(r.qesimFullCode, '')
		assert.ok(r.name.includes(kw), '0x' + code.toString(16) + ' -> ' + r.name)
	}

	// 0xE3se：AT+QESIM 状态机内部错误（不依赖模组识别）
	const fsm67 = EsimCore.decodeModuleErrCode(0xE367)
	assert.equal(fsm67.category, 'qesim-fsm')
	assert.equal(fsm67.qesimFullCode, '')
	assert.equal(fsm67.detail.stateName, 'WAIT_URC')
	assert.equal(fsm67.detail.statusName, '超时')
	assert.ok(fsm67.displayText.includes('WAIT_URC') && fsm67.displayText.includes('超时'))

	const fsm8C = EsimCore.decodeModuleErrCode(0xE38C)
	assert.equal(fsm8C.detail.stateName, 'REINJECTING')
	assert.equal(fsm8C.detail.statusName, '响应含 HTTP 头')

	const fsmBF = EsimCore.decodeModuleErrCode(0xE3BF)
	assert.equal(fsmBF.detail.stateName, 'ABORTED')
	assert.equal(fsmBF.detail.statusName, '部分中止')

	// 0xE4rn：mode=1 近端 ZMODEM 传输失败（不依赖模组识别）
	const zmAB = EsimCore.decodeModuleErrCode(0xE4AB)
	assert.equal(zmAB.category, 'zmodem')
	assert.equal(zmAB.qesimFullCode, '')
	assert.equal(zmAB.detail.dir, 1)
	assert.equal(zmAB.detail.round, 2)
	assert.equal(zmAB.detail.dirLabel, 'Host→MCU 收响应')
	assert.ok(zmAB.detail.zmodemName.includes('对端 CAN 取消'))
	assert.ok(zmAB.displayText.includes('第 2 轮') && zmAB.displayText.includes('Host→MCU 收响应') && zmAB.displayText.includes('CAN 取消'))

	const zm12 = EsimCore.decodeModuleErrCode(0xE412)
	assert.equal(zm12.detail.dir, 0)
	assert.equal(zm12.detail.round, 1)
	assert.equal(zm12.detail.dirLabel, 'MCU→Host 发请求')
	assert.equal(zm12.detail.zmodemName, '读超时')

	const zm9E = EsimCore.decodeModuleErrCode(0xE49E)
	assert.equal(zm9E.detail.dir, 1)
	assert.equal(zm9E.detail.round, 1)
	assert.equal(zm9E.detail.zmodemName, '未收到 ZFILE')

	const zm03 = EsimCore.decodeModuleErrCode(0xE403)
	assert.equal(zm03.detail.round, 0)
	assert.equal(zm03.detail.roundLabel, '未知轮次')
	assert.equal(zm03.detail.zmodemName, 'I/O 断开')

	// 协议帧端到端解析：未识别模组时 0xE1xx ~ 0xE4xx 仍应正常解析且不弹出「未识别模组」警告
	window.skSession.resetModule()
	for (const [code, expectSub] of [
		[0xE135, '+CME ERROR: 53 (参数非法)'],
		[0xE205, 'AT+QIACT=1 PDP 激活失败'],
		[0xE367, 'WAIT_URC'],
		[0xE4AB, '第 2 轮'],
	]) {
		const id4 = [3, 2, 7, code & 0xff, (code >> 8) & 0xff, 0x20, 0x26, 0x11, 0x26, 0x20, 0x00, 0x00]
		const pf = window.skParseFrame(sekUp(0x83, tlvBlock(66, [[4].concat(id4)])))
		assert.equal(pf.ok, true)
		assert.ok(pf.tlv[0].items[0].decoded.includes(expectSub), '0x' + code.toString(16) + ' decoded=' + pf.tlv[0].items[0].decoded)
		assert.ok(!pf.tlv[0].items[0].decoded.includes('0x8500'), '0xE1xx~0xE4xx 绝不能拼 0x8500')
		const plv = window.skLogView(pf)
		assert.ok(!plv.notes.some((n) => n.text.includes('未识别模组')), '0xE1xx~0xE4xx 不应提示未识别模组')
	}
}

// 3. Tag=66 ID=2 下载触发编码与 AC/CC 脱敏验证（严禁明文出现在解析输出与 logData 中）
{
	const secretAc = 'LPA:1$smdp.example.invalid$SECRET-MATCHING-ID-987654'
	const secretCc = 'CONF-CODE-4321'
	const val = EsimCore.encodeDownloadTrigger({ mode: 1, ac: secretAc, cc: secretCc })
	assert.equal(val[0], 1)
	assert.equal(val[1], secretAc.length)
	assert.equal(val[2 + secretAc.length], secretCc.length)

	const redacted = EsimCore.redactDownloadValue(val)
	assert.equal(redacted.length, val.length)
	assert.ok(!Buffer.from(redacted).toString('ascii').includes('SECRET-MATCHING-ID'))
	assert.ok(!Buffer.from(redacted).toString('ascii').includes('CONF-CODE-4321'))

	const downFrame = window.skBuildDownFrame({
		frameSeq: 8,
		version: 2,
		funcCode: 0x01,
		tlv: [{ tag: 66, items: [{ id: 2, value: val }] }],
	})
	const parsed = window.skParseFrame(downFrame)
	assert.equal(parsed.ok, true)
	const decoded = parsed.tlv[0].items[0].decoded
	assert.ok(decoded.includes('近端外部代理'))
	assert.ok(decoded.includes('已脱敏'))
	assert.ok(!decoded.includes('SECRET-MATCHING-ID'), '解码输出绝不能包含明文 AC')
	assert.ok(!decoded.includes('CONF-CODE-4321'), '解码输出绝不能包含明文 CC')

	const lvHtml = window.ParseView.render(window.skLogView(parsed))
	assert.ok(!lvHtml.includes('SECRET-MATCHING-ID'), 'ParseView 绝不能包含明文 AC')
	assert.ok(!lvHtml.includes('CONF-CODE-4321'), 'ParseView 绝不能包含明文 CC')
}

// 4. Tag=66 ID=3 Profile 管理编码与防误操作校验
{
	const mVal = EsimCore.encodeProfileManage({ op: 3, iccid: '89860099887766554433' })
	assert.equal(mVal.length, 21)
	assert.equal(mVal[0], 3)

	const pEnabled = { iccid: '89860011223344556677', enabled: true, pprDisableBlocked: false, pprDeleteBlocked: false }
	const pDisabled = { iccid: '89860099887766554433', enabled: false, pprDisableBlocked: false, pprDeleteBlocked: false }

	const delEnabled = EsimCore.validateProfileAction(3, pEnabled, [pEnabled, pDisabled])
	assert.equal(delEnabled.allowed, false, '启用态 Profile 必须被阻止删除')

	const delDisabled = EsimCore.validateProfileAction(3, pDisabled, [pEnabled, pDisabled])
	assert.equal(delDisabled.allowed, true)
	assert.ok(delDisabled.confirm.includes('60 秒'))

	const disOnly = EsimCore.validateProfileAction(2, pEnabled, [pEnabled])
	assert.equal(disOnly.allowed, true)
	assert.ok(disOnly.confirm.includes('唯一启用'))
}

// 5. ZMODEM 环回测试（含 ZDLE 特殊字节、>1024B 多包与 0 字节空传输）
function makePipePair() {
	const qA = Zmodem.createByteQueue()
	const qB = Zmodem.createByteQueue()
	const logAtoB = []
	const logBtoA = []
	const ioA = {
		readByte: (ms) => qB.readByte(ms),
		writeBytes: async (u8) => { logAtoB.push(new Uint8Array(u8)); qA.push(u8) },
	}
	const ioB = {
		readByte: (ms) => qA.readByte(ms),
		writeBytes: async (u8) => { logBtoA.push(new Uint8Array(u8)); qB.push(u8) },
	}
	return { ioA, ioB, logAtoB, logBtoA }
}

async function runAsyncTests() {
	// 5a. 多包 + ZDLE 转义字符环回
	{
		const { ioA, ioB } = makePipePair()
		const payload = new Uint8Array(2500)
		for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff
		// 注入特殊字节：ZDLE(0x18), XON(0x11), XOFF(0x13), '@' + '\r'
		payload[10] = 0x18
		payload[11] = 0x11
		payload[12] = 0x13
		payload[13] = 0x40
		payload[14] = 0x0d

		const [txRes, rxRes] = await Promise.all([
			Zmodem.send(ioA, { fileName: '/gsma/rsp2/es9plus/getBoundProfilePackage', data: payload }, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 }),
			Zmodem.receive(ioB, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 }),
		])
		assert.equal(txRes.transferredBytes, payload.length)
		assert.equal(rxRes.fileName, '/gsma/rsp2/es9plus/getBoundProfilePackage')
		assert.equal(rxRes.expectedSize, payload.length)
		assert.deepEqual(rxRes.data, payload)
	}

	// 5b. 0 字节空传输（第 4 轮 HTTP 204）
	{
		const { ioA, ioB } = makePipePair()
		const [txRes, rxRes] = await Promise.all([
			Zmodem.send(ioA, { fileName: '/gsma/rsp2/es9plus/handleNotification', data: new Uint8Array(0) }, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 }),
			Zmodem.receive(ioB, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 }),
		])
		assert.equal(txRes.transferredBytes, 0)
		assert.equal(rxRes.expectedSize, 0)
		assert.equal(rxRes.hasExpectedSize, true)
		assert.equal(rxRes.data.length, 0)
	}

	// 6a. mode=1 四轮 ES9+ 完整成功（第 1~3 轮 HTTP 200 原字节透传，第 4 轮 HTTP 204 空传输）
	{
		const { ioA: proxyIo, ioB: mcuIo } = makePipePair()
		const enc = new TextEncoder()
		const rawResponses = [
			enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}},"transactionId":"T1","keepOrder":true}'),
			enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}},"transactionId":"T1","round":2}'),
			enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}},"boundProfilePackage":"' + 'A'.repeat(2400) + '"}'),
			new Uint8Array(0),
		]
		const mcuReceived = []
		const httpCalls = []

		const mcuTask = (async () => {
			for (let r = 0; r < 4; r++) {
				const pathStr = EsimCore.ES9_ROUNDS[r].path
				const reqPayload = enc.encode(JSON.stringify({ smdpAddress: 'smdp.test.invalid', round: r + 1 }))
				await Zmodem.send(mcuIo, { fileName: pathStr, data: reqPayload }, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 })
				const resp = await Zmodem.receive(mcuIo, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 })
				mcuReceived.push(resp)
			}
		})()

		const proxyTask = EsimCore.runMode1ProxySession({
			zmodem: Zmodem,
			io: proxyIo,
			smdpHost: 'smdp.test.invalid',
			zmodemOpts: { readTimeoutMs: 1000, sessionTimeoutMs: 5000 },
			httpPost: async (req) => {
				httpCalls.push(req)
				const idx = httpCalls.length - 1
				return { status: idx === 3 ? 204 : 200, bodyBytes: rawResponses[idx] }
			},
		})

		const [res] = await Promise.all([proxyTask, mcuTask])
		assert.equal(res.ok, true)
		assert.equal(httpCalls.length, 4)
		assert.equal(httpCalls[0].url, 'https://smdp.test.invalid/gsma/rsp2/es9plus/initiateAuthentication')
		assert.equal(httpCalls[0].headers['X-Admin-Protocol'], 'gsma/rsp/v2.2.0')
		assert.equal(httpCalls[0].headers['User-Agent'], 'gsma-rsp-lpad')
		assert.equal(httpCalls[0].headers['Connection'], 'close')
		// 验证前 3 轮逐字节原样回传，第 4 轮 expectedSize === 0
		for (let r = 0; r < 3; r++) {
			assert.equal(mcuReceived[r].expectedSize, rawResponses[r].length)
			assert.deepEqual(mcuReceived[r].data, rawResponses[r])
		}
		assert.equal(mcuReceived[3].expectedSize, 0)
		assert.equal(mcuReceived[3].data.length, 0)
	}

	// 6b. SM-DP+ 返回 Failed（Executed-Success 不通过）-> 立即发 CAN*5 中止，绝不把失败体回灌给 MCU
	{
		const { ioA: proxyIo, ioB: mcuIo, logAtoB } = makePipePair()
		const enc = new TextEncoder()
		const failBody = enc.encode(JSON.stringify({
			header: {
				functionExecutionStatus: {
					status: 'Failed',
					statusCodeData: { subjectCode: '8.2.6', reasonCode: '3.8', message: 'Order cancelled' },
				},
			},
		}))

		const mcuTask = (async () => {
			await Zmodem.send(mcuIo, {
				fileName: '/gsma/rsp2/es9plus/initiateAuthentication',
				data: enc.encode('{"smdpAddress":"smdp.test.invalid"}'),
			}, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 })
			let aborted = false
			try {
				await Zmodem.receive(mcuIo, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 })
			} catch (e) {
				aborted = e.zmodemCode === Zmodem.STATUS.ERR_ABORTED
			}
			assert.equal(aborted, true, 'MCU 端必须收到 CAN*5 中止而不是失败 JSON')
		})()

		await assert.rejects(
			() => EsimCore.runMode1ProxySession({
				zmodem: Zmodem,
				io: proxyIo,
				smdpHost: 'smdp.test.invalid',
				zmodemOpts: { readTimeoutMs: 1000, sessionTimeoutMs: 5000 },
				httpPost: async () => ({ status: 200, bodyBytes: failBody }),
			}),
			(err) => {
				assert.equal(err.stage, 'smdp-status')
				assert.equal(err.subjectCode, '8.2.6')
				assert.equal(err.reasonCode, '3.8')
				return true
			}
		)
		await mcuTask
		// 确认发出的最后一个块包含连续 5+ 个 0x18 (CAN)
		const lastTx = logAtoB[logAtoB.length - 1]
		let maxCan = 0, cur = 0
		for (const b of lastTx) {
			if (b === 0x18) { cur++; if (cur > maxCan) maxCan = cur } else cur = 0
		}
		assert.ok(maxCan >= 5, '失败时必须发送 CAN*5+ 中止序列')
	}

	// 6c. 第 4 轮返回非 204 -> 发 CAN*5 中止
	{
		const { ioA: proxyIo, ioB: mcuIo } = makePipePair()
		const enc = new TextEncoder()
		const okBody = enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}}}')

		const mcuTask = (async () => {
			for (let r = 0; r < 4; r++) {
				await Zmodem.send(mcuIo, { fileName: EsimCore.ES9_ROUNDS[r].path, data: enc.encode('{}') }, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 })
				if (r < 3) {
					await Zmodem.receive(mcuIo, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 })
				} else {
					await assert.rejects(
						() => Zmodem.receive(mcuIo, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 }),
						(e) => e.zmodemCode === Zmodem.STATUS.ERR_ABORTED
					)
				}
			}
		})()

		let call = 0
		await assert.rejects(
			() => EsimCore.runMode1ProxySession({
				zmodem: Zmodem,
				io: proxyIo,
				smdpHost: 'smdp.test.invalid',
				zmodemOpts: { readTimeoutMs: 1000, sessionTimeoutMs: 5000 },
				httpPost: async () => {
					call++
					if (call <= 3) return { status: 200, bodyBytes: okBody }
					return { status: 500, bodyBytes: new Uint8Array(0) }
				},
			}),
			(err) => err.round === 3 && err.stage === 'http-status'
		)
		await mcuTask
	}

	// 7. B1 回归：长延迟等待 MCU 首个帧头超过 readTimeoutMs * maxRetries，仍只受 initialWaitMs 约束、不提前发 CAN*5
	{
		assert.ok(EsimCore.ES9_ROUNDS[0].initialWaitMs >= 90000, '第 1 轮 initialWaitMs 须 >= 90s')
		assert.ok(EsimCore.ES9_ROUNDS[1].initialWaitMs >= 60000, '第 2 轮 initialWaitMs 须 >= 60s')
		assert.ok(EsimCore.ES9_ROUNDS[2].initialWaitMs >= 60000, '第 3 轮 initialWaitMs 须 >= 60s')
		assert.ok(EsimCore.ES9_ROUNDS[3].initialWaitMs >= 180000, '第 4 轮 initialWaitMs 须 >= 180s')

		const { ioA: senderIo, ioB: recvIo, logBtoA } = makePipePair()
		const payload = new TextEncoder().encode('{"delayed":true}')
		// readTimeoutMs=20ms, maxRetries=2 (常规 60ms 即耗尽)，但 initialWaitMs=400ms，MCU 延迟 120ms 后才发 ZFILE
		const delayedSend = (async () => {
			await new Promise((r) => setTimeout(r, 120))
			return Zmodem.send(senderIo, { fileName: '/gsma/rsp2/es9plus/handleNotification', data: payload }, {
				readTimeoutMs: 200,
				sessionTimeoutMs: 2000,
				maxRetries: 3,
			})
		})()
		const rx = await Zmodem.receive(recvIo, {
			readTimeoutMs: 20,
			sessionTimeoutMs: 1000,
			initialWaitMs: 400,
			maxRetries: 2,
		})
		await delayedSend
		assert.deepEqual(rx.data, payload)
		// 确认等待期间未误发 CAN*5
		for (const chunk of logBtoA) {
			let cur = 0
			for (const b of chunk) {
				if (b === 0x18) cur++; else cur = 0
				assert.ok(cur < 5, '等待 initialWaitMs 期间绝不可提前发 CAN*5')
			}
		}
	}

	// 8. I1 回归：httpPost 挂起时用户 abort（不依赖原生取消命令），经 Promise.race 立刻放弃等待并向 MCU 发 CAN*5
	{
		const { ioA: proxyIo, ioB: mcuIo, logAtoB } = makePipePair()
		const enc = new TextEncoder()
		const ac = new AbortController()

		const mcuTask = (async () => {
			await Zmodem.send(mcuIo, {
				fileName: '/gsma/rsp2/es9plus/initiateAuthentication',
				data: enc.encode('{"smdpAddress":"smdp.test.invalid"}'),
			}, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 })
			await assert.rejects(
				() => Zmodem.receive(mcuIo, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 }),
				(e) => e.zmodemCode === Zmodem.STATUS.ERR_ABORTED
			)
		})()

		await assert.rejects(
			() => EsimCore.runMode1ProxySession({
				zmodem: Zmodem,
				io: proxyIo,
				smdpHost: 'smdp.test.invalid',
				signal: ac.signal,
				zmodemOpts: { readTimeoutMs: 500, sessionTimeoutMs: 5000 },
				httpPost: () => new Promise(() => {
					// 模拟忽略 signal 的桌面 IPC，50ms 后用户点停止
					setTimeout(() => ac.abort(), 50)
				}),
			}),
			(err) => err.stage === 'aborted'
		)
		await mcuTask
		const lastTx = logAtoB[logAtoB.length - 1]
		let maxCan = 0, cur = 0
		for (const b of lastTx) {
			if (b === 0x18) { cur++; if (cur > maxCan) maxCan = cur } else cur = 0
		}
		assert.ok(maxCan >= 5, '用户取消挂起的 httpPost 时必须立即向 MCU 发 CAN*5')
	}

	// 9. I3 回归：第 1 轮 smdpAddress 与 AC 主机不一致立即中止并发 CAN*5；大小写与末尾点差异允许通过
	{
		const { ioA: proxyIo, ioB: mcuIo } = makePipePair()
		const enc = new TextEncoder()
		const mcuTask = (async () => {
			await Zmodem.send(mcuIo, {
				fileName: '/gsma/rsp2/es9plus/initiateAuthentication',
				data: enc.encode('{"smdpAddress":"evil.other.invalid"}'),
			}, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 })
			await assert.rejects(
				() => Zmodem.receive(mcuIo, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 }),
				(e) => e.zmodemCode === Zmodem.STATUS.ERR_ABORTED
			)
		})()

		await assert.rejects(
			() => EsimCore.runMode1ProxySession({
				zmodem: Zmodem,
				io: proxyIo,
				smdpHost: 'smdp.test.invalid',
				zmodemOpts: { readTimeoutMs: 1000, sessionTimeoutMs: 5000 },
				httpPost: async () => { throw new Error('主机不一致时绝不应发起 HTTP 请求') },
			}),
			(err) => err.round === 0 && err.stage === 'host-mismatch'
		)
		await mcuTask
	}

	// 10. esim-panel.js 会话 ID 路由与 TLS 证书开关回归：单路模式路由到 'S'，双路路由到 'B'，透传 allowInsecureTls 并持久化
	async function runPanelDownloadCase({ serialMode, activeUiSid, openPhysSid, downloadMode, allowInsecureTls = false, redact = true }) {
		const listeners = Object.create(null)
		const storageMap = Object.create(null)
		function makeEl(id, extra) {
			const el = Object.assign({
				id,
				value: '',
				checked: false,
				textContent: '',
				className: '',
				hidden: false,
				disabled: false,
				style: {},
				dataset: {},
				childNodes: [],
				scrollTop: 0,
				scrollHeight: 0,
				addEventListener(type, fn) {
					listeners[id + ':' + type] = fn
				},
				appendChild(node) { this.childNodes.push(node) },
				removeChild(node) {
					const idx = this.childNodes.indexOf(node)
					if (idx >= 0) this.childNodes.splice(idx, 1)
				},
				querySelectorAll() { return [] },
			}, extra || {})
			return el
		}

		const elements = {
			'sk-esim-card': makeEl('sk-esim-card'),
			'sk-esim-eid': makeEl('sk-esim-eid'),
			'sk-esim-refresh': makeEl('sk-esim-refresh'),
			'sk-esim-poll': makeEl('sk-esim-poll'),
			'sk-esim-stop': makeEl('sk-esim-stop'),
			'sk-esim-state-badge': makeEl('sk-esim-state-badge'),
			'sk-esim-last-op': makeEl('sk-esim-last-op'),
			'sk-esim-fail-stage': makeEl('sk-esim-fail-stage'),
			'sk-esim-err-code': makeEl('sk-esim-err-code'),
			'sk-esim-err-hint': makeEl('sk-esim-err-hint'),
			'sk-esim-status-time': makeEl('sk-esim-status-time'),
			'sk-esim-profile-count': makeEl('sk-esim-profile-count'),
			'sk-esim-profile-list': makeEl('sk-esim-profile-list'),
			'sk-esim-mode': makeEl('sk-esim-mode', { value: String(downloadMode) }),
			'sk-esim-redact': makeEl('sk-esim-redact', { checked: true }),
			'sk-esim-ac': makeEl('sk-esim-ac', { type: 'password', value: 'LPA:1$smdp.test.invalid$MATCH-12345' }),
			'sk-esim-cc': makeEl('sk-esim-cc', { type: 'password', value: 'CC-9988' }),
			'sk-esim-proxy-row': makeEl('sk-esim-proxy-row'),
			'sk-esim-proxy-notice': makeEl('sk-esim-proxy-notice'),
			'sk-esim-tls-wrap': makeEl('sk-esim-tls-wrap'),
			'sk-esim-insecure-tls': makeEl('sk-esim-insecure-tls'),
			'sk-esim-proxy-url': makeEl('sk-esim-proxy-url'),
			'sk-esim-download': makeEl('sk-esim-download'),
			'sk-esim-progress-bar': makeEl('sk-esim-progress-bar'),
			'sk-esim-status': makeEl('sk-esim-status'),
			'sk-esim-log-title': makeEl('sk-esim-log-title'),
			'sk-esim-log': makeEl('sk-esim-log'),
			'sk-esim-log-clear': makeEl('sk-esim-log-clear'),
		}

		const calls = {
			pinSession: [],
			unpinCount: 0,
			writeRawTo: [],
			isSessionOpen: [],
			setSuppressRxLog: [],
			onReceiveFrom: [],
			httpReqs: [],
		}

		const enc = new TextEncoder()
		const okBody = enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}}}')
		const mcuRxQ = Zmodem.createByteQueue()
		let rxSub = null
		let mcuTask = null
		let pinnedSid = null

		const serialApi = {
			getMode() { return serialMode },
			getActiveSendSid() { return activeUiSid },
			isOpen() { return true },
			isSessionOpen(id) {
				calls.isSessionOpen.push(id)
				return id === openPhysSid
			},
			isPinned() { return pinnedSid !== null },
			pinSession(sid) {
				calls.pinSession.push(sid)
				pinnedSid = sid
			},
			unpinSession() {
				calls.unpinCount++
				pinnedSid = null
			},
			suppressParse: false,
			setSuppressRxLog(sid, on) {
				calls.setSuppressRxLog.push([sid, !!on])
			},
			onReceiveFrom(sid, cb) {
				calls.onReceiveFrom.push(sid)
				rxSub = { sid, cb }
				if (downloadMode === 1 && sid === openPhysSid) {
					const mcuIo = {
						readByte: (ms) => mcuRxQ.readByte(ms),
						writeBytes: async (u8) => {
							if (rxSub && rxSub.sid === openPhysSid) rxSub.cb(new Uint8Array(u8))
						},
					}
					mcuTask = (async () => {
						for (let r = 0; r < 4; r++) {
							await Zmodem.send(mcuIo, {
								fileName: EsimCore.ES9_ROUNDS[r].path,
								data: enc.encode(JSON.stringify({ smdpAddress: 'smdp.test.invalid', round: r + 1 })),
							}, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 })
							await Zmodem.receive(mcuIo, { readTimeoutMs: 1000, sessionTimeoutMs: 5000 })
						}
					})()
				}
				return () => { rxSub = null }
			},
			async writeRawTo(id, data, opts) {
				calls.writeRawTo.push({ id, len: data.length, hasLogData: !!(opts && opts.logData) })
				if (!this.isSessionOpen(id)) throw new Error('串口会话未打开或当前模式不可路由')
				if (rxSub && downloadMode === 1) mcuRxQ.push(data)
			},
		}

		// 终态 ID4: state=2(成功), op=1(下载), stage=0, err=0, 全0时间
		const id4Done = [2, 1, 0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
		const doneFrame = window.skParseFrame(sekUp(0x83, tlvBlock(66, [[4].concat(id4Done)])))
		let seq = 1
		let httpCount = 0

		const panelWin = {
			EsimCore,
			Zmodem,
			AppPlatform: {
				service(name) {
					if (name !== 'esim-http') return null
					return {
						async post(req) {
							httpCount++
							calls.httpReqs.push(req)
							if (httpCount <= 3) return { status: 200, bodyBytes: okBody }
							return { status: 204, bodyBytes: new Uint8Array(0) }
						},
					}
				},
			},
			AppDialog: {
				async alert(msg) { throw new Error('unexpected alert: ' + msg) },
				async confirm() { return true },
			},
			serialApi,
			skBuildDownFrame: window.skBuildDownFrame,
			sekTx: {
				nextSeq() { return seq++ },
				clearBuffer() {},
				waitFor() {
					return Promise.resolve({ frame: { dir: 'up', fields: { '功能码': 0x81 } } })
				},
				tag11Result() { return 0 },
				hasTag(f, tag) { return !!(f && f.tlv && f.tlv.some((t) => t.tag === tag)) },
				findTlvItem(f, tag, id) {
					if (!f || !f.tlv) return null
					const blk = f.tlv.find((t) => t.tag === tag)
					return blk ? (blk.items.find((it) => it.id === id) || null) : null
				},
				async sendAndWait() {
					return { frame: doneFrame }
				},
			},
		}

		const panelCtx = {
			window: panelWin,
			localStorage: {
				getItem(k) { return Object.prototype.hasOwnProperty.call(storageMap, k) ? storageMap[k] : null },
				setItem(k, v) { storageMap[k] = String(v) },
			},
			document: {
				readyState: 'complete',
				getElementById(id) { return elements[id] || null },
				createElement() { return makeEl('dyn') },
				addEventListener() {},
			},
			Uint8Array,
			TextEncoder,
			AbortController,
			Date,
			console,
			setTimeout(fn, ms) { return setTimeout(fn, Math.min(ms || 0, 5)) },
			clearTimeout,
		}
		vm.createContext(panelCtx)
		vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/esim-panel.js'), 'utf8'), panelCtx)

		// 默认开启脱敏；支持手动关闭切换明文调试
		assert.equal(elements['sk-esim-redact'].checked, true, '脱敏开关默认开启')
		assert.equal(elements['sk-esim-ac'].type, 'password', '脱敏开启时 AC 输入框为密码框')
		assert.equal(elements['sk-esim-cc'].type, 'password', '脱敏开启时 CC 输入框为密码框')
		if (!redact) {
			elements['sk-esim-redact'].checked = false
			listeners['sk-esim-redact:change']()
			assert.equal(storageMap.skEsimRedact, '0', '关闭脱敏应持久化开关偏好')
			assert.equal(elements['sk-esim-ac'].type, 'text', '关闭脱敏后 AC 输入框应切为明文')
			assert.equal(elements['sk-esim-cc'].type, 'text', '关闭脱敏后 CC 输入框应切为明文')
			assert.ok(elements['sk-esim-log-title'].textContent.includes('关闭脱敏'), '日志标题应提示已关闭脱敏')
		}

		if (downloadMode === 1) {
			assert.equal(elements['sk-esim-tls-wrap'].hidden, false, '桌面原生 mode=1 应显示 TLS 证书开关')
			assert.equal(elements['sk-esim-insecure-tls'].checked, false, 'TLS 证书开关默认关闭')
			assert.equal(elements['sk-esim-proxy-notice'].className, 'sk-esim-notice is-ok')
			if (allowInsecureTls) {
				elements['sk-esim-insecure-tls'].checked = true
				listeners['sk-esim-insecure-tls:change']()
				assert.equal(storageMap.skEsimAllowInsecureTls, '1', '勾选后应持久化开关偏好')
				assert.equal(elements['sk-esim-proxy-notice'].className, 'sk-esim-notice is-warn', '跳过 TLS 校验时应显示警告态提示')
			}
		}

		const onDownload = listeners['sk-esim-download:click']
		assert.equal(typeof onDownload, 'function', '应已绑定下载按钮点击事件')
		await onDownload()
		if (mcuTask) await mcuTask

		const logs = elements['sk-esim-log'].childNodes.map((n) => n.textContent)
		assert.ok(!logs.some((l) => l.includes('串口会话未打开或当前模式不可路由')), '不应报串口会话未打开或当前模式不可路由: ' + logs.join(' | '))
		assert.ok(!elements['sk-esim-status'].textContent.includes('下载失败'), '下载状态不应失败: ' + elements['sk-esim-status'].textContent)
		assert.deepEqual(calls.pinSession, [openPhysSid], 'pinSession 必须使用物理会话 ID')
		assert.equal(calls.unpinCount, 1, '结束后必须解除钉扎')
		assert.ok(calls.writeRawTo.length >= 1, '应至少触发一次 writeRawTo')
		assert.ok(calls.writeRawTo.every((c) => c.id === openPhysSid), '所有 writeRawTo 必须路由到 ' + openPhysSid)
		assert.equal(calls.writeRawTo[0].hasLogData, !!redact, redact ? '脱敏开启时下载触发帧必须提供打码 logData' : '关闭脱敏时下载触发帧不应替换 logData')
		if (redact) {
			assert.ok(!logs.some((l) => l.includes('MATCH-12345') || l.includes('CC-9988')), '脱敏开启时面板日志绝不能包含明文 AC/CC')
		} else {
			assert.ok(logs.some((l) => l.includes('MATCH-12345') && l.includes('CC-9988')), '关闭脱敏后面板日志应显示明文 AC/CC 便于联调')
		}
		assert.ok(!Object.values(storageMap).some((v) => v.includes('MATCH-12345') || v.includes('CC-9988')), '无论是否关闭脱敏，AC/CC 均不落盘 localStorage')
		assert.ok(calls.isSessionOpen.every((id) => id === openPhysSid), '所有 isSessionOpen 必须查询 ' + openPhysSid)
		if (downloadMode === 1) {
			assert.deepEqual(calls.onReceiveFrom, [openPhysSid], 'onReceiveFrom 必须订阅 ' + openPhysSid)
			if (redact) {
				assert.deepEqual(calls.setSuppressRxLog, [[openPhysSid, true], [openPhysSid, false]], '脱敏开启时 setSuppressRxLog 必须成对屏蔽与恢复 ' + openPhysSid)
				assert.ok(calls.writeRawTo.every((c) => c.hasLogData === true), '脱敏开启时触发帧与 ZMODEM TX 均须使用脱敏/占位 logData')
			} else {
				assert.deepEqual(calls.setSuppressRxLog, [], '关闭脱敏时不屏蔽 ZMODEM RX 串口日志')
				assert.ok(calls.writeRawTo.every((c) => c.hasLogData === false), '关闭脱敏时触发帧与 ZMODEM TX 均不替换 logData，原样记入串口日志')
			}
			assert.equal(httpCount, 4, 'mode=1 应完成四轮 SM-DP+ 请求')
			assert.ok(calls.httpReqs.every((r) => r.allowInsecureTls === !!allowInsecureTls), '每轮原生请求必须准确透传 allowInsecureTls')
			// 填自定义代理基址时隐藏原生 TLS 开关
			elements['sk-esim-proxy-url'].value = 'https://127.0.0.1:8443'
			listeners['sk-esim-proxy-url:input']()
			assert.equal(elements['sk-esim-tls-wrap'].hidden, true, '自定义代理基址非空时应隐藏原生 TLS 开关')
		}
	}

	// 10a. 单路模式（getMode==='single', getActiveSendSid==='A'，仅 'S' 打开、'A' 返回 false）：mode=0 与 mode=1（严格/跳过 TLS）均以 'S' 路由
	await runPanelDownloadCase({ serialMode: 'single', activeUiSid: 'A', openPhysSid: 'S', downloadMode: 0 })
	await runPanelDownloadCase({ serialMode: 'single', activeUiSid: 'A', openPhysSid: 'S', downloadMode: 1, allowInsecureTls: false })
	await runPanelDownloadCase({ serialMode: 'single', activeUiSid: 'A', openPhysSid: 'S', downloadMode: 1, allowInsecureTls: true })

	// 10b. 双路模式（getMode==='dual', getActiveSendSid==='B'，仅 'B' 打开）：mode=0 与 mode=1 均以 'B' 路由
	await runPanelDownloadCase({ serialMode: 'dual', activeUiSid: 'B', openPhysSid: 'B', downloadMode: 0 })
	await runPanelDownloadCase({ serialMode: 'dual', activeUiSid: 'B', openPhysSid: 'B', downloadMode: 1, allowInsecureTls: true })

	// 10c. 关闭脱敏开关：输入明文、串口记真实帧（含 mode=1 ZMODEM 原始 TX/RX）、面板日志可见，且 AC/CC 仍不落盘
	await runPanelDownloadCase({ serialMode: 'single', activeUiSid: 'A', openPhysSid: 'S', downloadMode: 0, redact: false })
	await runPanelDownloadCase({ serialMode: 'single', activeUiSid: 'A', openPhysSid: 'S', downloadMode: 1, allowInsecureTls: false, redact: false })

	// 11. esim-panel.js ID4 错误码渲染与模组识别门控回归（EG800Z / 未识别 / 非 EG800Z / 0xE1xx~0xE4xx）
	async function runPanelErrRenderCase({ moduleInfo, failStage, errCode, expectErrSub, forbidErrSub, expectHintSub, expectHintHidden }) {
		const listeners = Object.create(null)
		function makeEl(id, extra) {
			return Object.assign({
				id, value: '', checked: false, textContent: '', className: '', hidden: false, disabled: false,
				style: {}, dataset: {}, childNodes: [], scrollTop: 0, scrollHeight: 0,
				addEventListener(type, fn) { listeners[id + ':' + type] = fn },
				appendChild(node) { this.childNodes.push(node) },
				removeChild(node) { const idx = this.childNodes.indexOf(node); if (idx >= 0) this.childNodes.splice(idx, 1) },
				querySelectorAll() { return [] },
			}, extra || {})
		}
		const elements = {
			'sk-esim-card': makeEl('sk-esim-card'),
			'sk-esim-eid': makeEl('sk-esim-eid'),
			'sk-esim-refresh': makeEl('sk-esim-refresh'),
			'sk-esim-poll': makeEl('sk-esim-poll'),
			'sk-esim-stop': makeEl('sk-esim-stop'),
			'sk-esim-state-badge': makeEl('sk-esim-state-badge'),
			'sk-esim-last-op': makeEl('sk-esim-last-op'),
			'sk-esim-fail-stage': makeEl('sk-esim-fail-stage'),
			'sk-esim-err-code': makeEl('sk-esim-err-code'),
			'sk-esim-err-hint': makeEl('sk-esim-err-hint'),
			'sk-esim-status-time': makeEl('sk-esim-status-time'),
			'sk-esim-profile-count': makeEl('sk-esim-profile-count'),
			'sk-esim-profile-list': makeEl('sk-esim-profile-list'),
			'sk-esim-mode': makeEl('sk-esim-mode', { value: '0' }),
			'sk-esim-redact': makeEl('sk-esim-redact', { checked: true }),
			'sk-esim-ac': makeEl('sk-esim-ac', { type: 'password' }),
			'sk-esim-cc': makeEl('sk-esim-cc', { type: 'password' }),
			'sk-esim-proxy-row': makeEl('sk-esim-proxy-row'),
			'sk-esim-proxy-notice': makeEl('sk-esim-proxy-notice'),
			'sk-esim-tls-wrap': makeEl('sk-esim-tls-wrap'),
			'sk-esim-insecure-tls': makeEl('sk-esim-insecure-tls'),
			'sk-esim-proxy-url': makeEl('sk-esim-proxy-url'),
			'sk-esim-download': makeEl('sk-esim-download'),
			'sk-esim-progress-bar': makeEl('sk-esim-progress-bar'),
			'sk-esim-status': makeEl('sk-esim-status'),
			'sk-esim-log-title': makeEl('sk-esim-log-title'),
			'sk-esim-log': makeEl('sk-esim-log'),
			'sk-esim-log-clear': makeEl('sk-esim-log-clear'),
		}
		const id4Fail = [3, 1, failStage, errCode & 0xff, (errCode >> 8) & 0xff, 0x20, 0x26, 0x11, 0x26, 0x20, 0x30, 0x00]
		const failFrame = window.skParseFrame(sekUp(0x83, tlvBlock(66, [[4].concat(id4Fail)])))
		let pinnedSid = null
		const panelWin = {
			EsimCore,
			Zmodem,
			AppPlatform: { service() { return null } },
			AppDialog: { async alert(msg) { throw new Error('unexpected alert: ' + msg) }, async confirm() { return true } },
			serialApi: {
				getMode() { return 'single' },
				getActiveSendSid() { return 'A' },
				isOpen() { return true },
				isPinned() { return pinnedSid !== null },
				pinSession(sid) { pinnedSid = sid },
				unpinSession() { pinnedSid = null },
				getActiveLaneModuleInfo(sid) {
					assert.equal(sid, 'S')
					return moduleInfo
				},
			},
			sekTx: {
				hasTag(f, tag) { return !!(f && f.tlv && f.tlv.some((t) => t.tag === tag)) },
				findTlvItem(f, tag, id) {
					const blk = f && f.tlv ? f.tlv.find((t) => t.tag === tag) : null
					return blk ? (blk.items.find((it) => it.id === id) || null) : null
				},
				async sendAndWait() { return { frame: failFrame } },
			},
		}
		const panelCtx = {
			window: panelWin,
			localStorage: { getItem() { return null }, setItem() {} },
			document: {
				readyState: 'complete',
				getElementById(id) { return elements[id] || null },
				createElement() { return makeEl('dyn') },
				addEventListener() {},
			},
			Uint8Array, TextEncoder, AbortController, Date, console,
			setTimeout(fn, ms) { return setTimeout(fn, Math.min(ms || 0, 5)) },
			clearTimeout,
		}
		vm.createContext(panelCtx)
		vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/esim-panel.js'), 'utf8'), panelCtx)

		await listeners['sk-esim-poll:click']()
		const errText = elements['sk-esim-err-code'].textContent
		assert.ok(errText.includes(expectErrSub), 'err-code 应包含 ' + expectErrSub + '，实际: ' + errText)
		if (forbidErrSub) {
			assert.ok(!errText.includes(forbidErrSub), 'err-code 不应包含 ' + forbidErrSub + '，实际: ' + errText)
		}
		if (expectHintHidden) {
			assert.equal(elements['sk-esim-err-hint'].hidden, true, '不应显示提示条')
		} else if (expectHintSub) {
			assert.equal(elements['sk-esim-err-hint'].hidden, false, '应显示提示条')
			assert.ok(elements['sk-esim-err-hint'].textContent.includes(expectHintSub), '提示条内容不符: ' + elements['sk-esim-err-hint'].textContent)
		}
		assert.ok(elements['sk-esim-status'].textContent.includes(expectErrSub), '轮询终态摘要应包含解析后错误码: ' + elements['sk-esim-status'].textContent)
	}

	await runPanelErrRenderCase({
		moduleInfo: { known: true, isEg800z: true, moduleVersion: 'EG800ZEULAR09A01M04_BETA261020_E' },
		failStage: 6, errCode: 0x090C,
		expectErrSub: '0x8500090C', expectHintSub: '建议：',
	})
	await runPanelErrRenderCase({
		moduleInfo: { known: false, isEg800z: false, moduleVersion: '' },
		failStage: 6, errCode: 0x090C,
		expectErrSub: '0x090C（未识别模组）', forbidErrSub: '0x8500090C', expectHintSub: '提示：',
	})
	await runPanelErrRenderCase({
		moduleInfo: { known: true, isEg800z: false, moduleVersion: 'BC660KGLAAR01A05' },
		failStage: 6, errCode: 0x090C,
		expectErrSub: '0x090C', forbidErrSub: '0x8500090C', expectHintHidden: true,
	})
	await runPanelErrRenderCase({
		moduleInfo: { known: false, isEg800z: false, moduleVersion: '' },
		failStage: 1, errCode: 0xE135,
		expectErrSub: '+CME ERROR: 53 (参数非法)', forbidErrSub: '0x8500', expectHintSub: '建议：',
	})
	await runPanelErrRenderCase({
		moduleInfo: { known: false, isEg800z: false, moduleVersion: '' },
		failStage: 2, errCode: 0xE205,
		expectErrSub: 'AT+QIACT=1 PDP 激活失败', forbidErrSub: '0x8500', expectHintSub: '建议：',
	})
	await runPanelErrRenderCase({
		moduleInfo: { known: false, isEg800z: false, moduleVersion: '' },
		failStage: 4, errCode: 0xE367,
		expectErrSub: 'WAIT_URC', forbidErrSub: '0x8500', expectHintSub: '建议：',
	})
	await runPanelErrRenderCase({
		moduleInfo: { known: false, isEg800z: false, moduleVersion: '' },
		failStage: 7, errCode: 0xE4AB,
		expectErrSub: '第 2 轮', forbidErrSub: '0x8500', expectHintSub: '建议：',
	})

	// 12. esim-panel.js 「刷新信息」先查基础信息 (0x03 Tag10-ID1) 再查 Tag66；失败/空版本号优雅降级；轮询不发 Tag10-ID1
	async function runPanelRefreshProbeCase({ baseBehavior, errCode, failStage = 6, expectErrSub, forbidErrSub, expectHintSub, expectHintHidden, expectLogSub }) {
		const listeners = Object.create(null)
		function makeEl(id, extra) {
			return Object.assign({
				id, value: '', checked: false, textContent: '', className: '', hidden: false, disabled: false,
				style: {}, dataset: {}, childNodes: [], scrollTop: 0, scrollHeight: 0,
				addEventListener(type, fn) { listeners[id + ':' + type] = fn },
				appendChild(node) { this.childNodes.push(node) },
				removeChild(node) { const idx = this.childNodes.indexOf(node); if (idx >= 0) this.childNodes.splice(idx, 1) },
				querySelectorAll() { return [] },
			}, extra || {})
		}
		const elements = {
			'sk-esim-card': makeEl('sk-esim-card'),
			'sk-esim-eid': makeEl('sk-esim-eid'),
			'sk-esim-refresh': makeEl('sk-esim-refresh'),
			'sk-esim-poll': makeEl('sk-esim-poll'),
			'sk-esim-stop': makeEl('sk-esim-stop'),
			'sk-esim-state-badge': makeEl('sk-esim-state-badge'),
			'sk-esim-last-op': makeEl('sk-esim-last-op'),
			'sk-esim-fail-stage': makeEl('sk-esim-fail-stage'),
			'sk-esim-err-code': makeEl('sk-esim-err-code'),
			'sk-esim-err-hint': makeEl('sk-esim-err-hint'),
			'sk-esim-status-time': makeEl('sk-esim-status-time'),
			'sk-esim-profile-count': makeEl('sk-esim-profile-count'),
			'sk-esim-profile-list': makeEl('sk-esim-profile-list'),
			'sk-esim-mode': makeEl('sk-esim-mode', { value: '0' }),
			'sk-esim-redact': makeEl('sk-esim-redact', { checked: true }),
			'sk-esim-ac': makeEl('sk-esim-ac', { type: 'password' }),
			'sk-esim-cc': makeEl('sk-esim-cc', { type: 'password' }),
			'sk-esim-proxy-row': makeEl('sk-esim-proxy-row'),
			'sk-esim-proxy-notice': makeEl('sk-esim-proxy-notice'),
			'sk-esim-tls-wrap': makeEl('sk-esim-tls-wrap'),
			'sk-esim-insecure-tls': makeEl('sk-esim-insecure-tls'),
			'sk-esim-proxy-url': makeEl('sk-esim-proxy-url'),
			'sk-esim-download': makeEl('sk-esim-download'),
			'sk-esim-progress-bar': makeEl('sk-esim-progress-bar'),
			'sk-esim-status': makeEl('sk-esim-status'),
			'sk-esim-log-title': makeEl('sk-esim-log-title'),
			'sk-esim-log': makeEl('sk-esim-log'),
			'sk-esim-log-clear': makeEl('sk-esim-log-clear'),
		}
		const sentQueries = []
		let laneModule = { known: false, isEg800z: false, family: 'unknown', modelPrefix: '', label: '', moduleVersion: '', moduleModel: '', source: '' }
		let pinnedSid = null

		const eidBytes = [0x89, 0x04, 0x90, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78]
		const id4Bytes = [3, 1, failStage, errCode & 0xff, (errCode >> 8) & 0xff, 0x20, 0x26, 0x11, 0x26, 0x21, 0x00, 0x00]
		window.skSession.resetModule()
		const tag66Frame = window.skParseFrame(sekUp(0x83, tlvBlock(66, [
			[0].concat(eidBytes),
			[1, 0],
			[4].concat(id4Bytes),
		])))

		const panelWin = {
			EsimCore,
			Zmodem,
			AppPlatform: { service() { return null } },
			AppDialog: { async alert(msg) { throw new Error('unexpected alert: ' + msg) }, async confirm() { return true } },
			serialApi: {
				getMode() { return 'single' },
				getActiveSendSid() { return 'A' },
				isOpen() { return true },
				isPinned() { return pinnedSid !== null },
				pinSession(sid) { pinnedSid = sid },
				unpinSession() { pinnedSid = null },
				getActiveLaneModuleInfo(sid) {
					assert.equal(sid, 'S')
					return laneModule
				},
				setActiveLaneModuleInfo(sid, info) {
					assert.equal(sid, 'S')
					laneModule = EsimCore.detectModuleProfile(info)
					return laneModule.known
				},
			},
			sekTx: {
				hasTag(f, tag) { return !!(f && f.tlv && f.tlv.some((t) => t.tag === tag)) },
				findTlvItem(f, tag, id) {
					const blk = f && f.tlv ? f.tlv.find((t) => t.tag === tag) : null
					return blk ? (blk.items.find((it) => it.id === id) || null) : null
				},
				async sendAndWait(opts) {
					const qId = opts && opts.buildOpts && opts.buildOpts.tlv && opts.buildOpts.tlv[0] && opts.buildOpts.tlv[0].items[0].id
					sentQueries.push(qId)
					if (qId === 1) {
						if (baseBehavior.timeout) throw new Error('等待响应超时(3000ms)')
						const items = []
						if (baseBehavior.ver !== undefined) items.push([10].concat(asciiPadded(baseBehavior.ver, 32)))
						if (baseBehavior.model !== undefined) items.push([12].concat(asciiPadded(baseBehavior.model, 16)))
						window.skSession.resetModule()
						const baseFrame = window.skParseFrame(sekUp(0x83, tlvBlock(1, items)))
						return { frame: baseFrame }
					}
					if (qId === 66) return { frame: tag66Frame }
					throw new Error('unexpected query id: ' + qId)
				},
			},
		}
		const panelCtx = {
			window: panelWin,
			localStorage: { getItem() { return null }, setItem() {} },
			document: {
				readyState: 'complete',
				getElementById(id) { return elements[id] || null },
				createElement() { return makeEl('dyn') },
				addEventListener() {},
			},
			Uint8Array, TextEncoder, AbortController, Date, console,
			setTimeout(fn, ms) { return setTimeout(fn, Math.min(ms || 0, 5)) },
			clearTimeout,
		}
		vm.createContext(panelCtx)
		vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/esim-panel.js'), 'utf8'), panelCtx)

		// 先点「刷新信息」：必须按 [1, 66] 顺序发送
		await listeners['sk-esim-refresh:click']()
		assert.deepEqual(sentQueries, [1, 66], '刷新信息应先发 Tag10-ID1 再发 Tag10-ID66')
		assert.equal(elements['sk-esim-eid'].textContent, '89049032000000000000000012345678', 'Tag66 EID 必须正常更新')
		const errText = elements['sk-esim-err-code'].textContent
		assert.ok(errText.includes(expectErrSub), 'err-code 应包含 ' + expectErrSub + '，实际: ' + errText)
		if (forbidErrSub) assert.ok(!errText.includes(forbidErrSub), 'err-code 不应包含 ' + forbidErrSub + '，实际: ' + errText)
		if (expectHintHidden) assert.equal(elements['sk-esim-err-hint'].hidden, true)
		else if (expectHintSub) {
			assert.equal(elements['sk-esim-err-hint'].hidden, false)
			assert.ok(elements['sk-esim-err-hint'].textContent.includes(expectHintSub))
		}
		if (expectLogSub) {
			const logs = elements['sk-esim-log'].childNodes.map((n) => n.textContent)
			assert.ok(logs.some((l) => l.includes(expectLogSub)), '日志应包含 ' + expectLogSub + '，实际: ' + logs.join(' | '))
		}

		// 再点「轮询状态」：绝不能发 Tag10-ID1 干扰 ID4 轮询
		sentQueries.length = 0
		await listeners['sk-esim-poll:click']()
		assert.deepEqual(sentQueries, [66], 'ID4 轮询只允许发 Tag10-ID66，不得发送 Tag10-ID1')
	}

	// 12a. 刷新信息：Tag1 返回 EG800ZEULAR... -> 识别前缀 EG800Z -> Tag66 0x090C 启用 EG800Z 专属码表
	await runPanelRefreshProbeCase({
		baseBehavior: { ver: 'EG800ZEULAR09A01M04_BETA261020_E' },
		errCode: 0x090C,
		expectErrSub: '0x8500090C',
		expectHintSub: '建议：',
		expectLogSub: '基础信息识别模组：EG800Z',
	})

	// 12b. 刷新信息：Tag1 返回非 EG800Z（BC660K）-> 0x090C 仅展示原始十六进制，不套用 EG800Z 文案
	await runPanelRefreshProbeCase({
		baseBehavior: { ver: 'BC660KGLAAR01A05' },
		errCode: 0x090C,
		expectErrSub: '0x090C',
		forbidErrSub: '0x8500090C',
		expectHintHidden: true,
		expectLogSub: '基础信息识别模组：BC660K',
	})

	// 12c. 刷新信息：Tag1 超时失败 -> 优雅降级，不阻塞 Tag66 查询，0x090C 标注未识别模组
	await runPanelRefreshProbeCase({
		baseBehavior: { timeout: true },
		errCode: 0x090C,
		expectErrSub: '0x090C（未识别模组）',
		forbidErrSub: '0x8500090C',
		expectHintSub: '提示：',
		expectLogSub: '已降级，继续查询 Tag66',
	})

	// 12d. 刷新信息：Tag1 返回空版本号 -> 优雅降级，不阻塞 Tag66 查询，0xE205 通用细分子码正常解析
	await runPanelRefreshProbeCase({
		baseBehavior: { ver: '' },
		failStage: 2,
		errCode: 0xE205,
		expectErrSub: 'AT+QIACT=1 PDP 激活失败',
		forbidErrSub: '0x8500',
		expectHintSub: '建议：',
		expectLogSub: '未返回有效模组版本号',
	})
}

runAsyncTests().then(() => {
	console.log('esim.cjs OK')
}).catch((err) => {
	console.error(err)
	process.exit(1)
})
