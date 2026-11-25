// Run: node tests/js-protocol-plugin.cjs — synthetic data only.
// 覆盖：js/js-protocol-plugin.js 同步哈希指纹、信任门控铁律、registerProtocol/module.exports 两种形态、内置 ID 保护、XSS 隔离、桌面目录扫描与卸载。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function createEnv(opts) {
	opts = opts || {}
	const store = new Map()
	const registered = {}
	const events = []
	const services = new Map()

	const localStorage = {
		getItem(k) { return store.has(k) ? store.get(k) : null },
		setItem(k, v) { store.set(k, String(v)) },
		removeItem(k) { store.delete(k) },
	}

	const AppPlatform = {
		provide(name, impl) { services.set(name, impl) },
		service(name) { return services.get(name) || null },
	}

	const document = {
		dispatchEvent(ev) { events.push(ev.type) },
	}
	function CustomEvent(type, detail) {
		this.type = type
		this.detail = detail
	}

	const window = {
		localStorage,
		AppPlatform,
		_protocols: registered,
		__sideEffects: 0,
		registerProtocol(id, impl) {
			registered[id] = impl
			return true
		},
		unregisterProtocol(id) {
			delete registered[id]
			return { ok: true }
		},
	}

	if (opts.withRegistry) {
		window.ProtocolRegistry = {
			RESERVED_IDS: ['sek', 'wmbus', 'gz', 'cjt188', 'sk-ultrasonic', 'hostproto', 'cellular-at'],
			register(id, impl) {
				if (impl.builtin !== true && this.RESERVED_IDS.includes(id)) {
					throw new Error('保留协议 ID 不可占用：' + id)
				}
				registered[id] = impl
				return true
			},
			unregister(id) {
				delete registered[id]
				return { ok: true }
			},
			get(id) { return registered[id] || null },
			has(id) { return !!registered[id] },
		}
	}

	const ctx = {
		window,
		globalThis: window,
		localStorage,
		document,
		CustomEvent,
		Uint8Array,
		Uint32Array,
		ArrayBuffer,
		DataView,
		TextEncoder,
		TextDecoder,
		console,
	}
	vm.createContext(ctx)
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/parse-view.js'), 'utf8'), ctx)
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/json-protocol.js'), 'utf8'), ctx)
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/js-protocol-plugin.js'), 'utf8'), ctx)
	return {
		window,
		registered,
		store,
		events,
		AppPlatform,
		JP: window.JsonProtocol,
		JSP: window.JsProtocolPlugin,
		PV: window.ParseView,
	}
}

const J = x => JSON.parse(JSON.stringify(x))

async function run() {
	// 1. 确定性同步 SHA-256 哈希向量验证
	{
		const { JSP } = createEnv()
		assert.equal(JSP.hashCode(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
		assert.equal(JSP.hashCode('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
		assert.equal(JSP.hashCode('中文协议插件'), JSP.hashCode('中文协议插件'))
		assert.notEqual(JSP.hashCode('a'), JSP.hashCode('b'))
	}

	// 2. 示例插件源码完整执行与往返验证
	{
		const { JSP, registered } = createEnv({ withRegistry: true })
		const saved = JSP.saveLocalPlugin({ pluginId: 'sample-echo', name: '示例回声', code: JSP.EXAMPLE_CODE })
		assert.equal(saved.ok, true)
		assert.equal(saved.needsTrust, true)
		assert.equal(registered['demo-js-echo'], undefined, '未信任前绝不可执行插件')

		const trusted = JSP.trustAndEnable(saved.pluginKey)
		assert.equal(trusted.ok, true)
		assert.deepEqual(J(trusted.registeredIds), ['demo-js-echo'])

		const proto = registered['demo-js-echo']
		assert.equal(proto.builtin, false)
		assert.equal(proto.source, 'js-local')
		assert.equal(proto.ownerPluginId, 'local:sample-echo')

		const frame = proto.buildDownFrame({ cmd: 0x01, payloadHex: '50 49 4E 47' })
		const found = proto.findFrame(Uint8Array.from([0x00, ...frame, 0xFF]))
		assert.equal(found.found, true)
		assert.equal(found.offset, 1)
		const parsed = proto.parseFrame(found.frame)
		assert.equal(parsed.ok, true)
		const lv = proto.logView(parsed)
		assert.equal(lv.title, '心跳请求')
		assert.equal(lv.code, '0x01')
	}

	// 3. 安全门控铁律：未信任拒绝、改代码失信卸载、篡改 localStorage 拒绝、停用/重启用与删除
	{
		const { window, JSP, registered, store, events } = createEnv({ withRegistry: true })
		const codeV1 = `
			globalThis.__sideEffects += 1
			module.exports = {
				id: 'custom-mod-exp',
				name: '模块导出测试',
				parseFrame(b) { return { ok: true, raw: b } },
				logView() { return { title: 'V1' } },
			}
		`
		const s1 = JSP.saveLocalPlugin({ pluginId: 'mod-p', name: '模块插件', code: codeV1 })
		assert.equal(s1.ok, true)
		assert.equal(s1.needsTrust, true)
		assert.equal(window.__sideEffects, 0, '保存未信任插件时绝对不能执行代码')

		// 未信任直接 setEnabled(true) 必须拒绝
		const enDeny = JSP.setEnabled('local:mod-p', true)
		assert.equal(enDeny.ok, false)
		assert.equal(enDeny.needsTrust, true)
		assert.equal(window.__sideEffects, 0)

		// 信任并启用
		const tr = JSP.trustAndEnable('mod-p')
		assert.equal(tr.ok, true)
		assert.deepEqual(J(tr.registeredIds), ['custom-mod-exp'])
		assert.equal(window.__sideEffects, 1)
		assert.equal(registered['custom-mod-exp'].logView().title, 'V1')

		// 停用 → 卸载协议；哈希未变再启用 → 重新执行
		assert.equal(JSP.setEnabled('local:mod-p', false).ok, true)
		assert.equal(registered['custom-mod-exp'], undefined)
		assert.equal(JSP.setEnabled('local:mod-p', true).ok, true)
		assert.equal(window.__sideEffects, 2)
		assert.ok(registered['custom-mod-exp'])

		// 修改源码 → 自动失信并卸载旧协议，且绝不执行新源码
		const codeV2 = codeV1.replace("'V1'", "'V2'")
		const s2 = JSP.saveLocalPlugin({ pluginId: 'mod-p', name: '模块插件', code: codeV2 })
		assert.equal(s2.ok, true)
		assert.equal(s2.needsTrust, true)
		assert.equal(registered['custom-mod-exp'], undefined, '修改代码后应立即卸载旧协议')
		assert.equal(window.__sideEffects, 2, '修改代码后未再次信任前绝不能执行')

		// 模拟外部直接篡改 localStorage（把 enabled 改为 true 但不匹配信任哈希）
		const rawList = JSON.parse(store.get(JSP.STORAGE_KEY))
		rawList[0].enabled = true
		store.set(JSP.STORAGE_KEY, JSON.stringify(rawList))
		const bootRes = JSP.loadSavedIntoRegistry()
		assert.deepEqual(J(bootRes.loaded), [])
		assert.equal(window.__sideEffects, 2, '篡改源码且哈希不匹配时启动加载必须拒绝执行')

		// 再次信任后执行 V2
		assert.equal(JSP.trustAndEnable('local:mod-p').ok, true)
		assert.equal(registered['custom-mod-exp'].logView().title, 'V2')

		// 删除本地插件：卸载协议并清理存储与信任哈希
		assert.equal(JSP.removeLocalPlugin('mod-p').ok, true)
		assert.equal(registered['custom-mod-exp'], undefined)
		assert.equal(JSP.listPlugins().length, 0)
		assert.equal(JSON.parse(store.get(JSP.TRUST_KEY))['local:mod-p'], undefined)
		assert.ok(events.includes('serial-protocol-plugins-change'))
	}

	// 4. 内置保留 ID 保护
	{
		const { JSP, registered } = createEnv({ withRegistry: true })
		registered.sek = { id: 'sek', name: 'SEK', builtin: true }
		for (const id of ['sek', 'wmbus', 'gz', 'cjt188', 'sk-ultrasonic', 'hostproto', 'cellular-at']) {
			const pid = 'hijack-' + id
			JSP.saveLocalPlugin({
				pluginId: pid,
				name: '尝试抢注 ' + id,
				code: `registerProtocol('${id}', { name: '恶意覆盖', parseFrame() { return { ok: true } } })`,
			})
			const res = JSP.trustAndEnable('local:' + pid)
			assert.equal(res.ok, false, '应拦截抢注保留 ID：' + id)
			assert.ok(res.error.includes('保留'))
		}
		assert.equal(registered.sek.builtin, true, '内置协议 sek 不得被覆盖')
	}

	// 5. XSS 结构化隔离回归（无 ProtocolRegistry 独立模式下同样防御）
	{
		const { JSP, PV, registered } = createEnv({ withRegistry: false })
		const xssCode = `
			registerProtocol('xss-probe', {
				name: 'XSS 测试',
				parseFrame(b) { return { ok: true, raw: b } },
				logView() {
					return {
						title: '测试帧',
						sections: [{ title: '载荷', html: '<img src=x onerror=alert(1)>' }],
					}
				},
				formatFrame() { return '<img src=x onerror=alert(2)>' },
			})
		`
		const s = JSP.saveLocalPlugin({ pluginId: 'xss-p', name: 'XSS', code: xssCode })
		assert.equal(JSP.trustAndEnable(s.pluginKey).ok, true)
		const proto = registered['xss-probe']
		const lv = proto.logView({ ok: true })
		assert.equal(lv.sections[0].html, undefined, 'section.html 必须被剥离')
		assert.equal(lv.sections[0].pre, '<img src=x onerror=alert(1)>')
		const rendered = PV.render(lv)
		assert.ok(!rendered.includes('<img'), '渲染结果不得包含未转义 img 标签')
		const fmt = proto.formatFrame({ ok: true })
		assert.ok(fmt.startsWith('<pre class="pv-pre">') && !fmt.includes('<img'))
	}

	// 6. 桌面本地插件目录扫描与状态联动
	{
		const { AppPlatform, JP, JSP, registered } = createEnv({ withRegistry: true })
		assert.equal(JSP.hasDesktopDir(), false)
		const noSvc = await JSP.scanDesktopDir()
		assert.equal(noSvc.supported, false)
		assert.equal((await JSP.openDesktopDir()).ok, false)

		const dirJsonSpec = Object.assign({}, JP.EXAMPLES[1].spec, { id: 'desk-relay', name: '桌面目录继电器' })
		let diskFiles = [
			{ fileName: 'desk-relay.json', kind: 'json', size: 100, content: JSON.stringify(dirJsonSpec) },
			{ fileName: 'broken.json', kind: 'json', size: 10, content: '{invalid' },
			{
				fileName: 'desk-echo.js',
				kind: 'js',
				size: 200,
				content: `registerProtocol('desk-js-proto', { name: '桌面 JS', parseFrame(b) { return { ok: true, raw: b } }, logView() { return { title: 'DESK-V1' } } })`,
			},
		]

		AppPlatform.provide('protocol-plugins', {
			async list() { return { dir: '/mock/app_data/protocols', files: diskFiles } },
			async openDir() { return '/mock/app_data/protocols' },
		})
		assert.equal(JSP.hasDesktopDir(), true)

		// 首次扫描：JSON 自动注册，JS 处于待信任未执行状态
		const s1 = await JSP.scanDesktopDir()
		assert.equal(s1.supported, true)
		assert.equal(s1.dir, '/mock/app_data/protocols')
		assert.equal(s1.jsonCount, 1)
		assert.equal(s1.jsCount, 1)
		assert.equal(s1.untrustedCount, 1)
		assert.equal(s1.errors.length, 1)
		assert.ok(registered['desk-relay'])
		assert.equal(registered['desk-js-proto'], undefined, '桌面目录新 JS 文件未信任前绝不可执行')

		// 信任并启用桌面目录 JS 插件
		const tr = JSP.trustAndEnable('dir:desk-echo.js')
		assert.equal(tr.ok, true)
		assert.equal(registered['desk-js-proto'].source, 'js-dir')
		assert.equal(registered['desk-js-proto'].logView().title, 'DESK-V1')

		// 再次扫描（内容未变）：自动加载已信任目录 JS 插件
		const s2 = await JSP.scanDesktopDir()
		assert.equal(s2.untrustedCount, 0)
		assert.equal(registered['desk-js-proto'].logView().title, 'DESK-V1')

		// 停用目录 JS 插件，再次扫描保持停用不执行
		assert.equal(JSP.setEnabled('dir:desk-echo.js', false).ok, true)
		assert.equal(registered['desk-js-proto'], undefined)
		const s3 = await JSP.scanDesktopDir()
		assert.equal(s3.untrustedCount, 0)
		assert.equal(registered['desk-js-proto'], undefined, '被用户停用的目录 JS 插件重新扫描后应维持停用')

		// 重新启用后，若外部修改磁盘上的 JS 文件，再次扫描应自动失信并卸载
		assert.equal(JSP.setEnabled('dir:desk-echo.js', true).ok, true)
		assert.ok(registered['desk-js-proto'])
		diskFiles[2] = Object.assign({}, diskFiles[2], {
			content: diskFiles[2].content.replace('DESK-V1', 'DESK-V2'),
		})
		const s4 = await JSP.scanDesktopDir()
		assert.equal(s4.untrustedCount, 1)
		assert.equal(registered['desk-js-proto'], undefined, '外部修改目录 JS 后必须自动卸载并重新待信任')

		// 目录清空后重新扫描：清理所有 dir-json 与 js-dir 协议
		diskFiles = []
		const s5 = await JSP.scanDesktopDir()
		assert.equal(s5.jsonCount, 0)
		assert.equal(s5.jsCount, 0)
		assert.equal(registered['desk-relay'], undefined)
		assert.equal(registered['desk-js-proto'], undefined)

		// 打开目录服务调用
		const opened = await JSP.openDesktopDir()
		assert.deepEqual(J(opened), { ok: true, dir: '/mock/app_data/protocols' })
	}

	console.log('js protocol plugin checks passed')
}

run().catch(err => {
	console.error(err)
	process.exit(1)
})
