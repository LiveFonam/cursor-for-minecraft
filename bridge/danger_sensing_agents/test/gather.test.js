// The gatherer role (skills/gather_kinds.js, skills/gatherer.js, GatherMode), no server needed:
//   node --test bridge/danger_sensing_agents/test/gather.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { parseMessage, formatCommand } = require('../commands')
const { resolveKind, parseGatherArgs, parseGatherRequest, kindOfItem, tasksFromItems, carriedOf } = require('../skills/gather_kinds')
const { gatherKind, missingTool } = require('../skills/gatherer')
const { bringWood } = require('../skills/mine_branch')
const { gather } = require('../skills/gather')
const { makeModes } = require('../behaviors')
const { Friends, Blackboard } = require('../targets')
const { Agents } = require('../agents')

const OWNER = 'OwnerPlayer'
const names = ['Agent1', 'Agent2']
const human = { level: 'off', placesTorches: true, nextTorchGap: () => 3, idleMoment: async () => {}, lookAtPoint: async () => {}, lookAround: async () => {}, detourPoint: () => null }

// ---------- words ----------

test('the four kinds and the words for them', () => {
  for (const w of ['wood', 'logs', 'trees', 'oak_log', 'birch logs', 'some wood']) assert.equal(resolveKind(w), 'wood', w)
  for (const w of ['cobblestone', 'cobble', 'stone', 'rocks']) assert.equal(resolveKind(w), 'cobblestone', w)
  for (const w of ['iron', 'iron ore', 'raw iron', 'Raw-Iron']) assert.equal(resolveKind(w), 'iron', w)
  for (const w of ['diamonds', 'diamond', 'minecraft:diamond', 'diamond ore']) assert.equal(resolveKind(w), 'diamond', w)
  for (const w of ['gold', 'coal', 'dirt', '', 'the stuff']) assert.equal(resolveKind(w), null, w)
})

test('counts: the default per kind, before or after the kind, and a cap', () => {
  assert.deepEqual(parseGatherArgs(['wood']), { kind: 'wood', count: 16 })
  assert.deepEqual(parseGatherArgs(['cobblestone']), { kind: 'cobblestone', count: 32 })
  assert.deepEqual(parseGatherArgs(['iron']), { kind: 'iron', count: 8 })
  assert.deepEqual(parseGatherArgs(['diamonds']), { kind: 'diamond', count: 3 })
  assert.deepEqual(parseGatherArgs(['iron', '10']), { kind: 'iron', count: 10 })
  assert.deepEqual(parseGatherArgs(['10', 'iron']), { kind: 'iron', count: 10 })
  assert.match(parseGatherArgs(['iron', '999']).error, /at most 128/)
  assert.match(parseGatherArgs(['iron', '0']).error, /at least 1/)
  assert.match(parseGatherArgs(['gold']).error, /wood, cobblestone, iron, diamonds/)
})

test('chat: !gather, plain "gather ..." and "collect ...", to the agents or one bot', () => {
  const cmd = l => parseMessage(l, names)
  assert.deepEqual(cmd('!gather wood').command, { name: 'gather', args: { kind: 'wood', count: 16 } })
  assert.deepEqual(cmd('!Agent1 gather cobblestone 64'), { type: 'command', targets: ['Agent1'], command: { name: 'gather', args: { kind: 'cobblestone', count: 64 } } })
  assert.equal(cmd('gather iron 5').command.args.count, 5)
  assert.equal(cmd('please collect some diamonds').command.args.kind, 'diamond')
  assert.deepEqual(cmd('Agent2, gather 4 logs').targets, ['Agent2'])
  assert.equal(cmd('@agents gather wood').command.name, 'gather')
  assert.equal(cmd('!gather gold').type, 'error')
  assert.equal(cmd('@agents get me some wood and come back').type, 'translate', 'other phrasings go to the translator')
  assert.equal(cmd('the trees are nice'), null)
  assert.match(parseGatherRequest('gather round').error, /gather takes one of/)  // said back, never run
  assert.equal(formatCommand('all', { name: 'gather', args: { kind: 'diamond', count: 3 } }), '!gather diamonds 3')
})

test("the crafter's missing materials become gather tasks, one per kind", () => {
  assert.equal(kindOfItem('spruce_log'), 'wood')
  assert.equal(kindOfItem('cobbled_deepslate'), 'cobblestone')
  assert.equal(kindOfItem('raw_iron'), 'iron')
  assert.equal(kindOfItem('coal'), 'coal')
  assert.equal(kindOfItem('white_bed'), null)
  const { tasks, unknown } = tasksFromItems([{ name: 'cobblestone', count: 3 }, { name: 'oak_log', count: 1 }, { name: 'birch_log', count: 1 }, { name: 'raw_iron', count: 3 }, { name: 'string', count: 2 }])
  assert.deepEqual(tasks, [{ kind: 'cobblestone', count: 3 }, { kind: 'wood', count: 2 }, { kind: 'iron', count: 3 }])
  assert.deepEqual(unknown, ['string'])
})

// ---------- tools ----------

test('each kind says which pickaxe it needs', () => {
  const { bot } = makeBot()
  assert.equal(missingTool(bot, 'wood'), null)
  assert.match(missingTool(bot, 'cobblestone'), /need a pickaxe/)
  bot.give('wooden_pickaxe', 1)
  assert.equal(missingTool(bot, 'cobblestone'), null)
  assert.match(missingTool(bot, 'iron'), /stone pickaxe or better, I only have a wooden one/)
  const g = makeBot().bot
  g.give('golden_pickaxe', 1)
  assert.match(missingTool(g, 'iron'), /stone pickaxe or better, I only have a golden one/, 'gold can not mine iron')
  bot.give('golden_pickaxe', 1)
  bot.give('stone_pickaxe', 1)
  assert.equal(missingTool(bot, 'iron'), null)
  assert.match(missingTool(bot, 'diamond'), /iron pickaxe or better/)
  bot.give('iron_pickaxe', 1)
  assert.equal(missingTool(bot, 'diamond'), null)
})

test('no tool: nothing is dug, and it says what it needs', async () => {
  const { bot, world } = makeBot()
  const r = await gatherKind(bot, 'diamond', 3, { cancelled: false }, { human })
  assert.equal(r.result, 'no_tool')
  assert.match(r.message, /iron pickaxe/)
  assert.equal(world.digs, 0)
})

// ---------- the skills on the fake world ----------

// Real line of sight on the fake world: the ray stops at the first solid block
function realSight (bot, world) {
  bot.world.raycast = (from, dir, range) => {
    for (let t = 0; t <= range; t += 0.05) {
      const p = from.plus(dir.scaled(t)).floored()
      if (world.get(p).boundingBox === 'block') return { position: p, face: 0 }
    }
    return null
  }
}

// A natural oak (logs up into leaves the game placed) next to the bot, and a pillar of logs the owner placed
function woods () {
  const { bot, world } = makeBot({ groundY: 63 })
  bot.world.raycast = (from, dir, range) => {
    for (let t = 0; t <= range; t += 0.05) {
      const p = from.plus(dir.scaled(t)).floored()
      if (world.get(p).boundingBox === 'block') return { position: p, face: 0 }
    }
    return null
  }
  for (let y = 64; y <= 67; y++) world.set(new Vec3(2, y, 2), 'oak_log', { axis: 'y' })
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) world.set(new Vec3(x, 68, z), 'oak_leaves', { distance: 1, persistent: false, waterlogged: false })
  for (let y = 64; y <= 66; y++) world.set(new Vec3(-3, y, -3), 'oak_log', { axis: 'y' })
  return { bot, world }
}

test('wood: chops the natural tree, never a placed log pillar', async () => {
  const { bot, world } = woods()
  const r = await gatherKind(bot, 'wood', 3, { cancelled: false }, { human })
  assert.equal(r.result, 'done', r.message)
  assert.equal(carriedOf(bot.inventory.items(), 'wood'), 3)
  for (let y = 64; y <= 66; y++) assert.equal(world.name(new Vec3(-3, y, -3)), 'oak_log', 'the placed pillar stands')
})

test('wood: more than the tree has ends short and says so', async () => {
  const { bot } = woods()
  const r = await gatherKind(bot, 'wood', 10, { cancelled: false }, { human })
  assert.equal(r.result, 'none')
  assert.equal(r.got, 4)
  assert.match(r.message, /I got 4 of 10 logs: I couldn't find more wood nearby/)
})

test('iron: the miner finds it, keeps it in the bag and comes back', async () => {
  const at = new Vec3(0, 16, 0)
  const { bot, world } = makeBot({ groundY: 63, pos: at.offset(0.5, 0, 0.5) })
  world.set(at, 'air')
  world.set(at.offset(0, 1, 0), 'air')
  realSight(bot, world)
  bot.give('stone_pickaxe', 1)
  world.set(new Vec3(3, 17, -2), 'iron_ore')
  const token = { cancelled: false }
  const dig = bot.dig
  let n = 0
  bot.dig = async (...a) => { await dig(...a); if (++n > 400) token.cancelled = true }
  const r = await gatherKind(bot, 'iron', 1, token, { human, tuning: { branchLen: 4 } })
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.countOf('raw_iron'), 1)
  assert.ok(bot.entity.position.distanceTo(at.offset(0.5, 0, 0.5)) <= 4, 'back where it started')
})

const IRON_JOB = { blocks: ['iron_ore', 'deepslate_iron_ore'] }
const logsIn = bot => carriedOf(bot.inventory.items(), 'wood')

test('going for iron with a wooden spare and too little wood: it brings 2 logs first', async () => {
  const { bot } = woods()
  for (const [n, c] of [['stone_pickaxe', 1], ['wooden_pickaxe', 1], ['crafting_table', 1], ['stick', 1]]) bot.give(n, c)
  await bringWood(bot, { log: () => {} }, { cancelled: false }, IRON_JOB)
  assert.equal(logsIn(bot), 2)
})

test('wood for two new pickaxes, or a second pickaxe that can dig iron: no trip for logs', async () => {
  const enough = woods().bot
  for (const [n, c] of [['stone_pickaxe', 1], ['wooden_pickaxe', 1], ['crafting_table', 1], ['stick', 4]]) enough.give(n, c)
  await bringWood(enough, { log: () => {} }, { cancelled: false }, IRON_JOB)
  assert.equal(logsIn(enough), 0)
  const spare = woods().bot
  spare.give('stone_pickaxe', 2)
  await bringWood(spare, { log: () => {} }, { cancelled: false }, IRON_JOB)
  assert.equal(logsIn(spare), 0)
})

test('wood: with no walking way out of a ravine it digs to the spot, then goes back to walk moves', async () => {
  const { bot } = makeBot({ groundY: 63 })
  const [walk, dig] = [{ name: 'walk' }, { name: 'dig' }]
  bot.pathfinder.setMovements(walk)
  const used = []
  bot.pathfinder.goto = async () => {
    used.push(bot.pathfinder.movements.name)
    if (bot.pathfinder.movements === walk) throw new Error('No path to the goal!')
  }
  const r = await gatherKind(bot, 'wood', 1, { cancelled: false }, { human, digMoves: () => dig })
  assert.equal(r.result, 'none')
  assert.ok(used.includes('dig'), used.join(','))
  assert.equal(bot.pathfinder.movements, walk)
})

test('a canceled dig says nothing about the block: the same block is dug again', async () => {
  const { bot } = woods()
  const dig = bot.dig
  const dug = []
  bot.dig = async (b, ...r) => {
    dug.push(String(b.position))
    if (dug.length === 1) throw new Error('Digging aborted')
    return dig(b, ...r)
  }
  await gather(bot, 'oak_log', 1, { cancelled: false }, {})
  assert.equal(dug[1], dug[0], dug.join(' '))
})

test('a canceled dig on the way down a staircase does not end the gathering job', async () => {
  const { bot } = makeBot({ groundY: 63 })
  bot.give('wooden_pickaxe', 1)
  bot.findBlocks = () => []
  bot.pathfinder.goto = async () => {}
  const dig = bot.dig
  let n = 0
  bot.dig = async (b, ...r) => {
    if (++n === 1) throw new Error('Digging aborted')
    return dig(b, ...r)
  }
  await assert.doesNotReject(gather(bot, 'cobblestone', 1, { cancelled: false }, {}))
  assert.ok(n > 1, 'it dug again after the canceled dig')
})

test('a staircase for cobblestone cuts only the stone asked for, even when the drops reach the bag late', async () => {
  for (const want of [2, 3, 4]) {
    const { bot } = makeBot({ groundY: 63 })
    bot.give('wooden_pickaxe', 1)
    bot.findBlocks = () => []
    bot.pathfinder.goto = async () => {}
    const give = bot.give
    bot.give = (name, n) => {
      if (name === 'cobblestone') setTimeout(() => give(name, n), 30)
      else give(name, n)
    }
    await gather(bot, 'cobblestone', want, { cancelled: false }, {})
    assert.equal(bot.digged.filter(n => n === 'stone').length, want, `stone cut for ${want} cobblestone`)
    assert.equal(bot.inventory.items().find(i => i.name === 'cobblestone')?.count, want)
  }
})

function brokenPickaxeScene () {
  const at = new Vec3(0, 16, 0)
  const { bot, world } = makeBot({ groundY: 63, pos: at.offset(0.5, 0, 0.5) })
  for (const c of [at, at.offset(0, 1, 0), at.offset(1, 0, 0), at.offset(1, 1, 0)]) world.set(c, 'air')
  world.set(at.offset(-1, 0, 0), 'crafting_table')
  realSight(bot, world)
  bot.give('wooden_pickaxe', 1)
  bot.give('cobblestone', 3)
  bot.give('stick', 2)
  world.set(new Vec3(3, 17, -2), 'iron_ore')
  const token = { cancelled: false }
  const dig = bot.dig
  let n = 0
  bot.dig = async (...a) => { await dig(...a); if (++n > 400) token.cancelled = true }
  return { bot, token }
}

test('iron job coming back with its stone pickaxe broken: a new one from the bag, and it carries on', async () => {
  const { bot, token } = brokenPickaxeScene()
  const r = await gatherKind(bot, 'iron', 1, token, { human, tuning: { branchLen: 4 }, toolCtx: {} })
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.countOf('stone_pickaxe'), 1)
  assert.equal(bot.countOf('raw_iron'), 1)
})

test('a new iron job with only a wooden pickaxe still says what it needs and crafts nothing', async () => {
  const { bot, token } = brokenPickaxeScene()
  const r = await gatherKind(bot, 'iron', 1, token, { human, tuning: { branchLen: 4 } })
  assert.equal(r.result, 'no_tool')
  assert.equal(bot.countOf('stone_pickaxe'), 0)
  assert.equal(bot.countOf('cobblestone'), 3)
})

// ---------- the mode, through chat ----------

function agentsSetup ({ inv = {}, world: build = null } = {}) {
  const { bot, world } = build ? build() : makeBot({ groundY: 63 })
  for (const [n, c] of Object.entries(inv)) bot.give(n, c)
  const agents = Object.create(Agents.prototype)
  Object.assign(agents, {
    owner: OWNER, names: ['Agent1'], ctxs: new Map(), friends: new Friends(OWNER, ['Agent1']),
    blackboard: new Blackboard(), verbosity: 'normal', lastAnnounce: { text: '', at: 0 }, lastEvent: new Map(), metricsFile: null, closing: false,
    log: () => {}, miner: 'branch'
  })
  agents.noDigMoves = agents.digMoves = agents.buildMoves = () => ({})
  agents.ensureKit = async () => {}
  const ctx = { bot, agents, alive: true, seq: 0, pickaxes: null, human }
  const m = makeModes(ctx)
  agents.ctxs.set('Agent1', ctx)
  bot.give('bread', 16)  // enough food that the danger assessor's food run stays out of it
  return { bot, world, agents, ctx, m }
}

async function tickUntil (m, done, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    m.tick()
    if (done()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return false
}

test('"gather wood 3" in chat: the gather mode chops it, says so and ends', async () => {
  const { bot, agents, ctx, m } = agentsSetup({ world: woods })
  await agents.handleChat(bot, `<${OWNER}> gather wood 3`)
  assert.ok(m.get('gather').on)
  assert.ok(await tickUntil(m, () => !m.get('gather').on), bot.chats.join(' | '))
  assert.equal(carriedOf(bot.inventory.items(), 'wood'), 3)
  assert.ok(bot.chats.some(c => /Gathered 3 logs/.test(c)), bot.chats.join(' | '))
  assert.equal(ctx.manager.status(), 'idle')
})

test('the crafter, 1 cobblestone and 1 log short of a stone pickaxe, gets them through the real gatherer', async () => {
  const { bot, agents, world, m } = agentsSetup({ inv: { cobblestone: 2, wooden_pickaxe: 1 }, world: woods })
  world.set(new Vec3(-1, 64, 1), 'stone')  // a stone it can see
  world.set(new Vec3(3, 64, 0), 'crafting_table')
  bot.players[OWNER] = { username: OWNER, entity: { type: 'player', username: OWNER, position: new Vec3(4.5, 64, -1.5), height: 1.8 } }
  await agents.handleChat(bot, `<${OWNER}> craft me a stone pickaxe`)
  const gave = () => (bot.tossed || []).some(t => t.name === 'stone_pickaxe')
  assert.ok(await tickUntil(m, gave, 15000), bot.chats.join(' | '))
  assert.ok(bot.chats.some(c => /gathering it/.test(c)), bot.chats.join(' | '))
})
