// eSIM (Tag=66) Workbench 面板控制器：
// - 只在 SEK 协议下可用（通过切换 #sk-esim-card 的 style.display 与 Workbench 联动）
// - 不嗅探 UA / __TAURI__：通过 AppPlatform.service('esim-http') 判断是否具备免 CORS 的 SM-DP+ HTTPS 代理能力
// - 严禁持久化或明文输出激活码 (AC) / 确认码 (CC) 到 localStorage 或日志
// - 设备返回的所有字符串一律用 textContent 渲染
;(function () {
	'use strict'

	const POLL_INTERVAL_MS = 2000
	const POLL_MAX_DOWNLOAD_MS = 240000
	const POLL_MAX_DELETE_MS = 120000
	const POLL_MAX_MANAGE_MS = 60000
	const MAX_LOG_LINES = 120

	function $(id) { return document.getElementById(id) }

	function sleep(ms, signal) {
		return new Promise(function (resolve, reject) {
			if (signal && signal.aborted) { reject(new Error('操作已取消')); return }
			const t = setTimeout(function () {
				if (signal) signal.removeEventListener('abort', onAbort)
				resolve()
			}, ms)
			function onAbort() {
				clearTimeout(t)
				reject(new Error('操作已取消'))
			}
			if (signal) signal.addEventListener('abort', onAbort, { once: true })
		})
	}

	function nowTimeText() {
		const d = new Date()
		const p = n => String(n).padStart(2, '0')
		return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
	}

	function dialogAlert(msg, title) {
		if (window.AppDialog && typeof window.AppDialog.alert === 'function') {
			return window.AppDialog.alert(msg, { title: title || 'eSIM 提示' })
		}
		return Promise.resolve()
	}

	function dialogConfirm(msg, title) {
		if (window.AppDialog && typeof window.AppDialog.confirm === 'function') {
			return window.AppDialog.confirm(msg, { title: title || 'eSIM 确认' })
		}
		return Promise.resolve(true)
	}

	function init() {
		const card = $('sk-esim-card')
		if (!card || !window.EsimCore || !window.Zmodem) return

		const Core = window.EsimCore
		const ZM = window.Zmodem
		const P = window.AppPlatform

		const el = {
			card,
			eid: $('sk-esim-eid'),
			refreshBtn: $('sk-esim-refresh'),
			pollBtn: $('sk-esim-poll'),
			stopBtn: $('sk-esim-stop'),
			statusBadge: $('sk-esim-state-badge'),
			statusOp: $('sk-esim-last-op'),
			statusStage: $('sk-esim-fail-stage'),
			statusErr: $('sk-esim-err-code'),
			statusHint: $('sk-esim-err-hint'),
			statusTime: $('sk-esim-status-time'),
			profileCount: $('sk-esim-profile-count'),
			profileList: $('sk-esim-profile-list'),
			modeSelect: $('sk-esim-mode'),
			acInput: $('sk-esim-ac'),
			ccInput: $('sk-esim-cc'),
			proxyRow: $('sk-esim-proxy-row'),
			proxyNotice: $('sk-esim-proxy-notice'),
			proxyUrl: $('sk-esim-proxy-url'),
			downloadBtn: $('sk-esim-download'),
			progressBar: $('sk-esim-progress-bar'),
			statusLine: $('sk-esim-status'),
			logBox: $('sk-esim-log'),
			clearLogBtn: $('sk-esim-log-clear'),
		}

		let profilesCache = []
		let running = false
		let abortCtrl = null

		function syncProtocolVisibility() {
			// 由 ProtocolSubTabs 统一管理 #sk-esim-card 在 SEK 协议内的显隐；无子页控制器时兜底按当前协议切换
			if (window.ProtocolSubTabs) return
			const active = window._activeProtocol || 'sek'
			el.card.style.display = active === 'sek' ? '' : 'none'
		}
		syncProtocolVisibility()

		function hasNativeHttp() {
			return !!(P && typeof P.service === 'function' && P.service('esim-http'))
		}

		function updateModeNotice() {
			const mode = Number(el.modeSelect ? el.modeSelect.value : 0)
			if (!el.proxyRow) return
			if (mode === 1) {
				el.proxyRow.hidden = false
				if (hasNativeHttp()) {
					el.proxyNotice.textContent = '桌面端已就绪：将通过内置原生 HTTPS 通道转发四轮 SM-DP+ 请求（保留 TLS 校验，绕过浏览器 CORS）。'
					el.proxyNotice.className = 'sk-esim-notice is-ok'
				} else {
					el.proxyNotice.textContent = '网页版受浏览器 CORS 限制，无法直连 SM-DP+。请改用桌面客户端，或在下方填写本地 CORS 转发代理基地址。'
					el.proxyNotice.className = 'sk-esim-notice is-warn'
				}
			} else {
				el.proxyRow.hidden = true
			}
		}
		if (el.modeSelect) el.modeSelect.addEventListener('change', updateModeNotice)
		updateModeNotice()

		function addLog(text, level) {
			if (!el.logBox) return
			const line = document.createElement('div')
			line.className = 'sk-esim-log-line' + (level ? ' is-' + level : '')
			line.textContent = '[' + nowTimeText() + '] ' + text
			el.logBox.appendChild(line)
			while (el.logBox.childNodes.length > MAX_LOG_LINES) {
				el.logBox.removeChild(el.logBox.firstChild)
			}
			el.logBox.scrollTop = el.logBox.scrollHeight
		}

		function setProgress(pct, text) {
			if (!el.progressBar) return
			const v = Math.max(0, Math.min(100, Math.round(pct || 0)))
			el.progressBar.style.width = v + '%'
			el.progressBar.textContent = text || (v + '%')
		}

		function setStatusText(text) {
			if (el.statusLine) el.statusLine.textContent = text || ''
		}

		function setBusy(busy) {
			running = !!busy
			if (el.stopBtn) el.stopBtn.disabled = !running
			if (el.refreshBtn) el.refreshBtn.disabled = running
			if (el.pollBtn) el.pollBtn.disabled = running
			if (el.downloadBtn) el.downloadBtn.disabled = running
			if (el.modeSelect) el.modeSelect.disabled = running
			const btns = el.profileList ? el.profileList.querySelectorAll('button') : []
			btns.forEach(function (b) { b.disabled = running || b.dataset.hardDisabled === '1' })
		}

		function renderEid(eidInfo) {
			if (!el.eid) return
			if (!eidInfo || !eidInfo.valid) {
				el.eid.textContent = '--'
				return
			}
			el.eid.textContent = eidInfo.ready ? eidInfo.eid : '未就绪 (全 0)'
		}

		function renderStatus(st) {
			if (!st) {
				if (el.statusBadge) { el.statusBadge.textContent = '未知'; el.statusBadge.className = 'sk-esim-badge' }
				if (el.statusOp) el.statusOp.textContent = '--'
				if (el.statusStage) el.statusStage.textContent = '--'
				if (el.statusErr) el.statusErr.textContent = '--'
				if (el.statusHint) { el.statusHint.textContent = ''; el.statusHint.hidden = true }
				if (el.statusTime) el.statusTime.textContent = '--'
				return
			}
			if (el.statusBadge) {
				el.statusBadge.textContent = st.stateLabel
				const cls = st.state === 2 ? 'is-ok' : (st.state === 3 ? 'is-bad' : (st.state === 1 || st.state === 4 ? 'is-warn' : ''))
				el.statusBadge.className = 'sk-esim-badge' + (cls ? ' ' + cls : '')
			}
			if (el.statusOp) el.statusOp.textContent = st.lastOpLabel
			if (el.statusStage) el.statusStage.textContent = st.failStageLabel + ' (' + st.failStage + ')'
			if (el.statusErr) {
				el.statusErr.textContent = st.moduleErrCode
					? (st.moduleErrHex + ' (' + st.qesimFullCode + (st.errName ? ' · ' + st.errName : '') + ')')
					: '0x0000'
			}
			if (el.statusHint) {
				if (st.errHint) {
					el.statusHint.textContent = '建议：' + st.errHint
					el.statusHint.hidden = false
				} else {
					el.statusHint.textContent = ''
					el.statusHint.hidden = true
				}
			}
			if (el.statusTime) el.statusTime.textContent = st.timeText || '--'
		}

		function renderProfiles(listObj) {
			profilesCache = listObj && Array.isArray(listObj.profiles) ? listObj.profiles : []
			if (el.profileCount) el.profileCount.textContent = String(profilesCache.length)
			if (!el.profileList) return
			el.profileList.textContent = ''
			if (!profilesCache.length) {
				const empty = document.createElement('div')
				empty.className = 'sk-esim-empty'
				empty.textContent = '暂无 Profile（空白卡或尚未查询）'
				el.profileList.appendChild(empty)
				return
			}
			profilesCache.forEach(function (p) {
				const row = document.createElement('div')
				row.className = 'sk-esim-profile-row'

				const meta = document.createElement('div')
				meta.className = 'sk-esim-profile-meta'

				const iccidEl = document.createElement('div')
				iccidEl.className = 'sk-esim-iccid'
				iccidEl.textContent = p.iccid || '(空 ICCID)'

				const tagsEl = document.createElement('div')
				tagsEl.className = 'sk-esim-tags'

				function addTag(txt, cls) {
					const sp = document.createElement('span')
					sp.className = 'sk-esim-tag' + (cls ? ' ' + cls : '')
					sp.textContent = txt
					tagsEl.appendChild(sp)
				}
				addTag(p.enabled ? '已启用' : '已禁用', p.enabled ? 'is-ok' : '')
				addTag(p.profileClassLabel, '')
				if (p.pprDisableBlocked) addTag('禁禁PPR', 'is-warn')
				if (p.pprDeleteBlocked) addTag('禁删PPR', 'is-warn')
				if (p.fallback) addTag('回退卡', 'is-info')

				meta.append(iccidEl, tagsEl)

				const acts = document.createElement('div')
				acts.className = 'sk-esim-profile-acts'

				function makeActBtn(label, op, btnCls, hardDisabled, title) {
					const b = document.createElement('button')
					b.type = 'button'
					b.className = 'btn btn-xs ' + btnCls
					b.textContent = label
					if (title) b.title = title
					if (hardDisabled) {
						b.dataset.hardDisabled = '1'
						b.disabled = true
					} else {
						b.disabled = running
					}
					b.addEventListener('click', function () { handleProfileOp(op, p) })
					return b
				}

				acts.append(
					makeActBtn('启用', 1, 'btn-outline-success', false, '发送 Tag66-ID3 op=1 启用切卡'),
					makeActBtn('禁用', 2, 'btn-outline-warning', p.pprDisableBlocked, p.pprDisableBlocked ? 'PPR 策略禁止禁用' : '发送 Tag66-ID3 op=2 禁用'),
					makeActBtn('删除', 3, 'btn-outline-danger', p.pprDeleteBlocked, p.enabled ? '需先禁用后才能删除' : '发送 Tag66-ID3 op=3 删除（最长 60s）')
				)

				row.append(meta, acts)
				el.profileList.appendChild(row)
			})
		}

		function applyTag66Frame(frame) {
			if (!frame || !window.sekTx) return { status: null }
			const it0 = window.sekTx.findTlvItem(frame, 66, 0)
			const it1 = window.sekTx.findTlvItem(frame, 66, 1)
			const it4 = window.sekTx.findTlvItem(frame, 66, 4)
			if (it0 && it0.raw) renderEid(Core.decodeEid(it0.raw))
			if (it1 && it1.raw) renderProfiles(Core.decodeProfileList(it1.raw))
			const st = (it4 && it4.raw) ? Core.decodeStatus(it4.raw) : null
			if (st) renderStatus(st)
			return { eid: it0 ? Core.decodeEid(it0.raw) : null, profiles: it1 ? Core.decodeProfileList(it1.raw) : null, status: st }
		}

		function ensureReady() {
			if (!window.serialApi || !window.serialApi.isOpen()) {
				dialogAlert('请先在顶部连接栏打开设备通信口后再操作 eSIM。')
				return false
			}
			if (!window.sekTx) {
				dialogAlert('SEK 事务模块未就绪。')
				return false
			}
			return true
		}

		async function queryTag66(timeoutMs) {
			const res = await window.sekTx.sendAndWait({
				buildOpts: {
					funcCode: 0x03,
					tlv: [{ tag: 10, items: [{ id: 66, value: null }] }],
				},
				expectFunc: 0x83,
				match: function (f) { return window.sekTx.hasTag(f, 66) },
				timeoutMs: timeoutMs || 6000,
			})
			return applyTag66Frame(res.frame)
		}

		function acquirePin(sid) {
			if (window.serialApi.isPinned()) {
				throw new Error('当前已有其他串口事务正在运行，请稍后重试')
			}
			window.serialApi.pinSession(sid)
			if (!window.serialApi.isPinned()) {
				throw new Error('无法钉扎当前串口会话')
			}
			return true
		}

		function zmodemLogPlaceholder(byteLen) {
			const txt = '[ZMODEM TX ' + byteLen + 'B]'
			if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(txt)
			const out = new Uint8Array(txt.length)
			for (let i = 0; i < txt.length; i++) out[i] = txt.charCodeAt(i) & 0xff
			return out
		}

		async function pollUntilTerminal(maxWaitMs, label, signal) {
			const deadline = Date.now() + maxWaitMs
			let pollCount = 0
			while (Date.now() < deadline) {
				if (signal && signal.aborted) throw new Error('已手动停止轮询')
				if (!window.serialApi || !window.serialApi.isOpen()) throw new Error('通信连接已断开')
				await sleep(POLL_INTERVAL_MS, signal)
				pollCount++
				setStatusText(label + '：轮询 ID4 状态（第 ' + pollCount + ' 次）…')
				try {
					const info = await queryTag66(6000)
					const st = info.status
					if (st && st.state !== 1) {
						const summary = st.stateLabel + ' · ' + st.failStageLabel + (st.moduleErrCode ? ' · ' + st.qesimFullCode : '')
						setStatusText(label + '结束：' + summary)
						addLog(label + '终态 -> ' + summary, st.state === 2 ? 'ok' : (st.state === 4 ? 'warn' : 'bad'))
						setProgress(100, st.stateLabel)
						return st
					}
				} catch (e) {
					addLog('轮询查询未应答（继续重试）: ' + (e && e.message ? e.message : e), 'warn')
				}
			}
			throw new Error('轮询超时（' + Math.round(maxWaitMs / 1000) + 's），状态未知，请刷新核对')
		}

		function resultCodeText(code) {
			const map = { 0: '0:已受理(处理中)', 1: '1:处理成功', 2: '2:消息格式有误', 3: '3:不支持或超出范围', 4: '4:忙或安全约束拒绝' }
			return map[code] || String(code)
		}

		async function handleRefresh() {
			if (running || !ensureReady()) return
			abortCtrl = new AbortController()
			setBusy(true)
			setStatusText('正在查询 eSIM 信息 (0x03 Tag10-ID66)…')
			setProgress(30, '查询中')
			try {
				const info = await queryTag66(6000)
				const cnt = info.profiles ? info.profiles.count : 0
				setStatusText('查询完成：共 ' + cnt + ' 个 Profile')
				setProgress(100, '已刷新')
				addLog('查询 Tag66 完成：EID=' + (info.eid && info.eid.ready ? info.eid.eid : '未就绪') + '，Profile=' + cnt + '条', 'ok')
			} catch (e) {
				setStatusText('查询失败：' + (e && e.message ? e.message : e))
				setProgress(0, '失败')
				addLog('查询失败：' + (e && e.message ? e.message : e), 'bad')
			} finally {
				abortCtrl = null
				setBusy(false)
			}
		}

		async function handlePollOnly() {
			if (running || !ensureReady()) return
			abortCtrl = new AbortController()
			setBusy(true)
			setProgress(20, '轮询中')
			addLog('开始持续轮询 ID4 状态，直到离开执行中状态…', 'info')
			const sid = window.serialApi.getActiveSendSid()
			let pinned = false
			try {
				pinned = acquirePin(sid)
				await pollUntilTerminal(POLL_MAX_DOWNLOAD_MS, 'ID4 轮询', abortCtrl.signal)
			} catch (e) {
				setStatusText('轮询结束：' + (e && e.message ? e.message : e))
				addLog('轮询结束：' + (e && e.message ? e.message : e), 'warn')
			} finally {
				if (pinned) window.serialApi.unpinSession()
				abortCtrl = null
				setBusy(false)
			}
		}

		async function handleProfileOp(op, profile) {
			if (running || !ensureReady()) return
			const check = Core.validateProfileAction(op, profile, profilesCache)
			if (!check.allowed) {
				await dialogAlert(check.reason, '操作被阻止')
				return
			}
			if (check.confirm) {
				const ok = await dialogConfirm(check.confirm, 'Profile 管理确认')
				if (!ok) return
			}

			let val
			try {
				val = Core.encodeProfileManage({ op, iccid: profile.iccid })
			} catch (e) {
				await dialogAlert(e.message, '参数错误')
				return
			}

			abortCtrl = new AbortController()
			setBusy(true)
			const opLabel = Core.OP_LABELS[op] || ('op=' + op)
			setStatusText('正在下发 Profile ' + opLabel + '…')
			setProgress(15, opLabel)
			addLog('下发 Tag66-ID3 ' + opLabel + ' ICCID=' + profile.iccid, 'info')

			const sid = window.serialApi.getActiveSendSid()
			let pinned = false
			try {
				pinned = acquirePin(sid)
				const res = await window.sekTx.sendAndWait({
					buildOpts: {
						funcCode: 0x01,
						tlv: [{ tag: 66, items: [{ id: 3, value: val }] }],
					},
					expectFunc: 0x81,
					acceptProcessing: false,
					timeoutMs: 6000,
				})
				const code = res.tag11
				if (code === 0 || code === 1) {
					addLog('设备已受理 (' + resultCodeText(code) + ')，开始轮询 ID4…', 'info')
					setProgress(40, '执行中')
					await pollUntilTerminal(op === 3 ? POLL_MAX_DELETE_MS : POLL_MAX_MANAGE_MS, opLabel, abortCtrl.signal)
				} else {
					const msg = '设备同步拒绝：' + resultCodeText(code) + '（未修改 ID4）'
					setStatusText(msg)
					setProgress(0, '已拒绝')
					addLog(msg, 'bad')
				}
			} catch (e) {
				setStatusText(opLabel + '失败：' + (e && e.message ? e.message : e))
				setProgress(0, '失败')
				addLog(opLabel + '失败：' + (e && e.message ? e.message : e), 'bad')
			} finally {
				if (pinned) window.serialApi.unpinSession()
				abortCtrl = null
				setBusy(false)
			}
		}

		// 构建脱敏发送用的完整帧与 logData 副本（绝不在日志中落盘明文 AC/CC）
		function buildDownloadFrames(mode, ac, cc) {
			const val = Core.encodeDownloadTrigger({ mode, ac, cc })
			const redactedVal = Core.redactDownloadValue(val)
			const seq = window.sekTx.nextSeq()
			const now = new Date()
			const encKey = typeof window.serialApi.getEncKey === 'function' ? window.serialApi.getEncKey() : null
			const frame = window.skBuildDownFrame({
				frameSeq: seq,
				version: 2,
				time: now,
				funcCode: 0x01,
				encKey: encKey,
				tlv: [{ tag: 66, items: [{ id: 2, value: val }] }],
			})
			const logFrame = window.skBuildDownFrame({
				frameSeq: seq,
				version: 2,
				time: now,
				funcCode: 0x01,
				encKey: null,
				tlv: [{ tag: 66, items: [{ id: 2, value: redactedVal }] }],
			})
			return { frame, logFrame, seq }
		}

		function createHttpPoster(proxyBaseUrl) {
			const nativeSvc = P && typeof P.service === 'function' ? P.service('esim-http') : null
			if (nativeSvc && !proxyBaseUrl) {
				return function (req) {
					return nativeSvc.post({ url: req.url, bodyBytes: req.bodyBytes })
				}
			}
			if (proxyBaseUrl) {
				return async function (req) {
					const resp = await fetch(req.url, {
						method: 'POST',
						headers: {
							'X-Admin-Protocol': 'gsma/rsp/v2.2.0',
							'Content-Type': 'application/json',
						},
						body: req.bodyBytes,
						signal: req.signal,
					})
					const buf = await resp.arrayBuffer()
					return { status: resp.status, bodyBytes: new Uint8Array(buf) }
				}
			}
			return null
		}

		async function handleDownload() {
			if (running || !ensureReady()) return
			const mode = Number(el.modeSelect ? el.modeSelect.value : 0)
			const acRaw = el.acInput ? el.acInput.value.trim() : ''
			const ccRaw = el.ccInput ? el.ccInput.value.trim() : ''
			const proxyBaseUrl = el.proxyUrl ? el.proxyUrl.value.trim() : ''

			const acInfo = Core.parseActivationCode(acRaw)
			if (!acInfo.ok) {
				await dialogAlert(acInfo.error, '激活码校验失败')
				return
			}
			if (acInfo.warning) {
				const cont = await dialogConfirm(acInfo.warning + '\n\n确认继续下发吗？', '激活码提示')
				if (!cont) return
			}

			let httpPost = null
			if (mode === 1) {
				httpPost = createHttpPoster(proxyBaseUrl)
				if (!httpPost) {
					await dialogAlert('当前浏览器环境不支持直接向 SM-DP+ 发起 HTTPS POST（CORS 限制）。\n请使用桌面客户端，或在「本地代理基地址」填入支持 CORS 的转发代理。', '无法启动近端外部代理')
					return
				}
			}

			let built
			try {
				built = buildDownloadFrames(mode, acRaw, ccRaw)
			} catch (e) {
				await dialogAlert(e.message, '参数错误')
				return
			}

			abortCtrl = new AbortController()
			setBusy(true)
			setProgress(5, '触发下载')
			const modeName = Core.MODE_LABELS[mode] || ('mode=' + mode)
			setStatusText('正在发送下载触发 (' + modeName + ')…')
			addLog('触发 Profile 下载：' + modeName + '，SM-DP+=' + acInfo.smdpHost + '（AC/CC 已脱敏）', 'info')

			const sid = window.serialApi.getActiveSendSid()
			let pinned = false
			let rxLogSuppressed = false
			let unsubRx = null
			let prevSuppress = window.serialApi.suppressParse
			try {
				pinned = acquirePin(sid)
				window.sekTx.clearBuffer()
				const waitAck = window.sekTx.waitFor(function (frame) {
					if (frame.dir !== 'up') return false
					const fc = frame.fields && frame.fields['功能码']
					const fv = fc && typeof fc === 'object' ? fc.value : fc
					return fv === 0x81
				}, 6000)
				waitAck.catch(function () {})

				await window.serialApi.writeRawTo(sid, built.frame, { logData: built.logFrame })
				const ack = await waitAck
				const code = window.sekTx.tag11Result(ack.frame)

				if (code !== 0 && code !== 1) {
					const msg = '设备同步拒绝下载：' + resultCodeText(code) + '（未修改 ID4）'
					setStatusText(msg)
					setProgress(0, '已拒绝')
					addLog(msg, 'bad')
					return
				}

				if (mode === 0) {
					addLog('设备已受理 mode=0 内网下载 (' + resultCodeText(code) + ')，开始轮询 ID4（最长 180s）…', 'info')
					setProgress(25, '模组下载中')
					await pollUntilTerminal(POLL_MAX_DOWNLOAD_MS, '内网下载', abortCtrl.signal)
				} else if (mode === 1) {
					// 0x81 就绪后立刻独占串口进入 ZMODEM，屏蔽旧协议日志解析，绝不回落旧解析器
					addLog('设备已就绪 (' + resultCodeText(code) + ')，独占通道切入 ZMODEM 四轮 ES9+ 代理…', 'info')
					setProgress(15, 'ZMODEM 准备')

					const queue = ZM.createByteQueue()
					window.serialApi.suppressParse = true
					if (typeof window.serialApi.setSuppressRxLog === 'function') {
						window.serialApi.setSuppressRxLog(sid, true)
						rxLogSuppressed = true
					}
					unsubRx = window.serialApi.onReceiveFrom(sid, function (chunk) {
						queue.push(chunk)
					})

					const io = {
						readByte: function (ms) {
							if (!window.serialApi.isSessionOpen(sid)) {
								queue.fail(new Error('通信链路已断开'))
							}
							return queue.readByte(ms)
						},
						writeBytes: function (bytes) {
							return window.serialApi.writeRawTo(sid, bytes, { logData: zmodemLogPlaceholder(bytes.length) })
						},
					}

					await Core.runMode1ProxySession({
						zmodem: ZM,
						io: io,
						httpPost: httpPost,
						smdpHost: acInfo.smdpHost,
						proxyBaseUrl: proxyBaseUrl,
						signal: abortCtrl.signal,
						onEvent: function (ev) {
							if (ev.type === 'round-start') {
								const pct = 15 + ev.round * 20
								setProgress(pct, '第 ' + (ev.round + 1) + '/4 轮')
								setStatusText(ev.label + '：等待 MCU 请求…')
								addLog(ev.label + ' 开始', 'info')
							} else if (ev.type === 'http-start') {
								setStatusText('第 ' + (ev.round + 1) + '/4 轮：转发 HTTPS POST (' + ev.reqBytes + 'B)…')
							} else if (ev.type === 'http-done') {
								addLog('第 ' + (ev.round + 1) + '/4 轮 SM-DP+ 响应 HTTP ' + ev.httpStatus + ' (' + ev.respBytes + 'B)', ev.httpStatus === 200 || ev.httpStatus === 204 ? 'ok' : 'bad')
							} else if (ev.type === 'zmodem-tx-start') {
								setStatusText('第 ' + (ev.round + 1) + '/4 轮：ZMODEM 回传 ' + ev.totalBytes + 'B…')
							} else if (ev.type === 'zmodem-tx-progress' && ev.totalBytes > 0) {
								const base = 15 + ev.round * 20
								const pct = base + Math.round((ev.transferredBytes / ev.totalBytes) * 18)
								setProgress(pct, '第 ' + (ev.round + 1) + '/4 轮 ' + Math.round((ev.transferredBytes / ev.totalBytes) * 100) + '%')
							} else if (ev.type === 'error') {
								addLog('代理中止：' + ev.message, 'bad')
							}
						},
					})

					setProgress(95, '四轮完成')
					setStatusText('ZMODEM 四轮透传完成！等待设备落盘…')
					addLog('ZMODEM 四轮 ES9+ 透传全部完成', 'ok')

					// 退出 ZMODEM 独占态
					if (unsubRx) { unsubRx(); unsubRx = null }
					if (rxLogSuppressed && typeof window.serialApi.setSuppressRxLog === 'function') {
						window.serialApi.setSuppressRxLog(sid, false)
						rxLogSuppressed = false
					}
					window.serialApi.suppressParse = prevSuppress

					// 若链路仍保持打开（如串口/USB），自动刷新一次状态；BLE 按契约可能已断开待重连
					if (window.serialApi.isSessionOpen(sid)) {
						try {
							await sleep(1500, abortCtrl.signal)
							await pollUntilTerminal(30000, '下载收尾', abortCtrl.signal)
						} catch (e) {
							addLog('收尾状态刷新未完成（可重连后点击「刷新信息」核对）：' + (e && e.message ? e.message : e), 'warn')
						}
					} else {
						setProgress(100, '待重连核对')
						setStatusText('四轮透传已完成，设备已退出近端会话；请重新连接后点击「刷新信息」核对新 Profile。')
					}
				}
			} catch (e) {
				const msg = e && e.message ? e.message : String(e)
				setStatusText('下载失败：' + msg)
				setProgress(0, '失败')
				addLog('下载异常：' + msg, 'bad')
			} finally {
				if (unsubRx) { unsubRx(); unsubRx = null }
				if (rxLogSuppressed && typeof window.serialApi.setSuppressRxLog === 'function') {
					window.serialApi.setSuppressRxLog(sid, false)
					rxLogSuppressed = false
				}
				window.serialApi.suppressParse = prevSuppress
				if (pinned) window.serialApi.unpinSession()
				// 擦除内存中的明文帧引用与输入凭证（不留存）
				if (built && built.frame) built.frame.fill(0)
				abortCtrl = null
				setBusy(false)
			}
		}

		if (el.refreshBtn) el.refreshBtn.addEventListener('click', handleRefresh)
		if (el.pollBtn) el.pollBtn.addEventListener('click', handlePollOnly)
		if (el.downloadBtn) el.downloadBtn.addEventListener('click', handleDownload)
		if (el.stopBtn) {
			el.stopBtn.addEventListener('click', function () {
				if (abortCtrl) {
					abortCtrl.abort()
					addLog('已请求中止当前 eSIM 任务…', 'warn')
				}
			})
		}
		if (el.clearLogBtn) {
			el.clearLogBtn.addEventListener('click', function () {
				if (el.logBox) el.logBox.textContent = ''
			})
		}
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
	else init()
})()
