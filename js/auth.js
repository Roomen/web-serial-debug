;(function () {
	var _h = [175, 162, 62, 223, 78, 252, 150, 80, 91, 159, 27, 96, 16, 146, 189, 84, 217, 75, 48, 212, 59, 7, 164, 221, 109, 225, 249, 252, 98, 153, 110, 18]
	var _k = [75, 114, 31, 142, 58, 213, 103, 201]
	var _expiry = 3 * 24 * 60 * 60 * 1000

	function _d() {
		var r = ''
		for (var i = 0; i < _h.length; i++) {
			var b = _h[i] ^ _k[i % _k.length]
			r += (b < 16 ? '0' : '') + b.toString(16)
		}
		return r
	}

	async function _sha(msg) {
		var buf = new TextEncoder().encode(msg)
		var hb = await crypto.subtle.digest('SHA-256', buf)
		var a = new Uint8Array(hb)
		var r = ''
		for (var i = 0; i < a.length; i++) {
			r += (a[i] < 16 ? '0' : '') + a[i].toString(16)
		}
		return r
	}

	function _gt() {
		var t = Date.now()
		var x = (_h[0] << 24) | (_h[1] << 16) | (_h[2] << 8) | _h[3]
		return t.toString(36) + '.' + (t ^ x).toString(36)
	}

	function _vt(v) {
		if (!v) return false
		var p = v.indexOf('.')
		if (p < 0) return false
		var t = parseInt(v.substring(0, p), 36)
		if (!t || t > Date.now() + 86400000) return false
		if (Date.now() - t > _expiry) return false
		var s = parseInt(v.substring(p + 1), 36)
		var x = (_h[0] << 24) | (_h[1] << 16) | (_h[2] << 8) | _h[3]
		return s === (t ^ x)
	}

	window.__auth = {
		login: async function (email, password) {
			var h = await _sha(email + ':' + password)
			if (h !== _d()) return false
			localStorage.setItem('_as', _gt())
			return true
		},
		authed: function () {
			return _vt(localStorage.getItem('_as'))
		},
		logout: function () {
			localStorage.removeItem('_as')
			location.reload()
		}
	}

	function showIssueTip() {
		var tip = document.getElementById('issue-tip')
		var closeBtn = document.getElementById('issue-tip-close')
		if (!tip || !closeBtn) return
		if (localStorage.getItem('issueTipDismissed')) return
		tip.hidden = false
		closeBtn.addEventListener('click', function () {
			tip.hidden = true
			localStorage.setItem('issueTipDismissed', '1')
		})
	}

	var verEl = document.getElementById('app-version')
	if (verEl && window.APP_VERSION) {
		verEl.textContent = 'v' + window.APP_VERSION
		verEl.title = '应用版本 v' + window.APP_VERSION
	}

	var overlay = document.getElementById('login-overlay')
	if (!overlay) return

	if (window.__auth.authed()) {
		overlay.style.display = 'none'
		showIssueTip()
		return
	}

	var btn = document.getElementById('login-submit')
	var em = document.getElementById('login-email')
	var pw = document.getElementById('login-password')
	var er = document.getElementById('login-error')
	if (!btn || !em || !pw || !er) return

	function _err(msg) {
		er.textContent = msg
		er.style.display = msg ? '' : 'none'
	}

	async function _do() {
		_err('')
		if (!em.value.trim() || !pw.value) {
			_err('请输入邮箱和密码')
			return
		}
		btn.disabled = true
		btn.textContent = '\u9a8c\u8bc1\u4e2d...'
		try {
			var ok = await window.__auth.login(em.value.trim(), pw.value)
			if (ok) {
				location.reload()
				return
			}
			_err('邮箱或密码错误')
		} catch (e) {
			_err('验证失败，请重试')
		} finally {
			btn.disabled = false
			btn.textContent = '\u767b \u5f55'
		}
	}

	btn.addEventListener('click', _do)
	pw.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') _do()
	})
	em.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') pw.focus()
	})
})()
