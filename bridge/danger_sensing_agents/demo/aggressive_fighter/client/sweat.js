// "Sweat" sword bot, ported from FatihBastan/mc-pvp-bots (arena/bots.mjs and arena/brain.mjs, MIT License,
// Copyright (c) 2026 Fatih Bastan), the Sweat tier. A sword only benchmark (a sword comboing bot
// from GitHub that our bot should beat, since it also has a shield, an axe, a crossbow and a bow).
//
// What it does, as in the original: chases with the pathfinder until within 4 blocks, then fights by hand. It sees
// its target 90 ms late and aims at that spot, closes to just inside 3 blocks of reach and backs off when hugging,
// strafes in bursts of 0.5 to 1.4 s (85% of bursts), swings only at full sword charge (13 ticks), jumps 6 ticks early
// on 75% of swings so the hit lands falling (a crit), W-taps after 80% of landed hits (sprint off for 2 ticks), and
// whiffs 4% of swings, more against a target that moved. Changes for our bridge: one target (our bot) instead of a
// free for all, no retargeting or swarm, and it holds the sword slot of our kit.

const MELEE_ENTER = 4.0
const MELEE_EXIT = 5.5
const HISTORY_MS = 700
const SWEAT = { reactionMs: 90, aimJitter: 0.04, reach: 3.0, cooldownSlackTicks: 0, strafe: 0.85, crit: 0.75, wtap: 0.8 }
const COOLDOWN_TICKS = 13 + SWEAT.cooldownSlackTicks  // full sword charge is 12.5 ticks

// Where the target was reactionMs ago, from the remembered positions
function laggedPosition (history, now, reactionMs) {
  if (!history.length) return null
  const t = now - reactionMs
  if (t <= history[0].t) return history[0]
  for (let i = history.length - 1; i > 0; i--) {
    const a = history[i - 1]
    const b = history[i]
    if (a.t <= t && t <= b.t) {
      const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t)
      return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k }
    }
  }
  return history[history.length - 1]
}

// A swing lands unless out of reach, or the lagged view drifted (aimJitter scales how often)
function swingLands (realDistance, laggedDistance, drift) {
  if (realDistance > SWEAT.reach) return false
  if (laggedDistance > SWEAT.reach + 0.6) return false
  return Math.random() >= Math.min(0.9, SWEAT.aimJitter * (1 + drift))
}

class SweatFighter {
  constructor (bot, target) {
    this.bot = bot
    this.target = target
    this.mode = 'idle'
    this.ticks = 0
    this.lastAttackTick = -100
    this.history = []
    this.strafeDir = null
    this.strafeUntil = 0
    this.critPendingUntilTick = -1
    this.critPlanned = false
    this.sprintResumeTick = -1
    this.chasingId = null
    this.onTick = () => this.tick()
    bot.on('physicsTick', this.onTick)
  }

  stop () {
    this.bot.removeListener('physicsTick', this.onTick)
    try {
      this.bot.pathfinder.setGoal(null)
      this.bot.clearControlStates()
    } catch (err) {}
  }

  tick () {
    const bot = this.bot
    const foe = this.target
    if (!bot.entity || bot.health <= 0 || !foe?.isValid) return
    this.ticks++
    const now = Date.now()
    this.history.push({ t: now, x: foe.position.x, y: foe.position.y, z: foe.position.z })
    while (this.history.length > 2 && now - this.history[0].t > HISTORY_MS) this.history.shift()

    const real = bot.entity.position.distanceTo(foe.position)
    if (this.mode !== 'melee' && real <= MELEE_ENTER && Math.abs(foe.position.y - bot.entity.position.y) < 1.5) {
      this.mode = 'melee'
      bot.pathfinder.setGoal(null)
    } else if (this.mode === 'melee' && real > MELEE_EXIT) {
      this.mode = 'idle'
      bot.clearControlStates()
    }
    if (this.mode !== 'melee') {
      if (this.mode !== 'chase' || this.chasingId !== foe.id) {
        const { goals } = require('mineflayer-pathfinder')
        bot.pathfinder.setGoal(new goals.GoalFollow(foe, 2), true)
        this.mode = 'chase'
        this.chasingId = foe.id
      }
      return
    }
    this.chasingId = null
    this.fight(bot, foe, real, now)
  }

  fight (bot, foe, real, now) {
    const t = SWEAT
    const lagged = laggedPosition(this.history, now, t.reactionMs) ?? foe.position
    const laggedDist = bot.entity.position.distanceTo(lagged)
    const drift = Math.hypot(foe.position.x - lagged.x, foe.position.z - lagged.z)

    // Look where we think they are (a beat late), at chest height
    bot.lookAt(foe.position.offset(lagged.x - foe.position.x, 1.2 + (lagged.y - foe.position.y), lagged.z - foe.position.z), true)

    // Close in to just inside reach, back off if hugging
    bot.setControlState('forward', laggedDist > t.reach - 0.4)
    bot.setControlState('back', laggedDist < 1.1)
    if (this.ticks >= this.sprintResumeTick) bot.setControlState('sprint', laggedDist > t.reach - 0.4)

    // Strafe in bursts
    if (now >= this.strafeUntil) {
      this.strafeDir = Math.random() < t.strafe ? (Math.random() < 0.5 ? 'left' : 'right') : null
      this.strafeUntil = now + 500 + Math.random() * 900
    }
    bot.setControlState('left', this.strafeDir === 'left')
    bot.setControlState('right', this.strafeDir === 'right')

    const since = this.ticks - this.lastAttackTick
    // Crit: jump about six ticks before the sword is charged, so the way down lines up with a full charge
    if (this.critPlanned && this.critPendingUntilTick < 0 && since >= COOLDOWN_TICKS - 6 && bot.entity.onGround) {
      bot.setControlState('jump', true)
      this.critPendingUntilTick = this.ticks + 12
    } else if (this.critPendingUntilTick >= 0 && !bot.entity.onGround) {
      bot.setControlState('jump', false)
    }
    if (since < COOLDOWN_TICKS) return
    if (this.critPendingUntilTick >= 0) {
      const falling = !bot.entity.onGround && bot.entity.velocity.y < -0.08
      if (!falling && this.ticks < this.critPendingUntilTick) return
      bot.setControlState('jump', false)
      this.critPendingUntilTick = -1
    }

    this.lastAttackTick = this.ticks
    this.critPlanned = Math.random() < t.crit
    if (swingLands(real, laggedDist, drift)) {
      bot.attack(foe)
      // W-tap: drop sprint for two ticks so the next hit knocks back again
      if (Math.random() < t.wtap) {
        bot.setControlState('sprint', false)
        this.sprintResumeTick = this.ticks + 2
      }
    } else {
      bot.swingArm('right')
    }
  }
}

module.exports = { SweatFighter }
