// Run: node tests/mcp-ring.cjs — synthetic data only.
// 覆盖 js/mcp-ring.js：有界环的覆盖/游标/丢弃计数、换代次、命名空间游标、HEX 严格解析与读取参数校验。
const assert = require('node:assert/strict')
const Ring = require('../js/mcp-ring.js')

const enc = (s) => new TextEncoder().encode(s)
const dec = (u8) => new TextDecoder().decode(u8)

// ---- 基本读写与游标推进 ----
{
	const ring = Ring.createRing(16)
	ring.push(enc('abcdef'))
	const first = ring.read(null, 3)
	assert.equal(dec(first.data), 'abc')
	assert.equal(first.cursor, 0)
	assert.equal(first.nextCursor, 3)
	const second = ring.read(first.nextCursor, 100)
	assert.equal(dec(second.data), 'def')
	assert.equal(second.dropped, 0)
	const third = ring.read(second.nextCursor, 100)
	assert.equal(third.data.length, 0)
	assert.equal(third.nextCursor, 6)
}

// ---- 环满覆盖：丢最早的数据并如实计数（容量下限 1 KiB） ----
{
	const ring = Ring.createRing(1024)
	ring.push(new Uint8Array(1024).fill(0x41))
	ring.push(enc('wxyz'))
	const stats = ring.stats()
	assert.equal(stats.total, 1028)
	assert.equal(stats.retained, 1024)
	assert.equal(stats.oldestCursor, 4)
	// 用已经被覆盖的游标读：dropped 报告被丢掉的字节
	const r = ring.read(0, 8)
	assert.equal(r.dropped, 4)
	assert.equal(r.data.length, 8)
	assert.equal(r.cursor, 4)
}

// ---- 单次写入超过容量：只保留尾部 ----
{
	const ring = Ring.createRing(1024)
	ring.push(enc('x'.repeat(1000) + 'TAIL'))
	const r = ring.read(null, 8)
	assert.equal(dec(r.data), 'xxxxxxxx')
	assert.equal(r.dropped, 0)
	assert.equal(ring.stats().retained, 1004)
}

// ---- 换代次后游标作废（调用方按 generation 判） ----
{
	const ring = Ring.createRing(16)
	ring.push(enc('old'))
	const gen = ring.generation
	ring.reset()
	assert.ok(ring.generation > gen)
	assert.equal(ring.stats().total, 0)
	ring.push(enc('new'))
	assert.equal(dec(ring.read(null, 16).data), 'new')
}

// ---- 游标带命名空间：别的窗口 / 别的路 / 刷新前都不认 ----
{
	const a = Ring.encodeCursor('doc1-S', 3, 42)
	assert.deepEqual(Ring.parseCursor(a), { ns: 'doc1-S', generation: 3, offset: 42 })
	assert.equal(Ring.parseCursor('3:42'), null, '旧格式(无命名空间)不接受')
	assert.equal(Ring.parseCursor('doc1-S:3'), null)
	assert.equal(Ring.parseCursor('doc1-S:x:42'), null)
	assert.equal(Ring.parseCursor('doc1-S:3:42:7'), null)
	assert.equal(Ring.parseCursor(42), null)
	assert.notEqual(Ring.parseCursor(a).ns, Ring.parseCursor(Ring.encodeCursor('doc1-A', 3, 42)).ns)
}

// ---- HEX 严格解析：奇数位 / 非法字符 / 空值都拒绝，不猜不截断 ----
{
	assert.equal(Ring.parseHex('00 ff 10').ok, true)
	assert.deepEqual(Array.from(Ring.parseHex('00 ff 10').bytes), [0, 255, 16])
	assert.equal(Ring.parseHex('0').ok, false)
	assert.equal(Ring.parseHex('0g').ok, false)
	assert.equal(Ring.parseHex('').ok, false)
	assert.equal(Ring.parseHex('   ').ok, false)
	assert.equal(Ring.parseHex(null).ok, false)
	assert.equal(Ring.encodeHex(new Uint8Array([0, 1, 255])), '0001ff')
}

// ---- 读取参数：NaN / Infinity / 小数 / 越界都拒绝 ----
{
	assert.equal(Ring.readInt(undefined, 1, 10, 4), 4)
	assert.equal(Ring.readInt('7', 1, 10, 4), 7)
	assert.equal(Ring.readInt(NaN, 1, 10, 4), null)
	assert.equal(Ring.readInt(Infinity, 1, 10, 4), null)
	assert.equal(Ring.readInt(1.5, 1, 10, 4), null)
	assert.equal(Ring.readInt(0, 1, 10, 4), null)
	assert.equal(Ring.readInt(11, 1, 10, 4), null)
	assert.equal(Ring.readInt('abc', 1, 10, 4), null)
}

console.log('mcp-ring: ok')
