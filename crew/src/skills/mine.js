'use strict'

const { Vec3 } = require('vec3')
const { gather } = require('./gather')
const { craftItem, MissingItemsError } = require('./craft')
const { countItem, findItem, equipItem } = require('./inventory')
const { goTo, goals } = require('./move')
const { settle, throwIfAborted, isAbort } = require('./abort')

// The level each ore is commonly found near. Tunnels head for this height.
const ORE_LEVEL = { coal: 48, copper: 48, iron: 16, emerald: 16, lapis: 0, gold: -16, redstone: -58, diamond: -58 }
const DEFAULT_LEVEL = 16
const TOOL_ORDER = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite']
const HAZARDS = new Set(['lava', 'water', 'fire', 'soul_fire'])
const NEIGHBORS = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
  new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)
]
const DIRECTIONS = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)]
const UP = new Vec3(0, 1, 0)

// Turns a name like iron into its ore blocks and the items they drop.
function resolveMineTarget (registry, rawName) {
  const name = rawName.toLowerCase().replace(/^minecraft:/, '')
  const bare = name.replace(/^deepslate_/, '').replace(/_ore$/, '')
  const key = bare === 'lapis_lazuli' ? 'lapis' : bare
  const blocks = [`${key}_ore`, `deepslate_${key}_ore`].filter(block => registry.blocksByName[block])
  const isOre = blocks.length > 0
  if (!isOre) {
    const block = registry.blocksByName[name]
    if (!block || !block.diggable || block.name === 'air') return null
    blocks.push(name)
  }
  const drops = new Set()
  for (const blockName of blocks) {
    for (const drop of registry.blocksByName[blockName].drops ?? []) {
      const id = typeof drop === 'number' ? drop : drop?.drop?.id ?? drop?.id
      const item = registry.items[id]
      if (item) drops.add(item.name)
    }
  }
  if (drops.size === 0 && registry.itemsByName[name]) drops.add(name)
  if (drops.size === 0) return null
  return { name: key, blocks, items: [...drops], level: ORE_LEVEL[key] ?? DEFAULT_LEVEL }
}

// All tools able to harvest the block, cheapest first. Empty means any tool works.
function harvestToolNames (registry, blockName) {
  const tools = registry.blocksByName[blockName]?.harvestTools
  if (!tools) return []
  const rank = name => {
    const index = TOOL_ORDER.indexOf(name.split('_')[0])
    return index === -1 ? TOOL_ORDER.length : index
  }
  return Object.keys(tools)
    .map(id => registry.items[id].name)
    .sort((a, b) => rank(a) - rank(b))
}

async function ensureHarvestTool (bot, target, { movements, signal }) {
  const names = harvestToolNames(bot.registry, target.blocks[0])
  if (names.length === 0 || findItem(bot, names)) return
  for (const name of names) {
    try {
      await craftItem(bot, name, 1, { movements, signal })
      return
    } catch (err) {
      if (!(err instanceof MissingItemsError)) throw err
    }
  }
  throw new Error(`Need a ${names[0]} to mine ${target.name}`)
}

function touchesHazard (bot, position) {
  return NEIGHBORS.some(offset => HAZARDS.has(bot.blockAt(position.plus(offset))?.name))
}

function isSafeToDig (bot, block) {
  return Boolean(block) && block.diggable !== false && !touchesHazard(bot, block.position)
}

function isDark (block) {
  return (block?.light ?? 0) < 8 && (block?.skyLight ?? 0) < 8
}

function isOpen (block) {
  return block?.name === 'air' || block?.name === 'cave_air'
}

// Places a torch on the floor when the bot is in the dark and far from the last one.
async function placeTorchIfDark (bot, memo, { spacing = 7 } = {}) {
  const torch = findItem(bot, 'torch')
  if (!torch) return false
  const feet = bot.entity.position.floored()
  if (memo.lastTorch && memo.lastTorch.distanceTo(feet) < spacing) return false
  if (!isDark(bot.blockAt(feet))) return false

  const spots = [...DIRECTIONS.map(side => feet.plus(side)), feet]
  for (const spot of spots) {
    const floor = bot.blockAt(spot.offset(0, -1, 0))
    if (!isOpen(bot.blockAt(spot)) || floor?.boundingBox !== 'block') continue
    try {
      await equipItem(bot, torch)
      await bot.placeBlock(floor, UP)
      memo.lastTorch = feet
      return true
    } catch {
      // A failed torch never stops the mining job.
    }
  }
  return false
}

async function digIfNeeded (bot, position, signal) {
  const block = bot.blockAt(position)
  if (isOpen(block)) return true
  if (!isSafeToDig(bot, block)) return false
  await bot.tool.equipForBlock(block, { requireHarvest: false })
  throwIfAborted(signal)
  await settle(bot.dig(block, true), { signal, timeoutMs: 30000 })
  return true
}

// Digs one step of a tunnel. Goes down a stair step while above the wanted level.
async function tunnelStep (bot, direction, { descend, movements, signal }) {
  const feet = bot.entity.position.floored()
  const next = feet.plus(direction).offset(0, descend ? -1 : 0, 0)
  const floor = bot.blockAt(next.offset(0, -1, 0))
  if (floor?.boundingBox !== 'block' || HAZARDS.has(floor?.name)) return false

  const cells = [next, next.offset(0, 1, 0)]
  if (descend) cells.push(next.offset(0, 2, 0))
  for (const cell of cells) {
    const block = bot.blockAt(cell)
    if (!block || (!isOpen(block) && !isSafeToDig(bot, block))) return false
  }
  for (const cell of cells) {
    if (!await digIfNeeded(bot, cell, signal)) return false
  }
  try {
    await goTo(bot, new goals.GoalBlock(next.x, next.y, next.z), { movements, signal, timeoutMs: 10000 })
  } catch (err) {
    if (isAbort(err)) throw err
    return false
  }
  return true
}

async function tunnelOnward (bot, target, progress, { stepsPerLeg = 8, maxSteps = 200, movements, signal }) {
  let moved = false
  for (let step = 0; step < stepsPerLeg; step++) {
    throwIfAborted(signal)
    if (progress.steps >= maxSteps) return moved
    const descend = bot.entity.position.y > target.level
    let advanced = false
    for (let turn = 0; turn < DIRECTIONS.length; turn++) {
      if (await tunnelStep(bot, DIRECTIONS[progress.direction], { descend, movements, signal })) {
        advanced = true
        break
      }
      progress.direction = (progress.direction + 1) % DIRECTIONS.length
    }
    if (!advanced) return moved
    moved = true
    progress.steps++
    await placeTorchIfDark(bot, progress)
  }
  return moved
}

function newProgress () {
  return { done: 0, steps: 0, direction: 0, lastTorch: null }
}

// Mines until count items are gained. Safe to call again after an interruption,
// because progress lives in the object passed in.
async function mine (bot, target, count, { movements, signal, progress = newProgress() }) {
  const before = countItem(bot, target.items)
  const gainedNow = () => Math.max(0, countItem(bot, target.items) - before)
  const remaining = () => count - progress.done - gainedNow()

  try {
    while (remaining() > 0) {
      throwIfAborted(signal)
      await ensureHarvestTool(bot, target, { movements, signal })
      await gather(bot, {
        blockNames: target.blocks,
        itemNames: target.items,
        count: remaining(),
        movements,
        signal,
        isAllowed: block => isSafeToDig(bot, block),
        beforeEach: () => placeTorchIfDark(bot, progress)
      })
      if (remaining() <= 0) break
      if (!await tunnelOnward(bot, target, progress, { movements, signal })) break
    }
  } finally {
    progress.done += gainedNow()
  }
  return progress.done
}

module.exports = {
  mine,
  newProgress,
  resolveMineTarget,
  harvestToolNames,
  ensureHarvestTool,
  isSafeToDig,
  placeTorchIfDark,
  tunnelStep
}
