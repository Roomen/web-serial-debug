import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { buildTarget, cargoTargetDir, helperBinary, packageWindows } from './portable-windows.mjs'

const TARGET = 'x86_64-pc-windows-msvc'

function fixture(tag = 'portable test') {
	const desktop = mkdtempSync(join(tmpdir(), tag + '-'))
	const binaryDir = join(desktop, 'src-tauri', 'target', TARGET, 'release')
	mkdirSync(binaryDir, { recursive: true })
	writeFileSync(join(binaryDir, 'serial-debug.exe'), 'test executable')
	writeFileSync(join(binaryDir, 'serial-debug-updater.exe'), 'test helper')
	for (const channel of ['main', 'dev']) {
		mkdirSync(join(desktop, 'release', channel), { recursive: true })
		writeFileSync(join(desktop, 'release', channel, 'old.zip'), channel)
	}
	return { desktop, target: TARGET, version: '1.2.3', channel: 'dev' }
}

test('target supports separate and equals CLI syntax', () => {
	assert.equal(buildTarget(['build', '--target', TARGET]), TARGET)
	assert.equal(buildTarget(['build', '--target=aarch64-pc-windows-msvc']), 'aarch64-pc-windows-msvc')
	assert.equal(buildTarget(['build']), '')
})

test('ZIP stages program, update helper and instructions; replaces only selected channel', () => {
	const options = fixture()
	let staging
	try {
		const result = packageWindows({ ...options, env: {}, run(command, args, config) {
			assert.equal(command, 'powershell.exe')
			assert.ok(args.includes('-NonInteractive'))
			staging = config.env.SERIAL_ZIP_STAGE
			assert.deepEqual(readdirSync(staging).sort(), ['README.txt', 'Serial Debug.exe', 'serial-debug-updater.exe'])
			assert.equal(readFileSync(join(staging, 'Serial Debug.exe'), 'utf8'), 'test executable')
			assert.equal(readFileSync(join(staging, 'serial-debug-updater.exe'), 'utf8'), 'test helper')
			const readme = readFileSync(join(staging, 'README.txt'), 'utf8')
			assert.match(readme, /WebView2/)
			assert.match(readme, /serial-debug-updater\.exe/)
			assert.match(readme, /应用内更新/)
			writeFileSync(config.env.SERIAL_ZIP_OUT, 'mock archive')
			return { status: 0 }
		} })
		assert.equal(readFileSync(result, 'utf8'), 'mock archive')
		assert.deepEqual(readdirSync(join(options.desktop, 'release', 'dev')), ['Serial-Debug_1.2.3_windows_x64.zip'])
		assert.equal(readFileSync(join(options.desktop, 'release', 'main', 'old.zip'), 'utf8'), 'main')
		assert.equal(existsSync(staging), false)
	} finally { rmSync(options.desktop, { recursive: true, force: true }) }
})

test('archiving failure preserves previous artifacts and cleans temporary files', () => {
	const options = fixture()
	let staging
	try {
		assert.throws(() => packageWindows({ ...options, env: {}, run(command, args, config) {
			staging = config.env.SERIAL_ZIP_STAGE
			return { status: 1 }
		} }), /ZIP 打包失败/)
		assert.equal(existsSync(staging), false)
		assert.equal(readFileSync(join(options.desktop, 'release', 'dev', 'old.zip'), 'utf8'), 'dev')
	} finally { rmSync(options.desktop, { recursive: true, force: true }) }
})

test('missing update helper fails before archiving anything', () => {
	const options = fixture()
	try {
		rmSync(helperBinary(options), { force: true })
		assert.throws(() => packageWindows({ ...options, env: {}, run() { throw new Error('must not archive') } }), /更新助手/)
		assert.equal(readFileSync(join(options.desktop, 'release', 'dev', 'old.zip'), 'utf8'), 'dev')
	} finally { rmSync(options.desktop, { recursive: true, force: true }) }
})

test('signing runs the pinned Tauri CLI with the target version and keeps .sig next to the ZIP', () => {
	const options = fixture('signing')
	let signArgs
	try {
		const env = { TAURI_UPDATER_PUBLIC_KEY: 'public', TAURI_SIGNING_PRIVATE_KEY: 'secret-key-value' }
		let signEnv
		const result = packageWindows({ ...options, env, run(command, args, config) {
			if (command === 'powershell.exe') {
				writeFileSync(config.env.SERIAL_ZIP_OUT, 'mock archive')
				return { status: 0 }
			}
			// signer sign：私钥只经环境变量传递，绝不出现在命令行参数里(ps 可见)
			assert.equal(command, process.execPath)
			signArgs = args
			signEnv = config.env
			assert.ok(!args.includes('secret-key-value'), '私钥不能进 argv')
			assert.ok(!args.includes('-k') && !args.includes('-f'), '不要用把私钥放命令行的参数形式')
			const archive = args[args.length - 1]
			writeFileSync(archive + '.sig', 'c2lnbmF0dXJl\n')
			return { status: 0 }
		} })
		const cliIndex = signArgs.findIndex((a) => a === 'signer')
		assert.equal(signArgs[cliIndex + 1], 'sign')
		assert.equal(signArgs[signArgs.indexOf('--app-version') + 1], '1.2.3')
		assert.equal(signEnv.TAURI_SIGNING_PRIVATE_KEY, 'secret-key-value', '私钥经子进程环境变量传递')
		assert.match(result, /windows_x64\.zip$/)
		assert.deepEqual(readdirSync(join(options.desktop, 'release', 'dev')).sort(), ['Serial-Debug_1.2.3_windows_x64.zip', 'Serial-Debug_1.2.3_windows_x64.zip.sig'])
		assert.equal(readFileSync(join(options.desktop, 'release', 'dev', 'Serial-Debug_1.2.3_windows_x64.zip.sig'), 'utf8').trim(), 'c2lnbmF0dXJl')
	} finally { rmSync(options.desktop, { recursive: true, force: true }) }
})

test('a private key file is read and passed through the environment, not the command line', () => {
	const options = fixture('key-file')
	const keyFile = join(options.desktop, 'signing.key')
	writeFileSync(keyFile, 'file-secret-value\n')
	try {
		let seen
		packageWindows({ ...options, env: { TAURI_UPDATER_PUBLIC_KEY: 'public', TAURI_SIGNING_PRIVATE_KEY: keyFile }, run(command, args, config) {
			if (command === 'powershell.exe') {
				writeFileSync(config.env.SERIAL_ZIP_OUT, 'mock archive')
				return { status: 0 }
			}
			seen = { args, env: config.env }
			writeFileSync(args[args.length - 1] + '.sig', 'c2lnbmF0dXJl\n')
			return { status: 0 }
		} })
		assert.equal(seen.env.TAURI_SIGNING_PRIVATE_KEY, 'file-secret-value', '路径要先读成私钥内容')
		assert.ok(!seen.args.some((a) => a.includes('file-secret-value') || a === keyFile), '私钥与其路径都不进 argv')
	} finally { rmSync(options.desktop, { recursive: true, force: true }) }
})

test('signing failure fails the build instead of publishing an unsigned update', () => {
	const options = fixture('sign-fail')
	try {
		const env = { TAURI_UPDATER_PUBLIC_KEY: 'public', TAURI_SIGNING_PRIVATE_KEY: 'secret-key' }
		assert.throws(() => packageWindows({ ...options, env, run(command, args, config) {
			if (command === 'powershell.exe') {
				writeFileSync(config.env.SERIAL_ZIP_OUT, 'mock archive')
				return { status: 0 }
			}
			return { status: 1 }
		} }), /签名失败/)
		assert.equal(readFileSync(join(options.desktop, 'release', 'dev', 'old.zip'), 'utf8'), 'dev', '签名失败不能覆盖上一版')
	} finally { rmSync(options.desktop, { recursive: true, force: true }) }
})

test('no public key means an unsigned local ZIP is still produced', () => {
	const options = fixture('unsigned')
	try {
		const result = packageWindows({ ...options, env: { TAURI_SIGNING_PRIVATE_KEY: 'secret-key' }, run(command, args, config) {
			if (command === 'powershell.exe') {
				writeFileSync(config.env.SERIAL_ZIP_OUT, 'mock archive')
				return { status: 0 }
			}
			throw new Error('signing must not run without a public key')
		} })
		assert.ok(existsSync(result))
		assert.deepEqual(readdirSync(join(options.desktop, 'release', 'dev')), ['Serial-Debug_1.2.3_windows_x64.zip'])
	} finally { rmSync(options.desktop, { recursive: true, force: true }) }
})

test('Windows PowerShell produces an extractable ZIP with program, helper and README at root', { skip: process.platform !== 'win32' }, () => {
	const options = fixture()
	try {
		const archive = packageWindows(options)
		const extracted = join(options.desktop, 'extracted')
		const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:SERIAL_ZIP_OUT -DestinationPath $env:SERIAL_ZIP_EXTRACT'], {
			encoding: 'utf8', env: { ...process.env, SERIAL_ZIP_OUT: archive, SERIAL_ZIP_EXTRACT: extracted }
		})
		assert.equal(result.status, 0, result.stderr)
		assert.deepEqual(readdirSync(extracted).sort(), ['README.txt', 'Serial Debug.exe', 'serial-debug-updater.exe'])
		assert.equal(readFileSync(join(extracted, 'Serial Debug.exe'), 'utf8'), 'test executable')
		assert.equal(readFileSync(join(extracted, 'serial-debug-updater.exe'), 'utf8'), 'test helper')
	} finally { rmSync(options.desktop, { recursive: true, force: true }) }
})

test('absolute CARGO_TARGET_DIR is used as-is, relative one hangs off src-tauri', () => {
	// join('/a/src-tauri', '/tmp/x') 会得到 '/a/src-tauri/tmp/x'，必须用 resolve 语义。
	// 期望值要从平台原生路径算出来：Windows 上 resolve 会把 '/tmp/x' 变成 '<盘符>:\tmp\x'，
	// 直接写 Unix 字面量会让这条断言在 Windows runner 上必失败。
	const desktop = resolve(tmpdir(), 'portable-target-desktop')
	const absolute = resolve(tmpdir(), 'portable-absolute-target')
	assert.equal(cargoTargetDir(desktop, absolute), absolute, '绝对路径原样使用')
	assert.equal(cargoTargetDir(desktop, 'custom-target'), join(desktop, 'src-tauri', 'custom-target'))
	assert.equal(cargoTargetDir(desktop, 'target'), join(desktop, 'src-tauri', 'target'))
	// 相对路径必须挂在 src-tauri 下，不能变成相对 cwd 的 resolve
	assert.equal(cargoTargetDir(desktop, 'custom-target').startsWith(join(desktop, 'src-tauri')), true)
})

test('absolute CARGO_TARGET_DIR packages the helper from that directory', () => {
	const options = fixture('absolute-target')
	const previous = process.env.CARGO_TARGET_DIR
	const absolute = join(options.desktop, 'outside', 'target')
	try {
		process.env.CARGO_TARGET_DIR = absolute
		const dir = join(absolute, options.target, 'release')
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'serial-debug.exe'), 'abs executable')
		writeFileSync(join(dir, 'serial-debug-updater.exe'), 'abs helper')
		packageWindows({ ...options, env: {}, run(command, args, config) {
			assert.equal(readFileSync(join(config.env.SERIAL_ZIP_STAGE, 'Serial Debug.exe'), 'utf8'), 'abs executable')
			assert.equal(readFileSync(join(config.env.SERIAL_ZIP_STAGE, 'serial-debug-updater.exe'), 'utf8'), 'abs helper')
			writeFileSync(config.env.SERIAL_ZIP_OUT, 'archive')
			return { status: 0 }
		} })
	} finally {
		if (previous === undefined) delete process.env.CARGO_TARGET_DIR
		else process.env.CARGO_TARGET_DIR = previous
		rmSync(options.desktop, { recursive: true, force: true })
	}
})

test('relative CARGO_TARGET_DIR follows Cargo src-tauri working directory', () => {
	const options = fixture('custom-target')
	const previous = process.env.CARGO_TARGET_DIR
	try {
		process.env.CARGO_TARGET_DIR = 'custom-target'
		const dir = join(options.desktop, 'src-tauri', 'custom-target', options.target, 'release')
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'serial-debug.exe'), 'custom-target executable')
		writeFileSync(join(dir, 'serial-debug-updater.exe'), 'custom-target helper')
		packageWindows({ ...options, env: {}, run(command, args, config) {
			assert.equal(readFileSync(join(config.env.SERIAL_ZIP_STAGE, 'Serial Debug.exe'), 'utf8'), 'custom-target executable')
			assert.equal(readFileSync(join(config.env.SERIAL_ZIP_STAGE, 'serial-debug-updater.exe'), 'utf8'), 'custom-target helper')
			writeFileSync(config.env.SERIAL_ZIP_OUT, 'archive')
			return { status: 0 }
		} })
	} finally {
		if (previous === undefined) delete process.env.CARGO_TARGET_DIR
		else process.env.CARGO_TARGET_DIR = previous
		rmSync(options.desktop, { recursive: true, force: true })
	}
})

test('GNU target is rejected rather than publishing a ZIP missing loader DLLs', () => {
	assert.throws(() => packageWindows({ desktop: '/unused', version: '1.2.3', channel: 'dev', target: 'x86_64-pc-windows-gnu' }), /只支持 MSVC/)
})

test('the build wrapper compiles the helper into the directory the packager reads from', async () => {
	// tauri.mjs 与 portable-windows.mjs 必须共用同一套 target 目录规则：
	// 绝对 CARGO_TARGET_DIR 用 join 会拼成 src-tauri/<绝对路径>，helper 编到别处，打包时报「找不到更新助手」。
	const source = readFileSync(new URL('./tauri.mjs', import.meta.url), 'utf8')
	assert.match(source, /import \{[^}]*cargoTargetDir[^}]*\} from '\.\/portable-windows\.mjs'/, 'tauri.mjs 必须复用 cargoTargetDir')
	assert.match(source, /const helperTargetDir = cargoTargetDir\(desktop\)/, 'helper 编译目录必须来自 cargoTargetDir')
	assert.doesNotMatch(source, /join\(desktop, 'src-tauri', process\.env\.CARGO_TARGET_DIR/, '不要自己拼 target 目录')
	// 包装脚本生成的可执行文件路径与打包脚本读的路径一致（两种目录形态都覆盖）
	for (const dir of [resolve(tmpdir(), 'portable-abs-target'), 'custom-target']) {
		const previous = process.env.CARGO_TARGET_DIR
		try {
			process.env.CARGO_TARGET_DIR = dir
			const desktop = resolve(tmpdir(), 'portable-wrapper-desktop')
			const helper = helperBinary({ desktop, target: 'x86_64-pc-windows-msvc' })
			assert.ok(helper.startsWith(cargoTargetDir(desktop)), `${dir}: ${helper}`)
		} finally {
			if (previous === undefined) delete process.env.CARGO_TARGET_DIR
			else process.env.CARGO_TARGET_DIR = previous
		}
	}
})
