// The announcer (announcer.js): what a bot is doing, said in chat under the rate rules, no server needed:
//   node --test bridge/danger_sensing_agents/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { Announcer, announce, announceWhy, GAP_MS, REPEAT_MS, STALL_MS, STALE_MS } = require('../announcer')
const { parseMessage } = require('../commands')
const { makeModes } = require('../behaviors')
const { Friends } = require('../targets')
const { Agents } = require('../agents')

function setup ({ current = null } = {}) {
  let t = 1000000
  const clock = { now: () => t, add: ms => { t += ms } }
  const lines = []
  const a = new Announcer({ say: text => lines.push(text), now: clock.now, current })
  const { bot } = makeBot({ groundY: 63 })
  // every tick of a second in one go: the waiting lines and the stall check
  const pass = ms => { for (let i = 0; i < ms; i += 250) { clock.add(250); a.tick(bot) } }
  return { a, clock, lines, bot, pass }
}

test('a change of mode is said at once, a step waits for 5 s of quiet', () => {
  const s = setup()
  s.a.modeChanged('mine', 'mining iron 0/3')
  s.a.step('digging down to Y 16')
  assert.deepEqual(s.lines, ['mining iron 0/3'])
  s.pass(GAP_MS - 500)
  assert.deepEqual(s.lines, ['mining iron 0/3'], 'not before 5 s')
  s.pass(1000)
  assert.deepEqual(s.lines, ['mining iron 0/3', 'digging down to Y 16'])
})

test('the same line is never said twice within 30 s', () => {
  const s = setup()
  s.a.step('stuck, trying another path')
  s.pass(GAP_MS + 1000)
  s.a.step('stuck, trying another path')
  s.pass(GAP_MS + 1000)
  assert.equal(s.lines.length, 1)
  s.pass(REPEAT_MS)
  s.a.step('stuck, trying another path')
  assert.equal(s.lines.length, 2)
})

test('changes of task and key news go out at once, at most 3 in 5 s, the rest waits', () => {
  const s = setup()
  s.a.modeChanged('mine', 'mining iron 0/3')
  s.a.modeChanged('mobfight', 'zombie close, fighting')
  s.a.step('My pickaxe broke', { force: true })
  s.a.modeChanged('eat', 'eating, food at 6')
  assert.deepEqual(s.lines, ['mining iron 0/3', 'zombie close, fighting', 'My pickaxe broke'])
  s.pass(GAP_MS + 500)
  assert.equal(s.lines[3], 'eating, food at 6')
})

test('a step that waited too long is dropped, and a new task drops the old steps but keeps the key news', () => {
  const s = setup()
  s.a.modeChanged('mine', 'mining iron 0/3')
  for (let i = 0; i < 4; i++) s.a.step(`Found iron (${i + 1}/3)`)
  s.a.modeChanged('mobfight', 'zombie close, fighting')
  s.a.modeChanged('mine', 'mining iron 1/3')
  s.a.step('I died at 1 2 3', { force: true })  // a fourth forced line within 5 s waits its turn
  s.pass(GAP_MS + 500)
  assert.deepEqual(s.lines, ['mining iron 0/3', 'zombie close, fighting', 'mining iron 1/3', 'I died at 1 2 3'])
  const q = setup()
  q.a.step('one')
  q.a.step('two')
  q.clock.add(STALE_MS + 1)
  q.a.tick(q.bot)
  assert.deepEqual(q.lines, ['one'], 'two waited too long')
})

test('no move and no change in the bag for 20 s with a task is a stall, said once, with the reason when known', () => {
  const s = setup()
  s.a.modeChanged('mine', 'mining iron 1/3')
  s.a.step('digging down to Y 16')
  s.pass(STALL_MS + 2000)
  const stall = s.lines.find(l => /^stalled/.test(l))
  assert.ok(stall, s.lines.join(' | '))
  assert.match(stall, /^stalled 2\d s: mining iron 1\/3, digging down to Y 16$/)
  s.pass(STALL_MS)
  assert.equal(s.lines.filter(l => /^stalled/.test(l)).length, 1, 'said once per stall')
  // it moves, then stops again: a new stall, with the reason a skill gave
  s.bot.entity.position = s.bot.entity.position.offset(3, 0, 0)
  announceWhy(s.bot, 'no-op')  // no announcer on this bot: nothing happens
  s.a.reason('waiting for the furnace')
  s.pass(STALL_MS + 2000)
  assert.match(s.lines.filter(l => /^stalled/.test(l))[1] || '', /waiting for the furnace$/)
  // a change in the bag is progress too
  const q = setup()
  q.a.modeChanged('gather', 'gathering wood 1/8')
  q.pass(STALL_MS / 2)
  q.bot.give('oak_log', 1)
  q.pass(STALL_MS / 2 + 2000)
  assert.ok(!q.lines.some(l => /^stalled/.test(l)), q.lines.join(' | '))
})

test('standing still is no stall while idle or following', () => {
  for (const task of ['idle', 'following you']) {
    const s = setup()
    s.a.modeChanged(task, task)
    s.pass(STALL_MS * 2)
    assert.ok(!s.lines.some(l => /^stalled/.test(l)), task)
  }
})

test('!doing says the task as it is now, the step and how long it has been on each', () => {
  let progress = 'mining iron 0/3'
  const s = setup({ current: () => progress })
  s.a.modeChanged('mine', progress)
  s.pass(65000)
  progress = 'mining iron 2/3'
  s.bot.give('raw_iron', 2)
  s.a.step('branch mining at Y 16')
  s.pass(10000)
  assert.equal(s.a.doing(), 'mining iron 2/3 for 1 min 15 s, step: branch mining at Y 16 (10 s)')
  const p = parseMessage('!Agent1 doing', ['Agent1'])
  assert.equal(p.command.name, 'doing')
})

test('skills reach the bot\'s announcer through announce(bot, text), and nothing breaks without one', () => {
  const s = setup()
  s.bot.agentsAnnounce = s.a
  announce(s.bot, 'stuck, trying another path')
  assert.deepEqual(s.lines, ['stuck, trying another path'])
  announce({}, 'nobody listens')
  announce(null, 'nobody listens')
})

// The agents: modes say their changes, agents.event goes through the announcer, and !doing answers
function agentsSetup () {
  const { bot } = makeBot({ groundY: 63 })
  bot.give('bread', 16)
  const agents = Object.create(Agents.prototype)
  Object.assign(agents, {
    owner: 'Owner', names: ['Agent1'], ctxs: new Map(), friends: new Friends('Owner', ['Agent1']),
    verbosity: 'normal', lastAnnounce: { text: '', at: 0 }, lastEvent: new Map(), metricsFile: null, closing: false,
    log: () => {}, miner: 'branch'
  })
  agents.noDigMoves = agents.digMoves = agents.buildMoves = () => ({})
  agents.ensureKit = async () => {}
  agents.blackboard = { clear () {} }
  const ctx = { bot, agents, alive: true, seq: 0, pickaxes: null }
  const m = makeModes(ctx)
  agents.ctxs.set('Agent1', ctx)
  return { bot, agents, ctx, m }
}

test('a zombie walking up says the fight, and the job says it is back when it gets control again', () => {
  const { bot, ctx, m } = agentsSetup()
  // a job that waits for materials and stays on: a craft with nothing in the bag and no gatherer to ask
  ctx.manager.byName.delete('gather')
  ctx.agents.execute(ctx, { name: 'craft', args: { item: 'stone_pickaxe', requester: 'Owner' } })
  const crafting = () => bot.chats.filter(c => /^crafting a stone pickaxe/.test(c)).length
  m.tick()
  assert.equal(crafting(), 1, bot.chats.join(' | '))
  const at = bot.entity.position
  const z = { id: 5, type: 'hostile', name: 'zombie', position: at.offset(0, 0, 2), height: 1.95 }
  bot.entities[z.id] = z
  ctx.danger.update()
  m.tick()
  assert.equal(m.active.name, 'mobfight')
  assert.equal(bot.chats[bot.chats.length - 1], 'zombie close, fighting')
  delete bot.entities[z.id]
  ctx.danger.update()
  ctx.manager.get('craft').job.phase = 'run'
  m.tick()
  assert.equal(m.active.name, 'craft')
  assert.match(bot.chats[bot.chats.length - 1], /^back to crafting a stone pickaxe/)
  m.stopNow()
})

test('agents news goes through the announcer: one line every 5 s, key news at once', () => {
  const { bot, agents } = agentsSetup()
  const before = bot.chats.length
  agents.event(bot, 'normal', 'a', 'Following a cave for iron', 0)
  agents.event(bot, 'normal', 'b', 'At Y 16, branch mining for iron', 0)
  agents.event(bot, 'key', 'died', 'I died at 1 64 2', 0)
  assert.deepEqual(bot.chats.slice(before), ['Following a cave for iron', 'I died at 1 64 2'])
  agents.execute(agents.ctxs.get('Agent1'), { name: 'doing', args: {} })
  assert.match(bot.chats[bot.chats.length - 1], /^idle for \d+ s/)
})
