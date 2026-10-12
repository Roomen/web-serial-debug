// GitHub has no atomic asset replacement. Keep the previous manifest until the
// new bytes are uploaded and verified; roll back names if the final rename fails.
import { readFileSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promotePointer } from './channel-pointer.mjs'

const [channel, manifest] = process.argv.slice(2)
if (!['main', 'dev'].includes(channel) || !manifest) throw new Error('Expected channel and manifest path')
const repo = process.env.GH_REPO
const runId = process.env.GITHUB_RUN_ID
if (!repo || !/^\d+$/.test(runId || '')) throw new Error('Expected GH_REPO and GITHUB_RUN_ID')
function gh(args, input) {
	const result = spawnSync('gh', args, { input, maxBuffer: 4 * 1024 * 1024 })
	if (result.status !== 0) throw new Error('GitHub asset operation failed; previous asset is retained where possible')
	return result.stdout
}
function api(path, body) {
	return JSON.parse(gh(['api', path, ...(body ? ['--method', 'PATCH', '--input', '-'] : [])], body ? JSON.stringify(body) : undefined).toString())
}
const tag = `desktop-${channel}`
const stagedName = `latest-staged-${runId}.json`
const backupName = `latest-previous-${runId}.json`
copyFileSync(manifest, stagedName)
gh(['release', 'upload', tag, stagedName])
const release = api(`repos/${repo}/releases/tags/${tag}`)
const old = release.assets.find(a => a.name === 'latest.json')
const staged = release.assets.find(a => a.name === stagedName)
if (!old || !staged) throw new Error('Channel assets missing; staged upload retained for inspection')
const uploaded = gh(['api', `repos/${repo}/releases/assets/${staged.id}`, '-H', 'Accept: application/octet-stream'])
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
if (digest(uploaded) !== digest(readFileSync(manifest))) throw new Error('Uploaded manifest bytes do not match; old pointer remains intact')
promotePointer({
	old, staged, backupName, api,
	releasePath: `repos/${repo}/releases/tags/${tag}`,
	assetPath: id => `repos/${repo}/releases/assets/${id}`
})
// Intentionally retain the old asset under a backup name. Deleting it would
// prevent an operator from recovering the previous pointer after a later issue.
console.log('Channel pointer updated with previous manifest retained')
