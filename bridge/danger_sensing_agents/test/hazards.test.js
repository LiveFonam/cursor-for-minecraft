// Lava, creepers during a retreat, and mobs sealed off below the bot. No server needed
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { Friends } = require('../targets')
const { DangerAssessor } = require('../threats')
const { makeModes } = require('../behaviors')
const { digHazard, guardDigging, lavaExit, leaveLava, lavaStepCost, markBurned, sealedOff } = require('../hazards')

// A lava pool at y 63, x -3 to 1 and z -2 to 2, with the bot in it. The nearest bank is two moves east
function inPool () {
  const { bot, world } = makeBot({ groundY: 63 })
  world.fill3(new Vec3(-3, 63, -2), new Vec3(1, 63, 2), 'lava')
  bot.entity.position = new Vec3(0.5, 63, 0.5)
  bot.entity.isInLava = true
  bot.entity.onGround = false
  return { bot, world }
}

function assessor (bot) {
  const friends = new Friends('Owner', ['Agent1'])
  let t = 1000000
  const clock = { now: () => t, add: ms => { t += ms } }
  bot.give('bread', 8)
  return { a: new DangerAssessor(bot, { friends, owner: 'Owner', now: clock.now }), clock }
}

// A cave at y 50 to 54 under solid ground, with the bot standing on the surface at y 64 or in a shaft
function overCave (world) {
  world.fill3(new Vec3(-8, 50, -8), new Vec3(8, 54, 8), 'air')
}

const mob = (bot, id, name, x, y, z) => {
  const e = { id, type: 'hostile', name, position: new Vec3(x, y, z), height: 1.95, yaw: 0 }
  bot.entities[id] = e
  return e
}

test('a block with lava above or beside it, or over lava under the feet, is not safe to break', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  const clean = bot.blockAt(new Vec3(5, 63, 5))
  assert.equal(digHazard(bot, clean), null)
  world.set(new Vec3(6, 63, 5), 'lava')
  assert.match(digHazard(bot, bot.blockAt(new Vec3(5, 63, 5))), /lava/)
  world.set(new Vec3(5, 62, 9), 'stone')
  world.set(new Vec3(5, 63, 9), 'lava')
  assert.match(digHazard(bot, bot.blockAt(new Vec3(5, 62, 9))), /lava/, 'lava resting on it')
  world.set(new Vec3(0, 61, 0), 'lava')
  world.set(new Vec3(0, 62, 0), 'air')
  assert.match(digHazard(bot, bot.blockAt(new Vec3(0, 63, 0))), /lava/, 'its own floor over lava')
})

test('the dig guard refuses a block that would let lava out, as an aborted dig, and leaves it standing', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  guardDigging(bot)
  guardDigging(bot)  // once only
  world.set(new Vec3(3, 64, 0), 'stone')
  world.set(new Vec3(4, 64, 0), 'lava')
  await assert.rejects(bot.dig(bot.blockAt(new Vec3(3, 64, 0))), /aborted/i)
  assert.equal(world.name(new Vec3(3, 64, 0)), 'stone')
  world.set(new Vec3(-3, 64, 0), 'stone')
  await bot.dig(bot.blockAt(new Vec3(-3, 64, 0)))
  assert.equal(world.name(new Vec3(-3, 64, 0)), 'air')
})

test('the dig guard lets a stuck head dig out even beside lava', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  let stuck = true
  guardDigging(bot, { allow: () => stuck })
  world.set(new Vec3(3, 64, 0), 'stone')
  world.set(new Vec3(4, 64, 0), 'lava')
  await bot.dig(bot.blockAt(new Vec3(3, 64, 0)))
  assert.equal(world.name(new Vec3(3, 64, 0)), 'air')
  stuck = false
})

test('a walk beside lava costs extra, a floor of lava is ruled out, open ground costs nothing', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  assert.equal(lavaStepCost(bot, new Vec3(5, 64, 5)), 0)
  world.set(new Vec3(6, 63, 5), 'lava')
  assert.ok(lavaStepCost(bot, new Vec3(5, 64, 5)) > 0, 'the pool is one block over and one down')
  assert.ok(lavaStepCost(bot, new Vec3(5, 64, 5)) < 100, 'still allowed when it is the only way')
  world.set(new Vec3(9, 63, 9), 'lava')
  assert.equal(lavaStepCost(bot, new Vec3(9, 64, 9)), 100)
})

test('every walk gets the lava rules: beside it costs extra, breaking what holds it back is ruled out', () => {
  const { guardHazards } = require('../skills/move')
  const { bot, world } = makeBot({ groundY: 63 })
  const moves = { blocksToAvoid: new Set(), exclusionAreasStep: [], exclusionAreasBreak: [] }
  guardHazards(bot, moves)
  world.set(new Vec3(6, 63, 5), 'lava')
  const step = moves.exclusionAreasStep.reduce((n, f) => n + f(bot.blockAt(new Vec3(5, 64, 5))), 0)
  assert.ok(step > 0 && step < 100, `priced, not forbidden: ${step}`)
  assert.equal(moves.exclusionAreasBreak.reduce((n, f) => n + f(bot.blockAt(new Vec3(5, 63, 5))), 0), 100)
  assert.equal(moves.exclusionAreasBreak.reduce((n, f) => n + f(bot.blockAt(new Vec3(-5, 63, -5))), 0), 0)
})

test('gathering passes over stone that holds back lava and takes the safe block instead', async () => {
  const { gather } = require('../skills/gather')
  const { bot, world } = makeBot({ groundY: 63 })
  bot.give('stone_pickaxe', 1)
  world.set(new Vec3(2, 64, 0), 'stone')
  world.set(new Vec3(3, 64, 0), 'lava')
  world.set(new Vec3(-4, 64, 0), 'stone')
  await gather(bot, 'cobblestone', 1, { cancelled: false })
  assert.equal(world.name(new Vec3(2, 64, 0)), 'stone', 'the wall of the pool stays')
  assert.equal(world.name(new Vec3(-4, 64, 0)), 'air')
})

test('the way out of lava is the shortest one, onto dry standing ground', () => {
  const { bot } = inPool()
  const way = lavaExit(bot)
  assert.deepEqual([way.target.x, way.target.y, way.target.z], [2, 64, 0])
})

test('no way out inside the search range gives null', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  world.fill3(new Vec3(-20, 63, -20), new Vec3(20, 66, 20), 'lava')
  bot.entity.position = new Vec3(0.5, 63, 0.5)
  bot.entity.isInLava = true
  assert.equal(lavaExit(bot), null)
})

test('in lava it steers itself out at once, facing the bank, and lets go of the keys after', async () => {
  const { bot } = inPool()
  let ticks = 0
  let seen = null
  bot.waitForTicks = async () => {
    ticks++
    seen ??= { forward: bot.getControlState('forward'), jump: bot.getControlState('jump'), yaw: bot.entity.yaw }
    if (ticks >= 3) bot.entity.isInLava = false
  }
  assert.equal(await leaveLava(bot, {}), true)
  assert.equal(seen.forward, true)
  assert.equal(seen.jump, true)
  assert.ok(Math.abs(seen.yaw + Math.PI / 2) < 0.6, `faces east, yaw ${seen.yaw}`)
  assert.equal(bot.getControlState('forward'), false)
  assert.equal(bot.getControlState('jump'), false)
})

test('the escape mode does not depend on a path: a pathfinder that fails leaves it swimming, not idle', async () => {
  const { bot } = inPool()
  const events = []
  const ctx = { bot, agents: { friends: new Friends('Owner', ['Agent1']), owner: 'Owner', event: (...a) => events.push(a), metric: () => {}, log: () => {}, say: () => {}, stopAll: () => {}, profileChanged: () => {}, farms: () => [], ensureKit: async () => true, noDigMoves: () => ({}), digMoves: () => ({}), buildMoves: () => ({}) } }
  const m = makeModes(ctx)
  bot.give('bread', 8)
  bot.pathfinder.goto = async () => { throw new Error('No path') }
  let ticks = 0
  let steered = false
  bot.waitForTicks = async () => {
    steered = steered || bot.getControlState('forward')
    if (++ticks >= 3) bot.entity.isInLava = false
  }
  ctx.danger.update()
  const escape = m.get('escape')
  assert.equal(await escape.run({ cancelled: false }), 'done')
  assert.equal(steered, true)
  assert.ok(escape.retryAt <= Date.now(), 'no wait in the lava')
})

test('after a burn it will not dig at that spot for a while, then it may', () => {
  const { bot } = makeBot({ groundY: 63 })
  const t = 5000000
  markBurned(bot, new Vec3(5.5, 64, 5.5), t)
  assert.match(digHazard(bot, bot.blockAt(new Vec3(6, 63, 5)), t + 1000), /burned/)
  assert.equal(digHazard(bot, bot.blockAt(new Vec3(20, 63, 20)), t + 1000), null, 'somewhere else is fine')
  assert.equal(digHazard(bot, bot.blockAt(new Vec3(6, 63, 5)), t + 61000), null)
  assert.ok(lavaStepCost(bot, new Vec3(6, 64, 5), t + 1000) > 0, 'the path goes around it too')
})

test('retreating from a group, a creeper inside blast range is what it runs from, even with a skeleton nearer', () => {
  const { bot } = makeBot({ groundY: 63 })
  const { a } = assessor(bot)
  bot.health = 3
  mob(bot, 1, 'skeleton', 2.5, 64, 0.5)
  const c = mob(bot, 2, 'creeper', 0.5, 64, 4.7)
  a.update()
  assert.ok(a.report.flee, 'low health: it runs')
  assert.equal(a.report.flee.from.entity, c)
})

test('retreating with the creeper out of blast range still runs from the nearest', () => {
  const { bot } = makeBot({ groundY: 63 })
  const { a } = assessor(bot)
  bot.health = 3
  const s = mob(bot, 1, 'skeleton', 2.5, 64, 0.5)
  mob(bot, 2, 'creeper', 0.5, 64, 12.5)
  a.update()
  assert.equal(a.report.flee?.from?.entity, s)
})

test('mobs in a cave under solid ground are not a threat: no fight, no flee, no back off', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  overCave(world)
  const { a } = assessor(bot)
  bot.health = 5
  mob(bot, 1, 'zombie', 0.5, 54, 0.5)
  mob(bot, 2, 'zombie', 2.5, 54, 0.5)
  mob(bot, 3, 'creeper', 0.5, 54, 2.5)
  a.update()
  assert.equal(a.report.fight, null)
  assert.equal(a.report.flee, null)
  assert.equal(a.report.avoid, null)
  assert.equal(a.report.total, 0)
  assert.ok(a.report.dangers.filter(x => x.entity).every(x => x.sealed), 'it still knows they are there')
})

test('a crowd of six in the cave below does not set off a retreat on the first look', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  overCave(world)
  const { a } = assessor(bot)
  bot.health = 5
  for (let i = 0; i < 6; i++) mob(bot, i + 1, 'zombie', i - 2.5, 54, 1.5)
  a.update()
  assert.equal(a.report.flee, null)
  assert.equal(a.report.fight, null)
  assert.equal(a.report.total, 0)
})

test('a zombie close under a thin floor is sealed off until the bot starts breaking that floor', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  world.fill3(new Vec3(-4, 60, -4), new Vec3(4, 62, 4), 'air')
  const { a } = assessor(bot)
  mob(bot, 1, 'zombie', 0.5, 60, 0.5)
  a.update()
  assert.equal(a.report.fight, null, 'the floor is whole')
  bot.targetDigBlock = bot.blockAt(new Vec3(0, 63, 0))
  a.update()
  assert.ok(a.report.dangers.find(x => x.entity)?.active, 'breaking the floor opens the way')
})

test('a mob with an open way up to the bot is still a threat', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  world.fill3(new Vec3(-4, 58, -4), new Vec3(4, 61, 4), 'air')
  world.fill3(new Vec3(2, 62, 0), new Vec3(2, 63, 0), 'air')  // a shaft from the cave to the surface beside the bot
  const { a } = assessor(bot)
  const z = mob(bot, 1, 'zombie', 2.5, 60, 0.5)
  assert.equal(sealedOff(bot, z), false)
  a.update()
  assert.equal(a.report.dangers.find(x => x.entity)?.sealed, false)
})

test('a skeleton that can see the bot through a gap counts even with no walking route', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  world.fill3(new Vec3(-4, 58, -4), new Vec3(4, 61, 4), 'air')
  // two holes that meet only at a corner: an arrow's line fits through, a walking mob does not
  world.set(new Vec3(0, 63, 0), 'air')
  world.set(new Vec3(1, 62, 0), 'air')
  const { a } = assessor(bot)
  const s = mob(bot, 1, 'skeleton', 1.5, 58.72, 0.5)
  assert.equal(sealedOff(bot, s), true, 'no way on foot')
  a.update()
  const seen = a.report.dangers.find(x => x.entity === s)
  assert.equal(seen.sealed, false, 'it has a shot')
  assert.equal(seen.active, true)
})

test('a skeleton behind solid ground with no line of sight is sealed off', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  overCave(world)
  const { a } = assessor(bot)
  const s = mob(bot, 1, 'skeleton', 0.5, 54, 0.5)
  a.update()
  assert.equal(a.report.dangers.find(x => x.entity === s).sealed, true)
  assert.equal(a.report.fight, null)
})

test('a mob that hit the bot is never written off as sealed', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  world.fill3(new Vec3(-4, 60, -4), new Vec3(4, 62, 4), 'air')
  const { a, clock } = assessor(bot)
  const z = mob(bot, 1, 'zombie', 0.5, 62, 0.5)
  a.update()
  clock.add(200)
  bot.health = 15
  a.update()
  const seen = a.report.dangers.find(x => x.entity === z)
  assert.equal(seen.sealed, false)
  assert.equal(seen.active, true)
})

test('a flying mob is not sealed by the ground rule', () => {
  const { bot, world } = makeBot({ groundY: 63 })
  overCave(world)
  const p = mob(bot, 1, 'phantom', 0.5, 54, 0.5)
  assert.equal(sealedOff(bot, p), false)
})
