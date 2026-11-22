// Keeps the evil god hunting the player until he ends it: one wave at a time, each read from where things stand now.
// The controller starts this after the first breach and ends it the moment evil mode turns off.

const scene = require('./scene')
const plans = require('./evil_plan')
const { EvilRaid, RUSH_WAIT_MS } = require('./evil_raid')
const { EVIL_LIMITS } = require('./settings')

const IGNITE_WAIT_MS = 3000 // a creeper at a wall gets this long to arrive before it is lit
const ALL_MOBS = `@e[tag=${scene.TAG_EVIL}]`

// How many of each mob a wave brings, inside the cap. A creeper comes when a wall stands in the way, and every third wave
function waveSize (wave, limits, alive, needBreach) {
  const room = Math.max(0, limits.maxAlive - alive)
  const creeper = room > 0 && (needBreach || wave % 3 === 0) ? 1 : 0
  const want = Math.min(limits.startZombies + Math.floor((wave - 1) / 2), limits.maxZombies)
  return { creeper, zombies: Math.min(want, room - creeper) }
}

class EvilHunt {
  constructor (host, brain, firstRaid) {
    this.host = host
    this.brain = brain
    this.limits = host.s.evil || EVIL_LIMITS
    this.raid = firstRaid
    this.wave = 1
    this.waveAt = host.timers.now()
    this.fighting = true
    this.holdUntil = 0
    this.lastWave = 'none yet'
    this.deathsSeen = 0
    this.respawning = false
    this.busy = false
    this.ended = false
    this.timer = null
  }

  async start () {
    const { host } = this
    await host.send(`scoreboard objectives add ${scene.DEATHS} deathCount`)
    this.deathsSeen = await host.deaths(host.s.player)
    if (this.ended) return
    this.timer = host.timers.setInterval(() => { this.tick().catch(() => {}) }, this.limits.pollMs)
  }

  end () {
    this.ended = true
    if (this.timer) this.host.timers.clearInterval(this.timer)
    this.timer = null
    this.raid?.end()
  }

  async tick () {
    if (this.busy || this.ended) return
    this.busy = true
    try {
      await this.step()
    } catch (err) {
      this.host.log(`evil hunt: ${err.message}`)
    } finally {
      this.busy = false
    }
  }

  async step () {
    const { host, limits } = this
    const P = host.s.player
    const deaths = await host.deaths(P)
    if (this.ended) return
    if (deaths > this.deathsSeen) {
      this.deathsSeen = deaths
      this.lastWave = 'the player died'
      this.respawning = true
      this.fighting = false
    }
    if (this.respawning) return this.awaitRespawn()
    const now = host.timers.now()
    if (now < this.holdUntil) return
    const alive = plans.parseCount(await host.send(`execute if entity ${ALL_MOBS}`))
    if (alive === null || this.ended) return
    if (this.fighting) {
      const overdue = now - this.waveAt >= limits.waveMaxMs
      if (!overdue && (alive > 0 || !this.raid.zombiesOut)) return
      if (alive === 0 && this.raid.zombiesOut) {
        this.lastWave = 'cleared'
        this.fighting = false
        this.holdUntil = now + limits.waveGapMs
        return
      }
      this.lastWave = 'still fighting'
    }
    await this.nextWave()
  }

  // Nothing lands on a dead player. Once he is back he gets a moment and some protection before the hunt goes on
  async awaitRespawn () {
    const { host, limits } = this
    const P = host.s.player
    const health = plans.parseHealth(await host.send(`data get entity ${P} Health`))
    if (this.ended || !(health > 0)) return
    this.respawning = false
    this.holdUntil = host.timers.now() + limits.graceMs
    const seconds = Math.ceil(limits.graceMs / 1000)
    await host.send(`effect give ${P} resistance ${seconds} 4 true`)
    if (!this.ended) await host.tell(`You are back. The hunt goes on in ${seconds} seconds.`)
  }

  async openWalls (layout) {
    const open = new Set()
    for (const p of plans.wallProbes(layout)) {
      if (this.ended) return []
      if (/passed/i.test(await this.host.send(`execute if block ${p.x} ${p.y} ${p.z} minecraft:air`))) open.add(p.wall)
    }
    return [...open]
  }

  async nextWave () {
    const { host, limits } = this
    const P = host.s.player
    this.raid.end() // whatever the last wave still had coming stays away, so the count below is the true one
    if (host.evilTimer) host.timers.clearTimeout(host.evilTimer)
    host.evilTimer = null
    const player = plans.parsePos(await host.send(`data get entity ${P} Pos`))
    if (this.ended || !player) return
    const layout = plans.layoutOf(host.stage)
    const away = !layout || plans.isAway(player, layout)
    const open = layout ? await this.openWalls(layout) : []
    if (this.ended) return
    const alive = plans.parseCount(await host.send(`execute if entity ${ALL_MOBS}`))
    if (alive === null || this.ended) return
    const side = open[0] || (layout ? plans.nearestWall(player, layout) : 'east')
    if (away && alive > 0) await host.send(plans.regatherCommand(P, player, side))
    if (this.ended) return
    const wave = this.wave + 1
    const size = waveSize(wave, limits, alive, !away && open.length === 0)
    if (size.creeper + size.zombies === 0) { // full up: this wave's mobs are still out there
      this.waveAt = host.timers.now()
      this.fighting = true
      return
    }
    const raid = this.raid = host.raid = new EvilRaid(host, this.brain)
    const scripted = { wall: side, approach: 'center', zombies: 'breach', line: null }
    await raid.planWave(scripted, {
      wave,
      walls_standing: Object.keys(plans.WALLS).filter(w => !open.includes(w)),
      walls_open: open,
      last_wave: this.lastWave,
      player_left_base: away,
      mobs_alive: alive,
      mobs_coming: size.creeper + size.zombies
    })
    if (this.ended) return
    const commands = plans.waveCommands(host.stage, raid.plan, { player, away, ...size })
    await raid.sendAll(commands.creeper)
    if (raid.plan.zombies === 'wait_rush' && size.creeper) await host.sleep(RUSH_WAIT_MS)
    if (this.ended) return
    await raid.sendAll(commands.zombies)
    if (this.ended) return
    if (host.directed) await host.send(`director start ${P}`)
    else if (size.creeper && !away) {
      await host.sleep(IGNITE_WAIT_MS)
      if (this.ended) return
      await raid.ignite()
    }
    if (this.ended) return
    this.wave = wave
    this.waveAt = host.timers.now()
    this.fighting = true
    host.log(`evil: wave ${wave}, ${size.zombies} zombies and ${size.creeper} creeper, ${away ? 'at the player' : `${raid.plan.wall} wall`}`)
    await host.tell(`Wave ${wave}.`)
  }
}

module.exports = { EvilHunt, waveSize }
