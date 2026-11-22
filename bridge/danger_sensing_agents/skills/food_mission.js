// The food mission: what a bot does in a food emergency (threats.js decides when, food_plan.js holds the thresholds).
// Finding food is its only work until the food bar is back. Each pass of the loop takes the first thing that applies:
//
//   1. food in the bag or left in a furnace: the food decision (food_plan.js decideFood) says to eat ready food, cook,
//      or, when it cannot cook, eat raw
//   2. raw chicken goes in the furnace when it can. With the bar at 6 or less and nothing better, raw chicken and then
//      rotten flesh get eaten, the last resort. Golden apples and golden carrots are never eaten
//   3. a farm the agents built, or a chest it knows (one in sight, or by where the job started)
//   4. every grown food animal in sight, nearest first. One it cannot reach is left alone for 3 minutes
//   5. out from under cover, then a walk along wider and wider rings until an animal comes into sight
//
// The search walks and never sprints, because walking costs no hunger and sprinting does. It does not dig or take long
// drops, keeps away from lava and other hazards, and skips a waypoint it cannot reach. The job keeps its progress, so a
// mob can interrupt the mission and it carries on where it was.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { walkTo, guardHazards, rescueMoves, unstick } = require('./move')
const { spiral } = require('./explore')
const { foods, foodInfo, feed, animalsNear, huntOne, gaveUpOn, GIVE_UP_MS } = require('./food')
const { SPRINT_FOOD, LAST_RESORT_FOOD, RAW_NOW_AT, foodValue } = require('./food_plan')
const { canCook, cookSafely } = require('./cook')
const { foodFromFarm, nearestFarm } = require('./farm')
const { findContainers, contents, withdraw } = require('./storage')
const { sleep } = require('./abort')

const SIGHT = 32              // how far it notices an animal, with a clear line from the eye (the same rule as !explore)
const CLOSE_ANIMAL = 10       // an animal in sight this close goes before a walk to the farm or a chest
const EAT_RAW_AT = RAW_NOW_AT // at this food or less it eats raw meat at once, above it the furnace comes first
const LAST_RESORT_AT = SPRINT_FOOD  // raw chicken or rotten flesh only this low: a likely but small hunger effect
const COOK_RETRY_MS = 30000   // raw chicken that would not cook is tried again after this
const RING_STEP = 48          // rings this far apart: with SIGHT on both sides of the walk, each overlaps the last
const MAX_RING = 480          // past this it starts a new set of rings from where it stands
const RING_MARGIN = 5         // explore.js keeps its outer ring this far inside the radius it is given
const FARM_RANGE = 96
const FARM_RETRY_MS = 120000  // a farm with nothing ripe is looked at again after this
const CHEST_RADIUS = 16
const HOME_CHEST_RADIUS = 8
const CHEST_RETRY_MS = 300000 // a chest it looked in is left alone this long
const CHEST_POINTS = 24       // food points it takes from a chest, no more than it needs
const WATCH_TICKS = 10        // how often it looks for an animal while walking
const MAX_FAILS = 4           // waypoints in a row it cannot reach before it gets unstuck and moves on a ring
const CLIMB_RETRY_MS = 60000
const CLIMB_LOOK = 96         // blocks it looks up for the top of the ground above it
// The search before a long dig. A minute covers the first ring of waypoints at a walk, and it goes down after that if it
// has the safe minimum. With less it keeps looking for up to 3 minutes in all, then goes on its food bar, since a world
// with no animals in reach must not stop the job for good, and the food emergency still brings it back up
const DIG_SEARCH_MS = 60000
const DIG_SEARCH_MAX_MS = 180000
const DIG_SIGHT = 20          // an animal this close is worth walking to while it is looking for food

const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const legMs = d => Math.max(15000, Math.min(60000, Math.round(d * 1000)))

function setup (bot, job) {
  if (job.ready) return
  job.ready = true
  job.center = bot.entity.position.clone()
  job.ring = 0
  job.waypoints = []
  job.index = 0
  job.fails = 0
  job.farmAt = 0
  job.climbAt = 0
  job.chests = new Map()
  job.stats = { hunted: 0, ate: 0, rings: 0, waypoints: 0, failed: 0 }
}

// The walking rules of the search: no sprinting, no parkour, short drops, and water only when there is no other way.
// A copy, so the rules of every other job stay as they are
function searchMoves (bot, base) {
  if (!base) return base
  guardHazards(bot, base)
  const m = Object.assign(Object.create(Object.getPrototypeOf(base)), base)
  m.canDig = false
  m.allowSprinting = false
  m.allowParkour = false
  m.maxDropDown = 3
  m.liquidCost = 50
  return m
}

// The next ring out from where the search started, as waypoints from explore.js's spiral (only its outer ring, the
// inner ones were covered by the last ring). Past MAX_RING it starts over around where it stands, so it never runs out
function nextRing (bot, job) {
  if (job.ring >= MAX_RING) {
    job.center = bot.entity.position.clone()
    job.ring = 0
  }
  job.ring += RING_STEP
  const r = job.ring
  job.waypoints = spiral(job.center, r + RING_MARGIN, bot.entity.yaw).filter(p => horizontal(p, job.center) > r - 3)
  job.index = 0
  job.stats.rings++
}

// Under a roof of solid ground: a cave or its own tunnel. No sky light at all, because a thick tree canopy only dims
// it. The Nether and the End have no sky to climb to
function underCover (bot) {
  const dimension = bot.game?.dimension
  if (dimension && !/overworld/.test(dimension)) return false
  const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored())
  return !!head && (head.skyLight ?? 15) === 0
}

// The level just above the highest ground over its head. Trees do not count, it is not climbing one
function skyLevel (bot) {
  const p = bot.entity.position.floored()
  let top = p.y
  for (let y = p.y + 1; y <= p.y + CLIMB_LOOK; y++) {
    const b = bot.blockAt(new Vec3(p.x, y, p.z))
    if (!b) break
    if (b.boundingBox === 'block' && !/_leaves$|_log$/.test(b.name)) top = y
  }
  return top + 1
}

// Animals live on the surface: back to where the job started when it knows that, then straight up, digging through
// natural ground only on the last try (skills/move.js)
async function climbOut (bot, job, token, hooks) {
  if (Date.now() < job.climbAt) return
  job.climbAt = Date.now() + CLIMB_RETRY_MS
  hooks.step(job, 'Under cover with no food, heading up to look for animals')
  const rescue = hooks.rescue ? hooks.rescue() : rescueMoves(bot)
  const log = hooks.log
  if (hooks.home) {
    try {
      await walkTo(bot, new goals.GoalNear(hooks.home.x, hooks.home.y, hooks.home.z, 3), token, { ms: 45000, tries: 1, rescue, log })
    } catch (err) {
      log(`${bot.username} food mission, way back up: ${err.message}`)
    }
  }
  if (token.cancelled || !underCover(bot)) return
  try {
    await walkTo(bot, new goals.GoalY(skyLevel(bot)), token, { ms: 45000, tries: 1, rescue, log })
  } catch (err) {
    log(`${bot.username} food mission, climbing out: ${err.message}`)
  }
}

// A walk that ends early once sees() is true. Returns true when it stopped for that
async function walkWatching (bot, goal, token, ms, sees, log) {
  const leg = { spotted: false, get cancelled () { return token.cancelled || this.spotted } }
  let done = false
  const walking = walkTo(bot, goal, leg, { ms, tries: 0, log }).finally(() => { done = true })
  walking.catch(() => {})
  while (!done && !token.cancelled) {
    await bot.waitForTicks(WATCH_TICKS)
    if (!done && !token.cancelled && sees()) {
      leg.spotted = true
      bot.pathfinder.setGoal(null)
    }
    if (leg.spotted) break
  }
  try {
    await walking
  } catch (err) {
    if (!leg.spotted && !token.cancelled) throw err
  }
  return leg.spotted
}

// One leg of the search. An animal coming into sight ends it, the main loop goes to hunt it
async function searchLeg (bot, job, token, hooks) {
  if (underCover(bot)) {
    await climbOut(bot, job, token, hooks)
    if (token.cancelled) return
  }
  if (job.index >= job.waypoints.length) {
    nextRing(bot, job)
    hooks.step(job, `No food in sight, searching ${job.ring} blocks out`)
  }
  const wp = job.waypoints[job.index]
  if (!wp) {
    await sleep(1000, token)
    return
  }
  hooks.useMoves('search')
  const sees = () => animalsNear(bot, SIGHT, { sight: true }).length > 0
  try {
    const d = horizontal(bot.entity.position, wp)
    const spotted = await walkWatching(bot, new goals.GoalNearXZ(wp.x, wp.z, 3), token, legMs(d), sees, hooks.log)
    if (token.cancelled || spotted) return
    job.index++
    job.fails = 0
    job.stats.waypoints++
  } catch (err) {
    if (token.cancelled) return
    job.index++
    job.fails++
    job.stats.failed++
    hooks.log(`${bot.username} food mission: no way to ${wp.x} ${wp.z}: ${err.message}`)
    if (job.fails >= MAX_FAILS) {
      job.fails = 0
      job.index = job.waypoints.length  // this ring is blocked here, on to the next
      try { await unstick(bot, token, { log: hooks.log }) } catch {}
      await sleep(500, token)
    }
  }
}

// Every grown food animal in sight, one per pass, nearest first. True when it went for one
async function huntInSight (bot, job, token, hooks, radius = SIGHT) {
  const animal = animalsNear(bot, radius, { sight: true })[0]
  if (!animal) return false
  hooks.useMoves('hunt')
  hooks.step(job, `Hunting a ${animal.name.replace(/_/g, ' ')}`, `food-hunt-${animal.name}`)
  const r = await huntOne(bot, animal, token, hooks.log)
  hooks.log(`${bot.username} hunted a ${animal.name}: ${r}`)
  if (token.cancelled) return true
  if (r === 'killed') job.stats.hunted++
  else gaveUpOn(bot).set(animal.id, Date.now() + GIVE_UP_MS)
  return true
}

// Chests it knows: within CHEST_RADIUS with a clear view, and any by where the job started
function knownChests (bot, job, home) {
  const now = Date.now()
  const seen = findContainers(bot, bot.entity.position, CHEST_RADIUS, 8).filter(p => {
    const b = bot.blockAt(p)
    return b && bot.canSeeBlock(b)
  })
  const atHome = home ? findContainers(bot, home, HOME_CHEST_RADIUS, 4) : []
  const out = new Map()
  for (const p of [...seen, ...atHome]) {
    const k = `${p.x},${p.y},${p.z}`
    if ((job.chests.get(k) || 0) <= now) out.set(k, p)
  }
  return [...out.entries()]
}

// What to take from a chest holding have (name to count): the best food first, up to CHEST_POINTS and nothing else
function chestWants (bot, have) {
  const list = [...have.entries()]
    .map(([name, count]) => ({ name, count, f: foodInfo(bot, { name }) }))
    .filter(x => x.f)
    .sort((a, b) => foodValue(b.f) - foodValue(a.f))
  const wants = new Map()
  let left = CHEST_POINTS
  for (const x of list) {
    if (left <= 0) break
    const n = Math.min(x.count, Math.ceil(left / x.f.foodPoints))
    wants.set(x.name, n)
    left -= n * x.f.foodPoints
  }
  return wants
}

async function foodFromChests (bot, job, token, hooks) {
  for (const [k, pos] of knownChests(bot, job, hooks.home)) {
    if (token.cancelled) return false
    job.chests.set(k, Date.now() + CHEST_RETRY_MS)
    try {
      const wants = chestWants(bot, await contents(bot, pos, token))
      if (token.cancelled) return false
      if (!wants.size) continue
      hooks.step(job, `Taking food from the chest at ${pos.x} ${pos.y} ${pos.z}`, 'food-chest')
      await withdraw(bot, pos, wants, token)
    } catch (err) {
      hooks.log(`${bot.username} food mission, chest at ${pos}: ${err.message}`)
    }
    if (foods(bot).length) return true
  }
  return false
}

async function foodFromKnownFarm (bot, job, token, hooks) {
  const farms = hooks.farms()
  if (Date.now() < job.farmAt || !nearestFarm(farms, bot.entity.position, FARM_RANGE)) return false
  job.farmAt = Date.now() + FARM_RETRY_MS
  hooks.step(job, 'Going to the farm for food', 'food-farm')
  hooks.useMoves('build')
  try {
    await foodFromFarm(bot, farms, token, { log: hooks.log, foodPoints: () => foods(bot).reduce((n, x) => n + x.f.foodPoints * x.item.count, 0) })
  } catch (err) {
    hooks.log(`${bot.username} food mission, farm: ${err.message}`)
  }
  return foods(bot).length > 0
}

// Eats or cooks as the food decision says, until the bar is back. A cook that fails still leaves the raw food to eat,
// because the decision then sees no furnace. True when it ate or cooked anything
async function cookAndEat (bot, job, token, hooks) {
  hooks.useMoves('hunt')
  try {
    const r = await feed(bot, token, {
      emergency: true,
      safe: hooks.safe || (() => true),
      work: hooks.work,
      done: hooks.recovered,
      log: hooks.log,
      say: (text, key) => hooks.step(job, text, key)
    })
    job.stats.ate += r.ate
    return r.ate > 0 || r.cooked > 0
  } catch (err) {
    hooks.log(`${bot.username} food mission, eating: ${err.message}`)
    await sleep(1000, token)
    return false
  }
}

// Raw chicken is not on the food list, so the furnace is the way to make it food. True when it cooked something
async function cookChicken (bot, job, token, hooks) {
  if (bot.food <= EAT_RAW_AT || Date.now() < (job.cookAt || 0)) return false
  if (!bot.inventory.items().some(i => i.name === 'chicken') || !canCook(bot, hooks.work)) return false
  job.cookAt = Date.now() + COOK_RETRY_MS
  hooks.useMoves('hunt')
  return await cookSafely(bot, token, { log: hooks.log, say: text => hooks.step(job, text, 'food-cook'), work: hooks.work }) > 0
}

async function eatLastResort (bot, job, token, hooks) {
  if (bot.food > LAST_RESORT_AT) return false
  const bag = bot.inventory.items()
  const item = LAST_RESORT_FOOD.map(name => bag.find(i => i.name === name)).find(Boolean)
  if (!item) return false
  const label = item.name === 'chicken' ? 'raw chicken' : item.name.replace(/_/g, ' ')
  hooks.step(job, `Nothing better, eating ${label}`, 'food-flesh')
  try {
    await bot.equip(item, 'hand')
    await bot.consume()
    job.stats.ate++
  } catch (err) {
    if (!token.cancelled) hooks.log(`${bot.username} food mission, ${label}: ${err.message}`)
    await sleep(1000, token)
  }
  return true
}

// The mission. job keeps its progress across interruptions. hooks: recovered() (true once the bar is back), step(job,
// text, key) (a line for chat), log, farms(), home (where the job started, or null), work (the cook's furnace state),
// moves ({ walk, build }, the agents' walking rules), rescue() (the moves of a last try), safe() (no danger near, a
// furnace stop is allowed). Returns 'recovered' or 'cancelled'
async function foodMission (bot, job, token, hooks) {
  setup(bot, job)
  const search = searchMoves(bot, hooks.moves?.walk)
  const useMoves = kind => {
    const m = kind === 'search' || (kind === 'hunt' && bot.food <= SPRINT_FOOD) ? search : kind === 'build' ? hooks.moves?.build : hooks.moves?.walk
    if (m) bot.pathfinder.setMovements(m)
  }
  const h = { ...hooks, useMoves }
  while (!token.cancelled && !hooks.recovered()) {
    await bot.waitForTicks(1)  // never a pass without giving the game a tick
    if (token.cancelled || hooks.recovered()) break
    if (foods(bot).length || hooks.work?.smelting) {
      if (await cookAndEat(bot, job, token, h)) continue
      if (token.cancelled) break
    }
    if (await cookChicken(bot, job, token, h)) continue
    if (token.cancelled) break
    if (await eatLastResort(bot, job, token, h)) continue
    useMoves('hunt')
    // an animal right here is quicker than any walk to the farm or a chest
    if (!animalsNear(bot, CLOSE_ANIMAL, { sight: true }).length) {
      if (await foodFromKnownFarm(bot, job, token, h)) continue
      if (token.cancelled) break
      useMoves('hunt')
      if (await foodFromChests(bot, job, token, h)) continue
      if (token.cancelled) break
    }
    if (await huntInSight(bot, job, token, h)) continue
    await searchLeg(bot, job, token, h)
  }
  return token.cancelled ? 'cancelled' : 'recovered'
}

// The check before a long dig: a bounded walk on the surface for food, picking up useful things on the way. job keeps its
// progress across a fight or a meal. hooks as for the mission, plus enough() (the reserve is in the bag), safe minimum
// minimum(), collect(token) (wood it can see, for spare tools), and limits { searchMs, maxMs } for tests.
// Returns 'enough', 'minimum', 'limit' (it found too little and goes on its food bar) or 'cancelled'
async function foodBeforeDig (bot, job, token, hooks) {
  setup(bot, job)
  job.spent = job.spent || 0
  const searchMs = hooks.searchMs ?? DIG_SEARCH_MS
  const maxMs = hooks.maxMs ?? DIG_SEARCH_MAX_MS
  const search = searchMoves(bot, hooks.moves?.walk)
  const useMoves = kind => {
    const m = kind === 'search' ? search : kind === 'build' ? hooks.moves?.build : hooks.moves?.walk
    if (m) bot.pathfinder.setMovements(m)
  }
  const h = { ...hooks, useMoves }
  while (!token.cancelled) {
    if (hooks.enough()) return 'enough'
    if (job.spent >= searchMs && hooks.minimum()) return 'minimum'
    if (job.spent >= maxMs) return 'limit'
    const began = Date.now()
    await bot.waitForTicks(1)  // never a pass without giving the game a tick
    useMoves('hunt')
    if (!await foodFromKnownFarm(bot, job, token, h) && !token.cancelled && !await huntInSight(bot, job, token, h, DIG_SIGHT) && !token.cancelled) {
      await hooks.collect?.(token)
      if (!token.cancelled) await searchLeg(bot, job, token, h)
    }
    job.spent += Date.now() - began
  }
  return 'cancelled'
}

module.exports = { foodMission, foodBeforeDig, DIG_SEARCH_MS, DIG_SEARCH_MAX_MS, searchMoves, chestWants, nextRing, underCover, skyLevel, SIGHT, RING_STEP, MAX_RING, EAT_RAW_AT, LAST_RESORT_AT }
