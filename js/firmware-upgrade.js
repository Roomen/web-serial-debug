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
	// 自动升级(原始固件 → 按设备版本在内存里生成差分包或压缩包再升级，不输出中间产物)：js/firmware-core.js 与 js/firmware-library.js
	const Core = window.FirmwareCore
	const library = window.FirmwareLibrary || null
	const diffRunner = Core.createDiffRunner(new URL('firmware-diff-worker.js', document.currentScript.src).href, {
		onDone: function (r) { log('差分计算耗时 ' + Math.round(r.ms) + 'ms, patch ' + fmtSize(r.size), 'info') },
	})

	let fw = null                 // 解析后的固件信息
	let fwFileBuffer = null       // 固件 ArrayBuffer
	let running = false
	let stopFlag = false
	let recvBuffer = []
	let recvOffset = 0

	const el = {
		file: document.getElementById('fw-file'),
		select: document.getElementById('fw-select'),
		fileName: document.getElementById('fw-file-name'),
		fileSize: document.getElementById('fw-file-size'),
		dropZone: document.getElementById('fw-drop-zone'),
		fileCard: document.getElementById('fw-file-card'),
		fileClear: document.getElementById('fw-file-clear'),
		chunkSize: document.getElementById('fw-chunk-size'),
		parseInfo: document.getElementById('fw-parse-info'),
		versionRow: document.getElementById('fw-version-row'),
		version: document.getElementById('fw-version'),
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
		librarySummary: document.getElementById('fw-library-summary'),
		libraryClear: document.getElementById('fw-library-clear'),
	}

	// 只读事件：现代布局的升级流水线(js/modern-firmware.js)据此显示进度、分块与校验，不影响升级流程与时序
	function emit(detail) {
		try { document.dispatchEvent(new CustomEvent('fw-upgrade', { detail: detail })) } catch (e) { /* 事件只供界面使用 */ }
	}
	let lastError = ''
	let outcomeOk = false
	// 本轮设备上报的下载结果码(0x16)，自动升级据此判断差分包被拒后是否改用压缩包
	let lastDownloadStatus = null

	function fmtSize(bytes) {
		if (bytes < 1024) return bytes + ' B'
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
		return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
	}

	// 读取固件信息开关: 关闭后不解析包头, 整个文件当作固件数据, 版本号由用户手填
	function parseInfoEnabled() {
		return el.parseInfo.checked
	}

	// 文件名去扩展名作为默认版本号(版本号字段最长 16 字节)
	// 差分包名形如 "旧版本_时间戳_to_新版本_时间戳", 升级目标是 to 后面那个版本
	function defaultVersionFromName(name) {
		let s = String(name || '').replace(/\.[^.]*$/, '')
		const parts = s.split(/[\s_-]+to[\s_-]+/i)
		if (parts.length > 1) s = parts[parts.length - 1].replace(/_\d+$/, '')
		return s.slice(0, 16)
	}

	function autoInfoText(f) {
		return [
			'文件: ' + (f.fileName || ''),
			'类型: 原始固件 (自动升级)',
			'内嵌版本: ' + f.version,
			'大小: ' + f.rawData.length + ' 字节, CRC32 0x' + f.crc.toString(16).toUpperCase().padStart(8, '0'),
			'',
			'开始升级时先查设备版本：本机固件库里有同版本的原固件就生成差分包，',
			'没有(或同版本有多份不同构建)就生成压缩包；升级包只在内存里生成，不输出文件。',
		].join('\n')
	}

	// 原始固件存进本机固件库，之后设备跑的是它时可以作差分基准
	// 进行中的存库任务：自动升级查库前先等它，免得刚导入的旧固件还没写进去就判成「找不到」
	let librarySaving = Promise.resolve()
	function saveToLibrary(name, data) {
		if (!library) return
		const job = library.add(name, data).then(function (r) {
			if (r && r.evicted) log('固件库已满，淘汰了 ' + r.evicted + ' 份最久未用的固件', 'info')
			refreshLibrarySummary()
		}).catch(function (e) { log('存入固件库失败: ' + (e && e.message || e), 'warn') })
		// 等全部在途的存库，不只最近一次(先导入的那份可能更慢)
		librarySaving = Promise.all([librarySaving, job])
	}

	function refreshLibrarySummary() {
		if (!el.librarySummary) return
		if (!library) { el.librarySummary.textContent = '固件库不可用'; return }
		library.summary().then(function (s) {
			el.librarySummary.textContent = '本机固件库：' + s.count + ' 份' + (s.count ? '（' + fmtSize(s.bytes) + '）' : '')
		}).catch(function () { el.librarySummary.textContent = '固件库不可用' })
	}

	function manualInfoText(name, size, version) {
		return [
			'文件: ' + (name || ''),
			'版本: ' + (version || '(未填写)'),
			'数据大小: ' + size + ' 字节 (不解析包头, 整文件下发)',
		].join('\n')
	}

	// 升级实际使用的版本号: 手动模式取输入框当前值
	function effectiveVersion() {
		return parseInfoEnabled() ? fw.version : el.version.value.trim()
	}

	function applyParseMode() {
		const on = parseInfoEnabled()
		el.versionRow.classList.toggle('d-none', on)
		el.diagnose.disabled = !on
		el.parse.textContent = on ? '解析固件' : '载入固件'
	}

	function showFileCard(name, size) {
		el.dropZone.classList.add('d-none')
		el.fileCard.classList.remove('d-none')
		el.fileName.textContent = name
		el.fileSize.textContent = fmtSize(size)
		emit({ type: 'file-set', name: name, size: size })
	}

	function hideFileCard() {
		el.dropZone.classList.remove('d-none')
		el.fileCard.classList.add('d-none')
		el.fileName.textContent = '未选择固件文件'
		el.fileSize.textContent = '--'
		emit({ type: 'file-clear' })
	}

	function loadFwFile(file) {
		if (!file) return
		el.fileName.dataset.name = file.name
		el.version.value = defaultVersionFromName(file.name)
		const reader = new FileReader()
		reader.onload = function () {
			fwFileBuffer = reader.result
			showFileCard(file.name, file.size)
			log('已载入固件: ' + file.name + ' (' + fmtSize(file.size) + ')', 'info')
			el.parse.click()
		}
		reader.readAsArrayBuffer(file)
	}

	const LOG_MAX_LINES = 3000
	function log(msg, level) {
		const cls = { info: '', success: 'text-success', error: 'text-danger', warn: 'text-warning' }[level || 'info']
		const time = new Date().toLocaleTimeString()
		const line = document.createElement('div')
		line.className = cls
		line.textContent = `[${time}] ${msg}`
		el.log.appendChild(line)
		// 每个分片都记一行，连续升级、设备反复重请求时没有上限就一直涨
		while (el.log.childElementCount > LOG_MAX_LINES) el.log.removeChild(el.log.firstElementChild)
		el.log.scrollTop = el.log.scrollHeight
		if (level === 'error' && running) lastError = msg
		emit({ type: 'log', msg: msg, level: level || 'info' })
	}
	function setProgress(p) {
		p = Math.max(0, Math.min(100, p))
		el.progress.style.width = p + '%'
		el.progress.textContent = p + '%'
		el.progress.setAttribute('aria-valuenow', p)
		emit({ type: 'progress', percent: p })
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
		el.version.value = ''
		el.start.disabled = true
		log('已清除固件文件', 'info')
		emit({ type: 'parsed', ok: false, error: '' })
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
		if (!parseInfoEnabled()) {
			const name = el.fileName.dataset.name
			if (!el.version.value.trim()) el.version.value = defaultVersionFromName(name)
			fw = {
				ok: true,
				raw: true,
				fileName: name,
				firmwareData: new Uint8Array(fwFileBuffer),
				version: el.version.value.trim(),
			}
			el.info.textContent = manualInfoText(name, fw.firmwareData.length, fw.version)
			log('已载入固件(不解析包头), ' + fw.firmwareData.length + ' 字节', 'success')
			emit({ type: 'parsed', ok: true, raw: true, version: fw.version, size: fw.firmwareData.length })
			el.start.disabled = !serialApi.isOpen()
			return
		}
		const bytes = new Uint8Array(fwFileBuffer)
		const kind = Core.classify(bytes)
		if (kind.kind === 'raw') {
			fw = { ok: true, auto: true, fileName: el.fileName.dataset.name, rawData: bytes, version: kind.version, crc: kind.crc }
			el.info.textContent = autoInfoText(fw)
			log('原始固件, 内嵌版本 ' + kind.version + '；开始升级时按设备版本自动差分或压缩', 'success')
			saveToLibrary(fw.fileName, bytes)
			emit({ type: 'parsed', ok: true, raw: false, auto: true, version: kind.version, pkgType: '原始固件（自动差分 / 压缩）', size: bytes.length })
			el.start.disabled = !serialApi.isOpen()
			return
		}
		const r = FirmwareParser.parse(fwFileBuffer)
		if (!r.ok) {
			log('固件解析失败: ' + r.error, 'error')
			emit({ type: 'parsed', ok: false, error: r.error })
			fw = null
			el.start.disabled = true
			return
		}
		r.fileName = el.fileName.dataset.name
		fw = r
		el.info.textContent = FirmwareParser.diagnose(r)
		log('固件解析成功, 版本: ' + r.version, 'success')
		emit({ type: 'parsed', ok: true, raw: false, version: r.version, pkgType: r.pkgTypeName, size: r.firmwareData.length })
		el.start.disabled = !serialApi.isOpen()
	})

	el.diagnose.addEventListener('click', () => {
		if (!fw) {
			el.parse.click()
			if (!fw) return
		}
		if (fw.raw) {
			el.info.textContent = manualInfoText(fw.fileName, fw.firmwareData.length, effectiveVersion())
			return
		}
		if (fw.auto) {
			el.info.textContent = autoInfoText(fw)
			return
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
		emit({ type: 'query-start' })
		try {
			const resp = await sendAndWait(PCP.buildQueryVersionRequest(), PCPMessageCode.QUERY_VERSION, 5000)
			const res = PCP.parseQueryVersionResponse(resp)
			if (res.resultCode !== 0) {
				log('查询版本失败, 结果码 0x' + res.resultCode.toString(16), 'error')
				emit({ type: 'device-version', ok: false, source: 'query', error: '结果码 0x' + res.resultCode.toString(16) })
			} else {
				log('设备当前版本: ' + res.version, 'success')
				emit({ type: 'device-version', ok: true, source: 'query', version: res.version })
			}
		} catch (e) {
			log('查询版本超时: ' + e.message, 'error')
			emit({ type: 'device-version', ok: false, source: 'query', error: '超时' })
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
		el.parseInfo.checked = localStorage.getItem('fwParseInfo') !== '0'
		applyParseMode()
		el.parseInfo.addEventListener('change', function () {
			localStorage.setItem('fwParseInfo', this.checked ? '1' : '0')
			applyParseMode()
			// 模式变了, 已载入的文件要按新模式重新处理
			fw = null
			el.info.textContent = ''
			el.start.disabled = true
			if (fwFileBuffer) el.parse.click()
		})
		el.version.addEventListener('input', function () {
			if (fw && fw.raw) {
				fw.version = this.value.trim()
				el.info.textContent = manualInfoText(fw.fileName, fw.firmwareData.length, fw.version)
			}
		})
	})()

	el.start.addEventListener('click', async () => {
		if (!fw) {
			log(parseInfoEnabled() ? '请先解析固件' : '请先载入固件', 'error')
			return
		}
		if (!serialApi.isOpen()) {
			log('请先打开串口', 'error')
			return
		}
		const ver = effectiveVersion()
		if (!ver) {
			log('请先填写升级版本号', 'error')
			return
		}
		if (new TextEncoder().encode(ver).length > 16) {
			log('版本号超过 16 字节', 'error')
			return
		}
		running = true
		lastError = ''
		outcomeOk = false
		emit({ type: 'start', version: ver, chunkSize: parseInt(el.chunkSize.value) || 128, size: fw.auto ? fw.rawData.length : fw.firmwareData.length })
		stopFlag = false
		window.serialApi.suppressParse = true
		// 升级事务钉扎主发口: 期间切主发口被拦, 下发与 RX 等待稳定在同一设备
		serialApi.pinSession(serialApi.getActiveSendSid())
		el.start.disabled = true
		el.stop.disabled = false
		el.query.disabled = true
		setProgress(0)
		try {
			if (fw.auto) await runAuto(fw)
			else await runUpgrade(fw)
		} finally {
			diffRunner.dispose()
			running = false
			serialApi.unpinSession()
			window.serialApi.suppressParse = false
			el.start.disabled = false
			el.stop.disabled = true
			el.query.disabled = false
			recvBuffer = []
			recvOffset = 0
			emit({ type: 'end', ok: outcomeOk, stopped: stopFlag && !outcomeOk, error: lastError })
		}
	})

	el.stop.addEventListener('click', () => {
		if (!running) return
		stopFlag = true
		log('正在停止升级...', 'warn')
		// 自动升级的准备阶段(查库、取 BLANK、算差分)不经串口，要主动打断：结束在途差分、中止 BLANK 请求、让等待立即返回
		cancelPrepare()
	})

	// ---- 自动升级准备阶段的取消 ----
	// StopError：用户点停止(记为已停止)；断线时 disconnected 为 true(记为失败)
	class StopError extends Error {
		constructor(msg, disconnected) { super(msg); this.disconnected = !!disconnected }
	}
	let prepAbort = null
	let prepStop = null
	let prepWatch = 0
	function beginPrepare() {
		prepAbort = typeof AbortController === 'function' ? new AbortController() : null
		let fire = null
		const p = new Promise(function (resolve, reject) { fire = reject })
		p.catch(function () {})
		prepStop = { promise: p, fire: fire, reason: null }
		// 准备阶段不收发串口，断线不会让任何等待自己结束：盯着连接状态，断了就走同一条取消路径
		prepWatch = setInterval(function () {
			if (!serialApi.isOpen()) cancelPrepare(new StopError('串口已断开', true))
		}, 200)
	}
	// 在途差分由 buildAutoPackage 的 finally 结束 Worker(等待被这里打断后立即走到)
	function cancelPrepare(reason) {
		const r = reason || new StopError('已停止')
		// 先记原因再 abort：被中止的请求先报错时，调用方据此认出这是取消而不是普通失败
		if (prepStop && !prepStop.reason) prepStop.reason = r
		if (prepAbort) prepAbort.abort()
		if (prepStop) prepStop.fire(r)
	}
	function endPrepare() {
		clearInterval(prepWatch)
		prepWatch = 0
		prepAbort = null
		prepStop = null
	}
	function prepInterrupted(e) {
		if (e && e.disconnected) log('串口已断开，自动升级中止', 'error')
	}
	// 等一个准备阶段的异步结果；停止后立即抛 StopError，迟到的结果丢弃
	function untilStopped(promise) {
		if (prepStop && prepStop.reason) return Promise.reject(prepStop.reason)
		if (stopFlag) return Promise.reject(new StopError('已停止'))
		return prepStop ? Promise.race([promise, prepStop.promise]) : promise
	}

	// 累积接收字节, 提取一个完整的 PCP 帧(起始 0xFFFE + 8字节头 + dataLength)
	function tryReadFrame() {
		// 只移动读游标，整批处理完再回收前缀，避免多帧粘包时反复搬移整个数组。
		while (recvBuffer.length - recvOffset >= 8) {
			if (recvBuffer[recvOffset] !== 0xFF || recvBuffer[recvOffset + 1] !== 0xFE) {
				recvOffset++
				continue
			}
			const dataLength = (recvBuffer[recvOffset + 6] << 8) | recvBuffer[recvOffset + 7]
			const total = 8 + dataLength
			if (recvBuffer.length - recvOffset < total) break
			const frame = Uint8Array.from(recvBuffer.slice(recvOffset, recvOffset + total))
			recvOffset += total
			return frame
		}
		return null
	}

	// 常驻接收: 把所有串口原始字节累积进 recvBuffer, 并尝试派发给正在等待的 waiter
	let waiters = []
	serialApi.onReceive((data) => {
		if (!data || !data.length) return
		// 未升级也未查询时，不让普通串口流量进入固件帧解析器。
		if (!running && !waiters.length) { recvBuffer = []; recvOffset = 0; return }
		// 不能用 push(...data)：单次读回可能上万字节，展开成实参会超出调用栈上限抛 RangeError，这块数据就被静默丢掉
		for (let i = 0; i < data.length; i++) recvBuffer.push(data[i])
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
		if (recvOffset) { recvBuffer.splice(0, recvOffset); recvOffset = 0 }
		// PCP 最大帧为 8 + 65535 字节，保留尚未收全的最大帧。
		if (recvBuffer.length > 65543) recvBuffer.splice(0, recvBuffer.length - 65543)
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
			const failWrite = (error) => {
				// 只撤掉这笔等待；若应答/超时已经结束它，迟到的写失败也不影响别的事务。
				const idx = waiters.indexOf(w)
				if (idx === -1) return
				waiters.splice(idx, 1)
				clearTimeout(w.timer)
				reject(error)
			}
			try {
				Promise.resolve(serialApi.writeData(reqBytes)).catch(failWrite)
			} catch (error) {
				failWrite(error)
				return
			}
			log('发送: ' + bytesToHex(reqBytes), 'info')
		})
	}

	function bytesToHex(arr) {
		return Array.from(arr).map(b => ('0' + b.toString(16).toUpperCase()).slice(-2)).join(' ')
	}

	// 自动升级：查设备版本 → 固件库找原固件 → 内存里生成差分包(找到唯一一份)或压缩包 → 照常升级；
	// 设备以「校验失败 / 不支持该包类型」拒收差分包时，应答该结果后改用压缩包重来一次
	async function runAuto(src) {
		let deviceVersion = ''
		try {
			const resp = await sendAndWait(PCP.buildQueryVersionRequest(), PCPMessageCode.QUERY_VERSION, 5000)
			const res = PCP.parseQueryVersionResponse(resp)
			if (res.resultCode !== 0) {
				log('查询版本失败: 0x' + res.resultCode.toString(16), 'error')
				return
			}
			deviceVersion = res.version
			log('设备当前版本: ' + deviceVersion, 'success')
			emit({ type: 'device-version', ok: true, source: 'upgrade', version: deviceVersion })
		} catch (e) {
			log('查询版本超时: ' + e.message, 'error')
			return
		}
		if (stopFlag) return
		beginPrepare()
		let plan = null
		let pkg = null
		try {
			let candidates = []
			if (library) {
				try {
					await untilStopped(librarySaving)
					candidates = await untilStopped(library.findByVersion(deviceVersion))
				} catch (e) {
					if (e instanceof StopError) throw e
					log('读取固件库失败，改用压缩包: ' + (e && e.message || e), 'warn')
				}
			}
			plan = Core.planUpgrade({ deviceVersion, candidates })
			const why = { 'no-device-version': '设备没有上报版本', 'not-found': '本机固件库里没有 ' + deviceVersion + ' 的原固件', 'ambiguous': '固件库里 ' + deviceVersion + ' 有 ' + plan.count + ' 份不同构建，无法确定设备上是哪一份' }
			if (plan.mode === 'diff') log('在固件库找到原固件 ' + (plan.base.name || deviceVersion) + '，生成差分包', 'info')
			else log((why[plan.reason] || '') + '，生成压缩包', 'info')
			pkg = await buildAutoPackage(plan, src)
		} catch (e) {
			if (!(e instanceof StopError)) throw e
			prepInterrupted(e)
			return
		} finally {
			endPrepare()
		}
		if (!pkg || stopFlag) return
		await runUpgrade(pkg)
		if (!outcomeOk && !stopFlag && Core.shouldFallbackToCompress(plan.mode, lastDownloadStatus)) {
			log('设备拒收差分包，改用压缩包重新升级', 'warn')
			// 先应答这次失败的下载结果，设备收尾后才接新一轮通知；应答都发不出去就不再重来
			try {
				await serialApi.writeData(PCP.buildDownloadResultAck(0))
			} catch (e) {
				log('应答下载结果失败，不再重试: ' + (e && e.message || e), 'error')
				return
			}
			lastError = ''
			emit({ type: 'retry', reason: 'diff-rejected', status: lastDownloadStatus })
			// 之后成功的是压缩包：被拒的差分基准不能记成「最近用过」
			plan = { mode: 'compress', reason: 'device-rejected' }
			beginPrepare()
			try {
				pkg = await buildAutoPackage(plan, src)
			} catch (e) {
				if (!(e instanceof StopError)) throw e
				prepInterrupted(e)
				return
			} finally {
				endPrepare()
			}
			if (!pkg || stopFlag) return
			await runUpgrade(pkg)
		}
		if (outcomeOk && plan.mode === 'diff' && library) library.touch(plan.base.key).catch(function () {})
	}

	let blankData = null
	async function loadBlank() {
		if (blankData) return blankData
		try {
			// 取不到就用内置默认值；给个超时，网络挂住也不拖住升级
			const timer = setTimeout(function () { if (prepAbort) prepAbort.abort() }, 5000)
			try {
				const r = await untilStopped(fetch('imgs/BLANK.BIN', prepAbort ? { signal: prepAbort.signal } : undefined))
				if (!r.ok) throw new Error('HTTP ' + r.status)
				blankData = new Uint8Array(await untilStopped(r.arrayBuffer()))
			} finally {
				clearTimeout(timer)
			}
		} catch (e) {
			if (e instanceof StopError) throw e
			if (prepStop && prepStop.reason) throw prepStop.reason
			if (stopFlag) throw new StopError('已停止')
			blankData = Core.BLANK_BUILTIN
		}
		return blankData
	}

	// 生成并解析一个内存里的升级包；失败记日志返回 null，停止抛 StopError。生成完立即释放差分 Worker(WASM 内存)，不留到传输结束
	async function buildAutoPackage(plan, src) {
		const type = plan.mode === 'diff' ? 'diff' : 'compress'
		const label = type === 'diff' ? '差分包' : '压缩包'
		try {
			const base = type === 'diff' ? plan.base.data : await loadBlank()
			if (stopFlag) throw new StopError('已停止')
			const data = await untilStopped(Core.buildPackage(type, src.rawData, base, diffRunner.createPatch))
			if (stopFlag) throw new StopError('已停止')
			const r = FirmwareParser.parse(data.buffer)
			if (!r.ok) {
				log('生成的升级包校验失败: ' + r.error, 'error')
				return null
			}
			if (r.version !== src.version) {
				log('生成的升级包版本(' + (r.version || '空') + ')与原始固件(' + src.version + ')不一致', 'error')
				return null
			}
			r.fileName = src.fileName
			log(label + '已生成: ' + fmtSize(data.length) + '（原始固件 ' + fmtSize(src.rawData.length) + '）', 'success')
			return r
		} catch (e) {
			if (e instanceof StopError) throw e
			if (prepStop && prepStop.reason) throw prepStop.reason
			if (stopFlag) throw new StopError('已停止')
			log(label + '生成失败: ' + (e && e.message || e), 'error')
			return null
		} finally {
			diffRunner.dispose()
		}
	}

	async function runUpgrade(target) {
		const chunkSize = parseInt(el.chunkSize.value) || 128
		const firmwareData = target.firmwareData
		const totalChunks = Math.ceil(firmwareData.length / chunkSize)
		// 手动模式(不读包头)取输入框里的版本，其余取包头里的版本
		const version = target.raw ? el.version.value.trim() : target.version
		lastDownloadStatus = null
		log('开始固件升级, 版本: ' + version + ', 分片: ' + totalChunks, 'info')
		emit({ type: 'plan', version: version, chunkSize: chunkSize, totalChunks: totalChunks, size: firmwareData.length })

		// 步骤1: 查询设备版本
		if (stopFlag) return
		emit({ type: 'phase', name: 'query' })
		try {
			const resp = await sendAndWait(PCP.buildQueryVersionRequest(), PCPMessageCode.QUERY_VERSION, 5000)
			const res = PCP.parseQueryVersionResponse(resp)
			if (res.resultCode !== 0) {
				log('查询版本失败: 0x' + res.resultCode.toString(16), 'error')
				return
			}
			log('设备当前版本: ' + res.version, 'success')
			emit({ type: 'device-version', ok: true, source: 'upgrade', version: res.version })
			setProgress(15)
		} catch (e) {
			log('查询版本超时: ' + e.message, 'error')
			return
		}

		// 步骤2: 通知新版本
		if (stopFlag) return
		emit({ type: 'phase', name: 'notify' })
		try {
			const resp = await sendAndWait(
				PCP.buildNewVersionNotify(version, chunkSize, totalChunks),
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
		emit({ type: 'phase', name: 'transfer' })
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
				emit({ type: 'request', index: idx, resend: sentChunks.has(idx), total: totalChunks })
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
				const resp = PCP.buildDownloadResponse(idx, chunk, version)
				// 收到设备请求后延时 200ms 再回复, 提升传输鲁棒性
				await sleep(200)
				await serialApi.writeData(resp)
				const isResend = sentChunks.has(idx)
				log('发送: ' + bytesToHex(resp.slice(0, 50)) + '... (分片' + idx + ', ' + chunk.length + '字节)' + (isResend ? ' [重发]' : ''), 'info')
				sentChunks.add(idx)
				const done = sentChunks.size
				emit({ type: 'chunk', index: idx, resend: isResend, sent: done, total: totalChunks, bytes: chunk.length })
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
		emit({ type: 'phase', name: 'result' })
		try {
			let reportData = pendingMessage
			if (!reportData) reportData = await waitForCode(PCPMessageCode.DOWNLOAD_RESULT, 30000)
			if (!reportData) {
				log('等待下载结果上报超时', 'error')
				return
			}
			const res = PCP.parseDownloadResultReport(reportData)
			lastDownloadStatus = res.downloadStatus
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
		emit({ type: 'phase', name: 'execute' })
		try {
			await sleep(500)
			await serialApi.writeData(PCP.buildExecuteUpgradeRequest())
			log('已发送升级命令, 设备开始升级...', 'success')
			setProgress(100)
			log('升级完成!', 'success')
			outcomeOk = true
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
		el.version.value = defaultVersionFromName(fileName || 'packed_fw.bin')
		showFileCard(fileName || 'packed_fw.bin', arrayBuffer.byteLength)
		log('已载入固件(来自打包): ' + (fileName || 'packed_fw.bin') + ' (' + fmtSize(arrayBuffer.byteLength) + ')', 'info')
		var parseBtn = document.getElementById('fw-parse')
		if (parseBtn) parseBtn.click()
	}
	if (el.libraryClear) {
		el.libraryClear.addEventListener('click', function () {
			if (!library) return
			if (!window.confirm('清空本机固件库？之后找不到原固件时只能用压缩包升级。')) return
			library.clear().then(function () {
				log('已清空本机固件库', 'info')
				refreshLibrarySummary()
			}).catch(function (e) { log('清空固件库失败: ' + (e && e.message || e), 'error') })
		})
	}
	refreshLibrarySummary()

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
