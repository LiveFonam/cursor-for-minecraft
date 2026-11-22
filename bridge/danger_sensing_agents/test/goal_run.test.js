// A goal from the owner's chat line to the item in their hands, on the fake bot with the real modes and crafter. Only
// the gatherer is a stand-in that lands what it was asked for.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { Mode } = require('../modes')
const { makeModes } = require('../behaviors')
const { Friends, Blackboard } = require('../targets')
const { Agents } = require('../agents')
const { ChestMemory, chestView } = require('../chest_memory')
const { CONTAINERS } = require('../skills/storage')
const { addGoalStepMode } = require('../skills/goal_steps')
const { KINDS } = require('../skills/gather_kinds')

const OWNER = 'OwnerPlayer'

class FakeGather extends Mode {
  constructor (bot, log, result = () => 'done') {
    super('gather')
    this.profile = 'gather'
    this.bot = bot
    this.gathers = log
    this.result = result
  }

  enter () {
    const { kind, count, items } = this.params
    const list = items ? items.map(i => [i.name, i.count]) : [[KINDS[kind].items[0], count]]
    if (!items) this.gathers.push(`${kind} ${count}`)
    setTimeout(() => {
      if (!this.on) return
      for (const [n, c] of list) this.bot.give(n, c)
      this.finish(this.result(kind))
    }, 5)
  }
}

function setup ({ inv = {}, rcon = null, answer = null, owner = true, result } = {}) {
  const { bot, world } = makeBot({ groundY: 63 })
  for (const [n, c] of Object.entries(inv)) bot.give(n, c)
  bot.give('bread', 16)  // enough food that the danger assessor's food run stays out of it
  const agents = Object.create(Agents.prototype)
  Object.assign(agents, {
    owner: OWNER, names: ['Agent1'], ctxs: new Map(), friends: new Friends(OWNER, ['Agent1'], ['Friend2']),
    blackboard: new Blackboard(), verbosity: 'normal', lastAnnounce: { text: '', at: 0 }, lastEvent: new Map(), metricsFile: null, closing: false,
    log: () => {}, miner: 'branch', rcon, askWaitMs: 60
  })
  agents.noDigMoves = agents.digMoves = agents.buildMoves = () => ({})
  agents.ensureKit = async () => {}
  agents.blueprintNames = () => ['small_hut']
  const asked = []
  agents.translator = { enabled: true, translate: async (text, targets, state) => { asked.push({ text, state }); return answer } }
  const ctx = { bot, agents, alive: true, seq: 0, pickaxes: null, human: { level: 'off' } }
  const m = makeModes(ctx)
  const gathers = []
  const fake = new FakeGather(bot, gathers, result)
  m.modes[m.modes.indexOf(m.get('gather'))] = fake
  m.byName.set('gather', fake)
  addGoalStepMode(ctx)
  agents.ctxs.set('Agent1', ctx)
  bot.agentsChests = chestView(new ChestMemory(), bot, () => 'w', CONTAINERS)
  if (owner) bot.players[OWNER] = { username: OWNER, entity: { type: 'player', username: OWNER, position: new Vec3(4.5, 64, 0.5), height: 1.8 } }
  return { bot, world, agents, ctx, m, gathers, asked }
}

const chat = (agents, bot, text, sender = OWNER) => agents.handleChat(bot, `<${sender}> ${text}`)
const said = (bot, re) => bot.chats.some(c => re.test(c))
const gave = (bot, name) => bot.tossed.filter(t => t.name === name).reduce((n, t) => n + t.count, 0)

async function tickUntil (m, done, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    m.tick()
    if (done()) return true
    await new Promise(resolve => setTimeout(resolve, 3))
  }
  return false
}

test('"Agent1 make me an iron pickaxe" from an empty bag: gathers, crafts, smelts and hands it to the owner', async () => {
  const { bot, agents, m, gathers } = setup()
  await chat(agents, bot, 'Agent1 make me an iron pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.equal(gave(bot, 'iron_pickaxe'), 1)
  assert.equal(bot.countOf('iron_pickaxe'), 0)
  assert.deepEqual(gathers.map(g => g.split(' ')[0]), ['wood', 'cobblestone', 'cobblestone', 'iron'], '3 with the wooden pickaxe, the rest with the stone one')
  assert.ok(said(bot, /^On it: 1\) gather \d+ logs 2\) craft wooden pickaxe 3\) craft wooden axe to keep/), bot.chats.join(' | '))
  assert.ok(said(bot, /Here's your iron pickaxe, OwnerPlayer/))
  // the tools it made for itself stay with it
  assert.equal(bot.countOf('wooden_axe'), 1)
  assert.equal(bot.countOf('wooden_pickaxe'), 1)
  assert.equal(bot.countOf('stone_pickaxe'), 1)
  assert.equal(gave(bot, 'wooden_axe'), 0)
})

test('the whole diamond chain from an empty bag ends with the pickaxe handed over', async () => {
  const { bot, agents, m, gathers } = setup()
  await chat(agents, bot, 'make me a diamond pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/), 25000), bot.chats.join(' | '))
  assert.equal(gave(bot, 'diamond_pickaxe'), 1)
  assert.deepEqual(gathers.map(g => g.split(' ')[0]), ['wood', 'cobblestone', 'cobblestone', 'iron', 'diamond'])
  assert.equal(bot.countOf('iron_pickaxe'), 1)
  assert.equal(bot.countOf('wooden_axe'), 1)
})

test('a bag that already has an axe makes no second one', async () => {
  const { bot, agents, m } = setup({ inv: { stone_axe: 1 } })
  await chat(agents, bot, 'make me a wooden pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.equal(bot.countOf('wooden_axe'), 0)
  assert.equal(bot.countOf('stone_axe'), 1)
  assert.equal(gave(bot, 'wooden_pickaxe'), 1)
})

test('what it already carries is only walked over and handed', async () => {
  const { bot, agents, m, gathers } = setup({ inv: { diamond_pickaxe: 1 } })
  await chat(agents, bot, 'make me a diamond pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.equal(gave(bot, 'diamond_pickaxe'), 1)
  assert.deepEqual(gathers, [])
})

test('a raw material goal hands over exactly what was asked for, not the rest of the bag', async () => {
  const { bot, agents, m, ctx } = setup({ inv: { oak_log: 3, birch_log: 3, cobblestone: 5 } })
  agents.execute(ctx, { name: 'get', args: { item: 'wood', count: 4, requester: OWNER } })
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.equal(gave(bot, 'oak_log') + gave(bot, 'birch_log'), 4)
  assert.equal(bot.countOf('oak_log') + bot.countOf('birch_log'), 2)
  assert.equal(gave(bot, 'cobblestone'), 0)
  assert.equal(gave(bot, 'bread'), 0)
})

test('a nearby chest it never opened is checked, used and announced, and only what is needed leaves it', async () => {
  const { bot, world, agents, m, gathers } = setup({ inv: { stick: 2, crafting_table: 1 } })
  const pos = new Vec3(-3, 64, 2)
  world.fillChest(pos, [['diamond', 5], ['coal', 9]])
  await chat(agents, bot, 'make me a diamond pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.ok(said(bot, /Taking 3 diamonds from the chest at -3 64 2/), bot.chats.join(' | '))
  assert.equal(gave(bot, 'diamond_pickaxe'), 1)
  assert.deepEqual(gathers, [], 'nothing left to gather')
  const c = bot.agentsChests.list()[0]
  assert.equal(c.items.get('diamond'), 2)
  assert.equal(c.items.get('coal'), 9)
})

test('a remembered chest that turns out empty: it plans again and gathers instead', async () => {
  const { bot, world, agents, m, gathers } = setup({ inv: { iron_pickaxe: 1, stick: 2, crafting_table: 1 } })
  const pos = new Vec3(-3, 64, 2)
  world.fillChest(pos, [['coal', 1]])
  bot.agentsChests.saw(pos, new Map([['diamond', 3]]))
  await chat(agents, bot, 'make me a diamond pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.deepEqual(gathers, ['diamond 3'])
  assert.equal(bot.agentsChests.list()[0].items.get('diamond'), undefined, 'the memory now says what is really there')
  assert.equal(gave(bot, 'diamond_pickaxe'), 1)
})

const ownerHas = list => ({
  sent: [],
  async send (c) {
    this.sent.push(c)
    if (c === `data get entity ${OWNER} Inventory`) return `${OWNER} has the following entity data: [${list.map(([n, k], i) => `{Slot: ${i}b, id: "minecraft:${n}", count: ${k}}`).join(', ')}]`
    return ''
  }
})

test('the owner has the diamonds: it asks, they arrive, it never mines them', async () => {
  const rcon = ownerHas([['diamond', 3]])
  const { bot, agents, m, gathers, ctx } = setup({ inv: { stick: 2, crafting_table: 1 }, rcon })
  agents.askWaitMs = 3000
  await chat(agents, bot, 'make me a diamond pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /You have 3 diamonds, drop them to me/)), bot.chats.join(' | '))
  assert.equal(ctx.manager.status(), 'waiting for you to drop items')
  bot.give('diamond', 3)  // the owner's drop lands in the bag
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.deepEqual(gathers, [])
  assert.equal(gave(bot, 'diamond_pickaxe'), 1)
  for (const c of rcon.sent) assert.match(c, /^data get entity /, 'the console is only ever read')
})

test('a chest it has not opened yet comes before asking the owner', async () => {
  const rcon = ownerHas([['diamond', 3]])
  const { bot, world, agents, m } = setup({ inv: { stick: 2, crafting_table: 1 }, rcon })
  world.fillChest(new Vec3(-3, 64, 2), [['diamond', 3]])
  await chat(agents, bot, 'make me a diamond pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.ok(said(bot, /Taking 3 diamonds from the chest/), bot.chats.join(' | '))
  assert.ok(!said(bot, /You have/), bot.chats.join(' | '))
})

test('a chest 19 blocks away, where hunting left the bot in the live chest scene, is still looked into and used', async () => {
  const { bot, world, agents, m, gathers } = setup({ inv: { stick: 2, crafting_table: 1, iron_pickaxe: 1 } })
  world.fillChest(new Vec3(19, 64, 0), [['diamond', 3]])
  await chat(agents, bot, 'make me a diamond pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.ok(said(bot, /Taking 3 diamonds from the chest/), bot.chats.join(' | '))
  assert.deepEqual(gathers, [], 'nothing left to gather')
})

test('the owner ignores the request: after a short wait it gets its own', async () => {
  const rcon = ownerHas([['diamond', 3]])
  const { bot, agents, m, gathers } = setup({ inv: { iron_pickaxe: 1, stick: 2, crafting_table: 1 }, rcon })
  await chat(agents, bot, 'make me a diamond pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.ok(said(bot, /You have 3 diamonds/))
  assert.deepEqual(gathers, ['diamond 3'])
  assert.equal(bot.chats.filter(c => /You have/.test(c)).length, 1, 'it asks once')
  for (const c of rcon.sent) assert.ok(!/^(clear|give|item|data (modify|remove))/.test(c), c)
})

test('with no console it says it could not see the bag and still does the job', async () => {
  const { bot, agents, m } = setup()
  await chat(agents, bot, 'make me a stone pickaxe please')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.ok(said(bot, /I can't see your bag \(no server console\)/), bot.chats.join(' | '))
  assert.equal(gave(bot, 'stone_pickaxe'), 1)
})

test('a friend gets a crafted item but not the owner\'s chests or bag', async () => {
  const rcon = ownerHas([['diamond', 3]])
  const { bot, world, agents, m, ctx } = setup({ inv: { iron_pickaxe: 1, stick: 2, crafting_table: 1 }, rcon })
  world.fillChest(new Vec3(-3, 64, 2), [['diamond', 5]])
  bot.players.Friend2 = { username: 'Friend2', entity: { type: 'player', username: 'Friend2', position: new Vec3(-4.5, 64, 0.5), height: 1.8 } }
  await chat(agents, bot, 'make me a diamond pickaxe', 'Friend2')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/)), bot.chats.join(' | '))
  assert.ok(!said(bot, /Taking/), bot.chats.join(' | '))
  assert.ok(!said(bot, /You have/), bot.chats.join(' | '))
  assert.equal(rcon.sent.length, 0)
  assert.ok(said(bot, /Here's your diamond pickaxe, Friend2/))
  assert.equal(ctx.plan, null)
  // and a friend's other requests are ignored
  const before = bot.chats.length
  await chat(agents, bot, '!get diamond 5', 'Friend2')
  await tickUntil(m, () => false, 50)
  assert.equal(bot.chats.length, before)
})

test('too vague: it asks the question and does nothing', async () => {
  const { bot, agents, m, ctx, gathers } = setup({ answer: { lines: [], parsed: [], dropped: [], impossible: null, vague: 'What should I do?' } })
  await chat(agents, bot, '@agents do the thing')
  await tickUntil(m, () => false, 40)
  assert.deepEqual(bot.chats.filter(c => c !== 'idle'), ['Too vague for me: What should I do?'])
  assert.deepEqual(gathers, [])
  assert.equal(ctx.manager.status(), 'idle')
})

test('cannot do it: it says which part and why and does nothing', async () => {
  const { bot, agents, m, gathers } = setup({ answer: { lines: [], parsed: [], dropped: [], impossible: "I can't travel to the Nether", vague: null } })
  await chat(agents, bot, '@agents go to the nether')
  await tickUntil(m, () => false, 40)
  assert.deepEqual(bot.chats.filter(c => c !== 'idle'), ["That's impossible for me right now: I can't travel to the Nether"])
  assert.deepEqual(gathers, [])
})

test('a goal the script finds impossible says why and runs nothing', async () => {
  const answer = { lines: ['!get diamond_sword 1'], parsed: [{ targets: 'all', command: { name: 'get', args: { item: 'diamond_sword', count: 1 } } }], dropped: [], impossible: null, vague: null }
  const { bot, agents, m, gathers, asked } = setup({ answer })
  await chat(agents, bot, '@agents get me a diamond sword')
  assert.ok(await tickUntil(m, () => said(bot, /impossible for me right now: I can't make or gather diamond sword/)), bot.chats.join(' | '))
  assert.deepEqual(gathers, [])
  assert.equal(asked[0].state, undefined, 'the model gets the words and nothing else')
})

test('!stop while it waits for the owner ends the goal', async () => {
  const rcon = ownerHas([['diamond', 3]])
  const { bot, agents, m, ctx, gathers } = setup({ inv: { stick: 2, crafting_table: 1 }, rcon })
  agents.askWaitMs = 60000
  await chat(agents, bot, 'make me a diamond pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /You have 3 diamonds/)), bot.chats.join(' | '))
  await chat(agents, bot, '!stop')
  await tickUntil(m, () => false, 60)
  assert.equal(m.get('goalstep').on, false)
  assert.equal(ctx.manager.status(), 'idle')
  assert.deepEqual(gathers, [])
  assert.equal(gave(bot, 'diamond_pickaxe'), 0)
})

test('the owner out of sight with no console: it keeps the item and says so', async () => {
  const { bot, agents, m } = setup({ inv: { diamond_pickaxe: 1 }, owner: false })
  await chat(agents, bot, 'make me a diamond pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /I can't reach you/)), bot.chats.join(' | '))
  assert.equal(bot.countOf('diamond_pickaxe'), 1)
  assert.equal(gave(bot, 'diamond_pickaxe'), 0)
})

test('"craft me a diamond pickaxe" with no way to mine it goes through the planner too', async () => {
  const { bot, agents, m } = setup()
  await chat(agents, bot, 'craft me a diamond pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/), 25000), bot.chats.join(' | '))
  assert.equal(gave(bot, 'diamond_pickaxe'), 1)
})

test('a pickaxe lost on the way ends no goal: it plans again from the real bag and hands the pickaxe over', async () => {
  const ref = {}
  let lost = false
  const { bot, agents, m, gathers } = setup({
    result: kind => {
      if (kind !== 'iron' || lost) return 'done'
      lost = true
      ref.bot.take('stone_pickaxe', 1)
      ref.bot.take('raw_iron', ref.bot.countOf('raw_iron'))
      return 'no_tool'
    }
  })
  ref.bot = bot
  await chat(agents, bot, 'Agent1 make me an iron pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan/), 25000), bot.chats.join(' | '))
  assert.equal(gave(bot, 'iron_pickaxe'), 1)
  assert.equal(gathers.filter(g => g.startsWith('iron')).length, 2)
  assert.ok(!said(bot, /Stopping the plan/), bot.chats.join(' | '))
})

test('a goal that keeps losing its pickaxe stops after two new plans and says so', async () => {
  const ref = {}
  const { bot, agents, m, gathers } = setup({
    result: kind => {
      if (kind !== 'iron') return 'done'
      ref.bot.take('stone_pickaxe', ref.bot.countOf('stone_pickaxe'))
      ref.bot.take('raw_iron', ref.bot.countOf('raw_iron'))
      return 'no_tool'
    }
  })
  ref.bot = bot
  await chat(agents, bot, 'Agent1 make me an iron pickaxe')
  assert.ok(await tickUntil(m, () => said(bot, /Stopping the plan/), 25000), bot.chats.join(' | '))
  assert.equal(gathers.filter(g => g.startsWith('iron')).length, 3)
  assert.equal(gave(bot, 'iron_pickaxe'), 0)
})

test('the finished pickaxe lost before the handover (a death on the way): it plans again and still hands one over', async () => {
  const { bot, agents, m } = setup()
  await chat(agents, bot, 'Agent1 make me an iron pickaxe')
  // as in the live run: made, then a creeper on the walk over, so the handover step finds nothing to hand over
  let lost = false
  const look = bot.lookAt
  bot.lookAt = async (...a) => {
    if (!lost && new Error().stack.includes('runHand')) {
      lost = true
      bot.take('iron_pickaxe', 1)
    }
    return look(...a)
  }
  assert.ok(await tickUntil(m, () => said(bot, /Done with the plan|Stopping the plan/), 25000), bot.chats.join(' | '))
  assert.equal(lost, true)
  assert.ok(!said(bot, /Stopping the plan/), bot.chats.join(' | '))
  assert.equal(gave(bot, 'iron_pickaxe'), 1)
})

test('a part handed over and the rest lost is not planned again, so it never gives more than was asked', async () => {
  const { bot, agents, ctx, m } = setup({ inv: { oak_log: 3 } })
  const take = bot.toss
  bot.toss = async (...a) => { const r = await take(...a); bot.take('oak_log', bot.countOf('oak_log')); return r }
  agents.execute(ctx, { name: 'get', args: { item: 'wood', count: 3, requester: OWNER } })
  await tickUntil(m, () => said(bot, /Done with the plan|Stopping the plan/), 6000)
  assert.ok(gave(bot, 'oak_log') <= 3)
})

