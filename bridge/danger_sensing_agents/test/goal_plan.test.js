// The goal planner with no Minecraft: from a goal and what is available to the ordered steps.
const test = require('node:test')
const assert = require('node:assert/strict')
const { planGoal, goalCommands, resolveGoal, applyPlan, needsToolChain, withAxe, listText } = require('../goal_plan')
const { planCraft } = require('../skills/crafter_plan')
const { parseMessage, parseCommand } = require('../commands')
const { KEEP } = require('../behaviors')

const bag = o => new Map(Object.entries(o))
const chest = (x, items, distance = 5) => ({ pos: { x, y: 64, z: 0 }, items: bag(items), distance })
const plan = (item, count, s = {}, o) => planGoal({ item, count }, { bag: bag(s.bag || {}), chests: s.chests || [], owner: s.owner ? bag(s.owner) : null }, o)
const kinds = p => p.steps.map(s => s.kind === 'gather' ? `gather ${s.what}` : s.kind === 'craft' ? `craft ${s.item}` : s.kind)
const gathered = (p, what) => p.steps.filter(s => s.kind === 'gather' && s.what === what).reduce((n, s) => n + s.count, 0)

// Runs a plan the way the agents do: sources arrive, gathers land in the bag, and every craft has to be possible for
// the real crafter planner, with a table nearby or not
function replay (p, start, tableNear = false) {
  const have = new Map(start)
  const put = (n, c) => have.set(n, (have.get(n) || 0) + c)
  for (const s of p.steps) {
    if (s.kind === 'take' || s.kind === 'ask') for (const [n, c] of s.items) put(n, c)
    if (s.kind === 'gather') put({ wood: 'oak_log', cobblestone: 'cobblestone', iron: 'raw_iron', diamond: 'diamond', coal: 'coal' }[s.what], s.count)
    if (s.kind === 'prep') applyPlan(have, { steps: [{ kind: 'craft', name: s.item, times: s.times, count: s.times * 4 }] })
    if (s.kind === 'axe' && s.chop) put('oak_log', s.chop)  // the logs it chops for the axe when a tree is in sight
    if (s.kind === 'craft' || s.kind === 'axe') {
      const item = s.kind === 'axe' ? 'wooden_axe' : s.item
      const without = new Map(have)
      without.delete(item)
      const c = planCraft(item, without, { tableNear })
      assert.equal(c.missing.size, 0, `${item} is short of ${[...c.missing]} with ${[...have]}`)
      // the fuel has to be in the bag when the furnace is fed, which may be planks crafted earlier in the same plan
      for (const step of c.steps) {
        if (step.kind === 'smelt') {
          for (const [fuel, n] of step.fuel) assert.ok((have.get(fuel) || 0) >= n, `${fuel} for the furnace is not in the bag yet`)
        }
        applyPlan(have, { steps: [step] })
      }
      if (c.placeFurnace) have.set('furnace', Math.max(0, (have.get('furnace') || 0) - 1))
    }
  }
  return have
}

test('a diamond pickaxe from an empty bag: the whole chain in order, ending in the owner\'s hands', () => {
  const p = plan('diamond_pickaxe', 1)
  assert.equal(p.impossible, null)
  assert.deepEqual(kinds(p), [
    'gather wood', 'craft wooden_pickaxe', 'axe', 'gather cobblestone', 'craft stone_pickaxe', 'gather cobblestone', 'gather iron', 'smelt',
    'craft iron_pickaxe', 'gather diamond', 'craft diamond_pickaxe', 'walk', 'hand'
  ])
  assert.deepEqual(p.steps.filter(s => s.what === 'cobblestone').map(s => s.count), [3, 11], '3 with the wooden pickaxe, then the furnace\'s 8 and 3 spare with the stone one')
  assert.equal(gathered(p, 'iron'), 3)
  assert.equal(gathered(p, 'diamond'), 3)
  const smelt = p.steps.find(s => s.kind === 'smelt')
  assert.equal(smelt.count, 3)
  assert.ok(smelt.fuel.length > 0, 'it plans fuel')
  assert.deepEqual(p.steps.at(-1), { kind: 'hand', item: 'diamond_pickaxe', names: ['diamond_pickaxe'], count: 1 })
  for (const near of [false, true]) assert.equal(replay(p, new Map(), near).get('diamond_pickaxe'), 1)
})

test('partial bags: every step already covered is skipped', () => {
  assert.deepEqual(kinds(plan('diamond_pickaxe', 1, { bag: { diamond_pickaxe: 1 } })), ['walk', 'hand'])
  assert.deepEqual(kinds(plan('diamond_pickaxe', 1, { bag: { diamond: 3, stick: 2, crafting_table: 1 } })), ['craft diamond_pickaxe', 'walk', 'hand'])
  let p = plan('diamond_pickaxe', 1, { bag: { iron_pickaxe: 1, diamond: 1, stick: 2, crafting_table: 1 } })
  assert.deepEqual(kinds(p), ['axe', 'gather diamond', 'craft diamond_pickaxe', 'walk', 'hand'], 'an axe before it goes mining, with no wood trip the goal could fail on')
  assert.equal(gathered(p, 'diamond'), 2)
  p = plan('diamond_pickaxe', 1, { bag: { stone_pickaxe: 1, oak_log: 8 } })
  assert.ok(!kinds(p).includes('craft wooden_pickaxe'))
  assert.ok(!kinds(p).includes('craft stone_pickaxe'))
  assert.ok(kinds(p).includes('craft iron_pickaxe'))
  // a better pickaxe than it needs: nothing to make for the iron
  p = plan('iron_pickaxe', 1, { bag: { diamond_pickaxe: 1, raw_iron: 3, furnace: 1, coal: 1, stick: 2, crafting_table: 1 } })
  assert.deepEqual(kinds(p), ['smelt', 'craft iron_pickaxe', 'walk', 'hand'])
})

test('a spread of partial bags always replays through the real crafter planner', () => {
  const bags = [
    {}, { oak_log: 1 }, { oak_log: 3 }, { oak_planks: 2 }, { stick: 1 }, { cobblestone: 2 }, { cobblestone: 20 },
    { wooden_pickaxe: 1 }, { stone_pickaxe: 1 }, { iron_pickaxe: 1 }, { raw_iron: 1 }, { raw_iron: 3, cobblestone: 8, oak_log: 1 },
    { raw_iron: 3, cobblestone: 8, oak_log: 2 }, { iron_ingot: 2 }, { diamond: 2 }, { furnace: 1, raw_iron: 3 }, { coal: 1, raw_iron: 3 },
    { crafting_table: 1 }, { spruce_log: 4 }, { birch_planks: 9, stick: 4 }, { cobbled_deepslate: 11, wooden_pickaxe: 1 }, { stone_axe: 1 }
  ]
  for (const b of bags) {
    for (const item of ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'furnace', 'crafting_table']) {
      const p = plan(item, 1, { bag: b })
      assert.equal(p.impossible, null, `${item} from ${JSON.stringify(b)}`)
      for (const near of [false, true]) {
        assert.ok((replay(p, bag(b), near).get(item) || 0) >= 1, `${item} from ${JSON.stringify(b)}, table near ${near}`)
      }
    }
  }
})

test('the crafter makes crafted fuel before the smelt, so no separate step is needed', () => {
  const b = { raw_iron: 3, cobblestone: 8, oak_log: 2 }
  const p = plan('iron_pickaxe', 1, { bag: b })
  assert.ok(!p.steps.some(s => s.kind === 'prep'))
  replay(p, bag(b), true)
})

test('raw materials are a goal too, with the pickaxe they need made first', () => {
  assert.deepEqual(kinds(plan('wood', 16)), ['gather wood', 'walk', 'hand'])
  const p = plan('diamond', 2)
  assert.deepEqual(kinds(p).slice(-4), ['craft iron_pickaxe', 'gather diamond', 'walk', 'hand'])
  assert.deepEqual(kinds(plan('iron', 4, { bag: { raw_iron: 4 } })), ['walk', 'hand'])
  assert.equal(gathered(plan('wood', 10, { bag: { birch_log: 6 } }), 'wood'), 4, 'any log counts')
})

test('sources in order: bag, then chests nearest first, then the owner, then gathering', () => {
  // the bag covers it: no chest, no asking
  let p = plan('diamond_pickaxe', 1, { bag: { diamond: 3, stick: 2, crafting_table: 1 }, chests: [chest(1, { diamond: 9 })], owner: { diamond: 9 } })
  assert.deepEqual(kinds(p), ['craft diamond_pickaxe', 'walk', 'hand'])
  // a chest before the owner, the nearer chest first
  p = plan('diamond_pickaxe', 1, { bag: { stick: 2, crafting_table: 1 }, chests: [chest(9, { diamond: 3 }, 12), chest(2, { diamond: 2 }, 4)], owner: { diamond: 9 } })
  assert.deepEqual(p.steps.filter(s => s.kind === 'take').map(s => [s.pos.x, s.items]), [[2, [['diamond', 2]]], [9, [['diamond', 1]]]])
  assert.ok(!kinds(p).includes('ask'))
  assert.ok(!kinds(p).includes('gather diamond'))
  // what the chests lack comes from the owner, and only the rest is mined
  p = plan('diamond_pickaxe', 1, { bag: { stick: 2, crafting_table: 1, iron_pickaxe: 1 }, chests: [chest(2, { diamond: 1 })], owner: { diamond: 1 } })
  assert.deepEqual(p.steps.find(s => s.kind === 'ask').items, [['diamond', 1]])
  assert.equal(gathered(p, 'diamond'), 1)
  // the fetching comes before any other work
  assert.deepEqual(kinds(p).slice(0, 2), ['take', 'ask'])
})

test('it takes only what the plan uses', () => {
  const p = plan('iron_pickaxe', 1, { bag: { stick: 2, crafting_table: 1 }, chests: [chest(1, { iron_ingot: 30, diamond: 5, bread: 9 })] })
  assert.deepEqual(p.steps[0].items, [['iron_ingot', 3]])
  assert.deepEqual(kinds(p), ['take', 'craft iron_pickaxe', 'walk', 'hand'])
})

test('a far chest is worth it for diamonds and not for wood', () => {
  assert.ok(!kinds(plan('wood', 4, { chests: [chest(1, { oak_log: 64 }, 120)] })).includes('take'))
  assert.ok(kinds(plan('wood', 4, { chests: [chest(1, { oak_log: 64 }, 20)] })).includes('take'))
  assert.ok(kinds(plan('diamond', 3, { chests: [chest(1, { diamond: 3 }, 120)] })).includes('take'))
})

test('the owner is never asked for their tools or for the thing they asked for', () => {
  const p = plan('diamond_pickaxe', 1, { owner: { iron_pickaxe: 1, stone_pickaxe: 1, wooden_pickaxe: 1, diamond_pickaxe: 1, diamond_sword: 1 } })
  assert.ok(!kinds(p).includes('ask'))
  assert.ok(kinds(p).includes('craft iron_pickaxe'))
  assert.ok(!kinds(plan('wood', 4, { owner: { oak_log: 64 } })).includes('ask'))
  const q = plan('diamond_pickaxe', 1, { owner: { diamond: 3 } })
  assert.deepEqual(q.steps.find(s => s.kind === 'ask').items, [['diamond', 3]])
  assert.equal(gathered(q, 'diamond'), 0)
})

test('with no way to read the owner\'s bag the plan still works and says so', () => {
  const p = plan('stone_pickaxe', 1, { owner: null })
  assert.equal(p.impossible, null)
  assert.equal(p.ownerSeen, false)
  assert.equal(plan('stone_pickaxe', 1, { owner: {} }).ownerSeen, true)
})

test('a wooden axe right after the wooden pickaxe, with its wood gathered, unless it has an axe or a sword', () => {
  const p = plan('stone_pickaxe', 1)
  const k = kinds(p)
  assert.equal(k[k.indexOf('craft wooden_pickaxe') + 1], 'axe')
  assert.equal(k.filter(x => x === 'axe').length, 1)
  const have = replay(p, new Map())
  assert.equal(have.get('wooden_axe'), 1, 'the wood gathered covers the axe too')
  for (const weapon of ['wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe', 'wooden_sword', 'iron_sword']) {
    assert.ok(!kinds(plan('stone_pickaxe', 1, { bag: { [weapon]: 1 } })).includes('axe'), weapon)
  }
  // a pickaxe is no weapon: it makes the axe before it goes mining, and a job with no mining needs none
  const k2 = kinds(plan('iron_pickaxe', 1, { bag: { stone_pickaxe: 1 } }))
  assert.ok(k2.indexOf('axe') >= 0 && k2.indexOf('axe') < k2.indexOf('gather iron'))
  assert.ok(!kinds(plan('wood', 8)).includes('axe'))
})

test('the axe stays with the bot: not in the hand step and kept by !give', () => {
  const p = plan('wooden_pickaxe', 1)
  assert.deepEqual(p.steps.at(-1).names, ['wooden_pickaxe'])
  assert.ok(KEEP.test('wooden_axe'))
  assert.equal(goalCommands(p, 'Owner').find(c => c.kind === 'axe').command.name, 'axe')
})

test('a queue with a wooden pickaxe gets the axe after it', () => {
  const craft = item => ({ name: 'craft', args: { item, keep: true } })
  const q = [craft('wooden_pickaxe'), craft('stone_pickaxe')]
  assert.deepEqual(withAxe(q, new Map()).map(c => c.name), ['craft', 'axe', 'craft'])
  assert.equal(withAxe(q, bag({ iron_sword: 1 })), q)
  assert.deepEqual(withAxe([craft('stone_pickaxe')], new Map()).map(c => c.name), ['craft'])
})

test('what cannot be had is impossible, and says what', () => {
  assert.match(plan('diamond_sword', 1).impossible, /can't make or gather diamond sword/)
  assert.match(plan('bread', 5, { bag: { bread: 2 } }).impossible, /only found 2 bread/)
  assert.match(plan('iron_pickaxe', 9).impossible, /at most 8/)
  assert.match(plan('wood', 900).impossible, /at most 256 logs/)
  assert.match(plan('iron_pickaxe', 1, {}, { dimension: 'minecraft:the_nether' }).impossible, /only gather .* in the overworld/)
  assert.equal(plan('iron_pickaxe', 1, { bag: { iron_pickaxe: 1 } }, { dimension: 'the_nether' }).impossible, null)
  assert.equal(plan('diamond_sword', 1).steps.length, 0)
  // an item it cannot make still comes from a chest
  assert.deepEqual(kinds(plan('bread', 4, { chests: [chest(1, { bread: 6 })] })), ['take', 'walk', 'hand'])
})

test('goal words and the !get command', () => {
  assert.deepEqual(resolveGoal('diamond pickaxe'), { item: 'diamond_pickaxe', count: 1 })
  assert.deepEqual(resolveGoal('wood'), { item: 'wood', count: 16 })
  assert.deepEqual(resolveGoal('raw_iron'), { item: 'iron', count: 8 })
  assert.deepEqual(resolveGoal('coal'), { item: 'coal', count: 8 })
  assert.deepEqual(resolveGoal('minecraft:bread'), { item: 'bread', count: 1 })
  assert.equal(resolveGoal(''), null)
  assert.deepEqual(parseCommand(['get', 'diamond', 'pickaxe']), { name: 'get', args: { item: 'diamond_pickaxe', count: 1 } })
  assert.deepEqual(parseCommand(['get', 'wood', '10']), { name: 'get', args: { item: 'wood', count: 10 } })
  assert.ok(parseCommand(['get']).error)
  assert.ok(parseCommand(['get', 'wood', '0']).error)
})

test('"make me" is a goal, "craft me" stays the crafter\'s own command', () => {
  const names = ['Agent1']
  const p = parseMessage('Agent1 make me an iron pickaxe', names)
  assert.deepEqual(p, { type: 'command', targets: ['Agent1'], command: { name: 'get', args: { item: 'iron_pickaxe', count: 1 } } })
  assert.equal(parseMessage('please make me a furnace', names).command.name, 'get')
  assert.equal(parseMessage('Agent1 craft me an iron pickaxe', names).command.name, 'craft')
  assert.equal(parseMessage('can you craft a furnace', names).command.name, 'craft')
})

test('the crafter alone would stall only when a material needs a better pickaxe than the bag holds', () => {
  assert.equal(needsToolChain('diamond_pickaxe', new Map()), true)
  assert.equal(needsToolChain('iron_pickaxe', bag({ wooden_pickaxe: 1 })), true)
  assert.equal(needsToolChain('iron_pickaxe', bag({ stone_pickaxe: 1 })), false)
  assert.equal(needsToolChain('stone_pickaxe', new Map()), false)
  assert.equal(needsToolChain('diamond_pickaxe', bag({ diamond: 3, oak_log: 2 })), false)
})

test('chat words for items', () => {
  assert.equal(listText([['diamond', 3], ['stick', 2]]), '3 diamonds and 2 sticks')
  assert.equal(listText([['raw_iron', 3]]), '3 raw iron')
  assert.equal(listText([['oak_planks', 2], ['coal', 1], ['iron_ingot', 3]]), '2 oak planks, 1 coal and 3 iron ingots')
})
