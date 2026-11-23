import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions } from './updater-manifest.mjs'

const VERSION_TAG_RE = /^desktop-(main|dev)-v(\d+\.\d+\.\d+)$/
const VERSION_BUMP_RE = /^(?:chore(?:\([^)]*\))?:\s*)?bump\s+version\b/i
const COMMIT_PREFIX_RE = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/i

export function findPreviousTag(tags, channel, currentVersion) {
	const allowed = channel === 'main' ? new Set(['main']) : new Set(['main', 'dev'])
	let best = null
	for (const raw of tags) {
		const tag = String(raw || '').trim()
		const m = VERSION_TAG_RE.exec(tag)
		if (!m || !allowed.has(m[1])) continue
		const ver = m[2]
		if (compareVersions(ver, currentVersion) >= 0) continue
		if (!best || compareVersions(ver, best.version) > 0 || (compareVersions(ver, best.version) === 0 && m[1] === channel)) {
			best = { tag, version: ver, channel: m[1] }
		}
	}
	return best ? best.tag : null
}

function classifySubject(subject) {
	const text = String(subject || '').trim()
	if (!text) return null
	if (VERSION_BUMP_RE.test(text)) return null
	const m = COMMIT_PREFIX_RE.exec(text)
	if (!m) return { group: 'other', text }
	const type = m[1].toLowerCase()
	const scope = m[2] ? `${m[2]}: ` : ''
	const desc = m[3].trim()
	if (!desc || VERSION_BUMP_RE.test(desc)) return null
	if (type === 'feat') return { group: 'feat', text: scope + desc }
	if (type === 'fix') return { group: 'fix', text: scope + desc }
	if (type === 'refactor' || type === 'perf' || type === 'style') return { group: 'improve', text: scope + desc }
	return { group: 'other', text: scope + desc }
}

export function formatReleaseNotes({ version, channel, sha = '', commits = [], manualNotes = '', updater = true, previousTag = null }) {
	const manual = String(manualNotes || '').trim()
	if (manual) {
		return updater ? manual : `${manual}\n\n> 此版本未启用应用内更新，新版本请到 Releases 页下载。`
	}
	const heading = channel === 'dev'
		? `## Serial Debug v${version} 预览版`
		: `## Serial Debug v${version}`
	const sections = { feat: [], fix: [], improve: [], other: [] }
	const seen = new Set()
	for (const raw of commits) {
		const item = classifySubject(raw)
		if (!item) continue
		const key = `${item.group}:${item.text}`
		if (seen.has(key)) continue
		seen.add(key)
		sections[item.group].push(item.text)
	}
	const parts = [heading]
	const labels = [
		['feat', '### 新功能'],
		['fix', '### 问题修复'],
		['improve', '### 优化与调整'],
		['other', '### 其他变更'],
	]
	let hasEntries = false
	for (const [key, title] of labels) {
		if (!sections[key].length) continue
		hasEntries = true
		parts.push(`${title}\n${sections[key].map(line => `- ${line}`).join('\n')}`)
	}
	if (!hasEntries) {
		const fallback = channel === 'dev' && sha
			? `基于 dev 分支 ${sha.slice(0, 7)} 构建的预览版本。`
			: (previousTag ? `包含自 ${previousTag} 以来的常规维护与构建更新。` : `包含本版本的常规维护与构建更新。`)
		parts.push(fallback)
	}
	if (!updater) {
		parts.push('> 此版本未启用应用内更新，新版本请到 Releases 页下载。')
	}
	return parts.join('\n\n')
}

function gitLines(args) {
	try {
		const out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
		return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
	} catch (_) {
		return []
	}
}

export function generateReleaseNotesFromGit({ version, channel, sha = '', manualNotes = '', updater = true, fallbackCommitMessage = '' }) {
	const manual = String(manualNotes || '').trim()
	if (manual) {
		return formatReleaseNotes({ version, channel, sha, manualNotes: manual, updater })
	}
	// Only consider version tags reachable from HEAD so parallel branch tags do not distort the changelog.
	const tags = gitLines(['tag', '--merged', 'HEAD', '--list', 'desktop-*'])
	const previousTag = findPreviousTag(tags, channel, version)
	const range = previousTag ? `${previousTag}..HEAD` : 'HEAD'
	let commits = gitLines(['log', '--no-merges', '--pretty=format:%s', range])
	if (!commits.length && fallbackCommitMessage) {
		commits = [String(fallbackCommitMessage).split(/\r?\n/)[0]]
	}
	return formatReleaseNotes({ version, channel, sha, commits, updater, previousTag })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const output = process.argv[2] || 'release-notes.md'
	const e = process.env
	const notes = generateReleaseNotesFromGit({
		version: e.VERSION || '',
		channel: e.CHANNEL || 'dev',
		sha: e.GITHUB_SHA || '',
		manualNotes: e.RELEASE_NOTES || '',
		updater: e.UPDATER === 'true',
		fallbackCommitMessage: e.COMMIT_MESSAGE || '',
	})
	writeFileSync(output, notes + '\n')
}
