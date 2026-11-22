// The movement guard of the trained mob network. The network trained on a flat dry floor under an open sky, so water,
// ledges, roofs and mobs on another level are inputs it never saw. Each decision the guard reads the ground around the
// bot and picks who moves it:
//
//   network   normal ground: the network's keys, without any that step into a hazard or down more than 1 block
//   guard     in water or at a ledge: the guard moves the feet (to dry ground, or back from the edge), and the network
//             keeps its aim, swing and shield
//   scripted  in water with no way out: the fight goes to the scripted fighter, which can path through water
//
// A roof or a mob on another level changes nothing it can act on, so the network keeps its feet and the log names it.

const { Vec3 } = require('vec3')

const HAZARD = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|wither_rose|powder_snow|cobweb)$/
const GUARD_STEP = 1        // how far ahead a key is checked
const NET_DROP = 1          // the most it walks down in a fight: it never trained on a drop
const EDGE_PROBE = 0.75     // this close to a drop it steps back in
const SKY = 8               // the up ray read its full 8 blocks through all of training
const TRAINED_LEVEL = 1.5   // blocks between its feet and a mob's: a jump and knockback stayed within about 1.25
const SHORE_RADIUS = 10     // how far it looks for dry ground
const SHORE_EVERY = 10      // decisions between two searches for it
const WATER_TICKS = 240     // 12 s in water without getting out goes to the scripted fighter
const LABEL_HOLD = 10       // decisions a guard line stays up, so a bot working along an edge logs one line
const KEY_SHARE = 0.38      // a direction needs this share of a unit along an axis to press that axis's key
const EIGHT = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.707, 0.707], [0.707, -0.707], [-0.707, 0.707], [-0.707, -0.707]]
const BASE_LABEL = 'trained network'

const FB = 0
const LR = 1
const SPRINT = 2
const JUMP = 3

// Whether a step along (dx, dz) ends in something that hurts or above a drop of more than maxDrop blocks
function unsafeStep (bot, dx, dz, { step = GUARD_STEP, maxDrop = NET_DROP } = {}) {
  const p = bot.entity.position
  const x = Math.floor(p.x + dx * step)
  const z = Math.floor(p.z + dz * step)
  const y = Math.floor(p.y)
  for (const h of [0, 1]) {
    const b = bot.blockAt(new Vec3(x, y + h, z), false)
    if (b && HAZARD.test(b.name)) return true
  }
  for (let down = 1; down <= maxDrop + 1; down++) {
    const b = bot.blockAt(new Vec3(x, y - down, z), false)
    if (!b) return true
    if (HAZARD.test(b.name)) return true
    if (b.boundingBox === 'block' || b.name === 'water') return false
  }
  return true
}

function inWater (bot) {
  if (bot.entity.isInWater) return true
  const p = bot.entity.position
  return [0, 1].some(h => bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) + h, Math.floor(p.z)), false)?.name === 'water')
}

const open = b => !!b && b.boundingBox === 'empty' && b.name !== 'water' && !HAZARD.test(b.name)

function standable (bot, feet) {
  const floor = bot.blockAt(feet.offset(0, -1, 0), false)
  if (!floor || floor.boundingBox !== 'block' || HAZARD.test(floor.name)) return false
  return open(bot.blockAt(feet, false)) && open(bot.blockAt(feet.offset(0, 1, 0), false))
}

// The nearest dry standing spot, level or a little above or below, or null
function findShore (bot, radius = SHORE_RADIUS) {
  const base = bot.entity.position.floored()
  let best = null
  let bestD = Infinity
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const flat = Math.hypot(dx, dz)
      if (flat > radius || flat >= bestD) continue
      for (const dy of [3, 2, 1, 0, -1]) {
        const feet = base.offset(dx, dy, dz)
        if (!standable(bot, feet)) continue
        best = feet
        bestD = flat
        break
      }
    }
  }
  return best
}

function lowRoof (bot) {
  const p = bot.entity.position
  for (let h = 2; h <= SKY + 1; h++) {
    const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) + h, Math.floor(p.z)), false)
    if (b?.boundingBox === 'block') return true
  }
  return false
}

// The movement keys, in the network's action values, that go along (dx, dz) for a bot facing yaw, leaving out any key
// that would step somewhere unsafe
function feetToward (bot, dx, dz) {
  const yaw = bot.entity.yaw
  const forward = [-Math.sin(yaw), -Math.cos(yaw)]
  const right = [Math.cos(yaw), -Math.sin(yaw)]
  const len = Math.hypot(dx, dz) || 1
  const f = (dx * forward[0] + dz * forward[1]) / len
  const r = (dx * right[0] + dz * right[1]) / len
  const fb = f > KEY_SHARE ? 1 : f < -KEY_SHARE ? 2 : 0
  const lr = r > KEY_SHARE ? 2 : r < -KEY_SHARE ? 1 : 0
  const fSign = fb === 1 ? 1 : -1
  const rSign = lr === 2 ? 1 : -1
  return {
    fb: fb && !unsafeStep(bot, forward[0] * fSign, forward[1] * fSign) ? fb : 0,
    lr: lr && !unsafeStep(bot, right[0] * rSign, right[1] * rSign) ? lr : 0
  }
}

// Which way is back from the edges within EDGE_PROBE, or null when there is none or it stands on a pillar
function edgePush (bot) {
  if (!bot.entity.onGround) return null
  let x = 0
  let z = 0
  for (const [dx, dz] of EIGHT) {
    if (!unsafeStep(bot, dx, dz, { step: EDGE_PROBE })) continue
    x -= dx
    z -= dz
  }
  return Math.hypot(x, z) > 1e-6 ? { x, z } : null
}

class TerrainGuard {
  constructor (bot) {
    this.bot = bot
    this.reset()
  }

  reset () {
    this.waterTicks = 0
    this.shore = null
    this.shoreAge = Infinity
    this.label = BASE_LABEL
    this.quiet = 0
  }

  // The action to play for this decision, who is moving the bot, and whether the scripted fighter should take over
  decide (action, target, ticks = 2) {
    const bot = this.bot
    const out = action.slice()
    const reasons = []
    let handover = null
    if (inWater(bot)) {
      this.waterTicks += ticks
      if (++this.shoreAge >= SHORE_EVERY) {
        this.shore = findShore(bot)
        this.shoreAge = 0
      }
      reasons.push('in water')
      if (!this.shore) handover = `in water with no dry ground within ${SHORE_RADIUS} blocks`
      else if (this.waterTicks >= WATER_TICKS) handover = `still in water after ${WATER_TICKS / 20} s`
      else this.steer(out, this.shore.x + 0.5 - bot.entity.position.x, this.shore.z + 0.5 - bot.entity.position.z, true)
    } else {
      this.waterTicks = 0
      this.shoreAge = Infinity
      const push = edgePush(bot)
      if (push) {
        reasons.push('at a ledge')
        this.steer(out, push.x, push.z, false)
      }
    }
    if (lowRoof(bot)) reasons.push('under a roof')
    if (target?.position && Math.abs(target.position.y - bot.entity.position.y) > TRAINED_LEVEL) reasons.push('mob on another level')
    return { action: out, handover, label: this.nextLabel(reasons), reasons }
  }

  steer (action, dx, dz, jump) {
    const { fb, lr } = feetToward(this.bot, dx, dz)
    action[FB] = fb
    action[LR] = lr
    action[SPRINT] = 0
    action[JUMP] = jump ? 1 : 0
  }

  nextLabel (reasons) {
    if (reasons.length) {
      this.quiet = 0
      this.label = `${BASE_LABEL}, movement guard: ${reasons.join(', ')}`
    } else if (this.label !== BASE_LABEL && ++this.quiet >= LABEL_HOLD) {
      this.label = BASE_LABEL
      this.quiet = 0
    }
    return this.label
  }
}

// A copy of the walking rules that will not drop off a ledge, for the network's walk toward a far mob
function noDropMoves (moves) {
  if (!moves) return moves
  const m = Object.create(moves)
  m.maxDropDown = NET_DROP
  return m
}

module.exports = { TerrainGuard, unsafeStep, inWater, findShore, edgePush, feetToward, noDropMoves, HAZARD, NET_DROP, WATER_TICKS, SHORE_RADIUS, TRAINED_LEVEL, BASE_LABEL }
