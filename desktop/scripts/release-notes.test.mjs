import test from 'node:test'
import assert from 'node:assert/strict'
import { findPreviousTag, formatReleaseNotes } from './release-notes.mjs'

test('findPreviousTag picks highest older tag for main and dev channels', () => {
	const tags = [
		'desktop-main-v1.88.7',
		'desktop-dev-v1.89.0',
		'desktop-dev-v1.90.0',
		'desktop-dev-v1.91.0',
		'desktop-main',
		'desktop-dev',
	]
	assert.equal(findPreviousTag(tags, 'main', '1.91.0'), 'desktop-main-v1.88.7')
	assert.equal(findPreviousTag(tags, 'dev', '1.91.0'), 'desktop-dev-v1.90.0')
	assert.equal(findPreviousTag(['desktop-main-v1.90.0'], 'dev', '1.91.0'), 'desktop-main-v1.90.0')
	assert.equal(findPreviousTag(['desktop-dev-v1.91.0'], 'dev', '1.91.0'), null)
})

test('formatReleaseNotes groups commits into changelog sections without boilerplate install instructions', () => {
	const notes = formatReleaseNotes({
		version: '1.91.0',
		channel: 'dev',
		sha: 'abcdef123456',
		updater: true,
		commits: [
			'feat(ble): 支持 15 秒静默隐藏与已保存设备直连',
			'fix: 修复下拉直连误报广播名变更',
			'refactor: 精简释放逻辑',
			'chore: bump version to 1.91.0',
			'docs: 更新 AGENTS 约定',
		],
	})
	assert.match(notes, /^## Serial Debug v1\.91\.0 预览版/)
	assert.match(notes, /### 新功能\n- ble: 支持 15 秒静默隐藏与已保存设备直连/)
	assert.match(notes, /### 问题修复\n- 修复下拉直连误报广播名变更/)
	assert.match(notes, /### 优化与调整\n- 精简释放逻辑/)
	assert.match(notes, /### 其他变更\n- 更新 AGENTS 约定/)
	assert.doesNotMatch(notes, /bump version/i)
	assert.doesNotMatch(notes, /WebView2|xattr|隐私与安全性/)
})

test('formatReleaseNotes uses manual notes directly and appends updater warning only when disabled', () => {
	const custom = formatReleaseNotes({
		version: '1.91.0',
		channel: 'main',
		manualNotes: '手动编写的发布说明',
		updater: true,
	})
	assert.equal(custom, '手动编写的发布说明')
	const noUpdater = formatReleaseNotes({
		version: '1.91.0',
		channel: 'main',
		commits: ['feat: 新特性'],
		updater: false,
	})
	assert.match(noUpdater, /未启用应用内更新/)
})
