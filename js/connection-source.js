// A connection source supplies a stream port, not a second receive/send screen.
// Availability is provided by AppPlatform services; this module never sniffs native APIs.
;(function (root) {
	'use strict'
	const P = root.AppPlatform, A = root.SerialAdapter, D = root.AppDialog
	if (!P || !A || !D || !P.service('classic') && !P.service('computer-ble')) return
	let choosing = false
	function el(tag, text, parent, cls) {
		const e = document.createElement(tag)
		if (cls) e.className = cls
		if (text != null && text !== '') e.textContent = text
		if (parent) parent.appendChild(e)
		return e
	}
	function formatAge(ms) {
		if (!Number.isFinite(ms) || ms < 2000) return '刚刚'
		const sec = Math.floor(ms / 1000)
		return sec + 's 前'
	}
	function rssiLevel(rssi) {
		if (!Number.isFinite(rssi)) return 'unknown'
		if (rssi >= -60) return 'good'
		if (rssi >= -80) return 'mid'
		return 'weak'
	}
	function availableSources() {
		return [['computer-ble', 'BLE', 'computer-ble'], ['classic', '经典蓝牙 SPP', 'classic']]
			.filter(([, , service]) => P.service(service)).map(([id, label]) => ({ id, label }))
	}
	async function requestPort(kind = 'serial') {
		if (choosing) throw new Error('正在选择连接')
		if (kind === 'serial') return { port: await A.requestPort() }
		if (!availableSources().some(s => s.id === kind)) throw new Error('此设备来源不可用')
		choosing = true
		let result = null, live = true, ownedBle = false, action = null, heldRecord = null, inspecting = false
		let tickTimer = null
		const stopTick = () => { if (tickTimer != null) { clearInterval(tickTimer); tickTimer = null } }
		const nativeBle = P.service('computer-ble'), classic = P.service('classic')
		try {
			await D.panel({ title: '选择设备 · ' + availableSources().find(s => s.id === kind).label, wide: true, closeText: '取消', build(body, dialog) {
				body.classList.add('connection-source')
				const content = el('div', null, body), error = el('p', null, body, 'connection-error'); error.setAttribute('role', 'status')
				const retry = el('button', '重试释放未完成的选择', body, 'btn btn-sm btn-outline-danger'); retry.type = 'button'; retry.hidden = true
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
				function button(parent, text, fn, cls = 'btn btn-sm btn-outline-primary') {
					const b = el('button', text, parent, cls); b.type = 'button'
					b.onclick = () => run(fn, b)
					return b
				}
				function input(parent, label, value) { const l = el('label', label, parent), i = el('input', null, l, 'form-control form-control-sm'); i.value = value || ''; return i }
				function select(parent, label) { const l = el('label', label, parent), s = el('select', null, l, 'form-select form-select-sm'); return s }
				function option(s, value, label) { const o = el('option', label, s); o.value = String(value) }
				function done(port, discard) { stopTick(); result = { port, discard }; dialog.close() }
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
				async function showBle() {
					if (!live) return
					stopTick()
					if (!ownedBle && !nativeBle.canSelect()) {
						content.replaceChildren()
						throw new Error(nativeBle.canRetryRelease() ? '上次扫描或选择的清理尚未完成，请重试释放后再选择设备' : '请先用本路「断开」关闭现有 BLE 连接')
					}
					ownedBle = true; content.replaceChildren()
					const staleMs = (root.NativeBle && root.NativeBle.STALE_MS) || 15000
					const filters = el('div', null, content, 'connection-filters')
					const query = input(filters, '名称 / 广播 UUID / 别名 / 地址包含')
					query.placeholder = '输入名称、别名、地址或 UUID…'
					const minimum = input(filters, '最低 RSSI（输入正数，如 70 表示 ≥ -70 dBm；可选）'); minimum.type = 'number'; minimum.min = '1'; minimum.max = '127'; minimum.step = '1'; minimum.placeholder = '例如 70'
					const rssiThreshold = () => {
						if (minimum.value === '') return ''
						const magnitude = Number(minimum.value)
						if (!Number.isInteger(magnitude) || magnitude < 1 || magnitude > 127) throw new Error('最低 RSSI 请输入 1 到 127 的正数')
						return -magnitude
					}
					const order = select(filters, '排序'); option(order, 'signal', '信号最强'); option(order, 'recent', '最近发现'); option(order, 'name', '名称')
					const statusBar = el('div', null, content, 'connection-status-bar')
					const state = el('p', null, statusBar, 'connection-status'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite')
					const nameAlert = el('div', null, content, 'connection-name-alert'); nameAlert.hidden = true
					const rows = el('div', null, content, 'connection-devices'); rows.setAttribute('role', 'group'); rows.setAttribute('aria-label', '扫描设备')
					let selectedId = '', scanning = false, viewAlive = true, scanJob = null, pausedAt = 0
					let pendingNameConfirm = null
					const rowMap = new Map()
					const controls = el('div', null, content, 'connection-actions')
					const effectiveNow = () => pausedAt || Date.now()
					function hideNameAlert() {
						pendingNameConfirm = null
						nameAlert.hidden = true
						nameAlert.replaceChildren()
					}
					function showNameAlert(device, forceMapping) {
						pendingNameConfirm = { device, forceMapping }
						nameAlert.replaceChildren()
						const label = device.alias ? `「${device.alias}」` : '该已保存设备'
						el('div', `检测到${label}的广播名已变化：原名「${device.savedName}」→ 当前「${device.name}」，是否继续连接并更新广播名？`, nameAlert, 'connection-name-alert-text')
						const btns = el('div', null, nameAlert, 'connection-name-alert-actions')
						const ok = el('button', '继续连接并更新', btns, 'btn btn-sm btn-warning'); ok.type = 'button'
						ok.onclick = () => run(async () => {
							const ctx = pendingNameConfirm
							hideNameAlert()
							if (ctx) await connectSelected(ctx.forceMapping, true)
						}, ok)
						const cancel = el('button', '取消', btns, 'btn btn-sm btn-outline-secondary'); cancel.type = 'button'
						cancel.onclick = () => hideNameAlert()
						nameAlert.hidden = false
					}
					function renderRow(row, d, now) {
						const age = formatAge(now - (d.seen || now))
						const sig = JSON.stringify([d.alias || '', d.name || '', !!d.isSaved, !!d.nameChanged, d.savedName || '', d.rssi ?? null, age, d.seq || 0, d.address || '', d.services || []])
						if (row._sig === sig) return
						row._sig = sig
						row.replaceChildren()
						const head = el('div', null, row, 'connection-device-head')
						const titleWrap = el('div', null, head, 'connection-device-title-wrap')
						el('span', d.alias || d.name, titleWrap, 'connection-device-title')
						if (d.isSaved) el('span', '已保存', titleWrap, 'connection-badge connection-badge-saved')
						if (d.alias && d.name && d.alias !== d.name) el('span', d.name, titleWrap, 'connection-device-orig')
						if (d.nameChanged) el('span', '原名：' + d.savedName, titleWrap, 'connection-badge connection-badge-warn')
						const meta = el('div', null, head, 'connection-device-meta')
						const rssi = el('span', d.rssi == null ? '信号未知' : d.rssi + ' dBm', meta, 'connection-device-rssi')
						rssi.setAttribute('data-level', rssiLevel(d.rssi))
						el('span', age, meta, 'connection-device-age')
						if (d.seq) el('span', '#' + d.seq, meta, 'connection-device-seq')
						const sub = el('div', null, row, 'connection-device-sub')
						if (d.address) el('span', d.address, sub, 'connection-device-addr')
						if (d.services && d.services.length) {
							const shortFn = root.NativeBle && root.NativeBle.shortUuid ? root.NativeBle.shortUuid : (v => v)
							for (const u of d.services) {
								const tag = el('span', shortFn(u), sub, 'connection-device-uuid')
								tag.title = u
							}
						} else {
							el('span', '未收到广播服务 UUID', sub, 'connection-device-empty-uuid')
						}
					}
					function getSelectedDevice(list) {
						return list.find(d => d.deviceId === selectedId) || null
					}
					function paint() {
						if (!live || !viewAlive) return
						const now = effectiveNow()
						const allDevices = nativeBle.devices()
						const activeDevices = root.NativeBle.visibleDevices(allDevices, '', '', order.value, { now, staleMs })
						let list
						try { list = root.NativeBle.visibleDevices(allDevices, query.value, rssiThreshold(), order.value, { now, staleMs }) }
						catch (e) { state.textContent = e.message; connect.disabled = true; configBtn.hidden = true; return }
						const ids = new Set(list.map(d => d.deviceId))
						for (const [id, row] of rowMap) if (!ids.has(id)) { row.remove(); rowMap.delete(id) }
						list.forEach((d, i) => {
							let row = rowMap.get(d.deviceId)
							if (!row) {
								row = el('button', null, rows, 'connection-device'); row.type = 'button'
								row.onclick = () => { if (!action && live) { if (selectedId !== d.deviceId) hideNameAlert(); selectedId = d.deviceId; paint() } }
								row.ondblclick = () => { if (!action && live) { selectedId = d.deviceId; paint(); run(() => connectSelected(false, false), connect) } }
								rowMap.set(d.deviceId, row)
							}
							row.setAttribute('aria-pressed', String(d.deviceId === selectedId))
							renderRow(row, d, now)
							if (rows.children[i] !== row) {
								const focused = document.activeElement === row
								rows.insertBefore(row, rows.children[i] || null)
								if (focused) row.focus()
							}
						})
						const chosen = getSelectedDevice(list)
						const hiddenSelected = selectedId && !ids.has(selectedId)
						state.textContent = (scanning ? '持续扫描中' : '扫描已暂停') + ' · 显示 ' + list.length + ' / ' + activeDevices.length + ' 台活跃设备' + (list.length ? '' : ' · 暂无匹配设备') + (hiddenSelected ? ' · 已选设备已隐藏或离线' : '')
						connect.disabled = !chosen
						const canQuick = !!(chosen && chosen.isSaved && chosen.savedProfile)
						connect.textContent = canQuick ? '快速连接' : '连接并发现 TX/RX'
						configBtn.hidden = !canQuick
						configBtn.disabled = !chosen
						pause.textContent = scanning ? '暂停扫描' : '继续扫描'
					}
					rows.onkeydown = e => {
						if (!e || action || !live) return
						const items = Array.from(rows.children || [])
						if (!items.length) return
						if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
							e.preventDefault && e.preventDefault()
							const idx = items.findIndex(r => r.getAttribute && r.getAttribute('aria-pressed') === 'true')
							const next = e.key === 'ArrowDown' ? (idx < 0 ? 0 : Math.min(items.length - 1, idx + 1)) : (idx <= 0 ? 0 : idx - 1)
							items[next].onclick && items[next].onclick()
							items[next].focus && items[next].focus()
						} else if (e.key === 'Enter' && selectedId) {
							e.preventDefault && e.preventDefault()
							run(() => connectSelected(false, false), connect)
						}
					}
					function start() {
						pausedAt = 0
						scanning = true
						stopTick()
						if (typeof setInterval === 'function') tickTimer = setInterval(() => { if (live && viewAlive && scanning) paint() }, 1000)
						scanJob = nativeBle.scan(paint)
						scanJob.then(() => { scanning = false; stopTick(); paint() }, e => {
							scanning = false; stopTick(); paint()
							if (viewAlive) showError(e)
						})
					}
					async function connectSelected(forceMapping, confirmedNameChange) {
						const now = effectiveNow()
						const device = nativeBle.devices().find(d => d.deviceId === selectedId)
						if (!device || !root.NativeBle.visibleDevices([device], query.value, rssiThreshold(), order.value, { now, staleMs }).length) throw new Error('请先选择可见设备')
						if (device.isSaved && device.nameChanged && !confirmedNameChange) {
							showNameAlert(device, forceMapping)
							return
						}
						hideNameAlert()
						await nativeBle.stopScan(); if (!live) return
						stopTick()
						state.textContent = '连接并发现 GATT…'; inspecting = true
						try { heldRecord = await nativeBle.inspect(device) } finally { inspecting = false }
						if (!live) return
						if (!forceMapping && device.isSaved && device.savedProfile) {
							try {
								const ids = root.NativeBle.match(heldRecord.chars, device.savedProfile)
								if (nativeBle.saveDevice) nativeBle.saveDevice(device, { profile: device.savedProfile, alias: device.alias, broadcastName: device.name })
								const selected = nativeBle.createPort(heldRecord, device.savedProfile, ids.tx, ids.rx)
								viewAlive = false
								done(selected.port, selected.discard)
								return
							} catch (e) {
								// Saved mapping no longer uniquely matches: fall back to mapping UI.
								error.textContent = (e.message || String(e)) + '，请重新确认收发映射'
							}
						}
						viewAlive = false; showMapping(heldRecord)
					}
					const connect = button(controls, '连接并发现 TX/RX', () => connectSelected(false, false), 'btn btn-sm btn-primary')
					const configBtn = button(controls, '配置映射', () => connectSelected(true, false), 'btn btn-sm btn-outline-primary')
					configBtn.hidden = true
					const pause = button(controls, '暂停扫描', async () => {
						if (scanning) { pausedAt = Date.now(); stopTick(); await nativeBle.stopScan(); await scanJob; scanning = false }
						else start()
						paint()
					}, 'btn btn-sm btn-outline-secondary')
					button(controls, '清空列表', async () => {
						hideNameAlert()
						selectedId = ''
						for (const row of rowMap.values()) row.remove()
						rowMap.clear()
						if (nativeBle.clearDevices) nativeBle.clearDevices()
						if (!scanning) start()
						else pausedAt = 0
						paint()
					}, 'btn btn-sm btn-outline-secondary')
					connect.afterAction = paint
					query.oninput = minimum.oninput = order.onchange = paint
					el('p', '列表持续更新，超过 15 秒未收到广播的设备自动隐藏；支持双击设备快速连接。保存映射后可在设备下拉列表中直接点击连接。', content, 'connection-hint')
					start(); paint()
				}
				function showMapping(record) {
					stopTick()
					content.replaceChildren()
					const header = el('div', null, content, 'connection-mapping-head')
					el('h3', record.device.name + ' · 收发映射', header)
					if (record.device.address) el('span', record.device.address, header, 'connection-device-addr')
					const hasPersistent = !!record.device.persistentId
					const pref = nativeBle.preference(record.device.deviceId)
					const aliasLabel = hasPersistent ? '设备别名（保存到本机，下次可直接连接）' : '设备别名（仅本页面当前 BLE 会话）'
					const alias = input(content, aliasLabel, pref.alias)
					alias.maxLength = 32
					alias.placeholder = '例如：1号测试水表'
					alias.oninput = () => nativeBle.remember(record.device.deviceId, { alias: alias.value.trim().slice(0, 32) })
					el('p', 'TX 是电脑 → 设备，RX 是设备 → 电脑，可来自不同服务。属性只能确认支持的操作，请按设备协议核对实际用途。', content)
					const mode = select(content, 'TX 写入模式'); option(mode, 'true', '有响应（write）'); option(mode, 'false', '无响应（writeWithoutResponse）')
					const tx = select(content, 'TX · 电脑 → 设备'), rx = select(content, 'RX · 设备 → 电脑')
					const shortFn = root.NativeBle && root.NativeBle.shortUuid ? root.NativeBle.shortUuid : (v => v)
					const label = c => shortFn(c.characteristic) + ' (' + c.characteristic + ') ｜ 服务 ' + shortFn(c.service) + ' (' + c.service + ') ｜ ' + [[8, 'write'], [4, 'writeWithoutResponse'], [16, 'notify'], [32, 'indicate']].filter(([bit]) => c.props & bit).map(([, l]) => l).join(' / ') + ' ｜ 实例 ' + (c.id + 1)
					function fill(s, list) { const old = s.value; s.replaceChildren(); option(s, '', '请选择完整 UUID 与所属服务'); for (const c of list) option(s, c.id, label(c)); if (list.some(c => String(c.id) === old)) s.value = old; else if (list.length === 1) s.value = String(list[0].id) }
					function paintTx() { fill(tx, record.chars.filter(c => c.props & (mode.value === 'true' ? 8 : 4))) }
					paintTx(); fill(rx, record.chars.filter(c => c.props & 48))
					const autoHint = el('p', null, content, 'connection-auto-hint'); autoHint.hidden = true
					const summary = el('pre', null, content, 'connection-mapping')
					function preview() { summary.textContent = 'TX: ' + (tx.selectedOptions[0] && tx.selectedOptions[0].textContent || '未选择') + '\nRX: ' + (rx.selectedOptions[0] && rx.selectedOptions[0].textContent || '未选择') }
					mode.onchange = () => { paintTx(); preview() }; tx.onchange = rx.onchange = preview
					let appliedSaved = false
					try {
						const saved = pref.profile
						if (saved) {
							const ids = root.NativeBle.match(record.chars, saved)
							mode.value = String(saved.response); paintTx(); tx.value = String(ids.tx); rx.value = String(ids.rx)
							appliedSaved = true
						}
					} catch (e) { error.textContent = e.message || String(e) }
					if (!appliedSaved && root.NativeBle && typeof root.NativeBle.defaultMapping === 'function') {
						const def = root.NativeBle.defaultMapping(record.chars)
						if (def) {
							mode.value = String(def.response); paintTx(); tx.value = String(def.txId); rx.value = String(def.rxId)
							autoHint.textContent = '已自动匹配 FFE1 (RX) / FFE2 (TX) 收发特征，可直接确认开始透传。'
							autoHint.hidden = false
						}
					}
					preview()
					const actions = el('div', null, content, 'connection-actions')
					button(actions, '确认映射并开始透传', () => {
						const profile = root.NativeBle.mapping(record.chars, tx.value, rx.value, mode.value === 'true')
						const trimmedAlias = alias.value.trim().slice(0, 32)
						if (hasPersistent && nativeBle.saveDevice) nativeBle.saveDevice(record.device, { profile, alias: trimmedAlias, broadcastName: record.device.name })
						else nativeBle.remember(record.device.deviceId, { profile, alias: trimmedAlias })
						const selected = nativeBle.createPort(record, profile, Number(tx.value), Number(rx.value))
						done(selected.port, selected.discard)
					}, 'btn btn-sm btn-primary')
					button(actions, '返回扫描 / 修改设备', async () => { await nativeBle.close(record); heldRecord = null; await showBle() }, 'btn btn-sm btn-outline-secondary')
					if (hasPersistent && nativeBle.savedDevice && nativeBle.savedDevice(record.device.persistentId)) {
						button(actions, '移除本机保存记录', () => {
							nativeBle.removeSavedDevice(record.device.persistentId)
							alias.value = ''
							autoHint.textContent = '已从本机移除保存记录。'
							autoHint.hidden = false
						}, 'btn btn-sm btn-outline-danger')
					}
					el('p', 'RX 订阅成功后才显示已连接。修改映射请断开本路，再从「选择设备 → BLE」进入；重连会重新核对 UUID 与属性，重复实例须重选。', content, 'connection-hint')
				}
				// Enter the requested picker directly; the device dropdown already chose the source.
				run(kind === 'computer-ble' ? showBle : showClassic)
			} })
			live = false
			stopTick()
			if (!result && ownedBle) {
				// In-flight inspection has no handle yet: invalidate and drain it immediately.
				if (inspecting) await nativeBle.releasePicker()
				else { await nativeBle.stopScan(); if (heldRecord) await nativeBle.close(heldRecord) }
			}
			if (action) await action.catch(() => {})
			return result
		} finally { live = false; stopTick(); choosing = false }
	}
	const api = { requestPort, availableSources, isBusyForUpdate: () => choosing,
		ports: () => {
			return [...(P.service('classic') ? P.service('classic').ports() : []), ...(P.service('computer-ble') ? P.service('computer-ble').ports() : [])]
		},
	}
	P.provide('connection-source', api)
	A.addPortProvider(() => api.ports())
})(window)
