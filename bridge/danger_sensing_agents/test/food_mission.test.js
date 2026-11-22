// The food emergency and the food mission on the fake world (test/mockbot.js), no server needed.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { makeBot, registry } = require('./mockbot')
const { Friends } = require('../targets')
const { makeModes } = require('../behaviors')
const { FOOD_EMERGENCY, FOOD_RECOVERED, SPRINT_FOOD } = require('../skills/food_plan')
const { foodMission, searchMoves, chestWants, nextRing, underCover, skyLevel, RING_STEP, MAX_RING } = require('../skills/food_mission')
const { foods, eat, restockFood, huntOne, animalsNear, foodPointsCarried } = require('../skills/food')

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

let nextId = 500
function animal (bot, name, x, z, { hp = 8, y = null, metadata = {} } = {}) {
  const e = { id: nextId++, type: 'animal', name, position: new Vec3(x, y ?? bot.entity.position.y, z), height: 1, metadata: { 9: hp, ...metadata } }
  bot.entities[e.id] = e
  return e
}

function zombie (bot, dx, dz) {
  const p = bot.entity.position
  const e = { id: nextId++, type: 'hostile', name: 'zombie', position: new Vec3(p.x + dx, p.y, p.z + dz), height: 1.95, metadata: { 9: 20 } }
  bot.entities[e.id] = e
  return e
}

// A walking fake: a follow goal puts the bot next to its target, and a hit kills the animal and hands over its drops
function armHunting (bot, drops = { cow: { beef: 3 }, sheep: { mutton: 2 }, pig: { porkchop: 2 }, chicken: { chicken: 1 } }) {
  const setGoal = bot.pathfinder.setGoal
  bot.pathfinder.setGoal = g => {
    setGoal(g)
    const target = g?.entity
    if (target && !(g instanceof goals.GoalInvert) && bot.entities[target.id]) {
      bot.entity.position = target.position.offset(1, 0, 0)
    }
  }
  bot.attack = e => {
    delete bot.entities[e.id]
    for (const [name, n] of Object.entries(drops[e.name] || {})) bot.give(name, n)
  }
}

// Ticks the assessor and the manager like the agents do, until done() or the limit
async function run (ctx, done, ms = 5000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    ctx.danger.update()
    ctx.manager.tick()
    if (done()) return true
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  return false
}

const said = (agents, re) => agents.events.some(e => re.test(e.text))

function job () {
  const { bot, world } = makeBot()
  const agents = fakeAgents()
  const ctx = { bot, agents }
  const m = makeModes(ctx)
  m.byName.delete('gather')
  return { bot, world, agents, ctx, m }
}

// A craft job that stays on with nothing in the bag: the job that gets interrupted
function startJob (m) {
  m.get('craft').request({ item: 'stone_pickaxe', requester: 'Owner' })
}

// ---------- entering and leaving ----------

test('the thresholds follow the game: above the no sprint level, and it ends where hunger ends', () => {
  assert.equal(SPRINT_FOOD, 6)
  assert.equal(FOOD_EMERGENCY, 10)
  assert.equal(FOOD_RECOVERED, 14)
  // the 4 points above the sprint floor buy 160 m of sprinting at 0.1 exhaustion a meter and 4 exhaustion a point
  assert.equal((FOOD_EMERGENCY - SPRINT_FOOD) * 4 / 0.1, 160)
})

test('the emergency starts only with no usable food and the bar at 10 or less, and lasts until 14', () => {
  const { bot, ctx } = job()
  bot.food = 11
  assert.equal(ctx.danger.update().foodEmergency, null, '11 is not low enough')
  bot.food = 10
  assert.ok(ctx.danger.update().foodEmergency, 'empty bag at 10')
  assert.match(ctx.danger.summary(), /no food findfood/)
  bot.food = 13
  assert.ok(ctx.danger.update().foodEmergency, 'still on at 13')
  bot.food = 14
  assert.equal(ctx.danger.update().foodEmergency, null, 'over at 14')
  bot.food = 12
  assert.equal(ctx.danger.update().foodEmergency, null, 'does not come back above 10')

  const q = job()
  q.bot.food = 5
  q.bot.give('beef', 1)
  assert.equal(q.ctx.danger.update().foodEmergency, null, 'raw meat is usable food')
  q.bot.take('beef', 1)
  q.bot.give('rotten_flesh', 3)
  assert.ok(q.ctx.danger.update().foodEmergency, 'rotten flesh is not')
})

test('a death ends the emergency without saying it recovered', () => {
  const { bot, agents, ctx, m } = job()
  bot.food = 4
  ctx.danger.update()
  m.get('findfood').watch()
  assert.ok(said(agents, /Out of food with my bar at 4/))
  ctx.danger.reset()
  bot.food = 20
  ctx.danger.update()
  m.get('findfood').watch()
  assert.equal(said(agents, /Recovered/), false)
})

// ---------- priority ----------

test('finding food outranks every job, the job waits and comes back after', async () => {
  const { bot, agents, ctx, m } = job()
  armHunting(bot)
  ctx.restocking = true  // keeps the ordinary food run out of this test, the bag is empty on purpose
  startJob(m)
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'craft')
  bot.food = 8
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'findfood')
  assert.equal(m.get('craft').on, true, 'the job is paused, not ended')
  assert.ok(said(agents, /Out of food with my bar at 8, finding food comes first/))
  animal(bot, 'cow', 4.5, 0.5)
  assert.ok(await run(ctx, () => bot.food >= FOOD_RECOVERED), 'it found food and ate')
  m.get('craft').job.phase = 'run'  // it has work again once the mission lets go
  assert.ok(await run(ctx, () => m.active?.name === 'craft'), 'the job took over again')
  assert.ok(said(agents, /Recovered, my food bar is at/))
  m.stopNow()
})

test('mobs outrank the mission, and the mission picks up again once the mob is gone', async () => {
  const { bot, ctx, m } = job()
  bot.food = 8
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'findfood')
  const z = zombie(bot, 0, 2)
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'mobfight')
  delete bot.entities[z.id]
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'findfood')
  m.stopNow()
})

test('a creeper, a flee and lava all outrank the mission', () => {
  const { bot, ctx, m } = job()
  bot.food = 8
  const c = { id: nextId++, type: 'hostile', name: 'creeper', position: bot.entity.position.offset(0, 0, 3), height: 1.7, metadata: {} }
  bot.entities[c.id] = c
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'avoid')
  delete bot.entities[c.id]
  const w = { id: nextId++, type: 'hostile', name: 'warden', position: bot.entity.position.offset(0, 0, 12), height: 2.9, metadata: {} }
  bot.entities[w.id] = w
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'retreat')
  delete bot.entities[w.id]
  bot.entity.isInLava = true
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'escape')
  bot.entity.isInLava = false
  m.stopNow()
})

test('kill and guard orders wait during the emergency and stay on, and a flee still works with a kill order on', () => {
  const { bot, ctx, m } = job()
  const enemy = zombie(bot, 0, 20)
  m.setOn('kill', { radius: 32 })
  m.setOn('guard', { radius: 32 })
  ctx.danger.update()
  assert.equal(m.get('kill').wants(), true)
  bot.food = 6
  ctx.danger.update()
  assert.equal(m.get('kill').wants(), false, 'food first')
  assert.equal(m.get('guard').wants(), false, 'food first')
  assert.equal(m.get('kill').on, true)
  assert.equal(m.get('guard').on, true)
  delete bot.entities[enemy.id]
  const w = { id: nextId++, type: 'hostile', name: 'warden', position: bot.entity.position.offset(0, 0, 12), height: 2.9, metadata: {} }
  bot.entities[w.id] = w
  ctx.danger.update()
  assert.equal(m.get('retreat').wants(), true, 'running from a warden is not an order that waits')
  m.setOff('kill')
  m.setOff('guard')
})

test('!stay keeps it put and says why, !stop holds it for a minute', async () => {
  const { bot, agents, ctx, m } = job()
  bot.food = 5
  ctx.staying = true
  ctx.danger.update()
  m.tick()
  assert.notEqual(m.active?.name, 'findfood')
  assert.ok(said(agents, /staying here as told/))
  assert.equal(m.get('resupply').wants(), false)
  ctx.staying = false
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'findfood')
  m.stopNow()
  assert.ok(said(agents, /I will look again in a minute/))
  ctx.danger.update()
  m.tick()
  assert.notEqual(m.active?.name, 'findfood', 'a stop wins')
  assert.equal(m.get('resupply').wants(), false, 'no food run either')
  ctx.foodHoldUntil = 0
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'findfood')
  m.stopNow()
})

// ---------- the mission ----------

// The mission alone: recovered once the bar is back, with the walks it made kept in steps
function mission (bot, extra = {}) {
  const steps = []
  return {
    steps,
    hooks: {
      recovered: () => bot.food >= FOOD_RECOVERED,
      step: (j, text) => steps.push(text),
      log: () => {},
      farms: () => [],
      home: null,
      moves: { walk: { name: 'noDig', allowSprinting: true }, build: { name: 'build' } },
      rescue: () => ({ name: 'rescue' }),
      work: {},
      ...extra
    }
  }
}

test('no animals near: it walks out ring by ring until one comes into sight, hunts it, eats and is done', async () => {
  const { bot } = makeBot()
  armHunting(bot)
  bot.food = 6
  const start = bot.entity.position.clone()
  const token = { cancelled: false }
  const j = {}
  const { steps, hooks } = mission(bot)
  let far = null
  const goto = bot.pathfinder.goto
  bot.pathfinder.goto = async g => {
    await goto(g)
    // a cow waits out past the first ring, it shows up when the bot gets near
    if (!far && bot.entity.position.distanceTo(start) > RING_STEP - 6) far = animal(bot, 'cow', bot.entity.position.x + 12, bot.entity.position.z)
  }
  const r = await foodMission(bot, j, token, hooks)
  assert.equal(r, 'recovered')
  assert.ok(far, 'it walked out to the ring')
  assert.equal(bot.entities[far.id], undefined, 'the cow was hunted')
  assert.ok(bot.food >= FOOD_RECOVERED)
  assert.ok(steps.some(s => /searching 48 blocks out/.test(s)), steps.join(' | '))
  assert.ok(steps.some(s => /Hunting a cow/.test(s)))
  assert.equal(j.stats.hunted, 1)
})

test('the search walks: no sprint, no parkour, no digging, short drops, and the job\'s own walking rules stay as they were', () => {
  const { bot } = makeBot()
  const base = { name: 'noDig', allowSprinting: true, allowParkour: true, canDig: true, maxDropDown: 4, liquidCost: 1 }
  const m = searchMoves(bot, base)
  assert.equal(m.allowSprinting, false)
  assert.equal(m.allowParkour, false)
  assert.equal(m.canDig, false)
  assert.equal(m.maxDropDown, 3)
  assert.equal(m.liquidCost, 50)
  assert.equal(base.allowSprinting, true)
  assert.equal(base.canDig, true)
})

test('rings grow outward from the start and start over from where it stands past the last', () => {
  const { bot } = makeBot()
  const job = { center: new Vec3(0, 64, 0), ring: 0, waypoints: [], index: 0, stats: { rings: 0 } }
  nextRing(bot, job)
  assert.equal(job.ring, RING_STEP)
  assert.ok(job.waypoints.length >= 6)
  for (const p of job.waypoints) assert.ok(Math.abs(Math.hypot(p.x, p.z) - RING_STEP) <= 2, `${p}`)
  nextRing(bot, job)
  assert.equal(job.ring, RING_STEP * 2)
  for (const p of job.waypoints) assert.ok(Math.abs(Math.hypot(p.x, p.z) - RING_STEP * 2) <= 2, `${p}`)
  job.ring = MAX_RING
  bot.entity.position = new Vec3(200.5, 64, 300.5)
  nextRing(bot, job)
  assert.equal(job.ring, RING_STEP)
  assert.equal(job.center.x, 200.5)
})

test('an animal it cannot reach is given up quickly and not hunted again, the search goes on', async () => {
  const { bot } = makeBot()
  bot.food = 6
  const stuck = animal(bot, 'sheep', 12.5, 0.5)  // the fake pathfinder never brings it closer
  const r = await huntOne(bot, stuck, { cancelled: false }, () => {})
  assert.equal(r, 'could not get closer')

  const q = makeBot().bot
  q.food = 6
  armHunting(q)
  const unreachable = animal(q, 'sheep', 12.5, 0.5)
  const setGoal = q.pathfinder.setGoal
  let chases = 0
  q.pathfinder.setGoal = g => { if (g?.entity === unreachable) chases++; else setGoal(g) }
  const token = { cancelled: false }
  const j = {}
  const { hooks } = mission(q)
  let legs = 0
  const goto = q.pathfinder.goto
  q.pathfinder.goto = async g => {
    await goto(g)
    if (++legs === 3) animal(q, 'cow', q.entity?.position?.x ?? q.entity.position.x + 2, q.entity.position.z + 2)
  }
  const done = await foodMission(q, j, token, hooks)
  assert.equal(done, 'recovered')
  assert.equal(chases, 1, 'one try at the sheep it cannot reach')
  assert.ok(q.entities[unreachable.id], 'the sheep is still there')
})

test('it cooks raw meat when it can before eating, and takes one raw bite only at 1, then cooks the rest', async () => {
  const { bot } = makeBot()
  bot.food = 6
  bot.give('beef', 2)
  bot.give('coal', 1)
  bot.give('furnace', 1)
  bot.give('stone_pickaxe', 1)
  const { hooks } = mission(bot)
  assert.equal(await foodMission(bot, {}, { cancelled: false }, hooks), 'recovered')
  assert.equal(bot.food, 14, 'one steak took it from 6 to 14')
  assert.equal(bot.countOf('cooked_beef'), 1)
  assert.equal(bot.countOf('beef'), 0)

  // at 2 the game has not started to hurt it and waiting at a furnace burns nothing, so the beef still gets cooked
  const w = makeBot().bot
  w.food = 2
  w.give('beef', 4)
  w.give('coal', 1)
  w.give('furnace', 1)
  w.give('stone_pickaxe', 1)
  assert.equal(await foodMission(w, {}, { cancelled: false }, mission(w).hooks), 'recovered')
  assert.equal(w.countOf('beef'), 0, 'all four went in the furnace')
  assert.equal(w.countOf('cooked_beef'), 2, 'two steaks took it from 2 to 18')
  assert.equal(w.food, 18)

  const q = makeBot().bot
  q.food = 1
  q.give('beef', 4)
  q.give('coal', 1)
  q.give('furnace', 1)
  q.give('stone_pickaxe', 1)
  const h = mission(q).hooks
  assert.equal(await foodMission(q, {}, { cancelled: false }, h), 'recovered')
  assert.equal(q.countOf('beef'), 0)
  assert.equal(q.countOf('cooked_beef'), 1, 'one raw bite at 1, the other 3 cooked, two steaks eaten')
  assert.equal(q.food, 20, 'from 1 to 4 raw, then 12 and 20 on steak')
})

test('rotten flesh is the last resort: eaten at 6 or less, kept above that while it searches on', async () => {
  const { bot } = makeBot()
  bot.food = 6
  bot.give('rotten_flesh', 2)
  const token = { cancelled: false }
  const { steps, hooks } = mission(bot)
  const goto = bot.pathfinder.goto
  bot.pathfinder.goto = async g => {
    await goto(g)
    token.cancelled = true  // the first search leg: it has stopped eating by now
  }
  assert.equal(await foodMission(bot, {}, token, hooks), 'cancelled')
  assert.equal(bot.food, 10, 'one piece took it above 6')
  assert.equal(bot.countOf('rotten_flesh'), 1, 'the other is kept')
  assert.ok(steps.some(s => /rotten flesh/.test(s)))
})

test('a chest in sight: it takes food and only food, no more than it needs, and looks in each chest once', async () => {
  const { bot, world } = makeBot()
  bot.food = 6
  const pos = new Vec3(3, 64, 0)
  world.fillChest(pos, [['diamond', 5], ['bread', 20], ['rotten_flesh', 8]])
  const { hooks } = mission(bot)
  assert.equal(await foodMission(bot, {}, { cancelled: false }, hooks), 'recovered')
  assert.equal(bot.countOf('diamond'), 0, 'the diamonds stay')
  assert.equal(bot.countOf('rotten_flesh'), 0)
  assert.ok(bot.countOf('bread') + 2 <= 5, 'took 5 loaves at most')
  const wants = chestWants(bot, new Map([['bread', 20], ['cooked_beef', 2], ['spider_eye', 4], ['stone', 9]]))
  assert.equal(wants.get('cooked_beef'), 2)
  assert.equal(wants.get('bread'), 2, '16 points of steak, then 2 loaves to reach 24')
  assert.equal(wants.has('spider_eye'), false)
  assert.equal(wants.has('stone'), false)
})

test('an empty chest is not looked in again on every pass', async () => {
  const { bot, world } = makeBot()
  armHunting(bot)
  bot.food = 6
  const pos = new Vec3(3, 64, 0)
  world.fillChest(pos, [['stone', 1]])
  let opens = 0
  const open = bot.openContainer
  bot.openContainer = async b => { opens++; return open(b) }
  const { hooks } = mission(bot)
  let legs = 0
  const goto = bot.pathfinder.goto
  bot.pathfinder.goto = async g => {
    await goto(g)
    if (++legs === 4) animal(bot, 'cow', bot.entity.position.x + 2, bot.entity.position.z + 2)
  }
  assert.equal(await foodMission(bot, {}, { cancelled: false }, hooks), 'recovered')
  assert.equal(opens, 1)
})

test('underground it heads back up to where the job started before it searches', async () => {
  const { bot, world } = makeBot()
  world.fill3(new Vec3(-3, 40, -3), new Vec3(3, 42, 3), 'air')
  bot.entity.position = new Vec3(0.5, 40, 0.5)
  assert.equal(underCover(bot), true)
  bot.food = 6
  armHunting(bot)
  const home = new Vec3(10, 64, 10)
  const { steps, hooks } = mission(bot, { home })
  const goto = bot.pathfinder.goto
  let up = false
  bot.pathfinder.goto = async g => {
    if (g.x === home.x && g.z === home.z) {
      bot.entity.position = new Vec3(10.5, 64, 10.5)
      up = true
      animal(bot, 'cow', 13.5, 10.5)
      return
    }
    await goto(g)
  }
  assert.equal(await foodMission(bot, {}, { cancelled: false }, hooks), 'recovered')
  assert.ok(up, 'walked home first')
  assert.ok(steps.some(s => /heading up/.test(s)))
})

test('a hunt cut short leaves the goal of the mode that took over alone', async () => {
  const { bot } = makeBot()
  const cow = animal(bot, 'cow', 12.5, 0.5)
  const token = { cancelled: false }
  const hunt = huntOne(bot, cow, token, () => {})
  await new Promise(resolve => setImmediate(resolve))
  const flee = new goals.GoalInvert(new goals.GoalFollow(cow, 10))
  token.cancelled = true
  bot.pathfinder.setGoal(flee)  // what a retreat does the moment it gets control
  await hunt
  assert.equal(bot.pathfinder.goal, flee)
})

test('under trees is not underground, and neither is the Nether, and the way up ignores trees', () => {
  const { bot, world } = makeBot()
  assert.equal(underCover(bot), false, 'open sky')
  const realGet = world.get.bind(world)
  world.get = p => { const b = realGet(p); b.skyLight = 9; return b }
  assert.equal(underCover(bot), false, 'a canopy dims the light, it does not take it away')
  world.get = p => { const b = realGet(p); b.skyLight = 0; return b }
  assert.equal(underCover(bot), true, 'no sky light at all')
  bot.game.dimension = 'the_nether'
  assert.equal(underCover(bot), false, 'no sky to climb to')
  delete bot.game.dimension
  world.get = realGet
  world.fill3(new Vec3(0, 70, 0), new Vec3(0, 72, 0), 'oak_leaves')
  world.set(new Vec3(0, 68, 0), 'stone')
  assert.equal(skyLevel(bot), 69)
})

test('a cancelled mission stops and keeps its progress for the next run', async () => {
  const { bot } = makeBot()
  bot.food = 6
  const token = { cancelled: false }
  const j = {}
  const { hooks } = mission(bot)
  const goto = bot.pathfinder.goto
  let legs = 0
  bot.pathfinder.goto = async g => {
    await goto(g)
    if (++legs === 3) token.cancelled = true
  }
  assert.equal(await foodMission(bot, j, token, hooks), 'cancelled')
  const at = j.index
  assert.ok(at >= 1, 'it had walked part of the ring')
  bot.pathfinder.goto = goto
  bot.give('bread', 2)
  assert.equal(await foodMission(bot, j, { cancelled: false }, hooks), 'recovered')
  assert.equal(j.index, at, 'the same search, not a new one')
})

// ---------- animals on the way during a normal job ----------

test('an animal met on the way during a job: only that hunt, no walk to the farm', async () => {
  const { bot, agents, ctx, m } = job()
  armHunting(bot)
  let farmsAsked = 0
  agents.farms = () => { farmsAsked++; return [] }
  ctx.foodJob = { mode: 'mine', need: 50, home: new Vec3(0.5, 64, 60.5) }
  bot.food = 20
  ctx.danger.update()
  const resupply = m.get('resupply')
  assert.equal(resupply.wants(), false, 'away from the start, nothing in sight')
  animal(bot, 'sheep', 3.5, 3.5)
  assert.equal(resupply.wants(), true)
  assert.ok(resupply.close, 'that animal only')
  const r = await resupply.run({ cancelled: false })
  assert.equal(r, 'short')
  assert.equal(bot.countOf('mutton'), 2)
  assert.equal(farmsAsked, 0, 'the farm is not part of a hunt on the way')
  assert.equal(resupply.retryAt, 0, 'the next full food run keeps its time')
})

test('hunting on the way leaves animals behind a wall alone', async () => {
  const { bot, world } = makeBot()
  world.fill3(new Vec3(3, 64, -3), new Vec3(3, 67, 3), 'stone')
  const hidden = animal(bot, 'cow', 6.5, 0.5)
  assert.equal(animalsNear(bot, 24).includes(hidden), true)
  assert.equal(animalsNear(bot, 24, { sight: true }).includes(hidden), false)
  assert.equal(foodPointsCarried(bot), 0)
  assert.ok(registry.foodsByName.mutton)
})

// ---------- food it must not eat ----------

test('ordinary hunger never eats golden food or raw chicken, and picks what else it has', async () => {
  const { bot } = makeBot()
  for (const name of ['golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'chicken', 'rotten_flesh', 'spider_eye']) bot.give(name, 2)
  assert.deepEqual(foods(bot), [], 'none of it counts as food')
  assert.equal(foodPointsCarried(bot), 0)
  bot.food = 5
  assert.equal(await eat(bot, { cancelled: false }), 0)
  assert.equal(bot.food, 5)
  bot.give('bread', 3)
  assert.deepEqual(foods(bot).map(x => x.item.name), ['bread'])
  await eat(bot, { cancelled: false })
  for (const name of ['golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'chicken']) assert.equal(bot.countOf(name), 2, name)
})

test('a food mission leaves golden food in the bag and in the chest', async () => {
  const { bot, world } = makeBot()
  bot.food = 3
  bot.give('golden_apple', 2)
  bot.give('enchanted_golden_apple', 1)
  const wants = chestWants(bot, new Map([['golden_apple', 4], ['enchanted_golden_apple', 1], ['golden_carrot', 8], ['chicken', 5], ['bread', 3]]))
  assert.deepEqual([...wants.keys()], ['bread'])
  world.fillChest(new Vec3(3, 64, 0), [['golden_apple', 4], ['bread', 20]])
  assert.equal(await foodMission(bot, {}, { cancelled: false }, mission(bot).hooks), 'recovered')
  assert.equal(bot.countOf('golden_apple'), 2, 'none eaten, none taken')
  assert.equal(bot.countOf('enchanted_golden_apple'), 1)
})

test('raw chicken in an emergency: the furnace first, eaten raw only at 6 or less, and before rotten flesh', async () => {
  const c = makeBot().bot
  c.food = 8
  c.give('chicken', 2)
  c.give('coal', 1)
  c.give('furnace', 1)
  c.give('stone_pickaxe', 1)
  assert.equal(await foodMission(c, {}, { cancelled: false }, mission(c).hooks), 'recovered')
  assert.equal(c.countOf('chicken'), 0, 'both cooked')
  assert.ok(c.countOf('cooked_chicken') < 2, 'and eaten')

  const { bot } = makeBot()
  bot.food = 7
  bot.give('chicken', 1)
  bot.give('rotten_flesh', 1)
  const token = { cancelled: false }
  const { steps, hooks } = mission(bot)
  const goto = bot.pathfinder.goto
  bot.pathfinder.goto = async g => {
    await goto(g)
    if (bot.food === 7) bot.food = 6   // it searched on at 7, and the walk wore the bar down
    else token.cancelled = true
  }
  assert.equal(await foodMission(bot, {}, token, hooks), 'cancelled')
  assert.equal(bot.countOf('chicken'), 0, 'eaten at 6')
  assert.equal(bot.food, 8)
  assert.equal(bot.countOf('rotten_flesh'), 1, 'the chicken took it above 6, so the rotten flesh is kept')
  assert.ok(steps.some(s => /eating raw chicken/.test(s)), steps.join(' | '))
  assert.ok(!steps.some(s => /rotten flesh/.test(s)), steps.join(' | '))
})

test('a food run does not stop because a hunt only brought raw chicken', async () => {
  const { bot } = makeBot()
  armHunting(bot)
  bot.give('coal', 2)
  bot.give('furnace', 1)
  bot.give('stone_pickaxe', 1)
  const p = bot.entity.position
  for (let i = 0; i < 4; i++) animal(bot, 'chicken', p.x + 3 + i, p.z + 2)
  const have = await restockFood(bot, { cancelled: false }, { want: 20, rounds: 3 })
  assert.ok(bot.countOf('cooked_chicken') >= 4, `cooked ${bot.countOf('cooked_chicken')}`)
  assert.equal(have, foodPointsCarried(bot))
})
