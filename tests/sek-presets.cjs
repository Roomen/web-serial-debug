'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.resolve(__dirname, '..')
const sandbox = { window: {}, console, BigInt, Math, Number, String, Array, Object, Date, JSON, Uint8Array, parseInt, isNaN }
sandbox.globalThis = sandbox.window

function load(rel) {
	const code = fs.readFileSync(path.join(root, rel), 'utf8')
	vm.runInNewContext(code, sandbox, { filename: rel })
}

load('js/protocol-schema.js')
load('js/protocol-crypto.js')
load('js/protocol.js')
load('js/protocol-presets.js')

const presets = sandbox.window.SK_DOWN_PRESETS
const codec = sandbox.window.SK_PRESET_CODEC
assert.ok(Array.isArray(presets) && presets.length > 0, 'SK_DOWN_PRESETS 应已加载')
assert.ok(codec && typeof codec.largeFlowM3ToBytes === 'function', 'SK_PRESET_CODEC 应已加载')

// 1. 确认所有 0x01 参数设置类指令都有 param 输入定义（不再残留空 value: [] 的无输入框项）
let total01 = 0
for (const grp of presets) {
	for (const it of grp.items) {
		if (it.func === '0x01') {
			total01++
			assert.ok(it.param, `参数设置指令缺少 param: ${it.name}`)
		}
		for (const blk of (it.tlv || [])) {
			for (const item of (blk.items || [])) {
				if (Array.isArray(item.value) && item.value.length === 0) {
					assert.fail(`指令 ${it.name} 仍残留空 value: [] 且无输入框`)
				}
			}
		}
	}
}
assert.ok(total01 > 50, '应覆盖全部 0x01 参数设置指令')

// 2. 大口径底度(Tag3-ID35/36) 必须是 largeFlow 类型，且换算与 protocol.js 解析往返一致
const posPreset = presets.flatMap(g => g.items).find(it => it.name === '设置计量底度正累积(大口径)')
const negPreset = presets.flatMap(g => g.items).find(it => it.name === '设置计量底度逆累积(大口径)')
assert.strictEqual(posPreset.param.type, 'largeFlow')
assert.strictEqual(negPreset.param.type, 'largeFlow')

// 2a. 123.456 m³ @ 1L/圈 (code=3) → 123456 圈 (0x01E240)
const r3 = codec.largeFlowM3ToBytes('123.456', 3)
assert.deepStrictEqual(Array.from(r3.bytes), [0x00, 0x40, 0xE2, 0x01, 0x00, 0x00, 0x00, 0x00])
assert.strictEqual(r3.units, '123456')

// 2b. 123.456 m³ @ 100L/圈 (code=1) → 1234.56 四舍五入为 1235 圈 (0x04D3)
const r1 = codec.largeFlowM3ToBytes('123.456', 1)
assert.deepStrictEqual(Array.from(r1.bytes), [0x00, 0xD3, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00])
assert.strictEqual(r1.units, '1235')

// 2c. 1000000 m³ @ 1mL/圈 (code=6) → 10^12 圈 (0x000000E8D4A51000)，超过 32 位
const r6 = codec.largeFlowM3ToBytes('1000000', 6)
assert.deepStrictEqual(Array.from(r6.bytes), [0x00, 0x00, 0x10, 0xA5, 0xD4, 0xE8, 0x00, 0x00])
assert.strictEqual(r6.units, '1000000000000')

// 2d. 0 m³ @ 1000L/圈 (code=0) → 全 0
const r0 = codec.largeFlowM3ToBytes('0', 0)
assert.deepStrictEqual(Array.from(r0.bytes), [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
assert.strictEqual(r0.units, '0')

// 2e. 往返验证：编码进 SEK 帧并用 protocol.js 解析，能还原出对应读数
sandbox.window.skSession.setBase(2, 'Tag3-ID29') // 10L/圈 (code=2)
const r2 = codec.largeFlowM3ToBytes('56.78', 2) // 5678 圈 = 56780L = 56.78m³
assert.strictEqual(r2.units, '5678')
const frame = sandbox.window.skBuildDownFrame({
	funcCode: '0x01',
	version: 2,
	time: new Date('2026-01-01T00:00:00Z'),
	frameSeq: 1,
	tlv: [{ tag: 3, items: [{ id: 35, value: r2.bytes }] }]
})
const parsed = sandbox.window.skParseFrame(frame, {})
assert.strictEqual(parsed.ok, true)
const item35 = parsed.tlv[0].items[0]
assert.strictEqual(item35.id, 35)
const decodedStr = String(item35.hint || item35.decoded || '')
assert.ok(decodedStr.includes('56.78 m³'), `解析值应包含 56.78 m³，实际: ${decodedStr}`)
assert.ok(decodedStr.includes('10L/圈'), `应按 10L/圈 基准解析，实际: ${decodedStr}`)

// 2f. 非法输入与越界校验
assert.ok(codec.largeFlowM3ToBytes('', 3).error)
assert.ok(codec.largeFlowM3ToBytes('-1', 3).error)
assert.ok(codec.largeFlowM3ToBytes('abc', 3).error)
assert.ok(codec.largeFlowM3ToBytes('10', 9).error)
assert.ok(codec.largeFlowM3ToBytes('999999999999999999', 6).error)

// 3. 指令搜索过滤（按功能码 + 多关键字匹配名称/描述/分组）
const f1 = codec.filterPresets(presets, '0x01', '大口径')
assert.strictEqual(f1.length, 1)
assert.strictEqual(f1[0].filtered.length, 2)
assert.ok(f1[0].filtered.some(it => it.name.includes('正累积')))
assert.ok(f1[0].filtered.some(it => it.name.includes('逆累积')))

const f2 = codec.filterPresets(presets, '0x01', 'tag39 逆流')
assert.strictEqual(f2.length, 1)
assert.strictEqual(f2[0].filtered.length, 1)
assert.strictEqual(f2[0].filtered[0].name, '设置逆流阶段预警阈值参数')

const f3 = codec.filterPresets(presets, '0x03', '大口径')
assert.strictEqual(f3.length, 0)

// 4. settingRange 钳制类型边界 + settingBytes 支持 bcd / hexbytes
sandbox.window.ProtocolDownlink = require('../js/protocol-downlink.js')
const clamped = codec.settingRange({ type: 'uint8', min: '1', max: '365' })
assert.strictEqual(clamped.min, 1)
assert.strictEqual(clamped.max, 255)
assert.deepStrictEqual(Array.from(codec.settingBytes({ type: 'bcd', fillLen: 7 }, '123456')), [0x56, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00])
assert.throws(() => codec.settingBytes({ type: 'bcd', fillLen: 7 }, '12a4'))
assert.throws(() => codec.settingBytes({ type: 'bcd', fillLen: 7 }, '1'.repeat(15)))
assert.deepStrictEqual(Array.from(codec.settingBytes({ type: 'hexbytes', fillLen: 3 }, '07:66:88')), [0x07, 0x66, 0x88])
assert.deepStrictEqual(Array.from(codec.settingBytes({ type: 'hexbytes', fillLen: 4 }, '00 01')), [0x00, 0x01, 0x00, 0x00])
assert.throws(() => codec.settingBytes({ type: 'hexbytes', fillLen: 3 }, '076'))
assert.throws(() => codec.settingBytes({ type: 'hexbytes', fillLen: 3 }, '07 66 88 99'))
assert.throws(() => codec.settingBytes({ type: 'hexbytes', fillLen: 3 }, '07 ZZ 88'))

console.log('sek-presets.cjs: all assertions passed')
