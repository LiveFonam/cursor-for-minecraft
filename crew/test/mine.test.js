'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const {
  mine, newProgress, resolveMineTarget, harvestToolNames, isSafeToDig, placeTorchIfDark, tunnelStep
} = require('../src/skills/mine')
const { gather, collectOne, resetCollector } = require('../src/skills/gather')
const { countItem } = require('../src/skills/inventory')
const { createMockBot, registry } = require('./helpers/mock-bot')

const underground = { position: new Vec3(0, 40, 0), groundY: 64 }

function carve (bot, positions) {
  for (const p of positions) bot.setBlock(p, 'air')
}

function room (bot, center) {
  const cells = []
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      cells.push(center.offset(x, 0, z), center.offset(x, 1, z))
    }
  }
  carve(bot, cells)
}

test('resolves ore names to their ore blocks and drops', () => {
  const iron = resolveMineTarget(registry, 'iron')
  assert.deepEqual(iron.blocks, ['iron_ore', 'deepslate_iron_ore'])
  assert.deepEqual(iron.items, ['raw_iron'])
  assert.equal(resolveMineTarget(registry, 'iron_ore').name, 'iron')
  assert.equal(resolveMineTarget(registry, 'deepslate_diamond_ore').name, 'diamond')
  assert.equal(resolveMineTarget(registry, 'lapis_lazuli').name, 'lapis')
  assert.deepEqual(resolveMineTarget(registry, 'stone').items, ['cobblestone'])
  assert.equal(resolveMineTarget(registry, 'not_a_block'), null)
  assert.equal(resolveMineTarget(registry, 'bedrock'), null)
  assert.equal(resolveMineTarget(registry, 'air'), null)
})

test('lists harvest tools cheapest first', () => {
  const tools = harvestToolNames(registry, 'iron_ore')
  assert.equal(tools[0], 'stone_pickaxe')
  assert.ok(tools.includes('diamond_pickaxe'))
  assert.ok(!tools.includes('wooden_pickaxe'))
})

test('refuses to dig next to lava or water', () => {
  const bot = createMockBot(underground)
  const ore = new Vec3(3, 40, 0)
  bot.setBlock(ore, 'iron_ore')
  assert.equal(isSafeToDig(bot, bot.blockAt(ore)), true)
  bot.setBlock(ore.offset(0, 1, 0), 'lava')
  assert.equal(isSafeToDig(bot, bot.blockAt(ore)), false)
  assert.equal(isSafeToDig(bot, bot.blockAt(ore.offset(0, 1, 0))), false)
})

test('mines the requested count and keeps away from lava', async () => {
  const bot = createMockBot({ ...underground, items: { stone_pickaxe: 1 } })
  room(bot, new Vec3(0, 40, 0))
  const safe = [new Vec3(3, 40, 0), new Vec3(3, 41, 0), new Vec3(-3, 40, 0)]
  for (const p of safe) bot.setBlock(p, 'iron_ore')
  const risky = new Vec3(0, 40, 4)
  bot.setBlock(risky, 'iron_ore')
  bot.setBlock(risky.offset(0, 0, 1), 'lava')

  const target = resolveMineTarget(registry, 'iron')
  const done = await mine(bot, target, 3, { movements: {} })
  assert.equal(done, 3)
  assert.equal(countItem(bot, 'raw_iron'), 3)
  assert.equal(bot.blockAt(risky).name, 'iron_ore')
})

test('crafts a pickaxe when it needs one and can', async () => {
  const bot = createMockBot({ ...underground, items: { oak_planks: 8, stick: 4 } })
  room(bot, new Vec3(0, 40, 0))
  bot.setBlock(new Vec3(3, 40, 0), 'coal_ore')
  const done = await mine(bot, resolveMineTarget(registry, 'coal'), 1, { movements: {} })
  assert.equal(done, 1)
  assert.equal(countItem(bot, 'wooden_pickaxe'), 1)
})

test('fails clearly when the right tool is missing', async () => {
  const bot = createMockBot(underground)
  bot.setBlock(new Vec3(3, 40, 0), 'iron_ore')
  await assert.rejects(mine(bot, resolveMineTarget(registry, 'iron'), 1, { movements: {} }), /Need a stone_pickaxe/)
})

test('tunnels to find ore that is out of range', async () => {
  const bot = createMockBot({ position: new Vec3(0, 16, 0), groundY: 64, items: { stone_pickaxe: 1, torch: 8 } })
  bot.setBlock(new Vec3(45, 16, 0), 'iron_ore')
  const target = { ...resolveMineTarget(registry, 'iron'), level: 16 }
  const done = await mine(bot, target, 1, { movements: {} })
  assert.equal(done, 1)
  assert.ok(bot.entity.position.x > 10)
  assert.ok(bot.calls.placed.some(entry => entry.name === 'torch'))
})

test('stops tunnelling at the step limit', async () => {
  const bot = createMockBot({ position: new Vec3(0, 16, 0), groundY: 64, items: { stone_pickaxe: 1 } })
  const progress = newProgress()
  progress.steps = 200
  const target = { ...resolveMineTarget(registry, 'iron'), level: 16 }
  const done = await mine(bot, target, 1, { movements: {}, progress })
  assert.equal(done, 0)
})

test('tunnel step digs a stair going down', async () => {
  const bot = createMockBot({ position: new Vec3(0, 40, 0), groundY: 64, items: { stone_pickaxe: 1 } })
  const ok = await tunnelStep(bot, new Vec3(1, 0, 0), { descend: true, movements: {} })
  assert.equal(ok, true)
  assert.equal(bot.entity.position.y, 39)
  assert.equal(bot.entity.position.x, 1)
  for (const y of [39, 40, 41]) assert.equal(bot.blockAt(new Vec3(1, y, 0)).name, 'air')
})

test('tunnel step refuses to break into lava', async () => {
  const bot = createMockBot({ position: new Vec3(0, 40, 0), groundY: 64, items: { stone_pickaxe: 1 } })
  bot.setBlock(new Vec3(2, 40, 0), 'lava')
  const ok = await tunnelStep(bot, new Vec3(1, 0, 0), { descend: false, movements: {} })
  assert.equal(ok, false)
  assert.equal(bot.calls.dug.length, 0)
})

test('tunnel step refuses to step over a drop', async () => {
  const bot = createMockBot({ position: new Vec3(0, 40, 0), groundY: 64, items: { stone_pickaxe: 1 } })
  bot.setBlock(new Vec3(1, 39, 0), 'air')
  assert.equal(await tunnelStep(bot, new Vec3(1, 0, 0), { descend: false, movements: {} }), false)
})

test('places torches in the dark with spacing', async () => {
  const bot = createMockBot({ ...underground, items: { torch: 4 } })
  room(bot, new Vec3(0, 40, 0))
  const memo = newProgress()
  assert.equal(await placeTorchIfDark(bot, memo), true)
  assert.equal(await placeTorchIfDark(bot, memo), false)
  assert.equal(bot.calls.placed.length, 1)
})

test('skips torches in daylight and without torches', async () => {
  const lit = createMockBot({ position: new Vec3(0, 64, 0), items: { torch: 4 } })
  assert.equal(await placeTorchIfDark(lit, newProgress()), false)
  const none = createMockBot(underground)
  room(none, new Vec3(0, 40, 0))
  assert.equal(await placeTorchIfDark(none, newProgress()), false)
})

test('keeps its count across an interruption', async () => {
  const bot = createMockBot({ ...underground, items: { stone_pickaxe: 1 } })
  room(bot, new Vec3(0, 40, 0))
  for (const x of [3, 4, 5, 6]) bot.setBlock(new Vec3(x, 40, 0), 'iron_ore')
  const target = resolveMineTarget(registry, 'iron')
  const progress = newProgress()
  const controller = new AbortController()
  const collect = bot.collectBlock.collect.bind(bot.collectBlock)
  let calls = 0
  bot.collectBlock.collect = async block => {
    await collect(block)
    if (++calls === 2) controller.abort()
  }
  await assert.rejects(mine(bot, target, 4, { movements: {}, signal: controller.signal, progress }), { name: 'AbortedError' })
  assert.equal(progress.done, 2)
  bot.collectBlock.collect = collect
  assert.equal(await mine(bot, target, 4, { movements: {}, progress }), 4)
  assert.equal(countItem(bot, 'raw_iron'), 4)
})

test('gather stops when nothing is left', async () => {
  const bot = createMockBot()
  bot.setBlock(new Vec3(2, 64, 0), 'oak_log')
  const got = await gather(bot, { blockNames: ['oak_log'], itemNames: ['oak_log'], count: 5, movements: {} })
  assert.equal(got, 1)
})

test('gather skips a block it cannot collect', async () => {
  const bot = createMockBot()
  const bad = new Vec3(1, 64, 0)
  const good = new Vec3(5, 64, 0)
  bot.setBlock(bad, 'oak_log')
  bot.setBlock(good, 'oak_log')
  const collect = bot.collectBlock.collect.bind(bot.collectBlock)
  bot.collectBlock.collect = async block => {
    if (block.position.equals(bad)) throw new Error('No path')
    await collect(block)
  }
  const got = await gather(bot, { blockNames: ['oak_log'], itemNames: ['oak_log'], count: 2, movements: {} })
  assert.equal(got, 1)
  assert.equal(bot.blockAt(bad).name, 'oak_log')
})

test('a stuck collect times out and leaves the collector usable', async () => {
  const bot = createMockBot()
  const block = new Vec3(2, 64, 0)
  bot.setBlock(block, 'oak_log')
  const original = bot.collectBlock
  original.collect = () => new Promise(() => {})
  await assert.rejects(collectOne(bot, bot.blockAt(block), { movements: {}, timeoutMs: 10 }), { name: 'TimeoutError' })
  assert.notEqual(bot.collectBlock, original)
  assert.equal(bot.collectBlock.movements, null)
})

test('the collector never keeps its own unsafe movements', async () => {
  const bot = createMockBot()
  bot.setBlock(new Vec3(2, 64, 0), 'oak_log')
  await collectOne(bot, bot.blockAt(new Vec3(2, 64, 0)), { movements: { profile: 'dig' } })
  assert.equal(bot.collectBlock.movements, null)
  assert.equal(bot.pathfinder.movements.profile, 'dig')
  resetCollector(bot)
  assert.equal(bot.collectBlock.movements, null)
})

test('a full inventory stops gathering with a clear error', async () => {
  const bot = createMockBot()
  bot.inventory.emptySlotCount = () => 0
  bot.setBlock(new Vec3(2, 64, 0), 'oak_log')
  await assert.rejects(gather(bot, { blockNames: ['oak_log'], itemNames: ['oak_log'], count: 1, movements: {} }), /Inventory is full/)
})
