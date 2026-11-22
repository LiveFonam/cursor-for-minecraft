// One Minecraft client for the comparison, driven by the runner over stdin and stdout, one JSON message per line.
//
//   node side.js --role ref|new|opp --name <login> --enemy <login> --port <port> --cx <x> --cz <z> --half <h>
//
// Each process holds one bot, so a fighter's inputs can only come from what its own client received. The opponent role
// plays a scripted level or one of the open source bots.

const readline = require('readline')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const ROLE = arg('role')
const NAME = arg('name')
const ENEMY = arg('enemy')
const PORT = Number(arg('port'))
const CENTER = { x: Number(arg('cx', 0)), y: 100, z: Number(arg('cz', 0)) }
const HALF = Number(arg('half', 10))
const TICKS_PER_STEP = 2
const CLOCK_STEPS = 600
const READY_TICKS = 130  // long enough for a shield cooldown from the last round to run out on the server
const OFF_HAND_SLOT = 45

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n')
const log = (...a) => console.error(`[${NAME}]`, ...a)
console.log = log

require('./physics_check').check()
const mineflayer = require('mineflayer')
const { Metrics } = require('./metrics')

const lib = ROLE === 'new' ? require('./new/fighter') : require('./ref/fighter')
const { Fighter, IDLE_ACTION } = lib
const SLOT_AXE = lib.SLOT_AXE

let bot, fighter, metrics, brain, plugin
let dead = false
let steps = 0
let delay = 0
let queue = []

// The open source bots, set up the way the reference bridge sets them up: fair reach, no digging
const PLUGINS = {
  'mineflayer-pvp': {
    load (b) {
      const { pathfinder, Movements } = require('mineflayer-pathfinder')
      b.loadPlugin(pathfinder)
      b.loadPlugin(require('mineflayer-pvp').plugin)
      const moves = new Movements(b)
      moves.canDig = false
      b.pathfinder.setMovements(moves)
      b.pvp.movements = moves
      b.pvp.attackRange = 3.0
    },
    start (b, target) { b.setQuickBarSlot(1); b.pvp.attack(target) },
    stop (b) { b.pvp.stop() }
  },
  'custom-pvp': {
    load (b) {
      const { pathfinder, Movements } = require('mineflayer-pathfinder')
      b.loadPlugin(pathfinder)
      b.loadPlugin(require('@nxg-org/mineflayer-custom-pvp').default)
      const moves = new Movements(b)
      moves.canDig = false
      b.pathfinder.setMovements(moves)
      b.swordpvp.options.critConfig.mode = 'hop'
      b.swordpvp.options.genericConfig.attackRange = 3
      b.swordpvp.options.genericConfig.hitThroughWalls = false
    },
    start (b, target) { b.setQuickBarSlot(1); b.swordpvp.attack(target) },
    stop (b) { b.swordpvp.stop() }
  },
  'sweat-sword': {
    load (b) {
      const { pathfinder, Movements } = require('mineflayer-pathfinder')
      b.loadPlugin(pathfinder)
      const moves = new Movements(b)
      moves.canDig = false
      moves.allow1by1towers = false
      moves.allowParkour = true
      moves.allowSprinting = true
      moves.scafoldingBlocks = []
      b.pathfinder.setMovements(moves)
      b.pathfinder.thinkTimeout = 200
    },
    start (b, target) {
      const { SweatFighter } = require('./ref/sweat')
      b.setQuickBarSlot(1)
      b.sweat?.stop()
      b.sweat = new SweatFighter(b, target)
    },
    stop (b) { b.sweat?.stop(); b.sweat = null }
  }
}

function applyFixes () {
  if (ROLE === 'new') {
    require('./new/mineflayer_fixes').applyMineflayerFixes(bot)
    return
  }
  bot._client.on('entity_velocity', p => {
    const e = bot.entities[p.entityId]
    if (e) e.velocity.set(p.velocity.x, p.velocity.y, p.velocity.z)
  })
  require('./ref/sprint_fix').fixSprintPackets(bot)
}

function join () {
  return new Promise((resolve, reject) => {
    bot = mineflayer.createBot({ host: '127.0.0.1', port: PORT, username: NAME, version: '1.21.11', auth: 'offline', viewDistance: 'tiny', checkTimeoutInterval: 120000 })
    bot.setMaxListeners(60)
    const timer = setTimeout(() => reject(new Error('join timed out')), 60000)
    bot.once('spawn', () => {
      clearTimeout(timer)
      applyFixes()
      bot.on('death', () => { dead = true })
      bot.on('kicked', r => { log('kicked', JSON.stringify(r).slice(0, 200)); process.exit(3) })
      bot.on('end', r => { if (r !== 'closing') { log('disconnected', r); process.exit(3) } })
      resolve()
    })
    bot.once('kicked', r => { clearTimeout(timer); reject(new Error(`kicked: ${JSON.stringify(r).slice(0, 200)}`)) })
    bot.once('error', e => { clearTimeout(timer); reject(e) })
  })
}

const handlers = {
  async join (msg) {
    await join()
    if (ROLE === 'new') {
      fighter = new Fighter(bot, ENEMY, { arena: { ...CENTER, half: HALF } })
      fighter.setFairHealth(true, 'player', false)
    } else {
      fighter = new Fighter(bot, ENEMY)
      fighter.setFairHealth(true, 'player', false)
      fighter.kindInput = ROLE === 'ref'
    }
    metrics = new Metrics(bot, ENEMY)
    if (ROLE === 'opp') {
      if (PLUGINS[msg.opponent]) {
        plugin = PLUGINS[msg.opponent]
        plugin.load(bot)
      } else if (msg.opponent === 'shield-holder') {
        const { ShieldHolder } = require('./shield_holder')
        brain = new ShieldHolder({ yawSteps: lib.YAW_STEPS, pitchSteps: lib.PITCH_STEPS, idle: IDLE_ACTION })
      } else {
        const { ScriptedOpponent } = require('./ref/opponent')
        brain = new ScriptedOpponent(Number(msg.opponent))
      }
    }
    return { ok: true, id: bot.entity.id }
  },

  async stop () {
    if (plugin) { try { plugin.stop(bot) } catch (err) { log(`stop: ${err.message}`) } }
    fighter.stopEverything()
    for (let t = 0; t < 100 && (bot.health <= 0 || !bot.entity); t++) await bot.waitForTicks(1)
    return { ok: true, health: bot.health }
  },

  async ready (msg) {
    await bot.waitForTicks(4)
    fighter.selectSlot(SLOT_AXE)
    for (let t = 0; t < READY_TICKS; t++) {
      const p = bot.entity.position
      const placed = Math.abs(p.x - msg.x) < 1.2 && Math.abs(p.z - msg.z) < 3 && Math.abs(p.y - CENTER.y) < 1.5
      if (placed && bot.health >= 20 && fighter.shieldCooldown <= 0) return { ok: true }
      await bot.waitForTicks(1)
    }
    return { ok: false, health: bot.health, pos: [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z] }
  },

  async begin (msg) {
    fighter.reset()
    brain?.reset()
    dead = false
    steps = 0
    delay = msg.delay ?? 0
    queue = []
    metrics.begin()
    if (plugin) {
      let target = null
      for (let t = 0; t < 100 && !target; t++) {
        target = bot.players[ENEMY]?.entity
        if (!target) await bot.waitForTicks(1)
      }
      if (!target) throw new Error('the open source bot found no target')
      plugin.start(bot, target)
    }
    return snapshot()
  },

  async step (msg) {
    if (brain) fighter.act(brain.act(fighter.view(CENTER), bot.inventory.slots[OFF_HAND_SLOT]?.name === 'shield'))
    else if (!plugin) {
      queue.push(msg.action)
      const t = queue.length - 1
      fighter.act(t >= delay ? queue[t - delay] : IDLE_ACTION)
    }
    await bot.waitForTicks(TICKS_PER_STEP)
    steps++
    fighter.takeEvents()
    return snapshot()
  },

  async end () {
    if (plugin) { try { plugin.stop(bot) } catch (err) { log(`stop: ${err.message}`) } }
    fighter.endRoundShots?.()
    fighter.stopEverything()
    return { metrics: metrics.end() }
  },

  async close () {
    bot?.quit('closing')
    return { ok: true }
  }
}

function snapshot () {
  // pos only points the watching camera, the runner never passes it to a fighter's brain
  const p = bot.entity.position
  const out = { hp: dead ? 0 : Math.max(0, bot.health), dead: dead || bot.health <= 0, steps, pos: [p.x, p.y, p.z] }
  if (ROLE === 'ref') out.obs = fighter.observe(CENTER, Math.min(1, steps / CLOCK_STEPS))
  if (ROLE === 'new') {
    out.obs = fighter.observe()
    out.mask = fighter.masks().map(Number)
  }
  return out
}

async function main () {
  process.stdin.on('end', () => process.exit(0))
  const rl = readline.createInterface({ input: process.stdin })
  for await (const line of rl) {
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    try {
      send(await handlers[msg.cmd](msg))
    } catch (err) {
      log(err.stack ?? err)
      send({ error: String(err.message ?? err) })
    }
    if (msg.cmd === 'close') break
  }
  setTimeout(() => process.exit(0), 300)
}

main()
