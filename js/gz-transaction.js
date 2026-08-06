// 工装通信协议 请求-应答事务层: 帧缓冲 + sendAndWait
// 依赖: serialApi / gzFindFrame / gzParseFrame (见 gz-protocol.js)
;(function () {
	'use strict'
	if (!window.serialApi) {
		console.warn('gz-transaction: serialApi 未就绪')
		return
	}

	const serialApi = window.serialApi
	let recvBuf = []
	const waiters = []
	const MAX_BUF = 65536
	const MIN_FRAME = 5

	function dispatchFrame(parsed, rawFrame) {
		if (!parsed || parsed.dir !== 'up' || !parsed.xorOk) return
		for (let i = waiters.length - 1; i >= 0; i--) {
			const w = waiters[i]
			let ok = false
			try { ok = w.match(parsed, rawFrame) } catch (e) { ok = false }
			if (ok) {
				waiters.splice(i, 1)
				clearTimeout(w.timer)
				w.resolve({ frame: parsed, raw: rawFrame })
			}
		}
	}

	function pump() {
		for (;;) {
			if (recvBuf.length < MIN_FRAME) {
				if (recvBuf.length > MAX_BUF) recvBuf.splice(0, recvBuf.length - 4096)
				break
			}
			const u8 = new Uint8Array(recvBuf)
			let found = null
			try { found = window.gzFindFrame(u8) } catch (e) { found = null }
			if (found && found.found && found.length > 0) {
				const consume = found.offset + found.length
				const raw = found.frame
				let parsed = found.parse || null
				if (!parsed) {
					try { parsed = window.gzParseFrame(raw) } catch (e) { parsed = null }
				}
				recvBuf.splice(0, Math.min(consume, recvBuf.length))
				if (parsed) dispatchFrame(parsed, raw)
				continue
			}
			// 找不到合法帧: 丢弃噪声, 防止卡死
			if (recvBuf[0] !== 0xA5) {
				const idx = recvBuf.indexOf(0xA5)
				if (idx < 0) {
					if (recvBuf.length > MAX_BUF) recvBuf.splice(0, recvBuf.length - 4096)
					break
				}
				recvBuf.splice(0, idx)
				continue
			}
			// 以 A5 开头
			if (recvBuf.length > 1) {
				const len = recvBuf[1] & 0xff
				const total = 2 + len
				// Len 过短/过长不可能合法(最小帧 Len=3 → total=5, 最大 total=257)
				if (total < 5 || total > 257) {
					recvBuf.shift()
					continue
				}
				if (recvBuf.length >= total) {
					// 长度已齐但 findFrame 未命中(多为 XOR 失败) → 跳过该 A5
					recvBuf.shift()
					continue
				}
			}
			// 帧尚不完整: 等更多数据
			if (recvBuf.length > MAX_BUF) recvBuf.splice(0, recvBuf.length - 4096)
			break
		}
	}

	let lastRxAt = 0
	serialApi.onReceive(function (data) {
		if (!data || !data.length) return
		lastRxAt = Date.now()
		for (let i = 0; i < data.length; i++) recvBuf.push(data[i])
		pump()
	})

	function waitIdle(idleMs, maxWaitMs) {
		const idle = idleMs > 0 ? idleMs : 0
		const deadline = Date.now() + (maxWaitMs > 0 ? maxWaitMs : 3000)
		return new Promise(function (resolve) {
			;(function check() {
				const now = Date.now()
				const rest = lastRxAt + idle - now
				if (rest <= 0 || now >= deadline) { resolve(); return }
				setTimeout(check, Math.min(rest, deadline - now))
			})()
		})
	}

	function waitFor(matchFn, timeoutMs) {
		return new Promise(function (resolve, reject) {
			const w = {
				match: matchFn,
				resolve: resolve,
				reject: reject,
				timer: setTimeout(function () {
					const idx = waiters.indexOf(w)
					if (idx !== -1) waiters.splice(idx, 1)
					reject(new Error('等待响应超时(' + timeoutMs + 'ms)'))
				}, timeoutMs),
			}
			waiters.push(w)
			pump()
		})
	}

	async function sendAndWait(opts) {
		opts = opts || {}
		const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 3000
		if (!opts.frame) throw new Error('缺少待发送帧')
		if (!serialApi.isOpen()) throw new Error('串口未打开')
		const p = waitFor(opts.match, timeoutMs)
		await serialApi.writeData(opts.frame)
		return await p
	}

	function clearBuffer() { recvBuf = [] }
	function cancelAll(reason) {
		const msg = reason || '已取消'
		while (waiters.length) {
			const w = waiters.pop()
			clearTimeout(w.timer)
			try { w.reject(new Error(msg)) } catch (e) { /* */ }
		}
	}

	window.gzTx = {
		sendAndWait: sendAndWait,
		waitFor: waitFor,
		waitIdle: waitIdle,
		clearBuffer: clearBuffer,
		cancelAll: cancelAll,
	}
})()
