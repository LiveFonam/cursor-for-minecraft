// The evil god's plan and model calls, on a fake console and a fake model. Nothing here reaches a real API.

const test = require('node:test')
const assert = require('node:assert/strict')
const scene = require('../scene')
const plan = require('../evil_plan')
const { EvilBrain, MAX_CALLS, TIMEOUT_MS } = require('../evil_brain')
const { DemoController } = require('../controller')

const STAGE = { x: 10, y: -60, z: 20 }
const SETTINGS = { player: 'Viewer', agent: 'Agent1', dummy: 'Dummy', fighterName: 'Fighter', stage: STAGE, cueMobSeconds: 0, cueAnimalSeconds: 0 }
const GOOD = { wall: 'west', approach: 'left', zombies: 'flank', line: 'Your walls are a suggestion.' }
const textReply = value => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })

function fakeTimers () {
  let id = 0
  const t = {
    intervals: new Map(),
    timeouts: new Map(),
    setInterval: fn => { t.intervals.set(++id, fn); return id },
    clearInterval: i => t.intervals.delete(i),
    setTimeout: (fn, ms) => { t.timeouts.set(++id, { fn, ms }); return id },
    clearTimeout: i => t.timeouts.delete(i),
    now: () => 0,
    has: ms => [...t.timeouts.values()].some(x => x.ms === ms),
    fire (ms) {
      for (const [i, x] of [...t.timeouts]) if (x.ms === ms) { t.timeouts.delete(i); return x.fn() }
      throw new Error(`no timer of ${ms}`)
    }
  }
  return t
}

// answers: one reply per call, the last repeats. A function is called, so it can throw or never settle
function fakeClient (answers) {
  const list = Array.isArray(answers) ? answers : [answers]
  const client = {
    calls: [],
    messages: {
      create: async params => {
        client.calls.push(params)
        const a = list[Math.min(client.calls.length - 1, list.length - 1)]
        return typeof a === 'function' ? a(params) : textReply(a)
      }
    }
  }
  return client
}

function rig ({ answers, director = false, replies = {}, client: given } = {}) {
  const sent = []
  const logs = []
  const table = { ...replies, 'director status': director ? 'director: idle' : 'Unknown command', 'execute if entity': 'Test passed' }
  const rcon = {
    send: async c => {
      sent.push(c)
      for (const [start, r] of Object.entries(table)) if (c.startsWith(start)) return typeof r === 'function' ? r(c) : r
      return ''
    }
  }
  const timers = fakeTimers()
  const client = given === undefined ? fakeClient(answers) : given
  const log = l => logs.push(l)
  const brain = new EvilBrain({ client: client || undefined, credentials: client ? { key: 'sk-test-secret' } : null, log, timers })
  const bot = { entity: { position: { x: -5, y: -60, z: 20 } }, health: 18 }
  const agents = { agentBot: () => bot, stopAgent: async () => {}, runTask: async () => {}, dummyHas: async () => false }
  const c = new DemoController({ settings: SETTINGS, rcon, agents, spawnDuel: () => null, log, sleep: async () => {}, timers, brain, hostile: [] })
  return { c, sent, logs, timers, client, brain }
}

const summons = (sent, kind) => sent.filter(s => s.startsWith(`summon minecraft:${kind}`))
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)) }

test('plan menu: takes a valid plan and refuses anything off the menu', () => {
  assert.deepEqual(plan.checkPlan(JSON.stringify(GOOD)), GOOD)
  assert.deepEqual(plan.checkPlan('```json\n' + JSON.stringify(GOOD) + '\n```'), GOOD)
  for (const bad of [
    'no json here', '[]', 'null', '{}',
    JSON.stringify({ ...GOOD, wall: 'up' }),
    JSON.stringify({ ...GOOD, approach: 'above' }),
    JSON.stringify({ ...GOOD, zombies: 'all' }),
    JSON.stringify({ ...GOOD, wall: ['west'] }),
    JSON.stringify({ ...GOOD, wall: 'constructor' }),
    JSON.stringify({ ...GOOD, line: 7 }),
    JSON.stringify({ ...GOOD, command: 'kill @a' }),
    JSON.stringify({ wall: 'west', approach: 'left', zombies: 'flank' })
  ]) assert.equal(plan.checkPlan(bad), null, bad)
  assert.deepEqual(plan.checkMove('{"action":"regroup","line":"Together."}'), { action: 'regroup', line: 'Together.' })
  assert.equal(plan.checkMove('{"action":"summon","line":"x"}'), null)
  assert.equal(plan.checkMove('{"action":"press","line":"x","extra":1}'), null)
})

test('villain line: plain characters only and length limited', () => {
  const dirty = plan.cleanLine('Hi"} ,{"text":"x\\ \n§c@a /kill [me]')
  assert.match(dirty, /^[A-Za-z0-9 .,!?'-]*$/)
  assert.ok(plan.cleanLine('word '.repeat(100)).length <= plan.LINE_MAX)
  assert.ok(plan.cleanLine('x'.repeat(500)).length <= plan.LINE_MAX)
  assert.equal(plan.cleanLine(12), '')
})

test('geometry: every wall and approach stays in the cleared strip, outside the walls', () => {
  const L = plan.layoutOf(STAGE)
  for (const wall of Object.keys(plan.WALLS)) {
    for (const approach of Object.keys(plan.APPROACH)) {
      for (const zombies of plan.SPLITS) {
        const p = { wall, approach, zombies }
        const lines = [...plan.creeperCommands(STAGE, p), ...plan.zombieCommands(STAGE, p)].filter(l => l.startsWith('summon'))
        assert.equal(lines.length, 4)
        for (const l of lines) {
          const [, , x, , z] = l.split(' ').map(Number)
          const dx = Math.floor(x) - L.x
          const dz = Math.floor(z) - L.z
          assert.ok(Math.max(Math.abs(dx), Math.abs(dz)) === L.spawnOut, l)
        }
      }
    }
  }
})

test('a valid plan is followed: wall, approach, split and the villain line', async () => {
  const { c, sent, timers, logs, client } = rig({ answers: [GOOD, { action: 'press', line: 'Now.' }] })
  await c.handle('!evil', 'Viewer')
  const want = plan.creeperCommands(STAGE, GOOD)[0]
  assert.ok(sent.includes(want))
  assert.notEqual(want, scene.creeperCommands(STAGE)[0])
  assert.ok(sent.includes('tellraw Viewer "Evil god: Your walls are a suggestion."'))
  await timers.fire(3000)
  await settle()
  for (const l of plan.igniteCommands(STAGE, GOOD)) assert.ok(sent.includes(l), l)
  for (const l of plan.zombieCommands(STAGE, GOOD)) assert.ok(sent.includes(l), l)
  assert.equal(summons(sent, 'creeper').length, 1)
  assert.equal(summons(sent, 'zombie').length, 3)
  assert.equal(client.calls.length, 2)
  assert.equal(client.calls[0].model, 'claude-haiku-5-5')
  assert.ok(logs.some(l => l.startsWith('evil-brain 1/3 opening: west left flank')))
})

test('the model sees numbers and menu words, never a player name', async () => {
  const { c, client } = rig({ answers: GOOD, replies: {
    'data get entity Viewer Pos': 'Viewer has the following entity data: [-6.5d, -60.0d, 21.5d]',
    'data get entity Viewer Health': 'Viewer has the following entity data: 14.0f'
  } })
  await c.handle('!evil', 'Viewer')
  const body = client.calls[0].messages[0].content
  assert.ok(!body.includes('Viewer') && !body.includes('Agent1'))
  const s = JSON.parse(body)
  assert.deepEqual([s.player.dx, s.player.dz, s.player.health, s.player.inside], [0, 2, 14, true])
  assert.equal(s.base.door, 'south')
  assert.equal(s.mobs.zombies_waiting, 3)
})

for (const [name, answer] of [
  ['not JSON', 'I will destroy you'],
  ['off the menu', { ...GOOD, wall: 'roof' }],
  ['an extra field', { ...GOOD, command: 'op Viewer' }],
  ['a refusal', () => ({ stop_reason: 'refusal', content: [] })],
  ['an API error', () => { throw new Error('boom') }]
]) {
  test(`${name} falls back to the scripted breach`, async () => {
    const { c, sent, timers, logs } = rig({ answers: answer })
    await c.handle('!evil', 'Viewer')
    assert.ok(sent.includes(scene.creeperCommands(STAGE)[0]))
    assert.ok(logs.some(l => /opening: scripted/.test(l)))
    await timers.fire(3000)
    await settle()
    for (const l of scene.igniteCommands(STAGE)) assert.ok(sent.includes(l), l)
    for (const l of scene.zombieCommands(STAGE)) assert.ok(sent.includes(l), l)
    assert.equal(summons(sent, 'creeper').length, 1)
    assert.equal(summons(sent, 'zombie').length, 3)
  })
}

test('a model that never answers times out and the invasion still happens', async () => {
  const client = fakeClient(() => new Promise(() => {}))
  const { c, sent, timers, logs } = rig({ client })
  const going = c.handle('!evil', 'Viewer')
  for (let i = 0; i < 50 && !timers.has(TIMEOUT_MS); i++) await settle()
  assert.equal(summons(sent, 'creeper').length, 0)
  timers.fire(TIMEOUT_MS)
  await going
  assert.ok(logs.some(l => /opening: scripted \(.*timed out/.test(l)))
  assert.equal(summons(sent, 'creeper').length, 1)
  await timers.fire(3000)
  await settle()
  assert.equal(summons(sent, 'zombie').length, 3)
  assert.equal(client.calls.length, 1, 'no more calls after a failure')
})

test('no key: no call, the scripted plan, and it says so', async () => {
  const { c, sent, timers, logs, brain } = rig({ client: null })
  assert.equal(brain.enabled, false)
  await c.handle('!evil', 'Viewer')
  assert.ok(logs.some(l => l.includes('opening: scripted (no key)')))
  await timers.fire(3000)
  await settle()
  assert.equal(summons(sent, 'zombie').length, 3)
  assert.equal(c.raid.watcher, null, 'no model, so nothing watches for a moment to ask it')
})

test('the key never reaches a log, even inside an error message', async () => {
  const { c, logs } = rig({ answers: () => { throw new Error('bad key sk-test-secret here') } })
  await c.handle('!evil', 'Viewer')
  assert.ok(logs.length > 0)
  assert.ok(logs.every(l => !l.includes('sk-test-secret')))
})

test('the call cap holds however many zombies die', async () => {
  let alive = 3
  const { c, timers, client, sent } = rig({
    answers: [GOOD, { action: 'press', line: 'a' }, { action: 'regroup', line: 'b' }, { action: 'flank', line: 'c' }],
    replies: { 'execute if entity @e[tag=demo_evil,type=minecraft:zombie]': () => alive ? `Test passed, count: ${alive}` : 'Test failed' }
  })
  await c.handle('!evil', 'Viewer')
  await timers.fire(3000)
  await settle()
  const raid = c.raid
  assert.ok(raid.watcher)
  await raid.tick()
  for (alive of [2, 1, 0]) await raid.tick()
  assert.equal(client.calls.length, MAX_CALLS)
  assert.equal(summons(sent, 'zombie').length, 3, 'a change of plan never adds a mob')
  assert.equal(raid.watcher, null)
})

test('a zombie dying can move the survivors, by the script\'s own command', async () => {
  let alive = 3
  const { c, timers, sent } = rig({
    answers: [GOOD, { action: 'press', line: 'a' }, { action: 'regroup', line: 'To the hole.' }],
    replies: { 'execute if entity @e[tag=demo_evil,type=minecraft:zombie]': () => `Test passed, count: ${alive}` }
  })
  await c.handle('!evil', 'Viewer')
  await timers.fire(3000)
  await settle()
  await c.raid.tick()
  alive = 2
  await c.raid.tick()
  assert.ok(sent.includes(plan.moveCommands(STAGE, GOOD, 'regroup')[0]))
  assert.ok(sent.includes('tellraw Viewer "Evil god: To the hole."'))
})

test('with the director on, the model speaks but the script moves nothing', async () => {
  let alive = 3
  const { c, sent } = rig({
    director: true,
    answers: [GOOD, { action: 'regroup', line: 'Hold.' }],
    replies: { 'execute if entity @e[tag=demo_evil,type=minecraft:zombie]': () => `Test passed, count: ${alive}` }
  })
  await c.handle('!evil', 'Viewer')
  assert.ok(sent.includes('director start Viewer'))
  assert.equal(summons(sent, 'zombie').length, 3)
  await c.raid.tick()
  alive = 2
  await c.raid.tick()
  assert.ok(sent.includes('tellraw Viewer "Evil god: Hold."'))
  assert.ok(!sent.some(s => s.startsWith('tp @e[tag=demo_evil,type=minecraft:zombie')))
})

test('no model text reaches a server command except the cleaned villain line', async () => {
  const evil = 'XMARK"} run op Viewer \\ @a §c'
  let alive = 3
  const { c, sent, timers } = rig({
    answers: [{ ...GOOD, line: evil }, { action: 'flank', line: evil }, { action: 'regroup', line: evil }],
    replies: { 'execute if entity @e[tag=demo_evil,type=minecraft:zombie]': () => `Test passed, count: ${alive}` }
  })
  await c.handle('!evil', 'Viewer')
  await timers.fire(3000)
  await settle()
  await c.raid.tick()
  alive = 2
  await c.raid.tick()
  const marked = sent.filter(s => s.includes('XMARK'))
  assert.ok(marked.length >= 2)
  for (const s of marked) {
    assert.match(s, /^tellraw Viewer "Evil god: [A-Za-z0-9 .,!?'-]{1,80}"$/)
  }
  assert.ok(!sent.some(s => s.startsWith('op ')))
})

test('a reset during the model call stops the invasion cold', async () => {
  let release
  const client = fakeClient([GOOD, () => new Promise(resolve => { release = resolve })])
  const { c, sent, timers } = rig({ client })
  await c.handle('!evil', 'Viewer')
  const blast = timers.fire(3000)
  for (let i = 0; i < 50 && !release; i++) await settle()
  await c.handle('!reset', 'Viewer')
  release(textReply({ action: 'press', line: 'Too late.' }))
  await blast
  await settle()
  assert.equal(summons(sent, 'zombie').length, 0)
  assert.ok(!sent.some(s => s.includes('Too late')))
  assert.equal(c.raid, null)
})

test('a base the plan cannot read means the scripted breach and no model call', async () => {
  const real = scene.baseCommands
  const { c, sent, client, logs } = rig({ answers: GOOD })
  scene.baseCommands = s => real(s).filter(l => !l.includes('cobblestone'))
  try {
    await c.handle('!evil', 'Viewer')
  } finally {
    scene.baseCommands = real
  }
  assert.equal(client.calls.length, 0)
  assert.ok(sent.includes(scene.creeperCommands(STAGE)[0]))
  assert.ok(logs.some(l => l.includes('scripted (situation not readable)')))
})

test('a failure while reading the situation never stops the invasion', async () => {
  const { c, sent, timers, client } = rig({ answers: GOOD })
  c.agents.agentBot = () => { throw new Error('no bot') }
  await c.handle('!evil', 'Viewer')
  await timers.fire(3000)
  await settle()
  assert.equal(client.calls.length, 0)
  assert.equal(summons(sent, 'creeper').length, 1)
  assert.equal(summons(sent, 'zombie').length, 3)
})

// The same check the demo's own command test makes, over everything this menu can send
const WIDTH = { 'minecraft:vec3': 3, 'minecraft:block_pos': 3, 'minecraft:rotation': 2, 'minecraft:column_pos': 2, 'minecraft:vec2': 2 }
const NUMBER = /^-?\d+(\.\d+)?$/
const fits = (parser, word) => {
  if (parser === 'brigadier:integer') return /^-?\d+$/.test(word)
  if (parser === 'brigadier:float' || parser === 'brigadier:double') return NUMBER.test(word)
  if (parser === 'brigadier:bool') return word === 'true' || word === 'false'
  if (WIDTH[parser]) return word === '~' || NUMBER.test(word)
  return true
}

function splitCommand (line) {
  const out = []
  let word = ''
  let depth = 0
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      word += ch
      if (ch === '\\') word += line[++i]
      else if (ch === '"') quoted = false
    } else if (ch === '"') {
      quoted = true
      word += ch
    } else if (ch === ' ' && depth === 0) {
      out.push(word)
      word = ''
    } else {
      if ('[{'.includes(ch)) depth++
      if (']}'.includes(ch)) depth--
      word += ch
    }
  }
  out.push(word)
  return out
}

function walks (root, node, words, i) {
  if (i === words.length) return !!node.executable
  const from = node.redirects?.length ? root.children.find(c => c.name === node.redirects[0]) : node
  if (from !== node && walks(root, from, words, i)) return true
  for (const child of node.children || []) {
    if (child.type === 'literal') {
      if (child.name === words[i] && walks(root, child.name === 'run' ? root : child, words, i + 1)) return true
    } else {
      const n = WIDTH[child.parser?.parser] || 1
      if (i + n > words.length) continue
      if (words.slice(i, i + n).every(w => fits(child.parser?.parser, w)) && walks(root, child, words, i + n)) return true
    }
  }
  return false
}

test('every command the menu can send fits the game\'s command tree', () => {
  const root = require('minecraft-data')('1.21.11').commands.root
  const lines = new Set(['data get entity Viewer Pos', 'data get entity Viewer Health',
    'execute if entity @e[tag=demo_evil,type=minecraft:zombie]', `tellraw Viewer ${JSON.stringify(plan.villainText('Your walls are mine.'))}`])
  for (const wall of Object.keys(plan.WALLS)) {
    for (const approach of Object.keys(plan.APPROACH)) {
      for (const zombies of plan.SPLITS) {
        const p = { wall, approach, zombies }
        for (const l of [...plan.creeperCommands(STAGE, p), ...plan.zombieCommands(STAGE, p), ...plan.igniteCommands(STAGE, p)]) lines.add(l)
        for (const m of plan.MOVES) for (const l of plan.moveCommands(STAGE, p, m)) lines.add(l)
        for (const away of [false, true]) {
          const w = plan.waveCommands(STAGE, p, { player: { x: 100, y: 64, z: 100 }, away, creeper: 1, zombies: 6 })
          for (const l of [...w.creeper, ...w.zombies]) lines.add(l)
        }
        lines.add(plan.regatherCommand('Viewer', { x: 100, y: 64, z: 100 }, wall))
      }
    }
  }
  const bad = [...lines].filter(l => !walks(root, root, splitCommand(l), 0))
  assert.deepEqual(bad, [])
  assert.ok(lines.size > 50, `only ${lines.size} lines checked`)
})
