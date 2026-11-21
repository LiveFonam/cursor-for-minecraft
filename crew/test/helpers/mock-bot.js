'use strict'

const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const minecraftData = require('minecraft-data')

const VERSION = '1.21.4'
const registry = minecraftData(VERSION)

function key (p) {
  return `${p.x},${p.y},${p.z}`
}

// A small in-memory stand-in for a mineflayer bot on a flat world.
// Blocks below groundY are stone and the rest is air, unless set otherwise.
function createMockBot ({
  username = 'CrewHelper1',
  owner = 'TestOwner',
  ownerUuid = 'owner-uuid',
  position = new Vec3(0, 64, 0),
  groundY = 64,
  items = {},
  health = 20,
  food = 20
} = {}) {
  const bot = new EventEmitter()
  bot.setMaxListeners(50)
  const world = new Map()
  const blockProps = new Map()
  const unreachable = new Set()
  const stacks = []

  bot.username = username
  bot.version = VERSION
  bot.registry = registry
  bot.health = health
  bot.food = food
  bot.heldItem = null
  bot.targetDigBlock = null
  bot.calls = { chat: [], attacks: [], placed: [], dug: [], crafted: [], gotos: [] }
  bot.entity = { position: position.clone(), height: 1.62 }
  bot.entities = {}
  bot._client = new EventEmitter()
  bot.players = {
    [owner]: {
      username: owner,
      uuid: ownerUuid,
      entity: { name: 'player', type: 'player', username: owner, position: position.offset(3, 0, 0), isValid: true }
    }
  }

  function nameAt (p) {
    const stored = world.get(key(p))
    if (stored) return stored
    return p.y < groundY ? 'stone' : 'air'
  }

  bot.setBlock = (p, name, props = {}) => {
    world.set(key(p), name)
    blockProps.set(key(p), props)
  }

  bot.blockAt = p => {
    const at = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const name = nameAt(at)
    const data = registry.blocksByName[name]
    const props = blockProps.get(key(at)) ?? {}
    return {
      name,
      type: data.id,
      position: at,
      boundingBox: data.boundingBox,
      diggable: data.diggable,
      harvestTools: data.harvestTools,
      light: 0,
      skyLight: at.y >= groundY ? 15 : 0,
      metadata: props.age ?? 0,
      getProperties: () => props
    }
  }

  bot.markUnreachable = p => unreachable.add(key(p))

  // World search limited to a box around the point, nearest first.
  bot.findBlocks = ({ matching, maxDistance = 16, count = 1, point }) => {
    const center = (point ?? bot.entity.position).floored()
    const ids = new Set([].concat(matching))
    const found = []
    const consider = at => {
      if (ids.has(registry.blocksByName[nameAt(at)].id) && at.distanceTo(center) <= maxDistance) found.push(at)
    }
    for (const stored of world.keys()) {
      const [x, y, z] = stored.split(',').map(Number)
      consider(new Vec3(x, y, z))
    }
    found.sort((a, b) => a.distanceTo(center) - b.distanceTo(center))
    return found.slice(0, count)
  }

  bot.findBlock = ({ matching, maxDistance }) => {
    const [first] = bot.findBlocks({ matching, maxDistance, count: 1 })
    return first ? bot.blockAt(first) : null
  }

  function makeItem (name, count) {
    const data = registry.itemsByName[name]
    return { name, type: data.id, count, stackSize: data.stackSize }
  }

  function give (name, count = 1) {
    const existing = stacks.find(stack => stack.name === name)
    if (existing) existing.count += count
    else stacks.push(makeItem(name, count))
  }

  function take (name, count = 1) {
    const stack = stacks.find(item => item.name === name)
    if (!stack || stack.count < count) throw new Error(`Mock inventory lacks ${count} ${name}`)
    stack.count -= count
    if (stack.count === 0) {
      stacks.splice(stacks.indexOf(stack), 1)
      if (bot.heldItem === stack) bot.heldItem = null
    }
  }

  bot.give = give
  for (const [name, count] of Object.entries(items)) give(name, count)

  bot.inventory = {
    items: () => [...stacks],
    emptySlotCount: () => 36 - stacks.length
  }

  bot.equip = async item => {
    if (!stacks.includes(item)) throw new Error('Mock cannot equip an item it does not hold')
    bot.heldItem = item
  }

  bot.consume = async () => {
    const held = bot.heldItem
    if (!held) throw new Error('Nothing to eat')
    const food = registry.foodsByName[held.name]
    bot.food = Math.min(20, bot.food + food.foodPoints)
    take(held.name)
  }

  function dropsOf (blockName) {
    const data = registry.blocksByName[blockName]
    if (blockName === 'wheat') return ['wheat', 'wheat_seeds']
    return (data.drops ?? []).map(id => registry.items[id].name)
  }

  bot.dig = async block => {
    if (block.diggable === false) throw new Error('Mock block cannot be dug')
    bot.calls.dug.push(key(block.position))
    world.set(key(block.position), 'air')
    blockProps.delete(key(block.position))
    return dropsOf(block.name)
  }

  bot.stopDigging = () => { bot.targetDigBlock = null }

  bot.tool = { equipForBlock: async () => {} }

  bot.placeBlock = async (reference, face) => {
    const dest = reference.position.plus(face)
    const current = nameAt(dest)
    if (!['air', 'cave_air', 'short_grass'].includes(current)) throw new Error(`Mock cell is taken by ${current}`)
    if (!bot.heldItem) throw new Error('Mock has nothing in hand')
    const eye = bot.entity.position.offset(0, 1.62, 0)
    if (eye.distanceTo(dest.offset(0.5, 0.5, 0.5)) > 4.5) throw new Error('Mock place is out of reach')
    const name = bot.heldItem.name === 'wheat_seeds' ? 'wheat' : bot.heldItem.name
    take(bot.heldItem.name)
    world.set(key(dest), name)
    blockProps.set(key(dest), name === 'wheat' ? { age: 0 } : {})
    if (name.endsWith('_door')) world.set(key(dest.offset(0, 1, 0)), name)
    bot.calls.placed.push({ name, at: key(dest) })
  }

  bot.activateBlock = async block => {
    if (bot.heldItem?.name?.endsWith('_hoe') && ['dirt', 'grass_block'].includes(block.name)) {
      world.set(key(block.position), 'farmland')
    }
  }

  function recipeDelta (raw) {
    const counts = new Map()
    const cells = raw.inShape ? raw.inShape.flat() : raw.ingredients
    for (const id of cells) {
      if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const delta = [...counts].map(([id, count]) => ({ id, count: -count }))
    delta.push({ id: raw.result.id, count: raw.result.count })
    return delta
  }

  function recipeNeedsTable (raw) {
    if (raw.inShape) return raw.inShape.length > 2 || Math.max(...raw.inShape.map(r => r.length)) > 2
    return raw.ingredients.length > 4
  }

  bot.recipesFor = (id, _meta, _min, table) => {
    return (registry.recipes[id] ?? [])
      .filter(raw => table || !recipeNeedsTable(raw))
      .map(raw => ({ raw, delta: recipeDelta(raw), result: raw.result }))
      .filter(recipe => recipe.delta.every(entry => {
        if (entry.count > 0) return true
        const stack = stacks.find(item => item.type === entry.id)
        return stack && stack.count >= -entry.count
      }))
  }

  bot.craft = async (recipe, times, table) => {
    if (recipeNeedsTable(recipe.raw) && !table) throw new Error('Mock recipe needs a table')
    for (const entry of recipe.delta) {
      const name = registry.items[entry.id].name
      if (entry.count < 0) take(name, -entry.count * times)
    }
    for (const entry of recipe.delta) {
      if (entry.count > 0) give(registry.items[entry.id].name, entry.count * times)
    }
    bot.calls.crafted.push({ name: registry.items[recipe.result.id].name, times })
  }

  bot.pathfinder = {
    movements: null,
    goal: null,
    setMovements: m => { bot.pathfinder.movements = m },
    setGoal: goal => { bot.pathfinder.goal = goal },
    stop: () => { bot.pathfinder.goal = null },
    goto: async goal => {
      bot.calls.gotos.push(goal)
      const spot = goalPosition(goal)
      if (spot && unreachable.has(key(spot.floored()))) {
        const err = new Error('No path')
        err.name = 'NoPath'
        throw err
      }
      if (spot) bot.entity.position = spot
    }
  }

  function goalPosition (goal) {
    if (goal.entity) return goal.entity.position.clone()
    if (goal.x === undefined) return null
    const y = goal.y ?? bot.entity.position.y
    return new Vec3(goal.x, y, goal.z)
  }

  bot.pvp = {
    target: undefined,
    attack: async target => {
      bot.pvp.target = target
      bot.calls.attacks.push(target)
      bot.emit('startedAttacking')
    },
    stop: async () => {
      bot.pvp.target = undefined
      bot.emit('stoppedAttacking')
    },
    forceStop: () => {
      if (bot.pvp.target === undefined) return
      bot.pvp.target = undefined
      bot.emit('stoppedAttacking')
    }
  }

  class MockCollector {
    constructor () {
      this.targets = { clear () {} }
      this.movements = {}
    }

    async collect (block) {
      const drops = await bot.dig(block)
      for (const drop of drops) give(drop)
    }
  }
  bot.collectBlock = new MockCollector()

  // Dropping an item: a player within 3.5 blocks picks it up (the server's playerCollect).
  bot.calls.tossed = []
  bot.toss = async (type, _meta, count) => {
    const name = registry.items[type].name
    take(name, count)
    bot.calls.tossed.push({ name, count, at: bot.entity.position.clone() })
    const near = Object.values(bot.players).map(p => p.entity).find(e => e && e.position.distanceTo(bot.entity.position) <= 3.5)
    if (near) setTimeout(() => bot.emit('playerCollect', near, { name: 'item' }), 5)
  }
  bot.lookAt = async () => {}
  bot.setControlState = () => {}
  bot.waitForTicks = async () => {}

  // Furnaces smelt at once: each fuel item burns its vanilla number of items.
  const smelts = { raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot' }
  const burnOf = name => ({ coal: 8, charcoal: 8, coal_block: 80, stick: 0.5 })[name] ?? (/_planks$|_log$/.test(name) ? 1.5 : 0)
  bot.furnaces = new Map()
  bot.openFurnace = async block => {
    if (nameAt(block.position) !== 'furnace') throw new Error('Mock block is not a furnace')
    const state = bot.furnaces.get(key(block.position)) ?? { input: null, fuel: null, output: null, burn: 0 }
    bot.furnaces.set(key(block.position), state)
    const run = () => {
      while (state.input) {
        if (state.burn < 1 && state.fuel) {
          state.burn += burnOf(state.fuel.name)
          if (--state.fuel.count === 0) state.fuel = null
        }
        if (state.burn < 1) break
        state.burn -= 1
        const out = smelts[state.input.name]
        if (--state.input.count === 0) state.input = null
        state.output = state.output ?? makeItem(out, 0)
        state.output.count++
      }
    }
    const put = (slot, type, count) => {
      const name = registry.items[type].name
      take(name, count)
      state[slot] = state[slot] ?? makeItem(name, 0)
      state[slot].count += count
      run()
    }
    const takeSlot = slot => {
      const item = state[slot]
      state[slot] = null
      if (item) give(item.name, item.count)
      return item
    }
    return {
      inputItem: () => state.input,
      fuelItem: () => state.fuel,
      outputItem: () => state.output,
      putInput: async (type, _meta, count) => put('input', type, count),
      putFuel: async (type, _meta, count) => put('fuel', type, count),
      takeInput: async () => takeSlot('input'),
      takeFuel: async () => takeSlot('fuel'),
      takeOutput: async () => takeSlot('output'),
      close: () => {}
    }
  }

  bot.chat = line => bot.calls.chat.push(line)
  bot.addEntity = entity => {
    const id = Object.keys(bot.entities).length + 100
    const full = { id, isValid: true, ...entity }
    bot.entities[id] = full
    return full
  }
  bot.nearestEntity = (filter = () => true) => {
    const here = bot.entity.position
    let best = null
    for (const entity of Object.values(bot.entities)) {
      if (!filter(entity)) continue
      if (!best || entity.position.distanceTo(here) < best.position.distanceTo(here)) best = entity
    }
    return best
  }

  return bot
}

function createContext (bot, overrides = {}) {
  const said = []
  const ctx = {
    bot,
    config: { owner: 'TestOwner', bots: ['CrewHelper1', 'CrewHelper2'] },
    log: () => {},
    say: line => said.push(line),
    said,
    movements: { safe: { profile: 'safe' }, dig: { profile: 'dig' } },
    state: { job: null, fightName: null, retreating: false, lastHurtAt: null },
    ...overrides
  }
  return ctx
}

function flatFloor (bot, from, to, y, name = 'grass_block') {
  for (let x = from; x <= to; x++) {
    for (let z = from; z <= to; z++) bot.setBlock(new Vec3(x, y, z), name)
  }
}

module.exports = { createMockBot, createContext, flatFloor, registry, VERSION }
