// 公共协议请求层（window.ProtocolRequest）：在指定的一路上发一帧，等调用方的匹配函数认领应答，支持超时与取消。不认识任何具体协议。
// 一次读取流程（begin 返回的 flow）锁定发起时的那一路、协议（id 与注册表条目对象，同 id 被重新注册也算换了）与连接代次
// （serialApi.sessionGeneration）：写入前、认领前、交付结果前都按「协议 + 代次 + 是否打开 + 是否取消」重查一遍，
// 任一项变了后续请求不再发出，等待中的请求立即失败，迟到的应答丢弃，不会把旧连接 / 旧协议的应答记到新状态上。
// 收帧：调用方可以给 source（已按协议切好帧、入过账的条目流，设备面板就是这样做的，保证每一帧只切、只解析、只入账一次），
// 不给时按该路协议的 findFrame / parseFrame 自己切帧（解析放在 serialLanes.parseInLane 里，双路各路的流式状态隔离）。
// 认领边界：条目带帧起始字节在这一路字节流里的绝对位置（start），请求只认领起始位置在本次写入开始时已收字节数之后的帧，
// 查询发出前就已缓存的旧应答前缀、写入后才补齐的那一帧不会被认成本次应答（被动入账不受影响）。
// 写入完成前认领到的第一条合格帧被锁存，写完只复核它，后到的匹配帧不会把它换掉。
// 失败的 Error 带 code 与 sent：sent=false 表示这一帧没有发出去；sent=true 表示已经发出、设备那边结果未知。
// 钉扎（pinSession）只锁主发，挡不住手动发送等其它写入路径；所以 serialApi 提供 txCount 时，等待期间这一路有别的写入
// 就以 code 'foreign' 失败（无法确认应答属于本次请求），而不是把别人的应答认领成自己的。
// 依赖全部可注入，node 测试见 tests/device-panel.cjs。
;(function (root) {
	'use strict'

	const BUF_MAX = 65536
	const BUF_KEEP = 16384
	const RECHECK_MS = 200

	const MESSAGES = {
		cancelled: '已取消',
		generation: '连接已变化（断开、重连或换口），丢弃本次应答',
		closed: '这一路串口未打开',
		protocol: '这一路的协议已切换',
		timeout: '应答超时',
		write: '发送失败',
		build: '组帧失败',
		busy: '其它协议事务正在占用串口',
		noproto: '这一路的协议不能收帧（缺少 findFrame / parseFrame）',
		foreign: '等待应答期间这一路有其它发送，无法确认应答属于本次请求',
	}

	function makeErr(code, detail, sent) {
		const e = new Error(detail ? MESSAGES[code] + '：' + detail : MESSAGES[code])
		e.code = code
		e.sent = !!sent
		return e
	}

	function create(env) {
		env = env || {}
		const getApi = function () { return env.serialApi || root.serialApi || null }
		const getLanes = function () { return env.serialLanes || root.serialLanes || null }
		const getRegistry = function () { return env.registry || root.ProtocolRegistry || null }
		const doc = env.document !== undefined ? env.document : (typeof document !== 'undefined' ? document : null)
		const setT = env.setTimeout || function (fn, ms) { return setTimeout(fn, ms) }
		const clearT = env.clearTimeout || function (t) { clearTimeout(t) }
		const now = env.now || function () { return Date.now() }

		function generation(sid) {
			const a = getApi()
			return a && typeof a.sessionGeneration === 'function' ? a.sessionGeneration(sid) : 0
		}
		function laneOpen(sid) {
			const a = getApi()
			return !!(a && typeof a.isSessionOpen === 'function' && a.isSessionOpen(sid))
		}
		function protocolOf(sid) {
			const l = getLanes()
			if (l && typeof l.protocolOf === 'function') return l.protocolOf(sid) || ''
			return root._activeProtocol || ''
		}
		function protocolEntry(pid) {
			const r = getRegistry()
			return r && typeof r.get === 'function' ? (r.get(pid) || null) : null
		}
		function txCount(sid) {
			const a = getApi()
			return a && typeof a.txCount === 'function' ? a.txCount(sid) : null
		}
		function parseIn(sid, fn) {
			const l = getLanes()
			return l && typeof l.parseInLane === 'function' ? l.parseInLane(sid, fn) : fn()
		}
		function parseOpts() {
			const a = getApi()
			try { return (a && typeof a.getParseOpts === 'function' && a.getParseOpts()) || {} } catch (e) { return {} }
		}

		// 某一路的 RX 订阅。serialApi 单路模式下不按 sid 过滤，这里按模式自己挡：S 只在单路收，A/B 只在双路收
		function subscribeLane(sid, cb) {
			const a = getApi()
			if (!a || typeof a.onReceiveFrom !== 'function') return function () {}
			return a.onReceiveFrom(sid, function (data) {
				const mode = typeof a.getMode === 'function' ? a.getMode() : 'single'
				if (sid === 'S' ? mode !== 'single' : mode !== 'dual') return
				cb(data)
			})
		}

		// 协议实际变更的信号：按路配置变更、注册表变更、顶栏协议 change（单路改协议不派发 serial-lane-config）、连接事件。
		// 返回退订函数
		function watchProtocol(fn) {
			if (!doc || typeof doc.addEventListener !== 'function') return function () {}
			const evs = ['serial-lane-config', 'serial-protocol-registry-change', 'serial-session']
			evs.forEach(function (t) { doc.addEventListener(t, fn) })
			const sel = typeof doc.getElementById === 'function' ? doc.getElementById('serial-protocol-select') : null
			if (sel && typeof sel.addEventListener === 'function') sel.addEventListener('change', fn)
			return function () {
				evs.forEach(function (t) { doc.removeEventListener(t, fn) })
				if (sel && typeof sel.removeEventListener === 'function') sel.removeEventListener('change', fn)
			}
		}

		// 收帧器：按协议 findFrame 从字节流里切帧，再 parseFrame。findFrame / parseFrame 可能改协议的流式状态，
		// 所以整段放进 parseInLane。返回本次切出的 [{ frame: Uint8Array, parsed, start }]，start 是帧首字节在流里的绝对位置
		// （base0 是这个收帧器第一个字节的绝对位置）；reset 清掉半帧
		function createFramer(sid, proto, base0) {
			let buf = []
			let base = base0 || 0 // buf[0] 的绝对位置
			function push(chunk) {
				const out = []
				const arr = chunk ? Array.from(chunk) : []
				if (!proto || (!proto.findFrame && !proto.parseFrame)) { base += arr.length; return out }
				for (let i = 0; i < arr.length; i++) buf.push(arr[i] & 0xff)
				if (buf.length > BUF_MAX) { base += buf.length - BUF_KEEP; buf = buf.slice(buf.length - BUF_KEEP) }
				if (!buf.length) return out
				const opts = parseOpts()
				parseIn(sid, function () {
					if (typeof proto.findFrame === 'function') {
						let guard = 0
						while (buf.length && guard++ < 64) {
							let found = null
							try { found = proto.findFrame(Uint8Array.from(buf), opts) } catch (e) { found = null }
							if (!found || !found.found || !found.frame) break
							const end = (found.offset || 0) + (found.length || found.frame.length)
							const frame = Uint8Array.from(found.frame)
							const start = base + (found.offset || 0)
							const drop = Math.min(buf.length, Math.max(1, end))
							buf = buf.slice(drop)
							base += drop
							let parsed = found.parse || null
							if (!parsed && typeof proto.parseFrame === 'function') {
								try { parsed = proto.parseFrame(frame, opts) } catch (e) { parsed = null }
							}
							if (parsed && parsed.ok !== false) out.push({ frame: frame, parsed: parsed, start: start })
						}
						return
					}
					let parsed = null
					try { parsed = proto.parseFrame(Uint8Array.from(buf), opts) } catch (e) { parsed = null }
					if (parsed && parsed.ok !== false) {
						out.push({ frame: Uint8Array.from(buf), parsed: parsed, start: base })
						base += buf.length
						buf = []
					}
				})
				return out
			}
			return { push: push, size: function () { return buf.length }, reset: function () { base += buf.length; buf = [] } }
		}

		// 开始一次读取流程：锁定 sid、协议（id + 条目对象）、连接代次
		// opts.source(cb) => unsubscribe：可选的已切帧条目流，条目 { frame, parsed, at, gen, pid, entry, start, ... }；
		// opts.position() => 这一路已收字节数（与条目 start 同一坐标），给了 source 就要一起给（收帧泵的 source / position）
		function begin(sid, opts) {
			opts = opts || {}
			const a = getApi()
			const startGen = generation(sid)
			const pid = protocolOf(sid)
			const entry = protocolEntry(pid)
			if (!laneOpen(sid)) throw makeErr('closed')
			if (a && typeof a.isPinned === 'function' && a.isPinned()) throw makeErr('busy')
			let pinned = false
			if (opts.pin !== false && a && typeof a.pinSession === 'function') {
				a.pinSession(sid)
				pinned = true
			}
			let cancelReason = null
			let ended = false
			let current = null

			function check() {
				if (cancelReason != null) return makeErr('cancelled', cancelReason || '')
				if (ended) return makeErr('cancelled', '流程已结束')
				if (generation(sid) !== startGen) return makeErr('generation')
				if (!laneOpen(sid)) return makeErr('closed')
				if (protocolOf(sid) !== pid || protocolEntry(pid) !== entry) return makeErr('protocol')
				return null
			}

			// o = { build: () => bytes | bytes, match(parsed, frame, item) => bool, timeoutMs }
			// 成功：{ frame, parsed, at, sid, gen, protocolId, item }，要等这一帧真正写完且被认领才算
			function request(o) {
				o = o || {}
				return new Promise(function (resolve, reject) {
					const pre = check()
					if (pre) { reject(pre); return }
					if (current) { reject(makeErr('busy')); return }
					if (!entry || (typeof entry.findFrame !== 'function' && typeof entry.parseFrame !== 'function')) { reject(makeErr('noproto')); return }
					let bytes = null
					try {
						bytes = typeof o.build === 'function' ? o.build() : o.build
						bytes = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])
					} catch (e) {
						reject(makeErr('build', e && e.message ? e.message : String(e)))
						return
					}
					if (!bytes.length) { reject(makeErr('build', '空帧')); return }
					const timeoutMs = o.timeoutMs > 0 ? o.timeoutMs : 5000
					let done = false
					let sent = false // 已交给写入（之后失败都算「已发送、结果未知」）
					let written = false // 写入已完成
					let claimed = null // 写完之前就认领到的应答（锁存第一条合格候选），等写完再交付
					let tx0 = null
					let boundary = null // 写入开始时这一路已收字节数：起始位置在它之前的帧不是本次应答
					let ownPos = 0
					let timer = null
					let recheck = null
					let unsub = null
					const listeners = []
					let framer = null

					function finish(err, res) {
						if (done) return
						done = true
						if (timer) { clearT(timer); timer = null }
						if (recheck) { clearT(recheck); recheck = null }
						if (unsub) { try { unsub() } catch (e) {} unsub = null }
						if (framer) framer.reset()
						if (doc && typeof doc.removeEventListener === 'function') listeners.forEach(function (l) { doc.removeEventListener(l[0], l[1]) })
						if (current && current.finish === finish) current = null
						if (err) {
							err.sent = sent
							reject(err)
						} else resolve(res)
					}
					current = { finish: finish }

					function foreignTx() {
						if (tx0 == null) return false
						const n = txCount(sid)
						return n != null && n !== tx0 + 1
					}
					function deliver() {
						const bad = check()
						if (bad) { finish(bad); return }
						if (foreignTx()) { finish(makeErr('foreign')); return }
						const it = claimed
						finish(null, { frame: it.frame, parsed: it.parsed, at: it.at, sid: sid, gen: startGen, protocolId: pid, item: it })
					}
					function onItem(it) {
						if (done) return
						const bad = check()
						if (bad) { finish(bad); return }
						if (!sent) return // 还没发出去时收到的帧不可能是本次的应答
						if (it.gen != null && it.gen !== startGen) return
						if (it.entry !== undefined && it.entry !== entry) return
						if (claimed) return // 已锁存首条合格候选，写完只复核它
						// 起始字节早于本次写入（查询发出前就已缓存的旧应答前缀，写入后才补齐）：不是本次应答
						if (boundary != null && (typeof it.start !== 'number' || it.start < boundary)) return
						let hit = false
						try { hit = typeof o.match === 'function' ? !!o.match(it.parsed, it.frame, it) : false } catch (e) { hit = false }
						if (!hit) return
						if (foreignTx()) { finish(makeErr('foreign')); return }
						claimed = it
						if (written) deliver()
					}

					// 超时出口也要识别计数冲突：等待期间有别的发送时，没等到应答不只是超时，整轮都不可信
					timer = setT(function () { finish(foreignTx() ? makeErr('foreign') : makeErr('timeout', timeoutMs + 'ms')) }, timeoutMs)
					// 协议 / 连接变化没有统一事件：既听已有的事件，也定时重查（等待中立即结束，不等超时）
					function tick() {
						recheck = null
						if (done) return
						const bad = check()
						if (bad) { finish(bad); return }
						if (foreignTx()) { finish(makeErr('foreign')); return }
						recheck = setT(tick, RECHECK_MS)
					}
					recheck = setT(tick, RECHECK_MS)
					let unwatch = null
					if (doc && typeof doc.addEventListener === 'function') {
						const onSession = function (ev) {
							const d = ev && ev.detail
							if (d && d.sid === sid) finish(makeErr('generation'))
						}
						listeners.push(['serial-session', onSession])
						listeners.forEach(function (l) { doc.addEventListener(l[0], l[1]) })
						unwatch = watchProtocol(function () { if (done) return; const bad = check(); if (bad) finish(bad) })
					}
					const position = typeof opts.source === 'function'
						? (typeof opts.position === 'function' ? opts.position : null)
						: function () { return ownPos }
					if (typeof opts.source === 'function') {
						unsub = opts.source(onItem)
					} else {
						framer = createFramer(sid, entry, 0)
						unsub = subscribeLane(sid, function (data) {
							if (done) return
							ownPos += data ? data.length : 0
							const frames = framer.push(data)
							const at = now()
							const gen = generation(sid)
							for (let i = 0; i < frames.length && !done; i++) {
								onItem({ frame: frames[i].frame, parsed: frames[i].parsed, start: frames[i].start, at: at, gen: gen, pid: pid, entry: entry })
							}
						})
					}
					const prevUnsub = unsub
					unsub = function () { if (unwatch) unwatch(); if (prevUnsub) prevUnsub() }
					const api = getApi()
					Promise.resolve().then(function () {
						// 真正写之前再查一次：排队期间被取消 / 断开 / 换协议的，这一帧不发
						if (done) return
						const bad = check()
						if (bad) { finish(bad); return }
						tx0 = txCount(sid)
						boundary = position ? position() : null
						sent = true
						const writeOpts = o.secret ? { logData: new Uint8Array(bytes.length) } : undefined
						return Promise.resolve(api.writeRawTo(sid, bytes, writeOpts)).then(function () {
							if (done) return
							written = true
							if (claimed) deliver()
						})
					}).catch(function (e) {
						if (tx0 != null && txCount(sid) === tx0) sent = false
						finish(makeErr('write', e && e.message ? e.message : String(e)))
					})
				})
			}

			function readGroup(device, group) {
				return request({
					build: function () { return device.buildRequest(group, { sid: sid }) },
					match: function (parsed, frame, item) { return !!(item && item.res && item.res.groups.includes(group.id)) },
					timeoutMs: device.timeoutMs,
				})
			}

			async function writeField(device, field, value, context) {
				let reply = null
				await request({
					build: function () { return device.buildWrite(field, value, context) },
					secret: field.secret,
					match: function (parsed, frame) {
						reply = device.matchWriteReply(field, parsed, frame)
						return ['ok', 'rejected', 'processing'].includes(reply)
					},
					timeoutMs: device.timeoutMs,
				})
				return reply
			}

			function cancel(reason) {
				if (cancelReason == null) cancelReason = reason || ''
				if (current) current.finish(makeErr('cancelled', reason || ''))
			}

			function end() {
				if (ended) return
				ended = true
				if (current) current.finish(makeErr('cancelled', '流程已结束'))
				if (pinned && a && typeof a.unpinSession === 'function') a.unpinSession()
				pinned = false
			}

			return {
				sid: sid,
				gen: startGen,
				protocolId: pid,
				entry: entry,
				check: check,
				request: request,
				readGroup: readGroup,
				writeField: writeField,
				cancel: cancel,
				end: end,
				get cancelled() { return cancelReason != null },
			}
		}

		// 每路收帧泵：这一路的字节只在这里切帧、解析一次。每帧先交 hooks.onFrame（设备面板在这里入账，可往条目上挂结果），
		// 再按到达顺序广播给订阅者（读取流程经 begin 的 opts.source 订阅，只认领已入账的条目、不再二次解析或入账）。
		// 协议 id、注册表条目或连接代次一变就换新收帧器，旧协议 / 旧连接留下的半帧不会和新数据拼在一起：
		// 协议实际变更（按路配置 / 注册表 / 顶栏 change / 连接事件）时立即比对并清掉，不等下一次 RX
		// （否则同一路 X→Y→X 且期间没有 RX 时，回到 X 后旧半帧还在）；收到 RX 时再比对一次兜底。
		// position() 是这一路已收字节数，条目的 start 与它同一坐标，读取流程据此只认领写入之后才开始的帧。
		// hooks.skip() 为真时整块跳过（如 ZMODEM 期间屏蔽解析）
		function createPump(sid, hooks) {
			hooks = hooks || {}
			let st = null
			let pos = 0
			const subs = []
			function identity() {
				const pid = protocolOf(sid)
				return { pid: pid, entry: protocolEntry(pid), gen: generation(sid) }
			}
			function sync() {
				if (!st) return
				const id = identity()
				if (st.pid !== id.pid || st.entry !== id.entry || st.gen !== id.gen) st = null
			}
			const unwatch = watchProtocol(sync)
			const unsub = subscribeLane(sid, function (data) {
				const n = data ? data.length : 0
				if (typeof hooks.skip === 'function' && hooks.skip()) { pos += n; st = null; return }
				const id = identity()
				const pid = id.pid
				const entry = id.entry
				const gen = id.gen
				if (!st || st.pid !== pid || st.entry !== entry || st.gen !== gen) {
					st = { pid: pid, entry: entry, gen: gen, framer: createFramer(sid, entry, pos) }
				}
				pos += n
				if (!entry) { st.framer.reset(); return }
				if (typeof hooks.accept === 'function' && !hooks.accept(pid, entry)) { st = null; return }
				const frames = st.framer.push(data)
				const at = now()
				for (let i = 0; i < frames.length; i++) {
					const item = { sid: sid, frame: frames[i].frame, parsed: frames[i].parsed, start: frames[i].start, at: at, gen: gen, pid: pid, entry: entry }
					if (typeof hooks.onFrame === 'function') {
						try { hooks.onFrame(item) } catch (e) { item.error = e }
					}
					subs.slice().forEach(function (cb) { try { cb(item) } catch (e) {} })
				}
			})
			return {
				source: function (cb) {
					subs.push(cb)
					return function () { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1) }
				},
				position: function () { return pos },
				// 给测试与诊断：当前收帧器里还有没有半帧
				pending: function () { return st ? st.framer.size() : 0 },
				sync: sync,
				reset: function () { st = null },
				stop: function () { try { unsub() } catch (e) {} try { unwatch() } catch (e) {} subs.length = 0 },
			}
		}

		return {
			begin: begin,
			createPump: createPump,
			createFramer: createFramer,
			subscribeLane: subscribeLane,
			generation: generation,
			protocolEntry: protocolEntry,
			MESSAGES: MESSAGES,
		}
	}

	const api = create()
	api.create = create
	api.MESSAGES = MESSAGES
	if (typeof module !== 'undefined' && module.exports) module.exports = api
	if (typeof window !== 'undefined') window.ProtocolRequest = api
})(typeof window !== 'undefined' ? window : globalThis)
