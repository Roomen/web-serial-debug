// 日志「解析」格式的共用渲染器：协议的 logView(r) 返回视图模型，这里统一转义并出 HTML。
// 模型（多帧返回数组；完全不是本协议的帧返回 null）：
// {
//   title: '终端数据上报', code: '0x02', dir: 'up' | 'down' | '',
//   subject: { label: '设备', value: '12907856341200' },
//   badges: [{ text: 'CRC ✓', kind: 'ok' | 'bad' | 'warn' | 'info' | '', title: '' }],
//   meta: [['帧序号', '5'], ...],
//   notes: [{ text: '…', kind: 'warn' | 'info' }],
//   sections: [{ title, groups: [{ title, pairs }], pairs: [[label, value, hint, kind]], pre, html, errors }],
//   errors: ['…']
// }
// 渲染器负责转义模型里的全部文本字段；只有 section.html 原样插入，调用方必须保证它是协议自己拼出且已转义的 HTML。
// 键值对单元与头部都用行内元素 + 显式空格拼接，复制日志（innerText）时每个单元是「标签 值」一行
;(function () {
	'use strict'
	const root = typeof window !== 'undefined' ? window : globalThis

	function esc(s) {
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
	}

	const KINDS = { ok: 1, bad: 1, warn: 1, info: 1 }
	function kindCls(kind) {
		return KINDS[kind] ? ' pv-' + kind : ''
	}

	function badgeHtml(b) {
		if (!b || b.text == null || b.text === '') return ''
		return '<span class="pv-badge' + kindCls(b.kind) + '"' + (b.title ? ' title="' + esc(b.title) + '"' : '') + '>' + esc(b.text) + '</span>'
	}

	function headHtml(m, opts) {
		const dir = m.dir === 'up' || m.dir === 'down' ? m.dir : (opts.dir === 'up' || opts.dir === 'down' ? opts.dir : '')
		let h = ''
		if (dir) h += '<span class="pv-dir">' + (dir === 'up' ? '↑' : '↓') + '</span> '
		h += '<span class="pv-title">' + esc(m.title || '帧') + '</span>'
		if (m.code) h += ' <span class="pv-code">' + esc(m.code) + '</span>'
		if (opts.tag) h += ' <span class="pv-tag" title="快捷发送名称">' + esc(opts.tag) + '</span>'
		const s = m.subject
		if (s && s.value != null && s.value !== '') {
			h += ' <span class="pv-subject">' + (s.label ? '<span class="pv-sl">' + esc(s.label) + '</span> ' : '') +
				'<span class="pv-sv">' + esc(s.value) + '</span></span>'
		}
		const badges = (m.badges || []).map(badgeHtml).filter(Boolean)
		if (badges.length) h += ' ' + badges.join(' ')
		return h
	}

	function pairHtml(p) {
		if (!p) return ''
		const label = p[0] == null ? '' : p[0]
		const value = p[1] == null ? '' : p[1]
		let h = '<div class="pv-kv"><span class="pv-k" title="' + esc(label) + '">' + esc(label) + '</span> ' +
			'<span class="pv-v' + kindCls(p[3]) + '">' + esc(value) + '</span>'
		if (p[2]) h += ' <span class="pv-h">' + esc(p[2]) + '</span>'
		return h + '</div>'
	}

	function gridHtml(pairs) {
		if (!pairs || !pairs.length) return ''
		return '<div class="pv-grid">' + pairs.map(pairHtml).join('') + '</div>'
	}

	function sectionHtml(sec) {
		if (!sec) return ''
		let h = '<div class="pv-sec">'
		if (sec.title) h += '<div class="pv-sec-title">' + esc(sec.title) + '</div>'
		;(sec.groups || []).forEach(function (g) {
			if (!g || !g.pairs || !g.pairs.length) return
			h += '<div class="pv-grp">'
			if (g.title) h += '<div class="pv-grp-title">' + esc(g.title) + '</div>'
			h += gridHtml(g.pairs) + '</div>'
		})
		h += gridHtml(sec.pairs)
		if (sec.pre) h += '<pre class="pv-pre">' + esc(sec.pre) + '</pre>'
		if (sec.html) h += sec.html
		;(sec.errors || []).forEach(function (e) { h += '<div class="pv-err">' + esc(e) + '</div>' })
		return h + '</div>'
	}

	function bodyHtml(m) {
		let h = ''
		const meta = (m.meta || []).filter(function (x) { return x && x[1] != null && x[1] !== '' })
		if (meta.length) {
			h += '<div class="pv-meta">' + meta.map(function (x) {
				return '<span class="pv-mk">' + esc(x[0]) + '</span> <span class="pv-mv">' + esc(x[1]) + '</span>'
			}).join('<span class="pv-sep"> · </span>') + '</div>'
		}
		;(m.notes || []).forEach(function (n) {
			if (n && n.text) h += '<div class="pv-note' + kindCls(n.kind) + '">' + esc(n.text) + '</div>'
		})
		;(m.sections || []).forEach(function (s) { h += sectionHtml(s) })
		;(m.errors || []).forEach(function (e) { h += '<div class="pv-err">' + esc(e) + '</div>' })
		return h
	}

	function oneHtml(m, opts) {
		if (!m || typeof m !== 'object') return ''
		const dir = m.dir === 'up' || m.dir === 'down' ? m.dir : (opts.dir === 'up' || opts.dir === 'down' ? opts.dir : '')
		const cls = 'pv' + (dir ? ' pv-' + dir : '')
		const head = headHtml(m, opts)
		const body = bodyHtml(m)
		if (opts.collapsed && body) {
			return '<details class="' + cls + ' pv-fold"><summary class="pv-head">' + head + '</summary>' + body + '</details>'
		}
		return '<div class="' + cls + '"><div class="pv-head">' + head + '</div>' + body + '</div>'
	}

	// opts.collapsed: 只留头部一行，其余放进 <details>；opts.tag: 头部附带的名称（如快捷发送名）；opts.dir: 模型没给方向时的兜底
	function render(models, opts) {
		opts = opts || {}
		const list = Array.isArray(models) ? models : [models]
		return list.map(function (m) { return oneHtml(m, opts) }).join('')
	}

	// 没有 logView 的协议：把 formatFrame 的老样式 HTML 包进 .pv（formatFrame 自己负责转义）
	function renderLegacy(html) {
		return '<div class="pv pv-legacy">' + html + '</div>'
	}

	const KV = /^(.+?)\s=\s(.*)$/
	const COMPACT = /^([^=\s]+)=(\S*)$/
	const COMPACT_LOOSE = /^([^=\s]+)=(.*)$/
	const TRAIL_NOTE = /^(.*?\S)\s*[（(]([^）)]+)[）)]\s*$/

	function toPair(k, v) {
		k = k.trim()
		v = v.trim()
		const m = TRAIL_NOTE.exec(v)
		if (m) return [k, m[1], m[2]]
		return [k, v]
	}

	// 把 `key = value` 的多行文本拆成键值对；一行里用两个以上空格隔开的多个 `k = v`（或紧凑的 `k=v`）各成一对；
	// 没有 `=` 的行进 notes。值末尾的「（说明）」拆成 hint（pair[2]）
	function linesToPairs(text) {
		const pairs = []
		const notes = []
		String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
			const t = line.trim()
			if (!t) return
			const segs = t.split(/ {2,}/)
			if (segs.length > 1 && segs.every(function (s) { return KV.test(s) })) {
				segs.forEach(function (s) { const m = KV.exec(s); pairs.push(toPair(m[1], m[2])) })
				return
			}
			if (segs.length > 1 && segs.every(function (s) { return COMPACT_LOOSE.test(s) })) {
				segs.forEach(function (s) { const m = COMPACT_LOOSE.exec(s); pairs.push([m[1], m[2].trim()]) })
				return
			}
			const tokens = t.split(/\s+/)
			if (tokens.length > 1 && tokens.every(function (s) { return COMPACT.test(s) })) {
				tokens.forEach(function (s) { const m = COMPACT.exec(s); pairs.push([m[1], m[2]]) })
				return
			}
			const m = KV.exec(t)
			if (m) pairs.push(toPair(m[1], m[2]))
			else notes.push(t)
		})
		return { pairs: pairs, notes: notes }
	}

	root.ParseView = { render: render, renderLegacy: renderLegacy, linesToPairs: linesToPairs, esc: esc }
})()
