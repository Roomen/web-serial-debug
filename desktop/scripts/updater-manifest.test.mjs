import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compareVersions, createManifest } from './updater-manifest.mjs'
import { promotePointer } from './channel-pointer.mjs'
import { macSigningConfig, updaterConfig } from './release-config.mjs'

test('macOS updater manifest uses immutable assets; portable Windows has no installer update', () => {
	const dir = mkdtempSync(join(tmpdir(), 'updater-'))
	try {
		for (const name of ['macos_arm64.app.tar.gz']) {
			writeFileSync(join(dir, 'Serial-Debug_1.71.0_' + name), 'package')
			writeFileSync(join(dir, 'Serial-Debug_1.71.0_' + name + '.sig'), 'c2lnbmF0dXJl\n')
		}
		const args = { directory: dir, version: '1.71.0', channel: 'dev', previous: { version: '1.70.9' } }
		const manifest = createManifest(args)
		assert.equal(Object.keys(manifest.platforms).length, 1)
		assert.equal(manifest.platforms['darwin-aarch64'].signature, 'c2lnbmF0dXJl')
		assert.equal(manifest.platforms['windows-x86_64'], undefined)
		assert.equal(manifest.platforms['darwin-x86_64'], undefined)
		assert.equal(manifest.platforms['windows-x86_64-nsis'], undefined)
		assert.equal(manifest.platforms['windows-x86_64-msi'], undefined)
		assert.throws(() => createManifest({ ...args, previous: { version: '1.71.0' } }), /必须高于/)
		assert.throws(() => createManifest({ ...args, previous: { version: '2.0.0' } }), /必须高于/)
		rmSync(join(dir, 'Serial-Debug_1.71.0_macos_arm64.app.tar.gz.sig'))
		assert.throws(() => createManifest(args), /ENOENT/)
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

test('Windows ZIP never enables the installer updater even with signing keys', () => {
	const config = updaterConfig('main', { TAURI_UPDATER_PUBLIC_KEY: 'public', TAURI_SIGNING_PRIVATE_KEY: 'secret' }, 'win32')
	assert.equal(config.bundle.createUpdaterArtifacts, false)
	assert.equal(config.plugins.updater.pubkey, '')
	assert.equal(config.plugins.updater.endpoints, undefined)
})
