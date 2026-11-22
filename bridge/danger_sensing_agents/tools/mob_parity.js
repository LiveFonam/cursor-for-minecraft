// The mob input parity check: does this client build the mob network's inputs the way the simulator does?
//
//   node tools/mob_parity.js --rec rec.jsonl.gz --expert expert.npz [--out parity.json]
//
// A recording from tools/mob_parity_record.py is compared at three levels, each on every input slot:
//
//   formula   the simulator's exact state through buildMobInputs. Must match on every slot of every sample
//   client    only what a client sees each tick, through MobTracker. Every slot must match its tolerance on 99% of samples
//   server    the same with a real server's timing, which is not checked against a live server: a mob's position
//             arrives every 3 ticks at 1/4096 block, its yaw at 1/256 turn, and everything about a mob one tick late
//
// The network then picks an action from each level's inputs through agents_policy.py --mob. The switch decision needs
// the formula and client levels to pass and the actions from client inputs to agree with the simulator's. The server
// level is reported and does not decide, because it is a model of a server and not a measurement.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const readline = require('readline')
const { spawn } = require('child_process')
const { buildMobInputs, buildMobMask, MobTracker, INPUTS, MASK } = require('../skills/mob_inputs')

const ROOT = path.join(__dirname, '..', '..', '..')
const EXACT = 1e-4              // float32 rounding of the simulator's numbers
const SHARE = 0.99              // a slot passes the client level when this share of samples is inside its tolerance
const ACTION_SHARE = 0.95       // each action head must agree on this share of samples at the client level
const TICK = 0.1001             // one game tick on a timer scaled by 10
const MOTION = 0.15             // a mob's rebuilt motion, in input units (0.075 blocks a tick)
const LEAD = 0.02

// Input groups for the report, as [name, first slot, last slot]
const GROUPS = [
  ['own body', 0, 11], ['own weapon and shield', 12, 25], ['aim at nearest mob', 26, 38], ['nearest mob motion', 39, 44],
  ['nearest mob state', 45, 60], ['fight memory', 61, 67], ['last action', 68, 74], ['shot solve', 75, 80],
  ['incoming arrows', 81, 92], ['arrow pickup', 93, 95], ['block rays', 96, 121], ['hazard and water', 122, 127],
  ['border and tracking', 128, 129], ['mob 1', 130, 146], ['mob 2', 147, 163], ['mob 3', 164, 180], ['mobs alive', 181, 181]
]
const HEADS = ['forward', 'strafe', 'sprint', 'jump', 'yaw', 'pitch', 'attack', 'use', 'weapon', 'sneak', 'lock_aim']

// What a client can only approximate, with the tolerance of the client level
function tolerance (slot) {
  if (slot === 10 || slot === 46) return TICK
  if (slot >= 75 && slot <= 80) return LEAD
  if (slot >= 130 && slot < 181) {
    const f = (slot - 130) % 17
    if (f === 9 || f === 10) return MOTION
  }
  return EXACT
}

// Slots no client can match on a real server, whatever the code does, and why. Reported with the results
const CANNOT_MATCH = [
  { slots: '96 to 121', why: 'block rays: training had a flat floor and walls 12 blocks from the middle. A server has real terrain, so these carry values the network never saw in caves, forests and hills' },
  { slots: '128', why: 'border distance: a real world has no arena wall, so it is held at the middle of the arena' },
  { slots: '8, 9, 122 to 127', why: 'water and hazards: never present in training, so they are held at their training value and the network cannot react to water, lava or fire. A separate movement guard keeps it out of them' },
  { slots: '37, 38', why: 'line of sight: always clear in training, so held at 1. A mob behind a wall keeps its last seen place in the mob inputs' },
  { slots: '130+9, 130+10 per mob', why: 'mob motion: the simulator reads its internal velocity. A client only sees positions, every 3 ticks on a real server' },
  { slots: '130+14 per mob', why: 'enderman anger: the simulator holds a provoked flag. A client reads the creepy flag, which also follows other targets' },
  { slots: '10, 46', why: 'hurt timers: a client sees the hurt event a tick apart from the simulator order' }
]

function args () {
  const out = {}
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1]
  return out
}

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// Models a server's timing on the frames of one arena
class ServerTiming {
  constructor () { this.seen = new Map(); this.prev = null; this.t = 0 }

  frame (f) {
    const late = this.prev || f
    this.prev = f
    this.t++
    const mobs = late.mobs.map(m => {
      let s = this.seen.get(m.id)
      if (!s || (this.t + m.id) % 3 === 0) {
        s = { pos: m.pos.map(v => Math.round(v * 4096) / 4096), yaw: Math.round(m.yaw / 360 * 256) * 360 / 256, at: this.t, gap: s ? this.t - s.at : 1 }
        this.seen.set(m.id, s)
      }
      return { ...m, pos: s.pos, yaw: s.yaw, heldPos: true, heldFor: Math.max(s.gap, 1) }
    })
    return { ...f, mobs, hitMobs: late.hitMobs, hurtMobs: late.hurtMobs }
  }
}

function newStats () {
  return {
    n: 0,
    off: new Float64Array(INPUTS),
    worst: new Float64Array(INPUTS),
    maskOff: 0,
    actions: [],
    best: []
  }
}

function tally (st, built, want, mask, wantMask, tol) {
  st.n++
  for (let i = 0; i < INPUTS; i++) {
    const d = Math.abs(built[i] - want[i])
    if (d > st.worst[i]) st.worst[i] = d
    if (d > tol(i)) st.off[i]++
  }
  for (let i = 0; i < MASK; i++) if (mask[i] !== wantMask[i]) { st.maskOff++; break }
}

// Runs agents_policy.py --mob over a list of inputs and returns one action each
function runPolicy (expert, rows) {
  return new Promise((resolve, reject) => {
    const python = process.env.AGENTS_POLICY_PYTHON || 'python3'
    const proc = spawn(python, [path.join(ROOT, 'agents_policy.py'), '--mob', expert], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, OMP_NUM_THREADS: '1' } })
    const out = new Array(rows.length)
    let got = 0
    let next = 0
    const lines = readline.createInterface({ input: proc.stdout })
    const send = () => {
      while (next < rows.length && next - got < 64) {
        proc.stdin.write(JSON.stringify({ id: next, key: 'parity', obs: rows[next].obs, mask: rows[next].mask }) + '\n')
        next++
      }
      if (next >= rows.length && got >= rows.length) proc.stdin.end()
    }
    lines.on('line', line => {
      const msg = JSON.parse(line)
      if (msg.hello) { send(); return }
      if (msg.error) { reject(new Error(msg.error)); proc.kill(); return }
      out[msg.id] = msg.action
      got++
      send()
    })
    proc.on('error', reject)
    proc.on('exit', code => (got >= rows.length ? resolve(out) : reject(new Error(`policy exited ${code} after ${got} of ${rows.length}`))))
  })
}

function headAgreement (actions, want) {
  const same = new Array(HEADS.length).fill(0)
  let all = 0
  actions.forEach((a, k) => {
    let whole = true
    a.forEach((v, h) => { if (v === want[k][h]) same[h]++; else whole = false })
    if (whole) all++
  })
  const n = Math.max(actions.length, 1)
  return { perHead: Object.fromEntries(HEADS.map((h, i) => [h, +(same[i] / n).toFixed(4)])), wholeAction: +(all / n).toFixed(4) }
}

function groupReport (st, tol) {
  return GROUPS.map(([name, a, b]) => {
    let worst = 0
    let inside = 1
    let worstSlot = a
    for (let i = a; i <= b; i++) {
      const share = 1 - st.off[i] / Math.max(st.n, 1)
      if (share < inside) { inside = share; worstSlot = i }
      worst = Math.max(worst, st.worst[i])
    }
    return { group: name, slots: `${a}-${b}`, inside: +inside.toFixed(4), largest: +worst.toFixed(4), tolerance: tol(worstSlot), lowestSlot: worstSlot }
  })
}

// For tools/mob_parity_play.py: builds the inputs of live simulator rounds, one JSON line each way, so the network plays
// whole rounds from what this client would see. level is 'client' or 'server'
async function serve (level) {
  const arenas = new Map()
  const box = { x: 0, z: 0, half: 12 }
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    const msg = JSON.parse(line)
    if (msg.start) {
      const a = { tracker: new MobTracker({ arena: box }), timing: level === 'server' ? new ServerTiming() : null, action: null, ticks: 0 }
      a.tracker.reset(a.timing ? a.timing.frame(msg.start.frame) : msg.start.frame)
      arenas.set(msg.start.arena, a)
    } else if (msg.tick) {
      const a = arenas.get(msg.tick.arena)
      a.tracker.tick(a.timing ? a.timing.frame(msg.tick.frame) : msg.tick.frame, a.action)
      a.ticks++
    } else if (msg.ask !== undefined) {
      const a = arenas.get(msg.ask)
      if (a.action) a.tracker.endDecision(a.action, a.ticks)
      a.ticks = 0
      const s = a.tracker.state()
      process.stdout.write(JSON.stringify({ obs: buildMobInputs(s), mask: buildMobMask(s) }) + '\n')
    } else if (msg.act) {
      arenas.get(msg.act.arena).action = msg.act.action
    }
  }
}

async function main () {
  const opt = args()
  if (opt.serve) { await serve(opt.serve); return 0 }
  if (!opt.rec || !opt.expert) throw new Error('usage: mob_parity.js --rec rec.jsonl.gz --expert expert.npz [--out parity.json]')
  const levels = { formula: newStats(), client: newStats(), server: newStats() }
  const rows = { formula: [], client: [], server: [] }
  const want = []
  const arenas = new Map()
  const input = fs.createReadStream(opt.rec).pipe(zlib.createGunzip())
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  const arenaBox = { x: 0, z: 0, half: 12 }
  for await (const line of lines) {
    const msg = JSON.parse(line)
    if (msg.start) {
      const a = arenas.get(msg.start.arena) || {}
      a.client = new MobTracker({ arena: arenaBox })
      a.client.reset(msg.start.frame)
      a.server = new MobTracker({ arena: arenaBox })
      a.timing = new ServerTiming()
      a.server.reset(a.timing.frame(msg.start.frame))
      a.action = null
      a.ticks = 0
      arenas.set(msg.start.arena, a)
    } else if (msg.decide) {
      const d = msg.decide
      const a = arenas.get(d.arena)
      if (a.action) { a.client.endDecision(a.action, a.ticks); a.server.endDecision(a.action, a.ticks) }
      a.action = d.action
      a.ticks = 0
      const exact = { ...d.state, me: { ...d.state.me } }
      const f = buildMobInputs(exact)
      const fm = buildMobMask(exact)
      tally(levels.formula, f, d.obs, fm, d.mask, () => EXACT)
      rows.formula.push({ obs: f, mask: fm })
      for (const level of ['client', 'server']) {
        const s = a[level].state()
        const o = buildMobInputs(s)
        const m = buildMobMask(s)
        tally(levels[level], o, d.obs, m, d.mask, tolerance)
        rows[level].push({ obs: o, mask: m })
      }
      want.push(d.best)
    } else if (msg.tick) {
      const a = arenas.get(msg.tick.arena)
      a.client.tick(msg.tick.frame, a.action)
      a.server.tick(a.timing.frame(msg.tick.frame), a.action)
      a.ticks++
    }
  }

  const actions = {}
  for (const level of Object.keys(rows)) actions[level] = headAgreement(await runPolicy(opt.expert, rows[level]), want)
  const report = { samples: levels.formula.n, tolerance: { exact: EXACT, tickTimers: TICK, mobMotion: MOTION, shotSolve: LEAD, clientShare: SHARE, actionShare: ACTION_SHARE }, levels: {} }
  for (const name of Object.keys(levels)) {
    const st = levels[name]
    const tol = name === 'formula' ? () => EXACT : tolerance
    report.levels[name] = { groups: groupReport(st, tol), maskInside: +(1 - st.maskOff / Math.max(st.n, 1)).toFixed(4), actions: actions[name] }
  }
  const formulaOk = levels.formula.off.every(v => v === 0) && levels.formula.maskOff === 0
  const clientOk = levels.client.off.every(v => 1 - v / levels.client.n >= SHARE) && 1 - levels.client.maskOff / levels.client.n >= SHARE
  const headsOk = Object.values(actions.client.perHead).every(v => v >= ACTION_SHARE)
  const formulaActions = actions.formula.wholeAction === 1
  report.checks = { formulaEverySlot: formulaOk, formulaActionsIdentical: formulaActions, clientEverySlot: clientOk, clientActionHeads: headsOk }
  report.passed = formulaOk && formulaActions && clientOk && headsOk
  report.cannotMatchOnServer = CANNOT_MATCH
  report.expert_sha256 = sha(opt.expert)
  report.code_sha256 = sha(path.join(__dirname, '..', 'skills', 'mob_inputs.js'))
  report.unverified = 'No real server was used. The server level is a model of packet timing.'
  if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(report, null, 1))
  for (const name of Object.keys(report.levels)) {
    const l = report.levels[name]
    console.log(`\n${name}: mask ${l.maskInside}, whole action ${l.actions.wholeAction}`)
    console.log('  heads ' + Object.entries(l.actions.perHead).map(([k, v]) => `${k} ${v}`).join(', '))
    for (const g of l.groups) console.log(`  ${g.group.padEnd(24)} ${g.slots.padEnd(9)} inside ${g.inside}  largest ${g.largest}  (lowest slot ${g.lowestSlot}, tolerance ${g.tolerance})`)
  }
  console.log('\nchecks', JSON.stringify(report.checks), 'passed', report.passed)
  return report.passed ? 0 : 1
}

if (require.main === module) {
  main().then(code => { process.exitCode = code }, err => { console.error(err); process.exitCode = 2 })
}

module.exports = { CANNOT_MATCH, GROUPS, tolerance }
