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

export function createManifest({ directory, version, channel, notes = '', previous, pubDate = new Date().toISOString() }) {
	if (!['main', 'dev'].includes(channel)) throw new Error('未知更新通道')
	compareVersions(version, version)
	if (previous && compareVersions(version, previous.version) <= 0) throw new Error('发布版本必须高于通道当前版本')
	const tag = `desktop-${channel}-v${version}`
	const names = {
		'darwin-aarch64': `Serial-Debug_${version}_macos_arm64.app.tar.gz`
	}
	const platforms = {}
	for (const [platform, name] of Object.entries(names)) {
		if (!existsSync(join(directory, name))) throw new Error(`缺少更新包: ${name}`)
		const signature = readFileSync(join(directory, name + '.sig'), 'utf8').trim()
		if (!signature || !/^[A-Za-z0-9+/=]+$/.test(signature)) throw new Error(`更新包签名无效: ${name}`)
		platforms[platform] = {
			signature,
			url: `https://github.com/Roomen/web-serial-debug/releases/download/${tag}/${encodeURIComponent(name)}`
		}
	}
	return { version, notes, pub_date: pubDate, platforms }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [directory, version, channel, output, previousFile, notesFile] = process.argv.slice(2)
	if (!output) throw new Error('用法: updater-manifest.mjs 产物目录 版本 通道 输出 [旧清单] [更新说明]')
	const previous = previousFile && existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : undefined
	const notes = notesFile ? readFileSync(notesFile, 'utf8') : ''
	writeFileSync(output, JSON.stringify(createManifest({ directory, version, channel, previous, notes }), null, 2) + '\n')
}
