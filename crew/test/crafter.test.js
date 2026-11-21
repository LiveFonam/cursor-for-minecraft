'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { planItem, resolveTarget, describeMissing, TARGETS } = require('../src/skills/crafter-plan')
const { runCrafter, newCraftState } = require('../src/skills/crafter')
const { handleChat } = require('../src/commands')
const { countItem } = require('../src/skills/inventory')
const { createMockBot, createContext, registry } = require('./helpers/mock-bot')

const bagOf = items => new Map(Object.entries(items))
const crafts = plan => plan.steps.filter(step => step.kind === 'craft').map(step => `${step.name} x${step.batches}`)
const made = (bot, name) => bot.calls.crafted.filter(call => call.name === name).reduce((sum, call) => sum + call.times, 0)
const given = (bot, name) => bot.calls.tossed.filter(t => t.name === name).reduce((sum, t) => sum + t.count, 0)

// A bot at 0 64 0 with a crafting table two blocks away and the owner three blocks away
function setup (items, { table = true } = {}) {
  const bot = createMockBot({ items })
  if (table) bot.setBlock(new Vec3(2, 64, 0), 'crafting_table')
  const ctx = createContext(bot)
  return { bot, ctx }
}

// ---- the planner ----

test('the demo: 1 oak log and 2 cobblestone by a table is exactly 1 cobblestone short', () => {
  const short = planItem(registry, 'stone_pickaxe', bagOf({ oak_log: 1, cobblestone: 2 }), { tableNear: true })
  assert.deepEqual([...short.missing], [['cobblestone', 1]])
  const full = planItem(registry, 'stone_pickaxe', bagOf({ oak_log: 1, cobblestone: 3 }), { tableNear: true })
  assert.equal(full.missing.size, 0)
  assert.deepEqual(crafts(full), ['oak_planks x1', 'stick x1', 'stone_pickaxe x1'])
})

test('all six items plan from raw materials', () => {
  const cases = {
    wooden_pickaxe: [{ oak_log: 2 }, ['oak_planks x2', 'stick x1', 'wooden_pickaxe x1']],
    stone_pickaxe: [{ oak_log: 1, cobblestone: 3 }, ['oak_planks x1', 'stick x1', 'stone_pickaxe x1']],
    iron_pickaxe: [{ oak_log: 1, iron_ingot: 3 }, ['oak_planks x1', 'stick x1', 'iron_pickaxe x1']],
    diamond_pickaxe: [{ oak_log: 1, diamond: 3 }, ['oak_planks x1', 'stick x1', 'diamond_pickaxe x1']],
    furnace: [{ cobblestone: 8 }, ['furnace x1']],
    crafting_table: [{ oak_log: 1 }, ['oak_planks x1', 'crafting_table x1']]
  }
  for (const target of TARGETS) {
    const [have, want] = cases[target]
    const plan = planItem(registry, target, bagOf(have), { tableNear: true })
    assert.equal(plan.missing.size, 0, `${target} misses ${describeMissing(plan.missing)}`)
    assert.deepEqual(crafts(plan), want, target)
  }
})

test('with no table near it plans one and counts its wood', () => {
  const short = planItem(registry, 'stone_pickaxe', bagOf({ oak_log: 1, cobblestone: 3 }))
  assert.deepEqual([...short.missing], [['oak_log', 1]])
  const plan = planItem(registry, 'stone_pickaxe', bagOf({ oak_log: 2, cobblestone: 3 }))
  assert.equal(plan.missing.size, 0)
  assert.ok(crafts(plan).includes('crafting_table x1'))
})

test('iron: ingots it holds first, else raw iron smelted with coal or spare planks', () => {
  const ingots = planItem(registry, 'iron_pickaxe', bagOf({ iron_ingot: 3, raw_iron: 5, oak_log: 1 }), { tableNear: true })
  assert.equal(ingots.steps.some(step => step.kind === 'smelt'), false)

  const coal = planItem(registry, 'iron_pickaxe', bagOf({ iron_ingot: 1, raw_iron: 5, coal: 1, cobblestone: 8, oak_log: 1 }), { tableNear: true })
  assert.equal(coal.missing.size, 0)
  const smelt = coal.steps.find(step => step.kind === 'smelt')
  assert.equal(smelt.count, 2)
  assert.deepEqual(smelt.fuel, [['coal', 1]])
  const order = coal.steps.map(step => step.kind === 'smelt' ? 'smelt' : step.name)
  assert.ok(order.indexOf('furnace') < order.indexOf('smelt'))
  assert.ok(order.indexOf('smelt') < order.indexOf('iron_pickaxe'))

  const planks = planItem(registry, 'iron_pickaxe', bagOf({ raw_iron: 3, oak_log: 1 }), { tableNear: true, furnaceNear: true })
  assert.equal(planks.missing.size, 0)
  assert.deepEqual(planks.steps.find(step => step.kind === 'smelt').fuel, [['oak_planks', 2]])
})

test('it asks for things you can gather, never an iron block or nuggets', () => {
  const plan = planItem(registry, 'iron_pickaxe', bagOf({ raw_iron: 3, stick: 2 }), { tableNear: true })
  assert.deepEqual([...plan.missing].sort(), [['coal', 1], ['cobblestone', 8]])
  const none = planItem(registry, 'iron_pickaxe', bagOf({ stick: 2, coal: 1 }), { tableNear: true, furnaceNear: true })
  assert.deepEqual([...none.missing], [['raw_iron', 3]])
})

test('common names', () => {
  assert.equal(resolveTarget(['me', 'a', 'stone', 'pickaxe']), 'stone_pickaxe')
  assert.equal(resolveTarget(['wood', 'pickaxe']), 'wooden_pickaxe')
  assert.equal(resolveTarget(['a', 'cobblestone', 'pickaxe']), 'stone_pickaxe')
  assert.equal(resolveTarget(['an', 'iron', 'pick']), 'iron_pickaxe')
  assert.equal(resolveTarget(['furnace']), 'furnace')
  assert.equal(resolveTarget(['crafting_table']), 'crafting_table')
  assert.equal(resolveTarget(['stone_pickaxe', '2']), null)
  assert.equal(resolveTarget(['boat']), null)
})

// ---- whole jobs on the mock bot ----

test('the demo job: 1 short, waits, the player hands it over, it crafts once and gives it', async () => {
  const { bot, ctx } = setup({ oak_log: 1, cobblestone: 2 })
  const job = newCraftState('stone_pickaxe', 'TestOwner')
  const controller = new AbortController()
  const done = runCrafter(ctx, job, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.ok(ctx.said.some(line => /still need 1 cobblestone/.test(line)), ctx.said.join(' | '))
  assert.equal(made(bot, 'stone_pickaxe'), 0)
  bot.give('cobblestone', 1)
  const message = await done
  assert.match(message, /Here is your stone pickaxe, TestOwner/)
  assert.deepEqual(bot.calls.crafted.map(c => c.name), ['oak_planks', 'stick', 'stone_pickaxe'])
  assert.equal(given(bot, 'stone_pickaxe'), 1)
  assert.equal(countItem(bot, 'cobblestone'), 0)
})

test('every item through the job: made once, handed over', async () => {
  const bags = {
    wooden_pickaxe: { oak_log: 2 },
    stone_pickaxe: { oak_log: 1, cobblestone: 3 },
    iron_pickaxe: { oak_log: 1, iron_ingot: 3 },
    diamond_pickaxe: { oak_log: 1, diamond: 3 },
    furnace: { cobblestone: 8 },
    crafting_table: { oak_log: 1 }
  }
  for (const [item, items] of Object.entries(bags)) {
    const { bot, ctx } = setup(items)
    await runCrafter(ctx, newCraftState(item, 'TestOwner'), new AbortController().signal)
    assert.equal(made(bot, item), 1, item)
    assert.equal(given(bot, item), 1, item)
  }
})

test('raw iron: crafts and places a furnace, smelts 3, crafts and gives the pickaxe', async () => {
  const { bot, ctx } = setup({ raw_iron: 3, coal: 1, cobblestone: 8, oak_log: 1 })
  await runCrafter(ctx, newCraftState('iron_pickaxe', 'TestOwner'), new AbortController().signal)
  assert.equal(made(bot, 'furnace'), 1)
  assert.ok(bot.calls.placed.some(p => p.name === 'furnace'))
  assert.equal(made(bot, 'iron_pickaxe'), 1)
  assert.equal(given(bot, 'iron_pickaxe'), 1)
  assert.equal(countItem(bot, 'raw_iron') + countItem(bot, 'iron_ingot') + countItem(bot, 'coal'), 0)
})

test('the gatherer side gets the missing log, then the job carries on by itself', async () => {
  const { bot, ctx } = setup({ cobblestone: 3 })
  bot.setBlock(new Vec3(5, 64, 5), 'oak_log')
  const message = await runCrafter(ctx, newCraftState('stone_pickaxe', 'TestOwner'), new AbortController().signal)
  assert.ok(ctx.said.some(line => /I need 1 oak log\. Gathering it/.test(line)), ctx.said.join(' | '))
  assert.ok(bot.calls.dug.includes('5,64,5'))
  assert.match(message, /Here is your stone pickaxe/)
  assert.equal(made(bot, 'stone_pickaxe'), 1)
})

test('a fight cuts in: run again with the same job, still only one pickaxe', async () => {
  const { bot, ctx } = setup({ oak_log: 1, cobblestone: 3 })
  const craft = bot.craft
  bot.craft = async (...args) => { await new Promise(resolve => setTimeout(resolve, 60)); return craft(...args) }
  const job = newCraftState('stone_pickaxe', 'TestOwner')
  const first = new AbortController()
  const run = runCrafter(ctx, job, first.signal).catch(err => err)
  // abort once the final craft is on its way
  while (!bot.calls.crafted.some(c => c.name === 'stick')) await new Promise(resolve => setTimeout(resolve, 5))
  await new Promise(resolve => setTimeout(resolve, 20))
  first.abort()
  assert.equal((await run).name, 'AbortedError')
  await runCrafter(ctx, job, new AbortController().signal)
  assert.equal(made(bot, 'stone_pickaxe'), 1)
  assert.equal(given(bot, 'stone_pickaxe'), 1)
})

test('the owner out of reach: it keeps the item and says so, then hands it over', async () => {
  const { bot, ctx } = setup({ oak_log: 1, cobblestone: 3 })
  const owner = bot.players.TestOwner
  delete bot.players.TestOwner
  const done = runCrafter(ctx, newCraftState('stone_pickaxe', 'TestOwner'), new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.ok(ctx.said.some(line => /ready\. I am keeping it/.test(line)), ctx.said.join(' | '))
  assert.equal(countItem(bot, 'stone_pickaxe'), 1)
  bot.players.TestOwner = owner
  await done
  assert.equal(given(bot, 'stone_pickaxe'), 1)
})

test('it keeps its own pickaxe and makes a new one', async () => {
  const { bot, ctx } = setup({ stone_pickaxe: 1, oak_log: 1, cobblestone: 3 })
  await runCrafter(ctx, newCraftState('stone_pickaxe', 'TestOwner'), new AbortController().signal)
  assert.equal(made(bot, 'stone_pickaxe'), 1)
  assert.equal(countItem(bot, 'stone_pickaxe'), 1)
})

test('chat: "@crew craft me a stone pickaxe" starts the crafter, asking again is not a second job', () => {
  const { ctx } = setup({ oak_log: 1, cobblestone: 2 })
  ctx.modes = { interrupt: () => {} }
  const chat = text => handleChat(ctx, { sender: 'owner-uuid', plainMessage: text })
  chat('@crew craft me a stone pickaxe')
  assert.equal(ctx.state.job.crafter.item, 'stone_pickaxe')
  const job = ctx.state.job
  chat('@crew craft a cobblestone pickaxe')
  assert.equal(ctx.state.job, job)
  assert.ok(ctx.said.some(line => /already on your stone pickaxe/.test(line)))
  // other items still go to the general crafter
  chat('@crew craft stick 4')
  assert.equal(ctx.state.job.crafter, undefined)
  assert.equal(ctx.state.job.name, 'craft stick')
})
