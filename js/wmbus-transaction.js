// W-MBUS 请求-应答事务层: 帧缓冲 + sendAndWait + 下行计数器探测(供写类指令下发前自动取号防重放)
// 依赖: serialApi / wmbusFindFrame / wmbusParseFrame / wmbusBuildDownFrame (见 wmbus-protocol.js)
;(function () {
	'use strict'
	if (!window.serialApi) {
		console.warn('wmbus-transaction: serialApi 未就绪')
		return
	}

	const serialApi = window.serialApi
	let recvBuf = []
	const waiters = []
	const MAX_BUF = 65536
	const MIN_FRAME = 39 // HDR(15) + 最小加密区(16) + MACLEN(8)

	function dispatchFrame(parsed, rawFrame) {
		if (!parsed || parsed.dir !== 'up' || !parsed.macOk) return
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

	// wmbusFindFrame 返回: { found, offset, length, frame, parse, prefix, suffix }
	function pump() {
		for (;;) {
			if (recvBuf.length < MIN_FRAME) {
				if (recvBuf.length > MAX_BUF) recvBuf.splice(0, recvBuf.length - 4096)
				break
			}
			const u8 = new Uint8Array(recvBuf)
			let found = null
			try { found = window.wmbusFindFrame(u8, {}) } catch (e) { found = null }
			if (found && found.found && found.length > 0) {
				const consume = found.offset + found.length
				const raw = found.frame
				let parsed = found.parse || null
				if (!parsed) {
					try { parsed = window.wmbusParseFrame(raw, {}) } catch (e) { parsed = null }
				}
				recvBuf.splice(0, Math.min(consume, recvBuf.length))
				if (parsed) dispatchFrame(parsed, raw)
				continue
			}
			// 缓冲里暂时找不到完整帧(可能还在流式接收, 也可能全是噪声): 等更多数据, 但防止噪声把缓冲撑爆
			if (recvBuf.length > MAX_BUF) recvBuf.splice(0, recvBuf.length - 4096)
			break
		}
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

	async function sendAndWait(opts) {
		opts = opts || {}
		const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 5000
		if (!opts.frame) throw new Error('缺少待发送帧')
		if (!serialApi.isOpen()) throw new Error('串口未打开')
		const p = waitFor(opts.match, timeoutMs)
		await serialApi.writeData(opts.frame)
		return await p
	}

	function keyIdOf(frame) {
		const f = frame.fields && frame.fields['密钥角色KeyID']
		return f && typeof f === 'object' ? f.value : f
	}
	function addrOf(frame) {
		return frame.fields && frame.fields['设备地址ADDR']
	}

	// 探测设备当前下行计数器(last_mc): 用 0x12(读当前下行计数器), 该命令要求 role>0(操作员/管理员,公开读会被拒绝且无回复),
	// 因此必须用调用方实际选定的角色/密钥去查, 不能像其余纯读命令一样固定走公开读。
	// MCNT 不能像 0x10/0x11/0x13~0x15 那样固定填1: 0x12 需要角色鉴权, 实测设备对它仍按新鲜度校验
	// (与文件头注释描述的"0x10~0x15一律不校验"不完全一致), 一旦 last_mc 被推进超过1, 固定填1的探测帧
	// 会被判定为重放而静默丢弃、收不到任何应答, 导致后续写命令(如阀控0x84)永远卡在"探测计数器中"超时。
	// 因此改为调用方传入当前已知的、单调递增的 mcnt(与普通下行命令共用同一个计数器, 见 wmbus-protocol.js
	// 的 wmbusDownMcnt), 保证探测帧的 MCNT 不低于设备最后接受的值。
	// 应答按"结果码(1)+载荷"解析(见 wmbusParseFrame): dataBytes[0]=结果码, dataBytes[1..5)=last_mc(LE)。
	async function probeCounter(opts) {
		opts = opts || {}
		const addrHex = String(opts.addr || '').toUpperCase()
		const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 5000
		const keyId = (opts.keyId != null ? opts.keyId : 0) & 0xff
		const mcnt = (opts.mcnt >>> 0) || 1
		if (!addrHex) throw new Error('缺少设备地址ADDR')
		const frame = window.wmbusBuildDownFrame({ addr: addrHex, keyId: keyId, mcnt: mcnt, cmd: '0x12', payloadHex: '' })
		const match = function (frame2) {
			if (addrOf(frame2) !== addrHex) return false
			if (keyIdOf(frame2) !== keyId) return false
			const db = frame2.dataBytes || []
			// db.length<5: 不是"结果码+4字节计数器"结构; db[0]===0x20: 周期上报帧, 都不是本次探测要等的应答
			if (db.length < 5 || db[0] === 0x20) return false
			return true
		}
		const res = await sendAndWait({ frame: frame, match: match, timeoutMs: timeoutMs })
		const db = res.frame.dataBytes
		const rc = db[0]
		if (rc !== 0) {
			const table = window.wmbusResultTable || {}
			throw new Error('设备应答结果码=' + rc + (table[rc] ? '(' + table[rc] + ')' : ''))
		}
		return (db[1] | (db[2] << 8) | (db[3] << 16) | (db[4] << 24)) >>> 0
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

	window.wmbusTx = {
		sendAndWait: sendAndWait,
		waitFor: waitFor,
		probeCounter: probeCounter,
		clearBuffer: clearBuffer,
		cancelAll: cancelAll,
	}
})()
