// The chest memory and the owner's bag reader, offline.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { ChestMemory, chestView, otherHalf, canonical } = require('../chest_memory')
const { parseInventoryReply, readOwnerBag, readPlayerPos } = require('../owner_bag')
const { CONTAINERS, contents, withdraw, deposit } = require('../skills/storage')
const { makeBot } = require('./mockbot')

const items = o => new Map(Object.entries(o))
const P = { x: 4, y: 64, z: -2 }

function tempFile () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-chests-'))
  return { file: path.join(dir, 'agents-chests.json'), done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('a chest is remembered with where it is, what it held and when', () => {
  let t = 1000
  const m = new ChestMemory(null, { now: () => t })
  m.saw('w', 'overworld', P, items({ diamond: 3 }))
  t = 2000
  m.saw('w', 'overworld', P, items({ diamond: 1, coal: 4 }))
  const [c, ...rest] = m.list('w', 'overworld')
  assert.equal(rest.length, 0, 'seeing it again updates the one record')
  assert.deepEqual(c.pos, P)
  assert.deepEqual([...c.items], [['diamond', 1], ['coal', 4]])
  assert.equal(c.seen, 2000)
})

test('worlds and dimensions are kept apart', () => {
  const m = new ChestMemory()
  m.saw('a', 'overworld', P, items({ coal: 1 }))
  assert.equal(m.list('b', 'overworld').length, 0)
  assert.equal(m.list('a', 'the_nether').length, 0)
  assert.equal(m.knows('a', 'overworld', P), true)
  assert.equal(m.knows('b', 'overworld', P), false)
})

test('it survives a restart, and a broken file only means starting empty', () => {
  const { file, done } = tempFile()
  try {
    new ChestMemory(file).saw('w', 'overworld', P, items({ iron_ingot: 7 }))
    assert.equal(new ChestMemory(file).list('w', 'overworld')[0].items.get('iron_ingot'), 7)
    fs.writeFileSync(file, '{ not json')
    const logged = []
    const m = new ChestMemory(file, { log: l => logged.push(l) })
    assert.equal(m.list('w', 'overworld').length, 0)
    assert.equal(logged.length, 1)
  } finally {
    done()
  }
})

test('a chest that is gone is dropped, one in an unloaded chunk is kept', () => {
  const m = new ChestMemory()
  m.saw('w', 'overworld', { x: 1, y: 64, z: 0 }, items({ coal: 1 }))
  m.saw('w', 'overworld', { x: 2, y: 64, z: 0 }, items({ coal: 1 }))
  m.saw('w', 'overworld', { x: 3, y: 64, z: 0 }, items({ coal: 1 }))
  const dropped = m.prune('w', 'overworld', p => ({ 1: true, 2: false, 3: null })[p.x])
  assert.equal(dropped, 1)
  assert.deepEqual(m.list('w', 'overworld').map(c => c.pos.x).sort(), [1, 3])
  assert.equal(m.forget('w', 'overworld', { x: 1, y: 64, z: 0 }), true)
  assert.equal(m.forget('w', 'overworld', { x: 1, y: 64, z: 0 }), false)
})

test('both halves of a double chest are one record', () => {
  // a chest facing north: its left half connects east, its right half west
  assert.deepEqual(otherHalf({ x: 0, y: 64, z: 0 }, { facing: 'north', type: 'left' }), { x: 1, y: 64, z: 0 })
  assert.deepEqual(otherHalf({ x: 1, y: 64, z: 0 }, { facing: 'north', type: 'right' }), { x: 0, y: 64, z: 0 })
  assert.deepEqual(otherHalf({ x: 0, y: 64, z: 0 }, { facing: 'east', type: 'left' }), { x: 0, y: 64, z: 1 })
  assert.equal(otherHalf({ x: 0, y: 64, z: 0 }, { facing: 'north', type: 'single' }), null)
  assert.deepEqual(canonical({ x: 1, y: 64, z: 0 }, { facing: 'north', type: 'right' }), { x: 0, y: 64, z: 0 })
  const m = new ChestMemory()
  m.saw('w', 'overworld', { x: 0, y: 64, z: 0 }, items({ coal: 5 }), { facing: 'north', type: 'left' })
  m.saw('w', 'overworld', { x: 1, y: 64, z: 0 }, items({ coal: 5 }), { facing: 'north', type: 'right' })
  assert.equal(m.list('w', 'overworld').length, 1, 'its items are not counted twice')
})

test('opening, taking from and filling a chest keeps the memory right', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  const pos = new Vec3(2, 64, 0)
  world.fillChest(pos, [['diamond', 5], ['coal', 2]])
  const memory = new ChestMemory()
  bot.agentsChests = chestView(memory, bot, () => 'w', CONTAINERS)
  assert.equal(bot.agentsChests.knows(pos), false)
  await contents(bot, pos, null)
  assert.equal(bot.agentsChests.list()[0].items.get('diamond'), 5)
  await withdraw(bot, pos, items({ diamond: 3 }), null)
  assert.equal(bot.agentsChests.list()[0].items.get('diamond'), 2)
  bot.give('oak_log', 4)
  await deposit(bot, pos, i => i.name === 'oak_log', null)
  assert.equal(bot.agentsChests.list()[0].items.get('oak_log'), 4)
  world.set(pos, 'air')
  assert.equal(bot.agentsChests.prune(), 1)
  assert.equal(bot.agentsChests.list().length, 0)
})

// ---------- the owner's bag ----------

const REPLY = 'OwnerPlayer has the following entity data: [{count: 3, Slot: 0b, id: "minecraft:diamond"}, {Slot: 1b, id: "minecraft:oak_log", count: 12}, {Slot: 9b, id: "minecraft:diamond", count: 2}]'

test('the inventory reply is read, the same item in two slots added up', async () => {
  const r = parseInventoryReply(REPLY)
  assert.equal(r.complete, true)
  assert.deepEqual(r.items[0], { name: 'diamond', count: 3, slot: 0 })
  const { bag } = await readOwnerBag({ send: async () => REPLY }, 'OwnerPlayer')
  assert.deepEqual([...bag], [['diamond', 5], ['oak_log', 12]])
})

test('items inside a shulker box are not counted as carried', () => {
  const box = 'P has the following entity data: [{Slot: 0b, id: "minecraft:shulker_box", count: 1, components: {"minecraft:container": [{slot: 0, item: {id: "minecraft:diamond", count: 64}}]}}]'
  assert.deepEqual(parseInventoryReply(box).items, [{ name: 'shulker_box', count: 1, slot: 0 }])
})

test('a name with a brace or a quote inside an item does not break the reading', () => {
  const named = 'P has the following entity data: [{Slot: 0b, id: "minecraft:stick", count: 2, components: {"minecraft:custom_name": "a } odd \\" name ]"}}, {Slot: 1b, id: "minecraft:coal", count: 4}]'
  assert.deepEqual(parseInventoryReply(named).items.map(i => i.name), ['stick', 'coal'])
})

test('an empty bag is an empty bag, a missing player is no bag', async () => {
  assert.equal((await readOwnerBag({ send: async () => 'P has the following entity data: []' }, 'P')).bag.size, 0)
  assert.equal((await readOwnerBag({ send: async () => 'Found no elements matching Inventory' }, 'P')).bag.size, 0)
  const gone = await readOwnerBag({ send: async () => 'No entity was found' }, 'P')
  assert.equal(gone.bag, null)
  assert.ok(gone.why)
})

test('no console, or a console that fails, says it could not see the bag', async () => {
  assert.deepEqual(await readOwnerBag(null, 'P'), { bag: null, why: 'no server console' })
  assert.equal((await readOwnerBag({ send: async () => { throw new Error('closed') } }, 'P')).why, 'closed')
})

test('a reply cut short is completed slot by slot', async () => {
  const sent = []
  const cut = 'P has the following entity data: [{Slot: 0b, id: "minecraft:coal", count: 2}, {Slot: 1b, id: "minecraft:dia'
  const rcon = {
    send: async c => {
      sent.push(c)
      if (c === 'data get entity P Inventory') return cut
      if (c === 'data get entity P Inventory[{Slot:1b}]') return 'P has the following entity data: {Slot: 1b, id: "minecraft:diamond", count: 3}'
      return 'Found no elements matching Inventory[{Slot:9b}]'
    }
  }
  const { bag } = await readOwnerBag(rcon, 'P')
  assert.deepEqual([...bag], [['coal', 2], ['diamond', 3]])
  assert.ok(!sent.includes('data get entity P Inventory[{Slot:0b}]'), 'a slot it already has is not asked again')
})

test('only read commands ever reach the console, and only for a real player name', async () => {
  const sent = []
  const rcon = { send: async c => { sent.push(c); return 'P has the following entity data: [{Slot: 0b, id: "minecraft:coal' } }
  await readOwnerBag(rcon, 'P')
  await readPlayerPos(rcon, 'P')
  assert.ok(sent.length > 1)
  for (const c of sent) assert.match(c, /^data get entity P (Inventory(\[\{Slot:\d+b\}\])?|Pos)$/)
  const before = sent.length
  assert.equal((await readOwnerBag(rcon, 'P; clear @a')).bag, null)
  assert.equal(await readPlayerPos(rcon, 'x y'), null)
  assert.equal(sent.length, before)
})

test('a player position is read', async () => {
  const p = await readPlayerPos({ send: async () => 'P has the following entity data: [12.5d, 64.0d, -3.25d]' }, 'P')
  assert.deepEqual(p, { x: 12.5, y: 64, z: -3.25 })
})
