'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const { parseCommand, parseCount, isFromOwner, handleChat, attachCommands } = require('../src/commands')
const { createModes } = require('../src/modes')
const { createMockBot, createContext } = require('./helpers/mock-bot')

function setup (options) {
  const bot = createMockBot(options)
  const ctx = createContext(bot)
  ctx.modes = createModes(ctx)
  return { bot, ctx }
}

const fromOwner = text => ({ sender: 'owner-uuid', plainMessage: text })

test('parses commands addressed to the crew or to this bot', () => {
  assert.deepEqual(parseCommand('@crew mine iron 8', 'CrewHelper1'), { verb: 'mine', args: ['iron', '8'] })
  assert.deepEqual(parseCommand('  @CREW   come ', 'CrewHelper1'), { verb: 'come', args: [] })
  assert.deepEqual(parseCommand('@crewhelper1 stop', 'CrewHelper1'), { verb: 'stop', args: [] })
  assert.deepEqual(parseCommand('@crew', 'CrewHelper1'), { verb: 'help', args: [] })
})

test('ignores lines not addressed to this bot', () => {
  assert.equal(parseCommand('hello @crew come', 'CrewHelper1'), null)
  assert.equal(parseCommand('@CrewHelper2 come', 'CrewHelper1'), null)
  assert.equal(parseCommand(undefined, 'CrewHelper1'), null)
})

test('counts must be whole numbers in range', () => {
  assert.equal(parseCount(undefined, 8), 8)
  assert.equal(parseCount('12', 8), 12)
  for (const bad of ['0', '-1', '1.5', 'many', '257']) assert.equal(parseCount(bad, 8), null)
})

test('owner check matches the packet sender UUID', () => {
  const bot = createMockBot()
  assert.equal(isFromOwner(bot, 'TestOwner', 'owner-uuid'), true)
  assert.equal(isFromOwner(bot, 'TestOwner', 'other-uuid'), false)
  assert.equal(isFromOwner(bot, 'TestOwner', undefined), false)
  assert.equal(isFromOwner(bot, 'MissingName', 'owner-uuid'), false)
})

test('a stranger cannot command the bot, even by typing the owner name', () => {
  const { bot, ctx } = setup()
  attachCommands(ctx)
  bot._client.emit('playerChat', { sender: 'stranger-uuid', plainMessage: '@crew guard' })
  bot._client.emit('playerChat', { sender: 'stranger-uuid', plainMessage: '<TestOwner> @crew guard' })
  assert.equal(ctx.state.job, null)
  assert.deepEqual(ctx.said, [])
})

test('chat with no sender, like server broadcasts, is ignored', () => {
  const { bot, ctx } = setup()
  attachCommands(ctx)
  bot._client.emit('playerChat', { plainMessage: '@crew guard' })
  bot.emit('messagestr', 'TestOwner: @crew guard', 'system', null, null)
  bot.emit('chat', 'TestOwner', '@crew guard')
  assert.equal(ctx.state.job, null)
})

test('the owner can start each job', () => {
  const { bot, ctx } = setup({ items: { oak_planks: 200, oak_log: 8 } })
  const expected = {
    '@crew come': 'come',
    '@crew follow': 'follow',
    '@crew guard': 'guard',
    '@crew farm': 'farm',
    '@crew mine iron 8': 'mine iron',
    '@crew gather oak_log 4': 'gather oak_log',
    '@crew craft stick 4': 'craft stick',
    '@crew build hut': 'build hut',
    '@crew build pen': 'build pen'
  }
  for (const [line, name] of Object.entries(expected)) {
    assert.equal(handleChat(ctx, fromOwner(line)), true, line)
    assert.equal(ctx.state.job?.name, name, line)
  }
  assert.ok(bot)
})

test('stop clears the job and the fight target', () => {
  const { bot, ctx } = setup()
  bot.addEntity({ name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0) })
  handleChat(ctx, fromOwner('@crew guard'))
  handleChat(ctx, fromOwner('@crew fight zombie'))
  assert.equal(ctx.state.fightName, 'zombie')
  handleChat(ctx, fromOwner('@crew stop'))
  assert.equal(ctx.state.job, null)
  assert.equal(ctx.state.fightName, null)
})

test('refuses to fight the owner or a crew mate', () => {
  const { ctx } = setup()
  handleChat(ctx, fromOwner('@crew fight TestOwner'))
  handleChat(ctx, fromOwner('@crew fight crewhelper2'))
  assert.equal(ctx.state.fightName, null)
  assert.equal(ctx.said.filter(line => /will not fight/.test(line)).length, 2)
})

test('reports bad input without starting a job', () => {
  const { ctx } = setup()
  const lines = ['@crew mine', '@crew mine iron 0', '@crew mine notablock', '@crew craft notanitem',
    '@crew build ../../secret', '@crew build castle', '@crew fight', '@crew fight nobodyhere', '@crew dance']
  for (const line of lines) handleChat(ctx, fromOwner(line))
  assert.equal(ctx.state.job, null)
  assert.equal(ctx.state.fightName, null)
  assert.equal(ctx.said.length, lines.length)
})

test('come needs the owner to be visible', () => {
  const { bot, ctx } = setup()
  bot.players.TestOwner.entity = null
  handleChat(ctx, fromOwner('@crew come'))
  assert.equal(ctx.state.job, null)
  assert.match(ctx.said[0], /cannot see/)
})
