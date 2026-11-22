// The player's width in the movement physics. With exactly 0.3 the bot reports a spot just inside a wall it presses
// against, and Paper corrects it every tick.

const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const { Physics } = require('prismarine-physics')
const registry = require('prismarine-registry')('1.21.11')
const { applyMineflayerFixes, fixDigTimes, PLAYER_HALF_WIDTH } = require('../../mineflayer_fixes')

function fakeBot (physics) {
  const client = new EventEmitter()
  client.write = () => {}
  return { _client: client, entities: {}, physics }
}

test('the half width is half of the game\'s 0.6 float', () => {
  assert.strictEqual(PLAYER_HALF_WIDTH, 0.30000001192092896)
})

test('the fix sets the width on the real physics, once', () => {
  const physics = Physics(registry, { getBlock: () => null })
  assert.strictEqual(physics.playerHalfWidth, 0.3)
  const bot = fakeBot(physics)
  applyMineflayerFixes(bot)
  applyMineflayerFixes(bot)
  assert.strictEqual(physics.playerHalfWidth, PLAYER_HALF_WIDTH)
  assert.strictEqual(bot._client.listenerCount('entity_velocity'), 1)
})

test('with the game width, a player touching a wall at x 25 stays outside it by the game\'s own box', () => {
  const touching = 25 + PLAYER_HALF_WIDTH
  assert.ok(touching - Math.fround(0.6) / 2 >= 25)
  assert.ok(25.3 - Math.fround(0.6) / 2 < 25, 'the old contact spot is inside the wall')
})

test('dig times match the game once the ore material is fixed', () => {
  const Block = require('prismarine-block')(registry)
  const time = (blockName, tool) => Block.fromStateId(registry.blocksByName[blockName].defaultState, 0)
    .digTime(tool ? registry.itemsByName[tool].id : null, false, false, false, [], {})
  fixDigTimes(registry)
  fixDigTimes(registry)  // twice changes nothing
  // the game: speed / hardness / 30 of the block per tick with the right tool, / 100 with the wrong one
  assert.strictEqual(time('iron_ore', 'stone_pickaxe'), 1150)
  assert.strictEqual(time('iron_ore', 'iron_pickaxe'), 750)
  assert.strictEqual(time('deepslate_iron_ore', 'stone_pickaxe'), 1700)
  assert.strictEqual(time('diamond_ore', 'iron_pickaxe'), 750)
  assert.strictEqual(time('gold_ore', 'iron_pickaxe'), 750)
  // too weak a pickaxe still digs at its speed but drops nothing
  assert.strictEqual(time('iron_ore', 'wooden_pickaxe'), 7500)
  // a shovel or an axe is no faster than a hand on ore
  assert.strictEqual(time('iron_ore', 'wooden_shovel'), time('iron_ore', null))
  assert.strictEqual(time('iron_ore', 'stone_axe'), time('iron_ore', null))
  // blocks that were right stay right
  assert.strictEqual(time('stone', 'stone_pickaxe'), 600)
  assert.strictEqual(time('coal_ore', 'wooden_pickaxe'), 2300)
})

test('every block with that material is one a pickaxe mines', () => {
  const blocks = registry.blocksArray.filter(b => b.material === 'incorrect_for_wooden_tool')
  assert.ok(blocks.length > 50)
  for (const b of blocks) {
    if (!b.harvestTools) continue
    for (const id of Object.keys(b.harvestTools)) assert.match(registry.items[id].name, /_pickaxe$/, b.name)
  }
})

test('a bot without physics still gets the other fixes', () => {
  const bot = fakeBot(undefined)
  assert.doesNotThrow(() => applyMineflayerFixes(bot))
  assert.strictEqual(bot._client.listenerCount('entity_velocity'), 1)
})
