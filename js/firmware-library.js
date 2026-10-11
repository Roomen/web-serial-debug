// 本机固件库：导入过的原始固件存在本机(IndexedDB)，供自动升级按「设备上报的版本」找差分基准。
// 键是 crc32 + 大小(同一份构建只存一次)，记录内嵌版本、文件名、加入与最近使用时间；超过条数或总字节上限时
// 按最近使用时间淘汰最旧的，刚加入的那份不淘汰(单份就超字节上限时也留着它)。
// 每次修改(加入 / 标记使用 / 清空)都是一次原子的读改写：IndexedDB 里在同一个 readwrite 事务内读全部记录、算出写入与淘汰、
// 同步发出请求，不要拆成「读 → 另开事务写 → 再开事务删」——并发导入(连点两次、桌面多开的另一个窗口)会都按旧快照算淘汰，库就超上限，
// 已淘汰的记录也会被迟到的 touch 写回来。存储可注入(node 测试用内存实现，tests/firmware-core.cjs)。依赖 js/firmware-core.js。
;(function (root) {
	'use strict'

	const MAX_ENTRIES = 20
	const MAX_BYTES = 32 * 1024 * 1024

	function core() {
		return root.FirmwareCore || (typeof require === 'function' ? require('./firmware-core.js') : null)
	}

	function keyOf(crc, size) { return crc + ':' + size }

	// 淘汰选择：按 usedAt 从旧到新，直到条数与字节都在上限内；keepKey 永不淘汰
	function selectEvictions(records, caps, keepKey) {
		const maxEntries = caps && caps.maxEntries > 0 ? caps.maxEntries : MAX_ENTRIES
		const maxBytes = caps && caps.maxBytes > 0 ? caps.maxBytes : MAX_BYTES
		let count = records.length
		let bytes = records.reduce(function (s, r) { return s + (r.size || 0) }, 0)
		const out = []
		const order = records.slice().sort(function (a, b) { return (a.usedAt || 0) - (b.usedAt || 0) })
		for (let i = 0; i < order.length && (count > maxEntries || bytes > maxBytes); i++) {
			const r = order[i]
			if (r.key === keepKey) continue
			out.push(r.key)
			count--
			bytes -= r.size || 0
		}
		return out
	}

	// 加入一份固件的改动：all 是事务内读到的全部记录。同一份已在库里就保留原数据与加入时间，只更新名字与使用时间
	function planAdd(all, entry, caps, t) {
		const old = all.find(function (r) { return r.key === entry.key })
		const rec = {
			key: entry.key, crc: entry.crc, size: entry.size, version: entry.version,
			name: entry.name || (old && old.name) || '',
			addedAt: old ? old.addedAt : t, usedAt: t, data: old ? old.data : entry.data,
		}
		const rest = all.filter(function (r) { return r.key !== entry.key }).concat([rec])
		return { put: [rec], remove: selectEvictions(rest, caps, entry.key), rec }
	}

	// ---- 存储后端：update(fn) 把 fn(全部记录) 返回的 { put, remove, clear } 原子地应用，返回 fn 的结果；all() 只读 ----
	function memoryStore() {
		const m = new Map()
		return {
			async all() { return Array.from(m.values()) },
			// fn 与写入在同一个同步段里完成，JS 单线程即原子
			async update(fn) {
				const plan = fn(Array.from(m.values()))
				if (plan.clear) m.clear()
				;(plan.remove || []).forEach(function (k) { m.delete(k) })
				;(plan.put || []).forEach(function (r) { m.set(r.key, r) })
				return plan
			},
		}
	}

	function idbStore(indexedDB) {
		function open() {
			return new Promise(function (resolve, reject) {
				const req = indexedDB.open('fw-library', 1)
				req.onupgradeneeded = function () { req.result.createObjectStore('fw', { keyPath: 'key' }) }
				req.onsuccess = function () { resolve(req.result) }
				req.onerror = function () { reject(req.error) }
			})
		}
		function tx(mode, body) {
			return open().then(function (db) {
				return new Promise(function (resolve, reject) {
					const t = db.transaction('fw', mode)
					let out
					t.oncomplete = function () { db.close(); resolve(out) }
					t.onerror = function () { db.close(); reject(t.error) }
					t.onabort = function () { db.close(); reject(t.error || new Error('固件库事务被中止')) }
					body(t.objectStore('fw'), function (v) { out = v })
				})
			})
		}
		return {
			all() {
				return tx('readonly', function (s, done) {
					const req = s.getAll()
					req.onsuccess = function () { done(req.result) }
				})
			},
			// 读与写在同一个 readwrite 事务里：getAll 回调里同步发出 put / delete，事务不会在中间提交；
			// 同库的 readwrite 事务由浏览器串行(跨标签页 / 窗口也一样)，所以并发修改不会按旧快照各算各的
			update(fn) {
				return tx('readwrite', function (s, done) {
					const req = s.getAll()
					req.onsuccess = function () {
						const plan = fn(req.result)
						if (plan.clear) s.clear()
						;(plan.remove || []).forEach(function (k) { s.delete(k) })
						;(plan.put || []).forEach(function (r) { s.put(r) })
						done(plan)
					}
				})
			},
		}
	}

	function createLibrary(store, opts) {
		opts = opts || {}
		const caps = { maxEntries: opts.maxEntries || MAX_ENTRIES, maxBytes: opts.maxBytes || MAX_BYTES }
		const now = opts.now || function () { return Date.now() }

		return {
			// 存入一份原始固件；没有内嵌版本的不收(无法按版本查到它)。返回记录摘要(不含 data)或 null
			async add(name, data) {
				const C = core()
				const version = C.embeddedVersion(data)
				if (!version) return null
				const crc = C.crc32(data)
				// 拷贝在事务外做好：事务回调里只能同步工作
				const entry = { key: keyOf(crc, data.length), crc, size: data.length, version, name: name || '', data: data.slice() }
				const t = now()
				const plan = await store.update(function (all) { return planAdd(all, entry, caps, t) })
				const r = plan.rec
				return { key: r.key, crc: r.crc, size: r.size, version: r.version, name: r.name, evicted: plan.remove.length }
			},
			// 内嵌版本等于 version 的全部条目(含 data)
			async findByVersion(version) {
				const C = core()
				const all = await store.all()
				return all.filter(function (r) { return C.sameVersion(r.version, version) })
			},
			// 标记最近使用；记录已被淘汰或清空就什么也不写，不会把它写回来
			touch(key) {
				const t = now()
				return store.update(function (all) {
					const r = all.find(function (x) { return x.key === key })
					if (!r) return { put: [] }
					return { put: [Object.assign({}, r, { usedAt: t })] }
				}).then(function () {})
			},
			async summary() {
				const all = await store.all()
				return { count: all.length, bytes: all.reduce(function (s, r) { return s + (r.size || 0) }, 0) }
			},
			clear() { return store.update(function () { return { clear: true } }).then(function () {}) },
		}
	}

	const api = { MAX_ENTRIES, MAX_BYTES, keyOf, selectEvictions, planAdd, memoryStore, idbStore, createLibrary }

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api
	}
	root.FirmwareLibraryLib = api
	if (root.indexedDB) {
		root.FirmwareLibrary = createLibrary(idbStore(root.indexedDB))
	}
})(typeof window !== 'undefined' ? window : globalThis)
