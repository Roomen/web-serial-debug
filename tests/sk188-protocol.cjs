// Run: node tests/sk188-protocol.cjs — synthetic data only, no device logs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const window = { registerProtocol() {} }
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/sk188-protocol.js'), 'utf8'), {
	window, Uint8Array, document: { getElementById() { return null } },
})
const parse = window.sk188ParseFrame
const find = window.sk188FindFrame
const byteMap = window.sk188ByteMap
const hex = s => Uint8Array.from(s.split(' ').map(x => parseInt(x, 16)))
const seal = bytes => Uint8Array.from([...bytes, bytes.reduce((sum, b) => (sum + b) & 255, 0), 0x16])
const ack = seal(hex('68 10 12 34 56 78 90 12 34 83 03 81 0A 01'))
const read = seal([...hex('68 10 12 34 56 78 90 12 34 81 16 90 1F 02'),
	...hex('01 00 00 00 29 02 00 00 00 29 00 00 00 00 00 00 00 00 03')])
const write = seal(hex('68 10 12 34 56 78 90 12 34 95 03 A0 18 03'))
const request = window.sk188BuildDownFrame({ cmd: 3, addr: 'AA AA AA AA AA AA AA', seq: 1 })

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
console.log('SK188 regression checks passed')
