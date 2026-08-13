// SEK 请求-应答事务层: 帧缓冲 + sendAndWait + 帧序号分配
// 依赖: serialApi / skFindFrame / skParseFrame / skBuildDownFrame
;(function () {
	'use strict'
	if (!window.serialApi) {
		console.warn('sek-transaction: serialApi 未就绪')
		return
	}

	const serialApi = window.serialApi
	let _seq = 1
	let recvBuf = []
	const waiters = []
	const MAX_BUF = 65536

	function nextSeq() {
		const s = _seq & 0xffff
		_seq = (_seq + 1) & 0xffff
		if (_seq === 0) _seq = 1
		return s
	}

	function bytesEqual(a, b) {
		if (!a || !b || a.length !== b.length) return false
		for (let i = 0; i < a.length; i++) {
			if ((a[i] & 0xff) !== (b[i] & 0xff)) return false
		}
		return true
	}

	function toByteArr(v) {
		if (!v) return []
		if (v instanceof Uint8Array) return Array.from(v)
		if (Array.isArray(v)) return v.map(function (x) { return x & 0xff })
		if (typeof v === 'string') {
			const hex = v.replace(/\s+/g, '')
			const out = []
			for (let i = 0; i + 1 < hex.length; i += 2) {
				out.push(parseInt(hex.substr(i, 2), 16) & 0xff)
			}
			return out
		}
		return []
	}

	function getParseOpts() {
		if (typeof serialApi.getParseOpts === 'function') return serialApi.getParseOpts()
		return {}
	}

	function getEncKey() {
		if (typeof serialApi.getEncKey === 'function') return serialApi.getEncKey()
		return null
	}

	function funcValue(frame) {
		if (!frame || !frame.fields || frame.fields['功能码'] == null) return null
		const f = frame.fields['功能码']
		return typeof f === 'object' ? f.value : f
	}

	function frameSeq(frame) {
		if (!frame || !frame.fields) return null
		const s = frame.fields['帧序号']
		return s == null ? null : (s & 0xffff)
	}

	// 0x81/0x91 应答: 各 ID 的 Value 为处理结果码 (0处理中 1成功 2无法解析 3超范围 4失败)
	// 聚合: 有失败取首个失败码; 否则有处理中取 0; 全成功取 1
	function tag11Result(frame) {
		if (!frame || !frame.tlv) return null
		let fail = null
		let hasOk = false
		let hasProcessing = false
		let found = false
		for (let i = 0; i < frame.tlv.length; i++) {
			const blk = frame.tlv[i]
			const items = blk.items || []
			// 兼容旧形态: 独立 Tag11, ID 即结果码
			if (blk.tag === 11) {
				for (let j = 0; j < items.length; j++) {
					const it = items[j]
					let c = null
					if (it.resultCode != null) c = it.resultCode & 0xff
					else if (it.id >= 0 && it.id <= 4) c = it.id
					else if (it.raw && it.raw.length) c = it.raw[0] & 0xff
					if (c == null) continue
					found = true
					if (c === 1) hasOk = true
					else if (c === 0) hasProcessing = true
					else if (fail == null) fail = c
				}
				continue
			}
			for (let j = 0; j < items.length; j++) {
				const it = items[j]
				if (it.resultCode == null) continue
				const c = it.resultCode & 0xff
				found = true
				if (c === 1) hasOk = true
				else if (c === 0) hasProcessing = true
				else if (fail == null) fail = c
			}
		}
		if (!found) return null
		if (fail != null) return fail
		if (hasProcessing) return 0
		if (hasOk) return 1
		return null
	}

	function findTlvItem(frame, tag, id) {
		if (!frame || !frame.tlv) return null
		for (let i = 0; i < frame.tlv.length; i++) {
			const blk = frame.tlv[i]
			if (blk.tag !== tag) continue
			const items = blk.items || []
			for (let j = 0; j < items.length; j++) {
				if (items[j].id === id) return items[j]
			}
		}
		return null
	}

	function hasTag(frame, tag) {
		if (!frame || !frame.tlv) return false
		for (let i = 0; i < frame.tlv.length; i++) {
			if (frame.tlv[i].tag === tag) return true
		}
		return false
	}

	function findStart(buf, from) {
		for (let i = from || 0; i + 1 < buf.length; i++) {
			if (buf[i] === 0xA9 && buf[i + 1] === 0x9A) return i
		}
		return -1
	}

	function dispatchFrame(parsed, rawFrame) {
		if (!parsed || parsed.dir !== 'up') return
		// skParseFrame 只保证 ok/crcOk，不一定回填 endOk
		const valid = parsed.ok === true || (parsed.crcOk && parsed.endOk)
		if (!valid) return
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

	// skFindFrame 返回: { found, offset, length, frame, parse, prefix, suffix }
	function pump() {
		const opts = getParseOpts()
		for (;;) {
			if (recvBuf.length < 19) break
			const u8 = new Uint8Array(recvBuf)
			let found = null
			if (typeof skFindFrame === 'function') {
				try { found = skFindFrame(u8, opts) } catch (e) { found = null }
			}
			if (found && found.found && found.length > 0) {
				const start = found.offset || 0
				const len = found.length
				const consume = start + len
				const raw = found.frame || u8.subarray(start, consume)
				let parsed = found.parse || null
				if (!parsed && typeof skParseFrame === 'function') {
					try { parsed = skParseFrame(raw, opts) } catch (e) { parsed = null }
				}
				recvBuf.splice(0, Math.min(consume, recvBuf.length))
				if (parsed) dispatchFrame(parsed, raw)
				continue
			}
			// 无完整有效帧: 若头不是 A9 9A 则滑动; 否则等更多字节
			const idx = findStart(recvBuf, 0)
			if (idx < 0) {
				if (recvBuf.length > 1) recvBuf.splice(0, recvBuf.length - 1)
				break
			}
			if (idx > 0) {
				recvBuf.splice(0, idx)
				continue
			}
			// 已对齐帧头但尚未完整 — 缓冲过大则丢 1 字节防卡死
			if (recvBuf.length > MAX_BUF) {
				recvBuf.shift()
				continue
			}
			break
		}
		if (recvBuf.length > MAX_BUF) recvBuf.splice(0, recvBuf.length - 4096)
	}

	serialApi.onReceive(function (data) {
		if (!data || !data.length) return
		for (let i = 0; i < data.length; i++) recvBuf.push(data[i])
		pump()
	})

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
				}, timeoutMs)
			}
			waiters.push(w)
			pump()
		})
	}

	function buildDown(opts) {
		const o = Object.assign({}, opts || {})
		if (o.frameSeq == null) o.frameSeq = nextSeq()
		if (o.version == null) o.version = 2
		if (o.time == null) o.time = new Date()
		if (o.encKey === undefined) o.encKey = getEncKey()
		return { frame: skBuildDownFrame(o), seq: o.frameSeq, opts: o }
	}

	/**
	 * 发送并等待匹配的上行帧
	 * @param {object} opts
	 *   - buildOpts: skBuildDownFrame 参数
	 *   - expectFunc: 期望 ACK 功能码 number, 如 0x81
	 *   - matchSeq: 是否要求帧序号一致 (默认 false)
	 *   - timeoutMs
	 *   - match: 额外 (frame)=>boolean
	 *   - acceptProcessing: Tag11=0 时继续等 (默认 true)
	 */
	async function sendAndWait(opts) {
		opts = opts || {}
		const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 5000
		// 事务等待周期钉扎主发口: 请求与应答落在同一设备
		serialApi.pinSession(serialApi.getActiveSendSid())
		try {
			const built = buildDown(opts.buildOpts || {})
			const expectFunc = opts.expectFunc
			const matchSeq = !!opts.matchSeq
			const extra = opts.match
			const acceptProcessing = opts.acceptProcessing !== false

			const matchFn = function (frame) {
				if (frame.dir !== 'up') return false
				const fv = funcValue(frame)
				if (expectFunc != null && fv !== expectFunc) return false
				if (matchSeq) {
					const fs = frameSeq(frame)
					if (fs != null && fs !== (built.seq & 0xffff)) return false
				}
				if (expectFunc === 0x81 || expectFunc === 0x91) {
					const r11 = tag11Result(frame)
					if (r11 === 0 && acceptProcessing) return false
				}
				if (typeof extra === 'function' && !extra(frame)) return false
				return true
			}

			const p = waitFor(matchFn, timeoutMs)
			await serialApi.writeData(built.frame)
			const res = await p
			return {
				tx: built.frame,
				seq: built.seq,
				frame: res.frame,
				raw: res.raw,
				tag11: tag11Result(res.frame),
				func: funcValue(res.frame)
			}
		} finally {
			serialApi.unpinSession()
		}
	}

	function clearBuffer() {
		recvBuf = []
	}

	function cancelAll(reason) {
		const msg = reason || '已取消'
		while (waiters.length) {
			const w = waiters.pop()
			clearTimeout(w.timer)
			try { w.reject(new Error(msg)) } catch (e) { /* */ }
		}
	}

	window.sekTx = {
		nextSeq: nextSeq,
		buildDown: buildDown,
		sendAndWait: sendAndWait,
		waitFor: waitFor,
		clearBuffer: clearBuffer,
		cancelAll: cancelAll,
		bytesEqual: bytesEqual,
		toByteArr: toByteArr,
		funcValue: funcValue,
		frameSeq: frameSeq,
		tag11Result: tag11Result,
		findTlvItem: findTlvItem,
		hasTag: hasTag,
		getEncKey: getEncKey,
		getParseOpts: getParseOpts
	}
})()
