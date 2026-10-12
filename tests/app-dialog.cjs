// Run: node tests/app-dialog.cjs — synthetic data only.
// 覆盖: 页内对话框(js/app-dialog.js，假 DOM)作为最上层模态：isOpen 查询(含排队)、打开时收起命令面板、
// Enter / Esc 只在焦点属于对话框时生效(焦点在外面时不确认、不放给页面、拉回焦点)、带 ⌘/Ctrl/Alt 的组合键不传给页面快捷键、焦点移出被拉回；
// 以及命令面板快捷键只认不带 Shift / Alt 的 ⌘/Ctrl+K：截取 js/command-palette.js 的 `function isPaletteKey(` 与 js/native-shell.js 的 `const PAGE_KEYS = {` 到 `let lastKey`
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const dialogSrc = fs.readFileSync(path.join(__dirname, '../js/app-dialog.js'), 'utf8')

// ---------- 假 DOM ----------
function makeDom() {
	const docListeners = {}
	const winListeners = {}
	const doc = {
		activeElement: null,
		addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f) },
		removeEventListener(t, f) { docListeners[t] = (docListeners[t] || []).filter((x) => x !== f) },
		contains(n) { return doc.body.contains(n) },
		createElement(tag) { return new El(tag) },
	}
	class El {
		constructor(tag) {
			this.tagName = String(tag).toUpperCase()
			this.nodeType = 1
			this.children = []
			this.parentNode = null
			this.attrs = {}
			this.listeners = {}
			this.className = ''
			this.textContent = ''
			this.value = ''
		}
		appendChild(c) { c.parentNode = this; this.children.push(c); return c }
		remove() {
			if (!this.parentNode) return
			const a = this.parentNode.children
			a.splice(a.indexOf(this), 1)
			this.parentNode = null
		}
		contains(n) {
			while (n) {
				if (n === this) return true
				n = n.parentNode
			}
			return false
		}
		setAttribute(k, v) { this.attrs[k] = String(v) }
		getAttribute(k) { return this.attrs[k] }
		addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f) }
		focus() {
			doc.activeElement = this
			;(docListeners.focusin || []).slice().forEach((f) => f({ target: this }))
		}
		select() {}
		click() { (this.listeners.click || []).forEach((f) => f({ target: this })) }
		querySelectorAll() {
			const out = []
			const walk = (n) => n.children.forEach((c) => {
				if (c.tagName === 'INPUT' || c.tagName === 'BUTTON') out.push(c)
				walk(c)
			})
			walk(this)
			return out
		}
	}
	doc.body = new El('body')
	doc.activeElement = doc.body
	let paletteClosed = 0
	const win = {
		document: doc,
		navigator: {},
		addEventListener(t, f) { (winListeners[t] = winListeners[t] || []).push(f) },
		removeEventListener(t, f) { winListeners[t] = (winListeners[t] || []).filter((x) => x !== f) },
		serialCommandPalette: { close() { paletteClosed++ } },
	}
	const ctx = { window: win, module: undefined }
	vm.createContext(ctx)
	vm.runInContext(dialogSrc, ctx)
	return {
		doc, win, El, api: win.AppDialog,
		paletteClosed: () => paletteClosed,
		// 按浏览器顺序：window 捕获 → 页面(document)监听；被 stopPropagation 就到不了页面
		key(target, key, mods) {
			const e = Object.assign({ key, target, isComposing: false, stopped: false, prevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
				stopPropagation() { this.stopped = true }, preventDefault() { this.prevented = true } }, mods || {})
			for (const f of (winListeners.keydown || []).slice()) f(e)
			return e
		},
		mask() { return doc.body.children.find((c) => c.className === 'app-dlg-mask') || null },
		dialogKeyListeners: () => (winListeners.keydown || []).length,
	}
}

function find(node, pred) {
	if (pred(node)) return node
	for (const c of node.children) {
		const r = find(c, pred)
		if (r) return r
	}
	return null
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('打开时 isOpen 为真并收起命令面板；Enter 在对话框里确认，关闭后 isOpen 为假、监听摘掉', async () => {
	const d = makeDom()
	assert.equal(d.api.isOpen(), false)
	const res = d.api.confirm('清空？')
	assert.equal(d.api.isOpen(), true)
	assert.equal(d.paletteClosed(), 1)
	const mask = d.mask()
	assert.ok(mask)
	assert.ok(mask.contains(d.doc.activeElement), '焦点在对话框里')
	const e = d.key(d.doc.activeElement, 'Enter')
	assert.equal(e.stopped, true)
	assert.equal(await res, true)
	assert.equal(d.api.isOpen(), false)
	assert.equal(d.mask(), null)
	assert.equal(d.dialogKeyListeners(), 0)
})

test('焦点不在对话框里时 Enter / Esc 不确认也不取消，不传给页面，焦点被拉回', async () => {
	const d = makeDom()
	let settled = false
	const res = d.api.confirm('危险操作').then((v) => { settled = true; return v })
	const outside = new d.El('input')
	d.doc.body.appendChild(outside)
	// 绕过 focusin 拉回，模拟焦点已在外面(例如别的层抢走)
	d.doc.activeElement = outside
	for (const k of ['Enter', 'Escape']) {
		const e = d.key(outside, k)
		assert.equal(e.stopped, true, k + ' 不能传给页面')
		assert.equal(e.prevented, true)
		assert.ok(d.mask().contains(d.doc.activeElement), k + ' 后焦点回到对话框')
		d.doc.activeElement = outside
	}
	await Promise.resolve()
	assert.equal(settled, false)
	assert.equal(d.api.isOpen(), true)
	const esc = d.key(d.mask().children[0], 'Escape')
	assert.equal(esc.stopped, true)
	assert.equal(await res, false)
})

test('⌘K / Ctrl+Shift+K 等组合键在对话框打开期间不传给页面快捷键', async () => {
	const d = makeDom()
	const res = d.api.alert('提示')
	for (const mods of [{ metaKey: true }, { ctrlKey: true }, { ctrlKey: true, shiftKey: true }, { altKey: true }]) {
		const e = d.key(d.doc.activeElement, 'k', mods)
		assert.equal(e.stopped, true)
		assert.equal(e.prevented, false, '不拦默认动作(复制粘贴等)')
	}
	const plain = d.key(d.doc.activeElement, 'a')
	assert.equal(plain.stopped, false)
	d.key(d.doc.activeElement, 'Enter')
	await res
	const after = d.key(d.doc.body, 'k', { metaKey: true })
	assert.equal(after.stopped, false, '关闭后不再拦')
})

test('焦点移到对话框外会被拉回；取消键上的 Enter 交给按钮', async () => {
	const d = makeDom()
	const res = d.api.confirm('确认？')
	const outside = new d.El('button')
	d.doc.body.appendChild(outside)
	outside.focus()
	assert.ok(d.mask().contains(d.doc.activeElement))
	const cancel = find(d.mask(), (n) => n.tagName === 'BUTTON' && n.textContent === '取消')
	cancel.focus()
	const e = d.key(cancel, 'Enter')
	assert.equal(e.prevented, false, '取消键上的 Enter 由按钮自己的 click 处理')
	cancel.click()
	assert.equal(await res, false)
})

test('排队：第一个关掉、第二个紧接着显示，期间 isOpen 一直为真', async () => {
	const d = makeDom()
	const r1 = d.api.confirm('一')
	const r2 = d.api.prompt('二', 'x')
	assert.equal(d.api.isOpen(), true)
	d.key(d.doc.activeElement, 'Enter')
	assert.equal(await r1, true)
	assert.equal(d.api.isOpen(), true)
	const inp = find(d.mask(), (n) => n.tagName === 'INPUT')
	assert.equal(d.doc.activeElement, inp)
	d.key(inp, 'Enter')
	assert.equal(await r2, 'x')
	assert.equal(d.api.isOpen(), false)
})

// ---------- 命令面板快捷键：只认不带 Shift / Alt 的 ⌘/Ctrl+K ----------
function sliceFrom(file, startMark, endMark) {
	const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
	const s = src.indexOf(startMark)
	const e = src.indexOf(endMark, s)
	assert.ok(s > 0 && e > s, file + ' 锚点不见了: ' + startMark)
	return src.slice(s, e)
}
test('command-palette 的 isPaletteKey 与 native-shell 的 PAGE_KEYS 都不认 ⇧⌘K / ⌥⌘K', () => {
	const ctx = {}
	vm.createContext(ctx)
	vm.runInContext(sliceFrom('js/command-palette.js', 'function isPaletteKey(', '\n\t}\n') + '\n}\nthis.isPaletteKey = isPaletteKey', ctx)
	vm.runInContext(sliceFrom('js/native-shell.js', 'const PAGE_KEYS = {', '\tlet lastKey') + '\nthis.PAGE_KEYS = PAGE_KEYS', ctx)
	const pageTest = ctx.PAGE_KEYS['command-palette'].test
	const ev = (key, m) => Object.assign({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, m)
	for (const fn of [ctx.isPaletteKey, pageTest]) {
		assert.equal(fn(ev('k', { metaKey: true })), true)
		assert.equal(fn(ev('K', { ctrlKey: true })), true)
		assert.equal(fn(ev('K', { metaKey: true, shiftKey: true })), false, '⇧⌘K 是清空日志')
		assert.equal(fn(ev('k', { ctrlKey: true, shiftKey: true })), false)
		assert.equal(fn(ev('k', { metaKey: true, altKey: true })), false)
		assert.equal(fn(ev('k', {})), false)
	}
})

;(async () => {
	let failed = 0
	for (const t of tests) {
		try {
			await t.fn()
			console.log('ok   ' + t.name)
		} catch (e) {
			failed++
			console.error('FAIL ' + t.name)
			console.error(e)
		}
	}
	if (failed) {
		console.error(failed + ' failed')
		process.exit(1)
	}
	console.log('all ' + tests.length + ' passed')
})()
