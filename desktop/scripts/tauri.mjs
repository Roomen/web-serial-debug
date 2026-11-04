// 包一层 tauri CLI：应用版本只来自 js/version.js(window.APP_VERSION)，每次经 --config 传入，tauri.conf.json 与 Cargo.toml 不写版本。
// build 成功后把安装包复制进 desktop/release/<通道>/(每个通道只留最新一版，不入库)：macOS 只有 .dmg，Windows 是便携 ZIP；配了更新签名时另带应用内更新用的包与 .sig。
// Windows 的便携 ZIP 里还要放更新 helper(desktop/portable-updater)，所以打包前先编译它；它内嵌的公钥必须与构建同一份配置。
// 通道两个：main(正式版，从 main 分支构建)与 dev(最新预览，其它分支构建都算)，按构建时所在的 git 分支判定，环境变量 RELEASE_CHANNEL=main|dev 可强制指定；
// 只清理并写入本通道的目录，另一个通道的包原样保留。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { macSigningConfig, releaseChannel, updaterConfig } from './release-config.mjs'
import { buildTarget, cargoTargetDir, packageWindows } from './portable-windows.mjs'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(desktop, '..', 'js', 'version.js'), 'utf8')
const m = src.match(/APP_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/)
if (!m) throw new Error('js/version.js 里找不到 APP_VERSION')
const version = m[1]

const channel = releaseChannel(desktop)
process.env.RELEASE_CHANNEL = channel
const args = process.argv.slice(2)
const sub = args[0]
const target = buildTarget(args)
const windows = target ? target.includes('-windows-') : process.platform === 'win32'
const skipPackage = args.includes('--no-bundle')
if (sub === 'build' && windows && !skipPackage) args.push('--no-bundle')
if (sub === 'dev' || sub === 'build') {
	const updater = updaterConfig(channel, process.env, windows ? 'win32' : process.platform)
	const mac = macSigningConfig()
	args.push('--config', JSON.stringify({ version, ...updater, bundle: { ...updater.bundle, ...mac.bundle } }))
}
const bin = join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const started = Date.now()
const r = spawnSync(process.execPath, [bin, ...args], { cwd: desktop, stdio: 'inherit' })
if (r.status === 0 && sub === 'build' && !skipPackage) {
	if (windows) {
		buildHelper(target, args.includes('--debug'))
		packageWindows({ desktop, version, channel, target, debug: args.includes('--debug') })
	}
	else collect()
}
process.exit(r.status == null ? 1 : r.status)

// 便携版更新 helper：与主程序同 target / 同 profile 编译，公钥经环境变量注入(build.rs 编译期内嵌)。
// 失败就让整个构建失败：没有 helper 的 ZIP 无法应用内更新，不能静默出一个半成品包。
function buildHelper(target, debug) {
	const args = ['build', '--manifest-path', join(desktop, 'portable-updater', 'Cargo.toml'), '--bin', 'serial-debug-updater']
	if (target) args.push('--target', target)
	if (!debug) args.push('--release')
	// helper 是独立包(不在 src-tauri 的依赖图里)，但产物要和主程序放在同一个 target 目录。
	// 必须复用 cargoTargetDir：CARGO_TARGET_DIR 是绝对路径时它原样返回，join 会拼成 src-tauri/<绝对路径>
	// 那种无效目录，helper 编译到别处而打包脚本按 resolve 去找，构建直接报「找不到更新助手」。
	const helperTargetDir = cargoTargetDir(desktop)
	const r = spawnSync('cargo', args, { cwd: desktop, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: helperTargetDir } })
	if (r.error || r.status !== 0) throw new Error('构建更新助手 serial-debug-updater 失败', { cause: r.error })
	console.log('release: 已编译更新助手 → ' + helperTargetDir)
}

// ---- 构建产物 → desktop/release/<通道> ----
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
	const root = join(desktop, 'release')
	const out = join(root, channel)
	const jobs = []
	for (const { dir, arch } of bundleDirs()) {
		const base = 'Serial-Debug_' + version + '_'
		list(join(dir, 'dmg'), '.dmg').forEach((f) => jobs.push({ from: f, name: base + 'macos_' + arch + '.dmg' }))
		list(join(dir, 'macos'), '.app.tar.gz').forEach((f) => jobs.push({ from: f, name: base + 'macos_' + arch + '.app.tar.gz', signature: true }))
	}
	if (!jobs.length) {
		console.warn('release: 没找到本次构建的安装包，desktop/release/' + channel + ' 保持不变')
		return
	}
	rmSync(out, { recursive: true, force: true })
	mkdirSync(out, { recursive: true })
	for (const j of jobs) {
		const dest = join(out, j.name)
		copyFileSync(j.from, dest)
		if (j.signature && existsSync(j.from + '.sig')) copyFileSync(j.from + '.sig', dest + '.sig')
		console.log('release: ' + basename(j.from) + ' → desktop/release/' + channel + '/' + j.name)
	}
}
