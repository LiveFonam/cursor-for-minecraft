// How the bot moves and looks, on the real game physics and the real pathfinder (test/physicsbot.js). Each test
// reproduces something a person saw through the bot's camera: a stop on every stair, half broken ore, head snaps.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { makePhysicsBot, carveStairs, carveTunnel } = require('./physicsbot')
const { FakeWorld, makeBot } = require('./mockbot')
const { Mode, ModeManager } = require('../modes')
const { guardHazards } = require('../skills/move')
const { mineJob, walkOntoDrops, stepInto } = require('../skills/mine')
const { pathRuns } = require('../skills/mine_branch')
const { MotionRecorder, sceneCommands, args } = require('../tools/motion_probe')
const {
  installMotion, setFreeAim, walkCells, holdForDig, straightenPath, clearLine, headroom, nextTurnStep,
  seesBlock, inPickupBox, pickupSpot, preAim,
  TURN_MAX, DIG_AIM, JUMP_RISE, DIG_FINISH_MS
} = require('../skills/motion')

const human = { level: 'off', placesTorches: true, nextTorchGap: () => 3, idleMoment: async () => {}, lookAtPoint: async () => {}, lookAround: async () => {}, detourPoint: () => null }
const deg = r => (r * 180) / Math.PI

function stairsBot (going = 'up', { motion = true, steps = 20 } = {}) {
  const world = new FakeWorld({ groundY: 80 })
  const cells = carveStairs(world, new Vec3(0, 70, 0), steps)
  const route = going === 'up' ? cells.slice().reverse() : cells
  const h = makePhysicsBot({ world, pos: route[0].offset(0.5, 0, 0.5) })
  guardHazards(h.bot, h.moves)
  if (motion) installMotion(h.bot)
  return { ...h, route, end: route[route.length - 1] }
}

const goalAt = c => new goals.GoalBlock(c.x, c.y, c.z)

test('stairs: the plain pathfinder stops on every step, because it jumps under the lower step and loses the jump', async () => {
  const h = stairsBot('up', { motion: false })
  await h.until(() => h.bot.entity.onGround, 40)
  await h.drive(h.bot.pathfinder.goto(goalAt(h.end)), 3000)
  const r = h.report()
  assert.ok(r.pauses >= 15, `${r.pauses} stops on 20 steps`)
  assert.ok(r.seconds > 15, `${r.seconds} s`)
})

test('stairs: with the jump timed for the ceiling it walks up without a single stop, in half the time', async () => {
  const h = stairsBot('up')
  await h.until(() => h.bot.entity.onGround, 40)
  await h.drive(h.bot.pathfinder.goto(goalAt(h.end)), 3000)
  const r = h.report()
  assert.equal(h.bot.entity.position.floored().toString(), h.end.toString())
  assert.equal(r.pauses, 0, JSON.stringify(r))
  assert.ok(r.seconds < 11, `${r.seconds} s`)
  assert.equal(r.jumps, 20, 'one clean jump per step')
  assert.equal(r.replans, 1)
})

test('stairs: walking its own staircase needs no path search, up or down', async () => {
  for (const going of ['up', 'down']) {
    const h = stairsBot(going)
    await h.until(() => h.bot.entity.onGround, 40)
    assert.equal(await h.drive(walkCells(h.bot, h.route, null), 3000), true)
    const r = h.report()
    assert.equal(h.bot.entity.position.floored().toString(), h.end.toString(), going)
    assert.equal(r.pauses, 0, `${going} ${JSON.stringify(r)}`)
    assert.equal(r.replans, 0, going)
    assert.ok(r.seconds < 11, `${going} ${r.seconds} s`)
    assert.ok(r.longestStillS <= 0.25, `${going} ${r.longestStillS} s`)
  }
})

test('the room above its head counts every column its body is in', () => {
  const world = new FakeWorld({ groundY: 80 })
  const cells = carveStairs(world, new Vec3(0, 70, 0), 3)
  const h = makePhysicsBot({ world, pos: cells[2].offset(0.5, 0, 0.5) })
  installMotion(h.bot)
  assert.ok(headroom(h.bot) >= JUMP_RISE, 'in the middle of a step')
  // its back half still under the lower step
  h.bot.entity.position = new Vec3(0.5, cells[2].y, cells[2].z + 0.85)
  assert.ok(headroom(h.bot) < JUMP_RISE)
})

test('a tunnel of known cells is walked at a sprint without a stop or a turn of the camera', async () => {
  const world = new FakeWorld({ groundY: 80 })
  const cells = carveTunnel(world, new Vec3(0, 70, 0), 30)
  const h = makePhysicsBot({ world, pos: cells[0].offset(0.5, 0, 0.5), yaw: Math.PI })
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 40)
  await h.drive(walkCells(h.bot, cells, null), 2000)
  const r = h.report()
  assert.equal(r.pauses, 0)
  assert.ok(r.seconds < 6.5, `${r.seconds} s for 30 blocks`)
  assert.ok(r.maxCameraStepDeg < 2, `camera ${r.maxCameraStepDeg} degrees in a tick`)
})

test('no sprint when the food bar is too low for one', async () => {
  const world = new FakeWorld({ groundY: 80 })
  const cells = carveTunnel(world, new Vec3(0, 70, 0), 12)
  const h = makePhysicsBot({ world, pos: cells[0].offset(0.5, 0, 0.5), yaw: Math.PI, food: 6 })
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 40)
  let sprinted = false
  h.bot.on('physicsTick', () => { sprinted = sprinted || h.bot.getControlState('sprint') })
  await h.drive(walkCells(h.bot, cells, null), 2000)
  assert.equal(sprinted, false)
})

test('a cell walk that cannot get through says so, so the caller can use the pathfinder', async () => {
  const world = new FakeWorld({ groundY: 80 })
  const cells = carveTunnel(world, new Vec3(0, 70, 0), 8)
  world.set(cells[4], 'stone')
  world.set(cells[4].offset(0, 1, 0), 'stone')
  const h = makePhysicsBot({ world, pos: cells[0].offset(0.5, 0, 0.5) })
  installMotion(h.bot)
  await assert.rejects(h.drive(walkCells(h.bot, cells, null), 600), /stalled/)
  assert.equal(h.bot.getControlState('forward'), false, 'the keys are let go')
})

test('a cancelled cell walk ends at once with the keys let go', async () => {
  const world = new FakeWorld({ groundY: 80 })
  const cells = carveTunnel(world, new Vec3(0, 70, 0), 20)
  const h = makePhysicsBot({ world, pos: cells[0].offset(0.5, 0, 0.5) })
  installMotion(h.bot)
  const token = { cancelled: false }
  const walk = walkCells(h.bot, cells, token)
  await h.until(() => h.bot.entity.position.z > 4, 200)
  token.cancelled = true
  assert.equal(await h.drive(walk, 40), false)
  assert.equal(h.bot.getControlState('forward'), false)
})

test('paths are shortened to straight lines on open ground', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  guardHazards(h.bot, h.moves)
  await h.until(() => h.bot.entity.onGround, 20)
  const result = h.bot.pathfinder.getPathTo(h.moves, new goals.GoalBlock(9, 81, 5))
  const before = result.path.length
  const removed = straightenPath(h.bot, h.moves, result.path, h.bot.entity.position)
  assert.ok(removed >= 5, `${removed} of ${before} nodes`)
  assert.equal(result.path[result.path.length - 1].x, 9.5)
  assert.equal(result.path[result.path.length - 1].z, 5.5)
})

test('a straight line never crosses a wall, a hole, magma, or a node that digs', () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  guardHazards(h.bot, h.moves)
  const a = new Vec3(0.5, 81, 0.5)
  const b = new Vec3(6.5, 81, 0.5)
  assert.equal(clearLine(h.bot, h.moves, a, b), true)
  h.world.set(new Vec3(3, 81, 0), 'stone')
  assert.equal(clearLine(h.bot, h.moves, a, b), false, 'a wall')
  h.world.set(new Vec3(3, 81, 0), 'air')
  h.world.set(new Vec3(3, 80, 0), 'air')
  assert.equal(clearLine(h.bot, h.moves, a, b), false, 'a hole')
  h.world.set(new Vec3(3, 80, 0), 'magma_block')
  assert.equal(clearLine(h.bot, h.moves, a, b), false, 'magma')
  h.world.set(new Vec3(3, 80, 0), 'grass_block')
  h.world.set(new Vec3(3, 81, 0), 'water')
  assert.equal(clearLine(h.bot, h.moves, a, b), false, 'water')
  h.world.set(new Vec3(3, 81, 0), 'air')
  const node = (x, toBreak = []) => Object.assign(new Vec3(x, 81, 0.5), { toBreak, toPlace: [] })
  const path = [node(1.5), node(2.5), node(3.5, [{ x: 3, y: 81, z: 0 }]), node(4.5), node(5.5)]
  straightenPath(h.bot, h.moves, path, a)
  assert.ok(path.some(n => n.toBreak.length), 'the node that digs stays')
})

test('the camera turn speeds up, slows down and has a top speed', () => {
  let step = 0
  let error = Math.PI
  const steps = []
  for (let i = 0; i < 60 && error > 0.001; i++) {
    step = nextTurnStep(error, step)
    const moved = Math.min(step, error)
    steps.push(moved)
    error -= moved
  }
  assert.ok(Math.max(...steps) <= TURN_MAX + 1e-9)
  assert.ok(steps[0] < steps[2], 'it speeds up')
  assert.ok(steps[steps.length - 2] < TURN_MAX / 2, 'it slows down')
  assert.ok(steps.length < 30, `${steps.length} ticks for half a turn`)
})

test('a forced look is eased, and it resolves only once the camera is there', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  h.setCounting(true)
  await h.drive(h.bot.look(Math.PI * 0.9, -0.5, true), 80)
  const r = h.report()
  assert.ok(r.maxCameraStepDeg <= deg(TURN_MAX) * 1.35, `${r.maxCameraStepDeg} degrees in a tick`)
  const c = h.camera()
  assert.ok(Math.abs(Math.atan2(Math.sin(c.yaw - Math.PI * 0.9), Math.cos(c.yaw - Math.PI * 0.9))) < 0.03, 'aim is accurate')
  assert.ok(Math.abs(c.pitch + 0.5) < 0.03)
})

test('in a fight the camera is the network\'s: a forced look lands in the same tick, and the speeds go back', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  setFreeAim(h.bot, true)
  assert.equal(h.bot.physics.yawSpeed, 3)
  await h.bot.look(2.5, 0.4, true)
  h.tick()
  // to Mineflayer's own look step, 0.15 degrees
  assert.ok(Math.abs(h.camera().yaw - 2.5) < 0.003, 'exact and instant')
  setFreeAim(h.bot, false)
  await h.drive(h.bot.look(-1, 0, true), 60)
  assert.ok(Math.abs(Math.atan2(Math.sin(h.camera().yaw + 1), Math.cos(h.camera().yaw + 1))) < 0.03)
})

test('burning or in lava, a forced look stays instant, so a water bucket lands in time', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  h.bot.entity.metadata = { 0: 0x01 }
  await h.bot.look(1.2, -Math.PI / 2 + 0.01, true)
  h.tick()
  assert.ok(Math.abs(h.camera().pitch + Math.PI / 2 - 0.01) < 0.003)
})

test('the end of a walk does not teleport the bot to the middle of its block', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  let last = h.bot.entity.position.clone()
  let biggest = 0
  h.bot.on('move', () => {
    biggest = Math.max(biggest, Math.hypot(h.bot.entity.position.x - last.x, h.bot.entity.position.z - last.z))
    last = h.bot.entity.position.clone()
  })
  await h.drive(h.bot.pathfinder.goto(new goals.GoalBlock(12, 81, 7)), 1200)
  await h.until(() => false, 12)
  assert.ok(biggest < 0.45, `${biggest.toFixed(3)} blocks in one tick`)
})

test('a walk that ends off centre stays where it is, the pathfinder would have moved it to the middle at once', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.82, 81, 0.5) })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  await h.drive(h.bot.pathfinder.goto(new goals.GoalBlock(0, 81, 0)), 40)
  await h.until(() => false, 4)
  assert.ok(Math.abs(h.bot.entity.position.x - 0.82) < 0.02, `at ${h.bot.entity.position.x}`)
  assert.ok(h.bot.motion.stats.snapsAvoided >= 1)
})

// a mode manager with a gather job digging and a meal or a fight that wants control
function modeScene (wanting) {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  installMotion(h.bot)
  const job = new Mode('gather')
  job.profile = 'gather'
  let exits = 0
  job.exit = () => { exits++; h.bot.stopDigging() }
  const other = new Mode(wanting)
  other.profile = 'survive'
  other.wants = () => other.want === true
  other.always = true
  const m = new ModeManager([other, job], { holdControl: (a, c) => holdForDig(h.bot, c?.name, { fireOnly: other.fire === true }) })
  job.start()
  m.tick()
  h.bot.on('physicsTick', () => m.tick())
  return { h, m, job, other, exits: () => exits }
}

test('a meal waits for the block being broken, so ore is never left half broken', async () => {
  const s = modeScene('eat')
  s.h.bot.give('stone_pickaxe', 1)
  await s.h.bot.equip(s.h.bot.inventory.items()[0], 'hand')
  const ore = new Vec3(2, 81, 0)
  s.h.world.set(ore, 'iron_ore')
  await s.h.until(() => s.h.bot.entity.onGround, 10)
  const dig = s.h.bot.dig(s.h.world.get(ore), true)
  await s.h.until(() => !!s.h.bot.targetDigBlock, 20)
  s.other.want = true
  await s.h.drive(dig, 80)
  assert.equal(s.h.digs.canceled, 0)
  assert.equal(s.h.digs.finished, 1)
  assert.equal(s.h.world.name(ore), 'air')
  await s.h.until(() => s.m.active === s.other, 5)
  assert.equal(s.m.active, s.other, 'then it eats')
})

test('being on fire waits for a dig too, lava and low health do not', () => {
  const h = makePhysicsBot({ groundY: 80 })
  installMotion(h.bot)
  h.bot.targetDigBlock = {}
  h.bot.motion.digEndsAt = Date.now() + 1000
  assert.equal(holdForDig(h.bot, 'eat'), true)
  assert.equal(holdForDig(h.bot, 'escape', { fireOnly: true }), true, 'fire with a second left')
  assert.equal(holdForDig(h.bot, 'escape', { fireOnly: false }), false, 'lava')
  assert.equal(holdForDig(h.bot, 'mobfight'), false, 'a mob, with a second left')
  h.bot.health = 5
  assert.equal(holdForDig(h.bot, 'eat'), false, 'low health')
  h.bot.health = 20
  h.bot.motion.digEndsAt = Date.now() + 200
  assert.equal(holdForDig(h.bot, 'mobfight'), true, 'a mob, with the block about to break')
  h.bot.motion.digEndsAt = Date.now() + DIG_FINISH_MS + 500
  assert.equal(holdForDig(h.bot, 'eat'), false, 'a very slow block never holds a meal up')
  h.bot.targetDigBlock = null
  assert.equal(holdForDig(h.bot, 'eat'), false, 'nothing being dug')
})

test('a fight takes over from a long dig at once', async () => {
  const s = modeScene('mobfight')
  s.h.bot.give('wooden_pickaxe', 1)
  await s.h.bot.equip(s.h.bot.inventory.items()[0], 'hand')
  const ore = new Vec3(2, 81, 0)
  s.h.world.set(ore, 'obsidian')
  await s.h.until(() => s.h.bot.entity.onGround, 10)
  const dig = s.h.bot.dig(s.h.world.get(ore), true).catch(e => e.message)
  await s.h.until(() => !!s.h.bot.targetDigBlock, 20)
  s.other.want = true
  await s.h.until(() => s.m.active === s.other, 6)
  assert.equal(s.m.active, s.other)
  assert.equal(await s.h.drive(dig, 20), 'Digging aborted')
})

test('a dig starts before the camera has finished its turn, and the turn carries on while it breaks', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5), yaw: 0 })
  installMotion(h.bot)
  h.bot.give('stone_pickaxe', 1)
  await h.bot.equip(h.bot.inventory.items()[0], 'hand')
  await h.until(() => h.bot.entity.onGround, 10)
  // a block behind it: half a turn away
  const ore = new Vec3(0, 81, 2)
  h.world.set(ore, 'iron_ore')
  let startedAt = null
  let cameraAtStart = null
  let t = 0
  h.bot.on('physicsTick', () => {
    t++
    if (h.bot.targetDigBlock && startedAt === null) { startedAt = t; cameraAtStart = h.camera().yaw }
  })
  await h.drive(h.bot.dig(h.world.get(ore), true), 120)
  const off = Math.abs(Math.atan2(Math.sin(cameraAtStart - Math.PI), Math.cos(cameraAtStart - Math.PI)))
  assert.ok(off <= DIG_AIM + TURN_MAX, `the camera was ${off.toFixed(2)} radians off when the dig started`)
  assert.ok(off > 0.02, 'it did not wait for the turn to finish')
  assert.ok(startedAt <= 26, `the dig started on tick ${startedAt}`)
  assert.ok(h.report().maxCameraStepDeg <= deg(TURN_MAX) * 1.35, 'never a snap')
  assert.equal(h.digs.canceled, 0)
})

test('it walks straight onto a drop and picks it up, with no wait first', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  h.bot.entities[7] = { id: 7, name: 'item', position: new Vec3(4.5, 81.1, 0.5), drop: 'raw_iron' }
  await h.drive(walkOntoDrops(h.bot, new Vec3(4.5, 81.5, 0.5), { cancelled: false }), 120)
  assert.equal(h.bot.countOf('raw_iron'), 1)
  assert.equal(h.report().pauses, 0)
  assert.equal(h.bot.getControlState('forward'), false, 'the key is let go')
})

test('with nothing dropped it moves on within half a second', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  installMotion(h.bot)
  let ticks = 0
  h.bot.on('physicsTick', () => ticks++)
  await h.drive(walkOntoDrops(h.bot, new Vec3(3.5, 81.5, 0.5), { cancelled: false }), 40)
  assert.ok(ticks <= 11, `${ticks} ticks`)
})

test('stepping into a tunnel cell does not wait for the camera', async () => {
  const world = new FakeWorld({ groundY: 80 })
  const cells = carveTunnel(world, new Vec3(0, 70, 0), 3)
  const h = makePhysicsBot({ world, pos: cells[0].offset(0.5, 0, 0.5), yaw: 0 })
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  let ticks = 0
  h.bot.on('physicsTick', () => ticks++)
  await h.drive(stepInto(h.bot, cells[1], { cancelled: false }), 40)
  assert.ok(ticks <= 12, `${ticks} ticks for one block, with a half turn first`)
})

test('its path is cut into stretches of touching cells, with a gap wherever a cave walk or a drop was', () => {
  const v = (x, y, z) => new Vec3(x, y, z)
  const runs = pathRuns([v(0, 10, 0), v(0, 10, 1), v(0, 9, 2), v(5, 9, 9), v(5, 9, 10), v(5, 5, 11)])
  assert.deepEqual(runs.map(r => r.length), [3, 2, 1])
})

test('mining a seam of ore across a room: every dig finishes, none is cancelled, and the drops are in the bag', async () => {
  const world = new FakeWorld({ groundY: 80 })
  world.fill3(new Vec3(-3, 16, 0), new Vec3(3, 18, 9), 'air')
  for (const x of [-2, -1, 0, 2]) world.set(new Vec3(x, 16, 10), 'iron_ore')
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 16, 1.5), yaw: Math.PI })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  h.bot.give('stone_pickaxe', 1)
  h.bot.give('oak_planks', 4)
  h.bot.give('cobblestone', 8)
  h.bot.world.raycast = (from, dir, range) => {
    for (let t = 0; t <= range; t += 0.05) {
      const p = from.plus(dir.scaled(t)).floored()
      if (world.get(p).boundingBox === 'block') return { position: p, face: 0 }
    }
    return null
  }
  await h.until(() => h.bot.entity.onGround, 10)
  const job = { block: 'iron', blocks: ['iron_ore'], count: 4, mined: 0, strategy: 'branch', home: null, store: false, tuning: { branchLen: 0 } }
  const token = { cancelled: false }
  const r = await h.drive(mineJob(h.bot, job, human, token, {}), 2400)
  assert.equal(r.result, 'done', r.message)
  assert.equal(h.bot.countOf('raw_iron'), 4)
  assert.equal(h.digs.canceled, 0, 'no dig was cut short')
  assert.equal(h.digs.started, h.digs.finished)
  assert.equal(h.bot.motion.stats.digCanceled, 0)
  assert.ok(h.report().maxCameraStepDeg <= deg(TURN_MAX) * 1.35, `camera ${h.report().maxCameraStepDeg} degrees in a tick`)
})

// The real probe's room, block for block: 6 ore along the far wall, on two heights, with Mineflayer's own sight check
function probeRoom () {
  const at = [2000, 140, 2000]
  const [x, y, z] = at
  const scene = sceneCommands(at)
  const world = new FakeWorld({ groundY: 62 })
  world.fill3(new Vec3(x + 6, y - 8, z - 2), new Vec3(x + 14, y + 4, z + 13), 'stone')
  world.fill3(new Vec3(scene.room.x - 2, y, z), new Vec3(scene.room.x + 3, y + 2, z + 9), 'air')
  for (const o of scene.ores) world.set(new Vec3(...o), 'iron_ore')
  const h = makePhysicsBot({ world, realSight: true, pos: new Vec3(scene.room.x + 0.5, y, z + 1.5), yaw: 0 })
  h.moves.canDig = true
  h.moves.liquidCost = 50
  h.moves.maxDropDown = 3
  guardHazards(h.bot, h.moves)
  return { h, world, scene, y, z }
}

test('Mineflayer\'s sight check misses ore in plain view, seesBlock finds all of it, and buried ore stays hidden', () => {
  const { h, world, scene, y, z } = probeRoom()
  const ores = scene.ores.map(o => world.get(new Vec3(...o)))
  const mineflayer = ores.filter(b => h.bot.canSeeBlock(b)).length
  assert.ok(mineflayer < 6, `Mineflayer sees ${mineflayer} of 6`)
  assert.equal(ores.filter(b => seesBlock(h.bot, b)).length, 6)
  // a block behind the wall, and one with no open face at all
  world.set(new Vec3(scene.room.x, y, z + 12), 'iron_ore')
  assert.equal(seesBlock(h.bot, world.get(new Vec3(scene.room.x, y, z + 12))), false, 'no X-ray')
})

test('the probe\'s row of 6 ore: mined in one sweep with every drop in the bag, nothing else dug and no stop', async () => {
  const { h, world, scene } = probeRoom()
  installMotion(h.bot)
  h.bot.give('stone_pickaxe', 1)
  h.bot.give('oak_planks', 4)
  await h.until(() => h.bot.entity.onGround, 40)
  const job = { block: 'iron', blocks: ['iron_ore'], count: 6, mined: 0, strategy: 'branch', home: null, store: false, tuning: { branchLen: 0 } }
  const r = await h.drive(mineJob(h.bot, job, { ...human, level: 'light' }, { cancelled: false }, {}), 1200)
  assert.equal(r.result, 'done', r.message)
  assert.equal(scene.ores.filter(o => world.name(new Vec3(...o)) === 'iron_ore').length, 0)
  assert.equal(h.bot.countOf('raw_iron'), 6)
  assert.deepEqual([h.digs.started, h.digs.finished, h.digs.canceled], [6, 6, 0])
  const rep = h.report()
  assert.ok(rep.longestStillS <= 0.25, JSON.stringify(rep))
  assert.ok(rep.seconds < 20, `${rep.seconds} s`)
  assert.ok(rep.maxCameraStepDeg <= deg(TURN_MAX) * 1.35, `camera ${rep.maxCameraStepDeg} degrees in a tick`)
})

test('a drop in a hole in the wall is picked up from the cell in front of it, without digging or building', async () => {
  const world = new FakeWorld({ groundY: 80 })
  world.fill3(new Vec3(-3, 70, 0), new Vec3(3, 72, 6), 'air')
  world.set(new Vec3(0, 71, 7), 'air')  // the hole an ore at head height left
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 70, 2.5) })
  guardHazards(h.bot, h.moves)
  h.moves.canDig = true
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  h.bot.entities[7] = { id: 7, name: 'item', position: new Vec3(0.5, 71.1, 7.5), drop: 'raw_iron' }
  await h.drive(walkOntoDrops(h.bot, new Vec3(0.5, 71.5, 7.5), { cancelled: false }), 160)
  assert.equal(h.bot.countOf('raw_iron'), 1)
  assert.equal(h.digs.started, 0)
  assert.equal(h.bot.entity.position.floored().z, 6, 'it stays in the room')
})

test('the spot to fetch a drop from keeps the whole body in its cell, and a walled off drop has none', () => {
  const world = new FakeWorld({ groundY: 80 })
  world.fill3(new Vec3(-3, 70, 0), new Vec3(3, 72, 6), 'air')
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 70, 2.5) })
  guardHazards(h.bot, h.moves)
  const spot = pickupSpot(h.bot, h.moves, new Vec3(0.5, 70.1, 7.5))
  assert.ok(spot && spot.z + 0.3 < 7, `spot ${spot}`)
  assert.ok(inPickupBox(spot, new Vec3(0.5, 70.1, 7.5)))
  assert.equal(pickupSpot(h.bot, h.moves, new Vec3(0.5, 70.1, 12.5)), null)
})

test('the pickup box is the game\'s: the live server handed over an item 1.39 blocks away, and the item\'s own width counts', () => {
  assert.ok(inPickupBox(new Vec3(2010.4, 140, 2008.96), new Vec3(2010.13, 140, 2010.35)))
  assert.ok(inPickupBox(new Vec3(0.5, 70, 0.5), new Vec3(0.5, 69.3, 0.5)))
  assert.ok(!inPickupBox(new Vec3(0.5, 70, 0.5), new Vec3(2, 70, 0.5)))
})

test('a drop that rolled to the back of a one block wall hole is collected from the cell in front of it', async () => {
  const world = new FakeWorld({ groundY: 80 })
  world.fill3(new Vec3(-3, 70, 0), new Vec3(3, 72, 6), 'air')
  world.set(new Vec3(0, 70, 7), 'air')  // the hole an ore at foot height left, with stone above it
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 70, 2.5) })
  guardHazards(h.bot, h.moves)
  h.moves.canDig = true
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  // where the live server left it: against the back and side of the hole
  const drop = new Vec3(0.13, 70, 7.88)
  assert.ok(pickupSpot(h.bot, h.moves, drop), 'there is a spot in front of the hole')
  h.bot.entities[7] = { id: 7, name: 'item', position: drop, drop: 'raw_iron' }
  await h.drive(walkOntoDrops(h.bot, new Vec3(0.5, 70.5, 7.5), { cancelled: false }, { settled: true }), 160)
  assert.equal(h.bot.countOf('raw_iron'), 1)
  assert.equal(h.digs.started, 0)
})

test('a drop it cannot reach does not end the pickup: the others are still collected, within a time limit', async () => {
  const world = new FakeWorld({ groundY: 80 })
  world.fill3(new Vec3(-3, 70, 0), new Vec3(3, 72, 6), 'air')
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 70, 5.5) })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  // the nearest one is sealed behind the wall, the other lies in the open
  h.bot.entities[7] = { id: 7, name: 'item', position: new Vec3(0.5, 70.1, 8.6), drop: 'coal' }
  h.bot.entities[8] = { id: 8, name: 'item', position: new Vec3(-2.5, 70.1, 2.5), drop: 'raw_iron' }
  await h.drive(walkOntoDrops(h.bot, new Vec3(-0.5, 70.5, 5), { cancelled: false }, { settled: true }), 400)
  assert.equal(h.bot.countOf('raw_iron'), 1, 'the reachable drop is in the bag')
  assert.equal(h.bot.countOf('coal'), 0)
  assert.ok(h.bot.entities[7], 'the sealed drop stays where it is')
})

test('an older drop collected first does not end the pickup before the last block\'s own drop has landed', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  // as in the live run: the drop of the block before is in reach, and this block's drop lands two ticks later
  h.bot.entities[7] = { id: 7, name: 'item', position: new Vec3(1.2, 81.1, 0.5), drop: 'raw_iron', readyAt: 0 }
  let ticks = 0
  const land = () => {
    if (++ticks !== 3) return
    h.bot.entities[8] = { id: 8, name: 'item', position: new Vec3(0.5, 81.1, 1.2), drop: 'raw_iron', readyAt: 0 }
  }
  h.bot.on('physicsTick', land)
  await h.drive(walkOntoDrops(h.bot, new Vec3(0.5, 81.5, 1.5), { cancelled: false }), 60)
  h.bot.removeListener('physicsTick', land)
  await h.drive(Promise.resolve(), 3)
  assert.equal(h.bot.countOf('raw_iron'), 2)
})

test('with its own drop already in the bag the pickup ends within 4 ticks, so it is no visible stop', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  h.bot.entities[7] = { id: 7, name: 'item', position: new Vec3(1.2, 81.1, 0.5), drop: 'raw_iron', readyAt: 0 }
  let ticks = 0
  const count = () => { ticks++ }
  h.bot.on('physicsTick', count)
  await h.drive(walkOntoDrops(h.bot, new Vec3(0.5, 81.5, 1.5), { cancelled: false }), 30)
  h.bot.removeListener('physicsTick', count)
  assert.equal(h.bot.countOf('raw_iron'), 1)
  assert.ok(ticks <= 5, `took ${ticks} ticks`)
})

test('a pickaxe that breaks during a dig cancels it, so the client never marks a block gone that the server still has', async () => {
  const world = new FakeWorld({ groundY: 80 })
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 81, 0.5) })
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  h.bot.give('stone_pickaxe', 1)
  h.bot.heldItem = h.bot.inventory.items().find(i => i.name === 'stone_pickaxe')
  const at = new Vec3(1, 81, 0)
  world.set(at, 'stone')
  const digging = h.bot.dig(world.get(at), true)
  const result = digging.then(() => 'finished', e => e.message)
  await h.until(() => !!h.bot.targetDigBlock, 40)
  h.bot.heldItem = null
  h.bot.emit('heldItemChanged', null)
  await h.drive(result, 10)
  assert.match(await result, /tool in hand/)
  assert.equal(world.name(at), 'stone')
  assert.equal(h.digs.canceled, 1)
})

test('the same pickaxe wearing down during a dig does not cancel it', async () => {
  const world = new FakeWorld({ groundY: 80 })
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 81, 0.5) })
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  h.bot.give('stone_pickaxe', 1)
  h.bot.heldItem = h.bot.inventory.items().find(i => i.name === 'stone_pickaxe')
  const at = new Vec3(1, 81, 0)
  world.set(at, 'stone')
  const digging = h.bot.dig(world.get(at), true)
  await h.until(() => !!h.bot.targetDigBlock, 40)
  h.bot.emit('heldItemChanged', h.bot.heldItem)
  await h.drive(digging, 80)
  assert.equal(world.name(at), 'air')
  assert.equal(h.digs.canceled, 0)
})

test('a goal that moves a little mid walk keeps the path, adds the last step, and the walk never lets go of the key', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5), yaw: Math.PI })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  const first = h.bot.pathfinder.goto(new goals.GoalBlock(0, 81, 24)).catch(e => e.name)
  await h.until(() => h.bot.entity.position.z > 8, 200)
  let released = 0
  h.bot.on('physicsTick', () => { if (!h.bot.getControlState('forward') && h.bot.pathfinder.isMoving()) released++ })
  await h.drive(h.bot.pathfinder.goto(new goals.GoalBlock(0, 81, 25)), 400)
  assert.equal(await first, 'GoalChanged')
  assert.equal(h.bot.entity.position.floored().z, 25)
  assert.equal(h.bot.motion.stats.pathsReused, 1)
  assert.equal(h.bot.motion.stats.pathsExtended, 1)
  assert.equal(released, 0)
  assert.equal(h.report().pauses, 0)
})

test('a goal the old path already ends in needs no search at all', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5), yaw: Math.PI })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  const first = h.bot.pathfinder.goto(new goals.GoalBlock(0, 81, 20)).catch(() => {})
  await h.until(() => h.bot.entity.position.z > 5, 200)
  await h.drive(h.bot.pathfinder.goto(new goals.GoalNear(0, 81, 20, 1)), 400)
  await first
  assert.equal(h.bot.motion.stats.pathsReused, 1)
  assert.equal(h.bot.motion.stats.pathsExtended, 0)
})

test('while a new path is searched it walks on along its heading, and never over an edge', async () => {
  const world = new FakeWorld({ groundY: 80 })
  for (let x = -2; x <= 2; x++) for (let y = 70; y <= 80; y++) world.set(new Vec3(x, y, 9), 'air')  // a pit across the way
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 81, 0.5), yaw: Math.PI })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  h.bot.pathfinder.setGoal(new goals.GoalBlock(0, 81, 8))
  await h.until(() => h.bot.entity.position.z > 5, 200)
  h.bot.pathfinder.getPathTo = () => ({ status: 'partial', cost: 0, time: 0, visitedNodes: 0, generatedNodes: 0, path: [] })  // a search that takes its time
  const at = h.bot.entity.position.z
  h.bot.pathfinder.setGoal(new goals.GoalBlock(4, 81, 30))
  await h.until(() => false, 8)
  assert.ok(h.bot.entity.position.z > at + 0.8, `carried on from ${at} to ${h.bot.entity.position.z}`)
  assert.ok(h.bot.motion.stats.coastTicks >= 5)
  await h.until(() => false, 30)
  assert.equal(h.bot.getControlState('forward'), false, 'and stops when no path came')
  assert.ok(h.bot.entity.position.y > 80.9 && h.bot.entity.position.z < 9, `at ${h.bot.entity.position}`)
})

test('running from something never reuses the old path or carries on along the old heading', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5), yaw: Math.PI })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  h.bot.pathfinder.setGoal(new goals.GoalBlock(0, 81, 20))
  await h.until(() => h.bot.entity.position.z > 6, 200)
  h.bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalNear(0, 81, 14, 4)))
  assert.equal(h.bot.motion.coast, 0)
  await h.until(() => false, 3)
  assert.equal(h.bot.motion.stats.pathsReused, 0)
  h.bot.pathfinder.setGoal(null)
})

test('the next dig does not wait for a drop that a real server has not sent yet, and the drop is still collected', async () => {
  const world = new FakeWorld({ groundY: 80 })
  world.fill3(new Vec3(-3, 70, 0), new Vec3(3, 72, 6), 'air')
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 70, 5.5) })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  let ticks = 0
  const count = () => ticks++
  h.bot.on('physicsTick', count)
  await h.drive(walkOntoDrops(h.bot, new Vec3(0.5, 70.5, 7.5), { cancelled: false }, { digNext: true }), 20)
  h.bot.removeListener('physicsTick', count)
  assert.ok(ticks <= 1, `${ticks} ticks`)
  h.bot.entities[9] = { id: 9, name: 'item', position: new Vec3(0.5, 70.1, 7.5), drop: 'raw_iron', readyAt: 0 }
  await h.drive(walkOntoDrops(h.bot, new Vec3(0.5, 70.5, 7.5), { cancelled: false }, { settled: true }), 40)
  assert.equal(h.bot.countOf('raw_iron'), 1)
})

// A corridor three wide with a right angle, the walk's sharpest change of direction in one tick and its length
async function cornerWalk (motion) {
  const world = new FakeWorld({ groundY: 90 })
  world.fill3(new Vec3(9, 70, 13), new Vec3(11, 71, 24), 'air')
  world.fill3(new Vec3(9, 70, 22), new Vec3(16, 71, 24), 'air')
  const h = makePhysicsBot({ world, pos: new Vec3(10.5, 70, 14.5), yaw: Math.PI })
  h.moves.canDig = false
  guardHazards(h.bot, h.moves)
  if (motion) installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  let sharpest = 0
  let lastDir = null
  let walked = 0
  let last = h.bot.entity.position.clone()
  h.bot.on('physicsTick', () => {
    const p = h.bot.entity.position
    const dx = p.x - last.x
    const dz = p.z - last.z
    const step = Math.hypot(dx, dz)
    walked += step
    last = p.clone()
    if (step < 0.05) return
    const dir = Math.atan2(dx, dz)
    if (lastDir !== null) {
      const turn = Math.abs(Math.atan2(Math.sin(dir - lastDir), Math.cos(dir - lastDir)))
      if (turn > sharpest) sharpest = turn
    }
    lastDir = dir
  })
  await h.drive(h.bot.pathfinder.goto(new goals.GoalBlock(16, 70, 23)), 500)
  return { h, sharpest, walked, report: h.report() }
}

test('a corner is taken in a curve instead of a stop and a sharp turn', async () => {
  const plain = await cornerWalk(false)
  const flow = await cornerWalk(true)
  assert.equal(flow.h.bot.entity.position.floored().toString(), '(16, 70, 23)')
  assert.ok(flow.h.bot.motion.stats.cornersRounded >= 1)
  assert.equal(flow.report.pauses, 0)
  assert.ok(flow.sharpest < plain.sharpest, `sharpest turn ${deg(plain.sharpest).toFixed(0)} to ${deg(flow.sharpest).toFixed(0)} degrees`)
  assert.ok(flow.sharpest < 0.6, `${deg(flow.sharpest).toFixed(0)} degrees in one tick`)
  assert.ok(flow.walked < plain.walked, `${plain.walked.toFixed(1)} to ${flow.walked.toFixed(1)} blocks`)
})

test('in a one wide tunnel with a bend it still takes the bend without touching a wall or stopping', async () => {
  const world = new FakeWorld({ groundY: 90 })
  world.fill3(new Vec3(0, 70, 0), new Vec3(0, 71, 8), 'air')
  world.fill3(new Vec3(0, 70, 8), new Vec3(8, 71, 8), 'air')
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 70, 0.5), yaw: Math.PI })
  h.moves.canDig = false
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  await h.drive(h.bot.pathfinder.goto(new goals.GoalBlock(8, 70, 8)), 400)
  assert.equal(h.bot.entity.position.floored().toString(), '(8, 70, 8)')
  assert.equal(h.report().pauses, 0, JSON.stringify(h.report()))
})

test('a running jump across a gap is left to the pathfinder, and it lands', async () => {
  const world = new FakeWorld({ groundY: 80 })
  for (let x = -2; x <= 2; x++) for (let y = 74; y <= 80; y++) world.set(new Vec3(x, y, 6), 'air')
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 81, 0.5), yaw: Math.PI })
  h.moves.allowParkour = true
  h.moves.canDig = false
  h.moves.scafoldingBlocks = []
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  let lowest = 81
  h.bot.on('physicsTick', () => { lowest = Math.min(lowest, h.bot.entity.position.y) })
  await h.drive(h.bot.pathfinder.goto(new goals.GoalBlock(0, 81, 11)), 400)
  assert.equal(h.bot.entity.position.floored().toString(), '(0, 81, 11)')
  assert.ok(lowest > 80.5, `it fell to ${lowest}`)
})

test('an exact look made while the camera was leading ends on the exact spot, without waiting out its time limit', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5), yaw: 0 })
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  preAim(h.bot, new Vec3(3.5, 82.5, 0.5))
  await h.until(() => !!h.bot.motion.lead, 5)
  let ticks = 0
  const count = () => ticks++
  h.bot.on('physicsTick', count)
  await h.drive(h.bot.look(-1.2, 0.3, true), 40)
  h.bot.removeListener('physicsTick', count)
  assert.ok(ticks < 30, `${ticks} ticks`)
  assert.ok(Math.abs(Math.atan2(Math.sin(h.camera().yaw + 1.2), Math.cos(h.camera().yaw + 1.2))) < 0.03)
  assert.ok(Math.abs(h.camera().pitch - 0.3) < 0.03)
})

test('on the approach the camera turns sideways to the block while the body keeps to its line', async () => {
  const world = new FakeWorld({ groundY: 90 })
  world.fill3(new Vec3(0, 70, 0), new Vec3(0, 71, 12), 'air')
  const ore = new Vec3(1, 71, 10)
  world.set(ore, 'iron_ore')
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 70, 0.5), yaw: Math.PI })
  h.moves.canDig = false
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  h.bot.give('stone_pickaxe', 1)
  await h.bot.equip(h.bot.inventory.items()[0], 'hand')
  await h.until(() => h.bot.entity.onGround, 10)
  const centre = ore.offset(0.5, 0.5, 0.5)
  let offLine = 0
  h.bot.on('physicsTick', () => { offLine = Math.max(offLine, Math.abs(h.bot.entity.position.x - 0.5)) })
  preAim(h.bot, centre)
  await h.drive(h.bot.pathfinder.goto(new goals.GoalBlock(0, 70, 10)), 300)
  await h.until(() => false, 3)
  const c = h.camera()
  const eye = h.bot.entity.position.offset(0, 1.62, 0)
  const d = centre.minus(eye)
  const off = Math.abs(Math.atan2(Math.sin(c.yaw - Math.atan2(-d.x, -d.z)), Math.cos(c.yaw - Math.atan2(-d.x, -d.z))))
  assert.ok(off < 0.1, `the camera is ${off.toFixed(2)} radians off the block when it arrives`)
  assert.ok(offLine < 0.25, `the body left its line by ${offLine.toFixed(2)}`)
  let waited = 0
  const counter = () => waited++
  h.bot.on('physicsTick', counter)
  const dig = h.bot.dig(h.world.get(ore), true)
  preAim(h.bot, null)
  await h.until(() => !!h.bot.targetDigBlock, 10)
  h.bot.removeListener('physicsTick', counter)
  assert.ok(waited <= 1, `the dig waited ${waited} ticks for the camera`)
  await h.drive(dig, 60)
  assert.ok(h.report().maxCameraStepDeg <= deg(TURN_MAX) * 1.35, `camera ${h.report().maxCameraStepDeg} degrees in a tick`)
})

test('a camera that leads is sent without touching Mineflayer\'s own packet object', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5), yaw: 0 })
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  preAim(h.bot, new Vec3(3.5, 82.5, 0.5))
  await h.until(() => !!h.bot.motion.lead, 5)
  const seen = []
  const inner = h.bot._client.write
  h.bot._client.write = (n, p) => { seen.push(n); return inner(n, p) }
  const own = { x: 1, y: 2, z: 3, yaw: 11, pitch: 22, onGround: true, flags: {} }
  h.bot._client.write('position', own)
  assert.deepEqual([own.yaw, own.pitch], [11, 22], 'Mineflayer compares this object next tick')
  assert.notEqual(h.bot.motion.sent.yaw, Math.PI - (11 * Math.PI) / 180)
})

test('a fight drops the led camera at once and its looks and packets go through untouched', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5), yaw: 0 })
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  preAim(h.bot, new Vec3(3.5, 82.5, 0.5))
  await h.until(() => !!h.bot.motion.lead, 5)
  setFreeAim(h.bot, true)
  assert.equal(h.bot.motion.lead, null)
  assert.equal(h.bot.motion.aim, null)
  h.bot._client.write('look', { yaw: 33, pitch: 4, onGround: true })
  assert.ok(Math.abs(h.camera().yaw - (Math.PI - (33 * Math.PI) / 180)) < 1e-9)
  await h.bot.look(2.5, 0.4, true)
  h.tick()
  assert.ok(Math.abs(h.camera().yaw - 2.5) < 0.003, 'the network\'s aim is exact and instant')
})

test('the probe\'s scene stays inside the game\'s fill limit and gives a miner solid ground to search in', () => {
  const s = sceneCommands([100, 140, 200])
  for (const line of [...s.lines, s.clear].filter(l => l.startsWith('fill'))) {
    const [x1, y1, z1, x2, y2, z2] = line.split(' ').slice(1, 7).map(Number)
    const volume = (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1) * (Math.abs(z2 - z1) + 1)
    assert.ok(volume <= 32768, `${volume} blocks in: ${line}`)
  }
  assert.ok(s.lines.some(l => l.startsWith('fill 92 132 198') && l.endsWith('minecraft:stone')), 'a thick floor')
  assert.ok(s.clear.startsWith('fill 92 132 198'), 'the clean up takes the floor too')
  assert.deepEqual(s.corner.to, [113, 140, 223])
})

test('the probe\'s recorder counts stops, replans and camera jumps from what the bot sends', async () => {
  const measure = async motion => {
    const h = stairsBot('up', { motion })
    await h.until(() => h.bot.entity.onGround, 40)
    const rec = new MotionRecorder(h.bot)
    rec.start()
    await h.drive(h.bot.pathfinder.goto(goalAt(h.end)), 3000)
    return rec.stop()
  }
  const before = await measure(false)
  const after = await measure(true)
  assert.ok(before.pauses025 >= 15, `before ${before.pauses025}`)
  assert.equal(after.pauses025, 0)
  assert.equal(after.replans, 1)
  assert.ok(after.seconds < before.seconds * 0.7, `${before.seconds} s to ${after.seconds} s`)
})

test('the probe\'s recorder counts a head snap on the very first packet', async () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5), yaw: 0 })
  await h.until(() => h.bot.entity.onGround, 10)
  const rec = new MotionRecorder(h.bot)
  rec.start()
  await h.bot.look(Math.PI * 0.9, 0, true)
  h.tick()
  assert.ok(rec.stop().maxCameraStepDeg > 150)
})

test('the probe\'s recorder tells finished, canceled and undone digs apart', () => {
  const h = makePhysicsBot({ groundY: 80, pos: new Vec3(0.5, 81, 0.5) })
  const rec = new MotionRecorder(h.bot)
  rec.start()
  const a = new Vec3(1, 81, 0)
  const b = new Vec3(2, 81, 0)
  h.bot._client.write('block_dig', { status: 0, location: a, face: 1 })
  h.bot._client.write('block_dig', { status: 2, location: a, face: 1 })
  h.bot._client.write('block_dig', { status: 0, location: b, face: 1 })
  h.bot._client.write('block_dig', { status: 1, location: b, face: 0 })
  h.world.set(a, 'iron_ore')  // the server puts it back
  const r = rec.stop()
  assert.deepEqual([r.digsStarted, r.digsFinished, r.digsCanceled, r.digsUndone], [2, 1, 1, 1])
})

test('the probe builds inside one box and reads its options', () => {
  const s = sceneCommands([100, 140, 200])
  assert.equal(s.stairs.length, 21)
  assert.equal(s.ores.length, 6)
  assert.ok(s.lines[0].startsWith('fill 92 138 198 114'), s.lines[0])
  assert.ok(s.clear.endsWith('minecraft:air'))
  assert.deepEqual(args(['--before', '--at', '1', '2', '3', '--name', 'Agent2']).at, [1, 2, 3])
  assert.throws(() => args(['--nope']), /unknown option/)
})

test('a test stand-in without real physics gets none of it', () => {
  const { bot } = makeBot()
  assert.equal(installMotion(bot), null)
  assert.equal(bot.motion, undefined)
})
