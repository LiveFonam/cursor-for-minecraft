// The iron pickaxe benchmark on a fake server: what each scene starts with, how the owner stand-in answers the bot, and
// that only an iron pickaxe the server counts in AgentTester's bag is a pass. The real server is in livetest.js.

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const { parseMessage } = require('../commands')
const {
  TESTS, ORDER, IRON_BENCH_BREAD, IRON_BENCH_ORDER, IRON_BENCH_SCENES, IRON_BENCH_ANIMALS,
  parseAsk, freeSpotBeside, stepBackFrom, setupIronScene, ironSources, ironFailure, testIronPickaxe
} = require('../livetest')
const { listText } = require('../goal_plan')

const GROUND_Y = 63
const SPOT = new Vec3(0, GROUND_Y + 1, 0)
const chatLine = (who, text) => ({ at: Date.now(), text: `<${who}> ${text}` })

function fakeWorld ({ flat = true, oak = 12, naturalChests = [], chestReply = null } = {}) {
  const w = {
    bags: { Agent1: {}, AgentTester: {} },
    chests: new Map(naturalChests.map(p => [`${p.x} ${p.y} ${p.z}`, {}])),
    ground: {},
    summoned: [],
    sent: [],
    positions: { Agent1: [2.5, 64, -1.5], AgentTester: [0.5, 64, 0.5] },
    modes: { AgentTester: 'creative' },
    tossModes: [],
    foodLevel: 20,
    chestReply
  }
  const add = (bag, item, n) => { bag[item] = (bag[item] || 0) + n }
  w.rcon = {
    send: async c => {
      w.sent.push(c)
      let m
      if ((m = c.match(/^clear (\w+) minecraft:(\w+) 0$/))) {
        const n = w.bags[m[1]][m[2]] || 0
        return n ? `Found ${n} matching items on player ${m[1]}` : `No items were found on player ${m[1]}`
      }
      if ((m = c.match(/^clear (\w+)$/))) { w.bags[m[1]] = {}; return 'Removed items' }
      if ((m = c.match(/^give (\w+) minecraft:(\w+) (\d+)$/))) { add(w.bags[m[1]], m[2], Number(m[3])); return 'Gave' }
      if ((m = c.match(/^setblock (-?\d+) (-?\d+) (-?\d+) minecraft:(\w+)$/))) {
        const key = `${m[1]} ${m[2]} ${m[3]}`
        if (m[4] === 'chest') w.chests.set(key, {})
        else w.chests.delete(key)
        return 'Changed the block'
      }
      if ((m = c.match(/^item replace block (-?\d+) (-?\d+) (-?\d+) container\.\d+ with minecraft:(\w+) (\d+)$/))) {
        add(w.chests.get(`${m[1]} ${m[2]} ${m[3]}`), m[4], Number(m[5]))
        return 'Replaced'
      }
      if ((m = c.match(/^data get block (-?\d+) (-?\d+) (-?\d+) Items(?:\[(\d+)\])?$/))) {
        if (w.chestReply) return w.chestReply
        const chest = w.chests.get(`${m[1]} ${m[2]} ${m[3]}`)
        if (!chest) return 'The target block is not a block entity'
        const stacks = Object.entries(chest).filter(([, n]) => n > 0).map(([k, n], i) => `{Slot: ${i}b, id: "minecraft:${k}", count: ${n}}`)
        const head = `${m[1]}, ${m[2]}, ${m[3]} has the following block data: `
        if (m[4] !== undefined) return stacks[Number(m[4])] ? head + stacks[Number(m[4])] : `Found no elements matching Items[${m[4]}]`
        if (!stacks.length) return 'Found no elements matching Items'
        // as the real 1.21.11 server does: a long list is cut off with "..." inside the second stack
        return head + (stacks.length > 1 ? `[${stacks[0]}, {Slot: 1b, id: "...` : `[${stacks[0]}]`)
      }
      if ((m = c.match(/^summon minecraft:(\w+) /))) { w.summoned.push(m[1]); return 'Summoned' }
      if ((m = c.match(/^execute if entity @e\[type=minecraft:(\w+),/))) {
        const n = w.summoned.filter(a => a === m[1]).length
        return n ? `Test passed, count: ${n}` : 'Test failed'
      }
      if ((m = c.match(/^data get entity (\w+) Pos$/))) {
        const p = w.positions[m[1]]
        return `${m[1]} has the following entity data: [${p[0]}d, ${p[1]}d, ${p[2]}d]`
      }
      if (/foodLevel$/.test(c)) return `Agent1 has the following entity data: ${w.foodLevel}`
      if ((m = c.match(/^gamemode (\w+) (\w+)$/))) { w.modes[m[2]] = m[1]; return 'Set' }
      if ((m = c.match(/^tp AgentTester Agent1$/))) { w.positions.AgentTester = [...w.positions.Agent1]; return 'Teleported' }
      if ((m = c.match(/^tp AgentTester (\S+) (\S+) (\S+)$/))) { w.positions.AgentTester = [Number(m[1]), Number(m[2]), Number(m[3])]; return 'Teleported' }
      return ''
    }
  }
  const stateOf = name => registry.blocksByName[name].defaultState
  w.tester = {
    registry,
    entity: { yaw: 0 },
    world: {
      getColumnAt: () => ({}),
      getBlockStateId: v => stateOf(v.y === GROUND_Y + (flat || v.x < 0 ? 0 : 5) ? 'grass_block' : 'air')
    },
    findBlocks: ({ matching, count }) => {
      if (matching === registry.blocksByName.oak_log.id) return Array.from({ length: Math.min(oak, count) }, (_, i) => new Vec3(i, 64, 20))
      return [...w.chests.keys()].map(k => new Vec3(...k.split(' ').map(Number)))
    },
    look: async () => {},
    toss: async (id, _meta, n) => {
      w.tossModes.push(w.modes.AgentTester)
      const item = registry.items[id].name
      w.bags.AgentTester[item] -= n
      add(w.ground, item, n)
    },
    chat: text => { w.sent.push(`chat ${text}`); if (w.onChat) w.onChat(text) }
  }
  return w
}

function fakeSession (name, world, extra = {}) {
  const lines = []
  const s = {
    name,
    def: TESTS[name],
    spot: SPOT,
    botStart: new Vec3(2, 64, -2),
    chat: [],
    rcon: world.rcon,
    tester: world.tester,
    settleMs: 0,
    pollMs: 2,
    capMs: 400,
    walkAfterMs: 0,
    readStats: async () => world.stats || { 'minecraft:custom': {} },
    metrics: { mark: () => lines.length, since: i => lines.slice(i) },
    ...extra
  }
  const kit = s.def.kit
  for (const [item, n] of kit) world.bags.Agent1[item] = n
  return s
}

// ---------- the scenes ----------

test('the five scenes run by name through the job driver and stay out of the default order', () => {
  const names = ['iron_base', 'iron_little_food', 'iron_no_food', 'iron_chest', 'iron_owner_has']
  assert.deepEqual(Object.keys(IRON_BENCH_SCENES), names)
  for (const n of names) {
    assert.equal(typeof TESTS[n].run, 'function')
    assert.ok(TESTS[n].minutes > IRON_BENCH_SCENES[n].capMin, 'the harness limit leaves room to save the result')
    assert.equal(ORDER.includes(n), false)
    assert.equal(TESTS[n].translator, false, 'no paid API call unless asked for')
  }
})

test('the order is plain words and reaches a job for an iron pickaxe without the translator', () => {
  assert.equal(IRON_BENCH_ORDER, 'Agent1 make me an iron pickaxe')
  const p = parseMessage(IRON_BENCH_ORDER, ['Agent1'])
  assert.equal(p.type, 'command')
  assert.ok(['get', 'craft'].includes(p.command.name), p.command.name)
  assert.equal(p.command.args.item, 'iron_pickaxe')
})

test('the food amounts follow the game values', () => {
  assert.equal(registry.foodsByName.bread.foodPoints, 5)
  assert.equal(IRON_BENCH_BREAD.large * 5, 80)
  assert.equal(IRON_BENCH_BREAD.little * 5, 10)
  assert.equal(IRON_BENCH_BREAD.none, 0)
  assert.deepEqual(TESTS.iron_base.kit, [['bread', 16]])
  assert.deepEqual(TESTS.iron_little_food.kit, [['bread', 2]])
  assert.deepEqual(TESTS.iron_no_food.kit, [])
})

test('each scene starts with exactly what it says, checked on the server', async () => {
  const want = {
    iron_base: { bread: 16, chest: null, owner: {} },
    iron_little_food: { bread: 2, chest: null, owner: {} },
    iron_no_food: { bread: 0, chest: null, owner: {} },
    iron_chest: { bread: 16, chest: { iron_ingot: 3, stick: 2 }, owner: {} },
    iron_owner_has: { bread: 16, chest: null, owner: { iron_ingot: 3, stick: 2 } }
  }
  for (const [name, w] of Object.entries(want)) {
    const world = fakeWorld()
    const s = fakeSession(name, world)
    const { start } = await setupIronScene(s, s.def.iron)
    assert.equal(start.bot_bag.bread || 0, w.bread, name)
    assert.deepEqual(start.chest, w.chest, name)
    assert.deepEqual(start.owner, w.owner, name)
    assert.deepEqual(world.bags.AgentTester, w.owner, name)
    assert.equal(start.animals_within_32, IRON_BENCH_ANIMALS.length, name)
  }
})

test('leftovers from the world are gone: the owner bag, loose items and any chest the scene did not place', async () => {
  const world = fakeWorld({ naturalChests: [new Vec3(9, 64, 9)] })
  world.bags.AgentTester = { iron_pickaxe: 1, iron_ingot: 9 }
  const s = fakeSession('iron_base', world)
  const { start } = await setupIronScene(s, s.def.iron)
  assert.deepEqual(world.bags.AgentTester, {})
  assert.equal(world.chests.size, 0)
  assert.equal(start.natural_containers_removed, 1)
  assert.ok(world.sent.some(c => c.startsWith('kill @e[type=minecraft:item')))
})

test('a spot that is not the flat oak area stops the scene before it costs a run', async () => {
  for (const opts of [{ flat: false }, { oak: 3 }]) {
    const world = fakeWorld(opts)
    const s = fakeSession('iron_base', world)
    const r = await testIronPickaxe(s)
    assert.equal(r.pass, false)
    assert.equal(r.failure_reason, 'setup')
    assert.match(r.failure_detail, /flat oak/)
    assert.equal(world.sent.some(c => c === `chat ${IRON_BENCH_ORDER}`), false, 'the order is never given')
  }
})

// ---------- reading the bot's chat ----------

test('the planner\'s own request to the owner is an ask for exactly those items', () => {
  const both = listText([['iron_ingot', 3], ['stick', 2]])
  assert.deepEqual(parseAsk(`You have ${both}, drop them to me. I'll wait 20 s, then get the rest myself`).wants,
    [{ item: 'iron_ingot', count: 3 }, { item: 'stick', count: 2 }])
  const one = listText([['iron_ingot', 1]])
  assert.deepEqual(parseAsk(`You have ${one}, drop it to me. I'll wait 20 s, then get the rest myself`).wants, [{ item: 'iron_ingot', count: 1 }])
})

test('real requests from the crafter are asks, with the right materials', () => {
  const a = parseAsk('For the iron pickaxe I need 3 raw irons and 2 sticks more. Bring them to me and I\'ll carry on')
  assert.deepEqual(a.wants, [{ item: 'iron_ingot', count: 3 }, { item: 'stick', count: 2 }])
  const b = parseAsk('The gatherer couldn\'t get it all. For the iron pickaxe I still need 1 iron ingot, bring it to me and I\'ll carry on')
  assert.deepEqual(b.wants, [{ item: 'iron_ingot', count: 1 }])
  assert.deepEqual(parseAsk('Do you have any iron?').wants, [{ item: 'iron_ingot', count: null }])
  assert.deepEqual(parseAsk('Can you give me the materials?').wants, [{ item: 'iron_ingot', count: null }, { item: 'stick', count: null }])
  assert.equal(parseAsk('Bring me 8 cobblestone').other, true)
})

test('its own progress and offers are not asks', () => {
  for (const line of [
    'For the iron pickaxe I need 3 raw irons, gathering it',
    'On it: 1) !craft iron_pickaxe',
    'Here\'s your iron pickaxe, AgentTester',
    'AgentTester, your iron pickaxe is ready, I\'m keeping it until you\'re close',
    'I\'ll bring the iron pickaxe to you',
    'I will drop 3 iron ingots in the chest',
    'Can you come closer?'
  ]) assert.equal(parseAsk(line), null, line)
})

test('what the stand-in says back is never taken for an order', () => {
  for (const line of ['here you go', 'sorry, I have none of that']) assert.equal(parseMessage(line, ['Agent1']), null, line)
})

test('standing next to the bot needs air and a floor, a tight tunnel has no such place', () => {
  const open = p => ({ boundingBox: p.y === 63 ? 'block' : 'empty' })
  assert.deepEqual(freeSpotBeside(open, { x: 0.5, y: 64, z: 0.5 }), { x: 2.5, y: 64, z: 0.5 })
  assert.equal(freeSpotBeside(() => ({ boundingBox: 'block' }), { x: 0.5, y: 64, z: 0.5 }), null)
})

// ---------- the pass is counted on the server ----------

test('an iron pickaxe in the stand-in bag is a pass, with the time and food from the server', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_base', world)
  world.onChat = text => { if (text === IRON_BENCH_ORDER) setTimeout(() => { world.bags.AgentTester.iron_pickaxe = 1 }, 20) }
  const r = await testIronPickaxe(s)
  assert.equal(r.pass, true)
  assert.equal(r.ok, true)
  assert.equal(r.failure_reason, null)
  assert.ok(r.seconds >= 0 && r.seconds < 0.4)
  assert.equal(r.food_points_end, 80)
  assert.equal(r.food_bar_end, 20)
  assert.equal(r.lowest_food_bar, 20)
  assert.equal(r.console_kit_items, 0)
})

test('the bot saying it handed the pickaxe over is not a pass', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_base', world, { capMs: 60 })
  world.onChat = text => { if (text === IRON_BENCH_ORDER) s.chat.push(chatLine('Agent1', 'Here\'s your iron pickaxe, AgentTester')) }
  const r = await testIronPickaxe(s)
  assert.equal(r.pass, false)
  assert.equal(r.failure_reason, 'time_cap')
  assert.deepEqual(r.chat, ['Here\'s your iron pickaxe, AgentTester'])
})

test('a pickaxe the bot keeps is a failure, and the owner stand-in walks over to it first', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_base', world, { capMs: 60 })
  world.onChat = text => { if (text === IRON_BENCH_ORDER) world.bags.Agent1.iron_pickaxe = 1 }
  const r = await testIronPickaxe(s)
  assert.equal(r.pass, false)
  assert.equal(r.failure_reason, 'made_not_handed_over')
  assert.ok(r.owner.walked_over >= 1)
})

test('told it cannot reach the owner, the stand-in walks over and asks again, as the bot said to', async () => {
  const world = fakeWorld()
  let orders = 0
  const s = fakeSession('iron_base', world, { walkAfterMs: 100000 })
  world.onChat = text => {
    if (text !== IRON_BENCH_ORDER) return
    orders++
    if (orders === 1) {
      world.bags.Agent1.iron_pickaxe = 1
      s.chat.push(chatLine('Agent1', 'I can\'t reach you, AgentTester. Ask me again when you\'re closer and I\'ll hand it over'))
    } else {
      world.bags.Agent1.iron_pickaxe = 0
      world.bags.AgentTester.iron_pickaxe = 1
    }
  }
  const r = await testIronPickaxe(s)
  assert.equal(r.pass, true)
  assert.equal(orders, 2)
  assert.equal(r.owner.walked_over, 1)
  assert.equal(r.owner.asked_again, 1)
})

test('a bot still on its way with the pickaxe gets time to arrive by itself', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_base', world, { capMs: 60, walkAfterMs: 100000 })
  world.onChat = text => { if (text === IRON_BENCH_ORDER) world.bags.Agent1.iron_pickaxe = 1 }
  const r = await testIronPickaxe(s)
  assert.equal(r.owner.walked_over, 0)
})

test('a chest memory left from another run stops the scene', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_chest', world, {
    agents: { ctxs: new Map([['Agent1', { bot: { agentsChests: { list: () => [{ pos: { x: 5, y: 64, z: 1 }, items: new Map([['iron_ingot', 3]]) }] } } }]]) }
  })
  const r = await testIronPickaxe(s)
  assert.equal(r.failure_reason, 'setup')
  assert.match(r.failure_detail, /remember 1 chests/)
})

test('after a drop the owner stands clear of it', () => {
  const drop = { x: 0, y: 64, z: 0 }
  assert.deepEqual(stepBackFrom(drop, { x: 10, y: 64, z: 0 }), { x: 10, y: 64, z: 0 })
  assert.deepEqual(stepBackFrom(drop, { x: 2, y: 64, z: 0 }), { x: 5, y: 64, z: 0 })
  assert.deepEqual(stepBackFrom(drop, { x: 0, y: 70, z: 0 }), { x: 5, y: 70, z: 0 })
})

test('a pickaxe that arrives after the cap does not pass', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_base', world, { capMs: 30 })
  world.onChat = text => { if (text === IRON_BENCH_ORDER) setTimeout(() => { world.bags.AgentTester.iron_pickaxe = 1 }, 120) }
  const r = await testIronPickaxe(s)
  assert.equal(r.pass, false)
})

test('deaths come from the server statistics, and missing statistics are unknown', async () => {
  const world = fakeWorld()
  let reads = 0
  const s = fakeSession('iron_base', world, {
    capMs: 20,
    readStats: async () => (reads++ === 0 ? { 'minecraft:custom': { 'minecraft:deaths': 1 } } : { 'minecraft:custom': { 'minecraft:deaths': 3 } })
  })
  assert.equal((await testIronPickaxe(s)).deaths, 2)
  const none = fakeSession('iron_base', fakeWorld(), { capMs: 20, readStats: async () => ({}) })
  assert.equal((await testIronPickaxe(none)).deaths, null)
})

// ---------- the owner stand-in ----------

test('asked in chat, the owner really drops the materials from its bag, in survival, then goes back', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_owner_has', world)
  world.onChat = text => {
    if (text === IRON_BENCH_ORDER) s.chat.push(chatLine('Agent1', 'For the iron pickaxe I need 3 iron ingots and 2 sticks more. Bring them to me and I\'ll carry on'))
    if (text === 'here you go') {
      // the bot picks them up, crafts and hands the pickaxe over
      world.stats = { 'minecraft:picked_up': { 'minecraft:iron_ingot': world.ground.iron_ingot, 'minecraft:stick': world.ground.stick } }
      world.bags.AgentTester.iron_pickaxe = 1
    }
  }
  const r = await testIronPickaxe(s)
  assert.equal(r.pass, true)
  assert.deepEqual(world.ground, { iron_ingot: 3, stick: 2 })
  assert.equal(world.bags.AgentTester.iron_ingot, 0)
  assert.deepEqual(world.tossModes, ['survival', 'survival'])
  assert.equal(world.modes.AgentTester, 'creative')
  const [bx, , bz] = world.positions.Agent1
  const [tx, , tz] = world.positions.AgentTester
  assert.ok(Math.hypot(tx - bx, tz - bz) >= 4.99, 'the owner steps clear of what it dropped')
  assert.deepEqual(r.sources, ['owner'])
  assert.deepEqual(r.iron_from, ['owner'])
  assert.equal(r.used_offered_materials, true)
})

test('it gives what was asked for and keeps the rest', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_owner_has', world, { capMs: 40 })
  world.onChat = text => { if (text === IRON_BENCH_ORDER) s.chat.push(chatLine('Agent1', 'Can you give me 1 iron ingot?')) }
  await testIronPickaxe(s)
  assert.deepEqual(world.ground, { iron_ingot: 1 })
  assert.equal(world.bags.AgentTester.iron_ingot, 2)
  assert.equal(world.bags.AgentTester.stick, 2)
})

test('an owner with nothing says so and drops nothing, so a bot that asks is not left waiting', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_base', world, { capMs: 40 })
  world.onChat = text => { if (text === IRON_BENCH_ORDER) s.chat.push(chatLine('Agent1', 'Do you have 3 iron ingots?')) }
  const r = await testIronPickaxe(s)
  assert.deepEqual(world.ground, {})
  assert.equal(r.owner.said_none, 1)
  assert.ok(world.sent.includes('chat sorry, I have none of that'))
})

test('a progress line gets no drop from an owner who has the materials', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_owner_has', world, { capMs: 40 })
  world.onChat = text => { if (text === IRON_BENCH_ORDER) s.chat.push(chatLine('Agent1', 'For the iron pickaxe I need 3 raw irons, gathering it')) }
  await testIronPickaxe(s)
  assert.deepEqual(world.ground, {})
  assert.equal(world.bags.AgentTester.iron_ingot, 3)
})

// ---------- the sources ----------

test('sources come from server counts', () => {
  const diff = {
    'minecraft:mined': { 'minecraft:oak_log': 3, 'minecraft:stone': 12, 'minecraft:iron_ore': 3, 'minecraft:coal_ore': 1 },
    'minecraft:picked_up': { 'minecraft:raw_iron': 3, 'minecraft:stick': 1 }
  }
  const mined = ironSources({ diff })
  assert.deepEqual(mined.sources, ['gathered'])
  assert.deepEqual(mined.iron_from, ['mined'])
  const chest = ironSources({ diff: { 'minecraft:mined': { 'minecraft:oak_log': 1 } }, chestStart: { iron_ingot: 3, stick: 2 }, chestEnd: {} })
  assert.deepEqual(chest.sources, ['chest', 'gathered'])
  assert.deepEqual(chest.iron_from, ['chest'])
  assert.deepEqual(chest.from_chest, { iron_ingot: 3, stick: 2 })
  // the owner dropped them but the bot never picked them up
  assert.deepEqual(ironSources({ ownerDropped: { iron_ingot: 3 } }).sources, [])
})

test('a chest that cannot be read is not counted as emptied', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_chest', world, { capMs: 20 })
  world.onChat = text => { if (text === IRON_BENCH_ORDER) world.chestReply = 'That position is not loaded' }
  const r = await testIronPickaxe(s)
  assert.deepEqual(r.source_detail.from_chest, {})
  assert.equal(r.source_detail.chest_read, false)
  assert.equal(r.used_offered_materials, false)
})

test('a chest the bot took from is a source', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_chest', world)
  world.onChat = text => {
    if (text !== IRON_BENCH_ORDER) return
    const chest = [...world.chests.values()][0]
    chest.iron_ingot = 0
    chest.stick = 0
    world.bags.AgentTester.iron_pickaxe = 1
  }
  const r = await testIronPickaxe(s)
  assert.equal(r.pass, true)
  assert.deepEqual(r.sources, ['chest'])
  assert.equal(r.used_offered_materials, true)
})

test('the failure reason names what went wrong, most specific first', () => {
  const f = o => ironFailure({ pass: false, capMin: 45, ...o })?.code
  assert.equal(ironFailure({ pass: true }), null)
  assert.equal(f({ setupError: 'x', agentsExit: 1 }), 'setup')
  assert.equal(f({ harnessError: 'x' }), 'harness')
  assert.equal(f({ agentsExit: 'error' }), 'agents_exited')
  assert.equal(f({ botHolds: 1, chat: ['a'] }), 'made_not_handed_over')
  assert.equal(f({ chat: [] }), 'no_answer')
  assert.equal(f({ chat: ['That\'s impossible for me right now: no'] }), 'said_it_could_not')
  assert.equal(f({ chat: ['working on it'] }), 'time_cap')
})

// ---------- a goal the bot reports as failed ----------

const PLAN_STOPPED = 'Stopping the plan at step 7 of 9 (smelt 3 raw iron, craft iron pickaxe): it ended with error'
const inProcess = status => ({ ctxs: new Map([['Agent1', { plan: null, manager: { status } }]]) })

test('a goal the bot reports as failed, then idle, ends the scene at once and stays a failure', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_base', world, { capMs: 5000, goalOverMs: 20, agents: inProcess(() => 'idle') })
  world.onChat = text => { if (text === IRON_BENCH_ORDER) s.chat.push(chatLine('Agent1', PLAN_STOPPED)) }
  const t0 = Date.now()
  const r = await testIronPickaxe(s)
  assert.ok(Date.now() - t0 < 2500, 'it did not wait for the cap')
  assert.equal(r.pass, false)
  assert.equal(r.ended_on_goal_failure, true)
  assert.equal(r.failure_reason, 'goal_failed')
})

test('a reported failure while the bot is still busy does not end the scene', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_base', world, { capMs: 120, goalOverMs: 5, agents: inProcess(() => 'crafting') })
  world.onChat = text => { if (text === IRON_BENCH_ORDER) s.chat.push(chatLine('Agent1', PLAN_STOPPED)) }
  const r = await testIronPickaxe(s)
  assert.equal(r.ended_on_goal_failure, false)
  assert.ok(r.seconds >= 0.1, 'it ran to the cap')
})

test('idle with no reported failure does not end the scene', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_base', world, { capMs: 120, goalOverMs: 5, agents: inProcess(() => 'idle') })
  const r = await testIronPickaxe(s)
  assert.equal(r.ended_on_goal_failure, false)
  assert.equal(r.failure_reason === 'goal_failed', false)
})

test('a pickaxe reaching the tester after a reported failure still passes, counted on the server', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_base', world, { capMs: 3000, goalOverMs: 400, agents: inProcess(() => 'idle') })
  world.onChat = text => {
    if (text !== IRON_BENCH_ORDER) return
    s.chat.push(chatLine('Agent1', PLAN_STOPPED))
    setTimeout(() => { world.bags.AgentTester.iron_pickaxe = 1 }, 30)
  }
  const r = await testIronPickaxe(s)
  assert.equal(r.pass, true)
  assert.equal(r.ended_on_goal_failure, false)
})

test('the owner stays at the bot until the server has taken the drop, so it lands at the bot and not where the owner goes next', async () => {
  const world = fakeWorld()
  const s = fakeSession('iron_owner_has', world, { capMs: 600 })
  const toss = world.tester.toss
  const landed = []
  // as on the live server: the toss is handled on a later tick, at wherever the player stands by then
  world.tester.toss = async (id, meta, n) => {
    setTimeout(() => {
      landed.push([...world.positions.AgentTester])
      toss(id, meta, n)
    }, 40)
  }
  world.onChat = text => {
    if (text === IRON_BENCH_ORDER) s.chat.push(chatLine('Agent1', "You have 3 iron ingots and 2 sticks, drop them to me. I'll wait 20 s, then get the rest myself"))
  }
  const r = await testIronPickaxe(s)
  assert.deepEqual(r.owner.dropped, { iron_ingot: 3, stick: 2 })
  assert.equal(landed.length, 2)
  for (const at of landed) assert.ok(Math.hypot(at[0] - 2.5, at[2] + 1.5) < 1, `landed at ${at}`)
})

