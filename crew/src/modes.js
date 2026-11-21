'use strict'

const { EventEmitter } = require('node:events')
const { isAbort } = require('./skills/abort')
const { assessSurvival, runSurvival } = require('./skills/survive')
const { fight } = require('./combat/fight')
const { isLive, nearestHostile, findNamedTarget } = require('./combat/targets')

const PRIORITY = { survive: 30, fight: 20, job: 10, idle: 0 }
const DEFEND_WINDOW_MS = 5000
const DEFEND_RADIUS = 6
const GUARD_RADIUS = 12

// Runs the highest priority mode that wants to run. A mode is
// { name, priority, wants(), run(signal) }. Switching aborts the running mode.
class ModeManager extends EventEmitter {
  constructor ({ switchTimeoutMs = 5000 } = {}) {
    super()
    this.switchTimeoutMs = switchTimeoutMs
    this.modes = []
    this.active = null
    this.paused = false
    this.switching = false
    this.timer = null
  }

  add (mode) {
    this.modes.push(mode)
    this.modes.sort((a, b) => b.priority - a.priority)
    return this
  }

  get current () {
    return this.active?.mode.name ?? null
  }

  pick () {
    for (const mode of this.modes) {
      try {
        if (mode.wants()) return mode
      } catch (err) {
        this.emit('modeError', mode.name, err)
      }
    }
    return null
  }

  async tick () {
    if (this.paused || this.switching) return
    const next = this.pick()
    if (this.active?.mode === next) return
    this.switching = true
    try {
      await this.abortActive()
      if (next && !this.paused) this.launch(next)
    } finally {
      this.switching = false
    }
  }

  launch (mode) {
    const controller = new AbortController()
    const entry = { mode, controller, done: null }
    this.active = entry
    entry.done = Promise.resolve()
      .then(() => mode.run(controller.signal))
      .catch(err => { if (!isAbort(err)) this.emit('modeError', mode.name, err) })
      .finally(() => {
        if (this.active === entry) this.active = null
        this.emit('settled', mode.name)
      })
    this.emit('switch', mode.name)
  }

  // Aborts the running mode and waits for it. A mode that will not stop
  // within the time limit is abandoned, so one stuck call cannot freeze the bot.
  async abortActive () {
    const entry = this.active
    if (!entry) return
    entry.controller.abort()
    let timer
    const limit = new Promise(resolve => { timer = setTimeout(resolve, this.switchTimeoutMs) })
    await Promise.race([entry.done, limit])
    clearTimeout(timer)
    if (this.active === entry) {
      this.active = null
      this.emit('modeError', entry.mode.name, new Error('Mode did not stop in time'))
    }
  }

  // Restarts a mode when its work changed but it still wants to run.
  interrupt (name) {
    if (this.active?.mode.name === name) this.active.controller.abort()
  }

  pause () {
    this.paused = true
    this.active?.controller.abort()
  }

  resume () {
    this.paused = false
  }

  start (intervalMs = 250) {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch(err => this.emit('modeError', 'manager', err))
    }, intervalMs)
  }

  stop () {
    clearInterval(this.timer)
    this.timer = null
    this.pause()
  }
}

// Chooses who to fight: the owner's named target, then guard duty, then self defense.
function pickFightTarget (ctx, now = Date.now()) {
  const { bot, state } = ctx
  if (state.fightName) {
    const named = findNamedTarget(bot, state.fightName)
    if (isLive(named)) return { entity: named, commanded: true }
  }
  const anchor = state.job?.guardAnchor
  if (anchor) {
    const hostile = nearestHostile(bot, GUARD_RADIUS, anchor)
    if (hostile) return { entity: hostile, commanded: false }
  }
  if (now - (state.lastHurtAt ?? -Infinity) <= DEFEND_WINDOW_MS) {
    const attacker = nearestHostile(bot, DEFEND_RADIUS)
    if (attacker) return { entity: attacker, commanded: false }
  }
  return null
}

async function runFight (ctx, signal) {
  const pick = pickFightTarget(ctx)
  if (!pick) return
  const name = ctx.state.fightName
  const outcome = await fight(ctx.bot, pick.entity, { signal })
  if (pick.commanded && outcome !== 'aborted') {
    if (ctx.state.fightName === name) ctx.state.fightName = null
    ctx.say(outcome === 'defeated' ? `${name} defeated.` : `Fight with ${name} ended: ${outcome}.`)
  }
}

async function runJob (ctx, signal) {
  const job = ctx.state.job
  if (!job) return
  try {
    const message = await job.run(signal)
    if (ctx.state.job === job) {
      ctx.state.job = null
      ctx.say(message ?? `${job.name} done.`)
    }
  } catch (err) {
    if (isAbort(err)) {
      // An abandoned dig would keep the bot swinging at the old block.
      if (ctx.bot.targetDigBlock) ctx.bot.stopDigging()
      throw err
    }
    if (ctx.state.job === job) {
      ctx.state.job = null
      ctx.say(`${job.name} failed: ${err.message}`)
    }
  }
}

function waitForAbort (signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', resolve, { once: true })
  })
}

function createModes (ctx, options) {
  const manager = new ModeManager(options)
  manager.add({
    name: 'survive',
    priority: PRIORITY.survive,
    wants: () => assessSurvival(ctx) !== null,
    run: signal => runSurvival(ctx, signal)
  })
  manager.add({
    name: 'fight',
    priority: PRIORITY.fight,
    wants: () => pickFightTarget(ctx) !== null,
    run: signal => runFight(ctx, signal)
  })
  manager.add({
    name: 'job',
    priority: PRIORITY.job,
    wants: () => Boolean(ctx.state.job),
    run: signal => runJob(ctx, signal)
  })
  manager.add({
    name: 'idle',
    priority: PRIORITY.idle,
    wants: () => true,
    run: waitForAbort
  })
  return manager
}

module.exports = { ModeManager, createModes, pickFightTarget, PRIORITY, GUARD_RADIUS }
