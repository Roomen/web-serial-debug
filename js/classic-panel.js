;(function (root) {
	'use strict'
	const P = root.AppPlatform, service = P && P.service('classic'), host = document.getElementById('classic-workbench')
	if (!service || !host || !P.has('view.classic')) return
	function el(tag, text) { const e = document.createElement(tag); if (text) e.textContent = text; host.appendChild(e); return e }
	el('h2', '经典蓝牙 SPP')
	el('p', '通过电脑蓝牙搜索与配对。系统窗口内选择设备、输入 PIN 或核对比较码；不会自动确认。只支持提供 Serial Port Profile 的设备。')
	el('p', '系统操作进行中请在系统窗口取消。macOS 原生 SDP / 打开 / 写入等待系统返回期间无法强制中止；关闭未确认会提示失败并阻止升级，请等待后重试。')
	const status = el('p'), error = el('p'); error.setAttribute('role', 'status')
	function button(text, fn) { const b = el('button', text); b.type = 'button'; b.className = 'btn btn-sm btn-outline-secondary'; b.onclick = () => Promise.resolve().then(fn).catch(e => { error.textContent = e.message || String(e) }); return b }
	button('搜索并选择设备…', () => service.run('discover'))
	button('搜索并配对设备…', () => service.run('pair'))
	const select = el('select'); select.setAttribute('aria-label', 'Classic 设备')
	button('连接 SPP', () => service.run('connect', { deviceId: select.value }))
	button('关闭 / 重试释放', () => service.release())
	const hex = el('input'); hex.placeholder = 'TX 十六进制'; hex.setAttribute('aria-label', 'Classic TX HEX')
	button('发送 HEX', () => service.run('write', { generation: service.state().generation, hex: hex.value }))
	const log = el('pre'); log.setAttribute('aria-label', 'Classic RX HEX')
	let cursor = null, generation = null, display = '', scheduled = false
	function paint() {
		scheduled = false
		const s = service.state(); status.textContent = s.phase + ' · RX ' + s.received + ' 字节'; error.textContent = s.error || ''
		const selected = select.value; select.replaceChildren()
		for (const d of service.devices()) { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.name + (d.paired ? ' · 已配对' : ' · 未配对'); select.appendChild(o) }
		if (service.devices().some(d => d.deviceId === selected)) select.value = selected
		if (generation !== s.generation) { generation = s.generation; cursor = null; display = '' }
		let data, budget = 65536
		const parts = []
		do { data = service.read({ cursor }); cursor = data.cursor; parts.push(data.hex); budget -= data.hex.length / 2 } while (data.hasMore && data.hex && budget > 0)
		display = (display + parts.join('')).slice(-32768); log.textContent = display
		if (data.hasMore && !scheduled) { scheduled = true; setTimeout(paint, 0) }
	}
	service.subscribe(paint); paint()
})(window)
