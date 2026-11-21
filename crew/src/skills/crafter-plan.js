'use strict'

// The crafter's planner: the crafts and smelts that turn the bag into one item,
// and what is still missing. Pure, so the tests run it without a server.
// Recipes come from minecraft-data. Smelting is not in minecraft-data, so the
// one smelt the crafter needs (raw iron to iron ingots) is listed here.

const TARGETS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'furnace', 'crafting_table']

const ALIASES = {
  wooden_pickaxe: ['wooden pickaxe', 'wood pickaxe', 'wooden pick', 'wood pick', 'plank pickaxe'],
  stone_pickaxe: ['stone pickaxe', 'cobblestone pickaxe', 'cobble pickaxe', 'stone pick', 'cobblestone pick', 'cobble pick'],
  iron_pickaxe: ['iron pickaxe', 'iron pick'],
  diamond_pickaxe: ['diamond pickaxe', 'diamond pick'],
  furnace: ['furnace'],
  crafting_table: ['crafting table', 'craft table', 'workbench', 'table']
}

const SMELTS = { iron_ingot: ['raw_iron'] }

// Things it crafts on the way. Anything else is a raw material: crafted only
// when the bag already holds everything it takes (a diamond from a diamond block).
const INTERMEDIATE = /^(.*_planks|stick|crafting_table|furnace|iron_ingot|(wooden|stone|iron|diamond)_pickaxe)$/

// What a plan may ask for: things you get by breaking blocks, never a crafted
// form like an iron block, or the 27 nuggets that make 3 ingots.
const BASE = /^(.*_log|cobblestone|cobbled_deepslate|blackstone|raw_iron|iron_ingot|diamond|coal|charcoal|bamboo)$/

// Smelting fuel, as items smelted per fuel item
const FUEL = [['coal_block', 80], ['coal', 8], ['charcoal', 8], ['blaze_rod', 12]]
const WOOD_FUEL = 1.5
const STICK_FUEL = 0.5

const sum = map => [...map.values()].reduce((a, b) => a + b, 0)
const add = (map, key, n) => map.set(key, (map.get(key) ?? 0) + n)
// The usual things to ask for when several variants would do
const COMMON = new Set(['oak_log', 'cobblestone', 'raw_iron', 'iron_ingot', 'diamond', 'coal'])

// Fewest items missing; then asking for what the bag already had or the usual
// thing (oak logs, not pale oak; cobblestone, not deepslate); then fewest steps.
function score (trial, opts) {
  let odd = 0
  for (const key of trial.missing.keys()) if (!opts.known.has(key) && !COMMON.has(key)) odd++
  return sum(trial.missing) * 1000 + odd * 10 + trial.steps.length
}

function label (name) {
  return name.replace(/_/g, ' ')
}

function withArticle (name) {
  const text = label(name)
  return `${/^[aeiou]/.test(text) ? 'an' : 'a'} ${text}`
}

// Each raw recipe as { uses: Map name to count, makes, needsTable }
function recipesOf (registry, name) {
  const item = registry.itemsByName[name]
  if (!item) return []
  return (registry.recipes[item.id] ?? []).map(raw => {
    const cells = raw.inShape ? raw.inShape.flat() : (raw.ingredients ?? [])
    const uses = new Map()
    for (const cell of cells) {
      const id = typeof cell === 'number' ? cell : cell?.id
      if (id === null || id === undefined || id < 0) continue
      add(uses, registry.items[id].name, 1)
    }
    const width = raw.inShape ? Math.max(...raw.inShape.map(row => row.length)) : 0
    const needsTable = raw.inShape ? raw.inShape.length > 2 || width > 2 : cells.length > 4
    return { uses, makes: raw.result.count, needsTable }
  })
}

function clone (state) {
  return {
    stock: new Map(state.stock),
    steps: state.steps.map(step => ({ ...step })),
    missing: new Map(state.missing),
    smelting: state.smelting
  }
}

function need (registry, state, name, n, opts, chain = []) {
  const have = state.stock.get(name) ?? 0
  const used = Math.min(have, n)
  state.stock.set(name, have - used)
  const short = n - used
  if (short <= 0) return
  if (chain.length > 8 || chain.includes(name)) return add(state.missing, name, short)
  const next = [...chain, name]

  const tries = []
  for (const recipe of recipesOf(registry, name)) {
    if (recipe.uses.has(name)) continue
    const trial = clone(state)
    const batches = Math.ceil(short / recipe.makes)
    for (const [ingredient, per] of recipe.uses) need(registry, trial, ingredient, per * batches, opts, next)
    trial.steps.push({ kind: 'craft', name, batches, needsTable: recipe.needsTable, uses: recipe.uses })
    add(trial.stock, name, batches * recipe.makes - short)
    tries.push(trial)
  }
  for (const input of SMELTS[name] ?? []) {
    const trial = clone(state)
    if (!opts.furnaceNear && !trial.smelting) need(registry, trial, 'furnace', 1, opts, next)
    trial.smelting = true
    need(registry, trial, input, short, opts, next)
    trial.steps.push({ kind: 'smelt', name, input, count: short, fuel: [] })
    tries.push(trial)
  }

  const base = sum(state.missing)
  const complete = tries.filter(trial => sum(trial.missing) === base)
  const askable = tries.filter(trial => [...trial.missing].every(([key, count]) => count <= (state.missing.get(key) ?? 0) || BASE.test(key)))
  let best = null
  if (complete.length) best = complete.sort((a, b) => score(a, opts) - score(b, opts))[0]
  else if (INTERMEDIATE.test(name) && askable.length) best = askable.sort((a, b) => score(a, opts) - score(b, opts))[0]
  if (best) Object.assign(state, best)
  else add(state.missing, name, short)
}

// Fuel for each smelt from what the crafts leave: coal first, then spare wood.
function planFuel (state) {
  for (const step of state.steps.filter(s => s.kind === 'smelt')) {
    let burn = step.count
    const take = (item, per) => {
      const have = state.stock.get(item) ?? 0
      if (!have || burn <= 0) return
      const n = Math.min(have, Math.ceil(burn / per))
      state.stock.set(item, have - n)
      burn -= n * per
      step.fuel.push([item, n])
    }
    for (const [item, per] of FUEL) take(item, per)
    for (const [item, count] of [...state.stock]) if (count > 0 && /_planks$/.test(item)) take(item, WOOD_FUEL)
    for (const [item, count] of [...state.stock]) if (count > 0 && /_log$/.test(item) && !/crimson|warped/.test(item)) take(item, WOOD_FUEL)
    take('stick', STICK_FUEL)
    if (burn > 0) {
      add(state.missing, 'coal', Math.ceil(burn / 8))
      step.fuel.push(['coal', Math.ceil(burn / 8)])
    }
  }
}

function pass (registry, target, have, opts, extra = []) {
  const state = { stock: new Map(have), steps: [], missing: new Map(), smelting: false }
  for (const [name, n] of extra) need(registry, state, name, n, opts)
  need(registry, state, target, 1, opts)
  planFuel(state)
  return state
}

// Joins repeated crafts of one item at its first place.
function merge (steps) {
  const out = []
  const at = new Map()
  for (const step of steps) {
    if (step.kind === 'craft' && at.has(step.name)) out[at.get(step.name)].batches += step.batches
    else {
      if (step.kind === 'craft') at.set(step.name, out.length)
      out.push({ ...step })
    }
  }
  return out
}

// One of target from have, a Map of item name to count. tableNear and
// furnaceNear say whether one is in reach. Without a table it plans one and
// counts its wood. Returns { steps, missing }.
function planItem (registry, target, have, { tableNear = false, furnaceNear = false } = {}) {
  const known = new Set([...have.keys()].flatMap(name => [name, name.replace(/_planks$/, '_log')]))
  const opts = { furnaceNear, known }
  let state = pass(registry, target, have, opts)
  const needsTable = state.steps.some(step => step.kind === 'craft' && step.needsTable)
  if (needsTable && !tableNear && target !== 'crafting_table' && !((have.get('crafting_table') ?? 0) > 0)) {
    state = pass(registry, target, have, opts, [['crafting_table', 1]])
  }
  return { steps: merge(state.steps), missing: state.missing }
}

// "me a stone pickaxe", "cobblestone pickaxe", "stone_pickaxe" to a target, or null
function resolveTarget (words) {
  const text = [].concat(words).join(' ').toLowerCase()
    .replace(/^minecraft:/, '').replace(/[_-]+/g, ' ').replace(/[!?.,]/g, ' ')
    .replace(/^(?:me |us )?(?:a |an |one |1 )?/, '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  const snake = text.replace(/ /g, '_')
  if (TARGETS.includes(snake)) return snake
  for (const target of TARGETS) if (ALIASES[target].includes(text)) return target
  return null
}

// "1 cobblestone and 3 oak logs"
function describeMissing (missing) {
  // oak logs, sticks, diamonds; but cobblestone, coal, raw iron stay as they are
  const plural = name => /(_log|_planks|stick|_ingot|diamond|_pickaxe)$/.test(name)
  const parts = [...missing].filter(([, n]) => n > 0).map(([name, n]) => `${n} ${label(name)}${n > 1 && plural(name) ? 's' : ''}`)
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

module.exports = { TARGETS, ALIASES, SMELTS, planItem, recipesOf, resolveTarget, describeMissing, label, withArticle }
