// What stands between the mobs and the player: does water really stop them, which side is best to attack from, and
// the enderman that carries real ground into the gaps. Blocks are read through a blockAt function and are only ever
// moved, never made.

const plans = require('./evil_plan')
const scene = require('./scene')

const HOLDABLE = Object.freeze(['dirt', 'grass_block', 'sand', 'gravel'])
const WET = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])
const HOT = new Set(['lava', 'fire', 'soul_fire'])
const SIDES = Object.freeze(['north', 'east', 'west']) // the south wall has the door
const ALONG = Object.freeze([0, -1, 1, -2, 2, -3, 3])
const DIRS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])
const MAX_BLOCKS = 8        // the longest path an enderman will build
const FAR = 10              // how far past the wall the mobs' side of a path starts, at most
const NEAR = 6              // and at least, so a path always starts outside anything around the base
const DRY_MARGIN = 3        // sides this close to the driest one are all fair picks
const STEP_MS = 700         // each move of the enderman, so about a block every second or two
const SEND_WAIT_MS = 5000   // a console reply slower than this counts as a failed step
const ENDERMAN = `@e[tag=${scene.TAG_EVIL_BRIDGE},limit=1]`
const STOPPED = new Error('stopped')

const keyOf = (x, y, z) => `${x},${y},${z}`
const ringOf = (L, x, z) => Math.max(Math.abs(x - L.x), Math.abs(z - L.z))

function wallCell (L, side, ring, along) {
  const p = plans.wallPoint(L, side, ring, along)
  return { x: Math.floor(p.x), y: L.y, z: Math.floor(p.z) }
}

function gridOf (blockAt) {
  const seen = new Map()
  const read = (x, y, z) => {
    const k = keyOf(x, y, z)
    if (!seen.has(k)) {
      let b = null
      try { b = blockAt(x, y, z) || null } catch {}
      seen.set(k, b)
    }
    return seen.get(k)
  }
  const water = (x, y, z) => {
    const b = read(x, y, z)
    return !!b && (WET.has(b.name) || b.getProperties?.()?.waterlogged === true)
  }
  return {
    read,
    water,
    name: (x, y, z) => read(x, y, z)?.name ?? null,
    passable: (x, y, z) => {
      const b = read(x, y, z)
      return !!b && b.boundingBox === 'empty' && !HOT.has(b.name)
    },
    floor: (x, y, z) => read(x, y, z)?.boundingBox === 'block' && !water(x, y, z)
  }
}

// The same grid with some blocks placed, and some opened up
function patched (g, blocks, open = []) {
  const placed = new Set(blocks.map(b => keyOf(b.x, b.y, b.z)))
  const opened = new Set(open.map(b => keyOf(b.x, b.y, b.z)))
  return {
    ...g,
    water: (x, y, z) => !placed.has(keyOf(x, y, z)) && !opened.has(keyOf(x, y, z)) && g.water(x, y, z),
    floor: (x, y, z) => placed.has(keyOf(x, y, z)) || (!opened.has(keyOf(x, y, z)) && g.floor(x, y, z)),
    passable: (x, y, z) => opened.has(keyOf(x, y, z)) || (!placed.has(keyOf(x, y, z)) && g.passable(x, y, z))
  }
}

const dryOnly = g => ({ ...g, passable: (x, y, z) => g.passable(x, y, z) && !g.water(x, y, z) })
const noWater = g => ({ ...g, water: () => false })

const standable = (g, x, y, z) => g.floor(x, y - 1, z) && g.passable(x, y, z) && g.passable(x, y + 1, z)
const canStand = (g, x, y, z) => standable(g, x, y, z) && !(g.water(x, y, z) && g.water(x, y + 1, z))

function snap (g, x, y, z) {
  for (let k = 0; k < 3; k++) if (canStand(g, x, y - k, z)) return { x, y: y - k, z }
  return null
}

function moves (g, x, y, z) {
  const out = []
  for (const [dx, dz] of DIRS) {
    const [nx, nz] = [x + dx, z + dz]
    if (canStand(g, nx, y, nz)) out.push([nx, y, nz])
    else if (canStand(g, nx, y + 1, nz) && g.passable(x, y + 2, z)) out.push([nx, y + 1, nz])
    else if (g.passable(nx, y, nz) && g.passable(nx, y + 1, nz)) {
      for (let k = 1; k <= 3; k++) {
        if (!g.passable(nx, y - k + 1, nz)) break
        if (canStand(g, nx, y - k, nz)) { out.push([nx, y - k, nz]); break }
      }
    }
  }
  return out
}

// Can a walker get from any start to a spot the test accepts, staying near the base?
function reaches (g, starts, L, radius, isGoal) {
  const seen = new Set()
  const queue = []
  for (const s of starts) {
    const c = snap(g, s.x, s.y, s.z)
    if (c && !seen.has(keyOf(c.x, c.y, c.z))) {
      seen.add(keyOf(c.x, c.y, c.z))
      queue.push([c.x, c.y, c.z])
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const [x, y, z] = queue[i]
    if (isGoal(x, y, z)) return true
    for (const [nx, ny, nz] of moves(g, x, y, z)) {
      if (ringOf(L, nx, nz) > radius || seen.has(keyOf(nx, ny, nz))) continue
      seen.add(keyOf(nx, ny, nz))
      queue.push([nx, ny, nz])
    }
  }
  return false
}

function outerStarts (g, L) {
  const out = []
  for (const side of Object.keys(plans.WALLS)) {
    for (let r = L.half + FAR; r >= L.half + NEAR; r--) {
      const c = wallCell(L, side, r, 0)
      const spot = snap(g, c.x, L.y + 2, c.z)
      if (spot && !g.water(spot.x, spot.y, spot.z)) { out.push(spot); break }
    }
  }
  return out
}

// none: nothing wet in the way. shallow: they wade or climb out. stops: water really keeps them off. unknown: not read
function readMoat ({ blockAt, layout: L }) {
  const g = gridOf(blockAt)
  const R = L.half + FAR
  for (let x = L.x - R; x <= L.x + R; x++) {
    for (let z = L.z - R; z <= L.z + R; z++) {
      if (!g.read(x, L.y, z)) return { verdict: 'unknown', why: 'the ground is not loaded' }
    }
  }
  const starts = outerStarts(g, L)
  if (!starts.length) return { verdict: 'unknown', why: 'no ground outside to start from' }
  const atBase = (x, y, z) => ringOf(L, x, z) === L.half + 1
  if (reaches(dryOnly(g), starts, L, R, atBase)) return { verdict: 'none', why: 'a dry way in' }
  if (reaches(g, starts, L, R, atBase)) return { verdict: 'shallow', why: 'zombies wade across' }
  if (reaches(noWater(g), starts, L, R, atBase)) return { verdict: 'shallow', why: 'zombies climb out along the bottom' }
  let wet = false
  for (let x = L.x - R; x <= L.x + R && !wet; x++) {
    for (let z = L.z - R; z <= L.z + R && !wet; z++) {
      for (let y = L.y - 3; y <= L.y; y++) if (g.water(x, y, z)) wet = true
    }
  }
  return wet ? { verdict: 'stops', why: 'water stops them' } : { verdict: 'none', why: 'something else stops them' }
}

function waterBy (g, L, side) {
  let count = 0
  for (let along = -3; along <= 3; along++) {
    for (let r = L.half + 1; r <= L.half + 12; r++) {
      const c = wallCell(L, side, r, along)
      for (let y = L.y - 3; y <= L.y; y++) {
        if (g.water(c.x, y, c.z)) { count++; break }
      }
    }
  }
  return count
}

// Going out from the wall, the farthest ground on this line. A hill ends the line there. Water or a hole that never
// reaches land on the far side means there is nowhere for the mobs to come from
function startRing (g, L, side, along) {
  let best = null
  let inGap = false
  for (let r = L.half + 1; r <= L.half + FAR; r++) {
    const c = wallCell(L, side, r, along)
    if (!g.passable(c.x, L.y, c.z) || !g.passable(c.x, L.y + 1, c.z) || g.water(c.x, L.y, c.z)) break
    inGap = !g.floor(c.x, L.y - 1, c.z)
    if (!inGap) best = r
  }
  return inGap || best === null || best < L.half + 2 ? null : best
}

// One straight line in through a wall: where it starts, the blocks it needs, and a checked walk to the player
function lineOf (g, L, side, along, goal, maxBlocks, openWall) {
  const from = startRing(g, L, side, along)
  if (from === null) return null
  const blocks = []
  const route = []
  const open = []
  const y = L.y
  for (let r = from; r >= L.half - 1; r--) {
    const c = wallCell(L, side, r, along)
    if (r === L.half && openWall) {
      for (let h = 0; h < 3; h++) open.push({ x: c.x, y: y + h, z: c.z })
    } else if (!g.passable(c.x, y, c.z) || !g.passable(c.x, y + 1, c.z) || g.water(c.x, y, c.z)) return null
    if (!g.floor(c.x, y - 1, c.z)) {
      const was = g.water(c.x, y - 1, c.z) ? 'water' : g.name(c.x, y - 1, c.z) === 'air' ? 'air' : null
      if (!was) return null
      blocks.push({ x: c.x, y: y - 1, z: c.z, was })
      if (blocks.length > maxBlocks) return null
    }
    route.push({ x: c.x, y, z: c.z })
  }
  const after = patched(g, blocks, open)
  const target = snap(after, goal.x, goal.y + 1, goal.z)
  if (!target) return null
  const isGoal = (x, py, z) => x === target.x && py === target.y && z === target.z
  if (!reaches(after, [route[0]], L, L.half + FAR + 2, isGoal)) return null
  return { along, from: route[0], route, blocks }
}

function pathOn ({ blockAt, layout: L, side, goal, prefer = 0, maxBlocks = MAX_BLOCKS, openWall = false, grid = null }) {
  const g = grid || gridOf(blockAt)
  const order = [...ALONG].map(a => a + prefer).filter(a => Math.abs(a) <= L.half - 1)
  let best = null
  for (const along of order) {
    const line = lineOf(g, L, side, along, goal, maxBlocks, openWall)
    if (line && (!best || line.blocks.length < best.blocks.length)) best = line
  }
  return best ? { ...best, side } : null
}

// Every wall that can be attacked, driest first, then the fewest blocks to carry
function scoreSides ({ blockAt, layout: L, goal, maxBlocks = MAX_BLOCKS }) {
  const grid = gridOf(blockAt)
  const out = []
  for (const side of SIDES) {
    const path = pathOn({ blockAt, layout: L, side, goal, maxBlocks, openWall: true, grid })
    if (path) out.push({ ...path, water: waterBy(grid, L, side) })
  }
  return out.sort((a, b) => a.water - b.water || a.blocks.length - b.blocks.length || SIDES.indexOf(a.side) - SIDES.indexOf(b.side))
}

// The sides worth offering: nothing much wetter than the driest
const menuSides = sides => sides.filter(s => s.water <= sides[0].water + DRY_MARGIN)

// Natural ground near the start of the path, with nothing on it, off the path and clear of water
function groundSources (blockAt, L, path, n) {
  const g = gridOf(blockAt)
  const y = L.y - 1
  const inner = Math.max(L.half + 3, ringOf(L, path.from.x, path.from.z) - 1) // the mobs' side of any water
  const found = []
  for (let dx = -6; dx <= 6; dx++) {
    for (let dz = -6; dz <= 6; dz++) {
      const [x, z] = [path.from.x + dx, path.from.z + dz]
      const name = g.name(x, y, z)
      if (!HOLDABLE.includes(name) || ringOf(L, x, z) < inner) continue
      if (path.route.some(r => Math.abs(r.x - x) <= 1 && Math.abs(r.z - z) <= 1)) continue
      if (!g.passable(x, y + 1, z) || !g.passable(x, y + 2, z) || g.water(x, y + 1, z) || !g.floor(x, y - 1, z)) continue
      if (DIRS.some(([a, b]) => g.water(x + a, y, z + b) || !g.floor(x + a, y, z + b))) continue
      const stand = DIRS.map(([a, b]) => ({ x: x + a, y: y + 1, z: z + b })).find(c => canStand(g, c.x, c.y, c.z) && !g.water(c.x, c.y, c.z))
      if (stand) found.push({ x, y, z, name, stand, far: dx * dx + dz * dz })
    }
  }
  found.sort((a, b) => a.far - b.far)
  const picks = []
  for (const s of found) {
    if (picks.length >= n) break
    const clash = picks.some(p => (p.x === s.stand.x && p.z === s.stand.z) || (p.stand.x === s.x && p.stand.z === s.z))
    if (!clash) picks.push(s)
  }
  return picks
}

// Puts everything the enderman moved back where it came from, unless someone has changed it since
function undoCommands (moved = []) {
  const out = []
  for (const { placed: p, taken: t } of [...moved].reverse()) {
    if (p) out.push(`execute if block ${p.x} ${p.y} ${p.z} minecraft:${t.name} run setblock ${p.x} ${p.y} ${p.z} minecraft:${p.was}`)
    out.push(`execute if block ${t.x} ${t.y} ${t.z} minecraft:air run setblock ${t.x} ${t.y} ${t.z} minecraft:${t.name}`)
  }
  return out
}

// Console calls that stop dead the moment evil is turned off, and never wait forever on a reply
class Guard {
  constructor (host, waitMs = SEND_WAIT_MS) {
    this.host = host
    this.waitMs = waitMs
    this.ended = false
    this.stopped = new Promise((resolve, reject) => { this.stop = reject })
    this.stopped.catch(() => {})
  }

  end () {
    if (this.ended) return
    this.ended = true
    this.stop(STOPPED)
  }

  check () {
    if (this.ended) throw STOPPED
  }

  async send (command) {
    this.check()
    const { timers } = this.host
    let timer
    const late = new Promise((resolve, reject) => {
      timer = timers.setTimeout(() => reject(new Error(`no reply to ${command.split(' ')[0]}`)), this.waitMs)
    })
    try {
      return await Promise.race([this.host.send(command), late, this.stopped])
    } finally {
      timers.clearTimeout(timer)
    }
  }

  async pause (ms) {
    this.check()
    await Promise.race([this.host.sleep(ms), this.stopped])
    this.check()
  }
}

// The enderman's job: one block at a time from the ground to the next gap, standing only on land or what it has placed
class PathBuilder {
  constructor (host, guard, path, sources, { stepMs = STEP_MS } = {}) {
    Object.assign(this, { host, guard, path, stepMs })
    this.sources = [...sources]
  }

  moveTo (c) {
    return this.guard.send(`tp ${ENDERMAN} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`)
  }

  async take () {
    const g = this.guard
    while (this.sources.length) {
      const s = this.sources.shift()
      await this.moveTo(s.stand)
      await g.pause(this.stepMs)
      const at = `${s.x} ${s.y} ${s.z}`
      // written down before the command goes, so a turn-off in the middle still leaves a reset able to put it back
      s.entry = { placed: null, taken: { x: s.x, y: s.y, z: s.z, name: s.name } }
      this.host.carried.push(s.entry)
      await g.send(`execute if block ${at} minecraft:${s.name} run setblock ${at} minecraft:air`)
      if (!/passed/i.test(await g.send(`execute if block ${at} minecraft:air`))) continue
      await g.send(`data modify entity ${ENDERMAN} carriedBlockState set value {Name:"minecraft:${s.name}"}`)
      return s
    }
    return null
  }

  async place (cell, s) {
    const g = this.guard
    const at = `${cell.x} ${cell.y} ${cell.z}`
    s.entry.placed = { x: cell.x, y: cell.y, z: cell.z, was: cell.was }
    await g.send(`execute if block ${at} minecraft:${cell.was} run setblock ${at} minecraft:${s.name}`)
    const ok = /passed/i.test(await g.send(`execute if block ${at} minecraft:${s.name}`))
    await g.send(`data remove entity ${ENDERMAN} carriedBlockState`)
    if (!ok) {
      s.entry.placed = null
      const from = `${s.x} ${s.y} ${s.z}`
      await g.send(`execute if block ${from} minecraft:air run setblock ${from} minecraft:${s.name}`)
      return false
    }
    return true
  }

  // The spot on the path just before this gap: the bank, or the block it placed last
  edgeBefore (b) {
    const { route, from } = this.path
    const i = route.findIndex(c => c.x === b.x && c.z === b.z)
    return i > 0 ? route[i - 1] : from
  }

  // 'done', or 'failed' with whatever is already placed left standing. A turn-off throws out of here at once
  async run () {
    const { blocks } = this.path
    for (let i = 0; i < blocks.length; i++) {
      const s = await this.take()
      if (!s) {
        this.host.log('evil path: no ground left to carry')
        return 'failed'
      }
      this.host.log(`evil path: took ${s.name} at ${s.x} ${s.y} ${s.z}`)
      const b = blocks[i]
      await this.moveTo(this.edgeBefore(b))
      await this.guard.pause(this.stepMs)
      if (!await this.place(b, s)) {
        this.host.log(`evil path: could not place at ${b.x} ${b.y} ${b.z}, block put back`)
        return 'failed'
      }
      this.host.log(`evil path: placed ${i + 1}/${blocks.length} at ${b.x} ${b.y} ${b.z}`)
    }
    return 'done'
  }
}

module.exports = {
  HOLDABLE, MAX_BLOCKS, STOPPED, STEP_MS, SEND_WAIT_MS, ENDERMAN, gridOf, readMoat, scoreSides, pathOn, menuSides, groundSources,
  undoCommands, Guard, PathBuilder
}
