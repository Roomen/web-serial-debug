// 协议Tab内卡片可折叠: 下行下发 / 随机读写测试 / 批量配置写入
// 通过重新挂载已有 DOM 节点实现(不克隆), 不影响卡内控件的 id 与已绑定事件
;(function () {
	'use strict'

	const STATE_KEY = 'sk-card-collapse'
	// 首次默认状态: 下行下发展开, 其余折叠
	const DEFAULT_COLLAPSED = {
		'sk-down-card': false,
		'sk-rw-card': true,
		'sk-batch-card': true
	}

	function loadCollapseMap() {
		try {
			const raw = localStorage.getItem(STATE_KEY)
			if (raw) return JSON.parse(raw) || {}
		} catch (e) { /* 忽略 */ }
		return {}
	}

	function saveCollapseMap(map) {
		try { localStorage.setItem(STATE_KEY, JSON.stringify(map)) } catch (e) { /* 忽略 */ }
	}

	function setCollapsed(card, chevron, collapsed) {
		card.classList.toggle('is-collapsed', collapsed)
		chevron.classList.toggle('bi-chevron-down', !collapsed)
		chevron.classList.toggle('bi-chevron-right', collapsed)
	}

	function init() {
		const container = document.getElementById('nav-protocol')
		if (!container) return
		const cards = container.querySelectorAll(':scope > .protocol-down-card')
		if (!cards.length) return

		const saved = loadCollapseMap()

		cards.forEach(function (card) {
			const header = card.querySelector(':scope > h6.pane-section-title')
			if (!header || header.querySelector('.collapsible-chevron')) return

			const chevron = document.createElement('i')
			chevron.className = 'bi bi-chevron-down collapsible-chevron'
			header.insertBefore(chevron, header.firstChild)
			header.classList.add('collapsible-header')

			// 把标题之后的所有既有节点原样移入折叠容器(不新建/不克隆内容节点)
			const body = document.createElement('div')
			body.className = 'collapsible-body'
			const toMove = []
			let sib = header.nextSibling
			while (sib) {
				toMove.push(sib)
				sib = sib.nextSibling
			}
			toMove.forEach(function (n) { body.appendChild(n) })
			card.appendChild(body)

			const cardId = card.id
			const collapsed = saved.hasOwnProperty(cardId)
				? !!saved[cardId]
				: !!DEFAULT_COLLAPSED[cardId]
			setCollapsed(card, chevron, collapsed)

			header.addEventListener('click', function () {
				const next = !card.classList.contains('is-collapsed')
				setCollapsed(card, chevron, next)
				const map = loadCollapseMap()
				map[cardId] = next
				saveCollapseMap(map)
			})
		})
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init)
	} else {
		init()
	}
})()
