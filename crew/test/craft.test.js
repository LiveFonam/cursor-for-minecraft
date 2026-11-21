'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { planCraft, readRecipe, craftItem, MissingItemsError } = require('../src/skills/craft')
const { countItem } = require('../src/skills/inventory')
const { createMockBot, registry } = require('./helpers/mock-bot')

const id = name => registry.itemsByName[name].id
const stock = items => new Map(Object.entries(items).map(([name, count]) => [id(name), count]))

test('reads shaped and shapeless recipes', () => {
  const pickaxe = readRecipe(registry.recipes[id('wooden_pickaxe')][0])
  assert.equal(pickaxe.needsTable, true)
  assert.equal([...pickaxe.ingredients.values()].reduce((a, b) => a + b), 5)
  const planks = readRecipe(registry.recipes[id('oak_planks')][0])
  assert.equal(planks.needsTable, false)
  assert.equal(planks.makes, 4)
})

test('plans a full chain from logs to a wooden pickaxe', () => {
  const plan = planCraft(registry, stock({ oak_log: 3 }), id('wooden_pickaxe'), 1)
  assert.equal(plan.ok, true)
  const names = plan.steps.map(step => step.name)
  assert.ok(names.includes('oak_planks'))
  assert.ok(names.includes('stick'))
  assert.ok(names.includes('crafting_table'))
  assert.equal(names.at(-1), 'wooden_pickaxe')
  assert.ok(names.indexOf('crafting_table') < names.indexOf('wooden_pickaxe'))
  assert.ok(names.indexOf('oak_planks') < names.indexOf('stick'))
})

test('uses the wood type the bot actually holds', () => {
  const plan = planCraft(registry, stock({ birch_log: 3 }), id('wooden_pickaxe'), 1)
  assert.equal(plan.ok, true)
  assert.ok(plan.steps.some(step => step.name === 'birch_planks'))
})

test('skips the table when one is nearby', () => {
  const plan = planCraft(registry, stock({ oak_log: 2 }), id('wooden_pickaxe'), 1, { hasTable: true })
  assert.equal(plan.ok, true)
  assert.ok(!plan.steps.some(step => step.name === 'crafting_table'))
})

test('reports the raw materials that are missing', () => {
  const plan = planCraft(registry, new Map(), id('wooden_pickaxe'), 1, { hasTable: true })
  assert.equal(plan.ok, false)
  assert.deepEqual(Object.keys(plan.missing).every(name => name.endsWith('_log')), true)
  assert.ok(Object.keys(plan.missing).some(name => name.startsWith('oak_')))
})

test('does not loop on recipes that convert both ways', () => {
  const plan = planCraft(registry, new Map(), id('iron_ingot'), 1)
  assert.equal(plan.ok, false)
  assert.ok(plan.missing)
})

test('counts shared ingredients only once', () => {
  const plan = planCraft(registry, stock({ oak_planks: 2 }), id('stick'), 8)
  assert.equal(plan.ok, false)
  const enough = planCraft(registry, stock({ oak_planks: 4 }), id('stick'), 8)
  assert.equal(enough.ok, true)
})

test('does not spend items it already holds as the target', () => {
  const plan = planCraft(registry, stock({ stick: 4, oak_planks: 2 }), id('stick'), 4)
  assert.equal(plan.ok, true)
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0].batches, 1)
})

test('crafts through the chain and places a table', async () => {
  const bot = createMockBot({ items: { oak_log: 3 } })
  await craftItem(bot, 'wooden_pickaxe', 1)
  assert.equal(countItem(bot, 'wooden_pickaxe'), 1)
  assert.ok(bot.calls.placed.some(entry => entry.name === 'crafting_table'))
})

test('uses a table already in the world', async () => {
  const bot = createMockBot({ items: { oak_planks: 3, stick: 2 } })
  bot.setBlock(new Vec3(2, 64, 2), 'crafting_table')
  await craftItem(bot, 'wooden_pickaxe', 1)
  assert.equal(countItem(bot, 'wooden_pickaxe'), 1)
  assert.equal(bot.calls.placed.length, 0)
})

test('craft follows the planned wood when two types are held', async () => {
  const bot = createMockBot({ items: { oak_planks: 3, birch_planks: 2 } })
  bot.setBlock(new Vec3(2, 64, 2), 'crafting_table')
  await craftItem(bot, 'wooden_pickaxe', 1)
  assert.equal(countItem(bot, 'wooden_pickaxe'), 1)
})

test('throws a clear error when materials are missing', async () => {
  const bot = createMockBot()
  await assert.rejects(craftItem(bot, 'wooden_pickaxe', 1), err => {
    assert.ok(err instanceof MissingItemsError)
    assert.match(err.message, /Missing/)
    return true
  })
})

test('rejects unknown items', async () => {
  const bot = createMockBot()
  await assert.rejects(craftItem(bot, 'not_an_item', 1), /Unknown item/)
  await assert.rejects(craftItem(bot, 'diamond', 1), /Missing|No crafting/)
})
