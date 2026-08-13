// SEK 协议批量参数配置写入 + 回读确认
// 用户从 window.SK_DOWN_PRESETS (0x01 且带 param 的预设) 自建配置清单, 按顺序逐条下发,
// 全部发完后按 tag 整包查询回读比对。自成一体, 不依赖 random-rw-test.js 内部实现,
// 仅用 window.sekTx / window.serialApi / window.SK_DOWN_PRESETS 公开数据
;(function () {
	'use strict'

	const IR_IDLE_MS = 20000
	const IR_KEEPALIVE_TIMEOUT = 4000
	const DEFAULT_TIMEOUT_MS = 5000
	const DEFAULT_GAP_MS = 200
	const STATE_KEY = 'sk-batch-state'

	// tag → 整包查询 queryId 映射; 不在表内的 tag 跳过回读, 仅凭写应答判断
	const TAG_QUERY_ID = {
		1: 1, 2: 2, 3: 3, 4: 4,
		30: 30, 31: 31, 32: 10, 33: 11, 34: 13, 35: 35, 36: 15, 37: 18, 38: 22
	}

	const SUPPORTED_TYPES = { bcd: 1, ascii: 1, uint8: 1, uint16le: 1, uint32le: 1, enum: 1 }

	// ---------- 编码 ----------
	// digitStr: 纯数字字符串; len: 目标字节数
	// 奇数位前补0, 从末尾每两位一字节(低位在前=小端), 不足 len 用 0x00 补齐
	// 若数字位数超过 len*2 则报错(不做截断)
	function bcdLeBytes(digitStr, len) {
		let digits = String(digitStr).replace(/\D/g, '')
		if (digits === '') digits = '0'
		if (digits.length % 2 !== 0) digits = '0' + digits
		const bytes = []
		for (let i = digits.length - 2; i >= 0; i -= 2) {
			const hi = digits.charCodeAt(i) - 48
			const lo = digits.charCodeAt(i + 1) - 48
			bytes.push(((hi & 0xf) << 4) | (lo & 0xf))
		}
		if (bytes.length > len) {
			throw new Error('数值 ' + digitStr + ' 超出字段长度上限(' + len + ' 字节)')
		}
		while (bytes.length < len) bytes.push(0x00)
		return bytes
	}

	// 起始值(纯数字字符串) + k*step 的大数累加, 返回十进制字符串; step=0 表示固定不累加
	function addBig(startDigits, k, step) {
		if (!step) return startDigits
		return (BigInt(startDigits) + BigInt(k) * BigInt(step)).toString()
	}

	// ASCII: 逐字符 charCodeAt, 不足 fillLen 补 0x00, 超长截断
	function asciiToBytes(s, fillLen) {
		s = s == null ? '' : String(s)
		const bytes = []
		const n = fillLen != null ? Math.min(s.length, fillLen) : s.length
		for (let i = 0; i < n; i++) bytes.push(s.charCodeAt(i) & 0xff)
		if (fillLen != null) {
			while (bytes.length < fillLen) bytes.push(0x00)
		}
		return bytes
	}

	function numToBytesLE(val, type) {
		switch (type) {
			case 'uint32le': return [val & 0xff, (val >>> 8) & 0xff, (val >>> 16) & 0xff, (val >>> 24) & 0xff]
			case 'uint16le': return [val & 0xff, (val >>> 8) & 0xff]
			case 'uint8': return [val & 0xff]
			default: return []
		}
	}

	function hexOf(arr) {
		return (arr || []).map(function (b) {
			return ('0' + (b & 0xff).toString(16).toUpperCase()).slice(-2)
		}).join(' ')
	}

	function sleep(ms) {
		return new Promise(function (r) { setTimeout(r, ms) })
	}

	// ---------- 预设索引 ----------
	let PRESET_BY_NAME = {}
	let PRESET_GROUPS = []

	function buildPresetIndex() {
		PRESET_BY_NAME = {}
		PRESET_GROUPS = []
		const groups = window.SK_DOWN_PRESETS || []
		groups.forEach(function (g) {
			const filtered = (g.items || []).filter(function (it) {
				return it.func === '0x01' && it.param && SUPPORTED_TYPES[it.param.type] && it.tlv && it.tlv[0] && it.tlv[0].items && it.tlv[0].items[0]
			})
			if (filtered.length) PRESET_GROUPS.push({ group: g.group, items: filtered })
			filtered.forEach(function (it) { PRESET_BY_NAME[it.name] = it })
		})
	}

	function computeEntryBytes(entry, preset, k) {
		const param = preset.param
		const type = param.type
		const name = preset.name
		if (type === 'bcd') {
			const raw = (entry.value || '').trim()
			if (!/^[0-9]+$/.test(raw)) throw new Error(name + ' 起始值须为纯数字')
			const len = param.fillLen || 8
			if (raw.length > len * 2) throw new Error(name + ' 起始值超出字段长度上限(' + (len * 2) + ' 位十进制)')
			const step = parseInt(entry.step, 10)
			const stepVal = isNaN(step) ? 0 : step
			if (stepVal < 0) throw new Error(name + ' 步进须为不小于0的整数')
			const digitsStr = addBig(raw, k, stepVal)
			return bcdLeBytes(digitsStr, len)
		}
		if (type === 'ascii') {
			return asciiToBytes(entry.value || '', param.fillLen)
		}
		if (type === 'enum') {
			const key = entry.value
			if (key == null || key === '') throw new Error(name + ' 请选择枚举值')
			const val = parseInt(key, 10)
			if (isNaN(val)) throw new Error(name + ' 枚举值非法')
			return numToBytesLE(val & 0xff, 'uint8')
		}
		if (type === 'uint8' || type === 'uint16le' || type === 'uint32le') {
			const val = parseInt(entry.value, 10)
			if (isNaN(val) || val < 0) throw new Error(name + ' 数值须为不小于0的整数')
			const max = type === 'uint8' ? 0xff : (type === 'uint16le' ? 0xffff : 0xffffffff)
			if (val > max) throw new Error(name + ' 数值超出范围(最大 ' + max + ')')
			return numToBytesLE(val, type)
		}
		throw new Error(name + ' 不支持的参数类型: ' + type)
	}

	// ---------- DOM ----------
	const el = {}
	let list = [] // [{ presetName, value, step, enabled }]
	let running = false
	let stopFlag = false
	let lastCommAt = 0
	let keepingAlive = false
	let current = 0 // 下一台起始索引

	function $(id) { return document.getElementById(id) }

	function setStatus(text, cls) {
		if (!el.status) return
		el.status.textContent = text
		el.status.className = 'sk-rw-status' + (cls ? ' ' + cls : '')
	}

	function setProgressText(text) {
		if (!el.progress) return
		el.progress.style.width = '100%'
		el.progress.textContent = text
	}

	function logLine(msg, level) {
		if (!el.log) return
		const div = document.createElement('div')
		div.className = 'sk-rw-log-line sk-rw-' + (level || 'info')
		const t = new Date()
		const ts = [t.getHours(), t.getMinutes(), t.getSeconds()].map(function (n) {
			return ('0' + n).slice(-2)
		}).join(':')
		div.textContent = '[' + ts + '] ' + msg
		el.log.appendChild(div)
		el.log.scrollTop = el.log.scrollHeight
	}

	function clearLog() {
		if (el.log) el.log.innerHTML = ''
		if (el.summary) {
			el.summary.textContent = ''
			el.summary.className = 'sk-rw-summary'
		}
	}

	// ---------- 事务 ----------
	function assertRunning() {
		if (stopFlag) throw new Error('已停止')
		if (!window.serialApi || !window.serialApi.isOpen()) throw new Error('串口未打开')
		if (!window.sekTx) throw new Error('sekTx 未加载')
	}

	async function keepAliveIfNeeded() {
		if (stopFlag) throw new Error('已停止')
		if (!window.serialApi || !window.serialApi.isOpen()) throw new Error('串口未打开')
		if (keepingAlive) return
		if (Date.now() - lastCommAt < IR_IDLE_MS) return

		keepingAlive = true
		logLine('距上次通信已 ' + Math.round((Date.now() - lastCommAt) / 1000) +
			's, 发送保活查询(阈值' + (IR_IDLE_MS / 1000) + 's)', 'info')
		try {
			await window.sekTx.sendAndWait({
				buildOpts: { funcCode: '0x03', tlv: [{ tag: 10, items: [{ id: 1, value: [] }] }] },
				expectFunc: 0x83,
				timeoutMs: IR_KEEPALIVE_TIMEOUT
			})
			lastCommAt = Date.now()
			logLine('保活成功', 'info')
		} catch (e) {
			const err = new Error('保活失败, 已中止: ' + (e.message || e))
			err.fatal = true
			throw err
		} finally {
			keepingAlive = false
		}
	}

	// ---------- 单台写入 + 回读确认 ----------
	async function writeOne(k) {
		assertRunning()
		if (!list.length) throw new Error('清单为空, 请先添加配置项')

		const timeoutMs = Math.max(1000, parseInt(el.timeout.value, 10) || DEFAULT_TIMEOUT_MS)
		const gapMs = Math.max(0, parseInt(el.gap.value, 10) || 0)
		const continueOnFail = !!el.continueOnFail.checked

		// 先整体计算好本台各项字节, 编码/校验错误直接中止(不发送任何指令)
		const plan = list.map(function (entry) {
			const preset = PRESET_BY_NAME[entry.presetName]
			if (!preset) throw new Error('未知预设: ' + entry.presetName + ', 请删除该行后重试')
			const tag = preset.tlv[0].tag
			const id = preset.tlv[0].items[0].id
			const bytes = computeEntryBytes(entry, preset, k)
			return { name: preset.name, tag: tag, id: id, bytes: bytes }
		})

		const writeResults = []
		let aborted = false
		for (let i = 0; i < plan.length; i++) {
			if (aborted) {
				writeResults.push({ ok: false, tag11: null, error: '未尝试(前序失败已中止)', attempted: false })
				continue
			}
			if (stopFlag) throw new Error('已停止')
			await keepAliveIfNeeded()
			const item = plan[i]
			let tag11 = null
			let ok = false
			let err = null
			try {
				const res = await window.sekTx.sendAndWait({
					buildOpts: {
						funcCode: '0x01',
						tlv: [{ tag: item.tag, items: [{ id: item.id, value: item.bytes }] }]
					},
					expectFunc: 0x81,
					timeoutMs: timeoutMs
				})
				lastCommAt = Date.now()
				tag11 = res.tag11
				ok = (tag11 === 1)
			} catch (e) {
				err = e.message || String(e)
				ok = false
			}
			writeResults.push({ ok: ok, tag11: tag11, error: err, attempted: true })
			if (!ok && !continueOnFail) aborted = true
			if (gapMs > 0) await sleep(gapMs)
		}

		// 回读: 对涉及到的 tag 分别整包查询(去重), 不在映射表内的 tag 跳过回读
		const neededTagsSet = {}
		plan.forEach(function (p) { if (TAG_QUERY_ID[p.tag] != null) neededTagsSet[p.tag] = true })
		const neededTags = Object.keys(neededTagsSet).map(Number)
		const frames = {}
		for (let i = 0; i < neededTags.length; i++) {
			const tag = neededTags[i]
			try {
				if (stopFlag) throw new Error('已停止')
				await keepAliveIfNeeded()
				const qid = TAG_QUERY_ID[tag]
				const res = await window.sekTx.sendAndWait({
					buildOpts: { funcCode: '0x03', tlv: [{ tag: 10, items: [{ id: qid, value: [] }] }] },
					expectFunc: 0x83,
					timeoutMs: timeoutMs
				})
				lastCommAt = Date.now()
				frames[tag] = res.frame
			} catch (e) {
				frames[tag] = null
			}
		}

		const rows = plan.map(function (p, idx) {
			const wr = writeResults[idx]
			let readBytes = null
			let readOk = false
			let skippedRead = false
			if (TAG_QUERY_ID[p.tag] == null) {
				skippedRead = true
				readOk = !!wr.ok
			} else {
				const frame = frames[p.tag]
				if (frame) {
					const it = window.sekTx.findTlvItem(frame, p.tag, p.id)
					readBytes = (it && it.raw) ? it.raw.slice() : null
					readOk = !!(wr.ok && readBytes && window.sekTx.bytesEqual(readBytes, p.bytes))
				}
			}
			return {
				name: p.name, bytes: p.bytes,
				writeOk: wr.ok, tag11: wr.tag11, writeError: wr.error, attempted: wr.attempted,
				readBytes: readBytes, readOk: readOk, skippedRead: skippedRead
			}
		})

		const pass = rows.every(function (r) { return r.readOk })
		return { k: k, pass: pass, rows: rows }
	}

	// ---------- 展示 ----------
	function renderResult(result) {
		logLine('── 第 ' + (result.k + 1) + ' 台 ' + (result.pass ? 'PASS' : 'FAIL') + ' ──',
			result.pass ? 'pass' : 'fail')
		result.rows.forEach(function (r) {
			const wHex = hexOf(r.bytes)
			const rHex = r.skippedRead ? '(跳过回读)' : (r.readBytes ? hexOf(r.readBytes) : '(无)')
			const mark = r.readOk ? '✔' : '✘'
			let line = r.name + ': 写=' + wHex + ' 读=' + rHex + ' ' + mark
			if (!r.writeOk) {
				line += r.attempted
					? ' [写失败 tag11=' + r.tag11 + (r.writeError ? (' ' + r.writeError) : '') + ']'
					: ' [' + r.writeError + ']'
			}
			logLine(line, r.readOk ? 'pass' : 'fail')
		})
		renderReadback(result)
	}

	function renderReadback(result) {
		if (!el.readback) return
		el.readback.innerHTML = ''
		result.rows.forEach(function (r) {
			const div = document.createElement('div')
			div.className = 'sk-batch-readback-row ' + (r.readOk ? 'sk-rw-pass' : 'sk-rw-fail')
			const rHex = r.skippedRead ? '(跳过回读)' : (r.readBytes ? hexOf(r.readBytes) : '(无)')
			div.textContent = r.name + ': 写=' + hexOf(r.bytes) + ' 读=' + rHex + ' ' + (r.readOk ? '✔' : '✘')
			el.readback.appendChild(div)
		})
	}

	// ---------- 清单渲染 ----------
	function buildValueInput(preset, entry) {
		const param = preset.param
		if (param.type === 'enum') {
			const sel = document.createElement('select')
			sel.className = 'form-select form-select-sm'
			const options = param.options || {}
			Object.keys(options).forEach(function (key) {
				const opt = document.createElement('option')
				opt.value = key
				opt.textContent = options[key]
				sel.appendChild(opt)
			})
			const want = (entry.value != null && entry.value !== '') ? String(entry.value) : String(param.default != null ? param.default : '')
			sel.value = want
			return sel
		}
		const input = document.createElement('input')
		input.className = 'form-control form-control-sm'
		input.placeholder = param.label || ''
		if (param.type === 'ascii' || param.type === 'bcd') {
			input.type = 'text'
		} else {
			input.type = 'number'
			input.min = '0'
		}
		input.value = entry.value != null ? entry.value : ''
		return input
	}

	function renderList() {
		if (!el.list) return
		el.list.innerHTML = ''
		list.forEach(function (entry, idx) {
			const preset = PRESET_BY_NAME[entry.presetName]
			const row = document.createElement('div')
			row.className = 'sk-batch-item-row'

			if (!preset) {
				const warn = document.createElement('span')
				warn.className = 'sk-batch-item-name'
				warn.textContent = '(未知预设: ' + entry.presetName + ')'
				row.appendChild(warn)
				const delBtn = document.createElement('button')
				delBtn.className = 'btn btn-sm btn-outline-danger sk-batch-item-del'
				delBtn.title = '删除'
				delBtn.innerHTML = '<i class="bi bi-trash"></i>'
				delBtn.addEventListener('click', function () {
					list.splice(idx, 1)
					renderList()
					saveState()
				})
				row.appendChild(delBtn)
				el.list.appendChild(row)
				return
			}

			const no = document.createElement('span')
			no.className = 'sk-batch-item-no'
			no.textContent = String(idx + 1)
			row.appendChild(no)

			const nameSpan = document.createElement('span')
			nameSpan.className = 'sk-batch-item-name'
			nameSpan.textContent = preset.name
			nameSpan.title = preset.desc || ''
			row.appendChild(nameSpan)

			const valueEl = buildValueInput(preset, entry)
			valueEl.classList.add('sk-batch-item-value')
			valueEl.addEventListener('change', function () {
				entry.value = valueEl.value
				saveState()
			})
			row.appendChild(valueEl)

			if (preset.param.type === 'bcd') {
				const stepEl = document.createElement('input')
				stepEl.type = 'number'
				stepEl.className = 'form-control form-control-sm sk-batch-step'
				stepEl.min = '0'
				stepEl.title = '步进(累加), 0=固定不累加'
				stepEl.value = entry.step != null ? entry.step : '1'
				stepEl.addEventListener('change', function () {
					entry.step = stepEl.value
					saveState()
				})
				row.appendChild(stepEl)
			} else {
				const placeholder = document.createElement('span')
				placeholder.className = 'sk-batch-step-placeholder'
				row.appendChild(placeholder)
			}

			const delBtn = document.createElement('button')
			delBtn.className = 'btn btn-sm btn-outline-danger sk-batch-item-del'
			delBtn.title = '删除'
			delBtn.innerHTML = '<i class="bi bi-trash"></i>'
			delBtn.addEventListener('click', function () {
				list.splice(idx, 1)
				renderList()
				saveState()
			})
			row.appendChild(delBtn)

			el.list.appendChild(row)
		})
		if (!list.length) {
			const empty = document.createElement('div')
			empty.className = 'sk-batch-list-empty'
			empty.textContent = '清单为空, 请从上方选择预设后点「添加」'
			el.list.appendChild(empty)
		}
	}

	function renderPresetSelect() {
		if (!el.presetSelect) return
		el.presetSelect.innerHTML = ''
		PRESET_GROUPS.forEach(function (g) {
			const og = document.createElement('optgroup')
			og.label = g.group
			g.items.forEach(function (it) {
				const opt = document.createElement('option')
				opt.value = it.name
				opt.textContent = it.name
				og.appendChild(opt)
			})
			el.presetSelect.appendChild(og)
		})
	}

	// ---------- 状态持久化 ----------
	function saveState() {
		const st = {
			list: list.map(function (e) {
				return { presetName: e.presetName, value: e.value, step: e.step, enabled: e.enabled !== false }
			}),
			index: current,
			timeoutMs: parseInt(el.timeout.value, 10) || DEFAULT_TIMEOUT_MS,
			gapMs: parseInt(el.gap.value, 10) || DEFAULT_GAP_MS,
			continueOnFail: !!el.continueOnFail.checked
		}
		try { localStorage.setItem(STATE_KEY, JSON.stringify(st)) } catch (e) { /* 忽略存储失败 */ }
	}

	function loadState() {
		let st = null
		try {
			const raw = localStorage.getItem(STATE_KEY)
			if (raw) st = JSON.parse(raw)
		} catch (e) { st = null }
		if (!st) return
		if (Array.isArray(st.list)) {
			list = st.list.filter(function (e) { return e && e.presetName }).map(function (e) {
				return {
					presetName: e.presetName,
					value: e.value != null ? e.value : '',
					step: e.step != null ? e.step : '1',
					enabled: e.enabled !== false
				}
			})
		}
		current = parseInt(st.index, 10) || 0
		if (st.timeoutMs != null) el.timeout.value = st.timeoutMs
		if (st.gapMs != null) el.gap.value = st.gapMs
		if (st.continueOnFail != null) el.continueOnFail.checked = !!st.continueOnFail
	}

	// ---------- UI 状态 ----------
	function updateIdleStatus() {
		if (running) return
		setProgressText('已配 ' + current + ' 台')
		setStatus('就绪 · 下一台起始索引 ' + current, '')
	}

	function setBusyUi(busy) {
		running = busy
		el.primary.disabled = busy
		el.stop.disabled = !busy
		el.reset.disabled = busy
		el.add.disabled = busy
		el.presetSelect.disabled = busy
		el.timeout.disabled = busy
		el.gap.disabled = busy
		el.continueOnFail.disabled = busy
	}

	function validateBeforeRun() {
		if (!window.serialApi || !window.serialApi.isOpen()) {
			setStatus('请先打开串口', 'err')
			return false
		}
		if (!window.sekTx) {
			setStatus('事务层未加载(sekTx)', 'err')
			return false
		}
		if (!list.length) {
			setStatus('清单为空, 请先添加配置项', 'err')
			return false
		}
		for (let i = 0; i < list.length; i++) {
			if (!PRESET_BY_NAME[list[i].presetName]) {
				setStatus('清单中含未知预设: ' + list[i].presetName + ', 请删除该行', 'err')
				return false
			}
		}
		return true
	}

	// ---------- 产线逐台 ----------
	async function runLineStep() {
		if (running) return
		if (!validateBeforeRun()) return
		stopFlag = false
		setBusyUi(true)
		clearLog()
		setStatus('写入第 ' + (current + 1) + ' 台…', 'run')
		// 单台操作钉扎主发口: 写入与回读落在同一设备
		window.serialApi.pinSession(window.serialApi.getActiveSendSid())
		try {
			const result = await writeOne(current)
			renderResult(result)
			if (result.pass) {
				current++
				saveState()
				setStatus('第 ' + current + ' 台 PASS, 下一台起始索引 ' + current, 'ok')
				setProgressText('已配 ' + current + ' 台')
				if (el.summary) {
					el.summary.textContent = '第 ' + current + ' 台 PASS'
					el.summary.className = 'sk-rw-summary is-pass'
				}
			} else {
				setStatus('第 ' + (current + 1) + ' 台 FAIL, 请重试', 'err')
				if (el.summary) {
					el.summary.textContent = '第 ' + (current + 1) + ' 台 FAIL'
					el.summary.className = 'sk-rw-summary is-fail'
				}
			}
		} catch (e) {
			logLine('异常: ' + (e.message || e), 'fail')
			setStatus('异常: ' + (e.message || e), 'err')
		} finally {
			window.serialApi.unpinSession()
			setBusyUi(false)
		}
	}

	function stopAll() {
		stopFlag = true
		setStatus('正在停止…', 'warn')
		if (window.sekTx && typeof window.sekTx.cancelAll === 'function') {
			try { window.sekTx.cancelAll('已停止') } catch (e) { /* */ }
		}
	}

	function resetCount() {
		if (running) return
		current = 0
		saveState()
		setStatus('已重置计数为 0', 'ok')
		updateIdleStatus()
	}

	// ---------- init ----------
	function init() {
		el.card = $('sk-batch-card')
		el.presetSelect = $('sk-batch-preset-select')
		el.add = $('sk-batch-add')
		el.list = $('sk-batch-list')
		el.timeout = $('sk-batch-timeout')
		el.gap = $('sk-batch-gap')
		el.continueOnFail = $('sk-batch-continue')
		el.primary = $('sk-batch-primary')
		el.stop = $('sk-batch-stop')
		el.reset = $('sk-batch-reset')
		el.progress = $('sk-batch-progress-bar')
		el.status = $('sk-batch-status')
		el.summary = $('sk-batch-summary')
		el.readback = $('sk-batch-readback')
		el.log = $('sk-batch-log')
		if (!el.card || !el.primary) return

		buildPresetIndex()
		renderPresetSelect()
		loadState()
		renderList()
		updateIdleStatus()

		el.add.addEventListener('click', function () {
			const name = el.presetSelect.value
			const preset = PRESET_BY_NAME[name]
			if (!preset) return
			const def = (preset.param && preset.param.default != null) ? preset.param.default : ''
			list.push({
				presetName: name,
				value: def,
				step: preset.param.type === 'bcd' ? '1' : '0',
				enabled: true
			})
			renderList()
			saveState()
		})
		el.primary.addEventListener('click', function () {
			runLineStep().catch(function (e) {
				logLine('异常: ' + (e.message || e), 'fail')
				setStatus('异常', 'err')
				setBusyUi(false)
			})
		})
		el.stop.addEventListener('click', stopAll)
		el.stop.disabled = true
		el.reset.addEventListener('click', resetCount)

		const persistOn = [el.timeout, el.gap, el.continueOnFail]
		persistOn.forEach(function (input) {
			if (!input) return
			input.addEventListener('change', saveState)
		})
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init)
	} else {
		init()
	}

	window.skBatchConfig = {
		bcdLeBytes: bcdLeBytes,
		addBig: addBig,
		asciiToBytes: asciiToBytes,
		numToBytesLE: numToBytesLE,
		computeEntryBytes: computeEntryBytes,
		writeOne: writeOne,
		stop: stopAll,
		TAG_QUERY_ID: TAG_QUERY_ID
	}
})()
