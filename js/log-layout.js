// 日志区布局（window.LogLayout）：通信调试视图的右栏宽度钳制，与设备面板子视图里「通信记录」条的按协议布局存档。
// 只有纯函数与 localStorage 读写，不碰 DOM；js/common.js（右栏拖拽）与 js/device-panel.js（通信记录条）共用，node 测试直接加载。
;(function (root) {
	'use strict'

	// 日志区保底宽度：日志工具条按此宽度换行后每组都放得下（最宽的「显示格式」组约 200px + 两侧内边距）
	const LOG_MIN = 240
	// 右栏最窄：再窄检查器的键值表与停靠面板的表单就排不开
	const PANE_MIN = 280

	// 右栏宽度 px 钳进 [PANE_MIN, avail - LOG_MIN]；avail 是 #main 去掉停靠栏后的宽度。
	// 两个下限冲突（窗口窄到放不下两者）时日志区优先，右栏可以低于 PANE_MIN，但不小于 0。
	function clampRightPane(px, avail, o) {
		const logMin = o && o.logMin != null ? o.logMin : LOG_MIN
		const paneMin = o && o.paneMin != null ? o.paneMin : PANE_MIN
		let v = Math.round(Number(px))
		if (!isFinite(v)) v = paneMin
		v = Math.max(paneMin, v)
		if (isFinite(avail) && avail > 0) v = Math.min(v, Math.max(0, Math.floor(avail - logMin)))
		return v
	}

	// ---- 设备面板的通信记录条 ----
	// 状态 = { collapsed, h }：h 是展开时的高度（收起再展开回到原高度）
	const STRIP_KEY = 'deviceLogStripModern'
	const STRIP_MIN = 72
	const STRIP_DEFAULT = 120
	const STRIP_TALL = 360
	// 设备面板本身至少留这么高，条再拖高就不让了
	const PANEL_MIN = 160
	const STRIP_MAX_ENTRIES = 64
	// 协议在 device.log 里能给的初始偏好（只在用户从未调整过该协议时生效）
	const PREFS = ['collapsed', 'strip', 'tall']

	function normPref(v) {
		return typeof v === 'string' && PREFS.indexOf(v) >= 0 ? v : null
	}

	function prefState(pref) {
		if (pref === 'collapsed') return { collapsed: true, h: STRIP_DEFAULT }
		if (pref === 'tall') return { collapsed: false, h: STRIP_TALL }
		return { collapsed: false, h: STRIP_DEFAULT }
	}

	// avail：设备面板子视图的总高度（面板 + 条），按它算条的上限；不知道时只钳下限
	function clampStripH(h, avail) {
		let v = Math.round(Number(h))
		if (!isFinite(v)) v = STRIP_DEFAULT
		v = Math.max(STRIP_MIN, v)
		if (isFinite(avail) && avail > 0) v = Math.min(v, Math.max(STRIP_MIN, Math.floor(avail - PANEL_MIN)))
		return v
	}

	function validState(s) {
		if (!s || typeof s !== 'object' || Array.isArray(s)) return null
		const h = Number(s.h)
		if (!isFinite(h) || h <= 0) return null
		return { collapsed: s.collapsed === true, h: Math.max(STRIP_MIN, Math.round(h)) }
	}

	// 存档 = { v: 1, byPid, order }：order 显式记写入顺序（旧到新）。不能靠 Object.keys 的顺序淘汰——
	// 像整数的键（数字协议 id）总是排在最前且按数值升序，与写入顺序无关
	function readRaw(storage) {
		const map = Object.create(null)
		const order = []
		let raw = null
		try { raw = storage && storage.getItem(STRIP_KEY) } catch (e) { raw = null }
		if (!raw) return { map: map, order: order }
		let o = null
		try { o = JSON.parse(raw) } catch (e) { o = null }
		const by = o && o.v === 1 && o.byPid && typeof o.byPid === 'object' ? o.byPid : null
		if (!by) return { map: map, order: order }
		Object.keys(by).forEach(function (pid) {
			const st = validState(by[pid])
			if (st && pid) map[pid] = st
		})
		const seen = Object.create(null)
		;(Array.isArray(o.order) ? o.order : []).forEach(function (pid) {
			if (typeof pid === 'string' && pid in map && !seen[pid]) { seen[pid] = true; order.push(pid) }
		})
		// order 缺失或不全（手改、旧存档）时，剩下的按对象键顺序补在最前（视为更早）
		const rest = Object.keys(map).filter(function (pid) { return !seen[pid] })
		return { map: map, order: rest.concat(order) }
	}

	function readStore(storage) {
		return readRaw(storage).map
	}

	// 该协议这次要套用的状态：用户调整过 → 用户的；否则窄屏 / 移动画像 → 收起成一行；否则协议的 device.log 偏好；否则矮条
	function stripStateFor(saved, pid, pref, narrow) {
		const own = saved && pid && Object.prototype.hasOwnProperty.call(saved, pid) ? validState(saved[pid]) : null
		if (own) return { collapsed: own.collapsed, h: own.h, source: 'user' }
		if (narrow) return { collapsed: true, h: prefState(normPref(pref)).h, source: 'narrow' }
		const p = normPref(pref)
		const st = prefState(p)
		return { collapsed: st.collapsed, h: st.h, source: p ? 'protocol' : 'default' }
	}

	// 用户调整后写回这一协议的状态；条目超上限时按 order 丢掉最早写入的（重写的移到最后）
	function saveStripState(storage, pid, st) {
		if (!pid) return false
		const v = validState(st)
		if (!v) return false
		const cur = readRaw(storage)
		cur.map[pid] = v
		const order = cur.order.filter(function (k) { return k !== pid })
		order.push(pid)
		while (order.length > STRIP_MAX_ENTRIES) delete cur.map[order.shift()]
		const by = {}
		order.forEach(function (k) { by[k] = cur.map[k] })
		try { storage.setItem(STRIP_KEY, JSON.stringify({ v: 1, byPid: by, order: order })) } catch (e) { return false }
		return true
	}

	const api = {
		LOG_MIN: LOG_MIN,
		PANE_MIN: PANE_MIN,
		STRIP_KEY: STRIP_KEY,
		STRIP_MIN: STRIP_MIN,
		STRIP_DEFAULT: STRIP_DEFAULT,
		STRIP_TALL: STRIP_TALL,
		PANEL_MIN: PANEL_MIN,
		PREFS: PREFS.slice(),
		clampRightPane: clampRightPane,
		clampStripH: clampStripH,
		normPref: normPref,
		readStore: readStore,
		stripStateFor: stripStateFor,
		saveStripState: saveStripState,
	}
	if (typeof module !== 'undefined' && module.exports) module.exports = api
	if (root) root.LogLayout = api
})(typeof window !== 'undefined' ? window : null)
