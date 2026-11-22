// The night attack on a fake world: fake console, timers, model and blocks. Nothing here reaches a server or an API.

const test = require('node:test')
const assert = require('node:assert/strict')
const scene = require('../scene')
const plans = require('../evil_plan')
const moat = require('../evil_moat')
const { EvilBrain, CallBudget } = require('../evil_brain')
const { EVIL_LIMITS } = require('../settings')
const { DemoController } = require('../controller')
const { parseDemoCommand, parseAgentWords, HELP_LINES } = require('../words')

const STAGE = { x: 10, y: -60, z: 20 }
const SETTINGS = { player: 'Viewer', agent: 'Agent1', dummy: 'Dummy', fighterName: 'Fighter', stage: STAGE, cueMobSeconds: 0, cueAfterMobMs: 0 }
const L = plans.layoutOf(STAGE)
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)) }
const ringOf = (x, z) => Math.max(Math.abs(x - L.x), Math.abs(z - L.z))

function makeWorld ({ walls = true } = {}) {
  const blocks = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const name = (x, y, z) => blocks.get(key(x, y, z)) ?? (y === L.y - 1 ? 'grass_block' : y < L.y - 1 ? 'dirt' : 'air')
  const set = (x, y, z, n) => blocks.set(key(x, y, z), n)
  if (walls) {
    for (let x = L.x - L.half; x <= L.x + L.half; x++) {
      for (let z = L.z - L.half; z <= L.z + L.half; z++) {
        if (ringOf(x, z) === L.half) for (let y = L.y; y < L.y + 3; y++) set(x, y, z, 'cobblestone')
      }
    }
  }
  const at = (x, y, z) => {
    const n = name(x, y, z)
    return { name: n, boundingBox: n === 'air' || n === 'water' ? 'empty' : 'block' }
  }
  // water from ring a to ring b, `deep` blocks down, on the cells `where` accepts
  const dig = (a, b, deep = 2, where = () => true) => {
    for (let x = L.x - b; x <= L.x + b; x++) {
      for (let z = L.z - b; z <= L.z + b; z++) {
        if (ringOf(x, z) < a || !where(x, z)) continue
        for (let d = 1; d <= deep; d++) set(x, L.y - d, z, 'water')
      }
    }
  }
  return { at, name, set, dig, blocks }
}

const blockAtOf = w => (x, y, z) => w.at(x, y, z)
const textReply = value => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }] })

function rig ({ world = makeWorld(), mobs = { zombie: 3, creeper: 1, enderman: 1, skeleton: 0 }, answer = null, gate = null } = {}) {
  const sent = []
  const logs = []
  const tasks = []
  let intervals = 0
  const tagged = { zombie: 0, creeper: 0, enderman: 0, skeleton: 0 }
  let clock = 1000
  let id = 0
  const timers = {
    setInterval: () => { intervals++; return ++id },
    clearInterval: () => {},
    setTimeout: () => ++id,
    clearTimeout: () => {},
    now: () => clock
  }
  const typeIn = c => c.match(/type=minecraft:([a-z_]+)/)?.[1]
  const rcon = {
    send: async c => {
      sent.push(c)
      if (gate) await gate(c)
      let m = c.match(/^tag @e\[(.*)\] add demo_evil$/)
      if (m) {
        const t = typeIn(c)
        const limit = Number(m[1].match(/limit=(\d+)/)?.[1] ?? 99)
        const add = Math.min(limit, mobs[t] - tagged[t])
        tagged[t] += add
        return `Added tag to ${add} entities`
      }
      m = c.match(/summon minecraft:(zombie|creeper|enderman|skeleton)/)
      if (m) {
        mobs[m[1]]++
        tagged[m[1]]++
        return 'Summoned'
      }
      if (c.includes('{ignited:1b}')) { // the blast opens the wall where the creeper was put
        const p = world.lastCreeper
        if (p) {
          for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
              for (let y = L.y; y < L.y + 3; y++) if (world.name(p.x + dx, y, p.z + dz) === 'cobblestone') world.set(p.x + dx, y, p.z + dz, 'air')
            }
          }
          if (world.crater) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) world.set(p.x + dx, L.y - 1, p.z + dz, 'air')
        }
        mobs.creeper = 0
        tagged.creeper = 0
        return 'Modified'
      }
      m = c.match(/^tp @e\[tag=demo_evil_creeper,limit=1\] (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)$/)
      if (m) world.lastCreeper = { x: Math.floor(Number(m[1])), z: Math.floor(Number(m[3])) }
      m = c.match(/^execute if block (-?\d+) (-?\d+) (-?\d+) minecraft:([a-z_]+) run setblock (-?\d+) (-?\d+) (-?\d+) (?:minecraft:)?([a-z_]+)$/)
      if (m) {
        if (world.name(+m[1], +m[2], +m[3]) !== m[4]) return ''
        world.set(+m[5], +m[6], +m[7], m[8])
        return 'Changed the block'
      }
      m = c.match(/^execute if block (-?\d+) (-?\d+) (-?\d+) minecraft:([a-z_]+)$/)
      if (m) return world.name(+m[1], +m[2], +m[3]) === m[4] ? 'Test passed' : 'Test failed'
      m = c.match(/^execute if entity @e\[tag=demo_evil,type=minecraft:([a-z_]+)\]$/)
      if (m) return tagged[m[1]] ? `Test passed, count: ${tagged[m[1]]}` : 'Test failed'
      if (c.startsWith('execute if entity @e[tag=demo_evil_creeper')) return tagged.creeper ? 'Test passed, count: 1' : 'Test failed'
      if (c.startsWith('execute if entity')) return 'Test failed'
      if (c === `kill @e[tag=${scene.TAG_EVIL}]`) { for (const k of Object.keys(tagged)) { mobs[k] -= tagged[k]; tagged[k] = 0 } return 'Killed' }
      if (c.startsWith('director status')) return 'Unknown command'
      if (c.startsWith('scoreboard players get')) return 'Viewer has 0 [demo_deaths]'
      if (c === 'data get entity Viewer Pos') return `Viewer has the following entity data: [${L.x - 1.5}d, ${L.y}d, ${L.z + 0.5}d]`
      if (c === 'data get entity Viewer Health') return 'Viewer has the following entity data: 20.0f'
      return ''
    }
  }
  const client = { calls: [], messages: { create: async p => { client.calls.push(p); return answer ? answer(p) : textReply({ side: 'nope' }) } } }
  const brain = new EvilBrain(answer ? { client, credentials: { key: 'sk-test-secret' }, timers } : { credentials: null, timers })
  const bot = { entity: { position: { x: L.x, y: L.y, z: L.z } }, health: 20, blockAt: v => world.at(v.x, v.y, v.z) }
  const agents = { agentBot: () => bot, stopAgent: async () => {}, runTask: async t => { tasks.push(t) }, holdAtBase: () => {} }
  const c = new DemoController({ settings: SETTINGS, rcon, agents, spawnDuel: () => null, sleep: async () => {}, timers, brain, hostile: ['spider'], log: l => logs.push(l) })
  c.log = l => logs.push(l)
  return { c, sent, logs, tasks, world, mobs, tagged, client, intervals: () => intervals, advance: ms => { clock += ms } }
}

const runSiege = async r => {
  await r.c.handle('!evil', 'Viewer')
  await r.c.siege?.done
  await settle()
}
const firstIndex = (sent, test) => sent.findIndex(test)
const lastIndex = (sent, test) => { for (let i = sent.length - 1; i >= 0; i--) if (test(sent[i])) return i; return -1 }
const places = sent => sent.filter(c => /^execute if block .* minecraft:(water|air) run setblock /.test(c))
const takes = sent => sent.filter(c => /^execute if block .* minecraft:(dirt|grass_block|sand|gravel) run setblock -?\d+ -?\d+ -?\d+ (minecraft:)?air$/.test(c))

test('a real moat is detected', () => {
  const w = makeWorld()
  w.dig(8, 9)
  assert.equal(moat.readMoat({ blockAt: blockAtOf(w), layout: L }).verdict, 'stops')
})

test('shallow water is not a moat', () => {
  const w = makeWorld()
  w.dig(8, 9, 1)
  assert.equal(moat.readMoat({ blockAt: blockAtOf(w), layout: L }).verdict, 'shallow')
})

test('a moat with a land crossing is not a moat', () => {
  const w = makeWorld()
  w.dig(8, 9, 2, (x, z) => !(z === L.z && x > L.x))
  assert.equal(moat.readMoat({ blockAt: blockAtOf(w), layout: L }).verdict, 'none')
})

test('unread ground never counts as a moat', () => {
  assert.equal(moat.readMoat({ blockAt: () => null, layout: L }).verdict, 'unknown')
})

test('the shortest crossing is chosen', () => {
  const w = makeWorld()
  w.dig(8, 9)
  w.dig(10, 11, 2, (x, z) => Math.abs(x - L.x) > Math.abs(z - L.z) && x > L.x) // the east side is twice as wide
  const sides = moat.scoreSides({ blockAt: blockAtOf(w), layout: L, goal: { x: L.x - 2, y: L.y, z: L.z } })
  assert.notEqual(sides[0].side, 'east')
  assert.equal(sides[0].blocks.length, 2)
  assert.equal(sides.find(s => s.side === 'east')?.blocks.length ?? 4, 4)
})

test('the attack side is the one away from water', () => {
  const w = makeWorld()
  w.dig(7, 12, 2, (x, z) => x > L.x + 3 && Math.abs(z - L.z) < 8) // a pond off the east wall
  const sides = moat.scoreSides({ blockAt: blockAtOf(w), layout: L, goal: { x: L.x - 2, y: L.y, z: L.z } })
  assert.notEqual(sides[0].side, 'east')
  assert.equal(sides[0].water, 0)
  assert.ok(!moat.menuSides(sides).some(s => s.side === 'east'))
})

test('rough ground past the cleared strip still leaves a way in', () => {
  const w = makeWorld()
  for (let x = L.x - 20; x <= L.x + 20; x++) {
    for (let z = L.z - 20; z <= L.z + 20; z++) if (ringOf(x, z) >= 8) w.set(x, L.y, z, 'stone')
  }
  const sides = moat.scoreSides({ blockAt: blockAtOf(w), layout: L, goal: { x: L.x - 2, y: L.y, z: L.z } })
  assert.equal(sides.length, 3)
  assert.equal(sides[0].blocks.length, 0)
})

test('a crossing over the cap is not offered', () => {
  const w = makeWorld()
  w.dig(6, 16)
  assert.deepEqual(moat.scoreSides({ blockAt: blockAtOf(w), layout: L, goal: { x: L.x - 2, y: L.y, z: L.z }, maxBlocks: 3 }), [])
})

test('ground beside water, under the path or in the base is never taken', () => {
  const w = makeWorld()
  w.dig(8, 9)
  const [side] = moat.scoreSides({ blockAt: blockAtOf(w), layout: L, goal: { x: L.x - 2, y: L.y, z: L.z } })
  const picks = moat.groundSources(blockAtOf(w), L, side, 4)
  assert.equal(picks.length, 4)
  for (const s of picks) {
    assert.ok(ringOf(s.x, s.z) > 10, 'clear of the shore')
    assert.ok(!side.route.some(r => r.x === s.x && r.z === s.z), 'off the path')
    assert.ok(moat.HOLDABLE.includes(s.name))
  }
})

test('!moat and !agent are commands and in the help', () => {
  assert.deepEqual(parseDemoCommand('!moat'), { name: 'moat' })
  assert.deepEqual(parseDemoCommand('!agent'), { name: 'agent' })
  for (const word of ['!moat', '!agent']) assert.ok(HELP_LINES.some(l => l.includes(word)), word)
  assert.ok(parseAgentWords('spawn the agent'))
  assert.ok(parseAgentWords('bring the agent back'))
  assert.equal(parseAgentWords('make me an iron pickaxe'), null)
  assert.equal(parseAgentWords('get the agent an iron pickaxe'), null)
})

test('the moat keeps the door side land and reset takes it out', () => {
  const dig = scene.moatCommands(STAGE)
  assert.ok(dig.some(c => / water$/.test(c)))
  assert.ok(dig.some(c => c.includes(scene.TAG_MOAT)))
  assert.ok(scene.MOAT_IN > L.half + 2, 'land is left outside the door')
  const reset = scene.resetCommands(SETTINGS, STAGE)
  const clear = scene.moatClearCommands(STAGE)
  for (const c of clear) assert.ok(reset.includes(c), c)
  assert.ok(reset.indexOf(clear[0]) < reset.findIndex(c => c.includes('cobblestone')))
})

test('the moat as dug really stops walkers, leaves the door its land, and comes out clean', () => {
  const w = makeWorld()
  const apply = c => {
    const m = c.replace(/^execute if entity @e\[tag=demo_moat\] run /, '').match(/^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) ([a-z_]+)( replace air)?$/)
    if (!m) return
    const [a, b, d, e, f, g] = m.slice(1, 7).map(Number)
    for (let x = a; x <= e - 0 && x <= e; x++) {
      for (let y = b; y <= f; y++) {
        for (let z = d; z <= g; z++) if (!m[8] || w.name(x, y, z) === 'air') w.set(x, y, z, m[7])
      }
    }
  }
  scene.moatCommands(STAGE).forEach(apply)
  assert.equal(moat.readMoat({ blockAt: blockAtOf(w), layout: L }).verdict, 'stops')
  const door = scene.baseLayout(STAGE).door.outside
  assert.equal(w.name(door.x, door.y, door.z), 'air')
  assert.equal(w.name(door.x, door.y - 1, door.z), 'grass_block')
  assert.equal(w.name(door.x, door.y, door.z + 1), 'air')
  scene.moatClearCommands(STAGE).forEach(apply)
  assert.equal(moat.readMoat({ blockAt: blockAtOf(w), layout: L }).verdict, 'none')
  assert.ok(![...w.blocks.values()].includes('water'))
})

test('!evil makes it night, uses the mobs already there, and adds no waves', async () => {
  const r = rig()
  await runSiege(r)
  assert.ok(r.sent.some(c => c === 'time set midnight'))
  assert.equal(r.sent.filter(c => /summon minecraft:(zombie|creeper|enderman)/.test(c)).length, 0)
  assert.ok(r.sent.some(c => /^tag @e\[type=minecraft:zombie.* add demo_evil$/.test(c)))
  assert.ok(!('hunt' in r.c), 'there is no repeating loop to hold')
  assert.equal(r.intervals(), 0, 'nothing is scheduled to come back')
  const before = r.sent.length
  r.advance(600000)
  await settle()
  assert.equal(r.sent.length, before, 'nothing repeats afterwards')
})

test('only a missing role is summoned, and the log says so', async () => {
  const r = rig({ mobs: { zombie: 1, creeper: 0, enderman: 1, skeleton: 0 } })
  await runSiege(r)
  const made = r.sent.filter(c => /summon minecraft:(zombie|creeper|enderman)/.test(c))
  assert.equal(made.filter(c => c.includes('minecraft:zombie')).length, 2)
  assert.equal(made.filter(c => c.includes('minecraft:creeper')).length, 1)
  assert.equal(made.filter(c => c.includes('minecraft:enderman')).length, 0)
  assert.ok(r.logs.some(l => /summoned/i.test(l) && /zombie/.test(l)))
  for (const c of made) assert.ok(c.includes('positioned over'), 'lands on the ground out of sight')
})

test('creeper first, then the enderman moves real blocks, then the zombies cross', async () => {
  const world = makeWorld()
  world.dig(8, 9)
  const r = rig({ world })
  await runSiege(r)
  const blast = firstIndex(r.sent, c => c.includes('{ignited:1b}'))
  const placed = places(r.sent)
  const taken = takes(r.sent)
  assert.ok(blast >= 0)
  assert.ok(placed.length >= 2)
  assert.equal(taken.length, placed.length)
  for (let i = 0; i < placed.length; i++) {
    const t = r.sent.indexOf(taken[i])
    const p = r.sent.indexOf(placed[i])
    assert.ok(blast < t && t < p, `block ${i} is taken before it is placed`)
    const name = taken[i].match(/minecraft:(dirt|grass_block|sand|gravel) run/)[1]
    assert.ok(placed[i].endsWith(`minecraft:${name}`), 'the block placed is the block taken')
    assert.ok(r.sent.slice(t, p).some(c => c.includes(`carriedBlockState set value {Name:"minecraft:${name}"}`)), 'shown in its hands')
    const [tx, ty, tz] = placed[i].match(/^execute if block (-?\d+) (-?\d+) (-?\d+)/).slice(1).map(Number)
    const stood = r.sent.slice(t, p).filter(c => c.startsWith('tp @e[tag=demo_evil_bridge')).pop().split(' ').slice(2).map(Number)
    assert.equal(Math.abs(Math.floor(stood[0]) - tx) + Math.abs(Math.floor(stood[2]) - tz), 1, 'it stands right at the edge')
    assert.equal(stood[1], ty + 1, 'on top of the ground, not in the water')
    assert.notEqual(world.name(Math.floor(stood[0]), ty, Math.floor(stood[2])), 'water', 'never over water')
  }
  const lastPlace = lastIndex(r.sent, c => places([c]).length > 0)
  const release = firstIndex(r.sent, c => c.includes('{NoAI:0b}') && c.includes('zombie'))
  const firstMarch = firstIndex(r.sent, c => /^tp @e\[tag=demo_walker_/.test(c))
  assert.ok(lastPlace < firstMarch && firstMarch < release, 'zombies wait until the path is finished')
  assert.ok(r.logs.some(l => /evil path/.test(l)))
})

test('a crater left by the blast is filled too', async () => {
  const world = makeWorld()
  world.crater = true
  const r = rig({ world })
  await runSiege(r)
  assert.ok(places(r.sent).length >= 1)
  assert.ok(r.sent.some(c => /^tp @e\[tag=demo_walker_/.test(c)))
})

test('a wall that survives the blast means no march', async () => {
  const world = makeWorld()
  const r = rig({ world })
  const set = world.set
  world.set = (x, y, z, n) => { if (n !== 'air' || world.name(x, y, z) !== 'cobblestone') set(x, y, z, n) }
  await runSiege(r)
  assert.equal(r.sent.filter(c => /^tp @e\[tag=demo_walker_/.test(c)).length, 0)
  assert.ok(r.sent.some(c => c.includes('{NoAI:0b}') && c.includes('zombie')), 'the zombies are let go anyway')
  assert.ok(r.logs.some(l => /no route/.test(l)))
})

test('turning evil off stops the build with no late block or mob', async () => {
  const world = makeWorld()
  world.dig(8, 9)
  let hold = null
  let reached = null
  const reachedIt = new Promise(resolve => { reached = resolve })
  const gate = c => {
    if (!hold && /carriedBlockState set value/.test(c)) {
      reached()
      return new Promise(resolve => { hold = resolve })
    }
  }
  const r = rig({ world, gate })
  const on = r.c.handle('!evil', 'Viewer')
  await reachedIt
  const off = r.c.handle('!stop', 'Viewer')
  await settle()
  const mark = r.sent.length
  hold()
  await on
  await off
  await r.c.siege?.done
  await settle()
  const late = r.sent.slice(mark)
  assert.deepEqual(late.filter(c => /setblock|summon|carriedBlockState|tp @e\[tag=demo_walker/.test(c)), [])
  assert.ok(r.sent.includes(`kill @e[tag=${scene.TAG_EVIL}]`))
  assert.equal(r.c.evilOn, false)
  const taken = takes(r.sent)[0].match(/^execute if block (-?\d+) (-?\d+) (-?\d+) minecraft:([a-z_]+)/)
  assert.equal(world.name(+taken[1], +taken[2], +taken[3]), 'air', 'the block was in its hands')
  await r.c.handle('!reset', 'Viewer')
  assert.equal(world.name(+taken[1], +taken[2], +taken[3]), taken[4], 'a reset gives it back')
})

test('a failed place puts the block back and never hangs', async () => {
  const world = makeWorld()
  world.dig(8, 9)
  const r = rig({ world, gate: c => {
    const m = c.match(/^execute if block (-?\d+) (-?\d+) (-?\d+) minecraft:water run setblock/)
    if (m) world.set(+m[1], +m[2], +m[3], 'cobblestone') // someone blocked the spot
  } })
  await runSiege(r)
  const taken = takes(r.sent)[0].match(/^execute if block (-?\d+) (-?\d+) (-?\d+) minecraft:([a-z_]+)/)
  assert.equal(world.name(+taken[1], +taken[2], +taken[3]), taken[4], 'the block went back')
  assert.equal(r.sent.filter(c => /^tp @e\[tag=demo_walker_/.test(c)).length, 0)
  assert.ok(r.sent.some(c => c.includes('{NoAI:0b}') && c.includes('zombie')))
})

test('a reset takes the bridge out and gives the ground back', async () => {
  const world = makeWorld()
  world.dig(8, 9)
  const r = rig({ world })
  await runSiege(r)
  const placed = places(r.sent).map(c => c.match(/^execute if block (-?\d+) (-?\d+) (-?\d+)/).slice(1).map(Number))
  const taken = takes(r.sent).map(c => c.match(/^execute if block (-?\d+) (-?\d+) (-?\d+) minecraft:([a-z_]+)/).slice(1))
  await r.c.handle('!reset', 'Viewer')
  for (const [x, y, z] of placed) assert.equal(world.name(x, y, z), 'water')
  for (const [x, y, z, n] of taken) assert.equal(world.name(+x, +y, +z), n)
})

test('the model picks a checked side, and a bad pick means the code\'s side', async () => {
  const pick = rig({ answer: () => textReply({ side: 'west', approach: 'center', line: 'Your west wall is mine.' }) })
  await runSiege(pick)
  assert.equal(pick.client.calls.length, 1)
  assert.equal(pick.c.raid.plan.wall, 'west')
  const off = rig({ answer: () => textReply({ side: 'south', approach: 'center', line: 'Door.' }) })
  await runSiege(off)
  assert.equal(off.client.calls.length, 1)
  assert.ok(['north', 'east', 'west'].includes(off.c.raid.plan.wall))
  assert.ok(off.sent.some(c => c.includes('{ignited:1b}')), 'the attack still happens')
})

test('the agent is gone during evil and comes back when asked or when evil ends', async () => {
  const r = rig()
  await runSiege(r)
  assert.ok(r.sent.includes('gamemode spectator Agent1'))
  assert.equal(r.c.agentAway, true)
  const count = r.sent.filter(c => c === 'gamemode survival Agent1').length
  await r.c.handle('spawn the agent', 'Viewer')
  assert.equal(r.c.evilOn, true, 'asking for the agent does not end evil')
  assert.equal(r.c.agentAway, false)
  assert.equal(r.sent.filter(c => c === 'gamemode survival Agent1').length, count + 1)
  const again = rig()
  await runSiege(again)
  await again.c.handle('!stop', 'Viewer')
  assert.equal(again.c.agentAway, false)
  assert.ok(again.sent.includes('gamemode survival Agent1'))
})

const mobCommands = sent => sent.filter(c => /summon minecraft:(zombie|creeper|enderman)|^tag @e\[type=|ignited:1b/.test(c))

test('nothing a player or the model reads talks about waves', () => {
  assert.ok(!HELP_LINES.some(l => /wave/i.test(l)))
  for (const file of ['evil_brain.js', 'words.js', 'settings.js', 'evil_siege.js', 'evil_raid.js', 'evil_plan.js', 'controller.js']) {
    assert.ok(!/wave/i.test(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', file), 'utf8')), file)
  }
})

test('the door wall is never attacked, even when every other side is wet', () => {
  const w = makeWorld()
  w.dig(6, 9, 2, (x, z) => z <= L.z + 3)
  const sides = moat.scoreSides({ blockAt: blockAtOf(w), layout: L, goal: { x: L.x - 2, y: L.y, z: L.z } })
  assert.ok(sides.length > 0)
  assert.ok(!sides.some(s => s.side === 'south'))
})

test('zombies under his command keep the wooden axe and iron helmet, and drop neither', async () => {
  const r = rig({ mobs: { zombie: 1, creeper: 1, enderman: 1, skeleton: 0 } })
  await runSiege(r)
  assert.ok(r.sent.some(c => c.includes('run item replace entity @s weapon.mainhand with minecraft:wooden_axe')))
  assert.ok(r.sent.some(c => c.includes('run item replace entity @s armor.head with minecraft:iron_helmet')))
  assert.ok(r.sent.some(c => c.includes('{drop_chances:{mainhand:0.0f,head:0.0f}}')))
  for (const c of r.sent.filter(l => /summon minecraft:zombie/.test(l))) {
    assert.ok(c.includes('minecraft:wooden_axe') && c.includes('minecraft:iron_helmet'), 'a summoned one too')
  }
})

test('off: a model reply that lands after the turn-off moves nothing', async () => {
  let release
  const r = rig({ answer: () => new Promise(resolve => { release = resolve }) })
  await r.c.handle('!evil', 'Viewer')
  const done = r.c.siege.done
  for (let i = 0; i < 20 && !release; i++) await settle()
  assert.ok(release, 'the attack is waiting on the model')
  const before = mobCommands(r.sent).length
  await r.c.handle('!stop', 'Viewer')
  assert.equal(r.c.state, 'idle')
  release(textReply({ side: 'west', approach: 'center', line: 'Too late.' }))
  await done
  await settle()
  assert.equal(mobCommands(r.sent).length, before)
  assert.ok(!r.sent.some(c => c.includes('Too late')))
})

test('off: a plain task ends evil at once and then runs', async () => {
  const r = rig()
  await runSiege(r)
  await r.c.handle('get me some wood', 'Viewer')
  await settle()
  assert.equal(r.c.siege, null)
  assert.equal(r.c.evilOn, false)
  assert.deepEqual(r.tasks, ['get me some wood'])
  assert.ok(r.sent.some(c => c.startsWith('tellraw Viewer') && /evil god is gone/i.test(c)))
  const before = mobCommands(r.sent).length
  r.advance(600000)
  await settle()
  assert.equal(mobCommands(r.sent).length, before)
})

test('off: a task typed before the evil job started means no evil at all', async () => {
  const r = rig()
  const on = r.c.handle('!evil', 'Viewer')
  const task = r.c.handle('get me some wood', 'Viewer')
  await Promise.all([on, task])
  await settle()
  assert.equal(mobCommands(r.sent).length, 0)
  assert.equal(r.c.siege, null)
  assert.equal(r.c.state, 'idle')
  assert.deepEqual(r.tasks, ['get me some wood'])
})

test('on twice: a second !evil says so and stacks nothing', async () => {
  const r = rig()
  await runSiege(r)
  const siege = r.c.siege
  const before = mobCommands(r.sent).length
  await r.c.handle('!evil', 'Viewer')
  await settle()
  assert.equal(r.c.siege, siege)
  assert.equal(mobCommands(r.sent).length, before)
  assert.ok(r.sent.some(c => c.startsWith('tellraw Viewer') && /already/i.test(c)))
})

test('on again: !evil runs a whole new attack after a turn-off', async () => {
  const r = rig()
  await runSiege(r)
  await r.c.handle('!stop', 'Viewer')
  await runSiege(r)
  assert.equal(r.c.state, 'evil')
  assert.equal(r.sent.filter(c => c.includes('{ignited:1b}')).length, 2)
})

test('off: a turn-off while the agent is leaving never strands it in the sky', async () => {
  let hold = null
  let reached = null
  const reachedIt = new Promise(resolve => { reached = resolve })
  const r = rig({ gate: c => {
    if (!hold && c === 'gamemode spectator Agent1') {
      reached()
      return new Promise(resolve => { hold = resolve })
    }
  } })
  const on = r.c.handle('!evil', 'Viewer')
  await reachedIt
  const off = r.c.handle('!stop', 'Viewer')
  await settle()
  hold()
  await on
  await off
  await settle()
  const home = scene.agentHomeCommand('Agent1', STAGE)
  const lastTp = r.sent.filter(c => c.startsWith('tp Agent1 ')).pop()
  assert.equal(lastTp, home)
  assert.equal(r.c.agentAway, false)
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

test('budget: the caps carry across turning evil off and on, and the attack still comes', async () => {
  const r = rig({ answer: () => textReply({ side: 'west', approach: 'center', line: 'Again.' }) })
  for (let i = 0; i < 12; i++) {
    await runSiege(r)
    await r.c.handle('!stop', 'Viewer')
  }
  assert.ok(r.client.calls.length <= EVIL_LIMITS.modelPerMinute, `${r.client.calls.length} calls with the clock barely moving`)
  assert.equal(r.sent.filter(c => c.includes('{ignited:1b}')).length, 12)
})

// The same walk through the game's command tree the other demo tests make
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

test('every command the night attack can send fits the game\'s command tree', async () => {
  const root = require('minecraft-data')('1.21.11').commands.root
  const world = makeWorld()
  world.dig(8, 9)
  const r = rig({ world, mobs: { zombie: 1, creeper: 0, enderman: 0, skeleton: 1 } })
  await runSiege(r)
  await r.c.handle('!agent', 'Viewer')
  await r.c.handle('!stop', 'Viewer')
  await r.c.handle('!moat', 'Viewer')
  await r.c.handle('!reset', 'Viewer')
  const lines = [...new Set(r.sent.filter(c => !c.startsWith('gamerule') && !c.startsWith('tellraw') && !c.startsWith('director')))]
  const bad = lines.filter(l => !walks(root, root, splitCommand(l), 0))
  assert.deepEqual(bad, [])
  assert.ok(lines.length > 40, `only ${lines.length} lines checked`)
})

