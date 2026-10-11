// 固件核心：升级包包头、CRC、原始固件 / 升级包识别、差分 Worker 调度、在内存里生成压缩包 / 差分包，以及
// 「自动升级」该走差分还是压缩的判定。不碰 DOM 与串口，固件打包页(js/firmware-packager.js)与固件升级面板
// (js/firmware-upgrade.js)共用；node 里可直接跑(tests/firmware-core.cjs)。在这两个文件之前加载。
// 包类型：1 原始包、2 压缩包(以 BLANK 为基准的差分)、3 差分包(以设备当前固件为基准)。设备只校验包头里的旧文件 CRC，
// 所以差分基准必须与设备上的固件逐字节一致，只凭版本号对上而有多份不同构建时不能猜。
;(function (root) {
	'use strict'

	const HEADER_SIZE = 128
	const MAGIC_NUM = 0x6b636553
	const RAW_INFO_OFFSET = 0x4000
	const PKG_ORIGIN = 1
	const PKG_COMPRESS = 2
	const PKG_DIFF = 3
	// 设备拒绝差分包后改用压缩包重试的下载结果码：0x07 升级包校验失败(基准不是设备上那份)、0x08 不支持该包类型
	const DIFF_FALLBACK_STATUS = [0x07, 0x08]
	// BLANK.BIN 的内置默认值(imgs/BLANK.BIN 取不到时用)
	const BLANK_BUILTIN = new Uint8Array(32).fill(0xff)

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

	// 信息区完整(长度 >= 0x4020)就取，与 embeddedVersion 的判据一致；否则识别出了版本、包头里却是空版本
	function getNewFileInfo(data) {
		const info = new Uint8Array(32)
		if (data.length >= RAW_INFO_OFFSET + 0x20) {
			info.set(data.subarray(RAW_INFO_OFFSET, RAW_INFO_OFFSET + 0x20))
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

	// 包头 + 数据拼成完整升级包
	function joinPackage(header, data) {
		const full = new Uint8Array(header.length + data.length)
		full.set(header)
		full.set(data, header.length)
		return full
	}

	/**
	 * 原始固件里嵌的版本：与包头 newFileInfo 那 32 字节同源(取 0x4000 起)，前 4 字节时间戳，之后到 20 字节为版本串(遇 0 结束)。
	 * 取不到或不是可见 ASCII 就返回 null，不去猜
	 */
	function embeddedVersion(data) {
		if (!data || data.length < RAW_INFO_OFFSET + 0x20) return null
		let s = ''
		for (let i = RAW_INFO_OFFSET + 4; i < RAW_INFO_OFFSET + 20; i++) {
			const b = data[i]
			if (b === 0) break
			if (b < 0x20 || b > 0x7e) return null
			s += String.fromCharCode(b)
		}
		return s.length ? s : null
	}

	function readU32(data, off) {
		return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0
	}

	// 识别文件：升级包(魔数对上)返回包类型；否则按原始固件取内嵌版本，取不到就是 unknown。只看魔数不做 CRC 校验，校验交给 FirmwareParser
	function classify(data) {
		if (!data) return { kind: 'unknown' }
		if (data.length >= HEADER_SIZE && readU32(data, 0) === MAGIC_NUM) return { kind: 'package', pkgType: readU32(data, 8) }
		const version = embeddedVersion(data)
		if (version) return { kind: 'raw', version, crc: crc32(data), size: data.length }
		return { kind: 'unknown' }
	}

	function sameVersion(a, b) {
		if (a == null || b == null) return false
		const x = String(a).trim()
		return x !== '' && x === String(b).trim()
	}

	/**
	 * 自动升级的判定。candidates 是固件库里内嵌版本等于设备版本的条目([{ crc, size, data? }])：
	 * 唯一一份(按 crc + size 去重后)才差分；没有设备版本、库里没有、或同版本有多份不同构建都走压缩，不猜基准
	 */
	function planUpgrade(opts) {
		const deviceVersion = opts && opts.deviceVersion
		if (!deviceVersion || !String(deviceVersion).trim()) return { mode: 'compress', reason: 'no-device-version' }
		const seen = new Map()
		;(opts.candidates || []).forEach(function (c) {
			if (c && c.crc != null) seen.set(c.crc + ':' + c.size, c)
		})
		if (seen.size === 0) return { mode: 'compress', reason: 'not-found' }
		if (seen.size > 1) return { mode: 'compress', reason: 'ambiguous', count: seen.size }
		return { mode: 'diff', base: seen.values().next().value }
	}

	function shouldFallbackToCompress(mode, downloadStatus) {
		return mode === 'diff' && DIFF_FALLBACK_STATUS.indexOf(downloadStatus) !== -1
	}

	/**
	 * 在内存里生成升级包(不落盘、不下载)。type: 'compress'(base 为 BLANK)| 'diff'(base 为设备当前固件)。
	 * createPatch(old, new) → Promise<Uint8Array>，由差分 Worker 提供
	 */
	async function buildPackage(type, newData, baseData, createPatch, userDefine) {
		if (type !== 'compress' && type !== 'diff') throw new Error('未知的升级包类型: ' + type)
		if (!newData || !newData.length) throw new Error('缺少新固件')
		if (!baseData || !baseData.length) throw new Error(type === 'diff' ? '缺少差分基准固件' : '缺少 BLANK 基准')
		const patch = await createPatch(baseData, newData)
		const header = packFirmware({
			firmwareData: patch,
			pkgType: type === 'diff' ? PKG_DIFF : PKG_COMPRESS,
			userDefine: userDefine || '',
			oldFileData: baseData,
			newFileData: newData,
		})
		return joinPackage(header, patch)
	}

	/**
	 * 差分 Worker 调度：按需创建，同一时刻一个任务，超时或出错即 terminate 释放 WASM 内存；dispose() 在整轮结束时调用。
	 * WorkerCtor 默认取全局 Worker(node 测试注入假的)
	 */
	function createDiffRunner(workerUrl, opts) {
		opts = opts || {}
		const timeoutMs = opts.timeoutMs || 5 * 60 * 1000
		let worker = null
		let job = null

		function dispose(error) {
			if (worker) worker.terminate()
			worker = null
			if (job) {
				clearTimeout(job.timer)
				const j = job
				job = null
				j.reject(error || new Error('差分任务已结束'))
			}
		}

		function createPatch(oldData, newData) {
			return new Promise(function (resolve, reject) {
				if (job) { reject(new Error('差分任务正在执行')); return }
				try {
					if (!worker) {
						const WorkerCtor = opts.Worker || root.Worker
						worker = new WorkerCtor(workerUrl)
						worker.onmessage = function (e) {
							const j = job
							if (!j) return
							clearTimeout(j.timer)
							job = null
							if (e.data.error) j.reject(new Error(e.data.error))
							else {
								const patch = new Uint8Array(e.data.patch)
								if (opts.onDone) opts.onDone({ ms: e.data.ms, size: patch.length })
								j.resolve(patch)
							}
						}
						worker.onerror = function () { dispose(new Error('差分 Worker 加载或执行失败')) }
						worker.onmessageerror = function () { dispose(new Error('差分 Worker 数据传输失败')) }
					}
					// 输入还要留给组包 CRC，只转移本任务的副本
					const oldCopy = oldData.slice()
					const newCopy = newData.slice()
					job = { resolve: resolve, reject: reject, timer: setTimeout(function () {
						dispose(new Error('差分生成超时'))
					}, timeoutMs) }
					worker.postMessage({ old: oldCopy.buffer, nw: newCopy.buffer }, [oldCopy.buffer, newCopy.buffer])
				} catch (e) {
					if (job) dispose(e)
					else reject(e)
				}
			})
		}

		return { createPatch, dispose }
	}

	const api = {
		HEADER_SIZE, MAGIC_NUM, RAW_INFO_OFFSET, PKG_ORIGIN, PKG_COMPRESS, PKG_DIFF, DIFF_FALLBACK_STATUS, BLANK_BUILTIN,
		crc32, buildHeader, getNewFileInfo, packFirmware, joinPackage, embeddedVersion, classify, sameVersion,
		planUpgrade, shouldFallbackToCompress, buildPackage, createDiffRunner,
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api
	}
	root.FirmwareCore = api
})(typeof window !== 'undefined' ? window : globalThis)
