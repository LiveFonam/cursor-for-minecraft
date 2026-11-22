// One invasion from the plan to the last zombie. The controller keeps the order of events, and this holds the plan,
// asks the model at the moments that matter, and sends the commands. Without a brain it is the scripted breach.

const scene = require('./scene')
const plans = require('./evil_plan')

const WATCH_MS = 2000
const RUSH_WAIT_MS = 3000 // wait_rush: how long the zombies hold after the blast

class EvilRaid {
  // host: the controller (send, tell, sleep, timers, agents, stage, s, log, directed)
  constructor (host, brain) {
    this.host = host
    this.mind = brain?.invasion() || null
    this.plan = plans.FALLBACK_PLAN
    this.history = []
    this.blown = false
    this.zombiesOut = false
    this.zombies = null
    this.busy = false
    this.watcher = null
    this.ended = false
  }

  end () {
    this.ended = true
    this.stopWatch()
  }

  // Stops partway the moment the invasion is over, so a !reset never has mobs land after it
  async sendAll (commands) {
    for (const c of commands) {
      if (this.ended) return
      await this.host.send(c)
    }
  }

  async say (line) {
    if (line && !this.ended) await this.host.tell(plans.villainText(line))
  }

  async open () {
    if (!this.mind) return
    const situation = await this.situation('opening')
    if (this.ended) return
    if (!situation) {
      this.mind.broken = true
      this.host.log('evil-brain opening: scripted (situation not readable)')
      return
    }
    const plan = await this.mind.open(situation)
    if (this.ended) return
    this.plan = plan
    await this.say(plan.line)
  }

  summonCreeper () {
    return this.sendAll(plans.creeperCommands(this.host.stage, this.plan))
  }

  async summonZombies () {
    await this.sendAll(plans.zombieCommands(this.host.stage, this.plan))
    this.zombiesOut = true
  }

  ignite () {
    return this.sendAll(plans.igniteCommands(this.host.stage, this.plan))
  }

  // The wall has gone with no director on: one more decision, then the zombies come
  async invade () {
    if (this.ended) return
    this.blown = true
    this.history.push(`the creeper went off at the ${this.plan.wall} wall`)
    if (this.mind?.canAsk) {
      const move = await this.mind.adapt('wall_blew', await this.situation('wall_blew'))
      if (this.ended) return
      if (move) {
        this.plan = plans.withMove(this.plan, move.action)
        await this.say(move.line)
      }
    }
    if (this.plan.zombies === 'wait_rush') {
      await this.host.sleep(RUSH_WAIT_MS)
      if (this.ended) return
    }
    await this.summonZombies()
    this.watch()
  }

  watch () {
    if (this.watcher || this.ended || !this.mind?.canAsk) return
    this.watcher = this.host.timers.setInterval(() => { this.tick().catch(() => {}) }, WATCH_MS)
  }

  stopWatch () {
    if (this.watcher) this.host.timers.clearInterval(this.watcher)
    this.watcher = null
  }

  // Looks for the two moments worth a new decision: the wall going, and a zombie dying
  async tick () {
    if (this.busy || this.ended) return
    if (!this.mind.canAsk) {
      this.stopWatch()
      return
    }
    this.busy = true
    try {
      if (this.host.directed && !this.blown) {
        const creeper = await this.host.send(`execute if entity @e[tag=${scene.TAG_EVIL_CREEPER}]`)
        if (this.ended) return
        if (/failed/i.test(creeper)) {
          this.blown = true
          this.history.push('the creeper is gone')
          await this.react('wall_blew')
        }
      }
      if (this.ended) return
      const count = plans.parseCount(await this.host.send(`execute if entity @e[tag=${scene.TAG_EVIL},type=minecraft:zombie]`))
      if (count === null || this.ended) return
      const before = this.zombies
      this.zombies = count
      if (before !== null && count < before) {
        this.history.push(`a zombie died, ${count} left`)
        if (count > 0) await this.react('mob_died')
      }
      if (count === 0) this.stopWatch()
    } finally {
      this.busy = false
    }
  }

  // With the director on, it keeps the mobs: the model can still speak, but the script moves nothing
  async react (event) {
    if (!this.mind.canAsk) return
    const move = await this.mind.adapt(event, await this.situation(event))
    if (!move || this.ended) return
    await this.say(move.line)
    if (!this.host.directed) await this.sendAll(plans.moveCommands(this.host.stage, this.plan, move.action))
  }

  // Anything odd while looking around means no situation, and so no model call: the invasion carries on regardless
  async situation (event) {
    try {
      const P = this.host.s.player
      const player = plans.parsePos(await this.host.send(`data get entity ${P} Pos`))
      const playerHealth = plans.parseHealth(await this.host.send(`data get entity ${P} Health`))
      const bot = this.host.agents.agentBot()
      return plans.situationOf({
        event,
        stage: this.host.stage,
        plan: this.plan,
        history: this.history,
        player,
        playerHealth,
        agent: bot?.entity?.position || null,
        agentHealth: bot?.health ?? null,
        creeper: this.blown ? 0 : 1,
        zombiesOut: this.zombiesOut,
        zombies: this.zombies ?? 3
      })
    } catch {
      return null
    }
  }
}

module.exports = { EvilRaid, WATCH_MS, RUSH_WAIT_MS }
