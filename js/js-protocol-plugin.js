// 外部 JS 协议插件沙盒加载器：
// 提供同步确定性 SHA-256 哈希指纹信任门控、内置协议 ID 保护、安全执行与卸载，以及桌面端本地插件目录联动。
;(function (root) {
	'use strict'

	const STORAGE_KEY = 'customJsProtocols'
	const TRUST_KEY = 'trustedJsPluginHashes'
	const DIR_DISABLED_KEY = 'disabledDirJsPlugins'
	const MAX_CODE_BYTES = 1024 * 1024
	const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
	const DEFAULT_RESERVED_IDS = ['sek', 'wmbus', 'gz', 'cjt188', 'sk-ultrasonic', 'hostproto', 'cellular-at']

	function getReservedIds() {
		const reg = root.ProtocolRegistry
		if (reg && Array.isArray(reg.RESERVED_IDS)) {
			const set = new Set(DEFAULT_RESERVED_IDS)
			reg.RESERVED_IDS.forEach(id => set.add(id))
			return set
		}
		return new Set(DEFAULT_RESERVED_IDS)
	}

	// ===== 字节与 HEX 工具 =====
	function hexToBytes(str) {
		if (str == null || str === '') return new Uint8Array(0)
		if (str instanceof Uint8Array) return str.slice()
		if (Array.isArray(str)) return Uint8Array.from(str)
		const clean = String(str).replace(/0x/gi, '').replace(/[\s:,_-]/g, '')
		if (clean.length === 0) return new Uint8Array(0)
		if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null
		const out = new Uint8Array(clean.length / 2)
		for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
		return out
	}

	function bytesToHex(bytes) {
		const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])
		const out = new Array(b.length)
		for (let i = 0; i < b.length; i++) out[i] = (b[i] & 0xff).toString(16).toUpperCase().padStart(2, '0')
		return out.join(' ')
	}

	function escHtml(s) {
		if (root.ParseView && typeof root.ParseView.esc === 'function') return root.ParseView.esc(s)
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
	}

	// ===== 同步确定性 SHA-256 哈希（无异步 WebCrypto 依赖） =====
	const SHA256_K = new Uint32Array([
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	])

	function utf8Bytes(str) {
		if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str)
		const out = []
		for (let i = 0; i < str.length; i++) {
			let c = str.charCodeAt(i)
			if (c < 0x80) {
				out.push(c)
			} else if (c < 0x800) {
				out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
			} else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
				const c2 = str.charCodeAt(++i)
				const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff))
				out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
			} else {
				out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
			}
		}
		return Uint8Array.from(out)
	}

	function hashCode(source) {
		const msg = utf8Bytes(String(source == null ? '' : source))
		const bitLenHi = Math.floor((msg.length * 8) / 0x100000000) >>> 0
		const bitLenLo = (msg.length * 8) >>> 0
		const padLen = ((msg.length + 9 + 63) & ~63)
		const buf = new Uint8Array(padLen)
		buf.set(msg, 0)
		buf[msg.length] = 0x80
		const view = new DataView(buf.buffer)
		view.setUint32(padLen - 8, bitLenHi, false)
		view.setUint32(padLen - 4, bitLenLo, false)

		let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
		let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
		const w = new Uint32Array(64)

		for (let off = 0; off < padLen; off += 64) {
			for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
			for (let i = 16; i < 64; i++) {
				const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3)
				const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10)
				w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
			}
			let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
			for (let i = 0; i < 64; i++) {
				const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
				const ch = (e & f) ^ (~e & g)
				const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0
				const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
				const maj = (a & b) ^ (a & c) ^ (b & c)
				const temp2 = (S0 + maj) >>> 0
				h = g; g = f; f = e; e = (d + temp1) >>> 0
				d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
			}
			h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
			h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
		}
		return [h0, h1, h2, h3, h4, h5, h6, h7].map(x => x.toString(16).padStart(8, '0')).join('')
	}

	// ===== 示例插件源码 =====
	const EXAMPLE_CODE = [
		'// 自定义 JS 协议插件示例（心跳与回声协议）',
		'// 帧格式：5A A5 + Cmd(1B) + Len(1B) + Payload(Len B) + XOR8(1B)',
		'const HEAD0 = 0x5A',
		'const HEAD1 = 0xA5',
		'',
		'function calcXor(bytes, end) {',
		'\tlet x = 0',
		'\tfor (let i = 0; i < end; i++) x ^= bytes[i]',
		'\treturn x & 0xff',
		'}',
		'',
		'registerProtocol(\'demo-js-echo\', {',
		'\tname: \'JS 回声协议示例\',',
		'\tversion: \'1.0.0\',',
		'\tdescription: \'5A A5 + Cmd(1B) + Len(1B) + Payload + XOR8(1B)\',',
		'\tfindFrame(bytes) {',
		'\t\tconst b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])',
		'\t\tfor (let i = 0; i <= b.length - 5; i++) {',
		'\t\t\tif (b[i] !== HEAD0 || b[i + 1] !== HEAD1) continue',
		'\t\t\tconst len = b[i + 3]',
		'\t\t\tconst total = 5 + len',
		'\t\t\tif (i + total > b.length) continue',
		'\t\t\tconst slice = b.subarray(i, i + total)',
		'\t\t\tif (calcXor(slice, total - 1) !== slice[total - 1]) continue',
		'\t\t\treturn { found: true, frame: slice.slice(), offset: i, length: total, prefix: i, suffix: b.length - i - total }',
		'\t\t}',
		'\t\treturn { found: false }',
		'\t},',
		'\tparseFrame(bytes) {',
		'\t\tconst b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])',
		'\t\tif (b.length < 5 || b[0] !== HEAD0 || b[1] !== HEAD1) return { ok: false, raw: b, errors: [\'非本协议帧\'] }',
		'\t\tconst cmd = b[2]',
		'\t\tconst len = b[3]',
		'\t\tconst total = 5 + len',
		'\t\tif (b.length !== total) return { ok: false, matchedHead: true, raw: b, errors: [\'帧长与长度字段不符\'] }',
		'\t\tconst xorOk = calcXor(b, total - 1) === b[total - 1]',
		'\t\tconst payload = b.subarray(4, 4 + len)',
		'\t\treturn { ok: xorOk, matchedHead: true, crcOk: xorOk, cmd: cmd, payload: payload, raw: b, errors: xorOk ? [] : [\'XOR 校验失败\'] }',
		'\t},',
		'\tlogView(r) {',
		'\t\tif (!r || !r.matchedHead) return null',
		'\t\treturn {',
		'\t\t\ttitle: r.cmd === 0x01 ? \'心跳请求\' : r.cmd === 0x81 ? \'心跳应答\' : \'自定义指令\',',
		'\t\t\tcode: \'0x\' + r.cmd.toString(16).toUpperCase().padStart(2, \'0\'),',
		'\t\t\tdir: (r.cmd & 0x80) ? \'up\' : \'down\',',
		'\t\t\tbadges: [{ text: r.crcOk ? \'XOR ✓\' : \'XOR ✗\', kind: r.crcOk ? \'ok\' : \'bad\' }],',
		'\t\t\tsections: [{ pairs: [[\'载荷长度\', r.payload.length + \' B\'], [\'载荷 HEX\', api.bytesToHex(r.payload) || \'(空)\']] }],',
		'\t\t\terrors: r.errors || [],',
		'\t\t}',
		'\t},',
		'\tbuildDownFrame(opts) {',
		'\t\tconst o = opts || {}',
		'\t\tconst cmd = o.cmd != null ? Number(o.cmd) : 0x01',
		'\t\tconst payload = o.payloadHex != null ? (api.hexToBytes(o.payloadHex) || new Uint8Array(0)) : (o.payload instanceof Uint8Array ? o.payload : new Uint8Array(0))',
		'\t\tconst out = new Uint8Array(5 + payload.length)',
		'\t\tout[0] = HEAD0; out[1] = HEAD1; out[2] = cmd & 0xff; out[3] = payload.length & 0xff',
		'\t\tout.set(payload, 4)',
		'\t\tout[out.length - 1] = calcXor(out, out.length - 1)',
		'\t\treturn out',
		'\t},',
		'\tpresets: [{',
		'\t\tgroup: \'常用测试\',',
		'\t\titems: [',
		'\t\t\t{ name: \'发送心跳\', func: \'basic\', desc: \'Cmd=0x01 载荷 PING\', cmd: 0x01, payloadHex: \'50 49 4E 47\' },',
		'\t\t],',
		'\t}],',
		'})',
	].join('\n')

	// ===== 内存与持久化状态 =====
	const runtimeState = new Map() // pluginKey -> { registeredIds: string[], error: string }
	let dirJsPlugins = [] // Array<{ pluginId, pluginKey, name, fileName, source: 'js-dir', code, hash, updatedAt }>
	let lastScanPromise = null

	function canRunPlugins() {
		const P = root.AppPlatform
		if (P && typeof P.has === 'function' && !P.has('protocol.manage')) return false
		return true
	}

	function getStorage() {
		try {
			return root.localStorage || null
		} catch (e) {
			return null
		}
	}

	function readLocalPlugins() {
		const st = getStorage()
		if (!st) return []
		try {
			const raw = st.getItem(STORAGE_KEY)
			if (!raw) return []
			const parsed = JSON.parse(raw)
			if (!Array.isArray(parsed)) return []
			return parsed
				.filter(x => x && typeof x === 'object')
				.map(x => {
					const pluginId = String(x.pluginId || x.id || '').trim()
					return {
						pluginId: pluginId,
						name: String(x.name || pluginId || '未命名插件'),
						fileName: String(x.fileName || (pluginId ? pluginId + '.js' : 'plugin.js')),
						code: String(x.code || ''),
						enabled: !!x.enabled,
						updatedAt: Number(x.updatedAt) || 0,
					}
				})
				.filter(x => x.pluginId)
		} catch (e) {
			return []
		}
	}

	function writeLocalPlugins(list) {
		const st = getStorage()
		if (!st) return
		st.setItem(STORAGE_KEY, JSON.stringify(list))
	}

	function readTrustedHashes() {
		const st = getStorage()
		if (!st) return {}
		try {
			const raw = st.getItem(TRUST_KEY)
			if (!raw) return {}
			const parsed = JSON.parse(raw)
			return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
		} catch (e) {
			return {}
		}
	}

	function writeTrustedHashes(map) {
		const st = getStorage()
		if (!st) return
		st.setItem(TRUST_KEY, JSON.stringify(map))
	}

	function readDisabledDirSet() {
		const st = getStorage()
		if (!st) return new Set()
		try {
			const raw = st.getItem(DIR_DISABLED_KEY)
			if (!raw) return new Set()
			const parsed = JSON.parse(raw)
			return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set()
		} catch (e) {
			return new Set()
		}
	}

	function writeDisabledDirSet(set) {
		const st = getStorage()
		if (!st) return
		st.setItem(DIR_DISABLED_KEY, JSON.stringify(Array.from(set)))
	}

	function dispatchChange() {
		if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
			document.dispatchEvent(new CustomEvent('serial-protocol-plugins-change'))
		}
	}

	// ===== 安全隔离与注册桥 =====
	function sanitizeViewModel(model) {
		if (!model) return model
		if (Array.isArray(model)) return model.map(sanitizeViewModel)
		if (typeof model !== 'object') return model
		const out = Object.assign({}, model)
		if (Array.isArray(out.sections)) {
			out.sections = out.sections.map(sec => {
				if (!sec || typeof sec !== 'object') return sec
				const copy = Object.assign({}, sec)
				if (copy.html != null && copy.html !== '') {
					copy.pre = copy.pre ? (String(copy.pre) + '\n' + String(copy.html)) : String(copy.html)
					delete copy.html
				}
				return copy
			})
		}
		return out
	}

	function wrapPluginProtocol(id, impl, source, pluginKey) {
		const hasRegistry = !!(root.ProtocolRegistry && typeof root.ProtocolRegistry.register === 'function')
		const wrapped = Object.assign({}, impl, {
			id: id,
			name: String(impl.name || id),
			builtin: false,
			source: source,
			ownerPluginId: pluginKey,
		})
		if (typeof impl.logView === 'function') {
			const origLogView = impl.logView
			wrapped.logView = function () {
				return sanitizeViewModel(origLogView.apply(impl, arguments))
			}
		}
		// 若存在 ProtocolRegistry，则由其统一包裹 formatFrame 避免双重转义；独立运行/测试时在此直接隔离
		if (!hasRegistry) {
			if (typeof impl.formatFrame === 'function') {
				const origFmt = impl.formatFrame
				wrapped.formatFrame = function () {
					const raw = origFmt.apply(impl, arguments)
					return '<pre class="pv-pre">' + escHtml(raw == null ? '' : String(raw)) + '</pre>'
				}
			} else if (typeof wrapped.logView === 'function') {
				wrapped.formatFrame = function (parsed) {
					const m = wrapped.logView(parsed)
					if (!m) return '<div class="pv-err">无法解析该帧</div>'
					if (root.ParseView && typeof root.ParseView.render === 'function') {
						return root.ParseView.render(m)
					}
					return '<pre class="pv-pre">' + escHtml(JSON.stringify(m)) + '</pre>'
				}
			}
		}
		return wrapped
	}

	function registerInRegistry(id, impl) {
		if (root.ProtocolRegistry && typeof root.ProtocolRegistry.register === 'function') {
			return root.ProtocolRegistry.register(id, impl)
		}
		if (typeof root.registerProtocol === 'function') {
			return root.registerProtocol(id, impl)
		}
		return true
	}

	function unregisterFromRegistry(id) {
		if (root.ProtocolRegistry && typeof root.ProtocolRegistry.unregister === 'function') {
			return root.ProtocolRegistry.unregister(id)
		}
		if (typeof root.unregisterProtocol === 'function') {
			return root.unregisterProtocol(id)
		}
		return { ok: true }
	}

	function unloadPlugin(pluginKey) {
		const st = runtimeState.get(pluginKey)
		if (st && st.registeredIds && st.registeredIds.length) {
			st.registeredIds.forEach(id => {
				try { unregisterFromRegistry(id) } catch (e) { /* ignore */ }
			})
		}
		runtimeState.set(pluginKey, { registeredIds: [], error: '' })
	}

	function executePlugin(plugin) {
		const pluginKey = plugin.pluginKey
		if (!canRunPlugins()) {
			unloadPlugin(pluginKey)
			return { ok: false, error: '当前平台画像不支持外部 JS 插件' }
		}
		const trustedHashes = readTrustedHashes()
		const currentHash = hashCode(plugin.code)
		// 安全门控铁律：未启用或哈希不匹配绝不执行
		if (!plugin.enabled || trustedHashes[pluginKey] !== currentHash) {
			unloadPlugin(pluginKey)
			return { ok: false, needsTrust: true, error: '插件未信任或未启用，已拒绝执行' }
		}

		unloadPlugin(pluginKey)

		const reserved = getReservedIds()
		const collected = []
		const seenIds = new Set()

		function collectRegister(idOrImpl, maybeImpl) {
			let id = idOrImpl
			let impl = maybeImpl
			if (idOrImpl && typeof idOrImpl === 'object' && maybeImpl === undefined) {
				impl = idOrImpl
				id = impl.id
			}
			const cleanId = typeof id === 'string' ? id.trim() : ''
			if (!cleanId || !ID_RE.test(cleanId)) {
				throw new Error('插件注册的协议 ID 格式非法：' + String(id))
			}
			if (reserved.has(cleanId)) {
				throw new Error('插件不可覆盖保留的内置协议 ID：' + cleanId)
			}
			if (!impl || typeof impl !== 'object') {
				throw new Error('协议实现必须为对象：' + cleanId)
			}
			if (seenIds.has(cleanId)) {
				throw new Error('同一插件重复注册协议 ID：' + cleanId)
			}
			seenIds.add(cleanId)
			collected.push({
				id: cleanId,
				impl: wrapPluginProtocol(cleanId, impl, plugin.source, pluginKey),
			})
		}

		const api = {
			registerProtocol: collectRegister,
			ParseView: root.ParseView || null,
			Checksum: (root.JsonProtocol && root.JsonProtocol.Checksum) || null,
			hexToBytes: hexToBytes,
			bytesToHex: bytesToHex,
		}
		const mod = { exports: {} }

		try {
			const runner = new Function('api', 'module', 'exports', 'registerProtocol', '"use strict";\n' + plugin.code)
			runner(api, mod, mod.exports, collectRegister)
			// 兼容 module.exports = { id, name, ... } 或数组导出
			if (mod.exports && typeof mod.exports === 'object') {
				if (Array.isArray(mod.exports)) {
					mod.exports.forEach(item => {
						if (item && typeof item === 'object' && item.id && !seenIds.has(String(item.id).trim())) {
							collectRegister(item.id, item)
						}
					})
				} else if (mod.exports.id && !seenIds.has(String(mod.exports.id).trim())) {
					collectRegister(mod.exports.id, mod.exports)
				}
			}
		} catch (err) {
			const msg = err && err.message ? err.message : String(err)
			runtimeState.set(pluginKey, { registeredIds: [], error: msg })
			return { ok: false, error: msg }
		}

		if (!collected.length) {
			const msg = '插件未注册任何协议（请调用 registerProtocol(id, impl) 或导出 module.exports = { id, name, ... }）'
			runtimeState.set(pluginKey, { registeredIds: [], error: msg })
			return { ok: false, error: msg }
		}

		const registeredIds = []
		try {
			for (let i = 0; i < collected.length; i++) {
				const item = collected[i]
				const regOk = registerInRegistry(item.id, item.impl)
				if (regOk !== false) registeredIds.push(item.id)
			}
		} catch (err) {
			// 回滚本批已注册项
			registeredIds.forEach(id => {
				try { unregisterFromRegistry(id) } catch (e) { /* ignore */ }
			})
			const msg = err && err.message ? err.message : String(err)
			runtimeState.set(pluginKey, { registeredIds: [], error: msg })
			return { ok: false, error: msg }
		}

		runtimeState.set(pluginKey, { registeredIds: registeredIds, error: '' })
		return { ok: true, registeredIds: registeredIds }
	}

	// ===== 公开 API =====
	function findPlugin(pluginKeyOrId) {
		const raw = String(pluginKeyOrId || '').trim()
		if (!raw) return null
		const locals = readLocalPlugins()
		if (raw.startsWith('local:')) {
			const pid = raw.slice(6)
			const item = locals.find(x => x.pluginId === pid)
			return item ? { kind: 'local', item: item, locals: locals, pluginKey: raw } : null
		}
		if (raw.startsWith('dir:')) {
			const fName = raw.slice(4)
			const item = dirJsPlugins.find(x => x.fileName === fName)
			return item ? { kind: 'dir', item: item, pluginKey: raw } : null
		}
		const localHit = locals.find(x => x.pluginId === raw)
		if (localHit) return { kind: 'local', item: localHit, locals: locals, pluginKey: 'local:' + localHit.pluginId }
		const dirHit = dirJsPlugins.find(x => x.fileName === raw || x.pluginId === raw)
		if (dirHit) return { kind: 'dir', item: dirHit, pluginKey: dirHit.pluginKey }
		return null
	}

	function listPlugins() {
		const trustedHashes = readTrustedHashes()
		const disabledDirs = readDisabledDirSet()
		const out = []

		readLocalPlugins().forEach(item => {
			const pluginKey = 'local:' + item.pluginId
			const hash = hashCode(item.code)
			const trusted = trustedHashes[pluginKey] === hash
			const st = runtimeState.get(pluginKey) || { registeredIds: [], error: '' }
			out.push({
				pluginId: item.pluginId,
				pluginKey: pluginKey,
				name: item.name,
				fileName: item.fileName,
				source: 'js-local',
				enabled: !!(item.enabled && trusted),
				trusted: trusted,
				hash: hash,
				registeredIds: st.registeredIds.slice(),
				error: st.error || '',
				code: item.code,
				updatedAt: item.updatedAt,
			})
		})

		dirJsPlugins.forEach(item => {
			const pluginKey = item.pluginKey
			const trusted = trustedHashes[pluginKey] === item.hash
			const enabled = trusted && !disabledDirs.has(pluginKey)
			const st = runtimeState.get(pluginKey) || { registeredIds: [], error: '' }
			out.push({
				pluginId: item.pluginId,
				pluginKey: pluginKey,
				name: item.name,
				fileName: item.fileName,
				source: 'js-dir',
				enabled: enabled,
				trusted: trusted,
				hash: item.hash,
				registeredIds: st.registeredIds.slice(),
				error: st.error || '',
				code: item.code,
				updatedAt: item.updatedAt,
			})
		})

		return out
	}

	function generatePluginId(name, fileName) {
		const base = String(fileName || name || 'plugin')
			.replace(/\.js$/i, '')
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 28) || 'plugin'
		return base + '-' + Date.now().toString(36)
	}

	function saveLocalPlugin(input) {
		if (!input || typeof input !== 'object') {
			return { ok: false, error: '插件参数无效' }
		}
		const code = typeof input.code === 'string' ? input.code : ''
		if (!code.trim()) {
			return { ok: false, error: '插件源码不能为空' }
		}
		if (utf8Bytes(code).length > MAX_CODE_BYTES) {
			return { ok: false, error: '插件源码不能超过 1 MiB' }
		}

		const locals = readLocalPlugins()
		let pluginId = typeof input.pluginId === 'string' ? input.pluginId.trim() : ''
		if (pluginId.startsWith('local:')) pluginId = pluginId.slice(6)
		if (!pluginId) {
			pluginId = generatePluginId(input.name, input.fileName)
		} else if (!ID_RE.test(pluginId)) {
			return { ok: false, error: 'pluginId 格式非法（需为小写字母或数字开头，仅含小写字母、数字、下划线或连字符）' }
		}

		const name = typeof input.name === 'string' && input.name.trim()
			? input.name.trim().slice(0, 64)
			: (typeof input.fileName === 'string' && input.fileName.trim() ? input.fileName.replace(/\.js$/i, '').trim() : pluginId)
		const fileName = typeof input.fileName === 'string' && input.fileName.trim()
			? input.fileName.trim()
			: (pluginId + '.js')

		const pluginKey = 'local:' + pluginId
		const hash = hashCode(code)
		const trustedHashes = readTrustedHashes()
		const trusted = trustedHashes[pluginKey] === hash

		const idx = locals.findIndex(x => x.pluginId === pluginId)
		const prevEnabled = idx >= 0 ? !!locals[idx].enabled : false
		const nextEnabled = trusted ? prevEnabled : false

		const entry = {
			pluginId: pluginId,
			name: name,
			fileName: fileName,
			code: code,
			enabled: nextEnabled,
			updatedAt: Date.now(),
		}
		if (idx >= 0) locals[idx] = entry
		else locals.push(entry)
		writeLocalPlugins(locals)

		if (!trusted) {
			// 新建或修改代码后未信任：立即卸载旧协议，保持未执行态
			unloadPlugin(pluginKey)
		}
		dispatchChange()
		return { ok: true, pluginId: pluginId, pluginKey: pluginKey, needsTrust: !trusted }
	}

	function trustAndEnable(pluginKeyOrId, expectedHash) {
		const found = findPlugin(pluginKeyOrId)
		if (!found) return { ok: false, error: '未找到指定 JS 插件' }

		const pluginKey = found.pluginKey
		const code = found.item.code
		const hash = hashCode(code)
		if (expectedHash !== undefined && expectedHash !== null && String(expectedHash) !== hash) {
			return { ok: false, error: '插件内容已变更，请重新核对代码后再确认信任' }
		}
		const trustedHashes = readTrustedHashes()
		trustedHashes[pluginKey] = hash
		writeTrustedHashes(trustedHashes)

		if (found.kind === 'local') {
			found.item.enabled = true
			writeLocalPlugins(found.locals)
		} else {
			const disabled = readDisabledDirSet()
			disabled.delete(pluginKey)
			writeDisabledDirSet(disabled)
		}

		const execRes = executePlugin({
			pluginKey: pluginKey,
			source: found.kind === 'local' ? 'js-local' : 'js-dir',
			code: code,
			enabled: true,
		})
		if (!execRes.ok) {
			// 执行失败时回退启用标志，避免后续启动反复报错
			if (found.kind === 'local') {
				found.item.enabled = false
				writeLocalPlugins(found.locals)
			} else {
				const disabled = readDisabledDirSet()
				disabled.add(pluginKey)
				writeDisabledDirSet(disabled)
			}
			dispatchChange()
			return { ok: false, error: execRes.error }
		}

		dispatchChange()
		return { ok: true, registeredIds: execRes.registeredIds }
	}

	function setEnabled(pluginKeyOrId, enabled) {
		const found = findPlugin(pluginKeyOrId)
		if (!found) return { ok: false, error: '未找到指定 JS 插件' }
		const pluginKey = found.pluginKey
		const want = !!enabled

		if (!want) {
			unloadPlugin(pluginKey)
			if (found.kind === 'local') {
				found.item.enabled = false
				writeLocalPlugins(found.locals)
			} else {
				const disabled = readDisabledDirSet()
				disabled.add(pluginKey)
				writeDisabledDirSet(disabled)
			}
			dispatchChange()
			return { ok: true }
		}

		const hash = hashCode(found.item.code)
		const trustedHashes = readTrustedHashes()
		if (trustedHashes[pluginKey] !== hash) {
			return { ok: false, needsTrust: true, error: '该 JS 插件尚未信任或内容已变更，请先确认安全风险并信任后再启用' }
		}

		if (found.kind === 'local') {
			found.item.enabled = true
			writeLocalPlugins(found.locals)
		} else {
			const disabled = readDisabledDirSet()
			disabled.delete(pluginKey)
			writeDisabledDirSet(disabled)
		}

		const execRes = executePlugin({
			pluginKey: pluginKey,
			source: found.kind === 'local' ? 'js-local' : 'js-dir',
			code: found.item.code,
			enabled: true,
		})
		if (!execRes.ok) {
			if (found.kind === 'local') {
				found.item.enabled = false
				writeLocalPlugins(found.locals)
			} else {
				const disabled = readDisabledDirSet()
				disabled.add(pluginKey)
				writeDisabledDirSet(disabled)
			}
			dispatchChange()
			return { ok: false, error: execRes.error }
		}
		dispatchChange()
		return { ok: true }
	}

	function removeLocalPlugin(pluginIdOrKey) {
		const raw = String(pluginIdOrKey || '').trim()
		if (!raw) return { ok: false, error: '插件 ID 不能为空' }
		if (raw.startsWith('dir:')) {
			return { ok: false, error: '桌面插件目录中的 .js 文件请在本地目录删除后重新扫描' }
		}
		const pid = raw.startsWith('local:') ? raw.slice(6) : raw
		const locals = readLocalPlugins()
		const idx = locals.findIndex(x => x.pluginId === pid)
		if (idx < 0) return { ok: false, error: '未找到本地 JS 插件：' + pid }

		const pluginKey = 'local:' + pid
		unloadPlugin(pluginKey)
		runtimeState.delete(pluginKey)
		locals.splice(idx, 1)
		writeLocalPlugins(locals)

		const trustedHashes = readTrustedHashes()
		if (Object.prototype.hasOwnProperty.call(trustedHashes, pluginKey)) {
			delete trustedHashes[pluginKey]
			writeTrustedHashes(trustedHashes)
		}
		dispatchChange()
		return { ok: true }
	}

	function getDesktopService() {
		return (root.AppPlatform && typeof root.AppPlatform.service === 'function')
			? root.AppPlatform.service('protocol-plugins')
			: null
	}

	function hasDesktopDir() {
		return !!getDesktopService()
	}

	function scanDesktopDir() {
		const run = (async function () {
			if (!canRunPlugins()) {
				return { supported: false, dir: '', jsonCount: 0, jsCount: 0, untrustedCount: 0, truncated: false, errors: [] }
			}
			const svc = getDesktopService()
			if (!svc || typeof svc.list !== 'function') {
				return { supported: false, dir: '', jsonCount: 0, jsCount: 0, untrustedCount: 0, truncated: false, errors: [] }
			}

			let scan
			try {
				scan = await svc.list()
			} catch (err) {
				dispatchChange()
				return {
					supported: true,
					dir: '',
					jsonCount: 0,
					jsCount: 0,
					untrustedCount: 0,
					truncated: false,
					errors: ['扫描插件目录失败：' + (err && err.message ? err.message : String(err))],
				}
			}

			const dir = String((scan && scan.dir) || '')
			const files = Array.isArray(scan && scan.files) ? scan.files : []
			const truncated = !!(scan && scan.truncated)

			const trustedHashes = readTrustedHashes()
			const disabledDirs = readDisabledDirSet()
			let jsonCount = 0
			let jsCount = 0
			let untrustedCount = 0
			const errors = []

			// 批量事务包裹旧项清理与新项重注册：仍在目录中的协议不会在重扫期间误触发路回退与重复重渲
			const applyScan = function () {
				if (root.JsonProtocol && typeof root.JsonProtocol.clearDirSpecs === 'function') {
					root.JsonProtocol.clearDirSpecs()
				}
				dirJsPlugins.forEach(item => {
					unloadPlugin(item.pluginKey)
					runtimeState.delete(item.pluginKey)
				})
				dirJsPlugins = []

				for (let i = 0; i < files.length; i++) {
					const f = files[i]
					if (!f || !f.fileName) continue
					const fName = String(f.fileName)
					const kind = String(f.kind || '').toLowerCase()
					const content = String(f.content == null ? '' : f.content)

					if (kind === 'json') {
						if (root.JsonProtocol && typeof root.JsonProtocol.registerDirSpec === 'function') {
							const r = root.JsonProtocol.registerDirSpec(fName, content)
							if (r && r.ok) jsonCount++
							else errors.push(fName + '：' + ((r && r.errors) || ['加载失败']).join('；'))
						}
					} else if (kind === 'js') {
						jsCount++
						const pluginKey = 'dir:' + fName
						const hash = hashCode(content)
						const entry = {
							pluginId: fName,
							pluginKey: pluginKey,
							name: fName.replace(/\.js$/i, ''),
							fileName: fName,
							source: 'js-dir',
							code: content,
							hash: hash,
							updatedAt: Date.now(),
						}
						dirJsPlugins.push(entry)
						const trusted = trustedHashes[pluginKey] === hash
						if (!trusted) {
							untrustedCount++
							runtimeState.set(pluginKey, { registeredIds: [], error: '' })
						} else if (!disabledDirs.has(pluginKey)) {
							const execRes = executePlugin({
								pluginKey: pluginKey,
								source: 'js-dir',
								code: content,
								enabled: true,
							})
							if (!execRes.ok) errors.push(fName + '：' + execRes.error)
						}
					}
				}
			}

			const reg = root.ProtocolRegistry
			if (reg && typeof reg.batch === 'function') reg.batch(applyScan)
			else applyScan()

			dispatchChange()
			return {
				supported: true,
				dir: dir,
				jsonCount: jsonCount,
				jsCount: jsCount,
				untrustedCount: untrustedCount,
				truncated: truncated,
				errors: errors,
			}
		})()
		lastScanPromise = run
		return run
	}

	function whenScanned() {
		if (!canRunPlugins() || !hasDesktopDir()) {
			return Promise.resolve({ supported: false })
		}
		return lastScanPromise || Promise.resolve({ supported: true })
	}

	async function openDesktopDir() {
		const svc = getDesktopService()
		if (!svc || typeof svc.openDir !== 'function') {
			return { ok: false, error: '当前环境不支持桌面端本地插件目录' }
		}
		try {
			const dir = await svc.openDir()
			return { ok: true, dir: String(dir || '') }
		} catch (err) {
			return { ok: false, error: err && err.message ? err.message : String(err) }
		}
	}

	function loadSavedIntoRegistry() {
		if (!canRunPlugins()) {
			return { loaded: [], errors: [] }
		}
		const locals = readLocalPlugins()
		const trustedHashes = readTrustedHashes()
		const loaded = []
		const errors = []
		locals.forEach(item => {
			const pluginKey = 'local:' + item.pluginId
			const hash = hashCode(item.code)
			if (!item.enabled || trustedHashes[pluginKey] !== hash) {
				unloadPlugin(pluginKey)
				return
			}
			const res = executePlugin({
				pluginKey: pluginKey,
				source: 'js-local',
				code: item.code,
				enabled: true,
			})
			if (res.ok) loaded.push.apply(loaded, res.registeredIds)
			else errors.push(item.pluginId + '：' + res.error)
		})
		if (hasDesktopDir()) {
			scanDesktopDir().catch(() => {})
		}
		return { loaded: loaded, errors: errors }
	}

	const api = {
		STORAGE_KEY: STORAGE_KEY,
		TRUST_KEY: TRUST_KEY,
		EXAMPLE_CODE: EXAMPLE_CODE,
		hashCode: hashCode,
		listPlugins: listPlugins,
		saveLocalPlugin: saveLocalPlugin,
		trustAndEnable: trustAndEnable,
		setEnabled: setEnabled,
		removeLocalPlugin: removeLocalPlugin,
		hasDesktopDir: hasDesktopDir,
		scanDesktopDir: scanDesktopDir,
		whenScanned: whenScanned,
		openDesktopDir: openDesktopDir,
		loadSavedIntoRegistry: loadSavedIntoRegistry,
	}

	root.JsProtocolPlugin = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api

	// 浏览器环境启动时自动加载已信任且启用的 JS 插件，并在桌面端异步扫描本地插件目录
	if (typeof window !== 'undefined' && (window.ProtocolRegistry || typeof window.registerProtocol === 'function') && getStorage()) {
		loadSavedIntoRegistry()
	}
})(typeof window !== 'undefined' ? window : globalThis)
