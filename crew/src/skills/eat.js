'use strict'

const { equipItem } = require('./inventory')
const { isAbort, settle } = require('./abort')

// Harmful foods, plus golden apples, which are left for the owner.
const NEVER_EAT = new Set([
  'rotten_flesh',
  'spider_eye',
  'poisonous_potato',
  'pufferfish',
  'chicken',
  'suspicious_stew',
  'golden_apple',
  'enchanted_golden_apple',
  'chorus_fruit'
])

function bestFood (bot) {
  const foods = bot.registry.foodsByName
  let best = null
  let bestScore = -1
  for (const item of bot.inventory.items()) {
    const food = foods[item.name]
    if (!food || NEVER_EAT.has(item.name)) continue
    const score = food.saturation + food.foodPoints / 100
    if (score > bestScore) {
      best = item
      bestScore = score
    }
  }
  return best
}

async function eat (bot, { signal, timeoutMs = 6000 } = {}) {
  const food = bestFood(bot)
  if (!food) return false
  await equipItem(bot, food)
  try {
    await settle(bot.consume(), { signal, timeoutMs })
  } catch (err) {
    if (isAbort(err) || err.name === 'TimeoutError') bot.deactivateItem?.()
    throw err
  }
  return true
}

module.exports = { eat, bestFood, NEVER_EAT }
