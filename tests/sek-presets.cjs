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
load('js/parse-view.js')
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

// 5. 配置APN / 用户账号 / 用户密码允许写空(32B 全0)，且协议下行切换预设或清空输入时不残留上一条 TLV
const flatPresets = presets.flatMap(g => g.items)
const apnPreset = flatPresets.find(it => it.name === '配置APN')
const ipPreset = flatPresets.find(it => it.name === '配置业务平台IP')
const userPreset = flatPresets.find(it => it.name === '设置用户账号')
const passPreset = flatPresets.find(it => it.name === '设置用户密码')
assert.strictEqual(apnPreset.param.allowEmpty, true)
assert.strictEqual(userPreset.param.allowEmpty, true)
assert.strictEqual(passPreset.param.allowEmpty, true)
assert.notStrictEqual(ipPreset.param.allowEmpty, true)
assert.deepStrictEqual(sandbox.window.ProtocolDownlink.encodeFieldValue('ascii', '', apnPreset.param), new Array(32).fill(0))
assert.strictEqual(sandbox.window.ProtocolDownlink.encodeFieldValue('ascii', '', ipPreset.param), null)

// 5a. 下行 UI 回归：切到 配置APN 立刻生成 Tag3-ID7 全0帧；切到 配置业务平台IP（不允许空）必须清空 tlvInput，避免点下发误发上一条指令
{
	function mkEl(tag) {
		const el = {
			tagName: tag.toUpperCase(),
			value: '',
			textContent: '',
			placeholder: '',
			type: 'text',
			hidden: false,
			disabled: false,
			style: {},
			dataset: {},
			attrs: {},
			children: [],
			options: [],
			selectedIndex: 0,
			classList: { _s: new Set(), add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) }, toggle(c, v) { v ? this._s.add(c) : this._s.delete(c) }, contains(c) { return this._s.has(c) } },
			_listeners: {},
			addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn) },
			dispatchEvent(ev) {
				const list = this._listeners[ev.type] || []
				for (const fn of list) fn({ target: this })
			},
			click() { this.dispatchEvent({ type: 'click' }) },
			appendChild(c) {
				this.children.push(c)
				if (c.tagName === 'OPTION') this.options.push(c)
				if (c.tagName === 'OPTGROUP') {
					const origAppend = c.appendChild.bind(c)
					c.appendChild = (o) => { origAppend(o); if (o.tagName === 'OPTION') this.options.push(o) }
				}
			},
			setAttribute(k, v) { this.attrs[k] = v },
			removeAttribute(k) { delete this.attrs[k] },
			closest() { return null },
			querySelector() { return null },
			querySelectorAll() { return [] },
			focus() {},
		}
		Object.defineProperty(el, 'innerHTML', {
			get() { return '' },
			set() { el.children = []; el.options = [] },
		})
		return el
	}
	const ids = [
		'sk-down-card', 'serial-protocol-down-encrypt', 'serial-protocol-down-tlv',
		'serial-protocol-build', 'serial-protocol-send', 'serial-protocol-down-preview',
		'serial-protocol-down-preset', 'serial-protocol-down-func', 'serial-protocol-down-func-tabs',
		'serial-protocol-down-preset-search', 'serial-protocol-down-preset-search-clear',
		'serial-protocol-down-desc', 'serial-protocol-down-param-group',
		'serial-protocol-down-param-val', 'serial-protocol-down-param-sel',
		'serial-protocol-down-param-label', 'serial-protocol-down-param-unit',
		'serial-protocol-down-param-multi',
	]
	const dom = {}
	for (const id of ids) dom[id] = mkEl(id.includes('sel') || id.includes('preset') && !id.includes('search') && !id.includes('desc') || id.endsWith('func') ? 'select' : 'input')
	const sent = []
	const errs = []
	const uiDoc = {
		readyState: 'complete',
		getElementById(id) { return dom[id] || null },
		createElement(tag) { return mkEl(tag) },
		createTextNode(t) { return { textContent: t } },
	}
	const uiSandbox = {
		window: null,
		document: uiDoc,
		Event: function (type) { this.type = type },
		console, BigInt, Math, Number, String, Array, Object, Date, JSON, Uint8Array, parseInt, isNaN, setTimeout, clearTimeout, Promise,
	}
	uiSandbox.window = uiSandbox
	uiSandbox.globalThis = uiSandbox
	uiSandbox._activeProtocol = 'sek'
	uiSandbox.SK_TAGS = sandbox.window.SK_TAGS
	uiSandbox.SK_TAG_NAME = sandbox.window.SK_TAG_NAME
	uiSandbox.SK_DOWN_PRESETS = presets
	uiSandbox.SK_PRESET_CODEC = codec
	uiSandbox.skBuildDownFrame = sandbox.window.skBuildDownFrame
	uiSandbox.skParseFrame = sandbox.window.skParseFrame
	uiSandbox._serialProtocolHost = {
		rawSek: { buildDownFrame: sandbox.window.skBuildDownFrame, parseFrame: sandbox.window.skParseFrame },
		sendHex(hex) { sent.push(hex); return Promise.resolve() },
		addLogErr(msg) { errs.push(msg) },
	}
	vm.runInNewContext(fs.readFileSync(path.join(root, 'js/protocol-downlink.js'), 'utf8'), uiSandbox, { filename: 'js/protocol-downlink.js' })
	uiSandbox.ProtocolDownlink.mountSekPanel()

	// 先切到 0x01，默认选中第一项（设置上报频率 Tag3-ID9）
	dom['serial-protocol-down-func'].value = '0x01'
	dom['serial-protocol-down-func'].dispatchEvent({ type: 'change' })
	assert.strictEqual(dom['serial-protocol-down-preset'].value, '设置上报频率')
	assert.ok(dom['serial-protocol-down-tlv'].value.includes('"id":9'))

	// 切到 配置APN（默认空）→ 应立刻生成 Tag3-ID7 全0 32B 帧，绝不能残留 Tag3-ID9
	dom['serial-protocol-down-preset'].value = '配置APN'
	dom['serial-protocol-down-preset'].dispatchEvent({ type: 'change' })
	assert.strictEqual(dom['serial-protocol-down-tlv'].value, JSON.stringify([{ tag: 3, items: [{ id: 7, value: '00'.repeat(32) }] }]))
	const emptyApnParsed = sandbox.window.skParseFrame(dom['serial-protocol-down-preview'].value, {})
	assert.strictEqual(emptyApnParsed.ok, true)
	assert.strictEqual(emptyApnParsed.tlv[0].tag, 3)
	assert.strictEqual(emptyApnParsed.tlv[0].items[0].id, 7)
	assert.deepStrictEqual(emptyApnParsed.tlv[0].items[0].raw, new Array(32).fill(0))

	// 输入 cmnet → 生成 cmnet + 补零 32B；再删空 → 恢复全0 32B，不残留 cmnet
	dom['serial-protocol-down-param-val'].value = 'cmnet'
	dom['serial-protocol-down-param-val'].dispatchEvent({ type: 'input' })
	const cmnetParsed = sandbox.window.skParseFrame(dom['serial-protocol-down-preview'].value, {})
	assert.strictEqual(cmnetParsed.tlv[0].items[0].decoded, 'cmnet')
	assert.strictEqual(cmnetParsed.tlv[0].items[0].raw.length, 32)
	dom['serial-protocol-down-param-val'].value = ''
	dom['serial-protocol-down-param-val'].dispatchEvent({ type: 'input' })
	const clearedParsed = sandbox.window.skParseFrame(dom['serial-protocol-down-preview'].value, {})
	assert.deepStrictEqual(clearedParsed.tlv[0].items[0].raw, new Array(32).fill(0))

	// 输入非 ASCII 字符 → 清空 tlvInput 与 previewEl 并标红提示，不产生乱码帧
	dom['serial-protocol-down-param-val'].value = '中文'
	dom['serial-protocol-down-param-val'].dispatchEvent({ type: 'input' })
	assert.strictEqual(dom['serial-protocol-down-tlv'].value, '')
	assert.strictEqual(dom['serial-protocol-down-preview'].value, '')
	assert.strictEqual(dom['serial-protocol-down-param-unit'].classList.contains('is-error'), true)

	// 切到不允许写空的 配置业务平台IP（默认空）→ 必须清空 tlvInput 与 previewEl，点下发不得误发上一条指令
	dom['serial-protocol-down-preset'].value = '设置上报频率'
	dom['serial-protocol-down-preset'].dispatchEvent({ type: 'change' })
	assert.ok(dom['serial-protocol-down-tlv'].value.includes('"id":9'))
	dom['serial-protocol-down-preset'].value = '配置业务平台IP'
	dom['serial-protocol-down-preset'].dispatchEvent({ type: 'change' })
	assert.strictEqual(dom['serial-protocol-down-tlv'].value, '')
	assert.strictEqual(dom['serial-protocol-down-preview'].value, '')
	dom['serial-protocol-send'].click()
	assert.strictEqual(sent.length, 0, '不允许空的预设留空点下发绝不能误发上一条指令')
	assert.ok(errs.some(m => m.includes('请先生成HEX再下发')))
}

// 6. Tag40 蜂窝搜网参数查询与锁定配置编解码、校验与上行解析
const { skBuildDownFrame, skParseFrame, skCrc16, skLogView, ParseView } = sandbox.window
const cellularSettings = codec.filterPresets(presets, '0x01', 'Tag40').flatMap(group => group.filtered)
assert.strictEqual(cellularSettings.length, 3)

const examples = [
	{ input: '00101', bytes: [48, 48, 49, 48, 49, 0], decoded: '00101', auto: '自动选网' },
	{ input: '3， 8 20', bytes: [3, 8, 20, 0, 0, 0, 0, 0], decoded: 'B3, B8, B20', auto: '全频段自动搜网' },
	{ input: '262143', bytes: [255, 255, 3, 0], decoded: '262143', auto: '自动选频' },
]
for (const [index, preset] of cellularSettings.entries()) {
	const { input, bytes, decoded, auto } = examples[index]
	const id = index + 1
	const setting = JSON.parse(JSON.stringify(preset.tlv))
	for (const [text, expected, label] of [[input, bytes, decoded], ['  ', Array(bytes.length).fill(0), auto]]) {
		setting[0].items[0].value = codec.cellularLockToBytes(preset.param.field, text).bytes
		const parsedSetting = skParseFrame(skBuildDownFrame({ frameSeq: id, funcCode: preset.func, tlv: setting }))
		assert.equal(parsedSetting.ok, true)
		assert.equal(parsedSetting.tlv.length, 1)
		assert.equal(parsedSetting.tlv[0].tag, 40)
		assert.equal(parsedSetting.tlv[0].items.length, 1)
		assert.equal(parsedSetting.tlv[0].items[0].id, id)
		assert.deepEqual(Array.from(parsedSetting.tlv[0].items[0].raw), expected)
		assert.equal(parsedSetting.tlv[0].items[0].decoded, label)
	}
}
assert.deepEqual(Array.from(codec.cellularLockToBytes('operator', '001001').bytes), [48, 48, 49, 48, 48, 49])
assert.deepEqual(Array.from(codec.cellularLockToBytes('earfcn', '1').bytes), [1, 0, 0, 0])
for (const [field, invalid] of [
	['operator', ['1234', '1234567', '12a45', '１２３４５']],
	['bands', [',', '3,,8', '0', '256', '-1', '3.5', '1 2 3 4 5 6 7 8 9']],
	['earfcn', ['0', '262144', '-1', '1.5', '1e3']],
]) {
	for (const input of invalid) assert.ok(codec.cellularLockToBytes(field, input).error, `${field}: ${input}`)
}

const cellularQuery = codec.filterPresets(presets, '0x03', 'Tag40')[0].filtered[0]
const query = skParseFrame(skBuildDownFrame({ frameSeq: 1, funcCode: cellularQuery.func, tlv: cellularQuery.tlv }))
assert.equal(query.ok, true)
assert.equal(query.tlv[0].tag, 10)
assert.equal(query.tlv[0].items[0].id, 40)
assert.equal(query.tlv[0].items[0].name, '蜂窝搜网参数')
assert.equal(query.tlv[0].items[0].raw.length, 0)

const specifiedIds = [40, 4, 40, 6, ...Array(28).fill(0xff)]
const specificQuery = skParseFrame(skBuildDownFrame({ frameSeq: 1, funcCode: 0x03,
	tlv: [{ tag: 10, items: [{ id: 0, value: specifiedIds }] }] }))
assert.equal(specificQuery.tlv[0].items[0].decoded, '蜂窝搜网参数/ID4 蜂窝搜网参数/ID6')

function cellularReply(func, payload) {
	const block = [40, payload.length, 0, ...payload]
	const header = [0xa9, 0x9a, 1, 0, 2, 1, 0x10, ...Array(13).fill(0), func, 0]
	const frame = [...header, block.length + 2, 0, block.length, 0, ...block]
	const crc = skCrc16(Uint8Array.from(frame))
	return skParseFrame(Uint8Array.from([...frame, crc & 255, crc >> 8, 0x16]))
}
const reply = cellularReply(0x83, [
	1, ...Array(6).fill(0), 2, ...examples[1].bytes, 3, ...Array(4).fill(0),
	4, ...examples[0].bytes, 5, 8, 6, 0x45, 0x23, 0x01, 0,
])
assert.equal(reply.ok, true)
assert.equal(reply.tlv[0].name, '蜂窝搜网参数')
assert.deepEqual(Array.from(reply.tlv[0].items, item => item.decoded),
	['自动选网', 'B3, B8, B20', '自动选频', '00101', 'B8', '74565'])
assert.match(ParseView.render(skLogView(reply)), /当前驻网频点[^]*74565/)
const unknown = cellularReply(0x83, [4, ...Array(6).fill(0), 5, 0, 6, ...Array(4).fill(0)])
assert.deepEqual(Array.from(unknown.tlv[0].items, item => item.decoded), ['未知', '未知或未驻网', '未知'])
const ack = cellularReply(0x81, [2, 1, 3, 4])
assert.deepEqual(Array.from(ack.tlv[0].items, item => item.resultCode), [1, 4])
const truncated = cellularReply(0x83, [2, 3, 8, 6])
assert.equal(truncated.tlv[0].items.length, 1)
assert.equal(truncated.tlv[0].items[0].partial, true)

console.log('sek-presets.cjs: all assertions passed')
