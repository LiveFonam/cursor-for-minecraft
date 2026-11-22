// Cooking raw food in a furnace, the way a player does after a hunt. Cooked meat is worth 2 to 3 times as many food
// points as raw (a steak is 8, raw beef 3), so a short hunt goes much further.
//
// The furnace: an empty one it can see within 24 blocks (one holding anything is somebody's work and is left alone),
// then one it remembers within 48, else the furnace in its bag, else one it crafts from 8 cobblestone (cobbled deepslate
// and blackstone work too) on a crafting table it finds, carries or makes from planks, and picks back up. A furnace it
// placed itself goes back in the bag after. Fuel is coal or charcoal first, then planks, logs and sticks, only as much
// as the food needs, and never the coal the current job still has to smelt with. The smelting itself is the crafter's
// (crafter.js smelt), so a fight in the middle leaves the food in the furnace and the next run takes it back out.
//
// A furnace it cannot reach or that stops working is avoided for 5 minutes, and cooking as a whole waits 30 s, then 60,
// up to 5 minutes, after each failure. The food decision (food_plan.js) sees that as no furnace, so the bot never loops
// on one and eats raw only by the rules there.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goTo } = require('./move')
const { sleep } = require('./human')
const { COOKED, cookGain, MAX_BATCH } = require('./food_plan')

// Items one fuel item cooks (its burn time over the 200 ticks one item takes), best first
const FUEL = [['coal_block', 80], ['coal', 8], ['charcoal', 8], ['blaze_rod', 12]]
const WOOD_FUEL = 1.5
const STICK_FUEL = 0.5
const STONE = ['cobblestone', 'cobbled_deepslate', 'blackstone']
const SEE = 24
const KEEP_LOGS = 2  // the miner keeps 2 logs for a spare pickaxe, so they are the last fuel it burns
const RECALL = 48             // a furnace it used before is worth a walk from this far
const WALK_SPEED = 4.3        // meters a second at a walk
const OPEN_SECONDS = 1        // opening a furnace and filling it
const PLACE_SECONDS = 2       // placing the one from the bag and picking it up again
const CRAFT_SECONDS = 6       // crafting one first
const MAX_FURNACE_TRIES = 2   // furnaces it walks to in one stop before it uses its own
const COOK_RETRY_MS = 30000   // after a failure, doubling each time
const COOK_RETRY_MAX = 300000
const AVOID_MS = 300000       // a furnace that failed is left alone this long
const BUSY_MS = 60000         // one holding somebody's things is looked at again after this
const MAX_COOK_FAILS = 3      // failures in a row before it stops going back for food left in a furnace

const burnOf = name => (FUEL.find(([n]) => n === name)?.[1]) ?? (name === 'stick' ? STICK_FUEL : WOOD_FUEL)
const countOf = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)

// The raw food it carries that cooks, the biggest gain first: [{ name, output, count, gain }]
function rawCarried (bot) {
  const foods = bot.registry.foodsByName || {}
  const out = []
  for (const [name, output] of Object.entries(COOKED)) {
    const count = countOf(bot, name)
    if (!count) continue
    out.push({ name, output, count, gain: cookGain(name, foods) })
  }
  return out.sort((a, b) => b.gain - a.gain)
}

// The fuel it may burn, in the order it burns it: [[name, items one cooks, how many]]. keepCoal is coal the current job
// still needs: it comes off the coal, then the charcoal, then coal blocks (9 coal each)
function fuelStock (bot, keepCoal = 0) {
  // all coal kept: a stop beside a job's furnace, which burns only logs so the next craft keeps its planks and sticks
  if (keepCoal === Infinity) {
    const logs = new Set(bot.inventory.items().filter(i => /_log$/.test(i.name) && !/crimson|warped/.test(i.name)).map(i => i.name))
    return [...logs].map(name => [name, WOOD_FUEL, countOf(bot, name)])
  }
  const keep = {}
  let reserve = keepCoal
  for (const name of ['coal', 'charcoal']) {
    keep[name] = Math.min(countOf(bot, name), reserve)
    reserve -= keep[name]
  }
  keep.coal_block = Math.ceil(reserve / 9)
  const out = FUEL.map(([name, per]) => [name, per, countOf(bot, name) - (keep[name] || 0)])
  const items = bot.inventory.items()
  for (const name of new Set(items.filter(i => /_planks$/.test(i.name)).map(i => i.name))) out.push([name, WOOD_FUEL, countOf(bot, name)])
  out.push(['stick', STICK_FUEL, countOf(bot, 'stick')])
  for (const name of new Set(items.filter(i => /_log$/.test(i.name) && !/crimson|warped/.test(i.name)).map(i => i.name))) out.push([name, WOOD_FUEL, countOf(bot, name) - KEEP_LOGS])
  return out.filter(([, , n]) => n > 0)
}

// Fuel for n items from the bag, as [[name, count]], or null when the bag cannot cook them all
function fuelFor (bot, n, keepCoal = 0) {
  const out = []
  let need = n
  for (const [name, per, have] of fuelStock(bot, keepCoal)) {
    if (need <= 0) break
    const k = Math.min(have, Math.ceil(need / per))
    out.push([name, k])
    need -= k * per
  }
  return need > 0 ? null : out
}

// How many items the fuel it may burn can cook
const fuelItems = (bot, keepCoal = 0) => Math.floor(fuelStock(bot, keepCoal).reduce((n, [, per, have]) => n + per * have, 0))

const posKey = p => `${p.x},${p.y},${p.z}`
const avoided = (work, pos, now = Date.now()) => (work?.avoid?.get(posKey(pos)) || 0) > now

function avoidFurnace (work, pos, until) {
  if (!work.avoid) work.avoid = new Map()
  work.avoid.set(posKey(pos), until)
}

function rememberFurnace (work, pos) {
  if (!work.known) work.known = new Map()
  work.known.set(posKey(pos), pos.clone ? pos.clone() : pos)
}

// A furnace block it can see within reach of a walk and is not avoiding, or null
function furnaceNear (bot, radius = SEE, work = null) {
  const id = bot.registry.blocksByName.furnace.id
  for (const pos of bot.findBlocks({ matching: id, maxDistance: radius, count: 6 })) {
    if (avoided(work, pos)) continue
    const b = bot.blockAt(pos)
    if (b && (pos.distanceTo(bot.entity.position) < 3 || bot.canSeeBlock(b))) return b
  }
  return null
}

// The nearest furnace it used before, within RECALL and not avoided. One whose chunk is not loaded still counts, a
// loaded spot with no furnace left is forgotten
function furnaceRemembered (bot, work) {
  if (!work?.known) return null
  const me = bot.entity.position
  let best = null
  for (const [k, pos] of work.known) {
    const b = bot.blockAt(pos)
    if (b && b.name !== 'furnace') { work.known.delete(k); continue }
    const d = pos.distanceTo(me)
    if (d > RECALL || avoided(work, pos)) continue
    if (!best || d < best.d) best = { pos, d }
  }
  return best ? best.pos : null
}

// Whether the bag can make a furnace: 8 stone and a crafting table, or the wood for one
function canCraftFurnace (bot) {
  const stone = STONE.reduce((n, s) => n + countOf(bot, s), 0)
  if (stone < 8) return false
  const items = bot.inventory.items()
  const table = countOf(bot, 'crafting_table') > 0 || bot.findBlocks({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 6, count: 1 }).length > 0
  const planks = items.filter(i => /_planks$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  const logs = items.filter(i => /_log$/.test(i.name)).reduce((n, i) => n + i.count, 0)
  return table || planks >= 4 || logs >= 1
}

// Where the furnace comes from, in the order it tries them: 'near', 'remembered', 'bag', 'craft', or null
function furnaceSource (bot, work = null) {
  if (furnaceNear(bot, SEE, work)) return 'near'
  if (furnaceRemembered(bot, work)) return 'remembered'
  if (countOf(bot, 'furnace') > 0) return 'bag'
  return canCraftFurnace(bot) ? 'craft' : null
}

// Opens a furnace it did not place and looks: anything in it (food, fuel, a result) is somebody's, so it is not used
async function furnaceIsFree (bot, block, token) {
  await near(bot, block.position, token)
  if (token?.cancelled) return false
  const f = await bot.openFurnace(block)
  try {
    return !f.inputItem() && !f.fuelItem() && !f.outputItem()
  } finally {
    f.close()
  }
}

const keepOf = work => (typeof work?.keepCoal === 'function' ? work.keepCoal() : 0) || 0

// Whether it can cook at least one raw item right now, and why not
function cookCheck (bot, work = null) {
  const raw = rawCarried(bot)
  if (!raw.length) return { ok: false, why: 'no raw food' }
  if (Date.now() < (work?.noCookUntil || 0)) return { ok: false, why: `cooking failed a moment ago (${work.cookWhy})` }
  const source = furnaceSource(bot, work)
  if (!source) return { ok: false, why: 'no furnace and not 8 cobblestone' }
  if (!fuelFor(bot, 1, keepOf(work))) return { ok: false, why: 'no fuel' }
  return { ok: true, source, raw }
}

const canCook = (bot, work = null) => cookCheck(bot, work).ok

// What the food decision needs to know about cooking right now: { possible, why, source, seconds (walk and setup),
// fuelItems, pending (its food is already in a furnace) }. Reads the world but changes nothing
function cookOption (bot, work = {}, now = Date.now()) {
  if (now < (work.noCookUntil || 0)) return { possible: false, why: `cooking failed a moment ago (${work.cookWhy})` }
  const walk = pos => pos.distanceTo(bot.entity.position) / WALK_SPEED + OPEN_SECONDS
  if (work.smelting && work.furnace) return { possible: true, pending: true, source: 'resume', seconds: walk(work.furnace), fuelItems: Infinity }
  const items = fuelItems(bot, keepOf(work))
  if (items < 1) return { possible: false, why: 'no fuel' }
  const seen = furnaceNear(bot, SEE, work)
  if (seen) return { possible: true, source: 'near', seconds: walk(seen.position), fuelItems: items }
  const known = furnaceRemembered(bot, work)
  if (known) return { possible: true, source: 'remembered', seconds: walk(known), fuelItems: items }
  if (countOf(bot, 'furnace') > 0) return { possible: true, source: 'bag', seconds: PLACE_SECONDS, fuelItems: items }
  if (canCraftFurnace(bot)) return { possible: true, source: 'craft', seconds: CRAFT_SECONDS + PLACE_SECONDS, fuelItems: items }
  return { possible: false, why: 'no furnace and not 8 cobblestone' }
}

// The coal the bot's current job still has to smelt with: the craft in progress and the smelt steps left in a plan
function coalForJobs (ctx) {
  const { bot } = ctx
  let smelts = 0
  const job = ctx.manager?.byName?.get('craft')?.job
  if (job && !job.made) {
    try {
      const { planNow } = require('./crafter')
      smelts = planNow(bot, job).steps.filter(s => s.kind === 'smelt').reduce((n, s) => n + s.count, 0)
    } catch {}
  }
  const plan = ctx.plan
  if (plan?.steps) {
    let left = 0
    // one step's words can name several smelts: "smelt 4 raw iron, smelt 4 raw gold, craft ..."
    for (const text of plan.steps.slice(plan.index || 0)) {
      for (const m of text.matchAll(/(?:^|, )smelt (\d+) /g)) left += Number(m[1])
    }
    smelts = Math.max(smelts, left)
  }
  return Math.ceil(smelts / 8)
}

// The cook's state for one bot, kept across runs, with the job's coal protected
function workFor (ctx) {
  const work = ctx.cookWork || (ctx.cookWork = {})
  if (!work.keepCoal) work.keepCoal = () => coalForJobs(ctx)
  return work
}

// Records a failed stop: the furnace is avoided and cooking waits, longer each time. After MAX_COOK_FAILS it also lets
// go of anything left in that furnace, so nothing keeps sending it back
function cookFailed (work, why, now = Date.now()) {
  work.cookFails = (work.cookFails || 0) + 1
  work.cookWhy = why
  work.noCookUntil = now + Math.min(COOK_RETRY_MAX, COOK_RETRY_MS * 2 ** (work.cookFails - 1))
  if (work.furnace) avoidFurnace(work, work.furnace, now + AVOID_MS)
  if (work.cookFails >= MAX_COOK_FAILS) {
    work.smelting = false
    work.furnace = null
    work.furnaceOurs = false
  }
}

// A furnace further than RECALL is not worth the walk (after a death, or a job that moved on). It lets go of it, and
// anything left inside stays there. True when it let go
function letGoFarFurnace (bot, work, log = () => {}) {
  if (!work?.furnace || work.furnace.distanceTo(bot.entity.position) <= RECALL) return false
  if (work.smelting) log(`${bot.username} left food in the furnace at ${work.furnace}, too far to go back`)
  work.furnace = null
  work.smelting = false
  work.furnaceOurs = false
  return true
}

// cookFood that never throws and keeps the failure count. A danger cancelling it is no failure, the next run carries
// on. Returns how many items it cooked
async function cookSafely (bot, token, { log = () => {}, say = () => {}, work = {}, limit = MAX_BATCH } = {}) {
  const pending = !!work.smelting
  try {
    const n = await cookFood(bot, token, { log, say, work, limit })
    if (n > 0 || (pending && !work.smelting)) {
      work.cookFails = 0
      work.noCookUntil = 0
    } else if (!token?.cancelled) {
      cookFailed(work, 'nothing cooked')
    }
    return n
  } catch (err) {
    log(`${bot.username} cooking: ${err.message}`)
    if (!token?.cancelled) cookFailed(work, err.message)
    return 0
  }
}

// An empty furnace to use, seen or remembered. One it cannot reach is avoided, one in use is left alone for a while
async function freeFurnace (bot, work, token, log) {
  for (let i = 0; i < MAX_FURNACE_TRIES; i++) {
    if (token?.cancelled) return null
    const pos = furnaceNear(bot, SEE, work)?.position || furnaceRemembered(bot, work)
    if (!pos) return null
    try {
      await near(bot, pos, token)
      if (token?.cancelled) return null
      const block = bot.blockAt(pos)
      if (block?.name !== 'furnace') {
        work.known?.delete(posKey(pos))
        avoidFurnace(work, pos, Date.now() + BUSY_MS)
        continue
      }
      if (await furnaceIsFree(bot, block, token)) return block.position
      avoidFurnace(work, pos, Date.now() + BUSY_MS)
    } catch (err) {
      if (token?.cancelled) return null
      log(`${bot.username} furnace at ${pos}: ${err.message}`)
      avoidFurnace(work, pos, Date.now() + AVOID_MS)
    }
  }
  return null
}

async function near (bot, pos, token, range = 3) {
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= range + 0.5) return
  await goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), token, 20000)
}

// Crafts a furnace from 8 cobblestone, on a crafting table it finds, carries or makes, and picks a table it placed
// back up
async function craftFurnace (bot, work, token, log) {
  const { planItems, pickUpTable } = require('./craft')
  const { craftStep } = require('./crafter')  // the crafter's way, Mineflayer's own craft sometimes makes nothing on 1.21.11
  const { countItems } = require('./storage')
  const reg = bot.registry
  const tableNear = bot.findBlocks({ matching: reg.blocksByName.crafting_table.id, maxDistance: 6, count: 1 }).length > 0
  if (!tableNear && countOf(bot, 'crafting_table') === 0) {
    const p = planItems(reg, new Map([['crafting_table', 1]]), countItems(bot), { tableNear })
    if (p.missing.size || p.gather.size) throw new Error('I need planks for a crafting table')
    for (const c of p.crafts) await craftStep(bot, c, work, token, log)
  }
  if (token?.cancelled) return false
  await craftStep(bot, { name: 'furnace', times: 1, table: true }, work, token, log)
  await pickUpTable(bot, work, token)
  return countOf(bot, 'furnace') > 0
}

// Places the furnace from its bag on free ground beside it
async function placeFurnace (bot, work, token, log) {
  const { freeSpot } = require('./craft')
  const item = bot.inventory.items().find(i => i.name === 'furnace')
  if (!item) throw new Error('I have no furnace')
  const spot = freeSpot(bot, () => false)
  if (!spot) throw new Error('no free spot for a furnace')
  await near(bot, spot, token)
  await bot.equip(item, 'hand')
  await bot.placeBlock(bot.blockAt(spot.offset(0, -1, 0)), new Vec3(0, 1, 0))
  work.furnace = spot
  work.furnaceOurs = true
  log(`${bot.username} placed a furnace at ${spot}`)
}

// Digs the furnace it placed and picks it up. Only with a pickaxe, the game drops nothing without one
async function pickUpFurnace (bot, work, token) {
  if (!work.furnace || !work.furnaceOurs) return false
  const b = bot.blockAt(work.furnace)
  if (b?.name !== 'furnace') { work.furnace = null; work.furnaceOurs = false; return false }
  const pick = bot.inventory.items().find(i => /_pickaxe$/.test(i.name))
  if (!pick) return false
  await near(bot, b.position, token)
  if (token?.cancelled) return false
  await bot.equip(pick, 'hand')
  await bot.dig(b, true)
  await sleep(300)
  const drop = Object.values(bot.entities || {}).find(e => e.name === 'item' && e.position && e.position.distanceTo(b.position) < 3)
  if (drop) {
    try { await goTo(bot, new (require('./pickup').GoalPickup)(drop.position), token, 5000) } catch {}
  }
  work.furnace = null
  work.furnaceOurs = false
  return true
}

// Cooks the raw food it carries. work keeps the furnace and any smelt in progress across runs (a fight cancels the
// token and the next run carries on). limit: the most items this stop cooks. Returns how many items it cooked
// How many raw items are worth cooking beside a furnace it already has out for a job: a short stop on wood alone, so
// the plan's coal is never touched, and none with a good meal of ready food in the bag
function furnaceCookLimit (bot) {
  const { readyFoods } = require('./food')
  const ready = readyFoods(bot).reduce((n, x) => n + x.f.foodPoints * x.item.count, 0)
  if (ready >= FURNACE_COOK_READY) return 0
  const raw = rawCarried(bot).reduce((n, x) => n + x.count, 0)
  return Math.min(FURNACE_COOK_MAX, raw, fuelItems(bot, Infinity))
}

// After the job's last craft, while its furnace still stands. Returns how many items it cooked
async function cookAtFurnace (bot, job, token, log = () => {}) {
  const limit = furnaceCookLimit(bot)
  if (limit < 1 || token?.cancelled) return 0
  log(`${bot.username} cooking ${limit} raw food in the furnace it has out`)
  return cookSafely(bot, token, { log, work: { furnace: job.furnace, keepCoal: () => Infinity }, limit })
}

async function cookFood (bot, token, { log = () => {}, say = () => {}, work = {}, limit = Infinity } = {}) {
  const { smelt, emptyFurnace } = require('./crafter')
  work.stats = work.stats || { crafted: 0, smelted: 0 }
  // what a fight interrupted: the food and fuel back out of its own furnace first
  letGoFarFurnace(bot, work, log)
  if (work.smelting) await emptyFurnace(bot, work, token)
  const check = cookCheck(bot, work)
  if (!check.ok) return 0
  const keepCoal = keepOf(work)
  if (!work.furnace || bot.blockAt(work.furnace)?.name !== 'furnace') {
    work.furnace = null
    const free = await freeFurnace(bot, work, token, log)
    if (free) {
      work.furnace = free
      work.furnaceOurs = false
      rememberFurnace(work, free)
    } else {
      if (token?.cancelled) return 0
      if (countOf(bot, 'furnace') === 0) {
        if (!canCraftFurnace(bot) || !await craftFurnace(bot, work, token, log)) return 0
      }
      if (token?.cancelled) return 0
      await placeFurnace(bot, work, token, log)
    }
  }
  let cooked = 0
  // one kind at a time (the input slot takes one kind), the fuel counted from the bag as it is after the kind
  // before. A lit fuel item burns on whether food is in or not, so spare is what the fuel already burning can still
  // cook: the fuel lit for a kind (the least that covers it, so all of it gets lit) less what that kind took, less one
  // item for the moments between two kinds
  let spare = 0
  let left = limit
  for (const raw of rawCarried(bot)) {
    if (token?.cancelled || left <= 0) break
    let count = Math.min(raw.count, left)
    const fromBurn = Math.min(count, Math.max(0, Math.floor(spare) - 1))
    let fuel = count > fromBurn ? fuelFor(bot, count - fromBurn, keepCoal) : []
    // not enough fuel for all of it: as many as the fuel covers
    while (!fuel && count - fromBurn > 1) fuel = fuelFor(bot, --count - fromBurn, keepCoal)
    if (!fuel) {
      if (!fromBurn) break
      count = fromBurn
      fuel = []
    }
    say(`Cooking ${count} ${raw.name.replace(/_/g, ' ')}`)
    let ok = false
    try {
      ok = await smelt(bot, { input: raw.name, output: raw.output, count, fuel }, work, token, log)
    } catch (err) {
      // a furnace that stopped: its own food and fuel back in the bag before anything else
      log(`${bot.username} cooking ${raw.name}: ${err.message}`)
      if (!token?.cancelled) { try { await emptyFurnace(bot, work, token) } catch {} }
      break
    }
    if (!ok) break
    cooked += count
    left -= count
    spare = Math.max(0, spare + fuel.reduce((n, [name, k]) => n + burnOf(name) * k, 0) - count)
  }
  if (!token?.cancelled) {
    await pickUpFurnace(bot, work, token)
    // somebody's furnace is looked at again next time, it may be in use by then
    if (!work.furnaceOurs && !work.smelting) work.furnace = null
  }
  return cooked
}

const FURNACE_COOK_MAX = 4     // about 40 s beside the furnace
const FURNACE_COOK_READY = 20  // points of ready food that make the stop not worth it

module.exports = { cookFood, cookSafely, cookAtFurnace, furnaceCookLimit, cookFailed, cookOption, letGoFarFurnace, canCook, cookCheck, rawCarried, fuelFor, fuelItems, furnaceSource, furnaceNear, furnaceRemembered, rememberFurnace, coalForJobs, workFor, COOKED }
