// A 1v1 in its own world. One command starts a private Paper server, waits for the player, plays a best of 3 with the same
// fight code as the walkthrough's !1v1, and stops that server again.
//
//   DEMO_PLAYER=<name> DEMO_FIGHTER_RUN=<folder> node bridge/danger_sensing_agents/demo/one_v_one.js
//
//   ONE_V_ONE_DIR           the server's folder, world included (default runs/one-v-one, which git ignores)
//   ONE_V_ONE_PAPER         the server jar (default paper.jar in that folder)
//   ONE_V_ONE_JAVA          the Java 21 program (default java)
//   ONE_V_ONE_MEMORY        the server's largest heap (default 1G)
//   ONE_V_ONE_PORT          the game port (default 25570)
//   ONE_V_ONE_CONSOLE_PORT  the console port (default 25571)
//   ONE_V_ONE_JOIN_SECONDS  how long to wait for the player (default 600)
//
// The fighter's settings are the walkthrough's, listed in settings.js. The Minecraft EULA is yours to accept, so this
// never writes eula.txt and does not start without eula=true in it.

const crypto = require('crypto')
const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')
const { Rcon } = require('../../rcon')
const { loadSettings, missingFighterFiles } = require('./settings')
const { DemoController } = require('./controller')
const { spawnDuel: defaultDuel } = require('./duel')
const scene = require('./scene')

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..')
const GAME_PORT = 25570
const CONSOLE_PORT = 25571
const KEPT_PORTS = new Set([25565, 25575])   // the usual ports of a main server, never used here
const STAGE = Object.freeze({ x: -200, y: -60, z: 0 })   // puts the arena at the world's middle
const WINS_NEEDED = 2
const MOST_FIGHTS = 5        // drawn fights do not count, and this keeps a run of them from going on forever
const BETWEEN_FIGHTS_MS = 4000
const LAST_WORD_MS = 5000
const READY_SECONDS = 180
const STOP_SECONDS = 30
const WATCH_MS = 2000
const EULA_LINK = 'https://aka.ms/MinecraftEULA'
const FLAT_WORLD = JSON.stringify({
  biome: 'minecraft:plains',
  layers: [{ block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:dirt', height: 2 }, { block: 'minecraft:grass_block', height: 1 }]
})

const log = (...a) => console.error('[1v1]', ...a)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function portSetting (env, key, fallback) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${key} must be a port from 1024 to 65535`)
  return port
}

function serverOptions (env = process.env) {
  const dir = path.resolve(SOURCE_ROOT, env.ONE_V_ONE_DIR || path.join('runs', 'one-v-one'))
  const gamePort = portSetting(env, 'ONE_V_ONE_PORT', GAME_PORT)
  const consolePort = portSetting(env, 'ONE_V_ONE_CONSOLE_PORT', CONSOLE_PORT)
  if (gamePort === consolePort) throw new Error('The game port and the console port must differ')
  for (const port of [gamePort, consolePort]) {
    if (KEPT_PORTS.has(port)) throw new Error(`Port ${port} is left for your main server. Pick another one`)
  }
  const joinSeconds = Number(env.ONE_V_ONE_JOIN_SECONDS || 600)
  if (!Number.isInteger(joinSeconds) || joinSeconds < 1) throw new Error('ONE_V_ONE_JOIN_SECONDS must be a whole number of seconds')
  const memory = env.ONE_V_ONE_MEMORY || '1G'
  if (!/^[1-9]\d*[MG]$/.test(memory)) throw new Error('ONE_V_ONE_MEMORY must look like 900M or 1G')
  return {
    dir,
    paper: path.resolve(SOURCE_ROOT, env.ONE_V_ONE_PAPER || path.join(dir, 'paper.jar')),
    java: env.ONE_V_ONE_JAVA || 'java',
    memory,
    gamePort,
    consolePort,
    joinSeconds
  }
}

// Only a line of its own counts, so a commented out eula=true does not
const eulaAccepted = text => /^[ \t]*eula[ \t]*=[ \t]*true[ \t]*$/mi.test(String(text))

// What stops the server from starting, in words the person can act on, or null
function whyNotStart (opts, read = fs.readFileSync, exists = fs.existsSync) {
  const file = path.join(opts.dir, 'eula.txt')
  let text = ''
  try { text = read(file, 'utf8') } catch {}
  if (!eulaAccepted(text)) {
    return `The Minecraft EULA has not been accepted for this server, so nothing was started. Read ${EULA_LINK} and, if you agree, ` +
      `create ${file} with the line eula=true, then run this command again.`
  }
  if (!exists(opts.paper)) return `No Paper server at ${opts.paper}. Put a Paper 1.21.11 jar there, or set ONE_V_ONE_PAPER to its path.`
  return null
}

// A flat world on this machine only. The fighter logs in without an account, so the server is offline and allow listed
function serverProperties ({ gamePort, consolePort, password }) {
  return [
    'server-ip=127.0.0.1',
    `server-port=${gamePort}`,
    'enable-rcon=true',
    `rcon.port=${consolePort}`,
    `rcon.password=${password}`,
    'broadcast-rcon-to-ops=false',
    'online-mode=false',
    'white-list=true',
    'level-name=world',
    'level-type=minecraft\\:flat',
    `generator-settings=${FLAT_WORLD}`,
    'generate-structures=false',
    'gamemode=adventure',
    'difficulty=normal',
    'spawn-monsters=false',
    'spawn-protection=0',
    'allow-flight=true',
    'max-players=4',
    'view-distance=6',
    'simulation-distance=4',
    'motd=1v1 against the trained fighter',
    ''
  ].join('\n')
}

function readPid (file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function portInUse (port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = used => {
      socket.destroy()
      resolve(used)
    }
    socket.setTimeout(700, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function startServer (opts) {
  const pidFile = path.join(opts.dir, 'server.pid')
  const old = readPid(pidFile)
  if (old && isAlive(old)) {
    throw new Error(`A server from an earlier run may still be up, process ${old}. Stop it, or delete ${pidFile} if that process is something else.`)
  }
  fs.rmSync(pidFile, { force: true })
  for (const port of [opts.gamePort, opts.consolePort]) {
    if (await portInUse(port)) throw new Error(`Port ${port} is already in use. Set ONE_V_ONE_PORT or ONE_V_ONE_CONSOLE_PORT to a free one.`)
  }
  const password = crypto.randomBytes(18).toString('hex')
  const properties = path.join(opts.dir, 'server.properties')
  fs.writeFileSync(properties, serverProperties({ ...opts, password }), { mode: 0o600 })
  fs.chmodSync(properties, 0o600)
  const logFile = path.join(opts.dir, 'server.log')
  const out = fs.openSync(logFile, 'w')
  // its own process group, so Ctrl-C reaches this script first and the fight is closed before the server goes
  const child = spawn(opts.java, ['-Xms512M', `-Xmx${opts.memory}`, '-jar', opts.paper, '--nogui'],
    { cwd: opts.dir, stdio: ['ignore', out, out], detached: true })
  fs.closeSync(out)
  const server = { child, pidFile, logFile, password, exited: false }
  child.once('exit', () => { server.exited = true })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', err => reject(new Error(`Could not run ${opts.java}: ${err.message}. Set ONE_V_ONE_JAVA to a Java 21 program.`)))
  })
  fs.writeFileSync(pidFile, `${child.pid}\n`)
  log(`server starting, process ${child.pid}, log at ${logFile}`)
  return server
}

async function waitForServer (server) {
  for (let i = 0; i < READY_SECONDS; i++) {
    if (server.exited) throw new Error(`The server stopped while starting. See ${server.logFile}`)
    if (fs.readFileSync(server.logFile, 'utf8').includes('Done (')) return
    await pause(1000)
  }
  throw new Error(`The server was not up after ${READY_SECONDS} seconds. See ${server.logFile}`)
}

// Only ever the process this run started and saved
async function stopServer (server) {
  const saved = readPid(server.pidFile)
  if (saved !== server.child.pid) {
    log(`the saved process id does not match process ${server.child.pid}, leaving it alone`)
    return
  }
  if (!server.exited) {
    process.kill(saved, 'SIGTERM')
    for (let i = 0; i < STOP_SECONDS * 4 && !server.exited; i++) await pause(250)
    if (!server.exited) {
      log('the server did not stop in time, ending it')
      process.kill(saved, 'SIGKILL')
      for (let i = 0; i < 20 && !server.exited; i++) await pause(250)
    }
  }
  fs.rmSync(server.pidFile, { force: true })
  log('server stopped')
}

// The same fight as the walkthrough. Only the way back differs: there is no base here, so he waits on his side
class MatchController extends DemoController {
  duelReturnCommands () {
    const P = this.s.player
    const spot = scene.duelSpots(this.stage).player
    return [`clear ${P}`, `effect clear ${P}`, `effect give ${P} instant_health 1 3 true`, `gamemode adventure ${P}`,
      `tp ${P} ${spot.x} ${spot.y} ${spot.z} ${spot.yaw} 0`]
  }
}

function worldCommands (settings) {
  const spot = scene.duelSpots(STAGE).player
  return [
    'gamerule immediate_respawn true', 'gamerule doImmediateRespawn true',
    'gamerule spawn_mobs false', 'gamerule doMobSpawning false',
    'gamerule advance_time false', 'gamerule doDaylightCycle false',
    'gamerule advance_weather false', 'gamerule doWeatherCycle false',
    'gamerule respawn_radius 0', 'gamerule spawnRadius 0',
    'time set noon',
    'weather clear',
    `setworldspawn ${Math.floor(spot.x)} ${spot.y} ${Math.floor(spot.z)}`,
    `whitelist add ${settings.player}`
  ]
}

const onlineNames = reply => {
  const m = String(reply).match(/online:\s*(.*)$/s)
  return m ? m[1].split(',').map(n => n.trim()).filter(Boolean) : []
}
const isOnline = (reply, name) => onlineNames(reply).some(n => n.toLowerCase() === name.toLowerCase())

// Who has taken the match, 'draw' when the fights ran out level, or null while it goes on
function matchResult (score, fights) {
  if (score.player >= WINS_NEEDED) return 'player'
  if (score.fighter >= WINS_NEEDED) return 'fighter'
  if (fights < MOST_FIGHTS) return null
  if (score.player === score.fighter) return 'draw'
  return score.player > score.fighter ? 'player' : 'fighter'
}

// fight() plays one and gives its outcome. A fight that could not finish ends the match
async function playMatch ({ fight, tell, wait, fighterName }) {
  const score = { player: 0, fighter: 0 }
  for (let n = 1; n <= MOST_FIGHTS; n++) {
    await tell(`Fight ${n}. First to ${WINS_NEEDED} wins.`)
    const outcome = await fight()
    if (outcome === 'player' || outcome === 'fighter') score[outcome]++
    else if (outcome !== 'time') return { score, result: 'off', fights: n }
    await tell(`Score: you ${score.player}, ${fighterName} ${score.fighter}.`)
    const result = matchResult(score, n)
    if (result) return { score, result, fights: n }
    await wait(BETWEEN_FIGHTS_MS)
  }
  return { score, result: 'draw', fights: MOST_FIGHTS }
}

function fightOnce (controller) {
  return new Promise(resolve => {
    controller.onDuelEnd = resolve
    // a fight that fails before it starts never reaches its end
    controller.enqueue(() => controller.duel()).then(() => { if (!controller.duelRun) resolve('crashed') })
  })
}

const LAST_WORDS = {
  player: 'You won the match!',
  fighter: 'The fighter won the match.',
  draw: 'The match is a draw.',
  off: 'The match was called off.'
}

async function main (env = process.env) {
  const opts = serverOptions(env)
  fs.mkdirSync(opts.dir, { recursive: true })
  const blocked = whyNotStart(opts)
  if (blocked) {
    console.error(blocked)
    return 2
  }
  const settings = {
    ...loadSettings({ ...env, AGENTS_HOST: '127.0.0.1', AGENTS_PORT: String(opts.gamePort), AGENTS_RCON_PORT: String(opts.consolePort) }),
    stage: STAGE
  }
  const missing = missingFighterFiles(settings)
  if (missing.length) {
    console.error(`The fighter cannot run, missing: ${missing.join(', ')}. Set DEMO_FIGHTER_RUN to a trained fighter's folder.`)
    return 1
  }

  let server = null
  let rcon = null
  let controller = null
  let watcher = null
  let closing = null
  const close = () => {
    closing = closing || (async () => {
      if (watcher) clearInterval(watcher)
      try { controller?.close() } catch {}
      await pause(300)
      try { rcon?.close() } catch {}
      if (server) await stopServer(server)
    })()
    return closing
  }
  const quitWith = code => close().finally(() => process.exit(code))
  process.on('SIGINT', () => quitWith(130))
  process.on('SIGTERM', () => quitWith(143))
  process.on('exit', () => {
    if (server && !server.exited && readPid(server.pidFile) === server.child.pid) {
      try { process.kill(server.child.pid, 'SIGTERM') } catch {}
    }
  })

  try {
    server = await startServer(opts)
    server.child.once('exit', () => {
      if (closing) return
      log('the server stopped by itself')
      quitWith(1)
    })
    await waitForServer(server)
    rcon = new Rcon('127.0.0.1', opts.consolePort, server.password)
    await rcon.connect()

    const duel = settings.duelModule ? require(settings.duelModule).spawnDuel : defaultDuel
    const agents = { agentBot: () => null, stopAgent: async () => {}, runTask: async () => {}, holdAtBase: () => {} }
    controller = new MatchController({ settings, rcon, agents, spawnDuel: duel, log, hostile: [] })
    controller.stage = STAGE
    await controller.sendAll(worldCommands(settings))
    await controller.send(`forceload add ${scene.arenaChunks(STAGE)}`)
    for (const c of scene.arenaCommands(STAGE)) await controller.sendLoaded(c)

    log(`join localhost:${opts.gamePort} as ${settings.player}. Waiting up to ${opts.joinSeconds} seconds.`)
    const spot = scene.duelSpots(STAGE).player
    let joined = false
    for (let i = 0; i < opts.joinSeconds && !joined; i++) {
      joined = isOnline(await controller.send('list'), settings.player)
      if (!joined) await pause(1000)
    }
    if (!joined) throw new Error(`${settings.player} did not join in ${opts.joinSeconds} seconds`)
    await controller.sendAll([`gamemode adventure ${settings.player}`, `clear ${settings.player}`,
      `tp ${settings.player} ${spot.x} ${spot.y} ${spot.z} ${spot.yaw} 0`])
    await pause(BETWEEN_FIGHTS_MS)

    // he left: the fight in progress stops, and that ends the match
    watcher = setInterval(async () => {
      const run = controller.duelRun
      if (!run || isOnline(await controller.send('list'), settings.player)) return
      if (controller.duelRun !== run) return
      log(`${settings.player} left`)
      run.stopped = true
      run.child.stop()
    }, WATCH_MS)

    const { score, result, fights } = await playMatch({
      fight: () => fightOnce(controller),
      tell: text => controller.tell(text),
      wait: pause,
      fighterName: settings.fighterName
    })
    clearInterval(watcher)
    watcher = null
    await controller.tell(`${LAST_WORDS[result]} You ${score.player}, ${settings.fighterName} ${score.fighter}.`)
    log(`match over after ${fights} fights: ${result}, you ${score.player}, ${settings.fighterName} ${score.fighter}`)
    await pause(LAST_WORD_MS)
    await close()
    return result === 'off' ? 1 : 0
  } catch (err) {
    log(err.message)
    await close()
    return 1
  }
}

if (require.main === module) {
  main().then(code => process.exit(code), err => {
    console.error(err.message)
    process.exit(1)
  })
}

module.exports = {
  GAME_PORT, CONSOLE_PORT, MOST_FIGHTS, STAGE, eulaAccepted, isOnline, matchResult, onlineNames, playMatch, serverOptions,
  serverProperties, whyNotStart, worldCommands, MatchController
}
