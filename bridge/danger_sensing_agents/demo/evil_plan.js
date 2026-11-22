// The evil god's fixed menu, and what each choice means on the server. The model only ever picks words from this menu.
// Every coordinate and command is worked out here, so nothing the model writes can become a command. The one exception
// is the villain line, which is cut down to plain characters before it goes to chat. The base is read from what
// scene.js builds, so a change to the base changes the plans with it.

const scene = require('./scene')

// Facing a wall from outside, left and right are the creeper's own
const WALLS = Object.freeze({
  north: { x: 0, z: -1 },
  east: { x: 1, z: 0 },
  south: { x: 0, z: 1 },
  west: { x: -1, z: 0 }
})
const OPPOSITE = Object.freeze({ north: 'south', east: 'west', south: 'north', west: 'east' })
const APPROACH = Object.freeze({ left: 2, center: 0, right: -2 })
const SPLITS = Object.freeze(['breach', 'flank', 'wait_rush'])
const MOVES = Object.freeze(['press', 'regroup', 'flank'])
const LINE_MAX = 80
const ALONG = Object.freeze([0, -1, 1, -2, 2, -3, 3]) // where a wave's mobs stand along a wall
const RING = 12 // how far from a player who left the base a wave lands
const STRAY = 32 // a mob further from him than this has lost him
const ZOMBIES = `@e[tag=${scene.TAG_EVIL},type=minecraft:zombie]`
const BOX = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (cobblestone|air)$/
const BLOCK = /^setblock (-?\d+) -?\d+ (-?\d+) ([a-z_]+)/

// Today's scripted breach. It goes through the original command lists, so a fallback plays exactly as it always has
const FALLBACK_PLAN = Object.freeze({ wall: 'east', approach: 'center', zombies: 'breach', line: null, scripted: true })

const compass = (dx, dz) => `${dz < 0 ? 'north' : dz > 0 ? 'south' : ''}${dx < 0 ? 'west' : dx > 0 ? 'east' : ''}` || 'center'
const sideOf = (dx, dz) => Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north')

// The base as scene.js builds it, or null when it is not four plain walls, which means the scripted plan
function layoutOf (stage) {
  let commands
  try { commands = scene.baseCommands(stage) } catch { return null }
  const boxes = commands.map(c => c.match(BOX)).filter(Boolean).map(m => ({ n: m.slice(1, 7).map(Number), block: m[7] }))
  const walls = boxes.filter(b => b.block === 'cobblestone').map(b => b.n)
  if (walls.length !== 4) return null
  const xs = walls.flatMap(n => [n[0], n[3]])
  const ys = walls.flatMap(n => [n[1], n[4]])
  const zs = walls.flatMap(n => [n[2], n[5]])
  const [loX, hiX, loZ, hiZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]
  const half = (hiX - loX) / 2
  if (!Number.isInteger(half) || half !== (hiZ - loZ) / 2 || half < 3) return null
  const x = loX + half
  const z = loZ + half
  // mobs land inside the strip the base clears around itself, so never in a tree or a hill on any side
  const clear = boxes.find(b => b.block === 'air')?.n
  const room = clear ? Math.floor((clear[3] - clear[0]) / 2) : half + 3
  const spawnOut = Math.min(room, half + 3)
  if (spawnOut < half + 2) return null
  const inside = {}
  let door = 'none'
  for (const c of commands) {
    const m = c.match(BLOCK)
    if (!m) continue
    const [dx, dz] = [Number(m[1]) - x, Number(m[2]) - z]
    if (m[3].endsWith('_door')) door = sideOf(dx, dz)
    for (const item of ['bed', 'chest', 'furnace']) {
      if (m[3].endsWith(item) && !inside[item]) inside[item] = compass(dx, dz)
    }
  }
  return { x, y: Math.min(...ys), z, half, height: Math.max(...ys) - Math.min(...ys) + 1, spawnOut, door, inside }
}

function wallPoint (layout, wall, out, along) {
  const n = WALLS[wall]
  const left = { x: -n.z, z: n.x }
  return { x: layout.x + n.x * out + left.x * along + 0.5, y: layout.y, z: layout.z + n.z * out + left.z * along + 0.5 }
}

const summon = (kind, p, tags) => scene.summonCommand(kind, p, tags)

const planLayout = (stage, plan) => plan.scripted ? null : layoutOf(stage)

function creeperCommands (stage, plan) {
  const L = planLayout(stage, plan)
  if (!L) return scene.creeperCommands(stage)
  return [summon('creeper', wallPoint(L, plan.wall, L.spawnOut, APPROACH[plan.approach]), [scene.TAG_EVIL, scene.TAG_EVIL_CREEPER])]
}

function zombieCommands (stage, plan) {
  const L = planLayout(stage, plan)
  if (!L) return scene.zombieCommands(stage)
  const o = APPROACH[plan.approach]
  const spots = plan.zombies === 'flank'
    ? [wallPoint(L, plan.wall, L.spawnOut, o - 1), wallPoint(L, plan.wall, L.spawnOut, o + 1), wallPoint(L, OPPOSITE[plan.wall], L.spawnOut, 0)]
    : [o - 1, o, o + 1].map(along => wallPoint(L, plan.wall, L.spawnOut, along))
  return [...spots.map(p => summon('zombie', p, [scene.TAG_EVIL])),
    `effect give @e[tag=${scene.TAG_EVIL}] minecraft:fire_resistance infinite 0 true`]
}

function igniteCommands (stage, plan) {
  const L = planLayout(stage, plan)
  if (!L) return scene.igniteCommands(stage)
  const p = wallPoint(L, plan.wall, L.half + 1, APPROACH[plan.approach])
  return [
    `tp @e[tag=${scene.TAG_EVIL_CREEPER},limit=1] ${p.x} ${p.y} ${p.z}`,
    `data merge entity @e[tag=${scene.TAG_EVIL_CREEPER},limit=1] {ignited:1b}`
  ]
}

// One point on each side of the middle of a wall, at head height. Air there means the wall has a hole
function wallProbes (L) {
  return Object.keys(WALLS).flatMap(wall => [-2, 0, 2].map(along => {
    const p = wallPoint(L, wall, L.half, along)
    return { wall, x: Math.floor(p.x), y: L.y + 1, z: Math.floor(p.z) }
  }))
}

// The closest wall a raid may breach: when that is the door's wall, the side wall nearer to him
const nearestWall = (player, L) => {
  const side = sideOf(player.x - L.x, player.z - L.z)
  return side === 'south' ? (player.x >= L.x ? 'east' : 'west') : side
}

const isAway = (player, L) => !whereIs(player, null, L).inside

// A spot around the player, on the side the plan names. Flanking spreads the mobs all the way around him
function ringPoint (player, plan, i, n) {
  const dir = WALLS[plan.wall]
  const flank = plan.zombies === 'flank'
  const part = n > 1 ? i / (flank ? n : n - 1) - 0.5 : 0
  const a = Math.atan2(dir.z, dir.x) + (flank ? 2 * Math.PI : Math.PI / 2) * part
  return { x: Math.floor(player.x + RING * Math.cos(a)) + 0.5, y: Math.floor(player.y), z: Math.floor(player.z + RING * Math.sin(a)) + 0.5 }
}

// The ground under a spot away from the base, which nothing has cleared, so a mob never lands inside a hill
const surfaceSummon = (kind, p, tags) =>
  `execute positioned ${p.x} ${p.y} ${p.z} positioned over motion_blocking_no_leaves run ${summon(kind, { x: '~', y: '~', z: '~' }, tags)}`

// Mobs that lost him are put back near him, so a full cap of them far away can never stall the hunt
function regatherCommand (name, player, wall) {
  const p = ringPoint(player, { wall, zombies: 'breach' }, 0, 1)
  return `execute at ${name} run spreadplayers ${p.x} ${p.z} 1 4 false @e[tag=${scene.TAG_EVIL},distance=${STRAY}..]`
}

// A later wave: at the walls while he is inside, around him once he has left
function waveCommands (stage, plan, { player, away, creeper = 0, zombies = 0 }) {
  const L = layoutOf(stage)
  const n = creeper + zombies
  const atWall = i => {
    const flanker = plan.zombies === 'flank' && n > 1 && i === n - 1
    const shift = APPROACH[plan.approach] + (flanker ? 0 : ALONG[i % ALONG.length])
    return wallPoint(L, flanker ? OPPOSITE[plan.wall] : plan.wall, L.spawnOut, Math.max(-L.spawnOut, Math.min(L.spawnOut, shift)))
  }
  const place = (kind, i, tags) => away || !L ? surfaceSummon(kind, ringPoint(player, plan, i, n), tags) : summon(kind, atWall(i), tags)
  const creepers = Array.from({ length: creeper }, (_, i) => place('creeper', i, [scene.TAG_EVIL, scene.TAG_EVIL_CREEPER]))
  const walkers = Array.from({ length: zombies }, (_, i) => place('zombie', creeper + i, [scene.TAG_EVIL]))
  if (zombies) walkers.push(`effect give @e[tag=${scene.TAG_EVIL}] minecraft:fire_resistance infinite 0 true`)
  return { creeper: creepers, zombies: walkers }
}

// A change of plan once the zombies are out: all of them back to the hole, or one around to the far wall
function moveCommands (stage, plan, action) {
  const L = layoutOf(stage)
  if (!L) return []
  if (action === 'regroup') {
    const p = wallPoint(L, plan.wall, L.half + 2, APPROACH[plan.approach])
    return [`tp ${ZOMBIES} ${p.x} ${p.y} ${p.z}`]
  }
  if (action === 'flank') {
    const p = wallPoint(L, OPPOSITE[plan.wall], L.spawnOut, 0)
    return [`tp @e[tag=${scene.TAG_EVIL},type=minecraft:zombie,limit=1,sort=random] ${p.x} ${p.y} ${p.z}`]
  }
  return []
}

// A change of plan before the zombies are out only changes how they will come in
function withMove (plan, action) {
  if (plan.scripted) return plan
  if (action === 'regroup') return { ...plan, zombies: 'breach' }
  if (action === 'flank') return { ...plan, zombies: 'flank' }
  return plan
}

// Plain letters, digits and light punctuation only: no quotes, backslashes, brackets, selectors or color codes
function cleanLine (text) {
  if (typeof text !== 'string') return ''
  const safe = text.replace(/[^A-Za-z0-9 .,!?'-]/g, ' ').replace(/\s+/g, ' ').trim()
  if (safe.length <= LINE_MAX) return safe
  const cut = safe.slice(0, LINE_MAX)
  const space = cut.lastIndexOf(' ')
  return (space > LINE_MAX / 2 ? cut.slice(0, space) : cut).trim()
}

const villainText = line => `Evil god: ${cleanLine(line)}`

function readObject (text, keys) {
  if (typeof text !== 'string') return null
  let data
  try {
    data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const got = Object.keys(data)
  if (got.length !== keys.length || !keys.every(k => got.includes(k))) return null
  return typeof data.line === 'string' ? data : null
}

// The south wall holds the iron door, which stays shut through a raid
const BREACH_WALLS = Object.freeze(Object.keys(WALLS).filter(w => w !== 'south'))
const onMenu = (value, list) => typeof value === 'string' && list.includes(value)

// The opening plan, or null for anything off the menu
function checkPlan (text) {
  const d = readObject(text, ['wall', 'approach', 'zombies', 'line'])
  if (!d) return null
  if (!onMenu(d.wall, BREACH_WALLS) || !onMenu(d.approach, Object.keys(APPROACH)) || !onMenu(d.zombies, SPLITS)) return null
  return { wall: d.wall, approach: d.approach, zombies: d.zombies, line: cleanLine(d.line) || null }
}

// A change of plan, or null for anything off the menu
function checkMove (text) {
  const d = readObject(text, ['action', 'line'])
  if (!d || !onMenu(d.action, MOVES)) return null
  return { action: d.action, line: cleanLine(d.line) || null }
}

// The server's replies, read as numbers only, so no server text ever reaches the model
function parsePos (reply) {
  const m = String(reply).match(/\[(-?[\d.]+)d?, *(-?[\d.]+)d?, *(-?[\d.]+)d?\]/)
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null
}

function parseHealth (reply) {
  const m = String(reply).match(/data: *(-?[\d.]+)f?\s*$/)
  return m ? Number(m[1]) : null
}

function parseCount (reply) {
  const text = String(reply)
  if (/failed/i.test(text)) return 0
  const m = text.match(/count: *(\d+)/i)
  return m ? Number(m[1]) : null
}

function whereIs (pos, health, layout) {
  if (!pos) return null
  const dx = Math.round(pos.x - layout.x)
  const dz = Math.round(pos.z - layout.z)
  return { dx, dz, inside: Math.max(Math.abs(dx), Math.abs(dz)) < layout.half, nearest_wall: sideOf(dx, dz), health }
}

// What the model is told. Only numbers and words from this file, never a name or anything a player typed
function situationOf ({ event, stage, plan, history, player, playerHealth, agent, agentHealth, creeper, zombiesOut, zombies, hunt }) {
  const L = layoutOf(stage)
  if (!L) return null
  const side = 2 * L.half + 1
  return {
    event,
    base: { size: `${side}x${side}, cobblestone walls ${L.height} high`, walls: BREACH_WALLS, door: L.door, inside: L.inside },
    player: whereIs(player, playerHealth, L),
    agent: whereIs(agent, agentHealth, L),
    mobs: { creeper, zombies_out: zombiesOut ? zombies : 0, zombies_waiting: zombiesOut ? 0 : 3 },
    ...(plan && !plan.scripted ? { plan: { wall: plan.wall, approach: plan.approach, zombies: plan.zombies } } : {}),
    so_far: history.slice(-6),
    ...(hunt ? { hunt } : {})
  }
}

module.exports = {
  WALLS, APPROACH, SPLITS, MOVES, LINE_MAX, FALLBACK_PLAN, layoutOf, wallPoint, creeperCommands, zombieCommands, igniteCommands,
  moveCommands, waveCommands, regatherCommand, wallProbes, nearestWall, isAway, withMove, cleanLine, villainText, checkPlan, checkMove, parsePos, parseHealth, parseCount, situationOf
}
