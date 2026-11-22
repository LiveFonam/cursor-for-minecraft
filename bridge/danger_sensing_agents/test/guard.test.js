// !guard holds its post, on the fake world (test/mockbot.js), no server needed.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { Friends } = require('../targets')
const { makeModes } = require('../behaviors')

function setup () {
  const { bot } = makeBot({ groundY: 63 })
  bot.give('cooked_beef', 8)  // enough food that no food run starts
  const agents = {
    owner: 'Owner',
    friends: new Friends('Owner', ['Agent1']),
    log: () => {},
    event: () => {},
    say: () => {},
    announce: () => {},
    profileChanged: () => {},
    stopAll: () => {},
    farms: () => [],
    noDigMoves: () => ({}),
    digMoves: () => ({}),
    buildMoves: () => ({}),
    ensureKit: async () => {},
    blackboard: { clear () {} }
  }
  bot.agentsFight = { start: () => new Promise(() => {}), stop () {} }
  const ctx = { bot, agents }
  const m = makeModes(ctx)
  const tick = () => { ctx.danger.update(); m.tick() }
  return { bot, ctx, m, tick, post: bot.entity.position.clone() }
}

let nextId = 700
function zombie (bot, x, z) {
  const e = { id: nextId++, type: 'hostile', name: 'zombie', position: new Vec3(x, bot.entity.position.y, z), height: 1.95, metadata: { 9: 20 } }
  bot.entities[e.id] = e
  return e
}

async function until (tick, done) {
  for (let i = 0; i < 200 && !done(); i++) {
    tick()
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.ok(done(), 'timed out')
}

test('guard fights what comes within the radius, then walks back to its post', async () => {
  const { bot, m, tick, post } = setup()
  m.setOn('guard', { radius: 16 })
  tick()
  assert.equal(m.active?.name, 'idle', 'nothing to do on its post')
  const z = zombie(bot, post.x + 6, post.z)
  tick()
  assert.equal(m.active?.name, 'guard')
  assert.equal(m.get('guard').focus, z)
  bot.entity.position = post.offset(10, 0, 0)  // the fight took it away
  delete bot.entities[z.id]
  await until(tick, () => bot.entity.position.distanceTo(post) <= 2)
  assert.equal(m.get('guard').on, true, 'still on guard')
  await until(tick, () => m.active?.name === 'idle')
})

test('an enemy that runs past the radius of the post is left alone', () => {
  const { bot, m, tick, post } = setup()
  m.setOn('guard', { radius: 16 })
  tick()
  bot.entity.position = post.offset(14, 0, 0)
  const runner = zombie(bot, post.x + 24, post.z)
  assert.equal(m.get('guard').wants(), false, 'within 16 of the bot, but 24 from the post')
  const near = zombie(bot, post.x + 15, post.z)
  assert.equal(m.get('guard').wants(), true)
  assert.equal(m.get('guard').focus, near)
  assert.notEqual(m.get('guard').focus, runner)
})

test('it keeps the target it is fighting while another comes nearer the post', () => {
  const { bot, m, tick, post } = setup()
  m.setOn('guard', { radius: 16 })
  tick()
  const first = zombie(bot, post.x + 10, post.z)
  assert.ok(m.get('guard').wants())
  zombie(bot, post.x + 4, post.z)
  assert.ok(m.get('guard').wants())
  assert.equal(m.get('guard').focus, first)
})

test('a job, !follow or !stay comes before the walk back, and its radius then moves with the bot', async () => {
  const { bot, ctx, m, tick, post } = setup()
  m.setOn('guard', { radius: 16 })
  tick()
  m.setOn('follow', {})
  bot.entity.position = post.offset(30, 0, 0)
  assert.equal(m.get('guardpost').wants() && m.modes.indexOf(m.get('guardpost')) < m.modes.indexOf(m.get('follow')), false)
  assert.ok(m.modes.indexOf(m.get('guardpost')) > m.modes.indexOf(m.get('farm')), 'below every job')
  const z = zombie(bot, post.x + 36, post.z)
  assert.equal(m.get('guard').wants(), true, 'near the bot while it follows')
  delete bot.entities[z.id]
  m.setOff('follow')
  ctx.staying = true
  assert.equal(m.get('guardpost').wants(), false, 'told to stay')
  const y = zombie(bot, post.x + 36, post.z)
  assert.equal(m.get('guard').wants(), true, 'told to stay it still guards where it stands')
  delete bot.entities[y.id]
  ctx.staying = false
  assert.equal(m.get('guardpost').wants(), true)
})

test('!stop ends the post, and a new !guard takes a new one', async () => {
  const { bot, m, tick, post } = setup()
  m.setOn('guard', { radius: 16 })
  tick()
  bot.entity.position = post.offset(10, 0, 0)
  m.stopNow()
  assert.equal(m.get('guardpost').wants(), false)
  m.setOn('guard', { radius: 16 })
  assert.ok(m.get('guard').post.distanceTo(post.offset(10, 0, 0)) < 0.01)
  assert.equal(m.get('guardpost').wants(), false, 'already on the new post')
})

test('a mob on the owner is still fought from the post, and it walks back after', async () => {
  const { bot, ctx, m, tick, post } = setup()
  m.setOn('guard', { radius: 4 })
  bot.players.Owner = { username: 'Owner', entity: { type: 'player', username: 'Owner', position: post.offset(10, 0, 0), height: 1.8 } }
  bot.entities[50] = bot.players.Owner.entity
  bot.agentsFight = { start: () => new Promise(() => {}), stop () {} }
  const z = zombie(bot, post.x + 11, post.z)
  ctx.danger.update()
  assert.equal(m.get('guard').wants(), false, 'outside its own radius')
  assert.equal(ctx.danger.report.fight?.entity, z, 'the assessor still picks the mob on the owner')
  assert.equal(ctx.danger.report.fight?.forOwner, true)
  assert.equal(m.get('mobfight').wants(), true)
  delete bot.entities[z.id]
  bot.entity.position = post.offset(9, 0, 0)
  await until(tick, () => bot.entity.position.distanceTo(post) <= 2)
})
