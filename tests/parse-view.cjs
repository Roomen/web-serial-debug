// Run: node tests/parse-view.cjs — synthetic data only.
// 覆盖: 日志「解析」渲染器 js/parse-view.js（转义、折叠、键值对拆分），以及 SEK / 工装 / W-MBUS 三个协议的 logView 模型
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const registered = {}
const window = { registerProtocol(id, impl) { registered[id] = impl } }
const ctx = { window, Uint8Array, BigInt, TextDecoder, TextEncoder, console, localStorage: { getItem() { return null }, setItem() {} }, document: { getElementById() { return null } } }
vm.createContext(ctx)
for (const f of ['parse-view', 'protocol-schema', 'protocol-crypto', 'protocol', 'gz-protocol', 'wmbus-protocol']) {
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8'), ctx)
}
const PV = window.ParseView
const J = x => JSON.parse(JSON.stringify(x))
const hex = s => Uint8Array.from(s.split(/\s+/).filter(Boolean).map(x => parseInt(x, 16)))

// ---- 渲染器: 全部文本字段转义，只有 section.html 原样插入 ----
{
	const evil = '<script>alert(1)</script>'
	const html = PV.render({
		title: evil, code: evil, dir: 'up',
		subject: { label: evil, value: evil },
		badges: [{ text: evil, kind: 'bad', title: '"><img>' }],
		meta: [[evil, evil]],
		notes: [{ text: evil, kind: 'warn' }],
		sections: [{ title: evil, groups: [{ title: evil, pairs: [[evil, evil, evil, 'bad']] }], pairs: [[evil, evil]], pre: evil, errors: [evil], html: '<b class="raw">ok</b>' }],
		errors: [evil],
	}, { tag: evil })
	assert.ok(!html.includes('<script>') && !html.includes('<img>'), html)
	assert.ok(html.includes('<b class="raw">ok</b>'), 'section.html 原样插入')
	assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
	assert.ok(html.includes('pv-v pv-bad'), 'kind=bad 的值标红')
}
// 未知 kind 不会拼进 class；缺省标题有兜底
assert.ok(!PV.render({ title: 'x', badges: [{ text: 'a', kind: '" onmouseover="x' }] }).includes('onmouseover'))
assert.ok(PV.render({}).includes('<span class="pv-title">帧</span>'))
assert.equal(PV.render(null), '')
assert.equal(PV.render([]), '')

// ---- 折叠: 头部作 summary，其余进 details；没有其余内容时不折叠 ----
{
	const model = { title: 'T', dir: 'down', meta: [['a', 'b']], sections: [{ pairs: [['k', 'v']] }] }
	const folded = PV.render(model, { collapsed: true })
	assert.ok(folded.startsWith('<details class="pv pv-down pv-fold"><summary class="pv-head">'), folded)
	assert.ok(folded.indexOf('</summary>') < folded.indexOf('pv-meta'))
	assert.ok(PV.render({ title: 'T' }, { collapsed: true }).startsWith('<div class="pv">'))
	assert.ok(PV.render(model).startsWith('<div class="pv pv-down">'))
	// 多帧: 每帧各自成块
	assert.equal(PV.render([model, model]).split('class="pv pv-down"').length - 1, 2)
	// 模型没给方向时用调用方兜底
	assert.ok(PV.render({ title: 'T' }, { dir: 'up' }).includes('pv-up'))
}

// ---- 复制/导出: 单元里「标签」「值」之间是真空格，innerText 不会黏在一起 ----
assert.ok(PV.render({ title: 'T', sections: [{ pairs: [['标签', '值', 'ID9']] }] }).includes('</span> <span class="pv-v">值</span> <span class="pv-h">ID9</span></div>'))

// ---- linesToPairs ----
{
	const r = PV.linesToPairs('devType = 1 METER  DRN = 12345\nreason = 1（台架惯例 1=读表 2=参数）\ntxOk=1  rxOk=2\n阀门状态=开 电量状态=正常\n基准时间=2026-01-01 08:00:00  采样间隔=60分钟\n（无载荷）\n\n')
	assert.deepEqual(J(r.pairs), [
		['devType', '1 METER'], ['DRN', '12345'],
		['reason', '1', '台架惯例 1=读表 2=参数'],
		['txOk', '1'], ['rxOk', '2'],
		['阀门状态', '开'], ['电量状态', '正常'],
		['基准时间', '2026-01-01 08:00:00'], ['采样间隔', '60分钟'],
	])
	assert.deepEqual(J(r.notes), ['（无载荷）'])
	assert.deepEqual(J(PV.linesToPairs('k = a = b').pairs), [['k', 'a = b']])
	assert.deepEqual(J(PV.linesToPairs(null)), { pairs: [], notes: [] })
}

// ---- SEK ----
const sekUp = (fc, tlv, ctrl) => {
	const head = [0xA9, 0x9A, 0x05, 0x00, 0x02, 0x01, 0x10, 0x00, 0x12, 0x34, 0x56, 0x78, 0x90, 0x12, 0x9C, 0xFF, 0x0A, 0x00, 0x00, 0x1A, fc, ctrl || 0]
	const data = [tlv.length & 255, tlv.length >> 8].concat(tlv)
	const f = head.concat([data.length & 255, data.length >> 8]).concat(data)
	const c = window.skCrc16(Uint8Array.from(f))
	return f.concat([c & 255, c >> 8, 0x16])
}
const tag = (t, items) => { let p = []; items.forEach(it => { p = p.concat(it) }); return [t, p.length & 255, p.length >> 8].concat(p) }
{
	const frame = sekUp(0x02, tag(2, [[0, 0x39, 0x30, 0, 0], [3, 0xE8, 0x00], [10, 0x5E, 0x01]]))
	const m = J(window.skLogView(window.skParseFrame(frame)))
	assert.equal(m.title, '终端数据上报')
	assert.equal(m.code, '0x02')
	assert.equal(m.dir, 'up')
	assert.equal(m.subject.label, '设备')
	assert.ok(/^\d{14}$/.test(m.subject.value))
	assert.ok(m.badges.some(b => b.text === 'CRC ✓' && b.kind === 'ok'))
	assert.ok(m.meta.some(x => x[0] === 'RSRP'))
	assert.ok(!m.meta.some(x => ['功能码', '控制码', '数据域字节数', '设备唯一编码'].includes(x[0])))
	assert.ok(m.sections[0].title.startsWith('Tag2'))
	const pairs = m.sections[0].groups.flatMap(g => g.pairs)
	assert.ok(pairs.some(p => p[2] === 'ID0'), 'hint 为 ID')
	// CRC 损坏: 仍出模型，徽标变红
	const bad = frame.slice()
	bad[bad.length - 3] ^= 0xff
	assert.ok(J(window.skLogView(window.skParseFrame(bad))).badges.some(b => b.kind === 'bad'))
	// 应答结果码: 成功绿、失败红
	const ack = (code) => J(window.skLogView(window.skParseFrame(sekUp(0x81, tag(3, [[9, code]])))))
	assert.equal(ack(1).sections[0].pairs[0][3], 'ok')
	assert.equal(ack(4).sections[0].pairs[0][3], 'bad')
	// 下行帧没有设备编码
	const down = window.skBuildDownFrame({ funcCode: 0x03, tlv: [{ tag: 10, items: [{ id: 2 }] }] })
	const dm = J(window.skLogView(window.skParseFrame(down)))
	assert.equal(dm.dir, 'down')
	assert.equal(dm.title, '信息查询')
	assert.equal(dm.subject, undefined)
	// 不是 SEK 帧
	for (const junk of [[], [1, 2, 3], hex('00 11 22 33 44 55 66 77 88 99 AA BB CC DD EE FF 00 11 22 33'), [...frame.slice(1)]]) {
		assert.equal(window.skLogView(window.skParseFrame(junk)), null)
	}
	// 同一份模型渲染后没有未转义的设备字符串
	assert.ok(PV.render(m).includes('pv-grid'))
}

// ---- 工装 gz ----
{
	const gz = window.gzBuildDownFrame({ cmd: 0x05 }).frame
	const m = J(window.gzLogView(window.gzParseFrame(gz)))
	assert.ok(m.title && m.code)
	assert.ok(m.badges.some(b => b.text === 'XOR ✓'))
	const bad = Array.from(gz)
	bad[bad.length - 1] ^= 0xff
	assert.ok(J(window.gzLogView(window.gzParseFrame(bad))).badges.some(b => b.text === 'XOR ✗' && b.kind === 'bad'))
	for (const junk of [[], [1, 2], hex('00 11 22 33 44')]) assert.equal(window.gzLogView(window.gzParseFrame(junk)), null)
}

// ---- W-MBUS ----
{
	const down = window.wmbusBuildDownFrame({ addr: '01 02 03 04 05 06 07 08', keyId: 0, mcnt: 7, cmd: 0x10 })
	const m = J(window.wmbusLogView(window.wmbusParseFrame(down)))
	assert.equal(m.dir, 'down')
	assert.equal(m.code, '0x10')
	assert.equal(m.subject.value, '0102030405060708')
	assert.ok(m.badges.some(b => b.text === 'CMAC ✓' && b.kind === 'ok'))
	assert.ok(m.meta.some(x => x[0] === 'MCNT' && x[1] === 7))
	// CMAC 失败: 解密内容不可信，不给标题里的命令名，也不渲染内容
	const tampered = Array.from(down)
	tampered[tampered.length - 1] ^= 1
	const bm = J(window.wmbusLogView(window.wmbusParseFrame(tampered)))
	assert.ok(bm.badges.some(b => b.text === 'CMAC ✗' && b.kind === 'bad'))
	assert.equal(bm.code, '')
	assert.equal(bm.sections.length, 0)
	for (const junk of [[], [1, 2, 3], new Uint8Array(40)]) assert.equal(window.wmbusLogView(window.wmbusParseFrame(junk)), null)
	// 写角色密钥: 解密出的密钥在日志里脱敏
	const keyFrame = window.wmbusBuildDownFrame({ addr: '01 02 03 04 05 06 07 08', keyId: 0, mcnt: 8, cmd: 0x83, payloadHex: '01 ' + 'AB '.repeat(16) })
	const km = window.wmbusLogView(window.wmbusParseFrame(keyFrame))
	assert.ok(JSON.stringify(km).includes('已脱敏'))
	assert.ok(!JSON.stringify(km).toLowerCase().includes('abababab'))
}

assert.equal(typeof registered.gz.logView, 'function')
assert.equal(typeof registered.wmbus.logView, 'function')
console.log('parse view checks passed')
