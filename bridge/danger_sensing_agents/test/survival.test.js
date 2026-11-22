// Survival on the fake world (test/mockbot.js), no server needed: the mob fighter and its mode, the food plan,
// eating while safe, hunting and cooking.   node --test bridge/danger_sensing_agents/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { makeBot, registry } = require('./mockbot')
const { Friends } = require('../targets')
const { makeModes } = require('../behaviors')
const { FOOD_RESERVE } = require('../threats')
const { mobFight, bestWeapon, MobFighter } = require('../skills/mob_fight')
const { foodNeed, returnFood, eatReason, pickTopUp } = require('../skills/food_plan')
const { foods, eat, restockFood, animalsNear, foodPointsCarried } = require('../skills/food')
const { cookFood, cookCheck, fuelFor } = require('../skills/cook')

const Item = require('prismarine-item')(registry)

function fakeAgents (extra = {}) {
  const events = []
  return {
    owner: 'Owner',
    friends: new Friends('Owner', ['Agent1']),
    log: () => {},
    events,
    event: (bot, level, key, text) => events.push(text),
    say: () => {},
    stopAll: () => {},
    profileChanged: () => {},
    farms: () => [],
    noDigMoves: () => ({}),
    digMoves: () => ({}),
    buildMoves: () => ({}),
    kits: 0,
    ensureKit: async function () { this.kits++ },
    ...extra
  }
}

let nextId = 100
function mob (bot, name, dx, dz, { hp = 20, type = 'hostile', metadata = {} } = {}) {
  const p = bot.entity.position
  const e = { id: nextId++, type, name, position: new Vec3(p.x + dx, p.y, p.z + dz), height: name === 'chicken' ? 0.7 : 1.95, metadata: { 9: hp, ...metadata } }
  bot.entities[e.id] = e
  return e
}

// bot.attack takes damage off the target at once and removes it when it dies, recording the tick of every swing
function armAttacks (bot, { drops = {} } = {}) {
  const swings = []
  bot.attack = (e, dmg) => {
    swings.push({ id: e.id, tick: bot.ticks })
    const weapon = bestWeapon(bot)
    e.metadata[9] -= dmg ?? weapon.damage
    if (e.metadata[9] <= 0) {
      delete bot.entities[e.id]
      for (const [name, n] of Object.entries(drops[e.name] || {})) bot.give(name, n)
    }
  }
  return swings
}

// ---------- the mob fighter ----------

test('the mob fighter picks the most damage per second it carries, its fist with nothing', () => {
  const { bot } = makeBot()
  assert.equal(bestWeapon(bot).item, null)
  assert.equal(bestWeapon(bot).cooldown, 5)
  bot.give('diamond_pickaxe', 1)
  bot.give('iron_axe', 1)
  assert.equal(bestWeapon(bot).item.name, 'iron_axe')
  bot.give('diamond_sword', 1)
  const w = bestWeapon(bot)
  assert.equal(w.item.name, 'diamond_sword')
  assert.equal(w.cooldown, 13)
})

test('it swings only when the weapon has recharged and fights until the zombie dies', async () => {
  const { bot } = makeBot()
  bot.give('diamond_sword', 1)
  const swings = armAttacks(bot)
  const z = mob(bot, 'zombie', 0, 2)
  const r = await mobFight(bot, z)
  assert.equal(r, 'dead')
  assert.equal(bot.heldItem.name, 'diamond_sword')
  assert.equal(swings.length, 3, '20 health at 7 a hit')
  for (let i = 1; i < swings.length; i++) assert.ok(swings[i].tick - swings[i - 1].tick >= 13, `swing ${i} came early`)
})

test('a creeper: a hit, then it backs off, and it backs away at once when one swells close', async () => {
  const { bot } = makeBot()
  bot.give('stone_sword', 1)
  const c = mob(bot, 'creeper', 0, 2)
  const f = new MobFighter(bot)
  let goalAfterHit = null
  bot.attack = e => { e.metadata[9] -= 5 }
  const done = f.start(c)
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve))
  goalAfterHit = bot.pathfinder.goal
  f.stop()
  assert.equal(await done, 'stopped')
  assert.ok(goalAfterHit instanceof goals.GoalInvert, 'keeps away after the hit')
  // swelling within 4 blocks: away at once, shield up toward it
  const q = makeBot().bot
  q.inventory.slots[45] = new Item(registry.itemsByName.shield.id, 1)
  let raised = 0
  q.activateItem = off => { if (off) raised++ }
  q.attack = () => assert.fail('no swing at a swelling creeper')
  const s = mob(q, 'creeper', 0, 2.5, { metadata: { 16: 1 } })
  const g = new MobFighter(q)
  const d2 = g.start(s)
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(q.pathfinder.goal instanceof goals.GoalInvert)
  assert.equal(raised, 1)
  g.stop()
  await d2
})

test('a skeleton drawing from range gets the shield, lowered to swing once in reach', async () => {
  const { bot } = makeBot()
  bot.give('iron_sword', 1)
  bot.inventory.slots[45] = new Item(registry.itemsByName.shield.id, 1)
  const log = []
  bot.activateItem = off => log.push(off ? 'raise' : 'use')
  bot.deactivateItem = () => log.push('lower')
  const sk = mob(bot, 'skeleton', 0, 8, { metadata: { 8: 1 } })
  bot.attack = e => { log.push('swing'); e.metadata[9] = 0 }
  const f = new MobFighter(bot)
  const done = f.start(sk)
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(log, ['raise'])
  sk.position = bot.entity.position.offset(0, 0, 2)  // it came close
  assert.equal(await done, 'dead')
  assert.deepEqual(log, ['raise', 'lower', 'swing'])
})

test('the mob fighting mode takes a zombie from a running job with what it carries, no console kit, and the job comes back', async () => {
  const { bot } = makeBot()
  bot.give('bread', 16)
  bot.give('stone_sword', 1)
  armAttacks(bot)
  const agents = fakeAgents()
  const ctx = { bot, agents }
  const m = makeModes(ctx)
  // a job that stays on: crafting with nothing in the bag and no gatherer to ask
  m.byName.delete('gather')
  m.get('craft').request({ item: 'stone_pickaxe', requester: 'Owner' })
  m.tick()
  assert.equal(m.active.name, 'craft')
  const z = mob(bot, 'zombie', 0, 2)
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'mobfight')
  for (let i = 0; i < 200 && bot.entities[z.id]; i++) {
    await new Promise(resolve => setImmediate(resolve))
    m.tick()
  }
  assert.equal(bot.entities[z.id], undefined, 'the zombie is dead')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(agents.events.includes('Killed zombie'), agents.events.join(' | '))
  assert.equal(agents.kits, 0, 'no console kit for a mob')
  ctx.danger.update()
  m.get('craft').job.phase = 'run'
  m.tick()
  assert.equal(m.active.name, 'craft')
  m.stopNow()
})

// ---------- the food plan ----------

test('the food plan: a deep long trip needs more than the 2 bar floor, a short surface job less', () => {
  const { bot } = makeBot()
  const diamonds3 = foodNeed(bot, 'diamond', 3)
  const diamonds10 = foodNeed(bot, 'diamond', 10)
  const wood = foodNeed(bot, 'wood', 16)
  assert.ok(diamonds3.points > FOOD_RESERVE, `3 diamonds ${diamonds3.points}`)
  assert.ok(diamonds10.points > diamonds3.points + 10, `10 diamonds ${diamonds10.points}`)
  assert.ok(wood.points < FOOD_RESERVE, `wood ${wood.points}`)
  assert.equal(diamonds3.trip.jumps, 122, 'climbing back from Y -58 to 64')
  // a bar that is not full costs what it takes to fill it
  bot.food = 12
  assert.equal(foodNeed(bot, 'diamond', 3).points, diamonds3.points + 8)
  // the way home from Y -58 to Y 64: 122 jumps and one fight's healing, plus 4
  const home = new Vec3(0, 64, 0)
  assert.equal(returnFood(bot, home, new Vec3(0, -58, 0)), 21)
  assert.equal(returnFood(bot, home), 19)
})

test('a job raises the food to carry, and the target falls back when it ends', () => {
  const { bot } = makeBot()
  bot.give('iron_pickaxe', 1)
  bot.give('bread', 5)  // 25 points, over the floor
  const agents = fakeAgents()
  const ctx = { bot, agents }
  const m = makeModes(ctx)
  assert.equal(ctx.danger.update().resupply, null)
  m.setOn('mine', { block: 'diamond', blocks: ['diamond_ore', 'deepslate_diamond_ore'], count: 3 })
  const r = ctx.danger.update()
  assert.ok(r.resupply, 'short for a diamond trip')
  assert.ok(r.resupply.want > FOOD_RESERVE)
  assert.match(r.resupply.reason, /for this job/)
  assert.equal(m.get('resupply').wants(), false, 'a short bag never stops the job: the job checks its food before the dig')
  m.setOff('mine')
  assert.equal(ctx.danger.update().resupply, null)
})

test('safe with the bar under 18 it eats, choosing food that fits, and with a zombie near it waits until it is hungry', async () => {
  assert.equal(eatReason({ food: 17 }, true), 'top-up')
  assert.equal(eatReason({ food: 17 }, false), null)
  assert.equal(eatReason({ food: 13 }, false), 'hungry')
  assert.equal(eatReason({ food: 19 }, true), null)
  const { bot } = makeBot()
  bot.give('cooked_beef', 2)
  bot.give('bread', 2)
  bot.food = 15
  assert.equal(pickTopUp(foods(bot), bot.food).item.name, 'bread', 'bread fits under 20, steak does not')
  assert.equal(pickTopUp(foods(bot), 11).item.name, 'cooked_beef')
  await eat(bot, { cancelled: false }, { until: 18 })
  assert.equal(bot.food, 20)
  assert.equal(bot.countOf('bread'), 1)
  assert.equal(bot.countOf('cooked_beef'), 2)

  const q = makeBot().bot
  q.give('bread', 10)
  q.food = 16
  const ctx = { bot: q, agents: fakeAgents() }
  const m = makeModes(ctx)
  ctx.danger.update()
  assert.ok(ctx.danger.report.safe)
  assert.ok(m.get('eat').wants(), 'safe: tops up')
  const z = mob(q, 'zombie', 0, 7)
  z.yaw = Math.PI  // facing the bot
  ctx.danger.update()
  ctx.danger.update()
  assert.equal(ctx.danger.report.safe, false)
  assert.equal(m.get('eat').wants(), false, 'not with a zombie near')
  q.food = 12
  assert.ok(m.get('eat').wants(), 'hungry: eats anyway')
})

// ---------- hunting and cooking ----------

test('fuel: coal first, then planks, logs only past the 2 it keeps, none when it is not enough', () => {
  const { bot } = makeBot()
  assert.equal(fuelFor(bot, 1), null)
  bot.give('oak_log', 3)
  assert.deepEqual(fuelFor(bot, 1), [['oak_log', 1]])
  assert.equal(fuelFor(bot, 2), null, 'only 1 log may burn')
  bot.give('oak_planks', 2)
  assert.deepEqual(fuelFor(bot, 3), [['oak_planks', 2]])
  bot.give('coal', 1)
  assert.deepEqual(fuelFor(bot, 8), [['coal', 1]])
  assert.deepEqual(fuelFor(bot, 10), [['coal', 1], ['oak_planks', 2]])
})

test('cooking: raw beef in the furnace it carries, coal for fuel, the furnace back in the bag after', async () => {
  const { bot, world } = makeBot()
  bot.give('beef', 3)
  bot.give('coal', 2)
  bot.give('furnace', 1)
  bot.give('stone_pickaxe', 1)
  assert.equal(cookCheck(bot).source, 'bag')
  const before = foodPointsCarried(bot)
  const n = await cookFood(bot, { cancelled: false })
  assert.equal(n, 3)
  assert.equal(bot.countOf('cooked_beef'), 3)
  assert.equal(bot.countOf('beef'), 0)
  assert.equal(bot.countOf('coal'), 1)
  assert.equal(bot.countOf('furnace'), 1, 'picked back up')
  assert.equal(bot.findBlocks({ matching: registry.blocksByName.furnace.id, maxDistance: 8, count: 1 }).length, 0)
  assert.equal(foodPointsCarried(bot), before + 3 * 5, 'steak is 8, raw beef 3')
  assert.ok(world.placed >= 1)
})

test('cooking with no furnace: one from 8 cobblestone on a crafting table made from planks, both picked back up', async () => {
  const { bot } = makeBot()
  bot.give('porkchop', 2)
  bot.give('mutton', 1)
  bot.give('cobblestone', 8)
  bot.give('oak_planks', 4)
  bot.give('coal', 1)
  bot.give('wooden_pickaxe', 1)
  assert.equal(cookCheck(bot).source, 'craft')
  const n = await cookFood(bot, { cancelled: false })
  assert.equal(n, 3)
  assert.equal(bot.countOf('cooked_porkchop'), 2)
  assert.equal(bot.countOf('cooked_mutton'), 1)
  assert.equal(bot.countOf('furnace'), 1)
  assert.equal(bot.countOf('crafting_table'), 1)
  assert.ok(bot.crafted.includes('furnace'))
  // nothing to cook with: no furnace, no stone
  const q = makeBot().bot
  q.give('beef', 2)
  q.give('coal', 1)
  assert.match(cookCheck(q).why, /no furnace/)
})

test('a furnace holding somebody\'s things is left alone, an empty one nearby is used and stays where it is', async () => {
  const { bot, world } = makeBot()
  const spot = new Vec3(2, 64, 0)
  world.set(spot, 'furnace', { facing: 'north', lit: false })
  bot.give('beef', 2)
  bot.give('coal', 1)
  bot.give('furnace', 1)
  bot.give('stone_pickaxe', 1)
  // somebody's iron is smelting in it
  const open = await bot.openFurnace(world.get(spot))
  bot.give('raw_iron', 4)
  await open.putInput(registry.itemsByName.raw_iron.id, null, 4)
  assert.equal(await cookFood(bot, { cancelled: false }), 2)
  assert.equal(bot.countOf('cooked_beef'), 2)
  assert.equal(bot.countOf('raw_iron'), 0, 'their iron is not taken')
  assert.equal(world.furnaces.get(`${spot.x},${spot.y},${spot.z}`).input.count, 4)
  assert.equal(world.name(spot), 'furnace')
  assert.equal(bot.countOf('furnace'), 1, 'its own went back in the bag')
  // an empty furnace nearby is simply used, and not dug up
  const q = makeBot()
  q.world.set(spot, 'furnace', { facing: 'north', lit: false })
  q.bot.give('mutton', 1)
  q.bot.give('coal', 1)
  q.bot.give('stone_pickaxe', 1)
  assert.equal(await cookFood(q.bot, { cancelled: false }), 1)
  assert.equal(q.bot.countOf('cooked_mutton'), 1)
  assert.equal(q.world.name(spot), 'furnace')
  assert.equal(q.bot.countOf('furnace'), 0)
})

test('restock: hunts the grown animals nearby (never a baby), cooks the meat, and reaches the target', async () => {
  const { bot } = makeBot()
  bot.give('iron_sword', 1)
  bot.give('furnace', 1)
  bot.give('coal', 2)
  bot.give('stone_pickaxe', 1)
  armAttacks(bot, { drops: { cow: { beef: 2 }, pig: { porkchop: 2 } } })
  const baby = mob(bot, 'cow', 1, 1, { type: 'animal', hp: 10, metadata: { 16: true } })
  for (const [name, dx] of [['cow', 2], ['pig', -2], ['cow', 0]]) mob(bot, name, dx, 2, { type: 'animal', hp: 10 })
  assert.equal(animalsNear(bot).some(e => e === baby), false)
  const have = await restockFood(bot, { cancelled: false }, { want: 40 })
  assert.ok(have >= 40, `${have} food points`)
  assert.ok(bot.entities[baby.id], 'the calf lives')
  assert.equal(bot.countOf('beef') + bot.countOf('porkchop'), 0, 'all of it cooked')
  assert.equal(bot.countOf('cooked_beef'), 4)
  assert.equal(bot.countOf('cooked_porkchop'), 2)
})

test('a food run during a job deep away from its start waits for an animal it meets on the way', () => {
  const { bot } = makeBot()
  const ctx = { bot, agents: fakeAgents() }
  const m = makeModes(ctx)
  ctx.foodJob = { mode: 'mine', need: 50, home: new Vec3(0.5, 64, 60.5) }
  ctx.danger.update()
  const resupply = m.get('resupply')
  assert.ok(ctx.danger.report.resupply)
  assert.equal(resupply.wants(), false, 'deep in the tunnel: the miner turns back by itself')
  mob(bot, 'sheep', 3, 3, { type: 'animal', hp: 8 })
  assert.equal(resupply.wants(), true, 'a sheep it can see')
  ctx.restocking = true
  assert.equal(resupply.wants(), false, 'not while the miner is on its own food run')
})

// ---------- the live tests' food judgement ----------

test('the long trip check needs real readings: food before going down, and a bar that never fell below 6', () => {
  const { foodVerdict, TESTS } = require('../livetest')
  for (const name of ['food_long', 'hunt_food', 'strip_diamonds', 'danger_zombie']) assert.equal(typeof TESTS[name]?.run, 'function', name)
  const good = [{ bar: 20, points: 10, y: 70 }, { bar: 19, points: 44, y: 70 }, { bar: 17, points: 39, y: 50 }, { bar: 15, points: 30, y: -58 }]
  assert.equal(foodVerdict(good, 70).ok, true)
  assert.equal(foodVerdict(good, 70).food_points_before_trip, 44)
  // went down without getting food first
  assert.equal(foodVerdict([{ bar: 20, points: 10, y: 70 }, { bar: 19, points: 10, y: 40 }], 70).ok, false)
  // the bar ran low
  assert.equal(foodVerdict([{ bar: 20, points: 44, y: 70 }, { bar: 5, points: 20, y: 40 }], 70).ok, false)
  // never went down, or nothing could be read: no pass
  assert.equal(foodVerdict([{ bar: 20, points: 44, y: 70 }], 70).ok, false)
  assert.equal(foodVerdict([{ bar: null, points: null, y: null }], 70).ok, false)
  assert.equal(foodVerdict([], 70).ok, false)
})
