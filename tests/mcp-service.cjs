// Run: node tests/mcp-service.cjs — synthetic data only.
// 覆盖 js/mcp-service.js：只在桌面服务存在时挂菜单入口、面板状态文案、端口与启停控制、
// 令牌只在显式显示后出现(关面板后迟到的令牌不再写回)、复制的是干净 JSON、重新生成走面板内两步确认(不嵌套 AppDialog)。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const src = fs.readFileSync(path.join(__dirname, '../js/mcp-service.js'), 'utf8')

class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase()
		this.children = []
		this.parentNode = null
		this.listeners = {}
		this.className = ''
		this.textContent = ''
		this.value = ''
		this.hidden = false
		this.disabled = false
		this.type = ''
		this.id = ''
		this.title = ''
		this.dataset = {}
		this.classList = {
			toggle: (name, on) => {
				const set = new Set(this.className.split(/\s+/).filter(Boolean))
				if (on) set.add(name)
				else set.delete(name)
				this.className = Array.from(set).join(' ')
			},
			contains: (name) => this.className.split(/\s+/).includes(name),
		}
	}
	appendChild(c) { c.parentNode = this; this.children.push(c); return c }
	insertBefore(c, ref) {
		c.parentNode = this
		const i = ref ? this.children.indexOf(ref) : -1
		if (i < 0) this.children.push(c)
		else this.children.splice(i, 0, c)
		return c
	}
	setAttribute(k, v) { this[k] = v }
	addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f) }
	click() { (this.listeners.click || []).forEach((f) => f({ target: this })) }
	querySelectorAll() { return [] }
}

function makeHarness(opts) {
	opts = opts || {}
	const menu = new El('ul')
	const byId = {}
	const copied = []
	const dialogCalls = []
	let panelBody = null
	let closePanel = null
	const status = Object.assign({ supported: true, enabled: false, running: false, port: 38991, url: 'http://127.0.0.1:38991/mcp', hasToken: true, lastError: null, waitingForLogin: false }, opts.status || {})
	const svcListeners = {}
	const svc = opts.service === null ? null : {
		status: () => Promise.resolve(Object.assign({}, status)),
		enable: (port) => { status.enabled = true; if (port) status.port = port; return Promise.resolve({}) },
		disable: () => { status.enabled = false; status.running = false; return Promise.resolve({}) },
		revealToken: () => (opts.reveal || (() => Promise.resolve('a'.repeat(64))))(),
		regenerateToken: () => { status.token = 'b'.repeat(64); return Promise.resolve(Object.assign({}, status)) },
		listen: (name, cb) => { svcListeners[name] = cb; return Promise.resolve() },
	}
	const doc = {
		readyState: 'complete',
		activeElement: null,
		querySelector: (sel) => (sel === '#activity-rail .rail-bottom' ? menu : null),
		getElementById: (id) => byId[id] || null,
		createElement: (tag) => new El(tag),
		addEventListener() {},
	}
	const win = {
		document: doc,
		navigator: { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve() } } },
		AppPlatform: { has: (id) => id !== 'service.mcp' || opts.service !== null, service: (n) => (n === 'mcp' ? svc : null) },
		AppDialog: {
			panel: (o) => {
				dialogCalls.push(o)
				panelBody = new El('div')
				o.build(panelBody)
			doc.activeElement = panelBody.children.flatMap((n) => n.children).flatMap((n) => n.children).find((n) => n.tagName === 'INPUT') || null
				return new Promise((resolve) => { closePanel = () => { resolve(undefined) } })
			},
			confirm: () => { throw new Error('面板里不应嵌套 AppDialog.confirm') },
		},
		serialLanes: { toast() {} },
	}
	const ctx = { window: win, navigator: win.navigator, console, setTimeout, clearTimeout, Promise }
	vm.createContext(ctx)
	vm.runInContext(src, ctx)

	const h = {
		menu, byId, copied, dialogCalls, status, svcListeners,
		get panelBody() { return panelBody },
		close() { if (closePanel) closePanel() },
		menuItem() { return menu.children.find((b) => b.id === 'serial-mcp-service') || null },
		statusApi() { return win.McpServiceStatus || null },
		find(pred) {
			const walk = (n) => {
				if (pred(n)) return n
				for (const c of n.children) {
					const r = walk(c)
					if (r) return r
				}
				return null
			}
			return panelBody ? walk(panelBody) : null
		},
		byText(text) { return h.find((n) => n.tagName === 'BUTTON' && n.textContent === text) },
	}
	return h
}
const flush = () => new Promise((r) => setImmediate(r))

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('没有桌面 MCP 服务时不动配置菜单', async () => {
	const h = makeHarness({ service: null })
	await flush()
	assert.equal(h.menu.children.length, 0)
})

test('独立导航入口打开宽面板；首次聚焦仍显示默认端口', async () => {
	const h = makeHarness()
	await flush()
	const btn = h.menuItem()
	assert.ok(btn, '应当有 MCP 菜单项')
	assert.equal(btn.className, 'rail-item rail-mcp')
	assert.equal(btn.dataset.state, 'off')
	assert.equal(btn.dataset.feature, 'service.mcp')
	btn.click()
	await flush()
	assert.equal(h.dialogCalls.length, 1)
	assert.equal(h.dialogCalls[0].title, '本地 MCP 服务')
	assert.equal(h.dialogCalls[0].wide, true)
	const status = h.find((n) => n.className.indexOf('mdn-mcp-status') !== -1)
	assert.equal(status.textContent, '未启用（默认关闭）')
	const port = h.find((n) => n.className.indexOf('mdn-mcp-port') !== -1)
	assert.equal(port.value, '38991')
	assert.equal(port.disabled, false)
	assert.equal(h.byText('启用服务') != null, true)
})

test('面板关闭时导航状态仍随服务事件更新，重复点击不排队', async () => {
	const h = makeHarness({ status: { enabled: true, running: true } })
	await flush()
	assert.equal(h.menuItem().dataset.state, 'running')
	h.menuItem().click()
	h.menuItem().click()
	await flush()
	assert.equal(h.dialogCalls.length, 1)
	h.close()
	await flush()
	h.svcListeners['mcp-service']({ enabled: true, running: false, lastError: 'synthetic' })
	assert.equal(h.menuItem().dataset.state, 'error')
	h.svcListeners['mcp-service']({ enabled: true, running: false })
	assert.equal(h.menuItem().dataset.state, 'waiting')
	h.svcListeners['mcp-service']({ enabled: false, running: false })
	assert.equal(h.menuItem().dataset.state, 'off')
})

test('令牌默认不显示；显示后写进配置，隐藏后回到占位符', async () => {
	const h = makeHarness()
	await flush()
	h.menuItem().click()
	await flush()
	const cfg = h.find((n) => n.className.indexOf('mdn-mcp-cfg') !== -1)
	assert.ok(cfg.textContent.indexOf('<TOKEN>') !== -1)
	assert.equal(cfg.textContent.indexOf('aaaaaaaa'), -1)
	h.byText('显示令牌').click()
	await flush()
	const tokenBox = h.find((n) => n.className.indexOf('mdn-mcp-token') !== -1)
	assert.equal(tokenBox.textContent, 'a'.repeat(64))
	assert.ok(h.find((n) => n.className.indexOf('mdn-mcp-cfg') !== -1).textContent.indexOf('a'.repeat(64)) !== -1)
	h.byText('隐藏令牌').click()
	await flush()
	assert.equal(h.find((n) => n.className.indexOf('mdn-mcp-token') !== -1).textContent, '未显示')
})

test('复制配置是干净 JSON(无注释)，复制命令单独一份', async () => {
	const h = makeHarness({ status: { enabled: true, running: true } })
	await flush()
	h.menuItem().click()
	await flush()
	h.byText('复制配置').click()
	await flush()
	assert.equal(h.copied.length, 1)
	const text = h.copied[0]
	assert.equal(text.indexOf('#'), -1, '不应带注释')
	const parsed = JSON.parse(text)
	assert.equal(parsed.mcpServers['serial-debug'].url, 'http://127.0.0.1:38991/mcp')
	assert.equal(parsed.mcpServers['serial-debug'].headers.Authorization, 'Bearer ' + 'a'.repeat(64))
	assert.equal(h.find((n) => n.className.indexOf('mdn-mcp-token') !== -1).textContent, '未显示')
	h.byText('复制命令').click()
	await flush()
	assert.ok(h.copied[1].indexOf('claude mcp add --transport http serial-debug') === 0)
	assert.ok(h.copied[1].includes('Bearer ' + 'a'.repeat(64)))
})

test('一键复制给 Agent 包含完整配置与操作说明，不需要显示令牌', async () => {
	const h = makeHarness({ status: { enabled: true, running: true, port: 39000, url: 'http://127.0.0.1:39000/mcp' } })
	await flush()
	h.menuItem().click()
	await flush()
	h.byText('一键复制给 Agent').click()
	await flush()
	assert.equal(h.copied.length, 1)
	const text = h.copied[0]
	assert.ok(text.includes('http://127.0.0.1:39000/mcp'))
	assert.ok(text.includes('windows_list'))
	assert.ok(text.includes('blu_set_power'))
	assert.ok(text.includes('unknown_after_commit'))
	assert.ok(!text.includes('<TOKEN>'))
	const config = JSON.parse(text.match(/```json\n\n([\s\S]*?)\n\n```/)[1])
	assert.equal(config.mcpServers['serial-debug'].headers.Authorization, 'Bearer ' + 'a'.repeat(64))
	assert.equal(h.find((n) => n.className.indexOf('mdn-mcp-token') !== -1).textContent, '未显示')
})

test('服务未运行或取令牌失败时不复制无效的接入配置', async () => {
	let reads = 0
	const h = makeHarness({ reveal: () => { reads++; throw new Error('synthetic unavailable') } })
	await flush()
	h.menuItem().click()
	await flush()
	assert.equal(h.byText('一键复制给 Agent').disabled, true)
	h.byText('一键复制给 Agent').click()
	await flush()
	assert.equal(reads, 0)
	assert.equal(h.copied.length, 0)
	h.status.enabled = h.status.running = true
	h.svcListeners['mcp-service'](h.status)
	h.byText('一键复制给 Agent').click()
	await flush()
	assert.equal(reads, 1)
	assert.equal(h.copied.length, 0)
	assert.equal(h.byText('一键复制给 Agent').disabled, false)
})

test('复制等待期间关闭面板，不复制迟到的令牌且合并重复点击', async () => {
	let release
	let reads = 0
	const h = makeHarness({ status: { enabled: true, running: true }, reveal: () => {
		reads++
		return new Promise((r) => { release = r })
	} })
	await flush()
	h.menuItem().click()
	await flush()
	h.byText('一键复制给 Agent').click()
	h.byText('复制配置').click()
	await flush()
	assert.equal(reads, 1)
	h.close()
	await flush()
	release('c'.repeat(64))
	await flush()
	assert.equal(h.copied.length, 0)
	assert.equal(h.find((n) => n.className.indexOf('mdn-mcp-token') !== -1).textContent, '未显示')
})

test('重新生成令牌：面板内两步确认，不嵌套确认框', async () => {
	const h = makeHarness()
	await flush()
	h.menuItem().click()
	await flush()
	h.byText('重新生成…').click()
	await flush()
	assert.equal(h.byText('确认重新生成') != null, true, '第一次点击只进入确认态')
	assert.equal(h.status.token, undefined, '还没真正生成')
	h.byText('确认重新生成').click()
	await flush()
	assert.equal(h.status.token, 'b'.repeat(64))
})

test('已启用但未运行：主键是停用，另有启动键', async () => {
	const h = makeHarness({ status: { enabled: true, running: false, waitingForLogin: true } })
	await flush()
	h.menuItem().click()
	await flush()
	assert.ok(h.byText('停用服务'), '已启用时主键必须是停用')
	const start = h.byText('启动')
	assert.ok(start, '未运行时应有启动键')
	assert.equal(start.hidden, false)
	const status = h.find((n) => n.className.indexOf('mdn-mcp-status') !== -1)
	assert.equal(status.textContent, '已启用，等登录后自动启动')
})

test('绑定失败如实显示，不假装运行', async () => {
	const h = makeHarness({ status: { enabled: true, running: false, lastError: '端口 38991 绑定失败(可能已被占用)' } })
	await flush()
	h.menuItem().click()
	await flush()
	const status = h.find((n) => n.className.indexOf('mdn-mcp-status') !== -1)
	assert.equal(status.textContent, '启动失败：端口 38991 绑定失败(可能已被占用)')
	assert.equal(status.classList.contains('is-error'), true)
})

test('关闭面板后迟到的令牌不再写回页面', async () => {
	let release = null
	const h = makeHarness({ reveal: () => new Promise((r) => { release = r }) })
	await flush()
	h.menuItem().click()
	await flush()
	h.byText('显示令牌').click()
	await flush()
	h.close()
	await flush()
	release('c'.repeat(64))
	await flush()
	const tokenBox = h.find((n) => n.className.indexOf('mdn-mcp-token') !== -1)
	assert.equal(tokenBox.textContent, '未显示')
})

test('状态栏只读接口：state/label/port 随事件刷新，open 打开面板', async () => {
	const h = makeHarness({ status: { enabled: true, running: true, port: 39000 } })
	await flush()
	const api = h.statusApi()
	assert.ok(api, '应当挂出 McpServiceStatus')
	assert.equal(typeof api.state, 'function')
	assert.equal(typeof api.label, 'function')
	assert.equal(typeof api.port, 'function')
	assert.equal(typeof api.open, 'function')
	assert.equal(api.state(), 'running')
	assert.equal(api.label(), '运行中')
	assert.equal(api.port(), 39000)
	h.svcListeners['mcp-service']({ enabled: true, running: false, lastError: 'synthetic' })
	assert.equal(api.state(), 'error')
	assert.equal(api.label(), '服务异常')
	h.svcListeners['mcp-service']({ enabled: true, running: false })
	assert.equal(api.state(), 'waiting')
	assert.equal(api.label(), '等待启动')
	h.svcListeners['mcp-service']({ enabled: false, running: false })
	assert.equal(api.state(), 'off')
	// 未启用时端口回落默认值
	assert.equal(api.port(), 38991)
	api.open()
	await flush()
	assert.equal(h.dialogCalls.length, 1)
})

;(async () => {
	let failed = 0
	for (const t of tests) {
		try {
			await t.fn()
			console.log('ok   ' + t.name)
		} catch (e) {
			failed++
			console.error('FAIL ' + t.name)
			console.error(e)
		}
	}
	if (failed) {
		console.error(failed + ' failed')
		process.exit(1)
	}
	console.log('all ' + tests.length + ' passed')
})()
