;(function () {
	if (!('serial' in navigator)) {
		alert('当前浏览器不支持串口操作,请更换Edge或Chrome浏览器')
	}

	/* ========== Theme Toggle ========== */
	const STORAGE_KEY = 'serial-debug-theme'
	const themeToggle = document.getElementById('theme-toggle')
	const savedTheme = localStorage.getItem(STORAGE_KEY)

	if (savedTheme) {
		document.documentElement.setAttribute('data-theme', savedTheme)
	} else {
		const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
		if (prefersDark) {
			document.documentElement.setAttribute('data-theme', 'dark')
		}
	}

	function updateToggleUi() {
		const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
		themeToggle.title = isDark ? '切换至亮色模式' : '切换至暗色模式'
	}

	updateToggleUi()

	themeToggle.addEventListener('click', () => {
		const current = document.documentElement.getAttribute('data-theme')
		const next = current === 'dark' ? 'light' : 'dark'
		document.documentElement.setAttribute('data-theme', next)
		localStorage.setItem(STORAGE_KEY, next)
		updateToggleUi()
	})

	window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
		if (!localStorage.getItem(STORAGE_KEY)) {
			document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light')
			updateToggleUi()
		}
	})
	let serialPort = null
	const SERIAL_WANT_OPEN_KEY = 'serialWantOpen'
	function setSerialWantOpen(want) {
		try {
			if (want) sessionStorage.setItem(SERIAL_WANT_OPEN_KEY, '1')
			else sessionStorage.removeItem(SERIAL_WANT_OPEN_KEY)
		} catch (e) {}
	}
	function getSerialWantOpen() {
		try {
			return sessionStorage.getItem(SERIAL_WANT_OPEN_KEY) === '1'
		} catch (e) {
			return false
		}
	}
	// 仅刷新(reload)且刷新前串口处于打开意图时自动重连；新开/跳转不连
	;(function () {
		let navType = 'navigate'
		try {
			const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0]
			if (nav && nav.type) navType = nav.type
			else if (performance.navigation) navType = performance.navigation.type === 1 ? 'reload' : 'navigate'
		} catch (e) {}
		if (navType !== 'reload' || !getSerialWantOpen()) return
		navigator.serial.getPorts().then(async (ports) => {
			if (ports.length > 0) {
				serialPort = ports[0]
				await openSerial()
			}
		})
	})()
	let reader
	//串口目前是打开状态
	let serialOpen = false
	//串口目前是手动关闭状态
	let serialClose = true
	//串口正在打开中(防止并发)
	let serialOpening = false
	//串口分包合并时钟
	let serialTimer = null
	//串口循环发送时钟
	let serialloopSendTimer = null
	//串口缓存数据
	let serialData = []
	//文本解码
	let textdecoder = new TextDecoder()
	let currQuickSend = []
	//快捷发送列表
	let quickSendList = [
		{
			name: 'ESP32 AT指令',
			list: [
				{
					name: '测试 AT 启动',
					content: 'AT',
					hex: false,
				},
				{
					name: '重启模块',
					content: 'AT+RST',
					hex: false,
				},
				{
					name: '查看版本信息',
					content: 'AT+GMR',
					hex: false,
				},
				{
					name: '查询当前固件支持的所有命令及命令类型',
					content: 'AT+CMD?',
					hex: false,
				},
				{
					name: '进⼊ Deep-sleep 模式 1分钟',
					content: 'AT+GSLP=60000',
					hex: false,
				},
				{
					name: '开启AT回显功能',
					content: 'ATE1',
					hex: false,
				},
				{
					name: '关闭AT回显功能',
					content: 'ATE0',
					hex: false,
				},
				{
					name: '恢复出厂设置',
					content: 'AT+RESTORE',
					hex: false,
				},
				{
					name: '查询 UART 当前临时配置',
					content: 'AT+UART_CUR?',
					hex: false,
				},
				{
					name: '设置 UART 115200 保存flash',
					content: 'AT+UART_DEF=115200,8,1,0,3',
					hex: false,
				},
				{
					name: '查询 sleep 模式',
					content: 'AT+SLEEP?',
					hex: false,
				},
				{
					name: '查询当前剩余堆空间和最小堆空间',
					content: 'AT+SYSRAM?',
					hex: false,
				},
				{
					name: '查询系统提示信息',
					content: 'AT+SYSMSG?',
					hex: false,
				},
				{
					name: '查询 flash 用户分区',
					content: 'AT+SYSFLASH?',
					hex: false,
				},
				{
					name: '查询本地时间戳',
					content: 'AT+SYSTIMESTAMP?',
					hex: false,
				},
				{
					name: '查询 AT 错误代码提示',
					content: 'AT+SYSLOG?',
					hex: false,
				},
				{
					name: '设置/查询系统参数存储模式',
					content: 'AT+SYSPARA?',
					hex: false,
				},
			],
		},
	]
	//工具配置
	let toolOptions = {
		//自动滚动
		autoScroll: true,
		//显示时间 界面未开放
		showTime: true,
		//日志类型
		logType: 'hex',
		//分包合并时间
		timeOut: 200,
		//日志最大行数,超出后从顶部裁剪
		maxLogRows: 5000,
		//末尾加回车换行
		addCRLF: false,
		//HEX发送
		hexSend: true,
		//循环发送
		loopSend: false,
		//循环发送时间
		loopSendTime: 1000,
		//输入的发送内容
		sendContent: '',
		//快捷发送选中索引
		quickSendIndex: 0,
		//第三方协议解析开关
		skParseEnable: false,
		//悬停提示(静默解析)开关
		skHoverEnable: false,
		//解密模式 auto|always|never
		skDecryptMode: 'auto',
		//密钥ASCII
		skKeyAscii: '',
		//密钥HEX(优先)
		skKeyHex: '',
		//加密方式 aes128|aes256
		skEncType: 'aes128',
		//下行是否加密(默认关: 有密钥也明文下发, 密钥仍用于上行解析)
		skDownEncrypt: false,
		//当前协议
		skProtocol: 'sek',
	}

	// ---- 协议注册表 ----
	window._protocols = {}
	window._activeProtocol = 'sek'

	window.registerProtocol = function (id, impl) {
		window._protocols[id] = impl
		if (!document.getElementById('serial-protocol-select')) return
		var sel = document.getElementById('serial-protocol-select')
		var exists = Array.from(sel.options).some(function (o) { return o.value === id })
		if (!exists) {
			var opt = document.createElement('option')
			opt.value = id
			opt.textContent = impl.name || id
			sel.appendChild(opt)
		}
	}

	// 初始化 SEK 协议（延迟注册，等 protocol.js 加载后函数可用）
	function _initProtocolRegistry() {
		if (typeof skParseFrame === 'function') {
			window.registerProtocol('sek', {
				name: 'SEK',
				parseFrame: skParseFrame,
				formatFrame: skFormatFrame,
				findFrame: typeof skFindFrame === 'function' ? skFindFrame : null,
				byteMap: typeof skByteMap === 'function' ? skByteMap : null,
				buildDownFrame: typeof skBuildDownFrame === 'function' ? skBuildDownFrame : null,
				presets: window.SK_DOWN_PRESETS || [],
			})
		}
	}

	// 将全局函数替换为协议代理，根据 activeProtocol 分发
	;(function () {
		var _parse = typeof skParseFrame === 'function' ? skParseFrame : null
		var _fmt = typeof skFormatFrame === 'function' ? skFormatFrame : null
		var _find = typeof skFindFrame === 'function' ? skFindFrame : null
		var _bmap = typeof skByteMap === 'function' ? skByteMap : null
		var _build = typeof skBuildDownFrame === 'function' ? skBuildDownFrame : null

		_initProtocolRegistry()

		skParseFrame = function (data, opts) {
			var p = window.getActiveProtocol()
			if (p && p.parseFrame) return p.parseFrame(data, opts)
			if (_parse) return _parse(data, opts)
			return { errors: ['当前协议无解析器'] }
		}
		skFormatFrame = function (r) {
			var p = window.getActiveProtocol()
			if (p && p.formatFrame) return p.formatFrame(r)
			if (_fmt) return _fmt(r)
			return ''
		}
		skFindFrame = function (data, opts) {
			var p = window.getActiveProtocol()
			if (p && p.findFrame) return p.findFrame(data, opts)
			if (_find) return _find(data, opts)
			return null
		}
		if (_bmap) {
			skByteMap = function (r) {
				var p = window.getActiveProtocol()
				if (p && p.byteMap) return p.byteMap(r)
				return _bmap(r)
			}
		}
		if (_build) {
			skBuildDownFrame = function (opts) {
				var p = window.getActiveProtocol()
				if (p && p.buildDownFrame) return p.buildDownFrame(opts)
				return _build(opts)
			}
		}

		// 暴露协议预设重建函数
		window.rebuildProtocolPresets = function () {
			if (!window.SK_DOWN_PRESETS) return
			var proto = window.getActiveProtocol()
			var presets = (proto && proto.presets) ? proto.presets : window.SK_DOWN_PRESETS
			var oldSK = window.SK_DOWN_PRESETS
			window.SK_DOWN_PRESETS = presets
			rebuildPresets(document.getElementById('serial-protocol-down-func').value)
			window.SK_DOWN_PRESETS = oldSK
		}
	})()

	window.getActiveProtocol = function () {
		return window._protocols[window._activeProtocol] || null
	}

	// 协议选择器变更
	var protocolSelectEl = document.getElementById('serial-protocol-select')
	if (protocolSelectEl) {
		protocolSelectEl.addEventListener('change', function () {
			window._activeProtocol = this.value
			toolOptions.skProtocol = this.value
			localStorage.setItem('toolOptions', JSON.stringify(toolOptions))
			// 刷新常用指令列表
			if (typeof rebuildProtocolPresets === 'function') rebuildProtocolPresets()
		})
	}

	//生成快捷发送列表
	let quickSend = document.getElementById('serial-quick-send')
	let sendList = localStorage.getItem('quickSendList')
	if (sendList) {
		quickSendList = JSON.parse(sendList)
	}
	quickSendList.forEach((item, index) => {
		let option = document.createElement('option')
		option.innerText = item.name
		option.value = index
		quickSend.appendChild(option)
	})

	//快捷发送列表被单击
	document.getElementById('serial-quick-send-content').addEventListener('click', (e) => {
		const removeBtn = e.target.closest('.quick-remove')
		const sendBtn = e.target.closest('.quick-send')
		const row = e.target.closest('.quick-item')
		if (!row || !row.parentNode) return
		const index = Array.from(row.parentNode.children).indexOf(row)
		if (index < 0) return
		if (removeBtn) {
			currQuickSend.list.splice(index, 1)
			row.remove()
			saveQuickList()
			return
		}
		if (sendBtn) {
			const item = currQuickSend.list[index]
			if (item.hex) {
				sendHex(item.content)
				return
			}
			sendText(item.content)
		}
	})
	//快捷列表双击内容输入框改名
	document.getElementById('serial-quick-send-content').addEventListener('dblclick', (e) => {
		const input = e.target.closest('input.quick-content')
		const row = e.target.closest('.quick-item')
		if (!input || !row || !row.parentNode) return
		const index = Array.from(row.parentNode.children).indexOf(row)
		if (index < 0) return
		changeName((name) => {
			currQuickSend.list[index].name = name
			row.outerHTML = getQuickItemHtml(currQuickSend.list[index])
			saveQuickList()
		}, currQuickSend.list[index].name)
	})
	//快捷发送列表被改变
	document.getElementById('serial-quick-send-content').addEventListener('change', (e) => {
		const curr = e.target
		if (curr.tagName != 'INPUT') return
		const row = curr.closest('.quick-item')
		if (!row || !row.parentNode) return
		const index = Array.from(row.parentNode.children).indexOf(row)
		if (index < 0) return
		if (curr.type == 'text' || curr.classList.contains('quick-content')) {
			currQuickSend.list[index].content = curr.value
		}
		if (curr.type == 'checkbox') {
			currQuickSend.list[index].hex = curr.checked
		}
		saveQuickList()
	})
	function saveQuickList() {
		localStorage.setItem('quickSendList', JSON.stringify(quickSendList))
	}

	const quickSendContent = document.getElementById('serial-quick-send-content')
	//快捷发送列表更换选项
	quickSend.addEventListener('change', (e) => {
		let index = e.target.value
		if (index != -1) {
			changeOption('quickSendIndex', index)
			currQuickSend = quickSendList[index]
			//
			quickSendContent.innerHTML = ''
			currQuickSend.list.forEach((item) => {
				quickSendContent.innerHTML += getQuickItemHtml(item)
			})
		}
	})
	//添加快捷发送
	document.getElementById('serial-quick-send-add').addEventListener('click', (e) => {
		const item = {
			name: '发送',
			content: '',
			hex: false,
		}
		currQuickSend.list.push(item)
		quickSendContent.innerHTML += getQuickItemHtml(item)
		saveQuickList()
	})
	function getQuickItemHtml(item) {
		const rawName = item.name || '发送'
		const name = HTMLEncode(rawName)
		const nameAttr = attrEscape(rawName)
		const content = attrEscape(item.content || '')
		return `<div class="quick-item">
			<button type="button" title="移除" class="btn quick-remove" aria-label="移除"><i class="bi bi-x-lg"></i></button>
			<input class="form-control form-control-sm quick-content" placeholder="发送内容" value="${content}">
			<button type="button" class="btn btn-sm quick-send" title="发送: ${nameAttr}">${name}</button>
			<label class="quick-hex" title="HEX 模式">
				<input type="checkbox" ${item.hex ? 'checked' : ''}>
				<span>HEX</span>
			</label>
		</div>`
	}
	//快捷发送分组新增
	document.getElementById('serial-quick-send-add-group').addEventListener('click', (e) => {
		changeName((name) => {
			quickSendList.push({
				name: name,
				list: [],
			})
			quickSend.innerHTML += `<option value="${quickSendList.length - 1}">${name}</option>`
			quickSend.value = quickSendList.length - 1
			quickSend.dispatchEvent(new Event('change'))
			saveQuickList()
		})
	})
	//快捷发送分组重命名
	document.getElementById('serial-quick-send-rename-group').addEventListener('click', (e) => {
		changeName((name) => {
			currQuickSend.name = name
			quickSend.options[quickSend.value].innerText = name
			saveQuickList()
		}, currQuickSend.name)
	})
	//快捷发送分组删除
	document.getElementById('serial-quick-send-remove-group').addEventListener('click', (e) => {
		if (quickSendList.length == 1) {
			return
		}
		//弹窗询问是否删除
		if (!confirm('是否删除该分组?')) {
			return
		}
		quickSendList.splice(quickSend.value, 1)
		quickSend.options[quickSend.value].remove()
		quickSend.value = 0
		quickSend.dispatchEvent(new Event('change'))
		saveQuickList()
	})

	//导出
	document.getElementById('serial-quick-send-export').addEventListener('click', (e) => {
		let data = JSON.stringify(currQuickSend.list)
		let blob = new Blob([data], { type: 'text/plain' })
		saveAs(blob, currQuickSend.name + '.json')
	})
	//导入
	document.getElementById('serial-quick-send-import-btn').addEventListener('click', (e) => {
		document.getElementById('serial-quick-send-import').click()
	})
	document.getElementById('serial-quick-send-import').addEventListener('change', (e) => {
		let file = e.target.files[0]
		e.target.value = ''
		let reader = new FileReader()
		reader.onload = function (e) {
			let data = e.target.result
			try {
				let list = JSON.parse(data)
				currQuickSend.list.push(...list)
				list.forEach((item) => {
					quickSendContent.innerHTML += getQuickItemHtml(item)
				})
				saveQuickList()
			} catch (e) {
				showMsg('导入失败:' + e.message)
			}
		}
		reader.readAsText(file)
	})
	//重置参数
	document.getElementById('serial-reset').addEventListener('click', (e) => {
		if (!confirm('是否重置参数?')) {
			return
		}
		localStorage.removeItem('serialOptions')
		localStorage.removeItem('toolOptions')
		localStorage.removeItem('quickSendList')
		location.reload()
	})
	//导出参数
	document.getElementById('serial-export').addEventListener('click', (e) => {
		let data = {
			serialOptions: localStorage.getItem('serialOptions'),
			toolOptions: localStorage.getItem('toolOptions'),
			quickSendList: localStorage.getItem('quickSendList'),
		}
		let blob = new Blob([JSON.stringify(data)], { type: 'text/plain' })
		saveAs(blob, 'web-serial-debug.json')
	})
	//导入参数
	document.getElementById('serial-import').addEventListener('click', (e) => {
		document.getElementById('serial-import-file').click()
	})
	function setParam(key, value) {
		if (value == null) {
			localStorage.removeItem(key)
		} else {
			localStorage.setItem(key, value)
		}
	}
	document.getElementById('serial-import-file').addEventListener('change', (e) => {
		let file = e.target.files[0]
		e.target.value = ''
		let reader = new FileReader()
		reader.onload = function (e) {
			let data = e.target.result
			try {
				let obj = JSON.parse(data)
				setParam('serialOptions', obj.serialOptions)
				setParam('toolOptions', obj.toolOptions)
				setParam('quickSendList', obj.quickSendList)
				location.reload()
			} catch (e) {
				showMsg('导入失败:' + e.message)
			}
		}
		reader.readAsText(file)
	})
	//协议解析 HEX：归一化 / 转字节 / 0-F 转储渲染
	function normalizeHexRaw(raw) {
		return String(raw || '').replace(/0x/gi, '').replace(/[\s,;:\-_]+/g, '')
	}
	function hexRawToBytes(hex) {
		if (!hex || hex.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(hex)) return null
		const bytes = new Uint8Array(hex.length / 2)
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
		}
		return bytes
	}
	//剪贴板读取权限：在线 HTTPS 下首次授权后浏览器会记住，后续 click 静默 readText
	let _clipReadPerm = 'unknown' // granted | denied | prompt | unknown
	let _clipPermWatching = false
	function buildHexEmptyHtml() {
		const granted = _clipReadPerm === 'granted'
		const denied = _clipReadPerm === 'denied'
		const main = denied
			? '权限已拒绝，请用 Ctrl/Cmd+V 粘贴'
			: granted
				? '点击读取剪贴板 HEX'
				: '点击允许读取剪贴板'
		const sub = denied
			? '可在地址栏站点设置中重新允许剪贴板 · 也可点上方日志行'
			: granted
				? '已授权，点击即读 · 也支持 Ctrl/Cmd+V · 或点上方日志行'
				: '首次需浏览器授权一次，之后点击不再弹窗 · 也可 Ctrl/Cmd+V'
		return '<div class="sk-hex-empty" aria-hidden="true">' +
			'<div class="sk-hex-empty-main"><i class="bi bi-clipboard-plus"></i><span>' + main + '</span></div>' +
			'<div class="sk-hex-empty-sub">' + sub + '</div></div>'
	}
	function refreshHexEmptyHtml() {
		const view = document.getElementById('serial-protocol-hexview')
		if (view && view.classList.contains('is-empty')) {
			view.innerHTML = buildHexEmptyHtml()
		}
	}
	async function queryClipboardReadPerm() {
		try {
			if (!navigator.permissions || !navigator.permissions.query) return _clipReadPerm
			const st = await navigator.permissions.query({ name: 'clipboard-read' })
			_clipReadPerm = st.state || 'unknown'
			if (!_clipPermWatching) {
				_clipPermWatching = true
				st.addEventListener('change', function () {
					_clipReadPerm = st.state || 'unknown'
					refreshHexEmptyHtml()
				})
			}
		} catch (e) {
			// Firefox 等可能不支持 clipboard-read 查询，保持 unknown，靠首次 read 结果缓存
		}
		return _clipReadPerm
	}
	async function readClipboardTextOnce() {
		const text = await navigator.clipboard.readText()
		_clipReadPerm = 'granted'
		refreshHexEmptyHtml()
		return text
	}
	let _hexDumpState = { bytes: null, bm: null, cols: 0 }
	function getProtocolParseOpts() {
		return {
			keyAscii: toolOptions.skKeyAscii || undefined,
			keyHex: toolOptions.skKeyHex || undefined,
			decryptMode: toolOptions.skDecryptMode,
		}
	}
	//仅解析密钥材料; 不代表下发要加密
	function resolveToolEncKey() {
		if (toolOptions.skKeyHex) {
			const hex = String(toolOptions.skKeyHex).trim().replace(/\s+/g, '')
			if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
				const a = []
				for (let i = 0; i < hex.length; i += 2) a.push(parseInt(hex.substr(i, 2), 16))
				return new Uint8Array(a)
			}
			return null
		}
		if (toolOptions.skKeyAscii) {
			const s = String(toolOptions.skKeyAscii)
			const a = new Uint8Array(s.length)
			for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff
			return a
		}
		return null
	}
	//下发用密钥: 仅当「下发加密」开启且密钥有效时返回, 否则 null → 明文帧
	function getDownlinkEncKey() {
		if (!toolOptions.skDownEncrypt) return null
		return resolveToolEncKey()
	}
	function getHexDumpCols(view) {
		if (!view) return 16
		const style = window.getComputedStyle(view)
		const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
		const avail = Math.max(0, view.clientWidth - pad)
		const fs = parseFloat(style.fontSize) || 11.5
		// 左偏移列 + gap + N 个字节格
		const offW = 2.6 * fs + 8
		const cellW = 1.55 * fs + 2
		const n = Math.floor((avail - offW) / cellW)
		if (n >= 32) return 32
		return 16
	}
	function renderProtocolHexDump(bytes, bm) {
		const view = document.getElementById('serial-protocol-hexview')
		if (!view) return
		if (arguments.length >= 1) {
			_hexDumpState.bytes = bytes && bytes.length ? bytes : null
			_hexDumpState.bm = (bytes && bytes.length && bm) ? bm : null
		}
		bytes = _hexDumpState.bytes
		bm = _hexDumpState.bm
		if (!bytes || !bytes.length) {
			view.innerHTML = buildHexEmptyHtml()
			view.classList.add('is-empty')
			_hexDumpState.cols = 0
			return
		}
		view.classList.remove('is-empty')
		const COLS = getHexDumpCols(view)
		_hexDumpState.cols = COLS
		const gridStyle = 'grid-template-columns:repeat(' + COLS + ',1.55em)'
		let h = '<div class="sk-hex-dump-head"><span class="sk-hex-off"></span><span class="sk-hex-bytes" style="' + gridStyle + '">'
		for (let c = 0; c < COLS; c++) {
			h += '<span class="sk-hex-col">' + c.toString(16).toUpperCase() + '</span>'
		}
		h += '</span></div>'
		for (let i = 0; i < bytes.length; i += COLS) {
			h += '<div class="sk-hex-dump-row"><span class="sk-hex-off">' +
				i.toString(16).toUpperCase().padStart(4, '0') +
				'</span><span class="sk-hex-bytes" style="' + gridStyle + '">'
			for (let j = 0; j < COLS; j++) {
				const idx = i + j
				if (idx >= bytes.length) {
					h += '<span class="sk-hex-pad"></span>'
					continue
				}
				const hb = ('0' + bytes[idx].toString(16).toUpperCase()).slice(-2)
				const cell = bm && bm[idx]
				if (cell && cell.tip) {
					h += '<span class="sk-hex-byte" data-grp="' + attrEscape(cell.grp) +
						'" data-tip="' + attrEscape(cell.tip) + '">' + hb + '</span>'
				} else {
					h += '<span class="sk-hex-byte">' + hb + '</span>'
				}
			}
			h += '</span></div>'
		}
		view.innerHTML = h
	}
	function parseProtocolBytes(bytes, note) {
		if (!bytes || !bytes.length) {
			renderProtocolHexDump(null)
			document.getElementById('serial-protocol-output').innerHTML = ''
			return
		}
		renderProtocolHexDump(bytes)
		try {
			const r = skParseFrame(bytes, getProtocolParseOpts())
			if (typeof skByteMap === 'function') {
				try {
					renderProtocolHexDump(bytes, skByteMap(r))
				} catch (mapErr) { /* keep plain dump */ }
			}
			let head = ''
			if (note) head += '<div class="sk-parse-note">' + HTMLEncode(note) + '</div>'
			if (r.needKey) head += '<div class="sk-parse-err">⚠ 加密报文,请在右侧「第三方协议」中的「密钥(ASCII)」或「密钥(HEX)」输入框填入密钥后再解析</div>'
			document.getElementById('serial-protocol-output').innerHTML = head + skFormatFrame(r)
		} catch (err) {
			document.getElementById('serial-protocol-output').innerHTML = '<div class="sk-parse-err">解析异常:' + HTMLEncode(String(err)) + '</div>'
		}
	}
	// opts.requireValid: 仅在扫到 CRC+EOF 有效帧时填充（点击剪贴板用，失败不覆盖已有内容）
	function applyProtocolHexInput(raw, opts) {
		opts = opts || {}
		const hex = normalizeHexRaw(raw)
		const bytes = hexRawToBytes(hex)
		if (!bytes) {
			if (!opts.requireValid) renderProtocolHexDump(null)
			return false
		}
		let frameBytes = bytes
		let note = ''
		const found = typeof skFindFrame === 'function' ? skFindFrame(bytes, getProtocolParseOpts()) : null
		if (found && found.found) {
			frameBytes = found.frame
			if (found.prefix || found.suffix) {
				note = '已从偏移 0x' + found.offset.toString(16).toUpperCase() +
					' 截取有效帧（丢弃前 ' + found.prefix + ' / 后 ' + found.suffix + ' 字节）'
			}
		} else if (opts.requireValid) {
			return false
		}
		parseProtocolBytes(frameBytes, note)
		return true
	}
	//HEX 转储区：点击读剪贴板 / 粘贴即格式化并解析；宽度变化时在 16/32 列间切换
	const protocolHexView = document.getElementById('serial-protocol-hexview')
	if (protocolHexView) {
		queryClipboardReadPerm().then(refreshHexEmptyHtml)
		if (protocolHexView.classList.contains('is-empty')) {
			protocolHexView.innerHTML = buildHexEmptyHtml()
		}
		function applyClipboardHexText(text) {
			if (!text || !String(text).trim()) {
				addLogErr('剪贴板为空')
				return
			}
			if (!applyProtocolHexInput(text, { requireValid: true })) {
				const hex = normalizeHexRaw(text)
				if (!hexRawToBytes(hex)) addLogErr('剪贴板不是合法 HEX')
				else addLogErr('剪贴板中未找到有效协议帧（需 A9 9A … CRC … 16）')
			}
		}
		protocolHexView.addEventListener('paste', (e) => {
			e.preventDefault()
			const text = (e.clipboardData || window.clipboardData).getData('text')
			if (!applyProtocolHexInput(text)) {
				addLogErr('HEX格式错误:' + text)
			}
		})
		protocolHexView.addEventListener('click', async () => {
			//选中文本时不抢剪贴板，避免影响复制
			const sel = window.getSelection()
			if (sel && !sel.isCollapsed && protocolHexView.contains(sel.anchorNode)) return
			if (!navigator.clipboard || !navigator.clipboard.readText) {
				addLogErr('当前环境不支持读取剪贴板，请用 Ctrl/Cmd+V 粘贴')
				return
			}
			const perm = await queryClipboardReadPerm()
			if (perm === 'denied') {
				addLogErr('剪贴板权限已拒绝，请在地址栏站点设置中允许，或使用 Ctrl/Cmd+V')
				refreshHexEmptyHtml()
				return
			}
			try {
				//已授权时浏览器不再弹窗；首次 prompt 时由本次用户点击触发一次授权
				const text = await readClipboardTextOnce()
				applyClipboardHexText(text)
			} catch (err) {
				const name = err && err.name
				if (name === 'NotAllowedError' || name === 'SecurityError') {
					_clipReadPerm = 'denied'
					refreshHexEmptyHtml()
					addLogErr('未获得剪贴板权限，请在弹窗中选「允许」，或改用 Ctrl/Cmd+V')
				}
				//其它错误（空、取消等）静默，仍可用粘贴
			}
		})
		protocolHexView.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
				e.preventDefault()
				const sel = window.getSelection()
				const range = document.createRange()
				range.selectNodeContents(protocolHexView)
				sel.removeAllRanges()
				sel.addRange(range)
			}
		})
		if (typeof ResizeObserver !== 'undefined') {
			let _hexRoT = 0
			const ro = new ResizeObserver(function () {
				if (!_hexDumpState.bytes) return
				const next = getHexDumpCols(protocolHexView)
				if (next === _hexDumpState.cols) return
				clearTimeout(_hexRoT)
				_hexRoT = setTimeout(function () { renderProtocolHexDump() }, 50)
			})
			ro.observe(protocolHexView)
		}
	}
	//生成下发HEX
	let _downSeq = 1
	document.getElementById('serial-protocol-build').addEventListener('click', (e) => {
		let tlv
		try {
			tlv = JSON.parse(document.getElementById('serial-protocol-down-tlv').value || '[]')
		} catch (err) {
			addLogErr('TLV JSON解析失败:' + err.toString())
			return
		}
		try {
			if (toolOptions.skDownEncrypt && !resolveToolEncKey()) {
				addLogErr('已勾选下发加密, 但密钥无效或为空(请填写高级·密钥)')
				return
			}
			const encKey = getDownlinkEncKey()
			const frame = skBuildDownFrame({
				funcCode: document.getElementById('serial-protocol-down-func').value,
				version: 2,
				time: new Date(),
				frameSeq: _downSeq++,
				tlv: tlv,
				encKey: encKey,
			})
			let hex = []
			for (const b of frame) {
				hex.push(('0' + b.toString(16).toUpperCase()).slice(-2))
			}
			document.getElementById('serial-protocol-down-preview').value = hex.join(' ')
			if (encKey) {
				addLogErr('已生成加密下行帧 (ctrl 加密位=1)')
			}
		} catch (err) {
			addLogErr('生成帧失败:' + err.toString())
		}
	})
	//点击生成的 HEX 预览即可复制
	const downPreview = document.getElementById('serial-protocol-down-preview')
	if (downPreview) {
		downPreview.addEventListener('click', () => {
			const text = (downPreview.value || '').trim()
			if (!text) return
			copyText(text)
			downPreview.classList.add('is-copied')
			clearTimeout(downPreview._copyT)
			downPreview._copyT = setTimeout(() => downPreview.classList.remove('is-copied'), 800)
		})
	}
	//立即下发
	document.getElementById('serial-protocol-send').addEventListener('click', (e) => {
		const preview = document.getElementById('serial-protocol-down-preview').value
		if (!preview) {
			addLogErr('请先生成HEX再下发')
			return
		}
		sendHex(preview)
	})

	//常用指令(下行下发)初始化
	const presetSel = document.getElementById('serial-protocol-down-preset')
	const funcSel = document.getElementById('serial-protocol-down-func')

	function rebuildPresets(funcCode) {
		if (!presetSel) return
		var proto = window.getActiveProtocol()
		var presets = (proto && proto.presets) ? proto.presets : (window.SK_DOWN_PRESETS || [])
		var matchingGroups = []
		for (const grp of presets) {
			const filtered = grp.items.filter(it => it.func === funcCode)
			if (filtered.length) matchingGroups.push({ grp, filtered })
		}
		const keep = presetSel.value
		presetSel.innerHTML = ''
		const ph = document.createElement('option')
		ph.value = ''
		ph.textContent = matchingGroups.length ? '选择指令...' : '无可用指令'
		presetSel.appendChild(ph)
		for (const { grp, filtered } of matchingGroups) {
			// 单分组时不加 optgroup 标题，避免菜单里出现一条无意义的分组行
			const parent = matchingGroups.length > 1 ? document.createElement('optgroup') : presetSel
			if (parent !== presetSel) {
				parent.label = shortGroupName(grp.group, funcCode)
				presetSel.appendChild(parent)
			}
			for (const it of filtered) {
				const opt = document.createElement('option')
				opt.value = it.name
				opt.textContent = it.name
				parent.appendChild(opt)
			}
		}
		presetSel.value = keep
		if (presetSel.selectedIndex < 0) presetSel.selectedIndex = 0
	}

	// 分组名形如「参数设置-告警阈值 (0x01)」，功能码已由上方选择框决定，
	// 这里去掉重复的功能码名前缀和 (0xNN) 后缀，只留下真正区分分组的部分
	function shortGroupName(name, funcCode) {
		let s = String(name).replace(/\s*\(0x[0-9a-fA-F]+\)\s*$/, '')
		const opt = funcSel ? funcSel.options[funcSel.selectedIndex] : null
		const funcName = opt ? opt.textContent.replace(/\s*0x[0-9a-fA-F]+\s*$/, '').trim() : ''
		if (funcName && s.startsWith(funcName + '-')) s = s.slice(funcName.length + 1)
		return s || name
	}

	let _skipFuncEvent = false
	if (funcSel) {
		rebuildPresets(funcSel.value)
		funcSel.addEventListener('change', () => {
			if (_skipFuncEvent) { _skipFuncEvent = false; return }
			presetSel.value = ''
			rebuildPresets(funcSel.value)
		})
	}
	function presetItemByName(name) {
		var proto = window.getActiveProtocol()
		var presets = (proto && proto.presets) ? proto.presets : (window.SK_DOWN_PRESETS || [])
		for (const grp of presets) {
			for (const it of grp.items) {
				if (it.name === name) return it
			}
		}
		return null
	}
	function asciiToHexBytes(s, fillLen) {
		let a = []
		const n = fillLen != null ? Math.min(s.length, fillLen) : s.length
		for (let i = 0; i < n; i++) a.push(s.charCodeAt(i) & 0xff)
		if (fillLen != null) {
			while (a.length < fillLen) a.push(0x00)
		}
		return a
	}
	function bcdToBytes(s, fillLen) {
		let digits = s.replace(/\D/g, '')
		if (!digits) return []
		if (digits.length % 2 !== 0) digits = '0' + digits
		let a = []
		for (let i = digits.length - 2; i >= 0; i -= 2) {
			a.push((parseInt(digits.charAt(i), 10) << 4) | parseInt(digits.charAt(i + 1), 10))
		}
		if (fillLen != null) {
			while (a.length < fillLen) a.push(0x00)
		}
		return a
	}
	function numToBytes(val, type) {
		switch (type) {
			case 'uint32le': return [val & 0xff, (val >> 8) & 0xff, (val >> 16) & 0xff, (val >> 24) & 0xff]
			case 'uint16le': return [val & 0xff, (val >> 8) & 0xff]
			case 'uint8': return [val & 0xff]
			default: return []
		}
	}
	// BCD 一字节：十进制 0-99 → 0xNN
	function toBcdByte(n) {
		n = Math.max(0, Math.min(99, n | 0))
		return ((Math.floor(n / 10) & 0xf) << 4) | (n % 10)
	}
	// Tag10-ID9 日结：YY MM DD(各1B BCD) + 个数1B
	function dailyQueryBytes(count) {
		const d = new Date()
		const yy = d.getFullYear() % 100
		return [toBcdByte(yy), toBcdByte(d.getMonth() + 1), toBcdByte(d.getDate()), (count | 0) & 0xff]
	}
	// Tag10-ID23 错误日志：YYMMDDhhmmss 6B BCD + 条数1B
	function errLogQueryBytes(count) {
		const d = new Date()
		const yy = d.getFullYear() % 100
		return [
			toBcdByte(yy), toBcdByte(d.getMonth() + 1), toBcdByte(d.getDate()),
			toBcdByte(d.getHours()), toBcdByte(d.getMinutes()), toBcdByte(d.getSeconds()),
			(count | 0) & 0xff
		]
	}
	function presetToTlvJson(preset) {
		const out = []
		for (const blk of (preset.tlv || [])) {
			const items = []
			for (const it of (blk.items || [])) {
				let value
				if (it.ascii != null) {
					value = asciiToHexBytes(it.ascii, it.fillLen).map(b => ('0' + b.toString(16).toUpperCase()).slice(-2)).join('')
				} else if (it.value != null) {
					value = it.value.map(b => ('0' + (b & 0xff).toString(16).toUpperCase()).slice(-2)).join('')
				} else {
					value = []
				}
				const item = { id: it.id, value: value }
				items.push(item)
			}
			out.push({ tag: blk.tag, items: items })
		}
		return JSON.stringify(out, null, 0)
	}
		if (presetSel) {
		const paramGroup = document.getElementById('serial-protocol-down-param-group')
		const paramVal = document.getElementById('serial-protocol-down-param-val')
		const paramSelEnum = document.getElementById('serial-protocol-down-param-sel')
		const paramLabel = document.getElementById('serial-protocol-down-param-label')
		const paramUnit = document.getElementById('serial-protocol-down-param-unit')
		let _currentParamType = ''

		function buildWithParam() {
			const name = presetSel.value
			if (!name) return
			const preset = presetItemByName(name)
			if (!preset) return
			if (funcSel.value !== preset.func) {
				_skipFuncEvent = true
				document.getElementById('serial-protocol-down-func').value = preset.func
			}
			const tlv = JSON.parse(JSON.stringify(preset.tlv || []))
			if (preset.param) {
				let bytes
				if (preset.param.type === 'enum') {
					const rawVal = parseInt(paramSelEnum.value, 10)
					if (isNaN(rawVal)) return
					bytes = numToBytes(rawVal, 'uint8')
				} else if (preset.param.type === 'ascii') {
					const s = paramVal.value
					if (!s) return
					bytes = asciiToHexBytes(s, preset.param.fillLen)
				} else if (preset.param.type === 'bcd') {
					const s = paramVal.value
					if (!s) return
					bytes = bcdToBytes(s, preset.param.fillLen)
				} else if (preset.param.type === 'dailyQuery') {
					const rawVal = parseInt(paramVal.value.trim(), 10)
					if (isNaN(rawVal)) return
					bytes = dailyQueryBytes(rawVal)
				} else if (preset.param.type === 'errLogQuery') {
					const rawVal = parseInt(paramVal.value.trim(), 10)
					if (isNaN(rawVal)) return
					bytes = errLogQueryBytes(rawVal)
				} else {
					const rawVal = parseInt(paramVal.value.trim(), 10)
					if (isNaN(rawVal)) return
					bytes = numToBytes(rawVal, _currentParamType)
				}
				if (!bytes || !bytes.length) return
				for (const blk of tlv) {
					for (const it of (blk.items || [])) {
						if (!it.value || it.value.length === 0) it.value = bytes
					}
				}
			}
			const presetClone = { func: preset.func, tlv: tlv }
			const tlvStr = presetToTlvJson(presetClone)
			document.getElementById('serial-protocol-down-tlv').value = tlvStr
			document.getElementById('serial-protocol-build').click()
		}

		presetSel.addEventListener('change', (e) => {
			const name = e.target.value
			if (!name) { paramGroup.style.display = 'none'; return }
			const preset = presetItemByName(name)
			if (!preset) { paramGroup.style.display = 'none'; return }
			if (preset.param) {
				paramGroup.style.display = ''
				paramLabel.textContent = preset.param.label || '参数'
				if (preset.param.type === 'enum') {
					paramVal.style.display = 'none'
					paramSelEnum.style.display = ''
					paramSelEnum.innerHTML = ''
					const opts = preset.param.options || {}
					const def = preset.param.default || Object.keys(opts)[0] || '0'
					for (const [k, v] of Object.entries(opts)) {
						const op = document.createElement('option')
						op.value = k
						op.textContent = k + ':' + v
						if (String(k) === String(def)) op.selected = true
						paramSelEnum.appendChild(op)
					}
					paramUnit.textContent = ''
					_currentParamType = 'uint8'
				} else if (preset.param.type === 'ascii') {
					paramVal.style.display = ''
					paramVal.style.width = '180px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default || ''
					paramVal.placeholder = preset.param.placeholder || '值'
					paramUnit.textContent = ''
					_currentParamType = 'ascii'
				} else if (preset.param.type === 'bcd') {
					paramVal.style.display = ''
					paramVal.style.width = '180px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default || ''
					paramUnit.textContent = '(BCD LE)'
					_currentParamType = 'bcd'
				} else if (preset.param.type === 'dailyQuery') {
					paramVal.style.display = ''
					paramVal.style.width = '80px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default || '7'
					paramUnit.textContent = '条(日起=今天)'
					_currentParamType = 'dailyQuery'
				} else if (preset.param.type === 'errLogQuery') {
					paramVal.style.display = ''
					paramVal.style.width = '80px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default || '4'
					paramUnit.textContent = '条(起点=现在)'
					_currentParamType = 'errLogQuery'
				} else {
					paramVal.style.display = ''
					paramVal.style.width = '100px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default || '0'
					paramUnit.textContent = preset.param.type === 'uint32le' ? '(uint32 LE)' : preset.param.type === 'uint16le' ? '(uint16 LE)' : '(u8)'
					_currentParamType = preset.param.type
				}
			} else {
				paramGroup.style.display = 'none'
				_currentParamType = ''
			}
			buildWithParam()
		})
		paramVal.addEventListener('input', () => {
			if (_currentParamType) buildWithParam()
		})
		paramVal.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); document.getElementById('serial-protocol-send').click() }
		})
		paramSelEnum.addEventListener('change', () => {
			buildWithParam()
		})
	}
	//读取参数
	let options = localStorage.getItem('serialOptions')
	if (options) {
		let serialOptions = JSON.parse(options)
		set('serial-baud', serialOptions.baudRate)
		set('serial-data-bits', serialOptions.dataBits)
		set('serial-stop-bits', serialOptions.stopBits)
		set('serial-parity', serialOptions.parity)
		set('serial-buffer-size', serialOptions.bufferSize)
		set('serial-flow-control', serialOptions.flowControl)
	}
	options = localStorage.getItem('toolOptions')
	if (options) {
		toolOptions = JSON.parse(options)
	}
	document.getElementById('serial-timer-out').value = toolOptions.timeOut
	//老配置里没有该字段时回落到默认值
	if (!toolOptions.maxLogRows) {
		toolOptions.maxLogRows = 5000
	}
	if (toolOptions.skDownEncrypt == null) {
		toolOptions.skDownEncrypt = false
	}
	document.getElementById('serial-max-rows').value = toolOptions.maxLogRows
	document.getElementById('serial-log-type').value = toolOptions.logType
	document.getElementById('serial-auto-scroll').innerText = toolOptions.autoScroll ? '自动滚动' : '暂停滚动'
	document.getElementById('serial-add-crlf').checked = toolOptions.addCRLF
	document.getElementById('serial-hex-send').checked = toolOptions.hexSend
	document.getElementById('serial-loop-send').checked = toolOptions.loopSend
	document.getElementById('serial-loop-send-time').value = toolOptions.loopSendTime
	document.getElementById('serial-send-content').value = toolOptions.sendContent
	document.getElementById('serial-protocol-enable').checked = toolOptions.skParseEnable
	document.getElementById('serial-protocol-hover').checked = toolOptions.skHoverEnable
	if (toolOptions.skDecryptMode) {
		set('serial-protocol-decrypt', toolOptions.skDecryptMode)
	}
	document.getElementById('serial-protocol-key-ascii').value = toolOptions.skKeyAscii
	document.getElementById('serial-protocol-key-hex').value = toolOptions.skKeyHex
	const downEncEl = document.getElementById('serial-protocol-down-encrypt')
	if (downEncEl) downEncEl.checked = !!toolOptions.skDownEncrypt
	if (toolOptions.skEncType) {
		set('serial-protocol-enc-type', toolOptions.skEncType)
	}
	if (toolOptions.skProtocol) {
		window._activeProtocol = toolOptions.skProtocol
		var sel = document.getElementById('serial-protocol-select')
		if (sel) {
			var found = Array.from(sel.options).some(function (o) { return o.value === toolOptions.skProtocol })
			if (found) sel.value = toolOptions.skProtocol
		}
	}
	quickSend.value = toolOptions.quickSendIndex
	quickSend.dispatchEvent(new Event('change'))
	resetLoopSend()

	// 波特率二合一下拉输入框：可点选预设，也可直接手输
	;(function () {
		var combo = document.getElementById('baud-combo')
		var input = document.getElementById('serial-baud')
		var dropdown = document.getElementById('baud-dropdown')
		if (!combo || !input || !dropdown) return

		var isOpen = false
		//这次 click 之前，focus 是不是刚把面板打开过
		var openedByFocus = false

		function openDropdown() {
			isOpen = true
			combo.classList.add('open')
			showAll()
			setTimeout(function () { input.select() }, 0)
		}
		function closeDropdown() {
			isOpen = false
			openedByFocus = false
			combo.classList.remove('open')
		}
		function selectValue(val) {
			input.value = val
			closeDropdown()
			input.dispatchEvent(new Event('change', { bubbles: true }))
		}
		function showAll() {
			dropdown.querySelectorAll('li').forEach(function (li) {
				li.style.display = ''
			})
		}
		function filterOptions(query) {
			var q = query.toLowerCase()
			dropdown.querySelectorAll('li').forEach(function (li) {
				li.style.display = li.textContent.indexOf(q) !== -1 ? '' : 'none'
			})
		}

		input.addEventListener('focus', function () {
			if (isOpen) return
			openDropdown()
			openedByFocus = true
		})
		input.addEventListener('click', function (e) {
			e.stopPropagation()
			//同一次点击先触发 focus 打开、再触发 click，
			//如果这里照常 toggle 就会立刻关掉，逼用户点第二下
			if (openedByFocus) {
				openedByFocus = false
				return
			}
			if (isOpen) { closeDropdown(); return }
			openDropdown()
		})
		input.addEventListener('input', function () {
			openedByFocus = false
			if (!isOpen) openDropdown()
			filterOptions(this.value)
		})
		input.addEventListener('keydown', function (e) {
			openedByFocus = false
			if (e.key === 'Escape') {
				if (!isOpen) return
				//外层串口参数浮层也监听 Esc，这一次先只关自己
				e.stopPropagation()
				closeDropdown()
				input.blur()
				return
			}
			if (e.key === 'Enter') {
				var active = dropdown.querySelector('li.active')
				if (active && active.style.display !== 'none') {
					selectValue(active.getAttribute('data-value'))
					e.preventDefault()
				}
				closeDropdown()
				return
			}
			if (e.key === 'ArrowDown') {
				e.preventDefault()
				if (!isOpen) { openDropdown(); return }
				moveHighlight(1)
				return
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault()
				if (!isOpen) { openDropdown(); return }
				moveHighlight(-1)
				return
			}
		})
		function moveHighlight(dir) {
			var visible = []
			dropdown.querySelectorAll('li').forEach(function (li) {
				if (li.style.display !== 'none') visible.push(li)
			})
			if (!visible.length) return
			var curr = dropdown.querySelector('li.active')
			var idx = curr ? visible.indexOf(curr) : -1
			if (curr) curr.classList.remove('active')
			idx = (idx + dir + visible.length) % visible.length
			visible[idx].classList.add('active')
			visible[idx].scrollIntoView({ block: 'nearest' })
		}

		//用 mousedown 而不是 click：input 会先 blur 再收到 click，
		//blur 的重绘时机下 li 可能已经被隐藏，点击就落空了
		dropdown.addEventListener('mousedown', function (e) {
			var li = e.target.closest('li')
			if (!li) return
			e.preventDefault()
			selectValue(li.getAttribute('data-value'))
		})

		document.addEventListener('click', function (e) {
			if (!combo.contains(e.target)) closeDropdown()
		})

		//悬停展开；输入框仍聚焦时移出不关
		var baudHoverT = 0
		combo.addEventListener('mouseenter', function () {
			clearTimeout(baudHoverT)
			baudHoverT = setTimeout(function () {
				if (!isOpen) {
					isOpen = true
					combo.classList.add('open')
					showAll()
				}
			}, 100)
		})
		combo.addEventListener('mouseleave', function () {
			clearTimeout(baudHoverT)
			baudHoverT = setTimeout(function () {
				if (document.activeElement === input) return
				closeDropdown()
			}, 200)
		})
	})()

	// 记住当前 tab，刷新不丢失
	const tabTriggers = document.querySelectorAll('#nav-tab button[data-bs-toggle="tab"]')
	tabTriggers.forEach(btn => {
		btn.addEventListener('shown.bs.tab', (e) => {
			localStorage.setItem('activeTab', e.target.id)
		})
	})
	const savedTab = localStorage.getItem('activeTab')
	if (savedTab) {
		const tabBtn = document.getElementById(savedTab)
		if (tabBtn) {
			const tab = new bootstrap.Tab(tabBtn)
			tab.show()
		}
	}

	//实时修改选项
	document.getElementById('serial-timer-out').addEventListener('change', (e) => {
		changeOption('timeOut', parseInt(e.target.value))
	})
	document.getElementById('serial-max-rows').addEventListener('change', (e) => {
		let max = parseInt(e.target.value)
		if (isNaN(max) || max < 100) {
			max = 100
		}
		e.target.value = max
		changeOption('maxLogRows', max)
		trimLogRows()
	})
	// 日志类型：自定义下拉（悬停/点击展开），底层保留隐藏 select 兼容命令面板
	;(function () {
		const wrap = document.querySelector('.serial-log-type-wrap')
		const combo = document.getElementById('log-type-combo')
		const btn = document.getElementById('serial-log-type-btn')
		const menu = document.getElementById('serial-log-type-menu')
		const label = document.getElementById('serial-log-type-text')
		const select = document.getElementById('serial-log-type')
		if (!wrap || !combo || !btn || !menu || !label || !select) return

		function labelOf(val) {
			for (let i = 0; i < select.options.length; i++) {
				if (select.options[i].value === val) return select.options[i].textContent
			}
			return val
		}
		function syncUi(val) {
			label.textContent = labelOf(val)
			menu.querySelectorAll('li').forEach(function (li) {
				const on = li.getAttribute('data-value') === val
				li.classList.toggle('active', on)
				li.setAttribute('aria-selected', on ? 'true' : 'false')
			})
			const logsEl = document.getElementById('serial-logs')
			if (!logsEl) return
			logsEl.classList.toggle('ansi', String(val).includes('ansi'))
		}
		function openMenu() {
			combo.classList.add('open')
			btn.setAttribute('aria-expanded', 'true')
		}
		function closeMenu() {
			combo.classList.remove('open')
			btn.setAttribute('aria-expanded', 'false')
		}
		function setLogType(val) {
			if (select.value !== val) select.value = val
			syncUi(val)
			changeOption('logType', val)
		}

		syncUi(select.value || toolOptions.logType || 'hex')

		select.addEventListener('change', function (e) {
			syncUi(e.target.value)
			changeOption('logType', e.target.value)
		})

		btn.addEventListener('click', function (e) {
			e.preventDefault()
			e.stopPropagation()
			if (combo.classList.contains('open')) closeMenu()
			else openMenu()
		})
		menu.addEventListener('mousedown', function (e) {
			const li = e.target.closest('li[data-value]')
			if (!li) return
			e.preventDefault()
			e.stopPropagation()
			setLogType(li.getAttribute('data-value'))
			closeMenu()
		})

		let hoverT = 0
		wrap.addEventListener('mouseenter', function () {
			clearTimeout(hoverT)
			hoverT = setTimeout(openMenu, 80)
		})
		wrap.addEventListener('mouseleave', function () {
			clearTimeout(hoverT)
			hoverT = setTimeout(closeMenu, 160)
		})
		document.addEventListener('click', function (e) {
			if (!wrap.contains(e.target)) closeMenu()
		})
		btn.addEventListener('keydown', function (e) {
			if (e.key === 'Escape') {
				closeMenu()
				return
			}
			if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
				e.preventDefault()
				openMenu()
			}
		})
	})()
	document.getElementById('serial-auto-scroll').addEventListener('click', function (e) {
		let autoScroll = this.innerText != '自动滚动'
		this.innerText = autoScroll ? '自动滚动' : '暂停滚动'
		changeOption('autoScroll', autoScroll)
	})
	document.getElementById('serial-send-content').addEventListener('change', function (e) {
		changeOption('sendContent', this.value)
	})
	document.getElementById('serial-add-crlf').addEventListener('change', function (e) {
		changeOption('addCRLF', this.checked)
	})
	document.getElementById('serial-hex-send').addEventListener('change', function (e) {
		changeOption('hexSend', this.checked)
	})
	document.getElementById('serial-loop-send').addEventListener('change', function (e) {
		changeOption('loopSend', this.checked)
		resetLoopSend()
	})
	document.getElementById('serial-loop-send-time').addEventListener('change', function (e) {
		changeOption('loopSendTime', parseInt(this.value))
		resetLoopSend()
	})
	document.getElementById('serial-protocol-enable').addEventListener('change', function (e) {
		changeOption('skParseEnable', this.checked)
	})
	document.getElementById('serial-protocol-hover').addEventListener('change', function (e) {
		changeOption('skHoverEnable', this.checked)
	})
	document.getElementById('serial-protocol-decrypt').addEventListener('change', function (e) {
		changeOption('skDecryptMode', this.value)
	})
	document.getElementById('serial-protocol-key-ascii').addEventListener('change', function (e) {
		changeOption('skKeyAscii', this.value)
	})
	document.getElementById('serial-protocol-key-hex').addEventListener('change', function (e) {
		changeOption('skKeyHex', this.value)
	})
	document.getElementById('serial-protocol-enc-type').addEventListener('change', function (e) {
		changeOption('skEncType', this.value)
	})
	const downEncryptToggle = document.getElementById('serial-protocol-down-encrypt')
	if (downEncryptToggle) {
		downEncryptToggle.addEventListener('change', function () {
			changeOption('skDownEncrypt', this.checked)
		})
	}

	document.querySelectorAll('#serial-params-popover .serial-field input,#serial-params-popover .serial-field select').forEach((item) => {
		item.addEventListener('change', async (e) => {
			if (!serialOpen || serialOpening) {
				return
			}
			//未找到API可以动态修改串口参数,先关闭再重新打开
			serialOpening = true
			try {
				await closeSerial()
				//等底层端口完全释放后再 open，避免 InvalidStateError
				await new Promise((resolve) => setTimeout(resolve, 100))
				await openSerial()
			} finally {
				serialOpening = false
			}
		})
	})

	//重制发送循环时钟
	function resetLoopSend() {
		clearInterval(serialloopSendTimer)
		if (toolOptions.loopSend) {
			serialloopSendTimer = setInterval(() => {
				send()
			}, toolOptions.loopSendTime)
		}
	}

	//日志纯文本(复制/导出用):结构化行拼成 "时间 方向 内容",其余节点回退到 innerText
	function getLogsText() {
		let lines = []
		for (const node of serialLogs.children) {
			if (node.classList.contains('log-row')) {
				const time = node.querySelector('.log-time')
				const dir = node.querySelector('.log-dir')
				const body = node.querySelector('.log-body')
				let head = []
				if (time && time.innerText) head.push(time.innerText)
				if (dir && dir.innerText) head.push(dir.innerText)
				const content = body ? body.innerText : ''
				lines.push((head.join(' ') + ' ' + content).trim())
			} else {
				const t = node.innerText
				if (t) lines.push(t)
			}
		}
		return lines.join('\n')
	}
	//清空
	document.getElementById('serial-clear').addEventListener('click', (e) => {
		serialLogs.innerHTML = ''
		selectedLogRow = null
	})
	//复制
	document.getElementById('serial-copy').addEventListener('click', (e) => {
		let text = getLogsText()
		if (text) {
			copyText(text)
		}
	})
	//保存
	document.getElementById('serial-save').addEventListener('click', (e) => {
		let text = getLogsText()
		if (text) {
			saveText(text)
		}
	})
	//发送
	document.getElementById('serial-send').addEventListener('click', (e) => {
		send()
	})

	const serialToggle = document.getElementById('serial-open-or-close')
	const serialLogs = document.getElementById('serial-logs')

	//静默解析悬停提示浮层
	const skHoverTip = document.createElement('div')
	skHoverTip.id = 'sk-hover-tip'
	skHoverTip.style.display = 'none'
	document.body.appendChild(skHoverTip)
	function showSkHoverTip(span) {
		const tip = span.getAttribute('data-tip')
		if (!tip) {
			skHoverTip.style.display = 'none'
			return
		}
		skHoverTip.textContent = tip
		skHoverTip.style.display = 'block'
		const rect = span.getBoundingClientRect()
		const tw = skHoverTip.offsetWidth
		const th = skHoverTip.offsetHeight
		let left = rect.left + window.scrollX
		let top = rect.bottom + window.scrollY + 4
		if (left + tw > window.scrollX + document.documentElement.clientWidth) {
			left = window.scrollX + document.documentElement.clientWidth - tw - 4
		}
		if (top + th > window.scrollY + document.documentElement.clientHeight) {
			top = rect.top + window.scrollY - th - 4
		}
		skHoverTip.style.left = left + 'px'
		skHoverTip.style.top = top + 'px'
	}
	function clearSkHoverActive() {
		const act = document.querySelectorAll('.sk-hex-byte-active')
		for (const el of act) el.classList.remove('sk-hex-byte-active')
	}
	function onSkHexHover(e) {
		if (!e.target || !e.target.closest) return
		const span = e.target.closest('.sk-hex-byte')
		if (span) {
			clearSkHoverActive()
			const grp = span.getAttribute('data-grp')
			if (grp) {
				const peers = document.querySelectorAll('.sk-hex-byte[data-grp="' + grp + '"]')
				for (const el of peers) el.classList.add('sk-hex-byte-active')
			}
			showSkHoverTip(span)
		} else {
			clearSkHoverActive()
			skHoverTip.style.display = 'none'
		}
	}
	function hideSkHover() {
		clearSkHoverActive()
		skHoverTip.style.display = 'none'
	}
	serialLogs.addEventListener('mouseover', onSkHexHover)
	serialLogs.addEventListener('scroll', hideSkHover)
	serialLogs.addEventListener('mouseleave', hideSkHover)
	const protocolHexViewHover = document.getElementById('serial-protocol-hexview')
	if (protocolHexViewHover) {
		protocolHexViewHover.addEventListener('mouseover', onSkHexHover)
		protocolHexViewHover.addEventListener('scroll', hideSkHover)
		protocolHexViewHover.addEventListener('mouseleave', hideSkHover)
	}

	//点击日志行:把该行的原始HEX灌进底部解析面板并解析(事件委托,不影响悬停提示)
	let selectedLogRow = null
	serialLogs.addEventListener('click', (e) => {
		if (!e.target || !e.target.closest) return
		const row = e.target.closest('.log-row')
		if (!row || !serialLogs.contains(row)) return
		const hex = row.getAttribute('data-hex')
		if (!hex) return
		//选中文本时不触发解析,避免影响复制
		const sel = window.getSelection()
		if (sel && !sel.isCollapsed && sel.toString()) return
		if (selectedLogRow && selectedLogRow !== row) {
			selectedLogRow.classList.remove('selected')
		}
		row.classList.add('selected')
		selectedLogRow = row
		if (typeof window.expandParsePanel === 'function') {
			window.expandParsePanel()
		}
		applyProtocolHexInput(hex)
	})

	//选择串口
	document.getElementById('serial-select-port').addEventListener('click', async () => {
		// 客户端授权
		try {
			await navigator.serial.requestPort().then(async (port) => {
				await closeSerial()
				serialPort = port
				addLogErr('串口已选择')
			})
		} catch (e) {
			const errorType = e.name || 'UnknownError'
			const errorMsg = e.message || '未知错误'
			
			if (errorType === 'NotFoundError') {
				addLogErr('未选择串口设备')
			} else if (errorType === 'SecurityError') {
				addLogErr('串口权限被拒绝')
			} else {
				addLogErr(`获取串口权限出错: ${errorType} - ${errorMsg}`)
			}
		}
	})

	//关闭串口(无论 serialOpen 标志如何都尽量释放 reader/port，避免锁泄漏导致再次打开失败)
	async function closeSerial() {
		serialOpen = false
		const r = reader
		reader = null
		if (r) {
			try {
				await r.cancel()
			} catch (e) {}
			try {
				r.releaseLock()
			} catch (e) {}
		}
		if (serialPort) {
			try {
				await serialPort.close()
			} catch (e) {}
		}
		//仅手动关闭时清掉“想打开”标记；异常断开保留，刷新后仍可重连
		if (serialClose) setSerialWantOpen(false)
		serialStatuChange(false)
		serialToggle.innerHTML = '<i class="bi bi-play-circle"></i> 打开串口'
	}

	//打开串口
	async function openSerial() {
		if (serialOpen) return
		if (!serialPort) return
		let SerialOptions = {
			baudRate: parseInt(get('serial-baud')),
			dataBits: parseInt(get('serial-data-bits')),
			stopBits: parseInt(get('serial-stop-bits')),
			parity: get('serial-parity'),
			bufferSize: parseInt(get('serial-buffer-size')),
			flowControl: get('serial-flow-control'),
		}
		try {
			//端口可能处于“已打开但本地状态丢失”的脏状态，先尝试 close 再 open
			try {
				await serialPort.close()
			} catch (e) {}
			await serialPort.open(SerialOptions)
			serialToggle.innerHTML = '<i class="bi bi-stop-circle"></i> 关闭串口'
			serialOpen = true
			serialClose = false
			setSerialWantOpen(true)
			serialStatuChange(true)
			localStorage.setItem('serialOptions', JSON.stringify(SerialOptions))
			readData()
		} catch (e) {
			const errorType = e.name || 'UnknownError'
			const errorMsg = e.message || '未知错误'
			serialOpen = false
			serialStatuChange(false)
			serialToggle.innerHTML = '<i class="bi bi-play-circle"></i> 打开串口'

			addLogErr(`打开串口失败: ${errorType} - ${errorMsg}`)

			if (errorType === 'SecurityError') {
				addLogErr('权限错误：请检查浏览器串口权限设置')
			} else if (errorType === 'InvalidStateError') {
				addLogErr('串口状态错误：设备可能已被占用')
			} else if (errorType === 'NetworkError') {
				addLogErr('网络错误：设备可能已断开连接')
			}

			showMsg('打开串口失败:' + e.toString())
		}
	}

	//打开或关闭串口
	serialToggle.addEventListener('click', async () => {
		if (serialOpening) return

		if (!serialPort) {
			showMsg('请先选择串口')
			return
		}

		if (serialOpen) {
			serialClose = true
			serialOpening = true
			try {
				await closeSerial()
			} finally {
				serialOpening = false
			}
			return
		}

		serialOpening = true
		serialClose = false
		try {
			await openSerial()
		} finally {
			serialOpening = false
		}
	})

	//设置读取元素
	function get(id) {
		return document.getElementById(id).value
	}
	function set(id, value) {
		return (document.getElementById(id).value = value)
	}

	//修改参数并保存
	function changeOption(key, value) {
		toolOptions[key] = value
		localStorage.setItem('toolOptions', JSON.stringify(toolOptions))
	}

	//串口事件监听(Web Serial: 事件目标是 navigator.serial，端口在 e.port)
	function serialEventPort(e) {
		if (e && e.port && typeof e.port.open === 'function') return e.port
		//兼容极旧实现：少数环境曾把 SerialPort 放在 target
		const t = e && e.target
		if (t && typeof t.open === 'function' && typeof t.getInfo === 'function') return t
		return null
	}
	function serialPortLabel(port) {
		try {
			const info = port && port.getInfo ? port.getInfo() : {}
			const vendorId = info.usbVendorId != null ? `0x${info.usbVendorId.toString(16).padStart(4, '0')}` : '未知'
			const productId = info.usbProductId != null ? `0x${info.usbProductId.toString(16).padStart(4, '0')}` : '未知'
			return `Vendor: ${vendorId}, Product: ${productId}`
		} catch (err) {
			return 'Vendor: 未知, Product: 未知'
		}
	}
	navigator.serial.addEventListener('connect', (e) => {
		const port = serialEventPort(e)
		addLogErr(`设备已连接 (${serialPortLabel(port)})`)
		if (port && typeof port.open === 'function') {
			serialPort = port
		}
		//未主动关闭时，设备重插后自动重连
		if (!serialClose && !serialOpening && serialPort) {
			openSerial()
		}
	})
	navigator.serial.addEventListener('disconnect', async (e) => {
		const port = serialEventPort(e)
		addLogErr(`设备断开连接 (${serialPortLabel(port)})`)
		//仅当断开的是当前端口时清理；USB 拔出后旧 port 已失效，重连应等 connect 事件
		if (port && serialPort && port !== serialPort) return
		await closeSerial()
		if (!serialClose) {
			addLogErr('设备已断开，重新插入后将自动重连')
		}
	})
	function serialStatuChange(statu) {
		var el = document.getElementById('serial-status')
		if (statu) {
			el.innerHTML = '<div class="serial-status-indicator connected"><span class="serial-status-dot"></span><span class="serial-status-text">已连接</span></div>'
		} else {
			el.innerHTML = '<div class="serial-status-indicator disconnected"><span class="serial-status-dot"></span><span class="serial-status-text">未连接</span></div>'
		}
	}
	//串口数据收发
	async function send() {
		let content = document.getElementById('serial-send-content').value
		if (!content) {
			addLogErr('发送内容为空')
			return
		}
		if (toolOptions.hexSend) {
			await sendHex(content)
		} else {
			await sendText(content)
		}
	}

	//发送HEX到串口
	async function sendHex(hex) {
		const value = hex.replace(/\s+/g, '')
		if (/^[0-9A-Fa-f]+$/.test(value) && value.length % 2 === 0) {
			let data = []
			for (let i = 0; i < value.length; i = i + 2) {
				data.push(parseInt(value.substring(i, i + 2), 16))
			}
			await writeData(Uint8Array.from(data))
		} else {
			addLogErr('HEX格式错误:' + hex)
		}
	}

	//发送文本到串口
	async function sendText(text) {
		const encoder = new TextEncoder()
		await writeData(encoder.encode(text))
	}

	//写串口数据
	async function writeData(data) {
		if (!serialPort || !serialPort.writable) {
			addLogErr('请先打开串口再发送数据')
			return
		}
		let writer
		try {
			writer = serialPort.writable.getWriter()
			if (toolOptions.addCRLF) {
				data = new Uint8Array([...data, 0x0d, 0x0a])
			}
			await writer.write(data)
			addLog(data, false)
			addParseLog([...data], false)
		} catch (error) {
			const errorType = error.name || 'UnknownError'
			const errorMsg = error.message || '未知错误'
			addLogErr(`串口写入失败: ${errorType} - ${errorMsg}`)
		} finally {
			if (writer) {
				try { writer.releaseLock() } catch (e) {}
			}
		}
	}

	//读串口数据
	async function readData() {
		let streamError = false

		while (serialOpen && serialPort && serialPort.readable) {
			const r = serialPort.readable.getReader()
			reader = r
			try {
				while (true) {
					const { value, done } = await r.read()
					if (done) break
					dataReceived(value)
				}
			} catch (error) {
				const errorType = error.name || 'UnknownError'
				const errorMsg = error.message || '未知错误'
				//手动 close/cancel 时 read 会失败，不当作异常噪声
				if (serialOpen) {
					addLogErr(`串口读取错误: ${errorType} - ${errorMsg}`)
					if (errorType === 'NetworkError' || errorType === 'DeviceLostError') {
						addLogErr('设备可能已断开连接')
						streamError = true
					} else if (errorType === 'SecurityError') {
						addLogErr('串口权限错误，请重新授权')
						streamError = true
					} else {
						streamError = true
					}
				}
			} finally {
				if (reader === r) reader = null
				try {
					r.releaseLock()
				} catch (e) {}
			}
			//流异常时退出循环，由 disconnect/connect 或用户手动处理重连
			if (streamError || !serialOpen) break
		}

		if (streamError && serialOpen) {
			serialOpen = false
			serialStatuChange(false)
			serialToggle.innerHTML = '<i class="bi bi-play-circle"></i> 打开串口'
			if (!serialClose) {
				addLogErr('读取中断，可重新打开串口或等待设备重连')
			}
		}
	}

	//串口分包合并
	function dataReceived(data) {
		//立即把原始字节交给固件升级/协议测试等模块,由其自行按协议帧边界组装
		if (window.serialApi) {
			const api = window.serialApi
			if (api._receivers && api._receivers.length) {
				for (let i = 0; i < api._receivers.length; i++) {
					try { api._receivers[i](data) } catch (e) { /* ignore */ }
				}
			} else if (api._onReceive) {
				api._onReceive(data)
			}
		}
		serialData.push(...data)
		if (toolOptions.timeOut == 0) {
			addLog(serialData, true)
			addParseLog([...serialData], true)
			serialData = []
			return
		}
		//清除之前的时钟
		clearTimeout(serialTimer)
		serialTimer = setTimeout(() => {
			//超时发出
			addLog(serialData, true)
			addParseLog([...serialData], true)
			serialData = []
		}, toolOptions.timeOut)
	}

	//对外暴露的串口接口(供固件升级/协议测试等模块使用)
	//onReceive 支持多订阅者; 旧单回调 _onReceive 仍兼容
	window.serialApi = {
		async writeData(data) {
			await writeData(data)
		},
		isOpen() {
			return !!(serialPort && serialPort.writable && serialOpen)
		},
		//升级进行中时禁止第三方协议解析日志,避免干扰
		suppressParse: false,
		_onReceive: null,
		_receivers: [],
		onReceive(cb) {
			if (typeof cb !== 'function') return function () {}
			this._receivers.push(cb)
			//兼容旧固件升级模块: 保留最后一个单回调
			this._onReceive = cb
			const self = this
			return function unsubscribe() {
				const idx = self._receivers.indexOf(cb)
				if (idx !== -1) self._receivers.splice(idx, 1)
				if (self._onReceive === cb) {
					self._onReceive = self._receivers.length
						? self._receivers[self._receivers.length - 1]
						: null
				}
			}
		},
		//下行加密密钥; 未勾选「下发加密」时返回 null(明文)。解析密钥见 getParseOpts
		getEncKey() {
			return getDownlinkEncKey()
		},
		getParseOpts() {
			return getProtocolParseOpts()
		},
	}
	var ansi_up = new AnsiUp()
	//日志行裁剪:超过 maxLogRows 时从顶部批量删除,并保持非自动滚动时的视觉位置不跳
	function trimLogRows() {
		const max = parseInt(toolOptions.maxLogRows, 10)
		if (!max || max < 1) return
		let over = serialLogs.childElementCount - max
		if (over <= 0) return
		const beforeTop = serialLogs.scrollTop
		const beforeHeight = serialLogs.scrollHeight
		while (over-- > 0 && serialLogs.firstElementChild) {
			serialLogs.removeChild(serialLogs.firstElementChild)
		}
		if (toolOptions.autoScroll) return
		const want = Math.max(0, beforeTop - (beforeHeight - serialLogs.scrollHeight))
		if (Math.abs(serialLogs.scrollTop - want) > 1) {
			serialLogs.scrollTop = want
		}
	}
	//统一的日志追加入口:裁剪 + 自动滚动
	function appendLogNode(node) {
		serialLogs.append(node)
		trimLogRows()
		if (toolOptions.autoScroll) {
			serialLogs.scrollTop = serialLogs.scrollHeight - serialLogs.clientHeight
		}
	}
	//添加日志
	function addLog(data, isReceive = true) {
		let form = isReceive ? '←' : '→'
		//无论当前 logType 是什么都算出 HEX,点击行解析要用
		let dataHex = []
		for (const d of data) {
			//转16进制并补0
			dataHex.push(('0' + d.toString(16).toLocaleUpperCase()).slice(-2))
		}
		newmsg = ''
		if (toolOptions.logType.includes('hex')) {
			if (toolOptions.logType.includes('&')) {
				newmsg += 'HEX:'
			}
			if (toolOptions.skHoverEnable && typeof skByteMap === 'function') {
				try {
					const bm = skByteMap(skParseFrame(data, {
						keyAscii: toolOptions.skKeyAscii || undefined,
						keyHex: toolOptions.skKeyHex || undefined,
						decryptMode: toolOptions.skDecryptMode,
					}))
				let spanHtml = ''
				for (let i = 0; i < data.length; i++) {
					const h = dataHex[i]
					const cell = bm[i]
					if (cell && cell.tip) {
						spanHtml += '<span class="sk-hex-byte" data-grp="' + attrEscape(cell.grp) + '" data-tip="' + attrEscape(cell.tip) + '">' + h + '</span>'
					} else {
						spanHtml += h
					}
					if (i < data.length - 1) spanHtml += ' '
				}
					newmsg += spanHtml + '<br/>'
				} catch (e) {
					newmsg += dataHex.join(' ') + '<br/>'
				}
			} else {
				newmsg += dataHex.join(' ') + '<br/>'
			}
		}
		if (toolOptions.logType.includes('text')) {
			let dataText = textdecoder.decode(Uint8Array.from(data))
			if (toolOptions.logType.includes('&')) {
				newmsg += 'TEXT:'
			}
			//转义HTML标签,防止内容被当作标签渲染
			newmsg += HTMLEncode(dataText)
		}
		if (toolOptions.logType.includes('ansi')) {
			const dataText = textdecoder.decode(Uint8Array.from(data))
			const html = ansi_up.ansi_to_html(dataText)
			newmsg += html
		}
		//行尾多余的换行会撑出一条空行
		newmsg = newmsg.replace(/<br\/?>$/i, '')
		let time = toolOptions.showTime ? formatDate(new Date()) : ''
		let row = document.createElement('div')
		row.className = 'log-row'
		row.setAttribute('data-dir', isReceive ? 'rx' : 'tx')
		row.setAttribute('data-hex', dataHex.join(' '))
		row.innerHTML = '<span class="log-time">' + time + '</span>' +
			'<span class="log-dir">' + form + '</span>' +
			'<span class="log-body">' + newmsg + '</span>'
		appendLogNode(row)
	}
	//第三方协议解析日志
	function addParseLog(data, isReceive) {
		if (!toolOptions.skParseEnable) {
			return
		}
		if (window.serialApi && window.serialApi.suppressParse) {
			return
		}
		let html
		try {
			const r = skParseFrame(data, {
				keyAscii: toolOptions.skKeyAscii || undefined,
				keyHex: toolOptions.skKeyHex || undefined,
				decryptMode: toolOptions.skDecryptMode,
			})
			const form = isReceive ? '←' : '→'
			const dirCls = isReceive ? 'sk-parse-up' : 'sk-parse-down'
			const time = toolOptions.showTime ? formatDate(new Date()) + '&nbsp;' : ''
			const prompt = r.needKey ? '<div class="sk-parse-err">⚠ 加密报文,请在右侧「第三方协议」中的「密钥(ASCII)」或「密钥(HEX)」输入框填入密钥后再解析</div>' : ''
			html = '<div class="sk-parse-block ' + dirCls + '"><span class="text-muted small">' + time + form + ' 解析</span>' + prompt + skFormatFrame(r) + '</div>'
		} catch (err) {
			html = '<div class="sk-parse-block sk-parse-error"><span class="text-danger small">第三方协议解析异常:' + HTMLEncode(String(err)) + '</span></div>'
		}
		let tempNode = document.createElement('div')
		tempNode.innerHTML = html
		appendLogNode(tempNode)
	}
	//HTML转义
	function HTMLEncode(html) {
		var temp = document.createElement('div')
		temp.textContent != null ? (temp.textContent = html) : (temp.innerText = html)
		var output = temp.innerHTML
		temp = null
		return output
	}
	//HTML反转义
	function HTMLDecode(text) {
		var temp = document.createElement('div')
		temp.innerHTML = text
		var output = temp.innerText || temp.textContent
		temp = null
		return output
	}
	//属性值转义(用于 data-tip="..." 内)
	function attrEscape(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;')
	}
	//系统日志
	function addLogErr(msg) {
		let time = toolOptions.showTime ? formatDate(new Date()) : ''
		let row = document.createElement('div')
		row.className = 'log-row'
		row.setAttribute('data-dir', 'sys')
		row.innerHTML = '<span class="log-time">' + time + '</span>' +
			'<span class="log-dir">!</span>' +
			'<span class="log-body text-danger">' + msg + '</span>'
		appendLogNode(row)
	}

	//轻量 toast 提示(非确认框)
	let _toastTimer = null
	function showToast(msg, ms) {
		let tip = document.getElementById('serial-toast')
		if (!tip) {
			tip = document.createElement('div')
			tip.id = 'serial-toast'
			tip.className = 'serial-toast'
			tip.setAttribute('role', 'status')
			document.body.appendChild(tip)
		}
		tip.textContent = msg
		tip.classList.add('is-show')
		clearTimeout(_toastTimer)
		_toastTimer = setTimeout(function () {
			tip.classList.remove('is-show')
		}, ms != null ? ms : 1400)
	}

	//复制文本 — 成功后 toast 提示, 不弹确认框
	function copyText(text) {
		let textarea = document.createElement('textarea')
		textarea.value = text
		textarea.readOnly = 'readonly'
		textarea.style.position = 'absolute'
		textarea.style.left = '-9999px'
		document.body.appendChild(textarea)
		textarea.select()
		textarea.setSelectionRange(0, textarea.value.length)
		document.execCommand('copy')
		document.body.removeChild(textarea)
		showToast('复制成功')
	}

	//保存文本
	function saveText(text) {
		let blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
		saveAs(blob, 'serial.log')
	}

	//下载文件
	function saveAs(blob, filename) {
		if (window.navigator.msSaveOrOpenBlob) {
			navigator.msSaveBlob(blob, filename)
		} else {
			let link = document.createElement('a')
			let body = document.querySelector('body	')
			link.href = window.URL.createObjectURL(blob)
			link.download = filename
			// fix Firefox
			link.style.display = 'none'
			body.appendChild(link)
			link.click()
			body.removeChild(link)
			window.URL.revokeObjectURL(link.href)
		}
	}

	//弹窗
	const modalTip = new bootstrap.Modal('#model-tip')
	function showMsg(msg, title = 'Web Serial') {
		//alert(msg)
		document.getElementById('modal-title').innerHTML = title
		document.getElementById('modal-message').innerHTML = msg
		modalTip.show()
	}

	//当前时间 精确到毫秒
	function formatDate(now) {
		const hour = now.getHours() < 10 ? '0' + now.getHours() : now.getHours()
		const minute = now.getMinutes() < 10 ? '0' + now.getMinutes() : now.getMinutes()
		const second = now.getSeconds() < 10 ? '0' + now.getSeconds() : now.getSeconds()
		const millisecond = ('00' + now.getMilliseconds()).slice(-3)
		return `${hour}:${minute}:${second}.${millisecond}`
	}

	// 顶部连接条：参数摘要文案 + 悬停展开/移出关闭
	;(function () {
		const summaryText = document.getElementById('serial-params-summary-text')
		if (!summaryText) return

		const PARITY_ABBR = { none: 'N', even: 'E', odd: 'O' }
		const FIELDS = ['serial-baud', 'serial-data-bits', 'serial-stop-bits', 'serial-parity']

		function updateSummary() {
			const baud = (get('serial-baud') || '').trim() || '-'
			const dataBits = get('serial-data-bits') || '-'
			const stopBits = get('serial-stop-bits') || '-'
			const parity = PARITY_ABBR[get('serial-parity')] || 'N'
			summaryText.textContent = `${baud} ${dataBits}-${parity}-${stopBits}`
		}

		FIELDS.forEach(function (id) {
			const el = document.getElementById(id)
			if (!el) return
			el.addEventListener('change', updateSummary)
			el.addEventListener('input', updateSummary)
		})
		updateSummary()

		//浮层里是原生表单控件而不是 dropdown-item，
		//上下键要留给 select/input 自己，别让 Bootstrap 的菜单键盘导航截走
		const popover = document.getElementById('serial-params-popover')
		if (popover) {
			popover.addEventListener('keydown', function (e) {
				if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.stopPropagation()
			})
		}

		//悬停展开：移入打开，移出延迟关闭，避免经过缝隙时闪断
		const ddRoot = document.getElementById('serial-params-dropdown')
		const ddToggle = document.getElementById('serial-params-summary')
		if (ddRoot && ddToggle && typeof bootstrap !== 'undefined' && bootstrap.Dropdown) {
			const dd = bootstrap.Dropdown.getOrCreateInstance(ddToggle, { autoClose: 'outside' })
			let leaveT = 0
			const OPEN_DELAY = 80
			const CLOSE_DELAY = 180
			ddRoot.addEventListener('mouseenter', function () {
				clearTimeout(leaveT)
				leaveT = setTimeout(function () { dd.show() }, OPEN_DELAY)
			})
			ddRoot.addEventListener('mouseleave', function () {
				clearTimeout(leaveT)
				leaveT = setTimeout(function () {
					//嵌套波特率下拉打开时不关，避免选值时被收起
					const baudCombo = document.getElementById('baud-combo')
					if (baudCombo && baudCombo.classList.contains('open')) return
					dd.hide()
				}, CLOSE_DELAY)
			})
		}
	})()

	// details「高级·加解密与密钥」：悬停展开，鼠标移出整个 details 范围后延迟收起
	// 原生 <select>（日志类型/协议/分组等）系统控件无法可靠悬停打开，替换成自定义会伤键盘与移动端，故不做
	;(function () {
		const adv = document.getElementById('serial-protocol-advanced')
		if (!adv) return
		let hoverT = 0
		adv.addEventListener('mouseenter', function () {
			clearTimeout(hoverT)
			if (adv.open) return
			hoverT = setTimeout(function () { adv.open = true }, 100)
		})
		adv.addEventListener('mouseleave', function () {
			clearTimeout(hoverT)
			hoverT = setTimeout(function () {
				// 内部 select/input 仍聚焦时不收，避免选值或输入时面板被关掉
				if (adv.contains(document.activeElement)) return
				adv.open = false
			}, 200)
		})
	})()

	// 右栏：折叠条既是拖拽手柄(改宽度)也是折叠按钮(原地点击)
	;(function () {
		const main = document.getElementById('main')
		if (!main) return
		const WIDTH_KEY = 'sidebarWidths'
		//左栏已被顶部连接条取代，这里只剩右栏；left 分支保留但会安全退化
		const DEFAULTS = { right: 428 }
		//拖拽宽度上下限，避免被拖成不可用的窄条或吃掉整个日志区
		const LIMITS = { right: [280, 760] }
		const PANES = Object.keys(LIMITS)
		const DRAG_THRESHOLD = 4
		//折叠时暂存被拖出来的内联宽度，展开后还回去
		const stashedWidth = {}

		function sidebarOf(pane) {
			return pane === 'right' ? document.getElementById('serial-tools') : null
		}
		function isCollapsed(pane) {
			return main.classList.contains(pane + '-collapsed')
		}
		function isNarrow() {
			return window.matchMedia('(max-width: 768px)').matches
		}
		function applyWidth(pane, px) {
			const lim = LIMITS[pane]
			if (!lim) return
			px = Math.min(lim[1], Math.max(lim[0], Math.round(px)))
			main.style.setProperty('--pane-' + pane, px + 'px')
			return px
		}
		function saveWidths() {
			const cs = getComputedStyle(main)
			const o = {}
			for (const p of PANES) {
				if (isCollapsed(p)) continue
				const v = parseInt(cs.getPropertyValue('--pane-' + p), 10)
				if (!isNaN(v)) o[p] = v
			}
			localStorage.setItem(WIDTH_KEY, JSON.stringify(o))
		}
		function saveSidebarState() {
			const state = {}
			document.querySelectorAll('.sidebar .collapse').forEach(function (el) {
				state[el.parentElement.id || ''] = el.classList.contains('show')
			})
			localStorage.setItem('sidebarCollapsed', JSON.stringify(state))
		}
		function setCollapsed(pane, collapsed) {
			const sidebar = sidebarOf(pane)
			if (!sidebar) return
			const body = sidebar.querySelector('.collapse')
			const icon = sidebar.querySelector('.toggle-button i')
			main.classList.toggle(pane + '-collapsed', collapsed)
			//拖过宽度后 --pane-* 是内联的，优先级高于 .*-collapsed 规则，折叠时要先让位
			if (collapsed) {
				stashedWidth[pane] = main.style.getPropertyValue('--pane-' + pane)
				main.style.removeProperty('--pane-' + pane)
			} else if (stashedWidth[pane]) {
				main.style.setProperty('--pane-' + pane, stashedWidth[pane])
				stashedWidth[pane] = ''
			}
			if (body) body.classList.toggle('show', !collapsed)
			if (icon) {
				//箭头永远指向"点下去会往哪边动"
				const pointRight = pane === 'left' ? collapsed : !collapsed
				icon.classList.toggle('bi-chevron-compact-right', pointRight)
				icon.classList.toggle('bi-chevron-compact-left', !pointRight)
			}
			saveSidebarState()
		}

		document.querySelectorAll('.toggle-button[data-pane]').forEach(function (bar) {
			const pane = bar.dataset.pane === 'right' ? 'right' : 'left'
			if (!sidebarOf(pane)) return
			let dragging = false, moved = false, startX = 0, startW = 0

			bar.addEventListener('pointerdown', function (e) {
				//每次按下都重置，否则上一次拖拽的残留会吞掉这一次的 click
				moved = false
				//折叠态和窄屏只保留点击语义
				if (e.button !== 0 || isCollapsed(pane) || isNarrow()) return
				dragging = true
				startX = e.clientX
				startW = sidebarOf(pane).getBoundingClientRect().width
				bar.setPointerCapture(e.pointerId)
				main.classList.add('pane-dragging')
			})
			bar.addEventListener('pointermove', function (e) {
				if (!dragging) return
				const dx = e.clientX - startX
				if (Math.abs(dx) > DRAG_THRESHOLD) moved = true
				applyWidth(pane, pane === 'left' ? startW + dx : startW - dx)
			})
			function endDrag(e) {
				if (!dragging) return
				dragging = false
				main.classList.remove('pane-dragging')
				try { bar.releasePointerCapture(e.pointerId) } catch (err) {}
				if (moved) saveWidths()
			}
			bar.addEventListener('pointerup', endDrag)
			bar.addEventListener('pointercancel', endDrag)
			bar.addEventListener('click', function (e) {
				//拖拽结束时浏览器仍会补一个 click，这里吞掉
				if (moved) { moved = false; return }
				if (e.altKey && !isCollapsed(pane)) {
					applyWidth(pane, DEFAULTS[pane])
					saveWidths()
					return
				}
				setCollapsed(pane, !isCollapsed(pane))
			})
		})

		//恢复上次的宽度与折叠状态
		try {
			const w = JSON.parse(localStorage.getItem(WIDTH_KEY) || '{}')
			for (const p of PANES) {
				if (w[p]) applyWidth(p, w[p])
			}
		} catch (e) {}
		try {
			const state = JSON.parse(localStorage.getItem('sidebarCollapsed') || '{}')
			if (state['serial-tools'] === false) setCollapsed('right', true)
		} catch (e) {}
	})()

	// 协议解析面板：顶缝拖高度，header 只负责点击折叠(与串口发送一致)
	;(function () {
		const logMain = document.getElementById('log-main')
		const panel = document.getElementById('serial-parse-panel')
		const header = document.getElementById('serial-parse-header')
		const resizer = document.getElementById('serial-parse-resizer')
		if (!logMain || !panel || !header) return
		const STATE_KEY = 'parsePanelState'
		const DEFAULT_H = 220
		//面板最矮 120px；上限保证日志区不被压到 120px 以下(按 #log-main 实际高度动态算)
		const MIN_H = 120
		const MIN_LOG_H = 120

		function isNarrow() {
			return window.matchMedia('(max-width: 768px)').matches
		}
		function isCollapsed() {
			return panel.classList.contains('collapsed')
		}
		function maxHeight() {
			const logs = document.getElementById('serial-logs')
			const cur = panel.getBoundingClientRect().height
			const logH = logs ? logs.getBoundingClientRect().height : 0
			//面板+日志的总可用高度是固定的，面板多吃多少日志就少多少
			return Math.max(MIN_H, Math.round(cur + logH - MIN_LOG_H))
		}
		function applyHeight(px) {
			px = Math.min(maxHeight(), Math.max(MIN_H, Math.round(px)))
			logMain.style.setProperty('--parse-h', px + 'px')
			return px
		}
		function saveState() {
			const v = parseInt(logMain.style.getPropertyValue('--parse-h'), 10)
			localStorage.setItem(STATE_KEY, JSON.stringify({
				height: isNaN(v) ? DEFAULT_H : v,
				collapsed: isCollapsed()
			}))
		}
		function setCollapsed(collapsed) {
			panel.classList.toggle('collapsed', collapsed)
			const icon = header.querySelector('.serial-parse-chevron')
			if (icon) {
				icon.classList.toggle('bi-chevron-down', !collapsed)
				icon.classList.toggle('bi-chevron-right', collapsed)
			}
			saveState()
		}
		//供日志行点击调用:折叠态自动展开
		window.expandParsePanel = function () {
			if (isCollapsed()) setCollapsed(false)
		}

		// 顶缝拖高度
		if (resizer) {
			let dragging = false, startY = 0, startH = 0
			resizer.addEventListener('pointerdown', function (e) {
				if (e.button !== 0 || isCollapsed() || isNarrow()) return
				e.preventDefault()
				dragging = true
				startY = e.clientY
				startH = panel.getBoundingClientRect().height
				resizer.setPointerCapture(e.pointerId)
				logMain.classList.add('parse-dragging')
			})
			resizer.addEventListener('pointermove', function (e) {
				if (!dragging) return
				//往上拖(dy 为负)是把面板拉高
				applyHeight(startH - (e.clientY - startY))
			})
			function endDrag(e) {
				if (!dragging) return
				dragging = false
				logMain.classList.remove('parse-dragging')
				try { resizer.releasePointerCapture(e.pointerId) } catch (err) {}
				saveState()
			}
			resizer.addEventListener('pointerup', endDrag)
			resizer.addEventListener('pointercancel', endDrag)
		}

		// 标题栏只折叠
		header.addEventListener('click', function (e) {
			if (e.target.closest('button')) return
			setCollapsed(!isCollapsed())
		})

		const clearBtn = document.getElementById('serial-parse-clear')
		if (clearBtn) {
			clearBtn.addEventListener('click', function (e) {
				e.stopPropagation()
				document.getElementById('serial-protocol-output').innerHTML = ''
				if (typeof renderProtocolHexDump === 'function') renderProtocolHexDump(null)
			})
		}

		//恢复上次的高度与折叠状态；窄屏默认折叠
		let saved = {}
		try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') } catch (e) {}
		if (saved.height) applyHeight(saved.height)
		if (typeof saved.collapsed === 'boolean') {
			setCollapsed(saved.collapsed)
		} else {
			setCollapsed(isNarrow())
		}
	})()

	// 串口发送面板：点击标题栏折叠/展开（对齐协议解析面板）
	;(function () {
		const panel = document.getElementById('serial-send-panel')
		const header = document.getElementById('serial-send-header')
		if (!panel || !header) return
		const STATE_KEY = 'sendPanelState'

		function isCollapsed() {
			return panel.classList.contains('collapsed')
		}
		function saveState() {
			localStorage.setItem(STATE_KEY, JSON.stringify({ collapsed: isCollapsed() }))
		}
		function setCollapsed(collapsed) {
			panel.classList.toggle('collapsed', collapsed)
			const icon = header.querySelector('.serial-send-chevron')
			if (icon) {
				icon.classList.toggle('bi-chevron-down', !collapsed)
				icon.classList.toggle('bi-chevron-right', collapsed)
			}
			saveState()
		}
		window.expandSendPanel = function () {
			if (isCollapsed()) setCollapsed(false)
		}

		header.addEventListener('click', function () {
			setCollapsed(!isCollapsed())
		})

		let saved = {}
		try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') } catch (e) {}
		if (typeof saved.collapsed === 'boolean') {
			setCollapsed(saved.collapsed)
		}
	})()

	//设置名称（回车确认，Esc/取消关闭）
	const modalNewName = new bootstrap.Modal('#model-change-name')
	const modelChangeNameForm = document.getElementById('model-change-name-form')
	const modelNewNameInput = document.getElementById('model-new-name')
	let _changeNameCb = null
	function changeName(callback, oldName = '') {
		_changeNameCb = callback
		set('model-new-name', oldName)
		modalNewName.show()
	}
	function commitChangeName() {
		if (!_changeNameCb) return
		const cb = _changeNameCb
		_changeNameCb = null
		cb(get('model-new-name'))
		modalNewName.hide()
	}
	if (modelChangeNameForm) {
		modelChangeNameForm.addEventListener('submit', (e) => {
			e.preventDefault()
			commitChangeName()
		})
	}
	document.getElementById('model-change-name').addEventListener('shown.bs.modal', () => {
		if (!modelNewNameInput) return
		modelNewNameInput.focus()
		modelNewNameInput.select()
	})
	document.getElementById('model-change-name').addEventListener('hidden.bs.modal', () => {
		_changeNameCb = null
	})
})()
