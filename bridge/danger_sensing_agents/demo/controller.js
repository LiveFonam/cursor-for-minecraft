// Runs the demo: one state at a time (idle, run, duel or evil), every order from the one demo player.

const { parseDemoCommand, HELP_LINES } = require('./words')
const scene = require('./scene')

const PURGE_MS = 4000
const CAMERA_MS = 3000
const DUEL_POLL_MS = 1000
const DUEL_READY_MS = 90000
const DUEL_COUNTDOWN_MS = 3000
const BACKSTOP_DIRECTOR_MS = 40000
const BACKSTOP_SCRIPT_MS = 3000
const BLAST_WAIT_MS = 2000        // a lit creeper goes off in 1.5 seconds
const LOAD_TRIES = 10
const LOAD_WAIT_MS = 500
const HANDOVER_TRIES = 12
const HANDOVER_WAIT_MS = 500

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const REAL_TIMERS = { setInterval, clearInterval, setTimeout, clearTimeout, now: () => Date.now() }

class DemoController {
  // agents: agentBot(), stopAgent(), runTask(text), dummyHas(item). spawnDuel(options) gives an emitter of 'ready' and
  // 'exit' with go() and stop()
  constructor ({ settings, rcon, agents, spawnDuel, log = () => {}, sleep = defaultSleep, timers = REAL_TIMERS, hostile }) {
    this.s = settings
    this.rcon = rcon
    this.agents = agents
    this.spawnDuel = spawnDuel
    this.log = log
    this.sleep = sleep
    this.timers = timers
    this.hostile = hostile || scene.hostileToRemove(settings.version)
    this.stage = settings.stage
    this.state = 'idle'
    this.queue = Promise.resolve()
    this.purgeTimer = null
    this.cameraTimer = null
    this.cues = []
    this.evilTimer = null
    this.duelRun = null
    this.taskItem = null
    this.baseBuilt = false
    this.purging = false
    this.directed = false
  }

  async send (command) {
    try {
      return String(await this.rcon.send(command))
    } catch (err) {
      this.log(`console: ${command.split(' ')[0]} failed: ${err.message}`)
      return ''
    }
  }

  async sendAll (commands) {
    for (const c of commands) await this.send(c)
  }

  async sendLoaded (command) {
    for (let i = 0; i < LOAD_TRIES; i++) {
      const reply = await this.send(command)
      if (!/not loaded/i.test(reply)) return reply
      await this.sleep(LOAD_WAIT_MS)
    }
    throw new Error('the arena did not load')
  }

  tell (text) {
    return this.send(`tellraw ${this.s.player} ${JSON.stringify(String(text))}`)
  }

  enqueue (job) {
    const next = this.queue.then(job).catch(async err => {
      this.log(`demo: ${err.stack || err.message}`)
      await this.tell(`Demo problem: ${err.message}`)
    })
    this.queue = next
    return next
  }

  async begin (stage) {
    if (!this.stage) this.stage = stage
    await this.sendAll(scene.WORLD_RULES)
    this.purgeTimer = this.timers.setInterval(() => { this.purge().catch(() => {}) }, PURGE_MS)
    await this.enqueue(() => this.reset())
  }

  close () {
    if (this.purgeTimer) this.timers.clearInterval(this.purgeTimer)
    this.purgeTimer = null
    this.clearRun()
    this.clearEvilTimer()
    if (this.duelRun) {
      this.timers.clearInterval(this.duelRun.timer)
      this.duelRun.child.stop()
      this.duelRun = null
    }
  }

  async purge () {
    if (this.purging) return
    this.purging = true
    try {
      await this.sendAll(scene.purgeCommands(this.hostile))
    } finally {
      this.purging = false
    }
  }

  // true when the line was the demo's to handle, false when the agents should read it
  async handle (text, sender) {
    if (!sameName(sender, this.s.player)) return true
    const c = parseDemoCommand(text)
    if (c?.error) {
      await this.tell(c.error)
      return true
    }
    if (c) {
      if (c.name === 'stop' && this.duelRun) {
        this.duelRun.stopped = true
        this.duelRun.child.stop()
      }
      await this.enqueue(() => this.dispatch(c))
      return true
    }
    if (String(text).trim().startsWith('!')) return false
    if (this.state !== 'idle') {
      await this.tell(`Busy with the ${this.state}. Type !stop first.`)
      return true
    }
    await this.enqueue(() => this.agents.runTask(text))
    return true
  }

  dispatch (c) {
    switch (c.name) {
      case 'help': return this.help()
      case 'reset': return this.reset()
      case 'stop': return this.stop()
      case 'duel': return this.duel()
      case 'evil': return this.evil()
      case 'mob':
      case 'animal': return this.force(c.kind)
    }
  }

  async help () {
    for (const line of HELP_LINES) await this.tell(line)
  }

  clearRun () {
    if (this.cameraTimer) this.timers.clearInterval(this.cameraTimer)
    this.cameraTimer = null
    for (const t of this.cues) this.timers.clearTimeout(t)
    this.cues = []
    this.taskItem = null
  }

  clearEvilTimer () {
    if (this.evilTimer) this.timers.clearTimeout(this.evilTimer)
    this.evilTimer = null
  }

  // Ends whatever is running. The state goes first, so the agent's job ending is not read as a finished task
  async quiet () {
    const was = this.state
    this.state = 'idle'
    this.clearRun()
    this.clearEvilTimer()
    if (this.duelRun) await this.endDuel('stopped')
    if (was === 'evil') {
      await this.send('director stop')
      await this.send(`kill @e[tag=${scene.TAG_EVIL}]`)
    }
    await this.agents.stopAgent()
  }

  async reset () {
    await this.quiet()
    await this.sendAll(scene.resetCommands(this.s, this.stage, { baseBuilt: this.baseBuilt }))
    this.baseBuilt = false
    await this.tell('Scene ready. Say a task, or !help.')
  }

  async stop () {
    await this.quiet()
    const p = scene.spots(this.stage).player
    await this.send(`gamemode creative ${this.s.player}`)
    await this.send(`tp ${this.s.player} ${p.x + 0.5} ${p.y} ${p.z + 0.5}`)
    await this.tell('Stopped.')
  }

  // The agent began a task: he watches it from its point of view
  async taskStarted (item = null) {
    if (this.state !== 'idle') return
    this.state = 'run'
    this.taskItem = item
    await this.send(`gamemode spectator ${this.s.player}`)
    await this.follow()
    this.cameraTimer = this.timers.setInterval(() => { this.follow().catch(() => {}) }, CAMERA_MS)
    const cue = (seconds, kind) => {
      if (seconds > 0) this.cues.push(this.timers.setTimeout(() => { this.cue(kind).catch(() => {}) }, seconds * 1000))
    }
    cue(this.s.cueMobSeconds, 'zombie')
    cue(this.s.cueAnimalSeconds, 'cow')
  }

  async follow () {
    if (this.state !== 'run') return
    const bot = this.agents.agentBot()
    if (!bot?.entity || bot.health <= 0) return
    await this.send(`spectate ${this.s.agent} ${this.s.player}`)
  }

  // A new life is a new entity, and the camera has to be pointed at it again
  agentSpawned () {
    return this.follow()
  }

  cue (kind) {
    if (this.state !== 'run') return Promise.resolve()
    return this.force(kind)
  }

  async taskEnded (result) {
    if (this.state !== 'run') return
    const item = this.taskItem
    this.clearRun()
    this.state = 'idle'
    let gave = false
    if (item && result === 'done') {
      for (let i = 0; i < HANDOVER_TRIES && !gave; i++) {
        gave = await this.agents.dummyHas(item)
        if (!gave) await this.sleep(HANDOVER_WAIT_MS)
      }
    }
    const p = scene.spots(this.stage).player
    await this.send(`gamemode creative ${this.s.player}`)
    await this.send(`tp ${this.s.player} ${p.x + 0.5} ${p.y} ${p.z + 0.5} -90 0`)
    const what = item ? item.replace(/_/g, ' ') : 'task'
    if (gave) await this.tell(`Done: ${this.s.dummy} has the ${what}.`)
    else if (item && result === 'done') await this.tell(`The agent finished, but ${this.s.dummy} did not pick up the ${what}.`)
    else await this.tell(`The ${what} ended: ${result}.`)
  }

  async force (kind) {
    const bot = this.agents.agentBot()
    if (!bot?.entity) {
      await this.tell('The agent is not in the world right now.')
      return
    }
    const { Vec3 } = require('vec3')
    const spot = scene.openSpot((x, y, z) => bot.blockAt(new Vec3(x, y, z)), bot.entity.position)
    if (!spot) {
      await this.tell(`No open ground by the agent for a ${kind}.`)
      return
    }
    await this.sendAll(scene.forcedCommands(kind, spot))
    await this.tell(`A ${kind} is by the agent.`)
  }

  async evil () {
    await this.quiet()
    this.state = 'evil'
    const b = scene.baseOf(this.stage)
    const P = this.s.player
    await this.sendAll(scene.GRIEF_RULES)
    this.baseBuilt = true
    await this.sendAll(scene.baseCommands(this.stage))
    await this.sendAll([`gamemode survival ${P}`, `tp ${P} ${b.x + 0.5} ${b.y} ${b.z + 0.5}`,
      `effect give ${P} instant_health 1 3 true`, `effect give ${P} saturation 1 20 true`])
    await this.sendAll(scene.creeperCommands(this.stage))
    const directed = /^director:/i.test((await this.send('director status')).trim())
    this.directed = directed
    if (directed) {
      await this.sendAll(scene.zombieCommands(this.stage))
      await this.send(`director start ${P}`)
    }
    this.log(directed ? 'evil: the director has the mobs' : 'evil: no director on this server, using the scripted breach')
    this.evilTimer = this.timers.setTimeout(() => this.backstop().catch(() => {}),
      directed ? BACKSTOP_DIRECTOR_MS : BACKSTOP_SCRIPT_MS)
    await this.tell('The evil god has noticed your base. !reset when it is over.')
  }

  // The creeper is still walking around: it goes off at the wall now
  async backstop () {
    this.evilTimer = null
    if (this.state !== 'evil') return
    const alive = await this.send(`execute if entity @e[tag=${scene.TAG_EVIL_CREEPER}]`)
    if (/passed/i.test(alive)) await this.sendAll(scene.igniteCommands(this.stage))
    if (this.directed) return
    await this.sleep(BLAST_WAIT_MS)
    if (this.state === 'evil') await this.sendAll(scene.zombieCommands(this.stage))
  }

  deaths (name) {
    return this.send(`scoreboard players get ${name} ${scene.DEATHS}`).then(scene.parseScore)
  }

  async ruleValue (rule) {
    const m = (await this.send(`gamerule ${rule}`)).match(/(true|false)\s*$/i)
    return m ? m[1].toLowerCase() : null
  }

  async duel () {
    await this.quiet()
    this.state = 'duel'
    const { player: P, fighterName: F } = this.s
    const spots = scene.duelSpots(this.stage)
    const arena = scene.arenaOf(this.stage)
    const chunks = scene.arenaChunks(this.stage)
    const regen = await this.ruleValue('natural_health_regeneration')
    await this.send(`forceload add ${chunks}`)
    for (const c of scene.arenaCommands(this.stage)) await this.sendLoaded(c)
    await this.send(`scoreboard objectives add ${scene.DEATHS} deathCount`)
    await this.send(`whitelist add ${F}`)
    await this.send('gamerule pvp true')
    await this.send('gamerule natural_health_regeneration false')
    const child = this.spawnDuel({
      name: F,
      enemy: P,
      host: this.s.host,
      port: this.s.port,
      version: this.s.version,
      arena,
      client: this.s.fighterClient,
      policy: this.s.policyScript,
      run: this.s.fighterRun,
      python: this.s.python,
      sourceRoot: this.s.sourceRoot
    })
    const run = { child, chunks, regen, timer: null, p: 0, f: 0, deadline: 0, polling: false }
    this.duelRun = run
    child.once('exit', () => {
      if (this.duelRun === run) this.enqueue(() => this.finishDuel(run, 'crashed'))
    })
    await this.tell('Loading the fighter...')
    const ready = await new Promise(resolve => {
      const timer = this.timers.setTimeout(() => resolve(false), DUEL_READY_MS)
      child.once('ready', () => { this.timers.clearTimeout(timer); resolve(true) })
      child.once('exit', () => { this.timers.clearTimeout(timer); resolve(false) })
    })
    if (this.duelRun !== run) return
    if (!ready) {
      await this.finishDuel(run, 'crashed')
      return
    }
    await this.sendAll(scene.fighterKitCommands(P, spots.player, spots.player.yaw))
    await this.sendAll(scene.fighterKitCommands(F, spots.fighter, spots.fighter.yaw))
    run.p = await this.deaths(P)
    run.f = await this.deaths(F)
    await this.tell('Fight in 3 seconds!')
    await this.sleep(DUEL_COUNTDOWN_MS)
    if (this.duelRun !== run) return
    child.go()
    run.deadline = this.timers.now() + this.s.fightSeconds * 1000
    run.timer = this.timers.setInterval(() => {
      if (run.polling || this.duelRun !== run) return
      run.polling = true
      this.duelTick(run).catch(() => {}).finally(() => { run.polling = false })
    }, DUEL_POLL_MS)
  }

  async duelTick (run) {
    const [p, f] = [await this.deaths(this.s.player), await this.deaths(this.s.fighterName)]
    if (this.duelRun !== run) return
    if (p > run.p) await this.enqueue(() => this.finishDuel(run, 'fighter'))
    else if (f > run.f) await this.enqueue(() => this.finishDuel(run, 'player'))
    else if (this.timers.now() >= run.deadline) await this.enqueue(() => this.finishDuel(run, 'time'))
  }

  async finishDuel (run, outcome) {
    if (this.duelRun !== run) return
    await this.endDuel(run.stopped ? 'stopped' : outcome)
    if (this.state === 'duel') this.state = 'idle'
  }

  async endDuel (outcome) {
    const run = this.duelRun
    if (!run) return
    this.duelRun = null
    if (run.timer) this.timers.clearInterval(run.timer)
    run.child.stop()
    const { player: P, fighterName: F } = this.s
    const a = scene.arenaOf(this.stage)
    if (run.regen) await this.send(`gamerule natural_health_regeneration ${run.regen}`)
    await this.send(`kill @e[type=minecraft:item,x=${a.x},y=${a.y},z=${a.z},distance=..30]`)
    await this.send(`kill @e[type=minecraft:arrow,x=${a.x},y=${a.y},z=${a.z},distance=..30]`)
    await this.send(`forceload remove ${run.chunks}`)
    await this.send(`whitelist remove ${F}`)
    const p = scene.spots(this.stage).player
    await this.sendAll([`clear ${P}`, `effect clear ${P}`, `effect give ${P} instant_health 1 3 true`, `gamemode creative ${P}`,
      `tp ${P} ${p.x + 0.5} ${p.y} ${p.z + 0.5} -90 0`])
    const words = {
      fighter: 'The fighter won.',
      player: 'You beat the fighter!',
      time: 'Time is up, a draw.',
      crashed: 'The fighter could not run, so the fight is off.',
      stopped: 'Fight stopped.'
    }
    await this.tell(words[outcome])
  }
}

module.exports = { DemoController }
