'use strict'

const { Vec3 } = require('vec3')
const { expandBlueprint, countMaterials } = require('./blueprint')
const { craftItem, MissingItemsError } = require('./craft')
const { countItem, findItem, equipItem } = require('./inventory')
const { goTo, goals } = require('./move')
const { settle, throwIfAborted, isAbort } = require('./abort')

const REACH = 4.2
const EYE_HEIGHT = 1.62
const FACES = [
  new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)
]
// These need a block directly below them.
const FLOOR_ONLY = /(_door|torch|fence_gate)$/
// Clicking these opens a screen instead of placing a block against them.
const INTERACTIVE = /(door|gate|chest|crafting_table|furnace|barrel|bed|anvil|lever|button|shulker|hopper)/
const REPLACEABLE = new Set(['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow'])

function key (p) {
  return `${p.x},${p.y},${p.z}`
}

function isEmpty (block) {
  return block?.name === 'air' || block?.name === 'cave_air'
}

function worldCells (blueprint, origin) {
  return expandBlueprint(blueprint).map(cell => ({
    ...cell,
    position: origin.offset(cell.x, cell.y, cell.z)
  }))
}

function isDone (bot, cell) {
  const block = bot.blockAt(cell.position)
  if (!block) return false
  if (cell.block === 'air') return isEmpty(block)
  return block.name === cell.block
}

function canSupport (block) {
  return Boolean(block) && block.boundingBox === 'block' && !INTERACTIVE.test(block.name)
}

// Finds a solid neighbor to click, and the face that points at the cell.
function findReference (bot, cell) {
  const faces = FLOOR_ONLY.test(cell.block) ? [FACES[0]] : FACES
  for (const offset of faces) {
    const neighbor = bot.blockAt(cell.position.plus(offset))
    if (canSupport(neighbor)) return { block: neighbor, face: offset.scaled(-1) }
  }
  return null
}

function inReach (bot, position) {
  const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0)
  return eye.distanceTo(position.offset(0.5, 0.5, 0.5)) <= REACH
}

function bodyOverlaps (bot, position) {
  const feet = bot.entity.position.floored()
  return key(feet) === key(position) || key(feet.offset(0, 1, 0)) === key(position)
}

// Finds a place to stand within reach that no unfinished cell will fill.
function standSpots (bot, target, reserved) {
  const spots = []
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dy = -3; dy <= 1; dy++) {
        const feet = target.offset(dx, dy, dz)
        const head = feet.offset(0, 1, 0)
        if (reserved.has(key(feet)) || reserved.has(key(head))) continue
        if (key(feet) === key(target) || key(head) === key(target)) continue
        if (!REPLACEABLE.has(bot.blockAt(feet)?.name) || !REPLACEABLE.has(bot.blockAt(head)?.name)) continue
        if (bot.blockAt(feet.offset(0, -1, 0))?.boundingBox !== 'block') continue
        const eye = feet.offset(0.5, EYE_HEIGHT, 0.5)
        if (eye.distanceTo(target.offset(0.5, 0.5, 0.5)) > REACH) continue
        spots.push(feet)
      }
    }
  }
  const here = bot.entity.position
  return spots.sort((a, b) => a.distanceTo(here) - b.distanceTo(here))
}

async function moveIntoReach (bot, target, reserved, { movements, signal }) {
  if (inReach(bot, target) && !bodyOverlaps(bot, target)) return true
  for (const spot of standSpots(bot, target, reserved).slice(0, 5)) {
    try {
      await goTo(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), { movements, signal, timeoutMs: 20000 })
      if (inReach(bot, target) && !bodyOverlaps(bot, target)) return true
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }
  return false
}

function materialsShort (bot, cells) {
  const short = {}
  for (const [name, need] of Object.entries(countMaterials(cells))) {
    const have = countItem(bot, name)
    if (have < need) short[name] = need - have
  }
  return short
}

async function ensureMaterials (bot, cells, { movements, signal }) {
  for (const [name, count] of Object.entries(materialsShort(bot, cells))) {
    try {
      await craftItem(bot, name, count, { movements, signal })
    } catch (err) {
      if (!(err instanceof MissingItemsError)) throw err
    }
  }
  const short = materialsShort(bot, cells)
  if (Object.keys(short).length > 0) throw new MissingItemsError(short)
}

async function clearCell (bot, cell, reserved, options) {
  const block = bot.blockAt(cell.position)
  if (!block || isEmpty(block)) return true
  if (block.diggable === false) return false
  if (!await moveIntoReach(bot, cell.position, reserved, options)) return false
  await bot.tool.equipForBlock(block, { requireHarvest: false })
  await settle(bot.dig(block, true), { signal: options.signal, timeoutMs: 30000 })
  return isEmpty(bot.blockAt(cell.position))
}

async function placeCell (bot, cell, reserved, options) {
  const reference = findReference(bot, cell)
  if (!reference) return false
  const item = findItem(bot, cell.block)
  if (!item) return false
  if (!await moveIntoReach(bot, cell.position, reserved, options)) return false
  await equipItem(bot, item)
  await bot.placeBlock(reference.block, reference.face)
  return isDone(bot, cell)
}

// Builds a blueprint at origin. Finished cells are skipped, so calling this
// again after an interruption carries on where it stopped.
async function buildBlueprint (bot, blueprint, origin, { movements, signal }) {
  const cells = worldCells(blueprint, origin)
  const options = { movements, signal }
  const pendingPlacement = () => cells.filter(cell => cell.block !== 'air' && !cell.auto && !isDone(bot, cell))

  await ensureMaterials(bot, pendingPlacement(), options)

  const reserved = new Set(cells.filter(cell => cell.block !== 'air').map(cell => key(cell.position)))

  // Clear anything in the way first, including the space for door tops.
  for (const cell of cells) {
    throwIfAborted(signal)
    if (isDone(bot, cell)) continue
    const block = bot.blockAt(cell.position)
    const needsClear = cell.block === 'air' || cell.auto || !REPLACEABLE.has(block?.name)
    if (!needsClear || isEmpty(block)) continue
    try {
      await clearCell(bot, cell, reserved, options)
    } catch (err) {
      if (isAbort(err)) throw err
    }
  }

  // Blocks can depend on each other, so repeat until a pass places nothing.
  let progress = true
  while (progress) {
    progress = false
    for (const cell of pendingPlacement()) {
      throwIfAborted(signal)
      try {
        if (await placeCell(bot, cell, reserved, options)) progress = true
      } catch (err) {
        if (isAbort(err)) throw err
      }
    }
  }

  const failed = cells.filter(cell => !isDone(bot, cell)).length
  return { total: cells.length, failed }
}

module.exports = { buildBlueprint, findReference, standSpots, worldCells, materialsShort }
