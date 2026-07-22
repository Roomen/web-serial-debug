#!/usr/bin/env node
/**
 * 双向交叉测试：
 *  A) C 镜像组上行帧 → 网页 skParseFrame / skByteMap
 *  B) 网页 skBuildDownFrame → C 镜像验帧 + TLV 语义遍历
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { execFileSync, spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '../..')
const HERE = __dirname
const C_SRC = path.join(HERE, 'sk_c_mirror.c')
const C_BIN = path.join(HERE, 'sk_c_mirror')

function loadWeb() {
	const ctx = {
		window: {},
		console,
		TextEncoder,
		TextDecoder,
		Uint8Array,
		Array,
		parseInt,
		String,
		Date,
		Error,
		Math,
		JSON,
		BigInt,
		DataView,
		ArrayBuffer,
	}
	ctx.window = ctx
	for (const f of ['js/protocol-schema.js', 'js/protocol-crypto.js', 'js/protocol.js', 'js/protocol-presets.js']) {
		vm.runInNewContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f })
	}
	return ctx
}

function toHex(u8) {
	return Array.from(u8)
		.map((b) => ('0' + b.toString(16).toUpperCase()).slice(-2))
		.join(' ')
}

function parseHexLine(s) {
	const parts = s.trim().split(/\s+/)
	const a = []
	for (const p of parts) {
		if (!/^[0-9a-fA-F]{2}$/.test(p)) continue
		a.push(parseInt(p, 16))
	}
	return new Uint8Array(a)
}

function buildC() {
	const r = spawnSync('cc', ['-O0', '-Wall', '-o', C_BIN, C_SRC], { encoding: 'utf8' })
	if (r.status !== 0) {
		console.error(r.stderr || r.stdout)
		throw new Error('C compile failed')
	}
}

function genCUplinks() {
	const out = execFileSync(C_BIN, ['gen'], { encoding: 'utf8' })
	const samples = []
	for (const line of out.split('\n')) {
		if (line.startsWith('HEX ')) {
			const m = line.match(/^HEX (\S+) (\d+):(.*)$/)
			if (!m) continue
			samples.push({ name: m[1], hex: m[3].trim(), bytes: parseHexLine(m[3]) })
		} else if (line.startsWith('CRC_VECTOR')) {
			console.log('[C]', line)
		}
	}
	return samples
}

function genWebDowns(W) {
	const cases = []
	const push = (name, opt) => {
		const frame = W.skBuildDownFrame(opt)
		cases.push({ name, frame, hex: toHex(frame), opt })
	}
	const t = new Date('2026-07-22T10:30:00')

	push('set_freq_1440', {
		funcCode: '0x01',
		version: 2,
		time: t,
		frameSeq: 1,
		tlv: [{ tag: 3, items: [{ id: 9, value: [0xa0, 0x05] }] }],
	})
	push('set_caliber_40mm', {
		funcCode: '0x01',
		version: 2,
		time: t,
		frameSeq: 2,
		tlv: [{ tag: 3, items: [{ id: 18, value: [5] }] }],
	})
	push('set_ip', {
		funcCode: '0x01',
		version: 2,
		time: t,
		frameSeq: 3,
		tlv: [
			{
				tag: 3,
				items: [
					{
						id: 6,
						value: (() => {
							const a = new Array(32).fill(0)
							const s = '1.2.3.4,8080'
							for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i)
							return a
						})(),
					},
				],
			},
		],
	})
	push('query_base', {
		funcCode: '0x03',
		version: 2,
		time: t,
		frameSeq: 4,
		tlv: [{ tag: 10, items: [{ id: 1, value: [] }] }],
	})
	push('query_multi_null', {
		funcCode: '0x03',
		version: 2,
		time: t,
		frameSeq: 5,
		tlv: [{ tag: 10, items: [{ id: 1, value: [] }, { id: 2, value: [] }, { id: 3, value: [] }] }],
	})
	push('query_freeze_0', {
		funcCode: '0x03',
		version: 2,
		time: t,
		frameSeq: 6,
		tlv: [{ tag: 10, items: [{ id: 24, value: [0] }] }],
	})
	push('query_history_bcd', {
		funcCode: '0x03',
		version: 2,
		time: t,
		frameSeq: 7,
		// 协议文档: YYYYMMDDhhmmss BCD；C 代码按 year_u16_be + bin 字段读
		tlv: [{ tag: 10, items: [{ id: 5, value: [0x20, 0x26, 0x07, 0x22, 0x10, 0x30, 0x00] }] }],
	})
	push('cmd_open_cat', {
		funcCode: '0x11',
		version: 2,
		time: t,
		frameSeq: 8,
		tlv: [{ tag: 93, items: [{ id: 0, value: [0x01] }] }],
	})
	push('cmd_reset_2s', {
		funcCode: '0x11',
		version: 2,
		time: t,
		frameSeq: 9,
		tlv: [{ tag: 93, items: [{ id: 1, value: [2] }] }],
	})
	push('cmd_init_data_web0', {
		funcCode: '0x11',
		version: 2,
		time: t,
		frameSeq: 10,
		// 网页 preset: 0=数据初始化；C INIT_DATA=1
		tlv: [{ tag: 93, items: [{ id: 2, value: [0] }] }],
	})
	push('cmd_init_data_c1', {
		funcCode: '0x11',
		version: 2,
		time: t,
		frameSeq: 11,
		tlv: [{ tag: 93, items: [{ id: 2, value: [1] }] }],
	})
	push('cmd_sleep', {
		funcCode: '0x11',
		version: 2,
		time: t,
		frameSeq: 12,
		tlv: [{ tag: 93, items: [{ id: 12, value: [1] }] }],
	})

	// presets that auto-build
	for (const g of W.SK_DOWN_PRESETS || []) {
		for (const it of g.items) {
			const needsManual = (it.tlv || []).some((b) =>
				(b.items || []).some((x) => Array.isArray(x.value) && x.value.length === 0 && !it.param)
			)
			if (needsManual) continue
			let tlv = JSON.parse(JSON.stringify(it.tlv || []))
			if (it.param) {
				let bytes
				const p = it.param
				const bcd = (n) => {
					n = Math.max(0, Math.min(99, n | 0))
					return ((Math.floor(n / 10) & 0xf) << 4) | (n % 10)
				}
				if (p.type === 'enum') bytes = [parseInt(p.default || 0, 10)]
				else if (p.type === 'uint8') bytes = [parseInt(p.default || 0, 10) & 0xff]
				else if (p.type === 'uint16le') {
					const v = parseInt(p.default || 0, 10)
					bytes = [v & 0xff, (v >> 8) & 0xff]
				} else if (p.type === 'uint32le') {
					const v = parseInt(p.default || 0, 10)
					bytes = [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
				} else if (p.type === 'ascii') {
					const s = p.default || 'test'
					const n = p.fillLen || s.length
					bytes = Array(n).fill(0)
					for (let i = 0; i < s.length && i < n; i++) bytes[i] = s.charCodeAt(i)
				} else if (p.type === 'bcd') {
					const s = (p.default || '12345678901234').replace(/\D/g, '')
					const n = p.fillLen || 5
					const dig = s.padStart(n * 2, '0').slice(-n * 2)
					bytes = []
					for (let i = 0; i < n; i++) bytes.push(((+dig[i * 2]) << 4) | +dig[i * 2 + 1])
					bytes.reverse()
				} else if (p.type === 'dailyQuery') {
					const c = parseInt(p.default || 7, 10) & 0xff
					bytes = [bcd(26), bcd(7), bcd(22), c]
				} else if (p.type === 'errLogQuery') {
					const c = parseInt(p.default || 4, 10) & 0xff
					bytes = [bcd(26), bcd(7), bcd(22), bcd(10), bcd(30), bcd(0), c]
				} else continue
				for (const b of tlv) for (const x of b.items || []) if (!x.value || !x.value.length) x.value = bytes
			}
			const safe = it.name.replace(/[^\w\u4e00-\u9fff-]+/g, '_')
			push('preset_' + safe, { funcCode: it.func, version: 2, time: t, frameSeq: 100, tlv })
		}
	}
	return cases
}

function analyzeWebParse(W, name, bytes, expectDir) {
	const r = W.skParseFrame(bytes)
	const bm = W.skByteMap(r)
	let uncovered = 0
	for (const c of bm) if (!c || !c.tip) uncovered++
	const issues = []
	if (!r.ok) issues.push('ok=false errors=' + JSON.stringify(r.errors))
	if (expectDir && r.dir !== expectDir) issues.push('dir=' + r.dir + ' expect ' + expectDir)
	if (uncovered) issues.push('uncovered=' + uncovered)
	// 时间字段可读性
	const tips = []
	for (const c of bm) if (c && c.tip) tips.push(c.tip)
	const timeTips = tips.filter((t) => /时间|平台时间|realtime|实时/.test(t))
	const tlvSummary = (r.tlv || [])
		.map((t) => {
			const items = (t.items || []).map((i) => 'ID' + i.id + '=' + (i.decoded || hexShort(i.raw))).join(';')
			return 'Tag' + t.tag + '[' + items + ']'
		})
		.join(' | ')
	return { r, uncovered, issues, tlvSummary, timeTips }
}

function hexShort(raw) {
	if (!raw || !raw.length) return ''
	return Array.from(raw)
		.map((b) => ('0' + b.toString(16)).slice(-2))
		.join('')
}

function main() {
	console.log('=== build C mirror ===')
	buildC()
	const W = loadWeb()

	console.log('\n=== A) C uplink → Web parse ===')
	const cups = genCUplinks()
	let aPass = 0,
		aFail = 0
	const aNotes = []
	for (const s of cups) {
		const { r, uncovered, issues, tlvSummary, timeTips } = analyzeWebParse(W, s.name, s.bytes, 'up')
		const bad = issues.length > 0
		if (bad) {
			aFail++
			console.log('FAIL', s.name, issues.join('; '))
			console.log('  tlv:', tlvSummary)
			console.log('  timeTips:', timeTips.join(' | ') || '(none)')
			aNotes.push({ name: s.name, issues, tlvSummary, timeTips, fields: r.fields })
		} else {
			aPass++
			console.log('PASS', s.name, 'dir=' + r.dir, 'tlv:', tlvSummary.slice(0, 120))
			// 额外标注时间解码是否像 BCD
			if (timeTips.length) {
				const weird = timeTips.filter((t) => /-----|null|NaN|\d{10,}/.test(t) && !/2026|20\d{2}-/.test(t))
				if (weird.length) {
					console.log('  NOTE time decode suspicious:', weird.join(' | '))
					aNotes.push({ name: s.name, note: 'time', timeTips })
				}
			}
		}
	}
	console.log('A_SUMMARY pass=' + aPass + ' fail=' + aFail)

	console.log('\n=== B) Web downlink → C parse ===')
	const downs = genWebDowns(W)
	const feed = downs.map((d) => 'WEB_DOWN ' + d.name + ' ' + d.hex).join('\n') + '\n'
	const cOut = spawnSync(C_BIN, ['check'], { input: feed, encoding: 'utf8' })
	process.stdout.write(cOut.stdout || '')
	if (cOut.stderr) process.stderr.write(cOut.stderr)

	// 网页自洽：生成后自己解析
	console.log('\n=== B2) Web downlink self-parse ===')
	let b2p = 0,
		b2f = 0
	for (const d of downs) {
		const { issues, tlvSummary } = analyzeWebParse(W, d.name, d.frame, 'down')
		if (issues.length) {
			b2f++
			console.log('FAIL', d.name, issues.join('; '), tlvSummary.slice(0, 100))
		} else b2p++
	}
	console.log('B2_SUMMARY pass=' + b2p + ' fail=' + b2f + ' total=' + downs.length)

	// 对比平台时间字节序：C 风格 vs Web bcdEncode reverse
	console.log('\n=== C) platform time byte order check ===')
	const webFrame = W.skBuildDownFrame({
		funcCode: '0x03',
		version: 2,
		time: new Date('2026-07-22T10:30:00'),
		frameSeq: 1,
		tlv: [{ tag: 10, items: [{ id: 1, value: [] }] }],
	})
	const webTime = Array.from(webFrame.slice(5, 12))
		.map((b) => ('0' + b.toString(16)).slice(-2))
		.join(' ')
	const cTime = '20 26 07 22 10 30 00' // writeBcdTimeToBytes style for 2026-07-22 10:30:00 BCD fields
	console.log('Web down platform time bytes:', webTime)
	console.log('C   writeBcdTimeToBytes style:', cTime)
	console.log('Match:', webTime === cTime ? 'YES' : 'NO — endian/layout differs')

	// 文档差异摘录
	console.log('\n=== DIFF NOTES (for report) ===')
	console.log(
		JSON.stringify(
			{
				a_c_up_to_web: { pass: aPass, fail: aFail, notes: aNotes },
				time_layout: { web: webTime, c_style: cTime, same: webTime === cTime },
				init_mode: {
					web_preset: { 0: '数据初始化', 1: '参数初始化', 2: '恢复出厂', 3: '信息初始化' },
					c_enum: { 1: 'INIT_DATA', 2: 'INIT_PARAMS', 3: 'INIT_FACTORY', 4: 'INIT_INFO' },
				},
			},
			null,
			2
		)
	)
}

main()
