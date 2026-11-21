'use strict'

const { Vec3 } = require('vec3')
const { collectOne } = require('./gather')
const { countItem, findItem, equipItem, hasFreeSlot } = require('./inventory')
const { goNear } = require('./move')
const { isAbort, sleep, throwIfAborted } = require('./abort')

const MATURE_AGE = 7
const UP = new Vec3(0, 1, 0)
const HOES = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'golden_hoe', 'stone_hoe', 'wooden_hoe']
const TILLABLE = ['dirt', 'grass_block']
const WATER_RANGE = 4
const TILL_LIMIT = 9

function isMature (block) {
  const age = block.getProperties?.().age ?? block.metadata
  return Number(age) === MATURE_AGE
}

function search (bot, names, anchor, radius, count = 128) {
  const ids = names.map(name => bot.registry.blocksByName[name]?.id).filter(Number.isInteger)
  return bot.findBlocks({ point: anchor, matching: ids, maxDistance: radius, count })
}

function isAirAbove (bot, position) {
  return bot.blockAt(position.plus(UP))?.name === 'air'
}

function hasWaterNearby (bot, position) {
  for (let dx = -WATER_RANGE; dx <= WATER_RANGE; dx++) {
    for (let dz = -WATER_RANGE; dz <= WATER_RANGE; dz++) {
      if (bot.blockAt(position.offset(dx, 0, dz))?.name === 'water') return true
    }
  }
  return false
}

async function harvestRipe (bot, anchor, radius, { movements, signal }) {
  let done = 0
  for (const position of search(bot, ['wheat'], anchor, radius)) {
    throwIfAborted(signal)
    if (!hasFreeSlot(bot)) throw new Error('Inventory is full')
    const block = bot.blockAt(position)
    if (block?.name !== 'wheat' || !isMature(block)) continue
    try {
      await collectOne(bot, block, { movements, signal })
      done++
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  return done
}

async function plantEmpty (bot, anchor, radius, { movements, signal }) {
  let done = 0
  for (const position of search(bot, ['farmland'], anchor, radius)) {
    throwIfAborted(signal)
    const seeds = findItem(bot, 'wheat_seeds')
    if (!seeds) break
    if (!isAirAbove(bot, position)) continue
    try {
      await goNear(bot, position, 3, { movements, signal, timeoutMs: 20000 })
      await equipItem(bot, seeds)
      await bot.placeBlock(bot.blockAt(position), UP)
      done++
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  return done
}

// Tills ground near water. Used only when the area has no farmland at all.
async function tillNearWater (bot, anchor, radius, { movements, signal }) {
  const hoe = findItem(bot, HOES)
  if (!hoe) return 0
  let done = 0
  for (const position of search(bot, TILLABLE, anchor, radius, 256)) {
    throwIfAborted(signal)
    if (done >= TILL_LIMIT) break
    if (!isAirAbove(bot, position) || !hasWaterNearby(bot, position)) continue
    try {
      await goNear(bot, position, 3, { movements, signal, timeoutMs: 20000 })
      await equipItem(bot, hoe)
      await bot.activateBlock(bot.blockAt(position))
      if (bot.blockAt(position)?.name === 'farmland') done++
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  return done
}

// One round of farm work. Returns how many actions were done.
async function farmPass (bot, anchor, radius, options) {
  const harvested = await harvestRipe(bot, anchor, radius, options)
  let tilled = 0
  if (search(bot, ['farmland'], anchor, radius, 1).length === 0 && countItem(bot, 'wheat_seeds') > 0) {
    tilled = await tillNearWater(bot, anchor, radius, options)
  }
  const planted = await plantEmpty(bot, anchor, radius, options)
  return { harvested, tilled, planted }
}

// Farms until the signal aborts. Waits between rounds when nothing is ripe.
async function farmWheat (bot, anchor, { radius = 16, movements, signal, idleMs = 5000 }) {
  while (true) {
    throwIfAborted(signal)
    const result = await farmPass(bot, anchor, radius, { movements, signal })
    if (result.harvested + result.tilled + result.planted === 0) {
      const hasField = search(bot, ['farmland'], anchor, radius, 1).length > 0
      if (!hasField) throw new Error(`No farmland within ${radius} blocks, and I need a hoe, seeds and water nearby to make some`)
      await sleep(idleMs, signal)
    }
  }
}

module.exports = { farmWheat, farmPass, isMature }
