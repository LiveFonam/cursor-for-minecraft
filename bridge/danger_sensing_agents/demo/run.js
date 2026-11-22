// The live demo: one agent, a dummy who stands in for the player, and the chat commands in words.js.
//
//   DEMO_PLAYER=<name> node bridge/danger_sensing_agents/demo/run.js
//
// The server must already be running with RCON on. See settings.js for the other settings.

const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { Agents } = require('../agents')
const { parseChatLine, parseMessage } = require('../commands')
const { loadSettings, missingFighterFiles, hasNetwork } = require('./settings')
const { DemoController } = require('./controller')
const { spawnDuel } = require('./duel')

const log = (...a) => console.error('[demo]', ...a)
const GOAL_COMMANDS = new Set(['craft', 'get'])
const DUMMY_REJOIN_MS = 5000

class DemoAgents extends Agents {
  constructor (opts, settings) {
    super(opts)
    this.demo = settings
    this.controller = null
    this.dummyBot = null
    this.taskDepth = 0
    this.taskEpoch = 0
    this.taskResult = null
    this.friends.add(settings.dummy)
    this.friends.add(settings.fighterName)
  }

  // the scene's kit is the kit: the agent is not topped up with armor before a fight
  async ensureKit () {}

  setupBot (bot) {
    super.setupBot(bot)
    bot.on('spawn', () => { this.controller?.agentSpawned().catch(() => {}) })
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
  async tracked (item, work) {
    const epoch = this.taskEpoch
    if (this.taskDepth++ === 0) {
      this.taskResult = null
      await this.controller?.taskStarted(item)
    }
    let result = 'error'
    try {
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
    // whatever asked for it, the finished item goes to the dummy
    return this.tracked(args.item, () => super.runGoal(ctx, { ...args, requester: this.demo.dummy }, this.demo.dummy))
  }

  runPlan (ctx, commands, options) {
    return this.tracked(null, () => super.runPlan(ctx, commands, options))
  }

  // A task in plain words, made for the dummy
  async runTask (text) {
    const line = `@agents ${text}`
    const p = parseMessage(line, this.names)
    const ctx = this.ctxs.get(this.demo.agent)
    if (p?.type === 'command' && ctx) {
      if (GOAL_COMMANDS.has(p.command.name)) {
        ctx.seq++
        this.execute(ctx, { name: 'get', args: { ...p.command.args, count: p.command.args.count ?? 1, requester: this.demo.dummy } })
      } else {
        this.runPlan(ctx, [p.command], { labels: [p.command.name] }).catch(err => log(err.message))
      }
      return
    }
    await this.onOwnerMessage(line, this.demo.dummy)
  }

  agentBot () {
    return this.ctxs.get(this.demo.agent)?.bot || null
  }

  async stopAgent () {
    this.taskEpoch++
    this.taskDepth = 0
    await this.onOwnerMessage('!stop', this.demo.player)
  }

  async dummyHas (item) {
    const held = this.dummyBot?.inventory.items().find(i => i.name === item)
    if (!held) return false
    try { await this.dummyBot.equip(held, 'hand') } catch {}
    return true
  }

  connectDummy () {
    return new Promise((resolve, reject) => {
      const bot = mineflayer.createBot({
        host: this.demo.host,
        port: this.demo.port,
        username: this.demo.dummy,
        version: this.demo.version,
        auth: 'offline'
      })
      let joined = false
      bot.once('spawn', () => {
        joined = true
        this.dummyBot = bot
        resolve(bot)
      })
      bot.on('kicked', r => log(`the dummy was kicked: ${JSON.stringify(r).slice(0, 160)}`))
      bot.on('error', err => {
        log(`dummy: ${err.message}`)
        if (!joined) reject(err)
      })
      bot.on('end', () => {
        if (!joined) reject(new Error('the dummy could not join'))
        else if (!this.closing) setTimeout(() => this.connectDummy().catch(err => log(err.message)), DUMMY_REJOIN_MS)
      })
    })
  }

  close () {
    this.controller?.close()
    try { this.dummyBot?.quit('closing') } catch {}
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
  for (const name of [settings.player, settings.dummy]) await agents.rcon.send(`whitelist add ${name}`)
  const missing = missingFighterFiles(settings)
  if (missing.length) log(`!1v1 will not work, missing: ${missing.join(', ')}`)
  if (!hasNetwork(settings.agentRun)) log(`the agent cannot fight mobs, no network in ${settings.agentRun}. Set DEMO_AGENT_RUN`)
  await agents.connectDummy()
  const bot = agents.agentBot()
  if (!bot?.entity) throw new Error('The agent did not join')
  const p = bot.entity.position.floored()
  agents.controller = new DemoController({ settings, rcon: agents.rcon, agents, spawnDuel, log })
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
