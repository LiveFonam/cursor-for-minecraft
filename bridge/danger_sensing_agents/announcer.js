// The announcer: what an agent is doing, said in chat so whoever watches always knows. One per bot, made in
// makeModes (behaviors.js) and kept as ctx.announcer and bot.agentsAnnounce.
//
//   task    a change of mode or task, said at once ("mining iron 0/3", "zombie close, fighting", "eating, food at 6")
//   step    a major step inside the task ("digging down to Y 16", "stuck, trying another path"), from the skills
//           through announce(bot, text) and from the agents' news (agents.event)
//   done    a job that ended well ("done: mining iron 3/3"), said at once
//   stall   no move and no change in the bag for 20 s while it has a task: "stalled 20 s: <task>, <why>"
//
// Rules: at most one line every 5 s per bot, except a change of task or mode and news that cannot wait (a death, how
// a job ended), which go out at once, at most 3 lines in any 5 s so a burst never gets it kicked for spam. A step that
// comes too soon waits its turn, and one that waited more than 15 s is dropped as stale, and so are the waiting steps
// of a task that ended. The same line is never said twice within 30 s. !doing answers with the task, the step and how
// long it has been on it. No Minecraft in here apart from reading the bot's position and bag, so test/announcer.test.js
// drives it with a fake clock.

const GAP_MS = 5000          // at most one line this often, unless the task or mode changes
const BURST = 3              // and never more than this many lines within GAP_MS
const REPEAT_MS = 30000      // the same line is not said again within this
const STALE_MS = 15000       // a waiting step older than this is dropped
const STALL_MS = 20000       // no move and no bag change for this long is a stall
const CHECK_MS = 1000        // how often it looks for a stall
const MOVE = 0.5             // blocks that count as moving
const MAX_WAITING = 5
// tasks where standing still is the point
const RESTFUL = /^(idle|following you|staying)/

function bagSignature (bot) {
  return bot.inventory.items().map(i => `${i.name}:${i.count}`).sort().join(',')
}

function duration (ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
}

class Announcer {
  // say(text) puts a line in chat. current() is the live description of what it does (the mode manager's status)
  constructor ({ say, now = () => Date.now(), current = null, log = () => {} } = {}) {
    this.sayLine = say
    this.now = now
    this.current = current
    this.log = log
    this.task = 'idle'
    this.taskSince = now()
    this.stepText = null
    this.stepSince = null
    this.why = null
    this.recent = []           // when the lines of the last GAP_MS were said
    this.said = new Map()      // line to when it was last said
    this.waiting = []          // { text, at, force }
    this.still = null          // { pos, bag, since, task, told }
    this.checkedAt = -Infinity
  }

  // Says a line now when the rules allow it. force: a change of task or mode, past the 5 s gap. Returns true when said
  emit (text, { force = false } = {}) {
    const now = this.now()
    const last = this.said.get(text)
    if (last !== undefined && now - last < REPEAT_MS) return false
    if (!this.allowed(force)) {
      if (!this.waiting.some(w => w.text === text)) {
        // a change of task goes first, a step waits behind the others, the oldest step goes when too many wait
        if (force) this.waiting.unshift({ text, at: now, force })
        else this.waiting.push({ text, at: now, force })
        while (this.waiting.length > MAX_WAITING) {
          const i = this.waiting.findIndex(w => !w.force)
          this.waiting.splice(i < 0 ? this.waiting.length - 1 : i, 1)
        }
      }
      return false
    }
    this.recent.push(now)
    this.said.set(text, now)
    for (const [t, at] of this.said) if (now - at >= REPEAT_MS) this.said.delete(t)
    try { this.sayLine(text) } catch (err) { this.log(`announce: ${err.message}`) }
    return true
  }

  // Whether a line may go out now: a step only after GAP_MS of quiet, a forced line while fewer than BURST went out
  allowed (force) {
    const now = this.now()
    this.recent = this.recent.filter(at => now - at < GAP_MS)
    return force ? this.recent.length < BURST : this.recent.length === 0
  }

  // The next waiting line, once the rules allow it
  flush () {
    const now = this.now()
    this.waiting = this.waiting.filter(w => now - w.at < STALE_MS)
    if (!this.waiting.length || !this.allowed(this.waiting[0].force)) return
    const w = this.waiting.shift()
    this.emit(w.text, { force: w.force })
  }

  // Control moved to another mode (name), described as text
  modeChanged (name, text) {
    const line = text || name
    this.task = line
    this.taskSince = this.now()
    this.stepText = null
    this.stepSince = null
    this.why = null
    this.waiting = this.waiting.filter(w => w.force)  // the old task's steps are stale, its key news is not
    this.emit(line, { force: true })
  }

  // A major step of the task. force: news that cannot wait (a death, a broken pickaxe, how a job ended)
  step (text, { force = false } = {}) {
    if (!text) return
    this.stepText = text
    this.stepSince = this.now()
    this.emit(text, { force })
  }

  // Why it is waiting or stuck, said with a stall
  reason (text) {
    this.why = text || null
  }

  done (text) {
    this.stepText = null
    this.emit(`done: ${text}`, { force: true })
  }

  // Every tick: the waiting lines, and once a second the stall check
  tick (bot) {
    this.flush()
    const now = this.now()
    if (now - this.checkedAt < CHECK_MS || !bot?.entity?.position) return
    this.checkedAt = now
    const pos = bot.entity.position
    const bag = bagSignature(bot)
    const s = this.still
    if (!s || pos.distanceTo(s.pos) > MOVE || bag !== s.bag || this.task !== s.task) {
      this.still = { pos: pos.clone(), bag, since: now, task: this.task, told: false }
      return
    }
    if (s.told || now - s.since < STALL_MS || RESTFUL.test(this.live())) return
    s.told = true
    const live = this.live()
    const why = this.why || (live !== this.task ? live : null) || this.stepText
    this.emit(`stalled ${duration(now - s.since)}: ${this.task}${why && why !== this.task ? `, ${why}` : ', no reason known'}`, { force: true })
  }

  live () {
    try { return this.current ? this.current() : this.task } catch { return this.task }
  }

  // The !doing answer: the task as it stands now, the step, and how long it has been on each
  doing () {
    const now = this.now()
    const parts = [`${this.live()} for ${duration(now - this.taskSince)}`]
    if (this.stepText) parts.push(`step: ${this.stepText} (${duration(now - this.stepSince)})`)
    if (this.still?.told) parts.push(`stalled for ${duration(now - this.still.since)}`)
    return parts.join(', ')
  }
}

// What skills call: a step line for this bot, nothing when it has no announcer (tests, tools)
function announce (bot, text) {
  bot?.agentsAnnounce?.step(text)
}

function announceWhy (bot, text) {
  bot?.agentsAnnounce?.reason(text)
}

module.exports = { Announcer, announce, announceWhy, duration, GAP_MS, BURST, REPEAT_MS, STALL_MS, STALE_MS }
