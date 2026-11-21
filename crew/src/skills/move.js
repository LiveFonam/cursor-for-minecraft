'use strict'

const { Movements, goals } = require('mineflayer-pathfinder')
const { isAbort, settle, sleep, throwIfAborted } = require('./abort')

// The safe profile never breaks blocks, so walking cannot damage a base.
// The dig profile is used only by jobs that are meant to break blocks.
function createMovements (bot) {
  const safe = new Movements(bot)
  safe.canDig = false
  safe.allow1by1towers = false
  safe.scafoldingBlocks = []
  safe.maxDropDown = 3

  const dig = new Movements(bot)
  dig.canDig = true
  dig.allow1by1towers = false
  dig.scafoldingBlocks = []
  dig.maxDropDown = 3
  dig.dontCreateFlow = true
  dig.dontMineUnderFallingBlock = true

  return { safe, dig }
}

async function goTo (bot, goal, { movements, signal, timeoutMs = 60000 } = {}) {
  throwIfAborted(signal)
  if (movements) bot.pathfinder.setMovements(movements)
  try {
    await settle(bot.pathfinder.goto(goal), { signal, timeoutMs })
  } catch (err) {
    if (isAbort(err) || err.name === 'TimeoutError') bot.pathfinder.setGoal(null)
    throw err
  }
}

function goNear (bot, position, range, options) {
  const { x, y, z } = position.floored()
  return goTo(bot, new goals.GoalNear(x, y, z, range), options)
}

// Keeps following whatever entity getEntity returns until the signal aborts.
async function follow (bot, getEntity, { range = 2, movements, signal, pollMs = 500 } = {}) {
  let current = null
  if (movements) bot.pathfinder.setMovements(movements)
  try {
    while (true) {
      throwIfAborted(signal)
      const entity = getEntity()
      if (entity !== current) {
        current = entity
        bot.pathfinder.setGoal(entity ? new goals.GoalFollow(entity, range) : null, Boolean(entity))
      }
      await sleep(pollMs, signal)
    }
  } finally {
    bot.pathfinder.setGoal(null)
  }
}

// Candidate escape points, straight away from the threat first, then fanning out.
function retreatPoints (from, threat, distance) {
  let dx = from.x - threat.x
  let dz = from.z - threat.z
  const length = Math.hypot(dx, dz)
  if (length < 0.01) {
    dx = 1
    dz = 0
  } else {
    dx /= length
    dz /= length
  }
  return [0, 45, -45, 90, -90].map(degrees => {
    const angle = degrees * Math.PI / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    return {
      x: Math.round(from.x + (dx * cos - dz * sin) * distance),
      z: Math.round(from.z + (dx * sin + dz * cos) * distance)
    }
  })
}

async function retreatFrom (bot, threatPosition, { distance = 14, movements, signal, timeoutMs = 7000 } = {}) {
  for (const point of retreatPoints(bot.entity.position, threatPosition, distance)) {
    try {
      await goTo(bot, new goals.GoalNearXZ(point.x, point.z, 2), { movements, signal, timeoutMs })
      return true
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  return false
}

module.exports = { createMovements, goTo, goNear, follow, retreatFrom, retreatPoints, goals }
