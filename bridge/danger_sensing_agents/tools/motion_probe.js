// How smooth the bot looks on a real server, in numbers. Builds a closed test area high up through RCON, then measures a
// walk up and down a dug staircase, a sprint along a tunnel, a walk around a corner, a goal that moves mid walk, and mining a
// row of ore. Needs the bench server running
// (server-agents/bench.properties, RCON on) with nobody else using the area, and removes what it built afterwards. It
// refuses to run without the bench properties, so it can never build in the owner's own world.
//
//   node bridge/danger_sensing_agents/tools/motion_probe.js                    with the smooth movement
//   node bridge/danger_sensing_agents/tools/motion_probe.js --before           the same scenes without it, to compare
//   node bridge/danger_sensing_agents/tools/motion_probe.js --at 2000 140 2000 --name Agent2 --out runs/motion.json
//
// For each scene it prints: pauses over 0.25 s and 0.5 s (and per minute), replans per minute, the largest camera jump in
// one tick, digs started, finished, canceled and undone by the server, and seconds per block.

const fs = require('fs')
const path = require('path')

const PAUSE_MOVE = 0.01     // blocks in a tick, below this it stands still
const PAUSE_SHORT = 5       // ticks: 0.25 s
const PAUSE_LONG = 10       // ticks: 0.5 s
const TARGETS = { pausesPerMinute: 0, maxCameraStepDeg: 25, digsCanceled: 0, digsUndone: 0 }

const wrapDeg = a => a - 360 * Math.round(a / 360)

// Records one scene from what the bot really sends and receives
class MotionRecorder {
  constructor (bot) {
    this.bot = bot
    this.on = false
    this.reset()
    const client = bot._client
    const write = client.write.bind(client)
    client.write = (name, params) => {
      this.packet(name, params)
      return write(name, params)
    }
    client.on?.('position', () => { if (this.on) this.corrections++ })
    bot.on('path_update', r => { if (this.on && r.status !== 'partial') this.replans++ })
    bot.on('path_reset', why => { if (this.on) this.resets[why] = (this.resets[why] || 0) + 1 })
    bot.on('blockUpdate', (old, now) => this.blockChanged(old, now))
    bot.on('physicsTick', () => this.tick())
  }

  reset () {
    this.ticks = 0
    this.still = 0
    this.moved = false
    this.pausesShort = 0
    this.pausesLong = 0
    this.longest = 0
    this.replans = 0
    this.resets = {}
    this.maxCamera = 0
    this.corrections = 0
    this.digsStarted = 0
    this.digsFinished = 0
    this.digsCanceled = 0
    this.digsUndone = 0
    this.digTimes = []
    this.open = new Map()
    this.finished = new Map()
    this.lastPos = null
  }

  start () {
    this.reset()
    // from where the camera is now, so a snap on the very first packet counts too
    this.lastYaw = ((Math.PI - this.bot.entity.yaw) * 180) / Math.PI
    this.lastPitch = (-this.bot.entity.pitch * 180) / Math.PI
    this.on = true
  }

  stop () {
    this.on = false
    return this.result()
  }

  packet (name, p) {
    if ((name === 'look' || name === 'position_look') && p) {
      if (this.on && this.lastYaw !== undefined) {
        const step = Math.hypot(wrapDeg(p.yaw - this.lastYaw), p.pitch - this.lastPitch)
        if (step > this.maxCamera) this.maxCamera = step
      }
      this.lastYaw = p.yaw
      this.lastPitch = p.pitch
    }
    if (name !== 'block_dig' || !this.on || !p?.location) return
    const key = `${p.location.x},${p.location.y},${p.location.z}`
    if (p.status === 0) {
      this.digsStarted++
      this.open.set(key, Date.now())
    } else if (p.status === 1) {
      this.digsCanceled++
      this.open.delete(key)
    } else if (p.status === 2) {
      this.digsFinished++
      if (this.open.has(key)) this.digTimes.push(Date.now() - this.open.get(key))
      this.open.delete(key)
      this.finished.set(key, Date.now())
    }
  }

  // the server put back a block the bot believed it had broken
  blockChanged (old, now) {
    if (!this.on || !now?.position) return
    const key = `${now.position.x},${now.position.y},${now.position.z}`
    const at = this.finished.get(key)
    if (at === undefined || Date.now() - at > 1500) return
    if (now.type !== 0 && now.name !== 'air' && now.name !== 'cave_air') {
      this.digsUndone++
      this.finished.delete(key)
    }
  }

  tick () {
    if (!this.on) return
    this.ticks++
    const p = this.bot.entity.position
    const moved = this.lastPos ? Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z) + Math.abs(p.y - this.lastPos.y) : 0
    this.lastPos = p.clone()
    // working on a block, eating or using something is not a pause
    if (moved < PAUSE_MOVE && !this.bot.targetDigBlock && !this.bot.usingHeldItem) {
      this.still++
      return
    }
    if (this.moved) {
      if (this.still >= PAUSE_SHORT) this.pausesShort++
      if (this.still >= PAUSE_LONG) this.pausesLong++
      if (this.still > this.longest) this.longest = this.still
    }
    this.moved = true
    this.still = 0
  }

  result () {
    const seconds = this.ticks * 0.05
    const minutes = seconds / 60 || 1 / 60
    const mean = this.digTimes.length ? this.digTimes.reduce((a, b) => a + b, 0) / this.digTimes.length / 1000 : null
    return {
      seconds: +seconds.toFixed(2),
      pauses025: this.pausesShort,
      pauses05: this.pausesLong,
      pausesPerMinute: +(this.pausesShort / minutes).toFixed(1),
      longestPauseS: +(this.longest * 0.05).toFixed(2),
      replans: this.replans,
      replansPerMinute: +(this.replans / minutes).toFixed(1),
      pathResets: this.resets,
      maxCameraStepDeg: +this.maxCamera.toFixed(1),
      serverCorrections: this.corrections,
      digsStarted: this.digsStarted,
      digsFinished: this.digsFinished,
      digsCanceled: this.digsCanceled,
      digsUndone: this.digsUndone,
      secondsPerBlock: mean === null ? null : +mean.toFixed(2)
    }
  }
}

function args (argv) {
  const out = { at: [2000, 140, 2000], name: 'Agent2', before: false, out: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--before') out.before = true
    else if (argv[i] === '--at') { out.at = argv.slice(i + 1, i + 4).map(Number); i += 3 } else if (argv[i] === '--name') out.name = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
    else throw new Error(`unknown option ${argv[i]}`)
  }
  if (out.at.length !== 3 || out.at.some(n => !Number.isInteger(n))) throw new Error('--at takes three whole numbers')
  return out
}

function benchSettings (root) {
  const file = path.join(root, 'server-agents', 'bench.properties')
  if (!fs.existsSync(file)) throw new Error('no server-agents/bench.properties: this probe only runs on the bench world')
  const props = Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
  return { port: parseInt(props['server-port'], 10), rconPort: parseInt(props['rcon.port'], 10), password: props['rcon.password'] }
}

const STAIRS = 20
const TUNNEL = 30
const ORES = 6
const FLOOR = 6             // extra stone under the box: a miner that goes looking must not dig out of the bottom of it

// All inside one stone box, so no mob, light or terrain changes the numbers between runs
function sceneCommands ([x, y, z]) {
  const lines = [
    `fill ${x - 8} ${y - 2} ${z - 2} ${x + 14} ${y + STAIRS + 4} ${z + TUNNEL + 4} minecraft:stone`,
    `fill ${x - 8} ${y - 2 - FLOOR} ${z - 2} ${x + 14} ${y - 3} ${z + TUNNEL + 4} minecraft:stone`
  ]
  const stairs = []
  for (let i = 0; i <= STAIRS; i++) {
    const cell = [x, y + STAIRS - i, z + i]
    stairs.push(cell)
    lines.push(`fill ${cell[0]} ${cell[1]} ${cell[2]} ${cell[0]} ${cell[1] + 2} ${cell[2]} minecraft:air`)
  }
  const tunnel = []
  for (let i = 0; i <= TUNNEL; i++) tunnel.push([x + 4, y, z + i])
  lines.push(`fill ${x + 4} ${y} ${z} ${x + 4} ${y + 1} ${z + TUNNEL} minecraft:air`)
  // a room with a row of iron along its far wall
  const room = { x: x + 10, y, z }
  lines.push(`fill ${room.x - 2} ${y} ${z} ${room.x + 3} ${y + 2} ${z + 9} minecraft:air`)
  const ores = []
  for (let i = 0; i < ORES; i++) {
    const ore = [room.x - 2 + i, y + (i % 2), z + 10]
    ores.push(ore)
    lines.push(`setblock ${ore[0]} ${ore[1]} ${ore[2]} minecraft:iron_ore`)
  }
  // a corridor three wide with a right angle in it, for how a walk takes a corner
  lines.push(`fill ${x + 9} ${y} ${z + 13} ${x + 11} ${y + 1} ${z + 24} minecraft:air`)
  lines.push(`fill ${x + 9} ${y} ${z + 22} ${x + 13} ${y + 1} ${z + 24} minecraft:air`)
  const corner = { from: [x + 10, y, z + 14], to: [x + 13, y, z + 23] }
  return { lines, stairs, tunnel, room, ores, corner, clear: `fill ${x - 8} ${y - 2 - FLOOR} ${z - 2} ${x + 14} ${y + STAIRS + 4} ${z + TUNNEL + 4} minecraft:air` }
}

async function main () {
  const opt = args(process.argv.slice(2))
  const { Vec3 } = require('vec3')
  const mineflayer = require('mineflayer')
  const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
  require('../../patch-physics')
  const { Rcon } = require('../../rcon')
  const { applyMineflayerFixes } = require('../../mineflayer_fixes')
  const { installMotion, walkCells } = require('../skills/motion')
  const { goTo, guardHazards } = require('../skills/move')
  const { mineJob } = require('../skills/mine')
  const { Human } = require('../skills/human')
  const CONFIG = require('../config').loadConfig({ ownerRequired: false })
  const root = path.join(__dirname, '..', '..', '..')
  const { port, rconPort, password } = benchSettings(root)
  const rcon = new Rcon(CONFIG.host, rconPort, password)
  await rcon.connect()
  const say = (...a) => console.log(`[probe ${new Date().toTimeString().slice(0, 8)}]`, ...a)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  const [x, y, z] = opt.at
  const scene = sceneCommands(opt.at)
  const area = `${x - 8} ${z - 2} ${x + 14} ${z + TUNNEL + 4}`
  const difficulty = (await rcon.send('difficulty')).match(/difficulty is (\w+)/i)?.[1]?.toLowerCase()
  await rcon.send(`forceload add ${area}`)
  await rcon.send('difficulty peaceful')
  for (const line of scene.lines) await rcon.send(line)

  const bot = mineflayer.createBot({ host: CONFIG.host, port, username: opt.name, version: CONFIG.version, auth: 'offline' })
  bot.setMaxListeners(50)
  bot.loadPlugin(pathfinder)
  await new Promise((resolve, reject) => { bot.once('spawn', resolve); bot.once('error', reject); bot.once('kicked', r => reject(new Error(`kicked: ${JSON.stringify(r)}`))) })

  // --before keeps the older dig times and movement, with the fixes that only make the protocol work
  const material = bot.registry.materials.incorrect_for_wooden_tool
  const older = { ...material }
  applyMineflayerFixes(bot)
  // before installMotion, so it records the camera that really goes out, including a camera turning ahead of the body
  const rec = new MotionRecorder(bot)
  if (opt.before) {
    for (const id of Object.keys(material)) delete material[id]
    Object.assign(material, older)
  } else installMotion(bot)
  const walk = new Movements(bot)
  walk.canDig = false
  walk.scafoldingBlocks = []
  guardHazards(bot, walk)
  const dig = new Movements(bot)
  dig.canDig = true
  dig.liquidCost = 50
  dig.maxDropDown = 3
  guardHazards(bot, dig)

  const place = async (cell, yaw = 0) => {
    await rcon.send(`tp ${opt.name} ${cell[0] + 0.5} ${cell[1]} ${cell[2] + 0.5} ${yaw} 0`)
    await sleep(600)
    await bot.waitForChunksToLoad?.()
    for (let i = 0; i < 40 && !bot.entity.onGround; i++) await bot.waitForTicks(1)
    await bot.waitForTicks(6)
  }
  const cellsOf = list => list.map(c => new Vec3(c[0], c[1], c[2]))
  const goalOf = c => new goals.GoalBlock(c[0], c[1], c[2])
  const results = {}
  const run = async (name, fn) => {
    rec.start()
    const statsBefore = { ...bot.motion?.stats }
    let error = null
    try { await fn() } catch (err) { error = err.message }
    results[name] = { ...rec.stop(), error }
    if (bot.motion) {
      for (const k of ['cornersRounded', 'coastTicks', 'pathsReused', 'pathsExtended']) results[name][k] = bot.motion.stats[k] - (statsBefore[k] || 0)
    }
    say(name, JSON.stringify(results[name]))
  }

  try {
    await rcon.send(`gamemode survival ${opt.name}`)
    await rcon.send(`clear ${opt.name}`)
    await rcon.send(`effect give ${opt.name} minecraft:saturation 600 1 true`)
    await rcon.send(`give ${opt.name} minecraft:stone_pickaxe 1`)
    await rcon.send(`give ${opt.name} minecraft:oak_planks 4`)
    await sleep(600)

    bot.pathfinder.setMovements(walk)
    const top = scene.stairs[0]
    const bottom = scene.stairs[STAIRS]
    await place(bottom)
    await run('stairs up, pathfinder', () => goTo(bot, goalOf(top), null, 40000))
    await place(top)
    await run('stairs down, pathfinder', () => goTo(bot, goalOf(bottom), null, 40000))
    if (!opt.before) {
      await place(bottom)
      await run('stairs up, own path', () => walkCells(bot, cellsOf(scene.stairs).reverse(), null))
      await place(top)
      await run('stairs down, own path', () => walkCells(bot, cellsOf(scene.stairs), null))
    }
    await place(scene.tunnel[0], 180)
    await run('tunnel sprint', () => goTo(bot, goalOf(scene.tunnel[TUNNEL]), null, 30000))
    await place(scene.corner.from, 180)
    await run('walk around a corner', () => goTo(bot, goalOf(scene.corner.to), null, 20000))
    await place(scene.tunnel[0], 180)
    await run('goal moves mid walk', async () => {
      const first = goTo(bot, goalOf(scene.tunnel[TUNNEL - 2]), null, 30000).catch(() => {})
      await bot.waitForTicks(30)
      await goTo(bot, goalOf(scene.tunnel[TUNNEL]), null, 30000)
      await first
    })

    bot.pathfinder.setMovements(dig)
    await place([scene.room.x, scene.room.y, scene.room.z + 1], 180)
    const job = { block: 'iron', blocks: ['iron_ore'], count: ORES, mined: 0, strategy: 'branch', home: null, store: false, tuning: { branchLen: 0 } }
    await run('mining a row of ore', async () => {
      const r = await mineJob(bot, job, new Human(bot, CONFIG.human || 'light'), { cancelled: false }, { log: t => say(t) })
      if (r.result !== 'done') throw new Error(`mining ended with ${r.result}: ${r.message || ''}`)
    })
    // what the server says, not what the bot believes
    let broken = 0
    // gone means no longer ore: a hole the bot later filled with a block of its own still counts as mined
    for (const o of scene.ores) if (/passed/i.test(await rcon.send(`execute unless block ${o[0]} ${o[1]} ${o[2]} minecraft:iron_ore`))) broken++
    const bag = await rcon.send(`clear ${opt.name} minecraft:raw_iron 0`)
    results['mining a row of ore'].oreGoneOnServer = `${broken} of ${ORES}`
    // "Found 5 matching items on player Agent1", or "No items were found on player Agent1", whose name has a digit in it
    results['mining a row of ore'].rawIronInBag = Number(bag.match(/Found (\d+)/i)?.[1] ?? 0)
  } finally {
    bot.quit()
    await sleep(500)
    await rcon.send(scene.clear)
    await rcon.send(`forceload remove ${area}`)
    if (difficulty) await rcon.send(`difficulty ${difficulty}`)
    rcon.close?.()
  }

  const misses = []
  for (const [name, r] of Object.entries(results)) {
    if (r.error) misses.push(`${name}: ${r.error}`)
    if (r.pausesPerMinute > TARGETS.pausesPerMinute) misses.push(`${name}: ${r.pauses025} pauses over 0.25 s`)
    if (r.maxCameraStepDeg > TARGETS.maxCameraStepDeg) misses.push(`${name}: camera moved ${r.maxCameraStepDeg} degrees in a tick`)
    if (r.digsCanceled > TARGETS.digsCanceled) misses.push(`${name}: ${r.digsCanceled} digs canceled`)
    if (r.digsUndone > TARGETS.digsUndone) misses.push(`${name}: the server undid ${r.digsUndone} digs`)
  }
  const report = { mode: opt.before ? 'before' : 'after', targets: TARGETS, results, misses }
  const out = opt.out || path.join(root, 'runs', `motion-probe-${report.mode}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  say(misses.length ? `missed: ${misses.join('; ')}` : 'every target met')
  say(`saved ${out}`)
  process.exit(0)
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[probe] ${err.stack || err.message}`)
    process.exit(1)
  })
}

module.exports = { MotionRecorder, sceneCommands, args, TARGETS }
