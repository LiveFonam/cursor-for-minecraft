// Plain words reach Claude Haiku, the shortcuts stay as the fallback, and every call's tokens show in the log. A fake
// model client stands in, so nothing here makes an API call
const test = require('node:test')
const assert = require('node:assert/strict')
const { makeBot } = require('./mockbot')
const { parseMessage, formatCommand } = require('../commands')
const { Translator, noteUsage, systemPrompt } = require('../translator')
const { Designer } = require('../designer')
const { makeModes } = require('../behaviors')
const { Friends, Blackboard } = require('../targets')
const { Agents } = require('../agents')
const { DemoAgents } = require('../demo/run')
const { EvilBrain } = require('../demo/evil_brain')

const OWNER = 'TestOwner'
const KEY = 'sk-test-secret'
const NAMES = ['Agent1']

const textReply = (text, usage) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage })
const fakeClient = create => ({ messages: { create } })
const answer = lines => ({ lines, parsed: lines.map(l => ({ targets: 'all', command: parseMessage(l, NAMES).command })), dropped: [], impossible: null, vague: null })
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

function crew (reply, { enabled = true } = {}) {
  const { bot } = makeBot({ groundY: 63 })
  const agents = Object.create(Agents.prototype)
  Object.assign(agents, {
    owner: OWNER, names: NAMES, ctxs: new Map(), friends: new Friends(OWNER, NAMES),
    blackboard: new Blackboard(), verbosity: 'normal', lastAnnounce: { text: '', at: 0 }, lastEvent: new Map(), metricsFile: null, closing: false,
    log: () => {}, miner: 'branch'
  })
  agents.noDigMoves = agents.digMoves = agents.buildMoves = () => ({})
  agents.ensureKit = async () => {}
  agents.blueprintNames = () => ['small_hut']
  const asked = []
  agents.translator = { enabled, translate: async text => { asked.push(text); return reply } }
  const ctx = { bot, agents, alive: true, seq: 0, pickaxes: null, human: { level: 'off' } }
  makeModes(ctx)
  agents.ctxs.set('Agent1', ctx)
  const ran = []
  agents.execute = (c, command) => { ran.push(formatCommand('all', command)); return Promise.resolve('done') }
  return { bot, agents, ctx, asked, ran }
}

test('noteUsage keeps a running total and logs one line per call', () => {
  const lines = []
  const before = noteUsage(() => {}, { input_tokens: 0, output_tokens: 0 }, 'zero')
  const first = noteUsage(l => lines.push(l), { input_tokens: 100, output_tokens: 20 }, 'translator')
  const second = noteUsage(l => lines.push(l), { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, 'translator')
  assert.equal(lines.length, 2)
  assert.equal(first.calls, before.calls + 1)
  assert.equal(second.calls, before.calls + 2)
  assert.equal(second.input, before.input + 150)
  assert.equal(second.output, before.output + 25)
  assert.equal(second.cacheRead, before.cacheRead + 7)
  assert.equal(second.cacheWrite, before.cacheWrite + 3)
  assert.match(lines[0], /translator.*in 100.*out 20/)
  assert.match(lines[1], /cache read 7.*cache write 3/)
  assert.ok(lines[1].includes(`${second.calls} calls`), lines[1])
})

test('a call with no usage still counts and does not throw', () => {
  const lines = []
  const before = noteUsage(() => {}, {}, 'zero')
  const after = noteUsage(l => lines.push(l), undefined, 'translator')
  assert.equal(after.calls, before.calls + 1)
  assert.equal(after.input, before.input)
  assert.equal(lines.length, 1)
})

test('the translator logs its tokens with the model name, and never the key or the words', async () => {
  const lines = []
  const t = new Translator({ botNames: NAMES, log: l => lines.push(l), credentials: { key: KEY } })
  t.client = fakeClient(async () => textReply('{"goal": {"item": "wooden_pickaxe", "count": 1}}', { input_tokens: 812, output_tokens: 31 }))
  const r = await t.translate('make me a pickaxe bro')
  assert.deepEqual(r.lines, ['!get wooden_pickaxe 1'])
  const usage = lines.filter(l => /in 812/.test(l))
  assert.equal(usage.length, 1, lines.join(' | '))
  assert.match(usage[0], /claude-haiku-5-5/)
  assert.ok(!usage[0].includes(KEY))
  assert.ok(!usage[0].includes('pickaxe'))
})

test('a refused translator call is still billed, so it is still logged', async () => {
  const lines = []
  const t = new Translator({ botNames: NAMES, log: l => lines.push(l), credentials: { key: KEY } })
  t.client = fakeClient(async () => ({ stop_reason: 'refusal', content: [], usage: { input_tokens: 9, output_tokens: 1 } }))
  await t.translate('something')
  assert.equal(lines.filter(l => /in 9\b/.test(l)).length, 1, lines.join(' | '))
})

test('a failed translator call logs no tokens', async () => {
  const lines = []
  const t = new Translator({ botNames: NAMES, log: l => lines.push(l), credentials: { key: KEY } })
  t.client = fakeClient(async () => { throw new Error('down') })
  const r = await t.translate('make me a pickaxe')
  assert.ok(r.error)
  assert.equal(lines.filter(l => /tokens/.test(l)).length, 0)
})

test('the designer logs the tokens of every try', async () => {
  const lines = []
  const d = new Designer({ log: l => lines.push(l), credentials: { key: KEY } })
  d.client = fakeClient(async () => textReply('not json', { input_tokens: 2000, output_tokens: 40 }))
  await d.design('tower', 'a small tower')
  assert.equal(lines.filter(l => /designer.*in 2000/.test(l)).length, 2, lines.join(' | '))
})

test('the evil planner logs its tokens, even for an answer that lands after its timeout', async () => {
  const lines = []
  const late = () => new Promise(resolve => setTimeout(() => resolve(textReply('{}', { input_tokens: 77, output_tokens: 4 })), 30))
  const brain = new EvilBrain({ log: l => lines.push(l), client: fakeClient(late), credentials: { key: KEY }, timeoutMs: 5 })
  await assert.rejects(() => brain.request('system', {}), /timed out/)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(lines.filter(l => /evil-brain.*in 77/.test(l)).length, 1, lines.join(' | '))
})

test('the parser hands shortcut lines to the translator only when asked, with the shortcut kept', () => {
  const via = { viaTranslator: true }
  for (const [line, targets, words] of [
    ['craft me a stone pickaxe', 'all', 'craft me a stone pickaxe'],
    ['gather wood', 'all', 'gather wood'],
    ['@agents craft a furnace', 'all', 'craft a furnace'],
    ['Agent1, gather 10 iron', ['Agent1'], 'gather 10 iron']
  ]) {
    const p = parseMessage(line, NAMES, via)
    assert.equal(p.type, 'translate', line)
    assert.deepEqual(p.targets, targets, line)
    assert.equal(p.text, words, line)
    assert.deepEqual(p.shortcut, parseMessage(line, NAMES), line)
    assert.equal(p.shortcut.type, 'command', line)
  }
  assert.equal(parseMessage('!craft stone pickaxe', NAMES, via).type, 'command')
  assert.equal(parseMessage('hello there', NAMES, via), null)
  assert.equal(parseMessage('craft me a stone pickaxe', NAMES).type, 'command')
})

test('with the translator on, the owner\'s plain request goes to Haiku and its answer runs', async () => {
  const { bot, agents, asked, ran } = crew(answer(['!get stone_pickaxe 1']))
  await agents.handleChat(bot, `<${OWNER}> craft me a stone pickaxe`)
  await settle()
  assert.deepEqual(asked, ['craft me a stone pickaxe'])
  assert.deepEqual(ran, ['!get stone_pickaxe 1'])
})

for (const [why, reply] of [
  ['an API error', { lines: [], parsed: [], error: 'API error 500: down' }],
  ['a command that does not exist', { lines: [], parsed: [], dropped: ['!dance'], impossible: null, vague: null }]
]) {
  test(`when Haiku gives ${why}, the shortcut still runs and the error stays out of chat`, async () => {
    const { bot, agents, asked, ran } = crew(reply)
    await agents.handleChat(bot, `<${OWNER}> gather 5 wood`)
    await settle()
    assert.equal(asked.length, 1)
    assert.equal(ran.length, 1, ran.join(' | '))
    assert.match(ran[0], /^!gather/)
    assert.ok(!bot.chats.some(c => /API error|no command/.test(c)), bot.chats.join(' | '))
  })
}

test('with no key the shortcuts run and Haiku is not asked', async () => {
  const { bot, agents, asked, ran } = crew(answer([]), { enabled: false })
  await agents.handleChat(bot, `<${OWNER}> gather 5 wood`)
  await settle()
  assert.deepEqual(asked, [])
  assert.match(ran[0], /^!gather/)
})

test('a line starting with ! is an exact command and never uses Haiku', async () => {
  const { bot, agents, asked, ran } = crew(answer([]))
  await agents.handleChat(bot, `<${OWNER}> !gather wood 5`)
  await settle()
  assert.deepEqual(asked, [])
  assert.match(ran[0], /^!gather/)
})

test('a friend\'s request stays on the shortcut, so the model can never widen what a friend may order', async () => {
  const { bot, agents, asked, ran } = crew(answer(['!kill']))
  agents.friends = { has: n => n === 'Pal' }
  await agents.handleChat(bot, '<Pal> craft me a stone pickaxe')
  await settle()
  assert.deepEqual(asked, [])
  assert.equal(ran.length, 1)
  assert.match(ran[0], /stone.pickaxe/)
})

test('a question Haiku routes to !status is answered without stopping the job in progress', async () => {
  const { bot, agents, ctx, asked, ran } = crew(answer(['!status']))
  ctx.seq = 5
  await agents.handleChat(bot, `<${OWNER}> @agents how much food do you have`)
  await settle()
  assert.deepEqual(asked, ['how much food do you have'])
  assert.deepEqual(ran, ['!status'])
  assert.equal(ctx.seq, 5, 'the running job keeps its turn')
  assert.ok(!bot.chats.some(c => /On it/.test(c)), bot.chats.join(' | '))
})

test('the prompt sends questions about the bots to the status commands', () => {
  const prompt = systemPrompt(NAMES)
  assert.match(prompt, /how much food do you have.*!status/)
  assert.match(prompt, /what are you doing.*!doing/)
})

test('a demo task in plain words goes through Haiku when the translator is on', async () => {
  const a = Object.create(DemoAgents.prototype)
  const sent = []
  Object.assign(a, {
    names: NAMES,
    demo: { agent: 'Agent1', player: OWNER },
    ctxs: new Map([['Agent1', { seq: 0 }]]),
    translator: { enabled: true },
    execute: () => assert.fail('the shortcut ran'),
    onOwnerMessage: async (line, sender) => { sent.push([line, sender]) }
  })
  await a.runTask('craft me a stone pickaxe')
  assert.deepEqual(sent, [['@agents craft me a stone pickaxe', OWNER]])
})
