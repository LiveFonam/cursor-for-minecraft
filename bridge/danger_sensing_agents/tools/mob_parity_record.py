"""Records mob rounds from the simulator for the mob input parity check (tools/mob_parity.js).

    OMP_NUM_THREADS=1 PYTHONPATH=<simulator>/src python mob_parity_record.py --expert expert.npz --out rec.jsonl.gz

Writes one JSON line per event, for every arena of every scenario:

    {"start": ...}     a round began, with the first thing a client sees
    {"decide": ...}    the exact simulator state, the 182 inputs, the 57 mask values and the action it chose
    {"tick": ...}      one game tick as a client sees it: positions, health, entity flags and its own hits

Half the arenas act on the most likely action and half sample, so the recording also holds the clumsy situations a
trained policy avoids. Nothing here trains and it runs on one thread.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os

for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(name, "1")

import numpy as np  # noqa: E402

from fighter import actions as A  # noqa: E402
from fighter import constants as C  # noqa: E402
from fighter.mob_drill import MobExpert, MobFightEnv  # noqa: E402

SCENARIOS = ("zombie", "skeleton", "creeper", "enderman", "group2", "group3", "group4")
HIT_EVENTS = ("swings", "damage_taken", "melee_blocked", "arrows_blocked")


def nums(values) -> list:
    return [float(v) for v in values]


def mob_state(mobs, env: int, slot: int) -> dict:
    """Everything the simulator holds about one living mob that the inputs read."""
    return {
        "slot": slot,
        "kind": int(mobs.kind[env, slot]),
        "pos": nums(mobs.pos[env, slot]),
        "vel": nums(mobs.vel[env, slot]),
        "seenPos": nums(mobs.seen_pos[env, slot]),
        "seenVel": nums(mobs.seen_vel[env, slot]),
        "inSight": bool(mobs.in_sight[env, slot]),
        "hp": float(mobs.hp[env, slot]),
        "hurtTimer": int(mobs.hurt_timer[env, slot]),
        "yaw": float(mobs.yaw[env, slot]),
        "onGround": bool(mobs.on_ground[env, slot]),
        "swell": int(mobs.swell[env, slot]),
        "swellDir": int(mobs.swell_dir[env, slot]),
        "provoked": bool(mobs.provoked[env, slot]),
        "draw": int(mobs.draw[env, slot]),
    }


def exact_state(sim, env: int) -> dict:
    """The simulator's own numbers for this arena, as the inputs read them."""
    mem = sim.perception
    mobs = sim.mobs
    incoming = np.flatnonzero(sim.arrow_on[env] & (sim.arrow_owner[env] != 0)).tolist()
    return {
        "ticks": int(sim.ticks[env]),
        "arena": {"x": float(sim.origin[0]), "z": float(sim.origin[2]), "half": float(sim.cfg.arena_half)},
        "me": {
            "pos": nums(sim.pos[env, 0]),
            "vel": nums(sim.vel[env, 0]),
            "yaw": float(sim.yaw[env, 0]),
            "pitch": float(sim.pitch[env, 0]),
            "onGround": bool(sim.on_ground[env, 0]),
            "sprinting": bool(sim.sprinting[env, 0]),
            "sneaking": bool(sim.body.sneak[env, 0]),
            "hp": float(sim.hp[env, 0]),
            "hurtTimer": int(sim.hurt_timer[env, 0]),
            "fall": float(sim.body.fall[env, 0]),
            "inWater": bool(sim.combat.in_water[env, 0]),
            "eyesInWater": bool(sim.combat.eyes_in_water[env, 0]),
            "charge": float(sim.combat.charge()[env, 0]),
            "shieldTicks": int(sim.shield_ticks[env, 0]),
            "shieldDisabled": int(sim.shield_disabled[env, 0]),
            "useHeld": bool(sim.use_prev[env, 0]),
        },
        "memory": {
            "sinceHit": int(mem.since_hit[env, 0]),
            "sinceHurt": int(mem.since_hurt[env, 0]),
            "sinceDisabled": int(mem.since_disabled[env, 0]),
            "sinceSwing": int(mem.since_enemy_swing[env, 0]),
            "sinceWhiff": int(mem.since_whiff[env, 0]),
            "combo": int(mem.combo[env, 0]),
            "enemyHealth": float(mem.enemy_health[env, 0]),
            "lastAction": [int(v) for v in mem.last_action[env, 0]],
        },
        "mobs": [mob_state(mobs, env, s) for s in np.flatnonzero(mobs.alive[env]).tolist()],
        "arrows": [{"pos": nums(sim.arrow_pos[env, s]), "vel": nums(sim.arrow_vel[env, s])} for s in incoming],
    }


def client_frame(sim, env: int, before: dict, hits: list, kicks: set | None = None) -> dict:
    """One tick of what a real client receives or knows about itself. No simulator internals.

    `kicks` holds the mobs knocked after they moved this tick (a shield recoil, a blast). The game sends those as a
    velocity packet, so a client knows that speed before any position shows it.
    """
    mobs = sim.mobs
    seen = []
    for slot in np.flatnonzero(mobs.alive[env]).tolist():
        row = {
            "id": slot,
            "kind": int(mobs.kind[env, slot]),
            "pos": nums(mobs.pos[env, slot]),
            "hp": float(mobs.hp[env, slot]),
            "yaw": float(mobs.yaw[env, slot]),
            "swellDir": int(mobs.swell_dir[env, slot]) if mobs.kind[env, slot] == 2 else -1,
            "angry": bool(mobs.provoked[env, slot]),
            "drawing": bool(mobs.draw[env, slot] > 0),
        }
        if kicks and (env, slot) in kicks:
            row["kick"] = nums(mobs.vel[env, slot])
        seen.append(row)
    events = {k: float(sim.events[k][env, 0] - before[k][env, 0]) for k in ("swings", "damage_taken")}
    blocked = float(sim.events["melee_blocked"][env, 1] - before["melee_blocked"][env, 1])
    blocked += float(sim.events["arrows_blocked"][env, 0] - before["arrows_blocked"][env, 0])
    incoming = np.flatnonzero(sim.arrow_on[env] & (sim.arrow_owner[env] != 0)).tolist()
    return {
        "me": {
            "pos": nums(sim.pos[env, 0]),
            "vel": nums(sim.vel[env, 0]),
            "yaw": float(sim.yaw[env, 0]),
            "pitch": float(sim.pitch[env, 0]),
            "onGround": bool(sim.on_ground[env, 0]),
            "hp": float(sim.hp[env, 0]),
            "wall": bool(sim.body.wall_block[env, 0]),
        },
        "mobs": seen,
        "arrows": [{"id": s, "pos": nums(sim.arrow_pos[env, s]), "vel": nums(sim.arrow_vel[env, s])} for s in incoming],
        "swung": events["swings"] > 0,
        "hurt": events["damage_taken"] > 0,
        "blocked": blocked > 0,
        "hitMobs": [h["slot"] for h in hits if h["env"] == env and h["byPlayer"] and h["dealt"] > 0],
        "hurtMobs": [h["slot"] for h in hits if h["env"] == env and h["fresh"]],
    }


def record(expert: MobExpert, out, name: str, arenas: int, decisions: int, seed: int) -> dict:
    env = MobFightEnv(arenas, {name: 1.0}, seed=seed)
    sim = env.sim
    rng = np.random.default_rng(seed)
    hits: list = []
    pending: dict[int, list] = {e: [] for e in range(arenas)}

    hurt = sim.mobs.hurt

    def logged(where, slot, raw, by_player=True, armor=True):
        dealt, fresh = hurt(where, slot, raw, by_player, armor)
        for e, s, d, f in zip(where.tolist(), np.asarray(slot).tolist(), dealt.tolist(), fresh.tolist()):
            hits.append({"env": e, "slot": s, "dealt": d, "fresh": f, "byPlayer": bool(by_player)})
        return dealt, fresh

    sim.mobs.hurt = logged
    kicks: set = set()
    after_move = [False]
    knock = sim.mobs.knock

    def logged_knock(where, slot, dx, dz, strength):
        knock(where, slot, dx, dz, strength)
        if after_move[0]:
            kicks.update(zip(np.asarray(where).tolist(), np.asarray(slot).tolist()))

    sim.mobs.knock = logged_knock
    for method in ("_melee_attacks", "_fuses"):
        def phase(*a, inner=getattr(sim.mobs, method)):
            after_move[0] = True
            try:
                return inner(*a)
            finally:
                after_move[0] = False

        setattr(sim.mobs, method, phase)
    step_tick = sim._tick

    def tick(actions, first):
        before = {k: sim.events[k].copy() for k in HIT_EVENTS}
        hits.clear()
        kicks.clear()
        step_tick(actions, first)
        for e in range(arenas):
            pending[e].append(client_frame(sim, e, before, hits, kicks))

    sim._tick = tick
    write = lambda msg: out.write(json.dumps(msg, separators=(",", ":")) + "\n")
    key = lambda e: f"{name}/{e}"
    obs = env.reset()
    for e in range(arenas):
        write({"start": {"arena": key(e), "scenario": name, "frame": client_frame(sim, e, {k: sim.events[k] for k in HIT_EVENTS}, [])}})
    samples = 0
    for _ in range(decisions):
        masks = env.action_masks()
        greedy = expert.act(obs, masks, rng, deterministic=True)
        sampled = expert.act(obs, masks, rng, deterministic=False)
        chosen = greedy.copy()
        chosen[1::2] = sampled[1::2]
        for e in range(arenas):
            write({"decide": {
                "arena": key(e),
                "greedy": e % 2 == 0,
                "state": exact_state(sim, e),
                "obs": [float(v) for v in obs[e]],
                "mask": [int(v) for v in masks[e]],
                "action": [int(v) for v in chosen[e]],
                "best": [int(v) for v in greedy[e]],
            }})
            samples += 1
        env.step_async(chosen)
        obs, _, done, _ = env.step_wait()
        for e in range(arenas):
            for frame in pending[e]:
                write({"tick": {"arena": key(e), "frame": frame}})
            pending[e] = []
            if done[e]:
                write({"start": {"arena": key(e), "scenario": name, "frame": client_frame(sim, e, {k: sim.events[k] for k in HIT_EVENTS}, [])}})
    return {"scenario": name, "samples": samples}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--expert", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--arenas", type=int, default=4)
    parser.add_argument("--decisions", type=int, default=240)
    parser.add_argument("--seed", type=int, default=9100)
    args = parser.parse_args()
    expert = MobExpert.load(args.expert)
    if expert.shared_dim != 130 or expert.extra_dim != 52 or int(np.sum(expert.nvec)) != A.MASK_SIZE:
        raise SystemExit("this expert does not have the 130 + 52 input layout")
    if C.TICKS_PER_DECISION != 2:
        raise SystemExit("the recording assumes two game ticks per decision")
    summary = []
    with gzip.open(args.out, "wt", compresslevel=6) as out:
        for offset, name in enumerate(SCENARIOS):
            summary.append(record(expert, out, name, args.arenas, args.decisions, args.seed + offset))
    print(json.dumps({"out": args.out, "scenarios": summary}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
