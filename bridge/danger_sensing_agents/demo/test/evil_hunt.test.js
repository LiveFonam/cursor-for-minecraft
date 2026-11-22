// The always-on evil mode, on fake timers, a fake model and a fake console. Nothing here reaches a server or an API.

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { EVIL_LIMITS: L } = require('../settings')
const { EvilBrain, CallBudget } = require('../evil_brain')
const { DemoController } = require('../controller')

const STAGE = { x: 10, y: -60, z: 20 }
const SETTINGS = { player: 'Viewer', agent: 'Agent1', dummy: 'Dummy', fighterName: 'Fighter', stage: STAGE, cueMobSeconds: 0, cueAnimalSeconds: 0, fightSeconds: 60 }
const PLAN = { wall: 'west', approach: 'left', zombies: 'breach', line: 'Again.' }
const textReply = value => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }] })
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)) }
const isSummon = s => /(^|run )summon minecraft:(zombie|creeper)/.test(s)

function rig ({ answer = () => textReply(PLAN), keyless = false, gate = null, spawnDuel = () => null } = {}) {
  const world = { alive: 0, peak: 0, deaths: 0, health: 20, pos: { x: 11.5, y: -60, z: 20.5 }, holes: [] }
  const sent = []
  const tasks = []
  let clock = 1000
  let id = 0
  const timers = {
    intervals: new Map(),
    timeouts: new Map(),
    setInterval: fn => { timers.intervals.set(++id, fn); return id },
    clearInterval: i => timers.intervals.delete(i),
    setTimeout: (fn, ms) => { timers.timeouts.set(++id, { fn, ms }); return id },
    clearTimeout: i => timers.timeouts.delete(i),
    now: () => clock,
    fire (ms) {
      for (const [i, x] of [...timers.timeouts]) if (x.ms === ms) { timers.timeouts.delete(i); return x.fn() }
      throw new Error(`no timer of ${ms}`)
    }
  }
  const rcon = {
    send: async c => {
      sent.push(c)
      if (isSummon(c)) {
        if (gate) await gate(c)
        world.alive++
        world.peak = Math.max(world.peak, world.alive)
        return 'Summoned'
      }
      if (c === 'kill @e[tag=demo_evil]') { world.alive = 0; return 'Killed' }
      if (c.startsWith('director status')) return 'Unknown command'
      if (c.startsWith('execute if entity @e[tag=demo_evil_creeper]')) return 'Test failed'
      if (c.startsWith('execute if entity @e[tag=demo_evil')) return world.alive ? `Test passed, count: ${world.alive}` : 'Test failed'
      if (c.startsWith('execute if block')) return world.holes.some(h => c.startsWith(`execute if block ${h} `)) ? 'Test passed' : 'Test failed'
      if (c.startsWith('scoreboard players get')) return `Viewer has ${world.deaths} [demo_deaths]`
      if (c === 'data get entity Viewer Pos') return `Viewer has the following entity data: [${world.pos.x}d, ${world.pos.y}d, ${world.pos.z}d]`
      if (c === 'data get entity Viewer Health') return `Viewer has the following entity data: ${world.health}f`
      return ''
    }
  }
  const client = { calls: [], messages: { create: async p => { client.calls.push(p); return answer(client.calls.length) } } }
  const brain = new EvilBrain(keyless ? { credentials: null, timers } : { client, credentials: { key: 'sk-test-secret' }, timers })
  const bot = { entity: { position: { x: 8, y: -60, z: 20 } }, health: 20 }
  const agents = { agentBot: () => bot, stopAgent: async () => {}, runTask: async t => { tasks.push(t) } }
  const c = new DemoController({ settings: SETTINGS, rcon, agents, spawnDuel, sleep: async () => {}, timers, brain, hostile: ['spider'] })
  const step = async (ms = 0) => {
    clock += ms
    await c.hunt.tick()
    await settle()
  }
  // !evil, the blast, and the first wave's zombies
  const startEvil = async () => {
    await c.handle('!evil', 'Viewer')
    await timers.fire(3000)
    await settle()
  }
  // Clears the board and walks through the pause to the next wave
  const nextWave = async () => {
    world.alive = 0
    await step(0)
    await step(L.waveGapMs)
  }
  const summons = () => sent.filter(isSummon).length
  return { c, sent, world, timers, tasks, client, brain, step, startEvil, nextWave, summons, advance: ms => { clock += ms } }
}

test('hunt: waves keep coming after each one is cleared', async () => {
  const r = rig()
  await r.startEvil()
  assert.equal(r.c.state, 'evil')
  for (let wave = 2; wave <= 5; wave++) {
    const before = r.summons()
    await r.nextWave()
    assert.ok(r.summons() > before, `wave ${wave} spawned`)
    assert.equal(r.c.hunt.wave, wave)
    assert.equal(r.c.state, 'evil')
  }
})

test('hunt: the pause between waves holds', async () => {
  const r = rig()
  await r.startEvil()
  const before = r.summons()
  r.world.alive = 0
  await r.step(0)
  await r.step(L.waveGapMs - 1)
  assert.equal(r.summons(), before)
  await r.step(1)
  assert.ok(r.summons() > before)
})

test('hunt: the mob cap holds even when nothing ever dies', async () => {
  const r = rig()
  await r.startEvil()
  for (let i = 0; i < 12; i++) await r.step(L.waveMaxMs)
  assert.ok(r.world.peak <= L.maxAlive, `peak ${r.world.peak}`)
  assert.equal(r.world.alive, L.maxAlive)
})

test('hunt: waves escalate up to the per-wave limit, and zombies keep their axes', async () => {
  const r = rig()
  await r.startEvil()
  let biggest = 0
  for (let i = 0; i < 14; i++) {
    const from = r.sent.length
    await r.nextWave()
    const zombies = r.sent.slice(from).filter(s => /summon minecraft:zombie/.test(s))
    assert.ok(zombies.every(s => s.includes('minecraft:wooden_axe')))
    biggest = Math.max(biggest, zombies.length)
  }
  assert.equal(biggest, L.maxZombies)
})

test('hunt: a player who left the base is hunted where he is', async () => {
  const r = rig()
  await r.startEvil()
  r.world.pos = { x: 200.5, y: 70, z: -150.5 }
  const from = r.sent.length
  await r.nextWave()
  const lines = r.sent.slice(from).filter(isSummon)
  assert.ok(lines.length > 0)
  for (const l of lines) {
    const m = l.match(/^execute positioned (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) positioned over motion_blocking_no_leaves run summon minecraft:\w+ ~ ~ ~ /)
    assert.ok(m, l)
    assert.ok(Math.hypot(Number(m[1]) - 200.5, Number(m[3]) + 150.5) <= 16, l)
  }
})

test('hunt: a full cap of mobs left behind is brought to him, so the hunt never stalls', async () => {
  const r = rig()
  await r.startEvil()
  for (let i = 0; i < 6; i++) await r.step(L.waveMaxMs)
  assert.equal(r.world.alive, L.maxAlive)
  r.world.pos = { x: 300.5, y: 70, z: 300.5 }
  const from = r.sent.length
  await r.step(L.waveMaxMs)
  const line = r.sent.slice(from).find(s => s.includes('spreadplayers'))
  assert.ok(line, 'the strays are moved')
  assert.ok(line.startsWith('execute at Viewer run spreadplayers ') && line.includes('tag=demo_evil,distance=32..'), line)
  assert.equal(r.world.alive, L.maxAlive, 'and none are added')
})

test('hunt: with no model, the wave comes through the wall that is already open', async () => {
  const r = rig({ keyless: true })
  await r.startEvil()
  const walls = require('../evil_plan').wallProbes(require('../evil_plan').layoutOf(STAGE))
  const north = walls.find(p => p.wall === 'north')
  r.world.holes = [`${north.x} ${north.y} ${north.z}`]
  const from = r.sent.length
  await r.nextWave()
  const z = r.sent.slice(from).filter(isSummon).map(s => Number(s.split(' ')[4]))
  assert.ok(z.length > 0 && z.every(v => v < north.z), 'mobs land outside the north wall')
})

test('hunt: each wave tells the model the situation, in numbers and menu words only', async () => {
  const r = rig()
  await r.startEvil()
  const before = r.client.calls.length
  await r.nextWave()
  assert.equal(r.client.calls.length, before + 1)
  const seen = JSON.parse(r.client.calls.at(-1).messages[0].content)
  assert.equal(seen.event, 'wave')
  assert.equal(seen.hunt.wave, 2)
  assert.equal(seen.hunt.last_wave, 'cleared')
  assert.deepEqual(seen.hunt.walls_open, [])
  assert.ok(!JSON.stringify(seen).includes('Viewer'))
})

test('off: a model reply that lands after the turn-off spawns nothing', async () => {
  let release
  const r = rig({ answer: n => n <= 2 ? textReply(PLAN) : new Promise(resolve => { release = resolve }) })
  await r.startEvil()
  // the first wave's two calls answer, so the wave 2 call is the one left hanging
  r.world.alive = 0
  await r.step(0)
  r.advance(L.waveGapMs)
  const pending = r.c.hunt.tick()
  for (let i = 0; i < 20 && !release; i++) await settle()
  assert.ok(release, 'the wave is waiting on the model')
  const before = r.summons()
  await r.c.handle('!stop', 'Viewer')
  assert.equal(r.c.state, 'idle')
  release(textReply({ ...PLAN, line: 'Too late.' }))
  await pending
  await settle()
  assert.equal(r.summons(), before)
  assert.ok(!r.sent.some(s => s.includes('Too late')))
})

test('off: a turn-off in the middle of a wave stops the rest of it', async () => {
  let hold = false
  let open
  const r = rig({ gate: () => hold ? new Promise(resolve => { open = resolve }) : null })
  await r.startEvil()
  r.world.alive = 0
  await r.step(0)
  r.advance(L.waveGapMs)
  hold = true
  const pending = r.c.hunt.tick()
  for (let i = 0; i < 20 && !open; i++) await settle()
  assert.ok(open, 'a summon is in flight')
  const count = r.summons()
  hold = false
  const off = r.c.handle('!reset', 'Viewer')
  await settle()
  open()
  await Promise.all([off, pending])
  await settle()
  assert.equal(r.summons(), count)
  assert.ok(r.sent.lastIndexOf('kill @e[tag=demo_evil]') > r.sent.findLastIndex(isSummon))
})

for (const word of ['!reset', '!chest', '!stop', '!1v1']) {
  test(`off: ${word} ends evil mode, removes the mobs and says so`, async () => {
    const spawnDuel = () => {
      const child = new EventEmitter()
      child.go = () => {}
      child.stop = () => {}
      setImmediate(() => child.emit('exit'))
      return child
    }
    const r = rig({ spawnDuel })
    await r.startEvil()
    const hunt = r.c.hunt
    await r.c.handle(word, 'Viewer')
    await settle()
    assert.equal(r.c.hunt, null)
    assert.equal(hunt.ended, true)
    assert.equal(r.world.alive, 0)
    assert.ok(r.sent.some(s => s.startsWith('tellraw Viewer') && /evil god is gone/i.test(s)))
  })
}

test('off: a plain task ends evil mode at once and then runs', async () => {
  const r = rig()
  await r.startEvil()
  const before = r.summons()
  await r.c.handle('get me some wood', 'Viewer')
  await settle()
  assert.equal(r.c.hunt, null)
  assert.equal(r.world.alive, 0)
  assert.deepEqual(r.tasks, ['get me some wood'])
  assert.ok(r.sent.some(s => s.startsWith('tellraw Viewer') && /evil god is gone/i.test(s)))
  r.advance(L.waveMaxMs * 3)
  for (const fn of [...r.timers.intervals.values()]) await fn()
  await settle()
  assert.equal(r.summons(), before)
})

test('off: a task typed before the evil job started means no evil at all', async () => {
  const r = rig()
  const on = r.c.handle('!evil', 'Viewer')
  const task = r.c.handle('get me some wood', 'Viewer')
  await Promise.all([on, task])
  await settle()
  assert.equal(r.summons(), 0)
  assert.equal(r.c.hunt, null)
  assert.equal(r.c.state, 'idle')
  assert.deepEqual(r.tasks, ['get me some wood'])
})

test('on twice: a second !evil says so and stacks nothing', async () => {
  const r = rig()
  await r.startEvil()
  const hunt = r.c.hunt
  const before = r.summons()
  await r.c.handle('!evil', 'Viewer')
  await settle()
  assert.equal(r.c.hunt, hunt)
  assert.equal(r.summons(), before)
  assert.ok(r.sent.some(s => s.startsWith('tellraw Viewer') && /already/i.test(s)))
})

test('on again: !evil works after a turn-off', async () => {
  const r = rig()
  await r.startEvil()
  await r.c.handle('!stop', 'Viewer')
  await r.startEvil()
  assert.equal(r.c.state, 'evil')
  assert.ok(r.c.hunt && !r.c.hunt.ended)
})

test('budget: the per-minute, per-hour and per-run caps all hold', () => {
  let now = 0
  const b = new CallBudget({ perMinute: 2, perHour: 3, perRun: 4 }, () => now)
  b.spend(); b.spend()
  assert.equal(b.open, false, 'minute cap')
  now += 60000
  assert.equal(b.open, true)
  b.spend()
  assert.equal(b.open, false, 'hour cap')
  now += 3600000
  assert.equal(b.open, true)
  b.spend()
  assert.equal(b.open, false, 'run cap')
  now += 3600000 * 24
  assert.equal(b.open, false, 'the run cap never refills')
})

test('budget: an always-on hunt stays inside the model budget and keeps spawning', async () => {
  const r = rig()
  await r.startEvil()
  let last = r.summons()
  for (let i = 0; i < 60; i++) {
    await r.nextWave()
    assert.ok(r.summons() > last, 'a wave still comes with the model capped')
    last = r.summons()
  }
  assert.ok(r.client.calls.length <= L.modelPerHour, `${r.client.calls.length} calls`)
})

test('budget: the caps carry across turning evil mode off and on', async () => {
  const r = rig()
  for (let i = 0; i < 12; i++) {
    await r.startEvil()
    await r.c.handle('!stop', 'Viewer')
  }
  assert.ok(r.client.calls.length <= L.modelPerMinute, `${r.client.calls.length} calls with the clock barely moving`)
})

test('death: the hunt survives it, waits out the grace period, then goes on', async () => {
  const r = rig()
  await r.startEvil()
  const hunt = r.c.hunt
  r.world.deaths = 1
  r.world.health = 0
  await r.step(0)
  assert.equal(r.c.hunt, hunt)
  assert.equal(r.c.state, 'evil')
  r.world.alive = 0
  const before = r.summons()
  await r.step(L.waveMaxMs)
  assert.equal(r.summons(), before, 'nothing spawns on a dead player')
  r.world.health = 20
  await r.step(0)
  assert.ok(r.sent.some(s => s.startsWith('effect give Viewer') && s.includes('resistance')))
  await r.step(L.graceMs - 1)
  assert.equal(r.summons(), before, 'nothing spawns during the grace period')
  await r.step(1)
  assert.ok(r.summons() > before, 'the next wave comes after the grace period')
})

test('every command a wave can send fits the game\'s command tree', () => {
  const plans = require('../evil_plan')
  const root = require('minecraft-data')('1.21.11').commands.root
  const names = new Set(root.children.map(c => c.name))
  const execute = root.children.find(c => c.name === 'execute')
  const positioned = execute.children.find(c => c.name === 'positioned')
  assert.ok(positioned.children.some(c => c.name === 'over'), 'execute positioned over exists')
  const lines = []
  for (const away of [false, true]) {
    for (const wall of Object.keys(plans.WALLS)) {
      for (const zombies of plans.SPLITS) {
        const out = plans.waveCommands(STAGE, { wall, approach: 'center', zombies }, { player: { x: 100, y: 64, z: 100 }, away, creeper: 1, zombies: L.maxZombies })
        lines.push(...out.creeper, ...out.zombies)
      }
    }
  }
  assert.ok(lines.length > 50)
  for (const l of lines) {
    assert.ok(names.has(l.split(' ')[0]), l)
    assert.ok(!/undefined|NaN/.test(l), l)
  }
})
