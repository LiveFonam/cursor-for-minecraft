// The goal planner's own steps (goal_plan.js), the parts no other skill does: looking into nearby chests, taking from a
// chest, asking the owner to drop items, walking to a player and handing over exactly what was asked for. They run as
// one mode, just above the crafter, so a fight or a meal cuts in at any await and the step carries on afterwards.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { Mode } = require('../modes')
const { goTo, walkTo, rescueMoves } = require('./move')
const { findContainers, contents, withdraw } = require('./storage')
const { craftStep, countOf, stationNear } = require('./crafter')
const { planCraft } = require('./crafter_plan')
const { resync, pickUpTable } = require('./craft')
const { gatherKind } = require('./gatherer')
const { visible, LOGS } = require('./gather')
const { carriedOf } = require('./gather_kinds')
const { GoalPickup } = require('./mine')
const { inPickupBox } = require('./motion')
const { sleep } = require('./abort')
const { readPlayerPos } = require('../owner_bag')
const { listText, qty } = require('../goal_plan')

const ASK_WAIT_MS = 20000
const SURVEY_RADIUS = 32  // a food run before the goal can leave it well away from the chests it started beside
const SURVEY_MAX = 8
const NEAR_PLAYER = 3.5
const ASK_WALK_RANGE = 32
const DROP_RANGE = 16     // an owner can drop while the bot is still on its way, so the items may lie well behind it
const WALK_LEGS = 4

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// Opens the containers close by that the agents have not looked into yet (storage.js remembers what it sees)
async function runSurvey (ctx, job, token) {
  const { bot, agents } = ctx
  if (!bot.agentsChests) return 'done'
  bot.pathfinder.setMovements(agents.noDigMoves(bot))
  for (const pos of findContainers(bot, bot.entity.position, SURVEY_RADIUS, SURVEY_MAX)) {
    if (token.cancelled) return 'cancelled'
    if (bot.agentsChests.knows(pos)) continue
    try {
      await contents(bot, pos, token)
    } catch (err) {
      agents.log(`${bot.username} could not look in the chest at ${pos}: ${err.message}`)
    }
  }
  return token.cancelled ? 'cancelled' : 'done'
}

async function runTake (ctx, job, token) {
  const { bot, agents } = ctx
  const pos = new Vec3(job.pos.x, job.pos.y, job.pos.z)
  const left = new Map(job.items.map(([n, c]) => [n, c - (job.got.get(n) || 0)]).filter(([, c]) => c > 0))
  if (!left.size) return 'done'
  if (!job.said) {
    job.said = true
    agents.say(bot, `Taking ${listText([...left])} from the chest at ${pos.x} ${pos.y} ${pos.z}`)
  }
  bot.pathfinder.setMovements(agents.noDigMoves(bot))
  let taken
  try {
    taken = await withdraw(bot, pos, left, token)
  } catch (err) {
    if (token.cancelled) return 'cancelled'
    if (/no chest/.test(err.message)) bot.agentsChests?.forget(pos)
    agents.log(`${bot.username} could not take from the chest at ${pos}: ${err.message}`)
    return 'short'
  }
  for (const [n, c] of taken) job.got.set(n, (job.got.get(n) || 0) + c)
  if (token.cancelled) return 'cancelled'
  return [...left].every(([n, c]) => (taken.get(n) || 0) >= c) ? 'done' : 'short'
}

// Items of these names lying close by: the ones the owner just dropped
function wantedDrops (bot, names, range = DROP_RANGE) {
  const me = bot.entity.position
  return Object.values(bot.entities || {})
    .filter(e => e.name === 'item' && e.position && dist(e.position, me) <= range)
    .filter(e => names.has(typeof e.getDroppedItem === 'function' ? e.getDroppedItem()?.name : null))
    .sort((a, b) => dist(a.position, me) - dist(b.position, me))
}

// Walks toward where the owner was, and stops as soon as the owner has come to it or the offered items are on the ground,
// so it never walks on past a drop made at its feet
async function walkToAsk (ctx, from, names, token) {
  const { bot, agents } = ctx
  const goal = new goals.GoalNear(from.x, from.y, from.z, 2)
  let walking = true
  let stopped = false
  const walk = goTo(bot, goal, token, 15000)
    .catch(err => { if (!stopped) agents.log(`${bot.username} walk to ask: ${err.message}`) })
    .finally(() => { walking = false })
  while (walking && !token.cancelled) {
    const owner = bot.players[agents.owner]?.entity
    if (wantedDrops(bot, names).length || (owner && dist(owner.position, bot.entity.position) <= NEAR_PLAYER)) {
      stopped = true
      if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null)
      break
    }
    await bot.waitForTicks(1)
  }
  await walk
}

// Says what the owner has that would help, walks over when the owner is in sight, and waits a little for the drop.
// Nothing is ever taken: an owner who ignores this just means the bot gets its own
async function runAsk (ctx, job, token) {
  const { bot, agents } = ctx
  const names = new Set(job.items.map(([n]) => n))
  if (!job.start) {
    job.start = new Map([...names].map(n => [n, countOf(bot, n)]))
    job.until = Date.now() + (agents.askWaitMs ?? ASK_WAIT_MS)
    const seconds = Math.round((agents.askWaitMs ?? ASK_WAIT_MS) / 1000)
    const them = job.items.length > 1 || job.items[0][1] > 1 ? 'them' : 'it'
    agents.say(bot, `You have ${listText(job.items)}, drop ${them} to me. I'll wait ${seconds} s, then get the rest myself`)
  }
  const received = () => job.items.every(([n, c]) => countOf(bot, n) - job.start.get(n) >= c)
  const owner = bot.players[agents.owner]?.entity
  bot.pathfinder.setMovements(agents.noDigMoves(bot))
  if (owner && dist(owner.position, bot.entity.position) > NEAR_PLAYER && dist(owner.position, bot.entity.position) <= ASK_WALK_RANGE) {
    await walkToAsk(ctx, owner.position.clone(), names, token)
  }
  while (Date.now() < job.until && !token.cancelled) {
    if (received()) return 'done'
    const drop = wantedDrops(bot, names)[0]
    // in the game's pickup range it only has to wait out the delay on a thrown item
    if (drop && !inPickupBox(bot.entity.position, drop.position)) {
      try {
        await goTo(bot, new GoalPickup(drop.position), token, 4000)
      } catch {}
    }
    await sleep(250, token)
  }
  if (token.cancelled) return 'cancelled'
  if (!received()) {
    // the world is restored after a live scene, so this line is the only record of where an offered drop lay
    const at = q => `${q.x.toFixed(2)} ${q.y.toFixed(2)} ${q.z.toFixed(2)}`
    const lying = wantedDrops(bot, names, Infinity).map(e => `${e.getDroppedItem().name} at ${at(e.position)}`)
    agents.log(`${bot.username} ask ended without the items: ${lying.join(', ') || 'no such drop seen'}, bot at ${at(bot.entity.position)}`)
  }
  return 'done'
}

// Walks to a player: to where the bot sees them, or to where the server says they are when they are out of sight.
// 'done', 'far' or 'cancelled'
async function walkToPlayer (ctx, name, token) {
  const { bot, agents } = ctx
  bot.pathfinder.setMovements(agents.noDigMoves(bot))
  for (let leg = 0; leg < WALK_LEGS; leg++) {
    if (token.cancelled) return 'cancelled'
    const seen = bot.players[name]?.entity?.position
    const p = seen || await readPlayerPos(agents.rcon, name)
    if (!p) return 'far'
    if (dist(p, bot.entity.position) <= NEAR_PLAYER) return 'done'
    try {
      await walkTo(bot, new goals.GoalNear(p.x, p.y, p.z, 2), token, { ms: 30000, rescue: rescueMoves(bot), log: agents.log })
    } catch (err) {
      if (token.cancelled) return 'cancelled'
      agents.log(`${bot.username} walk to ${name}: ${err.message}`)
    }
    const now = bot.players[name]?.entity?.position
    if (now && dist(now, bot.entity.position) <= NEAR_PLAYER) return 'done'
  }
  return token.cancelled ? 'cancelled' : 'far'
}

async function runWalk (ctx, job, token) {
  const r = await walkToPlayer(ctx, job.to, token)
  if (r === 'far') ctx.agents.say(ctx.bot, `I can't reach you, ${job.to}. Ask me again when you're closer and I'll hand it over`)
  return r
}

// Drops exactly count of the item in front of the player. job.given keeps the score across a fight
async function runHand (ctx, job, token) {
  const { bot, agents } = ctx
  const player = bot.players[job.to]?.entity
  if (!player || dist(player.position, bot.entity.position) > NEAR_PLAYER + 1) {
    const r = await runWalk(ctx, job, token)
    if (r !== 'done') return r
  }
  const target = bot.players[job.to]?.entity
  if (!target) return 'far'
  await bot.lookAt(target.position.offset(0, 1.1, 0), true)
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
  await resync(bot)
  // handing over a pickaxe is not a pickaxe breaking (agents.watchPickaxes)
  ctx.pickaxes = null
  for (const name of job.names) {
    for (let tries = 0; tries < 3 && job.given < job.count; tries++) {
      if (token.cancelled) return 'cancelled'
      const have = countOf(bot, name)
      const n = Math.min(have, job.count - job.given)
      if (n <= 0) break
      if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(3)
      try {
        await bot.toss(bot.registry.itemsByName[name].id, null, n)
      } catch (err) {
        agents.log(`${bot.username} toss ${name}: ${err.message}`)
      }
      await resync(bot)
      job.given += Math.max(0, have - countOf(bot, name))
    }
  }
  ctx.pickaxes = null
  if (typeof bot.waitForTicks === 'function' && job.given > 0) {
    // a few steps back, so the player is the one standing on it when the pickup delay ends
    bot.setControlState('back', true)
    await bot.waitForTicks(14)
    bot.setControlState('back', false)
  }
  if (job.given < job.count) {
    agents.say(bot, `I could only hand over ${job.given} of ${job.count}`)
    return 'short'
  }
  const what = job.count > 1 ? qty(job.names.length > 1 ? job.item : job.names[0], job.count) : job.item.replace(/_/g, ' ')
  agents.say(bot, `Here's your ${what}, ${job.to}`)
  return 'done'
}

// Planks made ahead, so the furnace has its fuel before the crafter's later crafts (goal_plan.js lateFuel)
async function runPrep (ctx, job, token) {
  const { bot, agents } = ctx
  if (job.want === undefined) job.want = countOf(bot, job.item) + job.times * 4
  const times = Math.ceil((job.want - countOf(bot, job.item)) / 4)
  if (times <= 0) return 'done'
  job.station = job.station || { table: null, tableOurs: false }
  await craftStep(bot, { name: job.item, times, table: false }, job.station, token, agents.log)
  await resync(bot)
  if (token.cancelled) return 'cancelled'
  return countOf(bot, job.item) >= job.want ? 'done' : 'short'
}

// A wooden axe the bot keeps to fight with. It chops the logs it lacks. A failure here only costs the axe, so the plan
// carries on: 'done' either way unless it was cancelled
async function runAxe (ctx, job, token) {
  const { bot, agents } = ctx
  if (bot.inventory.items().some(i => /_(axe|sword)$/.test(i.name))) return 'done'
  job.station = job.station || { table: null, tableOurs: false }
  const planNow = () => {
    const have = new Map()
    for (const i of bot.inventory.items()) have.set(i.name, (have.get(i.name) || 0) + i.count)
    return planCraft('wooden_axe', have, { tableNear: !!stationNear(bot, 'crafting_table') || !!(job.station.table && bot.blockAt(job.station.table)?.name === 'crafting_table') })
  }
  try {
    // logs of its own for the axe, so it never uses the wood the plan's later crafts count on
    if (job.chop && !job.chopped) {
      const logs = () => carriedOf(bot.inventory.items(), 'wood')
      if (job.chopFrom === undefined) {
        if (!visible(bot, LOGS, () => false, { logs: true }).length) {
          agents.log(`${bot.username} no tree in sight for a wooden axe, carrying on without it`)
          return 'done'
        }
        job.chopFrom = logs()
      }
      bot.pathfinder.setMovements(agents.noDigMoves(bot))
      const left = job.chopFrom + job.chop - logs()
      if (left > 0) await gatherKind(bot, 'wood', left, token, { log: agents.log })
      if (token.cancelled) return 'cancelled'
      if (logs() < job.chopFrom + job.chop) {
        agents.say(bot, "I couldn't get the wood for a wooden axe, carrying on without it")
        return 'done'
      }
      job.chopped = true
    }
    for (let logs = 0; logs < 4 && planNow().missing.size; logs++) {
      bot.pathfinder.setMovements(agents.noDigMoves(bot))
      await gatherKind(bot, 'wood', 1, token, { log: agents.log })
      if (token.cancelled) return 'cancelled'
    }
    const plan = planNow()
    if (plan.missing.size) {
      agents.say(bot, "I couldn't get the wood for a wooden axe, carrying on without it")
      return 'done'
    }
    bot.pathfinder.setMovements(agents.noDigMoves(bot))
    for (const step of plan.steps) {
      if (token.cancelled) return 'cancelled'
      await resync(bot)
      await craftStep(bot, step, job.station, token, agents.log)
    }
    if (token.cancelled) return 'cancelled'
    await resync(bot)
    if (job.station.tableOurs) await pickUpTable(bot, job.station, token)
    agents.say(bot, countOf(bot, 'wooden_axe') > 0 ? 'Made a wooden axe, keeping it to fight with' : "I couldn't craft a wooden axe, carrying on without it")
  } catch (err) {
    if (token.cancelled) return 'cancelled'
    agents.log(`${bot.username} wooden axe: ${err.message}`)
    agents.say(bot, "I couldn't craft a wooden axe, carrying on without it")
  }
  return token.cancelled ? 'cancelled' : 'done'
}

const RUN = { survey: runSurvey, take: runTake, ask: runAsk, walk: runWalk, hand: runHand, prep: runPrep, axe: runAxe }

class GoalStepMode extends Mode {
  constructor (ctx) {
    super('goalstep')
    this.profile = 'move'
    this.ctx = ctx
    this.token = null
    this.job = null
    this.running = null
  }

  onStart () {
    this.job = { ...this.params, got: new Map(), given: 0, said: false }
  }

  enter () {
    const job = this.job
    const token = { cancelled: false }
    this.token = token
    // a run a fight cancelled may still be inside its last await: the next one starts once it has settled
    const prev = this.running || Promise.resolve()
    const run = prev.catch(() => {}).then(() => token.cancelled ? 'cancelled' : RUN[job.step](this.ctx, job, token))
    this.running = run
    run.then(result => {
      if (this.token === token) this.token = null
      if (!token.cancelled && this.on && this.job === job) this.finish(result || 'done')
    }).catch(err => {
      if (this.token === token) this.token = null
      if (token.cancelled || !this.on || this.job !== job) return
      this.ctx.agents.log(`${this.ctx.bot.username} ${job.step}: ${err.message}`)
      this.finish('error')
    })
  }

  exit () {
    if (this.token) this.token.cancelled = true
    this.token = null
    try { this.ctx.bot.pathfinder.setGoal(null) } catch {}
  }

  describe () {
    const j = this.job
    if (!j) return 'working on a goal'
    return {
      survey: 'looking in the chests nearby',
      take: 'taking from a chest',
      ask: 'waiting for you to drop items',
      walk: `walking to ${j.to}`,
      hand: `handing over to ${j.to}`,
      prep: 'making fuel',
      axe: 'making a wooden axe'
    }[j.step]
  }
}

// Adds the mode to a bot's manager, once, right above the crafter
function addGoalStepMode (ctx) {
  const m = ctx.manager
  if (m.byName.has('goalstep')) return m.get('goalstep')
  const mode = new GoalStepMode(ctx)
  m.modes.splice(m.modes.indexOf(m.get('craft')), 0, mode)
  m.byName.set('goalstep', mode)
  return mode
}

module.exports = { GoalStepMode, addGoalStepMode, walkToPlayer, runAsk, runAxe, ASK_WAIT_MS }
