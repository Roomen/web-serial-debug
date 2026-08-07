// BLU 波形冷存储：分块 deflate 压缩写入 OPFS（失败则 IndexedDB），按需解压回读
// 仅存电流 Float32 原始字节，保证不丢细节
// 多标签：session 心跳 + 仅回收过期会话；后开页不会清掉仍存活标签的数据
(function () {
	'use strict'

	const DIR_NAME = 'blu-wave-archive'
	const IDB_NAME = 'blu-wave-archive'
	const IDB_STORE = 'chunks'
	const IDB_VER = 1
	// 跨标签会话注册表（localStorage，同源可见）
	const TAB_REG_KEY = 'blu-wave-tab-sessions'
	// 超过此时长无心跳视为标签已死，可安全回收其冷数据
	const STALE_MS = 90 * 1000
	const HEARTBEAT_MS = 15 * 1000
	// sessionId 形如 s{time36}_{rand6}；块键 = sessionId + '_' + chunkId
	const SESSION_KEY_RE = /^(s[0-9a-z]+_[0-9a-z]+)_(.+)$/i

	let backend = null // 'opfs' | 'idb' | null
	let opfsDir = null
	let sessionId = ''
	let diskUsedBytes = 0
	let initPromise = null
	let heartbeatTimer = 0
	let pageExitBound = false

	function newSessionId() {
		return 's' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
	}

	function isCompressionSupported() {
		return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
	}

	async function compressDeflate(u8) {
		if (!isCompressionSupported()) {
			return u8
		}
		const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'))
		const buf = await new Response(stream).arrayBuffer()
		return new Uint8Array(buf)
	}

	async function decompressDeflate(u8, expectBytes) {
		if (!isCompressionSupported()) {
			return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4)
		}
		const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'))
		const buf = await new Response(stream).arrayBuffer()
		if (expectBytes && buf.byteLength !== expectBytes) {
			if (u8.byteLength === expectBytes) {
				return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength))
			}
		}
		return new Float32Array(buf)
	}

	function float32ToU8(f32) {
		return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
	}

	function sessionPrefixFromKey(name) {
		const m = String(name).match(SESSION_KEY_RE)
		return m ? m[1] : null
	}

	// ---- 跨标签心跳注册表 ----
	function readRegistry() {
		try {
			const raw = localStorage.getItem(TAB_REG_KEY)
			if (!raw) return {}
			const o = JSON.parse(raw)
			return o && typeof o === 'object' ? o : {}
		} catch (e) {
			return {}
		}
	}

	function writeRegistry(reg) {
		try {
			localStorage.setItem(TAB_REG_KEY, JSON.stringify(reg))
		} catch (e) { /* 忽略配额 */ }
	}

	function touchHeartbeat(id) {
		if (!id) return
		const reg = readRegistry()
		reg[id] = { t: Date.now() }
		writeRegistry(reg)
	}

	function dropHeartbeat(id) {
		if (!id) return
		const reg = readRegistry()
		if (reg[id]) {
			delete reg[id]
			writeRegistry(reg)
		}
	}

	/** 仍存活的 session（心跳未过期） */
	function liveSessionSet(now) {
		now = now || Date.now()
		const reg = readRegistry()
		const live = {}
		let dirty = false
		for (const id in reg) {
			if (!Object.prototype.hasOwnProperty.call(reg, id)) continue
			const ent = reg[id]
			const t = ent && isFinite(ent.t) ? ent.t : 0
			if (t > 0 && (now - t) <= STALE_MS) {
				live[id] = true
			} else {
				delete reg[id]
				dirty = true
			}
		}
		if (dirty) writeRegistry(reg)
		return live
	}

	function startHeartbeat() {
		stopHeartbeat()
		touchHeartbeat(sessionId)
		heartbeatTimer = setInterval(function () {
			touchHeartbeat(sessionId)
		}, HEARTBEAT_MS)
		if (typeof heartbeatTimer === 'object' && heartbeatTimer.unref) {
			try { heartbeatTimer.unref() } catch (e) { /* 浏览器无 unref */ }
		}
	}

	function stopHeartbeat() {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer)
			heartbeatTimer = 0
		}
	}

	// ---- OPFS ----
	async function initOpfs() {
		if (!navigator.storage || !navigator.storage.getDirectory) return false
		try {
			const root = await navigator.storage.getDirectory()
			opfsDir = await root.getDirectoryHandle(DIR_NAME, { create: true })
			backend = 'opfs'
			return true
		} catch (e) {
			opfsDir = null
			return false
		}
	}

	async function opfsWrite(name, u8) {
		const fh = await opfsDir.getFileHandle(name, { create: true })
		const w = await fh.createWritable()
		try {
			await w.write(u8)
		} finally {
			await w.close()
		}
	}

	async function opfsRead(name) {
		const fh = await opfsDir.getFileHandle(name, { create: false })
		const file = await fh.getFile()
		const buf = await file.arrayBuffer()
		return new Uint8Array(buf)
	}

	async function opfsRemove(name) {
		try {
			await opfsDir.removeEntry(name)
		} catch (e) { /* 忽略 */ }
	}

	async function opfsListNames() {
		const names = []
		if (!opfsDir) return names
		// eslint-disable-next-line no-restricted-syntax
		for await (const [name] of opfsDir.entries()) {
			names.push(String(name))
		}
		return names
	}

	async function opfsClearSession(prefix) {
		if (!opfsDir || !prefix) return
		const names = await opfsListNames()
		for (let i = 0; i < names.length; i++) {
			if (names[i].indexOf(prefix) === 0) {
				try { await opfsDir.removeEntry(names[i]) } catch (e) { /* 忽略 */ }
			}
		}
	}

	/** 删除「非存活 session」的块（保留 live 集合内及其它标签仍在用的） */
	async function opfsGcOrphans(live) {
		if (!opfsDir) return 0
		const names = await opfsListNames()
		let removed = 0
		for (let i = 0; i < names.length; i++) {
			const name = names[i]
			const sid = sessionPrefixFromKey(name)
			// 无法解析的旧键：一律当孤儿清掉
			if (!sid || !live[sid]) {
				try {
					await opfsDir.removeEntry(name)
					removed++
				} catch (e) { /* 忽略 */ }
			}
		}
		return removed
	}

	// ---- IndexedDB 回退 ----
	function idbOpen() {
		return new Promise(function (resolve, reject) {
			const req = indexedDB.open(IDB_NAME, IDB_VER)
			req.onupgradeneeded = function () {
				const db = req.result
				if (!db.objectStoreNames.contains(IDB_STORE)) {
					db.createObjectStore(IDB_STORE)
				}
			}
			req.onsuccess = function () { resolve(req.result) }
			req.onerror = function () { reject(req.error) }
		})
	}

	function idbPut(key, u8) {
		return idbOpen().then(function (db) {
			return new Promise(function (resolve, reject) {
				const tx = db.transaction(IDB_STORE, 'readwrite')
				tx.objectStore(IDB_STORE).put(u8, key)
				tx.oncomplete = function () { db.close(); resolve() }
				tx.onerror = function () { db.close(); reject(tx.error) }
			})
		})
	}

	function idbGet(key) {
		return idbOpen().then(function (db) {
			return new Promise(function (resolve, reject) {
				const tx = db.transaction(IDB_STORE, 'readonly')
				const req = tx.objectStore(IDB_STORE).get(key)
				req.onsuccess = function () {
					db.close()
					const v = req.result
					if (!v) resolve(null)
					else if (v instanceof Uint8Array) resolve(v)
					else resolve(new Uint8Array(v))
				}
				req.onerror = function () { db.close(); reject(req.error) }
			})
		})
	}

	function idbDelete(key) {
		return idbOpen().then(function (db) {
			return new Promise(function (resolve, reject) {
				const tx = db.transaction(IDB_STORE, 'readwrite')
				tx.objectStore(IDB_STORE).delete(key)
				tx.oncomplete = function () { db.close(); resolve() }
				tx.onerror = function () { db.close(); reject(tx.error) }
			})
		})
	}

	function idbClearPrefix(prefix) {
		return idbOpen().then(function (db) {
			return new Promise(function (resolve, reject) {
				const tx = db.transaction(IDB_STORE, 'readwrite')
				const store = tx.objectStore(IDB_STORE)
				const req = store.openCursor()
				req.onsuccess = function () {
					const cur = req.result
					if (!cur) return
					const k = String(cur.key)
					if (!prefix || k.indexOf(prefix) === 0) cur.delete()
					cur.continue()
				}
				tx.oncomplete = function () { db.close(); resolve() }
				tx.onerror = function () { db.close(); reject(tx.error) }
			})
		})
	}

	function idbGcOrphans(live) {
		return idbOpen().then(function (db) {
			return new Promise(function (resolve, reject) {
				let removed = 0
				const tx = db.transaction(IDB_STORE, 'readwrite')
				const store = tx.objectStore(IDB_STORE)
				const req = store.openCursor()
				req.onsuccess = function () {
					const cur = req.result
					if (!cur) return
					const k = String(cur.key)
					const sid = sessionPrefixFromKey(k)
					if (!sid || !live[sid]) {
						cur.delete()
						removed++
					}
					cur.continue()
				}
				tx.oncomplete = function () { db.close(); resolve(removed) }
				tx.onerror = function () { db.close(); reject(tx.error) }
			})
		})
	}

	async function initIdb() {
		if (typeof indexedDB === 'undefined') return false
		try {
			await idbOpen()
			backend = 'idb'
			return true
		} catch (e) {
			return false
		}
	}

	/**
	 * 回收已死标签留下的冷数据；保留心跳仍存活的 session（含本页）
	 * @returns {Promise<number>} 删除的条目数
	 */
	async function gcStaleSessions() {
		const live = liveSessionSet(Date.now())
		// 确保本会话算存活（刚 touch 过也应在 reg 里）
		if (sessionId) live[sessionId] = true
		let n = 0
		if (backend === 'opfs') n = await opfsGcOrphans(live)
		else if (backend === 'idb') n = await idbGcOrphans(live)
		return n
	}

	function bindPageExit() {
		if (pageExitBound || typeof window === 'undefined') return
		pageExitBound = true
		const onExit = function () {
			// 标签关闭/刷新：注销心跳并尽量删掉本会话盘上数据（内存态已丢，冷数据无主）
			stopHeartbeat()
			const prev = sessionId
			dropHeartbeat(prev)
			// pagehide 里尽量同步/快速；异步清扫不保证完成，靠下次 GC 兜底
			if (prev && backend) {
				if (backend === 'opfs') {
					opfsClearSession(prev).catch(function () { /* 忽略 */ })
				} else if (backend === 'idb') {
					idbClearPrefix(prev).catch(function () { /* 忽略 */ })
				}
			}
		}
		window.addEventListener('pagehide', onExit)
		// 部分环境 pagehide 不可靠，再挂 beforeunload（仅做注销，不 await）
		window.addEventListener('beforeunload', function () {
			stopHeartbeat()
			dropHeartbeat(sessionId)
		})
	}

	async function init() {
		if (initPromise) return initPromise
		initPromise = (async function () {
			diskUsedBytes = 0
			sessionId = newSessionId()
			if (await initOpfs()) {
				// 先登记心跳，再 GC，避免把自己刚写的（尚无）或竞态清掉
				startHeartbeat()
				bindPageExit()
				await gcStaleSessions()
				return backend
			}
			if (await initIdb()) {
				startHeartbeat()
				bindPageExit()
				await gcStaleSessions()
				return backend
			}
			backend = null
			startHeartbeat()
			bindPageExit()
			return null
		})()
		return initPromise
	}

	function getSessionId() {
		return sessionId
	}

	function getDiskUsed() {
		return diskUsedBytes
	}

	function getBackend() {
		return backend
	}

	function chunkKey(id) {
		return sessionId + '_' + id
	}

	/**
	 * 压缩并写入一块 Float32 电流数据
	 * @param {string} id
	 * @param {Float32Array} samples
	 * @returns {Promise<{byteSize:number, rawBytes:number}>}
	 */
	async function writeChunk(id, samples) {
		if (!backend) await init()
		if (!backend) throw new Error('无可用磁盘存储（OPFS/IndexedDB）')
		touchHeartbeat(sessionId)
		const raw = float32ToU8(samples)
		const rawBytes = raw.byteLength
		const payload = await compressDeflate(raw)
		const key = chunkKey(id)
		if (backend === 'opfs') await opfsWrite(key, payload)
		else await idbPut(key, payload)
		diskUsedBytes += payload.byteLength
		return {
			byteSize: payload.byteLength,
			rawBytes: rawBytes,
		}
	}

	/**
	 * 读回并解压为一块 Float32
	 * @param {string} id
	 * @param {number} n 样点数
	 */
	async function readChunk(id, n) {
		if (!backend) await init()
		if (!backend) throw new Error('无可用磁盘存储')
		const key = chunkKey(id)
		let u8
		if (backend === 'opfs') u8 = await opfsRead(key)
		else u8 = await idbGet(key)
		if (!u8) throw new Error('冷数据块不存在: ' + id)
		const expect = (n | 0) * 4
		if (u8.byteLength === expect) {
			return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength))
		}
		return decompressDeflate(u8, expect)
	}

	async function removeChunk(id, byteSize) {
		if (!backend) return
		const key = chunkKey(id)
		try {
			if (backend === 'opfs') await opfsRemove(key)
			else await idbDelete(key)
		} catch (e) { /* 忽略 */ }
		if (byteSize > 0) diskUsedBytes = Math.max(0, diskUsedBytes - byteSize)
	}

	/** 清空当前会话冷数据，并开启新 session id（不影响其它标签） */
	async function clearSession() {
		const prev = sessionId
		dropHeartbeat(prev)
		if (backend === 'opfs') await opfsClearSession(prev)
		else if (backend === 'idb') await idbClearPrefix(prev)
		diskUsedBytes = 0
		sessionId = newSessionId()
		startHeartbeat()
	}

	/**
	 * 仅回收过期会话（多标签安全）。
	 * 不再提供「无条件清空全库」给业务路径，避免误伤其它标签。
	 */
	async function gcOrphans() {
		if (!backend) await init()
		return gcStaleSessions()
	}

	window.BluWaveStore = {
		init: init,
		getSessionId: getSessionId,
		getDiskUsed: getDiskUsed,
		getBackend: getBackend,
		isCompressionSupported: isCompressionSupported,
		writeChunk: writeChunk,
		readChunk: readChunk,
		removeChunk: removeChunk,
		clearSession: clearSession,
		gcOrphans: gcOrphans,
		// 兼容旧名：语义改为多标签安全的孤儿回收，而非全库删除
		clearAllBackend: gcOrphans,
	}
})()
