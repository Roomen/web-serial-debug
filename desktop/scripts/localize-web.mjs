// 客户端使用仓库内固定版本的依赖，首屏与初始化不再等待 CDN。
import { readFileSync } from 'node:fs'

export function localizeWeb(html, vendor) {
	const manifest = JSON.parse(readFileSync(new URL('manifest.json', vendor), 'utf8'))
	for (const { url, path } of manifest) {
		// 构建时即校验文件，避免生成缺依赖的安装包。
		if (!readFileSync(new URL(path, vendor)).length) throw new Error('空的客户端依赖: ' + path)
		if (!html.includes(url)) throw new Error('页面依赖与客户端清单不一致: ' + path)
		html = html.replaceAll(url, 'vendor/' + path)
	}
	// 网页访问统计无需在客户端启动；移除后不再产生外部脚本请求。
	html = html.replace(/<script>\s*!function\s*\(p\)[\s\S]*?<\/script>/g, script => {
		if (!script.includes('LA_COLLECT')) throw new Error('未知的内联脚本')
		return ''
	})
	if (/<(?:script|link)\b[^>]*(?:src|href)=["']https?:\/\//i.test(html)) {
		throw new Error('客户端页面仍有未打包的远程依赖')
	}
	return html
}
