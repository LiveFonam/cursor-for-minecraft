"""The crit timing rule, and its agreement with the JavaScript game client."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from fighter import actions as A
from fighter.obs import OBS_DIM
from fighter.stance import StanceRules, apply_crit

CLIENT = os.environ.get("FIGHTER_CLIENT_JS", "")
NODE = shutil.which("node")
SLOTS = (4, 5, 8, 11, 12, 16, 19, 32, 33, 35, 38, 46, 52, 55)
HEADS = (A.SPRINT, A.JUMP, A.ATTACK)

HARNESS = r"""
const Module = require('module')
const STUBS = {
  vec3: { Vec3: class {} },
  'mineflayer/lib/conversions': { toNotchianYaw: y => y, toNotchianPitch: p => p },
  './fair_health': { HealthEstimate: class {}, APPLES: {}, EAT_TICKS: 32, meleeDamage: () => 0, arrowDamage: () => 0 }
}
const load = Module._load
Module._load = function (request, parent, main) {
  return request in STUBS ? STUBS[request] : load.call(this, request, parent, main)
}
const { Fighter, MASK_SIZE, HEAD_OFFSETS, ACTION_DIMS, OBS_DIM } = require(process.argv[process.argv.length - 1])
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'))
const f = Object.create(Fighter.prototype)
f.critBarred = () => false
const out = input.rows.map((row, k) => {
  const obs = new Array(OBS_DIM).fill(0)
  input.slots.forEach((slot, i) => { obs[slot] = row[i] })
  const mask = new Array(MASK_SIZE).fill(1)
  mask[HEAD_OFFSETS[3] + 1] = input.can_jump[k]
  const fix = (h, choice) => {
    mask.fill(0, HEAD_OFFSETS[h], HEAD_OFFSETS[h] + ACTION_DIMS[h])
    mask[HEAD_OFFSETS[h] + choice] = 1
  }
  f.applyCritRule(mask, obs, fix)
  return input.heads.flatMap(h => mask.slice(HEAD_OFFSETS[h], HEAD_OFFSETS[h] + ACTION_DIMS[h]))
})
process.stdout.write(JSON.stringify(out))
"""


def random_states(count, seed):
    rng = np.random.default_rng(seed)
    obs = np.zeros((count, OBS_DIM))
    for slot in (4, 5, 8, 12, 19, 35, 38, 52):
        obs[:, slot] = rng.random(count) < (0.9 if slot in (12, 38) else 0.1 if slot in (8, 19) else 0.5)
    obs[:, 11] = rng.choice([0.0, 0.02, 0.2], count)
    obs[:, 16] = rng.choice([0.125, 0.475, 0.5, 0.525, 0.875, 0.9, 0.925, 1.0], count)
    obs[:, 32] = rng.uniform(0.0, 6.0, count) / 32.0
    obs[:, 33] = rng.uniform(0.0, 4.0, count) / 4.0
    obs[:, 46] = rng.choice([0.0, 0.1, 0.2, 0.3, 1.0], count)
    obs[:, 55] = rng.uniform(-1.0, 1.0, count)
    return obs, rng.random(count) < 0.7


def python_heads(obs, can_jump):
    mask = np.ones((len(obs), A.MASK_SIZE), dtype=bool)
    mask[:, int(A.HEAD_OFFSETS[A.JUMP]) + 1] = can_jump
    apply_crit(mask, obs, np.ones(len(obs), dtype=bool))
    parts = [mask[:, int(A.HEAD_OFFSETS[h]) : int(A.HEAD_OFFSETS[h]) + int(A.NVEC[h])] for h in HEADS]
    return np.concatenate(parts, axis=1)


def one(values, can_jump=True):
    obs = np.zeros((1, OBS_DIM))
    obs[0, [12, 38, 35]] = 1.0
    obs[0, 32] = 2.0 / 32.0
    obs[0, 33] = 0.4
    for slot, value in values.items():
        obs[0, slot] = value
    mask = np.ones((1, A.MASK_SIZE), dtype=bool)
    mask[0, int(A.HEAD_OFFSETS[A.JUMP]) + 1] = can_jump
    apply_crit(mask, obs, np.ones(1, dtype=bool))
    return lambda head: np.flatnonzero(mask[0, int(A.HEAD_OFFSETS[head]) : int(A.HEAD_OFFSETS[head]) + int(A.NVEC[head])]).tolist()


def test_rule_is_off_by_default():
    assert StanceRules().crit_rule is False


def test_ground_jumps_and_holds_a_ready_swing():
    heads = one({4: 1.0, 16: 0.95})
    assert heads(A.JUMP) == [1]
    assert heads(A.ATTACK) == [0]


def test_fall_with_ready_charge_swings_with_sprint_off():
    heads = one({11: 0.05, 16: 0.95})
    assert heads(A.SPRINT) == [0]
    assert heads(A.ATTACK) == [A.ATTACK_CLICK]


def test_fall_with_the_server_flag_still_on_waits_one_decision():
    heads = one({5: 1.0, 11: 0.05, 16: 0.95})
    assert heads(A.SPRINT) == [0]
    assert heads(A.ATTACK) == [0]


def test_raised_shield_facing_the_fighter_is_hit_at_once():
    assert one({4: 1.0, 16: 0.3, 52: 1.0, 55: 1.0})(A.ATTACK) == [A.ATTACK_CLICK]


def test_ready_swing_at_a_leaving_enemy_is_not_held():
    assert A.ATTACK_CLICK in one({16: 0.95, 33: 0.7})(A.ATTACK)


@pytest.mark.skipif(not (CLIENT and Path(CLIENT).is_file() and NODE), reason="the game client or Node is not available")
def test_jump_sprint_and_attack_match_the_client_on_random_states():
    obs, can_jump = random_states(3000, 41)
    payload = {
        "slots": list(SLOTS),
        "rows": obs[:, list(SLOTS)].tolist(),
        "can_jump": can_jump.astype(int).tolist(),
        "heads": list(HEADS),
    }
    done = subprocess.run(
        [NODE, "-e", HARNESS, str(Path(CLIENT).resolve())],
        input=json.dumps(payload), capture_output=True, text=True, check=True, timeout=60,
    )
    client = np.array(json.loads(done.stdout), dtype=bool)
    ours = python_heads(obs, can_jump)
    assert client.shape == ours.shape
    assert (client == ours).all(), f"{int((client != ours).any(axis=1).sum())} states differ"
