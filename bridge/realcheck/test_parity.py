"""Compares every input, mask and action head of bridge/fighter.js with the simulator.

Run with the simulator's environment on the path:

    PYTHONPATH=<simulator>/src <simulator>/.venv/bin/python -m pytest bridge/realcheck/test_parity.py
"""

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter.obs import OBS_DIM, build_masks, build_obs
from fighter.sim import Sim, SimConfig

STUB = Path(__file__).with_name("parity_stub.js")
NODE = shutil.which("node")
ITEM = {C.SWORD: "diamond_sword", C.AXE: "diamond_axe", C.BOW: "bow", C.CROSSBOW: "crossbow"}
SLOT_OF = {C.AXE: 0, C.SWORD: 1, C.CROSSBOW: 2, C.BOW: 3}
TOLERANCE = 2e-4

pytestmark = pytest.mark.skipif(NODE is None, reason="Node is not installed")


def run_client(acts=(), states=()):
    out = subprocess.run(
        [NODE, str(STUB)], input=json.dumps({"acts": list(acts), "states": list(states)}),
        capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr[-3000:]
    return json.loads(out.stdout)


def client_yaw(yaw):
    return float(np.pi - np.radians(yaw))


def client_pitch(pitch):
    return float(-np.radians(pitch))


def state_of(sim, env, seat=0):
    you = 1 - seat
    memory = sim.perception
    period = C.TICKS_PER_SECOND / float(C.WEAPON_ATTACK_SPEED[sim.weapon[env, you]])
    held = sim.combat.weapons_held(np.array([env]), seat)[0]
    arrows = [
        {"pos": sim.arrow_pos[env, k].tolist(), "vel": sim.arrow_vel[env, k].tolist(), "mine": bool(sim.arrow_owner[env, k] == seat)}
        for k in np.flatnonzero(sim.arrow_on[env])
    ]
    stuck = [
        {"pos": sim.stuck_pos[env, k].tolist(), "age": int(sim.stuck_age[env, k])}
        for k in np.flatnonzero(sim.stuck_on[env] & sim.stuck_pickup[env])
    ]
    shield = int(sim.shield_ticks[env, you])
    draw, load = int(sim.draw_ticks[env, you]), int(sim.load_ticks[env, you])
    hand = (1 | 2) if shield > 0 and sim.weapon[env, you] <= C.AXE else (1 if draw > 0 or load > 0 else 0)
    return {
        "pos": sim.pos[env, seat].tolist(), "vel": sim.vel[env, seat].tolist(),
        "yaw": client_yaw(sim.yaw[env, seat]), "pitch": client_pitch(sim.pitch[env, seat]),
        "on_ground": bool(sim.on_ground[env, seat]), "hp": float(sim.hp[env, seat]),
        "sprinting": bool(sim.sprinting[env, seat]), "sneaking": bool(sim.body.sneak[env, seat]),
        "in_water": bool(sim.combat.in_water[env, seat]), "eyes_in_water": bool(sim.combat.eyes_in_water[env, seat]),
        "hurt": int(sim.hurt_timer[env, seat]), "fall": float(sim.body.fall[env, seat]),
        "weapon": ITEM[int(sim.weapon[env, seat])],
        "hotbar": {str(SLOT_OF[w]): ITEM[w] for w in range(C.NUM_WEAPONS) if held[w]},
        "attack_ticks": float(sim.attack_ticks[env, seat]),
        "shield_ticks": int(sim.shield_ticks[env, seat]), "shield_cooldown": int(sim.shield_disabled[env, seat]),
        "loaded": bool(sim.loaded[env, seat]), "load_ticks": int(sim.load_ticks[env, seat]),
        "load_wait": bool(sim.load_wait[env, seat]), "draw_ticks": int(sim.draw_ticks[env, seat]),
        "ammo": int(sim.ammo[env, seat]), "since_hit": int(memory.since_hit[env, seat]),
        "since_hurt": int(memory.since_hurt[env, seat]), "since_disabled": int(memory.since_disabled[env, seat]),
        "since_enemy_swing": int(memory.since_enemy_swing[env, seat]), "since_whiff": int(memory.since_whiff[env, seat]),
        "combo": int(memory.combo[env, seat]), "last_action": memory.last_action[env, seat].tolist(),
        "last_move": sim.body.last_move[env, seat].tolist(), "ticks": int(sim.ticks[env]),
        "arena_half": float(sim.cfg.arena_half), "border_half": float(np.ravel(sim.border_half)[env if np.size(sim.border_half) > 1 else 0]),
        "enemy_pos": sim.pos[env, you].tolist(), "enemy_move": sim.body.last_move[env, you].tolist(),
        "enemy_yaw": client_yaw(sim.yaw[env, you]), "enemy_weapon": ITEM[int(sim.weapon[env, you])],
        "enemy_hp": float(sim.hp[env, you]), "enemy_health_known": float(memory.enemy_health[env, seat]),
        "enemy_hurt": int(sim.hurt_timer[env, you]), "enemy_attack_ticks": float(sim.attack_ticks[env, you]),
        "enemy_charge_ticks": period, "enemy_hand": hand, "enemy_shield_ticks": shield,
        "enemy_use_ticks": max(draw, load), "enemy_loaded": bool(sim.loaded[env, you] and sim.weapon[env, you] == C.CROSSBOW),
        "enemy_sprinting": bool(sim.sprinting[env, you]), "enemy_shield_cooldown": int(sim.shield_disabled[env, you]),
        "enemy_on_ground": bool(sim.on_ground[env, you]), "enemy_sneaking": bool(sim.body.sneak[env, you]), "arrows": arrows, "stuck": stuck,
    }


def played_sim(seed, n=64, steps=70):
    sim = Sim(n, SimConfig(armor="none", arena_half=15.0, spawn_min=2.0, spawn_max=10.0), seed=seed)
    rng = np.random.default_rng(seed)
    for _ in range(steps):
        masks = np.stack([build_masks(sim, 0), build_masks(sim, 1)], axis=1)
        logits = rng.gumbel(size=masks.shape)
        logits = np.where(masks, logits, -np.inf)
        action = np.zeros((n, 2, len(A.NVEC)), dtype=np.int64)
        for head, (start, size) in enumerate(zip(A.HEAD_OFFSETS, A.NVEC)):
            action[..., head] = logits[..., start : start + size].argmax(axis=-1)
        sim.step(action)
        done = (sim.hp <= 0.0).any(axis=1)
        if done.any():
            sim.reset(done)
    return sim


def test_tables_match():
    reply = run_client()
    assert reply["dims"] == A.NVEC.tolist()
    assert reply["yaw"] == A.YAW_DELTAS.tolist()
    assert reply["pitch"] == A.PITCH_DELTAS.tolist()
    assert reply["idle"] == A.idle_action().tolist()
    assert reply["obsDim"] == OBS_DIM
    assert reply["maskSize"] == A.MASK_SIZE


def test_every_head_choice_decodes_alike():
    acts, expected = [], []
    for head, size in enumerate(A.NVEC):
        for choice in range(size):
            action = A.idle_action()
            action[head] = choice
            if head == A.SPRINT:
                action[A.FORWARD] = A.KEY_FORWARD
            acts.append({"action": action.tolist(), "start": {"yaw": 1.0, "pitch": 0.2, "item": "diamond_sword"}})
            expected.append(action)
    reply = run_client(acts=acts)
    for action, out in zip(expected, reply["acts"]):
        keys = out["controls"]
        forward = A.FORWARD_VALUES[action[A.FORWARD]]
        strafe = A.STRAFE_VALUES[action[A.STRAFE]]
        assert keys["forward"] == bool(forward > 0)
        assert keys["back"] == bool(forward < 0)
        assert keys["left"] == bool(strafe < 0)
        assert keys["right"] == bool(strafe > 0)
        assert keys["sprint"] == bool(action[A.SPRINT] == 1 and forward > 0)
        assert keys["jump"] == bool(action[A.JUMP] == 1)
        assert keys["sneak"] == bool(action[A.SNEAK] == 1)
        wanted = A.WEAPON_CHOICES[action[A.WEAPON]]
        assert out["slot"] == (None if wanted < 0 else SLOT_OF[int(wanted)])
        assert out["swings"] == int(action[A.ATTACK] > 0)
        assert out["second"] == bool(action[A.ATTACK] == A.ATTACK_DOUBLE)


@pytest.mark.parametrize("head", [A.YAW, A.PITCH])
def test_turn_heads_move_the_view_alike(head):
    start_yaw, start_pitch = 37.0, 12.0
    acts = []
    for choice in range(A.NVEC[head]):
        action = A.idle_action()
        action[head] = choice
        acts.append({"action": action.tolist(), "start": {"yaw": client_yaw(start_yaw), "pitch": client_pitch(start_pitch), "item": "diamond_sword"}})
    reply = run_client(acts=acts)
    for choice, out in enumerate(reply["acts"]):
        sim = Sim(1, SimConfig(), seed=0)
        sim.yaw[0, 0] = start_yaw
        sim.pitch[0, 0] = start_pitch
        step = A.neutral_actions(sim.weapon.copy())
        step[0, 0, head] = choice
        sim.step(step)
        view_yaw = np.degrees(np.pi - out["yaw"])
        view_pitch = -np.degrees(out["pitch"])
        assert (sim.yaw[0, 0] - view_yaw + 180.0) % 360.0 - 180.0 == pytest.approx(0.0, abs=1e-9)
        assert sim.pitch[0, 0] == pytest.approx(view_pitch, abs=1e-9)


@pytest.mark.parametrize("seed", [11, 12, 13, 14])
@pytest.mark.parametrize("seat", [0, 1])
def test_all_inputs_and_masks_match_on_played_states(seed, seat):
    sim = played_sim(seed)
    reply = run_client(states=[state_of(sim, env, seat) for env in range(sim.n)])
    ours = build_obs(sim, seat, 600).astype(np.float64)
    theirs = np.array(reply["obs"], dtype=np.float64)
    assert theirs.shape == (sim.n, OBS_DIM)
    wrong = {int(slot): float(np.abs(ours[:, slot] - theirs[:, slot]).max()) for slot in range(OBS_DIM)
             if np.abs(ours[:, slot] - theirs[:, slot]).max() > TOLERANCE}
    assert not wrong, f"slots that differ: {wrong}"
    masks = build_masks(sim, seat)
    client = np.array(reply["masks"], dtype=bool)
    bad = np.flatnonzero((masks != client).any(axis=0))
    assert len(bad) == 0, f"mask columns that differ: {bad.tolist()}"


CROSSBOW_SCRIPT = r"""
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { Fighter } = require(process.argv[2])
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'))
const out = input.sequences.map(presses => {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.entity = { id: 1, type: 'player', position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, metadata: {} }
  bot.entities = { 1: bot.entity }
  bot.players = {}
  bot.health = 20
  bot.heldItem = { name: 'crossbow', components: [] }
  bot.quickBarSlot = 2
  const controls = {}
  bot.getControlState = k => !!controls[k]
  bot.setControlState = (k, v) => { controls[k] = v }
  bot.clearControlStates = () => {}
  bot.look = () => {}
  bot.activateItem = () => {}
  bot.deactivateItem = () => {}
  const f = new Fighter(bot, 'Rival', { arena: { x: 0, y: 0, z: 0, half: 12 } })
  const slot = { name: 'crossbow', get components () { return f.loaded ? [{ type: 'charged_projectiles', data: { projectiles: [{}] } }] : [] } }
  bot.inventory = { hotbarStart: 36, slots: { 38: slot }, items: () => [{ name: 'arrow', count: f.arrows }] }
  f.loaded = true
  f.arrows = 5
  return presses.map(use => {
    const action = [...input.idle]
    action[input.use] = use
    f.act(action)
    const row = [f.charging, f.loadWait]
    bot.emit('physicsTick')
    bot.emit('physicsTick')
    return row
  })
})
console.log(JSON.stringify(out))
"""


@pytest.mark.parametrize("presses", [
    [1, 1, 1, 1, 1, 1],
    [1, 0, 1, 1, 1, 1],
    [1, 0, 0, 1, 1, 1],
    [1, 1, 0, 1, 1, 1],
])
def test_crossbow_reload_matches(presses):
    sim = Sim(1, SimConfig(armor="none", arena_half=30.0), seed=1)
    sim.pos[0, 1] = sim.pos[0, 0] + np.array([20.0, 0.0, 0.0])
    sim.weapon[0, 0] = C.CROSSBOW
    sim.loaded[0, 0] = True
    sim.ammo[0, 0] = 5
    ours = []
    for use in presses:
        action = A.neutral_actions(sim.weapon.copy())
        action[0, 0, A.USE] = use
        sim.step(action)
        ours.append([bool(sim.load_ticks[0, 0] > 0), bool(sim.load_wait[0, 0])])
    out = subprocess.run(
        [NODE, "-e", CROSSBOW_SCRIPT, "x", str(STUB.parent.parent / "fighter.js")],
        input=json.dumps({"sequences": [presses], "idle": A.idle_action().tolist(), "use": A.USE}),
        capture_output=True, text=True, timeout=60, cwd=str(STUB.parent.parent),
    )
    assert out.returncode == 0, out.stderr[-2000:]
    theirs = json.loads(out.stdout)[0]
    assert [row[0] for row in theirs] == [row[0] for row in ours]
