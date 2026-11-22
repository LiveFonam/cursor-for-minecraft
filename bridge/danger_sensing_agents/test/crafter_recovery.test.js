// The crafter when the world does not go to plan, no server needed:  node --test bridge/danger_sensing_agents/test/crafter_recovery.test.js
//
// Bags of mixed wood, a craft the server ignores or reports late, a table or furnace further off, an item nobody picks
// up, and a pickaxe that breaks while mining. The windowed bot below clicks through a small model of the server's
// crafting grid, so the hand crafting path runs too.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { Vec3 } = require('vec3')
const { makeBot, registry } = require('./mockbot')
const { Recipe } = require('prismarine-recipe')(registry)
const { planCraft, parseCraftRequest, resolveTarget, describeMissing, TARGETS } = require('../skills/crafter_plan')
const { runCraftJob, planNow, smelt } = require('../skills/crafter')
const { replacePickaxe, hasHarvestTool } = require('../skills/mine_branch')
const { mineJob } = require('../skills/mine')
const { parseMessage } = require('../commands')

const OWNER = 'OwnerPlayer'
const bagOf = o => new Map(Object.entries(o))
const newJob = (item, extra = {}) => ({ item, requester: OWNER, keep: false, phase: 'run', made: false, given: false, missing: null, table: null, tableOurs: false, furnace: null, ...extra })
const quiet = { say: () => {}, log: () => {} }
const live = () => ({ cancelled: false })

function setup (inv, { table = true, player = true } = {}) {
  const { bot, world } = makeBot({ groundY: 63 })
  for (const [n, c] of Object.entries(inv)) bot.give(n, c)
  if (table) world.set(new Vec3(2, 64, 0), 'crafting_table')
  if (player) bot.players[OWNER] = { username: OWNER, entity: { type: 'player', username: OWNER, position: new Vec3(3.5, 64, 0.5), height: 1.8 } }
  return { bot, world }
}

const madeCount = (bot, name) => bot.crafted.filter(n => n === name).length

// The server reports no pickup, or (with other) a pickup of some other item
function holdPickup (bot, other = null) {
  const emit = bot.emit
  bot.emit = (ev, ...a) => {
    if (ev !== 'playerCollect') return emit(ev, ...a)
    if (other) emit(ev, a[0], { name: 'item', getDroppedItem: () => ({ name: other }) })
  }
}

// The wait for a pickup ends right after the toss, so the tests need not sit through it
function shortWait (bot, job) {
  const toss = bot.toss
  bot.toss = async (...a) => {
    await toss(...a)
    job.tossedAt = 1
  }
}

// A small model of the server's crafting windows on the fake bot: the 2 by 2 grid of the bag and the 3 by 3 table.
// One right click puts one item in a cell, and a shift click on the result crafts for as long as the grid covers it.
function withWindows (bot, { ignoreResultClicks = 0 } = {}) {
  const all = Object.keys(registry.recipes).flatMap(id => Recipe.find(Number(id)))
  let ignored = 0
  const makeWindow = (target, width) => {
    const start = width === 2 ? 9 : 10
    target.width = width
    target.grid = new Array(width * width + 1).fill(null)
    target.selectedItem = null
    target.inventoryStart = start
    target.inventoryEnd = start + 36
    target.findInventoryItem = id => {
      const i = bot.inventory.items().findIndex(x => x.type === id)
      return i < 0 ? null : { slot: start + i }
    }
    target.firstEmptySlotRange = () => start
    Object.defineProperty(target, 'slots', {
      configurable: true,
      get () {
        const out = []
        target.grid.forEach((c, i) => { if (i > 0 && c) out[i] = c })
        bot.inventory.items().forEach((it, i) => { out[start + i] = it })
        return out
      }
    })
    return target
  }
  const trim = rows => {
    let r = rows.map(row => row.slice())
    while (r.length && r[0].every(c => c === null)) r.shift()
    while (r.length && r[r.length - 1].every(c => c === null)) r.pop()
    while (r.length && r.every(row => row[0] === null)) r = r.map(row => row.slice(1))
    while (r.length && r.every(row => row[row.length - 1] === null)) r = r.map(row => row.slice(0, -1))
    return JSON.stringify(r)
  }
  const match = win => {
    const rows = []
    for (let y = 0; y < win.width; y++) rows.push(win.grid.slice(1 + y * win.width, 1 + (y + 1) * win.width).map(c => c ? c.type : null))
    const shape = trim(rows)
    const flat = rows.flat().filter(c => c !== null).sort((a, b) => a - b)
    if (!flat.length) return null
    return all.find(r => {
      if (r.requiresTable && win.width < 3) return false
      if (r.inShape) return trim(r.inShape.map(row => row.map(c => c.id < 0 ? null : c.id))) === shape
      return JSON.stringify(r.ingredients.map(c => c.id).sort((a, b) => a - b)) === JSON.stringify(flat)
    }) || null
  }
  const toBag = (win, slot) => {
    const c = win.grid[slot]
    if (!c) return
    win.grid[slot] = null
    bot.give(c.name, c.count)
  }
  const click = (win, slot, button, mode) => {
    if (mode === 1 && slot === 0) {
      if (ignored < ignoreResultClicks) { ignored++; return }
      for (let r = match(win); r; r = match(win)) {
        for (let i = 1; i < win.grid.length; i++) {
          if (!win.grid[i]) continue
          if (--win.grid[i].count === 0) win.grid[i] = null
        }
        const name = registry.items[r.result.id].name
        bot.give(name, r.result.count)
        bot.crafted.push(name)
      }
      return
    }
    if (mode === 1) return toBag(win, slot)
    if (slot >= win.inventoryStart) {
      const it = bot.inventory.items()[slot - win.inventoryStart]
      if (!it || win.selectedItem) return
      win.selectedItem = { type: it.type, name: it.name, count: it.count }
      bot.take(it.name, it.count)
      return
    }
    if (button === 1 && win.selectedItem) {
      const c = win.grid[slot]
      if (c && c.type !== win.selectedItem.type) return
      win.grid[slot] = c ? { ...c, count: c.count + 1 } : { type: win.selectedItem.type, name: win.selectedItem.name, count: 1 }
      if (--win.selectedItem.count === 0) win.selectedItem = null
    }
  }
  const putBack = win => {
    if (!win.selectedItem) return
    bot.give(win.selectedItem.name, win.selectedItem.count)
    win.selectedItem = null
  }
  makeWindow(bot.inventory, 2)
  bot.clickWindow = async (slot, button, mode) => click(bot.currentWindow || bot.inventory, slot, button, mode)
  bot.putSelectedItemRange = async (a, b, win) => putBack(win)
  bot.putAway = async slot => click(bot.currentWindow || bot.inventory, slot, 0, 1)
  bot.openBlock = async () => {
    bot.currentWindow = makeWindow({}, 3)
    return bot.currentWindow
  }
  bot.closeWindow = win => {
    for (let i = 1; i < win.grid.length; i++) toBag(win, i)
    putBack(win)
    bot.currentWindow = null
  }
  return bot
}

// ---------- the planner ----------

test('it asks for the wood it already holds, and counts the planks it has', () => {
  const plan = planCraft('wooden_pickaxe', bagOf({ birch_planks: 1 }), { tableNear: true })
  assert.deepEqual([...plan.missing], [['birch_log', 1]])
  assert.deepEqual([...planCraft('wooden_pickaxe', new Map(), { tableNear: true }).missing], [['oak_log', 2]])
})

test('a shortfall in a wood it cannot make is asked for as a log it can gather', () => {
  const plan = planCraft('wooden_pickaxe', bagOf({ bamboo_planks: 8 }), { tableNear: false })
  assert.deepEqual([...plan.missing], [['oak_log', 1]])
})

test('raw iron, cobblestone and 1 log: the planks for the furnace are crafted before the smelt', () => {
  const plan = planCraft('iron_pickaxe', bagOf({ raw_iron: 3, cobblestone: 8, oak_log: 1 }), { tableNear: true })
  assert.equal(plan.missing.size, 0, describeMissing(plan.missing))
  const order = plan.steps.map(s => s.kind === 'smelt' ? 'smelt' : s.name)
  assert.deepEqual(plan.steps.find(s => s.kind === 'smelt').fuel, [['oak_planks', 2]])
  assert.ok(order.indexOf('oak_planks') < order.indexOf('smelt'), order.join(', '))
  assert.ok(order.indexOf('furnace') < order.indexOf('smelt'), order.join(', '))
  assert.ok(order.indexOf('smelt') < order.indexOf('iron_pickaxe'), order.join(', '))
})

test('every plan has each ingredient and fuel in the bag when its step runs', () => {
  const bags = [
    { raw_iron: 3, cobblestone: 8, oak_log: 1 }, { raw_iron: 3, cobblestone: 8, oak_log: 2 }, { raw_iron: 3, cobblestone: 8, oak_log: 3 },
    { raw_iron: 3, oak_log: 1 }, { raw_iron: 3, stick: 2, oak_log: 1 }, { raw_iron: 2, iron_ingot: 1, cobblestone: 8, spruce_log: 1 },
    { raw_iron: 3, stick: 8, cobblestone: 8 }, { raw_iron: 3, coal: 1, cobblestone: 8, oak_log: 1 }, { raw_iron: 3, oak_planks: 4, cobblestone: 8 },
    { raw_iron: 3, oak_planks: 2, birch_log: 1, cobblestone: 8 }, { oak_log: 2, cobblestone: 3 }, { diamond: 3, oak_log: 1 }
  ]
  let checked = 0
  for (const target of TARGETS) {
    for (const bag of bags) {
      for (const opts of [{ tableNear: true }, { tableNear: false }, { tableNear: true, furnaceNear: true }]) {
        const plan = planCraft(target, bagOf(bag), opts)
        if (plan.missing.size) continue
        checked++
        const stock = bagOf(bag)
        const take = (name, n) => {
          assert.ok((stock.get(name) || 0) >= n, `${target} from ${JSON.stringify(bag)}: ${n} ${name} not there yet`)
          stock.set(name, stock.get(name) - n)
        }
        for (const s of plan.steps) {
          if (s.kind === 'smelt') {
            take(s.input, s.count)
            for (const [name, n] of s.fuel) take(name, n)
            stock.set(s.output, (stock.get(s.output) || 0) + s.count)
          } else {
            for (const [name, n] of Object.entries(s.uses)) take(name, n * s.times)
            stock.set(s.name, (stock.get(s.name) || 0) + s.count)
          }
        }
      }
    }
  }
  assert.ok(checked > 20)
})

test('each craft step names what it takes, and two woods stay two steps', () => {
  const plan = planCraft('wooden_pickaxe', bagOf({ oak_planks: 2, birch_planks: 3 }), { tableNear: true })
  assert.equal(plan.missing.size, 0)
  const pick = plan.steps.find(s => s.name === 'wooden_pickaxe')
  assert.deepEqual(pick.uses, { birch_planks: 3, stick: 2 })
  assert.deepEqual(plan.steps.find(s => s.name === 'stick').uses, { oak_planks: 2 })
})

test('names with an article work after !craft, and chat counts read naturally', () => {
  assert.equal(resolveTarget('me a stone pickaxe'), 'stone_pickaxe')
  assert.equal(resolveTarget('an iron pick'), 'iron_pickaxe')
  assert.equal(resolveTarget('boat'), null)
  assert.equal(parseMessage('!craft me a stone pickaxe', ['Agent1']).command.args.item, 'stone_pickaxe')
  assert.deepEqual(parseCraftRequest('craft me a stone pickaxe'), { item: 'stone_pickaxe' })
  assert.equal(describeMissing(bagOf({ cobblestone: 8, coal: 2, oak_log: 3, diamond: 2 })), '8 cobblestone, 2 coal, 3 oak logs and 2 diamonds')
})

test('without the generated recipe file it plans the same from minecraft-data', () => {
  const file = require.resolve('../skills/crafter_plan')
  const saved = require.cache[file]
  const resolve = Module._resolveFilename
  delete require.cache[file]
  Module._resolveFilename = function (request, ...rest) {
    if (/all-recipes/.test(request)) throw Object.assign(new Error('no file'), { code: 'MODULE_NOT_FOUND' })
    return resolve.call(this, request, ...rest)
  }
  let bare
  try {
    bare = require('../skills/crafter_plan')
  } finally {
    Module._resolveFilename = resolve
    require.cache[file] = saved
  }
  const bags = [{}, { oak_log: 2 }, { birch_planks: 1 }, { oak_log: 1, cobblestone: 3 }, { spruce_log: 1, cobbled_deepslate: 3 }, { raw_iron: 3, coal: 1, cobblestone: 8, oak_log: 2 }, { iron_nugget: 27, oak_log: 1 }, { diamond_block: 1, oak_log: 1 }]
  const norm = p => JSON.stringify({ steps: p.steps.map(s => [s.kind, s.name, s.times, s.uses, s.input, s.fuel]), missing: [...p.missing].sort() })
  for (const t of TARGETS) {
    for (const b of bags) {
      for (const opts of [{ tableNear: true }, { tableNear: false }, { tableNear: true, furnaceNear: true }]) {
        assert.equal(norm(bare.planCraft(t, bagOf(b), opts)), norm(planCraft(t, bagOf(b), opts)), `${t} from ${JSON.stringify(b)}`)
      }
    }
  }
})

// ---------- whole jobs ----------

test('a bag of two woods crafts with the wood the plan counted', async () => {
  const { bot } = setup({ oak_planks: 2, birch_planks: 3 })
  assert.equal((await runCraftJob(bot, newJob('wooden_pickaxe'), live())).result, 'given')
  assert.equal(madeCount(bot, 'wooden_pickaxe'), 1)
})

test('raw iron, cobblestone and 1 log: the whole job smelts on planks it just made and hands the pickaxe over', async () => {
  const { bot } = setup({ raw_iron: 3, cobblestone: 8, oak_log: 1 })
  assert.equal((await runCraftJob(bot, newJob('iron_pickaxe'), live())).result, 'given')
  assert.equal(madeCount(bot, 'iron_pickaxe'), 1)
  for (const name of ['raw_iron', 'iron_ingot', 'cobblestone', 'oak_log', 'oak_planks']) assert.equal(bot.countOf(name), 0, name)
  assert.equal(bot.countOf('stick'), 2)  // one craft makes 4 and the pickaxe takes 2
})

test('a final craft that lands while its call fails is not made a second time', async () => {
  const { bot } = setup({ oak_log: 2, cobblestone: 6 })
  const craft = bot.craft
  let once = true
  bot.craft = async (r, ...a) => {
    await craft(r, ...a)
    if (once && registry.items[r.result.id].name === 'stone_pickaxe') {
      once = false
      throw new Error('window closed')
    }
  }
  assert.equal((await runCraftJob(bot, newJob('stone_pickaxe'), live())).result, 'given')
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
  assert.equal(bot.countOf('cobblestone'), 3)
})

test('what a refused craft left in the 2 by 2 grid goes back in the bag before it plans', async () => {
  const { bot } = setup({ cobblestone: 3 })
  withWindows(bot)
  bot.inventory.grid[1] = { type: registry.itemsByName.oak_log.id, name: 'oak_log', count: 1 }
  assert.equal((await runCraftJob(bot, newJob('stone_pickaxe'), live())).result, 'given')
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
})

test('a table or furnace further off is used only when the bag cannot make its own', async () => {
  const far = setup({ raw_iron: 3, coal: 1, stick: 2 })
  far.world.set(new Vec3(12, 64, 0), 'furnace')
  const job = newJob('iron_pickaxe')
  assert.equal((await runCraftJob(far.bot, job, live())).result, 'given')
  assert.equal(far.bot.placed.some(p => p.name === 'furnace'), false)
  assert.equal(job.furnace.toString(), new Vec3(12, 64, 0).toString())

  const table = setup({ cobblestone: 3, stick: 2 }, { table: false })
  table.world.set(new Vec3(12, 64, 0), 'crafting_table')
  assert.equal((await runCraftJob(table.bot, newJob('stone_pickaxe'), live())).result, 'given')
  assert.equal(table.bot.placed.some(p => p.name === 'crafting_table'), false)

  // a table it walked to is not its own, so it stays where it stands
  const left = setup({ cobblestone: 3, stick: 2 }, { table: false })
  left.world.set(new Vec3(12, 64, 0), 'crafting_table')
  assert.equal((await runCraftJob(left.bot, newJob('stone_pickaxe', { table: new Vec3(20, 64, 20), tableOurs: true }), live())).result, 'given')
  assert.equal(left.world.name(new Vec3(12, 64, 0)), 'crafting_table')

  // with wood for its own table it does not walk off
  const own = setup({ oak_log: 2, cobblestone: 3 }, { table: false })
  own.world.set(new Vec3(12, 64, 0), 'crafting_table')
  assert.equal((await runCraftJob(own.bot, newJob('stone_pickaxe'), live())).result, 'given')
  assert.ok(own.bot.placed.some(p => p.name === 'crafting_table'))
})

test('a far station it cannot reach is dropped from the plan and the job asks for materials', async () => {
  const { bot, world } = setup({ raw_iron: 3, coal: 1, stick: 2 })
  world.set(new Vec3(12, 64, 0), 'furnace')
  const goto = bot.pathfinder.goto
  bot.pathfinder.goto = async goal => {
    if (goal.x === 12) throw new Error('No path to the goal!')
    return goto(goal)
  }
  const job = newJob('iron_pickaxe')
  const r = await runCraftJob(bot, job, live())
  assert.equal(r.result, 'missing')
  assert.deepEqual([...r.missing], [['cobblestone', 8]])
  assert.equal(planNow(bot, job).missing.size, 1)
})

// ---------- the handover ----------

test('counted as given only when the server reports the player picking it up', async () => {
  const { bot } = setup({ oak_log: 1, cobblestone: 3 })
  holdPickup(bot)
  const job = newJob('stone_pickaxe')
  shortWait(bot, job)
  assert.equal((await runCraftJob(bot, job, live())).result, 'dropped')
  assert.equal(job.handed, undefined)
  assert.equal(bot.tossed.length, 1)
})

test('the player picking up some other item does not count', async () => {
  const { bot } = setup({ oak_log: 1, cobblestone: 3 })
  holdPickup(bot, 'dirt')
  const job = newJob('stone_pickaxe')
  shortWait(bot, job)
  const toss = bot.toss
  bot.toss = async (...a) => {
    await toss(...a)
    bot.emit('playerCollect', bot.players[OWNER].entity)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal((await runCraftJob(bot, job, live())).result, 'dropped')
})

test('a pickup reported while a fight has control still counts, with no second toss', async () => {
  const { bot } = setup({ oak_log: 1, cobblestone: 3 })
  const emit = bot.emit
  const held = []
  bot.emit = (ev, ...a) => ev === 'playerCollect' ? held.push(a) : emit(ev, ...a)
  const job = newJob('stone_pickaxe')
  const token = live()
  const toss = bot.toss
  bot.toss = async (...a) => {
    await toss(...a)
    token.cancelled = true
  }
  assert.equal((await runCraftJob(bot, job, token)).result, 'cancelled')
  bot.toss = toss
  bot.emit = emit
  emit('playerCollect', bot.players[OWNER].entity, { name: 'item', getDroppedItem: () => ({ name: 'stone_pickaxe' }) })
  assert.equal((await runCraftJob(bot, job, live())).result, 'given')
  assert.equal(bot.tossed.length, 1)
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
})

test('an item nobody took is taken back and handed over again, never crafted again', async () => {
  const { bot } = setup({ oak_log: 1, cobblestone: 3 })
  const emit = bot.emit
  bot.emit = (ev, ...a) => ev === 'playerCollect' ? undefined : emit(ev, ...a)
  const job = newJob('stone_pickaxe')
  const toss = bot.toss
  bot.toss = async (...a) => {
    await toss(...a)
    job.tossedAt = 1
    bot.entities[7] = { id: 7, name: 'item', position: bot.entity.position.offset(0, 0, 1), getDroppedItem: () => ({ name: 'stone_pickaxe' }) }
    bot.toss = toss
  }
  const goto = bot.pathfinder.goto
  bot.pathfinder.goto = async goal => {
    await goto(goal)
    if (bot.entities[7] && goal.z === Math.floor(bot.entities[7].position.z)) {
      delete bot.entities[7]
      bot.give('stone_pickaxe', 1)
    }
  }
  assert.equal((await runCraftJob(bot, job, live())).result, 'far')
  assert.equal(job.given, false)
  assert.equal(job.handoffs, 1)
  assert.equal(bot.countOf('stone_pickaxe'), 1)
  bot.emit = emit
  assert.equal((await runCraftJob(bot, job, live())).result, 'given')
  assert.equal(bot.tossed.length, 2)
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
})

// ---------- hand crafting through the windows ----------

test('by hand: logs to a stone pickaxe on a table it places and picks back up', async () => {
  const { bot, world } = setup({ oak_log: 2, cobblestone: 3 }, { table: false })
  withWindows(bot)
  assert.equal((await runCraftJob(bot, newJob('stone_pickaxe'), live())).result, 'given')
  assert.deepEqual(bot.crafted.filter(n => n === 'stone_pickaxe' || n === 'crafting_table'), ['crafting_table', 'stone_pickaxe'])
  assert.equal(bot.countOf('crafting_table'), 1)
  assert.equal(bot.inventory.grid.some(Boolean), false)
  assert.equal([...world.blocks.values()].some(b => b.name === 'crafting_table'), false)
})

test('by hand: a result click the server ignores is planned again and makes exactly one', async () => {
  const { bot } = setup({ oak_log: 2, cobblestone: 3 }, { table: false })
  withWindows(bot, { ignoreResultClicks: 2 })
  assert.equal((await runCraftJob(bot, newJob('stone_pickaxe'), live())).result, 'given')
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
  assert.equal(bot.inventory.grid.some(Boolean), false)
})

// ---------- a pickaxe that breaks while mining ----------

// Mineflayer's craft reports success from its own guess of the window. Here the planks show in the bag and pass the
// check after the craft, then the server's real window arrives: no planks, the logs still in the 2 by 2 grid
function plankCraftThatNeverLanded (bot) {
  const craft = bot.craft
  const inv = bot.inventory
  inv.slots = []
  let done = false
  bot.craft = async (r, n, table) => {
    if (done || registry.items[r.result.id].name !== 'oak_planks') return craft(r, n, table)
    done = true
    await craft(r, n, table)
    setTimeout(() => {
      bot.take('oak_planks', n * 4)
      inv.slots[1] = { name: 'oak_log', count: n }
    }, 20)
  }
  bot.putAway = async slot => {
    const it = inv.slots[slot]
    inv.slots[slot] = null
    if (it) bot.give(it.name, it.count)
  }
}

test('a broken pickaxe: planks the server never made do not end the job', async () => {
  const { bot } = setup({ oak_log: 4, cobblestone: 20 }, { table: false, player: false })
  plankCraftThatNeverLanded(bot)
  const said = []
  const logged = []
  const job = { blocks: ['iron_ore', 'deepslate_iron_ore'] }
  assert.equal(await replacePickaxe(bot, { say: t => said.push(t), log: t => logged.push(t) }, live(), job), true)
  assert.ok(logged.some(t => /planning again from the bag/.test(t)), logged.join(' | '))
  assert.equal(bot.countOf('stone_pickaxe'), 1)
  assert.equal(bot.countOf('crafting_table'), 1)
  assert.ok(said.some(t => /made a new stone one/.test(t)))
})

test('a broken pickaxe on diamond ore: never a stone one that cannot mine it', async () => {
  const { bot } = setup({ oak_log: 4, cobblestone: 20 }, { table: false, player: false })
  const job = { blocks: ['diamond_ore', 'deepslate_diamond_ore'] }
  assert.equal(await replacePickaxe(bot, quiet, live(), job), false)
  assert.equal(bot.crafted.length, 0)
  assert.equal(bot.countOf('oak_log'), 4)
  assert.equal(bot.countOf('cobblestone'), 20)
})

test('a broken pickaxe on diamond ore: three ingots make an iron one', async () => {
  const { bot } = setup({ oak_log: 3, iron_ingot: 3, cobblestone: 20 }, { table: false, player: false })
  const job = { blocks: ['diamond_ore', 'deepslate_diamond_ore'] }
  assert.equal(await replacePickaxe(bot, quiet, live(), job), true)
  assert.equal(bot.countOf('iron_pickaxe'), 1)
  assert.equal(bot.countOf('stone_pickaxe'), 0)
  assert.equal(hasHarvestTool(bot, job), true)
})

test('a fight during the replacement carries on with the same order and makes one', async () => {
  const { bot } = setup({ oak_log: 4, cobblestone: 20 }, { table: false, player: false })
  const ctx = { ...quiet }
  const job = { blocks: ['iron_ore', 'deepslate_iron_ore'] }
  const token = live()
  const craft = bot.craft
  bot.craft = async (r, ...a) => {
    await craft(r, ...a)
    if (registry.items[r.result.id].name === 'crafting_table') token.cancelled = true
  }
  assert.equal(await replacePickaxe(bot, ctx, token, job), false)
  assert.ok(ctx.spare, 'the order is kept')
  bot.craft = craft
  assert.equal(await replacePickaxe(bot, ctx, live(), job), true)
  assert.equal(ctx.spare, null)
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
  assert.equal(bot.countOf('stone_pickaxe'), 1)
})

const human = { level: 'off', placesTorches: false, nextTorchGap: () => 3, idleMoment: async () => {}, lookAtPoint: async () => {}, lookAround: async () => {}, detourPoint: () => null }

// A corridor at Y 16 with iron ore at its end, and a stone pickaxe in the bag
function miningScene (give, oreX) {
  const { bot, world } = makeBot({ groundY: 63, pos: new Vec3(0.5, 16, 0.5) })
  for (let x = 0; x < oreX; x++) {
    world.set(new Vec3(x, 16, 0), 'air')
    world.set(new Vec3(x, 17, 0), 'air')
  }
  world.set(new Vec3(oreX, 16, 0), 'iron_ore')
  world.set(new Vec3(oreX + 1, 16, 0), 'iron_ore')
  bot.give('stone_pickaxe', 1)
  for (const [n, c] of Object.entries(give)) bot.give(n, c)
  return { bot, world }
}

const ironJob = count => ({ block: 'iron', blocks: ['iron_ore', 'deepslate_iron_ore'], count, mined: 0, strategy: 'branch', home: null, store: false, prepared: true })

test('a whole mining job: the pickaxe breaks on a dig, a new one is made and mining goes on', async () => {
  const { bot } = miningScene({ oak_log: 4, cobblestone: 20 }, 2)
  const dig = bot.dig
  let broke = false
  bot.dig = async (...a) => {
    await dig(...a)
    if (!broke && bot.countOf('raw_iron') === 1) {
      broke = true
      bot.take('stone_pickaxe', 1)
    }
  }
  const said = []
  const r = await mineJob(bot, ironJob(2), human, live(), { say: t => said.push(t), log: () => {} })
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.countOf('raw_iron'), 2)
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
  assert.ok(said.some(t => /made a new stone one/.test(t)), said.join(' | '))
})

test('a whole mining job: the pickaxe breaks on the walk to the ore, it still gets replaced', async () => {
  const { bot } = miningScene({ oak_log: 4, cobblestone: 20 }, 6)
  const goto = bot.pathfinder.goto
  let walks = 0
  bot.pathfinder.goto = async goal => {
    if (walks++) return goto(goal)
    bot.take('stone_pickaxe', 1)
    bot.entity.position = new Vec3(4.5, 16, 0.5)
  }
  const r = await mineJob(bot, ironJob(1), human, live(), { say: () => {}, log: () => {} })
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.countOf('raw_iron'), 1)
  assert.equal(madeCount(bot, 'stone_pickaxe'), 1)
})

test('a whole mining job: no way to make a new pickaxe ends the job with the reason', async () => {
  const { bot } = miningScene({}, 2)
  const dig = bot.dig
  bot.dig = async (...a) => {
    await dig(...a)
    bot.take('stone_pickaxe', 1)
  }
  const r = await mineJob(bot, ironJob(2), human, live(), { say: () => {}, log: () => {} })
  assert.equal(r.result, 'no_tool')
  assert.match(r.message, /pickaxe broke/)
  assert.equal(bot.crafted.length, 0)
})

test('a furnace left one short by its clicks gets the missing item and more fuel, and the smelt still finishes', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  const spot = new Vec3(2, 64, 0)
  world.set(spot, 'furnace', { facing: 'north', lit: false })
  bot.give('raw_iron', 5)
  bot.give('oak_planks', 4)
  const open = bot.openFurnace
  bot.openFurnace = async b => {
    const f = await open(b)
    const put = f.putInput
    let calls = 0
    // as on the live server: the first clicks land nothing, the second land one fewer than asked
    f.putInput = async (type, meta, count) => {
      calls++
      if (calls === 1) return
      return put(type, meta, calls === 2 ? count - 1 : count)
    }
    return f
  }
  const job = { furnace: spot, stats: { smelted: 0 } }
  const step = { input: 'raw_iron', output: 'iron_ingot', count: 3, fuel: [['oak_planks', 2]] }
  assert.equal(await smelt(bot, step, job, live(), () => {}), true)
  assert.equal(bot.countOf('iron_ingot'), 3)
  assert.equal(bot.countOf('raw_iron'), 2, 'only the missing item went in')
  assert.equal(job.stats.smelted, 3)
})

test('a furnace out of fuel halfway: the rest comes back out, the plan is redone and the pickaxe gets made', async () => {
  const { bot } = setup({ raw_iron: 3, stick: 2, oak_planks: 5, furnace: 1 })
  const open = bot.openFurnace
  let first = true
  bot.openFurnace = async b => {
    const f = await open(b)
    const put = f.putFuel
    // as on the live server: one fuel item fewer reaches the furnace than the plan counted
    f.putFuel = async (type, meta, count) => {
      const n = first ? count - 1 : count
      first = false
      return put(type, meta, n)
    }
    return f
  }
  const lines = []
  const r = await runCraftJob(bot, newJob('iron_pickaxe', { keep: true }), live(), { log: l => lines.push(l) })
  assert.equal(r.result, 'kept')
  assert.equal(bot.countOf('iron_pickaxe'), 1)
  assert.equal(bot.countOf('raw_iron'), 0)
  assert.ok(lines.some(l => /furnace stopped.*planning again/.test(l)), lines.join(' | '))
})

test('a window copy from before the last click: the iron in the furnace is not clicked back out', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  const spot = new Vec3(2, 64, 0)
  world.set(spot, 'furnace', { facing: 'north', lit: false })
  bot.give('raw_iron', 3)
  bot.give('coal', 1)
  const open = bot.openFurnace
  let puts = 0
  let stale = false
  bot.openFurnace = async b => {
    const f = await open(b)
    f.id = 7
    const [input, output, put] = [f.inputItem, f.outputItem, f.putInput]
    f.inputItem = () => stale ? null : input()
    f.outputItem = () => stale ? null : output()
    // as on the live server: each click gets its own full window, so the sync hears an old one, and a second left click
    // on the full slot would lift the whole stack onto the cursor
    f.putInput = async (type, meta, count) => {
      if (++puts > 1) throw new Error('clicked the furnace input a second time')
      await put(type, meta, count)
      stale = true
    }
    return f
  }
  bot._syncWindow = async () => {
    if (stale) setTimeout(() => { stale = false; bot.emit('setWindowItems:7') }, 60)
  }
  const job = { furnace: spot, stats: { smelted: 0 } }
  const step = { input: 'raw_iron', output: 'iron_ingot', count: 3, fuel: [['coal', 1]] }
  assert.equal(await smelt(bot, step, job, live(), () => {}), true)
  assert.equal(puts, 1)
  assert.equal(bot.countOf('iron_ingot'), 3)
})

test('iron left on the cursor by a bad click goes back into the furnace', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  const spot = new Vec3(2, 64, 0)
  world.set(spot, 'furnace', { facing: 'north', lit: false })
  bot.give('raw_iron', 3)
  bot.give('coal', 1)
  const rawId = registry.itemsByName.raw_iron.id
  const open = bot.openFurnace
  bot.openFurnace = async b => {
    const f = await open(b)
    const put = f.putInput
    let calls = 0
    f.selectedItem = { name: 'raw_iron', count: 3 }
    f.count = id => id === rawId ? 0 : bot.countOf('iron_ingot')
    f.putInput = async (type, meta, count) => {
      if (++calls <= 2) return  // these clicks land nothing, the stack stays on the cursor
      f.selectedItem = null
      return put(type, meta, count)
    }
    return f
  }
  const job = { furnace: spot, stats: { smelted: 0 } }
  const step = { input: 'raw_iron', output: 'iron_ingot', count: 3, fuel: [['coal', 1]] }
  assert.equal(await smelt(bot, step, job, live(), () => {}), true)
  assert.equal(bot.countOf('iron_ingot'), 3)
})

test('a dig canceled because the pickaxe broke is not counted as being stuck', async () => {
  const { bot } = miningScene({ oak_log: 4, cobblestone: 20 }, 2)
  const dig = bot.dig
  let first = true
  bot.dig = async (...a) => {
    if (first) { first = false; throw new Error('Digging aborted: the tool in hand changed') }
    return dig(...a)
  }
  const job = ironJob(2)
  const r = await mineJob(bot, job, human, live(), { say: () => {}, log: () => {} })
  assert.equal(r.result, 'done')
  assert.equal(job.stats.stuck, 0)
})

