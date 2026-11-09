'use strict'
// Actual batch persistence functions with shared settings and isolated session progress.
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const source = fs.readFileSync(require('node:path').join(__dirname, '../js/batch-config.js'), 'utf8')
const begin = source.indexOf('\tfunction saveState()')
const end = source.indexOf('\t// ---------- UI 状态', begin)
const shared = new Map([['sk-batch-state', JSON.stringify({ list: [], index: 99, gapMs: 200 })]])
const storage = map => ({ getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, v) })
function instance(session) {
	const ctx = vm.createContext({
		localStorage: storage(shared), sessionStorage: storage(session), STATE_KEY: 'sk-batch-state',
		DEFAULT_TIMEOUT_MS: 5000, DEFAULT_GAP_MS: 200,
		el: { timeout: { value: 5000 }, gap: { value: 200 }, continueOnFail: { checked: false } },
	})
	vm.runInContext('let current = 0, list = []\n' + source.slice(begin, end) + '\nglobalThis.api = { saveState, loadState, set(v) { current = v }, get() { return current } }', ctx)
	ctx.api.loadState()
	return ctx.api
}
const aSession = new Map(), bSession = new Map()
const a = instance(aSession), b = instance(bSession)
assert.equal(a.get(), 0, 'legacy shared progress does not seed a new instance')
a.set(17)
a.saveState()
b.loadState()
assert.equal(b.get(), 0)
b.set(4)
b.saveState()
assert.equal(instance(aSession).get(), 17, 'refresh retains own progress')
assert.equal(instance(bSession).get(), 4)
assert.equal(Object.hasOwn(JSON.parse(shared.get('sk-batch-state')), 'index'), false)
console.log('instance-runtime: ok')
