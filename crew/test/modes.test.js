'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { ModeManager, createModes, pickFightTarget } = require('../src/modes')
const { sleep } = require('../src/skills/abort')
const { createMockBot, createContext } = require('./helpers/mock-bot')

function fakeMode (name, priority, log) {
  const mode = {
    name,
    priority,
    active: false,
    wants: () => mode.active,
    run: signal => new Promise((resolve, reject) => {
      log.push(`start ${name}`)
      signal.addEventListener('abort', () => {
        log.push(`stop ${name}`)
        const err = new Error('stopped')
        err.name = 'AbortedError'
        reject(err)
      }, { once: true })
    })
  }
  return mode
}

async function settleTicks (manager, rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await manager.tick()
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('runs the highest priority mode that wants to run', async () => {
  const log = []
  const low = fakeMode('low', 1, log)
  const high = fakeMode('high', 2, log)
  low.active = true
  high.active = true
  const manager = new ModeManager().add(low).add(high)
  await settleTicks(manager)
  assert.equal(manager.current, 'high')
  assert.deepEqual(log, ['start high'])
})

test('preempts a lower mode and returns to it afterwards', async () => {
  const log = []
  const job = fakeMode('job', 10, log)
  const fightMode = fakeMode('fight', 20, log)
  job.active = true
  const manager = new ModeManager().add(job).add(fightMode)
  await settleTicks(manager)
  assert.equal(manager.current, 'job')

  fightMode.active = true
  await settleTicks(manager)
  assert.equal(manager.current, 'fight')

  fightMode.active = false
  await settleTicks(manager)
  assert.equal(manager.current, 'job')
  assert.deepEqual(log, ['start job', 'stop job', 'start fight', 'stop fight', 'start job'])
})

test('a mode that ignores abort is abandoned after the time limit', async () => {
  const stuck = { name: 'stuck', priority: 1, wants: () => true, run: () => new Promise(() => {}) }
  const urgent = { name: 'urgent', priority: 2, on: false, wants () { return this.on }, run: () => new Promise(() => {}) }
  const errors = []
  const manager = new ModeManager({ switchTimeoutMs: 20 }).add(stuck).add(urgent)
  manager.on('modeError', (name, err) => errors.push(`${name}: ${err.message}`))
  await manager.tick()
  urgent.on = true
  await manager.tick()
  assert.equal(manager.current, 'urgent')
  assert.deepEqual(errors, ['stuck: Mode did not stop in time'])
})

test('a throwing wants check does not stop other modes', async () => {
  const log = []
  const broken = { name: 'broken', priority: 5, wants () { throw new Error('boom') }, run: async () => {} }
  const ok = fakeMode('ok', 1, log)
  ok.active = true
  const manager = new ModeManager().add(broken).add(ok)
  const errors = []
  manager.on('modeError', name => errors.push(name))
  await manager.tick()
  assert.equal(manager.current, 'ok')
  assert.deepEqual(errors, ['broken'])
})

test('pause stops the active mode and resume allows it again', async () => {
  const log = []
  const job = fakeMode('job', 1, log)
  job.active = true
  const manager = new ModeManager().add(job)
  await settleTicks(manager)
  manager.pause()
  await settleTicks(manager)
  assert.equal(manager.current, null)
  manager.resume()
  await settleTicks(manager)
  assert.equal(manager.current, 'job')
})

function crew (options) {
  const bot = createMockBot(options)
  const ctx = createContext(bot)
  ctx.modes = createModes(ctx)
  return { bot, ctx, modes: ctx.modes }
}

function blockingJob (name = 'test job') {
  const job = {
    name,
    runs: 0,
    finish: null,
    run (signal) {
      job.runs++
      return new Promise((resolve, reject) => {
        job.finish = resolve
        signal.addEventListener('abort', () => {
          const err = new Error('stopped')
          err.name = 'AbortedError'
          reject(err)
        }, { once: true })
      })
    }
  }
  return job
}

test('idle runs when there is nothing to do', async () => {
  const { modes } = crew()
  await settleTicks(modes)
  assert.equal(modes.current, 'idle')
})

test('the job resumes after a fight ends', async () => {
  const { bot, ctx, modes } = crew()
  const job = blockingJob()
  ctx.state.job = job
  await settleTicks(modes)
  assert.equal(modes.current, 'job')
  assert.equal(job.runs, 1)

  const zombie = bot.addEntity({ name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0) })
  ctx.state.lastHurtAt = Date.now()
  await settleTicks(modes)
  assert.equal(modes.current, 'fight')
  assert.deepEqual(bot.calls.attacks, [zombie])

  zombie.isValid = false
  bot.emit('entityDead', zombie)
  delete bot.entities[zombie.id]
  await settleTicks(modes)
  assert.equal(modes.current, 'job')
  assert.equal(job.runs, 2)
  assert.equal(ctx.state.job, job)
})

test('survive takes over from a fight when health is low', async () => {
  const { bot, ctx, modes } = crew()
  const zombie = bot.addEntity({ name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0) })
  ctx.state.lastHurtAt = Date.now()
  await settleTicks(modes)
  assert.equal(modes.current, 'fight')

  bot.health = 4
  bot.pathfinder.goto = () => new Promise(() => {})
  await settleTicks(modes)
  assert.equal(modes.current, 'survive')
  assert.equal(bot.pvp.target, undefined)
  assert.ok(zombie)
  modes.stop()
})

test('a finished job clears itself and reports', async () => {
  const { ctx, modes } = crew()
  const job = blockingJob('quick job')
  ctx.state.job = job
  await settleTicks(modes)
  job.finish('All done.')
  await settleTicks(modes)
  assert.equal(ctx.state.job, null)
  assert.ok(ctx.said.includes('All done.'))
  assert.equal(modes.current, 'idle')
})

test('a failed job clears itself and reports the reason', async () => {
  const { ctx, modes } = crew()
  ctx.state.job = { name: 'bad job', run: async () => { throw new Error('no tools') } }
  await settleTicks(modes)
  assert.equal(ctx.state.job, null)
  assert.ok(ctx.said.includes('bad job failed: no tools'))
})

test('replacing the job restarts the job mode', async () => {
  const { ctx, modes } = crew()
  const first = blockingJob('first')
  const second = blockingJob('second')
  ctx.state.job = first
  await settleTicks(modes)
  ctx.state.job = second
  modes.interrupt('job')
  await settleTicks(modes)
  assert.equal(second.runs, 1)
  assert.equal(ctx.state.job, second)
})

test('picks the owner named target ahead of guard and defense', () => {
  const { bot, ctx } = crew()
  const near = bot.addEntity({ name: 'zombie', type: 'hostile', position: new Vec3(1, 64, 0) })
  const named = bot.addEntity({ name: 'skeleton', type: 'hostile', position: new Vec3(10, 64, 0) })
  ctx.state.job = { name: 'guard', guardAnchor: new Vec3(0, 64, 0) }
  assert.equal(pickFightTarget(ctx).entity, near)
  ctx.state.fightName = 'skeleton'
  const pick = pickFightTarget(ctx)
  assert.equal(pick.entity, named)
  assert.equal(pick.commanded, true)
})

test('guard ignores creepers and mobs outside its radius', () => {
  const { bot, ctx } = crew()
  bot.addEntity({ name: 'creeper', type: 'hostile', position: new Vec3(2, 64, 0) })
  bot.addEntity({ name: 'zombie', type: 'hostile', position: new Vec3(40, 64, 0) })
  ctx.state.job = { name: 'guard', guardAnchor: new Vec3(0, 64, 0) }
  assert.equal(pickFightTarget(ctx), null)
})

test('self defense only triggers soon after being hurt', () => {
  const { bot, ctx } = crew()
  bot.addEntity({ name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0) })
  assert.equal(pickFightTarget(ctx), null)
  ctx.state.lastHurtAt = 1000
  assert.ok(pickFightTarget(ctx, 2000))
  assert.equal(pickFightTarget(ctx, 7000), null)
})

test('sleep is cancelled by abort', async () => {
  const controller = new AbortController()
  const pending = sleep(10000, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortedError' })
})
