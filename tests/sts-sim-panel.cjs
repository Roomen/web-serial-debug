// Run: node tests/sts-sim-panel.cjs — synthetic data only, no dependencies.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../js/sts-sim-panel.js'), 'utf8')
const flush = () => new Promise(resolve => setImmediate(resolve))
const DRN = '101123456788'
const PAK = '000102030405060708090a0b0c0d0e0f'
const unsafe = '<img src=x onerror="throw 1">'

class FakeElement {
	constructor(tag) {
		this.tagName = tag.toUpperCase()
		this.children = []
		this.parentNode = null
		this.attributes = {}
		this.listeners = new Map()
		this.style = {}
		this.dataset = {}
		this.className = ''
		this.id = ''
		this.htmlFor = ''
		this.value = ''
		this.checked = false
		this.disabled = false
		this.hidden = false
		this.open = false
		this.scrollTop = 0
		this.scrollIntoViewCalls = []
		this._text = ''
		this.classList = {
			add: (...names) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' ') },
			remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' ') },
			contains: name => this.className.split(/\s+/).includes(name),
		}
	}
	get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
	set textContent(value) {
		this.children.forEach(child => { child.parentNode = null })
		this.children = []
		this._text = String(value == null ? '' : value)
	}
	set innerHTML(value) { throw new Error('Unexpected innerHTML sink: ' + value) }
	get childNodes() { return this.children }
	get lastChild() { return this.children.at(-1) || null }
	get scrollHeight() { return this.children.length * 20 }
	get offsetHeight() { return 20 }
	appendChild(child) {
		if (child.parentNode) child.parentNode.removeChild(child)
		child.parentNode = this
		this.children.push(child)
		return child
	}
	append(...children) { children.forEach(child => this.appendChild(child)) }
	prepend(child) { this.appendChild(child); this.children.unshift(this.children.pop()) }
	insertBefore(child, ref) {
		if (child.parentNode) child.parentNode.removeChild(child)
		const index = ref ? this.children.indexOf(ref) : -1
		child.parentNode = this
		if (index === -1) this.children.push(child)
		else this.children.splice(index, 0, child)
		return child
	}
	scrollIntoView(options) { this.scrollIntoViewCalls.push(options) }
	removeChild(child) {
		const index = this.children.indexOf(child)
		assert.notEqual(index, -1)
		this.children.splice(index, 1)
		child.parentNode = null
		return child
	}
	setAttribute(name, value) { this.attributes[name] = String(value) }
	getAttribute(name) { return this.attributes[name] ?? null }
	matches(selector) {
		if (selector === '[id]') return !!this.id
		if (selector === 'label[for]') return this.tagName === 'LABEL' && !!this.htmlFor
		if (selector.startsWith('#')) return this.id === selector.slice(1)
		if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
		if (/^[a-z]+$/i.test(selector)) return this.tagName === selector.toUpperCase()
		throw new Error('Unsupported fake DOM selector: ' + selector)
	}
	querySelectorAll(selector) {
		const result = []
		for (const child of this.children) {
			if (child.matches(selector)) result.push(child)
			result.push(...child.querySelectorAll(selector))
		}
		return result
	}
	querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
	closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null }
	contains(node) { return !!node && (node === this || this.children.some(child => child.contains(node))) }
	addEventListener(type, listener) {
		if (!this.listeners.has(type)) this.listeners.set(type, [])
		this.listeners.get(type).push(listener)
	}
	dispatchEvent(event) {
		if (!event.target) event.target = this
		event.currentTarget = this
		for (const listener of this.listeners.get(event.type) || []) listener(event)
		if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event)
		return true
	}
	click() { if (!this.disabled) this.dispatchEvent({ type: 'click', bubbles: true }) }
}

function makeClock() {
	let now = 1_800_000_000_000
	let nextId = 0
	const timers = new Map()
	function schedule(fn, delay, interval) {
		const id = ++nextId
		timers.set(id, { fn, at: now + delay, interval })
		return id
	}
	return {
		now: () => now,
		setTimeout: (fn, delay) => schedule(fn, delay, 0),
		setInterval: (fn, delay) => schedule(fn, delay, delay),
		clearTimeout: id => timers.delete(id),
		clearInterval: id => timers.delete(id),
		async advance(ms) {
			const end = now + ms
			await flush()
			for (;;) {
				const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
				if (!next) break
				const [id, timer] = next
				now = timer.at
				if (timer.interval) timer.at += timer.interval
				else timers.delete(id)
				timer.fn()
				await flush()
			}
			now = end
			await flush()
		},
	}
}

function makeWorld(options = {}) {
	const storage = options.storage || new Map()
	const writes = []
	const clock = makeClock()
	const engines = []
	const factoryCalls = []
	const failingSids = new Set(options.failingSids || [])
	const startFailures = new Map(Object.entries(options.startFailures || {}).map(([sid, failures]) => [sid, failures.slice()]))
	const startAttempts = []
	const targetCalls = []
	const links = []
	const sent = []
	const sessions = new Set(options.open || [])
	let mode = options.mode || 'dual'
	const labels = { A: '', B: '', ...(options.labels || {}) }
	let shown = !!options.shown
	const laneProtos = options.lanes ? { ...options.lanes } : null
	const laneCalls = []
	const protocol = {
		value: options.protocol || 'sek', changes: [],
		options: ['sek', 'cjt188', 'hostproto'].map(value => ({ value })),
		dispatchEvent(event) { assert.equal(event.type, 'change'); this.changes.push(this.value) },
	}
	let root
	const presets = [{ code: '0001', label: '低电池告警' }, { code: '0002', label: '合成标签 ' + unsafe + '告警' }]
	const split = value => String(value || '').trim().split(/\s+/).filter(Boolean)
	function createEngine(role, args) {
		factoryCalls.push({ role, sid: args.link.sid })
		if (failingSids.has(args.link.sid)) throw new Error('合成配置非法')
		let resolveStart
		const startPromise = new Promise(resolve => { resolveStart = resolve })
		const state = {
			running: false, phase: 'idle', localAddr: options.ciuAddr || '2', drn: args.config.drn || DRN, meterNo: '12345678',
			remaining: 100, totalUsed: 20, totalPurchased: 120, batteryCv: 350,
			meterStatus: 0, valve: 1, valveFault: false, alarms: [], tariff: { currency: false, dec: 1 },
			archive: [], records: [], sessions: 0, pending: null,
		}
		const engine = {
			role, args, state, starts: 0, stops: 0,
			async start() {
				this.starts++
				startAttempts.push({ sid: args.link.sid, at: clock.now() })
				args.link.send('start')
				if (options.deferStart) await startPromise
				const failure = startFailures.get(args.link.sid)?.shift()
				if (failure) {
					if (failure instanceof Error) throw failure
					const error = new Error('合成启动失败: ' + failure)
					error.code = failure
					throw error
				}
				state.running = true
			},
			completeStart: () => resolveStart(),
			stop() { this.stops++; state.running = false },
			getState: () => state,
			log: text => args.onLog({ at: clock.now(), level: 'info', text }),
			emitState: patch => { Object.assign(state, patch); args.onState(state) },
			async status() {
				args.link.send('status')
				return { ok: true, op: 'status', message: unsafe, durationMs: 100, read: [{ id: 1, name: unsafe, text: unsafe }] }
			},
			setTarget(targetDrn) {
				args.link.send('setTarget')
				return new Promise((resolve, reject) => {
					const call = { engine, targetDrn, resolve: result => resolve(result || { targetDrn, basicsOk: true }), reject }
					targetCalls.push(call)
					if (!options.deferTargets) call.resolve()
				})
			},
			setLive(patch) {
				if (patch.alarmCodes != null) state.alarms = split(patch.alarmCodes)
				else Object.assign(state, patch)
				args.onState(state)
			},
		}
		engines.push(engine)
		return engine
	}
	const document = {
		readyState: 'complete', activeElement: null,
		createElement: tag => new FakeElement(tag),
		getElementById: id => id === 'serial-protocol-select' ? protocol : root?.id === id ? root : root?.querySelector('#' + id) || null,
	}
	const window = {
		_activeProtocol: 'hostproto',
		Workbench: {
			registerPanel(panel) { assert.equal(panel.id, 'sts-sim'); assert.equal(root, undefined); root = panel.el },
			isShown: id => id === 'sts-sim' && shown,
		},
		SerialHub: { getLabelA: () => labels.A, getLabelB: () => labels.B },
		serialLanes: laneProtos ? {
			protocolOf: sid => laneProtos[sid],
			setProtocol(sid, id) { laneProtos[sid] = id; laneCalls.push(sid + ':' + id) },
		} : undefined,
		serialApi: { getMode: () => mode, isSessionOpen: sid => sessions.has(sid) },
		hostProtoSerialLink(args) {
			assert.ok(['A', 'B', 'S'].includes(args.sid))
			const link = {
				sid: args.sid, closed: false, closes: 0,
				send(operation) { assert.equal(this.closed, false, 'cannot send through a closed link'); sent.push({ sid: args.sid, operation }) },
				close() { this.closed = true; this.closes++ },
			}
			links.push(link)
			return link
		},
		stsCiu: {
			VALVE_POS_OPEN: 1, VALVE_POS_CLOSED: 2, VALVE_POS_MASK: 3,
			fmtScaled: (value, dec) => (Number(value) / 10 ** dec).toFixed(dec),
			meterStatusText: () => ' 合成状态', recordTimeStr: () => '合成时刻', RECORD_EPOCH_UNSET: 0,
		},
		stsSim: {
			METER_DEFAULTS: { drn: DRN, tokenDelayS: 1, tokenMode: 'exec', creditAmount: 10, testBits: '00000001', valveDelayS: 1, remaining: 100, totalUsed: 20, batteryCv: 350, tariffCurrency: false, tariffDec: 0, alarmCodes: '' },
			CIU_DEFAULTS: { targetDrn: DRN, ackTimeoutS: 5, upTimeoutS: 10, busyWaitS: 1, sessionRetries: 2 },
			ALARM_PRESETS: presets,
			composeAlarmCodes: (checked, other) => [...new Set(checked.concat(split(other)))].join(' '),
			splitAlarmCodes(value) {
				const codes = split(value)
				return { checked: codes.filter(code => presets.some(preset => preset.code === code)), other: codes.filter(code => !presets.some(preset => preset.code === code)).join(' ') }
			},
			createMeterSim: args => createEngine('meter', args),
			createCiuSim: args => createEngine('ciu', args),
		},
	}
	class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now()])) } static now() { return clock.now() } }
	const context = vm.createContext({
		window, document, Date: FakeDate,
		Event: class { constructor(type) { this.type = type } },
		localStorage: {
			getItem: key => storage.get(key) ?? null,
			setItem(key, value) { writes.push({ key, value }); storage.set(key, String(value)) },
			removeItem(key) { storage.delete(key) },
		},
		setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval, clearInterval: clock.clearInterval,
	})
	vm.runInContext(source, context, { filename: 'js/sts-sim-panel.js' })
	assert.ok(root, 'panel registered')
	function panel(channel) {
		const element = root.querySelector('#wb-pane-sts-sim-' + channel)
		assert.ok(element, 'channel ' + channel + ' exists')
		const suffix = channel === 'S' ? '' : '.' + channel
		return {
			root: element, suffix,
			input(group, name) { const input = element.querySelector('#sts-sim-' + group + '-' + name + '-' + channel); assert.ok(input, group + '.' + name); return input },
			start: element.querySelector('.ctl-toggle'),
			role(role) { element.querySelector('.ctl-seg').querySelectorAll('button')[role === 'meter' ? 0 : 1].click() },
			cfg: element.querySelector('details'),
			body: element.querySelector('.sts-sim-body'),
			toggle: element.querySelector('.sts-sim-collapse'),
			title: element.querySelector('.sts-sim-title'),
			log: element.querySelector('.sts-sim-log'),
			status: element.querySelector('.sts-sim-status'),
		}
	}
	return { root, panel, labels, protocol, laneProtos, laneCalls, setShown(value) { shown = value }, storage, writes, clock, engines, factoryCalls, failingSids, startFailures, startAttempts, targetCalls, links, sent, sessions, setMode(value) { mode = value }, saved: key => JSON.parse(storage.get(key) || 'null') }
}

function change(input, value) {
	if (input.type === 'checkbox') input.checked = value
	else input.value = String(value)
	input.dispatchEvent({ type: 'change', bubbles: true })
}

const tests = []
function test(name, run) { tests.push({ name, run }) }

test('meter DRN input is removed and stale saved DRNs never reach engines', async () => {
	const storage = new Map(['S', 'A', 'B'].map(sid => ['stsSim.meter2' + (sid === 'S' ? '' : '.' + sid), JSON.stringify({ drn: '9998765432101' })]))
	const world = makeWorld({ storage, open: ['A', 'B'] })
	for (const sid of ['S', 'A', 'B']) assert.equal(world.panel(sid).root.querySelector('#sts-sim-meter-drn-' + sid), null)
	world.panel('A').start.click()
	world.panel('B').start.click()
	await flush()
	for (const engine of world.engines) assert.equal(engine.args.config.drn, '')
	for (const sid of ['A', 'B']) assert.equal(Object.hasOwn(world.saved('stsSim.meter2.' + sid), 'drn'), false)
	world.setMode('single')
	world.sessions.add('S')
	world.panel('S').start.click()
	await flush()
	assert.equal(world.engines.at(-1).args.config.drn, '')
	assert.equal(Object.hasOwn(world.saved('stsSim.meter2'), 'drn'), false)
})

test('CIU address is read-only, ignores old saved values and is never persisted', async () => {
	const storage = new Map([['stsSim.ciu.B', JSON.stringify({ localAddr: '99' })]])
	const world = makeWorld({ storage, open: ['B'], ciuAddr: '42' })
	const panel = world.panel('B')
	panel.role('ciu')
	const address = panel.root.querySelector('#sts-sim-ciu-localAddr-B')
	assert.equal(address.tagName, 'OUTPUT')
	assert.equal(address.textContent, '待读取')
	panel.start.click()
	await flush()
	assert.equal(Object.hasOwn(world.engines[0].args.config, 'localAddr'), false)
	assert.equal(address.textContent, '42')
	assert.match(panel.root.querySelector('.sts-sim-phase').textContent, /本机地址 42/)
	assert.equal(Object.hasOwn(world.saved('stsSim.ciu.B'), 'localAddr'), false)
	const refreshed = makeWorld({ storage: new Map(world.storage) })
	assert.equal(refreshed.panel('B').root.querySelector('#sts-sim-ciu-localAddr-B').textContent, '待读取')
	panel.start.click()
	assert.equal(address.textContent, '待读取')
})

test('A/B roles, configuration, logs and manual start/stop are independent', async () => {
	const world = makeWorld({ open: ['A', 'B'] })
	const channelA = world.panel('A')
	const channelB = world.panel('B')
	channelB.role('ciu')
	change(channelA.input('meter', 'remaining'), 321)
	change(channelB.input('ciu', 'ackTimeoutS'), 42)
	assert.equal(world.saved('stsSim.role.B'), 'ciu')
	assert.equal(channelA.root.querySelector('.ctl-seg').querySelector('button').getAttribute('aria-pressed'), 'true')
	assert.equal(world.saved('stsSim.meter2.A').remaining, '321')
	assert.equal(world.saved('stsSim.meter2'), null, 'dual A no longer shares the single-mode key')
	assert.equal(world.saved('stsSim.ciu.B').ackTimeoutS, '42')
	assert.equal(channelB.input('meter', 'remaining').value, '100')
	assert.equal(channelA.input('ciu', 'ackTimeoutS').value, '5')
	channelA.start.click()
	channelB.start.click()
	await flush()
	assert.deepEqual(world.engines.map(engine => engine.role), ['meter', 'ciu'])
	assert.equal(world.engines[0].args.config.remaining, 321)
	assert.equal(world.engines[1].args.config.ackTimeoutS, 42)
	world.engines[0].log('A-only')
	world.engines[1].log('B-only')
	assert.match(channelA.log.textContent, /A-only/)
	assert.doesNotMatch(channelA.log.textContent, /B-only/)
	assert.match(channelB.log.textContent, /B-only/)
	assert.doesNotMatch(channelB.log.textContent, /A-only/)
	channelA.start.click()
	assert.equal(world.engines[0].stops, 1)
	assert.equal(world.engines[1].stops, 0)
	assert.equal(world.saved('stsSim.running.A'), false)
	assert.equal(world.saved('stsSim.running.B'), true)
	channelB.start.click()
	assert.equal(world.engines[1].stops, 1)
	assert.equal(world.saved('stsSim.running.B'), false)
})

test('single mode shows only the S panel with unsuffixed keys; A/B panels are hidden and inert', async () => {
	const world = makeWorld({ mode: 'single', open: ['S', 'A', 'B'] })
	assert.equal(world.panel('S').root.hidden, false)
	assert.equal(world.panel('A').root.hidden, true)
	assert.equal(world.panel('B').root.hidden, true)
	assert.equal(world.root.querySelector('.sts-sim-dualbar').hidden, true, 'no A/B summary or log view in single mode')
	assert.equal(world.root.querySelector('.sts-sim-channelbar'), null)
	assert.equal(world.panel('S').toggle, null, 'single panel has no collapse button')
	assert.equal(world.panel('S').title.textContent, '单路')
	world.panel('A').start.click()
	world.panel('B').start.click()
	assert.equal(world.engines.length, 0)
	assert.equal(world.saved('stsSim.running.A'), null)
	change(world.panel('S').input('meter', 'remaining'), 77)
	world.panel('S').role('ciu')
	world.panel('S').start.click()
	await flush()
	assert.deepEqual(world.links.map(link => link.sid), ['S'])
	assert.equal(world.saved('stsSim.meter2').remaining, '77')
	assert.equal(world.saved('stsSim.role'), 'ciu')
	assert.equal(world.saved('stsSim.running'), true)
	for (const key of ['stsSim.meter2.A', 'stsSim.role.A', 'stsSim.running.A', 'stsSim.running.B', 'stsSim.channel']) assert.equal(world.storage.has(key), false, key)
})

test('S and A configurations do not leak into each other; legacy unsuffixed keys belong to S', async () => {
	const storage = new Map([['stsSim.meter2', JSON.stringify({ remaining: '111' })], ['stsSim.role', '"ciu"']])
	const world = makeWorld({ storage, open: ['A', 'S'] })
	assert.equal(world.panel('S').input('meter', 'remaining').value, '111')
	assert.equal(world.panel('A').input('meter', 'remaining').value, '100')
	assert.equal(world.panel('S').root.querySelector('.ctl-seg').querySelector('button').getAttribute('aria-pressed'), 'false')
	assert.equal(world.panel('A').root.querySelector('.ctl-seg').querySelector('button').getAttribute('aria-pressed'), 'true')
	change(world.panel('A').input('meter', 'remaining'), 222)
	change(world.panel('B').input('meter', 'remaining'), 333)
	assert.equal(world.saved('stsSim.meter2').remaining, '111')
	assert.equal(world.saved('stsSim.meter2.A').remaining, '222')
	assert.equal(world.saved('stsSim.meter2.B').remaining, '333')
	const refreshed = makeWorld({ storage: new Map(world.storage) })
	assert.deepEqual(['S', 'A', 'B'].map(sid => refreshed.panel(sid).input('meter', 'remaining').value), ['111', '222', '333'])
	change(world.panel('S').input('meter', 'pak'), PAK)
	assert.equal(world.panel('A').input('meter', 'pak').value, '', 'PAK inputs are per session')
})

for (const roles of [['meter', 'ciu'], ['ciu', 'meter'], ['meter', 'meter']]) {
	test('concurrent ' + roles.join('/') + ' startup keeps fixed A/B sids', async () => {
		const world = makeWorld({ open: ['A', 'B'], deferStart: true })
		for (const [index, channel] of ['A', 'B'].entries()) {
			world.panel(channel).role(roles[index])
			world.panel(channel).start.click()
		}
		assert.equal(world.engines.length, 2, 'B does not wait for A startup')
		assert.deepEqual(world.sent.map(entry => entry.sid), ['A', 'B'])
		world.engines[1].completeStart()
		await flush()
		assert.match(world.panel('B').status.textContent, /运行中/)
		assert.match(world.panel('A').status.textContent, /启动中/)
		world.engines[0].completeStart()
		await flush()
		await world.clock.advance(1000)
		assert.deepEqual(world.links.map(link => link.sid), ['A', 'B'])
		for (const channel of ['A', 'B']) {
			assert.match(world.panel(channel).status.textContent, /运行中/)
			if (world.panel(channel).root.querySelector('.sts-sim-ciu-view').hidden) continue
			world.panel(channel).input('ciu', 'status').click()
			await flush()
			assert.equal(world.sent.at(-1).sid, channel)
		}
	})
}

test('refresh persists wanted and configuration; each channel resumes only after open', async () => {
	const first = makeWorld({ open: ['A', 'B'] })
	first.panel('B').role('ciu')
	change(first.panel('A').input('meter', 'remaining'), 456)
	first.panel('A').start.click()
	first.panel('B').start.click()
	await flush()
	const refreshed = makeWorld({ storage: new Map(first.storage) })
	assert.equal(refreshed.engines.length, 0)
	assert.equal(refreshed.panel('A').input('meter', 'remaining').value, '456')
	for (const channel of ['A', 'B']) assert.match(refreshed.panel(channel).start.textContent, /取消等待/)
	refreshed.sessions.add('B')
	await refreshed.clock.advance(500)
	assert.deepEqual(refreshed.links.map(link => link.sid), ['B'])
	assert.equal(refreshed.engines[0].role, 'ciu')
	refreshed.sessions.add('A')
	await refreshed.clock.advance(500)
	assert.deepEqual(refreshed.links.map(link => link.sid), ['B', 'A'])
	assert.equal(refreshed.engines[1].args.config.remaining, 456)
	await refreshed.clock.advance(1000)
	assert.equal(refreshed.engines.length, 2, 'no duplicate automatic startup')
})

test('manual cancel while waiting clears wanted without touching the other channel', async () => {
	const world = makeWorld({ storage: new Map([['stsSim.running.A', 'true'], ['stsSim.running.B', 'true']]) })
	world.panel('A').start.click()
	assert.equal(world.saved('stsSim.running.A'), false)
	assert.equal(world.saved('stsSim.running.B'), true)
	world.sessions.add('A')
	world.sessions.add('B')
	await world.clock.advance(1000)
	assert.deepEqual(world.links.map(link => link.sid), ['B'])
	const refreshed = makeWorld({ storage: new Map(world.storage), open: ['A'] })
	assert.equal(refreshed.engines.length, 0)
})

test('disconnecting A stops only A, keeps wanted and reconnects only A', async () => {
	const world = makeWorld({ open: ['A', 'B'] })
	world.panel('A').start.click()
	world.panel('B').start.click()
	await flush()
	world.sessions.delete('A')
	await world.clock.advance(500)
	assert.equal(world.engines[0].stops, 1)
	assert.equal(world.links[0].closes, 1)
	assert.equal(world.engines[1].stops, 0)
	assert.equal(world.links[1].closed, false)
	assert.equal(world.saved('stsSim.running.A'), true)
	assert.match(world.panel('B').status.textContent, /运行中/)
	world.sessions.add('A')
	await world.clock.advance(500)
	assert.deepEqual(world.links.map(link => link.sid), ['A', 'B', 'A'])
	assert.equal(world.engines[1].starts, 1)
})

test('dual -> single -> dual: each session keeps its own wanted, resumes on return and never redirects to another sid', async () => {
	const world = makeWorld({ open: ['A', 'B', 'S'] })
	world.panel('A').role('ciu')
	world.panel('A').start.click()
	world.panel('B').start.click()
	await flush()
	world.setMode('single')
	await world.clock.advance(500)
	assert.deepEqual(world.engines.map(engine => engine.stops), [1, 1])
	assert.ok(world.links.every(link => link.closed))
	assert.deepEqual(world.links.map(link => link.sid), ['A', 'B'], 'S has no wanted, so nothing opens on it')
	assert.equal(world.saved('stsSim.running.A'), true)
	assert.equal(world.saved('stsSim.running.B'), true)
	assert.equal(world.saved('stsSim.running'), null)
	world.panel('A').input('ciu', 'status').click()
	await flush()
	assert.equal(world.sent.filter(entry => entry.operation === 'status').length, 0, 'stopped A cannot send via S')
	world.panel('S').role('ciu')
	world.panel('S').start.click()
	await flush()
	assert.deepEqual(world.links.map(link => link.sid), ['A', 'B', 'S'])
	world.panel('S').input('ciu', 'status').click()
	await flush()
	assert.equal(world.sent.at(-1).sid, 'S')
	await world.clock.advance(2000)
	assert.deepEqual(world.links.map(link => link.sid), ['A', 'B', 'S'], 'A/B do not restart in single mode')
	world.setMode('dual')
	await world.clock.advance(500)
	assert.equal(world.links[2].closed, true)
	assert.equal(world.engines[2].stops, 1)
	assert.equal(world.saved('stsSim.running'), true, 'S keeps its own wanted')
	assert.deepEqual(world.links.map(link => link.sid), ['A', 'B', 'S', 'A', 'B'])
	world.panel('A').input('ciu', 'status').click()
	await flush()
	assert.equal(world.sent.at(-1).sid, 'A')
	assert.equal(world.sent.filter(entry => entry.operation === 'status' && entry.sid === 'B').length, 0)
	world.setMode('single')
	await world.clock.advance(500)
	assert.deepEqual(world.links.map(link => link.sid), ['A', 'B', 'S', 'A', 'B', 'S'], 'S resumes after coming back')
})

test('mode switch during pending startup ignores stale completion', async () => {
	const world = makeWorld({ open: ['A', 'B', 'S'], deferStart: true })
	world.panel('A').start.click()
	world.panel('B').start.click()
	world.setMode('single')
	await world.clock.advance(500)
	assert.equal(world.engines.length, 2)
	world.engines[0].completeStart()
	world.engines[1].completeStart()
	await flush()
	for (const sid of ['A', 'B']) assert.doesNotMatch(world.panel(sid).status.textContent, /运行中/)
	assert.ok(world.links.every(link => link.closed))
	world.panel('S').start.click()
	assert.equal(world.engines.length, 3)
	world.engines[2].completeStart()
	await flush()
	assert.match(world.panel('S').status.textContent, /运行中/)
	assert.equal(world.links[2].sid, 'S')
})

for (const [channel, role] of [['A', 'meter'], ['B', 'ciu']]) {
	test(channel + ' ' + role + ' construction failure clears wanted and does not automatically retry', async () => {
		const suffix = '.' + channel
		const other = channel === 'A' ? 'B' : 'A'
		const storage = new Map([
			['stsSim.running.A', 'true'], ['stsSim.running.B', 'true'],
			['stsSim.role' + suffix, JSON.stringify(role)],
		])
		const world = makeWorld({ storage, open: ['A', 'B'], failingSids: [channel] })
		await flush()
		assert.equal(world.saved('stsSim.running' + suffix), false)
		assert.equal(world.factoryCalls.filter(call => call.sid === channel).length, 1)
		assert.equal(world.links.find(link => link.sid === channel).closed, true)
		assert.equal(world.links.find(link => link.sid === channel).closes, 1)
		assert.match(world.panel(channel).status.textContent, /合成配置非法/)
		assert.match(world.panel(channel).log.textContent, /配置错误/)
		const logCount = world.panel(channel).log.children.length
		await world.clock.advance(5000)
		assert.equal(world.factoryCalls.filter(call => call.sid === channel).length, 1)
		assert.equal(world.links.length, 2)
		assert.equal(world.panel(channel).log.children.length, logCount)
		assert.match(world.panel(other).status.textContent, /运行中/)
		assert.equal(world.engines[0].stops, 0)
		const refreshed = makeWorld({ storage: new Map(storage), open: ['A', 'B'] })
		await refreshed.clock.advance(1000)
		assert.deepEqual(refreshed.factoryCalls.map(call => call.sid), [other])
		world.failingSids.delete(channel)
		world.panel(channel).start.click()
		await flush()
		assert.equal(world.factoryCalls.filter(call => call.sid === channel).length, 2)
		assert.equal(world.saved('stsSim.running' + suffix), true)
		assert.match(world.panel(channel).status.textContent, /运行中/)
	})
}

for (const [channel, role] of [['A', 'meter'], ['B', 'ciu']]) {
	test(channel + ' ' + role + ' timeouts retain wanted and retry at 5/10/20/30/30 seconds, then succeed', async () => {
		const suffix = '.' + channel
		const world = makeWorld({ open: [channel], startFailures: { [channel]: Array(5).fill('timeout') } })
		const panel = world.panel(channel)
		panel.role(role)
		panel.start.click()
		await flush()
		const startedAt = world.clock.now()
		assert.equal(world.startAttempts.length, 1)
		for (const [index, delay] of [5000, 10000, 20000, 30000, 30000].entries()) {
			assert.equal(world.saved('stsSim.running' + suffix), true)
			assert.equal(world.engines[index].stops, 1)
			assert.equal(world.links[index].closed, true)
			const logCount = panel.log.children.length
			await world.clock.advance(delay - 500)
			assert.equal(world.startAttempts.length, index + 1, 'no 500ms retry before deadline')
			assert.equal(panel.log.children.length, logCount, 'no polling log spam')
			await world.clock.advance(500)
			assert.equal(world.startAttempts.length, index + 2, 'retry at deadline')
		}
		assert.deepEqual(world.startAttempts.map(attempt => attempt.at - startedAt), [0, 5000, 15000, 35000, 65000, 95000])
		assert.ok(world.startAttempts.every(attempt => attempt.sid === channel))
		assert.match(panel.status.textContent, /运行中/)
		assert.equal(panel.start.getAttribute('aria-pressed'), 'true')
		assert.equal(world.engines.at(-1).state.running, true)
		assert.equal(world.links.at(-1).closed, false)
		await world.clock.advance(60000)
		assert.equal(world.startAttempts.length, 6, 'successful retry stops retrying')
	})
}

test('manual cancel during timeout backoff clears wanted and cancels all automatic retries', async () => {
	const world = makeWorld({ open: ['A'], startFailures: { A: ['timeout', 'timeout'] } })
	const panel = world.panel('A')
	panel.start.click()
	await flush()
	await world.clock.advance(1000)
	assert.equal(world.saved('stsSim.running.A'), true)
	assert.match(panel.start.textContent, /取消(?:等待|重试)/)
	panel.start.click()
	assert.equal(world.saved('stsSim.running.A'), false)
	assert.equal(panel.start.getAttribute('aria-pressed'), 'false')
	const logCount = panel.log.children.length
	await world.clock.advance(120000)
	assert.equal(world.startAttempts.length, 1)
	assert.equal(panel.log.children.length, logCount)
	const refreshed = makeWorld({ storage: new Map(world.storage), open: ['A'] })
	await refreshed.clock.advance(10000)
	assert.equal(refreshed.startAttempts.length, 0)
	world.startFailures.get('A').length = 0
	panel.start.click()
	await flush()
	assert.match(panel.status.textContent, /运行中/)
	assert.equal(world.saved('stsSim.running.A'), true)
})

test('non-timeout authorization failure clears wanted and never retries', async () => {
	const authorizationError = new Error('合成授权拒绝')
	authorizationError.code = 'auth'
	const world = makeWorld({ open: ['B'], startFailures: { B: [authorizationError] } })
	const panel = world.panel('B')
	panel.role('ciu')
	panel.start.click()
	await flush()
	assert.equal(world.saved('stsSim.running.B'), false)
	assert.equal(world.engines[0].stops, 1)
	assert.equal(world.links[0].closed, true)
	assert.match(panel.status.textContent, /合成授权拒绝/)
	const logCount = panel.log.children.length
	await world.clock.advance(120000)
	assert.equal(world.startAttempts.length, 1)
	assert.equal(panel.log.children.length, logCount)
	const refreshed = makeWorld({ storage: new Map(world.storage), open: ['B'] })
	assert.equal(refreshed.engines.length, 0)
})

test('successful retry resets timeout backoff for the next disconnected session', async () => {
	const world = makeWorld({ open: ['A'], startFailures: { A: ['timeout'] } })
	world.panel('A').start.click()
	await flush()
	await world.clock.advance(5000)
	assert.match(world.panel('A').status.textContent, /运行中/)
	world.sessions.delete('A')
	await world.clock.advance(500)
	world.startFailures.get('A').push('timeout')
	world.sessions.add('A')
	await world.clock.advance(500)
	assert.equal(world.startAttempts.length, 3)
	const failedAt = world.startAttempts[2].at
	await world.clock.advance(4500)
	assert.equal(world.startAttempts.length, 3)
	await world.clock.advance(500)
	assert.equal(world.startAttempts.length, 4)
	assert.equal(world.startAttempts[3].at - failedAt, 5000)
	assert.match(world.panel('A').status.textContent, /运行中/)
})

test('PAK is passed to engines but never persisted or restored for either role/channel', async () => {
	const world = makeWorld({ open: ['A', 'B'] })
	world.panel('B').role('ciu')
	for (const channel of ['A', 'B']) {
		for (const group of ['meter', 'ciu']) {
			const input = world.panel(channel).input(group, 'pak')
			assert.equal(input.type, 'password')
			change(input, PAK)
		}
		world.panel(channel).start.click()
	}
	await flush()
	assert.ok(world.engines.every(engine => engine.args.config.pak === PAK))
	assert.ok(world.writes.every(write => !write.value.includes(PAK) && !write.value.includes('"pak"')))
	for (const channel of ['A', 'B']) {
		const suffix = '.' + channel
		for (const key of ['stsSim.meter2', 'stsSim.ciu']) {
			const config = world.saved(key + suffix)
			assert.equal(Object.hasOwn(config, 'pak'), false)
			world.storage.set(key + suffix, JSON.stringify({ ...config, pak: PAK }))
		}
	}
	const refreshed = makeWorld({ storage: new Map(world.storage) })
	for (const channel of ['A', 'B']) for (const group of ['meter', 'ciu']) assert.equal(refreshed.panel(channel).input(group, 'pak').value, '')
})

test('logs are newest first, capped at 500 per channel, and clear independently', async () => {
	const world = makeWorld({ open: ['A', 'B'] })
	world.panel('A').start.click()
	world.panel('B').start.click()
	await flush()
	world.engines[1].log('B-sentinel')
	for (let index = 0; index < 505; index++) world.engines[0].log('entry-' + index)
	const log = world.panel('A').log
	assert.equal(log.children.length, 500)
	assert.equal(log.children[0].querySelector('.sts-sim-log-text').textContent, 'entry-504')
	assert.equal(log.lastChild.querySelector('.sts-sim-log-text').textContent, 'entry-5')
	assert.equal(log.scrollTop, 0)
	log.scrollTop = 60
	world.engines[0].log('scrolled')
	assert.equal(log.scrollTop, 80)
	world.panel('A').root.querySelector('#sts-sim-log-clear-A').click()
	assert.equal(log.children.length, 0)
	assert.match(world.panel('B').log.textContent, /B-sentinel/)
	for (let index = 0; index < 501; index++) world.engines[0].log('after-clear-' + index)
	assert.equal(log.children.length, 500)
	assert.equal(log.lastChild.querySelector('.sts-sim-log-text').textContent, 'after-clear-1')
})

test('alarm selection persists, renders selected summary, restores, and separates live values', async () => {
	const world = makeWorld({ open: ['A'] })
	const channelA = world.panel('A')
	const alarm = code => channelA.root.querySelector('#sts-sim-cfg-alarm-' + code + '-A')
	const summary = alarm('0001').closest('.sts-sim-alarm-block').querySelector('.sts-sim-alarm-summary')
	assert.equal(summary.textContent, '无告警')
	change(alarm('0002'), true)
	change(alarm('0001'), true)
	change(alarm('other'), '9999')
	assert.equal(world.saved('stsSim.meter2.A').alarmCodes, '0001 0002 9999')
	assert.deepEqual(summary.querySelectorAll('.sts-sim-alarm-code').map(node => node.textContent), ['0001', '0002', '9999'])
	assert.match(summary.textContent, /9999自定义/)
	assert.match(summary.textContent, /<img/)
	assert.match(alarm('0001').closest('.sts-sim-alarm-block').querySelector('summary').textContent, /3 项/)
	assert.equal(world.panel('B').root.querySelector('.sts-sim-alarm-summary').textContent, '无告警')
	const refreshed = makeWorld({ storage: new Map(world.storage) })
	assert.equal(refreshed.panel('A').root.querySelector('#sts-sim-cfg-alarm-0002-A').checked, true)
	assert.equal(refreshed.panel('A').root.querySelector('#sts-sim-cfg-alarm-other-A').value, '9999')
	channelA.start.click()
	await flush()
	assert.equal(world.engines[0].args.config.alarmCodes, '0001 0002 9999')
	world.engines[0].emitState({ alarms: ['0001'] })
	change(channelA.root.querySelector('#sts-sim-live-alarm-other-A'), '8888')
	assert.deepEqual(world.engines[0].state.alarms, ['0001', '8888'])
	assert.equal(world.saved('stsSim.meter2.A').alarmCodes, '0001 0002 9999')
})

test('manual stop and restart clear old CIU results without clearing the other channel', async () => {
	const world = makeWorld({ open: ['A', 'B'] })
	for (const channel of ['A', 'B']) {
		world.panel(channel).role('ciu')
		world.panel(channel).start.click()
	}
	await flush()
	for (const channel of ['A', 'B']) {
		world.panel(channel).input('ciu', 'status').click()
		await flush()
		assert.notEqual(world.panel(channel).root.querySelector('.sts-sim-result').textContent, '')
	}
	const resultA = world.panel('A').root.querySelector('.sts-sim-result')
	const resultB = world.panel('B').root.querySelector('.sts-sim-result')
	world.panel('A').start.click()
	assert.equal(resultA.textContent, '', 'manual stop removes old result immediately')
	assert.notEqual(resultB.textContent, '', 'B result survives stopping A')
	world.panel('A').start.click()
	await flush()
	assert.equal(resultA.textContent, '', 'restart does not reuse old result')
	assert.match(world.panel('A').status.textContent, /运行中/)
})

test('disconnect and automatic restart clear old CIU results', async () => {
	const world = makeWorld({ open: ['A'] })
	const panel = world.panel('A')
	panel.role('ciu')
	panel.start.click()
	await flush()
	panel.input('ciu', 'status').click()
	await flush()
	const result = panel.root.querySelector('.sts-sim-result')
	assert.notEqual(result.textContent, '')
	world.sessions.delete('A')
	await world.clock.advance(500)
	assert.equal(result.textContent, '')
	world.sessions.add('A')
	await world.clock.advance(500)
	assert.equal(world.engines.length, 2)
	assert.match(panel.status.textContent, /运行中/)
	assert.equal(result.textContent, '')
})

test('successful setTarget clears old CIU results and persists the accepted target', async () => {
	const world = makeWorld({ open: ['A'], deferTargets: true })
	const panel = world.panel('A')
	panel.role('ciu')
	panel.start.click()
	await flush()
	panel.input('ciu', 'status').click()
	await flush()
	const result = panel.root.querySelector('.sts-sim-result')
	assert.notEqual(result.textContent, '')
	const targetInput = panel.input('ciu', 'targetDrn')
	const target = '101876543210'
	change(targetInput, target)
	assert.equal(targetInput.disabled, true)
	assert.equal(world.targetCalls.length, 1)
	assert.equal(world.targetCalls[0].targetDrn, target)
	world.targetCalls[0].resolve()
	await flush()
	assert.equal(result.textContent, '')
	assert.equal(targetInput.disabled, false)
	assert.equal(world.saved('stsSim.ciu.A').targetDrn, target)
})

for (const completion of ['resolve', 'reject']) {
	test('late setTarget ' + completion + ' cannot unlock a new instance target switch', async () => {
		const world = makeWorld({ open: ['A'], deferTargets: true })
		const panel = world.panel('A')
		panel.role('ciu')
		panel.start.click()
		await flush()
		const targetInput = panel.input('ciu', 'targetDrn')
		change(targetInput, '101876543210')
		assert.equal(targetInput.disabled, true)
		const oldCall = world.targetCalls[0]
		panel.start.click()
		panel.start.click()
		await flush()
		assert.notEqual(world.engines[0], world.engines[1])
		const newTarget = '101234567890'
		change(targetInput, newTarget)
		assert.equal(world.targetCalls.length, 2)
		assert.equal(targetInput.disabled, true)
		const newCall = world.targetCalls[1]
		assert.notEqual(oldCall.engine, newCall.engine)
		const savedBefore = world.storage.get('stsSim.ciu.A')
		const logCount = panel.log.children.length
		if (completion === 'resolve') oldCall.resolve()
		else oldCall.reject(new Error('合成迟到切换失败'))
		await flush()
		assert.equal(world.storage.get('stsSim.ciu.A'), savedBefore, 'stale switch does not overwrite new configuration')
		assert.equal(targetInput.value, newTarget)
		assert.equal(panel.log.children.length, logCount)
		assert.equal(targetInput.disabled, true)
		await world.clock.advance(1000)
		assert.equal(targetInput.disabled, true, 'later rendering cannot release the new switching lock')
		newCall.resolve()
		await flush()
		assert.equal(targetInput.disabled, false)
		assert.equal(world.saved('stsSim.ciu.A').targetDrn, newTarget)
	})
}

test('untrusted logs, meter state, alarm labels and CIU results use textContent', async () => {
	const world = makeWorld({ open: ['A', 'B'] })
	world.panel('A').start.click()
	world.panel('B').role('ciu')
	world.panel('B').start.click()
	await flush()
	world.engines[0].log(unsafe)
	assert.equal(world.panel('A').log.children[0].querySelector('.sts-sim-log-text').textContent, unsafe)
	world.engines[0].emitState({ drn: unsafe, meterNo: unsafe, alarms: [unsafe, '0002'] })
	assert.match(world.panel('A').root.querySelector('.sts-sim-meter-view').textContent, /<img/)
	world.panel('B').input('ciu', 'status').click()
	await flush()
	assert.match(world.panel('B').root.querySelector('.sts-sim-result').textContent, /<img/)
	assert.match(world.panel('B').log.textContent, /<img/)
	assert.equal(world.root.querySelectorAll('img').length, 0)
})

test('opening the panel switches the top protocol to hostproto and closing restores the previous one', async () => {
	const world = makeWorld({ protocol: 'cjt188' })
	world.setShown(true)
	await world.clock.advance(500)
	assert.equal(world.protocol.value, 'hostproto')
	assert.deepEqual(world.protocol.changes, ['hostproto'], 'change is dispatched so parsers and persistence follow')
	await world.clock.advance(1000)
	assert.equal(world.protocol.changes.length, 1, 'no repeated switching while shown')
	world.setShown(false)
	await world.clock.advance(500)
	assert.equal(world.protocol.value, 'cjt188')
	assert.equal(world.storage.has('stsSim.prevProtocol'), false)

	// 面板开着刷新：打开前的协议从 localStorage 取回，关闭后仍能恢复
	world.setShown(true)
	await world.clock.advance(500)
	const refreshed = makeWorld({ storage: new Map(world.storage), protocol: 'hostproto', shown: true })
	await refreshed.clock.advance(500)
	assert.deepEqual(refreshed.protocol.changes, [])
	refreshed.setShown(false)
	await refreshed.clock.advance(500)
	assert.equal(refreshed.protocol.value, 'cjt188')

	// 打开期间用户手动换了协议：关闭时不覆盖用户选择
	const manual = makeWorld({ protocol: 'sek' })
	manual.setShown(true)
	await manual.clock.advance(500)
	manual.protocol.value = 'cjt188'
	manual.setShown(false)
	await manual.clock.advance(500)
	assert.equal(manual.protocol.value, 'cjt188')
	assert.deepEqual(manual.protocol.changes, ['hostproto'])
})

test('with per-lane protocols, opening the panel switches every visible lane to hostproto and closing restores each lane', async () => {
	const world = makeWorld({ mode: 'dual', lanes: { S: 'sek', A: 'cjt188', B: 'sek' } })
	world.setShown(true)
	await world.clock.advance(500)
	assert.deepEqual(world.laneProtos, { S: 'sek', A: 'hostproto', B: 'hostproto' }, 'both dual lanes are parsed as hostproto, single lane untouched')
	assert.deepEqual(world.protocol.changes, [], 'top select is driven through serialLanes, not directly')
	await world.clock.advance(1000)
	assert.equal(world.laneCalls.length, 2, 'no repeated switching while shown')
	// 面板开着回到单路：新出现的单路也切过去
	world.setMode('single')
	await world.clock.advance(500)
	assert.equal(world.laneProtos.S, 'hostproto')
	// 用户手动把 B 改走：关闭时不覆盖
	world.laneProtos.B = 'cjt188'
	world.setShown(false)
	await world.clock.advance(500)
	assert.deepEqual(world.laneProtos, { S: 'sek', A: 'cjt188', B: 'cjt188' })
	assert.equal(world.storage.has('stsSim.prevProtocol'), false)

	// 面板开着刷新：每路打开前的协议从 localStorage 取回
	world.setMode('dual')
	world.setShown(true)
	await world.clock.advance(500)
	const refreshed = makeWorld({ mode: 'dual', storage: new Map(world.storage), lanes: { ...world.laneProtos }, shown: true })
	await refreshed.clock.advance(500)
	assert.deepEqual(refreshed.laneCalls, [])
	refreshed.setShown(false)
	await refreshed.clock.advance(500)
	assert.deepEqual(refreshed.laneProtos, { S: 'sek', A: 'cjt188', B: 'cjt188' })

	// 升级前存下的单个值按单路恢复
	const legacy = makeWorld({ mode: 'single', storage: new Map([['stsSim.prevProtocol', JSON.stringify('cjt188')]]), lanes: { S: 'hostproto', A: 'sek', B: 'sek' }, shown: true })
	await legacy.clock.advance(500)
	legacy.setShown(false)
	await legacy.clock.advance(500)
	assert.equal(legacy.laneProtos.S, 'cjt188')
})

test('per-session collapse state persists; summary strip expands and scrolls to a panel', async () => {
	const world = makeWorld({ open: ['A', 'B'] })
	const a = world.panel('A')
	assert.equal(a.toggle.getAttribute('aria-expanded'), 'true')
	assert.equal(a.body.hidden, false)
	assert.equal(a.toggle.classList.contains('ctl-toggle'), false, 'expand/collapse is not a ctl-* control')
	a.toggle.click()
	assert.equal(a.toggle.getAttribute('aria-expanded'), 'false')
	assert.equal(a.body.hidden, true)
	assert.equal(world.saved('stsSim.collapsed.A'), true)
	assert.equal(world.saved('stsSim.collapsed.B'), null)
	assert.equal(world.saved('stsSim.collapsed'), null)
	assert.equal(a.start.hidden, false, 'header controls stay visible when collapsed')
	const refreshed = makeWorld({ storage: new Map(world.storage) })
	assert.equal(refreshed.panel('A').body.hidden, true)
	assert.equal(refreshed.panel('A').toggle.getAttribute('aria-expanded'), 'false')
	assert.equal(refreshed.panel('B').body.hidden, false)
	const items = refreshed.root.querySelector('.sts-sim-summary').querySelectorAll('button')
	assert.equal(items.length, 2)
	assert.equal(items[0].textContent, 'A路 · 表端 · 已停止')
	items[0].click()
	assert.equal(refreshed.panel('A').body.hidden, false)
	assert.equal(refreshed.saved('stsSim.collapsed.A'), false)
	assert.equal(refreshed.panel('A').root.scrollIntoViewCalls.length, 1)
	assert.equal(refreshed.panel('B').root.scrollIntoViewCalls.length, 0)
})

test('display names follow serial labels and the summary reflects role and state', async () => {
	const world = makeWorld({ open: ['A', 'B'], labels: { A: 'COM3' } })
	assert.equal(world.panel('A').title.textContent, 'A路 · COM3')
	assert.equal(world.panel('B').title.textContent, 'B路')
	world.panel('B').role('ciu')
	world.panel('A').start.click()
	await flush()
	await world.clock.advance(500)
	const items = world.root.querySelector('.sts-sim-summary').querySelectorAll('button')
	assert.equal(items[0].textContent, 'A路 · COM3 · 表端 · 运行中')
	assert.equal(items[1].textContent, 'B路 · CIU · 已停止')
	world.labels.B = '/dev/cu.usbserial-1'
	world.labels.A = 'A路'
	await world.clock.advance(500)
	assert.equal(world.panel('A').title.textContent, 'A路', 'default label is not repeated')
	world.labels.A = ''
	await world.clock.advance(500)
	assert.equal(world.panel('A').title.textContent, 'A路')
	assert.equal(world.panel('B').title.textContent, 'B路 · /dev/cu.usbserial-1')
	assert.match(world.panel('B').root.querySelector('.sts-sim-logcard').textContent, /B路 · \/dev\/cu\.usbserial-1 日志/)
	assert.equal(world.panel('S').title.textContent, '单路')
	assert.doesNotMatch(world.panel('A').root.textContent, /通道/)
})

for (const [mode, sid] of [['single', 'S'], ['dual', 'A']]) {
	test(sid + ' configuration section collapses after start and is not reopened after stop', async () => {
		const world = makeWorld({ mode, open: [sid] })
		const panel = world.panel(sid)
		assert.equal(panel.cfg.open, true)
		panel.start.click()
		assert.equal(panel.cfg.open, true, 'still open while starting')
		await flush()
		assert.match(panel.status.textContent, /运行中/)
		assert.equal(panel.cfg.open, false)
		panel.cfg.open = true // 用户手动展开随意
		panel.start.click()
		assert.equal(panel.cfg.open, true)
		panel.cfg.open = false
		panel.start.click()
		await flush()
		panel.start.click()
		assert.equal(panel.cfg.open, false, 'stopping does not reopen it')
	})
}

;(async function () {
	let failures = 0
	for (const { name, run } of tests) {
		try { await run(); console.log('PASS ' + name) }
		catch (error) { failures++; console.error('FAIL ' + name); console.error(error.stack) }
	}
	console.log('\n' + (tests.length - failures) + '/' + tests.length + ' passed; ' + failures + ' failed')
	if (failures) process.exitCode = 1
})()
