// Scripted mining with mineflayer-pathfinder and bot.dig. Two strategies, picked by job.strategy:
//
//   tunnel  the baseline for the mining benchmark (agents.js --miner tunnel). It goes for ore it could
//        plausibly know about (an open face it can see now or saw earlier) and otherwise strip
//        mines one tunnel with the odd turn, down a staircase to the ore's usual height first.
//   branch  branch mining at each ore's 1.21 depth, caving for iron, coal and copper, surface walks for logs and sand,
//        lava, gravel and drop safety, torches on the right wall, and the haul stored in a chest at home
//        (skills/mine_branch.js). It only mines ore with an exposed face it can see.
//
// Neither ever scans the whole loaded world for ore, which would read as X-ray. Both fill job.stats for the
// benchmark: blocks dug, ores mined, torches, stuck events, failed paths and lava blocked off.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep } = require('./human')
const { goTo, walkOnly, walkOnlyMoves, dropDigMoves } = require('./move')
const { digHazard } = require('../hazards')
const { isMarkedOre } = require('./ore_marks')
const { canFlow, findKnownOre, inPickupBox, pickupSpot, preAim } = require('./motion')
const { bestPickaxeItem } = require('./gather_kinds')
const { GoalPickup, pickUpDrops } = require('./pickup')

const SEE_RADIUS = { off: 24, light: 20, full: 16 }
const REACH = 4.4             // a little under the server's 4.5 block reach
const MAX_EXPLORE = 400      // blocks of tunnel before giving up
const DROP_WAIT_MS = 350
const DROP_APPEAR_TICKS = 10  // a broken block's drop shows up within this
const DROP_SHOW_TICKS = 4     // after collecting an older drop, how long this block's own may still take to land
const DROP_WALK_TICKS = 60     // on one drop, then it counts as out of reach and the next one gets its turn
const DROP_ALL_TICKS = 240    // for everything lying around one spot
const DROP_ALL_MS = 12000     // the same limit in real time, since a walk around something can take seconds
const DROP_BOX_TICKS = 14     // in pickup range, an item can still be on its short pickup delay
const DROP_PATH_MS = 3000     // a drop further than a short walk around something is left behind
const DROP_DIG_BLOCKS = 3     // the most it opens to get to one drop of its own
const DROP_DIG_MS = 6000      // the dig and the step together, then the drop counts as out of reach
const DROP_PLAN_MS = 40       // the path search for that, short enough not to show
const BAG_SETTLE_TICKS = 4    // how long a picked up item can take to show in the bag
const OWED_SEARCH = 8         // a drop that rolled this far from its block still counts as that block's drop
const OWED_NEAR = 6           // further than this from a drop it can see, it walks over first (a drop's own walk is short)
const OWED_SIGHT = 24         // within this the game shows every drop, so one not shown is gone. Further off it goes to look
const OWED_BACK_MS = 15000    // the walk back after a fight
const OWED_LIFE_MS = 280000   // the game removes a drop after five minutes
const OWED_SETTLE_TICKS = 6   // a drop still in the air is not judged out of range yet
// A bot does not need to see, so torches only mark a long tunnel: none on a short trip, then one per this many blocks
const TORCH_EVERY = 32
const torchGapFor = human => Math.max(TORCH_EVERY, human?.nextTorchGap?.() ?? TORCH_EVERY)

// Blocks of tunnel for the torch rule. A cell counts the first time it is entered, so walking back through its own
// tunnel never earns another torch. stats.tunnel is what the live scenes hold the server's torch count against
function countTunnel (ctx, cell, blocks = 1) {
  const seen = ctx.tunnelCells || (ctx.tunnelCells = new Set())
  const k = `${cell.x},${cell.y},${cell.z}`
  if (seen.has(k)) return
  seen.add(k)
  ctx.sinceTorch += blocks
  if (ctx.stats) ctx.stats.tunnel = (ctx.stats.tunnel || 0) + blocks
}

// A torch went up: the job's log keeps how many blocks of tunnel it closed, and the count starts over
function torchPlaced (ctx) {
  if (ctx.stats) {
    ctx.stats.torches++
    ctx.stats.torchGaps = [...(ctx.stats.torchGaps || []), ctx.sinceTorch]
  }
  ctx.sinceTorch = 0
  ctx.torchGap = torchGapFor(ctx.human)
}

// where each ore is most common (Minecraft 1.18 and later), for the tunnelling
const BEST_Y = {
  diamond: -58, redstone: -58, lapis: 0, gold: -16, iron: 16, copper: 48, coal: 48, emerald: 100, quartz: null, debris: 15
}
const PICKAXES = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe']
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

class MineError extends Error {}

// Ore it can see from here or saw earlier, nearest first
function visibleTargets (bot, ids, human) {
  return findKnownOre(bot, ids, SEE_RADIUS[human.level] ?? 20)
}

// The best tool it carries for this block, or a reason it has none
function pickTool (bot, block) {
  const items = bot.inventory.items()
  const need = block.harvestTools ? Object.keys(block.harvestTools).map(Number) : null
  const usable = need ? items.filter(i => need.includes(i.type)) : items
  if (need && !usable.length) {
    const hasPick = items.some(i => i.name.endsWith('_pickaxe'))
    return { error: hasPick ? `my pickaxe is too weak for ${block.name.replace(/_/g, ' ')}` : 'I have no pickaxe' }
  }
  let best = null
  let bestTime = block.digTime(null, false, false, false, [], [])
  for (const item of usable) {
    const t = block.digTime(item.type, false, false, false, [], bot.entity.effects ? Object.values(bot.entity.effects) : [])
    if (t < bestTime) { best = item; bestTime = t }
  }
  return { item: best }
}

const WEARS_OUT = /_(pickaxe|axe|shovel|hoe|sword)$|^(shears|flint_and_steel)$/

// A tool loses durability on every block it breaks, so one that would not dig this block any faster leaves the hand:
// dirt is dug by hand unless there is a shovel. It wraps bot.dig, so every job and the pathfinder follow the rule
function keepToolsForTheirBlocks (bot) {
  if (!bot.dig || bot.digKeepsTools) return
  bot.digKeepsTools = true
  const dig = bot.dig.bind(bot)
  bot.dig = (block, ...rest) => {
    try {
      const pick = pickTool(bot, block)
      if (!pick.error && !pick.item && WEARS_OUT.test(bot.heldItem?.name || '')) {
        const start = bot.inventory.hotbarStart ?? 36
        for (let i = 0; i < 9; i++) {
          const item = bot.inventory.slots?.[start + i]
          if (!item || !WEARS_OUT.test(item.name)) {
            bot.setQuickBarSlot(i)
            break
          }
        }
      }
    } catch {}  // choosing a hand must never stop the dig itself
    return dig(block, ...rest)
  }
}

async function equipFor (bot, block) {
  const pick = pickTool(bot, block)
  if (pick.error) throw new MineError(pick.error)
  if (pick.item && bot.heldItem?.type !== pick.item.type) await bot.equip(pick.item, 'hand')
}

const dropsNear = (bot, pos) => Object.values(bot.entities)
  .filter(e => e.name === 'item' && e.position.distanceTo(pos) < 4)
  .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))

// The items lying around right now, taken before a dig: anything new after it is that block's own drop
const itemIds = bot => new Set(Object.values(bot.entities).filter(e => e.name === 'item').map(e => e.id))

// What a job digs for: the items its blocks drop, and only while the bag is still short of them
function dropFilter (bot, job) {
  const reg = bot.registry
  const names = new Set(job.blocks.flatMap(n => (reg.blocksByName[n]?.drops || [])
    .map(d => reg.items[typeof d === 'number' ? d : d?.drop?.id ?? d?.drop]?.name)).filter(Boolean))
  const own = e => {
    try { return names.has(e.getDroppedItem?.()?.name) } catch { return false }
  }
  const wants = e => !(job.inBag && job.inBag() >= job.want) && own(e)
  wants.own = own  // the block's own drop, whatever the bag holds
  return wants
}

// A job with a bag target (job.want, job.inBag) is judged by the bag. Every block it counted is broken and the bag is
// still short: a drop was truly lost, so the job takes that many more blocks, at most max(2, want) extra in all. The bag's
// count can trail the pickup by a tick or two, so a short bag gets a moment before it counts as a lost drop
async function bagShort (bot, job, token) {
  if (!job.inBag) return false
  for (let i = 0; i < BAG_SETTLE_TICKS && job.inBag() < job.want && !token.cancelled; i++) await bot.waitForTicks(1)
  const short = job.want - job.inBag()
  if (short <= 0) return false
  const room = job.want + Math.max(2, job.want) - job.count
  if (room <= 0) return false
  job.count += Math.min(short, room)
  return true
}

// False only when the path search is sure there is no way there on foot
function mayWalkTo (bot, at) {
  try {
    return bot.pathfinder.getPathTo(walkOnlyMoves(bot), new GoalPickup(at), DROP_PLAN_MS)?.status !== 'noPath'
  } catch {
    return true
  }
}

// No walking way to a drop: the hole an ore leaves at head height has a solid floor, so the bot cannot stand in it and the
// drop can lie past its pickup range. The cheapest way in that opens at most DROP_DIG_BLOCKS of natural ground and builds
// nothing, usually the one block under the first hole. True when it got there. note(why): told why it did not
async function digToDrop (bot, at, token, ms, note = () => {}) {
  const goal = new GoalPickup(at)
  const moves = dropDigMoves(bot)
  let plan
  try {
    plan = bot.pathfinder.getPathTo(moves, goal, DROP_PLAN_MS)
  } catch (err) {
    note(`path search threw ${err.message}`)
    return false
  }
  if (plan?.status !== 'success') {
    note(`path ${plan?.status ?? 'none'}`)
    return false
  }
  const opens = plan.path.reduce((n, m) => n + (m.toBreak?.length || 0), 0)
  const places = plan.path.reduce((n, m) => n + (m.toPlace?.length || 0), 0)
  if (opens > DROP_DIG_BLOCKS || places) {
    note(`path opens ${opens} blocks, places ${places}`)
    return false
  }
  const before = bot.pathfinder.movements
  const ends = Date.now() + ms
  const limit = setTimeout(() => { try { bot.stopDigging() } catch {} }, ms)
  try {
    // the first block goes at once, as the next dig of the chain, so there is no stop while a walk gets going
    for (const c of plan.path[0]?.toBreak || []) {
      if (!await clearBlock(bot, new Vec3(c.x, c.y, c.z), token)) {
        note(`could not open ${c.x} ${c.y} ${c.z}`)
        return false
      }
    }
    if (token.cancelled) return false
    // one step in a straight line now: the caller's walk takes it without the stop at the end of a path
    if (pickupSpot(bot, before || moves, at)) return true
    bot.pathfinder.setMovements(moves)
    await goTo(bot, goal, token, Math.max(250, ends - Date.now()))
    return !token.cancelled
  } catch (err) {
    note(`walk failed: ${err.message}`)
    return false
  } finally {
    clearTimeout(limit)
    if (bot.pathfinder.movements !== before) bot.pathfinder.setMovements(before)
  }
}

// Walks to where the game hands over the drops of the block it just broke, without stopping first, and goes on as soon as
// they are in its bag. A drop in a hole in the wall is picked up from the cell in front of it. A walk never digs or
// builds for a drop, which is how a row of ore used to turn into a mess of holes.
// digNext: another block is about to be dug from here, and the game hands the drop over during that dig.
// settled: the block broke a while ago, so a drop that is not there has already been picked up.
// known: the items from before the dig, so it waits for this block's own drop and not just for any.
// digFor(entity): a drop worth opening a block for when there is no walking way to it (never while digNext).
// dug: drops already dug for, kept by the caller across calls. enough(): the bag holds all it wants, nothing to wait for
async function walkOntoDrops (bot, pos, token, { digNext = false, settled = false, known = null, digFor = null, dug = new Set(), enough = null, log = null } = {}) {
  let seen = settled
  let sawOwn = false
  let waited = 0
  let idle = 0
  let inBox = 0
  let current = null
  let onThis = 0
  const left = new Set()      // out of reach: it stays behind, and the others are still collected
  const searched = new Set()
  const digNotes = new Map()  // why a dig for this drop did not get it
  const until = Date.now() + DROP_ALL_MS
  // the world is restored after a live scene, so this line is the only record of where a lost drop lay
  const giveUp = (e, why) => {
    left.add(e.id)
    let name = 'item'
    try { name = e.getDroppedItem?.()?.name || name } catch {}
    const at = q => `${q.x.toFixed(2)} ${q.y.toFixed(2)} ${q.z.toFixed(2)}`
    const dig = digNotes.get(e.id) || (dug.has(e.id) ? 'already tried' : null)
    log?.(`${bot.username} left a drop behind (${why}): ${name} at ${at(e.position)}, bot at ${at(bot.entity.position)}${dig ? `, dig: ${dig}` : ''}`)
  }
  try {
    // this block's own drop will land past its reach with no way there on foot: the next dig starts now, as the chain's
    // next block, instead of after a stop to watch the drop land
    if (known && digFor && !digNext && !settled && !enough?.()) {
      const at = pos.offset(0, -0.4, 0)
      const moves = bot.pathfinder.movements
      // with nothing solid under the block its drop falls, usually toward the bot, so that one is watched and not dug for
      const rests = bot.blockAt(pos.offset(0, -1, 0).floored())?.boundingBox === 'block'
      if (rests && !inPickupBox(bot.entity.position, at) && !(moves && pickupSpot(bot, moves, at)) && !mayWalkTo(bot, at)) {
        const watch = () => { if (dropsNear(bot, pos).some(e => !known.has(e.id))) sawOwn = true }
        bot.on('physicsTick', watch)
        try {
          await digToDrop(bot, at, token, DROP_DIG_MS)
        } finally {
          bot.removeListener('physicsTick', watch)
        }
      }
    }
    for (let t = 0; t < DROP_ALL_TICKS && Date.now() < until && !token.cancelled; t++) {
      const near = dropsNear(bot, pos)
      if (known && near.some(e => !known.has(e.id))) sawOwn = true
      // the bag has what the job came for: a block's stray cobblestone is no reason to stand and wait
      if (!digNext && enough?.()) return
      const open = near.filter(e => !left.has(e.id))
      // a drop it wants and cannot pick up from here goes first: one it stands next to is handed over by the game anyway
      const drop = (!digNext && digFor && open.find(e => digFor(e) && !inPickupBox(bot.entity.position, e.position))) || open[0]
      if (!drop) {
        // on a real server a drop shows up a tick or two after the block goes: the next dig does not wait for it
        if (digNext || settled) return
        // the drop just collected may be the one from the block before: this block's own can land a few ticks later
        if (known) {
          if (sawOwn || ++waited >= DROP_APPEAR_TICKS) return
        } else if (seen ? ++idle >= DROP_SHOW_TICKS : ++waited >= DROP_APPEAR_TICKS) return
        await bot.waitForTicks(1)
        continue
      }
      seen = true
      idle = 0
      if (drop.id !== current) {
        current = drop.id
        onThis = 0
        inBox = 0
      }
      if (++onThis > DROP_WALK_TICKS) {
        giveUp(drop, 'walk took too long')
        continue
      }
      const p = bot.entity.position
      const d = drop.position
      if (inPickupBox(p, d)) {
        bot.setControlState('forward', false)
        if (digNext) return
        if (++inBox > DROP_BOX_TICKS) giveUp(drop, 'in range but not handed over')
        else await bot.waitForTicks(1)
        continue
      }
      inBox = 0
      const moves = bot.pathfinder.movements
      const spot = moves ? pickupSpot(bot, moves, d) : null
      if (!spot) {
        bot.setControlState('forward', false)
        if (!searched.has(drop.id)) {
          searched.add(drop.id)
          // asked in this tick, so a drop with no walking way to it costs no wait for a path that will fail
          if (mayWalkTo(bot, d)) {
            try {
              await walkOnly(bot, new GoalPickup(d), token, DROP_PATH_MS)
              continue
            } catch {}
          }
        }
        if (token.cancelled) return  // interrupted is not given up: the drop stays owed
        const ms = Math.min(DROP_DIG_MS, until - Date.now())
        if (!digNext && !dug.has(drop.id) && ms > 500 && digFor?.(drop)) {
          dug.add(drop.id)
          if (await digToDrop(bot, d, token, ms, why => digNotes.set(drop.id, why))) {
            digNotes.set(drop.id, 'opened the way, still could not reach it')
            onThis = 0
            continue
          }
          if (token.cancelled) {
            dug.delete(drop.id)  // it gets its real try when the danger is over
            return
          }
        }
        giveUp(drop, 'no way to it')
        continue
      }
      bot.setControlState('forward', true)
      Promise.resolve(bot.look(Math.atan2(-(spot.x - p.x), -(spot.z - p.z)), 0.3, false)).catch(() => {})
      await bot.waitForTicks(1)
    }
  } finally {
    bot.setControlState('forward', false)
  }
}

// Picks up drops around a spot
async function collectAround (bot, pos, token, flow = {}) {
  if (canFlow(bot)) return walkOntoDrops(bot, pos, token, flow)
  await pickUpDrops(bot, pos, token, { settleMs: DROP_WAIT_MS, limitMs: DROP_ALL_MS })
}

// Game ticks seen by this bot, for how long a drop has been in the air
function dropTicks (bot) {
  if (!bot._dropTicks) {
    const count = { n: 0 }
    bot._dropTicks = count
    bot.on('physicsTick', () => { count.n++ })
  }
  return bot._dropTicks.n
}

// Every block a job breaks for its drop is owed until that drop was fetched or truly given up on, and stays owed through
// a fight: ctx lives on the job, so the job goes back for it when it resumes
function oweDrop (bot, ctx, at, known = null) {
  const spot = { at, known, since: Date.now(), tick: dropTicks(bot) }
  ;(ctx.owed || (ctx.owed = [])).push(spot)
  return spot
}

function settleDrop (ctx, spot) {
  ctx.owed = (ctx.owed || []).filter(s => s !== spot)
}

const ownDrops = (bot, ctx, spot) => Object.values(bot.entities).filter(e => e.name === 'item' && !spot.known?.has(e.id) &&
  e.position.distanceTo(spot.at) < OWED_SEARCH && (ctx.wantsDrop?.own || ctx.wantsDrop)?.(e))

// Fetches what is owed. strayOnly: just the drops that have landed out of pickup range, before the next dig of a chain
// (one in range is handed over during that dig, so the chain keeps its flow)
async function collectOwed (bot, ctx, token, { strayOnly = false } = {}) {
  for (const spot of (ctx.owed || []).slice()) {
    if (token.cancelled) return
    const age = Date.now() - spot.since
    if (age > OWED_LIFE_MS) {
      ctx.log?.(`${bot.username} left a drop behind (despawned while away) at ${spot.at}`)
      settleDrop(ctx, spot)
      continue
    }
    let drops = ownDrops(bot, ctx, spot)
    if (strayOnly && (dropTicks(bot) - spot.tick < OWED_SETTLE_TICKS || !drops.some(e => !inPickupBox(bot.entity.position, e.position)))) continue
    const target = drops[0]?.position || spot.at
    if (bot.entity.position.distanceTo(target) > (drops.length ? OWED_NEAR : OWED_SIGHT)) {
      try {
        await goTo(bot, new goals.GoalNear(target.x, target.y, target.z, 2), token, OWED_BACK_MS)
      } catch (err) {
        if (token.cancelled) return
        ctx.log?.(`${bot.username} left a drop behind (no way back) at ${spot.at}: ${err.message}`)
        settleDrop(ctx, spot)
        continue
      }
      if (token.cancelled) return
      drops = ownDrops(bot, ctx, spot)
    }
    const around = drops[0] && drops[0].position.distanceTo(spot.at) >= 4 ? drops[0].position : spot.at
    const enough = ctx.bagDone ? () => ctx.bagDone() && !ownDrops(bot, ctx, spot).length : null
    await collectAround(bot, around, token, { settled: true, digFor: ctx.wantsDrop?.own || ctx.wantsDrop, dug: ctx.dugFor, enough, log: ctx.log })
    if (token.cancelled) return
    settleDrop(ctx, spot)
  }
}

async function placeTorch (bot, ctx) {
  const torch = bot.inventory.items().find(i => i.name === 'torch')
  if (!torch) return false
  const feet = bot.entity.position.floored()
  const here = bot.blockAt(feet)
  const floor = bot.blockAt(feet.offset(0, -1, 0))
  if (!here || here.boundingBox !== 'empty' || here.name !== 'air' && here.name !== 'cave_air') return false
  if (!floor || floor.boundingBox !== 'block') return false
  const light = here.light ?? 15
  const sky = here.skyLight ?? 15
  if (Math.max(light, sky) >= 8) return false
  try {
    await bot.equip(torch, 'hand')
    await bot.placeBlock(floor, new Vec3(0, 1, 0))
    torchPlaced(ctx)
    return true
  } catch (err) {
    return false
  }
}

const AIR = new Set(['air', 'cave_air', 'void_air'])
const LIQUID = new Set(['lava', 'water', 'flowing_lava', 'flowing_water'])
const CARDINAL = [[0, -1], [1, 0], [0, 1], [-1, 0]]  // yaw 0 faces -z in Mineflayer
const FALLS = /^(gravel|sand|red_sand|suspicious_sand|suspicious_gravel)$|_concrete_powder$/

// Lava or water in or next to a block it is about to open
function liquidNear (bot, pos) {
  for (const [dx, dy, dz] of [[0, 0, 0], ...DIRS]) {
    const b = bot.blockAt(pos.offset(dx, dy, dz))
    if (b && LIQUID.has(b.name)) return true
  }
  return false
}

async function clearBlock (bot, pos, token) {
  for (let i = 0; i < 6 && !token.cancelled; i++) {  // gravel and sand fall back in
    const b = bot.blockAt(pos)
    // anything but air gets dug: snow layers, grass and flowers count as passable in the block data, and a snow
    // layer still held the bot up in the live test
    if (!b || AIR.has(b.name)) return true
    if (!b.diggable || LIQUID.has(b.name) || digHazard(bot, b)) return false
    // the drop does not matter here, only that the block goes (snow wants a shovel to drop anything)
    const pick = pickTool(bot, b)
    if (pick.item && bot.heldItem?.type !== pick.item.type) await bot.equip(pick.item, 'hand')
    const above = bot.blockAt(pos.offset(0, 1, 0))?.name
    await bot.dig(b, true)
    // only a block that can fall back in is worth waiting for
    if (!canFlow(bot) || FALLS.test(above || '')) await sleep(80)
  }
  return false
}

// One block of tunnel, the way a player strip mines: dig the head and feet blocks ahead (and the one below them
// while going down a staircase), step in, then look around for ore again. Lava, water or a drop ahead turns it.
// Pathfinder could not plan long digs through solid rock (every 10 block stretch timed out in the live test)
async function exploreStep (bot, ctx, token) {
  if (ctx.heading === undefined) ctx.heading = bot.entity.yaw
  if (Math.random() < 0.08) ctx.heading += (Math.random() < 0.5 ? -1 : 1) * Math.PI / 2  // the odd side turn
  const quarter = ((Math.round(ctx.heading / (Math.PI / 2)) % 4) + 4) % 4
  const [dx, dz] = CARDINAL[quarter]
  const feet = bot.entity.position.floored()
  const best = BEST_Y[ctx.label]
  const down = best !== null && best !== undefined && feet.y > best + 2
  const ahead = feet.offset(dx, 0, dz)
  const target = down ? ahead.offset(0, -1, 0) : ahead
  const open = down ? [ahead.offset(0, 1, 0), ahead, target] : [ahead.offset(0, 1, 0), ahead]
  const floor = bot.blockAt(target.offset(0, -1, 0))
  const blocked = open.some(p => liquidNear(bot, p)) || !floor || floor.boundingBox !== 'block' || LIQUID.has(floor.name)
  if (blocked) {
    ctx.heading += (Math.random() < 0.5 ? -1 : 1) * Math.PI / 2
    ctx.turns = (ctx.turns || 0) + 1
    if (ctx.turns > 6) throw new Error('lava, water or a drop on every side')
    return
  }
  ctx.turns = 0
  for (const p of open) {
    if (!await clearBlock(bot, p, token)) {
      ctx.heading += Math.PI / 2
      throw new Error(`could not dig ${bot.blockAt(p)?.name ?? 'a block'} ahead`)
    }
  }
  await stepInto(bot, target, token)
  countTunnel(ctx, target)
  ctx.tunnelled = (ctx.tunnelled || 0) + 1
  if (ctx.tunnelled % 10 === 0) ctx.log?.(`${bot.username} has tunnelled ${ctx.tunnelled} blocks, now at ${bot.entity.position.floored()}`)
}

// Water got in: walk back along its own tunnel to the last dry cell and turn away from the water
async function backOut (bot, ctx, token) {
  ctx.say?.('Water in my tunnel, backing out')
  const trail = bot.trail || []
  while (trail.length && bot.entity.isInWater && !token.cancelled) {
    const cell = trail.pop()
    try { await stepInto(bot, cell, token) } catch { break }
  }
  if (bot.entity.isInWater) {
    // no trail left: swim straight up and let the pathfinder find dry ground nearby
    bot.setControlState('jump', true)
    await bot.waitForTicks(20)
    bot.setControlState('jump', false)
  }
  ctx.heading = (ctx.heading ?? bot.entity.yaw) + Math.PI
}

// Walks into the next tunnel cell: steers at its centre every tick and lets go once over it, so it drops down a
// staircase step instead of resting on the edge of the block beyond (pathfinder timed out even on one block here)
async function stepInto (bot, cell, token) {
  // clearing a goal also lets go of every key, so only when there is one
  if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
  const c = cell.offset(0.5, 0, 0.5)
  try {
    for (let t = 0; t < 60 && !token.cancelled; t++) {
      const p = bot.entity.position
      const dh = Math.hypot(p.x - c.x, p.z - c.z)
      if (dh < 0.25) {
        bot.setControlState('forward', false)
        if (Math.abs(p.y - c.y) < 0.6 && bot.entity.onGround) {
          if (bot.trail) {
            bot.trail.push(cell.clone())
            if (bot.trail.length > 60) bot.trail.shift()
          }
          return
        }
      } else {
        // the body turns now and the camera follows at its own pace, so waiting for the look would only stop the walk
        Promise.resolve(bot.look(Math.atan2(-(c.x - p.x), -(c.z - p.z)), 0, false)).catch(() => {})
        bot.setControlState('forward', true)
      }
      await bot.waitForTicks(1)
    }
  } finally {
    bot.setControlState('forward', false)
  }
  if (!token.cancelled) {
    const p = bot.entity.position
    const names = [0, 1].map(dy => bot.blockAt(cell.offset(0, dy, 0))?.name).join(' and ')
    throw new Error(`could not step into the tunnel at ${cell} (${names}), stuck at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`)
  }
}

// Mines one block of the wanted kind. Returns 'mined', or 'none' after MAX_EXPLORE blocks of tunnel with nothing seen
async function mineOne (bot, ctx, token) {
  const { ids, human } = ctx
  for (let explored = 0; explored <= MAX_EXPLORE && !token.cancelled; explored++) {
    if (bot.entity.isInWater) await backOut(bot, ctx, token)
    if (bot.inventory.emptySlotCount() === 0) return 'full'
    const targets = visibleTargets(bot, ids, human).filter(p => !ctx.skip.has(p.toString()))
    if (!targets.length) {
      if (explored === MAX_EXPLORE) return 'none'
      if (!ctx.saidSearching) {
        ctx.say?.(`I don't see any ${ctx.label} yet, digging around for it`)
        ctx.saidSearching = true
      }
      // a pickaxe in hand before tunnelling, if it has one
      const pick = bestPickaxeItem(bot.inventory.items())
      if (pick && bot.heldItem?.type !== pick.type) await bot.equip(pick, 'hand')
      await exploreStep(bot, ctx, token)
      if (human.placesTorches && ctx.sinceTorch >= ctx.torchGap) await placeTorch(bot, ctx)
      continue
    }
    const pos = targets[0]
    if (liquidNear(bot, pos)) {
      // opening it would flood the tunnel (a bot drowned this way in the live test)
      ctx.skip.add(pos.toString())
      continue
    }
    ctx.log?.(`${bot.username} sees ${ctx.label} at ${pos}`)
    const block = bot.blockAt(pos)
    if (!block || !ids.includes(block.type)) continue
    await equipFor(bot, block)
    const start = bot.entity.position.clone()
    const inReach = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= REACH
    try {
      // ore in reach (most ore in a tunnel wall) is dug from where it stands: the pathfinder timed out on these
      if (!inReach()) {
        preAim(bot, pos.offset(0.5, 0.5, 0.5))
        await goTo(bot, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), token)
      }
    } catch (err) {
      // an ore it cannot reach is left alone from now on, so it does not walk at it forever
      ctx.skip.add(pos.toString())
      if (ctx.stats) ctx.stats.pathFails++
      ctx.log?.(`${bot.username} gives up on ${ctx.label} at ${pos}: ${err.message}`)
      continue
    } finally {
      preAim(bot, null)
    }
    if (token.cancelled) return 'cancelled'
    countTunnel(ctx, bot.entity.position.floored(), Math.round(start.distanceTo(bot.entity.position)))
    const again = bot.blockAt(pos)
    if (!again || !ids.includes(again.type)) continue
    if (digHazard(bot, again)) {
      ctx.skip.add(pos.toString())
      continue
    }
    await equipFor(bot, again)  // the walk may have dug with another tool
    if (token.cancelled) return 'cancelled'
    const known = itemIds(bot)
    await bot.dig(again, true)
    const spot = oweDrop(bot, ctx, pos.offset(0.5, 0.5, 0.5), known)
    await collectAround(bot, spot.at, token, { known, digFor: ctx.wantsDrop, dug: ctx.dugFor, enough: ctx.bagDone, log: ctx.log })
    if (!token.cancelled) settleDrop(ctx, spot)
    if (human.placesTorches && ctx.sinceTorch >= ctx.torchGap) await placeTorch(bot, ctx)
    return 'mined'
  }
  return 'cancelled'
}

// Counts every block the bot digs, its own digs and the pathfinder's, through one wrapper per bot. A job reads
// the counter before and after, so a fight pausing the job or a second job never double counts
function digCounter (bot) {
  if (!bot._agentsDigCount) {
    const counter = { n: 0 }
    const dig = bot.dig
    bot.dig = async function (...args) {
      const r = await dig.apply(bot, args)
      counter.n++
      return r
    }
    bot._agentsDigCount = counter
  }
  return bot._agentsDigCount
}

function newStats (strategy) {
  return {
    strategy,
    mode: strategy === 'tunnel' ? 'tunnel' : 'branch',
    dug: 0,
    ores: 0,
    torches: 0,
    stuck: 0,
    pathFails: 0,
    lavaBlocked: 0,
    startedAt: Date.now(),
    endedAt: null
  }
}

// A mining job: count blocks of any of these names. Keeps its progress in job, so a fight can pause it and it
// carries on after. say() sends a chat line. job.strategy 'tunnel' runs the tunnel miner, anything else the branch miner
async function mineJob (bot, job, human, token, hooks = {}) {
  const ids = job.blocks.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
  if (!ids.length) return { result: 'unknown', message: `"${job.block}" is not a block I know` }
  // ores need a pickaxe of some tier: say so now instead of tunnelling with bare hands
  const need = new Set(job.blocks.flatMap(n => Object.keys(bot.registry.blocksByName[n]?.harvestTools || {}).map(Number)))
  if (need.size && !bot.inventory.items().some(i => need.has(i.type))) {
    const hasPick = bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))
    return { result: 'no_tool', message: hasPick ? `My pickaxe is too weak for ${job.block}` : 'I have no pickaxe' }
  }
  const strategy = job.strategy === 'tunnel' ? 'tunnel' : 'branch'
  if (!job.stats) job.stats = newStats(strategy)
  const counter = digCounter(bot)
  const before = counter.n
  // a job never breaks the diamonds, gold or lapis it does not need, not even for a tunnel or a path (hazards.js)
  bot._keepOre = block => isMarkedOre(block) && !job.blocks.includes(block.name)
  try {
    if (strategy === 'tunnel') return await tunnelMineJob(bot, job, ids, human, token, hooks)
    // required here, mine_branch.js uses this file's helpers
    return await require('./mine_branch').branchMineJob(bot, job, ids, human, token, hooks)
  } finally {
    bot._keepOre = null
    job.stats.dug += counter.n - before
    job.stats.endedAt = Date.now()
  }
}

// The earlier loop, unchanged apart from the counting
async function tunnelMineJob (bot, job, ids, human, token, { say, log, onMined } = {}) {
  const ctx = job.ctx || (job.ctx = { ids, human, label: job.block, sinceTorch: 0, torchGap: torchGapFor(human), say, skip: new Set() })
  ctx.human = human
  ctx.log = log
  ctx.onMined = onMined
  ctx.say = say
  ctx.stats = job.stats
  ctx.wantsDrop = dropFilter(bot, job)
  ctx.dugFor = ctx.dugFor || new Set()
  ctx.bagDone = job.inBag ? () => job.inBag() >= job.want : null
  await collectOwed(bot, ctx, token)  // what a fight interrupted comes first
  while (!token.cancelled && (job.mined < job.count || await bagShort(bot, job, token))) {
    let r
    try {
      r = await mineOne(bot, ctx, token)
    } catch (err) {
      if (token.cancelled) break
      if (err instanceof MineError) return { result: 'no_tool', message: err.message }
      // a path that failed (blocked, too far): count it as a tunnel stretch and look again
      job.failures = (job.failures || 0) + 1
      job.stats.stuck++
      log?.(`${bot.username} mining: ${err.message}`)
      // a stretch that failed turns the tunnel, so it does not try the same wall again
      ctx.heading = (ctx.heading ?? bot.entity.yaw) + (Math.random() < 0.5 ? -1 : 1) * Math.PI / 2
      if (job.failures > 12) return { result: 'stuck', message: `I keep getting stuck, stopping with ${job.mined} ${job.block}` }
      await sleep(500)
      continue
    }
    if (r === 'mined') {
      job.mined++
      job.stats.ores++
      ctx.onMined?.(job)
    }
    if (r === 'full') return { result: 'full', message: 'Inventory full, coming back' }
    if (r === 'none') return { result: 'none', message: `I couldn't find any more ${job.block} nearby (${job.mined} so far)` }
  }
  if (token.cancelled) return { result: 'cancelled' }
  return { result: 'done', message: `Got ${job.mined} ${job.block}` }
}

module.exports = {
  mineJob,
  liquidNear,
  goTo,
  visibleTargets,
  pickTool,
  keepToolsForTheirBlocks,
  equipFor,
  collectAround,
  collectOwed,
  oweDrop,
  settleDrop,
  stepInto,
  backOut,
  digCounter,
  MineError,
  PICKAXES,
  BEST_Y,
  SEE_RADIUS,
  REACH,
  AIR,
  LIQUID,
  TORCH_EVERY,
  torchGapFor,
  countTunnel,
  torchPlaced,
  walkOntoDrops,
  itemIds,
  dropFilter,
  bagShort,
  GoalPickup
}
