// The crafter: one craft job ("craft me a stone pickaxe") from the bot's real bag to the item in the player's hands.
// Plans with crafter_plan.js, crafts with craft.js (the same crafting table handling as the builder), smelts raw iron
// in a furnace, and hands the item over by walking up and dropping it at the player's feet, all normal survival
// actions. CraftMode in behaviors.js runs it, so a fight can cut in at any await and the job picks up where it was.
//
// A job, kept across runs (the mode passes the same object every time):
//   { item, requester, phase, made, given, handed, madeCount, furnace, table, tableOurs, missing, stats }
// Each run first takes back what an interrupted smelt left in the furnace, then plans again from the real bag, so
// a fight, a restart or materials handed over by the player all just mean "look again". The target itself is never
// crafted twice: job.made is set the moment the final craft lands, and from then on the run only delivers.
// job.given means the item was tossed. job.handed means the server reported the player picking it up, and only that
// counts as delivered.

const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { goTo } = require('./move')
const { sleep } = require('./human')
const { craftAll, ensureTable, pickUpTable, placeBeside, canReach, resync, settleBag, pickRecipe } = require('./craft')
const { planCraft, LABEL, describeMissing } = require('./crafter_plan')
const { announceWhy } = require('../announcer')

const REACH = 6          // a crafting table or furnace this close counts as one to use
const GIVE_RANGE = 48    // the player this close (and loaded): walk over and hand it
const DROP_RANGE = 6     // items lying this close while it waits for materials get picked up
const SMELT_TICKS = 200  // one item in a furnace (10 s)
const STATION_RANGE = 32 // a table or furnace this close is worth the walk when the bag can't make one
const PICKUP_MS = 12000  // how long a tossed item may lie before it counts as not taken
const WATCH_MS = 300000  // a dropped item despawns after 5 minutes
const TAKE_BACK_RANGE = 16
// A craft that found the bag different from the plan: the next pass plans again from the server's bag
const BAG_CHANGED = /^I can't craft|^I could only craft|^I need 4 planks/
// A furnace that went out with items still in it: the next pass takes them back and plans again, with fuel from the bag
const FURNACE_STOPPED = /^the furnace stopped with /
const FURNACE_OUT_MS = 3000
const WINDOW_QUIET_MS = 200  // no window packet for this long: the server has answered every click

function bag (bot) {
  const m = new Map()
  for (const i of bot.inventory.items()) m.set(i.name, (m.get(i.name) || 0) + i.count)
  return m
}

function countOf (bot, name) {
  return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

// A crafting table or furnace within reach that it can see (or that touches it), or null
function stationNear (bot, name) {
  const def = bot.registry.blocksByName[name]
  if (!def) return null
  for (const pos of bot.findBlocks({ matching: def.id, maxDistance: REACH, count: 4 })) {
    const b = bot.blockAt(pos)
    if (b && (pos.distanceTo(bot.entity.position) < 3 || bot.canSeeBlock(b))) return b
  }
  return null
}

// The nearest table or furnace within STATION_RANGE that has not proved out of reach, or null
function stationFar (bot, name, job) {
  const def = bot.registry.blocksByName[name]
  if (!def) return null
  return bot.findBlocks({ matching: def.id, maxDistance: STATION_RANGE, count: 4 }).find(pos => !job.noStation?.has(pos.toString())) || null
}

const totalMissing = plan => [...plan.missing.values()].reduce((a, b) => a + b, 0)

// The plan from the bag as it is now. The copies of the target it already carries are its own (a miner keeps its
// pickaxe), so they are left out and the plan makes a new one. A table or furnace further off counts only when the
// bag can't pay for its own, and plan.stations then says where to walk
function planNow (bot, job) {
  const have = bag(bot)
  have.delete(job.item)
  const tableNear = !!stationNear(bot, 'crafting_table') || !!(job.table && bot.blockAt(job.table)?.name === 'crafting_table')
  const furnaceNear = !!stationNear(bot, 'furnace') || !!(job.furnace && bot.blockAt(job.furnace)?.name === 'furnace')
  const plan = planCraft(job.item, have, { tableNear, furnaceNear })
  if (!plan.missing.size) return plan
  const table = tableNear ? null : stationFar(bot, 'crafting_table', job)
  const furnace = furnaceNear ? null : stationFar(bot, 'furnace', job)
  if (!table && !furnace) return plan
  const far = planCraft(job.item, have, { tableNear: tableNear || !!table, furnaceNear: furnaceNear || !!furnace })
  if (totalMissing(far) >= totalMissing(plan)) return plan
  far.stations = []
  if (table && far.steps.some(s => s.kind === 'craft' && s.table)) far.stations.push(['table', table])
  if (furnace && far.steps.some(s => s.kind === 'smelt')) far.stations.push(['furnace', furnace])
  return far
}

// Walks to the far stations a plan counts on. False when one can't be reached (it is left out of the next plan)
async function useStations (bot, job, plan, token, log) {
  for (const [kind, pos] of plan.stations || []) {
    try {
      await near(bot, pos, token)
    } catch (err) {
      if (token?.cancelled) return false
      job.noStation = job.noStation || new Set()
      job.noStation.add(pos.toString())
      log(`${bot.username} can't reach the ${kind} at ${pos}: ${err.message}`)
      return false
    }
    if (token?.cancelled) return false
    job[kind] = pos
    if (kind === 'table') job.tableOurs = false  // someone else's table is never dug up
  }
  return true
}

// Crafting materials lying close by, the ones a player threw over. Not an item lying at a player's feet (one it
// just handed over, or one they are about to pick up)
const MATERIAL = /(_log|_planks|^stick|^cobblestone|^cobbled_deepslate|^blackstone|^raw_iron|^iron_ingot|^iron_nugget|^diamond|^coal|^charcoal|^crafting_table|^furnace)$/
function dropsNear (bot, missing = null, range = DROP_RANGE) {
  const me = bot.entity.position
  const players = Object.values(bot.players || {}).map(p => p.entity).filter(e => e && e !== bot.entity)
  return Object.values(bot.entities || {})
    .filter(e => e.name === 'item' && e.position && e.position.distanceTo(me) <= range)
    .filter(e => {
      const item = typeof e.getDroppedItem === 'function' ? e.getDroppedItem() : null
      return !item || missing?.has(item.name) || MATERIAL.test(item.name)
    })
    .filter(e => !players.some(p => p.position.distanceTo(e.position) < Math.min(1.5, e.position.distanceTo(me))))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
}

async function pickUpDrops (bot, missing, token) {
  let n = 0
  for (const e of dropsNear(bot, missing)) {
    if (token?.cancelled) return n
    if (!bot.entities[e.id]) continue
    try {
      await goTo(bot, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 0.5), token, 5000)
      n++
    } catch {}
    await sleep(250)
  }
  return n
}

// A furnace to smelt in: the job's own, one within reach, or the one in the bag placed beside the bot
async function ensureFurnace (bot, job, token, log) {
  if (job.furnace) {
    const b = bot.blockAt(job.furnace)
    if (b?.name === 'furnace' && await canReach(bot, b.position, token, log)) return bot.blockAt(job.furnace)
    job.furnace = null
  }
  const b = stationNear(bot, 'furnace')
  if (b && await canReach(bot, b.position, token, log)) { job.furnace = b.position; return bot.blockAt(b.position) }
  const item = bot.inventory.items().find(i => i.name === 'furnace')
  if (!item) throw new Error('I have no furnace to smelt in')
  const spot = await placeBeside(bot, 'furnace', () => false, token, log)
  job.furnace = spot
  log(`${bot.username} placed a furnace at ${spot}`)
  return bot.blockAt(spot)
}

async function near (bot, pos, token, range = 3) {
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= range + 0.5) return
  await goTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), token, 20000)
}

// What a smelt interrupted by a fight left in the job's furnace: ingots, raw iron, fuel, all back in the bag
async function emptyFurnace (bot, job, token) {
  // only a furnace it filled itself and did not finish with (never someone's furnace it merely stands near)
  if (!job.furnace || !job.smelting) return
  const b = bot.blockAt(job.furnace)
  if (b?.name !== 'furnace') { job.furnace = null; job.smelting = false; return }
  await near(bot, b.position, token)
  if (token?.cancelled) return
  const f = await bot.openFurnace(b)
  try {
    if (f.outputItem()) await f.takeOutput()
    if (f.inputItem()) await f.takeInput()
    if (f.fuelItem()) await f.takeFuel()
    job.smelting = false
  } finally {
    f.close()
  }
}

// The server's copy of a window after a batch of clicks. Each click gets its own full window back and _syncWindow returns
// on the first one it hears, which can be from before the last click, so the copy counts once the packets have stopped
async function settledWindow (bot, win) {
  if (typeof bot._syncWindow !== 'function') return
  const event = `setWindowItems:${win.id}`
  let last = Date.now()
  const heard = () => { last = Date.now() }
  bot.on(event, heard)
  try {
    await Promise.race([bot._syncWindow(win).catch(() => {}), sleep(3000)])
    const end = Date.now() + 3000
    last = Math.max(last, Date.now())
    while (Date.now() - last < WINDOW_QUIET_MS && Date.now() < end) await sleep(25)
  } finally {
    bot.removeListener(event, heard)
  }
}

// Smelts exactly step.count of step.input into step.output, then checks the bag holds them
async function smelt (bot, step, job, token, log) {
  const want = countOf(bot, step.output) + step.count
  const block = await ensureFurnace(bot, job, token, log)
  if (token?.cancelled) return false
  const reg = bot.registry.itemsByName
  await resync(bot)  // clicks from a stale copy of the bag put nothing in the furnace
  const f = await bot.openFurnace(block)
  try {
    const fuels = step.fuel.slice()
    const feed = async () => {
      // one kind of fuel fits the slot at a time: the next goes in once the slot is empty
      if (f.fuelItem() || !fuels.length) return
      const [name, n] = fuels.shift()
      const have = countOf(bot, name)
      if (have <= 0) throw new Error(`I ran out of ${name.replace(/_/g, ' ')} for the furnace`)
      await f.putFuel(reg[name].id, null, Math.min(n, have))
    }
    await feed()
    job.smelting = true
    await f.putInput(reg[step.input].id, null, step.count)
    // check the furnace really holds them (a refused click leaves it empty), else once more from a fresh copy
    const syncF = () => settledWindow(bot, f)
    await syncF()
    // (fuel is no check: a burning furnace has already taken the coal out of its slot)
    const inside = (f.inputItem()?.count || 0) + (f.outputItem()?.count || 0)
    if (inside < step.count) {
      log(`${bot.username} the furnace holds ${inside} of ${step.count} ${step.input}, putting the rest in again`)
      await f.putInput(reg[step.input].id, null, step.count - inside)
    }
    const state = () => `input ${f.inputItem()?.count || 0}, fuel ${f.fuelItem()?.name || 'none'} ${f.fuelItem()?.count || 0}, burning ${f.fuel ?? '?'}, output ${f.outputItem()?.count || 0}`
    log(`${bot.username} smelting ${step.count} ${step.input} (${state()})`)
    let shown = Date.now()
    announceWhy(bot, 'waiting for the furnace')  // standing still here is no stall without a reason (announcer.js)
    // while the furnace is open the bag lives in the furnace window (bot.inventory catches up when it closes)
    const outId = reg[step.output].id
    const held = () => typeof f.count === 'function' ? f.count(outId, null) : countOf(bot, step.output)
    let deadline = Date.now() + (step.count * SMELT_TICKS * 50) + 20000
    const inBag = name => typeof f.count === 'function' ? f.count(reg[name].id, null) : countOf(bot, name)
    let refills = 0
    let outSince = null
    // Clicks can land fewer items than asked. With input and output empty on the server's copy, nothing more is coming,
    // so what is missing goes in again, with fuel from the kinds the step planned (the planned fuel only covered the job)
    const refill = async () => {
      if (refills >= 3 || f.inputItem() || f.outputItem()) return
      await syncF()
      if (f.inputItem() || f.outputItem()) return
      const missing = want - held()
      // a bad click can leave the stack on the cursor, where the bag count does not see it
      const onCursor = f.selectedItem?.name === step.input ? f.selectedItem.count : 0
      const n = Math.min(missing, inBag(step.input) + onCursor)
      if (n <= 0) return
      refills++
      log(`${bot.username} the furnace is ${missing} ${step.output} short, putting ${n} ${step.input} in again`)
      if (!f.fuelItem()) {
        const name = step.fuel.map(([kind]) => kind).find(kind => inBag(kind) > 0)
        if (name) await f.putFuel(reg[name].id, null, Math.min(name === 'stick' ? n * 2 : n, inBag(name)))
      }
      await f.putInput(reg[step.input].id, null, n)
      deadline = Date.now() + (n * SMELT_TICKS * 50) + 20000
    }
    while (held() < want) {
      if (token?.cancelled) return false  // the rest stays in the furnace, emptyFurnace takes it on the next run
      if (f.outputItem()) await f.takeOutput()
      await feed()
      if (held() < want) await refill()
      if (Date.now() - shown > 10000) { shown = Date.now(); log(`${bot.username} furnace: ${state()}, bag ${held()}/${want}`) }
      // no fuel in the slot, none burning and none left to add: waiting longer cannot finish it
      if (f.inputItem() && !f.fuelItem() && !fuels.length && !(f.fuel > 0)) outSince ??= Date.now()
      else outSince = null
      if (Date.now() > deadline || (outSince && Date.now() - outSince > FURNACE_OUT_MS)) throw new Error(`the furnace stopped with ${held()} of ${want} ${step.output}`)
      await sleep(500)
    }
    if (f.fuelItem() && !f.inputItem()) await f.takeFuel()
    job.smelting = false
  } finally {
    announceWhy(bot, null)
    f.close()
  }
  // the iron pickaxe is only crafted with the ingots really in the bag
  await resync(bot)
  if (countOf(bot, step.output) < want) throw new Error(`I have ${countOf(bot, step.output)} ${step.output}, I need ${want}`)
  job.stats.smelted += step.count
  return true
}

async function syncWin (bot, win) {
  if (typeof bot._syncWindow === 'function') await Promise.race([bot._syncWindow(win).catch(() => {}), sleep(3000)])
}

// One craft step by hand, the way a player does it: open the grid (the table, or the bag's own 2 by 2), wait for the
// server's copy of the window, put one ingredient per cell, shift click the result. Mineflayer's bot.craft fires all
// its clicks at once and takes the result from its own guess of the window, which on 1.21.11
// sometimes crafts nothing
async function craftByHand (bot, step, job, token, log) {
  const reg = bot.registry
  const id = reg.itemsByName[step.name].id
  for (let i = 0; i < step.times; i++) {
    if (token?.cancelled) return
    const table = step.table ? await ensureTable(bot, job, token, { log }) : null
    if (token?.cancelled) return
    await resync(bot)
    const r = pickRecipe(bot, id, table, step.uses)
    if (!r) throw new Error(`I can't craft ${step.name.replace(/_/g, ' ')}, an ingredient is missing`)
    const w = table ? 3 : 2
    const cells = r.inShape
      ? r.inShape.flatMap((row, y) => row.map((ing, x) => ({ ing, slot: 1 + x + w * y })))
      : r.ingredients.map((ing, k) => ({ ing, slot: 1 + (k % w) + w * Math.floor(k / w) }))
    const win = table ? await bot.openBlock(table) : bot.inventory
    try {
      await syncWin(bot, win)
      const putBack = () => win.selectedItem ? bot.putSelectedItemRange(win.inventoryStart, win.inventoryEnd, win, null) : null
      for (const { ing, slot } of cells) {
        if (!ing || ing.id === -1) continue
        if (!win.selectedItem || win.selectedItem.type !== ing.id) {
          await putBack()
          const src = win.findInventoryItem(ing.id, null)
          if (!src) throw new Error(`I can't craft ${step.name.replace(/_/g, ' ')}, I have no ${reg.items[ing.id]?.name}`)
          await bot.clickWindow(src.slot, 0, 0)
        }
        await bot.clickWindow(slot, 1, 0)  // right click: one item into the cell
        await bot.waitForTicks(1)
      }
      await putBack()
      await bot.waitForTicks(2)
      await syncWin(bot, win)
      await bot.clickWindow(0, 0, 1)  // shift click the result into the bag
      await bot.waitForTicks(2)
    } finally {
      if (table) {
        try { bot.closeWindow(win) } catch {}
      } else {
        // the bag's grid keeps what a refused craft left in it: back to the bag
        for (let s = 1; s <= 4; s++) if (win.slots[s]) { try { await bot.clickWindow(s, 0, 1) } catch {} }
      }
    }
  }
  log(`${bot.username} crafted ${step.times} times ${step.name}`)
}

// craftByHand on a real server, craft.js's craftAll on the test bot (it has no windows)
async function craftStep (bot, step, job, token, log) {
  if (typeof bot.openBlock === 'function' && typeof bot.clickWindow === 'function' && bot.inventory?.slots) return craftByHand(bot, step, job, token, log)
  return craftAll(bot, [{ name: step.name, times: step.times, table: step.table, uses: step.uses }], job, token, { log })
}

// A few steps back after a drop, so after the 2 s pickup delay the player is the one standing on it, not the bot
async function stepBack (bot) {
  if (typeof bot.waitForTicks !== 'function') return
  bot.setControlState('back', true)
  await bot.waitForTicks(14)
  bot.setControlState('back', false)
}

// Which item an item entity holds, or null when it can't tell
function droppedName (entity) {
  try { return entity?.getDroppedItem?.()?.name || null } catch { return null }
}

function stopWatch (bot, job) {
  if (!job.watch) return
  clearTimeout(job.watch.timer)
  bot.removeListener('playerCollect', job.watch.on)
  job.watch = null
}

// From the toss on, notes the server's report (Mineflayer's playerCollect) that the requester picked this item up.
// It outlives a run, so a fight during the handover does not lose the report
function watchPickup (bot, job) {
  if (job.watch || typeof bot.on !== 'function' || typeof bot.removeListener !== 'function') return
  const on = (collector, collected) => {
    if (collector?.username !== job.requester) return
    const name = droppedName(collected)
    if (name && name !== job.item) return  // something else they walked over
    job.handed = true
    stopWatch(bot, job)
  }
  const timer = setTimeout(() => stopWatch(bot, job), WATCH_MS)
  timer.unref?.()
  job.watch = { on, timer }
  bot.on('playerCollect', on)
}

// Walks to the player and tosses the item at their feet. 'tossed', 'far' or 'cancelled'
async function tossToPlayer (bot, job, token, hooks) {
  const player = bot.players[job.requester]?.entity
  if (!player || player.position.distanceTo(bot.entity.position) > GIVE_RANGE) return 'far'
  try {
    // a fixed goal by the player (pathfinder.goto never settles on a moving GoalFollow)
    await goTo(bot, new goals.GoalNear(player.position.x, player.position.y, player.position.z, 2), token, 30000)
  } catch {
    if (token?.cancelled) return 'cancelled'
    if (player.position.distanceTo(bot.entity.position) > 3.5) return 'far'
  }
  if (token?.cancelled) return 'cancelled'
  const p = bot.players[job.requester]?.entity
  if (!p || p.position.distanceTo(bot.entity.position) > 3.5) return 'far'
  // face the player's chest from about 2 blocks away, so the drop lands on them and not at the bot's own feet
  await bot.lookAt(p.position.offset(0, 1.1, 0), true)
  // the bag as the server sees it: after crafting at a table Mineflayer's copy can be off by a slot, and a
  // toss from the wrong slot does nothing on the server
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
  await resync(bot)
  const before = countOf(bot, job.item)
  if (before <= 0) throw new Error(`I no longer have the ${LABEL[job.item] || job.item}`)
  const id = bot.registry.itemsByName[job.item].id
  // set first: if the toss lands while a fight cuts in, the next run must not toss a second one
  job.given = true
  job.heldBefore = before
  watchPickup(bot, job)
  for (let tries = 0; tries < 3; tries++) {
    hooks.onGiving?.(job)
    // the server throws along the facing it last heard, so let the turn reach it first
    if (typeof bot.waitForTicks === 'function') await bot.waitForTicks(3)
    job.tossedAt = Date.now()
    try { await bot.toss(id, null, 1) } catch (err) { hooks.log?.(`${bot.username} toss ${job.item}: ${err.message}`) }
    await stepBack(bot)
    await resync(bot)  // did the server really take it
    if (job.handed || countOf(bot, job.item) < before) break
    hooks.log?.(`${bot.username} toss ${tries + 1} of ${job.item}: the server kept it in the bag`)
  }
  if (!job.handed && countOf(bot, job.item) >= before) {
    stopWatch(bot, job)
    job.given = false
    throw new Error(`the server did not take my ${LABEL[job.item] || job.item} when I dropped it`)
  }
  return 'tossed'
}

function handedOver (bot, job, hooks) {
  stopWatch(bot, job)
  hooks.log?.(`${bot.username} gave ${job.item} to ${job.requester} (picked up)`)
  hooks.onGiven?.(job)
  return 'given'
}

// Back in the bag, so the handover starts again later
function backInBag (bot, job, hooks) {
  stopWatch(bot, job)
  job.given = false
  job.handoffs = (job.handoffs || 0) + 1
  hooks.log?.(`${bot.username} has the ${job.item} back, ${job.requester} did not pick it up`)
  return 'far'
}

// Nobody took it: walks over to take it back so it can't despawn. 'far' with it back in the bag, 'dropped' when it is
// gone from the bag and the server never reported the player taking it
async function takeBack (bot, job, token, hooks) {
  const me = bot.entity.position
  const drop = Object.values(bot.entities || {})
    .filter(e => e.name === 'item' && e.position && droppedName(e) === job.item && e.position.distanceTo(me) <= TAKE_BACK_RANGE)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
  if (drop) {
    try { await goTo(bot, new (require('./pickup').GoalPickup)(drop.position), token, 8000) } catch {}
    await sleep(600)
    await resync(bot)
  }
  if (token?.cancelled) return 'cancelled'
  if (job.handed) return handedOver(bot, job, hooks)
  if (countOf(bot, job.item) >= job.heldBefore) return backInBag(bot, job, hooks)
  stopWatch(bot, job)
  hooks.log?.(`${bot.username} dropped ${job.item} for ${job.requester}, the server never reported a pickup`)
  return 'dropped'
}

// Waits for the server to report the pickup of the tossed item
async function awaitPickup (bot, job, token, hooks) {
  while (!job.handed && Date.now() < (job.tossedAt || 0) + PICKUP_MS) {
    if (token?.cancelled) return 'cancelled'
    if (countOf(bot, job.item) >= job.heldBefore) break  // it walked back over it, or the toss never landed
    await sleep(50)
  }
  if (job.handed) return handedOver(bot, job, hooks)
  await resync(bot)
  if (countOf(bot, job.item) >= job.heldBefore) return backInBag(bot, job, hooks)
  return takeBack(bot, job, token, hooks)
}

// Hands the item over. 'given' only once the server reports the player picked it up, 'far' (keep it and say it is
// ready), 'dropped' (it left the bag with no pickup reported) or 'cancelled'
async function deliver (bot, job, token, hooks) {
  if (job.handed) return 'given'
  if (!job.given) {
    const r = await tossToPlayer(bot, job, token, hooks)
    if (r !== 'tossed') return r
  }
  return awaitPickup(bot, job, token, hooks)
}

// True when a final craft from an earlier attempt is in the bag after all, so it is never made a second time
async function finalLanded (bot, job) {
  if (job.finalBefore === undefined) return false
  await resync(bot)
  const landed = countOf(bot, job.item) > job.finalBefore
  if (landed) {
    job.made = true
    job.madeCount = countOf(bot, job.item)
  }
  job.finalBefore = undefined
  return landed
}

// One run of a craft job. Returns { result, ... }:
//   missing   { missing: Map }  the bag lacks these (the mode asks the gatherer or the player, then runs again)
//   given     the server reported the player picking it up
//   far       made, kept, the player is out of reach or did not take it (the mode hands it over later)
//   dropped   it left the bag at the player's feet and no pickup was reported
//   cancelled a higher mode took control (the mode runs it again later)
async function runCraftJob (bot, job, token, hooks = {}) {
  const log = hooks.log || (() => {})
  job.stats = job.stats || { crafted: 0, smelted: 0, runs: 0 }
  job.stats.runs++
  let bagError = null

  // Each pass plans from the bag as the server has it and does what is left. A craft the server did not take (its
  // copy of the bag and Mineflayer's can drift apart) just shows up as still to do on the next pass
  for (let pass = 0; !job.made && pass < 3; pass++) {
    // materials the player threw over while it waited
    if (job.missing) await pickUpDrops(bot, job.missing, token)
    await emptyFurnace(bot, job, token)
    if (token?.cancelled) return { result: 'cancelled' }
    // the server's bag, with anything a refused craft left in the 2 by 2 grid or on the cursor back in it
    await settleBag(bot)
    if (await finalLanded(bot, job)) break
    const plan = planNow(bot, job)
    job.plan = plan
    if (plan.missing.size) {
      job.missing = plan.missing
      return { result: 'missing', missing: plan.missing }
    }
    job.missing = null
    if (!await useStations(bot, job, plan, token, log)) {
      if (token?.cancelled) return { result: 'cancelled' }
      pass--  // that station is now left out, so the next plan differs
      continue
    }
    log(`${bot.username} craft ${job.item}${pass ? ` (pass ${pass + 1})` : ''}: ${plan.steps.map(s => s.kind === 'craft' ? `${s.name} x${s.times}` : `smelt ${s.count} ${s.input}`).join(', ')}`)
    for (const step of plan.steps) {
      if (token?.cancelled) return { result: 'cancelled' }
      await resync(bot)
      if (step.kind === 'smelt') {
        try {
          if (!await smelt(bot, step, job, token, log)) return { result: 'cancelled' }
        } catch (err) {
          if (token?.cancelled || !FURNACE_STOPPED.test(err.message)) throw err
          bagError = err
          log(`${bot.username} ${err.message}, planning again from the bag`)
          break
        }
        continue
      }
      const final = step.name === job.item
      const before = countOf(bot, job.item)
      const hadStep = countOf(bot, step.name)
      if (final) job.finalBefore = before
      try {
        // uses a table within reach or places one (from the bag, or crafted from the planks the plan counted)
        await craftStep(bot, step, job, token, log)
      } catch (err) {
        if (final && await finalLanded(bot, job)) break  // the craft landed and only the call after it failed
        if (token?.cancelled || !BAG_CHANGED.test(err.message)) throw err
        bagError = err
        log(`${bot.username} craft ${step.name}: ${err.message}, planning again from the bag`)
        break
      }
      if (token?.cancelled && !final) break
      // count it as the server has it
      await resync(bot)
      if (!final) {
        // a craft the server ignored: the steps after it would run short, so plan again from what is really there
        if (countOf(bot, step.name) < hadStep + step.count) {
          log(`${bot.username} craft ${step.name}: the server shows ${countOf(bot, step.name) - hadStep} of ${step.count}, planning again from the bag`)
          break
        }
        job.stats.crafted += step.times
        continue
      }
      job.stats.crafted += step.times
      if (countOf(bot, job.item) > before) {
        // the one copy it was asked for: from here on a run only hands it over
        job.made = true
        job.finalBefore = undefined
        job.madeCount = countOf(bot, job.item)
      } else {
        log(`${bot.username} craft ${job.item}: the server shows none after the craft, planning again from the bag`)
      }
      break
    }
    if (token?.cancelled && !job.made) return { result: 'cancelled' }
  }
  if (!job.made) throw bagError || new Error(`the crafts ran but I have no ${LABEL[job.item] || job.item}`)
  if (!job.madeLogged) { job.madeLogged = true; hooks.onMade?.(job) }
  // the furnace is still out and the job is made: its raw food goes in before it walks away
  if (job.furnace && !job.cookedHere) {
    job.cookedHere = true
    await require('./cook').cookAtFurnace(bot, job, token, log)
  }
  // a crafting table it placed itself goes back in the bag (4 planks it may need next time)
  if (job.item !== 'crafting_table' && job.tableOurs) { try { await pickUpTable(bot, job, token) } catch (err) { log(`${bot.username} table pickup: ${err.message}`) } }

  if (job.handed) return { result: 'given' }
  // !craft <item> keep: a tool the bot needs itself (a pickaxe for the next step of a plan) stays in its bag
  if (job.keep) return { result: 'kept' }
  if (token?.cancelled) return { result: 'cancelled' }
  const r = await deliver(bot, job, token, hooks)
  return { result: r }
}

module.exports = { runCraftJob, planNow, stationNear, dropsNear, countOf, bag, deliver, smelt, emptyFurnace, craftStep, describeMissing, GIVE_RANGE }
