// Run: node tests/protocol-manager.cjs — synthetic data only.
// 覆盖: js/protocol-manager.js 与 js/command-palette.js 协议命令：
// 1) 桌面/移动端门控（protocol.manage）；
// 2) 三栏切换、搜索、显隐开关及保底错误还原、设为当前、快捷跳转编辑；
// 3) JSON 协议新建模板、校验、保存、覆盖内联确认、目录只读提示、两步删除、导入导出；
// 4) JS 插件安全提示、桌面本地插件目录栏、导入默认未执行、内联两步信任启用、启停、编辑与两步删除；
// 5) 全程零嵌套 AppDialog.confirm / prompt / alert；
// 6) 恶意载荷 <img onerror=...> 经 textContent 安全渲染不注入 DOM 元素；
// 7) 命令面板「协议管理」与动态「切换协议：<名称>」命令及门控。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const managerSrc = fs.readFileSync(path.join(__dirname, '../js/protocol-manager.js'), 'utf8')
const paletteSrc = fs.readFileSync(path.join(__dirname, '../js/command-palette.js'), 'utf8')

class FakeEl {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase()
		this.nodeType = 1
		this.children = []
		this.parentNode = null
		this.listeners = {}
		this.attrs = {}
		this.className = ''
		this.textContent = ''
		this.value = ''
		this.checked = false
		this.hidden = false
		this.disabled = false
		this.readOnly = false
		this.type = ''
		this.id = ''
		this.title = ''
		this.placeholder = ''
		this.download = ''
		this.href = ''
		this.files = []
		this.dataset = {}
		this._innerHTML = ''
		this.classList = {
			toggle: (name, on) => {
				const set = new Set(this.className.split(/\s+/).filter(Boolean))
				if (on === undefined) {
					if (set.has(name)) set.delete(name)
					else set.add(name)
				} else if (on) {
					set.add(name)
				} else {
					set.delete(name)
				}
				this.className = Array.from(set).join(' ')
			},
			contains: (name) => this.className.split(/\s+/).includes(name),
		}
	}
	get innerHTML() { return this._innerHTML }
	set innerHTML(v) {
		if (this._forbidInnerHTML) throw new Error('protocol-manager 禁止使用 innerHTML')
		this._innerHTML = String(v)
	}
	get options() {
		return this.children.filter((c) => c.tagName === 'OPTION')
	}
	appendChild(c) {
		c.parentNode = this
		this.children.push(c)
		return c
	}
	removeChild(c) {
		const idx = this.children.indexOf(c)
		if (idx >= 0) {
			this.children.splice(idx, 1)
			c.parentNode = null
		}
		return c
	}
	remove() {
		if (!this.parentNode) return
		this.parentNode.removeChild(this)
	}
	setAttribute(k, v) {
		this.attrs[k] = String(v)
		if (k === 'id') this.id = String(v)
	}
	getAttribute(k) {
		return this.attrs[k] !== undefined ? this.attrs[k] : null
	}
	addEventListener(t, f) {
		;(this.listeners[t] = this.listeners[t] || []).push(f)
	}
	removeEventListener(t, f) {
		this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f)
	}
	dispatchEvent(ev) {
		const type = ev && ev.type ? ev.type : String(ev)
		const eventObj = Object.assign({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }, typeof ev === 'object' ? ev : { type })
		;(this.listeners[type] || []).slice().forEach((f) => f(eventObj))
		return true
	}
	click() {
		if (this.disabled) return
		this.dispatchEvent({ type: 'click' })
	}
	focus() {}
	blur() {}
	select() {}
	scrollIntoView() {}
	closest(sel) {
		let cur = this
		while (cur) {
			if (sel.startsWith('.') && cur.classList.contains(sel.slice(1))) return cur
			cur = cur.parentNode
		}
		return null
	}
	querySelectorAll(sel) {
		const out = []
		const walk = (n) => {
			for (const c of n.children) {
				if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) out.push(c)
				else if (c.tagName === sel.toUpperCase()) out.push(c)
				walk(c)
			}
		}
		walk(this)
		return out
	}
}

function walkTree(rootNode, fn) {
	if (!rootNode) return
	fn(rootNode)
	for (const c of rootNode.children || []) walkTree(c, fn)
}

function findNode(rootNode, pred) {
	let found = null
	walkTree(rootNode, (n) => {
		if (!found && pred(n)) found = n
	})
	return found
}

function findAllNodes(rootNode, pred) {
	const out = []
	walkTree(rootNode, (n) => {
		if (pred(n)) out.push(n)
	})
	return out
}

function makeManagerHarness(opts) {
	opts = opts || {}
	const docListeners = {}
	const byId = {}
	const manageMenuBtn = new FakeEl('button')
	manageMenuBtn.id = 'serial-protocol-manage'
	const manageRailBtn = new FakeEl('button')
	manageRailBtn.id = 'rail-plugin-manage'
	const manageInlineBtn = new FakeEl('button')
	manageInlineBtn.id = 'serial-protocol-manage-inline'
	const protoSelect = new FakeEl('select')
	protoSelect.id = 'serial-protocol-select'
	protoSelect.value = opts.activeProtocol || 'sek'
	byId['serial-protocol-manage'] = manageMenuBtn
	byId['rail-plugin-manage'] = manageRailBtn
	byId['serial-protocol-manage-inline'] = manageInlineBtn
	byId['serial-protocol-select'] = protoSelect

	const bodyEl = new FakeEl('body')
	const doc = {
		readyState: 'complete',
		body: bodyEl,
		getElementById: (id) => byId[id] || null,
		createElement: (tag) => {
			const el = new FakeEl(tag)
			el._forbidInnerHTML = true
			return el
		},
		addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f) },
		removeEventListener: (t, f) => { docListeners[t] = (docListeners[t] || []).filter((x) => x !== f) },
		dispatchEvent: (ev) => {
			;(docListeners[ev.type] || []).slice().forEach((f) => f(ev))
			return true
		},
	}

	// 可变模拟状态
	const protocols = opts.protocols ? opts.protocols.map((p) => Object.assign({}, p)) : [
		{ id: 'sek', name: '默认 TLV 协议', builtin: true, source: 'builtin', description: '默认内置协议', hidden: false, selectable: true, capabilities: { parse: true, downlink: true, presets: true, customPanel: false } },
		{ id: 'hostproto', name: '模组指令协议', builtin: true, source: 'builtin', description: '模组帧编解码', hidden: false, selectable: true, capabilities: { parse: true, downlink: true, presets: true, customPanel: false } },
		{ id: 'demo-json', name: '示例传感器', builtin: false, source: 'json', version: '1.0.0', description: 'JSON 定义传感器', hidden: false, selectable: true, capabilities: { parse: true, downlink: true, presets: true, customPanel: false } },
		{ id: 'demo-js', name: '示例 JS 协议', builtin: false, source: 'js-local', ownerPluginId: 'p1', description: 'JS 插件协议', hidden: false, selectable: true, capabilities: { parse: true, downlink: false, presets: false, customPanel: false } },
	]
	const savedJson = opts.savedJson ? opts.savedJson.map((x) => Object.assign({}, x)) : [
		{
			id: 'demo-json',
			name: '示例传感器',
			version: '1.0.0',
			description: 'JSON 定义传感器',
			source: 'json',
			spec: { schemaVersion: 1, id: 'demo-json', name: '示例传感器', framing: { head: 'AA 55', fixedLength: 8 } },
		},
		{
			id: 'dir-sensor',
			name: '目录传感器',
			version: '1.0.0',
			description: '来自本地目录',
			source: 'dir-json',
			fileName: 'dir-sensor.json',
			spec: { schemaVersion: 1, id: 'dir-sensor', name: '目录传感器', framing: { head: '55 AA', fixedLength: 6 } },
		},
	]
	const plugins = opts.plugins ? opts.plugins.map((x) => Object.assign({}, x)) : [
		{
			pluginId: 'p1',
			pluginKey: 'local:p1',
			name: '已信任插件',
			fileName: 'trusted.js',
			source: 'js-local',
			enabled: true,
			trusted: true,
			hash: '1111222233334444',
			registeredIds: ['demo-js'],
			error: '',
			code: '// trusted plugin',
		},
	]

	const calls = {
		setProtocol: [],
		setHidden: [],
		setActiveDriver: [],
		setPowerHidden: [],
		activateToolView: [],
		setToolHidden: [],
		upsert: [],
		removeJson: [],
		importJson: [],
		exportJson: [],
		saveLocalPlugin: [],
		trustAndEnable: [],
		setEnabled: [],
		removeLocalPlugin: [],
		openDesktopDir: 0,
		scanDesktopDir: 0,
		downloads: [],
		dialogPanels: [],
	}

	let panelBody = null
	let closePanel = null

	const win = {
		document: doc,
		_activeProtocol: opts.activeProtocol || 'sek',
		Event: function (type) { this.type = type },
		CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail },
		Blob: function (parts) { this.parts = parts },
		URL: {
			createObjectURL: (blob) => {
				const content = blob && blob.parts ? blob.parts.join('') : ''
				calls.downloads.push(content)
				return 'blob:synthetic'
			},
			revokeObjectURL: () => {},
		},
		AppPlatform: {
			has: (id) => (id === 'protocol.manage' ? opts.allowManage !== false : true),
		},
		AppDialog: {
			panel: (o) => {
				calls.dialogPanels.push(o)
				panelBody = new FakeEl('div')
				panelBody._forbidInnerHTML = true
				o.build(panelBody, { close: () => { if (closePanel) closePanel() } })
				return new Promise((resolve) => {
					closePanel = () => {
						closePanel = null
						resolve(undefined)
					}
				})
			},
			confirm: () => { throw new Error('禁止在协议管理面板内嵌套 AppDialog.confirm') },
			prompt: () => { throw new Error('禁止在协议管理面板内嵌套 AppDialog.prompt') },
			alert: () => { throw new Error('禁止在协议管理面板内嵌套 AppDialog.alert') },
		},
		serialLanes: {
			singleTarget: () => 'S',
			protocolOf: (sid) => (opts.laneProtocols && opts.laneProtocols[sid]) || win._activeProtocol,
			setProtocol: (target, id) => {
				calls.setProtocol.push({ target, id })
				if (opts.laneProtocols) opts.laneProtocols[target] = id
				if (target === 'S') win._activeProtocol = id
			},
		},
		ProtocolRegistry: {
			list: (o) => (o && o.includeHidden ? protocols.slice() : protocols.filter((p) => !p.hidden)),
			isHidden: (id) => {
				const p = protocols.find((x) => x.id === id)
				return !!(p && p.hidden)
			},
			setHidden: (id, hidden) => {
				calls.setHidden.push({ id, hidden })
				const visible = protocols.filter((p) => !p.hidden)
				if (hidden && visible.length <= 1 && visible[0] && visible[0].id === id) {
					return { ok: false, error: '至少需要保留一个可见协议' }
				}
				const target = protocols.find((p) => p.id === id)
				if (target) {
					target.hidden = !!hidden
					target.selectable = !target.hidden
				}
				return { ok: true }
			},
		},
		JsonProtocol: {
			EXAMPLES: [
				{
					id: 'sensor-ex',
					label: '传感器示例',
					spec: { schemaVersion: 1, id: 'new-sensor', name: '新传感器', framing: { head: 'AA 55', fixedLength: 8 } },
				},
			],
			listSaved: () => savedJson.slice(),
			validateSpec: (spec) => {
				if (!spec || typeof spec !== 'object') return { ok: false, errors: ['协议必须为对象'] }
				const errs = []
				if (spec.schemaVersion !== 1) errs.push('schemaVersion 必须为 1')
				if (!spec.id || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(spec.id)) errs.push('id 格式不合法')
				if (!spec.name) errs.push('缺少协议名称 name')
				return { ok: errs.length === 0, errors: errs }
			},
			upsert: (spec) => {
				calls.upsert.push(spec)
				const idx = savedJson.findIndex((x) => x.id === spec.id && x.source === 'json')
				const rec = { id: spec.id, name: spec.name, version: spec.version || '1.0.0', description: spec.description || '', source: 'json', spec }
				if (idx >= 0) savedJson[idx] = rec
				else savedJson.push(rec)
				return { ok: true, id: spec.id }
			},
			remove: (id) => {
				calls.removeJson.push(id)
				const idx = savedJson.findIndex((x) => x.id === id && x.source === 'json')
				if (idx < 0) return { ok: false, error: '无法删除' }
				savedJson.splice(idx, 1)
				return { ok: true }
			},
			importJson: (text) => {
				calls.importJson.push(text)
				const parsed = JSON.parse(text)
				const list = Array.isArray(parsed) ? parsed : (parsed.protocols || [parsed])
				const imported = []
				list.forEach((spec) => {
					savedJson.push({ id: spec.id, name: spec.name || spec.id, source: 'json', spec })
					imported.push(spec.id)
				})
				return { ok: true, imported, errors: [] }
			},
			exportJson: (id) => {
				calls.exportJson.push(id || null)
				if (id) {
					const found = savedJson.find((x) => x.id === id)
					return JSON.stringify(found ? found.spec : {}, null, 2)
				}
				return JSON.stringify({ version: 1, protocols: savedJson.filter((x) => x.source === 'json').map((x) => x.spec) }, null, 2)
			},
		},
		JsProtocolPlugin: {
			EXAMPLE_CODE: 'registerProtocol(\'sample-js\', { name: \'示例 JS 协议\', findFrame() { return null }, parseFrame() { return null } })\n',
			EXAMPLE_TEMPLATES: {
				protocol: 'registerProtocol(\'sample-js\', { name: \'示例 JS 协议\', findFrame() { return null }, parseFrame() { return null } })\n',
				powerDriver: 'registerPowerDriver(\'sample-meter\', { name: \'示例电流表\', capabilities: { nominalHz: 100 } })\n',
				tool: 'registerToolPlugin(\'sample-tool\', { name: \'示例工具\', label: \'工具\', icon: \'bi-calculator\' })\n',
			},
			listPlugins: () => plugins.slice(),
			hasDesktopDir: () => !!opts.hasDesktopDir,
			openDesktopDir: () => {
				calls.openDesktopDir++
				return Promise.resolve({ ok: true, dir: '/synthetic/app-data/protocols' })
			},
			scanDesktopDir: () => {
				calls.scanDesktopDir++
				return Promise.resolve({ supported: true, dir: '/synthetic/app-data/protocols', jsonCount: 1, jsCount: 1, untrustedCount: 1, errors: [] })
			},
			saveLocalPlugin: (input) => {
				calls.saveLocalPlugin.push(input)
				const existing = input.pluginId ? plugins.find((p) => p.pluginId === input.pluginId) : null
				if (existing) {
					existing.name = input.name
					existing.fileName = input.fileName
					existing.code = input.code
					existing.trusted = false
					existing.enabled = false
					existing.hash = 'changed-' + input.code.length
					return { ok: true, pluginId: existing.pluginId, pluginKey: existing.pluginKey, needsTrust: true }
				}
				const pid = 'p' + (plugins.length + 1)
				const key = 'local:' + pid
				plugins.push({
					pluginId: pid,
					pluginKey: key,
					name: input.name,
					fileName: input.fileName || (pid + '.js'),
					source: 'js-local',
					enabled: false,
					trusted: false,
					hash: 'hash-' + input.code.length,
					registeredIds: [],
					error: '',
					code: input.code,
				})
				return { ok: true, pluginId: pid, pluginKey: key, needsTrust: true }
			},
			trustAndEnable: (key, expectedHash) => {
				calls.trustAndEnable.push({ key, expectedHash })
				const target = plugins.find((p) => p.pluginKey === key || p.pluginId === key)
				if (!target) return { ok: false, error: '插件不存在' }
				if (expectedHash != null && String(expectedHash) !== String(target.hash)) {
					return { ok: false, error: '插件内容已变更，请重新核对代码后再确认信任' }
				}
				target.trusted = true
				target.enabled = true
				target.registeredIds = ['trusted-proto']
				return { ok: true, registeredIds: ['trusted-proto'] }
			},
			setEnabled: (key, enabled) => {
				calls.setEnabled.push({ key, enabled })
				const target = plugins.find((p) => p.pluginKey === key || p.pluginId === key)
				if (!target) return { ok: false, error: '插件不存在' }
				if (enabled && !target.trusted) return { ok: false, needsTrust: true, error: '尚未信任' }
				target.enabled = !!enabled
				return { ok: true }
			},
			removeLocalPlugin: (key) => {
				calls.removeLocalPlugin.push(key)
				const idx = plugins.findIndex((p) => p.pluginKey === key || p.pluginId === key)
				if (idx < 0) return { ok: false, error: '不存在' }
				plugins.splice(idx, 1)
				return { ok: true }
			},
		},
	}

	if (opts.dualMode) {
		win.SerialHub = { mode: 'dual' }
	}
	if (opts.powerDrivers) {
		const drivers = opts.powerDrivers.map((d) => Object.assign({}, d))
		let activeDriverId = opts.activePowerDriver || (drivers[0] ? drivers[0].id : '')
		win.PowerDriverRegistry = {
			list: (o) => (o && o.includeHidden ? drivers.slice() : drivers.filter((d) => !d.hidden)),
			getActiveId: () => activeDriverId,
			setActiveId: (id) => {
				calls.setActiveDriver.push(id)
				activeDriverId = id
				return { ok: true }
			},
			isHidden: (id) => !!(drivers.find((d) => d.id === id) || {}).hidden,
			setHidden: (id, hidden) => {
				calls.setPowerHidden.push({ id, hidden })
				if (opts.blockPowerHide && opts.blockPowerHide(id, hidden)) {
					return { ok: false, error: '当前激活功耗仪驱动不可隐藏' }
				}
				const t = drivers.find((d) => d.id === id)
				if (t) t.hidden = !!hidden
				return { ok: true }
			},
		}
		win.bluApi = {
			isOpen: () => !!opts.powerBusy,
			isBusyForUpdate: () => !!opts.powerBusy,
			getActiveDriverId: () => activeDriverId,
			setActiveDriver: (id) => {
				calls.setActiveDriver.push(id)
				if (opts.powerBusy) return { ok: false, code: 'busy', message: '功耗仪已连接，请先断开再切换驱动' }
				activeDriverId = id
				return { ok: true }
			},
		}
	}
	if (opts.toolPlugins) {
		const tools = opts.toolPlugins.map((t) => Object.assign({}, t))
		win.ToolPluginRegistry = {
			list: (o) => (o && o.includeHidden ? tools.slice() : tools.filter((t) => !t.hidden)),
			isHidden: (id) => !!(tools.find((t) => t.id === id) || {}).hidden,
			activateView: (viewId) => {
				calls.activateToolView.push(viewId)
				return viewId
			},
			setHidden: (id, hidden) => {
				calls.setToolHidden.push({ id, hidden })
				const t = tools.find((x) => x.id === id)
				if (hidden && t && t.busy) {
					return { ok: false, error: t.busyReason || '该工具正在运行，请先断开' }
				}
				if (t) t.hidden = !!hidden
				return { ok: true }
			},
		}
	}

	const ctx = { window: win, document: doc, console, setTimeout, clearTimeout, Promise }
	vm.createContext(ctx)
	vm.runInContext(managerSrc, ctx)

	return {
		win,
		doc,
		calls,
		protocols,
		savedJson,
		plugins,
		manageMenuBtn,
		manageRailBtn,
		manageInlineBtn,
		get body() { return panelBody },
		close() { if (closePanel) closePanel() },
		btn(text) { return findNode(panelBody, (n) => n.tagName === 'BUTTON' && n.textContent === text) },
		allBtns(text) { return findAllNodes(panelBody, (n) => n.tagName === 'BUTTON' && n.textContent === text) },
	}
}

const flush = () => new Promise((r) => setImmediate(r))
const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('移动端画像（protocol.manage 关闭）不挂载入口且 open() 返回 false', async () => {
	const h = makeManagerHarness({ allowManage: false })
	assert.equal(h.win.ProtocolManager.open(), false)
	assert.equal(h.win.ProtocolManager.isOpen(), false)
	h.manageMenuBtn.click()
	h.manageInlineBtn.click()
	assert.equal(h.calls.dialogPanels.length, 0)
})

test('桌面端三入口可打开面板，三栏切换与关闭生命周期正常', async () => {
	const h = makeManagerHarness()
	h.manageRailBtn.click()
	assert.equal(h.win.ProtocolManager.isOpen(), true)
	assert.equal(h.calls.dialogPanels.length, 1)
	assert.equal(h.calls.dialogPanels[0].title, '插件与协议')
	assert.equal(h.calls.dialogPanels[0].wide, true)

	// 重复点击不排队
	h.manageMenuBtn.click()
	h.manageInlineBtn.click()
	assert.equal(h.calls.dialogPanels.length, 1)

	const tabInstalled = h.btn('已装扩展')
	const tabJson = h.btn('JSON 协议')
	const tabJs = h.btn('JS 插件')
	assert.equal(tabInstalled.getAttribute('aria-pressed'), 'true')
	assert.equal(tabJson.getAttribute('aria-pressed'), 'false')

	tabJson.click()
	assert.equal(tabJson.getAttribute('aria-pressed'), 'true')
	assert.equal(findNode(h.body, (n) => n.classList.contains('pm-pane-json')).hidden, false)
	assert.equal(findNode(h.body, (n) => n.classList.contains('pm-pane-installed')).hidden, true)

	tabJs.click()
	assert.equal(tabJs.getAttribute('aria-pressed'), 'true')
	assert.equal(findNode(h.body, (n) => n.classList.contains('pm-pane-js')).hidden, false)

	h.close()
	await flush()
	assert.equal(h.win.ProtocolManager.isOpen(), false)
})

test('已装协议：搜索过滤、设为当前、显隐开关与保底错误提示还原', async () => {
	const h = makeManagerHarness({
		protocols: [
			{ id: 'sek', name: '默认协议', builtin: true, source: 'builtin', description: '内置默认', hidden: false, selectable: true, capabilities: { parse: true, downlink: true, presets: true, customPanel: false } },
			{ id: 'demo-json', name: '自定义传感器', builtin: false, source: 'json', description: '温度监测', hidden: false, selectable: true, capabilities: { parse: true, downlink: true, presets: false, customPanel: false } },
		],
	})
	h.win.ProtocolManager.open('installed')

	const summary = findNode(h.body, (n) => n.classList.contains('pm-summary'))
	assert.equal(summary.textContent, '已启用 2 / 共 2 个')

	// 搜索过滤
	const search = findNode(h.body, (n) => n.classList.contains('pm-search'))
	search.value = '传感器'
	search.dispatchEvent({ type: 'input' })
	let rows = findAllNodes(h.body, (n) => n.classList.contains('pm-item') && n.dataset.protocolId)
	assert.equal(rows.length, 1)
	assert.equal(rows[0].dataset.protocolId, 'demo-json')

	// 清空搜索
	search.value = ''
	search.dispatchEvent({ type: 'input' })

	// 设为当前
	const setBtn = h.btn('设为当前')
	assert.ok(setBtn)
	setBtn.click()
	assert.deepEqual(h.calls.setProtocol, [{ target: 'S', id: 'demo-json' }])

	// 隐藏 demo-json 成功
	const demoRow = findNode(h.body, (n) => n.dataset.protocolId === 'demo-json')
	const demoSw = findNode(demoRow, (n) => n.tagName === 'INPUT' && n.type === 'checkbox')
	demoSw.checked = false
	demoSw.dispatchEvent({ type: 'change' })
	assert.equal(h.protocols.find((p) => p.id === 'demo-json').hidden, true)
	assert.equal(summary.textContent, '已启用 1 / 共 2 个')

	// 尝试隐藏最后一个可见协议 sek -> 拒绝、显示错误、还原勾选
	const sekRow = findNode(h.body, (n) => n.dataset.protocolId === 'sek')
	const sekSw = findNode(sekRow, (n) => n.tagName === 'INPUT' && n.type === 'checkbox')
	sekSw.checked = false
	sekSw.dispatchEvent({ type: 'change' })
	assert.equal(sekSw.checked, true, '最后一个可见协议被拒后应还原勾选状态')
	const notice = findNode(h.body, (n) => n.classList.contains('pm-notice'))
	const noticeText = findNode(notice, (n) => n.classList.contains('pm-notice-text'))
	assert.equal(notice.hidden, false)
	assert.ok(noticeText && noticeText.textContent.includes('至少需要保留一个可见协议'))

	// 外部 serial-protocol-registry-change 事件触发刷新
	h.protocols.push({ id: 'live-added', name: '热加载协议', builtin: false, source: 'json', description: '事件刷新', hidden: false, selectable: true, capabilities: { parse: true, downlink: false, presets: false, customPanel: false } })
	h.doc.dispatchEvent({ type: 'serial-protocol-registry-change' })
	assert.ok(findNode(h.body, (n) => n.dataset.protocolId === 'live-added'))

	// 自定义 JSON 快捷「编辑」跳到 JSON Tab
	const editBtn = findNode(findNode(h.body, (n) => n.dataset.protocolId === 'demo-json'), (n) => n.tagName === 'BUTTON' && n.textContent === '编辑')
	editBtn.click()
	assert.equal(findNode(h.body, (n) => n.classList.contains('pm-pane-json')).hidden, false)

	h.close()
	await flush()
})

test('JSON 协议：模板新建、校验成功/失败、保存、覆盖内联确认、目录只读与两步删除（零嵌套 AppDialog）', async () => {
	const h = makeManagerHarness()
	h.win.ProtocolManager.open('json')

	// 目录 JSON 只读，无删除键
	const dirRow = findNode(h.body, (n) => n.dataset.jsonId === 'dir-sensor')
	assert.ok(dirRow)
	assert.ok(findNode(dirRow, (n) => n.textContent === '来自本地插件目录'))
	assert.equal(findNode(dirRow, (n) => n.tagName === 'BUTTON' && n.textContent === '删除'), null)

	// 点击新建协议填充模板
	h.btn('新建协议').click()
	const editor = findNode(findNode(h.body, (n) => n.classList.contains('pm-pane-json')), (n) => n.tagName === 'TEXTAREA')
	assert.ok(editor.value.includes('new-sensor'))

	// 非法 JSON 校验报错
	editor.value = '{bad json'
	editor.dispatchEvent({ type: 'input' })
	h.btn('校验格式').click()
	const valBox = findNode(h.body, (n) => n.classList.contains('pm-validate-box'))
	assert.equal(valBox.hidden, false)
	assert.ok(valBox.classList.contains('is-error'))
	assert.ok(findNode(valBox, (n) => n.textContent.includes('JSON 语法错误')))

	// 合法模板校验并保存
	h.btn('新建协议').click()
	h.btn('校验格式').click()
	assert.ok(valBox.classList.contains('is-ok'))
	assert.ok(findNode(valBox, (n) => n.textContent === '校验通过'))

	h.btn('保存并启用').click()
	assert.equal(h.calls.upsert.length, 1)
	assert.equal(h.calls.upsert[0].id, 'new-sensor')

	// 新建时填已有 ID -> 弹出内联覆盖确认而非 AppDialog.confirm
	h.btn('新建协议').click()
	editor.value = JSON.stringify({ schemaVersion: 1, id: 'demo-json', name: '覆盖版传感器' })
	editor.dispatchEvent({ type: 'input' })
	h.btn('保存并启用').click()
	assert.equal(h.calls.upsert.length, 1, '覆盖前必须等内联确认')
	const confirmOverwrite = h.btn('确认覆盖')
	assert.ok(confirmOverwrite, '应展开内联确认覆盖按钮')
	confirmOverwrite.click()
	assert.equal(h.calls.upsert.length, 2)
	assert.equal(h.calls.upsert[1].name, '覆盖版传感器')

	// 两步删除本地 JSON 协议
	const newRow = findNode(h.body, (n) => n.dataset.jsonId === 'new-sensor')
	const delBtn = findNode(newRow, (n) => n.tagName === 'BUTTON' && n.textContent === '删除')
	delBtn.click()
	assert.equal(h.calls.removeJson.length, 0, '第一次点击只进入确认态')
	const rowArmed = findNode(h.body, (n) => n.dataset.jsonId === 'new-sensor')
	const confirmDel = findNode(rowArmed, (n) => n.tagName === 'BUTTON' && n.textContent === '确认删除')
	assert.ok(confirmDel)
	confirmDel.click()
	assert.deepEqual(h.calls.removeJson, ['new-sensor'])

	// 导入 JSON 文件
	const jsonFileInput = findNode(findNode(h.body, (n) => n.classList.contains('pm-pane-json')), (n) => n.tagName === 'INPUT' && n.type === 'file')
	jsonFileInput.files = [{ name: 'imp.json', text: () => Promise.resolve(JSON.stringify({ schemaVersion: 1, id: 'imp-sensor', name: '导入传感器' })) }]
	jsonFileInput.dispatchEvent({ type: 'change' })
	await flush()
	assert.equal(h.calls.importJson.length, 1)
	assert.ok(findNode(h.body, (n) => n.dataset.jsonId === 'imp-sensor'))

	// 导出全部 JSON
	h.btn('导出全部 JSON').click()
	assert.equal(h.calls.exportJson.length, 1)
	assert.equal(h.calls.downloads.length, 1)

	h.close()
	await flush()
})

test('JS 插件：安全风险横幅、桌面目录操作、导入默认未执行 + 内联两步信任启用 + 两步删除', async () => {
	const h = makeManagerHarness({ hasDesktopDir: true })
	h.win.ProtocolManager.open('js')

	// 顶部安全风险提示条
	const banner = findNode(h.body, (n) => n.classList.contains('pm-security-banner'))
	assert.ok(banner)
	assert.ok(banner.children.some((c) => c.textContent.includes('串口收发') && c.textContent.includes('密钥与配置') && c.textContent.includes('操作页面 DOM')))

	// 桌面本地目录栏可见且可打开/扫描
	const dirBar = findNode(h.body, (n) => n.classList.contains('pm-dir-bar'))
	assert.equal(dirBar.hidden, false)
	h.btn('打开插件目录').click()
	await flush()
	assert.equal(h.calls.openDesktopDir, 1)
	h.btn('重新扫描').click()
	await flush()
	assert.equal(h.calls.scanDesktopDir, 1)
	assert.equal(findNode(dirBar, (n) => n.classList.contains('pm-dir-path')).textContent, '/synthetic/app-data/protocols')

	// 导入 .js 插件 -> 调用 saveLocalPlugin，绝不自动调用 trustAndEnable
	const fileInput = findNode(findNode(h.body, (n) => n.classList.contains('pm-pane-js')), (n) => n.tagName === 'INPUT' && n.type === 'file')
	fileInput.files = [{ name: 'ext-demo.js', text: () => Promise.resolve('registerProtocol("ext-demo", { name: "外部" })') }]
	fileInput.dispatchEvent({ type: 'change' })
	await flush()

	assert.equal(h.calls.saveLocalPlugin.length, 1)
	assert.equal(h.calls.trustAndEnable.length, 0, '导入后默认必须未信任、未执行')
	const importedCard = findNode(h.body, (n) => n.dataset.pluginKey === 'local:p2')
	assert.ok(importedCard)
	assert.ok(findNode(importedCard, (n) => n.textContent.includes('待确认安全风险')))

	// 点击「信任并启用…」-> 展开内联风险确认条带，仍未执行
	const trustBtn = findNode(importedCard, (n) => n.tagName === 'BUTTON' && n.textContent === '信任并启用…')
	trustBtn.click()
	assert.equal(h.calls.trustAndEnable.length, 0)
	const confirmTrustBtn = h.btn('我已知晓风险，信任并启用')
	assert.ok(confirmTrustBtn, '必须展示内联风险确认主按钮')
	confirmTrustBtn.click()
	const expectedHash = 'hash-' + 'registerProtocol("ext-demo", { name: "外部" })'.length
	assert.deepEqual(h.calls.trustAndEnable, [{ key: 'local:p2', expectedHash }])

	// 信任后可通过开关停用
	const trustedCard = findNode(h.body, (n) => n.dataset.pluginKey === 'local:p2')
	const enSw = findNode(trustedCard, (n) => n.tagName === 'INPUT' && n.type === 'checkbox')
	assert.equal(enSw.checked, true)
	enSw.checked = false
	enSw.dispatchEvent({ type: 'change' })
	assert.deepEqual(h.calls.setEnabled, [{ key: 'local:p2', enabled: false }])

	// 编辑并保存源码后（内容变化）重新回到待确认安全风险状态
	const editCodeBtn = findNode(findNode(h.body, (n) => n.dataset.pluginKey === 'local:p2'), (n) => n.tagName === 'BUTTON' && n.textContent === '编辑源码')
	editCodeBtn.click()
	const jsTextarea = findNode(findNode(h.body, (n) => n.classList.contains('pm-pane-js')), (n) => n.tagName === 'TEXTAREA')
	jsTextarea.value = 'registerProtocol("ext-demo", { name: "外部修改版" })'
	jsTextarea.dispatchEvent({ type: 'input' })
	h.btn('保存源码').click()
	const updatedCard = findNode(h.body, (n) => n.dataset.pluginKey === 'local:p2')
	assert.ok(findNode(updatedCard, (n) => n.textContent.includes('待确认安全风险')), '源码修改后应重新回到待信任状态')

	// 两步删除本地 JS 插件
	const cardForDel = findNode(h.body, (n) => n.dataset.pluginKey === 'local:p2')
	findNode(cardForDel, (n) => n.tagName === 'BUTTON' && n.textContent === '删除').click()
	assert.equal(h.calls.removeLocalPlugin.length, 0)
	const cardArmed = findNode(h.body, (n) => n.dataset.pluginKey === 'local:p2')
	findNode(cardArmed, (n) => n.tagName === 'BUTTON' && n.textContent === '确认删除').click()
	assert.deepEqual(h.calls.removeLocalPlugin, ['local:p2'])

	h.close()
	await flush()
})

test('XSS 防护：恶意协议名/描述/插件名经 textContent 渲染，不注入任何 img/script DOM', async () => {
	const xss = '<img src=x onerror=alert(1)><script>window.__pwn=1</script>'
	const h = makeManagerHarness({
		protocols: [
			{ id: 'evil-proto', name: xss, builtin: false, source: 'json', description: xss, hidden: false, selectable: true, capabilities: { parse: true, downlink: false, presets: false, customPanel: false } },
		],
		savedJson: [
			{ id: 'evil-proto', name: xss, description: xss, source: 'json', spec: { schemaVersion: 1, id: 'evil-proto', name: xss } },
		],
		plugins: [
			{ pluginId: 'px', pluginKey: 'local:px', name: xss, fileName: xss + '.js', source: 'js-local', enabled: false, trusted: false, hash: 'abcd', registeredIds: [], error: xss, code: xss },
		],
	})
	h.win.ProtocolManager.open('installed')
	assert.ok(findNode(h.body, (n) => n.textContent === xss))
	assert.equal(findNode(h.body, (n) => n.tagName === 'IMG' || n.tagName === 'SCRIPT'), null)

	h.btn('JSON 协议').click()
	assert.ok(findNode(h.body, (n) => n.textContent === xss))
	assert.equal(findNode(h.body, (n) => n.tagName === 'IMG' || n.tagName === 'SCRIPT'), null)

	h.btn('JS 插件').click()
	assert.ok(findNode(h.body, (n) => n.textContent === xss))
	assert.equal(findNode(h.body, (n) => n.tagName === 'IMG' || n.tagName === 'SCRIPT'), null)

	h.close()
	await flush()
})

test('命令面板：注册「协议管理」与动态「切换协议：<名称>」命令并受平台门控', async () => {
	function runPalette(allowManage) {
		const byId = {}
		const body = new FakeEl('body')
		const doc = {
			body,
			getElementById: (id) => byId[id] || null,
			querySelector: () => null,
			createElement: (tag) => new FakeEl(tag),
			addEventListener() {},
		}
		// 替换 buildDom 需要的节点查找（FakeEl 赋值 innerHTML 模拟，这里用轻量 DOM 捕渲染 HTML）
		let openedManager = 0
		const switched = []
		const win = {
			document: doc,
			navigator: { platform: 'MacIntel', userAgent: '' },
			localStorage: { getItem: () => null },
			_activeProtocol: 'sek',
			AppPlatform: { has: (f) => (f === 'protocol.manage' ? allowManage : true) },
			ProtocolManager: { open: () => { openedManager++ } },
			ProtocolRegistry: {
				list: () => [
					{ id: 'sek', name: '默认 TLV 协议' },
					{ id: 'custom-sensor', name: '自定义传感器' },
				],
			},
			serialLanes: {
				singleTarget: () => 'S',
				setProtocol: (t, id) => switched.push({ t, id }),
			},
		}
		// 命令面板 buildDom 写 overlay.innerHTML，需要支持 getElementById('serial-cmdk-input'/'serial-cmdk-list')
		const inp = new FakeEl('input')
		inp.id = 'serial-cmdk-input'
		const listBox = new FakeEl('div')
		listBox.id = 'serial-cmdk-list'
		byId['serial-cmdk-input'] = inp
		byId['serial-cmdk-list'] = listBox

		const ctx = {
			window: win,
			document: doc,
			navigator: win.navigator,
			localStorage: win.localStorage,
			getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
			Event: function (t) { this.type = t },
			console,
		}
		vm.createContext(ctx)
		vm.runInContext(paletteSrc, ctx)
		win.serialCommandPalette.open()
		return { win, inp, listBox, get openedManager() { return openedManager }, switched }
	}

	// 桌面端：含「插件与协议管理」与动态「切换协议」
	const desk = runPalette(true)
	assert.ok(desk.listBox.innerHTML.includes('插件与协议管理（切换 / 启停 / JSON 与 JS 扩展）'))
	assert.ok(desk.listBox.innerHTML.includes('切换协议：默认 TLV 协议'))
	assert.ok(desk.listBox.innerHTML.includes('切换协议：自定义传感器'))

	// 搜索并执行「协议管理」
	desk.inp.value = '协议管理'
	desk.inp.dispatchEvent({ type: 'input' })
	desk.inp.dispatchEvent({ type: 'keydown', key: 'Enter' })
	assert.equal(desk.openedManager, 1)

	// 搜索并执行「切换协议：自定义传感器」
	desk.win.serialCommandPalette.open()
	desk.inp.value = '切换协议：自定义传感器'
	desk.inp.dispatchEvent({ type: 'input' })
	desk.inp.dispatchEvent({ type: 'keydown', key: 'Enter' })
	assert.deepEqual(desk.switched, [{ t: 'S', id: 'custom-sensor' }])

	// 移动端：门控隐藏「插件与协议管理」
	const mob = runPalette(false)
	assert.equal(mob.listBox.innerHTML.includes('插件与协议管理（切换 / 启停 / JSON 与 JS 扩展）'), false)
	assert.ok(mob.listBox.innerHTML.includes('切换协议：默认 TLV 协议'))
})

test('插件与协议：复制开发提示词按钮与 buildDevPrompt 覆盖 JSON / 通信 JS / 功耗仪驱动 / 左栏工具 / 完整规范', async () => {
	const h = makeManagerHarness()
	const copied = []
	h.win.navigator = {
		clipboard: {
			writeText(text) {
				copied.push(text)
				return Promise.resolve()
			},
		},
	}
	assert.equal(h.win.ProtocolManager.open('installed'), true)
	const body = h.body
	const btns = findAllNodes(body, el => el.className && el.className.includes('pm-prompt-btn'))
	assert.equal(btns.length, 5, '应提供 JSON / 通信协议 / 功耗仪驱动 / 左栏工具 / 完整规范 五个复制提示词按钮')
	for (const b of btns) b.click()
	await new Promise(r => setTimeout(r, 10))
	assert.equal(copied.length, 5)
	assert.ok(copied[0].includes('schemaVersion') && copied[0].includes('checksum') && copied[0].includes('presets'))
	assert.ok(copied[1].includes('registerProtocol') && copied[1].includes('logView') && copied[1].includes('randomTest') && copied[1].includes('subTabs'))
	assert.ok(copied[2].includes('registerPowerDriver') && copied[2].includes('createSession'))
	assert.ok(copied[3].includes('registerToolPlugin') && copied[3].includes('mount'))
	assert.ok(copied[4].includes('schemaVersion') && copied[4].includes('registerProtocol') && copied[4].includes('registerPowerDriver') && copied[4].includes('registerToolPlugin'))
})

test('已装扩展：分类筛选、设备面板/PCP 徽标、双路 A/B 一键切换、功耗仪驱动与左栏工具控制', async () => {
	const h = makeManagerHarness({
		dualMode: true,
		laneProtocols: { A: 'sek', B: 'hostproto' },
		protocols: [
			{ id: 'sek', name: '默认 TLV', builtin: true, source: 'builtin', hidden: false, selectable: true, firmware: { method: 'pcp' }, capabilities: { parse: true, downlink: true, presets: true, customPanel: false, device: true } },
			{ id: 'hostproto', name: '模组协议', builtin: true, source: 'builtin', hidden: false, selectable: true, capabilities: { parse: true, downlink: true, presets: true, customPanel: false, device: false } },
		],
		powerDrivers: [
			{ id: 'blu100k', name: 'BLU 100k', shortName: 'BLU 100k', builtin: true, source: 'builtin', hidden: false, selectable: true, capabilities: { nominalHz: 100000, voltage: { supported: true, minMv: 800, maxMv: 5000 }, dutPower: { supported: true }, logicBits: 8 } },
			{ id: 'csv-meter', name: 'CSV 电流表', shortName: 'CSV', builtin: false, source: 'js-local', ownerPluginId: 'local:p1', hidden: false, selectable: true, capabilities: { nominalHz: 100, voltage: { supported: false }, dutPower: { supported: false }, logicBits: 0 } },
		],
		activePowerDriver: 'blu100k',
		powerBusy: true,
		toolPlugins: [
			{ id: 'power', name: '功耗分析', label: '功耗分析', viewId: 'view-blu', builtin: true, source: 'builtin', hidden: false, busy: true, busyReason: '功耗仪已连接，请先断开后再隐藏' },
			{ id: 'hex-calc', name: 'HEX 校验器', label: '校验器', viewId: 'view-plugin-hex-calc', builtin: false, source: 'js-local', ownerPluginId: 'local:p1', hidden: false, busy: false },
		],
		plugins: [
			{ pluginId: 'p1', pluginKey: 'local:p1', name: '多能力插件', fileName: 'multi.js', source: 'js-local', enabled: true, trusted: true, hash: 'aaa', registeredIds: ['demo-js'], registeredPowerIds: ['csv-meter'], registeredToolIds: ['hex-calc'], error: '', code: '// multi' },
		],
	})

	h.win.ProtocolManager.open('installed', { filter: 'all' })

	// 1) 通信协议徽标与双路按钮
	const sekRow = findNode(h.body, (n) => n.dataset.protocolId === 'sek')
	assert.ok(findNode(sekRow, (n) => n.classList.contains('pm-cap') && n.textContent === '设备面板'))
	assert.ok(findNode(sekRow, (n) => n.classList.contains('pm-cap') && n.textContent === 'PCP 固件'))
	assert.ok(findNode(sekRow, (n) => n.textContent === 'A 路使用中'))
	const setB = findNode(sekRow, (n) => n.tagName === 'BUTTON' && n.textContent === '设为 B 路')
	assert.ok(setB)
	setB.click()
	assert.deepEqual(h.calls.setProtocol, [{ target: 'B', id: 'sek' }])

	// 2) 切换到「功耗仪协议」筛选：仅显示功耗仪行，检查能力徽标与连接中切换拦截
	h.btn('功耗仪协议').click()
	assert.equal(findAllNodes(h.body, (n) => n.dataset.protocolId).length, 0)
	const bluRow = findNode(h.body, (n) => n.dataset.powerDriverId === 'blu100k')
	assert.ok(findNode(bluRow, (n) => n.classList.contains('pm-cap') && n.textContent === '100kHz'))
	assert.ok(findNode(bluRow, (n) => n.classList.contains('pm-cap') && n.textContent === '程控调压'))
	assert.ok(findNode(bluRow, (n) => n.classList.contains('pm-cap') && n.textContent === '上下电'))
	const csvRow = findNode(h.body, (n) => n.dataset.powerDriverId === 'csv-meter')
	const setDrvBtn = findNode(csvRow, (n) => n.tagName === 'BUTTON' && n.textContent === '设为当前驱动')
	assert.ok(setDrvBtn)
	setDrvBtn.click()
	const noticeText = findNode(h.body, (n) => n.classList.contains('pm-notice-text'))
	assert.ok(noticeText && noticeText.textContent.includes('请先断开'))

	// 3) 切换到「左栏工具」筛选：忙碌态拦截隐藏并还原勾选框；空闲工具点击「打开视图」跳转并关闭面板
	h.btn('左栏工具').click()
	assert.equal(findAllNodes(h.body, (n) => n.dataset.powerDriverId).length, 0)
	const pwrToolRow = findNode(h.body, (n) => n.dataset.toolPluginId === 'power')
	const pwrSw = findNode(pwrToolRow, (n) => n.tagName === 'INPUT' && n.type === 'checkbox')
	pwrSw.checked = false
	pwrSw.dispatchEvent({ type: 'change' })
	assert.equal(pwrSw.checked, true, '忙碌态拦截隐藏后应还原勾选框')
	assert.ok(findNode(h.body, (n) => n.classList.contains('pm-notice-text')).textContent.includes('功耗仪已连接'))

	// 切到 JS 插件栏测试三套模板选择与多能力徽标显示
	h.btn('JS 插件').click()
	const p1Card = findNode(h.body, (n) => n.dataset.pluginKey === 'local:p1')
	assert.ok(findNode(p1Card, (n) => n.textContent === '协议: demo-js'))
	assert.ok(findNode(p1Card, (n) => n.textContent === '功耗仪: csv-meter'))
	assert.ok(findNode(p1Card, (n) => n.textContent === '工具: hex-calc'))

	const jsPane = findNode(h.body, (n) => n.classList.contains('pm-pane-js'))
	const tplSel = findNode(jsPane, (n) => n.tagName === 'SELECT')
	assert.equal(tplSel.options.length, 3)
	tplSel.value = 'powerDriver'
	tplSel.dispatchEvent({ type: 'change' })
	h.btn('新建示例插件').click()
	const jsTa = findNode(jsPane, (n) => n.tagName === 'TEXTAREA')
	assert.ok(jsTa.value.includes('registerPowerDriver'))

	tplSel.value = 'tool'
	tplSel.dispatchEvent({ type: 'change' })
	h.btn('新建示例插件').click()
	assert.ok(jsTa.value.includes('registerToolPlugin'))

	// 回到左栏工具点击「打开视图」应激活视图并关闭面板
	h.btn('已装扩展').click()
	h.btn('左栏工具').click()
	const calcToolRow = findNode(h.body, (n) => n.dataset.toolPluginId === 'hex-calc')
	findNode(calcToolRow, (n) => n.tagName === 'BUTTON' && n.textContent === '打开视图').click()
	assert.deepEqual(h.calls.activateToolView, ['view-plugin-hex-calc'])
	await flush()
	assert.equal(h.win.ProtocolManager.isOpen(), false)
})

test('命令面板：联动 ToolPluginRegistry 与 PowerDriverRegistry（功耗隐藏时隐藏功耗命令，列出外部工具与功耗仪协议）', () => {
	function openWith(powerHidden) {
		const byId = {}
		const body = new FakeEl('body')
		const doc = {
			body,
			getElementById: (id) => byId[id] || null,
			querySelector: () => null,
			createElement: (tag) => new FakeEl(tag),
			addEventListener() {},
		}
		const activatedViews = []
		const switchedDrivers = []
		const win = {
			document: doc,
			navigator: { platform: 'MacIntel', userAgent: '' },
			localStorage: { getItem: () => null },
			_activeProtocol: 'sek',
			AppPlatform: { has: () => true },
			ToolPluginRegistry: {
				isHidden: (id) => id === 'power' && powerHidden,
				list: () => [
					{ id: 'power', name: '功耗分析', viewId: 'view-blu', hidden: powerHidden },
					{ id: 'hex-calc', name: 'HEX 校验器', viewId: 'view-plugin-hex-calc', hidden: false },
				],
				activateView: (vid) => activatedViews.push(vid),
			},
			PowerDriverRegistry: {
				list: () => [{ id: 'blu100k', name: 'BLU 100k', hidden: false }, { id: 'csv-meter', name: 'CSV 电流表', hidden: false }],
				getActiveId: () => 'blu100k',
				setActiveId: (id) => switchedDrivers.push(id),
			},
		}
		const inp = new FakeEl('input')
		inp.id = 'serial-cmdk-input'
		const listBox = new FakeEl('div')
		listBox.id = 'serial-cmdk-list'
		byId['serial-cmdk-input'] = inp
		byId['serial-cmdk-list'] = listBox
		const ctx = {
			window: win,
			document: doc,
			navigator: win.navigator,
			localStorage: win.localStorage,
			getComputedStyle: () => ({ display: 'none', visibility: 'hidden' }),
			Event: function (t) { this.type = t },
			console,
		}
		vm.createContext(ctx)
		vm.runInContext(paletteSrc, ctx)
		win.serialCommandPalette.open()
		return { win, inp, listBox, activatedViews, switchedDrivers }
	}

	const vis = openWith(false)
	assert.ok(vis.listBox.innerHTML.includes('切换到功耗分析'))
	assert.ok(vis.listBox.innerHTML.includes('打开串口发送'))
	assert.ok(vis.listBox.innerHTML.includes('切换到：HEX 校验器'))
	assert.ok(vis.listBox.innerHTML.includes('切换功耗仪协议：CSV 电流表'))

	const hid = openWith(true)
	assert.equal(hid.listBox.innerHTML.includes('切换到功耗分析'), false, '隐藏功耗工具后不列功耗视图命令')
	assert.equal(hid.listBox.innerHTML.includes('打开串口发送'), false, '隐藏功耗工具后不列串口发送面板命令')
	assert.equal(hid.listBox.innerHTML.includes('切换功耗仪协议：CSV 电流表'), false, '隐藏功耗工具后不列功耗仪协议命令')
	assert.ok(hid.listBox.innerHTML.includes('切换到：HEX 校验器'))
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
