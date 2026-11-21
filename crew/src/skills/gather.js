'use strict'

const { countItem, hasFreeSlot } = require('./inventory')
const { isAbort, settle, throwIfAborted } = require('./abort')

// The collect plugin can wait forever on a drop it cannot reach, and a stuck
// task blocks every later collect call. A fresh instance clears that state.
function resetCollector (bot) {
  const stale = bot.collectBlock
  stale.targets?.clear?.()
  bot.collectBlock = new stale.constructor(bot)
  bot.collectBlock.movements = null
}

function stopWork (bot) {
  bot.pathfinder.setGoal(null)
  if (bot.targetDigBlock) bot.stopDigging()
}

async function collectOne (bot, block, { movements, signal, timeoutMs = 45000 } = {}) {
  throwIfAborted(signal)
  if (movements) bot.pathfinder.setMovements(movements)
  // With no movements of its own, the plugin keeps the active safety settings.
  bot.collectBlock.movements = null
  try {
    await settle(bot.collectBlock.collect(block), { signal, timeoutMs })
  } catch (err) {
    if (isAbort(err) || err.name === 'TimeoutError') {
      stopWork(bot)
      resetCollector(bot)
    }
    throw err
  }
}

function posKey (position) {
  return `${position.x},${position.y},${position.z}`
}

// Collects blocks until count more of itemNames are held, or none are left
// in range. Returns how many were gained.
async function gather (bot, {
  blockNames,
  itemNames,
  count,
  maxDistance = 32,
  movements,
  signal,
  isAllowed = () => true,
  beforeEach = async () => {}
}) {
  const ids = blockNames.map(name => bot.registry.blocksByName[name]?.id).filter(Number.isInteger)
  const start = countItem(bot, itemNames)
  const gained = () => countItem(bot, itemNames) - start
  const skipped = new Set()

  while (gained() < count) {
    throwIfAborted(signal)
    if (!hasFreeSlot(bot)) throw new Error('Inventory is full')

    const positions = bot.findBlocks({ matching: ids, maxDistance, count: 64 })
    const position = positions.find(p => !skipped.has(posKey(p)) && isAllowed(bot.blockAt(p)))
    if (!position) break

    await beforeEach()
    const block = bot.blockAt(position)
    try {
      await collectOne(bot, block, { movements, signal })
    } catch (err) {
      if (isAbort(err)) throw err
      skipped.add(posKey(position))
      continue
    }
    if (bot.blockAt(position)?.type === block.type) skipped.add(posKey(position))
  }
  return Math.max(0, gained())
}

module.exports = { gather, collectOne, resetCollector, stopWork }
