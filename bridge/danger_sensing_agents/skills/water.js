'use strict'
// Water and digging. A block takes about 5 times longer to dig standing in water, and longer again off the ground, so
// the miners work from dry cells: they leave the water's edge before a dig site, step out before a dig, and keep the
// blocks that hold water back. Less strict than lava: with no dry way close they carry on through it.
const { goals } = require('mineflayer-pathfinder')
const { walkOnly } = require('./move')

const WATER_NAMES = ['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']  // all full of water
const WATERY = new Set(WATER_NAMES)
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const SHORE = 2            // dry ground has no water this close
const SHORE_MOVES = 8      // the furthest it walks to get off the water's edge
const SHORE_TRIES = 3      // failed walks off the edge before it digs where it is
const OUT_MOVES = 8        // the furthest it walks to get out of water
const DIG_MOVES = 2        // a step or two out of water for one dig, the block still in reach
const DIG_REACH = 4.4
const SEARCH_NODES = 400
const WALK_MS = 6000
const STAIR_LOOK = 4       // staircase steps checked before picking a direction
const WET_STEPS = 16       // tunnel cells it digs on through once water is the only way
const WATER_TURNS = 4      // turns away from water before it counts as the only way

const isWater = b => !!b && WATERY.has(b.name)
const solid = b => b?.boundingBox === 'block'
const feetOf = bot => bot.entity.position.floored()

// Really in water now, the world agreeing with the entity flag
function inWater (bot) {
  if (!bot.entity.isInWater) return false
  const feet = feetOf(bot)
  return isWater(bot.blockAt(feet)) || isWater(bot.blockAt(feet.offset(0, 1, 0)))
}

function waterNear (bot, cell, r = 1) {
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        if (isWater(bot.blockAt(cell.offset(dx, dy, dz)))) return true
      }
    }
  }
  return false
}

// Breaking this block would let water in: water above it or beside it (water under it stays there)
function holdsWater (bot, pos) {
  if (isWater(bot.blockAt(pos.offset(0, 1, 0)))) return true
  return SIDES.some(([dx, dz]) => isWater(bot.blockAt(pos.offset(dx, 0, dz))))
}

const floodedCell = (bot, c) => isWater(bot.blockAt(c)) || isWater(bot.blockAt(c.offset(0, 1, 0)))

function roomAt (bot, c) {
  const feet = bot.blockAt(c)
  const head = bot.blockAt(c.offset(0, 1, 0))
  return !!feet && !!head && !solid(feet) && !solid(head) && feet.name !== 'lava' && head.name !== 'lava'
}

// The nearest cell to stand in without water, by moves through open cells and water. margin keeps it that far from
// any water, ok(cell) can rule cells out. Null when there is none within the moves
function findDry (bot, from, { moves = OUT_MOVES, margin = 0, ok = () => true } = {}) {
  const seen = new Set([from.toString()])
  const queue = [{ c: from, d: 0 }]
  for (let i = 0; i < queue.length && i < SEARCH_NODES; i++) {
    const { c, d } = queue[i]
    if (i > 0 && solid(bot.blockAt(c.offset(0, -1, 0))) && !floodedCell(bot, c) &&
      (!margin || !waterNear(bot, c, margin)) && ok(c)) return c
    if (d >= moves) continue
    for (const [dx, dz] of SIDES) {
      for (const dy of [0, 1, -1]) {
        const n = c.offset(dx, dy, dz)
        const k = n.toString()
        if (seen.has(k) || !roomAt(bot, n)) continue
        if (dy === 1 && solid(bot.blockAt(c.offset(0, 2, 0)))) continue
        if (dy === -1 && solid(bot.blockAt(c.offset(dx, 1, dz)))) continue
        if (!solid(bot.blockAt(n.offset(0, -1, 0))) && !isWater(bot.blockAt(n))) continue
        seen.add(k)
        queue.push({ c: n, d: d + 1 })
      }
    }
  }
  return null
}

async function walkToDry (bot, token, log, opts) {
  const spot = findDry(bot, feetOf(bot), opts)
  if (!spot) return false
  try {
    await walkOnly(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), token, WALK_MS)
  } catch (err) {
    log?.(`${bot.username} water: could not walk to ${spot.x} ${spot.y} ${spot.z} (${err.message})`)
    return false
  }
  if (token?.cancelled || !feetOf(bot).equals(spot)) return false
  log?.(`${bot.username} water: moved to dry ground at ${spot.x} ${spot.y} ${spot.z}`)
  return true
}

// At or beside water where it is about to start digging: a short walk to dry ground, if there is any close
async function leaveShore (bot, token, log, memo = {}) {
  if ((memo.shoreFails || 0) >= SHORE_TRIES || !waterNear(bot, feetOf(bot), 1)) return false
  const from = feetOf(bot)
  if (await walkToDry(bot, token, log, { moves: SHORE_MOVES, margin: SHORE })) return true
  if (inWater(bot) && await walkToDry(bot, token, log, { moves: SHORE_MOVES })) return true  // any dry cell beats none
  if (!feetOf(bot).equals(from) || findDry(bot, from, { moves: SHORE_MOVES, margin: SHORE })) memo.shoreFails = (memo.shoreFails || 0) + 1
  return false
}

// Standing in water with a dry cell a step or two off that still reaches the block: it digs from there
async function stepOutToDig (bot, pos, token, log) {
  if (!inWater(bot)) return false
  const target = pos.offset(0.5, 0.5, 0.5)
  const ok = c => c.offset(0.5, 1.62, 0.5).distanceTo(target) <= DIG_REACH && !(c.x === pos.x && c.z === pos.z && c.y > pos.y)
  return walkToDry(bot, token, log, { moves: DIG_MOVES, ok })
}

// In water: out to a dry cell clear of the flow, or any dry cell, else back along its trail. Still in water after
// that, water is the only way and it digs on. True when it tried to get out, so the caller plans again from there
async function getOutOfWater (bot, ctx, token, backOut) {
  if (ctx.wetDig || !inWater(bot)) return false
  const log = ctx.log
  if (!await walkToDry(bot, token, log, { moves: OUT_MOVES, margin: 1 }) &&
    !await walkToDry(bot, token, log, { moves: OUT_MOVES })) await backOut(bot, ctx, token)
  if (!token?.cancelled && inWater(bot)) digOnWet(bot, ctx)
  return true
}

function digOnWet (bot, ctx) {
  ctx.wetDig = WET_STEPS
  ctx.log?.(`${bot.username} water: no dry way close, digging on`)
}

// Whether a staircase from here along d stays clear of water for its first steps
function stairIsDry (bot, start, d) {
  for (let n = 1; n <= STAIR_LOOK; n++) {
    const step = start.offset(d.x * n, -n, d.z * n)
    for (const c of [step.offset(0, 2, 0), step.offset(0, 1, 0), step]) {
      if (isWater(bot.blockAt(c)) || holdsWater(bot, c)) return false
    }
  }
  return true
}

// The spots that hold no water back, then the others, for when they are all there is
function dryFirst (bot, spots) {
  const wet = new Set(spots.filter(p => holdsWater(bot, p)))
  return [...spots.filter(p => !wet.has(p)), ...wet]
}

module.exports = {
  WATER_NAMES,
  WET_STEPS,
  WATER_TURNS,
  isWater,
  inWater,
  waterNear,
  holdsWater,
  floodedCell,
  findDry,
  leaveShore,
  stepOutToDig,
  getOutOfWater,
  digOnWet,
  stairIsDry,
  dryFirst
}
