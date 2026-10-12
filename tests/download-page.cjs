// 客户端下载页(download/download.js)的纯函数回归：通道按域名固定、系统与芯片识别、推荐、按通道取最新发布
const assert = require('assert')
const path = require('path')
const d = require(path.join(__dirname, '..', 'download', 'download.js'))

// 通道：两个正式域名固定，参数改不了；其它主机可用 ?channel= 预览
assert.strictEqual(d.channelFor('serial.logan825.org', ''), 'main')
assert.strictEqual(d.channelFor('serial-dev.logan825.org', ''), 'dev')
assert.strictEqual(d.channelFor('serial.logan825.org', '?channel=dev'), 'main')
assert.strictEqual(d.channelFor('serial-dev.logan825.org', '?channel=main'), 'dev')
assert.strictEqual(d.channelFor('localhost', '?channel=dev'), 'dev')
assert.strictEqual(d.channelFor('localhost', '?x=1&channel=main'), 'main')
assert.strictEqual(d.channelFor('localhost', '?channel=devx'), 'main')

// 系统
const UA = {
	mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
	win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
	linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
	android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
	iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
}
assert.strictEqual(d.detectOs({ userAgent: UA.mac }), 'macos')
assert.strictEqual(d.detectOs({ userAgent: UA.mac, maxTouchPoints: 5 }), 'ios')
assert.strictEqual(d.detectOs({ userAgent: UA.win }), 'windows')
assert.strictEqual(d.detectOs({ userAgent: UA.linux }), 'linux')
assert.strictEqual(d.detectOs({ userAgent: UA.android }), 'android')
assert.strictEqual(d.detectOs({ userAgent: UA.iphone }), 'ios')
assert.strictEqual(d.detectOs({ userAgent: UA.linux, uaPlatform: 'Android' }), 'android')
assert.strictEqual(d.detectOs({ userAgent: '' }), 'other')

// 芯片
assert.strictEqual(d.archFromHints('arm'), 'arm64')
assert.strictEqual(d.archFromHints('x86'), 'x64')
assert.strictEqual(d.archFromHints(''), null)
assert.strictEqual(d.archFromRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)'), 'arm64')
assert.strictEqual(d.archFromRenderer('Intel(R) Iris(TM) Plus Graphics 655'), 'x64')
assert.strictEqual(d.archFromRenderer('Apple GPU'), null)

// 推荐
assert.deepStrictEqual(d.recommend('windows', null), { id: 'win-x64', sure: true })
assert.deepStrictEqual(d.recommend('macos', 'arm64'), { id: 'mac-arm64', sure: true })
assert.deepStrictEqual(d.recommend('macos', 'x64'), { id: 'mac-x64', sure: true })
assert.deepStrictEqual(d.recommend('macos', null), { id: 'mac-arm64', sure: false })
assert.strictEqual(d.recommend('linux', 'x64'), null)
assert.strictEqual(d.recommend('ios', 'arm64'), null)

// 按通道取最新发布：只认 desktop-<通道>-v<版本>，跳过草稿、通道清单和另一个通道，按版本号而不是列表顺序
const rel = (tag, extra) => Object.assign({ tag_name: tag, draft: false, html_url: 'https://github.com/x/releases/tag/' + tag, assets: [] }, extra)
const list = [
	rel('desktop-main'),
	rel('desktop-dev'),
	rel('desktop-main-v1.9.0'),
	rel('desktop-main-v1.10.0', { assets: [{ name: 'Serial-Debug_1.10.0_macos_arm64.dmg' }], published_at: '2026-10-01T00:00:00Z' }),
	rel('desktop-main-v1.11.0', { draft: true }),
	rel('desktop-dev-v1.12.0'),
	rel('desktop-main-v1.10'),
	rel('v2.0.0')
]
const main = d.pickRelease(list, 'main')
assert.strictEqual(main.version, '1.10.0')
assert.strictEqual(main.url, 'https://github.com/x/releases/tag/desktop-main-v1.10.0')
assert.deepStrictEqual(main.assets, ['Serial-Debug_1.10.0_macos_arm64.dmg'])
assert.strictEqual(main.date, '2026-10-01T00:00:00Z')
assert.strictEqual(d.pickRelease(list, 'dev').version, '1.12.0')
assert.strictEqual(d.pickRelease([rel('desktop-main')], 'main'), null)
assert.strictEqual(d.pickRelease([], 'dev'), null)
assert.strictEqual(d.pickRelease(null, 'dev'), null)
assert.strictEqual(d.pickRelease([rel('desktop-dev-v1.0.0', { html_url: '' })], 'dev').url, 'https://github.com/Roomen/web-serial-debug/releases/tag/desktop-dev-v1.0.0')

// 推荐包的文件名与 desktop/scripts/tauri.mjs 的命名一致
const names = d.PACKAGES.map((p) => p.file('1.2.3'))
assert.deepStrictEqual(names, ['Serial-Debug_1.2.3_macos_arm64.dmg', 'Serial-Debug_1.2.3_macos_x64.dmg', 'Serial-Debug_1.2.3_windows_x64-setup.exe'])

console.log('download-page: ok')
