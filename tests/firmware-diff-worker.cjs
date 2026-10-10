// Real bundled WASM, synthetic firmware only; browser Worker API adapted to worker_threads.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { Worker } = require('node:worker_threads')

async function main() {
	const root = path.join(__dirname, '../js')
	const worker = new Worker(`
		const { parentPort, workerData } = require('node:worker_threads')
		const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path')
		global.require = require
		global.__dirname = workerData
		global.self = globalThis
		global.importScripts = (...files) => files.forEach(f => vm.runInThisContext(fs.readFileSync(path.join(workerData, f), 'utf8')))
		global.postMessage = (data, transfers) => parentPort.postMessage(data, transfers)
		vm.runInThisContext(fs.readFileSync(path.join(workerData, 'firmware-diff-worker.js'), 'utf8'))
		parentPort.on('message', data => self.onmessage({ data }))
	`, { eval: true, workerData: root })
	try {
		const data = (seed) => Uint8Array.from({ length: 65536 }, (_, i) => (i * 31 + seed * (i >> 12)) & 255)
		const old = data(1), nw = data(2)
		const run = (a, b) => new Promise((resolve, reject) => {
			worker.once('message', resolve)
			worker.once('error', reject)
			worker.postMessage({ old: a.buffer, nw: b.buffer })
		})
		const fwd = await run(old, nw)
		assert.equal(fwd.error, undefined)
		assert.ok(fwd.patch instanceof ArrayBuffer && fwd.patch.byteLength > 0)
		assert.equal(old.length, 65536, 'input firmware must stay available for CRC and reverse diff')
		const rev = await run(nw, old)
		assert.equal(rev.error, undefined)
		assert.ok(rev.patch.byteLength > 0)
		// Compare worker bulk-copy results byte-for-byte with the existing bundled engine.
		const create = require('../js/hdiffi.js')
		const c = { window: {} }
		vm.runInNewContext(fs.readFileSync(path.join(root, 'hdiffi-data.js'), 'utf8'), c)
		let memory
		const mod = await create({ instantiateWasm(imports, done) {
			WebAssembly.instantiate(Buffer.from(c.window.__hdiffiWasmBase64, 'base64'), imports).then(r => {
				memory = Object.values(r.instance.exports).find(v => v instanceof WebAssembly.Memory)
				done(r.instance)
			})
		} })
		const a = mod._malloc(old.length), b = mod._malloc(nw.length), out = mod._malloc(4)
		new Uint8Array(memory.buffer).set(old, a)
		new Uint8Array(memory.buffer).set(nw, b)
		const size = mod._hdiffi_create_patch(a, old.length, b, nw.length, out)
		const p = mod.getValue(out, 'i32') >>> 0
		assert.deepEqual(new Uint8Array(fwd.patch), new Uint8Array(memory.buffer, p, size))
		for (const ptr of [p, a, b, out]) mod._free(ptr)
	} finally {
		await worker.terminate()
	}
	console.log('firmware-diff-worker: ok')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
