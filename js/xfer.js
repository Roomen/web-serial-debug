// 近端 XFER (0xA5 0x5A) 轻量主从分片传输协议纯逻辑实现：与固件 Protocol/xfer/xfer.c 逐字节对齐
// 帧格式: magic(2B=0xA5 0x5A) + bodyLen(2B LE=4+payloadLen) + op(1B) + argOrStatus(1B) + sessionId(2B LE) + payload + crc32(4B LE IEEE 802.3)
// 不依赖 DOM 或 serialApi，可在 Node 直接单测（module.exports）并在浏览器挂到 window.Xfer
;(function (root) {
	'use strict'

	const MAGIC_0 = 0xA5
	const MAGIC_1 = 0x5A
	const MAX_CHUNK_LEN = 700
	const MAX_META_LEN = 96
	const FRAME_OVERHEAD = 8 // 2B magic + 2B bodyLen + 4B crc32
	const MAX_BODY_LEN = 4 + 6 + MAX_CHUNK_LEN // 710
	const MAX_FRAME_LEN = FRAME_OVERHEAD + MAX_BODY_LEN // 718
	const MAX_SCAN_BYTES = 4096

	const OP = Object.freeze({
		OPEN: 0x01,
		DATA: 0x02,
		PULL: 0x03,
		COMMIT: 0x04,
		QUERY: 0x05,
		ABORT: 0x06,
		OPEN_ACK: 0x81,
		DATA_ACK: 0x82,
		PULL_ACK: 0x83,
		COMMIT_ACK: 0x84,
		QUERY_ACK: 0x85,
		ABORT_ACK: 0x86,
	})

	const DIR = Object.freeze({
		PUSH: 0,
		PULL: 1,
	})

	const TARGET = Object.freeze({
		NONE: 0,
		ESIM_REQ: 1,
		ESIM_RSP: 2,
		ESIM_NTF: 3,
		CERT_CA: 16,
		CERT_CLIENT: 17,
		CERT_KEY: 18,
		FILE: 32,
	})

	const STATUS = Object.freeze({
		OK: 0,
		BAD_FRAME: 1,
		BAD_PARAM: 2,
		BUSY: 3,
		NO_SESSION: 4,
		OFFSET_ERR: 5,
		CRC_ERR: 6,
		BACKEND_ERR: 7,
		EOF_INCOMPLETE: 8,
	})

	const STATUS_LABELS = Object.freeze({
		0: 'OK',
		1: '帧格式错误 (BAD_FRAME)',
		2: '参数非法 (BAD_PARAM)',
		3: '会话忙/阶段未就绪 (BUSY)',
		4: '无活动会话 (NO_SESSION)',
		5: '偏移错位 (OFFSET_ERR)',
		6: 'CRC32 校验错 (CRC_ERR)',
		7: '后端执行失败 (BACKEND_ERR)',
		8: '数据未收齐 (EOF_INCOMPLETE)',
	})

	const ERR = Object.freeze({
		ERR_ARG: 'ERR_ARG',
		ERR_TIMEOUT: 'ERR_TIMEOUT',
		ERR_IO: 'ERR_IO',
		ERR_CRC: 'ERR_CRC',
		ERR_PROTOCOL: 'ERR_PROTOCOL',
		ERR_ABORTED: 'ERR_ABORTED',
		ERR_STATUS: 'ERR_STATUS',
		ERR_RETRY: 'ERR_RETRY',
	})

	const CRC32_NIBBLE = [
		0x00000000, 0x1DB71064, 0x3B6E20C8, 0x26D930AC,
		0x76DC4190, 0x6B6B51F4, 0x4DB26158, 0x5005713C,
		0xEDB88320, 0xF00F9344, 0xD6D6A3E8, 0xCB61B38C,
		0x9B64C2B0, 0x86D3D2D4, 0xA00AE278, 0xBDBDF21C,
	]

	function crc32Update(crc, data) {
		let c = ((crc >>> 0) ^ 0xFFFFFFFF) >>> 0
		for (let i = 0; i < data.length; i++) {
			const b = data[i] & 0xff
			c = (CRC32_NIBBLE[(c ^ b) & 0x0F] ^ (c >>> 4)) >>> 0
			c = (CRC32_NIBBLE[(c ^ (b >>> 4)) & 0x0F] ^ (c >>> 4)) >>> 0
		}
		return (c ^ 0xFFFFFFFF) >>> 0
	}

	function crc32(data) {
		return crc32Update(0, data)
	}

	function rdU16(buf, off) {
		return ((buf[off] & 0xff) | ((buf[off + 1] & 0xff) << 8)) >>> 0
	}

	function rdU32(buf, off) {
		return ((buf[off] & 0xff)
			| ((buf[off + 1] & 0xff) << 8)
			| ((buf[off + 2] & 0xff) << 16)
			| ((buf[off + 3] & 0xff) << 24)) >>> 0
	}

	function wrU16(buf, off, v) {
		buf[off] = v & 0xff
		buf[off + 1] = (v >>> 8) & 0xff
	}

	function wrU32(buf, off, v) {
		buf[off] = v & 0xff
		buf[off + 1] = (v >>> 8) & 0xff
		buf[off + 2] = (v >>> 16) & 0xff
		buf[off + 3] = (v >>> 24) & 0xff
	}

	function toU8(v) {
		if (!v || !v.length) return new Uint8Array(0)
		return v instanceof Uint8Array ? v : Uint8Array.from(v)
	}

	function makeErr(code, message, extra) {
		const err = new Error(message || code)
		err.xferCode = code
		if (extra) Object.assign(err, extra)
		return err
	}

	function packFrame(op, argOrStatus, sessionId, payload) {
		const pay = toU8(payload)
		const bodyLen = 4 + pay.length
		if (bodyLen > MAX_BODY_LEN) {
			throw makeErr(ERR.ERR_ARG, 'XFER 载荷超出上限: ' + pay.length)
		}
		const out = new Uint8Array(FRAME_OVERHEAD + bodyLen)
		out[0] = MAGIC_0
		out[1] = MAGIC_1
		wrU16(out, 2, bodyLen)
		out[4] = op & 0xff
		out[5] = argOrStatus & 0xff
		wrU16(out, 6, sessionId & 0xffff)
		if (pay.length) out.set(pay, 8)
		wrU32(out, 4 + bodyLen, crc32(out.subarray(0, 4 + bodyLen)))
		return out
	}

	function peekFrame(buf, offset, maxFrameCap) {
		const off = offset || 0
		const cap = maxFrameCap || MAX_FRAME_LEN
		const rem = buf ? (buf.length - off) : 0
		if (rem <= 0 || buf[off] !== MAGIC_0 || (rem >= 2 && buf[off + 1] !== MAGIC_1)) {
			return { status: 'none', frameLen: 0 }
		}
		if (rem < 4) return { status: 'incomplete', frameLen: 0 }
		const bodyLen = rdU16(buf, off + 2)
		const frameLen = FRAME_OVERHEAD + bodyLen
		if (bodyLen < 4 || frameLen > cap) {
			return { status: 'corrupt', frameLen: 0 }
		}
		if (rem < frameLen) return { status: 'incomplete', frameLen }
		const calc = crc32(buf.subarray(off, off + 4 + bodyLen))
		const recv = rdU32(buf, off + 4 + bodyLen)
		if (calc !== recv) return { status: 'corrupt', frameLen: 0 }
		return { status: 'ready', frameLen }
	}

	function unpackFrame(raw) {
		const u8 = toU8(raw)
		const pk = peekFrame(u8, 0, MAX_FRAME_LEN)
		if (pk.status !== 'ready') {
			return { ok: false, error: pk.status }
		}
		const bodyLen = rdU16(u8, 2)
		return {
			ok: true,
			op: u8[4] & 0xff,
			argOrStatus: u8[5] & 0xff,
			sessionId: rdU16(u8, 6),
			payload: u8.slice(8, 4 + bodyLen),
			frameLen: pk.frameLen,
		}
	}

	function buildOpen(opts) {
		opts = opts || {}
		const meta = toU8(opts.meta)
		if (meta.length > MAX_META_LEN) throw makeErr(ERR.ERR_ARG, 'XFER OPEN meta 超长: ' + meta.length)
		const pay = new Uint8Array(14 + meta.length)
		pay[0] = (opts.target || 0) & 0xff
		wrU16(pay, 1, (opts.reqMaxChunk || MAX_CHUNK_LEN) & 0xffff)
		wrU32(pay, 3, (opts.totalSize || 0) >>> 0)
		wrU32(pay, 7, (opts.expectedCrc32 || 0) >>> 0)
		wrU16(pay, 11, (opts.metaParam || 0) & 0xffff)
		pay[13] = meta.length & 0xff
		if (meta.length) pay.set(meta, 14)
		return packFrame(OP.OPEN, opts.dir & 0xff, opts.sessionId & 0xffff, pay)
	}

	function buildData(opts) {
		opts = opts || {}
		const data = toU8(opts.data)
		if (data.length === 0 || data.length > MAX_CHUNK_LEN) {
			throw makeErr(ERR.ERR_ARG, 'XFER DATA 块长非法: ' + data.length)
		}
		const pay = new Uint8Array(6 + data.length)
		wrU32(pay, 0, (opts.offset || 0) >>> 0)
		wrU16(pay, 4, data.length & 0xffff)
		pay.set(data, 6)
		return packFrame(OP.DATA, 0, opts.sessionId & 0xffff, pay)
	}

	function buildPull(opts) {
		opts = opts || {}
		const pay = new Uint8Array(6)
		wrU32(pay, 0, (opts.offset || 0) >>> 0)
		wrU16(pay, 4, (opts.reqLen || MAX_CHUNK_LEN) & 0xffff)
		return packFrame(OP.PULL, 0, opts.sessionId & 0xffff, pay)
	}

	function buildCommit(opts) {
		opts = opts || {}
		const pay = new Uint8Array(2)
		wrU16(pay, 0, (opts.commitParam || 0) & 0xffff)
		return packFrame(OP.COMMIT, 0, opts.sessionId & 0xffff, pay)
	}

	function buildQuery(opts) {
		opts = opts || {}
		return packFrame(OP.QUERY, 0, (opts.sessionId || 0) & 0xffff, new Uint8Array(0))
	}

	function buildAbort(opts) {
		opts = opts || {}
		const pay = new Uint8Array(2)
		wrU16(pay, 0, (opts.reason || 0) & 0xffff)
		return packFrame(OP.ABORT, 0, (opts.sessionId || 0) & 0xffff, pay)
	}

	function parseOpenAck(payload) {
		const u8 = toU8(payload)
		if (u8.length < 13) throw makeErr(ERR.ERR_PROTOCOL, 'OPEN_ACK 载荷过短: ' + u8.length)
		const metaLen = u8[12] & 0xff
		if (metaLen > MAX_META_LEN || u8.length < 13 + metaLen) {
			throw makeErr(ERR.ERR_PROTOCOL, 'OPEN_ACK meta 长度不合法')
		}
		return {
			agreedChunk: rdU16(u8, 0),
			totalSize: rdU32(u8, 2),
			totalCrc32: rdU32(u8, 6),
			metaParam: rdU16(u8, 10),
			metaLen,
			meta: u8.slice(13, 13 + metaLen),
		}
	}

	function parseDataAck(payload) {
		const u8 = toU8(payload)
		if (u8.length < 4) throw makeErr(ERR.ERR_PROTOCOL, 'DATA_ACK 载荷过短: ' + u8.length)
		return { ackedOffset: rdU32(u8, 0) }
	}

	function parsePullAck(payload) {
		const u8 = toU8(payload)
		if (u8.length < 6) throw makeErr(ERR.ERR_PROTOCOL, 'PULL_ACK 载荷过短: ' + u8.length)
		const offset = rdU32(u8, 0)
		const len = rdU16(u8, 4)
		if (u8.length < 6 + len) throw makeErr(ERR.ERR_PROTOCOL, 'PULL_ACK 数据截断')
		return { offset, len, data: u8.slice(6, 6 + len) }
	}

	function parseCommitAck(payload) {
		const u8 = toU8(payload)
		if (u8.length < 2) throw makeErr(ERR.ERR_PROTOCOL, 'COMMIT_ACK 载荷过短: ' + u8.length)
		return { resultCode: rdU16(u8, 0) }
	}

	function parseQueryAck(payload, sessionId) {
		const u8 = toU8(payload)
		if (u8.length < 16) throw makeErr(ERR.ERR_PROTOCOL, 'QUERY_ACK 载荷过短: ' + u8.length)
		return {
			active: u8[0] & 0xff,
			target: u8[1] & 0xff,
			dir: u8[2] & 0xff,
			metaParam: rdU16(u8, 4),
			agreedChunk: rdU16(u8, 6),
			totalSize: rdU32(u8, 8),
			ackedOffset: rdU32(u8, 12),
			sessionId: (sessionId || 0) & 0xffff,
		}
	}

	// 将推送式串口/BLE 接收流桥接为按字节带超时的异步读取接口
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
			closedErr = err || makeErr(ERR.ERR_IO, '通信链路已断开')
			if (!closedErr.xferCode) closedErr.xferCode = ERR.ERR_IO
			while (waiters.length) {
				const w = waiters.shift()
				clearTimeout(w.timer)
				w.reject(closedErr)
			}
		}

		function reset() {
			closedErr = null
			buf.length = 0
			head = 0
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

		return { push, fail, clear, reset, readByte }
	}

	function sleep(ms, signal) {
		return new Promise(function (resolve, reject) {
			if (signal && signal.aborted) {
				reject(makeErr(ERR.ERR_ABORTED, 'XFER 操作已取消'))
				return
			}
			const t = setTimeout(function () {
				if (signal) signal.removeEventListener('abort', onAbort)
				resolve()
			}, Math.max(1, ms || 1))
			function onAbort() {
				clearTimeout(t)
				reject(makeErr(ERR.ERR_ABORTED, 'XFER 操作已取消'))
			}
			if (signal) signal.addEventListener('abort', onAbort, { once: true })
		})
	}

	function checkAbort(signal) {
		if (signal && signal.aborted) {
			throw makeErr(ERR.ERR_ABORTED, 'XFER 操作已取消')
		}
	}

	async function readByteWithSignal(io, waitMs, signal) {
		checkAbort(signal)
		if (!signal) {
			try {
				return await io.readByte(waitMs)
			} catch (e) {
				throw makeErr(ERR.ERR_IO, e && e.message ? e.message : 'XFER 读链路断开', { cause: e })
			}
		}
		return new Promise(function (resolve, reject) {
			let settled = false
			function onAbort() {
				if (settled) return
				settled = true
				reject(makeErr(ERR.ERR_ABORTED, 'XFER 操作已取消'))
			}
			signal.addEventListener('abort', onAbort, { once: true })
			Promise.resolve().then(function () {
				return io.readByte(waitMs)
			}).then(
				function (v) {
					if (settled) return
					settled = true
					signal.removeEventListener('abort', onAbort)
					resolve(v)
				},
				function (e) {
					if (settled) return
					settled = true
					signal.removeEventListener('abort', onAbort)
					reject(makeErr(ERR.ERR_IO, e && e.message ? e.message : 'XFER 读链路断开', { cause: e }))
				}
			)
		})
	}

	// 在字节流中同步定位下一帧有效 XFER 应答（忽略噪声、TTM 行或并列 SEK 帧）
	async function readFrame(io, opts) {
		opts = opts || {}
		const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : Date.now
		const timeoutMs = Math.max(20, opts.timeoutMs || 5000)
		const signal = opts.signal || null
		const deadline = nowMs() + timeoutMs
		const buf = []
		let scanned = 0

		while (scanned < MAX_SCAN_BYTES) {
			checkAbort(signal)
			const rem = deadline - nowMs()
			if (rem <= 0) throw makeErr(ERR.ERR_TIMEOUT, '等待 XFER 应答超时 (' + timeoutMs + 'ms)')

			const b = await readByteWithSignal(io, Math.min(rem, 500), signal)
			if (b === null || b === undefined) {
				if (nowMs() >= deadline) throw makeErr(ERR.ERR_TIMEOUT, '等待 XFER 应答超时 (' + timeoutMs + 'ms)')
				continue
			}
			scanned++
			buf.push(b & 0xff)

			// 尝试在当前缓冲中对齐 0xA5 0x5A 并检查帧完整性
			while (buf.length > 0) {
				if (buf[0] !== MAGIC_0) {
					buf.shift()
					continue
				}
				if (buf.length === 1) break
				if (buf[1] !== MAGIC_1) {
					buf.shift()
					continue
				}
				if (buf.length < 4) break
				const bodyLen = (buf[2] | (buf[3] << 8)) & 0xffff
				const frameLen = FRAME_OVERHEAD + bodyLen
				if (bodyLen < 4 || frameLen > MAX_FRAME_LEN) {
					buf.shift()
					continue
				}
				if (buf.length < frameLen) break
				const u8 = Uint8Array.from(buf.slice(0, frameLen))
				const parsed = unpackFrame(u8)
				if (parsed.ok) {
					if (opts.expectOp != null && parsed.op !== opts.expectOp) {
						// 收到非期望 op（例如迟到的旧帧），消耗掉继续等待
						buf.splice(0, frameLen)
						continue
					}
					return parsed
				}
				// CRC 校验失败：滑动 1 字节重新同步
				buf.shift()
			}
		}
		throw makeErr(ERR.ERR_PROTOCOL, 'XFER 流同步扫描超出上限，未收到合法帧')
	}

	async function writeBytesSafe(io, bytes, signal) {
		checkAbort(signal)
		try {
			await io.writeBytes(bytes)
		} catch (e) {
			throw makeErr(ERR.ERR_IO, 'XFER 写入失败: ' + (e && e.message ? e.message : e), { cause: e })
		}
	}

	async function transact(io, frameBytes, expectAckOp, opts) {
		opts = opts || {}
		const maxRetries = Math.min(16, Math.max(1, opts.maxRetries || 5))
		const rpcTimeoutMs = Math.max(50, opts.rpcTimeoutMs || 5000)
		const signal = opts.signal || null
		let lastErr = null

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			checkAbort(signal)
			await writeBytesSafe(io, frameBytes, signal)
			try {
				return await readFrame(io, {
					expectOp: expectAckOp,
					timeoutMs: rpcTimeoutMs,
					nowMs: opts.nowMs,
					signal,
				})
			} catch (e) {
				if (e && (e.xferCode === ERR.ERR_IO || e.xferCode === ERR.ERR_ABORTED)) throw e
				lastErr = e
			}
		}
		throw lastErr || makeErr(ERR.ERR_RETRY, 'XFER RPC 重试耗尽')
	}

	async function query(io, opts) {
		opts = opts || {}
		const req = buildQuery({ sessionId: 0 })
		const ack = await transact(io, req, OP.QUERY_ACK, opts)
		if (ack.argOrStatus !== STATUS.OK) {
			throw makeErr(ERR.ERR_STATUS, 'XFER QUERY 返回异常状态: ' + (STATUS_LABELS[ack.argOrStatus] || ack.argOrStatus), {
				xferStatus: ack.argOrStatus,
			})
		}
		return parseQueryAck(ack.payload, ack.sessionId)
	}

	async function sendAbort(io, sessionId, reason, opts) {
		opts = opts || {}
		try {
			const req = buildAbort({ sessionId: sessionId || 0, reason: reason == null ? 0x0B : reason })
			await io.writeBytes(req)
			if (opts.waitAck) {
				await readFrame(io, {
					expectOp: OP.ABORT_ACK,
					timeoutMs: opts.timeoutMs || 1500,
					nowMs: opts.nowMs,
				}).catch(function () {})
			}
		} catch (e) {}
	}

	// PULL 拉取完整对象（支持 OPEN 等待 MCU 就绪、分片重传、CRC32 校验与可选延迟 COMMIT）
	async function pull(io, opts) {
		opts = opts || {}
		const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : Date.now
		const sessionId = (opts.sessionId || 1) & 0xffff
		if (!sessionId) throw makeErr(ERR.ERR_ARG, 'XFER PULL 需要非零 sessionId')
		const target = opts.target & 0xff
		const reqMaxChunk = Math.min(MAX_CHUNK_LEN, Math.max(1, opts.reqMaxChunk || MAX_CHUNK_LEN))
		const rpcTimeoutMs = Math.max(50, opts.rpcTimeoutMs || 5000)
		const openWaitMs = Math.max(rpcTimeoutMs, opts.openWaitMs != null ? opts.openWaitMs : 60000)
		const pollIntervalMs = Math.max(10, opts.pollIntervalMs != null ? opts.pollIntervalMs : 300)
		const maxRetries = Math.min(16, Math.max(1, opts.maxRetries || 5))
		const retryNoSession = opts.retryNoSession !== false
		const signal = opts.signal || null
		const deferCommit = !!opts.deferCommit

		const openFrame = buildOpen({
			dir: DIR.PULL,
			sessionId,
			target,
			reqMaxChunk,
			totalSize: 0,
			expectedCrc32: 0,
			metaParam: opts.metaParam || 0,
			meta: opts.meta || null,
		})

		// 1) OPEN(PULL)：MCU 准备 URC / 模组上电期间可能短暂返回 BUSY/NO_SESSION 或等待超时，按 openWaitMs 预算轮询
		const openDeadline = nowMs() + openWaitMs
		let openInfo = null
		while (true) {
			checkAbort(signal)
			const rem = openDeadline - nowMs()
			if (rem <= 0) {
				throw makeErr(ERR.ERR_TIMEOUT, '等待 MCU XFER PULL 就绪超时 (' + Math.round(openWaitMs / 1000) + 's)')
			}
			await writeBytesSafe(io, openFrame, signal)
			let ack
			try {
				ack = await readFrame(io, {
					expectOp: OP.OPEN_ACK,
					timeoutMs: Math.min(rpcTimeoutMs, rem),
					nowMs,
					signal,
				})
			} catch (e) {
				if (e && (e.xferCode === ERR.ERR_IO || e.xferCode === ERR.ERR_ABORTED)) throw e
				if (nowMs() >= openDeadline) {
					throw makeErr(ERR.ERR_TIMEOUT, '等待 MCU XFER PULL 应答超时 (' + Math.round(openWaitMs / 1000) + 's)')
				}
				continue
			}

			if (ack.argOrStatus === STATUS.OK) {
				openInfo = parseOpenAck(ack.payload)
				break
			}
			if (ack.argOrStatus === STATUS.BUSY || (ack.argOrStatus === STATUS.NO_SESSION && retryNoSession)) {
				if (typeof opts.onOpenWait === 'function') {
					const shouldAbort = await opts.onOpenWait({ status: ack.argOrStatus, remainingMs: openDeadline - nowMs() })
					if (shouldAbort) {
						throw makeErr(ERR.ERR_STATUS, shouldAbort === true ? '设备已结束近端会话' : String(shouldAbort), {
							xferStatus: ack.argOrStatus,
						})
					}
				}
				const left = openDeadline - nowMs()
				if (left <= 0) {
					throw makeErr(ERR.ERR_TIMEOUT, '等待 MCU XFER PULL 就绪超时 (' + Math.round(openWaitMs / 1000) + 's)')
				}
				await sleep(Math.min(pollIntervalMs, left), signal)
				continue
			}
			throw makeErr(ERR.ERR_STATUS, 'XFER OPEN(PULL) 被拒绝: ' + (STATUS_LABELS[ack.argOrStatus] || ack.argOrStatus), {
				xferStatus: ack.argOrStatus,
			})
		}

		// 2) 分片 PULL 拉取载荷
		const agreedChunk = openInfo.agreedChunk > 0 ? Math.min(MAX_CHUNK_LEN, openInfo.agreedChunk) : reqMaxChunk
		const totalSize = openInfo.totalSize
		const data = new Uint8Array(totalSize)
		let offset = 0

		while (offset < totalSize) {
			const reqLen = Math.min(agreedChunk, totalSize - offset)
			const pullFrame = buildPull({ sessionId, offset, reqLen })
			const ack = await transact(io, pullFrame, OP.PULL_ACK, {
				rpcTimeoutMs,
				maxRetries,
				nowMs,
				signal,
			})
			if (ack.argOrStatus !== STATUS.OK) {
				throw makeErr(ERR.ERR_STATUS, 'XFER PULL 失败: ' + (STATUS_LABELS[ack.argOrStatus] || ack.argOrStatus), {
					xferStatus: ack.argOrStatus,
				})
			}
			const chunk = parsePullAck(ack.payload)
			if (chunk.offset !== offset || chunk.len === 0 || offset + chunk.len > totalSize) {
				throw makeErr(ERR.ERR_PROTOCOL, 'XFER PULL_ACK 偏移或长度异常: off=' + chunk.offset + ' len=' + chunk.len)
			}
			data.set(chunk.data, offset)
			offset += chunk.len
			if (typeof opts.onProgress === 'function') {
				opts.onProgress({ transferredBytes: offset, totalBytes: totalSize })
			}
		}

		if (totalSize > 0 && openInfo.totalCrc32 !== 0) {
			const actualCrc = crc32(data)
			if (actualCrc !== openInfo.totalCrc32) {
				throw makeErr(ERR.ERR_CRC, 'XFER PULL 整包 CRC32 校验失败')
			}
		}

		let committed = false
		async function commit(commitParam) {
			if (committed) return { resultCode: 0 }
			const commitFrame = buildCommit({ sessionId, commitParam: commitParam || 0 })
			const ack = await transact(io, commitFrame, OP.COMMIT_ACK, {
				rpcTimeoutMs,
				maxRetries,
				nowMs,
				signal,
			})
			if (ack.argOrStatus !== STATUS.OK) {
				throw makeErr(ERR.ERR_STATUS, 'XFER COMMIT(PULL) 失败: ' + (STATUS_LABELS[ack.argOrStatus] || ack.argOrStatus), {
					xferStatus: ack.argOrStatus,
				})
			}
			committed = true
			return parseCommitAck(ack.payload)
		}

		let commitResult = null
		if (!deferCommit) {
			commitResult = await commit(opts.commitParam || 0)
		}

		return {
			sessionId,
			agreedChunk,
			totalSize,
			totalCrc32: openInfo.totalCrc32,
			metaParam: openInfo.metaParam,
			meta: openInfo.meta,
			data,
			commitResult,
			commit,
		}
	}

	// PUSH 回灌完整对象（支持 totalSize=0 空提交、块长协商、OFFSET_ERR 纠偏、断连 60s 保活 QUERY 断点续传）
	async function push(io, opts) {
		opts = opts || {}
		const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : Date.now
		const sessionId = (opts.sessionId || 1) & 0xffff
		if (!sessionId) throw makeErr(ERR.ERR_ARG, 'XFER PUSH 需要非零 sessionId')
		const target = opts.target & 0xff
		const data = toU8(opts.data)
		const totalSize = data.length
		const totalCrc = totalSize > 0 ? crc32(data) : 0
		const reqMaxChunk = Math.min(MAX_CHUNK_LEN, Math.max(1, opts.reqMaxChunk || MAX_CHUNK_LEN))
		const rpcTimeoutMs = Math.max(50, opts.rpcTimeoutMs || 5000)
		const maxRetries = Math.min(16, Math.max(1, opts.maxRetries || 5))
		const keepaliveMs = Math.max(0, opts.keepaliveMs != null ? opts.keepaliveMs : 60000)
		const waitReconnect = typeof opts.waitReconnect === 'function' ? opts.waitReconnect : null
		const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {}
		const signal = opts.signal || null

		// 1) OPEN(PUSH)
		const openFrame = buildOpen({
			dir: DIR.PUSH,
			sessionId,
			target,
			reqMaxChunk,
			totalSize,
			expectedCrc32: totalCrc,
			metaParam: opts.metaParam || 0,
			meta: opts.meta || null,
		})
		const openAck = await transact(io, openFrame, OP.OPEN_ACK, {
			rpcTimeoutMs,
			maxRetries,
			nowMs,
			signal,
		})
		if (openAck.argOrStatus !== STATUS.OK) {
			throw makeErr(ERR.ERR_STATUS, 'XFER OPEN(PUSH) 被拒绝: ' + (STATUS_LABELS[openAck.argOrStatus] || openAck.argOrStatus), {
				xferStatus: openAck.argOrStatus,
			})
		}
		const openInfo = parseOpenAck(openAck.payload)
		let chunkSize = openInfo.agreedChunk > 0 ? Math.min(MAX_CHUNK_LEN, openInfo.agreedChunk) : reqMaxChunk

		// 2) 分片 DATA（支持链路断开后 60s 内重连并 QUERY 续传）
		let offset = 0
		let resumedCount = 0

		async function tryReconnectAndQuery(ioErr) {
			if (!waitReconnect || keepaliveMs <= 0) throw ioErr
			onEvent({ type: 'xfer-link-lost', sessionId, offset, totalSize, keepaliveMs })
			const reconnectedIo = await waitReconnect({
				sessionId,
				offset,
				totalSize,
				keepaliveMs,
				signal,
			})
			if (reconnectedIo) io = reconnectedIo
			const q = await query(io, { rpcTimeoutMs, maxRetries, nowMs, signal })
			if (!q.active || q.target !== target || q.dir !== DIR.PUSH || q.sessionId !== sessionId || q.totalSize !== totalSize) {
				throw makeErr(ERR.ERR_PROTOCOL, '重连后 XFER QUERY 状态不匹配，无法续传 (active=' + q.active + ', sid=' + q.sessionId + ')')
			}
			if (q.ackedOffset > totalSize) {
				throw makeErr(ERR.ERR_PROTOCOL, '重连后 XFER QUERY ackedOffset 越界: ' + q.ackedOffset)
			}
			offset = q.ackedOffset
			if (q.agreedChunk > 0 && q.agreedChunk <= MAX_CHUNK_LEN) chunkSize = q.agreedChunk
			resumedCount++
			onEvent({ type: 'xfer-resumed', sessionId, ackedOffset: offset, totalSize, agreedChunk: chunkSize })
		}

		while (offset < totalSize) {
			const end = Math.min(totalSize, offset + chunkSize)
			const slice = data.subarray(offset, end)
			const dataFrame = buildData({ sessionId, offset, data: slice })
			let ack
			try {
				ack = await transact(io, dataFrame, OP.DATA_ACK, {
					rpcTimeoutMs,
					maxRetries,
					nowMs,
					signal,
				})
			} catch (e) {
				if (e && e.xferCode === ERR.ERR_IO) {
					await tryReconnectAndQuery(e)
					continue
				}
				throw e
			}
			if (ack.argOrStatus === STATUS.OK) {
				const dAck = parseDataAck(ack.payload)
				if (dAck.ackedOffset < end) {
					offset = dAck.ackedOffset
				} else {
					offset = end
				}
				if (typeof opts.onProgress === 'function') {
					opts.onProgress({ transferredBytes: offset, totalBytes: totalSize })
				}
				continue
			}
			if (ack.argOrStatus === STATUS.OFFSET_ERR) {
				const dAck = parseDataAck(ack.payload)
				if (dAck.ackedOffset <= totalSize) {
					offset = dAck.ackedOffset
					continue
				}
			}
			throw makeErr(ERR.ERR_STATUS, 'XFER DATA 失败: ' + (STATUS_LABELS[ack.argOrStatus] || ack.argOrStatus), {
				xferStatus: ack.argOrStatus,
			})
		}

		// 3) COMMIT（回传 commitParam，如 200 / 204）
		const commitFrame = buildCommit({ sessionId, commitParam: opts.commitParam || 0 })
		let commitAck
		while (true) {
			try {
				commitAck = await transact(io, commitFrame, OP.COMMIT_ACK, {
					rpcTimeoutMs,
					maxRetries,
					nowMs,
					signal,
				})
				break
			} catch (e) {
				if (e && e.xferCode === ERR.ERR_IO && totalSize > 0) {
					await tryReconnectAndQuery(e)
					if (offset < totalSize) {
						// 尚有尾包未确认，补发后再提交
						while (offset < totalSize) {
							const end = Math.min(totalSize, offset + chunkSize)
							const df = buildData({ sessionId, offset, data: data.subarray(offset, end) })
							const da = await transact(io, df, OP.DATA_ACK, { rpcTimeoutMs, maxRetries, nowMs, signal })
							if (da.argOrStatus !== STATUS.OK) {
								throw makeErr(ERR.ERR_STATUS, 'XFER 续传 DATA 失败: ' + (STATUS_LABELS[da.argOrStatus] || da.argOrStatus), {
									xferStatus: da.argOrStatus,
								})
							}
							offset = end
							if (typeof opts.onProgress === 'function') {
								opts.onProgress({ transferredBytes: offset, totalBytes: totalSize })
							}
						}
					}
					continue
				}
				throw e
			}
		}
		if (commitAck.argOrStatus !== STATUS.OK) {
			throw makeErr(ERR.ERR_STATUS, 'XFER COMMIT(PUSH) 失败: ' + (STATUS_LABELS[commitAck.argOrStatus] || commitAck.argOrStatus), {
				xferStatus: commitAck.argOrStatus,
			})
		}
		const commitResult = parseCommitAck(commitAck.payload)
		return {
			sessionId,
			agreedChunk: chunkSize,
			transferredBytes: totalSize,
			totalBytes: totalSize,
			resumedCount,
			resultCode: commitResult.resultCode,
		}
	}

	const api = {
		MAGIC_0,
		MAGIC_1,
		MAX_CHUNK_LEN,
		MAX_META_LEN,
		FRAME_OVERHEAD,
		MAX_BODY_LEN,
		MAX_FRAME_LEN,
		OP,
		DIR,
		TARGET,
		STATUS,
		STATUS_LABELS,
		ERR,
		crc32Update,
		crc32,
		packFrame,
		peekFrame,
		unpackFrame,
		buildOpen,
		buildData,
		buildPull,
		buildCommit,
		buildQuery,
		buildAbort,
		parseOpenAck,
		parseDataAck,
		parsePullAck,
		parseCommitAck,
		parseQueryAck,
		createByteQueue,
		readFrame,
		transact,
		query,
		sendAbort,
		pull,
		push,
	}

	if (typeof module !== 'undefined' && module.exports) module.exports = api
	root.Xfer = api
})(typeof window !== 'undefined' ? window : globalThis)
