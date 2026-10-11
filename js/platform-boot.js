// 组装点：所有传输后端注册完(serial-adapter.js 的 web、transport-ble.js 的 web-ble，以及原生壳注入的后端)之后、common.js 之前加载，
// 按 AppPlatform.transports 的优先顺序选定当前串口后端。原生壳(Tauri 等)的后端与平台服务(scanner、file-save、instance 等)
// 也在这之前注册 / provide；页面模块不自己挑后端。没有可用后端时保持 web，页面照旧提示不支持。
;(function () {
	'use strict'
	const P = window.AppPlatform
	const A = window.SerialAdapter
	if (!P || !A) return
	A.pick(P.transports)
})()
