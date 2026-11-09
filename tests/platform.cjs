// Run: node tests/platform.cjs — synthetic data only.
// 覆盖: 平台层(js/platform.js)的系统 / 运行时识别、功能画像(桌面全功能、移动端只留 SEK 协议与固件升级)、
// 传输优先顺序、协议与布局白名单、多开、功能门控样式
const assert = require('node:assert/strict')
const P = require('../js/platform.js')

// ---- 识别：桌面浏览器一律 web；Tauri 按 UA 分系统；移动端按 UA / iPadOS 触点；原生壳给的系统优先 ----
{
	const UA = {
		winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
		macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
		android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
		iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
		ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
	}
	assert.deepEqual(P.detect({ userAgent: UA.winChrome }), { os: 'web', runtime: 'browser' })
	assert.deepEqual(P.detect({ userAgent: UA.macChrome, maxTouchPoints: 0 }), { os: 'web', runtime: 'browser' })
	assert.deepEqual(P.detect({ userAgent: UA.winChrome, tauri: true }), { os: 'windows', runtime: 'tauri' })
	assert.deepEqual(P.detect({ userAgent: UA.macChrome, tauri: true }), { os: 'macos', runtime: 'tauri' })
	assert.deepEqual(P.detect({ userAgent: UA.android }), { os: 'android', runtime: 'browser' })
	assert.deepEqual(P.detect({ userAgent: UA.android, tauri: true }), { os: 'android', runtime: 'tauri' })
	assert.deepEqual(P.detect({ userAgent: UA.iphone }), { os: 'ios', runtime: 'browser' })
	assert.deepEqual(P.detect({ userAgent: UA.ipad, maxTouchPoints: 5 }), { os: 'ios', runtime: 'browser' }, 'iPadOS 自报 Macintosh')
	assert.deepEqual(P.detect({ userAgent: UA.macChrome, tauri: true, tauriOs: 'ios' }), { os: 'ios', runtime: 'tauri' })
	assert.deepEqual(P.detect({ uaPlatform: 'Android' }), { os: 'android', runtime: 'browser' })
	assert.deepEqual(P.detect({}), { os: 'web', runtime: 'browser' })
}

// ---- 桌面画像：全部功能、双路、任意协议、只走串口、可多开 ----
{
	;['web', 'windows', 'macos', 'linux'].forEach(function (os) {
		const d = P.resolve({ os, runtime: os === 'web' ? 'browser' : 'tauri' })
		assert.equal(d.profile, 'desktop')
		assert.equal(d.mobile, false)
		assert.equal(d.lanes, 2)
		// 界面只有一套：画像里不再有布局清单，也没有布局切换功能
		assert.equal(d.layouts, undefined)
		assert.equal(P.FEATURES.indexOf('layout.switch'), -1)
		assert.equal(d.protocols, '*')
		assert.deepEqual(d.transports, ['serial'])
		assert.equal(d.multiInstance, true)
		P.FEATURES.filter((f) => f.indexOf('transport.') !== 0 && f !== 'shell.browser' && f !== 'view.ble' && f !== 'view.classic').forEach((f) => assert.equal(P.hasFeature(d, f), true, os + ' ' + f))
		// 网页外壳入口(GitHub / 反馈链接)同样只在浏览器里
		assert.equal(P.hasFeature(d, 'shell.browser'), os === 'web')
		assert.equal(P.hasFeature(d, 'view.ble'), os === 'windows' || os === 'macos')
		assert.equal(P.hasFeature(d, 'transport.serial'), true)
		assert.equal(P.hasFeature(d, 'transport.ble'), false)
		assert.equal(P.hasFeature(d, 'panel.some-future-tool'), true, '目录外的新功能在桌面默认开启')
		assert.equal(P.gatingCss(d), (os === 'web' || os === 'linux' ? '[data-feature~="view.classic"]{display:none !important}\n[data-feature~="view.ble"]{display:none !important}\n' : '') + '[data-feature~="transport.ble"]{display:none !important}\n[data-feature~="transport.bt-classic"]{display:none !important}' + (os === 'web' ? '' : '\n[data-feature~="shell.browser"]{display:none !important}'))
	})
}

// ---- 移动画像：SEK 协议设置与下发 + 固件升级(+ 解析)，单路、只 SEK、单实例 ----
{
	const a = P.resolve({ os: 'android', runtime: 'tauri' })
	assert.equal(a.profile, 'mobile')
	assert.equal(a.lanes, 1)
	assert.equal(a.layouts, undefined)
	assert.deepEqual(a.protocols, ['sek'])
	assert.equal(a.multiInstance, false)
	assert.deepEqual(a.transports, ['ble', 'bt-classic', 'serial'])
	const on = P.FEATURES.filter((f) => P.hasFeature(a, f))
	const expectOn = ['view.serial', 'panel.protocol', 'panel.firmware', 'panel.parse', 'transport.serial', 'transport.ble', 'transport.bt-classic']
	assert.deepEqual(on.slice().sort(), expectOn.slice().sort())
	assert.equal(P.hasFeature(a, 'lane.dual'), false)
	assert.equal(P.hasFeature(a, 'view.power'), false)
	assert.equal(P.hasFeature(a, 'panel.sts-sim'), false)
	assert.equal(P.hasFeature(a, 'panel.some-future-tool'), false, '目录外的新功能在移动端默认关闭')
	const css = P.gatingCss(a)
	assert.ok(css.includes('[data-feature~="view.power"]{display:none !important}'))
	assert.ok(css.includes('[data-feature~="lane.dual"]'))
	assert.ok(!css.includes('"panel.protocol"'))

	const i = P.resolve({ os: 'ios', runtime: 'tauri' })
	assert.deepEqual(i.transports, ['ble'], 'iOS 没有串口与经典蓝牙')
	assert.equal(P.hasFeature(i, 'transport.serial'), false)
	assert.equal(P.hasFeature(i, 'panel.firmware'), true)
}

// ---- 客户端运行时：识别为 macOS 客户端，网页外壳入口关闭；不再提供布局相关接口 ----
{
	const w = fakeWin('', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')
	w.__TAURI_INTERNALS__ = {}
	const api = P.build(w)
	assert.equal(api.os, 'macos')
	assert.equal(api.layouts, undefined)
	assert.equal(api.allowsLayout, undefined)
	assert.equal(api.fallbackLayout, undefined)
	assert.equal(api.has('shell.browser'), false)
	assert.ok(rulesOf(w).includes('[data-feature~="shell.browser"]{display:none !important}'))
	assert.ok(!rulesOf(w).includes('layout.switch'))
}

// ---- 液态玻璃：只认客户端建窗时写的标志(macOS 26+ 才写)，且只在客户端运行时；网页版没有这个标志 ----
{
	const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
	const glass = fakeWin('', UA_MAC)
	glass.__TAURI_INTERNALS__ = {}
	glass.__APP_WINDOW_GLASS__ = true
	P.build(glass)
	assert.equal(glass.document.documentElement.dataset.glass, 'liquid')
	const opaque = fakeWin('', UA_MAC)
	opaque.__TAURI_INTERNALS__ = {}
	P.build(opaque)
	assert.equal(opaque.document.documentElement.dataset.glass, undefined, '没有标志(26 以下、其它系统)不写 data-glass')
	const web = fakeWin('', UA_MAC)
	web.__APP_WINDOW_GLASS__ = true
	P.build(web)
	assert.equal(web.document.documentElement.dataset.glass, undefined, '网页版即便有同名全局量也不写')
}

// ---- 预览覆盖：只换系统，运行时不变；非法值忽略 ----
{
	const d = P.resolve({ os: 'web', runtime: 'browser' }, { os: 'android' })
	assert.equal(d.os, 'android')
	assert.equal(d.runtime, 'browser')
	assert.equal(d.profile, 'mobile')
	assert.equal(P.resolve({ os: 'web', runtime: 'browser' }, { os: 'symbian' }).os, 'web')
	assert.equal(P.resolve({ os: 'bogus' }).os, 'web')
}

// ---- build：首屏 data-*、门控样式、目录外功能的动态规则、静态 data-feature 扫描、实例 ID、平台服务 ----
function fakeWin(search, ua, store) {
	const head = { children: [], appendChild(el) { this.children.push(el) } }
	const staticEls = [
		{ attrs: { 'data-feature': 'panel.protocol' }, getAttribute(k) { return this.attrs[k] || null } },
		{ attrs: { 'data-feature': 'view.future-thing' }, getAttribute(k) { return this.attrs[k] || null } },
	]
	return {
		navigator: { userAgent: ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', maxTouchPoints: 0 },
		location: { search: search || '' },
		sessionStorage: { m: store || {}, get length() { return Object.keys(this.m).length }, key(i) { return Object.keys(this.m)[i] }, removeItem(k) { delete this.m[k] }, getItem(k) { return this.m[k] || null }, setItem(k, v) { this.m[k] = String(v) } },
		document: {
			readyState: 'complete',
			documentElement: { dataset: {} },
			head,
			createElement() { return { id: '', textContent: '' } },
			querySelectorAll() { return staticEls },
		},
	}
}
function rulesOf(win) { const st = win.document.head.children.find((e) => e.id === 'platform-gating'); return st ? st.textContent : '' }
{
	const w = fakeWin('?platform=android')
	const api = P.build(w)
	assert.equal(w.document.documentElement.dataset.platform, 'android')
	assert.equal(w.document.documentElement.dataset.profile, 'mobile')
	assert.equal(w.document.documentElement.dataset.runtime, 'browser')
	assert.equal(w.document.head.children.length, 1, '只建一个门控样式节点')
	const css = rulesOf(w)
	assert.ok(css.includes('"view.power"'))
	assert.ok(css.includes('"view.future-thing"'), '静态 data-feature 的目录外 id 在移动端补规则')
	assert.ok(!css.includes('"panel.protocol"'))
	// gate：目录外的面板 id 补规则并标在节点上，已有标记保留
	const el = { a: { 'data-feature': 'view.serial' }, getAttribute(k) { return this.a[k] || null }, setAttribute(k, v) { this.a[k] = v } }
	assert.equal(api.gate(el, 'panel.new-tool'), false)
	assert.equal(el.a['data-feature'], 'view.serial panel.new-tool')
	assert.ok(rulesOf(w).includes('[data-feature~="panel.new-tool"]{display:none !important}'))
	api.gate(el, 'panel.new-tool')
	assert.equal(rulesOf(w).split('panel.new-tool').length, 2, '同一 id 只补一次规则')
	assert.equal(api.gate(null, 'panel.protocol'), true)
	assert.equal(api.allowsProtocol('sek'), true)
	assert.equal(api.allowsProtocol('gz'), false)
	// 平台服务
	assert.equal(api.service('scanner'), null)
	const scanner = { scan: async () => 'x' }
	api.provide('scanner', scanner)
	assert.equal(api.service('scanner'), scanner)
	assert.throws(() => api.provide('', scanner))
	// 实例 ID：同一会话存储(刷新)保持不变，新会话不同
	assert.ok(api.instanceId)
	const again = P.build(fakeWin('', null, { appInstanceId: api.instanceId }))
	assert.notEqual(again.instanceId, api.instanceId, '没有 Web Locks 的浏览器保守隔离继承运行态')
	assert.notEqual(P.build(fakeWin('')).instanceId, api.instanceId)
}
{
	const w = fakeWin('')
	const api = P.build(w)
	assert.equal(api.profile, 'desktop')
	assert.equal(api.multiInstance, true)
	assert.equal(api.gate(null, 'panel.new-tool'), true)
	assert.ok(!rulesOf(w).includes('future-thing'), '桌面上目录外 id 默认开启，不补隐藏规则')
	assert.ok(!rulesOf(w).includes('panel.new-tool'))
}

// ---- head 里加载(readyState=loading)：静态 data-feature 等 DOMContentLoaded 再扫描补规则 ----
{
	const w = fakeWin('?platform=ios')
	const els = []
	let onReady = null
	w.document.readyState = 'loading'
	w.document.querySelectorAll = () => els
	w.document.addEventListener = (t, fn) => { if (t === 'DOMContentLoaded') onReady = fn }
	P.build(w)
	assert.ok(!rulesOf(w).includes('late-thing'))
	assert.equal(typeof onReady, 'function', 'loading 时挂 DOMContentLoaded')
	els.push({ getAttribute() { return 'panel.protocol view.late-thing' } })
	onReady()
	assert.ok(rulesOf(w).includes('[data-feature~="view.late-thing"]{display:none !important}'))
}

console.log('platform: ok')

// 跨文档互斥不依赖旧标签页处理消息；包含 bfcache 释放/重新认领与更新交接。
;(async function () {
	const held = new Map()
	const locks = { async request(key, opts, callback) {
		if (held.has(key)) return callback(null)
		held.set(key, true)
		try { return await callback({ name: key }) } finally { held.delete(key) }
	} }
	function windowWith(store) {
		const w = fakeWin('', null, store)
		const listeners = {}
		w.navigator.locks = locks
		w.addEventListener = (type, fn) => (listeners[type] ||= []).push(fn)
		w.emit = (type, ev = {}) => (listeners[type] || []).forEach(fn => fn(ev))
		return w
	}
	const w = windowWith({ appInstanceId: 'synthetic-instance', serialWantOpenS: '1', serialWantPortS: 'synthetic', 'sk-batch-state.index': '17', 'stsSim.prevProtocol': 'sek' })
	const first = P.build(w)
	await first.instanceReady
	const copy = windowWith({ ...w.sessionStorage.m })
	const second = P.build(copy)
	await second.instanceReady
	assert.notEqual(second.instanceId, first.instanceId)
	for (const key of ['serialWantOpenS', 'serialWantPortS', 'sk-batch-state.index', 'stsSim.prevProtocol']) assert.equal(copy.sessionStorage.getItem(key), null)
	assert.equal(w.sessionStorage.getItem('serialWantOpenS'), '1')
	w.emit('pagehide')
	await Promise.resolve()
	const reload = windowWith({ ...w.sessionStorage.m })
	const third = P.build(reload)
	await third.instanceReady
	assert.equal(third.instanceId, first.instanceId, '刷新释放旧租约后 ID 不变')
	w.emit('pageshow', { persisted: true })
	await first.instanceReady
	assert.notEqual(first.instanceId, third.instanceId, 'bfcache 恢复先重新认领，有碰撞时清理意图')
	assert.equal(w.sessionStorage.getItem('serialWantOpenS'), null)
	const native = fakeWin('', 'tauri', { appInstanceId: 'handoff', serialWantOpenS: '1' })
	native.__TAURI_INTERNALS__ = {}
	native.__APP_NATIVE_INSTANCE_KEY__ = 'process:window'
	native.__APP_UPDATE_RESTORED__ = true
	const restored = P.build(native)
	await restored.instanceReady
	assert.equal(restored.instanceId, 'handoff')
	assert.equal(native.sessionStorage.getItem('serialWantOpenS'), '1')
	delete native.__APP_UPDATE_RESTORED__
	assert.equal(P.build(native).instanceId, 'handoff', '不支持 Web Locks 的原生窗口刷新不丢重连')
	console.log('platform instance lifecycle: ok')
})().catch(error => { console.error(error); process.exitCode = 1 })
