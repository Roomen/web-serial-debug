// eSIM (Tag=66 V2.32 ID0~ID7) Workbench 面板控制器：
// - 只在 SEK 协议下可用（通过切换 #sk-esim-card 的 style.display 与 Workbench 联动）
// - 支持客户视图 / 管理员视图切换（客户视图隐藏 bit10 卡或脱敏展示已启用隐藏卡，不展示策略配置与通知管理）
// - 不嗅探 UA / __TAURI__：通过 AppPlatform.service('esim-http') 判断是否具备免 CORS 的 SM-DP+ HTTPS 代理能力
// - 严禁持久化激活码 (AC) / 确认码 (CC) 到 localStorage；支持通过「脱敏」开关（默认开启）切换输入遮掩与日志脱敏
// - 设备返回的所有字符串一律用 textContent 渲染
;(function () {
	'use strict'

	const POLL_INTERVAL_MS = 2000
	const POLL_MAX_DOWNLOAD_MS = 240000
	const POLL_MAX_DELETE_MS = 120000
	const POLL_MAX_MANAGE_MS = 60000
	const POLL_MAX_NTF_MS = 180000
	const KEEPALIVE_WAIT_MS = 60000
	const MAX_LOG_LINES = 120
	const STORAGE_INSECURE_TLS = 'skEsimAllowInsecureTls'
	const STORAGE_REDACT = 'skEsimRedact'
	const STORAGE_VIEW_MODE = 'skEsimViewMode'

	function readBoolStorage(key, defaultVal) {
		try {
			if (typeof localStorage === 'undefined') return !!defaultVal
			const v = localStorage.getItem(key)
			if (v == null) return !!defaultVal
			return v === '1'
		} catch (e) {
			return !!defaultVal
		}
	}

	function writeBoolStorage(key, val) {
		try {
			if (typeof localStorage !== 'undefined') localStorage.setItem(key, val ? '1' : '0')
		} catch (e) {}
	}

	function readStrStorage(key, defaultVal) {
		try {
			if (typeof localStorage === 'undefined') return defaultVal
			const v = localStorage.getItem(key)
			return v == null ? defaultVal : String(v)
		} catch (e) {
			return defaultVal
		}
	}

	function writeStrStorage(key, val) {
		try {
			if (typeof localStorage !== 'undefined') localStorage.setItem(key, String(val))
		} catch (e) {}
	}

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
		if (!card || !window.EsimCore || !window.Xfer) return

		const Core = window.EsimCore
		const XF = window.Xfer
		const P = window.AppPlatform

		const el = {
			card,
			viewCustomerBtn: $('sk-esim-view-customer'),
			viewAdminBtn: $('sk-esim-view-admin'),
			eid: $('sk-esim-eid'),
			refreshBtn: $('sk-esim-refresh'),
			pollBtn: $('sk-esim-poll'),
			stopBtn: $('sk-esim-stop'),
			statusBadge: $('sk-esim-state-badge'),
			runtimeFlags: $('sk-esim-runtime-flags'),
			statusOp: $('sk-esim-last-op'),
			statusStage: $('sk-esim-fail-stage'),
			statusErr: $('sk-esim-err-code'),
			statusHint: $('sk-esim-err-hint'),
			statusTime: $('sk-esim-status-time'),
			cacheAge: $('sk-esim-cache-age'),
			ntfSection: $('sk-esim-ntf-section'),
			ntfBadge: $('sk-esim-ntf-badge'),
			ntfTotal: $('sk-esim-ntf-total'),
			ntfDel: $('sk-esim-ntf-del'),
			ntfOther: $('sk-esim-ntf-other'),
			ntfHeadEvent: $('sk-esim-ntf-head-event'),
			ntfHeadIccid: $('sk-esim-ntf-head-iccid'),
			ntfSyncBtn: $('sk-esim-ntf-sync'),
			ntfPurgeBtn: $('sk-esim-ntf-purge'),
			profileCount: $('sk-esim-profile-count'),
			policyClearBtn: $('sk-esim-policy-clear'),
			profileList: $('sk-esim-profile-list'),
			modeSelect: $('sk-esim-mode'),
			redactToggle: $('sk-esim-redact'),
			acInput: $('sk-esim-ac'),
			ccInput: $('sk-esim-cc'),
			proxyRow: $('sk-esim-proxy-row'),
			proxyNotice: $('sk-esim-proxy-notice'),
			tlsWrap: $('sk-esim-tls-wrap'),
			insecureTls: $('sk-esim-insecure-tls'),
			proxyUrl: $('sk-esim-proxy-url'),
			downloadBtn: $('sk-esim-download'),
			progressBar: $('sk-esim-progress-bar'),
			statusLine: $('sk-esim-status'),
			logTitle: $('sk-esim-log-title'),
			logBox: $('sk-esim-log'),
			clearLogBtn: $('sk-esim-log-clear'),
		}

		let profilesCache = []
		let running = false
		let abortCtrl = null
		let viewMode = readStrStorage(STORAGE_VIEW_MODE, 'admin') === 'customer' ? 'customer' : 'admin'

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

		function isInsecureTlsAllowed() {
			return !!(el.insecureTls && el.insecureTls.checked)
		}

		function isRedactEnabled() {
			return el.redactToggle ? !!el.redactToggle.checked : true
		}

		function isAdminView() {
			return viewMode === 'admin'
		}

		function setViewMode(nextMode, persist) {
			viewMode = nextMode === 'customer' ? 'customer' : 'admin'
			if (persist) writeStrStorage(STORAGE_VIEW_MODE, viewMode)
			if (el.viewCustomerBtn && typeof el.viewCustomerBtn.setAttribute === 'function') {
				el.viewCustomerBtn.setAttribute('aria-pressed', viewMode === 'customer' ? 'true' : 'false')
			}
			if (el.viewAdminBtn && typeof el.viewAdminBtn.setAttribute === 'function') {
				el.viewAdminBtn.setAttribute('aria-pressed', viewMode === 'admin' ? 'true' : 'false')
			}
			if (el.ntfSection) el.ntfSection.hidden = !isAdminView()
			if (el.policyClearBtn) el.policyClearBtn.hidden = !isAdminView()
			renderProfiles({ profiles: profilesCache })
		}

		if (el.viewCustomerBtn) {
			el.viewCustomerBtn.addEventListener('click', function () { setViewMode('customer', true) })
		}
		if (el.viewAdminBtn) {
			el.viewAdminBtn.addEventListener('click', function () { setViewMode('admin', true) })
		}

		function syncRedactionUi() {
			const redact = isRedactEnabled()
			if (el.acInput) {
				el.acInput.type = redact ? 'password' : 'text'
				el.acInput.placeholder = redact
					? 'LPA:1$smdp.example.com$MATCHING-ID（不落盘、当前已脱敏）'
					: 'LPA:1$smdp.example.com$MATCHING-ID（明文显示，仍不落盘）'
			}
			if (el.ccInput) {
				el.ccInput.type = redact ? 'password' : 'text'
				el.ccInput.placeholder = redact
					? '可选，最多 64 字节（不落盘、当前已脱敏）'
					: '可选，最多 64 字节（明文显示，仍不落盘）'
			}
			if (el.logTitle) {
				el.logTitle.textContent = redact ? '操作日志（凭证已脱敏）' : '操作日志（已关闭脱敏 · 凭证可见）'
			}
		}

		if (el.insecureTls) {
			el.insecureTls.checked = readBoolStorage(STORAGE_INSECURE_TLS, false)
		}
		if (el.redactToggle) {
			el.redactToggle.checked = readBoolStorage(STORAGE_REDACT, true)
			el.redactToggle.addEventListener('change', function () {
				writeBoolStorage(STORAGE_REDACT, !!el.redactToggle.checked)
				syncRedactionUi()
			})
		}
		syncRedactionUi()

		function updateModeNotice() {
			const mode = Number(el.modeSelect ? el.modeSelect.value : 0)
			if (!el.proxyRow) return
			if (mode === 1) {
				el.proxyRow.hidden = false
				const hasNative = hasNativeHttp()
				const hasCustomProxy = !!(el.proxyUrl && el.proxyUrl.value.trim())
				if (el.tlsWrap) el.tlsWrap.hidden = !hasNative || hasCustomProxy
				if (hasCustomProxy) {
					el.proxyNotice.textContent = '将通过下方自定义 CORS 转发代理基地址转发 XFER 四轮 SM-DP+ 请求与通知。'
					el.proxyNotice.className = 'sk-esim-notice is-ok'
				} else if (hasNative) {
					if (isInsecureTlsAllowed()) {
						el.proxyNotice.textContent = '桌面端已就绪（已跳过 SM-DP+ TLS 证书校验，适用于 GSMA CI / 测试环境）：仍强制 HTTPS 与 ES9+ 路径，eUICC 在应用层校验签名。'
						el.proxyNotice.className = 'sk-esim-notice is-warn'
					} else {
						el.proxyNotice.textContent = '桌面端已就绪：将通过内置原生 HTTPS 通道转发 XFER 四轮 SM-DP+ 请求（保留系统 TLS 校验）。连接 GSMA CI / 测试 SM-DP+ 如遇证书报错，请开启下方开关。'
						el.proxyNotice.className = 'sk-esim-notice is-ok'
					}
				} else {
					el.proxyNotice.textContent = '网页版受浏览器 CORS 限制，无法直连 SM-DP+。请改用桌面客户端，或在下方填写本地 CORS 转发代理基地址。'
					el.proxyNotice.className = 'sk-esim-notice is-warn'
				}
			} else {
				el.proxyRow.hidden = true
			}
		}
		if (el.modeSelect) el.modeSelect.addEventListener('change', updateModeNotice)
		if (el.proxyUrl) el.proxyUrl.addEventListener('input', updateModeNotice)
		if (el.insecureTls) {
			el.insecureTls.addEventListener('change', function () {
				writeBoolStorage(STORAGE_INSECURE_TLS, !!el.insecureTls.checked)
				updateModeNotice()
			})
		}
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
			if (el.ntfSyncBtn) el.ntfSyncBtn.disabled = running
			if (el.ntfPurgeBtn) el.ntfPurgeBtn.disabled = running
			if (el.policyClearBtn) el.policyClearBtn.disabled = running
			if (el.modeSelect) el.modeSelect.disabled = running
			if (el.insecureTls) el.insecureTls.disabled = running
			if (el.proxyUrl) el.proxyUrl.disabled = running
			const btns = el.profileList ? el.profileList.querySelectorAll('button') : []
			btns.forEach(function (b) { b.disabled = running || b.dataset.hardDisabled === '1' })
			const chks = el.profileList ? el.profileList.querySelectorAll('input[type="checkbox"]') : []
			chks.forEach(function (c) { c.disabled = running })
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
				if (el.runtimeFlags) el.runtimeFlags.textContent = ''
				if (el.statusOp) el.statusOp.textContent = '--'
				if (el.statusStage) el.statusStage.textContent = '--'
				if (el.statusErr) el.statusErr.textContent = '--'
				if (el.statusHint) { el.statusHint.textContent = ''; el.statusHint.hidden = true }
				if (el.statusTime) el.statusTime.textContent = '--'
				if (el.cacheAge) el.cacheAge.textContent = '--'
				return
			}
			if (el.statusBadge) {
				el.statusBadge.textContent = st.stateLabel
				const cls = st.state === 2 ? 'is-ok' : (st.state === 3 ? 'is-bad' : (st.state === 1 || st.state === 4 ? 'is-warn' : ''))
				el.statusBadge.className = 'sk-esim-badge' + (cls ? ' ' + cls : '')
			}
			if (el.runtimeFlags) {
				el.runtimeFlags.textContent = ''
				const flags = [
					{ on: st.cacheRefreshing, text: '后台刷新中', cls: 'is-info' },
					{ on: st.bootCacheReady, text: '缓存已就绪', cls: 'is-ok' },
					{ on: st.nearKeepaliveActive, text: '近端续传保活中 (60s)', cls: 'is-warn' },
				]
				flags.forEach(function (f) {
					if (!f.on) return
					const sp = document.createElement('span')
					sp.className = 'sk-esim-tag ' + f.cls
					sp.textContent = f.text
					el.runtimeFlags.appendChild(sp)
				})
				if (!el.runtimeFlags.childNodes.length) {
					const sp = document.createElement('span')
					sp.className = 'sk-esim-tag'
					sp.textContent = '缓存未就绪'
					el.runtimeFlags.appendChild(sp)
				}
			}
			if (el.statusOp) el.statusOp.textContent = st.lastOpLabel
			if (el.statusStage) el.statusStage.textContent = st.failStageLabel + ' (' + st.failStage + ')'
			if (el.statusErr) {
				el.statusErr.textContent = st.moduleErrCode
					? (st.errDisplay || st.moduleErrHex)
					: '0x0000'
			}
			if (el.statusHint) {
				if (st.errHint) {
					el.statusHint.textContent = (st.errCategory === 'module-unidentified' ? '提示：' : '建议：') + st.errHint
					el.statusHint.hidden = false
				} else {
					el.statusHint.textContent = ''
					el.statusHint.hidden = true
				}
			}
			if (el.statusTime) el.statusTime.textContent = st.timeText || '--'
			if (el.cacheAge) el.cacheAge.textContent = st.cacheAgeText || '--'
		}

		function renderNtfSummary(ntf) {
			if (!ntf) {
				if (el.ntfBadge) { el.ntfBadge.textContent = '未读取'; el.ntfBadge.className = 'sk-esim-badge' }
				if (el.ntfTotal) el.ntfTotal.textContent = '--'
				if (el.ntfDel) el.ntfDel.textContent = '--'
				if (el.ntfOther) el.ntfOther.textContent = '--'
				if (el.ntfHeadEvent) el.ntfHeadEvent.textContent = '--'
				if (el.ntfHeadIccid) el.ntfHeadIccid.textContent = '--'
				return
			}
			if (ntf.unread) {
				if (el.ntfBadge) { el.ntfBadge.textContent = '尚未读取'; el.ntfBadge.className = 'sk-esim-badge' }
				if (el.ntfTotal) el.ntfTotal.textContent = '尚未读取 (0xFF)'
				if (el.ntfDel) el.ntfDel.textContent = '--'
				if (el.ntfOther) el.ntfOther.textContent = '--'
				if (el.ntfHeadEvent) el.ntfHeadEvent.textContent = '--'
				if (el.ntfHeadIccid) el.ntfHeadIccid.textContent = '--'
				return
			}
			if (el.ntfBadge) {
				el.ntfBadge.textContent = ntf.totalCount > 0 ? ('待同步 ' + ntf.totalCount + ' 条') : '无积压'
				el.ntfBadge.className = 'sk-esim-badge ' + (ntf.totalCount > 0 ? 'is-warn' : 'is-ok')
			}
			if (el.ntfTotal) el.ntfTotal.textContent = String(ntf.totalCount)
			if (el.ntfDel) el.ntfDel.textContent = String(ntf.deleteCount)
			if (el.ntfOther) el.ntfOther.textContent = String(ntf.otherCount)
			if (el.ntfHeadEvent) el.ntfHeadEvent.textContent = ntf.headEventLabel
			if (el.ntfHeadIccid) {
				const carrierSuffix = ntf.headCarrier ? (' (' + ntf.headCarrier.name + ')') : ''
				el.ntfHeadIccid.textContent = ntf.headIccid ? (ntf.headIccid + carrierSuffix) : '--'
			}
		}

		function appendNode(parent, child) {
			if (!parent || !child) return
			if (typeof parent.appendChild === 'function') parent.appendChild(child)
		}

		function renderProfiles(listObj) {
			profilesCache = listObj && Array.isArray(listObj.profiles) ? listObj.profiles : []
			const admin = isAdminView()
			const anyOtherLockDisable = function (targetIccid) {
				return profilesCache.some(function (x) {
					return x && x.enabled && x.lockDisable && x.iccid !== targetIccid
				})
			}

			const visibleList = admin
				? profilesCache.slice()
				: profilesCache.filter(function (p) { return p && (!p.hiddenUser || p.enabled) })

			if (el.profileCount) el.profileCount.textContent = String(visibleList.length)
			if (!el.profileList) return
			el.profileList.textContent = ''

			if (!visibleList.length) {
				const empty = document.createElement('div')
				empty.className = 'sk-esim-empty'
				empty.textContent = profilesCache.length
					? '当前客户视图下暂无可展示的外部 Profile'
					: '暂无 Profile（空白卡或尚未查询）'
				appendNode(el.profileList, empty)
				return
			}

			visibleList.forEach(function (p) {
				const row = document.createElement('div')
				const maskedCustomerCard = !admin && p.hiddenUser && p.enabled
				row.className = 'sk-esim-profile-row' + (maskedCustomerCard ? ' is-masked' : '')

				const mainLine = document.createElement('div')
				mainLine.className = 'sk-esim-profile-main'

				const meta = document.createElement('div')
				meta.className = 'sk-esim-profile-meta'

				const iccidEl = document.createElement('div')
				iccidEl.className = 'sk-esim-iccid'

				const tagsEl = document.createElement('div')
				tagsEl.className = 'sk-esim-tags'

				function addTag(txt, cls) {
					const sp = document.createElement('span')
					sp.className = 'sk-esim-tag' + (cls ? ' ' + cls : '')
					sp.textContent = txt
					appendNode(tagsEl, sp)
				}

				if (maskedCustomerCard) {
					// 客户视图下正启用的隐藏卡：脱敏展示为“内置默认通信通道 [使用中]”，无 ICCID、无删/禁按钮
					iccidEl.textContent = '内置默认通信通道'
					addTag('使用中', 'is-ok')
					appendNode(meta, iccidEl)
					appendNode(meta, tagsEl)
					appendNode(mainLine, meta)
					appendNode(row, mainLine)
					appendNode(el.profileList, row)
					return
				}

				iccidEl.textContent = p.iccid || '(空 ICCID)'
				const carrier = p.carrier || Core.identifyIccidCarrier(p.iccid)
				if (carrier) addTag(carrier.name, 'is-carrier')
				addTag(p.enabled ? '已启用' : '已禁用', p.enabled ? 'is-ok' : '')
				addTag(p.profileClassLabel, '')

				if (admin) {
					if (p.hiddenUser) addTag('客户隐藏', 'is-hidden')
					if (p.fallbackSeed) addTag('保底', 'is-info')
					if (p.lockDelete) addTag('禁删', 'is-lock')
					if (p.lockDisable) addTag('禁停', 'is-lock')
					if (p.hasPendingNtf) addTag('有待发通知', 'is-ntf')
				} else {
					if (p.lockDelete) addTag('🔒禁删', 'is-lock')
					if (p.lockDisable) addTag('🔒禁停', 'is-lock')
				}

				appendNode(meta, iccidEl)
				appendNode(meta, tagsEl)

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
					b.addEventListener('click', function () { return handleProfileOp(op, p) })
					return b
				}

				// 已启用卡隐藏 [启用]；另一张已启用卡锁定禁停时禁用 [启用]
				if (!p.enabled) {
					const blockedByOther = anyOtherLockDisable(p.iccid)
					appendNode(acts, makeActBtn(
						'启用', 1, 'btn-outline-success', blockedByOther,
						blockedByOther ? '当前启用卡已配置禁止禁用/切走保护' : '发送 Tag66-ID5 op=1 启用切卡'
					))
				}

				appendNode(acts, makeActBtn(
					'禁用', 2, 'btn-outline-warning', p.lockDisable,
					p.lockDisable ? '策略已锁定，禁止禁用或切走' : '发送 Tag66-ID5 op=2 禁用'
				))

				// 客户视图下禁删卡隐藏删除按钮（或置灰）；已启用卡置灰删除按钮（需先切走/禁用）
				if (admin || !p.lockDelete) {
					const delHardDisabled = p.enabled || p.lockDelete
					const delTitle = p.lockDelete
						? '策略已锁定，禁止删除'
						: (p.enabled ? '需先切走或禁用后才能删除' : '发送 Tag66-ID5 op=3 删除（最长 60s）')
					appendNode(acts, makeActBtn('删除', 3, 'btn-outline-danger', delHardDisabled, delTitle))
				}

				appendNode(mainLine, meta)
				appendNode(mainLine, acts)
				appendNode(row, mainLine)

				// 管理员视图：每张卡提供策略勾选保存（发 ID7 op=0）
				if (admin && p.iccid) {
					const polRow = document.createElement('div')
					polRow.className = 'sk-esim-policy-row'

					const defs = [
						{ bit: Core.POLICY_BITS.LOCK_DELETE, label: '禁删', checked: !!p.lockDelete },
						{ bit: Core.POLICY_BITS.LOCK_DISABLE, label: '禁停', checked: !!p.lockDisable },
						{ bit: Core.POLICY_BITS.HIDDEN_USER, label: '客户隐藏', checked: !!p.hiddenUser },
						{ bit: Core.POLICY_BITS.FALLBACK_SEED, label: '保底', checked: !!p.fallbackSeed },
					]
					const boxes = []
					defs.forEach(function (d) {
						const lbl = document.createElement('label')
						lbl.className = 'sk-esim-policy-chk'
						const inp = document.createElement('input')
						inp.type = 'checkbox'
						inp.checked = d.checked
						inp.disabled = running
						inp.dataset.policyBit = String(d.bit)
						const sp = document.createElement('span')
						sp.textContent = d.label
						appendNode(lbl, inp)
						appendNode(lbl, sp)
						appendNode(polRow, lbl)
						boxes.push({ bit: d.bit, inp })
					})

					const saveBtn = document.createElement('button')
					saveBtn.type = 'button'
					saveBtn.className = 'btn btn-xs btn-outline-primary'
					saveBtn.textContent = '保存策略'
					saveBtn.title = '发送 Tag66-ID7 op=0 同步写入 MCU 管控策略并刷新 ID1'
					saveBtn.disabled = running
					saveBtn.addEventListener('click', function () {
						let mask = 0
						boxes.forEach(function (x) { if (x.inp.checked) mask |= x.bit })
						return handleSavePolicy(p.iccid, mask)
					})
					appendNode(polRow, saveBtn)
					appendNode(row, polRow)
				}

				appendNode(el.profileList, row)
			})
		}

		// 初始化视图模式显隐
		setViewMode(viewMode, false)

		function decodeAsciiItem(item) {
			if (!item) return ''
			if (item.raw && item.raw.length) {
				let s = ''
				for (let i = 0; i < item.raw.length; i++) {
					const c = item.raw[i] & 0xff
					if (c === 0) break
					s += String.fromCharCode(c)
				}
				return s.trim()
			}
			return item.decoded != null ? String(item.decoded).trim() : ''
		}

		function getCurrentModuleInfo(frame) {
			if (window.serialApi && typeof window.serialApi.getActiveLaneModuleInfo === 'function') {
				return window.serialApi.getActiveLaneModuleInfo(activePhysSid())
			}
			if (frame && frame.sessionModule) return frame.sessionModule
			if (window.skSession && typeof window.skSession.getModuleInfo === 'function') {
				return window.skSession.getModuleInfo()
			}
			return null
		}

		function applyTag66Frame(frame, probedModuleInfo) {
			if (!frame || !window.sekTx) return { status: null }
			const it0 = window.sekTx.findTlvItem(frame, 66, 0)
			const it1 = window.sekTx.findTlvItem(frame, 66, 1)
			const it2 = window.sekTx.findTlvItem(frame, 66, 2)
			const it3 = window.sekTx.findTlvItem(frame, 66, 3)
			const eid = (it0 && it0.raw) ? Core.decodeEid(it0.raw) : null
			const profiles = (it1 && it1.raw) ? Core.decodeProfileList(it1.raw) : null
			const laneInfo = getCurrentModuleInfo(frame)
			const moduleInfo = (laneInfo && laneInfo.known) ? laneInfo : (probedModuleInfo || laneInfo)
			const st = (it2 && it2.raw) ? Core.decodeStatus(it2.raw, { moduleInfo }) : null
			const ntf = (it3 && it3.raw) ? Core.decodeNtfSummary(it3.raw) : null

			if (eid) renderEid(eid)
			if (profiles) renderProfiles(profiles)
			if (st) renderStatus(st)
			if (ntf) renderNtfSummary(ntf)
			return { eid, profiles, status: st, ntfSummary: ntf }
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

		// 刷新前探测基础信息（0x03 Tag10-ID1 -> Tag1 ID10/ID12）识别模组型号前缀；失败或未返回版本号时优雅降级，不阻塞后续 Tag66
		async function queryBaseModuleInfo(timeoutMs) {
			try {
				const res = await window.sekTx.sendAndWait({
					buildOpts: {
						funcCode: 0x03,
						tlv: [{ tag: 10, items: [{ id: 1, value: null }] }],
					},
					expectFunc: 0x83,
					match: function (f) { return window.sekTx.hasTag(f, 1) },
					timeoutMs: timeoutMs || 3000,
				})
				const frame = res && res.frame
				if (!frame) return null
				const it10 = window.sekTx.findTlvItem(frame, 1, 10)
				const it12 = window.sekTx.findTlvItem(frame, 1, 12)
				const moduleVersion = decodeAsciiItem(it10)
				const moduleModel = decodeAsciiItem(it12)
				const profile = Core.detectModuleProfile({ moduleVersion, moduleModel })
				if (profile.known) {
					const uid = frame.fields && frame.fields['设备唯一编码'] != null ? frame.fields['设备唯一编码'] : null
					if (window.serialApi && typeof window.serialApi.setActiveLaneModuleInfo === 'function') {
						window.serialApi.setActiveLaneModuleInfo(activePhysSid(), {
							deviceUid: uid,
							moduleVersion: profile.moduleVersion,
							moduleModel: profile.moduleModel,
						})
					} else if (window.skSession) {
						if (uid != null && typeof window.skSession.touchDevice === 'function') window.skSession.touchDevice(uid)
						if (profile.moduleVersion && typeof window.skSession.setModuleVersion === 'function') window.skSession.setModuleVersion(profile.moduleVersion, 'Tag1-ID10')
						if (profile.moduleModel && typeof window.skSession.setModuleModel === 'function') window.skSession.setModuleModel(profile.moduleModel, 'Tag1-ID12')
					}
					return profile
				}
				return null
			} catch (e) {
				return { error: e && e.message ? e.message : String(e) }
			}
		}

		async function queryTag66(timeoutMs, probedModuleInfo) {
			const res = await window.sekTx.sendAndWait({
				buildOpts: {
					funcCode: 0x03,
					tlv: [{ tag: 10, items: [{ id: 66, value: null }] }],
				},
				expectFunc: 0x83,
				match: function (f) { return window.sekTx.hasTag(f, 66) },
				timeoutMs: timeoutMs || 6000,
			})
			return applyTag66Frame(res.frame, probedModuleInfo)
		}

		function activePhysSid() {
			// getActiveSendSid 返回 UI 路号（单路固定为 'A'）；底层会话操作需要物理会话 ID（单路 'S'，双路 'A'/'B'）
			return typeof window.serialApi.getMode === 'function' && window.serialApi.getMode() === 'single'
				? 'S'
				: window.serialApi.getActiveSendSid()
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

		function xferLogPlaceholder(byteLen) {
			const txt = '[XFER TX ' + byteLen + 'B]'
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
				setStatusText(label + '：轮询 ID2 状态（第 ' + pollCount + ' 次）…')
				try {
					const info = await queryTag66(6000)
					const st = info.status
					if (st && st.state !== 1) {
						const errPart = st.moduleErrCode ? (' · ' + (st.errDisplay || st.moduleErrHex)) : ''
						const summary = st.stateLabel + ' · ' + st.failStageLabel + errPart
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
			const map = { 0: '0:已受理(处理中/完成)', 1: '1:处理成功', 2: '2:消息格式有误', 3: '3:不支持或超出范围', 4: '4:忙或安全/策略约束拒绝' }
			return map[code] || String(code)
		}

		function createXferSessionBridge(sid, redact) {
			const queue = XF.createByteQueue()
			let unsubRx = window.serialApi.onReceiveFrom(sid, function (chunk) {
				queue.push(chunk)
			})
			let rxLogSuppressed = false
			const prevSuppress = window.serialApi.suppressParse
			window.serialApi.suppressParse = true
			if (redact && typeof window.serialApi.setSuppressRxLog === 'function') {
				window.serialApi.setSuppressRxLog(sid, true)
				rxLogSuppressed = true
			}

			const io = {
				readByte: function (ms) {
					if (!window.serialApi.isSessionOpen(sid)) {
						queue.fail(new Error('通信链路已断开'))
					}
					return queue.readByte(ms)
				},
				writeBytes: function (bytes) {
					return window.serialApi.writeRawTo(sid, bytes, redact ? { logData: xferLogPlaceholder(bytes.length) } : undefined)
				},
			}

			// 60s 断连保活等待重连：用户重连顶部链路后自动恢复 RX 订阅并交给 Xfer.push 发起 QUERY 续传
			async function waitReconnect(info) {
				const deadline = Date.now() + (info.keepaliveMs || KEEPALIVE_WAIT_MS)
				addLog('近端链路已断开（已发送 ' + info.offset + '/' + info.totalSize + 'B），等待 60s 内重连以 QUERY 续传…', 'warn')
				while (Date.now() < deadline) {
					if (info.signal && info.signal.aborted) throw new Error('已取消等待重连')
					if (window.serialApi.isSessionOpen(sid)) {
						queue.reset()
						if (unsubRx) { unsubRx(); unsubRx = null }
						unsubRx = window.serialApi.onReceiveFrom(sid, function (chunk) {
							queue.push(chunk)
						})
						addLog('近端链路已重连，发送 XFER QUERY 查询断点偏移…', 'info')
						return io
					}
					const remSec = Math.max(1, Math.ceil((deadline - Date.now()) / 1000))
					setStatusText('链路已断开，MCU 保活中：请在 ' + remSec + 's 内重连设备以自动续传…')
					await sleep(500, info.signal)
				}
				throw new Error('断连保活 60s 内未重连，无法续传')
			}

			function cleanup() {
				if (unsubRx) { unsubRx(); unsubRx = null }
				if (rxLogSuppressed && typeof window.serialApi.setSuppressRxLog === 'function') {
					window.serialApi.setSuppressRxLog(sid, false)
					rxLogSuppressed = false
				}
				window.serialApi.suppressParse = prevSuppress
			}

			return { io, waitReconnect, cleanup }
		}

		async function handleRefresh() {
			if (running || !ensureReady()) return
			abortCtrl = new AbortController()
			setBusy(true)
			setStatusText('正在查询基础信息以识别模组型号 (0x03 Tag10-ID1)…')
			setProgress(15, '识别模组')
			try {
				let probed = null
				const baseProbe = await queryBaseModuleInfo(3000)
				if (abortCtrl && abortCtrl.signal.aborted) throw new Error('已手动停止查询')
				if (baseProbe && baseProbe.known) {
					probed = baseProbe
					const verSuffix = baseProbe.moduleVersion ? (' (' + baseProbe.moduleVersion + ')') : ''
					addLog('基础信息识别模组：' + (baseProbe.modelPrefix || baseProbe.label) + verSuffix, 'info')
				} else if (baseProbe && baseProbe.error) {
					addLog('基础信息查询未应答（已降级，继续查询 Tag66）：' + baseProbe.error, 'warn')
				} else {
					addLog('基础信息未返回有效模组版本号（已降级，继续查询 Tag66）', 'info')
				}
				setStatusText('正在查询 eSIM 信息 (0x03 Tag10-ID66 → ID0~ID3)…')
				setProgress(45, '查询中')
				const info = await queryTag66(6000, probed)
				const cnt = info.profiles ? info.profiles.count : 0
				const ntfTxt = info.ntfSummary
					? (info.ntfSummary.unread ? '待发通知未读' : ('待发通知=' + info.ntfSummary.totalCount + '条'))
					: ''
				setStatusText('查询完成：共 ' + cnt + ' 个 Profile' + (ntfTxt ? (' · ' + ntfTxt) : ''))
				setProgress(100, '已刷新')
				addLog('查询 Tag66 完成：EID=' + (info.eid && info.eid.ready ? info.eid.eid : '未就绪') + '，Profile=' + cnt + '条' + (ntfTxt ? ('，' + ntfTxt) : ''), 'ok')
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
			addLog('开始持续轮询 ID2 状态，直到离开执行中状态…', 'info')
			const sid = activePhysSid()
			let pinned = false
			try {
				pinned = acquirePin(sid)
				await pollUntilTerminal(POLL_MAX_DOWNLOAD_MS, 'ID2 轮询', abortCtrl.signal)
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
			addLog('下发 Tag66-ID5 ' + opLabel + ' ICCID=' + profile.iccid, 'info')

			const sid = activePhysSid()
			let pinned = false
			try {
				pinned = acquirePin(sid)
				const res = await window.sekTx.sendAndWait({
					buildOpts: {
						funcCode: 0x01,
						tlv: [{ tag: 66, items: [{ id: 5, value: val }] }],
					},
					expectFunc: 0x81,
					acceptProcessing: false,
					timeoutMs: 6000,
				})
				const code = res.tag11
				if (code === 0 || code === 1) {
					addLog('设备已受理 (' + resultCodeText(code) + ')，开始轮询 ID2…', 'info')
					setProgress(40, '执行中')
					await pollUntilTerminal(op === 3 ? POLL_MAX_DELETE_MS : POLL_MAX_MANAGE_MS, opLabel, abortCtrl.signal)
				} else {
					const msg = '设备同步拒绝：' + resultCodeText(code) + '（未修改 ID2）'
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

		// ID7 同步写入卡管控策略（op=0 设置单卡，op=1 清空全部）
		async function handleSavePolicy(iccid, policyMask) {
			if (running || !ensureReady()) return
			let val
			try {
				val = Core.encodeProfilePolicy({ op: 0, iccid, policyMask })
			} catch (e) {
				await dialogAlert(e.message, '策略参数错误')
				return
			}

			abortCtrl = new AbortController()
			setBusy(true)
			setStatusText('正在写入卡管控策略 (ID7 op=0)…')
			setProgress(30, '写策略')
			addLog('下发 Tag66-ID7 op=0 ICCID=' + iccid + ' mask=0x' + (policyMask & 0x0f).toString(16).toUpperCase().padStart(2, '0'), 'info')

			const sid = activePhysSid()
			let pinned = false
			try {
				pinned = acquirePin(sid)
				const res = await window.sekTx.sendAndWait({
					buildOpts: {
						funcCode: 0x01,
						tlv: [{ tag: 66, items: [{ id: 7, value: val }] }],
					},
					expectFunc: 0x81,
					acceptProcessing: false,
					timeoutMs: 6000,
				})
				const code = res.tag11
				if (code === 0 || code === 1) {
					addLog('策略已同步落盘 (' + resultCodeText(code) + ')，正在刷新 ID1…', 'ok')
					setProgress(70, '刷新中')
					await queryTag66(6000)
					setStatusText('卡管控策略已保存并刷新')
					setProgress(100, '已保存')
				} else {
					const msg = '策略写入被拒绝：' + resultCodeText(code)
					setStatusText(msg)
					setProgress(0, '已拒绝')
					addLog(msg, 'bad')
				}
			} catch (e) {
				setStatusText('策略写入失败：' + (e && e.message ? e.message : e))
				setProgress(0, '失败')
				addLog('策略写入失败：' + (e && e.message ? e.message : e), 'bad')
			} finally {
				if (pinned) window.serialApi.unpinSession()
				abortCtrl = null
				setBusy(false)
			}
		}

		async function handleClearAllPolicies() {
			if (running || !ensureReady()) return
			const ok = await dialogConfirm('确认发送 Tag66-ID7 op=1 清空设备中全部 eSIM 管控策略（解除所有禁删/禁停/隐藏/保底标记）？', '清空全部策略确认')
			if (!ok) return

			const val = Core.encodeProfilePolicy({ op: 1 })
			abortCtrl = new AbortController()
			setBusy(true)
			setStatusText('正在清空全部卡管控策略 (ID7 op=1)…')
			setProgress(30, '清策略')
			addLog('下发 Tag66-ID7 op=1 清空全部卡管控策略', 'info')

			const sid = activePhysSid()
			let pinned = false
			try {
				pinned = acquirePin(sid)
				const res = await window.sekTx.sendAndWait({
					buildOpts: {
						funcCode: 0x01,
						tlv: [{ tag: 66, items: [{ id: 7, value: val }] }],
					},
					expectFunc: 0x81,
					acceptProcessing: false,
					timeoutMs: 6000,
				})
				const code = res.tag11
				if (code === 0 || code === 1) {
					addLog('全部策略已清空 (' + resultCodeText(code) + ')，正在刷新 ID1…', 'ok')
					setProgress(70, '刷新中')
					await queryTag66(6000)
					setStatusText('全部卡管控策略已清空')
					setProgress(100, '已清空')
				} else {
					const msg = '清空策略被拒绝：' + resultCodeText(code)
					setStatusText(msg)
					setProgress(0, '已拒绝')
					addLog(msg, 'bad')
				}
			} catch (e) {
				setStatusText('清空策略失败：' + (e && e.message ? e.message : e))
				setProgress(0, '失败')
				addLog('清空策略失败：' + (e && e.message ? e.message : e), 'bad')
			} finally {
				if (pinned) window.serialApi.unpinSession()
				abortCtrl = null
				setBusy(false)
			}
		}

		// ID6 op=1 同步待发通知（近端经 XFER target=0x03 拉取并 POST handleNotification）
		async function handleNtfSync() {
			if (running || !ensureReady()) return
			const proxyBaseUrl = el.proxyUrl ? el.proxyUrl.value.trim() : ''
			const allowInsecureTls = !proxyBaseUrl && isInsecureTlsAllowed()
			const httpPost = createHttpPoster(proxyBaseUrl, allowInsecureTls)
			if (!httpPost) {
				await dialogAlert('当前浏览器环境不支持直接向 SM-DP+ 发起 HTTPS POST（CORS 限制）。\n请使用桌面客户端，或在下载区「代理基址」填入支持 CORS 的转发代理后再同步离线通知。', '无法同步离线待发通知')
				return
			}

			const redact = isRedactEnabled()
			const val = Core.encodeNtfManage({ op: 1 })
			abortCtrl = new AbortController()
			setBusy(true)
			setProgress(10, '触发同步')
			setStatusText('正在下发同步待发通知 (ID6 op=1)…')
			addLog('下发 Tag66-ID6 op=1 同步待发通知（XFER target=0x03）', 'info')

			const sid = activePhysSid()
			let pinned = false
			let bridge = null
			try {
				pinned = acquirePin(sid)
				const res = await window.sekTx.sendAndWait({
					buildOpts: {
						funcCode: 0x01,
						tlv: [{ tag: 66, items: [{ id: 6, value: val }] }],
					},
					expectFunc: 0x81,
					acceptProcessing: false,
					timeoutMs: 6000,
				})
				const code = res.tag11
				if (code !== 0 && code !== 1) {
					const msg = '设备同步拒绝通知同步：' + resultCodeText(code)
					setStatusText(msg)
					setProgress(0, '已拒绝')
					addLog(msg, 'bad')
					return
				}

				addLog('设备已受理 (' + resultCodeText(code) + ')，启动 XFER (target=0x03) 拉取并上报待发通知…', 'info')
				setProgress(25, '拉取通知')
				bridge = createXferSessionBridge(sid, redact)

				const syncRes = await Core.runNtfSyncProxySession({
					xfer: XF,
					io: bridge.io,
					httpPost: httpPost,
					proxyBaseUrl: proxyBaseUrl,
					signal: abortCtrl.signal,
					onEvent: function (ev) {
						if (ev.type === 'ntf-item-start') {
							setStatusText('正在上报通知 seq=' + ev.seq + ' → ' + ev.fqdn + ' (' + ev.bytes + 'B)…')
							addLog('拉取待发通知 seq=' + ev.seq + ' (' + ev.fqdn + ', ' + ev.bytes + 'B)，开始 POST…', 'info')
						} else if (ev.type === 'ntf-item-done') {
							if (ev.deleted) {
								addLog('通知 seq=' + ev.seq + ' (' + ev.fqdn + ') 上报 HTTP 204 成功并已删除', 'ok')
							} else {
								const reason = ev.error ? ('异常: ' + ev.error) : ('HTTP ' + ev.httpStatus)
								addLog('通知 seq=' + ev.seq + ' (' + ev.fqdn + ') 上报未返回 204（' + reason + '），已跳过保留', 'warn')
							}
						} else if (ev.type === 'error') {
							addLog('通知同步异常：' + ev.message, 'bad')
						}
					},
				})

				bridge.cleanup()
				bridge = null
				addLog('XFER 通知同步结束：成功删除 ' + syncRes.deletedCount + ' 条，跳过 ' + syncRes.skippedCount + ' 条', syncRes.skippedCount ? 'warn' : 'ok')
				setProgress(85, '核对终态')

				if (window.serialApi.isSessionOpen(sid)) {
					try {
						await sleep(800, abortCtrl.signal)
						await pollUntilTerminal(30000, '同步通知收尾', abortCtrl.signal)
					} catch (e) {
						addLog('收尾状态刷新未完成（可点击「刷新信息」核对）：' + (e && e.message ? e.message : e), 'warn')
					}
				}
			} catch (e) {
				const msg = e && e.message ? e.message : String(e)
				setStatusText('同步通知失败：' + msg)
				setProgress(0, '失败')
				addLog('同步通知失败：' + msg, 'bad')
			} finally {
				if (bridge) bridge.cleanup()
				if (pinned) window.serialApi.unpinSession()
				abortCtrl = null
				setBusy(false)
			}
		}

		// ID6 op=2 强制清空本地死通知（仅近端通道可用，弹窗二次确认）
		async function handleNtfPurge() {
			if (running || !ensureReady()) return
			const ok1 = await dialogConfirm(
				'危险操作：强制清空本地死通知 (ID6 op=2) 将直接删除 eUICC 本地积压的全部待发通知，且不会向 SM-DP+ 上报（仅限近端 BLE/红外通道可用，远端通道会同步拒绝）。\n\n确认继续吗？',
				'强清本地死通知（第 1 次确认）'
			)
			if (!ok1) return
			const ok2 = await dialogConfirm(
				'再次确认：确定要永久清除本地全部未同步通知吗？此操作不可撤销。',
				'强清本地死通知（第 2 次确认）'
			)
			if (!ok2) return

			const val = Core.encodeNtfManage({ op: 2 })
			abortCtrl = new AbortController()
			setBusy(true)
			setProgress(15, '强清通知')
			setStatusText('正在下发强清本地死通知 (ID6 op=2)…')
			addLog('下发 Tag66-ID6 op=2 强制清空本地死通知', 'warn')

			const sid = activePhysSid()
			let pinned = false
			try {
				pinned = acquirePin(sid)
				const res = await window.sekTx.sendAndWait({
					buildOpts: {
						funcCode: 0x01,
						tlv: [{ tag: 66, items: [{ id: 6, value: val }] }],
					},
					expectFunc: 0x81,
					acceptProcessing: false,
					timeoutMs: 6000,
				})
				const code = res.tag11
				if (code === 0 || code === 1) {
					addLog('设备已受理 (' + resultCodeText(code) + ')，开始轮询 ID2…', 'info')
					setProgress(45, '执行中')
					await pollUntilTerminal(POLL_MAX_NTF_MS, '强清本地死通知', abortCtrl.signal)
				} else {
					const msg = '设备同步拒绝强清通知：' + resultCodeText(code) + '（仅近端通道可用）'
					setStatusText(msg)
					setProgress(0, '已拒绝')
					addLog(msg, 'bad')
				}
			} catch (e) {
				setStatusText('强清通知失败：' + (e && e.message ? e.message : e))
				setProgress(0, '失败')
				addLog('强清通知失败：' + (e && e.message ? e.message : e), 'bad')
			} finally {
				if (pinned) window.serialApi.unpinSession()
				abortCtrl = null
				setBusy(false)
			}
		}

		// 构建下载触发帧 (Tag=66 ID=4)：开启脱敏时同时生成打码后的 logData 副本，关闭脱敏时原样记入串口日志（AC/CC 始终不落盘）
		function buildDownloadFrames(mode, ac, cc, redact) {
			const val = Core.encodeDownloadTrigger({ mode, ac, cc })
			const seq = window.sekTx.nextSeq()
			const now = new Date()
			const encKey = typeof window.serialApi.getEncKey === 'function' ? window.serialApi.getEncKey() : null
			const frame = window.skBuildDownFrame({
				frameSeq: seq,
				version: 2,
				time: now,
				funcCode: 0x01,
				encKey: encKey,
				tlv: [{ tag: 66, items: [{ id: 4, value: val }] }],
			})
			let logFrame = null
			if (redact) {
				const redactedVal = Core.redactDownloadValue(val)
				logFrame = window.skBuildDownFrame({
					frameSeq: seq,
					version: 2,
					time: now,
					funcCode: 0x01,
					encKey: null,
					tlv: [{ tag: 66, items: [{ id: 4, value: redactedVal }] }],
				})
			}
			return { frame, logFrame, seq }
		}

		function createHttpPoster(proxyBaseUrl, allowInsecureTls) {
			const nativeSvc = P && typeof P.service === 'function' ? P.service('esim-http') : null
			if (nativeSvc && !proxyBaseUrl) {
				return function (req) {
					return nativeSvc.post({
						url: req.url,
						bodyBytes: req.bodyBytes,
						allowInsecureTls: !!allowInsecureTls,
					})
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
			const allowInsecureTls = !proxyBaseUrl && isInsecureTlsAllowed()

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
				httpPost = createHttpPoster(proxyBaseUrl, allowInsecureTls)
				if (!httpPost) {
					await dialogAlert('当前浏览器环境不支持直接向 SM-DP+ 发起 HTTPS POST（CORS 限制）。\n请使用桌面客户端，或在「代理基址」填入支持 CORS 的转发代理。', '无法启动近端外部代理')
					return
				}
			}

			const redact = isRedactEnabled()
			let built
			try {
				built = buildDownloadFrames(mode, acRaw, ccRaw, redact)
			} catch (e) {
				await dialogAlert(e.message, '参数错误')
				return
			}

			abortCtrl = new AbortController()
			setBusy(true)
			setProgress(5, '触发下载')
			const modeName = Core.MODE_LABELS[mode] || ('mode=' + mode)
			setStatusText('正在发送下载触发 (ID4 ' + modeName + ')…')
			const tlsTag = mode === 1 && allowInsecureTls ? '，已跳过 TLS 证书校验' : ''
			const credLog = redact
				? '（AC/CC 已脱敏）'
				: ('，AC=' + acRaw + (ccRaw ? '，CC=' + ccRaw : ''))
			addLog('触发 Profile 下载 (Tag66-ID4)：' + modeName + '，SM-DP+=' + acInfo.smdpHost + tlsTag + credLog, 'info')

			const sid = activePhysSid()
			let pinned = false
			let bridge = null
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

				await window.serialApi.writeRawTo(sid, built.frame, built.logFrame ? { logData: built.logFrame } : undefined)
				const ack = await waitAck
				const code = window.sekTx.tag11Result(ack.frame)

				if (code !== 0 && code !== 1) {
					const msg = '设备同步拒绝下载：' + resultCodeText(code) + '（未修改 ID2）'
					setStatusText(msg)
					setProgress(0, '已拒绝')
					addLog(msg, 'bad')
					return
				}

				if (mode === 0) {
					addLog('设备已受理 mode=0 内网下载 (' + resultCodeText(code) + ')，开始轮询 ID2（最长 180s）…', 'info')
					setProgress(25, '模组下载中')
					await pollUntilTerminal(POLL_MAX_DOWNLOAD_MS, '内网下载', abortCtrl.signal)
				} else if (mode === 1) {
					// 0x81 就绪后进入近端 XFER (0xA5 0x5A) 四轮 ES9+ 代理（支持第 3 轮 60s 断连保活 QUERY 续传）
					addLog('设备已就绪 (' + resultCodeText(code) + ')，进入 XFER (0xA5 0x5A) 四轮 ES9+ 代理' + (redact ? '' : '（已关闭脱敏，串口日志记录原始 XFER 报文）') + '…', 'info')
					setProgress(15, 'XFER 准备')

					bridge = createXferSessionBridge(sid, redact)

					await Core.runMode1ProxySession({
						xfer: XF,
						io: bridge.io,
						httpPost: httpPost,
						smdpHost: acInfo.smdpHost,
						proxyBaseUrl: proxyBaseUrl,
						waitReconnect: bridge.waitReconnect,
						signal: abortCtrl.signal,
						onEvent: function (ev) {
							if (ev.type === 'round-start') {
								const pct = 15 + ev.round * 20
								setProgress(pct, '第 ' + (ev.round + 1) + '/4 轮')
								setStatusText(ev.label + '：XFER PULL 等待 MCU 请求…')
								addLog(ev.label + ' 开始', 'info')
							} else if (ev.type === 'http-start') {
								setStatusText('第 ' + (ev.round + 1) + '/4 轮：转发 HTTPS POST (' + ev.reqBytes + 'B)…')
								addLog('第 ' + (ev.round + 1) + '/4 轮已拉取 MCU 请求 (' + ev.reqBytes + 'B)，正在请求 SM-DP+…', 'info')
							} else if (ev.type === 'http-done') {
								addLog('第 ' + (ev.round + 1) + '/4 轮 SM-DP+ 响应 HTTP ' + ev.httpStatus + ' (' + ev.respBytes + 'B)', ev.httpStatus === 200 || ev.httpStatus === 204 ? 'ok' : 'bad')
							} else if (ev.type === 'xfer-tx-start') {
								setStatusText('第 ' + (ev.round + 1) + '/4 轮：XFER PUSH 回灌 ' + ev.totalBytes + 'B…')
							} else if (ev.type === 'xfer-tx-progress' && ev.totalBytes > 0) {
								const base = 15 + ev.round * 20
								const pct = base + Math.round((ev.transferredBytes / ev.totalBytes) * 18)
								setProgress(pct, '第 ' + (ev.round + 1) + '/4 轮 ' + Math.round((ev.transferredBytes / ev.totalBytes) * 100) + '%')
							} else if (ev.type === 'xfer-resumed') {
								addLog('第 ' + (ev.round + 1) + '/4 轮 XFER QUERY 续传成功：从偏移 ' + ev.ackedOffset + '/' + ev.totalSize + 'B 继续回灌（块长 ' + ev.agreedChunk + 'B）', 'ok')
							} else if (ev.type === 'error') {
								addLog('代理中止：' + ev.message, 'bad')
							}
						},
					})

					setProgress(95, '四轮完成')
					setStatusText('XFER 四轮透传完成！等待设备落盘…')
					addLog('XFER 四轮 ES9+ 透传全部完成', 'ok')

					bridge.cleanup()
					bridge = null

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
				if (bridge) bridge.cleanup()
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
		if (el.ntfSyncBtn) el.ntfSyncBtn.addEventListener('click', handleNtfSync)
		if (el.ntfPurgeBtn) el.ntfPurgeBtn.addEventListener('click', handleNtfPurge)
		if (el.policyClearBtn) el.policyClearBtn.addEventListener('click', handleClearAllPolicies)
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
