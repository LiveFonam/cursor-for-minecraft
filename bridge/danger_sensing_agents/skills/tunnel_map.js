'use strict'
// What a bot remembers of the tunnels it dug itself, so the next ore trip walks back through them instead of opening a
// new staircase. Straight runs are kept as a start, a step and a length. Nothing here reads the world: the caller checks
// each stretch is still open just before walking it, because a blast, gravel or water can change it.
const { Vec3 } = require('vec3')

const MAX_CELLS = 4000     // the oldest runs are dropped past this
const WALK_S = 0.35        // seconds per block on foot, turns and the odd stop included
const DIG_STEP_S = 2.5     // seconds per staircase step: three blocks dug with a stone or iron pickaxe, and the step
const MAX_APPROACH = 96    // further than this from any tunnel it digs where it stands
const NEAR_WALK = 24       // a walk this short to a tunnel at the right depth always beats opening a new one
const LEVEL_SLACK = 2      // a tunnel this close to the wanted depth counts as being at it
const SPACING = 2          // solid blocks kept between parallel tunnels, the walls of each are already seen

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const dimensionOf = bot => String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '')
const keyOf = (dimension, c) => `${dimension}:${c.x},${c.y},${c.z}`
const left = d => ({ x: d.z, z: -d.x })
const right = d => ({ x: -d.z, z: d.x })

function runCells (run) {
  const cells = []
  for (let i = 0; i < run.len; i++) cells.push(new Vec3(run.x + run.dx * i, run.y + run.dy * i, run.z + run.dz * i))
  return cells
}

const lastCell = run => new Vec3(run.x + run.dx * (run.len - 1), run.y + run.dy * (run.len - 1), run.z + run.dz * (run.len - 1))

function routeOf (node) {
  const route = []
  for (let n = node; n; n = n.prev) route.push(n.cell)
  return route.reverse()
}

class TunnelMap {
  constructor () {
    this.segments = []          // { kind: 'stair' | 'main' | 'branch', dimension, x, y, z, dx, dy, dz, len }
    this.cells = new Map()      // "dimension:x,y,z" to its run
    this.blocked = new Set()    // cells found shut, left out of every route until it digs them again
  }

  // A cell it just dug or stands in at the start of a tunnel, d being the way the tunnel runs
  add (bot, kind, cell, d) {
    const dimension = dimensionOf(bot)
    const k = keyOf(dimension, cell)
    this.blocked.delete(k)
    if (this.cells.has(k)) return
    const dy = kind === 'stair' ? -1 : 0
    const last = this.segments[this.segments.length - 1]
    const follows = last && last.kind === kind && last.dimension === dimension && last.dx === d.x && last.dz === d.z &&
      cell.x === last.x + d.x * last.len && cell.y === last.y + dy * last.len && cell.z === last.z + d.z * last.len
    let run = last
    if (follows) last.len++
    else {
      run = { kind, dimension, x: cell.x, y: cell.y, z: cell.z, dx: d.x, dy, dz: d.z, len: 1 }
      this.segments.push(run)
    }
    this.cells.set(k, run)
    while (this.cells.size > MAX_CELLS && this.segments.length > 1) {
      const old = this.segments.shift()
      for (const c of runCells(old)) this.cells.delete(keyOf(old.dimension, c))
    }
  }

  markBlocked (bot, cell) {
    this.blocked.add(keyOf(dimensionOf(bot), cell))
  }

  nearest (dimension, from) {
    let best = null
    let bestD = Infinity
    for (const run of this.segments) {
      if (run.dimension !== dimension) continue
      for (const c of runCells(run)) {
        if (this.blocked.has(keyOf(dimension, c))) continue
        const d = c.distanceTo(from)
        if (d < bestD) { best = c; bestD = d }
      }
    }
    return best
  }

  // Every remembered cell it can walk to from start, with the step count and the way back
  reach (dimension, start) {
    const first = { cell: start, prev: null, d: 0 }
    const seen = new Map([[keyOf(dimension, start), first]])
    const queue = [first]
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i]
      for (const [dx, dz] of SIDES) {
        for (const dy of [-1, 0, 1]) {
          const c = n.cell.offset(dx, dy, dz)
          const k = keyOf(dimension, c)
          if (seen.has(k) || !this.cells.has(k) || this.blocked.has(k)) continue
          const m = { cell: c, prev: n, d: n.d + 1 }
          seen.set(k, m)
          queue.push(m)
        }
      }
    }
    return seen
  }

  // Digging this cell, heading along d, would only show rock an old tunnel already showed
  oldRock (bot, cell, d) {
    const dimension = dimensionOf(bot)
    if (this.cells.has(keyOf(dimension, cell))) return true
    const known = c => [-1, 0, 1].some(dy => this.cells.has(keyOf(dimension, c.offset(0, dy, 0))))
    const s = right(d)
    for (let n = 1; n <= SPACING; n++) {
      if (known(cell.offset(d.x * n, 0, d.z * n)) || known(cell.offset(s.x * n, 0, s.z * n)) || known(cell.offset(-s.x * n, 0, -s.z * n))) return true
    }
    return false
  }

  // The way on from a cell into rock it has not seen: straight on if it can, else a turn. Null when all of it is old
  freshDir (bot, cell, d) {
    for (const t of [d, left(d), right(d)]) {
      if (!this.oldRock(bot, cell.offset(t.x, 0, t.z), t)) return t
    }
    return null
  }

  // Where to start the next ore trip from. A route to walk with what to do at its end, or { why } to dig right here
  plan (bot, at, wantY) {
    const dimension = dimensionOf(bot)
    const entry = this.nearest(dimension, at)
    if (!entry) return { why: 'no tunnels remembered' }
    const approach = Math.ceil(entry.distanceTo(at))
    if (approach > MAX_APPROACH) return { why: `nearest tunnel is ${approach} blocks away` }
    const nodes = this.reach(dimension, entry)
    const walkS = n => (approach + n.d) * WALK_S
    const digS = y => Math.max(0, y - wantY) * DIG_STEP_S
    const fresh = digS(at.y)

    // a tunnel at the right depth: on from its open end, the main tunnel before a side branch
    let level = null
    for (const run of this.segments) {
      if (run.kind === 'stair' || run.dimension !== dimension) continue
      const end = lastCell(run)
      if (Math.abs(end.y - wantY) > LEVEL_SLACK) continue
      const node = nodes.get(keyOf(dimension, end))
      if (!node) continue
      const dir = this.freshDir(bot, end, { x: run.dx, z: run.dz })
      if (!dir) continue
      const rank = node.d + (run.kind === 'main' ? 0 : 1000)
      if (!level || rank < level.rank) level = { node, dir, run, rank }
    }
    if (level && (walkS(level.node) <= fresh || approach + level.node.d <= NEAR_WALK)) {
      return {
        route: routeOf(level.node),
        end: level.node.cell,
        dir: level.dir,
        phase: 'branch',
        s: level.run.kind === 'main' ? level.run.len - 1 : 0,
        why: `${level.run.kind} tunnel at Y ${level.node.cell.y}, ${level.node.d} blocks along it`
      }
    }

    // none there yet: down what it has, from the deepest point above the wanted depth
    let deep = null
    for (const node of nodes.values()) {
      if (node.cell.y <= wantY || node.cell.y >= at.y) continue
      const stair = this.cells.get(keyOf(dimension, node.cell)).kind === 'stair'
      if (!deep || node.cell.y < deep.node.cell.y || (node.cell.y === deep.node.cell.y && stair && !deep.stair)) deep = { node, stair }
    }
    if (!deep) return { why: 'no remembered tunnel leads lower' }
    const cost = walkS(deep.node) + digS(deep.node.cell.y)
    if (cost >= fresh) return { why: `digging takes ${Math.round(fresh)}s, the old tunnel ${Math.round(cost)}s` }
    const run = this.cells.get(keyOf(dimension, deep.node.cell))
    const along = { x: run.dx, z: run.dz }
    // the step below must not open the floor of a tunnel that carries on ahead
    const dir = [along, left(along), right(along)].find(t => !this.cells.has(keyOf(dimension, deep.node.cell.offset(t.x, 0, t.z)))) || along
    return {
      route: routeOf(deep.node),
      end: deep.node.cell,
      dir,
      phase: 'descend',
      s: 0,
      why: `down from Y ${deep.node.cell.y}, ${Math.round(fresh - cost)}s quicker than a new staircase`
    }
  }

  // A route through the tunnels from near `from` to the cell closest to target, when that ends within endWithin
  routeNear (bot, from, target, { enter = 3, endWithin = 4 } = {}) {
    const dimension = dimensionOf(bot)
    const entry = this.nearest(dimension, from)
    if (!entry || entry.distanceTo(from) > enter) return null
    let best = null
    for (const node of this.reach(dimension, entry).values()) {
      if (!best || node.cell.distanceTo(target) < best.cell.distanceTo(target)) best = node
    }
    return best && best.cell.distanceTo(target) <= endWithin ? routeOf(best) : null
  }
}

module.exports = { TunnelMap, MAX_APPROACH }
