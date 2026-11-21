'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { plugin: pvpPlugin } = require('mineflayer-pvp')
const { plugin: collectPlugin, CollectBlock } = require('mineflayer-collectblock')
const { createSay, startCrew, createHelper, onDeath } = require('../src/crew')
const { createMovements } = require('../src/skills/move')
const { resetCollector } = require('../src/skills/gather')
const { registry, VERSION, createMockBot, createContext } = require('./helpers/mock-bot')

const config = {
  owner: 'TestOwner',
  host: '127.0.0.1',
  port: 25565,
  version: VERSION,
  auth: 'offline',
  bots: ['CrewHelper1', 'CrewHelper2'],
  joinDelayMs: 5000
}

function fakeBot () {
  const bot = new EventEmitter()
  bot.loaded = []
  bot.loadPlugin = plugin => bot.loaded.push(plugin)
  return bot
}

test('say sends chat, spaces it out and never runs a command', async () => {
  const lines = []
  const say = createSay({ chat: line => lines.push(line) }, { gapMs: 2 })
  say('/op someone')
  say('line\nbreak')
  assert.deepEqual(lines, ['op someone'])
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(lines, ['op someone', 'line break'])
})

test('say drops the oldest lines when flooded', async () => {
  const lines = []
  const say = createSay({ chat: line => lines.push(line) }, { gapMs: 1, maxQueue: 2 })
  for (const n of [1, 2, 3, 4, 5]) say(String(n))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(lines, ['1', '4', '5'])
})

test('say survives a closed connection', () => {
  const say = createSay({ chat: () => { throw new Error('closed') } }, { gapMs: 1 })
  assert.doesNotThrow(() => say('hello'))
})

test('creates each bot with the config and all plugins', () => {
  const created = []
  const bot = createHelper(config, 'CrewHelper1', {
    createBot: options => {
      created.push(options)
      return fakeBot()
    },
    logger: () => {}
  })
  assert.deepEqual(created, [{ host: '127.0.0.1', port: 25565, username: 'CrewHelper1', version: VERSION, auth: 'offline' }])
  assert.deepEqual(bot.loaded, [pathfinder, pvpPlugin, collectPlugin])
})

test('joins bots one at a time with the configured delay', async () => {
  const names = []
  const waits = []
  await startCrew(config, {
    createBot: options => {
      names.push(options.username)
      return fakeBot()
    },
    logger: () => {},
    wait: async ms => waits.push(ms)
  })
  assert.deepEqual(names, ['CrewHelper1', 'CrewHelper2'])
  assert.deepEqual(waits, [5000])
})

test('drops a job after repeated deaths and clears the fight target', () => {
  const bot = createMockBot()
  const ctx = createContext(bot)
  ctx.modes = { pause: () => { ctx.paused = true } }
  const job = { name: 'mine iron' }
  ctx.state.job = job
  ctx.state.fightName = 'zombie'
  onDeath(ctx)
  assert.equal(ctx.state.job, job)
  assert.equal(ctx.state.fightName, null)
  assert.equal(ctx.paused, true)
  onDeath(ctx)
  assert.equal(ctx.state.job, job)
  onDeath(ctx)
  assert.equal(ctx.state.job, null)
  assert.match(ctx.said[0], /Dropping mine iron/)
})

// These run the real plugin code against a minimal bot, to catch API mismatches.
function pluginBot () {
  const bot = new EventEmitter()
  bot.setMaxListeners(30)
  bot.version = VERSION
  bot.registry = registry
  bot.supportFeature = registry.supportFeature
  bot.world = new EventEmitter()
  bot.entity = { position: { x: 0, y: 64, z: 0 } }
  bot.inventory = { items: () => [], slots: [], emptySlotCount: () => 36 }
  bot.loadPlugin = plugin => plugin(bot, {})
  bot.hasPlugin = () => false
  return bot
}

test('real movements profiles load for the target version', () => {
  const bot = pluginBot()
  const { safe, dig } = createMovements(bot)
  assert.ok(safe instanceof Movements)
  assert.equal(safe.canDig, false)
  assert.equal(safe.allow1by1towers, false)
  assert.deepEqual([...safe.scafoldingBlocks], [])
  assert.equal(dig.canDig, true)
  assert.equal(dig.dontCreateFlow, true)
})

test('the real pvp plugin exposes the calls fight depends on', () => {
  const bot = pluginBot()
  pathfinder(bot)
  pvpPlugin(bot)
  assert.ok(bot.pvp)
  for (const method of ['attack', 'stop', 'forceStop']) assert.equal(typeof bot.pvp[method], 'function')
})

test('the real collect plugin can be reset', () => {
  const bot = pluginBot()
  pathfinder(bot)
  bot.collectBlock = new CollectBlock(bot)
  const stale = bot.collectBlock
  resetCollector(bot)
  assert.ok(bot.collectBlock instanceof CollectBlock)
  assert.notEqual(bot.collectBlock, stale)
  assert.equal(bot.collectBlock.movements, null)
})
