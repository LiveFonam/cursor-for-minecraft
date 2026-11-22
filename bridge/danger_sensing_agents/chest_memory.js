// What the agents remember about chests, per world and dimension: where each one is, what it held and when a bot last
// looked inside. The planner reads this so a bot knows what it can use without walking around opening everything.
// skills/storage.js updates it every time a bot opens, takes from or fills a container. Saved in a small JSON file next
// to the agents' other per-world data. No Minecraft in here, test/chest_memory.test.js runs it offline.

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

const CLOCKWISE = { north: 'east', east: 'south', south: 'west', west: 'north' }
const COUNTER = { north: 'west', west: 'south', south: 'east', east: 'north' }
const STEP = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }

const plain = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
const keyOf = p => `${p.x},${p.y},${p.z}`

// The other half of a double chest from the block's state, or null for a single one
function otherHalf (pos, props) {
  if (!props || !STEP[props.facing] || !['left', 'right'].includes(props.type)) return null
  const dir = props.type === 'left' ? CLOCKWISE[props.facing] : COUNTER[props.facing]
  const [dx, dz] = STEP[dir]
  const p = plain(pos)
  return { x: p.x + dx, y: p.y, z: p.z + dz }
}

// Both halves of a double chest share one record, under the half with the lower coordinates
function canonical (pos, props) {
  const p = plain(pos)
  const other = otherHalf(p, props)
  if (!other) return p
  return (other.x < p.x || (other.x === p.x && other.z < p.z)) ? other : p
}

class ChestMemory {
  constructor (file = null, { now = Date.now, log = () => {} } = {}) {
    this.file = file
    this.now = now
    this.log = log
    this.worlds = {}
    this.load()
  }

  load () {
    if (!this.file) return
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (data && typeof data.worlds === 'object' && data.worlds) this.worlds = data.worlds
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`chest memory: starting empty, could not read it (${err.message})`)
    }
  }

  save () {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ worlds: this.worlds }))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      this.log(`chest memory: could not save (${err.message})`)
    }
  }

  table (world, dimension) {
    const w = this.worlds[world] || (this.worlds[world] = {})
    return w[dimension] || (w[dimension] = {})
  }

  // A bot just saw inside this container. items: Map of name to count
  saw (world, dimension, pos, items, props = null) {
    const p = canonical(pos, props)
    this.table(world, dimension)[keyOf(p)] = { pos: p, items: Object.fromEntries(items), seen: this.now() }
    this.save()
  }

  forget (world, dimension, pos, props = null) {
    const t = this.table(world, dimension)
    const k = keyOf(canonical(pos, props))
    if (!(k in t)) return false
    delete t[k]
    this.save()
    return true
  }

  knows (world, dimension, pos, props = null) {
    return keyOf(canonical(pos, props)) in this.table(world, dimension)
  }

  // Every remembered container here, as { pos, items: Map, seen }
  list (world, dimension) {
    return Object.values(this.table(world, dimension)).map(r => ({
      pos: { ...r.pos },
      items: new Map(Object.entries(r.items || {})),
      seen: r.seen
    }))
  }

  // Drops the ones that are gone. stillThere(pos) is true, false, or null when that spot is not loaded (kept)
  prune (world, dimension, stillThere) {
    const t = this.table(world, dimension)
    let dropped = 0
    for (const [k, r] of Object.entries(t)) {
      if (stillThere(r.pos) === false) {
        delete t[k]
        dropped++
      }
    }
    if (dropped) this.save()
    return dropped
  }
}

// One bot's view of the memory: its current world and dimension filled in, and double chests read from the block
function chestView (memory, bot, worldId, containers) {
  const dim = () => String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '')
  const propsAt = pos => {
    const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
    if (!b || !/chest$/.test(b.name) || typeof b.getProperties !== 'function') return null
    const props = b.getProperties()
    const other = otherHalf(pos, props)
    if (!other) return props
    // only a real second half makes it a double chest
    const twin = bot.blockAt(new Vec3(other.x, other.y, other.z))
    return twin && twin.name === b.name ? props : null
  }
  return {
    saw: (pos, items) => memory.saw(worldId(), dim(), pos, items, propsAt(pos)),
    forget: pos => memory.forget(worldId(), dim(), pos, propsAt(pos)),
    knows: pos => memory.knows(worldId(), dim(), pos, propsAt(pos)),
    list: () => memory.list(worldId(), dim()),
    prune: () => memory.prune(worldId(), dim(), pos => {
      const b = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
      return b ? containers.includes(b.name) : null
    })
  }
}

module.exports = { ChestMemory, chestView, otherHalf, canonical }
