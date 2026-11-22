// Walking: a time limit on every walk, hazards kept out of the path, and getting unstuck.
//
// goTo is the plain walk. pathfinder.goto can keep replanning a path without end, so every walk has a limit and
// fails when it runs out. Every walk keeps the bot off blocks that hurt (guardHazards): magma and campfires
// underfoot, and fire, berry bushes, wither roses, powder snow and cobwebs to walk through.
//
// walkTo is the walk that recovers. It watches the bot while it walks, and no progress for STUCK_TICKS (a corner,
// a hole it keeps jumping at) ends the try early. After a failed try it gets unstuck (digs the block its head is in,
// swims up, digs the natural block in its way, or backs off with a jump) and tries again. The last try uses the
// rescue moves when it has them: digging through natural ground and pillaring up with dirt or cobblestone, never
// breaking a block a player could have placed.

const { withTimeout } = require('./abort')
const { announce } = require('../announcer')
const { digHazard, lavaStepCost } = require('../hazards')

const GOTO_MS = 20000
const STUCK_TICKS = 80        // 4 s without moving STUCK_MOVE blocks counts as stuck
const STUCK_MOVE = 0.3
const WATCH_TICKS = 10
const HAZARD_PASS = ['fire', 'soul_fire', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose', 'powder_snow', 'cobweb', 'lava']
const HAZARD_FLOOR = ['magma_block', 'campfire', 'soul_campfire']
// Natural ground the rescue moves may dig through. Nothing on this list is a usual building block, and leaves
// count only when the game placed them (persistent false)
const NATURAL = /^(stone|deepslate|granite|diorite|andesite|tuff|calcite|dripstone_block|dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|clay|gravel|sand|red_sand|netherrack|soul_sand|soul_soil|end_stone|snow|snow_block|moss_block|short_grass|tall_grass|fern|large_fern|dead_bush|(deepslate_)?[a-z]+_ore|nether_[a-z]+_ore)$/
const PILLAR = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack']

function isNaturalGround (block) {
  if (!block) return false
  if (NATURAL.test(block.name)) return true
  if (/_leaves$/.test(block.name)) {
    const p = typeof block.getProperties === 'function' ? block.getProperties() : {}
    return p.persistent === false || p.persistent === 'false'
  }
  return false
}

// Adds the hazards to a pathfinder Movements, once. Movements without the sets (a test's stand-in) are left alone
function guardHazards (bot, moves) {
  if (!moves || moves._agentsHazards || !(moves.blocksToAvoid instanceof Set)) return moves
  const reg = bot.registry
  for (const n of HAZARD_PASS) {
    const b = reg.blocksByName[n]
    if (b) moves.blocksToAvoid.add(b.id)
  }
  const floors = new Set(HAZARD_FLOOR.map(n => reg.blocksByName[n]?.id).filter(id => id !== undefined))
  if (Array.isArray(moves.exclusionAreasStep)) {
    // a step into a cell whose floor hurts costs too much to take (pathfinder drops moves over 100)
    moves.exclusionAreasStep.push(block => {
      const p = block?.position
      if (!p || typeof p.offset !== 'function') return 0
      // the state id alone where the world has it: this runs for every step the path search looks at
      const q = p.offset(0, -1, 0)
      const state = bot.world?.getBlockStateId?.(q)
      const type = state !== undefined && state !== null ? reg.blocksByStateId[state]?.id : bot.blockAt(q)?.type
      return floors.has(type) ? 100 : 0
    })
    // beside lava costs extra and over it never. Kept for a second, the search asks about the same cells many times
    const costs = new Map()
    let costsAt = 0
    moves.exclusionAreasStep.push(block => {
      const p = block?.position
      if (!p || typeof p.offset !== 'function') return 0
      const now = Date.now()
      if (now - costsAt > 1000) { costs.clear(); costsAt = now }
      const k = `${p.x},${p.y},${p.z}`
      if (!costs.has(k)) costs.set(k, lavaStepCost(bot, p, now))
      return costs.get(k)
    })
  }
  if (Array.isArray(moves.exclusionAreasBreak)) {
    moves.exclusionAreasBreak.push(block => (block?.position?.offset && digHazard(bot, block) ? 100 : 0))
  }
  moves._agentsHazards = true
  return moves
}

// The moves of the last try: dig through natural ground, pillar and bridge with dirt or cobblestone, short drops
function rescueMoves (bot) {
  if (!bot._agentsRescue) {
    const { Movements } = require('mineflayer-pathfinder')
    const m = new Movements(bot)
    m.canDig = true
    m.allow1by1towers = true
    m.allowParkour = false
    m.maxDropDown = 3
    m.liquidCost = 50
    m.scafoldingBlocks = PILLAR.map(n => bot.registry.itemsByName[n]?.id).filter(id => id !== undefined)
    m.exclusionAreasBreak.push(block => isNaturalGround(block) ? 0 : 100)
    guardHazards(bot, m)
    bot._agentsRescue = m
  }
  return bot._agentsRescue
}

async function goTo (bot, goal, token, ms = GOTO_MS) {
  if (token?.cancelled) return
  guardHazards(bot, bot.pathfinder.movements)
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, {
      message: 'path took too long',
      onTimeout: () => bot.pathfinder.setGoal(null)
    })
  } catch (err) {
    if (token?.cancelled) return
    throw err
  } finally {
    // pathfinder.goto can end with the goal still set (it rejects a path it cannot find, and resolves on an empty one).
    // Left alone, that goal goes on walking and digging behind the next job and cancels its digs
    if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null)
  }
}

// Moves that only walk: no digging, no placed blocks, short drops
function walkOnlyMoves (bot) {
  if (!bot._agentsWalkOnly) {
    const { Movements } = require('mineflayer-pathfinder')
    const m = new Movements(bot)
    m.canDig = false
    m.allow1by1towers = false
    m.allowParkour = false
    m.scafoldingBlocks = []
    m.maxDropDown = 3
    m.liquidCost = 50
    guardHazards(bot, m)
    bot._agentsWalkOnly = m
  }
  return bot._agentsWalkOnly
}

// Moves for getting to a drop of its own in a hole: digs natural ground only, builds nothing, short drops
function dropDigMoves (bot) {
  if (!bot._agentsDropDig) {
    const { Movements } = require('mineflayer-pathfinder')
    const m = new Movements(bot)
    m.canDig = true
    m.allow1by1towers = false
    m.allowParkour = false
    m.scafoldingBlocks = []
    m.maxDropDown = 3
    m.liquidCost = 50
    m.exclusionAreasBreak.push(block => isNaturalGround(block) ? 0 : 100)
    guardHazards(bot, m)
    bot._agentsDropDig = m
  }
  return bot._agentsDropDig
}

// A short errand on foot, such as fetching a drop: it never breaks or builds anything to get there
async function walkOnly (bot, goal, token, ms) {
  const before = bot.pathfinder.movements
  const moves = walkOnlyMoves(bot)
  if (before !== moves) bot.pathfinder.setMovements(moves)
  try {
    await goTo(bot, goal, token, ms)
  } finally {
    if (bot.pathfinder.movements !== before) bot.pathfinder.setMovements(before)
  }
}

const atGoal = (bot, goal) => {
  const p = bot.entity.position
  try { return typeof goal.isEnd === 'function' && goal.isEnd(p.floored()) } catch { return false }
}

// One try: goTo, ended early when the bot has not moved STUCK_MOVE blocks in STUCK_TICKS
async function watchedGoTo (bot, goal, token, ms) {
  let done = false
  const walk = goTo(bot, goal, token, ms).finally(() => { done = true })
  const watch = (async () => {
    let from = bot.entity.position.clone()
    let still = 0
    while (!done && !token?.cancelled) {
      await bot.waitForTicks(WATCH_TICKS)
      if (done) return
      const p = bot.entity.position
      // digging or placing on the way is progress, a hard block can take seconds with no step
      const working = !!bot.targetDigBlock || !!bot.pathfinder.isMining?.() || !!bot.pathfinder.isBuilding?.()
      if (working || p.distanceTo(from) >= STUCK_MOVE) {
        from = p.clone()
        still = 0
        continue
      }
      still += WATCH_TICKS
      if (still >= STUCK_TICKS && !atGoal(bot, goal)) {
        bot.pathfinder.setGoal(null)
        const err = new Error('stuck, no progress')
        err.stuck = true
        throw err
      }
    }
  })()
  walk.catch(() => {})
  watch.catch(() => {})
  await Promise.race([walk, watch])
}

// Gets the bot moving again. Returns what it did
async function unstick (bot, token, { log = () => {} } = {}) {
  if (token?.cancelled) return 'cancelled'
  const p = bot.entity.position
  const feet = p.floored()
  const head = bot.blockAt(feet.offset(0, 1, 0))
  if (head && head.boundingBox === 'block' && isNaturalGround(head) && head.diggable) {
    try { await bot.dig(head, true); return 'dug its head free' } catch {}
  }
  if (bot.entity.isInWater) {
    bot.setControlState('jump', true)
    await bot.waitForTicks(20)
    bot.setControlState('jump', false)
    return 'swam up'
  }
  // the natural block in the way, where it looks
  const dx = Math.round(-Math.sin(bot.entity.yaw))
  const dz = Math.round(-Math.cos(bot.entity.yaw))
  for (const dy of [1, 0]) {
    const b = bot.blockAt(feet.offset(dx, dy, dz))
    if (b && b.boundingBox === 'block' && b.diggable && isNaturalGround(b) && !liquidNext(bot, b.position)) {
      try {
        await bot.dig(b, true)
        log(`${bot.username} dug ${b.name} in its way`)
        return `dug ${b.name}`
      } catch {}
    }
  }
  bot.setControlState('back', true)
  bot.setControlState('jump', true)
  await bot.waitForTicks(8)
  bot.setControlState('back', false)
  bot.setControlState('jump', false)
  return 'backed off'
}

function liquidNext (bot, pos) {
  for (const [x, y, z] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const n = bot.blockAt(pos.offset(x, y, z))?.name
    if (n === 'water' || n === 'lava') return true
  }
  return false
}

// A walk that recovers: up to tries + 1 tries, unstuck between them, the last one with the rescue moves when given.
// Resolves true on arrival, false when cancelled, throws the last failure
async function walkTo (bot, goal, token, { ms = GOTO_MS, tries = 2, rescue = null, log = () => {} } = {}) {
  await bot.agentsBeforeWalk?.(goal, token)    // a scene with a door the pathfinder cannot use gets the agent through it
  let last = null
  const before = bot.pathfinder.movements
  try {
    for (let attempt = 0; attempt <= tries; attempt++) {
      if (token?.cancelled) return false
      if (attempt > 0) {
        announce(bot, attempt === tries && rescue ? 'stuck, digging my way through' : 'stuck, trying another path')
        const did = await unstick(bot, token, { log })
        log(`${bot.username} walk try ${attempt + 1}: ${last?.message || 'failed'}, ${did}`)
        if (attempt === tries && rescue) bot.pathfinder.setMovements(rescue)
      }
      try {
        await watchedGoTo(bot, goal, token, ms)
        return !token?.cancelled
      } catch (err) {
        if (token?.cancelled) return false
        last = err
      }
    }
  } finally {
    if (bot.pathfinder.movements !== before) bot.pathfinder.setMovements(before)
  }
  throw last
}

module.exports = { goTo, walkOnly, walkOnlyMoves, dropDigMoves, walkTo, unstick, guardHazards, rescueMoves, isNaturalGround, GOTO_MS, STUCK_TICKS, HAZARD_PASS, HAZARD_FLOOR }
