// The trained mob network behind the mob fighter (skills/mob_fight.js). The danger assessor still decides what to fight,
// and this runs the fight: every 2 game ticks it builds the 182 inputs (mob_inputs.js), asks agents_policy.py --mob for an
// action and turns that into keys, a turn, a swing and the shield.
//
// It runs only when all of this holds, and otherwise the scripted fighter takes the fight and the log says why:
//   the network file exists, tools/mob_parity.js passed on that exact file and this exact input code,
//   the policy process answers, the bot carries an axe (the only weapon it trained with),
//   and the target is a zombie, skeleton, creeper or enderman, or a variant that moves and hits the same way.
//
// What training never had, this adds: a chase by pathfinder for a mob too far off (it trained within 14 blocks) and the
// movement guard (mob_guard.js), which drops a key that would walk it into a hazard or down more than 1 block, moves its
// feet out of water and back from a ledge, and hands the fight to the scripted fighter when it cannot get out of water.

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { PolicyClient } = require('./policy')
const { simYaw, simPitch, YAW_STEPS, PITCH_STEPS, IDLE_ACTION } = require('../../fighter')
const { buildMobInputs, buildMobMask, MobTracker, mobUnderCrosshair, KIND_OF, RAYS } = require('./mob_inputs')
const { clearLine } = require('../threats')
const { TerrainGuard, unsafeStep, noDropMoves } = require('./mob_guard')

const ROOT = path.join(__dirname, '..', '..', '..')
const DEFAULT_FILE = path.join('weights', 'mob', 'expert.npz')
const INPUT_CODE = path.join(__dirname, 'mob_inputs.js')

const SEE_RADIUS = 24       // the mobs it counts in the fight
const CHASE_FAR = 14        // further than this it walks over by pathfinder
const CHASE_NEAR = 10       // and hands the fight to the network inside this
const CHASE_STOP = 8
const IDLE_RESET_MS = 5000  // this long without fighting and the fight memory starts over
const MS_PER_TICK = 50
const MISSES = 5            // decisions in a row with no answer before the scripted fighter takes over
const RAY_RANGE = 8
const CHARGED = 0.9
const SPRINT_SLOWDOWN = 0.6
const KICK_MIN = 0.2        // a velocity packet this fast is a real knock
const KICK_MAX = 4
const HIT_WAIT = 3          // ticks the health update of a landed hit may trail its damage event
const BOGGED_HEALTH = 16

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const netFile = () => {
  const file = process.env.AGENTS_MOB_NET || DEFAULT_FILE
  return path.isAbsolute(file) ? file : path.join(ROOT, file)
}

// Whether the parity check passed on this network file and this input code
function checkParity (file = netFile()) {
  if (!fs.existsSync(file)) return { ok: false, why: `no mob network at ${file}` }
  const reportFile = path.join(path.dirname(file), 'parity.json')
  if (!fs.existsSync(reportFile)) return { ok: false, why: 'the input parity check has not been run on this network' }
  let report
  try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) } catch (err) { return { ok: false, why: `unreadable parity report: ${err.message}` } }
  if (report.passed !== true) return { ok: false, why: 'the input parity check did not pass' }
  if (report.expert_sha256 !== sha(file)) return { ok: false, why: 'the parity check was run on a different network file' }
  if (report.code_sha256 !== sha(INPUT_CODE)) return { ok: false, why: 'the input code changed since the parity check' }
  return { ok: true }
}

// The network process, shared by every bot. It loads only numpy and starts at the first mob fight
class MobNet {
  constructor (log = () => {}, { file = netFile(), policy = null, gate = checkParity } = {}) {
    this.file = file
    this.gate = gate
    this.checked = null
    this.policy = policy || new PolicyClient(file, log, { args: ['--mob', file] })
  }

  // Whether it can take a fight right now, without starting anything: its checks passed and its process is not known
  // to be down. The next ready() finds out whether a process that was down has come back
  usable () {
    if (!this.checked) this.checked = this.gate(this.file)
    return this.checked.ok && !this.down
  }

  async ready () {
    if (!this.checked) this.checked = this.gate(this.file)
    if (!this.checked.ok) return this.checked
    try {
      await this.policy.start()
      this.down = false
      return { ok: true }
    } catch (err) {
      this.down = true
      return { ok: false, why: `the policy process is unavailable: ${err.message}` }
    }
  }

  // The action, or null when the process is slow or gone
  async act (key, obs, mask) {
    try {
      return await this.policy.act(key, obs, mask)
    } catch {
      return null
    }
  }

  close () { this.policy.close() }
}

let shared = null
function sharedMobNet (log) {
  if (!shared) {
    shared = new MobNet(log)
    process.once('exit', () => { try { shared.close() } catch {} })
  }
  return shared
}

// Free distance along a ray through real blocks. A block that is not loaded stops it
function freeRay (bot, o, d, maxT) {
  let [x, y, z] = [Math.floor(o[0]), Math.floor(o[1]), Math.floor(o[2])]
  const step = d.map(v => (v > 0 ? 1 : -1))
  const inv = d.map(v => (Math.abs(v) > 1e-12 ? Math.abs(1 / v) : 1e30))
  const next = [0, 1, 2].map(i => (Math.abs(d[i]) > 1e-12 ? (d[i] > 0 ? [x, y, z][i] + 1 - o[i] : o[i] - [x, y, z][i]) * inv[i] : 1e30))
  for (let guard = 0; guard < 64; guard++) {
    const axis = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[2] <= next[1] ? 2 : 1
    const t = next[axis]
    if (t > maxT) return maxT
    next[axis] += inv[axis]
    if (axis === 0) x += step[0]
    else if (axis === 1) y += step[1]
    else z += step[2]
    const block = bot.blockAt(new Vec3(x, y, z), false)
    if (!block || block.boundingBox === 'block') return t
  }
  return maxT
}

// One bot's senses and hands for the network
class MobNetDriver {
  constructor (bot, fighter) {
    this.bot = bot
    this.fighter = fighter
    this.tracker = new MobTracker()
    this.guard = new TerrainGuard(bot)
    this.driving = false
    this.lastAt = -Infinity
    this.kicks = new Map()
    this.hits = new Map()     // mob id to ticks since its damage event
    this.hurtMobs = new Set()
    this.blocked = false
    this.arrows = new Map()
    this.swung = false
    this.lastHealth = bot.health
    this.sprintHeld = false
    const client = bot._client
    if (client?.on) {
      client.on('entity_velocity', p => {
        const v = p.velocity
        if (!v || !this.driving) return
        const speed = Math.hypot(v.x, v.y, v.z)
        if (speed >= KICK_MIN && speed <= KICK_MAX) this.kicks.set(p.entityId, [v.x, v.y, v.z])
      })
      client.on('damage_event', p => {
        if (!this.driving) return
        this.hurtMobs.add(p.entityId)
        if (p.sourceDirectId - 1 === bot.entity?.id) this.hits.set(p.entityId, 0)
      })
      client.on('sound_effect', p => {
        if (!this.driving) return
        const name = p.sound?.data?.soundName ?? bot.registry.sounds?.[(p.sound?.soundId ?? p.soundId) + 1]?.name ?? ''
        if (name !== 'item.shield.block') return
        const me = bot.entity.position
        if (Math.hypot(p.x / 8 - me.x, p.y / 8 - me.y, p.z / 8 - me.z) < 1.5) this.blocked = true
      })
    }
  }

  hasShield () { return this.bot.inventory.slots?.[45]?.name === 'shield' }

  // A fight begins: the memory carries over between targets of one fight and starts over after a pause
  begin (period) {
    const away = Date.now() - this.lastAt
    this.driving = true
    this.sprintHeld = false
    if (away > IDLE_RESET_MS) {
      this.kicks.clear()
      this.hits.clear()
      this.hurtMobs.clear()
      this.arrows.clear()
      this.lastHealth = this.bot.health
      this.guard.reset()
      this.tracker.reset(this.frame())
    } else {
      // the same fight, a new target: the swing kept recharging during the pause, and a mob that died is dropped
      this.tracker.attackTicks += Math.round(away / MS_PER_TICK)
      this.tracker.tick(this.frame(), IDLE_ACTION)
    }
    this.tracker.attackPeriod = period
  }

  trackArrows () {
    const bot = this.bot
    const out = []
    const present = new Set()
    for (const e of Object.values(bot.entities)) {
      if (e.name !== 'arrow' && e.name !== 'spectral_arrow') continue
      present.add(e.id)
      let a = this.arrows.get(e.id)
      if (!a) {
        a = { pos: [e.position.x, e.position.y, e.position.z], vel: [e.velocity?.x ?? 0, e.velocity?.y ?? 0, e.velocity?.z ?? 0], known: e.position.clone() }
        this.arrows.set(e.id, a)
      } else if (!a.known.equals(e.position)) {
        a.pos = [e.position.x, e.position.y, e.position.z]
        a.vel = [e.velocity?.x ?? a.vel[0], e.velocity?.y ?? a.vel[1], e.velocity?.z ?? a.vel[2]]
        a.known = e.position.clone()
      } else {
        a.pos = [a.pos[0] + a.vel[0], a.pos[1] + a.vel[1], a.pos[2] + a.vel[2]]
        a.vel = [a.vel[0] * 0.99, a.vel[1] * 0.99 - 0.05, a.vel[2] * 0.99]
      }
      if (e.metadata?.[10] !== true) out.push({ id: e.id, pos: a.pos, vel: a.vel })
    }
    for (const id of this.arrows.keys()) if (!present.has(id)) this.arrows.delete(id)
    return out
  }

  groundUnder (p) {
    const [x, z] = [Math.floor(p.x), Math.floor(p.z)]
    const top = Math.floor(p.y)
    for (let y = top; y >= top - 16; y--) {
      if (this.bot.blockAt(new Vec3(x, y, z), false)?.boundingBox === 'block') return y + 1
    }
    return p.y
  }

  // One tick of what this client can see, in the form MobTracker reads
  frame () {
    const bot = this.bot
    const me = bot.entity
    const eye = { x: me.position.x, y: me.position.y + 1.62, z: me.position.z }
    const mobs = []
    for (const e of Object.values(bot.entities)) {
      const kind = KIND_OF[e.name]
      if (kind === undefined || e === me || e.isValid === false || !e.position) continue
      if (e.position.distanceTo(me.position) > SEE_RADIUS) continue
      const hp = e.metadata?.[9]
      if (typeof hp === 'number' && hp <= 0) continue
      const head = { x: e.position.x, y: e.position.y + (e.height || 1.8) * 0.9, z: e.position.z }
      const row = {
        id: e.id,
        kind,
        pos: [e.position.x, e.position.y, e.position.z],
        hp: typeof hp === 'number' ? hp : (e.name === 'bogged' ? BOGGED_HEALTH : kind === 3 ? 40 : 20),
        yaw: simYaw(e.yaw ?? 0),
        swellDir: kind === 2 ? (e.metadata?.[16] ?? -1) : -1,
        angry: kind === 3 && e.metadata?.[17] === true,
        drawing: kind === 1 && !!((e.metadata?.[8] ?? 0) & 1),
        inSight: clearLine(bot, head, eye),
        maxHp: e.name === 'bogged' ? BOGGED_HEALTH : undefined
      }
      if (this.tracker.mobs.get(e.id)?.onGround === false) row.groundY = this.groundUnder(e.position)
      if (this.kicks.has(e.id)) row.kick = this.kicks.get(e.id)
      mobs.push(row)
    }
    this.kicks.clear()
    // a landed hit counts once its health update arrives, or after HIT_WAIT ticks without one
    const hitMobs = []
    for (const [id, age] of this.hits) {
      const old = this.tracker.mobs.get(id)
      const now = mobs.find(m => m.id === id)
      if (!now || (old && now.hp < old.hp) || age >= HIT_WAIT) {
        hitMobs.push(id)
        this.hits.delete(id)
      } else {
        this.hits.set(id, age + 1)
      }
    }
    const hurt = bot.health < this.lastHealth - 0.01
    this.lastHealth = bot.health
    const frame = {
      me: {
        pos: [me.position.x, me.position.y, me.position.z],
        vel: [me.velocity.x, me.velocity.y, me.velocity.z],
        yaw: simYaw(me.yaw),
        pitch: simPitch(me.pitch),
        onGround: !!me.onGround,
        hp: bot.health,
        wall: !!me.isCollidedHorizontally,
        hasShield: this.hasShield(),
        shield: this.hasShield()
      },
      mobs,
      arrows: this.trackArrows(),
      swung: this.swung,
      hurt,
      blocked: this.blocked,
      hitMobs,
      hurtMobs: [...this.hurtMobs]
    }
    this.swung = false
    this.blocked = false
    this.hurtMobs.clear()
    return frame
  }

  // The state for one decision, with this world's blocks
  state () {
    const bot = this.bot
    const s = this.tracker.state()
    const eye = [s.me.pos[0], s.me.pos[1] + (s.me.sneaking ? 1.27 : 1.62), s.me.pos[2]]
    const y = s.me.yaw * Math.PI / 180
    const [sinY, cosY] = [Math.sin(y), Math.cos(y)]
    s.rays = RAYS.map(([f, r, u]) => freeRay(bot, eye, [f * -sinY + r * -cosY, u, f * cosY + r * -sinY], RAY_RANGE))
    s.blockedBefore = (from, dir, t) => freeRay(bot, from, dir, t) < t
    return s
  }

  // Sets the movement keys for this action, without any that would walk it into a hazard
  keys (action) {
    const bot = this.bot
    const [fb, lr, sprint, jump, , , , use, , sneak] = action
    const m = bot.entity.yaw
    const forward = [-Math.sin(m), -Math.cos(m)]
    const right = [Math.cos(m), -Math.sin(m)]
    const safe = (dir, sign) => !unsafeStep(bot, dir[0] * sign, dir[1] * sign)
    const w = fb === 1 && safe(forward, 1)
    const s = fb === 2 && safe(forward, -1)
    const a = lr === 1 && safe(right, -1)
    const d = lr === 2 && safe(right, 1)
    bot.setControlState('forward', w)
    bot.setControlState('back', s)
    bot.setControlState('left', a)
    bot.setControlState('right', d)
    const run = sprint === 1 && w && sneak !== 1 && (this.sprintHeld || use !== 1)
    this.sprintHeld = run
    bot.setControlState('sprint', run)
    const vetoed = (fb === 1 && !w) || (fb === 2 && !s) || (lr === 1 && !a) || (lr === 2 && !d)
    bot.setControlState('jump', jump === 1 && !vetoed)
    bot.setControlState('sneak', sneak === 1)
  }

  turn (action, share) {
    const bot = this.bot
    const yaw = bot.entity.yaw + YAW_STEPS[action[4]] * Math.PI / 180 * share
    const pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, bot.entity.pitch + PITCH_STEPS[action[5]] * Math.PI / 180 * share))
    bot.look(yaw, pitch, true)
  }

  // A swing at whatever mob is under the crosshair now. Only mobs: never a player standing in the line
  swing () {
    const bot = this.bot
    const s = this.tracker.state()
    s.me.yaw = simYaw(bot.entity.yaw)
    s.me.pitch = simPitch(bot.entity.pitch)
    s.blockedBefore = (from, dir, t) => freeRay(bot, from, dir, t) < t
    const m = mobUnderCrosshair(s)
    const e = m ? bot.entities[m.id] : null
    this.swung = true
    if (!e) {
      bot.swingArm()
      return
    }
    const charged = this.tracker.charge() > CHARGED
    bot.attack(e)
    this.fighter.stats.swings++
    if (charged && this.sprintHeld) {
      bot.entity.velocity.x *= SPRINT_SLOWDOWN
      bot.entity.velocity.z *= SPRINT_SLOWDOWN
    }
  }

  // One decision: two game ticks in the simulator's order (half the turn, then the swing, then the move)
  async step (action, token) {
    const bot = this.bot
    const f = this.fighter
    const use = action[7] === 1 && this.hasShield()
    if (use) f.raise()
    else f.lower()
    this.keys(action)
    this.turn(action, 0.5)
    if (action[6] > 0 && !use) this.swing()
    await bot.waitForTicks(1)
    if (token.cancelled) return
    this.tracker.tick(this.frame(), action)
    this.turn(action, 0.5)
    if (action[6] === 2 && !use) this.swing()
    await bot.waitForTicks(1)
    if (token.cancelled) return
    this.tracker.tick(this.frame(), action)
    this.tracker.endDecision(action, 2)
    this.lastAt = Date.now()
  }

  // Takes its hands off the keys
  release () {
    if (!this.driving) return
    this.driving = false
    this.sprintHeld = false
    this.lastAt = Date.now()
    try { this.bot.clearControlStates() } catch {}
  }
}

// The best axe in the bag by damage per second, or null
function bestAxe (bot, melee) {
  let best = null
  let bestDps = 0
  for (const item of bot.inventory.items()) {
    if (!item.name.endsWith('_axe') || !melee[item.name]) continue
    const [damage, speed] = melee[item.name]
    if (damage * speed > bestDps) {
      best = { item, damage, speed, cooldown: Math.ceil(20 / speed) }
      bestDps = damage * speed
    }
  }
  return best
}

// Fights the target with the network. Resolves 'dead', 'stopped', or 'fallback' when the scripted fighter should take it
async function fightWithNet (fighter, target, token, net, { melee, live }) {
  const bot = fighter.bot
  if (KIND_OF[target.name] === undefined) {
    fighter.note(`scripted, the network never fought a ${target.name}`)
    return 'fallback'
  }
  const axe = bestAxe(bot, melee)
  if (!axe) {
    fighter.note('scripted, no axe in the bag and the network only trained with one')
    return 'fallback'
  }
  const ready = await net.ready()
  if (token.cancelled) return 'stopped'
  if (!ready.ok) {
    fighter.note(`scripted, ${ready.why}`)
    return 'fallback'
  }
  await fighter.readyHand(axe)
  if (token.cancelled) return 'stopped'
  if (bot.heldItem?.type !== axe.item.type) {
    fighter.note('scripted, could not get the axe into its hand')
    return 'fallback'
  }
  await fighter.readyShield()
  if (token.cancelled) return 'stopped'
  fighter.note('trained network')
  const driver = fighter.netDriver || (fighter.netDriver = new MobNetDriver(bot, fighter))
  driver.begin(20 / axe.speed)
  let misses = 0
  let chasing = false
  // the walk to a far mob keeps to its level: the network's guard covers its own keys, this covers the pathfinder
  const walking = bot.pathfinder.movements
  const onLevel = noDropMoves(walking)
  // after a cancel the next mode may already own the goal and the walking rules, so only its own rules are taken back
  const endChase = () => {
    if (!chasing) return
    chasing = false
    if (!token.cancelled) bot.pathfinder.setGoal(null)
    if (walking && bot.pathfinder.movements === onLevel) bot.pathfinder.setMovements(walking)
  }
  try {
    while (!token.cancelled) {
      const e = live(bot, target)
      if (!e) {
        fighter.stats.kills++
        return 'dead'
      }
      if (bot.heldItem?.type !== axe.item.type) {
        driver.release()
        fighter.note('scripted, the axe left its hand')
        return 'fallback'
      }
      const d = e.position.distanceTo(bot.entity.position)
      if (d > CHASE_FAR || (chasing && d > CHASE_NEAR)) {
        if (!chasing) {
          chasing = true
          fighter.lower()
          bot.clearControlStates()
          if (walking) bot.pathfinder.setMovements(onLevel)
          bot.pathfinder.setGoal(new goals.GoalFollow(e, CHASE_STOP), true)
        }
        for (let i = 0; i < 2 && !token.cancelled; i++) {
          await bot.waitForTicks(1)
          if (!token.cancelled) driver.tracker.tick(driver.frame(), IDLE_ACTION)
        }
        if (token.cancelled) break
        driver.tracker.endDecision(IDLE_ACTION, 2)
        driver.lastAt = Date.now()
        continue
      }
      endChase()
      const s = driver.state()
      const answer = await net.act(bot.username, buildMobInputs(s), buildMobMask(s))
      if (token.cancelled) break
      if (answer) misses = 0
      else if (++misses >= MISSES) {
        net.down = true
        driver.release()
        fighter.note('scripted, the network stopped answering')
        return 'fallback'
      }
      const move = driver.guard.decide(answer || IDLE_ACTION, e)
      if (move.handover) {
        driver.release()
        fighter.note(`scripted, ${move.handover}`)
        return 'fallback'
      }
      fighter.note(move.label)
      await driver.step(move.action, token)
    }
    return 'stopped'
  } finally {
    endChase()
  }
}

module.exports = { MobNet, MobNetDriver, sharedMobNet, checkParity, fightWithNet, bestAxe, unsafeStep, freeRay, netFile }
