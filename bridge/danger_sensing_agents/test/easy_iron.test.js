// When the goal planner gathers iron it also takes the easy iron in front of it, up to a cap. It never goes looking.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { gatherKind } = require('../skills/gatherer')
const { goalCommands, planGoal } = require('../goal_plan')

const human = { level: 'off', placesTorches: true, nextTorchGap: () => 3, idleMoment: async () => {}, lookAtPoint: async () => {}, lookAround: async () => {} }
const at = new Vec3(0, 16, 0)

function room () {
  const { bot, world } = makeBot({ groundY: 63, pos: at.offset(0.5, 0, 0.5) })
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      world.set(at.offset(x, 0, z), 'air')
      world.set(at.offset(x, 1, z), 'air')
    }
  }
  bot.world.raycast = (from, dir, range) => {
    for (let t = 0; t <= range; t += 0.05) {
      const p = from.plus(dir.scaled(t)).floored()
      if (world.get(p).boundingBox === 'block') return { position: p, face: 0 }
    }
    return null
  }
  bot.give('stone_pickaxe', 1)
  return { bot, world }
}

// count ore blocks in the north wall of the room, all in plain view
function wallOre (world, count) {
  const cells = []
  for (let y = 0; y <= 1; y++) for (let x = -1; x <= 1; x++) cells.push(at.offset(x, y, -2))
  for (let y = 0; y <= 1; y++) for (let x = -1; x <= 1; x++) cells.push(at.offset(x, y, 2))
  for (let y = 0; y <= 1; y++) for (let z = -1; z <= 1; z++) cells.push(at.offset(-2, y, z))
  for (let y = 0; y <= 1; y++) for (let z = -1; z <= 1; z++) cells.push(at.offset(2, y, z))
  for (const c of cells.slice(0, count)) world.set(c, 'iron_ore')
}

async function run (bot, want, deps = {}) {
  const token = { cancelled: false }
  const dig = bot.dig
  let n = 0
  bot.dig = async (...a) => { await dig(...a); if (++n > 200) token.cancelled = true }
  const r = await gatherKind(bot, 'iron', want, token, { human, tuning: { branchLen: 4 }, ...deps })
  return { r, digs: n }
}

test('asked for 3 with a vein of 6 in view: it takes all 6', async () => {
  const { bot, world } = room()
  wallOre(world, 6)
  const { r } = await run(bot, 3, { takeEasy: 12 })
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.countOf('raw_iron'), 6)
})

test('asked for 3 with 20 in view: it stops at the cap of 12', async () => {
  const { bot, world } = room()
  wallOre(world, 20)
  const { r } = await run(bot, 3, { takeEasy: 12 })
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.countOf('raw_iron'), 12)
})

test('nothing extra in view: exact count, no digging for more', async () => {
  const { bot, world } = room()
  wallOre(world, 3)
  const { r, digs } = await run(bot, 3, { takeEasy: 12 })
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.countOf('raw_iron'), 3)
  assert.equal(digs, 3, 'no detour')
  assert.ok(bot.entity.position.distanceTo(at.offset(0.5, 0, 0.5)) <= 4)
})

test('ore behind a wall is not taken', async () => {
  const { bot, world } = room()
  wallOre(world, 3)
  world.set(at.offset(0, 0, 3), 'iron_ore')  // behind the stone of the south wall
  world.set(at.offset(3, 1, 0), 'iron_ore')  // behind the stone of the east wall
  const { r } = await run(bot, 3, { takeEasy: 12 })
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.countOf('raw_iron'), 3)
  assert.equal(world.get(at.offset(0, 0, 3)).name, 'iron_ore')
  assert.equal(world.get(at.offset(3, 1, 0)).name, 'iron_ore')
})

test('a plain gather without the option keeps its exact count', async () => {
  const { bot, world } = room()
  wallOre(world, 6)
  const { r } = await run(bot, 3)
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.countOf('raw_iron'), 3)
})

test('ore touching lava is left alone', async () => {
  const { bot, world } = room()
  wallOre(world, 4)
  world.set(at.offset(1, 1, -3), 'lava')  // behind the fourth ore's neighbour
  world.set(at.offset(-1, 1, -3), 'lava')  // behind the fourth ore
  const { r } = await run(bot, 3, { takeEasy: 12 })
  assert.equal(r.result, 'done', r.message)
  assert.equal(world.get(at.offset(-1, 1, -2)).name, 'iron_ore')
})

test('low food: no extra iron', async () => {
  const { bot, world } = room()
  wallOre(world, 6)
  let asked = 0
  const lowFood = job => job.mined >= 3 && ++asked > 0
  const { r } = await run(bot, 3, { takeEasy: 12, lowFood, restock: async () => 'ok' })
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.countOf('raw_iron'), 3)
})

test('only the planner\'s iron step asks for easy iron, and extra iron just shortens the plan', () => {
  const args = bag => goalCommands(planGoal({ item: 'iron_pickaxe', count: 1 }, { bag: new Map(bag), chests: [] }), 'someone')
    .map(c => c.command).filter(c => c?.name === 'gather').map(c => c.args)
  const fresh = args([['stone_pickaxe', 1], ['stick', 2], ['furnace', 1], ['coal', 3]])
  const iron = fresh.find(a => a.kind === 'iron')
  assert.equal(iron.takeEasy, 12)
  assert.ok(fresh.filter(a => a.kind !== 'iron').every(a => !('takeEasy' in a)))
  const after = args([['stone_pickaxe', 1], ['stick', 2], ['furnace', 1], ['coal', 3], ['raw_iron', 6]])
  assert.ok(!after.some(a => a.kind === 'iron'), 'the extra iron is simply in the bag')
})
