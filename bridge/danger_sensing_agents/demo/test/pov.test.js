// The demo from the player's own view, without a server: the base, the stocked chest, spectating and the handover.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { loadSettings } = require('../settings')
const { parseDemoCommand, HELP_LINES } = require('../words')
const scene = require('../scene')
const { DemoController } = require('../controller')
const { DemoAgents } = require('../run')
const { Agents } = require('../../agents')
const { planGoal } = require('../../goal_plan')
const { ModeManager, Mode } = require('../../modes')
const { walkHome, walkToSpot } = require('../walk_home')

const CONFIG = { host: '127.0.0.1', port: 25566, version: '1.21.11', owner: null, bots: ['Agent1'], fighter_run: 'weights/fighter' }
const STAGE = { x: 10, y: -60, z: 20 }
const S = { ...loadSettings({ DEMO_PLAYER: 'Viewer' }, CONFIG), stage: STAGE }
const KIT = [['stone_axe', 1], ['shield', 1], ['bread', 6]]
const PICK = 'clear Viewer minecraft:diamond_pickaxe 0'
const found = n => (n ? `Found ${n} matching item(s) on player Viewer` : 'No items were found on player Viewer')
const tpTo = (name, p, yaw) => `tp ${name} ${p.x + 0.5} ${p.y} ${p.z + 0.5} ${yaw} 0`

function rig (replies = {}) {
  const sent = []
  const rcon = {
    sent,
    has: text => sent.some(c => c.includes(text)),
    send: async c => {
      sent.push(c)
      for (const [start, reply] of Object.entries(replies)) if (c.startsWith(start)) return typeof reply === 'function' ? reply(c) : reply
      return ''
    }
  }
  let id = 0
  const timers = {
    intervals: new Map(),
    timeouts: new Map(),
    setInterval: fn => { timers.intervals.set(++id, fn); return id },
    clearInterval: i => timers.intervals.delete(i),
    setTimeout: (fn, ms) => { timers.timeouts.set(++id, { fn, ms }); return id },
    clearTimeout: i => timers.timeouts.delete(i),
    now: () => 0
  }
  const bot = { entity: { position: { x: 0, y: -60, z: 0 } }, health: 20 }
  const agents = {
    forgotten: [],
    agentBot: () => bot,
    stopAgent: async () => {},
    runTask: async () => {},
    forgetChest: p => agents.forgotten.push(p)
  }
  const child = new EventEmitter()
  child.go = () => {}
  child.stop = () => {}
  const c = new DemoController({ settings: S, rcon, agents, spawnDuel: () => child, timers, sleep: async () => {}, hostile: ['spider'] })
  return { c, rcon, timers, agents, bot, child }
}

function demoAgents () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-pov-'))
  const a = new DemoAgents({ names: [S.agent], run: S.agentRun, translator: false, owner: S.player, builds: path.join(dir, 'b.json') }, S)
  a.seeWaitMs = 0
  return { a, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('reset: he stands in his base facing the agent, with a way out and the agent\'s kit', () => {
  const list = scene.resetCommands(S, STAGE)
  const b = scene.baseLayout(STAGE)
  assert.ok(list.includes(tpTo('Viewer', b.player, -90)))
  assert.ok(list.includes(tpTo('Agent1', b.agent, 90)))
  assert.equal(b.player.z, b.agent.z)
  assert.ok(b.agent.x > b.player.x)
  for (const p of [b.player, b.agent, b.hand]) assert.ok(Math.max(Math.abs(p.x - b.center.x), Math.abs(p.z - b.center.z)) < b.half)
  assert.ok(list.some(c => c.includes('red_bed')))
  assert.ok(list.some(c => c.startsWith(`setblock ${b.chest.x} ${b.chest.y} ${b.chest.z} chest[`)))
  assert.ok(list.some(c => c.startsWith(`setblock ${b.furnace.x} ${b.furnace.y} ${b.furnace.z} furnace[`)))
  const gap = `fill ${b.opening.from.x} ${b.opening.from.y} ${b.opening.from.z} ${b.opening.to.x} ${b.opening.to.y} ${b.opening.to.z} air`
  const lastWall = list.map(c => c.endsWith('cobblestone')).lastIndexOf(true)
  assert.ok(list.indexOf(gap) > lastWall, 'the gap is cut after the walls go up')
  assert.equal(b.opening.to.y - b.opening.from.y, 1, 'two blocks high, so the agent fits')
  for (const k of scene.agentKitCommands('Agent1')) assert.ok(list.includes(k))
  assert.ok(list.indexOf(tpTo('Viewer', b.player, -90)) > list.indexOf(gap))
  assert.ok(!list.some(c => c.startsWith('item replace block')), 'a plain reset leaves the chest empty')
})

test('no dummy joins, is whitelisted or receives anything in the default flow', () => {
  assert.ok(!('dummy' in S))
  assert.ok(!scene.resetCommands(S, STAGE).some(c => /dummy/i.test(c)))
  const source = fs.readFileSync(path.join(__dirname, '..', 'run.js'), 'utf8')
  assert.ok(!/dummy|createBot/i.test(source))
  const { a, done } = demoAgents()
  assert.equal(a.connectDummy, undefined)
  assert.ok(!a.friends.has('Dummy'))
  done()
})

test('!chest stocks exactly the list, a plain reset does not, and the agent forgets the chest each time', async () => {
  assert.deepEqual(parseDemoCommand('!chest'), { name: 'chest' })
  assert.ok(parseDemoCommand('!chest now').error)
  const { c, rcon, agents } = rig()
  c.stage = STAGE
  await c.handle('!chest', 'Viewer')
  const b = scene.baseLayout(STAGE)
  const stocked = rcon.sent.filter(s => s.startsWith('item replace block'))
  assert.deepEqual(stocked, scene.CHEST_STOCK.map(([item, n], i) =>
    `item replace block ${b.chest.x} ${b.chest.y} ${b.chest.z} container.${i} with minecraft:${item} ${n}`))
  assert.ok(rcon.sent.findIndex(s => s.includes(' chest[')) < rcon.sent.indexOf(stocked[0]))
  assert.deepEqual(agents.forgotten, [b.chest])
  rcon.sent.length = 0
  await c.handle('!reset', 'Viewer')
  assert.ok(!rcon.has('item replace block'))
  assert.equal(agents.forgotten.length, 2)
})

test('the stocked chest gives a plan that takes from it and gathers nothing, and an empty one runs the whole pathway', () => {
  const b = scene.baseLayout(STAGE)
  const plan = stock => planGoal({ item: 'diamond_pickaxe', count: 1 }, {
    bag: new Map(KIT),
    chests: [{ pos: b.chest, items: new Map(stock), distance: 3 }],
    owner: null,
    expectsRaw: true
  })
  const full = plan(scene.CHEST_STOCK)
  assert.deepEqual(full.steps.map(s => s.kind), ['take', 'craft', 'walk', 'hand'])
  assert.deepEqual(full.steps[0].pos, b.chest)
  assert.deepEqual(new Map(full.steps[0].items), new Map(scene.CHEST_STOCK))
  const empty = plan([])
  assert.ok(!empty.steps.some(s => s.kind === 'take'))
  assert.ok(empty.steps.some(s => s.kind === 'gather' && s.what === 'diamond'))
})

test('the agent plans for the player, with the chest and without waiting on a spectator\'s bag', async () => {
  const { a, done } = demoAgents()
  const b = scene.baseLayout(STAGE)
  const bot = {
    entity: { position: { x: b.agent.x, y: b.agent.y, z: b.agent.z } },
    inventory: { items: () => KIT.map(([name, count]) => ({ name, count })) },
    agentsChests: { prune: () => 0, list: () => [{ pos: b.chest, items: new Map(scene.CHEST_STOCK), seen: 1 }] }
  }
  const sources = a.goalSources({ bot }, true, new Map([['diamond', 64]]), true)
  assert.equal(sources.owner, null)
  assert.equal(sources.chests.length, 1)
  const steps = planGoal({ item: 'diamond_pickaxe', count: 1 }, { ...sources, expectsRaw: true }).steps
  assert.equal(steps[0].kind, 'take')
  assert.ok(!steps.some(s => s.kind === 'ask' || s.kind === 'gather'))
  const real = Agents.prototype.runGoal
  let who = null
  Agents.prototype.runGoal = async (ctx, args, requester) => { who = [args.requester, requester]; return 'done' }
  try {
    await a.runGoal({}, { item: 'diamond_pickaxe', count: 1 }, 'Someone')
  } finally {
    Agents.prototype.runGoal = real
  }
  assert.deepEqual(who, ['Viewer', 'Viewer'])
  assert.equal(a.owner, 'Viewer')
  done()
})

test('a task leaves him where he is as a spectator, with his camera his own', async () => {
  const { c, rcon } = rig({ [PICK]: found(0) })
  c.stage = STAGE
  await c.taskStarted('diamond_pickaxe')
  assert.equal(c.state, 'run')
  assert.ok(rcon.sent.includes('gamemode spectator Viewer'))
  assert.ok(!rcon.has('spectate '))
  assert.ok(!rcon.sent.some(s => s.startsWith('tp Viewer')))
})

test('!follow attaches, comes back after a respawn, and !unfollow lets go', async () => {
  const { c, rcon, bot, timers } = rig({ [PICK]: found(0) })
  c.stage = STAGE
  await c.handle('!follow', 'Viewer')
  assert.ok(!rcon.has('spectate Agent1'), 'nothing to follow outside a task')
  await c.taskStarted('diamond_pickaxe')
  await c.handle('!follow', 'Viewer')
  assert.equal(rcon.sent.filter(s => s === 'spectate Agent1 Viewer').length, 1)
  rcon.sent.length = 0
  bot.health = 0
  await c.agentSpawned()
  assert.ok(!rcon.has('spectate Agent1'))
  bot.health = 20
  await c.agentSpawned()
  assert.equal(rcon.sent.filter(s => s === 'spectate Agent1 Viewer').length, 1)
  const retry = [...timers.timeouts.values()].find(t => t.ms === 3000)
  assert.ok(retry, 'tries once more in case the new body was not ready')
  await retry.fn()
  assert.equal(rcon.sent.filter(s => s === 'spectate Agent1 Viewer').length, 2)
  rcon.sent.length = 0
  await c.handle('!unfollow', 'Viewer')
  assert.ok(rcon.sent.includes('execute as Viewer run spectate'))
  rcon.sent.length = 0
  await c.agentSpawned()
  assert.ok(!rcon.has('spectate Agent1'), 'after !unfollow a respawn does not grab the camera')
})

test('handover after he flew away: he is brought back in a normal mode and the item is counted', async () => {
  let held = 0
  const { c, rcon, timers } = rig({ [PICK]: () => found(held) })
  c.stage = STAGE
  await c.taskStarted('diamond_pickaxe', 1)
  await c.handle('!follow', 'Viewer')
  assert.ok(timers.timeouts.size >= 2)
  rcon.sent.length = 0
  assert.equal(await c.playerHome(), true)
  const home = tpTo('Viewer', scene.spots(STAGE).player, -90)
  assert.deepEqual(rcon.sent, [scene.REMOVE_BODY, 'gamemode survival Viewer', 'gamemode creative Viewer', home])
  assert.equal(c.following, false)
  assert.equal(timers.timeouts.size, 0, 'no staged mob during the handover')
  held = 1
  await c.taskEnded('done')
  assert.equal(c.state, 'idle')
  assert.equal(rcon.sent.filter(s => s === home).length, 1)
  assert.ok(rcon.sent.some(s => s.includes('Done: you have the diamond pickaxe')))
})

test('the handover only counts an item he did not already hold', async () => {
  const { c, rcon } = rig({ [PICK]: found(1) })
  c.stage = STAGE
  await c.taskStarted('diamond_pickaxe', 1)
  await c.playerHome()
  await c.taskEnded('done')
  assert.ok(rcon.sent.some(s => s.includes('did not pick up')))
  assert.ok(!rcon.has('Done: you have'))
})

test('a task that fails still brings him back to the base, and nothing is claimed', async () => {
  const { c, rcon } = rig({ [PICK]: found(0) })
  c.stage = STAGE
  await c.taskStarted('diamond_pickaxe', 1)
  await c.taskEnded('failed')
  assert.ok(rcon.sent.includes(tpTo('Viewer', scene.spots(STAGE).player, -90)))
  assert.ok(rcon.sent.includes('gamemode creative Viewer'))
  assert.ok(rcon.sent.some(s => s.includes('ended: failed')))
})

test('the walk to him goes to the base, and he is only moved once the agent has arrived', async () => {
  const { a, done } = demoAgents()
  const spots = scene.spots(STAGE)
  const calls = []
  a.say = () => {}
  a.walkToBase = async (ctx, at) => { calls.push({ walkedTo: at }); return result }
  a.controller = { stage: STAGE, playerHome: async () => { calls.push('home'); bot.players.Viewer = { entity: { position: { x: spots.player.x + 0.5, y: spots.player.y, z: spots.player.z + 0.5 } } }; return true } }
  // what it last saw of him is far away, from before he became a spectator
  const bot = { players: { Viewer: { entity: { position: { x: 900, y: 120, z: -400 } } } } }
  const real = Agents.prototype.execute
  let result = 'done'
  Agents.prototype.execute = async (ctx, command) => { calls.push(command); return result }
  try {
    assert.equal(await a.execute({ bot }, { name: 'walk', args: { to: 'Viewer' } }), 'done')
    assert.deepEqual(calls[0], { walkedTo: spots.hand })
    assert.equal(calls[1], 'home')
    calls.length = 0
    result = 'far'
    assert.equal(await a.execute({ bot }, { name: 'walk', args: { to: 'Viewer' } }), 'far')
    assert.ok(!calls.includes('home'), 'an agent that never got back does not pull him home')
    calls.length = 0
    result = 'done'
    await a.execute({ bot }, { name: 'walk', args: { to: 'Other' } })
    assert.deepEqual(calls, [{ name: 'walk', args: { to: 'Other' } }])
    bot.players.Viewer.entity.position = { x: 900, y: 120, z: -400 }
    a.controller.playerHome = async () => true
    assert.equal(await a.execute({ bot }, { name: 'walk', args: { to: 'Viewer' } }), 'far', 'an old sighting far away is not him')
  } finally {
    Agents.prototype.execute = real
  }
  done()
})

test('!evil uses the base he is in, keeps a stocked chest, and closes the gap first', async () => {
  const { c, rcon } = rig({ 'director status': 'Unknown command' })
  c.stage = STAGE
  await c.handle('!chest', 'Viewer')
  rcon.sent.length = 0
  await c.handle('!evil', 'Viewer')
  assert.ok(!rcon.has('red_bed'), 'no second base')
  assert.ok(!rcon.has(' chest['))
  assert.ok(!rcon.sent.some(s => s.includes(' air') && s.startsWith('fill')), 'nothing in the base is cleared')
  const seal = scene.sealCommands(STAGE).find(c => c.includes('iron_door['))
  assert.ok(seal.includes('iron_door['), 'the door is shut, not walled over')
  const creeper = rcon.sent.findIndex(s => s.startsWith('summon minecraft:creeper'))
  assert.ok(rcon.sent.indexOf(seal) >= 0 && rcon.sent.indexOf(seal) < creeper)
  assert.ok(rcon.sent.includes(tpTo('Viewer', scene.spots(STAGE).player, -90)))
  await c.handle('!stop', 'Viewer')
  rcon.sent.length = 0
  await c.handle('!evil', 'Viewer')
  assert.ok(rcon.has('red_bed'), 'a base already blown up is put back')
})

test('!1v1 returns him to the base', async () => {
  const { c, rcon, child } = rig({ 'scoreboard players get': n => `${n.split(' ')[3]} has 0 [demo_deaths]` })
  c.stage = STAGE
  const pending = c.handle('!1v1', 'Viewer')
  for (let i = 0; i < 60 && !child.listenerCount('ready'); i++) await new Promise(resolve => setImmediate(resolve))
  child.emit('ready')
  await pending
  assert.equal(c.state, 'duel')
  await c.finishDuel(c.duelRun, 'time')
  const tps = rcon.sent.filter(s => s.startsWith('tp Viewer'))
  assert.equal(tps[tps.length - 1], tpTo('Viewer', scene.spots(STAGE).player, -90))
  c.close()
})

test('the help names the new commands', () => {
  const text = HELP_LINES.join('\n')
  assert.match(text, /!chest/)
  assert.match(text, /!pov/)
  assert.match(text, /!spec/)
  assert.ok(!/dummy/i.test(text))
  assert.deepEqual(parseDemoCommand('!pov'), { name: 'follow' })
  assert.deepEqual(parseDemoCommand('!spec'), { name: 'unfollow' })
})

test('his body stays at his spot facing the agent during a task, and is gone when he is back', async () => {
  const { c, rcon } = rig({ [PICK]: found(0), 'data get entity Viewer Pos': 'Viewer has the following entity data: [-7.5d, -60.0d, 20.5d]' })
  c.stage = STAGE
  await c.taskStarted('diamond_pickaxe', 1)
  const body = rcon.sent.find(s => s.startsWith('summon minecraft:mannequin'))
  assert.ok(body.startsWith('summon minecraft:mannequin -7.5 -60 20.5 {'))
  for (const part of ['Tags:["demo_body"]', 'NoGravity:1b', 'Invulnerable:1b', 'immovable:1b', 'hide_description:1b', 'Rotation:[-90f,0f]', 'profile:{name:"Viewer"}']) assert.ok(body.includes(part), part)
  assert.ok(rcon.sent.indexOf(body) < rcon.sent.indexOf('gamemode spectator Viewer'))
  rcon.sent.length = 0
  await c.playerHome()
  assert.equal(rcon.sent[0], 'kill @e[tag=demo_body]')
  rcon.sent.length = 0
  await c.taskEnded('failed')
  assert.ok(!rcon.has('demo_body'), 'removed once')
})

test('!reset and !stop take the body away, and it is never on the mob purge', async () => {
  for (const word of ['!reset', '!stop', '!chest']) {
    const { c, rcon } = rig({ [PICK]: found(0) })
    c.stage = STAGE
    await c.taskStarted('diamond_pickaxe', 1)
    rcon.sent.length = 0
    await c.handle(word, 'Viewer')
    assert.ok(rcon.sent.includes(scene.REMOVE_BODY), word)
    assert.equal(c.bodyUp, false)
  }
  assert.ok(scene.resetCommands(S, STAGE).includes(scene.REMOVE_BODY), 'a body left by a crash goes too')
  assert.ok(!scene.hostileToRemove('1.21.11').includes('mannequin'))
})

test('the flow still works when the body cannot be placed', async () => {
  const { c, rcon } = rig({ [PICK]: found(0), 'summon minecraft:mannequin': () => { throw new Error('Unknown entity') } })
  c.stage = STAGE
  await c.taskStarted('diamond_pickaxe', 1)
  assert.equal(c.state, 'run')
  assert.ok(rcon.sent.includes('gamemode spectator Viewer'))
  assert.ok(rcon.sent.find(s => s.startsWith('summon minecraft:mannequin')).includes(`${scene.spots(STAGE).player.x + 0.5} -60`), 'falls back to his base spot')
  await c.taskEnded('failed')
  assert.equal(c.state, 'idle')
  assert.ok(rcon.sent.includes('gamemode creative Viewer'))
})

test('the walk home is a mode of its own: it ends at the spot and a stop ends it', async () => {
  const at = { x: 1, y: 0, z: 1 }
  const bot = { username: 'Agent1', entity: { position: { x: 1.5, y: 0, z: 1.5 } }, pathfinder: { setMovements () {}, setGoal () {} } }
  const agents = { noDigMoves: () => ({}), log: () => {} }
  assert.equal(await walkToSpot({ bot, agents }, at, { cancelled: false }), 'done')
  assert.equal(await walkToSpot({ bot, agents }, at, { cancelled: true }), 'cancelled')
  class Craft extends Mode { constructor () { super('craft') } }
  const manager = new ModeManager([new Craft()])
  const job = walkHome({ bot, agents, manager }, at)
  assert.equal(manager.modes[0].name, 'demohome')
  manager.tick()
  assert.equal(await job, 'done')
  bot.entity.position = { x: 500, y: 0, z: 500 }
  const stopped = walkHome({ bot, agents, manager }, at)
  assert.equal(manager.modes.filter(m => m.name === 'demohome').length, 1)
  manager.stopNow()
  assert.equal(await stopped, 'stopped')
})
