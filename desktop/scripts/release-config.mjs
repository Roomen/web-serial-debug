import { spawnSync } from 'node:child_process'

export function releaseChannel(cwd, env = process.env) {
	const forced = String(env.RELEASE_CHANNEL || '').toLowerCase()
	if (forced && !['main', 'dev'].includes(forced)) throw new Error('RELEASE_CHANNEL 必须是 main 或 dev')
	if (forced) return forced
	const g = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' })
	return g.status === 0 && g.stdout.trim() === 'main' ? 'main' : 'dev'
}

// 更新通道：macOS 与 Windows 便携版共用同一份清单与公钥。
// - 没有公钥时不嵌入假公钥、也不提供可安装的更新(本地仍能构建出可手动解压的便携 ZIP)
// - Windows 的更新载荷是便携 ZIP，由打包脚本自己签名，因此不让 tauri 生成 updater 产物
// - requireSignedVersion：签名里记录的版本必须与清单版本一致，防「新版号 + 旧包」的降级配对
export function updaterConfig(channel, env = process.env, platform = process.platform) {
	const pubkey = String(env.TAURI_UPDATER_PUBLIC_KEY || '').trim()
	if (!pubkey) return {
		bundle: { createUpdaterArtifacts: false },
		plugins: { updater: { pubkey: '' } }
	}
	return {
		bundle: { createUpdaterArtifacts: platform === 'darwin' && Boolean(env.TAURI_SIGNING_PRIVATE_KEY) },
		plugins: { updater: {
			pubkey,
			requireSignedVersion: true,
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
