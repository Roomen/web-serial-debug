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

	// 事务钉扎: 升级/批量配置等事务进行中锁定主发口, 防止中途切换把后续帧发到另一台设备
	let pinSid = null
	let pinDepth = 0
	// 日志全局单调序号: 同毫秒到达序 (ts, seq) 全序排序用
	let logSeq = 0
	// 单/双路切换串行化标志
	let modeSwitching = false

	// ===== SerialHub: 双路会话管理 =====
	// Session A 复用现有全局变量（保持单路模式等价）
	// Session B 独立存储
	let sessionB = {
		port: null,
		open: false,
		manualClose: true,
		opening: false,
		reader: null,
		wakeLock: null,
		packBuf: [],
		packStartTime: null,
		packTimer: null,
		sekWaitStart: null,
		label: 'RX',
	}
	const SerialHub = {
		mode: 'single',
		activeSendId: 'A',

		getPort(sid) { return sid === 'A' ? serialPort : sessionB.port },
		setPort(sid, port) { if (sid === 'A') serialPort = port; else sessionB.port = port },

		isOpen(sid) { return sid === 'A' ? serialOpen : sessionB.open },
		setOpen(sid, v) { if (sid === 'A') serialOpen = v; else sessionB.open = v },

		isManualClose(sid) { return sid === 'A' ? serialClose : sessionB.manualClose },
		setManualClose(sid, v) { if (sid === 'A') serialClose = v; else sessionB.manualClose = v },

		isOpening(sid) { return sid === 'A' ? serialOpening : sessionB.opening },
		setOpening(sid, v) { if (sid === 'A') serialOpening = v; else sessionB.opening = v },

		getReader(sid) { return sid === 'A' ? reader : sessionB.reader },
		setReader(sid, r) { if (sid === 'A') reader = r; else sessionB.reader = r },

		getWakeLock(sid) { return sid === 'A' ? wakeLockSentinel : sessionB.wakeLock },
		setWakeLock(sid, lk) { if (sid === 'A') wakeLockSentinel = lk; else sessionB.wakeLock = lk },

		getPackBuf(sid) { return sid === 'A' ? serialData : sessionB.packBuf },
		setPackBuf(sid, a) { if (sid === 'A') serialData = a; else sessionB.packBuf = a },

		getPackStartTime(sid) { return sid === 'A' ? serialDataStartTime : sessionB.packStartTime },
		setPackStartTime(sid, t) { if (sid === 'A') serialDataStartTime = t; else sessionB.packStartTime = t },

		getPackTimer(sid) { return sid === 'A' ? serialTimer : sessionB.packTimer },
		setPackTimer(sid, t) { if (sid === 'A') serialTimer = t; else sessionB.packTimer = t },

		getSekWaitStart(sid) { return sid === 'A' ? serialSekWaitStart : sessionB.sekWaitStart },
		setSekWaitStart(sid, t) { if (sid === 'A') serialSekWaitStart = t; else sessionB.sekWaitStart = t },

		getSessionLabel(sid) { return sid === 'A' ? this.getLabelA() : this.getLabelB() },
		getLabelA() {
			const el = document.getElementById('serial-session-a-label')
			return el ? el.value || 'TX' : 'TX'
		},
		getLabelB() {
			const el = document.getElementById('serial-session-b-label')
			return el ? el.value || 'RX' : 'RX'
		},

		activeSendSid() {
			if (pinSid) return pinSid
			return this.mode === 'single' ? 'A' : this.activeSendId
		},

		// 按 port 对象匹配会话（connect/disconnect 用）
		findSessionByPort(port) {
			if (!port) return null
			if (serialPort === port) return 'A'
			if (sessionB.port === port) return 'B'
			return null
		},

		// 找第一个未打开的会话（自动分配 connect 事件用）
		findClosedSession() {
			if (!serialOpen && !serialOpening) return 'A'
			if (SerialHub.mode === 'dual' && !sessionB.open && !sessionB.opening) return 'B'
			return null
		},

		// 日志容器：单路/双路共用 #serial-logs（分色 + 时间序插入）
		getLogContainer(sid) {
			return serialLogs
		},
	}

	// ===== 串口参数配置：单路/双路各自独立 =====
	// 单路沿用 localStorage 'serialOptions'（打开成功时写入，路径不变）；
	// 双路用独立键 'serialOptionsDual'，默认结构 = 单路默认结构，不从单路配置拷贝
	const SERIAL_OPTIONS_KEY = 'serialOptions'
	const SERIAL_OPTIONS_DUAL_KEY = 'serialOptionsDual'
	const DEFAULT_SERIAL_OPTIONS = {
		baudRate: 115200,
		dataBits: 8,
		stopBits: 1,
		parity: 'none',
		bufferSize: 1024,
		flowControl: 'none',
	}
	function readSerialOptions(key) {
		try {
			const raw = localStorage.getItem(key)
			if (raw) {
				const obj = JSON.parse(raw)
				if (obj && typeof obj === 'object') return Object.assign({}, DEFAULT_SERIAL_OPTIONS, obj)
			}
		} catch (e) {}
		return Object.assign({}, DEFAULT_SERIAL_OPTIONS)
	}
	// 双路独立配置（内存态；dropdown 变更 / 打开成功时同步到 serialOptionsDual）
	let SerialOptionsDual = readSerialOptions(SERIAL_OPTIONS_DUAL_KEY)
	// 参数摘要刷新函数（由下方 summary 组件初始化时注入，注入前为 null）
	let updateSerialParamsSummary = null
	// 从当前 dropdown 值收集串口参数
	function collectSerialParamsFromUI() {
		return {
			baudRate: parseInt(get('serial-baud')),
			dataBits: parseInt(get('serial-data-bits')),
			stopBits: parseInt(get('serial-stop-bits')),
			parity: get('serial-parity'),
			bufferSize: parseInt(get('serial-buffer-size')),
			flowControl: get('serial-flow-control'),
		}
	}
	// 按当前模式把对应配置刷进参数 dropdown（只设值不派发事件，避免触发重连）
	function applySerialParamsToUI() {
		const opts = SerialHub.mode === 'dual' ? SerialOptionsDual : readSerialOptions(SERIAL_OPTIONS_KEY)
		set('serial-baud', opts.baudRate)
		set('serial-data-bits', opts.dataBits)
		set('serial-stop-bits', opts.stopBits)
		set('serial-parity', opts.parity)
		set('serial-buffer-size', opts.bufferSize)
		set('serial-flow-control', opts.flowControl)
		if (updateSerialParamsSummary) updateSerialParamsSummary()
	}

	const SERIAL_WANT_OPEN_KEY = 'serialWantOpen'
	const SERIAL_WANT_OPEN_KEY_B = 'serialWantOpenB'
	function setSerialWantOpen(want, sid) {
		sid = sid || 'A'
		const key = sid === 'A' ? SERIAL_WANT_OPEN_KEY : SERIAL_WANT_OPEN_KEY_B
		try {
			if (want) sessionStorage.setItem(key, '1')
			else sessionStorage.removeItem(key)
		} catch (e) {}
	}
	function getSerialWantOpen(sid) {
		sid = sid || 'A'
		const key = sid === 'A' ? SERIAL_WANT_OPEN_KEY : SERIAL_WANT_OPEN_KEY_B
		try {
			return sessionStorage.getItem(key) === '1'
		} catch (e) {
			return false
		}
	}
	// 会话已开串口的设备身份 keys（reload 后按身份匹配，不再依赖 getPorts 位置）
	const SERIAL_WANT_PORT_KEY = 'serialWantPortKeyA'
	const SERIAL_WANT_PORT_KEY_B = 'serialWantPortKeyB'
	function setSerialWantPortKey(sid, keys) {
		sid = sid || 'A'
		const key = sid === 'A' ? SERIAL_WANT_PORT_KEY : SERIAL_WANT_PORT_KEY_B
		try {
			if (keys) sessionStorage.setItem(key, JSON.stringify(keys))
			else sessionStorage.removeItem(key)
		} catch (e) {}
	}
	function getSerialWantPortKey(sid) {
		sid = sid || 'A'
		const key = sid === 'A' ? SERIAL_WANT_PORT_KEY : SERIAL_WANT_PORT_KEY_B
		try {
			const raw = sessionStorage.getItem(key)
			if (!raw) return null
			const keys = JSON.parse(raw)
			return Array.isArray(keys) && keys.length ? keys : null
		} catch (e) {
			return null
		}
	}
	// reload 自动重连已整体移到本文件末尾的 reloadAutoReconnect IIFE：
	// 它要调 switchToDualUI，而 serialLogs 等 const 在后面才初始化，这里同步执行会踩 TDZ
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
	//当前合并包第一个字节到达的时间;日志显示用这个而不是flush时间,避免收发交错时时间戳乱序
	let serialDataStartTime = null
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
		localStorage.removeItem(SERIAL_OPTIONS_DUAL_KEY)
		localStorage.removeItem('toolOptions')
		localStorage.removeItem('quickSendList')
		location.reload()
	})
	//导出参数
	document.getElementById('serial-export').addEventListener('click', (e) => {
		let data = {
			serialOptions: localStorage.getItem('serialOptions'),
			serialOptionsDual: localStorage.getItem(SERIAL_OPTIONS_DUAL_KEY),
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
				setParam(SERIAL_OPTIONS_DUAL_KEY, obj.serialOptionsDual)
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
		// 左偏移列 + gap + N 个字节格; 列数取 16 的整数倍, 随宽度变化 16/32/48/64…
		const offW = 2.6 * fs + 8
		const cellW = 1.55 * fs + 2
		const n = Math.floor((avail - offW) / cellW)
		const cols = Math.max(16, Math.floor(n / 16) * 16)
		// 上限避免极宽屏一行过长难读
		return Math.min(cols, 64)
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
			const outEl = document.getElementById('serial-protocol-output')
			outEl.innerHTML = head + skFormatFrame(r)
			if (typeof skBindSeriesCharts === 'function') {
				try { skBindSeriesCharts(outEl) } catch (e) { /* ignore chart bind */ }
			}
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
				else addLogErr('剪贴板中未找到有效协议帧（请确认当前协议与帧格式匹配）')
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
				// 只选字节格, 不选左侧地址列/表头
				const byteSpans = protocolHexView.querySelectorAll('.sk-hex-byte')
				if (!byteSpans.length) return
				const sel = window.getSelection()
				sel.removeAllRanges()
				// 多 range 兼容性差: 选中整块 .sk-hex-bytes 容器串, 偏移列已 user-select:none
				const rows = protocolHexView.querySelectorAll('.sk-hex-dump-row .sk-hex-bytes')
				if (rows.length === 1) {
					const range = document.createRange()
					range.selectNodeContents(rows[0])
					sel.addRange(range)
				} else if (rows.length > 1) {
					const range = document.createRange()
					range.setStart(rows[0], 0)
					range.setEndAfter(rows[rows.length - 1].lastChild || rows[rows.length - 1])
					sel.addRange(range)
				}
			}
		})
		// 复制时去掉可能夹带的地址/空白, 仅输出 HEX 字节
		protocolHexView.addEventListener('copy', (e) => {
			const sel = window.getSelection()
			if (!sel || sel.isCollapsed) return
			const text = sel.toString()
			// 已是纯 HEX(含空格/换行)时清洗: 去掉像 0000/0010 的偏移伪影
			const cleaned = text
				.replace(/(^|\s)[0-9A-Fa-f]{4}(?=\s|$)/g, ' ')
				.replace(/[^0-9A-Fa-f\s]/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
			if (!cleaned) return
			// 仅当清洗改变内容或含偏移样模式时改写剪贴板
			if (cleaned !== text.replace(/\s+/g, ' ').trim() || /(?:^|\s)[0-9A-Fa-f]{4}(?:\s|$)/.test(text)) {
				e.preventDefault()
				const hexOnly = cleaned.replace(/\s+/g, ' ')
				try {
					e.clipboardData.setData('text/plain', hexOnly)
				} catch (err) { /* */ }
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
		if (!matchingGroups.length) {
			const ph = document.createElement('option')
			ph.value = ''
			ph.textContent = '无可用指令'
			presetSel.appendChild(ph)
		}
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
			if (presetSel.value) presetSel.dispatchEvent(new Event('change'))
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
		const n = Math.max(1, Math.min(60, count | 0))
		return [toBcdByte(yy), toBcdByte(d.getMonth() + 1), toBcdByte(d.getDate()), n & 0xff]
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
	// Tag10-ID5 历史数据：YYYYMMDDhhmmss 7B BCD(高位在前) 当日 00:00:00
	function histDateQueryBytes(isoDate) {
		const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
		if (!m) return null
		const y = parseInt(m[1], 10)
		const mo = parseInt(m[2], 10)
		const day = parseInt(m[3], 10)
		if (mo < 1 || mo > 12 || day < 1 || day > 31) return null
		// 用 Date 再校验非法日(如 2/30)
		const chk = new Date(y, mo - 1, day)
		if (chk.getFullYear() !== y || chk.getMonth() !== mo - 1 || chk.getDate() !== day) return null
		return [
			toBcdByte(Math.floor(y / 100)),
			toBcdByte(y % 100),
			toBcdByte(mo),
			toBcdByte(day),
			0x00, 0x00, 0x00
		]
	}
	function histDateBounds(maxDays) {
		const max = Math.max(1, Math.min(60, maxDays || 60))
		const pad = function (n) { return String(n).padStart(2, '0') }
		const fmt = function (d) {
			return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
		}
		const today = new Date()
		const minD = new Date(today.getFullYear(), today.getMonth(), today.getDate() - max)
		const yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
		return { min: fmt(minD), max: fmt(today), default: fmt(yest) }
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
				} else if (preset.param.type === 'histDate') {
					const iso = paramVal.value.trim()
					if (!iso) return
					bytes = histDateQueryBytes(iso)
					if (!bytes) return
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
					paramVal.type = 'text'
					paramSelEnum.style.display = ''
					paramSelEnum.innerHTML = ''
					const opts = preset.param.options || {}
					const def = preset.param.default || Object.keys(opts)[0] || '0'
					for (const [k, v] of Object.entries(opts)) {
						const op = document.createElement('option')
						op.value = k
						// 文案优先展示中文说明，值仍用数字 key
						op.textContent = v ? (String(v)) : String(k)
						if (String(k) === String(def)) op.selected = true
						paramSelEnum.appendChild(op)
					}
					paramUnit.textContent = ''
					_currentParamType = 'uint8'
				} else if (preset.param.type === 'ascii') {
					paramVal.type = 'text'
					paramVal.style.display = ''
					paramVal.style.width = '180px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default || ''
					paramVal.placeholder = preset.param.placeholder || '值'
					paramUnit.textContent = ''
					_currentParamType = 'ascii'
				} else if (preset.param.type === 'bcd') {
					paramVal.type = 'text'
					paramVal.style.display = ''
					paramVal.style.width = '180px'
					paramSelEnum.style.display = 'none'
					paramVal.value = preset.param.default || ''
					paramUnit.textContent = '(BCD LE)'
					_currentParamType = 'bcd'
				} else if (preset.param.type === 'dailyQuery') {
					paramVal.type = 'number'
					paramVal.style.display = ''
					paramVal.style.width = '80px'
					paramSelEnum.style.display = 'none'
					paramVal.min = '1'
					paramVal.max = String(preset.param.max || 60)
					paramVal.value = preset.param.default || '30'
					paramUnit.textContent = '天(日起=今天,≤60)'
					_currentParamType = 'dailyQuery'
				} else if (preset.param.type === 'errLogQuery') {
					paramVal.type = 'number'
					paramVal.style.display = ''
					paramVal.style.width = '80px'
					paramSelEnum.style.display = 'none'
					paramVal.removeAttribute('min')
					paramVal.removeAttribute('max')
					paramVal.value = preset.param.default || '4'
					paramUnit.textContent = '条(起点=现在)'
					_currentParamType = 'errLogQuery'
				} else if (preset.param.type === 'histDate') {
					const b = histDateBounds(preset.param.maxDays || 60)
					paramVal.type = 'date'
					paramVal.style.display = ''
					paramVal.style.width = '150px'
					paramSelEnum.style.display = 'none'
					paramVal.min = b.min
					paramVal.max = b.max
					paramVal.value = preset.param.default || b.default
					paramUnit.textContent = '近' + (preset.param.maxDays || 60) + '日可选'
					_currentParamType = 'histDate'
				} else {
					paramVal.type = 'text'
					paramVal.style.display = ''
					paramVal.style.width = '100px'
					paramSelEnum.style.display = 'none'
					paramVal.removeAttribute('min')
					paramVal.removeAttribute('max')
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
		if (presetSel.value) presetSel.dispatchEvent(new Event('change'))
	}
	//读取参数：单路/双路各自独立的串口参数，按当前模式刷新 dropdown
	applySerialParamsToUI()
	let options = localStorage.getItem('toolOptions')
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
		trimLogRows(SerialHub.getLogContainer('A'))
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
			const isAnsi = String(val).includes('ansi')
			const logsEl = document.getElementById('serial-logs')
			if (logsEl) logsEl.classList.toggle('ansi', isAnsi)
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
			// 双路：变更写入独立配置并持久化，不污染单路 serialOptions
			if (SerialHub.mode === 'dual') {
				SerialOptionsDual = collectSerialParamsFromUI()
				localStorage.setItem(SERIAL_OPTIONS_DUAL_KEY, JSON.stringify(SerialOptionsDual))
			}
			// 当任一会话打开时，关闭再重新打开以应用新参数
			const aOpen = SerialHub.isOpen('A') && !SerialHub.isOpening('A')
			const bOpen = SerialHub.mode === 'dual' && SerialHub.isOpen('B') && !SerialHub.isOpening('B')
			if (!aOpen && !bOpen) return
			//未找到API可以动态修改串口参数,先关闭再重新打开
			if (aOpen) {
				SerialHub.setOpening('A', true)
				try {
					await closeSerial('A')
					await new Promise((resolve) => setTimeout(resolve, 100))
					await openSerial('A')
				} finally {
					SerialHub.setOpening('A', false)
				}
			}
			if (bOpen) {
				SerialHub.setOpening('B', true)
				try {
					await closeSerial('B')
					await new Promise((resolve) => setTimeout(resolve, 100))
					await openSerial('B')
				} finally {
					SerialHub.setOpening('B', false)
				}
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

	//日志纯文本(复制/导出用): 单容器即含双路
	function getLogsText() {
		const container = SerialHub.getLogContainer('A')
		let lines = []
		if (!container) return ''
		for (const node of container.children) {
			if (node.classList.contains('log-row')) {
				const time = node.querySelector('.log-time')
				const dir = node.querySelector('.log-dir')
				const sess = node.querySelector('.log-sess')
				const len = node.querySelector('.log-len')
				const body = node.querySelector('.log-body')
				let head = []
				if (time && time.innerText) head.push(time.innerText)
				if (dir && dir.innerText) head.push(dir.innerText)
				if (sess && sess.innerText) head.push(sess.innerText)
				if (len && len.innerText) head.push(len.innerText)
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
		const container = SerialHub.getLogContainer('A')
		if (container) container.innerHTML = ''
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

	//选择串口（单路模式用）
	document.getElementById('serial-select-port').addEventListener('click', async () => {
		await selectPortFor('A')
	})

	async function selectPortFor(sid) {
		try {
		await navigator.serial.requestPort().then(async (port) => {
				if (isBluetoothSerialPort(port)) {
					addLogErr('不支持蓝牙串口，请选择 USB 串口')
					return
				}
				await closeSerial(sid)
				SerialHub.setPort(sid, port)
				// 多 CDC 槽位依赖 getPorts 全集：清缓存后重算
				_portIdentityCache.clear()
				const key = await getPortIdentityKey(port)
				// 另一会话口也要刷新 slot
				const other = sid === 'A' ? SerialHub.getPort('B') : SerialHub.getPort('A')
				if (other) await getPortIdentityKey(other)
				if (!key) {
					addLogErr(`无法获取设备标识（非 USB 串口），重命名仅本次会话有效`)
				} else if (key.fingerprint && key.fingerprint.siblingCount > 1) {
					addLogErr('检测到同型号多串口(CDC)，别名按授权顺序槽位记忆；重插后顺序变化时请重命名')
				}
				refreshPortDisplayNames()
				addLogErr(`串口已选择 (会话 ${sid}${key ? '' : '，无持久标识'})`)
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
	}

	//屏幕唤醒锁：息屏后系统会挂起 USB 导致设备掉线，长时间挂测必须按住
	let wakeLockSentinel = null
	async function requestWakeLock(sid) {
		sid = sid || 'A'
		try {
			const current = SerialHub.getWakeLock(sid)
			if (navigator.wakeLock && !current) {
				const lk = await navigator.wakeLock.request('screen')
				lk.addEventListener('release', function () {
					if (SerialHub.getWakeLock(sid) === lk) SerialHub.setWakeLock(sid, null)
				})
				SerialHub.setWakeLock(sid, lk)
			}
		} catch (e) {}
	}
	async function releaseWakeLock(sid) {
		sid = sid || 'A'
		const lk = SerialHub.getWakeLock(sid)
		if (lk) {
			try { await lk.release() } catch (e) {}
			SerialHub.setWakeLock(sid, null)
		}
	}
	//切到后台会被系统自动释放，切回来要重新申请，否则挂久了锁其实早没了
	document.addEventListener('visibilitychange', function () {
		if (document.visibilityState === 'visible') {
			if (SerialHub.isOpen('A')) requestWakeLock('A')
			if (SerialHub.isOpen('B')) requestWakeLock('B')
		}
	})

	//释放串口底层资源: 取消并释放 reader、close port(另一会话占用同一 port 对象则跳过)、清分包缓冲/定时器
	//所有释放路径(手动关闭/读流死/打开前清理/页面销毁)统一走这里, 避免 OS 句柄泄漏导致下次 open 报 NetworkError
	async function releasePort(sid) {
		sid = sid || 'A'
		const port = SerialHub.getPort(sid)
		const r = SerialHub.getReader(sid)
		SerialHub.setReader(sid, null)
		// 清理该会话的分包缓冲与合并时钟：关闭后旧口残包不得迟到入日志或与新口数据合并
		clearTimeout(SerialHub.getPackTimer(sid))
		SerialHub.setPackTimer(sid, null)
		SerialHub.setPackBuf(sid, [])
		SerialHub.setPackStartTime(sid, null)
		SerialHub.setSekWaitStart(sid, null)
		if (r) {
			try { await r.cancel() } catch (e) {}
			try { r.releaseLock() } catch (e) {}
		}
		if (port) {
			// 同一 port 对象可能被另一会话持有（如两会话选了同一设备），
			// 跳过 close 以免关掉对方会话正在用的连接
			const otherSid = sid === 'A' ? 'B' : 'A'
			const otherPort = SerialHub.getPort(otherSid)
			if (!(otherPort === port && SerialHub.isOpen(otherSid))) {
				try { await port.close() } catch (e) {}
			}
		}
	}

	//页面销毁时释放串口句柄(关键修复: 上一 document 仍握着 OS 句柄时, 刷新后立刻 open 必报 NetworkError)
	//先把 A/B 置未打开再 release: 同 port 双路时两边的"对方仍 open"保护才不会再跳过 close
	//fire-and-forget, 不 await 完整关闭链; 不清 wantOpen, 刷新后仍按意图自动重连
	function releasePortOnExit() {
		SerialHub.setOpen('A', false)
		SerialHub.setOpen('B', false)
		releasePort('A')
		releasePort('B')
	}
	window.addEventListener('pagehide', releasePortOnExit)
	window.addEventListener('beforeunload', releasePortOnExit)

	//bfcache 返回: pagehide 已把底层口释放, 状态/按钮与真实口状态对齐, 再按打开意图补重连
	window.addEventListener('pageshow', function (e) {
		if (!e.persisted) return
		serialStatuChange(false, 'A')
		serialStatuChange(false, 'B')
		updateOpenButton('A')
		updateOpenButton('B')
		//普通刷新的 pageshow 不再开(reloadAutoReconnect 负责); 仅 bfcache 恢复时按意图补开
		function reopenIfWanted(sid) {
			if (sid === 'B' && SerialHub.mode !== 'dual') return
			if (!getSerialWantOpen(sid) || SerialHub.isManualClose(sid)) return
			if (!SerialHub.getPort(sid) || SerialHub.isOpening(sid)) return
			SerialHub.setOpening(sid, true)
			openSerial(sid, { reason: 'reload' }).finally(function () {
				SerialHub.setOpening(sid, false)
			})
		}
		reopenIfWanted('A')
		reopenIfWanted('B')
	})

	//关闭串口(无论 serialOpen 标志如何都尽量释放 reader/port，避免锁泄漏导致再次打开失败)
	async function closeSerial(sid) {
		sid = sid || 'A'
		// 先置未打开再释放: readData 被 cancel 的异常不会当成断线噪声
		SerialHub.setOpen(sid, false)
		await releasePort(sid)
		releaseWakeLock(sid)
		//仅手动关闭时清掉"想打开"标记；异常断开保留，刷新后仍可重连
		if (SerialHub.isManualClose(sid)) {
			setSerialWantOpen(false, sid)
			setSerialWantPortKey(sid, null)
		}
		serialStatuChange(false, sid)
		updateOpenButton(sid)
	}

	//打开串口
	//opts.reason: 'user'(默认, 失败弹简短提示) | 'reload'(刷新自动重连) | 'hotplug'(设备重插自动重连), 后两者失败只打日志不弹窗
	//NetworkError/InvalidStateError 是占用/未释放/已拔出类瞬时错误, 按 200/400/800ms 退避重试(1 次首次 + 最多 3 次重试)
	const OPEN_RETRY_ERRORS = ['NetworkError', 'InvalidStateError']
	const OPEN_RETRY_DELAYS = [200, 400, 800]
	//文案不把 NetworkError 说成"网络错误": Web Serial 里它表示设备被占用/已拔出/句柄未释放
	const SERIAL_OPEN_FAIL_MSG = '无法打开串口：设备可能已被占用、已拔出，或上一页尚未释放。请稍后重试或重新插拔设备。'
	async function openSerial(sid, opts) {
		sid = sid || 'A'
		opts = opts || {}
		const reason = opts.reason || 'user'
		const port = SerialHub.getPort(sid)
		if (SerialHub.isOpen(sid)) return
		if (!port) return
		if (isBluetoothSerialPort(port)) {
			addLogErr(`不支持蓝牙串口，请选择 USB 串口`)
			return
		}
		let SerialOptions
		if (SerialHub.mode === 'dual') {
			// 双路：A/B 统一使用独立的双路配置
			SerialOptions = Object.assign({}, SerialOptionsDual)
		} else {
			SerialOptions = collectSerialParamsFromUI()
		}
		//打开前先释放本会话残留句柄(读流死/异常断开的脏状态), 忽略 close 失败
		await releasePort(sid)
		serialStatuChange('connecting', sid)
		let openError = null
		try {
			//端口可能处于"已打开但本地状态丢失"的脏状态: releasePort 已尽量 close; 占用类错误退避重试
			for (let attempt = 0; ; attempt++) {
				try {
					await port.open(SerialOptions)
					openError = null
					break
				} catch (e) {
					openError = e
					const retryable = OPEN_RETRY_ERRORS.indexOf(e.name || '') !== -1
					if (!retryable || attempt >= OPEN_RETRY_DELAYS.length) throw e
					await new Promise(function (resolve) { setTimeout(resolve, OPEN_RETRY_DELAYS[attempt]) })
				}
			}
		} catch (e) {
			openError = e
		}
		if (openError) {
			const errorType = openError.name || 'UnknownError'
			const errorMsg = openError.message || '未知错误'
			SerialHub.setOpen(sid, false)
			serialStatuChange(false, sid)
			updateOpenButton(sid)

			addLogErr(`打开串口失败(${sid}): ${errorType} - ${errorMsg}`)

			if (errorType === 'SecurityError') {
				addLogErr('权限错误：请检查浏览器串口权限设置')
			} else if (errorType === 'InvalidStateError') {
				addLogErr('串口状态错误：设备可能已被占用')
			} else if (errorType === 'NetworkError') {
				addLogErr(SERIAL_OPEN_FAIL_MSG)
			}

			//自动重连(刷新/重插)失败禁止弹窗只打日志; 手动打开失败给简短友好提示, 不甩原始错误
			if (reason === 'user') {
				showMsg(SERIAL_OPEN_FAIL_MSG)
			}
			return
		}
		SerialHub.setOpen(sid, true)
		SerialHub.setManualClose(sid, false)
		updateOpenButton(sid)
		// 新连接: 清空 SEK 会话基准水量, 避免串到上一块表
		if (sid === 'A' && window.skSession) {
			try {
				window.skSession.resetBase()
				window.skSession.deviceUid = null
			} catch (e) { /* */ }
		}
		setSerialWantOpen(true, sid)
		// 记录设备身份 keys，reload 后按身份匹配恢复（不依赖 getPorts 顺序）
		getPortIdentityKey(port).then(function (ident) {
			if (!ident) return
			setSerialWantPortKey(sid, ident.keys)
		})
		serialStatuChange(true, sid)
		localStorage.setItem(SerialHub.mode === 'dual' ? SERIAL_OPTIONS_DUAL_KEY : SERIAL_OPTIONS_KEY, JSON.stringify(SerialOptions))
		requestWakeLock(sid)
		readData(sid)
	}

	// 更新打开/关闭按钮文案
	// sid=B 永远写双路 B 按钮，避免 switchToSingle 竞态下误写单路主按钮
	function updateOpenButton(sid) {
		sid = sid || 'A'
		const open = SerialHub.isOpen(sid)
		let btnId
		let dualLabel = false
		if (sid === 'B') {
			btnId = 'serial-open-or-close-b'
			dualLabel = true
		} else if (SerialHub.mode === 'dual') {
			btnId = 'serial-open-or-close-a'
			dualLabel = true
		} else {
			btnId = 'serial-open-or-close'
		}
		const btn = document.getElementById(btnId)
		if (!btn) return
		if (open) {
			btn.innerHTML = '<i class="bi bi-stop-circle"></i> 关闭' + (dualLabel ? ' ' + sid : '')
		} else {
			btn.innerHTML = '<i class="bi bi-play-circle"></i> 打开' + (dualLabel ? ' ' + sid : '')
		}
	}

	//打开或关闭串口（单路：仅 A；双路：按按钮 id 区分）
	async function handleToggleClick(sid) {
		sid = sid || 'A'
		if (SerialHub.isOpening(sid)) return
		const port = SerialHub.getPort(sid)
		if (!port) {
			showMsg('请先选择串口')
			return
		}
		if (SerialHub.isOpen(sid)) {
			SerialHub.setManualClose(sid, true)
			SerialHub.setOpening(sid, true)
			try {
				await closeSerial(sid)
			} finally {
				SerialHub.setOpening(sid, false)
			}
			return
		}
		// 双路模式下检查端口冲突
		if (SerialHub.mode === 'dual') {
			const otherSid = sid === 'A' ? 'B' : 'A'
			const otherPort = SerialHub.getPort(otherSid)
			if (otherPort && otherPort === port) {
				addLogErr(`会话 ${sid} 与 ${otherSid} 选择了同一串口，请为两路选择不同设备`)
				return
			}
		}
		SerialHub.setOpening(sid, true)
		SerialHub.setManualClose(sid, false)
		try {
			await openSerial(sid)
		} finally {
			SerialHub.setOpening(sid, false)
		}
	}

	serialToggle.addEventListener('click', async () => {
		await handleToggleClick('A')
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

	// ===== 串口设备别名 v2（多键指纹 / localStorage entries / 蓝牙过滤） =====
	// port → 解析后的 { keys, fingerprint } 缓存（port 对象引用做 Map key）
	const _portIdentityCache = new Map()
	// port → 内存别名（无任何持久 key 时仅本次会话有效）
	const _sessionAliasByPort = new Map()
	const ALIAS_STORE_KEY = 'serialPortAliases'

	function normalizeLabel(s) {
		return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
	}

	/** 从字符串中提取 path token（macOS cu./tty.、Windows COM，大小写不敏感；统一小写便于匹配） */
	function extractPathTokens(text) {
		const out = []
		const re = /(?:cu\.|tty\.)[\w.-]+|\bCOM\d+\b/gi
		let m
		while ((m = re.exec(String(text || ''))) !== null) {
			out.push(m[0].toLowerCase())
		}
		return out
	}

	/** 蓝牙串口检测（Bluetooth Serial / RFCOMM） */
	function isBluetoothSerialPort(port) {
		try {
			const info = port && port.getInfo ? port.getInfo() : {}
			if (info.bluetoothServiceClassId != null && info.bluetoothServiceClassId !== '') return true
			// 无 USB VID/PID 且存在 bluetooth 相关字段
			if (info.usbVendorId == null && info.usbProductId == null) {
				const s = JSON.stringify(info).toLowerCase()
				if (s.indexOf('bluetooth') !== -1 || s.indexOf('rfcomm') !== -1) return true
			}
		} catch (e) {}
		return false
	}

	function randAliasId() {
		return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
	}

	/** 旧 v1 map（{ [key]: name }）→ v2 entries 迁移 + 消毒 */
	function normalizeAliasStore(raw) {
		if (raw && raw.version === 2 && Array.isArray(raw.entries)) {
			return {
				version: 2,
				entries: raw.entries.filter(function (e) {
					return e && typeof e.alias === 'string' && e.alias.trim() && Array.isArray(e.keys) && e.keys.length
				}).map(function (e) {
					return {
						id: e.id || randAliasId(),
						alias: e.alias.trim().slice(0, 32),
						keys: e.keys.filter(function (k) { return typeof k === 'string' && k }),
						fingerprint: e.fingerprint || {},
						updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
					}
				}),
			}
		}
		const entries = []
		if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
			for (const k in raw) {
				const v = raw[k]
				if (typeof v === 'string' && v.trim() && k.indexOf(':') !== -1) {
					entries.push({ id: randAliasId(), alias: v.trim().slice(0, 32), keys: [k], fingerprint: {}, updatedAt: 0 })
				}
			}
		}
		return { version: 2, entries }
	}

	function loadAliases() {
		try {
			const raw = localStorage.getItem(ALIAS_STORE_KEY)
			if (raw == null) return { version: 2, entries: [] }
			const parsed = JSON.parse(raw)
			const store = normalizeAliasStore(parsed)
			// 旧 v1 map 首次加载后立即回写为 v2
			if (!(parsed && parsed.version === 2)) saveAliases(store)
			return store
		} catch (e) { return { version: 2, entries: [] } }
	}
	function saveAliases(store) {
		try { localStorage.setItem(ALIAS_STORE_KEY, JSON.stringify(store)) } catch (e) {}
	}

	/** 从 port.getInfo() 扫全部自有属性构建指纹（同步部分） */
	function buildPortFingerprint(port) {
		const fp = { vid: null, pid: null, sn: null, productName: null, manufacturerName: null, path: null, labels: [] }
		let info = {}
		try {
			info = port && port.getInfo ? port.getInfo() : {}
		} catch (e) {}
		if (info.usbVendorId != null) fp.vid = info.usbVendorId.toString(16).padStart(4, '0')
		if (info.usbProductId != null) fp.pid = info.usbProductId.toString(16).padStart(4, '0')
		for (const k in info) {
			const v = info[k]
			if (typeof v !== 'string' || !v.trim()) continue
			const t = v.trim()
			fp.labels.push(t)
			const lk = k.toLowerCase()
			if (!fp.sn && lk.indexOf('serial') !== -1) fp.sn = t
			else if (!fp.path && lk.indexOf('path') !== -1) {
				const toks = extractPathTokens(t)
				if (toks.length) fp.path = toks[0]
			}
		}
		// 从全部字符串字段里兜底提取 path token
		if (!fp.path) {
			const toks = extractPathTokens(fp.labels.join(' '))
			if (toks.length) fp.path = toks[0]
		}
		return fp
	}

	/** 生成匹配 keys；多 CDC 必须带 slot，禁止仅靠弱键互串 */
	function buildPortKeys(fp) {
		const keys = new Set()
		const n = normalizeLabel
		const slot = (fp.slot != null && fp.slot >= 0) ? fp.slot : null
		if (fp.vid && fp.pid && slot != null) {
			keys.add('usb:' + fp.vid + ':' + fp.pid + ':slot:' + slot)
			if (fp.sn) keys.add('usb:' + fp.vid + ':' + fp.pid + ':sn:' + fp.sn + ':slot:' + slot)
		}
		if (fp.vid && fp.pid && fp.sn && slot == null) keys.add('usb:' + fp.vid + ':' + fp.pid + ':sn:' + fp.sn)
		if (fp.path) keys.add('path:' + String(fp.path).toLowerCase())
		if (fp.productName && fp.path) keys.add('label:' + n(fp.productName + ' (' + fp.path + ')'))
		// 弱键仅在「单口」时用于持久；多 slot 时不写弱键，避免 4 CDC 合并成一名
		if (slot == null || fp.siblingCount === 1) {
			if (fp.productName) keys.add('prod:' + n(fp.productName))
			if (fp.vid && fp.pid && fp.productName) keys.add('usb:' + fp.vid + ':' + fp.pid + ':prod:' + n(fp.productName))
			if (fp.vid && fp.pid) keys.add('usb:' + fp.vid + ':' + fp.pid)
		}
		const labels = fp.labels || []
		for (let i = 0; i < labels.length; i++) {
			const lab = n(labels[i])
			if (lab && (slot == null || fp.siblingCount === 1)) keys.add('label:' + lab)
		}
		return Array.from(keys)
	}

	function keyScore(key) {
		if (key.indexOf('path:') === 0) return 100
		if (key.indexOf(':slot:') !== -1) return 95
		if (key.indexOf(':sn:') !== -1) return 80
		if (key.indexOf('label:') === 0) return 60
		if (key.indexOf('prod:') === 0 || key.indexOf(':prod:') !== -1) return 40
		return 10
	}

	/** 解析端口身份（异步：WebUSB 按 VID/PID 增强 productName/SN/manufacturerName 后缓存；蓝牙口直接跳过） */
	async function resolvePortIdentity(port) {
		if (!port) return { keys: [], fingerprint: {} }
		if (_portIdentityCache.has(port)) return _portIdentityCache.get(port)
		if (isBluetoothSerialPort(port)) {
			const empty = { keys: [], fingerprint: buildPortFingerprint(port) }
			_portIdentityCache.set(port, empty)
			return empty
		}
		let fp = buildPortFingerprint(port)
		// WebUSB：仅当同 VID/PID 恰好 1 台已授权设备时取 SN，避免多设备错绑
		if (navigator.usb && navigator.usb.getDevices) {
			try {
				const devices = await navigator.usb.getDevices()
				const matches = []
				for (let i = 0; i < devices.length; i++) {
					const d = devices[i]
					if (fp.vid && fp.pid && d.vendorId === parseInt(fp.vid, 16) && d.productId === parseInt(fp.pid, 16)) {
						matches.push(d)
					}
				}
				if (matches.length === 1) {
					const d = matches[0]
					if (!fp.sn && d.serialNumber) fp.sn = String(d.serialNumber).trim()
					if (!fp.productName && d.productName) fp.productName = String(d.productName).trim()
					if (!fp.manufacturerName && d.manufacturerName) fp.manufacturerName = String(d.manufacturerName).trim()
					if (fp.productName) fp.labels.push(fp.productName)
				} else if (matches.length > 1) {
					const names = {}
					for (let i = 0; i < matches.length; i++) {
						const pn = matches[i].productName ? String(matches[i].productName).trim() : ''
						if (pn) names[pn] = (names[pn] || 0) + 1
					}
					const uniq = Object.keys(names)
					if (uniq.length === 1 && !fp.productName) {
						fp.productName = uniq[0]
						fp.labels.push(uniq[0])
					}
				}
			} catch (e) {}
		}
		// 同 VID/PID 多 CDC：按 getPorts() 顺序赋 slot（四口复合设备命名互不串）
		fp.slot = null
		fp.siblingCount = 1
		if (fp.vid && fp.pid && navigator.serial && navigator.serial.getPorts) {
			try {
				const all = await navigator.serial.getPorts()
				const siblings = []
				for (let i = 0; i < all.length; i++) {
					const p = all[i]
					if (isBluetoothSerialPort(p)) continue
					const ofp = buildPortFingerprint(p)
					if (ofp.vid === fp.vid && ofp.pid === fp.pid) siblings.push(p)
				}
				fp.siblingCount = siblings.length || 1
				if (siblings.length > 1) {
					let slot = siblings.indexOf(port)
					if (slot < 0) {
						// 引用比较失败时按顺序扫
						for (let i = 0; i < siblings.length; i++) {
							if (siblings[i] === port) { slot = i; break }
						}
					}
					if (slot >= 0) fp.slot = slot
				}
			} catch (e) {}
		}
		const ident = { keys: buildPortKeys(fp), fingerprint: fp }
		_portIdentityCache.set(port, ident)
		return ident
	}

	/** 同步兜底身份（缓存未就绪时，不含 WebUSB 增强） */
	function syncPortIdentity(port) {
		const fp = buildPortFingerprint(port)
		return { keys: buildPortKeys(fp), fingerprint: fp }
	}

	/** 兼容旧调用点：解析并返回身份（无持久 key 时为 null） */
	async function getPortIdentityKey(port) {
		const ident = await resolvePortIdentity(port)
		return ident && ident.keys.length ? ident : null
	}

	/** 按交集键打分取最高分；弱键-only 且多条同分 → 歧义不套用（防四 CDC 同名） */
	function lookupAlias(portKeys) {
		const entries = loadAliases().entries
		let best = null
		let bestCount = 0
		for (const entry of entries) {
			if (!entry || !entry.alias || !Array.isArray(entry.keys)) continue
			let score = 0
			for (const k of entry.keys) {
				if (portKeys.indexOf(k) !== -1 && keyScore(k) > score) score = keyScore(k)
			}
			if (score <= 0) continue
			if (!best || score > best.score) {
				best = { alias: entry.alias, score: score }
				bestCount = 1
			} else if (score === best.score) {
				bestCount++
			}
		}
		// 仅弱键命中且多条并列：不套用
		if (best && best.score <= 10 && bestCount > 1) return null
		// 当前口是多 CDC 槽位：必须命中 slot/path，禁止用旧弱键套到所有口
		const needsSlot = portKeys.some(function (k) { return k.indexOf(':slot:') !== -1 })
		if (best && needsSlot && best.score < 90) return null
		return best
	}

	function isUniquePortKey(k) {
		return k.indexOf('path:') === 0 || k.indexOf(':slot:') !== -1
	}

	/** entry 删除/清理：必须共享 path 或 slot；弱键全覆盖仅用于清理旧 v1 弱键 entry */
	function entryMatchesKeys(entry, portKeys) {
		for (const k of entry.keys) {
			if (portKeys.indexOf(k) !== -1 && isUniquePortKey(k)) return true
		}
		// 旧 v1 弱键 entry：keys 全是弱键且被当前 port 键覆盖
		const onlyWeak = entry.keys.every(function (k) { return keyScore(k) <= 40 })
		if (onlyWeak) return entry.keys.every(function (k) { return portKeys.indexOf(k) !== -1 })
		return false
	}

	/** 合并：仅 path/slot 共享才算同一物理口；禁止 prod/label/vidpid 合并（四 CDC） */
	function entryIsSameDevice(entry, portKeys) {
		for (const k of entry.keys) {
			if (portKeys.indexOf(k) !== -1 && isUniquePortKey(k)) return true
		}
		return false
	}

	/** 无别名时的默认显示名；多 CDC 时追加 #n */
	function defaultPortDisplayName(fp) {
		fp = fp || {}
		const p = fp.productName
		let base
		if (p && fp.path) base = p + ' (' + fp.path + ')'
		else if (p && fp.vid && fp.pid) base = p + ' · 0x' + fp.vid + ':0x' + fp.pid
		else if (p) base = p
		else if (fp.path) base = fp.path
		else base = 'Vendor: ' + (fp.vid ? '0x' + fp.vid : '未知') + ', Product: ' + (fp.pid ? '0x' + fp.pid : '未知')
		if (fp.siblingCount > 1 && fp.slot != null && fp.slot >= 0) {
			base += ' #' + (fp.slot + 1)
		}
		return base
	}

	/** 获取端口显示名（同步：持久别名 → 会话内存别名 → 默认显示名） */
	function getPortDisplayName(port) {
		if (!port) return '未知设备'
		const ident = _portIdentityCache.has(port) ? _portIdentityCache.get(port) : syncPortIdentity(port)
		if (ident.keys.length) {
			const hit = lookupAlias(ident.keys)
			if (hit) return hit.alias
		}
		const mem = _sessionAliasByPort.get(port)
		if (mem) return mem
		return defaultPortDisplayName(ident.fingerprint)
	}

	/** 端口当前持久别名（无则 null；清除按钮显隐 / tooltip 用） */
	function getPortAlias(port) {
		if (!port) return null
		const ident = _portIdentityCache.has(port) ? _portIdentityCache.get(port) : syncPortIdentity(port)
		if (!ident.keys.length) return null
		const hit = lookupAlias(ident.keys)
		return hit ? hit.alias : null
	}

	/** 端口默认显示名（无别名时，供 tooltip 摘要） */
	function getPortDefaultName(port) {
		if (!port) return '未知设备'
		const ident = _portIdentityCache.has(port) ? _portIdentityCache.get(port) : syncPortIdentity(port)
		return defaultPortDisplayName(ident.fingerprint)
	}

	/** 设置端口别名；有持久 key 必写 localStorage（合并/删除 entry），否则仅内存别名 */
	async function setPortAlias(port, name) {
		const trimmed = String(name || '').trim().slice(0, 32)
		const ident = await resolvePortIdentity(port)
		if (ident.keys.length) {
			const store = loadAliases()
			if (trimmed) {
				// 合并进打分最高的 entry（仅强键命中或弱键全被覆盖时才算同一设备，避免同适配器多口互覆盖）
				let target = null
				let maxScore = 0
				for (const entry of store.entries) {
					let score = 0
					for (const k of entry.keys) {
						if (ident.keys.indexOf(k) !== -1 && keyScore(k) > score) score = keyScore(k)
					}
					if (score > maxScore) { maxScore = score; target = entry }
				}
				if (target && !entryIsSameDevice(target, ident.keys)) target = null
				if (target) {
					target.alias = trimmed
					target.keys = Array.from(new Set(target.keys.concat(ident.keys)))
					target.fingerprint = ident.fingerprint
					target.updatedAt = Date.now()
					// 清理与目标撞强键 / 被目标 keys 覆盖的其它 entry（同设备不重复存）
					store.entries = store.entries.filter(function (entry) {
						if (entry === target) return true
						return !entryMatchesKeys(entry, target.keys)
					})
				} else {
					// 新建 entry 时也清掉被当前 keys 覆盖的旧 v1 弱键 entry（P2-1）
					store.entries = store.entries.filter(function (entry) {
						return !entryMatchesKeys(entry, ident.keys)
					})
					store.entries.push({ id: randAliasId(), alias: trimmed, keys: ident.keys.slice(), fingerprint: ident.fingerprint, updatedAt: Date.now() })
				}
			} else {
				// 留空 = 删除：移除强键命中的 entry（及被完全覆盖的旧 v1 弱键 entry）
				store.entries = store.entries.filter(function (entry) {
					return !entryMatchesKeys(entry, ident.keys)
				})
			}
			saveAliases(store)
			_sessionAliasByPort.delete(port)
			return true
		}
		// 无任何持久 key：仅会话内存别名
		if (trimmed) {
			_sessionAliasByPort.set(port, trimmed)
		} else {
			_sessionAliasByPort.delete(port)
		}
		showToast('设备无持久标识，别名仅本次会话有效', 2000)
		return true
	}

	/** 检查端口是否有持久化 key（可用于持久化重命名） */
	function portHasIdentity(port) {
		const ident = _portIdentityCache.get(port)
		return !!(ident && ident.keys.length)
	}

	/** 更新端口选择按钮文案（单路：选择串口；双路：标签 · 设备名） */
	function updatePortButtonDisplay(sid, port) {
		let btnId = null
		if (SerialHub.mode === 'dual') {
			btnId = sid === 'A' ? 'serial-select-port-a' : 'serial-select-port-b'
		} else {
			btnId = 'serial-select-port'
		}
		const btn = document.getElementById(btnId)
		if (!btn) return
		if (!port) {
			const def = SerialHub.mode === 'dual' ? (sid === 'A' ? '选择A' : '选择B') : '选择串口'
			btn.innerHTML = '<i class="bi bi-usb-plug"></i> ' + def
			btn.title = ''
			return
		}
		const name = getPortDisplayName(port)
		const label = SerialHub.mode === 'dual' ? (sid === 'A' ? SerialHub.getLabelA() : SerialHub.getLabelB()) : ''
		const text = SerialHub.mode === 'dual' ? (label + ' · ' + name) : name
		// 有别名时 tooltip 附带默认指纹摘要
		btn.title = getPortAlias(port) ? name + '（' + getPortDefaultName(port) + '）' : name
		btn.innerHTML = '<i class="bi bi-usb-plug"></i> ' + HTMLEncode(text)
	}

	/** 刷新所有 UI 中的端口显示名 */
	function refreshPortDisplayNames() {
		// 双路状态区
		if (SerialHub.mode === 'dual') {
			const portA = SerialHub.getPort('A')
			const portB = SerialHub.getPort('B')
			updateDualPortDisplay('A', portA)
			updateDualPortDisplay('B', portB)
			updatePortButtonDisplay('A', portA)
			updatePortButtonDisplay('B', portB)
		} else {
			// 单路状态
			updateSinglePortDisplay(serialPort)
			updatePortButtonDisplay('A', serialPort)
		}
	}
	navigator.serial.addEventListener('connect', (e) => {
		const port = serialEventPort(e)
		if (isBluetoothSerialPort(port)) {
			addLogErr(`不支持蓝牙串口，请选择 USB 串口`)
			return
		}
		addLogErr(`设备已连接 (${getPortDisplayName(port)})`)
		if (!port || typeof port.open !== 'function') return
		// 按 port 匹配已有会话；若都不匹配则分配给第一个未打开会话
		let sid = SerialHub.findSessionByPort(port)
		if (!sid) {
			sid = SerialHub.findClosedSession()
			if (sid) {
				SerialHub.setPort(sid, port)
				// 新 port 需要计算 identity
				getPortIdentityKey(port).then(function () {
					refreshPortDisplayNames()
				})
			}
		}
		if (!sid) return
		//未主动关闭时，设备重插后自动重连(hotplug: 失败只打日志不弹窗)
		//不可拆事务: setOpening 必须在 openSerial 第一个 await 之前同步完成, 防两个 connect/用户点击并发 open
		if (!SerialHub.isManualClose(sid) && !SerialHub.isOpening(sid) && SerialHub.getPort(sid)) {
			SerialHub.setOpening(sid, true)
			openSerial(sid, { reason: 'hotplug' }).finally(function () {
				SerialHub.setOpening(sid, false)
			})
		}
	})
	navigator.serial.addEventListener('disconnect', async (e) => {
		const port = serialEventPort(e)
		addLogErr(`设备断开连接 (${getPortDisplayName(port)})`)
		const sid = SerialHub.findSessionByPort(port)
		if (!sid) return
		await closeSerial(sid)
		if (!SerialHub.isManualClose(sid)) {
			addLogErr(`会话 ${sid} 设备已断开，重新插入后将自动重连`)
		}
	})
	function serialStatuChange(statu, sid) {
		sid = sid || 'A'
		// sid=B 永远写 #serial-status-b；A 在双路写 -a、单路写 #serial-status
		// （避免 closeSerial('B') 异步完成时 mode 已切 single 误写主状态区）
		let containerId
		if (sid === 'B') containerId = 'serial-status-b'
		else if (SerialHub.mode === 'dual') containerId = 'serial-status-a'
		else containerId = 'serial-status'
		var el = document.getElementById(containerId)
		if (!el) return
		// 三态: true=已连接 / 'connecting'=正在连接… / false=未连接
		let stateClass, stateText
		if (statu === 'connecting') {
			stateClass = 'connecting'
			stateText = '正在连接…'
		} else if (statu) {
			stateClass = 'connected'
			stateText = '已连接'
		} else {
			stateClass = 'disconnected'
			stateText = '未连接'
		}
		el.innerHTML = '<div class="serial-status-indicator ' + stateClass + '"><span class="serial-status-dot"></span><span class="serial-status-text">' + stateText + '</span></div>'
		// 更新双路日志面板标题的标签
		if (SerialHub.mode === 'dual') {
			updateDualLogLabels()
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

	//发送HEX到串口（使用主发口）
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

	//发送文本到串口（使用主发口）
	async function sendText(text) {
		const encoder = new TextEncoder()
		await writeData(encoder.encode(text))
	}

	//写串口数据（走主发口 activeSendSid）
	async function writeData(data, sid) {
		sid = sid || SerialHub.activeSendSid()
		const port = SerialHub.getPort(sid)
		if (!port || !port.writable) {
			addLogErr('请先打开串口再发送数据')
			return
		}
		if (!SerialHub.isOpen(sid)) {
			addLogErr('请先打开串口再发送数据')
			return
		}
		let writer
		try {
			writer = port.writable.getWriter()
			if (toolOptions.addCRLF) {
				data = new Uint8Array([...data, 0x0d, 0x0a])
			}
			const sendTime = new Date()
			await writer.write(data)
			addLog(data, false, sendTime, sid)
			addParseLog([...data], false, sendTime)
		} catch (error) {
			const errorType = error.name || 'UnknownError'
			const errorMsg = error.message || '未知错误'
			addLogErr(`串口写入失败(${sid}): ${errorType} - ${errorMsg}`)
		} finally {
			if (writer) {
				try { writer.releaseLock() } catch (e) {}
			}
		}
	}

	//线路层瞬时错误:设备还在,流只是被这一帧的错误打断,重新取 reader 即可继续收
	//(长时间挂测时溢出/断帧几乎必然出现一次,不该因此判定断线)
	const RECOVERABLE_READ_ERRORS = ['BufferOverrunError', 'BreakError', 'FramingError', 'ParityError']
	const READ_RECOVER_WINDOW_MS = 10000
	const READ_RECOVER_MAX = 20

	//读串口数据
	async function readData(sid) {
		sid = sid || 'A'
		let streamError = false
		let streamClosed = false
		let recoverCount = 0
		let recoverWindowTs = 0
		const port = SerialHub.getPort(sid)

		while (SerialHub.isOpen(sid) && port && port.readable) {
			const r = port.readable.getReader()
			SerialHub.setReader(sid, r)
			try {
				while (true) {
					const { value, done } = await r.read()
					if (done) {
						streamClosed = true
						break
					}
					dataReceived(value, sid)
				}
			} catch (error) {
				const errorType = error.name || 'UnknownError'
				const errorMsg = error.message || '未知错误'
				//手动 close/cancel 时 read 会失败，不当作异常噪声
				if (SerialHub.isOpen(sid)) {
					const canRecover = RECOVERABLE_READ_ERRORS.indexOf(errorType) !== -1 &&
						port && port.readable
					if (canRecover) {
						const now = Date.now()
						if (now - recoverWindowTs > READ_RECOVER_WINDOW_MS) {
							recoverCount = 0
							recoverWindowTs = now
						}
						recoverCount++
						if (recoverCount > READ_RECOVER_MAX) {
							addLogErr(`串口读取错误(${sid}): ${errorType} - ${errorMsg}`)
							addLogErr('短时间内错误过多，已停止自动恢复，请检查波特率/接线/缓冲区大小')
							streamError = true
						} else {
							addLogErr(`串口读取错误(${sid}): ${errorType} - ${errorMsg}，已自动恢复继续接收`)
						}
					} else {
						addLogErr(`串口读取错误(${sid}): ${errorType} - ${errorMsg}`)
						if (errorType === 'NetworkError' || errorType === 'DeviceLostError') {
							addLogErr('设备可能已断开连接')
						} else if (errorType === 'SecurityError') {
							addLogErr('串口权限错误，请重新授权')
						}
						streamError = true
					}
				}
			} finally {
				if (SerialHub.getReader(sid) === r) SerialHub.setReader(sid, null)
				try {
					r.releaseLock()
				} catch (e) {}
			}
			//流异常/已结束时退出循环，由 disconnect/connect 或用户手动处理重连
			if (streamError || streamClosed || !SerialHub.isOpen(sid)) break
		}

		if ((streamError || streamClosed) && SerialHub.isOpen(sid)) {
			//先置未打开再释放(不再先 release 后 setOpen): isOpen 窗口期 hotplug 不再被吞, 按钮不卡在「关闭」
			if (SerialHub.isOpening(sid)) {
				SerialHub.setOpen(sid, false)
				return
			}
			SerialHub.setOpening(sid, true)
			try {
				SerialHub.setOpen(sid, false)
				serialStatuChange(false, sid)
				updateOpenButton(sid)
				await releasePort(sid)
				if (!SerialHub.isManualClose(sid)) {
					addLogErr(streamError
						? '读取中断，可重新打开串口或等待设备重连'
						: `串口读取流已关闭(${sid})，可重新打开串口`)
				}
			} finally {
				SerialHub.setOpening(sid, false)
			}
			//收尾期间 connect 可能因 isOpening 被跳过；设备仍在则补一次热插拔重开
			if (!SerialHub.isManualClose(sid) && !SerialHub.isOpen(sid) && !SerialHub.isOpening(sid) && SerialHub.getPort(sid)) {
				SerialHub.setOpening(sid, true)
				openSerial(sid, { reason: 'hotplug' }).finally(function () {
					SerialHub.setOpening(sid, false)
				})
			}
		}
	}

	//单个合并包的字节上限，超过就强制断包，避免连续流下缓冲无限增长
	const SERIAL_PACK_MAX_BYTES = 65536
	// SEK 帧在分包静默后若仍未收满声明长度, 最多再多等这么久(防低波特/间隙拆帧)
	const SEK_INCOMPLETE_WAIT_MAX_MS = 3000
	let serialSekWaitStart = null

	// 若缓冲以 A9 9A 开头且声明长度未到, 返回期望总长; 已完整或非 SEK 返回 0
	function peekSekIncompleteNeed(buf) {
		if (!buf || buf.length < 16 || buf[0] !== 0xA9 || buf[1] !== 0x9A) return 0
		const cands = []
		const dlDown = buf[14] | (buf[15] << 8)
		const expDown = 16 + dlDown + 3
		if (dlDown >= 0 && dlDown <= 4096 && expDown >= 19 && expDown <= 8192) cands.push(expDown)
		if (buf.length >= 24) {
			const dlUp = buf[22] | (buf[23] << 8)
			const expUp = 24 + dlUp + 3
			if (dlUp >= 0 && dlUp <= 4096 && expUp >= 27 && expUp <= 8192) cands.push(expUp)
		}
		if (!cands.length) return 0
		// 任一候选长度处结束符正确 → 已完整, 不必再等
		for (let i = 0; i < cands.length; i++) {
			const exp = cands[i]
			if (buf.length >= exp && buf[exp - 1] === 0x16) return 0
		}
		// 取仍未收满的最大期望长度
		let need = 0
		for (let i = 0; i < cands.length; i++) {
			if (buf.length < cands[i] && cands[i] > need) need = cands[i]
		}
		return need
	}

	function flushSerialPack(buf, startTime, sid) {
		sid = sid || 'A'
		SerialHub.setSekWaitStart(sid, null)
		if (!buf || !buf.length) return
		addLog(buf, true, startTime, sid)
		addParseLog(buf.slice ? buf.slice() : [...buf], true, startTime)
	}

	//串口分包合并
	function dataReceived(data, sid) {
		sid = sid || 'A'
		//立即把原始字节交给固件升级/协议测试等模块,由其自行按协议帧边界组装
		// 单路: 全量转发(与 main 语义一致)
		// 双路: sid=null 订阅者仅收 activeSend(钉扎时即钉扎口)的 RX; 指定 sid 的订阅者仅收对应 sid
		if (window.serialApi) {
			const api = window.serialApi
			if (SerialHub.mode === 'single') {
				if (api._receivers && api._receivers.length) {
					for (let i = 0; i < api._receivers.length; i++) {
						try { api._receivers[i].cb(data) } catch (e) { /* ignore */ }
					}
				} else if (api._onReceive) {
					api._onReceive(data)
				}
			} else if (api._receivers && api._receivers.length) {
				const asid = SerialHub.activeSendSid()
				for (let i = 0; i < api._receivers.length; i++) {
					const sub = api._receivers[i]
					const hit = sub.sid == null ? (sid === asid) : (sub.sid === sid)
					if (hit) {
						try { sub.cb(data) } catch (e) { /* ignore */ }
					}
				}
			} else if (api._onReceive) {
				api._onReceive(data)
			}
		}
		const packBuf = SerialHub.getPackBuf(sid)
		//新的合并包开始:记下第一个字节到达的时间,日志显示要用这个而不是flush时间
		if (packBuf.length === 0) {
			SerialHub.setPackStartTime(sid, new Date())
			SerialHub.setSekWaitStart(sid, null)
		}
		//不能用 push(...data)：单次读回的块可能上万字节(bufferSize 最大约 1.6M)，
		//展开成实参会超出调用栈上限抛 RangeError，被外层当成读错误误判为断线
		for (let i = 0; i < data.length; i++) packBuf.push(data[i])
		if (toolOptions.timeOut == 0) {
			flushSerialPack(packBuf, SerialHub.getPackStartTime(sid), sid)
			SerialHub.setPackBuf(sid, [])
			return
		}
		//持续不断的流永远等不到 timeOut 间隔，缓冲会一直涨到把页面撑爆，超上限就强制断包
		if (packBuf.length >= SERIAL_PACK_MAX_BYTES) {
			clearTimeout(SerialHub.getPackTimer(sid))
			flushSerialPack(packBuf, SerialHub.getPackStartTime(sid), sid)
			SerialHub.setPackBuf(sid, [])
			return
		}
		//清除之前的时钟
		clearTimeout(SerialHub.getPackTimer(sid))
		const startTime = SerialHub.getPackStartTime(sid)
		const armFlush = () => {
			SerialHub.setPackTimer(sid, setTimeout(() => {
				const curBuf = SerialHub.getPackBuf(sid)
				// 协议感知: SEK 帧声明长度未到时, 在上限内继续等后续字节
				const wantProto = toolOptions.skParseEnable || toolOptions.skHoverEnable ||
					(window._activeProtocol === 'sek')
				if (wantProto) {
					const need = peekSekIncompleteNeed(curBuf)
					if (need > 0 && curBuf.length < need && curBuf.length < SERIAL_PACK_MAX_BYTES) {
						if (SerialHub.getSekWaitStart(sid) == null) SerialHub.setSekWaitStart(sid, Date.now())
						if (Date.now() - SerialHub.getSekWaitStart(sid) < SEK_INCOMPLETE_WAIT_MAX_MS) {
							armFlush()
							return
						}
					}
				}
				const pack = curBuf.slice()
				SerialHub.setPackBuf(sid, [])
				flushSerialPack(pack, startTime, sid)
			}, toolOptions.timeOut))
		}
		armFlush()
	}

	//对外暴露的串口接口(供固件升级/协议测试等模块使用)
	//onReceive 支持多订阅者; 旧单回调 _onReceive 仍兼容
	window.serialApi = {
		async writeData(data) {
			await writeData(data, SerialHub.activeSendSid())
		},
		isOpen() {
			const sid = SerialHub.activeSendSid()
			const port = SerialHub.getPort(sid)
			return !!(port && port.writable && SerialHub.isOpen(sid))
		},
		//升级进行中时禁止第三方协议解析日志,避免干扰
		suppressParse: false,
		_onReceive: null,
		_receivers: [],
		onReceive(cb) {
			if (typeof cb !== 'function') return function () {}
			const sub = { cb: cb, sid: null }
			this._receivers.push(sub)
			//兼容旧固件升级模块: 保留最后一个单回调
			this._onReceive = cb
			const self = this
			return function unsubscribe() {
				const idx = self._receivers.indexOf(sub)
				if (idx !== -1) self._receivers.splice(idx, 1)
				if (self._onReceive === cb) {
					self._onReceive = self._receivers.length
						? self._receivers[self._receivers.length - 1].cb
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
		// === 双路扩展 ===
		getMode() {
			return SerialHub.mode
		},
		getActiveSendSid() {
			return SerialHub.activeSendSid()
		},
		// 事务钉扎: pin 期间 activeSendSid()/writeData/isOpen/RX 转发均锁定到钉扎会话
		pinSession(sid) {
			sid = sid || SerialHub.activeSendSid()
			if (sid !== 'A' && sid !== 'B') {
				addLogErr('pinSession: 无效的会话 id: ' + sid)
				return
			}
			if (pinSid && pinSid !== sid) {
				addLogErr('已有事务钉扎会话 ' + pinSid + '，忽略钉扎 ' + sid)
				return
			}
			pinSid = sid
			pinDepth++
		},
		unpinSession() {
			if (pinDepth > 0) pinDepth--
			if (pinDepth === 0) pinSid = null
		},
		isPinned() {
			return pinSid != null
		},
		async writeDataTo(id, data) {
			if (id !== 'A' && id !== 'B') {
				addLogErr('writeDataTo: 无效的会话 id: ' + id)
				return
			}
			await writeData(data, id)
		},
		onReceiveFrom(id, cb) {
			// 按 session 订阅 RX: 只收指定 sid 的上行; 无 id 等价 onReceive(跟随 activeSend)
			if (typeof cb !== 'function') return function () {}
			if (id != null && id !== 'A' && id !== 'B') {
				addLogErr('onReceiveFrom: 无效的会话 id: ' + id)
				return function () {}
			}
			const sub = { cb: cb, sid: id || null }
			this._receivers.push(sub)
			const self = this
			return function unsubscribe() {
				const idx = self._receivers.indexOf(sub)
				if (idx !== -1) self._receivers.splice(idx, 1)
			}
		},
		getAddCRLF() {
			return !!toolOptions.addCRLF
		},
		setAddCRLF(v) {
			changeOption('addCRLF', !!v)
			const cb = document.getElementById('serial-add-crlf')
			if (cb) cb.checked = !!v
		},
		getHexSend() {
			return !!toolOptions.hexSend
		},
		setHexSend(v) {
			changeOption('hexSend', !!v)
			const cb = document.getElementById('serial-hex-send')
			if (cb) cb.checked = !!v
		},
		listSessions() {
			const list = [{ id: 'A', label: SerialHub.getLabelA(), open: SerialHub.isOpen('A') }]
			if (SerialHub.mode === 'dual') {
				list.push({ id: 'B', label: SerialHub.getLabelB(), open: SerialHub.isOpen('B') })
			}
			return list
		},
	}
	var ansi_up = new AnsiUp()
	//日志行裁剪:超过 maxLogRows 时从顶部批量删除,并保持非自动滚动时的视觉位置不跳
	function trimLogRows(container) {
		container = container || serialLogs
		const max = parseInt(toolOptions.maxLogRows, 10)
		if (!max || max < 1) return
		let over = container.childElementCount - max
		if (over <= 0) return
		const beforeTop = container.scrollTop
		const beforeHeight = container.scrollHeight
		while (over-- > 0 && container.firstElementChild) {
			container.removeChild(container.firstElementChild)
		}
		if (toolOptions.autoScroll) return
		const want = Math.max(0, beforeTop - (beforeHeight - container.scrollHeight))
		if (Math.abs(container.scrollTop - want) > 1) {
			container.scrollTop = want
		}
	}
	//统一的日志插入: 按 (data-ts, data-seq) 全局单调序插入 + 裁剪整行 + 自动滚动
	function appendLogNode(node, sid) {
		const container = SerialHub.getLogContainer(sid)
		if (!container) return
		const ts = parseInt(node.getAttribute('data-ts') || '0', 10) || 0
		const seq = parseInt(node.getAttribute('data-seq') || '0', 10) || 0
		if (ts > 0 && container.childElementCount > 0) {
			// 从尾部向前找插入点，保持 (ts, seq) 升序；同毫秒按到达序（seq）稳定排序
			let inserted = false
			for (let i = container.children.length - 1; i >= 0; i--) {
				const sib = container.children[i]
				const sts = parseInt(sib.getAttribute('data-ts') || '0', 10) || 0
				const sseq = parseInt(sib.getAttribute('data-seq') || '0', 10) || 0
				if (sts < ts || (sts === ts && sseq < seq)) {
					if (sib.nextSibling) container.insertBefore(node, sib.nextSibling)
					else container.appendChild(node)
					inserted = true
					break
				}
			}
			if (!inserted) container.insertBefore(node, container.firstChild)
		} else {
			container.appendChild(node)
		}
		trimLogRows(container)
		if (toolOptions.autoScroll) {
			container.scrollTop = container.scrollHeight - container.clientHeight
		}
	}
	//添加日志
	function addLog(data, isReceive = true, atTime = null, sid = null) {
		sid = sid || 'A'
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
		const when = atTime || new Date()
		const ts = when.getTime ? when.getTime() : Date.now()
		let time = toolOptions.showTime ? formatDate(when) : ''
		let row = document.createElement('div')
		row.className = 'log-row'
		row.setAttribute('data-dir', isReceive ? 'rx' : 'tx')
		row.setAttribute('data-hex', dataHex.join(' '))
		row.setAttribute('data-ts', String(ts))
		row.setAttribute('data-seq', String(++logSeq))
		row.setAttribute('data-sid', sid || 'A')
		// 双路：方向旁会话标签；整行用 data-sid 分色
		const sess = SerialHub.mode === 'dual'
			? (sid === 'B' ? SerialHub.getLabelB() : SerialHub.getLabelA())
			: ''
		const dirLabel = form
		const sessHtml = sess
			? '<span class="log-sess">' + HTMLEncode(sess) + '</span>'
			: ''
		row.innerHTML = '<span class="log-time">' + time + '</span>' +
			'<span class="log-dir">' + dirLabel + '</span>' +
			sessHtml +
			'<span class="log-len">' + data.length + 'B</span>' +
			'<span class="log-body">' + newmsg + '</span>'
		appendLogNode(row, sid)
	}
	//第三方协议解析日志
	function addParseLog(data, isReceive, atTime = null) {
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
			const time = toolOptions.showTime ? formatDate(atTime || new Date()) + '&nbsp;' : ''
			const prompt = r.needKey ? '<div class="sk-parse-err">⚠ 加密报文,请在右侧「第三方协议」中的「密钥(ASCII)」或「密钥(HEX)」输入框填入密钥后再解析</div>' : ''
			html = '<div class="sk-parse-block ' + dirCls + '"><span class="text-muted small">' + time + form + ' 解析</span>' + prompt + skFormatFrame(r) + '</div>'
		} catch (err) {
			html = '<div class="sk-parse-block sk-parse-error"><span class="text-danger small">第三方协议解析异常:' + HTMLEncode(String(err)) + '</span></div>'
		}
		let tempNode = document.createElement('div')
		tempNode.innerHTML = html
		// 解析日志同样参与 (ts, seq) 全序排序
		const when = atTime || new Date()
		tempNode.setAttribute('data-ts', String(when.getTime ? when.getTime() : Date.now()))
		tempNode.setAttribute('data-seq', String(++logSeq))
		// 解析日志始终跟 activeSend
		appendLogNode(tempNode, SerialHub.activeSendSid())
		if (typeof skBindSeriesCharts === 'function') {
			try { skBindSeriesCharts(tempNode) } catch (e) { /* ignore */ }
		}
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
	//系统日志（单容器）
	function addLogErr(msg) {
		const when = new Date()
		let time = toolOptions.showTime ? formatDate(when) : ''
		let row = document.createElement('div')
		row.className = 'log-row'
		row.setAttribute('data-dir', 'sys')
		row.setAttribute('data-ts', String(when.getTime()))
		row.setAttribute('data-seq', String(++logSeq))
		row.setAttribute('data-sid', 'SYS')
		row.innerHTML = '<span class="log-time">' + time + '</span>' +
			'<span class="log-dir">!</span>' +
			'<span class="log-body text-danger">' + msg + '</span>'
		appendLogNode(row, 'A')
	}

	//轻量顶部气泡(非确认框)。kind='error' 用红色、停留更久
	let _toastTimer = null
	function showToast(msg, ms, kind) {
		kind = kind || 'info'
		if (ms == null) ms = kind === 'error' ? 3600 : 1400
		let tip = document.getElementById('serial-toast')
		if (!tip) {
			tip = document.createElement('div')
			tip.id = 'serial-toast'
			tip.setAttribute('role', 'status')
			document.body.appendChild(tip)
		}
		tip.className = 'serial-toast' + (kind === 'error' ? ' is-error' : '')
		tip.textContent = msg
		// 下一帧再加 is-show, 保证从隐藏切到同文案时动画仍会播
		tip.classList.remove('is-show')
		void tip.offsetWidth
		tip.classList.add('is-show')
		clearTimeout(_toastTimer)
		_toastTimer = setTimeout(function () {
			tip.classList.remove('is-show')
		}, ms)
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

	//错误提示走顶部气泡, 不再弹确认框
	function showMsg(msg) {
		showToast(msg, null, 'error')
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
		// 供 applySerialParamsToUI（模式切换刷新）调用
		updateSerialParamsSummary = updateSummary

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

	// ===== 双路模式 UI 设置 =====

	// 切换 UI 到双路模式（同步；与 switchToSingleUI 通过 modeSwitching 串行化）
	function switchToDualUI() {
		if (modeSwitching) return
		modeSwitching = true
		try {
			SerialHub.mode = 'dual'
			try { sessionStorage.setItem('serialHubMode', 'dual') } catch (e) {}

			// 参数下拉框显示双路独立配置（reload 恢复路径在 serialLogs 初始化前也会走到这里）
			applySerialParamsToUI()

			// 切换按钮状态
			document.getElementById('serial-mode-single').classList.remove('active')
			document.getElementById('serial-mode-dual').classList.add('active')

			// 隐藏单路控件，显示双路控件（参数 dropdown 在共享区，始终可见）
			const singleCtrl = document.getElementById('serial-single-ctrl')
			const dualCtrl = document.getElementById('serial-dual-ctrl')
			if (singleCtrl) singleCtrl.style.display = 'none'
			if (dualCtrl) dualCtrl.style.display = ''

			// 日志始终 #serial-logs；标记 dual 以便 CSS 强化分色
			if (serialLogs) {
				serialLogs.classList.add('is-dual')
				serialLogs.style.display = ''
			}

			// 更新按钮文案
			updateOpenButton('A')
			updateOpenButton('B')

			// 更新状态
			serialStatuChange(SerialHub.isOpen('A'), 'A')
			serialStatuChange(SerialHub.isOpen('B'), 'B')

			// 刷新端口显示名
			refreshPortDisplayNames()
		} finally {
			modeSwitching = false
		}
	}

	// 切换 UI 到单路模式（必须 await 关闭 B，否则 closeSerial 异步回调会在 mode=single 后写坏主状态区）
	async function switchToSingleUI() {
		if (modeSwitching) return
		modeSwitching = true
		try {
			// 先关闭会话 B（如果打开）——在仍为 dual 时完成状态更新
			// 分包缓冲与定时器清理已统一在 closeSerial 内
			if (sessionB.open || SerialHub.getPort('B')) {
				sessionB.manualClose = true
				try { await closeSerial('B') } catch (e) {}
			}
			SerialHub.mode = 'single'
			try { sessionStorage.setItem('serialHubMode', 'single') } catch (e) {}

			// 参数下拉框恢复单路配置
			applySerialParamsToUI()

			document.getElementById('serial-mode-single').classList.add('active')
			document.getElementById('serial-mode-dual').classList.remove('active')

			const singleCtrl = document.getElementById('serial-single-ctrl')
			const dualCtrl = document.getElementById('serial-dual-ctrl')
			if (singleCtrl) singleCtrl.style.display = ''
			if (dualCtrl) dualCtrl.style.display = 'none'

			if (serialLogs) {
				serialLogs.classList.remove('is-dual')
				serialLogs.style.display = ''
			}

			updateOpenButton('A')
			serialStatuChange(SerialHub.isOpen('A'), 'A')
			refreshPortDisplayNames()
		} finally {
			modeSwitching = false
		}
	}

	function updateDualLogLabels() {
		// 合流日志无独立栏标题；保留空函数避免旧调用报错
	}

	// 模式切换按钮
	document.getElementById('serial-mode-single').addEventListener('click', function () {
		if (SerialHub.mode === 'single') return
		switchToSingleUI().catch(function () {})
	})
	document.getElementById('serial-mode-dual').addEventListener('click', function () {
		if (SerialHub.mode === 'dual') return
		switchToDualUI()
	})

	// 双路：会话 A 端口选择
	const dualSelectPortA = document.getElementById('serial-select-port-a')
	if (dualSelectPortA) {
		dualSelectPortA.addEventListener('click', async function () {
			await selectPortFor('A')
		})
	}

	// 双路：会话 B 端口选择
	const dualSelectPortB = document.getElementById('serial-select-port-b')
	if (dualSelectPortB) {
		dualSelectPortB.addEventListener('click', async function () {
			await selectPortFor('B')
		})
	}

	// 双路：会话 A 打开/关闭
	const dualOpenA = document.getElementById('serial-open-or-close-a')
	if (dualOpenA) {
		dualOpenA.addEventListener('click', async function () {
			await handleToggleClick('A')
		})
	}

	// 双路：会话 B 打开/关闭
	const dualOpenB = document.getElementById('serial-open-or-close-b')
	if (dualOpenB) {
		dualOpenB.addEventListener('click', async function () {
			await handleToggleClick('B')
		})
	}

	// 双路：标签编辑（会话 A）
	const labelAInput = document.getElementById('serial-session-a-label')
	if (labelAInput) {
		labelAInput.addEventListener('input', function () {
			updateDualLogLabels()
		})
		labelAInput.addEventListener('change', function () {
			try { sessionStorage.setItem('serialSessionLabelA', this.value) } catch (e) {}
		})
	}

	// 双路：标签编辑（会话 B）
	const labelBInput = document.getElementById('serial-session-b-label')
	if (labelBInput) {
		labelBInput.addEventListener('input', function () {
			sessionB.label = this.value || 'RX'
			updateDualLogLabels()
		})
		labelBInput.addEventListener('change', function () {
			try { sessionStorage.setItem('serialSessionLabelB', this.value) } catch (e) {}
		})
	}

	// 双路：主发口选择
	const activeSendSel = document.getElementById('serial-active-send')
	if (activeSendSel) {
		activeSendSel.addEventListener('change', function () {
			// 事务钉扎期间禁止切换主发口，避免把事务后续帧发到另一台设备
			if (window.serialApi && window.serialApi.isPinned()) {
				activeSendSel.value = SerialHub.activeSendId
				showToast('事务进行中，暂不能切换主发口', 2000)
				return
			}
			SerialHub.activeSendId = this.value
			try { sessionStorage.setItem('serialActiveSendId', this.value) } catch (e) {}
		})
	}

	// 双路：恢复标签和主发口设置
	;(function restoreDualSettings() {
		try {
			const savedLabelA = sessionStorage.getItem('serialSessionLabelA')
			if (savedLabelA && labelAInput) labelAInput.value = savedLabelA
			const savedLabelB = sessionStorage.getItem('serialSessionLabelB')
			if (savedLabelB) {
				sessionB.label = savedLabelB
				if (labelBInput) labelBInput.value = savedLabelB
			}
			const savedActiveSend = sessionStorage.getItem('serialActiveSendId')
			if (savedActiveSend && activeSendSel) {
				SerialHub.activeSendId = savedActiveSend
				activeSendSel.value = savedActiveSend
			}
		} catch (e) {}
	})()

	// 恢复上次模式状态
	;(function restoreMode() {
		try {
			const savedMode = sessionStorage.getItem('serialHubMode')
			if (savedMode === 'dual') {
				switchToDualUI()
			}
		} catch (e) {}
	})()

	// 暴露 SerialHub 供命令面板等使用
	window.SerialHub = SerialHub

	// ===== 端口别名 UI =====

	/** 状态区按钮组：铅笔(重命名) + 有别名时显示清除 */
	function renderStatusButtons(sid, port) {
		let html = '<button class="port-rename-btn" title="重命名设备（本地保存，留空=删除）" data-port-sid="' + sid + '"><i class="bi bi-pencil"></i></button>'
		if (getPortAlias(port)) {
			html += '<button class="port-alias-clear-btn" title="清除别名" data-port-sid="' + sid + '"><i class="bi bi-x"></i></button>'
		}
		return html
	}

	/** 更新单路模式端口显示 */
	function updateSinglePortDisplay(port) {
		const statusEl = document.getElementById('serial-status')
		if (!statusEl || !port) return
		const name = getPortDisplayName(port)
		const indicator = statusEl.querySelector('.serial-status-indicator')
		if (indicator) {
			const textEl = indicator.querySelector('.serial-status-text')
			if (textEl) {
				textEl.innerHTML = HTMLEncode(name) + ' ' + renderStatusButtons('A', port)
			}
		}
	}

	/** 更新双路模式会话端口显示 */
	function updateDualPortDisplay(sid, port) {
		const statusEl = document.getElementById(sid === 'A' ? 'serial-status-a' : 'serial-status-b')
		if (!statusEl || !port) return
		const name = getPortDisplayName(port)
		const indicator = statusEl.querySelector('.serial-status-indicator')
		if (indicator) {
			const textEl = indicator.querySelector('.serial-status-text')
			if (textEl) {
				textEl.innerHTML = HTMLEncode(name) + ' ' + renderStatusButtons(sid, port)
			}
		}
	}

	/** 启动重命名交互：port 对象和 sid */
	async function startPortRename(sid) {
		const port = SerialHub.getPort(sid)
		if (!port) return
		// 确保 identity 已计算（可能触发 WebUSB 查询）
		await getPortIdentityKey(port)
		const currentName = getPortDisplayName(port)
		const hasIdentity = portHasIdentity(port)
		const hint = hasIdentity ? '（将保存在本机浏览器）' : '（此设备无 USB 标识，仅本次会话有效）'
		const label = SerialHub.mode === 'dual' ? (sid === 'A' ? SerialHub.getLabelA() : SerialHub.getLabelB()) : ''
		const promptText = (label ? label + ' · ' : '') + '设备别名' + hint + '（留空或点清除=删除）'
		const newName = window.prompt(promptText, currentName && currentName.indexOf('Vendor:') === -1 ? currentName : '')
		if (newName === null) return // 取消
		// 空名 = 删除别名
		await setPortAlias(port, (newName || '').trim() ? newName.trim().slice(0, 32) : '')
		refreshPortDisplayNames()
	}

	// 事件委托：port-rename-btn 点击
	document.addEventListener('click', function (e) {
		const btn = e.target.closest('.port-rename-btn')
		if (!btn) return
		e.preventDefault()
		e.stopPropagation()
		const sid = btn.getAttribute('data-port-sid')
		if (sid) startPortRename(sid)
	})

	// 事件委托：port-alias-clear-btn 点击（立即清除并恢复默认显示）
	document.addEventListener('click', function (e) {
		const btn = e.target.closest('.port-alias-clear-btn')
		if (!btn) return
		e.preventDefault()
		e.stopPropagation()
		const sid = btn.getAttribute('data-port-sid')
		const port = SerialHub.getPort(sid)
		if (!port) return
		setPortAlias(port, '').then(function () {
			refreshPortDisplayNames()
		})
	})

	// status 文字每次更新后挂上重命名按钮（serialStatuChange 调用此扩展）
	const _origSerialStatuChange = serialStatuChange
	serialStatuChange = function (statu, sid) {
		_origSerialStatuChange(statu, sid)
		// 已选口就显示「设备名 + 铅笔(+清除)」，无论连接与否（圆点颜色表达连接态）
		// connecting 期间保留"正在连接…"文案，不覆盖成设备名
		const port = SerialHub.getPort(sid)
		if (port && statu !== 'connecting') {
			if (SerialHub.mode === 'dual') {
				updateDualPortDisplay(sid, port)
			} else {
				updateSinglePortDisplay(port)
			}
		}
	}

	// 初始化：为已授权端口预计算 identity（跳过蓝牙口）
	;(function preloadPortIdentities() {
		navigator.serial.getPorts().then(function (ports) {
			for (var i = 0; i < ports.length; i++) {
				if (isBluetoothSerialPort(ports[i])) continue
				getPortIdentityKey(ports[i])
			}
		})
	})()

	// ===== reload 自动重连 =====
	// 必须放在本 IIFE 末尾: dual 恢复要调 switchToDualUI, 而 serialLogs 等 const 在后面才初始化(前面执行会踩 TDZ)
	// 仅刷新(reload)且刷新前串口处于打开意图时自动重连；新开/跳转不连
	;(async function reloadAutoReconnect() {
		let navType = 'navigate'
		try {
			const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0]
			if (nav && nav.type) navType = nav.type
			else if (performance.navigation) navType = performance.navigation.type === 1 ? 'reload' : 'navigate'
		} catch (e) {}
		if (navType !== 'reload') return
		const wantA = getSerialWantOpen('A')
		const wantB = getSerialWantOpen('B')
		if (!wantA && !wantB) return
		// 恢复模式（此时所有 const/函数已初始化，无 TDZ 风险）
		try {
			const savedMode = sessionStorage.getItem('serialHubMode')
			if (savedMode === 'dual') {
				SerialHub.mode = 'dual'
				switchToDualUI()
			}
		} catch (e) {}
		// 给上一 document 的 pagehide 释放 OS 句柄留一点时间；真正的等待靠 openSerial 的退避重试
		await new Promise(function (resolve) { setTimeout(resolve, 150) })
		const allPorts = await navigator.serial.getPorts()
		// 自动重连跳过蓝牙串口
		const ports = allPorts.filter(function (p) { return !isBluetoothSerialPort(p) })
		if (ports.length === 0) return
		// 预计算候选口的身份 keys（reload 后缓存为空，直接解析即可）
		const identKeys = []
		for (let i = 0; i < ports.length; i++) {
			const ident = await getPortIdentityKey(ports[i])
			identKeys.push(ident ? ident.keys : [])
		}
		// 按已存身份 key 匹配对应口；无身份 key（旧 sessionStorage 用户）按位置一次性兼容
		function findPortByKey(sid) {
			const want = getSerialWantPortKey(sid)
			if (!want || !want.length) return null
			for (let i = 0; i < ports.length; i++) {
				for (let j = 0; j < identKeys[i].length; j++) {
					if (want.indexOf(identKeys[i][j]) !== -1) return ports[i]
				}
			}
			return null
		}
		function findPortByPos(pos) {
			return pos < ports.length ? ports[pos] : null
		}
		const aIdKey = getSerialWantPortKey('A')
		const bIdKey = getSerialWantPortKey('B')
		let planA = null
		let planB = null
		if (wantA) {
			planA = findPortByKey('A')
			if (!planA && !aIdKey) planA = findPortByPos(0)
		}
		if (SerialHub.mode === 'dual' && wantB) {
			planB = findPortByKey('B')
			if (!planB && !bIdKey) planB = findPortByPos(wantA && planA ? 1 : 0)
		}
		// 有身份 key 但匹配不到：不自动打开、不回落位置绑定，提示重新选择
		if (wantA && !planA) addLogErr('A 未找到原设备，请重新选择串口')
		if (SerialHub.mode === 'dual' && wantB && !planB) addLogErr('B 未找到原设备，请重新选择串口')
		if (planA) {
			// 走 SerialHub.setPort 而不是直接写 serialPort; 开前后维护 opening 锁防并发
			SerialHub.setPort('A', planA)
			SerialHub.setOpening('A', true)
			try {
				await openSerial('A', { reason: 'reload' })
			} finally {
				SerialHub.setOpening('A', false)
			}
		}
		if (planB) {
			SerialHub.setPort('B', planB)
			SerialHub.setOpening('B', true)
			try {
				await openSerial('B', { reason: 'reload' })
			} finally {
				SerialHub.setOpening('B', false)
			}
		}
		if (SerialHub.mode === 'dual' && wantA && wantB && planA && planB) {
			if (aIdKey && bIdKey) addLogErr('双路已按设备身份恢复 A/B 连接')
			else addLogErr('双路已按授权顺序恢复 A/B；若设备串台请重新选择串口')
		}
	})().catch(function () {})
})()
