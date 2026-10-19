import test from 'node:test'
import assert from 'node:assert/strict'
import { selectReleasesToPrune } from './prune-dev-releases.mjs'

test('keeps the newest five preview releases by numeric SemVer', () => {
	const tags = [
		'desktop-dev-v1.100.0',
		'desktop-dev-v1.99.0',
		'desktop-dev-v1.9.0',
		'desktop-dev-v2.0.0',
		'desktop-dev-v1.101.0',
		'desktop-dev-v0.9.9',
	]
	assert.deepEqual(selectReleasesToPrune(tags, 5), ['desktop-dev-v0.9.9'])
	const doomed = new Set(selectReleasesToPrune(tags, 5))
	const kept = tags.filter(tag => !doomed.has(tag)).sort()
	assert.deepEqual(kept, [
		'desktop-dev-v1.100.0',
		'desktop-dev-v1.101.0',
		'desktop-dev-v1.9.0',
		'desktop-dev-v1.99.0',
		'desktop-dev-v2.0.0',
	].sort())
})

test('numeric ordering decides the keep window, not string order', () => {
	const tags = [
		'desktop-dev-v1.9.0',
		'desktop-dev-v1.99.0',
		'desktop-dev-v1.100.0',
		'desktop-dev-v1.101.0',
	]
	// 字典序会保留 1.99.0 / 1.9.0；数值序必须保留 1.101.0 / 1.100.0
	assert.deepEqual(selectReleasesToPrune(tags, 2), [
		'desktop-dev-v1.99.0',
		'desktop-dev-v1.9.0',
	])
})

test('ignores the channel pointer, main releases, prerelease suffixes and malformed tags', () => {
	const tags = [
		'desktop-dev',
		'desktop-main',
		'desktop-main-v1.0.0',
		'desktop-dev-v1.0.1-rc.1',
		'desktop-dev-v1.0.1+build.2',
		'desktop-dev-v1.0.1.2',
		'desktop-dev-v1.0',
		'desktop-dev-v1.0.x',
		'v1.0.0',
		null,
		42,
	]
	assert.deepEqual(selectReleasesToPrune(tags, 0), [])
	assert.deepEqual(selectReleasesToPrune(tags, 5), [])
})

test('does not prune when the total is within the keep limit', () => {
	assert.deepEqual(selectReleasesToPrune([], 5), [])
	assert.deepEqual(selectReleasesToPrune(['desktop-dev-v1.0.0', 'desktop-dev-v1.0.1'], 5), [])
	assert.deepEqual(selectReleasesToPrune(['desktop-dev-v1.0.0'], 1), [])
})

test('returns only releases beyond the keep limit, newest first', () => {
	const tags = [
		'desktop-dev-v1.0.5',
		'desktop-dev-v1.0.1',
		'desktop-dev-v1.0.3',
		'desktop-dev-v1.0.0',
		'desktop-dev-v1.0.4',
		'desktop-dev-v1.0.2',
	]
	assert.deepEqual(selectReleasesToPrune(tags, 2), [
		'desktop-dev-v1.0.3',
		'desktop-dev-v1.0.2',
		'desktop-dev-v1.0.1',
		'desktop-dev-v1.0.0',
	])
})

test('never returns the current release even when it is outside the keep window', () => {
	const tags = [
		'desktop-dev-v1.0.0',
		'desktop-dev-v1.0.1',
		'desktop-dev-v1.0.2',
		'desktop-dev-v1.0.3',
		'desktop-dev-v1.0.4',
	]
	assert.deepEqual(selectReleasesToPrune(tags, 2, 'desktop-dev-v1.0.0'), [
		'desktop-dev-v1.0.2',
		'desktop-dev-v1.0.1',
	])
	// current 不在列表里时不影响结果
	assert.deepEqual(selectReleasesToPrune(tags, 0, 'desktop-dev-v9.9.9'), [
		'desktop-dev-v1.0.4',
		'desktop-dev-v1.0.3',
		'desktop-dev-v1.0.2',
		'desktop-dev-v1.0.1',
		'desktop-dev-v1.0.0',
	])
})

test('rejects an invalid keep count', () => {
	assert.throws(() => selectReleasesToPrune([], -1), /keep/)
	assert.throws(() => selectReleasesToPrune([], 1.5), /keep/)
})
