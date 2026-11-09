'use strict'
// Synthetic slow xterm and quota failures; exercise actual production functions.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const read = name => fs.readFileSync(path.join(__dirname, '../js', name), 'utf8')
async function main() {
	const callbacks = [], parsed = [], timers = new Map(), events = []
	let timerId = 0, clears = 0
	class Terminal {
		open() {}
		onData() {}
		write(bytes, cb) { parsed.push(bytes.slice()); callbacks.push(cb) }
		reset() { clears++ }
		dispose() {}
	}
	const window = { Terminal, addEventListener() {}, dispatchEvent: ev => events.push(ev) }
	const ctx = vm.createContext({
		window, Uint8Array, TextEncoder, CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail } },
		document: { documentElement: { getAttribute: () => 'dark' } }, requestAnimationFrame: fn => fn(),
		setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id),
	})
	vm.runInContext(read('serial-term.js'), ctx)
	await window.SerialTerm.ensure('single', { offsetWidth: 100, offsetHeight: 100 })
	window.SerialTerm.write('single', new Uint8Array(2 * 1024 * 1024))
	assert.equal(parsed.length, 1, 'at most one 16KiB chunk handed to slow xterm')
	assert.equal(parsed[0].length, 16384)
	const notice = [...timers.values()][0]
	notice()
	assert.equal(events[0].detail.bytes, 1024 * 1024, 'overflow is counted explicitly')
	window.SerialTerm.clear('single')
	window.SerialTerm.write('single', new Uint8Array([42]))
	callbacks.shift()()
	assert.equal(parsed.length, 2, 'queued old chunks discarded on clear')
	assert.equal(clears, 2, 'clear again after uncancellable in-flight parser callback')
	assert.deepEqual(Array.from(parsed[1]), [42])
	callbacks.shift()()
	window.SerialTerm.dispose('single')

	const source = read('common.js')
	const begin = source.indexOf('\tfunction paneHtml(')
	const end = source.indexOf('\t// 节流而不是防抖', begin)
	// A 64KiB HEX log row includes both visible body and data-hex attribute.
	const big = '<div data-hex="' + 'AB '.repeat(65536) + '"><span>' + 'AB '.repeat(65536) + '</span></div>'
	const boxes = { 'serial-logs-single': { childElementCount: 64, children: Array.from({ length: 64 }, () => ({ outerHTML: big })) }, 'serial-logs-dual': { childElementCount: 0 } }
	let stored = 'previous valid snapshot', fail = false, attempts = 0, quotaBytes = Infinity, now = 1000
	const writes = []
	const cache = vm.createContext({
		document: { getElementById: id => boxes[id] }, window: {}, clearTimeout() {},
		Date: { now: () => now }, logPersistRetryAt: 0, LOG_PERSIST_RETRY_MS: 60000,
		LOG_CACHE_VER: 2, logSeq: 64, LOG_CACHE_KEY: 'cache', persistLogsTimer: 0, logPersistLevel: 0,
		LOG_PERSIST_LEVELS: [1536 * 1024, 768 * 1024, 384 * 1024, 96 * 1024],
		sessionStorage: { setItem(key, raw) { attempts++; writes.push(raw.length * 2); if (fail || raw.length * 2 > quotaBytes) throw new Error('quota'); stored = raw } },
	})
	vm.runInContext(source.slice(begin, end) + '\nglobalThis.persist = persistLogsNow', cache)
	assert.equal(cache.persist(), true)
	assert.ok(JSON.parse(stored).single.includes('AB '), 'large rows retain recent complete history')
	assert.ok(stored.length * 2 <= 1536 * 1024, 'UTF-16 byte budget includes JSON escaping')
	const good = stored
	fail = true
	assert.equal(cache.persist(), false)
	assert.equal(stored, good, 'failed replacement leaves previous snapshot intact')
	assert.equal(attempts, 2, 'smaller budgets cannot fit a row and never serialize/store an empty replacement')
	fail = false
	assert.equal(cache.persist(), true, 'transient quota failure must not permanently lower a successful byte budget')
	// 临时配额紧张：普通日志四档降到最低档成功；同快照每行仅取/编码一次。
	const reads = new Map()
	boxes['serial-logs-single'].children = Array.from({ length: 3000 }, (_, i) => ({
		get outerHTML() { reads.set(i, (reads.get(i) || 0) + 1); return '<div>' + 'x'.repeat(1000) + '</div>' }
	}))
	boxes['serial-logs-single'].childElementCount = 3000
	quotaBytes = 100 * 1024
	const beforeDowngrade = attempts
	assert.equal(cache.persist(), true)
	assert.equal(attempts - beforeDowngrade, 4)
	assert.equal(cache.logPersistLevel, 3, 'must exercise a real successful downgrade')
	assert.ok([...reads.values()].every(n => n === 1), 'same-snapshot memo survives all quota failures')
	const smallSnapshot = stored
	const retryAt = cache.logPersistRetryAt
	// 持续每 2s 保存不能把升档截止时间一直后推，也不应每次探测四档。
	for (let i = 0; i < 4; i++) {
		now += 2000
		const before = attempts
		assert.equal(cache.persist(), true)
		assert.equal(attempts - before, 1)
		assert.equal(cache.logPersistRetryAt, retryAt)
	}
	quotaBytes = Infinity
	boxes['serial-logs-single'].children = Array.from({ length: 64 }, () => ({ outerHTML: big }))
	boxes['serial-logs-single'].childElementCount = 64
	const beforeNoFit = attempts
	assert.equal(cache.persist(), false, 'large row cannot fit the currently successful 96KiB budget')
	assert.equal(attempts, beforeNoFit, 'row over budget must not be mistaken for quota failure')
	assert.equal(stored, smallSnapshot, 'keep the valid old snapshot until bounded recovery')
	assert.equal(cache.logPersistRetryAt, retryAt)
	now = retryAt
	const beforeRecover = attempts
	assert.equal(cache.persist(), true, 'quota restored: scheduled probe must save the later 64KiB row')
	assert.equal(attempts - beforeRecover, 1)
	assert.equal(cache.logPersistLevel, 0)
	assert.ok(JSON.parse(stored).single.includes('AB '))
	assert.notEqual(stored, smallSnapshot)
	assert.ok(stored.length * 2 <= 1536 * 1024)

	// 若配额仍紧张，到点也只探测一次，之后继续用小档，不每 2s 四轮重试。
	quotaBytes = 100 * 1024
	boxes['serial-logs-single'].children = Array.from({ length: 3000 }, () => ({ outerHTML: '<div>' + 'x'.repeat(1000) + '</div>' }))
	boxes['serial-logs-single'].childElementCount = 3000
	assert.equal(cache.persist(), true)
	now = cache.logPersistRetryAt
	const beforeProbe = attempts
	assert.equal(cache.persist(), true)
	assert.equal(attempts - beforeProbe, 4)
	const nextProbe = cache.logPersistRetryAt
	now += 2000
	const afterProbe = attempts
	assert.equal(cache.persist(), true)
	assert.equal(attempts - afterProbe, 1)
	assert.equal(cache.logPersistRetryAt, nextProbe)
	assert.ok(writes.every(bytes => bytes <= 1536 * 1024), 'all quota probes obey the strict byte budget')
	console.log('serial-output-resources: ok')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
