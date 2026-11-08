// A connection source supplies a stream port, not a second receive/send screen.
// Availability is provided by AppPlatform services; this module never sniffs native APIs.
;(function (root) {
	'use strict'
	const P = root.AppPlatform, A = root.SerialAdapter, D = root.AppDialog
	if (!P || !A || !D || !P.service('classic') && !P.service('computer-ble') && !P.service('ble')) return
	let choosing = false
	const bridgePorts = new Map()
	let latestBridgeKey = null
	function pruneBridgePorts() {
		const bridge = P.service('ble'), generation = bridge && bridge.state().generation
		const bound = root.SerialHub ? ['S', 'A', 'B'].map(sid => root.SerialHub.getPort(sid)) : []
		for (const [key, entry] of bridgePorts) {
			// Keep the latest choice (including failed binding retries) and current lane mappings.
			// Removing an enumeration entry never closes a port owned by a lane.
			if (entry.bridge !== bridge || entry.generation !== generation || key !== latestBridgeKey && !bound.includes(entry.port)) bridgePorts.delete(key)
		}
	}
	function el(tag, text, parent) { const e = document.createElement(tag); if (text) e.textContent = text; parent.appendChild(e); return e }
	function jump(view) { const b = document.querySelector('.rail-item[data-view="' + view + '"]'); if (b) b.click() }
	function bridgePort() {
		const bridge = P.service('ble'), profile = JSON.parse(localStorage.getItem('bleBridgeProfile') || 'null')
		const resolved = bridge.resolveProfile(profile)
		const key = JSON.stringify([resolved.generation, resolved.tx, resolved.rx, profile.response, profile.chunkSize])
		let entry = bridgePorts.get(key)
		if (!entry || entry.bridge !== bridge) {
			entry = { port: bridge.createProfilePort(profile), bridge, generation: resolved.generation }
			bridgePorts.set(key, entry)
		}
		latestBridgeKey = key
		pruneBridgePorts()
		const port = entry.port
		return port
	}
	async function requestPort() {
		if (choosing) throw new Error('正在选择连接')
		choosing = true
		let result = null, live = true, ownedBle = false, action = null
		const nativeBle = P.service('computer-ble'), classic = P.service('classic')
		try {
			await D.panel({ title: '选择通信连接', wide: true, closeText: '取消', build(body, dialog) {
				body.classList.add('connection-source')
				const sources = el('div', null, body); sources.className = 'connection-sources'
				const content = el('div', null, body), error = el('p', null, body); error.setAttribute('role', 'status')
				function button(parent, text, fn) {
					const b = el('button', text, parent); b.type = 'button'; b.className = 'btn btn-sm btn-outline-primary'
					b.onclick = async () => {
						if (action) return
						error.textContent = ''; b.disabled = true
						const job = Promise.resolve().then(fn); action = job
						try { await job } catch (e) { if (live) error.textContent = e.message || String(e) }
						finally { if (action === job) action = null; b.disabled = false }
					}
					return b
				}
				function input(parent, label, value) { const l = el('label', label, parent), i = el('input', null, l); i.className = 'form-control form-control-sm'; i.value = value || ''; return i }
				function select(parent, label) { const l = el('label', label, parent), s = el('select', null, l); s.className = 'form-select form-select-sm'; return s }
				function option(s, value, label) { const o = el('option', label, s); o.value = String(value) }
				function done(port, discard) { result = { port, discard }; dialog.close() }
				async function leaveBle() { if (ownedBle) { await nativeBle.release(); ownedBle = false } }
				button(sources, '普通串口', async () => { await leaveBle(); const port = await A.requestPort(); if (live) done(port) })
				if (classic) button(sources, '经典蓝牙 SPP', async () => {
					await leaveBle(); content.replaceChildren()
					el('p', '选择提供 SPP 服务的设备；配对与 PIN 确认在系统窗口完成。连接后在通信调试中收发。取消时也请关闭系统选择窗口。', content)
					button(content, '选择已配对设备…', async () => {
						const found = await classic.run('discover'); if (!live) return
						const d = found.devices.find(d => d.deviceId === found.selectedDeviceId)
						if (!d || !d.paired) throw new Error('请先使用系统配对，再选择设备')
						done(classic.createPort(d.deviceId))
					})
					button(content, '搜索并配对…', async () => {
						const found = await classic.run('pair'); if (!live) return
						const d = found.devices.find(d => d.deviceId === found.selectedDeviceId)
						if (!d || !d.paired) throw new Error('系统尚未确认配对')
						done(classic.createPort(d.deviceId))
					})
				})
				if (P.service('ble')) button(sources, '外置 USB BLE 桥', async () => {
					await leaveBle(); content.replaceChildren()
					el('p', '使用外置桥当前已连接的设备与已保存 TX/RX 映射。扫描、配对与高级 GATT 设置保留在 BLE 桥页。', content)
					button(content, '使用已连接桥的映射', () => done(bridgePort()))
					button(content, '打开桥配置', () => { result = { navigate: 'view-ble' }; dialog.close() })
				})
				if (nativeBle) button(sources, '电脑 BLE', async () => {
					if (!ownedBle && !nativeBle.canSelect()) throw new Error('请先断开现有电脑 BLE 连接；关闭失败时可重试释放')
					if (ownedBle) await nativeBle.release()
					ownedBle = true; content.replaceChildren()
					const name = input(content, '广播名包含（主要查找方式）')
					const service = input(content, '广播服务 UUID（可选，完整 128-bit）')
					el('p', '筛选扫描收到的广播名与服务 UUID，两项同时满足；UUID 不代表唯一设备。', content)
					const devices = select(content, '扫描设备'), state = el('p', null, content)
					let list = []
					function fill() {
						const selected = devices.value; devices.replaceChildren(); option(devices, '', '请选择设备')
						for (const d of root.NativeBle.filterDevices(list, name.value, service.value.trim())) option(devices, d.deviceId, d.name + (d.rssi == null ? '' : ' · ' + d.rssi + ' dBm'))
						devices.value = selected
					}
					button(content, '扫描 5 秒', async () => { state.textContent = '扫描中…'; try { list = await nativeBle.scan(); if (!live) return; fill(); state.textContent = '扫描结束，共 ' + list.length + ' 台；请选择目标设备' } catch (e) { state.textContent = '扫描或筛选未完成，请检查提示后重试'; throw e } })
					button(content, '应用筛选', fill)
					button(content, '连接并发现 TX/RX', async () => {
						const device = list.find(d => d.deviceId === devices.value)
						if (!device) throw new Error('请先扫描并选择设备')
						state.textContent = '连接并发现 GATT…'
						const record = await nativeBle.inspect(device)
						if (!live) return
						showMapping(record)
					})
				})
				function showMapping(record) {
					content.replaceChildren(); el('h3', record.device.name + ' · 收发映射', content)
					el('p', 'TX 是电脑 → 设备，RX 是设备 → 电脑，可来自不同服务。属性只能确认支持的操作，请按设备协议核对实际用途。', content)
					const mode = select(content, 'TX 写入模式'); option(mode, 'true', '有响应（write）'); option(mode, 'false', '无响应（writeWithoutResponse）')
					const tx = select(content, 'TX · 电脑 → 设备'), rx = select(content, 'RX · 设备 → 电脑')
					const label = c => c.characteristic + ' ｜ 服务 ' + c.service + ' ｜ ' + [[8, 'write'], [4, 'writeWithoutResponse'], [16, 'notify'], [32, 'indicate']].filter(([bit]) => c.props & bit).map(([, label]) => label).join(' / ') + ' ｜ 实例 ' + (c.id + 1)
					function fill(s, list) { const old = s.value; s.replaceChildren(); option(s, '', '请选择完整 UUID 与所属服务'); for (const c of list) option(s, c.id, label(c)); if (list.some(c => String(c.id) === old)) s.value = old; else if (list.length === 1) s.value = String(list[0].id) }
					function paintTx() { fill(tx, record.chars.filter(c => c.props & (mode.value === 'true' ? 8 : 4))) }
					paintTx(); fill(rx, record.chars.filter(c => c.props & 48))
					const summary = el('pre', null, content); summary.className = 'connection-mapping'
					function preview() { summary.textContent = 'TX: ' + (tx.selectedOptions[0] && tx.selectedOptions[0].textContent || '未选择') + '\nRX: ' + (rx.selectedOptions[0] && rx.selectedOptions[0].textContent || '未选择') }
					mode.onchange = () => { paintTx(); preview() }; tx.onchange = rx.onchange = preview
					try {
						const saved = JSON.parse(localStorage.getItem('computerBleProfile') || 'null')
						if (saved) { const ids = root.NativeBle.match(record.chars, saved); mode.value = String(saved.response); paintTx(); tx.value = String(ids.tx); rx.value = String(ids.rx) }
					} catch (e) { error.textContent = e.message || String(e) }
					preview()
					button(content, '确认映射并开始透传', () => {
						const profile = root.NativeBle.mapping(record.chars, tx.value, rx.value, mode.value === 'true')
						localStorage.setItem('computerBleProfile', JSON.stringify(profile))
						const selected = nativeBle.createPort(record, profile, Number(tx.value), Number(rx.value))
						done(selected.port, selected.discard)
					})
					el('p', 'RX 订阅成功后才显示已连接。修改映射请断开本路，再从「选择连接来源」进入；重连会重新核对 UUID 与属性，重复实例须重选。', content)
					button(content, '返回扫描 / 修改设备', async () => { await nativeBle.close(record); content.replaceChildren(); el('p', '已断开，可点击上方「电脑 BLE」重新扫描。', content) })
				}
				if (nativeBle) button(sources, '重试释放电脑 BLE', async () => { if (root.serialApi && root.serialApi.isPinned()) throw new Error('通信事务进行中，请先停止事务')
					await nativeBle.release(); ownedBle = false; content.replaceChildren(); el('p', '已释放，可重新选择连接。', content) })
			} })
			live = false
			if (!result && ownedBle) await nativeBle.release()
			if (action) await action.catch(() => {})
			if (result && result.navigate) { jump(result.navigate); return null }
			return result
		} finally { live = false; choosing = false }
	}
	const api = { requestPort, bridgePort, isBusyForUpdate: () => choosing,
		ports: () => {
			pruneBridgePorts()
			return [...(P.service('classic') ? P.service('classic').ports() : []), ...(P.service('computer-ble') ? P.service('computer-ble').ports() : []), ...Array.from(bridgePorts.values(), entry => entry.port)]
		},
	}
	P.provide('connection-source', api)
	A.addPortProvider(() => api.ports())
})(window)
