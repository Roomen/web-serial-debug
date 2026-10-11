// 平台层：识别运行环境(系统 × 运行时)，给出功能画像，页面与各模块只经 window.AppPlatform 问「这里能不能用某功能」，
// 不要自己嗅探 UA、navigator.serial 或 Tauri 全局量。在 <head> 里第一个加载(首屏前定下 data-* 与功能门控样式)，不依赖任何模块。
// 画像：desktop(web / Windows / macOS / Linux，全部功能、双路、两套布局、可多开)；mobile(Android / iOS，只留 SEK 协议设置与下发、
// 固件升级，单路，只用经典布局，传输按系统取 BLE / 经典蓝牙 / 串口)。功能 id 见 FEATURES；画像外的功能在 DOM 上用
// data-feature="id"(多个以空格分隔，须全部开启)标注，由这里注入的样式隐藏，模块代码用 AppPlatform.has(id) 判断。
// 预览其它平台：URL 加 ?platform=android|ios|windows|macos|linux|web(只换系统，运行时仍按实际识别)。
// 纯逻辑可在 node 里跑(tests/platform.cjs)。
;(function (root) {
	'use strict'

	const FEATURES = [
		'view.serial', // 串口调试视图(日志、发送；移动端承载协议与固件面板)
		'view.firmware-pack', // 固件打包视图(原始包 / 压缩包 / 双向差分)
		'view.power', // 功耗分析视图(BLU 电流计)
		'lane.dual', // 双路 A/B(由画像的 lanes 推出)
		'layout.switch', // 经典 / 现代布局切换(由画像的 layouts 推出)
		'panel.quick-send',
		'panel.protocol', // 协议设置与下发
		'panel.rw', // 随机读写测试
		'panel.batch', // 批量配置写入
		'panel.firmware', // 固件升级
		'panel.parse', // 协议解析
		'panel.sts-sim', // STS 模拟
		'transport.serial',
		'transport.ble',
		'transport.bt-classic',
	]

	const OS_LIST = ['web', 'windows', 'macos', 'linux', 'android', 'ios']
	const MOBILE_OS = ['android', 'ios']

	// 各系统可用的传输，按优先顺序：iOS 没有串口，经典蓝牙要 MFi，只有 BLE；Android 手机串口靠 USB OTG，排在蓝牙之后
	const OS_TRANSPORTS = {
		web: ['serial'],
		windows: ['serial'],
		macos: ['serial'],
		linux: ['serial'],
		android: ['ble', 'bt-classic', 'serial'],
		ios: ['ble'],
	}

	const PROFILES = {
		desktop: {
			features: '*',
			protocols: '*',
			lanes: 2,
			layouts: ['classic', 'modern'],
		},
		mobile: {
			// 不开固件打包视图：移动端不输出中间产物，原始固件在固件升级面板里按设备版本自动差分 / 压缩后直接升级
			features: ['view.serial', 'panel.protocol', 'panel.parse', 'panel.firmware'],
			protocols: ['sek'],
			lanes: 1,
			layouts: ['classic'],
		},
	}

	function lower(s) { return String(s || '').toLowerCase() }

	// env = { userAgent, uaPlatform(navigator.userAgentData.platform), maxTouchPoints, tauri(bool), tauriOs(可选，原生插件给出) }
	function detect(env) {
		env = env || {}
		const runtime = env.tauri ? 'tauri' : 'browser'
		const forced = lower(env.tauriOs)
		if (OS_LIST.indexOf(forced) !== -1 && forced !== 'web') return { os: forced, runtime }
		const ua = lower(env.userAgent)
		const p = lower(env.uaPlatform)
		let os = 'web'
		if (p === 'android' || ua.indexOf('android') !== -1) os = 'android'
		else if (/iphone|ipad|ipod/.test(ua) || p === 'ios') os = 'ios'
		// iPadOS 13+ 的 Safari 自报 Macintosh，只能靠触点数区分
		else if (ua.indexOf('macintosh') !== -1 && (env.maxTouchPoints || 0) > 1) os = 'ios'
		else if (runtime === 'tauri') {
			if (p === 'windows' || ua.indexOf('windows') !== -1) os = 'windows'
			else if (p === 'macos' || ua.indexOf('mac os') !== -1) os = 'macos'
			else if (p === 'linux' || ua.indexOf('linux') !== -1) os = 'linux'
		}
		// 桌面浏览器一律算 web：功能与桌面客户端一致，区别只在运行时(多开、原生串口等由 runtime 决定)
		return { os, runtime }
	}

	// 由系统与运行时算出完整画像；override.os 用于预览(?platform=)
	function resolve(info, override) {
		info = info || {}
		const os = override && OS_LIST.indexOf(override.os) !== -1 ? override.os : (OS_LIST.indexOf(info.os) !== -1 ? info.os : 'web')
		const runtime = info.runtime === 'tauri' ? 'tauri' : 'browser'
		const profileId = MOBILE_OS.indexOf(os) !== -1 ? 'mobile' : 'desktop'
		const prof = PROFILES[profileId]
		const transports = OS_TRANSPORTS[os].slice()
		const enabled = {}
		FEATURES.forEach(function (f) {
			if (f.indexOf('transport.') === 0) enabled[f] = transports.indexOf(f.slice(10)) !== -1
			else if (f === 'lane.dual') enabled[f] = prof.lanes > 1
			else if (f === 'layout.switch') enabled[f] = prof.layouts.length > 1
			else enabled[f] = prof.features === '*' || prof.features.indexOf(f) !== -1
		})
		return {
			os,
			runtime,
			profile: profileId,
			mobile: profileId === 'mobile',
			lanes: prof.lanes,
			layouts: prof.layouts.slice(),
			transports,
			protocols: prof.protocols === '*' ? '*' : prof.protocols.slice(),
			// 桌面浏览器多开就是多标签页；桌面客户端允许多窗口 / 多进程；移动端单实例
			multiInstance: profileId === 'desktop',
			enabled,
		}
	}

	// 未列入目录的功能 id 在桌面画像下视为开启(新功能默认全平台可用，移动端要显式加进画像)
	function hasFeature(desc, id) {
		if (Object.prototype.hasOwnProperty.call(desc.enabled, id)) return desc.enabled[id]
		return desc.profile === 'desktop'
	}

	function disabledFeatures(desc) {
		return FEATURES.filter(function (f) { return !desc.enabled[f] })
	}

	// 只认功能 id 的字符集，防止拼进选择器出错
	function gatingCss(desc) {
		return disabledFeatures(desc).filter(function (f) { return /^[a-z0-9.-]+$/.test(f) }).map(function (f) {
			return '[data-feature~="' + f + '"]{display:none !important}'
		}).join('\n')
	}

	function makeInstanceId() {
		return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
	}

	// ---- 浏览器里建立 window.AppPlatform ----
	function build(win) {
		const nav = win.navigator || {}
		const tauri = !!(win.__TAURI_INTERNALS__ || win.__TAURI__)
		const info = detect({
			userAgent: nav.userAgent,
			uaPlatform: nav.userAgentData && nav.userAgentData.platform,
			maxTouchPoints: nav.maxTouchPoints,
			tauri,
			tauriOs: win.__APP_NATIVE_OS__,
		})
		let override = null
		try {
			const q = new URLSearchParams(win.location.search).get('platform')
			if (q) override = { os: lower(q) }
		} catch (e) {}
		const desc = resolve(info, override)

		// 实例 ID：每个窗口 / 标签页一份，刷新不变(存 sessionStorage)。多开时区分「本实例」的运行态用它，
		// 跨实例共享的只有 localStorage 里的设置；重连意图等运行态必须放 sessionStorage，否则两个实例会抢同一个口
		let instanceId = ''
		try {
			instanceId = win.sessionStorage.getItem('appInstanceId') || ''
			if (!instanceId) {
				instanceId = makeInstanceId()
				win.sessionStorage.setItem('appInstanceId', instanceId)
			}
		} catch (e) { instanceId = makeInstanceId() }

		// 平台服务：原生壳或可选模块在这里提供能力(如 scanner 扫码、file-save 存文件、instance 新开窗口)，
		// 功能代码用 service(name) 取，拿到 null 就不显示入口，不要按平台名分支
		const services = {}

		const api = {
			os: desc.os,
			runtime: desc.runtime,
			profile: desc.profile,
			mobile: desc.mobile,
			lanes: desc.lanes,
			layouts: desc.layouts,
			transports: desc.transports,
			protocols: desc.protocols,
			multiInstance: desc.multiInstance,
			instanceId,
			features: FEATURES.slice(),
			has(id) { return hasFeature(desc, id) },
			allowsProtocol(id) { return desc.protocols === '*' || desc.protocols.indexOf(id) !== -1 },
			allowsLayout(id) { return desc.layouts.indexOf(id) !== -1 },
			provide(name, impl) {
				if (!name || !impl) throw new TypeError('平台服务缺少 name 或实现')
				services[name] = impl
				return impl
			},
			service(name) { return services[name] || null },
		}

		// 门控样式：目录里关掉的功能首屏前就写好；目录外的 id(新面板、新入口)在用到时经 gate() 或 DOM 扫描补规则
		const ruled = new Set(disabledFeatures(desc))
		let style = null
		function addRules(css) {
			if (!css || !win.document.head) return
			if (!style) {
				style = win.document.createElement('style')
				style.id = 'platform-gating'
				win.document.head.appendChild(style)
			}
			style.textContent += (style.textContent ? '\n' : '') + css
		}
		function ensureRule(id) {
			if (ruled.has(id) || hasFeature(desc, id) || !/^[a-z0-9.-]+$/.test(id)) return
			ruled.add(id)
			addRules('[data-feature~="' + id + '"]{display:none !important}')
		}
		// 把节点标成需要功能 id，画像没开就隐藏；返回该功能是否开启
		api.gate = function (el, id) {
			if (el) {
				const cur = (el.getAttribute('data-feature') || '').split(/\s+/).filter(Boolean)
				if (cur.indexOf(id) === -1) el.setAttribute('data-feature', cur.concat(id).join(' '))
			}
			ensureRule(id)
			return hasFeature(desc, id)
		}

		const docEl = win.document && win.document.documentElement
		if (docEl) {
			docEl.dataset.platform = desc.os
			docEl.dataset.runtime = desc.runtime
			docEl.dataset.profile = desc.profile
			addRules(gatingCss(desc))
			// 页面里静态写的 data-feature 若不在目录里，解析完再补规则
			const scan = function () {
				win.document.querySelectorAll('[data-feature]').forEach(function (el) {
					el.getAttribute('data-feature').split(/\s+/).filter(Boolean).forEach(ensureRule)
				})
			}
			if (win.document.readyState === 'loading') win.document.addEventListener('DOMContentLoaded', scan)
			else scan()
		}
		return api
	}

	const lib = { FEATURES, PROFILES, OS_TRANSPORTS, detect, resolve, hasFeature, disabledFeatures, gatingCss, build }

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = lib
	}
	if (root.document && root.navigator) {
		root.AppPlatform = build(root)
	}
})(typeof window !== 'undefined' ? window : globalThis)
