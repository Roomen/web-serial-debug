import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { buildTarget, packageWindows } from './portable-windows.mjs'

function fixture() {
	const desktop = mkdtempSync(join(tmpdir(), 'portable test-'))
	const target = 'x86_64-pc-windows-msvc'
	const binaryDir = join(desktop, 'src-tauri', 'target', target, 'release')
	mkdirSync(binaryDir, { recursive: true })
	writeFileSync(join(binaryDir, 'serial-debug.exe'), 'test executable')
	for (const channel of ['main', 'dev']) {
		mkdirSync(join(desktop, 'release', channel), { recursive: true })
		writeFileSync(join(desktop, 'release', channel, 'old.zip'), channel)
	}
	return { desktop, target, version: '1.2.3', channel: 'dev' }
}

test('target supports separate and equals CLI syntax', () => {
	assert.equal(buildTarget(['build', '--target', 'x86_64-pc-windows-msvc']), 'x86_64-pc-windows-msvc')
	assert.equal(buildTarget(['build', '--target=aarch64-pc-windows-msvc']), 'aarch64-pc-windows-msvc')
	assert.equal(buildTarget(['build']), '')
})

test('ZIP stages only main executable and instructions; replaces only selected channel', () => {
	const options = fixture()
	let staging
	try {
		const result = packageWindows({ ...options, run(command, args, config) {
			assert.equal(command, 'powershell.exe')
			assert.ok(args.includes('-NonInteractive'))
			staging = config.env.SERIAL_ZIP_STAGE
			assert.deepEqual(readdirSync(staging).sort(), ['README.txt', 'Serial Debug.exe'])
			assert.equal(readFileSync(join(staging, 'Serial Debug.exe'), 'utf8'), 'test executable')
			assert.match(readFileSync(join(staging, 'README.txt'), 'utf8'), /WebView2/)
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
		assert.throws(() => packageWindows({ ...options, run(command, args, config) {
			staging = config.env.SERIAL_ZIP_STAGE
			return { status: 1 }
		} }), /ZIP 打包失败/)
		assert.equal(existsSync(staging), false)
		assert.equal(readFileSync(join(options.desktop, 'release', 'dev', 'old.zip'), 'utf8'), 'dev')
	} finally { rmSync(options.desktop, { recursive: true, force: true }) }
})

test('Windows PowerShell produces an extractable ZIP with the executable at root', { skip: process.platform !== 'win32' }, () => {
	const options = fixture()
	try {
		const archive = packageWindows(options)
		const extracted = join(options.desktop, 'extracted')
		const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:SERIAL_ZIP_OUT -DestinationPath $env:SERIAL_ZIP_EXTRACT'], {
			encoding: 'utf8', env: { ...process.env, SERIAL_ZIP_OUT: archive, SERIAL_ZIP_EXTRACT: extracted }
		})
		assert.equal(result.status, 0, result.stderr)
		assert.deepEqual(readdirSync(extracted).sort(), ['README.txt', 'Serial Debug.exe'])
		assert.equal(readFileSync(join(extracted, 'Serial Debug.exe'), 'utf8'), 'test executable')
	} finally { rmSync(options.desktop, { recursive: true, force: true }) }
})


test('relative CARGO_TARGET_DIR follows Cargo src-tauri working directory', () => {
	const options = fixture()
	const previous = process.env.CARGO_TARGET_DIR
	try {
		process.env.CARGO_TARGET_DIR = 'custom-target'
		const dir = join(options.desktop, 'src-tauri', 'custom-target', options.target, 'release')
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'serial-debug.exe'), 'custom-target executable')
		packageWindows({ ...options, run(command, args, config) {
			assert.equal(readFileSync(join(config.env.SERIAL_ZIP_STAGE, 'Serial Debug.exe'), 'utf8'), 'custom-target executable')
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
