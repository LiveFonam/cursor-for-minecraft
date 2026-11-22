// Command parser tests, no server needed:  node --test bridge/danger_sensing_agents/test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseChatLine, chatSender, helpText, COMMANDS, parseMessage, resolveBlocks, formatCommand } = require('../commands')
const { Translator } = require('../translator')

const BOTS = ['Agent1', 'Agent2']

test('reads chat lines, with and without the Not Secure tag', () => {
  assert.deepEqual(parseChatLine('<OwnerPlayer> !stop'), { sender: 'OwnerPlayer', message: '!stop' })
  assert.deepEqual(parseChatLine('[Not Secure] <OwnerPlayer> !kill 30'), { sender: 'OwnerPlayer', message: '!kill 30' })
  assert.equal(parseChatLine('OwnerPlayer joined the game'), null)
  // a player quoting the owner is still that player
  assert.equal(parseChatLine('<Eve> <OwnerPlayer> !stop').sender, 'Eve')
})

test('kill takes a radius and a name in any order', () => {
  let p = parseMessage('!kill', BOTS)
  assert.equal(p.type, 'command')
  assert.deepEqual(p.command, { name: 'kill', args: { radius: 50, target: null } })
  p = parseMessage('!kill 30 Steve', BOTS)
  assert.deepEqual(p.command.args, { radius: 30, target: 'Steve' })
  p = parseMessage('!kill Steve 20', BOTS)
  assert.deepEqual(p.command.args, { radius: 20, target: 'Steve' })
  assert.equal(parseMessage('!kill 999', BOTS).command.args.radius, 128)
})

test('addressing one bot, case insensitive', () => {
  const p = parseMessage('!agent1 mine iron 10', BOTS)
  assert.deepEqual(p.targets, ['Agent1'])
  assert.equal(p.command.name, 'mine')
  assert.deepEqual(p.command.args.blocks, ['iron_ore', 'deepslate_iron_ore'])
  assert.equal(p.command.args.count, 10)
  assert.equal(parseMessage('!all stop', BOTS).targets, 'all')
})

test('mine maps ores, plurals and plain block names', () => {
  assert.deepEqual(resolveBlocks('diamond').blocks, ['diamond_ore', 'deepslate_diamond_ore'])
  assert.deepEqual(resolveBlocks('diamonds').blocks, ['diamond_ore', 'deepslate_diamond_ore'])
  assert.deepEqual(resolveBlocks('raw_iron').blocks, ['iron_ore', 'deepslate_iron_ore'])
  assert.deepEqual(resolveBlocks('quartz').blocks, ['nether_quartz_ore'])
  assert.equal(resolveBlocks('logs').blocks.length, 9)
  assert.deepEqual(resolveBlocks('oak_log').blocks, ['oak_log'])
  const p = parseMessage('!mine diamond 5', BOTS)
  assert.deepEqual(p.command.args, { block: 'diamond', blocks: ['diamond_ore', 'deepslate_diamond_ore'], count: 5 })
  assert.equal(parseMessage('!mine coal', BOTS).command.args.count, 5)
  assert.equal(parseMessage('!mine iron ore 3', BOTS).command.args.block, 'iron')
})

test('bad commands are errors, ordinary chat is ignored', () => {
  assert.equal(parseMessage('!dance', BOTS).type, 'error')
  assert.equal(parseMessage('!mine', BOTS).type, 'error')
  assert.equal(parseMessage('!guard far', BOTS).type, 'error')
  assert.equal(parseMessage('!stop now', BOTS).type, 'error')
  assert.equal(parseMessage('!human max', BOTS).type, 'error')
  assert.equal(parseMessage('hello everyone', BOTS), null)
  assert.equal(parseMessage('/gamemode creative', BOTS), null)
})

test('plain words go to the translator', () => {
  assert.deepEqual(parseMessage('@agents go get me some diamonds', BOTS),
    { type: 'translate', targets: 'all', text: 'go get me some diamonds' })
  assert.deepEqual(parseMessage('Agent2, come here please', BOTS),
    { type: 'translate', targets: ['Agent2'], text: 'come here please' })
  assert.equal(parseMessage('@agents', BOTS), null)
})

test('human levels and stances', () => {
  assert.deepEqual(parseMessage('!human full', BOTS).command, { name: 'human', args: { level: 'full' } })
  assert.equal(parseMessage('!guard 8', BOTS).command.args.radius, 8)
  for (const c of ['stop', 'come', 'follow', 'stay', 'status', 'give']) assert.equal(parseMessage(`!${c}`, BOTS).command.name, c)
})

test('formatCommand round trips', () => {
  for (const line of ['!mine diamond 5', '!Agent1 kill 30 Steve', '!guard 8', '!stop', '!human off']) {
    const p = parseMessage(line, BOTS)
    const back = formatCommand(p.targets === 'all' ? 'all' : p.targets[0], p.command)
    assert.deepEqual(parseMessage(back, BOTS), p)
  }
})

test('translator output is checked by the same parser', () => {
  const t = new Translator({ botNames: BOTS, credentials: null })
  assert.equal(t.enabled, false)
  let r = t.check('{"command": "!mine diamond 5"}')
  assert.deepEqual(r.lines, ['!mine diamond 5'])
  for (const bad of ['/op Eve', '!fly', 'come']) {
    r = t.check(JSON.stringify({ command: bad }))
    assert.deepEqual(r.parsed, [], bad)
    assert.deepEqual(r.dropped, [bad], 'a line that is no command is kept apart (the request is impossible)')
  }
  r = t.check('here: {"command": "!mine iron 3"}', ['Agent2'])
  assert.deepEqual(r.parsed[0].targets, ['Agent2'])
  r = t.check('{"command": "!Agent1 come"}', ['Agent2'])
  assert.equal(r.lines.length, 0)
  r = t.check('{"impossible": "no bot can fish"}')
  assert.equal(r.impossible, 'no bot can fish')
  r = t.check('{"reject": "cannot build"}')
  assert.equal(r.impossible, 'cannot build', 'the reject field counts')
  assert.ok(t.check('not json').error)
})

test('the translator reads one request: a goal, a command, or one of the two refusals', () => {
  const t = new Translator({ botNames: BOTS, credentials: null })
  let r = t.check('{"goal": {"item": "diamond_pickaxe", "count": 1}}')
  assert.deepEqual(r.parsed[0].command, { name: 'get', args: { item: 'diamond_pickaxe', count: 1 } })
  r = t.check('{"goal": {"item": "wood", "count": null}}')
  assert.deepEqual(r.parsed[0].command.args, { item: 'wood', count: 16 }, 'no count said: the usual amount')
  r = t.check('{"vague": "Which item do you want?"}')
  assert.equal(r.vague, 'Which item do you want?')
  assert.equal(r.impossible, null)
  assert.deepEqual(r.parsed, [])
  r = t.check('{"impossible": "I can\'t go to the Nether"}')
  assert.equal(r.vague, null)
  assert.deepEqual(r.parsed, [])
  // a whole plan is not an answer any more, and a skill named directly still goes through the planner
  assert.ok(t.check('{"commands": ["!gather wood 10", "!come"]}').error)
  assert.equal(t.check('{"command": "!craft iron pickaxe"}').parsed[0].command.name, 'get')
  assert.deepEqual(t.check('{"command": "!gather iron 5"}').parsed[0].command.args, { item: 'iron', count: 5 })
})

test('quiet and verbose', () => {
  assert.deepEqual(parseMessage('!quiet', BOTS).command, { name: 'quiet', args: {} })
  assert.deepEqual(parseMessage('!verbose', BOTS).command, { name: 'verbose', args: {} })
  assert.equal(parseMessage('!quiet please', BOTS).type, 'error')
})

test('build, farm, expand, explore, design and blueprints', () => {
  const { SOLO } = require('../commands')
  let p = parseMessage('!build small_hut here', BOTS)
  assert.deepEqual(p.command, { name: 'build', args: { blueprint: 'small_hut', site: 'here', facing: null } })
  p = parseMessage('!Agent2 build wheat_farm 10 64 -20 east', BOTS)
  assert.deepEqual(p.targets, ['Agent2'])
  assert.deepEqual(p.command.args, { blueprint: 'wheat_farm', site: [10, 64, -20], facing: 'east' })
  assert.deepEqual(parseMessage('!farm', BOTS).command.args, { crop: 'wheat', here: false })
  assert.deepEqual(parseMessage('!farm here potatoes', BOTS).command.args, { crop: 'potato', here: true })
  assert.equal(parseMessage('!farm corn', BOTS).type, 'error')
  assert.equal(parseMessage('!build hut 1 2 3 up', BOTS).type, 'error')
  assert.deepEqual(parseMessage('!expand wheat_farm', BOTS).command.args, { build: 'wheat_farm' })
  assert.equal(parseMessage('!explore', BOTS).command.args.radius, 64)
  assert.equal(parseMessage('!explore 500', BOTS).command.args.radius, 256)
  assert.deepEqual(parseMessage('!design tower a 5 by 5 stone tower', BOTS).command.args, { blueprint: 'tower', words: 'a 5 by 5 stone tower' })
  assert.equal(parseMessage('!blueprints', BOTS).command.name, 'blueprints')
  for (const n of ['build', 'farm', 'expand', 'explore', 'design']) assert.ok(SOLO.has(n))
  for (const line of ['!build small_hut here', '!build wall 1 70 2 south', '!farm carrot here', '!expand wall', '!explore 32', '!design hall a long oak hall']) {
    const q = parseMessage(line, BOTS)
    assert.deepEqual(parseMessage(formatCommand('all', q.command), BOTS).command, q.command)
  }
})

test('the translator knows the blueprints and when to design a new one', () => {
  const { systemPrompt } = require('../translator')
  const text = systemPrompt(BOTS, [{ name: 'small_hut', description: 'a hut' }, { name: 'wheat_farm', description: 'the village farm' }])
  assert.match(text, /small_hut: a hut/)
  assert.match(text, /!build <blueprint> \[here \| x y z\]/)
  assert.match(text, /!design <new_name>/)
  const t = new Translator({ botNames: BOTS, credentials: null })
  let r = t.check('{"command": "!build small_hut here"}')
  assert.deepEqual(r.parsed[0].command.args, { blueprint: 'small_hut', site: 'here', facing: null })
  r = t.check('{"command": "!design tower a stone tower"}')
  assert.deepEqual(r.parsed.map(x => x.command.name), ['design', 'build'], 'a new blueprint is built right after it is drawn')
  assert.equal(r.parsed[1].command.args.blueprint, 'tower')
})

test('an order counts only from the player the chat packet names, whatever the line looks like', () => {
  const OWNER = '11111111-1111-3111-8111-111111111111'
  const EVIL = '22222222-2222-3222-8222-222222222222'
  const PAL = '33333333-3333-3333-8333-333333333333'
  const players = {
    OwnerPlayer: { username: 'OwnerPlayer', uuid: OWNER },
    Evil: { username: 'Evil', uuid: EVIL },
    Pal: { username: 'Pal', uuid: PAL }
  }
  const chat = { translate: '<%s> %s' }
  const say = { translate: '[%s] %s' }
  assert.equal(chatSender(players, '<OwnerPlayer> !stop', 'chat', chat, OWNER), 'OwnerPlayer')
  assert.equal(chatSender(players, '<OwnerPlayer> !stop', 'chat', { translate: 'chat.type.text' }, OWNER.toUpperCase()), 'OwnerPlayer')
  assert.equal(chatSender(players, '<Pal> craft me a stone pickaxe', 'chat', chat, PAL), 'Pal', 'a friend still gets through')
  assert.equal(chatSender(players, '[Evil] <OwnerPlayer> !stop', 'chat', say, EVIL), null, '/say from another player')
  assert.equal(chatSender(players, '[OwnerPlayer] <OwnerPlayer> !stop', 'chat', say, OWNER), null, 'a /say line is not an order')
  assert.equal(chatSender(players, '<OwnerPlayer> !stop', 'chat', chat, EVIL), null, 'a nickname that copies the owner')
  assert.equal(chatSender(players, '<Pal> craft me a stone pickaxe', 'chat', chat, EVIL), null, 'a copied friend')
  assert.equal(chatSender(players, '<OwnerPlayer> !stop', 'system', chat, null), null, 'a system line')
  assert.equal(chatSender(players, '<OwnerPlayer> !stop', 'chat', chat, undefined), null, 'chat with no profile')
  assert.equal(chatSender(players, '<OwnerPlayer> !stop', 'chat', chat, '00000000-0000-0000-0000-000000000000'), null)
  assert.equal(chatSender(players, '<OwnerPlayer> !stop', 'chat', chat, '44444444-4444-3444-8444-444444444444'), null, 'nobody on the list')
  assert.equal(chatSender(players, 'OwnerPlayer joined the game', 'chat', chat, OWNER), null)
})

test('kill takes a mob name, of one or more words', () => {
  assert.equal(parseMessage('!kill zombie', BOTS).command.args.target, 'zombie')
  assert.deepEqual(parseMessage('!kill 20 cave spider', BOTS).command.args, { radius: 20, target: 'cave_spider' })
  const q = parseMessage('!kill 20 cave spider', BOTS)
  assert.deepEqual(parseMessage(formatCommand('all', q.command), BOTS).command, q.command)
  assert.equal(parseMessage('!kill zom-bie', BOTS).type, 'error')
})

test('!help is a command: the list, or how one command works, each in one chat line', () => {
  assert.deepEqual(parseMessage('!help', BOTS), { type: 'command', targets: 'all', command: { name: 'help', args: {} } })
  assert.deepEqual(parseMessage('!Agent1 help kill', BOTS).command, { name: 'help', args: { topic: 'kill' } })
  assert.deepEqual(parseMessage('!help !guard', BOTS).command.args, { topic: 'guard' })
  for (const words of ['!help me', '!help constructor', '!help kill now']) {
    assert.deepEqual(parseMessage(words, BOTS).command, { name: 'help', args: {} }, words)
  }
  assert.equal(formatCommand('all', parseMessage('!help kill', BOTS).command), '!help kill')
  const list = helpText()
  assert.ok(list.length <= 250, `${list.length} characters`)
  for (const name of Object.keys(COMMANDS)) {
    assert.ok(list.includes(`!${name}`), name)
    assert.ok(helpText(name).startsWith(`!${name}`), name)
    assert.ok(helpText(name).length <= 250, `${name}: ${helpText(name).length} characters`)
  }
})
