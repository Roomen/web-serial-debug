// 网页更新检测：轮询 js/version.js，发现远端版本更高就把左下角版本号变成「点击刷新」入口。
// 版本号是唯一来源（window.APP_VERSION），所以这里直接抓源文件正则取版本，不另外生成 manifest。
(function () {
	'use strict'

	var FIRST_DELAY = 60 * 1000
	var INTERVAL = 30 * 60 * 1000
	var FOCUS_MIN_GAP = 5 * 60 * 1000
	var lastCheck = 0
	var found = false

	function parts(v) {
		return String(v).split('.').map(function (n) { return parseInt(n, 10) || 0 })
	}

	// 远端 > 本地才算更新，本地开发版本更高时不误报
	function newer(remote, local) {
		var a = parts(remote)
		var b = parts(local)
		for (var i = 0; i < 3; i++) {
			if ((a[i] || 0) > (b[i] || 0)) return true
			if ((a[i] || 0) < (b[i] || 0)) return false
		}
		return false
	}

	function markUpdate(version) {
		if (found) return
		found = true
		var el = document.getElementById('app-version')
		if (!el) return
		el.classList.add('rail-version--update')
		el.title = '有新版本 v' + version + '，点击刷新'
		el.setAttribute('role', 'button')
		el.setAttribute('tabindex', '0')
		el.setAttribute('aria-label', '有新版本 v' + version + '，点击刷新页面')
		var dot = document.createElement('span')
		dot.className = 'rail-version-dot'
		dot.setAttribute('aria-hidden', 'true')
		el.appendChild(dot)
		el.addEventListener('click', function () { location.reload() })
		el.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault()
				location.reload()
			}
		})
	}

	function check() {
		if (found || !window.APP_VERSION) return
		lastCheck = Date.now()
		fetch('js/version.js?_=' + Date.now(), { cache: 'no-store' })
			.then(function (r) { return r.ok ? r.text() : null })
			.then(function (text) {
				if (!text) return
				var m = text.match(/APP_VERSION\s*=\s*['"]([0-9]+(?:\.[0-9]+){0,2})['"]/)
				if (m && newer(m[1], window.APP_VERSION)) markUpdate(m[1])
			})
			.catch(function () { })
	}

	setTimeout(check, FIRST_DELAY)
	setInterval(check, INTERVAL)
	document.addEventListener('visibilitychange', function () {
		if (!document.hidden && Date.now() - lastCheck > FOCUS_MIN_GAP) check()
	})
})()
