// 本地 MCP 服务的界面：只在桌面客户端(提供了 AppPlatform.service('mcp') 且画像开启 service.mcp)里挂一个独立导航入口。
// 网页版 / 移动端没有这个服务，本文件什么都不做，也不注册任何监听。
// 令牌只在用户显式点「显示 / 复制」时经命令取回，放在内存里，关面板即清空；不写 localStorage、不打印日志。
;(function (root) {
	'use strict'
	const P = root.AppPlatform
	if (!P || !P.service || (P.has && !P.has('service.mcp'))) return
	const svc = P.service('mcp')
	if (!svc) return

	const doc = root.document
	let entry = null
	let latestStatus = null
	let opening = false
	let session = null // 当前打开的面板；关闭后置 null，迟到的异步结果一律丢弃

	function mk(tag, cls, text) {
		const el = doc.createElement(tag)
		if (cls) el.className = cls
		if (text != null) el.textContent = text
		return el
	}
	function toast(msg) {
		if (root.serialLanes && root.serialLanes.toast) root.serialLanes.toast(msg)
	}
	async function copyText(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			try {
				await navigator.clipboard.writeText(text)
				toast('已复制到剪贴板')
			} catch (e) { toast('复制失败，请重试或手动复制配置') }
		} else {
			toast('当前环境不支持剪贴板，请手动选择文本')
		}
	}
	function baseUrl(status) {
		return status.url || 'http://127.0.0.1:' + (status.port || 38991) + '/mcp'
	}
	// 复制出去的是干净的 MCP 客户端 JSON，不带注释
	function configJson(status, token) {
		return JSON.stringify({
			mcpServers: {
				'serial-debug': {
					type: 'http',
					url: baseUrl(status),
					headers: { Authorization: 'Bearer ' + (token || '<TOKEN>') },
				},
			},
		}, null, 2)
	}
	function cliCommand(status, token) {
		return 'claude mcp add --transport http serial-debug ' + baseUrl(status) + ' --header "Authorization: Bearer ' + (token || '<TOKEN>') + '"'
	}
	function agentInstructions(status, token) {
		return [
			'请连接正在运行的串口调试工具桌面版 MCP 服务，并使用它操作软件当前已选择的设备。',
			'传输：Streamable HTTP；地址：' + baseUrl(status),
			'以下是完整的 MCP 客户端配置，请按你所用客户端的配置格式接入：',
			'```json', configJson(status, token), '```',
			'Claude Code 也可执行以下接入命令：',
			'```sh', cliCommand(status, token), '```',
			'接入后先调用 windows_list，再用 serial_state / blu_state 确认目标窗口与设备。所有操作显式指定 window；串口还需指定 lane（单路 S，双路 A/B）。',
			'串口工具：serial_open、serial_close、serial_write、serial_read。功耗仪工具：blu_set_power、blu_set_voltage、blu_capture_start、blu_capture_stop、blu_capture_summary。',
			'设备需先在软件中选择；功耗仪需先在软件中连接。上下电只代表命令写入，无硬件确认；结果为 unknown_after_commit 时先查询状态，不要盲目重试。',
			'该配置含本机访问令牌，请只用于本机接入，不要提交到仓库或输出到日志。',
		].join('\n\n')
	}

	// 复制动作本身即为取凭据的明确意图；不必先显示令牌，也不把令牌写进可见面板。
	async function copyConnection(s, format) {
		if (s.closed || s.copying) return
		s.copying = true
		render(s)
		try {
			const status = await svc.status()
			if (s.closed) return
			s.status = status
			if (!status || !status.running) {
				toast('请先启用并启动本地 MCP 服务，再复制接入配置')
				return
			}
			const token = String(await svc.revealToken())
			if (s.closed) return
			if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('接入令牌不可用，请重新启用服务')
			const text = format === 'agent' ? agentInstructions(status, token)
				: (format === 'cli' ? cliCommand(status, token) : configJson(status, token))
			await copyText(text)
		} catch (e) {
			if (!s.closed) toast(String((e && e.message) || e))
		} finally {
			s.copying = false
			render(s)
		}
	}

	function updateEntry(status) {
		latestStatus = status
		if (!entry) return
		const st = status || {}
		const state = st.running ? 'running' : st.lastError ? 'error' : st.enabled ? 'waiting' : 'off'
		const label = { running: '运行中', error: '服务异常', waiting: '等待启动', off: '未启用' }[state]
		entry.dataset.state = state
		entry.title = '本地 MCP 服务 · ' + label
		entry.setAttribute('aria-label', entry.title)
	}

	function mountEntry() {
		const rail = doc.querySelector('#activity-rail .rail-bottom')
		if (!rail || doc.getElementById('serial-mcp-service')) return
		entry = mk('button', 'rail-item rail-mcp')
		entry.type = 'button'
		entry.id = 'serial-mcp-service'
		entry.dataset.feature = 'service.mcp'
		entry.appendChild(mk('i', 'bi bi-hdd-network'))
		entry.appendChild(mk('span', 'rail-label', 'MCP'))
		const dot = mk('span', 'rail-status-dot')
		dot.setAttribute('aria-hidden', 'true')
		entry.appendChild(dot)
		entry.addEventListener('click', function () { openPanel() })
		rail.insertBefore(entry, rail.firstChild)
		updateEntry(latestStatus)
		// 订阅先于读取；若读取期间收到了新状态，不用旧快照覆盖它。
		const snapshot = latestStatus
		Promise.resolve(svc.status()).then(function (status) {
			if (latestStatus === snapshot) updateEntry(status)
		}, function () { if (latestStatus === snapshot) updateEntry({ lastError: true }) })
	}

	function buildPanel(body, s) {
		body.classList.toggle('mdn-mcp-panel', true)
		s.statusLine = mk('div', 'mdn-mcp-status')
		s.urlLine = mk('div', 'mdn-mcp-url')
		s.urlLine.hidden = true

		const portRow = mk('div', 'mdn-mcp-row')
		const portLabel = mk('label', 'mdn-mcp-label', '端口')
		s.port = mk('input', 'form-control form-control-sm mdn-mcp-port')
		s.port.type = 'number'
		s.port.value = String((s.status && s.status.port) || 38991)
		s.port.min = '1024'
		s.port.max = '65535'
		s.port.setAttribute('inputmode', 'numeric')
		portLabel.appendChild(s.port)
		portRow.appendChild(portLabel)
		s.toggleBtn = mk('button', 'btn btn-sm btn-primary', '启用服务')
		s.toggleBtn.type = 'button'
		s.startBtn = mk('button', 'btn btn-sm btn-outline-primary', '启动')
		s.startBtn.type = 'button'
		s.startBtn.hidden = true
		portRow.appendChild(s.toggleBtn)
		portRow.appendChild(s.startBtn)
		body.appendChild(s.statusLine)
		body.appendChild(s.urlLine)
		body.appendChild(portRow)
		s.copyAgentBtn = mk('button', 'btn btn-sm btn-primary', '一键复制给 Agent')
		s.copyAgentBtn.type = 'button'
		s.copyAgentBtn.title = '复制完整接入说明、服务地址与访问令牌，可直接粘贴给本机 Agent'
		body.appendChild(s.copyAgentBtn)

		const tokenRow = mk('div', 'mdn-mcp-row')
		s.tokenBox = mk('code', 'mdn-mcp-token', '未显示')
		s.revealBtn = mk('button', 'btn btn-sm btn-outline-secondary', '显示令牌')
		s.revealBtn.type = 'button'
		s.copyTokenBtn = mk('button', 'btn btn-sm btn-outline-secondary', '复制令牌')
		s.copyTokenBtn.type = 'button'
		s.regenBtn = mk('button', 'btn btn-sm btn-outline-danger', '重新生成…')
		s.regenBtn.type = 'button'
		tokenRow.appendChild(s.tokenBox)
		tokenRow.appendChild(s.revealBtn)
		tokenRow.appendChild(s.copyTokenBtn)
		tokenRow.appendChild(s.regenBtn)
		body.appendChild(tokenRow)

		const configHead = mk('div', 'mdn-mcp-section-head')
		configHead.appendChild(mk('div', 'mdn-mcp-sub', '客户端配置'))
		s.copyCfgBtn = mk('button', 'btn btn-sm btn-outline-secondary', '复制配置')
		s.copyCfgBtn.type = 'button'
		s.cfg = mk('pre', 'mdn-mcp-cfg')
		configHead.appendChild(s.copyCfgBtn)
		body.appendChild(configHead)
		body.appendChild(s.cfg)
		const cliHead = mk('div', 'mdn-mcp-section-head')
		cliHead.appendChild(mk('div', 'mdn-mcp-sub', 'Claude Code'))
		s.copyCliBtn = mk('button', 'btn btn-sm btn-outline-secondary', '复制命令')
		s.copyCliBtn.type = 'button'
		s.cli = mk('pre', 'mdn-mcp-cfg')
		cliHead.appendChild(s.copyCliBtn)
		body.appendChild(cliHead)
		body.appendChild(s.cli)
		body.appendChild(mk('div', 'mdn-mcp-hint', '只监听 127.0.0.1，需要 Bearer 令牌；每个工具都必须显式指定窗口。服务开启后才会把工具暴露给 agent，窗口未登录时不执行任何操作。端口只能在服务停止时修改，绑定失败会如实报错，不会自动换端口。'))

		s.toggleBtn.addEventListener('click', function () { toggleService(s) })
		s.startBtn.addEventListener('click', function () { toggleService(s, true) })
		s.revealBtn.addEventListener('click', function () {
			if (s.token) {
				s.token = ''
				render(s)
				return
			}
			revealInto(s)
		})
		s.copyTokenBtn.addEventListener('click', function () {
			if (s.token) {
				copyText(s.token)
				return
			}
			revealInto(s, function (token) { copyText(token) })
		})
		s.regenBtn.addEventListener('click', function () { regenerate(s) })
		s.copyAgentBtn.addEventListener('click', function () { copyConnection(s, 'agent') })
		s.copyCfgBtn.addEventListener('click', function () { copyConnection(s, 'json') })
		s.copyCliBtn.addEventListener('click', function () { copyConnection(s, 'cli') })
	}

	async function revealInto(s, after) {
		try {
			const token = String(await svc.revealToken())
			if (!s || s.closed) return // 面板已关：迟到的令牌不再写回页面
			s.token = token
			render(s)
			if (after) after(token)
		} catch (e) {
			if (s && !s.closed) toast(String((e && e.message) || e))
		}
	}

	async function toggleService(s, forceStart) {
		const st = s.status || {}
		s.busy = true
		render(s)
		try {
			if (st.running || st.enabled) {
				if (forceStart) await svc.enable(Number(s.port.value) || undefined)
				else await svc.disable()
			} else {
				await svc.enable(Number(s.port.value) || undefined)
			}
		} catch (e) {
			if (!s.closed) toast(String((e && e.message) || e))
		} finally {
			s.busy = false
			if (!s.closed) await refresh(s, true)
		}
	}

	// 面板内两步确认，不再嵌套 AppDialog(它是单模态，会把确认框排在面板后面死等)
	function regenerate(s) {
		if (!s.regenArmed) {
			s.regenArmed = true
			render(s)
			clearTimeout(s.regenTimer)
			s.regenTimer = setTimeout(function () {
				if (s.closed) return
				s.regenArmed = false
				render(s)
			}, 5000)
			return
		}
		clearTimeout(s.regenTimer)
		s.regenArmed = false
		svc.regenerateToken().then(function (status) {
			if (s.closed) return
			s.token = ''
			s.status = status || s.status
			render(s)
			toast('令牌已重新生成，旧的客户端配置需要更新')
		}, function (e) {
			if (!s.closed) toast(String((e && e.message) || e))
		})
	}

	function render(s) {
		if (!s || s.closed) return
		const st = s.status || {}
		const running = !!st.running
		let text
		if (running) text = '运行中'
		else if (st.starting) text = '正在启动…'
		else if (st.enabled && st.lastError) text = '启动失败：' + st.lastError
		else if (st.enabled && st.waitingForLogin) text = '已启用，等登录后自动启动'
		else if (st.enabled) text = '已启用，未运行'
		else text = '未启用（默认关闭）'
		s.statusLine.textContent = text
		s.statusLine.classList.toggle('is-on', running)
		s.statusLine.classList.toggle('is-error', !!(st.enabled && st.lastError))
		s.urlLine.hidden = !running
		s.urlLine.textContent = running ? baseUrl(st) : ''
		if (doc.activeElement !== s.port) s.port.value = String(st.port || 38991)
		s.port.disabled = running || !!s.busy
		s.toggleBtn.disabled = !!s.busy
		s.toggleBtn.textContent = st.enabled ? '停用服务' : '启用服务'
		s.startBtn.hidden = !(st.enabled && !running)
		s.startBtn.disabled = !!s.busy
		const copyButtons = [s.copyAgentBtn, s.copyCfgBtn, s.copyCliBtn]
		copyButtons.forEach(function (button) {
			button.disabled = !!s.copying || !!s.busy || !running
		})
		s.tokenBox.textContent = s.token || '未显示'
		s.revealBtn.textContent = s.token ? '隐藏令牌' : '显示令牌'
		s.regenBtn.textContent = s.regenArmed ? '确认重新生成' : '重新生成…'
		s.cfg.textContent = configJson(st, s.token)
		s.cli.textContent = cliCommand(st, s.token)
	}

	async function refresh(s, force) {
		if (!s || s.closed) return
		try {
			const status = await svc.status()
			updateEntry(status)
			if (!s.closed) s.status = status
		} catch (e) {
			if (force && !s.closed) s.status = Object.assign({}, s.status, { lastError: String((e && e.message) || e) })
		}
		render(s)
	}

	async function openPanel() {
		if (opening || session) return
		opening = true
		let status = null
		try { status = await svc.status() } catch (e) { status = { lastError: String((e && e.message) || e) } }
		const s = { status: status, token: '', busy: false, regenArmed: false, regenTimer: 0, closed: false }
		opening = false
		session = s
		root.AppDialog.panel({
			title: '本地 MCP 服务',
			wide: true,
			closeText: '关闭',
			build: function (body) { buildPanel(body, s) },
		}).then(function () {
			s.closed = true
			s.token = ''
			clearTimeout(s.regenTimer)
			if (session === s) session = null
		})
		render(s)
	}

	Promise.resolve(svc.listen('mcp-service', function (status) {
		updateEntry(status)
		if (!session) return
		session.status = status || session.status
		render(session)
	})).catch(function () {})

	// 状态栏芯片(js/workbench.js TASKS)的只读接口：状态由 updateEntry / listen 保持新鲜，open 打开本面板
	function statusState() {
		const st = latestStatus || {}
		return st.running ? 'running' : st.lastError ? 'error' : st.enabled ? 'waiting' : 'off'
	}
	root.McpServiceStatus = {
		state: statusState,
		label: function () {
			return { running: '运行中', error: '服务异常', waiting: '等待启动', off: '未启用' }[statusState()]
		},
		port: function () {
			const st = latestStatus || {}
			return st.port || 38991
		},
		open: function () { openPanel() },
	}

	if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mountEntry)
	else mountEntry()
})(typeof window !== 'undefined' ? window : globalThis)
