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
	const MAX_FRAME = 257
	const MIN_FRAME = 5
	// 没有事务在等时只留这么长的尾巴(帧最长 257 字节)，不扫描：解析器常驻订阅全部接收，不能让普通流量也走一遍找帧
	const IDLE_TAIL = 1024

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
		if (!waiters.length) {
			if (recvBuf.length > IDLE_TAIL * 2) recvBuf.splice(0, recvBuf.length - IDLE_TAIL)
			return
		}
		while (waiters.length) {
			if (recvBuf.length < MIN_FRAME) break
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
			// 找帧器已检查所有完整候选，只保留可能没收齐的帧头，避免逐个跳过坏帧后重扫。
			const tailStart = Math.max(0, recvBuf.length - (MAX_FRAME - 1))
			const idx = recvBuf.indexOf(0xA5, tailStart)
			if (idx < 0) recvBuf.length = 0
			else if (idx > 0) recvBuf.splice(0, idx)
			break
		}
		if (!waiters.length && recvBuf.length > IDLE_TAIL * 2) recvBuf.splice(0, recvBuf.length - IDLE_TAIL)
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

	function waitFor(matchFn, timeoutMs, onWaiter) {
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
			if (onWaiter) onWaiter(w)
			pump()
		})
	}

	async function sendAndWait(opts) {
		opts = opts || {}
		const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 3000
		if (!opts.frame) throw new Error('缺少待发送帧')
		if (!serialApi.isOpen()) throw new Error('串口未打开')
		// 事务等待周期钉扎主发口: 请求与应答落在同一设备
		serialApi.pinSession(serialApi.getActiveSendSid())
		let pendingWaiter = null
		try {
			// 新请求不能由上一事务/闲置期留下的应答完成；被动 waitFor 仍可读取已有缓冲。
			if (!waiters.length) clearBuffer()
			const p = waitFor(opts.match, timeoutMs, function (w) { pendingWaiter = w })
			// 写入尚未结束时等待也可能超时/取消，先挂拒绝处理避免未处理的 Promise。
			p.catch(function () {})
			await serialApi.writeData(opts.frame)
			return await p
		} finally {
			if (pendingWaiter) {
				const idx = waiters.indexOf(pendingWaiter)
				if (idx !== -1) waiters.splice(idx, 1)
				clearTimeout(pendingWaiter.timer)
			}
			serialApi.unpinSession()
		}
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
