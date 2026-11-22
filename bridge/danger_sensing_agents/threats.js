// The danger assessor: what could hurt an agent right now, how much, and what to do about it.
//
// The agents call update() 5 times a second (every 4 game ticks), before the mode manager ticks. The survival modes
// in behaviors.js (escape, retreat, avoid, defend, eat, resupply) only read the report, so all the judgement is in
// here and the modes stay one line each. No Mineflayer in here: it reads bot.entities, bot.entity, bot.health,
// bot.food, bot.oxygenLevel, bot.inventory and bot.blockAt, so test/threats.test.js runs it on the fake world.
//
// A danger's score:  how bad it is  x  how close  x  coming at me  x  looking at me  x  height  x  how weak I am
// A score of FIGHT_AT or more is worth stopping a job for. Several mobs add up in the total, which decides fleeing.
//
// Responses, in the order the modes check them:
//   escape    in lava, on fire, or the head stuck in a block         (EscapeMode, top priority)
//   swim      out of air in water                                     (agents.breathe, a reflex under every mode)
//   flee      a warden or wither near, low health with enemies near, or too many enemies at once (RetreatMode)
//   avoid     a creeper within 6 blocks: back off to 9, unless the    (AvoidMode)
//             trained mob network can fight it, as it trained to
//   fight     the one enemy most worth fighting                      (MobFightMode for a mob, the trained network or
//                                                                     scripted, DefendMode for a player, the network)
//   findfood  no usable food and the bar at 10 or less, until it is back at 14 (FindFoodMode, above every job)
//   eat       hungry, or safe with the food bar under 18             (EatMode)
//   resupply  less food in the bag than the job needs, at least the 24 point reserve, raw food counted at its cooked
//             value when it can cook it (ResupplyMode)
//   watch     known, not worth acting on yet (far, neutral, behind a wall, out of reach)

const { Vec3 } = require('vec3')
const { isEnemy, dist } = require('./targets')
const { foodPointsCarried, foodSupply, supplyText, HUNGRY, HUNT_ENOUGH } = require('./skills/food')
const { FOOD_EMERGENCY, FOOD_RECOVERED } = require('./skills/food_plan')
const { sealedOff, wallsBetween } = require('./hazards')

const SENSE_RADIUS = 24       // blocks, mobs further out are not a danger yet (except long range shooters)
const SCAN_RADIUS = 64        // what it looks at at all (a ghast shoots from 50)
const FIGHT_AT = 1.5          // a score worth stopping a job for
const KEEP_FIGHT = 0.6        // a fight in progress goes on until its target scores below this
const SWITCH_RATIO = 1.5      // another enemy takes over the fight only when it scores this much more
const FLEE_HP = 6             // start running at this health with an enemy within FLEE_START
const SAFE_HP = 10            // stop running above this health, or once nothing is within FLEE_CLEAR
const FLEE_START = 10
const FLEE_CLEAR = 16
const OVERWHELM = 8           // total score that is too much to fight below OVERWHELM_HP health
const OVERWHELM_HP = 14
const BOSS_RADIUS = 32        // a warden or a wither this close: leave
const SEAL_KEEP_MS = 1000     // how long the answer on a walled off mob is kept
const SEAL_RADIUS = 16        // a mob further off than this is not checked for a wall
const SEAL_SEARCHES = 8       // how many mobs one look may check
const BLAST_REACH = 5         // a creeper this close can hurt the bot through a thin wall
const BLAST_WALL = 2          // the most solid blocks a blast gets through
const CREEPER_AVOID = 6       // a creeper this close: back off
const CREEPER_SAFE = 9        // until it is this far
const CREEPER_PATIENCE_MS = 15000  // backing off from the same creeper this long: fight it instead
const CREEPER_FIGHT_MS = 30000
const CREEPER_HOLD_MS = 6000  // a back off that began holds this long before the network may take that creeper
const UNREACHABLE_MS = 20000  // fighting the same enemy this long without getting close: it is out of reach
const UNREACHABLE_FOR_MS = 60000
const PROVOKED_MS = 30000     // a neutral mob or player that hit us stays an enemy this long
const ENDERMAN_ANGRY = 17     // entity metadata in 1.21: the enderman's flag for having a target
const HURT_MS = 3000          // damage this recent counts as being under attack
const APPROACH_SPEED = 0.5    // blocks per second toward us that counts as coming at us
const LOOK_ANGLE = Math.PI / 6
const STEEP = 5               // a walking mob this far above or below has a hard time reaching us
const OWNER_WEIGHT = 1.6       // a mob next to the owner counts this much (the owner has no assessor)
const SAFE_RADIUS = 12        // no enemy that matters this close, and nothing hurt it lately: safe to eat
// The food to carry: 24 points, a full bar and a bit, or 3 steaks. The owner's number
const FOOD_RESERVE = 24
// A creeper's blast, Minecraft Wiki (Explosion): power 3, so it reaches 6 blocks, and on normal difficulty it does
// (impact^2 + impact) / 2 * 7 * 6 + 1 at impact = 1 - distance / 6 with a clear line. A fuse starts within 3 blocks and a
// melee fight stands about 2.5 away, where that is 20: a full health bar with no armor. The trained network fought
// creepers in iron armor, where the same blast does 16
const BLAST_POWER = 3
const BLAST_AT = 2.5
const CREEPER_CORNERED = 3    // backing off and it is still this close: nowhere left to go
const CREEPER_CORNERED_MS = 1000  // well inside its 1.5 s fuse, so the hit that knocks it away lands before the blast

// How bad each mob is and how it attacks. kind: melee, ranged (range in blocks), exploder, boss.
// neutral: only a danger once it attacked us (or, for piglins, when we wear no gold). flier: height does not slow it
const MOBS = {
  zombie: { danger: 1, kind: 'melee', reach: 2 },
  husk: { danger: 1.1, kind: 'melee', reach: 2 },
  drowned: { danger: 1.1, kind: 'melee', reach: 2 },
  zombie_villager: { danger: 1, kind: 'melee', reach: 2 },
  spider: { danger: 1.2, kind: 'melee', reach: 2 },
  cave_spider: { danger: 1.5, kind: 'melee', reach: 2 },
  silverfish: { danger: 0.5, kind: 'melee', reach: 1.5 },
  endermite: { danger: 0.5, kind: 'melee', reach: 1.5 },
  slime: { danger: 1, kind: 'melee', reach: 2 },
  magma_cube: { danger: 1.5, kind: 'melee', reach: 2 },
  vindicator: { danger: 2.5, kind: 'melee', reach: 2 },
  ravager: { danger: 4, kind: 'melee', reach: 3 },
  hoglin: { danger: 2.5, kind: 'melee', reach: 2 },
  zoglin: { danger: 3, kind: 'melee', reach: 2 },
  piglin_brute: { danger: 3.5, kind: 'melee', reach: 2 },
  wither_skeleton: { danger: 3, kind: 'melee', reach: 2 },
  phantom: { danger: 1.3, kind: 'melee', reach: 2, flier: true },
  vex: { danger: 1.5, kind: 'melee', reach: 2, flier: true },
  skeleton: { danger: 1.5, kind: 'ranged', reach: 2, range: 15 },
  stray: { danger: 1.6, kind: 'ranged', reach: 2, range: 15 },
  bogged: { danger: 1.6, kind: 'ranged', reach: 2, range: 15 },
  pillager: { danger: 1.6, kind: 'ranged', reach: 2, range: 16 },
  witch: { danger: 2, kind: 'ranged', reach: 2, range: 10 },
  evoker: { danger: 2.5, kind: 'ranged', reach: 2, range: 12 },
  blaze: { danger: 2, kind: 'ranged', reach: 2, range: 16, flier: true },
  ghast: { danger: 2, kind: 'ranged', reach: 2, range: 50, flier: true },
  breeze: { danger: 2, kind: 'ranged', reach: 2, range: 16, flier: true },
  shulker: { danger: 1.5, kind: 'ranged', reach: 2, range: 16 },
  guardian: { danger: 2, kind: 'ranged', reach: 2, range: 15 },
  elder_guardian: { danger: 4, kind: 'ranged', reach: 2, range: 15 },
  illusioner: { danger: 2, kind: 'ranged', reach: 2, range: 15 },
  parched: { danger: 1.6, kind: 'ranged', reach: 2, range: 15 },
  giant: { danger: 3, kind: 'melee', reach: 4 },
  creaking: { danger: 2, kind: 'melee', reach: 2 },
  creeper: { danger: 3, kind: 'exploder', reach: 3 },
  warden: { danger: 10, kind: 'boss', reach: 3 },
  wither: { danger: 10, kind: 'boss', reach: 3, flier: true },
  enderman: { danger: 2.5, kind: 'melee', reach: 2, neutral: true },
  zombified_piglin: { danger: 2, kind: 'melee', reach: 2, neutral: true },
  piglin: { danger: 1.5, kind: 'melee', reach: 2, neutral: true, goldNeutral: true }
}
const UNKNOWN_MOB = { danger: 1, kind: 'melee', reach: 2 }

// Armor points per piece (helmet, chestplate, leggings, boots), from the Minecraft Wiki's Armor page
const ARMOR = {
  leather: [1, 3, 2, 1],
  golden: [2, 5, 3, 1],
  chainmail: [2, 5, 4, 1],
  iron: [2, 6, 5, 2],
  diamond: [3, 8, 6, 3],
  netherite: [3, 8, 6, 3]
}
const ARMOR_SLOTS = [5, 6, 7, 8]  // helmet, chestplate, leggings, boots in the player inventory window
const PIECES = ['helmet', 'chestplate', 'leggings', 'boots']
const WEAPON = /(_sword|_axe)$|^(mace|trident)$/

const label = e => e.username || (e.name || 'something').replace(/_/g, ' ')
const clamp01 = x => Math.max(0, Math.min(1, x))
// 1 at d0 or closer, falling to 0 at d1
const ramp = (d, d0, d1) => d <= d0 ? 1 : d >= d1 ? 0 : 1 - (d - d0) / (d1 - d0)

function armorPoints (bot) {
  let n = 0
  for (let i = 0; i < 4; i++) {
    const item = bot.inventory.slots?.[ARMOR_SLOTS[i]]
    if (!item) continue
    if (item.name === 'turtle_helmet') { n += 2; continue }
    const m = item.name.match(/^([a-z]+)_(helmet|chestplate|leggings|boots)$/)
    if (m && ARMOR[m[1]]) n += ARMOR[m[1]][PIECES.indexOf(m[2])]
  }
  return n
}

// The damage of a creeper's blast at this distance through this much armor (no toughness), normal difficulty
function blastDamage (armor, distance = BLAST_AT) {
  const impact = clamp01(1 - distance / (BLAST_POWER * 2))
  const raw = Math.floor((impact * impact + impact) / 2 * 7 * (BLAST_POWER * 2) + 1)
  const absorbed = Math.min(20, Math.max(armor / 5, armor - raw / 2))
  return raw * (1 - absorbed / 25)
}

// Whether a full health bar outlasts a blast in melee range in what it wears. It reads armor and not current health, so
// a fight that has started never flips to running because of a hit
const survivesBlast = bot => blastDamage(armorPoints(bot)) < 20

function wearsGold (bot) {
  return ARMOR_SLOTS.some(s => /^golden_/.test(bot.inventory.slots?.[s]?.name || ''))
}

// How weak the bot is right now: 1 when healthy, armored and armed, up to about 4.7 when nearly dead and bare
function vulnerability (bot) {
  const health = 1 + clamp01((20 - bot.health) / 20) * 2
  const armor = armorPoints(bot)
  const armorF = armor >= 15 ? 0.8 : armor >= 8 ? 1 : 1.3
  const armed = bot.inventory.items().some(i => WEAPON.test(i.name))
  return health * armorF * (armed ? 1 : 1.2)
}

// What kind of danger an entity is. Players that are not friends count as neutral: never fought unless they hit us
function specOf (e, bot) {
  if (e.type === 'player') {
    const held = e.heldItem?.name || ''
    const ranged = held === 'bow' || held === 'crossbow'
    return { danger: WEAPON.test(held) ? 2.6 : 2, kind: ranged ? 'ranged' : 'melee', reach: 3, range: 20, neutral: true }
  }
  const s = MOBS[e.name] || UNKNOWN_MOB
  if (s.goldNeutral) return wearsGold(bot) ? s : { ...s, neutral: false }
  return s
}

// Whether a straight line from a to b passes only through blocks without a full collision box
function clearLine (bot, a, b) {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const len = Math.hypot(d.x, d.y, d.z)
  const steps = Math.ceil(len / 0.5)
  let last = null
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const p = new Vec3(Math.floor(a.x + d.x * t), Math.floor(a.y + d.y * t), Math.floor(a.z + d.z * t))
    const k = `${p.x},${p.y},${p.z}`
    if (k === last) continue
    last = k
    const block = bot.blockAt(p)
    if (block && block.boundingBox === 'block') return false
  }
  return true
}

// Whether the entity's head points at the target (within 30 degrees, horizontally). Mineflayer's yaw 0 looks at -z
function lookingAt (e, target) {
  const yaw = e.headYaw ?? e.yaw
  if (yaw === undefined) return false
  const dx = target.x - e.position.x
  const dz = target.z - e.position.z
  if (Math.hypot(dx, dz) < 1e-6) return true
  const want = Math.atan2(-dx, -dz)
  let diff = Math.abs(want - yaw) % (2 * Math.PI)
  if (diff > Math.PI) diff = 2 * Math.PI - diff
  return diff <= LOOK_ANGLE
}

// Enemies by targets.js (hostile mobs, players who are not friends), plus the mobs in MOBS the game does not file
// as hostile: slime, magma cube, phantom, ghast, shulker (type "mob") and hoglin (type "animal")
function isDanger (e, friends) {
  if (isEnemy(e, friends)) return true
  return e.type !== 'player' && e.isValid !== false && Object.prototype.hasOwnProperty.call(MOBS, e.name)
}

function onFire (bot) {
  return !!((bot.entity.metadata?.[0] ?? 0) & 0x01)
}

const angryEnderman = e => e.name === 'enderman' && e.metadata?.[ENDERMAN_ANGRY] === true

// A melee hit needs a clear eye line. A mob with neither that nor open air between its body and the bot's did not land
// this one (a fall or hunger did). A creeper's blast does go through a wall, so it can always be blamed
function behindWall (bot, x, eye) {
  if (x.spec.kind === 'exploder' || clearLine(bot, eye, headOf(x.e))) return false
  const p = x.e.position
  const me = bot.entity.position
  const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v))
  const a = { x: clamp(p.x - 0.3, p.x + 0.3, me.x), y: clamp(p.y, p.y + (x.e.height ?? 1.95), me.y + 0.9), z: clamp(p.z - 0.3, p.z + 0.3, me.z) }
  const b = { x: clamp(me.x - 0.3, me.x + 0.3, a.x), y: clamp(me.y, me.y + 1.8, a.y), z: clamp(me.z - 0.3, me.z + 0.3, a.z) }
  return wallsBetween(bot, a, b, 1) > 0
}

class DangerAssessor {
  // reserve: the food points to carry right now, a number or a function (a long job raises it, food_plan.js).
  // Never below FOOD_RESERVE or above HUNT_ENOUGH. netFights(entity): whether the trained mob network would take this mob right now
  constructor (bot, { friends, owner = null, now = () => Date.now(), reserve = null, netFights = null, cookWork = null } = {}) {
    this.cookWork = cookWork
    this.bot = bot
    this.friends = friends
    this.owner = owner
    this.now = now
    this.reserve = reserve
    this.netFights = netFights
    this.reset()
  }

  wantFood () {
    const r = typeof this.reserve === 'function' ? this.reserve() : this.reserve
    return Math.min(HUNT_ENOUGH, Math.max(FOOD_RESERVE, Number.isFinite(r) ? r : 0))
  }

  // After a death everything it remembered is about the old life
  reset () {
    this.seen = new Map()         // id to { d, dOwner, t }, for the speed toward us
    this.hitBy = new Map()        // id to the time it last hurt us
    this.provoked = new Map()     // id to until when a neutral mob or player counts as an enemy
    this.unreachable = new Map()  // id to until when it is out of reach
    this.creeperFight = new Map() // id to until when a creeper is fought instead of avoided
    this.sealCache = new Map()    // id to the last answer on whether it has an open way to the bot
    this.sealEpoch = this.sealEpoch || 0  // goes up when a block near the bot opens or closes
    this.lastHealth = this.bot.health
    this.hurtAt = 0
    this.focusId = null
    this.engaged = null           // { id, since, closest }
    this.avoiding = null          // { id, since }
    this.fleeing = false
    this.safePos = null
    this.foodEmergency = false
    this.lives = (this.lives || 0) + 1  // a food emergency that ended with a death is not a recovery
    this.report = emptyReport()
  }

  update () {
    const bot = this.bot
    const now = this.now()
    if (!bot.entity?.position) return this.report
    const me = bot.entity.position
    const eye = { x: me.x, y: me.y + 1.62, z: me.z }
    const ownerEntity = this.owner ? bot.players?.[this.owner]?.entity : null
    const guardOwner = ownerEntity && ownerEntity.position && dist(ownerEntity.position, me) <= 16 ? ownerEntity : null
    const vuln = vulnerability(bot)
    for (const map of [this.provoked, this.unreachable, this.creeperFight]) {
      for (const [id, until] of map) if (until <= now) map.delete(id)
    }

    // hurt since the last look: blame the nearest enemy in reach, else the nearest shooter that can see us
    const hurt = bot.health < this.lastHealth - 0.01
    this.lastHealth = bot.health
    const enemies = []
    for (const e of Object.values(bot.entities || {})) {
      if (e === bot.entity || !e.position || !isDanger(e, this.friends)) continue
      const d = dist(e.position, me)
      if (d > SCAN_RADIUS) continue
      enemies.push({ e, d, spec: specOf(e, bot) })
    }
    if (hurt) {
      this.hurtAt = now
      const close = enemies.filter(x => x.d <= x.spec.reach + 2 && !behindWall(bot, x, eye)).sort((a, b) => a.d - b.d)[0]
      const shooter = close ? null : enemies
        .filter(x => x.spec.kind === 'ranged' && x.d <= x.spec.range && clearLine(bot, eye, headOf(x.e)))
        .sort((a, b) => a.d - b.d)[0]
      const who = close || shooter
      if (who) {
        this.hitBy.set(who.e.id, now)
        if (who.spec.neutral) this.provoked.set(who.e.id, now + PROVOKED_MS)
      }
    }

    const dangers = []
    const present = new Set()
    for (const { e, d, spec } of enemies) {
      present.add(e.id)
      dangers.push(this.scoreEntity(e, d, spec, { me, eye, vuln, guardOwner, now }))
    }
    for (const id of this.seen.keys()) if (!present.has(id)) this.seen.delete(id)
    for (const id of this.sealCache.keys()) if (!present.has(id)) this.sealCache.delete(id)
    const foodEmergency = this.decideFoodEmergency()
    dangers.push(...this.selfDangers(now, foodEmergency))
    dangers.sort((a, b) => b.score - a.score)

    const report = emptyReport()
    report.at = now
    report.dangers = dangers
    report.vulnerability = vuln
    const mobs = dangers.filter(x => x.entity && x.active)
    report.total = mobs.reduce((n, x) => n + x.score, 0)
    report.escape = dangers.find(x => x.response === 'escape') || null
    report.swim = dangers.find(x => x.response === 'swim') || null
    report.eat = dangers.find(x => x.response === 'eat') || null
    report.resupply = dangers.find(x => x.response === 'resupply') || null
    report.foodEmergency = foodEmergency
    report.flee = this.decideFlee(mobs, report.total)
    // the run goes away from a creeper inside its blast before anything nearer: a retreat that only watched the closest
    // mob ran past a creeper at 3 health. A boss stays the thing to run from
    if (report.flee && report.flee.from?.kind !== 'boss') {
      const blast = mobs.filter(x => x.kind === 'creeper' && x.distance <= CREEPER_AVOID).sort((a, b) => a.distance - b.distance)[0]
      if (blast) report.flee = { from: blast, reason: `${report.flee.reason}, creeper ${blast.distance.toFixed(1)} blocks away` }
    }
    report.avoid = report.flee ? null : this.decideAvoid(dangers, now)
    report.fight = report.flee || report.avoid ? null : this.decideFight(mobs, now)
    if (!report.fight) this.engaged = null
    for (const x of dangers) {
      if (!x.entity) continue
      if (report.flee && x === report.flee.from) x.response = 'flee'
      else if (report.avoid && x === report.avoid) x.response = 'avoid'
      else if (report.fight && x === report.fight) x.response = 'fight'
    }
    report.top = dangers[0] || null
    // safe: nothing to run from, fight or get out of, no enemy that matters within SAFE_RADIUS, and not hurt lately.
    // A safe bot eats before it gets hungry (food_plan.js)
    report.safe = !report.flee && !report.avoid && !report.fight && !report.escape && !report.swim &&
      now - this.hurtAt > HURT_MS && !mobs.some(x => x.score >= 0.5 && x.distance <= SAFE_RADIUS)

    if (bot.entity.onGround && !bot.entity.isInLava && !onFire(bot)) this.safePos = me.clone ? me.clone() : { ...me }
    this.report = report
    return report
  }

  scoreEntity (e, d, spec, { me, eye, vuln, guardOwner, now }) {
    const id = e.id
    const prev = this.seen.get(id)
    const dOwner = guardOwner ? dist(e.position, guardOwner.position) : null
    const dt = prev ? (now - prev.t) / 1000 : 0
    const speed = prev && dt > 0 ? (prev.d - d) / dt : 0
    const speedOwner = prev && dt > 0 && prev.dOwner != null && dOwner != null ? (prev.dOwner - dOwner) / dt : 0
    this.seen.set(id, { d, dOwner, t: now })

    const head = headOf(e)
    const los = spec.kind === 'ranged' ? clearLine(this.bot, eye, head) : true
    const near = spec.reach + 1
    let proximity
    if (spec.kind === 'ranged') {
      proximity = los && d <= spec.range ? Math.max(0.8 + 0.2 * (1 - d / spec.range), ramp(d, near, SENSE_RADIUS)) : 0.4 * ramp(d, near, SENSE_RADIUS)
    } else if (spec.kind === 'exploder') {
      proximity = ramp(d, 3, 16)
    } else if (spec.kind === 'boss') {
      proximity = ramp(d, near, BOSS_RADIUS * 1.5)
    } else {
      proximity = ramp(d, near, SENSE_RADIUS)
    }
    const coming = speed > APPROACH_SPEED
    const leaving = speed < -APPROACH_SPEED
    const looking = lookingAt(e, me)
    const dy = e.position.y - me.y
    const steep = !spec.flier && spec.kind !== 'ranged' && Math.abs(dy) > STEEP
    let score = spec.danger * proximity * (coming ? 1.5 : leaving ? 0.7 : 1) * (looking ? 1.2 : 1) * (steep ? 0.5 : 1) * vuln

    const reasons = [`${d.toFixed(1)} blocks`]
    if (coming) reasons.push('coming at me')
    if (leaving) reasons.push('moving away')
    if (looking) reasons.push('looking at me')
    if (steep) reasons.push(dy > 0 ? 'far above' : 'far below')
    if (spec.kind === 'ranged') reasons.push(los ? 'can shoot me' : 'no line of sight')

    // a mob attacking the owner nearby counts as much as one attacking the bot
    let forOwner = false
    if (dOwner != null && dOwner <= 8 && !spec.neutral && spec.kind !== 'exploder') {
      const ownerScore = spec.danger * ramp(dOwner, near, 8) * (speedOwner > APPROACH_SPEED ? 1.5 : 1) * OWNER_WEIGHT
      if (ownerScore > score) {
        score = ownerScore
        forOwner = true
        reasons.push(`${dOwner.toFixed(1)} blocks from you`)
      }
    }

    const hitMe = now - (this.hitBy.get(id) || -Infinity) <= HURT_MS
    // the game flags an enderman that has a target. Without this it counts as harmless until its first hit lands
    if (angryEnderman(e)) this.provoked.set(id, now + PROVOKED_MS)
    const provoked = this.provoked.has(id)
    const neutral = spec.neutral && !provoked
    if (hitMe) reasons.push('hit me')
    // no walking route and no shot: known about, but nothing to answer yet. A creeper close behind a thin wall still counts
    const nearOwner = dOwner != null && dOwner <= 8 && !spec.neutral && spec.kind !== 'exploder'
    const blast = spec.kind === 'exploder' && d <= BLAST_REACH &&
      wallsBetween(this.bot, { x: e.position.x, y: e.position.y + 0.85, z: e.position.z }, { x: me.x, y: me.y + 0.9, z: me.z }, BLAST_WALL) <= BLAST_WALL
    const sealed = !hitMe && !blast && !(spec.kind === 'ranged' && los) && !spec.flier && this.isSealed(e, d, now) && !(nearOwner && this.ownerOpen(e, now))
    if (sealed) {
      score *= 0.1
      reasons.push('no way to reach me')
    } else if (neutral) {
      score *= 0.2
      reasons.push(e.type === 'player' ? 'a player who has not attacked' : 'neutral, not angry')
    } else {
      if (d <= near) score = Math.max(score, FIGHT_AT)   // in reach: always worth answering
      if (hitMe) score = Math.max(score, FIGHT_AT + 0.5)
    }
    if (d > Math.max(SENSE_RADIUS, spec.range || 0, spec.kind === 'boss' ? BOSS_RADIUS : 0) && !hitMe) score = 0
    return {
      kind: spec.kind === 'boss' ? 'boss' : spec.kind === 'exploder' ? 'creeper' : e.type === 'player' ? 'player' : 'mob',
      name: label(e),
      entity: e,
      spec,
      distance: d,
      score,
      active: !neutral && !sealed && score > 0,
      sealed,
      forOwner,
      hitMe,
      response: 'watch',
      reason: reasons.join(', ')
    }
  }

  // sealedOff walks the cells around the two of them, so its answer is kept until either moves, the block being dug
  // changes, a nearby block opens or closes, or SEAL_KEEP_MS passes
  isSealed (e, d, now) {
    const bot = this.bot
    if (d > SEAL_RADIUS) return false
    this.watchBlocks()
    const at = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    const dig = bot.targetDigBlock?.position
    const key = `${at(bot.entity.position)}|${at(e.position)}|${dig ? at(dig) : ''}|${this.sealEpoch}`
    const kept = this.sealCache.get(e.id)
    if (kept && kept.key === key && now - kept.at < SEAL_KEEP_MS) return kept.sealed
    // a few searches a look at most, the rest keep their last answer until their turn: a crowd must not stall the tick.
    // An answer from before a block changed is not kept: that mob counts until its search runs
    if (this.sealLook !== now || this.sealMemoEpoch !== this.sealEpoch) {
      this.sealLook = now
      this.sealSearches = 0
      this.sealMemo = new Map()
      this.sealMemoEpoch = this.sealEpoch
    }
    if (this.sealSearches >= SEAL_SEARCHES) return kept?.epoch === this.sealEpoch ? kept.sealed : false
    this.sealSearches++
    const sealed = sealedOff(bot, e, dig ? new Map() : this.sealMemo)
    this.sealCache.set(e.id, { key, at: now, sealed, epoch: this.sealEpoch })
    return sealed
  }

  // Walled off from the bot but going for the owner beside it: that mob still counts. Unsure counts as open
  ownerOpen (e, now) {
    const o = this.bot.players?.[this.owner]?.entity?.position
    if (!o) return false
    const at = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    const key = `${at(o)}|${at(e.position)}|${this.sealEpoch}`
    const kept = this.sealCache.get(`owner${e.id}`)
    if (kept && kept.key === key && now - kept.at < SEAL_KEEP_MS) return kept.open
    if (this.sealSearches >= SEAL_SEARCHES) return true
    this.sealSearches++
    const open = !sealedOff(this.bot, e, this.bot.targetDigBlock ? new Map() : this.sealMemo, o)
    this.sealCache.set(`owner${e.id}`, { key, at: now, open })
    return open
  }

  // A wall that opens near the bot ends every kept answer at once
  watchBlocks () {
    const bot = this.bot
    if (this.watchingBlocks || !bot.on) return
    this.watchingBlocks = true
    this.sealEpoch = this.sealEpoch || 0
    bot.on('blockUpdate', (was, now) => {
      const p = now?.position || was?.position
      const me = bot.entity?.position
      if (!p || !me || (was?.boundingBox === now?.boundingBox && was?.name === now?.name)) return
      if (Math.abs(p.x - me.x) <= SEAL_RADIUS + 8 && Math.abs(p.y - me.y) <= SEAL_RADIUS && Math.abs(p.z - me.z) <= SEAL_RADIUS + 8) this.sealEpoch++
    })
  }

  // The bot's own body and bag
  selfDangers (now, foodEmergency = null) {
    const bot = this.bot
    const out = []
    const self = (kind, score, response, reason) => out.push({ kind, name: kind.replace(/_/g, ' '), entity: null, score, response, reason })
    if (bot.entity.isInLava) self('lava', 8, 'escape', 'standing in lava')
    else if (onFire(bot)) self('fire', 5, 'escape', 'on fire')
    const head = bot.blockAt(new Vec3(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y + 1.62), Math.floor(bot.entity.position.z)))
    if (smothers(head)) self('suffocation', 6, 'escape', `head inside ${head.name}`)
    if (bot.entity.isInWater && bot.oxygenLevel !== undefined && bot.oxygenLevel < 10) {
      self('drowning', 4 + (10 - bot.oxygenLevel) / 2, 'swim', `air ${bot.oxygenLevel} of 20`)
    }
    if (foodEmergency) self('no_food', 6, 'findfood', foodEmergency.reason)
    if (bot.food === 0) self('starving', 5, 'eat', 'food bar empty, losing health')
    else if (bot.food < HUNGRY) self('hunger', 1 + (HUNGRY - bot.food) / 7, 'eat', `food ${bot.food} of 20`)
    // raw food counts at its cooked value when it can cook it. What it eats and when is not decided from this
    const supply = foodSupply(bot, this.cookWork?.() || null)
    const carried = supply.total
    const want = this.wantFood()
    if (carried < want) {
      const why = want > FOOD_RESERVE ? 'for this job' : '(the reserve)'
      self('low_food_supply', 0.5 + (want - carried) / want, 'resupply', `${carried} food points in the bag, want ${want} ${why}`)
      Object.assign(out[out.length - 1], { carried, want, supply, text: supplyText(supply, want) })
    }
    if (bot.health < SAFE_HP && now - this.hurtAt > HURT_MS) self('low_health', (SAFE_HP - bot.health) / 5, 'eat', `health ${Math.round(bot.health)} of 20`)
    return out
  }

  // The food emergency (the thresholds and why are in food_plan.js). It starts with nothing usable in the bag and the
  // bar at FOOD_EMERGENCY or less, and lasts until the bar is back at FOOD_RECOVERED, food in the bag or not
  decideFoodEmergency () {
    const bot = this.bot
    if (!Number.isFinite(bot.food) || bot.health <= 0) {
      this.foodEmergency = false
      return null
    }
    const carried = foodPointsCarried(bot)
    if (this.foodEmergency) {
      if (bot.food >= FOOD_RECOVERED) this.foodEmergency = false
    } else if (carried === 0 && bot.food <= FOOD_EMERGENCY) {
      this.foodEmergency = true
    }
    if (!this.foodEmergency) return null
    return { food: bot.food, carried, reason: `food ${bot.food} of 20 with ${carried} food points in the bag` }
  }

  // Whether to run. A choice holds for a while: running lowers the score of what it runs from, so without a hold the
  // bot turned back into the same mobs every second and died between the two. Low health, a boss, or a clear change in
  // the fight still end a hold at once. With an axe and a shield it stands against the groups the mob network trained
  // on (up to 4 zombies, skeletons, creepers and endermen), and at decent health it never runs from 2 ordinary mobs.
  decideFlee (mobs, total) {
    const FLEE_HOLD_MS = 6000    // a run lasts at least this long
    const FIGHT_HOLD_MS = 6000   // and so does the stand after a run, or against a group
    const WORSE_HP = 6           // this much health lost since a stand began reopens the choice
    const WORSE_COUNT = 2        // and so do this many more enemies
    const DECENT_HP = 10
    const GROUP_MAX = 4
    const TRAINED = /^(zombie|husk|zombie_villager|skeleton|stray|bogged|parched|creeper|enderman)$/
    const COMMON = /^(spider|drowned|slime)$/
    const bot = this.bot
    const hp = bot.health
    const now = this.now()
    if (this.stance && this.stance.lives !== this.lives) this.stance = null  // a death ends every choice
    const choose = (kind, why, count) => { this.stance = { lives: this.lives, kind, why, until: now + (kind === 'flee' ? FLEE_HOLD_MS : FIGHT_HOLD_MS), hp, count } }

    const boss = mobs.find(x => x.kind === 'boss' && x.distance <= BOSS_RADIUS)
    if (boss) {
      this.fleeing = true
      choose('flee', 'boss', 1)
      return { from: boss, reason: `${boss.name} within ${Math.round(boss.distance)} blocks` }
    }
    const threats = mobs.filter(x => x.score >= 0.3)
    const nearest = threats.slice().sort((a, b) => a.distance - b.distance)[0]
    const near = threats.filter(x => x.distance <= Math.max(FLEE_CLEAR, x.spec?.range || 0))
    const st = this.stance
    const wasFleeing = this.fleeing

    // in a run: it goes on until the hold ends, unless nothing is near, it healed, or one enemy is left
    if (wasFleeing && st?.kind === 'flee' && now < st.until && near.length) {
      const healed = st.why === 'hp' ? hp > SAFE_HP : hp >= OVERWHELM_HP + 2
      const fewer = near.length <= 1 && st.count >= 2 && hp > FLEE_HP
      if (!healed && !fewer) {
        const reason = st.why === 'hp' ? `health ${Math.round(hp)} with ${nearest.name} close` : `${near.length} enemies at once (total ${total.toFixed(1)})`
        return { from: nearest, reason }
      }
    }

    const items = bot.inventory.items()
    const geared = items.some(i => /_axe$/.test(i.name)) &&
      (bot.inventory.slots?.[45]?.name === 'shield' || items.some(i => i.name === 'shield'))
    const named = re => near.every(x => re.test(x.entity?.name || ''))
    const standsGroup = geared && near.length <= GROUP_MAX && named(TRAINED)
    const fairFight = near.length <= 2 && hp >= DECENT_HP && near.every(x => TRAINED.test(x.entity?.name || '') || COMMON.test(x.entity?.name || ''))
    const canStand = standsGroup || fairFight

    const ranRecently = this.lastRun?.lives === this.lives && now - this.lastRun.at < FIGHT_HOLD_MS
    const hpLow = wasFleeing
      ? hp <= SAFE_HP && nearest && nearest.distance <= FLEE_CLEAR
      : hp <= FLEE_HP && nearest && nearest.distance <= (ranRecently ? FLEE_CLEAR : FLEE_START)
    const overTotal = wasFleeing ? total >= OVERWHELM / 2 && hp < OVERWHELM_HP + 2 : total >= OVERWHELM && hp < OVERWHELM_HP
    let swamped = near.length > 0 && !canStand && overTotal
    if (!wasFleeing && st?.kind === 'fight' && now < st.until && hp > st.hp - WORSE_HP && near.length < st.count + WORSE_COUNT) swamped = false

    if (hpLow || swamped) {
      if (!wasFleeing) choose('flee', hpLow ? 'hp' : 'swamped', near.length)
      this.fleeing = true
      const reason = hpLow ? `health ${Math.round(hp)} with ${nearest.name} close` : `${threats.length} enemies at once (total ${total.toFixed(1)})`
      return { from: nearest || threats[0], reason }
    }
    this.fleeing = false
    if (wasFleeing) {
      this.lastRun = { lives: this.lives, at: now }
      // counted from the group it ran from: the same mobs walking back into range are not more enemies
      choose('fight', 'after a run', Math.max(near.length, st?.count || 0))
    } else if (canStand && near.length >= 2 && overTotal && !(st?.kind === 'fight' && now < st.until)) {
      choose('fight', 'group', near.length)
    }
    return null
  }

  decideAvoid (dangers, now) {
    // The network trained to fight creepers, so one it can take is fought and not backed away from. The fight entry
    // keeps that choice for CREEPER_FIGHT_MS even if the network drops out, and a back off already under way finishes
    // its hold first, so a change of fighter cannot flip the bot between running and fighting
    for (const x of dangers) {
      if (x.kind !== 'creeper' || this.creeperFight.has(x.entity.id) || !this.netFights?.(x.entity)) continue
      const backingOff = this.avoiding?.id === x.entity.id
      if (backingOff && now - this.avoiding.since < CREEPER_HOLD_MS) continue
      this.creeperFight.set(x.entity.id, now + CREEPER_FIGHT_MS)
      if (backingOff) this.avoiding = null
    }
    const creepers = dangers.filter(x => x.kind === 'creeper' && !x.sealed && !this.creeperFight.has(x.entity.id))
    const cur = this.avoiding && creepers.find(x => x.entity.id === this.avoiding.id)
    if (cur && cur.distance < CREEPER_SAFE) {
      // in a dead end there is no backing off, and a hit is what pushes it away before its fuse ends
      if (cur.distance > CREEPER_CORNERED) this.avoiding.closeSince = null
      else this.avoiding.closeSince ??= now
      const closeSince = this.avoiding.closeSince
      if ((closeSince !== null && now - closeSince >= CREEPER_CORNERED_MS) || now - this.avoiding.since > CREEPER_PATIENCE_MS) {
        // it keeps following: fight it, a hit knocks it back and stops the fuse
        this.creeperFight.set(cur.entity.id, now + CREEPER_FIGHT_MS)
        this.avoiding = null
        return null
      }
      return cur
    }
    const close = creepers.filter(x => x.distance <= CREEPER_AVOID).sort((a, b) => a.distance - b.distance)[0]
    if (!close) { this.avoiding = null; return null }
    if (!this.avoiding || this.avoiding.id !== close.entity.id) this.avoiding = { id: close.entity.id, since: now, closeSince: close.distance <= CREEPER_CORNERED ? now : null }
    return close
  }

  decideFight (mobs, now) {
    const fightable = mobs.filter(x => {
      if (x.kind === 'boss') return false
      if (x.kind === 'creeper' && !this.creeperFight.has(x.entity.id)) return false
      if (this.unreachable.has(x.entity.id) && !(x.hitMe && x.distance <= x.spec.reach + 1)) return false
      return true
    })
    const best = fightable.slice().sort((a, b) => b.score - a.score)[0] || null
    const cur = this.focusId != null ? fightable.find(x => x.entity.id === this.focusId) : null
    let pick = null
    if (cur && cur.score >= KEEP_FIGHT) {
      pick = best && best !== cur && best.score >= FIGHT_AT && best.score >= cur.score * SWITCH_RATIO ? best : cur
    } else if (best && best.score >= FIGHT_AT) {
      pick = best
    }
    this.focusId = pick ? pick.entity.id : null
    if (!pick) return null
    // out of reach: fighting it this long without ever getting close (a skeleton on a cliff, a mob across water)
    if (!this.engaged || this.engaged.id !== pick.entity.id) this.engaged = { id: pick.entity.id, since: now, closest: pick.distance }
    this.engaged.closest = Math.min(this.engaged.closest, pick.distance)
    if (now - this.engaged.since > UNREACHABLE_MS && this.engaged.closest > pick.spec.reach + 1.5) {
      this.unreachable.set(pick.entity.id, now + UNREACHABLE_FOR_MS)
      pick.reason += ', out of reach'
      this.focusId = null
      this.engaged = null
      return null
    }
    return pick
  }

  // One chat line: the dangers worth knowing about, highest first
  summary (max = 4) {
    const r = this.report
    const shown = r.dangers.filter(x => x.response !== 'watch' || x.score >= 0.5).slice(0, max)
    if (!shown.length) return 'No dangers'
    return 'Dangers: ' + shown.map(x => `${x.name} ${x.response} ${x.score.toFixed(1)} (${x.reason})`).join('; ')
  }
}

function headOf (e) {
  return { x: e.position.x, y: e.position.y + (e.height || 1.8) * 0.85, z: e.position.z }
}

function emptyReport () {
  return { at: 0, dangers: [], total: 0, top: null, escape: null, swim: null, flee: null, avoid: null, fight: null, eat: null, resupply: null, foodEmergency: null, vulnerability: 1, safe: false }
}

// A door, gate, fence or pane is solid to walk into, but a head standing in its frame is not being smothered
const OPEN_FRAME = /(_door|_trapdoor|_fence|_fence_gate|_wall|_pane|iron_bars|chain|lantern)$/
function smothers (block) {
  return !!block && block.boundingBox === 'block' && !OPEN_FRAME.test(block.name || '')
}

module.exports = {
  smothers,
  DangerAssessor,
  isDanger,
  MOBS,
  armorPoints,
  blastDamage,
  survivesBlast,
  vulnerability,
  clearLine,
  lookingAt,
  FOOD_RESERVE,
  SAFE_RADIUS,
  FIGHT_AT,
  KEEP_FIGHT,
  CREEPER_AVOID,
  CREEPER_SAFE,
  CREEPER_PATIENCE_MS,
  UNREACHABLE_MS,
  BOSS_RADIUS,
  OVERWHELM,
  SAFE_HP,
  FLEE_HP
}
