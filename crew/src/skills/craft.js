'use strict'

const { Vec3 } = require('vec3')
const { inventoryCounts, findItem, equipItem } = require('./inventory')
const { goNear } = require('./move')
const { settle, throwIfAborted } = require('./abort')

const SEARCH_BUDGET = 20000
const TABLE_RANGE = 32

class MissingItemsError extends Error {
  constructor (missing) {
    const list = Object.entries(missing).map(([name, count]) => `${count} ${name}`).join(', ')
    super(`Missing ${list}`)
    this.name = 'MissingItemsError'
    this.missing = missing
  }
}

function ingredientId (cell) {
  if (cell === null || cell === undefined) return null
  const id = typeof cell === 'number' ? cell : cell.id
  return id === undefined || id === null || id < 0 ? null : id
}

// Reduces a raw recipe to its ingredient counts, output and grid need.
function readRecipe (recipe) {
  const cells = recipe.inShape ? recipe.inShape.flat() : (recipe.ingredients ?? [])
  const ingredients = new Map()
  for (const cell of cells) {
    const id = ingredientId(cell)
    if (id !== null) ingredients.set(id, (ingredients.get(id) ?? 0) + 1)
  }
  let needsTable
  if (recipe.inShape) {
    const width = Math.max(...recipe.inShape.map(row => row.length))
    needsTable = recipe.inShape.length > 2 || width > 2
  } else {
    needsTable = cells.length > 4
  }
  return { ingredients, makes: recipe.result.count, needsTable }
}

function missingTotal (missing) {
  return Object.values(missing).reduce((sum, count) => sum + count, 0)
}

function addMissing (into, from) {
  for (const [name, count] of Object.entries(from)) into[name] = (into[name] ?? 0) + count
}

// Picks which failed recipe to report: fewest items short, then the common wood.
function betterFailure (candidate, current) {
  if (!current) return true
  const a = missingTotal(candidate)
  const b = missingTotal(current)
  if (a !== b) return a < b
  const oak = names => Object.keys(names).some(name => name.startsWith('oak_'))
  return oak(candidate) && !oak(current)
}

function resolveItem (search, id, need, stock, trail) {
  if (--search.budget < 0) throw new Error('Recipe search is too large')

  const have = stock.get(id) ?? 0
  const used = Math.min(have, need)
  stock.set(id, have - used)
  const short = need - used
  if (short === 0) return { ok: true, steps: [] }

  const name = search.registry.items[id].name
  const recipes = search.registry.recipes[id]
  if (!recipes || trail.has(id)) return { ok: false, missing: { [name]: short } }

  const nextTrail = new Set(trail).add(id)
  let failure = null
  for (const raw of recipes) {
    const recipe = readRecipe(raw)
    if (recipe.ingredients.has(id)) continue
    const batches = Math.ceil(short / recipe.makes)
    const trial = new Map(stock)
    const steps = []
    const missing = {}
    for (const [ingredient, perBatch] of recipe.ingredients) {
      const result = resolveItem(search, ingredient, perBatch * batches, trial, nextTrail)
      if (result.ok) steps.push(...result.steps)
      else addMissing(missing, result.missing)
    }
    if (Object.keys(missing).length === 0) {
      trial.set(id, (trial.get(id) ?? 0) + batches * recipe.makes - short)
      stock.clear()
      for (const [key, value] of trial) stock.set(key, value)
      steps.push({ id, name, batches, needsTable: recipe.needsTable, uses: recipe.ingredients })
      return { ok: true, steps }
    }
    if (betterFailure(missing, failure)) failure = missing
  }
  return { ok: false, missing: failure ?? { [name]: short } }
}

// Plans the ordered crafts that turn the stock into count of itemId.
// Stock is a Map of item id to count and is not changed.
function planCraft (registry, stock, itemId, count, { hasTable = false } = {}) {
  const search = { registry, budget: SEARCH_BUDGET }
  const held = stock.get(itemId) ?? 0
  const target = held + count

  const attempt = withTable => {
    const working = new Map(stock)
    const steps = []
    if (withTable) {
      const table = resolveItem(search, registry.itemsByName.crafting_table.id, 1, working, new Set())
      if (!table.ok) return { ok: false, missing: table.missing, steps: [] }
      steps.push(...table.steps)
    }
    const result = resolveItem(search, itemId, target, working, new Set())
    if (!result.ok) return { ok: false, missing: result.missing, steps: [] }
    steps.push(...result.steps)
    return { ok: true, missing: {}, steps }
  }

  const first = attempt(false)
  if (!first.ok || hasTable || !first.steps.some(step => step.needsTable)) return first
  return attempt(true)
}

function findTable (bot) {
  const id = bot.registry.blocksByName.crafting_table.id
  return bot.findBlock({ matching: id, maxDistance: TABLE_RANGE })
}

// Finds a floor spot next to the bot where a crafting table fits.
function tableSpot (bot) {
  const feet = bot.entity.position.floored()
  const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  for (const side of sides) {
    const spot = feet.plus(side)
    const air = bot.blockAt(spot)
    const floor = bot.blockAt(spot.offset(0, -1, 0))
    if (air?.name === 'air' && floor?.boundingBox === 'block') return floor
  }
  return null
}

async function ensureTable (bot, { movements, signal }) {
  const existing = findTable(bot)
  if (existing) {
    await goNear(bot, existing.position, 3, { movements, signal })
    return bot.blockAt(existing.position)
  }
  const item = findItem(bot, 'crafting_table')
  if (!item) throw new MissingItemsError({ crafting_table: 1 })
  const floor = tableSpot(bot)
  if (!floor) throw new Error('No room to place a crafting table')
  await equipItem(bot, item)
  await bot.placeBlock(floor, new Vec3(0, 1, 0))
  return bot.blockAt(floor.position.offset(0, 1, 0))
}

// True when a live recipe uses exactly the ingredients the plan reserved.
function matchesStep (recipe, step) {
  const used = new Map()
  for (const entry of recipe.delta ?? []) {
    if (entry.count < 0 && entry.id !== step.id) used.set(entry.id, (used.get(entry.id) ?? 0) - entry.count)
  }
  if (used.size !== step.uses.size) return false
  return [...step.uses].every(([id, count]) => used.get(id) === count)
}

async function craftItem (bot, name, count = 1, { movements, signal } = {}) {
  const item = bot.registry.itemsByName[name]
  if (!item) throw new Error(`Unknown item: ${name}`)
  // An item with no recipe has to be found, so it is reported as missing.
  if (!bot.registry.recipes[item.id]) throw new MissingItemsError({ [name]: count })

  const plan = planCraft(bot.registry, inventoryCounts(bot), item.id, count, { hasTable: Boolean(findTable(bot)) })
  if (!plan.ok) throw new MissingItemsError(plan.missing)

  for (const step of plan.steps) {
    throwIfAborted(signal)
    const table = step.needsTable ? await ensureTable(bot, { movements, signal }) : null
    const options = bot.recipesFor(step.id, null, 1, table)
    const recipe = options.find(option => matchesStep(option, step)) ?? options[0]
    if (!recipe) throw new Error(`Cannot craft ${step.name} right now`)
    await settle(bot.craft(recipe, step.batches, table ?? undefined), { signal, timeoutMs: 30000 })
  }
  return plan.steps
}

module.exports = { planCraft, readRecipe, craftItem, ensureTable, findTable, MissingItemsError }
