// The death recorder. Every death in a live run adds one JSON line to deaths.jsonl in the run folder: the server's
// death message, scene and attempt, position, health and food over the last 10 s, the job and mode, the held item, the
// nearest mobs, and lava or drops close by. tools/deaths_summary.js counts the file by cause.

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

const HISTORY_MS = 10000
const SAMPLE_MS = 500
const MESSAGE_WAIT_MS = 1500   // the server's line can land just after the death event
const MESSAGE_FRESH_MS = 2000  // or just before it
const MOB_RADIUS = 16
const MOBS_KEPT = 6
const LAVA_XZ = 5
const LAVA_DOWN = 3
const LAVA_UP = 2
const DROP_SCAN = 12
const DROP_COUNTS = 4          // a fall this deep hurts

const NOT_A_DEATH = /joined the game|left the game|has made the advancement|has completed the challenge|has reached the goal/

const CAUSES = [
  ['lava', /lava/i],
  ['explosion', /blown up|blew up|explo|fireball/i],
  ['arrow', /shot by|was shot/i],
  ['fall', /fell|hit the ground/i],
  ['drowning', /drown/i],
  ['starving', /starv/i],
  ['suffocation', /suffocat|squash|squish/i],
  ['fire', /burn|flames|fire/i],
  ['melee', /slain|killed|stung|pummeled|impaled/i]
]

function causeOf (message) {
  if (!message) return 'unknown'
  for (const [cause, re] of CAUSES) if (re.test(message)) return cause
  return 'other'
}

function deathsFile (metrics) {
  return metrics ? path.join(path.dirname(metrics), 'deaths.jsonl') : null
}

function sceneOf (metrics) {
  return metrics ? path.basename(metrics).replace(/-\d{8}-\d{6}-metrics\.jsonl$/, '') : null
}

const round = (x, places = 2) => Math.round(x * 10 ** places) / 10 ** places

function mobsAround (bot, pos) {
  const out = []
  for (const e of Object.values(bot.entities || {})) {
    if (e === bot.entity || !e.position || !['hostile', 'mob', 'player'].includes(e.type)) continue
    const d = e.position.distanceTo(pos)
    if (d <= MOB_RADIUS) out.push({ name: e.username || e.name, distance: round(d, 1), dy: round(e.position.y - pos.y, 1) })
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, MOBS_KEPT)
}

function hazardsAround (bot, pos) {
  const c = pos.floored()
  let count = 0
  let nearest = null
  for (let dx = -LAVA_XZ; dx <= LAVA_XZ; dx++) {
    for (let dz = -LAVA_XZ; dz <= LAVA_XZ; dz++) {
      for (let dy = -LAVA_DOWN; dy <= LAVA_UP; dy++) {
        if (bot.blockAt(c.offset(dx, dy, dz))?.name !== 'lava') continue
        count++
        const d = round(Math.hypot(dx, dy, dz), 1)
        if (nearest === null || d < nearest) nearest = d
      }
    }
  }
  let drop = 0
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let depth = 0
    while (depth < DROP_SCAN) {
      const b = bot.blockAt(c.offset(dx, -1 - depth, dz))
      if (!b || b.boundingBox === 'block') break
      depth++
    }
    drop = Math.max(drop, depth)
  }
  return { lava: { count, nearest }, drop: drop >= DROP_COUNTS ? drop : 0 }
}

class DeathRecorder {
  constructor (bot, { metrics = null, attempt = process.env.CREW_ATTEMPT || null, status = () => null, job = () => null,
    now = () => Date.now(), later = fn => { const t = setTimeout(fn, MESSAGE_WAIT_MS); t.unref?.() } } = {}) {
    Object.assign(this, { bot, attempt, status, job, now, later })
    this.file = deathsFile(metrics)
    this.scene = sceneOf(metrics)
    this.history = []
    this.lastSample = -Infinity
    this.lastMessage = null
    this.pending = null
  }

  // Once a tick, it keeps a sample every half second
  sample () {
    if (!this.file) return
    const t = this.now()
    if (t - this.lastSample < SAMPLE_MS) return
    this.lastSample = t
    this.history.push({ at: t, health: round(this.bot.health ?? 0, 1), food: this.bot.food ?? null })
    while (this.history.length && t - this.history[0].at > HISTORY_MS) this.history.shift()
  }

  // A server line. Only this bot's own death counts, never a chat line or another player's death
  message (text) {
    if (!this.file || typeof text !== 'string') return
    if (!text.startsWith(`${this.bot.username} `) || NOT_A_DEATH.test(text)) return
    if (this.pending) {
      this.pending.message = text
      this.pending.cause = causeOf(text)
      this.flush()
    } else {
      this.lastMessage = { text, at: this.now() }
    }
  }

  // Called from the death event, before the bot's state is cleared. pos: where it last stood alive
  died (pos) {
    if (!this.file) return
    this.flush()
    const t = this.now()
    const p = pos || this.bot.entity.position
    const fresh = this.lastMessage && t - this.lastMessage.at <= MESSAGE_FRESH_MS ? this.lastMessage.text : null
    this.lastMessage = null
    this.pending = {
      t: new Date(t).toISOString(),
      bot: this.bot.username,
      scene: this.scene,
      attempt: this.attempt,
      message: fresh,
      cause: causeOf(fresh),
      pos: [round(p.x), round(p.y), round(p.z)],
      mode: this.safe(this.status),
      job: this.safe(this.job),
      held: this.bot.heldItem?.name ?? null,
      history: this.history.filter(h => t - h.at <= HISTORY_MS).map(h => ({ ago: t - h.at, health: h.health, food: h.food })),
      mobs: mobsAround(this.bot, p),
      hazards: hazardsAround(this.bot, new Vec3(p.x, p.y, p.z))
    }
    this.history = []
    if (fresh) this.flush()
    else this.later(() => this.flush())
  }

  safe (fn) {
    try { return fn() ?? null } catch { return null }
  }

  flush () {
    const line = this.pending
    if (!line) return
    this.pending = null
    try {
      fs.appendFileSync(this.file, JSON.stringify(line) + '\n')
    } catch {}  // a full disk must not take the bot down with it
  }
}

// Deaths by cause, most first, each with the scenes it happened in
function summarize (lines) {
  const by = new Map()
  for (const d of lines) {
    const cause = d.cause || 'unknown'
    if (!by.has(cause)) by.set(cause, { cause, count: 0, scenes: {} })
    const row = by.get(cause)
    row.count++
    const scene = d.scene || 'unknown'
    row.scenes[scene] = (row.scenes[scene] || 0) + 1
  }
  return { total: lines.length, causes: [...by.values()].sort((a, b) => b.count - a.count) }
}

module.exports = { DeathRecorder, deathsFile, sceneOf, causeOf, summarize }
