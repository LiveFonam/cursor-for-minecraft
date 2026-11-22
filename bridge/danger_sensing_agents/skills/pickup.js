// Picking up items from the ground with a plain walk. It goes to any cell where the game hands the item over, moves past
// a drop it cannot reach, and the whole collect has one time limit. The walk that flows on from a dig is walkOntoDrops.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep } = require('./human')
const { goTo } = require('./move')
const { inPickupBox } = require('./motion')

const COLLECT_MS = 12000      // for everything lying around one spot
const WALK_MS = 5000          // to one drop, then the next one gets its turn
const HANDOVER_MS = 1000      // in range, an item can still be on its short pickup delay
const STEP_MS = 50
const MAX_TRIES = 3           // walks to one drop that keeps rolling away

// Any standing cell where the game would hand this drop over
class GoalPickup extends goals.Goal {
  constructor (drop) {
    super()
    this.drop = drop.clone()
    this.x = Math.floor(drop.x)
    this.y = Math.floor(drop.y)
    this.z = Math.floor(drop.z)
  }

  heuristic (n) {
    return Math.hypot(n.x + 0.5 - this.drop.x, n.z + 0.5 - this.drop.z) + Math.abs(n.y - this.drop.y)
  }

  isEnd (n) {
    return inPickupBox(new Vec3(n.x + 0.5, n.y, n.z + 0.5), this.drop, 0.02)
  }
}

// Collects the items within radius of pos, nearest first. settleMs: how long a fresh drop gets to land first
async function pickUpDrops (bot, pos, token, { radius = 4, settleMs = 350, limitMs = COLLECT_MS, walkMs = WALK_MS } = {}) {
  if (settleMs > 0) await sleep(settleMs)
  const until = Date.now() + limitMs
  const left = new Set()
  const tries = new Map()
  while (!token?.cancelled && Date.now() < until) {
    const me = bot.entity.position
    const drop = Object.values(bot.entities || {})
      .filter(e => e.name === 'item' && e.position && !left.has(e.id) && e.position.distanceTo(pos) < radius)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
    if (!drop) return
    if (!inPickupBox(me, drop.position)) {
      const n = (tries.get(drop.id) || 0) + 1
      tries.set(drop.id, n)
      if (n > MAX_TRIES) {
        left.add(drop.id)
        continue
      }
      try {
        await goTo(bot, new GoalPickup(drop.position), token, Math.max(1, Math.min(walkMs, until - Date.now())))
      } catch {
        left.add(drop.id)
        continue
      }
      if (token?.cancelled) return
      if (!bot.entities?.[drop.id]) continue
      if (!inPickupBox(bot.entity.position, drop.position)) continue
    }
    const wait = Math.min(Date.now() + HANDOVER_MS, until)
    while (bot.entities?.[drop.id] && inPickupBox(bot.entity.position, drop.position) && Date.now() < wait && !token?.cancelled) await sleep(STEP_MS)
    // still here after the delay: the game is not handing it over (a full bag), so it does not hold up the others
    if (bot.entities?.[drop.id] && inPickupBox(bot.entity.position, drop.position)) left.add(drop.id)
  }
}

module.exports = { GoalPickup, pickUpDrops, COLLECT_MS }
