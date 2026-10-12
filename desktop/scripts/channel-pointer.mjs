export function promotePointer({ old, staged, backupName, api, releasePath, assetPath }) {
	try {
		api(assetPath(old.id), { name: backupName })
		api(assetPath(staged.id), { name: 'latest.json' })
	} catch (error) {
		// Inspect state after ambiguous response failures before choosing rollback.
		const assets = api(releasePath).assets
		const latest = assets.find(a => a.name === 'latest.json')
		if (latest?.id === staged.id) return
		if (!latest) api(assetPath(old.id), { name: 'latest.json' })
		throw error
	}
}
