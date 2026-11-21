'use strict'

// The crafter: one requested item from the real bag to the player's hands.
// It plans with crafter-plan.js, gathers what is missing with the gather and
// mine skills, waits for the player to hand over the rest, smelts raw iron in a
// furnace, and drops the finished item at the player's feet.

const { Vec3 } = require('vec3')
const { planItem, describeMissing, label } = require('./crafter-plan')
const { ensureTable, findTable } = require('./craft')
const { countItem, findItem, equipItem } = require('./inventory')
const { goNear } = require('./move')
const { gather } = require('./gather')
const { mine, newProgress, resolveMineTarget } = require('./mine')
const { settle, sleep, throwIfAborted } = require('./abort')

const STATION_RANGE = 32
const GIVE_RANGE = 48
const SMELT_MS = 10000

// Where each base material comes from: logs are gathered from trees, the rest
// is mined (cobblestone from stone).
const SOURCES = {
  cobblestone: { mine: 'stone' },
  cobbled_deepslate: { mine: 'deepslate' },
  raw_iron: { mine: 'iron' },
  coal: { mine: 'coal' },
  diamond: { mine: 'diamond' }
}

function bag (bot) {
  const counts = new Map()
  for (const item of bot.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
  return counts
}

function findStation (bot, name) {
  const id = bot.registry.blocksByName[name]?.id
  if (id === undefined) return null
  return bot.findBlock({ matching: id, maxDistance: STATION_RANGE })
}

// The plan from the bag as it is now. Copies of the item it already holds are
// its own (a miner keeps its pickaxe), so the plan makes a new one.
function planNow (bot, job) {
  const have = bag(bot)
  have.delete(job.item)
  return planItem(bot.registry, job.item, have, {
    tableNear: Boolean(findTable(bot)),
    furnaceNear: Boolean(findStation(bot, 'furnace'))
  })
}

// Mineflayer's copy of the bag can fall behind the server after crafting.
// A resync asks the server for the whole window again.
async function resync (bot) {
  if (typeof bot._syncWindow !== 'function') return
  await Promise.race([bot._syncWindow(bot.inventory).catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))])
}

// Asks the gatherer side of this same bot for each missing material once.
// Returns what it could not get.
async function gatherMissing (ctx, missing, signal) {
  const { bot } = ctx
  for (const [name, count] of missing) {
    throwIfAborted(signal)
    const source = SOURCES[name] ?? (name.endsWith('_log') ? { gather: name } : null)
    if (!source) continue
    try {
      if (source.gather) {
        await gather(bot, { blockNames: [source.gather], itemNames: [name], count, movements: ctx.movements.safe, signal })
      } else {
        const target = resolveMineTarget(bot.registry, source.mine)
        if (target) await mine(bot, { ...target, items: [name] }, count, { movements: ctx.movements.dig, signal, progress: newProgress() })
      }
    } catch (err) {
      if (err.name === 'AbortedError') throw err
      ctx.log(`gather ${name} for the crafter: ${err.message}`)
    }
  }
}

async function syncWindow (bot, window) {
  if (typeof bot._syncWindow !== 'function') return
  await Promise.race([bot._syncWindow(window).catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))])
}

// Puts back whatever a refused craft left in the bag's own 2 by 2 grid. Those
// slots are not part of the bag a plan counts, so a log stuck there is lost.
async function clearGrid (bot) {
  if (typeof bot.clickWindow !== 'function' || !bot.inventory.slots) return
  await syncWindow(bot, bot.inventory)
  for (let slot = 1; slot <= 4; slot++) {
    if (bot.inventory.slots[slot]) await bot.clickWindow(slot, 0, 1).catch(() => {})
  }
}

// One craft the way a player does it: open the grid, wait for the server's copy
// of the window, one item per cell, then shift click the result. Mineflayer's
// bot.craft sends every click at once and takes the result from its own guess;
// on the 1.21.4 server that left a log in the grid and made nothing.
async function craftOnceByHand (bot, recipe, table) {
  const width = table ? 3 : 2
  const cells = recipe.inShape
    ? recipe.inShape.flatMap((row, y) => row.map((ingredient, x) => ({ ingredient, slot: 1 + x + width * y })))
    : recipe.ingredients.map((ingredient, i) => ({ ingredient, slot: 1 + (i % width) + width * Math.floor(i / width) }))
  const window = table ? await bot.openBlock(table) : bot.inventory
  try {
    await syncWindow(bot, window)
    const putBack = () => window.selectedItem ? bot.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window, null) : null
    for (const { ingredient, slot } of cells) {
      if (!ingredient || ingredient.id === -1) continue
      if (window.selectedItem?.type !== ingredient.id) {
        await putBack()
        const source = window.findInventoryItem(ingredient.id, null)
        if (!source) throw new Error(`I have no ${bot.registry.items[ingredient.id]?.name}`)
        await bot.clickWindow(source.slot, 0, 0)
      }
      await bot.clickWindow(slot, 1, 0)
      await bot.waitForTicks(1)
    }
    await putBack()
    await bot.waitForTicks(2)
    await syncWindow(bot, window)
    await bot.clickWindow(0, 0, 1)
    await bot.waitForTicks(2)
  } finally {
    if (table) bot.closeWindow(window)
    else await clearGrid(bot)
  }
}

async function craftStep (bot, step, ctx, job, signal) {
  const table = step.needsTable ? await ensureTable(bot, { movements: ctx.movements.safe, signal }) : null
  const id = bot.registry.itemsByName[step.name].id
  const byHand = typeof bot.clickWindow === 'function' && typeof bot.openBlock === 'function'
  for (let i = 0; i < (byHand ? step.batches : 1); i++) {
    throwIfAborted(signal)
    await resync(bot)
    const options = bot.recipesFor(id, null, 1, table)
    // the recipe whose ingredients the plan counted (oak planks, not birch)
    const recipe = options.find(option => (option.delta ?? []).every(entry => entry.count > 0 || step.uses.has(bot.registry.items[entry.id].name))) ?? options[0]
    if (!recipe) throw new Error(`I cannot craft ${label(step.name)} right now`)
    // the craft itself is kept: an abort stops the wait, not the craft on the server
    job.inflight = Promise.resolve(byHand ? craftOnceByHand(bot, recipe, table) : bot.craft(recipe, step.batches, table ?? undefined))
    await settle(job.inflight, { signal, timeoutMs: 30000 })
    job.inflight = null
  }
}

// A furnace in reach, or the one in the bag placed beside the bot
async function ensureFurnace (bot, ctx, signal) {
  const near = findStation(bot, 'furnace')
  if (near) {
    await goNear(bot, near.position, 3, { movements: ctx.movements.safe, signal })
    return bot.blockAt(near.position)
  }
  const item = findItem(bot, 'furnace')
  if (!item) throw new Error('I have no furnace to smelt in')
  const feet = bot.entity.position.floored()
  for (const side of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
    const spot = feet.plus(side)
    if (bot.blockAt(spot)?.name !== 'air' || bot.blockAt(spot.offset(0, -1, 0))?.boundingBox !== 'block') continue
    await equipItem(bot, item)
    await bot.placeBlock(bot.blockAt(spot.offset(0, -1, 0)), new Vec3(0, 1, 0))
    return bot.blockAt(spot)
  }
  throw new Error('No room to place a furnace')
}

// Smelts exactly step.count, then checks the ingots are really in the bag
async function smelt (bot, step, ctx, job, signal) {
  const want = countItem(bot, step.name) + step.count
  const block = await ensureFurnace(bot, ctx, signal)
  job.furnace = block.position
  await resync(bot)
  const reg = bot.registry.itemsByName
  const furnace = await bot.openFurnace(block)
  try {
    const fuels = step.fuel.slice()
    const feed = async () => {
      if (furnace.fuelItem() || !fuels.length) return
      const [name, n] = fuels.shift()
      const have = countItem(bot, name)
      if (have <= 0) throw new Error(`I ran out of ${label(name)} for the furnace`)
      await furnace.putFuel(reg[name].id, null, Math.min(n, have))
    }
    await feed()
    job.smelting = true
    await furnace.putInput(reg[step.input].id, null, step.count)
    // while the furnace is open the bag lives in its window
    const held = () => typeof furnace.count === 'function' ? furnace.count(reg[step.name].id, null) : countItem(bot, step.name)
    const deadline = Date.now() + step.count * SMELT_MS + 20000
    while (held() < want) {
      if (furnace.outputItem()) await furnace.takeOutput()
      await feed()
      if (Date.now() > deadline) throw new Error(`The furnace stopped at ${held()} of ${want} ${label(step.name)}`)
      await sleep(500, signal)
    }
    if (furnace.fuelItem() && !furnace.inputItem()) await furnace.takeFuel()
    job.smelting = false
  } finally {
    furnace.close()
  }
  await resync(bot)
  if (countItem(bot, step.name) < want) throw new Error(`I have ${countItem(bot, step.name)} ${label(step.name)}, I need ${want}`)
}

// What an interrupted smelt left in its furnace goes back in the bag
async function emptyFurnace (bot, ctx, job, signal) {
  if (!job.smelting || !job.furnace) return
  const block = bot.blockAt(job.furnace)
  if (block?.name !== 'furnace') { job.smelting = false; return }
  await goNear(bot, block.position, 3, { movements: ctx.movements.safe, signal })
  const furnace = await bot.openFurnace(block)
  try {
    if (furnace.outputItem()) await furnace.takeOutput()
    if (furnace.inputItem()) await furnace.takeInput()
    if (furnace.fuelItem()) await furnace.takeFuel()
    job.smelting = false
  } finally {
    furnace.close()
  }
}

// Crafting materials lying close by, the ones a player threw over
async function pickUpDrops (bot, ctx, signal) {
  const drops = Object.values(bot.entities ?? {})
    .filter(entity => entity.name === 'item' && entity.position && entity.position.distanceTo(bot.entity.position) <= 6)
  for (const drop of drops) {
    throwIfAborted(signal)
    try { await goNear(bot, drop.position, 0.5, { movements: ctx.movements.safe, signal, timeoutMs: 5000 }) } catch (err) {
      if (err.name === 'AbortedError') throw err
    }
  }
}

// Resolves true when the server says this player picked something up
function pickedUpBy (bot, name, ms) {
  return new Promise(resolve => {
    const onCollect = collector => { if (collector?.username === name) done(true) }
    const timer = setTimeout(() => done(false), ms)
    function done (value) {
      clearTimeout(timer)
      bot.removeListener('playerCollect', onCollect)
      resolve(value)
    }
    bot.on('playerCollect', onCollect)
  })
}

// Walks up to the player and drops the item at their feet. Returns 'given',
// or 'far' when they are out of reach.
async function deliver (bot, ctx, job, signal) {
  const player = bot.players[job.requester]?.entity
  if (!player || player.position.distanceTo(bot.entity.position) > GIVE_RANGE) return 'far'
  try {
    await goNear(bot, player.position, 1, { movements: ctx.movements.safe, signal, timeoutMs: 30000 })
  } catch (err) {
    if (err.name === 'AbortedError') throw err
  }
  const near = bot.players[job.requester]?.entity
  if (!near || near.position.distanceTo(bot.entity.position) > 3.5) return 'far'
  // at their feet from a block away: a level throw flies past them
  await bot.lookAt(near.position.offset(0, 0.2, 0), true)
  await resync(bot)
  const before = countItem(bot, job.item)
  if (before <= 0) return 'given'
  const id = bot.registry.itemsByName[job.item].id
  // set first, so a toss that lands as a fight cuts in is never repeated
  job.given = true
  let caught = false
  for (let tries = 0; tries < 3 && !caught && countItem(bot, job.item) >= before; tries++) {
    const picked = pickedUpBy(bot, job.requester, 4000)
    // the server throws along the facing it last heard, so the turn goes first
    if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(3)
    await bot.toss(id, null, 1)
    // step back, so after the pickup delay the player is the one standing on it
    if (typeof bot.waitForTicks === 'function') {
      bot.setControlState('back', true)
      await bot.waitForTicks(6)
      bot.setControlState('back', false)
    }
    caught = await picked
    await resync(bot)
  }
  if (!caught && countItem(bot, job.item) >= before) {
    job.given = false
    throw new Error(`The server did not take the ${label(job.item)} when I dropped it`)
  }
  return 'given'
}

// One run of a craft job, called again after a fight or a meal with the same
// job object. It returns the message to say when the player has the item.
async function runCrafter (ctx, job, signal) {
  const { bot } = ctx
  // a craft a fight cut short may still be on its way: let it land first
  if (job.inflight) await job.inflight.catch(() => {})
  while (!job.made) {
    throwIfAborted(signal)
    if (job.finalBefore !== undefined) {
      await resync(bot)
      if (countItem(bot, job.item) > job.finalBefore) { job.made = true; break }
    }
    await emptyFurnace(bot, ctx, job, signal)
    await clearGrid(bot)
    if (job.waiting) await pickUpDrops(bot, ctx, signal)
    await resync(bot)
    const plan = planNow(bot, job)
    if (plan.missing.size) {
      const what = describeMissing(plan.missing)
      if (!job.gathered.has(what)) {
        job.gathered.add(what)
        ctx.say(`For the ${label(job.item)} I need ${what}. Gathering it.`)
        await gatherMissing(ctx, plan.missing, signal)
        continue
      }
      if (job.asked !== what) {
        job.asked = what
        ctx.say(`For the ${label(job.item)} I still need ${what}. Bring it to me and I will carry on.`)
      }
      job.waiting = true
      await sleep(1000, signal)
      continue
    }
    job.waiting = false
    for (const step of plan.steps) {
      throwIfAborted(signal)
      if (step.kind === 'smelt') { await smelt(bot, step, ctx, job, signal); continue }
      const final = step.name === job.item
      if (final) job.finalBefore = countItem(bot, job.item)
      await craftStep(bot, step, ctx, job, signal)
      if (final) {
        await resync(bot)
        if (countItem(bot, job.item) > job.finalBefore) job.made = true
        break
      }
    }
    if (!job.made && ++job.passes >= 3) throw new Error(`the crafts ran but I have no ${label(job.item)}`)
  }
  while (!job.given) {
    const result = await deliver(bot, ctx, job, signal)
    if (result === 'given') break
    if (!job.saidReady) {
      job.saidReady = true
      ctx.say(`${job.requester}, your ${label(job.item)} is ready. I am keeping it until you are close.`)
    }
    await sleep(5000, signal)
  }
  return `Here is your ${label(job.item)}, ${job.requester}.`
}

function newCraftState (item, requester) {
  return { item, requester, made: false, given: false, gathered: new Set(), asked: null, waiting: false, passes: 0, inflight: null, smelting: false, furnace: null, saidReady: false }
}

module.exports = { runCrafter, newCraftState, planNow, deliver, gatherMissing, SOURCES }
