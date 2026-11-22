// The gatherer: gets more of one raw material and keeps it in the bag. One scripted skill per kind
// (skills/gather_kinds.js has the kinds), each of which can later be swapped for a learned one on its own:
//
//   wood         the nearest natural tree it can see, chopped log by log (gather.js), any wood counts. No tree in
//                sight: walks a little way and looks again, up to 6 times, staying within 48 blocks of the start
//   cobblestone  stone it can see, else a short staircase down (gather.js). Needs a pickaxe
//   iron         the miner (mine_branch.js): caves it can see first, then branch mining at the best depth. Needs a
//   diamond      stone pickaxe for iron and an iron one for diamonds. It keeps the haul (no chest) and walks back
//   coal         to where it started
//
// Only blocks it can see or has uncovered itself, the same rule as the miner: no X-ray.

const { goals } = require('mineflayer-pathfinder')
const { gather, visible, wanderPoint } = require('./gather')
const { mineJob } = require('./mine')
const { goTo } = require('./move')
const { KINDS, LOGS, carriedOf, bestPickaxeOf, NEED_LEVEL, NEED_TEXT } = require('./gather_kinds')

const WANDERS = 6
const WANDER_RANGE = 48

const carried = (bot, kind) => carriedOf(bot.inventory.items(), kind)

// The best pickaxe it carries by mining level ('wooden'..'netherite'), or null
function bestPickaxe (bot) {
  return bestPickaxeOf(bot.inventory.items().map(i => i.name)).name
}

// What tool a kind needs that the bag lacks, as a chat line, or null
function missingTool (bot, kind) {
  const { name, level } = bestPickaxeOf(bot.inventory.items().map(i => i.name))
  if (!(kind in NEED_LEVEL) || level >= NEED_LEVEL[kind]) return null
  const need = NEED_TEXT[kind]
  return name ? `For ${KINDS[kind].label} I need ${need}, I only have a ${name} one` : `For ${KINDS[kind].label} I need ${need}`
}

// Gets want more of a kind. Returns { result: 'done'|'short'|'no_tool'|'none'|'full'|'stuck'|'cancelled', got,
// message }. deps: say, log, human (the miner's human-like touches), miner ('branch' or 'tunnel')
async function gatherKind (bot, kind, want, token, deps = {}) {
  const { log = () => {}, say = () => {} } = deps
  const k = KINDS[kind]
  if (!k) return { result: 'unknown', got: 0, message: `I don't know how to gather ${kind}` }
  const tool = missingTool(bot, kind)
  if (tool) {
    // deps.toolCtx: a job that already started, so its pickaxe broke on the way (a fight or a meal took over before the
    // miner could replace it). A new one from the bag, the miner's way. A new job with a weak pickaxe just says so
    if (!deps.toolCtx) return { result: 'no_tool', got: 0, message: tool }
    const { replacePickaxe } = require('./mine_branch')
    Object.assign(deps.toolCtx, { log, say })
    await replacePickaxe(bot, deps.toolCtx, token, { blocks: k.ores || ['stone'] })
    if (token?.cancelled) return { result: 'cancelled', got: 0 }
    const still = missingTool(bot, kind)
    if (still) return { result: 'no_tool', got: 0, message: still }
  }
  const start = carried(bot, kind)
  const target = start + want
  let result = 'done'
  if (kind === 'wood') result = await chopWood(bot, target, token, { log, say, digMoves: deps.digMoves, master: deps.master })
  else if (kind === 'cobblestone') {
    await gather(bot, 'cobblestone', want, token, { log, say, master: deps.master })
    if (carried(bot, kind) < target) result = 'none'
  } else {
    // want and inBag: the job is over when the bag holds the amount, and a drop that is truly lost costs one more ore
    const job = { block: kind, blocks: k.ores, count: want, mined: 0, want, inBag: () => carried(bot, kind) - start, strategy: deps.miner === 'tunnel' ? 'tunnel' : 'branch', home: null, store: false, ...(deps.tuning ? { tuning: deps.tuning } : {}), ...(deps.takeEasy ? { takeEasy: deps.takeEasy } : {}) }
    // lowFood, restock and restocking: the food turn-back of a trip underground (mine_branch.js)
    const r = await mineJob(bot, job, deps.human, token, { say, log, onMined: deps.onMined, lowFood: deps.lowFood, restock: deps.restock, restocking: deps.restocking })
    result = r.result === 'done' ? 'done' : r.result
  }
  if (token?.cancelled) return { result: 'cancelled', got: carried(bot, kind) - start }
  const got = carried(bot, kind) - start
  if (got >= want) return { result: 'done', got, message: `Got ${got} ${k.unit}` }
  const why = {
    none: `I couldn't find more ${k.label} nearby`,
    full: 'my bag is full',
    food: 'I ran too low on food to go back down',
    stuck: 'I kept getting stuck',
    no_tool: 'my pickaxe broke',
    done: 'some drops never reached my bag'
  }[result] || `it ended with ${result}`
  return { result: result === 'done' ? 'short' : result, got, message: `I got ${got} of ${want} ${k.unit}: ${why}` }
}

// Logs of any wood from natural trees it can see, until it carries target logs. 'done' or 'none'
async function chopWood (bot, target, token, { log, say, digMoves = null, master = null }) {
  const home = bot.entity.position.clone()
  let wanders = 0
  let dry = 0
  while (carried(bot, 'wood') < target && !token?.cancelled) {
    const spots = visible(bot, LOGS, () => false, { logs: true })
    if (spots.length) {
      const name = bot.blockAt(spots[0])?.name
      const before = carried(bot, 'wood')
      // gather() keeps to that wood until the tree is gone, then the next look picks the next tree
      await gather(bot, name, target - before, token, { log, say, master })
      if (carried(bot, 'wood') > before) { dry = 0; continue }
      if (++dry >= 3) return 'none'  // trees it sees but can't get to
    }
    if (token?.cancelled) break
    if (wanders === 0) log(`${bot.username} sees no tree it can reach, walking to look`)
    if (wanders++ >= WANDERS) return 'none'
    const { x, z } = wanderPoint(bot.entity.position, home, { master: master?.(), early: wanders <= WANDERS / 2, range: WANDER_RANGE })
    try {
      await goTo(bot, new goals.GoalNearXZ(x, z, 3), token, 20000)
    } catch (err) {
      log(`${bot.username} wood walk: ${err.message}`)
      // a ravine it followed an animal into has no walking way out, so it digs its way to the same spot
      if (digMoves && /no path/i.test(err.message) && !token?.cancelled) {
        const before = bot.pathfinder.movements
        bot.pathfinder.setMovements(digMoves())
        try {
          await goTo(bot, new goals.GoalNearXZ(x, z, 3), token, 30000)
        } catch (e) {
          log(`${bot.username} wood walk, digging: ${e.message}`)
        } finally {
          bot.pathfinder.setMovements(before)
        }
      }
    }
  }
  return 'done'
}

module.exports = { gatherKind, missingTool, bestPickaxe, carried }
