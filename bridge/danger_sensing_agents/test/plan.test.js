// Plain words to a queue of subtasks: the plan checker (plan_check.js) and the agents' handling of the translator's
// answer, no server and no API key needed (the translator is a stand-in that answers like Claude Haiku would):
//   node --test bridge/danger_sensing_agents/test/plan.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const registry = require('prismarine-registry')('1.21.11')
const { makeBot } = require('./mockbot')
const { parseMessage, formatCommand } = require('../commands')
const { checkPlan, blockLevel } = require('../plan_check')
const { systemPrompt } = require('../translator')
const { makeModes } = require('../behaviors')
const { Friends, Blackboard } = require('../targets')
const { Agents } = require('../agents')

const OWNER = 'OwnerPlayer'
const cmds = lines => lines.map(l => parseMessage(l, ['Agent1']).command)
const check = (lines, bag = {}, o = {}) => checkPlan(cmds(lines), new Map(Object.entries(bag)), { registry, blueprints: ['small_hut', 'wheat_farm'], ...o })
const steps = r => r.commands.map(c => formatCommand('all', c))

// ---------- the checker ----------

test('diamonds from an empty bag: the pickaxes go in front, wooden to iron, each kept', () => {
  const r = check(['!gather diamonds 3', '!give'])
  assert.equal(r.impossible, null)
  assert.deepEqual(steps(r), ['!craft wooden pickaxe keep', '!craft stone pickaxe keep', '!craft iron pickaxe keep', '!gather diamonds 3', '!give'])
  assert.equal(r.added.length, 3)
})

test('only the pickaxes it lacks are added, and none twice', () => {
  assert.deepEqual(steps(check(['!gather diamonds 3'], { stone_pickaxe: 1 })), ['!craft iron pickaxe keep', '!gather diamonds 3'])
  assert.deepEqual(steps(check(['!gather iron 5'], { iron_pickaxe: 1 })), ['!gather iron 5'])
  assert.deepEqual(steps(check(['!gather wood 10', '!come'])), ['!gather wood 10', '!come'])
  // the model already planned the pickaxes: nothing added, nothing doubled
  const r = check(['!craft wooden pickaxe keep', '!craft stone pickaxe keep', '!gather iron 3'])
  assert.deepEqual(steps(r), ['!craft wooden pickaxe keep', '!craft stone pickaxe keep', '!gather iron 3'])
  assert.equal(r.added.length, 0)
  // one it gave the player is not one it has: it makes its own
  assert.deepEqual(steps(check(['!craft stone pickaxe', '!gather iron 3'], { wooden_pickaxe: 1 })),
    ['!craft stone pickaxe', '!craft stone pickaxe keep', '!gather iron 3'])
})

test("a craft's own materials count: an iron pickaxe from nothing needs a stone one first, for the raw iron", () => {
  const r = check(['!craft iron pickaxe'])
  assert.deepEqual(steps(r), ['!craft wooden pickaxe keep', '!craft stone pickaxe keep', '!craft iron pickaxe'])
  assert.deepEqual(steps(check(['!craft crafting table'])), ['!craft crafting table'])
})

test('mining a block checks its harvest tool: obsidian takes a diamond pickaxe', () => {
  assert.equal(blockLevel(registry, 'obsidian'), 3)
  assert.equal(blockLevel(registry, 'iron_ore'), 1)
  assert.equal(blockLevel(registry, 'dirt'), -1)
  assert.equal(blockLevel(registry, 'snow'), null, 'a shovel block is not checked')
  assert.deepEqual(steps(check(['!mine obsidian 4'], { iron_pickaxe: 1 })), ['!craft diamond pickaxe keep', '!mine obsidian 4'])
})

test('impossible: Nether ores outside the Nether, a blueprint it has not got', () => {
  assert.match(check(['!mine debris 2']).impossible, /ancient debris is only in the Nether/)
  assert.equal(check(['!mine debris 2'], { diamond_pickaxe: 1 }, { dimension: 'minecraft:the_nether' }).impossible, null)
  assert.match(check(['!gather wood 4', '!build castle here']).impossible, /no blueprint called castle/)
  assert.equal(check(['!design castle a tall stone tower', '!build castle here']).impossible, null)
  assert.equal(check(['!build small_hut here']).impossible, null)
})

test('the translator is told to name one request and never to plan', () => {
  const p = systemPrompt(['Agent1'], [])
  assert.match(p, /You never plan/)
  for (const form of ['"goal"', '"command"', '"vague"', '"impossible"']) assert.ok(p.includes(form), form)
  assert.ok(!p.includes('!craft'), 'crafting steps are the script\'s')
  assert.ok(!p.includes('!gather'), 'gathering steps are the script\'s')
  assert.match(p, /!guard/)
})

// ---------- the agents with a stand-in translator ----------

function agentsWith (answer, { inv = {} } = {}) {
  const { bot } = makeBot({ groundY: 63 })
  for (const [n, c] of Object.entries(inv)) bot.give(n, c)
  const agents = Object.create(Agents.prototype)
  Object.assign(agents, {
    owner: OWNER, names: ['Agent1'], ctxs: new Map(), friends: new Friends(OWNER, ['Agent1']),
    blackboard: new Blackboard(), verbosity: 'normal', lastAnnounce: { text: '', at: 0 }, lastEvent: new Map(), metricsFile: null, closing: false,
    log: () => {}, miner: 'branch'
  })
  agents.noDigMoves = agents.digMoves = agents.buildMoves = () => ({})
  agents.ensureKit = async () => {}
  agents.blueprintNames = () => ['small_hut']
  const asked = []
  agents.translator = {
    enabled: true,
    translate: async (text, targets, state) => { asked.push({ text, state }); return answer }
  }
  const ctx = { bot, agents, alive: true, seq: 0, pickaxes: null, human: { level: 'off' } }
  makeModes(ctx)
  agents.ctxs.set('Agent1', ctx)
  // nothing really runs in these tests: each step is recorded and ends at once
  const ran = []
  agents.execute = (c, command) => { ran.push(formatCommand('all', command)); return Promise.resolve(answer.results?.[ran.length - 1] || 'done') }
  return { bot, agents, ctx, asked, ran }
}

const answer = lines => ({ lines, parsed: lines.map(l => ({ targets: 'all', command: parseMessage(l, ['Agent1']).command })), dropped: [], impossible: null })
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('plain words: only the words go to the model, the checked queue runs in order and is said in chat', async () => {
  const { bot, agents, asked, ran } = agentsWith(answer(['!gather diamonds 3', '!give']), { inv: { bread: 4, oak_log: 2 } })
  await agents.handleChat(bot, `<${OWNER}> @agents go get me some diamonds`)
  await settle()
  assert.equal(asked[0].text, 'go get me some diamonds')
  assert.equal(asked[0].state, undefined)
  assert.deepEqual(ran, ['!craft wooden pickaxe keep', '!axe', '!craft stone pickaxe keep', '!craft iron pickaxe keep', '!gather diamonds 3', '!give'])
  assert.ok(bot.chats.some(c => /On it: 1\) !craft wooden pickaxe keep 2\) craft wooden axe to keep 3\) .* \(I added the pickaxes I need\)/.test(c)), bot.chats.join(' | '))
  assert.ok(bot.chats.some(c => /Done with the plan \(6 steps\)/.test(c)))
})

test('impossible from the model: it says so and runs nothing', async () => {
  const { bot, agents, ran } = agentsWith({ lines: [], parsed: [], dropped: [], impossible: 'the bots cannot enchant' })
  await agents.handleChat(bot, `<${OWNER}> @agents enchant my sword`)
  await settle()
  assert.deepEqual(ran, [])
  assert.ok(bot.chats.some(c => /That's impossible for me right now: the bots cannot enchant/.test(c)), bot.chats.join(' | '))
})

test('impossible when the model planned a command that does not exist, even with good steps around it', async () => {
  const r = answer(['!gather diamonds 3', '!give'])
  r.dropped = ['!craft diamond sword']
  const { bot, agents, ran } = agentsWith(r)
  await agents.handleChat(bot, `<${OWNER}> @agents make me a diamond sword`)
  await settle()
  assert.deepEqual(ran, [])
  assert.ok(bot.chats.some(c => /impossible for me right now: there is no command for "!craft diamond sword"/.test(c)), bot.chats.join(' | '))
})

test('impossible from the checker: ancient debris in the overworld', async () => {
  const { bot, agents, ran } = agentsWith(answer(['!mine debris 4', '!give']))
  await agents.handleChat(bot, `<${OWNER}> @agents get me netherite`)
  await settle()
  assert.deepEqual(ran, [])
  assert.ok(bot.chats.some(c => /impossible for me right now: ancient debris is only in the Nether/.test(c)), bot.chats.join(' | '))
})

test('a step that does not get it done stops the plan there and says so', async () => {
  const a = answer(['!gather iron 5', '!give'])
  a.results = ['done', 'done', 'done', 'short']  // wooden pickaxe, axe and stone pickaxe made, then the iron came back short
  const { bot, agents, ran, ctx } = agentsWith(a)
  await agents.handleChat(bot, `<${OWNER}> @agents bring me iron`)
  await settle()
  assert.deepEqual(ran, ['!craft wooden pickaxe keep', '!axe', '!craft stone pickaxe keep', '!gather iron 5'])
  assert.ok(bot.chats.some(c => /Stopping the plan at step 4 of 5 \(!gather iron 5\): it ended with short/.test(c)), bot.chats.join(' | '))
  assert.equal(ctx.plan, null)
})

test('!plan says the steps left', async () => {
  const { bot, agents, ctx } = agentsWith(answer(['!come']))
  ctx.seq = 7
  ctx.plan = { steps: ['!craft stone pickaxe keep', '!gather iron 5', '!give'], index: 1, seq: 7 }
  agents.execute = Agents.prototype.execute
  await agents.handleChat(bot, `<${OWNER}> !plan`)
  assert.ok(bot.chats.some(c => /Step 2 of 3, .*2\) !gather iron 5 3\) !give/.test(c)), bot.chats.join(' | '))
  ctx.seq = 8  // a typed order replaced it
  await agents.handleChat(bot, `<${OWNER}> !plan`)
  assert.ok(bot.chats.some(c => /No plan running/.test(c)))
})

test('!help answers in chat once, whatever the bots are doing, and leaves a !stay and a plan alone', async () => {
  const { bot, agents, ctx } = agentsWith(answer([]))
  delete agents.execute  // the real commands
  ctx.staying = true
  ctx.seq = 7
  await agents.handleChat(bot, `<${OWNER}> !help`)
  assert.equal(bot.chats.length, 1, bot.chats.join(' | '))
  assert.match(bot.chats[0], /^Commands: !kill !guard /)
  await agents.handleChat(bot, `<${OWNER}> !help guard`)
  assert.match(bot.chats[1], /^!guard \[radius\]/)
  assert.ok(!bot.chats.some(c => /unknown command/.test(c)))
  assert.equal(ctx.staying, true)
  assert.equal(ctx.seq, 7)
})
