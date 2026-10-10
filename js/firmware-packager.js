;(function () {
	'use strict'

	const HEADER_SIZE = 128
	const MAGIC_NUM = 0x6b636553

	function crc32(data) {
		let crc = 0xFFFFFFFF
		const len = data.length
		for (let i = 0; i < len; i++) {
			crc ^= data[i]
			for (let j = 0; j < 8; j++) {
				crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
			}
		}
		return (crc ^ 0xFFFFFFFF) >>> 0
	}

	function parseFirmwareName(fileName) {
		const name = fileName.replace(/\.[^.]+$/, '')
		const parts = name.split('_')
		const version = parts.length > 0 && parts[0] ? parts[0] : 'Ver'
		const timestamp = parts.length > 1 && parts[1] ? parts[1] : '0'
		return { version, timestamp }
	}

	function toBytesLE(value, byteLength) {
		const bytes = new Uint8Array(byteLength)
		for (let i = 0; i < byteLength; i++) {
			bytes[i] = (value >>> (i * 8)) & 0xFF
		}
		return bytes
	}

	function buildHeader(info) {
		const body = new Uint8Array(124)

		let off = 0
		const setU32 = (v) => { body.set(toBytesLE(v, 4), off); off += 4 }
		const skipU32 = () => { off += 4 }

		setU32(MAGIC_NUM)
		setU32(info.pkgHeaderVersion || 0)
		setU32(info.pkgType)
		setU32(info.pkgEncType || 0)
		setU32(info.pkgDataSize)
		skipU32()
		setU32(info.patchFileSize)
		setU32(info.oldFileSize || 0)
		skipU32()
		setU32(info.newFileSize)
		skipU32()

		off = 11 * 4

		if (info.newFileInfo) {
			body.set(info.newFileInfo.slice(0, 32), off)
		}
		off += 32

		if (info.userDefine) {
			const enc = new TextEncoder()
			const ud = enc.encode(info.userDefine)
			body.set(ud.slice(0, 48), off)
		}
		off += 48

		const pkgDataCRC32 = crc32(info.pkgData)
		const newFileCRC32 = crc32(info.newFileData)
		const oldFileCRC32 = info.oldFileData ? crc32(info.oldFileData) : 0

		toBytesLE(pkgDataCRC32, 4).forEach((b, i) => { body[5 * 4 + i] = b })
		toBytesLE(oldFileCRC32, 4).forEach((b, i) => { body[8 * 4 + i] = b })
		toBytesLE(newFileCRC32, 4).forEach((b, i) => { body[10 * 4 + i] = b })

		const headerCRC32 = crc32(body)
		const result = new Uint8Array(HEADER_SIZE)
		result.set(body)
		result.set(toBytesLE(headerCRC32, 4), 124)
		return result
	}

	function getNewFileInfo(data) {
		const info = new Uint8Array(32)
		if (data.length > 0x4020) {
			info.set(data.subarray(0x4000, 0x4020))
		}
		return info
	}

	function packFirmware({ firmwareData, pkgType, userDefine, oldFileData, newFileData }) {
		return buildHeader({
			pkgType: pkgType,
			pkgData: firmwareData,
			pkgDataSize: firmwareData.length,
			patchFileSize: firmwareData.length,
			oldFileData: oldFileData || null,
			oldFileSize: oldFileData ? oldFileData.length : 0,
			newFileData: newFileData || firmwareData,
			newFileSize: (newFileData || firmwareData).length,
			newFileInfo: getNewFileInfo(newFileData || firmwareData),
			userDefine: userDefine || '',
		})
	}

	function downloadBlob(data, fileName) {
		const blob = new Blob([data], { type: 'application/octet-stream' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = fileName
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
	}

	// ---- 输出目录保存 (File System Access API), 避免每个文件都弹保存对话框 ----
	const fsSaveSupported = typeof window.showDirectoryPicker === 'function'
	let fwDirHandle = null

	function idbOpen() {
		return new Promise(function (resolve, reject) {
			const req = indexedDB.open('fw-packager', 1)
			req.onupgradeneeded = function () { req.result.createObjectStore('kv') }
			req.onsuccess = function () { resolve(req.result) }
			req.onerror = function () { reject(req.error) }
		})
	}

	function idbSet(key, val) {
		return idbOpen().then(function (db) {
			return new Promise(function (resolve, reject) {
				const tx = db.transaction('kv', 'readwrite')
				tx.objectStore('kv').put(val, key)
				tx.oncomplete = function () { db.close(); resolve() }
				tx.onerror = function () { db.close(); reject(tx.error) }
			})
		})
	}

	function idbGet(key) {
		return idbOpen().then(function (db) {
			return new Promise(function (resolve, reject) {
				const req = db.transaction('kv', 'readonly').objectStore('kv').get(key)
				req.onsuccess = function () { db.close(); resolve(req.result) }
				req.onerror = function () { db.close(); reject(req.error) }
			})
		})
	}

	// 恢复上次选择的输出目录(权限在下次点击时重新请求)
	;(function () {
		if (!fsSaveSupported) return
		idbGet('dirHandle').then(function (h) { if (h) fwDirHandle = h }).catch(function () {})
	})()

	// 需在用户手势有效期内调用; 返回 null 表示不支持, 抛出 AbortError 表示用户取消
	async function ensureDirHandle() {
		if (fwDirHandle) {
			if ((await fwDirHandle.queryPermission({ mode: 'readwrite' })) === 'granted') return fwDirHandle
			if ((await fwDirHandle.requestPermission({ mode: 'readwrite' })) === 'granted') return fwDirHandle
		}
		fwDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
		try { await idbSet('dirHandle', fwDirHandle) } catch (e) {}
		return fwDirHandle
	}

	async function writeToDir(dirHandle, name, data) {
		const fh = await dirHandle.getFileHandle(name, { create: true })
		const w = await fh.createWritable()
		await w.write(data)
		await w.close()
	}

	// 只读事件：现代布局的升级流水线(js/modern-firmware.js)据此显示选文件、生成结果与错误，不影响打包流程
	function emit(detail) {
		try { document.dispatchEvent(new CustomEvent('fw-pack', { detail: detail })) } catch (e) { /* 事件只供界面使用 */ }
	}

	function fmtSize(bytes) {
		if (bytes < 1024) return bytes + ' B'
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
		return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
	}

	window.FirmwarePackager = {
		crc32, parseFirmwareName, buildHeader, getNewFileInfo,
		packFirmware, downloadBlob, HEADER_SIZE,
	}

	// ---- UI bindings ----
	const el = {
		oldFile:     document.getElementById('fp-old-file'),
		oldSelect:   document.getElementById('fp-old-select'),
		oldName:     document.getElementById('fp-old-name'),
		oldSize:     document.getElementById('fp-old-size'),
		oldZone:     document.getElementById('fp-old-zone'),
		oldInfo:     document.getElementById('fp-old-info'),
		oldClear:    document.getElementById('fp-old-clear'),
		oldDrop:     document.getElementById('fp-drop-old'),
		newFile:     document.getElementById('fp-new-file'),
		newSelect:   document.getElementById('fp-new-select'),
		newName:     document.getElementById('fp-new-name'),
		newSize:     document.getElementById('fp-new-size'),
		newZone:     document.getElementById('fp-new-zone'),
		newInfo:     document.getElementById('fp-new-info'),
		newClear:    document.getElementById('fp-new-clear'),
		newDrop:     document.getElementById('fp-drop-new'),
		blankFile:   document.getElementById('fp-blank-file'),
		blankSelect: document.getElementById('fp-blank-select'),
		blankName:   document.getElementById('fp-blank-name'),
		userDefine:  document.getElementById('fp-user-define'),
		genOrigin:   document.getElementById('fp-gen-origin'),
		genCompress: document.getElementById('fp-gen-compress'),
		genDiff:     document.getElementById('fp-gen-diff'),
		genZip:      document.getElementById('fp-gen-zip'),
		blankRow:    document.getElementById('fp-blank-row'),
		start:       document.getElementById('fp-start'),
		log:         document.getElementById('fp-log'),
		logClear:    document.getElementById('fp-log-clear'),
	}

	window._fwPackOutputs = []

	const PACK_LOG_MAX_LINES = 2000
	function trimPackLog() {
		while (el.log.childElementCount > PACK_LOG_MAX_LINES) el.log.removeChild(el.log.firstElementChild)
	}

	function logUpgradeBtn(name, data, index) {
		const line = document.createElement('div')
		line.className = 'fw-log-upgrade-row'
		const button = document.createElement('button')
		button.type = 'button'
		button.className = 'fw-log-upgrade-btn'
		button.dataset.fwIdx = index

		const icon = document.createElement('i')
		icon.className = 'bi bi-arrow-right-circle'
		const buttonText = document.createElement('span')
		buttonText.textContent = '使用此固件进行串口升级'
		button.append(icon, buttonText)

		const fileName = document.createElement('span')
		fileName.className = 'fw-log-upgrade-name'
		fileName.textContent = name
		line.append(button, fileName)
		el.log.appendChild(line)
		trimPackLog()
		el.log.scrollTop = el.log.scrollHeight
	}

	// 新一轮生成开始时释放上一轮的产物：每份都是整包拷贝，一直留着内存会随生成次数增长。
	// 旧按钮置灰并去掉下标，新一轮 start 事件同步重置现代产物列表；已交给升级面板的那份由升级面板自己持有
	function releaseOutputs() {
		const list = window._fwPackOutputs
		list.length = 0
		el.log.querySelectorAll('.fw-log-upgrade-btn').forEach(function (b) {
			b.disabled = true
			delete b.dataset.fwIdx
			b.title = '已开始新一轮生成，这份产物已释放'
		})
	}

	function navToFwUpgrade(data, name, kind) {
		var buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
		window._fwPackOutputs.push({ name: name, buffer: buf })
		var idx = window._fwPackOutputs.length - 1
		logUpgradeBtn(name, data, idx)
		emit({ type: 'output', idx: idx, name: name, size: data.length, kind: kind || '' })
	}

	if (el.log) {
		el.log.addEventListener('click', function (e) {
			var btn = e.target.closest('.fw-log-upgrade-btn')
			if (!btn || btn.disabled) return
			var idx = parseInt(btn.getAttribute('data-fw-idx'), 10)
			var item = window._fwPackOutputs[idx]
			if (!item || !item.buffer) return
			if (window.Workbench) window.Workbench.open('firmware')
			if (window.setFwUpgradeFile) {
				window.setFwUpgradeFile(item.buffer, item.name)
			}
		})
	}

	const oldFw = { val: null }
	const oldFwName = { val: '' }
	const newFw = { val: null }
	const newFwName = { val: '' }
	const blank = { val: null }
	const blankNameVal = { val: '' }

	let diffWorker = null
	let diffJob = null
	let packRunning = false
	const diffWorkerUrl = new URL('firmware-diff-worker.js', document.currentScript.src).href

	function log(msg, level) {
		const cls = { info: '', success: 'text-success', error: 'text-danger', warn: 'text-warning' }[level || 'info']
		const time = new Date().toLocaleTimeString()
		const line = document.createElement('div')
		line.className = cls
		line.textContent = '[' + time + '] ' + msg
		el.log.appendChild(line)
		trimPackLog()
		el.log.scrollTop = el.log.scrollHeight
		emit({ type: 'log', msg: msg, level: level || 'info' })
	}

	function showFileInfo(zoneEl, infoEl, nameEl, sizeEl, size) {
		if (zoneEl) zoneEl.classList.add('d-none')
		if (infoEl) infoEl.classList.remove('d-none')
		if (sizeEl) sizeEl.textContent = fmtSize(size)
	}

	function hideFileInfo(zoneEl, infoEl, nameEl, sizeEl) {
		if (zoneEl) zoneEl.classList.remove('d-none')
		if (infoEl) infoEl.classList.add('d-none')
		if (nameEl) nameEl.textContent = '--'
		if (sizeEl) sizeEl.textContent = '--'
	}

	function loadFile(file, nameEl, sizeEl, bufferHolder, fileNameHolder, zoneEl, infoEl) {
		if (!file) return
		nameEl.textContent = file.name
		const reader = new FileReader()
		reader.onload = function () {
			bufferHolder.val = new Uint8Array(reader.result)
			fileNameHolder.val = file.name
			showFileInfo(zoneEl, infoEl, nameEl, sizeEl, reader.result.byteLength)
			emit({ type: 'file', which: bufferHolder === oldFw ? 'old' : (bufferHolder === newFw ? 'new' : 'blank'), name: file.name, size: reader.result.byteLength, data: bufferHolder.val })
			log('已载入 ' + file.name + ' (' + fmtSize(reader.result.byteLength) + ')', 'info')
		}
		reader.readAsArrayBuffer(file)
	}

	function setupDropZone(dropCard, zoneEl, fileInput, bufferHolder, fileNameHolder, nameEl, sizeEl, infoEl) {
		function preventDefaults(e) { e.preventDefault(); e.stopPropagation() }

		var dropJustHappened = false

		;['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (evt) {
			dropCard.addEventListener(evt, preventDefaults, false)
		})

		;['dragenter', 'dragover'].forEach(function (evt) {
			dropCard.addEventListener(evt, function () {
				zoneEl.classList.add('drag-over')
			}, false)
		})

		;['dragleave', 'drop'].forEach(function (evt) {
			dropCard.addEventListener(evt, function () {
				zoneEl.classList.remove('drag-over')
			}, false)
		})

		dropCard.addEventListener('drop', function (e) {
			dropJustHappened = true
			setTimeout(function () { dropJustHappened = false }, 100)
			const files = e.dataTransfer.files
			if (files.length > 0) {
				loadFile(files[0], nameEl, sizeEl, bufferHolder, fileNameHolder, zoneEl, infoEl)
			}
		}, false)

		zoneEl.addEventListener('click', function () {
			if (dropJustHappened) return
			fileInput.click()
		})
	}

	setupDropZone(el.newDrop, el.newZone, el.newFile, newFw, newFwName, el.newName, el.newSize, el.newInfo)
	setupDropZone(el.oldDrop, el.oldZone, el.oldFile, oldFw, oldFwName, el.oldName, el.oldSize, el.oldInfo)

	el.oldSelect.addEventListener('click', function (e) { e.stopPropagation(); el.oldFile.click() })
	el.newSelect.addEventListener('click', function (e) { e.stopPropagation(); el.newFile.click() })
	el.blankSelect.addEventListener('click', function () { el.blankFile.click() })

	el.oldClear.addEventListener('click', function (e) {
		e.stopPropagation()
		oldFw.val = null
		oldFwName.val = ''
		hideFileInfo(el.oldZone, el.oldInfo, el.oldName, el.oldSize)
		el.oldFile.value = ''
		log('已清除旧固件', 'info')
		emit({ type: 'file', which: 'old', name: '', size: 0, data: null })
	})
	el.newClear.addEventListener('click', function (e) {
		e.stopPropagation()
		newFw.val = null
		newFwName.val = ''
		hideFileInfo(el.newZone, el.newInfo, el.newName, el.newSize)
		el.newFile.value = ''
		log('已清除新固件', 'info')
		emit({ type: 'file', which: 'new', name: '', size: 0, data: null })
	})

	el.oldFile.addEventListener('change', function () {
		loadFile(this.files[0], el.oldName, el.oldSize, oldFw, oldFwName, el.oldZone, el.oldInfo)
	})
	el.newFile.addEventListener('change', function () {
		loadFile(this.files[0], el.newName, el.newSize, newFw, newFwName, el.newZone, el.newInfo)
	})
	el.blankFile.addEventListener('change', function () {
		loadFile(this.files[0], el.blankName, null, blank, blankNameVal, null, null)
	})

	el.genCompress.addEventListener('change', function () {
		el.blankRow.style.display = this.checked ? '' : 'none'
		savePackOptions()
	})

	el.genOrigin.addEventListener('change', savePackOptions)
	el.genDiff.addEventListener('change', savePackOptions)
	el.genZip.addEventListener('change', savePackOptions)
	el.userDefine.addEventListener('input', savePackOptions)

	function savePackOptions() {
		var opts = {
			genOrigin: el.genOrigin.checked,
			genCompress: el.genCompress.checked,
			genDiff: el.genDiff.checked,
			genZip: el.genZip.checked,
			userDefine: el.userDefine.value,
		}
		localStorage.setItem('fwPackOptions', JSON.stringify(opts))
	}

	// 恢复打包选项
	;(function () {
		var raw = localStorage.getItem('fwPackOptions')
		if (!raw) return
		try {
			var opts = JSON.parse(raw)
			if (typeof opts.genOrigin === 'boolean') el.genOrigin.checked = opts.genOrigin
			if (typeof opts.genCompress === 'boolean') el.genCompress.checked = opts.genCompress
			if (typeof opts.genDiff === 'boolean') el.genDiff.checked = opts.genDiff
			if (typeof opts.genZip === 'boolean') el.genZip.checked = opts.genZip
			if (typeof opts.userDefine === 'string') el.userDefine.value = opts.userDefine
			el.blankRow.style.display = el.genCompress.checked ? '' : 'none'
		} catch (e) {}
	})()

	el.logClear.addEventListener('click', function () {
		el.log.innerHTML = ''
	})

	// 按需创建差分 Worker，整轮生成结束即释放其 WASM 内存；不在串口页预载。
	function disposeDiffWorker(error) {
		if (diffWorker) diffWorker.terminate()
		diffWorker = null
		if (diffJob) {
			clearTimeout(diffJob.timer)
			const job = diffJob
			diffJob = null
			job.reject(error || new Error('差分任务已结束'))
		}
	}

	function wasmCreatePatch(oldData, newData) {
		return new Promise(function (resolve, reject) {
			if (diffJob) { reject(new Error('差分任务正在执行')); return }
			try {
				if (!diffWorker) {
					diffWorker = new Worker(diffWorkerUrl)
					diffWorker.onmessage = function (e) {
						const job = diffJob
						if (!job) return
						clearTimeout(job.timer)
						diffJob = null
						if (e.data.error) job.reject(new Error(e.data.error))
						else {
							const patch = new Uint8Array(e.data.patch)
							log('hdiffi 差分耗时: ' + Math.round(e.data.ms) + 'ms, patch: ' + fmtSize(patch.length), 'info')
							job.resolve(patch)
						}
					}
					diffWorker.onerror = function () { disposeDiffWorker(new Error('差分 Worker 加载或执行失败')) }
					diffWorker.onmessageerror = function () { disposeDiffWorker(new Error('差分 Worker 数据传输失败')) }
				}
				// 输入保留给组包 CRC 和反向差分；只转移本任务的副本。
				const oldCopy = oldData.slice()
				const newCopy = newData.slice()
				diffJob = { resolve: resolve, reject: reject, timer: setTimeout(function () {
					disposeDiffWorker(new Error('差分生成超时'))
				}, 5 * 60 * 1000) }
				diffWorker.postMessage({ old: oldCopy.buffer, nw: newCopy.buffer }, [oldCopy.buffer, newCopy.buffer])
			} catch (e) {
				if (diffJob) disposeDiffWorker(e)
				else reject(e)
			}
		})
	}

	el.start.addEventListener('click', async function () {
		if (packRunning) return
		if (!newFw.val) {
			log('请先选择新固件', 'error')
			return
		}

		const genOrigin = el.genOrigin.checked
		const genCompress = el.genCompress.checked
		const genDiff = el.genDiff.checked

		if (!genOrigin && !genCompress && !genDiff) {
			log('请至少选择一种输出类型', 'error')
			return
		}

		packRunning = true
		el.start.disabled = true
		try {
			// 固件选择可以在 await 期间变化，整轮使用同一份快照。
			const newData = newFw.val
			const oldData = oldFw.val
			const blankData = blank.val
			const oldName = oldFwName.val
			const newInfo = parseFirmwareName(newFwName.val)
			const userDefine = el.userDefine.value || ''
			const useZip = el.genZip.checked
			const zipFiles = []
			const newFwCRC32 = crc32(newData).toString(16).toUpperCase().padStart(8, '0')
			releaseOutputs()
			emit({ type: 'start' })

			// 在首个 await 前(点击手势有效期内)获取输出目录, 之后所有文件静默写入同一目录
			let dirHandle = null
			if (fsSaveSupported) {
				try {
					dirHandle = await ensureDirHandle()
					log('输出目录: ' + dirHandle.name + '/', 'info')
				} catch (e) {
					if (e && e.name === 'AbortError') {
						log('未选择输出目录, 已取消生成', 'warn')
						emit({ type: 'end', aborted: true })
						return
					}
					log('输出目录不可用, 将使用浏览器下载: ' + e.message, 'warn')
				}
			}

			async function outputFile(name, data, logMsg, level) {
				if (useZip) {
					zipFiles.push({ name: name, data: data })
				} else if (dirHandle) {
					try {
						await writeToDir(dirHandle, name, data)
						logMsg += ' | 已保存到 ' + dirHandle.name + '/'
					} catch (e) {
						downloadBlob(data, name)
						logMsg += ' | 目录写入失败, 已转为浏览器下载'
						level = 'warn'
					}
				} else {
					downloadBlob(data, name)
				}
				log(logMsg, level)
			}

			try {
				if (genOrigin) {
					const header = packFirmware({
						firmwareData: newData,
						pkgType: 1,
						userDefine: userDefine,
					})
					const full = new Uint8Array(header.length + newData.length)
					full.set(header)
					full.set(newData, header.length)
					const outName = newInfo.version + '_' + newInfo.timestamp + '_Origin.bin'
					await outputFile(outName, full,
						'原始包: ' + outName + ' | 大小: ' + fmtSize(full.length) + ' | 固件CRC32: ' + newFwCRC32, 'success')
					navToFwUpgrade(full, outName, 'origin')
				}

				if (genCompress) {
					if (!blankData) {
						log('压缩包需要 BLANK.bin, 请选择 BLANK 文件', 'error')
					} else {
						try {
							const patch = await wasmCreatePatch(blankData, newData)
							const header = packFirmware({
								firmwareData: patch,
								pkgType: 2,
								userDefine: userDefine,
								oldFileData: blankData,
								newFileData: newData,
							})
							const full = new Uint8Array(header.length + patch.length)
							full.set(header)
							full.set(patch, header.length)
							const outName = newInfo.version + '_' + newInfo.timestamp + '_comp.bin'
							await outputFile(outName, full,
								'压缩包: ' + outName + ' | 大小: ' + fmtSize(full.length) + ' (patch: ' + fmtSize(patch.length) + ')', 'success')
							navToFwUpgrade(full, outName, 'compress')
						} catch (e) {
							log('压缩包生成失败: ' + e.message, 'error')
						}
					}
				}

				if (genDiff) {
					if (!oldData) {
						log('差分包需要旧固件, 请先选择旧固件', 'error')
					} else {
						const oldInfo = parseFirmwareName(oldName)

						try {
							const patchA = await wasmCreatePatch(oldData, newData)
							const headerA = packFirmware({
								firmwareData: patchA,
								pkgType: 3,
								userDefine: userDefine,
								oldFileData: oldData,
								newFileData: newData,
							})
							const fullA = new Uint8Array(headerA.length + patchA.length)
							fullA.set(headerA)
							fullA.set(patchA, headerA.length)
							const outA = oldInfo.version + '_' + oldInfo.timestamp + '_to_' + newInfo.version + '_' + newInfo.timestamp + '.bin'
							await outputFile(outA, fullA,
								'差分包(旧→新): ' + outA + ' | 大小: ' + fmtSize(fullA.length) + ' | patch: ' + fmtSize(patchA.length), 'success')
							navToFwUpgrade(fullA, outA, 'diff-fwd')
						} catch (e) {
							log('差分包(旧→新)失败: ' + e.message, 'error')
						}

						try {
							const patchB = await wasmCreatePatch(newData, oldData)
							const headerB = packFirmware({
								firmwareData: patchB,
								pkgType: 3,
								userDefine: userDefine,
								oldFileData: newData,
								newFileData: oldData,
							})
							const fullB = new Uint8Array(headerB.length + patchB.length)
							fullB.set(headerB)
							fullB.set(patchB, headerB.length)
							const outB = newInfo.version + '_' + newInfo.timestamp + '_to_' + oldInfo.version + '_' + oldInfo.timestamp + '.bin'
							await outputFile(outB, fullB,
								'差分包(新→旧): ' + outB + ' | 大小: ' + fmtSize(fullB.length) + ' | patch: ' + fmtSize(patchB.length), 'success')
							navToFwUpgrade(fullB, outB, 'diff-rev')
						} catch (e) {
							log('差分包(新→旧)失败: ' + e.message, 'error')
						}
					}
				}

				if (useZip && zipFiles.length > 0) {
					const zip = new JSZip()
					for (const f of zipFiles) {
						zip.file(f.name, f.data)
					}
					const blob = await zip.generateAsync({ type: 'blob' })
					const zipName = newInfo.version + '_' + newInfo.timestamp + '_pack.zip'
					if (dirHandle) {
						try {
							await writeToDir(dirHandle, zipName, blob)
							log('打包保存: ' + dirHandle.name + '/' + zipName + ' (' + fmtSize(blob.size) + ', 含 ' + zipFiles.length + ' 个文件)', 'success')
							emit({ type: 'zip', name: zipName, size: blob.size, count: zipFiles.length })
						} catch (e) {
							downloadBlob(blob, zipName)
							log('打包下载: ' + zipName + ' (目录写入失败, 已转为浏览器下载)', 'warn')
							emit({ type: 'zip', name: zipName, size: blob.size, count: zipFiles.length })
						}
					} else {
						downloadBlob(blob, zipName)
						log('打包下载: ' + zipName + ' (' + fmtSize(blob.size) + ', 含 ' + zipFiles.length + ' 个文件)', 'success')
						emit({ type: 'zip', name: zipName, size: blob.size, count: zipFiles.length })
					}
				}
			} catch (e) {
				log('打包异常: ' + e.message, 'error')
			}
			emit({ type: 'end' })
		} finally {
			disposeDiffWorker()
			packRunning = false
			el.start.disabled = false
		}
	})

	// 内置 BLANK.BIN — 优先 fetch，失败则使用内嵌默认值
	var blankBuiltin = new Uint8Array([
		0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,
		0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,
		0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff
	])

	// 先用内嵌默认，fetch 成功后再覆盖
	blank.val = blankBuiltin

	fetch('imgs/BLANK.BIN')
		.then(function (r) {
			if (!r.ok) throw new Error('HTTP ' + r.status)
			return r.arrayBuffer()
		})
		.then(function (buf) {
			blank.val = new Uint8Array(buf)
			if (el.blankName) el.blankName.textContent = '内置 BLANK.BIN (' + fmtSize(buf.byteLength) + ')'
			log('已加载 BLANK.BIN (' + fmtSize(buf.byteLength) + ')', 'info')
		})
		.catch(function () {})
})()
