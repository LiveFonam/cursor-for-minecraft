// Crafting when the bag model and the server disagree: newer servers do not report a click they ignored, so a craft
// counts only when the result shows up in the bag.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { craftAll, ensureTable, freeSpot, placeBeside } = require('../skills/craft')
const { replacePickaxe } = require('../skills/mine_branch')

const quiet = { say: () => {}, log: () => {} }
const live = { cancelled: false }
const nameOf = (bot, r) => bot.registry.items[r.result.id].name

test('a plank craft the server ignored is made again, so a broken pickaxe still gets replaced', async () => {
  const { bot } = makeBot()
  bot.give('cobblestone', 10)
  bot.give('oak_log', 2)
  const real = bot.craft
  let ignored = 0
  bot.craft = async (r, n, table) => {
    if (!ignored && nameOf(bot, r) === 'oak_planks') { ignored++; return }
    return real(r, n, table)
  }
  assert.equal(await replacePickaxe(bot, quiet, live), true)
  assert.equal(ignored, 1)
  assert.equal(bot.countOf('stone_pickaxe'), 1)
  assert.equal(bot.countOf('crafting_table'), 1)
  assert.equal(bot.countOf('oak_log'), 0)
})

test('when the server makes only some of the crafts, the rest are made and none twice', async () => {
  const { bot } = makeBot()
  bot.give('oak_log', 3)
  const real = bot.craft
  let first = true
  bot.craft = async (r, n, table) => {
    if (first) { first = false; return real(r, 1, table) }
    return real(r, n, table)
  }
  assert.equal(await craftAll(bot, [{ name: 'oak_planks', times: 3, table: false }], {}, live), 12)
  assert.equal(bot.countOf('oak_planks'), 12)
  assert.equal(bot.countOf('oak_log'), 0)
})

test('materials the bag model lost are found again after a resync', async () => {
  const { bot } = makeBot()
  let syncs = 0
  bot._syncWindow = async () => {
    if (!syncs++) bot.give('oak_planks', 4)
  }
  await craftAll(bot, [{ name: 'crafting_table', times: 1, table: false }], {}, live)
  assert.equal(bot.countOf('crafting_table'), 1)
  assert.equal(bot.countOf('oak_planks'), 0)
})

test('planks left in the 2 by 2 grid or on the cursor go back in the bag and get used', async () => {
  const { bot } = makeBot()
  const inv = bot.inventory
  inv.slots = inv.slots || []
  const savedGrid = inv.slots[2]
  const savedCursor = inv.selectedItem
  inv.slots[2] = { name: 'oak_planks', count: 2 }
  inv.selectedItem = { name: 'oak_planks', count: 2 }
  bot.putAway = async slot => { inv.slots[slot] = savedGrid ?? null; bot.give('oak_planks', 2) }
  bot.putSelectedItemRange = async () => { inv.selectedItem = savedCursor ?? null; bot.give('oak_planks', 2) }
  await craftAll(bot, [{ name: 'crafting_table', times: 1, table: false }], {}, live)
  assert.equal(bot.countOf('crafting_table'), 1)
  assert.ok(!inv.slots[2])
  assert.ok(!inv.selectedItem)
})

test('a craft the server keeps ignoring ends with an error instead of counting as made', async () => {
  const { bot } = makeBot()
  bot.give('oak_log', 2)
  let calls = 0
  bot.craft = async () => { calls++ }
  await assert.rejects(craftAll(bot, [{ name: 'oak_planks', times: 2, table: false }], {}, live), /oak_planks/)
  assert.ok(calls >= 2 && calls <= 4)
  assert.equal(bot.countOf('oak_log'), 2)
})

test('materials that are really missing still end with the clear error', async () => {
  const { bot } = makeBot()
  await assert.rejects(craftAll(bot, [{ name: 'crafting_table', times: 1, table: false }], {}, live), /crafting_table, an ingredient is missing/)
})

// ---------- placing a table or furnace beside the bot ----------

test('a spot the bot\'s own body reaches into is not free: the live server refuses a block there', () => {
  // near a corner of its cell, the body also stands in the diagonal cell that is looked at first
  const { bot } = makeBot({ groundY: 63, pos: new Vec3(0.1, 64, 0.1) })
  const spot = freeSpot(bot, () => false)
  assert.ok(spot)
  const inBody = spot.x < 0.1 + 0.3 && spot.x + 1 > 0.1 - 0.3 && spot.z < 0.1 + 0.3 && spot.z + 1 > 0.1 - 0.3 && spot.y === 64
  assert.equal(inBody, false, `spot ${spot}`)
})

test('a spot with a cow in it is not free, and a dropped item does not block one', () => {
  const { bot } = makeBot({ groundY: 63, pos: new Vec3(0.5, 64, 0.5) })
  const first = freeSpot(bot, () => false)
  bot.entities[50] = { id: 50, name: 'cow', width: 0.9, height: 1.4, position: first.offset(0.5, 0, 0.5) }
  assert.ok(!freeSpot(bot, () => false).equals(first))
  bot.entities[50] = { id: 50, name: 'item', position: first.offset(0.5, 0, 0.5) }
  assert.ok(freeSpot(bot, () => false).equals(first))
})

test('a table the server refuses at one spot is placed at the next one', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  bot.give('crafting_table', 1)
  const place = bot.placeBlock
  let tries = 0
  bot.placeBlock = async (ref, face) => {
    if (++tries === 1) throw new Error(`Server refused to place crafting_table at ${ref.position.offset(0, 1, 0)}: the block is still air`)
    return place(ref, face)
  }
  const job = {}
  const table = await ensureTable(bot, job, { cancelled: false })
  assert.equal(tries, 2)
  assert.equal(table.name, 'crafting_table')
  assert.equal(world.name(job.table), 'crafting_table')
})

test('a table it can see but has no walking way to is left alone, and it places its own', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  bot.give('crafting_table', 1)
  const far = new Vec3(5, 64, 0)
  world.set(far, 'crafting_table')  // as in the live run: across a gap in a cave
  bot.canSeeBlock = () => true
  bot.pathfinder.goto = async () => { throw new Error('No path to the goal!') }
  const job = {}
  const table = await ensureTable(bot, job, { cancelled: false })
  assert.equal(table.name, 'crafting_table')
  assert.ok(!job.table.equals(far), 'it used a table within reach')
  assert.equal(bot.countOf('crafting_table'), 0)
})

test('a table from an earlier step that can no longer be reached is replaced', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  bot.give('crafting_table', 1)
  const far = new Vec3(12, 64, 0)
  world.set(far, 'crafting_table')
  bot.pathfinder.goto = async () => { throw new Error('No path to the goal!') }
  const job = { table: far }
  await ensureTable(bot, job, { cancelled: false })
  assert.ok(!job.table.equals(far))
})

test('a free spot with no walking way to it is skipped for the next one', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  bot.give('crafting_table', 1)
  const feet = bot.entity.position.floored()
  const goto = bot.pathfinder.goto
  let calls = 0
  bot.pathfinder.goto = async g => {
    if (++calls === 1) throw new Error('No path to the goal!')
    return goto(g)
  }
  const nearBy = p => Math.max(Math.abs(p.x - feet.x), Math.abs(p.z - feet.z)) < 4
  const spot = await placeBeside(bot, 'crafting_table', nearBy, { cancelled: false })
  assert.equal(world.name(spot), 'crafting_table')
  assert.ok(calls >= 2)
})

