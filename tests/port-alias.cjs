// Run: node tests/port-alias.cjs — synthetic data only.
// 覆盖: 串口设备别名(js/common.js 里 `// ===== 串口设备别名 v2` 到 `/** 检查端口是否有持久化 key` 之间，按这两行注释截取，别删)。
// 桌面客户端原生后端的 getInfo 带路径、产品名、序列号：改名后重启(新的端口对象、空的身份缓存)按序列号或路径认回别名，
// 首次显示(身份还没异步解析)就是别名；同型号的另一台设备(路径或序列号不同)不会靠产品名 / VID:PID / getPorts 排位的 slot 被套上别名，
// 改名与清除别名也不会合并或删掉另一台的记录；网页版只有 VID/PID 的口(含同型号多 CDC 的 slot)照旧
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const N = require('../js/transport-native-serial.js')

const source = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
const start = source.indexOf('\t// ===== 串口设备别名 v2')
const end = source.indexOf('\t/** 检查端口是否有持久化 key', start)
assert.ok(start > 0 && end > start, 'common.js 别名段的锚点不见了')
const aliasSrc = source.slice(start, end)

function memStorage() {
	const m = new Map()
	return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

// 一次「启动」：新的 vm 上下文 = 空的身份缓存；storage 跨启动共享(localStorage)
function boot(storage, ports, backend) {
	const ctx = {
		window: {},
		console,
		localStorage: storage,
		showToast() {},
		SerialHub: { allPhys: () => [], getPort: () => null },
		SerialAdapter: {
			backend: backend || 'native',
			getUsbDevices: async () => [],
			getPorts: async () => ports.slice(),
		},
	}
	vm.createContext(ctx)
	vm.runInContext(aliasSrc + '\nthis.api = { setPortAlias, getPortDisplayName, getPortAlias, resolvePortIdentity, lookupAlias }', ctx)
	return ctx.api
}

function nativePort(desc) {
	return { open() {}, getInfo() { return N.portInfo(desc) } }
}

const CP_A = { path: '/dev/cu.usbserial-0001', name: 'cu.usbserial-0001', vendorId: 0x10c4, productId: 0xea60, serialNumber: 'AB12', manufacturer: 'Silicon Labs', product: 'CP2102 USB to UART Bridge Controller' }
const CP_B = Object.assign({}, CP_A, { path: '/dev/cu.usbserial-0002', name: 'cu.usbserial-0002', serialNumber: 'CD34' })
const CH_1 = { path: '/dev/cu.usbserial-1410', name: 'cu.usbserial-1410', vendorId: 0x1a86, productId: 0x7523, product: 'USB Serial' }
const CH_2 = Object.assign({}, CH_1, { path: '/dev/cu.usbserial-1420', name: 'cu.usbserial-1420' })

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('有序列号的设备：改名后重启按序列号认回，首次同步显示就是别名；换了口名也认得', async () => {
	const storage = memStorage()
	const p = nativePort(CP_A)
	const a1 = boot(storage, [p])
	await a1.setPortAlias(p, '电表 1 号')
	assert.equal(a1.getPortDisplayName(p), '电表 1 号')
	// 重启：新端口对象，身份缓存为空，还没异步解析
	const p2 = nativePort(CP_A)
	const a2 = boot(storage, [p2])
	assert.equal(a2.getPortDisplayName(p2), '电表 1 号', '首次显示不必等异步解析')
	await a2.resolvePortIdentity(p2)
	assert.equal(a2.getPortDisplayName(p2), '电表 1 号')
	// 插到另一个 USB 口，口名变了，序列号相同
	const p3 = nativePort(Object.assign({}, CP_A, { path: '/dev/cu.usbserial-0009', name: 'cu.usbserial-0009' }))
	const a3 = boot(storage, [p3])
	assert.equal(a3.getPortDisplayName(p3), '电表 1 号')
})

test('同型号另一台(序列号不同)不被套上别名，两台同时在位也各显示各的', async () => {
	const storage = memStorage()
	const pa = nativePort(CP_A)
	const a1 = boot(storage, [pa])
	await a1.setPortAlias(pa, '电表 1 号')
	const pa2 = nativePort(CP_A)
	const pb = nativePort(CP_B)
	const a2 = boot(storage, [pa2, pb])
	assert.equal(a2.getPortDisplayName(pa2), '电表 1 号')
	assert.notEqual(a2.getPortDisplayName(pb), '电表 1 号')
	await a2.resolvePortIdentity(pa2)
	await a2.resolvePortIdentity(pb)
	assert.equal(a2.getPortDisplayName(pa2), '电表 1 号')
	assert.equal(a2.getPortAlias(pb), null)
	// 两台都在位时给第二台改名，重启后各自认回
	await a2.setPortAlias(pb, '电表 2 号')
	const a3 = boot(storage, [nativePort(CP_A), nativePort(CP_B)])
	const qa = nativePort(CP_A)
	const qb = nativePort(CP_B)
	assert.equal(a3.getPortDisplayName(qa), '电表 1 号')
	assert.equal(a3.getPortDisplayName(qb), '电表 2 号')
})

test('没有序列号的设备按路径认回；同型号插在另一个口的另一台不套这条别名', async () => {
	const storage = memStorage()
	const p = nativePort(CH_1)
	const a1 = boot(storage, [p])
	await a1.setPortAlias(p, '调试板')
	const a2 = boot(storage, [nativePort(CH_1), nativePort(CH_2)])
	const q1 = nativePort(CH_1)
	const q2 = nativePort(CH_2)
	assert.equal(a2.getPortDisplayName(q1), '调试板')
	assert.equal(a2.getPortAlias(q2), null, '只靠产品名 / VID:PID 命中、路径不同：是另一台')
	assert.equal(a2.getPortDisplayName(q2), 'USB Serial (cu.usbserial-1420)')
})

test('网页版只有 VID/PID 的口：别名照旧按 VID/PID 认回', async () => {
	const storage = memStorage()
	const web = () => ({ open() {}, getInfo() { return { usbVendorId: 0x1a86, usbProductId: 0x7523 } } })
	const p = web()
	const a1 = boot(storage, [p], 'web')
	await a1.setPortAlias(p, '网页设备')
	const p2 = web()
	const a2 = boot(storage, [p2], 'web')
	await a2.resolvePortIdentity(p2)
	assert.equal(a2.getPortDisplayName(p2), '网页设备')
})

// 两台同型号同时在位：getPorts 顺序给的 slot 只是排位，拔插后顺序会变。路径 / 序列号对不上的另一台，slot 命中也不能套别名
async function resolveAll(api, ports) {
	for (const p of ports) await api.resolvePortIdentity(p)
}
test('同型号两台 [X,Y] 给 X 命名，拔插后 getPorts 变成 [Y,X]：Y 不靠 slot 0 套上 X 的别名，X 仍按路径认回', async () => {
	for (const pair of [[CP_A, CP_B], [CH_1, CH_2]]) {
		const storage = memStorage()
		const x = nativePort(pair[0])
		const y = nativePort(pair[1])
		const a1 = boot(storage, [x, y])
		await resolveAll(a1, [x, y])
		await a1.setPortAlias(x, '设备 X')
		const y2 = nativePort(pair[1])
		const x2 = nativePort(pair[0])
		const a2 = boot(storage, [y2, x2])
		await resolveAll(a2, [y2, x2])
		assert.equal(a2.getPortAlias(y2), null, 'slot 0 换成了 Y，路径 / 序列号都对不上')
		assert.equal(a2.getPortAlias(x2), '设备 X')
	}
})

test('全新的同型号设备占了 X 原来的 slot：不套 X 的别名', async () => {
	const storage = memStorage()
	const x = nativePort(CP_A)
	const y = nativePort(CP_B)
	const a1 = boot(storage, [x, y])
	await resolveAll(a1, [x, y])
	await a1.setPortAlias(x, '设备 X')
	const z = nativePort(Object.assign({}, CP_A, { path: '/dev/cu.usbserial-0003', name: 'cu.usbserial-0003', serialNumber: 'EF56' }))
	const y2 = nativePort(CP_B)
	const a2 = boot(storage, [z, y2])
	await resolveAll(a2, [z, y2])
	assert.equal(a2.getPortAlias(z), null)
	assert.equal(a2.getPortAlias(y2), null)
})

test('[Y,X] 时给 Y 改名 / 清除别名：不合并进、也不删掉 X 的记录', async () => {
	const storage = memStorage()
	const x = nativePort(CP_A)
	const y = nativePort(CP_B)
	const a1 = boot(storage, [x, y])
	await resolveAll(a1, [x, y])
	await a1.setPortAlias(x, '设备 X')
	const y2 = nativePort(CP_B)
	const x2 = nativePort(CP_A)
	const a2 = boot(storage, [y2, x2])
	await resolveAll(a2, [y2, x2])
	await a2.setPortAlias(y2, '设备 Y')
	assert.equal(a2.getPortAlias(y2), '设备 Y')
	assert.equal(a2.getPortAlias(x2), '设备 X')
	const x3 = nativePort(CP_A)
	const y3 = nativePort(CP_B)
	const a3 = boot(storage, [x3, y3])
	await resolveAll(a3, [x3, y3])
	assert.equal(a3.getPortAlias(x3), '设备 X')
	assert.equal(a3.getPortAlias(y3), '设备 Y')
	await a3.setPortAlias(y3, '')
	assert.equal(a3.getPortAlias(y3), null)
	assert.equal(a3.getPortAlias(x3), '设备 X', '清除 Y 不能顺手删掉共享 slot 键的 X')
})

test('同型号两台都在位、序列号各不相同：X 换了 USB 口(路径变了)仍按序列号认回，Y 不受影响', async () => {
	const storage = memStorage()
	const x = nativePort(CP_A)
	const y = nativePort(CP_B)
	const a1 = boot(storage, [x, y])
	await resolveAll(a1, [x, y])
	await a1.setPortAlias(x, '设备 X')
	const xMoved = Object.assign({}, CP_A, { path: '/dev/cu.usbserial-0009', name: 'cu.usbserial-0009' })
	const x2 = nativePort(xMoved)
	const y2 = nativePort(CP_B)
	const a2 = boot(storage, [x2, y2])
	await resolveAll(a2, [x2, y2])
	assert.equal(a2.getPortAlias(x2), '设备 X')
	assert.equal(a2.getPortAlias(y2), null)
})

test('同一序列号的复合设备(多个接口)：仍按 slot / 路径各认各的', async () => {
	const storage = memStorage()
	const IF0 = Object.assign({}, CP_A, { path: '/dev/cu.usbmodemAB121', name: 'cu.usbmodemAB121' })
	const IF1 = Object.assign({}, CP_A, { path: '/dev/cu.usbmodemAB123', name: 'cu.usbmodemAB123' })
	const p0 = nativePort(IF0)
	const p1 = nativePort(IF1)
	const a1 = boot(storage, [p0, p1])
	await resolveAll(a1, [p0, p1])
	await a1.setPortAlias(p0, '接口 0')
	await a1.setPortAlias(p1, '接口 1')
	const q0 = nativePort(IF0)
	const q1 = nativePort(IF1)
	const a2 = boot(storage, [q0, q1])
	await resolveAll(a2, [q0, q1])
	assert.equal(a2.getPortAlias(q0), '接口 0')
	assert.equal(a2.getPortAlias(q1), '接口 1')
})

test('网页版同型号多 CDC(没有路径与序列号)：照旧按授权顺序的 slot 各认各的', async () => {
	const storage = memStorage()
	const web = () => ({ open() {}, getInfo() { return { usbVendorId: 0x1a86, usbProductId: 0x55d4 } } })
	const p0 = web()
	const p1 = web()
	const a1 = boot(storage, [p0, p1], 'web')
	await resolveAll(a1, [p0, p1])
	await a1.setPortAlias(p0, '口 1')
	await a1.setPortAlias(p1, '口 2')
	const q0 = web()
	const q1 = web()
	const a2 = boot(storage, [q0, q1], 'web')
	await resolveAll(a2, [q0, q1])
	assert.equal(a2.getPortAlias(q0), '口 1')
	assert.equal(a2.getPortAlias(q1), '口 2')
})

;(async () => {
	let failed = 0
	for (const t of tests) {
		try {
			await t.fn()
			console.log('ok -', t.name)
		} catch (e) {
			failed++
			console.error('FAIL -', t.name)
			console.error(e)
		}
	}
	if (failed) {
		console.error(failed + ' failed')
		process.exit(1)
	}
	console.log('all ' + tests.length + ' passed')
})()
