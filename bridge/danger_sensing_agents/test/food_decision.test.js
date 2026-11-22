// The food decision (skills/food_plan.js decideFood) and the furnace flow around it, on the fake world, no server needed.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot, registry } = require('./mockbot')
const { Friends } = require('../targets')
const { makeModes } = require('../behaviors')
const {
  decideFood, waitSeconds, cookGain, saturationOf, foodValue, COOKED, RAW_NOW_AT, COOK_BY, DANGER_RAW_AT,
  SPRINT_FOOD, MAX_BATCH, MIN_GAIN_PER_SECOND
} = require('../skills/food_plan')
const { feed, foodDecision, eat, foods, readyFoods, restockFood } = require('../skills/food')
const {
  cookFood, cookSafely, cookFailed, cookOption, cookCheck, fuelFor, fuelItems, furnaceSource, rememberFurnace, coalForJobs, workFor
} = require('../skills/cook')
const { foodMission } = require('../skills/food_mission')

const foodsByName = registry.foodsByName
const bagOf = obj => Object.entries(obj).map(([name, count]) => ({ name, count }))
const furnace = (extra = {}) => ({ possible: true, source: 'near', seconds: 3, fuelItems: 64, ...extra })
const decide = (food, bag, extra = {}) => decideFood({ food, bag: bagOf(bag), foodsByName, cook: furnace(), ...extra })

function fakeAgents () {
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
    noDigMoves: () => ({ name: 'noDig' }),
    digMoves: () => ({}),
    buildMoves: () => ({ name: 'build' }),
    ensureKit: async () => {},
    announce: () => {},
    blackboard: { clear () {} }
  }
}

function kitted (items) {
  const made = makeBot()
  for (const [name, n] of Object.entries(items)) made.bot.give(name, n)
  return made
}

let nextId = 900
function zombie (bot, dz) {
  const p = bot.entity.position
  const e = { id: nextId++, type: 'hostile', name: 'zombie', position: new Vec3(p.x, p.y, p.z + dz), height: 1.95, yaw: Math.PI, metadata: { 9: 20 } }
  bot.entities[e.id] = e
  return e
}

// ---------- the real food values ----------

test('saturation comes from the game values, not the inflated registry field', () => {
  const real = { cooked_beef: 12.8, beef: 1.8, bread: 6, cooked_chicken: 7.2, chicken: 1.2, baked_potato: 6, potato: 0.6, cod: 0.4, golden_carrot: 14.4 }
  for (const [name, sat] of Object.entries(real)) {
    assert.ok(Math.abs(saturationOf(foodsByName[name]) - sat) < 0.001, `${name}: ${saturationOf(foodsByName[name])}`)
  }
  assert.ok(foodsByName.cooked_beef.saturation > 100, 'the raw registry field would rank food wrongly')
})

test('every raw food gains from cooking, and the gain is computed from the registry', () => {
  for (const name of Object.keys(COOKED)) assert.ok(cookGain(name, foodsByName) > 0, name)
  assert.ok(Math.abs(cookGain('beef', foodsByName) - 16) < 0.001, 'steak 20.8 against raw beef 4.8')
  assert.ok(Math.abs(cookGain('potato', foodsByName) - 9.4) < 0.001)
  assert.ok(cookGain('beef', foodsByName) > cookGain('rabbit', foodsByName))
  assert.ok(Math.abs(foodValue(foodsByName.bread) - 11) < 0.001)
})

test('the time it can wait follows the hunger rules', () => {
  assert.equal(waitSeconds(1), 0, 'the last point is never spent waiting')
  assert.equal(waitSeconds(0), 0)
  assert.equal(Math.round(waitSeconds(2)), 80, 'no sprint below 7, one jump a second')
  assert.equal(Math.round(waitSeconds(6)), 400)
  assert.ok(waitSeconds(10) > waitSeconds(6))
  assert.ok(waitSeconds(10, 5) > waitSeconds(10), 'saturation drains first')
  assert.ok(waitSeconds(4, 2) > waitSeconds(4))
})

// ---------- ready food first ----------

test('ready food is eaten first at any bar, never raw meat while it is in the bag', () => {
  for (let food = 0; food < 18; food++) {
    const d = decide(food, { beef: 8, bread: 2 })
    assert.equal(d.action, 'eat', `bar ${food}`)
    assert.equal(d.item, 'bread')
    assert.equal(d.raw, false)
    assert.equal(d.say, 'Eating bread')
  }
  assert.equal(decide(5, { beef: 4, cooked_beef: 1, bread: 1 }).item, 'cooked_beef', 'the best when it is hungry')
  assert.equal(decide(5, { beef: 4, carrot: 1 }).item, 'carrot', 'needs no cooking')
  assert.equal(decide(5, { beef: 4, bread: 1 }, { safe: false }).item, 'bread', 'with danger near too')
})

test('a top-up picks ready food that fits under 20', () => {
  assert.equal(decide(15, { cooked_beef: 2, bread: 2 }).item, 'bread')
  assert.equal(decide(19, { bread: 2 }).action, 'none')
  assert.equal(decide(16, { bread: 2 }, { safe: false }).action, 'none', 'no top-up with danger near')
})

test('golden food is never chosen, at any bar, with or without danger', () => {
  for (const safe of [true, false]) {
    for (const food of [0, 1, 6, 13]) {
      const d = decide(food, { golden_apple: 3, enchanted_golden_apple: 1, golden_carrot: 5 }, { safe })
      assert.equal(d.action, 'none', `bar ${food} safe ${safe}`)
    }
  }
})

// ---------- cooking comes first ----------

test('with raw food only and no danger it keeps working above 10, then stops to cook a batch', () => {
  for (const food of [17, 14, 13, 11]) {
    const d = decide(food, { beef: 4 }, { cook: furnace({ seconds: 20 }) })
    assert.equal(d.action, 'wait', `bar ${food}`)
    assert.equal(d.why, 'keep-working')
  }
  for (const food of [COOK_BY, 8, 6, 3, 2]) {
    const d = decide(food, { beef: 4 }, { cook: furnace({ seconds: 20 }) })
    assert.equal(d.action, 'cook', `bar ${food}`)
    assert.equal(d.count, 4)
    assert.equal(d.say, 'Cooking 4 beef first')
  }
})

test('a furnace right there is used for a top-up too', () => {
  assert.equal(decide(16, { beef: 2 }, { cook: furnace({ seconds: 3 }) }).action, 'cook')
  assert.equal(decide(16, { beef: 2 }, { cook: furnace({ seconds: 20 }) }).action, 'wait')
})

test('hurt, it cooks at once so healing comes back sooner', () => {
  assert.equal(decide(15, { beef: 4 }, { health: 10, cook: furnace({ seconds: 20 }) }).action, 'cook')
})

test('a batch is capped, takes the biggest gains first, and fits the fuel and the time left', () => {
  const big = decide(8, { rabbit: 20, beef: 20 })
  assert.equal(big.count, MAX_BATCH)
  assert.deepEqual(big.items, [{ name: 'beef', count: MAX_BATCH }])
  const mixed = decide(8, { rabbit: 3, beef: 2 })
  assert.deepEqual(mixed.items, [{ name: 'beef', count: 2 }, { name: 'rabbit', count: 3 }])
  assert.equal(mixed.say, 'Cooking 5 raw food first')
  assert.equal(decide(8, { beef: 6 }, { cook: furnace({ fuelItems: 2 }) }).count, 2, 'only what the fuel covers')
  // at 2 the budget is 80 s, so with a 45 s walk only 3 fit
  assert.equal(decide(2, { beef: 8 }, { cook: furnace({ seconds: 45 }) }).count, 3)
})

test('a long trip for a tiny gain does not pay, a short one does', () => {
  const far = decide(8, { potato: 1 }, { cook: furnace({ seconds: 30 }) })
  assert.ok(9.4 / 40 < MIN_GAIN_PER_SECOND)
  assert.equal(far.action, 'wait')
  assert.equal(far.why, 'no-furnace')
  assert.equal(decide(8, { potato: 1 }, { cook: furnace({ seconds: 3 }) }).action, 'cook')
  assert.equal(decide(5, { potato: 1 }, { cook: furnace({ seconds: 30 }) }).raw, true, 'and at 6 or less it eats it')
})

// ---------- raw only as a last resort ----------

test('raw at 1 or 0 even with a furnace, one bite at a time', () => {
  for (const food of [RAW_NOW_AT, 0]) {
    const d = decide(food, { beef: 4, mutton: 2 })
    assert.equal(d.action, 'eat')
    assert.equal(d.raw, true)
    assert.equal(d.item, 'beef')
    assert.equal(d.count, 1)
    assert.match(d.say, /^Eating raw beef, about to starve/)
  }
  assert.equal(decide(2, { beef: 4 }).action, 'cook', 'at 2 it still waits for the furnace')
})

test('no furnace: it holds out until it would lose its sprint, then eats raw', () => {
  const cook = { possible: false, why: 'no furnace' }
  for (const food of [13, 10, 7]) assert.equal(decide(food, { beef: 4 }, { cook }).action, 'wait', `bar ${food}`)
  for (const food of [SPRINT_FOOD, 4, 2]) {
    const d = decide(food, { beef: 4 }, { cook })
    assert.equal(d.raw, true, `bar ${food}`)
    assert.match(d.say, /no way to cook it/)
  }
  assert.equal(decide(12, { beef: 4 }, { cook: null, health: 10 }).raw, true, 'hurt with no furnace, food is healing')
})

test('danger: no furnace stop, raw at 8 or less, and it stays hungry above that', () => {
  const d = decide(DANGER_RAW_AT, { beef: 4 }, { safe: false })
  assert.equal(d.action, 'eat')
  assert.equal(d.raw, true)
  assert.match(d.say, /danger is close/)
  assert.equal(decide(9, { beef: 4 }, { safe: false }).action, 'wait')
  assert.equal(decide(9, { beef: 4 }, { safe: false, emergency: true }).raw, true, 'in a food emergency it eats')
  for (let food = 0; food < 20; food++) assert.notEqual(decide(food, { beef: 4 }, { safe: false }).action, 'cook', `bar ${food}`)
})

test('raw chicken is the last choice of all', () => {
  assert.equal(decide(1, { chicken: 4, rabbit: 1 }).item, 'rabbit')
  assert.equal(decide(0, { chicken: 4 }).item, 'chicken')
  const none = { possible: false }
  assert.equal(decide(7, { chicken: 4 }, { cook: none }).action, 'wait', 'above 6 it keeps it')
  assert.equal(decide(6, { chicken: 4 }, { cook: none }).item, 'chicken')
  assert.equal(decide(12, { chicken: 4 }, { cook: none, health: 8 }).action, 'wait', 'not to heal')
  assert.equal(decide(8, { chicken: 4 }, { safe: false }).action, 'wait')
  assert.equal(decide(6, { chicken: 4 }, { safe: false }).item, 'chicken')
  assert.equal(decide(8, { chicken: 2 }).action, 'cook', 'with a furnace it gets cooked')
})

test('at critical health one raw bite that turns healing on beats the wait', () => {
  const d = decide(15, { beef: 4 }, { health: 5 })
  assert.equal(d.raw, true)
  assert.equal(d.why, 'heal')
  assert.equal(decide(14, { beef: 4 }, { health: 5 }).action, 'cook', 'a bite that stops short of 18 heals nothing')
})

test('across every bar, bag and danger it never picks raw while ready food is there, and always has a choice', () => {
  const bags = [{}, { beef: 3 }, { chicken: 2 }, { bread: 1 }, { beef: 2, bread: 1 }, { potato: 1, chicken: 1 }, { golden_apple: 2, beef: 1 }, { rotten_flesh: 2 }]
  const cooks = [null, furnace(), furnace({ seconds: 60, fuelItems: 1 }), { possible: false, why: 'x' }]
  for (const bag of bags) {
    for (const cook of cooks) {
      for (const safe of [true, false]) {
        for (const emergency of [true, false]) {
          for (const health of [3, 10, 20]) {
            for (let food = 0; food <= 20; food++) {
              const d = decide(food, bag, { cook, safe, emergency, health })
              const where = JSON.stringify({ food, bag, cook, safe, emergency, health })
              assert.ok(['eat', 'cook', 'wait', 'none'].includes(d.action), where)
              if (bag.bread && d.action === 'eat') assert.equal(d.item, 'bread', where)
              if (d.action === 'eat') assert.ok(!['golden_apple', 'rotten_flesh'].includes(d.item), where)
              if (!safe) assert.notEqual(d.action, 'cook', where)
              if (d.action === 'cook') assert.ok(cook?.possible, where)
            }
          }
        }
      }
    }
  }
})

test('what a fight left in a furnace is collected once it is safe, ready food still goes first', () => {
  const cook = furnace({ pending: true, source: 'resume' })
  const d = decide(20, {}, { cook })
  assert.equal(d.action, 'cook')
  assert.equal(d.why, 'collect')
  assert.equal(decide(5, { bread: 1 }, { cook }).item, 'bread')
  assert.equal(decide(20, {}, { cook, safe: false }).action, 'none')
})

// ---------- eating ----------

test('eat() leaves raw food alone unless it is told otherwise', async () => {
  const { bot } = kitted({ beef: 3 })
  bot.food = 5
  assert.equal(await eat(bot, { cancelled: false }), 0)
  assert.equal(bot.countOf('beef'), 3)
  assert.equal(await eat(bot, { cancelled: false }, { raw: true }) > 0, true)
  const q = kitted({ beef: 3, bread: 1 }).bot
  q.food = 12
  await eat(q, { cancelled: false }, { raw: true })
  assert.equal(q.countOf('bread'), 0)
  assert.equal(q.countOf('beef'), 3, 'bread took it to 17, no raw needed')
  assert.deepEqual(readyFoods(kitted({ beef: 1, bread: 1 }).bot).map(x => x.item.name), ['bread'])
  assert.equal(foods(kitted({ beef: 1 }).bot).length, 1, 'raw meat still counts as food in the bag')
})

// ---------- fuel ----------

test('fuel: it never burns the coal the job needs, and uses wood instead', () => {
  const { bot } = kitted({ coal: 2, oak_planks: 4 })
  assert.deepEqual(fuelFor(bot, 8), [['coal', 1]], 'no job: coal first')
  assert.deepEqual(fuelFor(bot, 4, 2), [['oak_planks', 3]], 'both coal kept')
  assert.deepEqual(fuelFor(bot, 8, 1), [['coal', 1]], 'one to spare')
  assert.equal(fuelFor(bot, 7, 2), null, '4 planks cook 6')
  assert.equal(fuelItems(bot, 2), 6)
  assert.equal(fuelItems(bot), 22)
  const blocks = kitted({ coal_block: 2 }).bot
  assert.equal(fuelItems(blocks, 9), 80, 'one block is the 9 coal it keeps')
})

test('the coal a job needs is read from the craft job and from the plan', () => {
  const { bot } = kitted({ raw_iron: 3, coal: 2, oak_planks: 16, stick: 4 })
  const agents = fakeAgents()
  const ctx = { bot, agents }
  const m = makeModes(ctx)
  assert.equal(coalForJobs(ctx), 0, 'no job')
  m.byName.delete('gather')
  m.get('craft').request({ item: 'iron_pickaxe', requester: 'Owner' })
  assert.equal(coalForJobs(ctx), 1, '3 iron to smelt')
  m.get('craft').job = null
  ctx.plan = { steps: ['gather 9 iron', 'smelt 9 raw iron', 'craft iron pickaxe'], index: 0 }
  assert.equal(coalForJobs(ctx), 2)
  ctx.plan.index = 2
  assert.equal(coalForJobs(ctx), 0, 'the smelt is behind it')
  assert.equal(workFor(ctx), ctx.cookWork)
  ctx.plan.index = 0
  assert.equal(ctx.cookWork.keepCoal(), 2)
})

test('cooking with a job on burns wood and leaves the job its coal', async () => {
  const { bot } = kitted({ beef: 2, coal: 1, oak_planks: 2, furnace: 1, stone_pickaxe: 1 })
  const work = { keepCoal: () => 1 }
  assert.equal(await cookFood(bot, { cancelled: false }, { work }), 2)
  assert.equal(bot.countOf('coal'), 1)
  assert.equal(bot.countOf('cooked_beef'), 2)
  // with only the job's coal there is no fuel to cook with
  const q = kitted({ beef: 2, coal: 1, furnace: 1 }).bot
  assert.equal(cookOption(q, { keepCoal: () => 1 }).possible, false)
  assert.equal(foodDecision(q, { work: { keepCoal: () => 1 } }).action, 'none')
})

// ---------- where the furnace comes from ----------

test('the order: seen, then remembered, then the bag, then crafted', () => {
  const { bot, world } = kitted({ beef: 1, coal: 1, furnace: 1, cobblestone: 8, oak_planks: 4 })
  const work = {}
  assert.equal(furnaceSource(bot, work), 'bag')
  assert.equal(cookOption(bot, work).source, 'bag')
  bot.take('furnace', 1)
  assert.equal(cookOption(bot, work).source, 'craft')
  const far = new Vec3(30, 64, 0)
  world.set(far, 'furnace', { facing: 'north', lit: false })
  rememberFurnace(work, far)
  assert.equal(cookOption(bot, work).source, 'remembered')
  assert.ok(cookOption(bot, work).seconds > 6, 'the walk counts')
  world.set(new Vec3(4, 64, 0), 'furnace', { facing: 'north', lit: false })
  assert.equal(cookOption(bot, work).source, 'near')
})

test('a remembered furnace that is gone is forgotten', () => {
  const { bot, world } = kitted({ beef: 1, coal: 1 })
  const work = {}
  const spot = new Vec3(30, 64, 0)
  world.set(spot, 'furnace', { facing: 'north', lit: false })
  rememberFurnace(work, spot)
  assert.equal(cookOption(bot, work).source, 'remembered')
  world.set(spot, 'air')
  assert.equal(cookOption(bot, work).possible, false)
  assert.equal(work.known.size, 0)
})

// ---------- the furnace flow and its failures ----------

test('feed: eats ready food, then cooks and eats, and stops when it is full enough', async () => {
  const { bot } = kitted({ bread: 1, beef: 3, coal: 1, furnace: 1, stone_pickaxe: 1 })
  bot.food = 4
  const said = []
  const r = await feed(bot, { cancelled: false }, { say: t => said.push(t) })
  assert.equal(said[0], 'Eating bread')
  assert.ok(said.includes('Cooking 3 beef first'), said.join(' | '))
  assert.equal(bot.countOf('beef'), 0, 'nothing eaten raw')
  assert.ok(bot.food >= 18, `bar ${bot.food}`)
  assert.equal(r.cooked, 3)
})

test('an unreachable furnace: avoided, its own furnace used instead, and no loop', async () => {
  const { bot, world } = kitted({ beef: 2, coal: 1, furnace: 1, stone_pickaxe: 1 })
  const spot = new Vec3(10, 64, 0)
  world.set(spot, 'furnace', { facing: 'north', lit: false })
  const goto = bot.pathfinder.goto
  let tries = 0
  bot.pathfinder.goto = async g => {
    if (g.x === spot.x && g.z === spot.z) { tries++; throw new Error('no path') }
    return goto(g)
  }
  const work = {}
  assert.equal(await cookSafely(bot, { cancelled: false }, { work }), 2)
  assert.equal(bot.countOf('cooked_beef'), 2)
  assert.equal(tries, 1, 'one try at that furnace')
  assert.ok(work.avoid.size, 'and it is avoided')
})

test('a cook that keeps failing backs off, and the decision falls back to the raw rules', async () => {
  const { bot } = kitted({ beef: 3, coal: 1, furnace: 1 })
  bot.placeBlock = async () => { throw new Error('cannot place') }
  bot.food = 5
  const work = {}
  const r = await feed(bot, { cancelled: false }, { work })
  assert.equal(work.cookFails, 1)
  assert.ok(work.noCookUntil > Date.now() + 20000)
  assert.equal(cookCheck(bot, work).ok, false)
  assert.equal(cookOption(bot, work).possible, false)
  assert.ok(r.ate >= 1, 'at 5 with no way to cook, it ate raw')
  assert.ok(bot.food > SPRINT_FOOD)
  assert.ok(bot.countOf('beef') >= 1, 'and only what it needed')
})

test('the wait doubles up to 5 minutes, and three failures let go of a stuck furnace', () => {
  const work = { furnace: new Vec3(5, 64, 5), smelting: true }
  const now = 1000000
  cookFailed(work, 'x', now)
  assert.equal(work.noCookUntil, now + 30000)
  assert.equal(work.smelting, true)
  cookFailed(work, 'x', now)
  assert.equal(work.noCookUntil, now + 60000)
  cookFailed(work, 'x', now)
  assert.equal(work.noCookUntil, now + 120000)
  assert.equal(work.smelting, false, 'nothing keeps sending it back')
  assert.equal(work.furnace, null)
  for (let i = 0; i < 6; i++) cookFailed(work, 'x', now)
  assert.equal(work.noCookUntil, now + 300000)
})

test('a good batch clears the failures', async () => {
  const { bot } = kitted({ beef: 1, coal: 1, furnace: 1, stone_pickaxe: 1 })
  const work = { cookFails: 2, noCookUntil: 0 }
  assert.equal(await cookSafely(bot, { cancelled: false }, { work }), 1)
  assert.equal(work.cookFails, 0)
})

test('danger cancelling a cook is no failure, and the food in the furnace comes back after', async () => {
  const { bot, world } = kitted({ beef: 3, coal: 1, stone_pickaxe: 1 })
  const spot = new Vec3(2, 64, 0)
  world.set(spot, 'furnace', { facing: 'north', lit: false })
  const token = { cancelled: false }
  const work = { furnace: spot, furnaceOurs: false, smelting: true, stats: { crafted: 0, smelted: 0 } }
  const open = await bot.openFurnace(world.get(spot))
  await open.putFuel(registry.itemsByName.coal.id, null, 1)
  bot.take('beef', 3)
  const s = world.furnaces.get(`${spot.x},${spot.y},${spot.z}`)
  s.output = new (require('prismarine-item')(registry))(registry.itemsByName.cooked_beef.id, 3)
  token.cancelled = true
  assert.equal(await cookSafely(bot, token, { work }), 0)
  assert.equal(work.cookFails || 0, 0)
  assert.equal(work.smelting, true, 'kept for the next run')
  assert.equal(foodDecision(bot, { work }).why, 'collect')
  const n = await feed(bot, { cancelled: false }, { work })
  assert.equal(n.last.action === 'none' || n.last.action === 'wait', true)
  assert.equal(bot.countOf('cooked_beef'), 3)
  assert.equal(work.smelting, false)
})

test('food left in a furnace far away (after a death or a long walk) does not send it back', async () => {
  const { bot, world } = kitted({ bread: 1 })
  const spot = new Vec3(200, 64, 0)
  world.set(spot, 'furnace', { facing: 'north', lit: false })
  const work = { furnace: spot, furnaceOurs: true, smelting: true }
  let walks = 0
  const goto = bot.pathfinder.goto
  bot.pathfinder.goto = async g => { walks++; return goto(g) }
  assert.equal(foodDecision(bot, { work }).action, 'none')
  assert.equal(work.smelting, false)
  assert.equal(work.furnace, null)
  assert.equal(walks, 0)
})

test('restock cooks in batches and stops trying after a failure', async () => {
  const { bot } = kitted({ beef: 12, coal: 2, furnace: 1, stone_pickaxe: 1 })
  await restockFood(bot, { cancelled: false }, { want: 80, rounds: 3, work: {} })
  assert.equal(bot.countOf('cooked_beef'), 12)
  const q = kitted({ beef: 3, coal: 1, furnace: 1 }).bot
  let places = 0
  q.placeBlock = async () => { places++; throw new Error('cannot place') }
  await restockFood(q, { cancelled: false }, { want: 80, rounds: 4, work: {} })
  assert.equal(places, 1, 'one failed try in the whole run')
})

// ---------- the modes ----------

function modes (items) {
  const { bot, world } = kitted(items)
  const agents = fakeAgents()
  const ctx = { bot, agents }
  const m = makeModes(ctx)
  m.byName.delete('gather')
  return { bot, world, agents, ctx, m }
}

const settle = async (ctx, m, done, ms = 3000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    ctx.danger.update()
    m.tick()
    if (done()) return true
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  return false
}

test('the eat mode leaves a job alone while it waits to cook', () => {
  const { bot, ctx, m } = modes({ beef: 4, coal: 1, furnace: 1 })
  bot.food = 12
  ctx.danger.update()
  assert.equal(m.get('eat').wants(), false, 'above 10 it keeps working')
  bot.food = 10
  assert.equal(m.get('eat').wants(), true)
  assert.equal(m.get('eat').decision.action, 'cook')
})

test('the eat mode cooks and then eats, saying each once', async () => {
  const { bot, agents, ctx, m } = modes({ beef: 4, coal: 1, furnace: 1, stone_pickaxe: 1 })
  bot.food = 8
  assert.ok(await settle(ctx, m, () => bot.food >= 18 && !m.get('eat').token))
  assert.equal(bot.countOf('beef'), 0, 'none eaten raw')
  const texts = agents.events.map(e => e.text)
  assert.equal(texts.filter(t => t === 'Cooking 4 beef first').length, 1, texts.join(' | '))
  assert.ok(texts.includes('Eating cooked beef'), texts.join(' | '))
  m.stopNow()
})

test('told to stay it does not walk to a furnace, and a danger response outranks the meal', () => {
  const { bot, ctx, m } = modes({ beef: 4, coal: 1, furnace: 1 })
  bot.food = 8
  ctx.staying = true
  ctx.danger.update()
  assert.equal(m.get('eat').wants(), false, 'held, and 8 is above the raw line')
  ctx.staying = false
  m.get('eat').memo = null
  zombie(bot, 2)
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'mobfight')
  m.stopNow()
})

test('an order to come ends a cooking stop and the meal does not take over again', () => {
  const { bot, ctx, m } = modes({ beef: 4, coal: 1, furnace: 1 })
  bot.food = 8
  ctx.danger.update()
  const eatMode = m.get('eat')
  assert.equal(eatMode.wants(), true)
  eatMode.token = { cancelled: false }
  eatMode.cooking = true
  assert.equal(eatMode.wants(), true, 'the stop goes on')
  m.get('come').on = true
  assert.equal(eatMode.wants(), false, 'the order goes first')
  eatMode.token = null
  eatMode.cooking = false
  assert.equal(eatMode.wants(), false, 'and it does not come straight back')
  m.get('come').on = false
})

// ---------- the food emergency ----------

test('the mission with danger near eats raw at once and never stops at a furnace', async () => {
  const { bot } = kitted({ beef: 4, coal: 1, furnace: 1, stone_pickaxe: 1 })
  bot.food = 9
  let opens = 0
  const open = bot.openFurnace
  bot.openFurnace = async b => { opens++; return open(b) }
  const r = await foodMission(bot, {}, { cancelled: false }, {
    recovered: () => bot.food >= 14,
    step: () => {},
    log: () => {},
    farms: () => [],
    home: null,
    moves: { walk: { name: 'noDig' }, build: { name: 'build' } },
    rescue: () => ({}),
    safe: () => false,
    work: {}
  })
  assert.equal(r, 'recovered')
  assert.equal(opens, 0)
  assert.equal(bot.countOf('beef'), 2, 'two raw bites took it from 9 to 15')
})

test('the mission does not hang on a furnace it cannot use', async () => {
  const { bot } = kitted({ beef: 4, coal: 1, furnace: 1 })
  bot.placeBlock = async () => { throw new Error('cannot place') }
  bot.food = 8
  let places = 0
  const place = bot.placeBlock
  bot.placeBlock = async (...a) => { places++; return place(...a) }
  const r = await foodMission(bot, {}, { cancelled: false }, {
    recovered: () => bot.food >= 14,
    step: () => {},
    log: () => {},
    farms: () => [],
    home: null,
    moves: { walk: { name: 'noDig' }, build: { name: 'build' } },
    rescue: () => ({}),
    work: {}
  })
  assert.equal(r, 'recovered')
  assert.equal(places, 1)
  assert.ok(bot.food >= 14)
})

test('the state before the a10 heap crash: 3 beef, little fuel, the job\'s new furnace: feed returns and the heap stays flat', async () => {
  const v8 = require('node:v8')
  const vm = require('node:vm')
  v8.setFlagsFromString('--expose-gc')
  const gc = vm.runInNewContext('gc')
  const round = async () => {
    const { bot, world } = kitted({ beef: 3, oak_planks: 1, stone_pickaxe: 1 })
    bot.food = 6
    const spot = new Vec3(2, 64, 0)
    world.set(spot, 'furnace', { facing: 'north', lit: false })
    let limit
    const stuck = new Promise((resolve, reject) => { limit = setTimeout(() => reject(new Error('feed did not return')), 5000) })
    try {
      await Promise.race([feed(bot, { cancelled: false }, { work: { furnace: spot, furnaceOurs: true } }), stuck])
    } finally {
      clearTimeout(limit)
    }
  }
  await round()
  gc()
  const before = process.memoryUsage().heapUsed
  for (let i = 0; i < 6; i++) await round()
  gc()
  const grew = process.memoryUsage().heapUsed - before
  assert.ok(grew < 4 * 1024 * 1024, `the heap grew ${(grew / 1048576).toFixed(1)} MB over 6 rounds`)
})
