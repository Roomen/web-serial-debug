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

// ---- 桌面画像：全部功能、双路、两套布局、任意协议、只走串口、可多开 ----
{
	;['web', 'windows', 'macos', 'linux'].forEach(function (os) {
		const d = P.resolve({ os, runtime: os === 'web' ? 'browser' : 'tauri' })
		assert.equal(d.profile, 'desktop')
		assert.equal(d.mobile, false)
		assert.equal(d.lanes, 2)
		assert.deepEqual(d.layouts, ['classic', 'modern'])
		assert.equal(d.protocols, '*')
		assert.deepEqual(d.transports, ['serial'])
		assert.equal(d.multiInstance, true)
		P.FEATURES.filter((f) => f.indexOf('transport.') !== 0).forEach((f) => assert.equal(P.hasFeature(d, f), true, os + ' ' + f))
		assert.equal(P.hasFeature(d, 'transport.serial'), true)
		assert.equal(P.hasFeature(d, 'transport.ble'), false)
		assert.equal(P.hasFeature(d, 'panel.some-future-tool'), true, '目录外的新功能在桌面默认开启')
		assert.equal(P.gatingCss(d), '[data-feature~="transport.ble"]{display:none !important}\n[data-feature~="transport.bt-classic"]{display:none !important}')
	})
}

// ---- 移动画像：SEK 协议设置与下发 + 固件升级(+ 解析)，单路、只经典布局、只 SEK、单实例 ----
{
	const a = P.resolve({ os: 'android', runtime: 'tauri' })
	assert.equal(a.profile, 'mobile')
	assert.equal(a.lanes, 1)
	assert.deepEqual(a.layouts, ['classic'])
	assert.deepEqual(a.protocols, ['sek'])
	assert.equal(a.multiInstance, false)
	assert.deepEqual(a.transports, ['ble', 'bt-classic', 'serial'])
	const on = P.FEATURES.filter((f) => P.hasFeature(a, f))
	const expectOn = ['view.serial', 'panel.protocol', 'panel.firmware', 'panel.parse', 'transport.serial', 'transport.ble', 'transport.bt-classic']
	assert.deepEqual(on.slice().sort(), expectOn.slice().sort())
	assert.equal(P.hasFeature(a, 'lane.dual'), false)
	assert.equal(P.hasFeature(a, 'layout.switch'), false)
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
		sessionStorage: { m: store || {}, getItem(k) { return this.m[k] || null }, setItem(k, v) { this.m[k] = String(v) } },
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
	assert.equal(api.allowsLayout('modern'), false)
	// 平台服务
	assert.equal(api.service('scanner'), null)
	const scanner = { scan: async () => 'x' }
	api.provide('scanner', scanner)
	assert.equal(api.service('scanner'), scanner)
	assert.throws(() => api.provide('', scanner))
	// 实例 ID：同一会话存储(刷新)保持不变，新会话不同
	assert.ok(api.instanceId)
	const again = P.build(fakeWin('', null, { appInstanceId: api.instanceId }))
	assert.equal(again.instanceId, api.instanceId)
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
