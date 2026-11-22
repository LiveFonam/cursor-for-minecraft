// Plays the comparison rounds on a real server and writes one record per round, in the shape sim_side.py writes.
//
//   node real_side.js --policies scripted,random --rounds 150 --out real.json --rcon-file rcon.pw
//
// Every matchup has its own walled arena on one flat world. All bots run in this process, and a policy reads only the
// 130 inputs and the mask the Fighter builds from what its client received.

require('../patch-physics')
const fs = require('fs')
const mineflayer = require('mineflayer')
const { Rcon } = require('../rcon')
const { Fighter, SLOT_OF } = require('../fighter')
const { applyMineflayerFixes } = require('../mineflayer_fixes')
const { POLICIES } = require('./policies')
const { loadTrained } = require('./net')
const SPEC = require('./spec.json')

const FLOOR = 0
const SPACING = 160
const WALL_HEIGHT = 12
const SETTLE_TICKS = 24
const JOIN_GAP_MS = 400
const ROUND_RETRIES = 3
const MOB_WAIT_TICKS = 40
const RESPAWN_TICKS = 10
const ARMOR = ['head', 'chest', 'legs', 'feet'].map((slot, i) => [`armor.${slot}`, `${SPEC.armor}_${['helmet', 'chestplate', 'leggings', 'boots'][i]}`])
const KIT = [['hotbar.0', 'diamond_axe'], ['hotbar.1', 'diamond_sword'], ['hotbar.2', 'crossbow'], ['hotbar.3', 'bow'], ['weapon.offhand', 'shield']]
const MOB_NBT = {
  zombie: '{IsBaby:0b,CanPickUpLoot:0b,PersistenceRequired:1b}',
  skeleton: '{equipment:{mainhand:{id:"minecraft:bow",count:1}},CanPickUpLoot:0b,PersistenceRequired:1b}',
  creeper: '{PersistenceRequired:1b}',
  enderman: '{PersistenceRequired:1b}'
}
const RULES = [
  ['advance_time', 'doDaylightCycle', 'false'], ['advance_weather', 'doWeatherCycle', 'false'],
  ['spawn_mobs', 'doMobSpawning', 'false'], ['natural_health_regeneration', 'naturalRegeneration', 'false'],
  ['random_tick_speed', 'randomTickSpeed', '0'], ['immediate_respawn', 'doImmediateRespawn', 'true'],
  ['spawn_phantoms', 'doInsomnia', 'false'], ['mob_griefing', 'mobGriefing', 'false'],
  ['show_death_messages', 'showDeathMessages', 'false'], ['send_command_feedback', 'sendCommandFeedback', 'false']
]

function args () {
  const out = { host: '127.0.0.1', port: 25594, rconPort: 25595, policies: 'scripted', rounds: 150, seed: 9001, opponents: [...SPEC.mobs, ...SPEC.bots].join(',') }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i += 2) out[a[i].slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = a[i + 1]
  for (const k of ['port', 'rconPort', 'rounds', 'seed']) out[k] = Number(out[k])
  return out
}

// A small seeded generator, so a run can be repeated
function mulberry (seed) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6D2B79F5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const uniform = (rng, lo, hi) => lo + rng() * (hi - lo)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

async function joinBot (name, opt) {
  const bot = mineflayer.createBot({ host: opt.host, port: opt.port, username: name, version: '1.21.11', auth: 'offline', viewDistance: 'short', checkTimeoutInterval: 120000 })
  bot.setMaxListeners(60)
  bot.on('error', e => console.log(`bot error ${name}: ${e.message}`))
  bot.on('kicked', r => console.log(`kicked ${name}: ${JSON.stringify(r).slice(0, 160)}`))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`spawn timeout ${name}`)), 60000)
    bot.once('spawn', () => { clearTimeout(timer); resolve() })
    bot.once('end', r => { clearTimeout(timer); reject(new Error(`ended ${name}: ${r}`)) })
  })
  applyMineflayerFixes(bot)
  return bot
}

class Match {
  constructor (index, policy, opponent, rcon, opt, makePolicy) {
    this.index = index
    this.policyName = policy
    this.opponent = opponent
    this.rcon = rcon
    this.opt = opt
    this.isMob = SPEC.mobs.includes(opponent)
    this.center = { x: (index + 1) * SPACING, y: FLOOR, z: 0, half: SPEC.arena_half }
    this.rng = mulberry(opt.seed + index * 1009)
    this.policy = makePolicy(policy)
    this.other = this.isMob ? null : POLICIES[opponent]
    this.records = []
    this.failures = 0
  }

  async join () {
    const tag = String(this.index).padStart(2, '0')
    this.nameA = `Rc${tag}A`
    this.nameB = `Rc${tag}B`
    this.botA = await joinBot(this.nameA, this.opt)
    await sleep(JOIN_GAP_MS)
    if (!this.isMob) {
      this.botB = await joinBot(this.nameB, this.opt)
      await sleep(JOIN_GAP_MS)
    }
    const allowed = this.isMob ? new Set(['axe']) : null
    this.fa = new Fighter(this.botA, this.isMob ? null : this.nameB, { arena: this.center, allowedWeapons: allowed, planRules: false })
    if (!this.isMob) this.fb = new Fighter(this.botB, this.nameA, { arena: this.center, planRules: false })
    this.watchDeaths()
  }

  watchDeaths () {
    this.botA.on('death', () => { this.deadA = true })
    if (this.botB) this.botB.on('death', () => { this.deadB = true })
    this.botA.on('entityDead', e => { if (this.mob && e.id === this.mob.id) this.mobDead = true })
    this.botA.on('entityGone', e => { if (this.mob && e.id === this.mob.id) this.mobGone = true })
  }

  async buildArena () {
    const { x, z, half } = this.center
    const [lo, hi, top] = [-half - 1, half, FLOOR + WALL_HEIGHT]
    await this.rcon.send(`forceload add ${x - 32} ${z - 32} ${x + 32} ${z + 32}`)
    await sleep(300)
    await this.rcon.send(`fill ${x + lo} ${FLOOR} ${z + lo} ${x + hi} ${top} ${z + lo} minecraft:barrier`)
    await this.rcon.send(`fill ${x + lo} ${FLOOR} ${z + hi} ${x + hi} ${top} ${z + hi} minecraft:barrier`)
    await this.rcon.send(`fill ${x + lo} ${FLOOR} ${z + lo} ${x + lo} ${top} ${z + hi} minecraft:barrier`)
    await this.rcon.send(`fill ${x + hi} ${FLOOR} ${z + lo} ${x + hi} ${top} ${z + hi} minecraft:barrier`)
  }

  async kit (name) {
    const cmds = [`clear ${name}`, `effect clear ${name}`, `effect give ${name} minecraft:instant_health 1 10 true`,
      `effect give ${name} minecraft:saturation 1 20 true`]
    for (const [slot, item] of [...ARMOR, ...KIT]) cmds.push(`item replace entity ${name} ${slot} with minecraft:${item}`)
    cmds.push(`item replace entity ${name} inventory.0 with minecraft:arrow ${SPEC.arrows}`)
    for (const c of cmds) await this.rcon.send(c)
  }

  // The spawn rule of the simulator: a random middle point, a random distance and direction, each facing the other
  // within the face noise
  spawnPoints () {
    const margin = SPEC.spawn_max / 2 + 0.5
    const room = Math.max(SPEC.arena_half - margin, 0)
    const [cx, cz] = [uniform(this.rng, -room, room), uniform(this.rng, -room, room)]
    const dist = uniform(this.rng, SPEC.spawn_min, SPEC.spawn_max)
    const angle = uniform(this.rng, 0, 2 * Math.PI)
    const [ox, oz] = [Math.cos(angle) * dist / 2, Math.sin(angle) * dist / 2]
    const a = { x: cx - ox, z: cz - oz }
    const b = { x: cx + ox, z: cz + oz }
    const facing = Math.atan2(-(b.x - a.x), b.z - a.z) * 180 / Math.PI
    a.yaw = facing + uniform(this.rng, -SPEC.face_noise, SPEC.face_noise)
    b.yaw = facing + 180 + uniform(this.rng, -SPEC.face_noise, SPEC.face_noise)
    return { a, b }
  }

  async place (name, bot, p, slot) {
    const { x, z } = this.center
    const [wx, wz] = [x + p.x, z + p.z]
    await this.rcon.send(`tp ${name} ${wx.toFixed(3)} ${FLOOR} ${wz.toFixed(3)} ${p.yaw.toFixed(2)} 0`)
    bot.setQuickBarSlot(slot)
    for (let i = 0; i < 80; i++) {
      await bot.waitForTicks(1)
      const at = bot.entity.position
      if (Math.hypot(at.x - wx, at.z - wz) < 0.2 && Math.abs(at.y - FLOOR) < 0.1 && bot.health >= 19.9) return true
    }
    return false
  }

  async spawnMob (a) {
    const { x, z, half } = this.center
    const angle = uniform(this.rng, 0, 2 * Math.PI)
    const radius = uniform(this.rng, SPEC.mob_spawn_min, SPEC.mob_spawn_max)
    const edge = half - 0.6
    const mx = x + clamp(a.x + radius * Math.cos(angle), -edge, edge)
    const mz = z + clamp(a.z + radius * Math.sin(angle), -edge, edge)
    const before = new Set(Object.keys(this.botA.entities))
    await this.rcon.send(`summon minecraft:${this.opponent} ${mx.toFixed(3)} ${FLOOR} ${mz.toFixed(3)} ${MOB_NBT[this.opponent]}`)
    for (let i = 0; i < MOB_WAIT_TICKS; i++) {
      await this.botA.waitForTicks(1)
      const found = Object.values(this.botA.entities).find(e => e.name === this.opponent && !before.has(String(e.id)))
      if (found) return found
    }
    return null
  }

  async prepare () {
    const { x, z, half } = this.center
    const size = 2 * half + 2
    await this.rcon.send(`kill @e[type=!player,x=${x - half - 1},y=${FLOOR - 2},z=${z - half - 1},dx=${size},dy=40,dz=${size}]`)
    // A player that just died needs its respawn before the console can give it anything
    if (this.deadA) await this.botA.waitForTicks(RESPAWN_TICKS)
    if (this.deadB) await this.botB.waitForTicks(RESPAWN_TICKS)
    this.deadA = false
    this.deadB = false
    this.mob = null
    this.mobDead = false
    this.mobGone = false
    await this.kit(this.nameA)
    if (!this.isMob) await this.kit(this.nameB)
    this.fa.stopEverything()
    if (this.fb) this.fb.stopEverything()
    const { a, b } = this.spawnPoints()
    if (this.isMob) a.yaw = uniform(this.rng, -180, 180)
    const startSlot = this.isMob ? SLOT_OF.axe : SLOT_OF.sword
    let ok = await this.place(this.nameA, this.botA, a, startSlot)
    if (!this.isMob) ok = (await this.place(this.nameB, this.botB, b, SLOT_OF.sword)) && ok
    if (!ok) return false
    await this.botA.waitForTicks(SETTLE_TICKS)
    if (this.isMob) {
      this.mob = await this.spawnMob(a)
      if (!this.mob) return false
      this.fa.enemy.lookup = () => {
        const e = this.botA.entities[this.mob.id]
        return e && e.isValid !== false ? e : null
      }
    }
    this.fa.reset(true)
    this.fa.enemy.reset()
    if (this.fb) { this.fb.reset(true); this.fb.enemy.reset() }
    this.botA.setQuickBarSlot(startSlot)
    if (this.botB) this.botB.setQuickBarSlot(SLOT_OF.sword)
    return true
  }

  enemyHealth () {
    if (this.isMob) {
      const h = this.botA.entities[this.mob.id]?.metadata?.[9]
      return typeof h === 'number' ? h : this.lastEnemy
    }
    return this.deadB ? 0 : this.botB.health
  }

  async playRound () {
    const maxSteps = SPEC.round_ticks / SPEC.ticks_per_decision
    const tally = { damage_dealt: 0, damage_taken: 0, swings: 0, hits: 0, shots: 0, arrow_hits: 0 }
    let myHealth = this.botA.health
    this.lastEnemy = this.isMob ? (this.botA.entities[this.mob.id]?.metadata?.[9] ?? (this.opponent === 'enderman' ? 40 : 20)) : this.botB.health
    let steps = 0
    let result = { win: 0, loss: 0 }
    for (; steps < maxSteps; steps++) {
      this.fa.act(this.policy(this.fa.observe(), this.fa.masks(), steps, this.rng))
      if (this.fb) this.fb.act(this.other(this.fb.observe(), this.fb.masks(), steps, this.rng))
      await this.botA.waitForTicks(SPEC.ticks_per_decision)
      const mine = this.deadA ? 0 : this.botA.health
      tally.damage_taken += Math.max(myHealth - mine, 0)
      myHealth = mine
      const theirs = this.mobDead ? 0 : this.enemyHealth()
      tally.damage_dealt += Math.max(this.lastEnemy - theirs, 0)
      this.lastEnemy = theirs
      const blast = this.isMob && this.opponent === 'creeper' && this.mobGone && !this.mobDead
      if (this.deadA) { result = { win: 0, loss: 1 }; steps++; break }
      if (this.isMob ? this.mobDead : this.deadB) { result = { win: 1, loss: 0 }; steps++; break }
      if (blast) { steps++; break }
    }
    this.fa.stopEverything()
    if (this.fb) this.fb.stopEverything()
    const ev = this.fa.takeEvents()
    tally.swings = ev.swings
    tally.hits = ev.meleeDamaged
    tally.shots = ev.shots
    tally.arrow_hits = ev.arrowHits
    for (const k of Object.keys(tally)) tally[k] = Math.round(tally[k] * 10000) / 10000
    return { ...result, ticks: steps * SPEC.ticks_per_decision, ...tally }
  }

  async run () {
    while (this.records.length < this.opt.rounds) {
      let ready = false
      for (let i = 0; i < ROUND_RETRIES && !ready; i++) ready = await this.prepare()
      if (!ready) { this.failures++; if (this.failures > 20) throw new Error(`${this.key()} cannot start rounds`); continue }
      this.records.push(await this.playRound())
      if (this.records.length % 10 === 0) {
        const wins = this.records.reduce((n, r) => n + r.win, 0)
        console.log(`${this.key()} ${this.records.length}/${this.opt.rounds} rounds, ${wins} wins`)
        this.opt.save()
      }
    }
  }

  key () { return `${this.policyName}/${this.opponent}` }
}

async function setupWorld (rcon) {
  for (const [name, older, value] of RULES) {
    const r = await rcon.send(`gamerule ${name} ${value}`)
    if (/unknown|incorrect|error/i.test(r)) await rcon.send(`gamerule ${older} ${value}`)
  }
  for (const c of ['time set 18000', 'weather clear', `difficulty ${SPEC.difficulty}`]) await rcon.send(c)
}

async function main () {
  const opt = args()
  const password = fs.readFileSync(opt.rconFile, 'utf8').trim()
  const rcon = new Rcon(opt.host, opt.rconPort, password)
  await rcon.connect()
  await setupWorld(rcon)
  const trained = opt.weights ? loadTrained(opt.weights) : null
  const makePolicy = name => {
    if (name === 'trained') return (obs, mask) => trained.act(obs, mask)
    return POLICIES[name]
  }
  const matches = []
  for (const p of opt.policies.split(',')) {
    for (const o of opt.opponents.split(',')) matches.push(new Match(matches.length, p, o, rcon, opt, makePolicy))
  }
  opt.save = () => {
    const out = { side: 'real', matchups: {} }
    for (const m of matches) (out.matchups[m.policyName] ??= {})[m.opponent] = m.records
    fs.writeFileSync(`${opt.out}.partial`, JSON.stringify(out))
    fs.renameSync(`${opt.out}.partial`, opt.out)
  }
  for (const m of matches) { await m.join(); await m.buildArena() }
  console.log(`${matches.length} arenas ready`)
  const results = await Promise.allSettled(matches.map(m => m.run()))
  opt.save()
  results.forEach((r, i) => { if (r.status === 'rejected') console.log(`failed ${matches[i].key()}: ${r.reason.message}`) })
  for (const m of matches) {
    const wins = m.records.reduce((n, r) => n + r.win, 0)
    console.log(`${m.key()}: ${wins}/${m.records.length} wins, ${m.failures} failed setups`)
  }
  for (const m of matches) { m.botA.quit(); m.botB?.quit() }
  await sleep(500)
  process.exit(results.some(r => r.status === 'rejected') ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
