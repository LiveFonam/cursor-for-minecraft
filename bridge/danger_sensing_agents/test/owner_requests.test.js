// What the owner asked for after watching the bot: hunting on the way, the axe, the wooden pickaxe as a throwaway step,
// creepers, and food counted the way it will really be eaten, with no standing around for it.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot, FakeWorld } = require('./mockbot')
const { makePhysicsBot } = require('./physicsbot')
const { Friends } = require('../targets')
const { Mode } = require('../modes')
const { makeModes, foodBeforeLongDig } = require('../behaviors')
const { planGoal, goalCommands } = require('../goal_plan')
const { DangerAssessor, FOOD_RESERVE, blastDamage, survivesBlast } = require('../threats')
const { foodSupply, supplyText, animalOnTheWay, huntOnTheWay, huntOne, foodPointsCarried, WAY_RADIUS, WAY_RESERVE } = require('../skills/food')
const { foodNeed } = require('../skills/food_plan')
const { bestWeapon } = require('../skills/mob_fight')
const { sharedMobNet } = require('../skills/mob_net')
const { bestPickaxeItem } = require('../skills/gather_kinds')
const { pickTool, mineJob } = require('../skills/mine')
const { guardHazards } = require('../skills/move')
const { installMotion } = require('../skills/motion')

const bag = o => new Map(Object.entries(o))
const plan = (item, count = 1, s = {}) => planGoal({ item, count }, { bag: bag(s.bag || {}), chests: s.chests || [], owner: s.owner ? bag(s.owner) : null })
const labels = p => goalCommands(p, 'Owner').map(c => c.label)
const cobble = p => p.steps.filter(s => s.kind === 'gather' && s.what === 'cobblestone')
const human = { level: 'off', placesTorches: false, nextTorchGap: () => 99, idleMoment: async () => {}, lookAtPoint: async () => {}, lookAround: async () => {}, detourPoint: () => null }

function fakeAgents (extra = {}) {
  const events = []
  return {
    owner: 'Owner',
    friends: new Friends('Owner', ['Agent1']),
    log: () => {},
    events,
    event: (bot, level, key, text) => events.push({ level, key, text }),
    say: () => {},
    stopAll: () => {},
    profileChanged: () => {},
    farms: () => [],
    noDigMoves: () => ({ name: 'noDig', allowSprinting: true }),
    digMoves: () => ({}),
    buildMoves: () => ({ name: 'build' }),
    ensureKit: async () => {},
    announce: () => {},
    blackboard: { clear () {} },
    ...extra
  }
}

let nextId = 900
function animal (bot, name, x, z, { y = null, metadata = {} } = {}) {
  const e = { id: nextId++, type: 'animal', name, position: new Vec3(x, y ?? bot.entity.position.y, z), height: 1, metadata: { 9: 8, ...metadata } }
  bot.entities[e.id] = e
  return e
}

// A hit kills, and the meat lands straight in the bag
function armHunting (bot, drops = { cow: { beef: 3 }, sheep: { mutton: 2 } }) {
  const setGoal = bot.pathfinder.setGoal
  bot.pathfinder.setGoal = g => {
    setGoal(g)
    const target = g?.entity
    if (target && bot.entities[target.id] && !g.goal) bot.entity.position = target.position.offset(1, 0, 0)
  }
  bot.attack = e => {
    delete bot.entities[e.id]
    for (const [name, n] of Object.entries(drops[e.name] || {})) bot.give(name, n)
  }
}

class StandInJob extends Mode {
  constructor (name) {
    super(name)
    this.profile = name
  }
}

// The real modes with a stand-in for the job in control
function withJob (name = 'gather', inv = {}) {
  const { bot, world } = makeBot()
  for (const [n, c] of Object.entries(inv)) bot.give(n, c)
  const agents = fakeAgents()
  const ctx = { bot, agents }
  const m = makeModes(ctx)
  const job = new StandInJob(name)
  m.modes[m.modes.indexOf(m.get(name))] = job
  m.byName.set(name, job)
  job.start({})
  ctx.danger.update()
  return { bot, world, agents, ctx, m, job }
}

// ---------- the wooden pickaxe is a throwaway step ----------

test('an iron pickaxe from an empty bag: 3 cobblestone with the wooden pickaxe, all the rest with the stone one', () => {
  const p = plan('iron_pickaxe')
  assert.deepEqual(labels(p), [
    'gather 4 logs', 'craft wooden pickaxe', 'craft wooden axe to keep', 'gather 3 cobblestone', 'craft stone pickaxe',
    'gather 11 cobblestone', 'gather 3 raw iron', 'smelt 3 raw iron, craft iron pickaxe', 'walk to you', 'hand over iron pickaxe'
  ])
  assert.deepEqual(cobble(p).map(s => [s.count, !!s.withWood]), [[3, true], [11, false]])
})

test('from partial bags the wooden pickaxe digs only what the stone pickaxe still lacks', () => {
  let p = plan('iron_pickaxe', 1, { bag: { wooden_pickaxe: 1, cobblestone: 2 } })
  assert.deepEqual(cobble(p).map(s => [s.count, !!s.withWood]), [[1, true], [11, false]])
  assert.ok(!labels(p).includes('craft wooden pickaxe'), 'the one it has will do')
  p = plan('iron_pickaxe', 1, { bag: { wooden_pickaxe: 1, cobblestone: 3 } })
  assert.ok(cobble(p).every(s => !s.withWood), 'it holds the 3 already')
  p = plan('iron_pickaxe', 1, { bag: { stone_pickaxe: 1 } })
  assert.ok(!labels(p).some(l => /wooden pickaxe/.test(l)))
  assert.ok(cobble(p).every(s => !s.withWood))
})

test('across bags, chests and the owner it never digs more than 3 cobblestone with a wooden pickaxe', () => {
  const bags = [{}, { oak_log: 8 }, { wooden_pickaxe: 1 }, { wooden_pickaxe: 1, cobblestone: 1 }, { cobblestone: 2 }, { cobbled_deepslate: 2, wooden_pickaxe: 1 }, { furnace: 1 }, { raw_iron: 3 }]
  const sources = [{}, { chests: [{ pos: { x: 1, y: 64, z: 0 }, items: bag({ cobblestone: 2, oak_log: 4 }), distance: 5 }] }, { owner: { cobblestone: 1, stick: 2 } }]
  for (const b of bags) {
    for (const src of sources) {
      for (const item of ['stone_pickaxe', 'furnace', 'iron_pickaxe', 'diamond_pickaxe']) {
        const p = plan(item, 1, { bag: b, ...src })
        assert.equal(p.impossible, null)
        const wooden = cobble(p).filter(s => s.withWood).reduce((n, s) => n + s.count, 0)
        assert.ok(wooden <= 3, `${item} from ${JSON.stringify(b)}: ${wooden} with the wooden pickaxe`)
        const k = p.steps.map(s => s.kind === 'craft' ? s.item : s.kind === 'gather' ? `gather ${s.what}${s.withWood ? ' wooden' : ''}` : s.kind)
        const stone = k.indexOf('stone_pickaxe')
        if (stone >= 0) assert.ok(k.slice(stone).every(x => x !== 'gather cobblestone wooden'), 'none after the stone pickaxe')
      }
    }
  }
})

test('a stone pickaxe in a chest is taken instead of making a wooden one', () => {
  const p = plan('iron_pickaxe', 1, { chests: [{ pos: { x: 1, y: 64, z: 0 }, items: bag({ stone_pickaxe: 1, wooden_pickaxe: 1 }), distance: 5 }] })
  assert.deepEqual(p.steps[0].items, [['stone_pickaxe', 1]])
  assert.ok(!labels(p).includes('craft wooden pickaxe'))
})

test('a trip for ore on a stone pickaxe keeps 3 cobblestone for a new one, and only then', () => {
  assert.equal(cobble(plan('iron_pickaxe')).reduce((n, s) => n + s.count, 0), 14, '3 + 8 for the furnace + 3 spare')
  assert.equal(cobble(plan('furnace')).reduce((n, s) => n + s.count, 0), 11, 'no trip for ore, no spare')
  const p = plan('iron_pickaxe', 1, { bag: { stone_pickaxe: 1, furnace: 1, oak_log: 4, wooden_axe: 1 } })
  assert.deepEqual(cobble(p).map(s => s.count), [3])
  assert.ok(labels(p).indexOf('gather 3 cobblestone') < labels(p).indexOf('gather 3 raw iron'))
  assert.equal(cobble(plan('iron_pickaxe', 1, { bag: { stone_pickaxe: 1, furnace: 1, cobblestone: 5, wooden_axe: 1, oak_log: 2 } })).length, 0)
  assert.equal(cobble(plan('diamond', 1, { bag: { iron_pickaxe: 1, wooden_axe: 1 } })).length, 0, 'a stone spare is no use for diamonds')
})

test('the leftover wooden pickaxe never goes back in the hand', () => {
  const { bot } = makeBot()
  bot.give('wooden_pickaxe', 1)
  bot.give('stone_pickaxe', 1)
  assert.equal(bestPickaxeItem(bot.inventory.items()).name, 'stone_pickaxe')
  assert.equal(pickTool(bot, bot.blockAt(new Vec3(0, 40, 0))).item.name, 'stone_pickaxe')
})

// ---------- the axe ----------

test('the axe is made early and before any mining, whatever pickaxe it already has', () => {
  for (const b of [{}, { stone_pickaxe: 1 }, { iron_pickaxe: 1 }]) {
    const l = labels(plan('diamond_pickaxe', 1, { bag: b }))
    const axe = l.indexOf('craft wooden axe to keep')
    assert.ok(axe >= 0, JSON.stringify(b))
    assert.ok(l.slice(0, axe).every(x => !/cobblestone|raw iron|diamonds/.test(x)), l.join(' ; '))
  }
})

test('underground with no tree in sight the axe is skipped and the goal carries on', async () => {
  const { runAxe } = require('../skills/goal_steps')
  const { bot } = makeBot()
  bot.give('iron_pickaxe', 1)
  bot.give('stick', 2)
  const agents = fakeAgents({ noDigMoves: () => ({}) })
  assert.equal(await runAxe({ bot, agents }, { chop: 2 }, { cancelled: false }), 'done')
  assert.equal(bot.countOf('wooden_axe'), 0)
  assert.equal(bot.countOf('stick'), 2, 'the sticks the plan counts on are untouched')
})

test('in a fight it reaches for the axe, over a pickaxe and over a sword that is no better', () => {
  const weapon = inv => {
    const { bot } = makeBot()
    for (const n of inv) bot.give(n, 1)
    return bestWeapon(bot).item?.name
  }
  assert.equal(weapon(['wooden_axe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']), 'wooden_axe')
  assert.equal(weapon(['stone_axe', 'stone_sword']), 'stone_axe')
  assert.equal(weapon(['wooden_axe', 'stone_axe']), 'stone_axe')
  assert.equal(weapon(['wooden_axe', 'diamond_sword']), 'diamond_sword', 'a far better sword still wins')
  assert.equal(weapon(['iron_pickaxe']), 'iron_pickaxe')
})

test('it chops logs with the axe', () => {
  const { bot, world } = makeBot()
  bot.give('stone_pickaxe', 1)
  bot.give('wooden_axe', 1)
  world.set(new Vec3(1, 64, 0), 'oak_log')
  assert.equal(pickTool(bot, bot.blockAt(new Vec3(1, 64, 0))).item.name, 'wooden_axe')
})

test('a hunt swings the axe, and only when it has recharged', async () => {
  const { bot } = makeBot()
  bot.give('iron_sword', 1)
  bot.give('stone_axe', 1)
  const cow = animal(bot, 'cow', 2.5, 0.5)
  let hits = 0
  let tick = 0
  const wait = bot.waitForTicks
  bot.waitForTicks = async n => { tick += n; await wait(n) }
  const at = []
  bot.attack = e => {
    at.push(tick)
    if (++hits === 2) delete bot.entities[e.id]
  }
  assert.equal(await huntOne(bot, cow, { cancelled: false }, () => {}), 'killed')
  assert.equal(bot.heldItem.name, 'stone_axe')
  assert.equal(at[1] - at[0], 25, 'a stone axe recharges in 25 ticks')
})

// ---------- hunting on the way ----------

test('on the way: a close animal in sight, and none that is far, a baby, behind a wall, on another level or not needed', () => {
  const near = () => { const { bot, world } = makeBot(); return { bot, world } }
  let s = near()
  const cow = animal(s.bot, 'cow', 7.5, 0.5)
  assert.equal(animalOnTheWay(s.bot), cow)
  s = near()
  animal(s.bot, 'cow', WAY_RADIUS + 2.5, 0.5)
  assert.equal(animalOnTheWay(s.bot), null, 'too far')
  s = near()
  animal(s.bot, 'cow', 4.5, 0.5, { metadata: { 16: true } })
  assert.equal(animalOnTheWay(s.bot), null, 'a baby')
  s = near()
  s.world.fill3(new Vec3(2, 64, -3), new Vec3(2, 67, 3), 'stone')
  animal(s.bot, 'cow', 5.5, 0.5)
  assert.equal(animalOnTheWay(s.bot), null, 'behind a wall')
  s = near()
  animal(s.bot, 'cow', 4.5, 0.5, { y: s.bot.entity.position.y - 4 })
  assert.equal(animalOnTheWay(s.bot), null, 'down in a hole')
  s = near()
  s.bot.give('cooked_beef', Math.ceil(WAY_RESERVE / 8))
  animal(s.bot, 'cow', 4.5, 0.5)
  assert.equal(animalOnTheWay(s.bot), null, 'the bag holds its reserve')
})

test('on the way: a bag of 16 bread is no reason to walk past a close cow', () => {
  const { bot } = makeBot()
  bot.give('bread', 16)
  const cow = animal(bot, 'cow', 4.5, 0.5)
  assert.equal(animalOnTheWay(bot), cow)
})

test('a hunt that was called off says so, it did not time out', async () => {
  const { bot } = makeBot()
  const cow = animal(bot, 'cow', 4.5, 0.5)
  assert.equal(await huntOne(bot, cow, { cancelled: true }, () => {}), 'cancelled')
})

test('on the way: a walk that is much longer than the line to it does not count', () => {
  const { bot } = makeBot()
  animal(bot, 'cow', 6.5, 0.5)
  bot._agentsWalkOnly = {}  // the walking rules the path search is handed, which this stand-in does not read
  bot.pathfinder.getPathTo = () => ({ status: 'success', path: new Array(30).fill({}) })
  assert.equal(animalOnTheWay(bot), null)
})

test('during a job, not hungry: it steps out for a close cow, and the job gets control back', async () => {
  const { bot, ctx, m, job } = withJob('gather', { bread: 5 })
  armHunting(bot)
  assert.equal(bot.food, 20)
  const cow = animal(bot, 'cow', 5.5, 0.5)
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'resupply')
  for (let i = 0; i < 200 && m.active?.name !== 'gather'; i++) {
    ctx.danger.update()
    m.tick()
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(bot.entities[cow.id], undefined)
  assert.equal(bot.countOf('beef'), 3)
  assert.equal(m.active, job)
})

test('it never hunts on the way during danger, or by stepping out of a craft or a hand over', () => {
  let s = withJob('gather', { bread: 5 })
  animal(s.bot, 'cow', 5.5, 0.5)
  s.bot.entities[77] = { id: 77, type: 'hostile', name: 'zombie', position: new Vec3(4.5, 64, 4.5), height: 1.95, yaw: 0 }
  s.ctx.danger.update()
  assert.equal(s.m.get('resupply').wants(), false, 'a zombie close')
  s = withJob('craft', { bread: 5 })
  s.m.active = s.job
  animal(s.bot, 'cow', 5.5, 0.5)
  s.ctx.danger.update()
  assert.equal(s.m.get('resupply').wants(), false, 'at the crafting table')
})

test('a hunt on the way picks up its drop and is over within seconds, with no stop', async () => {
  const world = new FakeWorld({ groundY: 63 })
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 64, 0.5), dropLag: 3 })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  h.bot.give('wooden_axe', 1)
  await h.until(() => h.bot.entity.onGround, 10)
  const cow = { id: 60, type: 'animal', name: 'cow', position: new Vec3(0.5, 64, 7.5), velocity: new Vec3(0, 0, 0), height: 1.4, metadata: { 9: 10 } }
  h.bot.entities[60] = cow
  let hits = 0
  h.bot.attack = e => {
    if (++hits < 2) return
    delete h.bot.entities[e.id]
    h.bot.entities[61] = { id: 61, name: 'item', position: e.position.offset(0.2, 0.1, 0), drop: 'beef', readyAt: 0, getDroppedItem: () => ({ name: 'beef', count: 1 }) }
  }
  const t = h.report().seconds
  const r = await h.drive(huntOnTheWay(h.bot, cow, { cancelled: false }, () => {}), 300)
  assert.equal(r, 'killed')
  assert.equal(h.bot.countOf('beef'), 1)
  assert.ok(h.report().seconds - t < 6, `took ${h.report().seconds - t} s`)
})

test('an animal that runs off is let go', async () => {
  const { bot } = makeBot()
  const cow = animal(bot, 'cow', 8.5, 0.5)
  const wait = bot.waitForTicks
  bot.waitForTicks = async n => { cow.position.z += 2; await wait(n) }
  assert.equal(await huntOnTheWay(bot, cow, { cancelled: false }, () => {}), 'ran off')
})

// ---------- creepers ----------

test('the blast that ended the live run: a bare bot at full health dies at melee range, one in iron armor does not', () => {
  assert.equal(blastDamage(0), 20)
  assert.equal(blastDamage(15), 16)
  const { bot } = makeBot()
  assert.equal(survivesBlast(bot), false)
  bot.inventory.slots[5] = { name: 'iron_helmet' }
  bot.inventory.slots[6] = { name: 'iron_chestplate' }
  bot.inventory.slots[7] = { name: 'iron_leggings' }
  bot.inventory.slots[8] = { name: 'iron_boots' }
  assert.equal(survivesBlast(bot), true)
})

function creeperAt (z, { armored = false } = {}) {
  const { bot } = makeBot({ groundY: 63 })
  bot.give('bread', 8)
  bot.give('wooden_axe', 1)
  if (armored) Object.assign(bot.inventory.slots, { 5: { name: 'iron_helmet' }, 6: { name: 'iron_chestplate' }, 7: { name: 'iron_leggings' }, 8: { name: 'iron_boots' } })
  const ctx = { bot, agents: fakeAgents() }
  makeModes(ctx)
  const e = { id: 7, type: 'hostile', name: 'creeper', position: new Vec3(0.5, 64, z), height: 1.7, yaw: Math.PI }
  bot.entities[e.id] = e
  return { bot, ctx, e }
}

test('reproduces the live death: a bare bot holding an axe backs away from a creeper instead of handing it to the network', () => {
  const net = sharedMobNet(() => {})
  const saved = net.checked
  net.checked = { ok: true }
  try {
    const bare = creeperAt(5.5)
    let r = bare.ctx.danger.update()
    assert.equal(r.avoid?.entity, bare.e)
    assert.equal(r.fight, null)
    const armored = creeperAt(5.5, { armored: true })
    r = armored.ctx.danger.update()
    assert.equal(r.avoid, null, 'in the armor it trained in, the network takes it')
    assert.equal(r.fight?.entity, armored.e)
  } finally {
    net.checked = saved
  }
})

test('cornered in a tunnel it stops backing off and hits the creeper before the fuse ends', () => {
  const { bot } = makeBot({ groundY: 63 })
  bot.give('bread', 8)
  let t = 1000000
  const a = new DangerAssessor(bot, { friends: new Friends('Owner', ['Agent1']), owner: 'Owner', now: () => t, netFights: () => false })
  const e = { id: 7, type: 'hostile', name: 'creeper', position: new Vec3(0.5, 64, 3), height: 1.7, yaw: Math.PI }
  bot.entities[e.id] = e
  assert.equal(a.update().avoid?.entity, e)
  t += 600
  assert.equal(a.update().avoid?.entity, e, 'a moment to get away first')
  t += 500
  const r = a.update()
  assert.equal(r.avoid, null)
  assert.equal(r.fight?.entity, e)
})

test('after a blast it survives, with the floor gone under it, the miner carries on with no failure', async () => {
  const world = new FakeWorld({ groundY: 62 })
  for (let z = 0; z <= 2; z++) { world.set(new Vec3(0, 16, z), 'air'); world.set(new Vec3(0, 17, z), 'air') }
  world.set(new Vec3(0, 17, 22), 'iron_ore')
  world.set(new Vec3(0, 16, 22), 'iron_ore')
  const h = makePhysicsBot({ world, realSight: true, pos: new Vec3(0.5, 16, 2.5), yaw: Math.PI, dropLag: 3 })
  Object.assign(h.moves, { canDig: true, liquidCost: 50, maxDropDown: 3 })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  h.bot.give('stone_pickaxe', 1)
  h.bot.give('oak_planks', 4)
  h.bot.give('cobblestone', 8)
  await h.until(() => h.bot.entity.onGround, 20)
  const job = { block: 'iron', blocks: ['iron_ore'], count: 2, mined: 0, strategy: 'branch', home: null, store: false, tuning: { branchLen: 0 }, want: 2, inBag: () => h.bot.countOf('raw_iron') }
  const first = { cancelled: false }
  mineJob(h.bot, job, human, first, {}).catch(() => {})
  await h.until(() => h.bot.entity.position.z > 8, 1600)
  first.cancelled = true
  h.bot.pathfinder.setGoal(null)
  try { h.bot.stopDigging() } catch {}
  await h.until(() => false, 4)
  const p = h.bot.entity.position.clone()
  const c = p.offset(0, -0.5, -0.8)
  for (let x = -3; x <= 3; x++) {
    for (let y = -3; y <= 3; y++) {
      for (let z = -3; z <= 3; z++) {
        const q = c.floored().offset(x, y, z)
        if (q.offset(0.5, 0.5, 0.5).distanceTo(c) <= 2.6 && world.name(q) !== 'air') world.set(q, 'air')
      }
    }
  }
  h.bot.entity.velocity.y += 0.45
  h.bot.entity.velocity.z += 0.8
  h.bot.health = 8
  await h.until(() => false, 2)
  const r = await h.drive(mineJob(h.bot, job, human, { cancelled: false }, {}), 6000)
  assert.equal(r.result, 'done', r.message)
  assert.equal(h.bot.countOf('raw_iron'), 2)
  assert.equal(job.stats.stuck, 0)
})

// ---------- food counted as it will be eaten ----------

const withCooking = bot => { bot.give('furnace', 1); bot.give('coal', 2) }

test('raw mutton with a way to cook counts at its cooked value', () => {
  const { bot } = makeBot()
  bot.give('mutton', 5)
  withCooking(bot)
  const s = foodSupply(bot)
  assert.deepEqual([s.ready, s.afterCooking, s.raw, s.total, s.canCook], [0, 30, 0, 30, true])
  assert.equal(foodPointsCarried(bot), 10, 'what it could eat right now is unchanged')
})

test('raw mutton with no furnace, or no fuel, counts at its raw value', () => {
  let { bot } = makeBot()
  bot.give('mutton', 5)
  let s = foodSupply(bot)
  assert.deepEqual([s.ready, s.afterCooking, s.raw, s.total, s.canCook], [0, 0, 10, 10, false])
  bot = makeBot().bot
  bot.give('mutton', 5)
  bot.give('furnace', 1)
  assert.equal(foodSupply(bot).total, 10, 'a furnace and nothing to burn')
})

test('it counts only as many items as the fuel can cook, the biggest gain first', () => {
  const { bot } = makeBot()
  bot.give('mutton', 3)
  bot.give('beef', 1)
  bot.give('furnace', 1)
  bot.give('oak_planks', 1)  // one plank cooks 1.5 items, so 1
  const s = foodSupply(bot)
  assert.equal(s.afterCooking, 8, 'the beef gains 5, mutton 4')
  assert.equal(s.raw, 6)
  assert.equal(s.total, 14)
})

test('raw chicken is worth nothing until it can be cooked', () => {
  let { bot } = makeBot()
  bot.give('chicken', 4)
  assert.equal(foodSupply(bot).total, 0)
  bot = makeBot().bot
  bot.give('chicken', 4)
  withCooking(bot)
  assert.equal(foodSupply(bot).total, 24)
})

test('the chat line keeps ready food and food to cook apart', () => {
  const { bot } = makeBot()
  bot.give('bread', 2)
  bot.give('mutton', 3)
  withCooking(bot)
  assert.equal(supplyText(foodSupply(bot), 24), 'Food: 10 ready + 18 after cooking, want 24')
  const { bot: b2 } = makeBot()
  b2.give('bread', 2)
  b2.give('mutton', 3)
  assert.equal(supplyText(foodSupply(b2), 24), 'Food: 10 ready + 6 raw, want 24')
})

test('the reserve is met by raw mutton it can cook, and not by the same mutton when it cannot', () => {
  const assess = cook => {
    const { bot } = makeBot()
    bot.give('mutton', 5)
    if (cook) withCooking(bot)
    return new DangerAssessor(bot, { friends: new Friends('Owner', ['Agent1']), owner: 'Owner' }).update()
  }
  assert.equal(assess(true).resupply, null)
  const r = assess(false).resupply
  assert.equal(r.carried, 10)
  assert.equal(r.text, 'Food: 0 ready + 10 raw, want 24')
})

test('raw food in the bag is still not a meal: the emergency and the eating rules read the real bag', () => {
  const { bot } = makeBot()
  bot.give('chicken', 4)
  withCooking(bot)
  bot.food = 8
  const r = new DangerAssessor(bot, { friends: new Friends('Owner', ['Agent1']), owner: 'Owner' }).update()
  assert.ok(r.foodEmergency, 'raw chicken is no usable food for the emergency, however much it would cook into')
})

// ---------- never idle for food ----------

test('the reserve is 24, and a job budget no longer adds padding on top of what the trip burns', () => {
  assert.equal(FOOD_RESERVE, 24)
  const { bot } = makeBot()
  assert.ok(foodNeed(bot, 'wood', 4).points < FOOD_RESERVE, 'wood')
  assert.ok(foodNeed(bot, 'cobblestone', 11).points < FOOD_RESERVE, 'cobblestone')
  assert.ok(foodNeed(bot, 'diamond', 3).points > FOOD_RESERVE, 'a deep trip really burns more')
})

test('short of food with nothing in sight, the job keeps control and keeps working', () => {
  for (const name of ['gather', 'craft', 'mine']) {
    const { ctx, m, job } = withJob(name)
    assert.ok(ctx.danger.report.resupply, 'the bag is short')
    for (let i = 0; i < 5; i++) {
      ctx.danger.update()
      m.tick()
      assert.equal(m.active, job, name)
    }
  }
})

test('with no job at all it still goes for the food the reserve lacks', () => {
  const { bot } = makeBot()
  const ctx = { bot, agents: fakeAgents() }
  const m = makeModes(ctx)
  ctx.danger.update()
  assert.equal(m.get('resupply').wants(), true)
})

test('a food run from before the order gives way to the order at once', () => {
  const { bot } = makeBot()
  const ctx = { bot, agents: fakeAgents() }
  const m = makeModes(ctx)
  ctx.danger.update()
  const resupply = m.get('resupply')
  resupply.token = { cancelled: false }
  resupply.fullRun = true
  assert.equal(resupply.wants(), true, 'no job yet, it carries on')
  m.get('gather').start({ kind: 'wood', count: 1 })
  assert.equal(resupply.wants(), false)
  resupply.fullRun = false
  assert.equal(resupply.wants(), true, 'a hunt on the way finishes its animal')
  resupply.token = null
})

test('a real food emergency still outranks the job', () => {
  const { bot, ctx, m } = withJob('gather')
  bot.food = 8
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'findfood')
  m.stopNow()
})

// ---------- the check before a long dig ----------

function digSetup ({ inv = {}, food = 20, y = 64, searchMs = 0, maxMs = 0 } = {}) {
  const { bot, world } = makeBot({ groundY: y - 1 })
  for (const [n, c] of Object.entries(inv)) bot.give(n, c)
  bot.food = food
  const agents = fakeAgents({ digSearchMs: searchMs, digSearchMaxMs: maxMs })
  const ctx = { bot, agents }
  makeModes(ctx)
  ctx.foodJob = { mode: 'gather', need: 0, home: bot.entity.position.clone() }
  ctx.danger.update()
  return { bot, world, agents, ctx }
}
const told = (agents, re) => agents.events.some(e => re.test(e.text))

test('before a long dig with enough food it just goes', async () => {
  const { ctx, agents } = digSetup({ inv: { bread: 5 } })
  const task = {}
  assert.equal(await foodBeforeLongDig(ctx, task, 'iron', { cancelled: false }), true)
  assert.equal(task.foodChecked, true)
  assert.equal(agents.events.length, 0)
})

test('raw mutton it can cook counts as enough for the dig', async () => {
  const { ctx, agents } = digSetup({ inv: { mutton: 5, furnace: 1, coal: 2 } })
  assert.equal(await foodBeforeLongDig(ctx, {}, 'iron', { cancelled: false }), true)
  assert.equal(told(agents, /Looking for food/), false)
})

test('under the reserve it hunts on the surface first, says so, then goes down', async () => {
  const { bot, ctx, agents } = digSetup({ searchMs: 5000, maxMs: 10000 })
  armHunting(bot, { cow: { cooked_beef: 3 } })
  animal(bot, 'cow', 12.5, 0.5)
  const task = {}
  assert.equal(await foodBeforeLongDig(ctx, task, 'iron', { cancelled: false }), true)
  assert.equal(bot.countOf('cooked_beef'), 3)
  assert.ok(told(agents, /Food: 0 ready, want 24\. Looking for food up here before the long dig/))
  assert.ok(told(agents, /Enough, going down/))
})

test('when the search runs out it goes down with the safe minimum', async () => {
  // 2 bread is 10 points, and a full bar has 14 above the sprint limit: 24 against about 20 for the way home
  const { ctx, agents } = digSetup({ inv: { bread: 2 } })
  assert.equal(await foodBeforeLongDig(ctx, {}, 'iron', { cancelled: false }), true)
  assert.ok(told(agents, /covers the way back, going down/))
  assert.equal(ctx.foodJob.waived, undefined, 'its turn back rule stays on')
})

test('with less than the minimum and nothing to find, it goes on its food bar at the hard limit and does not bounce back up', async () => {
  const { ctx, agents } = digSetup({ inv: {} })
  assert.equal(await foodBeforeLongDig(ctx, {}, 'iron', { cancelled: false }), true)
  assert.ok(told(agents, /going down on my food bar/))
  assert.equal(ctx.foodJob.waived, true)
})

test('under the minimum it keeps searching past the first limit, and a meal found then ends the search', async () => {
  const { bot, ctx, agents } = digSetup({ searchMs: 0, maxMs: 60000 })
  armHunting(bot, { cow: { cooked_beef: 3 } })
  const goto = bot.pathfinder.goto
  let legs = 0
  bot.pathfinder.goto = async g => {
    await goto(g)
    if (++legs === 2) animal(bot, 'cow', bot.entity.position.x + 4, bot.entity.position.z)
  }
  assert.equal(await foodBeforeLongDig(ctx, {}, 'iron', { cancelled: false }), true)
  assert.ok(legs >= 2, 'it walked instead of standing still')
  assert.equal(bot.countOf('cooked_beef'), 3)
  assert.ok(told(agents, /Enough, going down/))
})

test('a short way down needs no search, and a search a fight cut short carries on', async () => {
  const shallow = digSetup({ y: 22 })
  shallow.bot.entity.position.y = 16
  const t = {}
  assert.equal(await foodBeforeLongDig(shallow.ctx, t, 'iron', { cancelled: false }), true)
  assert.equal(t.foodChecked, true)
  assert.equal(shallow.agents.events.length, 0)
  const s = digSetup({ searchMs: 5000, maxMs: 10000 })
  const task = {}
  assert.equal(await foodBeforeLongDig(s.ctx, task, 'iron', { cancelled: true }), false)
  assert.ok(!task.foodChecked, 'it looks again when the job resumes')
})

// ---------- who fights a creeper once the assessor has marked it for a fight (cornered, or it kept following) ----------

function fighterChoice (name, { armored = false } = {}) {
  const s = creeperAt(2.5, { armored })
  s.e.name = name
  const calls = []
  s.bot.agentsMobFight = { start: (t, o) => { calls.push(o.useNet); return Promise.resolve('stopped') }, stop () {} }
  const mode = s.ctx.manager.get('mobfight')
  mode.focus = s.e
  mode.update()
  return calls
}

test('a bare bot with an axe, cornered by a creeper, fights it scripted and not with the network', () => {
  assert.deepEqual(fighterChoice('creeper'), [false])
})

test('the same bot in armor that outlasts the blast still gives the creeper to the network', () => {
  assert.deepEqual(fighterChoice('creeper', { armored: true }), [true])
})

test('a bare bot still gives every other mob to the network', () => {
  assert.deepEqual(fighterChoice('zombie'), [true])
})

test('a bare bot cornered by a swelling creeper backs away from it on the real fighter', async () => {
  const { goals: pathGoals } = require('mineflayer-pathfinder')
  const { bot, ctx, e } = creeperAt(2.5)
  e.metadata = { 16: 1, 9: 20 }
  bot.attack = () => assert.fail('no swing at a swelling creeper')
  const net = sharedMobNet(() => {})
  const saved = net.checked
  net.checked = { ok: true }
  const mode = ctx.manager.get('mobfight')
  try {
    mode.focus = e
    mode.update()
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve))
    assert.ok(bot.pathfinder.goal instanceof pathGoals.GoalInvert, 'keeps away from the fuse')
  } finally {
    mode.exit()
    net.checked = saved
  }
})
