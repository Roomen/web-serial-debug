// Run: node tests/protocol-downlink-time.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const window = {
	_protocols: {},
	_activeProtocol: 'sek',
	registerProtocol(id, impl) {
		window._protocols[id] = impl
	},
	getActiveProtocol() {
		return window._protocols[window._activeProtocol] || null
	},
}

const context = vm.createContext({
	window,
	Uint8Array,
	document: {
		getElementById() { return null },
		createElement() { return {} },
	},
	localStorage: {
		getItem() { return null },
		setItem() {},
	},
})

// 加载协议文件
const files = ['protocol-schema', 'protocol-crypto', 'parse-view', 'protocol', 'cjt188-protocol']
for (const f of files) {
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8'), context)
}

// 模拟 common.js 中的协议注册与分发
window.registerProtocol('sek', {
	name: 'SEK',
	parseFrame: window.skParseFrame,
	buildDownFrame: window.skBuildDownFrame,
	updateFrameTime: window.skUpdateFrameTime,
})
window.registerProtocol('cjt188', {
	name: '188协议',
	parseFrame: window.cjt188ParseFrame,
	buildDownFrame: window.cjt188BuildDownFrame,
	updateFrameTime: window.cjt188UpdateFrameTime,
})

function updateDownlinkFrameTime(bytes, now) {
	if (!bytes || bytes.length < 5) return false
	const active = window.getActiveProtocol && window.getActiveProtocol()
	if (active && typeof active.updateFrameTime === 'function') {
		try {
			if (active.updateFrameTime(bytes, now)) return true
		} catch (_) {}
	}
	if (window._protocols) {
		for (const id in window._protocols) {
			const p = window._protocols[id]
			if (p && p !== active && typeof p.updateFrameTime === 'function') {
				try {
					if (p.updateFrameTime(bytes, now)) return true
				} catch (_) {}
			}
		}
	}
	return false
}

// 1. SEK 协议测试
{
	const oldDate = new Date(2020, 0, 1, 12, 0, 0)
	const newDate = new Date(2026, 10, 17, 15, 30, 45)

	// 1.1 普通下行帧 (例如 funcCode=0x03 查询)
	const frame = window.skBuildDownFrame({
		funcCode: '0x03',
		version: 2,
		time: oldDate,
		frameSeq: 1,
		tlv: [{ tag: 1, items: [{ id: 1, value: [0x01] }] }],
	})

	const parsedOld = window.skParseFrame(frame)
	assert.equal(parsedOld.crcOk, true)

	// 更新时间
	const updated = updateDownlinkFrameTime(frame, newDate)
	assert.equal(updated, true)

	const parsedNew = window.skParseFrame(frame)
	assert.equal(parsedNew.crcOk, true, '更新时间后 CRC 必须正确')
	// 验证时间字段 (平台时间)
	const timeField = parsedNew.fields['平台时间']
	assert.ok(timeField.includes('2026') && timeField.includes('11') && timeField.includes('17'), '平台时间已更新为新时间')

	// 1.2 带 Tag3-ID20 (水表实时时间) 的下行帧
	const frameWithClock = window.skBuildDownFrame({
		funcCode: '0x01',
		version: 2,
		time: oldDate,
		frameSeq: 2,
		tlv: [{ tag: 3, items: [{ id: 20, value: [0x20, 0x20, 0x01, 0x01, 0x12, 0x00, 0x00] }] }],
	})
	assert.equal(window.skParseFrame(frameWithClock).crcOk, true)

	assert.equal(updateDownlinkFrameTime(frameWithClock, newDate), true)
	const parsedClock = window.skParseFrame(frameWithClock)
	assert.equal(parsedClock.crcOk, true)
	// 验证 TLV 内部的水表时间也更新了
	const tag3 = parsedClock.tlv.find(t => t.tag === 3)
	assert.ok(tag3, 'Tag 3 存在')
	const item20 = tag3.items.find(it => it.id === 20)
	assert.ok(item20, 'Item 20 存在')
	assert.deepEqual(Array.from(item20.raw), [0x20, 0x26, 0x11, 0x17, 0x15, 0x30, 0x45])

	// 1.3 上行帧不应该被修改
	// 伪造一个 SEK 上行帧头
	const fakeUpFrame = new Uint8Array(27)
	fakeUpFrame[0] = 0xA9
	fakeUpFrame[1] = 0x9A
	fakeUpFrame[12] = 0x81 // 上行功能码
	fakeUpFrame[26] = 0x16
	assert.equal(window.skUpdateFrameTime(fakeUpFrame, newDate), false, '上行帧不可被当作下行帧修改')
}

// 2. CJ/T 188 协议测试
{
	const oldDate = new Date(2020, 0, 1, 12, 0, 0)
	const newDate = new Date(2026, 10, 17, 15, 30, 45)

	// 2.1 写标准时间帧 (cmd 0x04, time)
	const frame188 = window.cjt188BuildDownFrame({
		cmd: 0x04,
		addr: '12345678901234',
		time: oldDate,
		preamble: true,
	})

	const parsed188Old = window.cjt188ParseFrame(frame188.subarray(3)) // 剥除 FE FE FE
	assert.equal(parsed188Old.csOk, true)
	assert.equal(parsed188Old.endOk, true)

	// 更新时间
	const updated188 = updateDownlinkFrameTime(frame188, newDate)
	assert.equal(updated188, true)

	const parsed188New = window.cjt188ParseFrame(frame188.subarray(3))
	assert.equal(parsed188New.csOk, true, '更新时间后 CS 校验必须正确')
	assert.equal(parsed188New.endOk, true)
	assert.ok(parsed188New.decoded.includes('2026-11-17 15:30:45'), '解析内容包含最新时间')

	// 2.2 其它非时间下行帧 (例如 读数据 0x01)
	const readFrame = window.cjt188BuildDownFrame({
		cmd: 0x01,
		addr: '12345678901234',
		preamble: true,
	})
	const copyRead = new Uint8Array(readFrame)
	assert.equal(updateDownlinkFrameTime(readFrame, newDate), false, '非时间下行帧不应匹配更新')
	assert.deepEqual(readFrame, copyRead, '内容不应被篡改')
}

// 3. 跨协议识别测试
{
	const newDate = new Date(2026, 10, 17, 15, 30, 45)
	// 当前协议为 cjt188 时，发送 SEK 帧也能识别并更新
	window._activeProtocol = 'cjt188'
	const sekFrame = window.skBuildDownFrame({
		funcCode: '0x03',
		version: 2,
		time: new Date(2019, 0, 1, 0, 0, 0),
		frameSeq: 5,
	})
	assert.equal(updateDownlinkFrameTime(sekFrame, newDate), true)
	assert.equal(window.skParseFrame(sekFrame).crcOk, true)

	// 当前协议为 sek 时，发送 188 帧也能识别并更新
	window._activeProtocol = 'sek'
	const frame188 = window.cjt188BuildDownFrame({
		cmd: 0x04,
		addr: '12345678901234',
		time: new Date(2019, 0, 1, 0, 0, 0),
		preamble: false,
	})
	assert.equal(updateDownlinkFrameTime(frame188, newDate), true)
	assert.equal(window.cjt188ParseFrame(frame188).csOk, true)
}

console.log('All protocol downlink time tests passed successfully!')
