// The death recorder: one line per death in the run folder, and the summary by cause. No server needed
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { DeathRecorder, deathsFile, sceneOf, causeOf, summarize } = require('../death_log')

function setup () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deaths-'))
  const metrics = path.join(dir, 'iron_base-20260101-010203-metrics.jsonl')
  const { bot, world } = makeBot({ groundY: 63 })
  let t = 1000000
  const clock = { now: () => t, add: ms => { t += ms } }
  const timers = []
  const rec = new DeathRecorder(bot, {
    metrics,
    attempt: 'a1',
    status: () => 'gathering cobblestone',
    job: () => 'gather',
    now: clock.now,
    later: (fn) => timers.push(fn)
  })
  const read = () => fs.readFileSync(deathsFile(metrics), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  return { dir, metrics, bot, world, clock, rec, read, timers }
}

test('the file sits in the run folder and the scene comes from the metrics file name', () => {
  assert.equal(deathsFile('/runs/x/iron_base-20260101-010203-metrics.jsonl'), path.join('/runs/x', 'deaths.jsonl'))
  assert.equal(deathsFile(null), null)
  assert.equal(sceneOf('/runs/x/iron_little_food-20260101-010203-metrics.jsonl'), 'iron_little_food')
})

test('a death writes one line with the message, scene, place, history, job, item, mobs and lava', () => {
  const s = setup()
  s.bot.give('stone_pickaxe', 1)
  s.bot.heldItem = s.bot.inventory.items()[0]
  s.world.set(new Vec3(2, 64, 0), 'lava')
  s.bot.entities[7] = { id: 7, type: 'hostile', name: 'creeper', position: new Vec3(3.5, 64, 0.5), height: 1.7 }
  for (let i = 0; i < 30; i++) {
    s.bot.health = 20 - i * 0.5
    s.rec.sample()
    s.clock.add(500)
  }
  s.rec.message('Agent1 was blown up by Creeper')
  s.rec.died(new Vec3(0.5, 64, 0.5))
  const [d] = s.read()
  assert.equal(d.message, 'Agent1 was blown up by Creeper')
  assert.equal(d.cause, 'explosion')
  assert.equal(d.scene, 'iron_base')
  assert.equal(d.attempt, 'a1')
  assert.deepEqual(d.pos, [0.5, 64, 0.5])
  assert.equal(d.mode, 'gathering cobblestone')
  assert.equal(d.job, 'gather')
  assert.equal(d.held, 'stone_pickaxe')
  assert.equal(d.mobs[0].name, 'creeper')
  assert.equal(d.hazards.lava.nearest, 2)
  assert.ok(d.history.length > 0 && d.history.length <= 21, 'only the last 10 s')
  assert.ok(d.history.every(h => h.ago <= 10000))
  assert.ok('health' in d.history[0] && 'food' in d.history[0])
})

test('a message that comes after the death event is still on the line', () => {
  const s = setup()
  s.rec.died(new Vec3(0.5, 64, 0.5))
  assert.equal(fs.existsSync(deathsFile(s.metrics)), false, 'waits for the message')
  s.rec.message('Agent1 tried to swim in lava')
  const [d] = s.read()
  assert.equal(d.cause, 'lava')
  assert.equal(s.read().length, 1)
  for (const fn of s.timers) fn()
  assert.equal(s.read().length, 1, 'the timer does not write it twice')
})

test('with no message at all the line is still written when the wait ends', () => {
  const s = setup()
  s.rec.died(new Vec3(0.5, 64, 0.5))
  for (const fn of s.timers) fn()
  const [d] = s.read()
  assert.equal(d.message, null)
  assert.equal(d.cause, 'unknown')
})

test('another player\'s death and chat lines are not taken for this bot\'s', () => {
  const s = setup()
  s.rec.message('Agent2 was blown up by Creeper')
  s.rec.message('<Agent1> I died at 1 2 3')
  s.rec.died(new Vec3(0.5, 64, 0.5))
  for (const fn of s.timers) fn()
  assert.equal(s.read()[0].message, null)
})

test('no metrics file means a live run is not recording, and nothing is written', () => {
  const { bot } = makeBot({ groundY: 63 })
  const rec = new DeathRecorder(bot, { metrics: null, later: fn => fn() })
  rec.sample()
  rec.died(new Vec3(0, 64, 0))
})

test('causes are read from the server wording', () => {
  assert.equal(causeOf('Agent1 tried to swim in lava'), 'lava')
  assert.equal(causeOf('Agent1 was blown up by Creeper'), 'explosion')
  assert.equal(causeOf('Agent1 was slain by Zombie'), 'melee')
  assert.equal(causeOf('Agent1 was shot by Skeleton'), 'arrow')
  assert.equal(causeOf('Agent1 fell from a high place'), 'fall')
  assert.equal(causeOf('Agent1 hit the ground too hard'), 'fall')
  assert.equal(causeOf('Agent1 drowned'), 'drowning')
  assert.equal(causeOf('Agent1 starved to death'), 'starving')
  assert.equal(causeOf('Agent1 suffocated in a wall'), 'suffocation')
  assert.equal(causeOf('Agent1 burned to death'), 'fire')
  assert.equal(causeOf(null), 'unknown')
})

test('the summary counts deaths by cause, most first, with the scenes', () => {
  const lines = [
    { cause: 'explosion', scene: 'iron_base' },
    { cause: 'lava', scene: 'iron_base' },
    { cause: 'explosion', scene: 'iron_chest' }
  ]
  const out = summarize(lines)
  assert.equal(out.total, 3)
  assert.deepEqual(out.causes[0], { cause: 'explosion', count: 2, scenes: { iron_base: 1, iron_chest: 1 } })
  assert.deepEqual(out.causes[1], { cause: 'lava', count: 1, scenes: { iron_base: 1 } })
})
