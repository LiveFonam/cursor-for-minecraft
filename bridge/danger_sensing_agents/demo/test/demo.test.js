// The demo without a server: settings, chat words, the command lists, and the controller on a fake console.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { loadSettings, missingFighterFiles, hasNetwork } = require('../settings')
const { parseDemoCommand, HELP_LINES, MOBS, ANIMALS } = require('../words')
const scene = require('../scene')
const { DemoController } = require('../controller')
const { policyCommand } = require('../duel')

const CONFIG = { host: '127.0.0.1', port: 25566, version: '1.21.11', owner: null, bots: ['Agent1'], fighter_run: 'weights/fighter' }
const STAGE = { x: 10, y: -60, z: 20 }
const settings = (extra = {}) => ({ ...loadSettings({ DEMO_PLAYER: 'Viewer', ...extra }, CONFIG), stage: STAGE })

class FakeRcon {
  constructor (replies = {}) { this.sent = []; this.replies = replies }
  async send (c) {
    this.sent.push(c)
    for (const [start, reply] of Object.entries(this.replies)) {
      if (c.startsWith(start)) return typeof reply === 'function' ? reply(c) : reply
    }
    return ''
  }
  has (text) { return this.sent.some(c => c.includes(text)) }
  index (text) { return this.sent.findIndex(c => c.includes(text)) }
}

function fakeTimers () {
  let id = 0
  const t = {
    time: 0,
    intervals: new Map(),
    timeouts: new Map(),
    setInterval: fn => { t.intervals.set(++id, fn); return id },
    clearInterval: i => t.intervals.delete(i),
    setTimeout: (fn, ms) => { t.timeouts.set(++id, { fn, ms }); return id },
    clearTimeout: i => t.timeouts.delete(i),
    now: () => t.time,
    fire (ms) {
      for (const [i, x] of [...t.timeouts]) if (x.ms === ms) { t.timeouts.delete(i); return x.fn() }
      throw new Error(`no timer of ${ms}`)
    }
  }
  return t
}

function fakeChild () {
  const c = new EventEmitter()
  c.went = 0
  c.stopped = 0
  c.go = () => { c.went++ }
  c.stop = () => { c.stopped++ }
  return c
}

function rig ({ replies, extra } = {}) {
  const rcon = new FakeRcon(replies)
  const timers = fakeTimers()
  const child = fakeChild()
  const air = { boundingBox: 'empty' }
  const ground = { boundingBox: 'block' }
  const bot = { entity: { position: { x: 15.5, y: -60, z: 23.5 } }, health: 20, blockAt: p => (p.y < -60 ? ground : air) }
  const agents = {
    stops: 0,
    tasks: [],
    holds: false,
    agentBot: () => bot,
    stopAgent: async () => { agents.stops++ },
    runTask: async t => { agents.tasks.push(t) },
    forgetChest: () => {}
  }
  const duelOptions = []
  const c = new DemoController({
    settings: settings(extra),
    rcon,
    agents,
    spawnDuel: o => { duelOptions.push(o); return child },
    timers,
    sleep: async () => {},
    hostile: ['spider', 'witch']
  })
  return { c, rcon, timers, child, agents, bot, duelOptions }
}

test('settings: the player comes from the environment, and the fighter path is a setting', () => {
  assert.throws(() => loadSettings({}, CONFIG), /DEMO_PLAYER/)
  const s = loadSettings({ DEMO_PLAYER: 'Viewer', DEMO_FIGHTER_RUN: '/models/next', DEMO_STAGE: '1,-60,2' }, CONFIG)
  assert.equal(s.player, 'Viewer')
  assert.equal(s.fighterRun, path.resolve('/models/next'))
  assert.equal(s.agentRun, path.resolve('/models/next'))
  assert.deepEqual(s.stage, { x: 1, y: -60, z: 2 })
  assert.equal(loadSettings({}, { ...CONFIG, owner: 'FromConfig' }).player, 'FromConfig')
})

test('settings: refuses a remote server, bad names, a bad stage and name clashes', () => {
  assert.throws(() => loadSettings({ DEMO_PLAYER: 'Viewer' }, { ...CONFIG, host: 'example.invalid' }), /this machine/)
  assert.throws(() => loadSettings({ DEMO_PLAYER: 'no spaces' }, CONFIG), /Minecraft name/)
  assert.throws(() => loadSettings({ DEMO_PLAYER: 'Viewer', DEMO_STAGE: '1,2' }, CONFIG), /DEMO_STAGE/)
  assert.throws(() => loadSettings({ DEMO_PLAYER: 'Agent1' }, CONFIG), /three different/)
  assert.throws(() => loadSettings({ DEMO_PLAYER: 'Viewer', DEMO_CUE_MOB: 'soon' }, CONFIG), /whole number/)
})

test('settings: names the fighter files that are missing', () => {
  const s = loadSettings({ DEMO_PLAYER: 'Viewer', DEMO_FIGHTER_CLIENT: '/f/fighter.js', DEMO_POLICY: '/f/p.py', DEMO_FIGHTER_RUN: '/f/run' }, CONFIG)
  assert.deepEqual(missingFighterFiles(s, () => true), [])
  assert.deepEqual(missingFighterFiles(s, f => f !== '/f/run' && f !== '/f/fair_health.js'), ['/f/fair_health.js', '/f/run'])
})

test('settings: the agent network follows the fighter unless set, and a folder without one is caught', () => {
  assert.equal(loadSettings({ DEMO_PLAYER: 'Viewer', DEMO_FIGHTER_RUN: '/f/a' }, CONFIG).agentRun, path.resolve('/f/a'))
  assert.equal(loadSettings({ DEMO_PLAYER: 'Viewer', DEMO_FIGHTER_RUN: '/f/a', DEMO_AGENT_RUN: '/f/b' }, CONFIG).agentRun, path.resolve('/f/b'))
  assert.equal(hasNetwork('/r', f => f === path.join('/r', 'fighter', 'policy.npz')), true)
  assert.equal(hasNetwork('/r', f => f === path.join('/r', 'policy.npz')), true)
  assert.equal(hasNetwork('/r', () => false), false)
})

test('settings: every demo death is recorded in a file beside the job log', () => {
  const { deathsFile } = require('../../death_log')
  const s = loadSettings({ DEMO_PLAYER: 'Viewer', DEMO_METRICS: '/logs/demo/metrics.jsonl' }, CONFIG)
  assert.equal(s.metrics, path.resolve('/logs/demo/metrics.jsonl'))
  assert.equal(deathsFile(s.metrics), path.join(path.resolve('/logs/demo'), 'deaths.jsonl'))
  assert.ok(deathsFile(loadSettings({ DEMO_PLAYER: 'Viewer' }, CONFIG).metrics).endsWith(path.join('runs', 'demo', 'deaths.jsonl')))
})

test('words: every command, and everything else is left alone', () => {
  assert.deepEqual(parseDemoCommand('!start'), { name: 'reset' })
  assert.deepEqual(parseDemoCommand('!reset'), { name: 'reset' })
  assert.deepEqual(parseDemoCommand('!1v1'), { name: 'duel' })
  assert.deepEqual(parseDemoCommand('!EVIL'), { name: 'evil' })
  assert.deepEqual(parseDemoCommand('!stop'), { name: 'stop' })
  assert.deepEqual(parseDemoCommand('!help'), { name: 'help' })
  assert.deepEqual(parseDemoCommand('!mob'), { name: 'mob', kind: 'zombie' })
  assert.deepEqual(parseDemoCommand('!mob creeper'), { name: 'mob', kind: 'creeper' })
  assert.deepEqual(parseDemoCommand('!animal sheep'), { name: 'animal', kind: 'sheep' })
  assert.match(parseDemoCommand('!mob spider').error, /zombie/)
  assert.match(parseDemoCommand('!animal zombie').error, /cow/)
  assert.ok(parseDemoCommand('!evil now').error)
  assert.equal(parseDemoCommand('!status'), null)
  assert.equal(parseDemoCommand('make me a diamond pickaxe'), null)
  for (const word of ['!reset', '!start', '!1v1', '!evil', '!mob', '!animal', '!stop', '!help']) {
    assert.ok(HELP_LINES.some(l => l.includes(word)), word)
  }
})

test('scene: clears every hostile mob but the four, and no animal', () => {
  const gone = scene.hostileToRemove('1.21.11')
  for (const keep of ['zombie', 'skeleton', 'enderman', 'creeper']) assert.ok(!gone.includes(keep), keep)
  for (const out of ['spider', 'cave_spider', 'witch', 'husk', 'stray', 'drowned', 'phantom', 'slime', 'zombie_villager', 'bogged', 'parched', 'zombie_nautilus', 'hoglin', 'ghast', 'magma_cube', 'shulker', 'piglin', 'zombified_piglin', 'warden', 'breeze', 'creaking']) {
    assert.ok(gone.includes(out), out)
  }
  for (const animal of ['cow', 'pig', 'sheep', 'chicken', 'strider', 'horse', 'wolf']) assert.ok(!gone.includes(animal), animal)
  assert.ok(!gone.includes('end_crystal'))
  assert.deepEqual(scene.purgeCommands(['spider']), ['kill @e[type=minecraft:spider]'])
  for (const m of MOBS) assert.ok(scene.KEEP_HOSTILE.includes(m))
  assert.ok(ANIMALS.every(a => !gone.includes(a)))
})

test('scene: the agent starts with a shield, an axe, exactly 16 bread and no armor', () => {
  const kit = scene.agentKitCommands('Agent1')
  assert.equal(kit[0], 'clear Agent1')
  assert.ok(kit.includes('item replace entity Agent1 weapon.offhand with shield'))
  assert.ok(kit.some(c => /hotbar\.0 with \w*_axe$/.test(c)))
  assert.ok(kit.includes('item replace entity Agent1 hotbar.8 with bread 16'))
  assert.ok(!kit.some(c => /armor|helmet|chestplate|leggings|boots/.test(c)))
})

test('scene: the base has walls, a bed, a chest and a furnace, and the invasion is 1 creeper and 3 zombies', () => {
  const base = scene.baseCommands(STAGE)
  assert.equal(base.filter(c => c.endsWith('cobblestone')).length, 4)
  assert.equal(base.filter(c => c.includes('red_bed')).length, 2)
  assert.ok(base.some(c => c.includes(' chest[')))
  assert.ok(base.some(c => c.includes(' furnace[')))
  const inv = [...scene.creeperCommands(STAGE), ...scene.zombieCommands(STAGE)]
  assert.equal(inv.filter(c => c.startsWith('summon minecraft:creeper')).length, 1)
  assert.equal(inv.filter(c => c.startsWith('summon minecraft:zombie')).length, 3)
})

test('scene: a spot for a mob is two free blocks on solid ground', () => {
  const open = (x, y) => ({ boundingBox: y < 0 ? 'block' : 'empty' })
  const spot = scene.openSpot(open, { x: 0.5, y: 0, z: 0.5 })
  assert.equal(spot.y, 0)
  assert.equal(Math.max(Math.abs(Math.floor(spot.x)), Math.abs(Math.floor(spot.z))), 4)
  assert.equal(scene.openSpot(() => ({ boundingBox: 'block' }), { x: 0, y: 0, z: 0 }), null)
  assert.equal(scene.openSpot(() => null, { x: 0, y: 0, z: 0 }), null)
})

test('scene: the agent starts with a stone axe', () => {
  const a = scene.agentKitCommands('Agent1')
  assert.ok(a.includes('item replace entity Agent1 hotbar.0 with stone_axe'))
  assert.ok(!a.some(c => c.includes('diamond_axe')))
})

test('scene: the fight kit is the full kit in the fighter\'s slots', () => {
  const k = scene.fighterKitCommands('Viewer', { x: 1, y: 100, z: 2 }, 90)
  assert.ok(k.includes('item replace entity Viewer hotbar.0 with diamond_axe'))
  assert.ok(k.includes('item replace entity Viewer weapon.offhand with shield'))
  assert.equal(k.filter(c => c.includes('armor.')).length, 4)
  assert.equal(k[k.length - 1], 'tp Viewer 1 100 2 90 0')
})

test('controller: only the demo player is obeyed', async () => {
  const { c, rcon, agents } = rig()
  assert.equal(await c.handle('!evil', 'Stranger'), true)
  assert.equal(await c.handle('make me a diamond pickaxe', 'Stranger'), true)
  assert.equal(rcon.sent.length, 0)
  assert.equal(agents.tasks.length, 0)
  assert.equal(await c.handle('!status', 'viewer'), false)
  await c.handle('make me a diamond pickaxe', 'VIEWER')
  assert.deepEqual(agents.tasks, ['make me a diamond pickaxe'])
})

test('controller: a task puts him in spectator where he stands, !follow goes on the agent, and he receives the item', async () => {
  let held = 0
  const { c, rcon, bot, timers } = rig({ replies: { 'clear Viewer minecraft:diamond_pickaxe 0': () => (held ? `Found ${held} matching item(s) on player Viewer` : 'No items were found on player Viewer') } })
  await c.taskStarted('diamond_pickaxe')
  assert.equal(c.state, 'run')
  assert.ok(rcon.has('gamemode spectator Viewer'))
  assert.ok(!rcon.has('spectate Agent1 Viewer'))
  await c.handle('!follow', 'Viewer')
  assert.ok(rcon.index('gamemode spectator Viewer') < rcon.index('spectate Agent1 Viewer'))
  rcon.sent.length = 0
  bot.health = 0
  await c.agentSpawned()
  assert.ok(!rcon.has('spectate'))
  bot.health = 20
  await c.agentSpawned()
  assert.deepEqual(rcon.sent, ['spectate Agent1 Viewer'])
  assert.equal(timers.intervals.size, 0)
  assert.equal(timers.timeouts.size, 3)
  held = 1
  await c.taskEnded('done')
  assert.equal(c.state, 'idle')
  assert.equal(timers.intervals.size, 0)
  assert.equal(timers.timeouts.size, 0)
  assert.ok(rcon.has('gamemode creative Viewer'))
  assert.ok(rcon.sent.some(s => s.includes('tellraw') && s.includes('you have the diamond pickaxe')))
})

test('controller: the end of a task says so when he got nothing', async () => {
  const { c, rcon } = rig()
  await c.taskStarted('diamond_pickaxe')
  await c.taskEnded('done')
  assert.ok(rcon.sent.some(s => s.includes('did not pick up')))
  const second = rig()
  await second.c.taskStarted('diamond_pickaxe')
  await second.c.taskEnded('failed')
  assert.ok(second.rcon.sent.some(s => s.includes('ended: failed')))
})

test('controller: the cues send a mob and an animal only during a task', async () => {
  const { c, rcon, timers } = rig()
  await c.taskStarted('diamond_pickaxe')
  await timers.fire(60000)
  assert.ok(rcon.has('summon minecraft:zombie'))
  await timers.fire(120000)
  assert.ok(rcon.has('summon minecraft:cow'))
  rcon.sent.length = 0
  await c.taskEnded('done')
  await c.cue('zombie')
  assert.ok(!rcon.has('summon'))
})

test('controller: a plain task is refused while something else runs', async () => {
  const { c, agents, rcon } = rig()
  c.state = 'duel'
  await c.handle('make me a diamond pickaxe', 'Viewer')
  assert.equal(agents.tasks.length, 0)
  assert.ok(rcon.sent.some(s => s.includes('Busy with the duel')))
})

test('controller: !mob and !animal summon by the agent', async () => {
  const { c, rcon } = rig()
  await c.handle('!mob skeleton', 'Viewer')
  await c.handle('!animal pig', 'Viewer')
  assert.ok(rcon.has('summon minecraft:skeleton'))
  assert.ok(rcon.has('summon minecraft:pig'))
})

test('controller: evil with the director builds the base, spawns, and hands the mobs over', async () => {
  const { c, rcon, timers } = rig({ replies: { 'director status': 'director: idle', 'execute if entity': 'Test passed' } })
  await c.handle('!evil', 'Viewer')
  assert.equal(c.state, 'evil')
  assert.ok(rcon.index('red_bed') < rcon.index('summon minecraft:creeper'))
  assert.ok(rcon.index('summon minecraft:zombie') < rcon.index('director start Viewer'))
  assert.ok(rcon.has('gamemode survival Viewer'))
  assert.ok(rcon.has('gamerule mob_griefing true'))
  assert.ok(!rcon.has('{ignited:1b}'))
  await timers.fire(40000)
  assert.ok(rcon.has('{ignited:1b}'))
  await c.handle('!reset', 'Viewer')
  assert.ok(rcon.has('director stop'))
  assert.equal(c.baseIntact, true)
})

test('controller: evil without the director lights the creeper at the wall', async () => {
  const { c, rcon, timers } = rig({ replies: { 'director status': 'Unknown command', 'execute if entity': 'Test passed' } })
  await c.handle('!evil', 'Viewer')
  assert.ok(!rcon.has('director start'))
  assert.ok(!rcon.has('summon minecraft:zombie'))
  await timers.fire(3000)
  assert.ok(rcon.has('{ignited:1b}'))
  assert.ok(rcon.index('{ignited:1b}') < rcon.index('summon minecraft:zombie'))
  assert.equal(rcon.sent.filter(s => s.startsWith('summon minecraft:zombie')).length, 3)
})

test('controller: no creeper left, nothing to light', async () => {
  const { c, rcon, timers } = rig({ replies: { 'director status': 'director: idle', 'execute if entity': 'Test failed' } })
  await c.handle('!evil', 'Viewer')
  await timers.fire(40000)
  assert.ok(!rcon.has('{ignited:1b}'))
})

// Starts a 1v1 up to the point where the fight is on. The deaths come from the box, so a test can change them
async function startDuel (r, deaths) {
  const pending = r.c.handle('!1v1', 'Viewer')
  await new Promise(resolve => setImmediate(resolve))
  for (let i = 0; i < 40 && !r.duelOptions.length; i++) await new Promise(resolve => setImmediate(resolve))
  for (let i = 0; i < 10 && !r.child.listenerCount('ready'); i++) await new Promise(resolve => setImmediate(resolve))
  r.child.emit('ready')
  await pending
  return deaths
}

const duelRig = () => {
  const deaths = { Viewer: 2, Fighter: 5 }
  const r = rig({
    replies: {
      'scoreboard players get': c => {
        const name = c.split(' ')[3]
        return `${name} has ${deaths[name]} [demo_deaths]`
      },
      'gamerule natural_health_regeneration': c => (c.split(' ').length === 2 ? 'Gamerule is currently set to: true' : '')
    }
  })
  return { ...r, deaths }
}

test('controller: 1v1 loads the fighter from the setting, gives both the kit, and returns him after a loss', async () => {
  const r = duelRig()
  await startDuel(r, r.deaths)
  assert.equal(r.c.state, 'duel')
  assert.equal(r.child.went, 1)
  assert.equal(r.duelOptions[0].run, r.c.s.fighterRun)
  assert.equal(r.duelOptions[0].enemy, 'Viewer')
  assert.ok(r.rcon.has('item replace entity Viewer hotbar.0 with diamond_axe'))
  assert.ok(r.rcon.has('item replace entity Fighter hotbar.0 with diamond_axe'))
  assert.ok(r.rcon.has('gamerule natural_health_regeneration false'))
  r.deaths.Viewer = 3
  await r.c.duelTick(r.c.duelRun)
  await r.c.queue
  assert.equal(r.c.state, 'idle')
  assert.equal(r.child.stopped, 1)
  assert.ok(r.rcon.sent.some(s => s.includes('The fighter won')))
  assert.ok(r.rcon.has('gamerule natural_health_regeneration true'))
  assert.ok(r.rcon.has('whitelist remove Fighter'))
  assert.ok(r.rcon.has('forceload remove'))
  assert.ok(r.rcon.sent.lastIndexOf('gamemode creative Viewer') > r.rcon.index('whitelist remove Fighter'))
})

test('controller: 1v1 won by the player, and a fight that runs out of time', async () => {
  const won = duelRig()
  await startDuel(won, won.deaths)
  won.deaths.Fighter = 6
  await won.c.duelTick(won.c.duelRun)
  await won.c.queue
  assert.ok(won.rcon.sent.some(s => s.includes('You beat the fighter')))
  const late = duelRig()
  await startDuel(late, late.deaths)
  late.timers.time = 181000
  await late.c.duelTick(late.c.duelRun)
  await late.c.queue
  assert.ok(late.rcon.sent.some(s => s.includes('a draw')))
})

test('controller: a fighter that dies at load ends the fight cleanly', async () => {
  const r = duelRig()
  const pending = r.c.handle('!1v1', 'Viewer')
  for (let i = 0; i < 60 && !r.child.listenerCount('ready'); i++) await new Promise(resolve => setImmediate(resolve))
  r.child.emit('exit', 1)
  await pending
  await r.c.queue
  assert.equal(r.c.state, 'idle')
  assert.equal(r.c.duelRun, null)
  assert.ok(r.rcon.sent.some(s => s.includes('could not run')))
  assert.ok(!r.rcon.has('item replace entity Viewer'))
})

test('controller: !stop during a fight ends it and says stopped', async () => {
  const r = duelRig()
  await startDuel(r, r.deaths)
  await r.c.handle('!stop', 'Viewer')
  await r.c.queue
  assert.equal(r.c.state, 'idle')
  assert.ok(r.rcon.sent.some(s => s.includes('Fight stopped')))
  assert.ok(r.agents.stops >= 1)
})

test('controller: the purge runs on its timer and close stops it', async () => {
  const { c, rcon, timers } = rig()
  await c.begin(STAGE)
  assert.ok(rcon.has('gamerule immediate_respawn true'))
  assert.ok(rcon.has('difficulty normal'))
  assert.ok(rcon.has('gamerule spawn_mobs true'))
  assert.ok(rcon.has('item replace entity Agent1 hotbar.8 with bread 16'))
  const [tick] = [...timers.intervals.values()]
  rcon.sent.length = 0
  await tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(rcon.has('kill @e[type=minecraft:spider]'))
  c.close()
  assert.equal(timers.intervals.size, 0)
})

test('duel: the policy runs with the set network and finds its package', () => {
  const cmd = policyCommand({ python: 'py', policy: '/x/agents_policy.py', run: '/x/run', sourceRoot: '/src' })
  assert.equal(cmd.file, 'py')
  assert.deepEqual(cmd.args, ['/x/agents_policy.py', '--run', '/x/run'])
  assert.equal(cmd.cwd, '/src')
  assert.deepEqual(cmd.env.PYTHONPATH.split(path.delimiter).slice(0, 2), [path.join('/x', 'fighter_src'), path.join('/src', 'fighter', 'src')])
})

test('controller: a slow purge is not started twice', async () => {
  const { c, rcon } = rig()
  let open
  rcon.send = () => new Promise(resolve => { open = resolve })
  const first = c.purge()
  await c.purge()
  assert.equal(c.purging, true)
  for (let i = 0; i < 2; i++) {
    open('')
    await new Promise(resolve => setImmediate(resolve))
  }
  await first
  assert.equal(c.purging, false)
})

test('duel: the real process loads the client and a policy, then exits when the server is not there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-duel-'))
  const stub = path.join(dir, 'policy.js')
  fs.writeFileSync(stub, "process.stdout.write(JSON.stringify({ hello: { name: 'stub', rate: 10, kind: 'test', fair: false } }) + '\\n'); process.stdin.resume()\n")
  const port = await new Promise(resolve => {
    const probe = require('net').createServer().listen(0, '127.0.0.1', () => {
      const p = probe.address().port
      probe.close(() => resolve(p))
    })
  })
  const client = path.resolve(process.env.DEMO_TEST_CLIENT || path.join(__dirname, '..', '..', '..', 'fighter.js'))
  const { spawnDuel } = require('../duel')
  const child = spawnDuel({
    name: 'Fighter', enemy: 'Viewer', host: '127.0.0.1', port, version: '1.21.11',
    arena: { x: 0, y: 100, z: 0, half: 10 }, client, policy: stub, run: dir, python: process.execPath, sourceRoot: dir
  })
  let ready = false
  child.once('ready', () => { ready = true })
  const code = await new Promise(resolve => {
    const t = setTimeout(() => { child.stop(); resolve('timeout') }, 25000)
    child.once('exit', c => { clearTimeout(t); resolve(c) })
  })
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(ready, false)
  assert.equal(code, 3)
})

test('agents: "make me a diamond pickaxe" becomes a goal for the player, and a stopped task is forgotten', async () => {
  const { DemoAgents } = require('../run')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-agents-'))
  const s = settings()
  const a = new DemoAgents({ names: [s.agent], run: s.agentRun, translator: false, owner: s.player, builds: path.join(dir, 'b.json') }, s)
  const seen = []
  a.ctxs.set(s.agent, { bot: {}, seq: 0 })
  a.execute = (ctx, command) => { seen.push(command); return null }
  await a.runTask('make me a diamond pickaxe')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].name, 'get')
  assert.equal(seen[0].args.item, 'diamond_pickaxe')
  assert.equal(seen[0].args.count, 1)
  assert.equal(seen[0].args.requester, s.player)
  assert.equal(await a.ensureKit(), undefined)

  const events = []
  a.controller = { taskStarted: async i => events.push(`start ${i}`), taskEnded: async r => events.push(`end ${r}`) }
  await a.tracked('diamond_pickaxe', () => a.tracked(null, async () => 'done'))
  assert.deepEqual(events, ['start diamond_pickaxe', 'end done'])
  events.length = 0
  let release
  const old = a.tracked('iron_pickaxe', () => new Promise(resolve => { release = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  a.taskEpoch++
  a.taskDepth = 0
  await a.tracked('diamond_pickaxe', async () => 'done')
  release('stopped')
  await old
  assert.deepEqual(events, ['start iron_pickaxe', 'start diamond_pickaxe', 'end done'])
  fs.rmSync(dir, { recursive: true, force: true })
})

// Every line the demo sends, walked through the game's own command tree. Rule names are left out: they changed across
// versions, which is why the demo sets each under both names
function splitCommand (line) {
  const out = []
  let word = ''
  let depth = 0
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      word += ch
      if (ch === '\\') word += line[++i]
      else if (ch === '"') quoted = false
    } else if (ch === '"') {
      quoted = true
      word += ch
    } else if (ch === ' ' && depth === 0) {
      out.push(word)
      word = ''
    } else {
      if ('[{'.includes(ch)) depth++
      if (']}'.includes(ch)) depth--
      word += ch
    }
  }
  out.push(word)
  return out
}

const WIDTH = { 'minecraft:vec3': 3, 'minecraft:block_pos': 3, 'minecraft:rotation': 2, 'minecraft:column_pos': 2, 'minecraft:vec2': 2 }
const NUMBER = /^-?\d+(\.\d+)?$/
const fits = (parser, word) => {
  if (parser === 'brigadier:integer') return /^-?\d+$/.test(word)
  if (parser === 'brigadier:float' || parser === 'brigadier:double') return NUMBER.test(word)
  if (parser === 'brigadier:bool') return word === 'true' || word === 'false'
  if (WIDTH[parser]) return NUMBER.test(word)
  return true
}

function walks (root, node, words, i) {
  if (i === words.length) return !!node.executable
  // the data lists execute's run with no children: in the game it goes on at the root
  if (node.type === 'literal' && node.name === 'run' && !node.children?.length) return walks(root, root, words, i)
  const from = node.redirects?.length ? root.children.find(c => c.name === node.redirects[0]) : node
  if (from !== node && walks(root, from, words, i)) return true
  for (const child of node.children || []) {
    if (child.type === 'literal') {
      if (child.name === words[i] && walks(root, child, words, i + 1)) return true
    } else {
      const n = WIDTH[child.parser?.parser] || 1
      if (i + n > words.length) continue
      if (words.slice(i, i + n).every(w => fits(child.parser?.parser, w)) && walks(root, child, words, i + n)) return true
    }
  }
  return false
}

test('every command the demo sends fits the game\'s command tree', async () => {
  const root = require('minecraft-data')('1.21.11').commands.root
  const known = new Map(root.children.map(c => [c.name, c]))
  const lines = new Set()
  const noteAll = r => r.rcon.sent.forEach(c => lines.add(c))

  const a = rig({ replies: { 'director status': 'Unknown command', 'execute if entity': 'Test passed' } })
  a.c.hostile = scene.hostileToRemove('1.21.11')
  await a.c.begin(STAGE)
  await a.c.purge()
  await a.c.handle('!help', 'Viewer')
  for (const m of MOBS) await a.c.handle(`!mob ${m}`, 'Viewer')
  for (const x of ANIMALS) await a.c.handle(`!animal ${x}`, 'Viewer')
  await a.c.handle('!chest', 'Viewer')
  await a.c.taskStarted('diamond_pickaxe')
  await a.c.handle('!follow', 'Viewer')
  await a.c.handle('!unfollow', 'Viewer')
  await a.c.playerHome()
  await a.c.taskEnded('done')
  await a.c.handle('!evil', 'Viewer')
  await a.timers.fire(3000)
  await a.c.handle('!reset', 'Viewer')
  await a.c.handle('!stop', 'Viewer')
  a.c.close()
  noteAll(a)

  const d = duelRig()
  await startDuel(d, d.deaths)
  d.deaths.Viewer = 3
  await d.c.duelTick(d.c.duelRun)
  await d.c.queue
  noteAll(d)

  let checked = 0
  const bad = []
  for (const line of lines) {
    const words = splitCommand(line)
    if (words[0] === 'director') continue
    if (words[0] === 'gamerule') {
      if (words.length < 2 || words.length > 3) bad.push(line)
      continue
    }
    checked++
    if (!known.has(words[0]) || !walks(root, root, words, 0)) bad.push(line)
  }
  assert.deepEqual(bad, [])
  for (const wrong of ['effect give @e minecraft:speed forever', 'item replace entity Viewer hotbar.0 diamond_axe',
    'fill 1 2 3 4 5 barrier', 'spectate Agent1 Viewer extra', 'execute as Viewer run spectate Agent1 Viewer extra', 'execute as Viewer run', 'forceload add', 'time set', 'data merge entity']) {
    assert.equal(walks(root, root, splitCommand(wrong), 0), false, wrong)
  }
  assert.ok(checked > 60, `only ${checked} lines checked`)
})

test('scene: the agent starts with a stone axe, a shield and 16 bread', () => {
  const k = scene.agentKitCommands('Agent1')
  assert.ok(k.includes('item replace entity Agent1 hotbar.0 with stone_axe'))
  assert.ok(k.includes('item replace entity Agent1 weapon.offhand with shield'))
  assert.ok(k.includes('item replace entity Agent1 hotbar.8 with bread 16'))
  assert.ok(!k.some(c => c.includes('diamond')))
})
