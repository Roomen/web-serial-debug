// Run: node tests/ui-resource-lifecycle.cjs — synthetic DOM only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = name => fs.readFileSync(path.join(__dirname, '../js', name), 'utf8')

// A removed SEK chart must release its observer/listeners; late callbacks cannot draw it.
{
	const observers = []
	let paints = 0
	const listeners = new Map()
	const ctx = new Proxy({}, { get: (target, key) => target[key] || (() => {}) })
	const tip = { hidden: true }
	const output = { parentElement: null, querySelectorAll: () => [canvas] }
	const row = { parentElement: output, querySelectorAll: () => [canvas] }
	const box = { parentElement: row, clientWidth: 320, querySelector: () => tip }
	const canvas = {
		parentElement: box, style: {},
		getAttribute: () => JSON.stringify({ rows: [{ t: '00:00', v: 1 }, { t: '00:01', v: 2 }] }),
		getContext: () => { paints++; return ctx },
		addEventListener: (type, fn) => listeners.set(type, fn),
		removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type) },
	}
	const world = { window: {}, ResizeObserver: class {
		constructor(fn) { this.fn = fn; this.disconnected = false; observers.push(this) }
		observe(node) { this.node = node }
		disconnect() { this.disconnected = true }
	} }
	vm.createContext(world)
	vm.runInContext(source('protocol.js'), world)
	const W = world.window
	W.skBindSeriesCharts(output)
	W.skBindSeriesCharts(output)
	assert.equal(observers.length, 1, 'binding a chart twice must not duplicate observers')
	assert.equal(listeners.size, 2)
	assert.equal(row._skHasSeriesCharts, true, 'parent row gets a fast-path marker even when bound from its body')
	W.skDisposeSeriesCharts(row)
	assert.equal(observers[0].disconnected, true)
	assert.equal(listeners.size, 0)
	const before = paints
	observers[0].fn()
	assert.equal(paints, before, 'a queued resize callback cannot draw a disposed chart')
	W.skDisposeSeriesCharts(row)
	W.skDisposeSeriesCharts({ querySelectorAll() { throw new Error('chart-free rows must not be scanned') } })
	W.skBindSeriesCharts(output)
	assert.equal(observers.length, 2, 'a restored chart can be rebound after disposal')
	W.skDisposeSeriesCharts(canvas)
	assert.equal(observers[1].disconnected, true, 'direct canvas disposal is supported')
	assert.equal(listeners.size, 0)
}

// Exhausting CSS fallback URLs must terminate instead of repeatedly requesting the final CDN.
async function cssFallback() {
	const appended = []
	const cssRequests = []
	const document = {
		getElementById: id => appended.find(node => node.id === id),
		createElement(tag) {
			const node = { tag }
			Object.defineProperty(node, 'href', {
				get: () => node.url,
				set: value => { node.url = value; cssRequests.push(value) },
			})
			return node
		},
		head: { appendChild(node) { appended.push(node); if (node.tag === 'script') node.onerror() } },
	}
	const world = { document, window: { addEventListener() {} }, console: { error() {} } }
	vm.createContext(world)
	vm.runInContext(source('serial-term.js'), world)
	const pending = world.window.SerialTerm.ensure('S', {})
	const css = appended.find(node => node.tag === 'link')
	for (let i = 0; i < 10 && css.onerror; i++) css.onerror()
	assert.equal(cssRequests.length, 3, 'try each fallback once')
	assert.equal(css.onerror, null)
	assert.equal(await pending, null)
}

cssFallback().then(() => console.log('ui-resource-lifecycle: ok')).catch(error => { console.error(error); process.exitCode = 1 })
