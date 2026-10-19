// 预览版 release 只保留最新 KEEP 个版本（含 tag）。通道指针 desktop-dev、正式版 desktop-main*
// 与本轮刚发布的版本永不删除；匹配必须严格到 MAJOR.MINOR.PATCH，预发布后缀不算。
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const KEEP = 5
export const DEV_RELEASE_TAG = /^desktop-dev-v([0-9]+)\.([0-9]+)\.([0-9]+)$/

function compareNumeric(a, b) {
	for (let i = 0; i < 3; i++) {
		if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1
	}
	return 0
}

// 纯函数：返回需要删除的 tag（按 SemVer 数值降序排列）。current 非空时强制保留。
export function selectReleasesToPrune(tags, keep, current) {
	if (!Number.isInteger(keep) || keep < 0) throw new Error('keep must be a non-negative integer')
	const parsed = []
	for (const tag of tags || []) {
		if (typeof tag !== 'string') continue
		const m = DEV_RELEASE_TAG.exec(tag)
		if (!m) continue
		parsed.push({ tag: tag, parts: [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])] })
	}
	parsed.sort(function (a, b) { return compareNumeric(b, a) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0) })
	const kept = new Set(parsed.slice(0, keep).map(function (x) { return x.tag }))
	if (current) kept.add(String(current))
	return parsed.filter(function (x) { return !kept.has(x.tag) }).map(function (x) { return x.tag })
}

function gh(args) {
	const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
	return r
}

function main() {
	const channel = String(process.env.CHANNEL || '')
	if (channel !== 'dev') {
		console.log('prune skipped: channel is ' + (channel || '(unset)'))
		return
	}
	const repo = String(process.env.GH_REPO || '').trim()
	if (!repo) {
		console.warn('::warning::prune skipped: GH_REPO is not set')
		return
	}
	const version = String(process.env.VERSION || '').trim()
	const current = /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) ? 'desktop-dev-v' + version : ''
	// 必须沿用工作流的分页取法：只取第一页会漏掉更旧的 release，导致没有删干净
	const list = gh(['api', '--paginate', '--slurp', 'repos/' + repo + '/releases?per_page=100'])
	if (list.error || list.status !== 0) {
		console.warn('::warning::prune skipped: failed to list releases' + (list.stderr ? ': ' + String(list.stderr).trim() : ''))
		return
	}
	let releases
	try {
		releases = JSON.parse(String(list.stdout)).flat()
	} catch (e) {
		console.warn('::warning::prune skipped: release list is not valid JSON')
		return
	}
	let doomed
	try {
		doomed = selectReleasesToPrune(releases.map(function (r) { return r && r.tag_name }), KEEP, current)
	} catch (e) {
		console.warn('::warning::prune skipped: ' + (e && e.message ? e.message : e))
		return
	}
	if (!doomed.length) {
		console.log('no preview releases to prune')
		return
	}
	console.log('pruning ' + doomed.length + ' old preview release(s)' + (current ? '; keeping ' + current : ''))
	for (const tag of doomed) {
		const r = gh(['release', 'delete', tag, '--cleanup-tag', '--yes'])
		if (r.error || r.status !== 0) {
			console.warn('::warning::failed to delete ' + tag + (r.stderr ? ': ' + String(r.stderr).trim() : ''))
			continue
		}
		console.log('deleted ' + tag)
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main()
	} catch (e) {
		// 清理失败只告警，绝不让发布工作流失败
		console.warn('::warning::prune skipped: ' + (e && e.message ? e.message : e))
	}
}
