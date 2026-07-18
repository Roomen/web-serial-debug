;(function () {
	'use strict'

	// ============================================================
	// PCP 协议 (华为IoT平台 PCP, 基于 pcp_protocol.py 重写)
	// ============================================================
	const PCPMessageCode = {
		QUERY_VERSION: 0x13,
		NEW_VERSION_NOTIFY: 0x14,
		DOWNLOAD_REQUEST: 0x15,
		DOWNLOAD_RESULT: 0x16,
		EXECUTE_UPGRADE: 0x17,
		UPGRADE_RESULT: 0x18,
	}

	const PCP = {
		START_FLAG: 0xFFFE,
		PROTOCOL_VERSION: 0x01,
		CRC16_TABLE: (function () {
			const table = new Array(256)
			for (let i = 0; i < 256; i++) {
				let crc = i << 8
				for (let j = 0; j < 8; j++) {
					crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF
				}
				table[i] = crc & 0xFFFF
			}
			return table
		})(),

		calculateCrc16(data) {
			let crc = 0x0000
			for (let i = 0; i < data.length; i++) {
				crc = ((crc >> 8) ^ this.CRC16_TABLE[(crc ^ data[i]) & 0xFF]) & 0xFFFF
			}
			return crc & 0xFFFF
		},

		versionToBytes(versionStr) {
			const enc = new TextEncoder()
			let bytes = Array.from(enc.encode(versionStr))
			while (bytes.length < 16) bytes.push(0x00)
			return bytes.slice(0, 16)
		},

		bytesToVersion(bytes) {
			let end = bytes.indexOf(0)
			if (end === -1) end = bytes.length
			const slice = bytes.slice(0, end)
			return new TextDecoder().decode(Uint8Array.from(slice))
		},

		buildMessage(messageCode, data) {
			data = data || []
			const head = new Uint8Array(8)
			// 起始标识 0xFFFE (big endian)
			head[0] = 0xFF
			head[1] = 0xFE
			head[2] = this.PROTOCOL_VERSION
			head[3] = messageCode
			// 校验码占位 2 字节
			head[4] = 0x00
			head[5] = 0x00
			// 数据区长度 (big endian)
			head[6] = (data.length >> 8) & 0xFF
			head[7] = data.length & 0xFF
			const msg = new Uint8Array(8 + data.length)
			msg.set(head, 0)
			msg.set(Uint8Array.from(data), 8)
			const crc = this.calculateCrc16(msg)
			msg[4] = (crc >> 8) & 0xFF
			msg[5] = crc & 0xFF
			return msg
		},

		parseMessage(message) {
			if (message.length < 8) return null
			const startFlag = (message[0] << 8) | message[1]
			const version = message[2]
			const messageCode = message[3]
			const checksum = (message[4] << 8) | message[5]
			const dataLength = (message[6] << 8) | message[7]
			const data = message.slice(8, 8 + dataLength)

			const temp = new Uint8Array(message.length)
			temp.set(message, 0)
			temp[4] = 0x00
			temp[5] = 0x00
			const calculatedCrc = this.calculateCrc16(temp.subarray(0, 8 + dataLength))

			return {
				startFlag,
				version,
				messageCode,
				checksum,
				checksumValid: checksum === calculatedCrc,
				dataLength,
				data,
			}
		},

		buildQueryVersionRequest() {
			return this.buildMessage(PCPMessageCode.QUERY_VERSION)
		},
		parseQueryVersionResponse(response) {
			const parsed = this.parseMessage(response)
			if (!parsed || parsed.dataLength < 17) return { resultCode: 0xFF, version: '' }
			const resultCode = parsed.data[0]
			const version = this.bytesToVersion(Array.from(parsed.data.slice(1, 17)))
			return { resultCode, version }
		},

		buildNewVersionNotify(targetVersion, chunkSize, totalChunks) {
			const data = []
			data.push(...this.versionToBytes(targetVersion))
			data.push((chunkSize >> 8) & 0xFF, chunkSize & 0xFF)
			data.push((totalChunks >> 8) & 0xFF, totalChunks & 0xFF)
			data.push(0x00, 0x00)
			return this.buildMessage(PCPMessageCode.NEW_VERSION_NOTIFY, data)
		},
		parseNewVersionNotifyResponse(response) {
			const parsed = this.parseMessage(response)
			if (!parsed || parsed.dataLength < 1) return { resultCode: 0xFF }
			return { resultCode: parsed.data[0] }
		},

		parseDownloadRequest(request) {
			const parsed = this.parseMessage(request)
			if (!parsed || parsed.dataLength < 18) return { targetVersion: '', chunkIndex: 0 }
			const version = this.bytesToVersion(Array.from(parsed.data.slice(0, 16)))
			const chunkIndex = (parsed.data[16] << 8) | parsed.data[17]
			return { targetVersion: version, chunkIndex }
		},
		buildDownloadResponse(chunkIndex, chunkData, targetVersion) {
			const data = []
			data.push(0x00)
			data.push((chunkIndex >> 8) & 0xFF, chunkIndex & 0xFF)
			data.push(...chunkData)
			return this.buildMessage(PCPMessageCode.DOWNLOAD_REQUEST, data)
		},

		parseDownloadResultReport(report) {
			const parsed = this.parseMessage(report)
			if (!parsed || parsed.dataLength < 1) return { downloadStatus: 0xFF }
			return { downloadStatus: parsed.data[0] }
		},
		buildDownloadResultAck(resultCode) {
			resultCode = resultCode || 0
			return this.buildMessage(PCPMessageCode.DOWNLOAD_RESULT, [resultCode])
		},

		buildExecuteUpgradeRequest() {
			return this.buildMessage(PCPMessageCode.EXECUTE_UPGRADE)
		},
		parseExecuteUpgradeResponse(response) {
			const parsed = this.parseMessage(response)
			if (!parsed || parsed.dataLength < 1) return { resultCode: 0xFF }
			return { resultCode: parsed.data[0] }
		},

		parseUpgradeResultReport(report) {
			const parsed = this.parseMessage(report)
			if (!parsed || parsed.dataLength < 17) return { resultCode: 0xFF, currentVersion: '' }
			const resultCode = parsed.data[0]
			const currentVersion = this.bytesToVersion(Array.from(parsed.data.slice(1, 17)))
			return { resultCode, currentVersion }
		},
		buildUpgradeResultAck(resultCode) {
			resultCode = resultCode || 0
			return this.buildMessage(PCPMessageCode.UPGRADE_RESULT, [resultCode])
		},

		messageCodeName(code) {
			const names = {
				0x13: '查询设备版本',
				0x14: '下载新版本软件包通知',
				0x15: '请求下载升级包',
				0x16: '上报升级包下载结果',
				0x17: '执行软件升级',
				0x18: '上报升级结果',
			}
			return names[code] || ('未知(0x' + code.toString(16) + ')')
		},
	}

	// ============================================================
	// 固件解析 (基于 firmware_parser.py 重写)
	// ============================================================
	function crc32(bytes) {
		let crc = 0xFFFFFFFF
		for (let i = 0; i < bytes.length; i++) {
			crc ^= bytes[i]
			for (let j = 0; j < 8; j++) {
				crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1
				crc >>>= 0
			}
		}
		return (crc ^ 0xFFFFFFFF) >>> 0
	}

	const FirmwareParser = {
		HEADER_SIZE: 128,
		MAGIC_NUM: 0x6b636553,

		parse(arrayBuffer) {
			const fileData = new Uint8Array(arrayBuffer)
			if (fileData.length < this.HEADER_SIZE) {
				return { ok: false, error: `固件文件太小(${fileData.length}字节)，至少需要${this.HEADER_SIZE}字节` }
			}
			const dv = new DataView(arrayBuffer)
			const header = {}
			let off = 0
			header.magicNum = dv.getUint32(off, true); off += 4
			header.pkgHeaderVersion = dv.getUint32(off, true); off += 4
			header.pkgType = dv.getUint32(off, true); off += 4
			header.pkgEncType = dv.getUint32(off, true); off += 4
			header.pkgDataSize = dv.getUint32(off, true); off += 4
			header.pkgDataCRC32 = dv.getUint32(off, true); off += 4
			header.patchFileSize = dv.getUint32(off, true); off += 4
			header.oldFileSize = dv.getUint32(off, true); off += 4
			header.oldFileCRC32 = dv.getUint32(off, true); off += 4
			header.newFileSize = dv.getUint32(off, true); off += 4
			header.newFileCRC32 = dv.getUint32(off, true); off += 4
			const newFileInfo = fileData.slice(44, 76)
			const userDefine = fileData.slice(76, 124)
			header.pkgHeaderCRC32 = dv.getUint32(124, true)

			if (header.magicNum !== this.MAGIC_NUM) {
				return { ok: false, error: '包头解析失败，魔数校验不通过' }
			}
			if (fileData.length < this.HEADER_SIZE + header.pkgDataSize) {
				return { ok: false, error: `固件数据不完整，期望${header.pkgDataSize}字节，实际${fileData.length - this.HEADER_SIZE}字节` }
			}
			const firmwareData = fileData.slice(0, this.HEADER_SIZE + header.pkgDataSize)
			const pureData = firmwareData.slice(this.HEADER_SIZE)
			const calculatedCrc = crc32(pureData)
			if (calculatedCrc !== header.pkgDataCRC32) {
				return { ok: false, error: `数据CRC32校验失败，期望0x${header.pkgDataCRC32.toString(16).toUpperCase()}，实际0x${calculatedCrc.toString(16).toUpperCase()}` }
			}
			if (newFileInfo.length < 20) {
				return { ok: false, error: 'newFileInfo字段长度不足' }
			}
			const timestamp = dv.getUint32(44, true)
			let end = 4
			while (end < 20 && newFileInfo[end] !== 0) end++
			const version = new TextDecoder().decode(newFileInfo.slice(4, end))

			return {
				ok: true,
				header,
				firmwareData,
				version,
				timestamp,
				newFileInfo,
				userDefine,
				pkgTypeName: this.pkgTypeName(header.pkgType),
				encTypeName: this.encTypeName(header.pkgEncType),
			}
		},

		pkgTypeName(t) {
			return { 1: '原始包', 2: '压缩包', 3: '差分包' }[t] || `未知类型(${t})`
		},
		encTypeName(t) {
			return { 0: '不加密', 1: 'AES256' }[t] || `未知类型(${t})`
		},

		diagnose(fw) {
			const lines = []
			const h = fw.header
			lines.push(`文件: ${fw.fileName || ''}`)
			lines.push(`版本: ${fw.version}`)
			lines.push(`时间戳: ${fw.timestamp} (0x${fw.timestamp.toString(16).toUpperCase()})`)
			const d = new Date(fw.timestamp * 1000)
			if (!isNaN(d.getTime())) lines.push(`  日期: ${d.toLocaleString()}`)
			lines.push(`包类型: ${fw.pkgTypeName}`)
			lines.push(`加密: ${fw.encTypeName}`)
			lines.push(`数据大小: ${h.pkgDataSize} 字节`)
			lines.push(`新文件大小: ${h.newFileSize} 字节`)
			lines.push(`数据CRC32: 0x${h.pkgDataCRC32.toString(16).toUpperCase()}`)
			if (h.pkgType === 3) {
				lines.push('')
				lines.push('⚠ 差分包：设备必须支持差分升级，且当前版本需匹配旧文件CRC32 0x' + h.oldFileCRC32.toString(16).toUpperCase())
			}
			lines.push('')
			lines.push('分片建议:')
			;[500, 200, 100].forEach((cs) => {
				const n = Math.ceil(h.pkgDataSize / cs)
				lines.push(`  分片 ${cs}字节: 需 ${n} 个分片`)
			})
			return lines.join('\n')
		},
	}

	window.PCP = PCP
	window.PCPMessageCode = PCPMessageCode
	window.FirmwareParser = FirmwareParser
})()
