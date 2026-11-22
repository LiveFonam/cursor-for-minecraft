// Haste is a command: the agent only has it after !haste, and keeps it until it is switched off.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { loadSettings } = require('../settings')
const { parseDemoCommand } = require('../words')
const { DemoController } = require('../controller')

const CONFIG = { host: '127.0.0.1', port: 25566, version: '1.21.11', owner: null, bots: ['Agent1'], fighter_run: 'weights/fighter' }
const S = { ...loadSettings({ DEMO_PLAYER: 'Viewer' }, CONFIG), stage: { x: 10, y: -60, z: 20 } }
const ON = 'effect give Agent1 minecraft:haste infinite 1 true'
const OFF = 'effect clear Agent1 minecraft:haste'

function rig () {
  const sent = []
  const rcon = { send: async c => { sent.push(c); return '' } }
  let id = 0
  const timers = { setInterval: () => ++id, clearInterval: () => {}, setTimeout: () => ++id, clearTimeout: () => {}, now: () => 0 }
  const bot = { entity: { position: { x: 0, y: -60, z: 0 } }, health: 20 }
  const agents = { agentBot: () => bot, stopAgent: async () => {}, runTask: async () => {}, forgetChest: () => {} }
  const c = new DemoController({ settings: S, rcon, agents, spawnDuel: () => new EventEmitter(), timers, sleep: async () => {}, log: () => {} })
  c.stage = S.stage
  return { c, sent, bot }
}

test('a task alone gives no Haste', async () => {
  const { c, sent } = rig()
  await c.taskStarted('diamond_pickaxe')
  assert.ok(!sent.includes(ON))
})

test('!haste turns it on, and again turns it off', async () => {
  const { c, sent } = rig()
  await c.handle('!haste', 'Viewer')
  assert.ok(sent.includes(ON))
  sent.length = 0
  await c.handle('!haste', 'Viewer')
  assert.ok(sent.includes(OFF))
})

test('!haste on and off are explicit, and anything else is refused', () => {
  assert.deepEqual(parseDemoCommand('!haste on'), { name: 'haste', on: true })
  assert.deepEqual(parseDemoCommand('!haste off'), { name: 'haste', on: false })
  assert.ok(parseDemoCommand('!haste 2').error)
})

test('only the demo player can use it', async () => {
  const { c, sent } = rig()
  await c.handle('!haste', 'Someone')
  assert.ok(!sent.includes(ON))
})

test('once on, it comes back after a death', async () => {
  const { c, sent, bot } = rig()
  await c.handle('!haste on', 'Viewer')
  sent.length = 0
  bot.health = 0
  await c.agentSpawned()
  assert.ok(!sent.includes(ON))
  bot.health = 20
  await c.agentSpawned()
  assert.ok(sent.includes(ON))
})

test('once off, a respawn does not bring it back', async () => {
  const { c, sent } = rig()
  await c.handle('!haste on', 'Viewer')
  await c.handle('!haste off', 'Viewer')
  sent.length = 0
  await c.agentSpawned()
  assert.ok(!sent.includes(ON))
})

test('a reset keeps it on', async () => {
  const { c, sent } = rig()
  await c.handle('!haste on', 'Viewer')
  sent.length = 0
  await c.reset()
  assert.ok(sent.lastIndexOf(ON) > sent.findIndex(l => l === 'effect clear Agent1'))
})

test('plain words can turn Haste on and off', () => {
  const { parseHasteWords: words } = require('../words')
  for (const line of ['use haste', 'give yourself haste', 'turn on haste', 'haste please', 'mine faster', 'can you dig way faster']) {
    assert.equal(words(line)?.on, true, line)
  }
  for (const line of ['turn off haste', 'stop using haste', 'no more haste', 'remove haste', "don't use haste"]) {
    assert.equal(words(line)?.on, false, line)
  }
  for (const line of ['make me a diamond pickaxe', 'come here', '!haste', '']) assert.equal(words(line), null, line)
})

test('saying use haste does not start a task, and a task with haste does both', async () => {
  const { c, sent } = rig()
  const tasks = []
  c.agents.runTask = async text => { tasks.push(text) }
  await c.handle('use haste', 'Viewer')
  assert.ok(sent.includes(ON))
  assert.equal(tasks.length, 0)
  await c.handle('make me a diamond pickaxe with haste', 'Viewer')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(tasks, ['make me a diamond pickaxe with haste'])
})

test('a death during a task puts him in the new agent\'s view, and it retries', async () => {
  const sent = []
  const pending = []
  const rcon = { send: async c => { sent.push(c); return '' } }
  const timers = { setInterval: () => 1, clearInterval: () => {}, setTimeout: fn => { pending.push(fn); return pending.length }, clearTimeout: () => {}, now: () => 0 }
  const bot = { entity: { position: { x: 0, y: -60, z: 0 } }, health: 20 }
  const agents = { agentBot: () => bot, stopAgent: async () => {}, runTask: async () => {}, forgetChest: () => {} }
  const c = new DemoController({ settings: S, rcon, agents, spawnDuel: () => new EventEmitter(), timers, sleep: async () => {}, log: () => {} })
  c.stage = S.stage
  await c.taskStarted('diamond_pickaxe')
  assert.ok(!sent.includes('spectate Agent1 Viewer'))
  pending.length = 0
  bot.health = 0
  await c.agentSpawned()
  assert.ok(!sent.includes('spectate Agent1 Viewer'), 'not onto a dead body')
  bot.health = 20
  for (let i = 0; i < 3 && pending.length; i++) pending.shift()()
  assert.ok(sent.includes('spectate Agent1 Viewer'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.length, 0, 'it stops after its tries')
})
