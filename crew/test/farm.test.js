'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { farmPass, farmWheat, isMature } = require('../src/skills/farm')
const { countItem } = require('../src/skills/inventory')
const { createMockBot } = require('./helpers/mock-bot')

const anchor = new Vec3(0, 64, 0)

function field (bot, ages) {
  ages.forEach((age, x) => {
    bot.setBlock(new Vec3(x, 63, 2), 'farmland')
    if (age !== null) bot.setBlock(new Vec3(x, 64, 2), 'wheat', { age })
  })
}

test('only age 7 wheat counts as ripe', () => {
  const bot = createMockBot()
  bot.setBlock(new Vec3(0, 64, 2), 'wheat', { age: 7 })
  bot.setBlock(new Vec3(1, 64, 2), 'wheat', { age: 6 })
  assert.equal(isMature(bot.blockAt(new Vec3(0, 64, 2))), true)
  assert.equal(isMature(bot.blockAt(new Vec3(1, 64, 2))), false)
})

test('reads ripeness from real block state objects', () => {
  const realRegistry = require('prismarine-registry')('1.21.4')
  const Block = require('prismarine-block')(realRegistry)
  const wheat = realRegistry.blocksByName.wheat
  assert.equal(isMature(Block.fromStateId(wheat.minStateId + 7, 0)), true)
  assert.equal(isMature(Block.fromStateId(wheat.minStateId + 6, 0)), false)
})

test('harvests ripe wheat, leaves young wheat and replants', async () => {
  const bot = createMockBot()
  field(bot, [7, 3, 7])
  const result = await farmPass(bot, anchor, 16, { movements: {} })
  assert.equal(result.harvested, 2)
  assert.equal(result.planted, 2)
  assert.equal(countItem(bot, 'wheat'), 2)
  assert.deepEqual(bot.blockAt(new Vec3(1, 64, 2)).getProperties(), { age: 3 })
  for (const x of [0, 2]) {
    const crop = bot.blockAt(new Vec3(x, 64, 2))
    assert.equal(crop.name, 'wheat')
    assert.equal(crop.getProperties().age, 0)
  }
})

test('plants on empty farmland when it holds seeds', async () => {
  const bot = createMockBot({ items: { wheat_seeds: 2 } })
  field(bot, [null, null, null])
  const result = await farmPass(bot, anchor, 16, { movements: {} })
  assert.equal(result.planted, 2)
  assert.equal(countItem(bot, 'wheat_seeds'), 0)
})

test('tills ground near water when there is no farmland', async () => {
  const bot = createMockBot({ items: { wooden_hoe: 1, wheat_seeds: 4 } })
  bot.setBlock(new Vec3(0, 63, 0), 'water')
  bot.setBlock(new Vec3(1, 63, 0), 'dirt')
  bot.setBlock(new Vec3(2, 63, 0), 'grass_block')
  bot.setBlock(new Vec3(12, 63, 0), 'dirt')
  const result = await farmPass(bot, anchor, 16, { movements: {} })
  assert.equal(result.tilled, 2)
  assert.equal(result.planted, 2)
  assert.equal(bot.blockAt(new Vec3(12, 63, 0)).name, 'dirt')
})

test('does not till when farmland already exists', async () => {
  const bot = createMockBot({ items: { wooden_hoe: 1, wheat_seeds: 1 } })
  field(bot, [3])
  bot.setBlock(new Vec3(5, 63, 0), 'water')
  bot.setBlock(new Vec3(6, 63, 0), 'dirt')
  const result = await farmPass(bot, anchor, 16, { movements: {} })
  assert.equal(result.tilled, 0)
  assert.equal(bot.blockAt(new Vec3(6, 63, 0)).name, 'dirt')
})

test('fails clearly when there is no way to farm', async () => {
  const bot = createMockBot()
  await assert.rejects(farmWheat(bot, anchor, { movements: {} }), /No farmland/)
})

test('keeps farming until aborted', async () => {
  const bot = createMockBot()
  field(bot, [7])
  const controller = new AbortController()
  const running = farmWheat(bot, anchor, { movements: {}, signal: controller.signal, idleMs: 5 })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(countItem(bot, 'wheat'), 1)
  controller.abort()
  await assert.rejects(running, { name: 'AbortedError' })
})

test('a full inventory stops the harvest', async () => {
  const bot = createMockBot()
  field(bot, [7])
  bot.inventory.emptySlotCount = () => 0
  await assert.rejects(farmPass(bot, anchor, 16, { movements: {} }), /Inventory is full/)
})
