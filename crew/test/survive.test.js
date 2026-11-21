'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { eat, bestFood } = require('../src/skills/eat')
const { assessSurvival, runSurvival } = require('../src/skills/survive')
const { retreatPoints } = require('../src/skills/move')
const { countItem } = require('../src/skills/inventory')
const { createMockBot, createContext } = require('./helpers/mock-bot')

function zombieNear (bot, distance = 3) {
  return bot.addEntity({ name: 'zombie', type: 'hostile', position: bot.entity.position.offset(distance, 0, 0) })
}

test('picks the most filling safe food', () => {
  const bot = createMockBot({ items: { bread: 1, cooked_beef: 1, rotten_flesh: 5 } })
  assert.equal(bestFood(bot).name, 'cooked_beef')
})

test('never picks harmful food or golden apples', () => {
  const bot = createMockBot({ items: { rotten_flesh: 1, spider_eye: 1, poisonous_potato: 1, golden_apple: 1 } })
  assert.equal(bestFood(bot), null)
})

test('eating raises food and uses one item', async () => {
  const bot = createMockBot({ items: { bread: 2 }, food: 10 })
  assert.equal(await eat(bot), true)
  assert.equal(bot.food, 15)
  assert.equal(countItem(bot, 'bread'), 1)
})

test('eat reports false with no food', async () => {
  assert.equal(await eat(createMockBot()), false)
})

test('wants to eat when hungry and holding food', () => {
  const bot = createMockBot({ items: { bread: 1 }, food: 10 })
  assert.deepEqual(assessSurvival(createContext(bot)), { action: 'eat' })
})

test('does nothing when hungry with no food', () => {
  const bot = createMockBot({ food: 2 })
  assert.equal(assessSurvival(createContext(bot)), null)
})

test('retreats at low health with a threat near', () => {
  const bot = createMockBot({ health: 5 })
  const zombie = zombieNear(bot)
  const need = assessSurvival(createContext(bot))
  assert.equal(need.action, 'retreat')
  assert.equal(need.threat, zombie)
})

test('keeps retreating until health recovers or the threat is gone', () => {
  const bot = createMockBot({ health: 5 })
  const zombie = zombieNear(bot)
  const ctx = createContext(bot)
  assessSurvival(ctx)
  bot.health = 9
  assert.equal(assessSurvival(ctx).action, 'retreat')
  bot.health = 12
  assert.equal(assessSurvival(ctx), null)
  bot.health = 5
  assert.equal(assessSurvival(ctx).action, 'retreat')
  delete bot.entities[zombie.id]
  assert.equal(assessSurvival(ctx), null)
})

test('backs away from a close creeper at full health', () => {
  const bot = createMockBot()
  const creeper = bot.addEntity({ name: 'creeper', type: 'hostile', position: bot.entity.position.offset(3, 0, 0) })
  const need = assessSurvival(createContext(bot))
  assert.equal(need.action, 'retreat')
  assert.equal(need.threat, creeper)
})

test('retreat points lead away from the threat', () => {
  const [first] = retreatPoints(new Vec3(0, 64, 0), new Vec3(5, 64, 0), 10)
  assert.ok(first.x < 0)
  const fallback = retreatPoints(new Vec3(1, 64, 1), new Vec3(1, 64, 1), 10)
  assert.equal(fallback.length, 5)
})

test('retreat moves the bot further from the threat', async () => {
  const bot = createMockBot({ health: 5 })
  const zombie = zombieNear(bot, 3)
  const ctx = createContext(bot)
  const before = bot.entity.position.distanceTo(zombie.position)
  await runSurvival(ctx, new AbortController().signal)
  assert.ok(bot.entity.position.distanceTo(zombie.position) > before)
})

test('a cornered bot stops retreating so it can fight back', async () => {
  const bot = createMockBot({ health: 5 })
  zombieNear(bot)
  const ctx = createContext(bot)
  bot.pathfinder.goto = async () => {
    const err = new Error('No path')
    err.name = 'NoPath'
    throw err
  }
  let clock = 1000
  await runSurvival(ctx, new AbortController().signal, () => clock)
  assert.equal(ctx.state.corneredUntil, 6000)
  assert.equal(assessSurvival(ctx, clock), null)
  clock = 7000
  assert.equal(assessSurvival(ctx, clock).action, 'retreat')
})

test('a failed meal is not retried at once', async () => {
  const bot = createMockBot({ items: { bread: 1 }, food: 5 })
  bot.consume = async () => { throw new Error('Interrupted') }
  const ctx = createContext(bot)
  const clock = 1000
  await runSurvival(ctx, new AbortController().signal, () => clock)
  assert.equal(assessSurvival(ctx, clock + 1), null)
  assert.deepEqual(assessSurvival(ctx, clock + 10001), { action: 'eat' })
})
