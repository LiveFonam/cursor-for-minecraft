// The agents' live tests. One self contained Node script that runs the same way on macOS and
// Windows: it starts the agents server on a frozen bench world, runs one test, saves a top down picture and the
// results, and stops everything it started by PID.
//
//   node bridge/danger_sensing_agents/livetest.js wheat_farm            one test (also mining_proof, bench_tunnel, bench_branch, small_hut,
//                                                      explore, translate, or several joined by commas)
//   node bridge/danger_sensing_agents/livetest.js gather_wood           gather_wood, gather_cobblestone, gather_iron, gather_diamond and
//                                                      gather_coal, mining_mobs (a mining bot with mobs summoned next to
//                                                      it), diamond_goal (a diamond pickaxe from an empty inventory)
//   node bridge/danger_sensing_agents/livetest.js food_long             survival: food_long (food planned for a long trip), hunt_food
//                                                      (hunting and cooking), strip_diamonds (strip mining to Y -58 and
//                                                      back), danger_zombie (a zombie during a job, then back to the job)
//   node bridge/danger_sensing_agents/livetest.js iron_base             iron pickaxe benchmark, from nothing to the pickaxe in AgentTester's
//                                                      bag: iron_base, iron_little_food, iron_no_food, iron_chest, iron_owner_has
//   node bridge/danger_sensing_agents/livetest.js all                   every test in order: wheat_farm, mining_proof, bench_tunnel,
//                                                      bench_branch, bench_tunnel, bench_branch, small_hut, explore, translate
//   node bridge/danger_sensing_agents/livetest.js all --until HH:MM     no test starts after that time
//   node bridge/danger_sensing_agents/livetest.js bench_setup           makes the bench world again (the first test does it by itself)
//   node bridge/danger_sensing_agents/livetest.js serve                 opens the bench world as the last test left it, to look around
//   node bridge/danger_sensing_agents/livetest.js stop                  stops the agents server by its PID file
//
// Needs an agents server in server-agents/ (its properties, whitelist and paper.jar, see docs/danger-sensing-agents.md). Results:
// runs/agents-tests/<test>.png (the latest picture), <test>.json (the latest run and up to 20 earlier ones),
// summary.txt (one paragraph per run), bench.csv (one row per bench run), and per run logs.
//
// Safety. The owner's own world (in server-agents/) is never opened: Paper runs with --config bench.properties and
// --world-dir bench, so the world lives in server-agents/bench and is copied back from server-agents/bench-pristine
// before every test. A test refuses to start when anything already listens on the agents port (maybe the owner is playing
// on that world) and when the running server's seed is not the bench seed, so the test commands (time, gamerules,
// kills, clears) can only ever reach the bench world. The test owner is AgentTester (whitelisted for the test and
// removed after), never the owner.

const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const { Vec3 } = require('vec3')

const ROOT = path.join(__dirname, '..', '..')
const AGENTS_DIR = path.join(ROOT, 'server-agents')
const SERVER_DIR = path.join(ROOT, 'server')
const BENCH_DIR = path.join(AGENTS_DIR, 'bench')
const PRISTINE = path.join(AGENTS_DIR, 'bench-pristine')
const BENCH_PROPS = path.join(AGENTS_DIR, 'bench.properties')
const PID_FILE = path.join(AGENTS_DIR, 'server.pid')
const BENCH_FILE = path.join(__dirname, 'bench.json')
const BENCH_TEMPLATE = path.join(__dirname, 'bench.example.json')
const OUT_DIR = process.env.AGENTS_TESTS_DIR || path.join(ROOT, 'runs', 'agents-tests')
const CONFIG = require('./config').loadConfig({ ownerRequired: false })
const { torchVerdict } = require('./live_scenes')
const { FOOD_RESERVE } = require('./threats')
const { fightPlot, savePlot, resetPlot, checkBot, clearBot, announce } = require('./live_reset')
const TESTER = 'AgentTester'
const BOT = 'Agent1'
const WIN = process.platform === 'win32'
const MINUTE = 60000

const IRON = ['iron_ore', 'deepslate_iron_ore']
const COAL = ['coal_ore', 'deepslate_coal_ore']
const DIAMOND = ['diamond_ore', 'deepslate_diamond_ore']
const HOSTILE = ['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'slime', 'zombie_villager', 'phantom', 'silverfish', 'endermite', 'pillager', 'vindicator']
// blocks a top down view looks through, and broken blocks that do not count as digging
const SEE_THROUGH = /^(air|cave_air|void_air|light|structure_void|short_grass|tall_grass|fern|large_fern|dead_bush|bush|short_dry_grass|tall_dry_grass|dandelion|poppy|blue_orchid|allium|azure_bluet|\w+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|pink_petals|wildflowers|leaf_litter|firefly_bush|vine|glow_lichen|cactus_flower|open_eyeblossom|closed_eyeblossom)$/
const PLANT = /^(short_grass|tall_grass|fern|large_fern|dead_bush|bush|short_dry_grass|tall_dry_grass|dandelion|poppy|blue_orchid|allium|azure_bluet|\w+_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|sunflower|lilac|rose_bush|peony|pink_petals|wildflowers|leaf_litter|firefly_bush|vine|glow_lichen|\w+_carpet|sweet_berry_bush|seagrass|tall_seagrass|kelp|kelp_plant|\w+_mushroom|hanging_roots|cave_vines|cave_vines_plant|spore_blossom|sugar_cane|\w+_sapling|torch|wall_torch|snow|wheat|carrots|potatoes|beetroots)$/
const GOOD_GROUND = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt'])
// Tree parts: a top view stops on them, but a bot set down there stands on a canopy (from leaves high above
// the forest floor every walk and every tunnel meets a drop)
const TREE = /(_leaves|_log|_wood|_stem|_hyphae|_mushroom_block|^bamboo|^mangrove_roots|^moss_carpet|^snow)$/
// changes the world makes by itself (grass spreading, leaves decaying, snow) do not mark a build's footprint
const NATURAL_SURFACE = new RegExp(`${SEE_THROUGH.source.slice(0, -2)}|grass_block|dirt|snow|\\w+_leaves)$`)
const STUCK_RE = /mining: |stuck|could not step|path took too long|gives up on/gi

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d
const rel = p => path.relative(ROOT, p).split(path.sep).join('/')
const pad = n => String(n).padStart(2, '0')
function fileStamp (d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

let logFile = null
function log (...a) {
  const line = `[livetest ${new Date().toTimeString().slice(0, 8)}] ${a.join(' ')}`
  console.log(line)
  if (logFile) {
    try { fs.appendFileSync(logFile, line + '\n') } catch {}
  }
}

function withTimeout (promise, ms, what = 'step') {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms) })
  ]).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------------------------------------------
// Files, Java and Paper

function readBench () { return JSON.parse(fs.readFileSync(fs.existsSync(BENCH_FILE) ? BENCH_FILE : BENCH_TEMPLATE, 'utf8')) }
function writeBench (bench) { fs.writeFileSync(BENCH_FILE, JSON.stringify(bench, null, 2) + '\n') }

function readProps (file) {
  const props = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    props[line.slice(0, i)] = line.slice(i + 1)
  }
  return props
}

// The agents server's own properties with the bench seed and world name, so ports and the RCON password always match
function benchProperties (agentsPropsText, seed, levelName) {
  const set = { 'level-seed': String(seed), 'level-name': levelName }
  const done = new Set()
  const out = []
  for (const line of agentsPropsText.split(/\r?\n/)) {
    if (!line) continue
    const key = line.includes('=') && !line.startsWith('#') ? line.slice(0, line.indexOf('=')) : null
    if (key && key in set) {
      out.push(`${key}=${set[key]}`)
      done.add(key)
    } else {
      out.push(line)
    }
  }
  for (const [k, v] of Object.entries(set)) if (!done.has(k)) out.push(`${k}=${v}`)
  return out.join('\n') + '\n'
}

function walkFiles (dir, visit, depth = 0) {
  if (depth > 8) return
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, visit, depth + 1)
    else visit(p)
  }
}

// Java from the first bin/java under server/jre or server-agents/jre, else the one on the PATH
function findJava () {
  const exe = WIN ? 'java.exe' : 'java'
  for (const base of [path.join(SERVER_DIR, 'jre'), path.join(AGENTS_DIR, 'jre')]) {
    const found = []
    walkFiles(base, p => {
      if (path.basename(p) === exe && path.basename(path.dirname(p)) === 'bin') found.push(p)
    })
    found.sort()
    if (found.length) return found[0]
  }
  return exe
}

function paperJar () {
  const own = path.join(AGENTS_DIR, 'paper.jar')
  return fs.existsSync(own) ? own : path.join(SERVER_DIR, 'paper.jar')
}

function offlineUuid (name) {
  const b = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest()
  b[6] = (b[6] & 0x0f) | 0x30
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function fileSize (f) {
  try { return fs.statSync(f).size } catch { return 0 }
}

function readFrom (f, offset) {
  try {
    const buf = fs.readFileSync(f)
    return buf.subarray(Math.min(offset, buf.length)).toString('utf8')
  } catch { return '' }
}

// ---------------------------------------------------------------------------------------------------------------
// Processes, always by PID

function pidAlive (pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

async function killPid (pid, { tree = false, graceMs = 8000 } = {}) {
  if (!pidAlive(pid)) return
  if (WIN) {
    // taskkill by PID, with /T for the children this harness started through it (the agents' Python fighter)
    spawnSync('taskkill', ['/pid', String(pid), ...(tree ? ['/T'] : []), '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch {}
  const until = Date.now() + graceMs
  while (pidAlive(pid) && Date.now() < until) await sleep(250)
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

// Before any world folder changes: a server already on the agents port may be the owner's world or an open bench world
async function refuseIfBusy () {
  if (!fs.existsSync(path.join(AGENTS_DIR, 'server.properties'))) {
    throw new Error('no agents server in server-agents/ yet, see docs/danger-sensing-agents.md')
  }
  if (await portOpen(CONFIG.port)) {
    throw new Error(`something already listens on port ${CONFIG.port} (maybe the owner's agents world), not touching it`)
  }
}

function portOpen (port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const sock = net.connect(port, host)
    const done = v => { sock.destroy(); resolve(v) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(1500, () => done(false))
  })
}

// ---------------------------------------------------------------------------------------------------------------
// The bench world and the agents server

function restoreBench () {
  if (!fs.existsSync(PRISTINE)) throw new Error('no pristine bench world yet (bench_setup makes it)')
  fs.rmSync(BENCH_DIR, { recursive: true, force: true })
  fs.cpSync(PRISTINE, BENCH_DIR, { recursive: true })
}

function savePristine () {
  if (!fs.existsSync(BENCH_DIR)) throw new Error('no bench world to save')
  fs.rmSync(PRISTINE, { recursive: true, force: true })
  fs.cpSync(BENCH_DIR, PRISTINE, { recursive: true })
}

function rconSettings () {
  const p = readProps(fs.existsSync(BENCH_PROPS) ? BENCH_PROPS : path.join(AGENTS_DIR, 'server.properties'))
  return { port: parseInt(p['rcon.port'], 10), password: p['rcon.password'] }
}

async function startServer (s, { detached = false } = {}) {
  const props = path.join(AGENTS_DIR, 'server.properties')
  if (!fs.existsSync(props)) throw new Error('no agents server in server-agents/ yet, see docs/danger-sensing-agents.md')
  if (await portOpen(CONFIG.port)) {
    throw new Error(`something already listens on port ${CONFIG.port} (maybe the owner's agents world), not touching it`)
  }
  const bench = readBench()
  fs.writeFileSync(BENCH_PROPS, benchProperties(fs.readFileSync(props, 'utf8'), bench.seed, bench.level_name))
  const mem = CONFIG.server_memory || '1G'
  fs.mkdirSync(path.join(AGENTS_DIR, 'logs'), { recursive: true })
  const out = fs.openSync(path.join(AGENTS_DIR, 'logs', 'bench-console.log'), 'a')
  const java = findJava()
  const args = ['-Dagents=1', '-Dagentsbench=1', `-Xms${mem}`, `-Xmx${mem}`, '-jar', paperJar(), '--nogui',
    '--config', 'bench.properties', '--world-dir', path.basename(BENCH_DIR)]
  const proc = spawn(java, args, { cwd: AGENTS_DIR, stdio: ['ignore', out, out], windowsHide: true, detached })
  fs.closeSync(out)
  s.serverExit = undefined
  proc.on('error', err => { s.serverExit = `error ${err.message}` })
  proc.on('exit', code => { s.serverExit = code ?? 'signal' })
  if (detached) proc.unref()
  s.serverPid = proc.pid
  fs.writeFileSync(PID_FILE, String(proc.pid))  // the stop command reads this file
  log(`agents server starting on the bench world (pid ${proc.pid}, ${mem} heap, java ${rel(java)})`)
  s.rcon = await waitRcon(s, 8 * MINUTE)
  log('agents server ready')
}

async function waitRcon (s, ms) {
  const { Rcon } = require('../rcon')
  const { port, password } = rconSettings()
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (s.serverExit !== undefined) throw new Error(`the agents server stopped while starting (${s.serverExit}), see server-agents/logs/bench-console.log`)
    const r = new Rcon('127.0.0.1', port, password)
    try {
      await withTimeout(r.connect(), 5000, 'RCON connect')
      return r
    } catch {
      try { r.close() } catch {}
    }
    await sleep(3000)
  }
  throw new Error('the agents server did not open RCON in time')
}

async function stopServer (s) {
  if (!s.serverPid) return
  if (!s.rcon && pidAlive(s.serverPid)) {
    try { s.rcon = await waitRcon({}, 8000) } catch {}
  }
  if (s.rcon) {
    try { await withTimeout(s.rcon.send('stop'), 15000, 'stop') } catch {}
    try { s.rcon.close() } catch {}
    s.rcon = null
  }
  const until = Date.now() + 90000
  while (pidAlive(s.serverPid) && s.serverExit === undefined && Date.now() < until) await sleep(500)
  if (pidAlive(s.serverPid) && s.serverExit === undefined) {
    log('the agents server did not stop by itself, ending it by PID')
    await killPid(s.serverPid, { tree: true, graceMs: 15000 })
  }
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(s.serverPid)) fs.unlinkSync(PID_FILE)
  } catch {}
  log(`agents server stopped (pid ${s.serverPid})`)
  s.serverPid = null
}

// Every test command is refused unless the running server is the bench world
async function checkSeed (s) {
  const reply = await s.rcon.send('seed')
  const m = reply.match(/\[(-?\d+)\]/) || reply.match(/(-?\d{3,})/)
  const seed = String(readBench().seed)
  if (!m || m[1] !== seed) throw new Error(`the running server's seed is ${m ? m[1] : 'unknown'}, not the bench seed ${seed}, refusing`)
}

// Game rules got snake case names in 1.21.11 (random_tick_speed), older servers use camel case (randomTickSpeed)
async function setRule (s, names, value) {
  for (const n of names) {
    let reply = ''
    try { reply = await s.rcon.send(`gamerule ${n} ${value}`) } catch { return null }
    if (!/unknown|incorrect|invalid|expected|error/i.test(reply)) return n
  }
  log(`no game rule of ${names.join(' or ')} took the value ${value}`)
  return null
}

async function prepWorld (s, spot) {
  await setRule(s, ['advance_time', 'doDaylightCycle'], 'false')
  await setRule(s, ['advance_weather', 'doWeatherCycle'], 'false')
  await setRule(s, ['spawn_phantoms', 'doInsomnia'], 'false')
  await setRule(s, ['respawn_radius', 'spawnRadius'], 0)
  await setRule(s, ['random_tick_speed', 'randomTickSpeed'], 3)
  for (const c of ['time set 1000', 'weather clear', 'difficulty normal']) await s.rcon.send(c)
  if (spot) await killHostiles(s, spot)
}

async function killHostiles (s, p) {
  for (const t of HOSTILE) await s.rcon.send(`kill @e[type=minecraft:${t},x=${p.x},y=${p.y},z=${p.z},distance=..64]`)
}

// ---------------------------------------------------------------------------------------------------------------
// The test owner and the agents

async function joinTester (s) {
  const mineflayer = require('mineflayer')
  await s.rcon.send(`whitelist add ${TESTER}`)
  const bot = mineflayer.createBot({
    host: CONFIG.host, port: CONFIG.port, username: TESTER, version: CONFIG.version, auth: 'offline', checkTimeoutInterval: 120000
  })
  s.tester = bot
  bot.on('error', err => log(`${TESTER}: ${err.message}`))
  bot.on('kicked', r => log(`${TESTER} was kicked: ${JSON.stringify(r).slice(0, 200)}`))
  bot.on('messagestr', text => { s.chat.push({ at: Date.now(), text }) })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${TESTER} could not join`)), 90000)
    bot.once('spawn', () => { clearTimeout(timer); resolve() })
    bot.once('end', r => { clearTimeout(timer); reject(new Error(`${TESTER} left: ${r}`)) })
  })
  await s.rcon.send(`gamemode creative ${TESTER}`)
  log(`${TESTER} joined (creative)`)
}

function say (s, text) {
  log(`${TESTER} says: ${text}`)
  s.tester.chat(text)
}

// Waits until the chunks covering this box are in the tester's view
async function waitArea (bot, x0, z0, x1, z1, ms) {
  const until = Date.now() + ms
  const v = new Vec3(0, 0, 0)
  while (Date.now() < until) {
    let missing = 0
    for (let cx = x0 >> 4; cx <= x1 >> 4; cx++) {
      for (let cz = z0 >> 4; cz <= z1 >> 4; cz++) {
        v.x = cx * 16
        v.z = cz * 16
        if (!bot.world.getColumnAt(v)) missing++
      }
    }
    if (!missing) return true
    await sleep(500)
  }
  return false
}

// The tester stands on the spot facing south (yaw 0 in the /tp command), where the builds go
async function ownerAt (s, spot = s.spot) {
  try { s.tester.creative.stopFlying() } catch {}
  await s.rcon.send(`tp ${TESTER} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5} 0 0`)
  await waitArea(s.tester, spot.x - 40, spot.z - 40, spot.x + 40, spot.z + 40, 60000)
  await sleep(1500)
}

// A level grass site around the spot: 25 wide, 6 behind the spot and 18 in front (south), 3 blocks of dirt under
// the grass and 12 of air above it, so trees and slopes are gone. The bench world is restored before every test
async function flattenSite (s, spot) {
  const gy = spot.y - 1
  const [x1, x2, z1, z2] = [spot.x - 12, spot.x + 12, spot.z - 6, spot.z + 18]
  const replies = []
  for (const c of [
    `fill ${x1} ${gy - 3} ${z1} ${x2} ${gy - 1} ${z2} minecraft:dirt`,
    `fill ${x1} ${gy} ${z1} ${x2} ${gy} ${z2} minecraft:grass_block`,
    `fill ${x1} ${gy + 1} ${z1} ${x2} ${gy + 12} ${z2} minecraft:air`,
    `kill @e[type=minecraft:item,x=${spot.x},y=${spot.y},z=${spot.z},distance=..40]`
  ]) replies.push(await s.rcon.send(c))
  log(`site levelled at ${spot.x} ${gy} ${spot.z}: ${replies.slice(0, 3).map(r => String(r).slice(0, 60)).join(' | ')}`)
  s.flattened = { x1, x2, z1, z2, ground: gy }
}

// Out of any footprint: 3 blocks behind the spot and 3 up, hovering
async function testerAside (s) {
  await s.rcon.send(`tp ${TESTER} ${s.spot.x + 0.5} ${s.spot.y + 3} ${s.spot.z - 2.5} 0 30`)
  try { s.tester.creative.startFlying() } catch {}
}

function startAgents (s, { miner = null, translator = false } = {}) {
  // AGENTS_IN_PROCESS=1 runs the bot inside this process, for a machine that allows few processes
  if (process.env.AGENTS_IN_PROCESS === '1') {
    const { Agents } = require('./agents')
    s.agents = new Agents({ names: [BOT], owner: TESTER, run: CONFIG.fighter_run, translator, metrics: s.metricsFile, miner: miner || 'branch', builds: path.join(BENCH_DIR, 'agents-builds.json') })
    s.agentsExit = undefined
    s.agents.start().catch(err => { s.agentsExit = `error ${err.message}` })
    log('agents started in this process')
    return
  }
  // what the agents build in a test is remembered inside the bench world (restored before every test), never in
  // the list that belongs to the owner's agents world
  const args =[path.join(ROOT, 'bridge', 'danger_sensing_agents', 'agents.js'), '--owner', TESTER, '--metrics', s.metricsFile, '--bots', '1',
    '--builds', path.join(BENCH_DIR, 'agents-builds.json')]
  if (miner) args.push('--miner', miner)
  if (!translator) args.push('--no-translator')
  const out = fs.openSync(s.agentsLog, 'a')
  const proc = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', out, out], windowsHide: true })
  fs.closeSync(out)
  s.agentsPid = proc.pid
  s.agentsExit = undefined
  proc.on('error', err => { s.agentsExit = `error ${err.message}` })
  proc.on('exit', code => { s.agentsExit = code ?? 'signal' })
  fs.writeFileSync(path.join(OUT_DIR, 'agents.pid'), String(proc.pid))
  log(`agents started (pid ${proc.pid}): agents.js ${args.slice(1).join(' ')}`)
}

async function waitOnline (s, name, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (s.agentsExit !== undefined) throw new Error(`the agents stopped (${s.agentsExit}), see ${rel(s.agentsLog)}`)
    const list = await s.rcon.send('list')
    const names = (list.split(':').slice(1).join(':') || '').split(',').map(x => x.trim())
    if (names.includes(name)) return
    await sleep(2000)
  }
  throw new Error(`${name} did not join`)
}

async function prepBot (s, name, pos, kit) {
  const c = cmd => s.rcon.send(cmd)
  await c(`gamemode survival ${name}`)
  await c(`clear ${name}`)
  await c(`effect clear ${name}`)
  await c(`tp ${name} ${pos.x + 0.5} ${pos.y} ${pos.z + 0.5} 180 0`)
  await c(`effect give ${name} minecraft:instant_health 1 4 true`)
  await c(`effect give ${name} minecraft:saturation 1 10 true`)
  for (const [item, n] of kit) await c(`give ${name} minecraft:${item} ${n}`)
  await sleep(2000)
  log(`${name} ready at ${pos.x} ${pos.y} ${pos.z} with ${kit.map(([i, n]) => `${n} ${i}`).join(', ') || 'nothing'}`)
}

// The ground column below a spot in the tester's view: the first block from the top that a top view does not see
// through (with skip, the blocks it matches are seen through too), or null when the column is not loaded
function groundAt (bot, x, z, top = 200, bottom = -64, skip = null) {
  const v = new Vec3(x, 0, z)
  if (!bot.world.getColumnAt(v)) return null
  for (let y = top; y >= bottom; y--) {
    v.y = y
    const b = bot.registry.blocksByStateId[bot.world.getBlockStateId(v)]
    if (!b || SEE_THROUGH.test(b.name) || (skip && skip.test(b.name))) continue
    return { y, name: b.name }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// What the agents report: the metrics file (agents.js --metrics) and the server's own statistics

class MetricsTail {
  constructor (file) {
    this.file = file
    this.offset = 0
    this.partial = ''
    this.lines = []
  }

  poll () {
    let fd
    try { fd = fs.openSync(this.file, 'r') } catch { return }
    try {
      const size = fs.fstatSync(fd).size
      if (size <= this.offset) return
      const buf = Buffer.alloc(size - this.offset)
      fs.readSync(fd, buf, 0, buf.length, this.offset)
      this.offset = size
      const parts = (this.partial + buf.toString('utf8')).split('\n')
      this.partial = parts.pop()
      for (const p of parts) {
        if (!p.trim()) continue
        try { this.lines.push(JSON.parse(p)) } catch {}
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  mark () { this.poll(); return this.lines.length }
  since (i) { this.poll(); return this.lines.slice(i) }

  // The line saying how a job of this bot ended, or null when the time runs out
  async waitJob (s, bot, job, ms, since) {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const hit = this.since(since).find(l => l.bot === bot && l.job === job)
      if (hit) return hit
      if (s.agentsExit !== undefined) return { bot, job, result: 'agents-exited' }
      await sleep(1000)
    }
    return null
  }
}

function statsFile (name) {
  return path.join(BENCH_DIR, readBench().level_name, 'stats', `${offlineUuid(name)}.json`)
}

// The server's statistics of a player (save-all writes them), categories like minecraft:mined and minecraft:used
async function statsNow (s, name = BOT) {
  if (s.readStats && name === BOT) return s.readStats()   // a fake server in the offline tests
  try { await withTimeout(s.rcon.send('save-all'), 30000, 'save-all') } catch {}
  await sleep(300)
  try { return JSON.parse(fs.readFileSync(statsFile(name), 'utf8')).stats || {} } catch { return {} }
}

function statDiff (a, b) {
  const out = {}
  for (const [cat, vals] of Object.entries(b || {})) {
    for (const [k, n] of Object.entries(vals)) {
      const d = n - ((a?.[cat] || {})[k] || 0)
      if (d > 0) (out[cat] ||= {})[k] = d
    }
  }
  return out
}

const short = k => k.replace(/^minecraft:/, '')

function mineSummary (diff, ores) {
  let dug = 0
  let plants = 0
  let target = 0
  const other = {}
  for (const [k, n] of Object.entries(diff['minecraft:mined'] || {})) {
    const name = short(k)
    if (PLANT.test(name)) plants += n
    else dug += n
    if (ores.includes(name)) target += n
    else if (/_ore$|^ancient_debris$/.test(name)) other[name] = n
  }
  const custom = diff['minecraft:custom'] || {}
  const cm = ['walk_one_cm', 'sprint_one_cm', 'crouch_one_cm', 'swim_one_cm', 'walk_under_water_one_cm', 'climb_one_cm']
    .reduce((t, k) => t + (custom[`minecraft:${k}`] || 0), 0)
  const picked = {}
  for (const [k, n] of Object.entries(diff['minecraft:picked_up'] || {})) {
    if (/raw_|coal|diamond|emerald|lapis|redstone|copper|gold|quartz|debris/.test(k)) picked[short(k)] = n
  }
  return { blocks_dug: dug, plants_broken: plants, target_ores: target, other_ores: other, deaths: custom['minecraft:deaths'] || 0, walked_m: Math.round(cm / 100), picked_up: picked }
}

// Items in a container or a player, from "data get". The reply lists one {...} per stack
function parseItems (reply) {
  const out = {}
  const start = reply.indexOf('[')
  if (start < 0) return out
  let depth = 0
  let from = -1
  for (let i = start + 1; i < reply.length; i++) {
    const ch = reply[i]
    if (ch === '{') {
      if (depth === 0) from = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && from >= 0) {
        const el = reply.slice(from, i + 1)
        const id = el.match(/id: ?"minecraft:([a-z0-9_]+)"/)
        const count = el.match(/count: ?(\d+)/i)
        if (id) out[id[1]] = (out[id[1]] || 0) + (count ? parseInt(count[1], 10) : 1)
        from = -1
      }
    } else if (ch === ']' && depth === 0) {
      break
    }
  }
  return out
}

async function itemsAt (s, pos) {
  try { return parseItems(await s.rcon.send(`data get block ${pos.x} ${pos.y} ${pos.z} Items`)) } catch { return {} }
}

function containersNear (s, center, radius = 24) {
  const reg = s.tester.registry
  const ids = ['chest', 'trapped_chest', 'barrel'].map(n => reg.blocksByName[n]?.id).filter(x => x !== undefined)
  return s.tester.findBlocks({ point: center, matching: ids, maxDistance: radius, count: 20 })
}

async function itemsInContainersNear (s, center, radius = 24) {
  const total = {}
  for (const p of containersNear(s, center, radius)) {
    for (const [k, n] of Object.entries(await itemsAt(s, p))) total[k] = (total[k] || 0) + n
  }
  return total
}

// Where the bot is, every 2 seconds, from the server (works however far it goes)
function startPathSampling (s) {
  let busy = false
  s.pathTimer = setInterval(async () => {
    if (busy || !s.rcon) return
    busy = true
    try {
      const r = await withTimeout(s.rcon.send(`data get entity ${BOT} Pos`), 5000, 'pos')
      const m = r.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/)
      if (m) s.path.push({ at: Date.now(), x: Math.floor(+m[1]), y: Math.floor(+m[2]), z: Math.floor(+m[3]) })
    } catch {}
    busy = false
  }, 2000)
}

function stopPathSampling (s) {
  if (s.pathTimer) clearInterval(s.pathTimer)
  s.pathTimer = null
}

function botChat (s, fromIndex = 0) {
  const out = []
  for (const c of s.chat.slice(fromIndex)) {
    const m = String(c.text).match(/^(?:\[[^\]]*\] )*<([^>]+)> (.*)$/)
    if (m && m[1] === BOT) out.push({ at: c.at, text: m[2] })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Pictures: block snapshots from the tester's view, a top down render, and a PNG written by hand

function snapshot (bot, box) {
  const minY = bot.game?.minY ?? -64
  const maxY = minY + (bot.game?.height ?? 384) - 1
  const b = { ...box, y0: Math.max(minY, box.y0), y1: Math.min(maxY, box.y1) }
  const nx = b.x1 - b.x0 + 1
  const ny = b.y1 - b.y0 + 1
  const nz = b.z1 - b.z0 + 1
  const ids = new Int32Array(nx * ny * nz).fill(-1)
  const v = new Vec3(0, 0, 0)
  for (let x = b.x0; x <= b.x1; x++) {
    for (let z = b.z0; z <= b.z1; z++) {
      v.x = x
      v.y = 0
      v.z = z
      if (!bot.world.getColumnAt(v)) continue
      const base = ((x - b.x0) * nz + (z - b.z0)) * ny
      for (let y = b.y0; y <= b.y1; y++) {
        v.y = y
        ids[base + y - b.y0] = bot.world.getBlockStateId(v)
      }
    }
  }
  return { box: b, nx, ny, nz, ids }
}

function stateAt (snap, x, y, z) {
  const b = snap.box
  if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1 || z < b.z0 || z > b.z1) return -1
  return snap.ids[((x - b.x0) * snap.nz + (z - b.z0)) * snap.ny + (y - b.y0)]
}

function topBlock (snap, reg, x, z, yTop = snap.box.y1) {
  for (let y = yTop; y >= snap.box.y0; y--) {
    const id = stateAt(snap, x, y, z)
    if (id < 0) return null
    const b = reg.blocksByStateId[id]
    if (!b || SEE_THROUGH.test(b.name)) continue
    return { name: b.name, y, id }
  }
  return null
}

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))))
const COLORS = {
  grass_block: [95, 159, 53], dirt: [134, 96, 67], coarse_dirt: [119, 85, 59], podzol: [91, 63, 24], rooted_dirt: [144, 103, 76],
  dirt_path: [148, 121, 65], mud: [60, 57, 61], farmland: [128, 90, 58], water: [52, 95, 218], lava: [207, 92, 20],
  oak_log: [151, 121, 72], oak_planks: [162, 130, 78], composter: [120, 80, 40], cobblestone: [122, 122, 122],
  mossy_cobblestone: [110, 125, 100], stone: [136, 136, 136], deepslate: [80, 80, 86], cobbled_deepslate: [77, 77, 80],
  granite: [149, 103, 85], diorite: [188, 188, 188], andesite: [136, 136, 137], tuff: [108, 109, 102], sand: [219, 207, 163],
  red_sand: [190, 102, 33], sandstone: [216, 203, 155], gravel: [131, 127, 126], clay: [160, 166, 179], torch: [255, 214, 70],
  wall_torch: [255, 214, 70], chest: [168, 116, 44], trapped_chest: [168, 116, 44], barrel: [134, 100, 58],
  crafting_table: [140, 95, 55], furnace: [110, 110, 110], hay_block: [210, 180, 40], glass: [200, 230, 240],
  snow: [245, 250, 250], snow_block: [245, 250, 250], ice: [160, 190, 250], white_wool: [233, 236, 236], bedrock: [60, 60, 60]
}
const ORE_COLORS = {
  coal: [30, 30, 30], iron: [216, 175, 147], copper: [224, 122, 75], gold: [252, 238, 75], redstone: [200, 20, 20],
  lapis: [31, 79, 200], diamond: [93, 236, 245], emerald: [23, 221, 98], quartz: [235, 230, 220], ancient_debris: [100, 70, 60]
}
const GREY = [128, 128, 128]

function oreColor (name) {
  for (const [k, c] of Object.entries(ORE_COLORS)) if (name.includes(k)) return c
  return null
}

function blockColor (reg, name, id) {
  if (COLORS[name]) {
    if (name === 'farmland') {
      const moisture = reg.blocksByStateId[id] ? id - reg.blocksByName.farmland.minStateId : 0
      return moisture >= 7 ? [86, 55, 32] : COLORS.farmland
    }
    return COLORS[name]
  }
  const age = () => id - (reg.blocksByName[name]?.minStateId ?? id)
  if (name === 'wheat') return lerp([96, 170, 60], [222, 192, 86], age() / 7)
  if (name === 'carrots') return lerp([96, 170, 60], [235, 140, 40], age() / 7)
  if (name === 'potatoes') return lerp([96, 170, 60], [200, 170, 90], age() / 7)
  if (name === 'beetroots') return lerp([96, 170, 60], [170, 40, 50], age() / 3)
  if (/_ore$|^ancient_debris$/.test(name)) return oreColor(name) || GREY
  if (/_leaves$/.test(name)) return [60, 110, 40]
  if (/_log$|_wood$|_stem$/.test(name)) return [151, 121, 72]
  if (/_planks$|_slab$|_stairs$|_trapdoor$|_pressure_plate$/.test(name)) return /cobble|stone|brick|deepslate/.test(name) ? COLORS.cobblestone : COLORS.oak_planks
  if (/_fence|_fence_gate$/.test(name)) return [140, 112, 66]
  if (/_door$/.test(name)) return [125, 92, 52]
  if (/_bed$/.test(name)) return name === 'white_bed' ? [228, 228, 228] : [200, 40, 40]
  if (/_wall$/.test(name)) return [112, 112, 112]
  if (/_sapling$/.test(name)) return [80, 140, 50]
  if (/_wool$|_carpet$/.test(name)) return [220, 220, 220]
  if (/terracotta|concrete/.test(name)) return [160, 100, 80]
  return GREY
}

const shade = (c, f) => c.map(v => Math.max(0, Math.min(255, Math.round(v * f))))

// region: {x0, z0, x1, z1}. color(x, z) gives [r, g, b] or null. markers: [{x, z, color, style: fill|outline|dot}]
function renderPng (region, color, markers = []) {
  const w = region.x1 - region.x0 + 1
  const h = region.z1 - region.z0 + 1
  const scale = Math.max(2, Math.min(12, Math.floor(720 / Math.max(w, h))))
  const W = w * scale
  const H = h * scale
  const rgb = Buffer.alloc(W * H * 3)
  const put = (px, py, c) => {
    if (px < 0 || py < 0 || px >= W || py >= H) return
    const i = (py * W + px) * 3
    rgb[i] = c[0]
    rgb[i + 1] = c[1]
    rgb[i + 2] = c[2]
  }
  for (let z = region.z0; z <= region.z1; z++) {
    for (let x = region.x0; x <= region.x1; x++) {
      const c = color(x, z) || [40, 40, 40]
      const edge = scale >= 6 ? shade(c, 0.9) : c
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const onEdge = dx === scale - 1 || dy === scale - 1
          put((x - region.x0) * scale + dx, (z - region.z0) * scale + dy, onEdge ? edge : c)
        }
      }
    }
  }
  for (const m of markers) {
    if (m.x < region.x0 || m.x > region.x1 || m.z < region.z0 || m.z > region.z1) continue
    const px = (m.x - region.x0) * scale
    const py = (m.z - region.z0) * scale
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const border = dx === 0 || dy === 0 || dx === scale - 1 || dy === scale - 1
        const inner = dx >= scale / 3 && dx < scale - scale / 3 && dy >= scale / 3 && dy < scale - scale / 3
        if (m.style === 'fill' || (m.style === 'outline' && border) || (m.style === 'dot' && inner)) put(px + dx, py + dy, m.color)
      }
    }
  }
  return { png: encodePng(W, H, rgb), width: W, height: H, scale }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// An 8 bit RGB PNG: every row starts with filter byte 0, the rows are deflated with zlib
function encodePng (w, h, rgb) {
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0
    rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // colour type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// The box each kind of picture snapshots: builds go south of the spot, mining goes down, exploring goes wide
function snapshotBox (kind, spot) {
  if (kind === 'mine') return { x0: spot.x - 64, x1: spot.x + 64, z0: spot.z - 64, z1: spot.z + 64, y0: -64, y1: spot.y + 8 }
  if (kind === 'path') return { x0: spot.x - 80, x1: spot.x + 80, z0: spot.z - 80, z1: spot.z + 80, y0: spot.y - 30, y1: spot.y + 40 }
  return { x0: spot.x - 20, x1: spot.x + 20, z0: spot.z - 12, z1: spot.z + 28, y0: spot.y - 10, y1: spot.y + 16 }
}

// Columns where any block changed between two snapshots, with what changed
function changedColumns (before, after, reg) {
  const out = new Map()
  const b = after.box
  const counts = {}
  for (let x = b.x0; x <= b.x1; x++) {
    for (let z = b.z0; z <= b.z1; z++) {
      for (let y = b.y0; y <= b.y1; y++) {
        const p = stateAt(before, x, y, z)
        const q = stateAt(after, x, y, z)
        if (p < 0 || q < 0 || p === q) continue
        const pn = reg.blocksByStateId[p]?.name || 'unknown'
        const qn = reg.blocksByStateId[q]?.name || 'unknown'
        if (pn !== qn) {
          counts[pn] = (counts[pn] || 0) - 1
          counts[qn] = (counts[qn] || 0) + 1
        }
        const key = `${x},${z}`
        const col = out.get(key) || { x, z, dugMinY: null, ore: null, torch: false, placed: false, significant: false }
        if (!(NATURAL_SURFACE.test(pn) && NATURAL_SURFACE.test(qn))) col.significant = true
        const solidBefore = !SEE_THROUGH.test(pn) && pn !== 'water' && pn !== 'lava'
        if (/_ore$|^ancient_debris$/.test(pn) && !/_ore$/.test(qn)) col.ore = pn
        if ((qn === 'torch' || qn === 'wall_torch') && pn !== qn) col.torch = true
        if (solidBefore && SEE_THROUGH.test(qn)) col.dugMinY = col.dugMinY === null ? y : Math.min(col.dugMinY, y)
        if (!SEE_THROUGH.test(qn)) col.placed = true
        out.set(key, col)
      }
    }
  }
  const net = Object.fromEntries(Object.entries(counts).filter(([, n]) => n !== 0).sort((a, c) => c[1] - a[1]))
  return { cols: out, net }
}

function bboxOf (points, pad) {
  if (!points.length) return null
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity
  for (const p of points) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z)
  }
  return { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad }
}

function clampRegion (r, spot, half) {
  return {
    x0: Math.max(r.x0, spot.x - half), x1: Math.min(r.x1, spot.x + half),
    z0: Math.max(r.z0, spot.z - half), z1: Math.min(r.z1, spot.z + half)
  }
}

// Draws the test's result: a build or farm as it stands, a mine as its tunnels by depth, an exploration as its path
function savePicture (s, kind) {
  const reg = s.tester.registry
  const { cols, net } = changedColumns(s.before, s.after, reg)
  const spot = s.spot
  const changed = [...cols.values()]
  const pathPts = s.path.map(p => ({ x: p.x, z: p.z, y: p.y }))
  let region
  if (kind === 'build') {
    region = bboxOf([...changed.filter(c => c.significant), { x: spot.x - 2, z: spot.z - 2 }, { x: spot.x + 2, z: spot.z + 2 }], 3)
    region = clampRegion(region, spot, 40)
  } else {
    const extra = kind === 'path' ? (s.finds || []) : []
    region = bboxOf([...changed, ...pathPts, ...extra, { x: spot.x - 8, z: spot.z - 8 }, { x: spot.x + 8, z: spot.z + 8 }], 4)
    region = clampRegion(region, spot, 128)
  }
  // height shading over what the picture shows
  const tops = new Map()
  let yMin = Infinity
  let yMax = -Infinity
  for (let x = region.x0; x <= region.x1; x++) {
    for (let z = region.z0; z <= region.z1; z++) {
      const t = topBlock(s.after, reg, x, z)
      if (!t) continue
      tops.set(`${x},${z}`, t)
      yMin = Math.min(yMin, t.y)
      yMax = Math.max(yMax, t.y)
    }
  }
  const lit = t => shade(blockColor(reg, t.name, t.id), 0.82 + 0.36 * (t.y - yMin) / Math.max(1, yMax - yMin))
  const deep = y => lerp([60, 30, 100], [205, 190, 240], (y - (-64)) / Math.max(1, spot.y + 64))
  const pathCells = new Map()
  for (const p of pathPts) {
    const k = `${p.x},${p.z}`
    if (!pathCells.has(k) || pathCells.get(k) > p.y) pathCells.set(k, p.y)
  }
  let color
  if (kind === 'build') {
    color = (x, z) => { const t = tops.get(`${x},${z}`); return t ? lit(t) : null }
  } else if (kind === 'mine') {
    color = (x, z) => {
      const k = `${x},${z}`
      const col = cols.get(k)
      if (col?.ore) return oreColor(col.ore) || GREY
      if (col?.torch) return COLORS.torch
      if (col && col.dugMinY !== null) return deep(col.dugMinY)
      if (pathCells.has(k) && pathCells.get(k) < spot.y - 2) return deep(pathCells.get(k))
      const t = tops.get(k)
      return t ? shade(lit(t), 0.45) : null
    }
  } else {
    color = (x, z) => {
      const k = `${x},${z}`
      const t = tops.get(k)
      const base = t ? lit(t) : null
      if (pathCells.has(k)) return base ? lerp(base, [255, 255, 255], 0.6) : [230, 230, 230]
      return base
    }
  }
  const markers = [{ x: spot.x, z: spot.z, color: [230, 30, 30], style: 'outline' }]
  if (s.botStart) markers.push({ x: s.botStart.x, z: s.botStart.z, color: [230, 30, 30], style: 'dot' })
  for (const f of s.finds || []) markers.push({ x: f.x, z: f.z, color: [230, 40, 230], style: 'fill' })
  const { png, width, height, scale } = renderPng(region, color, markers)
  const latest = path.join(OUT_DIR, `${s.name}.png`)
  fs.writeFileSync(latest, png)
  fs.writeFileSync(path.join(OUT_DIR, `${s.name}-${s.stamp}.png`), png)
  log(`picture ${rel(latest)} (${width} by ${height} pixels, ${scale} per block)`)
  return {
    file: rel(latest),
    region,
    pixels_per_block: scale,
    key: kind === 'mine'
      ? 'north is up. Tunnels are coloured by depth (dark purple deep, pale lavender shallow), mined ore in its own colour (iron tan, coal black, copper orange, diamond cyan), torches yellow, the surface dimmed. The red square is the spot, the red dot where the bot started'
      : kind === 'path'
        ? 'north is up. The path the bot walked is drawn light over the ground, finds it reported are magenta, the red square is the spot'
        : 'north is up, the ground and the build as seen from above, brighter is higher. The red square is where the owner stood',
    blocks_changed: net
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The tests

// the hut takes about 34 logs (12 corners, the rest as planks, slabs, a door, sticks and a table), so with 32 it
// also has to chop a tree or two. The farm takes 28 border logs and 3 for the composter and its table, 2 water
// buckets fill the 7 long channel, the chest takes the harvest
// The kit a player would bring, so the build and the farming get tested (gathering has its own test). The hut
// takes 34 logs (12 corners, 22 as planks for walls, floor, 25 slabs, a door, sticks and a crafting table). The
// farm takes 28 border logs, 7 slabs and a crafting table for the composter, 2 water buckets for the 7 long
// channel (two sources make the rest), seeds for 27 spots, a hoe, and a chest for the harvest
const BUILD_KIT_HUT = [['oak_log', 36], ['white_bed', 1], ['coal', 4], ['iron_axe', 1], ['iron_pickaxe', 1], ['bread', 16]]
const FARM_KIT = [['oak_log', 28], ['oak_slab', 7], ['crafting_table', 1], ['water_bucket', 2], ['wheat_seeds', 40], ['iron_hoe', 1], ['chest', 1], ['bread', 16]]

const LOG_ITEMS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'].map(w => `${w}_log`)
const MINER_KIT = [['torch', 32], ['bread', 16], ['cobblestone', 32], ['water_bucket', 1]]
const gatherDef = (command, items, want, minutes, kit) => ({ minutes: minutes + 3, picture: null, kit, proof: { command, items, want, minutes }, run: testGather })

// The iron benchmark's starting food, counted in bread. One bread restores 5 food points and a full bar is 20. The
// agents' food plan (skills/food_plan.js) wants about 32 points in the bag for 3 iron from the surface, 22 for the trip
// and 10 to keep at the end.
//   large   16 bread = 80 points, 4 full bars and over twice what the plan wants, so food does not decide the run
//   little   2 bread = 10 points, half a bar and less than the trip alone costs, so it has to find more or run short
//   none     0 bread, with animals next to the start so that food is possible
// Every scene starts with a full food bar, so these amounts are only what is in the bag.
const IRON_BENCH_BREAD = { large: 16, little: 2, none: 0 }
const IRON_BENCH_ORDER = `${BOT} make me an iron pickaxe`
const IRON_BENCH_MATERIALS = [['iron_ingot', 3], ['stick', 2]]
// Caps in minutes. From nothing it needs wood, stone, coal, a furnace and iron. Less food leaves time to hunt and cook.
// With the materials at hand it still needs one tree for a crafting table
const IRON_BENCH_SCENES = {
  iron_base: { capMin: 45, bread: IRON_BENCH_BREAD.large, chest: false, ownerHas: false },
  iron_little_food: { capMin: 50, bread: IRON_BENCH_BREAD.little, chest: false, ownerHas: false },
  iron_no_food: { capMin: 55, bread: IRON_BENCH_BREAD.none, chest: false, ownerHas: false },
  iron_chest: { capMin: 20, bread: IRON_BENCH_BREAD.large, chest: true, ownerHas: false },
  iron_owner_has: { capMin: 20, bread: IRON_BENCH_BREAD.large, chest: false, ownerHas: true }
}
// The plain order parses without the translator today. AGENTS_BENCH_TRANSLATOR=1 turns it on, which makes paid API calls
const ironBenchDef = sc => ({
  minutes: sc.capMin + 3,
  picture: null,
  kit: sc.bread ? [['bread', sc.bread]] : [],
  translator: process.env.AGENTS_BENCH_TRANSLATOR === '1',
  iron: sc,
  run: testIronPickaxe
})

const TESTS = {
  ...Object.fromEntries(Object.entries(IRON_BENCH_SCENES).map(([name, sc]) => [name, ironBenchDef(sc)])),
  gather_wood: gatherDef(`!${BOT} gather wood 8`, LOG_ITEMS, 8, 12, [['bread', 8]]),
  gather_cobblestone: gatherDef(`!${BOT} gather cobblestone 16`, ['cobblestone', 'cobbled_deepslate'], 16, 12, [['wooden_pickaxe', 1], ['bread', 8]]),
  gather_iron: gatherDef(`!${BOT} gather iron 3`, ['raw_iron'], 3, 25, [['stone_pickaxe', 1], ...MINER_KIT]),
  gather_diamond: gatherDef(`!${BOT} gather diamonds 3`, ['diamond'], 3, 35, [['iron_pickaxe', 1], ...MINER_KIT]),
  gather_coal: { minutes: 28, picture: null, kit: [['stone_pickaxe', 1], ...MINER_KIT], run: testGatherCoal },
  mining_mobs: { minutes: 25, picture: null, flatten: true, kit: [['iron_pickaxe', 1], ...MINER_KIT], run: testMiningMobs },
  diamond_goal: { minutes: 125, picture: null, kit: [], run: testDiamondGoal },
  food_long: { minutes: 40, picture: null, flatten: true, kit: [['iron_pickaxe', 1], ['iron_sword', 1], ['bread', 2], ['furnace', 1], ['coal', 4], ['torch', 32], ['cobblestone', 32], ['water_bucket', 1]], run: testFoodLong },
  hunt_food: { minutes: 15, picture: null, flatten: true, kit: [['iron_sword', 1], ['stone_pickaxe', 1], ['cobblestone', 8], ['oak_planks', 8], ['coal', 4]], run: testHuntFood },
  strip_diamonds: { minutes: 45, picture: 'mine', kit: [['iron_pickaxe', 1], ...MINER_KIT], run: testStripDiamonds },
  danger_zombie: { minutes: 25, picture: null, flatten: true, kit: [['stone_sword', 1], ['iron_pickaxe', 1], ...MINER_KIT], run: testDangerZombie },
  wheat_farm: { minutes: 45, picture: 'build', kit: FARM_KIT, flatten: true, run: testWheatFarm },
  mining_proof: { minutes: 52, picture: 'mine', kit: [['stone_pickaxe', 1]], run: testMiningProof },
  bench_tunnel: { minutes: 20, picture: 'mine', miner: 'tunnel', bench: true, run: testBench },
  bench_branch: { minutes: 20, picture: 'mine', miner: 'branch', bench: true, run: testBench },
  small_hut: { minutes: 30, picture: 'build', kit: BUILD_KIT_HUT, flatten: true, run: testSmallHut },
  explore: { minutes: 15, picture: 'path', kit: [['stone_sword', 1], ['bread', 16], ['torch', 16]], run: testExplore },
  translate: { minutes: 5, picture: null, translator: true, kit: [['bread', 4]], run: testTranslate }
}
const ORDER = ['wheat_farm', 'mining_proof', 'bench_tunnel', 'bench_branch', 'bench_tunnel', 'bench_branch', 'small_hut', 'explore', 'translate']

function jobStep (command, t0, hit) {
  return {
    command,
    result: hit ? hit.result : 'capped',
    minutes: round((Date.now() - t0) / MINUTE),
    error: hit?.error || null,
    agents_stats: hit?.stats || null
  }
}

// A build from the spot: the owner stands there facing south, the bot builds, the owner steps out of the way
async function buildStep (s, command, capMin) {
  await ownerAt(s)
  const m = s.metrics.mark()
  const t0 = Date.now()
  say(s, command)
  await sleep(5000)
  await testerAside(s)
  const hit = await s.metrics.waitJob(s, BOT, 'build', capMin * MINUTE, m)
  if (!hit) {
    say(s, '!stop')
    await sleep(2000)
  }
  const step = jobStep(command, t0, hit)
  step.agents_news = s.metrics.since(m).filter(l => l.bot === BOT && l.event).map(l => l.text).slice(-25)
  return step
}

async function testWheatFarm (s) {
  const statsStart = await statsNow(s)
  const build = await buildStep(s, '!build wheat_farm here', 25)
  const r = { steps: [build] }
  // one harvest, replant and store cycle within minutes: crops get 100 times the random ticks (bench world only)
  await setRule(s, ['random_tick_speed', 'randomTickSpeed'], 300)
  const base = await statsNow(s)
  await ownerAt(s)
  const m = s.metrics.mark()
  const t1 = Date.now()
  say(s, '!farm wheat')
  await sleep(5000)
  await testerAside(s)
  const out = { command: '!farm wheat', harvested: 0, replanted: 0, stored_wheat: 0, minutes_to_cycle: null }
  const until = Date.now() + 15 * MINUTE
  while (Date.now() < until && s.agentsExit === undefined) {
    await sleep(20000)
    const d = statDiff(base, await statsNow(s))
    out.harvested = (d['minecraft:mined'] || {})['minecraft:wheat'] || 0
    out.replanted = (d['minecraft:used'] || {})['minecraft:wheat_seeds'] || 0
    out.stored_wheat = (await itemsInContainersNear(s, s.spot, 24)).wheat || 0
    if (out.harvested > 0 && out.replanted > 0 && out.stored_wheat > 0) {
      out.minutes_to_cycle = round((Date.now() - t1) / MINUTE)
      break
    }
  }
  say(s, '!stop')
  await sleep(2000)
  await setRule(s, ['random_tick_speed', 'randomTickSpeed'], 3)
  out.result = out.minutes_to_cycle !== null ? 'cycle' : (s.agentsExit !== undefined ? 'agents-exited' : 'capped')
  out.minutes = round((Date.now() - t1) / MINUTE)
  out.agents_news = s.metrics.since(m).filter(l => l.bot === BOT && (l.event || l.job)).map(l => l.text || `${l.job} ${l.result}`).slice(-25)
  r.steps.push(out)
  const d = statDiff(statsStart, await statsNow(s))
  r.placed = Object.fromEntries(Object.entries(d['minecraft:used'] || {}).map(([k, n]) => [short(k), n]).filter(([k]) => !/_(pickaxe|axe|shovel|hoe|sword)$/.test(k)))
  r.ok = build.result === 'done' && out.result === 'cycle'
  return r
}

async function mineStep (s, command, ores, capMin) {
  const base = await statsNow(s)
  const logStart = fileSize(s.agentsLog)
  const m = s.metrics.mark()
  const t0 = Date.now()
  say(s, command)
  let hit = await s.metrics.waitJob(s, BOT, 'mine', capMin * MINUTE, m)
  let result = hit ? hit.result : 'capped'
  if (!hit) {
    say(s, '!stop')
    await sleep(3000)
    hit = s.metrics.since(m).find(l => l.bot === BOT && l.job === 'mine') || null
    if (hit && hit.result !== 'stopped') result = hit.result
  }
  const minutes = (Date.now() - t0) / MINUTE
  const diff = statDiff(base, await statsNow(s))
  const sum = mineSummary(diff, ores)
  const stuckLog = (readFrom(s.agentsLog, logStart).match(STUCK_RE) || []).length
  const deathsSeen = s.metrics.since(m).filter(l => l.bot === BOT && l.death).length
  const news = s.metrics.since(m).filter(l => l.bot === BOT && l.event).map(l => l.text)
  return {
    command,
    result,
    minutes: round(minutes),
    blocks_dug: sum.blocks_dug,
    target_ores: sum.target_ores,
    ores_per_100_blocks: sum.blocks_dug ? round(100 * sum.target_ores / sum.blocks_dug) : 0,
    minutes_per_ore: sum.target_ores ? round(minutes / sum.target_ores) : null,
    deaths: Math.max(sum.deaths, deathsSeen),
    stuck_events: Number.isFinite(hit?.stats?.stuck) ? hit.stats.stuck : stuckLog,
    stuck_log_lines: stuckLog,
    other_ores: sum.other_ores,
    picked_up: sum.picked_up,
    plants_broken: sum.plants_broken,
    walked_m: sum.walked_m,
    torches_placed: (diff['minecraft:used'] || {})['minecraft:torch'] || 0,
    torches_crafted: (diff['minecraft:crafted'] || {})['minecraft:torch'] || 0,
    agents_stats: hit?.stats || null,
    agents_news: news.slice(-25)
  }
}

async function testMiningProof (s) {
  const base = await statsNow(s)
  const steps = []
  steps.push(await mineStep(s, `!${BOT} mine iron 5`, IRON, 25))
  steps.push(await mineStep(s, `!${BOT} mine coal 10`, COAL, 25))
  const where = await itemsInContainersNear(s, s.botStart, 16)
  const mined = steps.every(x => x.result === 'done')
  const burned = await coalForTorches(s, base)
  const give = await handOver(s, [{ items: ['raw_iron'], want: 5 }, { items: ['coal'], want: Math.max(1, 10 - burned) }])
  const torches = torchVerdict(steps, { coalWanted: 10 })
  const r = { steps: [...steps, give], ore_in_chests_near_start: where, coal_used_for_torches: burned, torch_check: torches, fail_reasons: torches.reasons }
  r.ok = mined && give.handed_over && torches.ok
  return r
}

async function testBench (s) {
  const bench = readBench()
  const ores = /coal/.test(bench.bench_job) ? COAL : IRON
  const step = await mineStep(s, bench.bench_job, ores, bench.bench_minutes || 15)
  // numbers alone are not a pass: 0 ores means the miner never got going
  const torches = torchVerdict([step])
  return { miner: s.def.miner, steps: [step], torch_check: torches, fail_reasons: torches.reasons, ok: step.result !== 'agents-exited' && (step.target_ores || 0) > 0 && torches.ok }
}

async function testSmallHut (s) {
  const statsStart = await statsNow(s)
  const step = await buildStep(s, '!build small_hut here', 25)
  const d = statDiff(statsStart, await statsNow(s))
  const placed = Object.fromEntries(Object.entries(d['minecraft:used'] || {}).map(([k, n]) => [short(k), n]).filter(([k]) => !/_(pickaxe|axe|shovel|hoe|sword)$/.test(k)))
  return { steps: [step], placed, ok: step.result === 'done' }
}

function coordsIn (text) {
  const m = text.match(/(-?\d+)[ ,]+(-?\d+)[ ,]+(-?\d+)/)
  if (m) return { x: +m[1], y: +m[2], z: +m[3] }
  const m2 = text.match(/(-?\d+)[ ,]+(-?\d+)/)
  return m2 ? { x: +m2[1], y: null, z: +m2[2] } : null
}

async function testExplore (s) {
  await ownerAt(s)
  const m = s.metrics.mark()
  const c0 = s.chat.length
  const t0 = Date.now()
  say(s, `!${BOT} explore 64`)
  const hit = await s.metrics.waitJob(s, BOT, 'explore', 12 * MINUTE, m)
  if (!hit) {
    say(s, '!stop')
    await sleep(2000)
  }
  const lines = botChat(s, c0).map(l => l.text)
  const finds = lines.filter(l => coordsIn(l) && !/^(I died|Agents)/.test(l))
  s.finds = finds.map(coordsIn).filter(Boolean)
  const step = jobStep(`!${BOT} explore 64`, t0, hit)
  const far = s.path.reduce((mx, p) => Math.max(mx, Math.hypot(p.x - s.spot.x, p.z - s.spot.z)), 0)
  const last = s.path[s.path.length - 1]
  step.farthest_blocks = Math.round(far)
  step.back_within_blocks = last ? Math.round(Math.hypot(last.x - s.botStart.x, last.z - s.botStart.z)) : null
  return { steps: [step], finds, chat: lines.slice(-60), ok: step.result === 'done' && finds.length > 0 }
}

async function testTranslate (s) {
  await ownerAt(s)
  const c0 = s.chat.length
  const t0 = Date.now()
  const line = '@agents build me a small house here'
  say(s, line)
  let reply = null
  while (!reply && Date.now() - t0 < 90000 && s.agentsExit === undefined) {
    await sleep(1000)
    reply = botChat(s, c0).find(l => /^(On it|Can't do that|I did not get|the translator|API )/i.test(l.text)) || null
  }
  say(s, '!stop')
  await sleep(2000)
  return {
    steps: [{ command: line, reply: reply ? reply.text : null, seconds: reply ? round((reply.at - t0) / 1000, 1) : null }],
    chat: botChat(s, c0).map(l => l.text).slice(-10),
    ok: !!reply && /!build small_hut/.test(reply.text)
  }
}

// How many of an item the bot holds, read on the server (clear with count 0 only counts)
async function serverCount (s, item) {
  const m = (await s.rcon.send(`clear ${BOT} minecraft:${item} 0`)).match(/Found (\d+)/i)
  return m ? parseInt(m[1], 10) : 0
}

async function serverTotal (s, items) {
  let n = 0
  for (const item of items) n += await serverCount(s, item)
  return n
}

// How many of these items a player holds, read on the server
async function playerTotal (s, who, items) {
  let n = 0
  for (const item of items) {
    const m = String(await s.rcon.send(`clear ${who} minecraft:${item} 0`)).match(/Found (\d+)/i)
    if (m) n += parseInt(m[1], 10)
  }
  return n
}

async function posOf (s, who) {
  try {
    const m = String(await s.rcon.send(`data get entity ${who} Pos`)).match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/)
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null
  } catch { return null }
}

// A bot does not see a player out of tracking range, so the owner stand-in comes back within 16 blocks of it first,
// the way a player walks over. The bot still does the walking for the handover
async function testerComesClose (s) {
  const [bot, me] = [await posOf(s, BOT), await posOf(s, TESTER)]
  if (!bot || !me || Math.hypot(bot.x - me.x, bot.y - me.y, bot.z - me.z) <= 32) return false
  const reply = await s.rcon.send(`spreadplayers ${Math.floor(bot.x)} ${Math.floor(bot.z)} 4 16 false ${TESTER}`)
  log(`${TESTER} comes closer to ${BOT}: ${String(reply).slice(0, 80)}`)
  await sleep(s.settleMs ?? 3000)
  return true
}

// The coal that went into torches during a job, from the server's crafting statistic (4 torches take 1 coal)
async function coalForTorches (s, base) {
  const crafted = statDiff(base, await statsNow(s))['minecraft:crafted'] || {}
  return Math.ceil((crafted['minecraft:torch'] || 0) / 4)
}

// How every check that yields items ends: the bot walks to the owner stand-in and hands them over, and the server
// says what reached AgentTester's bag. wants is a list of { items, want }, any of the items counts toward its want
async function handOver (s, wants, { pickupMs = 15000 } = {}) {
  const before = []
  for (const w of wants) before.push(await playerTotal(s, TESTER, w.items))
  const came = await testerComesClose(s)
  const step = await commandStep(s, `!${BOT} give`, 'give', 6)
  // a dropped stack can be picked up after 2 seconds
  const until = Date.now() + pickupMs
  let got = []
  for (;;) {
    got = []
    for (let i = 0; i < wants.length; i++) got.push(await playerTotal(s, TESTER, wants[i].items) - before[i])
    if (wants.every((w, i) => got[i] >= w.want) || Date.now() >= until) break
    await sleep(500)
  }
  step.owner_came_closer = came
  step.delivered = wants.map((w, i) => ({ item: w.items[0], want: w.want, got: got[i] }))
  step.handed_over = step.result === 'done' && wants.every((w, i) => got[i] >= w.want)
  return step
}

// One typed command, up to the line saying how its job ended
async function commandStep (s, command, job, capMin) {
  const m = s.metrics.mark()
  const t0 = Date.now()
  say(s, command)
  const hit = await s.metrics.waitJob(s, BOT, job, capMin * MINUTE, m)
  if (!hit) {
    say(s, '!stop')
    await sleep(3000)
  }
  const step = jobStep(command, t0, hit)
  step.deaths = s.metrics.since(m).filter(l => l.bot === BOT && l.death).length
  step.agents_news = s.metrics.since(m).filter(l => l.bot === BOT && l.event).map(l => l.text).slice(-25)
  return step
}

// Passes on what the server counts in the bot's inventory, whatever the bot said
async function testGather (s) {
  const { command, items, want, minutes } = s.def.proof
  const before = await serverTotal(s, items)
  const step = await commandStep(s, command, 'gather', minutes)
  const after = await serverTotal(s, items)
  step.server_gained = after - before
  const give = await handOver(s, [{ items, want }])
  return { steps: [step, give], want, server_count: after, ok: step.server_gained >= want && give.handed_over }
}

// The chat command offers four kinds, so coal goes through !mine, the same miner. A mine job hands its haul over,
// so the server's own pickup statistic is the count
async function testGatherCoal (s) {
  const base = await statsNow(s)
  const step = await mineStep(s, `!${BOT} mine coal 5`, COAL, 25)
  const got = step.picked_up.coal || 0
  const burned = await coalForTorches(s, base)
  const give = await handOver(s, [{ items: ['coal'], want: Math.max(1, 5 - burned) }])
  const torches = torchVerdict([step], { coalWanted: 5 })
  return { steps: [step, give], want: 5, server_picked_up: got, coal_used_for_torches: burned, torch_check: torches, fail_reasons: torches.reasons, ok: step.result === 'done' && got >= 5 && give.handed_over && torches.ok }
}

// A zombie, a creeper and a skeleton next to a bot that starts mining, at night so none of them burns
async function testMiningMobs (s) {
  await s.rcon.send('time set 18000')
  const at = s.botStart
  const mobs = [['zombie', 6, 0], ['creeper', -6, 2], ['skeleton', 1, 7]]
  const summoned = []
  for (const [type, dx, dz] of mobs) {
    summoned.push(await s.rcon.send(`summon minecraft:${type} ${at.x + dx + 0.5} ${at.y} ${at.z + dz + 0.5}`))
  }
  const step = await mineStep(s, `!${BOT} mine iron 3`, IRON, 20)
  const got = step.picked_up.raw_iron || 0
  const give = await handOver(s, [{ items: ['raw_iron'], want: 3 }])
  const torches = torchVerdict([step])
  return { steps: [step, give], summoned, want: 3, server_picked_up: got, torch_check: torches, fail_reasons: torches.reasons, ok: step.result === 'done' && step.deaths === 0 && got >= 3 && give.handed_over && torches.ok }
}

// A diamond pickaxe from an empty inventory through the agents' typed commands, in order. Each step must show up on
// the server before the next one starts, and the last one is handed to the owner stand-in
async function testDiamondGoal (s) {
  const plan = [
    [`!${BOT} craft wooden pickaxe keep`, 'craft', 'wooden_pickaxe', 1, 15],
    [`!${BOT} craft stone pickaxe keep`, 'craft', 'stone_pickaxe', 1, 15],
    [`!${BOT} craft iron pickaxe keep`, 'craft', 'iron_pickaxe', 1, 40],
    [`!${BOT} gather diamonds 3`, 'gather', 'diamond', 3, 40],
    [`!${BOT} craft diamond pickaxe`, 'craft', 'diamond_pickaxe', 1, 15, TESTER]
  ]
  const steps = []
  for (const [command, job, item, need, capMin, who = BOT] of plan) {
    if (who !== BOT) await testerComesClose(s)
    const step = await commandStep(s, command, job, capMin)
    step.server_count = await playerTotal(s, who, [item])
    steps.push(step)
    if (step.result !== 'done' || step.server_count < need) break
  }
  const pickaxes = await playerTotal(s, TESTER, ['diamond_pickaxe'])
  return { steps, diamond_pickaxe_with_owner: pickaxes, ok: steps.length === plan.length && pickaxes >= 1 }
}

// ---------------------------------------------------------------------------------------------------------------
// The survival tests. Each passes on what the server reports: its item counts, the bot's food bar and position, and
// its statistics

const RAW_FOOD = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato']
const COOKED_FOOD = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'baked_potato']
const FOOD_ITEMS = ['bread', 'carrot', 'apple', ...RAW_FOOD, ...COOKED_FOOD]
const MIN_FOOD_BAR = 6        // the bar on the server never went below this on a long trip
const SAMPLE_MS = 5000

// Food points in the bot's bag, from the server's item counts
async function serverFoodPoints (s) {
  const foods = require('prismarine-registry')(CONFIG.version).foodsByName
  let points = 0
  for (const item of FOOD_ITEMS) points += (await serverCount(s, item)) * (foods[item]?.foodPoints || 0)
  return points
}

// A number the server holds for the bot ("Agent1 has the following entity data: 17"), or null
async function serverEntityNumber (s, path) {
  try {
    const m = String(await s.rcon.send(`data get entity ${BOT} ${path}`)).match(/data: (-?[\d.]+)[a-z]?\s*$/i)
    return m ? Number(m[1]) : null
  } catch { return null }
}

async function serverPos (s) {
  try {
    const m = String(await s.rcon.send(`data get entity ${BOT} Pos`)).match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/)
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null
  } catch { return null }
}

// Reads the food bar, the food points in the bag and the height every few seconds until stop() is called
function sampleFood (s) {
  const samples = []
  let running = true
  const loop = (async () => {
    while (running && s.agentsExit === undefined) {
      const bar = await serverEntityNumber(s, 'foodLevel')
      const points = await serverFoodPoints(s).catch(() => null)
      const pos = await serverPos(s)
      samples.push({ at: Date.now(), bar, points, y: pos ? Math.floor(pos.y) : null })
      const until = Date.now() + SAMPLE_MS
      while (running && Date.now() < until) await sleep(200)
    }
  })()
  return { stop: async () => { running = false; await loop; return samples } }
}

// How a long trip went on food, from the server's samples: the lowest food bar, and the most food in the bag before
// it first went more than 8 blocks below its start. No readings means no evidence, so nothing is claimed
function foodVerdict (samples, startY, wantBefore = FOOD_RESERVE) {
  const bars = samples.map(x => x.bar).filter(x => x !== null && x !== undefined)
  const deep = samples.findIndex(x => x.y !== null && x.y < startY - 8)
  const before = (deep < 0 ? samples : samples.slice(0, deep)).map(x => x.points).filter(x => x !== null && x !== undefined)
  const lowestBar = bars.length ? Math.min(...bars) : null
  const pointsBeforeTrip = before.length ? Math.max(...before) : null
  return {
    samples: samples.length,
    went_deep: deep >= 0,
    lowest_food_bar: lowestBar,
    food_points_before_trip: pointsBeforeTrip,
    ok: lowestBar !== null && pointsBeforeTrip !== null && deep >= 0 && lowestBar >= MIN_FOOD_BAR && pointsBeforeTrip >= wantBefore
  }
}

async function summonAround (s, kinds, nbt = '') {
  const replies = []
  for (const [type, dx, dz] of kinds) {
    replies.push(await s.rcon.send(`summon minecraft:${type} ${s.spot.x + dx + 0.5} ${s.spot.y} ${s.spot.z + dz + 0.5}${nbt ? ` ${nbt}` : ''}`))
  }
  return replies
}

// A diamond trip with 10 food points in the bag, cows on the site, a furnace and coal (a cow drops 1 to 3 beef, cooked
// meat makes the target whatever the drops) and a mild hunger effect so the bar really moves. It has to get food
// before it goes down, keep its bar up all the way, and come back with the diamond
async function testFoodLong (s) {
  const summoned = await summonAround(s, [['cow', -6, 4], ['cow', -3, 7], ['cow', 0, 9], ['cow', 3, 7], ['cow', 6, 4], ['cow', 8, 9]])
  await s.rcon.send(`effect give ${BOT} minecraft:hunger 1800 0 true`)
  const before = await serverCount(s, 'diamond')
  const sampler = sampleFood(s)
  const step = await commandStep(s, `!${BOT} gather diamonds 1`, 'gather', 35)
  const samples = await sampler.stop()
  step.server_gained = (await serverCount(s, 'diamond')) - before
  const food = foodVerdict(samples, s.botStart.y)
  const give = await handOver(s, [{ items: ['diamond'], want: 1 }])
  return { steps: [step, give], summoned: summoned.length, food, ok: step.result === 'done' && step.server_gained >= 1 && step.deaths === 0 && food.ok && give.handed_over }
}

// No food at all, animals on the site, a furnace it has to craft from 8 cobblestone, coal for fuel. It gets going by
// itself: no order is typed. The food is its own supply, so this check has no handover
async function testHuntFood (s) {
  const base = await statsNow(s)
  const m = s.metrics.mark()
  const summoned = await summonAround(s, [['cow', -6, 4], ['cow', 5, 5], ['pig', -3, 8], ['pig', 3, 9], ['sheep', 0, 6], ['sheep', 7, 8], ['chicken', -7, 8], ['chicken', 1, 11]])
  const t0 = Date.now()
  const out = { command: '(none, it starts on its own)', food_points: 0, cooked: 0, minutes: null }
  const until = t0 + 12 * MINUTE
  while (Date.now() < until && s.agentsExit === undefined) {
    await sleep(5000)
    out.food_points = await serverFoodPoints(s)
    out.cooked = await serverTotal(s, COOKED_FOOD)
    if (out.food_points >= 40 && out.cooked > 0) { out.minutes = round((Date.now() - t0) / MINUTE); break }
  }
  out.result = out.minutes !== null ? 'fed' : (s.agentsExit !== undefined ? 'agents-exited' : 'capped')
  out.raw_left = await serverTotal(s, RAW_FOOD)
  out.deaths = s.metrics.since(m).filter(l => l.bot === BOT && l.death).length
  out.agents_news = s.metrics.since(m).filter(l => l.bot === BOT && l.event).map(l => l.text).slice(-25)
  const killed = statDiff(base, await statsNow(s))['minecraft:killed'] || {}
  out.animals_killed = ['cow', 'pig', 'sheep', 'chicken'].reduce((n, a) => n + (killed[`minecraft:${a}`] || 0), 0)
  return { steps: [out], summoned: summoned.length, ok: out.result === 'fed' && out.deaths === 0 && out.animals_killed > 0 }
}

// Strip mining for 3 diamonds from the surface: to Y -58, a branch pattern, lit, and back to where it started
async function testStripDiamonds (s) {
  const step = await mineStep(s, `!${BOT} mine diamond 3`, DIAMOND, 40)
  const ys = s.path.map(p => p.y)
  const deepest = ys.length ? Math.min(...ys) : null
  const end = await serverPos(s)
  const back = end ? Math.hypot(end.x - (s.botStart.x + 0.5), end.y - s.botStart.y, end.z - (s.botStart.z + 0.5)) : null
  const cs = step.agents_stats || {}
  const got = step.picked_up.diamond || 0
  const out = { want: 3, server_picked_up: got, deepest_y: deepest, blocks_from_start_at_end: back === null ? null : round(back, 1), torches: cs.torches ?? 0, branches: cs.branches ?? 0 }
  const depthOk = deepest !== null && deepest <= -54 && deepest >= -60
  const give = await handOver(s, [{ items: ['diamond'], want: 3 }])
  const torches = torchVerdict([step])
  return { steps: [step, give], ...out, torch_check: torches, fail_reasons: torches.reasons, ok: step.result === 'done' && got >= 3 && step.deaths === 0 && depthOk && back !== null && back <= 6 && out.branches >= 1 && give.handed_over && torches.ok }
}

// A zombie next to a bot that starts mining, at night so it does not burn. The bot has to answer it with what it
// carries (no console kit), kill it by the server's own count, and finish the job
async function testDangerZombie (s) {
  await s.rcon.send('time set 18000')
  const base = await statsNow(s)
  const c0 = s.chat.length
  const at = s.botStart
  const summoned = await s.rcon.send(`summon minecraft:zombie ${at.x + 6.5} ${at.y} ${at.z + 0.5} {Tags:["agentstest"],PersistenceRequired:1b}`)
  const t0 = Date.now()
  let goneAfter = null
  let watching = true
  const watch = (async () => {
    while (watching && Date.now() - t0 < 3 * MINUTE) {
      await sleep(1000)
      const r = String(await s.rcon.send('execute if entity @e[tag=agentstest]').catch(() => 'passed'))
      if (/failed/i.test(r)) { goneAfter = round((Date.now() - t0) / 1000, 1); return }
    }
  })()
  const step = await mineStep(s, `!${BOT} mine iron 3`, IRON, 20)
  watching = false
  await watch
  const killed = (statDiff(base, await statsNow(s))['minecraft:killed'] || {})['minecraft:zombie'] || 0
  const kit = await serverTotal(s, ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'diamond_axe', 'shield'])
  const said = botChat(s, c0).some(l => /zombie close, fighting/i.test(l.text))
  const got = step.picked_up.raw_iron || 0
  const out = { summoned, zombie_gone_after_s: goneAfter, zombies_killed_by_bot: killed, said_it_fights: said, console_kit_items: kit, want: 3, server_picked_up: got }
  const give = await handOver(s, [{ items: ['raw_iron'], want: 3 }])
  return { steps: [step, give], ...out, ok: step.result === 'done' && step.deaths === 0 && got >= 3 && killed >= 1 && goneAfter !== null && said && kit === 0 && give.handed_over }
}

// ---------------------------------------------------------------------------------------------------------------
// The iron pickaxe benchmark: one plain chat order, and a pass only when the server counts an iron pickaxe in
// AgentTester's bag within the cap. Nothing the bot says counts toward the pass

// Offsets from the spot, inside the area the flatness check covers
const IRON_BENCH_ANIMALS = [['cow', -6, 4], ['cow', 5, 5], ['pig', -3, 8], ['pig', 3, 9], ['sheep', 0, 6], ['sheep', 7, 8], ['chicken', -7, 8], ['chicken', 1, 11]]
const IRON_BENCH_CHEST = [5, 1]
const CHEST_SLOTS = 54              // a double chest
const OWNER_DROP_WAIT_MS = 2000     // how long the owner stand-in waits for the server to take its drop
const IRON_BENCH_MIN_OAK = 12        // the same bar the flat oak world search uses
const OWNER_WALK_AFTER_MS = 150000   // the bot gets this long to bring a finished pickaxe over by itself
const OWNER_WALK_EVERY_MS = 20000
const OWNER_NONE_EVERY_MS = 20000
const OWNER_WAITS_FOR_BOT_MS = 12000 // a bot that asks walks over first, and it waits 20 s in all for the drop
const OWNER_STEPS_BACK = 5           // blocks from the drop, so the owner does not pick its own items up again
const BOT_WALKS_TO_ASK = 32          // from further away the bot stays where it is and the owner goes to it
const BOT_SAYS_COME = /ask me again when you're closer|keeping it until you're close/i
const BOT_SAYS_ASK_AGAIN = /ask me again/i
// The goal ended without the pickaxe: its plan stopped at a step, or the planner calls it impossible
const BOT_SAYS_GOAL_FAILED = /^Stopping the plan at step \d+ of \d+|^That's impossible for me/
const GOAL_OVER_IDLE_MS = 20000      // after saying so it must stay idle this long, with no plan, for the scene to end
const OWNER_HAS_NONE = 'sorry, I have none of that'
const OWNER_HANDS_OVER = 'here you go'

// Whether a line of the bot's chat asks the owner for materials, and which. A note about its own work ("I need 3 raw
// irons, gathering it") or an offer ("I'll bring it to you") is no request. Returns null, or { wants, other }:
// wants are the owner's materials it names (count null means all of them), other means it asked for something else
function parseAsk (text) {
  const line = String(text || '')
    .replace(/\b(?:i|i'll|i will|i can|i'm going to|i am going to|let me)\s+(?:bring|give|hand|pass|throw|toss|drop|share)\b[^.,;!?]*/gi, ' ')
    .replace(/\b(?:wooden|wood|stone|iron|golden|gold|diamond|netherite)\s+pickaxes?\b/gi, ' ')
  const asks = /\b(?:can|could|would|will) you\b|\bdo you have\b|\bhave you got\b|\bgot any\b|\b(?:can|may) i (?:have|get|borrow)\b|\b(?:give|hand|pass|bring|throw|toss|drop) (?:me|it|them|those|that|some|any|\d)|\bspare\b|\blend\b|\bneed\b[^.!?]*\b(?:please|from you)\b/i
  if (!asks.test(line)) return null
  const wants = []
  const all = /\b(?:materials?|ingredients?|what you have|everything)\b/i.test(line)
  const iron = line.match(/(?:(\d+)\s+)?(?:raw\s+)?\biron(?:\s+ingots?|\s+ores?|s)?\b/i)
  if (iron || all) wants.push({ item: 'iron_ingot', count: iron?.[1] ? Number(iron[1]) : null })
  const sticks = line.match(/(\d+)\s+sticks?\b/i)
  if (sticks || all || /\b(?:sticks?|planks?|logs?|wood)\b/i.test(line)) wants.push({ item: 'stick', count: sticks ? Number(sticks[1]) : null })
  const other = /\d|\bany\b|cobble|coal|stone|furnace|table|food|bread|meat/i.test(line)
  return wants.length || other ? { wants, other: !wants.length } : null
}

// A place to stand 2 blocks from the bot: air for feet and head, a full block below. Null in a tight tunnel
function freeSpotBeside (blockAt, at) {
  const feet = new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z))
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const p = feet.offset(dx, 0, dz)
    const [floor, low, high] = [blockAt(p.offset(0, -1, 0)), blockAt(p), blockAt(p.offset(0, 1, 0))]
    if (floor?.boundingBox === 'block' && low?.boundingBox === 'empty' && high?.boundingBox === 'empty') return { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }
  }
  return null
}

// What a chest holds as the server reports it. An empty chest is {}, and null means it could not be read, so an
// unloaded or broken chest never looks like a chest the bot emptied
// One stack at a time: the server cuts a long list off with "...", which hid every stack after the first
async function chestContents (s, pos) {
  const out = {}
  for (let i = 0; i < CHEST_SLOTS; i++) {
    const reply = String(await s.rcon.send(`data get block ${pos.x} ${pos.y} ${pos.z} Items[${i}]`))
    if (/found no elements/i.test(reply)) return out
    if (!/has the following block data/i.test(reply)) return null
    const id = reply.match(/id: ?"minecraft:([a-z0-9_]+)"/)
    const count = reply.match(/count: ?(\d+)/i)
    if (!id) return null
    out[id[1]] = (out[id[1]] || 0) + (count ? parseInt(count[1], 10) : 1)
  }
  return out
}

function flatOakCheck (s) {
  const t = s.tester
  const flat = !!flatSpot(t, s.spot.x, s.spot.z, 2)
  const id = t.registry.blocksByName.oak_log?.id
  const logs = id === undefined ? 0 : t.findBlocks({ point: s.spot, matching: id, maxDistance: 32, count: IRON_BENCH_MIN_OAK }).length
  return { flat, oak_logs: logs, ok: flat && logs >= IRON_BENCH_MIN_OAK }
}

// Puts the scene in the restored bench world and checks it on the server. Throws when it is not what the scene says
async function setupIronScene (s, sc) {
  const c = cmd => s.rcon.send(cmd)
  const { x, y, z } = s.spot
  const area = flatOakCheck(s)
  if (!area.ok) throw new Error(`the bench spot ${x} ${y} ${z} is not the flat oak area (flat ${area.flat}, ${area.oak_logs} oak logs within 32), run the seed scan and bench setup first`)
  // the world is restored before every run, but a chest memory kept outside it would tell this run about the last one
  const remembered = s.agents?.ctxs?.get(BOT)?.bot?.agentsChests?.list?.() || []
  if (remembered.length) throw new Error(`the agents already remember ${remembered.length} chests, so this run is not clean. Keep its chest memory inside the bench world folder`)
  await c(`clear ${TESTER}`)
  await c(`kill @e[type=minecraft:item,x=${x},y=${y},z=${z},distance=..64]`)
  // no scene may find a chest it was not given
  const natural = containersNear(s, s.spot, 48)
  for (const p of natural) await c(`setblock ${p.x} ${p.y} ${p.z} minecraft:air`)

  const materials = Object.fromEntries(IRON_BENCH_MATERIALS)
  let chest = null
  let chestStart = null
  if (sc.chest) {
    const [cx, cz] = [x + IRON_BENCH_CHEST[0], z + IRON_BENCH_CHEST[1]]
    const g = groundAt(s.tester, cx, cz, 200, -64, TREE)
    if (!g) throw new Error('no ground for the chest')
    chest = { x: cx, y: g.y + 1, z: cz }
    // loaded for the whole run, so its contents can be read wherever the players are
    await c(`forceload add ${cx} ${cz}`)
    await c(`setblock ${cx} ${chest.y} ${cz} minecraft:chest`)
    for (let i = 0; i < IRON_BENCH_MATERIALS.length; i++) {
      const [item, n] = IRON_BENCH_MATERIALS[i]
      await c(`item replace block ${cx} ${chest.y} ${cz} container.${i} with minecraft:${item} ${n}`)
    }
    chestStart = await chestContents(s, chest)
    if (!chestStart || IRON_BENCH_MATERIALS.some(([item, n]) => chestStart[item] !== n)) throw new Error(`the chest holds ${JSON.stringify(chestStart)}`)
  }
  if (sc.ownerHas) for (const [item, n] of IRON_BENCH_MATERIALS) await c(`give ${TESTER} minecraft:${item} ${n}`)
  for (const [item] of IRON_BENCH_MATERIALS) {
    const held = await playerTotal(s, TESTER, [item])
    if (held !== (sc.ownerHas ? materials[item] : 0)) throw new Error(`${TESTER} holds ${held} ${item}`)
  }
  if (await playerTotal(s, TESTER, ['iron_pickaxe']) !== 0) throw new Error(`${TESTER} already holds an iron pickaxe`)

  for (const [type, dx, dz] of IRON_BENCH_ANIMALS) {
    const g = groundAt(s.tester, x + dx, z + dz, 200, -64, TREE)
    if (g) await c(`summon minecraft:${type} ${x + dx + 0.5} ${g.y + 1} ${z + dz + 0.5} {PersistenceRequired:1b}`)
  }
  let animals = 0
  for (const type of new Set(IRON_BENCH_ANIMALS.map(a => a[0]))) {
    const m = String(await c(`execute if entity @e[type=minecraft:${type},x=${x},y=${y},z=${z},distance=..32]`)).match(/count: (\d+)/i)
    if (m) animals += Number(m[1])
  }
  if (!animals) throw new Error('no animals near the start')

  const bread = await serverCount(s, 'bread')
  const extras = await serverTotal(s, ['iron_ingot', 'stick', 'raw_iron', 'iron_pickaxe'])
  if (bread !== sc.bread || extras) throw new Error(`${BOT} starts with ${bread} bread and ${extras} materials`)
  return {
    chest,
    start: {
      bot_bag: bread ? { bread } : {},
      food_points_in_bag: bread * 5,
      chest: chestStart,
      owner: sc.ownerHas ? materials : {},
      animals_within_32: animals,
      natural_containers_removed: natural.length,
      oak_logs_within_32: area.oak_logs
    }
  }
}

// Where the owner goes after a drop: back where it stood, or further along that line when that is too close to the drop
function stepBackFrom (drop, home, blocks = OWNER_STEPS_BACK) {
  const d = Math.hypot(home.x - drop.x, home.z - drop.z)
  if (d >= blocks) return home
  const [ux, uz] = d > 0.01 ? [(home.x - drop.x) / d, (home.z - drop.z) / d] : [1, 0]
  return { x: drop.x + ux * blocks, y: home.y, z: drop.z + uz * blocks }
}

// A bot that asks walks to the owner first when it is close enough, so the owner waits for it. Dropping at a spot the
// bot is about to leave would put the items out of its sight
async function botComesOver (s) {
  const until = Date.now() + (s.askWaitMs ?? OWNER_WAITS_FOR_BOT_MS)
  while (Date.now() < until) {
    const [b, me] = [await posOf(s, BOT), await posOf(s, TESTER)]
    if (!b || !me) return
    const d = Math.hypot(b.x - me.x, b.y - me.y, b.z - me.z)
    if (d <= 4 || d > BOT_WALKS_TO_ASK) return
    await sleep(s.settleMs ?? 500)
  }
}

// The owner stand-in goes to the bot, drops the items at its feet in survival (the same click path the bot's own
// handover uses) and steps away at once, because a player standing on a drop picks it up again after 2 seconds
async function ownerDrops (s, give) {
  const before = {}
  for (const [item] of give) before[item] = await playerTotal(s, TESTER, [item])
  await botComesOver(s)
  const home = await posOf(s, TESTER)
  const dropAt = await posOf(s, BOT)
  await s.rcon.send(`tp ${TESTER} ${BOT}`)
  await s.rcon.send(`gamemode survival ${TESTER}`)
  try {
    await sleep(s.settleMs ?? 600)
    try { await s.tester.look(s.tester.entity?.yaw ?? 0, -Math.PI / 2, true) } catch {}
    for (const [item, n] of give) {
      try {
        await s.tester.toss(s.tester.registry.itemsByName[item].id, null, n)
      } catch (err) {
        log(`${TESTER} could not drop ${item}: ${err.message}`)
      }
    }
    // the server handles a toss on a later tick, at wherever the player stands by then, so it stays until the bag shows it
    const until = Date.now() + OWNER_DROP_WAIT_MS
    while (Date.now() < until) {
      let waiting = false
      for (const [item, n] of give) if (await playerTotal(s, TESTER, [item]) > before[item] - n) waiting = true
      if (!waiting) break
      await sleep(25)
    }
  } finally {
    await s.rcon.send(`gamemode creative ${TESTER}`)
    if (home) {
      const to = dropAt ? stepBackFrom(dropAt, home) : home
      await s.rcon.send(`tp ${TESTER} ${to.x} ${to.y} ${to.z}`)
    }
  }
  await sleep(s.settleMs ?? 500)
  const dropped = {}
  for (const [item] of give) dropped[item] = Math.max(0, before[item] - await playerTotal(s, TESTER, [item]))
  return dropped
}

// Answers one request the way a person would: drops what was asked for if it has it, says so when it has none
async function answerAsk (s, owner, ask, text) {
  const give = []
  for (const w of ask.wants) {
    const held = await playerTotal(s, TESTER, [w.item])
    const n = w.count === null ? held : Math.min(w.count, held)
    if (n > 0) give.push([w.item, n])
  }
  const entry = { line: text.slice(0, 200), dropped: {} }
  if (give.length) {
    entry.dropped = await ownerDrops(s, give)
    if (give.some(([item]) => !entry.dropped[item])) {
      log(`${TESTER} drop did not register, trying once more`)
      const retry = await ownerDrops(s, give.filter(([item]) => !entry.dropped[item]))
      for (const [item, n] of Object.entries(retry)) entry.dropped[item] = (entry.dropped[item] || 0) + n
    }
    for (const [item, n] of Object.entries(entry.dropped)) owner.dropped[item] = (owner.dropped[item] || 0) + n
    if (Object.values(entry.dropped).some(n => n > 0)) say(s, OWNER_HANDS_OVER)
    else owner.drop_failures++
  } else if (Date.now() - owner.lastNone >= OWNER_NONE_EVERY_MS) {
    owner.lastNone = Date.now()
    owner.said_none++
    say(s, OWNER_HAS_NONE)
  }
  owner.asked.push(entry)
}

// The bot keeps a finished item while the owner is out of reach, so a person who sees it is ready walks over
async function ownerWalksOver (s) {
  const b = await posOf(s, BOT)
  if (!b) return false
  await s.rcon.send(`tp ${TESTER} ${b.x} ${b.y} ${b.z}`)
  await sleep(s.settleMs ?? 1500)
  const near = typeof s.tester.blockAt === 'function' ? freeSpotBeside(p => s.tester.blockAt(p), b) : null
  if (near) await s.rcon.send(`tp ${TESTER} ${near.x} ${near.y} ${near.z}`)
  return true
}

// Which sources the run really used, from the server's statistics and chest contents. An owner's drop counts only as
// far as the bot's own pickup statistic shows it arrived
function ironSources ({ diff = {}, chestStart = null, chestEnd = null, ownerDropped = {} }) {
  const mined = diff['minecraft:mined'] || {}
  const picked = diff['minecraft:picked_up'] || {}
  const sum = re => Object.entries(mined).reduce((t, [k, n]) => t + (re.test(short(k)) ? n : 0), 0)
  const gathered = {
    logs: sum(/_log$/),
    stone: sum(/^(stone|deepslate|cobblestone|cobbled_deepslate)$/),
    iron_ore: sum(/^(deepslate_)?iron_ore$/),
    coal_ore: sum(/^(deepslate_)?coal_ore$/),
    raw_iron_picked_up: picked['minecraft:raw_iron'] || 0
  }
  const fromChest = {}
  if (chestStart && chestEnd) {
    for (const [k, n] of Object.entries(chestStart)) {
      const d = n - (chestEnd[k] || 0)
      if (d > 0) fromChest[k] = d
    }
  }
  const fromOwner = {}
  for (const [k, n] of Object.entries(ownerDropped)) {
    const got = Math.min(n, picked[`minecraft:${k}`] || 0)
    if (got > 0) fromOwner[k] = got
  }
  const sources = []
  if (Object.keys(fromChest).length) sources.push('chest')
  if (Object.keys(fromOwner).length) sources.push('owner')
  if (Object.values(gathered).some(n => n > 0)) sources.push('gathered')
  const ironFrom = []
  if (fromChest.iron_ingot) ironFrom.push('chest')
  if (fromOwner.iron_ingot) ironFrom.push('owner')
  if (gathered.iron_ore || gathered.raw_iron_picked_up) ironFrom.push('mined')
  return { sources, iron_from: ironFrom, from_chest: fromChest, from_owner: fromOwner, gathered, chest_read: !chestStart || !!chestEnd }
}

// Why a run did not pass, most specific first
// Only a bot running in this process can be read, so one in its own process never ends a scene early
function botIdleNoPlan (s) {
  const ctx = s.agents?.ctxs?.get(BOT)
  return !!ctx && !ctx.plan && ctx.manager?.status() === 'idle'
}

function ironFailure ({ pass, setupError = null, harnessError = null, agentsExit, botHolds = 0, chat = [], deaths = 0, capMin, goalFailed = null }) {
  if (pass) return null
  if (setupError) return { code: 'setup', detail: setupError }
  if (harnessError) return { code: 'harness', detail: harnessError }
  if (agentsExit !== undefined) return { code: 'agents_exited', detail: String(agentsExit) }
  if (botHolds > 0) return { code: 'made_not_handed_over', detail: `${BOT} holds an iron pickaxe that never reached ${TESTER}` }
  if (!chat.length) return { code: 'no_answer', detail: `${BOT} said nothing after the order` }
  const gaveUp = chat.slice(-5).reverse().find(l => /impossible|can't|couldn't|cannot|translator is off|did not get/i.test(l))
  if (gaveUp) return { code: 'said_it_could_not', detail: gaveUp.slice(0, 200) }
  if (goalFailed) return { code: 'goal_failed', detail: goalFailed.slice(0, 200) }
  return { code: 'time_cap', detail: `no iron pickaxe with ${TESTER} after ${capMin} minutes, ${deaths ?? 'unknown'} deaths, last line: ${chat[chat.length - 1].slice(0, 160)}` }
}

async function testIronPickaxe (s) {
  const sc = s.def.iron
  const readStats = s.readStats || statsNow
  const c0 = s.chat.length
  const m = s.metrics.mark()
  const record = (why, extra = {}) => ({
    ok: false,
    steps: [{ command: IRON_BENCH_ORDER, result: why.code, minutes: 0, error: why.detail }],
    scene: s.name,
    pass: false,
    seconds: null,
    cap_minutes: sc.capMin,
    deaths: null,
    food_points_end: null,
    food_bar_end: null,
    lowest_food_bar: null,
    sources: [],
    chat: [],
    failure_reason: why.code,
    failure_detail: why.detail,
    ...extra
  })
  let scene
  try {
    scene = await setupIronScene(s, sc)
  } catch (err) {
    log(`${s.name} setup: ${err.message}`)
    return record(ironFailure({ pass: false, setupError: err.message, capMin: sc.capMin }))
  }

  const base = await readStats(s)
  const sampler = sampleFood(s)
  const owner = { asked: [], dropped: {}, said_none: 0, walked_over: 0, asked_again: 0, drop_failures: 0, lastNone: 0 }
  const capMs = s.capMs ?? sc.capMin * MINUTE
  const pollMs = s.pollMs ?? 1000
  const walkAfter = s.walkAfterMs ?? OWNER_WALK_AFTER_MS
  const t0 = Date.now()
  let pass = false
  let seconds = null
  let harnessError = null
  let cursor = s.chat.length
  let heldSince = null
  let lastWalk = 0
  let toldToCome = false
  let toldToAskAgain = false
  let goalFailed = null
  let idleSince = null
  let endedOnGoalFailure = false
  say(s, IRON_BENCH_ORDER)
  try {
    while (Date.now() - t0 < capMs && s.agentsExit === undefined) {
      if (await playerTotal(s, TESTER, ['iron_pickaxe']) >= 1) {
        pass = true
        seconds = round((Date.now() - t0) / 1000, 1)
        break
      }
      const lines = botChat(s, cursor)
      cursor = s.chat.length
      for (const l of lines) {
        if (BOT_SAYS_COME.test(l.text)) toldToCome = true
        if (BOT_SAYS_ASK_AGAIN.test(l.text)) toldToAskAgain = true
        if (BOT_SAYS_GOAL_FAILED.test(l.text)) goalFailed = l.text
        const ask = parseAsk(l.text)
        if (ask) await answerAsk(s, owner, ask, l.text)
      }
      // a person walks over once the bot says the pickaxe is ready, or when it has not arrived after a while
      if (await serverCount(s, 'iron_pickaxe') > 0) {
        heldSince ??= Date.now()
        idleSince = null
        if ((toldToCome || Date.now() - heldSince >= walkAfter) && Date.now() - lastWalk >= OWNER_WALK_EVERY_MS) {
          lastWalk = Date.now()
          toldToCome = false
          if (await ownerWalksOver(s)) owner.walked_over++
          if (toldToAskAgain) {
            // its job ended when it could not reach the owner, and it said to ask again from close by
            toldToAskAgain = false
            owner.asked_again++
            await sleep(s.settleMs ?? 1000)
            goalFailed = null  // a new order is a new goal
            say(s, IRON_BENCH_ORDER)
          }
        }
      } else {
        heldSince = null
        toldToCome = false
        toldToAskAgain = false
        // it said the goal failed and has nothing left to do, so waiting for the cap would only burn time
        if (goalFailed && botIdleNoPlan(s)) {
          idleSince ??= Date.now()
          if (Date.now() - idleSince >= (s.goalOverMs ?? GOAL_OVER_IDLE_MS)) {
            endedOnGoalFailure = true
            log(`${s.name}: ${BOT} reported its goal failed and stayed idle, ending the scene`)
            break
          }
        } else {
          idleSince = null
        }
      }
      await sleep(pollMs)
    }
  } catch (err) {
    harnessError = err.message
    log(`${s.name}: ${err.stack || err.message}`)
  }
  if (seconds === null) seconds = round((Date.now() - t0) / 1000, 1)
  const samples = await sampler.stop()
  if (!pass && s.agentsExit === undefined) {
    try { say(s, '!stop') } catch {}
    await sleep(s.settleMs ?? 3000)
  }

  const end = await readStats(s)
  const diff = statDiff(base, end)
  // no statistics file means the deaths are unknown, not zero
  const deaths = Object.keys(end).length ? ((diff['minecraft:custom'] || {})['minecraft:deaths'] || 0) : null
  const chestEnd = scene.chest ? await chestContents(s, scene.chest).catch(() => null) : null
  const src = ironSources({ diff, chestStart: scene.start.chest, chestEnd, ownerDropped: owner.dropped })
  const botHolds = await serverCount(s, 'iron_pickaxe').catch(() => 0)
  const chat = botChat(s, c0).map(l => l.text)
  const why = ironFailure({ pass, harnessError, agentsExit: s.agentsExit, botHolds, chat, deaths, capMin: sc.capMin, goalFailed })
  const { lastNone, ...ownerOut } = owner
  return {
    ok: pass,
    steps: [{ command: IRON_BENCH_ORDER, result: pass ? 'passed' : why.code, minutes: round(seconds / 60), error: why?.detail || null }],
    scene: s.name,
    pass,
    seconds,
    cap_minutes: sc.capMin,
    ended_on_goal_failure: endedOnGoalFailure,
    deaths,
    food_points_end: await serverFoodPoints(s).catch(() => null),
    food_bar_end: await serverEntityNumber(s, 'foodLevel'),
    lowest_food_bar: foodVerdict(samples, s.spot.y).lowest_food_bar,
    food_samples: samples.length,
    sources: src.sources,
    iron_from: src.iron_from,
    source_detail: { from_chest: src.from_chest, from_owner: src.from_owner, gathered: src.gathered, chest_read: src.chest_read },
    // a pass that ignored the chest or the owner still passes, this shows it
    used_offered_materials: sc.chest ? src.iron_from.includes('chest') : (sc.ownerHas ? src.iron_from.includes('owner') : null),
    // the fight kit comes from the server console, so anything here means the run did not stay "from nothing"
    console_kit_items: await serverTotal(s, ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'diamond_axe', 'diamond_sword', 'crossbow', 'bow', 'shield']).catch(() => null),
    chat: chat.slice(-300),
    failure_reason: why?.code || null,
    failure_detail: why?.detail || null,
    start: scene.start,
    owner: { ...ownerOut, asked: ownerOut.asked.slice(-20) },
    agents_jobs: s.metrics.since(m).filter(l => l.bot === BOT && l.job).map(l => ({ job: l.job, result: l.result, error: l.error || null }))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One test from start to end, and the one time bench world setup

function newSession (name) {
  const stamp = fileStamp()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  return {
    name,
    def: TESTS[name] || {},
    stamp,
    chat: [],
    path: [],
    finds: [],
    metricsFile: path.join(OUT_DIR, `${name}-${stamp}-metrics.jsonl`),
    agentsLog: path.join(OUT_DIR, `${name}-${stamp}-agents.log`)
  }
}

async function cleanup (s) {
  stopPathSampling(s)
  if (s.agents) {
    try { s.agents.close() } catch {}
    s.agents = null
    await sleep(1000)
  }
  if (s.agentsPid) {
    if (s.agentsExit === undefined) log(`stopping the agents (pid ${s.agentsPid})`)
    await killPid(s.agentsPid, { tree: true })
    try { fs.unlinkSync(path.join(OUT_DIR, 'agents.pid')) } catch {}
    s.agentsPid = null
  }
  if (s.tester) {
    try { s.tester.quit('test done') } catch {}
    s.tester = null
    await sleep(1000)
  }
  if (s.rcon) {
    try { await withTimeout(s.rcon.send(`whitelist remove ${TESTER}`), 5000, 'whitelist') } catch {}
    try { await withTimeout(setRule(s, ['random_tick_speed', 'randomTickSpeed'], 3), 5000, 'gamerule') } catch {}
  }
  await stopServer(s)
}

// A square ring of candidate centres around (x, z), 8 blocks apart, the same order every time
function ring (x, z, r) {
  if (r === 0) return [[x, z]]
  const out = []
  for (let d = -r; d < r; d += 8) out.push([x + d, z - r])
  for (let d = -r; d < r; d += 8) out.push([x + r, z + d])
  for (let d = r; d > -r; d -= 8) out.push([x + d, z + r])
  for (let d = r; d > -r; d -= 8) out.push([x - r, z + d])
  return out
}

// The area the tests use, all grass or dirt with no trees or water, at most tol blocks of height difference:
// 8 blocks to each side of the spot, 4 behind it and 12 in front (south, where the builds go)
function flatSpot (bot, cx, cz, tol, cache = null) {
  let lo = Infinity
  let hi = -Infinity
  let here = null
  for (let x = cx - 8; x <= cx + 8; x++) {
    for (let z = cz - 4; z <= cz + 12; z++) {
      const key = `${x},${z}`
      let g = cache?.get(key)
      if (!g) {
        g = groundAt(bot, x, z)
        if (g && cache) cache.set(key, g)
      }
      if (!g || !GOOD_GROUND.has(g.name)) return null
      lo = Math.min(lo, g.y)
      hi = Math.max(hi, g.y)
      if (hi - lo > tol) return null
      if (x === cx && z === cz) here = g.y
    }
  }
  return { ground: here }
}

async function viewAround (s, x, z, half = 16) {
  if (await waitArea(s.tester, x - half, z - half, x + half, z + 16, 10)) return
  await s.rcon.send(`tp ${TESTER} ${x + 0.5} 200 ${z + 0.5}`)
  try { s.tester.creative.startFlying() } catch {}
  await waitArea(s.tester, x - half, z - half, x + half, z + 16, 45000)
}

// How far from the spawn the spot search looks
const SPOT_RADIUS = 256

async function findSpot (s) {
  const t = s.tester
  const sp = t.spawnPoint && (t.spawnPoint.x || t.spawnPoint.z || t.spawnPoint.y) ? t.spawnPoint.floored() : t.entity.position.floored()
  s.spawn = sp
  const cache = new Map()
  for (const tol of [1, 2]) {
    for (let r = 0; r <= SPOT_RADIUS; r += 8) {
      for (const [cx, cz] of ring(sp.x, sp.z, r)) {
        await viewAround(s, cx, cz)
        const ok = flatSpot(t, cx, cz, tol, cache)
        if (ok) {
          log(`flat spot at ${cx} ${ok.ground + 1} ${cz} (${r} blocks from the spawn, height spread at most ${tol})`)
          return new Vec3(cx, ok.ground + 1, cz)
        }
      }
    }
  }
  await viewAround(s, sp.x, sp.z)
  const g = groundAt(t, sp.x, sp.z, 200, -64, TREE)
  log(`no flat spot within ${SPOT_RADIUS} blocks of the spawn, using the ground under the spawn`)
  return new Vec3(sp.x, (g ? g.y : sp.y) + 1, sp.z)
}

async function benchSetup (s) {
  log('making the bench world from the seed (once): a fresh world, a spot, the chunks around it, then a pristine copy')
  await refuseIfBusy()
  if (fs.existsSync(PRISTINE)) log('an older pristine bench world exists, it gets replaced')
  fs.rmSync(BENCH_DIR, { recursive: true, force: true })
  try {
    await startServer(s)
    await checkSeed(s)
    await prepWorld(s, null)
    await joinTester(s)
    const bench = readBench()
    let spot = bench.spot ? new Vec3(...bench.spot) : null
    if (spot) {
      await viewAround(s, spot.x, spot.z)
      if (!flatSpot(s.tester, spot.x, spot.z, 2)) {
        log(`the saved spot ${spot} is not flat grass in this world, looking again`)
        spot = null
      }
    }
    if (!spot) {
      spot = await findSpot(s)
      bench.spot = [spot.x, spot.y, spot.z]
      bench.spawn = s.spawn ? [s.spawn.x, s.spawn.y, s.spawn.z] : null
      writeBench(bench)
    }
    // the chunks within about 190 blocks of the spot exist before the copy, with the animals they were made with
    for (const dx of [-96, 0, 96]) {
      for (const dz of [-96, 0, 96]) {
        await s.rcon.send(`tp ${TESTER} ${spot.x + dx + 0.5} 200 ${spot.z + dz + 0.5}`)
        try { s.tester.creative.startFlying() } catch {}
        await waitArea(s.tester, spot.x + dx - 64, spot.z + dz - 64, spot.x + dx + 64, spot.z + dz + 64, 90000)
        await sleep(2000)
      }
    }
    s.spot = spot
    await ownerAt(s, spot)
  } finally {
    await cleanup(s)
  }
  savePristine()
  log(`pristine bench world saved in ${rel(PRISTINE)}`)
}

function summaryLine (r) {
  const when = new Date(r.started)
  const at = r.spot ? ` at ${r.spot.join(' ')}` : ''
  const head = `${when.toDateString().slice(4, 10)} ${pad(when.getHours())}:${pad(when.getMinutes())} ${r.test}${at} on ${r.machine}: ${r.ok ? 'passed' : 'not passed'}`
  const parts = [head]
  if (r.error) parts.push(`error ${r.error}`)
  for (const st of r.steps || []) {
    if (st.blocks_dug !== undefined) {
      parts.push(`${st.command} ended ${st.result} after ${st.minutes} minutes with ${st.target_ores} ore in ${st.blocks_dug} blocks dug (${st.ores_per_100_blocks} per 100 blocks, ${st.minutes_per_ore ?? 'no'} minutes per ore), ${st.deaths} deaths, ${st.stuck_events} stuck events`)
    } else if (st.harvested !== undefined) {
      parts.push(`${st.command} ended ${st.result} after ${st.minutes} minutes, ${st.harvested} wheat harvested, ${st.replanted} seeds planted, ${st.stored_wheat} wheat in chests`)
    } else if (st.reply !== undefined) {
      parts.push(`"${st.command}" got the reply "${st.reply}"`)
    } else if (st.agents_stats && st.agents_stats.reached !== undefined) {
      const cs = st.agents_stats
      parts.push(`${st.command} ended ${st.result} after ${st.minutes} minutes, ${cs.reached} of ${cs.reached + cs.failed} targets reached, ${cs.walked} walked`)
    } else {
      parts.push(`${st.command} ended ${st.result} after ${st.minutes} minutes${st.error ? ` (${st.error})` : ''}`)
    }
  }
  if (r.finds) parts.push(`${r.finds.length} finds reported`)
  if (r.picture) parts.push(`picture ${r.picture.file}`)
  return parts.join('. ') + '.'
}

function appendBenchCsv (r) {
  const file = path.join(OUT_DIR, 'bench.csv')
  const st = (r.steps || [])[0] || {}
  const header = 'started,test,miner,machine,result,minutes,blocks_dug,target_ores,ores_per_100_blocks,minutes_per_ore,deaths,stuck_events,spot\n'
  if (!fs.existsSync(file)) fs.writeFileSync(file, header)
  else {
    // a file without the spot column gets it added, with those rows empty
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    if (!lines[0].endsWith(',spot')) fs.writeFileSync(file, [header.trim(), ...lines.slice(1).filter(Boolean).map(l => l + ',')].join('\n') + '\n')
  }
  const row = [r.started, r.test, r.miner || '', r.machine, st.result ?? (r.error ? 'error' : ''), st.minutes ?? '', st.blocks_dug ?? '',
    st.target_ores ?? '', st.ores_per_100_blocks ?? '', st.minutes_per_ore ?? '', st.deaths ?? '', st.stuck_events ?? '', (r.spot || []).join(' ')]
  fs.appendFileSync(file, row.map(v => String(v).replace(/,/g, ' ')).join(',') + '\n')
}

function saveResult (name, result) {
  const file = path.join(OUT_DIR, `${name}.json`)
  let doc = { test: name, latest: null, runs: [] }
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  doc.latest = result
  doc.runs = [...(doc.runs || []), result].slice(-20)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
  fs.appendFileSync(path.join(OUT_DIR, 'summary.txt'), summaryLine(result) + '\n')
  if (TESTS[name]?.bench) appendBenchCsv(result)
  log(`results in ${rel(file)}`)
}

let current = null

async function runTest (name) {
  const def = TESTS[name]
  const s = newSession(name)
  current = s
  logFile = path.join(OUT_DIR, `${name}-${s.stamp}.log`)
  const bench = readBench()
  const result = {
    test: name,
    started: new Date().toISOString(),
    machine: os.hostname(),
    platform: process.platform,
    seed: bench.seed,
    miner: def.miner || null,
    logs: { harness: rel(logFile), agents: rel(s.agentsLog), metrics: rel(s.metricsFile) }
  }
  log(`test ${name} starts`)
  try {
    await refuseIfBusy()
    if (!fs.existsSync(PRISTINE)) {
      await benchSetup(s)
      Object.assign(s, { chat: [], path: [] })
    }
    const spotArr = process.env.AGENTS_SPOT ? process.env.AGENTS_SPOT.split(',').map(Number) : readBench().spot
    if (spotArr && spotArr.some(n => !Number.isFinite(n))) throw new Error(`AGENTS_SPOT ${process.env.AGENTS_SPOT} is not x,y,z`)
    if (!spotArr) throw new Error('the bench world has no spot, run bench_setup')
    s.spot = new Vec3(...spotArr)
    result.spot = spotArr
    restoreBench()
    await startServer(s)
    await checkSeed(s)
    await prepWorld(s, s.spot)
    await joinTester(s)
    await ownerAt(s)
    if (def.flatten) {
      // a build test levels its own site first, the way a player picks flat ground: the build and the farming get
      // tested, not the hill
      await flattenSite(s, s.spot)
      await ownerAt(s)
    }
    s.metrics = new MetricsTail(s.metricsFile)
    startAgents(s, { miner: def.miner, translator: def.translator })
    await waitOnline(s, BOT, 4 * MINUTE)
    const g = groundAt(s.tester, s.spot.x + 2, s.spot.z - 2, 200, -64, TREE)
    s.botStart = new Vec3(s.spot.x + 2, g ? g.y + 1 : s.spot.y, s.spot.z - 2)
    await prepBot(s, BOT, s.botStart, def.bench ? bench.bench_kit : def.kit)
    await killHostiles(s, s.spot)
    if (def.picture) s.before = snapshot(s.tester, snapshotBox(def.picture, s.spot))
    startPathSampling(s)
    Object.assign(result, await withTimeout(def.run(s), (def.minutes + 5) * MINUTE, `the ${name} test`))
    stopPathSampling(s)
    if (def.picture && s.tester) {
      await sleep(1500)
      s.after = snapshot(s.tester, snapshotBox(def.picture, s.spot))
      result.picture = savePicture(s, def.picture)
    }
  } catch (err) {
    result.ok = false
    result.error = err.message
    log(`test ${name} failed: ${err.stack || err.message}`)
    // a picture of how far it got, when the world is still in view
    if (def.picture && s.before && s.tester && !result.picture) {
      try {
        s.after = snapshot(s.tester, snapshotBox(def.picture, s.spot))
        result.picture = savePicture(s, def.picture)
      } catch (e) {
        log(`no picture: ${e.message}`)
      }
    }
  } finally {
    try { await cleanup(s) } catch (err) { log(`cleanup: ${err.message}`) }
    result.ended = new Date().toISOString()
    result.minutes = round((Date.parse(result.ended) - Date.parse(result.started)) / MINUTE)
    result.path = s.path.filter((p, i) => i % Math.max(1, Math.ceil(s.path.length / 400)) === 0).map(p => [p.x, p.y, p.z])
    saveResult(name, result)
    current = null
  }
  log(`test ${name} ended: ${result.ok ? 'passed' : 'not passed'}`)
  return result
}

// ---------------------------------------------------------------------------------------------------------------
// A session: one server for many scenes, so the owner's Minecraft stays connected with the camera on the bot. Between
// scenes the plot and the bot are reset in place and read back from the server. A reset that does not check out fails
// that scene at setup. Every pass condition is the scene's own, unchanged.
//   node bridge/danger_sensing_agents/livetest.js session net_zombie,net_skeleton [rounds]

const SESSION_MAX_RSS_MB = 1900   // a server past this is restarted between two scenes
const SESSION_TAG = 'livefight'

function serverRssMb (pid) {
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)
    return m ? Number(m[1]) / 1024 : 0
  } catch {
    return 0
  }
}

async function onlineNames (s) {
  return (String(await s.rcon.send('list')).split(':').slice(1).join(':') || '').split(',').map(x => x.trim()).filter(Boolean)
}

// The bot leaves the server, so the next scene starts from a new connection and a new process state
async function closeSessionBot (s) {
  if (!s.agents) return
  try { s.agents.close() } catch {}
  s.agents = null
  const until = Date.now() + 20000
  while (Date.now() < until) {
    if (!(await onlineNames(s)).includes(BOT)) return
    await sleep(400)
  }
  throw new Error(`${BOT} did not leave the server`)
}

async function openSessionWorld (s) {
  restoreBench()
  await startServer(s)
  await checkSeed(s)
  await prepWorld(s, s.spot)
  await setRule(s, ['spawn_mobs', 'doMobSpawning'], 'false')
  await joinTester(s)
  await ownerAt(s)
  s.plot = await savePlot(s.rcon, fightPlot({ x: s.spot.x, y: s.spot.y, z: s.spot.z + 6 }), { sleep })
  log(`session world open, reference copy of the plot laid (${s.plot.box.x1} ${s.plot.box.y1} ${s.plot.box.z1} to ${s.plot.box.x2} ${s.plot.box.y2} ${s.plot.box.z2})`)
}

async function reopenSessionWorld (s, why) {
  log(`restarting the session's server: ${why}`)
  if (s.tester) {
    try { s.tester.quit('server restart') } catch {}
    s.tester = null
  }
  await stopServer(s)
  await openSessionWorld(s)
}

async function runSessionScene (s, name, roundNo, rounds) {
  const def = TESTS[name]
  const bench = readBench()
  Object.assign(s, newSession(name), { before: null, after: null, metrics: null, flattened: null, botStart: null })
  logFile = path.join(OUT_DIR, `${name}-${s.stamp}.log`)
  const result = {
    test: name,
    started: new Date().toISOString(),
    machine: os.hostname(),
    platform: process.platform,
    seed: bench.seed,
    miner: def.miner || null,
    session: true,
    round: roundNo,
    spot: [s.spot.x, s.spot.y, s.spot.z],
    logs: { harness: rel(logFile), agents: rel(s.agentsLog), metrics: rel(s.metricsFile) }
  }
  log(`test ${name} starts (session, round ${roundNo} of ${rounds})`)
  let ready = false
  try {
    await closeSessionBot(s)
    if (s.serverExit !== undefined) await reopenSessionWorld(s, `it stopped (${s.serverExit})`)
    else if (serverRssMb(s.serverPid) > SESSION_MAX_RSS_MB) await reopenSessionWorld(s, `it uses ${Math.round(serverRssMb(s.serverPid))} MB`)
    await s.rcon.send(`clear ${TESTER}`)
    await resetPlot(s.rcon, s.plot, { sleep, tag: SESSION_TAG })
    for (const c of ['time set 1000', 'weather clear', 'difficulty normal']) await s.rcon.send(c)
    await ownerAt(s)
    await announce(s.rcon, `Next test: ${name}${rounds > 1 ? `, round ${roundNo} of ${rounds}` : ''}`)
    s.metrics = new MetricsTail(s.metricsFile)
    startAgents(s, { miner: def.miner, translator: def.translator })
    await waitOnline(s, BOT, 2 * MINUTE)
    const g = groundAt(s.tester, s.spot.x + 2, s.spot.z - 2, 200, -64, TREE)
    s.botStart = new Vec3(s.spot.x + 2, g ? g.y + 1 : s.spot.y, s.spot.z - 2)
    await clearBot(s.rcon, BOT)
    await prepBot(s, BOT, s.botStart, def.kit)
    await checkBot(s.rcon, BOT, { kit: def.kit, at: s.botStart }, { sleep })
    // a new connection is a new player entity, so the owner's camera is put on it again
    const watcher = process.env.CREW_SHOW_WATCHER
    if (watcher && (await onlineNames(s)).includes(watcher)) {
      await s.rcon.send(`gamemode spectator ${watcher}`)
      await s.rcon.send(`spectate ${BOT} ${watcher}`)
    }
    ready = true
    startPathSampling(s)
    Object.assign(result, await withTimeout(def.run(s), (def.minutes + 5) * MINUTE, `the ${name} test`))
  } catch (err) {
    result.ok = false
    result.error = err.message
    if (!ready) result.setup_failed = true
    log(`test ${name} ${ready ? 'failed' : 'failed at setup'}: ${err.stack || err.message}`)
  } finally {
    stopPathSampling(s)
    try { await closeSessionBot(s) } catch (err) { log(`closing the bot: ${err.message}`) }
    result.ended = new Date().toISOString()
    result.minutes = round((Date.parse(result.ended) - Date.parse(result.started)) / MINUTE)
    result.path = s.path.filter((p, i) => i % Math.max(1, Math.ceil(s.path.length / 400)) === 0).map(p => [p.x, p.y, p.z])
    saveResult(name, result)
  }
  log(`test ${name} ended: ${result.ok ? 'passed' : 'not passed'}`)
  return result
}

async function runSession (names, rounds) {
  if (process.env.AGENTS_IN_PROCESS !== '1') throw new Error('a session needs AGENTS_IN_PROCESS=1')
  const other = names.filter(n => !TESTS[n]?.fight)
  if (other.length) throw new Error(`the session runner only runs fight scenes so far, not ${other.join(', ')}`)
  const attempt = process.env.CREW_ATTEMPT || 'session'
  const stopFlag = path.join(ROOT, 'STOP_AFTER_SCENE')
  const s = newSession('session')
  current = s
  logFile = path.join(OUT_DIR, `session-${s.stamp}.log`)
  const results = []
  await refuseIfBusy()
  if (!fs.existsSync(PRISTINE)) throw new Error('no pristine bench world, run bench_setup')
  const spot = readBench().spot
  if (!spot) throw new Error('the bench world has no spot, run bench_setup')
  s.spot = new Vec3(...spot)
  try {
    await openSessionWorld(s)
    for (let roundNo = 1; roundNo <= rounds; roundNo++) {
      for (const name of names) {
        const file = path.join(OUT_DIR, `${name}-${attempt}-round${roundNo}.json`)
        if (fs.existsSync(file)) { log(`SKIP ${name} attempt ${attempt} round ${roundNo}: it already has a result`); continue }
        if (fs.existsSync(stopFlag)) { log('stop flag seen, ending the session at this scene boundary'); return results }
        const r = await runSessionScene(s, name, roundNo, rounds)
        fs.copyFileSync(path.join(OUT_DIR, `${name}.json`), file)
        console.log(`RESULT ${name} attempt ${attempt} round ${roundNo} ${r.ok ? 'pass' : 'FAIL'}${r.setup_failed ? ' (setup)' : ''}`)
        results.push(r)
      }
    }
    return results
  } finally {
    await cleanup(s)
    current = null
  }
}

function pastTime (hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes() > h * 60 + m
}

async function stopByPidFile () {
  let pid = null
  try { pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10) } catch {}
  if (!pidAlive(pid)) {
    log('the agents server is not running')
    return
  }
  const s = { serverPid: pid }
  try { s.rcon = await waitRcon({}, 10000) } catch {}
  await stopServer(s)
}

async function main () {
  const argv = process.argv.slice(2)
  const what = argv[0]
  const ui = argv.indexOf('--until')
  const until = ui >= 0 ? argv[ui + 1] : null
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const pidFile = path.join(OUT_DIR, 'livetest.pid')
  fs.writeFileSync(pidFile, String(process.pid))
  const onSignal = async sig => {
    log(`${sig}, cleaning up`)
    if (current) {
      try { await cleanup(current) } catch {}
    }
    try { fs.unlinkSync(pidFile) } catch {}
    process.exit(1)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    if (what === 'all' || (what && what.split(',').every(n => TESTS[n]))) {
      const names = what === 'all' ? ORDER : what.split(',')
      const results = []
      for (const name of names) {
        if (until && pastTime(until)) {
          log(`it is past ${until}, ${name} and the tests after it are not run`)
          break
        }
        results.push(await runTest(name))
      }
      log(`done: ${results.map(r => `${r.test} ${r.ok ? 'passed' : 'not passed'}`).join(', ')}`)
      if (results.some(r => !r.ok)) process.exitCode = 1
    } else if (what === 'session') {
      const results = await runSession(String(argv[1] || '').split(',').filter(Boolean), Math.max(1, Number(argv[2]) || 1))
      log(`session done: ${results.map(r => `${r.test} ${r.ok ? 'passed' : 'not passed'}`).join(', ')}`)
      if (results.some(r => !r.ok)) process.exitCode = 1
    } else if (what === 'bench_setup') {
      const s = newSession('bench_setup')
      current = s
      logFile = path.join(OUT_DIR, `bench_setup-${s.stamp}.log`)
      await benchSetup(s)
    } else if (what === 'serve') {
      const s = newSession('serve')
      await refuseIfBusy()
      if (!fs.existsSync(BENCH_DIR)) restoreBench()
      await startServer(s, { detached: true })
      await checkSeed(s)
      s.rcon.close()
      log(`the bench world is open on port ${CONFIG.port} as the last test left it (pid ${s.serverPid}), stop it with: node bridge/danger_sensing_agents/livetest.js stop`)
    } else if (what === 'stop') {
      await stopByPidFile()
    } else {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 26).join('\n'))
      process.exitCode = 2
    }
  } finally {
    try { fs.unlinkSync(pidFile) } catch {}
  }
  // mineflayer and RCON sockets can keep the event loop alive
  setTimeout(() => process.exit(process.exitCode || 0), 500)
}

// Every craft, handing over while facing the owner, the mob network, the food rules and plain chat (live_scenes.js)
require('./live_scenes').registerScenes(TESTS, { BOT, TESTER, MINUTE, TREE, LOG_ITEMS, FOOD_ITEMS, sleep, round, say, statsNow, statDiff, setRule, groundAt, serverCount, serverEntityNumber, serverPos, playerTotal, posOf, handOver, commandStep, botChat })

if (require.main === module) {
  main().catch(err => {
    log(err.stack || err.message)
    process.exit(1)
  })
}

module.exports = {
  benchProperties, offlineUuid, parseItems, statDiff, mineSummary, encodePng, crc32, renderPng, ring, coordsIn,
  blockColor, summaryLine, snapshot, snapshotBox, changedColumns, savePicture, flatSpot, groundAt, findJava, walkFiles,
  handOver, testerComesClose, playerTotal,
  TESTS, ORDER, foodVerdict,
  IRON_BENCH_BREAD, IRON_BENCH_ORDER, IRON_BENCH_MATERIALS, IRON_BENCH_SCENES, IRON_BENCH_ANIMALS,
  parseAsk, freeSpotBeside, stepBackFrom, chestContents, setupIronScene, ironSources, ironFailure, testIronPickaxe, runSession
}
