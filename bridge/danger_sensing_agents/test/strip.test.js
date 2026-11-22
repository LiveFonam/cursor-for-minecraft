// Strip mining for diamonds from the surface on the fake world (test/mockbot.js): down the staircase to Y -58, the
// branch pattern, torches, turning back for food, and home.   node --test bridge/danger_sensing_agents/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { mineJob } = require('../skills/mine')
const { ensureTorches, nearestIndex } = require('../skills/mine_branch')

const human = {
  level: 'off',
  placesTorches: true,
  nextTorchGap: () => 6,
  idleMoment: async () => {},
  lookAtPoint: async () => {},
  lookAround: async () => {},
  detourPoint: () => null
}
const DIAMOND = ['diamond_ore', 'deepslate_diamond_ore']
// The staircase runs north (yaw 0) from z 0, one block per step, and the main tunnel goes on from its bottom at Y -58.
// The ore sits in the wall of the main tunnel, 2 blocks past the bottom of the stairs. One test starts on the surface,
// the others in a pocket at Y -20 so they run in a few seconds
function setup ({ give = [['iron_pickaxe', 1], ['torch', 32], ['cobblestone', 32]], digLimit = 1200, startY = -20 } = {}) {
  const start = new Vec3(0.5, startY, 0.5)
  const { bot, world } = makeBot({ groundY: 63, pos: start })
  if (startY < 63) {
    world.set(start.floored(), 'air')
    world.set(start.floored().offset(0, 1, 0), 'air')
  }
  const ORE = new Vec3(1, -58, -(startY + 58) - 2)
  for (const [name, n] of give) bot.give(name, n)
  const token = { cancelled: false }
  let digs = 0
  const dig = bot.dig
  bot.dig = async (...a) => {
    await dig(...a)
    if (++digs >= digLimit) token.cancelled = true
  }
  let lowest = Infinity
  const ticks = bot.waitForTicks
  bot.waitForTicks = async n => {
    await ticks(n)
    lowest = Math.min(lowest, Math.floor(bot.entity.position.y))
  }
  bot.world.raycast = (from, dir, range) => {
    for (let t = 0; t <= range; t += 0.05) {
      const p = from.plus(dir.scaled(t)).floored()
      if (world.get(p).boundingBox === 'block') return { position: p, face: 0 }
    }
    return null
  }
  world.set(ORE, 'deepslate_diamond_ore')
  return { bot, world, token, start, ORE, lowest: () => lowest, digs: () => digs }
}

const job = (extra = {}) => ({ block: 'diamond', blocks: DIAMOND, count: 1, mined: 0, strategy: 'branch', home: null, store: false, ...extra })

test('diamonds from the surface: a staircase to Y -58, the ore found in a tunnel wall, torches up, and back home', async () => {
  const s = setup({ startY: 64 })
  const j = job()
  const r = await mineJob(s.bot, j, human, s.token, {})
  assert.equal(r.result, 'done', r.message)
  assert.equal(s.bot.countOf('diamond'), 1)
  assert.equal(s.lowest(), -58, 'it mines at Y -58, never lower')
  assert.ok(j.stats.descended >= 120, `${j.stats.descended} steps down`)
  // about 122 steps down at one torch per 32 blocks
  assert.ok(j.stats.torches >= 3 && j.stats.torches <= 5, `${j.stats.torches} torches on the way down`)
  assert.ok(s.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) <= 4, `home, at ${s.bot.entity.position}`)
})

test('lava beside the staircase turns it, and it still reaches Y -58', async () => {
  const s = setup()
  // a lava pocket straight ahead of the stairs at Y -30
  s.world.fill3(new Vec3(-1, -32, -12), new Vec3(1, -28, -10), 'lava')
  s.world.set(s.ORE, 'deepslate')
  const j = job({ count: 1, tuning: { branchLen: 2 } })
  // the stairs turn, so the ore goes wherever it ends up: stop once it is at depth
  const dig = s.bot.dig
  s.bot.dig = async (...a) => {
    await dig(...a)
    if (Math.floor(s.bot.entity.position.y) <= -58) s.token.cancelled = true
  }
  const r = await mineJob(s.bot, j, human, s.token, {})
  assert.equal(r.result, 'cancelled')
  assert.equal(s.lowest(), -58)
  assert.ok(j.stats.lavaBlocked >= 1, 'it saw the lava')
  assert.ok(j.stats.turns >= 1, 'and turned')
})

test('too little food at the face: home along its path, food there, back down, and the job finishes', async () => {
  const s = setup()
  const j = job()
  let restocked = 0
  let posAtRestock = null
  const hooks = {
    // short of food once, deep in the stairs
    lowFood: () => !restocked && s.bot.entity.position.y < -40,
    restock: async () => {
      restocked++
      posAtRestock = s.bot.entity.position.clone()
      return true
    },
    restocking: on => { s.restockFlag = (s.restockFlag || []).concat(on) }
  }
  const r = await mineJob(s.bot, j, human, s.token, hooks)
  assert.equal(r.result, 'done', r.message)
  assert.equal(restocked, 1)
  assert.ok(posAtRestock.distanceTo(s.start) <= 4, `it got food at home, not at ${posAtRestock}`)
  assert.equal(j.stats.foodTrips, 1)
  assert.deepEqual(s.restockFlag, [true, false])
  assert.equal(s.bot.countOf('diamond'), 1)
  assert.ok(s.digs() < 200, `it went on from its old tunnel, ${s.digs()} blocks dug`)
})

test('no food to be had at home: it stops there and says so instead of starving at the face', async () => {
  const s = setup()
  const j = job()
  const r = await mineJob(s.bot, j, human, s.token, {
    lowFood: () => s.bot.entity.position.y < -40,
    restock: async () => false
  })
  assert.equal(r.result, 'food')
  assert.match(r.message, /too little food/)
  assert.ok(s.bot.entity.position.distanceTo(s.start) <= 4)
})

test('torches: a few from spare coal and wood on a long tunnel, never what the job needs', async () => {
  const says = []
  const long = { say: t => says.push(t), log: () => {}, sinceTorch: 32, label: 'iron' }
  const a = makeBot().bot
  a.give('coal', 6)
  a.give('oak_planks', 8)
  assert.equal(await ensureTorches(a, long, { cancelled: false }), 4)
  assert.equal(a.countOf('torch'), 4)
  assert.equal(a.countOf('coal'), 5, 'one coal, the rest stays for the furnace')
  assert.match(says[0], /Crafted 4 torches/)
  // a short trip crafts none
  const short = makeBot().bot
  short.give('coal', 6)
  short.give('oak_planks', 8)
  assert.equal(await ensureTorches(short, { ...long, sinceTorch: 10 }, { cancelled: false }), 0)
  assert.equal(short.countOf('coal'), 6)
  // the coal the furnace needs stays
  const smelting = makeBot().bot
  smelting.give('coal', 4)
  smelting.give('oak_planks', 8)
  assert.equal(await ensureTorches(smelting, long, { cancelled: false }), 0)
  assert.equal(smelting.countOf('coal'), 4)
  // so does the wood for a new pickaxe
  const lowWood = makeBot().bot
  lowWood.give('coal', 8)
  lowWood.give('oak_planks', 4)
  assert.equal(await ensureTorches(lowWood, long, { cancelled: false }), 0)
  assert.equal(lowWood.countOf('oak_planks'), 4)
  // coal it is mining for is never burned
  const coalJob = makeBot().bot
  coalJob.give('coal', 8)
  coalJob.give('oak_planks', 8)
  assert.equal(await ensureTorches(coalJob, { ...long, label: 'coal' }, { cancelled: false }), 0)
  // torches left: nothing to craft
  const c = makeBot().bot
  c.give('torch', 1)
  c.give('coal', 8)
  c.give('stick', 6)
  assert.equal(await ensureTorches(c, long, { cancelled: false }), 0, 'it still has one')
})

test('a walk along the path starts from the cell nearest to the bot', () => {
  const cells = [new Vec3(0, 64, 0), new Vec3(0, 63, -1), new Vec3(0, 62, -2), new Vec3(0, 61, -3)]
  assert.equal(nearestIndex(cells, new Vec3(0, 62, -2)), 2)
  assert.equal(nearestIndex(cells, new Vec3(5, 70, 5)), 0)
})
