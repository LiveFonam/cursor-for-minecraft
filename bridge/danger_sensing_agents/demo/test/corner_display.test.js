// The corner readout: what the agent carries, how far it is, its time on the job and what the model has cost.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { hudLines, jobLine, apiLines, maxDurability } = require('../corner_lines')
const { cornerLines, readBag, writeLines } = require('../corner_display')

const data = value => `Agent1 has the following entity data: ${value}`

function world (fields) {
  return async command => {
    const key = command.replace('data get entity ', '')
    return key in fields ? data(fields[key]) : 'Found no elements matching'
  }
}

const AGENT = {
  'Agent1 Health': '17.5f',
  'Agent1 foodLevel': '18',
  'Agent1 Pos[0]': '13.0d',
  'Agent1 Pos[1]': '64.0d',
  'Agent1 Pos[2]': '4.0d',
  'Viewer Pos[0]': '10.0d',
  'Viewer Pos[1]': '64.0d',
  'Viewer Pos[2]': '0.0d',
  'Agent1 Inventory[0].id': '"minecraft:stone_axe"',
  'Agent1 Inventory[0].count': '1',
  'Agent1 Inventory[0].components."minecraft:damage"': '31',
  'Agent1 Inventory[1].id': '"minecraft:bread"',
  'Agent1 Inventory[1].count': '16',
  'Agent1 equipment.offhand.id': '"minecraft:shield"',
  'Agent1 equipment.offhand.count': '1'
}

test('food, blocks and tools are counted apart, with what is left of each tool', () => {
  const lines = hudLines([
    { id: 'stone_axe', count: 1, damage: 30 },
    { id: 'bread', count: 2 },
    { id: 'beef', count: 2 },
    { id: 'cobblestone', count: 12 },
    { id: 'oak_planks', count: 3 }
  ])
  assert.ok(lines.includes('Ready food 10 pts'))
  assert.ok(lines.includes('Raw food   6 pts (16 cooked)'))
  assert.ok(lines.includes('Blocks     15'))
  assert.ok(lines.includes(' stone axe 101/131'))
  assert.equal(maxDurability('cobblestone'), 0)
})

test('the job line shows the time gone, then how long the last job took', () => {
  const started = '[agents 10:00:00] Agent1 goal 1 iron_pickaxe: start'
  assert.deepEqual(jobLine(started, 10 * 3600 + 90), ['Gone for   1:30 (iron pickaxe)'])
  const ended = `${started}\n[agents 10:02:05] Agent1: goal to idle`
  assert.deepEqual(jobLine(ended, 11 * 3600), ['Last job   2:05 (iron pickaxe)'])
  assert.deepEqual(jobLine('nothing here', 0), [])
})

test('the model line uses the last running total and its prices', () => {
  const text = 'x tokens: in 10, out 1 | total 1 calls, in 10, out 1\ny tokens: in 1000, out 100 | total 2 calls, in 1010, out 101'
  const [calls, cost] = apiLines(text)
  assert.match(calls, /^Haiku\s+2 calls, 1\.0k in, 101 out$/)
  assert.equal(cost, 'API cost   $0.0002 this run')
  assert.deepEqual(apiLines('no model use'), [])
})

test('the bag is read one field at a time, with the off hand', async () => {
  const bag = await readBag(world(AGENT), 'Agent1')
  assert.deepEqual(bag, [
    { id: 'stone_axe', count: 1, damage: 31 },
    { id: 'bread', count: 16, damage: 0 },
    { id: 'shield', count: 1, damage: 0 }
  ])
})

test('the readout measures from the base when it has one, and from the player otherwise', async () => {
  const fromBase = await cornerLines({ send: world(AGENT), bot: 'Agent1', player: 'Viewer', home: { x: 13, y: 64, z: 16 } })
  assert.deepEqual(fromBase.slice(0, 4), ['Agent1', 'HP   17.5 / 20', 'Food 18 / 20', 'Base       12 blocks away'])
  const fromPlayer = await cornerLines({ send: world(AGENT), bot: 'Agent1', player: 'Viewer' })
  assert.equal(fromPlayer[3], 'Player     5 blocks away')
})

test('nothing is shown while the agent is not in the world', async () => {
  assert.deepEqual(await cornerLines({ send: world({}), bot: 'Agent1', player: 'Viewer' }), [])
})

test('the file is replaced whole, so the display never reads half of it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corner-'))
  const file = path.join(dir, 'hud.txt')
  writeLines(file, ['one', 'two'])
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\r\ntwo')
  assert.deepEqual(fs.readdirSync(dir), ['hud.txt'])
})
