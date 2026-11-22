// One fighter on a real server: the simulator's 130 inputs and action masks, built only from what this client
// receives, and each action of the 11 heads turned into keys, turns, clicks and item use.
//
// Angles follow the simulator (fighter/src/fighter/obs.py): yaw in degrees with 0 facing +Z, pitch in degrees
// with positive looking down. Mineflayer keeps radians with its own zero, and simYaw and simPitch convert.
// A mob enemy is read the way the simulator shows it in seat 1: a player sized body holding a sword, or a bow
// for a skeleton, whose swing charge always reads full.
//
// Two kinds of ground. With the arena option the floor and walls are known, as in the simulator's flat arena, and
// the enemy is always in sight. Without it the bot keeps a memory of the blocks it has seen: block rays stop at
// cells it never saw, and an enemy behind cover keeps its last seen place and motion.

const { Vec3 } = require('vec3')
const { toNotchianYaw, toNotchianPitch } = require('mineflayer/lib/conversions')
const { HealthEstimate, APPLES, EAT_TICKS, meleeDamage, arrowDamage } = require('./fair_health')

const OBS_DIM = 130
const MAX_HEALTH = 20
const EYE = 1.62
const SNEAK_EYE = 1.27
const SNEAK_HEIGHT = 1.5
const POSE_CROUCHING = 5
const PLAYER_W = 0.6
const PLAYER_H = 1.8
const REACH = 3.0
const FAR_REACH = 64
const HURT_TICKS = 10
const FULL_CHARGE = 0.848
const SHIELD_RAISE_TICKS = 6
const SHIELD_DISABLE_TICKS = 100
const CROSSBOW_LOAD_TICKS = 25
const CROSSBOW_RELOAD_DELAY = 4  // ticks after a shot before loading can start, with the key held or pressed again
const ATTACKER_SLOWDOWN = 0.6
const CHARGED_HIT = 0.9
const CROSSBOW_SPEED = 3.15
// The crossbow and sword rules on the action mask (fighter/src/fighter/stance.py), and the swing charge they train with
const PLAN_READY_GATE = 0.9
const FLOOR_MARGIN = 1e-3
const LOAD_ABORT_PROGRESS = 0.75
const AXE_RULE_RANGE = 3.0
const FAR_SHOT_RANGE = 6.0
const JUST_DISABLED = 0.9
const ENEMY_HURT_WINDOW = 0.2
const INPUT_ENEMY_DISTANCE = 32
const INPUT_ENEMY_IN_SIGHT = 38
const INPUT_ENEMY_HURT = 46
const INPUT_ENEMY_SHIELD_UP = 52
const INPUT_ENEMY_SHIELD_DISABLED = 54
const INPUT_ENEMY_FACING = 55
const INPUT_CLEAR_LINE = 37
const INPUT_AIM_WIDTHS = 79
const GUN_MIN_RANGE = 4.5     // inside this the fight is the axe's
const GUN_FORCE_RANGE = 7     // past this the crossbow comes out, loaded or not
const GUN_REST_STEPS = 8      // decisions the crossbow stays away after a shield turned it back
const CHASE_RANGE = 3.5       // with the axe out it runs at an enemy further than this
const CHASE_FACING = 0.7      // only while roughly facing it
const INPUT_AIM_COS = 27
const BOW_SPEED = 3.0
const BOW_FULL_DRAW_TICKS = 20
const BOW_MIN_DRAW_TICKS = 3
const AIM_MIN_POWER = 0.1
const START_ARROWS = 6
const CHEST = 1.2
const FEET = 0.1
const ROUND_SCALE = 1200
const TRACKING_RANGE = 160
const GROUND_SPEED = 0.005
const STILL_SPEED = 0.02
const NEVER = 100
const WHIFF_PUNISH_WINDOW = 20
const WHIFF_WAIT = 4
const FINE_TURN_RANGE = 9
const ARROW_DRAG = 0.99
const ARROW_GRAVITY = 0.05
const LOG_ARROW_DRAG = Math.log(ARROW_DRAG)
const VERTICAL_DRAG = 0.98
const BODY_GRAVITY = 0.08
const LOG_BODY_DRAG = Math.log(VERTICAL_DRAG)
const BODY_TERMINAL = 0.08 * VERTICAL_DRAG / (1 - VERTICAL_DRAG)
const SOLVER_ITERATIONS = 4
const SPAWN_BELOW_EYE = 0.1
const ARROW_TARGET_MARGIN = 0.6
const MAX_LOFT = 1.4
const MIN_REACH_FRACTION = 0.05
const NO_REACH_WIDTHS = 99
const ON_TARGET_MISS = 1.3
const PICKUP_SEEN_AGE = 20
const PICKUP_SEE_RANGE = 4
const PICKUP_BELOW = 1.0
const PICKUP_ABOVE_HEAD = 0.5
const RAY_RANGE = 8
const SIGHT_RANGE = 8
const MEMORY_BEHIND = 16  // remembered cells run from 16 below the eye's cell to 15 above it on each axis
const MEMORY_AHEAD = 15
const VIEW_H = 1.4281480067421146
const VIEW_V = 0.7002075382097097
const SHOT_MISS_TICKS = 40
const BORDER_SCALE = 16
const GROUND_SEARCH = 48
const ARROW_IN_GROUND = 10
const DESYNC_TICKS = 20
const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose', 'powder_snow'])
const ATTACK_SPEED = { sword: 1.6, axe: 1.0, bow: 4.0, crossbow: 4.0, none: 4.0 }

// The action heads, in the simulator's order (fighter/src/fighter/actions.py)
const YAW_STEPS = [-90, -45, -20, -10, -4, -1.5, 0, 1.5, 4, 10, 20, 45, 90, 180, -0.5, 0.5, -0.25, 0.25]
const PITCH_STEPS = [-40, -20, -8, -3, -1, 0, 1, 3, 8, 20, 40, -0.5, 0.5, -0.25, 0.25]
const ACTION_DIMS = [3, 3, 2, 2, YAW_STEPS.length, PITCH_STEPS.length, 3, 2, 5, 2, 2]
const HEAD_OFFSETS = ACTION_DIMS.reduce((acc, size, i) => { acc.push(i ? acc[i - 1] + ACTION_DIMS[i - 1] : 0); return acc }, [])
const MASK_SIZE = ACTION_DIMS.reduce((a, b) => a + b, 0)
const [FORWARD, STRAFE, SPRINT, JUMP, YAW, PITCH, ATTACK, USE, WEAPON, SNEAK, LOCK_AIM] = ACTION_DIMS.keys()
const IDLE_ACTION = [0, 0, 0, 0, YAW_STEPS.indexOf(0), PITCH_STEPS.indexOf(0), 0, 0, 0, 0, 0]
const FORWARD_VALUES = [0, 1, -1]
const STRAFE_VALUES = [0, -1, 1]
const FINE_YAW = YAW_STEPS.map(s => s !== 0 && Math.abs(s) < 1)
const FINE_PITCH = PITCH_STEPS.map(s => s !== 0 && Math.abs(s) < 1)
// Weapon head: keep, axe, sword, crossbow, bow. Hotbar slots hold them in the same order from slot 0.
const WEAPON_HEAD = ['keep', 'axe', 'sword', 'crossbow', 'bow']
const SLOT_OF = { axe: 0, sword: 1, crossbow: 2, bow: 3 }
const SLOT_AXE = SLOT_OF.axe
const SLOT_SWORD = SLOT_OF.sword
const SLOT_CROSSBOW = SLOT_OF.crossbow
const SLOT_BOW = SLOT_OF.bow

const RAY_DIRS = (() => {
  const rows = []
  for (const p of [55, 20, 0]) {
    const r = p * Math.PI / 180
    for (let k = 0; k < 8; k++) {
      const a = 2 * Math.PI * k / 8
      rows.push([Math.cos(a) * Math.cos(r), Math.sin(a) * Math.cos(r), -Math.sin(r)])
    }
  }
  rows.push([0, 0, 1], [0, 0, -1])
  return rows.map(([f, r, u]) => ({ f, r, u, sin: Math.sin(Math.atan2(r, f)), cos: Math.cos(Math.atan2(r, f)) }))
})()

const rad = d => d * Math.PI / 180
const deg = r => r * 180 / Math.PI
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const wrapDeg = a => ((a + 180) % 360 + 360) % 360 - 180
const simYaw = m => 180 - deg(m)
const simPitch = m => -deg(m)
const hyp = (x, z) => Math.hypot(x, z)

// View yaw and pitch along a vector, in simulator degrees
function viewAngles (d) {
  return [deg(Math.atan2(-d.x, d.z)), -deg(Math.atan2(d.y, hyp(d.x, d.z)))]
}

// Forward and right parts of a world vector for a simulator yaw in degrees
function ego (x, z, yawDeg) {
  const s = Math.sin(rad(yawDeg))
  const c = Math.cos(rad(yawDeg))
  return [x * -s + z * c, x * -c + z * -s]
}

function lookVector (yawDeg, pitchDeg) {
  const y = rad(yawDeg)
  const p = rad(pitchDeg)
  return { x: -Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: Math.cos(y) * Math.cos(p) }
}

// Entry distance of a ray into a box, or null when it misses
function rayBox (o, d, lo, hi) {
  let entry = -Infinity
  let exit = Infinity
  for (const k of ['x', 'y', 'z']) {
    const step = Math.abs(d[k]) < 1e-9 ? 1e-9 : d[k]
    const a = (lo[k] - o[k]) / step
    const b = (hi[k] - o[k]) / step
    entry = Math.max(entry, Math.min(a, b))
    exit = Math.min(exit, Math.max(a, b))
  }
  entry = Math.max(entry, 0)
  return exit >= entry ? entry : null
}

function weaponOf (item) {
  if (!item) return 'none'
  if (item.name.endsWith('_axe')) return 'axe'
  if (item.name.endsWith('_sword')) return 'sword'
  if (item.name === 'crossbow') return 'crossbow'
  if (item.name === 'bow') return 'bow'
  return 'none'
}

// The shot solve of fighter/src/fighter/arrows.py intercept. After k ticks an arrow has moved 100 v (1 - 0.99^k)
// sideways and (vy + 5) 100 (1 - 0.99^k) - 5 k upward. The aim point follows the target for the flight time, stays
// inside the arena and a falling target stops at the floor. Returns simulator yaw and pitch and the flight ticks.
function intercept (from, target, tv, airborne, ground, speed, carry, center, limit) {
  const rate = 1 / Math.max(speed, 1e-6)
  const first = hyp(target.x - from.x, target.z - from.z) * rate * (1 - ARROW_DRAG)
  let flight = Math.max(Math.log1p(-Math.min(first, 0.98)) / LOG_ARROW_DRAG, 0.5)
  const need = { x: 0, y: 0, z: 0 }
  for (let i = 0; i < SOLVER_ITERATIONS; i++) {
    const ax = clamp(target.x + tv.x * flight, center.x - limit, center.x + limit)
    const az = clamp(target.z + tv.z * flight, center.z - limit, center.z + limit)
    let ay = target.y
    if (airborne) {
      const fall = (tv.y + BODY_TERMINAL) * -Math.expm1(LOG_BODY_DRAG * flight) / (1 - VERTICAL_DRAG) - BODY_TERMINAL * flight
      ay = Math.max(target.y + fall, ground)
    }
    const reach = -100 * Math.expm1(LOG_ARROW_DRAG * flight)
    need.x = (ax - from.x) / reach - carry.x
    need.y = (ay + CHEST - from.y + 5 * flight) / reach - 5 - carry.y
    need.z = (az - from.z) / reach - carry.z
    const size = Math.hypot(need.x, need.y, need.z)
    const scaled = Math.min(Math.max(reach * size * rate * 0.01, 1e-4), 0.98)
    flight = Math.max(Math.log1p(-scaled) / LOG_ARROW_DRAG, 0.5)
  }
  return { yaw: deg(Math.atan2(-need.x, need.z)), pitch: -deg(Math.atan2(need.y, hyp(need.x, need.z))), flight }
}

// The cells within sight range, nearest first, each with the cell before it on the straight line from the eye
const SIGHT_CELLS = (() => {
  const cells = []
  const limit = (SIGHT_RANGE + 0.5) ** 2
  for (let x = -SIGHT_RANGE; x <= SIGHT_RANGE; x++) {
    for (let y = -SIGHT_RANGE; y <= SIGHT_RANGE; y++) {
      for (let z = -SIGHT_RANGE; z <= SIGHT_RANGE; z++) {
        if (x * x + y * y + z * z <= limit) cells.push({ x, y, z, order: Math.abs(x) + Math.abs(y) + Math.abs(z) })
      }
    }
  }
  cells.sort((a, b) => a.order - b.order)
  const index = new Map(cells.map((c, i) => [`${c.x},${c.y},${c.z}`, i]))
  for (const c of cells) {
    let [px, py, pz] = [0, 0, 0]
    let [cx, cy, cz] = [0, 0, 0]
    const steps = Math.max(Math.abs(c.x), Math.abs(c.y), Math.abs(c.z)) * 8
    for (let s = 1; s <= steps; s++) {
      const nx = Math.round(c.x * s / steps)
      const ny = Math.round(c.y * s / steps)
      const nz = Math.round(c.z * s / steps)
      if (nx === c.x && ny === c.y && nz === c.z) break
      if (nx !== cx || ny !== cy || nz !== cz) { [px, py, pz] = [nx, ny, nz]; [cx, cy, cz] = [nx, ny, nz] }
    }
    c.pred = c.order === 0 ? -1 : index.get(`${px},${py},${pz}`)
  }
  return cells
})()

function blockClass (block) {
  if (!block) return { solid: false, opaque: false, water: false, stop: false }
  const name = block.name
  const lava = name === 'lava'
  const fire = name === 'fire' || name === 'soul_fire'
  const solid = block.boundingBox === 'block'
  return { solid, opaque: lava || (solid && !block.transparent), water: name === 'water', stop: solid || lava || fire, hazard: lava || fire }
}

// The view volume of a look, as five planes that a point inside is not past
function viewPlanes (yawDeg, pitchDeg) {
  const y = rad(yawDeg)
  const p = rad(pitchDeg)
  const [sy, cy, sp, cp] = [Math.sin(y), Math.cos(y), Math.sin(p), Math.cos(p)]
  const F = [-sy * cp, -sp, cy * cp]
  const R = [cy, 0, sy]
  const U = [-sy * sp, cp, cy * sp]
  const mix = (a, sign, k) => [sign * a[0] - k * F[0], sign * a[1] - k * F[1], sign * a[2] - k * F[2]]
  return [mix(R, 1, VIEW_H), mix(R, -1, VIEW_H), mix(U, 1, VIEW_V), mix(U, -1, VIEW_V), [-F[0], -F[1], -F[2]]]
}

// Steps a line through whole cells from o along d. visit(x, y, z, t) returning true stops the walk
function walkCells (o, d, maxT, visit) {
  let [x, y, z] = [Math.floor(o.x), Math.floor(o.y), Math.floor(o.z)]
  const sx = d.x > 0 ? 1 : -1
  const sy = d.y > 0 ? 1 : -1
  const sz = d.z > 0 ? 1 : -1
  const ix = Math.abs(d.x) > 1e-12 ? Math.abs(1 / d.x) : 1e30
  const iy = Math.abs(d.y) > 1e-12 ? Math.abs(1 / d.y) : 1e30
  const iz = Math.abs(d.z) > 1e-12 ? Math.abs(1 / d.z) : 1e30
  let tx = Math.abs(d.x) > 1e-12 ? (d.x > 0 ? x + 1 - o.x : o.x - x) * ix : 1e30
  let ty = Math.abs(d.y) > 1e-12 ? (d.y > 0 ? y + 1 - o.y : o.y - y) * iy : 1e30
  let tz = Math.abs(d.z) > 1e-12 ? (d.z > 0 ? z + 1 - o.z : o.z - z) * iz : 1e30
  for (let guard = 0; guard < 256; guard++) {
    let now
    if (tx <= ty && tx <= tz) { now = tx; tx += ix; x += sx } else if (tz <= ty) { now = tz; tz += iz; z += sz } else { now = ty; ty += iy; y += sy }
    if (now > maxT) return
    if (visit(x, y, z, now)) return
  }
}

// What one bot remembers of the blocks around it. A cell is read only through a see through cell already reached
// on the line from the eye, inside the view. A remembered block can be stale, and a cell never seen stays unknown.
class SeenBlocks {
  constructor (bot) {
    this.bot = bot
    this.cells = new Map()
    this.center = null
  }

  clear () {
    this.cells.clear()
    this.center = null
  }

  remember (x, y, z, cell) {
    this.cells.set(`${x},${y},${z}`, { ...cell, x, y, z })
  }

  // Forgets every cell outside the window around the eye's cell
  recenter (x, y, z) {
    const c = this.center
    if (c && c.x === x && c.y === y && c.z === z) return
    this.center = { x, y, z }
    const inside = (v, mid) => v >= mid - MEMORY_BEHIND && v <= mid + MEMORY_AHEAD
    for (const [key, cell] of this.cells) {
      if (!inside(cell.x, x) || !inside(cell.y, y) || !inside(cell.z, z)) this.cells.delete(key)
    }
  }

  known (x, y, z) {
    return this.cells.get(`${x},${y},${z}`)
  }

  actual (x, y, z) {
    return blockClass(this.bot.blockAt(new Vec3(x, y, z), false))
  }

  lineClear (eye, x, y, z) {
    const q = { x: x + 0.5, y: y + 0.5, z: z + 0.5 }
    const d = { x: q.x - eye.x, y: q.y - eye.y, z: q.z - eye.z }
    let open = true
    walkCells(eye, d, 1, (cx, cy, cz) => {
      if (cx === x && cy === y && cz === z) return true
      if (this.actual(cx, cy, cz).opaque) { open = false; return true }
      return false
    })
    return open
  }

  update (eye, yawDeg, pitchDeg) {
    const planes = viewPlanes(yawDeg, pitchDeg)
    const radius = planes.map(p => 0.5 * (Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2])))
    const [ix, iy, iz] = [Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)]
    this.recenter(ix, iy, iz)
    const open = new Uint8Array(SIGHT_CELLS.length)
    const here = this.actual(ix, iy, iz)
    this.remember(ix, iy, iz, here)
    open[0] = here.opaque ? 0 : 1
    for (let k = 1; k < SIGHT_CELLS.length; k++) {
      const c = SIGHT_CELLS[k]
      if (!open[c.pred]) continue
      const dx = ix + c.x + 0.5 - eye.x
      const dy = iy + c.y + 0.5 - eye.y
      const dz = iz + c.z + 0.5 - eye.z
      let inside = true
      for (let q = 0; q < 5; q++) {
        if (planes[q][0] * dx + planes[q][1] * dy + planes[q][2] * dz - radius[q] > 0) { inside = false; break }
      }
      if (!inside) continue
      const [x, y, z] = [ix + c.x, iy + c.y, iz + c.z]
      const seen = this.actual(x, y, z)
      const old = this.known(x, y, z)
      if ((!old || old.solid !== seen.solid || old.opaque !== seen.opaque || old.water !== seen.water || old.stop !== seen.stop) && this.lineClear(eye, x, y, z)) {
        this.remember(x, y, z, seen)
      }
      open[k] = seen.opaque ? 0 : 1
    }
  }

  // Whether a straight line to a point is open: inside the view it stops at the first opaque block, outside only
  // at a remembered one
  lineOpen (eye, q, planes) {
    const d = { x: q.x - eye.x, y: q.y - eye.y, z: q.z - eye.z }
    const inView = planes.every(p => p[0] * d.x + p[1] * d.y + p[2] * d.z <= 0)
    const [qx, qy, qz] = [Math.floor(q.x), Math.floor(q.y), Math.floor(q.z)]
    if (Math.floor(eye.x) === qx && Math.floor(eye.y) === qy && Math.floor(eye.z) === qz) return true
    let open = true
    walkCells(eye, d, 1, (x, y, z) => {
      if (x === qx && y === qy && z === qz) return true
      const cell = inView ? this.actual(x, y, z) : this.known(x, y, z)
      if (cell && cell.opaque) { open = false; return true }
      return false
    })
    return open
  }

  // Free distance along a ray, whether it stopped at a hazard and the distance to the first water, or -1
  ray (eye, dir, maxT) {
    const start = this.known(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z))
    const out = { free: maxT, hazard: false, water: start && start.water ? 0 : -1 }
    walkCells(eye, dir, maxT, (x, y, z, t) => {
      const cell = this.known(x, y, z)
      if (!cell) { out.free = t; return true }
      if (cell.stop) { out.free = t; out.hazard = !!cell.hazard; return true }
      if (cell.water && out.water < 0) out.water = t
      return false
    })
    return out
  }
}

// What this client sees of the enemy, a player found by name or an entity found by lookup.
class EnemyView {
  constructor (bot, username) {
    this.bot = bot
    this.username = username
    this.lookup = null
    this.reset()
    bot.on('physicsTick', () => this.tick())
    bot.on('entitySwingArm', e => { if (e === this.entity()) { this.ticksSinceSwing = 0; this.swingSeen = true } })
    bot.on('entityHurt', e => {
      if (e !== this.entity()) return
      this.ticksSinceHurt = 0
      if (this.hurtTimer === 0) this.hurtTimer = HURT_TICKS
    })
    bot.on('entityEquip', e => {
      if (e !== this.entity()) return
      const w = weaponOf(e.heldItem)
      if (w !== this.lastWeapon) this.ticksSinceSwitch = 0
      this.lastWeapon = w
    })
  }

  entity () {
    const e = this.lookup ? this.lookup() : this.bot.players[this.username]?.entity
    return e && e.isValid !== false ? e : null
  }

  isMob () {
    const e = this.entity()
    return !!this.lookup || (!!e && e.type !== 'player')
  }

  tick () {
    this.ticksSinceSwing++
    this.ticksSinceSwitch++
    this.ticksSinceHurt++
    if (this.hurtTimer > 0) this.hurtTimer--
    if (this.shieldCooldown > 0) this.shieldCooldown--
    this.shieldTicks = this.shieldUp() ? this.shieldTicks + 1 : 0
    this.useTicks = this.rangedUse() ? this.useTicks + 1 : 0
    const e = this.entity()
    if (!e) return
    // Position packets do not line up with our ticks, so the motion is averaged over the last few
    this.history.push(e.position.clone())
    if (this.history.length > 4) this.history.shift()
    const first = this.history[0]
    const n = this.history.length - 1
    if (n > 0) this.vel = { x: (e.position.x - first.x) / n, y: (e.position.y - first.y) / n, z: (e.position.z - first.z) / n }
    const hp = this.health()
    if (hp != null && this.lastHealth != null && hp < this.lastHealth) this.damageTaken += this.lastHealth - hp
    if (hp != null) this.lastHealth = hp
  }

  // The motion to lead by: sideways the last tick's movement, and the fall speed the next tick will have, which is
  // what remains of the last vertical step after gravity and drag
  leadVel () {
    const v = this.vel
    return { x: v.x, y: (v.y - BODY_GRAVITY) * VERTICAL_DRAG, z: v.z }
  }

  airborne () {
    return this.history.length >= 2 && Math.abs(this.vel.y) >= GROUND_SPEED
  }

  health () {
    const h = this.entity()?.metadata?.[9]
    return typeof h === 'number' ? h : null
  }

  handActive () {
    return ((this.entity()?.metadata?.[8] ?? 0) & 1) === 1
  }

  weapon () {
    const e = this.entity()
    if (!e) return 'none'
    if (this.isMob()) return e.name === 'skeleton' ? 'bow' : 'sword'
    return weaponOf(e.heldItem)
  }

  holdsRanged () {
    const w = this.isMob() ? weaponOf(this.entity()?.heldItem) : this.weapon()
    return w === 'crossbow' || w === 'bow'
  }

  shieldUp () {
    if (this.isMob() || !this.handActive() || this.holdsRanged()) return false
    const e = this.entity()
    const offhand = ((e.metadata?.[8] ?? 0) & 2) === 2
    return (offhand ? e.equipment?.[1] : e.heldItem)?.name === 'shield'
  }

  shieldActive () {
    return this.shieldUp() && this.shieldTicks + 1 >= SHIELD_RAISE_TICKS
  }

  rangedUse () {
    return this.handActive() && this.holdsRanged()
  }

  crossbowLoaded () {
    const item = this.entity()?.heldItem
    if (this.isMob() || item?.name !== 'crossbow') return false
    const c = (item.components ?? []).find(x => x.type === 'charged_projectiles')
    return (c?.data?.projectiles ?? c?.data ?? []).length > 0
  }

  // The pose entry of the entity metadata, sent by name or by its number
  crouching () {
    const pose = this.entity()?.metadata?.[6]
    return !this.isMob() && (pose === 'crouching' || pose === POSE_CROUCHING)
  }

  sprinting () {
    return !this.isMob() && ((this.entity()?.metadata?.[0] ?? 0) & 0x08) !== 0
  }

  // A mob's swing charge reads full, as the simulator's parked seat shows it
  charge () {
    if (this.isMob()) return 1
    const period = 20 / ATTACK_SPEED[this.weapon()]
    return clamp((Math.min(this.ticksSinceSwing, this.ticksSinceSwitch) + 0.5) / period, 0, 1)
  }

  reset () {
    this.history = []
    this.vel = { x: 0, y: 0, z: 0 }
    this.ticksSinceSwing = 1000
    this.ticksSinceSwitch = 1000
    this.ticksSinceHurt = 1000
    this.hurtTimer = 0
    this.lastWeapon = null
    this.shieldCooldown = 0
    this.shieldTicks = 0
    this.useTicks = 0
    this.swingSeen = false
    this.lastHealth = this.health?.() ?? null
    this.damageTaken = 0
  }
}

class Fighter {
  // options: arena {x, y, z, half} for a known flat arena centered there, with its floor at y, and
  // allowedWeapons, a set of weapon names. Without an arena the bot works from the blocks it has seen.
  // planRules: the crossbow and sword rules on the action mask, on by default for a fighter in a known arena
  constructor (bot, enemyName, options = {}) {
    this.bot = bot
    this.enemy = new EnemyView(bot, enemyName)
    this.arena = options.arena ?? null
    this.borderHalf = options.arena?.half ?? 12
    this.planRules = options.planRules ?? !!options.arena
    this.rangeRules = !!options.rangeRules
    this.gunForceRange = options.gunForceRange ?? GUN_FORCE_RANGE
    this.readyGate = options.readyGate ?? (this.planRules ? PLAN_READY_GATE : FULL_CHARGE)
    this.allowedWeapons = options.allowedWeapons ?? (this.planRules ? new Set(['axe', 'sword', 'crossbow']) : null)
    this.memory = new SeenBlocks(bot)
    this.fairHealth = false
    this.hpEst = new HealthEstimate()
    this.arrowsSeen = new Map()
    this.arrowOwner = new Map()
    this.reset(false)
    // The physics patch (patch-physics.js) reads this before every move, so it always holds this tick's item use
    Object.defineProperty(bot, 'fighterUsingItem', { configurable: true, enumerable: true, get: () => this.usingItem() })

    bot.on('physicsTick', () => this.tick())
    bot._client.on('set_cooldown', p => {
      if (/shield/.test(p.cooldownGroup ?? p.itemId ?? '') && p.cooldownTicks > 0) {
        this.shieldCooldown = p.cooldownTicks
        this.shieldUp = false
        this.ticksSinceDisabled = 0
        this.events.myShieldBroken++
      }
    })
    bot.on('entityHurt', e => {
      if (e === bot.entity) {
        this.ticksSinceHurt = 0
        if (this.hurtTimer === 0) this.hurtTimer = HURT_TICKS
        this.combo = 0
        this.freshCombo = true
      } else if (e && e === this.enemy.entity()) {
        this.ticksSinceHit = 0
        this.combo = this.freshCombo ? 1 : this.combo + 1
        this.freshCombo = false
        if (this.ticksSinceWhiff <= WHIFF_PUNISH_WINDOW) this.ticksSinceWhiff = NEVER
      }
    })
    bot.on('entitySwingArm', e => { if (e && e === this.enemy.entity()) this.whiffCheck = WHIFF_WAIT })
    bot._client.on('spawn_entity', p => {
      const name = bot.registry.entities[p.type]?.name
      if (name !== 'arrow' && name !== 'spectral_arrow') return
      const owner = p.objectData
      this.arrowOwner.set(p.entityId, owner)
      const v = p.velocity && typeof p.velocity === 'object' ? p.velocity : { x: (p.velocityX ?? 0) / 8000, y: (p.velocityY ?? 0) / 8000, z: (p.velocityZ ?? 0) / 8000 }
      this.arrowsSeen.set(p.entityId, { pos: new Vec3(p.x, p.y, p.z), vel: { x: v.x, y: v.y, z: v.z }, known: null, groundAge: 0 })
      if (owner === bot.entity?.id) {
        this.events.shotsSeen++
        this.myShots.set(p.entityId, { speed: this.lastShot?.speed ?? CROSSBOW_SPEED, full: this.lastShot?.full ?? true, age: 0 })
      }
    })
    bot._client.on('damage_event', p => {
      const enemy = this.enemy.entity()
      if (!enemy || p.entityId !== enemy.id) return
      const direct = p.sourceDirectId - 1
      if (direct === bot.entity.id) {
        this.events.meleeDamaged++
        if (this.fairHealth && this.pendingMelee) this.hpEst.hit(this.pendingMelee.amount, false, true)
        this.pendingMelee = null
      } else if (this.arrowOwner.get(direct) === bot.entity.id) {
        this.events.arrowHits++
        if (this.fairHealth) this.hpEst.hit(this.shotDamage(direct), false, true)
      }
    })
    bot._client.on('sound_effect', p => {
      const name = p.sound?.data?.soundName ?? bot.registry.sounds?.[(p.sound?.soundId ?? p.soundId) + 1]?.name ?? ''
      if (name !== 'item.shield.block' && name !== 'item.shield.break') return
      const at = { x: p.x / 8, y: p.y / 8, z: p.z / 8 }
      const e = this.enemy.entity()
      const dist = ent => ent ? Math.hypot(at.x - ent.position.x, at.y - ent.position.y, at.z - ent.position.z) : 99
      if (e && dist(e) < dist(bot.entity) && dist(e) < 1.5) {
        if (name === 'item.shield.break') this.enemy.shieldCooldown = SHIELD_DISABLE_TICKS
        else if (this.ticksSinceAttack <= 3) {
          this.events.blocked++
          if (this.fairHealth) { this.hpEst.hit(0, true, true); this.pendingMelee = null }
        }
      } else if (dist(bot.entity) < 1.5 && name === 'item.shield.block') {
        this.ticksSinceMyBlock = 0
      }
    })
  }

  // Everything that counts by ticks moves on here, once per client tick
  tick () {
    const me = this.bot.entity
    this.lastObs = null
    this.ticks++
    this.ticksSinceSwing++
    this.ticksSinceHit++
    this.ticksSinceHurt++
    this.ticksSinceDisabled++
    this.ticksSinceWhiff++
    this.ticksSinceMyBlock++
    this.ticksSinceAttack++
    if (this.hurtTimer > 0) this.hurtTimer--
    if (this.shieldCooldown > 0) this.shieldCooldown--
    this.shieldTicks = this.shieldUp ? this.shieldTicks + 1 : 0
    // a raise the server did not take shows as our own hand staying inactive
    if (this.shieldUp && this.shieldTicks >= 4 && !this.ownHandActive()) this.shieldUp = false
    if (this.whiffCheck > 0 && --this.whiffCheck === 0 && this.ticksSinceHurt > WHIFF_WAIT && this.ticksSinceMyBlock > WHIFF_WAIT) {
      this.ticksSinceWhiff = WHIFF_WAIT
    }
    if (this.charging) this.loadTicks++
    if (this.charging && this.loadTicks >= CROSSBOW_LOAD_TICKS - 1) this.awaitLoad = 10
    this.confirmLoad()
    if (this.awaitLoad > 0 && !this.charging) this.awaitLoad--
    if (this.drawing) this.drawTicks++
    if (this.reloadDelay > 0) this.reloadDelay--
    // fall distance, the way the server adds it up: downward movement while off the ground
    if (this.lastY != null) {
      const dy = me.position.y - this.lastY
      this.fall = me.onGround ? 0 : (dy < 0 ? this.fall - dy : this.fall)
    }
    this.lastY = me.position.y
    if (this.lastPos) this.lastMove = { x: me.position.x - this.lastPos.x, y: me.position.y - this.lastPos.y, z: me.position.z - this.lastPos.z }
    this.lastPos = me.position.clone()
    const hp = this.bot.health
    if (this.lastHealth != null && hp < this.lastHealth) this.events.damageTaken += this.lastHealth - hp
    this.lastHealth = hp
    this.trackArrows()
    for (const s of this.myShots.values()) s.age++
    if (this.fairHealth) this.fairHealthTick()
    this.syncWithServer()
    if (this.secondClick) {
      this.secondClick = false
      if (!this.shieldUp) this.swing()
    }
  }

  // Fair health: the enemy input is this bot's own estimate (fair_health.js). kind is the enemy's kind and
  // naturalRegen whether the server heals players by itself
  setFairHealth (on, kind = 'player', naturalRegen = false) {
    this.fairHealth = !!on
    this.hpEst.naturalRegen = naturalRegen
    this.hpEst.reset(kind)
    this.pendingMelee = null
    this.enemyEating = 0
  }

  fairHealthTick () {
    this.hpEst.tick()
    if (this.pendingMelee && --this.pendingMelee.ticks <= 0) {
      if (this.hpEst.inside()) this.hpEst.hit(this.pendingMelee.amount, false, false)
      this.pendingMelee = null
    }
    const e = this.enemy.entity()
    const active = e && this.enemy.handActive()
    const offhand = active && ((e.metadata?.[8] ?? 0) & 2) === 2
    const item = active ? (offhand ? e.equipment?.[1] : e.heldItem)?.name : null
    if (item && APPLES[item]) {
      if (++this.enemyEating === EAT_TICKS) this.hpEst.ate(item)
    } else this.enemyEating = 0
  }

  shotDamage (id) {
    const s = this.myShots.get(id)
    if (!s) return arrowDamage(CROSSBOW_SPEED, 0, true)
    return arrowDamage(s.speed, Math.min(s.age, SHOT_MISS_TICKS), s.full)
  }

  ownHandActive () {
    return ((this.bot.entity?.metadata?.[8] ?? 0) & 1) === 1
  }

  // Whether the game counts this client as using an item, which cuts its movement input to 20%: a raised shield, a
  // drawn bow, or a crossbow from the press until the key is let go, also after it has loaded
  usingItem () {
    return this.shieldUp || this.charging || this.holdingLoad || this.drawing
  }

  weapon () {
    return weaponOf(this.bot.heldItem)
  }

  charge () {
    return clamp((this.ticksSinceSwing + 0.5) / (20 / ATTACK_SPEED[this.weapon()]), 0, 1)
  }

  eyeHeight () {
    return this.bot.getControlState('sneak') ? SNEAK_EYE : EYE
  }

  eye () {
    return this.bot.entity.position.offset(0, this.eyeHeight(), 0)
  }

  // Arrow positions arrive rarely, so each flying arrow moves on by the arrow rule between updates
  trackArrows () {
    for (const [id, a] of this.arrowsSeen) {
      const e = this.bot.entities[id]
      if (!e) { this.arrowsSeen.delete(id); this.arrowOwner.delete(id); continue }
      const grounded = e.metadata?.[ARROW_IN_GROUND] === true
      if (grounded) {
        a.groundAge++
        a.pos = e.position.clone()
        a.vel = { x: 0, y: 0, z: 0 }
      } else if (!a.known || !a.known.equals(e.position)) {
        a.pos = e.position.clone()
        a.vel = { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z }
      } else {
        a.pos = a.pos.offset(a.vel.x, a.vel.y, a.vel.z)
        a.vel = { x: a.vel.x * ARROW_DRAG, y: a.vel.y * ARROW_DRAG - ARROW_GRAVITY, z: a.vel.z * ARROW_DRAG }
      }
      a.known = e.position.clone()
      a.grounded = grounded
    }
  }

  // Whether nothing blocks the straight line from the eye to a point
  clearTo (eye, point) {
    if (this.arena) return true
    return this.memory.lineOpen(eye, point, viewPlanes(simYaw(this.bot.entity.yaw), simPitch(this.bot.entity.pitch)))
  }

  // Sight lines to the chest, head and feet, and the aim line, as fighter/src/fighter/perception.py runs them
  refreshSight () {
    const e = this.enemy.entity()
    const me = this.bot.entity
    const eye = this.eye()
    const yaw = simYaw(me.yaw)
    const pitch = simPitch(me.pitch)
    if (!this.arena) this.memory.update(eye, yaw, pitch)
    if (!e) {
      this.sight = { ...this.sight, visible: false, chestClear: false, crosshairClear: false }
      return
    }
    const feet = e.position
    if (this.arena) {
      this.sight = { pos: feet.clone(), move: { ...this.enemy.vel }, visible: true, chestClear: true, crosshairClear: true, seen: true }
      return
    }
    const planes = viewPlanes(yaw, pitch)
    const lines = [CHEST, EYE, FEET].map(h => this.memory.lineOpen(eye, feet.offset(0, h, 0), planes))
    const look = lookVector(yaw, pitch)
    const box = this.enemyBox(feet)
    const entry = rayBox(eye, look, box.lo, box.hi)
    const aimPoint = entry != null && entry <= FAR_REACH
      ? { x: eye.x + look.x * entry, y: eye.y + look.y * entry, z: eye.z + look.z * entry }
      : feet.offset(0, CHEST, 0)
    const crosshairClear = this.memory.lineOpen(eye, aimPoint, planes)
    const visible = lines.some(Boolean)
    if (visible || !this.sight.seen) {
      this.sight.pos = feet.clone()
      this.sight.move = { ...this.enemy.vel }
      this.sight.seen = true
    }
    this.sight.visible = visible
    this.sight.chestClear = lines[0]
    this.sight.crosshairClear = crosshairClear
  }

  // The enemy's body for the crosshair inputs: player sized, and lower while it crouches
  enemyBox (feet) {
    const w = PLAYER_W / 2
    const h = this.enemy.crouching() ? SNEAK_HEIGHT : PLAYER_H
    return { lo: { x: feet.x - w, y: feet.y, z: feet.z - w }, hi: { x: feet.x + w, y: feet.y + h, z: feet.z + w } }
  }

  // Free distance, hazard and water along each of the 26 rays from the eye
  rays (eye, yaw) {
    const s = Math.sin(rad(yaw))
    const c = Math.cos(rad(yaw))
    return RAY_DIRS.map(d => {
      const dir = { x: d.f * -s + d.r * -c, y: d.u, z: d.f * c + d.r * -s }
      const hit = this.arena ? { free: this.flatRay(eye, dir), hazard: false, water: -1 } : this.memory.ray(eye, dir, RAY_RANGE)
      return { ...hit, sin: d.sin, cos: d.cos }
    })
  }

  // The known flat arena: the floor plane and the four wall planes
  flatRay (eye, dir) {
    const a = this.arena
    let best = Math.min(RAY_RANGE, (eye.y - a.y) / Math.max(-dir.y, 1e-12))
    for (const [k, mid] of [['x', a.x], ['z', a.z]]) {
      const from = eye[k] - mid
      const room = dir[k] > 0 ? a.half - from : from + a.half
      best = Math.min(best, room / Math.max(Math.abs(dir[k]), 1e-12))
    }
    return Math.max(best, 0)
  }

  // The 130 inputs of fighter/src/fighter/obs.py build_obs, in the same order and scale
  observe () {
    this.refreshSight()
    const bot = this.bot
    const me = bot.entity
    const obs = new Array(OBS_DIM).fill(0)
    const yaw = simYaw(me.yaw)
    const pitch = simPitch(me.pitch)
    const vel = me.velocity
    const [fv, rv] = ego(vel.x, vel.z, yaw)
    const w = this.weapon()
    const charge = this.charge()
    const ready = this.swingReady(charge)
    obs[0] = bot.health / MAX_HEALTH
    obs[1] = clamp(fv * 3, -3, 3)
    obs[2] = clamp(rv * 3, -3, 3)
    obs[3] = clamp(vel.y * 3, -3, 3)
    obs[4] = me.onGround ? 1 : 0
    obs[5] = this.sprintFlag ? 1 : 0
    obs[6] = bot.getControlState('sneak') ? 1 : 0
    obs[7] = Math.sin(rad(pitch))
    obs[8] = me.isInWater ? 1 : 0
    obs[9] = bot.blockAt(this.eye(), false)?.name === 'water' ? 1 : 0
    obs[10] = this.hurtTimer / HURT_TICKS
    obs[11] = Math.min(this.fall / 4, 1)
    obs[12] = w === 'axe' ? 1 : 0
    obs[13] = w === 'sword' ? 1 : 0
    obs[14] = w === 'crossbow' ? 1 : 0
    obs[15] = w === 'bow' ? 1 : 0
    obs[16] = charge
    obs[17] = ready ? 1 : 0
    obs[18] = vel.y < 0 && !me.onGround && ready ? 1 : 0
    obs[19] = this.shieldUp ? 1 : 0
    obs[20] = this.shieldUp && this.shieldTicks + 1 >= SHIELD_RAISE_TICKS ? 1 : 0
    obs[21] = this.shieldCooldown / SHIELD_DISABLE_TICKS
    obs[22] = this.loaded ? 1 : 0
    obs[23] = this.charging ? this.loadTicks / CROSSBOW_LOAD_TICKS : 0
    obs[24] = this.drawing ? Math.min(this.drawTicks / BOW_FULL_DRAW_TICKS, 1) : 0
    obs[25] = Math.min(this.arrows, START_ARROWS) / START_ARROWS

    const s = this.sight
    const target = s.pos ?? me.position
    const eye = this.eye()
    const gap = { x: target.x - eye.x, y: target.y + CHEST - eye.y, z: target.z - eye.z }
    const flat = hyp(gap.x, gap.z)
    const [wantYaw, wantPitch] = viewAngles(gap)
    const yawErr = wrapDeg(yaw - wantYaw)
    const pitchErr = pitch - wantPitch
    obs[26] = Math.sin(rad(yawErr))
    obs[27] = Math.cos(rad(yawErr))
    obs[28] = clamp(pitchErr / 90, -1, 1)
    obs[29] = clamp(yawErr / 10, -1, 1)
    obs[30] = clamp(pitchErr / 10, -1, 1)
    obs[31] = Math.min(flat / 8, 2)
    obs[32] = Math.min(flat / 32, 1.5)
    const half = PLAYER_W / 2
    const near = {
      x: clamp(eye.x, target.x - half, target.x + half),
      y: clamp(eye.y, target.y, target.y + PLAYER_H),
      z: clamp(eye.z, target.z - half, target.z + half)
    }
    obs[33] = Math.min(Math.hypot(near.x - eye.x, near.y - eye.y, near.z - eye.z) / 4, 2)
    obs[34] = clamp((target.y - me.position.y) / 3, -2, 2)

    const e = this.enemy.entity()
    if (e) {
      const look = lookVector(yaw, pitch)
      const box = this.enemyBox(e.position)
      const entry = rayBox(eye, look, box.lo, box.hi)
      const meets = entry != null && s.crosshairClear
      obs[35] = meets && entry <= REACH ? 1 : 0
      obs[36] = meets && entry <= FAR_REACH ? 1 : 0
    }
    obs[37] = s.chestClear ? 1 : 0
    obs[38] = s.visible ? 1 : 0
    const move = s.move ?? { x: 0, y: 0, z: 0 }
    const [ef, er] = ego(move.x, move.z, yaw)
    obs[39] = clamp(ef * 3, -3, 3)
    obs[40] = clamp(er * 3, -3, 3)
    obs[41] = clamp(move.y * 3, -3, 3)
    const live = this.enemy.vel
    obs[42] = this.enemy.history.length >= 2 && Math.abs(live.y) < GROUND_SPEED ? 1 : 0
    obs[43] = this.enemy.sprinting() ? 1 : 0
    obs[44] = hyp(live.x, live.z) < STILL_SPEED ? 1 : 0
    obs[45] = (this.fairHealth ? this.hpEst.value() : Math.max(MAX_HEALTH - this.enemy.damageTaken, 0)) / MAX_HEALTH
    obs[46] = this.enemy.hurtTimer / HURT_TICKS
    obs[47] = this.enemy.charge()
    const ew = this.enemy.weapon()
    obs[48] = ew === 'axe' ? 1 : 0
    obs[49] = ew === 'sword' ? 1 : 0
    obs[50] = ew === 'crossbow' ? 1 : 0
    obs[51] = ew === 'bow' ? 1 : 0
    obs[52] = this.enemy.shieldUp() ? 1 : 0
    obs[53] = this.enemy.shieldActive() ? 1 : 0
    obs[54] = this.enemy.shieldCooldown / SHIELD_DISABLE_TICKS
    if (e) {
      const toMe = { x: me.position.x - target.x, z: me.position.z - target.z }
      const span = Math.max(hyp(toMe.x, toMe.z), 1e-6)
      const theirYaw = simYaw(e.yaw)
      const view = lookVector(theirYaw, 0)
      obs[55] = (view.x * toMe.x + view.z * toMe.z) / span
      obs[56] = wrapDeg(theirYaw - deg(Math.atan2(-toMe.x, toMe.z))) / 180
    }
    const using = this.enemy.useTicks
    obs[57] = using > 0 ? 1 : 0
    obs[58] = Math.min(using, CROSSBOW_LOAD_TICKS) / CROSSBOW_LOAD_TICKS
    obs[59] = this.enemy.crossbowLoaded() ? 1 : 0

    obs[61] = Math.min(this.ticksSinceHit, 40) / 40
    obs[62] = Math.min(this.ticksSinceHurt, 40) / 40
    obs[63] = Math.min(this.ticksSinceDisabled, 40) / 40
    obs[64] = Math.min(this.enemy.ticksSinceSwing, 40) / 40
    obs[65] = Math.min(this.ticksSinceWhiff, 40) / 40
    obs[66] = Math.min(this.combo, 5) / 5
    obs[67] = Math.min(this.ticks / ROUND_SCALE, 1)
    const p = this.prevAction
    obs[68] = FORWARD_VALUES[p[FORWARD]]
    obs[69] = STRAFE_VALUES[p[STRAFE]]
    obs[70] = p[SPRINT]
    obs[71] = p[JUMP]
    obs[72] = YAW_STEPS[p[YAW]] / 90
    obs[73] = p[ATTACK] / 2
    obs[74] = p[USE]

    if (s.seen) this.leadSlots(obs, yaw, pitch)
    this.arrowSlots(obs, yaw)
    this.pickupSlots(obs, yaw)
    this.blockSlots(obs, eye, yaw)
    const off = this.arena ? { x: me.position.x - this.arena.x, z: me.position.z - this.arena.z } : { x: 0, z: 0 }
    obs[128] = clamp((this.borderHalf - Math.max(Math.abs(off.x), Math.abs(off.z))) / BORDER_SCALE, 0, 1)
    obs[129] = e && hyp(e.position.x - me.position.x, e.position.z - me.position.z) <= TRACKING_RANGE ? 1 : 0
    this.lastObs = obs.map(x => (Number.isFinite(x) ? x : 0))
    return this.lastObs
  }

  aimSpeed () {
    const w = this.weapon()
    if (w !== 'bow') return CROSSBOW_SPEED
    const pull = this.drawing && this.drawTicks > 0 ? Math.min(this.drawTicks / BOW_FULL_DRAW_TICKS, 1) : 1
    return BOW_SPEED * Math.max(Math.min((pull * pull + 2 * pull) / 3, 1), AIM_MIN_POWER)
  }

  // The solve for a shot fired now at where the enemy is known to be
  solveShot () {
    const me = this.bot.entity
    const sight = this.sight
    const bow = this.weapon() === 'bow'
    const from = { x: me.position.x, y: me.position.y + this.eyeHeight() - SPAWN_BELOW_EYE, z: me.position.z }
    const carry = { x: bow ? this.lastMove.x : 0, y: bow && !me.onGround ? this.lastMove.y : 0, z: bow ? this.lastMove.z : 0 }
    const vel = sight.visible ? this.enemy.leadVel() : sight.move
    const a = this.arena
    // Over a known floor a body is in the air whenever it is above it, even at the top of a jump where it barely moves
    const inAir = a ? sight.pos.y > a.y + FLOOR_MARGIN : this.enemy.airborne()
    const airborne = inAir && sight.visible
    const speed = this.aimSpeed()
    const ground = airborne ? (a ? a.y : this.groundBelow(sight.pos)) : sight.pos.y
    const solved = intercept(from, sight.pos, vel, airborne, ground, speed, carry, a ?? { x: 0, z: 0 }, a ? a.half - PLAYER_W / 2 : Infinity)
    const loft = -rad(solved.pitch)
    const left = Math.exp(LOG_ARROW_DRAG * solved.flight)
    return { ...solved, speed, loft, left, reach: left > MIN_REACH_FRACTION && loft < MAX_LOFT }
  }

  // The highest solid block top under a point, from what this bot has seen
  groundBelow (pos) {
    const [x, z] = [Math.floor(pos.x), Math.floor(pos.z)]
    const top = Math.floor(pos.y)
    for (let y = top; y >= top - GROUND_SEARCH; y--) {
      if (this.memory.known(x, y, z)?.solid) return y + 1
    }
    return pos.y
  }

  // Slots 75 to 80
  leadSlots (obs, yaw, pitch) {
    const b = this.solveShot()
    const yawErr = wrapDeg(yaw - b.yaw)
    const pitchErr = pitch - b.pitch
    obs[75] = clamp(yawErr / 30, -2, 2)
    obs[76] = clamp(pitchErr / 30, -2, 2)
    obs[77] = clamp(yawErr / 2, -1, 1)
    obs[78] = clamp(pitchErr / 2, -1, 1)
    const across = Math.max(100 * b.speed * Math.cos(b.loft) * (1 - b.left), 0.5)
    const widths = b.reach ? Math.abs(rad(yawErr)) / Math.atan(ARROW_TARGET_MARGIN / across) : NO_REACH_WIDTHS
    obs[79] = Math.min(widths, 5) / 5
    obs[80] = Math.min(b.flight / 20, 2)
  }

  // Slots 81 to 92: the two most urgent arrows flying at us
  arrowSlots (obs, yaw) {
    const me = this.bot.entity
    const center = me.position.offset(0, PLAYER_H / 2, 0)
    const found = []
    for (const [id, a] of this.arrowsSeen) {
      if (a.grounded || this.arrowOwner.get(id) === me.id) continue
      const rel = { x: a.pos.x - center.x, y: a.pos.y - center.y, z: a.pos.z - center.z }
      const v = a.vel
      const speedSq = Math.max(v.x * v.x + v.y * v.y + v.z * v.z, 1e-6)
      const closest = clamp(-(rel.x * v.x + rel.y * v.y + rel.z * v.z) / speedSq, 0, 60)
      const miss = Math.hypot(rel.x + v.x * closest, rel.y + v.y * closest, rel.z + v.z * closest)
      found.push({ rel, closest, miss, urgency: closest + miss })
    }
    found.sort((a, b) => a.urgency - b.urgency)
    found.slice(0, 2).forEach((a, rank) => {
      const base = 81 + rank * 6
      const [f, r] = ego(a.rel.x, a.rel.z, yaw)
      obs[base] = f / 16
      obs[base + 1] = r / 16
      obs[base + 2] = a.rel.y / 4
      obs[base + 3] = Math.min(a.closest / 20, 3)
      obs[base + 4] = Math.min(a.miss / 2, 1)
      obs[base + 5] = a.miss < ON_TARGET_MISS ? 1 : 0
    })
  }

  // Slots 93 to 95: the nearest landed arrow a player could collect
  pickupSlots (obs, yaw) {
    const me = this.bot.entity.position
    let best = null
    for (const [id, a] of this.arrowsSeen) {
      if (!a.grounded || a.groundAge < PICKUP_SEEN_AGE) continue
      const owner = this.bot.entities[this.arrowOwner.get(id)]
      if (owner && owner.type !== 'player') continue
      const d = { x: a.pos.x - me.x, y: a.pos.y - me.y, z: a.pos.z - me.z }
      const across = hyp(d.x, d.z)
      if (across > PICKUP_SEE_RANGE || d.y < -PICKUP_BELOW || d.y > PLAYER_H + PICKUP_ABOVE_HEAD) continue
      if (!best || across < best.across) best = { d, across }
    }
    if (!best) return
    const [f, r] = ego(best.d.x, best.d.z, yaw)
    obs[93] = 1
    obs[94] = f / PICKUP_SEE_RANGE
    obs[95] = r / PICKUP_SEE_RANGE
  }

  // Slots 96 to 127: the 26 rays, then the nearest hazard and water they reached
  blockSlots (obs, eye, yaw) {
    const rays = this.rays(eye, yaw)
    rays.forEach((r, i) => { obs[96 + i] = Math.min(r.free / RAY_RANGE, 1) })
    const nearest = pick => {
      let best = null
      rays.forEach(r => { const d = pick(r); if (d != null && (!best || d < best.d)) best = { d, r } })
      return best
    }
    const hazard = nearest(r => (r.hazard ? r.free : null))
    const water = nearest(r => (r.water >= 0 ? r.water : null))
    obs[122] = hazard ? Math.min(hazard.d / RAY_RANGE, 1) : 1
    obs[123] = hazard ? hazard.r.sin : 0
    obs[124] = hazard ? hazard.r.cos : 1
    obs[125] = water ? Math.min(water.d / RAY_RANGE, 1) : 1
    obs[126] = water ? water.r.sin : 0
    obs[127] = water ? water.r.cos : 1
  }

  heldWeapons () {
    const inv = this.bot.inventory
    const at = slot => weaponOf(inv.slots[inv.hotbarStart + slot])
    return { axe: at(SLOT_OF.axe) === 'axe', sword: at(SLOT_OF.sword) === 'sword', crossbow: at(SLOT_OF.crossbow) === 'crossbow', bow: at(SLOT_OF.bow) === 'bow' }
  }

  // The flat action mask of fighter/src/fighter/obs.py build_masks, 57 values
  masks () {
    const mask = new Array(MASK_SIZE).fill(1)
    const w = this.weapon()
    const melee = w === 'axe' || w === 'sword' || w === 'none'
    const using = (melee && this.shieldUp) || this.drawing || this.charging
    const me = this.bot.entity
    mask[HEAD_OFFSETS[SPRINT] + 1] = using ? 0 : 1
    mask[HEAD_OFFSETS[JUMP] + 1] = me.onGround || me.isInWater ? 1 : 0
    mask[HEAD_OFFSETS[ATTACK] + 1] = melee ? 1 : 0
    mask[HEAD_OFFSETS[ATTACK] + 2] = melee ? 1 : 0
    const canUse = melee ? this.shieldCooldown === 0 : (this.arrows > 0 || (w === 'crossbow' && this.loaded))
    mask[HEAD_OFFSETS[USE] + 1] = canUse && !this.loadWait ? 1 : 0
    const held = this.heldWeapons()
    WEAPON_HEAD.forEach((name, i) => {
      if (i === 0) return
      const ok = held[name] && (!this.allowedWeapons || this.allowedWeapons.has(name))
      mask[HEAD_OFFSETS[WEAPON] + i] = ok ? 1 : 0
    })
    if (this.allowedWeapons && !this.allowedWeapons.has(w) && this.canSwitch(mask)) mask[HEAD_OFFSETS[WEAPON]] = 0
    mask[HEAD_OFFSETS[LOCK_AIM] + 1] = melee ? 0 : 1
    const known = this.sight.pos ?? me.position
    if (hyp(known.x - me.position.x, known.z - me.position.z) < FINE_TURN_RANGE) {
      FINE_YAW.forEach((fine, i) => { if (fine) mask[HEAD_OFFSETS[YAW] + i] = 0 })
      FINE_PITCH.forEach((fine, i) => { if (fine) mask[HEAD_OFFSETS[PITCH] + i] = 0 })
    }
    if (this.planRules) this.applyPlanRules(mask)
    return mask
  }

  swingReady (charge) {
    return charge >= (this.readyGate ?? FULL_CHARGE)
  }

  canSwitch (mask) {
    return WEAPON_HEAD.some((_, i) => i > 0 && mask[HEAD_OFFSETS[WEAPON] + i] === 1)
  }

  // Whether the enemy's body is inside axe range of this bot's eye
  axeInRuleRange () {
    const e = this.enemy.entity()
    if (!e) return false
    const eye = this.eye()
    const half = PLAYER_W / 2
    const p = e.position
    const dx = eye.x - clamp(eye.x, p.x - half, p.x + half)
    const dy = eye.y - clamp(eye.y, p.y, p.y + PLAYER_H)
    const dz = eye.z - clamp(eye.z, p.z - half, p.z + half)
    return Math.hypot(dx, dy, dz) <= AXE_RULE_RANGE
  }

  // The range habits. Past 7 blocks the crossbow is out, from 4.5 blocks it locks on, reloads the moment it is empty and
  // fires the moment the aim is on a target with no shield facing it. A raised shield facing it sends it back to the axe
  // for a moment, and with the axe out it runs at an enemy that is out of reach
  applyRangeRules (mask, at, fix, obs, distance, canCrossbow, canAxe, axe, crossbow) {
    const seen = obs[INPUT_ENEMY_IN_SIGHT] > 0.5
    const guarded = obs[INPUT_ENEMY_SHIELD_UP] > 0.5 && obs[INPUT_ENEMY_FACING] > 0
    if (this.noGunSteps > 0) this.noGunSteps--
    if (this.weapon() === 'axe' && seen && distance >= CHASE_RANGE && obs[INPUT_AIM_COS] > CHASE_FACING) {
      fix(FORWARD, 1)
      fix(SPRINT, 1)
    }
    if (guarded && distance >= GUN_MIN_RANGE) {
      this.openingLoad = false
      this.noGunSteps = GUN_REST_STEPS
      if (this.weapon() !== 'crossbow') mask[at + crossbow] = 0
      else if (canAxe && !this.charging) fix(WEAPON, axe)
      return
    }
    if (seen && canCrossbow && !this.noGunSteps && (this.loaded || this.arrows > 0) && distance >= this.gunForceRange) fix(WEAPON, crossbow)
    if (this.weapon() !== 'crossbow' || !seen || distance < GUN_MIN_RANGE) return
    fix(LOCK_AIM, 1)
    if (!this.loaded) {
      if (this.arrows > 0) fix(USE, 1)
      return
    }
    const aimed = obs[INPUT_AIM_WIDTHS] * 5 < 1 && obs[INPUT_CLEAR_LINE] > 0.5
    const hold = !aimed || obs[INPUT_ENEMY_HURT] > ENEMY_HURT_WINDOW
    fix(USE, !hold && !this.useHeld ? 1 : 0)
  }

  // Load the crossbow first, fire it at clear targets, hold fire at a raised shield that faces this bot and in the
  // enemy's hurt window, put it away inside axe range, and keep the sword for while the enemy's shield is disabled.
  applyPlanRules (mask) {
    const obs = this.lastObs ?? this.observe()
    const at = HEAD_OFFSETS[WEAPON]
    const axe = WEAPON_HEAD.indexOf('axe')
    const sword = WEAPON_HEAD.indexOf('sword')
    const crossbow = WEAPON_HEAD.indexOf('crossbow')
    const fix = (h, choice) => {
      mask.fill(0, HEAD_OFFSETS[h], HEAD_OFFSETS[h] + ACTION_DIMS[h])
      mask[HEAD_OFFSETS[h] + choice] = 1
    }
    const w = this.weapon()
    const holding = w === 'crossbow'
    const canCrossbow = mask[at + crossbow] === 1
    const canAxe = mask[at + axe] === 1
    if (this.loaded || this.arrows <= 0 || !canCrossbow) this.openingLoad = false

    const load = this.charging ? this.loadTicks : 0
    const loading = this.openingLoad || load > 0
    const distance = obs[INPUT_ENEMY_DISTANCE] * 32
    const closing = this.rangeRules && distance < GUN_MIN_RANGE
    const guardedFar = this.rangeRules && distance >= GUN_MIN_RANGE && obs[INPUT_ENEMY_SHIELD_UP] > 0.5 && obs[INPUT_ENEMY_FACING] > 0
    const abort = loading && (this.hurtTimer > 0 || closing || guardedFar) && load / CROSSBOW_LOAD_TICKS < LOAD_ABORT_PROGRESS && canAxe
    const carry = loading && !abort && canCrossbow
    let followUp = false
    if (abort) {
      this.openingLoad = false
      fix(WEAPON, axe)
      fix(USE, 0)
    } else if (carry) {
      fix(WEAPON, crossbow)
      fix(USE, 1)
    } else if (this.loaded) {
      const fresh = !this.useHeld
      const seen = obs[INPUT_ENEMY_IN_SIGHT] > 0.5
      const shield = obs[INPUT_ENEMY_SHIELD_UP] > 0.5
      followUp = obs[INPUT_ENEMY_SHIELD_DISABLED] >= JUST_DISABLED
      if (followUp) {
        fix(WEAPON, crossbow)
        fix(USE, holding && fresh ? 1 : 0)
        if (holding && seen) fix(LOCK_AIM, 1)
      } else {
        const facing = shield && obs[INPUT_ENEMY_FACING] > 0
        if (holding && fresh && (facing || obs[INPUT_ENEMY_HURT] > ENEMY_HURT_WINDOW)) fix(USE, 0)
        if (obs[INPUT_ENEMY_DISTANCE] * 32 >= FAR_SHOT_RANGE && seen && !shield) {
          fix(WEAPON, crossbow)
          if (holding) fix(LOCK_AIM, 1)
        }
      }
    }
    if (this.rangeRules && !abort && !followUp) this.applyRangeRules(mask, at, fix, obs, distance, canCrossbow, canAxe, axe, crossbow)
    if (!abort && !carry && !followUp && canAxe && (closing || this.axeInRuleRange())) {
      mask[at + crossbow] = 0
      if (holding) mask[at] = 0
    }
    if (!(this.enemy.shieldCooldown > 0)) {
      mask[at + sword] = 0
      if (w === 'sword' && this.canSwitch(mask)) mask[at] = 0
    }
  }

  act (a) {
    const bot = this.bot
    const [fb, lr, sprint, jump, yawI, pitchI, attack, use, slot, sneak, lock] = a
    bot.setControlState('forward', fb === 1)
    bot.setControlState('back', fb === 2)
    bot.setControlState('left', lr === 1)
    bot.setControlState('right', lr === 2)
    // The server's sprint flag starts with a new press and ends at a sprint hit, while a held key keeps the body running
    const using = this.shieldUp || this.charging || this.drawing
    const sprintKey = sprint === 1 && fb === 1 && sneak !== 1 && (!!this.sprintHeld || !using)
    this.sprintFlag = (!!this.sprintFlag || (sprintKey && !this.sprintHeld)) && sprintKey
    this.sprintHeld = sprintKey
    bot.setControlState('sprint', sprintKey)
    bot.setControlState('jump', jump === 1)
    bot.setControlState('sneak', sneak === 1)

    let yaw = bot.entity.yaw + rad(YAW_STEPS[yawI])
    let pitch = clamp(bot.entity.pitch + rad(PITCH_STEPS[pitchI]), -Math.PI / 2, Math.PI / 2)
    const w = this.weapon()
    if (lock === 1 && (w === 'crossbow' || w === 'bow') && this.sight?.seen) {
      // Lock aim: straight to where an arrow fired now would meet the enemy. A bow drawn too little to reach
      // turns only sideways and keeps the chosen pitch.
      const aim = this.solveShot()
      yaw = Math.PI - rad(aim.yaw)
      if (aim.reach) pitch = clamp(-rad(aim.pitch), -Math.PI / 2, Math.PI / 2)
    }
    bot.look(yaw, pitch, true)

    const wanted = WEAPON_HEAD[slot]
    if (wanted !== 'keep' && bot.quickBarSlot !== SLOT_OF[wanted]) this.selectSlot(SLOT_OF[wanted])

    // Swing first, which only works with the shield down, then handle the use button
    if (attack > 0 && !this.shieldUp && !this.charging && !this.drawing) {
      this.swing()
      if (attack === 2) this.secondClick = true
    }
    const held = this.weapon()
    if (held === 'crossbow') this.useCrossbow(use === 1)
    else if (held === 'bow') this.useBow(use === 1)
    else if (use === 1 && !this.shieldUp && this.shieldCooldown <= 0) {
      bot.activateItem(true)
      this.shieldUp = true
    } else if (use === 0 && this.shieldUp) {
      bot.deactivateItem()
      this.shieldUp = false
    }
    if (use === 0) { this.loadWait = false; this.shotWait = false }
    this.useHeld = use === 1
    this.prevAction = a
  }

  selectSlot (slot) {
    // The shield is in the off hand, so the server keeps it raised through a slot change until use is let go
    if (this.shieldUp) this.bot.deactivateItem()
    this.bot.setQuickBarSlot(slot)
    // Switching away cancels a crossbow charge or a bow draw and restarts the swing charge, as in vanilla
    if (this.charging || this.holdingLoad || this.drawing) this.bot.usingHeldItem = false
    this.charging = false
    this.holdingLoad = false
    this.drawing = false
    this.loadTicks = 0
    this.drawTicks = 0
    this.shieldUp = false
    this.shieldTicks = 0
    this.loadWait = false
    this.shotWait = false
    this.ticksSinceSwing = 0
  }

  // The crossbow loads once the charge is full while use is held. The server's loaded crossbow shows a tick
  // or two after ours, so the load is taken once it does.
  confirmLoad () {
    if (this.loaded || this.awaitLoad <= 0) return
    const srv = this.serverRanged()
    if (!srv.loaded) return
    this.loaded = true
    this.arrows = srv.arrows
    this.awaitLoad = 0
    // The crossbow stays in use after it loads, until the key is let go
    this.holdingLoad = this.charging
    this.charging = false
    this.loadTicks = 0
    if (this.useHeld) this.loadWait = true
  }

  serverRanged () {
    const inv = this.bot.inventory
    const arrows = inv.items().filter(i => i.name === 'arrow').reduce((n, i) => n + i.count, 0)
    const cb = inv.slots[inv.hotbarStart + SLOT_OF.crossbow]
    const charged = (cb?.components ?? []).find(c => c.type === 'charged_projectiles')
    const loaded = (charged?.data?.projectiles ?? charged?.data ?? []).length > 0
    return { arrows, loaded }
  }

  // Local ranged state predicts the server's. When the two still disagree after DESYNC_TICKS the server wins.
  syncWithServer () {
    if (this.charging || this.drawing) { this.desyncTicks = 0; return }
    const srv = this.serverRanged()
    if (srv.arrows === this.arrows && srv.loaded === this.loaded) { this.desyncTicks = 0; return }
    if (++this.desyncTicks < DESYNC_TICKS) return
    this.arrows = srv.arrows
    this.loaded = srv.loaded
    this.desyncTicks = 0
  }

  useCrossbow (pressed) {
    const bot = this.bot
    if (!pressed && this.holdingLoad) {
      // Without this release the server keeps using the crossbow, and its next shot would reload at once
      bot.deactivateItem()
      this.holdingLoad = false
    }
    if (pressed && !this.useHeld) {
      this.confirmLoad()
      if (this.loaded) {
        bot.activateItem()
        // A shot is over at once, so Mineflayer's own use flag must not stay on
        bot.usingHeldItem = false
        this.loaded = false
        this.loadWait = true
        this.shotWait = true
        this.reloadDelay = CROSSBOW_RELOAD_DELAY
        this.lastShot = { speed: CROSSBOW_SPEED, full: true }
        this.events.shots++
        return
      }
    }
    if (this.shotWait && this.reloadDelay === 0) {
      this.loadWait = false
      this.shotWait = false
    }
    if (pressed && !this.charging && !this.loaded && !this.loadWait && this.reloadDelay === 0 && this.arrows > 0) {
      bot.activateItem()
      this.charging = true
      this.loadTicks = 0
    } else if (!pressed && this.charging) {
      bot.deactivateItem()
      this.charging = false
      this.loadTicks = 0
    }
  }

  useBow (pressed) {
    const bot = this.bot
    if (pressed && !this.drawing && this.arrows > 0) {
      bot.activateItem()
      this.drawing = true
      this.drawTicks = 0
    } else if (!pressed && this.drawing && this.drawTicks < BOW_MIN_DRAW_TICKS + 1) {
      // A very short draw: letting go may or may not shoot depending on packet timing, so it is cancelled by
      // switching away and back, which stops the use without a shot
      bot.setQuickBarSlot(SLOT_OF.axe)
      bot.setQuickBarSlot(SLOT_OF.bow)
      bot.usingHeldItem = false
      this.drawing = false
    } else if (!pressed && this.drawing) {
      // The server shoots along the last rotation it received, so this step's turn goes out before the release
      bot._client.write('look', {
        yaw: toNotchianYaw(bot.entity.yaw),
        pitch: toNotchianPitch(bot.entity.pitch),
        onGround: bot.entity.onGround,
        flags: { onGround: bot.entity.onGround, hasHorizontalCollision: undefined }
      })
      bot.deactivateItem()
      const pull = Math.min(this.drawTicks / BOW_FULL_DRAW_TICKS, 1)
      this.lastShot = { speed: BOW_SPEED * Math.max(Math.min((pull * pull + 2 * pull) / 3, 1), AIM_MIN_POWER), full: pull >= 1 }
      this.drawing = false
      this.arrows--
      this.events.shots++
    }
  }

  // A swing at the crosshair: a hit only when the view ray meets the enemy within reach with nothing between
  swing () {
    const bot = this.bot
    const e = this.enemy.entity()
    this.events.swings++
    if (e && this.crosshairOnEnemy()) {
      const charged = this.charge() > CHARGED_HIT
      const running = charged && (this.sprintFlag || this.sprintHeld)
      const blocked = this.enemyBlocks(e)
      if (this.fairHealth) {
        const crit = this.charge() > 0.9 && this.fall > 0 && !bot.entity.onGround && !this.sprintFlag
        this.pendingMelee = { amount: meleeDamage(this.weapon(), this.charge(), crit), ticks: 6 }
      }
      bot.attack(e)
      this.events.attacks++
      this.ticksSinceAttack = 0
      // The server ends its sprint flag at a sprint hit, and a running client slows on every charged hit that lands
      if (!blocked) {
        if (charged) this.sprintFlag = false
        if (running) {
          bot.entity.velocity.x *= ATTACKER_SLOWDOWN
          bot.entity.velocity.z *= ATTACKER_SLOWDOWN
        }
      }
    } else {
      bot.swingArm()
    }
    this.ticksSinceSwing = 0
  }

  // Whether the enemy's raised shield faces this bot
  enemyBlocks (e) {
    if (!this.enemy.shieldActive()) return false
    const view = lookVector(simYaw(e.yaw), 0)
    const me = this.bot.entity.position
    return view.x * (me.x - e.position.x) + view.z * (me.z - e.position.z) > 0
  }

  crosshairOnEnemy (reach = REACH) {
    const e = this.enemy.entity()
    if (!e) return false
    const me = this.bot.entity
    const eye = this.eye()
    const look = lookVector(simYaw(me.yaw), simPitch(me.pitch))
    const w = (e.width ?? PLAYER_W) / 2
    const h = e.height ?? PLAYER_H
    const p = e.position
    const t = rayBox(eye, look, { x: p.x - w, y: p.y, z: p.z - w }, { x: p.x + w, y: p.y + h, z: p.z + w })
    if (t === null || t > reach) return false
    return this.clearTo(eye, { x: eye.x + look.x * t, y: eye.y + look.y * t, z: eye.z + look.z * t })
  }

  takeEvents () {
    const ev = this.events
    this.events = freshEvents()
    return ev
  }

  stopEverything () {
    this.bot.clearControlStates()
    this.sprintHeld = false
    this.sprintFlag = false
    if (this.charging || this.holdingLoad || this.drawing) this.selectSlot(SLOT_OF.axe)
    if (this.shieldUp) this.bot.deactivateItem()
    this.shieldUp = false
    this.secondClick = false
  }

  reset (stop = true) {
    if (stop) this.stopEverything()
    this.ticks = 0
    this.lastObs = null
    this.openingLoad = true
    this.noGunSteps = 0
    this.shieldUp = false
    this.secondClick = false
    this.ticksSinceSwing = 1000
    this.shieldTicks = 0
    this.shieldCooldown = 0
    this.ticksSinceHit = NEVER
    this.ticksSinceHurt = NEVER
    this.ticksSinceDisabled = NEVER
    this.ticksSinceWhiff = NEVER
    this.ticksSinceMyBlock = NEVER
    this.ticksSinceAttack = NEVER
    this.hurtTimer = 0
    this.lastMove = { x: 0, y: 0, z: 0 }
    this.lastPos = null
    this.whiffCheck = 0
    this.fall = 0
    this.lastY = null
    this.charging = false
    this.holdingLoad = false
    this.loadTicks = 0
    this.drawing = false
    this.drawTicks = 0
    this.loaded = false
    this.loadWait = false
    this.shotWait = false
    this.reloadDelay = 0
    this.sprintHeld = false
    this.sprintFlag = false
    this.arrows = START_ARROWS
    this.useHeld = false
    this.desyncTicks = 0
    this.awaitLoad = 0
    this.combo = 0
    this.freshCombo = true
    this.prevAction = IDLE_ACTION
    this.sight = { pos: null, move: null, visible: false, chestClear: false, crosshairClear: false, seen: false }
    this.memory.clear()
    this.myShots = new Map()
    this.lastShot = null
    this.arrowsSeen.clear()
    this.arrowOwner.clear()
    this.pendingMelee = null
    this.enemyEating = 0
    this.hpEst.reset()
    this.events = freshEvents()
    this.lastHealth = this.bot.health ?? null
    if (stop) this.enemy.reset()
  }
}

function freshEvents () {
  return { swings: 0, attacks: 0, blocked: 0, meleeDamaged: 0, shots: 0, shotsSeen: 0, arrowHits: 0, damageTaken: 0, myShieldBroken: 0 }
}

module.exports = {
  Fighter,
  EnemyView,
  OBS_DIM,
  MASK_SIZE,
  ACTION_DIMS,
  HEAD_OFFSETS,
  IDLE_ACTION,
  YAW_STEPS,
  PITCH_STEPS,
  SLOT_OF,
  SLOT_AXE,
  SLOT_SWORD,
  SLOT_CROSSBOW,
  SLOT_BOW,
  SeenBlocks,
  simYaw,
  simPitch,
  viewAngles,
  wrapDeg,
  weaponOf
}
