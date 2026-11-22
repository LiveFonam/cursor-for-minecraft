const test = require('node:test')
const assert = require('node:assert')
const scene = require('../scene')
const { passDoor, sideOf, doorGate, doorBlocks, keepDoorWhole, REACH } = require('../door')
const { walkToSpot } = require('../walk_home')

const STAGE = { x: 100, y: -60, z: 200 }
const L = scene.baseLayout(STAGE)
const FAST = { open: 30, cross: 60, reset: 1, stand: 50, line: 40, poll: 1 }
const key = p => `${p.x},${p.y},${p.z}`
const mid = p => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 })

// A bot in a world holding only the door and its levers. Walking is instant, and the door blocks a walk while it is shut.
// Levers stay where they are put, and either one on holds the door open
function fakeBot (start, { opensOnPress = () => true, shutBeforeWalk = () => false } = {}) {
  const log = []
  let open = false
  let ons = 0
  const levers = new Map([[key(L.door.insideLever), false], [key(L.door.outsideLever), false]])
  const doorBlock = half => ({ name: 'iron_door', getProperties: () => ({ open, half }) })
  const leverBlock = p => ({ name: 'lever', position: p, getProperties: () => ({ powered: levers.get(key(p)) }) })
  const blocks = new Map([
    [key(L.door.lower), () => doorBlock('lower')],
    [key(L.door.upper), () => doorBlock('upper')],
    [key(L.door.insideLever), () => leverBlock(L.door.insideLever)],
    [key(L.door.outsideLever), () => leverBlock(L.door.outsideLever)]
  ])
  let aim = null
  const bot = {
    username: 'Agent1',
    entity: { position: { ...start } },
    pathfinder: { setGoal () {}, setMovements () {}, movements: {} },
    blockAt: p => blocks.get(key(p))?.() ?? null,
    lookAt: async p => { aim = p },
    activateBlock: async (block, face) => {
      const k = key(block.position)
      levers.set(k, !levers.get(k))
      if (levers.get(k)) ons++
      log.push({ press: k, on: levers.get(k), face, from: { ...bot.entity.position } })
      if (![...levers.values()].some(Boolean)) open = false
      else if (levers.get(k)) open = open || opensOnPress(ons)
    },
    setControlState (name, on) {
      if (name !== 'forward' || !on || !aim) return
      if (open && shutBeforeWalk(ons)) open = false
      const crosses = (bot.entity.position.z < L.door.lower.z) !== (aim.z < L.door.lower.z)
      log.push({ walk: { x: aim.x, z: aim.z }, open })
      if (crosses && !open) return
      bot.entity.position = { x: aim.x, y: bot.entity.position.y, z: aim.z }
    }
  }
  return {
    bot,
    log,
    shut: () => { open = false },
    isOpen: () => open,
    lever: p => levers.get(key(p)),
    setLever: (p, on) => { levers.set(key(p), on); open = [...levers.values()].some(Boolean) }
  }
}

const ctxOf = bot => ({ bot, agents: { log () {}, noDigMoves: () => ({}) } })
const teleport = async (bot, goal) => { bot.entity.position = { x: goal.x + 0.5, y: goal.y, z: goal.z + 0.5 }; return true }
const opts = { waits: FAST, walk: teleport }

test('the base has one real iron door, closed, with a lever on each side of the wall beside it', () => {
  const list = scene.baseCommands(STAGE)
  const d = L.door
  const lower = `setblock ${key(d.lower).replace(/,/g, ' ')} iron_door[facing=north,half=lower,hinge=left,open=false,powered=false]`
  const upper = `setblock ${key(d.upper).replace(/,/g, ' ')} iron_door[facing=north,half=upper,hinge=left,open=false,powered=false]`
  assert.ok(list.includes(lower))
  assert.ok(list.includes(upper))
  assert.ok(list.indexOf(lower) < list.indexOf(upper), 'lower half first')
  const lastWall = list.map(c => c.endsWith('cobblestone')).lastIndexOf(true)
  assert.ok(list.indexOf(lower) > lastWall, 'the door goes in after the walls')
  assert.equal(d.lower.z, L.center.z + L.half, 'in the south wall')
  assert.equal(d.upper.y, d.lower.y + 1)
  // both levers sit on the same wall block, which touches the door's upper half
  const wall = { x: d.upper.x + 1, y: d.upper.y, z: d.upper.z }
  assert.deepEqual(d.leverWall, wall)
  assert.deepEqual(d.insideLever, { ...wall, z: wall.z - 1 })
  assert.deepEqual(d.outsideLever, { ...wall, z: wall.z + 1 })
  assert.ok(list.includes(`setblock ${d.insideLever.x} ${d.insideLever.y} ${d.insideLever.z} lever[face=wall,facing=north,powered=false]`))
  assert.ok(list.includes(`setblock ${d.outsideLever.x} ${d.outsideLever.y} ${d.outsideLever.z} lever[face=wall,facing=south,powered=false]`))
  assert.ok(!list.some(c => /_button/.test(c)))
  assert.ok(!list.some(c => /pressure_plate/.test(c)))
})

test('the opening is one door wide, and the rest of the wall stays cobblestone', () => {
  assert.equal(L.opening.from.x, L.opening.to.x)
  assert.equal(L.opening.from.x, L.door.lower.x)
})

test('!evil puts the door back shut and never walls it over or cuts a gap', () => {
  const seal = scene.sealCommands(STAGE)
  assert.ok(seal.some(c => c.includes('iron_door[') && c.includes('half=lower') && c.includes('open=false')))
  assert.ok(seal.some(c => c.includes('iron_door[') && c.includes('half=upper')))
  assert.ok(!seal.some(c => c.endsWith('cobblestone') || c.endsWith(' air')))
})

test('the raid plan cannot aim the creeper at the wall with the door', () => {
  const { checkPlan } = require('../evil_plan')
  const plan = wall => JSON.stringify({ wall, approach: 'center', zombies: 'breach', line: 'x' })
  assert.equal(checkPlan(plan('south')), null)
  for (const wall of ['north', 'east', 'west']) assert.equal(checkPlan(plan(wall)).wall, wall)
})

test('a scripted wave picks the nearest wall, but never the one with the door', () => {
  const { layoutOf, nearestWall } = require('../evil_plan')
  const b = layoutOf(STAGE)
  assert.equal(nearestWall({ x: b.x + 1, z: b.z + 10 }, b), 'east')
  assert.equal(nearestWall({ x: b.x - 1, z: b.z + 10 }, b), 'west')
  assert.equal(nearestWall({ x: b.x, z: b.z - 10 }, b), 'north')
})

test('sides: the door cell counts as inside until past the panel, a roof or a mine is outside', () => {
  assert.equal(sideOf(STAGE, mid(L.hand)), 'in')
  assert.equal(sideOf(STAGE, mid(L.door.inside)), 'in')
  assert.equal(sideOf(STAGE, mid(L.door.lower)), 'in')
  assert.equal(sideOf(STAGE, mid(L.door.outside)), 'out')
  assert.equal(sideOf(STAGE, { ...mid(L.hand), y: L.wallTop + 2 }), 'out')
  assert.equal(sideOf(STAGE, { ...mid(L.hand), y: L.center.y - 20 }), 'out')
})

test('leaving flips the inside lever before it walks, and ends outside', async () => {
  const { bot, log } = fakeBot(mid(L.agent))
  assert.equal(await passDoor(ctxOf(bot), STAGE, 'out', { cancelled: false }, opts), 'done')
  assert.equal(sideOf(STAGE, bot.entity.position), 'out')
  const press = log.findIndex(l => l.press)
  const through = log.findIndex(l => l.walk && l.walk.z > L.door.lower.z)
  assert.ok(press >= 0 && through > press, 'pressed, then walked')
  assert.equal(log[press].press, key(L.door.insideLever))
  assert.equal(log[press].face.z, -1, 'pressed on its open face')
  assert.ok(Math.hypot(log[press].from.x - L.door.inside.x - 0.5, log[press].from.z - L.door.inside.z - 0.5) < 0.5, 'from the spot in front of the door')
})

test('coming home flips the outside lever and ends inside', async () => {
  const { bot, log } = fakeBot({ x: L.center.x + 30.5, y: L.center.y, z: L.center.z + 30.5 })
  assert.equal(await passDoor(ctxOf(bot), STAGE, 'in', { cancelled: false }, opts), 'done')
  assert.equal(sideOf(STAGE, bot.entity.position), 'in')
  const press = log.find(l => l.press)
  assert.equal(press.press, key(L.door.outsideLever))
  assert.equal(press.face.z, 1)
})

test('a press that does not open the door is tried again', async () => {
  const { bot, log } = fakeBot(mid(L.door.inside), { opensOnPress: n => n >= 2 })
  assert.equal(await passDoor(ctxOf(bot), STAGE, 'out', { cancelled: false }, opts), 'done')
  assert.equal(log.filter(l => l.press && l.on).length, 2)
})

test('a door that shuts before the walk is pressed again and passed', async () => {
  const { bot, log } = fakeBot(mid(L.door.inside), { shutBeforeWalk: n => n === 1 })
  assert.equal(await passDoor(ctxOf(bot), STAGE, 'out', { cancelled: false }, opts), 'done')
  assert.equal(log.filter(l => l.press && l.on).length, 2)
  assert.equal(sideOf(STAGE, bot.entity.position), 'out')
})

test('a door that never opens gives up after a few tries instead of hanging', async () => {
  const { bot, log } = fakeBot(mid(L.door.outside), { opensOnPress: () => false })
  assert.equal(await passDoor(ctxOf(bot), STAGE, 'in', { cancelled: false }, { ...opts, tries: 3 }), 'shut')
  assert.equal(log.filter(l => l.press && l.on).length, 3)
  assert.ok(log.filter(l => l.press).every(l => l.press === key(L.door.outsideLever)))
})

test('a missing lever or an error from the press ends as shut too', async () => {
  const gone = fakeBot(mid(L.door.outside))
  const at = gone.bot.blockAt
  gone.bot.blockAt = p => key(p) === key(L.door.outsideLever) ? null : at(p)
  assert.equal(await passDoor(ctxOf(gone.bot), STAGE, 'in', { cancelled: false }, { ...opts, tries: 2 }), 'shut')
  const broken = fakeBot(mid(L.door.outside))
  broken.bot.activateBlock = async () => { throw new Error('too far') }
  assert.equal(await passDoor(ctxOf(broken.bot), STAGE, 'in', { cancelled: false }, { ...opts, tries: 2 }), 'shut')
})

test('a stop during the door ends it at once', async () => {
  const { bot, log } = fakeBot(mid(L.door.inside))
  assert.equal(await passDoor(ctxOf(bot), STAGE, 'out', { cancelled: true }, opts), 'cancelled')
  assert.equal(log.length, 0)
})

test('a door a blast took is just a gap: no lever needed', async () => {
  const { bot, log } = fakeBot(mid(L.door.inside))
  const at = bot.blockAt
  bot.blockAt = p => (key(p) === key(L.door.lower) ? { name: 'air', getProperties: () => ({}) } : at(p))
  bot.activateBlock = async () => { throw new Error('nothing to press') }
  const cross = bot.setControlState
  bot.setControlState = (name, on) => { if (name === 'forward' && on) bot.entity.position = { ...mid(L.door.outside) }; else cross(name, on) }
  assert.equal(await passDoor(ctxOf(bot), STAGE, 'out', { cancelled: false }, opts), 'done')
  assert.equal(log.filter(l => l.press).length, 0)
})

test('the walk home goes through the door first, and a shut door ends it as shut', async () => {
  const { bot } = fakeBot(mid(L.door.outside), { opensOnPress: () => false })
  const agents = { log () {}, noDigMoves: () => ({}) }
  let walked = 0
  const door = async () => { walked++; return 'shut' }
  assert.equal(await walkToSpot({ bot, agents }, L.hand, { cancelled: false }, door), 'shut')
  assert.equal(walked, 1)
})

test('the gate takes a walk across the wall through the door, and leaves walks on one side alone', async () => {
  const { bot, log } = fakeBot(mid(L.door.outside))
  let stage = STAGE
  const gate = doorGate(ctxOf(bot), () => stage, opts)
  await gate({ x: L.door.outside.x + 3, y: L.center.y, z: L.door.outside.z + 2 }, { cancelled: false })
  assert.equal(log.length, 0, 'same side, nothing to do')
  stage = null
  await gate({ ...L.chest }, { cancelled: false })
  assert.equal(log.length, 0, 'outside a task the gate is off')
  stage = STAGE
  await gate({ ...L.chest }, { cancelled: false })
  assert.equal(sideOf(STAGE, bot.entity.position), 'in')
  assert.equal(log.find(l => l.press).press, key(L.door.outsideLever))
})

test('after a door that stayed shut the gate rests, so a job retrying its walk cannot pile up presses', async () => {
  const { bot, log } = fakeBot(mid(L.door.outside), { opensOnPress: () => false })
  const gate = doorGate(ctxOf(bot), () => STAGE, { ...opts, tries: 2 })
  await gate({ ...L.chest }, { cancelled: false })
  const after = log.filter(l => l.press).length
  await gate({ ...L.chest }, { cancelled: false })
  assert.equal(log.filter(l => l.press).length, after)
})

test('every door and lever line uses block states the game really has', () => {
  const blocks = require('minecraft-data')('1.21.11').blocksByName
  for (const line of scene.doorCommands(STAGE)) {
    const m = line.match(/^setblock -?\d+ -?\d+ -?\d+ ([a-z_]+)\[(.+)\]$/)
    assert.ok(m, line)
    const states = new Map(blocks[m[1]].states.map(s => [s.name, s]))
    const given = m[2].split(',').map(p => p.split('='))
    assert.equal(given.length, states.size, `${m[1]} sets all its states`)
    for (const [name, value] of given) {
      const s = states.get(name)
      assert.ok(s, `${m[1]} has ${name}`)
      assert.ok(s.type === 'bool' ? ['true', 'false'].includes(value) : s.values.includes(value), `${name}=${value}`)
    }
  }
})

const { DemoAgents } = require('../run')
const bareAgents = controller => Object.assign(Object.create(DemoAgents.prototype), {
  demo: { player: 'Viewer', agent: 'Agent1' }, controller, taskDepth: 0, taskEpoch: 0, taskResult: null
})

test('a task goes out through the door before its work starts', async () => {
  const events = []
  const a = bareAgents({ taskStarted: async () => events.push('start'), taskEnded: async r => events.push(`end ${r}`) })
  a.leaveBase = async () => events.push('leave')
  await a.tracked('diamond_pickaxe', async () => { events.push('work'); return 'done' }, 1, {})
  assert.deepEqual(events, ['start', 'leave', 'work', 'end done'])
})

test('a stop while it is leaving means the work never starts', async () => {
  let worked = false
  const a = bareAgents({ taskStarted: async () => {}, taskEnded: async () => {} })
  a.leaveBase = async () => { a.taskEpoch++; a.taskDepth = 0 }
  assert.equal(await a.tracked('diamond_pickaxe', async () => { worked = true; return 'done' }, 1, {}), 'stopped')
  assert.equal(worked, false)
})

test('a plan that only walks back to him skips the trip out through the door', () => {
  const a = bareAgents({ stage: STAGE, state: 'run' })
  let given
  a.tracked = (item, work, count, ctx) => { given = ctx }
  const ctx = {}
  a.runPlan(ctx, [{ name: 'walk', args: { to: 'viewer' } }], {})
  assert.equal(given, null)
  a.runPlan(ctx, [{ name: 'mine', args: {} }], {})
  assert.equal(given, ctx)
})

test('leaving for real: through the mode and out of the door', async () => {
  const { Mode, ModeManager } = require('../../modes')
  class Craft extends Mode { constructor () { super('craft') } }
  const manager = new ModeManager([new Craft()])
  const { bot, log } = fakeBot(mid(L.door.inside))
  const a = bareAgents({ stage: STAGE, state: 'run' })
  a.takeBaseChest = async () => {}
  a.log = () => {}
  const ctx = { bot, manager, agents: { log () {}, noDigMoves: () => ({}) } }
  const ticking = setInterval(() => manager.tick(), 5)
  try {
    await a.leaveBase(ctx, 0)
  } finally {
    clearInterval(ticking)
  }
  assert.equal(sideOf(STAGE, bot.entity.position), 'out')
  assert.equal(log.find(l => l.press).press, key(L.door.insideLever))
})

test('a door that stays shut at the hand-over: it says so and the flow ends', async () => {
  const said = []
  const a = bareAgents({ stage: STAGE, state: 'run', playerHome: async () => { throw new Error('must not bring him back') } })
  a.say = (bot, text) => said.push(text)
  a.walkToBase = async () => 'shut'
  assert.equal(await a.walkHome({ bot: {} }, { args: { to: 'Viewer' } }), 'far')
  assert.ok(said.some(t => /door/.test(t)))
})

// Levers

const eyeTo = (from, p) => Math.hypot(from.x + 0.5 - p.x - 0.5, from.y + 1.62 - p.y - 0.5, from.z + 0.5 - p.z - 0.5)
const logged = () => { const lines = []; return { lines, log: l => lines.push(l), noDigMoves: () => ({}) } }

test('the agent can reach the lever it used from where it lands on the far side', () => {
  assert.ok(eyeTo(L.door.outside, L.door.insideLever) < REACH)
  assert.ok(eyeTo(L.door.inside, L.door.outsideLever) < REACH)
})

for (const [to, start, used, other] of [
  ['out', L.door.inside, 'insideLever', 'outsideLever'],
  ['in', L.door.outside, 'outsideLever', 'insideLever']
]) {
  test(`going ${to}: flips its own lever on, walks through, flips that same lever off, and the door is shut`, async () => {
    const f = fakeBot(mid(start))
    assert.equal(await passDoor(ctxOf(f.bot), STAGE, to, { cancelled: false }, opts), 'done')
    const flips = f.log.filter(l => l.press)
    assert.deepEqual(flips.map(l => [l.press, l.on]), [[key(L.door[used]), true], [key(L.door[used]), false]])
    assert.equal(sideOf(STAGE, flips[1].from), to, 'turned off from the far side')
    assert.equal(f.lever(L.door[used]), false)
    assert.equal(f.lever(L.door[other]), false)
    assert.equal(f.isOpen(), false)
  })
}

test('a door the owner already opened: the agent walks through and touches no lever', async () => {
  const f = fakeBot(mid(L.door.inside))
  f.setLever(L.door.outsideLever, true)
  assert.equal(await passDoor(ctxOf(f.bot), STAGE, 'out', { cancelled: false }, opts), 'done')
  assert.equal(f.log.filter(l => l.press).length, 0)
  assert.equal(f.lever(L.door.outsideLever), true)
  assert.equal(f.isOpen(), true)
})

test('the owner flips the other lever mid-way: the door stays open, it says so and carries on', async () => {
  const f = fakeBot(mid(L.door.inside))
  const flip = f.bot.activateBlock
  let first = true
  f.bot.activateBlock = async (...a) => {
    await flip(...a)
    if (first) f.setLever(L.door.outsideLever, true)
    first = false
  }
  const agents = logged()
  assert.equal(await passDoor({ bot: f.bot, agents }, STAGE, 'out', { cancelled: false }, opts), 'done')
  assert.equal(f.lever(L.door.insideLever), false, 'its own lever is back off')
  assert.equal(f.lever(L.door.outsideLever), true, 'the owner lever is left alone')
  assert.ok(agents.lines.some(l => /left open/.test(l)))
})

test('a lever that will not flip back: logged, and the task goes on', async () => {
  const f = fakeBot(mid(L.door.inside))
  const flip = f.bot.activateBlock
  let n = 0
  f.bot.activateBlock = async (...a) => {
    if (++n === 2) throw new Error('too far')
    return flip(...a)
  }
  const agents = logged()
  assert.equal(await passDoor({ bot: f.bot, agents }, STAGE, 'out', { cancelled: false }, opts), 'done')
  assert.equal(n, 2, 'one try at closing, no loop')
  assert.ok(agents.lines.some(l => /left open/.test(l)))
})

test('a lever found on with the door shut is reset first, so the flip really opens it', async () => {
  const f = fakeBot(mid(L.door.inside))
  f.setLever(L.door.insideLever, true)
  f.shut()
  assert.equal(await passDoor(ctxOf(f.bot), STAGE, 'out', { cancelled: false }, opts), 'done')
  assert.deepEqual(f.log.filter(l => l.press).map(l => l.on), [false, true, false])
  assert.equal(f.isOpen(), false)
})

test('a door that will not open leaves its lever off', async () => {
  const f = fakeBot(mid(L.door.outside), { opensOnPress: () => false })
  assert.equal(await passDoor(ctxOf(f.bot), STAGE, 'in', { cancelled: false }, { ...opts, tries: 2 }), 'shut')
  assert.equal(f.lever(L.door.outsideLever), false)
})

test('every rebuild sets the levers off, and before the door so a lever left on cannot hold it open', () => {
  for (const list of [scene.doorCommands(STAGE), scene.sealCommands(STAGE), scene.baseCommands(STAGE)]) {
    const levers = list.filter(c => / lever\[/.test(c))
    assert.equal(levers.length, 2)
    assert.ok(levers.every(c => c.endsWith('powered=false]')))
    const door = list.findIndex(c => c.includes('iron_door['))
    assert.ok(list.findLastIndex(c => / lever\[/.test(c)) < door)
    assert.ok(list.findLastIndex(c => c.endsWith('cobblestone')) < list.findIndex(c => / lever\[/.test(c)), 'the wall is up first')
  }
  const reset = scene.resetCommands({ agent: 'Agent1', player: 'Viewer', fighter: 'Agent2' }, STAGE, { stocked: true })
  assert.equal(reset.filter(c => / lever\[.*powered=false/.test(c)).length, 2)
})

test('digging refuses the door, its levers, the block they hang on and the floor under the door', async () => {
  const dug = []
  const bot = { dig: async b => { dug.push(b.position) } }
  keepDoorWhole(bot, () => STAGE)
  const kept = doorBlocks(STAGE)
  for (const p of [L.door.lower, L.door.upper, L.door.insideLever, L.door.outsideLever, L.door.leverWall, { ...L.door.lower, y: L.door.lower.y - 1 }]) {
    assert.ok(kept.some(k => key(k) === key(p)), key(p))
    await assert.rejects(bot.dig({ position: p }))
  }
  assert.equal(dug.length, 0)
  const other = { x: L.door.lower.x - 1, y: L.door.lower.y, z: L.door.lower.z }
  await bot.dig({ position: other })
  assert.equal(dug.length, 1, 'the rest of the world digs as before')
})

test('the path planner will not break them either, even with digging on', () => {
  const { Movements } = require('mineflayer-pathfinder')
  const bot = {}
  keepDoorWhole(bot, () => STAGE)
  const m = Object.create(Movements.prototype)
  Object.assign(m, { bot, canDig: true, dontCreateFlow: false, dontMineUnderFallingBlock: false, blocksCantBreak: new Set(), exclusionAreasBreak: [] })
  const block = position => ({ type: 1, position })
  assert.equal(!!m.safeToBreak(block(L.door.leverWall)), false)
  assert.equal(!!m.safeToBreak(block(L.door.insideLever)), false)
  assert.equal(!!m.safeToBreak(block({ x: L.door.lower.x - 1, y: L.door.lower.y, z: L.door.lower.z })), true)
})

test('a plain !reset says the chest is empty and that !chest stocks it', async () => {
  const { DemoController } = require('../controller')
  const told = []
  const c = Object.create(DemoController.prototype)
  Object.assign(c, {
    s: { agent: 'Agent1', player: 'Viewer', fighter: 'Agent2' },
    stage: STAGE,
    agents: {},
    quiet: async () => {},
    send: async () => {},
    sendLoaded: async () => {},
    tell: async t => told.push(t)
  })
  await c.reset()
  assert.match(told.at(-1), /chest is empty/i)
  assert.match(told.at(-1), /!chest/)
  await c.reset({ stocked: true })
  assert.match(told.at(-1), /stocked/)
  assert.doesNotMatch(told.at(-1), /empty/)
})

test('a walk that runs out of time but did get across still shuts the door behind it', async () => {
  const f = fakeBot(mid(L.door.inside))
  const set = f.bot.setControlState
  let walks = 0
  f.bot.setControlState = (name, on) => {
    if (name === 'forward' && on && ++walks === 2) {
      setTimeout(() => { f.bot.entity.position = { ...mid(L.door.outside), x: L.door.outside.x + 0.9 } }, 70)
      return
    }
    set(name, on)
  }
  assert.equal(await passDoor(ctxOf(f.bot), STAGE, 'out', { cancelled: false }, { ...opts, waits: { ...FAST, reset: 30 } }), 'done')
  assert.equal(f.lever(L.door.insideLever), false)
  assert.equal(f.isOpen(), false)
})
