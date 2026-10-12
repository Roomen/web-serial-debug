import { spawnSync } from 'node:child_process'

export function releaseChannel(cwd, env = process.env) {
	const forced = String(env.RELEASE_CHANNEL || '').toLowerCase()
	if (forced && !['main', 'dev'].includes(forced)) throw new Error('RELEASE_CHANNEL 必须是 main 或 dev')
	if (forced) return forced
	const g = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' })
	return g.status === 0 && g.stdout.trim() === 'main' ? 'main' : 'dev'
}

export function updaterConfig(channel, env = process.env) {
	const pubkey = String(env.TAURI_UPDATER_PUBLIC_KEY || '').trim()
	if (!pubkey) return {
		bundle: { createUpdaterArtifacts: false },
		plugins: { updater: { pubkey: '' } }
	}
	return {
		bundle: { createUpdaterArtifacts: Boolean(env.TAURI_SIGNING_PRIVATE_KEY) },
		plugins: { updater: {
			pubkey,
			endpoints: [`https://github.com/Roomen/web-serial-debug/releases/download/desktop-${channel}/latest.json`],
			windows: { installMode: 'passive' }
		} }
	}
}
