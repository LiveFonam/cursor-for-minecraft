// Food planning: how much food a job needs in the bag before it starts, which food to eat when, and how much a trip
// underground keeps for the way home.
//
// The costs are the game's hunger rules from the Minecraft Wiki's Hunger page (Java Edition): 4 exhaustion empties one
// food point (saturation first), breaking a block costs 0.005, a jump 0.05, sprinting 0.1 per meter, and healing 1
// health costs 6. Walking costs nothing. Health only comes back while the food bar is at 18 or more, which is why a bot
// that is safe keeps it there. Healing is most of what a trip costs, so the plan budgets the health a trip is likely
// to lose, more underground and more the longer it lasts.
//
// The per ore and per minute figures marked as guesses are planning guesses, to be tuned from the live runs.

const { targetDepth } = require('./mine_branch')

const EXHAUSTION_PER_POINT = 4
const COST = { dig: 0.005, jump: 0.05, sprintMeter: 0.1, healHp: 6 }
const REGEN_FOOD = 18        // health comes back at this food level or more
const HUNGRY = 14            // below this it eats whatever the danger (food.js eats the best it has)
const SPRINT_FOOD = 6        // the game allows no sprinting at this food level or less
// The food emergency: no usable food in the bag and the bar at FOOD_EMERGENCY or less. The number comes from the game's
// rules. At 6 or less a player cannot sprint, so it can neither run an animal down nor outrun a mob, and the search has
// to start before that. Sprinting costs 0.1 exhaustion a meter and 4 exhaustion empty one food point, so the 4 points
// from 10 down to 6 buy at least 160 m of sprinting (more with saturation left), and walking costs nothing. It ends at
// FOOD_RECOVERED, the level where the bot stops being hungry, so one small meal does not switch it off and on again.
const FOOD_EMERGENCY = 10
const FOOD_RECOVERED = HUNGRY
// Never eaten and never taken from a chest for hunger: worth far more to the owner than the food points
const PROTECTED_FOOD = new Set(['golden_apple', 'enchanted_golden_apple', 'golden_carrot'])
// Not food for ordinary hunger, because of what it does to the eater. The food emergency may eat the first two as a
// last resort (food_mission.js), raw chicken first: a 30 percent chance of the hunger effect against 80 for rotten flesh
const RISKY_FOOD = new Set(['chicken', 'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])
const LAST_RESORT_FOOD = ['chicken', 'rotten_flesh']
// Guesses: blocks the branch miner digs per ore found at the ore's best depth
const DIG_PER_ORE = { diamond: 120, redstone: 40, lapis: 90, gold: 90, iron: 40, copper: 30, coal: 25, emerald: 200, debris: 250, quartz: 30 }
const SECONDS_PER_DIG = 0.8  // guess: digging plus the walking between digs
const HURT_PER_MINUTE = { deep: 1, surface: 0.5 }  // guess: health lost per minute to mobs, falls and burns
const HEAL_BASE = 10         // one fight's worth of healing, on any trip
const RETURN_MARGIN = 4      // on top of what the way home costs
const GO_DOWN_MARGIN = 10    // food points beyond the way home it wants before it goes back down to work
const DEEP = 8               // a trip more than this many blocks down counts as underground
const STAIR_DIGS = 3         // blocks dug per step of the staircase down
const SURFACE_WALK = 60      // meters it sprints on a surface job

// What a trip costs: { digs, jumps, sprint, minutes, heal, exhaustion, points }. depth is how far down it goes
function tripCost ({ digs = 0, depth = 0, sprint = 0 }) {
  const jumps = depth                      // one jump per step on the way back up
  const allDigs = digs + depth * STAIR_DIGS
  const minutes = allDigs * SECONDS_PER_DIG / 60
  const deep = depth > DEEP
  const heal = HEAL_BASE + minutes * HURT_PER_MINUTE[deep ? 'deep' : 'surface']
  const exhaustion = allDigs * COST.dig + jumps * COST.jump + sprint * COST.sprintMeter + heal * COST.healHp
  return { digs: allDigs, jumps, sprint, minutes: round(minutes), heal: round(heal), exhaustion: round(exhaustion), points: Math.ceil(exhaustion / EXHAUSTION_PER_POINT) }
}

const round = x => Math.round(x * 10) / 10

// The trip a job makes. kind is an ore label (diamond, iron, coal), 'wood' or 'cobblestone'
function jobTrip (bot, kind, count = 1) {
  if (kind === 'wood') return tripCost({ digs: count * 2, sprint: SURFACE_WALK })
  if (kind === 'cobblestone') return tripCost({ digs: Math.ceil(count * 1.3), depth: Math.min(8, Math.ceil(count / 6)) })
  const label = kind === 'diamonds' ? 'diamond' : kind
  const y = Math.floor(bot.entity.position.y)
  const depth = label in DIG_PER_ORE ? Math.max(0, y - targetDepth(bot, label)) : 0
  return tripCost({ digs: count * (DIG_PER_ORE[label] ?? 30), depth })
}

// Food points to carry for a job: what the trip burns and filling its own bar now. The reserve (threats.js FOOD_RESERVE)
// is the floor under this, so only a trip that really burns more raises it
function foodNeed (bot, kind, count = 1) {
  const trip = jobTrip(bot, kind, count)
  return { points: trip.points + Math.max(0, 20 - bot.food), trip }
}

// Food points it keeps for the way home from where it stands (or from at): the climb and one fight's healing, plus a
// margin. Below this a trip underground turns back, and it goes back down only with GO_DOWN_MARGIN more than this
function returnFood (bot, home, at = null) {
  const y = at ? at.y : bot.entity.position.y
  const up = home ? Math.max(0, Math.floor(home.y) - Math.floor(y)) : 0
  const exhaustion = up * COST.jump + HEAL_BASE * COST.healHp
  return Math.ceil(exhaustion / EXHAUSTION_PER_POINT) + RETURN_MARGIN
}

// Eat now? Hungry (below 14) whatever the danger, or safe with room under 18, so it heals and never runs low
function eatReason (bot, safe) {
  if (bot.food < HUNGRY) return 'hungry'
  if (safe && bot.food < REGEN_FOOD) return 'top-up'
  return null
}

// The food to eat for a top-up: the most it can eat without wasting any (points that fit under 20), else the smallest.
// list is food.js foods(bot), best first
function pickTopUp (list, food) {
  const gap = 20 - food
  const fits = list.filter(x => x.f.foodPoints <= gap)
  if (fits.length) return fits[0]
  return list.slice().sort((a, b) => a.f.foodPoints - b.f.foodPoints)[0] || null
}

// ---------- the food decision: eat now, cook first, or keep working ----------
//
// decideFood is pure: it reads numbers and returns a choice, so every rule below is tested without a server.
//
//   1. Ready food (bread, cooked meat, anything that needs no furnace) is always eaten first. Golden food never is.
//   2. Raw food waits for the furnace. Standing by a furnace costs no hunger, so waiting is cheap, and a steak restores
//      16 more points than raw beef for 10 s of furnace time.
//   3. With no danger the bot keeps working until COOK_BY, then makes one short stop to cook a batch.
//   4. Raw food is eaten only when: the bar is at RAW_NOW_AT or less, danger makes a stop unsafe and the bar is at
//      DANGER_RAW_AT or less, cooking is impossible or does not pay and it can no longer sprint or needs to heal, or
//      one bite turns healing back on at critical health. Raw chicken is always the last choice.

// What each raw food cooks into
const COOKED = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  chicken: 'cooked_chicken',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato'
}
const SMELT_SECONDS = 10      // a furnace takes 200 ticks per item
// At 1 the next food point lost is the one that starts starving at 0 (1 health every 4 s), so the bar never waits here
const RAW_NOW_AT = 1
// When to stop work to cook. Above the sprint limit of 6 with 4 points to spare: 160 m of sprinting, the same margin as
// the food emergency, so the cooked food arrives before the bot loses its sprint
const COOK_BY = FOOD_EMERGENCY
// With danger close it cannot stand at a furnace, and it must keep its sprint. 2 points above the limit are 80 m of
// sprinting, enough to get away
const DANGER_RAW_AT = SPRINT_FOOD + 2
const HURT_HEALTH = 14        // below this, food that brings healing back is worth a stop right away
const CRITICAL_HEALTH = 6     // two zombie hits on normal difficulty
const HANDY_SECONDS = 8       // a furnace this close is used for a top-up too, the stop costs almost nothing
const MAX_BATCH = 8           // 80 s at the furnace and up to 64 food points, one short stop
// A trip to the furnace must beat getting more food another way. A cow hunt brings about 3 raw beef (14.4 points) in
// about 30 s, so 0.5 points a second. A planning guess, to be tuned from the live runs
const MIN_GAIN_PER_SECOND = 0.5
const SPRINT_BURN = 0.56      // exhaustion a second at a full sprint (5.6 m/s at 0.1 a meter), the worst case above 6
const SLOW_BURN = 0.05        // exhaustion a second at 6 or less, where it cannot sprint: one jump every second

// The saturation a food really restores. The registry's saturationRatio is twice that (steak 25.6 for a real 12.8),
// and its saturation field is larger still (204.8 for steak), so neither is used directly
const saturationOf = f => (f?.saturationRatio ?? 0) / 2
// What one item restores in all, food points plus saturation
const foodValue = f => f ? f.foodPoints + saturationOf(f) : 0

// How much more one item restores cooked than raw
function cookGain (name, foods) {
  const raw = foods[name]
  const out = foods[COOKED[name]]
  return raw && out ? foodValue(out) - foodValue(raw) : 0
}

// Seconds of work the bar can pay for before it reaches RAW_NOW_AT, counting the worst case burn. Saturation drains
// first, at the rate of the band the bar is in
function waitSeconds (food, saturation = 0) {
  if (food <= RAW_NOW_AT) return 0
  const fast = Math.max(0, food - SPRINT_FOOD) + (food > SPRINT_FOOD ? saturation : 0)
  const slow = Math.max(0, Math.min(food, SPRINT_FOOD) - RAW_NOW_AT) + (food > SPRINT_FOOD ? 0 : saturation)
  return fast * EXHAUSTION_PER_POINT / SPRINT_BURN + slow * EXHAUSTION_PER_POINT / SLOW_BURN
}

// The bag as ready food (best first) and raw food (the biggest cooking gain first)
function splitBag (bag, foods) {
  const counts = new Map()
  for (const { name, count } of bag) counts.set(name, (counts.get(name) || 0) + count)
  const ready = []
  const raw = []
  for (const [name, count] of counts) {
    const f = foods[name]
    if (!f || !count) continue
    if (COOKED[name]) raw.push({ name, count, f, gain: cookGain(name, foods) })
    else if (!PROTECTED_FOOD.has(name) && !RISKY_FOOD.has(name)) ready.push({ name, count, f })
  }
  ready.sort((a, b) => foodValue(b.f) - foodValue(a.f))
  raw.sort((a, b) => b.gain - a.gain)
  return { ready, raw }
}

// The batch for one stop: the biggest gains first, as many as the fuel, MAX_BATCH and the time left allow
function cookBatch (raw, cook, budget) {
  const room = Math.floor((budget - cook.seconds) / SMELT_SECONDS)
  let left = Math.min(MAX_BATCH, Math.floor(cook.fuelItems ?? MAX_BATCH), room)
  const items = []
  let gain = 0
  for (const x of raw) {
    if (left <= 0) break
    const n = Math.min(x.count, left)
    items.push({ name: x.name, count: n })
    gain += n * x.gain
    left -= n
  }
  const count = items.reduce((n, x) => n + x.count, 0)
  return { items, count, gain, seconds: cook.seconds + count * SMELT_SECONDS }
}

const words = name => name.replace(/_/g, ' ')
const RAW_WHY = { starving: 'about to starve', danger: 'danger is close', 'no-furnace': 'no way to cook it', heal: 'I need to heal now' }

// The choice for this moment. state: { food, saturation, health, safe (no danger near), emergency (the food mission is
// running), bag: [{ name, count }], foodsByName (the game's registry), cook: null when it cannot cook, else { possible,
// seconds (the walk and setup before the first item), fuelItems, source, pending (its food is already in a furnace) } }.
// Returns { action: 'eat' | 'cook' | 'wait' | 'none', why, item, raw, count, items, seconds, gain, pending, say }
function decideFood ({ food, saturation = 0, health = 20, safe = true, emergency = false, bag = [], foodsByName = {}, cook = null }) {
  const { ready, raw } = splitBag(bag, foodsByName)
  const hungry = food < HUNGRY
  const hurt = health < HURT_HEALTH && food < 20
  const topUp = safe && food < REGEN_FOOD
  const needs = hungry || hurt || topUp
  const none = why => ({ action: 'none', why, item: null, raw: false, count: 0, say: null })
  const eatRaw = (x, why) => ({ action: 'eat', why, item: x.name, raw: true, count: 1, say: `Eating raw ${words(x.name)}, ${RAW_WHY[why]}` })

  if (ready.length && needs) {
    const pick = hungry || hurt ? ready[0] : pickTopUp(ready, food)
    return { action: 'eat', why: 'ready', item: pick.name, raw: false, count: 1, say: `Eating ${words(pick.name)}` }
  }
  // what a fight left in the furnace comes back first, it is the bot's food whether it is hungry yet or not
  if (safe && cook?.possible && cook.pending) {
    return { action: 'cook', why: 'collect', item: null, raw: false, count: 0, pending: true, seconds: cook.seconds, say: 'Getting my food from the furnace' }
  }
  if (!raw.length) return none(ready.length ? 'not-hungry' : 'no-food')
  if (!needs) return none('not-hungry')

  // raw chicken is the last choice of all (30 percent chance of the hunger effect)
  const byValue = raw.slice().sort((a, b) => foodValue(b.f) - foodValue(a.f))
  const edible = byValue.find(x => x.name !== 'chicken') || null
  const chicken = byValue.find(x => x.name === 'chicken') || null
  const wait = why => ({ action: 'wait', why, item: null, raw: false, count: 0, say: `Saving my ${words((edible || chicken).name)} to cook it` })

  if (!safe) {
    if (edible && (food <= DANGER_RAW_AT || emergency)) return eatRaw(edible, 'danger')
    if (chicken && !edible && food <= SPRINT_FOOD) return eatRaw(chicken, 'danger')
    return wait('danger')
  }
  if (food <= RAW_NOW_AT) return eatRaw(edible || chicken, 'starving')
  // one raw bite that puts the bar back at 18 turns healing on now, and two more hits would kill it
  if (edible && health <= CRITICAL_HEALTH && food + edible.f.foodPoints >= REGEN_FOOD) return eatRaw(edible, 'heal')

  const plan = cook?.possible ? cookBatch(raw, cook, waitSeconds(food, saturation)) : null
  if (plan?.count && plan.gain / plan.seconds >= MIN_GAIN_PER_SECOND) {
    // only a furnace already standing: placing one from the bag for a top-up would stop the job for nothing urgent
    const handy = topUp && (cook.source === 'near' || cook.source === 'remembered') && cook.seconds <= HANDY_SECONDS
    if (food <= COOK_BY || hurt || emergency || handy) {
      const what = plan.items.length === 1 ? words(plan.items[0].name) : 'raw food'
      return { action: 'cook', why: 'cook', item: plan.items[0].name, raw: false, count: plan.count, items: plan.items, seconds: plan.seconds, gain: plan.gain, source: cook.source, say: `Cooking ${plan.count} ${what} first` }
    }
    return wait('keep-working')
  }
  // cooking is impossible or does not pay
  if (edible && (emergency || hurt || food <= SPRINT_FOOD)) return eatRaw(edible, 'no-furnace')
  if (chicken && !edible && food <= SPRINT_FOOD) return eatRaw(chicken, 'no-furnace')
  return wait('no-furnace')
}

module.exports = { tripCost, jobTrip, foodNeed, returnFood, eatReason, pickTopUp, decideFood, waitSeconds, cookGain, saturationOf, foodValue, COOKED, SMELT_SECONDS, RAW_NOW_AT, COOK_BY, DANGER_RAW_AT, HURT_HEALTH, CRITICAL_HEALTH, HANDY_SECONDS, MAX_BATCH, MIN_GAIN_PER_SECOND, COST, DIG_PER_ORE, REGEN_FOOD, HUNGRY, SPRINT_FOOD, FOOD_EMERGENCY, FOOD_RECOVERED, PROTECTED_FOOD, RISKY_FOOD, LAST_RESORT_FOOD, GO_DOWN_MARGIN, EXHAUSTION_PER_POINT }
