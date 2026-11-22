// Lava and walled off mobs, the checks every job shares.
//
//   digHazard     whether breaking a block would let lava out, drop the bot into it, or is at a spot that just burned it
//   guardDigging  makes bot.dig refuse those blocks, as an aborted dig, so every skill handles it the way it already does
//   lavaStepCost  what a path pays to walk beside lava (allowed when there is no other way) or over it (never)
//   lavaExit      the shortest way from inside lava to dry ground, and leaveLava swims it without the pathfinder
//   sealedOff     whether a mob below has no open way up to the bot

const { Vec3 } = require('vec3')

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const UNDER_FEET = 4          // how far below its own floor it looks for lava
const LAVA_EDGE_COST = 8      // a path takes up to this many extra steps to stay off the edge of a pool
const NEVER = 100             // pathfinder drops a move at this cost
const BURN_RADIUS = 3
const BURN_MS = 60000         // the spot that burned it stays off limits this long
const EXIT_XZ = 6
const EXIT_UP = 3
const EXIT_NODES = 1200
const LEAVE_MS = 6000
const TICK_LIMIT_MS = 200     // a tick that never comes (a death) must not hang the swim
const SEAL_MARGIN = 6         // blocks around the bot and the mob that the search for an open way covers
const SEAL_ABOVE = 2
const SEAL_BELOW = 2          // a mob at least this far under the bot's feet can be sealed off
const SEAL_NODES = 2500       // a search this big is not sure of anything, so the mob still counts

// these get to the bot without an open way on foot
const NOT_SEALED = /^(phantom|ghast|happy_ghast|blaze|vex|bat|allay|bee|parrot|breeze|ender_dragon|wither|enderman|shulker)$/

const isLava = b => b?.name === 'lava'
const solid = b => b?.boundingBox === 'block'
const keyOf = p => `${p.x},${p.y},${p.z}`

function burnedNear (bot, p, now) {
  const b = bot._lavaBurn
  if (!b || now >= b.until) return false
  return Math.hypot(p.x + 0.5 - b.pos.x, p.y + 0.5 - b.pos.y, p.z + 0.5 - b.pos.z) <= BURN_RADIUS
}

function markBurned (bot, pos, now = Date.now()) {
  bot._lavaBurn = { pos: pos.clone ? pos.clone() : new Vec3(pos.x, pos.y, pos.z), until: now + BURN_MS }
}

// Why this block should stay where it is, or null
function digHazard (bot, block, now = Date.now()) {
  const p = block?.position
  if (!p) return null
  if (isLava(bot.blockAt(p.offset(0, 1, 0)))) return 'lava above it'
  for (const [dx, dz] of SIDES) {
    if (isLava(bot.blockAt(p.offset(dx, 0, dz)))) return 'lava beside it'
  }
  const me = bot.entity?.position
  if (me && Math.floor(me.x) === p.x && Math.floor(me.z) === p.z && p.y < me.y) {
    for (let dy = 1; dy <= UNDER_FEET; dy++) {
      const b = bot.blockAt(p.offset(0, -dy, 0))
      if (isLava(b)) return 'lava under its floor'
      if (solid(b)) break
    }
  }
  if (burnedNear(bot, p, now)) return 'it just burned here'
  return null
}

// allow(block): a dig that has to happen anyway (a head stuck in a block)
function guardDigging (bot, { allow = () => false } = {}) {
  if (bot._digGuarded) return
  bot._digGuarded = true
  const dig = bot.dig.bind(bot)
  bot.dig = (block, ...rest) => {
    const why = allow(block) ? null : digHazard(bot, block)
    if (why) return Promise.reject(new Error(`Digging aborted: ${block.name} at ${block.position}, ${why}`))
    return dig(block, ...rest)
  }
}

// By state id where the world has it: a path search asks this for every step it looks at
function lavaAt (bot, p) {
  const lava = bot.registry.blocksByName.lava?.id
  const state = bot.world?.getBlockStateId?.(p)
  const type = state !== undefined && state !== null ? bot.registry.blocksByStateId[state]?.id : bot.blockAt(p)?.type
  return type === lava
}

function lavaStepCost (bot, p, now = Date.now()) {
  if (lavaAt(bot, p.offset(0, -1, 0))) return NEVER
  for (const [dx, dz] of SIDES) {
    if (lavaAt(bot, p.offset(dx, 0, dz)) || lavaAt(bot, p.offset(dx, -1, dz))) return LAVA_EDGE_COST
  }
  return burnedNear(bot, p, now) ? LAVA_EDGE_COST : 0
}

const roomAt = (bot, p) => !solid(bot.blockAt(p)) && !solid(bot.blockAt(p.offset(0, 1, 0)))

function dryStand (bot, p) {
  if (!roomAt(bot, p) || isLava(bot.blockAt(p)) || isLava(bot.blockAt(p.offset(0, 1, 0)))) return false
  return solid(bot.blockAt(p.offset(0, -1, 0)))
}

// The nearest dry place to stand by moves through open cells: { target, next }, next being the first cell of the way
function lavaExit (bot) {
  const start = bot.entity.position.floored()
  const seen = new Set([keyOf(start)])
  const queue = [{ p: start, next: null }]
  for (let i = 0; i < queue.length && i < EXIT_NODES; i++) {
    const { p, next } = queue[i]
    if (i > 0 && dryStand(bot, p)) return { target: p, next }
    const steps = SIDES.map(([dx, dz]) => p.offset(dx, 0, dz))
    if (!solid(bot.blockAt(p.offset(0, 2, 0)))) {
      steps.push(p.offset(0, 1, 0), ...SIDES.map(([dx, dz]) => p.offset(dx, 1, dz)))
    }
    for (const q of steps) {
      if (Math.abs(q.x - start.x) > EXIT_XZ || Math.abs(q.z - start.z) > EXIT_XZ || q.y - start.y > EXIT_UP) continue
      const k = keyOf(q)
      if (seen.has(k) || !roomAt(bot, q)) continue
      seen.add(k)
      queue.push({ p: q, next: next || q })
    }
  }
  return null
}

// Swims for the nearest bank on its own keys: lava takes a full bar in about 2.5 s, no time to wait for a path.
// True when it is out. The spot is remembered, so the job that brought it here goes somewhere else
async function leaveLava (bot, token, { maxMs = LEAVE_MS } = {}) {
  if (!bot.entity.isInLava) return true
  markBurned(bot, bot.entity.position)
  if (!lavaExit(bot)) return false
  bot.pathfinder?.setGoal?.(null)
  const end = Date.now() + maxMs
  try {
    while (bot.entity.isInLava && !token?.cancelled && bot.health > 0 && Date.now() < end) {
      const way = lavaExit(bot)
      if (way) await bot.lookAt(way.next.offset(0.5, 1.2, 0.5), true)
      bot.setControlState('forward', !!way)
      bot.setControlState('sprint', !!way)
      bot.setControlState('jump', true)
      await Promise.race([bot.waitForTicks(1), new Promise(resolve => setTimeout(resolve, TICK_LIMIT_MS))])
    }
  } finally {
    for (const c of ['forward', 'sprint', 'jump']) bot.setControlState(c, false)
  }
  return !bot.entity.isInLava
}

// Whether a mob under the bot has no open way up to it. Spreads out from the bot through every cell without a full
// block, in a box around the two of them that stops just above the bot, so a long way round through the surface does
// not count. The block it is breaking right now counts as open, so a floor about to give way into a cave is no seal
function sealedOff (bot, e) {
  if (e.type === 'player' || NOT_SEALED.test(e.name || '')) return false
  const me = bot.entity.position
  if (e.position.y > me.y - SEAL_BELOW) return false
  const start = me.floored()
  const goal = e.position.floored()
  const digging = bot.targetDigBlock?.position
  const diggingKey = digging ? keyOf(digging) : null
  const box = {
    x0: Math.min(start.x, goal.x) - SEAL_MARGIN,
    x1: Math.max(start.x, goal.x) + SEAL_MARGIN,
    z0: Math.min(start.z, goal.z) - SEAL_MARGIN,
    z1: Math.max(start.z, goal.z) + SEAL_MARGIN,
    y0: goal.y - 1,
    y1: start.y + SEAL_ABOVE
  }
  const seen = new Set([keyOf(start)])
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    if (i >= SEAL_NODES) return false
    const p = queue[i]
    if (p.x === goal.x && p.z === goal.z && (p.y === goal.y || p.y === goal.y + 1)) return false
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const q = p.offset(dx, dy, dz)
      if (q.x < box.x0 || q.x > box.x1 || q.z < box.z0 || q.z > box.z1 || q.y < box.y0 || q.y > box.y1) continue
      const k = keyOf(q)
      if (seen.has(k)) continue
      seen.add(k)
      if (k !== diggingKey && solid(bot.blockAt(q))) continue
      queue.push(q)
    }
  }
  return true
}

module.exports = { digHazard, guardDigging, lavaStepCost, lavaExit, leaveLava, markBurned, sealedOff, LAVA_EDGE_COST }
