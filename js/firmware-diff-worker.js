// 差分计算只在独立 Worker 中执行，主线程结束生成后 terminate 释放 WASM。
let modulePromise = null
let wasmMemory = null

function loadModule() {
	if (modulePromise) return modulePromise
	modulePromise = new Promise(function (resolve, reject) {
		try {
			// 内嵌 WASM 文件沿用页面全局命名；Worker 不需要 DOM。
			self.window = self
			importScripts('hdiffi.js', 'hdiffi-data.js')
			const bytes = Uint8Array.from(atob(self.__hdiffiWasmBase64), function (c) { return c.charCodeAt(0) })
			delete self.__hdiffiWasmBase64
			createHpatchLiteModule({
				instantiateWasm: function (imports, done) {
					WebAssembly.instantiate(bytes, imports).then(function (result) {
						wasmMemory = Object.values(result.instance.exports).find(function (v) { return v instanceof WebAssembly.Memory })
						done(result.instance)
					}).catch(reject)
				}
			}).then(resolve, reject)
		} catch (e) { reject(e) }
	})
	return modulePromise
}

self.onmessage = async function (e) {
	let mod = null
	let oldPtr = 0, newPtr = 0, outPtrPtr = 0, outPtr = 0
	try {
		mod = await loadModule()
		const oldData = new Uint8Array(e.data.old)
		const newData = new Uint8Array(e.data.nw)
		const t0 = performance.now()
		oldPtr = mod._malloc(Math.max(1, oldData.length))
		newPtr = mod._malloc(Math.max(1, newData.length))
		outPtrPtr = mod._malloc(4)
		if (!oldPtr || !newPtr || !outPtrPtr) throw new Error('差分内存分配失败')
		// malloc 和差分可能扩容线性内存，每次都读取当前 buffer。
		const heap = new Uint8Array(wasmMemory.buffer)
		heap.set(oldData, oldPtr)
		heap.set(newData, newPtr)
		mod.setValue(outPtrPtr, 0, 'i32')
		const size = mod._hdiffi_create_patch(oldPtr, oldData.length, newPtr, newData.length, outPtrPtr)
		outPtr = mod.getValue(outPtrPtr, 'i32') >>> 0
		if (size <= 0 || !outPtr) throw new Error('hdiffi 差分失败, 返回 ' + size)
		const patch = new Uint8Array(wasmMemory.buffer, outPtr, size).slice()
		self.postMessage({ patch: patch.buffer, ms: performance.now() - t0 }, [patch.buffer])
	} catch (error) {
		self.postMessage({ error: error && error.message ? error.message : String(error) })
	} finally {
		if (mod) {
			for (const ptr of [outPtr, oldPtr, newPtr, outPtrPtr]) {
				if (ptr) mod._free(ptr)
			}
		}
	}
}
