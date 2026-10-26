// Synthetic byte grammar tests; no device data.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const ctx = vm.createContext({ window: {}, TextEncoder, Uint8Array })
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/text-byte-encoder.js'), 'utf8'), ctx)
const encode = ctx.window.TextByteEncoder.encode
const bytes = s => Array.from(encode(s))
assert.deepEqual(bytes('中文😀'), Array.from(new TextEncoder().encode('中文😀')))
assert.deepEqual(bytes(''), [])
assert.deepEqual(bytes(String.raw`\a\b\t\n\v\f\r\\\'\"\?`), [7, 8, 9, 10, 11, 12, 13, 92, 39, 34, 63])
assert.deepEqual(bytes(String.raw`\0\00\000\1\12\123\377\08\0000`), [0, 0, 0, 1, 10, 83, 255, 0, 56, 0, 48])
assert.deepEqual(bytes(String.raw`\x0\xf\xFF\x00000041\x41\x42`), [0, 15, 255, 65, 65, 66])
assert.deepEqual(bytes(String.raw`\\n`), [92, 110], 'escape results are never parsed recursively')
assert.deepEqual(bytes('😀' + String.raw`\377` + '中'), [240, 159, 152, 128, 255, 228, 184, 173])
for (const s of ['abc\\', String.raw`abc\q`, String.raw`\x`, String.raw`\xG`, String.raw`\400`, String.raw`\777`, String.raw`\x100`, String.raw`\x41B`, String.raw`\u0041`, String.raw`\U0001F600`, '\\\n']) {
	assert.throws(() => encode(s), /TEXT 转义错误.*第 1 行/)
}
assert.throws(() => encode('ok\n😀' + String.raw`\q`), /第 2 行，第 2 列/)
assert.throws(() => encode('\\x' + 'f'.repeat(100000)), /0–255/)
const large = '中😀'.repeat(100000) + String.raw`\0`
const encoded = encode(large)
assert.equal(encoded.length, 700001)
assert.equal(encoded[encoded.length - 1], 0)
console.log('text-byte-encoder: ok')
