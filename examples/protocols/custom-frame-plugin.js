// JS 协议插件完整参考例程：
// 展示 findFrame / parseFrame / logView / byteMap / buildDownFrame / presets / randomTest 完整适配方式。
// 帧格式：5A A5 + Cmd(1B) + Len(1B) + Payload(Len B) + XOR8(1B)
;(function () {
	'use strict'

	const HEAD0 = 0x5A
	const HEAD1 = 0xA5
	const CMD_NAMES = {
		0x01: '心跳查询',
		0x02: '读版本',
		0x03: '读传感器',
		0x81: '心跳应答',
		0x82: '版本应答',
		0x83: '传感器应答',
	}

	function calcXor(bytes, end) {
		let x = 0
		for (let i = 0; i < end; i++) x ^= bytes[i]
		return x & 0xff
	}

	function hex2(n) {
		return (n & 0xff).toString(16).toUpperCase().padStart(2, '0')
	}

	function buildFrame(cmd, payload) {
		const p = Array.isArray(payload) ? payload : []
		const out = new Uint8Array(5 + p.length)
		out[0] = HEAD0
		out[1] = HEAD1
		out[2] = cmd & 0xff
		out[3] = p.length & 0xff
		for (let i = 0; i < p.length; i++) out[4 + i] = p[i] & 0xff
		out[out.length - 1] = calcXor(out, out.length - 1)
		return out
	}

	registerProtocol('demo-frame-plugin', {
		name: 'JS 协议参考例程',
		version: '1.0.0',
		description: '5A A5 + Cmd(1B) + Len(1B) + Payload + XOR8（含解析、下行预设与随机测试）',

		findFrame(bytes) {
			const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])
			for (let i = 0; i <= b.length - 5; i++) {
				if (b[i] !== HEAD0 || b[i + 1] !== HEAD1) continue
				const len = b[i + 3]
				const total = 5 + len
				if (i + total > b.length) continue
				const slice = b.subarray(i, i + total)
				if (calcXor(slice, total - 1) !== slice[total - 1]) continue
				return {
					found: true,
					frame: slice.slice(),
					offset: i,
					length: total,
					prefix: i,
					suffix: b.length - i - total,
				}
			}
			return { found: false }
		},

		parseFrame(bytes) {
			const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])
			if (b.length < 5 || b[0] !== HEAD0 || b[1] !== HEAD1) {
				return { ok: false, raw: b, errors: ['帧头不匹配'] }
			}
			const cmd = b[2]
			const len = b[3]
			const total = 5 + len
			if (b.length !== total) {
				return { ok: false, matchedHead: true, raw: b, errors: ['长度不匹配'] }
			}
			const xorOk = calcXor(b, total - 1) === b[total - 1]
			const payload = b.slice(4, 4 + len)
			return {
				ok: xorOk,
				raw: b,
				cmd: cmd,
				cmdName: CMD_NAMES[cmd] || ('0x' + hex2(cmd)),
				len: len,
				payload: payload,
				xorOk: xorOk,
				errors: xorOk ? [] : ['XOR 校验失败'],
			}
		},

		logView(r) {
			if (!r || !r.raw || r.cmd == null) return null
			const hexPayload = Array.from(r.payload || []).map(hex2).join(' ') || '(空)'
			return {
				title: r.cmdName,
				code: '0x' + hex2(r.cmd),
				badges: [{ text: r.xorOk ? 'XOR OK' : 'XOR ERR', kind: r.xorOk ? 'ok' : 'bad' }],
				sections: [{
					title: '帧信息',
					pairs: [
						['命令码', '0x' + hex2(r.cmd)],
						['载荷长度', r.len + ' B'],
						['载荷', hexPayload],
					],
				}],
				errors: r.errors || [],
			}
		},

		byteMap(bytes, r) {
			const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])
			const map = new Array(b.length)
			if (b.length < 5) return map
			map[0] = { grp: 'head', tip: '帧头 0x5A' }
			map[1] = { grp: 'head', tip: '帧头 0xA5' }
			map[2] = { grp: 'cmd', tip: '命令码: ' + (r ? r.cmdName : ('0x' + hex2(b[2]))) }
			map[3] = { grp: 'len', tip: '载荷长度: ' + b[3] + ' B' }
			for (let i = 4; i < b.length - 1; i++) {
				map[i] = { grp: 'payload', tip: '载荷[' + (i - 4) + ']' }
			}
			map[b.length - 1] = { grp: 'xor', tip: 'XOR8 校验字节' }
			return map
		},

		buildDownFrame(opts) {
			opts = opts || {}
			const cmd = Number(opts.cmd != null ? opts.cmd : 0x01)
			const payload = Array.isArray(opts.payload) ? opts.payload : []
			return buildFrame(cmd, payload)
		},

		presets: [
			{
				group: '基础查询',
				items: [
					{ name: '心跳查询', func: '0x01', cmd: 0x01, payload: [], desc: '查询设备在线状态' },
					{ name: '读版本', func: '0x02', cmd: 0x02, payload: [], desc: '读取固件版本' },
					{ name: '读传感器', func: '0x03', cmd: 0x03, payload: [], desc: '读取当前传感器采样值' },
				],
			},
		],

		randomTest: {
			supportsWrite: false,
			hint: '示例插件 · 3 条安全只读命令随机压测（心跳 / 版本 / 传感器）',
			cases: [
				{ name: '心跳查询', build: function () { return Array.from(buildFrame(0x01, [])) } },
				{ name: '读版本', build: function () { return Array.from(buildFrame(0x02, [])) } },
				{ name: '读传感器', build: function () { return Array.from(buildFrame(0x03, [])) } },
			],
		},
	})
})()
