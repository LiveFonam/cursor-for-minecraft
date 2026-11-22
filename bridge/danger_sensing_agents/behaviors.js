// The agents' modes, highest priority first: escape, kill, retreat, avoid, guard, mobfight, defend, findfood, eat, give,
// come, resupply, craft, gather, build, mine, explore, farm, follow, guardpost, idle. Stop is not a mode, the manager checks it before
// any of these every tick (modes.js).
//
// Escape, retreat, avoid, mobfight, defend, findfood, eat and resupply are always on: they act whenever the danger
// assessor (threats.js, ctx.danger) says so, pausing whatever job runs below them, and the job carries on after. In a food
// emergency (findfood) the kill and guard orders wait too, so only the danger responses still outrank finding food.
//
// Every mode belongs to one skill profile, and reaches the game only through that profile's skill:
//   fight    kill, guard, defend          the trained network behind fight(bot, target) (skills/fight.js)
//   mobfight mobfight                     scripted melee against mobs with what it carries (skills/mob_fight.js)
//   survive  escape, retreat, avoid, findfood, eat, resupply
//                                         getting out of lava and fire, running, eating, gathering food, cooking and
//                                         food from its farm (skills/food.js, food_plan.js, food_mission.js, cook.js,
//                                         farm.js)
//   mine     mine                         scripted mining (skills/mine.js)
//   craft    craft                        the crafter role: craft requests from chat (skills/crafter.js)
//   gather   gather                       the gatherer role: wood, cobblestone, iron, diamonds (skills/gatherer.js)
//   build    build, farm                  blueprints, crafting and farming (skills/build.js, craft.js, farm.js)
//   move     give, come, explore, follow, guardpost
//                                         pathfinder walks (explore: skills/explore.js)
// The manager switches profiles as control moves between modes, so any one skill can later be swapped for a
// learned policy without touching the others.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { Mode, ModeManager } = require('./modes')
const { enemiesNear, pickFocus } = require('./targets')
const { fight, stopFight } = require('./skills/fight')
const { mobFight, stopMobFight, netCanFight } = require('./skills/mob_fight')
const { mineJob, goTo } = require('./skills/mine')
const { walkTo, rescueMoves } = require('./skills/move')
const { leaveLava } = require('./hazards')
const { HUNT_ENOUGH, foods, foodPointsCarried, foodSupply, supplyText, needsFood, eat, animalOnTheWay, huntOnTheWay, huntText, gaveUpOn, restockFood, GIVE_UP_MS } = require('./skills/food')
const { foodNeed, returnFood, eatReason, REGEN_FOOD, GO_DOWN_MARGIN, FOOD_RECOVERED, SPRINT_FOOD } = require('./skills/food_plan')
const { foodMission, foodBeforeDig, woodOnTheWay, ROAM_RING } = require('./skills/food_mission')
const { targetDepth, bringWood } = require('./skills/mine_branch')
const { buildJob } = require('./skills/build')
const { farmJob, foodFromFarm, nearestFarm } = require('./skills/farm')
const { exploreJob } = require('./skills/explore')
const { runCraftJob, planNow, dropsNear, GIVE_RANGE } = require('./skills/crafter')
const { torchPlan, topUpTorches } = require('./skills/torches')
const { LABEL, describeMissing, aOrAn } = require('./skills/crafter_plan')
const { gatherKind } = require('./skills/gatherer')
const { KINDS: GATHER_KINDS, tasksFromItems, carriedOf } = require('./skills/gather_kinds')
const { DangerAssessor, FOOD_RESERVE, CREEPER_SAFE, BOSS_RADIUS, survivesBlast } = require('./threats')
const { Announcer } = require('./announcer')
const { sleep } = require('./skills/human')

const KEEP = /(_pickaxe|_axe|_sword|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots)$|^(shield|bow|crossbow|arrow|torch)$/
const GIVE_MIN_RANGE = 1.5    // blocks from the owner, closer than this a thrown item flies past them
const GIVE_BACKUP_TICKS = 5   // about one block of walking backward
const GIVE_SETTLE_TICKS = 3   // for a turn to reach the server before the throw, the same wait the crafter uses
const VALUABLE = new Set(['diamond', 'emerald', 'debris', 'netherite', 'ancient_debris', 'gold'])
const SAFE_DISTANCE = 16
const RESUPPLY_RETRY_MS = 180000  // after a food run that came back short, wait this long before the next
const RESUPPLY_ROAM_MS = 180000   // one walk around for food and wood when no animal is close, then it looks again
const ROAM_RECHECK_MS = 5000      // danger close or just moved by the server: how soon it asks again
const ROAM_HOLD_MS = 15000        // after the server moves it, it stays put this long before it walks off again
const TELEPORT_BLOCKS = 4         // further than this between two looks is the server moving it, not a walk
const ROAM_BLOCKERS = new Set(['follow', 'guard', 'guardpost'])  // orders that keep it where it is
const RESUPPLY_ROUNDS = 4         // hunting rounds per food run, each up to 3 animals (skills/food.js)
const ESCAPE_RETRY_MS = 5000      // on fire with no water anywhere: let it burn out, look again after this
const LAVA_RETRY_MS = 250         // in lava a failed try is tried again almost at once
const HUNT_DURING = new Set(['gather', 'mine', 'explore'])  // jobs a short hunt may step into: no window open, nothing to hand over
const WORK_MODES = new Set(['give', 'come', 'goalstep', 'craft', 'gather', 'build', 'mine', 'explore', 'farm'])  // a job that ends: food never holds one up
const DEEP = 8                    // a job more than this far below where it started is underground
const FOOD_STOP_HOLD_MS = 60000   // after !stop it leaves food alone this long, even with none left
const FOOD_RETRY_MS = 5000        // a food mission that failed starts again after this
const FOOD_STAY_SAY_MS = 120000   // told to stay with no food: it says so this often
const POST_RANGE = 2              // this close to its guard post counts as on it
const POST_CHECK_MS = 1000        // after a walk back, how long before it checks the post again
const POST_RETRY_MS = 10000       // after a walk back that failed

function ownerEntity (ctx) {
  return ctx.bot.players[ctx.agents.owner]?.entity || null
}

const nameOf = e => e.username || (e.name || 'something').replace(/_/g, ' ')

// Told to !stay, or !stop a moment ago: no walking off for food
const foodHeld = ctx => !!ctx.staying || Date.now() < (ctx.foodHoldUntil || 0)
// A food emergency it is free to act on: orders that are not danger responses wait
const foodFirst = ctx => !!ctx.findFood?.urgent()

// Kill and guard share this: get the kit once, then fight whatever target() picks, switching when it changes
class FightMode extends Mode {
  constructor (name, ctx) {
    super(name)
    this.profile = 'fight'
    this.ctx = ctx
    this.focus = null
    this.kitReady = false
    this.kitAsked = false
    this.watched = null
  }

  onStart () {
    this.kitReady = false
    this.kitAsked = false
  }

  enter () {
    if (!this.kitAsked) {
      this.kitAsked = true
      this.ctx.agents.ensureKit(this.ctx.bot).finally(() => { this.kitReady = true })
    }
  }

  update () {
    if (!this.kitReady || !this.focus) return
    const done = fight(this.ctx.bot, this.focus)
    if (this.watched !== this.focus.id) {
      this.watched = this.focus.id
      const target = this.focus
      done.then(r => {
        if (r === 'dead') this.ctx.agents.event(this.ctx.bot, 'normal', `kill-${target.id}`, `Killed ${nameOf(target)}`)
        if (r === 'no-brain') this.ctx.agents.event(this.ctx.bot, 'key', 'no-brain', 'My fighting network is not running')
      })
    }
  }

  exit () {
    this.watched = null
    stopFight(this.ctx.bot)
  }
}

class KillMode extends FightMode {
  constructor (ctx) { super('kill', ctx) }

  onStart () {
    super.onStart()
    const bb = this.ctx.agents.blackboard
    bb.named = this.params.target || null
    bb.focusId = null
  }

  wants () {
    if (foodFirst(this.ctx)) return false  // the order stays on and carries on once it has eaten
    const { bot, agents } = this.ctx
    const owner = ownerEntity(this.ctx)
    const center = owner ? owner.position : bot.entity.position
    const list = enemiesNear(bot.entities, center, this.params.radius, agents.friends, bot.entity, agents.blackboard.named)
    const focus = pickFocus(list, center, agents.blackboard.named, agents.blackboard.focusId)
    if (!focus) {
      const named = agents.blackboard.named
      agents.announce(named ? `No ${named} within ${this.params.radius} blocks` : 'Area clear')
      this.focus = null
      this.finish('clear')
      return false
    }
    agents.blackboard.focusId = focus.id
    this.focus = focus
    return true
  }

  describe () {
    return `kill within ${this.params.radius}${this.focus ? ` on ${nameOf(this.focus)}` : ''}`
  }
}

// Holds the spot where the order was given: enemies within the radius of it get fought, one that runs further is left
// alone, and GuardPostMode walks back after. With a job running below, or told to !stay, it watches around itself
// instead. Protecting the owner is the always-on mob fight and defend modes, as on any other job
class GuardMode extends FightMode {
  constructor (ctx) {
    super('guard', ctx)
    this.post = null
  }

  onStart () {
    super.onStart()
    this.post = this.ctx.bot.entity.position.clone()
  }

  center () {
    const { bot, manager, staying } = this.ctx
    const below = manager.modes.slice(manager.modes.indexOf(this) + 1)
    return !this.post || staying || below.some(m => m.on && !m.always) ? bot.entity.position : this.post
  }

  wants () {
    if (foodFirst(this.ctx)) return false
    const { bot, agents } = this.ctx
    const list = enemiesNear(bot.entities, this.center(), this.params.radius, agents.friends, bot.entity)
    // the one it is fighting stays the target while it is in range, the nearest to the post may change as they move
    this.focus = list.includes(this.focus) ? this.focus : list[0] || null
    return !!this.focus
  }

  describe () { return `guarding within ${this.params.radius}${this.focus ? `, fighting ${nameOf(this.focus)}` : ''}` }
}

// The assessor says flee (a warden or wither near, low health with an enemy close, or too many enemies at once) and
// there is no kill order: run from the danger
class RetreatMode extends Mode {
  constructor (ctx) {
    super('retreat')
    this.profile = 'survive'
    this.ctx = ctx
    this.always = true
    this.threat = null
  }

  wants () {
    const { manager, danger } = this.ctx
    if (manager.get('kill').on && !foodFirst(this.ctx)) return false
    const flee = danger.report.flee
    this.flee = flee
    this.threat = flee?.from?.entity || null
    return !!this.threat
  }

  enter () {
    const { bot, agents } = this.ctx
    const boss = this.flee?.from?.kind === 'boss'
    agents.event(bot, boss ? 'key' : 'normal', boss ? 'retreat-boss' : 'retreat', boss ? `${this.flee.from.name} nearby, getting away` : `Retreating: ${this.flee?.reason || 'taking damage'}`)
    stopFight(bot)
    bot.pathfinder.setMovements(agents.noDigMoves(bot))
    this.following = null
  }

  update () {
    if (!this.threat || this.following === this.threat) return
    this.following = this.threat
    const range = this.flee?.from?.kind === 'boss' ? BOSS_RADIUS + 8 : SAFE_DISTANCE
    this.ctx.bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(this.threat, range)), true)
  }

  exit () {
    this.following = null
    this.ctx.bot.pathfinder.setGoal(null)
  }

  describe () { return `retreating${this.flee ? `: ${this.flee.reason}` : ''}` }
}

// A creeper within 6 blocks that the trained network cannot take: back off until it is 9 away. One that keeps following
// for 15 s gets fought instead (the assessor hands it to the mob fighter), since a hit knocks it back and stops its fuse
class AvoidMode extends Mode {
  constructor (ctx) {
    super('avoid')
    this.profile = 'survive'
    this.ctx = ctx
    this.always = true
    this.creeper = null
    this.following = null
  }

  wants () {
    this.creeper = this.ctx.danger.report.avoid?.entity || null
    return !!this.creeper
  }

  enter () {
    const { bot, agents } = this.ctx
    agents.event(bot, 'normal', 'avoid-creeper', 'Creeper close, backing off', 15000)
    stopFight(bot)
    bot.pathfinder.setMovements(agents.noDigMoves(bot))
    this.following = null
  }

  update () {
    if (!this.creeper || this.following === this.creeper) return
    this.following = this.creeper
    this.ctx.bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(this.creeper, CREEPER_SAFE + 1)), true)
  }

  exit () {
    this.following = null
    this.ctx.bot.pathfinder.setGoal(null)
  }

  describe () { return 'backing off from a creeper' }
}

// The mob fighting mode: a mob the assessor picked (one coming at it, in reach, shooting at it, that hit it, or one
// attacking the owner close by) gets the mob fighter, the trained mob network when it is available and the scripted
// melee otherwise (skills/mob_fight.js), with what the bot carries and no console kit. It
// senses danger without seeking it: the assessor only picks mobs that matter, and the job below carries on after
class MobFightMode extends Mode {
  constructor (ctx) {
    super('mobfight')
    this.profile = 'mobfight'
    this.ctx = ctx
    this.always = true
    this.pick = null
    this.focus = null
    this.watched = null
  }

  wants () {
    const p = this.ctx.danger.report.fight
    this.pick = p && p.entity && p.entity.type !== 'player' ? p : null
    this.focus = this.pick?.entity || null
    return !!this.focus
  }

  enter () {
    const { bot, agents } = this.ctx
    const p = this.pick
    if (p?.forOwner) agents.event(bot, 'normal', `defend-${p.entity.id}`, `Protecting you from ${p.name}`, 15000)
    this.watched = null
  }

  update () {
    const { bot, agents } = this.ctx
    if (!this.focus) return
    const target = this.focus
    // a creeper that cornered a bare bot gets the scripted hit and back off: the network has no blast check of its own
    const useNet = target.name !== 'creeper' || survivesBlast(bot)
    const done = mobFight(bot, target, { moves: agents.noDigMoves(bot), log: agents.log, useNet })
    if (this.watched === target.id) return
    this.watched = target.id
    done.then(r => {
      if (r === 'dead') agents.event(bot, 'normal', `kill-${target.id}`, `Killed ${nameOf(target)}`)
    })
  }

  exit () {
    this.watched = null
    stopMobFight(this.ctx.bot)
  }

  describe () { return `${this.pick?.name || 'a mob'} close, fighting` }
}

// Self defence against a player with no order needed: a player who is not a friend and hit it gets the trained
// network (mobs go to the mob fighting mode above). The assessor keeps the same target until it dies or stops
// mattering, and gives up on one it cannot reach in 20 s
class DefendMode extends FightMode {
  constructor (ctx) {
    super('defend', ctx)
    this.always = true
    this.pick = null
  }

  wants () {
    const p = this.ctx.danger.report.fight
    this.pick = p && p.entity && p.entity.type === 'player' ? p : null
    this.focus = this.pick?.entity || null
    return !!this.focus
  }

  enter () {
    const { bot, agents } = this.ctx
    const p = this.pick
    if (p) {
      const text = p.forOwner ? `Protecting you from ${p.name}` : `${p.name[0].toUpperCase()}${p.name.slice(1)} close, fighting it`
      agents.event(bot, 'normal', `defend-${p.entity.id}`, text, 15000)
    }
    // the kit again for every fight: it may have died, or used its arrows (ensureKit only adds what is missing)
    this.kitAsked = false
    this.kitReady = false
    super.enter()
  }

  describe () { return `defending against ${this.pick?.name || 'an enemy'}` }
}

// A mode that runs one async job and turns itself off when it ends. A higher mode taking over cancels the job,
// and the job starts again (keeping its progress) when the mode gets control back
class JobMode extends Mode {
  constructor (name, ctx, profile) {
    super(name)
    this.profile = profile
    this.ctx = ctx
    this.token = null
  }

  enter () {
    const token = { cancelled: false }
    this.token = token
    this.run(token).then(result => {
      if (!token.cancelled && (this.on || this.always)) {
        this.record(result || 'done')
        // a job the owner gave that ended well is said at once ("done: mining iron 3/3"), a meal is not news
        if ((result || 'done') === 'done' && !this.always) {
          try { this.ctx.announcer?.done(this.describe()) } catch {}
        }
        this.finish(result || 'done')
      }
      if (!token.cancelled) this.token = null
    }).catch(err => {
      this.ctx.agents.log(`${this.ctx.bot.username} ${this.name}: ${err.message}`)
      if (!token.cancelled) this.token = null
      if (!token.cancelled && (this.on || this.always)) {
        this.ctx.agents.event(this.ctx.bot, 'key', `${this.name}-failed`, `${this.name} failed: ${err.message}`.slice(0, 90))
        this.record('error', err.message)
        this.finish('error')
      }
    })
  }

  // A job cut short by !stop, !stay or another order is recorded too (the harness stops time capped runs)
  finish (result = 'done') {
    if (this.settle && (result === 'stopped' || result === 'off' || result === 'replaced') && this.job) this.record(result)
    // its food plan ends with it (the assessor's target goes back to the 2 bar floor)
    if (this.ctx?.foodJob?.mode === this.name) this.ctx.foodJob = null
    super.finish(result)
  }

  // How the job ended, for the live test harness (agents.js --metrics). Modes keep their numbers in this.job.stats
  record (result, error = null) {
    const { bot, agents } = this.ctx
    const p = bot.entity?.position
    agents.metric?.({
      bot: bot.username,
      job: this.name,
      result,
      error,
      params: this.params,
      stats: this.job?.stats || null,
      pos: p ? [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)] : null
    })
  }

  exit () {
    if (this.token) this.token.cancelled = true
    this.token = null
    const bot = this.ctx.bot
    bot.pathfinder.setGoal(null)
    try { bot.stopDigging() } catch {}
  }

  async run () { return 'done' }
}

// Hungry (or hurt and not fighting) with food in the bag: the food decision (food_plan.js decideFood) picks. Ready food
// is eaten first, raw food waits for the furnace while the bot keeps working, and it eats raw only as a last resort.
// Safe with the food bar under 18 it eats before it gets low, choosing food that fits without waste, so health keeps
// coming back and it never has to eat with a mob close. An order to come or give ends a cooking stop, and the food left
// in the furnace is collected after. Out of food: say so now and then
class EatMode extends JobMode {
  static DECIDE_MS = 1000  // the decision can look for a furnace, so it is not worked out on every tick

  constructor (ctx) {
    super('eat', ctx, 'survive')
    this.always = true
    this.retryAt = 0
    this.farmRetryAt = 0
    this.reason = null
    this.decision = null
    this.memo = null
    this.cooking = false
    require('./skills/cook').workFor(ctx)  // every food path shares it, with the job's coal protected
  }

  ownerOrderWaiting () {
    return ['come', 'give'].some(name => this.ctx.manager?.byName.get(name)?.on)
  }

  decide () {
    const { bot, danger } = this.ctx
    const safe = !!danger.report.safe
    const held = foodHeld(this.ctx)
    const work = require('./skills/cook').workFor(this.ctx)
    const bag = bot.inventory.items().map(i => `${i.name}:${i.count}`).join()
    const key = `${bot.food}|${Math.ceil(bot.health)}|${safe}|${held}|${!!work.smelting}|${work.noCookUntil || 0}|${bag}`
    const now = Date.now()
    if (this.memo?.key === key && now < this.memo.until) return this.memo.d
    const d = require('./skills/food').foodDecision(bot, { safe, work, walk: !held })
    this.memo = { key, until: now + EatMode.DECIDE_MS, d }
    return d
  }

  wants () {
    if (this.token) return !(this.cooking && this.ownerOrderWaiting())  // finish the bite in progress
    const { bot, agents, danger } = this.ctx
    if (Date.now() < this.retryAt) return false
    const d = this.decide()
    if (d.action === 'eat' || (d.action === 'cook' && !this.ownerOrderWaiting())) {
      this.decision = d
      this.reason = d.action === 'cook' ? 'cooking' : d.why
      return true
    }
    this.decision = null
    const reason = needsFood(bot, false) ? 'hungry' : eatReason(bot, !!danger.report.safe)
    if (!reason) return false
    this.reason = reason
    if (reason === 'top-up') return false  // nothing ready to eat, the raw food waits for the furnace
    if (!foods(bot).length) {
      // a farm the agents built feeds it (B5): ripe crops, the farm chest, bread from wheat
      if (bot.food < 14 && !foodHeld(this.ctx) && Date.now() >= this.farmRetryAt && nearestFarm(agents.farms(), bot.entity.position, 96)) return true
      if (bot.food < 14) agents.event(bot, 'key', 'no-food', 'I am low on food and have none', 120000)
      this.retryAt = Date.now() + 10000
      return false
    }
    // raw food and no reason to stop yet: it keeps working
    if (d.action === 'wait' && d.say) agents.event(bot, 'normal', 'food-wait', d.say, 120000)
    return false
  }

  async run (token) {
    const { bot, agents } = this.ctx
    const chosen = this.decision
    this.decision = null
    if (!chosen && !foods(bot).length) {
      agents.event(bot, 'normal', 'farm-food', 'Hungry, getting food from the farm', 60000)
      bot.pathfinder.setMovements(agents.buildMoves(bot))
      await foodFromFarm(bot, agents.farms(), token, { log: agents.log, foodPoints: () => foodPointsCarried(bot) })
      if (token.cancelled) return 'cancelled'
      if (!foods(bot).length) {
        this.farmRetryAt = Date.now() + 120000
        agents.event(bot, 'key', 'no-food', 'I am low on food and the farm has nothing ripe', 120000)
        return 'none'
      }
    }
    this.cooking = chosen?.action === 'cook'
    try {
      await require('./skills/food').feed(bot, token, {
        safe: () => !!this.ctx.danger.report.safe,
        work: require('./skills/cook').workFor(this.ctx),
        walk: () => !foodHeld(this.ctx),
        log: agents.log,
        say: (text, key) => {
          this.cooking = key === 'food-cook'
          if (this.cooking) bot.pathfinder.setMovements(agents.noDigMoves(bot))  // the walk to the furnace digs nothing
          agents.event(bot, 'normal', key, text, 30000)
        }
      })
    } catch (err) {
      this.retryAt = Date.now() + 10000
      throw err
    } finally {
      this.cooking = false
      this.memo = null  // what it just did changed the answer
    }
    return 'done'
  }

  describe () {
    const food = this.ctx.bot.food
    if (this.cooking) return `cooking food, food at ${food}`
    return `eating, food at ${food}${this.reason === 'top-up' ? ' (topping up while safe)' : ''}`
  }
}

// The food emergency (threats.js decides it, food_plan.js holds the thresholds): nothing usable in the bag and the bar
// low. Finding food is then the only work (skills/food_mission.js) until the bar is back. Only escape, retreat, avoid and
// the two fight responses run above it, and the job it interrupted carries on after. !stay keeps it where it is, and
// !stop holds it for a minute, because an order to stand still always wins
class FindFoodMode extends JobMode {
  constructor (ctx) {
    super('findfood', ctx, 'survive')
    this.always = true
    this.job = null
    this.announced = false
    this.life = 0
    this.retryAt = 0
    this.stayToldAt = 0
  }

  emergency () {
    const { bot, danger } = this.ctx
    return !!danger.report.foodEmergency && bot.food < FOOD_RECOVERED
  }

  urgent () { return this.emergency() && !foodHeld(this.ctx) }

  wants () {
    this.watch()
    return this.urgent()
  }

  // Keeps the mission going when a run ended with the emergency still on (a failure, after a short wait)
  update () {
    if (!this.token && Date.now() >= this.retryAt) this.enter()
  }

  // Says when the emergency starts and ends, whichever mode has control (the manager calls this every tick)
  watch () {
    const { bot, agents, danger } = this.ctx
    const on = this.emergency()
    if (on && !this.announced) {
      this.announced = true
      this.life = danger.lives
      agents.event(bot, 'key', 'food-emergency', `Out of food with my bar at ${bot.food}, finding food comes first`, 0)
    } else if (!on && this.announced) {
      this.announced = false
      this.job = null
      if (danger.lives === this.life) agents.event(bot, 'key', 'food-recovered', `Recovered, my food bar is at ${bot.food}`, 0)
    }
    if (on && this.ctx.staying && Date.now() >= this.stayToldAt) {
      this.stayToldAt = Date.now() + FOOD_STAY_SAY_MS
      agents.event(bot, 'key', 'food-stay', `I have no food and my bar is at ${bot.food}, staying here as told`, 0)
    }
  }

  async run (token) {
    const { bot, agents } = this.ctx
    if (!this.job) this.job = {}
    try {
      return await foodMission(bot, this.job, token, {
        recovered: () => bot.food >= FOOD_RECOVERED,
        step: (job, text, key = 'food-step') => {
          job.step = text
          agents.event(bot, 'normal', key, text, 20000)
        },
        log: agents.log,
        farms: () => (agents.farms ? agents.farms() : []),
        home: this.ctx.foodJob?.home || null,
        moves: { walk: agents.noDigMoves(bot), build: agents.buildMoves(bot) },
        safe: () => !!this.ctx.danger.report.safe,  // no furnace stop with danger near
        work: this.ctx.cookWork || (this.ctx.cookWork = {})
      })
    } catch (err) {
      this.retryAt = Date.now() + FOOD_RETRY_MS
      throw err
    }
  }

  describe () {
    const step = this.job?.step
    return `finding food, bar at ${this.ctx.bot.food}${step ? `: ${step}` : ''}`
  }
}

// In lava, on fire or with its head inside a block: get out. Water on its feet when it carries a bucket, else back
// to the last solid ground it stood on (in lava) or into water nearby (on fire), and digging the block at its head
class EscapeMode extends JobMode {
  constructor (ctx) {
    super('escape', ctx, 'survive')
    this.always = true
    this.retryAt = 0
  }

  wants () {
    if (this.token) return true
    return !!this.ctx.danger.report.escape && Date.now() >= this.retryAt
  }

  async run (token) {
    const { bot, agents, danger } = this.ctx
    const d = danger.report.escape
    if (!d) return 'done'
    const says = { lava: 'In lava, getting out', fire: 'On fire, putting it out', suffocation: 'Stuck in a block, digging out' }
    agents.event(bot, 'key', `escape-${d.kind}`, says[d.kind], 10000)
    stopFight(bot)
    if (d.kind === 'suffocation') return digOut(bot, token)
    if (await douseSelf(bot, token)) return 'done'
    if (token.cancelled) return 'cancelled'
    // lava takes a full bar in about 2.5 s: it swims for the nearest bank on its own keys, the path is only a fallback
    if (d.kind === 'lava' && await leaveLava(bot, token)) return 'done'
    if (token.cancelled) return 'cancelled'
    bot.pathfinder.setMovements(agents.noDigMoves(bot))
    const target = d.kind === 'lava' ? danger.safePos : waterNear(bot, 6)
    if (!target) {
      this.retryAt = Date.now() + (d.kind === 'lava' ? LAVA_RETRY_MS : ESCAPE_RETRY_MS)
      return 'nowhere'
    }
    bot.setControlState('jump', d.kind === 'lava')
    try {
      await goTo(bot, new goals.GoalNear(target.x, target.y, target.z, d.kind === 'lava' ? 0.5 : 0), token, 6000)
    } catch (err) {
      if (token.cancelled) return 'cancelled'
      this.retryAt = Date.now() + (d.kind === 'lava' ? LAVA_RETRY_MS : ESCAPE_RETRY_MS / 5)
    } finally {
      bot.setControlState('jump', false)
    }
    return 'done'
  }

  describe () { return `escaping ${this.ctx.danger.report.escape?.kind || 'danger'}` }
}

// Water on its own feet, then back in the bucket. True when it had a bucket to use
async function douseSelf (bot, token) {
  const bucket = bot.inventory.items().find(i => i.name === 'water_bucket')
  if (!bucket) return false
  await bot.equip(bucket, 'hand')
  await bot.look(bot.entity.yaw, -Math.PI / 2, true)
  await bot.waitForTicks(2)  // the look reaches the server before the use, it aims the bucket with it
  bot.activateItem()
  await sleep(1200)
  if (token.cancelled) return true
  const empty = bot.inventory.items().find(i => i.name === 'bucket')
  if (empty) {
    await bot.equip(empty, 'hand')
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    await bot.waitForTicks(2)
    bot.activateItem()
  }
  return true
}

// The block its head is in: dig it when it can, else jump
async function digOut (bot, token) {
  const p = bot.entity.position
  const head = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y + 1.62), Math.floor(p.z)))
  if (head && head.boundingBox === 'block' && (!bot.canDigBlock || bot.canDigBlock(head))) {
    try {
      await bot.dig(head)
      return 'done'
    } catch (err) {
      if (token.cancelled) return 'cancelled'
    }
  }
  bot.setControlState('jump', true)
  await sleep(500)
  bot.setControlState('jump', false)
  return 'jumped'
}

// The nearest water within r blocks (a cell it can stand in), or null
function waterNear (bot, r) {
  const f = bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position
  let best = null
  let bestD = Infinity
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const p = new Vec3(f.x + dx, f.y + dy, f.z + dz)
        if (bot.blockAt(p)?.name !== 'water') continue
        const d = dx * dx + dy * dy + dz * dz
        if (d < bestD) { best = p; bestD = d }
      }
    }
  }
  return best
}

// Food for later. During a job it never stops the work for a food run, however short the bag is: the job carries on and
// a food animal that is close, in sight and a short walk away gets a small detour (skills/food.js animalOnTheWay), even
// when the bot is not hungry, until the bag holds a sensible reserve. The check before a long dig is the job's own
// (foodBeforeLongDig). With no job it gets the food the reserve lacks: ripe crops, the chest and bread from a farm the
// agents built within 96 blocks, then hunting animals nearby and cooking. A run that comes back short walks on around the
// area for food and wood, and only waits 3 minutes when an order keeps it where it is.
// Never during danger, and not while told to !stay
class ResupplyMode extends JobMode {
  constructor (ctx) {
    super('resupply', ctx, 'survive')
    this.always = true
    this.retryAt = 0
    this.want = FOOD_RESERVE
    this.close = null
    this.walk = null
    this.roaming = false
    this.holdUntil = 0
    this.lastPos = null
  }

  // A jump between two looks is the server moving it: it does not walk off from where it was just put
  noteJump () {
    const p = this.ctx.bot.entity?.position
    if (!p) return
    if (this.lastPos && Math.hypot(p.x - this.lastPos.x, p.y - this.lastPos.y, p.z - this.lastPos.z) > TELEPORT_BLOCKS) {
      this.holdUntil = Date.now() + ROAM_HOLD_MS
    }
    this.lastPos = { x: p.x, y: p.y, z: p.z }
  }

  // Why it may not walk around for food right now: 'order' (told to stay near), 'wait' (danger, or just moved), or null
  roamBlock () {
    const { danger, manager } = this.ctx
    if (foodHeld(this.ctx) || manager.modes.some(m => m.on && ROAM_BLOCKERS.has(m.name))) return 'order'
    return !danger.report.safe || Date.now() < this.holdUntil ? 'wait' : null
  }

  wants () {
    const { bot, agents, danger, manager } = this.ctx
    this.noteJump()
    const working = !!this.ctx.foodJob || manager.modes.some(m => m.on && WORK_MODES.has(m.name))
    // a food run from before the order gives way to it, a hunt already under way finishes
    if (this.token) return !(this.fullRun && working) && !(this.roaming && this.roamBlock())
    const need = danger.report.resupply
    if (this.ctx.restocking) return false
    if (this.ctx.staying) {
      if (need) agents.event(bot, 'normal', 'resupply-stay', `${need.text || `Only ${need.carried} food points`}, staying here as told`, 300000)
      return false
    }
    if (foodHeld(this.ctx)) return false
    this.want = need?.want || FOOD_RESERVE
    if (working) {
      const active = manager.active
      if (!danger.report.safe || bot.currentWindow || (active && !active.always && !HUNT_DURING.has(active.name))) return false
      this.close = animalOnTheWay(bot, this.ctx.cookWork || null)
      return !!this.close
    }
    this.close = null
    return !!need && Date.now() >= this.retryAt
  }

  async run (token) {
    const { bot, agents } = this.ctx
    const work = require('./skills/cook').workFor(this.ctx)
    const points = () => foodSupply(bot, work).total
    const want = this.want
    const close = this.close
    this.close = null
    this.fullRun = !close
    bot.pathfinder.setMovements(agents.noDigMoves(bot))
    if (close) {
      agents.event(bot, 'normal', 'hunt-way', `A ${close.name.replace(/_/g, ' ')} close by, getting it for later`, 20000)
      const r = await huntOnTheWay(bot, close, token, agents.log)
      agents.log(`${bot.username} hunted a ${close.name} on the way: ${r} (${huntText(bot)})`)
      if (token.cancelled) return 'cancelled'
      if (r !== 'killed') gaveUpOn(bot).set(close.id, Date.now() + GIVE_UP_MS)
      return points() >= want ? 'done' : 'short'
    }
    agents.event(bot, 'normal', 'resupply', `${supplyText(foodSupply(bot, work), want)}, getting more`, 60000)
    const have = await restockFood(bot, token, {
      want,
      points,
      farms: () => (agents.farms ? agents.farms() : []),
      log: agents.log,
      say: text => agents.event(bot, 'normal', 'cooking', text, 30000),
      rounds: RESUPPLY_ROUNDS,
      work
    })
    if (token.cancelled) return 'cancelled'
    if (have < want) {
      const block = this.roamBlock()
      if (block === 'order') {
        this.retryAt = Date.now() + RESUPPLY_RETRY_MS
        agents.event(bot, 'normal', 'resupply-short', `${supplyText(foodSupply(bot, work), want)}, looking again in 3 minutes`, RESUPPLY_RETRY_MS)
        return 'short'
      }
      if (block) {
        this.retryAt = Date.now() + ROAM_RECHECK_MS
        return 'short'
      }
      agents.event(bot, 'normal', 'resupply-roam', `${supplyText(foodSupply(bot, work), want)}, walking around for food and wood`, RESUPPLY_ROAM_MS)
      const r = await this.roam(token, () => points() >= want, work)
      if (token.cancelled) return 'cancelled'
      if (r !== 'enough') return 'short'  // no wait: the next run looks close by again and walks on
    }
    agents.event(bot, 'normal', 'resupply-done', `Got food. ${supplyText(foodSupply(bot, work), want)}`, 60000)
    return 'done'
  }

  // Walks wider and wider rings around where it began, taking wood it passes and any animal that is close
  async roam (token, enough, work) {
    const { bot, agents, danger } = this.ctx
    const p = bot.entity.position
    if (this.walk?.center && Math.hypot(this.walk.center.x - p.x, this.walk.center.z - p.z) > ROAM_RING + 16) this.walk = null
    this.walk = this.walk || { maxRing: ROAM_RING, anchored: true }
    this.walk.spent = 0
    const ms = agents.roamMs ?? RESUPPLY_ROAM_MS
    this.roaming = true
    try {
      return await foodBeforeDig(bot, this.walk, token, {
        enough,
        minimum: () => false,
        collect: t => woodOnTheWay(bot, t, { log: agents.log, say: text => agents.event(bot, 'normal', 'resupply-wood', text, 30000) }),
        step: (job, text, key = 'food-step') => {
          job.step = text
          agents.event(bot, 'normal', key, text, 20000)
        },
        log: agents.log,
        farms: () => (agents.farms ? agents.farms() : []),
        moves: { walk: agents.noDigMoves(bot), build: agents.buildMoves?.(bot) },
        safe: () => !!danger.report.safe,
        work,
        searchMs: ms,
        maxMs: ms
      })
    } finally {
      this.roaming = false
    }
  }

  describe () { return `getting food, ${foodSupply(this.ctx.bot, this.ctx.cookWork || null).total} of ${this.want} points` }
}

// A small stock of torches from coal nothing else needs (skills/torches.js). Only at a quiet moment: safe, on the ground,
// no window open and no job at a station. It takes a second or two in the bag's own grid and never walks
class TorchMode extends JobMode {
  static LOOK_MS = 1000
  static RETRY_MS = 60000
  static MAX_MS = 10000

  constructor (ctx) {
    super('torches', ctx, 'survive')
    this.always = true
    this.nextLook = 0
    this.until = 0
    this.plan = null
  }

  wants () {
    if (this.token) return Date.now() < this.until
    const { bot, danger, manager } = this.ctx
    if (Date.now() < this.nextLook) return false
    if (!danger.report.safe || bot.currentWindow || this.ctx.restocking || bot.entity?.onGround === false) return false
    const active = manager.active
    if (active && !active.always && !HUNT_DURING.has(active.name)) return false
    this.nextLook = Date.now() + TorchMode.LOOK_MS
    this.plan = torchPlan(this.ctx)
    return !!this.plan
  }

  async run (token) {
    const { bot, agents } = this.ctx
    const plan = this.plan
    this.plan = null
    this.until = Date.now() + TorchMode.MAX_MS
    this.nextLook = Date.now() + TorchMode.RETRY_MS
    try {
      const made = await topUpTorches(this.ctx, token, plan)
      if (made > 0) agents.log(`${bot.username} made ${made} torches from spare coal`)
    } catch (err) {
      if (!token.cancelled) agents.log(`${bot.username} torches: ${err.message}`)
    }
    return token.cancelled ? 'cancelled' : 'done'
  }

  describe () { return 'making torches' }
}

// What the food in the bag and the bar above the sprint limit can pay for. The safe minimum for a dig is the way home from
// its depth with one fight's healing (returnFood): under it the miner's own check would turn straight back up
const foodToSpend = (ctx, bot) => foodSupply(bot, ctx.cookWork || null).total + Math.max(0, bot.food - SPRINT_FOOD)

// Before a long dig underground: enough food, or a bounded walk on the surface for it first. task keeps the search's
// progress across a fight or a meal. False when it was cancelled
async function foodBeforeLongDig (ctx, task, kind, token) {
  const { bot, agents } = ctx
  if (task.foodChecked || foodHeld(ctx)) return true
  const y = targetDepth(bot, kind)
  if (bot.entity.position.y - y <= DEEP) {
    task.foodChecked = true  // a short way down, or already there
    return true
  }
  const home = ctx.foodJob?.home || bot.entity.position
  const work = require('./skills/cook').workFor(ctx)
  const want = () => Math.min(HUNT_ENOUGH, Math.max(FOOD_RESERVE, ctx.foodJob?.need || 0))
  const enough = () => foodSupply(bot, work).total >= want()
  if (enough()) {
    task.foodChecked = true
    return true
  }
  const line = () => supplyText(foodSupply(bot, work), want())
  agents.event(bot, 'key', 'dig-food', `${line()}. Looking for food up here before the long dig`, 30000)
  task.foodSearch = task.foodSearch || {}
  const r = await foodBeforeDig(bot, task.foodSearch, token, {
    enough,
    minimum: () => foodToSpend(ctx, bot) >= returnFood(bot, home, { y }),
    collect: t => bringWood(bot, { say: text => agents.event(bot, 'normal', 'dig-food-wood', text, 30000), log: agents.log }, t, { blocks: GATHER_KINDS[kind]?.ores || [] }),
    step: (job, text, key = 'food-step') => {
      job.step = text
      agents.event(bot, 'normal', key, text, 20000)
    },
    log: agents.log,
    farms: () => (agents.farms ? agents.farms() : []),
    home,
    moves: { walk: agents.noDigMoves(bot), build: agents.buildMoves(bot) },
    safe: () => !!ctx.danger.report.safe,
    work,
    searchMs: agents.digSearchMs,
    maxMs: agents.digSearchMaxMs
  })
  if (r === 'cancelled' || token.cancelled) return false
  task.foodChecked = true
  if (r === 'enough') agents.event(bot, 'key', 'dig-food-done', `${line()}. Enough, going down`, 0)
  else if (r === 'minimum') agents.event(bot, 'key', 'dig-food-done', `${line()}. Searched long enough and it covers the way back, going down`, 0)
  else {
    // the turn-back would only send it straight up again: the bar and the food emergency look after it from here
    if (ctx.foodJob) ctx.foodJob.waived = true
    agents.event(bot, 'key', 'dig-food-done', `${line()}. No more food around here, going down on my food bar`, 0)
  }
  return true
}

// The food plan of a job (food_plan.js): how much it needs in the bag before it starts, kept in ctx.foodJob for the
// assessor's resupply target until the job ends (JobMode.finish clears it), and where it started
function planFood (ctx, mode, kind, count) {
  const { bot, agents } = ctx
  const plan = foodNeed(bot, kind, count)
  ctx.foodJob = { mode: mode.name, need: plan.points, home: bot.entity.position.clone() }
  agents.log(`${bot.username} food plan for ${count} ${kind}: ${plan.points} food points (${plan.trip.digs} blocks dug, ${plan.trip.heal} health healed, about ${plan.trip.minutes} min)`)
}

// The miner's food turn-back (mine_branch.js): low when the bag holds less than the way home from this depth costs,
// restock gets food at home and says whether there is enough to go back down to the face and up again
function foodHooks (ctx) {
  const { bot, agents } = ctx
  return {
    lowFood: job => {
      // nothing left to eat and the bar running down: stop and get food, wherever the job started
      if (foodPointsCarried(bot) === 0 && bot.food < 6) return true
      const home = job.home
      if (ctx.foodJob?.waived || !home || home.y - bot.entity.position.y <= DEEP) return false
      return foodToSpend(ctx, bot) < returnFood(bot, home)
    },
    restock: async (token, { face } = {}) => {
      const home = ctx.foodJob?.home || bot.entity.position
      // enough to go back down and up again, which can be more than the reserve
      const back = returnFood(bot, home, face) + GO_DOWN_MARGIN
      const want = Math.min(HUNT_ENOUGH, Math.max(FOOD_RESERVE, ctx.foodJob?.need || 0, back))
      const work = require('./skills/cook').workFor(ctx)
      agents.event(bot, 'normal', 'restock', `${supplyText(foodSupply(bot, work), want)}, getting food before I go back down`, 30000)
      bot.pathfinder.setMovements(agents.noDigMoves(bot))
      try {
        await restockFood(bot, token, {
          want,
          points: () => foodSupply(bot, work).total,
          farms: () => (agents.farms ? agents.farms() : []),
          log: agents.log,
          say: text => agents.event(bot, 'normal', 'cooking', text, 30000),
          rounds: RESUPPLY_ROUNDS,
          work
        })
      } finally {
        bot.pathfinder.setMovements(agents.digMoves(bot))
      }
      return foodSupply(bot, work).total >= back
    },
    restocking: on => { ctx.restocking = on }
  }
}

async function walkToOwner (ctx, token, range) {
  const owner = ownerEntity(ctx)
  if (!owner) return false
  const bot = ctx.bot
  bot.pathfinder.setMovements(ctx.agents.noDigMoves(bot))
  try {
    // a time limit, pathfinder.goto sometimes never settles (a !give hung for 90 s in the live test). Stuck, it gets
    // unstuck and tries again, the last try digging through natural ground and pillaring (skills/move.js)
    await walkTo(bot, new goals.GoalNear(owner.position.x, owner.position.y, owner.position.z, range), token, {
      ms: 30000,
      rescue: rescueMoves(bot),
      log: ctx.agents.log
    })
  } catch (err) {
    if (token.cancelled) return false
    const near = ownerEntity(ctx)?.position.distanceTo(bot.entity.position) <= 6
    if (!near) throw err
  }
  return !token.cancelled
}

class ComeMode extends JobMode {
  constructor (ctx) { super('come', ctx, 'move') }

  async run (token) {
    if (!ownerEntity(this.ctx)) {
      this.ctx.agents.say(this.ctx.bot, `I can't see you, ${this.ctx.agents.owner}`)
      return 'far'
    }
    await walkToOwner(this.ctx, token, 2)
    return 'done'
  }

  describe () { return 'coming to you' }
}

// Turns to the owner's chest and waits until the server has heard the turn, since it throws along the last facing it
// was told. Closer than GIVE_MIN_RANGE a throw flies past the owner, so it backs up to about 2 blocks first
async function faceOwnerChest (ctx, token) {
  const { bot } = ctx
  const owner = ownerEntity(ctx)
  if (!owner) return false
  await bot.lookAt(owner.position.offset(0, 1.2, 0), true)
  if (token.cancelled || typeof bot.waitForTicks !== 'function') return !token.cancelled
  if (owner.position.distanceTo(bot.entity.position) < GIVE_MIN_RANGE) {
    bot.setControlState('back', true)
    await bot.waitForTicks(GIVE_BACKUP_TICKS)
    bot.setControlState('back', false)
    if (token.cancelled) return false
    await bot.lookAt(owner.position.offset(0, 1.2, 0), true)
  }
  await bot.waitForTicks(GIVE_SETTLE_TICKS)
  return !token.cancelled
}

class GiveMode extends JobMode {
  constructor (ctx) { super('give', ctx, 'move') }

  async run (token) {
    const { bot, agents } = this.ctx
    if (!ownerEntity(this.ctx)) {
      agents.say(bot, `I can't see you, ${agents.owner}`)
      return 'far'
    }
    if (!await walkToOwner(this.ctx, token, 2)) return 'cancelled'
    // tools, weapons, armor, torches and some food stay with the bot
    const keepFood = foods(bot)[0]?.item
    const items = bot.inventory.items().filter(i => !KEEP.test(i.name) && i !== keepFood)
    if (!items.length) {
      agents.say(bot, 'Nothing to give')
      return 'done'
    }
    let n = 0
    for (const item of items) {
      if (token.cancelled) return 'cancelled'
      // the owner can move between stacks, so each throw gets its own turn and settle
      if (!await faceOwnerChest(this.ctx, token)) return token.cancelled ? 'cancelled' : 'far'
      await bot.tossStack(item)
      n += item.count
    }
    // step back so the owner collects the drop and the bot does not pick it up again
    if (typeof bot.waitForTicks === 'function') {
      bot.setControlState('back', true)
      await bot.waitForTicks(14)
      bot.setControlState('back', false)
    }
    agents.say(bot, `Dropped ${n} items`)
    return 'done'
  }

  describe () { return 'bringing you items' }
}

class MineMode extends JobMode {
  constructor (ctx) { super('mine', ctx, 'mine') }

  onStart () {
    // strategy 'tunnel' is the single tunnel miner, the mining benchmark's baseline (agents.js --miner tunnel)
    this.job = {
      block: this.params.block,
      blocks: this.params.blocks,
      count: this.params.count,
      mined: 0,
      strategy: this.ctx.agents.miner === 'tunnel' ? 'tunnel' : 'branch',
      home: null
    }
    planFood(this.ctx, this, this.params.block, this.params.count)
  }

  async run (token) {
    const { bot, agents, human } = this.ctx
    const job = this.job
    // food is checked once before a long way down, and the miner turns back by itself when the food for the way home
    // runs short
    if (!await foodBeforeLongDig(this.ctx, job, job.block, token)) return 'cancelled'
    bot.pathfinder.setMovements(agents.digMoves(bot))
    const r = await mineJob(bot, job, human, token, {
      ...foodHooks(this.ctx),
      say: text => agents.event(bot, 'normal', 'mine-note', text, 30000),
      log: agents.log,
      onMined: j => {
        const valuable = VALUABLE.has(j.block)
        agents.event(bot, valuable ? 'normal' : 'detail', `mined-${j.mined}`, `Found ${j.block} (${j.mined}/${j.count})`, 0)
      }
    })
    if (token.cancelled) return 'cancelled'
    if (r.message) agents.event(bot, 'key', `mine-${r.result}`, r.message, 0)
    if (r.result === 'full') setTimeout(() => this.ctx.manager.setOn('give', {}), 0)
    return r.result
  }

  describe () { return `mining ${this.job.block} ${this.job.mined}/${this.job.count}` }
}

// What the build and farm jobs need from the agents: chat, the log, the builds it knows, and the miner for coal
function jobHooks (ctx) {
  const { bot, agents, human } = ctx
  return {
    say: text => agents.event(bot, 'normal', 'job-note', text, 0),
    log: agents.log,
    builds: () => agents.builds.list(),
    farms: () => agents.farms(),
    register: job => agents.builds.add(bot, job),
    mine: async (blocks, count, token) => {
      const job = { block: blocks[0].replace(/^deepslate_/, '').replace(/_ore$/, ''), blocks, count, mined: 0, strategy: agents.miner, home: null, store: false }
      bot.pathfinder.setMovements(agents.digMoves(bot))
      try {
        await mineJob(bot, job, human, token, { say: t => agents.event(bot, 'normal', 'mine-note', t, 30000), log: agents.log })
      } finally {
        bot.pathfinder.setMovements(agents.buildMoves(bot))
      }
      return job.mined
    }
  }
}

// The crafter role: "craft me a stone pickaxe" (skills/crafter.js does the work, skills/crafter_plan.js the plan).
// One job at a time, the rest queued. A job's phase:
//   run        it has control and works (plans, crafts, smelts, walks over to hand it to the player)
//   waiting    the bag lacks materials: it lets lower modes run (follow) and looks at the bag again every second,
//              so materials the player hands over, or the gatherer brings, start it again on their own
//   gathering  the gatherer role (a mode named 'gather', see GATHER below) has the order for the missing materials
//   holding    made, but the player was out of reach: it keeps it and hands it over when they come close
// A fight takes control like from any job mode: the run is cancelled at its next await, and when the fight ends the
// next run looks at the bag again and carries on. job.made means the item exists, so no run crafts a second one.
//
// GATHER, the one integration point for the gatherer role. Register a mode named 'gather' in makeModes (anywhere
// below eat). The crafter turns it on with
//     manager.setOn('gather', { items: [{ name: 'cobblestone', count: 1 }], for: 'craft', requester })
// and waits for the promise setOn returns (it settles when the gather mode calls this.finish(result)). Whatever the
// result, the crafter then looks at the bag again: done means it carries on, still missing means it asks the player.
// Without a gather mode it asks the player in chat instead.
const CHECK_MS = 1000
const HOLD_RETRY_MS = 10000
const HOLD_RETRY_MAX_MS = 120000

class CraftMode extends Mode {
  constructor (ctx) {
    super('craft')
    this.profile = 'craft'
    this.ctx = ctx
    this.token = null
    this.job = null
    this.queue = []
    this.checkAt = 0
  }

  // A craft request from chat. The same item for the same player while one is pending is not a second job (a
  // repeated message or a retry never makes two). Returns 'started', 'queued', 'duplicate' or 'ready' (it was
  // holding that item, it goes to hand it over now)
  request ({ item, requester, keep = false }) {
    const same = [this.job, ...this.queue].find(j => j && j.item === item && j.requester === requester && !!j.keep === !!keep)
    if (same) {
      if (same.phase === 'holding') { same.retryAt = 0; same.handoffs = 0; return 'ready' }
      return 'duplicate'
    }
    const job = { item, requester, keep: !!keep, phase: 'run', made: false, given: false, missing: null, askedFor: null, retryAt: 0, table: null, tableOurs: false, furnace: null }
    job.done = new Promise(resolve => { job.settle = resolve })
    if (this.job) { this.queue.push(job); return 'queued' }
    this.start({ item, requester })  // start() first: it ends any old job, then this one is the job
    this.job = job
    return 'started'
  }

  wants () {
    const job = this.job
    if (!job) return false
    if (this.token) return true
    if (job.phase === 'run') return true
    if (job.phase === 'gathering') return false
    const now = Date.now()
    if (job.phase === 'holding') {
      const p = this.ctx.bot.players[job.requester]?.entity
      if (!p || now < job.retryAt) return false
      if (p.position.distanceTo(this.ctx.bot.entity.position) > GIVE_RANGE) return false
      job.phase = 'run'
      return true
    }
    // waiting: the bag again every second (cheap, the planner is pure)
    if (now < this.checkAt) return false
    this.checkAt = now + CHECK_MS
    const bot = this.ctx.bot
    if (!planNow(bot, job).missing.size || dropsNear(bot, job.missing).length) {
      job.phase = 'run'
      return true
    }
    return false
  }

  enter () { this.kick() }

  update () {
    if (!this.token && this.job && this.job.phase === 'run') this.kick()
  }

  kick () {
    const { bot, agents } = this.ctx
    const job = this.job
    if (!job || this.token) return
    const token = { cancelled: false }
    this.token = token
    const hooks = {
      log: agents.log,
      onMade: () => agents.log(`${bot.username} made ${aOrAn(LABEL[job.item])} for ${job.requester}`),
      // handing over a pickaxe is not a pickaxe breaking (agents.watchPickaxes counts again from here)
      onGiving: () => { this.ctx.pickaxes = null },
      onGiven: () => { this.ctx.pickaxes = null }
    }
    // a run a fight cancelled may still be inside its last await (a craft or a toss on its way to the server): the
    // next run starts only once it has settled, so two runs never craft side by side
    const prev = this.running || Promise.resolve()
    const run = prev.catch(() => {}).then(() => {
      if (token.cancelled) return { result: 'cancelled' }
      bot.pathfinder.setMovements(agents.noDigMoves(bot))
      return runCraftJob(bot, job, token, hooks)
    })
    this.running = run
    run.finally(() => { if (this.running === run) this.running = null }).catch(() => {})
    run.then(r => {
      if (this.token === token) this.token = null
      if (token.cancelled || this.job !== job) return
      this.after(job, r)
    }).catch(err => {
      if (this.token === token) this.token = null
      if (token.cancelled || this.job !== job) return
      agents.log(`${bot.username} craft ${job.item}: ${err.stack || err.message}`)
      agents.event(bot, 'key', 'craft-failed', `I couldn't craft the ${LABEL[job.item]}: ${err.message}`.slice(0, 200), 0)
      this.next(job, 'error', err.message)
    })
  }

  after (job, r) {
    const { bot, agents, manager } = this.ctx
    const label = LABEL[job.item]
    if (r.result === 'cancelled') return
    if (r.result === 'missing') {
      job.phase = 'waiting'
      this.checkAt = Date.now() + CHECK_MS
      const what = describeMissing(r.missing)
      if (job.askedFor === what) return  // asked for exactly this already
      job.askedFor = what
      const items = [...r.missing].map(([name, count]) => ({ name, count }))
      const them = r.missing.size > 1 || [...r.missing.values()][0] > 1 ? 'them' : 'it'
      // the gatherer gets two tries per job, then the player is asked
      job.gathers = job.gathers || 0
      if (manager.byName.has('gather') && job.gathers < 2) {
        job.gathers++
        job.phase = 'gathering'
        agents.say(bot, `For the ${label} I need ${what}, gathering it`)
        manager.setOn('gather', { items, for: 'craft', requester: job.requester }).then(res => {
          if (this.job !== job || job.phase !== 'gathering') return
          agents.log(`${bot.username} gather for ${label} ended: ${res}`)
          // run again: it carries on, or says what is still missing (the gatherer again, or the player)
          job.phase = 'run'
          job.askedFor = null
        })
      } else if (job.gathers) {
        agents.say(bot, `The gatherer couldn't get it all. For the ${label} I still need ${what}, bring ${them} to me and I'll carry on`)
      } else {
        agents.say(bot, `For the ${label} I need ${what} more. Bring ${them} to me and I'll carry on`)
      }
      return
    }
    if (r.result === 'far') {
      job.phase = 'holding'
      // a player who keeps not picking it up is asked less and less often
      job.retryAt = Date.now() + Math.min(HOLD_RETRY_MS * 2 ** (job.handoffs || 0), HOLD_RETRY_MAX_MS)
      if (!job.saidReady) agents.say(bot, `${job.requester}, your ${label} is ready, I'm keeping it until you're close`)
      job.saidReady = true
      return
    }
    if (r.result === 'given') {
      agents.say(bot, `Here's your ${label}, ${job.requester}`)
      this.next(job, 'done')
    }
    if (r.result === 'dropped') {
      agents.say(bot, `${job.requester}, I dropped your ${label} by you, but I never saw you pick it up`)
      this.next(job, 'dropped')
    }
    if (r.result === 'kept') {
      agents.say(bot, `Made ${aOrAn(label)}, keeping it`)
      this.next(job, 'done')
    }
  }

  // This job is over: the next one in the queue, or the mode turns off
  next (job, result, error = null) {
    this.recordJob(job, result, error)
    job.settle?.(result)
    if (this.job !== job) return
    this.job = this.queue.shift() || null
    if (!this.job) { this.finish(result); return }
    this.job.phase = 'run'
    this.ctx.agents.say(this.ctx.bot, `Now the ${LABEL[this.job.item]} for ${this.job.requester}`)
  }

  recordJob (job, result, error) {
    const { bot, agents } = this.ctx
    agents.metric?.({ bot: bot.username, job: 'craft', result, error, params: { item: job.item, requester: job.requester }, stats: job.stats || null })
  }

  // !stop or another order ends every job, made or not (an item it made stays in its bag)
  finish (result = 'done') {
    if (result === 'stopped' || result === 'off' || result === 'replaced') {
      for (const j of [this.job, ...this.queue]) if (j && j.settle) { this.recordJob(j, result); j.settle(result) }
      this.job = null
      this.queue = []
    }
    super.finish(result)
  }

  exit () {
    if (this.token) this.token.cancelled = true
    this.token = null
    const bot = this.ctx.bot
    bot.pathfinder.setGoal(null)
    try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
  }

  describe () {
    const j = this.job
    if (!j) return 'crafting nothing'
    const label = LABEL[j.item]
    if (j.phase === 'waiting') return `waiting for ${describeMissing(j.missing || new Map())} to craft ${aOrAn(label)}`
    if (j.phase === 'gathering') return `gathering ${describeMissing(j.missing || new Map())} for ${aOrAn(label)}`
    if (j.phase === 'holding') return `holding ${aOrAn(label)} for ${j.requester}`
    return `crafting ${aOrAn(label)} for ${j.requester}`
  }
}

// The gatherer role: !gather wood|cobblestone|iron|diamonds [count], and the crafter's order for missing materials
// (manager.setOn('gather', { items: [{ name, count }], for: 'craft', requester }), see GATHER above). Each kind is one
// scripted skill (skills/gatherer.js). Several kinds run in order. "count more" means more than the bag held when
// the order came, so a fight or a meal in the middle does not change the target, and the job carries on after.
// It keeps everything it gathers in the bag (the crafter, or !give, takes it from there)
class GatherMode extends JobMode {
  constructor (ctx) { super('gather', ctx, 'gather') }

  onStart () {
    const p = this.params
    const { tasks, unknown } = p.items ? tasksFromItems(p.items) : { tasks: [{ kind: p.kind, count: p.count, ...(p.takeEasy ? { takeEasy: p.takeEasy } : {}) }], unknown: [] }
    this.job = { tasks: tasks.map(t => ({ ...t, start: null, got: 0 })), unknown, index: 0, for: p.for || null }
    // the food plan of its longest trip (the tasks run one after another, with a food run between when short)
    const biggest = this.job.tasks.slice().sort((a, b) => foodNeed(this.ctx.bot, b.kind, b.count).points - foodNeed(this.ctx.bot, a.kind, a.count).points)[0]
    if (biggest) planFood(this.ctx, this, biggest.kind, biggest.count)
  }

  async run (token) {
    const { bot, agents, human } = this.ctx
    const job = this.job
    if (job.unknown.length) agents.log(`${bot.username} gather: nothing gathers ${job.unknown.join(', ')}`)
    if (!job.tasks.length) return 'unknown'
    for (; job.index < job.tasks.length; job.index++) {
      const t = job.tasks[job.index]
      const k = GATHER_KINDS[t.kind]
      const have = () => carriedOf(bot.inventory.items(), t.kind)
      const resumed = t.start !== null
      if (t.start === null) {
        t.start = have()
        agents.event(bot, 'normal', `gather-${t.kind}`, `Gathering ${t.count} ${k.unit}${job.for === 'craft' ? ' for crafting' : ''}`, 0)
      }
      const left = t.start + t.count - have()
      if (left <= 0) continue
      if (GATHER_KINDS[t.kind]?.ores && !await foodBeforeLongDig(this.ctx, t, t.kind, token)) return 'cancelled'
      bot.pathfinder.setMovements(t.kind === 'wood' ? agents.noDigMoves(bot) : agents.digMoves(bot))
      const r = await gatherKind(bot, t.kind, left, token, {
        ...foodHooks(this.ctx),
        master: () => ownerEntity(this.ctx)?.position || null,
        ...(t.takeEasy ? { takeEasy: t.takeEasy - (have() - t.start) } : {}),  // the cap covers the whole task, also after a fight
        ...(resumed ? { toolCtx: (t.toolCtx ??= {}) } : {}),  // kept on the task, so a fight never makes two pickaxes
        digMoves: () => agents.digMoves(bot),
        say: text => agents.event(bot, 'normal', 'gather-note', text, 30000),
        log: agents.log,
        human,
        miner: agents.miner,
        onMined: j => agents.event(bot, 'detail', `gather-mined-${j.mined}`, `Found ${k.label} (${j.mined}/${j.count})`, 0)
      })
      t.got = have() - t.start
      if (token.cancelled) return 'cancelled'
      if (r.result !== 'done') {
        agents.event(bot, 'key', `gather-${r.result}`, r.message, 0)
        return r.result
      }
    }
    const summary = job.tasks.map(t => `${Math.max(0, t.got)} ${GATHER_KINDS[t.kind].unit}`).join(', ')
    agents.event(bot, 'key', 'gather-done', `Gathered ${summary}`, 0)
    return 'done'
  }

  describe () {
    const t = this.job?.tasks?.[this.job.index]
    if (!t) {
      const list = this.job?.tasks || []
      return list.length ? `gathered ${list.map(x => `${Math.max(0, x.got)} ${GATHER_KINDS[x.kind].unit}`).join(', ')}` : 'gathering'
    }
    const got = t.start === null ? 0 : Math.max(0, carriedOf(this.ctx.bot.inventory.items(), t.kind) - t.start)
    return `gathering ${GATHER_KINDS[t.kind].label} ${got}/${t.count}${this.job.for === 'craft' ? ' for crafting' : ''}`
  }
}

// Builds a blueprint (and !expand, which builds the bigger blueprint over the old one)
class BuildMode extends JobMode {
  constructor (ctx) { super('build', ctx, 'build') }

  onStart () {
    this.job = { blueprint: this.params.blueprint, anchor: this.params.anchor, facing: this.params.facing, modules: this.params.modules || 1, crop: this.params.crop || null }
  }

  async run (token) {
    const { bot, agents } = this.ctx
    this.job.hooks = jobHooks(this.ctx)
    bot.pathfinder.setMovements(agents.buildMoves(bot))
    const r = await buildJob(bot, this.job, token)
    if (token.cancelled) return 'cancelled'
    if (r.message) agents.event(bot, 'key', `build-${r.result}`, r.message, 0)
    return r.result
  }

  describe () { return `building ${this.job?.blueprint?.name}, ${this.job?.stats?.placed || 0} blocks placed` }
}

// Tends a farm forever: harvest, replant, store. With here and no farm there, builds the village wheat farm first
class FarmMode extends JobMode {
  constructor (ctx) { super('farm', ctx, 'build') }

  onStart () {
    this.job = { crop: this.params.crop, here: this.params.here || null, facing: this.params.facing || null, farm: null, maxCycles: this.params.maxCycles || 0 }
  }

  async run (token) {
    const { bot, agents } = this.ctx
    const job = this.job
    job.hooks = {
      ...jobHooks(this.ctx),
      build: async (name, anchor, facing, tok, crop) => {
        const b = agents.loadBlueprint(name)
        if (!b) return { result: 'unknown', message: `I have no blueprint called ${name}` }
        const bjob = { blueprint: b, anchor, facing: facing || b.facing, modules: 1, crop, hooks: jobHooks(this.ctx) }
        this.buildJob = bjob
        const r = await buildJob(bot, bjob, tok)
        if (r.message && !tok.cancelled) agents.event(bot, 'key', `build-${r.result}`, r.message, 0)
        return { ...r, record: bjob.record || null }
      }
    }
    bot.pathfinder.setMovements(agents.buildMoves(bot))
    const r = await farmJob(bot, job, token)
    if (token.cancelled) return 'cancelled'
    if (r.message) agents.event(bot, 'key', `farm-${r.result}`, r.message, 0)
    return r.result
  }

  describe () {
    const s = this.job?.stats
    return `farming ${this.job?.crop}${s ? `, ${s.harvested} harvested, ${s.stored} stored` : ''}`
  }
}

class ExploreMode extends JobMode {
  constructor (ctx) { super('explore', ctx, 'move') }

  onStart () {
    this.job = { radius: this.params.radius, start: null, found: [] }
  }

  async run (token) {
    const { bot, agents, human } = this.ctx
    bot.pathfinder.setMovements(agents.noDigMoves(bot))
    const r = await exploreJob(bot, this.job, human, token, {
      say: (text, o = {}) => agents.event(bot, 'normal', o.key || 'explore-note', text, 0),
      log: agents.log,
      moves: agents.noDigMoves(bot)
    })
    if (token.cancelled) return 'cancelled'
    if (r.message) agents.event(bot, 'key', `explore-${r.result}`, r.message, 0)
    return r.result
  }

  describe () { return `exploring within ${this.job?.radius}, ${this.job?.found?.length || 0} finds` }
}

class FollowMode extends Mode {
  constructor (ctx) {
    super('follow')
    this.profile = 'move'
    this.ctx = ctx
    this.following = null
  }

  wants () { return !!ownerEntity(this.ctx) }

  enter () { this.following = null }

  update () {
    const owner = ownerEntity(this.ctx)
    if (!owner || owner === this.following) return
    const bot = this.ctx.bot
    bot.pathfinder.setMovements(this.ctx.agents.noDigMoves(bot))
    bot.pathfinder.setGoal(new goals.GoalFollow(owner, 2), true)
    this.following = owner
  }

  exit () {
    this.following = null
    this.ctx.bot.pathfinder.setGoal(null)
  }

  describe () { return 'following you' }
}

// Back to the guard post once nothing else wants the bot: below every job, so a fight, a meal, an order or !follow
// always comes first, and never while told to !stay
class GuardPostMode extends JobMode {
  constructor (ctx) {
    super('guardpost', ctx, 'move')
    this.always = true
    this.retryAt = 0
  }

  wants () {
    const { bot, manager, staying } = this.ctx
    const guard = manager.get('guard')
    if (!guard.on || !guard.post || staying) return false
    if (this.token) return true
    return Date.now() >= this.retryAt && bot.entity.position.distanceTo(guard.post) > POST_RANGE
  }

  record () {}  // a walk back is not a job of its own in the metrics

  async run (token) {
    const { bot, agents, manager } = this.ctx
    const post = manager.get('guard').post
    this.retryAt = Date.now() + POST_CHECK_MS
    bot.pathfinder.setMovements(agents.noDigMoves(bot))
    try {
      await walkTo(bot, new goals.GoalNear(post.x, post.y, post.z, 1), token, { ms: 30000, tries: 1, log: agents.log })
    } catch (err) {
      if (token.cancelled) return 'cancelled'
      this.retryAt = Date.now() + POST_RETRY_MS
      agents.event(bot, 'normal', 'guard-post', `I can't get back to my post: ${err.message}`.slice(0, 90), 60000)
      return 'far'
    }
    return 'done'
  }

  describe () { return 'walking back to my guard post' }
}

class IdleMode extends Mode {
  constructor () {
    super('idle')
    this.always = true
  }
}

function makeModes (ctx) {
  // the food to carry is the running job's plan, at least the reserve (threats.js FOOD_RESERVE). The network takes a
  // creeper only in armor that outlasts the blast: bare, it backs off, and hits it only when cornered
  if (!ctx.danger) ctx.danger = new DangerAssessor(ctx.bot, { friends: ctx.agents.friends, owner: ctx.agents.owner, reserve: () => ctx.foodJob?.need || 0, cookWork: () => ctx.cookWork || null, netFights: e => netCanFight(ctx.bot, e, { log: ctx.agents.log }) && (e.name !== 'creeper' || survivesBlast(ctx.bot)) })
  // what it is doing, said in chat (announcer.js). Skills reach it through bot.agentsAnnounce
  if (!ctx.announcer) {
    ctx.announcer = new Announcer({
      say: text => ctx.agents.say(ctx.bot, text),
      current: () => ctx.manager ? ctx.manager.status() : 'idle',
      log: ctx.agents.log || (() => {})
    })
  }
  ctx.bot.agentsAnnounce = ctx.announcer
  const findFood = new FindFoodMode(ctx)
  ctx.findFood = findFood
  const manager = new ModeManager([
    new EscapeMode(ctx),
    new KillMode(ctx),
    new RetreatMode(ctx),
    new AvoidMode(ctx),
    new GuardMode(ctx),
    new MobFightMode(ctx),
    new DefendMode(ctx),
    findFood,
    new EatMode(ctx),
    new GiveMode(ctx),
    new ComeMode(ctx),
    new ResupplyMode(ctx),
    new CraftMode(ctx),
    new TorchMode(ctx),
    new GatherMode(ctx),
    new BuildMode(ctx),
    new MineMode(ctx),
    new ExploreMode(ctx),
    new FarmMode(ctx),
    new FollowMode(ctx),
    new GuardPostMode(ctx),
    new IdleMode()
  ], {
    log: text => ctx.agents.log(`${ctx.bot.username}: ${text}`),
    stopAll: () => {
      if (findFood.emergency()) {
        ctx.foodHoldUntil = Date.now() + FOOD_STOP_HOLD_MS
        ctx.agents.event(ctx.bot, 'key', 'food-hold', 'Stopped. I still have no food, I will look again in a minute unless you say !stay', 30000)
      }
      ctx.agents.stopAll(ctx.bot)
    },
    profileChanged: (prev, next) => ctx.agents.profileChanged(ctx, prev, next),
    modeChanged: (prev, next) => {
      let text = 'idle'
      try { text = next ? next.describe() : 'idle' } catch { text = next ? next.name : 'idle' }
      // a job getting control back after a fight or a meal
      if (next && !next.always && next.entries > 1) text = `back to ${text}`
      ctx.announcer.modeChanged(next ? next.name : 'idle', text)
    },
    ticked: () => {
      findFood.watch()
      ctx.announcer.tick(ctx.bot)
    }
  })
  ctx.manager = manager
  return manager
}

module.exports = { makeModes, foodBeforeLongDig, TorchMode, CraftMode, GatherMode, KillMode, GuardMode, GuardPostMode, RetreatMode, AvoidMode, MobFightMode, DefendMode, EscapeMode, FindFoodMode, ResupplyMode, EatMode, MineMode, BuildMode, FarmMode, ExploreMode, FollowMode, ComeMode, GiveMode, IdleMode, KEEP, jobHooks, foodHooks, planFood }
