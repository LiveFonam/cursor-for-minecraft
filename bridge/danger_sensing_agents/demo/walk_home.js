// The agent's walk back to the base at the end of a task. It is a mode just above the crafter, so a fight or a meal cuts
// in at any await and the walk carries on afterwards.

const { goals } = require('mineflayer-pathfinder')
const { Mode } = require('../modes')
const { walkTo, rescueMoves } = require('../skills/move')

const LEGS = 12         // the base can be a whole mine away
const LEG_MS = 30000
const NEAR = 2

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// 'done', 'far' or 'cancelled'
async function walkToSpot (ctx, at, token) {
  const { bot, agents } = ctx
  bot.pathfinder.setMovements(agents.noDigMoves(bot))
  for (let leg = 0; leg < LEGS; leg++) {
    if (token.cancelled) return 'cancelled'
    if (dist(at, bot.entity.position) <= NEAR) return 'done'
    try {
      await walkTo(bot, new goals.GoalNear(at.x, at.y, at.z, 1), token, { ms: LEG_MS, rescue: rescueMoves(bot), log: agents.log })
    } catch (err) {
      if (token.cancelled) return 'cancelled'
      agents.log(`${bot.username} walk to the base: ${err.message}`)
    }
  }
  if (token.cancelled) return 'cancelled'
  return dist(at, bot.entity.position) <= NEAR ? 'done' : 'far'
}

class WalkHomeMode extends Mode {
  constructor (ctx) {
    super('demohome')
    this.profile = 'move'
    this.ctx = ctx
    this.token = null
    this.job = null
    this.running = null
  }

  onStart () {
    this.job = { ...this.params }
  }

  enter () {
    const job = this.job
    const token = { cancelled: false }
    this.token = token
    // a walk a fight cancelled may still be inside its last await: the next one starts once it has settled
    const prev = this.running || Promise.resolve()
    const run = prev.catch(() => {}).then(() => token.cancelled ? 'cancelled' : walkToSpot(this.ctx, job.at, token))
    this.running = run
    run.then(result => {
      if (this.token === token) this.token = null
      if (!token.cancelled && this.on && this.job === job) this.finish(result || 'done')
    }).catch(err => {
      if (this.token === token) this.token = null
      if (token.cancelled || !this.on || this.job !== job) return
      this.ctx.agents.log(`${this.ctx.bot.username} walk home: ${err.message}`)
      this.finish('error')
    })
  }

  exit () {
    if (this.token) this.token.cancelled = true
    this.token = null
    try { this.ctx.bot.pathfinder.setGoal(null) } catch {}
  }

  describe () {
    return 'walking back to the base'
  }
}

// Starts the walk and resolves with how it ended. The mode is added to a bot's manager once
function walkHome (ctx, at) {
  const m = ctx.manager
  if (!m.byName.has('demohome')) {
    const mode = new WalkHomeMode(ctx)
    m.modes.splice(m.modes.indexOf(m.get('craft')), 0, mode)
    m.byName.set('demohome', mode)
  }
  return m.setOn('demohome', { at })
}

module.exports = { walkHome, walkToSpot, WalkHomeMode }
