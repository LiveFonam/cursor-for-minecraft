// What the bot knows about ore: only what a player standing in its place could see, or saw earlier and remembers
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { visibleTargets } = require('../skills/mine')
const { seenOre } = require('../skills/mine_branch')
const { visible } = require('../skills/gather')
const { knownOre, seesBlock } = require('../skills/motion')

const FEET = new Vec3(0, 16, 0)
const ORE = new Vec3(2, 16, 0)

function scene () {
  const { bot, world } = makeBot({ groundY: 63, pos: FEET.offset(0.5, 0, 0.5) })
  world.set(FEET, 'air')
  world.set(FEET.offset(0, 1, 0), 'air')
  bot.world.raycast = (from, dir, range) => {
    for (let t = 0; t <= range; t += 0.05) {
      const p = from.plus(dir.scaled(t)).floored()
      if (world.get(p).boundingBox === 'block') return { position: p, face: 0 }
    }
    return null
  }
  return { bot, world, ids: [bot.registry.blocksByName.iron_ore.id] }
}

// The three searches that pick ore to go and dig
function searches ({ bot, ids }) {
  const ctx = { ids, human: { level: 'off' }, skip: new Set(), ownCells: new Set(), pathIndex: new Map() }
  return {
    tunnel: visibleTargets(bot, ids, { level: 'off' }),
    branch: seenOre(bot, ctx),
    gather: visible(bot, ['iron_ore'], () => false)
  }
}

const has = (list, pos) => list.some(p => p.equals(pos))

test('a buried ore 2 blocks away behind stone is not known', () => {
  const s = scene()
  s.world.set(ORE, 'iron_ore')
  for (const [name, list] of Object.entries(searches(s))) assert.equal(has(list, ORE), false, name)
})

test('the same ore with an open face in view is known', () => {
  const s = scene()
  s.world.set(ORE, 'iron_ore')
  s.world.set(new Vec3(1, 16, 0), 'air')
  s.world.set(new Vec3(1, 17, 0), 'air')
  for (const [name, list] of Object.entries(searches(s))) assert.equal(has(list, ORE), true, name)
})

test('an ore behind a wall with an open face on the far side is not known', () => {
  const s = scene()
  s.world.set(ORE, 'iron_ore')
  s.world.set(new Vec3(3, 16, 0), 'air')
  s.world.set(new Vec3(3, 17, 0), 'air')
  for (const [name, list] of Object.entries(searches(s))) assert.equal(has(list, ORE), false, name)
})

test('ore it saw stays known after it walks out of sight, until the ore is gone', () => {
  const s = scene()
  s.world.set(ORE, 'iron_ore')
  s.world.set(new Vec3(1, 16, 0), 'air')
  s.world.set(new Vec3(1, 17, 0), 'air')
  assert.equal(has(visibleTargets(s.bot, s.ids, { level: 'off' }), ORE), true)
  s.world.set(new Vec3(0, 16, -4), 'air')
  s.world.set(new Vec3(0, 17, -4), 'air')
  s.bot.entity.position = new Vec3(0.5, 16, -3.5)
  assert.equal(seesBlock(s.bot, s.bot.blockAt(ORE)), false)
  assert.equal(has(visibleTargets(s.bot, s.ids, { level: 'off' }), ORE), true)
  s.world.set(ORE, 'stone')
  assert.equal(has(visibleTargets(s.bot, s.ids, { level: 'off' }), ORE), false)
})

test('the limit on sight checks holds per search and only delays visible ore', () => {
  const s = scene()
  for (let x = -2; x <= 2; x++) {
    s.world.set(new Vec3(x, 16, 3), 'iron_ore')  // an open face on the far side only
    s.world.set(new Vec3(x, 16, 4), 'air')
  }
  for (let x = -5; x <= -1; x++) {
    s.world.set(new Vec3(x, 16, 0), 'air')
    s.world.set(new Vec3(x, 17, 0), 'air')
  }
  const far = new Vec3(-6, 16, 0)
  s.world.set(far, 'iron_ore')
  const found = s.bot.findBlocks({ matching: s.ids, maxDistance: 16, count: 200 })
  assert.ok(found[found.length - 1].equals(far), 'the visible ore is the last one a nearest first search reaches')

  const blockAt = s.bot.blockAt
  let checks = 0
  s.bot.blockAt = (...args) => {
    if (args.length === 1) checks++
    return blockAt(...args)
  }
  let searchesNeeded = 0
  let known = []
  while (!has(known, far) && searchesNeeded < 3) {
    checks = 0
    known = knownOre(s.bot, found, 2)
    searchesNeeded++
    assert.ok(checks <= 2, `${checks} sight checks in one search`)
  }
  assert.equal(has(known, far), true, 'visible ore was dropped by the limit')
  assert.equal(known.length, 1, 'nothing hidden came along with it')
})
