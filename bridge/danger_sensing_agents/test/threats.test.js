// The danger assessor (threats.js) and the survival modes that act on it, no server needed:
//   node --test bridge/danger_sensing_agents/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { Friends } = require('../targets')
const { DangerAssessor, armorPoints, FOOD_RESERVE, CREEPER_PATIENCE_MS, UNREACHABLE_MS } = require('../threats')
const { makeModes } = require('../behaviors')

const registry = require('prismarine-registry')('1.21.11')
const Item = require('prismarine-item')(registry)

// A bot on flat ground at 0.5 64 0.5 with a full bag of bread (so the food check stays quiet unless a test wants it),
// a clock the test moves, and a helper to put mobs around it
function setup ({ bread = 8, owner = 'Owner' } = {}) {
  const { bot, world } = makeBot({ groundY: 63 })
  if (bread) bot.give('bread', bread)
  let t = 1000000
  const clock = { now: () => t, add: ms => { t += ms } }
  const friends = new Friends(owner, ['Agent1'])
  const a = new DangerAssessor(bot, { friends, owner, now: clock.now })
  let nextId = 1
  const spawn = (name, x, z, { type = 'hostile', y = 64, yaw, username, heldItem } = {}) => {
    const e = { id: nextId++, type, name, username, position: new Vec3(x, y, z), height: 1.95, heldItem }
    // facing the bot unless told otherwise (Mineflayer yaw: 0 looks at -z)
    e.yaw = yaw ?? Math.atan2(-(bot.entity.position.x - x), -(bot.entity.position.z - z))
    bot.entities[e.id] = e
    return e
  }
  const away = (e) => { e.yaw = Math.atan2(-(e.position.x - bot.entity.position.x), -(e.position.z - bot.entity.position.z)) }
  return { bot, world, clock, a, spawn, away, friends }
}

const wearDiamond = bot => {
  for (const [slot, name] of [[5, 'diamond_helmet'], [6, 'diamond_chestplate'], [7, 'diamond_leggings'], [8, 'diamond_boots']]) {
    bot.inventory.slots[slot] = new Item(registry.itemsByName[name].id, 1)
  }
  bot.give('diamond_sword', 1)
}

// Moves a mob a share of the way toward the bot at 0 0, on the same height
const closer = (e, f) => { e.position.x *= f; e.position.z *= f }

// Two looks 1 s apart, so the assessor sees which way mobs move
function look (s, move = () => {}) {
  s.a.update()
  s.clock.add(1000)
  move()
  return s.a.update()
}

test('food: less than the 24 point reserve in the bag is a danger, 24 or more is not', () => {
  assert.equal(FOOD_RESERVE, 24)
  const s = setup({ bread: 4 })  // bread is 5 food points: 20
  let r = s.a.update()
  assert.ok(r.resupply)
  assert.equal(r.resupply.carried, 20)
  assert.match(r.resupply.reason, /20 food points/)
  s.bot.give('bread', 1)  // 25
  r = s.a.update()
  assert.equal(r.resupply, null)
  // rotten flesh and spider eyes do not count as food
  const t = setup({ bread: 0 })
  t.bot.give('rotten_flesh', 64)
  assert.equal(t.a.update().resupply.carried, 0)
})

test('hunger and starving go to eating', () => {
  const s = setup()
  s.bot.food = 10
  assert.equal(s.a.update().eat.kind, 'hunger')
  s.bot.food = 0
  const r = s.a.update()
  assert.equal(r.eat.kind, 'starving')
  assert.equal(r.eat.response, 'eat')
})

test('a zombie coming at it gets fought, one standing far off looking away does not', () => {
  const s = setup()
  const z = s.spawn('zombie', 0.5, 10.5)
  const r = look(s, () => { z.position.z = 8.5 })
  assert.equal(r.fight?.entity, z)
  assert.match(r.fight.reason, /coming at me/)

  const q = setup()
  const far = q.spawn('zombie', 0.5, 14.5)
  q.away(far)
  const r2 = look(q)
  assert.equal(r2.fight, null)
  assert.equal(r2.dangers.find(x => x.entity === far).response, 'watch')
})

test('an enemy in reach is always answered, even in full diamond with a sword', () => {
  const s = setup()
  wearDiamond(s.bot)
  assert.equal(armorPoints(s.bot), 20)
  const z = s.spawn('zombie', 0.5, 3)
  s.away(z)
  assert.equal(look(s).fight?.entity, z)
})

test('a creeper within 6 blocks is backed away from, not fought, until it is 9 away', () => {
  const s = setup()
  const c = s.spawn('creeper', 0.5, 5.5)
  s.spawn('zombie', 5.5, 0.5)
  let r = look(s)
  assert.equal(r.avoid?.entity, c)
  assert.equal(r.fight, null, 'nothing is fought while backing off')
  c.position.z = 8
  assert.equal(look(s).avoid?.entity, c, 'still too close at 7.5')
  c.position.z = 11
  r = look(s)
  assert.equal(r.avoid, null)
})

test('a creeper that keeps following for 15 s gets fought instead', () => {
  const s = setup()
  const c = s.spawn('creeper', 0.5, 5.5)
  assert.equal(look(s).avoid?.entity, c)
  s.clock.add(CREEPER_PATIENCE_MS + 1000)
  const r = s.a.update()
  assert.equal(r.avoid, null)
  assert.equal(r.fight?.entity, c)
})

test('a skeleton that can see it is a danger, one behind a wall is not', () => {
  const s = setup()
  const sk = s.spawn('skeleton', 0.5, 10.5)
  let r = look(s)
  assert.equal(r.fight?.entity, sk)
  assert.match(r.fight.reason, /can shoot me/)
  for (let x = -2; x <= 2; x++) for (let y = 64; y <= 67; y++) s.world.set(new Vec3(x, y, 5), 'stone')
  r = look(s)
  const d = r.dangers.find(x => x.entity === sk)
  assert.match(d.reason, /no line of sight/)
  assert.ok(d.score < 1, `score ${d.score}`)
})

test('a warden means leave', () => {
  const s = setup()
  s.spawn('warden', 0.5, 25.5)
  const r = look(s)
  assert.equal(r.flee?.from.kind, 'boss')
  assert.equal(r.fight, null)
})

test('low health with an enemy close: run, and keep running until health is above 10', () => {
  const s = setup()
  s.bot.health = 5
  const z = s.spawn('zombie', 0.5, 6.5)
  assert.equal(look(s).flee?.from.entity, z)
  s.bot.health = 8
  assert.ok(look(s).flee, 'still running at 8')
  s.bot.health = 11
  const r = look(s)
  assert.equal(r.flee, null)
  assert.equal(r.fight?.entity, z)
})

test('too many enemies at once below 14 health: run; at full health: fight the worst', () => {
  const s = setup()
  s.bot.health = 12
  const zs = [[0.5, 6], [6, 0.5], [-5, 0.5], [0.5, -5]].map(([x, z]) => s.spawn('zombie', x, z))
  let r = look(s, () => { for (const z of zs) closer(z, 0.8) })
  assert.ok(r.flee, `total ${r.total}`)
  assert.match(r.flee.reason, /enemies at once/)

  const q = setup()
  const zs2 = [[0.5, 6], [6, 0.5], [-5, 0.5], [0.5, -5]].map(([x, z]) => q.spawn('zombie', x, z))
  r = look(q, () => { for (const z of zs2) closer(z, 0.8) })
  assert.equal(r.flee, null)
  assert.ok(r.fight)
})

test('an enderman is left alone until it attacks', () => {
  const s = setup()
  const e = s.spawn('enderman', 0.5, 3.5)
  let r = look(s)
  assert.equal(r.fight, null)
  assert.match(r.dangers.find(x => x.entity === e).reason, /neutral/)
  s.bot.health = 13  // it hit us
  r = s.a.update()
  assert.equal(r.fight?.entity, e)
  assert.match(r.fight.reason, /hit me/)
})

test('a player who is not a friend is watched, fought only after hitting it, and friends never count', () => {
  const s = setup()
  const steve = s.spawn('player', 0.5, 4, { type: 'player', username: 'Steve' })
  const owner = s.spawn('player', 2, 0.5, { type: 'player', username: 'Owner' })
  let r = look(s)
  assert.equal(r.fight, null)
  assert.ok(!r.dangers.some(x => x.entity === owner))
  assert.match(r.dangers.find(x => x.entity === steve).reason, /has not attacked/)
  s.bot.health = 16
  r = s.a.update()
  assert.equal(r.fight?.entity, steve)
})

test('mobs the game does not file as hostile still count (slime, phantom, ghast, hoglin)', () => {
  const s = setup()
  const slime = s.spawn('slime', 0.5, 3, { type: 'mob' })
  const hoglin = s.spawn('hoglin', 20.5, 0.5, { type: 'animal' })
  s.away(hoglin)
  const r = look(s)
  assert.equal(r.fight?.entity, slime)
  assert.ok(r.dangers.some(x => x.name === 'hoglin'))
  // animals stay out of it
  const q = setup()
  q.spawn('cow', 0.5, 3, { type: 'animal' })
  assert.equal(look(q).dangers.filter(x => x.entity).length, 0)
})

test('it keeps fighting the same enemy unless another is much worse', () => {
  const s = setup()
  const a = s.spawn('zombie', 0.5, 7)
  const b = s.spawn('zombie', 7, 0.5)
  let r = look(s, () => { a.position.z = 5; b.position.x = 6 })
  const first = r.fight.entity
  b.position.x = 5.2
  a.position.z = 5.4
  r = s.a.update()
  assert.equal(r.fight.entity, first, 'a slightly worse one does not take over')
  const cs = s.spawn('ravager', -3, 0.5)
  r = look(s, () => { cs.position.x = -2.5 })
  assert.equal(r.fight.entity, cs, 'a ravager in reach does')
})

test('an enemy it cannot get close to in 20 s is given up on', () => {
  const s = setup()
  const z = s.spawn('zombie', 0.5, 6)  // standing and staring: worth fighting, but never comes into reach
  assert.equal(look(s).fight?.entity, z)
  for (let i = 0; i < (UNREACHABLE_MS / 1000) + 2; i++) { s.clock.add(1000); s.a.update() }
  const r = s.a.update()
  assert.equal(r.fight, null)
  assert.equal(r.dangers.find(x => x.entity === z).response, 'watch')
  // unless it comes into reach and hits
  z.position.z = 2
  s.bot.health = 18
  assert.equal(s.a.update().fight?.entity, z)
})

test('a mob next to the owner is fought even when the bot itself is not threatened', () => {
  const s = setup()
  s.bot.players.Owner = { entity: { position: new Vec3(10.5, 64, 0.5) } }
  const z = s.spawn('zombie', 12, 0.5)
  s.away(z)
  const r = look(s)
  assert.equal(r.fight?.entity, z)
  assert.ok(r.fight.forOwner)
  assert.match(r.fight.reason, /from you/)
})

test('lava, fire, a block at its head and running out of air', () => {
  const s = setup()
  s.bot.entity.isInLava = true
  assert.equal(s.a.update().escape.kind, 'lava')
  s.bot.entity.isInLava = false
  s.bot.entity.metadata = { 0: 0x01 }
  assert.equal(s.a.update().escape.kind, 'fire')
  s.bot.entity.metadata = { 0: 0 }
  s.world.set(new Vec3(0, 65, 0), 'gravel')
  assert.equal(s.a.update().escape.kind, 'suffocation')
  s.world.set(new Vec3(0, 65, 0), 'air')
  assert.equal(s.a.update().escape, null)
  s.bot.entity.isInWater = true
  s.bot.oxygenLevel = 4
  assert.equal(s.a.update().swim.kind, 'drowning')
})

test('the summary names the dangers and what it does about each', () => {
  const s = setup({ bread: 2 })
  s.spawn('creeper', 0.5, 4)
  const r = look(s)
  assert.ok(r.avoid)
  const line = s.a.summary()
  assert.match(line, /creeper avoid/)
  assert.match(line, /low food supply resupply/)
  assert.equal(setup().a.summary(), 'No dangers')
})

// The survival modes sit where they should and act on the report
function fakeAgents (bot) {
  return {
    owner: 'Owner',
    friends: new Friends('Owner', ['Agent1']),
    log: () => {},
    event: () => {},
    say: () => {},
    stopAll: () => {},
    profileChanged: () => {},
    farms: () => [],
    noDigMoves: () => ({}),
    ensureKit: async () => true
  }
}

test('the survival modes run in this order, above the jobs', () => {
  const { bot } = makeBot({ groundY: 63 })
  const ctx = { bot, agents: fakeAgents(bot) }
  const m = makeModes(ctx)
  assert.deepEqual(m.modes.map(x => x.name),
    ['escape', 'kill', 'retreat', 'avoid', 'guard', 'mobfight', 'defend', 'findfood', 'eat', 'give', 'come', 'resupply', 'craft', 'gather', 'build', 'mine', 'explore', 'farm', 'follow', 'guardpost', 'idle'])
  assert.ok(ctx.danger instanceof DangerAssessor)
})

test('the mob fighting mode takes a mob the assessor picked, defend only a player, resupply waits while told to stay', () => {
  const { bot } = makeBot({ groundY: 63 })
  const ctx = { bot, agents: fakeAgents(bot) }
  const m = makeModes(ctx)
  const z = { id: 9, type: 'hostile', name: 'zombie', position: new Vec3(0.5, 64, 2.5), height: 1.95 }
  bot.entities[z.id] = z
  ctx.danger.update()
  const mobfight = m.get('mobfight')
  assert.ok(mobfight.wants())
  assert.equal(mobfight.focus, z)
  assert.equal(m.get('defend').wants(), false, 'a mob is not for the network')
  const resupply = m.get('resupply')
  assert.ok(ctx.danger.report.resupply, 'an empty bag needs food')
  ctx.staying = true
  assert.equal(resupply.wants(), false)
  ctx.staying = false
  assert.equal(resupply.wants(), true)
})
