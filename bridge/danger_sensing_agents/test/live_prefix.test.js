// The fixes that come before the first live queue: the handover throw, creepers going to the trained network, the torch
// count in the miners, and the movement guard on ground the network never trained on. No server needed.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { Friends } = require('../targets')
const { DangerAssessor } = require('../threats')
const { GiveMode } = require('../behaviors')
const { MobFighter, netCanFight } = require('../skills/mob_fight')
const { MobNet, unsafeStep } = require('../skills/mob_net')
const { TerrainGuard, edgePush, findShore, noDropMoves, WATER_TICKS, SHORE_RADIUS } = require('../skills/mob_guard')
const { countTunnel, torchPlaced, TORCH_EVERY } = require('../skills/mine')
const { analyzeFight } = require('../live_scenes')
const { IDLE_ACTION } = require('../../fighter')

const walkKey = key => IDLE_ACTION.map((v, i) => (i === key[0] ? key[1] : v))
const W = walkKey([0, 1])

// ---------- the handover ----------

function giveSetup ({ ownerAt = new Vec3(2.5, 64, 0.5), items = [['cobblestone', 16], ['coal', 8]] } = {}) {
  const { bot } = makeBot({ groundY: 63 })
  bot._agentsRescue = {}
  for (const [name, n] of items) bot.give(name, n)
  const owner = { position: ownerAt }
  bot.players = { Owner: { entity: owner } }
  const ctx = { bot, agents: { owner: 'Owner', say: () => {}, log: () => {}, noDigMoves: () => ({}) } }
  const looks = []
  const lookAt = bot.lookAt
  bot.lookAt = async (point, force) => {
    looks.push({ tick: bot.ticks, point: point.clone(), force })
    return lookAt(point, force)
  }
  // the mock walks forward only: holding back moves it away from where it faces
  const ticks = bot.waitForTicks
  bot.waitForTicks = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      if (bot.getControlState('back')) {
        const y = bot.entity.yaw
        bot.entity.position = bot.entity.position.plus(new Vec3(Math.sin(y) * 0.2, 0, Math.cos(y) * 0.2))
      }
      await ticks(1)
    }
  }
  const throws = []
  const toss = bot.tossStack
  bot.tossStack = async item => {
    throws.push({ name: item.name, tick: bot.ticks, yaw: bot.entity.yaw, at: bot.entity.position.clone(), lastLook: looks[looks.length - 1] })
    return toss(item)
  }
  return { bot, ctx, owner, throws, looks, mode: new GiveMode(ctx) }
}

const offFacing = (t, target) => {
  const line = Math.atan2(-(target.x - t.at.x), -(target.z - t.at.z))
  let d = Math.abs(line - t.yaw) % (2 * Math.PI)
  if (d > Math.PI) d = 2 * Math.PI - d
  return d * 180 / Math.PI
}

test('give: every throw waits for the turn to reach the server and faces the owner chest', async () => {
  const s = giveSetup()
  s.bot.entity.yaw = 0   // back turned: the owner is to the east
  assert.equal(await s.mode.run({ cancelled: false }), 'done')
  assert.equal(s.throws.length, 2)
  for (const t of s.throws) {
    assert.ok(t.tick - t.lastLook.tick >= 3, `threw ${t.tick - t.lastLook.tick} ticks after the turn`)
    assert.equal(t.lastLook.force, true)
    assert.equal(t.lastLook.point.y, s.owner.position.y + 1.2)
    assert.ok(offFacing(t, s.owner.position) < 1, `${offFacing(t, s.owner.position)} degrees off`)
    const d = Math.hypot(s.owner.position.x - t.at.x, s.owner.position.z - t.at.z)
    assert.ok(d >= 1.5 && d <= 3, `threw from ${d} blocks`)
  }
})

test('give: an owner who moves between stacks is faced again before the next throw', async () => {
  const s = giveSetup()
  const toss = s.bot.tossStack
  s.bot.tossStack = async item => {
    await toss(item)
    s.owner.position = new Vec3(s.bot.entity.position.x, 64, s.bot.entity.position.z + 2)
  }
  await s.mode.run({ cancelled: false })
  assert.ok(offFacing(s.throws[1], s.owner.position) < 1)
  assert.notEqual(s.throws[0].yaw, s.throws[1].yaw)
})

test('give: a bot standing on the owner backs up to throw, and ends well clear of the drop', async () => {
  const s = giveSetup({ ownerAt: new Vec3(1.2, 64, 0.5), items: [['cobblestone', 16]] })
  const goto = s.bot.pathfinder.goto
  s.bot.pathfinder.goto = async () => {}   // already inside the 2 block goal
  await s.mode.run({ cancelled: false })
  s.bot.pathfinder.goto = goto
  const d = Math.hypot(s.owner.position.x - s.throws[0].at.x, s.owner.position.z - s.throws[0].at.z)
  assert.ok(d >= 1.5, `threw from ${d} blocks`)
  const after = Math.hypot(s.owner.position.x - s.bot.entity.position.x, s.owner.position.z - s.bot.entity.position.z)
  assert.ok(after >= 3.5, `stands ${after} blocks from the drop, inside pickup reach of it`)
  assert.equal(s.bot.getControlState('back'), false)
})

test('give: a cancel between stacks stops the throwing', async () => {
  const s = giveSetup()
  const token = { cancelled: false }
  const toss = s.bot.tossStack
  s.bot.tossStack = async item => { await toss(item); token.cancelled = true }
  assert.equal(await s.mode.run(token), 'cancelled')
  assert.equal(s.throws.length, 1)
})

// ---------- creepers ----------

function creeperSetup ({ netFights = null, axe = true } = {}) {
  const { bot } = makeBot({ groundY: 63 })
  bot.give('bread', 8)
  if (axe) bot.give('diamond_axe', 1)
  let t = 1000000
  const clock = { now: () => t, add: ms => { t += ms } }
  const a = new DangerAssessor(bot, { friends: new Friends('Owner', ['Agent1']), owner: 'Owner', now: clock.now, netFights })
  const e = { id: 7, type: 'hostile', name: 'creeper', position: new Vec3(0.5, 64, 5.5), height: 1.7, yaw: Math.PI }
  bot.entities[e.id] = e
  return { bot, a, clock, e }
}

test('creeper: with the network in charge it is fought at once, not backed away from', () => {
  const s = creeperSetup({ netFights: () => true })
  const r = s.a.update()
  assert.equal(r.avoid, null)
  assert.equal(r.fight?.entity, s.e)
})

test('creeper: without the network the scripted avoidance still backs off', () => {
  const s = creeperSetup({ netFights: () => false })
  const r = s.a.update()
  assert.equal(r.avoid?.entity, s.e)
  assert.equal(r.fight, null)
})

test('creeper: only a bot with an axe and a working network hands it to the network', () => {
  const net = { usable: () => true }
  const creeper = { name: 'creeper' }
  assert.equal(netCanFight(creeperSetup().bot, creeper, { net }), true)
  assert.equal(netCanFight(creeperSetup({ axe: false }).bot, creeper, { net }), false, 'no weapon')
  const sword = creeperSetup({ axe: false }).bot
  sword.give('diamond_sword', 1)
  assert.equal(netCanFight(sword, creeper, { net }), false, 'it only trained with an axe')
  assert.equal(netCanFight(creeperSetup().bot, creeper, { net: { usable: () => false } }), false, 'network down')
  assert.equal(netCanFight(creeperSetup().bot, { name: 'spider' }, { net }), false, 'a mob it never fought')
})

test('creeper: a back off under way holds 6 s before the network takes over', () => {
  let usable = false
  const s = creeperSetup({ netFights: () => usable })
  assert.equal(s.a.update().avoid?.entity, s.e)
  usable = true
  s.clock.add(3000)
  assert.equal(s.a.update().avoid?.entity, s.e, 'still inside the hold')
  s.clock.add(3100)
  const r = s.a.update()
  assert.equal(r.avoid, null)
  assert.equal(r.fight?.entity, s.e)
})

test('creeper: a network that drops out mid fight does not flip the bot back to running', () => {
  let usable = true
  const s = creeperSetup({ netFights: () => usable })
  s.e.position = new Vec3(0.5, 64, 3.5)   // in the fight, so it is never given up as out of reach
  assert.equal(s.a.update().fight?.entity, s.e)
  usable = false
  for (let i = 0; i < 25; i++) {
    s.clock.add(1000)
    const r = s.a.update()
    assert.equal(r.avoid, null, `flipped after ${i + 1} s`)
    assert.equal(r.fight?.entity, s.e)
  }
})

test('the network reports itself down and comes back when its process does', async () => {
  let fail = true
  const policy = { start: async () => { if (fail) throw new Error('gone') }, close: () => {} }
  const net = new MobNet(() => {}, { file: 'x', policy, gate: () => ({ ok: true }) })
  assert.equal(net.usable(), true)
  assert.equal((await net.ready()).ok, false)
  assert.equal(net.usable(), false)
  fail = false
  assert.equal((await net.ready()).ok, true)
  assert.equal(net.usable(), true)
  const refused = new MobNet(() => {}, { file: 'x', policy, gate: () => ({ ok: false, why: 'no parity' }) })
  assert.equal(refused.usable(), false)
})

// ---------- the torch count in the miners ----------

test('tunnel count: a cell counts once, so walking back earns no torch', () => {
  const ctx = { sinceTorch: 0, torchGap: TORCH_EVERY, stats: { torches: 0 } }
  for (let z = 0; z < 20; z++) countTunnel(ctx, new Vec3(0, 10, z))
  for (let z = 19; z >= 0; z--) countTunnel(ctx, new Vec3(0, 10, z))
  assert.equal(ctx.sinceTorch, 20)
  assert.equal(ctx.stats.tunnel, 20)
  countTunnel(ctx, new Vec3(5, 10, 5), 6)
  assert.equal(ctx.stats.tunnel, 26)
})

test('torch log: each placement records the tunnel it closed and restarts the count', () => {
  const ctx = { sinceTorch: 33, torchGap: TORCH_EVERY, stats: { torches: 0 } }
  torchPlaced(ctx)
  ctx.sinceTorch = 40
  torchPlaced(ctx)
  assert.equal(ctx.stats.torches, 2)
  assert.deepEqual(ctx.stats.torchGaps, [33, 40])
  assert.equal(ctx.sinceTorch, 0)
})

// ---------- the movement guard ----------

// A pool 2 deep from x -8 to 3, around a bot standing on its floor, with dry ground from x 4
function pool ({ east = 3 } = {}) {
  const made = makeBot({ groundY: 63, pos: new Vec3(0.5, 62, 0.5) })
  for (let x = -8; x <= east; x++) {
    for (let z = -8; z <= 8; z++) {
      for (const y of [62, 63]) made.world.set(new Vec3(x, y, z), 'water')
    }
  }
  return made
}

function ledge () {
  const made = makeBot({ groundY: 63 })
  for (let x = 2; x <= 8; x++) {
    for (let z = -8; z <= 8; z++) {
      for (let y = 58; y <= 63; y++) made.world.set(new Vec3(x, y, z), 'air')
    }
  }
  made.bot.entity.onGround = true
  return made
}

function mobAt (bot, name, offset) {
  const e = { id: 900 + Object.keys(bot.entities).length, type: 'hostile', name, position: bot.entity.position.plus(offset), velocity: new Vec3(0, 0, 0), yaw: 0, height: 1.95, metadata: { 9: 20 } }
  bot.entities[e.id] = e
  return e
}

test('guard: on plain ground the network keeps its own keys', () => {
  const { bot } = makeBot({ groundY: 63 })
  bot.entity.onGround = true
  const g = new TerrainGuard(bot)
  const r = g.decide(W, mobAt(bot, 'zombie', new Vec3(0, 0, 2)))
  assert.deepEqual(r.action, W)
  assert.equal(r.handover, null)
  assert.equal(r.label, 'trained network')
})

test('guard: in water it swims for the nearest dry ground and the network keeps its aim and swing', () => {
  const { bot } = pool()
  const shore = findShore(bot)
  assert.equal(shore.x, 4)
  bot.entity.yaw = 0   // facing north, so east is its right hand
  const action = IDLE_ACTION.slice()
  action[4] = 3
  action[5] = 2
  action[6] = 1
  const r = new TerrainGuard(bot).decide(action, mobAt(bot, 'zombie', new Vec3(0, 0, 2)))
  assert.equal(r.handover, null)
  assert.equal(r.action[1], 2, 'right, toward the shore')
  assert.equal(r.action[3], 1, 'holding jump to swim up')
  assert.equal(r.action[2], 0, 'no sprint')
  assert.deepEqual([r.action[4], r.action[5], r.action[6]], [3, 2, 1], 'its aim and swing are the network\'s')
  assert.match(r.label, /^trained network, movement guard: in water/)
})

test('guard: water with no dry ground in reach goes to the scripted fighter', () => {
  const { bot, world } = pool({ east: 8 + SHORE_RADIUS })
  for (let x = -8 - SHORE_RADIUS; x <= 8 + SHORE_RADIUS; x++) {
    for (let z = -8 - SHORE_RADIUS; z <= 8 + SHORE_RADIUS; z++) {
      for (const y of [62, 63]) world.set(new Vec3(x, y, z), 'water')
    }
  }
  const r = new TerrainGuard(bot).decide(IDLE_ACTION, mobAt(bot, 'zombie', new Vec3(0, 0, 2)))
  assert.match(r.handover, /no dry ground/)
})

test('guard: still in water after its time limit goes to the scripted fighter', () => {
  const { bot } = pool()
  const g = new TerrainGuard(bot)
  const z = mobAt(bot, 'zombie', new Vec3(0, 0, 2))
  let r
  for (let t = 0; t < WATER_TICKS; t += 2) {
    assert.equal(r?.handover ?? null, null)
    r = g.decide(IDLE_ACTION, z)
  }
  assert.match(r.handover, /still in water after 12 s/)
})

test('guard: getting out of water starts the clock over', () => {
  const { bot } = pool()
  const g = new TerrainGuard(bot)
  const z = mobAt(bot, 'zombie', new Vec3(0, 0, 2))
  for (let t = 0; t < WATER_TICKS - 4; t += 2) g.decide(IDLE_ACTION, z)
  const wet = bot.entity.position
  bot.entity.position = new Vec3(5.5, 64, 0.5)
  bot.entity.onGround = true
  g.decide(IDLE_ACTION, z)
  assert.equal(g.waterTicks, 0)
  bot.entity.position = wet
  assert.equal(g.decide(IDLE_ACTION, z).handover, null)
})

test('guard: a step down of 1 is fine, a drop of 2 is refused', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  world.set(new Vec3(1, 63, 0), 'air')
  assert.equal(unsafeStep(bot, 1, 0), false, 'one block down')
  world.set(new Vec3(1, 62, 0), 'air')
  assert.equal(unsafeStep(bot, 1, 0), true, 'two blocks down')
})

test('guard: at a ledge it walks back in, away from the drop', () => {
  const { bot } = ledge()
  bot.entity.position = new Vec3(1.6, 64, 0.5)
  bot.entity.yaw = -Math.PI / 2   // facing east, over the edge
  assert.ok(edgePush(bot).x < 0)
  const r = new TerrainGuard(bot).decide(W, mobAt(bot, 'zombie', new Vec3(-2, 0, 0)))
  assert.equal(r.action[0], 2, 'backward, away from the edge')
  assert.match(r.label, /at a ledge/)
  assert.equal(r.handover, null)
})

test('guard: a roof and a mob on another level are named, and the network keeps its feet', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  bot.entity.onGround = true
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) world.set(new Vec3(x, 67, z), 'stone')
  const r = new TerrainGuard(bot).decide(W, mobAt(bot, 'zombie', new Vec3(0, 3, 2)))
  assert.deepEqual(r.action, W)
  assert.match(r.label, /under a roof/)
  assert.match(r.label, /mob on another level/)
})

test('guard: its log line holds through a short gap, so an edge does not flood the log', () => {
  const { bot } = ledge()
  const g = new TerrainGuard(bot)
  const z = mobAt(bot, 'zombie', new Vec3(-1, 0, 0))
  bot.entity.position = new Vec3(1.6, 64, 0.5)
  const at = g.decide(W, z).label
  bot.entity.position = new Vec3(-3.5, 64, 0.5)
  for (let i = 0; i < 5; i++) assert.equal(g.decide(W, z).label, at)
  for (let i = 0; i < 6; i++) g.decide(W, z)
  assert.equal(g.label, 'trained network')
})

const logged = () => {
  const lines = []
  return { lines, log: m => lines.push(m), events: () => lines.filter(l => l.includes('mob fighter: ')).map((l, t) => ({ t, kind: 'brain', brain: l.split('mob fighter: ')[1] })) }
}

test('a network told to walk off a ledge stays on it, and the log says the guard held it', async () => {
  const { bot } = ledge()
  bot.give('iron_axe', 1)
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.entity.yaw = -Math.PI / 2   // facing east, toward the edge at x 2
  const z = mobAt(bot, 'zombie', new Vec3(-2, 0, 0))
  let asked = 0
  const net = { ready: async () => ({ ok: true }), act: async () => { if (++asked > 40) delete bot.entities[z.id]; return W } }
  const out = logged()
  const r = await new MobFighter(bot, { log: out.log }).start(z, { net })
  assert.equal(r, 'dead')
  assert.equal(bot.entity.position.y, 64, 'never left the top')
  assert.ok(bot.entity.position.x < 2.3, `ended at x ${bot.entity.position.x}`)
  const report = analyzeFight(out.events())
  assert.equal(report.fought_by, 'network')
  assert.ok(report.guard_reasons.includes('at a ledge'), JSON.stringify(report))
})

test('a fight that cannot leave the water goes to the scripted fighter and says why', async () => {
  const { bot, world } = pool({ east: 8 + SHORE_RADIUS })
  for (let x = -8 - SHORE_RADIUS; x <= 8 + SHORE_RADIUS; x++) {
    for (let z = -8 - SHORE_RADIUS; z <= 8 + SHORE_RADIUS; z++) {
      for (const y of [62, 63]) world.set(new Vec3(x, y, z), 'water')
    }
  }
  bot.give('iron_axe', 1)
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  const z = mobAt(bot, 'zombie', new Vec3(0, 0, 2))
  bot.attack = e => { delete bot.entities[e.id] }
  const net = { ready: async () => ({ ok: true }), act: async () => W }
  const out = logged()
  assert.equal(await new MobFighter(bot, { log: out.log }).start(z, { net }), 'dead')
  const report = analyzeFight(out.events())
  assert.equal(report.fought_by, 'mixed')
  assert.match(report.fallback_reasons.join(), /no dry ground/)
})

test('a cancelled walk to a far mob leaves the next mode its goal and walking rules', async () => {
  const { bot } = makeBot({ groundY: 63 })
  bot.give('iron_axe', 1)
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.pathfinder.movements = { maxDropDown: 4 }
  const z = mobAt(bot, 'zombie', new Vec3(0, 0, 20))
  const fighter = new MobFighter(bot)
  const nextMoves = { maxDropDown: 2 }
  const nextGoal = { next: true }
  const ticks = bot.waitForTicks
  let n = 0
  bot.waitForTicks = async k => {
    if (++n === 3) {
      fighter.stop()
      bot.pathfinder.setMovements(nextMoves)
      bot.pathfinder.setGoal(nextGoal)
    }
    return ticks(k)
  }
  const net = { ready: async () => ({ ok: true }), act: async () => IDLE_ACTION }
  assert.equal(await fighter.start(z, { net }), 'stopped')
  assert.equal(bot.pathfinder.movements, nextMoves)
  assert.equal(bot.pathfinder.goal, nextGoal)
})

test('the walk to a far mob keeps to its level and puts the walking rules back', async () => {
  const { bot } = makeBot({ groundY: 63 })
  bot.give('iron_axe', 1)
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  const base = { maxDropDown: 4 }
  bot.pathfinder.movements = base
  const z = mobAt(bot, 'zombie', new Vec3(0, 0, 20))
  let during = null
  const ticks = bot.waitForTicks
  let n = 0
  bot.waitForTicks = async k => {
    if (++n === 3) during = bot.pathfinder.movements
    if (n === 6) delete bot.entities[z.id]
    return ticks(k)
  }
  const net = { ready: async () => ({ ok: true }), act: async () => IDLE_ACTION }
  assert.equal(await new MobFighter(bot).start(z, { net }), 'dead')
  assert.equal(during.maxDropDown, 1)
  assert.equal(base.maxDropDown, 4, 'the shared rules are not changed')
  assert.equal(bot.pathfinder.movements, base)
  assert.equal(noDropMoves(null), null)
})
