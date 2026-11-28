// Run: node tests/esim.cjs — synthetic data only.
// 覆盖: SEK Tag=66 V2.32 (ID0~ID7) / Tag=10 ID=66 编解码与 logView 脱敏、ID1 低/高字节位域与运营商识别、
// ID2 14B 事务与缓存状态 (runtimeFlags/cacheAgeSec/错误码分区)、ID3 14B 待发通知摘要与 10B BCD ICCID、
// ID4~ID7 下行编解码与策略拦截、近端 XFER (0xA5 0x5A) 协议环回/块长协商 (700B/128B)/第3轮 60s 断连 QUERY 续传、
// ID6 op=1 待发通知 XFER(target=0x03) 同步、以及 esim-panel.js 客户/管理员视图与通知策略交互回归
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const Xfer = require('../js/xfer.js')
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

// 1. profile_class 反转映射、V2.32 statusBits 位域编解码与 ICCID 运营商识别
{
	assert.equal(EsimCore.mapAtProfileClassToId1(2), 0, 'AT 操作文件(2) -> ID1 运营(0)')
	assert.equal(EsimCore.mapAtProfileClassToId1(1), 1, 'AT 预置文件(1) -> ID1 预置/引导(1)')
	assert.equal(EsimCore.mapAtProfileClassToId1(0), 2, 'AT 测试文件(0) -> ID1 测试(2)')
	assert.equal(EsimCore.mapAtProfileClassToId1(9), 3, '其他 -> 未知/保留(3)')

	const f1 = EsimCore.encodeProfileFlags({
		enabled: true,
		profileClass: 0,
		hasPendingNtf: true,
		lockDelete: true,
		lockDisable: false,
		hiddenUser: true,
		fallbackSeed: true,
	})
	// bit0(0x0001) | bit3(0x0008) | bit8(0x0100) | bit10(0x0400) | bit11(0x0800) = 0x0D09
	assert.equal(f1, 0x0D09)
	const d1 = EsimCore.decodeProfileFlags(f1)
	assert.equal(d1.enabled, true)
	assert.equal(d1.profileClass, 0)
	assert.equal(d1.profileClassLabel, '运营')
	assert.equal(d1.hasPendingNtf, true)
	assert.equal(d1.policyMask, 0x0D)
	assert.equal(d1.lockDelete, true)
	assert.equal(d1.lockDisable, false)
	assert.equal(d1.hiddenUser, true)
	assert.equal(d1.fallbackSeed, true)

	// ICCID 归属运营商识别
	assert.equal(EsimCore.identifyIccidCarrier('89860011223344556677').name, '中国移动')
	assert.equal(EsimCore.identifyIccidCarrier('89860411223344556677').name, '中国移动')
	assert.equal(EsimCore.identifyIccidCarrier('89860111223344556677').name, '中国联通')
	assert.equal(EsimCore.identifyIccidCarrier('89860911223344556677').name, '中国联通')
	assert.equal(EsimCore.identifyIccidCarrier('89860311223344556677').name, '中国电信')
	assert.equal(EsimCore.identifyIccidCarrier('89861111223344556677').name, '中国电信')
	assert.equal(EsimCore.identifyIccidCarrier('8985201122334455667').name, '中国香港')
	assert.equal(EsimCore.identifyIccidCarrier('9999999999'), null)
}

// 2. SEK Tag=10 ID=66 查询帧与 0x83 Tag=66 V2.32 (ID0 + ID1 + ID2 14B + ID3 14B) 解码与 logView
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

	// 构造 0x83 + Tag66 (ID0 EID + ID1 2个Profile + ID2 14B状态 + ID3 14B通知摘要)
	const eidBytes = [0x89, 0x04, 0x90, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x12, 0x34, 0x56, 0x78]
	const p1Flags = EsimCore.encodeProfileFlags({ enabled: true, profileClass: 0, lockDelete: true, lockDisable: true, fallbackSeed: true })
	const p2Flags = EsimCore.encodeProfileFlags({ enabled: false, profileClass: 1, hasPendingNtf: true, hiddenUser: true })
	const id1Val = [2]
		.concat(asciiPadded('89860011223344556677', 20), [p1Flags & 0xff, p1Flags >> 8])
		.concat(asciiPadded('89860199887766554433', 20), [p2Flags & 0xff, p2Flags >> 8])
	// ID2 (14B): state=3(失败), runtimeFlags=0x03(刷新中+缓存就绪), lastOp=2(近端XFER下载), failStage=6, err=0x090C, time=2026-11-24 19:30:00, cacheAge=18s
	const id2Val = [3, 0x03, 2, 6, 0x0C, 0x09, 0x20, 0x26, 0x11, 0x24, 0x19, 0x30, 0x00, 18]
	// ID3 (14B): total=3, del=1, other=2, headEvent=4(删除), headIccidBcd=19位 8985201234567890123 + 0xF
	const headBcd = Array.from(EsimCore.encodeIccidBcd('8985201234567890123'))
	assert.equal(headBcd.length, 10)
	assert.equal(headBcd[9] & 0x0f, 0x0f, '19 位 ICCID 末尾半字节必须补 0xF')
	const id3Val = [3, 1, 2, 4].concat(headBcd)

	const up = sekUp(0x83, tlvBlock(66, [
		[0].concat(eidBytes),
		[1].concat(id1Val),
		[2].concat(id2Val),
		[3].concat(id3Val),
	]))

	// 2a. 未查过模组版本时，0x090C 仅显示原始十六进制并标注未识别模组
	window.skSession.resetModule()
	const parsedUnknown = window.skParseFrame(up)
	assert.equal(parsedUnknown.ok, true)
	assert.equal(parsedUnknown.tlv.length, 1)
	assert.equal(parsedUnknown.tlv[0].tag, 66)
	assert.equal(parsedUnknown.tlv[0].name, 'eSIM管理')
	assert.equal(parsedUnknown.tlv[0].items.length, 4)
	assert.equal(parsedUnknown.tlv[0].items[0].decoded, '89049032000000000000000012345678')
	assert.ok(parsedUnknown.tlv[0].items[1].decoded.includes('89860011223344556677'))
	assert.ok(parsedUnknown.tlv[0].items[1].decoded.includes('启用,运营,禁删,禁停,保底'))
	assert.ok(parsedUnknown.tlv[0].items[1].decoded.includes('禁用,预置/引导,有待发通知,客户隐藏'))
	assert.ok(parsedUnknown.tlv[0].items[2].decoded.includes('0x090C（未识别模组）'))
	assert.ok(parsedUnknown.tlv[0].items[2].decoded.includes('刷新中,缓存就绪'))
	assert.ok(parsedUnknown.tlv[0].items[2].decoded.includes('18s前'))
	assert.ok(!parsedUnknown.tlv[0].items[2].decoded.includes('0x8500090C'))
	assert.ok(parsedUnknown.tlv[0].items[3].decoded.includes('总计:3 (删除:1, 其他:2)'))
	assert.ok(parsedUnknown.tlv[0].items[3].decoded.includes('首条:删除 ICCID=8985201234567890123'))
	const lvUnknown = window.skLogView(parsedUnknown)
	assert.ok(lvUnknown && lvUnknown.sections.length === 1)
	assert.equal(lvUnknown.sections[0].title, 'Tag66 eSIM管理')
	assert.equal(lvUnknown.sections[0].pairs.length, 4)
	assert.ok(lvUnknown.notes.some((n) => n.kind === 'warn' && n.text.includes('未识别模组')))

	// 2b. 通过 Tag=1 ID=10 识别到 EG800Z 模组后，启用 EG800Z +QESIM 专属码表
	const tag1Eg800z = sekUp(0x83, tlvBlock(1, [
		[10].concat(asciiPadded('EG800ZEULAR09A01M04_BETA261020_E', 32)),
	]))
	assert.equal(window.skParseFrame(tag1Eg800z).ok, true)
	assert.equal(window.skSession.isEg800z(), true)

	const parsed = window.skParseFrame(up)
	assert.equal(parsed.ok, true)
	assert.ok(parsed.tlv[0].items[2].decoded.includes('失败'))
	assert.ok(parsed.tlv[0].items[2].decoded.includes('0x8500090C'))
	assert.ok(parsed.tlv[0].items[2].decoded.includes('PE 处理错误'))
	assert.ok(parsed.tlv[0].items[2].decoded.includes('2026-11-24 19:30:00'))

	const lv = window.skLogView(parsed)
	assert.ok(!lv.notes.some((n) => n.text.includes('未识别模组')))

	// 2c. 识别到非 EG800Z 模组（如 BC660K）时，不套用 EG800Z 文案也不提示未识别
	const tag1Other = sekUp(0x83, tlvBlock(1, [
		[10].concat(asciiPadded('BC660KGLAAR01A05', 32)),
		[12].concat(asciiPadded('BC660K', 16)),
	]))
	assert.equal(window.skParseFrame(tag1Other).ok, true)
	const parsedOther = window.skParseFrame(up)
	assert.ok(parsedOther.tlv[0].items[2].decoded.includes('模组码:0x090C '))
	assert.ok(!parsedOther.tlv[0].items[2].decoded.includes('0x8500090C'))
	assert.ok(!window.skLogView(parsedOther).notes.some((n) => n.text.includes('未识别模组')))

	// 2d. 换表（设备唯一码变更）必须重置模组识别状态
	assert.equal(window.skParseFrame(tag1Eg800z).ok, true)
	const snapEg = window.skSession.snapshot()
	const upOtherDevice = sekUpWithUid(0x83, tlvBlock(66, [[2].concat(id2Val)]), [0x00, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44])
	const parsedOtherDev = window.skParseFrame(upOtherDevice)
	assert.equal(window.skSession.hasModule(), false)
	assert.ok(parsedOtherDev.tlv[0].items[0].decoded.includes('0x090C（未识别模组）'))
	window.skSession.restore(snapEg)
	assert.equal(window.skSession.isEg800z(), true)
	window.skSession.resetModule()

	// 2e. 结构化解码器测试：ID2 严格 14B（拒绝旧 12B）、cacheAgeSec 边界、ID3 14B 未读/空/有效
	assert.equal(EsimCore.decodeStatus(id2Val.slice(0, 12)), null, '12B 旧版长度必须拒绝返回 null')
	const stEg = EsimCore.decodeStatus(id2Val, { moduleVersion: 'EG800ZEULAR08A02M04_ESIM_01.001.01.001' })
	assert.equal(stEg.state, 3)
	assert.equal(stEg.runtimeFlags, 0x03)
	assert.equal(stEg.cacheRefreshing, true)
	assert.equal(stEg.bootCacheReady, true)
	assert.equal(stEg.nearKeepaliveActive, false)
	assert.equal(stEg.lastOp, 2)
	assert.equal(stEg.failStage, 6)
	assert.equal(stEg.moduleErrCode, 0x090C)
	assert.equal(stEg.qesimFullCode, '0x8500090C')
	assert.equal(stEg.timeText, '2026-11-24 19:30:00')
	assert.equal(stEg.cacheAgeSec, 18)
	assert.equal(stEg.cacheAgeText, '18s 前')

	// cacheAgeSec = 255 区分未刷新 vs >=255s 前；runtimeFlags bit2 续传保活
	const id2Keepalive = [1, 0x06, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255]
	const stKa = EsimCore.decodeStatus(id2Keepalive)
	assert.equal(stKa.bootCacheReady, true)
	assert.equal(stKa.nearKeepaliveActive, true)
	assert.equal(stKa.cacheAgeText, '≥255s 前')

	const id2Unread = [0, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255]
	const stUnread = EsimCore.decodeStatus(id2Unread)
	assert.equal(stUnread.bootCacheReady, false)
	assert.equal(stUnread.cacheAgeText, '尚未刷新')

	// ID3 待发通知摘要解码
	const ntf = EsimCore.decodeNtfSummary(id3Val)
	assert.equal(ntf.unread, false)
	assert.equal(ntf.totalCount, 3)
	assert.equal(ntf.deleteCount, 1)
	assert.equal(ntf.otherCount, 2)
	assert.equal(ntf.headEvent, 4)
	assert.equal(ntf.headEventLabel, '删除')
	assert.equal(ntf.headIccid, '8985201234567890123')
	assert.equal(ntf.headCarrier.name, '中国香港')

	const ntfUnread = EsimCore.decodeNtfSummary([0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
	assert.equal(ntfUnread.unread, true)
	assert.equal(ntfUnread.headIccid, '')
	assert.equal(EsimCore.decodeNtfSummary([0, 0, 0]), null)
}

// 2.5. 错误码全分区测试（含 0x0105 / 0x0802 / 0x0705 / 0xE1xx / 0xE2xx / 0xE3se / 0xE4rn XFER）
{
	const egMod = { moduleVersion: 'EG800ZEULAR09A01M04_BETA261020_E' }
	assert.ok(EsimCore.decodeModuleErrCode(0x0105, egMod).name.includes('STK'))
	assert.ok(EsimCore.decodeModuleErrCode(0x0302, egMod).name.includes('禁止删除启用态'))
	assert.ok(EsimCore.decodeModuleErrCode(0x0802, egMod).name.includes('禁止删除启用态'))
	assert.ok(EsimCore.decodeModuleErrCode(0x0705, egMod).name.includes('激活码无效'))

	assert.equal(EsimCore.decodeModuleErrCode(0xE135).name, '+CME ERROR: 53 (参数非法)')
	assert.ok(EsimCore.decodeModuleErrCode(0xE205).name.includes('AT+QIACT=1'))
	assert.equal(EsimCore.decodeModuleErrCode(0xE367).detail.stateName, 'WAIT_URC')

	const xf3E = EsimCore.decodeModuleErrCode(0xE4BE) // dir=1(PUSH), round=3, errMag=0xE(60s keepalive timeout)
	assert.equal(xf3E.category, 'xfer')
	assert.equal(xf3E.detail.dir, 1)
	assert.equal(xf3E.detail.round, 3)
	assert.ok(xf3E.detail.xferName.includes('60s 保活超时'))
	assert.ok(xf3E.displayText.includes('XFER') && xf3E.displayText.includes('第 3 轮'))

	const xfAbt = EsimCore.decodeModuleErrCode(0xE4AB) // dir=1, round=2, errMag=0xB(ABORT)
	assert.equal(xfAbt.category, 'xfer')
	assert.ok(xfAbt.detail.xferName.includes('ABORT'))
}

// 3. Tag=66 ID4(下载触发脱敏) / ID5(单卡管理与策略拦截) / ID6(通知队列) / ID7(卡管控策略配置)
{
	// ID4 下载触发 + 脱敏
	const secretAc = 'LPA:1$smdp.example.invalid$SECRET-MATCHING-ID-987654'
	const secretCc = 'CONF-CODE-4321'
	const dlVal = EsimCore.encodeDownloadTrigger({ mode: 1, ac: secretAc, cc: secretCc })
	assert.equal(dlVal[0], 1)
	assert.equal(dlVal[1], secretAc.length)
	assert.equal(dlVal[2 + secretAc.length], secretCc.length)

	const redacted = EsimCore.redactDownloadValue(dlVal)
	assert.equal(redacted.length, dlVal.length)
	assert.ok(!Buffer.from(redacted).toString('ascii').includes('SECRET-MATCHING-ID'))
	assert.ok(!Buffer.from(redacted).toString('ascii').includes('CONF-CODE-4321'))

	const downDl = window.skBuildDownFrame({
		frameSeq: 8,
		version: 2,
		funcCode: 0x01,
		tlv: [{ tag: 66, items: [{ id: 4, value: dlVal }] }],
	})
	const parsedDl = window.skParseFrame(downDl)
	assert.equal(parsedDl.ok, true)
	assert.equal(parsedDl.tlv[0].items[0].id, 4)
	assert.ok(parsedDl.tlv[0].items[0].decoded.includes('近端XFER代理'))
	assert.ok(parsedDl.tlv[0].items[0].decoded.includes('已脱敏'))
	assert.ok(!parsedDl.tlv[0].items[0].decoded.includes('SECRET-MATCHING-ID'))
	assert.ok(!parsedDl.tlv[0].items[0].decoded.includes('CONF-CODE-4321'))
	const lvHtml = window.ParseView.render(window.skLogView(parsedDl))
	assert.ok(!lvHtml.includes('SECRET-MATCHING-ID'))
	assert.ok(!lvHtml.includes('CONF-CODE-4321'))

	// ID5 单卡管理与策略拦截（含 bit8 LOCK_DELETE、bit9 LOCK_DISABLE 禁禁且禁切走）
	const mVal = EsimCore.encodeProfileManage({ op: 3, iccid: '89860099887766554433' })
	assert.equal(mVal.length, 21)
	assert.equal(mVal[0], 3)

	const pLockedEnabled = { iccid: '89860011223344556677', enabled: true, lockDelete: true, lockDisable: true }
	const pDisabledLockedDel = { iccid: '89860099887766554433', enabled: false, lockDelete: true, lockDisable: false }
	const pDisabledFree = { iccid: '89860155555555555555', enabled: false, lockDelete: false, lockDisable: false }

	assert.equal(EsimCore.validateProfileAction(3, pLockedEnabled, [pLockedEnabled, pDisabledFree]).allowed, false)
	assert.equal(EsimCore.validateProfileAction(3, pDisabledLockedDel, [pLockedEnabled, pDisabledLockedDel]).allowed, false, 'bit8 LOCK_DELETE 必须阻止删除')
	assert.equal(EsimCore.validateProfileAction(2, pLockedEnabled, [pLockedEnabled, pDisabledFree]).allowed, false, 'bit9 LOCK_DISABLE 必须阻止禁用')
	assert.equal(EsimCore.validateProfileAction(1, pDisabledFree, [pLockedEnabled, pDisabledFree]).allowed, false, '另一启用卡带 LOCK_DISABLE 时必须阻止切走')
	assert.equal(EsimCore.validateProfileAction(3, pDisabledFree, [pDisabledFree]).allowed, true)

	// ID6 通知队列操作触发 (1B)
	const ntfSyncVal = EsimCore.encodeNtfManage({ op: 1 })
	assert.deepEqual(Array.from(ntfSyncVal), [1])
	const ntfPurgeVal = EsimCore.encodeNtfManage({ op: 2 })
	assert.deepEqual(Array.from(ntfPurgeVal), [2])
	assert.throws(() => EsimCore.encodeNtfManage({ op: 3 }))

	const downId6 = window.skBuildDownFrame({
		frameSeq: 9,
		version: 2,
		funcCode: 0x01,
		tlv: [{ tag: 66, items: [{ id: 6, value: ntfSyncVal }] }],
	})
	const parsedId6 = window.skParseFrame(downId6)
	assert.equal(parsedId6.ok, true)
	assert.ok(parsedId6.tlv[0].items[0].decoded.includes('同步待发通知(1)'))

	// ID7 卡管控策略配置 (22B)
	const polSet = EsimCore.encodeProfilePolicy({ op: 0, iccid: '89860011223344556677', policyMask: 0x0D })
	assert.equal(polSet.length, 22)
	assert.equal(polSet[0], 0)
	assert.equal(polSet[21], 0x0D)
	const polDec = EsimCore.decodeProfilePolicy(polSet)
	assert.equal(polDec.iccid, '89860011223344556677')
	assert.equal(polDec.lockDelete, true)
	assert.equal(polDec.lockDisable, false)
	assert.equal(polDec.hiddenUser, true)
	assert.equal(polDec.fallbackSeed, true)

	const polClr = EsimCore.encodeProfilePolicy({ op: 1 })
	assert.equal(polClr.length, 22)
	assert.equal(polClr[0], 1)
	assert.ok(polClr.slice(1).every((b) => b === 0), 'op=1 清空全部策略时 ICCID 和 policyMask 必须全 0')
	assert.throws(() => EsimCore.encodeProfilePolicy({ op: 0, iccid: '89860011223344556677', policyMask: 0x10 }), '高 4 位保留位非 0 必须拒绝')

	const downId7 = window.skBuildDownFrame({
		frameSeq: 10,
		version: 2,
		funcCode: 0x01,
		tlv: [{ tag: 66, items: [{ id: 7, value: polSet }] }],
	})
	const parsedId7 = window.skParseFrame(downId7)
	assert.equal(parsedId7.ok, true)
	assert.ok(parsedId7.tlv[0].items[0].decoded.includes('设置策略(0)'))
	assert.ok(parsedId7.tlv[0].items[0].decoded.includes('禁删,客户隐藏,保底'))
}

// 4. 固件 Protocol/xfer/xfer.c 的精确 JS 镜像服务，用于验证 XFER (0xA5 0x5A) 帧格式、块长协商、60s 续传与通知同步
function createMockXferServer(backend, channelMaxChunk) {
	const chMax = channelMaxChunk || 700
	let srv = resetSrv()

	function resetSrv() {
		return {
			active: 0,
			target: 0,
			dir: 0,
			sessionId: 0,
			agreedChunk: 0,
			respMetaParam: 0,
			totalSize: 0,
			expectedCrc32: 0,
			ackedOffset: 0,
			runningCrc32: 0,
			openReqCrc: 0,
			respMeta: new Uint8Array(0),
		}
	}

	function wrU16(buf, off, v) { buf[off] = v & 0xff; buf[off + 1] = (v >>> 8) & 0xff }
	function wrU32(buf, off, v) {
		buf[off] = v & 0xff
		buf[off + 1] = (v >>> 8) & 0xff
		buf[off + 2] = (v >>> 16) & 0xff
		buf[off + 3] = (v >>> 24) & 0xff
	}
	function rdU16(buf, off) { return (buf[off] | (buf[off + 1] << 8)) >>> 0 }
	function rdU32(buf, off) { return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0 }

	function handleFrame(reqBytes) {
		const f = Xfer.unpackFrame(reqBytes)
		assert.equal(f.ok, true, 'Host 发出的 XFER 帧必须合法')
		const op = f.op
		const arg = f.argOrStatus
		let sid = f.sessionId
		const pay = f.payload
		const matched = srv.active && sid !== 0 && sid === srv.sessionId
		let sts = Xfer.STATUS.OK
		let outPay = new Uint8Array(0)

		if (op === Xfer.OP.OPEN) {
			const target = pay[0]
			const reqMax = rdU16(pay, 1)
			const totSize = rdU32(pay, 3)
			const expCrc = rdU32(pay, 7)
			const mParam = rdU16(pay, 11)
			const mLen = pay[13]
			const meta = pay.slice(14, 14 + mLen)
			const reqCrc = Xfer.crc32(pay)
			if (srv.active) {
				if (sid !== srv.sessionId || arg !== srv.dir || reqCrc !== srv.openReqCrc || srv.ackedOffset !== 0) {
					sts = Xfer.STATUS.BUSY
				}
			} else {
				const resp = backend.open({ target, dir: arg, totalSize: totSize, metaParam: mParam, meta })
				if (resp.status !== Xfer.STATUS.OK) {
					sts = resp.status
				} else {
					let agreed = Math.min(chMax, reqMax, Xfer.MAX_CHUNK_LEN)
					if (resp.maxChunk && resp.maxChunk < agreed) agreed = resp.maxChunk
					srv.active = 1
					srv.target = target
					srv.dir = arg
					srv.sessionId = sid
					srv.agreedChunk = agreed
					srv.respMetaParam = resp.metaParam || 0
					srv.totalSize = arg === Xfer.DIR.PUSH ? totSize : (resp.totalSize || 0)
					srv.expectedCrc32 = arg === Xfer.DIR.PUSH ? expCrc : (resp.totalCrc32 || 0)
					srv.ackedOffset = 0
					srv.runningCrc32 = 0
					srv.openReqCrc = reqCrc
					srv.respMeta = resp.meta || new Uint8Array(0)
				}
			}
			if (sts === Xfer.STATUS.OK) {
				outPay = new Uint8Array(13 + srv.respMeta.length)
				wrU16(outPay, 0, srv.agreedChunk)
				wrU32(outPay, 2, srv.totalSize)
				wrU32(outPay, 6, srv.expectedCrc32)
				wrU16(outPay, 10, srv.respMetaParam)
				outPay[12] = srv.respMeta.length
				outPay.set(srv.respMeta, 13)
			}
		} else if (op === Xfer.OP.DATA) {
			if (!matched) {
				sts = Xfer.STATUS.NO_SESSION
			} else {
				const off = rdU32(pay, 0)
				const len = rdU16(pay, 4)
				const chunk = pay.slice(6, 6 + len)
				if (srv.dir !== Xfer.DIR.PUSH || len === 0 || len > srv.agreedChunk) {
					sts = Xfer.STATUS.BAD_PARAM
				} else if (off === srv.ackedOffset && len <= srv.totalSize - off) {
					sts = backend.write(off, chunk)
					if (sts === Xfer.STATUS.OK) {
						srv.ackedOffset += len
						srv.runningCrc32 = srv.expectedCrc32 ? Xfer.crc32Update(srv.runningCrc32, chunk) : 0
					}
				} else if (!(off < srv.ackedOffset && (srv.ackedOffset - off) === len)) {
					sts = Xfer.STATUS.OFFSET_ERR
				}
			}
			outPay = new Uint8Array(4)
			wrU32(outPay, 0, matched ? srv.ackedOffset : 0)
		} else if (op === Xfer.OP.PULL) {
			if (!matched) {
				sts = Xfer.STATUS.NO_SESSION
			} else {
				const off = rdU32(pay, 0)
				let n = Math.min(rdU16(pay, 4), srv.agreedChunk, srv.totalSize - off)
				const chunk = n > 0 ? backend.read(off, n) : new Uint8Array(0)
				srv.ackedOffset = Math.max(srv.ackedOffset, off + n)
				outPay = new Uint8Array(6 + chunk.length)
				wrU32(outPay, 0, off)
				wrU16(outPay, 4, chunk.length)
				outPay.set(chunk, 6)
			}
		} else if (op === Xfer.OP.COMMIT) {
			const commitParam = rdU16(pay, 0)
			let resCode = 0
			if (!matched) {
				sts = Xfer.STATUS.NO_SESSION
			} else if (srv.dir === Xfer.DIR.PUSH && srv.ackedOffset !== srv.totalSize) {
				sts = Xfer.STATUS.EOF_INCOMPLETE
			} else if (srv.dir === Xfer.DIR.PUSH && srv.expectedCrc32 && srv.runningCrc32 !== srv.expectedCrc32) {
				sts = Xfer.STATUS.CRC_ERR
			} else {
				const cr = backend.commit(commitParam)
				sts = cr.status
				resCode = cr.resultCode || 0
				if (sts === Xfer.STATUS.OK) srv = resetSrv()
			}
			outPay = new Uint8Array(2)
			wrU16(outPay, 0, resCode)
		} else if (op === Xfer.OP.QUERY) {
			outPay = new Uint8Array(16)
			outPay[0] = srv.active
			outPay[1] = srv.target
			outPay[2] = srv.dir
			outPay[3] = 0
			wrU16(outPay, 4, srv.respMetaParam)
			wrU16(outPay, 6, srv.agreedChunk)
			wrU32(outPay, 8, srv.totalSize)
			wrU32(outPay, 12, srv.ackedOffset)
			sid = srv.sessionId
		} else if (op === Xfer.OP.ABORT) {
			const reason = rdU16(pay, 0)
			if (backend.abort) backend.abort(reason)
			srv = resetSrv()
		} else {
			sts = Xfer.STATUS.BAD_FRAME
		}
		return Xfer.packFrame(op | 0x80, sts, sid, outPay)
	}

	return { handleFrame, getState: () => srv }
}

function makeDirectXferIo(server, opts) {
	opts = opts || {}
	const rxQ = Xfer.createByteQueue()
	const txFrames = []
	let disconnected = false
	let dropAtPushOffset = opts.dropAtPushOffset != null ? opts.dropAtPushOffset : -1
	let droppedOnce = false

	const io = {
		readByte(ms) {
			if (disconnected) return Promise.reject(Object.assign(new Error('模拟 BLE 断连'), { xferCode: Xfer.ERR.ERR_IO }))
			return rxQ.readByte(ms)
		},
		async writeBytes(u8) {
			const copy = new Uint8Array(u8)
			txFrames.push(copy)
			const parsed = Xfer.unpackFrame(copy)
			if (disconnected) throw Object.assign(new Error('模拟 BLE 断连'), { xferCode: Xfer.ERR.ERR_IO })
			if (dropAtPushOffset >= 0 && !droppedOnce && parsed.ok && parsed.op === Xfer.OP.DATA) {
				const off = (parsed.payload[0] | (parsed.payload[1] << 8) | (parsed.payload[2] << 16) | (parsed.payload[3] << 24)) >>> 0
				if (off >= dropAtPushOffset) {
					droppedOnce = true
					disconnected = true
					throw Object.assign(new Error('模拟第3轮 BPP 中途断连'), { xferCode: Xfer.ERR.ERR_IO })
				}
			}
			const resp = server.handleFrame(copy)
			// 模拟夹杂 TTM 日志与噪声前缀，验证 Xfer.readFrame 帧同步稳健性
			if (opts.injectNoise) rxQ.push(new TextEncoder().encode('TTM:OK\r\n'))
			rxQ.push(resp)
		},
	}
	return {
		io,
		txFrames,
		reconnect() {
			disconnected = false
			rxQ.reset()
		},
	}
}

function createMode1DownloadBackend(opts) {
	opts = opts || {}
	const enc = new TextEncoder()
	let round = 0 // 0..3
	let phase = 'PULL'
	let openDelayCalls = opts.startupNoSessionCount || 0
	let pushedChunks = []
	const receivedResponses = []
	const abortReasons = []

	return {
		receivedResponses,
		abortReasons,
		open(req) {
			if (openDelayCalls > 0) {
				openDelayCalls--
				return { status: Xfer.STATUS.NO_SESSION }
			}
			if (req.dir === Xfer.DIR.PULL && req.target === Xfer.TARGET.ESIM_REQ) {
				if (phase !== 'PULL' || round >= 4) return { status: Xfer.STATUS.BUSY }
				const pathStr = opts.overridePath && opts.overridePath[round] ? opts.overridePath[round] : EsimCore.ES9_ROUNDS[round].path
				const smdp = opts.reqSmdpAddress || 'smdp.test.invalid'
				const json = enc.encode(JSON.stringify({ smdpAddress: smdp, round: round + 1 }))
				this._curReq = json
				return {
					status: Xfer.STATUS.OK,
					totalSize: json.length,
					totalCrc32: Xfer.crc32(json),
					metaParam: round + 1,
					meta: enc.encode(pathStr),
				}
			}
			if (req.dir === Xfer.DIR.PUSH && req.target === Xfer.TARGET.ESIM_RSP) {
				if (phase !== 'PUSH') return { status: Xfer.STATUS.BUSY }
				pushedChunks = []
				return { status: Xfer.STATUS.OK, metaParam: round + 1 }
			}
			return { status: Xfer.STATUS.BAD_PARAM }
		},
		read(off, len) {
			return this._curReq.slice(off, off + len)
		},
		write(off, chunk) {
			pushedChunks.push(new Uint8Array(chunk))
			return Xfer.STATUS.OK
		},
		commit(commitParam) {
			if (phase === 'PULL') {
				phase = 'PUSH'
				return { status: Xfer.STATUS.OK, resultCode: round + 1 }
			}
			let total = 0
			for (const c of pushedChunks) total += c.length
			const merged = new Uint8Array(total)
			let p = 0
			for (const c of pushedChunks) { merged.set(c, p); p += c.length }
			receivedResponses.push({ round, commitParam, data: merged })
			round++
			phase = 'PULL'
			return { status: Xfer.STATUS.OK, resultCode: commitParam || 200 }
		},
		abort(reason) {
			abortReasons.push(reason)
		},
	}
}

async function runAsyncTests() {
	const enc = new TextEncoder()

	// 5a. XFER (0xA5 0x5A) mode=1 四轮完整成功 + 模拟开机 NO_SESSION 等待 + 噪声同步 + 红外 128B 块长协商
	for (const chMax of [700, 128]) {
		const backend = createMode1DownloadBackend({ startupNoSessionCount: 2 })
		const srv = createMockXferServer(backend, chMax)
		const { io } = makeDirectXferIo(srv, { injectNoise: true })

		const rawResponses = [
			enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}},"transactionId":"T1"}'),
			enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}},"transactionId":"T1","round":2}'),
			enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}},"boundProfilePackage":"' + 'B'.repeat(2400) + '"}'),
			new Uint8Array(0),
		]
		const httpCalls = []
		const res = await EsimCore.runMode1ProxySession({
			xfer: Xfer,
			io,
			smdpHost: 'smdp.test.invalid',
			xferOpts: { rpcTimeoutMs: 1000, pollIntervalMs: 10, openWaitMs: 3000 },
			httpPost: async (req) => {
				httpCalls.push(req)
				const idx = httpCalls.length - 1
				return { status: idx === 3 ? 204 : 200, bodyBytes: rawResponses[idx] }
			},
		})
		assert.equal(res.ok, true)
		assert.equal(httpCalls.length, 4)
		assert.equal(res.rounds[2].agreedChunk, chMax, '应按通道块长协商: ' + chMax)
		assert.equal(backend.receivedResponses.length, 4)
		for (let r = 0; r < 3; r++) {
			assert.equal(backend.receivedResponses[r].commitParam, 200)
			assert.deepEqual(backend.receivedResponses[r].data, rawResponses[r])
		}
		assert.equal(backend.receivedResponses[3].commitParam, 204)
		assert.equal(backend.receivedResponses[3].data.length, 0)
	}

	// 5b. 第 3 轮 33KB BPP 中途断连 + 60s 保活重连 + QUERY(0x05) 获取 ackedOffset 无损续传
	{
		const backend = createMode1DownloadBackend()
		const srv = createMockXferServer(backend, 700)
		const pipe = makeDirectXferIo(srv, { dropAtPushOffset: 14000 })
		const bppPayload = enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}},"bpp":"' + 'X'.repeat(33400) + '"}')
		const rawResponses = [
			enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}},"r":1}'),
			enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}},"r":2}'),
			bppPayload,
			new Uint8Array(0),
		]
		let httpIdx = 0
		let resumeEv = null
		const res = await EsimCore.runMode1ProxySession({
			xfer: Xfer,
			io: pipe.io,
			smdpHost: 'smdp.test.invalid',
			xferOpts: { rpcTimeoutMs: 1000, pollIntervalMs: 10, openWaitMs: 3000, keepaliveMs: 5000 },
			waitReconnect: async () => {
				pipe.reconnect()
				return pipe.io
			},
			onEvent: (ev) => {
				if (ev.type === 'xfer-resumed') resumeEv = ev
			},
			httpPost: async () => {
				const idx = httpIdx++
				return { status: idx === 3 ? 204 : 200, bodyBytes: rawResponses[idx] }
			},
		})
		assert.equal(res.ok, true)
		assert.ok(resumeEv, '断连重连后必须触发 xfer-resumed 事件')
		assert.equal(resumeEv.ackedOffset, 14000, 'QUERY 应返回精确断点偏移 14000')
		assert.equal(res.rounds[2].resumedCount, 1)
		assert.deepEqual(backend.receivedResponses[2].data, bppPayload, '续传后的 33KB BPP 必须逐字节完整一致')
		// 确认发过 QUERY(0x05)
		assert.ok(pipe.txFrames.some((f) => Xfer.unpackFrame(f).op === Xfer.OP.QUERY), '重连续传前必须先发 QUERY(0x05)')
	}

	// 5c. SM-DP+ 业务失败 / 第 4 轮非 204 / 主机不匹配 / 用户取消 -> 立即发 XFER ABORT(0x06)
	{
		const backend = createMode1DownloadBackend()
		const srv = createMockXferServer(backend, 700)
		const pipe = makeDirectXferIo(srv)
		const failBody = enc.encode(JSON.stringify({
			header: { functionExecutionStatus: { status: 'Failed', statusCodeData: { subjectCode: '8.2.6', reasonCode: '3.8', message: 'Cancelled' } } },
		}))
		await assert.rejects(
			() => EsimCore.runMode1ProxySession({
				xfer: Xfer,
				io: pipe.io,
				smdpHost: 'smdp.test.invalid',
				xferOpts: { rpcTimeoutMs: 1000, openWaitMs: 2000 },
				httpPost: async () => ({ status: 200, bodyBytes: failBody }),
			}),
			(err) => err.stage === 'smdp-status' && err.subjectCode === '8.2.6'
		)
		assert.ok(pipe.txFrames.some((f) => Xfer.unpackFrame(f).op === Xfer.OP.ABORT), 'SM-DP+ 失败必须发 XFER ABORT')
		assert.equal(backend.abortReasons.length, 1)
	}
	{
		const backend = createMode1DownloadBackend({ reqSmdpAddress: 'evil.other.invalid' })
		const srv = createMockXferServer(backend, 700)
		const pipe = makeDirectXferIo(srv)
		await assert.rejects(
			() => EsimCore.runMode1ProxySession({
				xfer: Xfer,
				io: pipe.io,
				smdpHost: 'smdp.test.invalid',
				xferOpts: { rpcTimeoutMs: 1000, openWaitMs: 2000 },
				httpPost: async () => { throw new Error('不应发 HTTP') },
			}),
			(err) => err.stage === 'host-mismatch'
		)
		assert.equal(backend.abortReasons.length, 1)
	}
	{
		const backend = createMode1DownloadBackend()
		const srv = createMockXferServer(backend, 700)
		const pipe = makeDirectXferIo(srv)
		const ac = new AbortController()
		await assert.rejects(
			() => EsimCore.runMode1ProxySession({
				xfer: Xfer,
				io: pipe.io,
				smdpHost: 'smdp.test.invalid',
				signal: ac.signal,
				xferOpts: { rpcTimeoutMs: 1000, openWaitMs: 2000 },
				httpPost: () => new Promise(() => { setTimeout(() => ac.abort(), 30) }),
			}),
			(err) => err.stage === 'aborted'
		)
		assert.equal(backend.abortReasons.length, 1)
	}

	// 6. ID6 op=1 待发通知离线同步 (XFER target=0x03): HTTP 500 跳过不删 + 网络异常 0 跳过不删 + HTTP 204 删除 + 空哨兵 COMMIT(0) 收口
	{
		const queueItems = [
			{ seq: 10, fqdn: 'dead-http500.test', json: enc.encode('{"pendingNotification":"REVBRDEw"}') },
			{ seq: 11, fqdn: 'dead-dns.test', json: enc.encode('{"pendingNotification":"RE5TMTF="}') },
			{ seq: 12, fqdn: 'live-smdp.test', json: enc.encode('{"pendingNotification":"TElWRTEy"}') },
		]
		let cursor = 0
		let sentinelCommitted = false
		const deletedSeqs = []
		const skippedSeqs = []

		const ntfBackend = {
			open(req) {
				assert.equal(req.dir, Xfer.DIR.PULL)
				assert.equal(req.target, Xfer.TARGET.ESIM_NTF)
				if (cursor < queueItems.length) {
					const it = queueItems[cursor]
					this._cur = it
					return {
						status: Xfer.STATUS.OK,
						totalSize: it.json.length,
						totalCrc32: Xfer.crc32(it.json),
						metaParam: it.seq,
						meta: enc.encode(it.fqdn),
					}
				}
				this._cur = null
				return { status: Xfer.STATUS.OK, totalSize: 0, totalCrc32: 0, metaParam: 0, meta: new Uint8Array(0) }
			},
			read(off, len) { return this._cur.json.slice(off, off + len) },
			commit(commitParam) {
				if (!this._cur) {
					assert.equal(commitParam, 0)
					sentinelCommitted = true
					return { status: Xfer.STATUS.OK, resultCode: 0 }
				}
				const seq = this._cur.seq
				cursor++
				if (commitParam === 204) {
					deletedSeqs.push(seq)
					return { status: Xfer.STATUS.OK, resultCode: 204 }
				}
				skippedSeqs.push([seq, commitParam])
				return { status: Xfer.STATUS.OK, resultCode: commitParam }
			},
		}

		const srv = createMockXferServer(ntfBackend, 700)
		const { io } = makeDirectXferIo(srv)
		const postedUrls = []
		const res = await EsimCore.runNtfSyncProxySession({
			xfer: Xfer,
			io,
			xferOpts: { rpcTimeoutMs: 1000, openWaitMs: 2000 },
			httpPost: async (req) => {
				postedUrls.push(req.url)
				if (req.smdpHost === 'dead-http500.test') return { status: 500, bodyBytes: new Uint8Array(0) }
				if (req.smdpHost === 'dead-dns.test') throw new Error('DNS failed')
				return { status: 204, bodyBytes: new Uint8Array(0) }
			},
		})
		assert.equal(res.ok, true)
		assert.equal(sentinelCommitted, true)
		assert.equal(res.deletedCount, 1)
		assert.equal(res.skippedCount, 2)
		assert.deepEqual(deletedSeqs, [12])
		assert.deepEqual(skippedSeqs, [[10, 500], [11, 0]])
		assert.deepEqual(postedUrls, [
			'https://dead-http500.test/gsma/rsp2/es9plus/handleNotification',
			'https://dead-dns.test/gsma/rsp2/es9plus/handleNotification',
			'https://live-smdp.test/gsma/rsp2/es9plus/handleNotification',
		])
	}

	// 7. esim-panel.js 全链路回归（路由/脱敏/TLS/视图模式/策略写入 ID7/通知同步与强清 ID6）
	function createPanelHarness(opts) {
		opts = opts || {}
		const listeners = Object.create(null)
		const storageMap = Object.assign(Object.create(null), opts.initialStorage || {})

		function makeNode(tag, id, extra) {
			let _text = ''
			const node = Object.assign({
				tagName: String(tag || 'DIV').toUpperCase(),
				id: id || '',
				type: '',
				value: '',
				checked: false,
				className: '',
				title: '',
				hidden: false,
				disabled: false,
				style: {},
				dataset: {},
				attrs: Object.create(null),
				childNodes: [],
				scrollTop: 0,
				scrollHeight: 0,
				_listeners: Object.create(null),
				get textContent() { return _text },
				set textContent(v) { _text = String(v == null ? '' : v); this.childNodes.length = 0 },
				setAttribute(k, v) { this.attrs[k] = String(v) },
				getAttribute(k) { return this.attrs[k] },
				addEventListener(type, fn) {
					this._listeners[type] = fn
					if (this.id) listeners[this.id + ':' + type] = fn
				},
				appendChild(ch) { this.childNodes.push(ch); return ch },
				append(...args) { args.forEach((a) => this.appendChild(a)) },
				removeChild(ch) {
					const idx = this.childNodes.indexOf(ch)
					if (idx >= 0) this.childNodes.splice(idx, 1)
				},
				querySelectorAll(sel) {
					const out = []
					function walk(n) {
						for (const c of n.childNodes || []) {
							if (sel === 'button' && c.tagName === 'BUTTON') out.push(c)
							if (sel === 'input[type="checkbox"]' && c.tagName === 'INPUT' && c.type === 'checkbox') out.push(c)
							walk(c)
						}
					}
					walk(this)
					return out
				},
			}, extra || {})
			return node
		}

		const ids = [
			'sk-esim-card', 'sk-esim-view-customer', 'sk-esim-view-admin',
			'sk-esim-eid', 'sk-esim-refresh', 'sk-esim-poll', 'sk-esim-stop',
			'sk-esim-state-badge', 'sk-esim-runtime-flags', 'sk-esim-last-op', 'sk-esim-fail-stage',
			'sk-esim-err-code', 'sk-esim-err-hint', 'sk-esim-status-time', 'sk-esim-cache-age',
			'sk-esim-ntf-section', 'sk-esim-ntf-badge', 'sk-esim-ntf-total', 'sk-esim-ntf-del',
			'sk-esim-ntf-other', 'sk-esim-ntf-head-event', 'sk-esim-ntf-head-iccid',
			'sk-esim-ntf-sync', 'sk-esim-ntf-purge',
			'sk-esim-profile-count', 'sk-esim-policy-clear', 'sk-esim-profile-list',
			'sk-esim-mode', 'sk-esim-redact', 'sk-esim-ac', 'sk-esim-cc',
			'sk-esim-proxy-row', 'sk-esim-proxy-notice', 'sk-esim-tls-wrap', 'sk-esim-insecure-tls', 'sk-esim-proxy-url',
			'sk-esim-download', 'sk-esim-progress-bar', 'sk-esim-status', 'sk-esim-log-title', 'sk-esim-log', 'sk-esim-log-clear',
		]
		const elements = Object.create(null)
		for (const id of ids) elements[id] = makeNode('div', id)
		elements['sk-esim-mode'].value = String(opts.downloadMode != null ? opts.downloadMode : 0)
		elements['sk-esim-redact'].checked = true
		elements['sk-esim-ac'].type = 'password'
		elements['sk-esim-ac'].value = opts.ac || 'LPA:1$smdp.test.invalid$MATCH-12345'
		elements['sk-esim-cc'].type = 'password'
		elements['sk-esim-cc'].value = opts.cc != null ? opts.cc : 'CC-9988'

		const panelCtx = {
			window: opts.panelWin,
			localStorage: {
				getItem(k) { return Object.prototype.hasOwnProperty.call(storageMap, k) ? storageMap[k] : null },
				setItem(k, v) { storageMap[k] = String(v) },
			},
			document: {
				readyState: 'complete',
				getElementById(id) { return elements[id] || null },
				createElement(tag) { return makeNode(tag, '') },
				addEventListener() {},
			},
			Uint8Array, TextEncoder, TextDecoder, AbortController, Date, console,
			setTimeout(fn, ms) { return setTimeout(fn, Math.min(ms || 0, 5)) },
			clearTimeout,
		}
		vm.createContext(panelCtx)
		vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/esim-panel.js'), 'utf8'), panelCtx)
		return { elements, listeners, storageMap }
	}

	// 7a. esim-panel.js mode=0 / mode=1 (XFER) 路由、TLS 开关、脱敏开关与 ID4 触发帧回归
	async function runPanelDownloadCase({ serialMode, activeUiSid, openPhysSid, downloadMode, allowInsecureTls = false, redact = true }) {
		const calls = {
			pinSession: [], unpinCount: 0, writeRawTo: [], isSessionOpen: [],
			setSuppressRxLog: [], onReceiveFrom: [], httpReqs: [],
		}
		const okBody = enc.encode('{"header":{"functionExecutionStatus":{"status":"Executed-Success"}}}')
		const dlBackend = createMode1DownloadBackend()
		const xferSrv = createMockXferServer(dlBackend, 700)
		let rxSub = null
		let pinnedSid = null

		const serialApi = {
			getMode() { return serialMode },
			getActiveSendSid() { return activeUiSid },
			isOpen() { return true },
			isSessionOpen(id) { calls.isSessionOpen.push(id); return id === openPhysSid },
			isPinned() { return pinnedSid !== null },
			pinSession(sid) { calls.pinSession.push(sid); pinnedSid = sid },
			unpinSession() { calls.unpinCount++; pinnedSid = null },
			suppressParse: false,
			setSuppressRxLog(sid, on) { calls.setSuppressRxLog.push([sid, !!on]) },
			onReceiveFrom(sid, cb) {
				calls.onReceiveFrom.push(sid)
				rxSub = { sid, cb }
				return () => { rxSub = null }
			},
			async writeRawTo(id, data, opts) {
				calls.writeRawTo.push({ id, len: data.length, data: new Uint8Array(data), hasLogData: !!(opts && opts.logData) })
				if (!this.isSessionOpen(id)) throw new Error('串口会话未打开或当前模式不可路由')
				if (rxSub && downloadMode === 1 && data[0] === Xfer.MAGIC_0 && data[1] === Xfer.MAGIC_1) {
					const resp = xferSrv.handleFrame(data)
					setTimeout(() => { if (rxSub && rxSub.sid === openPhysSid) rxSub.cb(resp) }, 0)
				}
			},
		}

		// 终态 ID2 (14B): state=2(成功), runtimeFlags=0x02(缓存已就绪), lastOp=2, failStage=0, err=0, time=0, cacheAge=3
		const id2Done = [2, 0x02, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]
		const doneFrame = window.skParseFrame(sekUp(0x83, tlvBlock(66, [[2].concat(id2Done)])))
		let seq = 1
		let httpCount = 0

		const panelWin = {
			EsimCore,
			Xfer,
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
			AppDialog: { async alert(msg) { throw new Error('unexpected alert: ' + msg) }, async confirm() { return true } },
			serialApi,
			skBuildDownFrame: window.skBuildDownFrame,
			sekTx: {
				nextSeq() { return seq++ },
				clearBuffer() {},
				waitFor() { return Promise.resolve({ frame: { dir: 'up', fields: { '功能码': 0x81 } } }) },
				tag11Result() { return 0 },
				hasTag(f, tag) { return !!(f && f.tlv && f.tlv.some((t) => t.tag === tag)) },
				findTlvItem(f, tag, id) {
					const blk = f && f.tlv ? f.tlv.find((t) => t.tag === tag) : null
					return blk ? (blk.items.find((it) => it.id === id) || null) : null
				},
				async sendAndWait() { return { frame: doneFrame } },
			},
		}

		const { elements, listeners, storageMap } = createPanelHarness({ panelWin, downloadMode })

		if (!redact) {
			elements['sk-esim-redact'].checked = false
			listeners['sk-esim-redact:change']()
			assert.equal(storageMap.skEsimRedact, '0')
			assert.equal(elements['sk-esim-ac'].type, 'text')
		}
		if (downloadMode === 1 && allowInsecureTls) {
			elements['sk-esim-insecure-tls'].checked = true
			listeners['sk-esim-insecure-tls:change']()
			assert.equal(storageMap.skEsimAllowInsecureTls, '1')
		}

		await listeners['sk-esim-download:click']()

		// 验证首帧为 Tag=66 ID=4 (V2.32 下载触发)
		const firstParsed = window.skParseFrame(calls.writeRawTo[0].data)
		assert.equal(firstParsed.ok, true)
		assert.equal(firstParsed.tlv[0].tag, 66)
		assert.equal(firstParsed.tlv[0].items[0].id, 4, '下载触发必须使用 Tag=66 ID=4')

		const logs = elements['sk-esim-log'].childNodes.map((n) => n.textContent)
		assert.ok(!elements['sk-esim-status'].textContent.includes('下载失败'), elements['sk-esim-status'].textContent)
		assert.deepEqual(calls.pinSession, [openPhysSid])
		assert.equal(calls.unpinCount, 1)
		assert.equal(calls.writeRawTo[0].hasLogData, !!redact)
		assert.ok(!Object.values(storageMap).some((v) => v.includes('MATCH-12345') || v.includes('CC-9988')))
		if (downloadMode === 1) {
			assert.equal(httpCount, 4)
			assert.ok(calls.httpReqs.every((r) => r.allowInsecureTls === !!allowInsecureTls))
			if (redact) {
				assert.deepEqual(calls.setSuppressRxLog, [[openPhysSid, true], [openPhysSid, false]])
				assert.ok(calls.writeRawTo.every((c) => c.hasLogData === true))
			} else {
				assert.deepEqual(calls.setSuppressRxLog, [])
				assert.ok(calls.writeRawTo.every((c) => c.hasLogData === false))
			}
		}
	}

	await runPanelDownloadCase({ serialMode: 'single', activeUiSid: 'A', openPhysSid: 'S', downloadMode: 0 })
	await runPanelDownloadCase({ serialMode: 'single', activeUiSid: 'A', openPhysSid: 'S', downloadMode: 1, allowInsecureTls: false })
	await runPanelDownloadCase({ serialMode: 'single', activeUiSid: 'A', openPhysSid: 'S', downloadMode: 1, allowInsecureTls: true })
	await runPanelDownloadCase({ serialMode: 'dual', activeUiSid: 'B', openPhysSid: 'B', downloadMode: 1, allowInsecureTls: true, redact: false })

	// 7b. 视图模式（客户视图 / 管理员视图）、ID7 策略写入、ID6 通知同步与强清二次确认回归
	{
		const eidBytes = [0x89, 0x04, 0x90, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x22, 0x33, 0x44]
		// 3 张卡：
		// #1 隐藏且启用 (bit0 | bit10 | bit8 | bit9 | bit11) -> 客户视图脱敏“内置默认通信通道 [使用中]”无按钮
		// #2 隐藏且禁用 (bit10) -> 客户视图完全隐藏
		// #3 普通禁用卡，带禁删 (bit8) 和待发通知 (bit3) -> 客户视图展示但隐藏删除、标 🔒禁删，管理员视图全展示+策略编辑
		const f1 = EsimCore.encodeProfileFlags({ enabled: true, profileClass: 1, lockDelete: true, lockDisable: true, hiddenUser: true, fallbackSeed: true })
		const f2 = EsimCore.encodeProfileFlags({ enabled: false, profileClass: 2, hiddenUser: true })
		const f3 = EsimCore.encodeProfileFlags({ enabled: false, profileClass: 0, hasPendingNtf: true, lockDelete: true })
		const id1Val = [3]
			.concat(asciiPadded('89860011111111111111', 20), [f1 & 0xff, f1 >> 8])
			.concat(asciiPadded('89860122222222222222', 20), [f2 & 0xff, f2 >> 8])
			.concat(asciiPadded('89860333333333333333', 20), [f3 & 0xff, f3 >> 8])
		const id2Val = [2, 0x06, 7, 0, 0, 0, 0x20, 0x26, 0x11, 0x28, 0x14, 0x30, 0x00, 12]
		const id3Val = [2, 1, 1, 4].concat(Array.from(EsimCore.encodeIccidBcd('89860333333333333333')))

		window.skSession.resetModule()
		const tag66Frame = window.skParseFrame(sekUp(0x83, tlvBlock(66, [
			[0].concat(eidBytes),
			[1].concat(id1Val),
			[2].concat(id2Val),
			[3].concat(id3Val),
		])))

		const sentReqs = []
		const confirmCalls = []
		let pinnedSid = null
		let rxSub = null

		// 准备通知同步模拟后端
		let ntfCursor = 0
		const ntfSrv = createMockXferServer({
			open(req) {
				if (req.target === Xfer.TARGET.ESIM_NTF && ntfCursor === 0) {
					const j = enc.encode('{"pendingNotification":"QUI="}')
					this._j = j
					return { status: Xfer.STATUS.OK, totalSize: j.length, totalCrc32: Xfer.crc32(j), metaParam: 77, meta: enc.encode('ntf.test') }
				}
				this._j = null
				return { status: Xfer.STATUS.OK, totalSize: 0, totalCrc32: 0, metaParam: 0, meta: new Uint8Array(0) }
			},
			read(off, len) { return this._j.slice(off, off + len) },
			commit(p) { ntfCursor++; return { status: Xfer.STATUS.OK, resultCode: p } },
		}, 700)

		const panelWin = {
			EsimCore,
			Xfer,
			AppPlatform: {
				service(name) {
					if (name !== 'esim-http') return null
					return { async post() { return { status: 204, bodyBytes: new Uint8Array(0) } } }
				},
			},
			AppDialog: {
				async alert(msg) { throw new Error('unexpected alert: ' + msg) },
				async confirm(msg, opts) { confirmCalls.push(opts && opts.title ? opts.title : msg); return true },
			},
			serialApi: {
				getMode() { return 'single' },
				getActiveSendSid() { return 'A' },
				isOpen() { return true },
				isSessionOpen() { return true },
				isPinned() { return pinnedSid !== null },
				pinSession(sid) { pinnedSid = sid },
				unpinSession() { pinnedSid = null },
				suppressParse: false,
				setSuppressRxLog() {},
				onReceiveFrom(sid, cb) { rxSub = cb; return () => { rxSub = null } },
				async writeRawTo(sid, data) {
					if (rxSub && data[0] === Xfer.MAGIC_0 && data[1] === Xfer.MAGIC_1) {
						const resp = ntfSrv.handleFrame(data)
						setTimeout(() => { if (rxSub) rxSub(resp) }, 0)
					}
				},
				getActiveLaneModuleInfo() { return { known: true, isEg800z: true } },
			},
			sekTx: {
				hasTag(f, tag) { return !!(f && f.tlv && f.tlv.some((t) => t.tag === tag)) },
				findTlvItem(f, tag, id) {
					const blk = f && f.tlv ? f.tlv.find((t) => t.tag === tag) : null
					return blk ? (blk.items.find((it) => it.id === id) || null) : null
				},
				async sendAndWait(opts) {
					const b = opts.buildOpts
					sentReqs.push({ fc: b.funcCode, tag: b.tlv[0].tag, id: b.tlv[0].items[0].id, val: b.tlv[0].items[0].value })
					if (b.funcCode === 0x03 && b.tlv[0].items[0].id === 1) {
						return { frame: window.skParseFrame(sekUp(0x83, tlvBlock(1, [[10].concat(asciiPadded('EG800Z_TEST', 32))]))) }
					}
					if (b.funcCode === 0x03) return { frame: tag66Frame }
					return { tag11: 0, frame: { dir: 'up' } }
				},
			},
		}

		const { elements, listeners } = createPanelHarness({ panelWin })
		await listeners['sk-esim-refresh:click']()

		// 管理员视图默认展示全部 3 张卡 + runtimeFlags + cacheAge + ID3 摘要
		assert.equal(elements['sk-esim-profile-count'].textContent, '3')
		assert.equal(elements['sk-esim-cache-age'].textContent, '12s 前')
		assert.ok(elements['sk-esim-runtime-flags'].childNodes.some((n) => n.textContent.includes('缓存已就绪')))
		assert.ok(elements['sk-esim-runtime-flags'].childNodes.some((n) => n.textContent.includes('保活')))
		assert.equal(elements['sk-esim-ntf-total'].textContent, '2')
		assert.equal(elements['sk-esim-ntf-del'].textContent, '1')
		assert.equal(elements['sk-esim-ntf-other'].textContent, '1')
		assert.equal(elements['sk-esim-ntf-head-event'].textContent, '删除')
		assert.ok(elements['sk-esim-ntf-head-iccid'].textContent.includes('89860333333333333333'))
		assert.ok(elements['sk-esim-ntf-head-iccid'].textContent.includes('中国电信'))
		assert.equal(elements['sk-esim-ntf-section'].hidden, false)

		// 在管理员视图点第 3 张卡的「保存策略」-> 发送 Tag66-ID7 op=0 并刷新
		const row3 = elements['sk-esim-profile-list'].childNodes[2]
		const row3Buttons = row3.querySelectorAll('button')
		const savePolicyBtn = row3Buttons.find((b) => b.textContent === '保存策略')
		assert.ok(savePolicyBtn, '管理员视图每张卡必须提供「保存策略」按钮')
		sentReqs.length = 0
		await savePolicyBtn._listeners.click()
		assert.equal(sentReqs[0].fc, 0x01)
		assert.equal(sentReqs[0].tag, 66)
		assert.equal(sentReqs[0].id, 7)
		assert.equal(sentReqs[0].val.length, 22)
		assert.equal(sentReqs[0].val[0], 0)
		assert.equal(sentReqs[0].val[21], 0x01, '第 3 张卡原带 LOCK_DELETE(bit0)')
		assert.equal(sentReqs[1].fc, 0x03, 'ID7 同步写入成功后应立即刷新 Tag66')

		// 管理员视图点「清空全部策略」-> 发送 Tag66-ID7 op=1
		sentReqs.length = 0
		await listeners['sk-esim-policy-clear:click']()
		assert.equal(sentReqs[0].id, 7)
		assert.equal(sentReqs[0].val[0], 1)
		assert.equal(sentReqs[0].val[21], 0)

		// 管理员视图点「同步通知 (ID6 op=1)」-> 发 ID6 op=1 + 走 XFER target=0x03 + 轮询 ID2
		sentReqs.length = 0
		await listeners['sk-esim-ntf-sync:click']()
		assert.equal(sentReqs[0].fc, 0x01)
		assert.equal(sentReqs[0].tag, 66)
		assert.equal(sentReqs[0].id, 6)
		assert.deepEqual(Array.from(sentReqs[0].val), [1])
		assert.equal(ntfCursor, 2, '应拉取 1 条通知并提交空哨兵收口')

		// 管理员视图点「强清死通知 (ID6 op=2)」-> 必须弹窗二次确认，再发 ID6 op=2
		confirmCalls.length = 0
		sentReqs.length = 0
		await listeners['sk-esim-ntf-purge:click']()
		assert.equal(confirmCalls.length, 2, 'ID6 op=2 必须执行二次确认')
		assert.equal(sentReqs[0].id, 6)
		assert.deepEqual(Array.from(sentReqs[0].val), [2])

		// 切换到客户视图：隐藏禁用隐藏卡(#2)、脱敏启用隐藏卡(#1)无按钮、隐藏通知管理与策略入口
		listeners['sk-esim-view-customer:click']()
		assert.equal(elements['sk-esim-ntf-section'].hidden, true, '客户视图必须隐藏通知摘要与强清入口')
		assert.equal(elements['sk-esim-policy-clear'].hidden, true, '客户视图必须隐藏清空策略按钮')
		assert.equal(elements['sk-esim-profile-count'].textContent, '2', '客户视图隐藏禁用态隐藏卡后应剩 2 张')
		const custRows = elements['sk-esim-profile-list'].childNodes
		const maskedText = JSON.stringify(custRows[0])
		assert.ok(maskedText.includes('内置默认通信通道') && maskedText.includes('使用中'))
		assert.ok(!maskedText.includes('89860011111111111111'), '客户视图脱敏卡不得暴露隐藏 ICCID')
		assert.equal(custRows[0].querySelectorAll('button').length, 0, '客户视图脱敏卡不得提供删/禁/启按钮')
		const custRow2Btns = custRows[1].querySelectorAll('button')
		assert.ok(!custRow2Btns.some((b) => b.textContent === '删除'), '客户视图下带 LOCK_DELETE 的卡应隐藏删除按钮')
		assert.ok(!custRow2Btns.some((b) => b.textContent === '保存策略'), '客户视图不得提供策略编辑')
		assert.equal(custRow2Btns.find((b) => b.textContent === '启用').disabled, true, '当前启用卡带 LOCK_DISABLE 时客户视图应禁用其他卡的启用按钮')
	}
}

runAsyncTests().then(() => {
	console.log('esim.cjs OK')
}).catch((err) => {
	console.error(err)
	process.exit(1)
})
