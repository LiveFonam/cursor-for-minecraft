// The trace that starts at an explosion near the bot
const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { installBlastTrace, NEAR, TRACE_MS, QUIET_MS } = require('../skills/blast_trace')

function setup () {
  const bot = new EventEmitter()
  bot.username = 'Agent1'
  bot._client = new EventEmitter()
  bot.entity = { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true }
  bot.health = 20
  bot.heldItem = { name: 'diamond_axe' }
  bot.getControlState = k => k === 'forward'
  bot.pathfinder = { goal: null, isMoving: () => false, isMining: () => false, isBuilding: () => false }
  const ctx = { manager: { active: { name: 'mobfight' }, status: () => 'fighting' }, plan: null }
  const lines = []
  let t = 1000
  const trace = installBlastTrace(bot, () => ctx, l => lines.push(l), { now: () => t, timer: false })
  return { bot, ctx, lines, trace, at: ms => { t = 1000 + ms; trace.tick() } }
}
const blast = (bot, x = 3) => bot._client.emit('explosion', { center: { x, y: 64, z: 0 }, radius: 3, blockCount: 12, playerKnockback: { x: 0.5, y: 0.2, z: 0 } })

test('a blast close by starts the trace with where it was and the bot\'s whole state', () => {
  const { bot, lines, trace } = setup()
  blast(bot)
  assert.equal(trace.active(), true)
  assert.match(lines[0], /blast at 3\.00 64\.00 0\.00, 3\.0 blocks away, radius 3\.0, 12 blocks, knockback 0\.50 0\.20 0\.00/)
  for (const part of ['mode=mobfight', 'goal=none', 'held=diamond_axe', 'dig=none', 'path=none', 'keys=forward', 'pos=0.00 64.00 0.00', 'hp=20.0']) assert.ok(lines[1].includes(part), part)
})

test('a blast far away is not traced', () => {
  const { bot, lines, trace } = setup()
  blast(bot, NEAR + 1)
  assert.equal(trace.active(), false)
  assert.equal(lines.length, 0)
})

test('it logs each change at once, and only a heartbeat while nothing changes', () => {
  const { bot, ctx, lines, at } = setup()
  blast(bot)
  const n = lines.length
  at(250)
  assert.equal(lines.length, n, 'nothing changed')
  ctx.manager.active = { name: 'retreat' }
  at(500)
  assert.equal(lines.length, n + 1)
  assert.match(lines[n], /mode=retreat/)
  bot.targetDigBlock = { name: 'stone', position: { x: 1, y: 64, z: 0 } }
  at(750)
  assert.match(lines[n + 1], /dig=stone@1 64 0/)
  at(750 + QUIET_MS)
  assert.equal(lines.length, n + 3, 'the heartbeat')
})

test('it ends after 30 s, and another blast keeps it going', () => {
  const { bot, lines, trace, at } = setup()
  blast(bot)
  at(TRACE_MS - 1000)
  blast(bot)
  at(TRACE_MS + 1000)
  assert.equal(trace.active(), true)
  at(2 * TRACE_MS)
  assert.equal(trace.active(), false)
  assert.match(lines[lines.length - 1], /blast trace ends/)
})

test('a state it cannot read is logged and does not break the bot', () => {
  const { bot, ctx, lines, at } = setup()
  blast(bot)
  ctx.manager.status = () => { throw new Error('no status') }
  assert.doesNotThrow(() => at(300))
  assert.match(lines[lines.length - 1], /blast trace: no status/)
})
