'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { fight, configureFight, bestWeapon, weaponScore } = require('../src/combat/fight')
const { findNamedTarget, nearestHostile } = require('../src/combat/targets')
const { createMockBot } = require('./helpers/mock-bot')

function zombie (bot, x = 2) {
  return bot.addEntity({ name: 'zombie', type: 'hostile', position: new Vec3(x, 64, 0) })
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('ranks weapons by material, swords over axes', () => {
  assert.ok(weaponScore('diamond_sword') > weaponScore('diamond_axe'))
  assert.ok(weaponScore('diamond_axe') > weaponScore('iron_sword'))
  assert.equal(weaponScore('stick'), -1)
  const bot = createMockBot({ items: { stick: 1, stone_sword: 1, iron_axe: 1 } })
  assert.equal(bestWeapon(bot).name, 'iron_axe')
})

test('equips the best weapon and attacks through the pvp plugin', async () => {
  const bot = createMockBot({ items: { iron_sword: 1 } })
  const target = zombie(bot)
  const running = fight(bot, target)
  await tick()
  assert.equal(bot.heldItem?.name, 'iron_sword')
  assert.deepEqual(bot.calls.attacks, [target])
  bot.emit('entityDead', target)
  assert.equal(await running, 'defeated')
  assert.equal(bot.pvp.target, undefined)
})

test('reports each way a fight can end', async () => {
  const cases = [
    ['gone', (bot, target) => bot.emit('entityGone', target)],
    ['died', bot => bot.emit('death')],
    ['gone', bot => bot.pvp.stop()],
    ['lost', (bot, target) => { target.position = new Vec3(100, 64, 0) }],
    ['gone', (bot, target) => { target.isValid = false }]
  ]
  for (const [expected, act] of cases) {
    const bot = createMockBot()
    const target = zombie(bot)
    const running = fight(bot, target, { pollMs: 2 })
    await tick()
    act(bot, target)
    assert.equal(await running, expected)
  }
})

test('stops on abort and on timeout', async () => {
  const bot = createMockBot()
  const controller = new AbortController()
  const running = fight(bot, zombie(bot), { signal: controller.signal })
  await tick()
  controller.abort()
  assert.equal(await running, 'aborted')
  assert.equal(bot.pvp.target, undefined)

  const slow = createMockBot()
  assert.equal(await fight(slow, zombie(slow), { timeoutMs: 5 }), 'timeout')
})

test('does not attack a dead target or after an abort', async () => {
  const bot = createMockBot()
  const dead = zombie(bot)
  dead.isValid = false
  assert.equal(await fight(bot, dead), 'gone')
  const controller = new AbortController()
  controller.abort()
  assert.equal(await fight(bot, zombie(bot), { signal: controller.signal }), 'aborted')
  assert.equal(bot.calls.attacks.length, 0)
})

test('events for other entities do not end the fight', async () => {
  const bot = createMockBot()
  const target = zombie(bot)
  const other = zombie(bot, 5)
  const running = fight(bot, target)
  await tick()
  bot.emit('entityDead', other)
  bot.emit('entityGone', other)
  assert.equal(bot.pvp.target, target)
  bot.emit('entityDead', target)
  assert.equal(await running, 'defeated')
})

test('a new fight replaces an old target without ending early', async () => {
  const bot = createMockBot()
  const old = zombie(bot)
  bot.pvp.target = old
  const target = zombie(bot, 3)
  const running = fight(bot, target)
  await tick()
  assert.equal(bot.pvp.target, target)
  bot.emit('entityDead', target)
  assert.equal(await running, 'defeated')
})

test('leaves no listeners behind', async () => {
  const bot = createMockBot()
  const before = bot.listenerCount('entityDead') + bot.listenerCount('death') + bot.listenerCount('stoppedAttacking')
  const target = zombie(bot)
  const running = fight(bot, target)
  await tick()
  bot.emit('entityDead', target)
  await running
  const after = bot.listenerCount('entityDead') + bot.listenerCount('death') + bot.listenerCount('stoppedAttacking')
  assert.equal(after, before)
})

test('applies safe combat settings', () => {
  const bot = createMockBot()
  const movements = { profile: 'safe' }
  configureFight(bot, movements)
  assert.equal(bot.pvp.movements, movements)
  assert.equal(bot.pvp.viewDistance, 32)
  assert.equal(bot.pvp.attackRange, 3)
})

test('fight.js is the only source file that uses the pvp plugin', () => {
  const root = path.join(__dirname, '..', 'src')
  const users = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js') && /\.pvp\b/.test(fs.readFileSync(full, 'utf8'))) {
        users.push(path.relative(root, full))
      }
    }
  }
  walk(root)
  assert.deepEqual(users, [path.join('combat', 'fight.js')])
})

test('finds named players and mobs but not friends who are out of sight', () => {
  const bot = createMockBot()
  assert.equal(findNamedTarget(bot, 'testowner'), bot.players.TestOwner.entity)
  const mob = zombie(bot)
  assert.equal(findNamedTarget(bot, 'ZOMBIE'), mob)
  assert.equal(findNamedTarget(bot, 'skeleton'), null)
  bot.players.TestOwner.entity = null
  assert.equal(findNamedTarget(bot, 'TestOwner'), null)
})

test('nearest hostile skips neutral mobs and animals', () => {
  const bot = createMockBot()
  bot.addEntity({ name: 'enderman', type: 'hostile', position: new Vec3(1, 64, 0) })
  bot.addEntity({ name: 'cow', type: 'animal', position: new Vec3(1, 64, 1) })
  assert.equal(nearestHostile(bot, 10), null)
  const mob = zombie(bot, 4)
  assert.equal(nearestHostile(bot, 10), mob)
})
