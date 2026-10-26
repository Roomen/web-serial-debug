const test = require('node:test')
const assert = require('node:assert/strict')
const { createController, blockers } = require('../js/app-update.js')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

function deferred() {
	let resolve, reject
	const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
	return { promise, resolve, reject }
}
function setup() {
	const events = [], acknowledgments = []
	const install = deferred()
	const env = {
		Workbench: { updateBlockers: () => [] },
		serialApi: { isPinned: () => false, prepareForAppUpdate: async () => {}, resumeAfterAppUpdate() { this.updatePreparing = false } },
		sessionStorage: { length: 2, key: (i) => ['serialHubMode', 'unrelated'][i], getItem: () => 'single' },
	}
	const service = {
		check: async () => ({ version: '2.0.0', currentVersion: '1.0.0', body: '<script>plain text</script>' }),
		install: (version) => { assert.equal(version, '2.0.0'); return install.promise },
		setPreparing: () => {},
		ack: async (...args) => acknowledgments.push(args),
	}
	return { env, service, install, events, acknowledgments, controller: createController(service, env, (s) => events.push(s)) }
}

test('busy tasks in hidden views block install; power and pinned transactions also block', async () => {
	const s = setup()
	await s.controller.check()
	s.env.Workbench.updateBlockers = () => ['固件升级']
	s.env.bluApi = { isOpen: () => true }
	s.env.serialApi.isPinned = () => true
	assert.deepEqual(blockers(s.env), ['固件升级', '协议事务', '功耗仪连接'])
	assert.equal(await s.controller.install(), false)
	assert.equal(s.controller.busy, false)
	s.env.bluApi = { isOpen: () => false, isBusyForUpdate: () => true }
	assert.ok(blockers(s.env).includes('功耗仪连接'), 'power device opening is also busy')
})

test('signed download remains usable; preparing progress must not swallow the ready event', async () => {
	const s = setup()
	await s.controller.check()
	const installing = s.controller.install()
	assert.equal(s.controller.frozen, false)
	s.controller.progress({ operationId: 1, state: 'preparing' })
	await s.controller.prepare({ operationId: 1 })
	assert.equal(s.controller.frozen, true)
	assert.equal(s.env.serialApi.updatePreparing, true)
	assert.deepEqual(s.acknowledgments, [[1, true, { serialHubMode: 'single' }]])
	s.install.resolve()
	assert.equal(await installing, true)
	assert.equal(s.controller.frozen, true, 'successful install stays frozen until restart')
})

test('tasks started during download are rejected by all-window preparation', async () => {
	const s = setup()
	await s.controller.check()
	const installing = s.controller.install()
	s.env.Workbench.updateBlockers = () => ['批量配置']
	await s.controller.prepare({ operationId: 4 })
	assert.deepEqual(s.acknowledgments, [[4, false, {}]])
	s.install.reject(new Error('busy'))
	await assert.rejects(installing)
	assert.equal(s.controller.frozen, false)
})

test('missing release confirmation fails closed and allows retry', async () => {
	const s = setup()
	s.env.serialApi.prepareForAppUpdate = async () => { throw new Error('close failed') }
	await s.controller.prepare({ operationId: 2 })
	assert.equal(s.acknowledgments[0][1], false)
	assert.equal(s.controller.frozen, false)
	s.controller.finished({ operationId: 2, success: false })
	s.env.serialApi.prepareForAppUpdate = async () => {}
	await s.controller.prepare({ operationId: 3 })
	assert.equal(s.acknowledgments[1][1], true)
})

test('timeout while closing cannot produce a late ready acknowledgment', async () => {
	const s = setup(), closing = deferred()
	s.env.serialApi.prepareForAppUpdate = () => closing.promise
	const preparing = s.controller.prepare({ operationId: 7 })
	assert.equal(s.controller.frozen, true)
	s.controller.finished({ operationId: 7, success: false })
	closing.resolve()
	await preparing
	assert.equal(s.acknowledgments[0][1], false)
	assert.equal(s.controller.frozen, false)
})

test('check calls are serialized and a check failure clears stale update selection', async () => {
	const s = setup(), checking = deferred()
	s.service.check = () => checking.promise
	const first = s.controller.check()
	assert.equal(await s.controller.check(), undefined)
	checking.resolve(null)
	assert.equal(await first, null)
	s.service.check = async () => ({ version: '2.0.0' })
	await s.controller.check()
	s.service.check = async () => { throw new Error('offline') }
	await assert.rejects(s.controller.check())
	assert.equal(s.controller.busy, false)
	assert.equal(s.controller.pending, null)
})

test('session storage failure never acknowledges a partial snapshot as ready', async () => {
	const s = setup()
	s.env.sessionStorage.getItem = () => { throw new Error('storage denied') }
	await s.controller.prepare({ operationId: 8 })
	assert.equal(s.acknowledgments[0][1], false)
	assert.equal(s.controller.frozen, false)
})

test('browser has no native entry and Tauri never polls its bundled webpage version', () => {
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/app-update.js'), 'utf8'), {
		window: { AppPlatform: { service: () => null }, document: { createElement() { throw new Error('browser DOM changed') } } },
	})
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/update-check.js'), 'utf8'), {
		window: { AppPlatform: { runtime: 'tauri' } },
		setTimeout() { throw new Error('local version polling started') },
	})
})

test('native config entry and unconfigured-build dialog use platform service', async () => {
	class Element {
		constructor() { this.children = []; this.attrs = {}; this.events = {}; this.classList = { add() {}, remove() {} } }
		appendChild(child) { child.parentNode = this; this.children.push(child); return child }
		append(...children) { children.forEach((child) => this.appendChild(child)) }
		setAttribute(key, value) { this.attrs[key] = value }
		removeAttribute(key) { delete this.attrs[key] }
		addEventListener(key, value) { this.events[key] = value }
	}
	const menu = new Element(), body = new Element(), version = new Element(), alerts = []
	const doc = { readyState: 'complete', body, createElement: () => new Element(), querySelector: () => menu, getElementById: () => version }
	const service = { listen: async () => () => {}, check: async () => { throw new Error('not configured') }, setPreparing() {} }
	const window = { document: doc, AppPlatform: { service: () => service }, APP_UPDATER_CONFIGURED: false, AppDialog: { alert: async (text) => alerts.push(text) }, addEventListener() {} }
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/app-update.js'), 'utf8'), { window })
	assert.equal(menu.children[0].children[0].id, 'serial-check-update')
	await window.AppUpdate.check(true)
	assert.equal(alerts.length, 1)
	assert.match(alerts[0], /发布版客户端/)
	assert.match(body.children[0].children[0].textContent, /更新未完成/)
})

test('portable update entry opens download page without native checks, listeners or timers', () => {
	const opened = [], menu = { children: [], appendChild(child) { this.children.push(child) } }
	const doc = {
		readyState: 'complete', body: { appendChild() {} }, querySelector: () => menu,
		createElement(tag) { return {
			tag, children: [], appendChild(child) { this.children.push(child) },
			addEventListener(name, cb) { this[name] = cb },
			click() { opened.push({ href: this.href, target: this.target }) }, remove() {},
		} },
	}
	const service = { manualDownloadUrl: 'https://example.com/download/' }
	const window = { document: doc, AppPlatform: { service: () => service } }
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/app-update.js'), 'utf8'), {
		window, setTimeout() { throw new Error('installer polling started') }, setInterval() { throw new Error('installer polling started') },
	})
	const button = menu.children[0].children[0]
	assert.equal(button.textContent, '下载新版 ZIP…')
	button.click()
	window.AppUpdate.check(true)
	assert.deepEqual(opened, [
		{ href: service.manualDownloadUrl, target: '_blank' },
		{ href: service.manualDownloadUrl, target: '_blank' },
	])
})
