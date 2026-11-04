import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function compareVersions(a, b) {
	const parse = (v) => {
		if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('版本必须是三段 SemVer')
		return v.split('.').map(Number)
	}
	const av = parse(a), bv = parse(b)
	for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return Math.sign(av[i] - bv[i])
	return 0
}

// 通道清单里的平台键必须与 tauri-plugin-updater 实际查找的一致：
// macOS 是 darwin-aarch64(安装包 .app.tar.gz)；Windows 便携版没有安装器产物，
// bundle_type 为空，插件先找 windows-x86_64-{installer} 再回落到 windows-x86_64。
// 载荷就是可手动使用的便携 ZIP，helper 从 ZIP 里取主程序并替换 EXE。
export const PLATFORM_PACKAGES = {
	'darwin-aarch64': name => `Serial-Debug_${name.version}_macos_arm64.app.tar.gz`,
	'windows-x86_64': name => `Serial-Debug_${name.version}_windows_x64.zip`
}

export function createManifest({ directory, version, channel, notes = '', previous, pubDate = new Date().toISOString() }) {
	if (!['main', 'dev'].includes(channel)) throw new Error('未知更新通道')
	compareVersions(version, version)
	if (previous && compareVersions(version, previous.version) <= 0) throw new Error('发布版本必须高于通道当前版本')
	const tag = `desktop-${channel}-v${version}`
	// 每个平台都必须有包与签名：任何一项缺失都直接失败，不能发布只覆盖部分平台的清单
	const entries = {}
	for (const [platform, nameOf] of Object.entries(PLATFORM_PACKAGES)) {
		const name = nameOf({ version })
		if (!existsSync(join(directory, name))) throw new Error(`缺少更新包: ${name}`)
		const signature = readFileSync(join(directory, name + '.sig'), 'utf8').trim()
		if (!signature || !/^[A-Za-z0-9+/=]+$/.test(signature)) throw new Error(`更新包签名无效: ${name}`)
		entries[platform] = {
			signature,
			url: `https://github.com/Roomen/web-serial-debug/releases/download/${tag}/${encodeURIComponent(name)}`
		}
	}
	return { version, notes, pub_date: pubDate, platforms: entries }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [directory, version, channel, output, previousFile, notesFile] = process.argv.slice(2)
	if (!output) throw new Error('用法: updater-manifest.mjs 产物目录 版本 通道 输出 [旧清单] [更新说明]')
	const previous = previousFile && existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : undefined
	const notes = notesFile ? readFileSync(notesFile, 'utf8') : ''
	writeFileSync(output, JSON.stringify(createManifest({ directory, version, channel, previous, notes }), null, 2) + '\n')
}
