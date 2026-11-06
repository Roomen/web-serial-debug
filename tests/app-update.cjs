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

// 加载真实的 js/workbench.js，用真 TASKS 的 updateBlockers 断言过滤；MCP 状态由 window.McpServiceStatus 桩提供
function realWorkbench(mcpStatus, dom) {
	const win = { McpServiceStatus: mcpStatus }
	win.window = win
	win.document = Object.assign({
		readyState: 'loading',
		addEventListener() {},
		getElementById: () => null,
		querySelector: () => null,
	}, dom)
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/workbench.js'), 'utf8'), win)
	return win.Workbench
}

test('MCP 服务运行中不阻止应用更新(blocksUpdate: false 的任务被 updateBlockers 过滤)', async () => {
	const s = setup()
	await s.controller.check()
	// MCP 已启用且运行中：真实 TASKS 里它是 running，但 blocksUpdate 为 false，不能进阻断清单
	s.env.Workbench = realWorkbench({ state: () => 'running', port: () => 38991, open() {} })
	assert.deepEqual(Array.from(s.env.Workbench.updateBlockers()), [], '运行中的 MCP 不在阻断清单里')
	assert.deepEqual(blockers(s.env), [])
	// 同一份真实 TASKS：面板任务运行中(停止键可用)照样阻断，证明过滤确实在跑
	const running = realWorkbench({ state: () => 'off', port: () => 38991, open() {} }, {
		getElementById: (id) => (id === 'sk-rw-stop' ? { disabled: false } : null),
	})
	assert.deepEqual(Array.from(running.updateBlockers()), ['随机读写'])
	// MCP 运行时仍可进入安装准备
	const installing = s.controller.install()
	s.install.resolve()
	assert.equal(await installing, true)
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
		insertBefore(child) { return this.appendChild(child) }
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
	assert.equal(menu.children[0].id, 'serial-check-update')
	await window.AppUpdate.check(true)
	assert.equal(alerts.length, 1)
	assert.match(alerts[0], /发布版客户端/)
	assert.match(body.children[0].children[0].textContent, /更新未完成/)
})

test('failed portable update result is surfaced on startup and never blocks when absent', async () => {
	class Element {
		constructor() { this.children = []; this.attrs = {}; this.events = {}; this.classList = { add() {}, remove() {} } }
		appendChild(child) { child.parentNode = this; this.children.push(child); return child }
		insertBefore(child) { return this.appendChild(child) }
		append(...children) { children.forEach((child) => this.appendChild(child)) }
		setAttribute(key, value) { this.attrs[key] = value }
		removeAttribute(key) { delete this.attrs[key] }
		addEventListener(key, value) { this.events[key] = value }
	}
	const menu = new Element(), body = new Element(), version = new Element(), alerts = []
	const doc = { readyState: 'complete', body, createElement: () => new Element(), querySelector: () => menu, getElementById: () => version }
	const result = { success: false, version: '2.0.0', message: '无法替换正在使用的程序，请先退出所有 Serial Debug 窗口' }
	const service = { listen: async () => () => {}, check: async () => null, setPreparing() {}, takeResult: async () => result }
	const window = { document: doc, AppPlatform: { service: () => service }, APP_VERSION: '1.0.0', APP_UPDATER_CONFIGURED: true, AppDialog: { alert: async (text, opts) => alerts.push({ text, opts }) }, addEventListener() {} }
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/app-update.js'), 'utf8'), { window })
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(alerts.length, 1, '上次失败原因必须在启动后告诉用户')
	assert.match(alerts[0].text, /无法替换正在使用的程序/)
	const bar = body.children[0]
	assert.equal(bar.hidden, false)
	assert.match(bar.children[0].textContent, /上次更新未完成/)
	// 服务没有 takeResult(旧版原生端)时不生成任何提示
	const alerts2 = []
	const legacy = { listen: async () => () => {}, check: async () => null, setPreparing() {} }
	const window2 = { document: { ...doc, body: new Element() }, AppPlatform: { service: () => legacy }, APP_VERSION: '1.0.0', APP_UPDATER_CONFIGURED: true, AppDialog: { alert: async (text) => alerts2.push(text) }, addEventListener() {} }
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/app-update.js'), 'utf8'), { window: window2 })
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(alerts2.length, 0)
})

test('successful update result is consumed without any prompt', async () => {
	class Element {
		constructor() { this.children = []; this.events = {}; this.classList = { add() {}, remove() {} } }
		appendChild(child) { child.parentNode = this; this.children.push(child); return child }
		insertBefore(child) { return this.appendChild(child) }
		append(...children) { children.forEach((child) => this.appendChild(child)) }
		setAttribute() {}
		removeAttribute() {}
		addEventListener() {}
	}
	const calls = [], alerts = []
	const service = { listen: async () => () => {}, check: async () => null, setPreparing() {}, takeResult: async () => { calls.push(1); return { success: true, version: '2.0.0', message: '' } } }
	const window = {
		document: { readyState: 'complete', body: new Element(), createElement: () => new Element(), querySelector: () => null, getElementById: () => null },
		AppPlatform: { service: () => service }, APP_VERSION: '2.0.0', APP_UPDATER_CONFIGURED: true,
		AppDialog: { alert: async (text) => alerts.push(text) }, addEventListener() {},
	}
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/app-update.js'), 'utf8'), { window })
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(calls.length, 1)
	assert.equal(alerts.length, 0)
})
