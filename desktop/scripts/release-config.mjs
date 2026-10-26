import { spawnSync } from 'node:child_process'

export function releaseChannel(cwd, env = process.env) {
	const forced = String(env.RELEASE_CHANNEL || '').toLowerCase()
	if (forced && !['main', 'dev'].includes(forced)) throw new Error('RELEASE_CHANNEL 必须是 main 或 dev')
	if (forced) return forced
	const g = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' })
	return g.status === 0 && g.stdout.trim() === 'main' ? 'main' : 'dev'
}

export function updaterConfig(channel, env = process.env, platform = process.platform) {
	const pubkey = String(env.TAURI_UPDATER_PUBLIC_KEY || '').trim()
	if (!pubkey || platform === 'win32') return {
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

// 没有 Developer ID 时整包 ad-hoc 签名：只有链接器签过的包没有封存资源，下载后被判「已损坏」，「隐私与安全性」里不给「仍要打开」。
export function macSigningConfig(env = process.env, platform = process.platform) {
	if (platform !== 'darwin' || String(env.APPLE_SIGNING_IDENTITY || '').trim()) return {}
	return { bundle: { macOS: { signingIdentity: '-' } } }
}
