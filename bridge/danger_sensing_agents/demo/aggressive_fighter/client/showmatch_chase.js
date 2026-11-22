// Show match chase layer, on only with DEMO_SHOWMATCH=1. It sits between the network's action and the key presses.
//
// Outside melee range it runs the enemy down: faces them, holds forward and sprint, sprint-jumps on open ground, hops
// one block steps and steers around walls and lava. Shield, crossbow, bow and sneak are off so nothing slows it.
// Inside melee range the network keeps its attack and aim, but its movement can only close the distance.
//
// Turns still go through the action's yaw and pitch steps, so the camera cap in fighter.js holds.

const { Vec3 } = require('vec3')

// Off by default, the network plays its own movement unless DEMO_CHASE=1 asks for this layer
const SHOWMATCH_ON = process.env.DEMO_SHOWMATCH === '1' && process.env.DEMO_CHASE === '1'

// Action indices (fighter.js)
const FB = 0
const LR = 1
const SPRINT = 2
const JUMP = 3
const YAW = 4
const PITCH = 5
const ATTACK = 6
const USE = 7
const SLOT = 8
const SNEAK = 9
const LOCK = 10
const SLOT_AXE_ACTION = 1
const SLOT_RANGED_FIRST = 3

// Horizontal distance between feet. Reach is 3.0 from the eye to the hitbox, so about 3.3 between centers
const MELEE_RANGE = 3.2
// Sprint-jump all the way into range (a flat sprint only matches a sprinting runner), once running the right way
const JUMP_MAX_TURN = 20 * Math.PI / 180
// Key thresholds for moving toward the enemy in melee: sin(22.5 degrees), the edge of an 8 way key choice
const KEY_EDGE = 0.38
const KEEP_STRAFE_FWD = 0.7
const EYE = 1.62
const CHEST = 1.2
const PROBES = [0.7, 1.4]
// A sprint-jump covers about 4 blocks, so it only leaves the ground with that much safe floor ahead
const LANDING_PROBES = [2, 3, 4, 5]
// Enemy speed straight away from us, blocks a tick (2 a second): above this they are running, not fighting
const FLEE_SPEED = 0.1
const HOP_PROBE = 0.9
const STEER_DEGREES = [30, 60, 90, 120, 150]
// Paths are checked at the body's edges too, since a heading that scrapes a wall gets pinned against it
const BODY_EDGES = [0, -0.35, 0.35]
// Going around something, it only turns back to the enemy once this much of the direct line is clear, and tries the
// other way around after this many decisions (4 s)
const DETOUR_EXIT_PROBES = [0.7, 1.4, 2.1, 2.8, 3.5]
const DETOUR_MAX_STEPS = 40
const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'cactus', 'magma_block'])

const OPEN = 0
const STEP = 1
const BLOCKED = 2

const solid = b => !!b && b.boundingBox === 'block'
const rad = d => d * Math.PI / 180
const deg = r => r * 180 / Math.PI

function wrapAngle (r) {
  const t = (r + Math.PI) % (2 * Math.PI)
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI
}

function nearestIndex (steps, want) {
  let best = 0
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(steps[i] - want) < Math.abs(steps[best] - want)) best = i
  }
  return best
}

class ShowmatchChase {
  constructor (fighter, yawSteps, pitchSteps) {
    this.fighter = fighter
    this.bot = fighter.bot
    this.yawSteps = yawSteps
    this.pitchSteps = pitchSteps
    this.sprintJump = true
    this.wantSprint = false
    this.side = 1
    this.detourSteps = 0
    this.groundY = null
    // The fighter drops sprint after a sprint hit and actions come every 2 ticks, so this puts it back the next tick.
    // A round reset clears the forward key, which also ends this
    this.bot.on('physicsTick', () => {
      if (this.wantSprint && this.bot.getControlState('forward') && !this.bot.getControlState('sprint')) {
        this.bot.setControlState('sprint', true)
      }
    })
  }

  // The action to play instead of a. The caller's array is left alone
  shape (a) {
    const me = this.bot.entity
    const e = this.fighter.enemy.entity()
    if (!me || !e) {
      this.wantSprint = false
      return a
    }
    if (me.onGround || this.groundY === null) this.groundY = Math.floor(me.position.y + 0.01)
    const dx = e.position.x - me.position.x
    const dz = e.position.z - me.position.z
    const dist = Math.hypot(dx, dz)
    const out = a.slice()
    out[SNEAK] = 0
    out[LOCK] = 0
    // Bows and crossbows stop the run, so the fight stays on the axe or sword the network picks
    const w = this.fighter.weapon()
    if (w === 'crossbow' || w === 'bow') out[SLOT] = SLOT_AXE_ACTION
    else if (out[SLOT] >= SLOT_RANGED_FIRST) out[SLOT] = 0
    if (dist > MELEE_RANGE) this.chase(out, e, dx, dz, dist)
    else this.melee(out, dx, dz, dist)
    this.wantSprint = out[FB] === 1 && out[SPRINT] === 1
    return out
  }

  chase (out, e, dx, dz, dist) {
    const me = this.bot.entity
    const heading = this.steer(Math.atan2(-dx, -dz), dist)
    const turn = wrapAngle(heading - me.yaw)
    const pitch = Math.atan2(e.position.y + CHEST - me.position.y - EYE, dist)
    out[FB] = 1
    out[LR] = 0
    out[SPRINT] = 1
    out[USE] = 0
    // A swing out of reach would only throw away the charge for the first hit
    out[ATTACK] = 0
    out[YAW] = nearestIndex(this.yawSteps, deg(turn))
    out[PITCH] = nearestIndex(this.pitchSteps, deg(pitch - me.pitch))
    const fx = -Math.sin(heading)
    const fz = -Math.cos(heading)
    const ahead = this.probe(me.position.x + fx * HOP_PROBE, me.position.z + fz * HOP_PROBE)
    const open = Math.abs(turn) <= JUMP_MAX_TURN && this.canLeap(heading)
    out[JUMP] = ahead === STEP || (me.isCollidedHorizontally && ahead !== BLOCKED) || open ? 1 : 0
  }

  // Attack and aim stay the network's, and so do jump and shield unless the enemy is running. Its keys are replaced
  // whenever they would not close the distance
  melee (out, dx, dz, dist) {
    const me = this.bot.entity
    const ux = dx / (dist || 1)
    const uz = dz / (dist || 1)
    const fwd = ux * -Math.sin(me.yaw) + uz * -Math.cos(me.yaw)
    const right = ux * Math.cos(me.yaw) + uz * -Math.sin(me.yaw)
    const v = this.fighter.enemy.vel
    if (v.x * ux + v.z * uz > FLEE_SPEED) {
      out[USE] = 0
      if (fwd >= Math.cos(JUMP_MAX_TURN) && this.canLeap(me.yaw)) out[JUMP] = 1
    }
    out[FB] = fwd > KEY_EDGE ? 1 : fwd < -KEY_EDGE ? 2 : 0
    if (fwd <= KEEP_STRAFE_FWD || out[LR] === 0) out[LR] = right > KEY_EDGE ? 2 : right < -KEY_EDGE ? 1 : 0
    // A raised shield cannot sprint in vanilla
    out[SPRINT] = out[FB] === 1 && out[USE] === 0 ? 1 : 0
  }

  // The closest heading to want with a clear path. Once going around something it stays on that side
  steer (want, dist) {
    const direct = this.detourSteps > 0 ? DETOUR_EXIT_PROBES.filter(d => d < dist) : PROBES
    if (this.clear(want, direct)) {
      this.detourSteps = 0
      return want
    }
    if (++this.detourSteps > DETOUR_MAX_STEPS) {
      this.detourSteps = 1
      this.side = -this.side
    }
    for (const s of [this.side, -this.side]) {
      for (const d of STEER_DEGREES) {
        const heading = want + s * rad(d)
        if (this.clear(heading)) {
          this.side = s
          return heading
        }
      }
    }
    return want
  }

  clear (yaw, probes = PROBES) {
    const p = this.bot.entity.position
    const fx = -Math.sin(yaw)
    const fz = -Math.cos(yaw)
    return probes.every(d => BODY_EDGES.every(w => this.probe(p.x + fx * d + fz * w, p.z + fz * d - fx * w) !== BLOCKED))
  }

  canLeap (yaw) {
    return this.sprintJump && this.clear(yaw, LANDING_PROBES)
  }

  // OPEN to walk on, STEP to hop, BLOCKED for a wall, a drop or something that burns. Unloaded blocks count as open
  probe (x, z) {
    const at = dy => this.bot.blockAt(new Vec3(Math.floor(x), this.groundY + dy, Math.floor(z)))
    const feet = at(0)
    const head = at(1)
    const floor = at(-1)
    if ([feet, head, floor].some(b => b && HAZARDS.has(b.name))) return BLOCKED
    if (solid(feet) && (solid(head) || solid(at(2)))) return BLOCKED
    if (floor && !solid(floor) && !solid(feet)) {
      const under = at(-2)
      if (under && !solid(under)) return BLOCKED
    }
    return solid(feet) ? STEP : OPEN
  }
}

module.exports = { ShowmatchChase, SHOWMATCH_ON, MELEE_RANGE }
