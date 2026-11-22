// The mob fighter: the skill behind the mob fighting mode (MobFightMode in behaviors.js). With useNet it fights with the
// trained mob network (skills/mob_net.js) when that is available, and otherwise with the scripted melee below, and the
// log says which one and why. Scripted melee uses whatever the bot carries, no console kit, the way a survival player
// answers a zombie that walks into the tunnel.
//
//   weapon   its axe by default, a sword only of a better material, else the most damage per second, else its fist
//   reach    it closes to about 2 blocks and swings only once the weapon has recharged, so every hit lands in full
//   creeper  a hit knocks it back and resets the fuse, then it backs off a few blocks, and backs away at once when
//            the creeper swells within 4 blocks
//   shield   in the offhand when it carries one, raised while a skeleton draws at it from range or a creeper swells
//            close, lowered to swing
//
// The danger assessor (threats.js) decides what is worth fighting, when to stop and when to run, so this only fights.

const { goals } = require('mineflayer-pathfinder')
const { guardHazards } = require('./move')
const { fightWithNet, sharedMobNet, bestAxe } = require('./mob_net')
const { KIND_OF } = require('./mob_inputs')
const { bestAxeItem } = require('./gather_kinds')

const REACH = 3.0           // a player's attack reach on a mob in Java Edition
const CLOSE = 2             // the follow distance while closing in
const BACK_OFF = 5          // how far it backs off from a creeper after a hit
const BACK_TICKS = 16       // how long that takes before it closes in again
const SWELL_RANGE = 4       // a swelling creeper this close: back away now
const SHIELD_RANGE = 4      // a drawing skeleton further than this: shield up
// Attack damage and attacks per second, Minecraft Wiki (Java Edition) Sword, Axe, Pickaxe, Shovel, Trident, Mace
const MELEE = {
  netherite_sword: [8, 1.6], diamond_sword: [7, 1.6], iron_sword: [6, 1.6], stone_sword: [5, 1.6], golden_sword: [4, 1.6], wooden_sword: [4, 1.6],
  netherite_axe: [10, 1], diamond_axe: [9, 1], iron_axe: [9, 0.9], stone_axe: [9, 0.8], golden_axe: [7, 1], wooden_axe: [7, 0.8],
  netherite_pickaxe: [6, 1.2], diamond_pickaxe: [5, 1.2], iron_pickaxe: [4, 1.2], stone_pickaxe: [3, 1.2], golden_pickaxe: [2, 1.2], wooden_pickaxe: [2, 1.2],
  netherite_shovel: [6.5, 1], diamond_shovel: [5.5, 1], iron_shovel: [4.5, 1], stone_shovel: [3.5, 1], golden_shovel: [2.5, 1], wooden_shovel: [2.5, 1],
  trident: [9, 1.1],
  mace: [6, 0.6]
}
const FIST = [1, 4]
// Entity metadata in 1.21: 8 holds the living entity's hand flags (bit 1 is using an item, a skeleton drawing its
// bow), 9 its health, 16 a creeper's fuse state (1 while it swells)
const HAND = 8
const HEALTH = 9
const SWELL = 16
const OFFHAND = 45
const HOTBAR = 36           // the first hotbar slot in the player inventory window
const isFood = (bot, item) => !!item && !!bot.registry?.foodsByName?.[item.name]

// The weapon for a fight: { item, damage, speed, cooldown } with cooldown in ticks, item null for the fist. The axe by
// default, it is what the bot keeps for fights and saves the pickaxe from wear. Only a sword of a better material beats
// it. With no axe, the most damage per second, a pickaxe or shovel last on a tie (they wear out digging)
const MATERIAL = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }
const materialOf = name => MATERIAL[name.split('_')[0]] ?? 0
function bestWeapon (bot) {
  const items = bot.inventory.items()
  const axe = bestAxeItem(items.filter(i => MELEE[i.name]))
  const betterSword = axe && items.some(i => /_sword$/.test(i.name) && MELEE[i.name] && materialOf(i.name) > materialOf(axe.name))
  if (axe && !betterSword) {
    const m = MELEE[axe.name]
    return { item: axe, damage: m[0], speed: m[1], cooldown: Math.ceil(20 / m[1]) }
  }
  let best = { item: null, damage: FIST[0], speed: FIST[1] }
  let bestDps = FIST[0] * FIST[1]
  for (const item of items) {
    const m = MELEE[item.name]
    if (!m) continue
    const dps = m[0] * m[1] - (/_(pickaxe|shovel)$/.test(item.name) ? 0.01 : 0)
    if (dps > bestDps) { best = { item, damage: m[0], speed: m[1] }; bestDps = dps }
  }
  best.cooldown = Math.ceil(20 / best.speed)
  return best
}

function liveTarget (bot, target) {
  const e = bot.entities[target.id]
  if (!e || e.isValid === false) return null
  const hp = e.metadata?.[HEALTH]
  if (typeof hp === 'number' && hp <= 0) return null
  return e
}

const swelling = e => e.name === 'creeper' && e.metadata?.[SWELL] === 1
const drawing = e => /^(skeleton|stray|bogged|parched|pillager)$/.test(e.name) && !!((e.metadata?.[HAND] ?? 0) & 0x01)

// One bot's mob fights. agentsMobFight(bot) makes it on first use
class MobFighter {
  constructor (bot, { log = () => {} } = {}) {
    this.bot = bot
    this.log = log
    this.token = null
    this.target = null
    this.done = null
    this.shieldUp = false
    this.stats = { fights: 0, swings: 0, kills: 0 }
    this.brain = null
    this.netDriver = null
  }

  // Logs which fighter is in use, each time it changes
  note (brain) {
    if (brain === this.brain) return
    this.brain = brain
    this.log(`${this.bot.username} mob fighter: ${brain}`)
  }

  get fighting () { return !!this.token }

  // Fights this entity until it dies or the fight is stopped. Resolves 'dead', 'gone' (dead before it began) or 'stopped'
  start (target, { moves = null, net = null, useNet = false } = {}) {
    if (this.target && this.target.id === target.id && this.token && !this.token.cancelled) return this.done
    this.stop()
    const token = { cancelled: false }
    this.token = token
    this.target = target
    this.stats.fights++
    const brain = net || (useNet ? sharedMobNet(this.log) : null)
    this.done = this.loop(target, token, moves, brain).catch(err => {
      this.log(`${this.bot.username} mob fight: ${err.message}`)
      return 'error'
    }).finally(() => {
      if (this.token === token) {
        this.token = null
        this.target = null
        this.release()
      }
    })
    return this.done
  }

  stop () {
    if (this.token) this.token.cancelled = true
    this.token = null
    this.target = null
    this.release()
  }

  release () {
    const bot = this.bot
    this.lower()
    this.netDriver?.release()
    try { bot.pathfinder.setGoal(null) } catch {}
    this.goal = null
  }

  raise () {
    if (this.shieldUp || !this.hasShield()) return
    try { this.bot.activateItem(true) } catch {}
    this.shieldUp = true
  }

  lower () {
    if (!this.shieldUp) return
    try { this.bot.deactivateItem() } catch {}
    this.shieldUp = false
  }

  hasShield () {
    return this.bot.inventory.slots?.[OFFHAND]?.name === 'shield'
  }

  // A shield from the bag into an empty offhand
  async readyShield () {
    const bot = this.bot
    if (this.hasShield() || bot.inventory.slots?.[OFFHAND]) return
    const shield = bot.inventory.items().find(i => i.name === 'shield')
    if (!shield) return
    try { await bot.equip(shield, 'off-hand') } catch (err) { this.log(`${bot.username} shield: ${err.message}`) }
  }

  // The main hand for a fight: the best weapon, or empty with none. True when a swing is fine, false when food is
  // still in the hand. Mineflayer's unequip throws the held stack on the ground when the bag is full, so with no room
  // it moves to a hotbar slot that holds no food instead
  async readyHand (weapon) {
    const bot = this.bot
    try {
      if (weapon.item) {
        if (bot.heldItem?.type !== weapon.item.type) await bot.equip(weapon.item, 'hand')
      } else if (bot.heldItem) {
        if (bot.inventory.emptySlotCount() > 0) await bot.unequip('hand')
        else {
          const slots = bot.inventory.slots || []
          for (let i = 0; i < 9 && isFood(bot, bot.heldItem); i++) {
            if (!isFood(bot, slots[HOTBAR + i])) bot.setQuickBarSlot(i)
          }
        }
      }
    } catch (err) {
      this.log(`${bot.username} could not ready its hand: ${err.message}`)
    }
    return !isFood(bot, bot.heldItem)
  }

  // Sets the walking goal, only when it changes: 'close' follows the target, 'back' keeps away from it
  steer (kind, e) {
    if (this.goal === kind) return
    this.goal = kind
    const bot = this.bot
    if (kind === 'close') bot.pathfinder.setGoal(new goals.GoalFollow(e, CLOSE), true)
    else if (kind === 'back') bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(e, BACK_OFF)), true)
    else bot.pathfinder.setGoal(null)
  }

  async loop (target, token, moves, net = null) {
    const bot = this.bot
    // the assessor's report can still name a mob that just died: no fight, and no second kill counted
    if (!liveTarget(bot, target)) return 'gone'
    if (moves) bot.pathfinder.setMovements(moves)
    guardHazards(bot, bot.pathfinder.movements)
    if (net) {
      const result = await fightWithNet(this, target, token, net, { melee: MELEE, live: liveTarget })
      if (result !== 'fallback') return result
      if (token.cancelled) return 'stopped'
    } else {
      this.note('scripted')
    }
    let weapon = bestWeapon(bot)
    let handOk = await this.readyHand(weapon)
    let heldType = bot.heldItem?.type
    let warned = false
    await this.readyShield()
    let tick = 0
    let lastSwing = -Infinity
    let backUntil = -Infinity
    while (!token.cancelled) {
      const e = liveTarget(bot, target)
      if (!e) {
        this.stats.kills++
        return 'dead'
      }
      const me = bot.entity.position
      const d = e.position.distanceTo(me)
      const creeper = e.name === 'creeper'
      if (creeper && (tick < backUntil || (swelling(e) && d < SWELL_RANGE))) {
        // after a hit, or a fuse about to blow: keep away, shield toward it
        this.steer('back', e)
        if (swelling(e)) this.raise()
        else this.lower()
      } else if (d > REACH - 0.3) {
        this.steer('close', e)
        if (drawing(e) && d > SHIELD_RANGE) this.raise()
        else this.lower()
      } else {
        this.steer('close', e)
        // the hand changed during the fight (the weapon broke, something else took the slot): ready it again
        if (bot.heldItem?.type !== heldType) {
          weapon = bestWeapon(bot)
          handOk = await this.readyHand(weapon)
          heldType = bot.heldItem?.type
          if (token.cancelled) break
        }
        if (!handOk) {
          if (!warned) this.log(`${bot.username} has only food to hold and no free slot, not swinging it`)
          warned = true
        } else if (tick - lastSwing >= weapon.cooldown) {
          this.lower()
          await bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.8, 0), true)
          if (token.cancelled) break
          bot.attack(e)
          this.stats.swings++
          lastSwing = tick
          if (creeper) backUntil = tick + BACK_TICKS
        }
      }
      await bot.waitForTicks(1)
      tick++
    }
    return 'stopped'
  }
}

function agentsMobFight (bot, opts) {
  if (!bot.agentsMobFight) bot.agentsMobFight = new MobFighter(bot, opts)
  return bot.agentsMobFight
}

// The single entry point of the mob fighter
function mobFight (bot, target, opts = {}) {
  return agentsMobFight(bot, opts).start(target, opts)
}

function stopMobFight (bot) {
  bot.agentsMobFight?.stop()
}

// Whether the trained network would take this mob right now: it knows the mob, the bot carries an axe, and the network
// passed its checks and is not known to be down. The danger assessor asks this before backing away from a creeper
function netCanFight (bot, entity, { net = null, log } = {}) {
  if (KIND_OF[entity?.name] === undefined || !bestAxe(bot, MELEE)) return false
  return (net || sharedMobNet(log)).usable()
}

module.exports = { mobFight, stopMobFight, netCanFight, MobFighter, bestWeapon, swelling, drawing, liveTarget, MELEE, REACH }
