// Run: node tests/json-protocol.cjs — synthetic data only.
// 覆盖：js/json-protocol.js 校验和引擎、Schema v1 校验、帧扫描/解析/byteMap/ParseView 渲染、通用下行组帧往返、存储与导入导出、桌面目录加载。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function createEnv() {
	const store = new Map()
	const registered = {}
	const localStorage = {
		getItem(k) { return store.has(k) ? store.get(k) : null },
		setItem(k, v) { store.set(k, String(v)) },
		removeItem(k) { store.delete(k) },
	}
	const ProtocolRegistry = {
		RESERVED_IDS: ['sek', 'wmbus', 'gz', 'cjt188', 'sk-ultrasonic', 'hostproto', 'cellular-at'],
		register(id, impl) {
			if (impl.builtin !== true && this.RESERVED_IDS.includes(id)) {
				throw new Error('保留协议 ID 不可占用：' + id)
			}
			registered[id] = impl
			return true
		},
		unregister(id) {
			delete registered[id]
			return { ok: true }
		},
		get(id) { return registered[id] || null },
		has(id) { return !!registered[id] },
	}
	const window = {
		localStorage,
		ProtocolRegistry,
		_protocols: registered,
		registerProtocol(id, impl) { return ProtocolRegistry.register(id, impl) },
		unregisterProtocol(id) { return ProtocolRegistry.unregister(id) },
	}
	const ctx = {
		window,
		globalThis: window,
		localStorage,
		Uint8Array,
		ArrayBuffer,
		DataView,
		TextEncoder,
		TextDecoder,
		console,
	}
	vm.createContext(ctx)
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/parse-view.js'), 'utf8'), ctx)
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/json-protocol.js'), 'utf8'), ctx)
	return { window, registered, store, JP: window.JsonProtocol, PV: window.ParseView }
}

const hex = s => Uint8Array.from(s.trim().split(/\s+/).filter(Boolean).map(x => parseInt(x, 16)))
const J = x => JSON.parse(JSON.stringify(x))

// 1. 校验和标准向量测试（ASCII "123456789"）
{
	const { JP } = createEnv()
	const CS = JP.Checksum
	const vec = Uint8Array.from('123456789', c => c.charCodeAt(0))
	assert.equal(CS.sizeOf('none'), 0)
	assert.equal(CS.sizeOf('sum8'), 1)
	assert.equal(CS.sizeOf('xor8'), 1)
	assert.equal(CS.sizeOf('xor'), 1)
	assert.equal(CS.sizeOf('lrc8'), 1)
	assert.equal(CS.sizeOf('crc8'), 1)
	assert.equal(CS.sizeOf('crc16-modbus'), 2)
	assert.equal(CS.sizeOf('crc16-ccitt'), 2)
	assert.equal(CS.sizeOf('crc16-xmodem'), 2)
	assert.equal(CS.sizeOf('crc16-ibm'), 2)
	assert.equal(CS.sizeOf('crc16-custom'), 2)

	assert.equal(CS.compute(vec, 'sum8'), 0xDD)
	assert.equal(CS.compute(vec, 'xor8'), 0x31)
	assert.equal(CS.compute(vec, 'xor'), 0x31)
	assert.equal(CS.compute(vec, 'lrc8'), 0x23)
	assert.equal(CS.compute(vec, 'crc8'), 0xF4)
	assert.equal(CS.compute(vec, 'crc16-modbus'), 0x4B37)
	assert.equal(CS.compute(vec, 'crc16-ccitt'), 0x29B1)
	assert.equal(CS.compute(vec, 'crc16-xmodem'), 0x31C3)
	assert.equal(CS.compute(vec, 'crc16-ibm'), 0xBB3D)
	assert.equal(CS.compute(vec, { algorithm: 'crc16-custom', poly: 0x1021, init: 0xFFFF, refIn: false, refOut: false, xorOut: 0x0000 }), 0x29B1)

	// verify：正常与篡改
	const withCrc = new Uint8Array(vec.length + 2)
	withCrc.set(vec, 0)
	withCrc[vec.length] = 0x37
	withCrc[vec.length + 1] = 0x4B
	assert.equal(CS.verify(withCrc, { algorithm: 'crc16-modbus', endian: 'le', start: 0, end: -2, offset: -2 }), true)
	const bad = withCrc.slice()
	bad[bad.length - 1] ^= 0x01
	assert.equal(CS.verify(bad, { algorithm: 'crc16-modbus', endian: 'le', start: 0, end: -2, offset: -2 }), false)
}

// 2. Schema v1 合法与非法校验
{
	const { JP } = createEnv()
	assert.ok(Array.isArray(JP.EXAMPLES) && JP.EXAMPLES.length >= 2, '至少包含 2 套示例协议')
	JP.EXAMPLES.forEach(ex => {
		const r = JP.validateSpec(ex.spec)
		assert.equal(r.ok, true, '示例协议应通过校验：' + ex.id + ' -> ' + (r.errors || []).join('; '))
	})

	// 保留内置 ID 全部拒绝
	for (const reserved of ['sek', 'wmbus', 'gz', 'cjt188', 'sk-ultrasonic', 'hostproto', 'cellular-at']) {
		const bad = Object.assign({}, JP.EXAMPLES[0].spec, { id: reserved })
		const r = JP.validateSpec(bad)
		assert.equal(r.ok, false, '应拒绝保留内置 ID：' + reserved)
		assert.ok(r.errors.some(e => e.includes('保留')))
	}

	// 非法字段全面覆盖
	assert.equal(JP.validateSpec(null).ok, false)
	assert.equal(JP.validateSpec(Object.assign({}, JP.EXAMPLES[0].spec, { schemaVersion: 2 })).ok, false)
	assert.equal(JP.validateSpec(Object.assign({}, JP.EXAMPLES[0].spec, { id: 'Bad ID!' })).ok, false)
	assert.equal(JP.validateSpec(Object.assign({}, JP.EXAMPLES[0].spec, { name: '' })).ok, false)
	assert.equal(JP.validateSpec(Object.assign({}, JP.EXAMPLES[0].spec, { name: 'a'.repeat(49) })).ok, false)
	assert.equal(JP.validateSpec(Object.assign({}, JP.EXAMPLES[0].spec, { framing: { head: 'ZZ' } })).ok, false)
	assert.equal(JP.validateSpec(Object.assign({}, JP.EXAMPLES[0].spec, { framing: { head: 'AA 55' } })).ok, false) // 缺少定长/长度/帧尾
	assert.equal(JP.validateSpec(Object.assign({}, JP.EXAMPLES[0].spec, { checksum: { algorithm: 'md5' } })).ok, false)
	assert.equal(JP.validateSpec(Object.assign({}, JP.EXAMPLES[0].spec, { fields: [{ name: 'bad', offset: 0, type: 'float99' }] })).ok, false)
}

// 3. 变长帧 + CRC16-Modbus 示例（demo-sensor-crc16）：下行往返、粘包噪声、全字段解析、byteMap、logView
{
	const { JP, PV } = createEnv()
	const proto = JP.compile(JP.EXAMPLES[0].spec)
	assert.equal(proto.id, 'demo-sensor-crc16')
	assert.equal(proto.builtin, false)
	assert.equal(proto.source, 'json')
	assert.ok(proto.presets.length > 0)
	assert.equal(proto.funcTabs.length, 2)

	// 形态 1：presetName + paramValue 下行组帧并往返解析
	const down1 = proto.buildDownFrame({ presetName: '读取通道温湿度', paramValue: 3 })
	assert.ok(down1 instanceof Uint8Array)
	assert.equal(down1.length, 8)
	assert.equal(down1[0], 0xAA)
	assert.equal(down1[1], 0x55)
	assert.equal(down1[2], 1) // payload len = 8 - 7 = 1
	assert.equal(down1[3], 0x01)
	assert.equal(down1[4], 3)
	assert.equal(down1[7], 0x0D)

	const pDown = proto.parseFrame(down1)
	assert.equal(pDown.ok, true)
	assert.equal(pDown.crcOk, true)
	assert.equal(pDown.title, '读取温湿度请求')
	assert.equal(pDown.code, '0x01')
	assert.equal(pDown.dir, 'down')
	assert.equal(pDown.fields['通道号'].value, 3)

	// 形态 2：cmd + payload
	const down2 = proto.buildDownFrame({ cmd: 0x02, payload: [1] })
	const pDown2 = proto.parseFrame(down2)
	assert.equal(pDown2.ok, true)
	assert.equal(pDown2.title, '继电器控制请求')
	assert.equal(pDown2.fields['动作'].formatted, '闭合')

	// 形态 3：rawHex
	const rawOut = proto.buildDownFrame({ rawHex: 'AA 55 01 02 00' })
	assert.deepEqual(Array.from(rawOut), [0xAA, 0x55, 0x01, 0x02, 0x00])

	// 构造上行应答帧：设备地址 BCD 20260001、温度 -12.5℃ (int16le -125 = 0xFF83)、湿度 65.4% (654 = 0x028E)、状态位 0x01 (电池欠压, 探头正常)
	const payloadUp = [0x20, 0x26, 0x00, 0x01, 0x83, 0xFF, 0x8E, 0x02, 0x01]
	const upBody = Uint8Array.from([0xAA, 0x55, payloadUp.length, 0x81, ...payloadUp])
	const upCrc = JP.Checksum.compute(upBody, 'crc16-modbus')
	const upFrame = Uint8Array.from([...upBody, upCrc & 0xff, (upCrc >>> 8) & 0xff, 0x0D])

	// 前导噪声 + 坏 CRC 伪帧 + 真实帧 + 粘包尾帧
	const badDecoy = down1.slice()
	badDecoy[5] ^= 0xff
	const stream = Uint8Array.from([0x00, 0xFF, ...badDecoy, 0x99, ...upFrame, ...down1])
	const found = proto.findFrame(stream)
	assert.equal(found.found, true)
	assert.equal(found.offset, 2 + badDecoy.length + 1)
	assert.equal(found.prefix, found.offset)
	assert.equal(found.suffix, down1.length)
	assert.deepEqual(Array.from(found.frame), Array.from(upFrame))

	const parsed = proto.parseFrame(found.frame)
	assert.equal(parsed.ok, true)
	assert.equal(parsed.crcOk, true)
	assert.equal(parsed.title, '温湿度应答')
	assert.equal(parsed.dir, 'up')
	assert.deepEqual(J(parsed.subject), { label: '设备地址', value: '20260001' })
	assert.equal(parsed.fields['温度'].formatted, '-12.5 ℃')
	assert.equal(parsed.fields['湿度'].formatted, '65.4 %')
	assert.equal(parsed.fields['状态位'].formatted, '电池:欠压 · 探头:正常')

	// byteMap 与 logView + ParseView 渲染
	const bm = proto.byteMap(parsed)
	assert.equal(bm.length, upFrame.length)
	assert.equal(bm[0].grp, '帧头')
	assert.equal(bm[2].grp, '长度')
	assert.equal(bm[4].grp, '设备地址')
	assert.equal(bm[upFrame.length - 2].grp, '校验')
	assert.equal(bm[upFrame.length - 1].grp, '帧尾')

	const lv = proto.logView(parsed)
	assert.ok(lv && lv.badges.some(b => b.text === 'CRC ✓' && b.kind === 'ok'))
	assert.ok(lv.sections.every(s => !('html' in s)), 'JSON 协议 logView 绝不能含 section.html')
	const rendered = PV.render(lv)
	assert.ok(rendered.includes('20260001') && rendered.includes('-12.5 ℃'))
	assert.ok(proto.formatFrame(parsed).includes('pv-grid'))

	// CRC 损坏时仍输出模型且徽标标红
	const tampered = upFrame.slice()
	tampered[tampered.length - 2] ^= 0xff
	const pBad = proto.parseFrame(tampered)
	assert.equal(pBad.ok, false)
	assert.equal(pBad.crcOk, false)
	assert.ok(proto.logView(pBad).badges.some(b => b.text === 'CRC ✗' && b.kind === 'bad'))

	// 非本协议噪声帧 logView 返回 null
	assert.equal(proto.logView(proto.parseFrame(hex('00 11 22 33 44'))), null)
}

// 4. 定长帧 + Sum8 示例（demo-relay-sum8）
{
	const { JP } = createEnv()
	const proto = JP.compile(JP.EXAMPLES[1].spec)
	const frame = proto.buildDownFrame({ presetName: '打开通道 1' })
	assert.equal(frame.length, 8)
	const f = proto.findFrame(Uint8Array.from([0x55, ...frame, 0x00]))
	assert.equal(f.found, true)
	assert.equal(f.offset, 1)
	const p = proto.parseFrame(f.frame)
	assert.equal(p.ok, true)
	assert.equal(p.crcOk, true)
	assert.equal(p.title, '设置通道输出')
	assert.deepEqual(J(p.subject), { label: '节点地址', value: '0x01' })
	assert.equal(p.fields['输出状态'].formatted, '打开')
}

// 5. 前导码 + 帧尾定界 + 全整数大小端 / ASCII / BCD_LE / rest 字段 + XSS 转义回归
{
	const { JP, PV } = createEnv()
	const spec = {
		schemaVersion: 1,
		id: 'demo-tail-full',
		name: '综合类型测试协议',
		framing: {
			preamble: 'FF FF',
			head: '68',
			tail: '16',
			minLength: 26,
		},
		checksum: {
			algorithm: 'xor8',
			start: 0,
			end: -2,
			offset: -2,
		},
		fields: [
			{ name: 's8', offset: 1, type: 'int8' },
			{ name: 'u16be', offset: 2, type: 'uint16be' },
			{ name: 'i16be', offset: 4, type: 'int16be' },
			{ name: 'u32le', offset: 6, type: 'uint32le' },
			{ name: 'u32be', offset: 10, type: 'uint32be' },
			{ name: 'i32le', offset: 14, type: 'int32le' },
			{ name: 'i32be', offset: 18, type: 'int32be' },
			{ name: 'bcdLe', offset: 22, length: 2, type: 'bcd' },
			{ name: 'label', offset: 24, length: 'rest', type: 'ascii' },
		],
		frames: [
			{
				match: { offset: 2, bytes: '12 34' },
				title: '综合上报',
				code: '0x1234',
				dir: 'up',
			},
		],
	}
	const proto = JP.compile(spec)
	const asciiPayload = Array.from('<img onerror=1>', c => c.charCodeAt(0))
	// 载荷内部故意放一个 0x16 字节测试帧尾定界 + XOR 验签
	const body = [
		0x68,
		0xFE, // int8 = -2
		0x12, 0x34, // u16be = 0x1234
		0xFF, 0x9C, // i16be = -100
		0x78, 0x56, 0x34, 0x12, // u32le = 0x12345678
		0x12, 0x34, 0x56, 0x78, // u32be = 0x12345678
		0xF6, 0xFF, 0xFF, 0xFF, // i32le = -10
		0xFF, 0xFF, 0xFF, 0xEC, // i32be = -20
		0x34, 0x12, // bcd_le -> "1234"
		...asciiPayload,
	]
	const xorVal = JP.Checksum.compute(body, 'xor8')
	const withPreamble = Uint8Array.from([0xFF, 0xFF, ...body, xorVal, 0x16])

	const found = proto.findFrame(withPreamble)
	assert.equal(found.found, true)
	assert.equal(found.offset, 2)

	const parsed = proto.parseFrame(withPreamble)
	assert.equal(parsed.ok, true)
	assert.equal(parsed.title, '综合上报')
	assert.equal(parsed.fields.s8.value, -2)
	assert.equal(parsed.fields.u16be.value, 0x1234)
	assert.equal(parsed.fields.i16be.value, -100)
	assert.equal(parsed.fields.u32le.value, 0x12345678)
	assert.equal(parsed.fields.u32be.value, 0x12345678)
	assert.equal(parsed.fields.i32le.value, -10)
	assert.equal(parsed.fields.i32be.value, -20)
	assert.equal(parsed.fields.bcdLe.value, '1234')
	assert.equal(parsed.fields.label.value, '<img onerror=1>')

	const bm = proto.byteMap(parsed)
	assert.equal(bm[0].grp, '前导')
	assert.equal(bm[2].grp, '帧头')

	const html = PV.render(proto.logView(parsed))
	assert.ok(!html.includes('<img'), 'ASCII 字段中的 HTML 标签必须被转义')
	assert.ok(html.includes('&lt;img onerror=1&gt;'))
}

// 6. 存储、导入/导出、桌面目录注册与清理
{
	const { JP, registered, store } = createEnv()
	const u1 = JP.upsert(JP.EXAMPLES[0].spec)
	assert.equal(u1.ok, true)
	assert.equal(u1.id, 'demo-sensor-crc16')
	assert.ok(registered['demo-sensor-crc16'])

	// 导出单个与全部
	const singleStr = JP.exportJson('demo-sensor-crc16')
	assert.equal(JSON.parse(singleStr).id, 'demo-sensor-crc16')
	const allStr = JP.exportJson()
	const bundle = JSON.parse(allStr)
	assert.equal(bundle.version, 1)
	assert.equal(bundle.protocols.length, 1)

	// 导入协议包（数组 + 对象 + bundle）
	const imp = JP.importJson(JSON.stringify({ version: 1, protocols: [JP.EXAMPLES[1].spec] }))
	assert.equal(imp.ok, true)
	assert.deepEqual(J(imp.imported), ['demo-relay-sum8'])
	assert.equal(JP.listSaved().length, 2)

	// 桌面目录 JSON 注册（不写 localStorage，冲突跳过）
	const dirSpec = Object.assign({}, JP.EXAMPLES[1].spec, { id: 'dir-only-relay', name: '目录继电器' })
	const dr1 = JP.registerDirSpec('relay.json', JSON.stringify(dirSpec))
	assert.equal(dr1.ok, true)
	assert.equal(registered['dir-only-relay'].source, 'dir-json')
	assert.equal(JSON.parse(store.get(JP.STORAGE_KEY)).length, 2, 'dir-json 不得写入 localStorage')

	// 冲突保护：与本地已注册 ID 冲突时跳过
	const drConflict = JP.registerDirSpec('dup.json', JSON.stringify(JP.EXAMPLES[0].spec))
	assert.equal(drConflict.ok, false)

	// remove 拒绝删除 dir-json
	const rmDir = JP.remove('dir-only-relay')
	assert.equal(rmDir.ok, false)
	assert.ok(rmDir.error.includes('插件目录'))

	// clearDirSpecs 干净卸载 dir-json 但保留本地 json
	JP.clearDirSpecs()
	assert.equal(registered['dir-only-relay'], undefined)
	assert.ok(registered['demo-sensor-crc16'])

	// remove 删除本地协议
	const rmLocal = JP.remove('demo-relay-sum8')
	assert.equal(rmLocal.ok, true)
	assert.equal(registered['demo-relay-sum8'], undefined)

	// 重启后 loadSavedIntoRegistry 恢复本地已保存协议
	delete registered['demo-sensor-crc16']
	const loaded = JP.loadSavedIntoRegistry()
	assert.deepEqual(J(loaded.loaded), ['demo-sensor-crc16'])
	assert.ok(registered['demo-sensor-crc16'])
}

console.log('json protocol checks passed')
