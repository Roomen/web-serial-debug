// 跨协议批量指令下发 + 应答/回读确认
// 支持所有协议（SEK、hostProto、CJ/T 188、W-MBUS、工装、蜂窝 AT 及自定义 JSON/JS 插件）：
// - 从当前协议的 presets 挑选指令（含参数与逐台步进）或添加自定义 HEX/文本步骤；
// - SEK 纯 0x01 写预设清单保留红外保活 + 按 Tag 整包回读逐项比对；
// - 其他协议与混合清单按当前协议 buildDownFrame + findFrame/parseFrame 走通用请求-应答事务；
// - 清单按协议 ID 独立保存（SEK 兼容旧存储键 sk-batch-state）。
;(function () {
	'use strict'

	const IR_IDLE_MS = 20000
	const IR_KEEPALIVE_TIMEOUT = 4000
	const DEFAULT_TIMEOUT_MS = 5000
	const DEFAULT_GAP_MS = 200
	const STATE_KEY = 'sk-batch-state'

	// tag → 整包查询 queryId 映射; 不在表内的 tag 跳过回读, 仅凭写应答判断
	const TAG_QUERY_ID = {
		1: 1, 2: 2, 3: 3, 4: 4,
		30: 30, 31: 31, 32: 10, 33: 11, 34: 13, 35: 35, 36: 15, 37: 18, 38: 22
	}

	const SUPPORTED_TYPES = {
		bcd: 1, bcd_le: 1, bcd_be: 1,
		ascii: 1, hex: 1, hexbytes: 1,
		uint8: 1, int8: 1,
		uint16le: 1, uint16be: 1, int16le: 1, int16be: 1,
		uint32le: 1, uint32be: 1, int32le: 1, int32be: 1,
		enum: 1
	}

	// ---------- 编码 ----------
	function bcdLeBytes(digitStr, len) {
		let digits = String(digitStr).replace(/\D/g, '')
		if (digits === '') digits = '0'
		if (digits.length % 2 !== 0) digits = '0' + digits
		const bytes = []
		for (let i = digits.length - 2; i >= 0; i -= 2) {
			const hi = digits.charCodeAt(i) - 48
			const lo = digits.charCodeAt(i + 1) - 48
			bytes.push(((hi & 0xf) << 4) | (lo & 0xf))
		}
		if (len != null && bytes.length > len) {
			throw new Error('数值 ' + digitStr + ' 超出字段长度上限(' + len + ' 字节)')
		}
		if (len != null) {
			while (bytes.length < len) bytes.push(0x00)
		}
		return bytes
	}

	function bcdBeBytes(digitStr, len) {
		let digits = String(digitStr).replace(/\D/g, '')
		if (digits === '') digits = '0'
		if (digits.length % 2 !== 0) digits = '0' + digits
		if (len != null && digits.length < len * 2) digits = digits.padStart(len * 2, '0')
		const bytes = []
		for (let i = 0; i < digits.length; i += 2) {
			const hi = digits.charCodeAt(i) - 48
			const lo = digits.charCodeAt(i + 1) - 48
			bytes.push(((hi & 0xf) << 4) | (lo & 0xf))
		}
		if (len != null && bytes.length > len) {
			throw new Error('数值 ' + digitStr + ' 超出字段长度上限(' + len + ' 字节)')
		}
		return bytes
	}

	function addBig(startDigits, k, step) {
		if (!step) return startDigits
		return (BigInt(startDigits) + BigInt(k) * BigInt(step)).toString()
	}

	function asciiToBytes(s, fillLen) {
		s = s == null ? '' : String(s)
		const bytes = []
		const n = fillLen != null ? Math.min(s.length, fillLen) : s.length
		for (let i = 0; i < n; i++) bytes.push(s.charCodeAt(i) & 0xff)
		if (fillLen != null) {
			while (bytes.length < fillLen) bytes.push(0x00)
		}
		return bytes
	}

	function hexStrToBytes(str) {
		const clean = String(str == null ? '' : str).replace(/0x/gi, '').replace(/[\s:,_-]/g, '')
		if (!clean) return []
		if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
			throw new Error('HEX 格式无效: ' + str)
		}
		const out = []
		for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16))
		return out
	}

	function textToBytes(str, appendCrlf) {
		const s = String(str == null ? '' : str) + (appendCrlf ? '\r\n' : '')
		if (typeof TextEncoder === 'function') return Array.from(new TextEncoder().encode(s))
		return asciiToBytes(s)
	}

	function numToBytesLE(val, type) {
		switch (type) {
			case 'uint32le':
			case 'int32le':
				return [val & 0xff, (val >>> 8) & 0xff, (val >>> 16) & 0xff, (val >>> 24) & 0xff]
			case 'uint32be':
			case 'int32be':
				return [(val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff]
			case 'uint16le':
			case 'int16le':
				return [val & 0xff, (val >>> 8) & 0xff]
			case 'uint16be':
			case 'int16be':
				return [(val >>> 8) & 0xff, val & 0xff]
			case 'uint8':
			case 'int8':
				return [val & 0xff]
			default:
				return []
		}
	}

	function hexOf(arr) {
		return Array.from(arr || []).map(function (b) {
			return ('0' + (b & 0xff).toString(16).toUpperCase()).slice(-2)
		}).join(' ')
	}

	function sleep(ms) {
		return new Promise(function (r) { setTimeout(r, ms) })
	}

	function isBcdType(type) {
		return type === 'bcd' || type === 'bcd_le' || type === 'bcd_be'
	}

	function isNumericType(type) {
		return ['uint8', 'int8', 'uint16le', 'uint16be', 'int16le', 'int16be', 'uint32le', 'uint32be', 'int32le', 'int32be'].indexOf(type) !== -1
	}

	// ---------- 协议识别与预设索引 ----------
	function getActiveProtoId() {
		return window._activeProtocol ||
			(document.getElementById('serial-protocol-select') || {}).value ||
			'sek'
	}

	function getActiveProto() {
		if (typeof window.getActiveProtocol === 'function') {
			try { return window.getActiveProtocol() } catch (e) { /* ignore */ }
		}
		const id = getActiveProtoId()
		return (window._protocols && window._protocols[id]) || null
	}

	function getActiveProtoName() {
		const p = getActiveProto()
		if (p && p.name) return p.name
		const id = getActiveProtoId()
		return id ? id.toUpperCase() : '?'
	}

	// 为缺少 presets 声明的内置协议（如 cjt188 / sk-ultrasonic）补充默认常用批量指令预设
	function builtinFallbackPresets(protoId) {
		if (protoId === 'cjt188' || protoId === 'sk-ultrasonic') {
			return [{
				group: '188 常用指令',
				items: [
					{ name: '读表号 (0x03)', func: '0x03', cmd: '0x03', desc: '广播读表号' },
					{ name: '读数据 (0x01)', func: '0x01', cmd: '0x01', desc: '读取当前累积流量与状态' },
					{ name: '开阀 (0x04)', func: '0x04', cmd: '0x04', val: '55', desc: '阀门控制：开阀' },
					{ name: '关阀 (0x04)', func: '0x04', cmd: '0x04', val: '99', desc: '阀门控制：关阀' },
				],
			}]
		}
		return []
	}

	function normalizePresetGroups(presets) {
		if (!Array.isArray(presets) || !presets.length) return []
		if (presets[0] && Array.isArray(presets[0].items)) return presets
		return [{ group: '常用指令', items: presets }]
	}

	let PRESET_BY_NAME = {}
	let PRESET_GROUPS = []
	let activeProtoId = 'sek'

	function buildPresetIndex(protoId) {
		PRESET_BY_NAME = {}
		PRESET_GROUPS = []
		const id = protoId || getActiveProtoId()
		activeProtoId = id
		const proto = getActiveProto()
		let rawGroups = []
		if (id === 'sek') {
			rawGroups = normalizePresetGroups(window.SK_DOWN_PRESETS || (proto && proto.presets) || [])
		} else if (proto && Array.isArray(proto.presets) && proto.presets.length) {
			rawGroups = normalizePresetGroups(proto.presets)
		} else {
			rawGroups = builtinFallbackPresets(id)
		}
		rawGroups.forEach(function (g) {
			const filtered = (g.items || []).filter(function (it) {
				if (!it || !it.name) return false
				// 如果带 param，必须是我们支持编辑的参数类型
				if (it.param && it.param.type && !SUPPORTED_TYPES[it.param.type]) return false
				return true
			})
			if (filtered.length) PRESET_GROUPS.push({ group: g.group || '常用指令', items: filtered })
			filtered.forEach(function (it) { PRESET_BY_NAME[it.name] = it })
		})
	}

	function isSekWritePreset(preset) {
		return !!(activeProtoId === 'sek' && preset && preset.func === '0x01' &&
			preset.param && SUPPORTED_TYPES[preset.param.type] &&
			preset.tlv && preset.tlv[0] && preset.tlv[0].items && preset.tlv[0].items[0])
	}

	function computeEntryBytes(entry, preset, k) {
		const param = preset.param
		const type = param.type
		const name = preset.name
		if (isBcdType(type)) {
			const raw = (entry.value || '').trim()
			if (!/^[0-9]+$/.test(raw)) throw new Error(name + ' 起始值须为纯数字')
			const len = param.fillLen || param.length || 8
			if (raw.length > len * 2) throw new Error(name + ' 起始值超出字段长度上限(' + (len * 2) + ' 位十进制)')
			const step = parseInt(entry.step, 10)
			const stepVal = isNaN(step) ? 0 : step
			if (stepVal < 0) throw new Error(name + ' 步进须为不小于0的整数')
			const digitsStr = addBig(raw, k, stepVal)
			return type === 'bcd_be' ? bcdBeBytes(digitsStr, len) : bcdLeBytes(digitsStr, len)
		}
		if (type === 'ascii') {
			return asciiToBytes(entry.value || '', param.fillLen != null ? param.fillLen : param.length)
		}
		if (type === 'hex' || type === 'hexbytes') {
			const raw = hexStrToBytes(entry.value || '')
			const fillLen = param.fillLen != null ? param.fillLen : param.length
			if (fillLen != null) {
				while (raw.length < fillLen) raw.push(0x00)
			}
			return raw
		}
		if (type === 'enum') {
			const key = entry.value
			if (key == null || key === '') throw new Error(name + ' 请选择枚举值')
			const val = parseInt(key, 10)
			if (isNaN(val)) throw new Error(name + ' 枚举值非法')
			return numToBytesLE(val & 0xff, param.valueType || 'uint8')
		}
		if (isNumericType(type)) {
			const baseVal = parseInt(entry.value, 10)
			if (isNaN(baseVal)) throw new Error(name + ' 数值非法')
			const step = parseInt(entry.step, 10)
			const stepVal = isNaN(step) ? 0 : step
			const val = baseVal + (k || 0) * stepVal
			if (type.indexOf('uint') === 0 && val < 0) throw new Error(name + ' 数值须为不小于0的整数')
			return numToBytesLE(val, type)
		}
		throw new Error(name + ' 不支持的参数类型: ' + type)
	}

	function buildStepFrame(entry, k, protoId, proto) {
		if (entry.kind === 'custom') {
			const mode = entry.mode || 'hex'
			const raw = entry.value || ''
			const bytes = mode === 'hex' ? hexStrToBytes(raw) : textToBytes(raw, mode === 'text_crlf')
			if (!bytes.length) throw new Error((entry.name || '自定义步骤') + ' 内容为空')
			return { name: entry.name || ('自定义(' + mode.toUpperCase() + ')'), bytes: bytes, waitReply: entry.waitReply !== false }
		}
		const preset = PRESET_BY_NAME[entry.presetName]
		if (!preset) throw new Error('未知预设: ' + entry.presetName + ', 请删除该行后重试')

		// 协议级构建
		if (protoId === 'sek') {
			let tlv = []
			if (preset.tlv) {
				tlv = preset.tlv.map(function (blk) {
					return {
						tag: blk.tag,
						items: (blk.items || []).map(function (it) {
							let v = it.value != null ? it.value.slice() : []
							if (it.ascii != null) v = asciiToBytes(it.ascii, it.fillLen)
							return { id: it.id, value: v }
						})
					}
				})
			}
			if (preset.param && tlv[0] && tlv[0].items && tlv[0].items[0]) {
				tlv[0].items[0].value = computeEntryBytes(entry, preset, k)
			}
			const built = typeof window.skBuildDownFrame === 'function'
				? window.skBuildDownFrame({ funcCode: preset.func || '0x03', tlv: tlv })
				: (proto && typeof proto.buildDownFrame === 'function' ? proto.buildDownFrame({ funcCode: preset.func || '0x03', tlv: tlv }) : null)
			const frame = built && built.frame ? Array.from(built.frame) : (built ? Array.from(built) : [])
			if (!frame.length) throw new Error(preset.name + ' 组帧失败')
			return { name: preset.name, bytes: frame, waitReply: entry.waitReply !== false, preset: preset }
		}

		if ((protoId === 'cjt188' || protoId === 'sk-ultrasonic') && typeof window.cjt188BuildDownFrame === 'function') {
			const r = window.cjt188BuildDownFrame({
				cmd: preset.cmd || preset.func || '0x01',
				val: preset.val != null ? preset.val : entry.value,
			})
			const frame = r && r.frame ? Array.from(r.frame) : []
			if (!frame.length) throw new Error(preset.name + ' 组帧失败')
			return { name: preset.name, bytes: frame, waitReply: entry.waitReply !== false, preset: preset }
		}

		if (proto && typeof proto.buildDownFrame === 'function') {
			const opts = Object.assign({}, preset)
			if (preset.param) {
				const paramBytes = computeEntryBytes(entry, preset, k)
				opts.payload = paramBytes
				opts.payloadHex = hexOf(paramBytes)
				opts.value = entry.value
			}
			const built = proto.buildDownFrame(opts)
			const frame = built && built.frame ? Array.from(built.frame) : (built ? Array.from(built) : [])
			if (!frame.length) throw new Error(preset.name + ' 组帧失败')
			return { name: preset.name, bytes: frame, waitReply: entry.waitReply !== false, preset: preset }
		}

		if (preset.hex || preset.payloadHex) {
			const bytes = hexStrToBytes(preset.hex || preset.payloadHex)
			if (!bytes.length) throw new Error(preset.name + ' HEX 为空')
			return { name: preset.name, bytes: bytes, waitReply: entry.waitReply !== false, preset: preset }
		}
		throw new Error('当前协议不支持构建预设: ' + preset.name)
	}

	// ---------- DOM ----------
	const el = {}
	let list = [] // [{ kind: 'preset'|'custom', presetName, name, mode, value, step, waitReply, enabled }]
	let running = false
	let stopFlag = false
	let lastCommAt = 0
	let keepingAlive = false
	let current = 0
	let activeCancelWait = null

	function $(id) { return document.getElementById(id) }

	function setStatus(text, cls) {
		if (!el.status) return
		el.status.textContent = text
		el.status.className = 'sk-rw-status' + (cls ? ' ' + cls : '')
	}

	function setProgressText(text) {
		if (!el.progress) return
		el.progress.style.width = '100%'
		el.progress.textContent = text
	}

	function logLine(msg, level) {
		if (!el.log) return
		const div = document.createElement('div')
		div.className = 'sk-rw-log-line sk-rw-' + (level || 'info')
		const t = new Date()
		const ts = [t.getHours(), t.getMinutes(), t.getSeconds()].map(function (n) {
			return ('0' + n).slice(-2)
		}).join(':')
		div.textContent = '[' + ts + '] ' + msg
		el.log.appendChild(div)
		el.log.scrollTop = el.log.scrollHeight
	}

	function clearLog() {
		if (el.log) el.log.innerHTML = ''
		if (el.summary) {
			el.summary.textContent = ''
			el.summary.className = 'sk-rw-summary'
		}
	}

	// ---------- 事务 ----------
	function assertRunning(requireSekTx) {
		if (stopFlag) throw new Error('已停止')
		if (!window.serialApi || !window.serialApi.isOpen()) throw new Error('串口未打开')
		if (requireSekTx && !window.sekTx) throw new Error('sekTx 未加载')
	}

	async function keepAliveIfNeeded() {
		if (stopFlag) throw new Error('已停止')
		if (!window.serialApi || !window.serialApi.isOpen()) throw new Error('串口未打开')
		if (keepingAlive) return
		if (Date.now() - lastCommAt < IR_IDLE_MS) return

		keepingAlive = true
		logLine('距上次通信已 ' + Math.round((Date.now() - lastCommAt) / 1000) +
			's, 发送保活查询(阈值' + (IR_IDLE_MS / 1000) + 's)', 'info')
		try {
			await window.sekTx.sendAndWait({
				buildOpts: { funcCode: '0x03', tlv: [{ tag: 10, items: [{ id: 1, value: [] }] }] },
				expectFunc: 0x83,
				timeoutMs: IR_KEEPALIVE_TIMEOUT
			})
			lastCommAt = Date.now()
			logLine('保活成功', 'info')
		} catch (e) {
			const err = new Error('保活失败, 已中止: ' + (e.message || e))
			err.fatal = true
			throw err
		} finally {
			keepingAlive = false
		}
	}

	// 通用协议请求-应答事务：发送原始字节，按协议 findFrame / parseFrame 等待有效应答帧（无 findFrame 时收包即返）
	function sendAndWaitGeneric(proto, frameBytes, timeoutMs) {
		return new Promise(function (resolve, reject) {
			if (stopFlag) { reject(new Error('已停止')); return }
			const api = window.serialApi
			if (!api || !api.isOpen()) { reject(new Error('串口未打开')); return }
			const targetSid = typeof api.getActiveSendSid === 'function' ? api.getActiveSendSid() : 'S'
			let done = false
			let buf = []
			let timer = null
			let unsub = null

			function finish(err, res) {
				if (done) return
				done = true
				if (timer) { clearTimeout(timer); timer = null }
				if (unsub) { try { unsub() } catch (e) {} unsub = null }
				if (activeCancelWait === cancel) activeCancelWait = null
				if (err) reject(err)
				else resolve(res)
			}

			function cancel(reason) {
				finish(new Error(reason || '已停止'))
			}
			activeCancelWait = cancel

			timer = setTimeout(function () {
				finish(new Error('应答超时(' + timeoutMs + 'ms)'))
			}, timeoutMs)

			if (typeof api.onReceive === 'function') {
				unsub = api.onReceive(function (chunk, sid) {
					if (done) return
					if (sid && targetSid && sid !== targetSid) return
					const arr = Array.from(chunk || [])
					if (!arr.length) return
					for (let i = 0; i < arr.length; i++) buf.push(arr[i])
					if (buf.length > 65536) buf = buf.slice(buf.length - 16384)

					if (proto && typeof proto.findFrame === 'function') {
						while (buf.length > 0) {
							let found = null
							try { found = proto.findFrame(Uint8Array.from(buf)) } catch (e) { found = null }
							if (!found || !found.found || !found.frame) break
							const endPos = (found.offset || 0) + (found.length || found.frame.length)
							buf = buf.slice(Math.max(1, endPos))
							let parsed = null
							if (typeof proto.parseFrame === 'function') {
								try { parsed = proto.parseFrame(found.frame) } catch (e) { parsed = null }
							}
							if (!parsed || parsed.ok !== false) {
								finish(null, { frame: Array.from(found.frame), parsed: parsed })
								return
							}
						}
						return
					}
					if (proto && typeof proto.parseFrame === 'function') {
						let parsed = null
						try { parsed = proto.parseFrame(Uint8Array.from(buf)) } catch (e) { parsed = null }
						if (parsed && parsed.ok !== false) {
							finish(null, { frame: buf.slice(), parsed: parsed })
							return
						}
						return
					}
					finish(null, { frame: buf.slice(), parsed: null })
				})
			}

			Promise.resolve(api.writeRaw(Uint8Array.from(frameBytes))).catch(function (e) {
				finish(new Error('发送失败: ' + (e && e.message ? e.message : e)))
			})
		})
	}

	// ---------- 单台写入 + 回读确认（SEK 专用增强模式） ----------
	async function writeOneSek(k, timeoutMs, gapMs, continueOnFail) {
		assertRunning(true)
		const plan = list.map(function (entry) {
			const preset = PRESET_BY_NAME[entry.presetName]
			if (!preset) throw new Error('未知预设: ' + entry.presetName + ', 请删除该行后重试')
			const tag = preset.tlv[0].tag
			const id = preset.tlv[0].items[0].id
			const bytes = computeEntryBytes(entry, preset, k)
			return { name: preset.name, tag: tag, id: id, bytes: bytes }
		})

		const writeResults = []
		let aborted = false
		for (let i = 0; i < plan.length; i++) {
			if (aborted) {
				writeResults.push({ ok: false, tag11: null, error: '未尝试(前序失败已中止)', attempted: false })
				continue
			}
			if (stopFlag) throw new Error('已停止')
			await keepAliveIfNeeded()
			const item = plan[i]
			let tag11 = null
			let ok = false
			let err = null
			try {
				const res = await window.sekTx.sendAndWait({
					buildOpts: {
						funcCode: '0x01',
						tlv: [{ tag: item.tag, items: [{ id: item.id, value: item.bytes }] }]
					},
					expectFunc: 0x81,
					timeoutMs: timeoutMs
				})
				lastCommAt = Date.now()
				tag11 = res.tag11
				ok = (tag11 === 1)
			} catch (e) {
				err = e.message || String(e)
				ok = false
			}
			writeResults.push({ ok: ok, tag11: tag11, error: err, attempted: true })
			if (!ok && !continueOnFail) aborted = true
			if (gapMs > 0) await sleep(gapMs)
		}

		const neededTagsSet = {}
		plan.forEach(function (p) { if (TAG_QUERY_ID[p.tag] != null) neededTagsSet[p.tag] = true })
		const neededTags = Object.keys(neededTagsSet).map(Number)
		const frames = {}
		for (let i = 0; i < neededTags.length; i++) {
			const tag = neededTags[i]
			try {
				if (stopFlag) throw new Error('已停止')
				await keepAliveIfNeeded()
				const qid = TAG_QUERY_ID[tag]
				const res = await window.sekTx.sendAndWait({
					buildOpts: { funcCode: '0x03', tlv: [{ tag: 10, items: [{ id: qid, value: [] }] }] },
					expectFunc: 0x83,
					timeoutMs: timeoutMs
				})
				lastCommAt = Date.now()
				frames[tag] = res.frame
			} catch (e) {
				frames[tag] = null
			}
		}

		const rows = plan.map(function (p, idx) {
			const wr = writeResults[idx]
			let readBytes = null
			let readOk = false
			let skippedRead = false
			if (TAG_QUERY_ID[p.tag] == null) {
				skippedRead = true
				readOk = !!wr.ok
			} else {
				const frame = frames[p.tag]
				if (frame) {
					const it = window.sekTx.findTlvItem(frame, p.tag, p.id)
					readBytes = (it && it.raw) ? it.raw.slice() : null
					readOk = !!(wr.ok && readBytes && window.sekTx.bytesEqual(readBytes, p.bytes))
				}
			}
			return {
				name: p.name, bytes: p.bytes,
				writeOk: wr.ok, tag11: wr.tag11, writeError: wr.error, attempted: wr.attempted,
				readBytes: readBytes, readOk: readOk, skippedRead: skippedRead
			}
		})

		const pass = rows.every(function (r) { return r.readOk })
		return { k: k, mode: 'sek-write', pass: pass, rows: rows }
	}

	// ---------- 通用跨协议批量执行 ----------
	async function writeOneGeneric(k, timeoutMs, gapMs, continueOnFail) {
		assertRunning(false)
		const protoId = getActiveProtoId()
		const proto = getActiveProto()
		const plan = list.map(function (entry) {
			return buildStepFrame(entry, k, protoId, proto)
		})

		const rows = []
		let aborted = false
		for (let i = 0; i < plan.length; i++) {
			const step = plan[i]
			if (aborted) {
				rows.push({
					name: step.name, bytes: step.bytes,
					writeOk: false, writeError: '未尝试(前序失败已中止)', attempted: false,
					readBytes: null, readOk: false, skippedRead: !step.waitReply
				})
				continue
			}
			if (stopFlag) throw new Error('已停止')
			let ok = false
			let err = null
			let replyBytes = null
			try {
				if (step.waitReply) {
					const res = await sendAndWaitGeneric(proto, step.bytes, timeoutMs)
					replyBytes = res && res.frame ? res.frame : null
					ok = true
				} else {
					await window.serialApi.writeRaw(Uint8Array.from(step.bytes))
					ok = true
				}
				lastCommAt = Date.now()
			} catch (e) {
				err = e && e.message ? e.message : String(e)
				ok = false
			}
			rows.push({
				name: step.name, bytes: step.bytes,
				writeOk: ok, tag11: null, writeError: err, attempted: true,
				readBytes: replyBytes, readOk: ok, skippedRead: !step.waitReply
			})
			if (!ok && !continueOnFail) aborted = true
			if (gapMs > 0 && i < plan.length - 1) await sleep(gapMs)
		}

		const pass = rows.every(function (r) { return r.readOk })
		return { k: k, mode: 'generic', pass: pass, rows: rows }
	}

	async function writeOne(k) {
		if (!list.length) throw new Error('清单为空, 请先添加指令步骤')
		const timeoutMs = Math.max(500, parseInt(el.timeout && el.timeout.value, 10) || DEFAULT_TIMEOUT_MS)
		const gapMs = Math.max(0, parseInt(el.gap && el.gap.value, 10) || 0)
		const continueOnFail = !!(el.continueOnFail && el.continueOnFail.checked)
		const allSekWrite = activeProtoId === 'sek' && !!window.sekTx && list.every(function (e) {
			return e.kind !== 'custom' && isSekWritePreset(PRESET_BY_NAME[e.presetName])
		})
		if (allSekWrite) return writeOneSek(k, timeoutMs, gapMs, continueOnFail)
		return writeOneGeneric(k, timeoutMs, gapMs, continueOnFail)
	}

	// ---------- 展示 ----------
	function renderResult(result) {
		logLine('── 第 ' + (result.k + 1) + ' 轮 ' + (result.pass ? 'PASS' : 'FAIL') + ' ──',
			result.pass ? 'pass' : 'fail')
		result.rows.forEach(function (r) {
			const wHex = hexOf(r.bytes)
			const rHex = r.skippedRead ? '(仅发送)' : (r.readBytes ? hexOf(r.readBytes) : '(无应答)')
			const mark = r.readOk ? '✔' : '✘'
			let line = r.name + ': 发=' + wHex + ' 回=' + rHex + ' ' + mark
			if (!r.writeOk) {
				line += r.attempted
					? ' [' + (r.tag11 != null ? 'tag11=' + r.tag11 + ' ' : '') + (r.writeError || '失败') + ']'
					: ' [' + r.writeError + ']'
			}
			logLine(line, r.readOk ? 'pass' : 'fail')
		})
		renderReadback(result)
	}

	function renderReadback(result) {
		if (!el.readback) return
		el.readback.innerHTML = ''
		result.rows.forEach(function (r) {
			const div = document.createElement('div')
			div.className = 'sk-batch-readback-row ' + (r.readOk ? 'sk-rw-pass' : 'sk-rw-fail')
			const rHex = r.skippedRead ? '(仅发送)' : (r.readBytes ? hexOf(r.readBytes) : '(无)')
			div.textContent = r.name + ': 发=' + hexOf(r.bytes) + ' 回=' + rHex + ' ' + (r.readOk ? '✔' : '✘')
			el.readback.appendChild(div)
		})
	}

	// ---------- 清单渲染 ----------
	function buildValueInput(preset, entry) {
		const param = preset.param
		if (!param) return null
		if (param.type === 'enum') {
			const sel = document.createElement('select')
			sel.className = 'form-select form-select-sm'
			const options = param.options || {}
			Object.keys(options).forEach(function (key) {
				const opt = document.createElement('option')
				opt.value = key
				opt.textContent = options[key]
				sel.appendChild(opt)
			})
			const want = (entry.value != null && entry.value !== '') ? String(entry.value) : String(param.default != null ? param.default : '')
			sel.value = want
			return sel
		}
		const input = document.createElement('input')
		input.className = 'form-control form-control-sm'
		input.placeholder = param.label || param.placeholder || '值'
		if (isNumericType(param.type)) {
			input.type = 'number'
			if (param.type.indexOf('uint') === 0) input.min = '0'
		} else {
			input.type = 'text'
		}
		input.value = entry.value != null ? entry.value : ''
		return input
	}

	function renderList() {
		if (!el.list) return
		el.list.innerHTML = ''
		list.forEach(function (entry, idx) {
			const row = document.createElement('div')
			row.className = 'sk-batch-item-row' + (entry.kind === 'custom' ? ' is-custom' : '')

			const no = document.createElement('span')
			no.className = 'sk-batch-item-no'
			no.textContent = String(idx + 1)
			row.appendChild(no)

			if (entry.kind === 'custom') {
				const modeSel = document.createElement('select')
				modeSel.className = 'form-select form-select-sm sk-batch-custom-mode'
				;[
					['hex', 'HEX'],
					['text', 'TEXT'],
					['text_crlf', 'TEXT+\\r\\n'],
				].forEach(function (optDef) {
					const o = document.createElement('option')
					o.value = optDef[0]
					o.textContent = optDef[1]
					modeSel.appendChild(o)
				})
				modeSel.value = entry.mode || 'hex'
				modeSel.addEventListener('change', function () {
					entry.mode = modeSel.value
					saveState()
				})
				row.appendChild(modeSel)

				const valInput = document.createElement('input')
				valInput.type = 'text'
				valInput.className = 'form-control form-control-sm sk-batch-item-value'
				valInput.placeholder = entry.mode === 'hex' ? '如 68 10 AA ...' : '如 AT+CSQ'
				valInput.value = entry.value != null ? entry.value : ''
				valInput.addEventListener('change', function () {
					entry.value = valInput.value
					saveState()
				})
				row.appendChild(valInput)

				const waitLabel = document.createElement('label')
				waitLabel.className = 'ctl-chip ctl-chip--micro sk-batch-wait'
				waitLabel.title = '勾选后发送完等待设备应答'
				const waitCb = document.createElement('input')
				waitCb.type = 'checkbox'
				waitCb.checked = entry.waitReply !== false
				waitCb.addEventListener('change', function () {
					entry.waitReply = waitCb.checked
					saveState()
				})
				const waitTxt = document.createElement('span')
				waitTxt.textContent = '等回'
				waitLabel.append(waitCb, waitTxt)
				row.appendChild(waitLabel)

				const delBtn = document.createElement('button')
				delBtn.type = 'button'
				delBtn.className = 'btn btn-sm btn-outline-danger sk-batch-item-del'
				delBtn.title = '删除'
				delBtn.innerHTML = '<i class="bi bi-trash"></i>'
				delBtn.addEventListener('click', function () {
					list.splice(idx, 1)
					renderList()
					saveState()
				})
				row.appendChild(delBtn)
				el.list.appendChild(row)
				return
			}

			const preset = PRESET_BY_NAME[entry.presetName]
			if (!preset) {
				const warn = document.createElement('span')
				warn.className = 'sk-batch-item-name'
				warn.textContent = '(未知预设: ' + entry.presetName + ')'
				row.appendChild(warn)
				const delBtn = document.createElement('button')
				delBtn.type = 'button'
				delBtn.className = 'btn btn-sm btn-outline-danger sk-batch-item-del'
				delBtn.title = '删除'
				delBtn.innerHTML = '<i class="bi bi-trash"></i>'
				delBtn.addEventListener('click', function () {
					list.splice(idx, 1)
					renderList()
					saveState()
				})
				row.appendChild(delBtn)
				el.list.appendChild(row)
				return
			}

			const nameSpan = document.createElement('span')
			nameSpan.className = 'sk-batch-item-name'
			nameSpan.textContent = preset.name
			nameSpan.title = preset.desc || ''
			row.appendChild(nameSpan)

			const valueEl = buildValueInput(preset, entry)
			if (valueEl) {
				valueEl.classList.add('sk-batch-item-value')
				valueEl.addEventListener('change', function () {
					entry.value = valueEl.value
					saveState()
				})
				row.appendChild(valueEl)
			} else {
				const noParam = document.createElement('span')
				noParam.className = 'sk-batch-item-noparam'
				noParam.textContent = '无参指令'
				row.appendChild(noParam)
			}

			if (preset.param && (isBcdType(preset.param.type) || isNumericType(preset.param.type))) {
				const stepEl = document.createElement('input')
				stepEl.type = 'number'
				stepEl.className = 'form-control form-control-sm sk-batch-step'
				stepEl.min = '0'
				stepEl.title = '步进(每轮累加), 0=固定不累加'
				stepEl.value = entry.step != null ? entry.step : (isBcdType(preset.param.type) ? '1' : '0')
				stepEl.addEventListener('change', function () {
					entry.step = stepEl.value
					saveState()
				})
				row.appendChild(stepEl)
			} else {
				const placeholder = document.createElement('span')
				placeholder.className = 'sk-batch-step-placeholder'
				row.appendChild(placeholder)
			}

			const delBtn = document.createElement('button')
			delBtn.type = 'button'
			delBtn.className = 'btn btn-sm btn-outline-danger sk-batch-item-del'
			delBtn.title = '删除'
			delBtn.innerHTML = '<i class="bi bi-trash"></i>'
			delBtn.addEventListener('click', function () {
				list.splice(idx, 1)
				renderList()
				saveState()
			})
			row.appendChild(delBtn)

			el.list.appendChild(row)
		})
		if (!list.length) {
			const empty = document.createElement('div')
			empty.className = 'sk-batch-list-empty'
			empty.textContent = PRESET_GROUPS.length
				? '清单为空，请从上方选择预设点「添加」，或点「+ 自定义」编排指令'
				: '当前协议无预设指令，可点「+ 自定义」编排 HEX / 文本指令序列'
			el.list.appendChild(empty)
		}
	}

	function renderPresetSelect() {
		if (!el.presetSelect) return
		el.presetSelect.innerHTML = ''
		if (!PRESET_GROUPS.length) {
			const opt = document.createElement('option')
			opt.value = ''
			opt.textContent = '（当前协议无预设，请用 + 自定义）'
			el.presetSelect.appendChild(opt)
			el.presetSelect.disabled = true
			if (el.add) el.add.disabled = true
			return
		}
		el.presetSelect.disabled = running
		if (el.add) el.add.disabled = running
		PRESET_GROUPS.forEach(function (g) {
			const og = document.createElement('optgroup')
			og.label = g.group
			g.items.forEach(function (it) {
				const opt = document.createElement('option')
				opt.value = it.name
				opt.textContent = it.name
				og.appendChild(opt)
			})
			el.presetSelect.appendChild(og)
		})
	}

	// ---------- 按协议隔离的状态持久化 ----------
	function storageKeyFor(protoId) {
		return protoId === 'sek' ? STATE_KEY : (STATE_KEY + ':' + protoId)
	}

	function indexKeyFor(protoId) {
		return protoId === 'sek' ? (STATE_KEY + '.index') : (STATE_KEY + ':' + protoId + '.index')
	}

	function saveState() {
		const st = {
			list: list.map(function (e) {
				return {
					kind: e.kind || 'preset',
					presetName: e.presetName || '',
					name: e.name || '',
					mode: e.mode || 'hex',
					value: e.value != null ? e.value : '',
					step: e.step != null ? e.step : '0',
					waitReply: e.waitReply !== false,
					enabled: e.enabled !== false,
				}
			}),
			timeoutMs: parseInt(el.timeout && el.timeout.value, 10) || DEFAULT_TIMEOUT_MS,
			gapMs: parseInt(el.gap && el.gap.value, 10) || DEFAULT_GAP_MS,
			continueOnFail: !!(el.continueOnFail && el.continueOnFail.checked)
		}
		try { sessionStorage.setItem(indexKeyFor(activeProtoId), String(current)) } catch (e) {}
		try { localStorage.setItem(storageKeyFor(activeProtoId), JSON.stringify(st)) } catch (e) {}
	}

	function loadState(protoId) {
		list = []
		current = 0
		let st = null
		try {
			const raw = localStorage.getItem(storageKeyFor(protoId))
			if (raw) st = JSON.parse(raw)
		} catch (e) { st = null }
		if (st && Array.isArray(st.list)) {
			list = st.list.filter(function (e) {
				return e && (e.kind === 'custom' || e.presetName)
			}).map(function (e) {
				return {
					kind: e.kind || 'preset',
					presetName: e.presetName || '',
					name: e.name || '',
					mode: e.mode || 'hex',
					value: e.value != null ? e.value : '',
					step: e.step != null ? e.step : '1',
					waitReply: e.waitReply !== false,
					enabled: e.enabled !== false,
				}
			})
		}
		try { current = Math.max(0, parseInt(sessionStorage.getItem(indexKeyFor(protoId)), 10) || 0) } catch (e) { current = 0 }
		if (st && st.timeoutMs != null && el.timeout) el.timeout.value = st.timeoutMs
		if (st && st.gapMs != null && el.gap) el.gap.value = st.gapMs
		if (st && st.continueOnFail != null && el.continueOnFail) el.continueOnFail.checked = !!st.continueOnFail
	}

	// ---------- UI 状态与协议同步 ----------
	function updateIdleStatus() {
		if (running) return
		setProgressText('已完成 ' + current + ' 轮')
		setStatus('就绪 · 下一轮起始索引 ' + current, '')
	}

	function refreshProtocol() {
		if (running) return
		const id = getActiveProtoId()
		const name = getActiveProtoName()
		buildPresetIndex(id)
		loadState(id)
		if (el.titleProto) el.titleProto.textContent = name
		if (el.hint) {
			el.hint.textContent = id === 'sek'
				? '协议 SEK · 支持协议预设与自定义指令；纯 0x01 写预设清单自动执行整包回读确认（清单按协议独立保存）'
				: '协议 ' + name + ' · 编排多条预设或自定义指令按顺序逐条下发并等待应答（清单按协议独立保存）'
		}
		renderPresetSelect()
		renderList()
		updateIdleStatus()
	}

	function setBusyUi(busy) {
		running = busy
		if (el.primary) el.primary.disabled = busy
		if (el.stop) el.stop.disabled = !busy
		if (el.reset) el.reset.disabled = busy
		if (el.add) el.add.disabled = busy || !PRESET_GROUPS.length
		if (el.addCustom) el.addCustom.disabled = busy
		if (el.presetSelect) el.presetSelect.disabled = busy || !PRESET_GROUPS.length
		if (el.timeout) el.timeout.disabled = busy
		if (el.gap) el.gap.disabled = busy
		if (el.continueOnFail) el.continueOnFail.disabled = busy
	}

	function validateBeforeRun() {
		if (!window.serialApi || !window.serialApi.isOpen()) {
			setStatus('请先打开串口', 'err')
			return false
		}
		if (!list.length) {
			setStatus('清单为空, 请先添加指令步骤', 'err')
			return false
		}
		for (let i = 0; i < list.length; i++) {
			if (list[i].kind !== 'custom' && !PRESET_BY_NAME[list[i].presetName]) {
				setStatus('清单中含未知预设: ' + list[i].presetName + ', 请删除该行', 'err')
				return false
			}
		}
		return true
	}

	// ---------- 逐轮/逐台执行 ----------
	async function runLineStep() {
		if (running) return
		if (!validateBeforeRun()) return
		stopFlag = false
		setBusyUi(true)
		clearLog()
		setStatus('执行第 ' + (current + 1) + ' 轮…', 'run')
		window.serialApi.pinSession(window.serialApi.getActiveSendSid())
		try {
			const result = await writeOne(current)
			renderResult(result)
			if (result.pass) {
				current++
				saveState()
				setStatus('第 ' + current + ' 轮 PASS, 下一轮起始索引 ' + current, 'ok')
				setProgressText('已完成 ' + current + ' 轮')
				if (el.summary) {
					el.summary.textContent = '第 ' + current + ' 轮 PASS'
					el.summary.className = 'sk-rw-summary is-pass'
				}
			} else {
				setStatus('第 ' + (current + 1) + ' 轮 FAIL, 请重试', 'err')
				if (el.summary) {
					el.summary.textContent = '第 ' + (current + 1) + ' 轮 FAIL'
					el.summary.className = 'sk-rw-summary is-fail'
				}
			}
		} catch (e) {
			logLine('异常: ' + (e.message || e), 'fail')
			setStatus('异常: ' + (e.message || e), 'err')
		} finally {
			window.serialApi.unpinSession()
			setBusyUi(false)
		}
	}

	function stopAll() {
		stopFlag = true
		setStatus('正在停止…', 'warn')
		if (activeCancelWait) {
			try { activeCancelWait('已停止') } catch (e) {}
		}
		if (window.sekTx && typeof window.sekTx.cancelAll === 'function') {
			try { window.sekTx.cancelAll('已停止') } catch (e) {}
		}
	}

	function resetCount() {
		if (running) return
		current = 0
		saveState()
		setStatus('已重置计数为 0', 'ok')
		updateIdleStatus()
	}

	// ---------- init ----------
	function init() {
		el.card = $('sk-batch-card')
		el.titleProto = $('sk-batch-proto-name')
		el.hint = $('sk-batch-hint')
		el.presetSelect = $('sk-batch-preset-select')
		el.add = $('sk-batch-add')
		el.addCustom = $('sk-batch-add-custom')
		el.list = $('sk-batch-list')
		el.timeout = $('sk-batch-timeout')
		el.gap = $('sk-batch-gap')
		el.continueOnFail = $('sk-batch-continue')
		el.primary = $('sk-batch-primary')
		el.stop = $('sk-batch-stop')
		el.reset = $('sk-batch-reset')
		el.progress = $('sk-batch-progress-bar')
		el.status = $('sk-batch-status')
		el.summary = $('sk-batch-summary')
		el.readback = $('sk-batch-readback')
		el.log = $('sk-batch-log')
		if (!el.card || !el.primary) return

		refreshProtocol()

		if (el.add) {
			el.add.addEventListener('click', function () {
				const name = el.presetSelect ? el.presetSelect.value : ''
				const preset = PRESET_BY_NAME[name]
				if (!preset) return
				const def = (preset.param && preset.param.default != null) ? preset.param.default : ''
				list.push({
					kind: 'preset',
					presetName: name,
					value: def,
					step: (preset.param && isBcdType(preset.param.type)) ? '1' : '0',
					waitReply: true,
					enabled: true
				})
				renderList()
				saveState()
			})
		}

		if (el.addCustom) {
			el.addCustom.addEventListener('click', function () {
				const isTextProto = activeProtoId === 'cellular-at'
				list.push({
					kind: 'custom',
					name: '自定义 #' + (list.length + 1),
					mode: isTextProto ? 'text_crlf' : 'hex',
					value: isTextProto ? 'AT' : '',
					step: '0',
					waitReply: true,
					enabled: true,
				})
				renderList()
				saveState()
			})
		}

		el.primary.addEventListener('click', function () {
			runLineStep().catch(function (e) {
				logLine('异常: ' + (e.message || e), 'fail')
				setStatus('异常', 'err')
				setBusyUi(false)
			})
		})
		el.stop.addEventListener('click', stopAll)
		el.stop.disabled = true
		el.reset.addEventListener('click', resetCount)

		const persistOn = [el.timeout, el.gap, el.continueOnFail]
		persistOn.forEach(function (input) {
			if (!input) return
			input.addEventListener('change', saveState)
		})

		const sel = $('serial-protocol-select')
		if (sel) sel.addEventListener('change', refreshProtocol)
		if (window.ProtocolRegistry && typeof window.ProtocolRegistry.onChange === 'function') {
			window.ProtocolRegistry.onChange(refreshProtocol)
		}
	}

	function start() {
		Promise.resolve(window.AppPlatform && window.AppPlatform.instanceReady).then(init)
	}
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start)
	} else {
		start()
	}

	window.skBatchConfig = {
		bcdLeBytes: bcdLeBytes,
		addBig: addBig,
		asciiToBytes: asciiToBytes,
		numToBytesLE: numToBytesLE,
		computeEntryBytes: computeEntryBytes,
		buildStepFrame: buildStepFrame,
		writeOne: writeOne,
		stop: stopAll,
		refreshProtocol: refreshProtocol,
		TAG_QUERY_ID: TAG_QUERY_ID
	}
})()
