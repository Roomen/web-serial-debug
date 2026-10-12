// 包一层 tauri CLI：应用版本只来自 js/version.js(window.APP_VERSION)，每次经 --config 传入，tauri.conf.json 与 Cargo.toml 不写版本。
// build 成功后把安装包复制进 desktop/release/(只留最新一版，不入库)：macOS 是 .dmg 与打成 zip 的 .app，Windows 是 NSIS 安装程序与 .msi。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(desktop, '..', 'js', 'version.js'), 'utf8')
const m = src.match(/APP_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/)
if (!m) throw new Error('js/version.js 里找不到 APP_VERSION')
const version = m[1]

const args = process.argv.slice(2)
const sub = args[0]
if (sub === 'dev' || sub === 'build') args.push('--config', JSON.stringify({ version }))
const bin = join(desktop, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri')
const started = Date.now()
const r = spawnSync(bin, args, { cwd: desktop, stdio: 'inherit', shell: process.platform === 'win32' })
if (r.status === 0 && sub === 'build' && args.indexOf('--no-bundle') === -1) collect()
process.exit(r.status == null ? 1 : r.status)

// ---- 构建产物 → desktop/release ----
function archOf(triple) {
	const a = (triple || '').split('-')[0] || process.arch
	if (a === 'aarch64' || a === 'arm64') return 'arm64'
	if (a === 'x86_64' || a === 'x64') return 'x64'
	if (a === 'i686' || a === 'ia32') return 'x86'
	return a
}

// 本次构建的 bundle 目录：带 --target 时在 target/<triple>/release/bundle，否则 target/release/bundle
function bundleDirs() {
	const target = join(desktop, 'src-tauri', 'target')
	const dirs = []
	const plain = join(target, 'release', 'bundle')
	if (existsSync(plain)) dirs.push({ dir: plain, arch: archOf(process.arch) })
	if (existsSync(target)) {
		for (const t of readdirSync(target)) {
			const d = join(target, t, 'release', 'bundle')
			if (t.indexOf('-') !== -1 && existsSync(d)) dirs.push({ dir: d, arch: t === 'universal-apple-darwin' ? 'universal' : archOf(t) })
		}
	}
	return dirs
}

// 只认本次构建写出的文件，旧版本残留在 bundle 目录里的不拿
function fresh(p) {
	try { return statSync(p).mtimeMs >= started - 1000 } catch (e) { return false }
}

function list(dir, ext) {
	if (!existsSync(dir)) return []
	return readdirSync(dir).filter((n) => n.toLowerCase().endsWith(ext)).map((n) => join(dir, n)).filter(fresh)
}

function collect() {
	const out = join(desktop, 'release')
	const jobs = []
	for (const { dir, arch } of bundleDirs()) {
		const base = 'Serial-Debug_' + version + '_'
		list(join(dir, 'dmg'), '.dmg').forEach((f) => jobs.push({ from: f, name: base + 'macos_' + arch + '.dmg' }))
		list(join(dir, 'macos'), '.app').forEach((f) => jobs.push({ from: f, name: base + 'macos_' + arch + '.app.zip', zip: true }))
		list(join(dir, 'nsis'), '.exe').forEach((f) => jobs.push({ from: f, name: base + 'windows_' + arch + '-setup.exe' }))
		list(join(dir, 'msi'), '.msi').forEach((f) => jobs.push({ from: f, name: base + 'windows_' + arch + '.msi' }))
	}
	if (!jobs.length) {
		console.warn('release: 没找到本次构建的安装包，desktop/release 保持不变')
		return
	}
	rmSync(out, { recursive: true, force: true })
	mkdirSync(out, { recursive: true })
	for (const j of jobs) {
		const dest = join(out, j.name)
		if (j.zip) {
			// ditto 保留 .app 的符号链接、扩展属性与签名，zip 命令会弄坏
			const z = spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', j.from, dest], { stdio: 'inherit' })
			if (z.status !== 0) {
				console.warn('release: 打包 ' + basename(j.from) + ' 失败，跳过')
				continue
			}
		} else {
			copyFileSync(j.from, dest)
		}
		console.log('release: ' + basename(j.from) + ' → desktop/release/' + j.name)
	}
}
