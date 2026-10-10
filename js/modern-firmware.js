// 现代布局 · 固件页：把「固件打包」与「固件升级」重建为一条四步流水线（选择固件 → 生成升级包 → 升级 → 校验）。
// 打包与升级的业务逻辑仍在 firmware-packager.js / firmware-upgrade.js：这里只订阅它们派发的只读事件
// （document 上的 fw-pack / fw-upgrade）维护一份界面模型，并把原控件节点原样搬进新结构（不克隆，搬之前留注释占位，
// 切回经典布局按占位放回、新建的 DOM 全部删掉）。新增的控件（结果列表、下载、「用此包升级」、校验页的查询键）
// 只驱动现有逻辑：window.setFwUpgradeFile、FirmwarePackager.downloadBlob、点击原 #fw-query。
// 纯函数（版本识别、分块状态、阶段推导、统计）同时导出给 node 回归测试，不碰 DOM。
;(function () {
	'use strict'
	const root = typeof window !== 'undefined' ? window : globalThis

	const HEADER_SIZE = 128
	const RAW_INFO_OFFSET = 0x4000

	// ---------- 纯函数 ----------

	function fmtSize(bytes) {
		if (!(bytes >= 0)) return '--'
		if (bytes < 1024) return bytes + ' B'
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
		return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
	}

	function fmtRate(bytesPerSec) {
		if (!(bytesPerSec > 0) || !isFinite(bytesPerSec)) return '--'
		if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s'
		return (bytesPerSec / 1024).toFixed(1) + ' KB/s'
	}

	function fmtEta(sec) {
		if (!(sec >= 0) || !isFinite(sec)) return '--:--'
		const s = Math.round(sec)
		const mm = Math.floor(s / 60)
		const ss = s % 60
		return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0')
	}

	/**
	 * 裸固件(.bin)里嵌的版本：与打包器写进包头 newFileInfo 的那 32 字节同源（取 0x4000 起），
	 * 布局同 FirmwareParser：前 4 字节时间戳，之后到 20 字节为版本串(遇 0 结束)。
	 * 取不到或不是可见 ASCII 就返回 null，不去猜
	 */
	function embeddedVersion(data) {
		if (!data || data.length < RAW_INFO_OFFSET + 0x20) return null
		let s = ''
		for (let i = RAW_INFO_OFFSET + 4; i < RAW_INFO_OFFSET + 20; i++) {
			const b = data[i]
			if (b === 0) break
			if (b < 0x20 || b > 0x7e) return null
			s += String.fromCharCode(b)
		}
		return s.length ? s : null
	}

	function sameVersion(a, b) {
		if (a == null || b == null) return false
		return String(a).trim() === String(b).trim() && String(a).trim() !== ''
	}

	/** 产物大小相对原始包(包头 + 新固件)的比例，没有基准返回 null */
	function ratioOf(size, base) {
		if (!(base > 0) || !(size >= 0)) return null
		return size / base
	}

	// 分块格子：state 0 待发 / 1 进行中 / 2 已确认；retried 记「重发过」
	function newGrid(total) {
		return { total: total, state: new Uint8Array(total), retried: new Uint8Array(total), active: -1 }
	}

	/** 设备请求某块：上一块视为已确认(设备没再要它)，这一块进入进行中；同一块被再次请求即重发 */
	function gridRequest(g, index, resend) {
		if (!g || index < 0 || index >= g.total) return
		if (g.active >= 0 && g.active !== index) g.state[g.active] = 2
		if (resend) g.retried[index] = 1
		g.state[index] = 1
		g.active = index
	}

	function gridFinish(g) {
		if (!g) return
		if (g.active >= 0) g.state[g.active] = 2
		g.active = -1
	}

	function gridCounts(g) {
		const c = { done: 0, retried: 0, active: 0, pending: 0 }
		if (!g) return c
		for (let i = 0; i < g.total; i++) {
			const st = g.state[i]
			if (st === 1) c.active++
			else if (st === 2) {
				if (g.retried[i]) c.retried++
				else c.done++
			} else c.pending++
		}
		return c
	}

	/** 格子太多画不下时，每 per 个分块合成一格：含进行中为进行中，全部已确认才算已确认(含重发则标重发)，其余待发 */
	function gridBucket(g, from, to) {
		let allDone = true
		let anyRetry = false
		for (let i = from; i < to; i++) {
			const st = g.state[i]
			if (st === 1) return 1
			if (st !== 2) allDone = false
			else if (g.retried[i]) anyRetry = true
		}
		if (!allDone) return 0
		return anyRetry ? 3 : 2
	}

	function newModel() {
		return {
			pack: { old: null, nw: null, running: false, outputs: [], zip: null, selected: -1, notice: null, errors: 0, aborted: false, ran: false, base: null, lastLog: '' },
			up: {
				file: null, parsed: null, running: false, phase: '', percent: 0, plan: null, grid: null, sent: 0,
				tTransfer: 0, tEnd: 0, outcome: null, error: '', pre: null, post: null, querying: false, queryError: '', notice: null, lastLog: '',
			},
		}
	}

	function reducePack(m, e, now) {
		const p = m.pack
		switch (e.type) {
			case 'file': {
				const key = e.which === 'old' ? 'old' : (e.which === 'new' ? 'nw' : null)
				if (!key) break
				p.notice = null
				p[key] = e.data ? { name: e.name, size: e.size, version: embeddedVersion(e.data) } : null
				break
			}
			case 'start':
				p.running = true
				p.outputs = []
				p.zip = null
				p.selected = -1
				p.errors = 0
				p.notice = null
				p.aborted = false
				p.ran = true
				p.base = p.nw ? HEADER_SIZE + p.nw.size : null
				break
			case 'output':
				p.outputs.push({ idx: e.idx, name: e.name, size: e.size, kind: e.kind, base: p.base })
				if (p.selected < 0) p.selected = 0
				break
			case 'zip':
				p.zip = { name: e.name, size: e.size, count: e.count }
				break
			case 'log':
				p.lastLog = e.msg
				if (e.level === 'error' || e.level === 'warn') p.notice = { msg: e.msg, level: e.level }
				if (e.level === 'error' && p.running) p.errors++
				break
			case 'end':
				p.running = false
				p.aborted = !!e.aborted
				break
		}
		return m
	}

	function reduceUpgrade(m, e, now) {
		const u = m.up
		switch (e.type) {
			case 'file-set':
				u.file = { name: e.name, size: e.size }
				if (!u.running) resetRun(u)
				break
			case 'file-clear':
				u.file = null
				u.parsed = null
				if (!u.running) {
					resetRun(u)
					u.plan = null
					u.grid = null
				}
				break
			case 'parsed':
				u.parsed = e.ok ? { version: e.version, raw: !!e.raw, pkgType: e.pkgType || '', size: e.size } : { error: e.error || '', ok: false }
				if (e.ok) u.parsed.ok = true
				if (!e.ok && !u.running) { u.plan = null; u.grid = null }
				break
			case 'query-start':
				u.querying = true
				u.queryError = ''
				break
			case 'device-version':
				u.querying = false
				if (!e.ok) { u.queryError = e.error || '失败'; break }
				u.queryError = ''
				if (e.source === 'query' && u.outcome === 'ok') u.post = e.version
				else { u.pre = e.version; u.post = null }
				break
			case 'start':
				u.running = true
				u.outcome = null
				u.error = ''
				u.notice = null
				u.pre = null
				u.post = null
				u.percent = 0
				u.sent = 0
				u.phase = 'query'
				u.tTransfer = 0
				u.tEnd = 0
				break
			case 'plan':
				u.plan = { version: e.version, chunkSize: e.chunkSize, totalChunks: e.totalChunks, size: e.size }
				u.grid = newGrid(e.totalChunks)
				u.sent = 0
				break
			case 'phase':
				u.phase = e.name
				if (e.name === 'transfer') u.tTransfer = now
				if (e.name === 'result' || e.name === 'execute') gridFinish(u.grid)
				break
			case 'request':
				gridRequest(u.grid, e.index, e.resend)
				break
			case 'chunk':
				u.sent = e.sent
				if (e.resend && u.grid && e.index < u.grid.total) u.grid.retried[e.index] = 1
				break
			case 'progress':
				u.percent = e.percent
				break
			case 'log':
				u.lastLog = e.msg
				if (e.level === 'error' || e.level === 'warn') u.notice = { msg: e.msg, level: e.level }
				break
			case 'end':
				u.running = false
				u.phase = ''
				u.tEnd = now
				u.outcome = e.ok ? 'ok' : (e.stopped ? 'stopped' : 'failed')
				u.error = e.error || ''
				if (e.ok) gridFinish(u.grid)
				break
		}
		return m
	}

	// 换了文件：上一轮的结果、版本与分块都不再属于它
	function resetRun(u) {
		u.outcome = null
		u.error = ''
		u.notice = null
		u.post = null
		u.pre = null
		u.percent = 0
		u.sent = 0
		u.plan = null
		u.grid = null
		u.phase = ''
	}

	/** 还没开始升级时，按已解析的固件与当前分片大小预排分块格子 */
	function previewPlan(m, chunkSize) {
		const u = m.up
		if (u.running || u.outcome) return
		if (!u.parsed || !u.parsed.ok || !(u.parsed.size > 0)) return
		const cs = chunkSize > 0 ? chunkSize : 128
		const total = Math.ceil(u.parsed.size / cs)
		if (u.grid && u.grid.total === total && u.plan && u.plan.chunkSize === cs) return
		u.plan = { version: u.parsed.version, chunkSize: cs, totalChunks: total, size: u.parsed.size, preview: true }
		u.grid = newGrid(total)
		u.sent = 0
	}

	function targetVersion(m) {
		const u = m.up
		if (u.plan && !u.plan.preview && (u.running || u.outcome)) return u.plan.version
		return u.parsed && u.parsed.ok ? u.parsed.version : null
	}

	/** 传输速率与剩余时间(按本轮传输开始以来的平均速度，含重发耗时) */
	function computeStats(m, now) {
		const u = m.up
		const out = { rate: null, eta: null }
		if (!u.plan || !u.sent || !u.tTransfer) return out
		const end = u.running ? now : (u.tEnd || now)
		const elapsed = (end - u.tTransfer) / 1000
		if (!(elapsed > 0)) return out
		out.rate = u.sent * u.plan.chunkSize / elapsed
		if (u.running && u.phase === 'transfer') out.eta = (u.plan.totalChunks - u.sent) * (elapsed / u.sent)
		return out
	}

	const PHASE_TEXT = {
		query: '查询设备版本',
		notify: '通知设备新版本',
		transfer: '传输分块',
		result: '等待设备下载结果',
		execute: '发送升级命令',
	}

	function shortMsg(s, n) {
		s = String(s || '')
		return s.length > n ? s.slice(0, n - 1) + '…' : s
	}

	/** 四步状态：done / active / waiting / failed，附一句摘要，全部从模型派生 */
	function deriveStages(m) {
		const p = m.pack
		const u = m.up
		const st = []

		// 1 选择固件
		if (p.nw) {
			const nv = p.nw.version
			const ov = p.old ? p.old.version : null
			let sum
			if (p.old) sum = (ov || shortMsg(p.old.name, 18)) + ' → ' + (nv || shortMsg(p.nw.name, 18))
			else sum = nv ? '新固件 ' + nv : shortMsg(p.nw.name, 28)
			st.push({ key: 'select', name: '选择固件', state: 'done', summary: sum })
		} else if (u.file) {
			st.push({ key: 'select', name: '选择固件', state: 'done', summary: '直接载入升级包' })
		} else {
			st.push({ key: 'select', name: '选择固件', state: 'waiting', summary: '未选择新固件' })
		}

		// 2 生成升级包
		if (p.running) {
			st.push({ key: 'pack', name: '生成升级包', state: 'active', summary: '生成中，已出 ' + p.outputs.length + ' 个' })
		} else if (p.outputs.length) {
			st.push({ key: 'pack', name: '生成升级包', state: 'done', summary: p.outputs.length + ' 个产物' + (p.errors ? ' · ' + p.errors + ' 项失败' : '') })
		} else if (p.ran && p.errors && !p.aborted) {
			st.push({ key: 'pack', name: '生成升级包', state: 'failed', summary: p.notice ? shortMsg(p.notice.msg, 36) : '生成失败' })
		} else if (p.ran && p.aborted) {
			st.push({ key: 'pack', name: '生成升级包', state: 'waiting', summary: '已取消' })
		} else if (!p.nw && u.file) {
			st.push({ key: 'pack', name: '生成升级包', state: 'done', summary: '已跳过' })
		} else {
			st.push({ key: 'pack', name: '生成升级包', state: 'waiting', summary: p.nw ? '待生成' : '先选择新固件' })
		}

		// 3 升级
		if (u.running) {
			let sum = PHASE_TEXT[u.phase] || '升级中'
			if (u.phase === 'transfer' && u.plan) sum += ' ' + u.sent + '/' + u.plan.totalChunks
			st.push({ key: 'upgrade', name: '升级', state: 'active', summary: sum + ' · ' + u.percent + '%' })
		} else if (u.outcome === 'ok') {
			st.push({ key: 'upgrade', name: '升级', state: 'done', summary: '升级命令已发出' })
		} else if (u.outcome === 'failed') {
			st.push({ key: 'upgrade', name: '升级', state: 'failed', summary: u.error ? shortMsg(u.error, 36) : '升级失败' })
		} else if (u.outcome === 'stopped') {
			st.push({ key: 'upgrade', name: '升级', state: 'waiting', summary: '已停止 · ' + u.percent + '%' })
		} else if (u.parsed && u.parsed.ok === false && u.file) {
			st.push({ key: 'upgrade', name: '升级', state: 'failed', summary: '固件解析失败' })
		} else if (u.file) {
			st.push({ key: 'upgrade', name: '升级', state: 'waiting', summary: '已载入 ' + shortMsg(u.file.name, 24) })
		} else {
			st.push({ key: 'upgrade', name: '升级', state: 'waiting', summary: '未载入升级包' })
		}

		// 4 校验
		const target = targetVersion(m)
		if (u.querying && u.outcome === 'ok') {
			st.push({ key: 'verify', name: '校验', state: 'active', summary: '查询中' })
		} else if (u.outcome === 'ok' && u.post != null) {
			if (target != null && sameVersion(u.post, target)) st.push({ key: 'verify', name: '校验', state: 'done', summary: '一致 · ' + u.post })
			else if (target != null) st.push({ key: 'verify', name: '校验', state: 'failed', summary: '不一致 · ' + u.post + ' ≠ ' + target })
			else st.push({ key: 'verify', name: '校验', state: 'waiting', summary: '设备版本 ' + u.post })
		} else if (u.outcome === 'ok') {
			st.push({ key: 'verify', name: '校验', state: 'waiting', summary: '待查询升级后版本' })
		} else {
			st.push({ key: 'verify', name: '校验', state: 'waiting', summary: '升级完成后查询' })
		}
		return st
	}

	const pure = {
		HEADER_SIZE, fmtSize, fmtRate, fmtEta, embeddedVersion, sameVersion, ratioOf,
		newGrid, gridRequest, gridFinish, gridCounts, gridBucket,
		newModel, reducePack, reduceUpgrade, previewPlan, targetVersion, computeStats, deriveStages,
	}
	root.ModernFirmware = pure
	if (typeof document === 'undefined') return

	// ---------- 界面（仅现代布局） ----------

	const $ = function (id) { return document.getElementById(id) }
	const model = newModel()
	const KIND_LABEL = { origin: '原始包', compress: '压缩包', 'diff-fwd': '差分包（旧→新）', 'diff-rev': '差分包（新→旧）' }
	const STATE_LABEL = { done: '完成', active: '进行中', waiting: '等待', failed: '失败' }
	const STATE_MARK = { done: '✓', failed: '!', active: '', waiting: '' }

	let ui = null
	let parked = []
	let added = []
	let timer = 0
	let raf = 0
	let ro = null
	let themeMo = null

	function chunkInputValue() {
		const i = $('fw-chunk-size')
		return i ? parseInt(i.value, 10) || 128 : 128
	}

	function h(tag, cls, text) {
		const n = document.createElement(tag)
		if (cls) n.className = cls
		if (text != null) n.textContent = text
		return n
	}

	function park(node, parent, before) {
		if (!node || !node.parentNode || !parent) return false
		const ph = document.createComment('layout-origin:mdn-fw:' + (node.id || node.className))
		node.parentNode.insertBefore(ph, node)
		parked.push([node, ph])
		parent.insertBefore(node, before || null)
		return true
	}

	// 折叠区：按钮只管 aria-expanded 与 hidden，正文里放原节点
	function fold(title) {
		const wrap = h('div', 'mdn-fw-fold')
		const btn = h('button', 'mdn-fw-fold-btn')
		btn.type = 'button'
		btn.setAttribute('aria-expanded', 'false')
		const caret = h('i', 'bi bi-chevron-right mdn-fw-fold-caret')
		caret.setAttribute('aria-hidden', 'true')
		const last = h('span', 'mdn-fw-fold-last')
		btn.append(caret, h('span', 'mdn-fw-fold-title', title), last)
		const region = h('div', 'mdn-fw-fold-body')
		region.hidden = true
		btn.addEventListener('click', function () {
			const open = btn.getAttribute('aria-expanded') !== 'true'
			btn.setAttribute('aria-expanded', String(open))
			region.hidden = !open
			if (open) {
				const pre = region.querySelector('pre')
				if (pre) pre.scrollTop = pre.scrollHeight
			}
		})
		wrap.append(btn, region)
		return { el: wrap, last: last, btn: btn, region: region }
	}

	function card(n, title, sub) {
		const sec = h('section', 'mdn-fw-card')
		sec.dataset.step = String(n)
		const head = h('div', 'mdn-fw-card-head')
		const cap = h('h3', 'mdn-fw-cap', n + ' · ' + title)
		cap.id = 'mdn-fw-cap-' + n
		sec.setAttribute('aria-labelledby', cap.id)
		head.appendChild(cap)
		let subEl = null
		if (sub != null) {
			subEl = h('span', 'mdn-fw-cap-sub', sub)
			head.appendChild(subEl)
		}
		sec.appendChild(head)
		return { el: sec, sub: subEl }
	}

	function note() {
		const n = h('div', 'mdn-fw-note')
		n.setAttribute('role', 'status')
		n.hidden = true
		return n
	}

	function build() {
		const rootEl = h('section', 'mdn-fw')
		rootEl.id = 'mdn-fw'
		rootEl.setAttribute('aria-label', '固件打包与升级流水线')

		// 顶部四步进度条
		const steps = h('ol', 'mdn-fw-steps')
		const stepEls = []
		;['选择固件', '生成升级包', '升级', '校验'].forEach(function (name, i) {
			const li = h('li', 'mdn-fw-step')
			const badge = h('span', 'mdn-fw-step-badge', String(i + 1))
			badge.setAttribute('aria-hidden', 'true')
			const txt = h('div', 'mdn-fw-step-text')
			const top = h('div', 'mdn-fw-step-top')
			const nm = h('span', 'mdn-fw-step-name', name)
			const stt = h('span', 'mdn-fw-step-state')
			top.append(nm, stt)
			const sum = h('div', 'mdn-fw-step-sum')
			txt.append(top, sum)
			li.append(badge, txt)
			steps.appendChild(li)
			stepEls.push({ li: li, badge: badge, state: stt, sum: sum })
		})
		const cards = h('div', 'mdn-fw-cards')

		// 卡片 1：选择固件
		const c1 = card(1, '选择固件')
		const slots = {}
		;[['old', 'fp-drop-old'], ['nw', 'fp-drop-new']].forEach(function (pair) {
			const slot = h('div', 'mdn-fw-slot')
			slot.dataset.which = pair[0]
			const node = $(pair[1])
			park(node, slot)
			const detail = node ? node.querySelector('.fw-file-detail') : null
			let ver = null
			if (detail) {
				ver = h('span', 'mdn-fw-ver')
				ver.hidden = true
				detail.appendChild(ver)
				added.push(ver)
			}
			slots[pair[0]] = { ver: ver }
			c1.el.appendChild(slot)
		})
		const blankSlot = h('div', 'mdn-fw-slot mdn-fw-slot--blank')
		park($('fp-blank-row'), blankSlot)
		c1.el.appendChild(blankSlot)
		const ud = $('fp-user-define')
		const udSlot = h('div', 'mdn-fw-slot')
		park(ud ? ud.closest('.fw-config-item') : null, udSlot)
		c1.el.appendChild(udSlot)
		c1.el.appendChild(h('p', 'mdn-fw-hint', '也可以跳过打包，直接把现成的升级包拖进第 3 步的固件文件框。'))

		// 卡片 2：生成升级包
		const c2 = card(2, '生成升级包')
		const typesSlot = h('div', 'mdn-fw-slot')
		const origin = $('fp-gen-origin')
		park(origin ? origin.closest('.fw-config-item') : null, typesSlot)
		c2.el.appendChild(typesSlot)
		const genRow = h('div', 'mdn-fw-genrow')
		const zip = $('fp-gen-zip')
		park(zip ? zip.closest('.ctl-switch') : null, genRow)
		park($('fp-start'), genRow)
		c2.el.appendChild(genRow)
		const packNote = note()
		c2.el.appendChild(packNote)
		const list = h('div', 'mdn-fw-outs')
		list.setAttribute('role', 'listbox')
		list.setAttribute('aria-label', '生成的升级包')
		const outEmpty = h('div', 'mdn-fw-empty', '生成后在这里列出每个产物')
		c2.el.append(outEmpty, list)
		const zipNote = h('div', 'mdn-fw-zipnote')
		zipNote.hidden = true
		const actions = h('div', 'mdn-fw-actions')
		const dl = h('button', 'btn btn-sm btn-outline-secondary', '下载')
		dl.type = 'button'
		dl.id = 'mdn-fw-download'
		const use = h('button', 'btn btn-sm btn-primary', '用此包升级 →')
		use.type = 'button'
		use.id = 'mdn-fw-use'
		actions.append(dl, use)
		c2.el.append(zipNote, actions)
		const logCard = $('fp-log') ? $('fp-log').closest('.fw-log-card') : null
		const packFold = fold('生成日志')
		park(logCard, packFold.region)
		c2.el.appendChild(packFold.el)

		// 卡片 3：升级
		const c3 = card(3, '升级', '')
		const fileA = $('fw-file') ? $('fw-file').closest('.fw-upgrade-card') : null
		const fileSlot = h('div', 'mdn-fw-slot')
		park(fileA, fileSlot)
		c3.el.appendChild(fileSlot)
		const ctlRow = $('fw-start') ? $('fw-start').parentElement : null
		const ctlSlot = h('div', 'mdn-fw-slot mdn-fw-slot--ctl')
		park(ctlRow, ctlSlot)
		c3.el.appendChild(ctlSlot)
		const prog = h('div', 'mdn-fw-prog')
		const big = h('span', 'mdn-fw-big', '0%')
		const stats = h('span', 'mdn-fw-stats')
		prog.append(big, stats)
		c3.el.appendChild(prog)
		const barSlot = h('div', 'mdn-fw-slot mdn-fw-slot--bar')
		park($('fw-progress') ? $('fw-progress').parentElement : null, barSlot)
		c3.el.appendChild(barSlot)
		const gridWrap = h('div', 'mdn-fw-grid')
		const canvas = h('canvas', 'mdn-fw-canvas')
		canvas.setAttribute('role', 'img')
		const gridEmpty = h('div', 'mdn-fw-empty', '载入并解析固件后显示分块进度')
		gridWrap.append(canvas, gridEmpty)
		const legend = h('div', 'mdn-fw-legend')
		const legendItems = {}
		;[['done', '已确认'], ['retried', '重发过'], ['active', '进行中'], ['pending', '待发']].forEach(function (p) {
			const item = h('span', 'mdn-fw-legend-item')
			const sw = h('span', 'mdn-fw-swatch mdn-fw-swatch--' + p[0])
			sw.setAttribute('aria-hidden', 'true')
			const txt = h('span')
			item.append(sw, txt)
			legend.appendChild(item)
			legendItems[p[0]] = { txt: txt, label: p[1] }
		})
		legend.title = '已确认：设备已转去请求后续分块或上报结果；重发过：设备重复请求过该块；进行中：设备正在请求/刚发出的块'
		const upNote = note()
		c3.el.append(gridWrap, legend, upNote)
		const upFold = fold('升级日志')
		park($('fw-log'), upFold.region)
		c3.el.appendChild(upFold.el)

		// 卡片 4：校验
		const c4 = card(4, '校验')
		const rows = h('dl', 'mdn-fw-rows')
		const val = {}
		;[['pre', '升级前'], ['target', '目标'], ['post', '升级后']].forEach(function (p) {
			const dt = h('dt', null, p[1])
			const dd = h('dd', 'mdn-fw-mono', '--')
			rows.append(dt, dd)
			val[p[0]] = dd
		})
		c4.el.appendChild(rows)
		const verdict = h('div', 'mdn-fw-verdict')
		verdict.setAttribute('role', 'status')
		const verifyBtn = h('button', 'btn btn-sm btn-outline-secondary', '查询版本')
		verifyBtn.type = 'button'
		verifyBtn.id = 'mdn-fw-verify'
		const verifyHint = h('p', 'mdn-fw-hint', '升级命令发出、设备重启后点「查询版本」，与目标版本比对；也可随时查询当前版本。')
		c4.el.append(verdict, verifyBtn, verifyHint)

		cards.append(c1.el, c2.el, c3.el, c4.el)
		rootEl.append(steps, cards)

		$('view-fw-pack').appendChild(rootEl)

		// 新控件只驱动现有逻辑
		list.addEventListener('click', function (e) {
			const b = e.target.closest('.mdn-fw-out')
			if (!b) return
			model.pack.selected = Number(b.dataset.i)
			render()
		})
		dl.addEventListener('click', function () {
			const o = model.pack.outputs[model.pack.selected]
			const item = o && root._fwPackOutputs && root._fwPackOutputs[o.idx]
			if (!item || !item.buffer || !root.FirmwarePackager) return
			root.FirmwarePackager.downloadBlob(new Uint8Array(item.buffer), item.name)
		})
		use.addEventListener('click', function () {
			const o = model.pack.outputs[model.pack.selected]
			const item = o && root._fwPackOutputs && root._fwPackOutputs[o.idx]
			if (!item || !item.buffer || !root.setFwUpgradeFile || model.up.running) return
			root.setFwUpgradeFile(item.buffer, item.name)
			c3.el.scrollIntoView({ block: 'nearest' })
		})
		verifyBtn.addEventListener('click', function () {
			const q = $('fw-query')
			if (q && !q.disabled) q.click()
		})
		// 原生模式(不解析包头)下版本号由用户手填，校验页的目标版本跟着输入走
		const verIn = $('fw-version')
		const onVer = function () {
			if (model.up.parsed && model.up.parsed.raw && !model.up.running) { model.up.parsed.version = verIn.value.trim(); render() }
		}
		if (verIn) {
			verIn.addEventListener('input', onVer)
			ui_cleanup.push(function () { verIn.removeEventListener('input', onVer) })
		}
		const chunkIn = $('fw-chunk-size')
		const onChunk = function () { previewPlan(model, chunkInputValue()); render() }
		if (chunkIn) {
			chunkIn.addEventListener('input', onChunk)
			chunkIn.addEventListener('change', onChunk)
			ui_cleanup.push(function () {
				chunkIn.removeEventListener('input', onChunk)
				chunkIn.removeEventListener('change', onChunk)
			})
		}
		canvas.addEventListener('mousemove', function (e) {
			const t = cellTitle(e)
			if (t !== canvas.title) canvas.title = t
		})

		ui = {
			root: rootEl, stepEls: stepEls, slots: slots, packNote: packNote, list: list, outEmpty: outEmpty, zipNote: zipNote,
			dl: dl, use: use, packFold: packFold, upFold: upFold, c3: c3, big: big, stats: stats, canvas: canvas, gridWrap: gridWrap,
			gridEmpty: gridEmpty, legendItems: legendItems, upNote: upNote, val: val, verdict: verdict, verifyBtn: verifyBtn,
			packSig: '',
		}
	}

	let ui_cleanup = []

	// ---------- 渲染 ----------

	function setNote(el, n) {
		if (!n) {
			el.hidden = true
			el.textContent = ''
			delete el.dataset.level
			return
		}
		el.hidden = false
		el.dataset.level = n.level
		if (el.textContent !== n.msg) el.textContent = n.msg
	}

	function renderSteps() {
		deriveStages(model).forEach(function (s, i) {
			const e = ui.stepEls[i]
			e.li.dataset.state = s.state
			if (s.state === 'active') e.li.setAttribute('aria-current', 'step')
			else e.li.removeAttribute('aria-current')
			e.badge.textContent = s.state === 'waiting' ? String(i + 1) : STATE_MARK[s.state]
			e.state.textContent = STATE_LABEL[s.state]
			e.sum.textContent = s.summary
		})
	}

	function renderFiles() {
		;[['old', model.pack.old], ['nw', model.pack.nw]].forEach(function (pair) {
			const ver = ui.slots[pair[0]].ver
			if (!ver) return
			const f = pair[1]
			if (f && f.version) {
				ver.hidden = false
				ver.textContent = '识别为 ' + f.version
			} else {
				ver.hidden = true
				ver.textContent = ''
			}
		})
	}

	function renderPack() {
		const p = model.pack
		setNote(ui.packNote, p.notice)
		ui.outEmpty.hidden = p.outputs.length > 0
		const sig = p.outputs.map(function (o) { return o.idx + ':' + o.size + ':' + o.base }).join('|')
		if (sig === ui.packSig) {
			Array.prototype.forEach.call(ui.list.children, function (b, i) { b.setAttribute('aria-selected', String(i === p.selected)) })
		} else {
			ui.packSig = sig
			ui.list.textContent = ''
		}
		if (ui.list.children.length === 0) p.outputs.forEach(function (o, i) {
			const b = h('button', 'mdn-fw-out')
			b.type = 'button'
			b.setAttribute('role', 'option')
			b.setAttribute('aria-selected', String(i === p.selected))
			b.dataset.i = String(i)
			const r = ratioOf(o.size, o.base)
			const name = h('span', 'mdn-fw-mono mdn-fw-out-name', o.name)
			const size = h('span', 'mdn-fw-mono mdn-fw-out-size', fmtSize(o.size))
			b.append(name, size)
			if (r != null) {
				const track = h('span', 'mdn-fw-bar')
				const fill = h('span', 'mdn-fw-bar-fill')
				fill.style.width = Math.max(1, Math.min(100, r * 100)).toFixed(1) + '%'
				track.appendChild(fill)
				b.appendChild(track)
			}
			const label = KIND_LABEL[o.kind] || '升级包'
			b.appendChild(h('span', 'mdn-fw-out-desc', label + (r != null ? ' · ' + Math.round(r * 100) + '%' : '')))
			ui.list.appendChild(b)
		})
		if (p.zip) {
			ui.zipNote.hidden = false
			ui.zipNote.textContent = 'ZIP：' + p.zip.name + ' · ' + fmtSize(p.zip.size) + ' · ' + p.zip.count + ' 个文件'
		} else {
			ui.zipNote.hidden = true
		}
		const has = p.outputs.length > 0 && p.selected >= 0
		ui.dl.disabled = !has
		ui.use.disabled = !has || model.up.running
		ui.packFold.last.textContent = shortMsg(p.lastLog, 60)
	}

	function renderUpgrade(now) {
		const u = model.up
		ui.big.textContent = u.percent + '%'
		let line
		if (u.plan) {
			const st = computeStats(model, now)
			const parts = ['块 ' + u.sent + '/' + u.plan.totalChunks, u.plan.chunkSize + ' B/块']
			if (st.rate != null) parts.push(fmtRate(st.rate))
			if (u.running && u.phase === 'transfer') parts.push('剩余 ' + fmtEta(st.eta))
			else if (u.running) parts.push(PHASE_TEXT[u.phase] || '')
			line = parts.filter(Boolean).join(' · ')
		} else {
			line = u.running ? (PHASE_TEXT[u.phase] || '升级中') : '未开始'
		}
		ui.stats.textContent = line
		setNote(ui.upNote, u.notice)
		ui.upFold.last.textContent = shortMsg(u.lastLog, 60)
		// 当前走哪个串口：与顶栏主发口一致
		if (ui.c3.sub) {
			let t = ''
			try {
				const sid = root.serialApi && root.serialApi.getActiveSendSid && root.serialApi.getActiveSendSid()
				if (sid === 'A') t = '经顶栏 A 路'
				else if (sid === 'B') t = '经顶栏 B 路'
				else if (sid) t = '经顶栏串口'
			} catch (e) { /* 取不到就不显示 */ }
			if (ui.c3.sub.textContent !== t) ui.c3.sub.textContent = t
		}
		drawGrid()
	}

	function renderVerify() {
		const u = model.up
		const target = targetVersion(model)
		ui.val.pre.textContent = u.pre != null ? u.pre : '--'
		ui.val.target.textContent = target != null ? target : '--'
		ui.val.post.textContent = u.post != null ? u.post : (u.querying ? '查询中…' : '待查询')
		let text = ''
		let state = ''
		if (u.queryError && !u.querying) { text = '查询失败：' + u.queryError; state = 'failed' }
		if (u.outcome === 'ok' && u.post != null && target != null) {
			if (sameVersion(u.post, target)) { text = '一致：设备已运行目标版本'; state = 'done' } else { text = '不一致：设备版本与目标版本不同'; state = 'failed' }
		} else if (!text && u.post == null && u.pre != null && target != null && sameVersion(u.pre, target)) {
			text = '设备当前已是目标版本'
			state = 'waiting'
		}
		ui.verdict.textContent = text
		ui.verdict.dataset.state = state
		ui.verdict.hidden = !text
		const q = $('fw-query')
		ui.verifyBtn.disabled = !!(q && q.disabled) || u.querying
		ui.verifyBtn.textContent = u.outcome === 'ok' ? '查询升级后版本' : '查询版本'
	}

	function render() {
		if (!viewVisible()) return
		if (raf) return
		raf = requestAnimationFrame(function () {
			raf = 0
			if (!viewVisible()) return
			renderAll(Date.now())
		})
	}

	function viewVisible() {
		const view = $('view-fw-pack')
		return !!(ui && !document.hidden && view && view.classList.contains('active'))
	}

	function renderAll(now) {
		renderSteps()
		renderFiles()
		renderPack()
		renderUpgrade(now)
		renderVerify()
	}

	// ---------- 分块格子（canvas） ----------

	const CELL_GAP = 2
	const GRID_MAX_H = 168

	function gridLayout(total, width) {
		let c = 10
		for (; c >= 3; c--) {
			const cols = Math.max(1, Math.floor((width + CELL_GAP) / (c + CELL_GAP)))
			const rows = Math.ceil(total / cols)
			if (rows * (c + CELL_GAP) - CELL_GAP <= GRID_MAX_H) return { c: c, cols: cols, rows: rows, per: 1, cells: total }
		}
		c = 3
		const cols = Math.max(1, Math.floor((width + CELL_GAP) / (c + CELL_GAP)))
		const rowsMax = Math.floor((GRID_MAX_H + CELL_GAP) / (c + CELL_GAP))
		const cap = cols * rowsMax
		const per = Math.ceil(total / cap)
		const cells = Math.ceil(total / per)
		return { c: c, cols: cols, rows: Math.ceil(cells / cols), per: per, cells: cells }
	}

	let lastLayout = null

	function cssVar(cs, name, fallback) {
		const v = cs.getPropertyValue(name).trim()
		return v || fallback
	}

	function drawGrid() {
		const g = model.up.grid
		const cv = ui.canvas
		const has = !!(g && g.total > 0)
		ui.gridWrap.classList.toggle('is-empty', !has)
		const counts = gridCounts(g)
		const li = ui.legendItems
		li.done.txt.textContent = li.done.label + ' ' + counts.done
		li.retried.txt.textContent = li.retried.label + ' ' + counts.retried
		li.active.txt.textContent = li.active.label + ' ' + counts.active
		li.pending.txt.textContent = li.pending.label + ' ' + counts.pending
		if (!has) {
			cv.setAttribute('aria-label', '分块进度：尚无分块')
			lastLayout = null
			return
		}
		cv.setAttribute('aria-label', '分块进度：共 ' + g.total + ' 块，已确认 ' + counts.done + '，重发过 ' + counts.retried + '，进行中 ' + counts.active + '，待发 ' + counts.pending)
		const width = Math.floor(cv.parentElement.clientWidth)
		if (width < 20) return
		const L = gridLayout(g.total, width)
		lastLayout = { L: L, width: width }
		const height = L.rows * (L.c + CELL_GAP) - CELL_GAP
		const dpr = window.devicePixelRatio || 1
		if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(height * dpr)) {
			cv.width = Math.round(width * dpr)
			cv.height = Math.round(height * dpr)
		}
		cv.style.width = width + 'px'
		cv.style.height = height + 'px'
		const ctx = cv.getContext('2d')
		if (!ctx) return
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.clearRect(0, 0, width, height)
		const cs = getComputedStyle(cv)
		const colors = {
			0: cssVar(cs, '--mdn-cell-pending', '#cdd4de'),
			1: cssVar(cs, '--mdn-cell-active', '#1f5fbf'),
			2: cssVar(cs, '--mdn-cell-done', '#1c2330'),
			3: cssVar(cs, '--mdn-cell-retry', '#e07a1f'),
		}
		const cellW = (width - (L.cols - 1) * CELL_GAP) / L.cols
		for (let i = 0; i < L.cells; i++) {
			let st
			if (L.per === 1) {
				st = g.state[i]
				if (st === 2 && g.retried[i]) st = 3
			} else {
				st = gridBucket(g, i * L.per, Math.min(g.total, (i + 1) * L.per))
			}
			const col = i % L.cols
			const row = Math.floor(i / L.cols)
			ctx.fillStyle = colors[st]
			ctx.fillRect(col * (cellW + CELL_GAP), row * (L.c + CELL_GAP), cellW, L.c)
		}
	}

	function cellTitle(e) {
		const g = model.up.grid
		if (!g || !lastLayout) return ''
		const rect = ui.canvas.getBoundingClientRect()
		const L = lastLayout.L
		const cellW = (lastLayout.width - (L.cols - 1) * CELL_GAP) / L.cols
		const col = Math.floor((e.clientX - rect.left) / (cellW + CELL_GAP))
		const row = Math.floor((e.clientY - rect.top) / (L.c + CELL_GAP))
		if (col < 0 || col >= L.cols || row < 0) return ''
		const i = row * L.cols + col
		if (i >= L.cells) return ''
		const from = i * L.per
		const to = Math.min(g.total, from + L.per)
		const name = ['待发', '进行中', '已确认', '重发过'][gridBucket(g, from, to)]
		return L.per === 1 ? '块 #' + from + ' · ' + name : '块 #' + from + '–#' + (to - 1) + ' · ' + name
	}

	// ---------- 挂载 / 撤销 ----------

	function mount() {
		if (ui || !$('view-fw-pack')) return
		build()
		const view = $('view-fw-pack')
		previewPlan(model, chunkInputValue())
		if (viewVisible()) renderAll(Date.now())
		// 事件始终归约到 model；页面再次显示时补一次完整视图(含产物列表)。
		document.addEventListener('visibilitychange', render)
		ui_cleanup.push(function () { document.removeEventListener('visibilitychange', render) })
		// 速率、剩余时间与端口标签随时间变；产物列表只在事件到来时重建，免得键盘焦点被每秒重绘打掉
		timer = setInterval(function () {
			// 固件页没显示时不刷新：分块格子每秒都要整段统计；切回固件页后下一拍(1 秒内)补上
			if (!viewVisible()) return
			const now = Date.now()
			renderSteps()
			renderUpgrade(now)
			renderVerify()
		}, 1000)
		if (typeof ResizeObserver === 'function') {
			ro = new ResizeObserver(function () { if (viewVisible()) drawGrid() })
			ro.observe(ui.gridWrap)
		}
		if (typeof MutationObserver === 'function') {
			themeMo = new MutationObserver(function () { if (viewVisible()) drawGrid() })
			themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
			const viewMo = new MutationObserver(render)
			viewMo.observe(view, { attributes: true, attributeFilter: ['class'] })
			ui_cleanup.push(function () { viewMo.disconnect() })
		}
	}

	function unmount() {
		if (!ui) return
		clearInterval(timer)
		timer = 0
		if (ro) { ro.disconnect(); ro = null }
		if (themeMo) { themeMo.disconnect(); themeMo = null }
		if (raf) { cancelAnimationFrame(raf); raf = 0 }
		ui_cleanup.forEach(function (fn) { fn() })
		ui_cleanup = []
		parked.reverse().forEach(function (pair) { pair[1].replaceWith(pair[0]) })
		parked = []
		added.forEach(function (n) { n.remove() })
		added = []
		ui.root.remove()
		ui = null
		lastLayout = null
	}

	function init() {
		document.addEventListener('fw-pack', function (e) {
			reducePack(model, e.detail || {}, Date.now())
			render()
		})
		document.addEventListener('fw-upgrade', function (e) {
			const d = e.detail || {}
			reduceUpgrade(model, d, Date.now())
			if (d.type === 'parsed' || d.type === 'file-set') previewPlan(model, chunkInputValue())
			render()
		})
		document.addEventListener('serial-layout-move', function (e) {
			if (e.detail && e.detail.layout === 'modern') mount()
			else unmount()
		})
		if (document.documentElement.dataset.layout === 'modern') mount()
	}

	root.ModernFirmware.model = model
	root.ModernFirmware.isMounted = function () { return !!ui }

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
	else init()
})()
