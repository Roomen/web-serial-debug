// Run: node tests/ac6d-protocol.cjs — synthetic data only.
// 覆盖: AC6D 容积式电子水表协议引擎（js/ac6d-protocol.js）全指令编解码往返、V2.7(40B)/旧固件(48B/24B)双向自适应、
// A99A 透传与模组信息解析、流式粘包/拆包、16B OTA 固件头校验封装、三锚点校准算法、SK-CALIB-BIND v4 导出与 ProtocolRegistry 接入。
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const P = require('../js/ac6d-protocol.js')
const ProtocolRegistryMod = require('../js/protocol-registry.js')
const DeviceModel = require('../js/device-model.js')

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

function packU16(v) { return [v & 0xff, (v >> 8) & 0xff] }
function packI16(v) { const n = (v | 0) & 0xffff; return [n & 0xff, (n >> 8) & 0xff] }
function packU32(v) { const u = v >>> 0; return [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff] }
function packU64(v) {
	let bi = BigInt(v)
	const out = []
	for (let i = 0; i < 8; i++) { out.push(Number(bi & 0xffn)); bi >>= 8n }
	return out
}
function asciiPad(str, len) {
	const out = new Array(len).fill(0)
	for (let i = 0; i < Math.min(str.length, len); i++) out[i] = str.charCodeAt(i) & 0xff
	return out
}
function makeRspFrame(seq, cmd, status, addr, data) {
	const pkt = [cmd & 0xff, status & 0xff]
	if (addr != null) pkt.push(...packU32(addr))
	if (data && data.length) pkt.push(...data)
	return P.buildFrame(seq, Uint8Array.from(pkt))
}
function makeA99aUplink(func, dataDomain, opts) {
	const o = opts || {}
	const seq = o.seq != null ? o.seq : 7
	const devCodeBytes = o.devCodeBytes || [0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]
	const rsrp = o.rsrp != null ? o.rsrp : -850
	const snr = o.snr != null ? o.snr : 120
	const cov = o.coverage != null ? o.coverage : 1
	const csq = o.csq != null ? o.csq : 24
	const body = Uint8Array.from([
		0xa9, 0x9a,
		...packU16(seq),
		0x02, // ver
		0x01, // vendor
		0x10, // devType
		...devCodeBytes,
		...packI16(rsrp),
		...packI16(snr),
		cov,
		csq,
		func & 0xff,
		0x00,
		...packU16(dataDomain.length),
		...dataDomain,
	])
	const crc = P.crc16(body)
	return Uint8Array.from([...body, ...packU16(crc), 0x16])
}

// ---- 1. CRC16 标准向量与时间/UID/HEX 基础工具 ----
test('crc16 standard vector & BCD / UID / hex helpers', () => {
	const vec = Uint8Array.from('123456789', (c) => c.charCodeAt(0))
	assert.equal(P.crc16(vec), 0x29b1)

	const d = new Date(2026, 10, 27, 15, 30, 45)
	const bcd = P.dateToBcd7(d)
	assert.deepEqual(Array.from(bcd), [0x20, 0x26, 0x11, 0x27, 0x15, 0x30, 0x45])
	assert.equal(P.bcdToDateStr(bcd), '2026-11-27 15:30:45')
	assert.equal(P.bcdToDateStr([0x26, 0x11, 0x27, 0x08, 0x09, 0x10]), '2026-11-27 08:09:10')
	assert.equal(P.sensorTimeToStr([0x26, 0x11, 0x27, 0x12, 0x34, 0x56, 0x05, 0x00]), '2026-11-27 12:34:56')

	// UID 7B -> onlyAddr[3..6] uint32 LE
	const uid = Uint8Array.from([0x11, 0x22, 0x33, 0x78, 0x56, 0x34, 0x12])
	assert.equal(P.uidBytesToAuthCode(uid), 0x12345678)
	assert.equal(P.uidBytesToAuthCode('11223378563412'), 0x12345678)
	assert.equal(P.uidBytesToAuthCode('112233'), null)
	assert.equal(P.uidBytesToAuthCode('11223300000000'), null)

	assert.equal(P.bytesToHex([0xac, 0x6d, 0x01], true), 'AC 6D 01')
	assert.equal(P.bytesToHex([0xac, 0x6d, 0x01], false), 'AC6D01')
	assert.deepEqual(Array.from(P.hexToBytes('ac 6d 01')), [0xac, 0x6d, 0x01])
	assert.equal(P.hexToBytes('ZZ'), null)
})

// ---- 2. OTA 指令集 0x20 / 0x24 / 0x22 / 0x25 (Format A & B) / 0x26 ----
test('OTA commands 0x20, 0x24, 0x22, 0x25 (A & B), 0x26 round-trip', () => {
	// 0x20 HANDSHAKE
	const req20 = P.builders.handshake({ seq: 1 })
	const pReq20 = P.parseFrame(req20)
	assert.equal(pReq20.ok, true)
	assert.equal(pReq20.dir, 'req')
	assert.equal(pReq20.cmd, 0x20)
	assert.equal(pReq20.addr, 0)

	const verData = asciiPad('FW_V3.1.0', 16)
	const rsp20NoAddr = P.parseFrame(makeRspFrame(1, 0x20, 0x00, null, verData))
	assert.equal(rsp20NoAddr.detail.firmwareVersion, 'FW_V3.1.0')
	const rsp20WithAddr = P.parseFrame(makeRspFrame(1, 0x20, 0x00, 0, verData))
	assert.equal(rsp20WithAddr.detail.firmwareVersion, 'FW_V3.1.0')

	// 0x24 OTA_ERASE
	const req24 = P.builders.otaErase(0x8000, 0x6000, { seq: 2 })
	const pReq24 = P.parseFrame(req24)
	assert.equal(pReq24.cmd, 0x24)
	assert.equal(pReq24.detail.targetAddr, 0x8000)
	assert.equal(pReq24.detail.eraseSize, 0x6000)
	const rsp24 = P.parseFrame(makeRspFrame(2, 0x24, 0x00, 0x8000, []))
	assert.equal(rsp24.typeOrStatus, 0x00)

	// 0x22 OTA_DATA
	const chunk = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
	const req22 = P.builders.otaData(0x8100, chunk, { seq: 3 })
	const pReq22 = P.parseFrame(req22)
	assert.equal(pReq22.typeOrStatus, 0x12)
	assert.equal(pReq22.detail.targetAddr, 0x8100)
	assert.equal(pReq22.detail.chunkSize, 8)
	assert.deepEqual(Array.from(pReq22.data), Array.from(chunk))

	// 0x25 OTA_CRC: Format A vs Format B
	const req25 = P.builders.otaCrc(0x8000, 0x1200, { seq: 4 })
	const pReq25 = P.parseFrame(req25)
	assert.equal(pReq25.detail.startAddr, 0x8000)
	assert.equal(pReq25.detail.length, 0x1200)

	// Format B: ADDR=0x00008000 + CRC=0x4892 (raw: 00 80 00 00 92 48)
	const rsp25FmtB = makeRspFrame(4, 0x25, 0x00, 0x8000, [0x92, 0x48])
	const pFmtB = P.parseFrame(rsp25FmtB, { crcReqAddr: 0x8000 })
	assert.equal(pFmtB.detail.crcValue, 0x4892)
	assert.equal(pFmtB.detail.crcFormat, 'B')
	// Heuristic without explicit crcReqAddr when addr === 0x8000
	const pFmtBAuto = P.parseFrame(rsp25FmtB)
	assert.equal(pFmtBAuto.detail.crcValue, 0x4892)

	// Format A: CRC at raw[0..1] (e.g. A2 16 00 00 FC 56 -> 0x16A2)
	const rsp25FmtA = makeRspFrame(4, 0x25, 0x00, null, [0xa2, 0x16, 0x00, 0x00, 0xfc, 0x56])
	const pFmtA = P.parseFrame(rsp25FmtA, { crcReqAddr: 0x8000 })
	assert.equal(pFmtA.detail.crcValue, 0x16a2)
	assert.equal(pFmtA.detail.crcFormat, 'A')

	// 0x26 OTA_FINISH
	const req26 = P.builders.otaFinish(0x3456, 0x9abc, { seq: 5 })
	const pReq26 = P.parseFrame(req26)
	assert.equal(pReq26.detail.totalSize, 0x3456)
	assert.equal(pReq26.detail.totalCrc, 0x9abc)
})

// ---- 3. 核心流量与设备指令 0x30 / 0x31 / 0x32 / 0x33 / 0x34 / 0x35 / 0x36 / 0x37 / 0x3F ----
test('Core commands 0x30..0x37 and 0x3F round-trip', () => {
	// 0x30 FLOW_FAST: 唯一无 ADDR，严格 10B 请求帧
	const req30 = P.builders.flowFast({ seq: 0x11 })
	assert.equal(req30.length, 10)
	assert.equal(req30[4], 0x02)
	assert.equal(req30[5], 0x00)
	const pReq30 = P.parseFrame(req30)
	assert.equal(pReq30.hasAddr, false)
	assert.equal(pReq30.cmd, 0x30)

	// 0x30 应答 (21B) + 4倍频象限余数 3 + 低电压/磁干扰报警
	const data30 = [
		0x02, // mode = 校表
		...packU64(123456000), // pos uL
		...packU64(456000),    // rev uL
		...packU16(25000),     // 2.5000 m³/h = 2500.0 L/h
		(3 << 4) | 0x01,       // flowing + fwd + quadRemainder=3
		0x03,                  // low voltage + magnetic
	]
	const rsp30 = makeRspFrame(0x11, 0x30, 0x00, null, data30)
	const pRsp30 = P.parseFrame(rsp30, { meterPulseEq: 17085 })
	assert.equal(pRsp30.ok, true)
	assert.equal(pRsp30.detail.mode, 2)
	assert.equal(pRsp30.detail.modeText, '校表')
	assert.equal(pRsp30.detail.posVolumeUl, 123456000)
	assert.equal(pRsp30.detail.revVolumeUl, 456000)
	assert.equal(pRsp30.detail.netVolumeUl, 123000000)
	assert.equal(pRsp30.detail.flowRateM3h, 2.5)
	assert.equal(pRsp30.detail.flowRateLph, 2500)
	assert.equal(pRsp30.detail.isFlowing, true)
	assert.equal(pRsp30.detail.isReverse, false)
	assert.equal(pRsp30.detail.quadRemainder, 3)
	assert.deepEqual(pRsp30.detail.alarms, ['低电压', '磁干扰'])
	assert.equal(pRsp30.detail.posVolumeInterpUl, 123456000 + Math.floor(17085 * 3 / 4))

	// 0x31 FLOW_QUERY (req with time sync + 51B rsp both with & without ADDR)
	const now = new Date(2026, 10, 27, 10, 20, 30)
	const req31 = P.builders.flowQuery(true, { seq: 0x0b, now })
	const pReq31 = P.parseFrame(req31)
	assert.equal(pReq31.detail.withTimeSync, true)
	assert.equal(pReq31.detail.syncTime, '2026-11-27 10:20:30')

	const data31 = [
		...packU64(500),       // posPulse
		...packU64(12),        // revPulse
		...packU64(8542500),   // posVol
		...packU64(205020),    // revVol
		...packU16(1234),      // 0.1234 m³/h = 123.4 L/h
		0x01,                  // mode=快速响应
		0xfb,                  // temp = -5°C (int8)
		...packU16(365),       // 3.65V
		...packU16(60000),     // pulseEqUl
		(2 << 4) | 0x03,       // flowing + reverse + quad=2
		0x04,                  // crystal alarm
		...packU16(450),       // pulseIntervalMs
		...P.dateToBcd7(now),  // 7B BCD
	]
	assert.equal(data31.length, 51)
	for (const addrOpt of [0, null]) {
		const pRsp31 = P.parseFrame(makeRspFrame(0x0b, 0x31, 0x00, addrOpt, data31))
		assert.equal(pRsp31.ok, true)
		assert.equal(pRsp31.detail.posPulse, 500)
		assert.equal(pRsp31.detail.revPulse, 12)
		assert.equal(pRsp31.detail.temperatureC, -5)
		assert.equal(pRsp31.detail.voltageV, 3.65)
		assert.equal(pRsp31.detail.pulseEqUl, 60000)
		assert.equal(pRsp31.detail.isReverse, true)
		assert.equal(pRsp31.detail.quadRemainder, 2)
		assert.deepEqual(pRsp31.detail.alarms, ['晶振失效'])
		assert.equal(pRsp31.detail.pulseIntervalMs, 450)
		assert.equal(pRsp31.detail.deviceTime, '2026-11-27 10:20:30')
	}

	// 0x32 ALARM_CLEAR
	const req32 = P.builders.alarmClear(0x03, 0x12345678, { seq: 0x0e })
	const pReq32 = P.parseFrame(req32)
	assert.equal(pReq32.addr, 0x12345678)
	assert.equal(pReq32.detail.mask, 0x03)
	assert.deepEqual(pReq32.detail.alarms, ['低电压', '磁干扰'])

	// 0x33 DEV_INFO (51B + authCode extraction)
	const req33 = P.builders.devInfo(true, { seq: 0x07, now })
	assert.equal(P.parseFrame(req33).detail.withTimeSync, true)
	const uidBytes = [0xaa, 0xbb, 0xcc, 0x78, 0x56, 0x34, 0x12]
	const data33 = [
		...uidBytes,
		...asciiPad('V3.1.2-AC6D', 16),
		24,                      // 24°C
		...packU16(361),         // 3.61V
		0x08,                    // Flash失败
		0x26, 0x11, 0x27, 0x10, 0x20, 0x30, 0x05, 0x00, // 8B sensor time
		0x02,                    // mode=校表
		...packU16(3),           // powerResetCount
		...packU16(1),           // wdtResetCount
		...packU32(86400),       // totalRunTimeSec
		...packU32(3600),        // activeRunTimeSec
		0x00, 0x00, 0x00,        // reserved
	]
	assert.equal(data33.length, 51)
	for (const addrOpt of [0, null]) {
		const pRsp33 = P.parseFrame(makeRspFrame(0x07, 0x33, 0x00, addrOpt, data33))
		assert.equal(pRsp33.detail.onlyAddrHex, 'AABBCC78563412')
		assert.equal(pRsp33.detail.authCode, 0x12345678)
		assert.equal(pRsp33.detail.firmwareVersion, 'V3.1.2-AC6D')
		assert.equal(pRsp33.detail.temperatureC, 24)
		assert.equal(pRsp33.detail.voltageV, 3.61)
		assert.deepEqual(pRsp33.detail.alarms, ['Flash失败'])
		assert.equal(pRsp33.detail.sensorTime, '2026-11-27 10:20:30')
		assert.equal(pRsp33.detail.mode, 2)
		assert.equal(pRsp33.detail.powerResetCount, 3)
		assert.equal(pRsp33.detail.wdtResetCount, 1)
		assert.equal(pRsp33.detail.totalRunTimeSec, 86400)
		assert.equal(pRsp33.detail.activeRunTimeSec, 3600)
	}

	// 0x34 TIME_SYNC
	const req34 = P.builders.timeSync(now, 0, { seq: 0x09 })
	const pReq34 = P.parseFrame(req34)
	assert.equal(pReq34.typeOrStatus, 0x12)
	assert.equal(pReq34.detail.syncTime, '2026-11-27 10:20:30')
	const pRsp34 = P.parseFrame(makeRspFrame(0x09, 0x34, 0x00, 0, Array.from(P.dateToBcd7(now))))
	assert.equal(pRsp34.detail.deviceTime, '2026-11-27 10:20:30')

	// 0x35 MODE_SET: mode 0/1 addr=0, mode 2 addr=authCode
	assert.equal(P.parseFrame(P.builders.modeSet(0, 0x12345678, { seq: 1 })).addr, 0)
	assert.equal(P.parseFrame(P.builders.modeSet(1, 0x12345678, { seq: 2 })).addr, 0)
	assert.equal(P.parseFrame(P.builders.modeSet(2, 0x12345678, { seq: 3 })).addr, 0x12345678)
	const pRsp35Already = P.parseFrame(makeRspFrame(3, 0x35, 0x08, 0, [0x02]))
	assert.equal(pRsp35Already.typeOrStatus, 0x08)
	assert.equal(pRsp35Already.detail.mode, 2)

	// 0x36 AUTH_BYPASS
	const req36 = P.builders.authBypass(0xdeadbeef, { seq: 0x0f })
	assert.equal(P.parseFrame(req36).detail.bypassVal, 0xdeadbeef)
	const pRsp36 = P.parseFrame(makeRspFrame(0x0f, 0x36, 0x00, null, packU32(0xdeadbeef)))
	assert.equal(pRsp36.detail.bypassVal, 0xdeadbeef)

	// 0x37 DAILY_FREEZE (32B entries with real CRC16 over 0..27)
	const req37 = P.builders.dailyFreeze(15, { seq: 0x12 })
	assert.equal(P.parseFrame(req37).detail.startIndex, 15)
	const entry1Body = [
		...packU16(0x5a5a),
		...packU16(1),
		0x20, 0x26, 0x11, 0x26,
		...packU32(12345), // 123.45 L
		...packU32(45),    // 0.45 L
		...packU32(12390), // 123.90 L
		...packU16(15000), // 1.5000 m³/h
		...packI16(-25),   // -2.5 °C
		0x01,              // low voltage
		0x00, 0x00, 0x00,
	]
	const entry1 = [...entry1Body, ...packU16(P.crc16(Uint8Array.from(entry1Body))), 0x00, 0x00]
	assert.equal(entry1.length, 32)
	const rsp37 = makeRspFrame(0x12, 0x37, 0x00, 0, [...packU16(62), ...packU16(1), ...entry1])
	const pRsp37 = P.parseFrame(rsp37)
	assert.equal(pRsp37.detail.totalCount, 62)
	assert.equal(pRsp37.detail.batchCount, 1)
	assert.equal(pRsp37.detail.entries.length, 1)
	assert.equal(pRsp37.detail.entries[0].magicOk, true)
	assert.equal(pRsp37.detail.entries[0].crcOk, true)
	assert.equal(pRsp37.detail.entries[0].valid, true)
	assert.equal(pRsp37.detail.entries[0].date, '2026-11-26')
	assert.equal(pRsp37.detail.entries[0].cumulativeL, 123.45)
	assert.equal(pRsp37.detail.entries[0].temperatureC, -2.5)
	assert.deepEqual(pRsp37.detail.entries[0].alarms, ['低电压'])

	// 0x3F INIT_REPORT
	const data3f = [0x01, ...asciiPad('FW_INIT', 16), ...P.dateToBcd7(now), 2, 1, 0]
	const pRsp3f = P.parseFrame(makeRspFrame(1, 0x3f, 0x00, 0, data3f))
	assert.equal(pRsp3f.detail.firmwareVersion, 'FW_INIT')
	assert.equal(pRsp3f.detail.powerResetCount, 2)
})

// ---- 4. 校准表 0x40 / 0x41 ----
test('CALIB_READ (192B & 176B) and CALIB_WRITE (all 176B & single 6B)', () => {
	const calibObj = {
		meterPulseEq: 17085,
		calibPulseEq: 1000,
		commPulseEq: 60000,
		fwdCount: 18,
		revCount: 16,
		fwdPoints: Array.from({ length: 20 }, (_, i) => (i + 1) * 100),
		fwdCoeffs: Array.from({ length: 20 }, (_, i) => 10000 + i * 5),
		revPoints: Array.from({ length: 20 }, (_, i) => (i + 1) * 110),
		revCoeffs: Array.from({ length: 20 }, (_, i) => 9950 + i * 3),
	}

	const req41All = P.builders.calibWriteAll(calibObj, 0x12345678, { seq: 0x21 })
	const pReq41All = P.parseFrame(req41All)
	assert.equal(pReq41All.ok, true)
	assert.equal(pReq41All.addr, 0x12345678)
	assert.equal(pReq41All.data.length, 176)
	assert.equal(pReq41All.detail.meterPulseEq, 17085)
	assert.equal(pReq41All.detail.fwdCount, 18)
	assert.equal(pReq41All.detail.revCount, 16)
	assert.equal(pReq41All.detail.fwdPoints[5], 600)
	assert.equal(pReq41All.detail.revCoeffs[10], 9980)

	// 192B CALIB_READ 应答 (带 0xAA55AA55 魔数 + 8B 尾部)
	const cal192 = [
		...packU32(0xaa55aa55),
		...packU32(12),
		...pReq41All.data,
		0, 0, 0, 0, 0, 0,
		...packU16(0x7788),
	]
	assert.equal(cal192.length, 192)
	const pRsp40 = P.parseFrame(makeRspFrame(0x22, 0x40, 0x00, 0, cal192))
	assert.equal(pRsp40.detail.meterPulseEq, 17085)
	assert.equal(pRsp40.detail.commPulseEq, 60000)
	assert.equal(pRsp40.detail.fwdCoeffs[19], 10095)
	assert.equal(pRsp40.detail.crcHex, '0x7788')

	// 176B 无魔数回退
	const pRsp40Short = P.parseFrame(makeRspFrame(0x22, 0x40, 0x00, 0, Array.from(pReq41All.data)))
	assert.equal(pRsp40Short.detail.meterPulseEq, 17085)
	assert.equal(pRsp40Short.detail.revPoints[0], 110)

	// Single calib write
	const req41Single = P.builders.calibWriteSingle('rev', 4, 10123, 0x12345678, { seq: 0x23 })
	const pSingle = P.parseFrame(req41Single)
	assert.equal(pSingle.detail.writeMode, 'single')
	assert.equal(pSingle.detail.direction, 'rev')
	assert.equal(pSingle.detail.index, 4)
	assert.equal(pSingle.detail.coeff, 10123)
})

// ---- 5. 参数读写 0x42 / 0x43 (V2.7 40B 与 Legacy 48B/24B 双向自适应 + type=1 64B/61B + type=2 35B/36B) ----
test('PARAM_READ/PARAM_WRITE adaptive V2.7 40B & legacy 48B/24B + meter 64B/61B + alarm 35B/36B', () => {
	const baseObj = {
		onlyAddrHex: '01020378563412',
		voltageAlarmV: 3.15,
		sampleIntervalMin: 30,
		baseDegree: 9876543210,
		initFlag: 0x55,
		meterPulseEq: 17085,
		calibPulseEq: 1000,
		commPulseEq: 60000,
		calibEnable: 1,
		calibDirection: 0,
		tempCompCoef: -120,
		tempCompBaseC: 20.5,
	}

	// V2.7 40B write -> simulate 0x42(0) response with same 41B data
	const req43V27 = P.builders.paramWriteBase(baseObj, 0x12345678, { seq: 0x30 })
	const pReq43V27 = P.parseFrame(req43V27)
	assert.equal(pReq43V27.data.length, 41)
	assert.equal(pReq43V27.detail.layout, 'v27-40')
	assert.equal(pReq43V27.detail.base.voltageAlarmV, 3.15)
	assert.equal(pReq43V27.detail.base.tempCompCoef, -120)

	for (const addrOpt of [0, null]) {
		const pRsp42V27 = P.parseFrame(makeRspFrame(0x30, 0x42, 0x00, addrOpt, Array.from(pReq43V27.data)))
		assert.equal(pRsp42V27.detail.paramType, 0)
		assert.equal(pRsp42V27.detail.layout, 'v27-40')
		assert.equal(pRsp42V27.detail.base.onlyAddrHex, '01020378563412')
		assert.equal(pRsp42V27.detail.base.authCode, 0x12345678)
		assert.equal(pRsp42V27.detail.base.baseDegree, 9876543210)
		assert.equal(pRsp42V27.detail.base.meterPulseEq, 17085)
		assert.equal(pRsp42V27.detail.base.tempCompBaseC, 20.5)
	}

	// Legacy 48B write -> simulate 0x42(0) response with same 49B data
	const req43Leg48 = P.builders.paramWriteBase(baseObj, 0x12345678, { seq: 0x31, layout: 'legacy-48' })
	const pReq43Leg48 = P.parseFrame(req43Leg48)
	assert.equal(pReq43Leg48.data.length, 49)
	assert.equal(pReq43Leg48.detail.layout, 'legacy-48')

	for (const addrOpt of [0, null]) {
		const pRsp42Leg48 = P.parseFrame(makeRspFrame(0x31, 0x42, 0x00, addrOpt, Array.from(pReq43Leg48.data)))
		assert.equal(pRsp42Leg48.detail.paramType, 0)
		assert.equal(pRsp42Leg48.detail.layout, 'legacy-48')
		assert.equal(pRsp42Leg48.detail.base.voltageAlarmV, 3.15)
		assert.equal(pRsp42Leg48.detail.base.sampleIntervalMin, 30)
		assert.equal(pRsp42Leg48.detail.base.baseDegree, 9876543210)
		assert.equal(pRsp42Leg48.detail.base.commPulseEq, 60000)
		assert.equal(pRsp42Leg48.detail.base.tempCompCoef, -120)
		assert.equal(pRsp42Leg48.detail.base.tempCompBaseC, 20.5)
	}

	// Legacy 24B write (main.py:4840)
	const req43Leg24 = P.builders.paramWriteBase(baseObj, 0x12345678, { seq: 0x32, layout: 'legacy-24' })
	const pReq43Leg24 = P.parseFrame(req43Leg24)
	assert.equal(pReq43Leg24.data.length, 24)
	assert.equal(pReq43Leg24.detail.layout, 'legacy-24')
	assert.equal(pReq43Leg24.detail.base.meterPulseEq, 17085)

	// type=1 V2.4 64B & V2.3 61B
	const bcdNow = Array.from(P.dateToBcd7(new Date(2026, 10, 27, 9, 8, 7)))
	const meter64 = [
		0xaa, 0x01, 22, 0x01,
		...packU32(99),
		...packU64(500000),
		...packU64(1000),
		...packU64(499000),
		...packU64(30),
		...packU64(1),
		...packU32(7200),
		...packU16(3000),
		...bcdNow,
		0x00,
		...packU16(0x1122),
	]
	assert.equal(meter64.length, 64)
	const pM64 = P.parseFrame(makeRspFrame(0x33, 0x42, 0x00, 0, [0x01, ...meter64]))
	assert.equal(pM64.detail.layout, 'v24-64')
	assert.equal(pM64.detail.meter.devLiveTotalTimeSec, 7200)
	assert.equal(pM64.detail.meter.temperatureC, 22)

	const meter61 = [
		0xaa, 0x01, 21, 0x01,
		...packU32(88),
		...packU64(400000),
		...packU64(0),
		...packU64(400000),
		...packU64(25),
		...packU64(0),
		...packU16(2000),
		...bcdNow,
		0x00, 0x00,
		...packU16(0x3344),
	]
	assert.equal(meter61.length, 61)
	const pM61 = P.parseFrame(makeRspFrame(0x34, 0x42, 0x00, 0, [0x01, ...meter61]))
	assert.equal(pM61.detail.layout, 'v23-61')
	assert.equal(pM61.detail.meter.posVolumeUl, 400000)

	// type=2 V2.7 35B & legacy 36B
	const alarm35 = [
		1, ...bcdNow,
		0, ...bcdNow,
		1, 2, ...bcdNow,
		0, ...bcdNow,
		...packU16(0x5566),
	]
	assert.equal(alarm35.length, 35)
	const pA35 = P.parseFrame(makeRspFrame(0x35, 0x42, 0x00, 0, [0x02, ...alarm35]))
	assert.equal(pA35.detail.layout, 'v27-35')
	assert.equal(pA35.detail.alarm.powerFlag, 1)
	assert.equal(pA35.detail.alarm.memoryType, 2)

	const alarm36 = [...alarm35.slice(0, 33), 0x00, ...packU16(0x7788)]
	const pA36 = P.parseFrame(makeRspFrame(0x36, 0x42, 0x00, 0, [0x02, ...alarm36]))
	assert.equal(pA36.detail.layout, 'legacy-36')
	assert.equal(pA36.detail.alarm.crcHex, '0x7788')
})

// ---- 6. 日志与系统指令 0x44 / 0x45 / 0x46 / 0x47 ----
test('LOG_READ 0x44, RESET 0x45, PARAM_RESET 0x46, BASE_DEGREE 0x47', () => {
	const req44 = P.builders.logRead(0xff, 0x12345678, { seq: 0x40 })
	assert.equal(P.parseFrame(req44).detail.logType, 0xff)

	const t = Array.from(P.dateToBcd7(new Date(2026, 10, 27, 11, 22, 33)))
	const makeLog = (type, payloadBytes) => {
		const pay = new Array(22).fill(0)
		for (let i = 0; i < payloadBytes.length; i++) pay[i] = payloadBytes[i]
		const body = [type, ...t, ...pay]
		return [...body, ...packU16(P.crc16(Uint8Array.from(body)))]
	}
	const rsp44 = makeRspFrame(0x40, 0x44, 0x00, 0, [
		0xff,
		...makeLog(0, [0x01]),
		...makeLog(1, [5]),
		...makeLog(2, [...packU16(0x29b1), ...packU16(12340)]),
		...makeLog(3, [0xff, 0x36]),
		...makeLog(3, [0x32, 0x03]),
		...makeLog(3, [...packU16(295)]),
	])
	const pRsp44 = P.parseFrame(rsp44)
	assert.equal(pRsp44.detail.entries.length, 6)
	assert.match(pRsp44.detail.entries[0].summary, /参数CRC失败/)
	assert.match(pRsp44.detail.entries[1].summary, /5/)
	assert.match(pRsp44.detail.entries[2].summary, /0x29B1/)
	assert.match(pRsp44.detail.entries[3].summary, /自动恢复清除/)
	assert.match(pRsp44.detail.entries[4].summary, /0x32/)
	assert.match(pRsp44.detail.entries[5].summary, /2.95V/)

	const req45 = P.builders.systemReset(0x12345678, { seq: 0x41 })
	assert.equal(P.parseFrame(req45).addr, 0x12345678)

	const req46 = P.builders.paramReset(3, 0x12345678, { seq: 0x42 })
	assert.equal(P.parseFrame(req46).detail.level, 3)

	const bigDeg = 0x0001020304050607n
	const req47 = P.builders.baseDegree(bigDeg, 0x12345678, { seq: 0x43 })
	const pReq47 = P.parseFrame(req47)
	assert.equal(pReq47.detail.baseDegree, Number(bigDeg))
})

// ---- 7. A99A 透传、模组信息与混合流式拆包 ----
test('A99A passthrough, module info uplink & mixed sticky-packet stream parser', () => {
	const innerAc6d = P.builders.flowFast({ seq: 0x55 })
	const wrappedDown = P.wrapPassthrough(innerAc6d, 100, new Date(2026, 10, 27, 12, 0, 0))
	assert.equal(wrappedDown[0], 0xa9)
	assert.equal(wrappedDown[1], 0x9a)
	assert.equal(wrappedDown[wrappedDown.length - 1], 0x16)

	const unwrappedDown = P.unwrapPassthrough(wrappedDown)
	assert.ok(unwrappedDown)
	assert.deepEqual(Array.from(unwrappedDown.payload), Array.from(innerAc6d))

	// 构造真实上行 A99A 透传帧 (func=0x84 at offset 20)
	const rspAc6d = makeRspFrame(0x55, 0x20, 0x00, 0, asciiPad('V3.1', 16))
	const tlvVal = [0x00, ...rspAc6d]
	const tlv = [0x07, ...packU16(tlvVal.length), ...tlvVal]
	const upPassFrame = makeA99aUplink(0x84, [...packU16(tlv.length), ...tlv], { seq: 101 })
	const unwrappedUp = P.unwrapPassthrough(upPassFrame)
	assert.ok(unwrappedUp)
	assert.deepEqual(Array.from(unwrappedUp.payload), Array.from(rspAc6d))

	// A99A 模组信息查询帧 & 上行解析
	const qFrame = P.buildModuleInfoQuery(0x01, 102, new Date(2026, 10, 27, 12, 1, 2))
	assert.equal(qFrame[0], 0xa9)
	assert.equal(qFrame[12], 0x03)
	assert.equal(qFrame[qFrame.length - 1], 0x16)
	assert.equal(P.parseFrame(qFrame).kind, 'a99a-query')

	// 构造 Tag=1 基础数据
	const userNumReversed = Array.from(P.hexToBytes('07500061521103000000')) // reverses to 00000003115261005007
	const devCodeRev = [0x14, 0x13, 0x12, 0x11, 0x10, 0x09, 0x08]
	const tag1Val = [
		0x00, ...asciiPad('861234567890123', 15),
		0x01, ...asciiPad('460041234567890', 15),
		0x02, ...asciiPad('89860412345678901234', 20),
		0x03, ...userNumReversed,
		0x04, ...devCodeRev,
		0x05, ...asciiPad('NB_V2.0', 16),
		0x06, ...P.dateToBcd7(new Date(2026, 10, 27, 12, 2, 3)),
		0x09, ...Array.from(P.hexToBytes('11223344556677889900')),
		0x0a, ...asciiPad('MOD_FW_1.2.3', 32),
		0x0b, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
	]
	const tag1Tlv = [0x01, ...packU16(tag1Val.length), ...tag1Val]
	const infoUplink = makeA99aUplink(0x83, [...packU16(tag1Tlv.length), ...tag1Tlv], {
		seq: 103,
		rsrp: -910,
		snr: 85,
		coverage: 2,
		csq: 19,
	})
	const modInfo = P.parseModuleInfoUplink(infoUplink)
	assert.ok(modInfo && modInfo.ok)
	assert.equal(modInfo.seq, 103)
	assert.deepEqual(modInfo.signal, { rsrp: -910, snr: 85, coverage: 2, csq: 19 })
	assert.equal(modInfo.basic.imei, '861234567890123')
	assert.equal(modInfo.basic.imsi, '460041234567890')
	assert.equal(modInfo.basic.iccid, '89860412345678901234')
	assert.equal(modInfo.basic.userNumber, '00000003115261005007')
	assert.equal(modInfo.basic.deviceCode, '08091011121314')
	assert.equal(modInfo.basic.firmwareVersion, 'NB_V2.0')
	assert.equal(modInfo.basic.deviceTime, '2026-11-27 12:02:03')
	assert.equal(modInfo.basic.moduleFw, 'MOD_FW_1.2.3')
	assert.equal(modInfo.basic.bluetoothMac, 'AABBCCDDEEFF')

	// 混合流粘包 + 逐字节拆包测试
	const stream = Uint8Array.from([
		0x00, 0xff, 0x13, // 前导噪声
		...innerAc6d,     // 纯 AC6D
		...upPassFrame,   // A99A 透传包装 AC6D
		...infoUplink,    // A99A 模组上报
	])
	const sp1 = P.createStreamParser()
	const evsAll = sp1.push(stream)
	assert.equal(evsAll.length, 3)
	assert.equal(evsAll[0].kind, 'ac6d')
	assert.equal(evsAll[0].unwrappedFromIot, false)
	assert.equal(evsAll[1].kind, 'ac6d')
	assert.equal(evsAll[1].unwrappedFromIot, true)
	assert.equal(evsAll[1].parsed.detail.firmwareVersion, 'V3.1')
	assert.equal(evsAll[2].kind, 'a99a-info')
	assert.equal(evsAll[2].moduleInfo.basic.imei, '861234567890123')

	// 逐 3 字节切分喂入，验证无丢帧
	const sp2 = P.createStreamParser()
	const evsFrag = []
	for (let i = 0; i < stream.length; i += 3) {
		evsFrag.push(...sp2.push(stream.subarray(i, Math.min(stream.length, i + 3))))
	}
	assert.equal(evsFrag.length, 3)
	assert.equal(evsFrag[2].moduleInfo.basic.userNumber, '00000003115261005007')
})

// ---- 8. 16B OTA 固件头封装与校验 ----
test('OTA 16B header inspect, wrap, idempotency and 24KB boundary', () => {
	const rawBody = new Uint8Array(1024)
	for (let i = 0; i < rawBody.length; i++) rawBody[i] = (i * 37) & 0xff

	const rawInfo = P.inspectFirmwareBin(rawBody)
	assert.equal(rawInfo.hasHeader, false)
	assert.equal(rawInfo.validForApp2, true)

	const wrapped = P.wrapFirmwareWithHeader(rawBody)
	assert.equal(wrapped.alreadyWrapped, false)
	assert.equal(wrapped.image.length, 1024 + 16)
	assert.equal(wrapped.info.hasHeader, true)
	assert.equal(wrapped.info.magicOk, true)
	assert.equal(wrapped.info.productId, '9091')
	assert.equal(wrapped.info.bodySize, 1024)
	assert.equal(wrapped.info.bodyCrc, P.crc16(rawBody))
	assert.equal(wrapped.info.totalSize, 1040)
	assert.equal(wrapped.info.totalCrc, P.crc16(wrapped.image))
	assert.equal(wrapped.info.validForApp2, true)

	// 幂等：对已封装固件再次 wrap 不会重复加头
	const wrappedAgain = P.wrapFirmwareWithHeader(wrapped.image)
	assert.equal(wrappedAgain.alreadyWrapped, true)
	assert.equal(wrappedAgain.image.length, wrapped.image.length)

	// 超出 24KB (0x6000) 校验失败
	const oversized = new Uint8Array(0x6000) // 加 16B 头后 0x6010 > 0x6000
	const ovInfo = P.inspectFirmwareBin(oversized)
	assert.equal(ovInfo.validForApp2, false)
	assert.match(ovInfo.reason, /24KB/)

	// 篡改产品识别码校验失败
	const badProd = wrapped.image.slice()
	badProd[11] = '8'.charCodeAt(0)
	const badProdInfo = P.inspectFirmwareBin(badProd)
	assert.equal(badProdInfo.validForApp2, false)
	assert.match(badProdInfo.reason, /产品识别码/)
})

// ---- 9. 三锚点校准算法与 SK-CALIB-BIND v4 导出 ----
test('3-anchor ratios, coeff math, error grading & SK-CALIB-BIND v4 JSON', () => {
	const fwd = P.createAnchorTable('fwd')
	assert.equal(fwd.Q3.length, 8)
	assert.equal(fwd.Q2.length, 6)
	assert.equal(fwd.Q1.length, 4)
	assert.equal(fwd.Q3[0].flow, 5.125)
	assert.equal(fwd.Q3[0].idx, 0)
	assert.equal(fwd.Q3[2].flow, 2.5)
	assert.equal(fwd.Q3[2].isAnchor, true)
	assert.equal(fwd.Q1[3].idx, 17)

	const inferredQ3 = P.inferAnchorGroup(fwd.Q3, 1.25)
	assert.equal(inferredQ3[2].error, 1.25)
	assert.equal(inferredQ3[0].error, Math.round(1.25 * 1.18627 * 10000) / 10000)
	assert.equal(inferredQ3[5].error, Math.round(1.25 * -0.587719 * 10000) / 10000)

	assert.equal(P.calcNewCoeff(10000, 2.0), Math.trunc(10000 * (100 / 102)))
	assert.equal(P.calcNewCoeff(10000, -2.0), Math.trunc(10000 * (100 / 98)))

	// pulseEq=17085 uL, deltaMs=1000ms, coeff=10000 -> 17085*3.6/1000 = 61.506 L/h
	assert.ok(Math.abs(P.calcPointFlowRateLph(17085, 1000, 10000) - 61.506) < 1e-9)
	assert.equal(P.calcPointFlowRateLph(17085, 0, 10000), 0)

	assert.deepEqual(P.evalCalibErrorGrade(2500, 0.8), { grade: 'ok', symbol: '✓' })
	assert.deepEqual(P.evalCalibErrorGrade(2500, 1.2), { grade: 'warn', symbol: '⚠' })
	assert.deepEqual(P.evalCalibErrorGrade(2500, 1.8), { grade: 'bad', symbol: '✗' })
	assert.deepEqual(P.evalCalibErrorGrade(5, 1.9), { grade: 'ok', symbol: '✓' })
	assert.deepEqual(P.evalCalibErrorGrade(5, 2.5), { grade: 'warn', symbol: '⚠' })
	assert.deepEqual(P.evalCalibErrorGrade(5, 3.2), { grade: 'bad', symbol: '✗' })

	const saveDate = new Date(2026, 10, 26, 18, 21, 24)
	const fn = P.buildCalibBindFileName('00000003115261005007', saveDate)
	assert.equal(fn, '0311526100_5007_N_N_N_N_N_N_N_N_N_校表数据_20261126_182124.json')

	const bindJson = P.buildCalibBindJson({
		date: saveDate,
		port: 'COM162',
		deviceInfo: { onlyAddrHex: 'AABBCC78563412', firmwareVersion: 'V3.1', temperatureC: 25, voltageV: 3.6, modeText: '校表' },
		moduleInfo: {
			basic: { imei: '861234567890123', iccid: '89860412345678901234', userNumber: '00000003115261005007', deviceCode: '08091011121314' },
			signal: { rsrp: -850, snr: 120, coverage: 1, csq: 24 },
		},
		baseParams: { onlyAddrHex: 'AABBCC78563412', voltageAlarmV: 3.1, sampleIntervalMin: 60, baseDegree: 0, initFlag: 0x55, meterPulseEq: 17085, calibPulseEq: 1000, commPulseEq: 60000, calibEnable: 1, calibDirection: 0, tempCompCoef: 10000, tempCompBaseC: 20, crcHex: '0x1234' },
		calibData: { meterPulseEq: 17085, calibPulseEq: 1000, commPulseEq: 60000, fwdCount: 18, revCount: 18, fwdPoints: [10], fwdCoeffs: [10000], revPoints: [10], revCoeffs: [10000] },
		serialIo: { device_info: { tx: 'AC6D', rx: 'AC6D' } },
	})
	assert.equal(bindJson.schema, 'SK-CALIB-BIND')
	assert.equal(bindJson.schema_version, 4)
	assert.equal(bindJson['批次'], '0311526100')
	assert.deepEqual(bindJson['台位使能'], { 数量: 1, 台位: [0] })
	assert.equal(bindJson['台位0'].statu['串口使能'], '使能')
	assert.equal(bindJson['台位0'].statu['读取传感器信息'], '成功')
	assert.equal(bindJson['台位0'].statu['读取远传模组信息'], '成功')
	assert.equal(bindJson['台位0'].device.user_number, '00000003115261005007')
	assert.equal(bindJson['台位0'].basic_data['计量脉冲当量(uL/脉冲)'], 17085)
	assert.equal(bindJson['台位1'].statu['串口使能'], '未使能')
	assert.equal(bindJson['台位9'].statu['串口使能'], '未使能')
})

// ---- 10. ProtocolRegistry 注册、logView/byteMap/presets 与 DeviceModel 接入 ----
test('ProtocolRegistry registration, logView, byteMap, presets and device panel integration', () => {
	const pvSandbox = { window: {}, globalThis: null }
	pvSandbox.globalThis = pvSandbox.window
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/parse-view.js'), 'utf8'), pvSandbox, { filename: 'js/parse-view.js' })
	const ParseView = pvSandbox.window.ParseView

	const win = { _protocols: {}, _activeProtocol: 'ac6d-meter', ParseView }
	const reg = ProtocolRegistryMod.createRegistry({ window: win, document: null, localStorage: null, ParseView })
	win.registerProtocol = (id, spec) => reg.register(id, spec)
	win.ProtocolRegistry = reg

	const ac6dCtx = Object.assign({
		window: win,
		globalThis: win,
		Uint8Array,
		Uint16Array,
		ArrayBuffer,
		BigInt,
		Date,
		Math,
		Number,
		String,
		Array,
		Object,
		Set,
		Map,
		console,
	})
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/ac6d-protocol.js'), 'utf8'), ac6dCtx, { filename: 'js/ac6d-protocol.js' })

	assert.equal(reg.has('ac6d-meter'), true)
	const entry = reg.get('ac6d-meter')
	assert.equal(entry.builtin, true)
	assert.equal(entry.name, '容积水表 (AC6D)')
	assert.ok(entry.device, 'device 声明应通过 normalizeDevice 校验')
	assert.equal(entry.device.queryable, true)
	assert.equal(entry.device.groups.length, 4)

	// 所有 preset 都能用 buildDownFrame 正确组帧并被 parseFrame 识别
	let presetCount = 0
	for (const grp of entry.presets) {
		for (const item of grp.items) {
			const frame = entry.buildDownFrame({ cmd: item.cmd, payloadHex: item.payloadHex })
			assert.ok(frame instanceof Uint8Array && frame.length >= 10)
			const parsed = entry.parseFrame(frame)
			assert.equal(parsed.ok, true)
			const lv = entry.logView(parsed)
			assert.ok(lv && typeof lv === 'object')
			for (const sec of (lv.sections || [])) {
				assert.equal('html' in sec, false, 'logView 不得包含 section.html')
			}
			const html = ParseView.render(lv)
			assert.ok(html.includes('pv-head'))
			const bm = entry.byteMap(parsed)
			assert.equal(bm.length, frame.length)
			presetCount++
		}
	}
	assert.equal(presetCount, 10)

	// DeviceModel 消费 0x33 应答帧
	const reqDev = entry.device.buildRequest(entry.device.groups[0])
	assert.ok(reqDev instanceof Uint8Array && reqDev.length >= 14)
	const data33 = [
		0x01, 0x02, 0x03, 0x78, 0x56, 0x34, 0x12,
		...asciiPad('V3.1.0', 16),
		23,
		...packU16(360),
		0x00,
		0x26, 0x11, 0x27, 0x09, 0x00, 0x00, 0x05, 0x00,
		0x01,
		...packU16(2),
		...packU16(0),
		...packU32(1000),
		...packU32(500),
		0, 0, 0,
	]
	const rsp33Frame = makeRspFrame(1, 0x33, 0x00, 0, data33)
	const parsed33 = entry.parseFrame(rsp33Frame)
	assert.equal(entry.device.matchReply(entry.device.groups[0], parsed33), true)
	const store = DeviceModel.createStore()
	const ing = DeviceModel.ingest(store, {
		sid: 'S',
		pid: 'ac6d-meter',
		gen: 1,
		at: Date.now(),
		bytes: rsp33Frame,
		parsed: parsed33,
		device: entry.device,
	})
	assert.ok(ing && ing.keys.includes('onlyAddr') && ing.keys.includes('firmwareVersion'))
	const lane = DeviceModel.lane(store, 'S', 'ac6d-meter')
	assert.equal(DeviceModel.reading(lane, 'onlyAddr').raw, '01020378563412')
	assert.equal(DeviceModel.reading(lane, 'voltageV').raw, 3.6)

	// 外部不得覆盖保留 ID 'ac6d-meter'
	assert.throws(() => reg.register('ac6d-meter', { name: 'spoof' }), /保留/)
})

// ---- 11. 回归测试：P1-5 / P2-1 / P2-2 / P2-3 / P2-4 ----
test('Regression: paramWriteBase requires valid onlyAddr, raw176 slice, 0x25 req tracking & ambiguity, 0x37/0x44 CRC16, uint64 bounds', () => {
	// P1-5: v27-40 / legacy-48 缺省或全零 onlyAddr 必须抛错，legacy-24 不需要 onlyAddr
	assert.throws(() => P.builders.paramWriteBase({ voltageAlarmV: 3.1 }, 0x12345678, { layout: 'v27-40' }), /onlyAddr/)
	assert.throws(() => P.builders.paramWriteBase({ onlyAddrHex: '00000000000000' }, 0x12345678, { layout: 'legacy-48' }), /onlyAddr/)
	assert.doesNotThrow(() => P.builders.paramWriteBase({ voltageAlarmV: 3.1 }, 0x12345678, { layout: 'legacy-24' }))

	// P2-1: parseCalibTableData 返回精确 176B raw176
	const raw176In = new Uint8Array(176)
	for (let i = 0; i < 176; i++) raw176In[i] = (i * 13 + 5) & 0xff
	raw176In[14] = 25 // 刻意保留未截断原始字节（UI 会钳制到 20，但 raw176 必须保留原字节）
	const cal192 = [...packU32(0xaa55aa55), ...packU32(1), ...raw176In, 0, 0, 0, 0, 0, 0, ...packU16(0x1122)]
	const pCal = P.parseFrame(makeRspFrame(0x61, 0x40, 0x00, 0, cal192))
	assert.ok(pCal.detail.raw176 instanceof Uint8Array)
	assert.equal(pCal.detail.raw176.length, 176)
	assert.deepEqual(Array.from(pCal.detail.raw176), Array.from(raw176In))

	// P2-2 & P2-A: 无模块全局状态；无 ctx.crcReqTracker 时即使先解析过 0x25 req，非 0x8000 应答仍为 crcAmbiguous；显式 tracker 隔离跨路
	const req25Custom = P.builders.otaCrc(0x9000, 0x400, { seq: 0x71 })
	assert.equal(P.parseFrame(req25Custom).detail.startAddr, 0x9000)
	const rsp25Custom = makeRspFrame(0x71, 0x25, 0x00, 0x9000, [0x34, 0x12])
	// 无状态 parseFrame 不应受到前一次 parseFrame(req25Custom) 的全局污染
	const pStateless = P.parseFrame(rsp25Custom)
	assert.equal(pStateless.detail.crcAmbiguous, true)
	assert.equal(pStateless.detail.crcValue, null)
	assert.equal(pStateless.detail.crcValueA, 0x9000)
	assert.equal(pStateless.detail.crcValueB, 0x1234)
	const lvAmbig = P.logView(pStateless)
	const candPair = lvAmbig.sections[0].pairs.find((x) => x[0] === 'CRC 候选')
	assert.ok(candPair && candPair[1].includes('0x9000') && candPair[1].includes('0x1234'))
	assert.ok(P.formatFrame(pStateless).includes('缺请求地址上下文'))

	// 双路独立 crcReqTracker 同 seq 不同起始地址互不污染（支持 clone / clear）
	const trA = P.createCrcReqTracker(32)
	const trB = P.createCrcReqTracker(32)
	const reqA = P.builders.otaCrc(0x8000, 0x400, { seq: 0x71 })
	const reqB = P.builders.otaCrc(0x9000, 0x400, { seq: 0x71 })
	P.parseFrame(reqA, { crcReqTracker: trA })
	P.parseFrame(reqB, { crcReqTracker: trB })
	const rspA = makeRspFrame(0x71, 0x25, 0x00, 0x8000, [0xaa, 0xbb])
	const pA = P.parseFrame(rspA, { crcReqTracker: trA })
	const pB = P.parseFrame(rsp25Custom, { crcReqTracker: trB })
	assert.equal(pA.detail.crcFormat, 'B')
	assert.equal(pA.detail.crcValue, 0xbbaa)
	assert.equal(pB.detail.crcFormat, 'B')
	assert.equal(pB.detail.crcValue, 0x1234)
	const trBClone = trB.clone()
	trB.clear()
	assert.equal(P.parseFrame(rsp25Custom, { crcReqTracker: trB }).detail.crcAmbiguous, true)
	assert.equal(P.parseFrame(rsp25Custom, { crcReqTracker: trBClone }).detail.crcValue, 0x1234)

	// streamParser 实例级 trackCrcReq 识别非 0x8000 格式 B，且两实例互不串扰
	const rsp25Ambig = makeRspFrame(0x79, 0x25, 0x00, 0x9400, [0x78, 0x56])
	const sp1 = P.createStreamParser()
	const sp2 = P.createStreamParser()
	sp1.trackCrcReq(0x79, 0x9400)
	sp2.trackCrcReq(0x79, 0xa000)
	const evs1 = sp1.push(rsp25Ambig)
	const evs2 = sp2.push(rsp25Ambig)
	assert.equal(evs1[0].parsed.detail.crcFormat, 'B')
	assert.equal(evs1[0].parsed.detail.crcValue, 0x5678)
	assert.equal(evs2[0].parsed.detail.crcFormat, 'A')
	assert.equal(evs2[0].parsed.detail.crcValue, 0x9400)

	// P2-3: 0x37 (0..27) 与 0x44 (0..29) 条目 CRC16 校验
	const freezeGoodBody = [
		...packU16(0x5a5a), ...packU16(10), 0x20, 0x26, 0x11, 0x27,
		...packU32(5000), ...packU32(10), ...packU32(5010), ...packU16(1200), ...packI16(200),
		0x00, 0x00, 0x00, 0x00,
	]
	const freezeGood = [...freezeGoodBody, ...packU16(P.crc16(Uint8Array.from(freezeGoodBody))), 0x00, 0x00]
	const freezeBadCrc = freezeGood.slice()
	freezeBadCrc[28] ^= 0xff
	const pF = P.parseFrame(makeRspFrame(0x81, 0x37, 0x00, 0, [...packU16(2), ...packU16(2), ...freezeGood, ...freezeBadCrc]))
	assert.equal(pF.detail.entries[0].crcOk, true)
	assert.equal(pF.detail.entries[0].valid, true)
	assert.equal(pF.detail.entries[1].crcOk, false)
	assert.equal(pF.detail.entries[1].valid, false)

	const tNow = Array.from(P.dateToBcd7(new Date(2026, 10, 27, 12, 0, 0)))
	const logBody = [1, ...tNow, 7, ...new Array(21).fill(0)]
	const logGood = [...logBody, ...packU16(P.crc16(Uint8Array.from(logBody)))]
	const logBad = logGood.slice()
	logBad[30] ^= 0x01
	const pL = P.parseFrame(makeRspFrame(0x82, 0x44, 0x00, 0, [0xff, ...logGood, ...logBad]))
	assert.equal(pL.detail.entries[0].crcOk, true)
	assert.equal(pL.detail.entries[0].summary.includes('[CRC校验失败]'), false)
	assert.equal(pL.detail.entries[1].crcOk, false)
	assert.ok(pL.detail.entries[1].summary.includes('[CRC校验失败]'))

	// P2-4: packU64le 严格拒绝越界或非法值
	assert.equal(P.packU64le(0xffffffffffffffffn).length, 8)
	assert.equal(P.packU64le('18446744073709551615').length, 8)
	for (const bad of [18446744073709551616n, '18446744073709551616', -1n, '-1', 'abc', NaN, Infinity, 1.5, null]) {
		assert.throws(() => P.packU64le(bad), RangeError)
	}
	assert.throws(() => P.builders.baseDegree('18446744073709551616', 0x12345678), RangeError)
})

let passed = 0
for (const t of tests) {
	t.fn()
	passed++
}
console.log('ac6d-protocol: ok (' + passed + ' tests)')
