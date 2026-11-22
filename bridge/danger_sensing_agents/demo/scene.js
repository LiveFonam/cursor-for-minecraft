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
const FIGHT_START = 6
const BASE_WEST = 16
const BASE_HALF = 4
const WALL_HEIGHT = 3
const CLEAN_RADIUS = 64
const CLEAR_HEIGHT = 12         // a whole oak, so no crown is left floating over the plot

const PLACE_ON = '["yellow_concrete","black_concrete","stone_bricks","cobblestone"]'
// What !chest puts in the base chest: a diamond pickaxe's diamonds and sticks, and the planks for a crafting table
const CHEST_STOCK = Object.freeze([['diamond', 3], ['stick', 2], ['oak_planks', 4]])
const FIGHT_KIT = Object.freeze([
  ['armor.head', 'diamond_helmet'], ['armor.chest', 'diamond_chestplate'], ['armor.legs', 'diamond_leggings'],
  ['armor.feet', 'diamond_boots'], ['hotbar.0', 'diamond_axe'], ['hotbar.1', 'diamond_sword'],
  ['weapon.offhand', 'shield'], ['hotbar.2', 'crossbow'], ['hotbar.3', 'bow'], ['inventory.0', 'arrow 6'],
  ['hotbar.5', `cobblestone[can_place_on=[{blocks:${PLACE_ON}}]] 64`],
  ['hotbar.6', `lava_bucket[can_place_on=[{blocks:${PLACE_ON}}]]`]
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
    `item replace entity ${name} hotbar.0 with diamond_axe`,
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
    opening: { from: { x: x - 1, y, z: z + BASE_HALF }, to: { x, y: y + 1, z: z + BASE_HALF } },
    ...spots(stage)
  }
}

// The gap in the south wall the agent walks out of
function openingCommand (stage, block) {
  const { from, to } = baseLayout(stage).opening
  return `fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} ${block}`
}

// !evil closes the gap, so the creeper has a wall to breach
const sealCommands = stage => [openingCommand(stage, 'cobblestone')]

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

function arenaCommands (stage) {
  const a = arenaOf(stage)
  const lo = { x: a.x - a.half, z: a.z - a.half }
  const hi = { x: a.x + a.half - 1, z: a.z + a.half - 1 }
  const y = a.y
  return [
    `fill ${lo.x - 1} ${y - 1} ${lo.z - 1} ${hi.x + 1} ${y + 5} ${hi.z + 1} barrier hollow`,
    `fill ${lo.x} ${y - 2} ${lo.z} ${hi.x} ${y - 2} ${hi.z} stone`,
    `fill ${lo.x} ${y - 1} ${lo.z} ${hi.x} ${y - 1} ${hi.z} stone_bricks`,
    `fill ${lo.x} ${y} ${lo.z} ${hi.x} ${y + 4} ${hi.z} air`
  ]
}

function arenaChunks (stage) {
  const a = arenaOf(stage)
  return `${a.x - a.half - 1} ${a.z - a.half - 1} ${a.x + a.half} ${a.z + a.half}`
}

function fighterKitCommands (name, spot, yaw) {
  return [
    `gamemode adventure ${name}`,
    `clear ${name}`,
    `effect clear ${name}`,
    ...FIGHT_KIT.map(([slot, item]) => `item replace entity ${name} ${slot} with ${item}`),
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

module.exports = {
  TAG_BODY, REMOVE_BODY, bodyCommand, yawToAgent, CHEST_STOCK, baseLayout, baseChunks, stockCommands, sealCommands,
  WORLD_RULES, GRIEF_RULES, KEEP_HOSTILE, TAG_EVIL, TAG_EVIL_CREEPER, TAG_FORCED, DEATHS, FIGHT_KIT,
  hostileToRemove, purgeCommands, spots, at, baseOf, arenaOf, agentKitCommands, resetCommands, baseCommands,
  creeperCommands, zombieCommands, igniteCommands, arenaCommands, arenaChunks, fighterKitCommands, duelSpots, openSpot, forcedCommands,
  parseScore, summonCommand, agentHomeCommand
}
