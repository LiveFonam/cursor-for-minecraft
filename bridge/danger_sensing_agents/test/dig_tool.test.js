// A tool wears out on every block it breaks, so it only stays in the hand for blocks it digs faster.
const test = require('node:test')
const assert = require('node:assert')
const { keepToolsForTheirBlocks } = require('../skills/mine')

const PICK = { type: 1, name: 'stone_pickaxe', count: 1 }
const AXE = { type: 2, name: 'wooden_axe', count: 1 }
const SHOVEL = { type: 3, name: 'stone_shovel', count: 1 }
const BREAD = { type: 4, name: 'bread', count: 2 }
const dirt = { name: 'dirt', digTime: type => (type === SHOVEL.type ? 200 : 750) }
const stone = { name: 'stone', harvestTools: { [PICK.type]: true }, digTime: type => (type === PICK.type ? 600 : 7500) }

function makeBot (hotbar, held) {
  const slots = []
  hotbar.forEach((item, i) => { slots[36 + i] = item })
  const bot = {
    entity: {},
    heldItem: held,
    inventory: { hotbarStart: 36, slots, items: () => hotbar.filter(Boolean) },
    setQuickBarSlot (i) { bot.heldItem = slots[36 + i] ?? null },
    dug: [],
    dig: async function (block, ...rest) { bot.dug.push({ block: block.name, heldAtDig: bot.heldItem?.name ?? null, rest }) }
  }
  keepToolsForTheirBlocks(bot)
  return bot
}

test('dirt is not dug with the pickaxe', async () => {
  const bot = makeBot([PICK, AXE, null, BREAD], PICK)
  await bot.dig(dirt, true)
  assert.strictEqual(bot.dug[0].heldAtDig, null)
})

test('it never moves to another tool to dig dirt', async () => {
  const bot = makeBot([PICK, AXE, BREAD], PICK)
  await bot.dig(dirt, true)
  assert.strictEqual(bot.dug[0].heldAtDig, 'bread')
})

test('stone keeps the pickaxe in the hand', async () => {
  const bot = makeBot([PICK, AXE, null], PICK)
  await bot.dig(stone, true)
  assert.strictEqual(bot.dug[0].heldAtDig, 'stone_pickaxe')
})

test('a shovel it is already holding stays for dirt', async () => {
  const bot = makeBot([PICK, SHOVEL, null], SHOVEL)
  await bot.dig(dirt, true)
  assert.strictEqual(bot.dug[0].heldAtDig, 'stone_shovel')
})

test('with nine tools on the hotbar the dig still happens', async () => {
  const bot = makeBot(Array(9).fill(PICK), PICK)
  await bot.dig(dirt, true)
  assert.strictEqual(bot.dug.length, 1)
})

test('the arguments reach the real dig, and wrapping twice is harmless', async () => {
  const bot = makeBot([PICK, null], PICK)
  keepToolsForTheirBlocks(bot)
  await bot.dig(stone, 'ignore', 'raycast')
  assert.strictEqual(bot.dug.length, 1)
  assert.deepStrictEqual(bot.dug[0].rest, ['ignore', 'raycast'])
})
