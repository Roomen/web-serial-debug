// hostProto 事务层（主机端）: 串行请求-应答 + SEQ/CMD 配对 + 逐字节同帧重发 + EVT 分发
// 语义照 hostProtoHost: 组帧前置 FF×4 前导且前导+帧一次 write；RSP 按 SEQ+CMD 配对；
// 超时后原帧逐字节重发（同 SEQ 同载荷，吃模组幂等缓存），间隔 ≥100ms；REBOOT 类命令强制不重发
// 与 C 版的区别: C 版并发 request 立即失败，这里排队串行（网页里更顺手）
// 平台依赖全部注入（write / onReceive / now / setTimeout / clearTimeout），node 里可用假时钟跑
;(function () {
	'use strict'
	const W = window

	const RX_CLEAR_MS = 50 // 帧内字节间隔超过 50ms 视为半帧残留（对应 rxBusy/rxClear）
	const MIN_TIMEOUT_MS = 100

	function mkErr(msg, code, cmd) {
		const e = new Error(msg)
		e.code = code
		e.cmd = cmd
		return e
	}

	// 含密钥的命令按命令号判定敏感字节范围（相对载荷起点），日志副本把这些字节换成 0x00 并重算 CRC，
	// 这样日志里仍是一个合法但已脱敏的帧；真实串口写的是原帧
	const SECRET_RANGES = {
		0x0300: [0, 16], // PROV_AUTH: PAK
		0x0303: [0, 16], // PROV_PAK_SET: 新 PAK
		0x0311: [3, 19], // PROV_KEYS_SLOT_SET: 钥表密钥
		0x0210: [1, 17], // WOR_SESSION_KEY_SET: 会话钥
		0x0101: [16, 48], // LW_CFG_SET: nwkKey + appKey
	}
	function redactedCopy(frame, cmd) {
		const r = SECRET_RANGES[cmd]
		if (!r) return null
		const pre = 4
		const start = pre + 8 + r[0]
		const end = Math.min(pre + 8 + r[1], frame.length - 2)
		if (start >= end) return null
		const c = frame.slice()
		for (let i = start; i < end; i++) c[i] = 0
		const crc = W.hostProto.crc16(c.subarray(pre), c.length - pre - 2)
		c[c.length - 2] = crc & 0xff
		c[c.length - 1] = (crc >> 8) & 0xff
		return c
	}

	function createHostProtoLink(cfg) {
		const H = W.hostProto
		const write = cfg.write
		const now = cfg.now || function () { return Date.now() }
		const setT = cfg.setTimeout
		const clrT = cfg.clearTimeout
		const log = cfg.log || function () {}
		let unsubscribe = null
		let closed = false
		let rx = []
		let rxTimer = null
		let seqNext = 1
		let cur = null
		const queue = []
		const evtHandlers = []
		const stats = { txFrames: 0, retries: 0, timeouts: 0, rxFrames: 0, rxRsp: 0, rxEvt: 0, rxIgnored: 0, rxClear: 0, rxOvf: 0 }

		function nameOf(cmd) { return H.cmdName(cmd) || ('0x' + cmd.toString(16).toUpperCase().padStart(4, '0')) }

		function finish(ok, value) {
			const c = cur
			if (!c) return
			cur = null
			if (c.timer != null) { clrT(c.timer); c.timer = null }
			if (ok) c.resolve(value)
			else c.reject(value)
			kick()
		}

		function send() {
			const c = cur
			if (!c) return
			c.attempt++
			stats.txFrames++
			if (c.attempt > 1) stats.retries++
			let r
			try {
				r = write(c.frame, c.logFrame)
			} catch (e) {
				finish(false, mkErr('串口发送失败: ' + (e && e.message ? e.message : e), 'write', c.cmd))
				return
			}
			if (r && typeof r.then === 'function') {
				r.then(null, function (e) {
					if (cur === c) finish(false, mkErr('串口发送失败: ' + (e && e.message ? e.message : e), 'write', c.cmd))
				})
			}
			if (cur !== c) return // 应答在 write 期间同步到达（假串口/回环），请求已结束，不再挂超时
			c.timer = setT(function () {
				c.timer = null
				if (cur !== c) return
				if (c.attempt < c.maxAttempts) {
					log('重发 ' + nameOf(c.cmd) + ' seq=' + c.seq + '（第 ' + (c.attempt + 1) + ' 次，逐字节同帧）')
					send()
				} else {
					stats.timeouts++
					finish(false, mkErr('模组无应答: ' + nameOf(c.cmd) + ' 超时（' + c.attempt + ' 次尝试，每次 ' + c.timeoutMs + 'ms）', 'timeout', c.cmd))
				}
			}, c.timeoutMs)
		}

		function kick() {
			if (cur || closed || !queue.length) return
			cur = queue.shift()
			cur.seq = seqNext
			seqNext = (seqNext + 1) & 0xff
			cur.frame = H.buildFrame({ type: H.TYPE_REQ, cmd: cur.cmd, seq: cur.seq, payload: cur.payload, preamble: true })
			cur.logFrame = redactedCopy(cur.frame, cur.cmd)
			cur.attempt = 0
			send()
		}

		function request(cmd, payload, opts) {
			const o = opts || {}
			const pl = payload instanceof Uint8Array ? payload : Uint8Array.from(payload || [])
			return new Promise(function (resolve, reject) {
				if (closed) { reject(mkErr('链路已关闭', 'closed', cmd)); return }
				if (pl.length > H.MAX_PAY) { reject(mkErr('载荷超过 255 字节', 'size', cmd)); return }
				const noRetry = !!o.noRetry || H.NO_RETRY.indexOf(cmd) !== -1
				const retries = noRetry ? 0 : (o.retries == null ? 2 : Math.max(0, o.retries))
				queue.push({
					cmd: cmd, payload: pl,
					timeoutMs: Math.max(MIN_TIMEOUT_MS, o.timeoutMs == null ? 1000 : o.timeoutMs),
					maxAttempts: 1 + retries,
					resolve: resolve, reject: reject, timer: null, seq: 0, frame: null, attempt: 0,
				})
				kick()
			})
		}

		function onRsp(f) {
			stats.rxRsp++
			const c = cur
			if (!c || f.seq !== c.seq || f.cmd !== c.cmd) {
				log('忽略不配对的应答 ' + nameOf(f.cmd) + ' seq=' + f.seq)
				return
			}
			const status = f.payload.length ? f.payload[0] : H.STATUS.ERR_FMT
			finish(true, {
				status: status,
				statusName: H.STATUS_NAME[status] || ('0x' + status.toString(16).toUpperCase()),
				payload: f.payload.slice(1),
				seq: f.seq,
				raw: f.raw,
			})
		}

		function onEvtFrame(f) {
			stats.rxEvt++
			const evt = { cmd: f.cmd, name: H.cmdName(f.cmd), payload: f.payload.slice(), raw: f.raw, at: now() }
			for (let i = 0; i < evtHandlers.length; i++) {
				try { evtHandlers[i](evt) } catch (e) { log('EVT 处理异常: ' + (e && e.message ? e.message : e)) }
			}
		}

		function pump() {
			for (;;) {
				if (!rx.length) break
				const u8 = Uint8Array.from(rx)
				const s = H.scan(u8, 0, false)
				if (s.status === 'frame') {
					const raw = u8.slice(s.offset, s.offset + s.total)
					rx = rx.slice(s.offset + s.total)
					stats.rxFrames++
					const f = { type: s.type, cmd: s.cmd, seq: s.seq, payload: raw.subarray(8, s.total - 2), raw: raw }
					if (s.type === H.TYPE_RSP) onRsp(f)
					else if (s.type === H.TYPE_EVT) onEvtFrame(f)
					else stats.rxIgnored++
					continue
				}
				if (s.status === 'wait') { rx = rx.slice(s.offset); break }
				rx = s.keep ? [0xeb] : []
				break
			}
		}

		function armRxTimer() {
			if (rxTimer != null) { clrT(rxTimer); rxTimer = null }
			if (!rx.length || closed) return
			rxTimer = setT(function () {
				rxTimer = null
				if (rx.length) {
					stats.rxClear++
					log('半帧超过 ' + RX_CLEAR_MS + 'ms 无后续字节，清除 ' + rx.length + ' 字节残留')
					rx = []
				}
			}, RX_CLEAR_MS)
		}

		function feed(data) {
			if (closed || !data || !data.length) return
			let i = 0
			while (i < data.length) {
				// 缓冲上限 = 一个候选帧的最大长度 265 字节；分段塞入并扫描，大段噪声里夹的好帧不会被挤掉
				if (rx.length >= H.MAX_FRAME) { rx.shift(); stats.rxOvf++ }
				const take = Math.min(H.MAX_FRAME - rx.length, data.length - i)
				for (let k = 0; k < take; k++) rx.push(data[i + k])
				i += take
				pump()
			}
			armRxTimer()
		}

		function close() {
			if (closed) return
			closed = true
			if (unsubscribe) { try { unsubscribe() } catch (e) { /* 忽略 */ } unsubscribe = null }
			if (rxTimer != null) { clrT(rxTimer); rxTimer = null }
			const err = function (c) { return mkErr('链路已关闭', 'closed', c.cmd) }
			if (cur) {
				const c = cur
				cur = null
				if (c.timer != null) clrT(c.timer)
				c.reject(err(c))
			}
			while (queue.length) { const q = queue.shift(); q.reject(err(q)) }
			evtHandlers.length = 0
			if (typeof cfg.onClose === 'function') { try { cfg.onClose() } catch (e) { /* 忽略 */ } }
		}

		const link = {
			request: request,
			onEvt: function (cb) {
				evtHandlers.push(cb)
				return function () {
					const i = evtHandlers.indexOf(cb)
					if (i !== -1) evtHandlers.splice(i, 1)
				}
			},
			close: close,
			feed: feed,
			now: now,
			rxBusy: function () { return rx.length },
			rxClear: function () { const n = rx.length; rx = []; return n },
			get stats() { return Object.assign({}, stats) },
			get closed() { return closed },
		}
		unsubscribe = cfg.onReceive ? cfg.onReceive(feed) : null
		return link
	}

	// 浏览器绑定: 走 serialApi 的当前主发口，用 writeRaw（不追加 CRLF、日志只显示脱敏副本）。事务期间钉扎会话，避免用户中途切主发口
	function hostProtoSerialLink(extra) {
		const api = W.serialApi
		if (!api) throw new Error('serialApi 未就绪')
		const opts = extra || {}
		let pinned = false
		if (typeof api.pinSession === 'function') {
			api.pinSession(api.getActiveSendSid())
			pinned = true
		}
		return createHostProtoLink({
			write: function (bytes, logBytes) {
				if (!api.isOpen()) throw new Error('串口未打开')
				return api.writeRaw(bytes, { logData: logBytes || null })
			},
			onReceive: function (cb) { return api.onReceive(cb) },
			now: function () { return Date.now() },
			setTimeout: function (f, ms) { return setTimeout(f, ms) },
			clearTimeout: function (h) { clearTimeout(h) },
			log: opts.log,
			onClose: function () {
				if (pinned && typeof api.unpinSession === 'function') api.unpinSession()
			},
		})
	}

	W.createHostProtoLink = createHostProtoLink
	W.hostProtoSerialLink = hostProtoSerialLink
})()
