// The agents' fight skill: the project's trained fighting network. fight(bot, target) is the one entry point,
// so a later version (or a different network) only changes what runs behind it.
//
// Per decision: the bot's Fighter (bridge/fighter.js) builds the 130 inputs and the action mask, agents_policy.py picks
// an action (skill experts included), Fighter.act turns it into keys, then the bot waits ticks_per_step ticks (2 at 10
// decisions a second).
//
// In open terrain the Fighter works from the blocks this bot has seen, and the border input stays where the middle
// of an arena would put it. A target further than CHASE_FAR blocks is reached with pathfinder first (the network
// learned on a flat arena), and the network takes over within CHASE_NEAR.
// Before the fight has started (no hit either way yet, or none for LULL_TICKS) the bot closes in further, to OPEN_NEAR,
// the range where the network fights (aggressive to start a fight, then whatever works best). Training
// starts 25 to 27 blocks apart and every opponent walks in by itself, so the network never learned to open a fight
// against a mob or player that waits, and left alone at 8 to 16 blocks it loads and stands. In the
// simulator its melee hits land at 2.7 to 3.8 blocks and half its fighting steps are within 4.4, so it is handed
// the fight at 5. Once anyone is hit the wider range applies, so it can kite.

const { goals } = require('mineflayer-pathfinder')
const { Fighter, IDLE_ACTION, SLOT_AXE, SLOT_SWORD, SLOT_CROSSBOW, SLOT_BOW } = require('../../fighter')
const { friendInTheWay } = require('../targets')

const CHASE_FAR = 16
const CHASE_NEAR = 10
const OPEN_FAR = 6       // not fighting yet: chase when further than this
const OPEN_NEAR = 5      // and hand over to the network within this (GoalFollow stops at OPEN_NEAR - 1)
const LULL_TICKS = 100   // 5 s with no hit either way and the fight counts as not started again

// What the bot does at distance d: 'chase' (pathfinder) or 'fight' (the network). chasing is the chase in progress,
// engaged is true when someone was hit within LULL_TICKS
function approach (d, chasing, engaged) {
  if (!engaged) return d > OPEN_FAR || (chasing && d > OPEN_NEAR) ? 'chase' : 'fight'
  return d > CHASE_FAR || (chasing && d > CHASE_NEAR) ? 'chase' : 'fight'
}
const EYE = 1.62

// The axe kit the network trained with (without the arena's place-only blocks). Other inventories
// come with the general fighter later
const KIT_HOTBAR = [
  [SLOT_AXE, 'diamond_axe'],
  [SLOT_SWORD, 'diamond_sword'],
  [SLOT_CROSSBOW, 'crossbow'],
  [SLOT_BOW, 'bow']
]
const KIT_ARMOR = [['armor.head', 'diamond_helmet', 5], ['armor.chest', 'diamond_chestplate', 6],
  ['armor.legs', 'diamond_leggings', 7], ['armor.feet', 'diamond_boots', 8]]
const KIT_ARROWS = 6
const OFFHAND_SLOT = 45

class AgentFighter extends Fighter {
  constructor (bot) {
    super(bot, null)
    this.friends = null
  }

  // Arrows must not fly through a friend either: hold the draw, or hold a loaded crossbow, while one is in line
  lineBlocked () {
    const e = this.enemy.entity()
    if (!e || !this.friends) return false
    const me = this.bot.entity.position
    const others = Object.values(this.bot.entities).filter(x => x !== this.bot.entity)
    return !!friendInTheWay({ x: me.x, y: me.y + EYE, z: me.z }, e, others, this.friends)
  }

  useBow (pressed) {
    if (!pressed && this.drawing && this.lineBlocked()) pressed = true
    super.useBow(pressed)
  }

  useCrossbow (pressed) {
    if (pressed && !this.useHeld && this.loaded && this.lineBlocked()) pressed = false
    super.useCrossbow(pressed)
  }

  aimAt (target) {
    if (target.type === 'player' && target.username) {
      this.enemy.lookup = null
      this.enemy.username = target.username
    } else {
      this.enemy.username = null
      this.enemy.lookup = () => {
        const e = this.bot.entities[target.id]
        return e && e.isValid !== false ? e : null
      }
    }
    this.reset(true)
  }
}

// a version trained with fair health (stage fair_health) reads its own estimate of the
// enemy's health in the enemyHp input, as it trained, never the real health. The hello line says which (agents_policy.py).
// A player regenerates naturally on the agents server (vanilla default), a zombie is the plain vanilla one (fair_health.js
// ENEMY_KINDS basic). A version without it reads the real health
function fairKind (target) {
  if (!target || target.type === 'player') return 'player'
  return 'basic'
}

function setupFairHealth (fighter, info, target) {
  const kind = fairKind(target)
  fighter.setFairHealth(!!(info && info.fair), kind, kind === 'player')
}

function targetGone (bot, target) {
  const e = bot.entities[target.id]
  if (!e || e.isValid === false) return true
  const hp = e.metadata?.[9]
  return typeof hp === 'number' && hp <= 0
}

// Gives a bot the axe kit through the server console when it lacks it. Anything in the kit's hotbar slots or the
// offhand that is not the kit item is moved to a free inventory slot first, so nothing it carried is lost
async function ensureKit (bot, rcon, log = () => {}) {
  if (!rcon) return false
  const inv = bot.inventory
  const totals = () => {
    const t = {}
    for (const i of inv.items()) t[i.name] = (t[i.name] || 0) + i.count
    const off = inv.slots[OFFHAND_SLOT]
    if (off) t[off.name] = (t[off.name] || 0) + off.count
    return t
  }
  const before = totals()
  const displaced = new Set()
  const free = () => {
    for (let s = 9; s <= 35; s++) if (!inv.slots[s]) return s
    for (let s = 40; s <= 44; s++) if (!inv.slots[s]) return s  // hotbar slots 4 to 8
    return null
  }
  const cmds = []
  for (const [hot, name] of KIT_HOTBAR) {
    const slot = 36 + hot
    const item = inv.slots[slot]
    if (item?.name === name) continue
    if (item) {
      displaced.add(item.name)
      const to = free()
      if (to === null) { log(`${bot.username}: no room to move ${item.name} out of the kit slot`); continue }
      try { await bot.moveSlotItem(slot, to) } catch (err) { log(`${bot.username}: move ${item.name}: ${err.message}`) }
    }
    cmds.push(`item replace entity ${bot.username} hotbar.${hot} with ${name}`)
  }
  const off = inv.slots[OFFHAND_SLOT]
  if (off?.name !== 'shield') {
    if (off) {
      displaced.add(off.name)
      const to = free()
      if (to !== null) { try { await bot.moveSlotItem(OFFHAND_SLOT, to) } catch {} }
    }
    cmds.push(`item replace entity ${bot.username} weapon.offhand with shield`)
  }
  for (const [slot, name, win] of KIT_ARMOR) if (!inv.slots[win]) cmds.push(`item replace entity ${bot.username} ${slot} with ${name}`)
  const arrows = inv.items().filter(i => i.name === 'arrow').reduce((n, i) => n + i.count, 0)
  if (arrows < KIT_ARROWS) cmds.push(`give ${bot.username} arrow ${KIT_ARROWS - arrows}`)
  for (const c of cmds) await rcon.send(c)
  if (cmds.length) {
    log(`${bot.username}: kit topped up (${cmds.length} items)`)
    await bot.waitForTicks(10)
    // a move the server did not take (the live test lost a pickaxe this way) is given back by the console, so the
    // kit never costs the bot what it carried (damage and enchantments of such an item are not kept)
    const after = totals()
    for (const name of displaced) {
      const lost = (before[name] || 0) - (after[name] || 0)
      if (lost > 0) {
        await rcon.send(`give ${bot.username} ${name} ${lost}`)
        log(`${bot.username}: gave back ${lost} ${name}`)
      }
    }
  }
  return cmds.length > 0
}

// One agent's fight runner. agents.js makes one per bot and stores it as bot.agentsFight
class FightSkill {
  constructor (bot, policy, { friends, noDigMoves, log }) {
    this.bot = bot
    this.policy = policy
    this.fighter = new AgentFighter(bot)
    this.fighter.friends = friends
    this.noDigMoves = noDigMoves
    this.log = log || (() => {})
    this.target = null
    this.token = null
    this.done = null
  }

  // Starts fighting this entity. Resolves 'dead', 'gone', 'stopped' or 'no-brain' when the fight ends
  start (target) {
    if (this.target && this.target.id === target.id && this.token && !this.token.cancelled) return this.done
    this.stop()
    const token = { cancelled: false }
    this.token = token
    this.target = target
    this.done = this.loop(target, token).catch(err => {
      this.log(`${this.bot.username} fight: ${err.message}`)
      return 'error'
    }).finally(() => {
      // a newer fight may already own the keys, only the current one clears them
      if (this.token === token) {
        this.token = null
        this.target = null
        this.fighter.stopEverything()
      }
    })
    return this.done
  }

  stop () {
    if (this.token) this.token.cancelled = true
    // a chase in progress is this skill's goal, so it clears it here, before the next mode sets its own
    if (this.chasing && this.chasing === this.token) this.bot.pathfinder.setGoal(null)
    this.chasing = null
    this.token = null
    this.target = null
    this.fighter.stopEverything()
  }

  get fighting () { return !!this.token }

  async loop (target, token) {
    const bot = this.bot
    let info
    try {
      info = await this.policy.start()
    } catch (err) {
      return 'no-brain'
    }
    const ticksPerStep = Math.max(1, Math.round(20 / (info.rate || 10)))
    this.fighter.aimAt(target)
    setupFairHealth(this.fighter, info, target)
    let chasing = false
    let chaseRange = 0
    let ticks = 0
    let lastHit = -Infinity  // the tick of the last hit either way (Fighter counts arrow hits too)
    while (!token.cancelled) {
      if (targetGone(bot, target)) {
        if (chasing) bot.pathfinder.setGoal(null)
        return 'dead'
      }
      const live = bot.entities[target.id]
      const d = live.position.distanceTo(bot.entity.position)
      if (Math.min(this.fighter.ticksSinceHit, this.fighter.ticksSinceHurt) < ticksPerStep) lastHit = ticks
      const engaged = ticks - lastHit < LULL_TICKS
      if (approach(d, chasing, engaged) === 'chase') {
        const range = engaged ? CHASE_NEAR - 2 : OPEN_NEAR - 1
        if (!chasing || range !== chaseRange) {
          if (!chasing) this.fighter.stopEverything()
          chasing = true
          chaseRange = range
          this.chasing = token
          bot.pathfinder.setMovements(this.noDigMoves)
          bot.pathfinder.setGoal(new goals.GoalFollow(live, range), true)
        }
        await bot.waitForTicks(ticksPerStep)
        ticks += ticksPerStep
        continue
      }
      if (chasing) {
        chasing = false
        this.chasing = null
        bot.pathfinder.setGoal(null)
      }
      const obs = this.fighter.observe()
      const action = await this.policy.act(bot.username, obs, this.fighter.masks())
      if (token.cancelled) break
      this.fighter.act(action || IDLE_ACTION)
      await bot.waitForTicks(ticksPerStep)
      ticks += ticksPerStep
    }
    return 'stopped'
  }
}

// The single fight entry point: the bot fights this target with whatever runs behind FightSkill
function fight (bot, target) {
  return bot.agentsFight.start(target)
}

function stopFight (bot) {
  bot.agentsFight?.stop()
}

module.exports = { fairKind, setupFairHealth, fight, stopFight, ensureKit, FightSkill, AgentFighter, targetGone, KIT_HOTBAR, approach, OPEN_NEAR, OPEN_FAR }
