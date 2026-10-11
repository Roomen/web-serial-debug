// 包一层 tauri CLI：应用版本只来自 js/version.js(window.APP_VERSION)，每次经 --config 传入，tauri.conf.json 与 Cargo.toml 不写版本。
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(desktop, '..', 'js', 'version.js'), 'utf8')
const m = src.match(/APP_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/)
if (!m) throw new Error('js/version.js 里找不到 APP_VERSION')

const args = process.argv.slice(2)
const sub = args[0]
if (sub === 'dev' || sub === 'build') args.push('--config', JSON.stringify({ version: m[1] }))
const bin = join(desktop, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri')
const r = spawnSync(bin, args, { cwd: desktop, stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(r.status == null ? 1 : r.status)
