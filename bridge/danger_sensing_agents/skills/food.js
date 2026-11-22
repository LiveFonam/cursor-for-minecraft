// Keeping a bot fed: picking the food to eat, eating, hunting animals nearby and getting the bag back up to a target
// (the farm, the hunt, then cooking what it hunted, skills/cook.js). When to eat and how much to carry is the food
// plan's (skills/food_plan.js).

const { goals } = require('mineflayer-pathfinder')
const { sleep } = require('./human')
const { guardHazards, walkOnlyMoves } = require('./move')
const { pickTopUp, decideFood, foodValue, COOKED, MAX_BATCH, PROTECTED_FOOD, RISKY_FOOD } = require('./food_plan')
const { bestAxeItem } = require('./gather_kinds')

const HUNGRY = 14          // eat below this much food (of 20)
const LOW_HEALTH = 14      // also eat to heal below this health while not fighting
const ENOUGH_FOOD = 10     // food points to carry before a long job
const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'])
const GATHER_RADIUS = 24
const GATHER_ANIMALS = 3
const HIT_TICKS = 12
const BABY = 16            // the ageable mob's baby flag in the 1.21 entity metadata (a baby drops nothing)
const GIVE_UP_MS = 180000  // an animal it could not reach is left alone this long
const NO_CLOSER_HITS = 10  // this many hit windows (6 s) without getting a block closer: it cannot reach that animal
const FEED_STEPS = 16      // bites and batches in one meal, more than a full bar needs
// Hunting on the way, during a job and with no need to eat. 10 blocks there and 10 back is about 4 s at a sprint, and a
// wooden axe kills a cow in 2 charged hits, about 2 s more, for roughly 2 raw beef: 16 food points once cooked, most of a
// full bar for about 6 s. Past that the detour starts to show as the bot leaving its work, so it is left alone
const WAY_RADIUS = 10
const WAY_PATH = 14        // walking steps to reach it: a fence or a hole makes a short line a long walk
const WAY_LEVEL = 1.5      // blocks above or below: one step, never down into a ravine it has to climb out of
const WAY_LEASH = 14       // an animal that runs this far from where the detour began is let go
const WAY_MS = 8000
// It stops at 6 full bars, counting what it can cook at its cooked value: about 15 steaks. Well above the 24 point
// reserve on purpose, so a bag of bread is no reason to walk past a close animal
const HUNT_ENOUGH = 36          // food points: over this it stops going after animals, whatever the job asks for
const WAY_RESERVE = HUNT_ENOUGH
const WAY_PATH_MS = 40
const WAY_CHECK_MS = 1000  // how long the answer of one path search holds for one animal
const SUPPLY_MS = 1000     // cooking options read the world, so the food count is worked out at most this often
// Ticks an axe needs to recharge (20 over its attacks per second, Minecraft Wiki). A swing before that does a fraction
const AXE_TICKS = { wooden: 25, stone: 25, iron: 23, golden: 20, diamond: 20, netherite: 20 }

function foodInfo (bot, item) {
  const f = bot.registry.foodsByName?.[item.name]
  if (!f || PROTECTED_FOOD.has(item.name) || RISKY_FOOD.has(item.name)) return null
  return f
}

// The food it carries, best first (most food plus real saturation, food_plan.js)
function foods (bot) {
  return bot.inventory.items()
    .map(item => ({ item, f: foodInfo(bot, item) }))
    .filter(x => x.f)
    .sort((a, b) => foodValue(b.f) - foodValue(a.f))
}

// The food that needs no furnace, best first
const readyFoods = bot => foods(bot).filter(x => !COOKED[x.item.name])

function foodPointsCarried (bot) {
  return foods(bot).reduce((n, x) => n + x.f.foodPoints * x.item.count, 0)
}

// What the bag is worth as a food reserve. Ready food at its value, and raw food at its cooked value for as many items as
// the bot can really cook (a furnace it has, knows of or can craft, and the fuel), at its raw value otherwise. Raw chicken
// is no food until it is cooked. This is only the count: what to eat and when stays with the food decision.
// { ready, afterCooking, raw, total, canCook }: afterCooking is the raw food it will cook, raw what it cannot
function foodSupply (bot, work = null) {
  const items = bot.inventory.items()
  const foods = bot.registry.foodsByName || {}
  const { cookOption, fuelItems } = require('./cook')
  const bag = items.filter(i => foods[i.name]).map(i => `${i.name}:${i.count}`).join()
  // only what changes the answer, so digging cobblestone does not search for a furnace again and again
  const stone = items.filter(i => /^(cobblestone|cobbled_deepslate|blackstone)$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  const furnaces = items.filter(i => i.name === 'furnace').reduce((n, i) => n + i.count, 0)
  const key = `${bag}|${fuelItems(bot)}|${stone >= 8}|${furnaces}|${!!work?.smelting}|${work?.noCookUntil || 0}`
  const now = Date.now()
  const memo = bot._agentsSupply
  if (memo?.key === key && now < memo.until) return memo.value

  const ready = readyFoods(bot).reduce((n, x) => n + x.f.foodPoints * x.item.count, 0)
  const raw = new Map()
  for (const i of items) if (COOKED[i.name] && foods[i.name]) raw.set(i.name, (raw.get(i.name) || 0) + i.count)
  let room = 0
  if (raw.size) {
    const option = cookOption(bot, work || {})
    if (option.possible) room = Math.floor(option.fuelItems)
  }
  const rawPoints = name => RISKY_FOOD.has(name) ? 0 : foods[name].foodPoints
  const cookedPoints = name => foods[COOKED[name]]?.foodPoints ?? rawPoints(name)
  let afterCooking = 0
  let uncooked = 0
  // the fuel goes to what gains the most
  const order = [...raw].sort((a, b) => (cookedPoints(b[0]) - rawPoints(b[0])) - (cookedPoints(a[0]) - rawPoints(a[0])))
  for (const [name, count] of order) {
    const n = Math.min(room, count)
    room -= n
    afterCooking += n * cookedPoints(name)
    uncooked += (count - n) * rawPoints(name)
  }
  const value = { ready, afterCooking, raw: uncooked, total: ready + afterCooking + uncooked, canCook: afterCooking > 0 }
  bot._agentsSupply = { key, until: now + SUPPLY_MS, value }
  return value
}

// The food count for chat: "Food: 10 ready + 18 after cooking, want 24"
function supplyText (s, want) {
  const parts = [`${s.ready} ready`]
  if (s.afterCooking) parts.push(`${s.afterCooking} after cooking`)
  if (s.raw) parts.push(`${s.raw} raw`)
  return `Food: ${parts.join(' + ')}, want ${want}`
}

function needsFood (bot, fighting) {
  if (bot.food < HUNGRY) return true
  return !fighting && bot.health < LOW_HEALTH && bot.food < 20
}

// Eats ready food until it is no longer hungry or has none left. Raw food stays for the furnace unless raw is true, and
// even then only once no ready food is left. until: also eat while the food bar is below it (a top-up when safe,
// food_plan.js), choosing the food that fits under 20 without waste. Returns how many items it ate
async function eat (bot, token, { until = 0, raw = false } = {}) {
  let ate = 0
  while (!token.cancelled && bot.food < 20 && (bot.food < HUNGRY || bot.health < LOW_HEALTH || bot.food < until)) {
    const ready = readyFoods(bot)
    const list = ready.length || !raw ? ready : foods(bot)
    const best = bot.food < HUNGRY || bot.health < LOW_HEALTH ? list[0] : pickTopUp(list, bot.food)
    if (!best) break
    await bot.equip(best.item, 'hand')
    try {
      await bot.consume()
      ate++
    } catch (err) {
      if (token.cancelled) break
      await sleep(300)
      if (ate === 0) throw err
      break
    }
  }
  return ate
}

// The decision for this bot right now (food_plan.js decideFood). Looks for a furnace only when it would use one.
// walk: false when it was told to stay, so a furnace is out of the question
function foodDecision (bot, { safe = true, emergency = false, work = {}, walk = true } = {}) {
  const { cookOption, letGoFarFurnace } = require('./cook')
  letGoFarFurnace(bot, work)
  const bag = bot.inventory.items().map(i => ({ name: i.name, count: i.count }))
  const hasRaw = bag.some(x => COOKED[x.name])
  const hasReady = readyFoods(bot).length > 0
  const wantsFurnace = walk && (work.smelting || (hasRaw && !hasReady))
  return decideFood({
    food: bot.food,
    saturation: bot.foodSaturation ?? 0,
    health: bot.health,
    safe,
    emergency,
    bag,
    foodsByName: bot.registry.foodsByName || {},
    cook: wantsFurnace ? cookOption(bot, work) : null
  })
}

// One bite of the named food. True when it ate
async function eatItem (bot, token, name) {
  const item = bot.inventory.items().find(i => i.name === name)
  if (!item) return false
  await bot.equip(item, 'hand')
  try {
    await bot.consume()
    return true
  } catch (err) {
    if (token.cancelled) return false
    await sleep(300)
    throw err
  }
}

// Follows the decision, looking again after every bite and every batch, until it says to stop. The step limit and the
// cook's failure wait (cook.js) mean it always ends. opts: safe() (no danger near), emergency, work, walk() (free to
// walk to a furnace), done() (stop early), log, say(text, key). Returns { ate, cooked, last }
async function feed (bot, token, { safe = () => true, emergency = false, work = {}, walk = () => true, done = () => false, log = () => {}, say = () => {} } = {}) {
  const { cookSafely } = require('./cook')
  const out = { ate: 0, cooked: 0, last: null }
  for (let step = 0; step < FEED_STEPS && !token.cancelled && !done(); step++) {
    const d = foodDecision(bot, { safe: safe(), emergency, work, walk: walk() })
    out.last = d
    if (d.action === 'eat') {
      say(d.say, 'food-eat')
      try {
        if (!await eatItem(bot, token, d.item)) break
        out.ate++
      } catch (err) {
        if (!out.ate && !out.cooked) throw err
        break
      }
    } else if (d.action === 'cook') {
      say(d.say, 'food-cook')
      out.cooked += await cookSafely(bot, token, { log, work, limit: d.count || MAX_BATCH })
    } else {
      break
    }
  }
  return out
}

const isBaby = e => e.metadata?.[BABY] === true

function gaveUpOn (bot) {
  if (!bot._agentsGaveUp) bot._agentsGaveUp = new Map()
  const now = Date.now()
  for (const [id, until] of bot._agentsGaveUp) if (until <= now) bot._agentsGaveUp.delete(id)
  return bot._agentsGaveUp
}

// Grown food animals within radius, nearest first, leaving out ones it gave up on. sight: only ones it can see
function animalsNear (bot, radius = GATHER_RADIUS, { sight = false } = {}) {
  const me = bot.entity.position
  const skip = gaveUpOn(bot)
  return Object.values(bot.entities || {})
    .filter(e => ANIMALS.has(e.name) && e.position && e.isValid !== false && !isBaby(e) && !skip.has(e.id))
    .filter(e => e.position.distanceTo(me) <= radius)
    .filter(e => !sight || canSee(bot, e))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

// A clear line from its eyes to the middle of the entity, through blocks without a full collision box
function canSee (bot, e) {
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const to = e.position.offset(0, (e.height || 1) * 0.5, 0)
  const d = to.minus(eye)
  const len = d.norm()
  const step = d.scaled(1 / Math.max(1, Math.ceil(len / 0.5)))
  let p = eye.clone()
  for (let i = 1; i < Math.ceil(len / 0.5); i++) {
    p = p.plus(step)
    const b = bot.blockAt(p.floored())
    if (b && b.boundingBox === 'block') return false
  }
  return true
}

// What hunting did for one bot, for its log: animals seen in sight within WAY_RADIUS during a job (each counted once),
// hunts started and how they ended
function huntCounts (bot) {
  return bot._agentsHunts || (bot._agentsHunts = { seen: new Set(), seenAt: 0, started: 0, killed: 0, gaveUp: 0, cancelled: 0 })
}

function huntText (bot) {
  const c = huntCounts(bot)
  return `hunts: ${c.seen.size} seen, ${c.started} started, ${c.killed} killed, ${c.gaveUp} gave up, ${c.cancelled} cancelled`
}

function noteSeen (bot) {
  const c = huntCounts(bot)
  const now = Date.now()
  if (now < c.seenAt) return
  c.seenAt = now + WAY_CHECK_MS
  for (const e of animalsNear(bot, WAY_RADIUS, { sight: true })) c.seen.add(e.id)
}

// The animal worth a small detour right now, or null: grown, in sight, within WAY_RADIUS on about its own level, not in
// water, with a short walk to it, and only while the bag holds no more than WAY_RESERVE
function animalOnTheWay (bot, work = null) {
  noteSeen(bot)
  if (foodSupply(bot, work).total > WAY_RESERVE) return null
  const me = bot.entity.position
  const checks = bot._agentsWayChecks || (bot._agentsWayChecks = new Map())
  const now = Date.now()
  for (const [id, c] of checks) if (c.until <= now) checks.delete(id)
  for (const e of animalsNear(bot, WAY_RADIUS, { sight: true })) {
    if (Math.abs(e.position.y - me.y) > WAY_LEVEL) continue
    if (bot.blockAt(e.position.floored())?.name === 'water') continue
    let c = checks.get(e.id)
    if (!c) {
      c = { ok: shortWalk(bot, e), until: now + WAY_CHECK_MS }
      checks.set(e.id, c)
    }
    if (c.ok) return e
  }
  return null
}

// Whether a plain walk with no digging reaches it in WAY_PATH steps
function shortWalk (bot, e) {
  if (typeof bot.pathfinder?.getPathTo !== 'function') return true
  try {
    const p = e.position
    const r = bot.pathfinder.getPathTo(walkOnlyMoves(bot), new goals.GoalNear(p.x, p.y, p.z, 2), WAY_PATH_MS)
    return r?.status === 'success' && r.path.length <= WAY_PATH
  } catch {
    return false
  }
}

// One animal met on the way: a short walk, the kill and its drops, then back to the job. Returns what huntOne returns
function huntOnTheWay (bot, animal, token, log) {
  return huntOne(bot, animal, token, log, { leash: WAY_LEASH, ms: WAY_MS, flow: true })
}

// Animals nearby, up to GATHER_ANIMALS of them. sight: only ones it can see. Returns the food points gained
async function gatherFood (bot, token, log = () => {}, { radius = GATHER_RADIUS, sight = false } = {}) {
  const before = foodPointsCarried(bot)
  for (let n = 0; n < GATHER_ANIMALS && !token.cancelled; n++) {
    const animal = animalsNear(bot, radius, { sight })[0]
    if (!animal) {
      log(`${bot.username} sees no animals within ${radius}`)
      break
    }
    const r = await huntOne(bot, animal, token, log)
    if (r !== 'killed' && !token.cancelled) gaveUpOn(bot).set(animal.id, Date.now() + GIVE_UP_MS)
    log(`${bot.username} hunted a ${animal.name}: ${r} (${huntText(bot)})`)
  }
  return foodPointsCarried(bot) - before
}

// Walks up to one animal and hits it until it dies, then picks up the drops. A scripted gathering skill, separate
// from the fight profile (the trained network is for mobs and players that fight back). The axe first, swung only when
// recharged. leash: let it go once it runs this far from where the hunt began. ms: the time limit. flow: pick up the drops
// without stopping first, for a hunt on the way
async function huntOne (bot, animal, token, log, { leash = null, ms = 20000, flow = false } = {}) {
  const items = bot.inventory.items()
  const axe = bestAxeItem(items)
  const weapon = axe || items.find(i => /_sword$/.test(i.name))
  if (weapon && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand')
  const hitTicks = axe ? AXE_TICKS[axe.name.split('_')[0]] : HIT_TICKS
  guardHazards(bot, bot.pathfinder.movements)
  const from = bot.entity.position.clone()
  const known = flow ? new Set(Object.values(bot.entities).filter(e => e.name === 'item').map(e => e.id)) : null
  const chase = new goals.GoalFollow(animal, 1.5)
  bot.pathfinder.setGoal(chase, true)
  const counts = huntCounts(bot)
  counts.started++
  const until = Date.now() + ms
  let result = `gave up after ${Math.round(ms / 1000)} s`
  let closest = Infinity
  let noCloser = 0
  let readyAt = 0
  let ticks = 0
  try {
    while (!token.cancelled && Date.now() < until) {
      const e = bot.entities[animal.id]
      if (!e || e.isValid === false) { result = 'killed'; break }
      if (leash !== null && e.position.distanceTo(from) > leash) {
        result = 'ran off'
        break
      }
      const d = e.position.distanceTo(bot.entity.position)
      if (d < 3) {
        noCloser = 0
        if (ticks >= readyAt) {
          await bot.lookAt(e.position.offset(0, e.height * 0.6, 0), true)
          bot.attack(e)
          readyAt = ticks + hitTicks
        }
      } else if (d < closest - 1) {
        closest = d
        noCloser = 0
      } else if (++noCloser >= NO_CLOSER_HITS * HIT_TICKS) {
        result = 'could not get closer'  // across water, up a cliff, behind a fence
        break
      }
      await bot.waitForTicks(1)
      ticks++
    }
  } finally {
    // only its own goal: a mode that took over (running from a creeper) has set its own by now
    if (bot.pathfinder.goal === chase) bot.pathfinder.setGoal(null)
  }
  if (result !== 'killed') {
    counts[token.cancelled ? 'cancelled' : 'gaveUp']++
    return token.cancelled ? 'cancelled' : result
  }
  counts.killed++
  // the drops
  const spot = animal.position.clone()
  if (flow) {
    const { collectAround } = require('./mine')
    try {
      await collectAround(bot, spot.offset(0, 0.5, 0), token, { known, log })
    } catch (err) {
      log(`${bot.username} drops of a hunt: ${err.message}`)
    }
    return result
  }
  await require('./pickup').pickUpDrops(bot, spot, token, { settleMs: 400 })
  return result
}

const rawChicken = bot => bot.inventory.items().filter(i => i.name === 'chicken').reduce((n, i) => n + i.count, 0)

// Gets the food in the bag up to want: the agents' farm within 96 blocks first, then up to rounds hunts of animals
// nearby, cooking what it hunted whenever it can (cooked meat counts 2 to 3 times raw). Returns the food points it
// carries at the end. opts: farms() (the agents' farm records), log, say, work (the cook's furnace state, kept by the
// caller across runs), sight (only hunt animals it can see), points() (what counts toward want, the raw count by default)
async function restockFood (bot, token, { want, farms = () => [], log = () => {}, say = () => {}, rounds = 4, work = {}, sight = false, points = () => foodPointsCarried(bot) } = {}) {
  const { foodFromFarm, nearestFarm } = require('./farm')
  const { cookSafely, canCook } = require('./cook')
  // one batch at a time, so a big stack of raw meat is a few short stops and not one long one
  const cook = async () => canCook(bot, work) ? cookSafely(bot, token, { log, say, work, limit: MAX_BATCH }) : 0
  if (nearestFarm(farms(), bot.entity.position, 96)) {
    await foodFromFarm(bot, farms(), token, { log, foodPoints: () => foodPointsCarried(bot) })
    if (token.cancelled) return points()
  }
  for (let round = 0; round < rounds && points() < want; round++) {
    // what it carries raw goes in the furnace first, it may already be enough
    if (await cook() && points() >= want) break
    if (token.cancelled) break
    const chickenBefore = rawChicken(bot)
    const got = await gatherFood(bot, token, log, { sight })
    if (token.cancelled) break
    // raw chicken counts for nothing until it is cooked, but the hunt did bring food back
    if (got <= 0 && rawChicken(bot) <= chickenBefore) break
  }
  if (!token.cancelled) await cook()
  return points()
}

module.exports = { HUNT_ENOUGH, foods, readyFoods, foodInfo, foodPointsCarried, foodSupply, supplyText, animalOnTheWay, huntOnTheWay, huntCounts, huntText, WAY_RADIUS, WAY_RESERVE, needsFood, eat, eatItem, feed, foodDecision, gatherFood, huntOne, animalsNear, gaveUpOn, canSee, restockFood, isBaby, HUNGRY, LOW_HEALTH, ENOUGH_FOOD, ANIMALS, GIVE_UP_MS }
