// The evil god's mind: a few short model calls per invasion, each one a pick from the menu in evil_plan.js. It never
// throws and never waits past its timeout. No key, an error, a timeout or a bad reply all mean the scripted plan.
// The key is loaded the way the translator loads it and is never printed or logged.

const { loadCredentials, makeClient, apiErrorText, noteUsage } = require('../translator')
const { FALLBACK_PLAN, checkPlan, checkMove } = require('./evil_plan')
const { EVIL_LIMITS } = require('./settings')

const MODEL = 'claude-haiku-5-5'
const MAX_CALLS = 3
const TIMEOUT_MS = 4000
const REAL_TIMERS = { setTimeout, clearTimeout }
const MINUTE_MS = 60000
const HOUR_MS = 3600000

const SHARED = [
  'You are the evil god in a Minecraft demo, running one raid on a small cobblestone base. A script spawns the mobs, moves them and sets off the blast. You only choose from a fixed menu.',
  'The raid is exactly 1 creeper and 3 zombies. The creeper blows a hole in one wall, then the zombies come in.',
  'In the situation, dx and dz are blocks east and south of the base center. Use the player\'s position, health and what has happened to choose well.',
  'The line is one short villain taunt for chat: at most 80 characters, plain words and basic punctuation.',
  'Reply with exactly one JSON object and nothing else.'
]

const OPENING = [
  ...SHARED,
  'Form: {"wall":"north|east|west","approach":"left|center|right","zombies":"breach|flank|wait_rush","line":"..."}',
  'wall: the wall to blow. approach: where along that wall, as the creeper faces it.',
  'zombies: breach sends all 3 through the hole. flank sends 2 through the hole and 1 around the far wall. wait_rush holds all 3 for a few seconds after the blast, then they rush together.'
].join('\n')

const ADAPT = [
  ...SHARED,
  'The raid has started. The event says what just happened, and plan is the current plan.',
  'Form: {"action":"press|regroup|flank","line":"..."}',
  'press keeps the plan. regroup brings the zombies together at the hole. flank sends one zombie around to the far wall.'
].join('\n')

const WAVE = [
  'You are the evil god in a Minecraft demo, hunting one player wave after wave. A script spawns the mobs and moves them. You only choose from a fixed menu.',
  'In the situation, dx and dz are blocks east and south of the base center. hunt says which wave this is, which walls stand, how the last wave went and how many mobs are coming.',
  'If the player has left the base the mobs land around the player, and wall only sets the side they come from.',
  'The line is one short villain taunt for chat: at most 80 characters, plain words and basic punctuation.',
  'Reply with exactly one JSON object and nothing else.',
  'Form: {"wall":"north|east|west","approach":"left|center|right","zombies":"breach|flank|wait_rush","line":"..."}',
  'wall: the side to attack from, best where a wall is already gone. approach: where along it. zombies: breach comes together, flank sends one around the far side, wait_rush holds them for a few seconds.'
].join('\n')

// The bill's hard stop, across every wave and every time evil mode is turned on, until the demo restarts
class CallBudget {
  constructor ({ perMinute, perHour, perRun }, now = Date.now) {
    Object.assign(this, { perMinute, perHour, perRun, now })
    this.stamps = []
    this.total = 0
  }

  get open () {
    const t = this.now()
    this.stamps = this.stamps.filter(s => t - s < HOUR_MS)
    return this.total < this.perRun && this.stamps.length < this.perHour &&
      this.stamps.filter(s => t - s < MINUTE_MS).length < this.perMinute
  }

  spend () {
    this.stamps.push(this.now())
    this.total++
  }
}

class EvilBrain {
  constructor ({ model = MODEL, log = () => {}, credentials, client, timers = REAL_TIMERS, maxCalls = MAX_CALLS, timeoutMs = TIMEOUT_MS, limits = EVIL_LIMITS } = {}) {
    this.model = model
    this.log = log
    this.timers = timers
    this.maxCalls = maxCalls
    this.timeoutMs = timeoutMs
    this.budget = new CallBudget({ perMinute: limits.modelPerMinute, perHour: limits.modelPerHour, perRun: limits.modelPerRun },
      () => timers.now ? timers.now() : Date.now())
    this.creds = credentials === undefined && !client ? loadCredentials() : credentials
    this.client = client || (this.creds ? makeClient(this.creds, timeoutMs) : null)
  }

  get enabled () { return !!this.client }

  invasion () { return new Invasion(this) }

  // Rejects on an error or at the timeout. A late answer is dropped
  request (system, situation) {
    let timer
    const timeout = new Promise((resolve, reject) => {
      timer = this.timers.setTimeout(() => reject(new Error('timed out')), this.timeoutMs)
    })
    const call = Promise.resolve().then(() => this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: JSON.stringify(situation) }]
    }))
    // counted here so an answer that lands after the timeout, which is still billed, shows in the log too
    call.then(reply => noteUsage(this.log, reply?.usage, `evil-brain ${this.model}`), () => {})
    return Promise.race([call, timeout]).finally(() => this.timers.clearTimeout(timer))
  }
}

// One invasion's calls. A failed call ends the model's part in this invasion, so a dead API costs one timeout at most
class Invasion {
  constructor (brain) {
    this.brain = brain
    this.calls = 0
    this.broken = false
  }

  get canAsk () { return this.brain.enabled && !this.broken && this.calls < this.brain.maxCalls && this.brain.budget.open }

  async ask (kind, system, situation, check, show) {
    const b = this.brain
    if (!this.canAsk) {
      const why = !b.enabled ? 'no key' : this.broken ? 'model off after a failure' : this.calls >= b.maxCalls ? 'call cap reached' : 'model budget reached'
      b.log(`evil-brain ${kind}: scripted (${why})`)
      return null
    }
    if (!situation) {
      b.log(`evil-brain ${kind}: scripted (situation not readable)`)
      return null
    }
    b.budget.spend()
    const tag = `evil-brain ${++this.calls}/${b.maxCalls} ${kind}`
    try {
      const reply = await b.request(system, situation)
      if (reply?.stop_reason === 'refusal') {
        b.log(`${tag}: scripted (refused)`)
        return null
      }
      const text = (reply?.content || []).filter(x => x.type === 'text').map(x => x.text).join('')
      const out = check(text)
      if (!out) {
        b.log(`${tag}: scripted (reply off the menu)`)
        return null
      }
      b.log(`${tag}: ${show(out)}${out.line ? ` "${out.line}"` : ''}`)
      return out
    } catch (err) {
      this.broken = true
      b.log(`${tag}: scripted (${apiErrorText(err, b.creds).slice(0, 80)})`)
      return null
    }
  }

  // Always gives a plan to run
  async open (situation) {
    const plan = await this.ask('opening', OPENING, situation, checkPlan, p => `${p.wall} ${p.approach} ${p.zombies}`)
    if (plan) return plan
    this.broken = true // a scripted opening stays scripted to the end
    return { ...FALLBACK_PLAN }
  }

  // A later wave of the hunt: its plan, or null to keep the scripted side
  wave (situation) {
    return this.ask('wave', WAVE, situation, checkPlan, p => `${p.wall} ${p.approach} ${p.zombies}`)
  }

  // A change of plan, or null to carry on as planned
  adapt (event, situation) {
    return this.ask(event, ADAPT, situation, checkMove, m => m.action)
  }
}

module.exports = { EvilBrain, CallBudget, MAX_CALLS, TIMEOUT_MS }
