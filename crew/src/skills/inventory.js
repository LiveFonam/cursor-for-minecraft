'use strict'

function countItem (bot, names) {
  const wanted = new Set([].concat(names))
  return bot.inventory.items()
    .filter(item => wanted.has(item.name))
    .reduce((sum, item) => sum + item.count, 0)
}

function findItem (bot, names) {
  const items = bot.inventory.items()
  for (const name of [].concat(names)) {
    const match = items.find(item => item.name === name)
    if (match) return match
  }
  return null
}

// Item counts keyed by numeric item id, the form the craft planner reads.
function inventoryCounts (bot) {
  const counts = new Map()
  for (const item of bot.inventory.items()) {
    counts.set(item.type, (counts.get(item.type) ?? 0) + item.count)
  }
  return counts
}

async function equipItem (bot, item, destination = 'hand') {
  if (destination === 'hand' && bot.heldItem?.type === item.type) return
  await bot.equip(item, destination)
}

function hasFreeSlot (bot) {
  return bot.inventory.emptySlotCount() > 0
}

module.exports = { countItem, findItem, inventoryCounts, equipItem, hasFreeSlot }
