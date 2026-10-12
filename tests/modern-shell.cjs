// Run: node tests/modern-shell.cjs — synthetic data only.
// 覆盖: 现代布局外壳 js/modern-shell.js 的纯函数（日志过滤的解析与匹配、连接按钮的参数摘要、日志缩放档位、串口列表行的标题 / 次行 / 状态）
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const ctx = { console }
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/modern-shell.js'), 'utf8'), ctx)
const M = ctx.ModernShell
assert.ok(M && typeof M.parseLogFilter === 'function')

const P = M.parseLogFilter
const match = function (q, row) { return M.matchLogFilter(P(q), row) }
const tx = { dir: 'tx', text: '10:00:00.100 TX 8B 68 10 AA 01 03 90 1F 16', hex: '68 10 AA 01 03 90 1F 16' }
const rx = { dir: 'rx', text: '10:00:00.300 RX 6B [BOOT] app ok', hex: '5B 42 4F 4F 54 5D' }
const sys = { dir: '', text: '10:00:01.000 ! 未选择串口设备', hex: '' }

// ---- 解析 ----
{
	assert.equal(P('').empty, true)
	assert.equal(P('   ').empty, true)
	assert.equal(P(null).empty, true)
	const f = P('RX 68 10 aa boot 7E')
	assert.deepEqual(Array.from(f.dirs), ['rx'])
	assert.deepEqual(JSON.parse(JSON.stringify(f.seqs)), [['68', '10', 'AA'], ['7E']], '方向词/普通词打断字节序列')
	assert.deepEqual(Array.from(f.words), ['boot'])
	assert.deepEqual(Array.from(P('tx tx rx').dirs), ['tx', 'rx'], '方向去重')
	assert.deepEqual(Array.from(P('0x68 ABC').words), ['0x68', 'abc'], '不是两位十六进制的都按关键字')
}

// ---- 匹配 ----
{
	assert.equal(match('', tx), true, '空过滤全显示')
	assert.equal(match('tx', tx), true)
	assert.equal(match('tx', rx), false)
	assert.equal(match('tx rx', rx), true, '多个方向之间是或')
	assert.equal(match('sys', sys), true, '没有方向的行按 sys')
	assert.equal(match('rx', sys), false)
	assert.equal(match('68 10 aa', tx), true, '字节序列不区分大小写')
	assert.equal(match('10 AA 01', tx), true)
	assert.equal(match('68 AA', tx), false, '字节序列必须连续')
	assert.equal(match('A 01', { dir: 'tx', text: 'x', hex: 'AA 01' }), false, '单个十六进制位不是字节，按关键字匹配文本')
	assert.equal(match('0A', { dir: 'rx', text: 'x', hex: '10 A0 1A' }), false, '按字节边界匹配，不跨字节拼接')
	assert.equal(match('boot', rx), true, '关键字不区分大小写')
	assert.equal(match('boot tx', rx), false, '各条件同时满足')
	assert.equal(match('未选择', sys), true)
	assert.equal(match('ab', { dir: 'rx', text: 'tab key', hex: '74 61 62' }), true, '两位十六进制词也按原文匹配文本')
	assert.equal(match('5b 42', rx), true, '文本行按其 HEX 匹配字节')
	assert.equal(match('90 1F', { dir: 'tx', text: 'TX', hex: '  90   1f ' }), true, 'HEX 里多余空白与小写不影响')
}

// ---- 参数摘要 ----
{
	assert.equal(M.compactParams('115200 8-N-1'), '115200 8N1')
	assert.equal(M.compactParams('2400 8-E-1'), '2400 8E1')
	assert.equal(M.compactParams(' 9600 7-O-2 '), '9600 7O2')
	assert.equal(M.compactParams('- 8-N-1'), '- 8N1')
	assert.equal(M.compactParams('奇怪的文案'), '奇怪的文案', '格式不认识就原样')
	assert.equal(M.compactParams(undefined), '')
}

// 日志缩放：70%–200%，每档 10%，坏值回落 100%，浮点不漂
{
	assert.equal(M.clampZoom(1), 1)
	assert.equal(M.clampZoom('1.3'), 1.3)
	assert.equal(M.clampZoom(5), 2)
	assert.equal(M.clampZoom(0.1), 0.7)
	assert.equal(M.clampZoom('abc'), 1)
	assert.equal(M.clampZoom(null), 1)
	assert.equal(M.clampZoom(-1), 1)
	assert.equal(M.stepZoom(1, 1), 1.1)
	assert.equal(M.stepZoom(1.1, 1), 1.2, '0.1 累加不出 1.2000000000000002')
	assert.equal(M.stepZoom(0.7, -1), 0.7)
	assert.equal(M.stepZoom(2, 1), 2)
	let z = 1
	for (let i = 0; i < 20; i++) z = M.stepZoom(z, 1)
	assert.equal(z, 2)
}

// 串口列表行
{
	const native = { alias: null, productName: 'CP2102 USB to UART Bridge Controller', portName: 'cu.usbserial-0001', vid: '10c4', pid: 'ea60', sn: 'AB12', slot: null }
	assert.equal(M.portRowTitle(native), 'CP2102 USB to UART Bridge Controller')
	assert.equal(M.portRowSub(native), 'cu.usbserial-0001 · 10C4:EA60 · SN AB12')
	assert.equal(M.portRowTitle(Object.assign({}, native, { alias: '电表 1 号' })), '电表 1 号')
	assert.equal(M.portRowTitle(Object.assign({}, native, { slot: 1 })), 'CP2102 USB to UART Bridge Controller #2')
	// 没产品名：标题是口名，次行不重复口名
	const bare = { portName: 'COM3', vid: '1a86', pid: '7523' }
	assert.equal(M.portRowTitle(bare), 'COM3')
	assert.equal(M.portRowSub(bare), '1A86:7523')
	// 网页版只有 VID/PID
	assert.equal(M.portRowTitle({ vid: '1a86', pid: '7523' }), 'USB 串口设备')
	assert.equal(M.portRowTitle({}), '串口设备')
	assert.equal(M.portRowSub({}), '')

	assert.equal(JSON.stringify(M.portRowState({})), JSON.stringify({ tag: '', kind: 'idle', disabled: false }))
	assert.equal(M.portRowState({ current: true }).kind, 'current')
	assert.equal(M.portRowState({ current: true, open: true }).tag, '已连接')
	assert.equal(M.portRowState({ current: true, open: true, opening: true }).kind, 'opening')
	assert.equal(M.portRowState({ current: true, failed: true, open: true }).kind, 'failed')
	const busy = M.portRowState({ owner: 'B' })
	assert.equal(busy.tag, 'B 路占用')
	assert.equal(busy.disabled, true)
	assert.equal(M.portRowState({ owner: 'S' }).tag, '单路占用')
	assert.equal(M.portRowState({ owner: 'BLU' }).tag, '功耗分析占用')
	// 未在位优先于其它状态：灰显、不可选
	assert.equal(JSON.stringify(M.portRowState({ absent: true, current: true })), JSON.stringify({ tag: '未在位', kind: 'absent', disabled: true }))
}

console.log('modern-shell ok')
