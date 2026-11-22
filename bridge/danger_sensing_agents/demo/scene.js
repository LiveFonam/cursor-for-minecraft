// What the demo asks of the server, as plain command lists, so all of it can be checked without one.

const KEEP_HOSTILE = Object.freeze(['zombie', 'skeleton', 'enderman', 'creeper'])
// listed as hostile in the game data but not mobs to clear: a block-like entity, and a harmless nether animal
const NOT_CLEARED = new Set(['end_crystal', 'strider'])
// hostile in the game, filed under animals in the data
const ALSO_HOSTILE = Object.freeze(['zombie_nautilus'])

const TAG_EVIL = 'demo_evil'
const TAG_EVIL_CREEPER = 'demo_evil_creeper'
const TAG_FORCED = 'demo_forced'
const TAG_BODY = 'demo_body'
const DEATHS = 'demo_deaths'

const ARENA_Y = 100
const ARENA_HALF = 10
const ARENA_EAST = 200
const ARENA_TILE = 4             // 5 by 5 floor squares
const ARENA_TILES = ['yellow_concrete', 'black_concrete']
const FIGHT_START = 5
const BASE_WEST = 16
const BASE_HALF = 4
const WALL_HEIGHT = 3
const CLEAN_RADIUS = 64
const CLEAR_HEIGHT = 12         // a whole oak, so no crown is left floating over the plot
const PILLAR_BLOCK = 'gray_concrete'
const PILLAR_HEIGHT = 3         // too tall to jump over, and it stops a crossbow bolt
const PILLAR_SIZES = Object.freeze([[1, 2], [2, 1], [1, 3], [3, 1], [2, 2]])
const PILLAR_FROM_EDGE = 2      // room to walk between a pillar and the arena wall
const PILLAR_FROM_SPAWN = 3     // open blocks kept on every side of a spawn spot
const PILLAR_GAP = 2            // open blocks between two pillars, so nobody gets wedged

// What !chest puts in the base chest: a diamond pickaxe's diamonds and sticks, and the planks for a crafting table
const CHEST_STOCK = Object.freeze([['diamond', 3], ['stick', 2], ['oak_planks', 4]])
const FIGHT_KIT = Object.freeze([
  ['armor.head', 'diamond_helmet'], ['armor.chest', 'diamond_chestplate'], ['armor.legs', 'diamond_leggings'],
  ['armor.feet', 'diamond_boots'], ['hotbar.0', 'diamond_axe'], ['hotbar.1', 'diamond_sword'],
  ['weapon.offhand', 'shield'], ['hotbar.2', 'crossbow'], ['hotbar.3', 'bow'], ['inventory.0', 'arrow 6']
])

// The player's kit in a 1v1: the crossbow comes loaded, which is his head start, then the axe, sword and bow
const PLAYER_KIT = Object.freeze([
  ['armor.head', 'diamond_helmet'], ['armor.chest', 'diamond_chestplate'], ['armor.legs', 'diamond_leggings'],
  ['armor.feet', 'diamond_boots'], ['weapon.offhand', 'shield'],
  ['hotbar.0', 'crossbow[charged_projectiles=[{id:"minecraft:arrow",count:1}]]'],
  ['hotbar.1', 'diamond_axe'], ['hotbar.2', 'diamond_sword'], ['hotbar.3', 'bow'], ['inventory.0', 'arrow 5']
])

function hostileToRemove (version = '1.21.11') {
  const data = require('minecraft-data')(version)
  const names = data.entitiesArray.filter(e => e.type === 'hostile' || /hostile/i.test(e.category || '')).map(e => e.name)
  return [...new Set([...names, ...ALSO_HOSTILE])].filter(n => !KEEP_HOSTILE.includes(n) && !NOT_CLEARED.has(n)).sort()
}

// The rule names changed across versions, so each is set under both: the name a server does not know is refused
const WORLD_RULES = Object.freeze([
  'difficulty normal',
  'gamerule immediate_respawn true', 'gamerule doImmediateRespawn true',
  'gamerule spawn_mobs true', 'gamerule doMobSpawning true'
])
const GRIEF_RULES = Object.freeze(['gamerule mob_griefing true', 'gamerule mobGriefing true'])

const purgeCommands = names => names.map(n => `kill @e[type=minecraft:${n}]`)

// Where everyone stands, all inside the base: he looks east at the agent, the agent looks back at him
const spots = s => {
  const b = baseOf(s)
  return {
    player: { x: b.x - 2, y: b.y, z: b.z },
    hand: { x: b.x, y: b.y, z: b.z },       // where the agent comes back to, to hand the item over
    agent: { x: b.x + 1, y: b.y, z: b.z }
  }
}
const at = p => `${p.x} ${p.y} ${p.z}`
const middleOf = p => `${p.x + 0.5} ${p.y} ${p.z + 0.5}`
const baseOf = s => ({ x: s.x - BASE_WEST, y: s.y, z: s.z })
const arenaOf = s => ({ x: s.x + ARENA_EAST, y: ARENA_Y, z: s.z, half: ARENA_HALF })

function agentKitCommands (name) {
  return [
    `clear ${name}`,
    `effect clear ${name}`,
    `item replace entity ${name} hotbar.0 with stone_axe`,
    `item replace entity ${name} weapon.offhand with shield`,
    `item replace entity ${name} hotbar.8 with bread 6`,
    `effect give ${name} instant_health 1 3 true`,
    `effect give ${name} saturation 1 20 true`
  ]
}

// Takes the evil base and whatever a blast did back out of the ground
function clearBaseCommands (s) {
  const b = baseOf(s)
  const r = BASE_HALF + 3
  const box = (y1, y2, block, how = '') => `fill ${b.x - r} ${y1} ${b.z - r} ${b.x + r} ${y2} ${b.z + r} ${block}${how}`
  return [box(b.y, b.y + CLEAR_HEIGHT, 'air'), box(b.y - 4, b.y - 2, 'dirt', ' replace air'), box(b.y - 1, b.y - 1, 'grass_block', ' replace air')]
}

function resetCommands (settings, stage, { stocked = false } = {}) {
  const p = spots(stage)
  const near = `x=${stage.x},y=${stage.y},z=${stage.z},distance=..${CLEAN_RADIUS}`
  return [
    'time set day',
    'weather clear',
    `kill @e[tag=${TAG_EVIL}]`,
    `kill @e[tag=${TAG_FORCED}]`,
    REMOVE_BODY,
    ...KEEP_HOSTILE.map(n => `kill @e[type=minecraft:${n},${near}]`),
    ...baseCommands(stage),
    ...(stocked ? stockCommands(stage) : []),
    `kill @e[type=minecraft:item,${near}]`,
    `kill @e[type=minecraft:experience_orb,${near}]`,
    `kill @e[type=minecraft:arrow,${near}]`,
    `gamemode survival ${settings.agent}`,
    ...agentKitCommands(settings.agent),
    `tp ${settings.agent} ${middleOf(p.agent)} 90 0`,
    `gamemode creative ${settings.player}`,
    `tp ${settings.player} ${middleOf(p.player)} -90 0`
  ]
}

// His body, left standing where he was while he spectates. A display entity, not a login: nothing hurts or pushes it
function bodyCommand (name, p, yaw) {
  return `summon minecraft:mannequin ${p.x} ${p.y} ${p.z} {Tags:["${TAG_BODY}"],NoGravity:1b,Invulnerable:1b,immovable:1b,hide_description:1b,Rotation:[${yaw}f,0f],profile:{name:"${name}"}}`
}
const REMOVE_BODY = `kill @e[tag=${TAG_BODY}]`

// The yaw that looks from p at the agent's start spot
function yawToAgent (stage, p) {
  const a = spots(stage).agent
  return Math.round(Math.atan2(-(a.x + 0.5 - p.x), a.z + 0.5 - p.z) * 180 / Math.PI) + 0
}

// The base as data, for anything that needs to know where its parts are
function baseLayout (stage) {
  const { x, y, z } = baseOf(stage)
  return {
    center: { x, y, z },
    half: BASE_HALF,
    wallTop: y + WALL_HEIGHT - 1,
    bed: [{ x: x - 2, y, z: z - 2 }, { x: x - 1, y, z: z - 2 }],
    chest: { x: x + 2, y, z: z - 2 },
    furnace: { x: x + 2, y, z: z + 2 },
    opening: { from: { x, y, z: z + BASE_HALF }, to: { x, y: y + 1, z: z + BASE_HALF } },
    door: {
      lower: { x, y, z: z + BASE_HALF },
      upper: { x, y: y + 1, z: z + BASE_HALF },
      // both on the wall block beside the door's upper half: a lever that is on powers that block, and it powers the door
      leverWall: { x: x + 1, y: y + 1, z: z + BASE_HALF },
      insideLever: { x: x + 1, y: y + 1, z: z + BASE_HALF - 1 },
      outsideLever: { x: x + 1, y: y + 1, z: z + BASE_HALF + 1 },
      inside: { x, y, z: z + BASE_HALF - 1 },   // where the agent stands to flip a lever, and lands after walking in
      outside: { x, y, z: z + BASE_HALF + 1 }
    },
    ...spots(stage)
  }
}

// The door's place in the south wall, cut after the walls go up
function openingCommand (stage, block) {
  const { from, to } = baseLayout(stage).opening
  return `fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} ${block}`
}

// The levers go off first, so one left on cannot hold the rebuilt door open. The door's lower half goes before its upper
// half: an upper half alone would not last
function doorCommands (stage) {
  const d = baseLayout(stage).door
  const door = (p, half) => `setblock ${at(p)} iron_door[facing=north,half=${half},hinge=left,open=false,powered=false]`
  return [
    `setblock ${at(d.insideLever)} lever[face=wall,facing=north,powered=false]`,
    `setblock ${at(d.outsideLever)} lever[face=wall,facing=south,powered=false]`,
    door(d.lower, 'lower'),
    door(d.upper, 'upper')
  ]
}

// !evil shuts the door, so the creeper has to breach a wall
const sealCommands = stage => doorCommands(stage)

function stockCommands (stage) {
  const c = baseLayout(stage).chest
  return CHEST_STOCK.map(([item, n], i) => `item replace block ${c.x} ${c.y} ${c.z} container.${i} with minecraft:${item} ${n}`)
}

// Kept loaded, so the base can be reset and stocked wherever the player and the agent have gone
function baseChunks (stage) {
  const { x, z } = baseOf(stage)
  const r = BASE_HALF + 3
  return `${x - r} ${z - r} ${x + r} ${z + r}`
}

function baseCommands (stage) {
  const { x, y, z } = baseOf(stage)
  const h = BASE_HALF
  const top = y + WALL_HEIGHT - 1
  return [
    ...clearBaseCommands(stage),
    `fill ${x - h} ${y} ${z - h} ${x + h} ${top} ${z - h} cobblestone`,
    `fill ${x - h} ${y} ${z + h} ${x + h} ${top} ${z + h} cobblestone`,
    `fill ${x - h} ${y} ${z - h} ${x - h} ${top} ${z + h} cobblestone`,
    `fill ${x + h} ${y} ${z - h} ${x + h} ${top} ${z + h} cobblestone`,
    openingCommand(stage, 'air'),
    ...doorCommands(stage),
    `setblock ${x - 2} ${y} ${z - 2} red_bed[facing=east,part=foot]`,
    `setblock ${x - 1} ${y} ${z - 2} red_bed[facing=east,part=head]`,
    `setblock ${x + 2} ${y} ${z - 2} chest[facing=south]`,
    `setblock ${x + 2} ${y} ${z + 2} furnace[facing=west]`
  ]
}

// The demo's zombies carry a wooden axe, which they keep when they die
const ZOMBIE_GEAR = ',equipment:{mainhand:{id:"minecraft:wooden_axe",count:1}},drop_chances:{mainhand:0.0f}'

function summonCommand (kind, p, tags) {
  const list = tags.map(t => `"${t}"`).join(',')
  return `summon minecraft:${kind} ${p.x} ${p.y} ${p.z} {Tags:[${list}],PersistenceRequired:1b${kind === 'zombie' ? ZOMBIE_GEAR : ''}}`
}

// Haste II while the agent is on a task, so the mining moves along in the demo
const hasteCommand = name => `effect give ${name} minecraft:haste infinite 1 true`
const endHasteCommand = name => `effect clear ${name} minecraft:haste`

// The agent back on its spot in the base, facing the player
function agentHomeCommand (name, stage) {
  return `tp ${name} ${middleOf(spots(stage).agent)} 90 0`
}

// sunlight would burn the zombies before they do anything
const fireproof = tag => `effect give @e[tag=${tag}] minecraft:fire_resistance infinite 0 true`

function creeperCommands (stage) {
  const { x, y, z } = baseOf(stage)
  return [summonCommand('creeper', { x: x + BASE_HALF + 5, y, z }, [TAG_EVIL, TAG_EVIL_CREEPER])]
}

function zombieCommands (stage) {
  const { x, y, z } = baseOf(stage)
  const out = x + BASE_HALF + 7
  return [
    summonCommand('zombie', { x: out, y, z: z - 2 }, [TAG_EVIL]),
    summonCommand('zombie', { x: out, y, z }, [TAG_EVIL]),
    summonCommand('zombie', { x: out, y, z: z + 2 }, [TAG_EVIL]),
    fireproof(TAG_EVIL)
  ]
}

// The creeper put against the outside of the east wall and lit, when nothing else got it there
function igniteCommands (stage) {
  const { x, y, z } = baseOf(stage)
  return [
    `tp @e[tag=${TAG_EVIL_CREEPER},limit=1] ${x + BASE_HALF + 1.5} ${y} ${z + 0.5}`,
    `data merge entity @e[tag=${TAG_EVIL_CREEPER},limit=1] {ignited:1b}`
  ]
}

// A flat 20 by 20 arena. Barrier is the real wall and glass one block outside shows where it ends. Both fighters are in
// adventure mode with nothing that can break or place a block, so the floor stays as it is
function arenaCommands (stage) {
  const a = arenaOf(stage)
  const lo = { x: a.x - a.half, z: a.z - a.half }
  const hi = { x: a.x + a.half - 1, z: a.z + a.half - 1 }
  const y = a.y
  const out = [
    `fill ${lo.x - 1} ${y - 1} ${lo.z - 1} ${hi.x + 1} ${y + 5} ${hi.z + 1} barrier hollow`,
    `fill ${lo.x} ${y - 2} ${lo.z} ${hi.x} ${y - 2} ${hi.z} stone`,
    `fill ${lo.x} ${y} ${lo.z} ${hi.x} ${y + 4} ${hi.z} air`
  ]
  for (let i = 0; i * ARENA_TILE < a.half * 2; i++) {
    for (let j = 0; j * ARENA_TILE < a.half * 2; j++) {
      const x = lo.x + i * ARENA_TILE
      const z = lo.z + j * ARENA_TILE
      out.push(`fill ${x} ${y - 1} ${z} ${x + ARENA_TILE - 1} ${y - 1} ${z + ARENA_TILE - 1} ${ARENA_TILES[(i + j) % 2]}`)
    }
  }
  const [x0, x1, z0, z1] = [lo.x - 2, hi.x + 2, lo.z - 2, hi.z + 2]
  out.push(`fill ${x0} ${y - 1} ${z0} ${x1} ${y + 5} ${z0} glass`, `fill ${x0} ${y - 1} ${z1} ${x1} ${y + 5} ${z1} glass`,
    `fill ${x0} ${y - 1} ${z0} ${x0} ${y + 5} ${z1} glass`, `fill ${x1} ${y - 1} ${z0} ${x1} ${y + 5} ${z1} glass`)
  return out
}

function arenaChunks (stage) {
  const a = arenaOf(stage)
  return `${a.x - a.half - 2} ${a.z - a.half - 2} ${a.x + a.half + 1} ${a.z + a.half + 1}`
}

function fighterKitCommands (name, spot, yaw, kit = FIGHT_KIT) {
  return [
    `gamemode adventure ${name}`,
    `clear ${name}`,
    `effect clear ${name}`,
    ...kit.map(([slot, item]) => `item replace entity ${name} ${slot} with ${item}`),
    `effect give ${name} instant_health 1 3 true`,
    `effect give ${name} saturation 1 20 true`,
    `tp ${name} ${spot.x} ${spot.y} ${spot.z} ${yaw} 0`
  ]
}

function duelSpots (stage) {
  const a = arenaOf(stage)
  return {
    player: { x: a.x - FIGHT_START + 0.5, y: a.y, z: a.z + 0.5, yaw: -90 },
    fighter: { x: a.x + FIGHT_START + 0.5, y: a.y, z: a.z + 0.5, yaw: 90 }
  }
}

// How many open blocks lie between two footprints, on the axis where they are furthest apart. Touching is 0
function blocksBetween (a, b) {
  return Math.max(a.x1 - b.x2, b.x1 - a.x2, a.z1 - b.z2, b.z1 - a.z2) - 1
}

// The same pillar on the other side of the arena's middle, so neither fighter's side is better
function mirrorPillar (a, p) {
  const [sx, sz] = [2 * a.x - 1, 2 * a.z - 1]
  return { x1: sx - p.x2, x2: sx - p.x1, z1: sz - p.z2, z2: sz - p.z1 }
}

// Every place a pillar of this size can stand with its mirror, clear of the walls, both spawns and the pillars so far
function pillarPlaces (stage, [w, d], taken) {
  const a = arenaOf(stage)
  const spawns = Object.values(duelSpots(stage)).map(s => {
    const [x, z] = [Math.floor(s.x), Math.floor(s.z)]
    return { x1: x, x2: x, z1: z, z2: z }
  })
  const out = []
  for (let x1 = a.x - a.half + PILLAR_FROM_EDGE; x1 + w - 1 <= a.x + a.half - 1 - PILLAR_FROM_EDGE; x1++) {
    for (let z1 = a.z - a.half + PILLAR_FROM_EDGE; z1 + d - 1 <= a.z + a.half - 1 - PILLAR_FROM_EDGE; z1++) {
      const pillar = { x1, x2: x1 + w - 1, z1, z2: z1 + d - 1 }
      const mirror = mirrorPillar(a, pillar)
      if (blocksBetween(pillar, mirror) < PILLAR_GAP) continue
      if ([pillar, mirror].some(p => spawns.some(s => blocksBetween(p, s) < PILLAR_FROM_SPAWN))) continue
      if ([pillar, mirror].some(p => taken.some(t => blocksBetween(p, t) < PILLAR_GAP))) continue
      out.push(pillar)
    }
  }
  return out
}

// Fresh cover for one fight: 1 or 2 pairs of solid pillars, each pair mirrored across the arena's middle
function pillarLayout (stage, rng = Math.random) {
  const a = arenaOf(stage)
  const pick = list => list[Math.min(list.length - 1, Math.floor(rng() * list.length))]
  const pairs = rng() < 0.5 ? 1 : 2
  const out = []
  for (let i = 0; i < pairs; i++) {
    const places = pillarPlaces(stage, pick(PILLAR_SIZES), out)
    if (!places.length) break
    const pillar = pick(places)
    out.push(pillar, mirrorPillar(a, pillar))
  }
  return out
}

const pillarFill = (stage, p, block) => {
  const y = arenaOf(stage).y
  return `fill ${p.x1} ${y} ${p.z1} ${p.x2} ${y + PILLAR_HEIGHT - 1} ${p.z2} ${block}`
}
const pillarCommands = (stage, pillars) => pillars.map(p => pillarFill(stage, p, PILLAR_BLOCK))
const pillarClearCommands = (stage, pillars) => pillars.map(p => pillarFill(stage, p, 'air'))

// A place by the agent where a mob fits: two free blocks over solid ground, closest ring first
function openSpot (blockAt, pos, { near = 4, far = 8, drop = 2 } = {}) {
  const fx = Math.floor(pos.x)
  const fy = Math.floor(pos.y)
  const fz = Math.floor(pos.z)
  const free = (x, y, z) => blockAt(x, y, z)?.boundingBox === 'empty'
  const solid = (x, y, z) => blockAt(x, y, z)?.boundingBox === 'block'
  for (let r = near; r <= far; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        for (let i = 0; i <= drop * 2; i++) {
          const dy = i % 2 ? (i + 1) / 2 : -i / 2
          const [x, y, z] = [fx + dx, fy + dy, fz + dz]
          if (solid(x, y - 1, z) && free(x, y, z) && free(x, y + 1, z)) return { x: x + 0.5, y, z: z + 0.5 }
        }
      }
    }
  }
  return null
}

function forcedCommands (kind, spot) {
  return [summonCommand(kind, spot, [TAG_FORCED]), fireproof(TAG_FORCED)]
}

const parseScore = reply => {
  const m = String(reply).match(/has (\d+) \[/)
  return m ? Number(m[1]) : 0
}

// A health score, or null when the server has none yet: unknown is not the same as dead
const parseHealth = reply => {
  const m = String(reply).match(/has (\d+) \[/)
  return m ? Number(m[1]) : null
}

module.exports = {
  TAG_BODY, REMOVE_BODY, bodyCommand, yawToAgent, CHEST_STOCK, baseLayout, baseChunks, stockCommands, sealCommands, doorCommands,
  WORLD_RULES, GRIEF_RULES, KEEP_HOSTILE, TAG_EVIL, TAG_EVIL_CREEPER, TAG_FORCED, DEATHS, FIGHT_KIT, PLAYER_KIT,
  hostileToRemove, purgeCommands, spots, at, baseOf, arenaOf, agentKitCommands, resetCommands, baseCommands,
  creeperCommands, zombieCommands, igniteCommands, arenaCommands, arenaChunks, fighterKitCommands, duelSpots, openSpot, forcedCommands,
  parseScore, parseHealth, summonCommand, agentHomeCommand, hasteCommand, endHasteCommand, pillarLayout, pillarCommands, pillarClearCommands,
  mirrorPillar, blocksBetween, PILLAR_BLOCK, PILLAR_HEIGHT, PILLAR_FROM_EDGE, PILLAR_FROM_SPAWN, PILLAR_GAP
}
