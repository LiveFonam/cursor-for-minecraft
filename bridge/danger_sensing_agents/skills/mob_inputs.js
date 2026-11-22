// The inputs of the mob network: the shared 130 in their mob version plus 52 mob inputs, 182 in all, and the 57 value
// action mask, computed the way the simulator computes them (fighter/obs.py build_obs, fighter/mob_drill.py
// mob_features and MobInterface.masks). No Mineflayer in here, so tools/mob_parity.js can check every slot against
// situations recorded from the simulator.
//
// The mob version of the shared inputs differs from the player fighter's on purpose. The simulator shows the nearest
// mob in the enemy seat but leaves that seat's walking record empty, so the enemy motion inputs (39 to 41, 44) read
// still, and its swing inputs (47, 64, 65) read as never. The enemy health input (45) is 20 minus all the damage
// dealt this fight, to any mob.
//
//   buildMobInputs(state)   the 182 inputs
//   buildMobMask(state)     the 57 mask values
//   MobTracker              turns what a client sees each tick into that state
//
// A state holds { ticks, arena, me, memory, mobs, arrows }. arena is { x, z, half } in the simulator and null on a
// real server, where state.rays holds the 26 free distances from real blocks.

const { HEAD_OFFSETS, YAW_STEPS, IDLE_ACTION } = require('../../fighter')

const SHARED = 130
const NEAREST = 3
const PER_MOB = 17
const MOB_INPUTS = PER_MOB * NEAREST + 1
const INPUTS = SHARED + MOB_INPUTS
const MASK = 57
const MAX_MOBS = 4

const ZOMBIE = 0
const SKELETON = 1
const CREEPER = 2
const ENDERMAN = 3
const HEALTH = [20, 20, 20, 40]
const HEIGHT = [1.95, 1.99, 1.7, 2.9]
const MOB_EYE = [1.74, 1.74, 1.445, 2.55]
const MOB_WIDTH = 0.6
const FUSE = 30
const STARE_TOLERANCE = 0.025
// The real mobs the network fought, and the variants that move and hit the same way
const KIND_OF = { zombie: ZOMBIE, husk: ZOMBIE, zombie_villager: ZOMBIE, skeleton: SKELETON, stray: SKELETON, bogged: SKELETON, parched: SKELETON, creeper: CREEPER, enderman: ENDERMAN }

const MAX_HEALTH = 20
const EYE = 1.62
const SNEAK_EYE = 1.27
const PLAYER_W = 0.6
const PLAYER_H = 1.8
const CHEST = 1.2
const REACH = 3
const FAR_REACH = 64
const HURT_TICKS = 10
const FULL_CHARGE = 0.848
const CHARGE_GATE = 0.9
const SHIELD_RAISE = 6
const SHIELD_DISABLE = 100
const LOAD_TICKS = 25
const ROUND_SCALE = 1200
const NEVER = 100
const FINE_TURN_RANGE = 9
const FORWARD_VALUES = [0, 1, -1]
const STRAFE_VALUES = [0, -1, 1]
const FORWARD = 0
const STRAFE = 1
const SPRINT = 2
const JUMP = 3
const YAW = 4
const PITCH = 5
const ATTACK = 6
const USE = 7
const WEAPON = 8
const LOCK_AIM = 10
const FINE_YAW = YAW_STEPS.map(v => v !== 0 && Math.abs(v) < 1)
const PITCH_VALUES = [-40, -20, -8, -3, -1, 0, 1, 3, 8, 20, 40, -0.5, 0.5, -0.25, 0.25]
const FINE_PITCH = PITCH_VALUES.map(v => v !== 0 && Math.abs(v) < 1)

const CROSSBOW_SPEED = 3.15
const ARROW_DRAG = 0.99
const LOG_ARROW = Math.log(ARROW_DRAG)
const VERTICAL_DRAG = 0.98
const LOG_BODY = Math.log(VERTICAL_DRAG)
const TERMINAL = 0.08 * VERTICAL_DRAG / (1 - VERTICAL_DRAG)
const SPAWN_BELOW_EYE = 0.1
const AIM_HEIGHT = 1.2
const TARGET_MARGIN = 0.6
const MAX_LOFT = 1.4
const MIN_REACH = 0.05
const NO_REACH = 99
const ON_TARGET = 1.3
const RAY_RANGE = 8
const BORDER_HALF = 12     // on a real server the border input stays where the middle of an arena puts it
const ARENA_SIZE = 24      // the mob position inputs are scaled by the training arena's width
const GROUND_DRAG = 0.91 * 0.6
const AIR_DRAG = 0.91
const TELEPORT_STEP = 2    // blocks in one tick that no walk or knockback covers

// The 26 rays as (forward, right, up), in slot order
const RAYS = (() => {
  const out = []
  for (const p of [55, 20, 0]) {
    const pitch = p * Math.PI / 180
    for (let k = 0; k < 8; k++) {
      const a = 2 * Math.PI * k / 8
      out.push([Math.cos(a) * Math.cos(pitch), Math.sin(a) * Math.cos(pitch), -Math.sin(pitch)])
    }
  }
  out.push([0, 0, 1], [0, 0, -1])
  return out
})()

const rad = d => d * Math.PI / 180
const deg = r => r * 180 / Math.PI
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
const wrap = a => (((a + 180) % 360) + 360) % 360 - 180
const ego = (x, z, s, c) => [x * -s + z * c, x * -c + z * -s]
const look = (yaw, pitch) => {
  const [y, p] = [rad(yaw), rad(pitch)]
  return [-Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)]
}
const eyeOf = me => [me.pos[0], me.pos[1] + (me.sneaking ? SNEAK_EYE : EYE), me.pos[2]]
const liveMobs = s => s.mobs.filter(m => m.alive !== false)

// The entry distance of a ray into a box, or null when it misses
function rayBox (o, d, lo, hi) {
  let near = -Infinity
  let far = Infinity
  for (let i = 0; i < 3; i++) {
    const step = Math.abs(d[i]) < 1e-9 ? 1e-9 : d[i]
    const a = (lo[i] - o[i]) / step
    const b = (hi[i] - o[i]) / step
    near = Math.max(near, Math.min(a, b))
    far = Math.min(far, Math.max(a, b))
  }
  const entry = Math.max(near, 0)
  return far >= entry ? entry : null
}

// The nearest living mob by its true position, the one the simulator puts in the enemy seat
function focusOf (s) {
  let best = null
  let bestD = Infinity
  for (const m of liveMobs(s)) {
    const d = (m.pos[0] - s.me.pos[0]) ** 2 + (m.pos[1] - s.me.pos[1]) ** 2 + (m.pos[2] - s.me.pos[2]) ** 2
    if (d < bestD) { best = m; bestD = d }
  }
  return best
}

// The first mob under the crosshair within reach, or null. state.blockedBefore(eye, dir, t) says a block is in the way
function mobUnderCrosshair (s, reach = REACH) {
  const eye = eyeOf(s.me)
  const dir = look(s.me.yaw, s.me.pitch)
  let best = null
  let bestT = Infinity
  for (const m of liveMobs(s)) {
    const half = MOB_WIDTH / 2
    const lo = [m.pos[0] - half, m.pos[1], m.pos[2] - half]
    const hi = [m.pos[0] + half, m.pos[1] + HEIGHT[m.kind], m.pos[2] + half]
    const t = rayBox(eye, dir, lo, hi)
    if (t !== null && t <= reach && t < bestT) { best = m; bestT = t }
  }
  if (best && s.blockedBefore?.(eye, dir, bestT)) return null
  return best
}

// Slots 75 to 80: the shot solve of arrows.py intercept for an axe holder, which reads the crossbow's speed. The enemy
// seat's sideways motion is empty, so only a falling mob moves the aim point
function leadSlots (obs, s, focus, yaw, pitch) {
  const me = s.me
  const fromX = me.pos[0]
  const fromY = me.pos[1] + (me.sneaking ? SNEAK_EYE : EYE) - SPAWN_BELOW_EYE
  const fromZ = me.pos[2]
  const [toX, toY, toZ] = focus.pos
  const airborne = !focus.onGround
  const ground = s.arena ? 0 : (focus.groundY ?? toY)
  const limit = s.arena ? s.arena.half - PLAYER_W / 2 : Infinity
  const rate = 1 / CROSSBOW_SPEED
  const first = Math.hypot(toX - fromX, toZ - fromZ) * rate * (1 - ARROW_DRAG)
  let flight = Math.max(Math.log1p(-Math.min(first, 0.98)) / LOG_ARROW, 0.5)
  let [needX, needY, needZ] = [0, 0, 0]
  for (let i = 0; i < 4; i++) {
    const aimX = clamp(toX, -limit, limit)
    const aimZ = clamp(toZ, -limit, limit)
    let aimY = toY
    if (airborne) {
      const fall = (focus.vel[1] + TERMINAL) * -Math.expm1(LOG_BODY * flight) / (1 - VERTICAL_DRAG) - TERMINAL * flight
      aimY = Math.max(toY + fall, ground)
    }
    const reach = -100 * Math.expm1(LOG_ARROW * flight)
    needX = (aimX - fromX) / reach
    needY = (aimY + AIM_HEIGHT - fromY + 5 * flight) / reach - 5
    needZ = (aimZ - fromZ) / reach
    const size = Math.sqrt(needX * needX + needY * needY + needZ * needZ)
    const scaled = Math.min(Math.max(reach * size * rate * 0.01, 1e-4), 0.98)
    flight = Math.max(Math.log1p(-scaled) / LOG_ARROW, 0.5)
  }
  const leadYaw = deg(Math.atan2(-needX, needZ))
  const leadPitch = -deg(Math.atan2(needY, Math.hypot(needX, needZ)))
  const yawErr = wrap(yaw - leadYaw)
  const pitchErr = pitch - leadPitch
  obs[75] = clamp(yawErr / 30, -2, 2)
  obs[76] = clamp(pitchErr / 30, -2, 2)
  obs[77] = clamp(yawErr / 2, -1, 1)
  obs[78] = clamp(pitchErr / 2, -1, 1)
  const loft = -rad(leadPitch)
  const left = Math.exp(LOG_ARROW * flight)
  const reaches = left > MIN_REACH && loft < MAX_LOFT
  const across = Math.max(100 * CROSSBOW_SPEED * Math.cos(loft) * (1 - left), 0.5)
  const widths = reaches ? Math.abs(rad(yawErr)) / Math.atan(TARGET_MARGIN / across) : NO_REACH
  obs[79] = Math.min(widths, 5) / 5
  obs[80] = Math.min(flight / 20, 2)
}

// Slots 81 to 92: the two most urgent arrows flying at it
function arrowSlots (obs, s, sinY, cosY) {
  const c = [s.me.pos[0], s.me.pos[1] + PLAYER_H / 2, s.me.pos[2]]
  const found = (s.arrows || []).map(a => {
    const rel = [a.pos[0] - c[0], a.pos[1] - c[1], a.pos[2] - c[2]]
    const v = a.vel
    const speedSq = Math.max(v[0] * v[0] + v[1] * v[1] + v[2] * v[2], 1e-6)
    const closest = clamp(-(rel[0] * v[0] + rel[1] * v[1] + rel[2] * v[2]) / speedSq, 0, 60)
    const miss = Math.hypot(rel[0] + v[0] * closest, rel[1] + v[1] * closest, rel[2] + v[2] * closest)
    return { rel, closest, miss, urgency: closest + miss }
  }).sort((a, b) => a.urgency - b.urgency)
  found.slice(0, 2).forEach((a, rank) => {
    const base = 81 + rank * 6
    const [f, r] = ego(a.rel[0], a.rel[2], sinY, cosY)
    obs[base] = f / 16
    obs[base + 1] = r / 16
    obs[base + 2] = a.rel[1] / 4
    obs[base + 3] = Math.min(a.closest / 20, 3)
    obs[base + 4] = Math.min(a.miss / 2, 1)
    obs[base + 5] = a.miss < ON_TARGET ? 1 : 0
  })
}

// Slots 96 to 121. In the simulator: the free distance in the walled flat arena. On a server: the distances it was given
function raySlots (obs, s, eye, sinY, cosY) {
  if (!s.arena) {
    for (let i = 0; i < RAYS.length; i++) obs[96 + i] = Math.min((s.rays?.[i] ?? RAY_RANGE) / RAY_RANGE, 1)
    return
  }
  const { x, z, half } = s.arena
  const origin = [eye[0] - x, eye[1], eye[2] - z]
  RAYS.forEach(([f, r, u], i) => {
    const dir = [f * -sinY + r * -cosY, u, f * cosY + r * -sinY]
    let best = Math.min(RAY_RANGE, origin[1] / Math.max(-dir[1], 1e-12))
    for (const axis of [0, 2]) {
      const room = dir[axis] > 0 ? half - origin[axis] : origin[axis] + half
      best = Math.min(best, room / Math.max(Math.abs(dir[axis]), 1e-12))
    }
    obs[96 + i] = Math.max(best, 0) / RAY_RANGE
  })
}

// The 52 mob inputs of mob_features: the three nearest by where they were last seen, then the share still alive
function mobSlots (obs, s, sinY, cosY) {
  const at = SHARED
  const me = s.me
  const live = liveMobs(s)
  obs[at + MOB_INPUTS - 1] = Math.min(live.length, MAX_MOBS) / MAX_MOBS
  const scale = s.arena ? 2 * s.arena.half : ARENA_SIZE
  const eye = eyeOf(me)
  const view = look(me.yaw, me.pitch)
  const ranked = live.map(m => {
    const seen = m.inSight === false
    const shown = seen ? m.seenPos : m.pos
    const moving = seen ? m.seenVel : m.vel
    const gap = [shown[0] - me.pos[0], shown[1] - me.pos[1], shown[2] - me.pos[2]]
    return { m, gap, moving, d: gap[0] ** 2 + gap[1] ** 2 + gap[2] ** 2 }
  }).sort((a, b) => a.d - b.d)
  ranked.slice(0, NEAREST).forEach(({ m, gap, moving }, rank) => {
    const base = at + rank * PER_MOB
    const [f, r] = ego(gap[0], gap[2], sinY, cosY)
    const [fv, rv] = ego(moving[0], moving[2], sinY, cosY)
    const toEye = [m.pos[0] - eye[0], m.pos[1] + MOB_EYE[m.kind] - eye[1], m.pos[2] - eye[2]]
    const len = Math.max(Math.hypot(...toEye), 1e-6)
    const dot = (toEye[0] * view[0] + toEye[1] * view[1] + toEye[2] * view[2]) / len
    obs[base] = 1
    obs[base + 1 + m.kind] = 1
    obs[base + 5] = f / scale
    obs[base + 6] = r / scale
    obs[base + 7] = gap[1] / 4
    obs[base + 8] = Math.min(Math.hypot(gap[0], gap[2]) / 8, 2)
    obs[base + 9] = fv * 2
    obs[base + 10] = rv * 2
    obs[base + 11] = m.hp / (m.maxHp ?? HEALTH[m.kind])
    obs[base + 12] = m.swell / FUSE
    obs[base + 13] = m.kind === CREEPER && m.swellDir > 0 ? 1 : 0
    obs[base + 14] = m.provoked ? 1 : 0
    obs[base + 15] = m.draw > 0 ? 1 : 0
    obs[base + 16] = dot > 1 - STARE_TOLERANCE / len && m.inSight !== false ? 1 : 0
  })
}

function buildMobInputs (s) {
  const obs = new Array(INPUTS).fill(0)
  const { me, memory: mem } = s
  const focus = focusOf(s)
  const yaw = me.yaw
  const pitch = me.pitch
  const sinY = Math.sin(rad(yaw))
  const cosY = Math.cos(rad(yaw))
  const [fv, rv] = ego(me.vel[0], me.vel[2], sinY, cosY)
  const ready = me.charge >= FULL_CHARGE
  obs[0] = me.hp / MAX_HEALTH
  obs[1] = clamp(fv * 3, -3, 3)
  obs[2] = clamp(rv * 3, -3, 3)
  obs[3] = clamp(me.vel[1] * 3, -3, 3)
  obs[4] = me.onGround ? 1 : 0
  obs[5] = me.sprinting ? 1 : 0
  obs[6] = me.sneaking ? 1 : 0
  obs[7] = Math.sin(rad(pitch))
  obs[8] = me.inWater ? 1 : 0
  obs[9] = me.eyesInWater ? 1 : 0
  obs[10] = me.hurtTimer / HURT_TICKS
  obs[11] = Math.min(me.fall / 4, 1)
  obs[12] = 1   // the network only ever held an axe
  obs[16] = me.charge
  obs[17] = ready ? 1 : 0
  obs[18] = me.vel[1] < 0 && !me.onGround && ready ? 1 : 0
  obs[19] = me.shieldTicks > 0 ? 1 : 0
  obs[20] = me.shieldTicks >= SHIELD_RAISE ? 1 : 0
  obs[21] = me.shieldDisabled / SHIELD_DISABLE
  obs[25] = 1   // a full quiver it never used

  const eye = eyeOf(me)
  if (focus) {
    const t = focus.pos
    const gap = [t[0] - eye[0], t[1] + CHEST - eye[1], t[2] - eye[2]]
    const flat = Math.hypot(gap[0], gap[2])
    const wantYaw = deg(Math.atan2(-gap[0], gap[2]))
    const wantPitch = -deg(Math.atan2(gap[1], flat))
    const yawErr = wrap(yaw - wantYaw)
    const pitchErr = pitch - wantPitch
    obs[26] = Math.sin(rad(yawErr))
    obs[27] = Math.cos(rad(yawErr))
    obs[28] = clamp(pitchErr / 90, -1, 1)
    obs[29] = clamp(yawErr / 10, -1, 1)
    obs[30] = clamp(pitchErr / 10, -1, 1)
    obs[31] = Math.min(flat / 8, 2)
    obs[32] = Math.min(flat / 32, 1.5)
    const half = PLAYER_W / 2
    const lo = [t[0] - half, t[1], t[2] - half]
    const hi = [t[0] + half, t[1] + PLAYER_H, t[2] + half]
    const near = [clamp(eye[0], lo[0], hi[0]), clamp(eye[1], lo[1], hi[1]), clamp(eye[2], lo[2], hi[2])]
    obs[33] = Math.min(Math.hypot(near[0] - eye[0], near[1] - eye[1], near[2] - eye[2]) / 4, 2)
    obs[34] = clamp((t[1] - me.pos[1]) / 3, -2, 2)
    const entry = rayBox(eye, look(yaw, pitch), lo, hi)
    obs[35] = entry !== null && entry <= REACH ? 1 : 0
    obs[36] = entry !== null && entry <= FAR_REACH ? 1 : 0
  }
  obs[37] = 1   // always clear in the flat arena the network trained in
  obs[38] = 1
  obs[42] = 1   // the enemy seat's walking record is empty, so it reads as standing still
  obs[44] = 1
  obs[45] = mem.enemyHealth / MAX_HEALTH
  if (focus) {
    obs[46] = focus.hurtTimer / HURT_TICKS
    const skeleton = focus.kind === SKELETON
    obs[49] = skeleton ? 0 : 1
    obs[51] = skeleton ? 1 : 0
    const toMe = [me.pos[0] - focus.pos[0], me.pos[2] - focus.pos[2]]
    const span = Math.max(Math.hypot(toMe[0], toMe[1]), 1e-6)
    const their = look(focus.yaw, 0)
    obs[55] = (their[0] * toMe[0] + their[2] * toMe[1]) / span
    obs[56] = wrap(focus.yaw - deg(Math.atan2(-toMe[0], toMe[1]))) / 180
    const draw = skeleton ? focus.draw : 0
    obs[57] = draw > 0 ? 1 : 0
    obs[58] = Math.min(draw, LOAD_TICKS) / LOAD_TICKS
  }
  obs[47] = 1
  obs[61] = Math.min(mem.sinceHit, 40) / 40
  obs[62] = Math.min(mem.sinceHurt, 40) / 40
  obs[63] = Math.min(mem.sinceDisabled ?? NEVER, 40) / 40
  obs[64] = Math.min(mem.sinceSwing ?? NEVER, 40) / 40
  obs[65] = Math.min(mem.sinceWhiff ?? NEVER, 40) / 40
  obs[66] = Math.min(mem.combo, 5) / 5
  obs[67] = Math.min(s.ticks / ROUND_SCALE, 1)
  const last = mem.lastAction
  obs[68] = FORWARD_VALUES[last[FORWARD]]
  obs[69] = STRAFE_VALUES[last[STRAFE]]
  obs[70] = last[SPRINT]
  obs[71] = last[JUMP]
  obs[72] = YAW_STEPS[last[YAW]] / 90
  obs[73] = last[ATTACK] / 2
  obs[74] = me.useHeld ? 1 : 0

  if (focus) leadSlots(obs, s, focus, yaw, pitch)
  arrowSlots(obs, s, sinY, cosY)
  raySlots(obs, s, eye, sinY, cosY)
  obs[122] = 1   // no lava, fire or water in the arena, so these never moved in training
  obs[124] = 1
  obs[125] = 1
  obs[127] = 1
  if (s.arena) {
    const off = Math.max(Math.abs(me.pos[0] - s.arena.x), Math.abs(me.pos[2] - s.arena.z))
    obs[128] = clamp((s.arena.half - off) / 16, 0, 1)
  } else {
    obs[128] = BORDER_HALF / 16
  }
  obs[129] = 1
  mobSlots(obs, s, sinY, cosY)
  return obs.map(v => (Number.isFinite(v) ? clamp(v, -5, 5) : 0))
}

function buildMobMask (s) {
  const mask = new Array(MASK).fill(1)
  const me = s.me
  const off = HEAD_OFFSETS
  mask[off[SPRINT] + 1] = me.shieldTicks > 0 ? 0 : 1
  mask[off[JUMP] + 1] = me.onGround || me.inWater ? 1 : 0
  const aimed = mobUnderCrosshair(s) ? 1 : 0
  mask[off[ATTACK] + 1] = aimed
  mask[off[ATTACK] + 2] = aimed
  mask[off[USE] + 1] = me.shieldDisabled === 0 && me.hasShield !== false ? 1 : 0
  for (const i of [2, 3, 4]) mask[off[WEAPON] + i] = 0   // keep or the axe, nothing else
  mask[off[LOCK_AIM] + 1] = 0
  const focus = focusOf(s)
  const known = focus ? focus.pos : me.pos
  if (Math.hypot(known[0] - me.pos[0], known[2] - me.pos[2]) < FINE_TURN_RANGE) {
    FINE_YAW.forEach((fine, i) => { if (fine) mask[off[YAW] + i] = 0 })
    FINE_PITCH.forEach((fine, i) => { if (fine) mask[off[PITCH] + i] = 0 })
  }
  return mask
}

// Builds the input state from what a client can see, one game tick at a time. A frame is
//   { me: { pos, vel, yaw, pitch, onGround, hp, wall }, mobs: [{ id, kind, pos, hp, yaw, swellDir, angry, drawing, kick }],
//     arrows: [{ pos, vel }], swung, hurt, blocked, hitMobs: [ids], hurtMobs: [ids] }
// and the order of calls per decision is state(), then tick(frame, action) for each tick, then endDecision(action, n).
class MobTracker {
  constructor ({ arena = null } = {}) {
    this.arena = arena
    this.reset(null)
  }

  reset (frame) {
    this.ticks = 0
    this.me = null
    this.mobs = new Map()
    this.arrows = []
    this.attackTicks = 1000
    this.hurtTimer = 0
    this.shieldTicks = 0
    this.useHeld = false
    this.fall = 0
    this.sprinting = false
    this.sprintHeld = false
    this.sneaking = false
    this.wall = false
    this.sinceHit = NEVER
    this.sinceHurt = NEVER
    this.combo = 0
    this.fresh = true
    this.enemyHealth = MAX_HEALTH
    this.lastAction = IDLE_ACTION.slice()
    this.stepHit = false
    this.stepHurt = false
    this.stepDealt = 0
    if (frame) this.see(frame, true)
  }

  // Positions, health and flags of this frame. A mob's motion is rebuilt from how far it moved: the simulator's reads
  // after friction, so a step on the ground counts for 0.546 of itself
  see (frame, first = false) {
    const prevY = this.me?.pos[1]
    this.me = { ...frame.me }
    if (!first && prevY !== undefined) {
      const dy = frame.me.pos[1] - prevY
      if (dy < 0) this.fall -= dy
      if (frame.me.onGround) this.fall = 0
    }
    this.wall = !!frame.me.wall
    this.arrows = frame.arrows || []
    const seen = new Set()
    for (const f of frame.mobs) {
      seen.add(f.id)
      const old = this.mobs.get(f.id)
      const m = old || { id: f.id, kind: f.kind, pos: f.pos, vel: [0, 0, 0], seenPos: f.pos, seenVel: [0, 0, 0], onGround: true, hurtTimer: 0, swell: 0, draw: 0 }
      if (old && !first) {
        const step = [f.pos[0] - old.pos[0], f.pos[1] - old.pos[1], f.pos[2] - old.pos[2]]
        const moved = step[0] !== 0 || step[1] !== 0 || step[2] !== 0
        if (moved || !f.heldPos) {
          const drag = old.onGround ? GROUND_DRAG : AIR_DRAG
          const per = f.heldPos ? (f.heldFor || 1) : 1
          if (Math.hypot(step[0], step[1], step[2]) / per > TELEPORT_STEP) {
            m.vel = [0, 0, 0]   // an enderman's teleport is a new place, not speed
            m.onGround = true
          } else {
            m.vel = [step[0] / per * drag, (step[1] / per - 0.08) * VERTICAL_DRAG, step[2] / per * drag]
            m.onGround = Math.abs(step[1]) < 1e-6
          }
        }
      }
      if (f.kick) m.vel = f.kick   // knocked after it moved: the game sends that speed as its own packet
      m.pos = f.pos
      m.hp = f.hp
      m.yaw = f.yaw
      m.swellDir = f.swellDir
      m.provoked = !!f.angry
      m.drawing = !!f.drawing
      m.inSight = f.inSight !== false
      if (m.inSight) {
        m.seenPos = f.pos
        m.seenVel = m.vel
      }
      m.groundY = f.groundY
      m.maxHp = f.maxHp
      if (!first) {
        m.draw = m.drawing ? m.draw + 1 : 0
        if (m.kind === CREEPER) m.swell = clamp(m.swell + (m.swellDir > 0 ? 1 : -1), 0, FUSE)
      }
      this.mobs.set(f.id, m)
    }
    return seen
  }

  // One game tick, in the simulator's order: the swing, the sprint keys, the move, then the timers
  tick (frame, action) {
    const use = action[USE] === 1
    const key = action[SPRINT] === 1 && action[FORWARD] === 1 && !this.wall && action[9] !== 1 && (this.sprintHeld || !use)
    const charge = this.charge()
    const hits = new Set(frame.hitMobs || [])
    if (frame.swung) {
      if (hits.size && this.sprinting && charge > CHARGE_GATE) this.sprinting = false
      this.attackTicks = 0
    }
    this.sprinting = (this.sprinting || (key && !this.sprintHeld)) && key
    this.sprintHeld = key
    this.sneaking = action[9] === 1
    this.shieldTicks = use && (frame.me.shield !== false) ? this.shieldTicks + 1 : 0
    this.useHeld = use

    const before = new Map([...this.mobs].map(([id, m]) => [id, m.hp]))
    const seen = this.see(frame)
    if (frame.me.wall) this.sprinting = false
    for (const id of hits) {
      const was = before.get(id)
      if (was === undefined) continue
      const now = seen.has(id) ? this.mobs.get(id).hp : 0
      this.stepDealt += Math.max(was - now, 0)
      this.stepHit = true
    }
    for (const id of this.mobs.keys()) if (!seen.has(id)) this.mobs.delete(id)
    for (const id of frame.hurtMobs || []) {
      const m = this.mobs.get(id)
      if (m && m.hurtTimer === 0) m.hurtTimer = HURT_TICKS
    }
    for (const m of this.mobs.values()) if (m.hurtTimer > 0) m.hurtTimer--
    if (this.hurtTimer > 0) this.hurtTimer--
    if ((frame.hurt || frame.blocked) && this.hurtTimer === 0) this.hurtTimer = HURT_TICKS
    if (frame.hurt) this.stepHurt = true
    this.attackTicks++
    this.ticks++
  }

  // The counters the simulator moves once per decision, after its ticks
  endDecision (action, ticks) {
    this.sinceHit += ticks
    this.sinceHurt += ticks
    if (this.stepHurt) {
      this.sinceHurt = 0
      this.combo = 0
      this.fresh = true
    }
    if (this.stepHit) {
      this.sinceHit = 0
      this.combo = this.fresh ? 1 : this.combo + 1
      this.fresh = false
    }
    this.enemyHealth = Math.max(this.enemyHealth - this.stepDealt, 0)
    this.stepHit = false
    this.stepHurt = false
    this.stepDealt = 0
    this.lastAction = action.slice(0, 11)
  }

  charge () {
    return clamp((this.attackTicks + 0.5) / (this.attackPeriod || 20), 0, 1)
  }

  state () {
    return {
      ticks: this.ticks,
      arena: this.arena,
      me: {
        ...this.me,
        sprinting: this.sprinting,
        sneaking: this.sneaking,
        hurtTimer: this.hurtTimer,
        fall: this.fall,
        inWater: false,
        eyesInWater: false,
        charge: this.charge(),
        shieldTicks: this.shieldTicks,
        shieldDisabled: 0,
        useHeld: this.useHeld
      },
      memory: {
        sinceHit: this.sinceHit,
        sinceHurt: this.sinceHurt,
        combo: this.combo,
        enemyHealth: this.enemyHealth,
        lastAction: this.lastAction
      },
      mobs: [...this.mobs.values()],
      arrows: this.arrows
    }
  }
}

module.exports = { buildMobInputs, buildMobMask, MobTracker, mobUnderCrosshair, focusOf, KIND_OF, INPUTS, SHARED, MOB_INPUTS, MASK, MAX_MOBS, HEIGHT, RAYS, ZOMBIE, SKELETON, CREEPER, ENDERMAN }
