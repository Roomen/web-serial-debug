// Desktop USB bridge workbench. Dynamic text always uses textContent; no raw addresses/passkeys in logs.
;(function (root) {
	'use strict'
	const P = root.AppPlatform
	if (!P || !P.has('view.ble')) return
	const ble = P.service('ble'), host = document.getElementById('ble-workbench')
	if (!ble || !host) return
	function el(tag, text, parent = host) { const e = document.createElement(tag); if (text) e.textContent = text; parent.appendChild(e); return e }
	el('h2', 'USB BLE 桥')
	el('p', '独立 2 Mbps 串口桥 · TX 写外设 / RX 收通知。连接前保持桥口打开并复位桥固件，等待 ready；重开串口不等于 BLE 复位。')
	const status = el('p'), error = el('p'); error.setAttribute('role', 'status')
	function button(parent, title, fn) { const b = el('button', title, parent); b.type = 'button'; b.className = 'btn btn-sm btn-outline-secondary'; b.onclick = () => Promise.resolve().then(fn).catch(e => { error.textContent = e.message || String(e) }); return b }
	const bar = el('div'); bar.className = 'ble-controls'
	const ports = el('select', null, bar); ports.setAttribute('aria-label', '桥串口')
	function fill(select, values, label, key) {
		const selected = select.value; select.replaceChildren()
		for (const value of values) { const opt = el('option', label(value), select); opt.value = value[key] }
		if (values.some(v => v[key] === selected)) select.value = selected
	}
	async function refresh() { fill(ports, await ble.ports(), p => [p.name, p.portName].filter(Boolean).join(' · '), 'deviceId') }
	button(bar, '刷新桥口', refresh)
	button(bar, '打开桥口', () => ble.run('open', { deviceId: ports.value }))
	button(bar, '关闭桥口', () => ble.run('close'))
	button(bar, '扫描', () => ble.run('scan_start'))
	button(bar, '停止扫描', () => ble.run('scan_stop'))
	const columns = el('div'); columns.className = 'ble-columns'
	const left = el('section', null, columns); el('h3', '扫描设备', left)
	el('p', '主机侧筛选已收到的广播 / 扫描响应；名称与 UUID 同时满足。不会按 GATT 发现结果筛选。', left)
	const nameFilter = el('input', null, left); nameFilter.placeholder = '广播名包含（忽略大小写）'; nameFilter.setAttribute('aria-label', '广播名筛选'); nameFilter.maxLength = 128
	const uuidFilter = el('input', null, left); uuidFilter.placeholder = '128-bit 广播服务 UUID'; uuidFilter.setAttribute('aria-label', '广播服务 UUID 筛选'); uuidFilter.maxLength = 36
	button(left, '应用筛选', () => { paintDevices(); error.textContent = '' })
	button(left, '清除筛选', () => { nameFilter.value = uuidFilter.value = ''; paintDevices(); error.textContent = '' })
	const devices = el('select', null, left); devices.size = 12; devices.setAttribute('aria-label', '扫描设备')
	button(left, '连接选中设备', () => ble.run('connect', { deviceId: devices.value }))
	button(left, '断开外设', () => ble.run('disconnect', { generation: ble.state().generation }))
	const right = el('section', null, columns); el('h3', 'GATT（连接后自动发现）', right)
	const gatt = el('select', null, right); gatt.size = 10; gatt.setAttribute('aria-label', 'GATT 特征')
	const params = () => ({ generation: ble.state().generation, characteristicId: gatt.value })
	const controls = el('div', null, right); controls.className = 'ble-controls'
	button(controls, '读取', () => ble.run('read', params()))
	button(controls, '订阅 RX', () => ble.run('subscribe', { ...params(), on: true }))
	button(controls, '取消订阅', () => ble.run('subscribe', { ...params(), on: false }))
	button(controls, '配对', () => ble.run('pair', { generation: ble.state().generation }))
	const hex = el('input', null, right); hex.placeholder = 'TX 十六进制字节（最多 512 字节）'; hex.setAttribute('aria-label', '写入 HEX')
	button(right, '写入（有响应）', () => ble.run('write', { ...params(), hex: hex.value, response: true }))
	button(right, '写入（无响应）', () => ble.run('write', { ...params(), hex: hex.value, response: false }))
	// Pair challenge is local only, intentionally never stored or included in MCP state/logs.
	const pairing = el('div', null, right), pairText = el('span', null, pairing), passkey = el('input', null, pairing)
	passkey.type = 'password'; passkey.autocomplete = 'off'; passkey.placeholder = '配对码'; passkey.setAttribute('aria-label', '配对码')
	button(pairing, '提交输入 / 确认一致', () => { const c = ble.state().challenge; const n = c && c.action === 'confirm' ? 1 : Number(passkey.value); passkey.value = ''; return ble.run('passkey', { generation: ble.state().generation, passkey: n }) })
	button(pairing, '拒绝 / 取消配对', () => { const c = ble.state().challenge; passkey.value = ''; return c && c.action === 'confirm' ? ble.run('passkey', { generation: ble.state().generation, passkey: 0 }) : ble.release() })
	el('h3', '透传 Profile', right)
	const tx = el('select', null, right), rx = el('select', null, right); tx.setAttribute('aria-label', 'TX · 电脑 → 设备（写特征）'); rx.setAttribute('aria-label', 'RX · 设备 → 电脑（通知特征）')
	const mode = el('select', null, right)
	for (const [value, label] of [['true', 'TX 有响应'], ['false', 'TX 无响应']]) { const o = el('option', label, mode); o.value = value }
	const chunk = el('input', null, right); chunk.type = 'number'; chunk.min = '1'; chunk.max = '512'; chunk.value = '20'; chunk.setAttribute('aria-label', '分片字节数')
	button(right, '保存 Profile', () => { localStorage.setItem('bleBridgeProfile', JSON.stringify(ble.profile(tx.value, rx.value, mode.value === 'true', Number(chunk.value)))); error.textContent = '已保存服务/特征结构选择器，不保存句柄或设备地址' })
	button(right, '解析已存 Profile', () => { const p = JSON.parse(localStorage.getItem('bleBridgeProfile') || 'null'); const r = ble.resolveProfile(p); tx.value = r.tx; rx.value = r.rx; mode.value = String(p.response); chunk.value = p.chunkSize; error.textContent = 'Profile 已在本连接唯一匹配' })
	el('p', 'TX（电脑 → 设备）与 RX（设备 → 电脑）可属于不同服务。保存映射后在通信调试中统一收发；属性不代表设备协议的实际用途。', right)
	button(right, '接入通信调试主发路', async () => {
		const sources = P.service('connection-source'), lanes = root.serialLanes, hub = root.SerialHub
		if (!sources || !lanes || !hub) throw new Error('通信调试尚未就绪')
		const profile = ble.profile(tx.value, rx.value, mode.value === 'true', Number(chunk.value))
		localStorage.setItem('bleBridgeProfile', JSON.stringify(profile))
		const port = sources.bridgePort()
		if (!await lanes.selectPort(hub.activeSendPhys(), port, { open: true })) throw new Error('本路正忙或无法接入，请检查通信调试连接状态')
		const nav = document.querySelector('.rail-item[data-view="view-serial"]'); if (nav) nav.click()
	})

	el('h3', '事件与收发数据')
	const log = el('pre'); log.className = 'ble-log'; log.setAttribute('aria-label', 'BLE 日志')
	function paintDevices() {
		try { fill(devices, ble.devices({ name: nameFilter.value, serviceUuid: uuidFilter.value }), d => d.name + ' · ' + d.rssi + ' dBm · ' + (d.connectable ? '可连接' : '不可连接') + ' · 广播 UUID：' + ((d.uuids || []).join(', ') || '未收到'), 'deviceId') }
		catch (e) { devices.replaceChildren(); throw e }
	}
	let scheduled = false
	function paint() {
		scheduled = false
		const s = ble.state(), list = ble.gatt().characteristics
		status.textContent = '桥状态：' + s.phase + ' · 扫描：' + (s.scanning ? '进行中' : '停止') + ' · 固件会话：' + (s.synchronized ? '已同步' : '待复位 ready') + ' · GATT：' + (s.discovery ? '已发现' : '未完成')
		try { paintDevices() } catch (e) { error.textContent = e.message || String(e) }
		const label = c => c.service + ' / ' + c.uuid + ' · 属性 0x' + c.props.toString(16) + ' · ' + c.characteristicId.split(':').pop()
		fill(gatt, list, label, 'characteristicId')
		function candidates(select, values) {
			const selected = select.value; select.replaceChildren()
			const blank = el('option', '请选择 UUID 与所属服务', select); blank.value = ''
			for (const c of values) { const o = el('option', label(c), select); o.value = c.characteristicId }
			if (values.some(c => c.characteristicId === selected)) select.value = selected
			else if (values.length === 1) select.value = values[0].characteristicId
		}
		candidates(tx, list.filter(c => c.props & (mode.value === 'false' ? 4 : 8))); candidates(rx, list.filter(c => c.props & 48))
		pairing.hidden = !s.challenge
		pairText.textContent = s.challenge ? s.challenge.action + (s.challenge.action === 'input' ? '' : ' ' + String(s.challenge.value).padStart(6, '0')) : ''
		const logs = ble.logs(); log.textContent = logs.events.map(e => e.sequence + ' ' + e.kind + (e.data == null ? '' : ' ' + JSON.stringify(e.data))).join('\n') + '\n丢弃事件：' + logs.dropped
	}
	mode.onchange = paint
	ble.subscribe(() => { if (!scheduled) { scheduled = true; setTimeout(paint, 100) } })
	paint(); refresh().catch(() => { error.textContent = '桥口枚举失败，请重试' })
})(window)
