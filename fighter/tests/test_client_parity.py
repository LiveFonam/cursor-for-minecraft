"""Compares action decoding and shared inputs with the JavaScript game client.

Set FIGHTER_CLIENT_JS to the path of the client's fighter.js. The tests skip when
the variable is unset, the file is absent or Node is not installed.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter.obs import OBS_DIM, build_obs
from fighter.sim import Sim, SimConfig

CLIENT = os.environ.get("FIGHTER_CLIENT_JS", "")
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(
    not (CLIENT and Path(CLIENT).is_file() and NODE), reason="the game client or Node is not available"
)

HARNESS = r"""
const Module = require('module')
class Vec3 {
  constructor (x, y, z) { this.x = x; this.y = y; this.z = z }
  offset (x, y, z) { return new Vec3(this.x + x, this.y + y, this.z + z) }
  clone () { return new Vec3(this.x, this.y, this.z) }
  equals (o) { return this.x === o.x && this.y === o.y && this.z === o.z }
  distanceTo (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) }
}
const STUBS = {
  vec3: { Vec3 },
  'mineflayer/lib/conversions': { toNotchianYaw: y => (Math.PI - y) * 180 / Math.PI, toNotchianPitch: p => -p * 180 / Math.PI },
  './fair_health': { HealthEstimate: class {}, APPLES: {}, EAT_TICKS: 32, meleeDamage: () => 0, arrowDamage: () => 0 }
}
const load = Module._load
Module._load = function (request, parent, main) {
  return request in STUBS ? STUBS[request] : load.call(this, request, parent, main)
}
const client = require(process.argv[2])
const { Fighter } = client
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'))
const v3 = a => new Vec3(a[0], a[1], a[2])
const held = name => (name === 'none' ? null : { name, components: [] })

function acting (start) {
  const f = Object.create(Fighter.prototype)
  const controls = {}
  const out = { controls, slot: null, swings: 0, second: false }
  f.bot = {
    entity: { yaw: start.yaw, pitch: start.pitch, onGround: true, position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0) },
    heldItem: held(start.item),
    quickBarSlot: -1,
    setControlState: (k, v) => { controls[k] = v },
    look: (y, p) => { out.yaw = y; out.pitch = p },
    setQuickBarSlot: s => { out.slot = s },
    activateItem: () => {},
    deactivateItem: () => {}
  }
  f.prevAction = client.IDLE_ACTION
  f.events = { toggles: 0, jumpResets: 0 }
  f.ticksSinceHitMe = 100
  f.shieldUp = false
  f.charging = false
  f.drawing = false
  f.shieldCooldown = 0
  f.enemy = { entity: () => null }
  f.useCrossbow = () => {}
  f.useBow = () => {}
  f.swing = () => { out.swings++ }
  Object.defineProperty(f, 'secondClick', { set (v) { out.second = v }, get () { return out.second } })
  return { f, out }
}

function observing (s) {
  const f = Object.create(Fighter.prototype)
  const body = { type: 'player', position: v3(s.enemy_pos), yaw: s.enemy_yaw, heldItem: held(s.enemy_weapon) }
  f.bot = {
    entities: {},
    entity: { id: 'self', yaw: s.yaw, pitch: s.pitch, onGround: s.on_ground, isInWater: s.in_water, position: v3(s.pos), velocity: v3(s.vel) },
    heldItem: held(s.weapon),
    health: s.hp,
    getControlState: k => (k === 'sneak' ? s.sneak : k === 'sprint' ? s.sprinting : false),
    blockAt: () => ({ name: s.eyes_in_water ? 'water' : 'air' })
  }
  f.enemy = Object.assign(Object.create(client.EnemyView.prototype), {
    bot: { players: { rival: { entity: body } } },
    username: 'rival',
    lookup: null,
    vel: v3(s.enemy_move),
    history: [body.position, body.position],
    damageTaken: 20 - s.enemy_hp,
    hurtTimer: s.enemy_hurt_timer,
    ticksSinceSwing: s.since_enemy_swing,
    charge: () => Math.min(Math.max((s.enemy_attack_ticks + 0.5) / s.enemy_charge_ticks, 0), 1),
    useTicks: s.enemy_use_ticks,
    shieldCooldown: s.enemy_shield_cooldown,
    shieldUp: () => s.enemy_shield_up,
    shieldActive: () => s.enemy_shield_active,
    rangedUse: () => s.enemy_ranged_use,
    crossbowLoaded: () => s.enemy_loaded,
    sprinting: () => s.enemy_sprinting
  })
  f.arena = s.arena
  f.borderHalf = s.border_half
  f.readyGate = s.ready_gate
  f.sight = { pos: null, move: null, visible: false, chestClear: false, crosshairClear: false, seen: false }
  f.arrowsSeen = new Map(s.arrows.map((a, i) => [i, { pos: v3(a.pos), vel: v3(a.vel), grounded: a.grounded, groundAge: a.age }]))
  f.arrowOwner = new Map()
  f.lastMove = v3(s.last_move)
  f.fairHealth = false
  f.sprintFlag = s.sprinting
  f.hurtTimer = s.hurt_timer
  f.fall = s.fall
  f.ticks = s.ticks
  f.ticksSinceSwing = s.attack_ticks
  f.shieldUp = s.shield_up
  f.shieldTicks = s.shield_ticks
  f.shieldCooldown = s.shield_cooldown
  f.ticksSinceHit = s.since_hit
  f.ticksSinceHurt = s.since_hurt
  f.ticksSinceDisabled = s.since_disabled
  f.ticksSinceWhiff = s.since_whiff
  f.combo = s.combo
  f.loaded = s.loaded
  f.charging = s.load_ticks > 0
  f.loadTicks = s.load_ticks
  f.drawing = s.draw_ticks > 0
  f.drawTicks = s.draw_ticks
  f.arrows = s.ammo
  f.prevAction = s.last_action
  return f
}

const reply = { dims: client.ACTION_DIMS, yaw: client.YAW_STEPS, pitch: client.PITCH_STEPS, idle: client.IDLE_ACTION, obsDim: client.OBS_DIM }
reply.acts = input.acts.map(a => {
  const { f, out } = acting(a.start)
  f.act(a.action)
  return out
})
reply.obs = input.states.map(s => observing(s).observe())
console.log(JSON.stringify(reply))
"""

ITEM = {C.SWORD: "diamond_sword", C.AXE: "diamond_axe", C.BOW: "bow", C.CROSSBOW: "crossbow"}
SLOT_OF = {C.AXE: 0, C.SWORD: 1, C.CROSSBOW: 2, C.BOW: 3}

# The simulator and the client share one input layout.
EXACT_SLOTS = range(OBS_DIM)


def run_client(acts=(), states=()):
    payload = json.dumps({"acts": list(acts), "states": list(states)})
    out = subprocess.run(
        [NODE, "-e", HARNESS, "harness", str(Path(CLIENT).resolve())],
        input=payload, capture_output=True, text=True, timeout=60,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    return json.loads(out.stdout)


def client_yaw(yaw):
    return float(np.pi - np.radians(yaw))


def client_pitch(pitch):
    return float(-np.radians(pitch))


def state_of(sim, env, seat=0):
    you = 1 - seat
    memory = sim.perception
    period = C.TICKS_PER_SECOND / float(C.WEAPON_ATTACK_SPEED[sim.weapon[env, you]])
    return {
        "pos": sim.pos[env, seat].tolist(),
        "vel": sim.vel[env, seat].tolist(),
        "yaw": client_yaw(sim.yaw[env, seat]),
        "pitch": client_pitch(sim.pitch[env, seat]),
        "on_ground": bool(sim.on_ground[env, seat]),
        "hp": float(sim.hp[env, seat]),
        "sprinting": bool(sim.sprinting[env, seat]),
        "weapon": ITEM[int(sim.weapon[env, seat])],
        "attack_ticks": float(sim.attack_ticks[env, seat]),
        "shield_up": bool(sim.shield_ticks[env, seat] > 0),
        "shield_ticks": max(int(sim.shield_ticks[env, seat]) - 1, 0),
        "shield_cooldown": int(sim.shield_disabled[env, seat]),
        "loaded": bool(sim.loaded[env, seat]),
        "load_ticks": int(sim.load_ticks[env, seat]),
        "draw_ticks": int(sim.draw_ticks[env, seat]),
        "ammo": int(sim.ammo[env, seat]),
        "since_hit": int(memory.since_hit[env, seat]),
        "since_hurt": int(memory.since_hurt[env, seat]),
        "since_disabled": int(memory.since_disabled[env, seat]),
        "since_enemy_swing": int(memory.since_enemy_swing[env, seat]),
        "since_whiff": int(memory.since_whiff[env, seat]),
        "combo": int(memory.combo[env, seat]),
        "last_action": memory.last_action[env, seat].tolist(),
        "round_time": min(float(sim.ticks[env]) / 1200.0, 1.0),
        "enemy_pos": sim.pos[env, you].tolist(),
        "enemy_move": sim.body.last_move[env, you].tolist(),
        "enemy_yaw": client_yaw(sim.yaw[env, you]),
        "enemy_weapon": ITEM[int(sim.weapon[env, you])],
        "enemy_hp": float(memory.enemy_health[env, seat]),
        "enemy_attack_ticks": float(sim.attack_ticks[env, you]),
        "enemy_charge_ticks": period,
        "enemy_shield_up": bool(sim.shield_ticks[env, you] > 0),
        "enemy_shield_active": bool(sim.shield_ticks[env, you] >= C.SHIELD_RAISE_TICKS),
        "enemy_ranged_use": bool(sim.draw_ticks[env, you] > 0 or sim.load_ticks[env, you] > 0),
        "enemy_loaded": bool(sim.loaded[env, you] and sim.weapon[env, you] == C.CROSSBOW),
        "enemy_sprinting": bool(sim.sprinting[env, you]),
        "enemy_shield_cooldown": int(sim.shield_disabled[env, you]),
        "enemy_hurt_timer": int(sim.hurt_timer[env, you]),
        "enemy_use_ticks": int(max(sim.draw_ticks[env, you], sim.load_ticks[env, you])),
        "in_water": bool(sim.combat.in_water[env, seat]),
        "eyes_in_water": bool(sim.combat.eyes_in_water[env, seat]),
        "sneak": bool(sim.body.sneak[env, seat]),
        "hurt_timer": int(sim.hurt_timer[env, seat]),
        "fall": float(sim.body.fall[env, seat]),
        "ticks": int(sim.ticks[env]),
        "last_move": sim.body.last_move[env, seat].tolist(),
        "ready_gate": float(sim.cfg.ready_gate),
        "arrows": [
            {"pos": sim.arrow_pos[env, i].tolist(), "vel": sim.arrow_vel[env, i].tolist(), "grounded": False, "age": 0}
            for i in np.flatnonzero(sim.arrow_on[env] & (sim.arrow_owner[env] != seat)).tolist()
        ] + [
            {"pos": sim.stuck_pos[env, i].tolist(), "vel": [0.0, 0.0, 0.0], "grounded": True, "age": int(sim.stuck_age[env, i])}
            for i in np.flatnonzero(sim.stuck_on[env] & sim.stuck_pickup[env]).tolist()
        ],
        "border_half": float(np.broadcast_to(sim.border_half, (sim.n,))[env]),
        "arena": dict(zip("xyz", np.broadcast_to(sim.origin, (sim.n, 3))[env].tolist()), half=float(sim.cfg.arena_half)),
    }


def test_action_tables_match_the_client():
    reply = run_client()
    assert reply["dims"] == A.NVEC.tolist()
    assert reply["yaw"] == A.YAW_DELTAS.tolist()
    assert reply["pitch"] == A.PITCH_DELTAS.tolist()
    assert reply["idle"] == A.idle_action().tolist()


def test_every_head_choice_decodes_like_the_client():
    acts = []
    expected = []
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
def test_turn_heads_move_the_view_like_the_client(head):
    start_yaw, start_pitch = 37.0, 12.0
    choices = range(A.NVEC[head])
    acts = []
    for choice in choices:
        action = A.idle_action()
        action[head] = choice
        acts.append({
            "action": action.tolist(),
            "start": {"yaw": client_yaw(start_yaw), "pitch": client_pitch(start_pitch), "item": "diamond_sword"},
        })
    reply = run_client(acts=acts)
    for choice, out in zip(choices, reply["acts"]):
        sim = Sim(1, SimConfig(), seed=0)
        sim.yaw[0, 0] = start_yaw
        sim.pitch[0, 0] = start_pitch
        step = A.neutral_actions(sim.weapon.copy())
        step[0, 0, head] = choice
        sim.step(step)
        client_view_yaw = np.degrees(np.pi - out["yaw"])
        client_view_pitch = -np.degrees(out["pitch"])
        assert (sim.yaw[0, 0] - client_view_yaw + 180.0) % 360.0 - 180.0 == pytest.approx(0.0, abs=1e-9)
        assert sim.pitch[0, 0] == pytest.approx(client_view_pitch, abs=1e-9)


def played_sim(seed=11, n=48):
    sim = Sim(n, SimConfig(armor="none", arena_half=15.0, spawn_min=2.0, spawn_max=10.0), seed=seed)
    rng = np.random.default_rng(seed)
    for _ in range(60):
        action = rng.integers(0, A.NVEC, size=(n, 2, len(A.NVEC)))
        action[..., A.LOCK_AIM] = 0
        action[..., A.SNEAK] = 0
        sim.step(action)
        done = (sim.hp <= 0.0).any(axis=1)
        if done.any():
            sim.reset(done)
    return sim


def test_shared_inputs_match_the_client_on_played_states():
    sim = played_sim()
    states = [state_of(sim, env) for env in range(sim.n)]
    reply = run_client(states=states)
    assert reply["obsDim"] == OBS_DIM
    ours = build_obs(sim, 0, 600).astype(np.float64)
    theirs = np.array(reply["obs"], dtype=np.float64)
    assert theirs.shape == (sim.n, OBS_DIM)
    for slot in EXACT_SLOTS:
        assert ours[:, slot] == pytest.approx(theirs[:, slot], abs=2e-5), f"slot {slot}"


def test_yaw_error_slots_match_the_client_angle():
    sim = played_sim(seed=12)
    reply = run_client(states=[state_of(sim, env) for env in range(sim.n)])
    client = np.array(reply["obs"], dtype=np.float64)
    theirs = np.arctan2(client[:, 26], client[:, 27])
    ours = build_obs(sim, 0, 600).astype(np.float64)
    assert ours[:, 26] == pytest.approx(np.sin(theirs), abs=2e-5)
    assert ours[:, 27] == pytest.approx(np.cos(theirs), abs=2e-5)
    assert ours[:, 29] == pytest.approx(np.clip(np.degrees(theirs) / 10.0, -1.0, 1.0), abs=2e-5)


@pytest.mark.parametrize("weapon", [C.BOW, C.CROSSBOW])
def test_lead_inputs_match_the_client_for_still_bodies(weapon):
    rng = np.random.default_rng(13)
    n = 32
    sim = Sim(n, SimConfig(armor="none", arena_half=30.0), seed=13)
    sim.pos[:, 0] = np.column_stack([rng.uniform(-5, 5, n), np.zeros(n), rng.uniform(-5, 5, n)])
    angle = rng.uniform(0.0, 2.0 * np.pi, n)
    distance = rng.uniform(6.0, 20.0, n)
    sim.pos[:, 1] = sim.pos[:, 0] + np.column_stack([np.cos(angle) * distance, np.zeros(n), np.sin(angle) * distance])
    sim.yaw[:, 0] = rng.uniform(-180.0, 180.0, n)
    sim.pitch[:, 0] = rng.uniform(-20.0, 20.0, n)
    sim.vel[:] = 0.0
    sim.body.last_move[:] = 0.0
    sim.weapon[:, 0] = weapon
    reply = run_client(states=[state_of(sim, env) for env in range(n)])
    ours = build_obs(sim, 0, 600).astype(np.float64)
    theirs = np.array(reply["obs"], dtype=np.float64)
    assert ours[:, 75] == pytest.approx(theirs[:, 75], abs=0.02)
    assert ours[:, 76] == pytest.approx(theirs[:, 76], abs=0.02)
    assert ours[:, 80] == pytest.approx(theirs[:, 80], abs=0.05)
