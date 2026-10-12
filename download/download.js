// 客户端下载页：按域名定通道(主站正式版、dev 站预览版，互不列出对方的包)，按访问者系统推荐安装包，
// 下载按钮指向该通道最新一版的 GitHub 发布页。发布标签与文件名的约定见 desktop/DISTRIBUTION.md 与 desktop/scripts/tauri.mjs
;(function (root) {
	const REPO = 'Roomen/web-serial-debug'
	const HOSTS = { 'serial.logan825.org': 'main', 'serial-dev.logan825.org': 'dev' }

	const PACKAGES = [
		{ id: 'mac-arm64', os: 'macos', title: 'macOS · Apple 芯片', hint: 'M1 及之后的 Mac', file: (v) => `Serial-Debug_${v}_macos_arm64.dmg` },
		{ id: 'mac-x64', os: 'macos', title: 'macOS · Intel 芯片', hint: '2020 年及之前的 Intel Mac', file: (v) => `Serial-Debug_${v}_macos_x64.dmg` },
		{ id: 'win-x64', os: 'windows', title: 'Windows · x64', hint: 'Windows 10 / 11 安装程序', file: (v) => `Serial-Debug_${v}_windows_x64-setup.exe` }
	]

	// 正式站与预览站各自固定通道，参数改不了(两个通道不互通)；只有本地等其它主机允许 ?channel= 预览
	function channelFor(hostname, search) {
		const fixed = HOSTS[String(hostname || '').toLowerCase()]
		if (fixed) return fixed
		const m = /[?&]channel=(main|dev)(?:&|$)/.exec(search || '')
		return m ? m[1] : 'main'
	}

	function detectOs(env) {
		env = env || {}
		const ua = String(env.userAgent || '').toLowerCase()
		const p = String(env.uaPlatform || '').toLowerCase()
		if (p === 'android' || ua.indexOf('android') !== -1) return 'android'
		if (/iphone|ipad|ipod/.test(ua) || p === 'ios') return 'ios'
		// iPadOS 13+ 的 Safari 自报 Macintosh，只能靠触点数区分
		if (ua.indexOf('macintosh') !== -1 && (env.maxTouchPoints || 0) > 1) return 'ios'
		if (p === 'macos' || ua.indexOf('mac os') !== -1 || ua.indexOf('macintosh') !== -1) return 'macos'
		if (p === 'windows' || ua.indexOf('windows') !== -1) return 'windows'
		if (p === 'linux' || p === 'chrome os' || ua.indexOf('linux') !== -1 || ua.indexOf('cros') !== -1) return 'linux'
		return 'other'
	}

	// Client Hints 给 'arm' / 'x86'；拿不到时看 WebGL 渲染器名，Safari 统一报 'Apple GPU' 认不出就返回 null
	function archFromHints(architecture) {
		const a = String(architecture || '').toLowerCase()
		if (a === 'arm') return 'arm64'
		if (a === 'x86') return 'x64'
		return null
	}
	function archFromRenderer(renderer) {
		const r = String(renderer || '').toLowerCase()
		if (/apple m\d/.test(r)) return 'arm64'
		if (/intel|amd|radeon|nvidia/.test(r)) return 'x64'
		return null
	}

	// 返回 { id, sure }：sure 为 false 表示芯片没认出、按多数情况猜的；没有对应客户端返回 null
	function recommend(os, arch) {
		if (os === 'windows') return { id: 'win-x64', sure: true }
		if (os === 'macos') return arch === 'x64' ? { id: 'mac-x64', sure: true } : { id: 'mac-arm64', sure: arch === 'arm64' }
		return null
	}

	function parseVersion(s) {
		const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s || '')
		return m ? [+m[1], +m[2], +m[3]] : null
	}

	// 版本发布的标签是 desktop-<通道>-v<版本>(通道清单 desktop-<通道> 不算)，取未作草稿的最高版本
	function pickRelease(releases, channel) {
		const prefix = 'desktop-' + channel + '-v'
		let best = null
		;(Array.isArray(releases) ? releases : []).forEach((r) => {
			if (!r || r.draft || typeof r.tag_name !== 'string' || r.tag_name.indexOf(prefix) !== 0) return
			const v = parseVersion(r.tag_name.slice(prefix.length))
			if (!v) return
			if (best && (v[0] - best.v[0] || v[1] - best.v[1] || v[2] - best.v[2]) <= 0) return
			best = { v, release: r }
		})
		if (!best) return null
		const r = best.release
		return {
			version: best.v.join('.'),
			url: r.html_url || `https://github.com/${REPO}/releases/tag/${encodeURIComponent(r.tag_name)}`,
			date: r.published_at || null,
			assets: (r.assets || []).map((a) => a && a.name).filter(Boolean)
		}
	}

	function releasesPageUrl(channel) {
		return `https://github.com/${REPO}/releases?q=desktop-${channel}-v&expanded=true`
	}

	const api = { REPO, PACKAGES, channelFor, detectOs, archFromHints, archFromRenderer, recommend, pickRelease, releasesPageUrl }
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api
		return
	}

	// ===== 页面 =====
	const doc = root.document
	const nav = root.navigator || {}
	const channel = channelFor(root.location.hostname, root.location.search)
	const $ = (id) => doc.getElementById(id)

	function detectArch() {
		const uad = nav.userAgentData
		const viaHints = uad && typeof uad.getHighEntropyValues === 'function'
			? uad.getHighEntropyValues(['architecture']).then((v) => archFromHints(v && v.architecture), () => null)
			: Promise.resolve(null)
		return viaHints.then((a) => {
			if (a) return a
			try {
				const gl = doc.createElement('canvas').getContext('webgl')
				const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
				return archFromRenderer(gl && gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
			} catch (e) {
				return null
			}
		})
	}

	function fetchReleases() {
		const ctl = typeof AbortController === 'function' ? new AbortController() : null
		const timer = setTimeout(() => ctl && ctl.abort(), 10000)
		return fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
			headers: { Accept: 'application/vnd.github+json' },
			signal: ctl ? ctl.signal : undefined
		}).then((res) => {
			if (!res.ok) throw new Error('HTTP ' + res.status)
			return res.json()
		}).finally(() => clearTimeout(timer))
	}

	const state = { os: detectOs({ userAgent: nav.userAgent, uaPlatform: nav.userAgentData && nav.userAgentData.platform, maxTouchPoints: nav.maxTouchPoints }), arch: null, release: undefined, error: false }

	function el(tag, cls, text) {
		const e = doc.createElement(tag)
		if (cls) e.className = cls
		if (text != null) e.textContent = text
		return e
	}

	function actionFor(primary) {
		const r = state.release
		if (r) {
			const a = el('a', primary ? 'btn btn-primary' : 'btn', '前往发布页下载')
			a.href = r.url
			a.target = '_blank'
			a.rel = 'noopener'
			return a
		}
		if (state.error) {
			const a = el('a', 'btn', '在 GitHub 查看')
			a.href = releasesPageUrl(channel)
			a.target = '_blank'
			a.rel = 'noopener'
			return a
		}
		const b = el('button', 'btn', state.release === undefined ? '查询中…' : '尚未发布')
		b.disabled = true
		return b
	}

	function fileLine(pkg) {
		const r = state.release
		if (!r) return null
		const name = pkg.file(r.version)
		return el('div', 'file', '文件：' + name)
	}

	function render() {
		const r = state.release
		const rec = recommend(state.os, state.arch)
		$('dl-version').textContent = r ? 'v' + r.version + (r.date ? ' · ' + r.date.slice(0, 10) : '')
			: state.error ? '暂时查不到发布信息' : state.release === undefined ? '正在查询最新版本…' : '客户端尚未发布'

		const box = $('dl-recommend')
		box.replaceChildren()
		if (rec) {
			const pkg = PACKAGES.find((p) => p.id === rec.id)
			box.append(el('div', 'eyebrow', '为你的系统推荐'), el('h2', null, pkg.title))
			box.append(el('p', 'muted', rec.sure ? pkg.hint : '没能识别芯片类型，按 Apple 芯片推荐；Intel Mac 请选下方的 Intel 版本（苹果菜单 → 关于本机 可查看芯片）'))
			const f = fileLine(pkg)
			if (f) box.append(f)
			box.append(actionFor(true))
		} else {
			const name = { linux: 'Linux', android: 'Android', ios: 'iOS / iPadOS' }[state.os]
			box.append(el('div', 'eyebrow', '当前系统'), el('h2', null, name ? name + ' 暂无客户端' : '当前系统暂无客户端'))
			box.append(el('p', 'muted', '可以直接使用网页版（Chrome / Edge 等 Chromium 浏览器支持 Web Serial）；客户端目前提供 macOS 与 Windows 版本。'))
			const a = el('a', 'btn btn-primary', '打开网页版')
			a.href = '../'
			box.append(a)
		}

		const list = $('dl-list')
		list.replaceChildren()
		PACKAGES.forEach((pkg) => {
			const li = el('li', rec && rec.id === pkg.id ? 'item is-rec' : 'item')
			const info = el('div', 'info')
			const t = el('div', 'title', pkg.title)
			if (rec && rec.id === pkg.id) t.append(el('span', 'tag', '推荐'))
			info.append(t, el('div', 'muted', pkg.hint))
			const f = fileLine(pkg)
			if (f) info.append(f)
			li.append(info, actionFor(!!rec && rec.id === pkg.id))
			list.append(li)
		})
	}

	function boot() {
		const dev = channel === 'dev'
		doc.documentElement.dataset.channel = channel
		$('dl-channel').textContent = dev ? '预览版' : '正式版'
		$('dl-channel-note').textContent = dev
			? '预览版来自 dev 分支，功能较新但可能不稳定，只会更新到后续预览版。'
			: '正式版来自 main 分支，只会更新到后续正式版。'
		doc.title = dev ? '下载客户端（预览版） · Web Serial Debug' : '下载客户端 · Web Serial Debug'
		render()
		detectArch().then((a) => { state.arch = a; render() })
		fetchReleases().then((list) => {
			state.release = pickRelease(list, channel)
			render()
		}, () => {
			state.error = true
			state.release = null
			render()
		})
	}

	if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot)
	else boot()
})(typeof window !== 'undefined' ? window : globalThis)
