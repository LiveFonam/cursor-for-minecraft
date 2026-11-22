// A small stock of torches made from coal nothing else needs, and the count of what hunting did.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { TorchMode } = require('../behaviors')
const { torchPlan, topUpTorches, TORCH_STOCK } = require('../skills/torches')
const { animalOnTheWay, huntOne, huntOnTheWay, huntCounts, huntText } = require('../skills/food')

const count = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)

function ctxFor (bot, extra = {}) {
  return {
    bot,
    manager: { byName: new Map(), modes: [], active: null },
    danger: { report: { safe: true } },
    agents: { log () {}, metric () {} },
    ...extra
  }
}

let nextId = 9000
function animal (bot, name, x, z) {
  const e = { id: nextId++, type: 'animal', name, position: new Vec3(x, bot.entity.position.y, z), height: 1, metadata: {}, isValid: true }
  bot.entities[e.id] = e
  return e
}

test('torches: spare coal and sticks become a stock of about 8, and no more', async () => {
  const { bot } = makeBot()
  bot.give('coal', 5)
  bot.give('stick', 4)
  const ctx = ctxFor(bot)
  assert.equal(await topUpTorches(ctx, { cancelled: false }), 8)
  assert.equal(count(bot, 'torch'), TORCH_STOCK)
  assert.equal(count(bot, 'coal'), 3)
  assert.equal(count(bot, 'stick'), 2)
  assert.equal(torchPlan(ctx), null, 'the stock is full')
})

test('torches: charcoal works too', async () => {
  const { bot } = makeBot()
  bot.give('charcoal', 1)
  bot.give('stick', 1)
  assert.equal(await topUpTorches(ctxFor(bot), { cancelled: false }), 4)
  assert.equal(count(bot, 'charcoal'), 0)
})

test('torches: a stock with under a batch of room is left alone', () => {
  const { bot } = makeBot()
  bot.give('torch', TORCH_STOCK - 3)
  bot.give('coal', 4)
  bot.give('stick', 4)
  assert.equal(torchPlan(ctxFor(bot)), null)
})

test('torches: coal the plan still has to smelt with is never used', async () => {
  const { bot } = makeBot()
  bot.give('coal', 1)
  bot.give('stick', 4)
  const ctx = ctxFor(bot, { plan: { steps: ['smelt 8 raw iron, mine diamonds'], index: 0 } })
  assert.equal(torchPlan(ctx), null)
  bot.give('coal', 1)
  assert.equal(await topUpTorches(ctx, { cancelled: false }), 4)
  assert.equal(count(bot, 'coal'), 1, 'the coal for the smelt is still there')
})

test('torches: every smelt in one plan step is counted', () => {
  const { bot } = makeBot()
  bot.give('coal', 1)
  bot.give('stick', 4)
  const ctx = ctxFor(bot, { plan: { steps: ['smelt 4 raw iron, smelt 4 raw gold, mine diamonds'], index: 0 } })
  assert.equal(torchPlan(ctx), null)
})

test('torches: coal for the raw food in the bag comes first', () => {
  const { bot } = makeBot()
  bot.give('coal', 1)
  bot.give('stick', 4)
  bot.give('beef', 8)
  assert.equal(torchPlan(ctxFor(bot)), null)
})

test('torches: coal a job was asked to bring stays in the bag, also after the job', () => {
  const { bot } = makeBot()
  bot.give('coal', 8)
  bot.give('stick', 4)
  const mine = { on: true, params: { block: 'coal', count: 8 } }
  const ctx = ctxFor(bot)
  ctx.manager.byName.set('mine', mine)
  assert.equal(torchPlan(ctx), null)
  mine.on = false
  assert.equal(torchPlan(ctx), null, 'the job is over, the coal is still what was asked for')
})

test('torches: nothing is made while a craft is still ahead in the plan', () => {
  const { bot } = makeBot()
  bot.give('coal', 8)
  bot.give('stick', 4)
  assert.equal(torchPlan(ctxFor(bot, { plan: { steps: ['mine iron', 'craft iron pickaxe'], index: 0 } })), null)
})

test('torches: wood for sticks, but never the 2 logs kept for a spare pickaxe', async () => {
  const { bot } = makeBot()
  bot.give('coal', 2)
  bot.give('oak_log', 2)
  assert.equal(torchPlan(ctxFor(bot)), null)
  bot.give('oak_log', 1)
  assert.equal(await topUpTorches(ctxFor(bot), { cancelled: false }), 8)
  assert.equal(count(bot, 'oak_log'), 2)
})

test('torches: the mode waits out danger, an open window and a job at a station', () => {
  const { bot } = makeBot()
  bot.give('coal', 2)
  bot.give('stick', 2)
  const ctx = ctxFor(bot)
  ctx.danger.report.safe = false
  assert.equal(new TorchMode(ctx).wants(), false, 'danger')
  ctx.danger.report.safe = true
  bot.currentWindow = {}
  assert.equal(new TorchMode(ctx).wants(), false, 'a window is open')
  bot.currentWindow = null
  ctx.manager.active = { name: 'build', always: false }
  assert.equal(new TorchMode(ctx).wants(), false, 'building')
  ctx.manager.active = { name: 'mine', always: false }
  assert.equal(new TorchMode(ctx).wants(), true, 'between two blocks of a mining job')
})

test('hunt counts: seen in range, started, killed, gave up and cancelled', async () => {
  const { bot } = makeBot()
  const near = animal(bot, 'cow', 4.5, 0.5)
  animal(bot, 'cow', 40.5, 0.5)
  assert.equal(animalOnTheWay(bot), near)
  assert.equal(huntCounts(bot).seen.size, 1, 'only the one in range')

  assert.equal(await huntOne(bot, near, { cancelled: true }, () => {}), 'cancelled')
  const far = animal(bot, 'pig', 30.5, 0.5)
  assert.equal(await huntOnTheWay(bot, far, { cancelled: false }, () => {}), 'ran off')
  const gone = animal(bot, 'sheep', 2.5, 0.5)
  delete bot.entities[gone.id]
  assert.equal(await huntOne(bot, gone, { cancelled: false }, () => {}), 'killed')

  const c = huntCounts(bot)
  assert.deepEqual([c.started, c.killed, c.gaveUp, c.cancelled], [3, 1, 1, 1])
  assert.equal(huntText(bot), 'hunts: 1 seen, 3 started, 1 killed, 1 gave up, 1 cancelled')
})
