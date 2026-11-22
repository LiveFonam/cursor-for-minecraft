// The scenes of live_scenes.js on a fake server: what each one sets up, what passes, and above all what must not pass.
// The real server is in livetest.js.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { parseMessage } = require('../commands')
const { TESTS, ORDER, IRON_BENCH_SCENES } = require('../livetest')
const {
  analyzeFight, healthSummary, fightVerdict, parseAlive, throwAngle, parseMotion, facingVerdict, torchVerdict, arena, mobSpots, ledgerCount, installHaikuBudget,
  FIGHTS, FIGHT_KIT, FIGHT_ARMOR, CRAFT_BAGS, CHAT_SCRIPT, CHAT_CALLS, HAIKU_CAP, TAG
} = require('../live_scenes')

const SPOT = new Vec3(0, 64, 0)
const bump = (w, cat, key, n = 1) => {
  const c = (w.stats[`minecraft:${cat}`] ||= {})
  c[`minecraft:${key}`] = (c[`minecraft:${key}`] || 0) + n
}

function fakeWorld () {
  const w = {
    bags: { Agent1: {}, AgentTester: {} },
    positions: { Agent1: [2.5, 64, -1.5], AgentTester: [0.5, 64, 0.5] },
    stats: {},
    sent: [],
    alive: 0,
    health: 20,
    food: 20,
    drainTo: null,
    checks: 0,
    lowY: null,
    script: null,
    onChat: null,
    afterDrain: null,
    motions: {},
    items: 0,
    noServerMotion: false,
    noPacketMotion: false,
    worn: {},
    armorRefused: false
  }
  w.rcon = {
    send: async c => {
      w.sent.push(c)
      let m
      if ((m = c.match(/^clear (\w+) minecraft:(\w+) 0$/))) {
        const n = w.bags[m[1]][m[2]] || 0
        return n ? `Found ${n} matching items on player ${m[1]}` : `No items were found on player ${m[1]}`
      }
      if ((m = c.match(/^clear (\w+)$/))) { w.bags[m[1]] = {}; return 'Removed' }
      if ((m = c.match(/^give (\w+) minecraft:(\w+) (\d+)$/))) { w.bags[m[1]][m[2]] = (w.bags[m[1]][m[2]] || 0) + Number(m[3]); return 'Gave' }
      if ((m = c.match(/^item replace entity Agent1 (armor\.\w+) with minecraft:(\w+)$/))) { if (!w.armorRefused) w.worn[m[1]] = m[2]; return 'Replaced' }
      if ((m = c.match(/^execute if items entity Agent1 (armor\.\w+) minecraft:(\w+)$/))) return w.worn[m[1]] === m[2] ? 'Test passed, count: 1' : 'Test failed'
      if (/^summon minecraft:(zombie|skeleton|creeper|enderman) /.test(c)) { w.alive++; return 'Summoned' }
      if (c === `execute if entity @e[tag=${TAG}]`) {
        w.checks++
        if (w.checks === 2 && w.script) { const run = w.script; w.script = null; await run() }
        return w.alive ? `Test passed, count: ${w.alive}` : 'Test failed'
      }
      if ((m = c.match(/^data get entity (\w+) Pos$/))) {
        const p = w.positions[m[1]]
        const y = m[1] === 'Agent1' && w.lowY !== null ? w.lowY : p[1]
        return `${m[1]} has the following entity data: [${p[0]}d, ${y}d, ${p[2]}d]`
      }
      if ((m = c.match(/^data get entity (item-\d+) Motion$/))) {
        const v = w.motions[m[1]]
        return v ? `Item has the following entity data: [${v.x}d, ${v.y}d, ${v.z}d]` : 'No entity was found'
      }
      if (/ Health$/.test(c)) return `Agent1 has the following entity data: ${w.health}f`
      if (/ foodLevel$/.test(c)) return `Agent1 has the following entity data: ${w.food}`
      if (/^effect give Agent1 minecraft:hunger/.test(c)) { if (w.drainTo !== null) w.food = w.drainTo; return 'Applied' }
      if (/^effect clear Agent1 minecraft:hunger/.test(c)) { if (w.afterDrain) { const run = w.afterDrain; w.afterDrain = null; run() } return 'Removed' }
      if ((m = c.match(/^tp (Agent1|AgentTester) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/))) {
        w.positions[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])]
        w.syncEntities?.()
        return 'Teleported'
      }
      return ''
    }
  }
  const tester = new EventEmitter()
  tester.players = { Agent1: { entity: { position: new Vec3(...w.positions.Agent1) } } }
  tester.entity = { position: new Vec3(...w.positions.AgentTester) }
  tester.creative = { startFlying () {} }
  tester.world = { getColumnAt: () => ({}) }
  tester.chat = text => { w.sent.push(`chat ${text}`); if (w.onChat) w.onChat(text) }
  w.syncEntities = () => {
    tester.players.Agent1.entity.position = new Vec3(...w.positions.Agent1)
    tester.entity.position = new Vec3(...w.positions.AgentTester)
  }
  w.tester = tester
  // a dropped item, thrown toward the owner or the other way
  w.toss = (toward = true) => {
    const bot = tester.players.Agent1.entity.position
    const owner = tester.entity.position
    const len = Math.hypot(owner.x - bot.x, owner.z - bot.z) || 1
    const sign = toward ? 1 : -1
    const motion = { x: sign * 0.3 * (owner.x - bot.x) / len, y: 0.1, z: sign * 0.3 * (owner.z - bot.z) / len }
    const uuid = `item-${++w.items}`
    if (!w.noServerMotion) w.motions[uuid] = motion
    const velocity = w.noPacketMotion ? new Vec3(0, 0, 0) : new Vec3(motion.x, motion.y, motion.z)
    tester.emit('entitySpawn', { name: 'item', uuid, position: new Vec3(bot.x, bot.y + 1, bot.z), velocity })
  }
  return w
}

function session (name, w, extra = {}) {
  const lines = []
  const s = {
    name,
    def: TESTS[name],
    spot: SPOT,
    botStart: new Vec3(2, 64, -2),
    chat: [],
    rcon: w.rcon,
    tester: w.tester,
    settleMs: 0,
    pollMs: 1,
    capMs: 150,
    drainMs: 30,
    pickupMs: 40,
    tossWatchMs: 4,
    replyMs: 60,
    orderMs: 60,
    readStats: async () => JSON.parse(JSON.stringify(w.stats)),
    metrics: {
      lines,
      mark: () => lines.length,
      since: i => lines.slice(i),
      waitJob: async (_s, bot, job, ms, since) => {
        const until = Date.now() + Math.min(ms, 120)
        while (Date.now() < until) {
          const hit = lines.slice(since).find(l => l.bot === bot && l.job === job)
          if (hit) return hit
          await new Promise(resolve => setTimeout(resolve, 1))
        }
        return null
      }
    },
    agents: { ctxs: new Map([['Agent1', { manager: { hooks: {} } }]]) },
    ...extra
  }
  for (const [item, n] of s.def.kit) w.bags.Agent1[item] = n
  s.mode = (from, to) => s.agents.ctxs.get('Agent1').manager.hooks.modeChanged({ name: from }, { name: to })
  s.brain = text => console.error('[agents 00:00:00]', `Agent1 mob fighter: ${text}`)
  return s
}

const botSays = (s, text) => s.chat.push({ at: Date.now(), text: `<Agent1> ${text}` })

// ---------- the table of scenes ----------

const NEW_SCENES = [...Object.keys(FIGHTS), 'craft_every', 'handover_facing', 'food_ready_first', 'food_cook', 'food_early', 'food_mission', 'chat_english']

test('every new scene runs by name, stays out of the default order, and starts on the levelled bench', () => {
  for (const n of NEW_SCENES) {
    assert.equal(typeof TESTS[n]?.run, 'function', n)
    assert.equal(ORDER.includes(n), false, n)
    assert.equal(TESTS[n].flatten, true, n)
  }
})

test('only the chat scene turns the paid translator on', () => {
  for (const n of NEW_SCENES) assert.equal(!!TESTS[n].translator, n === 'chat_english', n)
  for (const n of Object.keys(IRON_BENCH_SCENES)) assert.equal(TESTS[n].translator, false, n)
})

test('the scenes start with exactly the stated kit', () => {
  for (const n of Object.keys(FIGHTS)) assert.deepEqual(TESTS[n].kit, FIGHT_KIT, n)
  assert.deepEqual(FIGHT_KIT.map(x => x[0]), ['diamond_axe', 'shield'])
  assert.deepEqual(TESTS.craft_every.kit, [])
  assert.deepEqual(TESTS.food_mission.kit, [])
  assert.deepEqual(TESTS.food_cook.kit, [['beef', 4], ['coal', 4]])
  assert.deepEqual(TESTS.food_early.kit, [['bread', 4]])
})

test('the fights cover each mob alone, groups of 2 to 4, a cave, water and a ledge', () => {
  for (const k of ['zombie', 'skeleton', 'creeper', 'enderman']) assert.deepEqual(FIGHTS[`net_${k}`].mobs, [k])
  for (const n of [2, 3, 4]) assert.equal(FIGHTS[`net_group${n}`].mobs.length, n)
  assert.deepEqual(['net_cave', 'net_water', 'net_ledge'].map(n => FIGHTS[n].arena), ['cave', 'water', 'ledge'])
})

test('every craft target has a bag', () => {
  const { TARGETS } = require('../skills/crafter_plan')
  assert.deepEqual(Object.keys(CRAFT_BAGS).sort(), [...TARGETS].sort())
})

test('each chat line reaches the translator, none is caught by the local parsers', () => {
  assert.equal(Object.keys(CHAT_SCRIPT).length, CHAT_CALLS)
  for (const line of Object.values(CHAT_SCRIPT)) assert.equal(parseMessage(line, ['Agent1']).type, 'translate', line)
})

test('a clean queue stays inside the Haiku limit, both rounds of both chat scenes', () => {
  assert.ok(2 * (CHAT_CALLS + 1) <= HAIKU_CAP)
})

// ---------- reading the logs ----------

test('a fight with no change of side has no flips', () => {
  const r = analyzeFight([{ t: 0, kind: 'brain', brain: 'trained network' }, { t: 0, kind: 'mode', from: 'idle', to: 'mobfight' }, { t: 20000, kind: 'mode', from: 'mobfight', to: 'idle' }])
  assert.equal(r.fought_by, 'network')
  assert.equal(r.flips, 0)
  assert.equal(r.rapid_flips, 0)
  assert.equal(r.mode_changes, 2)
})

test('flips count changes of side, and a meal in between does not hide one', () => {
  const ev = (t, to) => ({ t, kind: 'mode', to })
  const r = analyzeFight([ev(0, 'mobfight'), ev(7000, 'eat'), ev(8000, 'retreat'), ev(15000, 'mobfight')])
  assert.equal(r.flips, 2)
  assert.equal(r.rapid_flips, 0)
})

test('a return within 2 s of the last change is a rapid flip', () => {
  const ev = (t, to) => ({ t, kind: 'mode', to })
  assert.equal(analyzeFight([ev(0, 'mobfight'), ev(7000, 'avoid'), ev(8500, 'mobfight')]).rapid_flips, 1)
  assert.equal(analyzeFight([ev(0, 'mobfight'), ev(7000, 'avoid'), ev(9000, 'mobfight')]).rapid_flips, 0)
})

test('the old flipping rate fails on the rate alone', () => {
  const events = []
  for (let i = 0; i < 40; i++) events.push({ t: i * 3000, kind: 'mode', to: i % 2 ? 'retreat' : 'mobfight' })
  const report = analyzeFight(events)
  assert.equal(report.rapid_flips, 0)
  assert.ok(report.flips_per_min > 6)
  assert.equal(fightVerdict({ report: { ...report, fought_by: 'network' }, health: { samples: 3, lowest_y: 64 }, killed: { zombie: 1 }, mobs: ['zombie'], deaths: 0 }).ok, false)
})

test('which fighter fought comes from the log lines', () => {
  const b = (...x) => x.map(brain => ({ t: 0, kind: 'brain', brain }))
  assert.equal(analyzeFight(b('trained network')).fought_by, 'network')
  assert.equal(analyzeFight(b('scripted, no axe in the bag and the network only trained with one')).fought_by, 'scripted')
  assert.equal(analyzeFight(b('trained network', 'scripted, the network stopped answering')).fought_by, 'mixed')
  assert.equal(analyzeFight([]).fought_by, 'none')
})

test('health lost adds up every drop, healing in between does not hide one', () => {
  const r = healthSummary([{ health: 20, y: 64 }, { health: 15, y: 64 }, { health: 18, y: 63 }, { health: 12, y: 64 }, { health: null, y: null }])
  assert.equal(r.health_lost, 11)
  assert.equal(r.lowest_health, 12)
  assert.equal(r.lowest_y, 63)
})

test('the alive reply is read for the real replies', () => {
  assert.equal(parseAlive('Test passed, count: 3'), 3)
  assert.equal(parseAlive('Test failed'), 0)
  assert.equal(parseAlive('Test passed'), 1)
  assert.equal(parseAlive('something else'), null)
})

test('the throw angle is measured against the line to the owner', () => {
  const bot = { x: 0, z: 0 }
  const owner = { x: 5, z: 0 }
  assert.equal(throwAngle(bot, owner, { x: 0.3, z: 0 }), 0)
  assert.equal(throwAngle(bot, owner, { x: -0.3, z: 0 }), 180)
  assert.equal(throwAngle(bot, owner, { x: 0, z: 0.3 }), 90)
  assert.equal(throwAngle(bot, owner, { x: 0, z: 0 }), null)
  assert.equal(throwAngle(bot, owner, null), null)
})

test('the motion reply is read, small numbers included', () => {
  assert.deepEqual(parseMotion('Item has the following entity data: [0.12d, 0.1d, -1.0E-4d]'), { x: 0.12, y: 0.1, z: -0.0001 })
  assert.equal(parseMotion('No entity was found'), null)
})

test('facing needs at least one measured throw and none off to the side', () => {
  assert.equal(facingVerdict([]).ok, false)
  assert.equal(facingVerdict([{ angle: null }]).ok, false)
  assert.equal(facingVerdict([{ angle: 10 }, { angle: 44 }]).ok, true)
  assert.equal(facingVerdict([{ angle: 10 }, { angle: 46 }]).ok, false)
})

test('each arena fits the levelled site, with the mobs on standing ground', () => {
  const c = { x: SPOT.x, y: SPOT.y, z: SPOT.z + 6 }
  for (const kind of ['open', 'cave', 'water', 'ledge']) {
    const a = arena(kind, c)
    for (const p of mobSpots(a, 4)) {
      assert.ok(Math.abs(p.x - SPOT.x) <= 12 && p.z - SPOT.z >= -6 && p.z - SPOT.z <= 18, kind)
      const d = Math.hypot(p.x - (a.bot.x + 0.5), p.z - (a.bot.z + 0.5))
      assert.ok(d >= 2 && d <= 10.5, `${kind} ${d}`)
    }
  }
  const cave = arena('cave', c)
  for (const p of mobSpots(cave, 4)) assert.ok(Math.abs(Math.floor(p.x) - c.x) <= 6 && Math.abs(Math.floor(p.z) - c.z) <= 6, 'inside the room')
  assert.ok(arena('ledge', c).standY - c.y > 3, 'a drop the movement guard must refuse')
  const top = arena('ledge', c)
  for (const p of mobSpots(top, 4)) assert.ok(Math.abs(Math.floor(p.x) - c.x) <= 5 && Math.abs(Math.floor(p.z) - c.z) <= 5, 'on the platform')
  const pool = arena('water', c)
  for (const p of mobSpots(pool, 4)) assert.ok(Math.max(Math.abs(Math.floor(p.x) - c.x), Math.abs(Math.floor(p.z) - c.z)) > 5, 'on the shore')
})

// ---------- the fights ----------

const winning = (w, s, kinds, brain = 'trained network') => () => {
  s.brain(brain)
  s.mode('idle', 'mobfight')
  for (const k of kinds) bump(w, 'killed', k)
  w.alive = 0
}

test('a fight won by the network passes, counted on the server', async () => {
  const w = fakeWorld()
  const s = session('net_group2', w)
  w.script = winning(w, s, ['zombie', 'skeleton'])
  const r = await s.def.run(s)
  assert.equal(r.ok, true, JSON.stringify(r.fail_reasons))
  assert.equal(r.fought_by, 'network')
  assert.equal(r.kills_total, 2)
  assert.equal(r.deaths, 0)
  assert.equal(r.health_lost, 0)
  assert.ok(w.sent.includes('time set 18000'))
})

test('the skeleton is summoned with no data, so it keeps its bow', async () => {
  const w = fakeWorld()
  const s = session('net_skeleton', w)
  w.script = winning(w, s, ['skeleton'])
  await s.def.run(s)
  const line = w.sent.find(c => c.startsWith('summon minecraft:skeleton'))
  assert.match(line, /^summon minecraft:skeleton -?[\d.]+ -?[\d.]+ -?[\d.]+$/)
})

test('an enderman is provoked by the bot through the server', async () => {
  const w = fakeWorld()
  const s = session('net_enderman', w)
  w.script = winning(w, s, ['enderman'])
  await s.def.run(s)
  assert.ok(w.sent.some(c => /^damage @e\[type=minecraft:enderman,tag=livefight,limit=1\] 1 minecraft:player_attack by Agent1$/.test(c)))
})

test('the scripted fallback fails the scene even when every mob dies', async () => {
  const w = fakeWorld()
  const s = session('net_zombie', w)
  w.script = winning(w, s, ['zombie'], 'scripted, the policy process is unavailable: gone')
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.equal(r.fought_by, 'scripted')
  assert.match(r.fail_reasons.join(), /policy process/)
})

test('flipping between fighting and running fails the scene even when every mob dies', async () => {
  const w = fakeWorld()
  const s = session('net_zombie', w)
  w.script = () => {
    s.brain('trained network')
    for (let i = 0; i < 6; i++) s.mode('x', i % 2 ? 'mobfight' : 'retreat')
    bump(w, 'killed', 'zombie')
    w.alive = 0
  }
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.ok(r.rapid_flips > 0)
})

test('a creeper that blew itself up is not a kill', async () => {
  const w = fakeWorld()
  const s = session('net_creeper', w)
  w.script = () => { s.brain('trained network'); s.mode('idle', 'mobfight'); w.alive = 0 }
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.match(r.fail_reasons.join(), /0 of 1 creeper/)
})

test('a death fails the scene and ends it', async () => {
  const w = fakeWorld()
  const s = session('net_zombie', w)
  w.script = () => { s.brain('trained network'); s.mode('idle', 'mobfight'); s.metrics.lines.push({ bot: 'Agent1', death: true }) }
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.equal(r.deaths, 1)
  assert.equal(r.steps[0].result, 'died')
})

test('mobs still alive at the cap fail the scene', async () => {
  const w = fakeWorld()
  const s = session('net_zombie', w, { capMs: 20 })
  w.script = () => { s.brain('trained network'); s.mode('idle', 'mobfight') }
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.equal(r.steps[0].result, 'capped')
  assert.equal(r.mobs_left, 1)
})

test('falling off the ledge fails the scene', async () => {
  const w = fakeWorld()
  const s = session('net_ledge', w)
  w.lowY = 64   // the platform top is at Y 69
  w.script = winning(w, s, ['zombie', 'zombie'])
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.match(r.fail_reasons.join(), /fell off the ledge/)
})

test('a fight needs the agents in this process to read the fighter', async () => {
  const w = fakeWorld()
  const s = session('net_zombie', w, { agents: null })
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.equal(w.alive, 0, 'nothing summoned')
})

test('console.error is put back after a fight', async () => {
  const before = console.error
  const w = fakeWorld()
  const s = session('net_zombie', w)
  w.script = winning(w, s, ['zombie'])
  await s.def.run(s)
  assert.equal(console.error, before)
})

// ---------- crafting and handing over ----------

function crafter (w, s, { toward = true, botKeeps = false, gives = 1 } = {}) {
  w.onChat = text => {
    const m = text.match(/^craft me a (.+)$/)
    if (!m) return
    const item = m[1].replace(/ /g, '_')
    if (botKeeps) w.bags.Agent1[item] = 1
    else w.bags.AgentTester[item] = (w.bags.AgentTester[item] || 0) + gives
    w.toss(toward)
    s.metrics.lines.push({ bot: 'Agent1', job: 'craft', result: 'done' })
  }
}

test('every craft passes when each lands in the owner\'s bag, thrown toward the owner', async () => {
  const w = fakeWorld()
  const s = session('craft_every', w)
  crafter(w, s)
  const r = await s.def.run(s)
  assert.equal(r.ok, true, JSON.stringify(r.fail_reasons))
  assert.equal(r.steps.length, 6)
  for (const [item, bag] of Object.entries(CRAFT_BAGS)) {
    for (const [name, n] of bag) assert.ok(w.sent.includes(`give Agent1 minecraft:${name} ${n}`), `${item} ${name}`)
  }
})

test('a craft thrown away from the owner fails', async () => {
  const w = fakeWorld()
  const s = session('craft_every', w)
  crafter(w, s, { toward: false })
  assert.equal((await s.def.run(s)).ok, false)
})

test('a craft the bot keeps fails', async () => {
  const w = fakeWorld()
  const s = session('craft_every', w)
  crafter(w, s, { botKeeps: true })
  assert.equal((await s.def.run(s)).ok, false)
})

test('two of an item in the owner\'s bag is not the one that was asked for', async () => {
  const w = fakeWorld()
  const s = session('craft_every', w)
  crafter(w, s, { gives: 2 })
  assert.equal((await s.def.run(s)).ok, false)
})

function giver (w, s, { toward = true, short = false } = {}) {
  w.onChat = text => {
    if (text !== '!Agent1 give') return
    const bag = w.bags.Agent1
    w.bags.AgentTester.cobblestone = (w.bags.AgentTester.cobblestone || 0) + (short ? 15 : bag.cobblestone)
    w.bags.AgentTester.coal = (w.bags.AgentTester.coal || 0) + bag.coal
    w.bags.Agent1 = {}
    w.toss(toward)
    s.metrics.lines.push({ bot: 'Agent1', job: 'give', result: 'done' })
  }
}

test('handing over passes from two owner positions when thrown toward the owner', async () => {
  const w = fakeWorld()
  const s = session('handover_facing', w)
  giver(w, s)
  const r = await s.def.run(s)
  assert.equal(r.ok, true, JSON.stringify(r.fail_reasons))
  assert.equal(r.steps.length, 2)
  assert.ok(r.steps.every(x => x.facing.worst_angle <= 45))
})

test('a handover thrown the other way fails even when the items arrive', async () => {
  const w = fakeWorld()
  const s = session('handover_facing', w)
  giver(w, s, { toward: false })
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.ok(r.steps.every(x => x.handed_over))
})

test('the throw is read from the spawn packet when the server has no motion to report', async () => {
  const w = fakeWorld()
  w.noServerMotion = true
  const s = session('handover_facing', w)
  giver(w, s)
  assert.equal((await s.def.run(s)).ok, true)
})

test('a handover with no throw to read does not pass', async () => {
  const w = fakeWorld()
  w.noServerMotion = true
  w.noPacketMotion = true
  const s = session('handover_facing', w)
  giver(w, s)
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.ok(r.steps.every(x => x.facing.measured === 0))
})

test('a handover one item short fails', async () => {
  const w = fakeWorld()
  const s = session('handover_facing', w)
  giver(w, s, { short: true })
  assert.equal((await s.def.run(s)).ok, false)
})

// ---------- food ----------

const eats = (w, item) => { w.bags.Agent1[item]--; bump(w, 'used', item); w.food = Math.min(20, w.food + 5) }

test('ready food first passes when bread goes first and the raw beef stays', async () => {
  const w = fakeWorld()
  const s = session('food_ready_first', w)
  w.drainTo = 17
  w.afterDrain = () => eats(w, 'bread')
  const r = await s.def.run(s)
  assert.equal(r.ok, true, JSON.stringify(r.fail_reasons))
  assert.equal(r.first_eaten, 'bread')
})

test('raw beef eaten with bread in the bag fails', async () => {
  const w = fakeWorld()
  const s = session('food_ready_first', w)
  w.drainTo = 17
  w.afterDrain = () => eats(w, 'beef')
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.equal(r.first_eaten, 'beef')
})

test('cooking with bread in the bag fails', async () => {
  const w = fakeWorld()
  const s = session('food_ready_first', w)
  w.drainTo = 17
  w.afterDrain = () => { eats(w, 'bread'); bump(w, 'crafted', 'cooked_beef') }
  assert.equal((await s.def.run(s)).ok, false)
})

const cooks = (w, { raw = false } = {}) => () => {
  bump(w, 'custom', 'interact_with_furnace')
  bump(w, 'crafted', 'cooked_beef', 4)
  bump(w, 'used', 'cooked_beef')
  if (raw) bump(w, 'used', 'beef')
  w.food = 17
}

test('cooking passes on a real furnace, the steak taken out and eaten', async () => {
  const w = fakeWorld()
  const s = session('food_cook', w)
  w.drainTo = 9
  w.afterDrain = cooks(w)
  const r = await s.def.run(s)
  assert.equal(r.ok, true, JSON.stringify(r.fail_reasons))
  assert.ok(w.sent.includes('setblock 4 64 -2 minecraft:furnace'))
})

test('eating raw while cooking is possible fails', async () => {
  const w = fakeWorld()
  const s = session('food_cook', w)
  w.drainTo = 9
  w.afterDrain = cooks(w, { raw: true })
  assert.equal((await s.def.run(s)).ok, false)
})

test('steak the bot never ate fails', async () => {
  const w = fakeWorld()
  const s = session('food_cook', w, { capMs: 20 })
  w.drainTo = 9
  w.afterDrain = () => { bump(w, 'custom', 'interact_with_furnace'); bump(w, 'crafted', 'cooked_beef', 4) }
  assert.equal((await s.def.run(s)).ok, false)
})

test('eating early passes on a bite before the bot is hungry', async () => {
  const w = fakeWorld()
  const s = session('food_early', w)
  w.drainTo = 17
  w.afterDrain = () => eats(w, 'bread')
  const r = await s.def.run(s)
  assert.equal(r.ok, true, JSON.stringify(r.fail_reasons))
  assert.equal(r.bar_at_first_bite, 17)
})

test('a first bite at a hungry bar is not early', async () => {
  const w = fakeWorld()
  const s = session('food_early', w)
  w.drainTo = 12
  w.afterDrain = () => eats(w, 'bread')
  assert.equal((await s.def.run(s)).ok, false)
})

test('never eating fails', async () => {
  const w = fakeWorld()
  const s = session('food_early', w, { capMs: 20 })
  w.drainTo = 17
  assert.equal((await s.def.run(s)).ok, false)
})

function missionWorld (extra) {
  const w = fakeWorld()
  w.tester.registry = {}
  const s = session('food_mission', w, extra)
  w.drainTo = 9
  return { w, s }
}

test('the food mission passes from an empty bag', async () => {
  const { w, s } = missionWorld()
  // groundAt reads blocks through the registry, so the fake world answers for it
  s.tester.world = { getColumnAt: () => ({}), getBlockStateId: v => (v.y === 63 ? 1 : 0) }
  s.tester.registry = { blocksByStateId: { 0: { name: 'air' }, 1: { name: 'grass_block' } } }
  w.afterDrain = () => {
    s.metrics.lines.push({ bot: 'Agent1', event: 'food-emergency', text: 'Out of food with my bar at 9, finding food comes first' })
    bump(w, 'killed', 'cow')
    bump(w, 'used', 'beef')
    w.food = 15
  }
  const r = await s.def.run(s)
  assert.equal(r.ok, true, JSON.stringify(r.fail_reasons))
  assert.equal(r.cows_placed, 4)
  for (const c of w.sent.filter(x => x.startsWith('summon minecraft:cow'))) {
    const [, x, , z] = c.match(/cow (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/)
    assert.ok(Math.hypot(Number(x) - 2.5, Number(z) + 1.5) > 32, 'out of sight')
  }
})

test('a bar that comes back with no mission fails', async () => {
  const { w, s } = missionWorld()
  s.tester.world = { getColumnAt: () => null }
  w.afterDrain = () => { bump(w, 'killed', 'cow'); bump(w, 'used', 'beef'); w.food = 15 }
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.match(r.fail_reasons.join(), /never started/)
})

test('a mission that never brings the bar back fails', async () => {
  const { w, s } = missionWorld({ capMs: 20 })
  s.tester.world = { getColumnAt: () => null }
  w.afterDrain = () => s.metrics.lines.push({ bot: 'Agent1', event: 'food-emergency', text: 'Out of food' })
  assert.equal((await s.def.run(s)).ok, false)
})

// ---------- plain chat ----------

function chatWorld ({ replies = {}, ledger = null, skip = [] } = {}) {
  const w = fakeWorld()
  const calls = []
  const client = { messages: { create: async a => { calls.push(a); return { content: [] } } } }
  const designerCalls = []
  const designer = { client: { messages: { create: async a => { designerCalls.push(a); return {} } } } }
  const s = session('chat_english', w)
  s.agents = { ctxs: s.agents.ctxs, translator: { client }, designer }
  if (ledger) process.env.AGENTS_HAIKU_LEDGER = ledger
  else delete process.env.AGENTS_HAIKU_LEDGER
  w.onChat = text => {
    const kind = Object.keys(CHAT_SCRIPT).find(k => CHAT_SCRIPT[k] === text)
    if (!kind || skip.includes(kind)) return
    client.messages.create({ text }).then(() => {
      if (kind === 'vague') botSays(s, replies.vague ?? 'Too vague for me: what should I do?')
      if (kind === 'impossible') botSays(s, replies.impossible ?? "That's impossible for me right now: I can't brew potions")
      if (kind === 'logs') w.bags.AgentTester.oak_log = 3
      if (kind === 'come') { w.positions.Agent1 = [...w.positions.AgentTester]; w.positions.Agent1[0] += 2 }
      if (kind === 'pick') w.bags.AgentTester.wooden_pickaxe = 1
    }).catch(() => botSays(s, 'API request failed: the Haiku call limit for this run is used up'))
  }
  return { w, s, calls, designerCalls }
}

test('the chat scene passes with three orders done and two different refusals', async () => {
  const { s, calls } = chatWorld()
  const r = await s.def.run(s)
  assert.equal(r.ok, true, JSON.stringify(r.fail_reasons))
  assert.equal(r.haiku_calls, CHAT_CALLS)
  assert.equal(calls.length, CHAT_CALLS)
  assert.deepEqual(r.steps.map(x => x.kind), ['vague', 'impossible', 'logs', 'come', 'pick'])
})

test('a vague request answered as impossible fails', async () => {
  const { s } = chatWorld({ replies: { vague: "That's impossible for me right now: no" } })
  assert.equal((await s.def.run(s)).ok, false)
})

test('an impossible request answered as too vague fails', async () => {
  const { s } = chatWorld({ replies: { impossible: 'Too vague for me: what?' } })
  assert.equal((await s.def.run(s)).ok, false)
})

test('a refusal that still starts a job fails', async () => {
  const { w, s } = chatWorld()
  const inner = w.onChat
  w.onChat = text => { inner(text); if (text === CHAT_SCRIPT.vague) s.metrics.lines.push({ bot: 'Agent1', job: 'gather', result: 'done' }) }
  assert.equal((await s.def.run(s)).ok, false)
})

test('an order the server does not see done fails', async () => {
  const { s } = chatWorld({ skip: ['pick'] })
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.equal(r.steps.find(x => x.kind === 'pick').result, 'capped')
})

test('trouble with the API stops the scene after one paid call', async () => {
  const { s, calls } = chatWorld({ replies: { vague: 'API error 529: overloaded' } })
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.equal(calls.length, 1)
  assert.equal(r.steps.length, 1)
})

test('the limit is shared through the ledger and refuses a scene it cannot cover', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  const ledger = path.join(dir, 'calls.log')
  fs.writeFileSync(ledger, 'x\n'.repeat(HAIKU_CAP - CHAT_CALLS + 1))
  const { s, calls } = chatWorld({ ledger })
  const r = await s.def.run(s)
  delete process.env.AGENTS_HAIKU_LEDGER
  fs.rmSync(dir, { recursive: true })
  assert.equal(r.ok, false)
  assert.equal(r.blocked, 'haiku limit')
  assert.equal(calls.length, 0)
})

test('a call past the cap never reaches the API, and each counted call is one ledger line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  const ledger = path.join(dir, 'calls.log')
  fs.writeFileSync(ledger, 'x\n'.repeat(HAIKU_CAP - 1))
  let real = 0
  const s = { name: 'chat_english', agents: { translator: { client: { messages: { create: async () => { real++; return {} } } } } } }
  const b = installHaikuBudget(s, ledger)
  await s.agents.translator.client.messages.create({})
  await assert.rejects(() => s.agents.translator.client.messages.create({}), /used up/)
  assert.equal(real, 1)
  assert.equal(ledgerCount(ledger), HAIKU_CAP)
  assert.equal(b.remaining(), 0)
  assert.equal(fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).pop(), 'chat_english')
  fs.rmSync(dir, { recursive: true })
})

test('the limit sits on the real translator, with no network call', async () => {
  const { Translator } = require('../translator')
  const translator = new Translator({ botNames: ['Agent1'], credentials: { key: 'offline-test-value' } })
  let real = 0
  translator.client.messages.create = async () => { real++; return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"vague": "What should I do?"}' }] } }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  const ledger = path.join(dir, 'calls.log')
  fs.writeFileSync(ledger, 'x\n'.repeat(HAIKU_CAP - 1))
  installHaikuBudget({ name: 'chat_english', agents: { translator } }, ledger)
  assert.equal((await translator.translate('help me out')).vague, 'What should I do?')
  const over = await translator.translate('help me out')
  fs.rmSync(dir, { recursive: true })
  assert.equal(real, 1)
  assert.match(over.error, /used up/)
  assert.equal(JSON.stringify(over).includes('offline-test-value'), false)
})

test('the larger designer model cannot be called from a chat scene', async () => {
  const { s, designerCalls } = chatWorld()
  installHaikuBudget(s, null)
  await assert.rejects(() => s.agents.designer.client.messages.create({}), /designer is off/)
  assert.equal(designerCalls.length, 0)
})

test('the translate scene keeps its pass test and counts its call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  const ledger = path.join(dir, 'calls.log')
  fs.writeFileSync(ledger, 'x\n'.repeat(HAIKU_CAP))
  process.env.AGENTS_HAIKU_LEDGER = ledger
  const w = fakeWorld()
  const s = { ...session('chat_english', w), name: 'translate', def: TESTS.translate }
  let real = 0
  s.agents = { translator: { client: { messages: { create: async () => { real++; return {} } } } } }
  const r = await TESTS.translate.run(s)
  delete process.env.AGENTS_HAIKU_LEDGER
  fs.rmSync(dir, { recursive: true })
  assert.equal(r.ok, false)
  assert.equal(r.blocked, 'haiku limit')
  assert.equal(real, 0)
})

// ---------- the armor the network trained in ----------

test('every fight wears the full plain iron set the network trained in, confirmed by the server', async () => {
  assert.deepEqual(FIGHT_ARMOR.map(x => x[1]), ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'])
  const w = fakeWorld()
  const s = session('net_zombie', w)
  w.script = winning(w, s, ['zombie'])
  const r = await s.def.run(s)
  assert.equal(r.armor_worn, 4)
  assert.equal(r.ok, true, r.fail_reasons.join())
  for (const [slot, item] of FIGHT_ARMOR) assert.ok(w.sent.includes(`item replace entity Agent1 ${slot} with minecraft:${item}`), item)
})

test('a fight the server does not show in full armor does not run and does not pass', async () => {
  const w = fakeWorld()
  w.armorRefused = true
  const s = session('net_zombie', w)
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.equal(r.armor_worn, 0)
  assert.equal(r.steps[0].result, 'setup')
  assert.match(r.fail_reasons.join(), /0 of 4 armor pieces/)
})

test('the fight log names the movement guard and keeps it apart from a scripted fallback', () => {
  const guard = 'trained network, movement guard: in water, under a roof'
  const held = analyzeFight([{ t: 0, kind: 'brain', brain: 'trained network' }, { t: 1, kind: 'brain', brain: guard }])
  assert.equal(held.fought_by, 'network')
  assert.deepEqual(held.guard_reasons, ['in water', 'under a roof'])
  assert.equal(held.guard_lines, 1)
  const handed = analyzeFight([{ t: 0, kind: 'brain', brain: guard }, { t: 1, kind: 'brain', brain: 'scripted, still in water after 12 s' }])
  assert.equal(handed.fought_by, 'mixed')
  assert.deepEqual(handed.fallback_reasons, ['scripted, still in water after 12 s'])
})

// ---------- the torch rule, on what the server counts ----------

const mined = (extra = {}) => ({ torches_placed: 0, torches_crafted: 0, blocks_dug: 200, walked_m: 150, picked_up: {}, agents_stats: { tunnel: 100, torchGaps: [] }, ...extra })

test('torches: none on a short trip', () => {
  const short = mined({ torches_placed: 1, agents_stats: { tunnel: 31, torchGaps: [31] } })
  const r = torchVerdict([short])
  assert.equal(r.ok, false)
  assert.equal(r.allowed, 0)
  assert.equal(torchVerdict([mined({ agents_stats: { tunnel: 31, torchGaps: [] } })]).ok, true)
})

test('torches: at most one per 32 blocks of tunnel, counted per job', () => {
  const at = (placed, tunnel) => torchVerdict([mined({ torches_placed: placed, agents_stats: { tunnel, torchGaps: Array(placed).fill(32) } })])
  assert.equal(at(3, 96).ok, true)
  assert.equal(at(4, 96).ok, false)
  // two jobs of 31 blocks are two short trips, not one tunnel of 62
  const trip = mined({ torches_placed: 1, agents_stats: { tunnel: 31, torchGaps: [32] } })
  assert.equal(torchVerdict([trip, mined({ agents_stats: { tunnel: 31, torchGaps: [] } })]).ok, false)
})

test('torches: the server count decides, however few the miner logged', () => {
  const r = torchVerdict([mined({ torches_placed: 9, agents_stats: { tunnel: 64, torchGaps: [32, 32] } })])
  assert.equal(r.ok, false)
  assert.match(r.reasons.join(), /server counts 9 torches placed, 2 allowed/)
})

test('torches: bunched torches fail even when the total is inside the limit', () => {
  const r = torchVerdict([mined({ torches_placed: 2, agents_stats: { tunnel: 96, torchGaps: [32, 5] } })])
  assert.equal(r.ok, false)
  assert.match(r.reasons.join(), /under 32 blocks/)
})

test('torches: a tunnel longer than the server saw it dig and walk is not believed', () => {
  const r = torchVerdict([mined({ torches_placed: 3, blocks_dug: 20, walked_m: 12, agents_stats: { tunnel: 500, torchGaps: [32, 32, 32] } })])
  assert.equal(r.tunnel, 32)
  assert.equal(r.allowed, 1)
  assert.equal(r.ok, false)
})

test('torches: a job with no tunnel log gets no torches', () => {
  assert.equal(torchVerdict([mined({ torches_placed: 1, agents_stats: null })]).ok, false)
  assert.equal(torchVerdict([mined({ agents_stats: null })]).ok, true)
})

test('torches: none from coal the job needs', () => {
  const coal = (got, crafted) => torchVerdict([mined({ picked_up: { coal: got }, torches_crafted: crafted })], { coalWanted: 5 })
  assert.equal(coal(5, 0).ok, true)
  assert.equal(coal(6, 4).ok, true, 'one spare coal')
  const short = coal(5, 4)
  assert.equal(short.ok, false)
  assert.match(short.reasons.join(), /1 coal went into torches, leaving 4 of the 5/)
})

// A mining scene on the fake server: the mine job reports its numbers, the server counts what it did
function mineScene (name, w, { job, stats, bag = {} }) {
  const s = session(name, w, { pickupMs: 0 })
  w.onChat = text => {
    if (/ mine /.test(text)) {
      for (const [cat, vals] of Object.entries(stats)) for (const [k, n] of Object.entries(vals)) bump(w, cat, k, n)
      s.metrics.lines.push({ bot: 'Agent1', job: 'mine', result: 'done', stats: job })
    } else if (/ give$/.test(text)) {
      Object.assign(w.bags.AgentTester, bag)
      s.metrics.lines.push({ bot: 'Agent1', job: 'give', result: 'done' })
    }
  }
  return s
}

const COAL_RUN = { mined: { coal_ore: 5, stone: 95 }, picked_up: { coal: 5 }, custom: { walk_one_cm: 8000 } }

test('gather_coal passes on a clean run and fails on torches made from its coal', async () => {
  const clean = fakeWorld()
  const first = mineScene('gather_coal', clean, { job: { tunnel: 40, torchGaps: [] }, stats: COAL_RUN, bag: { coal: 5 } })
  const ok = await first.def.run(first)
  assert.equal(ok.torch_check.ok, true, ok.torch_check.reasons.join())
  assert.equal(ok.ok, true)
  const burnt = fakeWorld()
  const stats = { ...COAL_RUN, crafted: { torch: 4 } }
  const s = mineScene('gather_coal', burnt, { job: { tunnel: 40, torchGaps: [] }, stats, bag: { coal: 4 } })
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.match(r.fail_reasons.join(), /coal went into torches/)
})

test('mining_mobs fails on a torch the short trip did not earn', async () => {
  const w = fakeWorld()
  const stats = { mined: { iron_ore: 3, stone: 40 }, picked_up: { raw_iron: 3 }, used: { torch: 2 }, custom: { walk_one_cm: 3000 } }
  const s = mineScene('mining_mobs', w, { job: { tunnel: 25, torchGaps: [] }, stats, bag: { raw_iron: 3 } })
  const r = await s.def.run(s)
  assert.equal(r.ok, false)
  assert.match(r.fail_reasons.join(), /server counts 2 torches placed, 0 allowed/)
})

test('a fight the owner is watching waits until his camera is on the bot, and only then summons the mobs', async () => {
  const w = fakeWorld()
  const s = session('net_zombie', w, { cameraWaitMs: 3000 })
  w.script = winning(w, s, ['zombie'], 'trained network')
  const send = s.rcon.send.bind(s.rcon)
  let asks = 0
  let asksAtSummon = null
  let asksAtPlacing = null
  s.rcon = { ...s.rcon, send: async c => {
    if (c.startsWith('execute as @a[name=WatcherOne,gamemode=spectator]')) return ++asks >= 3 ? 'Test passed, count: 1' : 'Test failed'
    if (c.startsWith('summon') && asksAtSummon === null) asksAtSummon = asks
    if (c.startsWith('tp Agent1') && asksAtPlacing === null) asksAtPlacing = asks
    return send(c)
  } }
  process.env.CREW_SHOW_WATCHER = 'WatcherOne'
  let r
  try { r = await s.def.run(s) } finally { delete process.env.CREW_SHOW_WATCHER }
  assert.equal(r.camera_on_bot, true)
  assert.equal(asksAtSummon, 3)
  assert.equal(asksAtPlacing, 3, 'the bot is put in the arena after the wait, or it walks off to hunt while it waits')
  assert.equal(r.ok, true)
})

test('a camera that never arrives does not hold the fight forever or change its result', async () => {
  const w = fakeWorld()
  const s = session('net_zombie', w, { cameraWaitMs: 30 })
  w.script = winning(w, s, ['zombie'], 'trained network')
  const send = s.rcon.send.bind(s.rcon)
  s.rcon = { ...s.rcon, send: async c => c.startsWith('execute as @a[name=WatcherOne') ? 'Test failed' : send(c) }
  process.env.CREW_SHOW_WATCHER = 'WatcherOne'
  let r
  try { r = await s.def.run(s) } finally { delete process.env.CREW_SHOW_WATCHER }
  assert.equal(r.camera_on_bot, false)
  assert.equal(r.ok, true)
})

test('with nobody watching a fight does not ask about a camera', async () => {
  const w = fakeWorld()
  const s = session('net_zombie', w)
  w.script = winning(w, s, ['zombie'], 'trained network')
  const r = await s.def.run(s)
  assert.equal(r.camera_on_bot, null)
})

