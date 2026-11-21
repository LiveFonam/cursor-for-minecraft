'use strict'

const { eat, bestFood } = require('./eat')
const { retreatFrom } = require('./move')
const { nearestThreat, nearbyCreeper } = require('../combat/targets')
const { isAbort, sleep } = require('./abort')

const TUNING = {
  eatAtFood: 14,
  retreatHealth: 6,
  resumeHealth: 12,
  threatRadius: 8,
  creeperRadius: 5,
  cornerCooldownMs: 5000,
  eatCooldownMs: 10000
}

// Decides what survival needs right now, or null when the bot is fine.
function assessSurvival (ctx, now = Date.now()) {
  const { bot, state } = ctx
  const tuning = ctx.tuning ?? TUNING
  const threat = nearestThreat(bot, tuning.threatRadius)

  if (state.retreating && (!threat || bot.health >= tuning.resumeHealth)) state.retreating = false
  if (threat && bot.health <= tuning.retreatHealth) state.retreating = true

  if (now >= (state.corneredUntil ?? 0)) {
    const creeper = nearbyCreeper(bot, tuning.creeperRadius)
    if (creeper) return { action: 'retreat', threat: creeper }
    if (state.retreating) return { action: 'retreat', threat }
  }

  const hungry = bot.food <= tuning.eatAtFood || (bot.health <= tuning.retreatHealth && bot.food < 20)
  if (hungry && now >= (state.eatBlockedUntil ?? 0) && bestFood(bot)) return { action: 'eat' }
  return null
}

async function runSurvival (ctx, signal, now = Date.now) {
  const { bot, state, movements } = ctx
  const tuning = ctx.tuning ?? TUNING
  const need = assessSurvival(ctx, now())
  if (!need) return

  if (need.action === 'retreat') {
    const escaped = await retreatFrom(bot, need.threat.position, { movements: movements.safe, signal })
    if (!escaped) state.corneredUntil = now() + tuning.cornerCooldownMs
    return
  }

  try {
    const ate = await eat(bot, { signal })
    if (!ate) state.eatBlockedUntil = now() + tuning.eatCooldownMs
  } catch (err) {
    if (isAbort(err)) throw err
    state.eatBlockedUntil = now() + tuning.eatCooldownMs
    await sleep(100, signal)
  }
}

module.exports = { assessSurvival, runSurvival, TUNING }
