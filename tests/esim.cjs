// Run: node tests/esim.cjs — synthetic data only.
// 覆盖: SEK Tag=66 / Tag=10 ID=66 编解码与 logView 脱敏、profile_class 反转与位域解码、
// ID4 模组码/时间戳解析、Profile 防误操作校验、ZMODEM 停等 CRC32 环回、mode=1 四轮 ES9+ 状态机(HTTP 200/204/CAN*5)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const Zmodem = require('../js/zmodem.js')
const EsimCore = require('../js/esim-core.js')

// 加载 SEK 协议脚本做帧编解码与 logView 回归
const window = { registerProtocol() {} }
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

function sekUp(fc, tlv) {
	const head = [
		0xA9, 0x9A, 0x11, 0x00, 0x02, 0x01, 0x10,
		0x00, 0x12, 0x34, 0x56, 0x78, 0x90, 0x12,
		0x9C, 0xFF, 0x0A, 0x00, 0x00, 0x1A, fc, 0x00,
	]
	const data = [tlv.length & 255, tlv.length >> 8].concat(tlv)
	const f = head.concat([data.length & 255, data.length >> 8]).concat(data)
	const c = window.skCrc16(Uint8Array.from(f))
	return Uint8Array.from(f.concat([c & 255, c >> 8, 0x16]))
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
	const parsed = window.skParseFrame(up)
	assert.equal(parsed.ok, true)
	assert.equal(parsed.tlv.length, 1)
	assert.equal(parsed.tlv[0].tag, 66)
	assert.equal(parsed.tlv[0].name, 'eSIM管理')
	assert.equal(parsed.tlv[0].items.length, 3)

	assert.equal(parsed.tlv[0].items[0].decoded, '89049032000000000000000012345678')
	assert.ok(parsed.tlv[0].items[1].decoded.includes('89860011223344556677'))
	assert.ok(parsed.tlv[0].items[1].decoded.includes('启用,运营'))
	assert.ok(parsed.tlv[0].items[1].decoded.includes('禁用,预置/引导,禁删PPR'))
	assert.ok(parsed.tlv[0].items[2].decoded.includes('失败'))
	assert.ok(parsed.tlv[0].items[2].decoded.includes('0x8500090C'))
	assert.ok(parsed.tlv[0].items[2].decoded.includes('2026-11-24 19:30:00'))

	const lv = window.skLogView(parsed)
	assert.ok(lv && lv.sections.length === 1)
	assert.equal(lv.sections[0].title, 'Tag66 eSIM管理')
	assert.equal(lv.sections[0].pairs.length, 3)

	// 结构化解码器测试（严格 12B：含空闲全 0 时间戳与 9B 截断拒绝）
	assert.equal(EsimCore.decodeEid(new Uint8Array(16)).ready, false)
	const st = EsimCore.decodeStatus(id4Val)
	assert.equal(st.state, 3)
	assert.equal(st.failStage, 6)
	assert.equal(st.moduleErrCode, 0x090C)
	assert.equal(st.qesimFullCode, '0x8500090C')
	assert.equal(st.timeText, '2026-11-24 19:30:00')
	assert.ok(st.errHint.length > 0)

	const id4Idle = [0, 0, 0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
	const upIdle = sekUp(0x83, tlvBlock(66, [[4].concat(id4Idle)]))
	const parsedIdle = window.skParseFrame(upIdle)
	assert.equal(parsedIdle.ok, true)
	assert.equal(parsedIdle.tlv[0].items.length, 1, '全0空闲12B ID4不得误判为9B把末尾3B拆成伪ID')
	assert.equal(parsedIdle.tlv[0].items[0].raw.length, 12)
	const stIdle = EsimCore.decodeStatus(id4Idle)
	assert.equal(stIdle.state, 0)
	assert.equal(stIdle.timeText, '')

	// 9B 截断 ID4 必须判不完整 / 返回 null
	assert.equal(EsimCore.decodeStatus([3, 2, 6, 0x0C, 0x09, 0x00, 0x00, 0x00, 0x00]), null)
	const upTrunc = sekUp(0x83, tlvBlock(66, [[4, 3, 2, 6, 0x0C, 0x09, 0x00, 0x00, 0x00, 0x00]]))
	const parsedTrunc = window.skParseFrame(upTrunc)
	assert.equal(parsedTrunc.tlv[0].items[0].partial, true)
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
}

runAsyncTests().then(() => {
	console.log('esim.cjs OK')
}).catch((err) => {
	console.error(err)
	process.exit(1)
})
