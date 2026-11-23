// Run: node tests/ui-params-busy.cjs — synthetic data only.
// 覆盖: 参数卡忙碌态（js/common.js）。目标路打开/关闭/换参重连期间字段禁用且 change 拒绝落盘；
// 切换 paramsTarget 忙碌态跟随该路；结束恢复；原本因别的原因禁用的字段不被解开；
// 单路未打开时 change 不落盘（既有语义）。执行的是真实 SerialHub.setOpening / applySerialParamsToUI /
// setParamsTarget / refreshParamsBusyUI / 参数卡 change handler / reopenWithNewParams，不是 mock。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
const DualConfig = require('../js/dual-config.js')

function slice(startMark, endMark, from) {
	const start = source.indexOf(startMark, from || 0)
	const end = source.indexOf(endMark, start)
	assert.ok(start > 0 && end > start, 'common.js 锚点不见了: ' + startMark.trim())
	return { src: source.slice(start, end), end }
}
const hubStart = source.indexOf('\tfunction makeSerialSession(')
const hubEnd = source.indexOf('\n\t}\n', source.indexOf('\tconst SerialHub = {'))
assert.ok(hubStart > 0 && hubEnd > hubStart, 'common.js 的 SerialHub 段不见了')
const hubSrc = source.slice(hubStart, hubEnd + 3)
const params = slice('\t// ===== 串口参数配置：单路、双路 A、双路 B 各自独立 =====', '\t// MCP 与 UI 共用：读某一路归一化后的参数')
// refreshParamsBusyUI 里也有同一个 querySelectorAll，参数卡 handler 要从参数段之后找
const handler = slice("\tdocument.querySelectorAll('#serial-params-popover", '\t//重制发送循环时钟', params.end)
const paramsSrc = params.src + slice('\tfunction portTransport(port)', '\tfunction laneParams(sid)').src
const handlerSrc = handler.src

const FIELD_IDS = ['serial-baud', 'serial-data-bits', 'serial-stop-bits', 'serial-parity', 'serial-buffer-size', 'serial-flow-control']
const FIELD_VALS = { 'serial-baud': '115200', 'serial-data-bits': '8', 'serial-stop-bits': '1', 'serial-parity': 'none', 'serial-buffer-size': '1024', 'serial-flow-control': 'none' }
const settle = () => new Promise(resolve => setImmediate(resolve))

function harness() {
	const store = new Map()
	const writes = []
	const fields = {}
	FIELD_IDS.forEach((id) => {
		fields[id] = {
			id, disabled: false, value: FIELD_VALS[id], listeners: [],
			addEventListener(t, fn) { if (t === 'change') this.listeners.push(fn) },
			async fire() { for (const fn of this.listeners.slice()) await fn({ target: this }) },
		}
	})
	const calls = { close: [], open: [] }
	const gates = { close: null, open: null }
	const ctx = {
		console, Promise, Set, Map, WeakMap, JSON, Object, Array, parseInt, isFinite, Number, String,
		window: { DualConfig, Workbench: null },
		CustomEvent: class { constructor(type, init) { this.type = type; if (init) Object.assign(this, init) } },
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => { writes.push(k); store.set(k, String(v)) },
			removeItem: (k) => store.delete(k),
		},
		document: {
			getElementById: (id) => fields[id] || null,
			querySelectorAll: (sel) => (sel.indexOf('serial-params-popover') >= 0 ? FIELD_IDS.map((id) => fields[id]) : []),
			dispatchEvent() {},
		},
		get: (id) => (fields[id] ? fields[id].value : undefined),
		set: (id, v) => { if (fields[id]) fields[id].value = String(v) },
		pinSid: null,
		laneMoving: false,
		// reopenWithNewParams / 单路分支的 I/O 只留闸门桩，忙碌标记走的是真实 setOpening
		closeSerial: async (sid) => { calls.close.push(sid); if (gates.close) await gates.close.p },
		openSerial: async (sid) => { calls.open.push(sid); if (gates.open) await gates.open.p; return true },
		setTimeout: (fn) => { fn(); return 0 },
		clearTimeout: () => {},
	}
	vm.createContext(ctx)
	vm.runInContext(
		hubSrc + paramsSrc + handlerSrc +
		'\nglobalThis.api = { SerialHub, setParamsTarget, applySerialParamsToUI, paramsSid, reopenWithNewParams,' +
		' getLaneOptions: () => laneOptions, getParamsTarget: () => paramsTarget, paramsBusyDisabled }',
		ctx)
	return { api: ctx.api, fields, calls, gates, writes, store,
		gate(name) { let resolve; const p = new Promise((r) => { resolve = r }); gates[name] = { p, resolve } },
		disabled() { return FIELD_IDS.map((id) => fields[id].disabled) } }
}

async function main() {
	// ---- 双路：A 正在打开，UI change 不覆盖 laneOptions、不落盘，字段值被恢复 ----
	{
		const h = harness()
		const { api, fields } = h
		api.SerialHub.mode = 'dual'
		api.applySerialParamsToUI()
		const before = api.getLaneOptions().A.baudRate
		const writesBefore = h.writes.length
		api.SerialHub.setOpening('A', true) // openSerial 拍快照后的打开期间
		assert.deepEqual(h.disabled(), [true, true, true, true, true, true], 'A 打开期间字段应全部禁用')
		fields['serial-baud'].value = '9600'
		await fields['serial-baud'].fire()
		assert.equal(api.getLaneOptions().A.baudRate, before, 'opening 期间 change 不得写 laneOptions')
		assert.equal(h.writes.length, writesBefore, 'opening 期间 change 不得持久化')
		assert.equal(fields['serial-baud'].value, String(before), '被拒的字段值应恢复成实际参数')
		assert.equal(h.calls.open.length + h.calls.close.length, 0, 'opening 期间不得触发重连')
		api.SerialHub.setOpening('A', false)
		assert.deepEqual(h.disabled(), [false, false, false, false, false, false], '打开结束后字段恢复可编辑')
	}

	// ---- 双路：换参重连期间（真实 reopenWithNewParams + setOpening）字段禁用、后续 change 被拒 ----
	{
		const h = harness()
		const { api, fields } = h
		api.SerialHub.mode = 'dual'
		api.applySerialParamsToUI()
		api.SerialHub.setOpen('A', true)
		h.gate('close'); h.gate('open')
		fields['serial-baud'].value = '57600'
		const done = fields['serial-baud'].fire() // 走真实 handler：落盘 → reopenWithNewParams
		await settle(); await settle()
		assert.equal(api.getLaneOptions().A.baudRate, 57600, '空闲路的 change 正常落盘')
		assert.ok(h.writes.includes('serialOptionsDualLanes'), '正常变更应持久化')
		assert.deepEqual(h.disabled(), [true, true, true, true, true, true], '换参重连期间字段禁用')
		fields['serial-baud'].value = '4800'
		await fields['serial-baud'].fire()
		assert.equal(api.getLaneOptions().A.baudRate, 57600, '重连期间的 change 不得覆盖刚落盘的参数')
		assert.equal(fields['serial-baud'].value, '57600', '被拒后字段恢复成实际参数')
		h.gates.close.resolve(); await settle()
		assert.deepEqual(h.disabled(), [true, true, true, true, true, true], '关闭后重开期间仍禁用')
		h.gates.open.resolve(); await done
		assert.deepEqual(h.disabled(), [false, false, false, false, false, false], '重连结束字段恢复')
		assert.deepEqual(h.calls.close, ['A']); assert.deepEqual(h.calls.open, ['A'], '只对目标路重连')
	}

	// ---- 双路：忙碌态跟随 paramsTarget，另一空闲路仍可编辑 ----
	{
		const h = harness()
		const { api, fields } = h
		api.SerialHub.mode = 'dual'
		api.applySerialParamsToUI()
		api.SerialHub.setOpening('A', true)
		assert.ok(h.disabled().every(Boolean), '目标 A 忙：禁用')
		api.setParamsTarget('B')
		assert.ok(h.disabled().every((d) => !d), '切到空闲 B：可编辑')
		fields['serial-baud'].value = '9600'
		await fields['serial-baud'].fire()
		assert.equal(api.getLaneOptions().B.baudRate, 9600, '空闲 B 的 change 正常落盘')
		assert.equal(api.getLaneOptions().A.baudRate, 115200, '不碰忙碌的 A')
		api.setParamsTarget('A')
		assert.ok(h.disabled().every(Boolean), '切回忙碌的 A：禁用')
		api.SerialHub.setOpening('A', false)
		assert.ok(h.disabled().every((d) => !d), 'A 结束后恢复')
	}

	// ---- 单路：S 忙碌禁用、结束恢复；未打开时 change 不落盘不重连（既有语义） ----
	{
		const h = harness()
		const { api, fields } = h
		assert.equal(api.SerialHub.mode, 'single')
		api.applySerialParamsToUI()
		fields['serial-baud'].value = '9600'
		await fields['serial-baud'].fire()
		assert.equal(h.writes.filter((k) => k === 'serialOptions').length, 0, '单路未打开时 change 不写 serialOptions')
		assert.equal(h.calls.open.length + h.calls.close.length, 0, '单路未打开时 change 不重连')
		api.SerialHub.setOpening('S', true)
		assert.ok(h.disabled().every(Boolean), '单路 S 打开期间字段禁用')
		fields['serial-baud'].value = '4800'
		await fields['serial-baud'].fire()
		assert.equal(h.calls.open.length + h.calls.close.length, 0, 'S 打开期间的 change 不触发重连')
		api.SerialHub.setOpening('S', false)
		assert.ok(h.disabled().every((d) => !d), 'S 结束后恢复')
	}

	// ---- 原本因别的原因禁用的字段不被忙碌恢复解开 ----
	{
		const h = harness()
		const { api, fields } = h
		api.SerialHub.mode = 'dual'
		fields['serial-flow-control'].disabled = true // 其它来源的禁用
		api.SerialHub.setOpening('A', true)
		api.SerialHub.setOpening('A', false)
		assert.equal(fields['serial-flow-control'].disabled, true, '原本禁用的字段保持禁用')
		assert.ok(FIELD_IDS.filter((id) => id !== 'serial-flow-control').every((id) => !fields[id].disabled), '其余字段恢复')
	}

	console.log('ui-params-busy: ok')
}
main().catch((e) => { console.error(e); process.exit(1) })
