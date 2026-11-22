// Runs a saved fighter inside Node for the real server check: the network, its experts and the same takeover rule
// as fighter/src/fighter/experts.py. export_policy.py writes the file this reads.

const fs = require('fs')
const { ACTION_DIMS, HEAD_OFFSETS } = require('../fighter')

const INPUT_LIMIT = 5
const TAKEOVER_RANGE = 4.5
const RANGE_SCALE = 32
const [, , , , YAW, PITCH, , USE, , , LOCK_AIM] = ACTION_DIMS.keys()
const ENEMY_IN_SIGHT = 38

class Net {
  constructor (layers) {
    this.layers = layers.map(l => ({ w: Float32Array.from(l.w), b: Float32Array.from(l.b), rows: l.rows, cols: l.cols }))
  }

  logits (obs) {
    let x = Float32Array.from(obs)
    this.layers.forEach((l, k) => {
      const out = new Float32Array(l.rows)
      for (let r = 0; r < l.rows; r++) {
        let sum = 0
        const at = r * l.cols
        for (let c = 0; c < l.cols; c++) sum += l.w[at + c] * x[c]
        sum += l.b[r]
        out[r] = k < this.layers.length - 1 ? Math.max(sum, 0) : sum
      }
      x = out
    })
    return x
  }

  // The best allowed choice of every head
  act (obs, mask) {
    const scores = this.logits(obs)
    return ACTION_DIMS.map((size, head) => {
      const start = HEAD_OFFSETS[head]
      let best = 0
      let top = -Infinity
      for (let i = 0; i < size; i++) {
        const s = mask[start + i] ? scores[start + i] : -Infinity
        if (s > top) { top = s; best = i }
      }
      return best
    })
  }
}

const holdsRanged = o => o[14] > 0.5 || o[15] > 0.5
const enemyRanged = o => o[50] > 0.5 || o[51] > 0.5 || o[57] > 0.5
const enemyFar = o => o[32] * RANGE_SCALE >= TAKEOVER_RANGE
const shieldFacing = o => o[53] > 0.5 && o[55] > 0
const SITUATIONS = {
  shooter: o => holdsRanged(o) && enemyFar(o) && !shieldFacing(o),
  blocker: o => !holdsRanged(o) && enemyRanged(o) && enemyFar(o)
}
const SPEC_HEADS = { shooter: [YAW, PITCH, USE, LOCK_AIM], blocker: [YAW, PITCH, USE] }

function fixHeads (name, expert, obs, mask) {
  const allowed = mask.slice()
  for (const [head, keep] of expert.locks) {
    const start = HEAD_OFFSETS[head]
    if (!allowed[start + keep]) continue
    allowed.fill(0, start, start + ACTION_DIMS[head])
    allowed[start + keep] = 1
  }
  if (SPEC_HEADS[name].includes(LOCK_AIM) && obs[ENEMY_IN_SIGHT] <= 0.5) {
    allowed[HEAD_OFFSETS[LOCK_AIM] + 1] = 0
    allowed[HEAD_OFFSETS[LOCK_AIM]] = 1
  }
  const chosen = expert.net.act(obs, allowed)
  for (const head of SPEC_HEADS[name]) {
    const start = HEAD_OFFSETS[head]
    mask.fill(0, start, start + ACTION_DIMS[head])
    mask[start + chosen[head]] = 1
  }
}

class Trained {
  constructor (saved) {
    this.net = new Net(saved.layers)
    this.experts = saved.experts.map(e => ({ name: e.name, locks: e.locks, net: new Net(e.layers) }))
  }

  act (rawObs, rawMask) {
    const obs = rawObs.map(v => Math.fround(Math.min(Math.max(v, -INPUT_LIMIT), INPUT_LIMIT)))
    const mask = rawMask.map(Number)
    for (const name of ['shooter', 'blocker']) {
      if (!SITUATIONS[name](obs)) continue
      const expert = this.experts.find(e => e.name === name)
      if (expert) fixHeads(name, expert, obs, mask)
      break
    }
    return this.net.act(obs, mask)
  }
}

const loadTrained = file => new Trained(JSON.parse(fs.readFileSync(file, 'utf8')))

module.exports = { Trained, loadTrained }
