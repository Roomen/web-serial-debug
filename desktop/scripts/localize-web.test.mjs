import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { localizeWeb } from './localize-web.mjs'

const vendor = new URL('../vendor/', import.meta.url)
const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

test('客户端启动依赖全部在包内，网页仍保留 CDN', () => {
	const html = localizeWeb(source, vendor)
	assert.match(source, /https:\/\/cdn\.bootcdn\.net/)
	assert.doesNotMatch(html, /LA_COLLECT/)
	const resources = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)/g)].map(m => m[1])
	assert.ok(resources.filter(p => p.startsWith('vendor/')).length === 7)
	for (const path of resources) {
		assert.doesNotMatch(path, /^https?:/)
		const file = path.startsWith('vendor/') ? new URL(path.slice(7), vendor) : new URL('../../' + path, import.meta.url)
		assert.ok(existsSync(file), '打包资源缺失: ' + path)
		if (!path.endsWith('.css')) continue
		for (const [, url] of readFileSync(file, 'utf8').matchAll(/url\(["']?([^)'"\s]+)/g)) {
			if (url.startsWith('data:')) continue
			assert.ok(existsSync(new URL(url, file)), '字体或样式资源缺失: ' + url)
		}
	}
})

test('新增远程依赖或页面与依赖清单不一致时拒绝出包', () => {
	assert.throws(() => localizeWeb(source + '<script src="https://example.invalid/new.js"></script>', vendor), /未打包/)
	assert.throws(() => localizeWeb(source.replace('bootstrap.bundle.min.js', 'other.js'), vendor), /不一致/)
})
