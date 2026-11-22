// A gather job is judged by its bag. These scenes copy the two live failures block for block: three touching ores at head
// height over a solid floor, where the last ore's drop lies two cells from the only place the bot can stand.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makePhysicsBot } = require('./physicsbot')
const { FakeWorld } = require('./mockbot')
const { guardHazards, walkOnlyMoves } = require('../skills/move')
const { installMotion, inPickupBox } = require('../skills/motion')
const { mineJob, walkOntoDrops } = require('../skills/mine')
const { gatherKind } = require('../skills/gatherer')
const { runAsk } = require('../skills/goal_steps')

const human = { level: 'off', placesTorches: false, nextTorchGap: () => 99, idleMoment: async () => {}, lookAtPoint: async () => {}, lookAround: async () => {}, detourPoint: () => null }
const v = a => new Vec3(...a)

// The ore and the cells the bot walked, read from the untouched world and the run's position samples
const SCENES = {
  base: {
    stand: [93, 16, 47],
    tunnel: [[93, 16, 44], [93, 16, 45], [93, 16, 46], [93, 16, 47]],
    ores: [[93, 17, 48], [94, 17, 48], [93, 17, 49], [94, 17, 49], [93, 18, 48], [94, 16, 49]],
    far: [93, 17, 49],
    rest: [93.5, 17, 49.7],
    bridge: [93, 16, 48]
  },
  noFood: {
    stand: [21, 16, 33],
    tunnel: [[24, 16, 33], [23, 16, 33], [22, 16, 33], [21, 16, 33]],
    ores: [[21, 17, 32], [20, 17, 32], [21, 17, 31], [20, 17, 31], [21, 18, 31], [20, 16, 32]],
    far: [21, 17, 31],
    rest: [21.5, 17, 31.3],
    bridge: [21, 16, 32]
  },
  // two ores one above the other, so the first hole is two high but its floor is a step up under a solid roof
  baseRound2: {
    stand: [55, 16, -73],
    tunnel: [[52, 16, -73], [53, 16, -73], [54, 16, -73], [55, 16, -73]],
    ores: [[55, 17, -72], [55, 17, -71], [55, 18, -72], [55, 18, -71], [57, 17, -71], [57, 18, -71]],
    far: [55, 17, -71],
    rest: [55.5, 17, -70.3],
    bridge: [55, 16, -72],
    falls: { '55,18,-72': [55.5, 17.05, -71.5], '55,18,-71': [55.5, 17.05, -70.5] }
  }
}

function scene (name, { lose = () => false, dropLag = 3, extra = null } = {}) {
  const s = SCENES[name]
  const world = new FakeWorld({ groundY: 62 })
  for (const c of s.tunnel) {
    world.set(v(c), 'air')
    world.set(v(c).offset(0, 1, 0), 'air')
  }
  for (const o of s.ores) world.set(v(o), 'iron_ore')
  extra?.(world)
  const dropAt = at => {
    if (lose(at)) return null
    const fell = s.falls?.[`${at.x},${at.y},${at.z}`]
    if (fell) return v(fell)
    return at.equals(v(s.far)) ? v(s.rest) : at.offset(0.5, 0.05, 0.5)
  }
  const h = makePhysicsBot({ world, realSight: true, pos: v(s.stand).offset(0.5, 0, 0.5), yaw: 0, dropLag, dropAt })
  h.moves.canDig = true
  h.moves.liquidCost = 50
  h.moves.maxDropDown = 3
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  h.bot.give('stone_pickaxe', 1)
  h.bot.give('oak_planks', 4)
  return { h, world, s }
}

// a few ticks on the ground first: the game's dig time is five times longer in the air
const settle = async h => { let n = 0; await h.until(() => h.bot.entity.onGround && ++n > 3, 20) }

const ironJob = (count = 3) => ({ block: 'iron', blocks: ['iron_ore'], count, mined: 0, strategy: 'branch', home: null, store: false, tuning: { branchLen: 0 } })

for (const name of Object.keys(SCENES)) {
  test(`live failure ${name}: the last ore's drop is out of reach from the only cell it can stand in`, () => {
    const s = SCENES[name]
    const body = [0.3, 0.7].map(f => v(s.stand).offset(f, 0, f))
    for (const b of body) assert.equal(inPickupBox(new Vec3(b.x, s.stand[1], b.z), v(s.rest)), false)
  })

  test(`live failure ${name}: gathering 3 raw iron ends with 3 in the bag`, async () => {
    const { h, world } = scene(name)
    await settle(h)
    const r = await h.drive(gatherKind(h.bot, 'iron', 3, { cancelled: false }, { human, tuning: { branchLen: 0 } }), 2400)
    assert.equal(r.result, 'done', r.message)
    assert.equal(h.bot.countOf('raw_iron'), 3)
    assert.equal(h.digs.canceled, 0, 'no dig was cut short')
    assert.equal(world.name(v(SCENES[name].far)), 'air', 'the ore whose drop lies out of reach was one of the three')
  })
}

test('it opens only the one block between it and the drop, and never builds', async () => {
  const { h, world, s } = scene('base')
  await settle(h)
  const before = h.bot.inventory.items().map(i => `${i.name}:${i.count}`).join()
  const r = await h.drive(mineJob(h.bot, ironJob(), human, { cancelled: false }, {}), 2400)
  assert.equal(r.result, 'done', r.message)
  assert.equal(h.bot.countOf('raw_iron'), 3)
  assert.equal(world.name(v(s.bridge)), 'air', 'the floor under the first ore is the block it opened')
  assert.equal(h.digs.finished, 4, '3 ores and 1 block')
  assert.ok(before.includes('oak_planks:4') && h.bot.countOf('oak_planks') === 4, 'nothing placed')
})

test('the chain of digs keeps its flow: no pause before the last ore, and the fetch is one dig and one step', async () => {
  const { h } = scene('noFood')
  await settle(h)
  const r = await h.drive(mineJob(h.bot, ironJob(), human, { cancelled: false }, {}), 2400)
  assert.equal(r.result, 'done', r.message)
  const rep = h.report()
  assert.equal(rep.pauses, 0, JSON.stringify(rep))
  assert.ok(rep.longestStillS <= 0.25, JSON.stringify(rep))
  assert.equal(h.digs.canceled, 0)
})

test('an older drop that takes a while to collect does not end the wait for the last block\'s own drop', async () => {
  const world = new FakeWorld({ groundY: 80 })
  world.fill3(new Vec3(-3, 70, 0), new Vec3(3, 72, 8), 'air')
  const h = makePhysicsBot({ world, pos: new Vec3(0.5, 70, 0.5) })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await h.until(() => h.bot.entity.onGround, 10)
  // the older drop is a few steps away, and this block's own only arrives after it was picked up
  h.bot.entities[7] = { id: 7, name: 'item', position: new Vec3(0.5, 70.1, 4.5), drop: 'raw_iron', readyAt: 0 }
  const known = new Set([7])
  let after = 0
  const land = () => {
    if (h.bot.entities[7] || ++after !== 3) return
    h.bot.entities[8] = { id: 8, name: 'item', position: new Vec3(0.5, 70.1, 6.5), drop: 'raw_iron', readyAt: 0 }
  }
  h.bot.on('physicsTick', land)
  await h.drive(walkOntoDrops(h.bot, new Vec3(0.5, 70.5, 5.5), { cancelled: false }, { known }), 200)
  h.bot.removeListener('physicsTick', land)
  assert.equal(h.bot.countOf('raw_iron'), 2)
})

test('a drop that is truly gone is replaced by the next ore of the vein', async () => {
  let lost = 0
  const { h, world, s } = scene('base', { lose: at => at.equals(v(SCENES.base.far)) && ++lost === 1 })
  await settle(h)
  const r = await h.drive(gatherKind(h.bot, 'iron', 3, { cancelled: false }, { human, tuning: { branchLen: 0 } }), 3000)
  assert.equal(r.result, 'done', r.message)
  assert.equal(h.bot.countOf('raw_iron'), 3)
  assert.equal(s.ores.filter(o => world.name(v(o)) !== 'iron_ore').length, 4, 'one more ore than asked for')
})

test('when every drop vanishes the job stops at its limit and reports short', async () => {
  const { h, s, world } = scene('base', { lose: () => true })
  await settle(h)
  const r = await h.drive(gatherKind(h.bot, 'iron', 2, { cancelled: false }, { human, tuning: { branchLen: 0 } }), 6000)
  assert.equal(r.result, 'short', r.message)
  assert.equal(h.bot.countOf('raw_iron'), 0)
  assert.ok(s.ores.filter(o => world.name(v(o)) !== 'iron_ore').length <= 4, 'at most twice the amount asked for')
})

test('a drop sealed in blocks it may not dig is left within the time limit', async () => {
  const world = new FakeWorld({ groundY: 62 })
  const s = SCENES.base
  for (const c of s.tunnel) {
    world.set(v(c), 'air')
    world.set(v(c).offset(0, 1, 0), 'air')
  }
  world.fill3(new Vec3(92, 15, 48), new Vec3(95, 19, 51), 'bedrock')
  world.set(v(s.far), 'air')
  const h = makePhysicsBot({ world, realSight: true, pos: v(s.stand).offset(0.5, 0, 0.5) })
  h.moves.canDig = true
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  h.bot.give('stone_pickaxe', 1)
  await settle(h)
  h.bot.entities[50] = { id: 50, name: 'item', position: v(s.rest), drop: 'raw_iron', readyAt: 0, getDroppedItem: () => ({ name: 'raw_iron', count: 1 }) }
  const lines = []
  await h.drive(walkOntoDrops(h.bot, v(s.far).offset(0.5, 0.5, 0.5), { cancelled: false }, { settled: true, digFor: () => true, log: m => lines.push(m) }), 300)
  assert.equal(lines.length, 1, lines.join(' | '))
  assert.match(lines[0], /left a drop behind \(no way to it\): raw_iron at 93\.50 17\.00 49\.70, bot at /)
  assert.equal(h.digs.finished, 0, 'nothing was opened')
  assert.ok(h.bot.entities[50], 'the drop stays where it is')
})

test('the block beside lava is never the one it opens to reach a drop', async () => {
  const { h, world, s } = scene('base', { extra: w => w.set(v(SCENES.base.bridge).offset(1, 0, 0), 'lava') })
  await settle(h)
  world.set(v(s.ores[0]), 'air')
  h.bot.entities[50] = { id: 50, name: 'item', position: v(s.rest), drop: 'raw_iron', readyAt: 0, getDroppedItem: () => ({ name: 'raw_iron', count: 1 }) }
  await h.drive(walkOntoDrops(h.bot, v(s.far).offset(0.5, 0.5, 0.5), { cancelled: false }, { settled: true, digFor: () => true }), 500)
  assert.equal(world.name(v(s.bridge)), 'stone')
  assert.equal(world.name(v(s.bridge).offset(1, 0, 0)), 'lava')
})

test('it never digs for a drop that is not what the job is after', async () => {
  const { h, world, s } = scene('base')
  await settle(h)
  h.bot.entities[60] = { id: 60, name: 'item', position: v(s.rest), drop: 'cobblestone', readyAt: 0, getDroppedItem: () => ({ name: 'cobblestone', count: 1 }) }
  world.set(v(s.ores[0]), 'air')
  await h.drive(walkOntoDrops(h.bot, v(s.far).offset(0.5, 0.5, 0.5), { cancelled: false }, { settled: true, digFor: e => e.getDroppedItem()?.name === 'raw_iron' }), 200)
  assert.equal(h.digs.started, 0)
  assert.ok(h.bot.entities[60])
})

test('a hole at foot height with a roof: it opens the block above the first cell and steps in', async () => {
  const world = new FakeWorld({ groundY: 62 })
  for (let z = 10; z <= 12; z++) {
    world.set(new Vec3(5, 16, z), 'air')
    world.set(new Vec3(5, 17, z), 'air')
  }
  world.set(new Vec3(5, 16, 13), 'iron_ore')
  world.set(new Vec3(5, 16, 14), 'iron_ore')
  const rest = new Vec3(5.5, 16, 14.7)
  const h = makePhysicsBot({ world, realSight: true, pos: new Vec3(5.5, 16, 12.5), dropLag: 3, dropAt: at => at.z === 14 ? rest : at.offset(0.5, 0.05, 0.5) })
  h.moves.canDig = true
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  h.bot.give('stone_pickaxe', 1)
  h.bot.give('oak_planks', 4)
  await settle(h)
  const r = await h.drive(gatherKind(h.bot, 'iron', 2, { cancelled: false }, { human, tuning: { branchLen: 0 } }), 2400)
  assert.equal(r.result, 'done', r.message)
  assert.equal(h.bot.countOf('raw_iron'), 2)
  assert.equal(world.name(new Vec3(5, 17, 13)), 'air', 'the block above the hole')
  assert.equal(h.digs.finished, 3, '2 ores and 1 block')
})

test('an ore over open air: its drop falls to the bot and nothing extra is dug', async () => {
  const world = new FakeWorld({ groundY: 80 })
  world.fill3(new Vec3(-2, 70, -2), new Vec3(2, 72, 2), 'air')
  world.set(new Vec3(0, 73, 1), 'iron_ore')
  const h = makePhysicsBot({ world, realSight: true, pos: new Vec3(0.5, 70, 0.5), dropLag: 6, dropAt: () => new Vec3(0.5, 70.05, 1.5) })
  h.moves.canDig = true
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  h.bot.give('stone_pickaxe', 1)
  h.bot.give('oak_planks', 4)
  await settle(h)
  const r = await h.drive(gatherKind(h.bot, 'iron', 1, { cancelled: false }, { human, tuning: { branchLen: 0 } }), 1200)
  assert.equal(r.result, 'done', r.message)
  assert.equal(h.digs.finished, 1, 'only the ore')
})

test('an item that shows in the bag a few ticks after its pickup does not cost an extra ore', async () => {
  const { h, world, s } = scene('base')
  const give = h.bot.give
  const later = []
  h.bot.give = (name, n) => { later.push({ name, n, wait: 3 }) }
  h.bot.on('physicsTick', () => {
    for (let i = later.length - 1; i >= 0; i--) {
      if (--later[i].wait > 0) continue
      give(later[i].name, later[i].n)
      later.splice(i, 1)
    }
  })
  await settle(h)
  const r = await h.drive(gatherKind(h.bot, 'iron', 3, { cancelled: false }, { human, tuning: { branchLen: 0 } }), 2400)
  assert.equal(r.result, 'done', r.message)
  assert.equal(h.bot.countOf('raw_iron'), 3)
  assert.equal(s.ores.filter(o => world.name(v(o)) !== 'iron_ore').length, 3, 'exactly the 3 ores asked for')
})

// The live owner scene: the bot is 15 blocks off when it asks, the owner jumps to it once it is within 4 blocks, drops 0.6 s
// later at that spot, and steps back. The bot used to walk on to where the owner had been and stand 6 to 7 blocks from the items
test('the owner drops the items while the bot is still walking over: it stops there and collects them', async () => {
  const world = new FakeWorld({ groundY: 67 })
  const h = makePhysicsBot({ world, pos: new Vec3(43.5, 68, 34.5) })
  guardHazards(h.bot, h.moves)
  installMotion(h.bot)
  await settle(h)
  const home = new Vec3(32.5, 68, 24.5)
  const owner = { position: home.clone() }
  h.bot.players = { OwnerPlayer: { entity: owner } }
  const items = ['iron_ingot', 'iron_ingot', 'iron_ingot', 'stick', 'stick']
  let spot = null
  let since = 0
  h.bot.on('physicsTick', () => {
    if (!spot) {
      if (h.bot.entity.position.distanceTo(owner.position) > 4) return
      spot = h.bot.entity.position.clone()
      owner.position = spot.clone()
      return
    }
    since++
    if (since === 12) {
      items.forEach((drop, i) => {
        h.bot.entities[300 + i] = { id: 300 + i, name: 'item', position: spot.offset(0.05 * i, 0, 0), drop, readyAt: Infinity, getDroppedItem: () => ({ name: drop, count: 1 }) }
      })
      const d = spot.minus(home)
      owner.position = spot.plus(d.scaled(-5 / Math.max(0.01, d.norm())))
    }
    if (since === 52) for (let i = 0; i < 5; i++) if (h.bot.entities[300 + i]) h.bot.entities[300 + i].readyAt = 0
  })
  const ctx = { bot: h.bot, agents: { owner: 'OwnerPlayer', say: () => {}, log: () => {}, askWaitMs: 2500, noDigMoves: b => walkOnlyMoves(b) } }
  const job = { items: [['iron_ingot', 3], ['stick', 2]] }
  const r = await h.drive(runAsk(ctx, job, { cancelled: false }), 400000)
  assert.equal(r, 'done')
  assert.equal(h.bot.countOf('iron_ingot'), 3)
  assert.equal(h.bot.countOf('stick'), 2)
})
