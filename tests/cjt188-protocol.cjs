// Run: node tests/cjt188-protocol.cjs — synthetic data only, no device logs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const window = { registerProtocol() {} }
const context = vm.createContext({ window, Uint8Array, document: { getElementById() { return null } } })
for (const file of ['parse-view', 'cjt188-protocol']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + file + '.js'), 'utf8'), context)
const parse = window.cjt188ParseFrame
const find = window.cjt188FindFrame
const byteMap = window.cjt188ByteMap
const hex = s => Uint8Array.from(s.split(' ').map(x => parseInt(x, 16)))
const seal = bytes => Uint8Array.from([...bytes, bytes.reduce((sum, b) => (sum + b) & 255, 0), 0x16])
const ack = seal(hex('68 10 12 34 56 78 90 12 34 83 03 81 0A 01'))
const read = seal([...hex('68 10 12 34 56 78 90 12 34 81 16 90 1F 02'),
	...hex('01 00 00 00 29 02 00 00 00 29 00 00 00 00 00 00 00 00 03')])
const write = seal(hex('68 10 12 34 56 78 90 12 34 95 03 A0 18 03'))
const request = window.cjt188BuildDownFrame({ cmd: 3, addr: 'AA AA AA AA AA AA AA', seq: 1 })

for (const frame of [request, ack, read, write]) {
	const expected = parse(frame)
	assert.equal(expected.ok, true)
	for (const prefix of [[], [0xfe], [0xfe, 0xfe, 0xfe]]) {
		const input = Uint8Array.from([...prefix, ...frame, 0x68, 0x10])
		const result = parse(input)
		assert.equal(result.ok, true)
		assert.deepEqual(result.fields, expected.fields)
		assert.equal(result.decoded, expected.decoded)
		assert.equal(result.frameOffset, prefix.length)
		assert.deepEqual(Array.from(result.raw), Array.from(input))
		const map = byteMap(result)
		assert.equal(map.length, input.length)
		assert.deepEqual(map.slice(prefix.length, -2), byteMap(expected))
		assert.ok(map.slice(0, prefix.length).every(label => label.includes('前导')))
		assert.ok(map.slice(-2).every(label => label === ''))
		const found = find(input)
		assert.equal(found.found, true)
		assert.deepEqual(found.frame, frame)
		assert.equal(found.prefix, prefix.length)
		assert.equal(found.suffix, 2)
	}
}
assert.match(parse(read).decoded, /BCD值=1/)
assert.match(parse(read).decoded, /BCD值=2/)
assert.match(parse(read).decoded, /异常\/未知/)

const noise = hex('00 00 C0 40 00')
assert.equal(find([...noise, ...ack]).found, true)
assert.equal(parse(noise).ok, false)
assert.ok(byteMap(parse(noise)).every(label => label === ''))
for (const input of [[], [0xfe, 0xfe], [0xfe, 0x68], [0x68, 0x10], [...ack.slice(0, -1)]]) {
	assert.equal(parse(input).ok, false)
}
for (const pos of [ack.length - 2, ack.length - 1]) {
	const bad = ack.slice()
	bad[pos] ^= 1
	const input = [0xfe, 0xfe, 0xfe, ...bad]
	assert.equal(parse(input).ok, false)
	assert.equal(find(input).found, false)
	assert.match(parse(input).errors.join(), pos === ack.length - 2 ? /校验和/ : /帧尾/)
}
for (const length of [0, 1, 2]) {
	const input = seal([...ack.slice(0, 10), length, ...Array(length).fill(0)])
	assert.equal(parse(input).ok, false)
	assert.equal(find(input).found, false)
}

// Reproduce the firmware's misplaced address copy, recomputing its checksum.
const damaged = Array.from(write.slice(0, -2))
damaged.splice(1, 7, ...hex('12 34 56 78 90 12 34'))
const malformed = [0xfe, 0xfe, 0xfe, ...seal(damaged), 0x68, 0x10]
const result = parse(malformed)
assert.equal(result.ok, false)
assert.match(result.errors.join(), /疑似写表号应答地址偏移错误/)
assert.equal(find(malformed).found, false)
assert.ok(byteMap(result).slice(3).every(label => label === ''))
const corrupted = malformed.slice()
corrupted[17] ^= 1
assert.doesNotMatch(parse(corrupted).errors.join(), /地址偏移/)

// Fake-DOM regression: valve operation options must preserve hexadecimal values through frame building.
{
	class Element {
		constructor(value = '') {
			this.value = value
			this.dataset = {}
			this.style = {}
			this.options = []
			this.listeners = {}
			this.checked = true
		}
		set innerHTML(value) { if (value === '') this.options = [] }
		addEventListener(type, callback) { this.listeners[type] = callback }
		appendChild(option) {
			this.options.push(option)
			if (this.options.length === 1) this.selectedIndex = 0
		}
		querySelector() { return null }
		click() { if (this.listeners.click) this.listeners.click() }
	}
	const elements = new Map()
	const ids = [
		'cjt188-down-cmd', 'cjt188-down-addr', 'cjt188-down-addr-reset', 'cjt188-down-seq',
		'cjt188-down-preamble', 'cjt188-down-param-group', 'cjt188-down-param-label',
		'cjt188-down-param-val', 'cjt188-down-param-sel', 'cjt188-down-err', 'cjt188-down-build',
		'cjt188-down-send', 'cjt188-down-preview', 'serial-protocol-select', 'cjt188-down-title',
		'cjt188-down-card', 'sk-down-card', 'sk-rw-card', 'sk-batch-card', 'serial-protocol-advanced',
	]
	for (const id of ids) elements.set(id, new Element(id === 'cjt188-down-cmd' ? '0x04' : id === 'serial-protocol-select' ? 'cjt188' : ''))
	const fakeDocument = {
		getElementById(id) { return elements.get(id) || null },
		createElement() { return new Element() },
	}
	const uiContext = vm.createContext({
		window: { registerProtocol() {} },
		document: fakeDocument,
		localStorage: { getItem() { return null }, setItem() {} },
		Uint8Array,
	})
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/cjt188-protocol.js'), 'utf8'), uiContext)
	const paramSel = elements.get('cjt188-down-param-sel')
	assert.deepEqual(paramSel.options.map(option => option.textContent), ['0x55 开阀', '0x77 除锈', '0x99 关阀'])
	Object.defineProperty(paramSel, 'value', { configurable: true, get() { return this.options[this.selectedIndex].value } })
	elements.get('cjt188-down-build').click()
	const defaultFrame = hex(elements.get('cjt188-down-preview').value)
	assert.equal(defaultFrame[parse(defaultFrame).frameOffset + 14], 0x55)
	assert.equal(elements.get('cjt188-down-err').textContent, '')
	for (const protocol of ['cjt188', 'sk-ultrasonic']) {
		elements.get('serial-protocol-select').value = protocol
		for (const [index, op] of [0x55, 0x77, 0x99].entries()) {
			paramSel.selectedIndex = index
			elements.get('cjt188-down-preview').value = ''
			elements.get('cjt188-down-build').click()
			const built = hex(elements.get('cjt188-down-preview').value)
			const parsed = parse(built)
			assert.equal(parsed.ok, true)
			assert.equal(built[parsed.frameOffset + 14], op)
			assert.equal(elements.get('cjt188-down-err').textContent, '')
		}
	}
}

// 日志「解析」视图模型: 合法帧给带 title 的模型，垃圾数据返回 null；模型里的文本保持原样，转义是渲染器的事
const J = x => JSON.parse(JSON.stringify(x))
{
	const m = J(window.cjt188LogView(parse(read)))
	assert.equal(m.title, '读数据')
	assert.equal(m.code, '0x01')
	assert.equal(m.dir, 'up')
	assert.deepEqual(m.subject, { label: '表号', value: '12345678901234' })
	assert.ok(m.badges.some(b => b.text === '应答') && m.badges.some(b => b.kind === 'ok'))
	assert.deepEqual(m.sections[0].pairs[0], ['当前累计流量', 'BCD 1', '单位标识 0x29'])
	assert.equal(window.cjt188LogView(parse(request)).dir, 'down')
	assert.equal(window.cjt188LogView(parse(request)).subject.value.includes('广播'), true)
	// 校验和错误仍给模型，但带醒目的失败徽标
	const bad = read.slice()
	bad[bad.length - 2] ^= 1
	assert.ok(window.cjt188LogView(parse(bad)).badges.some(b => b.kind === 'bad'))
	for (const junk of [[], [0xfe, 0xfe], hex('00 11 22 33'), noise, [0x68, 0x10]]) assert.equal(window.cjt188LogView(parse(junk)), null)
	// 设备字符串原样放进模型，渲染时才转义
	const evil = J(window.cjt188LogView({ fields: { 功能码: { value: '0x01', name: '<img src=x>' }, 表号: '<script>', 数据标识: '', 序号: 0 }, dir: 'up', errors: [], ctrl: 0x81, dataLen: 3, csOk: true, endOk: true }))
	assert.equal(evil.title, '<img src=x>')
	assert.equal(evil.subject.value, '<script>')
	const html = window.ParseView.render(evil)
	assert.ok(!html.includes('<img') && !html.includes('<script>') && html.includes('&lt;script&gt;'))
}
console.log('CJ/T 188 regression checks passed')
