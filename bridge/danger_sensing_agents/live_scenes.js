// The live scenes for what the gather, job and iron scenes in livetest.js do not prove: every craft, handing items over
// while facing the owner, the trained mob network in fights, the food rules, and plain English chat. They run through
// livetest.js like any other scene and pass only on what the server reports.
//
//   node bridge/danger_sensing_agents/livetest.js net_zombie      one scene
//
//   craft_every, handover_facing
//   net_zombie, net_skeleton, net_creeper, net_enderman, net_group2, net_group3, net_group4, net_cave, net_water, net_ledge
//   food_ready_first, food_cook, food_early, food_mission
//   chat_english
//
// A fight passes when the server counts every mob killed by the bot, the bot did not die, the log shows the trained
// network fought with no scripted fallback, and it did not flip between fighting and running. The chat scene and the
// translate scene share a limit of HAIKU_CAP paid calls, counted in the file named by AGENTS_HAIKU_LEDGER.

const fs = require('fs')
const path = require('path')

const TAG = 'livefight'
const FIGHT_KIT = [['diamond_axe', 1], ['shield', 1]]   // an axe is the only weapon the network trained with
// The armor it trained in (fighter mob_drill.py SimConfig(armor="iron"), a plain full set with no enchantments), put
// on by the server because the bot does not dress itself
const CAMERA_WAIT_MS = 120000
const FIGHT_ARMOR = [['armor.head', 'iron_helmet'], ['armor.chest', 'iron_chestplate'], ['armor.legs', 'iron_leggings'], ['armor.feet', 'iron_boots']]
const FIGHT_MODES = new Set(['mobfight', 'defend', 'kill', 'guard'])
const RUN_MODES = new Set(['retreat', 'avoid', 'escape'])
// A stand or a run holds for 6 s (decideFlee in threats.js), so a bot that keeps to it changes side at most 10 times a
// minute. More than 6 is flipping, and so is any change of side that comes within 2 s of the last one
const MAX_FLIPS_PER_MIN = 6
const RAPID_FLIP_MS = 2000
const MAX_TOSS_ANGLE = 45     // degrees between the throw and the line to the owner
const TORCH_EVERY = 32        // blocks of tunnel per torch, the miner's own rule (skills/mine.js)
const TORCHES_PER_COAL = 4
const HUNGRY = 14             // food_plan.js: below this it is hungry, so a bite at or above it is an early one
const HAIKU_CAP = 12          // paid calls in one queue run, over every chat scene and round
const CHAT_CALLS = 5          // the lines of chat_english, one call each

const FIGHTS = {
  net_zombie: { mobs: ['zombie'], arena: 'open', capMin: 5 },
  net_skeleton: { mobs: ['skeleton'], arena: 'open', capMin: 5 },
  net_creeper: { mobs: ['creeper'], arena: 'open', capMin: 5 },
  net_enderman: { mobs: ['enderman'], arena: 'open', capMin: 6 },
  net_group2: { mobs: ['zombie', 'skeleton'], arena: 'open', capMin: 7 },
  net_group3: { mobs: ['zombie', 'skeleton', 'creeper'], arena: 'open', capMin: 8 },
  net_group4: { mobs: ['zombie', 'skeleton', 'creeper', 'enderman'], arena: 'open', capMin: 10 },
  net_cave: { mobs: ['zombie', 'skeleton'], arena: 'cave', capMin: 8 },
  net_water: { mobs: ['zombie', 'zombie'], arena: 'water', capMin: 8 },
  net_ledge: { mobs: ['zombie', 'zombie'], arena: 'ledge', capMin: 8 }
}

// The raw materials of each craft and nothing more
const CRAFT_BAGS = {
  wooden_pickaxe: [['oak_log', 2]],
  stone_pickaxe: [['oak_log', 1], ['cobblestone', 3]],
  iron_pickaxe: [['oak_log', 1], ['iron_ingot', 3]],
  diamond_pickaxe: [['oak_log', 1], ['diamond', 3]],
  furnace: [['cobblestone', 8]],
  crafting_table: [['oak_log', 1]]
}

// Plain words that the local parsers leave alone, so each one reaches Haiku
const CHAT_SCRIPT = {
  vague: 'Agent1 help me out',
  impossible: 'Agent1 brew me a potion of healing',
  logs: 'Agent1 could you fetch me three oak logs please',
  come: 'Agent1 come stand next to me',
  pick: 'Agent1 I could really use a wooden pick right now'
}
const SAYS_VAGUE = /^Too vague for me:/
const SAYS_IMPOSSIBLE = /^That's impossible for me right now:/
const SAYS_API_TROUBLE = /^(API |the translator)/

// ---------- what the logs and the server say, with no server in here ----------

// events: { t, kind: 'mode', from, to } and { t, kind: 'brain', brain }, in order
function analyzeFight (events, { from = null, to = null } = {}) {
  const modes = events.filter(e => e.kind === 'mode')
  let side = null
  let lastFlip = null
  let flips = 0
  let rapid = 0
  const sided = []
  for (const e of modes) {
    const next = FIGHT_MODES.has(e.to) ? 'fight' : RUN_MODES.has(e.to) ? 'run' : null
    if (!next) continue
    sided.push(e.t)
    if (side && next !== side) {
      flips++
      if (lastFlip !== null && e.t - lastFlip < RAPID_FLIP_MS) rapid++
      lastFlip = e.t
    }
    side = next
  }
  const start = sided.length ? sided[0] : from
  const end = sided.length ? Math.max(sided[sided.length - 1], to ?? 0) : to
  const minutes = Math.max(1, ((end ?? 0) - (start ?? 0)) / 60000)
  const notes = events.filter(e => e.kind === 'brain').map(e => e.brain)
  const scripted = notes.filter(n => /^scripted/.test(n))
  // the movement guard moves its feet in water and at ledges while the network keeps fighting (skills/mob_guard.js)
  const net = notes.some(n => /^trained network(,|$)/.test(n))
  const guarded = notes.map(n => n.match(/^trained network, movement guard: (.+)$/)?.[1]).filter(Boolean)
  return {
    fought_by: net && !scripted.length ? 'network' : net ? 'mixed' : scripted.length ? 'scripted' : 'none',
    fallback_reasons: scripted,
    guard_reasons: [...new Set(guarded.flatMap(x => x.split(', ')))],
    guard_lines: guarded.length,
    mode_changes: modes.length,
    mode_changes_per_min: Math.round(100 * modes.length / minutes) / 100,
    flips,
    flips_per_min: Math.round(100 * flips / minutes) / 100,
    rapid_flips: rapid
  }
}

// samples: { health, y }. What it lost in all, counted on each drop, so healing in between does not hide a hit
function healthSummary (samples) {
  const hp = samples.map(x => x.health).filter(x => typeof x === 'number')
  let lost = 0
  for (let i = 1; i < hp.length; i++) lost += Math.max(0, hp[i - 1] - hp[i])
  const ys = samples.map(x => x.y).filter(x => typeof x === 'number')
  return {
    samples: hp.length,
    health_lost: Math.round(lost * 10) / 10,
    lowest_health: hp.length ? Math.min(...hp) : null,
    lowest_y: ys.length ? Math.min(...ys) : null
  }
}

function fightVerdict ({ report, health, killed, mobs, deaths, standY = null }) {
  const reasons = []
  const want = {}
  for (const m of mobs) want[m] = (want[m] || 0) + 1
  for (const [kind, n] of Object.entries(want)) {
    if ((killed[kind] || 0) < n) reasons.push(`the server counts ${killed[kind] || 0} of ${n} ${kind} killed by the bot`)
  }
  if (deaths > 0) reasons.push(`${deaths} deaths`)
  if (report.fought_by !== 'network') reasons.push(`fought by ${report.fought_by}${report.fallback_reasons.length ? ` (${report.fallback_reasons.join(' | ')})` : ''}`)
  if (report.flips_per_min > MAX_FLIPS_PER_MIN) reasons.push(`${report.flips_per_min} flips a minute between fighting and running`)
  if (report.rapid_flips > 0) reasons.push(`${report.rapid_flips} flips within ${RAPID_FLIP_MS / 1000} s of the last one`)
  if (!health.samples) reasons.push('no health readings from the server')
  if (standY !== null && health.lowest_y !== null && health.lowest_y < standY - 1) reasons.push(`fell off the ledge to Y ${health.lowest_y}`)
  return { ok: reasons.length === 0, reasons }
}

// "Test passed, count: 3" or "Test failed"
function parseAlive (reply) {
  const text = String(reply)
  if (/failed/i.test(text)) return 0
  const m = text.match(/count: (\d+)/i)
  return m ? Number(m[1]) : (/passed/i.test(text) ? 1 : null)
}

// The degrees between the throw and the line from the bot to the owner, level with the ground. Null with no throw to read
function throwAngle (bot, owner, motion) {
  if (!motion) return null
  const tx = owner.x - bot.x
  const tz = owner.z - bot.z
  const flew = Math.hypot(motion.x, motion.z)
  const line = Math.hypot(tx, tz)
  if (flew < 1e-6 || line < 0.01) return null
  const cos = Math.max(-1, Math.min(1, (motion.x * tx + motion.z * tz) / (flew * line)))
  return Math.round(10 * Math.acos(cos) * 180 / Math.PI) / 10
}

// "... has the following entity data: [0.12d, 0.1d, -1.0E-4d]"
function parseMotion (reply) {
  const n = '(-?[\\d.]+(?:E-?\\d+)?)d'
  const m = String(reply).match(new RegExp(`\\[${n}, ${n}, ${n}\\]`))
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null
}

function facingVerdict (tosses) {
  const measured = tosses.map(x => x.angle).filter(a => a !== null && a !== undefined)
  return {
    tosses: tosses.length,
    measured: measured.length,
    worst_angle: measured.length ? Math.max(...measured) : null,
    ok: measured.length > 0 && measured.every(a => a <= MAX_TOSS_ANGLE)
  }
}

// The torch rule for mining jobs. steps are mine steps, with what the server counted and the miner's own log: none on a
// short trip, at most one per TORCH_EVERY blocks of tunnel in each job, none closer together than that, and none made
// from coal the scene still needs. The miner's tunnel length is capped by what the server saw it dig and walk
function torchVerdict (steps, { coalWanted = 0 } = {}) {
  let placed = 0
  let crafted = 0
  let tunnel = 0
  let allowed = 0
  let coal = 0
  const gaps = []
  for (const st of steps) {
    placed += st.torches_placed || 0
    crafted += st.torches_crafted || 0
    coal += st.picked_up?.coal || 0
    const said = st.agents_stats?.tunnel
    const blocks = Number.isFinite(said) ? Math.min(said, (st.blocks_dug || 0) + (st.walked_m || 0)) : 0
    tunnel += blocks
    allowed += Math.floor(blocks / TORCH_EVERY)
    gaps.push(...(st.agents_stats?.torchGaps || []))
  }
  const burned = Math.ceil(crafted / TORCHES_PER_COAL)
  const reasons = []
  if (placed > allowed) reasons.push(`the server counts ${placed} torches placed, ${allowed} allowed for ${tunnel} blocks of tunnel`)
  const close = gaps.filter(g => g < TORCH_EVERY)
  if (close.length) reasons.push(`${close.length} torches placed under ${TORCH_EVERY} blocks after the last (${close.join(', ')})`)
  if (coalWanted > 0 && coal - burned < coalWanted) reasons.push(`${burned} coal went into torches, leaving ${coal - burned} of the ${coalWanted} the job needs`)
  return { ok: !reasons.length, placed, crafted, tunnel, allowed, coal_burned: burned, gaps, reasons }
}

// The ground for a fight, built with fill commands inside the levelled site. c is the middle at standing height
function arena (kind, { x, y, z }) {
  if (kind === 'cave') {
    return {
      build: [`fill ${x - 8} ${y} ${z - 8} ${x + 8} ${y + 4} ${z + 8} minecraft:stone`, `fill ${x - 6} ${y} ${z - 6} ${x + 6} ${y + 2} ${z + 6} minecraft:air`],
      bot: { x, y, z },
      radius: 4,
      mobY: y,
      standY: null
    }
  }
  if (kind === 'water') {
    // the mobs stand on the diagonals, so 9 blocks out is the first ring clear of the 11 wide pool
    return { build: [`fill ${x - 5} ${y - 2} ${z - 5} ${x + 5} ${y - 1} ${z + 5} minecraft:water`], bot: { x, y: y - 2, z }, radius: 9, mobY: y, standY: null }
  }
  if (kind === 'ledge') {
    return { build: [`fill ${x - 5} ${y} ${z - 5} ${x + 5} ${y + 4} ${z + 5} minecraft:stone`], bot: { x, y: y + 5, z }, radius: 3, mobY: y + 5, standY: y + 5 }
  }
  return { build: [], bot: { x, y, z }, radius: 6, mobY: y, standY: null }
}

function mobSpots (a, n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const turn = Math.PI / 4 + 2 * Math.PI * i / n
    out.push({ x: Math.floor(a.bot.x + a.radius * Math.cos(turn)) + 0.5, y: a.mobY, z: Math.floor(a.bot.z + a.radius * Math.sin(turn)) + 0.5 })
  }
  return out
}

function ledgerCount (file) {
  if (!file) return 0
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
}

// Counts every paid call of this run and refuses the ones past the cap. The designer writes blueprints with a larger
// model, and no scene here needs one, so it stays off
function installHaikuBudget (s, file = process.env.AGENTS_HAIKU_LEDGER || null) {
  const client = s.agents?.translator?.client
  if (!client) return null
  let calls = 0
  const remaining = () => HAIKU_CAP - (file ? ledgerCount(file) : calls)
  const real = client.messages.create.bind(client.messages)
  client.messages.create = async (...args) => {
    if (remaining() <= 0) throw new Error('the Haiku call limit for this run is used up')
    calls++
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${s.name}\n`)
    }
    return real(...args)
  }
  const designer = s.agents.designer?.client
  if (designer) designer.messages.create = async () => { throw new Error('the designer is off in this scene') }
  return { calls: () => calls, remaining }
}

// ---------- the scenes ----------

function makeScenes (h) {
  const { BOT, TESTER, MINUTE, sleep, round, say } = h
  const poll = (s, ms) => s.pollMs ?? ms
  const settle = (s, ms) => s.settleMs ?? ms
  const statsOf = s => (s.readStats ? s.readStats() : h.statsNow(s))
  const deathsSince = (s, m) => s.metrics.since(m).filter(l => l.bot === BOT && l.death).length
  const diffCount = (diff, cat, item) => (diff[`minecraft:${cat}`] || {})[`minecraft:${item}`] || 0
  const statDeaths = diff => diffCount(diff, 'custom', 'deaths')

  // The log of one fight: which fighter each line names, from the agents' own log, and every change of mode
  function captureFight (s) {
    const events = []
    const file = s.metricsFile ? s.metricsFile.replace(/-metrics\.jsonl$/, '-fight.jsonl') : null
    const add = e => {
      const line = { t: Date.now(), ...e }
      events.push(line)
      if (file) { try { fs.appendFileSync(file, JSON.stringify(line) + '\n') } catch {} }
    }
    const realError = console.error
    const marker = `${BOT} mob fighter: `
    console.error = (...a) => {
      realError.apply(console, a)
      const text = a.join(' ')
      const at = text.indexOf(marker)
      if (at >= 0) add({ kind: 'brain', brain: text.slice(at + marker.length).trim() })
    }
    let hooked = null
    let realHook = null
    const hook = () => {
      const ctx = s.agents?.ctxs?.get(BOT)
      if (!ctx?.manager || ctx === hooked) return
      if (hooked) hooked.manager.hooks.modeChanged = realHook   // it reconnected: the old one lets go
      hooked = ctx
      realHook = ctx.manager.hooks.modeChanged
      const before = realHook
      ctx.manager.hooks.modeChanged = (prev, next) => {
        add({ kind: 'mode', from: prev?.name || 'idle', to: next?.name || 'idle' })
        return before?.(prev, next)
      }
    }
    hook()
    const timer = setInterval(hook, 500)
    return {
      events,
      add,
      stop () {
        clearInterval(timer)
        console.error = realError
        if (hooked) hooked.manager.hooks.modeChanged = realHook
      }
    }
  }

  function sampleFight (s) {
    const samples = []
    let running = true
    const loop = (async () => {
      while (running && s.agentsExit === undefined) {
        const health = await h.serverEntityNumber(s, 'Health')
        const pos = await h.serverPos(s)
        samples.push({ at: Date.now(), health, y: pos ? pos.y : null })
        await sleep(poll(s, 500))
      }
    })()
    return { stop: async () => { running = false; await loop; return samples } }
  }

  // Summoned with no data so a skeleton gets its bow, then tagged, kept and grown up
  async function summonTagged (s, kind, at) {
    await s.rcon.send(`summon minecraft:${kind} ${at.x} ${at.y} ${at.z}`)
    const place = `type=minecraft:${kind},x=${at.x},y=${at.y},z=${at.z},distance=..3`
    await s.rcon.send(`tag @e[${place},tag=!${TAG},limit=1,sort=nearest] add ${TAG}`)
    await s.rcon.send(`data merge entity @e[${place},tag=${TAG},limit=1,sort=nearest] {PersistenceRequired:1b${kind === 'zombie' ? ',IsBaby:0b' : ''}}`)
  }

  const aliveCount = async s => parseAlive(await s.rcon.send(`execute if entity @e[tag=${TAG}]`))

  // Puts the trained armor on the bot and returns how many pieces the server shows it wearing
  async function wearFightArmor (s) {
    for (const [slot, item] of FIGHT_ARMOR) await s.rcon.send(`item replace entity ${BOT} ${slot} with minecraft:${item}`)
    let worn = 0
    for (const [slot, item] of FIGHT_ARMOR) {
      if (parseAlive(await s.rcon.send(`execute if items entity ${BOT} ${slot} minecraft:${item}`)) === 1) worn++
    }
    return worn
  }

  // A fight the owner is watching (CREW_SHOW_WATCHER is his name): his client takes over a minute to rejoin after a server
  // start, so the mobs wait until his camera is on the bot, for at most CAMERA_WAIT_MS. It changes nothing about what passes.
  // true or false, or null when nobody is watching
  async function waitForCamera (s) {
    const name = process.env.CREW_SHOW_WATCHER
    if (!name) return null
    const until = Date.now() + (s.cameraWaitMs ?? CAMERA_WAIT_MS)
    while (Date.now() < until) {
      const on = await s.rcon.send(`execute as @a[name=${name},gamemode=spectator] at @s if entity @a[name=${BOT},distance=..2]`)
      if (/passed/i.test(String(on))) {
        await sleep(settle(s, 1500))
        return true
      }
      await sleep(poll(s, 1000))
    }
    return false
  }

  async function testFight (s) {
    const sc = s.def.fight
    if (!s.agents) return { steps: [], ok: false, fail_reasons: ['needs AGENTS_IN_PROCESS=1 to read which fighter fought'] }
    const middle = { x: s.spot.x, y: s.spot.y, z: s.spot.z + 6 }
    const a = arena(sc.arena, middle)
    const spawnRule = await h.setRule(s, ['spawn_mobs', 'doMobSpawning'], 'false')
    await s.rcon.send('time set 18000')   // night, so nothing burns and an enderman keeps its target
    for (const c of a.build) await s.rcon.send(c)
    await s.rcon.send(`tp ${TESTER} ${middle.x + 0.5} ${middle.y + 12} ${middle.z - 10.5}`)
    try { s.tester.creative?.startFlying?.() } catch {}
    // before the bot is placed: left standing in the arena through the wait, it walks off to hunt
    const cameraOnBot = await waitForCamera(s)
    await s.rcon.send(`tp ${BOT} ${a.bot.x + 0.5} ${a.bot.y} ${a.bot.z + 0.5} 180 0`)
    const armorWorn = await wearFightArmor(s)
    await sleep(settle(s, 2500))
    const base = await statsOf(s)
    const m = s.metrics.mark()
    const log = captureFight(s)
    const sampler = sampleFight(s)
    const t0 = Date.now()
    const spots = mobSpots(a, sc.mobs.length)
    for (let i = 0; i < sc.mobs.length; i++) await summonTagged(s, sc.mobs[i], spots[i])
    const summoned = await aliveCount(s)
    // An enderman leaves a player alone until it is provoked, so the server marks it as hit by the bot
    let provokeReply = null
    if (sc.mobs.includes('enderman')) provokeReply = String(await s.rcon.send(`damage @e[type=minecraft:enderman,tag=${TAG},limit=1] 1 minecraft:player_attack by ${BOT}`)).slice(0, 120)
    let alive = summoned
    const until = t0 + (s.capMs ?? sc.capMin * MINUTE)
    let endedOn = 'capped'
    if (summoned !== sc.mobs.length || armorWorn !== FIGHT_ARMOR.length) endedOn = 'setup'
    while (endedOn === 'capped' && Date.now() < until && s.agentsExit === undefined) {
      alive = await aliveCount(s)
      if (alive === 0) { endedOn = 'all gone'; break }
      if (deathsSince(s, m) > 0) { endedOn = 'died'; break }
      await sleep(poll(s, 500))
    }
    await sleep(settle(s, 2000))
    const samples = await sampler.stop()
    const t1 = Date.now()
    log.stop()
    const diff = h.statDiff(base, await statsOf(s))
    const killed = Object.fromEntries([...new Set(sc.mobs)].map(k => [k, diffCount(diff, 'killed', k)]))
    const deaths = Math.max(deathsSince(s, m), statDeaths(diff))
    const report = analyzeFight(log.events, { from: t0, to: t1 })
    const health = healthSummary(samples)
    const verdict = fightVerdict({ report, health, killed, mobs: sc.mobs, deaths, standY: a.standY })
    if (summoned !== sc.mobs.length) verdict.reasons.unshift(`the server has ${summoned} of ${sc.mobs.length} mobs after the summons`)
    if (armorWorn !== FIGHT_ARMOR.length) verdict.reasons.unshift(`the server shows ${armorWorn} of ${FIGHT_ARMOR.length} armor pieces worn`)
    return {
      steps: [{ command: `(${sc.mobs.join(', ')} in ${sc.arena})`, result: endedOn, minutes: round((t1 - t0) / MINUTE) }],
      arena: sc.arena,
      mobs: sc.mobs,
      armor_worn: armorWorn,
      camera_on_bot: cameraOnBot,
      provoke_reply: provokeReply,
      spawn_rule: spawnRule,
      mobs_left: alive,
      kills: killed,
      kills_total: Object.values(killed).reduce((n, x) => n + x, 0),
      deaths,
      ...report,
      ...health,
      fail_reasons: verdict.reasons,
      ok: verdict.ok && summoned === sc.mobs.length && armorWorn === FIGHT_ARMOR.length
    }
  }

  // Which way each dropped item was thrown. A server sends a dropped item's position only about once a second, so this
  // reads its motion: from the server when it can, else from the packet that spawned it
  function watchTosses (s) {
    const tosses = []
    const reads = []
    const onSpawn = e => {
      if (e?.name !== 'item') return
      const bot = s.tester.players?.[BOT]?.entity?.position
      const owner = s.tester.entity?.position
      if (!bot || !owner || Math.hypot(e.position.x - bot.x, e.position.z - bot.z) > 3.5) return
      const rec = { angle: null, source: null }
      const [b, o] = [bot, owner].map(p => ({ x: p.x, y: p.y, z: p.z }))
      const packet = e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null
      const who = e.uuid || `@e[type=minecraft:item,x=${e.position.x},y=${e.position.y},z=${e.position.z},distance=..1,limit=1,sort=nearest]`
      tosses.push(rec)
      reads.push(Promise.resolve().then(() => s.rcon.send(`data get entity ${who} Motion`)).catch(() => '').then(reply => {
        rec.angle = throwAngle(b, o, parseMotion(reply))
        rec.source = 'server'
        if (rec.angle === null) {
          rec.angle = throwAngle(b, o, packet)
          rec.source = rec.angle === null ? null : 'packet'
        }
      }))
    }
    s.tester.on('entitySpawn', onSpawn)
    return {
      stop: async () => {
        await sleep(s.tossWatchMs ?? 350)
        s.tester.removeListener('entitySpawn', onSpawn)
        await Promise.all(reads)
        return facingVerdict(tosses)
      }
    }
  }

  // Each craft from its raw materials at a table, asked for in chat and handed to the owner. The server must show
  // exactly one in the owner's bag and none left with the bot, and the throw must go toward the owner
  async function testCraftEvery (s) {
    const { x, y, z } = s.botStart
    const steps = []
    for (const [item, bag] of Object.entries(CRAFT_BAGS)) {
      for (const c of [`clear ${BOT}`, `clear ${TESTER}`, `kill @e[type=minecraft:item,x=${x},y=${y},z=${z},distance=..16]`,
        `setblock ${x} ${y} ${z + 3} minecraft:crafting_table`,
        `tp ${BOT} ${x + 0.5} ${y} ${z + 0.5} 180 0`, `tp ${TESTER} ${x + 3.5} ${y} ${z + 0.5}`]) await s.rcon.send(c)
      for (const [name, n] of bag) await s.rcon.send(`give ${BOT} minecraft:${name} ${n}`)
      await sleep(settle(s, 1500))
      const watch = watchTosses(s)
      const step = await h.commandStep(s, `craft me a ${item.replace(/_/g, ' ')}`, 'craft', 3)
      const until = Date.now() + (s.pickupMs ?? 15000)
      let owner = 0
      while (Date.now() < until) {
        owner = await h.playerTotal(s, TESTER, [item])
        if (owner >= 1) break
        await sleep(poll(s, 500))
      }
      step.item = item
      step.owner_got = owner
      step.bot_left = await h.serverCount(s, item)
      step.facing = await watch.stop()
      step.ok = owner === 1 && step.bot_left === 0 && step.facing.ok
      steps.push(step)
    }
    const bad = steps.filter(x => !x.ok)
    return {
      steps,
      fail_reasons: bad.map(x => `${x.item}: owner has ${x.owner_got}, bot has ${x.bot_left}, worst throw ${x.facing.worst_angle ?? 'not seen'}`),
      ok: steps.length === Object.keys(CRAFT_BAGS).length && !bad.length
    }
  }

  // The owner stands in two different places, and the bot starts with its back turned, so a throw in the right
  // direction cannot be luck
  async function testHandover (s) {
    const { x, y, z } = s.botStart
    const wants = [{ items: ['cobblestone'], want: 16 }, { items: ['coal'], want: 8 }]
    const steps = []
    for (const [i, [dx, dz]] of [[7, 3], [-5, 8]].entries()) {
      if (i) for (const { items, want } of wants) await s.rcon.send(`give ${BOT} minecraft:${items[0]} ${want}`)
      await s.rcon.send(`tp ${BOT} ${x + 0.5} ${y} ${z + 0.5} 180 0`)
      await s.rcon.send(`tp ${TESTER} ${x + dx + 0.5} ${y} ${z + dz + 0.5}`)
      await sleep(settle(s, 1500))
      const watch = watchTosses(s)
      const step = await h.handOver(s, wants, s.pickupMs === undefined ? {} : { pickupMs: s.pickupMs })
      step.facing = await watch.stop()
      step.ok = step.handed_over && step.facing.ok
      steps.push(step)
    }
    const bad = steps.filter(x => !x.ok)
    return {
      steps,
      fail_reasons: bad.map(x => `handed over ${x.handed_over}, worst throw ${x.facing.worst_angle ?? 'not seen'} degrees`),
      ok: steps.length === 2 && !bad.length
    }
  }

  // A strong hunger effect until the server's bar is at target, then it ends. The effect burns saturation first
  async function drainBar (s, target, capMs = 60000) {
    await s.rcon.send(`effect give ${BOT} minecraft:hunger 60 120 true`)
    const until = Date.now() + (s.drainMs ?? capMs)
    let bar = await h.serverEntityNumber(s, 'foodLevel')
    while (Date.now() < until && !(bar !== null && bar <= target)) {
      await sleep(poll(s, 200))
      bar = await h.serverEntityNumber(s, 'foodLevel')
    }
    await s.rcon.send(`effect clear ${BOT} minecraft:hunger`)
    return bar
  }

  // Bread, raw beef, a furnace and coal in the bag. The first thing it eats has to be the bread, with no cooking
  async function testFoodReady (s) {
    const base = await statsOf(s)
    const m = s.metrics.mark()
    const start = { bread: await h.serverCount(s, 'bread'), beef: await h.serverCount(s, 'beef'), cooked_beef: 0 }
    const bar = await drainBar(s, 17)
    const until = Date.now() + (s.capMs ?? 45000)
    let first = null
    let holdUntil = null
    while (Date.now() < until && (holdUntil === null || Date.now() < holdUntil)) {
      const now = { bread: await h.serverCount(s, 'bread'), beef: await h.serverCount(s, 'beef'), cooked_beef: await h.serverCount(s, 'cooked_beef') }
      if (!first) {
        if (now.beef < start.beef) first = 'beef'
        else if (now.cooked_beef > 0) first = 'cooked_beef'
        else if (now.bread < start.bread) first = 'bread'
        if (first) holdUntil = Date.now() + settle(s, 8000)   // long enough to catch a raw bite right after
      }
      await sleep(poll(s, 300))
    }
    const diff = h.statDiff(base, await statsOf(s))
    const out = {
      bar_after_drain: bar,
      first_eaten: first,
      ate_bread: diffCount(diff, 'used', 'bread'),
      ate_raw_beef: diffCount(diff, 'used', 'beef'),
      cooked_beef: diffCount(diff, 'crafted', 'cooked_beef'),
      raw_left: await h.serverCount(s, 'beef'),
      deaths: Math.max(deathsSince(s, m), statDeaths(diff))
    }
    const reasons = []
    if (first !== 'bread') reasons.push(`the first food gone was ${first || 'nothing'}`)
    if (out.ate_bread < 1) reasons.push('the server counts no bread eaten')
    if (out.ate_raw_beef > 0) reasons.push('it ate raw beef with bread in the bag')
    if (out.cooked_beef > 0) reasons.push('it cooked with ready food in the bag')
    if (out.raw_left !== start.beef) reasons.push(`raw beef went from ${start.beef} to ${out.raw_left}`)
    if (out.deaths) reasons.push(`${out.deaths} deaths`)
    return { steps: [{ command: '(hungry, bread and raw beef in the bag)', result: first || 'nothing eaten', minutes: 0 }], ...out, fail_reasons: reasons, ok: !reasons.length }
  }

  // Only raw beef and coal, with a real furnace placed beside it. The server must count steak taken from the furnace
  // and eaten, and no raw beef eaten
  async function testFoodCook (s) {
    const base = await statsOf(s)
    const m = s.metrics.mark()
    const { x, y, z } = s.botStart
    await s.rcon.send(`setblock ${x + 2} ${y} ${z} minecraft:furnace`)
    const bar = await drainBar(s, 9)
    const t0 = Date.now()
    const until = t0 + (s.capMs ?? 5 * MINUTE)
    let diff = {}
    let now = bar
    while (Date.now() < until && s.agentsExit === undefined) {
      await sleep(poll(s, 5000))
      diff = h.statDiff(base, await statsOf(s))
      now = await h.serverEntityNumber(s, 'foodLevel')
      if (diffCount(diff, 'crafted', 'cooked_beef') >= 1 && diffCount(diff, 'used', 'cooked_beef') >= 1 && now >= HUNGRY) break
    }
    diff = h.statDiff(base, await statsOf(s))
    const out = {
      bar_after_drain: bar,
      bar_at_end: now,
      cooked_beef: diffCount(diff, 'crafted', 'cooked_beef'),
      ate_cooked: diffCount(diff, 'used', 'cooked_beef'),
      ate_raw: diffCount(diff, 'used', 'beef'),
      furnace_uses: diffCount(diff, 'custom', 'interact_with_furnace'),
      deaths: Math.max(deathsSince(s, m), statDeaths(diff))
    }
    const reasons = []
    if (out.cooked_beef < 1) reasons.push('the server counts no beef cooked')
    if (out.ate_cooked < 1) reasons.push('the server counts no cooked beef eaten')
    if (out.ate_raw > 0) reasons.push(`it ate ${out.ate_raw} raw beef`)
    if (out.furnace_uses < 1) reasons.push('the server counts no use of a furnace')
    if (now === null || now < HUNGRY) reasons.push(`the bar ended at ${now}`)
    if (out.deaths) reasons.push(`${out.deaths} deaths`)
    return { steps: [{ command: '(hungry, raw beef, coal and a furnace)', result: reasons.length ? 'not fed' : 'fed', minutes: round((Date.now() - t0) / MINUTE) }], ...out, fail_reasons: reasons, ok: !reasons.length }
  }

  // With the bar just under 18 and nothing wrong, it tops up before it is ever hungry
  async function testFoodEarly (s) {
    const base = await statsOf(s)
    const m = s.metrics.mark()
    const start = await h.serverCount(s, 'bread')
    let bar = await drainBar(s, 17)
    let lowest = bar
    let barAtBite = null
    const until = Date.now() + (s.capMs ?? 30000)
    while (Date.now() < until) {
      const left = await h.serverCount(s, 'bread')
      if (left < start) { barAtBite = bar; break }
      bar = await h.serverEntityNumber(s, 'foodLevel')
      if (bar !== null) lowest = lowest === null ? bar : Math.min(lowest, bar)
      await sleep(poll(s, 250))
    }
    const diff = h.statDiff(base, await statsOf(s))
    const ate = diffCount(diff, 'used', 'bread')
    const deaths = Math.max(deathsSince(s, m), statDeaths(diff))
    const reasons = []
    if (barAtBite === null) reasons.push('it did not eat')
    else if (barAtBite < HUNGRY) reasons.push(`its first bite came with the bar at ${barAtBite}`)
    if (ate < 1) reasons.push('the server counts no bread eaten')
    if (lowest === null || lowest < HUNGRY) reasons.push(`the bar fell to ${lowest}`)
    if (deaths) reasons.push(`${deaths} deaths`)
    return { steps: [{ command: '(bar just under 18, bread in the bag)', result: barAtBite === null ? 'did not eat' : 'ate', minutes: 0 }], bar_at_first_bite: barAtBite, lowest_bar: lowest, ate_bread: ate, deaths, fail_reasons: reasons, ok: !reasons.length }
  }

  // Cows beyond its 32 block sight, so it has to go looking
  async function placeFarCows (s) {
    const placed = []
    for (const [dx, dz] of [[40, 0], [0, 40], [-40, 0], [0, -40], [30, 30], [-30, 30], [30, -30], [-30, -30]]) {
      if (placed.length >= 4) break
      const [cx, cz] = [s.botStart.x + dx, s.botStart.z + dz]
      const g = h.groundAt(s.tester, cx, cz, 200, -64, h.TREE)
      if (!g || /water|lava/.test(g.name)) continue
      await s.rcon.send(`summon minecraft:cow ${cx + 0.5} ${g.y + 1} ${cz + 0.5}`)
      placed.push([cx, g.y + 1, cz])
    }
    return placed
  }

  // An empty bag and a low bar. It has to start the food mission by itself, find an animal and get its bar back
  async function testFoodMission (s) {
    const base = await statsOf(s)
    const m = s.metrics.mark()
    const cows = await placeFarCows(s)
    const bar = await drainBar(s, 9)
    const t0 = Date.now()
    const until = t0 + (s.capMs ?? 12 * MINUTE)
    let now = bar
    let done = false
    while (Date.now() < until && s.agentsExit === undefined) {
      await sleep(poll(s, 3000))
      now = await h.serverEntityNumber(s, 'foodLevel')
      if (now !== null && now >= HUNGRY) { done = true; break }
    }
    const diff = h.statDiff(base, await statsOf(s))
    const killed = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].reduce((n, a) => n + diffCount(diff, 'killed', a), 0)
    const foods = h.FOOD_ITEMS.reduce((n, f) => n + diffCount(diff, 'used', f), 0)
    const events = s.metrics.since(m).filter(l => l.bot === BOT && l.event)
    const started = events.some(l => l.event === 'food-emergency')
    const deaths = Math.max(deathsSince(s, m), statDeaths(diff))
    const reasons = []
    if (!started) reasons.push('the food mission never started')
    if (!done) reasons.push(`the bar only got to ${now}`)
    if (killed < 1) reasons.push('the server counts no animal killed')
    if (foods < 1) reasons.push('the server counts nothing eaten')
    if (deaths) reasons.push(`${deaths} deaths`)
    return {
      steps: [{ command: '(empty bag, bar at 9 or less)', result: done ? 'recovered' : 'capped', minutes: round((Date.now() - t0) / MINUTE) }],
      cows_placed: cows.length,
      bar_after_drain: bar,
      bar_at_end: now,
      mission_started: started,
      animals_killed: killed,
      food_eaten: foods,
      deaths,
      agents_news: events.map(l => l.text).slice(-25),
      fail_reasons: reasons,
      ok: !reasons.length
    }
  }

  async function replyAfter (s, c0, ms) {
    const until = Date.now() + ms
    while (Date.now() < until && s.agentsExit === undefined) {
      const hit = h.botChat(s, c0).find(l => SAYS_VAGUE.test(l.text) || SAYS_IMPOSSIBLE.test(l.text) || SAYS_API_TROUBLE.test(l.text))
      if (hit) return hit.text
      await sleep(poll(s, 500))
    }
    return null
  }

  // One request the bot has to turn down in the right words, starting no job
  async function refusalStep (s, kind, line, want) {
    const c0 = s.chat.length
    const m = s.metrics.mark()
    const t0 = Date.now()
    say(s, line)
    const reply = await replyAfter(s, c0, s.replyMs ?? 30000)
    await sleep(settle(s, 3000))
    const jobs = s.metrics.since(m).filter(l => l.bot === BOT && l.job).length
    const onIt = h.botChat(s, c0).some(l => /^On it/.test(l.text))
    return {
      command: line,
      kind,
      result: reply ? 'replied' : 'no reply',
      reply,
      seconds: round((Date.now() - t0) / 1000, 1),
      minutes: round((Date.now() - t0) / MINUTE),
      api_trouble: !!reply && SAYS_API_TROUBLE.test(reply),
      ran_nothing: jobs === 0 && !onIt,
      ok: !!reply && want.test(reply) && jobs === 0 && !onIt
    }
  }

  // One order in plain words, finished when check() on the server says so
  async function orderStep (s, id, line, capMs, check) {
    const t0 = Date.now()
    say(s, line)
    const until = t0 + capMs
    let seen = null
    let ok = false
    while (Date.now() < until && s.agentsExit === undefined) {
      await sleep(poll(s, 2000))
      seen = await check()
      if (seen.ok) { ok = true; break }
    }
    if (!ok) {
      say(s, '!stop')
      await sleep(settle(s, 2000))
    }
    return { command: line, kind: id, result: ok ? 'done' : 'capped', minutes: round((Date.now() - t0) / MINUTE), server: seen?.value ?? null, ok }
  }

  // Sent as normal chat by the owner stand-in. The two refusals go first: they are quick, and when the API is in
  // trouble the scene ends there with no more paid calls
  async function testChat (s) {
    const budget = installHaikuBudget(s)
    if (!budget) return { steps: [], ok: false, fail_reasons: ['needs AGENTS_IN_PROCESS=1 and the API key in the git-ignored .env'] }
    if (budget.remaining() < CHAT_CALLS) {
      return { steps: [], ok: false, blocked: 'haiku limit', fail_reasons: [`only ${budget.remaining()} of the ${HAIKU_CAP} Haiku calls are left, this scene needs ${CHAT_CALLS}`] }
    }
    const steps = []
    const finish = extra => {
      const calls = budget.calls()
      const reasons = steps.filter(x => !x.ok).map(x => `${x.kind}: ${x.reply || x.result}`)
      if (calls > CHAT_CALLS) reasons.push(`${calls} Haiku calls, the limit for this scene is ${CHAT_CALLS}`)
      if (steps.length === CHAT_CALLS && calls !== CHAT_CALLS) reasons.push(`${calls} Haiku calls for ${CHAT_CALLS} requests`)
      if (steps.length < CHAT_CALLS) reasons.push(`stopped after ${steps.length} of ${CHAT_CALLS} requests`)
      const v = steps.find(x => x.kind === 'vague')?.reply
      const i = steps.find(x => x.kind === 'impossible')?.reply
      if (v && i && v === i) reasons.push('the two refusals are the same line')
      return { steps, haiku_calls: calls, haiku_left: budget.remaining(), ...extra, fail_reasons: reasons, ok: !reasons.length }
    }
    for (const [kind, want] of [['vague', SAYS_VAGUE], ['impossible', SAYS_IMPOSSIBLE]]) {
      const step = await refusalStep(s, kind, CHAT_SCRIPT[kind], want)
      steps.push(step)
      if (step.api_trouble || !step.reply) return finish({ stopped_early: step.reply || 'no reply' })
    }
    const logsBefore = await h.playerTotal(s, TESTER, h.LOG_ITEMS)
    steps.push(await orderStep(s, 'logs', CHAT_SCRIPT.logs, s.orderMs ?? 8 * MINUTE, async () => {
      const value = await h.playerTotal(s, TESTER, h.LOG_ITEMS) - logsBefore
      return { value, ok: value >= 3 }
    }))
    await s.rcon.send(`tp ${TESTER} ${s.spot.x + 9.5} ${s.spot.y} ${s.spot.z + 14.5}`)
    await sleep(settle(s, 2000))
    steps.push(await orderStep(s, 'come', CHAT_SCRIPT.come, s.orderMs ?? MINUTE, async () => {
      const [bot, me] = [await h.posOf(s, BOT), await h.posOf(s, TESTER)]
      const value = bot && me ? round(Math.hypot(bot.x - me.x, bot.y - me.y, bot.z - me.z), 1) : null
      return { value, ok: value !== null && value <= 4 }
    }))
    const picksBefore = await h.playerTotal(s, TESTER, ['wooden_pickaxe'])
    steps.push(await orderStep(s, 'pick', CHAT_SCRIPT.pick, s.orderMs ?? 6 * MINUTE, async () => {
      const value = await h.playerTotal(s, TESTER, ['wooden_pickaxe']) - picksBefore
      return { value, ok: value >= 1 }
    }))
    return finish({})
  }

  const fightDef = sc => ({ minutes: sc.capMin + 3, picture: null, flatten: true, kit: FIGHT_KIT, fight: sc, run: testFight })
  return {
    ...Object.fromEntries(Object.entries(FIGHTS).map(([name, sc]) => [name, fightDef(sc)])),
    craft_every: { minutes: 25, picture: null, flatten: true, kit: [], run: testCraftEvery },
    handover_facing: { minutes: 10, picture: null, flatten: true, kit: [['cobblestone', 16], ['coal', 8]], run: testHandover },
    food_ready_first: { minutes: 5, picture: null, flatten: true, kit: [['bread', 4], ['beef', 4], ['furnace', 1], ['coal', 2]], run: testFoodReady },
    food_cook: { minutes: 8, picture: null, flatten: true, kit: [['beef', 4], ['coal', 4]], run: testFoodCook },
    food_early: { minutes: 4, picture: null, flatten: true, kit: [['bread', 4]], run: testFoodEarly },
    food_mission: { minutes: 15, picture: null, flatten: true, kit: [], run: testFoodMission },
    chat_english: { minutes: 20, picture: null, flatten: true, translator: true, kit: [['bread', 8]], run: testChat }
  }
}

// Adds the scenes to livetest.js's table, and counts the translate scene's one paid call under the same limit
function registerScenes (TESTS, helpers) {
  Object.assign(TESTS, makeScenes(helpers))
  const translate = TESTS.translate
  if (translate) {
    const run = translate.run
    translate.run = async s => {
      const budget = installHaikuBudget(s)
      if (budget && budget.remaining() < 1) return { steps: [], ok: false, blocked: 'haiku limit', fail_reasons: [`none of the ${HAIKU_CAP} Haiku calls are left`] }
      return run(s)
    }
  }
  return TESTS
}

module.exports = {
  registerScenes, makeScenes, analyzeFight, healthSummary, fightVerdict, parseAlive, throwAngle, parseMotion, facingVerdict, torchVerdict, arena, mobSpots,
  ledgerCount, installHaikuBudget,
  FIGHTS, FIGHT_KIT, FIGHT_ARMOR, TORCH_EVERY, CRAFT_BAGS, CHAT_SCRIPT, CHAT_CALLS, HAIKU_CAP, MAX_FLIPS_PER_MIN, RAPID_FLIP_MS, MAX_TOSS_ANGLE, TAG
}
