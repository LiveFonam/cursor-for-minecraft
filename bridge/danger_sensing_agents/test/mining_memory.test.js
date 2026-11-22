'use strict'
// The bot's memory while mining: the tunnels it dug and the ore it saw and left in the ground
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { mineJob } = require('../skills/mine')
const { TunnelMap } = require('../skills/tunnel_map')
const { OreMarks, answerDiamonds, saysYesToDiamonds } = require('../skills/ore_marks')

const human = {
  level: 'off',
  placesTorches: false,
  nextTorchGap: () => 99,
  idleMoment: async () => {},
  lookAtPoint: async () => {},
  lookAround: async () => {},
  detourPoint: () => null
}
const IRON = ['iron_ore', 'deepslate_iron_ore']
const DIAMOND = ['diamond_ore', 'deepslate_diamond_ore']
const NORTH = { x: 0, z: -1 }

function setup ({ at = new Vec3(0, 24, 0), digLimit = 200, give = [['diamond_pickaxe', 1]] } = {}) {
  const { bot, world } = makeBot({ groundY: 63, pos: at.offset(0.5, 0, 0.5) })
  world.set(at, 'air')
  world.set(at.offset(0, 1, 0), 'air')
  for (const [name, n] of give) bot.give(name, n)
  const token = { cancelled: false }
  const digs = []
  const dig = bot.dig
  bot.dig = async (block, ...rest) => {
    const pos = block.position.clone()
    const name = world.name(pos)
    await dig(block, ...rest)
    digs.push({ pos, name })
    if (digs.length >= digLimit) token.cancelled = true
  }
  const stood = []
  const ticks = bot.waitForTicks
  bot.waitForTicks = async (n) => {
    await ticks(n)
    stood.push(bot.entity.position.floored())
  }
  bot.world.raycast = (from, dir, range) => {
    for (let t = 0; t <= range; t += 0.05) {
      const p = from.plus(dir.scaled(t)).floored()
      if (world.get(p).boundingBox === 'block') return { position: p, face: 0 }
    }
    return null
  }
  bot._tunnelMap = new TunnelMap()
  const logs = []
  return { bot, world, token, digs, stood, logs, hooks: { log: t => logs.push(t) } }
}

const job = (block, blocks, extra = {}) => ({ block, blocks, count: 1, mined: 0, strategy: 'branch', home: null, store: false, tuning: { branchLen: 0 }, ...extra })

// A staircase north from start down to y, then a level tunnel, carved and remembered as if the bot had dug them
function carve (bot, world, start, y, level) {
  const open = c => { world.set(c, 'air'); world.set(c.offset(0, 1, 0), 'air'); world.set(c.offset(0, 2, 0), 'air') }
  let c = start.clone()
  open(c)
  bot._tunnelMap.add(bot, 'stair', c, NORTH)
  const stairs = [c]
  while (c.y > y) {
    c = c.offset(0, -1, -1)
    open(c)
    bot._tunnelMap.add(bot, 'stair', c, NORTH)
    stairs.push(c)
  }
  const main = []
  for (let i = 0; i < level; i++) {
    c = c.offset(0, 0, -1)
    open(c)
    bot._tunnelMap.add(bot, 'main', c, NORTH)
    main.push(c)
  }
  return { stairs, main }
}

test('a second ore trip walks through the first tunnel instead of digging a new one', async () => {
  const { bot, world, token, digs, logs, hooks } = setup()
  world.set(new Vec3(0, 16, -11), 'iron_ore')
  const first = await mineJob(bot, job('iron', IRON), human, token, hooks)
  assert.equal(first.result, 'done', first.message)
  const before = digs.length
  assert.ok(before > 10, 'the first trip dug a staircase')
  world.set(new Vec3(0, 16, -15), 'iron_ore')
  const second = await mineJob(bot, job('iron', IRON), human, token, hooks)
  assert.equal(second.result, 'done', second.message)
  const later = digs.slice(before)
  assert.ok(later.length <= 12, `second trip dug ${later.length} blocks`)
  assert.ok(later.every(d => d.pos.y <= 17 && d.pos.z <= -10), 'nothing dug outside the end of the old tunnel')
  assert.ok(logs.some(l => /tunnels: reusing/.test(l)), logs.join(' | '))
})

test('the diamond trip continues down the existing staircase from its deepest point', async () => {
  const { bot, world, token, digs, logs, hooks } = setup({ digLimit: 60 })
  const { stairs } = carve(bot, world, new Vec3(0, 24, 0), 16, 4)
  const r = await mineJob(bot, job('diamond', DIAMOND), human, token, hooks)
  assert.equal(r.result, 'cancelled')
  const bottom = stairs[stairs.length - 1].y
  assert.ok(digs.every(d => d.pos.y <= bottom + 1), `dug above the old staircase: ${digs.find(d => d.pos.y > bottom + 1)?.pos}`)
  assert.ok(Math.min(...digs.map(d => d.pos.y)) < bottom - 5, 'it went on down')
  assert.ok(logs.some(l => /tunnels: reusing/.test(l)), logs.join(' | '))
})

for (const blocker of ['gravel', 'water', 'lava']) {
  test(`a remembered tunnel blocked by ${blocker} falls back to digging`, async () => {
    const { bot, world, token, digs, stood, logs, hooks } = setup({ digLimit: 30 })
    const { stairs } = carve(bot, world, new Vec3(0, 24, 0), 16, 4)
    const bad = stairs[4]
    world.set(bad, blocker)
    const r = await mineJob(bot, job('iron', IRON), human, token, hooks)
    assert.equal(r.result, 'cancelled')
    assert.ok(logs.some(l => /tunnels: digging fresh \(.*blocked/.test(l)), logs.join(' | '))
    assert.ok(digs.length > 0, 'it dug on')
    // gravel is dug out like any block in its way, a liquid is never walked into
    if (blocker === 'gravel') assert.ok(digs.some(d => d.pos.equals(bad) && d.name === 'gravel'), 'it dug the gravel out')
    else assert.ok(!stood.some(p => p.equals(bad)), 'it never stood in the liquid')
  })
}

test('a danger response stops the walk through a remembered tunnel at once', async () => {
  const { bot, world, token, stood, hooks } = setup()
  const { main } = carve(bot, world, new Vec3(0, 24, 0), 16, 8)
  const ticks = bot.waitForTicks
  let n = 0
  bot.waitForTicks = async (t) => {
    await ticks(t)
    if (++n === 3) token.cancelled = true
  }
  const r = await mineJob(bot, job('iron', IRON), human, token, hooks)
  assert.equal(r.result, 'cancelled')
  assert.ok(!stood.some(p => p.equals(main[main.length - 1])), 'it did not walk on to the end')
})

test('gold buried in the rock is never marked, only ore it truly sees counts', async () => {
  const { bot, world, token, hooks } = setup({ at: new Vec3(0, 16, 0) })
  world.set(new Vec3(4, 16, -2), 'gold_ore')
  world.set(new Vec3(0, 16, -5), 'iron_ore')
  bot._oreMarks = new OreMarks()
  const r = await mineJob(bot, job('iron', IRON), human, token, hooks)
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot._oreMarks.list().length, 0)
  assert.equal(bot.chats.filter(t => /^Found /.test(t)).length, 0)
})

test('a respawn far from its tunnels digs fresh right there', async () => {
  const { bot, world, token, digs, stood, logs, hooks } = setup({ at: new Vec3(400, 40, 400), digLimit: 20 })
  carve(bot, world, new Vec3(0, 24, 0), 16, 4)
  const r = await mineJob(bot, job('iron', IRON), human, token, hooks)
  assert.equal(r.result, 'cancelled')
  assert.ok(logs.some(l => /tunnels: digging fresh \(.*away/.test(l)), logs.join(' | '))
  assert.ok(digs.length > 0)
  assert.ok(stood.every(p => p.distanceTo(new Vec3(400, 40, 400)) < 30), 'no long walk')
})

test('a remembered diamond is reached through the tunnels', async () => {
  const { bot, world, token, digs, logs, hooks } = setup()
  const { main } = carve(bot, world, new Vec3(0, 24, 0), 16, 6)
  const gem = main[main.length - 1].offset(0, 0, -1)
  world.set(gem, 'diamond_ore')
  bot._oreMarks = new OreMarks({ say: () => {} })
  bot._oreMarks.saw(bot, [gem], 'diamond')
  const r = await mineJob(bot, job('diamond', DIAMOND), human, token, hooks)
  assert.equal(r.result, 'done', r.message)
  assert.equal(world.name(gem), 'air')
  assert.equal(digs.length, 1, 'only the diamond was dug')
  assert.ok(logs.some(l => /tunnels: reusing.*remembered/.test(l)), logs.join(' | '))
})

test('the way home goes up the remembered staircase when its own path stops short of home', async () => {
  const start = new Vec3(0, 16, -12)
  const home = new Vec3(0, 24, 0)
  const { bot, world, token, digs, logs, hooks } = setup({ at: start })
  carve(bot, world, home, 16, 4)
  world.set(start.offset(0, 0, -1), 'iron_ore')
  const r = await mineJob(bot, job('iron', IRON, { home }), human, token, hooks)
  assert.equal(r.result, 'done', r.message)
  assert.ok(logs.some(l => /tunnels: reusing .* on the way home/.test(l)), logs.join(' | '))
  assert.ok(bot.entity.position.distanceTo(home.offset(0.5, 0, 0.5)) <= 4, `ended at ${bot.entity.position}`)
  assert.ok(digs.every(d => d.name === 'iron_ore'), 'nothing dug on the way out')
})

test('with the map on, the branch grid keeps its branches 3 apart on both sides', async () => {
  const { bot, world, token } = setup({ at: new Vec3(0, -58, 0), digLimit: 140 })
  const j = job('diamond', DIAMOND, { tuning: { branchLen: 4 } })
  const r = await mineJob(bot, j, human, token, {})
  assert.equal(r.result, 'cancelled')
  assert.ok(j.stats.branches >= 4, `${j.stats.branches} branches`)
  for (const z of [0, -3, -6]) {
    for (let k = 1; k <= 4; k++) {
      assert.equal(world.name(new Vec3(k, -58, z)), 'air', `east branch at ${z} cell ${k}`)
      assert.equal(world.name(new Vec3(-k, -58, z)), 'air', `west branch at ${z} cell ${k}`)
    }
  }
})

test('a staircase dug for cobblestone is remembered for the next ore trip', async () => {
  const { bot, token } = setup({ at: new Vec3(0, 64, 0) })
  await require('../skills/gather').gather(bot, 'cobblestone', 3, token, {})
  assert.ok(bot._tunnelMap.segments.some(s => s.kind === 'stair' && s.len >= 2), JSON.stringify(bot._tunnelMap.segments))
})

test('the map stays compact, and rock beside an old tunnel counts as already searched', () => {
  const { bot } = setup()
  const map = bot._tunnelMap
  for (let i = 0; i < 200; i++) map.add(bot, 'main', new Vec3(0, 16, -i), NORTH)
  assert.equal(map.segments.length, 1)
  assert.equal(map.oldRock(bot, new Vec3(2, 16, -50), NORTH), true, '2 blocks from the old tunnel')
  assert.equal(map.oldRock(bot, new Vec3(3, 16, -50), NORTH), false, '2 solid blocks between')
})

test('an iron job leaves gold and lapis, and tells the master once per cluster with the right name', async () => {
  const { bot, world, token, digs, hooks } = setup({ at: new Vec3(0, 16, 0) })
  const gold = new Vec3(1, 16, -2)
  const lapis = new Vec3(-1, 16, -2)
  world.set(gold, 'deepslate_gold_ore')
  world.set(lapis, 'lapis_ore')
  world.set(new Vec3(0, 16, -5), 'iron_ore')
  bot._oreMarks = new OreMarks()
  const r = await mineJob(bot, job('iron', IRON), human, token, hooks)
  assert.equal(r.result, 'done', r.message)
  assert.equal(world.name(gold), 'deepslate_gold_ore')
  assert.equal(world.name(lapis), 'lapis_ore')
  assert.equal(digs.filter(d => /gold|lapis/.test(d.name)).length, 0)
  const told = bot.chats.filter(t => /^Found /.test(t))
  assert.equal(told.length, 2, told.join(' | '))
  assert.ok(told.includes("Found gold at 1 16 -2. Say get the gold if you want it. I'm carrying on."), told.join(' | '))
  assert.ok(told.includes("Found lapis at -1 16 -2. Say get the lapis if you want it. I'm carrying on."), told.join(' | '))
  assert.deepEqual(bot._oreMarks.list().map(c => c.kind).sort(), ['gold', 'lapis'])
})

test('a gold job mines gold from a remembered spot and still leaves the lapis', async () => {
  const { bot, world, token, hooks } = setup({ at: new Vec3(0, 16, 0) })
  const gold = new Vec3(0, 16, -3)
  const lapis = new Vec3(1, 16, -1)
  world.set(new Vec3(0, 16, -1), 'air')
  world.set(new Vec3(0, 17, -1), 'air')
  world.set(new Vec3(0, 16, -2), 'air')
  world.set(new Vec3(0, 17, -2), 'air')
  world.set(gold, 'gold_ore')
  world.set(lapis, 'lapis_ore')
  bot._oreMarks = new OreMarks({ say: () => {} })
  bot._oreMarks.saw(bot, [gold], 'gold')
  bot._oreMarks.saw(bot, [lapis], 'lapis')
  const r = await mineJob(bot, job('gold', ['gold_ore', 'deepslate_gold_ore']), human, token, hooks)
  assert.equal(r.result, 'done', r.message)
  assert.equal(world.name(gold), 'air')
  assert.equal(world.name(lapis), 'lapis_ore')
  assert.deepEqual(bot._oreMarks.list().map(c => c.kind), ['lapis'])
})

test('clusters of different ores stay separate even when they touch', () => {
  const { bot } = setup()
  const marks = new OreMarks({ say: () => {} })
  marks.saw(bot, [new Vec3(0, 16, 0)], 'gold')
  marks.saw(bot, [new Vec3(1, 16, 0)], 'lapis')
  marks.saw(bot, [new Vec3(2, 16, 0)], 'gold')
  assert.equal(marks.list().length, 2)
  assert.equal(marks.nearest(bot, new Set(), 'lapis').x, 1)
})

function answering (give) {
  const { bot } = setup({ give })
  const marks = new OreMarks({ say: () => {} })
  const run = []
  const said = []
  const ctx = { bot, alive: true, plan: null, manager: { active: null } }
  const agents = { oreMarks: marks, names: [bot.username], ctxs: new Map([[bot.username, ctx]]), say: (b, t) => said.push(t), execute: (c, command) => run.push(command) }
  return { bot, marks, run, said, ctx, agents }
}

test('"get the gold" and "get the lapis" answer their own question and queue a mine job', () => {
  const { bot, marks, run, ctx, agents } = answering([['iron_pickaxe', 1]])
  marks.saw(bot, [new Vec3(0, 16, 3), new Vec3(1, 16, 3)], 'gold')
  marks.saw(bot, [new Vec3(40, 16, 3)], 'lapis')
  assert.equal(answerDiamonds(agents, 'get the gold', 'someone', { every: 0 }), true)
  assert.equal(marks.list().find(c => c.kind === 'gold').answered, true)
  assert.equal(marks.list().find(c => c.kind === 'lapis').answered, false)
  assert.equal(answerDiamonds(agents, 'get the lapis', 'someone', { every: 0 }), true)
  ctx.diamondCheck()
  assert.deepEqual(run[0], { name: 'mine', args: { block: 'gold', blocks: ['gold_ore', 'deepslate_gold_ore'], count: 2 } })
  ctx.diamondCheck()
  assert.deepEqual(run[1], { name: 'mine', args: { block: 'lapis', blocks: ['lapis_ore', 'deepslate_lapis_ore'], count: 1 } })
})

test('a plain yes answers the newest open question, and "get the gold" with none open is left alone', () => {
  const { bot, marks, run, ctx, agents } = answering([['iron_pickaxe', 1]])
  assert.equal(answerDiamonds(agents, 'get the gold', 'someone', { every: 0 }), false)
  marks.saw(bot, [new Vec3(0, 16, 3)], 'gold')
  marks.saw(bot, [new Vec3(40, 16, 3)], 'lapis')
  assert.equal(answerDiamonds(agents, 'yes', 'someone', { every: 0 }), true)
  ctx.diamondCheck()
  assert.equal(run[0].args.block, 'lapis')
  assert.equal(saysYesToDiamonds('get the gold', ['Agent1']), false, 'gold is no yes to diamonds')
})

test('without a good enough pickaxe it says so and leaves the ore marked', () => {
  const { bot, marks, run, said, ctx, agents } = answering([['stone_pickaxe', 1]])
  marks.saw(bot, [new Vec3(0, 16, 3)], 'gold')
  assert.equal(answerDiamonds(agents, 'get the gold', 'someone', { every: 0 }), true)
  ctx.diamondCheck()
  assert.equal(run.length, 0)
  assert.ok(said.some(t => /iron pickaxe/.test(t) && /gold/.test(t)), said.join(' | '))
  assert.equal(marks.list().length, 1, 'still remembered')
})

test('lapis only takes a stone pickaxe', () => {
  const { bot, marks, run, ctx, agents } = answering([['stone_pickaxe', 1]])
  marks.saw(bot, [new Vec3(0, 16, 3)], 'lapis')
  assert.equal(answerDiamonds(agents, 'get the lapis', 'someone', { every: 0 }), true)
  ctx.diamondCheck()
  assert.equal(run.length, 1)
})
