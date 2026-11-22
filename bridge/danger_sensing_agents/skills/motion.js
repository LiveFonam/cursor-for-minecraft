// How the bot moves and looks to a person watching through its camera. installMotion adds these to a real bot, once:
//
//   camera    forced looks are eased over a few ticks at a human turn speed instead of snapping. Digs start as soon as
//             the camera is close to the block, and keep turning onto it while the block breaks.
//   jumps     a jump is held back while the body still sits under a low ceiling. On a dug staircase the bot used to jump
//             with its back half under the lower step, hit that ceiling, lose the jump and wait out the 10 tick cooldown
//             against the wall, once per step.
//   paths     the pathfinder's grid path is shortened to straight lines wherever the whole body fits and the floor is safe.
//   stopping  the end of a walk no longer teleports the bot to the middle of its block.
//   corners   the walk steers at a point a little way along its path and drops a waypoint once the next one is in a
//             clear line, so it curves around a corner instead of walking to the middle of the corner block and turning.
//   replans   a new goal never stops the walk: it carries on along its heading while the search runs, and a path that
//             still ends in the new goal, or nearly, is kept instead of being searched again.
//   approach  on the way to a block the camera turns to it, sideways and up or down, while the body keeps to its line, so
//             the dig starts with the camera already there.
//
// walkCells walks a list of known cells (its own tunnel or staircase) without searching for a path and without stopping
// at waypoints. A fight turns all of this off (setFreeAim): the trained networks keep their exact aim and controls.
// Bots without real physics (the test stand-in) get none of it, and the callers fall back to the plain walk.

const TICK_S = 0.05
const TURN_MAX = 0.16         // radians a tick, about 180 degrees a second
const TURN_ACCEL = 0.05       // how fast a turn speeds up, per tick
const TURN_EASE = 0.4         // the share of what is left to turn, so a turn slows down as it arrives
const TURN_MIN = 0.02
const DEFAULT_TURN_SPEED = 3  // Mineflayer's own, radians a second
const LOOK_EXACT = 0.02       // a look that must be accurate, such as aiming a bucket
const LOOK_WAIT_TICKS = 32     // long enough for a half turn
const DIG_AIM = 0.6           // a dig may start once the camera is this close to the block, and keeps turning onto it
const DIG_AIM_TICKS = 24
const DIG_TURN_SPARE = 6      // a dig that outlasts the camera's turn by this many ticks starts at once
const JUMP_RISE = 1.05        // the room above its head a jump needs to get up one block
const JUMP_HOLD_MAX = 12      // ticks a jump may be held back, so a wrong reading can never freeze it
const PRE_AIM_RANGE = 5
const STRAIGHT_NODES = 14     // how much of a path gets straightened
const STRAIGHT_REACH = 10     // the longest stretch one straight line replaces
const STRAIGHT_THROTTLE = 4   // ticks between straightening a path that is still being searched
const BODY = 0.32             // half the body's width, with a small margin
const PATH_BODY = 0.45        // the clearance a walking line keeps from walls, so the body swings wide of a corner
const SPRINT_FOOD = 6         // the game stops a sprint at this food or lower
const WALK_STALL_TICKS = 30
const DIG_FINISH_MS = 2500    // a dig this close to done is finished before a job that can wait takes over
const DIG_FINISH_URGENT_MS = 350
const DIG_HOLD_HEALTH = 6
const URGENT_MODES = new Set(['kill', 'guard', 'defend', 'retreat', 'avoid', 'mobfight', 'escape'])
const ROUND_RANGE = 1.25      // how far before a waypoint the walk may start to cut its corner
const CARROT = 1.5            // how far along the path it steers at
const BODY_TURN = 0.5         // radians a tick the walking direction may swing (the camera is eased on its own)
const STEER_MIN = 0.12        // closer than this to the point it steers at, the heading means nothing
const COAST_TICKS = 10        // how long it keeps walking on its heading while a new path is searched
const COAST_LOOK = 1          // the floor it must see ahead to do that
const KEEP_TICKS = 2          // a path stays reusable this long after its goal changed
const KEEP_NEAR = 2.5         // and only while the bot is this close to its next node
const TAIL_REACH = 3          // a goal this close to the end of the old path gets a short extension
const TAIL_MS = 15            // the time limit of that short search
const REUSE_RESETS = new Set(['goal_updated', 'goal_moved'])
const COAST_RESETS = new Set(['goal_updated', 'goal_moved', 'block_updated'])
const LEAD_DONE = 0.01        // radians: the camera is back on the body's heading
const LEAD_SETTLED = 0.03     // and the body's heading has held this still since the last tick
const FREE_SPEED = 60         // Mineflayer's own look speed while the sent camera is led, so it stays on the body
// The game's pickup box: the body grown by 1 block sideways and 0.5 up and down, touching the item's own 0.25 box
const PICKUP_X = 1.425        // sideways: 0.3 of body, 1 of reach, 0.125 of item
const PICKUP_BELOW = 0.75     // 0.5 of reach, 0.25 of item height
const PICKUP_ABOVE = 2.3
const PICKUP_MARGIN = 0.1     // aim this far inside that box
const SPOT_INSET = BODY + 0.02  // a standing spot keeps the whole body inside its cell
const NEXT_TURN_TICKS = 8     // in the last ticks of a dig the camera starts toward the next block
const NEXT_TURN_MAX = 0.3     // but stays this close to the block still breaking, about its edge
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const FACE_SPOTS = [[0, 0], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]
const ORE_SIGHT_CHECKS = 48    // line of sight checks one ore search may run
const ORE_FIND_COUNT = 1000    // buried ore must not crowd visible ore out of the search
const ORE_MEMORY = 4096        // ore positions it keeps in mind

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a))
const isFlee = goal => goal?.constructor?.name === 'GoalInvert'
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const toSentYaw = yaw => ((Math.PI - yaw) * 180) / Math.PI
const toSentPitch = pitch => (-pitch * 180) / Math.PI

function newStats () {
  return { digStarted: 0, digFinished: 0, digCanceled: 0, digMs: 0, jumpsHeld: 0, nodesSkipped: 0, snapsAvoided: 0, cellWalks: 0, cellWalkStalls: 0, digsHeld: 0, cornersRounded: 0, coastTicks: 0, pathsReused: 0, pathsExtended: 0, leadTicks: 0 }
}

// Can it see any open face of this block from its eyes? Mineflayer's canSeeBlock ends its ray at the block's lowest corner,
// which is short of the block whenever that corner is the near one, so ore in plain view on the +x or +z side counts as
// hidden. This casts to points on each face that looks at the eyes and has no solid block against it. Still no X-ray: a
// block with no open face, or with something solid in the way, is never seen
function seesBlock (bot, block) {
  if (typeof bot.world?.raycast !== 'function') return !!bot.canSeeBlock?.(block)
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const pos = block.position
  const c = pos.offset(0.5, 0.5, 0.5)
  const match = (input, iter) => !!iter?.intersect?.(input.shapes, input.position) || input.position.equals(pos)
  for (const [fx, fy, fz] of FACES) {
    if ((eye.x - c.x) * fx + (eye.y - c.y) * fy + (eye.z - c.z) * fz <= 0.5) continue
    const side = bot.blockAt(pos.offset(fx, fy, fz), false)
    if (!side || side.boundingBox === 'block') continue
    for (const [u, v] of FACE_SPOTS) {
      const point = c.offset(
        fx * 0.49 + (fx ? 0 : u),
        fy * 0.49 + (fy ? 0 : (fx ? u : v)),
        fz * 0.49 + (fz ? 0 : v)
      )
      const d = point.minus(eye)
      const len = d.norm()
      if (len < 1e-6) return true
      const hit = bot.world.raycast(eye, d.scaled(1 / len), len + 0.02, match)
      if (hit?.position?.equals(pos)) return true
    }
  }
  return false
}

const oreMemory = new WeakMap()
const posKey = p => `${p.x},${p.y},${p.z}`

function hasOpenFace (bot, pos) {
  return FACES.some(([x, y, z]) => {
    const side = bot.blockAt(pos.offset(x, y, z), false)
    return !!side && side.boundingBox !== 'block'
  })
}

// Which of these ore positions it knows: in view right now, or seen earlier and still there. Only ore with an open face
// costs a sight check, at most cap per search. When more are waiting, those checked longest ago go first, so visible ore
// past the limit is picked up by a following search instead of being lost. The result keeps the order of found
function knownOre (bot, found, cap = ORE_SIGHT_CHECKS) {
  const dimension = bot.game?.dimension ?? ''
  let memory = oreMemory.get(bot)
  if (!memory || memory.dimension !== dimension) {
    memory = { dimension, seen: new Set(), asked: new Map(), turn: 0 }
    oreMemory.set(bot, memory)
  }
  memory.turn++
  const known = new Set()
  const waiting = []
  for (const pos of found) {
    const id = posKey(pos)
    if (memory.seen.has(id)) known.add(id)
    else if (hasOpenFace(bot, pos)) waiting.push({ pos, id, asked: memory.asked.get(id) ?? 0 })
  }
  waiting.sort((a, b) => a.asked - b.asked)
  for (const { pos, id } of waiting.slice(0, cap)) {
    memory.asked.set(id, memory.turn)
    const block = bot.blockAt(pos)
    if (block && seesBlock(bot, block)) {
      memory.seen.add(id)
      known.add(id)
    }
  }
  for (const id of memory.seen) {
    if (memory.seen.size <= ORE_MEMORY) break
    memory.seen.delete(id)
  }
  if (memory.asked.size > ORE_MEMORY) memory.asked.clear()
  return found.filter(pos => known.has(posKey(pos)))
}

// The ore of these ids within radius that it knows about, nearest first
function findKnownOre (bot, ids, radius, cap = ORE_SIGHT_CHECKS) {
  if (!ids.length) return []
  return knownOre(bot, bot.findBlocks({ matching: ids, maxDistance: radius, count: ORE_FIND_COUNT }), cap)
}

// Is a drop inside the box the game hands items over in, for a body standing at p?
function inPickupBox (p, drop, margin = 0) {
  const side = PICKUP_X - margin
  return Math.abs(drop.x - p.x) <= side && Math.abs(drop.z - p.z) <= side && drop.y >= p.y - PICKUP_BELOW && drop.y <= p.y + PICKUP_ABOVE
}

// The nearest place on its own level, in a clear straight line, where the game hands this drop over. A drop inside a wall
// hole needs no walk into the hole: the cell in front of it is close enough. null when no straight walk gets there
function pickupSpot (bot, moves, drop) {
  const p = bot.entity.position
  const y = Math.floor(p.y + 0.01)
  const Vec = p.constructor
  const seen = new Map()
  const out = []
  for (let x = Math.floor(drop.x) - 2; x <= Math.floor(drop.x) + 2; x++) {
    for (let z = Math.floor(drop.z) - 2; z <= Math.floor(drop.z) + 2; z++) {
      const spot = new Vec(clamp(drop.x, x + SPOT_INSET, x + 1 - SPOT_INSET), y, clamp(drop.z, z + SPOT_INSET, z + 1 - SPOT_INSET))
      if (inPickupBox(spot, drop, PICKUP_MARGIN)) out.push({ spot, d: Math.hypot(spot.x - p.x, spot.z - p.z) })
    }
  }
  out.sort((a, b) => a.d - b.d)
  for (const { spot } of out) {
    if (clearLine(bot, moves, new Vec(p.x, y, p.z), spot, seen)) return spot
  }
  return null
}

// The next camera speed in radians a tick: speeds up, then slows down as it arrives
function nextTurnStep (error, previous) {
  if (error <= TURN_MIN) return TURN_MIN
  return Math.max(TURN_MIN, Math.min(error * TURN_EASE, previous + TURN_ACCEL, TURN_MAX))
}

// How high it can rise before its head meets a block, over every column its body is in
function headroom (bot) {
  const p = bot.entity.position
  const w = bot.physics?.playerHalfWidth ?? 0.3
  const top = p.y + 1.8
  let room = Infinity
  const Vec = p.constructor
  for (let x = Math.floor(p.x - w); x <= Math.floor(p.x + w - 1e-6); x++) {
    for (let z = Math.floor(p.z - w); z <= Math.floor(p.z + w - 1e-6); z++) {
      for (let y = Math.floor(top); y <= Math.floor(top + JUMP_RISE + 0.3); y++) {
        const b = bot.blockAt(new Vec(x, y, z), false)
        if (!b || b.boundingBox !== 'block' || !b.shapes?.length) continue
        const bottom = y + Math.min(...b.shapes.map(s => s[1]))
        if (bottom < top - 1e-3) continue
        room = Math.min(room, bottom - top)
        break
      }
    }
  }
  return room
}

// Is the whole body free to walk the straight line from a to b on one level, with safe floor all the way?
function clearLine (bot, moves, a, b, seen = new Map(), body = BODY) {
  const y = Math.floor(b.y + 1e-3)
  const Vec = b.constructor
  const cell = (x, cy, z) => {
    const k = `${x},${cy},${z}`
    if (!seen.has(k)) seen.set(k, bot.blockAt(new Vec(x, cy, z), false) || null)
    return seen.get(k)
  }
  const okCell = (x, z) => {
    for (const dy of [0, 1]) {
      const c = cell(x, y + dy, z)
      if (!c || c.boundingBox !== 'empty' || moves.blocksToAvoid?.has(c.type) || moves.liquids?.has(c.type)) return false
    }
    const floor = cell(x, y - 1, z)
    if (!floor || floor.boundingBox !== 'block' || moves.blocksToAvoid?.has(floor.type) || moves.liquids?.has(floor.type)) return false
    const here = cell(x, y, z)
    return !(moves.exclusionAreasStep?.length && moves.exclusionStep(here) > 0)
  }
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  const steps = Math.max(1, Math.ceil(len / 0.25))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = a.x + (b.x - a.x) * t
    const z = a.z + (b.z - a.z) * t
    for (const [ox, oz] of [[-body, -body], [body, -body], [-body, body], [body, body]]) {
      if (!okCell(Math.floor(x + ox), Math.floor(z + oz))) return false
    }
  }
  return true
}

// a node reached by plain walking: not a dig, a placed block, or a running jump across a gap
const plainNode = n => !n.toBreak?.length && !n.toPlace?.length && !n.parkour

// The pathfinder's diagonal steps can cut across the corner of a wall, and the body then scrapes along it and jerks free.
// Such a step goes by way of the open cell beside it instead, which the steering rounds off. Returns how many it added
function bendDiagonals (bot, moves, path) {
  const seen = new Map()
  let added = 0
  for (let i = 0; i + 1 < path.length && i < STRAIGHT_NODES; i++) {
    const a = path[i]
    const b = path[i + 1]
    if (!plainNode(a) || !plainNode(b) || !Number.isInteger(a.y) || a.y !== b.y) continue
    if (Math.abs(b.x - a.x) !== 1 || Math.abs(b.z - a.z) !== 1) continue
    if (clearLine(bot, moves, a, b, seen)) continue
    for (const [x, z] of [[b.x, a.z], [a.x, b.z]]) {
      const via = a.clone()
      via.x = x
      via.z = z
      if (!clearLine(bot, moves, a, via, seen) || !clearLine(bot, moves, via, b, seen)) continue
      via.toBreak = []
      via.toPlace = []
      path.splice(i + 1, 0, via)
      added++
      i++
      break
    }
  }
  return added
}

// Shortens a path in place: from each point, the farthest later node on the same level that a straight line reaches.
// Nodes that dig, place or change height all stay. Returns how many nodes it removed
function straightenPath (bot, moves, path, from = null) {
  if (!path || path.length < 2) return 0
  const seen = new Map()
  const out = []
  let anchor = from && Math.abs(from.y - path[0].y) < 0.01 ? from : null
  let i = 0
  const limit = Math.min(path.length, STRAIGHT_NODES)
  while (i < limit) {
    const node = path[i]
    if (!anchor || !plainNode(node) || !Number.isInteger(node.y) || Math.abs(anchor.y - node.y) > 0.01) {
      out.push(node)
      anchor = plainNode(node) && Number.isInteger(node.y) ? node : null
      i++
      continue
    }
    let best = i
    for (let j = i + 1; j < limit && j - i <= STRAIGHT_REACH; j++) {
      const n = path[j]
      if (!plainNode(n) || n.y !== node.y) break
      if (clearLine(bot, moves, anchor, n, seen)) best = j
    }
    out.push(path[best])
    anchor = path[best]
    i = best + 1
  }
  const removed = limit - out.length
  if (removed > 0) path.splice(0, limit, ...out)
  return removed
}

// Adds the smooth camera, jumps and paths to a real bot. Safe to call twice. Returns bot.motion, or null for a stand-in
function installMotion (bot) {
  if (bot.motion) return bot.motion
  if (!bot._client?.write || !bot.physics || typeof bot.look !== 'function' || !bot.pathfinder) return null
  const m = {
    free: false,          // a fight: the network's own aim and controls, none of this applies
    aim: null,            // the block it is about to work on, the camera turns toward it on the way
    nextAim: null,        // the block after the one it is digging
    digTicks: 0,          // ticks left on the dig in progress
    path: null,           // the pathfinder's current path
    walking: false,       // walkCells is driving
    sent: { yaw: bot.entity.yaw, pitch: bot.entity.pitch },
    turn: 0,              // the camera's speed last tick, radians
    digEndsAt: 0,
    lead: null,           // the camera while it turns ahead of the body, { yaw, pitch }
    leadUnsent: false,
    heading: null,        // the walking direction the corner steering holds
    coast: 0,             // ticks left to keep walking while a new path is searched
    kept: null,           // the path of a goal that just changed, for the next search to reuse
    stats: newStats()
  }
  bot.motion = m

  // what the server actually sees of the camera. While the camera leads, every packet carries its look instead of the body's
  // heading (a copy: Mineflayer keeps and compares the object it passes here)
  const write = bot._client.write.bind(bot._client)
  bot._client.write = (name, params) => {
    if (m.lead && !m.free && params && (name === 'look' || name === 'position_look' || name === 'position')) {
      params = { ...params, yaw: toSentYaw(m.lead.yaw), pitch: toSentPitch(m.lead.pitch) }
      if (name === 'position') name = 'position_look'
    }
    if ((name === 'look' || name === 'position_look') && params) {
      m.sent.yaw = Math.PI - (params.yaw * Math.PI) / 180
      m.sent.pitch = (-params.pitch * Math.PI) / 180
      m.leadUnsent = false
    }
    return write(name, params)
  }
  // Mineflayer sends nothing on a tick when neither its position nor its own look changed
  const flushLead = () => {
    if (!m.lead || !m.leadUnsent || m.free) return
    m.leadUnsent = false
    const onGround = !!bot.entity.onGround
    bot._client.write('look', { yaw: toSentYaw(m.lead.yaw), pitch: toSentPitch(m.lead.pitch), onGround, flags: { onGround, hasHorizontalCollision: undefined } })
  }

  const off = () => ({ yaw: Math.abs(wrap(bot.entity.yaw - m.sent.yaw)), pitch: Math.abs(bot.entity.pitch - m.sent.pitch) })
  let waiters = []
  // resolves once the camera is within tolerance of where the bot means to look, or after maxTicks
  const aimed = (tolerance, maxTicks) => {
    const e = off()
    if (e.yaw <= tolerance && e.pitch <= tolerance) return Promise.resolve()
    return new Promise(resolve => {
      // the clock too: no ticks run while dead or between worlds, and a job must never hang on a look
      const timer = setTimeout(() => done(), maxTicks * 50 + 150)
      const w = { tolerance, left: maxTicks, done: null }
      const done = () => {
        clearTimeout(timer)
        waiters = waiters.filter(x => x !== w)
        resolve()
      }
      w.done = done
      waiters.push(w)
    })
  }
  m.aimed = aimed

  const rawLook = bot.look
  m.rawLook = rawLook
  // burning or in lava every tick counts: aiming a water bucket stays instant
  const burning = () => !!bot.entity.isInLava || !!((bot.entity.metadata?.[0] ?? 0) & 0x01)
  bot.look = (yaw, pitch, force) => {
    if (force !== true || m.free) return rawLook(yaw, pitch, force)
    if (burning()) {
      m.lead = null  // this look must land at once, and on the real camera
      return rawLook(yaw, pitch, force)
    }
    m.aim = null  // an exact look outranks a block it was only turning toward
    Promise.resolve(rawLook(yaw, pitch, false)).catch(() => {})
    return aimed(LOOK_EXACT, LOOK_WAIT_TICKS)
  }

  // one continuous dig: start turning, start breaking once the camera is near, keep turning while it breaks
  if (typeof bot.dig === 'function') {
    const rawDig = bot.dig
    bot.dig = async (block, forceLook, digFace) => {
      if (m.free || !block?.position) return rawDig(block, forceLook, digFace)
      m.stats.digStarted++
      const started = Date.now()
      let toolGone = false
      // the camera may be leading toward another block: this one comes first
      if (m.aim) m.aim = block.position.offset(0.5, 0.5, 0.5)
      try {
        const ms = typeof bot.digTime === 'function' ? bot.digTime(block) : 0
        if (forceLook !== 'ignore') {
          Promise.resolve(bot.lookAt(block.position.offset(0.5, 0.5, 0.5), false)).catch(() => {})
          // the crack starts while the camera comes round, as long as it arrives well before the block breaks
          const e = off()
          const turnTicks = Math.hypot(e.yaw, e.pitch) / TURN_MAX
          if (!(Number.isFinite(ms) && turnTicks + DIG_TURN_SPARE <= ms / 50)) await aimed(DIG_AIM, DIG_AIM_TICKS)
        }
        m.digEndsAt = Date.now() + (Number.isFinite(ms) ? ms : 0)
        m.digTicks = Number.isFinite(ms) ? Math.ceil(ms / 50) : 0
        // The dig time was worked out for the tool in hand. If it breaks now the server needs far longer, while Mineflayer
        // would still mark the block gone when its timer ends and the bot would walk into a block only it thinks is air
        const tool = bot.heldItem?.type ?? null
        const onHeld = () => {
          if (toolGone || (bot.heldItem?.type ?? null) === tool) return
          toolGone = true
          try { bot.stopDigging() } catch {}
        }
        bot.on('heldItemChanged', onHeld)
        let r
        try {
          r = await rawDig(block, 'ignore')
        } finally {
          bot.removeListener('heldItemChanged', onHeld)
        }
        m.stats.digFinished++
        m.stats.digMs += Date.now() - started
        return r
      } catch (err) {
        if (/abort/i.test(err?.message || '')) m.stats.digCanceled++
        if (toolGone) throw new Error('Digging aborted: the tool in hand changed')
        throw err
      } finally {
        m.digEndsAt = 0
        m.digTicks = 0
      }
    }
  }

  // the path the pathfinder is about to follow, shortened to straight lines
  let lastStraight = -STRAIGHT_THROTTLE
  let tick = 0
  bot.on('path_update', results => {
    m.path = results.path
    // nothing to walk on: no carrying on along the old heading either
    if (m.coast > 0 && !results.path?.length && results.status !== 'partial') {
      m.coast = 0
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)
    }
    if (m.free || !results.path?.length) return
    if (results.status === 'partial' && tick - lastStraight < STRAIGHT_THROTTLE) return
    lastStraight = tick
    const moves = bot.pathfinder.movements
    if (!moves) return
    const from = bot.entity.onGround ? bot.entity.position : null
    bendDiagonals(bot, moves, results.path)
    m.stats.nodesSkipped += straightenPath(bot, moves, results.path, from)
  })

  // A goal that changed mid walk: the path so far is kept for the search that follows
  bot.on('path_reset', reason => {
    if (m.free) return
    const pf = bot.pathfinder
    if (REUSE_RESETS.has(reason) && m.path?.length) m.kept = { path: m.path.slice(), moves: pf.movements, tick }
    if (COAST_RESETS.has(reason) && bot.getControlState('forward') && !m.walking) m.coast = COAST_TICKS
  })
  bot.on('blockUpdate', (was, now) => {
    if (m.kept && was?.type !== now?.type) m.kept = null
  })

  // The old path when it still ends in the new goal, the old path plus a short extension when the goal moved a little.
  // null means a full search. Paths that dig or place are never reused: those nodes are used up as they run
  const keptPath = (moves, goal) => {
    const k = m.kept
    m.kept = null
    if (!k || k.moves !== moves || tick - k.tick > KEEP_TICKS || !k.path.length || !k.path.every(plainNode)) return null
    if (isFlee(goal)) return null  // running from something always gets a fresh path
    const p = bot.entity.position
    const first = k.path[0]
    if (Math.abs(first.y - p.y) > 1.2) return null
    // a straightened path can have its next node far ahead, which is fine as long as the way there is open
    if (Math.hypot(first.x - p.x, first.z - p.z) > KEEP_NEAR && !(Math.abs(first.y - p.y) < 0.01 && clearLine(bot, moves, p, first))) return null
    const last = k.path[k.path.length - 1]
    const end = p.constructor ? new p.constructor(Math.floor(last.x), Math.floor(last.y), Math.floor(last.z)) : null
    try {
      if (goal.isEnd(end)) return k.path
      const h = goal.heuristic(end)
      if (!(h >= 0 && h <= TAIL_REACH)) return null
      const search = bot.pathfinder.getPathFromTo(moves, end.offset(0.5, 0, 0.5), goal, { timeout: TAIL_MS, tickTimeout: TAIL_MS })
      const tail = search.next().value?.result
      if (tail?.status !== 'success' || !tail.path.length || !tail.path.every(plainNode)) return null
      m.stats.pathsExtended++
      return k.path.concat(tail.path)
    } catch {
      return null
    }
  }
  const rawGetPathTo = bot.pathfinder.getPathTo
  bot.pathfinder.getPathTo = (moves, goal, timeout) => {
    const path = m.free ? null : keptPath(moves, goal)
    if (!path) return rawGetPathTo(moves, goal, timeout)
    m.stats.pathsReused++
    return { status: 'success', cost: path.length, time: 0, visitedNodes: 0, generatedNodes: 0, path }
  }

  // setting a goal lets go of every key: a walk that gets a new goal keeps its keys, so it never loses a tick of speed
  const rawSetGoal = bot.pathfinder.setGoal
  bot.pathfinder.setGoal = (goal, dynamic = false) => {
    const walking = !m.free && !m.walking && !!goal && !isFlee(goal) && bot.pathfinder.isMoving() && bot.getControlState('forward')
    const sprinting = walking && bot.getControlState('sprint')
    rawSetGoal(goal, dynamic)
    if (!goal || isFlee(goal)) m.coast = 0  // never carries on along the old heading, which may lead at the danger
    if (!walking) return
    bot.setControlState('forward', true)
    if (sprinting) bot.setControlState('sprint', true)
  }

  // Follows the path in a curve: waypoints whose corner it can cut are dropped, and it steers at a point a little way along
  // what is left. Only on flat stretches of plain walking. Steps, jumps, digs and placed blocks stay the pathfinder's
  const steerPath = (yawBefore) => {
    const pf = bot.pathfinder
    const e = bot.entity
    const path = m.path
    const moves = pf.movements
    if (m.walking || !moves || !path?.length || !pf.isMoving() || pf.isMining?.() || pf.isBuilding?.()) return false
    if (!e.onGround || e.isInWater || e.isInLava || bot.getControlState('jump')) return false
    const p = e.position
    const flat = n => plainNode(n) && Number.isInteger(n.y) && Math.abs(n.y - p.y) < 0.01
    // near a step or a running jump the pathfinder's own straight approach is what makes the jump land
    if (!path.slice(0, 3).every(flat)) return false
    const seen = new Map()
    // the waypoint is moved onto the body rather than removed, so the pathfinder counts it as reached: it treats 3.5 s
    // without reaching a node as stuck and would stop the walk to search again
    if (path.length > 1 && flat(path[1]) && Math.hypot(path[0].x - p.x, path[0].z - p.z) <= ROUND_RANGE && clearLine(bot, moves, p, path[1], seen, PATH_BODY)) {
      path[0].x = p.x
      path[0].z = p.z
      m.stats.cornersRounded++
    }
    const Vec = p.constructor
    let from = p
    let left = CARROT
    let target = null
    for (let i = 0; i < path.length && i < 4; i++) {
      const n = path[i]
      if (!flat(n)) break
      const d = Math.hypot(n.x - from.x, n.z - from.z)
      if (d >= left) {
        const t = left / d
        target = new Vec(from.x + (n.x - from.x) * t, n.y, from.z + (n.z - from.z) * t)
        break
      }
      left -= d
      from = n
      target = n
    }
    if (!target || !clearLine(bot, moves, p, target, seen, PATH_BODY)) target = path[0]
    if (Math.hypot(target.x - p.x, target.z - p.z) < STEER_MIN) return false
    const want = Math.atan2(-(target.x - p.x), -(target.z - p.z))
    const was = m.heading ?? yawBefore ?? e.yaw
    m.heading = was + clamp(wrap(want - was), -BODY_TURN, BODY_TURN)
    Promise.resolve(rawLook(m.heading, e.pitch, false)).catch(() => {})
    bot.setControlState('forward', true)
    return true
  }

  // A goal changed and no path has come back yet: on along its heading, while the floor ahead is clear
  const coast = () => {
    if (m.coast <= 0) return
    const pf = bot.pathfinder
    const e = bot.entity
    if (pf.isMoving() || m.walking) {
      m.coast = 0
      return
    }
    const stop = () => {
      m.coast = 0
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)
    }
    if (!pf.goal || !pf.movements || !e.onGround || e.isInWater || e.isInLava) return stop()
    const p = e.position
    const ahead = new p.constructor(p.x - Math.sin(e.yaw) * COAST_LOOK, p.y, p.z - Math.cos(e.yaw) * COAST_LOOK)
    if (!clearLine(bot, pf.movements, p, ahead)) return stop()
    bot.setControlState('forward', true)
    m.stats.coastTicks++
    if (--m.coast === 0) stop()
  }

  // On the way to a block the camera turns to it while the body keeps its line. With nothing to look at it eases back onto
  // the body's heading and hands the camera back to Mineflayer. True while it is leading
  const leadCamera = () => {
    const e = bot.entity
    if (burning()) {
      m.lead = null
      return false
    }
    const eye = e.position.offset(0, e.eyeHeight ?? 1.62, 0)
    const lookAt = point => {
      const d = point.minus(eye)
      return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)), dist: d.norm() }
    }
    let want = null
    if (m.aim) {
      const a = lookAt(m.aim)
      if (a.dist <= PRE_AIM_RANGE) want = a
    } else if (m.nextAim && bot.targetDigBlock?.position && m.digTicks > 0 && m.digTicks <= NEXT_TURN_TICKS) {
      // the block is nearly broken: the camera drifts to its edge on the side of the next one
      const now = lookAt(bot.targetDigBlock.position.offset(0.5, 0.5, 0.5))
      const next = lookAt(m.nextAim)
      const dy = wrap(next.yaw - now.yaw)
      const dp = next.pitch - now.pitch
      const gap = Math.hypot(dy, dp)
      const k = gap > 0 ? Math.min(1, NEXT_TURN_MAX / gap) : 0
      want = { yaw: now.yaw + dy * k, pitch: now.pitch + dp * k }
    }
    if (want && !m.lead) m.lead = { yaw: m.sent.yaw, pitch: m.sent.pitch, bodyYaw: e.yaw, bodyPitch: e.pitch }
    if (!m.lead) return false
    const target = want || { yaw: e.yaw, pitch: e.pitch }
    const dy = wrap(target.yaw - m.lead.yaw)
    const dp = target.pitch - m.lead.pitch
    const err = Math.hypot(dy, dp)
    // handed back only when Mineflayer's own look, which followed the body last tick, is where the camera is now
    const settled = Math.abs(wrap(e.yaw - m.lead.bodyYaw)) <= LEAD_SETTLED && Math.abs(e.pitch - m.lead.bodyPitch) <= LEAD_SETTLED
    m.lead.bodyYaw = e.yaw
    m.lead.bodyPitch = e.pitch
    if (!want && err <= LEAD_DONE && settled) {
      m.lead = null
      return false
    }
    m.turn = nextTurnStep(err, m.turn)
    const k = err > 0 ? Math.min(1, m.turn / err) : 0
    m.lead.yaw += dy * k
    m.lead.pitch += dp * k
    m.stats.leadTicks++
    m.leadUnsent = true
    queueMicrotask(flushLead)
    return true
  }

  let before = null
  let held = 0
  bot.prependListener('physicsTick', () => {
    const e = bot.entity
    before = { x: e.position.x, z: e.position.z, vx: e.velocity.x, vz: e.velocity.z, yaw: e.yaw }
  })

  bot.on('physicsTick', () => {
    tick++
    const e = bot.entity
    if (m.digTicks > 0) m.digTicks--
    if (m.free) {
      before = null
      held = 0
      return
    }

    // the end of a walk: the pathfinder recentres the bot and zeroes its speed in one tick, which shows as a jerk.
    // A block it is about to place still needs the body out of the way, so that case stays
    if (before) {
      const placing = bot.pathfinder.isBuilding?.() || m.path?.[0]?.toPlace?.length > 0
      const moved = Math.hypot(e.position.x - before.x, e.position.z - before.z)
      if (!placing && moved > 0 && moved <= 0.5) {
        e.position.x = before.x
        e.position.z = before.z
        if (e.velocity.x === 0 && e.velocity.z === 0) {
          e.velocity.x = before.vx * 0.4
          e.velocity.z = before.vz * 0.4
        }
        m.stats.snapsAvoided++
      }
    }

    // a jump that cannot get up the step is not pressed yet
    const moving = m.walking || bot.pathfinder.isMoving?.()
    if (moving && bot.getControlState('jump') && e.onGround && !e.isInWater && !e.isInLava && held < JUMP_HOLD_MAX && headroom(bot) < JUMP_RISE) {
      bot.setControlState('jump', false)
      bot.jumpQueued = false  // pressing the key queues a jump that would still fire on the next tick
      held++
      m.stats.jumpsHeld++
    } else if (!bot.getControlState('jump') || !e.onGround) {
      held = 0
    }

    if (!steerPath(before?.yaw)) m.heading = null
    coast()

    // the camera speed for this tick, read by Mineflayer as it sends the look
    if (leadCamera()) {
      bot.physics.yawSpeed = FREE_SPEED
      bot.physics.pitchSpeed = FREE_SPEED
    } else {
      const err = off()
      // one speed for the whole turn, shared between the axes, so a diagonal is no faster and both arrive together
      const total = Math.hypot(err.yaw, err.pitch)
      m.turn = nextTurnStep(total, m.turn)
      const share = axis => (total > 0 ? (m.turn * axis) / total : TURN_MIN)
      bot.physics.yawSpeed = share(err.yaw) / TICK_S
      bot.physics.pitchSpeed = share(err.pitch) / TICK_S
    }

    for (const w of waiters.slice()) {
      const now = off()
      if (--w.left <= 0 || (now.yaw <= w.tolerance && now.pitch <= w.tolerance)) w.done()
    }
  })
  return m
}

// A fight owns the camera and the keys: its aim stays exact and instant. Off again when the fight is over
function setFreeAim (bot, on) {
  const m = bot.motion
  if (!m || m.free === on) return
  m.free = on
  m.aim = null
  m.nextAim = null
  m.lead = null
  m.heading = null
  m.coast = 0
  m.kept = null
  m.turn = 0
  if (bot.physics) {
    bot.physics.yawSpeed = DEFAULT_TURN_SPEED
    bot.physics.pitchSpeed = DEFAULT_TURN_SPEED
  }
}

// The block it is heading for, so the camera tips toward it on the way. null clears it
function preAim (bot, point) {
  if (bot.motion) bot.motion.aim = point || null
}

// The block it will dig after the one it is digging now, so the turn starts before this one breaks. null clears it
function preAimNext (bot, point) {
  if (bot.motion) bot.motion.nextAim = point || null
}

const canFlow = bot => !!bot.motion && !bot.motion.free

const cellCentre = c => c.offset(0.5, 0, 0.5)

// Walks through known standing cells in order, without a path search and without stopping at any of them. Sprints when
// food allows, jumps up steps with clean timing, slows only for the last cell. True on arrival, false when cancelled.
// Throws when it stops making progress, so the caller can use the pathfinder instead
async function walkCells (bot, cells, token, { sprint = true } = {}) {
  const m = bot.motion
  if (!m) throw new Error('no smooth walking on this bot')
  if (!cells.length) return true
  bot.pathfinder.setGoal(null)
  const last = cells.length - 1
  let i = 0
  let bestD = Infinity
  for (let k = 0; k <= last; k++) {
    const d = cellCentre(cells[k]).distanceTo(bot.entity.position)
    if (d <= bestD) { bestD = d; i = k }
  }
  const sameLine = (a, b, c) => (b.x - a.x) === (c.x - b.x) && (b.z - a.z) === (c.z - b.z)
  let progress = Infinity
  let idle = 0
  m.walking = true
  m.stats.cellWalks++
  try {
    for (;;) {
      if (token?.cancelled) return false
      const e = bot.entity
      const p = e.position
      while (i < last) {
        const c = cellCentre(cells[i])
        if (Math.abs(p.x - c.x) < 0.45 && Math.abs(p.z - c.z) < 0.45 && Math.abs(p.y - c.y) < 1.1) {
          i++
          progress = Infinity
        } else break
      }
      const cell = cells[i]
      const c = cellCentre(cell)
      const dist = Math.hypot(p.x - c.x, p.z - c.z)
      if (i === last && dist < 0.3 && Math.abs(p.y - c.y) < 0.6 && e.onGround) return true

      // along a straight stretch it steers at a point further on, so the camera holds still
      let aim = c
      if (i < last && i > 0 && sameLine(cells[i - 1], cell, cells[i + 1]) && cells[i + 1].y === cell.y) aim = cellCentre(cells[i + 1])
      const yaw = Math.atan2(-(aim.x - p.x), -(aim.z - p.z))
      const rising = cell.y > Math.floor(p.y + 0.01)
      const falling = cell.y < Math.floor(p.y + 0.01)
      const pitch = rising ? -0.18 : falling ? 0.25 : 0
      Promise.resolve(m.rawLook(yaw, pitch, false)).catch(() => {})

      const turnNext = i < last && i > 0 && !sameLine(cells[i - 1], cell, cells[i + 1])
      const easing = i === last && dist < 1.1
      bot.setControlState('forward', !(i === last && dist < 0.3))
      bot.setControlState('sprint', sprint && !easing && !turnNext && (bot.food ?? 20) > SPRINT_FOOD)
      // this runs after the tick's jump check, so it checks the room above its head itself
      bot.setControlState('jump', rising && e.onGround && dist < 1.35 && headroom(bot) >= JUMP_RISE)

      if (dist < progress - 0.04) {
        progress = dist
        idle = 0
      } else if (++idle > WALK_STALL_TICKS) {
        m.stats.cellWalkStalls++
        throw new Error(`walk stalled before ${cell}`)
      }
      await bot.waitForTicks(1)
    }
  } finally {
    m.walking = false
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
  }
}

// May the job in control finish the block it is breaking before this mode takes over? A dig cut short loses all its
// progress and starts again from nothing. Fights, lava and low health only wait for a dig that is about to end
function holdForDig (bot, chosenName, { fireOnly = false } = {}) {
  const m = bot.motion
  if (!m || m.free || !bot.targetDigBlock || !m.digEndsAt) return false
  const left = m.digEndsAt - Date.now()
  if (left <= 0) return false
  const urgent = (URGENT_MODES.has(chosenName) && !(chosenName === 'escape' && fireOnly)) || (bot.health ?? 20) <= DIG_HOLD_HEALTH
  const hold = left <= (urgent ? DIG_FINISH_URGENT_MS : DIG_FINISH_MS)
  if (hold) m.stats.digsHeld++
  return hold
}

module.exports = {
  installMotion,
  setFreeAim,
  preAim,
  preAimNext,
  canFlow,
  walkCells,
  holdForDig,
  straightenPath,
  bendDiagonals,
  clearLine,
  seesBlock,
  knownOre,
  findKnownOre,
  inPickupBox,
  pickupSpot,
  headroom,
  nextTurnStep,
  newStats,
  TURN_MAX,
  DIG_AIM,
  JUMP_RISE,
  DIG_FINISH_MS,
  DIG_FINISH_URGENT_MS
}
