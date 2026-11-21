'use strict'

// These mobs are left alone unless the owner names them.
// Creepers explode in melee, and the others are neutral until provoked.
const NO_AUTO_ATTACK = new Set(['creeper', 'enderman', 'zombified_piglin', 'piglin', 'piglin_brute'])
const LIVING_TYPES = new Set(['hostile', 'animal', 'passive', 'mob', 'ambient', 'water_creature'])

function isLive (entity) {
  if (!entity || entity.isValid === false) return false
  return entity.health === undefined || entity.health > 0
}

function isHostile (entity) {
  return entity?.type === 'hostile' && isLive(entity)
}

function nearestHostile (bot, radius, center = bot.entity.position) {
  return bot.nearestEntity(entity =>
    isHostile(entity) &&
    !NO_AUTO_ATTACK.has(entity.name) &&
    entity.position.distanceTo(center) <= radius
  )
}

function nearestThreat (bot, radius) {
  const center = bot.entity.position
  return bot.nearestEntity(entity => isHostile(entity) && entity.position.distanceTo(center) <= radius)
}

function nearbyCreeper (bot, radius) {
  const center = bot.entity.position
  return bot.nearestEntity(entity =>
    entity.name === 'creeper' && isLive(entity) && entity.position.distanceTo(center) <= radius
  )
}

// Finds a target by player name, or the nearest living mob of that type.
function findNamedTarget (bot, name, radius = 32) {
  const wanted = name.toLowerCase()
  for (const [username, player] of Object.entries(bot.players)) {
    if (username.toLowerCase() === wanted) return isLive(player.entity) ? player.entity : null
  }
  const center = bot.entity.position
  return bot.nearestEntity(entity =>
    entity.name === wanted &&
    LIVING_TYPES.has(entity.type) &&
    isLive(entity) &&
    entity.position.distanceTo(center) <= radius
  )
}

module.exports = { isLive, isHostile, nearestHostile, nearestThreat, nearbyCreeper, findNamedTarget, NO_AUTO_ATTACK }
