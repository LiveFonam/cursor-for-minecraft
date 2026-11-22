// A small stock of torches, made in the bag's own 2 by 2 grid from coal and wood nothing else needs, so it never walks
// anywhere for them. How often torches are placed is the miner's rule (skills/mine.js) and does not change here.

const { planCraft } = require('./crafter_plan')
const { craftStep, bag, countOf } = require('./crafter')
const { coalForJobs, rawCarried } = require('./cook')

const TORCH_STOCK = 8
const TORCHES_PER_COAL = 4
const COOKS_PER_COAL = 8
const KEEP_LOGS = 2  // the miner keeps 2 logs for a spare pickaxe

// Coal a running job was asked to bring. A job with no count wants all of it
function coalAsked (ctx) {
  const modes = ctx.manager?.byName
  let asked = 0
  const mine = modes?.get('mine')
  if (mine?.on && /coal/.test(`${mine.params?.block} ${mine.params?.blocks}`)) asked = mine.params.count ?? Infinity
  const gather = modes?.get('gather')
  if (gather?.on) {
    for (const t of gather.job?.tasks || []) if (/coal/.test(t.kind)) asked = Math.max(asked, t.count ?? Infinity)
  }
  return asked
}

// Coal that is spoken for: the plan's smelting, the raw food in the bag, and what a job was asked to bring. That last
// part outlives the job while the coal is still in the bag, and shrinks once it has been handed over
function coalToKeep (ctx) {
  const { bot } = ctx
  const held = countOf(bot, 'coal') + countOf(bot, 'charcoal')
  ctx.coalAsked = Math.max(coalAsked(ctx), Math.min(ctx.coalAsked || 0, held))
  const raw = rawCarried(bot).reduce((n, r) => n + r.count, 0)
  return coalForJobs(ctx) + Math.ceil(raw / COOKS_PER_COAL) + ctx.coalAsked
}

// A craft still to come may count on the sticks, the planks or the coal in the bag
function craftsAhead (ctx) {
  const craft = ctx.manager?.byName?.get('craft')
  if (craft?.on || craft?.queue?.length) return true
  const plan = ctx.plan
  return !!plan?.steps?.slice(plan.index || 0).some(text => /\b(craft|make)\b/.test(text))
}

// Takes up to keep out of the named items in the bag copy
function holdBack (have, names, keep) {
  for (const name of names) {
    const n = have.get(name) || 0
    const kept = Math.min(n, keep)
    keep -= kept
    if (n > kept) have.set(name, n - kept)
    else have.delete(name)
  }
}

// The crafter's plan for the torches worth making now, or null. Whole batches only, so the stock stays at about 8
function torchPlan (ctx) {
  const { bot } = ctx
  const room = Math.floor((TORCH_STOCK - countOf(bot, 'torch')) / TORCHES_PER_COAL)
  if (room < 1 || craftsAhead(ctx)) return null
  const have = bag(bot)
  have.delete('torch')
  holdBack(have, ['coal', 'charcoal'], coalToKeep(ctx))
  const gathering = !!ctx.manager?.byName?.get('gather')?.on  // wood in the bag may be what it was sent for
  const names = [...have.keys()]
  holdBack(have, names.filter(n => n.endsWith('_log')), gathering ? Infinity : KEEP_LOGS)
  if (gathering) holdBack(have, names.filter(n => n.endsWith('_planks')), Infinity)
  const batches = Math.min(room, (have.get('coal') || 0) + (have.get('charcoal') || 0))
  for (let n = batches; n > 0; n--) {
    const plan = planCraft('torch', have, { count: n * TORCHES_PER_COAL })
    if (!plan.missing.size && !plan.table && plan.steps.every(s => s.kind === 'craft')) return plan
  }
  return null
}

// Crafts the plan. Returns how many torches it made
async function topUpTorches (ctx, token, plan = torchPlan(ctx)) {
  if (!plan) return 0
  const { bot } = ctx
  const before = countOf(bot, 'torch')
  const job = { item: 'torch' }
  for (const step of plan.steps) {
    if (token.cancelled) break
    await craftStep(bot, step, job, token, ctx.agents?.log || (() => {}))
  }
  return countOf(bot, 'torch') - before
}

module.exports = { torchPlan, topUpTorches, TORCH_STOCK }
