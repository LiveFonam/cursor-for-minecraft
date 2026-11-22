// Scripted players that read only the 130 inputs and the action mask. policies.py holds the same rules for the
// simulator, and test_policies.py checks that the two agree.

const { ACTION_DIMS, HEAD_OFFSETS, YAW_STEPS, PITCH_STEPS } = require('../fighter')

const [FORWARD, STRAFE, SPRINT, , YAW, PITCH, ATTACK, USE, WEAPON] = ACTION_DIMS.keys()
const KEY_FORWARD = 1
const KEY_BACK = 2
const KEY_LEFT = 1
const KEY_RIGHT = 2
const GUARD_FLIP = 10
const FIST_CHARGE = 0.95

const allowed = (mask, head, choice) => !!mask[HEAD_OFFSETS[head] + choice]

function nearest (values, wanted, mask, head) {
  let best = 0
  let cost = Infinity
  values.forEach((v, i) => {
    if (!allowed(mask, head, i)) return
    const c = Math.abs(v - wanted)
    if (c < cost) { cost = c; best = i }
  })
  return best
}

function base (obs, mask) {
  const action = new Array(ACTION_DIMS.length).fill(0)
  const yawError = Math.atan2(obs[26], obs[27]) * 180 / Math.PI
  action[YAW] = nearest(YAW_STEPS, yawError, mask, YAW)
  action[PITCH] = nearest(PITCH_STEPS, obs[28] * 90, mask, PITCH)
  return { action, distance: obs[32] * 32 }
}

const band = (d, far, near) => (d > far ? KEY_FORWARD : d < near ? KEY_BACK : 0)

function pickWeapon (action, obs, mask, slot, holds) {
  action[WEAPON] = obs[holds] < 0.5 && allowed(mask, WEAPON, slot) ? slot : 0
}

function reach (obs, mask) {
  const { action, distance } = base(obs, mask)
  pickWeapon(action, obs, mask, 1, 12)
  action[FORWARD] = band(distance, 2.6, 1.8)
  action[SPRINT] = distance > 3.6 && allowed(mask, SPRINT, 1) ? 1 : 0
  action[ATTACK] = obs[35] > 0.5 && obs[17] > 0.5 && allowed(mask, ATTACK, 1) ? 1 : 0
  return action
}

function duelist (obs, mask) {
  const { action, distance } = base(obs, mask)
  pickWeapon(action, obs, mask, 2, 13)
  action[FORWARD] = band(distance, 2.4, 1.6)
  action[SPRINT] = distance > 3.6 && allowed(mask, SPRINT, 1) ? 1 : 0
  action[ATTACK] = obs[35] > 0.5 && obs[16] >= FIST_CHARGE && allowed(mask, ATTACK, 1) ? 1 : 0
  return action
}

function guard (obs, mask, turn) {
  const { action, distance } = base(obs, mask)
  pickWeapon(action, obs, mask, 1, 12)
  action[FORWARD] = band(distance, 3.0, 2.2)
  action[STRAFE] = Math.floor(turn / GUARD_FLIP) % 2 === 0 ? KEY_LEFT : KEY_RIGHT
  const strike = obs[35] > 0.5 && obs[17] > 0.5
  action[ATTACK] = strike && obs[19] < 0.5 && allowed(mask, ATTACK, 1) ? 1 : 0
  action[USE] = distance < 4 && !strike && allowed(mask, USE, 1) ? 1 : 0
  return action
}

function uniform (obs, mask, turn, random = Math.random) {
  return ACTION_DIMS.map((size, head) => {
    let best = 0
    let score = -1
    for (let i = 0; i < size; i++) {
      if (!allowed(mask, head, i)) continue
      const s = random()
      if (s > score) { score = s; best = i }
    }
    return best
  })
}

module.exports = { POLICIES: { scripted: reach, duelist, guard, random: uniform } }
