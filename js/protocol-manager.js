// 协议管理界面：统一管理内置协议显隐、声明式 JSON 协议增删改导、外部 JS 插件安全信任与桌面端本地插件目录。
// 依赖：window.AppDialog（panel 模式）、window.ProtocolRegistry、window.JsonProtocol、window.JsProtocolPlugin。
// 面板内严禁嵌套调用 AppDialog.confirm / prompt / alert（会与单模态队列死锁），危险操作统一使用面板内联两步确认；
// 所有不可信文本字段一律经 textContent 或表单 value 渲染，严禁拼装 innerHTML。
;(function (root) {
	'use strict'

	const TABS = [
		{ id: 'installed', label: '已装协议' },
		{ id: 'json', label: 'JSON 协议' },
		{ id: 'js', label: 'JS 插件' },
	]
	const ARMED_TIMEOUT_MS = 5000
	const SECURITY_WARNING = '外部 JS 插件拥有与本页面相同的全部权限（包括串口收发、读取本地存储中的密钥与配置、操作页面 DOM），请仅信任你亲自审阅过的代码；文件内容变更后需重新确认信任。'

	function buildDevPrompt(kind) {
		const mode = kind === 'json' || kind === 'js' ? kind : 'all'
		const jsonSpec = [
			'## 声明式 JSON 协议（Schema v1）开发规范',
			'适用于固定帧头、长度字段/定长、标准校验和、结构化字段解析与常规下行指令的二进制协议（免写 JS，零安全风险）。',
			'',
			'### 顶层必填字段',
			'- `schemaVersion`: 固定为 `1`',
			'- `id`: 唯一标识，仅允许小写字母、数字、`-`、`_`，以字母或数字开头（1~48 字符），不能占用已有内置协议 ID',
			'- `name`: 展示名称；`version`: 版本号（如 `"1.0.0"`）；`description`: 简短说明',
			'',
			'### 帧边界与校验 (`framing` / `checksum`)',
			'- `framing`: `{ head: "AA 55", tail: "0D 0A"(可选), fixedLength: 16 }` 或动态长度 `length: { offset, size: 1|2, endian: "le"|"be", totalDelta: 0 }`（总帧长 = 长度字段值 + totalDelta），配合 `minLength` / `maxLength`',
			'- `checksum`: `{ algorithm, offset, start, end, endian }`，支持算法：`none`、`sum8`、`xor8`、`lrc8`、`crc8`、`crc16-modbus`、`crc16-ccitt`、`crc16-xmodem`、`crc16-ibm`、`crc16-custom`（负偏移如 `-2` 表示从帧尾倒数）',
			'',
			'### 字段解析 (`fields`)',
			'- 支持类型：`uint8`、`int8`、`uint16le`、`uint16be`、`int16le`、`int16be`、`uint32le`、`uint32be`、`int32le`、`int32be`、`hex`、`ascii`、`bcd`、`bcd_le`、`bcd_be`、`bitfield`',
			'- 每项可配：`name`、`offset`、`length`（变长类型必填）、`type`、`scale`、`unit`、`format`（`"hex"` 等）、`enum`（映射对象 `{"0":"关闭","1":"开启"}`）、`bits`（位域数组）',
			'',
			'### 下行预设 (`presets`)',
			'- 配置 `presets` 后，工具会自动生成「协议」面板下行界面，并自动接入「批量交互（批量下发 / 随机读写）」：',
			'  `[{ "group": "常用指令", "items": [{ "name": "读状态", "func": "0x03", "desc": "查询设备状态", "payloadHex": "00 01" }] }]`',
			'- 需要用户输入参数时在 item 中增加 `param: { label, type, default, fillLen, options }`',
			'',
			'### 设备面板 (`device`，可选)',
			'- 声明后「通信调试 / 设备面板」切换可用：设备面板按读取组发查询、按应答认领，把字段当前值显示在状态页与参数页；可选声明参数写入。',
			'- `groups`: `[{ "id": "live", "title": "实时数据", "request": { "template": "读状态" } | { "cmd": "0x02", "payloadHex": "" } | { "rawHex": "AA 01 02 AD" }, "reply": { "title": "状态应答" } | { "match": { "offset": 2, "value": "0x82" } } }]`；`template` 引用 `downlink.templates` 的名字，`reply.title` 对应 `frames[].title`，`reply.match` 与 `frames[].match` 同格式',
			'- `fields`: `[{ "key": "volt", "from": "电压", "name": "电压", "group": "live", "kind": "number"|"enum"|"text"|"bits"|"time"|"hex"|"flag", "unit": "V", "copy": false, "note": "" }]`；`from` 必须是 `fields` / `frames[].fields` 里的字段名，值取该字段解出的值（已按 `scale`），`kind` 缺省时按字段类型推断，没有 `group` 的字段显示为「读不到」',
			'- `readSets`: `{ "status": ["live"], "all": ["live", "cfg"] }`（主按键「读取状态」读 status，「更多 → 全部读取」读 all）；`nameKey`：标题旁显示的设备名字段；`timeoutMs`：单组应答超时（200~60000，默认 5000）；`log`：设备面板下方「通信记录」条的初始状态 `"collapsed"`（收起成一行）/ `"strip"`（矮条，默认）/ `"tall"`（高条），用户调整过就以用户为准',
			'- `status`: 状态页部件数组，`type` 取 `metric`（`key` + `sub` + `meter`）、`identity`（`keys`，可复制）、`deviceTime`（`key`，显示与电脑的偏差）、`flags`（`keys`）、`dayBitmap`（`key` + `days` / `firstBit` / `setMeans: "ok"|"bad"` / `setLabel` / `clearLabel`）、`kv`（`keys`）',
			'- `categories`: 参数页分类 `[{ "id": "cfg", "title": "参数", "keys": ["..."] }]`',
			'- `fields[].write`: `{ min?, max?, step?, maxLen?, pattern?, hint?, options?: {值: 文案}, confirm? }`；`pattern` 仅接受单一字符组/字符及其可选量词（例如 `[0-9]{1,3}`），全串匹配。`secret: true` 不进快照，含保密字段的来源帧不提供可复制数据。',
			'- `writes`: `[{ "field": "volt", "template": "设置电压", "reply": { "ok": { "title": "写入应答", "match": { "offset": 3, "value": 1 } }, "rejected"?: { title?, match? }, "processing"?: { title?, match? } } }]`。按字段 key 为带 `write` 的字段声明一个单参数 `downlink.templates` 模板，宿主将输入原值传给模板 `paramValue`。成功应答规则必需；每个规则须包含 `title` 或 `match`，三种应答应互斥。',
			'- 有 `group` 的字段必须先读到本连接当前值，成功应答后重读该组；无 `group` 时写前强制确认、成功应答不等于已生效。快照套用只写草稿。',
			'',
			'### 最小可运行 JSON 例程',
			'```json',
			'{',
			'  "schemaVersion": 1,',
			'  "id": "demo-sensor-v1",',
			'  "name": "示例传感器协议",',
			'  "version": "1.0.0",',
			'  "description": "AA 55 + Cmd(1B) + Len(1B) + Payload + CRC16-Modbus(2B LE)",',
			'  "framing": {',
			'    "head": "AA 55",',
			'    "length": { "offset": 3, "size": 1, "endian": "be", "totalDelta": 6 },',
			'    "minLength": 6,',
			'    "maxLength": 260',
			'  },',
			'  "checksum": { "algorithm": "crc16-modbus", "offset": -2, "start": 0, "end": -2, "endian": "le" },',
			'  "fields": [',
			'    { "name": "命令码", "offset": 2, "type": "uint8", "format": "hex" },',
			'    { "name": "载荷长度", "offset": 3, "type": "uint8" }',
			'  ],',
			'  "presets": [',
			'    {',
			'      "group": "基础查询",',
			'      "items": [',
			'        { "name": "读版本", "func": "0x01", "cmd": "0x01", "payloadHex": "" }',
			'      ]',
			'    }',
			'  ]',
			'}',
			'```',
		].join('\n')

		const jsSpec = [
			'## 外部 JS 协议插件开发规范',
			'适用于复杂变长 TLV、动态加解密、自定义状态机、专属子页工具或自定义随机测试逻辑的协议。',
			'',
			'### 注册入口',
			'调用 `registerProtocol(id, impl)`（或 `module.exports = { id, ...impl }`）：',
			'- `id`: 唯一标识（`/^[a-z0-9][a-z0-9_-]{0,47}$/`，不能覆盖内置协议 ID）',
			'- `name`, `version`, `description`: 协议展示信息',
			'',
			'### 核心方法契约',
			'1. `findFrame(bytes)`：从字节流 `Uint8Array` 中定位完整帧；找到返回 `{ found: true, frame: Uint8Array, offset, length, prefix, suffix }`，否则返回 `{ found: false }`',
			'2. `parseFrame(bytes)`：解析单帧，返回 `{ ok: boolean, raw: Uint8Array, errors?: string[], ...自定义解析字段 }`',
			'3. `logView(parsed)`：返回检查器与日志「解析」视图模型（单帧对象或数组，不识别返回 `null`）：',
			'   `{ title, code?, badges?: [{ text, kind: "ok"|"bad"|"warn"|"info" }], meta?: [[k, v]], sections?: [{ title, pairs?: [[k, v, hint?, kind?]], pre? }], notes?: [{ text, kind }], errors?: string[] }`',
			'   注意：外部插件严禁使用 `section.html`（会被宿主自动降级为纯文本），所有文本由渲染器统一转义。',
			'4. `byteMap(bytes, parsed)`（可选）：返回与帧等长的数组 `[{ grp, tip }]`，实现 HEX 字节悬停高亮与字段说明',
			'5. `buildDownFrame(opts)`（可选）：构建下行帧，返回 `Uint8Array` 或 `{ frame: Uint8Array }`',
			'6. `presets` / `funcTabs`（可选）：声明常用指令预设与功能码分页，自动接入「协议下发」与「批量交互」面板',
			'7. `randomTest`（可选）：自定义随机读写压测 `{ supportsWrite: boolean, hint?: string, cases: [{ name, build(rng), verify?(res) }] }`；不提供时框架会自动从 `presets` 提取可用指令进行随机压测',
			'8. `subTabs`（可选）：在「协议」面板内扩展协议专属子页 `[{ id, label, icon, show(), hide() }]`',
			'',
			'9. `device`（可选）：设备面板声明（状态页、参数当前值、可选写入），宿主不认识协议细节，全部由这里给出：',
			'   `{ title, nameKey?, timeoutMs?, log?: "collapsed"|"strip"|"tall"（设备面板下方通信记录条的初始状态，用户调整过就以用户为准）, fields: [{ key, name, kind: "number"|"enum"|"text"|"bits"|"time"|"hex"|"flag", unit?, scale?, decimals?, digits?, options?, bits?, group?, copy?, note?, addr?, secret?, write? }],`',
			'   `groups: [{ id, title, request, reply? }], readSets?: { status: [组 id], all: [组 id] }, status?: [部件], categories?: [{ id, title, keys }],`',
			'   `extract(parsed, frame) => { [key]: 原值 }`（必需，缺了整份声明被拒；不认识的帧返回 `null`；原值只能是标量或一层标量数组），`buildRequest?(group, ctx) => Uint8Array | number[]`、`matchReply?(group, parsed, frame) => true`（两个都给才能查询，缺一个面板只被动更新），',
			'   `format?(key, raw, get) => string | null`（`get(key)` 只取同一路、同一连接的其它读数），`byteGroups?(parsed, key) => [byteMap 的 grp]`（来源帧按分组高亮，不要返回猜的偏移）}`',
			'   部件 `type`：`metric`（key/sub/meter）、`identity`（keys）、`deviceTime`（key，值为 `YYYY-MM-DD hh:mm:ss`）、`flags`（keys，flag 原值 `[on, note]` 或 bits 字段）、`dayBitmap`（key/days/firstBit/setMeans/setLabel/clearLabel）、`kv`（keys）。',
			'   `fields[].write?: { min?, max?, step?, maxLen?, pattern?, hint?, options?, confirm? }`，配合 `buildWrite(field, value, ctx) => Uint8Array` 和 `matchWriteReply(field, parsed, frame) => "ok" | "rejected" | "processing" | null`；组帧失败请抛错。`ctx` 有 `sid`、`gen`、原输入 `text` 和只取同代次同路读数的 `get(key)`。',
			'   可选 `parseInput(field, text)` 把文本变成与 extract 同形的原值，用作编码及比对；缺省按 kind 转换，数值输入按原值而非显示倍率。`secret: true` 不进快照且保护含该字段的来源帧。声明 group 的字段必须先读本连接，成功应答后按该组回读；没 group 时与自定义确认文案合成一次强制确认，不能确认生效。',
			'   宿主只保留约定的数据字段和函数，所有文本 `textContent` 显示；快照只把确认不一致的可写项加入草稿，不直接下发。',
			'',
			'### 最小可运行 JS 插件例程',
			'```js',
			'registerProtocol(\'demo-custom-proto\', {',
			'  name: \'示例自定义协议\',',
			'  version: \'1.0.0\',',
			'  description: \'5A A5 + Cmd(1B) + Len(1B) + Payload + XOR8(1B)\',',
			'  findFrame(bytes) {',
			'    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])',
			'    for (let i = 0; i <= b.length - 5; i++) {',
			'      if (b[i] !== 0x5A || b[i + 1] !== 0xA5) continue',
			'      const len = b[i + 3], total = 5 + len',
			'      if (i + total > b.length) continue',
			'      let x = 0; for (let k = 0; k < total - 1; k++) x ^= b[i + k]',
			'      if ((x & 0xff) !== b[i + total - 1]) continue',
			'      return { found: true, frame: b.slice(i, i + total), offset: i, length: total, prefix: i, suffix: b.length - i - total }',
			'    }',
			'    return { found: false }',
			'  },',
			'  parseFrame(bytes) {',
			'    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])',
			'    if (b.length < 5 || b[0] !== 0x5A || b[1] !== 0xA5) return { ok: false, raw: b, errors: [\'非本协议帧\'] }',
			'    const cmd = b[2], len = b[3], payload = b.slice(4, 4 + len)',
			'    return { ok: true, raw: b, cmd, len, payload }',
			'  },',
			'  logView(r) {',
			'    if (!r || !r.ok) return null',
			'    return {',
			'      title: \'自定义帧\',',
			'      code: \'0x\' + r.cmd.toString(16).toUpperCase().padStart(2, \'0\'),',
			'      badges: [{ text: \'XOR OK\', kind: \'ok\' }],',
			'      sections: [{ title: \'字段\', pairs: [[\'载荷长度\', r.len + \' B\']] }],',
			'    }',
			'  },',
			'  buildDownFrame(opts) {',
			'    const cmd = Number(opts && opts.cmd != null ? opts.cmd : 0x01) & 0xff',
			'    const payload = Array.isArray(opts && opts.payload) ? opts.payload : []',
			'    const out = new Uint8Array(5 + payload.length)',
			'    out[0] = 0x5A; out[1] = 0xA5; out[2] = cmd; out[3] = payload.length',
			'    for (let i = 0; i < payload.length; i++) out[4 + i] = payload[i] & 0xff',
			'    let x = 0; for (let i = 0; i < out.length - 1; i++) x ^= out[i]',
			'    out[out.length - 1] = x & 0xff',
			'    return out',
			'  },',
			'  presets: [{ group: \'基础指令\', items: [{ name: \'心跳查询\', func: \'0x01\', cmd: 0x01, payload: [] }] }],',
			'})',
			'```',
		].join('\n')

		if (mode === 'json') {
			return [
				'请根据我提供的通信协议文档，生成一个可直接导入「Web Serial Debug → 协议管理 → JSON 协议」的声明式 JSON 协议文件。',
				'要求：严格遵守以下 Schema v1 规范，只输出合法 JSON（不要附加多余解释），并补齐常用指令 `presets` 以便直接支持下行下发和批量交互。',
				'',
				jsonSpec,
			].join('\n')
		}
		if (mode === 'js') {
			return [
				'请根据我提供的通信协议文档，编写一个可直接导入「Web Serial Debug → 协议管理 → JS 插件」的协议插件 `.js` 文件。',
				'要求：严格遵守以下 `registerProtocol` 契约，不依赖外部第三方库，不使用 `section.html` / `innerHTML`，并实现 `findFrame`、`parseFrame`、`logView`、`byteMap`、`buildDownFrame` 与 `presets`。',
				'',
				jsSpec,
			].join('\n')
		}
		return [
			'请根据我提供的通信协议文档，为「Web Serial Debug」开发对应的协议适配文件。',
			'选型建议：若协议为固定帧头 + 长度/定长 + 标准校验和 + 常规字段，请优先输出「声明式 JSON 协议」；若包含复杂 TLV、自定义加密/状态机或动态子页，请输出「JS 协议插件」。',
			'',
			jsonSpec,
			'',
			'---',
			'',
			jsSpec,
		].join('\n')
	}

	function copyText(text) {
		const nav = root.navigator
		if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
			return Promise.resolve(nav.clipboard.writeText(text)).then(function () { return true }, function () { return fallbackCopy(text) })
		}
		return Promise.resolve(fallbackCopy(text))
	}

	function fallbackCopy(text) {
		const doc = getDoc()
		if (!doc || !doc.body || typeof doc.execCommand !== 'function') return false
		const ta = doc.createElement('textarea')
		ta.value = text
		ta.style.position = 'fixed'
		ta.style.opacity = '0'
		doc.body.appendChild(ta)
		try {
			ta.select()
			return !!doc.execCommand('copy')
		} catch (e) {
			return false
		} finally {
			if (typeof ta.remove === 'function') ta.remove()
		}
	}

	let session = null
	let boundDoc = null

	function getDoc() {
		return root.document || null
	}

	function canManage() {
		const P = root.AppPlatform
		if (P && typeof P.has === 'function') return !!P.has('protocol.manage')
		return true
	}

	function mk(tag, cls, text) {
		const doc = getDoc()
		const el = doc.createElement(tag)
		if (cls) el.className = cls
		if (text != null) el.textContent = String(text)
		return el
	}

	function clearChildren(el) {
		if (!el) return
		while (el.children && el.children.length) {
			const last = el.children[el.children.length - 1]
			if (typeof last.remove === 'function') last.remove()
			else if (typeof el.removeChild === 'function') el.removeChild(last)
			else break
		}
		if (el.firstChild && typeof el.removeChild === 'function') {
			while (el.firstChild) el.removeChild(el.firstChild)
		}
	}

	function getActiveProtocolId() {
		if (typeof root._activeProtocol === 'string' && root._activeProtocol) return root._activeProtocol
		const doc = getDoc()
		const sel = doc && doc.getElementById ? doc.getElementById('serial-protocol-select') : null
		return sel ? String(sel.value || '') : ''
	}

	function switchProtocol(id) {
		const reg = root.ProtocolRegistry
		if (reg && typeof reg.isHidden === 'function' && reg.isHidden(id) && typeof reg.setHidden === 'function') {
			reg.setHidden(id, false)
		}
		if (root.serialLanes && typeof root.serialLanes.setProtocol === 'function') {
			const target = typeof root.serialLanes.singleTarget === 'function' ? root.serialLanes.singleTarget() : 'S'
			root.serialLanes.setProtocol(target, id)
			return true
		}
		const doc = getDoc()
		const sel = doc && doc.getElementById ? doc.getElementById('serial-protocol-select') : null
		if (sel) {
			sel.value = id
			if (typeof root.Event === 'function' && typeof sel.dispatchEvent === 'function') {
				sel.dispatchEvent(new root.Event('change', { bubbles: true }))
			}
			return true
		}
		return false
	}

	function sourceLabel(item) {
		if (!item) return '自定义'
		if (item.builtin || item.source === 'builtin') return '内置'
		if (item.source === 'json') return 'JSON'
		if (item.source === 'dir-json') return '目录 JSON'
		if (item.source === 'js-local') return 'JS 插件'
		if (item.source === 'js-dir') return '目录 JS'
		return String(item.source || '自定义')
	}

	function sourceBadgeClass(item) {
		if (!item) return 'pm-badge-muted'
		if (item.builtin || item.source === 'builtin') return 'pm-badge-builtin'
		if (item.source === 'json' || item.source === 'dir-json') return 'pm-badge-json'
		if (item.source === 'js-local' || item.source === 'js-dir') return 'pm-badge-js'
		return 'pm-badge-muted'
	}

	function readFileText(file) {
		if (!file) return Promise.reject(new Error('未选择文件'))
		if (typeof file.text === 'function') return file.text()
		return new Promise(function (resolve, reject) {
			if (typeof root.FileReader !== 'function') {
				reject(new Error('当前环境不支持读取文件'))
				return
			}
			const reader = new root.FileReader()
			reader.onload = function () { resolve(String(reader.result || '')) }
			reader.onerror = function () { reject(new Error('读取文件失败')) }
			reader.readAsText(file)
		})
	}

	function triggerDownload(filename, content) {
		const doc = getDoc()
		if (!doc || !doc.body || typeof root.Blob !== 'function' || !root.URL || typeof root.URL.createObjectURL !== 'function') {
			return false
		}
		const blob = new root.Blob([String(content || '')], { type: 'application/json;charset=utf-8' })
		const url = root.URL.createObjectURL(blob)
		const a = doc.createElement('a')
		a.href = url
		a.download = filename
		a.hidden = true
		doc.body.appendChild(a)
		if (typeof a.click === 'function') a.click()
		if (typeof a.remove === 'function') a.remove()
		setTimeout(function () {
			if (root.URL && typeof root.URL.revokeObjectURL === 'function') root.URL.revokeObjectURL(url)
		}, 1000)
		return true
	}

	function setNotice(s, kind, text) {
		if (!s || s.closed) return
		s.notice = text ? { kind: kind || 'info', text: String(text) } : null
		renderNotice(s)
	}

	function renderNotice(s) {
		if (!s || !s.noticeEl) return
		clearChildren(s.noticeEl)
		if (!s.notice || !s.notice.text) {
			s.noticeEl.hidden = true
			s.noticeEl.className = 'pm-notice'
			return
		}
		s.noticeEl.hidden = false
		s.noticeEl.className = 'pm-notice is-' + (s.notice.kind || 'info')
		const textEl = mk('span', 'pm-notice-text', s.notice.text)
		const closeBtn = mk('button', 'pm-notice-close', '×')
		closeBtn.type = 'button'
		closeBtn.setAttribute('aria-label', '关闭提示')
		closeBtn.addEventListener('click', function () {
			s.notice = null
			renderNotice(s)
		})
		s.noticeEl.appendChild(textEl)
		s.noticeEl.appendChild(closeBtn)
	}

	function clearJsonDeleteArm(s) {
		if (s.jsonDeleteArmed) {
			clearTimeout(s.jsonDeleteArmed.timer)
			s.jsonDeleteArmed = null
		}
	}

	function clearJsDeleteArm(s) {
		if (s.jsDeleteArmed) {
			clearTimeout(s.jsDeleteArmed.timer)
			s.jsDeleteArmed = null
		}
	}

	function switchTab(s, tabId) {
		if (!s || s.closed) return
		const valid = TABS.some(function (t) { return t.id === tabId })
		s.tab = valid ? tabId : 'installed'
		s.tabButtons.forEach(function (btn) {
			const active = btn.dataset.tab === s.tab
			btn.setAttribute('aria-pressed', active ? 'true' : 'false')
			btn.classList.toggle('active', active)
		})
		Object.keys(s.tabPanels).forEach(function (k) {
			s.tabPanels[k].hidden = k !== s.tab
		})
		renderActiveTab(s)
	}

	function renderActiveTab(s) {
		if (!s || s.closed) return
		if (s.tab === 'installed') renderInstalledTab(s)
		else if (s.tab === 'json') renderJsonTab(s)
		else if (s.tab === 'js') renderJsTab(s)
	}

	// ========== Tab 1：已装协议 ==========
	function buildInstalledTab(s) {
		const pane = mk('div', 'pm-pane pm-pane-installed')
		const bar = mk('div', 'pm-toolbar')
		const search = mk('input', 'form-control form-control-sm pm-search')
		search.type = 'text'
		search.placeholder = '搜索协议名称、ID 或描述…'
		search.setAttribute('autocomplete', 'off')
		search.setAttribute('spellcheck', 'false')
		search.setAttribute('aria-label', '搜索已装协议')
		search.addEventListener('input', function () {
			s.search = search.value
			renderInstalledTab(s)
		})
		const summary = mk('div', 'pm-summary')
		bar.appendChild(search)
		bar.appendChild(summary)
		const list = mk('div', 'pm-list')
		pane.appendChild(bar)
		pane.appendChild(list)
		s.installedSearch = search
		s.installedSummary = summary
		s.installedList = list
		return pane
	}

	function openCustomEditor(s, item) {
		if (item.source === 'json' || item.source === 'dir-json') {
			const jp = root.JsonProtocol
			const saved = jp && typeof jp.listSaved === 'function' ? jp.listSaved() : []
			const found = saved.find(function (x) { return x.id === item.id })
			if (found) selectJsonItem(s, found)
			switchTab(s, 'json')
			return
		}
		if (item.source === 'js-local' || item.source === 'js-dir') {
			const jsp = root.JsProtocolPlugin
			const plugins = jsp && typeof jsp.listPlugins === 'function' ? jsp.listPlugins() : []
			const found = plugins.find(function (p) {
				if (item.ownerPluginId && (p.pluginId === item.ownerPluginId || p.pluginKey === item.ownerPluginId)) return true
				return Array.isArray(p.registeredIds) && p.registeredIds.indexOf(item.id) >= 0
			})
			if (found) selectJsPlugin(s, found)
			switchTab(s, 'js')
		}
	}

	function renderInstalledTab(s) {
		if (!s || s.closed || !s.installedList) return
		const reg = root.ProtocolRegistry
		const all = reg && typeof reg.list === 'function' ? reg.list({ includeHidden: true }) : []
		const enabledCount = all.filter(function (item) { return !item.hidden }).length
		s.installedSummary.textContent = '已启用 ' + enabledCount + ' / 共 ' + all.length + ' 个'

		const kw = String(s.search || '').trim().toLowerCase()
		const filtered = kw ? all.filter(function (item) {
			const hay = [item.name || '', item.id || '', item.description || '', sourceLabel(item)].join(' ').toLowerCase()
			return hay.indexOf(kw) >= 0
		}) : all

		clearChildren(s.installedList)
		if (!filtered.length) {
			s.installedList.appendChild(mk('div', 'pm-empty', kw ? '未找到匹配的协议' : '暂无已注册协议'))
			return
		}

		const activeId = getActiveProtocolId()
		filtered.forEach(function (item) {
			const row = mk('div', 'pm-item' + (item.hidden ? ' is-hidden' : ''))
			row.dataset.protocolId = item.id

			const main = mk('div', 'pm-item-main')
			const head = mk('div', 'pm-item-head')
			head.appendChild(mk('span', 'pm-item-name', item.name || item.id))
			head.appendChild(mk('code', 'pm-id-badge', item.id))
			head.appendChild(mk('span', 'pm-badge ' + sourceBadgeClass(item), sourceLabel(item)))
			if (item.version) head.appendChild(mk('span', 'pm-badge pm-badge-muted', 'v' + item.version))

			const caps = item.capabilities || {}
			if (caps.parse) head.appendChild(mk('span', 'pm-cap', '解析'))
			if (caps.downlink) head.appendChild(mk('span', 'pm-cap', '下行'))
			if (caps.presets) head.appendChild(mk('span', 'pm-cap', '预设'))
			if (caps.customPanel) head.appendChild(mk('span', 'pm-cap', '面板'))
			main.appendChild(head)

			if (item.description) {
				main.appendChild(mk('div', 'pm-item-desc', item.description))
			}
			row.appendChild(main)

			const acts = mk('div', 'pm-item-acts')
			if (item.id === activeId) {
				acts.appendChild(mk('span', 'pm-badge pm-badge-active', '当前使用中'))
			} else {
				const useBtn = mk('button', 'btn btn-sm btn-outline-primary', '设为当前')
				useBtn.type = 'button'
				useBtn.addEventListener('click', function () {
					switchProtocol(item.id)
					setNotice(s, 'ok', '已切换到协议：' + (item.name || item.id))
					renderInstalledTab(s)
				})
				acts.appendChild(useBtn)
			}

			if (!item.builtin && (item.source === 'json' || item.source === 'dir-json' || item.source === 'js-local' || item.source === 'js-dir')) {
				const editBtn = mk('button', 'btn btn-sm btn-outline-secondary', '编辑')
				editBtn.type = 'button'
				editBtn.addEventListener('click', function () { openCustomEditor(s, item) })
				acts.appendChild(editBtn)
			}

			const swWrap = mk('div', 'form-check form-switch ctl-switch pm-switch')
			const swId = 'pm-vis-' + item.id
			const swInput = mk('input', 'form-check-input')
			swInput.type = 'checkbox'
			swInput.id = swId
			swInput.checked = !item.hidden
			const swLabel = mk('label', 'form-check-label', item.hidden ? '已隐藏' : '显示')
			swLabel.setAttribute('for', swId)
			swInput.addEventListener('change', function () {
				if (!reg || typeof reg.setHidden !== 'function') return
				const res = reg.setHidden(item.id, !swInput.checked)
				if (res && res.ok === false) {
					swInput.checked = !item.hidden
					setNotice(s, 'error', res.error || '至少需要保留一个可见协议')
					return
				}
				setNotice(s, 'info', swInput.checked ? '已显示协议：' + (item.name || item.id) : '已隐藏协议：' + (item.name || item.id))
				renderInstalledTab(s)
			})
			swWrap.appendChild(swInput)
			swWrap.appendChild(swLabel)
			acts.appendChild(swWrap)

			row.appendChild(acts)
			s.installedList.appendChild(row)
		})
	}

	// ========== Tab 2：JSON 协议 ==========
	function getJsonExamples() {
		const jp = root.JsonProtocol
		return jp && Array.isArray(jp.EXAMPLES) ? jp.EXAMPLES : []
	}

	function defaultJsonTemplate() {
		const examples = getJsonExamples()
		if (examples.length && examples[0] && examples[0].spec) return examples[0].spec
		return {
			schemaVersion: 1,
			id: 'custom-proto',
			name: '自定义协议',
			version: '1.0.0',
			description: '示例帧结构',
			framing: { head: 'AA 55', fixedLength: 8 },
			fields: [{ name: '命令码', offset: 2, length: 1, type: 'uint8', format: 'hex' }],
		}
	}

	function selectJsonItem(s, item) {
		s.jsonSelectedId = item.id
		s.jsonSource = item.source || 'json'
		s.jsonFileName = item.fileName || ''
		s.jsonText = item.spec ? JSON.stringify(item.spec, null, 2) : ''
		s.jsonValidation = item.error ? { ok: false, errors: [item.error] } : null
		s.jsonOverwriteConfirm = null
		if (s.jsonEditor) s.jsonEditor.value = s.jsonText
	}

	function startNewJson(s, exampleIndex) {
		const examples = getJsonExamples()
		const chosen = (exampleIndex >= 0 && examples[exampleIndex] && examples[exampleIndex].spec)
			? examples[exampleIndex].spec
			: defaultJsonTemplate()
		s.jsonSelectedId = null
		s.jsonSource = 'json'
		s.jsonFileName = ''
		s.jsonText = JSON.stringify(chosen, null, 2)
		s.jsonValidation = null
		s.jsonOverwriteConfirm = null
		if (s.jsonEditor) s.jsonEditor.value = s.jsonText
		renderJsonTab(s)
	}

	function parseAndValidateJson(rawText) {
		let parsed
		try {
			parsed = JSON.parse(String(rawText || ''))
		} catch (e) {
			return { ok: false, parsed: null, errors: ['JSON 语法错误：' + String((e && e.message) || e)] }
		}
		const jp = root.JsonProtocol
		if (!jp || typeof jp.validateSpec !== 'function') {
			return { ok: false, parsed: null, errors: ['JSON 协议引擎未加载'] }
		}
		const res = jp.validateSpec(parsed)
		return {
			ok: !!(res && res.ok),
			parsed: parsed,
			errors: Array.isArray(res && res.errors) ? res.errors : (res && res.ok ? [] : ['校验失败']),
		}
	}

	function doSaveJsonSpec(s, parsed) {
		const jp = root.JsonProtocol
		if (!jp || typeof jp.upsert !== 'function') {
			setNotice(s, 'error', 'JSON 协议引擎未加载')
			return
		}
		const res = jp.upsert(parsed)
		s.jsonOverwriteConfirm = null
		if (res && res.ok) {
			s.jsonSelectedId = res.id || parsed.id
			s.jsonSource = 'json'
			s.jsonValidation = { ok: true, errors: [] }
			setNotice(s, 'ok', '已保存并启用 JSON 协议：' + s.jsonSelectedId)
			renderJsonTab(s)
		} else {
			const errs = Array.isArray(res && res.errors) && res.errors.length ? res.errors : ['保存失败']
			s.jsonValidation = { ok: false, errors: errs }
			setNotice(s, 'error', errs[0])
			renderJsonEditorMeta(s)
		}
	}

	function buildJsonTab(s) {
		const pane = mk('div', 'pm-pane pm-pane-json')
		const bar = mk('div', 'pm-toolbar')

		const examples = getJsonExamples()
		const tplSelect = mk('select', 'form-select form-select-sm pm-tpl-select')
		tplSelect.setAttribute('aria-label', '选择 JSON 协议示例模板')
		if (examples.length) {
			examples.forEach(function (ex, idx) {
				const opt = mk('option', '', ex.label || ex.id || ('模板 ' + (idx + 1)))
				opt.value = String(idx)
				tplSelect.appendChild(opt)
			})
		} else {
			const opt = mk('option', '', '空白示例模板')
			opt.value = '0'
			tplSelect.appendChild(opt)
		}

		const newBtn = mk('button', 'btn btn-sm btn-outline-primary', '新建协议')
		newBtn.type = 'button'
		newBtn.addEventListener('click', function () {
			const idx = parseInt(tplSelect.value, 10)
			startNewJson(s, isNaN(idx) ? 0 : idx)
			setNotice(s, 'info', '已填充 JSON 示例模板，请修改后保存')
		})

		const importInput = mk('input', 'pm-hidden-file')
		importInput.type = 'file'
		importInput.accept = '.json,application/json'
		importInput.hidden = true
		importInput.addEventListener('change', function () {
			const file = importInput.files && importInput.files[0]
			importInput.value = ''
			if (!file) return
			readFileText(file).then(function (text) {
				if (s.closed) return
				const jp = root.JsonProtocol
				if (!jp || typeof jp.importJson !== 'function') {
					setNotice(s, 'error', 'JSON 协议引擎未加载')
					return
				}
				const res = jp.importJson(text)
				if (res && res.ok) {
					const count = Array.isArray(res.imported) ? res.imported.length : 0
					setNotice(s, 'ok', '已导入 ' + count + ' 个 JSON 协议' + (count ? '：' + res.imported.join('、') : ''))
					if (count) {
						const saved = typeof jp.listSaved === 'function' ? jp.listSaved() : []
						const first = saved.find(function (x) { return x.id === res.imported[0] })
						if (first) selectJsonItem(s, first)
					}
					renderJsonTab(s)
				} else {
					const errs = Array.isArray(res && res.errors) && res.errors.length ? res.errors : ['导入失败']
					s.jsonValidation = { ok: false, errors: errs }
					setNotice(s, 'error', '导入失败：' + errs[0])
					renderJsonEditorMeta(s)
				}
			}, function (err) {
				if (!s.closed) setNotice(s, 'error', String((err && err.message) || err))
			})
		})

		const importBtn = mk('button', 'btn btn-sm btn-outline-secondary', '导入 JSON 文件…')
		importBtn.type = 'button'
		importBtn.addEventListener('click', function () { importInput.click() })

		const exportAllBtn = mk('button', 'btn btn-sm btn-outline-secondary', '导出全部 JSON')
		exportAllBtn.type = 'button'
		exportAllBtn.addEventListener('click', function () {
			const jp = root.JsonProtocol
			if (!jp || typeof jp.exportJson !== 'function') return
			const text = jp.exportJson()
			triggerDownload('custom-protocols.json', text)
			setNotice(s, 'ok', '已导出全部自定义 JSON 协议')
		})

		bar.appendChild(newBtn)
		bar.appendChild(tplSelect)
		bar.appendChild(importBtn)
		bar.appendChild(exportAllBtn)
		bar.appendChild(importInput)
		pane.appendChild(bar)

		const layout = mk('div', 'pm-split')
		const listCol = mk('div', 'pm-list pm-saved-list')
		const editorCol = mk('div', 'pm-editor-card')

		const editorHead = mk('div', 'pm-editor-head')
		const editorTitle = mk('div', 'pm-editor-title', '新建 JSON 协议')
		const editorReadonlyTag = mk('span', 'pm-badge pm-badge-muted', '来自本地插件目录 · 只读')
		editorReadonlyTag.hidden = true
		editorHead.appendChild(editorTitle)
		editorHead.appendChild(editorReadonlyTag)

		const textarea = mk('textarea', 'form-control form-control-sm pm-code-editor')
		textarea.rows = 12
		textarea.setAttribute('spellcheck', 'false')
		textarea.setAttribute('aria-label', 'JSON 协议定义')
		textarea.placeholder = '在此输入或编辑 JSON 协议定义（schemaVersion: 1）…'
		textarea.addEventListener('input', function () {
			s.jsonText = textarea.value
			if (s.jsonOverwriteConfirm) {
				s.jsonOverwriteConfirm = null
				renderJsonEditorMeta(s)
			}
		})

		const validateBox = mk('div', 'pm-validate-box')
		validateBox.hidden = true
		const overwriteBox = mk('div', 'pm-confirm-bar')
		overwriteBox.hidden = true

		const editorActs = mk('div', 'pm-editor-acts')
		const validateBtn = mk('button', 'btn btn-sm btn-outline-secondary', '校验格式')
		validateBtn.type = 'button'
		validateBtn.addEventListener('click', function () {
			const check = parseAndValidateJson(s.jsonText)
			s.jsonValidation = { ok: check.ok, errors: check.errors }
			renderJsonEditorMeta(s)
		})

		const saveBtn = mk('button', 'btn btn-sm btn-primary', '保存并启用')
		saveBtn.type = 'button'
		saveBtn.addEventListener('click', function () {
			if (s.jsonSource === 'dir-json') return
			const check = parseAndValidateJson(s.jsonText)
			s.jsonValidation = { ok: check.ok, errors: check.errors }
			if (!check.ok) {
				setNotice(s, 'error', check.errors[0] || 'JSON 协议校验未通过')
				renderJsonEditorMeta(s)
				return
			}
			const jp = root.JsonProtocol
			const saved = jp && typeof jp.listSaved === 'function' ? jp.listSaved() : []
			const collision = saved.find(function (x) { return x.source === 'json' && x.id === check.parsed.id })
			if (collision && s.jsonSelectedId !== check.parsed.id) {
				s.jsonOverwriteConfirm = { id: check.parsed.id, spec: check.parsed }
				renderJsonEditorMeta(s)
				return
			}
			doSaveJsonSpec(s, check.parsed)
		})

		editorActs.appendChild(validateBtn)
		editorActs.appendChild(saveBtn)

		editorCol.appendChild(editorHead)
		editorCol.appendChild(textarea)
		editorCol.appendChild(validateBox)
		editorCol.appendChild(overwriteBox)
		editorCol.appendChild(editorActs)

		layout.appendChild(listCol)
		layout.appendChild(editorCol)
		pane.appendChild(layout)

		s.jsonList = listCol
		s.jsonEditor = textarea
		s.jsonEditorTitle = editorTitle
		s.jsonReadonlyTag = editorReadonlyTag
		s.jsonValidateBox = validateBox
		s.jsonOverwriteBox = overwriteBox
		s.jsonSaveBtn = saveBtn
		s.jsonImportInput = importInput

		return pane
	}

	function renderJsonEditorMeta(s) {
		if (!s || s.closed) return
		const isDir = s.jsonSource === 'dir-json'
		s.jsonEditorTitle.textContent = s.jsonSelectedId
			? (isDir ? '查看目录协议：' + s.jsonSelectedId : '编辑 JSON 协议：' + s.jsonSelectedId)
			: '新建 JSON 协议'
		s.jsonReadonlyTag.hidden = !isDir
		s.jsonEditor.readOnly = isDir
		s.jsonSaveBtn.disabled = isDir

		clearChildren(s.jsonValidateBox)
		if (!s.jsonValidation) {
			s.jsonValidateBox.hidden = true
			s.jsonValidateBox.className = 'pm-validate-box'
		} else if (s.jsonValidation.ok) {
			s.jsonValidateBox.hidden = false
			s.jsonValidateBox.className = 'pm-validate-box is-ok'
			s.jsonValidateBox.appendChild(mk('div', '', '校验通过'))
		} else {
			s.jsonValidateBox.hidden = false
			s.jsonValidateBox.className = 'pm-validate-box is-error'
			const ul = mk('ul', 'pm-error-list')
			s.jsonValidation.errors.forEach(function (err) {
				ul.appendChild(mk('li', '', err))
			})
			s.jsonValidateBox.appendChild(ul)
		}

		clearChildren(s.jsonOverwriteBox)
		if (s.jsonOverwriteConfirm) {
			s.jsonOverwriteBox.hidden = false
			s.jsonOverwriteBox.appendChild(mk('div', 'pm-confirm-text', '已存在同名 JSON 协议「' + s.jsonOverwriteConfirm.id + '」，确认覆盖并启用新定义？'))
			const acts = mk('div', 'pm-confirm-acts')
			const confirmBtn = mk('button', 'btn btn-sm btn-danger', '确认覆盖')
			confirmBtn.type = 'button'
			confirmBtn.addEventListener('click', function () {
				const pending = s.jsonOverwriteConfirm
				if (pending) doSaveJsonSpec(s, pending.spec)
			})
			const cancelBtn = mk('button', 'btn btn-sm btn-outline-secondary', '取消')
			cancelBtn.type = 'button'
			cancelBtn.addEventListener('click', function () {
				s.jsonOverwriteConfirm = null
				renderJsonEditorMeta(s)
			})
			acts.appendChild(confirmBtn)
			acts.appendChild(cancelBtn)
			s.jsonOverwriteBox.appendChild(acts)
		} else {
			s.jsonOverwriteBox.hidden = true
		}
	}

	function renderJsonTab(s) {
		if (!s || s.closed || !s.jsonList) return
		const jp = root.JsonProtocol
		const saved = jp && typeof jp.listSaved === 'function' ? jp.listSaved() : []
		clearChildren(s.jsonList)

		if (!saved.length) {
			s.jsonList.appendChild(mk('div', 'pm-empty', '尚未保存自定义 JSON 协议，可点击「新建协议」或「导入 JSON 文件…」'))
		} else {
			saved.forEach(function (item) {
				const selected = s.jsonSelectedId === item.id && s.jsonSource === (item.source || 'json')
				const row = mk('div', 'pm-item pm-item-compact' + (selected ? ' is-selected' : ''))
				row.dataset.jsonId = item.id

				const main = mk('div', 'pm-item-main')
				const head = mk('div', 'pm-item-head')
				const pickBtn = mk('button', 'pm-link-btn', item.name || item.id)
				pickBtn.type = 'button'
				pickBtn.addEventListener('click', function () {
					selectJsonItem(s, item)
					renderJsonTab(s)
				})
				head.appendChild(pickBtn)
				head.appendChild(mk('code', 'pm-id-badge', item.id))
				head.appendChild(mk('span', 'pm-badge ' + (item.source === 'dir-json' ? 'pm-badge-muted' : 'pm-badge-json'), item.source === 'dir-json' ? '目录 JSON' : 'JSON'))
				main.appendChild(head)
				if (item.description) main.appendChild(mk('div', 'pm-item-desc', item.description))
				if (item.error) main.appendChild(mk('div', 'pm-item-err', item.error))
				row.appendChild(main)

				const acts = mk('div', 'pm-item-acts')
				const expBtn = mk('button', 'btn btn-sm btn-outline-secondary', '导出')
				expBtn.type = 'button'
				expBtn.addEventListener('click', function () {
					if (!jp || typeof jp.exportJson !== 'function') return
					triggerDownload((item.id || 'protocol') + '.json', jp.exportJson(item.id))
					setNotice(s, 'ok', '已导出协议：' + item.id)
				})
				acts.appendChild(expBtn)

				if (item.source === 'dir-json') {
					acts.appendChild(mk('span', 'pm-dir-readonly-hint', '来自本地插件目录'))
				} else {
					const armed = !!(s.jsonDeleteArmed && s.jsonDeleteArmed.id === item.id)
					if (armed) {
						const confirmDel = mk('button', 'btn btn-sm btn-danger', '确认删除')
						confirmDel.type = 'button'
						confirmDel.addEventListener('click', function () {
							clearJsonDeleteArm(s)
							const res = jp && typeof jp.remove === 'function' ? jp.remove(item.id) : { ok: false, error: '无法删除' }
							if (res && res.ok) {
								if (s.jsonSelectedId === item.id) {
									s.jsonSelectedId = null
									s.jsonText = ''
									if (s.jsonEditor) s.jsonEditor.value = ''
								}
								setNotice(s, 'ok', '已删除 JSON 协议：' + item.id)
								renderJsonTab(s)
							} else {
								setNotice(s, 'error', (res && res.error) || '删除失败')
								renderJsonTab(s)
							}
						})
						const cancelDel = mk('button', 'btn btn-sm btn-outline-secondary', '取消')
						cancelDel.type = 'button'
						cancelDel.addEventListener('click', function () {
							clearJsonDeleteArm(s)
							renderJsonTab(s)
						})
						acts.appendChild(confirmDel)
						acts.appendChild(cancelDel)
					} else {
						const delBtn = mk('button', 'btn btn-sm btn-outline-danger', '删除')
						delBtn.type = 'button'
						delBtn.addEventListener('click', function () {
							clearJsonDeleteArm(s)
							const timer = setTimeout(function () {
								if (s.closed) return
								s.jsonDeleteArmed = null
								renderJsonTab(s)
							}, ARMED_TIMEOUT_MS)
							s.jsonDeleteArmed = { id: item.id, timer: timer }
							renderJsonTab(s)
						})
						acts.appendChild(delBtn)
					}
				}

				row.appendChild(acts)
				s.jsonList.appendChild(row)
			})
		}

		renderJsonEditorMeta(s)
	}

	// ========== Tab 3：JS 插件 ==========
	function selectJsPlugin(s, plugin) {
		s.jsEditingNew = false
		s.jsSelectedKey = plugin.pluginKey
		s.jsSelectedSource = plugin.source || 'js-local'
		s.jsSelectedId = plugin.pluginId || ''
		s.jsName = plugin.name || ''
		s.jsFileName = plugin.fileName || ''
		s.jsCode = plugin.code || ''
		if (s.jsNameInput) s.jsNameInput.value = s.jsName
		if (s.jsFileNameInput) s.jsFileNameInput.value = s.jsFileName
		if (s.jsCodeEditor) s.jsCodeEditor.value = s.jsCode
	}

	function buildJsTab(s) {
		const pane = mk('div', 'pm-pane pm-pane-js')

		// 顶部固定安全风险提示条
		const warnBanner = mk('div', 'pm-security-banner')
		warnBanner.setAttribute('role', 'note')
		warnBanner.appendChild(mk('i', 'bi bi-shield-exclamation pm-security-icon'))
		warnBanner.appendChild(mk('div', 'pm-security-text', SECURITY_WARNING))
		pane.appendChild(warnBanner)

		// 桌面端本地插件目录栏（仅 hasDesktopDir() 为真时显示）
		const dirBar = mk('div', 'pm-dir-bar')
		dirBar.hidden = true
		const dirInfo = mk('div', 'pm-dir-info')
		dirInfo.appendChild(mk('span', 'pm-dir-label', '本地插件目录'))
		const dirPath = mk('code', 'pm-dir-path', '应用数据目录 / protocols')
		dirInfo.appendChild(dirPath)
		const dirActs = mk('div', 'pm-dir-acts')
		const openDirBtn = mk('button', 'btn btn-sm btn-outline-secondary', '打开插件目录')
		openDirBtn.type = 'button'
		openDirBtn.addEventListener('click', function () {
			const jsp = root.JsProtocolPlugin
			if (!jsp || typeof jsp.openDesktopDir !== 'function') return
			Promise.resolve(jsp.openDesktopDir()).then(function (res) {
				if (s.closed) return
				if (res && res.dir) s.jsDirPath = res.dir
				if (res && res.ok === false) setNotice(s, 'error', res.error || '无法打开插件目录')
				else setNotice(s, 'ok', '已打开本地插件目录')
				renderJsDirBar(s)
			}, function (err) {
				if (!s.closed) setNotice(s, 'error', String((err && err.message) || err))
			})
		})
		const scanDirBtn = mk('button', 'btn btn-sm btn-outline-primary', '重新扫描')
		scanDirBtn.type = 'button'
		scanDirBtn.addEventListener('click', function () {
			const jsp = root.JsProtocolPlugin
			if (!jsp || typeof jsp.scanDesktopDir !== 'function' || s.jsScanning) return
			s.jsScanning = true
			renderJsDirBar(s)
			Promise.resolve(jsp.scanDesktopDir()).then(function (res) {
				if (s.closed) return
				s.jsScanning = false
				if (res && res.dir) s.jsDirPath = res.dir
				s.jsDirTruncated = !!(res && res.truncated)
				if (res && res.supported === false) {
					setNotice(s, 'warn', '当前环境不支持本地插件目录扫描')
				} else if (res) {
					const msg = '扫描完成：JSON ' + (res.jsonCount || 0) + ' 个，JS ' + (res.jsCount || 0) + ' 个' +
						(res.untrustedCount ? '，待确认信任 ' + res.untrustedCount + ' 个' : '') +
						(res.truncated ? '（目录文件超过 64 个上限，仅加载前 64 个）' : '')
					setNotice(s, (res.errors && res.errors.length) || res.truncated ? 'warn' : 'ok', msg)
				}
				renderJsTab(s)
			}, function (err) {
				if (s.closed) return
				s.jsScanning = false
				setNotice(s, 'error', '扫描失败：' + String((err && err.message) || err))
				renderJsDirBar(s)
			})
		})
		dirActs.appendChild(openDirBtn)
		dirActs.appendChild(scanDirBtn)
		dirBar.appendChild(dirInfo)
		dirBar.appendChild(dirActs)
		pane.appendChild(dirBar)

		// 工具条
		const bar = mk('div', 'pm-toolbar')
		const newBtn = mk('button', 'btn btn-sm btn-outline-primary', '新建示例插件')
		newBtn.type = 'button'
		newBtn.addEventListener('click', function () {
			const jsp = root.JsProtocolPlugin
			s.jsEditingNew = true
			s.jsSelectedKey = null
			s.jsSelectedSource = 'js-local'
			s.jsSelectedId = ''
			s.jsName = '示例 JS 插件'
			s.jsFileName = 'example-plugin.js'
			s.jsCode = (jsp && typeof jsp.EXAMPLE_CODE === 'string' && jsp.EXAMPLE_CODE)
				? jsp.EXAMPLE_CODE
				: 'registerProtocol(\'example-js\', {\n\tname: \'示例 JS 协议\',\n\tfindFrame() { return null },\n\tparseFrame() { return null },\n})\n'
			s.jsNameInput.value = s.jsName
			s.jsFileNameInput.value = s.jsFileName
			s.jsCodeEditor.value = s.jsCode
			renderJsEditor(s)
			setNotice(s, 'info', '已填入示例插件源码；保存后需显式确认信任才会执行')
		})

		const importInput = mk('input', 'pm-hidden-file')
		importInput.type = 'file'
		importInput.accept = '.js,text/javascript'
		importInput.hidden = true
		importInput.addEventListener('change', function () {
			const file = importInput.files && importInput.files[0]
			importInput.value = ''
			if (!file) return
			readFileText(file).then(function (text) {
				if (s.closed) return
				const jsp = root.JsProtocolPlugin
				if (!jsp || typeof jsp.saveLocalPlugin !== 'function') {
					setNotice(s, 'error', 'JS 插件引擎未加载')
					return
				}
				const fileName = file.name || 'custom-plugin.js'
				const baseName = fileName.replace(/\.js$/i, '') || '自定义插件'
				const res = jsp.saveLocalPlugin({ name: baseName, fileName: fileName, code: text })
				if (res && res.ok) {
					setNotice(s, 'warn', '已导入插件「' + baseName + '」（默认处于待确认安全风险状态，未执行），请在列表中确认信任后启用')
					const plugins = typeof jsp.listPlugins === 'function' ? jsp.listPlugins() : []
					const created = plugins.find(function (p) { return p.pluginKey === res.pluginKey || p.pluginId === res.pluginId })
					if (created) selectJsPlugin(s, created)
					renderJsTab(s)
				} else {
					setNotice(s, 'error', (res && res.error) || '导入 JS 插件失败')
				}
			}, function (err) {
				if (!s.closed) setNotice(s, 'error', String((err && err.message) || err))
			})
		})

		const importBtn = mk('button', 'btn btn-sm btn-outline-secondary', '导入 .js 插件…')
		importBtn.type = 'button'
		importBtn.addEventListener('click', function () { importInput.click() })

		bar.appendChild(newBtn)
		bar.appendChild(importBtn)
		bar.appendChild(importInput)
		pane.appendChild(bar)

		const list = mk('div', 'pm-list')
		pane.appendChild(list)

		// 源码查看/编辑区
		const editorCard = mk('div', 'pm-editor-card')
		editorCard.hidden = true
		const editorHead = mk('div', 'pm-editor-head')
		const editorTitle = mk('div', 'pm-editor-title', '插件源码')
		const closeEditorBtn = mk('button', 'btn btn-sm btn-outline-secondary', '收起')
		closeEditorBtn.type = 'button'
		closeEditorBtn.addEventListener('click', function () {
			s.jsEditingNew = false
			s.jsSelectedKey = null
			renderJsEditor(s)
		})
		editorHead.appendChild(editorTitle)
		editorHead.appendChild(closeEditorBtn)

		const metaRow = mk('div', 'pm-js-meta-row')
		const nameInput = mk('input', 'form-control form-control-sm')
		nameInput.type = 'text'
		nameInput.placeholder = '插件名称'
		nameInput.setAttribute('aria-label', '插件名称')
		nameInput.addEventListener('input', function () { s.jsName = nameInput.value })
		const fileInput = mk('input', 'form-control form-control-sm')
		fileInput.type = 'text'
		fileInput.placeholder = '文件名（如 my-proto.js）'
		fileInput.setAttribute('aria-label', '插件文件名')
		fileInput.addEventListener('input', function () { s.jsFileName = fileInput.value })
		metaRow.appendChild(nameInput)
		metaRow.appendChild(fileInput)

		const codeEditor = mk('textarea', 'form-control form-control-sm pm-code-editor')
		codeEditor.rows = 10
		codeEditor.setAttribute('spellcheck', 'false')
		codeEditor.setAttribute('aria-label', 'JS 插件源码')
		codeEditor.addEventListener('input', function () { s.jsCode = codeEditor.value })

		const editorActs = mk('div', 'pm-editor-acts')
		const saveBtn = mk('button', 'btn btn-sm btn-primary', '保存源码')
		saveBtn.type = 'button'
		saveBtn.addEventListener('click', function () {
			if (s.jsSelectedSource === 'js-dir') return
			const jsp = root.JsProtocolPlugin
			if (!jsp || typeof jsp.saveLocalPlugin !== 'function') {
				setNotice(s, 'error', 'JS 插件引擎未加载')
				return
			}
			const payload = {
				name: String(s.jsName || '').trim() || '未命名插件',
				fileName: String(s.jsFileName || '').trim() || 'custom-plugin.js',
				code: String(s.jsCode || ''),
			}
			if (!s.jsEditingNew && s.jsSelectedId) payload.pluginId = s.jsSelectedId
			const res = jsp.saveLocalPlugin(payload)
			if (res && res.ok) {
				s.jsEditingNew = false
				s.jsSelectedKey = res.pluginKey || s.jsSelectedKey
				s.jsSelectedId = res.pluginId || s.jsSelectedId
				s.jsSelectedSource = 'js-local'
				setNotice(s, res.needsTrust ? 'warn' : 'ok', res.needsTrust
					? '源码已保存；内容变化后处于待确认安全风险状态，请确认信任后启用'
					: '源码已保存')
				renderJsTab(s)
			} else {
				setNotice(s, 'error', (res && res.error) || '保存插件源码失败')
			}
		})
		editorActs.appendChild(saveBtn)

		editorCard.appendChild(editorHead)
		editorCard.appendChild(metaRow)
		editorCard.appendChild(codeEditor)
		editorCard.appendChild(editorActs)
		pane.appendChild(editorCard)

		s.jsDirBar = dirBar
		s.jsDirPathEl = dirPath
		s.jsScanDirBtn = scanDirBtn
		s.jsList = list
		s.jsEditorCard = editorCard
		s.jsEditorTitle = editorTitle
		s.jsNameInput = nameInput
		s.jsFileNameInput = fileInput
		s.jsCodeEditor = codeEditor
		s.jsSaveBtn = saveBtn
		s.jsImportInput = importInput

		return pane
	}

	function renderJsDirBar(s) {
		if (!s || !s.jsDirBar) return
		const jsp = root.JsProtocolPlugin
		const hasDir = !!(jsp && typeof jsp.hasDesktopDir === 'function' && jsp.hasDesktopDir())
		s.jsDirBar.hidden = !hasDir
		if (!hasDir) return
		s.jsDirPathEl.textContent = (s.jsDirPath || '应用数据目录 / protocols') + (s.jsDirTruncated ? '（已达 64 文件上限，部分未加载）' : '')
		s.jsScanDirBtn.disabled = !!s.jsScanning
		s.jsScanDirBtn.textContent = s.jsScanning ? '扫描中…' : '重新扫描'
	}

	function renderJsEditor(s) {
		if (!s || !s.jsEditorCard) return
		const open = !!(s.jsEditingNew || s.jsSelectedKey)
		s.jsEditorCard.hidden = !open
		if (!open) return
		const isDir = !s.jsEditingNew && s.jsSelectedSource === 'js-dir'
		s.jsEditorTitle.textContent = s.jsEditingNew
			? '新建本地 JS 插件'
			: (isDir ? '查看桌面目录插件源码（只读）：' + (s.jsFileName || s.jsName) : '编辑本地 JS 插件：' + (s.jsName || s.jsFileName))
		s.jsNameInput.readOnly = isDir
		s.jsFileNameInput.readOnly = isDir
		s.jsCodeEditor.readOnly = isDir
		s.jsSaveBtn.hidden = isDir
	}

	function renderJsTab(s) {
		if (!s || s.closed || !s.jsList) return
		renderJsDirBar(s)
		const jsp = root.JsProtocolPlugin
		const plugins = jsp && typeof jsp.listPlugins === 'function' ? jsp.listPlugins() : []
		clearChildren(s.jsList)

		if (!plugins.length) {
			s.jsList.appendChild(mk('div', 'pm-empty', '尚未导入外部 JS 插件'))
		} else {
			plugins.forEach(function (p) {
				const card = mk('div', 'pm-item pm-js-card')
				card.dataset.pluginKey = p.pluginKey

				const top = mk('div', 'pm-js-top')
				const main = mk('div', 'pm-item-main')
				const head = mk('div', 'pm-item-head')
				head.appendChild(mk('span', 'pm-item-name', p.name || p.fileName || p.pluginId))
				if (p.fileName) head.appendChild(mk('code', 'pm-id-badge', p.fileName))
				head.appendChild(mk('span', 'pm-badge ' + (p.source === 'js-dir' ? 'pm-badge-muted' : 'pm-badge-js'), p.source === 'js-dir' ? '桌面目录' : 'Web 本地'))

				if (p.error) {
					head.appendChild(mk('span', 'pm-badge pm-badge-danger', '执行出错'))
				} else if (!p.trusted) {
					head.appendChild(mk('span', 'pm-badge pm-badge-warn', '⚠ 待确认安全风险'))
				} else if (p.enabled) {
					const ids = Array.isArray(p.registeredIds) && p.registeredIds.length ? p.registeredIds.join(', ') : '无注册协议'
					head.appendChild(mk('span', 'pm-badge pm-badge-ok', '已信任 · 已注册: ' + ids))
				} else {
					head.appendChild(mk('span', 'pm-badge pm-badge-muted', '已信任 · 已停用'))
				}
				main.appendChild(head)

				if (p.error) {
					main.appendChild(mk('div', 'pm-item-err', p.error))
				}
				top.appendChild(main)

				const acts = mk('div', 'pm-item-acts')
				if (!p.trusted) {
					const trustBtn = mk('button', 'btn btn-sm btn-warning', '信任并启用…')
					trustBtn.type = 'button'
					trustBtn.addEventListener('click', function () {
						s.jsTrustConfirmKey = p.pluginKey
						renderJsTab(s)
					})
					acts.appendChild(trustBtn)
				} else {
					const swWrap = mk('div', 'form-check form-switch ctl-switch pm-switch')
					const swId = 'pm-js-en-' + p.pluginKey.replace(/[^a-zA-Z0-9_-]/g, '_')
					const swInput = mk('input', 'form-check-input')
					swInput.type = 'checkbox'
					swInput.id = swId
					swInput.checked = !!p.enabled
					const swLabel = mk('label', 'form-check-label', p.enabled ? '已启用' : '已停用')
					swLabel.setAttribute('for', swId)
					swInput.addEventListener('change', function () {
						if (!jsp || typeof jsp.setEnabled !== 'function') return
						const res = jsp.setEnabled(p.pluginKey, swInput.checked)
						if (res && res.needsTrust) {
							swInput.checked = false
							s.jsTrustConfirmKey = p.pluginKey
							setNotice(s, 'warn', '插件内容已变更，需重新确认安全风险后启用')
							renderJsTab(s)
							return
						}
						if (res && res.ok === false) {
							swInput.checked = !!p.enabled
							setNotice(s, 'error', res.error || '切换插件状态失败')
							return
						}
						setNotice(s, 'ok', swInput.checked ? '已启用插件：' + (p.name || p.fileName) : '已停用插件：' + (p.name || p.fileName))
						renderJsTab(s)
					})
					swWrap.appendChild(swInput)
					swWrap.appendChild(swLabel)
					acts.appendChild(swWrap)
				}

				const viewBtn = mk('button', 'btn btn-sm btn-outline-secondary', p.source === 'js-dir' ? '查看源码' : '编辑源码')
				viewBtn.type = 'button'
				viewBtn.addEventListener('click', function () {
					selectJsPlugin(s, p)
					renderJsEditor(s)
				})
				acts.appendChild(viewBtn)

				if (p.source === 'js-local') {
					const armed = !!(s.jsDeleteArmed && s.jsDeleteArmed.key === p.pluginKey)
					if (armed) {
						const confirmDel = mk('button', 'btn btn-sm btn-danger', '确认删除')
						confirmDel.type = 'button'
						confirmDel.addEventListener('click', function () {
							clearJsDeleteArm(s)
							const res = jsp && typeof jsp.removeLocalPlugin === 'function' ? jsp.removeLocalPlugin(p.pluginKey) : { ok: false, error: '删除失败' }
							if (res && res.ok) {
								if (s.jsSelectedKey === p.pluginKey) {
									s.jsSelectedKey = null
									s.jsEditingNew = false
								}
								if (s.jsTrustConfirmKey === p.pluginKey) s.jsTrustConfirmKey = null
								setNotice(s, 'ok', '已删除 JS 插件：' + (p.name || p.fileName))
								renderJsTab(s)
							} else {
								setNotice(s, 'error', (res && res.error) || '删除失败')
								renderJsTab(s)
							}
						})
						const cancelDel = mk('button', 'btn btn-sm btn-outline-secondary', '取消')
						cancelDel.type = 'button'
						cancelDel.addEventListener('click', function () {
							clearJsDeleteArm(s)
							renderJsTab(s)
						})
						acts.appendChild(confirmDel)
						acts.appendChild(cancelDel)
					} else {
						const delBtn = mk('button', 'btn btn-sm btn-outline-danger', '删除')
						delBtn.type = 'button'
						delBtn.addEventListener('click', function () {
							clearJsDeleteArm(s)
							const timer = setTimeout(function () {
								if (s.closed) return
								s.jsDeleteArmed = null
								renderJsTab(s)
							}, ARMED_TIMEOUT_MS)
							s.jsDeleteArmed = { key: p.pluginKey, timer: timer }
							renderJsTab(s)
						})
						acts.appendChild(delBtn)
					}
				}

				top.appendChild(acts)
				card.appendChild(top)

				// 面板内联风险确认条带（不嵌套 AppDialog.confirm；绑定当前展示的哈希防 TOCTOU）
				if (s.jsTrustConfirmKey === p.pluginKey) {
					const confirmedHash = p.hash
					const confirmBar = mk('div', 'pm-confirm-bar pm-trust-confirm')
					const msg = '确认执行该 JS 插件代码？插件「' + (p.name || p.fileName || p.pluginId) + '」拥有与本页面相同的全部权限（包括串口收发、读取本地存储中的密钥与配置、操作页面 DOM），请仅信任你亲自审阅过的代码。' +
						(confirmedHash ? '（指纹：' + String(confirmedHash).slice(0, 16) + '）' : '')
					confirmBar.appendChild(mk('div', 'pm-confirm-text', msg))
					const cActs = mk('div', 'pm-confirm-acts')
					const trustConfirmBtn = mk('button', 'btn btn-sm btn-danger', '我已知晓风险，信任并启用')
					trustConfirmBtn.type = 'button'
					trustConfirmBtn.addEventListener('click', function () {
						if (!jsp || typeof jsp.trustAndEnable !== 'function') return
						const res = jsp.trustAndEnable(p.pluginKey, confirmedHash)
						s.jsTrustConfirmKey = null
						if (res && res.ok) {
							const ids = Array.isArray(res.registeredIds) && res.registeredIds.length ? '（已注册：' + res.registeredIds.join(', ') + '）' : ''
							setNotice(s, 'ok', '已信任并启用插件「' + (p.name || p.fileName) + '」' + ids)
						} else {
							setNotice(s, 'error', (res && res.error) || '启用插件失败')
						}
						renderJsTab(s)
					})
					const cancelTrustBtn = mk('button', 'btn btn-sm btn-outline-secondary', '取消')
					cancelTrustBtn.type = 'button'
					cancelTrustBtn.addEventListener('click', function () {
						s.jsTrustConfirmKey = null
						renderJsTab(s)
					})
					cActs.appendChild(trustConfirmBtn)
					cActs.appendChild(cancelTrustBtn)
					confirmBar.appendChild(cActs)
					card.appendChild(confirmBar)
				}

				s.jsList.appendChild(card)
			})
		}

		renderJsEditor(s)
	}

	// ========== 面板主构建 ==========
	function buildPanel(body, s) {
		body.classList.toggle('pm-panel', true)

		const topBar = mk('div', 'pm-topbar')
		const seg = mk('div', 'ctl-seg pm-tabs')
		seg.setAttribute('role', 'group')
		seg.setAttribute('aria-label', '协议管理分页')
		s.tabButtons = TABS.map(function (t) {
			const btn = mk('button', '', t.label)
			btn.type = 'button'
			btn.dataset.tab = t.id
			btn.setAttribute('aria-pressed', t.id === s.tab ? 'true' : 'false')
			btn.classList.toggle('active', t.id === s.tab)
			btn.addEventListener('click', function () { switchTab(s, t.id) })
			seg.appendChild(btn)
			return btn
		})
		topBar.appendChild(seg)

		// 一键复制 AI 协议/插件开发提示词
		const promptWrap = mk('div', 'pm-prompt-actions')
		const promptLabel = mk('span', 'pm-prompt-label', '复制开发提示词:')
		promptWrap.appendChild(promptLabel)
		;[
			{ kind: 'json', label: 'JSON 协议', title: '复制声明式 JSON 协议开发提示词（贴给 AI + 协议文档即可生成）' },
			{ kind: 'js', label: 'JS 插件', title: '复制 JS 协议插件开发提示词（贴给 AI + 协议文档即可生成）' },
			{ kind: 'all', label: '完整规范', title: '复制包含选型指南、JSON Schema 与 JS 插件契约的完整提示词' },
		].forEach(function (item) {
			const b = mk('button', 'btn btn-sm btn-outline-secondary pm-prompt-btn')
			b.type = 'button'
			b.dataset.promptKind = item.kind
			b.title = item.title
			const ic = mk('i', 'bi bi-clipboard-check')
			ic.setAttribute('aria-hidden', 'true')
			b.appendChild(ic)
			b.appendChild(mk('span', '', item.label))
			b.addEventListener('click', function () {
				const text = buildDevPrompt(item.kind)
				copyText(text).then(function (ok) {
					if (s.closed) return
					if (ok) {
						setNotice(s, 'ok', '已复制「' + item.label + '开发提示词」（' + text.length + ' 字），可直接粘贴给 AI 并附上协议文档生成适配插件')
					} else {
						setNotice(s, 'error', '复制失败：当前环境不允许访问剪贴板')
					}
				})
			})
			promptWrap.appendChild(b)
		})
		topBar.appendChild(promptWrap)
		body.appendChild(topBar)

		const noticeEl = mk('div', 'pm-notice')
		noticeEl.hidden = true
		body.appendChild(noticeEl)
		s.noticeEl = noticeEl

		const installedPane = buildInstalledTab(s)
		const jsonPane = buildJsonTab(s)
		const jsPane = buildJsTab(s)
		s.tabPanels = {
			installed: installedPane,
			json: jsonPane,
			js: jsPane,
		}
		body.appendChild(installedPane)
		body.appendChild(jsonPane)
		body.appendChild(jsPane)

		switchTab(s, s.tab)
	}

	function open(initialTab) {
		if (!canManage()) return false
		const validTab = TABS.some(function (t) { return t.id === initialTab }) ? initialTab : 'installed'
		if (session && !session.closed) {
			if (initialTab) switchTab(session, validTab)
			return true
		}
		if (!root.AppDialog || typeof root.AppDialog.panel !== 'function') return false

		const doc = getDoc()
		const s = {
			tab: validTab,
			closed: false,
			search: '',
			notice: null,
			tabButtons: [],
			tabPanels: {},
			jsonSelectedId: null,
			jsonSource: 'json',
			jsonFileName: '',
			jsonText: '',
			jsonValidation: null,
			jsonOverwriteConfirm: null,
			jsonDeleteArmed: null,
			jsSelectedKey: null,
			jsSelectedSource: 'js-local',
			jsSelectedId: '',
			jsEditingNew: false,
			jsName: '',
			jsFileName: '',
			jsCode: '',
			jsTrustConfirmKey: null,
			jsDeleteArmed: null,
			jsDirPath: '',
			jsScanning: false,
		}

		function onExternalChange() {
			if (s.closed) return
			renderActiveTab(s)
		}

		session = s
		if (doc && typeof doc.addEventListener === 'function') {
			doc.addEventListener('serial-protocol-registry-change', onExternalChange)
			doc.addEventListener('serial-protocol-plugins-change', onExternalChange)
		}

		Promise.resolve(root.AppDialog.panel({
			title: '协议管理',
			wide: true,
			closeText: '关闭',
			build: function (body) { buildPanel(body, s) },
		})).then(function () {
			s.closed = true
			clearJsonDeleteArm(s)
			clearJsDeleteArm(s)
			if (doc && typeof doc.removeEventListener === 'function') {
				doc.removeEventListener('serial-protocol-registry-change', onExternalChange)
				doc.removeEventListener('serial-protocol-plugins-change', onExternalChange)
			}
			if (session === s) session = null
		})

		return true
	}

	function isOpen() {
		return !!(session && !session.closed)
	}

	function mountEntries() {
		if (!canManage()) return
		const doc = getDoc()
		if (!doc || boundDoc === doc) return
		boundDoc = doc
		;['serial-protocol-manage', 'serial-protocol-manage-inline'].forEach(function (id) {
			const btn = doc.getElementById ? doc.getElementById(id) : null
			if (!btn || btn.dataset && btn.dataset.pmBound === '1') return
			if (btn.dataset) btn.dataset.pmBound = '1'
			btn.addEventListener('click', function () { open('installed') })
		})
	}

	const api = {
		open: open,
		isOpen: isOpen,
		buildDevPrompt: buildDevPrompt,
	}

	if (typeof module !== 'undefined' && module.exports) module.exports = api
	root.ProtocolManager = api

	const doc = getDoc()
	if (doc) {
		if (doc.readyState === 'loading' && typeof doc.addEventListener === 'function') {
			doc.addEventListener('DOMContentLoaded', mountEntries)
		} else {
			mountEntries()
		}
	}
})(typeof window !== 'undefined' ? window : globalThis)
