// 客户端更新界面只调用平台服务；浏览器与移动端没有服务时不生成任何入口。
;(function (root) {
	'use strict'

	// 后台检测间隔；窗口切回前台时距上次检测超过同一间隔才补查
	const CHECK_INTERVAL_MS = 6 * 3600000

	function blockers(env) {
		const reasons = env.Workbench && env.Workbench.updateBlockers ? env.Workbench.updateBlockers().slice() : []
		if (env.serialApi && env.serialApi.isPinned()) reasons.push('协议事务')
		// 连接中的功耗仪可能仍在接收或归档，不在安装时强行截断。
		if (env.bluApi && (env.bluApi.isBusyForUpdate ? env.bluApi.isBusyForUpdate() : env.bluApi.isOpen())) reasons.push('功耗仪连接')
		if (!env.serialApi || !env.serialApi.prepareForAppUpdate) reasons.push('页面尚未就绪')
		return Array.from(new Set(reasons))
	}

	function createController(service, env, changed) {
		let pending = null
		let busy = false
		let frozen = false
		let operation = null
		const emit = changed || function () {}
		function freeze(value) {
			frozen = value
			service.setPreparing(value)
			if (env.serialApi) env.serialApi.updatePreparing = value
			if (!value && env.serialApi && env.serialApi.resumeAfterAppUpdate) env.serialApi.resumeAfterAppUpdate()
			emit({ state: value ? 'preparing' : 'idle', frozen: value })
		}
		return {
			get pending() { return pending },
			get busy() { return busy },
			get frozen() { return frozen },
			async check() {
				if (busy || frozen) return undefined
				busy = true
				emit({ state: 'checking' })
				try {
					pending = await service.check()
					emit({ state: pending ? 'available' : 'current', update: pending })
					return pending
				} catch (e) {
					pending = null
					emit({ state: 'error', retry: 'check' })
					throw e
				} finally { busy = false }
			},
			async install() {
				if (busy || frozen || !pending) return false
				const reasons = blockers(env)
				if (reasons.length) {
					emit({ state: 'blocked', reasons: reasons })
					return false
				}
				busy = true
				let succeeded = false
				emit({ state: 'downloading' })
				try {
					await service.install(pending.version)
					succeeded = true
					return true
				} catch (e) {
					emit({ state: 'error', retry: 'install' })
					throw e
				} finally {
					busy = false
					// 后端 finished 事件为主；invoke 失败也解除本窗口的临时冻结。
					if (frozen && !succeeded) freeze(false)
				}
			},
			async prepare(data) {
				if (!data || data.operationId == null || operation != null) return
				operation = data.operationId
				let ready = false
				let session = {}
				try {
					const reasons = blockers(env)
					if (reasons.length) {
						emit({ state: 'blocked', reasons: reasons })
					} else {
						freeze(true)
						await env.serialApi.prepareForAppUpdate()
						// 安装准备过程中如果后端已超时或取消，不能交付迟到的确认。
						ready = frozen && operation === data.operationId
						if (ready) {
							if (!env.sessionStorage) throw new Error('会话存储不可用')
							for (let i = 0; i < env.sessionStorage.length; i++) {
								const key = env.sessionStorage.key(i)
								if (key === 'appInstanceId' || /^serial/.test(key)) session[key] = env.sessionStorage.getItem(key)
							}
						}
					}
				} catch (e) { ready = false; emit({ state: 'blocked', reasons: ['会话未确认保存或串口未确认释放'] }) }
				try { await service.ack(data.operationId, ready, session) } catch (e) { ready = false }
				if (!ready && frozen && operation === data.operationId) freeze(false)
			},
			progress(data) {
				emit({ state: data.state, downloaded: data.downloaded, total: data.total })
			},
			finished(data) {
				if (operation != null && data.operationId !== operation) return
				operation = null
				if (!data.success) {
					if (frozen) freeze(false)
					emit({ state: 'error', retry: 'install' })
				}
			},
		}
	}

	if (typeof module !== 'undefined' && module.exports) module.exports = { blockers: blockers, createController: createController }
	const service = root.AppPlatform && root.AppPlatform.service('app-update')
	if (!service || !root.document) return
	const doc = root.document
	let status, action, shield, retry = 'check', lastCheck = 0, manualChecking = false
	let previousFocus = null
	function showShield(on) {
		if (on && !shield) {
			previousFocus = doc.activeElement
			shield = doc.createElement('div')
			shield.className = 'app-update-shield'
			shield.setAttribute('role', 'dialog')
			shield.setAttribute('aria-modal', 'true')
			shield.setAttribute('aria-label', '正在安装应用更新')
			shield.tabIndex = -1
			shield.textContent = '正在保存会话并安装更新，请稍候…'
			doc.body.appendChild(shield)
			shield.focus()
		} else if (!on && shield) {
			shield.remove()
			shield = null
			if (previousFocus && doc.contains(previousFocus)) previousFocus.focus()
		}
	}
	const controller = createController(service, root, function (s) {
		if (s.frozen != null) showShield(s.frozen)
		if (!status) return
		if (s.state === 'idle') return
		const version = doc.getElementById('app-version')
		if (version && (s.state === 'current' || (s.state === 'error' && s.retry === 'check'))) {
			version.classList.remove('rail-version--update')
			version.title = '应用版本'
			version.removeAttribute('role')
			version.removeAttribute('tabindex')
		}
		if (!manualChecking && (s.state === 'checking' || s.state === 'current' || (s.state === 'error' && s.retry === 'check'))) return
		const messages = {
			checking: '正在检查更新…', current: '已是最新版本',
			available: '有新版本 v' + (s.update ? s.update.version : ''),
			downloading: '正在下载更新…', preparing: '正在保存会话…', installing: '正在安装更新…',
			blocked: '暂不能安装，请先结束：' + (s.reasons || []).join('、'),
			error: '更新未完成，请重试；当前版本可继续使用',
		}
		status.textContent = messages[s.state] || '正在更新…'
		if (s.state === 'downloading' && s.total > 0) status.textContent += ' ' + Math.min(100, Math.floor(s.downloaded / s.total * 100)) + '%'
		status.parentNode.hidden = false
		action.hidden = !['available', 'error', 'blocked'].includes(s.state)
		retry = s.retry || (s.state === 'available' || s.state === 'blocked' ? 'install' : retry)
		action.textContent = s.state === 'available' ? '查看更新' : '重试'
		if (version && s.state === 'available') {
			version.classList.add('rail-version--update')
			version.title = '有新版本，点击查看更新'
			version.setAttribute('role', 'button')
			version.tabIndex = 0
		}
	})
	async function offerInstall() {
		const update = controller.pending
		if (!update || controller.busy || controller.frozen) return
		const text = '当前版本 v' + (update.currentVersion || root.APP_VERSION) + '\n新版本 v' + update.version + '\n\n' + String(update.body || '此版本未提供更新说明。').slice(0, 16000) + '\n\n安装完成后应用将重启。'
		if (await root.AppDialog.confirm(text, { title: '应用更新', okText: '下载并安装', cancelText: '稍后' })) {
			try { await controller.install() } catch (e) { /* 状态条提供重试，原生错误不暴露路径或配置 */ }
		}
	}
	async function check(manual) {
		if (controller.busy || controller.frozen) return
		manualChecking = !!manual
		lastCheck = Date.now()
		try {
			const update = await controller.check()
			if (manual && update) await offerInstall()
			else if (manual && update === null) await root.AppDialog.alert('当前已是最新版本。', { title: '应用更新' })
		} catch (e) {
			if (manual && root.APP_UPDATER_CONFIGURED === false) await root.AppDialog.alert('此版本暂不支持在线更新，请安装发布版客户端。', { title: '应用更新' })
		} finally { manualChecking = false }
	}
	root.AppUpdate = { check: check }
	// 注册完成前不自动检查；无响应的窗口由后端超时保护拒绝安装。
	const listeners = Promise.all([
		service.listen('app-update-prepare', function (data) { controller.prepare(data) }),
		service.listen('app-update-progress', function (data) { controller.progress(data) }),
		service.listen('app-update-finished', function (data) { controller.finished(data) }),
	])
	function init() {
		const menu = doc.querySelector('.rail-config-menu')
		if (menu) {
			const li = doc.createElement('li')
			const button = doc.createElement('button')
			button.id = 'serial-check-update'
			button.type = 'button'
			button.className = 'dropdown-item'
			button.textContent = '检查应用更新…'
			button.addEventListener('click', function () { check(true) })
			li.appendChild(button)
			menu.appendChild(li)
		}
		const bar = doc.createElement('div')
		bar.id = 'serial-app-update'
		bar.hidden = true
		bar.setAttribute('role', 'status')
		bar.setAttribute('aria-live', 'polite')
		status = doc.createElement('span')
		action = doc.createElement('button')
		action.type = 'button'
		action.className = 'btn btn-sm btn-outline-primary'
		action.addEventListener('click', function () { if (retry === 'install') offerInstall(); else check(true) })
		const dismiss = doc.createElement('button')
		dismiss.type = 'button'
		dismiss.className = 'btn btn-sm'
		dismiss.setAttribute('aria-label', '关闭更新提示')
		dismiss.textContent = '×'
		dismiss.addEventListener('click', function () { bar.hidden = true })
		bar.append(status, action, dismiss)
		doc.body.appendChild(bar)
		const version = doc.getElementById('app-version')
		if (version) {
			version.addEventListener('click', function () { if (controller.pending) offerInstall() })
			version.addEventListener('keydown', function (e) { if (controller.pending && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); offerInstall() } })
		}
		root.addEventListener('keydown', function (e) { if (controller.frozen) { e.preventDefault(); e.stopImmediatePropagation() } }, true)
		listeners.then(function () {
			if (!root.APP_UPDATER_CONFIGURED) return
			setTimeout(function () { check(false) }, 60000)
			setInterval(function () { check(false) }, CHECK_INTERVAL_MS)
			doc.addEventListener('visibilitychange', function () { if (!doc.hidden && Date.now() - lastCheck > CHECK_INTERVAL_MS) check(false) })
		}).catch(function () { /* 监听未就绪不启动后台更新检测 */ })
	}
	if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init)
	else init()
})(typeof window !== 'undefined' ? window : globalThis)
