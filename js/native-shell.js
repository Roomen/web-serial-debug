// 桌面客户端(Tauri 2)的页面侧外壳胶水：只在 AppPlatform 判定为 tauri 运行时生效，网页版什么也不做。
// 页面的导出、固件产物都是 <a download> + blob，客户端由 Rust 端(desktop/src-tauri/src/lib.rs)存进系统「下载」目录后派发 app-download，
// 这里提示保存位置(浏览器有下载栏，WebView 没有，不提示用户就不知道文件去哪了)。
;(function (root) {
	'use strict'
	const P = root.AppPlatform
	const T = root.__TAURI__
	if (!P || P.runtime !== 'tauri' || !T || !T.event) return

	let timer = 0
	function notify(text, isError) {
		let tip = document.getElementById('native-toast')
		if (!tip) {
			tip = document.createElement('div')
			tip.id = 'native-toast'
			tip.setAttribute('role', 'status')
			tip.title = '点击关闭'
			tip.addEventListener('click', function () { tip.classList.remove('is-show') })
			document.body.appendChild(tip)
		}
		tip.className = 'serial-toast' + (isError ? ' is-error' : '')
		tip.textContent = text
		tip.classList.remove('is-show')
		void tip.offsetWidth
		tip.classList.add('is-show')
		clearTimeout(timer)
		timer = setTimeout(function () { tip.classList.remove('is-show') }, 4000)
	}

	T.event.listen('app-download', function (e) {
		const p = e && e.payload ? e.payload : {}
		const path = String(p.path || '')
		const name = path.split(/[\\/]/).pop()
		if (p.success === false) notify('保存失败' + (name ? '：' + name : ''), true)
		else notify('已保存到「下载」' + (name ? '：' + name : ''))
	})
})(typeof window !== 'undefined' ? window : globalThis)
