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
	navigator.serial.getPorts().then((ports) => {
		if (ports.length > 0) {
			serialPort = ports[0]
			serialStatuChange(true)
		}
	})
	let reader
	//串口目前是打开状态
	let serialOpen = false
	//串口目前是手动关闭状态
	let serialClose = true
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
		let curr = e.target
		if (curr.tagName != 'BUTTON') {
			curr = curr.parentNode
		}
		if (curr.tagName != 'BUTTON') {
			return
		}
		const index = Array.from(curr.parentNode.parentNode.children).indexOf(curr.parentNode)
		if (curr.classList.contains('quick-remove')) {
			currQuickSend.list.splice(index, 1)
			curr.parentNode.remove()
			saveQuickList()
			return
		}
		if (curr.classList.contains('quick-send')) {
			let item = currQuickSend.list[index]
			if (item.hex) {
				sendHex(item.content)
				return
			}
			sendText(item.content)
		}
	})
	//快捷列表双击改名
	document.getElementById('serial-quick-send-content').addEventListener('dblclick', (e) => {
		let curr = e.target
		if (curr.tagName != 'INPUT' || curr.type != 'text') {
			return
		}
		const index = Array.from(curr.parentNode.parentNode.children).indexOf(curr.parentNode)
		changeName((name) => {
			currQuickSend.list[index].name = name
			curr.parentNode.outerHTML = getQuickItemHtml(currQuickSend.list[index])
			saveQuickList()
		}, currQuickSend.list[index].name)
	})
	//快捷发送列表被改变
	document.getElementById('serial-quick-send-content').addEventListener('change', (e) => {
		let curr = e.target
		if (curr.tagName != 'INPUT') {
			return
		}
		const index = Array.from(curr.parentNode.parentNode.children).indexOf(curr.parentNode)
		if (curr.type == 'text') {
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
		return `<div class="d-flex p-1 border-bottom quick-item">
			<button type="button" title="移除该项" class="btn btn-sm btn-outline-secondary me-1 quick-remove"><i class="bi bi-x"></i></button>
			<input class="form-control form-control-sm me-1" placeholder="要发送的内容,双击改名" value="${item.content}">
			<button class="flex-shrink-0 me-1 align-self-center btn btn-secondary btn-sm  quick-send" title="${item.name}">${item.name}</button>
			<input class="form-check-input flex-shrink-0 align-self-center" type="checkbox" ${item.hex ? 'checked' : ''}>
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
	//第三方协议手动解析
	document.getElementById('serial-protocol-parse').addEventListener('click', (e) => {
		const raw = document.getElementById('serial-protocol-input').value
		if (!raw) {
			addLogErr('请输入HEX报文')
			return
		}
		let hex = raw.replace(/0x/gi, '').replace(/[\s,;]+/g, '')
		if (!/^[0-9A-Fa-f]*$/.test(hex) || hex.length % 2 !== 0) {
			addLogErr('HEX格式错误:' + raw)
			return
		}
		let bytes = new Uint8Array(hex.length / 2)
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
		}
		try {
			const r = skParseFrame(bytes, {
				keyAscii: toolOptions.skKeyAscii || undefined,
				keyHex: toolOptions.skKeyHex || undefined,
				decryptMode: toolOptions.skDecryptMode,
			})
			const prompt = r.needKey ? '<div class="sk-parse-err">⚠ 加密报文,请在上方「密钥(ASCII)」或「密钥(HEX)」输入框填入密钥后再解析</div>' : ''
			document.getElementById('serial-protocol-output').innerHTML = prompt + skFormatFrame(r)
		} catch (err) {
			document.getElementById('serial-protocol-output').innerHTML = '<div class="sk-parse-err">解析异常:' + HTMLEncode(String(err)) + '</div>'
		}
	})
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
			let encKey = null
			if (toolOptions.skKeyHex) {
				const hex = toolOptions.skKeyHex.trim().replace(/\s+/g, '')
				if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
					const a = []
					for (let i = 0; i < hex.length; i += 2) a.push(parseInt(hex.substr(i, 2), 16))
					encKey = new Uint8Array(a)
				}
			} else if (toolOptions.skKeyAscii) {
				const s = toolOptions.skKeyAscii
				const a = new Uint8Array(s.length)
				for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff
				encKey = a
			}
			const frame = skBuildDownFrame({
				funcCode: document.getElementById('serial-protocol-down-func').value,
				version: 2,
				time: new Date(),
				frameSeq: _downSeq++,
				tlv: tlv,
				encKey: encKey ? encKey : null,
			})
			let hex = []
			for (const b of frame) {
				hex.push(('0' + b.toString(16).toUpperCase()).slice(-2))
			}
			document.getElementById('serial-protocol-down-preview').value = hex.join(' ')
		} catch (err) {
			addLogErr('生成帧失败:' + err.toString())
		}
	})
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
		if (!presetSel || !window.SK_DOWN_PRESETS) return
		while (presetSel.options.length > 1) presetSel.remove(1)
		for (const grp of window.SK_DOWN_PRESETS) {
			const filtered = grp.items.filter(it => it.func === funcCode)
			if (!filtered.length) continue
			const og = document.createElement('optgroup')
			og.label = grp.group
			for (const it of filtered) {
				const op = document.createElement('option')
				op.value = it.name
				op.textContent = it.name
				og.appendChild(op)
			}
			presetSel.appendChild(og)
		}
	}
	let _skipFuncEvent = false
	if (funcSel && window.SK_DOWN_PRESETS) {
		rebuildPresets(funcSel.value)
		funcSel.addEventListener('change', () => {
			if (_skipFuncEvent) { _skipFuncEvent = false; return }
			presetSel.value = ''
			rebuildPresets(funcSel.value)
		})
	}
	function presetItemByName(name) {
		if (!window.SK_DOWN_PRESETS) return null
		for (const grp of window.SK_DOWN_PRESETS) {
			for (const it of grp.items) {
				if (it.name === name) return it
			}
		}
		return null
	}
	function asciiToHexBytes(s, fillLen) {
		let a = []
		for (let i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0xff)
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
					paramUnit.textContent = ''
					_currentParamType = 'ascii'
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
	if (toolOptions.skEncType) {
		set('serial-protocol-enc-type', toolOptions.skEncType)
	}
	quickSend.value = toolOptions.quickSendIndex
	quickSend.dispatchEvent(new Event('change'))
	resetLoopSend()

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
	document.getElementById('serial-log-type').addEventListener('change', (e) => {
		changeOption('logType', e.target.value)
		if (e.target.value.includes('ansi')) {
			serialLogs.classList.add('ansi')
		} else {
			serialLogs.classList.remove('ansi')
		}
	})
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

	document.querySelectorAll('#serial-options .input-group input,#serial-options .input-group select').forEach((item) => {
		item.addEventListener('change', async (e) => {
			if (!serialOpen) {
				return
			}
			//未找到API可以动态修改串口参数,先关闭再重新打开
			await closeSerial()
			//立即打开会提示串口已打开,延迟50ms再打开
			setTimeout(() => {
				openSerial()
			}, 50)
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

	//清空
	document.getElementById('serial-clear').addEventListener('click', (e) => {
		serialLogs.innerHTML = ''
	})
	//复制
	document.getElementById('serial-copy').addEventListener('click', (e) => {
		let text = serialLogs.innerText
		if (text) {
			copyText(text)
		}
	})
	//保存
	document.getElementById('serial-save').addEventListener('click', (e) => {
		let text = serialLogs.innerText
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
		const act = serialLogs.querySelectorAll('.sk-hex-byte-active')
		for (const el of act) el.classList.remove('sk-hex-byte-active')
	}
	serialLogs.addEventListener('mouseover', (e) => {
		if (!e.target || !e.target.closest) return
		const span = e.target.closest('.sk-hex-byte')
		if (span) {
			clearSkHoverActive()
			const grp = span.getAttribute('data-grp')
			if (grp) {
				const peers = serialLogs.querySelectorAll('.sk-hex-byte[data-grp="' + grp + '"]')
				for (const el of peers) el.classList.add('sk-hex-byte-active')
			}
			showSkHoverTip(span)
		} else {
			clearSkHoverActive()
			skHoverTip.style.display = 'none'
		}
	})
	serialLogs.addEventListener('scroll', () => {
		clearSkHoverActive()
		skHoverTip.style.display = 'none'
	})
	serialLogs.addEventListener('mouseleave', () => {
		clearSkHoverActive()
		skHoverTip.style.display = 'none'
	})

	//选择串口
	document.getElementById('serial-select-port').addEventListener('click', async () => {
		// 客户端授权
		try {
			await navigator.serial.requestPort().then(async (port) => {
				closeSerial()
				serialPort = port
				serialStatuChange(true)
			})
		} catch (e) {
			console.error('获取串口权限出错' + e.toString())
		}
	})

	//关闭串口
	async function closeSerial() {
		if (serialOpen) {
			serialOpen = false
			reader?.cancel()
			serialToggle.innerHTML = '打开串口'
		}
	}

	//打开串口
	async function openSerial() {
		let SerialOptions = {
			baudRate: parseInt(get('serial-baud')),
			dataBits: parseInt(get('serial-data-bits')),
			stopBits: parseInt(get('serial-stop-bits')),
			parity: get('serial-parity'),
			bufferSize: parseInt(get('serial-buffer-size')),
			flowControl: get('serial-flow-control'),
		}
		// console.log('串口配置', JSON.stringify(SerialOptions))
		serialPort
			.open(SerialOptions)
			.then(() => {
				serialToggle.innerHTML = '关闭串口'
				serialOpen = true
				serialClose = false
				localStorage.setItem('serialOptions', JSON.stringify(SerialOptions))
				readData()
			})
			.catch((e) => {
				showMsg('打开串口失败:' + e.toString())
			})
	}

	//打开或关闭串口
	serialToggle.addEventListener('click', async () => {
		if (!serialPort) {
			showMsg('请先选择串口')
			return
		}

		if (serialPort.writable && serialPort.readable) {
			closeSerial()
			serialClose = true
			return
		}

		openSerial()
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

	//串口事件监听
	navigator.serial.addEventListener('connect', (e) => {
		serialStatuChange(true)
		serialPort = e.target
		//未主动关闭连接的情况下,设备重插,自动重连
		if (!serialClose) {
			openSerial()
		}
	})
	navigator.serial.addEventListener('disconnect', (e) => {
		serialStatuChange(false)
		setTimeout(closeSerial, 500)
	})
	function serialStatuChange(statu) {
		let tip
		if (statu) {
			tip = '<div class="alert alert-success" role="alert">设备已连接</div>'
		} else {
			tip = '<div class="alert alert-danger" role="alert">设备已断开</div>'
		}
		document.getElementById('serial-status').innerHTML = tip
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
		writeData(encoder.encode(text))
	}

	//写串口数据
	async function writeData(data) {
		if (!serialPort || !serialPort.writable) {
			addLogErr('请先打开串口再发送数据')
			return
		}
		const writer = serialPort.writable.getWriter()
		if (toolOptions.addCRLF) {
			data = new Uint8Array([...data, 0x0d, 0x0a])
		}
		await writer.write(data)
		writer.releaseLock()
		addLog(data, false)
		addParseLog([...data], false)
	}

	//读串口数据
	async function readData() {
		while (serialOpen && serialPort.readable) {
			reader = serialPort.readable.getReader()
			try {
				while (true) {
					const { value, done } = await reader.read()
					if (done) {
						break
					}
					dataReceived(value)
				}
			} catch (error) {
			} finally {
				reader.releaseLock()
			}
		}
		await serialPort.close()
	}

	//串口分包合并
	function dataReceived(data) {
		//立即把原始字节交给固件升级等模块,由其自行按协议帧边界组装
		if (window.serialApi && window.serialApi._onReceive) window.serialApi._onReceive(data)
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

	//对外暴露的串口接口(供固件升级等模块使用)
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
		onReceive(cb) {
			this._onReceive = cb
		},
	}
	var ansi_up = new AnsiUp()
	//添加日志
	function addLog(data, isReceive = true) {
		let classname = 'text-primary'
		let form = '→'
		if (isReceive) {
			classname = 'text-success'
			form = '←'
		}
		newmsg = ''
		if (toolOptions.logType.includes('hex')) {
			let dataHex = []
			for (const d of data) {
				//转16进制并补0
				dataHex.push(('0' + d.toString(16).toLocaleUpperCase()).slice(-2))
			}
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
		let time = toolOptions.showTime ? formatDate(new Date()) + '&nbsp;' : ''
		const template = '<div><span class="' + classname + '">' + time + form + '</span><br>' + newmsg + '</div>'
		let tempNode = document.createElement('div')
		tempNode.innerHTML = template
		serialLogs.append(tempNode)
		if (toolOptions.autoScroll) {
			serialLogs.scrollTop = serialLogs.scrollHeight - serialLogs.clientHeight
		}
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
			const prompt = r.needKey ? '<div class="sk-parse-err">⚠ 加密报文,请在上方「密钥(ASCII)」或「密钥(HEX)」输入框填入密钥后再解析</div>' : ''
			html = '<div class="sk-parse-block ' + dirCls + '"><span class="text-muted small">' + time + form + ' 解析</span>' + prompt + skFormatFrame(r) + '</div>'
		} catch (err) {
			html = '<div class="sk-parse-block sk-parse-error"><span class="text-danger small">第三方协议解析异常:' + HTMLEncode(String(err)) + '</span></div>'
		}
		let tempNode = document.createElement('div')
		tempNode.innerHTML = html
		serialLogs.append(tempNode)
		if (toolOptions.autoScroll) {
			serialLogs.scrollTop = serialLogs.scrollHeight - serialLogs.clientHeight
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
	//系统日志
	function addLogErr(msg) {
		let time = toolOptions.showTime ? formatDate(new Date()) + '&nbsp;' : ''
		const template = '<div><span class="text-danger">' + time + ' 系统消息</span><br>' + msg + '</div>'
		let tempNode = document.createElement('div')
		tempNode.innerHTML = template
		serialLogs.append(tempNode)
		if (toolOptions.autoScroll) {
			serialLogs.scrollTop = serialLogs.scrollHeight - serialLogs.clientHeight
		}
	}

	//复制文本
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
		showMsg('已复制到剪贴板')
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

	//左右折叠
	document.querySelectorAll('.toggle-button').forEach((element) => {
		element.addEventListener('click', (e) => {
			e.currentTarget.parentElement.querySelector('.collapse').classList.toggle('show')
			e.currentTarget.querySelector('i').classList.toggle('bi-chevron-compact-right')
			e.currentTarget.querySelector('i').classList.toggle('bi-chevron-compact-left')
		})
	})

	//设置名称
	const modalNewName = new bootstrap.Modal('#model-change-name')
	function changeName(callback, oldName = '') {
		set('model-new-name', oldName)
		modalNewName.show()
		document.getElementById('model-save-name').onclick = null
		document.getElementById('model-save-name').onclick = function () {
			callback(get('model-new-name'))
			modalNewName.hide()
		}
	}
})()
