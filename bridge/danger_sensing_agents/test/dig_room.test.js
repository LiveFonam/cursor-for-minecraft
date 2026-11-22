// With no free floor nearby, the bot digs one block out of the wall beside it and uses that hole for a furnace or table.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { digRoom } = require('../skills/craft')

const STONE = { name: 'stone', boundingBox: 'block', diggable: true, digTime: () => 600 }
const AIR = { name: 'air', boundingBox: 'empty', diggable: false, digTime: () => 0 }

function makeBot (blocks = {}, fallback = STONE) {
  const key = p => `${p.x},${p.y},${p.z}`
  const world = new Map(Object.entries(blocks))
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), effects: {} },
    entities: {},
    heldItem: null,
    inventory: { items: () => [], slots: [], hotbarStart: 36 },
    blockAt: p => ({ ...(world.get(key(p)) ?? fallback), position: p }),
    dug: [],
    dig: async b => {
      bot.dug.push(key(b.position))
      world.set(key(b.position), AIR)
    }
  }
  world.set('0,64,0', AIR)
  world.set('0,65,0', AIR)
  return bot
}

test('it digs a wall block at its feet and returns that spot', async () => {
  const bot = makeBot()
  const spot = await digRoom(bot, () => false)
  assert.ok(spot)
  assert.strictEqual(spot.y, 64)
  assert.strictEqual(Math.abs(spot.x) + Math.abs(spot.z), 1)
  assert.strictEqual(bot.blockAt(spot).name, 'air')
  assert.strictEqual(bot.blockAt(spot.offset(0, -1, 0)).boundingBox, 'block')
  assert.strictEqual(bot.dug.length, 1)
})

test('it never digs next to lava', async () => {
  const lava = { name: 'lava', boundingBox: 'empty', diggable: false, digTime: () => 0 }
  const bot = makeBot({ '2,64,0': lava, '-2,64,0': lava, '0,64,2': lava, '0,64,-2': lava })
  assert.strictEqual(await digRoom(bot, () => false), null)
  assert.strictEqual(bot.dug.length, 0)
})

test('it leaves chests and other useful blocks alone', async () => {
  const chest = { ...STONE, name: 'chest' }
  const bot = makeBot({ '1,64,0': chest, '-1,64,0': chest, '0,64,1': chest, '0,64,-1': chest })
  assert.strictEqual(await digRoom(bot, () => false), null)
})

test('it skips a block with sand or gravel above it', async () => {
  const gravel = { ...STONE, name: 'gravel' }
  const bot = makeBot({ '1,65,0': gravel, '-1,65,0': gravel, '0,65,1': gravel })
  const spot = await digRoom(bot, () => false)
  assert.deepStrictEqual([spot.x, spot.z], [0, -1])
})

test('it needs a solid block under the hole', async () => {
  const bot = makeBot({ '1,63,0': AIR, '-1,63,0': AIR, '0,63,1': AIR, '0,63,-1': AIR })
  assert.strictEqual(await digRoom(bot, () => false), null)
})
