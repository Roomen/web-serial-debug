// Windows 便携包：直接归档 Tauri release 主程序，不调用 NSIS / MSI。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export function buildTarget(args) {
	const i = args.indexOf('--target')
	return i >= 0 ? args[i + 1] : (args.find(a => a.startsWith('--target=')) || '').slice(9)
}

export function packageWindows({ desktop, version, channel, target, debug = false, run = spawnSync }) {
	if (!['main', 'dev'].includes(channel)) throw new Error('未知发布通道')
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('版本必须是三段 SemVer')
	if (target && !target.endsWith('-pc-windows-msvc')) throw new Error('Windows 便携包只支持 MSVC 目标，避免缺少运行时 DLL')
	const arch = target ? target.split('-')[0] : process.arch
	const archName = ({ x86_64: 'x64', aarch64: 'arm64', i686: 'x86', ia32: 'x86' })[arch] || arch
	const executable = join(resolve(desktop, 'src-tauri', process.env.CARGO_TARGET_DIR || 'target'), target || '', debug ? 'debug' : 'release', 'serial-debug.exe')
	if (!existsSync(executable)) throw new Error('找不到本次构建的 Windows 主程序')
	const staging = mkdtempSync(join(tmpdir(), 'serial-debug-portable-'))
	const name = `Serial-Debug_${version}_windows_${archName}.zip`
	try {
		copyFileSync(executable, join(staging, 'Serial Debug.exe'))
		writeFileSync(join(staging, 'README.txt'), '\ufeffSerial Debug ' + version + '\r\n\r\n解压全部文件后运行 Serial Debug.exe，无需安装。\r\n需要 Windows 10/11 与 Microsoft Edge WebView2 Runtime。\r\n如无法启动，请从 https://developer.microsoft.com/microsoft-edge/webview2/ 安装 Evergreen Runtime。\r\n更新时先退出所有窗口，再解压新版替换程序。配置保存在当前用户的应用数据目录，不随 ZIP 携带。\r\n', 'utf8')
		// 路径经环境变量传给 PowerShell，避免空格、引号等进入脚本语法。
		const archive = join(staging, name)
		const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath (Join-Path $env:SERIAL_ZIP_STAGE "Serial Debug.exe"),(Join-Path $env:SERIAL_ZIP_STAGE "README.txt") -DestinationPath $env:SERIAL_ZIP_OUT -CompressionLevel Optimal -Force'], {
			stdio: 'inherit', env: { ...process.env, SERIAL_ZIP_STAGE: staging, SERIAL_ZIP_OUT: archive }
		})
		if (result.error || result.status !== 0 || !existsSync(archive)) throw new Error('Windows ZIP 打包失败', { cause: result.error })
		const out = join(desktop, 'release', channel)
		// ZIP 成功后才替换本通道，失败时保留上一版。
		rmSync(out, { recursive: true, force: true })
		mkdirSync(out, { recursive: true })
		copyFileSync(archive, join(out, name))
		console.log('release: desktop/release/' + channel + '/' + name)
		return join(out, name)
	} finally { rmSync(staging, { recursive: true, force: true }) }
}
