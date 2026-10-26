// User-composed TEXT: UTF-8 literals and C-style byte escapes, parsed once before writing.
;(function () {
	const utf8 = new TextEncoder()
	const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '\\': 92, "'": 39, '"': 34, '?': 63 }

	function encode(text) {
		const bytes = new Uint8Array(text.length * 3)
		let used = 0, start = 0, i = 0
		function literal(end) {
			const span = utf8.encode(text.slice(start, end))
			bytes.set(span, used)
			used += span.length
		}
		function fail(at, reason) {
			const lines = text.slice(0, at).split('\n')
			const column = Array.from(lines[lines.length - 1]).length + 1
			throw new Error('TEXT 转义错误（第 ' + lines.length + ' 行，第 ' + column + ' 列）：' + reason)
		}
		while (i < text.length) {
			if (text[i] !== '\\') { i++; continue }
			literal(i)
			const at = i++
			if (i === text.length) fail(at, '末尾反斜杠缺少转义字符')
			const ch = text[i++]
			let value
			if (Object.prototype.hasOwnProperty.call(simple, ch)) {
				value = simple[ch]
			} else if (/[0-7]/.test(ch)) {
				value = Number(ch)
				let digits = 1
				while (digits < 3 && i < text.length && /[0-7]/.test(text[i])) {
					value = value * 8 + Number(text[i++])
					digits++
				}
			} else if (ch === 'x') {
				const first = i
				value = 0
				while (i < text.length && /[0-9a-fA-F]/.test(text[i])) {
					// Saturate only the accumulator; still consume every hex digit.
					value = Math.min(256, value * 16 + parseInt(text[i++], 16))
				}
				if (i === first) fail(at, '\\x 后至少需要一位十六进制数字')
			} else {
				fail(at, '不支持的转义；字面反斜杠请写成 \\\\')
			}
			if (value > 255) fail(at, '数字转义超出单字节范围 0–255')
			bytes[used++] = value
			start = i
		}
		literal(text.length)
		return bytes.subarray(0, used)
	}

	window.TextByteEncoder = { encode }
})()
