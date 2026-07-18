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
				tx.oncomplete = function () { resolve() }
				tx.onerror = function () { reject(tx.error) }
			})
		})
	}

	function idbGet(key) {
		return idbOpen().then(function (db) {
			return new Promise(function (resolve, reject) {
				const req = db.transaction('kv', 'readonly').objectStore('kv').get(key)
				req.onsuccess = function () { resolve(req.result) }
				req.onerror = function () { reject(req.error) }
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

	function logUpgradeBtn(name, data, index) {
		const line = document.createElement('div')
		line.className = 'fw-log-upgrade-row'
		line.innerHTML = '<button class="fw-log-upgrade-btn" data-fw-idx="' + index + '"><i class="bi bi-arrow-right-circle"></i> 使用此固件进行串口升级</button><span class="fw-log-upgrade-name">' + name + '</span>'
		el.log.appendChild(line)
		el.log.scrollTop = el.log.scrollHeight
	}

	function navToFwUpgrade(data, name) {
		var buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
		window._fwPackOutputs.push({ name: name, buffer: buf })
		var idx = window._fwPackOutputs.length - 1
		logUpgradeBtn(name, data, idx)
	}

	if (el.log) {
		el.log.addEventListener('click', function (e) {
			var btn = e.target.closest('.fw-log-upgrade-btn')
			if (!btn) return
			var idx = parseInt(btn.getAttribute('data-fw-idx'), 10)
			var item = window._fwPackOutputs[idx]
			if (!item || !item.buffer) return
			var rail = document.querySelector('.rail-item[data-view="view-serial"]')
			if (rail) rail.click()
			var fwTab = document.getElementById('nav-firmware-tab')
			setTimeout(function () {
				if (!fwTab) return
				if (fwTab.classList.contains('active')) {
					if (window.setFwUpgradeFile) {
						window.setFwUpgradeFile(item.buffer, item.name)
					}
				} else {
					var onShown = function () {
						if (window.setFwUpgradeFile) {
							window.setFwUpgradeFile(item.buffer, item.name)
						}
						fwTab.removeEventListener('shown.bs.tab', onShown)
					}
					fwTab.addEventListener('shown.bs.tab', onShown)
					var tab = new bootstrap.Tab(fwTab)
					tab.show()
				}
			}, 100)
		})
	}

	const oldFw = { val: null }
	const oldFwName = { val: '' }
	const newFw = { val: null }
	const newFwName = { val: '' }
	const blank = { val: null }
	const blankNameVal = { val: '' }

	let hdiffiModule = null
	let hdiffiReady = false
	let hdiffiLoading = false

	function log(msg, level) {
		const cls = { info: '', success: 'text-success', error: 'text-danger', warn: 'text-warning' }[level || 'info']
		const time = new Date().toLocaleTimeString()
		const line = document.createElement('div')
		line.className = cls
		line.textContent = '[' + time + '] ' + msg
		el.log.appendChild(line)
		el.log.scrollTop = el.log.scrollHeight
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
	})
	el.newClear.addEventListener('click', function (e) {
		e.stopPropagation()
		newFw.val = null
		newFwName.val = ''
		hideFileInfo(el.newZone, el.newInfo, el.newName, el.newSize)
		el.newFile.value = ''
		log('已清除新固件', 'info')
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

	// 提前解码 WASM 二进制，供 instantiateWasm 使用
	;(function () {
		if (!window.__hdiffiWasmBase64) return
		try {
			var binStr = atob(window.__hdiffiWasmBase64)
			window.__hdiffiWasmBuf = new Uint8Array(binStr.length)
			for (var i = 0; i < binStr.length; i++) window.__hdiffiWasmBuf[i] = binStr.charCodeAt(i)
		} catch (e) {}
	})()

	// 提前静默加载 hdiffi，避免用户点击"开始生成"后再等待
	;(function () {
		if (typeof createHpatchLiteModule === 'undefined') return
		if (!window.__hdiffiWasmBuf) return
		hdiffiLoading = true
		try {
			createHpatchLiteModule({
				instantiateWasm: function (imports, successCallback) {
					WebAssembly.instantiate(window.__hdiffiWasmBuf, imports).then(function (result) {
						successCallback(result.instance)
					})
				}
			}).then(function (mod) {
				hdiffiModule = mod
				hdiffiReady = true
			}).catch(function () {})
			.finally(function () { hdiffiLoading = false })
		} catch (e) { hdiffiLoading = false }
	})()

	function ensureHdiffi() {
		return new Promise(function (resolve, reject) {
			if (hdiffiReady) return resolve(hdiffiModule)
			if (hdiffiLoading) {
				const check = setInterval(function () {
					if (hdiffiReady) { clearInterval(check); resolve(hdiffiModule) }
					if (!hdiffiLoading && !hdiffiReady) { clearInterval(check); reject(new Error('hdiffi 加载失败')) }
				}, 100)
				return
			}
			hdiffiLoading = true
			log('正在加载 hdiffi (HPatchLite) WASM ...', 'info')
			if (typeof createHpatchLiteModule === 'undefined') {
				hdiffiLoading = false
				reject(new Error('hdiffi WASM 模块未找到, 请确认 hdiffi.js 已加载'))
				return
			}

			function onLoad(mod) {
				hdiffiModule = mod
				hdiffiReady = true
				hdiffiLoading = false
				log('hdiffi WASM 就绪', 'success')
				resolve(mod)
			}
			function onError(err) {
				hdiffiLoading = false
				log('hdiffi WASM 初始化失败: ' + err.message, 'error')
				reject(err)
			}

			if (window.__hdiffiWasmBuf) {
				createHpatchLiteModule({
					instantiateWasm: function (imports, successCallback) {
						WebAssembly.instantiate(window.__hdiffiWasmBuf, imports).then(function (result) {
							successCallback(result.instance)
						})
					}
				}).then(onLoad).catch(onError)
			} else {
				createHpatchLiteModule().then(onLoad).catch(onError)
			}
		})
	}

	function wasmCreatePatch(oldData, newData) {
		return ensureHdiffi().then(function (mod) {
			const t0 = performance.now()
			const oldPtr = mod._malloc(oldData.length)
			const newPtr = mod._malloc(newData.length)
			const outPtrPtr = mod._malloc(4)

			for (let i = 0; i < oldData.length; i++) mod.setValue(oldPtr + i, oldData[i], 'i8')
			for (let i = 0; i < newData.length; i++) mod.setValue(newPtr + i, newData[i], 'i8')

			const patchSize = mod._hdiffi_create_patch(oldPtr, oldData.length, newPtr, newData.length, outPtrPtr)

			if (patchSize <= 0) {
				mod._free(oldPtr)
				mod._free(newPtr)
				mod._free(outPtrPtr)
				throw new Error('hdiffi 差分失败, 返回 ' + patchSize)
			}

			const outPtr = mod.getValue(outPtrPtr, 'i32')
			const patch = new Uint8Array(patchSize)
			for (let i = 0; i < patchSize; i++) patch[i] = mod.getValue(outPtr + i, 'i8')

			mod._free(outPtr)
			mod._free(oldPtr)
			mod._free(newPtr)
			mod._free(outPtrPtr)

			const t1 = performance.now()
			log('hdiffi 差分耗时: ' + (t1 - t0).toFixed(0) + 'ms, patch: ' + fmtSize(patchSize), 'info')
			return patch
		})
	}

	el.start.addEventListener('click', async function () {
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

		const newInfo = parseFirmwareName(newFwName.val)
		const userDefine = el.userDefine.value || ''
		const useZip = el.genZip.checked
		const zipFiles = []
		const newFwCRC32 = crc32(newFw.val).toString(16).toUpperCase().padStart(8, '0')

		// 在首个 await 前(点击手势有效期内)获取输出目录, 之后所有文件静默写入同一目录
		let dirHandle = null
		if (fsSaveSupported) {
			try {
				dirHandle = await ensureDirHandle()
				log('输出目录: ' + dirHandle.name + '/', 'info')
			} catch (e) {
				if (e && e.name === 'AbortError') {
					log('未选择输出目录, 已取消生成', 'warn')
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
					firmwareData: newFw.val,
					pkgType: 1,
					userDefine: userDefine,
				})
				const full = new Uint8Array(header.length + newFw.val.length)
				full.set(header)
				full.set(newFw.val, header.length)
				const outName = newInfo.version + '_' + newInfo.timestamp + '_Origin.bin'
				await outputFile(outName, full,
					'原始包: ' + outName + ' | 大小: ' + fmtSize(full.length) + ' | 固件CRC32: ' + newFwCRC32, 'success')
				navToFwUpgrade(full, outName)
			}

			if (genCompress) {
				if (!blank.val) {
					log('压缩包需要 BLANK.bin, 请选择 BLANK 文件', 'error')
				} else {
					try {
						const patch = await wasmCreatePatch(blank.val, newFw.val)
						const header = packFirmware({
							firmwareData: patch,
							pkgType: 2,
							userDefine: userDefine,
							oldFileData: blank.val,
							newFileData: newFw.val,
						})
						const full = new Uint8Array(header.length + patch.length)
						full.set(header)
						full.set(patch, header.length)
						const outName = newInfo.version + '_' + newInfo.timestamp + '_comp.bin'
						await outputFile(outName, full,
							'压缩包: ' + outName + ' | 大小: ' + fmtSize(full.length) + ' (patch: ' + fmtSize(patch.length) + ')', 'success')
						navToFwUpgrade(full, outName)
					} catch (e) {
						log('压缩包生成失败: ' + e.message, 'error')
					}
				}
			}

			if (genDiff) {
				if (!oldFw.val) {
					log('差分包需要旧固件, 请先选择旧固件', 'error')
				} else {
					const oldInfo = parseFirmwareName(oldFwName.val)

					try {
						const patchA = await wasmCreatePatch(oldFw.val, newFw.val)
						const headerA = packFirmware({
							firmwareData: patchA,
							pkgType: 3,
							userDefine: userDefine,
							oldFileData: oldFw.val,
							newFileData: newFw.val,
						})
						const fullA = new Uint8Array(headerA.length + patchA.length)
						fullA.set(headerA)
						fullA.set(patchA, headerA.length)
						const outA = oldInfo.version + '_' + oldInfo.timestamp + '_to_' + newInfo.version + '_' + newInfo.timestamp + '.bin'
						await outputFile(outA, fullA,
							'差分包(旧→新): ' + outA + ' | 大小: ' + fmtSize(fullA.length) + ' | patch: ' + fmtSize(patchA.length), 'success')
						navToFwUpgrade(fullA, outA)
					} catch (e) {
						log('差分包(旧→新)失败: ' + e.message, 'error')
					}

					try {
						const patchB = await wasmCreatePatch(newFw.val, oldFw.val)
						const headerB = packFirmware({
							firmwareData: patchB,
							pkgType: 3,
							userDefine: userDefine,
							oldFileData: newFw.val,
							newFileData: oldFw.val,
						})
						const fullB = new Uint8Array(headerB.length + patchB.length)
						fullB.set(headerB)
						fullB.set(patchB, headerB.length)
						const outB = newInfo.version + '_' + newInfo.timestamp + '_to_' + oldInfo.version + '_' + oldInfo.timestamp + '.bin'
						await outputFile(outB, fullB,
							'差分包(新→旧): ' + outB + ' | 大小: ' + fmtSize(fullB.length) + ' | patch: ' + fmtSize(patchB.length), 'success')
						navToFwUpgrade(fullB, outB)
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
					} catch (e) {
						downloadBlob(blob, zipName)
						log('打包下载: ' + zipName + ' (目录写入失败, 已转为浏览器下载)', 'warn')
					}
				} else {
					downloadBlob(blob, zipName)
					log('打包下载: ' + zipName + ' (' + fmtSize(blob.size) + ', 含 ' + zipFiles.length + ' 个文件)', 'success')
				}
			}
		} catch (e) {
			log('打包异常: ' + e.message, 'error')
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
