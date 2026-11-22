// The danger sensing agents: helper bots the owner commands in chat on the agents server (server-agents/, see docs/danger-sensing-agents.md).
//
//   node bridge/danger_sensing_agents/agents.js                      the bots named in agents.config.json (Agent1, Agent2)
//   node bridge/danger_sensing_agents/agents.js --bots 3             Agent1 to Agent3
//   node bridge/danger_sensing_agents/agents.js --names Ann,Bob      these names (add them to the agents whitelist first)
//   node bridge/danger_sensing_agents/agents.js --run runs/<version> another saved version of the fighting network
//   node bridge/danger_sensing_agents/agents.js --owner AgentTester   obey another name (the live test harness, livetest.js)
//   node bridge/danger_sensing_agents/agents.js --metrics <file>     append one JSON line per finished job, death and chat event
//   node bridge/danger_sensing_agents/agents.js --miner tunnel       the single tunnel miner (for the mining benchmark)
//   node bridge/danger_sensing_agents/agents.js --builds <file>      where the agents remember what they built (default server-agents/agents-builds.json)
//
// Only the owner's chat counts, checked by the sender's UUID in the chat packet. "!" lines are commands, "@agents ..." or "Agent1 ..." in plain words go through the
// translator. Each bot runs a priority mode manager (behaviors.js) ticked every game tick.

const fs = require('fs')
const path = require('path')
require('../patch-physics')  // the same movement physics the fighter trained with
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { Rcon } = require('../rcon')
const { Vec3 } = require('vec3')
const { parseChatLine, chatSender, helpText, parseMessage, formatCommand, SOLO } = require('./commands')
const { aOrAn } = require('./skills/crafter_plan')
const bp = require('./skills/blueprint')
const { withCrop } = require('./skills/farm')
const { Designer } = require('./designer')
const { Friends, Blackboard, guardAttacks } = require('./targets')
const { guardDigging } = require('./hazards')
const { guardHazards } = require('./skills/move')
const { DeathRecorder } = require('./death_log')
const { makeModes } = require('./behaviors')
const { FightSkill, ensureKit, stopFight } = require('./skills/fight')
const { PolicyClient } = require('./skills/policy')
const { Human } = require('./skills/human')
const { installMotion, setFreeAim, holdForDig } = require('./skills/motion')
const { installBlastTrace } = require('./skills/blast_trace')
const { Translator } = require('./translator')
const { KINDS: GATHER_KINDS } = require('./skills/gather_kinds')
const { checkPlan } = require('./plan_check')
const { planGoal, goalCommands, needsToolChain, withAxe } = require('./goal_plan')
const { ChestMemory, chestView } = require('./chest_memory')
const { OreMarks, answerDiamonds } = require('./skills/ore_marks')
const { readOwnerBag } = require('./owner_bag')
const { addGoalStepMode } = require('./skills/goal_steps')
const { CONTAINERS } = require('./skills/storage')
const { TARGETS } = require('./skills/crafter_plan')

const ROOT = path.join(__dirname, '..', '..')
const { loadConfig, requireOwner } = require('./config')
const CONFIG = loadConfig({ ownerRequired: false })
// the goal planner's own steps (skills/goal_steps.js)
const GOAL_STEPS = new Set(['survey', 'take', 'ask', 'walk', 'hand', 'prep', 'axe'])
// how many times a goal looks at its sources again: after taking from chests and asking the owner, it plans from what
// really arrived, and the last round only gathers
const GOAL_ROUNDS = 3
const GOAL_TOOL_REPLANS = 2  // a pickaxe or the finished item lost on the way (broken, or a death): the goal plans again this often
// A step that ended early for a reason a new plan can get past, sharing that budget. A full bag or an unknown kind stays
// the same whatever it plans, and a job another order replaced is not its to resume
const WORTH_REPLANNING = { gather: new Set(['short', 'none', 'stuck', 'food', 'error']), craft: new Set(['error']) }
const JOB_COMMANDS = new Set(['kill', 'mine', 'gather', 'come', 'give', 'build', 'expand', 'explore', 'design', 'craft', ...GOAL_STEPS])
// one shot jobs: starting one ends the others (the farm keeps going underneath, follow comes back after)
const ONE_SHOT = ['build', 'mine', 'explore', 'gather']
// a plan step of these that does not end with 'done' stops the plan: the steps after it count on it
const MUST_FINISH = new Set(['gather', 'craft', 'mine', 'prep', 'walk', 'hand'])
// the bag as a Map of item name to count
const bagOf = bot => {
  const m = new Map()
  for (const i of bot.inventory.items()) m.set(i.name, (m.get(i.name) || 0) + i.count)
  return m
}
// commands that only answer or set chat options: they leave a running plan alone
const INFO = new Set(['help', 'status', 'doing', 'danger', 'plan', 'blueprints', 'human', 'quiet', 'verbose'])
// commands that do not end a !stay
const STAY_KEEPS = new Set(['stay', 'help', 'status', 'doing', 'danger', 'plan', 'human', 'quiet', 'verbose', 'blueprints'])
const CUSTOM_BLUEPRINTS = path.join(ROOT, 'server-agents', 'blueprints')
const BUILDS_FILE = path.join(ROOT, 'server-agents', 'agents-builds.json')
const RECONNECT_MS = 5000

function stamp () {
  const d = new Date()
  return d.toTimeString().slice(0, 8)
}
const log = (...a) => console.error(`[agents ${stamp()}]`, ...a)

function parseArgs (argv) {
  const opts = { names: CONFIG.bots, run: CONFIG.fighter_run, translator: true, owner: CONFIG.owner, metrics: null, miner: 'branch' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--bots') opts.names = Array.from({ length: Math.max(1, parseInt(argv[++i], 10) || 2) }, (_, k) => `Agent${k + 1}`)
    else if (a === '--names') opts.names = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--run') opts.run = argv[++i]
    else if (a === '--no-translator') opts.translator = false
    else if (a === '--owner') opts.owner = argv[++i]
    else if (a === '--metrics') opts.metrics = argv[++i]
    else if (a === '--miner') opts.miner = argv[++i] === 'tunnel' ? 'tunnel' : 'branch'
    else if (a === '--builds') opts.builds = argv[++i]
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 14).join('\n'))
      process.exit(0)
    }
  }
  return opts
}

// What the agents have built, kept next to the world it stands in, so !expand and !farm find their builds again
class Builds {
  constructor (file) {
    this.file = file
    this.items = []
    try { this.items = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    if (!Array.isArray(this.items)) this.items = []
  }

  list () { return this.items }

  // A finished build. The same blueprint on the same anchor (a rebuild or an expansion) updates its record
  add (bot, job) {
    const a = job.anchor
    const box = job.box ? { min: { x: job.box.min.x, y: job.box.min.y, z: job.box.min.z }, max: { x: job.box.max.x, y: job.box.max.y, z: job.box.max.z } } : null
    const fields = {
      blueprint: job.blueprint.name,
      anchor: [a.x, a.y, a.z],
      facing: job.facing,
      modules: job.modules || 1,
      crop: job.crop || (bp.cellsOf(job.blueprint).some(c => bp.CROPS[c.name]) ? 'wheat' : null),
      box,
      bot: bot.username,
      at: new Date().toISOString()
    }
    let rec = this.items.find(r => r.blueprint === fields.blueprint && r.anchor.join() === fields.anchor.join())
    if (rec) Object.assign(rec, fields)
    else {
      rec = { id: `${fields.blueprint}-${Date.now()}`, ...fields }
      this.items.push(rec)
    }
    job.record = rec
    this.save()
    return rec
  }

  // The nearest record of this blueprint (or with this id) to a point
  find (name, point) {
    const list = this.items.filter(r => r.blueprint === name || r.id === name)
    if (!point) return list[list.length - 1] || null
    return list.sort((a, b) => dist(a.anchor, point) - dist(b.anchor, point))[0] || null
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2))
    } catch (err) {
      log(`builds: ${err.message}`)
    }
  }
}
const dist = (a, p) => Math.hypot(a[0] - p.x, a[1] - p.y, a[2] - p.z)
// a step for chat: the wooden axe is a plan step with no command of its own to type
const stepLabel = c => c.name === 'axe' ? 'craft wooden axe to keep' : formatCommand('all', c)

// RCON settings of the agents server, read from its own server.properties
function agentsRconSettings () {
  const file = path.join(ROOT, 'server-agents', 'server.properties')
  if (!fs.existsSync(file)) return null
  const props = Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
  if (props['enable-rcon'] !== 'true') return null
  return { port: parseInt(props['rcon.port'], 10), password: props['rcon.password'], level: props['level-name'] || 'world' }
}

class Agents {
  constructor (opts) {
    this.opts = opts
    this.owner = opts.owner || CONFIG.owner
    this.names = opts.names
    // the real owner stays a friend while a test owner gives the orders
    this.friends = new Friends(this.owner, this.names, [CONFIG.owner, ...CONFIG.friends].filter(Boolean))
    this.metricsFile = opts.metrics || null
    this.miner = opts.miner || 'branch'
    this.builds = new Builds(opts.builds || BUILDS_FILE)
    // what is in the chests, kept next to the builds of the same world
    this.chests = new ChestMemory(path.join(path.dirname(opts.builds || BUILDS_FILE), 'agents-chests.json'), { log })
    this.oreMarks = new OreMarks({ say: (bot, text) => this.say(bot, text) })
    this.worldId = 'world'
    this.designer = new Designer({ log, credentials: opts.translator ? undefined : null })
    this.blackboard = new Blackboard()
    this.ctxs = new Map()  // bot name to its context
    this.policy = new PolicyClient(opts.run, log)
    const blueprints = () => this.blueprintNames().map(n => ({ name: n, description: this.loadBlueprint(n)?.description }))
    this.translator = opts.translator
      ? new Translator({ model: CONFIG.translator_model, botNames: this.names, log, blueprints })
      : new Translator({ botNames: this.names, log, credentials: null, blueprints })
    this.lastAnnounce = { text: '', at: 0 }
    this.verbosity = 'normal'  // quiet, normal or verbose (!quiet, !verbose)
    this.lastEvent = new Map()
    this.rcon = null
    this.closing = false
    this.log = log
  }

  async start () {
    const rc = agentsRconSettings()
    if (rc) {
      this.worldId = `level:${rc.level}`
      try {
        const r = new Rcon(CONFIG.host, rc.port, rc.password)
        await r.connect()
        this.rcon = r
      } catch (err) {
        log(`no console access (RCON ${rc.port}): ${err.message}, the fight kit is off`)
      }
      // the seed tells a new world from an old one of the same name, so its chests are not mixed up
      if (this.rcon) {
        try {
          const seed = String(await this.rcon.send('seed')).match(/\[(-?\d+)\]/)
          if (seed) this.worldId = `seed:${seed[1]}`
        } catch (err) {
          log(`could not read the world seed: ${err.message}`)
        }
      }
    }
    log(this.translator.enabled ? `translator on (${this.translator.model})` : 'translator off: no ANTHROPIC_API_KEY in the environment or .env')
    for (const name of this.names) {
      await this.connect(name)
      await new Promise(resolve => setTimeout(resolve, 1500))  // the server refuses quick joins from one address
    }
  }

  connect (name) {
    return new Promise(resolve => {
      const bot = mineflayer.createBot({
        host: CONFIG.host,
        port: CONFIG.port,
        username: name,
        version: CONFIG.version,
        auth: 'offline',
        checkTimeoutInterval: 60000
      })
      bot.setMaxListeners(50)
      bot.loadPlugin(pathfinder)
      let spawned = false
      bot.once('spawn', () => {
        spawned = true
        require('../mineflayer_fixes').applyMineflayerFixes(bot)  // real sprint actions and knockback
        installMotion(bot)  // smooth camera, jumps and paths, off during a fight
        require('./skills/mine').keepToolsForTheirBlocks(bot)  // no pickaxe on dirt
        this.setupBot(bot)
        installBlastTrace(bot, () => this.ctxs.get(name), log)  // what it does after an explosion next to it
        log(`${name} joined`)
        resolve(bot)
      })
      let duplicate = false
      bot.on('kicked', reason => {
        const text = JSON.stringify(reason)
        // someone else logged in with this name (another agents process, or a person): rejoining would kick them in
        // turn, and the two would take turns forever
        duplicate = text.includes('duplicate_login')
        log(`${name} was kicked: ${text.slice(0, 200)}`)
      })
      bot.on('error', err => log(`${name}: ${err.message}`))
      bot.on('end', reason => {
        const ctx = this.ctxs.get(name)
        if (ctx && ctx.bot === bot) {
          ctx.alive = false
          ctx.fight?.stop()
        }
        if (!spawned) resolve(null)
        if (this.closing) return
        if (duplicate) {
          log(`${name} is logged in somewhere else, not rejoining`)
          return
        }
        log(`${name} left (${reason}), joining again in ${RECONNECT_MS / 1000} s`)
        setTimeout(() => this.connect(name), RECONNECT_MS)
      })
    })
  }

  setupBot (bot) {
    guardAttacks(bot, this.friends, log)
    const ctx = { bot, agents: this, alive: true, seq: 0, pickaxes: null, lastPos: null }
    bot.trail = []  // the cells of its own tunnel, for backing out of water
    bot._oreMarks = this.oreMarks
    ctx.human = new Human(bot, this.ctxs.get(bot.username)?.human?.level || CONFIG.human || 'light')
    ctx.fight = new FightSkill(bot, this.policy, { friends: this.friends, noDigMoves: this.noDigMoves(bot), log })
    bot.agentsFight = ctx.fight
    makeModes(ctx)
    // no job breaks a block that holds back lava, except a head stuck in a block digging itself free and the table or
    // furnace it placed itself (a craft that cannot take its table back would stop there)
    guardDigging(bot, { allow: block => ctx.danger.report?.escape?.kind === 'suffocation' || /^(crafting_table|furnace)$/.test(block?.name || '') })
    ctx.deaths = new DeathRecorder(bot, {
      metrics: this.metricsFile,
      status: () => ctx.manager?.status(),
      job: () => ctx.manager?.active?.name
    })
    ctx.manager.hooks.holdControl =(active, chosen) => holdForDig(bot, chosen?.name, { fireOnly: ctx.danger.report?.escape?.kind === 'fire' })
    addGoalStepMode(ctx)
    bot.agentsChests = chestView(this.chests, bot, () => this.worldId, CONTAINERS)
    this.ctxs.set(bot.username, ctx)
    bot.on('physicsTick', () => {
      if (!ctx.alive) return
      ctx.deaths.sample()
      // the danger assessor (threats.js) 5 times a second, before the modes read its report
      if (ctx.ticks % 4 === 0) ctx.danger.update()
      ctx.manager.tick()
      this.breathe(bot, ctx)
      if (bot.health > 0) ctx.lastPos = bot.entity.position.clone()
      if (++ctx.ticks % 20 === 0) this.watchPickaxes(bot, ctx)
    })
    ctx.ticks = 0
    bot.on('messagestr', (text, position, message, senderUuid) => {
      ctx.deaths.message(text)
      if (this.listener() !== bot) return
      if (!chatSender(bot.players, text, position, message, senderUuid)) return  // a system line or a look-alike
      this.handleChat(bot, text).catch(err => log(`command failed: ${err.stack || err.message}`))
    })
    bot.on('death', () => {
      const p = ctx.lastPos || bot.entity.position
      ctx.deaths.died(p)
      log(`${bot.username} died at ${p.floored()}`)
      this.metric({ bot: bot.username, death: true, pos: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], mode: ctx.manager?.status() })
      this.event(bot, 'key', 'died', `I died at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`, 0)
      ctx.pickaxes = null  // everything dropped, so do not report its pickaxe as broken
      bot.trail = []
      ctx.danger.reset()  // what it knew about the mobs around it was about the old life
    })
  }

  // One chat line whose sender the packet has confirmed (chatSender in commands.js), as the server sends it
  // ("<OwnerPlayer> craft me a stone pickaxe"). Only the owner gives orders, and a friend may ask the crafter for an
  // item (it hands it to whoever asked), nothing else
  async handleChat (bot, text) {
    const line = parseChatLine(text)
    if (!line || line.sender === bot.username) return
    if (line.sender.toLowerCase() !== this.owner.toLowerCase()) {
      if (!this.friends.has(line.sender) || this.names.some(n => n.toLowerCase() === line.sender.toLowerCase())) return
      const p = parseMessage(line.message, this.names)
      if (p?.type !== 'command') return
      // a friend may ask for something the agents craft, nothing else (no other item out of the owner's chests)
      if (p.command.name !== 'craft' && !(p.command.name === 'get' && TARGETS.includes(p.command.args.item))) return
    }
    await this.onOwnerMessage(line.message, line.sender)
  }

  // A pickaxe gone from the bag while the bot lives means it broke (the kit and !give never take pickaxes away)
  watchPickaxes (bot, ctx) {
    if (bot.health <= 0) return
    const n = bot.inventory.items().filter(i => i.name.endsWith('_pickaxe')).length
    if (ctx.pickaxes !== null && n < ctx.pickaxes) {
      this.event(bot, 'key', 'pickaxe', n ? 'One of my pickaxes broke' : 'My pickaxe broke', 0)
    }
    ctx.pickaxes = n
  }

  // News for the owner. level: key (always said), normal (not in quiet), detail (verbose only). The same news from
  // the same bot is said at most once per gap milliseconds
  event (bot, level, key, text, gap = 10000) {
    const shown = { quiet: ['key'], normal: ['key', 'normal'], verbose: ['key', 'normal', 'detail'] }[this.verbosity]
    log(`${bot.username} event: ${text}`)
    this.metric({ bot: bot.username, event: key, level, text })
    if (!shown.includes(level)) return
    const id = `${bot.username}:${key}`
    const now = Date.now()
    if (gap && now - (this.lastEvent.get(id) || 0) < gap) return
    this.lastEvent.set(id, now)
    // through the bot's announcer (announcer.js): one line every 5 s, never the same line twice within 30 s
    const a = this.ctxs.get(bot.username)?.announcer
    if (a) a.step(text, { force: level === 'key' })
    else this.say(bot, text)
  }

  // One JSON line per finished job, death or chat event, for the live test harness and the mining benchmark
  metric (record) {
    if (!this.metricsFile) return
    try {
      fs.appendFileSync(this.metricsFile, JSON.stringify({ t: new Date().toISOString(), ...record }) + '\n')
    } catch (err) {
      log(`metrics: ${err.message}`)
    }
  }

  // Control moved to a mode of another skill profile: put the old profile's work away
  profileChanged (ctx, prev, next) {
    const bot = ctx.bot
    setFreeAim(bot, next === 'fight' || next === 'mobfight')  // the trained networks keep their exact aim and keys
    if (prev === 'fight') stopFight(bot)
    if (prev === 'mine') {
      try { bot.stopDigging() } catch {}
    }
    if (prev !== 'idle' || next !== 'idle') log(`${bot.username}: ${prev} to ${next}`)
  }

  // A reflex under every mode: out of air in water, swim up (a bot drowned while mining in the live test)
  breathe (bot, ctx) {
    const low = bot.entity.isInWater && bot.oxygenLevel !== undefined && bot.oxygenLevel < 10
    if (low) {
      bot.setControlState('jump', true)
      ctx.swimming = true
    } else if (ctx.swimming) {
      bot.setControlState('jump', false)
      ctx.swimming = false
    }
  }

  // The one bot that reads chat for everyone, so each line is handled once
  listener () {
    for (const name of this.names) {
      const ctx = this.ctxs.get(name)
      if (ctx?.alive) return ctx.bot
    }
    return null
  }

  digMoves (bot) {
    if (!bot._agentsDig) {
      const m = new Movements(bot)
      m.canDig = true
      m.allowParkour = true
      m.liquidCost = 50  // around water, a bot drowned walking to an ore in the live test
      m.maxDropDown = 3  // the default 4 costs half a heart
      guardHazards(bot, m)
      bot._agentsDig = m
    }
    return bot._agentsDig
  }

  noDigMoves (bot) {
    if (!bot._agentsNoDig) {
      const m = new Movements(bot)
      m.canDig = false
      m.allow1by1towers = false
      m.scafoldingBlocks = []
      guardHazards(bot, m)  // the retreat and back off set their goal without goTo
      bot._agentsNoDig = m
    }
    return bot._agentsNoDig
  }

  // Walking around a building site: never digs (the owner's blocks stay where they are), never places stray blocks of its
  // own, opens doors, short drops only
  buildMoves (bot) {
    if (!bot._agentsBuild) {
      const m = new Movements(bot)
      m.canDig = false
      m.allow1by1towers = false
      m.scafoldingBlocks = []
      m.allowParkour = false
      m.canOpenDoors = true
      m.maxDropDown = 3
      m.liquidCost = 50
      guardHazards(bot, m)
      bot._agentsBuild = m
    }
    return bot._agentsBuild
  }

  // A blueprint from the library, or one Claude drew for the owner (server-agents/blueprints)
  loadBlueprint (name) {
    return bp.loadBlueprint(name) || bp.loadBlueprint(name, CUSTOM_BLUEPRINTS)
  }

  blueprintNames () {
    return [...new Set([...bp.listBlueprints(), ...bp.listBlueprints(CUSTOM_BLUEPRINTS)])].sort()
  }

  // The farms it built, newest last
  farms () {
    return this.builds.list().filter(r => r.crop)
  }

  // Where the owner stands: the ground below (the first full block under the owner's feet, so a jump or a hover does
  // not lift the build into the air) and the owner's look, or null when no bot can see the owner
  ownerSpot () {
    for (const ctx of this.ctxs.values()) {
      const e = ctx.alive && ctx.bot.players[this.owner]?.entity
      if (e) {
        const f = e.position.floored()
        let ground = f.offset(0, -1, 0)
        for (let i = 0; i < 12; i++) {
          const b = ctx.bot.blockAt(f.offset(0, -1 - i, 0))
          if (!b) break
          if (b.boundingBox === 'block') { ground = b.position; break }
        }
        return { anchor: new Vec3(ground.x, ground.y, ground.z), yaw: e.yaw }
      }
    }
    return null
  }

  say (bot, text) {
    if (!bot) return
    try { bot.chat(String(text).slice(0, 250)) } catch {}
  }

  // A line for all the agents, said once even when every bot reaches the same conclusion
  announce (text) {
    const now = Date.now()
    if (this.lastAnnounce.text === text && now - this.lastAnnounce.at < 3000) return
    this.lastAnnounce = { text, at: now }
    this.say(this.listener(), text)
  }

  async ensureKit (bot) {
    if (!this.rcon) {
      if (!this.saidNoKit) this.say(bot, 'No console access, I fight with what I carry')
      this.saidNoKit = true
      return
    }
    try {
      await ensureKit(bot, this.rcon, log)
    } catch (err) {
      log(`${bot.username} kit: ${err.message}`)
    }
  }

  stopAll (bot) {
    stopFight(bot)
    try { bot.pathfinder.stop() } catch {}
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    try { bot.stopDigging() } catch {}
    try { bot.deactivateItem() } catch {}
    this.blackboard.clear()
  }

  targetsOf (targets) {
    const names = targets === 'all' ? this.names : targets
    return names.map(n => this.ctxs.get(n)).filter(c => c?.alive)
  }

  // sender: who said it (the owner, or a friend asking the crafter), the crafter hands the item to them
  async onOwnerMessage (message, sender = this.owner) {
    if (answerDiamonds(this, message, sender)) return  // a yes to "found diamonds", the job comes after this one
    // the owner's plain words go through the model when it is on. A friend's line stays on the shortcuts, which only
    // name what a friend may ask for
    const viaTranslator = !!this.translator?.enabled && String(sender).toLowerCase() === String(this.owner).toLowerCase()
    let p = parseMessage(message, this.names, { viaTranslator })
    if (!p) return
    let r = null
    if (p.type === 'translate') {
      // plain words through the translator (Claude Haiku), which only names what is wanted
      r = await this.translator.translate(p.text, p.targets)
      if (p.shortcut && !r?.vague && !r?.impossible && !r?.parsed?.length) {
        // no usable answer: a line the shortcuts know still works without the model
        log(`translator: ${String(r?.error || 'no usable answer').slice(0, 120)}, using the shortcut`)
        p = p.shortcut
        r = null
      } else if (!r.error && !r.vague && !r.impossible && !r.dropped?.length && r.parsed.length === 1 && INFO.has(r.parsed[0].command.name)) {
        // a question: answered like a typed one, so the job in progress carries on
        p = { type: 'command', targets: r.parsed[0].targets, command: r.parsed[0].command }
        r = null
      }
    }
    // "craft me a diamond pickaxe" with no way to mine the diamonds yet: the crafter alone would stall, so it is a goal
    if (p.type === 'command' && p.command.name === 'craft' && !String(message).trim().startsWith('!')) {
      const ctx = this.targetsOf(p.targets)[0]
      if (ctx && needsToolChain(p.command.args.item, bagOf(ctx.bot))) p.command = { name: 'get', args: { item: p.command.args.item, count: 1 } }
    }
    if (p.type === 'command' && (p.command.name === 'craft' || p.command.name === 'get')) p.command.args.requester = sender
    if (p.type === 'error') {
      this.say(this.listener(), p.error)
      return
    }
    if (p.type === 'command') {
      let ctxs = this.targetsOf(p.targets)
      if (!ctxs.length) return
      if (p.command.name === 'quiet' || p.command.name === 'verbose') {
        this.verbosity = this.verbosity === p.command.name ? 'normal' : p.command.name
      }
      this.pinHere(p.command)
      if (SOLO.has(p.command.name) && p.targets === 'all') ctxs = [this.pickSolo(ctxs, p.command)]
      for (const ctx of ctxs) {
        if (!INFO.has(p.command.name)) ctx.seq++  // a typed order replaces any plan still queued, a question does not
        this.execute(ctx, p.command)
      }
      this.acknowledge(ctxs, p.command)
      return
    }
    if (r.error) { this.say(this.listener(), r.error.slice(0, 120)); return }
    // the two refusals, each says why and runs nothing. Too vague: the model asks what is meant. Impossible: a part of
    // it needs a skill the agents have not got, or the model named a command that does not exist
    if (r.vague) { this.vague(r.vague); return }
    if (r.impossible) { this.impossible(r.impossible); return }
    if (r.dropped.length) { this.impossible(`there is no command for "${r.dropped[0]}"`); return }
    if (!r.parsed.length) { this.say(this.listener(), 'I did not get a command out of that'); return }
    log(`translated "${p.text}" to ${r.lines.join(' ; ')}`)
    // a goal: one bot, and the script plans every step
    if (r.parsed.length === 1 && r.parsed[0].command.name === 'get') {
      const { targets, command } = r.parsed[0]
      const ctxs = this.targetsOf(targets)
      if (!ctxs.length) return
      command.args.requester = sender
      this.execute(targets === 'all' ? this.pickSolo(ctxs, command) : ctxs[0], command)
      return
    }
    // a stop anywhere in the plan acts at once, the rest runs in order per bot. "here" means where the owner stood when
    // saying it, and the jobs one bot takes go to the same bot
    const perBot = new Map()
    let solo = null
    for (const { targets, command } of r.parsed) {
      this.pinHere(command)
      if (command.name === 'craft') command.args.requester = sender
      let ctxs = this.targetsOf(targets)
      if (SOLO.has(command.name) && targets === 'all' && ctxs.length) {
        solo = solo || this.pickSolo(ctxs, command)
        ctxs = [solo]
      }
      for (const ctx of ctxs) {
        if (!perBot.has(ctx)) perBot.set(ctx, [])
        perBot.get(ctx).push(command)
      }
    }
    // every bot's queue checked against its own bag before anything runs (plan_check.js): the pickaxes it lacks go
    // in front, and one impossible step makes the whole request impossible
    const plans = new Map()
    for (const [ctx, commands] of perBot) {
      const c = checkPlan(commands, bagOf(ctx.bot), { registry: ctx.bot.registry, dimension: ctx.bot.game?.dimension, blueprints: this.blueprintNames() })
      if (c.impossible) { this.impossible(c.impossible); return }
      // a queue that makes the first wooden pickaxe makes the wooden axe to fight with right after it
      c.commands = withAxe(c.commands, bagOf(ctx.bot))
      plans.set(ctx, c)
    }
    for (const [ctx, c] of plans) {
      const steps = c.commands.map(stepLabel)
      log(`${ctx.bot.username} plan: ${steps.join(' ; ')}${c.added.length ? ` (added: ${c.added.map(x => x.why).join(' | ')})` : ''}`)
      const who = plans.size > 1 ? `${ctx.bot.username}: ` : ''
      const extra = c.added.length ? ` (I added ${c.added.length === 1 ? 'a pickaxe' : 'the pickaxes'} I need)` : ''
      this.say(ctx.bot, `${who}On it: ${steps.map((s, i) => `${i + 1}) ${s}`).join(' ')}${extra}`.slice(0, 250))
      this.runPlan(ctx, c.commands, { labels: steps })
    }
  }

  // A request no plan can do: say why, run nothing
  impossible (reason) {
    log(`impossible: ${reason}`)
    this.say(this.listener(), `That's impossible for me right now: ${String(reason).slice(0, 180)}`)
  }

  // A request that does not say what is wanted: ask, run nothing
  vague (question) {
    log(`too vague: ${question}`)
    this.say(this.listener(), `Too vague for me: ${String(question).slice(0, 180)}`)
  }

  // What the goal planner can draw on right now. A friend's request only uses the bot's own bag and gathering, the
  // owner's chests and bag are the owner's
  goalSources (ctx, forOwner, ownerBag, useChests) {
    const bot = ctx.bot
    const me = bot.entity.position
    const known = forOwner && useChests && bot.agentsChests ? (bot.agentsChests.prune(), bot.agentsChests.list()) : []
    return {
      bag: bagOf(bot),
      chests: known.map(c => ({ pos: c.pos, items: c.items, distance: Math.hypot(c.pos.x - me.x, c.pos.y - me.y, c.pos.z - me.z) })),
      owner: ownerBag
    }
  }

  // One goal from the owner's words to the item in their hands. The script plans from the bag, the chests it knows and
  // the owner's bag, gets what those hold, looks again at what really arrived and does the rest. Resolves when it ends
  async runGoal (ctx, args, requester = this.owner) {
    const seq = ++ctx.seq
    const bot = ctx.bot
    const goal = { item: args.item, count: args.count }
    const gone = () => ctx.seq !== seq || !ctx.alive
    addGoalStepMode(ctx)
    this.oneShot(ctx.manager)
    const forOwner = String(requester).toLowerCase() === String(this.owner).toLowerCase()
    const dimension = bot.game?.dimension
    let ownerBag = null
    if (forOwner) {
      const r = await readOwnerBag(this.rcon, this.owner)
      if (gone()) return 'stopped'
      ownerBag = r.bag
      if (!ownerBag) {
        log(`${bot.username} can't read ${this.owner}'s bag: ${r.why}`)
        this.say(bot, `I can't see your bag (${r.why}), so I'll use what I find myself`)
      }
    }
    let surveyed = false
    let toolReplans = 0
    let shortPlan = null  // what was left of the plan when a step last came up short: the same again means no progress
    for (let round = 0; round < GOAL_ROUNDS; round++) {
      if (gone()) return 'stopped'
      const last = round === GOAL_ROUNDS - 1
      const sources = () => ({ ...this.goalSources(ctx, forOwner, last ? null : ownerBag, !last), expectsRaw: true })  // it hunts on the way
      let plan = planGoal(goal, sources(), { dimension })
      // chests close by it has never opened are looked into once, before it asks the owner or goes gathering
      if (!surveyed && forOwner && bot.agentsChests && plan.steps.some(s => s.kind === 'gather' || s.kind === 'ask')) {
        surveyed = true
        await this.execute(ctx, { name: 'survey', args: {} })
        if (gone()) return 'stopped'
        plan = planGoal(goal, sources(), { dimension })
      }
      if (plan.impossible) {
        ctx.plan = null
        this.impossible(plan.impossible)
        return 'impossible'
      }
      const all = goalCommands(plan, requester)
      const fetching = last ? 0 : all.filter(c => c.kind === 'take' || c.kind === 'ask').length
      const now = fetching ? all.slice(0, fetching) : all
      const labels = all.map(c => c.label)
      log(`${bot.username} goal ${goal.count} ${goal.item}: ${labels.join(' ; ')}`)
      this.say(bot, `${round ? 'Now' : 'On it'}: ${labels.map((s, i) => `${i + 1}) ${s}`).join(' ')}`.slice(0, 250))
      // what it needed is gone: a pickaxe, or the one item it made and was about to hand over
      const lostItem = (r, command) => command.name === 'hand' && r === 'short' && (goal.count ?? 1) === 1 && !bagOf(bot).get(goal.item)
      let cameUpShort = false
      const retry = toolReplans < GOAL_TOOL_REPLANS
        ? (r, command) => {
            if (r === 'no_tool' || lostItem(r, command)) return true
            if (!WORTH_REPLANNING[command.name]?.has(r)) return false
            const left = labels.slice(all.findIndex(c => c.command === command)).join(' ; ')  // from the step that failed on
            if (left === shortPlan) return false
            shortPlan = left
            cameUpShort = true
            return true
          }
        : null
      const result = await this.runPlan(ctx, now.map(c => c.command), { labels: now.map(c => c.label), seq, final: !fetching, retry })
      if (result === 'replan') {
        toolReplans++
        round--
        this.say(bot, cameUpShort ? 'That step came up short, planning again from what I have' : 'I lost what I needed, planning again from what I have')
        continue
      }
      if (result !== 'done') return result
      if (!fetching) return 'done'
      ownerBag = null  // asked once, and what the owner dropped is in the bag now
    }
    return 'done'
  }

  // Runs a plan's steps in order, each job to its end. A gather, craft or mine that did not get it done stops the
  // plan there (the steps after it count on it) and says so. !plan says where it is. labels: the words for each step.
  // final false: a part of a longer goal, so it does not say it is done. Resolves 'done', 'stopped' or 'failed'
  async runPlan (ctx, commands, { labels = null, seq = ++ctx.seq, final = true, retry = null } = {}) {
    const steps = labels || commands.map(c => formatCommand('all', c))
    ctx.plan = { steps, index: 0, seq }
    for (const [i, command] of commands.entries()) {
      if (ctx.seq !== seq || !ctx.alive) return 'stopped'
      ctx.plan.index = i
      const job = this.execute(ctx, command)
      if (job && JOB_COMMANDS.has(command.name)) {
        const result = await job
        if (ctx.seq !== seq) return 'stopped'
        if (result === 'stopped') { ctx.plan = null; return 'stopped' }
        if (MUST_FINISH.has(command.name) && result !== 'done') {
          if (retry?.(result, command)) { ctx.plan = null; return 'replan' }  // the caller plans again
          this.say(ctx.bot, `Stopping the plan at step ${i + 1} of ${steps.length} (${steps[i]}): it ended with ${result}`.slice(0, 250))
          ctx.plan = null
          return 'failed'
        }
      }
    }
    if (ctx.seq !== seq) return 'stopped'
    if (final) {
      ctx.plan = null
      if (steps.length > 1) this.say(ctx.bot, `Done with the plan (${steps.length} steps)`)
    }
    return 'done'
  }

  // A build or farm "here" is pinned to where the owner stands now, not where the owner is when a plan gets to it
  pinHere (command) {
    const a = command.args || {}
    if ((command.name === 'build' && a.site === 'here') || (command.name === 'farm' && a.here)) {
      if (!a.at) a.at = this.ownerSpot()
    }
  }

  // The bot that takes a one bot job: one with nothing to do, else the first
  pickSolo (ctxs, command = null) {
    // a craft request goes to the bot already making that item for that player (so it is not made twice), then to
    // one with a craft job (it queues there)
    if (command?.name === 'craft') {
      const a = command.args
      const has = c => { const m = c.manager.get('craft'); return [m.job, ...m.queue].some(j => j && j.item === a.item && j.requester === (a.requester || this.owner)) }
      const busy = ctxs.find(has) || ctxs.find(c => c.manager.get('craft').job)
      if (busy) return busy
    }
    return ctxs.find(c => ['idle', 'following you'].includes(c.manager.status())) || ctxs[0]
  }

  oneShot (m, keep) {
    for (const n of ONE_SHOT) if (n !== keep) m.setOff(n)
  }

  // Runs one command on one bot. Returns the job's promise for commands that end on their own
  execute (ctx, command) {
    const m = ctx.manager
    const a = command.args
    // !stay keeps the bot where it is (no food runs) until the next order that moves it
    if (!STAY_KEEPS.has(command.name)) ctx.staying = false
    // any new order ends a goal's chest, ask or hand step (the plan's own next step finds it already over)
    if (!INFO.has(command.name) && !GOAL_STEPS.has(command.name) && m.byName.has('goalstep')) m.setOff('goalstep', 'replaced')
    if (GOAL_STEPS.has(command.name)) {
      addGoalStepMode(ctx)
      return m.setOn('goalstep', { step: command.name, ...a })
    }
    switch (command.name) {
      case 'stop':
        ctx.seq++
        ctx.cancelDiamonds?.()
        m.stopNow()
        return null
      case 'kill':
        for (const n of ['mine', 'come', 'give', 'follow']) m.setOff(n)
        return m.setOn('kill', { radius: a.radius, target: a.target })
      case 'guard':
        return m.setOn('guard', { radius: a.radius })
      case 'come':
        m.setOff('follow')
        return m.setOn('come', {})
      case 'follow':
        m.setOff('come')
        return m.setOn('follow', {})
      case 'stay':
        ctx.staying = true
        for (const n of ['follow', 'come', 'mine', 'gather', 'give', 'build', 'farm', 'explore']) m.setOff(n)
        ctx.bot.pathfinder.setGoal(null)
        ctx.bot.clearControlStates()
        return null
      case 'gather':
        this.oneShot(m, 'gather')
        return m.setOn('gather', { kind: a.kind, count: a.count })
      case 'mine':
        this.oneShot(m, 'mine')
        return m.setOn('mine', { block: a.block, blocks: a.blocks, count: a.count })
      case 'build': {
        const b = this.loadBlueprint(a.blueprint)
        if (!b) {
          this.say(ctx.bot, `I have no blueprint called ${a.blueprint}. Try !blueprints, or describe it to @agents`)
          return null
        }
        let anchor
        let facing = a.facing
        if (a.site === 'here') {
          const spot = a.at || this.ownerSpot()
          if (!spot) { this.say(ctx.bot, `I can't see you, ${this.owner}`); return null }
          anchor = spot.anchor
          facing = facing || bp.facingTowardOwner(spot.yaw)
        } else {
          anchor = new Vec3(a.site[0], a.site[1] - 1, a.site[2])
          facing = facing || b.facing
        }
        this.oneShot(m, 'build')
        return m.setOn('build', { blueprint: b, anchor, facing })
      }
      case 'expand': {
        const owner = ctx.bot.players[this.owner]?.entity
        const rec = this.builds.find(a.build, owner ? owner.position : ctx.bot.entity.position)
        if (!rec) { this.say(ctx.bot, `I know no ${a.build} the agents built`); return null }
        const base = this.loadBlueprint(rec.blueprint)
        if (!base || !base.expand) { this.say(ctx.bot, `${rec.blueprint} has no module to add`); return null }
        const bigger = withCrop(bp.expandBlueprint(base, rec.modules || 1), rec.crop)
        this.oneShot(m, 'build')
        return m.setOn('build', { blueprint: bigger, anchor: new Vec3(...rec.anchor), facing: rec.facing, modules: (rec.modules || 1) + 1, crop: rec.crop })
      }
      case 'farm': {
        let here = null
        let facing = null
        if (a.here) {
          const spot = a.at || this.ownerSpot()
          if (!spot) { this.say(ctx.bot, `I can't see you, ${this.owner}`); return null }
          here = spot.anchor
          facing = bp.facingTowardOwner(spot.yaw)
        }
        return m.setOn('farm', { crop: a.crop, here, facing })
      }
      case 'explore':
        this.oneShot(m, 'explore')
        return m.setOn('explore', { radius: a.radius })
      case 'design':
        return this.design(ctx, a)
      case 'blueprints':
        this.say(ctx.bot, `Blueprints: ${this.blueprintNames().join(', ')}`)
        return null
      case 'give':
        return m.setOn('give', {})
      case 'craft': return this.craft(ctx, a)
      case 'get':
        return this.runGoal(ctx, a, a.requester || this.owner).catch(err => {
          log(`${ctx.bot.username} goal ${a.item}: ${err.stack || err.message}`)
          ctx.plan = null
          this.say(ctx.bot, `I couldn't finish getting the ${String(a.item).replace(/_/g, ' ')}: ${err.message}`.slice(0, 200))
          return 'error'
        })
      case 'help':
        this.announce(helpText(a.topic))  // one answer, however many bots were asked
        return null
      case 'status':
        this.say(ctx.bot, this.statusLine(ctx))
        return null
      case 'doing':
        this.say(ctx.bot, ctx.announcer ? ctx.announcer.doing() : ctx.manager.status())
        return null
      case 'plan': {
        const pl = ctx.plan && ctx.plan.seq === ctx.seq ? ctx.plan : null
        if (!pl) { this.say(ctx.bot, 'No plan running'); return null }
        const left = pl.steps.slice(pl.index).map((s, i) => `${pl.index + i + 1}) ${s}`).join(' ')
        this.say(ctx.bot, `Step ${pl.index + 1} of ${pl.steps.length}, ${ctx.manager.status()}. ${left}`.slice(0, 250))
        return null
      }
      case 'danger':
        ctx.danger.update()
        log(`${ctx.bot.username} ${ctx.danger.summary(10)}`)
        this.say(ctx.bot, ctx.danger.summary(3).slice(0, 250))
        return null
      case 'human':
        ctx.human.setLevel(a.level)
        return null
      case 'quiet': case 'verbose':
        return null  // for all agents, set once in onOwnerMessage
    }
    return null
  }

  // A new blueprint from the owner's words through Claude Sonnet: checked, saved to server-agents/blueprints, its material
  // list said in chat before anything gets built. Resolves 'done' or 'error'
  async design (ctx, a) {
    const bot = ctx.bot
    if (this.loadBlueprint(a.blueprint)) {
      this.say(bot, `I already have ${a.blueprint}, building that one`)
      return 'done'
    }
    if (!this.designer.enabled) {
      this.say(bot, 'Drawing new blueprints needs ANTHROPIC_API_KEY in the environment or .env')
      return 'error'
    }
    const r = await this.designer.design(a.blueprint, a.words)
    if (r.error) {
      this.say(bot, `I couldn't draw ${a.blueprint}: ${r.error}`.slice(0, 200))
      return 'error'
    }
    const file = bp.saveBlueprint(r.blueprint, CUSTOM_BLUEPRINTS)
    log(`designed ${a.blueprint} (${r.attempts} tries), saved to ${file}`)
    const [x, y, z] = r.blueprint.size
    this.say(bot, `${a.blueprint} is ${x} by ${z}, ${y} high, it takes ${bp.describeItems(r.check.materials)}`.slice(0, 250))
    return 'done'
  }

  // A craft request to the crafter role (CraftMode in behaviors.js). Says what happens, returns the job's promise
  craft (ctx, a) {
    const mode = ctx.manager.get('craft')
    const requester = a.requester || this.owner
    const label = a.item.replace(/_/g, ' ')
    const r = mode.request({ item: a.item, requester, keep: !!a.keep })
    if (r === 'started') this.say(ctx.bot, a.keep ? `Crafting ${aOrAn(label)} to keep` : `Crafting ${aOrAn(label)} for ${requester}`)
    else if (r === 'queued') this.say(ctx.bot, `I'll craft the ${label} for ${requester} after ${mode.describe().replace(/^\w+ /, 'the ')}`)
    else if (r === 'duplicate') this.say(ctx.bot, `I'm already on your ${label}, ${requester}`)
    else if (r === 'ready') this.say(ctx.bot, `Your ${label} is ready, ${requester}, bringing it`)
    const job = [mode.job, ...mode.queue].find(j => j && j.item === a.item && j.requester === requester && !!j.keep === !!a.keep)
    return job ? job.done : null
  }

  statusLine (ctx) {
    const b = ctx.bot
    const p = b.entity.position
    const pick = b.inventory.items().find(i => i.name.endsWith('_pickaxe'))
    return `${ctx.manager.status()}, health ${Math.round(b.health)}, food ${b.food}, at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}` +
      `, ${pick ? pick.name.replace('_', ' ') : 'no pickaxe'}, human ${ctx.human.level}`
  }

  acknowledge (ctxs, command) {
    if (command.name === 'help' || command.name === 'status' || command.name === 'doing' || command.name === 'danger' || command.name === 'plan' || command.name === 'blueprints' || command.name === 'craft' || command.name === 'get') return  // those speak for themselves
    const who = ctxs.length === this.names.length && ctxs.length > 1 ? 'Agents' : ctxs.map(c => c.bot.username).join(', ')
    const a = command.args
    const text = {
      stop: 'stopped',
      kill: `killing within ${a.radius}${a.target ? `, target ${a.target}` : ''}`,
      guard: `guarding within ${a.radius}`,
      come: 'coming',
      follow: 'following',
      stay: 'staying here',
      mine: `mining ${a.count} ${a.block}`,
      gather: `gathering ${a.count} ${GATHER_KINDS[a.kind]?.unit || a.kind}`,
      give: 'bringing what I have',
      human: `human mode ${a.level}`,
      quiet: `chat news ${this.verbosity}`,
      verbose: `chat news ${this.verbosity}`,
      build: `building ${a.blueprint}${Array.isArray(a.site) ? ` at ${a.site.join(' ')}` : ' here'}`,
      farm: `farming ${a.crop}${a.here ? ' here' : ''}`,
      expand: `adding a module to ${a.build}`,
      explore: `exploring within ${a.radius}`,
      design: `drawing a blueprint for ${a.blueprint}`
    }[command.name] || formatCommand('all', command)
    this.say(ctxs[0].bot, `${who}: ${text}`)
  }

  close () {
    this.closing = true
    for (const ctx of this.ctxs.values()) {
      try { ctx.bot.quit('closing') } catch {}
    }
    this.policy.close()
    this.rcon?.close()
  }
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  requireOwner(opts.owner)
  const agents = new Agents(opts)
  const shutdown = () => {
    log('closing')
    agents.close()
    setTimeout(() => process.exit(0), 1500)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await agents.start()
  log(`agents ready: ${opts.names.join(', ')}, owner ${agents.owner}, fighter ${opts.run}`)
}

if (require.main === module) {
  main().catch(err => {
    log(err.stack || err.message)
    process.exit(1)
  })
}

module.exports = { Agents, Builds }
