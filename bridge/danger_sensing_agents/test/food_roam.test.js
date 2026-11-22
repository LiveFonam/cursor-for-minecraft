// Short of food with no animal close, a bot keeps moving: it walks wider rings, takes wood it passes and hunts only what
// is close. It never stands for minutes, and never walks off while told to stay, in danger, or just after being moved.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { Friends } = require('../targets')
const { makeModes } = require('../behaviors')
const { foodBeforeDig, nextRing, woodOnTheWay, ROAM_RING, ROAM_LOGS } = require('../skills/food_mission')

function fakeAgents (extra = {}) {
  const events = []
  return {
    owner: 'Owner',
    friends: new Friends('Owner', ['Agent1']),
    log: () => {},
    events,
    event: (bot, level, key, text) => events.push({ level, key, text }),
    say: () => {},
    stopAll: () => {},
    profileChanged: () => {},
    farms: () => [],
    noDigMoves: () => ({ name: 'noDig', allowSprinting: true }),
    digMoves: () => ({}),
    buildMoves: () => ({ name: 'build' }),
    ensureKit: async () => {},
    announce: () => {},
    blackboard: { clear () {} },
    roamMs: 120,
    ...extra
  }
}

function setup () {
  const { bot, world } = makeBot()
  const agents = fakeAgents()
  const ctx = { bot, agents }
  const m = makeModes(ctx)
  ctx.danger.update()
  return { bot, world, agents, ctx, m, resupply: m.get('resupply') }
}

let nextId = 900
function mob (bot, type, name, dx, dz) {
  const p = bot.entity.position
  const e = { id: nextId++, type, name, position: new Vec3(p.x + dx, p.y, p.z + dz), height: 1.9, width: 0.6, metadata: [], velocity: new Vec3(0, 0, 0), health: 20 }
  bot.entities[e.id] = e
  return e
}

test('no animal close: it walks on at once, with no 3 minute wait', async () => {
  const { bot, agents, resupply } = setup()
  const start = bot.entity.position.clone()
  assert.equal(resupply.wants(), true)
  const r = await resupply.run({ cancelled: false })
  assert.equal(r, 'short')
  assert.equal(resupply.retryAt, 0, 'the next run follows straight away')
  assert.ok(bot.walks > 0, 'it walked')
  assert.ok(bot.entity.position.distanceTo(start) > 10, 'it left the spot')
  assert.ok(agents.events.some(e => e.key === 'resupply-roam'))
  assert.ok(!agents.events.some(e => e.key === 'resupply-short'))
})

test('an order to stay near keeps it there, and only then it waits the 3 minutes', async () => {
  for (const name of ['follow', 'guardpost']) {
    const { bot, m, resupply } = setup()
    m.get(name).on = true
    const before = Date.now()
    assert.equal(await resupply.run({ cancelled: false }), 'short')
    assert.equal(bot.walks, 0, name)
    assert.ok(resupply.retryAt >= before + 170000, name)
    m.get(name).on = false
  }
})

test('a threat close ends the walk, and the walk does not start with one there', async () => {
  const { bot, ctx, resupply } = setup()
  resupply.token = { cancelled: false }
  resupply.fullRun = true
  resupply.roaming = true
  assert.equal(resupply.wants(), true)
  mob(bot, 'hostile', 'zombie', 4, 0)
  ctx.danger.update()
  assert.equal(ctx.danger.report.safe, false)
  assert.equal(resupply.wants(), false)
  resupply.token = null
  resupply.roaming = false
  assert.equal(await resupply.run({ cancelled: false }), 'short')
  assert.equal(bot.walks, 0, 'it did not walk off with the zombie there')
})

test('moved by the server, it stops walking and stays where it was put for a moment', async () => {
  const { bot, resupply } = setup()
  resupply.token = { cancelled: false }
  resupply.fullRun = true
  resupply.roaming = true
  assert.equal(resupply.wants(), true)
  bot.entity.position = bot.entity.position.offset(20, 0, 0)
  assert.equal(resupply.wants(), false)
  resupply.token = null
  resupply.roaming = false
  const walks = bot.walks
  assert.equal(await resupply.run({ cancelled: false }), 'short')
  assert.equal(bot.walks, walks)
  assert.ok(resupply.retryAt > Date.now(), 'it asks again shortly')
})

test('a cow out of hunting range neither gets hunted nor stops the walk', async () => {
  const { bot } = setup()
  const cow = mob(bot, 'animal', 'cow', 28, 0)
  bot.pathfinder.goto = async () => { await bot.waitForTicks(12) }
  const job = {}
  const r = await foodBeforeDig(bot, job, { cancelled: false }, {
    enough: () => false,
    minimum: () => false,
    step: () => {},
    log: () => {},
    farms: () => [],
    moves: { walk: { name: 'noDig' }, build: { name: 'build' } },
    work: {},
    searchMs: 150,
    maxMs: 150
  })
  assert.equal(r, 'limit')
  assert.ok(bot.entities[cow.id], 'the cow is alive')
  assert.ok(job.stats.waypoints > 0, 'the legs were walked to their end')
})

test('wood on the walk comes from a natural tree, and stops at the limit', async () => {
  const { bot, world } = setup()
  for (let y = world.groundY + 1; y <= world.groundY + 4; y++) world.set(new Vec3(3, y, 3), 'oak_log', { axis: 'y' })
  for (let x = 2; x <= 4; x++) for (let z = 2; z <= 4; z++) if (x !== 3 || z !== 3) world.set(new Vec3(x, world.groundY + 4, z), 'oak_leaves', { persistent: false })
  assert.ok(await woodOnTheWay(bot, { cancelled: false }) > 0)
  assert.ok(bot.countOf('oak_log') > 0)
  const had = bot.countOf('oak_log')
  bot.give('oak_log', ROAM_LOGS)
  assert.equal(await woodOnTheWay(bot, { cancelled: false }), 0)
  assert.equal(bot.countOf('oak_log'), had + ROAM_LOGS)
})

test('the rings of a walk for food stay around where it began', () => {
  const { bot } = setup()
  const center = bot.entity.position.clone()
  const job = { center, ring: 0, waypoints: [], index: 0, stats: { rings: 0 }, maxRing: ROAM_RING, anchored: true }
  let widest = 0
  for (let i = 0; i < 12; i++) {
    bot.entity.position = center.offset(i * 40, 0, 0)
    nextRing(bot, job)
    widest = Math.max(widest, job.ring)
    assert.equal(job.center, center)
  }
  assert.equal(widest, ROAM_RING)
})

test('the live scene order: a walk begun before the kit ends once the bread lands, and gives way to the goal', async () => {
  const { bot, agents, m, resupply } = setup()
  agents.roamMs = 5000
  const start = bot.entity.position.clone()
  assert.equal(resupply.wants(), true)
  const run = resupply.run({ cancelled: false })
  const end = Date.now() + 3000
  while (!bot.walks && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 2))
  assert.ok(bot.walks > 0, 'the walk began on the empty bag')
  // prepBot: the teleport back to the start, then the kit. The chest is only placed after this
  bot.entity.position = start.clone()
  bot.give('bread', 16)
  assert.equal(await run, 'done', 'the bread ended the walk')
  assert.ok(bot.entity.position.distanceTo(start) <= 32, `it ended ${bot.entity.position.distanceTo(start).toFixed(1)} blocks from the start, inside the chest survey`)
  // a food run still under way when the goal's first step starts gives way to it
  resupply.token = { cancelled: false }
  resupply.fullRun = true
  assert.equal(resupply.wants(), true)
  m.get('gather').on = true
  assert.equal(resupply.wants(), false)
  m.get('gather').on = false
  resupply.token = null
})
