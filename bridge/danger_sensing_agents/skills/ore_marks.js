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

// The ores it leaves in the ground and tells the master about. needs is what it takes to harvest them
const ORE_KINDS = {
  diamond: { ores: ['diamond_ore', 'deepslate_diamond_ore'], word: 'diamonds', them: 'them', needs: 'an iron pickaxe or better' },
  gold: { ores: ['gold_ore', 'deepslate_gold_ore'], word: 'gold', them: 'it', needs: 'an iron pickaxe or better' },
  lapis: { ores: ['lapis_ore', 'deepslate_lapis_ore'], word: 'lapis', them: 'it', needs: 'a stone pickaxe or better' }
}
const KIND_OF = new Map(Object.entries(ORE_KINDS).flatMap(([kind, k]) => k.ores.map(n => [n, kind])))
const oreKind = block => KIND_OF.get(block?.name) || null
const isMarkedOre = block => KIND_OF.has(block?.name)
const kindOfJob = blocks => blocks.map(n => KIND_OF.get(n)).find(Boolean) || null
const isDiamondOre = block => /(^|_)diamond_ore$/.test(block?.name || '')
const dimensionOf = bot => String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '')

class OreMarks {
  constructor ({ say = (bot, text) => bot.chat(text), now = Date.now } = {}) {
    this.say = say
    this.now = now
    this.clusters = []
  }

  // Ore the bot truly sees right now. A new cluster is reported once, more of a known one is added quietly
  saw (bot, positions, kind = 'diamond') {
    const dimension = dimensionOf(bot)
    const { word, them } = ORE_KINDS[kind]
    for (const raw of positions) {
      const p = new Vec3(raw.x, raw.y, raw.z)
      const near = this.clusters.find(c => c.dimension === dimension && c.kind === kind && c.cells.some(q => q.distanceTo(p) <= CLUSTER_GAP))
      if (near) {
        if (!near.cells.some(q => q.equals(p))) near.cells.push(p)
        continue
      }
      this.clusters.push({ dimension, kind, cells: [p], by: bot.username, askedAt: this.now(), answered: false })
      this.say(bot, `Found ${word} at ${p.x} ${p.y} ${p.z}. Say get the ${word} if you want ${them}. I'm carrying on.`)
    }
  }

  list () {
    return this.clusters
  }

  // The closest remembered ore in this dimension, leaving out the cells in skip (a Set of "x,y,z" strings)
  nearest (bot, skip = new Set(), kind = null) {
    const dimension = dimensionOf(bot)
    const from = bot.entity.position
    let best = null
    for (const c of this.clusters) {
      if (c.dimension !== dimension || (kind && c.kind !== kind)) continue
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

  // The newest cluster whose question is still open, of one kind if given
  pending (kind = null) {
    const now = this.now()
    return this.clusters.slice().reverse().find(c => !c.answered && (!kind || c.kind === kind) && now - c.askedAt <= ASK_OPEN_MS) || null
  }
}

// A plain yes, or "get the gold". { kind } names the ore when the line did, null when it is no yes at all. Anything with
// a refusal in it, or an order for something else, is not one
function oreYes (text, names = []) {
  let s = String(text || '').toLowerCase().trim().replace(/[.!?]+$/, '')
  for (const n of names) {
    const low = n.toLowerCase()
    for (const head of [`@${low}`, low]) {
      if (s.startsWith(head) && /^[\s,:]/.test(s.slice(head.length))) s = s.slice(head.length).replace(/^[\s,:]+/, '')
    }
  }
  if (/\b(no|nope|not|don'?t|do not|never|leave|later|skip|stop)\b/.test(s)) return null
  const YES = '(?:yes|yeah|yep|yup|sure|ok|okay|please|go ahead|do it)'
  const GET = '(?:get|grab|mine|dig|take) (?:them|those|it|(?:the|those|these) (diamonds|gold|lapis))'
  const m = s.match(new RegExp(`^(?:${YES}[\\s,]*)*(?:${GET})?(?:[\\s,]*please)?$`))
  if (!m || !s.length) return null
  return { kind: { diamonds: 'diamond', gold: 'gold', lapis: 'lapis' }[m[1]] || null }
}

function saysYesToDiamonds (text, names = []) {
  const yes = oreYes(text, names)
  return !!yes && (!yes.kind || yes.kind === 'diamond')
}

function canHarvest (bot, kind) {
  const tools = new Set(kind.ores.flatMap(n => Object.keys(bot.registry.blocksByName[n]?.harvestTools || {}).map(Number)))
  return !tools.size || bot.inventory.items().some(i => tools.has(i.type))
}

// Diamonds go through the goal planner, which also makes the pickaxe. It has no plan for raw gold or lapis, so those are
// a mining job, and only with a pickaxe that gets the drop
function runOreOrder (agents, ctx, { spot, sender }) {
  const count = spot.cells.length
  if (!count) return
  if (spot.kind === 'diamond') return agents.execute(ctx, { name: 'get', args: { item: 'diamond', count, requester: sender } })
  const k = ORE_KINDS[spot.kind]
  if (!canHarvest(ctx.bot, k)) return agents.say(ctx.bot, `I need ${k.needs} for the ${k.word}, so I'm leaving it marked`)
  agents.execute(ctx, { name: 'mine', args: { block: spot.kind, blocks: [...k.ores], count } })
}

// Called first with each line from the owner. True when the line was a yes to an open question
function answerDiamonds (agents, message, sender, { every = WAIT_EVERY_MS } = {}) {
  if (agents.owner && String(sender).toLowerCase() !== String(agents.owner).toLowerCase()) return false  // the master's call
  const yes = oreYes(message, agents.names)
  const spot = yes && agents.oreMarks?.pending(yes.kind)
  if (!spot) return false
  const ctx = agents.ctxs.get(spot.by)?.alive ? agents.ctxs.get(spot.by) : [...agents.ctxs.values()].find(c => c.alive)
  if (!ctx) return false
  spot.answered = true
  agents.say(ctx.bot, `OK, I'll get the ${ORE_KINDS[spot.kind].word} after this job`)
  ctx.oreOrders = ctx.oreOrders || []
  ctx.oreOrders.push({ spot, sender, until: Date.now() + WAIT_MS })
  const stopWaiting = () => {
    if (ctx.diamondTimer) clearInterval(ctx.diamondTimer)
    ctx.diamondTimer = null
    ctx.diamondCheck = null
    ctx.oreOrders = []
  }
  ctx.diamondCheck = () => {
    if (!ctx.alive) return stopWaiting()
    ctx.oreOrders = ctx.oreOrders.filter(o => Date.now() <= o.until)
    if (!ctx.oreOrders.length) return stopWaiting()
    const active = ctx.manager?.active?.name
    if (ctx.plan || (active && !FREE_MODES.has(active))) return
    const order = ctx.oreOrders.shift()
    if (!ctx.oreOrders.length) stopWaiting()
    runOreOrder(agents, ctx, order)
  }
  ctx.cancelDiamonds = stopWaiting
  if (every > 0) {
    if (ctx.diamondTimer) clearInterval(ctx.diamondTimer)
    ctx.diamondTimer = setInterval(() => ctx.diamondCheck?.(), every)
    ctx.diamondTimer.unref?.()
  }
  return true
}

module.exports = { OreMarks, ORE_KINDS, oreKind, isMarkedOre, kindOfJob, oreYes, saysYesToDiamonds, answerDiamonds, isDiamondOre }
