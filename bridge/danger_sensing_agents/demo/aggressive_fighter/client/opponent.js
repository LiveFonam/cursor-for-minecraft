// Scripted opponents for the early lessons, from a punching bag up to a shield fighter.
// They go through the same Fighter rules as the learning bot (crosshair hits only, no swing while blocking).

const { YAW_STEPS, PITCH_STEPS, IDLE_ACTION } = require('./fighter')

const LEVEL_NAMES = ['punching bag', 'dodger', 'sword fighter', 'shield fighter']
LEVEL_NAMES[10] = 'blocker'  // DEC-114, the good-player blocker (brain/sim/opponent.py BLOCKER)
const BLOCKER = 10
const BLOCK_REACH = 4.5

const deg = r => r * 180 / Math.PI

function nearest (steps, value) {
  let best = 0
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(steps[i] - value) < Math.abs(steps[best] - value)) best = i
  }
  return best
}

class ScriptedOpponent {
  constructor (level) {
    this.level = level
    this.reset()
  }

  reset () {
    this.strafe = Math.random() < 0.5 ? 1 : 2
    this.strafeTimer = 0
    this.wtap = 0
    // Each round gets a slightly different skill so the bot does not overfit one style
    this.aim = 0.55 + Math.random() * 0.3
    this.reaction = Math.random() < 0.5 ? 0 : 1
    this.shieldTimer = 0
    this.prevYaw = null
    this.prevPitch = null
    this.step = 0
    this.loading = false
    this.firePressed = false
  }

  // Crossbow, the way players do it in duels: load it early while it is safe, then fire right after
  // a melee hit knocked them back (the combo) or when they are at range. Returns true when it used
  // the crossbow this step.
  crossbow (a, v) {
    this.step++
    const safe = v.dist > 5 || v.enemySinceSwing > 30
    if (v.arrows > 0 && !v.crossbowLoaded && (this.loading || (this.step < 60 && safe))) {
      this.loading = v.crossbowCharge < 1
      a[8] = 3
      a[6] = 0
      a[7] = v.crossbowCharge >= 1 ? 0 : 1
      return true
    }
    if (v.crossbowLoaded) {
      // Wait out their hurt window (10 ticks) after our melee hit, or the arrow does nothing
      const combo = v.sinceMeleeHit >= 10 && v.sinceMeleeHit <= 22 && v.dist > 2.5
      const range = v.dist > 6 && v.dist < 16
      if ((combo || range) && (v.longShot || v.weapon !== 'crossbow')) {
        a[8] = 3
        a[6] = 0
        a[7] = v.weapon === 'crossbow' && v.longShot && !this.firePressed ? 1 : 0
        this.firePressed = a[7] === 1
        return true
      }
    }
    this.firePressed = false
    return false
  }

  act (v) {
    if (this.level <= 0 || !v.visible) return IDLE_ACTION.slice()
    const a = IDLE_ACTION.slice()

    // Aim: close part of the gap each step, plus lead for how fast the target slides across the
    // view (mostly from our own strafing), with some wobble
    const yawErr = deg(v.yawErr)
    const pitchErr = deg(v.pitchErr)
    const lead = (now, prev) => (prev ? Math.max(-15, Math.min(15, now - (prev.err - prev.step))) : 0)
    const yawWant = yawErr * this.aim + 0.8 * lead(yawErr, this.prevYaw) + (Math.random() - 0.5) * 3
    const pitchWant = pitchErr * this.aim + 0.5 * lead(pitchErr, this.prevPitch) + (Math.random() - 0.5) * 1.5
    a[4] = nearest(YAW_STEPS, yawWant)
    a[5] = nearest(PITCH_STEPS, pitchWant)
    this.prevYaw = { err: yawErr, step: YAW_STEPS[a[4]] }
    this.prevPitch = { err: pitchErr, step: PITCH_STEPS[a[5]] }

    // Someone standing still and not swinging is not a threat: walk straight in and finish them
    const enemySpeed = Math.hypot(v.enemyVel[0], v.enemyVel[1])
    const passive = this.level >= 2 && enemySpeed < 0.04 && v.enemySinceSwing > 30 && !v.enemyShieldActive
    if (passive) {
      a[4] = nearest(YAW_STEPS, yawErr * 0.9)
      a[5] = nearest(PITCH_STEPS, pitchErr * 0.9)
      a[0] = v.dist > 2.6 ? 1 : 0
      a[2] = a[0]
      a[8] = 2
      if (v.charge > 0.92 && v.crosshair) a[6] = 1
      if (v.dist < 3.0 && v.charge > 0.8 && v.onGround && Math.random() < 0.15) {
        a[3] = 1
        a[2] = 0
      }
      if (!v.onGround && v.myVelY < 0 && v.charge > 0.9 && v.crosshair) a[6] = 1
      this.avoidLava(a, v)
      return a
    }

    // Movement: close the distance, then circle
    const usingCrossbow = this.level >= 2 && this.level !== BLOCKER && this.crossbow(a, v)
    if (--this.strafeTimer <= 0) {
      this.strafe = Math.random() < 0.5 ? 1 : 2
      this.strafeTimer = 10 + Math.floor(Math.random() * 25)
    }
    if (v.dist > 2.8) {
      a[0] = 1
      a[2] = 1
    } else if (v.dist < 1.8) {
      a[0] = 2
    }
    a[1] = this.strafe
    if (Math.random() < 0.03) a[3] = 1
    this.avoidLava(a, v)
    if (this.level === 1 || usingCrossbow) return a

    // Sword fighter: swing on a full charge when the crosshair is on target, w-tap after hits
    a[8] = 2
    if (this.wtap > 0) {
      this.wtap--
      a[0] = 0
      a[2] = 0
    }
    const ready = v.charge > 0.92 && v.crosshair
    if (ready && this.reaction-- <= 0) {
      a[6] = 1
      this.wtap = 1
      this.reaction = Math.random() < 0.5 ? 0 : 1
    }
    if (this.level === 2) return a

    if (this.level === BLOCKER) return this.blocker(a, v)
    // Shield fighter: axe their shield, punish with the sword, block when they are about to swing
    if (v.enemyShieldUp && v.dist < 3.5) {
      a[8] = 1
      a[6] = v.weapon === 'axe' && v.crosshair ? 1 : 0
      return a
    }
    if (v.enemyShieldCooldown > 0) {
      a[8] = 2
      a[6] = ready ? 1 : 0
      return a
    }
    const threatened = v.dist < 3.5 && v.enemyFacing > 0.6 && v.enemySinceSwing > 8
    if (this.shieldTimer > 0) this.shieldTimer--
    if (threatened && v.charge < 0.7 && v.shieldCooldown <= 0 && Math.random() < 0.6) this.shieldTimer = 4
    if (this.shieldTimer > 0) {
      a[7] = 1
      a[6] = 0
      a[2] = 0
    }
    // Crit: jump on a full charge, swing while falling
    if (!a[7] && v.dist < 3.0 && v.charge > 0.8 && v.onGround && Math.random() < 0.08) a[3] = 1
    if (!a[7] && !v.onGround && v.myVelY < 0 && v.charge > 0.9 && v.crosshair) a[6] = 1
    return a
  }
}

// DEC-114, the good-player blocker, the same rules as brain/sim/opponent.py blocker(): the shield fighter's movement and
// aim, its shield up whenever we are within BLOCK_REACH except for its own swing, and up against our drawn bow, loading
// or loaded crossbow at any distance after 1 or 2 decisions. The axe out, into our raised shield at any charge, the
// sword only while our shield is down. It never uses its crossbow (act() skips it for this level)
ScriptedOpponent.prototype.blocker = function (a, v) {
  const threat = v.enemyRangedUse || v.enemyLoaded
  if (!threat) this.blockReact = -1
  else if (this.blockReact === undefined || this.blockReact < 0) this.blockReact = 1 + Math.floor(Math.random() * 2)
  else this.blockReact = Math.max(this.blockReact - 1, 0)
  const ranged = threat && this.blockReact === 0
  const oursDown = v.enemyShieldCooldown > 0
  a[8] = oursDown ? 2 : 1
  const right = v.weapon === (oursDown ? 'sword' : 'axe')
  const axeOurs = v.enemyShieldUp && v.weapon === 'axe'
  const swing = v.dist < 3.0 && v.crosshair && right && (axeOurs || v.charge > 0.92)
  const up = v.shieldCooldown <= 0 && !swing && (ranged || v.dist < BLOCK_REACH)
  a[6] = swing ? 1 : 0
  a[7] = up ? 1 : 0
  if (up) { a[2] = 0; a[3] = 0 }
  return a
}

ScriptedOpponent.prototype.avoidLava = function (a, v) {
  const t = v.terrain
  if (!t) return
  if (t.lavaAhead && a[0] === 1) {
    a[0] = 0
    a[2] = 0
    a[3] = 0
  }
  if (t.lavaBehind && a[0] === 2) a[0] = 0
  if (t.lavaLeft && a[1] === 1) a[1] = t.lavaRight ? 0 : 2
  if (t.lavaRight && a[1] === 2) a[1] = t.lavaLeft ? 0 : 1
  if (a[1] !== this.strafe) this.strafe = a[1] || this.strafe
}

module.exports = { ScriptedOpponent, LEVEL_NAMES }
