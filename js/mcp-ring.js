// MCP 读串口用的有界接收环与参数工具（纯逻辑，可在 node 里跑）。
// 游标是不透明字符串 "generation:offset"：代次由每路连接代次决定，换设备/重连后旧游标一律 invalid_cursor，
// 不可能拿上一次连接的数据冒充这一次的。环满时丢最早的数据，dropped 如实报告。
;(function (root) {
	'use strict'

	const DEFAULT_CAPACITY = 256 * 1024
	const DEFAULT_READ_BYTES = 4096
	const MAX_READ_BYTES = 65536
	const MAX_READ_TIMEOUT_MS = 30000
	const MAX_WRITE_BYTES = 16384

	function toBytes(src) {
		if (src instanceof Uint8Array) return src
		if (src instanceof ArrayBuffer) return new Uint8Array(src)
		if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
		return new Uint8Array(src || [])
	}

	function createRing(capacity) {
		const cap = Math.max(1024, Math.floor(Number(capacity) || DEFAULT_CAPACITY))
		const buf = new Uint8Array(cap)
		let head = 0
		let len = 0
		let total = 0
		let generation = 1

		function push(src) {
			const bytes = toBytes(src)
			if (!bytes.length) return
			if (bytes.length >= cap) {
				buf.set(bytes.subarray(bytes.length - cap), 0)
				head = 0
				len = cap
				total += bytes.length
				return
			}
			const tail = (head + len) % cap
			const first = Math.min(bytes.length, cap - tail)
			buf.set(bytes.subarray(0, first), tail)
			if (first < bytes.length) buf.set(bytes.subarray(first), 0)
			const overflow = Math.max(0, len + bytes.length - cap)
			head = (head + overflow) % cap
			len = Math.min(cap, len + bytes.length)
			total += bytes.length
		}

		// 读取 [cursor, cursor+maxBytes)：cursor 为 null 时从最早保留的字节开始
		function read(cursor, maxBytes) {
			const want = Math.max(1, Math.min(MAX_READ_BYTES, Math.floor(Number(maxBytes) || DEFAULT_READ_BYTES)))
			const oldest = total - len
			let from = cursor == null ? oldest : Math.floor(Number(cursor))
			let dropped = 0
			if (!isFinite(from) || from < oldest) {
				dropped = oldest - (isFinite(from) ? from : oldest)
				from = oldest
			}
			if (from > total) from = total
			const n = Math.min(want, total - from)
			const out = new Uint8Array(n)
			if (n > 0) {
				const start = (head + (from - oldest)) % cap
				const first = Math.min(n, cap - start)
				out.set(buf.subarray(start, start + first), 0)
				if (first < n) out.set(buf.subarray(0, n - first), first)
			}
			return { cursor: from, nextCursor: from + n, dropped: dropped, data: out }
		}

		return {
			get capacity() { return cap },
			get generation() { return generation },
			get total() { return total },
			get retained() { return len },
			push: push,
			read: read,
			stats: function () { return { generation: generation, total: total, retained: len, oldestCursor: total - len } },
			// 新的连接 / 断开：代次 +1，旧游标随之作废
			reset: function () {
				generation += 1
				head = 0
				len = 0
				total = 0
			},
		}
	}

	// 游标带命名空间(文档 + 路)：别的窗口/别的路/刷新前的游标都认不出来，不会被当成这一路的字节偏移
	function encodeCursor(ns, generation, offset) {
		return String(ns) + ':' + String(generation) + ':' + String(offset)
	}

	function parseCursor(text) {
		if (typeof text !== 'string') return null
		const m = /^([A-Za-z0-9_-]{1,80}):(\d{1,10}):(\d{1,15})$/.exec(text)
		if (!m) return null
		const generation = Number(m[2])
		const offset = Number(m[3])
		if (!isFinite(generation) || !isFinite(offset)) return null
		return { ns: m[1], generation: generation, offset: offset }
	}

	// HEX：允许空格分隔；奇数字节、非 hex 字符一律拒绝(不猜、不截断)
	function parseHex(text) {
		if (typeof text !== 'string') return { ok: false, message: 'data 必须是字符串' }
		const clean = text.replace(/[\s]/g, '')
		if (!clean.length) return { ok: false, message: 'data 不能为空' }
		if (!/^[0-9a-fA-F]+$/.test(clean)) return { ok: false, message: 'HEX 数据包含非十六进制字符' }
		if (clean.length % 2 !== 0) return { ok: false, message: 'HEX 数据必须是整数字节(长度为偶数)' }
		const bytes = new Uint8Array(clean.length / 2)
		for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16)
		return { ok: true, bytes: bytes }
	}

	function encodeHex(bytes) {
		const src = toBytes(bytes)
		let out = ''
		for (let i = 0; i < src.length; i++) out += (src[i] < 16 ? '0' : '') + src[i].toString(16)
		return out
	}

	// 读参数：整数、范围内，NaN / Infinity / 小数都拒绝(不静默截断)
	function readInt(value, lo, hi, fallback) {
		if (value == null || value === '') return fallback
		const n = Number(value)
		if (!isFinite(n) || Math.floor(n) !== n) return null
		if (n < lo || n > hi) return null
		return n
	}

	const api = {
		DEFAULT_CAPACITY: DEFAULT_CAPACITY,
		DEFAULT_READ_BYTES: DEFAULT_READ_BYTES,
		MAX_READ_BYTES: MAX_READ_BYTES,
		MAX_READ_TIMEOUT_MS: MAX_READ_TIMEOUT_MS,
		MAX_WRITE_BYTES: MAX_WRITE_BYTES,
		createRing: createRing,
		encodeCursor: encodeCursor,
		parseCursor: parseCursor,
		parseHex: parseHex,
		encodeHex: encodeHex,
		readInt: readInt,
	}

	if (typeof module !== 'undefined' && module.exports) module.exports = api
	if (root && root.document) root.McpRing = api
})(typeof window !== 'undefined' ? window : null)
