// Windows 便携包：直接归档 Tauri release 主程序 + 更新 helper，不调用 NSIS / MSI。
// 便携包同时就是应用内更新的载荷：客户端下载它、验签、由 helper 在主程序退出后替换 EXE。
// 配了更新签名时对 ZIP 生成 .sig(流水线与客户端都按这个签名判断能不能装)。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 便携包里固定的三个文件名；EXE_ENTRY 与 helper 名必须与 portable-update-common 里的常量一致
export const EXE_ENTRY = 'Serial Debug.exe'
export const HELPER_FILE = 'serial-debug-updater.exe'
export const README_ENTRY = 'README.txt'

export function buildTarget(args) {
	const i = args.indexOf('--target')
	return i >= 0 ? args[i + 1] : (args.find(a => a.startsWith('--target=')) || '').slice(9)
}

// 与 tauri.mjs 找主程序用同一个 target 目录：CARGO_TARGET_DIR 是相对路径时相对 src-tauri，
// 绝对路径时就是它自己(必须用 resolve，不要用 join——join('/a','/b') 会得到 '/a/b')。
export function cargoTargetDir(desktop, dir = process.env.CARGO_TARGET_DIR || 'target') {
	return resolve(desktop, 'src-tauri', dir)
}

export function helperBinary({ desktop, target, debug = false }) {
	return join(cargoTargetDir(desktop), target || '', debug ? 'debug' : 'release', HELPER_FILE)
}

export function readmeText(version) {
	return '\ufeffSerial Debug ' + version + '\r\n\r\n' +
		'解压全部文件后运行 Serial Debug.exe，无需安装或管理员权限。\r\n' +
		'serial-debug-updater.exe 是应用内更新用的助手，请与主程序放在同一文件夹，不要删除或改名。\r\n' +
		'需要 Windows 10/11 与 Microsoft Edge WebView2 Runtime。\r\n' +
		'如无法启动，请从 https://developer.microsoft.com/microsoft-edge/webview2/ 安装 Evergreen Runtime。\r\n' +
		'应用内更新会自行下载并替换程序，不需要手动解压；也可以退出程序后手动解压新版覆盖。\r\n' +
		'配置保存在当前用户的应用数据目录，不随 ZIP 携带。\r\n'
}

// 对便携 ZIP 生成更新签名。私钥不写进命令行(ps / 进程列表可见)，只经子进程环境变量
// TAURI_SIGNING_PRIVATE_KEY 传递(CLI 文档里 -k 的 env 就是它)；给的是文件路径时先读出来，
// 因为 signer sign 只接受字面私钥。--app-version 把版本写进签名的信任注释，
// 客户端的 requireSignedVersion 依赖它。
export function signArchive({ archive, version, run = spawnSync, env = process.env, cli = defaultCli() }) {
	const configured = String(env.TAURI_SIGNING_PRIVATE_KEY || '').trim()
	if (!configured) return null
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本必须是三段 SemVer')
	const key = existsSync(configured) ? readFileSync(configured, 'utf8').trim() : configured
	if (!key) throw new Error('更新签名私钥为空，无法签名')
	const args = [cli.path, 'signer', 'sign', '--app-version', version, archive]
	const childEnv = { ...env, TAURI_SIGNING_PRIVATE_KEY: key }
	const result = run(process.execPath, args, { stdio: 'inherit', env: childEnv })
	if (result.error || result.status !== 0) throw new Error('更新包签名失败', { cause: result.error })
	const signature = archive + '.sig'
	if (!existsSync(signature)) throw new Error('签名工具没有生成 .sig 文件')
	const text = readFileSync(signature, 'utf8').trim()
	if (!/^[A-Za-z0-9+/=]+$/.test(text)) throw new Error('更新包签名内容无效')
	return text
}

function defaultCli() {
	const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
	return { path: join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js') }
}

export function packageWindows({ desktop, version, channel, target, debug = false, run = spawnSync, env = process.env }) {
	if (!['main', 'dev'].includes(channel)) throw new Error('未知发布通道')
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本必须是三段 SemVer')
	if (target && !target.endsWith('-pc-windows-msvc')) throw new Error('Windows 便携包只支持 MSVC 目标，避免缺少运行时 DLL')
	const arch = target ? target.split('-')[0] : process.arch
	const archName = ({ x86_64: 'x64', aarch64: 'arm64', i686: 'x86', ia32: 'x86' })[arch] || arch
	const executable = join(cargoTargetDir(desktop), target || '', debug ? 'debug' : 'release', 'serial-debug.exe')
	if (!existsSync(executable)) throw new Error('找不到本次构建的 Windows 主程序')
	const helper = helperBinary({ desktop, target, debug })
	if (!existsSync(helper)) throw new Error('找不到更新助手 serial-debug-updater.exe，请先构建 desktop/portable-updater')
	const staging = mkdtempSync(join(tmpdir(), 'serial-debug-portable-'))
	const name = `Serial-Debug_${version}_windows_${archName}.zip`
	try {
		copyFileSync(executable, join(staging, EXE_ENTRY))
		copyFileSync(helper, join(staging, HELPER_FILE))
		writeFileSync(join(staging, README_ENTRY), readmeText(version), 'utf8')
		// 路径经环境变量传给 PowerShell，避免空格、引号等进入脚本语法。
		const archive = join(staging, name)
		const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath (Join-Path $env:SERIAL_ZIP_STAGE "Serial Debug.exe"),(Join-Path $env:SERIAL_ZIP_STAGE "serial-debug-updater.exe"),(Join-Path $env:SERIAL_ZIP_STAGE "README.txt") -DestinationPath $env:SERIAL_ZIP_OUT -CompressionLevel Optimal -Force'], {
			stdio: 'inherit', env: { ...env, SERIAL_ZIP_STAGE: staging, SERIAL_ZIP_OUT: archive }
		})
		if (result.error || result.status !== 0 || !existsSync(archive)) throw new Error('Windows ZIP 打包失败', { cause: result.error })
		// 只有配了更新签名才签：本地无签名构建仍可手动解压使用，但不会被客户端当成可安装的更新
		let signature = null
		if (String(env.TAURI_UPDATER_PUBLIC_KEY || '').trim() && String(env.TAURI_SIGNING_PRIVATE_KEY || '').trim()) {
			signature = signArchive({ archive, version, run, env })
		}
		const out = join(desktop, 'release', channel)
		// ZIP 与签名都成功后才替换本通道，失败时保留上一版。
		rmSync(out, { recursive: true, force: true })
		mkdirSync(out, { recursive: true })
		copyFileSync(archive, join(out, name))
		if (signature) copyFileSync(archive + '.sig', join(out, name + '.sig'))
		console.log('release: desktop/release/' + channel + '/' + name)
		return join(out, name)
	} finally { rmSync(staging, { recursive: true, force: true }) }
}
