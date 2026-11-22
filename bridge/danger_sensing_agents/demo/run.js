// The live demo: one agent, the player in their own base, and the chat commands in words.js.
//
//   DEMO_PLAYER=<name> node bridge/danger_sensing_agents/demo/run.js
//
// The server must already be running with RCON on. See settings.js for the other settings.

const fs = require('fs')
const { Vec3 } = require('vec3')
const path = require('path')
const { Agents } = require('../agents')
const { parseChatLine, parseMessage } = require('../commands')
const { loadSettings, missingFighterFiles, hasNetwork } = require('./settings')
const { DemoController } = require('./controller')
const { EvilBrain } = require('./evil_brain')
const { spawnDuel } = require('./duel')
const scene = require('./scene')
const { contents, withdraw } = require('../skills/storage')
const { walkHome, runAsWalk } = require('./walk_home')
const { passDoor, sideOf, doorGate, keepDoorWhole } = require('./door')

const log = (...a) => console.error('[demo]', ...a)
const GOAL_COMMANDS = new Set(['craft', 'get'])
const SEE_TRIES = 20
const LEAVE_MS = 45000
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

class DemoAgents extends Agents {
  constructor (opts, settings) {
    super(opts)
    this.demo = settings
    this.controller = null
    this.seeWaitMs = 250
    this.taskDepth = 0
    this.taskEpoch = 0
    this.taskResult = null
    this.friends.add(settings.fighterName)
  }

  // the scene's kit is the kit: the agent is not topped up with armor before a fight
  async ensureKit () {}

  setupBot (bot) {
    super.setupBot(bot)
    bot.on('spawn', () => { this.controller?.agentSpawned().catch(() => {}) })
    // only during a task: in a fight at the base or between tasks the door is left alone
    bot.agentsBeforeWalk = doorGate({ bot, agents: this }, () => this.controller?.state === 'run' ? this.controller.stage : null)
    keepDoorWhole(bot, () => this.controller?.stage)
  }

  // Only the demo player drives the demo
  async handleChat (bot, text) {
    const line = parseChatLine(text)
    if (!line || line.sender === bot.username || !this.controller) return
    if (line.sender.toLowerCase() !== this.demo.player.toLowerCase()) return
    const handled = await this.controller.handle(line.message, line.sender)
    if (!handled) await this.onOwnerMessage(line.message, line.sender)
  }

  // A goal or a plan, however deep, counts as one task from its first step to its last
  async tracked (item, work, count = 1, ctx = null) {
    const epoch = this.taskEpoch
    const first = this.taskDepth++ === 0
    if (first) {
      this.taskResult = null
      await this.controller?.taskStarted(item, count)
    }
    let result = 'error'
    try {
      if (first && ctx) await this.leaveBase(ctx, epoch)
      if (epoch !== this.taskEpoch) return (result = 'stopped')
      result = await work()
      return result
    } finally {
      if (epoch === this.taskEpoch) {
        this.taskResult = result
        if (--this.taskDepth === 0) this.controller?.taskEnded(this.taskResult).catch(err => log(err.message))
      }
    }
  }

  runGoal (ctx, args, requester) {
    // whatever asked for it, the finished item goes to the player
    const p = this.demo.player
    return this.tracked(args.item, () => super.runGoal(ctx, { ...args, requester: p }, p), args.count ?? 1, ctx)
  }

  // He is a spectator during a task and cannot drop anything, so the plan never waits on his bag. Chests still count
  goalSources (ctx, forOwner, ownerBag, useChests) {
    return super.goalSources(ctx, forOwner, null, useChests)
  }

  // The walk to the player goes to the base instead, since he may have flown anywhere and the agent cannot see a spectator
  execute (ctx, command) {
    if (command.name === 'walk' && this.controller && sameName(command.args?.to, this.demo.player)) return this.walkHome(ctx, command)
    return super.execute(ctx, command)
  }

  // Back at the base, the player is brought to his spot, and the hand step starts once the agent can see him
  async walkHome (ctx, command) {
    const stage = this.controller.stage
    const r = await this.walkToBase(ctx, scene.spots(stage).hand, token => passDoor(ctx, stage, 'in', token))
    if (r === 'shut') {
      this.say(ctx.bot, `I can't get through the door, ${command.args.to}`)
      return 'far'
    }
    if (r === 'far') this.say(ctx.bot, `I can't get back to you, ${command.args.to}`)
    if (r !== 'done') return r
    if (!await this.controller.playerHome()) return 'stopped'
    const home = scene.spots(this.controller.stage).player
    for (let i = 0; i < SEE_TRIES; i++) {
      // near his spot, because the last sighting from before he was a spectator can still be on the list
      const seen = ctx.bot.players?.[this.demo.player]?.entity?.position
      if (seen && Math.hypot(seen.x - home.x - 0.5, seen.z - home.z - 0.5) <= 2) return 'done'
      await new Promise(resolve => setTimeout(resolve, this.seeWaitMs))
    }
    return 'far'
  }

  walkToBase (ctx, at, door = null) {
    return walkHome(ctx, at, door)
  }

  // A task starts with the agent going out through the door, with what the base chest holds, since the job's own paths
  // cannot cross it. Never holds the task up: whatever happens here, the job then runs
  async leaveBase (ctx, epoch) {
    const stage = this.controller?.stage
    if (!stage || this.controller.state !== 'run' || !ctx.manager || !ctx.bot?.blockAt || !ctx.bot.entity) return
    if (sideOf(stage, ctx.bot.entity.position) !== 'in') return
    const lower = scene.baseLayout(stage).door.lower
    if (ctx.bot.blockAt(new Vec3(lower.x, lower.y, lower.z))?.name !== 'iron_door') return
    const out = async token => {
      await this.takeBaseChest(ctx, stage, token)
      return token.cancelled ? 'cancelled' : passDoor(ctx, stage, 'out', token)
    }
    let timer
    const limit = new Promise(resolve => { timer = setTimeout(() => resolve('late'), LEAVE_MS) })
    try {
      const r = await Promise.race([runAsWalk(ctx, out), limit])
      if (r === 'late') ctx.manager.setOff('demohome', 'late')
      if (r !== 'done' && epoch === this.taskEpoch) log(`${ctx.bot.username} did not get out through the door: ${r}`)
    } catch (err) {
      log(`${ctx.bot.username} leaving the base: ${err.message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  async takeBaseChest (ctx, stage, token) {
    const pos = new Vec3(...Object.values(scene.baseLayout(stage).chest))
    try {
      ctx.bot.pathfinder.setMovements(this.noDigMoves(ctx.bot))
      const held = await contents(ctx.bot, pos, token)
      if (held.size && !token.cancelled) await withdraw(ctx.bot, pos, held, token)
    } catch (err) {
      log(`${ctx.bot.username} base chest: ${err.message}`)
    }
  }

  // What the agent remembers of a chest is out of date once the scene has refilled or emptied it
  forgetChest (pos) {
    this.agentBot()?.agentsChests?.forget(pos)
  }

  runPlan (ctx, commands, options) {
    // a walk back to him needs no trip out through the door first
    const home = commands.every(c => c.name === 'walk' && sameName(c.args?.to, this.demo.player))
    return this.tracked(null, () => super.runPlan(ctx, commands, options), 1, home ? null : ctx)
  }

  // A task in plain words, made for the player
  async runTask (text) {
    const line = `@agents ${text}`
    const p = parseMessage(line, this.names, { viaTranslator: !!this.translator?.enabled })
    const ctx = this.ctxs.get(this.demo.agent)
    if (p?.type === 'command' && ctx) {
      if (GOAL_COMMANDS.has(p.command.name)) {
        ctx.seq++
        this.execute(ctx, { name: 'get', args: { ...p.command.args, count: p.command.args.count ?? 1, requester: this.demo.player } })
      } else {
        this.runPlan(ctx, [p.command], { labels: [p.command.name] }).catch(err => log(err.message))
      }
      return
    }
    await this.onOwnerMessage(line, this.demo.player)
  }

  agentBot () {
    return this.ctxs.get(this.demo.agent)?.bot || null
  }

  // Between tasks the agent stays in the base instead of wandering off for food. The next task clears this
  holdAtBase () {
    const ctx = this.ctxs.get(this.demo.agent)
    if (ctx) ctx.staying = true
  }

  async stopAgent () {
    this.taskEpoch++
    this.taskDepth = 0
    await this.onOwnerMessage('!stop', this.demo.player)
  }

  close () {
    this.controller?.close()
    super.close()
  }
}

async function main () {
  const settings = loadSettings()
  fs.mkdirSync(path.dirname(settings.metrics), { recursive: true })
  const agents = new DemoAgents({
    names: [settings.agent],
    run: settings.agentRun,
    translator: true,
    owner: settings.player,
    metrics: settings.metrics,
    miner: 'branch'
  }, settings)
  const shutdown = () => {
    log('closing')
    agents.close()
    setTimeout(() => process.exit(0), 1500)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await agents.start()
  if (!agents.rcon) throw new Error('The demo needs RCON on the server')
  await agents.rcon.send(`whitelist add ${settings.player}`)
  const missing = missingFighterFiles(settings)
  if (missing.length) log(`!1v1 will not work, missing: ${missing.join(', ')}`)
  if (!hasNetwork(settings.agentRun)) log(`the agent cannot fight mobs, no network in ${settings.agentRun}. Set DEMO_AGENT_RUN`)
  const bot = agents.agentBot()
  if (!bot?.entity) throw new Error('The agent did not join')
  const p = bot.entity.position.floored()
  const brain = new EvilBrain({ log })
  log(brain.enabled ? 'evil god: the model picks the plan, the script runs it' : 'evil god: no API key, using the scripted plan')
  agents.controller = new DemoController({ settings, rcon: agents.rcon, agents, spawnDuel, log, brain })
  await agents.controller.begin({ x: p.x, y: p.y, z: p.z })
  log(`demo ready for ${settings.player}. Type !help in chat.`)
}

if (require.main === module) {
  main().catch(err => {
    log(err.stack || err.message)
    process.exit(1)
  })
}

module.exports = { DemoAgents }
