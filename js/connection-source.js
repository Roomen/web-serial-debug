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
	function availableSources() {
		return [['computer-ble', '电脑 BLE', 'computer-ble'], ['classic', '经典蓝牙 SPP', 'classic'], ['bridge', '外置 USB BLE 桥', 'ble']]
			.filter(([, , service]) => P.service(service)).map(([id, label]) => ({ id, label }))
	}
	async function requestPort(kind = 'serial') {
		if (choosing) throw new Error('正在选择连接')
		if (kind === 'serial') return { port: await A.requestPort() }
		if (!availableSources().some(s => s.id === kind)) throw new Error('此设备来源不可用')
		choosing = true
		let result = null, live = true, ownedBle = false, action = null, heldRecord = null, inspecting = false
		const nativeBle = P.service('computer-ble'), classic = P.service('classic')
		try {
			await D.panel({ title: '选择设备 · ' + availableSources().find(s => s.id === kind).label, wide: true, closeText: '取消', build(body, dialog) {
				body.classList.add('connection-source')
				const content = el('div', null, body), error = el('p', null, body); error.setAttribute('role', 'status')
				const retry = el('button', '重试释放未完成的选择', body); retry.type = 'button'; retry.className = 'btn btn-sm btn-outline-danger'; retry.hidden = true
				function showError(e) {
					if (!live) return
					error.textContent = e.message || String(e)
					retry.hidden = !(kind === 'computer-ble' && nativeBle.canRetryRelease())
				}
				async function run(fn, b) {
					if (action || !live) return
					error.textContent = ''; if (b) b.disabled = true
					const job = Promise.resolve().then(fn); action = job
					try { await job } catch (e) { showError(e) }
					finally { if (action === job) action = null; if (b) { b.disabled = false; if (b.afterAction) b.afterAction() } }
				}
				retry.onclick = () => run(async () => { await nativeBle.releasePicker(); ownedBle = false; heldRecord = null; retry.hidden = true; await showBle() }, retry)
				function button(parent, text, fn) {
					const b = el('button', text, parent); b.type = 'button'; b.className = 'btn btn-sm btn-outline-primary'
					b.onclick = () => run(fn, b)
					return b
				}
				function input(parent, label, value) { const l = el('label', label, parent), i = el('input', null, l); i.className = 'form-control form-control-sm'; i.value = value || ''; return i }
				function select(parent, label) { const l = el('label', label, parent), s = el('select', null, l); s.className = 'form-select form-select-sm'; return s }
				function option(s, value, label) { const o = el('option', label, s); o.value = String(value) }
				function done(port, discard) { result = { port, discard }; dialog.close() }
				function showClassic() {
					el('p', '选择提供 SPP 服务的设备；配对与 PIN 确认在系统窗口完成。连接后在通信调试中收发。取消时也请关闭系统选择窗口。改名仅本页面当前 SPP 会话有效，不按名称自动选择设备。', content)
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
				}
				function showBridge() {
					el('p', '使用外置桥当前已连接的设备与已保存 TX/RX 映射。扫描、配对与高级 GATT 设置保留在 BLE 桥页。', content)
					button(content, '使用已连接桥的映射', () => done(bridgePort()))
					button(content, '打开桥配置', () => { result = { navigate: 'view-ble' }; dialog.close() })
				}
				async function showBle() {
					if (!live) return
					if (!ownedBle && !nativeBle.canSelect()) {
						content.replaceChildren()
						throw new Error(nativeBle.canRetryRelease() ? '上次扫描或选择的清理尚未完成，请重试释放后再选择设备' : '请先用本路「断开」关闭现有电脑 BLE 连接')
					}
					ownedBle = true; content.replaceChildren()
					const filters = el('div', null, content); filters.className = 'connection-filters'
					const query = input(filters, '名称 / 广播 UUID / 别名包含')
					const minimum = input(filters, '最低 RSSI（输入正数，如 70 表示 ≥ -70 dBm；可选）'); minimum.type = 'number'; minimum.min = '1'; minimum.max = '127'; minimum.step = '1'
					const rssiThreshold = () => {
						if (minimum.value === '') return ''
						const magnitude = Number(minimum.value)
						if (!Number.isInteger(magnitude) || magnitude < 1 || magnitude > 127) throw new Error('最低 RSSI 请输入 1 到 127 的正数')
						return -magnitude
					}
					const order = select(filters, '排序'); option(order, 'signal', '信号最强'); option(order, 'name', '名称'); option(order, 'recent', '最近发现')
					const state = el('p', null, content); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite')
					const rows = el('div', null, content); rows.className = 'connection-devices'; rows.setAttribute('role', 'group'); rows.setAttribute('aria-label', '扫描设备')
					let selectedId = '', scanning = false, viewAlive = true, scanJob = null
					const rowMap = new Map()
					const controls = el('div', null, content); controls.className = 'connection-actions'
					function paint() {
						if (!live || !viewAlive) return
						let list
						try { list = root.NativeBle.visibleDevices(nativeBle.devices(), query.value, rssiThreshold(), order.value) }
						catch (e) { state.textContent = e.message; connect.disabled = true; return }
						const ids = new Set(list.map(d => d.deviceId))
						for (const [id, row] of rowMap) if (!ids.has(id)) { row.remove(); rowMap.delete(id) }
						list.forEach((d, i) => {
							let row = rowMap.get(d.deviceId)
							if (!row) {
								row = el('button', null, rows); row.type = 'button'; row.className = 'connection-device'
								row.onclick = () => { if (!action && live) { selectedId = d.deviceId; paint() } }
								rowMap.set(d.deviceId, row)
							}
							row.setAttribute('aria-pressed', String(d.deviceId === selectedId))
							row.textContent = (d.alias ? d.alias + ' · ' : '') + d.name + ' · ' + (d.rssi == null ? '信号未知' : d.rssi + ' dBm') + '\n' + (d.services.join(' · ') || '未收到广播服务 UUID')
							if (rows.children[i] !== row) {
								const focused = document.activeElement === row
								rows.insertBefore(row, rows.children[i] || null)
								if (focused) row.focus()
							}
						})
						state.textContent = (scanning ? '持续扫描中' : '扫描已暂停') + ' · 显示 ' + list.length + ' / ' + nativeBle.devices().length + ' 台' + (list.length ? '' : ' · 暂无匹配设备') + (selectedId && !ids.has(selectedId) ? ' · 已选设备被筛选隐藏' : '')
						connect.disabled = !selectedId || !ids.has(selectedId)
						pause.textContent = scanning ? '暂停扫描' : '继续扫描'
					}
					function start() {
						scanning = true
						scanJob = nativeBle.scan(paint)
						scanJob.then(() => { scanning = false; paint() }, e => {
							scanning = false; paint()
							if (viewAlive) showError(e)
						})
					}
					const pause = button(controls, '暂停扫描', async () => {
						if (scanning) { await nativeBle.stopScan(); await scanJob; scanning = false }
						else start()
						paint()
					})
					const connect = button(controls, '连接并发现 TX/RX', async () => {
						const device = nativeBle.devices().find(d => d.deviceId === selectedId)
						if (!device || !root.NativeBle.visibleDevices([device], query.value, rssiThreshold(), order.value).length) throw new Error('请先选择可见设备')
						await nativeBle.stopScan(); if (!live) return
						state.textContent = '连接并发现 GATT…'; inspecting = true
						try { heldRecord = await nativeBle.inspect(device) } finally { inspecting = false }
						if (!live) return
						viewAlive = false; showMapping(heldRecord)
					})
					connect.afterAction = paint
					query.oninput = minimum.oninput = order.onchange = paint
					el('p', '列表持续更新；名称与 UUID 来自广播，UUID 不证明设备用途。别名与映射仅在本页面的当前 BLE 会话中记忆；刷新或取消回收后需重新选择，不自动连接。', content)
					start(); paint()
				}
				function showMapping(record) {
					content.replaceChildren(); el('h3', record.device.name + ' · 收发映射', content)
					const alias = input(content, '设备别名（仅本页面当前 BLE 会话）', nativeBle.preference(record.device.deviceId).alias)
					alias.maxLength = 32
					alias.oninput = () => nativeBle.remember(record.device.deviceId, { alias: alias.value.trim().slice(0, 32) })
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
						const saved = nativeBle.preference(record.device.deviceId).profile
						if (saved) { const ids = root.NativeBle.match(record.chars, saved); mode.value = String(saved.response); paintTx(); tx.value = String(ids.tx); rx.value = String(ids.rx) }
					} catch (e) { error.textContent = e.message || String(e) }
					preview()
					button(content, '确认映射并开始透传', () => {
						const profile = root.NativeBle.mapping(record.chars, tx.value, rx.value, mode.value === 'true')
						nativeBle.remember(record.device.deviceId, { profile, alias: alias.value.trim().slice(0, 32) })
						const selected = nativeBle.createPort(record, profile, Number(tx.value), Number(rx.value))
						done(selected.port, selected.discard)
					})
					el('p', 'RX 订阅成功后才显示已连接。修改映射请断开本路，再从「选择设备 → 电脑 BLE」进入；重连会重新核对 UUID 与属性，重复实例须重选。', content)
					button(content, '返回扫描 / 修改设备', async () => { await nativeBle.close(record); heldRecord = null; await showBle() })
				}
				// Enter the requested picker directly; the device dropdown already chose the source.
				run(kind === 'computer-ble' ? showBle : kind === 'classic' ? showClassic : showBridge)
			} })
			live = false
			if (!result && ownedBle) {
				// In-flight inspection has no handle yet: invalidate and drain it immediately.
				if (inspecting) await nativeBle.releasePicker()
				else { await nativeBle.stopScan(); if (heldRecord) await nativeBle.close(heldRecord) }
			}
			if (action) await action.catch(() => {})
			if (result && result.navigate) { jump(result.navigate); return null }
			return result
		} finally { live = false; choosing = false }
	}
	const api = { requestPort, availableSources, bridgePort, isBusyForUpdate: () => choosing,
		ports: () => {
			pruneBridgePorts()
			return [...(P.service('classic') ? P.service('classic').ports() : []), ...(P.service('computer-ble') ? P.service('computer-ble').ports() : []), ...Array.from(bridgePorts.values(), entry => entry.port)]
		},
	}
	P.provide('connection-source', api)
	A.addPortProvider(() => api.ports())
})(window)
