'use strict'
// The way to an iron pickaxe: a quick choice of where to dig, close to the master, and wood for cooking
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { mineJob } = require('../skills/mine')

const human = {
  level: 'off',
  placesTorches: true,
  nextTorchGap: () => 3,
  idleMoment: async () => {},
  lookAtPoint: async () => {},
  lookAround: async () => {},
  detourPoint: () => null
}
const IRON = ['iron_ore', 'deepslate_iron_ore']
const ironJob = (extra = {}) => ({ block: 'iron', blocks: IRON, count: 1, mined: 0, strategy: 'branch', home: null, ...extra })

// A bot at Y 16 in solid stone with a long straight cave going north and no ore in it. Stops after a few digs
function longCave () {
  const at = new Vec3(0, 16, 0)
  const { bot, world } = makeBot({ groundY: 63, pos: at.offset(0.5, 0, 0.5) })
  for (let z = 0; z >= -150; z--) {
    world.set(new Vec3(0, 16, z), 'air')
    world.set(new Vec3(0, 17, z), 'air')
  }
  bot.give('diamond_pickaxe', 1)
  const token = { cancelled: false }
  let digs = 0
  const dig = bot.dig
  bot.dig = async (block, ...rest) => {
    await dig(block, ...rest)
    if (++digs >= 6) token.cancelled = true
  }
  bot.world.raycast = (from, dir, range) => {
    for (let t = 0; t <= range; t += 0.05) {
      const p = from.plus(dir.scaled(t)).floored()
      if (world.get(p).boundingBox === 'block') return { position: p, face: 0 }
    }
    return null
  }
  return { bot, world, token }
}

test('a dry cave gets a few short moves, then it digs where it stands', async () => {
  const t = longCave()
  const j = ironJob()
  await mineJob(t.bot, j, human, t.token, {})
  assert.ok(j.stats.caveMoves >= 1, 'a cave right there is still used')
  assert.ok(j.stats.caveMoves <= 3, `${j.stats.caveMoves} cave moves`)
  assert.ok(t.token.cancelled, 'it went on to dig')
})

test('the time for caves is limited, however many moves are left', async () => {
  const t = longCave()
  const j = ironJob({ tuning: { caveMs: 1 } })
  await mineJob(t.bot, j, human, t.token, {})
  assert.equal(j.stats.caveMoves, 1)
  assert.ok(t.token.cancelled, 'it went on to dig')
})

// A repeatable stand-in for Math.random
function seeded (seed = 7) {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

test('the first walks to look for a source lean toward the master, the later ones are free', () => {
  const { wanderPoint } = require('../skills/gather')
  const pos = { x: 30, z: 0 }
  const home = { x: 30, z: 0 }
  const master = { x: 0, z: 0 }
  const mean = opts => {
    const random = seeded()
    let sum = 0
    for (let i = 0; i < 300; i++) {
      const p = wanderPoint(pos, home, { ...opts, random })
      sum += Math.hypot(p.x - master.x, p.z - master.z)
    }
    return sum / 300
  }
  assert.ok(mean({ master, early: true }) < mean({ master, early: false }) - 4)
  assert.equal(mean({ master, early: false }), mean({ master: null, early: true }))
  const far = wanderPoint({ x: 47, z: 0 }, { x: 0, z: 0 }, { range: 48, random: () => 0 })
  assert.ok(Math.hypot(far.x, far.z) <= 48.001, 'stays in range of where it started')
})

test('a tree nearer the master wins over one a little nearer the bot', () => {
  const { preferNearMaster } = require('../skills/gather')
  const bot = { entity: { position: new Vec3(10, 64, 0) } }
  const away = new Vec3(16, 64, 0)
  const toward = new Vec3(3, 64, 0)
  assert.deepEqual(preferNearMaster([away, toward], bot, new Vec3(0, 64, 0)), [toward, away])
  assert.deepEqual(preferNearMaster([away, toward], bot, null), [away, toward])
})

test('the run stats give the farthest and average distance from the master', () => {
  const { masterDistance } = require('../skills/gather')
  const path = [{ x: 3, z: 4 }, { x: 0, z: 10 }, { x: 0, z: 0 }]
  assert.deepEqual(masterDistance(path, { x: 0, z: 0 }), { farthest: 10, average: 5 })
  assert.deepEqual(masterDistance([], { x: 0, z: 0 }), { farthest: null, average: null })
})

const woodStep = plan => plan.steps.find(s => s.kind === 'gather' && s.what === 'wood')?.count

test('with raw food or a hunt ahead and no coal left, a few more logs before it leaves the trees', () => {
  const { planGoal } = require('../goal_plan')
  const goal = { item: 'iron_pickaxe', count: 1 }
  const plain = woodStep(planGoal(goal, { bag: [] }))
  assert.equal(woodStep(planGoal(goal, { bag: [['beef', 6]] })), plain + 3)
  assert.equal(woodStep(planGoal(goal, { bag: [], expectsRaw: true })), plain + 3)
  const withCoal = woodStep(planGoal(goal, { bag: [['coal', 5]] }))
  assert.equal(woodStep(planGoal(goal, { bag: [['coal', 5], ['beef', 6]] })), withCoal)
})

function craftKit (items) {
  const { bot, world } = makeBot({ groundY: 63 })
  for (const [n, c] of Object.entries(items)) bot.give(n, c)
  world.set(new Vec3(2, 64, 0), 'crafting_table')
  const job = { item: 'iron_pickaxe', requester: 'someone', keep: true, phase: 'run', made: false, given: false, stats: { crafted: 0, smelted: 0 } }
  return { bot, job }
}

test('with the furnace down for iron it cooks raw food after the pickaxe, on wood, and keeps its coal', async () => {
  const { runCraftJob } = require('../skills/crafter')
  const { bot, job } = craftKit({ raw_iron: 3, cobblestone: 8, oak_log: 6, coal: 3, beef: 6 })
  await runCraftJob(bot, job, { cancelled: false })
  assert.equal(bot.countOf('iron_pickaxe'), 1)
  assert.ok(bot.countOf('cooked_beef') >= 1, 'it cooked')
  assert.ok(bot.countOf('cooked_beef') <= 4, 'a short stop')
  assert.ok(bot.countOf('coal') >= 2, 'the coal stays')
})

test('the stop at the furnace burns spare logs only, never the planks and sticks of the next craft', () => {
  const { furnaceCookLimit } = require('../skills/cook')
  assert.equal(furnaceCookLimit(craftKit({ beef: 6, oak_planks: 8, stick: 4 }).bot), 0)
  assert.equal(furnaceCookLimit(craftKit({ beef: 6, oak_log: 3, oak_planks: 8, stick: 4 }).bot), 4)
  assert.equal(furnaceCookLimit(craftKit({ beef: 6, coal: 5 }).bot), 0)
})

test('with plenty of ready food the iron trip does not stop to cook', async () => {
  const { runCraftJob } = require('../skills/crafter')
  const { bot, job } = craftKit({ raw_iron: 3, cobblestone: 8, oak_log: 6, beef: 6, bread: 8 })
  await runCraftJob(bot, job, { cancelled: false })
  assert.equal(bot.countOf('iron_pickaxe'), 1)
  assert.equal(bot.countOf('cooked_beef'), 0)
})
