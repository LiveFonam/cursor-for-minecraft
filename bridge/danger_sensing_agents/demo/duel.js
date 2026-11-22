// One 1v1 fighter in its own process: it joins, loads the network, and fights once told to. The demo controller starts it
// with one JSON argument and reads one JSON event per line: {"event":"ready"}. A line "go" on stdin starts the fight.

const path = require('path')
const Module = require('module')
const readline = require('readline')
const { spawn } = require('child_process')
const { EventEmitter } = require('events')

const TICKS_PER_STEP = 2

function policyCommand (cfg) {
  const beside = path.join(path.dirname(cfg.policy), 'fighter_src')
  const fighterSrc = path.join(cfg.sourceRoot, 'fighter', 'src')
  const pythonPath = [beside, fighterSrc, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
  return {
    file: cfg.python,
    args: [cfg.policy, '--run', cfg.run],
    env: { ...process.env, PYTHONPATH: pythonPath },
    cwd: cfg.sourceRoot
  }
}

// The parent's handle on a running fighter
function spawnDuel (cfg) {
  const child = spawn(process.execPath, [__filename, JSON.stringify(cfg)], { stdio: ['pipe', 'pipe', 'inherit'] })
  const handle = new EventEmitter()
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try {
      if (JSON.parse(line).event === 'ready') handle.emit('ready')
    } catch {}
  })
  child.on('exit', code => handle.emit('exit', code))
  child.on('error', () => handle.emit('exit', 1))
  handle.go = () => { try { child.stdin.write('go\n') } catch {} }
  handle.stop = () => { if (child.exitCode === null) child.kill('SIGTERM') }
  return handle
}

async function main (cfg) {
  // the client file can live outside this tree, and finds its packages here
  process.env.NODE_PATH = [path.join(__dirname, '..', '..', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
  Module._initPaths()
  const emit = event => process.stdout.write(JSON.stringify({ event }) + '\n')
  const log = (...a) => console.error('[duel]', ...a)
  console.log = log

  require('../../patch-physics')
  const mineflayer = require('mineflayer')
  const { PolicyClient } = require('../skills/policy')
  const { Fighter, IDLE_ACTION, SLOT_AXE } = require(cfg.client)
  const { applyMineflayerFixes } = require(path.join(path.dirname(cfg.client), 'mineflayer_fixes'))

  const command = policyCommand(cfg)
  const policy = new PolicyClient(cfg.run, log, {
    spawnProcess: (_file, _args, options) => spawn(command.file, command.args, { ...options, cwd: command.cwd, env: command.env })
  })
  const info = await policy.start()

  const bot = mineflayer.createBot({ host: cfg.host, port: cfg.port, username: cfg.name, version: cfg.version, auth: 'offline' })
  bot.setMaxListeners(60)
  const quit = code => {
    try { policy.close() } catch {}
    try { bot.quit('closing') } catch {}
    setTimeout(() => process.exit(code), 500)
  }
  process.on('SIGTERM', () => quit(0))
  process.on('SIGINT', () => quit(0))
  bot.on('kicked', r => { log('kicked', JSON.stringify(r).slice(0, 200)); process.exit(3) })
  bot.on('error', e => log(e.message))
  bot.on('end', () => process.exit(3))
  await new Promise(resolve => bot.once('spawn', resolve))
  applyMineflayerFixes(bot)

  const fighter = new Fighter(bot, cfg.enemy, { arena: { x: cfg.arena.x, y: cfg.arena.y, z: cfg.arena.z, half: cfg.arena.half } })
  fighter.setFairHealth(!!info?.fair, 'player', false)
  let fighting = false
  let thinking = false
  let ticks = 0
  bot.on('physicsTick', () => {
    if (!fighting || thinking || bot.health <= 0 || ++ticks % TICKS_PER_STEP) return
    thinking = true
    Promise.resolve()
      .then(() => policy.act(bot.username, fighter.observe(), fighter.masks()))
      .then(action => { if (fighting) fighter.act(action || IDLE_ACTION) })
      .catch(err => log(err.message))
      .finally(() => { thinking = false })
  })
  readline.createInterface({ input: process.stdin }).on('line', line => {
    if (line.trim() !== 'go' || fighting) return
    fighter.reset()
    fighter.selectSlot(SLOT_AXE)
    fighting = true
  }).on('close', () => quit(0))
  emit('ready')
}

if (require.main === module) {
  main(JSON.parse(process.argv[2])).catch(err => {
    console.error('[duel]', err.stack || err.message)
    process.exit(1)
  })
}

module.exports = { spawnDuel, policyCommand }
