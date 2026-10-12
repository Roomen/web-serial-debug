// 把网页版的静态文件复制进 desktop/dist 作为客户端的前端：页面只有一份，客户端不另改页面文件。
// tauri 不允许 frontendDist 包含 src-tauri 所在目录，所以不能直接指向仓库根目录。
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseChannel } from './release-config.mjs'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(desktop, '..')
const dist = join(desktop, 'dist')
const ENTRIES = ['index.html', 'css', 'js', 'imgs']

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
for (const e of ENTRIES) {
	const src = join(repo, e)
	if (!existsSync(src)) throw new Error('缺少网页文件: ' + e)
	cpSync(src, join(dist, e), { recursive: true })
}
console.log('stage-web: 已复制 ' + ENTRIES.join(', ') + ' → desktop/dist')

writeFileSync(join(dist, 'js', 'release-config.js'), 'window.APP_RELEASE_CHANNEL = ' + JSON.stringify(releaseChannel(desktop)) + ';\nwindow.APP_UPDATER_CONFIGURED = ' + Boolean(String(process.env.TAURI_UPDATER_PUBLIC_KEY || '').trim()) + ';\n')
