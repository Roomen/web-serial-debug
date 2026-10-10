// STS 表端 / CIU 模拟面板: 只负责界面与串口接线，协议与状态机都在 sts-sim.js（引擎不碰 DOM）
// 串口数据、模组回的字节、对端数据、STS 结果块一律用 textContent 渲染，不拼 innerHTML
// PAK 输入框不持久化；其余配置存 localStorage（stsSim.* 前缀，读写包 try/catch）
;(function () {
	'use strict'
	// sid: 物理会话。'S' 单路模式，'A' / 'B' 双路模式；三套面板各自独立配置、启停与日志，sid 固定不随模式映射
	function createPanel(channel) {
		const W = window
		const SIM = W.stsSim
		const S = W.stsCiu
		const MODE = channel === 'S' ? 'single' : 'dual'
		const suffix = channel === 'S' ? '' : '.' + channel // S 沿用已上线的无后缀键，不迁移
		const KEY_COLLAPSED = 'stsSim.collapsed' + suffix
		const KEY_ROLE = 'stsSim.role' + suffix
		const KEY_METER = 'stsSim.meter2' + suffix
		const KEY_CIU = 'stsSim.ciu' + suffix
		const KEY_RUNNING = 'stsSim.running' + suffix
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
			{ k: 'tokenDelayS', label: '令牌处理耗时(s)', kind: 'num', min: 0, max: 3600, w: 72 },
			{ k: 'tokenMode', label: '普通令牌结果', kind: 'sel', title: '非模拟令牌（任意 20 位）的处理结果: 已执行 = 处理状态 2 + MODE1 充值量；结果码 = 处理状态 1 + MODE3；表计测试 = 处理状态 1 + MODE256 位图。这里只回报结果码，不执行业务动作；模拟令牌按自身类型处理，不受此项影响', options: [
				['exec', '已执行(充值)'], ['1', 'OVER 余额过多'], ['2', 'OLD 令牌过期'], ['3', 'USED 已使用'], ['4', '1ST 换钥第一步'], ['5', '2ND 换钥第二步'],
				['6', 'EXPIRED 密钥到期'], ['7', 'SUCCESS 设置成功'], ['8', '清余额成功'], ['9', '设置预付费'], ['10', '设置后付费'], ['11', '打开水阀'],
				['12', '关闭水阀'], ['13', '清除窃水'], ['255', 'REJECT 错误令牌'], ['test', '表计测试(MODE256)'],
			] },
			{ k: 'creditAmount', label: '充值量(原始整数)', kind: 'num', min: 0, w: 96, title: '按当前计价模式的最小单位：体积 dL，金额按小数位' },
			{ k: 'creditLimit', label: '余额上限(0=不限)', kind: 'num', min: 0, w: 96, title: '原始整数，单位同剩余量。充值后剩余量超过上限时令牌不执行，终局为处理状态 1 + MODE3 OVER 余额过多；对模拟令牌和「已执行(充值)」的普通令牌都生效。0 = 只受 i32 上限 2147483647 限制' },
			{ k: 'testBits', label: '测试位图(HEX)', kind: 'text', maxlength: 8, w: 96, title: '结果模式为「表计测试」时 MODE256 的 Value，u32 位图：BIT0 水阀开关测试、BIT1 全屏、BIT2 总用水量、BIT3 KRN、BIT4 TI、BIT7 清除窃水、BIT9 软件版本、BIT13 EA、BIT16 KEN、BIT17 DRN' },
			{ k: 'valveDelayS', label: '阀门动作耗时(s)', kind: 'num', min: 0, max: 600, w: 72 },
			{ k: 'remaining', label: '初始剩余量', kind: 'num', w: 96 },
			{ k: 'totalUsed', label: '初始累计量', kind: 'num', min: 0, w: 96 },
			{ k: 'batteryV', label: '电池(V)', kind: 'num', min: 0, max: 655.35, step: 0.01, w: 80, title: '两位小数，引擎内部换算为 0.01V 整数' },
			{ k: 'tariffCurrency', label: '计价模式', kind: 'sel', options: [['0', '体积(dL)'], ['1', '金额']] },
			{ k: 'tariffDec', label: '金额小数位', kind: 'sel', options: [['0', '0'], ['2', '2']] },
			{ k: 'pak', label: 'PAK(32 位 HEX，不保存)', kind: 'text', maxlength: 32, w: 260, persist: false, sensitive: true, title: '仅当模组角色需要切换时用于 PROV_AUTH，不写入浏览器存储' },
		]
		const CIU_FIELDS = [
			{ k: 'targetDrn', label: '目标表 DRN', kind: 'text', maxlength: 13, w: 150, title: '唤醒地址用完整 DRN；应用层表号取中间 8 位（13 位去掉 4 位厂商码和末位校验，11 位去掉 2 位厂商码和末位校验）' },
			{ k: 'ackTimeoutS', label: 'ACK 超时(s)', kind: 'num', min: 1, max: 600, w: 72 },
			{ k: 'upTimeoutS', label: '上行超时(s)', kind: 'num', min: 1, max: 600, w: 72 },
			{ k: 'busyWaitS', label: 'BUSY 等待(s)', kind: 'num', min: 0, max: 600, w: 72 },
			{ k: 'sessionRetries', label: '会话重试次数', kind: 'num', min: 0, max: 20, w: 72 },
			{ k: 'sendTiming', label: 'WOR_SEND 时机', kind: 'sel', title: '规范允许 WAKE 受理后立即入队（默认）。实板上 ACK 后表端收不到会话帧时，切到「ACK 后」对比，可判断是否为 ACK 前入队的数据没被模组消费', options: [['accept', '受理后立即'], ['ack', 'ACK 后']] },
			{ k: 'pak', label: 'PAK(32 位 HEX，不保存)', kind: 'text', maxlength: 32, w: 260, persist: false, sensitive: true, title: '仅当模组角色需要切换时用于 PROV_AUTH，不写入浏览器存储' },
		]

		const ui = {
			wanted: lsGet(KEY_RUNNING) === true,
			sid: null,
			name: channel === 'S' ? '单路' : channel + '路', // 短名，用于提示文案
			title: channel === 'S' ? '单路' : channel + '路', // 头部显示名，串口标签改成自定义名时附上
			collapsed: channel !== 'S' && lsGet(KEY_COLLAPSED) === true,
			retryAt: 0,
			retryCount: 0,
			role: 'meter',
			running: false,
			starting: false,
			opBusy: false,
			switching: false, // CIU 目标 DRN 切换进行中
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
					if (def.step) input.step = def.step
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

		// 告警码复选网格（配置与运行时各一份）：预置码按表内顺序，另有「其他码」文本框（4 位十进制，空格分隔）
		function buildAlarmGrid(prefix) {
			const root = el('div', 'sts-sim-alarm-block')
			const selected = el('div', 'sts-sim-alarm-summary')
			const picker = el('details', 'sts-sim-alarm-picker')
			const summary = el('summary', null, '选择告警')
			picker.appendChild(summary)
			const grid = el('div', 'sts-sim-alarms')
			const checks = {}
			SIM.ALARM_PRESETS.forEach(function (p) {
				const wrap = el('div', 'form-check form-switch ctl-switch')
				const input = document.createElement('input')
				input.type = 'checkbox'
				input.className = 'form-check-input'
				input.id = prefix + '-' + p.code
				const label = el('label', 'form-check-label')
				label.title = p.label
				label.append(el('span', 'sts-sim-alarm-code', p.code), el('span', 'sts-sim-alarm-name', alarmName(p)))
				label.htmlFor = input.id
				wrap.append(input, label)
				grid.appendChild(wrap)
				checks[p.code] = input
			})
			const other = document.createElement('input')
			other.type = 'text'
			other.className = 'form-control form-control-sm'
			other.id = prefix + '-other'
			other.placeholder = '其他码，4 位十进制，空格分隔'
			other.spellcheck = false
			other.autocomplete = 'off'
			other.style.maxWidth = '260px'
			picker.append(grid, other, el('div', 'sts-sim-hint small', '预置码按列表顺序优先显示；其他码追加在后。'))
			root.append(selected, picker)
			const refresh = function () {
				const codes = SIM.composeAlarmCodes(Object.keys(checks).filter(function (code) { return checks[code].checked }), other.value)
				renderAlarms(selected, codes.trim() ? codes.trim().split(/\s+/) : [])
				summary.textContent = '选择告警 · ' + (codes.trim() ? codes.trim().split(/\s+/).length : 0) + ' 项'
			}
			root.addEventListener('change', refresh)
			refresh()
			return {
				root: root, checks: checks, other: other,
				get: function () {
					const on = Object.keys(checks).filter(function (c) { return checks[c].checked })
					return SIM.composeAlarmCodes(on, other.value)
				},
				set: function (str) {
					const sp = SIM.splitAlarmCodes(str)
					Object.keys(checks).forEach(function (c) { checks[c].checked = sp.checked.indexOf(c) !== -1 })
					other.value = sp.other
					refresh()
				},
				setDisabled: function (b) {
					Object.keys(checks).forEach(function (c) { checks[c].disabled = b })
					other.disabled = b
				},
			}
		}
		function alarmName(preset) {
			const names = { '0801': '通讯电池 · 二级 10%', '0803': '低电量 · 一级 20%' }
			return names[preset.code] || preset.label.replace(/（.*?）/g, '').replace(/告警$/, '')
		}
		function renderAlarms(target, codes) {
			target.textContent = ''
			if (!codes.length) { target.appendChild(el('span', 'sts-sim-empty', '无告警')); return }
			codes.forEach(function (code) {
				const preset = SIM.ALARM_PRESETS.find(function (item) { return item.code === code })
				const tag = el('span', 'sts-sim-alarm-tag')
				tag.append(el('span', 'sts-sim-alarm-code', code), el('span', null, preset ? alarmName(preset) : '自定义'))
				tag.title = preset ? preset.label : '自定义告警码'
				target.appendChild(tag)
			})
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
			const root = el('div', 'sts-sim-chan')
			root.id = 'wb-pane-sts-sim'
			root.setAttribute('role', 'region')

			// 头部: 显示名(A/B 可折叠) + 角色分段 + 启停 + 状态，一行放下，窄时换行
			const head = el('div', 'sts-sim-head')
			let toggle = null
			let nameEl
			if (channel === 'S') {
				nameEl = el('span', 'sts-sim-title', ui.title)
				head.appendChild(nameEl)
			} else {
				toggle = el('button', 'sts-sim-collapse')
				toggle.type = 'button'
				const chevron = el('i', 'bi bi-chevron-down')
				chevron.setAttribute('aria-hidden', 'true')
				nameEl = el('span', 'sts-sim-title', ui.title)
				toggle.append(chevron, nameEl)
				toggle.chevron = chevron
				head.appendChild(toggle)
			}
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
			head.append(seg, startBtn, status)
			root.appendChild(head)
			const body = el('div', 'sts-sim-body')
			root.appendChild(body)
			const hint = el('div', 'sts-sim-hint small', ui.name + ' · 独立串口收发 · 115200 8N1')
			body.appendChild(hint)

			// 配置
			const cfg = el('details', 'sts-sim-card')
			cfg.open = true
			cfg.appendChild(el('summary', null, '配置'))
			const meterForm = el('div', 'sts-sim-form')
			METER_FIELDS.forEach(function (d) { meterForm.appendChild(buildField(d, 'meter')) })
			const ciuForm = el('div', 'sts-sim-form')
			const addrField = el('div', 'sts-sim-field')
			ui.refs.ciuLocalAddr = el('output', 'form-control form-control-sm', '待读取')
			ui.refs.ciuLocalAddr.id = 'sts-sim-ciu-localAddr'
			addrField.append(el('span', 'sts-sim-field-name', '本机地址(只读)'), ui.refs.ciuLocalAddr)
			ciuForm.appendChild(addrField)
			CIU_FIELDS.forEach(function (d) { ciuForm.appendChild(buildField(d, 'ciu')) })
			ui.alarmCfg = buildAlarmGrid('sts-sim-cfg-alarm')
			const alarmCfgBox = el('div', 'sts-sim-field')
			alarmCfgBox.append(el('span', 'sts-sim-field-name', '初始告警'), ui.alarmCfg.root)
			alarmCfgBox.style.width = '100%'
			meterForm.appendChild(alarmCfgBox)
			meterForm.appendChild(el('div', 'sts-sim-hint small', 'DRN 启动时从模组自动读取。'))
			ciuForm.appendChild(el('div', 'sts-sim-hint small', '本机地址取自模组 DEV_ID_GET（DRN）；启动时查 WOR_GET_STATUS，未初始化才用 WOR_INIT 设为发起端地址。'))
			cfg.append(meterForm, ciuForm)
			body.appendChild(cfg)

			// 表端运行视图
			const meterView = el('div', 'sts-sim-card sts-sim-meter-view')
			meterView.appendChild(el('div', 'sts-sim-card-title', '表计状态'))
			const dl = el('div', 'sts-sim-kv')
			const kv = {}
			;['DRN', '表号', '表计状态位域', '剩余量', '累计使用量', '总购买量', '阀门', '电池', '告警码', '在飞待办', '存档', '最近会话'].forEach(function (name) {
				dl.appendChild(el('span', 'sts-sim-k', name))
				kv[name] = el('span', 'sts-sim-v', '-')
				dl.appendChild(kv[name])
			})
			meterView.appendChild(dl)
			// 运行值: 运行中可随时改、立即生效；只改运行值，不回写上面的配置表单（下次启动仍以表单为初值）
			meterView.appendChild(el('div', 'sts-sim-card-title', '运行值（立即生效，不回写配置）'))
			const live = el('div', 'sts-sim-form')
			ui.live = {}
			;[['remaining', '剩余量(原始整数)', 1, 110], ['totalUsed', '累计使用量(原始 dL)', 1, 110], ['totalPurchased', '总购买量(原始整数)', 1, 110], ['batteryV', '电池(V)', 0.01, 80]].forEach(function (f) {
				const wrap = el('label', 'sts-sim-field')
				wrap.append(el('span', 'sts-sim-field-name', f[1]))
				const input = document.createElement('input')
				input.type = 'number'
				input.step = String(f[2])
				input.className = 'form-control form-control-sm'
				input.style.width = f[3] + 'px'
				input.id = 'sts-sim-live-' + f[0]
				wrap.htmlFor = input.id
				wrap.appendChild(input)
				live.appendChild(wrap)
				ui.live[f[0]] = input
			})
			meterView.appendChild(live)
			const valveRow = el('div', 'sts-sim-row')
			valveRow.appendChild(el('span', 'sts-sim-field-name', '阀门位置'))
			const valveSeg = el('div', 'ctl-seg')
			valveSeg.setAttribute('role', 'group')
			valveSeg.setAttribute('aria-label', '阀门位置')
			ui.valveBtns = {}
			;[['open', '开'], ['closed', '关'], ['unknown', '不明']].forEach(function (x) {
				const b = el('button', null, x[1])
				b.type = 'button'
				b.dataset.pos = x[0]
				b.setAttribute('aria-pressed', 'false')
				valveSeg.appendChild(b)
				ui.valveBtns[x[0]] = b
			})
			const faultWrap = el('div', 'form-check form-switch ctl-switch')
			ui.valveFault = document.createElement('input')
			ui.valveFault.type = 'checkbox'
			ui.valveFault.className = 'form-check-input'
			ui.valveFault.id = 'sts-sim-live-valve-fault'
			const faultLabel = el('label', 'form-check-label', '阀门动作故障')
			faultLabel.htmlFor = ui.valveFault.id
			faultWrap.append(ui.valveFault, faultLabel)
			valveRow.append(valveSeg, faultWrap)
			meterView.appendChild(valveRow)
			ui.alarmLive = buildAlarmGrid('sts-sim-live-alarm')
			meterView.appendChild(el('div', 'sts-sim-field-name', '运行告警 · 修改立即生效（0x17）'))
			meterView.appendChild(ui.alarmLive.root)
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
			const tokenBtn = buildToggleRow('下发令牌', 'sts-sim-ciu-token-go')
			tokRow.append(tokenInput, tokenBtn)
			// 模拟令牌生成: 明文测试格式（不是 STS 令牌），表端模拟器按类型给出对应结果；生成后填进上面的令牌框
			const simRow = el('div', 'sts-sim-row')
			const simType = document.createElement('select')
			simType.className = 'form-select form-select-sm'
			simType.id = 'sts-sim-ciu-simtype'
			simType.style.width = '140px'
			Object.keys(S.SIM_TOKEN_TYPES || {}).forEach(function (k) {
				const o = document.createElement('option')
				o.value = k
				o.textContent = k + ' ' + S.SIM_TOKEN_TYPES[k].name
				simType.appendChild(o)
			})
			const simData = document.createElement('input')
			simData.type = 'text'
			simData.id = 'sts-sim-ciu-simdata'
			simData.className = 'form-control form-control-sm'
			simData.style.width = '120px'
			simData.autocomplete = 'off'
			simData.spellcheck = false
			const simBtn = buildToggleRow('生成模拟令牌', 'sts-sim-ciu-simgen')
			simRow.title = '模拟令牌 = 77 + 类型 2 位 + 序号 4 位 + 数据 10 位 + 校验 2 位，只对本工具的表端模拟器有意义。充值填充值量：体积按 STS 令牌单位 0.1 m³（100 L），表端换算为协议的 dL（×1000），金额按 10^-d 货币单位；表计测试填位图 HEX；指定结果码填 1/2/3/6/255；其余类型不需要数据。序号每次生成自动递增'
			// 充值量的单位与换算值: 计价模式要等 CIU 启动后读到寄存器 0x18 才知道
			const simUnit = el('span', 'sts-sim-hint small')
			simUnit.id = 'sts-sim-ciu-simunit'
			simRow.append(el('span', 'sts-sim-field-name', '模拟令牌'), simType, simData, simUnit, simBtn)
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
			ciuView.append(tokRow, simRow, opRow, readRow, phase, resultCard)

			body.append(meterView, ciuView)

			// 日志
			const logCard = el('div', 'sts-sim-card sts-sim-logcard')
			const logHead = el('div', 'sts-sim-row')
			const logTitle = el('span', 'sts-sim-card-title', ui.title + ' 日志 · 最新在前')
			logHead.appendChild(logTitle)
			const clearBtn = buildToggleRow('清空', 'sts-sim-log-clear')
			clearBtn.classList.add('ms-auto')
			logHead.appendChild(clearBtn)
			const logBox = el('div', 'sts-sim-log')
			logBox.setAttribute('role', 'log')
			logCard.append(logHead, logBox)
			body.appendChild(logCard)

			Object.assign(ui.refs, {
				root, head, body, toggle, nameEl, hint, logCard, logTitle, bMeter, bCiu, startBtn, startText, startIcon, status, cfg, meterForm, ciuForm, meterView, ciuView, kv, recTable,
				tokenInput, tokenBtn, simType, simData, simUnit, simBtn, statusBtn, recBtn, valveOpenBtn, valveCloseBtn, unbindBtn, readStart, readCount, readBtn, abortBtn,
				phase, resultCard, logBox, clearBtn,
			})
			root.querySelectorAll('[id]').forEach(function (node) { node.id += '-' + channel })
			root.querySelectorAll('label[for]').forEach(function (node) { node.htmlFor += '-' + channel })
			root.id += '-' + channel
			root.setAttribute('aria-label', '模拟' + ui.name)
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
			if (group === 'meter') data.alarmCodes = ui.alarmCfg.get()
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
				if (d.k === 'tokenMode' && v === 'reject') v = '255' // 旧配置的「未执行(拒收)」
				if (d.k === 'batteryV' && v == null) v = defaults.batteryCv / 100
				input.value = v == null ? '' : String(v)
			})
			if (group === 'meter') ui.alarmCfg.set(saved.alarmCodes != null ? saved.alarmCodes : defaults.alarmCodes)
		}
		function collectMeterConfig() {
			const raw = readGroup('meter', METER_FIELDS)
			const c = { drn: '' } // 地址始终以本次连接的模组为准
			METER_FIELDS.forEach(function (d) {
				const v = raw[d.k]
				c[d.k] = d.kind === 'num' ? (v === '' ? undefined : Number(v)) : v
			})
			c.tariffCurrency = raw.tariffCurrency === '1'
			c.tariffDec = Number(raw.tariffDec)
			c.batteryCv = raw.batteryV === '' ? undefined : Math.round(Number(raw.batteryV) * 100)
			delete c.batteryV
			c.alarmCodes = ui.alarmCfg.get()
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
			const nearTop = box.scrollTop < 24
			const oldTop = box.scrollTop
			const at = entry.at || Date.now()
			const line = el('div', 'sts-sim-log-line sts-sim-lv-' + (entry.level || 'info'))
			line.appendChild(el('span', 'sts-sim-log-time', fmtTime(at)))
			line.appendChild(el('span', 'sts-sim-log-text', String(entry.text)))
			box.prepend(line)
			ui.logCount++
			while (ui.logCount > MAX_LOG && box.lastChild) {
				box.removeChild(box.lastChild)
				ui.logCount--
			}
			box.scrollTop = nearTop ? 0 : oldTop + line.offsetHeight
		}
		function plog(level, text) { appendLog({ at: Date.now(), level: level, text: text }) }
		function clearLog() {
			ui.refs.logBox.textContent = ''
			ui.logCount = 0
		}
		function applyCollapsed() {
			const r = ui.refs
			r.body.hidden = ui.collapsed
			if (!r.toggle) return
			r.toggle.setAttribute('aria-expanded', String(!ui.collapsed))
			r.toggle.chevron.className = 'bi ' + (ui.collapsed ? 'bi-chevron-right' : 'bi-chevron-down')
		}
		function setCollapsed(v) {
			if (channel === 'S') return
			ui.collapsed = !!v
			lsSet(KEY_COLLAPSED, ui.collapsed)
			applyCollapsed()
		}
		function waitText() { return '等待' + ui.name + '串口重连' }
		// 面板是否处在自己的模式且串口已打开；不在本模式时按串口不可用处理，不会去借用别的会话
		function available() {
			const api = W.serialApi
			return !!api && api.getMode() === MODE && api.isSessionOpen(channel)
		}

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
			// CIU 的目标 DRN 运行中保持可改（空闲时由引擎的 setTarget 决定是否接受）
			ui.inputs.ciu.targetDrn.disabled = ui.starting || ui.switching // 切换进行中锁住，避免第二次修改与第一次交错
			ui.alarmCfg.setDisabled(busy)
			// 表端运行值控件只在运行中可用
			const liveOn = ui.running && ui.role === 'meter'
			Object.keys(ui.live).forEach(function (k) { ui.live[k].disabled = !liveOn })
			Object.keys(ui.valveBtns).forEach(function (k) { ui.valveBtns[k].disabled = !liveOn })
			ui.valveFault.disabled = !liveOn
			ui.alarmLive.setDisabled(!liveOn)
			updateCiuButtons()
		}
		function updateCiuButtons() {
			const r = ui.refs
			const st = ui.engine && ui.role === 'ciu' ? ui.engine.getState() : null
			const idle = !!(st && st.running && st.phase === 'idle' && !ui.opBusy)
			;[r.tokenBtn, r.statusBtn, r.recBtn, r.valveOpenBtn, r.valveCloseBtn, r.unbindBtn, r.readBtn].forEach(function (b) { b.disabled = !idle })
			r.tokenInput.disabled = !(ui.running && ui.role === 'ciu')
			r.simBtn.disabled = r.tokenInput.disabled
			r.abortBtn.disabled = !(ui.running && ui.opBusy)
			r.tokenBtn.disabled = !idle || r.tokenInput.value.length !== 20
		}
		// 模拟充值令牌的单位: 原始整数按表端计价模式的最小单位计数，有数值时附换算值
		function renderSimUnit() {
			const r = ui.refs
			const t = S.SIM_TOKEN_TYPES && S.SIM_TOKEN_TYPES[r.simType.value]
			r.simUnit.hidden = !t || t.data !== 'amount'
			if (r.simUnit.hidden) return
			const st = ui.engine && ui.role === 'ciu' && ui.running ? ui.engine.getState() : null
			const tariff = st && st.tariff
			const raw = r.simData.value.trim()
			let text
			if (!tariff) text = '单位：体积 0.1 m³（100 L，STS 令牌最小粒度）/ 金额 10^-d 货币单位（启动后按表端 0x18 确定）'
			else if (/^\d{1,10}$/.test(raw)) text = '= ' + S.simAmountText(Number(raw), tariff)
			else text = '单位 ' + (tariff.currency ? S.qtyUnit(tariff) : '0.1 m³（100 L）')
			r.simUnit.textContent = text
		}
		// 阀门行: 动作中（正在开/关或恢复，剩余秒数）、关阀保持期剩余时间；剩余时间按快照时刻的剩余毫秒减去已过去的时间
		function renderValveText(s) {
			const posName = function (v) { return v === S.VALVE_POS_OPEN ? '开' : v === S.VALVE_POS_CLOSED ? '关' : '不明' }
			const since = Math.max(0, Date.now() - (s.at || Date.now()))
			let t
			if (s.valveMoving) {
				const left = Math.max(0, Math.ceil((s.valveMoving.remainMs - since) / 1000))
				t = s.valveMoving.kind === 'restore'
					? '恢复中（正在恢复到' + posName(s.valveHold ? s.valveHold.pre : s.valveMoving.target) + '，位置报不明，剩余 ' + left + ' 秒）'
					: '动作中（正在' + (s.valveMoving.target === S.VALVE_POS_OPEN ? '开' : '关') + '阀，位置报不明，剩余 ' + left + ' 秒）'
			} else {
				t = posName(s.valve & S.VALVE_POS_MASK)
				if (s.valveHold) {
					const left = Math.max(0, Math.ceil((s.valveHold.remainMs - since) / 1000))
					t += '（阀控测试保持期，剩余 ' + Math.floor(left / 60) + ' 分 ' + pad(left % 60) + ' 秒后恢复到' + posName(s.valveHold.pre) + '）'
				}
			}
			if (s.valveFault) t += '，动作故障'
			ui.refs.kv['阀门'].textContent = t
		}
		// 把引擎当前值同步到运行值控件（正在编辑的那个不动）
		// force=true: 校验失败时强制还原，连正在聚焦的控件和「其他码」框一起还原
		function syncLive(s, force) {
			const set = function (input, v) { if (force || document.activeElement !== input) input.value = v }
			set(ui.live.remaining, String(s.remaining))
			set(ui.live.totalUsed, String(s.totalUsed))
			set(ui.live.totalPurchased, String(s.totalPurchased))
			set(ui.live.batteryV, S.fmtScaled(s.batteryCv, 2))
			const pos = s.valve & S.VALVE_POS_MASK
			const cur = pos === S.VALVE_POS_OPEN ? 'open' : pos === S.VALVE_POS_CLOSED ? 'closed' : 'unknown'
			Object.keys(ui.valveBtns).forEach(function (k) { ui.valveBtns[k].setAttribute('aria-pressed', String(k === cur)) })
			ui.valveFault.checked = !!s.valveFault
			if (force || !ui.alarmLive.root.contains(document.activeElement)) ui.alarmLive.set(s.alarms.join(' '))
		}
		function renderMeterState(s) {
			const kv = ui.refs.kv
			const t = s.tariff
			kv['DRN'].textContent = s.drn || '-'
			kv['表号'].textContent = s.meterNo || '-'
			kv['剩余量'].textContent = fmtQty(s.remaining, t) + '（原始 ' + s.remaining + '）'
			kv['累计使用量'].textContent = fmtQty(s.totalUsed, { currency: false, dec: 1 })
			kv['总购买量'].textContent = fmtQty(s.totalPurchased, t)
			kv['表计状态位域'].textContent = '0x' + s.meterStatus.toString(16).toUpperCase().padStart(2, '0') + S.meterStatusText(s.meterStatus)
			renderValveText(s)
			syncLive(s)
			kv['电池'].textContent = S.fmtScaled(s.batteryCv, 2) + ' V'
			kv['告警码'].classList.add('sts-sim-alarm-summary')
			renderAlarms(kv['告警码'], s.alarms)
			renderPendingText(s)
			kv['存档'].textContent = s.archive.length ? s.archive.map(function (a) { return a.type + ' 0x' + a.tgt.toString(16).toUpperCase() }).join('，') : '空'
			const ls = s.lastSession
			kv['最近会话'].textContent = ls ? '共 ' + s.sessions + ' 次；最近一次入队 ' + ls.setUplinkMs + 'ms，自 kind=3 起 ' + ls.sinceKind3Ms + 'ms' + (ls.endReason != null ? '，终结 r' + ls.endReason + '，本会话表端确认上行 ' + ls.upDelivered + ' 片' : '') : (s.sessions ? '共 ' + s.sessions + ' 次' : '暂无')
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
				if (res.token.stsResultText) add('STS 结果', res.token.stsResultText)
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
				const hdr = ['会话', '结果', 'wake', 'send', 'ACK', '上行', '终结']
				hdr.forEach(function (h) { tb.appendChild(el('span', 'sts-sim-tl-h', h)) })
				res.sessions.forEach(function (s) {
					const tl = s.timeline || {}
					tb.appendChild(el('span', null, s.label + ' #' + s.attempt))
					tb.appendChild(el('span', s.ok ? 'is-ok' : 'is-bad', s.ok ? 'OK' : (s.reason || '失败')))
					;[tl.wakeMs, tl.sendMs, tl.ackMs, tl.upMs].forEach(function (v) { tb.appendChild(el('span', null, v == null ? '-' : String(v))) })
					// 终结 = 本轮返回前收到 EVT 0x0281 的时刻与原因；CIU 不结束会话，成功会话通常在返回后才由空闲看门狗收尾（r8），这里显示 -
					tb.appendChild(el('span', null, tl.endMs == null ? '-' : tl.endMs + ' r' + tl.endReason))
				})
				box.appendChild(tb)
			}
			box.appendChild(el('div', 'sts-sim-hint small', '总耗时 ' + (res.durationMs / 1000).toFixed(1) + ' s'))
		}
		function renderPhase() {
			const r = ui.refs
			if (!ui.engine || ui.role !== 'ciu' || !ui.running) { r.ciuLocalAddr.textContent = '待读取'; r.phase.textContent = ''; renderSimUnit(); return }
			const st = ui.engine.getState()
			r.ciuLocalAddr.textContent = st.localAddr == null ? '待读取' : st.localAddr
			const names = { idle: '空闲', session: '唤醒会话中（INIT → WAKE → SEND → 等 ACK → 等上行，会话由空闲看门狗收尾）', 'wait-poll': '等待下一次轮询' }
			let t = '阶段：' + (names[st.phase] || st.phase)
			if (st.localAddr != null) t += '；本机地址 ' + st.localAddr
			if (st.budgetLeftMs != null) t += '；总预算剩余 ' + Math.ceil(st.budgetLeftMs / 1000) + ' s'
			if (st.tariff) t += '；计价 ' + (st.tariff.currency ? '金额 d=' + st.tariff.dec : '体积 dL')
			if (st.protoVersion != null) t += '；表体协议版本 ' + st.protoVersion
			r.phase.textContent = t
			renderSimUnit()
			updateCiuButtons()
		}
		// 在飞待办的预计剩余秒数随阀门动作倒计时变化，tick 里和阀门行一起刷新，否则停在受理时的值
		function renderPendingText(s) {
			const p = s.pending
			ui.refs.kv['在飞待办'].textContent = p ? p.type + ' TGT=0x' + p.tgt.toString(16).toUpperCase() + '，预计剩余 ' + p.etaS + ' s' : '无'
		}
		function tick() {
			if (!ui.running) return
			// 串口断开: 引擎自动停止
			if (!available()) {
				plog('error', '串口已断开，模拟器自动停止')
				stopSim(waitText(), true)
				return
			}
			renderPhase()
			if (ui.engine && ui.role === 'meter') { const st = ui.engine.getState(); st.at = Date.now(); renderValveText(st); renderPendingText(st) }
		}

		// ===== 启停 =====
		function cleanup() {
			if (ui.timer != null) { clearInterval(ui.timer); ui.timer = null }
			if (ui.engine) { try { ui.engine.stop() } catch (e) { /* 忽略 */ } ui.engine = null }
			if (ui.link) { try { ui.link.close() } catch (e) { /* 忽略 */ } ui.link = null }
			ui.running = false
			ui.starting = false
			ui.opBusy = false
			ui.switching = false
			renderResult(null)
		}
		function stopSim(msg, keepWanted) {
			if (!keepWanted) {
				ui.wanted = false
				ui.retryAt = 0
				ui.retryCount = 0
				lsSet(KEY_RUNNING, false)
			}
			cleanup()
			setStatus(msg || '已停止')
			applyRunning()
			renderPhase()
		}
		async function startSim() {
			if (ui.running || ui.starting) return
			const sid = channel
			if (!available()) {
				setStatus('请先连接串口', 'is-bad')
				plog('warn', '串口未连接：请先在顶栏打开串口（115200 8N1）再启动模拟')
				return
			}
			let engine
			try {
				ui.sid = sid
				ui.link = W.hostProtoSerialLink({ sid: sid, log: function (t) { plog('info', '[链路] ' + t) } })
				if (ui.role === 'meter') {
					const cfg = collectMeterConfig()
					saveGroup('meter', METER_FIELDS, KEY_METER)
					engine = SIM.createMeterSim({ link: ui.link, clock: ui.clock, config: cfg, onLog: appendLog, onState: function (s) { s.at = Date.now(); ui.lastState = s; renderMeterState(s) } })
				} else {
					const cfg = collectCiuConfig()
					saveGroup('ciu', CIU_FIELDS, KEY_CIU)
					engine = SIM.createCiuSim({ link: ui.link, clock: ui.clock, config: cfg, onLog: appendLog, onState: function () { renderPhase() } })
				}
			} catch (e) {
				if (ui.link) { try { ui.link.close() } catch (e2) { /* 忽略 */ } ui.link = null }
				ui.wanted = false
				ui.retryAt = 0
				ui.retryCount = 0
				lsSet(KEY_RUNNING, false)
				setStatus(e.message, 'is-bad')
				plog('error', '配置错误: ' + e.message)
				applyRunning()
				return
			}
			ui.engine = engine
			renderResult(null)
			ui.ciuTarget = ui.inputs.ciu.targetDrn.value.trim()
			ui.starting = true
			ui.wanted = true
			lsSet(KEY_RUNNING, true)
			setStatus(ui.role === 'meter' ? '启动中：探活与核对模组…' : '启动中：探活、核对模组并读取计价模式与协议版本（每次读取是一次唤醒会话，需数十秒）…')
			applyRunning()
			// 日志解析按每一路自己的协议(双路两路可以不同)，提示看这一路的
			const laneProto = typeof W.protocolIdForSid === 'function' ? W.protocolIdForSid(channel) : W._activeProtocol
			if (laneProto !== 'hostproto') plog('info', channel === 'S' ? '切到顶栏「hostProto 模组」协议可在日志里看到逐帧解析' : '把' + ui.name + '的协议设为「hostProto 模组」可在日志里看到逐帧解析')
			try {
				await engine.start()
				if (ui.engine !== engine) return // 启动期间被手动停止
				if (!available()) { stopSim(waitText(), true); return }
				ui.running = true
				ui.starting = false
				ui.retryAt = 0
				ui.retryCount = 0
				ui.refs.cfg.open = false
				ui.timer = setInterval(tick, 500)
				setStatus(ui.role === 'meter' ? '表端运行中' : 'CIU 运行中', 'is-ok')
				applyRunning()
				renderPhase()
			} catch (e) {
				if (ui.engine !== engine) return
				const msg = e && e.message ? e.message : String(e)
				plog('error', '启动失败: ' + msg)
				const timedOut = e && e.code === 'timeout'
				if (timedOut) {
					ui.retryCount++
					ui.retryAt = Date.now() + Math.min(30000, 5000 * Math.pow(2, Math.min(ui.retryCount - 1, 3)))
				}
				stopSim('启动失败: ' + msg, timedOut || !available())
				ui.refs.status.classList.add('is-bad')
			}
		}

		// ===== CIU 操作 =====
		async function runCiu(fn) {
			if (!ui.engine || !ui.running || ui.opBusy) return
			ui.opBusy = true
			const engine = ui.engine
			updateCiuButtons()
			renderResult(null)
			try {
				const res = await fn(engine)
				if (ui.engine !== engine) return
				renderResult(res)
				plog(res.ok ? 'info' : 'warn', '[' + res.op + '] ' + (res.ok ? '成功' : '未成功') + '：' + res.message)
			} catch (e) {
				if (ui.engine !== engine) return
				plog('error', '操作异常: ' + (e && e.message ? e.message : e))
			} finally {
				if (ui.engine === engine) {
					ui.opBusy = false
					updateCiuButtons()
					renderPhase()
				}
			}
		}
		function parseRegId(v) {
			const s = String(v).trim()
			const n = /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10)
			return Number.isFinite(n) && n >= 0 && n <= 0xff ? n : null
		}

		function applyLive(patch) {
			if (!ui.engine || ui.role !== 'meter' || !ui.running) return
			try {
				ui.engine.setLive(patch)
			} catch (e) {
				plog('warn', '运行值未修改: ' + e.message)
				setStatus(e.message, 'is-bad')
				syncLive(ui.engine.getState(), true)
				return
			}
			syncLive(ui.engine.getState())
		}
		// CIU 运行中切换目标 DRN: 引擎只在空闲时接受；被拒时把输入框还原为当前目标。
		// 目标 DRN 本身就是这份配置的一项，切换成功后照常存盘
		async function switchTarget() {
			const input = ui.inputs.ciu.targetDrn
			const want = input.value.trim()
			const before = ui.ciuTarget
			const eng = ui.engine // 捕获当前引擎: await 之后引擎已换或已停止就不再写状态、不存配置
			const stale = function () { return ui.engine !== eng || !ui.running }
			ui.switching = true
			applyRunning()
			try {
				const r = await eng.setTarget(want)
				if (stale()) return
				// 回填并保存引擎实际接受的目标（规范化后的值），不读表单上此刻的内容
				const accepted = (r && r.targetDrn) || want
				ui.ciuTarget = accepted
				renderResult(null)
				input.value = accepted
				saveGroup('ciu', CIU_FIELDS, KEY_CIU)
				if (r && r.basicsOk === false) setStatus('目标表已切换，基础信息读取失败（下次操作前会自动重读）', 'is-bad')
				else setStatus('目标表已切换', 'is-ok')
			} catch (e) {
				if (stale() || (e && e.code === 'aborted')) return
				plog('warn', '目标表未切换: ' + e.message)
				setStatus(e.message, 'is-bad')
				input.value = before || ''
			} finally {
				if (!stale()) {
					ui.switching = false
					applyRunning()
				}
			}
			updateCiuButtons()
			renderPhase()
		}

		function bind() {
			const r = ui.refs
			r.bMeter.addEventListener('click', function () { ui.role = 'meter'; lsSet(KEY_ROLE, ui.role); applyRole() })
			r.bCiu.addEventListener('click', function () { ui.role = 'ciu'; lsSet(KEY_ROLE, ui.role); applyRole() })
			r.startBtn.addEventListener('click', function () {
				if (ui.running || ui.starting || ui.wanted) { plog('info', '手动停止'); stopSim('已停止') } else startSim()
			})
			r.clearBtn.addEventListener('click', clearLog)
			if (r.toggle) r.toggle.addEventListener('click', function () { setCollapsed(!ui.collapsed) })
			Object.keys(ui.inputs.meter).forEach(function (k) {
				ui.inputs.meter[k].addEventListener('change', function () { saveGroup('meter', METER_FIELDS, KEY_METER); applyRole() })
			})
			ui.alarmCfg.root.addEventListener('change', function () { saveGroup('meter', METER_FIELDS, KEY_METER) })
			Object.keys(ui.inputs.ciu).forEach(function (k) {
				ui.inputs.ciu[k].addEventListener('change', function () {
					if (k === 'targetDrn' && ui.running && ui.engine) { switchTarget(); return }
					saveGroup('ciu', CIU_FIELDS, KEY_CIU)
				})
			})
			// 表端运行值: 每个控件改完立即调引擎，校验失败时提示并回退到引擎当前值
			Object.keys(ui.live).forEach(function (k) {
				ui.live[k].addEventListener('change', function () {
					const v = ui.live[k].value
					if (v === '') { syncLive(ui.engine.getState(), true); return }
					applyLive(k === 'batteryV' ? { batteryCv: Math.round(Number(v) * 100) } : { [k]: Number(v) })
				})
			})
			const alarmChange = function () { applyLive({ alarmCodes: ui.alarmLive.get() }) }
			Object.keys(ui.alarmLive.checks).forEach(function (c) { ui.alarmLive.checks[c].addEventListener('change', alarmChange) })
			ui.alarmLive.other.addEventListener('change', alarmChange)
			Object.keys(ui.valveBtns).forEach(function (k) {
				ui.valveBtns[k].addEventListener('click', function () {
					if (ui.engine && ui.role === 'meter') { ui.engine.setValve(k); syncLive(ui.engine.getState()) }
				})
			})
			ui.valveFault.addEventListener('change', function () {
				if (ui.engine && ui.role === 'meter') ui.engine.setValveFault(ui.valveFault.checked)
			})
			r.tokenInput.addEventListener('input', function () {
				r.tokenInput.value = r.tokenInput.value.replace(/\D/g, '').slice(0, 20) // 只接受数字
				updateCiuButtons()
			})
			// 序号从随机值起步并逐次递增: 同一页面里反复生成不会撞上表端的去重 / 已用记录
			let simSerial = Math.floor(Math.random() * 9000) + 1
			const simHint = function () {
				const t = S.SIM_TOKEN_TYPES && S.SIM_TOKEN_TYPES[r.simType.value]
				const k = t ? t.data : null
				r.simData.disabled = !k
				r.simData.placeholder = k === 'amount' ? '充值量' : k === 'bits' ? '位图 HEX，如 20001' : k === 'code' ? '1/2/3/6/255' : '无需数据'
			}
			r.simType.addEventListener('change', function () { simHint(); renderSimUnit() })
			r.simData.addEventListener('input', renderSimUnit)
			simHint()
			renderSimUnit()
			r.simBtn.addEventListener('click', function () {
				const t = S.SIM_TOKEN_TYPES[r.simType.value]
				const raw = r.simData.value.trim()
				let data = 0
				if (t.data === 'bits') {
					if (!/^(0x)?[0-9a-fA-F]{1,8}$/i.test(raw)) { plog('warn', '测试位图需 1..8 位 HEX'); return }
					data = parseInt(raw.replace(/^0x/i, ''), 16)
				} else if (t.data) {
					if (!/^\d{1,10}$/.test(raw)) { plog('warn', '模拟令牌数据需为十进制整数'); return }
					data = Number(raw)
				}
				let tok
				try { tok = S.simTokenEncode({ type: r.simType.value, serial: simSerial, data: data }) } catch (e) { plog('warn', e.message); return }
				simSerial = simSerial >= 9999 ? 1 : simSerial + 1
				r.tokenInput.value = tok
				updateCiuButtons()
				const st = ui.engine && ui.role === 'ciu' ? ui.engine.getState() : null
				plog('info', '已生成 ' + S.simTokenText(S.simTokenDecode(tok), st && st.tariff) + ': ' + tok)
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
			applyCollapsed()
			applyRunning()
			setStatus(ui.wanted ? waitText() : '未启动')
			return root
		}
		const root = init()
		return {
			root: root,
			channel: channel,
			setCollapsed: setCollapsed,
			setLabel: function (label) {
				const base = channel === 'S' ? '单路' : channel + '路'
				const title = channel === 'S' || !label || label === base || label === channel ? base : base + ' · ' + label
				if (title === ui.title) return
				ui.title = title
				ui.refs.nameEl.textContent = title
				ui.refs.logTitle.textContent = title + ' 日志 · 最新在前'
			},
			poll: function () {
				const api = W.serialApi
				const usable = available()
				if ((ui.running || ui.starting) && (!api || ui.sid !== channel || !usable)) stopSim(waitText(), true)
				if (ui.wanted && !ui.running && !ui.starting && Date.now() >= ui.retryAt && usable) startSim()
				if (ui.wanted && !ui.running && !ui.starting) {
					const retrying = ui.retryAt > Date.now() && usable
					ui.refs.startText.textContent = retrying ? '取消重试' : '取消等待'
					ui.refs.startIcon.className = 'bi bi-hourglass-split'
					ui.refs.startBtn.setAttribute('aria-pressed', 'true')
					if (retrying) setStatus('模组暂未应答，' + Math.ceil((ui.retryAt - Date.now()) / 1000) + ' 秒后自动重试', 'is-bad')
				}
				return ui.title + ' · ' + (ui.role === 'meter' ? '表端' : 'CIU') + ' · ' + (ui.running ? '运行中' : ui.starting ? '启动中' : ui.wanted ? (ui.retryAt > Date.now() ? '待重试' : '待重连') : '已停止')
			},
		}
	}

	const W = window
	if (!W.stsSim || !W.hostProtoSerialLink || typeof document === 'undefined') return
	function mk(tag, cls, text) {
		const e = document.createElement(tag)
		if (cls) e.className = cls
		if (text != null) e.textContent = text
		return e
	}

	const root = mk('div', 'tab-pane d-flex flex-column wb-pane-scroll sts-sim')
	root.id = 'wb-pane-sts-sim'
	root.setAttribute('role', 'tabpanel')

	const help = mk('details', 'sts-sim-card')
	help.appendChild(mk('summary', null, '接线与刷新说明'))
	help.appendChild(mk('div', 'sts-sim-hint small', '单路与双路是不同的串口，各自独立保存配置。双路模式下 A路 / B路 并排（窄栏时上下堆叠）显示，独立设置角色、启停与日志，支持 CIU + 表端或两路表端，需分别连接两个 hostProto 模组。运行时保持本页在前台，不要让其他工具占用同一串口。'))
	help.appendChild(mk('div', 'sts-sim-hint small', '刷新后等待对应串口重连，再自动重新启动。使用配置初值，不恢复运行值、充值记录、阀门保持期或在飞事务。PAK 不保存；需要认证时重新输入并手动启动。'))

	const panels = {}
	;['S', 'A', 'B'].forEach(function (sid) { panels[sid] = createPanel(sid) })

	// ===== 双路摘要条: 窄栏上下堆叠时显示，点击展开并定位到对应面板 =====
	const dualbar = mk('div', 'sts-sim-dualbar')
	const summary = mk('div', 'sts-sim-summary')
	summary.setAttribute('role', 'group')
	summary.setAttribute('aria-label', '双路状态摘要')
	const summaryItems = {}
	;['A', 'B'].forEach(function (sid) {
		const b = mk('button', 'sts-sim-summary-item')
		b.type = 'button'
		b.addEventListener('click', function () {
			panels[sid].setCollapsed(false)
			const node = panels[sid].root
			if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
		})
		summaryItems[sid] = b
		summary.appendChild(b)
	})
	dualbar.appendChild(summary)

	const grid = mk('div', 'sts-sim-grid')
	;['S', 'A', 'B'].forEach(function (sid) { grid.appendChild(panels[sid].root) })

	root.append(help, dualbar, grid)

	function readLabel(fn) {
		try { const hub = W.SerialHub; return hub && typeof hub[fn] === 'function' ? String(hub[fn]() || '') : '' } catch (e) { return '' }
	}
	function refresh() {
		const dual = !!(W.serialApi && W.serialApi.getMode() === 'dual')
		panels.A.setLabel(readLabel('getLabelA'))
		panels.B.setLabel(readLabel('getLabelB'))
		Object.keys(panels).forEach(function (sid) {
			const text = panels[sid].poll()
			if (summaryItems[sid] && summaryItems[sid].textContent !== text) summaryItems[sid].textContent = text
			const hide = sid === 'S' ? dual : !dual
			if (panels[sid].root.hidden !== hide) panels[sid].root.hidden = hide
		})
		// 每 500ms 跑一次：值没变就不写 DOM，免得反复触发样式重算和属性观察器
		if (dualbar.hidden !== !dual) dualbar.hidden = !dual
		if (!grid.classList.contains(dual ? 'is-dual' : 'is-single')) {
			grid.classList.remove('is-dual', 'is-single')
			grid.classList.add(dual ? 'is-dual' : 'is-single')
		}
		syncProtocol()
	}

	// 打开面板时把当前模式下每一路(单路 S，双路 A 与 B)的协议都切到 hostproto，关闭后按路恢复打开前的协议：
	// 只切顶栏的话双路里非主发那一路仍按原协议解析。打开前的协议按路存 localStorage({ S | A | B: id })，
	// 面板开着刷新页面后关闭仍能恢复；面板开着时进入双路，新出现的路也切过去；期间用户手动换过某一路就尊重用户选择，不再恢复。
	// 没有 serialLanes(按路协议接口)时退回只切顶栏。改顶栏后必须派发 change：common.js 与各协议模块都只在 change 里切换解析器和持久化。
	const KEY_PREV_PROTO = 'stsSim.prevProtocol'
	let panelShown = false
	let laneApplied = {}
	function setProtocol(sel, value) {
		if (sel.value === value || !Array.prototype.some.call(sel.options, function (o) { return o.value === value })) return
		sel.value = value
		sel.dispatchEvent(new Event('change', { bubbles: true }))
	}
	function readPrevLanes() {
		const v = JSON.parse(localStorage.getItem(KEY_PREV_PROTO) || 'null')
		if (typeof v === 'string') return { S: v } // 升级前只记顶栏一个值
		return v && typeof v === 'object' ? v : {}
	}
	function syncLaneProtocols(sel, shown) {
		const lanes = W.serialLanes
		const has = Array.prototype.some.call(sel.options, function (o) { return o.value === 'hostproto' })
		if (shown) {
			panelShown = true
			if (!has) return
			const api = W.serialApi
			const visible = api && api.getMode() === 'dual' ? ['A', 'B'] : ['S']
			let prev = {}
			try { prev = readPrevLanes() } catch (e) { /* 存储不可用时只做切换，不记忆 */ }
			let changed = false
			visible.forEach(function (sid) {
				if (laneApplied[sid]) return
				laneApplied[sid] = true
				const cur = lanes.protocolOf(sid)
				if (!cur || cur === 'hostproto') return
				if (!Object.prototype.hasOwnProperty.call(prev, sid)) prev[sid] = cur
				changed = true
				lanes.setProtocol(sid, 'hostproto')
			})
			if (changed) {
				try { localStorage.setItem(KEY_PREV_PROTO, JSON.stringify(prev)) } catch (e) { /* 同上 */ }
			}
			return
		}
		if (!panelShown) return
		panelShown = false
		laneApplied = {}
		let prev = {}
		try {
			prev = readPrevLanes()
			localStorage.removeItem(KEY_PREV_PROTO)
		} catch (e) { /* 同上 */ }
		Object.keys(prev).forEach(function (sid) {
			if (prev[sid] && lanes.protocolOf(sid) === 'hostproto') lanes.setProtocol(sid, prev[sid])
		})
	}
	function syncProtocol() {
		const wb = W.Workbench
		const sel = document.getElementById('serial-protocol-select')
		if (!wb || typeof wb.isShown !== 'function' || !sel) return
		const shown = wb.isShown('sts-sim')
		if (W.serialLanes && typeof W.serialLanes.setProtocol === 'function') {
			syncLaneProtocols(sel, shown)
			return
		}
		if (shown === panelShown) return
		panelShown = shown
		try {
			if (shown) {
				if (sel.value !== 'hostproto') localStorage.setItem(KEY_PREV_PROTO, JSON.stringify(sel.value))
				setProtocol(sel, 'hostproto')
			} else {
				const prev = JSON.parse(localStorage.getItem(KEY_PREV_PROTO) || 'null')
				localStorage.removeItem(KEY_PREV_PROTO)
				if (prev && sel.value === 'hostproto') setProtocol(sel, prev)
			}
		} catch (e) { /* 存储不可用时只做切换，不记忆 */ if (shown) setProtocol(sel, 'hostproto') }
	}
	// 停靠栏按钮、关闭按钮都是点击触发，这里跟一次，免得等 500ms 轮询
	if (typeof document.addEventListener === 'function') document.addEventListener('click', function () { setTimeout(syncProtocol, 0) })
	refresh()
	setInterval(refresh, 500)

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

	register(root)
})()
