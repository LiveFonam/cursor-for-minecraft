'use strict'
// Diamonds it saw on a job that does not need them: left in the ground, remembered per cluster, and the master is asked
// once. A yes makes them a job after the current one, and any later diamond job starts at a remembered spot.
// Kept for as long as the agents run. A spot is always checked against the world before it is relied on.
const { Vec3 } = require('vec3')

const CLUSTER_GAP = 4         // ores this close are one cluster, one message
const ASK_OPEN_MS = 10 * 60 * 1000  // a plain "yes" answers the question for this long
const WAIT_MS = 30 * 60 * 1000      // how long a yes waits for the current job to end
const WAIT_EVERY_MS = 2000
const FREE_MODES = new Set(['idle', 'follow'])  // nothing it would be pulled away from

const isDiamondOre = block => /(^|_)diamond_ore$/.test(block?.name || '')
const dimensionOf = bot => String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '')

class OreMarks {
  constructor ({ say = (bot, text) => bot.chat(text), now = Date.now } = {}) {
    this.say = say
    this.now = now
    this.clusters = []
  }

  // Ore the bot truly sees right now. A new cluster is reported once, more of a known one is added quietly
  saw (bot, positions) {
    const dimension = dimensionOf(bot)
    for (const raw of positions) {
      const p = new Vec3(raw.x, raw.y, raw.z)
      const near = this.clusters.find(c => c.dimension === dimension && c.cells.some(q => q.distanceTo(p) <= CLUSTER_GAP))
      if (near) {
        if (!near.cells.some(q => q.equals(p))) near.cells.push(p)
        continue
      }
      this.clusters.push({ dimension, cells: [p], by: bot.username, askedAt: this.now(), answered: false })
      this.say(bot, `Found diamonds at ${p.x} ${p.y} ${p.z}. Say get the diamonds if you want them. I'm carrying on.`)
    }
  }

  list () {
    return this.clusters
  }

  // The closest remembered ore in this dimension, leaving out the cells in skip (a Set of "x,y,z" strings)
  nearest (bot, skip = new Set()) {
    const dimension = dimensionOf(bot)
    const from = bot.entity.position
    let best = null
    for (const c of this.clusters) {
      if (c.dimension !== dimension) continue
      for (const p of c.cells) {
        if (skip.has(`${p.x},${p.y},${p.z}`)) continue
        if (!best || p.distanceTo(from) < best.distanceTo(from)) best = p
      }
    }
    return best
  }

  forget (pos) {
    for (const c of this.clusters) c.cells = c.cells.filter(q => !q.equals(pos))
    this.clusters = this.clusters.filter(c => c.cells.length)
  }

  // The newest cluster whose question is still open
  pending () {
    const now = this.now()
    return this.clusters.slice().reverse().find(c => !c.answered && now - c.askedAt <= ASK_OPEN_MS) || null
  }
}

// A plain yes to "get the diamonds". Anything with a refusal in it, or an order for something else, is not one
function saysYesToDiamonds (text, names = []) {
  let s = String(text || '').toLowerCase().trim().replace(/[.!?]+$/, '')
  for (const n of names) {
    const low = n.toLowerCase()
    for (const head of [`@${low}`, low]) {
      if (s.startsWith(head) && /^[\s,:]/.test(s.slice(head.length))) s = s.slice(head.length).replace(/^[\s,:]+/, '')
    }
  }
  if (/\b(no|nope|not|don'?t|do not|never|leave|later|skip|stop)\b/.test(s)) return false
  const YES = '(?:yes|yeah|yep|yup|sure|ok|okay|please|go ahead|do it)'
  const GET = '(?:get|grab|mine|dig|take) (?:them|those|the diamonds|those diamonds|these diamonds)'
  return new RegExp(`^(?:${YES}[\\s,]*)*(?:${GET})?(?:[\\s,]*please)?$`).test(s) && s.length > 0
}

// Called first with each line from the owner. True when the line was a yes to an open question
function answerDiamonds (agents, message, sender, { every = WAIT_EVERY_MS } = {}) {
  if (agents.owner && String(sender).toLowerCase() !== String(agents.owner).toLowerCase()) return false  // the master's call
  const spot = agents.oreMarks?.pending()
  if (!spot || !saysYesToDiamonds(message, agents.names)) return false
  const ctx = agents.ctxs.get(spot.by)?.alive ? agents.ctxs.get(spot.by) : [...agents.ctxs.values()].find(c => c.alive)
  if (!ctx) return false
  spot.answered = true
  agents.say(ctx.bot, "OK, I'll get the diamonds after this job")
  const until = Date.now() + WAIT_MS
  const stopWaiting = () => {
    if (ctx.diamondTimer) clearInterval(ctx.diamondTimer)
    ctx.diamondTimer = null
    ctx.diamondCheck = null
  }
  ctx.diamondCheck = () => {
    if (!ctx.alive || Date.now() > until) return stopWaiting()
    const active = ctx.manager?.active?.name
    if (ctx.plan || (active && !FREE_MODES.has(active))) return
    const count = spot.cells.length
    stopWaiting()
    if (count) agents.execute(ctx, { name: 'get', args: { item: 'diamond', count, requester: sender } })
  }
  ctx.cancelDiamonds = stopWaiting
  if (every > 0) {
    if (ctx.diamondTimer) clearInterval(ctx.diamondTimer)
    ctx.diamondTimer = setInterval(() => ctx.diamondCheck?.(), every)
    ctx.diamondTimer.unref?.()
  }
  return true
}

module.exports = { OreMarks, saysYesToDiamonds, answerDiamonds, isDiamondOre }
