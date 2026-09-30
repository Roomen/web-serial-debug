// STS 表端 / CIU 模拟面板: 只负责界面与串口接线，协议与状态机都在 sts-sim.js（引擎不碰 DOM）
// 串口数据、模组回的字节、对端数据、STS 结果块一律用 textContent 渲染，不拼 innerHTML
// PAK 输入框不持久化；其余配置存 localStorage（stsSim.* 前缀，读写包 try/catch）
;(function () {
	'use strict'
	const W = window
	if (!W.stsSim || !W.hostProtoSerialLink || typeof document === 'undefined') return
	const SIM = W.stsSim
	const S = W.stsCiu

	const KEY_ROLE = 'stsSim.role'
	const KEY_METER = 'stsSim.meter'
	const KEY_CIU = 'stsSim.ciu'
	const MAX_LOG = 500

	// ===== 小工具 =====
	function el(tag, cls, text) {
		const e = document.createElement(tag)
		if (cls) e.className = cls
		if (text != null) e.textContent = text
		return e
	}
	function lsGet(key) {
		try { return JSON.parse(localStorage.getItem(key) || 'null') } catch (e) { return null }
	}
	function lsSet(key, v) {
		try { localStorage.setItem(key, JSON.stringify(v)) } catch (e) { /* 存储不可用时静默 */ }
	}
	function pad(n, w) { return String(n).padStart(w || 2, '0') }
	function fmtTime(ms) {
		const d = new Date(ms)
		return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3)
	}
	function fmtQty(v, tariff) {
		if (v == null) return '-'
		if (!tariff) return String(v)
		return tariff.currency ? S.fmtScaled(v, tariff.dec) : S.fmtScaled(v, tariff.dec) + ' L'
	}

	// ===== 字段定义 =====
	// kind: text / num / sel / bool；persist=false 的不落盘
	const METER_FIELDS = [
		{ k: 'drn', label: 'DRN(留空=以模组为准)', kind: 'text', maxlength: 13, w: 150, title: '13 位 = 4 位厂商码 + 8 位表号 + 1 位校验（11 位为 2 位厂商码）；应用层表号取中间 8 位。与模组不一致且填了 PAK 时写入模组并复位' },
		{ k: 'tokenDelayS', label: '令牌处理耗时(s)', kind: 'num', min: 0, max: 3600, w: 72 },
		{ k: 'tokenMode', label: '结果模式', kind: 'sel', options: [['exec', '已执行(充值)'], ['reject', '未执行(拒收)']] },
		{ k: 'creditAmount', label: '充值量(原始整数)', kind: 'num', min: 0, w: 96, title: '按当前计价模式的最小单位：体积 dL，金额按小数位' },
		{ k: 'stsBlockHex', label: 'STS 结果块(HEX)', kind: 'text', w: 200, title: '1..47 字节，原样透传，工具不解释' },
		{ k: 'valveDelayS', label: '阀门动作耗时(s)', kind: 'num', min: 0, max: 600, w: 72 },
		{ k: 'remaining', label: '初始剩余量', kind: 'num', w: 96 },
		{ k: 'totalUsed', label: '初始累计量', kind: 'num', min: 0, w: 96 },
		{ k: 'batteryCv', label: '电池(0.01V)', kind: 'num', min: 0, max: 65535, w: 80 },
		{ k: 'alarmCodes', label: '告警码(4 位,空格分隔)', kind: 'text', w: 160 },
		{ k: 'tariffCurrency', label: '计价模式', kind: 'sel', options: [['0', '体积(dL)'], ['1', '金额']] },
		{ k: 'tariffDec', label: '金额小数位', kind: 'sel', options: [['0', '0'], ['2', '2']] },
		{ k: 'pak', label: 'PAK(32 位 HEX，不保存)', kind: 'text', maxlength: 32, w: 260, persist: false, sensitive: true, title: '仅当模组角色或 DRN 需要写入时用于 PROV_AUTH，不写入浏览器存储' },
	]
	const CIU_FIELDS = [
		{ k: 'targetDrn', label: '目标表 DRN', kind: 'text', maxlength: 13, w: 150, title: '唤醒地址用完整 DRN；应用层表号取中间 8 位（13 位去掉 4 位厂商码和末位校验，11 位去掉 2 位厂商码和末位校验）' },
		{ k: 'localAddr', label: '本机地址(十进制)', kind: 'text', maxlength: 20, w: 120 },
		{ k: 'ackTimeoutS', label: 'ACK 超时(s)', kind: 'num', min: 1, max: 600, w: 72 },
		{ k: 'upTimeoutS', label: '上行超时(s)', kind: 'num', min: 1, max: 600, w: 72 },
		{ k: 'busyWaitS', label: 'BUSY 等待(s)', kind: 'num', min: 0, max: 600, w: 72 },
		{ k: 'sessionRetries', label: '会话重试次数', kind: 'num', min: 0, max: 20, w: 72 },
		{ k: 'pak', label: 'PAK(32 位 HEX，不保存)', kind: 'text', maxlength: 32, w: 260, persist: false, sensitive: true, title: '仅当模组角色或 DRN 需要写入时用于 PROV_AUTH，不写入浏览器存储' },
	]

	const ui = {
		role: 'meter',
		running: false,
		starting: false,
		opBusy: false,
		engine: null,
		link: null,
		timer: null,
		inputs: { meter: {}, ciu: {} },
		refs: {},
		logCount: 0,
		lastState: null,
		clock: {
			now: function () { return Date.now() },
			setTimeout: function (f, ms) { return setTimeout(f, ms) },
			clearTimeout: function (h) { clearTimeout(h) },
		},
	}

	// ===== 构建 DOM =====
	function buildField(def, group) {
		const wrap = el('label', 'sts-sim-field')
		wrap.append(el('span', 'sts-sim-field-name', def.label))
		let input
		if (def.kind === 'sel') {
			input = document.createElement('select')
			input.className = 'form-select form-select-sm'
			def.options.forEach(function (o) {
				const opt = document.createElement('option')
				opt.value = o[0]
				opt.textContent = o[1]
				input.appendChild(opt)
			})
		} else {
			input = document.createElement('input')
			input.className = 'form-control form-control-sm'
			input.type = def.kind === 'num' ? 'number' : (!def.sensitive ? 'text' : 'password')
			if (def.kind === 'num') {
				if (def.min != null) input.min = def.min
				if (def.max != null) input.max = def.max
			}
			if (def.maxlength) input.maxLength = def.maxlength
			input.autocomplete = 'off'
			input.spellcheck = false
		}
		if (def.w) input.style.width = def.w + 'px'
		if (def.title) wrap.title = def.title
		input.id = 'sts-sim-' + group + '-' + def.k
		wrap.htmlFor = input.id
		wrap.appendChild(input)
		ui.inputs[group][def.k] = input
		return wrap
	}

	function buildToggleRow(text, id) {
		const b = document.createElement('button')
		b.type = 'button'
		b.className = 'btn btn-sm btn-outline-secondary'
		b.id = id
		b.textContent = text
		return b
	}

	function build() {
		const root = el('div', 'tab-pane d-flex flex-column wb-pane-scroll sts-sim')
		root.id = 'wb-pane-sts-sim'
		root.setAttribute('role', 'tabpanel')

		// 顶部: 角色分段 + 启停
		const top = el('div', 'sts-sim-top')
		const seg = el('div', 'ctl-seg')
		seg.setAttribute('role', 'group')
		seg.setAttribute('aria-label', '模拟角色')
		const bMeter = el('button', null, '表端')
		const bCiu = el('button', null, 'CIU')
		bMeter.type = bCiu.type = 'button'
		seg.append(bMeter, bCiu)
		const startBtn = el('button', 'btn btn-sm btn-outline-secondary ctl-toggle')
		startBtn.type = 'button'
		startBtn.setAttribute('aria-pressed', 'false')
		const startIcon = el('i', 'bi bi-play-fill')
		startIcon.setAttribute('aria-hidden', 'true')
		const startText = el('span', null, '启动')
		startBtn.append(startIcon, startText)
		const status = el('span', 'sts-sim-status small')
		top.append(seg, startBtn, status)
		root.appendChild(top)
		const hint = el('div', 'sts-sim-hint small', '模拟器经 hostProto 模组收发，运行期间请保持本页在前台，且不要让其它工具占用同一个串口。切到顶栏「hostProto 模组」协议可在日志里逐帧解析。')
		root.appendChild(hint)

		// 配置
		const cfg = el('details', 'sts-sim-card')
		cfg.open = true
		cfg.appendChild(el('summary', null, '配置'))
		const meterForm = el('div', 'sts-sim-form')
		METER_FIELDS.forEach(function (d) { meterForm.appendChild(buildField(d, 'meter')) })
		const ciuForm = el('div', 'sts-sim-form')
		CIU_FIELDS.forEach(function (d) { ciuForm.appendChild(buildField(d, 'ciu')) })
		cfg.append(meterForm, ciuForm)
		root.appendChild(cfg)

		// 表端运行视图
		const meterView = el('div', 'sts-sim-card sts-sim-meter-view')
		meterView.appendChild(el('div', 'sts-sim-card-title', '表计状态'))
		const dl = el('div', 'sts-sim-kv')
		const kv = {}
		;['DRN', '表号', '剩余量', '累计使用量', '总购买量', '阀门', '电池', '告警码', '在飞待办', '存档', '最近会话'].forEach(function (name) {
			dl.appendChild(el('span', 'sts-sim-k', name))
			kv[name] = el('span', 'sts-sim-v', '-')
			dl.appendChild(kv[name])
		})
		meterView.appendChild(dl)
		meterView.appendChild(el('div', 'sts-sim-card-title', '充值记录（最近在前）'))
		const recTable = el('div', 'sts-sim-records')
		meterView.appendChild(recTable)

		// CIU 运行视图
		const ciuView = el('div', 'sts-sim-card sts-sim-ciu-view')
		ciuView.appendChild(el('div', 'sts-sim-card-title', '操作'))
		const tokRow = el('div', 'sts-sim-row')
		const tokenInput = document.createElement('input')
		tokenInput.type = 'text'
		tokenInput.id = 'sts-sim-ciu-token'
		tokenInput.className = 'form-control form-control-sm sts-sim-token'
		tokenInput.placeholder = '20 位数字令牌'
		tokenInput.maxLength = 20
		tokenInput.inputMode = 'numeric'
		tokenInput.autocomplete = 'off'
		tokenInput.spellcheck = false
		const tokenBtn = buildToggleRow('令牌充值', 'sts-sim-ciu-token-go')
		tokRow.append(tokenInput, tokenBtn)
		const opRow = el('div', 'sts-sim-row')
		const statusBtn = buildToggleRow('查询状态', 'sts-sim-ciu-status')
		const recBtn = buildToggleRow('充值记录', 'sts-sim-ciu-records')
		const valveOpenBtn = buildToggleRow('阀控测试·开', 'sts-sim-ciu-valve-open')
		const valveCloseBtn = buildToggleRow('阀控测试·关', 'sts-sim-ciu-valve-close')
		const unbindBtn = buildToggleRow('断开绑定', 'sts-sim-ciu-unbind')
		opRow.append(statusBtn, recBtn, valveOpenBtn, valveCloseBtn, unbindBtn)
		const readRow = el('div', 'sts-sim-row')
		const readStart = document.createElement('input')
		readStart.type = 'text'
		readStart.className = 'form-control form-control-sm'
		readStart.style.width = '72px'
		readStart.value = '0x01'
		readStart.title = '起始寄存器 id（十六进制或十进制）'
		const readCount = document.createElement('input')
		readCount.type = 'number'
		readCount.className = 'form-control form-control-sm'
		readCount.style.width = '64px'
		readCount.min = '1'
		readCount.max = '16'
		readCount.value = '4'
		readCount.title = '数量 1..16'
		const readBtn = buildToggleRow('读寄存器', 'sts-sim-ciu-read')
		const abortBtn = buildToggleRow('中止', 'sts-sim-ciu-abort')
		readRow.append(el('span', 'sts-sim-field-name', '起始/数量'), readStart, readCount, readBtn, abortBtn)
		const phase = el('div', 'sts-sim-phase small', '')
		const resultCard = el('div', 'sts-sim-result')
		ciuView.append(tokRow, opRow, readRow, phase, resultCard)

		root.append(meterView, ciuView)

		// 日志
		const logCard = el('div', 'sts-sim-card sts-sim-logcard')
		const logHead = el('div', 'sts-sim-row')
		logHead.appendChild(el('span', 'sts-sim-card-title', '日志'))
		const clearBtn = buildToggleRow('清空', 'sts-sim-log-clear')
		clearBtn.classList.add('ms-auto')
		logHead.appendChild(clearBtn)
		const logBox = el('div', 'sts-sim-log')
		logBox.setAttribute('role', 'log')
		logCard.append(logHead, logBox)
		root.appendChild(logCard)

		Object.assign(ui.refs, {
			root, bMeter, bCiu, startBtn, startText, startIcon, status, cfg, meterForm, ciuForm, meterView, ciuView, kv, recTable,
			tokenInput, tokenBtn, statusBtn, recBtn, valveOpenBtn, valveCloseBtn, unbindBtn, readStart, readCount, readBtn, abortBtn,
			phase, resultCard, logBox, clearBtn,
		})
		return root
	}

	// ===== 配置读写 =====
	function readGroup(group, defs) {
		const out = {}
		defs.forEach(function (d) {
			const v = ui.inputs[group][d.k].value
			out[d.k] = v
		})
		return out
	}
	function saveGroup(group, defs, key) {
		const data = {}
		defs.forEach(function (d) { if (d.persist !== false) data[d.k] = ui.inputs[group][d.k].value })
		lsSet(key, data)
	}
	function loadGroup(group, defs, key, defaults) {
		const saved = lsGet(key) || {}
		defs.forEach(function (d) {
			const input = ui.inputs[group][d.k]
			if (d.persist === false) { input.value = ''; return }
			let v = saved[d.k]
			if (v == null) v = defaults[d.k]
			if (d.k === 'tariffCurrency') v = (v === true || v === '1') ? '1' : '0'
			input.value = v == null ? '' : String(v)
		})
	}
	function collectMeterConfig() {
		const raw = readGroup('meter', METER_FIELDS)
		const c = {}
		METER_FIELDS.forEach(function (d) {
			const v = raw[d.k]
			c[d.k] = d.kind === 'num' ? (v === '' ? undefined : Number(v)) : v
		})
		c.tariffCurrency = raw.tariffCurrency === '1'
		c.tariffDec = Number(raw.tariffDec)
		return c
	}
	function collectCiuConfig() {
		const raw = readGroup('ciu', CIU_FIELDS)
		const c = {}
		CIU_FIELDS.forEach(function (d) {
			const v = raw[d.k]
			c[d.k] = d.kind === 'num' ? (v === '' ? undefined : Number(v)) : v
		})
		return c
	}

	// ===== 日志 =====
	function appendLog(entry) {
		const box = ui.refs.logBox
		if (!box) return
		const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24
		const line = el('div', 'sts-sim-log-line sts-sim-lv-' + (entry.level || 'info'))
		line.appendChild(el('span', 'sts-sim-log-time', fmtTime(entry.at || Date.now())))
		line.appendChild(el('span', 'sts-sim-log-text', String(entry.text)))
		box.appendChild(line)
		ui.logCount++
		while (ui.logCount > MAX_LOG && box.firstChild) {
			box.removeChild(box.firstChild)
			ui.logCount--
		}
		if (nearBottom) box.scrollTop = box.scrollHeight
	}
	function plog(level, text) { appendLog({ at: Date.now(), level: level, text: text }) }

	// ===== 渲染 =====
	function setStatus(text, cls) {
		ui.refs.status.textContent = text
		ui.refs.status.className = 'sts-sim-status small' + (cls ? ' ' + cls : '')
	}
	function applyRole() {
		const r = ui.refs
		const isMeter = ui.role === 'meter'
		r.bMeter.setAttribute('aria-pressed', String(isMeter))
		r.bCiu.setAttribute('aria-pressed', String(!isMeter))
		r.meterForm.hidden = !isMeter
		r.ciuForm.hidden = isMeter
		r.meterView.hidden = !isMeter
		r.ciuView.hidden = isMeter
		const tariffIsCur = ui.inputs.meter.tariffCurrency.value === '1'
		ui.inputs.meter.tariffDec.closest('label').hidden = !tariffIsCur
	}
	function applyRunning() {
		const r = ui.refs
		const busy = ui.running || ui.starting
		r.startBtn.setAttribute('aria-pressed', String(busy))
		r.startText.textContent = busy ? '停止' : '启动'
		r.startIcon.className = 'bi ' + (busy ? 'bi-stop-fill' : 'bi-play-fill')
		r.bMeter.disabled = busy
		r.bCiu.disabled = busy
		// 运行期间配置锁定
		Object.keys(ui.inputs).forEach(function (g) {
			Object.keys(ui.inputs[g]).forEach(function (k) { ui.inputs[g][k].disabled = busy })
		})
		updateCiuButtons()
	}
	function updateCiuButtons() {
		const r = ui.refs
		const st = ui.engine && ui.role === 'ciu' ? ui.engine.getState() : null
		const idle = !!(st && st.running && st.phase === 'idle' && !ui.opBusy)
		;[r.tokenBtn, r.statusBtn, r.recBtn, r.valveOpenBtn, r.valveCloseBtn, r.unbindBtn, r.readBtn].forEach(function (b) { b.disabled = !idle })
		r.tokenInput.disabled = !(ui.running && ui.role === 'ciu')
		r.abortBtn.disabled = !(ui.running && ui.opBusy)
		r.tokenBtn.disabled = !idle || r.tokenInput.value.length !== 20
	}
	function renderMeterState(s) {
		const kv = ui.refs.kv
		const t = s.tariff
		kv['DRN'].textContent = s.drn || '-'
		kv['表号'].textContent = s.meterNo || '-'
		kv['剩余量'].textContent = fmtQty(s.remaining, t) + '（原始 ' + s.remaining + '）'
		kv['累计使用量'].textContent = fmtQty(s.totalUsed, { currency: false, dec: 1 })
		kv['总购买量'].textContent = fmtQty(s.totalPurchased, t)
		const pos = s.valve & S.VALVE_POS_MASK
		kv['阀门'].textContent = (pos === S.VALVE_POS_OPEN ? '开' : pos === S.VALVE_POS_CLOSED ? '关' : '不明') +
			(s.valveTestActive ? '（阀控测试中，到期 ' + fmtTime(s.valveRestoreAt) + ' 恢复）' : '')
		kv['电池'].textContent = S.fmtScaled(s.batteryCv, 2) + ' V'
		kv['告警码'].textContent = s.alarms.length ? s.alarms.join(' ') : '无'
		kv['在飞待办'].textContent = s.pending ? s.pending.type + ' TGT=0x' + s.pending.tgt.toString(16).toUpperCase() + '，预计剩余 ' + s.pending.etaS + ' s' : '无'
		kv['存档'].textContent = s.archive.length ? s.archive.map(function (a) { return a.type + ' 0x' + a.tgt.toString(16).toUpperCase() }).join('，') : '空'
		const ls = s.lastSession
		kv['最近会话'].textContent = ls ? '共 ' + s.sessions + ' 次；最近一次 SET_UPLINK ' + ls.setUplinkMs + 'ms，自 kind=3 起 ' + ls.sinceKind3Ms + 'ms' : (s.sessions ? '共 ' + s.sessions + ' 次' : '暂无')
		const box = ui.refs.recTable
		box.textContent = ''
		const list = s.records.filter(function (r) { return !r.empty })
		if (!list.length) { box.appendChild(el('div', 'sts-sim-empty small', '暂无')); return }
		list.forEach(function (r, i) {
			const row = el('div', 'sts-sim-rec')
			row.appendChild(el('span', null, '#' + (i + 1)))
			row.appendChild(el('span', null, r.minutes === S.RECORD_EPOCH_UNSET ? '时刻未知' : S.recordTimeStr(r.minutes)))
			row.appendChild(el('span', null, fmtQty(r.amount, t)))
			box.appendChild(row)
		})
	}
	function renderResult(res) {
		const box = ui.refs.resultCard
		box.textContent = ''
		if (!res) return
		const head = el('div', 'sts-sim-result-head ' + (res.ok ? 'is-ok' : 'is-bad'))
		head.appendChild(el('span', 'sts-sim-badge', res.ok ? '成功' : ({ timeout: '超时放弃', nak: '被拒绝', aborted: '已中止', unsupported: '不支持' }[res.outcome] || '失败')))
		head.appendChild(el('span', null, ' ' + (res.message || '')))
		box.appendChild(head)
		const kv = el('div', 'sts-sim-kv')
		const add = function (k, v) { kv.appendChild(el('span', 'sts-sim-k', k)); kv.appendChild(el('span', 'sts-sim-v', v)) }
		if (res.token) {
			add('处理状态', '0x' + res.token.procStatus.toString(16).toUpperCase().padStart(2, '0') + (res.token.known === false ? '（未知）' : res.token.executed ? ' 已执行' : ' 未执行'))
			if (res.token.executed) { add('充值量', res.token.creditedText); add('剩余量', res.token.remainingText) }
			if (res.token.stsBlockHex) add('STS 结果块', res.token.stsBlockHex)
		}
		if (res.write) add('WRITE', '寄存器 0x' + res.write.reg.toString(16).toUpperCase() + ' 结果 0x' + res.write.result.toString(16).toUpperCase().padStart(2, '0'))
		if (res.status) {
			add('剩余量', res.status.remainingText)
			add('阀门', '0x' + res.status.valve.toString(16).toUpperCase().padStart(2, '0') + res.status.valveText)
			add('表计状态', '0x' + res.status.meterStatus.toString(16).toUpperCase().padStart(2, '0') + res.status.meterStatusText)
			add('电池', res.status.batteryText)
			if (res.status.alarms) add('告警码', res.status.alarms.join(' '))
		}
		if (res.nak) add('NAK', '0x' + res.nak.reason.toString(16).toUpperCase().padStart(2, '0') + ' ' + res.nak.text)
		if (res.read) res.read.forEach(function (t) { add('0x' + t.id.toString(16).toUpperCase().padStart(2, '0') + ' ' + t.name, t.invalid ? '无效标记' : t.text) })
		if (res.records) {
			res.records.forEach(function (r) { add('#' + r.index, r.empty ? '空槽' : (r.timeText + '  ' + r.amountText)) })
		}
		if (kv.childNodes.length) box.appendChild(kv)
		if (res.sessions && res.sessions.length) {
			box.appendChild(el('div', 'sts-sim-card-title', '会话时间线（相对 WAKE 请求，ms）'))
			const tb = el('div', 'sts-sim-tl')
			const hdr = ['会话', '结果', 'wake', 'send', 'ACK', '上行']
			hdr.forEach(function (h) { tb.appendChild(el('span', 'sts-sim-tl-h', h)) })
			res.sessions.forEach(function (s) {
				const tl = s.timeline || {}
				tb.appendChild(el('span', null, s.label + ' #' + s.attempt))
				tb.appendChild(el('span', s.ok ? 'is-ok' : 'is-bad', s.ok ? 'OK' : (s.reason || '失败')))
				;[tl.wakeMs, tl.sendMs, tl.ackMs, tl.upMs].forEach(function (v) { tb.appendChild(el('span', null, v == null ? '-' : String(v))) })
			})
			box.appendChild(tb)
		}
		box.appendChild(el('div', 'sts-sim-hint small', '总耗时 ' + (res.durationMs / 1000).toFixed(1) + ' s'))
	}
	function renderPhase() {
		const r = ui.refs
		if (!ui.engine || ui.role !== 'ciu' || !ui.running) { r.phase.textContent = ''; return }
		const st = ui.engine.getState()
		const names = { idle: '空闲', session: '唤醒会话中（WAKE → SEND → 等 ACK → 等上行）', 'wait-poll': '等待下一次轮询' }
		let t = '阶段：' + (names[st.phase] || st.phase)
		if (st.budgetLeftMs != null) t += '；总预算剩余 ' + Math.ceil(st.budgetLeftMs / 1000) + ' s'
		if (st.tariff) t += '；计价 ' + (st.tariff.currency ? '金额 d=' + st.tariff.dec : '体积 dL')
		if (st.protoVersion != null) t += '；表体协议版本 ' + st.protoVersion
		r.phase.textContent = t
		updateCiuButtons()
	}
	function tick() {
		if (!ui.running) return
		// 串口断开: 引擎自动停止
		const api = W.serialApi
		if (api && !api.isOpen()) {
			plog('error', '串口已断开，模拟器自动停止')
			stopSim('串口已断开')
			return
		}
		renderPhase()
	}

	// ===== 启停 =====
	function cleanup() {
		if (ui.timer != null) { clearInterval(ui.timer); ui.timer = null }
		if (ui.engine) { try { ui.engine.stop() } catch (e) { /* 忽略 */ } ui.engine = null }
		if (ui.link) { try { ui.link.close() } catch (e) { /* 忽略 */ } ui.link = null }
		ui.running = false
		ui.starting = false
		ui.opBusy = false
	}
	function stopSim(msg) {
		cleanup()
		setStatus(msg || '已停止')
		applyRunning()
		renderPhase()
	}
	async function startSim() {
		if (ui.running || ui.starting) return
		const api = W.serialApi
		if (!api || !api.isOpen()) {
			setStatus('请先连接串口', 'is-bad')
			plog('warn', '串口未连接：请先在顶栏打开串口（115200 8N1）再启动模拟')
			return
		}
		let engine
		try {
			ui.link = W.hostProtoSerialLink({ log: function (t) { plog('info', '[链路] ' + t) } })
			if (ui.role === 'meter') {
				const cfg = collectMeterConfig()
				saveGroup('meter', METER_FIELDS, KEY_METER)
				engine = SIM.createMeterSim({ link: ui.link, clock: ui.clock, config: cfg, onLog: appendLog, onState: function (s) { ui.lastState = s; renderMeterState(s) } })
			} else {
				const cfg = collectCiuConfig()
				saveGroup('ciu', CIU_FIELDS, KEY_CIU)
				engine = SIM.createCiuSim({ link: ui.link, clock: ui.clock, config: cfg, onLog: appendLog, onState: function () { renderPhase() } })
			}
		} catch (e) {
			if (ui.link) { try { ui.link.close() } catch (e2) { /* 忽略 */ } ui.link = null }
			setStatus(e.message, 'is-bad')
			plog('error', '配置错误: ' + e.message)
			return
		}
		ui.engine = engine
		ui.starting = true
		setStatus(ui.role === 'meter' ? '启动中：探活与核对模组…' : '启动中：探活、核对模组并读取计价模式与协议版本（每次读取是一次唤醒会话，需数十秒）…')
		applyRunning()
		if (W._activeProtocol !== 'hostproto') plog('info', '切到顶栏「hostProto 模组」协议可在日志里看到逐帧解析')
		try {
			await engine.start()
			if (ui.engine !== engine) return // 启动期间被手动停止
			ui.running = true
			ui.starting = false
			if (ui.role === 'meter') {
				const s = engine.getState()
				if (s.drn) ui.inputs.meter.drn.value = s.drn // 以模组回读的 DRN 为准并回填
				saveGroup('meter', METER_FIELDS, KEY_METER)
			}
			ui.timer = setInterval(tick, 500)
			setStatus(ui.role === 'meter' ? '表端运行中' : 'CIU 运行中', 'is-ok')
			applyRunning()
			renderPhase()
		} catch (e) {
			if (ui.engine !== engine) return
			const msg = e && e.message ? e.message : String(e)
			plog('error', '启动失败: ' + msg)
			stopSim('启动失败: ' + msg)
			ui.refs.status.classList.add('is-bad')
		}
	}

	// ===== CIU 操作 =====
	async function runCiu(fn) {
		if (!ui.engine || !ui.running || ui.opBusy) return
		ui.opBusy = true
		updateCiuButtons()
		renderResult(null)
		try {
			const res = await fn(ui.engine)
			renderResult(res)
			plog(res.ok ? 'info' : 'warn', '[' + res.op + '] ' + (res.ok ? '成功' : '未成功') + '：' + res.message)
		} catch (e) {
			plog('error', '操作异常: ' + (e && e.message ? e.message : e))
		} finally {
			ui.opBusy = false
			updateCiuButtons()
			renderPhase()
		}
	}
	function parseRegId(v) {
		const s = String(v).trim()
		const n = /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10)
		return Number.isFinite(n) && n >= 0 && n <= 0xff ? n : null
	}

	function bind() {
		const r = ui.refs
		r.bMeter.addEventListener('click', function () { ui.role = 'meter'; lsSet(KEY_ROLE, ui.role); applyRole() })
		r.bCiu.addEventListener('click', function () { ui.role = 'ciu'; lsSet(KEY_ROLE, ui.role); applyRole() })
		r.startBtn.addEventListener('click', function () {
			if (ui.running || ui.starting) { plog('info', '手动停止'); stopSim('已停止') } else startSim()
		})
		r.clearBtn.addEventListener('click', function () { r.logBox.textContent = ''; ui.logCount = 0 })
		Object.keys(ui.inputs.meter).forEach(function (k) {
			ui.inputs.meter[k].addEventListener('change', function () { saveGroup('meter', METER_FIELDS, KEY_METER); applyRole() })
		})
		Object.keys(ui.inputs.ciu).forEach(function (k) {
			ui.inputs.ciu[k].addEventListener('change', function () { saveGroup('ciu', CIU_FIELDS, KEY_CIU) })
		})
		r.tokenInput.addEventListener('input', function () {
			r.tokenInput.value = r.tokenInput.value.replace(/\D/g, '').slice(0, 20) // 只接受数字
			updateCiuButtons()
		})
		r.tokenBtn.addEventListener('click', function () {
			const t = r.tokenInput.value
			if (!/^\d{20}$/.test(t)) { plog('warn', '令牌需 20 位数字'); return }
			runCiu(function (e) { return e.token(t) })
		})
		r.statusBtn.addEventListener('click', function () { runCiu(function (e) { return e.status() }) })
		r.recBtn.addEventListener('click', function () { runCiu(function (e) { return e.records() }) })
		r.valveOpenBtn.addEventListener('click', function () { runCiu(function (e) { return e.valveTest(true) }) })
		r.valveCloseBtn.addEventListener('click', function () { runCiu(function (e) { return e.valveTest(false) }) })
		r.unbindBtn.addEventListener('click', function () { runCiu(function (e) { return e.unbind() }) })
		r.readBtn.addEventListener('click', function () {
			const start = parseRegId(r.readStart.value)
			const n = parseInt(r.readCount.value, 10)
			if (start == null || !(n >= 1 && n <= 16) || start + n - 1 > 0xff) { plog('warn', 'READ 参数非法：起始 0..255，数量 1..16，且不越过 0xFF'); return }
			runCiu(function (e) { return e.read(start, n) })
		})
		r.abortBtn.addEventListener('click', function () { if (ui.engine) ui.engine.abort() })
	}

	function init() {
		const root = build()
		loadGroup('meter', METER_FIELDS, KEY_METER, SIM.METER_DEFAULTS)
		loadGroup('ciu', CIU_FIELDS, KEY_CIU, SIM.CIU_DEFAULTS)
		const savedRole = lsGet(KEY_ROLE)
		ui.role = savedRole === 'ciu' ? 'ciu' : 'meter'
		bind()
		applyRole()
		applyRunning()
		setStatus('未启动')
		register(root)
	}

	// Workbench 可能尚未就绪（脚本在 workbench.js 之前加载）: 等 DOMContentLoaded 之后再注册，仍未就绪就轮询
	function register(root) {
		let tries = 0
		const attempt = function () {
			if (W.Workbench && typeof W.Workbench.registerPanel === 'function') {
				W.Workbench.registerPanel({
					id: 'sts-sim', title: 'STS 表端 / CIU 模拟', label: 'STS 模拟', icon: 'bi-broadcast',
					el: root, order: 60, docks: ['right', 'bottom'], dock: 'right',
				})
				return
			}
			if (++tries < 100) setTimeout(attempt, 50)
		}
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attempt)
		else attempt()
	}

	init()
})()
