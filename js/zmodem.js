// ZMODEM (CRC32 + ZCRCW 停等模式) 纯逻辑实现：与固件侧 ZMODEM 停等子集线格式逐字节对齐
// 不依赖 DOM 或 serialApi，可在 Node 直接单测（module.exports）并在浏览器挂到 window.Zmodem
;(function (root) {
	'use strict'

	const ZPAD = 0x2A
	const ZDLE = 0x18
	const ZBIN = 0x41
	const ZHEX = 0x42
	const ZBIN32 = 0x43
	const XON = 0x11
	const XOFF = 0x13

	const FRAME = {
		ZRQINIT: 0,
		ZRINIT: 1,
		ZSINIT: 2,
		ZACK: 3,
		ZFILE: 4,
		ZSKIP: 5,
		ZNAK: 6,
		ZABORT: 7,
		ZFIN: 8,
		ZRPOS: 9,
		ZDATA: 10,
		ZEOF: 11,
		ZFERR: 12,
		ZCRC: 13,
		ZCHALLENGE: 14,
		ZCOMPL: 15,
		ZCAN: 16,
	}

	const ZCRCE = 0x68
	const ZCRCG = 0x69
	const ZCRCQ = 0x6A
	const ZCRCW = 0x6B
	const ZRUB0 = 0x6C
	const ZRUB1 = 0x6D

	const CANFDX = 0x01
	const CANFC32 = 0x20
	const ESCCTL = 0x40
	const ESC8 = 0x80
	const ZCBIN = 0x01

	const MAX_SUBPACKET_LEN = 1024
	const MAX_HEADER_SCAN_BYTES = 2560
	const CAN_ABORT_COUNT = 5
	const ABORT_SEQ = Uint8Array.from([
		ZDLE, ZDLE, ZDLE, ZDLE, ZDLE, ZDLE, ZDLE, ZDLE,
		0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
	])
	const OVER_AND_OUT = Uint8Array.from([0x4F, 0x4F]) // "OO"

	const STATUS = {
		OK: 'OK',
		ERR_ARG: 'ERR_ARG',
		ERR_TIMEOUT: 'ERR_TIMEOUT',
		ERR_IO: 'ERR_IO',
		ERR_CRC: 'ERR_CRC',
		ERR_ESCAPE: 'ERR_ESCAPE',
		ERR_OVERFLOW: 'ERR_OVERFLOW',
		ERR_EOF: 'ERR_EOF',
		ERR_OFFSET: 'ERR_OFFSET',
		ERR_UNSUPPORTED: 'ERR_UNSUPPORTED',
		ERR_ABORTED: 'ERR_ABORTED',
		ERR_RETRY: 'ERR_RETRY',
		ERR_PROTOCOL: 'ERR_PROTOCOL',
	}

	function makeErr(code, message) {
		const err = new Error(message || code)
		err.zmodemCode = code
		return err
	}

	function crc16(data) {
		let crc = 0
		for (let i = 0; i < data.length; i++) {
			crc ^= (data[i] & 0xff) << 8
			for (let bit = 0; bit < 8; bit++) {
				if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff
				else crc = (crc << 1) & 0xffff
			}
		}
		return crc & 0xffff
	}

	function crc32Update(crc, data) {
		let state = (~crc) >>> 0
		for (let i = 0; i < data.length; i++) {
			state ^= data[i] & 0xff
			for (let bit = 0; bit < 8; bit++) {
				if (state & 1) state = ((state >>> 1) ^ 0xEDB88320) >>> 0
				else state = (state >>> 1) >>> 0
			}
		}
		return (~state) >>> 0
	}

	function crc32(data) {
		return crc32Update(0, data)
	}

	function unpackPosLe(pos) {
		const v = pos >>> 0
		return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
	}

	function packPosLe(p) {
		return ((p[0] & 0xff) | ((p[1] & 0xff) << 8) | ((p[2] & 0xff) << 16) | ((p[3] & 0xff) << 24)) >>> 0
	}

	function shouldEscapeByte(b, prevByte, hasPrev, escapeCtrl) {
		const b7 = b & 0x7f
		if (b === ZDLE) return true
		if (b7 === 0x10 || b7 === XON || b7 === XOFF) return true
		if (b7 === 0x0d && hasPrev && (prevByte & 0x7f) === 0x40) return true
		if (escapeCtrl && (b & 0x60) === 0) return true
		return false
	}

	function zdleEscape(src, escapeCtrl) {
		const out = []
		let prev = 0
		let hasPrev = false
		for (let i = 0; i < src.length; i++) {
			const b = src[i] & 0xff
			if (shouldEscapeByte(b, prev, hasPrev, escapeCtrl)) {
				out.push(ZDLE, b ^ 0x40)
			} else {
				out.push(b)
			}
			prev = b
			hasPrev = true
		}
		return Uint8Array.from(out)
	}

	const HEX_DIGITS = '0123456789abcdef'

	function encodeHexHeader(type, posOrFlags) {
		const p = unpackPosLe(posOrFlags)
		const raw = [type & 0xff, p[0], p[1], p[2], p[3]]
		const c = crc16(raw)
		raw.push((c >>> 8) & 0xff, c & 0xff)
		const out = new Uint8Array(20)
		out[0] = ZPAD
		out[1] = ZPAD
		out[2] = ZDLE
		out[3] = ZHEX
		let idx = 4
		for (let i = 0; i < raw.length; i++) {
			out[idx++] = HEX_DIGITS.charCodeAt((raw[i] >>> 4) & 0x0f)
			out[idx++] = HEX_DIGITS.charCodeAt(raw[i] & 0x0f)
		}
		out[idx++] = 0x0d
		out[idx++] = 0x0a
		return out
	}

	function encodeBin32Header(type, posOrFlags, escapeCtrl) {
		const p = unpackPosLe(posOrFlags)
		const raw5 = [type & 0xff, p[0], p[1], p[2], p[3]]
		const c = crc32(raw5)
		const cBytes = unpackPosLe(c)
		const raw = Uint8Array.from(raw5.concat(cBytes))
		const esc = zdleEscape(raw, !!escapeCtrl)
		const out = new Uint8Array(3 + esc.length)
		out[0] = ZPAD
		out[1] = ZDLE
		out[2] = ZBIN32
		out.set(esc, 3)
		return out
	}

	function encodeSubpacketCrcw(data, escapeCtrl) {
		const u8 = data instanceof Uint8Array ? data : Uint8Array.from(data || [])
		if (u8.length > MAX_SUBPACKET_LEN) throw makeErr(STATUS.ERR_OVERFLOW, 'ZMODEM 子包超长')
		const escData = zdleEscape(u8, !!escapeCtrl)
		const endArr = Uint8Array.from([ZCRCW])
		let c = crc32Update(0, u8)
		c = crc32Update(c, endArr)
		const escCrc = zdleEscape(Uint8Array.from(unpackPosLe(c)), !!escapeCtrl)
		const out = new Uint8Array(escData.length + 2 + escCrc.length)
		out.set(escData, 0)
		out[escData.length] = ZDLE
		out[escData.length + 1] = ZCRCW
		out.set(escCrc, escData.length + 2)
		return out
	}

	function hexToNibble(ch) {
		if (ch >= 0x30 && ch <= 0x39) return ch - 0x30
		if (ch >= 0x61 && ch <= 0x66) return ch - 0x61 + 10
		if (ch >= 0x41 && ch <= 0x46) return ch - 0x41 + 10
		return -1
	}

	function makeZrinitPos(maxSubpacketLen, escapeCtrl) {
		const p = [
			maxSubpacketLen & 0xff,
			(maxSubpacketLen >>> 8) & 0xff,
			0,
			CANFDX | CANFC32 | (escapeCtrl ? ESCCTL : 0),
		]
		return packPosLe(p)
	}

	function parseFileMeta(bytes) {
		let nul = -1
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] === 0) { nul = i; break }
		}
		if (nul <= 0) throw makeErr(STATUS.ERR_EOF, 'ZFILE 缺少文件名')
		let fileName = ''
		for (let i = 0; i < nul; i++) fileName += String.fromCharCode(bytes[i])
		let hasExpectedSize = false
		let expectedSize = 0
		if (nul + 1 < bytes.length) {
			let numStr = ''
			for (let i = nul + 1; i < bytes.length; i++) {
				const ch = bytes[i]
				if (ch === 0 || ch === 0x20) break
				if (ch < 0x30 || ch > 0x39) throw makeErr(STATUS.ERR_EOF, 'ZFILE 长度字段非法')
				numStr += String.fromCharCode(ch)
			}
			if (numStr.length > 0) {
				const parsed = Number(numStr)
				if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
					throw makeErr(STATUS.ERR_EOF, 'ZFILE 长度超出范围')
				}
				expectedSize = parsed
				hasExpectedSize = true
			}
		}
		return { fileName, expectedSize, hasExpectedSize }
	}

	function encodeFileMeta(fileName, totalSize) {
		const name = String(fileName || 'payload.json')
		const sizeStr = String(totalSize >>> 0)
		const out = new Uint8Array(name.length + 1 + sizeStr.length + 1)
		let idx = 0
		for (let i = 0; i < name.length; i++) out[idx++] = name.charCodeAt(i) & 0xff
		out[idx++] = 0
		for (let i = 0; i < sizeStr.length; i++) out[idx++] = sizeStr.charCodeAt(i) & 0xff
		out[idx++] = 0
		return out
	}

	// 将推送式串口接收流桥接为按字节带超时的异步读取接口
	function createByteQueue() {
		const buf = []
		let head = 0
		let closedErr = null
		const waiters = []

		function compact() {
			if (head > 4096 && head * 2 >= buf.length) {
				buf.splice(0, head)
				head = 0
			}
		}

		function push(data) {
			if (!data || !data.length || closedErr) return
			for (let i = 0; i < data.length; i++) buf.push(data[i] & 0xff)
			while (waiters.length && head < buf.length) {
				const w = waiters.shift()
				clearTimeout(w.timer)
				w.resolve(buf[head++])
			}
			compact()
		}

		function fail(err) {
			if (closedErr) return
			closedErr = err || makeErr(STATUS.ERR_IO, '链路已断开')
			while (waiters.length) {
				const w = waiters.shift()
				clearTimeout(w.timer)
				w.reject(closedErr)
			}
		}

		function clear() {
			buf.length = 0
			head = 0
		}

		function readByte(timeoutMs) {
			if (head < buf.length) {
				const b = buf[head++]
				compact()
				return Promise.resolve(b)
			}
			if (closedErr) return Promise.reject(closedErr)
			return new Promise(function (resolve, reject) {
				const w = {
					resolve,
					reject,
					timer: setTimeout(function () {
						const idx = waiters.indexOf(w)
						if (idx !== -1) waiters.splice(idx, 1)
						resolve(null)
					}, Math.max(1, timeoutMs || 1)),
				}
				waiters.push(w)
			})
		}

		return { push, fail, clear, readByte }
	}

	function normalizeOpts(opts) {
		opts = opts || {}
		const maxSubpacketLen = Math.min(MAX_SUBPACKET_LEN, Math.max(1, opts.maxSubpacketLen || MAX_SUBPACKET_LEN))
		const readTimeoutMs = Math.max(10, opts.readTimeoutMs || 3000)
		const sessionTimeoutMs = Math.max(readTimeoutMs, opts.sessionTimeoutMs || 60000)
		const initialWaitMs = opts.initialWaitMs != null ? Math.max(0, opts.initialWaitMs) : 0
		const maxRetries = Math.min(32, Math.max(1, opts.maxRetries || 5))
		const maxFileSize = opts.maxFileSize || 0
		const escapeCtrl = !!opts.escapeCtrl
		const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : Date.now
		const signal = opts.signal || null
		return { maxSubpacketLen, readTimeoutMs, sessionTimeoutMs, initialWaitMs, maxRetries, maxFileSize, escapeCtrl, nowMs, signal }
	}

	async function sendAbort(io) {
		try {
			await io.writeBytes(ABORT_SEQ)
		} catch (e) {}
	}

	function createReader(io, cfg) {
		let startMs = cfg.nowMs()

		function resetSessionClock() {
			startMs = cfg.nowMs()
		}

		function remainingMs(customDeadlineMs) {
			if (customDeadlineMs != null) {
				return Math.max(0, customDeadlineMs - cfg.nowMs())
			}
			const elapsed = cfg.nowMs() - startMs
			return Math.max(0, cfg.sessionTimeoutMs - elapsed)
		}

		function checkAbort() {
			if (cfg.signal && cfg.signal.aborted) {
				throw makeErr(STATUS.ERR_ABORTED, 'ZMODEM 会话已取消')
			}
		}

		async function readByte(customDeadlineMs) {
			checkAbort()
			const rem = remainingMs(customDeadlineMs)
			if (rem <= 0) return { status: STATUS.ERR_TIMEOUT }
			const wait = Math.min(rem, cfg.readTimeoutMs)
			let b
			try {
				b = await io.readByte(wait)
			} catch (e) {
				return { status: STATUS.ERR_IO, error: e }
			}
			checkAbort()
			if (b === null || b === undefined) {
				return { status: STATUS.ERR_TIMEOUT }
			}
			if (remainingMs(customDeadlineMs) <= 0) return { status: STATUS.ERR_TIMEOUT }
			return { status: STATUS.OK, value: b & 0xff }
		}

		async function readZdleItem(wireState) {
			while (true) {
				if (wireState.count >= wireState.max) return { status: STATUS.ERR_ESCAPE }
				const r = await readByte()
				if (r.status !== STATUS.OK) return r
				wireState.count++
				const b = r.value
				if (b !== ZDLE) {
					return { status: STATUS.OK, byte: b, frameEnd: 0 }
				}
				// 遇到 ZDLE：检查连续 CAN(0x18) 取消或转义字符
				let canCount = 1
				while (true) {
					if (wireState.count >= wireState.max) return { status: STATUS.ERR_ESCAPE }
					const r2 = await readByte()
					if (r2.status !== STATUS.OK) return r2
					wireState.count++
					const n = r2.value
					if (n === ZDLE) {
						canCount++
						if (canCount >= CAN_ABORT_COUNT) return { status: STATUS.ERR_ABORTED }
						continue
					}
					if (n === ZCRCE || n === ZCRCG || n === ZCRCQ || n === ZCRCW) {
						return { status: STATUS.OK, byte: 0, frameEnd: n }
					}
					if (n === ZRUB0) return { status: STATUS.OK, byte: 0x7f, frameEnd: 0 }
					if (n === ZRUB1) return { status: STATUS.OK, byte: 0xff, frameEnd: 0 }
					if ((n & 0x60) === 0x40) return { status: STATUS.OK, byte: n ^ 0x40, frameEnd: 0 }
					return { status: STATUS.ERR_ESCAPE }
				}
			}
		}

		async function readHeader(customDeadlineMs) {
			let scanned = 0
			let canCount = 0
			let state = 0 // 0=seek ZPAD, 1=seen ZPAD, 2=seen ZDLE
			while (scanned < MAX_HEADER_SCAN_BYTES) {
				const r = await readByte(customDeadlineMs)
				if (r.status !== STATUS.OK) return r
				scanned++
				const b = r.value
				if (b === ZDLE) {
					canCount++
					if (canCount >= CAN_ABORT_COUNT) return { status: STATUS.ERR_ABORTED }
					if (state === 1) {
						state = 2
					} else {
						state = 0
					}
					continue
				}
				canCount = 0
				if (state === 0) {
					if (b === ZPAD) state = 1
					continue
				}
				if (state === 1) {
					if (b === ZPAD) continue
					state = 0
					continue
				}
				// state === 2: ZPAD ... ZDLE 后紧跟格式字节
				if (b === ZHEX) {
					const raw = new Uint8Array(7)
					for (let i = 0; i < 7; i++) {
						const hi = await readByte()
						if (hi.status !== STATUS.OK) return hi
						const lo = await readByte()
						if (lo.status !== STATUS.OK) return lo
						const h = hexToNibble(hi.value)
						const l = hexToNibble(lo.value)
						if (h < 0 || l < 0) return { status: STATUS.ERR_CRC }
						raw[i] = (h << 4) | l
					}
					// 吸收可选 \r \n XON
					const eol1 = await readByte()
					if (eol1.status === STATUS.OK && (eol1.value & 0x7f) === 0x0d) {
						await readByte()
					}
					const calc = crc16(raw.subarray(0, 5))
					const recv = ((raw[5] << 8) | raw[6]) & 0xffff
					if (calc !== recv) return { status: STATUS.ERR_CRC }
					const p = [raw[1], raw[2], raw[3], raw[4]]
					const type = raw[0]
					if (type === FRAME.ZCAN || type === FRAME.ZABORT || type === FRAME.ZFERR || type === FRAME.ZSKIP) {
						return { status: STATUS.ERR_ABORTED, header: { type, format: ZHEX, p, pos: packPosLe(p) } }
					}
					return { status: STATUS.OK, header: { type, format: ZHEX, p, pos: packPosLe(p) } }
				}
				if (b === ZBIN32) {
					const raw = new Uint8Array(9)
					const wire = { count: 0, max: 24 }
					for (let i = 0; i < 9; i++) {
						const it = await readZdleItem(wire)
						if (it.status !== STATUS.OK) return it
						if (it.frameEnd) return { status: STATUS.ERR_ESCAPE }
						raw[i] = it.byte
					}
					const calc = crc32(raw.subarray(0, 5))
					const recv = packPosLe(raw.subarray(5, 9))
					if (calc !== recv) return { status: STATUS.ERR_CRC }
					const p = [raw[1], raw[2], raw[3], raw[4]]
					const type = raw[0]
					if (type === FRAME.ZCAN || type === FRAME.ZABORT || type === FRAME.ZFERR || type === FRAME.ZSKIP) {
						return { status: STATUS.ERR_ABORTED, header: { type, format: ZBIN32, p, pos: packPosLe(p) } }
					}
					return { status: STATUS.OK, header: { type, format: ZBIN32, p, pos: packPosLe(p) } }
				}
				if (b === ZBIN) {
					return { status: STATUS.ERR_UNSUPPORTED }
				}
				state = (b === ZPAD) ? 1 : 0
			}
			return { status: STATUS.ERR_PROTOCOL }
		}

		async function readSubpacketCrcw(maxLen) {
			const out = []
			const wire = { count: 0, max: maxLen * 2 + 12 }
			while (true) {
				const it = await readZdleItem(wire)
				if (it.status !== STATUS.OK) return it
				if (it.frameEnd) {
					if (it.frameEnd !== ZCRCW) return { status: STATUS.ERR_UNSUPPORTED }
					const crcRaw = new Uint8Array(4)
					for (let i = 0; i < 4; i++) {
						const cIt = await readZdleItem(wire)
						if (cIt.status !== STATUS.OK) return cIt
						if (cIt.frameEnd) return { status: STATUS.ERR_ESCAPE }
						crcRaw[i] = cIt.byte
					}
					const dataU8 = Uint8Array.from(out)
					let calc = crc32Update(0, dataU8)
					calc = crc32Update(calc, Uint8Array.from([ZCRCW]))
					const recv = packPosLe(crcRaw)
					if (calc !== recv) return { status: STATUS.ERR_CRC }
					return { status: STATUS.OK, data: dataU8 }
				}
				if (out.length >= maxLen) return { status: STATUS.ERR_OVERFLOW }
				out.push(it.byte)
			}
		}

		return { readByte, readHeader, readSubpacketCrcw, remainingMs, resetSessionClock, checkAbort }
	}

	function isFatal(st) {
		return st === STATUS.ERR_IO || st === STATUS.ERR_ABORTED || st === STATUS.ERR_UNSUPPORTED || st === STATUS.ERR_OVERFLOW
	}

	// 发送端（Proxy → MCU）：支持 totalSize > 0（第 1~3 轮纯 JSON body）和 totalSize === 0（第 4 轮 HTTP 204 空传输）
	async function send(io, file, opts) {
		const cfg = normalizeOpts(opts)
		const data = file && file.data ? (file.data instanceof Uint8Array ? file.data : Uint8Array.from(file.data)) : new Uint8Array(0)
		const totalSize = data.length
		const fileName = (file && file.fileName) ? String(file.fileName) : 'response.json'
		const reader = createReader(io, cfg)
		let retries = 0
		let totalRetries = 0
		let subLen = cfg.maxSubpacketLen
		let useEscapeCtrl = cfg.escapeCtrl

		async function write(u8) {
			reader.checkAbort()
			try {
				await io.writeBytes(u8)
			} catch (e) {
				throw makeErr(STATUS.ERR_IO, 'ZMODEM 写入失败: ' + (e && e.message ? e.message : e))
			}
		}

		function handleFailure(st, msg) {
			if (isFatal(st)) {
				if (st !== STATUS.ERR_IO && st !== STATUS.ERR_ABORTED) return sendAbort(io).then(() => { throw makeErr(st, msg) })
				throw makeErr(st, msg)
			}
			if (reader.remainingMs() <= 0) {
				return sendAbort(io).then(() => { throw makeErr(STATUS.ERR_TIMEOUT, 'ZMODEM 会话超时') })
			}
			if (retries >= cfg.maxRetries) {
				return sendAbort(io).then(() => { throw makeErr(st || STATUS.ERR_RETRY, msg || 'ZMODEM 重试耗尽') })
			}
			retries++
			totalRetries++
			return null
		}

		// 阶段 1: 发 ZRQINIT 等待对端 ZRINIT（要求支持 CANFC32）
		while (true) {
			await write(encodeHexHeader(FRAME.ZRQINIT, 0))
			const res = await reader.readHeader()
			if (res.status === STATUS.OK && res.header.type === FRAME.ZRINIT) {
				const flags = res.header.p[3]
				if ((flags & CANFC32) === 0) {
					await sendAbort(io)
					throw makeErr(STATUS.ERR_UNSUPPORTED, '对端不支持 ZMODEM CRC32 (CANFC32)')
				}
				const peerBuf = (res.header.p[0] | (res.header.p[1] << 8)) & 0xffff
				if (peerBuf > 0 && peerBuf < subLen) subLen = peerBuf
				if (flags & ESCCTL) useEscapeCtrl = true
				retries = 0
				break
			}
			const fail = handleFailure(res.status === STATUS.OK ? STATUS.ERR_PROTOCOL : res.status, '等待 ZRINIT 失败')
			if (fail) await fail
		}

		// 阶段 2: 发 ZFILE + 元信息子包，等待 ZRPOS(0)
		const meta = encodeFileMeta(fileName, totalSize)
		while (true) {
			await write(encodeBin32Header(FRAME.ZFILE, (ZCBIN << 24) >>> 0, useEscapeCtrl))
			await write(encodeSubpacketCrcw(meta, useEscapeCtrl))
			const res = await reader.readHeader()
			if (res.status === STATUS.OK) {
				if (res.header.type === FRAME.ZRPOS) {
					if (res.header.pos !== 0) {
						await sendAbort(io)
						throw makeErr(STATUS.ERR_OFFSET, 'ZFILE 收到非零 ZRPOS: ' + res.header.pos)
					}
					retries = 0
					break
				}
				if (res.header.type === FRAME.ZRINIT) {
					const fail = handleFailure(STATUS.ERR_RETRY, '对端重发 ZRINIT')
					if (fail) await fail
					continue
				}
			}
			const fail = handleFailure(res.status === STATUS.OK ? STATUS.ERR_PROTOCOL : res.status, 'ZFILE 握手失败')
			if (fail) await fail
		}

		// 阶段 3 & 4: ZDATA + ZCRCW 停等数据块，然后 ZEOF(totalSize) 等待 ZRINIT
		let offset = 0
		let maxSentOffset = 0
		while (true) {
			while (offset < totalSize) {
				const end = Math.min(totalSize, offset + subLen)
				const chunk = data.subarray(offset, end)
				await write(encodeBin32Header(FRAME.ZDATA, offset, useEscapeCtrl))
				await write(encodeSubpacketCrcw(chunk, useEscapeCtrl))
				if (end > maxSentOffset) maxSentOffset = end
				const res = await reader.readHeader()
				if (res.status === STATUS.OK) {
					if (res.header.type === FRAME.ZACK && res.header.pos === end) {
						offset = end
						retries = 0
						if (opts && typeof opts.onProgress === 'function') {
							opts.onProgress({ transferredBytes: offset, totalBytes: totalSize })
						}
						continue
					}
					if (res.header.type === FRAME.ZACK || res.header.type === FRAME.ZRPOS) {
						if (res.header.pos > maxSentOffset) {
							await sendAbort(io)
							throw makeErr(res.header.pos > totalSize ? STATUS.ERR_EOF : STATUS.ERR_OFFSET, '对端偏移越界')
						}
						offset = res.header.pos
						const fail = handleFailure(STATUS.ERR_RETRY, '对端请求重传偏移 ' + offset)
						if (fail) await fail
						continue
					}
					if (res.header.type === FRAME.ZNAK) {
						const fail = handleFailure(STATUS.ERR_CRC, '对端回 ZNAK')
						if (fail) await fail
						continue
					}
				}
				const fail = handleFailure(res.status === STATUS.OK ? STATUS.ERR_PROTOCOL : res.status, 'ZDATA 应答异常')
				if (fail) await fail
			}

			// ZEOF(totalSize)
			await write(encodeBin32Header(FRAME.ZEOF, totalSize, useEscapeCtrl))
			const eofRes = await reader.readHeader()
			if (eofRes.status === STATUS.OK) {
				if (eofRes.header.type === FRAME.ZRINIT) {
					retries = 0
					break
				}
				if (eofRes.header.type === FRAME.ZRPOS) {
					if (eofRes.header.pos > totalSize) {
						await sendAbort(io)
						throw makeErr(STATUS.ERR_EOF, 'ZEOF 收到非法 ZRPOS')
					}
					offset = eofRes.header.pos
					const fail = handleFailure(STATUS.ERR_RETRY, 'ZEOF 后重传')
					if (fail) await fail
					continue
				}
			}
			const fail = handleFailure(eofRes.status === STATUS.OK ? STATUS.ERR_PROTOCOL : eofRes.status, '等待 ZEOF 确认失败')
			if (fail) await fail
		}

		// 阶段 5: ZFIN 握手 + "OO"
		while (true) {
			await write(encodeHexHeader(FRAME.ZFIN, 0))
			const res = await reader.readHeader()
			if (res.status === STATUS.OK && res.header.type === FRAME.ZFIN) {
				await write(OVER_AND_OUT)
				return { fileName, transferredBytes: totalSize, totalBytes: totalSize, retriesUsed: totalRetries }
			}
			const fail = handleFailure(res.status === STATUS.OK ? STATUS.ERR_PROTOCOL : res.status, 'ZFIN 握手失败')
			if (fail) await fail
		}
	}

	// 接收端（MCU → Proxy）：接收相对路径 fileName 与请求 JSON 字节
	async function receive(io, opts) {
		const cfg = normalizeOpts(opts)
		const reader = createReader(io, cfg)
		const zrinitPos = makeZrinitPos(cfg.maxSubpacketLen, cfg.escapeCtrl)
		let retries = 0
		let totalRetries = 0
		let fileName = ''
		let expectedSize = 0
		let hasExpectedSize = false

		async function write(u8) {
			reader.checkAbort()
			try {
				await io.writeBytes(u8)
			} catch (e) {
				throw makeErr(STATUS.ERR_IO, 'ZMODEM 写入失败: ' + (e && e.message ? e.message : e))
			}
		}

		function handleFailure(st, msg) {
			if (isFatal(st)) {
				if (st !== STATUS.ERR_IO && st !== STATUS.ERR_ABORTED) return sendAbort(io).then(() => { throw makeErr(st, msg) })
				throw makeErr(st, msg)
			}
			if (reader.remainingMs() <= 0) {
				return sendAbort(io).then(() => { throw makeErr(STATUS.ERR_TIMEOUT, 'ZMODEM 接收超时') })
			}
			if (retries >= cfg.maxRetries) {
				return sendAbort(io).then(() => { throw makeErr(st || STATUS.ERR_RETRY, msg || 'ZMODEM 接收重试耗尽') })
			}
			retries++
			totalRetries++
			return null
		}

		// 阶段 1: 发 ZRINIT 等待 ZFILE
		// 若配置了 initialWaitMs，在收到首个有效帧头前只受 initialWaitMs 约束，不计入 maxRetries，不提前发 CAN*5，
		// 且等待期间不重复刷发 ZRINIT（避免在长等待期把串口/BLE 缓冲灌满 ZRINIT 导致对端连发重复 ZFILE）
		await write(encodeHexHeader(FRAME.ZRINIT, zrinitPos))
		let firstZrqinitAbsorbed = false
		let seenFirstHeader = false
		let hadInitialIdleTimeout = false
		const initialDeadlineMs = cfg.initialWaitMs > 0 ? (cfg.nowMs() + cfg.initialWaitMs) : null
		while (true) {
			const waitingInitial = !seenFirstHeader && initialDeadlineMs != null
			const res = await reader.readHeader(waitingInitial ? initialDeadlineMs : null)
			if (res.status === STATUS.OK) {
				const firstArrival = !seenFirstHeader
				if (firstArrival) {
					seenFirstHeader = true
					if (initialDeadlineMs != null) reader.resetSessionClock()
				}
				if (res.header.type === FRAME.ZRQINIT) {
					if (firstArrival && hadInitialIdleTimeout) {
						// 经历过长等待说明首帧 ZRINIT 发出时对端尚未就绪，立刻回一次 ZRINIT（不计入重试）
						firstZrqinitAbsorbed = true
						await write(encodeHexHeader(FRAME.ZRINIT, zrinitPos))
						continue
					}
					if (!firstZrqinitAbsorbed) {
						firstZrqinitAbsorbed = true
						continue
					}
					const fail = handleFailure(STATUS.ERR_RETRY, '重复 ZRQINIT')
					if (fail) await fail
					await write(encodeHexHeader(FRAME.ZRINIT, zrinitPos))
					continue
				}
				if (res.header.type === FRAME.ZSINIT) {
					if (res.header.format !== ZBIN32 || (res.header.p[3] & ESC8)) {
						await sendAbort(io)
						throw makeErr(STATUS.ERR_UNSUPPORTED, '不支持的 ZSINIT')
					}
					const sub = await reader.readSubpacketCrcw(128)
					if (sub.status === STATUS.OK) {
						await write(encodeHexHeader(FRAME.ZACK, 0))
						continue
					}
					const fail = handleFailure(sub.status, 'ZSINIT 子包错误')
					if (fail) await fail
					await write(encodeHexHeader(FRAME.ZRINIT, zrinitPos))
					continue
				}
				if (res.header.type === FRAME.ZFILE) {
					if (res.header.format !== ZBIN32) {
						await sendAbort(io)
						throw makeErr(STATUS.ERR_UNSUPPORTED, '仅支持 ZBIN32 格式 ZFILE')
					}
					const sub = await reader.readSubpacketCrcw(128)
					if (sub.status === STATUS.OK) {
						let meta
						try {
							meta = parseFileMeta(sub.data)
						} catch (e) {
							await sendAbort(io)
							throw e
						}
						fileName = meta.fileName
						expectedSize = meta.expectedSize
						hasExpectedSize = meta.hasExpectedSize
						if (cfg.maxFileSize > 0 && hasExpectedSize && expectedSize > cfg.maxFileSize) {
							await sendAbort(io)
							throw makeErr(STATUS.ERR_EOF, '接收文件超出上限')
						}
						retries = 0
						await write(encodeHexHeader(FRAME.ZRPOS, 0))
						break
					}
					const fail = handleFailure(sub.status, 'ZFILE 元信息子包错误')
					if (fail) await fail
					await write(encodeHexHeader(FRAME.ZRINIT, zrinitPos))
					continue
				}
			}
			if (waitingInitial && res.status === STATUS.ERR_TIMEOUT) {
				if (reader.remainingMs(initialDeadlineMs) <= 0) {
					throw makeErr(STATUS.ERR_TIMEOUT, '等待 MCU 发起 ZMODEM 传输超时')
				}
				hadInitialIdleTimeout = true
				continue
			}
			const fail = handleFailure(res.status === STATUS.OK ? STATUS.ERR_PROTOCOL : res.status, '等待 ZFILE 失败')
			if (fail) await fail
			await write(encodeHexHeader(FRAME.ZRINIT, zrinitPos))
		}

		// 阶段 2: 接收 ZDATA + ZCRCW 直到 ZEOF
		const chunks = []
		let confirmedOffset = 0
		while (true) {
			let retryType = FRAME.ZRPOS
			const res = await reader.readHeader()
			if (res.status === STATUS.OK) {
				if (res.header.type === FRAME.ZDATA) {
					if (res.header.format !== ZBIN32) {
						await sendAbort(io)
						throw makeErr(STATUS.ERR_UNSUPPORTED, '仅支持 ZBIN32 格式 ZDATA')
					}
					const frameOffset = res.header.pos
					const sub = await reader.readSubpacketCrcw(cfg.maxSubpacketLen)
					if (sub.status === STATUS.OK) {
						const endOffset = frameOffset + sub.data.length
						if (frameOffset > confirmedOffset) {
							const fail = handleFailure(STATUS.ERR_OFFSET, '数据偏移跳跃')
							if (fail) await fail
							await write(encodeHexHeader(FRAME.ZRPOS, confirmedOffset))
							continue
						}
						if (endOffset <= confirmedOffset) {
							retryType = endOffset === confirmedOffset ? FRAME.ZACK : FRAME.ZRPOS
							const fail = handleFailure(STATUS.ERR_RETRY, '重复 ZDATA 块')
							if (fail) await fail
							await write(encodeHexHeader(retryType, confirmedOffset))
							continue
						}
						const skip = confirmedOffset - frameOffset
						const newPart = skip > 0 ? sub.data.subarray(skip) : sub.data
						if (hasExpectedSize && endOffset > expectedSize) {
							await sendAbort(io)
							throw makeErr(STATUS.ERR_EOF, '接收数据超过声明长度')
						}
						if (cfg.maxFileSize > 0 && endOffset > cfg.maxFileSize) {
							await sendAbort(io)
							throw makeErr(STATUS.ERR_EOF, '接收数据超过上限')
						}
						chunks.push(newPart)
						confirmedOffset = endOffset
						retries = 0
						if (opts && typeof opts.onProgress === 'function') {
							opts.onProgress({ transferredBytes: confirmedOffset, totalBytes: hasExpectedSize ? expectedSize : 0 })
						}
						await write(encodeHexHeader(FRAME.ZACK, confirmedOffset))
						continue
					}
					const fail = handleFailure(sub.status, 'ZDATA 子包校验失败')
					if (fail) await fail
					await write(encodeHexHeader(FRAME.ZRPOS, confirmedOffset))
					continue
				}
				if (res.header.type === FRAME.ZEOF) {
					if (res.header.pos < confirmedOffset || (hasExpectedSize && res.header.pos !== expectedSize)) {
						await sendAbort(io)
						throw makeErr(STATUS.ERR_EOF, 'ZEOF 偏移不匹配')
					}
					if (res.header.pos > confirmedOffset) {
						const fail = handleFailure(STATUS.ERR_EOF, '提前收到 ZEOF')
						if (fail) await fail
						await write(encodeHexHeader(FRAME.ZRPOS, confirmedOffset))
						continue
					}
					retries = 0
					await write(encodeHexHeader(FRAME.ZRINIT, zrinitPos))
					break
				}
				if (res.header.type === FRAME.ZFILE && confirmedOffset === 0) {
					await reader.readSubpacketCrcw(128)
					const fail = handleFailure(STATUS.ERR_RETRY, '重复 ZFILE')
					if (fail) await fail
					await write(encodeHexHeader(FRAME.ZRPOS, 0))
					continue
				}
			}
			const fail = handleFailure(res.status === STATUS.OK ? STATUS.ERR_PROTOCOL : res.status, 'ZDATA 阶段异常')
			if (fail) await fail
			await write(encodeHexHeader(retryType, confirmedOffset))
		}

		// 阶段 3: 等待 ZFIN -> 回复 ZFIN -> 尝试吸收 "OO"
		while (true) {
			const res = await reader.readHeader()
			if (res.status === STATUS.OK && res.header.type === FRAME.ZFIN) {
				await write(encodeHexHeader(FRAME.ZFIN, 0))
				// 短暂吸收 "OO"（可选，不作为失败判据）
				try {
					const b1 = await io.readByte(Math.min(300, cfg.readTimeoutMs))
					if (b1 === 0x4F) await io.readByte(Math.min(300, cfg.readTimeoutMs))
				} catch (e) {}
				break
			}
			if (res.status === STATUS.OK && res.header.type === FRAME.ZEOF && res.header.pos === confirmedOffset) {
				const fail = handleFailure(STATUS.ERR_RETRY, '重复 ZEOF')
				if (fail) await fail
				await write(encodeHexHeader(FRAME.ZRINIT, zrinitPos))
				continue
			}
			const fail = handleFailure(res.status === STATUS.OK ? STATUS.ERR_PROTOCOL : res.status, '等待 ZFIN 失败')
			if (fail) await fail
			await write(encodeHexHeader(FRAME.ZRINIT, zrinitPos))
		}

		const data = new Uint8Array(confirmedOffset)
		let off = 0
		for (let i = 0; i < chunks.length; i++) {
			data.set(chunks[i], off)
			off += chunks[i].length
		}
		return { fileName, data, expectedSize, hasExpectedSize, retriesUsed: totalRetries }
	}

	const api = {
		ZPAD, ZDLE, ZBIN, ZHEX, ZBIN32,
		FRAME, ZCRCW, CANFDX, CANFC32, ESCCTL, ZCBIN,
		MAX_SUBPACKET_LEN, CAN_ABORT_COUNT, ABORT_SEQ,
		STATUS,
		crc16, crc32, crc32Update,
		zdleEscape, encodeHexHeader, encodeBin32Header, encodeSubpacketCrcw,
		encodeFileMeta, parseFileMeta, makeZrinitPos,
		createByteQueue, sendAbort, send, receive,
	}

	if (typeof module !== 'undefined' && module.exports) module.exports = api
	root.Zmodem = api
})(typeof window !== 'undefined' ? window : globalThis)
