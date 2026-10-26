// Execute production send/preview/event fragments with synthetic ports and DOM.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const source = read('js/common.js')
function fragment(start, end, src = source) {
	const a = src.indexOf(start), b = src.indexOf(end, a)
	assert.ok(a >= 0 && b > a, 'source anchors exist')
	return src.slice(a, b) + '\n'
}
async function main() {
	const writes = [], errors = [], history = [], listeners = {}, stored = new Map()
	const elements = {}
	for (const id of ['serial-send-content', 'serial-send-info', 'serial-hex-send', 'serial-add-cr', 'serial-add-lf', 'serial-add-nul', 'serial-quick-send-content']) {
		elements[id] = { value: '', checked: false, classList: { toggle(k, v) { this[k] = v } }, addEventListener(type, fn) { listeners[id + ':' + type] = fn } }
	}
	let acquired = 0, flushed = 0
	const session = { txBytes: 0 }
	const port = { writable: { getWriter() { acquired++; return { write(data) { writes.push(Array.from(data)); return Promise.resolve() }, releaseLock() {} } } } }
	const ctx = vm.createContext({
		window: {}, TextEncoder, Uint8Array, Date,
		document: { getElementById: id => elements[id] },
		sendInput: elements['serial-send-content'], sendInfo: elements['serial-send-info'],
		SerialHub: { activeSendPhys: () => 'S', getPort: () => port, isOpen: () => true, _sess: () => session },
		addLogErr: s => errors.push(s), addLog() {}, showToast() {}, recoverIfWriteDead() {},
		flushPendingRx() { flushed++ }, lookupQuickSendName: () => 'synthetic', pushSendHistory: s => history.push(s),
		localStorage: { getItem: k => stored.get(k) || null, setItem: (k, v) => stored.set(k, v) },
		SPLIT_MODES: ['time', 'line'], isValidLogType: () => true, LOG_OPTION_KEYS: [], dragHappened: false, currQuickSend: { list: [] }, saveQuickList() {}
	})
	vm.runInContext(read('js/text-byte-encoder.js'), ctx)
	vm.runInContext(fragment('\tconst DEFAULT_TOOL_OPTIONS = {', '\n\t// 日志条') +
		fragment('\tfunction changeOption(', '\n\t//串口事件监听') +
		fragment('\tlet loopSendLast = null', '\n\t// 终端键盘直写') +
		fragment('\tfunction updateSendInfo()', "\n\tsendInput.addEventListener('input'") +
		fragment("\tdocument.getElementById('serial-add-nul').addEventListener", "\n\tdocument.getElementById('serial-hex-send').addEventListener") +
		fragment("\tdocument.getElementById('serial-quick-send-content').addEventListener('click'", '\n\t//快捷列表双击') +
		'\nglobalThis.api = { send, sendText, sendHex, writeData, updateSendInfo, changeOption, options: toolOptions }', ctx)
	vm.runInContext('globalThis.publicApi = {\n' + fragment('\t\tasync writeData(data, opts)', '\n\t\tisSessionOpen(id)') + '\n}', ctx)
	ctx.window.serialApi = ctx.publicApi
	ctx.publicApi.isOpen = () => true
	const { api } = ctx
	assert.equal(api.options.addNUL, false)
	api.options.hexSend = false
	const input = elements['serial-send-content']
	input.value = String.raw`中😀\r\n\0\377`
	for (let mask = 0; mask < 8; mask++) {
		api.options.addCR = !!(mask & 1)
		api.options.addLF = !!(mask & 2)
		api.options.addNUL = !!(mask & 4)
		api.updateSendInfo()
		await api.send()
		const expected = [228, 184, 173, 240, 159, 152, 128, 13, 10, 0, 255]
		if (mask & 1) expected.push(13)
		if (mask & 2) expected.push(10)
		if (mask & 4) expected.push(0)
		assert.deepEqual(writes.at(-1), expected)
		assert.equal(elements['serial-send-info'].textContent, expected.length + ' 字节')
		assert.equal(history.at(-1), input.value, 'history retains literal input')
	}
	// Real generic public byte API must leave protocol/firmware bytes alone when CR/LF are off.
	api.options.addCR = api.options.addLF = false
	const binary = Uint8Array.of(0, 92, 110, 255)
	await ctx.publicApi.writeData(binary)
	assert.deepEqual(writes.at(-1), Array.from(binary))
	await ctx.publicApi.writeData(binary, { composed: true })
	assert.deepEqual(writes.at(-1), [...binary, 0])
	await ctx.publicApi.writeRaw(binary, { composed: true })
	assert.deepEqual(writes.at(-1), Array.from(binary))
	// Generic wrapper only forwards composed; other flags must not become a public contract.
	const opts = { composed: true }
	for (const key of ['raw', 'logData', 'throwOnError']) {
		Object.defineProperty(opts, key, { get() { throw new Error('unexpected forwarding of ' + key) } })
	}
	await ctx.publicApi.writeData(binary, opts)
	assert.deepEqual(writes.at(-1), [...binary, 0])
	for (let mask = 0; mask < 4; mask++) {
		api.options.addCR = !!(mask & 1)
		api.options.addLF = !!(mask & 2)
		await ctx.publicApi.writeData(binary)
		const expected = Array.from(binary)
		if (mask & 1) expected.push(13)
		if (mask & 2) expected.push(10)
		assert.deepEqual(writes.at(-1), expected, 'generic bytes retain legacy CR/LF only')
	}
	input.value = '中'.repeat(100000) + String.raw`\0`
	api.updateSendInfo()
	await api.send()
	assert.equal(writes.at(-1).length, 300004)
	assert.equal(elements['serial-send-info'].textContent, '300004 字节')
	await api.writeData(Uint8Array.of(92, 110), null, null, { raw: true, composed: true })
	assert.deepEqual(writes.at(-1), [92, 110], 'raw bytes bypass escapes and every suffix')
	const before = writes.length, locks = acquired, flushes = flushed
	for (const invalid of [String.raw`OK\q`, 'OK\\', String.raw`OK\x`, String.raw`OK\x100`]) {
		input.value = invalid
		api.updateSendInfo()
		assert.equal(elements['serial-send-info'].classList['is-error'], true)
		await api.send()
		assert.equal(errors.at(-1), elements['serial-send-info'].textContent)
	}
	assert.equal(writes.length, before)
	assert.equal(acquired, locks, 'validation must happen before taking a writer')
	assert.equal(flushed, flushes, 'invalid text must not flush RX')
	const quick = listeners['serial-quick-send-content:click']
	const row = { parentNode: { children: [] } }
	row.parentNode.children.push(row)
	const event = { target: { closest: selector => selector === '.quick-item' ? row : selector === '.quick-send' ? {} : null } }
	ctx.currQuickSend.list = [{ content: String.raw`Q\0`, name: 'test', hex: false }]
	for (let mask = 0; mask < 8; mask++) {
		api.options.addCR = !!(mask & 1)
		api.options.addLF = !!(mask & 2)
		api.options.addNUL = !!(mask & 4)
		quick(event)
		await new Promise(resolve => setImmediate(resolve))
		const expected = [81, 0]
		if (mask & 1) expected.push(13)
		if (mask & 2) expected.push(10)
		if (mask & 4) expected.push(0)
		assert.deepEqual(writes.at(-1), expected)
	}
	// Modern quick chips forward to the original quick row's send button.
	ctx.list = {}
	ctx.$ = id => id === 'serial-quick-send-content' ? { children: [{ querySelector: () => ({ click: () => quick(event) }) }] } : null
	ctx.listen = (el, type, fn) => { ctx.modernClick = fn }
	vm.runInContext(fragment("\t\tlisten(list, 'click', function (e) {\n\t\t\tconst b = e.target.closest('.mdn-chip[data-idx]')", '\n\t\tconst refresh = batched(refreshQuick)', read('js/modern-shell.js')), ctx)
	ctx.modernClick({ target: { closest: () => ({ dataset: { idx: '0' } }) } })
	await new Promise(resolve => setImmediate(resolve))
	assert.deepEqual(writes.at(-1), [81, 0, 13, 10, 0])
	ctx.currQuickSend.list[0].content = String.raw`Q\bad\q`
	const quickBefore = writes.length
	quick(event)
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(writes.length, quickBefore)
	ctx.currQuickSend.list[0] = { content: '5C 6E', hex: true }
	quick(event)
	await new Promise(resolve => setImmediate(resolve))
	assert.deepEqual(writes.at(-1), [92, 110, 13, 10, 0])
	api.options.hexSend = true
	elements['serial-hex-send'].checked = true
	input.value = '5C 6E'
	api.updateSendInfo()
	await api.send()
	assert.equal(elements['serial-send-info'].textContent, '5 字节')
	assert.deepEqual(writes.at(-1), [92, 110, 13, 10, 0])
	// Persist and reload through production initialization, including old CRLF migration.
	listeners['serial-add-nul:change'].call({ checked: true })
	assert.equal(JSON.parse(stored.get('toolOptions')).addNUL, true)
	for (const options of [{ addNUL: true }, { addCRLF: true }, {}]) {
		stored.set('toolOptions', JSON.stringify(options))
		vm.runInContext('{ toolOptions = Object.assign({}, DEFAULT_TOOL_OPTIONS)\n' +
			fragment('\tconst rawToolOptions =', '\n\tlogOptionsSingle = pickLogOptions') +
			fragment("\tdocument.getElementById('serial-add-cr').checked =", "\n\tdocument.getElementById('serial-hex-send').checked") +
			'\n} globalThis.restored = toolOptions', ctx)
		assert.equal(ctx.restored.addNUL, !!options.addNUL)
		assert.equal(elements['serial-add-nul'].checked, !!options.addNUL)
		assert.equal(ctx.restored.addCR, !!options.addCRLF)
	}
	ctx.restored.addCR = ctx.restored.addLF = ctx.restored.addNUL = true
	// Terminal bytes remain literal and do not receive suffixes.
	vm.runInContext(fragment('\tasync function writeTermBytes(', '\n\t// 写入遇到') + '\nglobalThis.term = writeTermBytes', ctx)
	await ctx.term('S', Uint8Array.of(92, 110))
	assert.deepEqual(writes.at(-1), [92, 110])
	// BLU preset and custom sends converge on this same production function.
	const results = []
	ctx.window.serialApi = ctx.publicApi
	ctx.showResult = (message, status) => results.push({ message, status })
	ctx.refreshUI = () => {}
	ctx.armAutoClose = () => {}
	vm.runInContext(fragment('\tasync function doSend(', '\n\tfunction getAutoClose(', read('js/blu-cmd-sheet.js')) + '\nglobalThis.bluSend = doSend', ctx)
	for (let mask = 0; mask < 8; mask++) {
		ctx.restored.addCR = !!(mask & 1)
		ctx.restored.addLF = !!(mask & 2)
		ctx.restored.addNUL = !!(mask & 4)
		await ctx.bluSend(String.raw`B\0`, false)
		const expected = [66, 0]
		if (mask & 1) expected.push(13)
		if (mask & 2) expected.push(10)
		if (mask & 4) expected.push(0)
		assert.deepEqual(writes.at(-1), expected)
	}
	const bluBefore = writes.length
	await ctx.bluSend(String.raw`B\q`, false)
	assert.equal(writes.length, bluBefore)
	assert.equal(results.at(-1).status, 'error')
	await ctx.bluSend('5C 6E', true)
	assert.deepEqual(writes.at(-1), [92, 110, 13, 10, 0])
	ctx.presetSel = { value: JSON.stringify({ c: String.raw`P\0`, h: false }) }
	ctx.customInput = { value: String.raw`C\0` }
	ctx.window.serialApi.getHexSend = () => false
	vm.runInContext(fragment('\tasync function sendPreset()', '\n\tasync function doSend(', read('js/blu-cmd-sheet.js')) + '\nglobalThis.bluRoutes = { sendPreset, sendCustom }', ctx)
	await ctx.bluRoutes.sendPreset()
	assert.deepEqual(writes.at(-1), [80, 0, 13, 10, 0])
	await ctx.bluRoutes.sendCustom()
	assert.deepEqual(writes.at(-1), [67, 0, 13, 10, 0])
	assert.equal(ctx.customInput.value, String.raw`C\0`)
	const html = read('index.html')
	assert.ok(html.indexOf('js/text-byte-encoder.js') < html.indexOf('js/common.js'))
	assert.equal((html.match(/id="serial-add-nul"/g) || []).length, 1)

}
main().then(() => console.log('text-send: ok')).catch(error => { console.error(error); process.exitCode = 1 })
