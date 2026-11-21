// The mob director on a real server, end to end. Needs the server running with the MobDirector plugin
// (node director/scripts/build.js), a flat world, RCON on, and nobody else on it (see director/README.md).
// CrewTester joins as the target player; each scene builds the demo arena over RCON, places the "existing" mobs,
// starts the director against CrewTester and reads `director status json` once a second.
//
//   node director/scripts/live-test.js            every scene
//   node director/scripts/live-test.js gate_open  one scene, or several joined by commas
//
// Scenes: gate_open, gate_closed, creeper_killed, blast_fails, underground, skeleton, stop_spawns, disconnect, death
//
// The arena (also in director/config.yml): a 7 by 7 yard at 0 -60 0 on the flat world, cobblestone
// walls 3 high at x and z = -4 and +4, an oak fence gate in the north wall at 0 -60 -4. RCON sets each scene up (it
// clears the area, rebuilds the walls, summons the mobs, sets the night); the director only ever uses mobs, their own
// pathfinding, the normal creeper fuse and the game's explosion.

const fs = require('fs')
const path = require('path')
const { Rcon } = require('./rcon')

const ROOT = path.join(__dirname, '..', '..')
const SERVER = process.env.MOB_DIRECTOR_SERVER ? path.resolve(process.env.MOB_DIRECTOR_SERVER) : path.join(ROOT, 'crew', 'server')
// Mineflayer comes from the crew (npm install in crew/ first)
let mineflayer
try { mineflayer = require(path.join(ROOT, 'crew', 'node_modules', 'mineflayer')) } catch {
  console.error('Mineflayer is missing: run npm install in crew/ first')
  process.exit(1)
}
const crewConfig = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'crew', 'crew.config.json'), 'utf8')) } catch { return {} } })()
const CONFIG = {
  host: process.env.CREW_HOST || crewConfig.host || '127.0.0.1',
  port: parseInt(process.env.CREW_PORT || crewConfig.port || 25565, 10),
  version: process.env.CREW_VERSION || crewConfig.version || '1.21.4'
}
const TESTER = 'CrewTester'
const Y = -60
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (...a) => console.log(`[director ${new Date().toTimeString().slice(0, 8)}]`, ...a)

function rconSettings () {
  const props = Object.fromEntries(fs.readFileSync(path.join(SERVER, 'server.properties'), 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
  return { port: parseInt(props['rcon.port'], 10), password: props['rcon.password'] }
}

class Live {
  constructor (rcon, player) {
    this.rcon = rcon
    this.player = player
    this.trace = []
  }

  // Every drop of the target's health from now on (a hit), until done()
  countHits () {
    const h = { n: 0, last: this.player.health }
    const on = () => { if (this.player.health < h.last - 0.01) h.n++; h.last = this.player.health }
    this.player.on('health', on)
    h.done = () => this.player.removeListener('health', on)
    return h
  }

  cmd (c) { return this.rcon.send(c).then(r => String(r).replace(/§./g, '')) }

  async status () {
    const r = await this.cmd('director status json')
    try { return JSON.parse(r.slice(r.indexOf('{'))) } catch { return { tactic: '?', reason: r } }
  }

  // Polls the status until done(status) or the time runs out, keeping every change of tactic or reason
  async watch (done, ms, label) {
    const end = Date.now() + ms
    let last = ''
    while (Date.now() < end) {
      const s = await this.status()
      const line = `${s.tactic}: ${s.reason}${s.ignited ? ' [fuse lit]' : ''}`
      if (process.env.DIRECTOR_DEBUG && Date.now() % 2000 < 1000) log(`    ${s.tactic} hp ${this.player.health?.toFixed(1)} ${(s.mobs || []).map(m => `${m.type} ${m.state} ${m.dist}`).join(', ')}`)
      if (line !== last) {
        last = line
        this.trace.push({ t: new Date().toISOString(), tactic: s.tactic, reason: s.reason, ignited: s.ignited, mobs: s.mobs, lastBreach: s.lastBreach })
        log(`  ${line}`)
      }
      if (done(s)) return s
      await sleep(1000)
    }
    throw new Error(`${label || 'condition'} not reached within ${ms / 1000} s`)
  }

  async blockIs (x, y, z, block) {
    const r = await this.cmd(`execute if block ${x} ${y} ${z} ${block}`)
    return /passed/i.test(r)
  }

  async count (selector) {
    const r = await this.cmd(`execute if entity ${selector}`)
    const m = r.match(/Count: (\d+)/i)
    return m ? parseInt(m[1], 10) : 0
  }
}

// The flat ground and the demo arena, rebuilt for every scene
async function arena (live, { gate = 'open', walls = 'single', roofless = true } = {}) {
  const c = live.cmd.bind(live)
  await c('director stop')
  await c('kill @e[type=!player]')
  await c(`fill -24 ${Y} -24 24 ${Y + 8} 24 air`)
  await c(`fill -24 ${Y - 1} -24 24 ${Y - 1} 24 grass_block`)
  await c(`fill -24 ${Y - 3} -24 24 ${Y - 2} 24 dirt`)
  if (walls !== 'none') {
    const rings = walls === 'double' ? [4, 5] : [4]
    for (const r of rings) {
      await c(`fill ${-r} ${Y} ${-r} ${r} ${Y + 2} ${-r} cobblestone`)
      await c(`fill ${-r} ${Y} ${r} ${r} ${Y + 2} ${r} cobblestone`)
      await c(`fill ${-r} ${Y} ${-r} ${-r} ${Y + 2} ${r} cobblestone`)
      await c(`fill ${r} ${Y} ${-r} ${r} ${Y + 2} ${r} cobblestone`)
    }
    // the inside stays clear
    await c(`fill -3 ${Y} -3 3 ${Y + 2} 3 air`)
    if (gate !== 'none') {
      await c(`setblock 0 ${Y} -4 oak_fence_gate[facing=north,open=${gate === 'open'}]`)
      await c(`fill 0 ${Y + 1} -4 0 ${Y + 2} -4 air`)
    }
  }
  // test world setup only: monsters need a difficulty above peaceful, and night keeps zombies from burning
  await c('difficulty normal')
  // and no natural spawns, so the only mobs are the ones a scene places (or the director calls in)
  // 1.21.11 renamed the gamerules (spawn_mobs), 1.21.4 still has doMobSpawning
  if (/Incorrect|Unknown/i.test(await c('gamerule doMobSpawning false'))) await c('gamerule spawn_mobs false')
  await c('time set 18000')
  await c('weather clear')
  await c(`gamemode survival ${TESTER}`)
  await c(`clear ${TESTER}`)
  await c(`effect clear ${TESTER}`)
  // so the test player lives through a few hits and the scene can be read (damage still lands and shows)
  await c(`effect give ${TESTER} resistance 600 2 true`)
  await c(`effect give ${TESTER} instant_health 1 10 true`)
  await c(`tp ${TESTER} 0.5 ${Y} 0.5 0 0`)
  await sleep(1500)
}

// a summon with data skips the normal spawn setup, so a skeleton gets its bow here
// (1.21.5 moved hand items to equipment:{mainhand:...}; 1.21.4 still reads HandItems)
const minor = parseInt(String(CONFIG.version).split('.')[2] || '0', 10)
const BOW = minor >= 5 ? ',equipment:{mainhand:{id:"minecraft:bow",count:1}}' : ',HandItems:[{id:"minecraft:bow",count:1},{}]'
const summon = (live, type, x, z, y = Y) => live.cmd(`summon ${type} ${x + 0.5} ${y} ${z + 0.5} {PersistenceRequired:1b${type === 'skeleton' ? BOW : ''}}`)

const SCENES = {
  // the gate stands open: the zombies' own pathfinder finds the way in, they attack
  async gate_open (live) {
    await arena(live, { gate: 'open' })
    await summon(live, 'zombie', 0, -14)
    await summon(live, 'zombie', 3, -15)
    await summon(live, 'creeper', -6, -13)
    const hp = live.player.health
    await live.cmd(`director start ${TESTER}`)
    const s = await live.watch(s => s.tactic === 'ASSAULT', 15000, 'ASSAULT')
    // the zombies walk the 15 steps in and hit: the target's health drops (counted as it happens, it heals fast)
    const hits = live.countHits()
    try { await live.watch(() => hits.n >= 2, 30000, 'hits') } catch {}
    hits.done()
    const hit = hits.n >= 2
    return { ok: s.tactic === 'ASSAULT' && hit, tactic: s.tactic, reason: s.reason, testerHurt: hit, recruited: s.mobs.length }
  },

  // the gate is shut: one creeper walks to the gate, the zombies hold back, the fuse, the blast, then the attack
  async gate_closed (live) {
    await arena(live, { gate: 'closed' })
    await summon(live, 'zombie', 0, -14)
    await summon(live, 'zombie', 3, -15)
    await summon(live, 'creeper', -6, -13)
    await live.cmd(`director start ${TESTER}`)
    const b = await live.watch(s => s.tactic === 'BREACH', 15000, 'BREACH')
    const held = b.mobs.filter(m => m.role === 'MELEE').every(m => /holding/.test(m.state))
    const lit = await live.watch(s => s.ignited || s.tactic !== 'BREACH', 45000, 'fuse')
    const after = await live.watch(s => s.tactic !== 'BREACH', 20000, 'after the blast')
    const gateGone = !(await live.blockIs(0, Y, -4, 'oak_fence_gate'))
    const hits = live.countHits()
    if (after.tactic === 'ASSAULT') await waitFor(() => hits.n >= 1, 30000)
    hits.done()
    const hit = hits.n >= 1
    return { ok: b.reason.includes('gate') && lit.ignited !== undefined && after.tactic === 'ASSAULT' && gateGone, breachReason: b.reason, zombiesHeldBack: held, lastBreach: after.lastBreach, gateGone, testerHurt: hit }
  },

  // the player kills the creeper on its way: the breach fails, the gate stays, a cooldown
  async creeper_killed (live) {
    await arena(live, { gate: 'closed' })
    await summon(live, 'zombie', 0, -14)
    await summon(live, 'creeper', -10, -16)
    await live.cmd(`director start ${TESTER}`)
    await live.watch(s => s.tactic === 'BREACH' && !s.ignited, 15000, 'BREACH')
    // a hit from the player (CrewTester), the way a sword or a bow kills it
    await live.cmd(`damage @e[type=creeper,tag=director,limit=1] 100 minecraft:player_attack by ${TESTER}`)
    const s = await live.watch(s => /killed/.test(s.lastBreach || ''), 10000, 'breach failed')
    const gateIntact = await live.blockIs(0, Y, -4, 'oak_fence_gate')
    return { ok: s.tactic === 'WAIT' && s.cooldown > 0 && gateIntact, tactic: s.tactic, reason: s.reason, lastBreach: s.lastBreach, cooldown: s.cooldown, gateIntact }
  },

  // a 2 thick cobblestone wall all round and no gate: the director still tries the thinnest wall; a creeper blast
  // rarely gets through 2 blocks of cobblestone, and then it must see there is no way in and back off
  async blast_fails (live) {
    await arena(live, { gate: 'none', walls: 'double' })
    await summon(live, 'zombie', 0, -14)
    await summon(live, 'creeper', -3, -12)
    await live.cmd(`director start ${TESTER}`)
    const b = await live.watch(s => s.tactic === 'BREACH', 15000, 'BREACH')
    const after = await live.watch(s => s.tactic !== 'BREACH', 60000, 'after the blast')
    const opened = /^opened/.test(after.lastBreach || '')
    return { ok: opened ? after.tactic === 'ASSAULT' : (after.tactic === 'WAIT' && after.cooldown > 0 && /no way in/.test(after.lastBreach)), breachReason: b.reason, result: opened ? 'the blast opened the wall' : 'the blast left no way in', tactic: after.tactic, reason: after.reason, lastBreach: after.lastBreach, cooldown: after.cooldown }
  },

  // a shallow room under the grass (3 by 3, the grass is the roof, the way down closed): a creeper on top
  async underground (live) {
    await arena(live, { walls: 'none' })
    await live.cmd(`fill -1 ${Y - 3} 9 1 ${Y - 2} 11 air`)
    await live.cmd(`tp ${TESTER} 0.5 ${Y - 3} 10.5`)
    await summon(live, 'zombie', 10, 18)
    await summon(live, 'creeper', -8, 16)
    await sleep(1000)
    await live.cmd(`director start ${TESTER}`)
    const b = await live.watch(s => s.tactic === 'BREACH' || s.tactic === 'WAIT', 15000, 'a plan')
    let after = b
    if (b.tactic === 'BREACH') after = await live.watch(s => s.tactic !== 'BREACH', 60000, 'after the blast')
    const roofOpen = !(await live.blockIs(0, Y - 1, 10, 'grass_block')) || !(await live.blockIs(1, Y - 1, 10, 'grass_block')) || !(await live.blockIs(-1, Y - 1, 10, 'grass_block'))
    return { ok: b.tactic === 'BREACH' && /roof/.test(b.reason), plan: b.reason, tactic: after.tactic, reason: after.reason, lastBreach: after.lastBreach, roofOpen }
  },

  // ranged support: an open gate, a skeleton outside it shoots once it sees the player
  async skeleton (live) {
    await arena(live, { gate: 'open' })
    await summon(live, 'skeleton', 0, -12)
    await summon(live, 'zombie', 6, -14)
    await live.cmd(`director start ${TESTER}`)
    const s = await live.watch(s => s.mobs.some(m => m.role === 'RANGED' && /attacking|shooting/.test(m.state)), 20000, 'skeleton shooting')
    let seen = 0
    const onSpawn = e => { if (e.name === 'arrow') seen++ }
    live.player.on('entitySpawn', onSpawn)
    const hits = live.countHits()
    const arrows = await waitFor(() => seen > 0, 20000)
    live.player.removeListener('entitySpawn', onSpawn)
    hits.done()
    const hurt = hits.n > 0
    return { ok: arrows, skeleton: s.mobs.find(m => m.role === 'RANGED'), arrowsSeen: seen, testerHurt: hurt }
  },

  // no mobs near: it calls in reinforcements (at most 2), stop ends that: no spawn after the stop
  async stop_spawns (live) {
    await arena(live, { gate: 'closed' })
    await live.cmd(`director start ${TESTER}`)
    const s = await live.watch(st => st.reinforcements >= 1, 20000, 'a reinforcement')
    const spawned = s.mobs.filter(m => m.spawned)
    await live.cmd('director stop')
    const before = await live.count('@e[type=#minecraft:skeletons]') + await live.count('@e[type=zombie]') + await live.count('@e[type=creeper]')
    const tagged = await live.count('@e[tag=director]')
    await sleep(25000)
    const after = await live.count('@e[type=#minecraft:skeletons]') + await live.count('@e[type=zombie]') + await live.count('@e[type=creeper]')
    const idle = await live.status()
    return { ok: after <= before && tagged === 0 && idle.tactic === 'STOPPED', spawnedBeforeStop: spawned.map(m => m.type), mobsAtStop: before, mobsAfter25s: after, stillTagged: tagged, status: idle.reason }
  },

  // the target logs out: the encounter ends and lets go of its mobs
  async disconnect (live) {
    await arena(live, { gate: 'closed' })
    await summon(live, 'zombie', 0, -14)
    await live.cmd(`director start ${TESTER}`)
    await live.watch(s => s.tactic !== 'STARTING', 10000, 'a tactic')
    live.player.quit()
    await sleep(3000)
    const s = await live.status()
    const tagged = await live.count('@e[tag=director]')
    live.player = await join()
    return { ok: s.tactic === 'STOPPED' && /disconnected/.test(s.reason) && tagged === 0, status: s.reason, stillTagged: tagged }
  },

  // the target dies: the encounter ends
  async death (live) {
    await arena(live, { gate: 'open' })
    await summon(live, 'zombie', 0, -14)
    await live.cmd(`director start ${TESTER}`)
    await live.watch(s => s.tactic === 'ASSAULT', 15000, 'ASSAULT')
    await live.cmd(`effect clear ${TESTER}`)
    await live.cmd(`kill ${TESTER}`)
    await sleep(2000)
    const s = await live.status()
    await sleep(2000)
    return { ok: s.tactic === 'STOPPED' && /died/.test(s.reason), status: s.reason }
  }
}

async function waitFor (fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(500)
  }
  return false
}

function join () {
  const player = mineflayer.createBot({ host: CONFIG.host, port: CONFIG.port, username: TESTER, version: CONFIG.version, auth: 'offline' })
  return new Promise((resolve, reject) => {
    player.once('spawn', () => setTimeout(() => resolve(player), 1500))
    player.once('error', reject)
  })
}

async function main () {
  const pick = process.argv[2] ? process.argv[2].split(',') : Object.keys(SCENES)
  const rc = rconSettings()
  const rcon = new Rcon(CONFIG.host, rc.port, rc.password)
  await rcon.connect()
  const probe = String(await rcon.send('director status'))
  if (/Unknown/i.test(probe)) { console.error('The MobDirector plugin is not loaded: build it and restart the server'); process.exit(1) }
  const live = new Live(rcon, await join())
  const results = {}
  let failed = 0
  for (const name of pick) {
    log(`scene ${name}`)
    live.trace = []
    try {
      const r = await SCENES[name](live)
      results[name] = { ...r, trace: live.trace }
      if (!r.ok) failed++
      const { trace, ...shown } = results[name]
      log(`scene ${name}: ${r.ok ? 'PASS' : 'FAIL'} ${JSON.stringify(shown)}`)
    } catch (err) {
      failed++
      results[name] = { ok: false, error: err.message, trace: live.trace }
      log(`scene ${name}: FAIL ${err.message}`)
    }
    await live.cmd('director stop')
  }
  const out = path.join(ROOT, 'runs', 'crew-tests', 'director_live.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
  log(`${pick.length - failed}/${pick.length} scenes passed, results in ${path.relative(ROOT, out)}`)
  live.player.quit()
  rcon.close()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}

main().catch(err => { console.error(err); process.exit(1) })
