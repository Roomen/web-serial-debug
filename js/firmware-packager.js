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
		setU32(info.pkgHeaderVersion || 1)
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
		newFile:     document.getElementById('fp-new-file'),
		newSelect:   document.getElementById('fp-new-select'),
		newName:     document.getElementById('fp-new-name'),
		blankFile:   document.getElementById('fp-blank-file'),
		blankSelect: document.getElementById('fp-blank-select'),
		blankName:   document.getElementById('fp-blank-name'),
		userDefine:  document.getElementById('fp-user-define'),
		genOrigin:   document.getElementById('fp-gen-origin'),
		genCompress: document.getElementById('fp-gen-compress'),
		genDiff:     document.getElementById('fp-gen-diff'),
		blankRow:    document.getElementById('fp-blank-row'),
		start:       document.getElementById('fp-start'),
		log:         document.getElementById('fp-log'),
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

	function loadFile(file, nameEl, bufferHolder, fileNameHolder) {
		if (!file) return
		nameEl.textContent = file.name
		const reader = new FileReader()
		reader.onload = function () {
			bufferHolder.val = new Uint8Array(reader.result)
			fileNameHolder.val = file.name
			log('已载入 ' + file.name + ' (' + fmtSize(reader.result.byteLength) + ')', 'info')
		}
		reader.readAsArrayBuffer(file)
	}

	el.oldSelect.addEventListener('click', () => el.oldFile.click())
	el.newSelect.addEventListener('click', () => el.newFile.click())
	el.blankSelect.addEventListener('click', () => el.blankFile.click())

	el.oldFile.addEventListener('change', function () {
		loadFile(this.files[0], el.oldName, oldFw, oldFwName)
	})
	el.newFile.addEventListener('change', function () {
		loadFile(this.files[0], el.newName, newFw, newFwName)
	})
	el.blankFile.addEventListener('change', function () {
		loadFile(this.files[0], el.blankName, blank, blankNameVal)
	})

	el.genCompress.addEventListener('change', function () {
		el.blankRow.style.display = this.checked ? '' : 'none'
	})

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
			createHpatchLiteModule().then(function (mod) {
				hdiffiModule = mod
				hdiffiReady = true
				hdiffiLoading = false
				log('hdiffi WASM 就绪', 'success')
				resolve(mod)
			}).catch(function (err) {
				hdiffiLoading = false
				log('hdiffi WASM 加载失败: ' + err.message, 'error')
				reject(err)
			})
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
				downloadBlob(full, outName)
				log('原始包: ' + outName + ' | 大小: ' + fmtSize(full.length) + ' | 固件CRC32: ' + crc32(newFw.val).toString(16).toUpperCase().padStart(8, '0'), 'success')
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
						downloadBlob(full, outName)
						log('压缩包: ' + outName + ' | 大小: ' + fmtSize(full.length) + ' (patch: ' + fmtSize(patch.length) + ')', 'success')
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
						downloadBlob(fullA, outA)
						log('差分包(旧→新): ' + outA + ' | 大小: ' + fmtSize(fullA.length) + ' | patch: ' + fmtSize(patchA.length), 'success')
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
						downloadBlob(fullB, outB)
						log('差分包(新→旧): ' + outB + ' | 大小: ' + fmtSize(fullB.length) + ' | patch: ' + fmtSize(patchB.length), 'success')
					} catch (e) {
						log('差分包(新→旧)失败: ' + e.message, 'error')
					}
				}
			}
		} catch (e) {
			log('打包异常: ' + e.message, 'error')
		}
	})

	// 加载内置 BLANK.BIN
	fetch('imgs/BLANK.BIN')
		.then(function (r) {
			if (!r.ok) throw new Error('HTTP ' + r.status)
			return r.arrayBuffer()
		})
		.then(function (buf) {
			blank.val = new Uint8Array(buf)
			log('已加载内置 BLANK.BIN (' + fmtSize(buf.byteLength) + ')', 'info')
		})
		.catch(function () {})
})()
