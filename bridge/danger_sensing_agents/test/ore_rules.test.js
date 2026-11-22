'use strict'
// Marking diamonds without digging them
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { mineJob } = require('../skills/mine')
const { OreMarks, saysYesToDiamonds, answerDiamonds } = require('../skills/ore_marks')

const human = {
  level: 'off',
  placesTorches: false,
  nextTorchGap: () => 99,
  idleMoment: async () => {},
  lookAtPoint: async () => {},
  lookAround: async () => {},
  detourPoint: () => null
}
const IRON = ['iron_ore', 'deepslate_iron_ore']
const DIAMOND = ['diamond_ore', 'deepslate_diamond_ore']

// An open room 5 wide and 2 high around the bot, in solid stone at Y 16. Anything put in its walls is in plain view
function room ({ pick = 'iron_pickaxe', length = 2, digLimit = 60 } = {}) {
  const at = new Vec3(0, 16, 0)
  const { bot, world } = makeBot({ groundY: 63, pos: at.offset(0.5, 0, 0.5) })
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= length; z++) {
      world.set(new Vec3(x, 16, z), 'air')
      world.set(new Vec3(x, 17, z), 'air')
    }
  }
  bot.give(pick, 1)
  bot.give('cobblestone', 16)
  const token = { cancelled: false }
  const digs = []
  const dig = bot.dig.bind(bot)
  bot.dig = async (block, ...rest) => {
    digs.push({ name: block.name, pos: block.position.clone() })
    if (digs.length >= digLimit) token.cancelled = true
    return dig(block, ...rest)
  }
  return { bot, world, token, digs, at }
}

function ironJob (bot, count, extra = {}) {
  const start = bot.countOf('raw_iron')
  return { block: 'iron', blocks: IRON, count, mined: 0, want: count, inBag: () => bot.countOf('raw_iron') - start, strategy: 'branch', home: null, store: false, prepared: true, ...extra }
}

// n ores in the east and west walls of the room, nearest the bot first
function wallOres (world, n, name = 'iron_ore') {
  const spots = []
  for (const z of [0, -1, 1, -2, 2]) {
    for (const x of [3, -3]) for (const y of [16, 17]) spots.push(new Vec3(x, y, z))
  }
  const used = spots.slice(0, n)
  for (const p of used) world.set(p, name)
  return used
}

const ironDigs = digs => digs.filter(d => /iron_ore$/.test(d.name)).length

test('a diamond in view is not dug, the master is told once, and the job carries on', async () => {
  const { bot, world, token, digs } = room()
  wallOres(world, 2)
  const gem = new Vec3(0, 16, 3)
  const gem2 = new Vec3(1, 16, 3)
  world.set(gem, 'diamond_ore')
  world.set(gem2, 'diamond_ore')
  bot._oreMarks = new OreMarks()
  const j = ironJob(bot, 2)
  const r = await mineJob(bot, j, human, token, {})
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.blockAt(gem).name, 'diamond_ore')
  assert.equal(bot.blockAt(gem2).name, 'diamond_ore')
  assert.equal(digs.filter(d => /diamond/.test(d.name)).length, 0)
  const told = bot.chats.filter(t => /^Found diamonds at /.test(t))
  assert.equal(told.length, 1, told.join(' | '))
  assert.match(told[0], /Found diamonds at -?\d+ -?\d+ -?\d+\. Say get the diamonds if you want them\. I'm carrying on\./)
  assert.equal(ironDigs(digs), 2, 'the iron job finished')
  assert.equal(bot._oreMarks.list().length, 1, 'one cluster')
})

test('a tunnel never breaks diamond ore in its way on a job that does not need it', async () => {
  const { bot, world, token, digs } = room({ digLimit: 40 })
  for (const z of [-3, 3]) for (const x of [-1, 0, 1]) for (const y of [16, 17]) world.set(new Vec3(x, y, z), 'diamond_ore')
  bot._oreMarks = new OreMarks()
  const j = ironJob(bot, 1, { tuning: { branchLen: 3 } })
  await mineJob(bot, j, human, token, {})
  assert.equal(digs.filter(d => /diamond/.test(d.name)).length, 0)
})

test('a later diamond job goes to the remembered spot before any branch mining', async () => {
  const { bot, world, token, digs } = room({ length: 26 })
  const gem = new Vec3(0, 16, 27)
  world.set(gem, 'diamond_ore')
  bot.world.raycast = () => bot.blockAt(gem)  // the mock world has no ray test, the corridor to the ore is open
  bot._oreMarks = new OreMarks()
  bot._oreMarks.saw(bot, [gem])
  const start = bot.countOf('diamond')
  const j = { block: 'diamond', blocks: DIAMOND, count: 1, mined: 0, want: 1, inBag: () => bot.countOf('diamond') - start, strategy: 'branch', home: null, store: false, prepared: true }
  const r = await mineJob(bot, j, human, token, {})
  assert.equal(r.result, 'done', r.message)
  assert.equal(bot.countOf('diamond'), 1)
  assert.equal(digs.length, 1, `dug only the marked ore: ${digs.map(d => d.name).join(',')}`)
  assert.equal(bot._oreMarks.list().length, 0, 'the mark is used up')
})

test('a remembered spot with no diamond left is forgotten', async () => {
  const { bot, token } = room({ digLimit: 3 })
  const gone = new Vec3(0, 16, 3)  // plain stone
  bot._oreMarks = new OreMarks()
  bot._oreMarks.saw(bot, [gone])
  const j = { block: 'diamond', blocks: DIAMOND, count: 1, mined: 0, want: 1, inBag: () => bot.countOf('diamond'), strategy: 'branch', home: null, store: false, prepared: true }
  await mineJob(bot, j, human, token, {})
  assert.equal(bot._oreMarks.list().length, 0)
})

test('plain yes words count, refusals and other orders do not', () => {
  for (const s of ['yes', 'Yes please', 'yeah', 'sure', 'ok', 'go ahead', 'get the diamonds', 'get them', 'grab the diamonds please', 'yes get them', 'Agent1, get the diamonds']) {
    assert.equal(saysYesToDiamonds(s, ['Agent1']), true, s)
  }
  for (const s of ['no', 'no thanks', "don't get the diamonds", 'not now', 'leave them', 'get 5 wood', 'come here', 'stop', 'yes but not now']) {
    assert.equal(saysYesToDiamonds(s, ['Agent1']), false, s)
  }
})

test('a yes makes the diamonds a job after the current one, a stray yes does nothing', () => {
  const { bot } = room()
  const marks = new OreMarks()
  const run = []
  const said = []
  const ctx = { bot, alive: true, plan: { steps: [] }, manager: { active: { name: 'gather' } } }
  const agents = { oreMarks: marks, names: [bot.username], ctxs: new Map([[bot.username, ctx]]), say: (b, t) => said.push(t), execute: (c, command) => run.push(command) }
  assert.equal(answerDiamonds(agents, 'yes', 'someone', { every: 0 }), false, 'nothing was asked')
  marks.saw(bot, [new Vec3(0, 16, 3), new Vec3(1, 16, 3)])
  assert.equal(answerDiamonds(agents, 'get the diamonds', 'someone', { every: 0 }), true)
  assert.equal(run.length, 0, 'still busy with the current job')
  ctx.plan = null
  ctx.manager.active = null
  ctx.diamondCheck()
  assert.deepEqual(run, [{ name: 'get', args: { item: 'diamond', count: 2, requester: 'someone' } }])
  assert.equal(answerDiamonds(agents, 'yes', 'someone', { every: 0 }), false, 'answered once')
})
