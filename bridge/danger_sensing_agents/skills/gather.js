// Getting the simple raw materials a build or a farm needs, the way a player would: logs from trees it can see,
// cobblestone from stone it can see or from a short staircase down, dirt, sand, coal from ore it can see (the miner
// otherwise), seeds from grass and saplings from leaves. Only blocks it can see from where it stands, the same rule
// as mining, and never a block of the owner's: logs only from natural trees, leaves only natural ones, nothing inside a
// build the agents know about.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goTo } = require('./move')
const { digHazard } = require('../hazards')
const { sleep } = require('./human')
const { pickTool, stepInto, walkOntoDrops } = require('./mine')
const { pickUpDrops } = require('./pickup')
const { canFlow, findKnownOre, preAim, seesBlock, walkCells } = require('./motion')
const { WOODS } = require('./craft')
const { dryFirst, holdsWater, leaveShore, stairIsDry, stepOutToDig } = require('./water')

const SEE = 24
const WANDERS = 6
const DIG_CANCELS = 4   // a block whose dig keeps being canceled is left alone after this many
const LOGS = WOODS.map(w => `${w}_log`)

// item to the blocks that give it
function sourcesFor (item) {
  if (LOGS.includes(item)) return { blocks: [item], cap: 64 }
  if (/_sapling$/.test(item)) return { blocks: [item.replace(/_sapling$/, '_leaves')], cap: 80, leaves: true }
  return {
    cobblestone: { blocks: ['stone'], pickaxe: true, cap: 96 },
    dirt: { blocks: ['dirt', 'grass_block', 'podzol'], cap: 96 },
    sand: { blocks: ['sand'], cap: 96 },
    coal: { blocks: ['coal_ore', 'deepslate_coal_ore'], pickaxe: true, cap: 32 },
    wheat_seeds: { blocks: ['short_grass', 'tall_grass'], cap: 120 }
  }[item] || null
}

// A natural tree's log: going up the trunk it reaches leaves the game placed (persistent false)
function isNaturalLog (bot, pos) {
  let p = pos
  for (let i = 0; i < 32; i++) {
    const up = bot.blockAt(p.offset(0, 1, 0))
    if (!up || !/_log$/.test(up.name)) break
    p = p.offset(0, 1, 0)
  }
  let leaves = 0
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const b = bot.blockAt(p.offset(dx, dy, dz))
        if (b && /_leaves$/.test(b.name) && b.getProperties().persistent === false) leaves++
      }
    }
  }
  return leaves >= 3
}

function isNaturalLeaves (block) {
  return !!block && /_leaves$/.test(block.name) && block.getProperties().persistent === false
}

// Blocks of these names it can see (or that touch it), nearest first, minus avoid(pos)
function visible (bot, names, avoid, { leaves = false, logs = false } = {}) {
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
  // ore is never known just for being close: it has to be in view or remembered
  if (names.some(n => /_ore$/.test(n))) return findKnownOre(bot, ids, SEE).filter(p => !avoid(p)).slice(0, 12)
  const found = bot.findBlocks({ matching: ids, maxDistance: SEE, count: 120 })
  const out = []
  let checks = 0
  for (const pos of found) {
    if (avoid(pos) || bot.agentsKeepBlock?.(pos)) continue
    const b = bot.blockAt(pos)
    if (!b) continue
    if (leaves && !isNaturalLeaves(b)) continue
    if (logs && !isNaturalLog(bot, pos)) continue
    const near = pos.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) <= 4
    if (!near) {
      if (checks++ > 40) break
      if (!seesBlock(bot, b)) continue
    }
    out.push(pos)
    if (out.length >= 12) break
  }
  return out
}

async function collectDrops (bot, pos, token) {
  if (canFlow(bot)) return walkOntoDrops(bot, pos, token || {})
  await pickUpDrops(bot, pos, token, { settleMs: 300 })
}

async function digOne (bot, pos, token, log) {
  const b = bot.blockAt(pos)
  if (!b || b.name === 'air') return false
  const reach = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.4
  if (!reach()) {
    preAim(bot, pos.offset(0.5, 0.5, 0.5))
    try {
      await goTo(bot, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), token, 20000)
    } finally {
      preAim(bot, null)
    }
  }
  if (token?.cancelled) return false
  await stepOutToDig(bot, pos, token, log)
  if (token?.cancelled) return false
  const again = bot.blockAt(pos)
  if (!again || again.name !== b.name) return false
  const pick = pickTool(bot, again)
  if (pick.item && bot.heldItem?.type !== pick.item.type) await bot.equip(pick.item, 'hand')
  await bot.dig(again, true)
  await collectDrops(bot, pos.offset(0.5, 0.5, 0.5), token)
  return true
}

// A short staircase down from where it stands to reach stone (cobblestone on flat ground). Returns blocks dug
async function staircase (bot, item, want, token, log) {
  await leaveShore(bot, token, log)
  if (token?.cancelled) return 0
  const start = bot.entity.position.floored()
  const yaw = bot.entity.yaw
  const ways = [[0, -1], [-1, 0], [0, 1], [1, 0]]
  const facing = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4
  // the way it faces, else a side, else behind it. With water on all four it digs on the way it faces
  const dry = [0, 1, 3, 2].map(t => ways[(facing + t) % 4]).find(([x, z]) => stairIsDry(bot, start, { x, z }))
  const [dx, dz] = dry || ways[facing]
  if (dry && dry !== ways[facing]) log(`${bot.username} water: turning the staircase`)
  const stops = dry ? ['lava', 'water'] : ['lava']
  let feet = start
  let dug = 0
  const walked = [start]
  // a cut block's drop reaches the bag a moment later, so what was cut counts as well as what is held
  const yields = new Set(sourcesFor(item)?.blocks || [])
  const before = count(bot, item)
  let cut = 0
  let lastCut = null
  const enough = () => Math.max(count(bot, item), before + cut) >= want
  for (let step = 0; step < 24 && !token?.cancelled && !enough(); step++) {
    const next = feet.offset(dx, -1, dz)
    for (const p of [next.offset(0, 2, 0), next.offset(0, 1, 0), next]) {
      const b = bot.blockAt(p)
      if (!b) return dug
      if (stops.includes(b.name) || stops.includes(bot.blockAt(p.offset(0, 1, 0))?.name)) return dug
      if (b.boundingBox === 'empty' && b.name !== 'short_grass') continue
      if (dry && holdsWater(bot, p)) return dug
      if (yields.has(b.name) && enough()) break
      const pick = pickTool(bot, b)
      if (pick.error) return dug
      if (pick.item && bot.heldItem?.type !== pick.item.type) await bot.equip(pick.item, 'hand')
      await bot.dig(b, true)
      dug++
      if (yields.has(b.name)) {
        cut++
        lastCut = p
      }
    }
    if (enough()) break
    const floor = bot.blockAt(next.offset(0, -1, 0))
    if (!floor || floor.boundingBox !== 'block') return dug
    try {
      if (canFlow(bot)) await stepInto(bot, next, token || {})
      else await goTo(bot, new goals.GoalBlock(next.x, next.y, next.z), token, 8000)
    } catch (err) {
      log(`${bot.username} staircase: ${err.message}`)
      return dug
    }
    feet = next
    walked.push(next)
    // a staircase dug for stone is a head start for the next ore trip
    if (step === 0) bot._tunnelMap?.add(bot, 'stair', start, { x: dx, z: dz })
    bot._tunnelMap?.add(bot, 'stair', next, { x: dx, z: dz })
  }
  if (lastCut && enough() && !token?.cancelled) {
    await collectDrops(bot, lastCut.offset(0.5, 0.5, 0.5), token)
    for (let i = 0; i < 20 && count(bot, item) < want && !token?.cancelled; i++) await sleep(50)
  }
  // back up the stairs in one walk, the pathfinder if that fails
  if (canFlow(bot) && walked.length > 1) {
    try {
      await walkCells(bot, walked.slice().reverse(), token)
      return dug
    } catch (err) {
      log(`${bot.username} staircase back up: ${err.message}`)
    }
  }
  try { await goTo(bot, new goals.GoalBlock(start.x, start.y, start.z), token, 30000) } catch {}
  return dug
}

function count (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

// Where to walk next to look for a source: 12 to 22 blocks off, within range of where it started. The early walks take
// the best of three directions for staying near the master, the later ones are free so a far source is still found
function wanderPoint (pos, home, { master = null, early = true, range = 48, random = Math.random } = {}) {
  const pick = () => {
    const angle = random() * Math.PI * 2
    const d = 12 + random() * 10
    let x = pos.x + Math.cos(angle) * d
    let z = pos.z + Math.sin(angle) * d
    const off = Math.hypot(x - home.x, z - home.z)
    if (off > range) { x = home.x + (x - home.x) * range / off; z = home.z + (z - home.z) * range / off }
    return { x, z }
  }
  const first = pick()
  if (!master || !early) return first
  const toMaster = p => Math.hypot(p.x - master.x, p.z - master.z)
  return [pick(), pick()].reduce((best, p) => toMaster(p) < toMaster(best) ? p : best, first)
}

// The spots it can see, the cheapest first once the way back to the master counts for half
function preferNearMaster (spots, bot, master) {
  if (!master) return spots
  const cost = p => p.distanceTo(bot.entity.position) + 0.5 * Math.hypot(p.x - master.x, p.z - master.z)
  return spots.slice().sort((a, b) => cost(a) - cost(b))
}

// The farthest and average distance from the master over a run's path, in whole blocks
function masterDistance (path, master) {
  if (!master || !path?.length) return { farthest: null, average: null }
  let farthest = 0
  let sum = 0
  for (const p of path) {
    const d = Math.hypot(p.x - master.x, p.z - master.z)
    if (d > farthest) farthest = d
    sum += d
  }
  return { farthest: Math.round(farthest), average: Math.round(sum / path.length) }
}

// Gets want more of item. Returns how many it got. avoid(pos) protects the owner's builds and the site
async function gather (bot, item, want, token, { log = () => {}, say = () => {}, avoid = () => false, mine = null, master = null } = {}) {
  const src = sourcesFor(item)
  if (!src) return 0
  if (src.pickaxe && !bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) {
    say(`I need a pickaxe to get ${item}`)
    return 0
  }
  const startCount = count(bot, item)
  const target = startCount + want
  const home = bot.entity.position.clone()
  let broken = 0
  let wanders = 0
  const failed = new Set()
  // a block that holds back lava is not worth walking up to
  const skip = p => avoid(p) || failed.has(p.toString()) || !!digHazard(bot, bot.blockAt(p))
  const canceled = new Map()
  while (count(bot, item) < target && !token?.cancelled && broken < src.cap) {
    const spots = dryFirst(bot, preferNearMaster(visible(bot, src.blocks, skip, { leaves: src.leaves, logs: LOGS.includes(item) }), bot, master?.()))
    if (spots.length) {
      try {
        if (await digOne(bot, spots[0], token, log)) broken++
      } catch (err) {
        log(`${bot.username} gather ${item}: ${err.message}`)
        // a canceled dig says nothing about the block, so it is tried again
        const at = spots[0].toString()
        canceled.set(at, (canceled.get(at) || 0) + 1)
        if (!/aborted/i.test(err.message) || canceled.get(at) >= DIG_CANCELS) failed.add(at)
        else await sleep(100)
      }
      continue
    }
    if (item === 'cobblestone' && wanders >= 1) {
      try {
        broken += await staircase(bot, item, target, token, log)
      } catch (err) {
        if (!/aborted/i.test(err.message)) throw err
        log(`${bot.username} staircase: ${err.message}`)
      }
      if (count(bot, item) < target && wanders >= WANDERS) break
    }
    if (item === 'coal' && mine && wanders >= 2) {
      await mine(['coal_ore', 'deepslate_coal_ore'], target - count(bot, item), token)
      break
    }
    if (wanders === 0) log(`${bot.username} sees no ${item} source it can reach within ${SEE} blocks, walking to look`)
    if (wanders++ >= WANDERS) break
    // walk a little way and look again, staying within 48 blocks of where it started
    const { x, z } = wanderPoint(bot.entity.position, home, { master: master?.(), early: wanders <= WANDERS / 2 })
    try {
      await goTo(bot, new goals.GoalNearXZ(x, z, 3), token, 20000)
    } catch (err) {
      log(`${bot.username} gather walk: ${err.message}`)
    }
  }
  const got = count(bot, item) - startCount
  log(`${bot.username} gathered ${got} ${item} (${broken} blocks broken, ${wanders} walks)`)
  return got
}

// Fills empty buckets from water it can see within 32 blocks. Returns how many it filled
async function fillBuckets (bot, want, token, { avoid = () => false } = {}) {
  let filled = 0
  for (let i = 0; i < want && !token?.cancelled; i++) {
    const bucket = bot.inventory.items().find(it => it.name === 'bucket')
    if (!bucket) break
    const id = bot.registry.blocksByName.water.id
    const spots = bot.findBlocks({ matching: b => b.type === id && Number(b.getProperties().level) === 0, maxDistance: 32, count: 40 })
      .filter(p => !avoid(p) && bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty')
    const pos = spots.find(p => bot.canSeeBlock(bot.blockAt(p)))
    if (!pos) break
    await goTo(bot, new goals.GoalNear(pos.x, pos.y + 1, pos.z, 2), token, 20000)
    const before = count(bot, 'water_bucket')
    await bot.equip(bucket, 'hand')
    await bot.lookAt(pos.offset(0.5, 0.9, 0.5), true)
    await bot.waitForTicks(2)
    bot.activateItem()
    await bot.waitForTicks(4)
    if (count(bot, 'water_bucket') > before) filled++
    else break
  }
  return filled
}

module.exports = { gather, wanderPoint, preferNearMaster, masterDistance, sourcesFor, isNaturalLog, isNaturalLeaves, visible, collectDrops, fillBuckets, count, LOGS }
