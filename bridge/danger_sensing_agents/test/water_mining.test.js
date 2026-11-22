'use strict'
// Mining near water, no server needed: dry spots first, no digging while standing in water when a step gets it out,
// a block holding water back stays, and a world of water still gets dug
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { mineJob } = require('../skills/mine')
const { gather } = require('../skills/gather')
const { TunnelMap } = require('../skills/tunnel_map')

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
const job = () => ({ block: 'diamond', blocks: DIAMOND, count: 1, mined: 0, strategy: 'branch', home: null, store: false })

function miner ({ startY = -20, digLimit = 6 } = {}) {
  const start = new Vec3(0.5, startY, 0.5)
  const { bot, world } = makeBot({ groundY: 63, pos: start })
  if (startY < 63) {
    world.set(start.floored(), 'air')
    world.set(start.floored().offset(0, 1, 0), 'air')
  }
  for (const [name, n] of [['iron_pickaxe', 1], ['torch', 32], ['cobblestone', 32]]) bot.give(name, n)
  const token = { cancelled: false }
  const digs = []
  const dig = bot.dig
  bot.dig = async (block, ...rest) => {
    const feet = bot.entity.position.floored()
    digs.push({ feet, at: block.position.clone(), inWater: world.name(feet) === 'water' })
    await dig(block, ...rest)
    if (digs.length >= digLimit) token.cancelled = true
  }
  bot.world.raycast = (from, dir, range) => {
    for (let t = 0; t <= range; t += 0.05) {
      const p = from.plus(dir.scaled(t)).floored()
      if (world.get(p).boundingBox === 'block') return { position: p, face: 0 }
    }
    return null
  }
  const lines = []
  return { bot, world, token, digs, lines, hooks: { log: l => lines.push(l) } }
}

function waterWithin (world, c, r) {
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -r; dz <= r; dz++) if (world.name(c.offset(dx, dy, dz)) === 'water') return true
    }
  }
  return false
}

test('starting beside a puddle it walks to dry ground before the first dig, and logs it', async () => {
  const s = miner({ startY: 64, digLimit: 3 })
  s.world.fill3(new Vec3(1, 63, -1), new Vec3(2, 63, 1), 'water')
  await mineJob(s.bot, job(), human, s.token, s.hooks)
  assert.ok(s.digs.length > 0, 'it dug')
  assert.ok(!waterWithin(s.world, s.digs[0].feet, 1), `first dig stood at ${s.digs[0].feet}`)
  assert.ok(s.digs[0].feet.distanceTo(new Vec3(0, 64, 0)) <= 8, 'a short move, no long detour')
  assert.ok(s.lines.some(l => /water: moved/.test(l)), 'one log line says why it moved')
})

test('standing in water with a dry cell next to it, it steps out before it digs', async () => {
  const s = miner({ digLimit: 4 })
  s.world.set(new Vec3(0, -20, 0), 'water')
  s.world.set(new Vec3(1, -20, 0), 'air')
  s.world.set(new Vec3(1, -19, 0), 'air')
  s.bot.entity.isInWater = true
  await mineJob(s.bot, job(), human, s.token, s.hooks)
  assert.ok(s.digs.length > 0, 'it dug')
  assert.deepEqual(s.digs.filter(d => d.inWater), [], 'no dig while standing in water')
})

test('its tunnel floods: it leaves the flow and carries on from a dry cell', async () => {
  const s = miner({ digLimit: 3 })
  for (let z = 0; z >= -6; z--) {
    s.world.set(new Vec3(0, -20, z), z >= -2 ? 'water' : 'air')
    s.world.set(new Vec3(0, -19, z), 'air')
  }
  s.bot.entity.isInWater = true
  await mineJob(s.bot, job(), human, s.token, s.hooks)
  assert.ok(s.digs.length > 0, 'it dug')
  assert.equal(s.digs[0].inWater, false)
  assert.ok(s.digs[0].feet.z <= -3, `carried on from ${s.digs[0].feet}`)
})

test('gravel holding water back over the tunnel is left alone', async () => {
  const s = miner({ startY: -58, digLimit: 30 })
  s.world.set(new Vec3(0, -56, -1), 'gravel')
  s.world.set(new Vec3(0, -55, -1), 'water')
  // no side branches, so the main tunnel heads straight under the gravel
  await mineJob(s.bot, { ...job(), tuning: { branchLen: 0 } }, human, s.token, s.hooks)
  assert.ok(s.digs.length >= 10, `${s.digs.length} digs`)
  assert.equal(s.world.name(new Vec3(0, -56, -1)), 'gravel')
})

test('a staircase for stone turns away from a block holding water back', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  bot.give('wooden_pickaxe', 1)
  bot.findBlocks = () => []
  bot.pathfinder.goto = async () => {}
  world.set(new Vec3(1, 62, -2), 'water')
  await gather(bot, 'cobblestone', 1, { cancelled: false }, {})
  assert.equal(world.name(new Vec3(0, 62, -2)), 'dirt')
})

test('a surface spot beside water waits behind a dry one', async () => {
  const { bot, world } = makeBot({ groundY: 63, pos: new Vec3(0.5, 64, 0.5) })
  const wet = new Vec3(1, 63, 0)
  const dry = new Vec3(0, 63, -2)
  world.set(wet, 'sand')
  world.set(dry, 'sand')
  world.set(new Vec3(2, 63, 0), 'water')
  bot.findBlocks = () => [wet, dry].filter(p => world.name(p) === 'sand')
  const order = []
  const dig = bot.dig
  bot.dig = async (b, ...r) => {
    order.push(b.position.toString())
    await dig(b, ...r)
    bot.give('sand', 1)
  }
  await gather(bot, 'sand', 1, { cancelled: false }, {})
  assert.equal(order[0], dry.toString())
})

test('water over every way on: it still digs instead of getting stuck', async () => {
  const s = miner({ startY: -58, digLimit: 8 })
  s.world.fill3(new Vec3(-12, -56, -12), new Vec3(12, -56, 12), 'water')
  const j = job()
  await mineJob(s.bot, j, human, s.token, s.hooks)
  assert.equal(s.digs.length, 8, 'it kept digging')
  assert.equal(j.stats.stuck, 0)
})

test('a remembered tunnel that flooded counts as blocked, with no walk down to it', async () => {
  const s = miner({ startY: -58, digLimit: 3 })
  const map = new TunnelMap()
  for (let z = 0; z >= -10; z--) {
    s.world.set(new Vec3(0, -58, z), 'air')
    s.world.set(new Vec3(0, -57, z), 'air')
    map.add(s.bot, 'main', new Vec3(0, -58, z), { x: 0, z: -1 })
  }
  s.bot._tunnelMap = map
  s.world.set(new Vec3(0, -58, -8), 'water')
  await mineJob(s.bot, job(), human, s.token, s.hooks)
  assert.ok(s.lines.some(l => /tunnels: digging fresh \(blocked by water/.test(l)), s.lines.join(' | '))
  assert.ok(map.blocked.size >= 1, 'the flooded cell is marked')
  assert.ok(s.digs.length > 0, 'it dug')
  assert.ok(s.digs[0].feet.z > -7, `it walked to the flood, first dig at ${s.digs[0].feet}`)
})
