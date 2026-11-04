import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compareVersions, createManifest } from './updater-manifest.mjs'
import { promotePointer } from './channel-pointer.mjs'
import { macSigningConfig, updaterConfig } from './release-config.mjs'

function packages(dir, version, names) {
	for (const name of names) {
		const file = `Serial-Debug_${version}_${name}`
		writeFileSync(join(dir, file), 'package')
		writeFileSync(join(dir, file + '.sig'), 'c2lnbmF0dXJl\n')
	}
}

test('manifest covers macOS installer update and Windows portable update, nothing else', () => {
	const dir = mkdtempSync(join(tmpdir(), 'updater-'))
	try {
		packages(dir, '1.71.0', ['macos_arm64.app.tar.gz', 'windows_x64.zip'])
		const args = { directory: dir, version: '1.71.0', channel: 'dev', previous: { version: '1.70.9' } }
		const manifest = createManifest(args)
		assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-aarch64', 'windows-x86_64'])
		assert.equal(manifest.platforms['darwin-aarch64'].signature, 'c2lnbmF0dXJl')
		// Windows 便携版没有安装器产物，平台键不带 nsis / msi 后缀
		assert.equal(manifest.platforms['windows-x86_64-nsis'], undefined)
		assert.equal(manifest.platforms['windows-x86_64-msi'], undefined)
		assert.equal(manifest.platforms['darwin-x86_64'], undefined)
		assert.match(manifest.platforms['windows-x86_64'].url, /desktop-dev-v1\.71\.0\/Serial-Debug_1\.71\.0_windows_x64\.zip$/)
		assert.throws(() => createManifest({ ...args, previous: { version: '1.71.0' } }), /必须高于/)
		assert.throws(() => createManifest({ ...args, previous: { version: '2.0.0' } }), /必须高于/)
		// 任一平台的签名无效都失败(先坏 Windows 的签名，macOS 的仍有效)
		writeFileSync(join(dir, 'Serial-Debug_1.71.0_windows_x64.zip.sig'), 'not a signature !!')
		assert.throws(() => createManifest(args), /签名无效: Serial-Debug_1\.71\.0_windows_x64\.zip/)
		// 签名文件缺失也是失败，不是跳过该平台
		rmSync(join(dir, 'Serial-Debug_1.71.0_macos_arm64.app.tar.gz.sig'))
		assert.throws(() => createManifest(args), /ENOENT/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a manifest missing either platform fails instead of publishing a partial one', () => {
	const dir = mkdtempSync(join(tmpdir(), 'updater-'))
	try {
		// 只有 Windows 包：macOS 客户端必须也拿不到半份清单，构建直接失败
		packages(dir, '1.71.0', ['windows_x64.zip'])
		assert.throws(() => createManifest({ directory: dir, version: '1.71.0', channel: 'main' }), /缺少更新包: Serial-Debug_1\.71\.0_macos_arm64\.app\.tar\.gz/)
		// 只有 macOS 包：同样失败
		rmSync(join(dir, 'Serial-Debug_1.71.0_windows_x64.zip'))
		rmSync(join(dir, 'Serial-Debug_1.71.0_windows_x64.zip.sig'))
		packages(dir, '1.71.0', ['macos_arm64.app.tar.gz'])
		assert.throws(() => createManifest({ directory: dir, version: '1.71.0', channel: 'main' }), /缺少更新包: Serial-Debug_1\.71\.0_windows_x64\.zip/)
	} finally { rmSync(dir, { recursive: true, force: true }) }
})

test('version comparison is numeric and malformed versions fail closed', () => {
	assert.equal(compareVersions('1.10.0', '1.9.99'), 1)
	assert.throws(() => compareVersions('1.0.0-dev', '1.0.0'))
})

test('unsigned local builds cannot generate updater artifacts', () => {
	const localConfig = updaterConfig('dev', {}, 'darwin')
	assert.equal(localConfig.bundle.createUpdaterArtifacts, false)
	assert.equal(typeof localConfig.plugins.updater, 'object')
	assert.equal(localConfig.plugins.updater.pubkey, '')
	assert.equal('endpoints' in localConfig.plugins.updater, false)
	assert.equal(updaterConfig('dev', { TAURI_UPDATER_PUBLIC_KEY: 'public' }, 'darwin').bundle.createUpdaterArtifacts, false)
	const config = updaterConfig('main', { TAURI_UPDATER_PUBLIC_KEY: 'public', TAURI_SIGNING_PRIVATE_KEY: 'secret' }, 'darwin')
	assert.equal(config.bundle.createUpdaterArtifacts, true)
	assert.match(config.plugins.updater.endpoints[0], /desktop-main\/latest.json$/)
	assert.equal(config.plugins.updater.pubkey, 'public')
})


test('pointer rename keeps old bytes and restores the old name after a failed promotion', () => {
	const old = { id: 1, name: 'latest.json' }, staged = { id: 2, name: 'stage.json' }
	const assets = [old, staged]
	const api = (path, body) => {
		if (!body) return { assets }
		if (path === '2') throw new Error('upload rename failure')
		assets.find(a => String(a.id) === path).name = body.name
	}
	assert.throws(() => promotePointer({ old, staged, backupName: 'backup.json', api, releasePath: 'release', assetPath: String }), /rename failure/)
	assert.equal(old.name, 'latest.json')
	assert.equal(staged.name, 'stage.json')
})

test('pointer response failure after successful promotion does not undo the new pointer', () => {
	const old = { id: 1, name: 'latest.json' }, staged = { id: 2, name: 'stage.json' }
	const assets = [old, staged]
	const api = (path, body) => {
		if (!body) return { assets }
		assets.find(a => String(a.id) === path).name = body.name
		if (path === '2') throw new Error('response lost')
	}
	promotePointer({ old, staged, backupName: 'backup.json', api, releasePath: 'release', assetPath: String })
	assert.equal(old.name, 'backup.json')
	assert.equal(staged.name, 'latest.json')
})

test('macOS builds without Developer ID are ad-hoc signed as a whole bundle', () => {
	assert.deepEqual(macSigningConfig({}, 'darwin'), { bundle: { macOS: { signingIdentity: '-' } } })
	assert.deepEqual(macSigningConfig({ APPLE_SIGNING_IDENTITY: 'Developer ID Application: X' }, 'darwin'), {})
	assert.deepEqual(macSigningConfig({}, 'win32'), {})
})

test('Windows portable updates use the same signed channel but never build installer artifacts', () => {
	const config = updaterConfig('main', { TAURI_UPDATER_PUBLIC_KEY: 'public', TAURI_SIGNING_PRIVATE_KEY: 'secret' }, 'win32')
	// 便携 ZIP 由 portable-windows.mjs 自己签名，tauri 不生成安装器更新产物
	assert.equal(config.bundle.createUpdaterArtifacts, false)
	// 但检查/下载仍走同一套端点与公钥
	assert.equal(config.plugins.updater.pubkey, 'public')
	assert.equal(config.plugins.updater.requireSignedVersion, true)
	assert.match(config.plugins.updater.endpoints[0], /desktop-main\/latest\.json$/)
})

test('signature version binding is requested so a new version cannot pair with an old signed package', () => {
	const mac = updaterConfig('dev', { TAURI_UPDATER_PUBLIC_KEY: 'public', TAURI_SIGNING_PRIVATE_KEY: 'secret' }, 'darwin')
	assert.equal(mac.plugins.updater.requireSignedVersion, true)
	assert.equal(mac.bundle.createUpdaterArtifacts, true)
	// 没有私钥时 macOS 不出更新包，但配置里仍要求版本绑定
	const unsigned = updaterConfig('dev', { TAURI_UPDATER_PUBLIC_KEY: 'public' }, 'darwin')
	assert.equal(unsigned.bundle.createUpdaterArtifacts, false)
	assert.equal(unsigned.plugins.updater.requireSignedVersion, true)
})
