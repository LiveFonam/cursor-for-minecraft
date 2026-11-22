// Walking on the fake world (test/mockbot.js): hazards kept out of the path, getting unstuck, and the rescue moves
// that dig only natural ground.   node --test bridge/danger_sensing_agents/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')
const { makeBot, registry } = require('./mockbot')
const { goTo, walkTo, unstick, guardHazards, rescueMoves, isNaturalGround, STUCK_TICKS } = require('../skills/move')
const { Announcer } = require('../announcer')

const id = n => registry.blocksByName[n].id

test('every walk stays off magma and campfires and out of berry bushes, wither roses, powder snow and fire', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  const m = guardHazards(bot, new Movements(bot))
  for (const n of ['sweet_berry_bush', 'wither_rose', 'powder_snow', 'fire', 'soul_fire', 'campfire', 'cobweb', 'lava']) {
    assert.ok(m.blocksToAvoid.has(id(n)), n)
  }
  world.set(new Vec3(3, 63, 0), 'magma_block')
  assert.equal(m.exclusionStep(world.get(new Vec3(3, 64, 0))), 100, 'a step onto magma')
  assert.equal(m.exclusionStep(world.get(new Vec3(2, 64, 0))), 0, 'a step onto grass')
  // once only, and a stand-in without the sets is left alone
  const n = m.exclusionAreasStep.length
  guardHazards(bot, m)
  assert.equal(m.exclusionAreasStep.length, n)
  assert.deepEqual(guardHazards(bot, {}), {})
})

test('the rescue moves dig and pillar through natural ground only, never a block a player could have placed', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  const m = rescueMoves(bot)
  assert.equal(m.canDig, true)
  assert.equal(m.allow1by1towers, true)
  assert.ok(m.scafoldingBlocks.includes(registry.itemsByName.dirt.id))
  const at = new Vec3(1, 64, 1)
  for (const [name, props, ok] of [
    ['stone', null, true], ['deepslate', null, true], ['dirt', null, true], ['gravel', null, true], ['iron_ore', null, true],
    ['deepslate_diamond_ore', null, true], ['oak_leaves', { persistent: false, distance: 1, waterlogged: false }, true],
    ['oak_leaves', { persistent: true, distance: 1, waterlogged: false }, false], ['oak_planks', null, false], ['cobblestone', null, false],
    ['glass', null, false], ['oak_log', null, false], ['white_wool', null, false]
  ]) {
    world.set(at, name, props)
    const b = world.get(at)
    assert.equal(isNaturalGround(b), ok, `${name} ${JSON.stringify(props)}`)
    assert.equal(m.exclusionBreak(b), ok ? 0 : 100, name)
  }
})

test('unstick digs its head free, digs natural ground in its way, and backs off from a placed block', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  world.set(new Vec3(0, 65, 0), 'gravel')
  assert.equal(await unstick(bot, null), 'dug its head free')
  assert.equal(world.name(new Vec3(0, 65, 0)), 'air')
  bot.entity.yaw = 0  // looking north, -z
  world.set(new Vec3(0, 64, -1), 'stone')
  assert.equal(await unstick(bot, null), 'dug stone')
  world.set(new Vec3(0, 64, -1), 'oak_planks')
  world.set(new Vec3(0, 65, -1), 'oak_planks')
  assert.equal(await unstick(bot, null), 'backed off')
  assert.equal(world.name(new Vec3(0, 64, -1)), 'oak_planks', 'a placed block stays')
})

test('a walk that makes no progress is ended early, it gets unstuck, says so and tries again', async () => {
  const { bot } = makeBot({ groundY: 63 })
  const lines = []
  bot.agentsAnnounce = new Announcer({ say: t => lines.push(t) })
  let calls = 0
  const goto = bot.pathfinder.goto
  bot.pathfinder.goto = goal => {
    calls++
    if (calls === 1) return new Promise(() => {})  // stuck: never arrives, never moves
    return goto(goal)
  }
  const t0 = bot.ticks
  const ok = await walkTo(bot, new goals.GoalNear(5, 64, 5, 1), null, { ms: 5000 })
  assert.equal(ok, true)
  assert.equal(calls, 2)
  assert.ok(bot.ticks - t0 >= STUCK_TICKS, 'it waited for the stall')
  assert.ok(bot.entity.position.distanceTo(new Vec3(5.5, 64, 5.5)) <= 2)
  assert.deepEqual(lines, ['stuck, trying another path'])
})

test('the last try uses the rescue moves, and the moves it had come back after', async () => {
  const { bot } = makeBot({ groundY: 63 })
  const own = { name: 'own moves' }
  bot.pathfinder.setMovements(own)
  const rescue = { name: 'rescue' }
  const seen = []
  bot.pathfinder.goto = async () => {
    seen.push(bot.pathfinder.movements.name)
    if (seen.length < 3) throw new Error('No path to the goal!')
  }
  assert.equal(await walkTo(bot, new goals.GoalNear(9, 64, 9, 1), null, { tries: 2, rescue }), true)
  assert.deepEqual(seen, ['own moves', 'own moves', 'rescue'])
  assert.equal(bot.pathfinder.movements, own)
  // every try failing: the last error comes out
  bot.pathfinder.goto = async () => { throw new Error('No path to the goal!') }
  await assert.rejects(walkTo(bot, new goals.GoalNear(9, 64, 9, 1), null, { tries: 1 }), /No path/)
  // a cancelled walk is no failure
  assert.equal(await walkTo(bot, new goals.GoalNear(9, 64, 9, 1), { cancelled: true }), false)
})

test('a path that cannot be found leaves no goal running to dig behind the next job', async () => {
  const { bot } = makeBot({ groundY: 63 })
  const goal = new goals.GoalNear(50, 64, 50, 1)
  // as the real pathfinder.goto does: it rejects on no path and keeps the goal
  bot.pathfinder.goto = async g => { bot.pathfinder.setGoal(g); throw new Error('No path to the goal!') }
  await assert.rejects(goTo(bot, goal, null, 1000), /No path/)
  assert.equal(bot.pathfinder.goal, null)
})

test('a failed walk does not clear a newer goal that replaced it', async () => {
  const { bot } = makeBot({ groundY: 63 })
  const newer = new goals.GoalNear(9, 64, 9, 1)
  bot.pathfinder.goto = async () => { bot.pathfinder.setGoal(newer); throw new Error('The goal was changed') }
  await assert.rejects(goTo(bot, new goals.GoalNear(50, 64, 50, 1), null, 1000), /changed/)
  assert.equal(bot.pathfinder.goal, newer)
})

test('a walk that ends with an empty path leaves no goal behind, as the real pathfinder.goto would', async () => {
  const { bot } = makeBot({ groundY: 63 })
  const goal = new goals.GoalNearXZ(50, 50, 3)
  // on an empty path the library resolves as if it had arrived and keeps the goal, then digs toward it later
  bot.pathfinder.goto = async g => { bot.pathfinder.setGoal(g) }
  await goTo(bot, goal, null, 1000)
  assert.equal(bot.pathfinder.goal, null)
})

test('a finished walk does not clear a newer goal', async () => {
  const { bot } = makeBot({ groundY: 63 })
  const newer = new goals.GoalNear(9, 64, 9, 1)
  bot.pathfinder.goto = async () => { bot.pathfinder.setGoal(newer) }
  await goTo(bot, new goals.GoalNearXZ(50, 50, 3), null, 1000)
  assert.equal(bot.pathfinder.goal, newer)
})

