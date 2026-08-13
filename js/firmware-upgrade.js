;(function () {
	'use strict'

	if (!window.PCP || !window.FirmwareParser) {
		console.error('PCP 模块未加载')
		return
	}
	if (!window.serialApi) {
		console.error('串口接口未就绪')
		return
	}

	const PCP = window.PCP
	const PCPMessageCode = window.PCPMessageCode
	const FirmwareParser = window.FirmwareParser
	const serialApi = window.serialApi

	let fw = null                 // 解析后的固件信息
	let fwFileBuffer = null       // 固件 ArrayBuffer
	let running = false
	let stopFlag = false
	let recvBuffer = []

	const el = {
		file: document.getElementById('fw-file'),
		select: document.getElementById('fw-select'),
		fileName: document.getElementById('fw-file-name'),
		fileSize: document.getElementById('fw-file-size'),
		dropZone: document.getElementById('fw-drop-zone'),
		fileCard: document.getElementById('fw-file-card'),
		fileClear: document.getElementById('fw-file-clear'),
		chunkSize: document.getElementById('fw-chunk-size'),
		parse: document.getElementById('fw-parse'),
		diagnose: document.getElementById('fw-diagnose'),
		info: document.getElementById('fw-info'),
		start: document.getElementById('fw-start'),
		stop: document.getElementById('fw-stop'),
		query: document.getElementById('fw-query'),
		clearLog: document.getElementById('fw-clear-log'),
		status: document.getElementById('fw-status'),
		progress: document.getElementById('fw-progress'),
		log: document.getElementById('fw-log'),
	}

	function fmtSize(bytes) {
		if (bytes < 1024) return bytes + ' B'
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
		return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
	}

	function showFileCard(name, size) {
		el.dropZone.classList.add('d-none')
		el.fileCard.classList.remove('d-none')
		el.fileName.textContent = name
		el.fileSize.textContent = fmtSize(size)
	}

	function hideFileCard() {
		el.dropZone.classList.remove('d-none')
		el.fileCard.classList.add('d-none')
		el.fileName.textContent = '未选择固件文件'
		el.fileSize.textContent = '--'
	}

	function loadFwFile(file) {
		if (!file) return
		el.fileName.dataset.name = file.name
		const reader = new FileReader()
		reader.onload = function () {
			fwFileBuffer = reader.result
			showFileCard(file.name, file.size)
			log('已载入固件: ' + file.name + ' (' + fmtSize(file.size) + ')', 'info')
			el.parse.click()
		}
		reader.readAsArrayBuffer(file)
	}

	function log(msg, level) {
		const cls = { info: '', success: 'text-success', error: 'text-danger', warn: 'text-warning' }[level || 'info']
		const time = new Date().toLocaleTimeString()
		const line = document.createElement('div')
		line.className = cls
		line.textContent = `[${time}] ${msg}`
		el.log.appendChild(line)
		el.log.scrollTop = el.log.scrollHeight
	}
	function setProgress(p) {
		p = Math.max(0, Math.min(100, p))
		el.progress.style.width = p + '%'
		el.progress.textContent = p + '%'
		el.progress.setAttribute('aria-valuenow', p)
	}
	function setStatus(s) {
		el.status.textContent = s || ''
	}

	el.select.addEventListener('click', function (e) { e.stopPropagation(); el.file.click() })
	el.dropZone.addEventListener('click', function () { el.file.click() })

	el.fileClear.addEventListener('click', function (e) {
		e.stopPropagation()
		fw = null
		fwFileBuffer = null
		hideFileCard()
		el.file.value = ''
		el.info.textContent = ''
		el.start.disabled = true
		log('已清除固件文件', 'info')
	})

	el.file.addEventListener('change', function (e) {
		const f = e.target.files[0]
		if (f) loadFwFile(f)
	})

	// Drag & Drop
	;['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (evt) {
		el.dropZone.addEventListener(evt, function (e) { e.preventDefault(); e.stopPropagation() }, false)
	})
	;['dragenter', 'dragover'].forEach(function (evt) {
		el.dropZone.addEventListener(evt, function () { el.dropZone.classList.add('drag-over') }, false)
	})
	;['dragleave', 'drop'].forEach(function (evt) {
		el.dropZone.addEventListener(evt, function () { el.dropZone.classList.remove('drag-over') }, false)
	})
	el.dropZone.addEventListener('drop', function (e) {
		const files = e.dataTransfer.files
		if (files.length > 0) loadFwFile(files[0])
	}, false)

	el.parse.addEventListener('click', () => {
		if (!fwFileBuffer) {
			log('请先选择固件文件', 'error')
			return
		}
		const r = FirmwareParser.parse(fwFileBuffer)
		if (!r.ok) {
			log('固件解析失败: ' + r.error, 'error')
			fw = null
			el.start.disabled = true
			return
		}
		r.fileName = el.fileName.dataset.name
		fw = r
		el.info.textContent = FirmwareParser.diagnose(r)
		log('固件解析成功, 版本: ' + r.version, 'success')
		el.start.disabled = !serialApi.isOpen()
	})

	el.diagnose.addEventListener('click', () => {
		if (!fw) {
			el.parse.click()
			if (!fw) return
		}
		el.info.textContent = FirmwareParser.diagnose(fw)
	})

	el.query.addEventListener('click', async () => {
		if (!serialApi.isOpen()) {
			log('请先打开串口', 'error')
			return
		}
		window.serialApi.suppressParse = true
		serialApi.pinSession(serialApi.getActiveSendSid())
		try {
			const resp = await sendAndWait(PCP.buildQueryVersionRequest(), PCPMessageCode.QUERY_VERSION, 5000)
			const res = PCP.parseQueryVersionResponse(resp)
			if (res.resultCode !== 0) {
				log('查询版本失败, 结果码 0x' + res.resultCode.toString(16), 'error')
			} else {
				log('设备当前版本: ' + res.version, 'success')
			}
		} catch (e) {
			log('查询版本超时: ' + e.message, 'error')
		} finally {
			serialApi.unpinSession()
			window.serialApi.suppressParse = false
		}
	})

	el.clearLog.addEventListener('click', () => { el.log.innerHTML = '' })

	// 持久化分片大小
	;(function () {
		var saved = localStorage.getItem('fwChunkSize')
		if (saved) el.chunkSize.value = saved
		el.chunkSize.addEventListener('change', function () {
			localStorage.setItem('fwChunkSize', this.value)
		})
	})()

	el.start.addEventListener('click', async () => {
		if (!fw) {
			log('请先解析固件', 'error')
			return
		}
		if (!serialApi.isOpen()) {
			log('请先打开串口', 'error')
			return
		}
		running = true
		stopFlag = false
		window.serialApi.suppressParse = true
		// 升级事务钉扎主发口: 期间切主发口被拦, 下发与 RX 等待稳定在同一设备
		serialApi.pinSession(serialApi.getActiveSendSid())
		el.start.disabled = true
		el.stop.disabled = false
		el.query.disabled = true
		setProgress(0)
		try {
			await runUpgrade()
		} finally {
			running = false
			serialApi.unpinSession()
			window.serialApi.suppressParse = false
			el.start.disabled = false
			el.stop.disabled = true
			el.query.disabled = false
			recvBuffer = []
		}
	})

	el.stop.addEventListener('click', () => {
		if (!running) return
		stopFlag = true
		log('正在停止升级...', 'warn')
	})

	// 累积接收字节, 提取一个完整的 PCP 帧(起始 0xFFFE + 8字节头 + dataLength)
	function tryReadFrame() {
		while (recvBuffer.length >= 8) {
			if (recvBuffer[0] !== 0xFF || recvBuffer[1] !== 0xFE) {
				recvBuffer.shift()
				continue
			}
			const dataLength = (recvBuffer[6] << 8) | recvBuffer[7]
			const total = 8 + dataLength
			if (recvBuffer.length < total) break
			const frame = recvBuffer.splice(0, total)
			return Uint8Array.from(frame)
		}
		return null
	}

	// 常驻接收: 把所有串口原始字节累积进 recvBuffer, 并尝试派发给正在等待的 waiter
	let waiters = []
	serialApi.onReceive((data) => {
		if (!data || !data.length) return
		recvBuffer.push(...data)
		// 防止非 PCP 流量无限堆积
		if (recvBuffer.length > 65536) recvBuffer.splice(0, recvBuffer.length - 65536)
		let frame
		while ((frame = tryReadFrame())) {
			const parsed = PCP.parseMessage(frame)
			if (!parsed) continue
			for (let i = waiters.length - 1; i >= 0; i--) {
				const w = waiters[i]
				if (w.codes.indexOf(parsed.messageCode) !== -1) {
					waiters.splice(i, 1)
					clearTimeout(w.timer)
					w.resolve(frame)
				}
			}
		}
	})

	// 发送数据并等待指定消息码的响应(可同时等待多个消息码), 带超时
	function sendAndWait(reqBytes, expectCodes, timeout) {
		const codes = Array.isArray(expectCodes) ? expectCodes : [expectCodes]
		return new Promise((resolve, reject) => {
			const w = {
				codes,
				resolve,
				timer: setTimeout(() => {
					const idx = waiters.indexOf(w)
					if (idx !== -1) waiters.splice(idx, 1)
					reject(new Error('等待响应超时'))
				}, timeout),
			}
			waiters.push(w)
			serialApi.writeData(reqBytes)
			log('发送: ' + bytesToHex(reqBytes), 'info')
		})
	}

	function bytesToHex(arr) {
		return Array.from(arr).map(b => ('0' + b.toString(16).toUpperCase()).slice(-2)).join(' ')
	}

	async function runUpgrade() {
		const parser = fw
		const chunkSize = parseInt(el.chunkSize.value) || 128
		const firmwareData = fw.firmwareData
		const totalChunks = Math.ceil(firmwareData.length / chunkSize)
		log('开始固件升级, 版本: ' + parser.version + ', 分片: ' + totalChunks, 'info')

		// 步骤1: 查询设备版本
		if (stopFlag) return
		try {
			const resp = await sendAndWait(PCP.buildQueryVersionRequest(), PCPMessageCode.QUERY_VERSION, 5000)
			const res = PCP.parseQueryVersionResponse(resp)
			if (res.resultCode !== 0) {
				log('查询版本失败: 0x' + res.resultCode.toString(16), 'error')
				return
			}
			log('设备当前版本: ' + res.version, 'success')
			setProgress(15)
		} catch (e) {
			log('查询版本超时: ' + e.message, 'error')
			return
		}

		// 步骤2: 通知新版本
		if (stopFlag) return
		try {
			const resp = await sendAndWait(
				PCP.buildNewVersionNotify(parser.version, chunkSize, totalChunks),
				PCPMessageCode.NEW_VERSION_NOTIFY, 5000)
			const res = PCP.parseNewVersionNotifyResponse(resp)
			const errMap = {
				0x01: '设备使用中', 0x02: '信号质量差', 0x03: '已经是最新版本',
				0x04: '电量不足', 0x05: '剩余空间不足', 0x09: '内存不足', 0x7F: '内部异常',
			}
			if (res.resultCode !== 0) {
				log('设备拒绝升级: ' + (errMap[res.resultCode] || ('0x' + res.resultCode.toString(16))), 'error')
				return
			}
			log('设备允许升级', 'success')
			setProgress(25)
		} catch (e) {
			log('新版本通知超时', 'error')
			return
		}

		// 步骤3: 分片下载传输
		if (stopFlag) return
		const sentChunks = new Set()
		let pendingMessage = null
		try {
			// 设备请求哪个分片就回哪个分片; 收到下载结果(0x16)即视为传输完成
			while (true) {
				if (stopFlag) return
				let requestData
				if (pendingMessage) {
					requestData = pendingMessage
					pendingMessage = null
				} else {
					// 同时等待分片请求(0x15)与下载结果上报(0x16)
					requestData = await waitForCode([PCPMessageCode.DOWNLOAD_REQUEST, PCPMessageCode.DOWNLOAD_RESULT], 10000)
				}
				if (!requestData) {
					log('等待设备数据超时 (' + sentChunks.size + '/' + totalChunks + ')', 'error')
					return
				}
				const parsed = PCP.parseMessage(requestData)
				if (parsed.messageCode === PCPMessageCode.DOWNLOAD_RESULT) {
					log('设备上报下载结果', 'info')
					pendingMessage = requestData
					break
				}
				if (parsed.messageCode !== PCPMessageCode.DOWNLOAD_REQUEST) {
					log('收到意外消息: ' + PCP.messageCodeName(parsed.messageCode), 'warn')
					continue
				}
				const req = PCP.parseDownloadRequest(requestData)
				const idx = req.chunkIndex
				if (idx >= totalChunks) {
					log('设备请求无效分片索引 ' + idx, 'warn')
					continue
				}
				const start = idx * chunkSize
				const end = Math.min(start + chunkSize, firmwareData.length)
				let chunk = firmwareData.subarray(start, end)
				// 末尾不足一个分包大小需用 0xFF 补齐
				if (chunk.length < chunkSize) {
					const padded = new Uint8Array(chunkSize)
					padded.set(chunk, 0)
					padded.fill(0xFF, chunk.length)
					chunk = padded
				}
				const resp = PCP.buildDownloadResponse(idx, chunk, parser.version)
				// 收到设备请求后延时 200ms 再回复, 提升传输鲁棒性
				await sleep(200)
				await serialApi.writeData(resp)
				const isResend = sentChunks.has(idx)
				log('发送: ' + bytesToHex(resp.slice(0, 50)) + '... (分片' + idx + ', ' + chunk.length + '字节)' + (isResend ? ' [重发]' : ''), 'info')
				sentChunks.add(idx)
				const done = sentChunks.size
				setProgress(25 + Math.floor(done / totalChunks * 45))
				if (done % 10 === 0 || done === totalChunks) {
					log('已传输 ' + done + '/' + totalChunks + ' 个分片', 'info')
				}
			}
			log('固件传输完成, 共 ' + sentChunks.size + ' 个分片', 'success')
		} catch (e) {
			log('下载过程异常: ' + e.message, 'error')
			return
		}

		// 步骤4: 上报下载结果
		if (stopFlag) return
		try {
			let reportData = pendingMessage
			if (!reportData) reportData = await waitForCode(PCPMessageCode.DOWNLOAD_RESULT, 30000)
			if (!reportData) {
				log('等待下载结果上报超时', 'error')
				return
			}
			const res = PCP.parseDownloadResultReport(reportData)
			const errMap = {
				0x05: '剩余空间不足', 0x06: '下载超时', 0x07: '升级包校验失败',
				0x08: '升级包类型不支持（设备可能不支持差分包，请使用原始包）',
			}
			if (res.downloadStatus !== 0) {
				log('设备下载失败: ' + (errMap[res.downloadStatus] || ('0x' + res.downloadStatus.toString(16))), 'error')
				return
			}
			await serialApi.writeData(PCP.buildDownloadResultAck(0))
			log('设备下载成功', 'success')
			setProgress(80)
		} catch (e) {
			log('下载结果处理异常: ' + e.message, 'error')
			return
		}

		// 步骤5: 执行升级
		if (stopFlag) return
		try {
			await sleep(500)
			await serialApi.writeData(PCP.buildExecuteUpgradeRequest())
			log('已发送升级命令, 设备开始升级...', 'success')
			setProgress(100)
			log('升级完成!', 'success')
		} catch (e) {
			log('执行升级异常: ' + e.message, 'error')
		}
	}

	// 仅等待某一消息码(不自动发送), 带超时, 用于分片请求/下载结果
	function waitForCode(expectCode, timeout) {
		const codes = Array.isArray(expectCode) ? expectCode : [expectCode]
		return new Promise((resolve) => {
			const w = {
				codes,
				resolve,
				timer: setTimeout(() => {
					const idx = waiters.indexOf(w)
					if (idx !== -1) waiters.splice(idx, 1)
					resolve(null)
				}, timeout),
			}
			waiters.push(w)
		})
	}

	function sleep(ms) {
		return new Promise(r => setTimeout(r, ms))
	}

	// 串口打开状态变化时同步按钮
	const syncStartBtn = () => {
		el.start.disabled = !(fw && serialApi.isOpen())
	}

	// 供固件打包工具调用的外部接口
	window.setFwUpgradeFile = function (arrayBuffer, fileName) {
		fw = null
		fwFileBuffer = arrayBuffer
		el.fileName.dataset.name = fileName || 'packed_fw.bin'
		showFileCard(fileName || 'packed_fw.bin', arrayBuffer.byteLength)
		log('已载入固件(来自打包): ' + (fileName || 'packed_fw.bin') + ' (' + fmtSize(arrayBuffer.byteLength) + ')', 'info')
		var parseBtn = document.getElementById('fw-parse')
		if (parseBtn) parseBtn.click()
	}
	// 监听 serialApi 状态: 简单轮询 open 状态变化
	let lastOpen = serialApi.isOpen()
	setInterval(() => {
		const open = serialApi.isOpen()
		if (open !== lastOpen) {
			lastOpen = open
			syncStartBtn()
		}
	}, 500)
})()
