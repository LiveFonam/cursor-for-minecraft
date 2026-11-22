"""Plays the comparison rounds in the simulator and writes one record per round.

    python sim_side.py --policy scripted --opponents zombie,duelist --rounds 150 --out sim.json

Mob rounds need a simulator with the mob module on PYTHONPATH.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from fighter import actions as A
from fighter import constants as C
from fighter.obs import build_masks, build_obs
from fighter.sim import Sim, SimConfig

from policies import POLICIES

HERE = Path(__file__).resolve().parent
SPEC = json.loads((HERE / "spec.json").read_text())
INPUT_LIMIT = 5.0


def trained(weights):
    sys.path.insert(0, str(HERE.parent.parent))
    from agents_policy import Player

    player = Player(weights)
    return lambda obs, mask, turn, rng: player.act(obs, mask)


CLIENT = {"model": "vanilla"}


def sim_config():
    return SimConfig(
        client_model=CLIENT["model"], armor=SPEC["armor"], arena_half=float(SPEC["arena_half"]), spawn_min=SPEC["spawn_min"],
        spawn_max=SPEC["spawn_max"], face_noise_deg=SPEC["face_noise"],
    )


def observe(sim, seat, allowed=None):
    obs = np.clip(build_obs(sim, seat, SPEC["round_ticks"]), -INPUT_LIMIT, INPUT_LIMIT)
    return obs, build_masks(sim, seat, allowed)


def fresh_tallies(n):
    return {k: np.zeros(n) for k in ("damage_dealt", "damage_taken", "swings", "hits", "shots", "arrow_hits")}


def add_events(tally, events, live):
    tally["damage_taken"] += events["damage_taken"][:, 0] * live
    tally["swings"] += events["swings"][:, 0] * live
    tally["hits"] += events["hits"][:, 0] * live
    tally["shots"] += events["arrows_fired"][:, 0] * live
    tally["arrow_hits"] += events["arrow_hits"][:, 0] * live


def records(tally, ticks, wins, losses):
    return [
        {"win": int(wins[i]), "loss": int(losses[i]), "ticks": int(ticks[i]),
         **{k: round(float(v[i]), 4) for k, v in tally.items()}}
        for i in range(len(ticks))
    ]


def play_bot(policy, opponent, rounds, seed):
    sim = Sim(rounds, sim_config(), seed=seed)
    sim.reset()
    rng = np.random.default_rng(seed + 1)
    other = POLICIES[opponent]
    tally = fresh_tallies(rounds)
    live = np.ones(rounds, dtype=bool)
    ticks = np.zeros(rounds, dtype=np.int64)
    wins = np.zeros(rounds, dtype=bool)
    losses = np.zeros(rounds, dtype=bool)
    turn = np.zeros(rounds, dtype=np.int64)
    idle = A.neutral_actions(np.full((rounds, 2), C.SWORD))
    while live.any():
        obs0, mask0 = observe(sim, 0)
        obs1, mask1 = observe(sim, 1)
        joined = np.stack([policy(obs0, mask0, turn, rng), other(obs1, mask1, turn, rng)], axis=1)
        joined[~live] = idle[~live]
        before = np.maximum(sim.hp[:, 1], 0.0)
        events = sim.step(joined)
        tally["damage_dealt"] += (before - np.maximum(sim.hp[:, 1], 0.0)).clip(0.0) * live
        add_events(tally, events, live)
        turn += 1
        ticks[live] += SPEC["ticks_per_decision"]
        my_dead = sim.hp[:, 0] <= 0.0
        their_dead = sim.hp[:, 1] <= 0.0
        ended = live & (my_dead | their_dead | (ticks >= SPEC["round_ticks"]))
        wins |= ended & their_dead & ~my_dead
        losses |= ended & my_dead & ~their_dead
        live &= ~ended
    return records(tally, ticks, wins, losses)


def play_mob(policy, opponent, rounds, seed):
    from fighter.mobs import KIND_NAMES, NO_MOB, MobConfig, MobSim

    sim = MobSim(rounds, sim_config(), seed=seed, mobs=MobConfig(
        difficulty=SPEC["difficulty"], spawn_min=SPEC["mob_spawn_min"], spawn_max=SPEC["mob_spawn_max"]))
    sim.reset()
    idx = np.arange(rounds)
    sim.weapon[idx, 0] = C.AXE
    table = np.full((rounds, sim.mobs.m), NO_MOB, dtype=np.int64)
    table[:, 0] = KIND_NAMES.index(opponent)
    sim.mobs.spawn_roster(idx, table)
    sim.show_focus()
    allowed = np.zeros((rounds, C.NUM_WEAPONS), dtype=bool)
    allowed[:, C.AXE] = True
    rng = np.random.default_rng(seed + 1)
    tally = fresh_tallies(rounds)
    live = np.ones(rounds, dtype=bool)
    ticks = np.zeros(rounds, dtype=np.int64)
    wins = np.zeros(rounds, dtype=bool)
    losses = np.zeros(rounds, dtype=bool)
    turn = np.zeros(rounds, dtype=np.int64)
    idle = A.neutral_actions(np.full(rounds, C.AXE))
    while live.any():
        obs, mask = observe(sim, 0, allowed)
        action = policy(obs, mask, turn, rng)
        action[~live] = idle[~live]
        joined = np.stack([action, A.neutral_actions(np.full(rounds, C.SWORD))], axis=1)
        before = np.maximum(sim.mobs.hp[:, 0], 0.0)
        events = sim.step(joined)
        tally["damage_dealt"] += (before - np.maximum(sim.mobs.hp[:, 0], 0.0)).clip(0.0) * live
        add_events(tally, events, live)
        turn += 1
        ticks[live] += SPEC["ticks_per_decision"]
        dead = sim.hp[:, 0] <= 0.0
        cleared = ~sim.mobs.alive.any(axis=1)
        ended = live & (dead | cleared | (ticks >= SPEC["round_ticks"]))
        wins |= ended & cleared & ~dead & (sim.mobs.blasts == 0)
        losses |= ended & dead
        live &= ~ended
    return records(tally, ticks, wins, losses)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--policy", default="scripted", help="scripted, random or trained")
    ap.add_argument("--weights", help="campaign folder for a trained policy")
    ap.add_argument("--opponents", default=",".join(SPEC["mobs"] + SPEC["bots"]))
    ap.add_argument("--rounds", type=int, default=150)
    ap.add_argument("--seed", type=int, default=7001)
    ap.add_argument("--client", default="vanilla", choices=("vanilla", "mineflayer"), help="the client that moves the bodies")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    CLIENT["model"] = args.client
    policy = trained(args.weights) if args.policy == "trained" else POLICIES[args.policy]
    result = {"side": "sim", "policy": args.policy, "client": args.client, "matchups": {}}
    for k, name in enumerate(args.opponents.split(",")):
        start = time.time()
        play = play_mob if name in SPEC["mobs"] else play_bot
        result["matchups"][name] = play(policy, name, args.rounds, args.seed + 100 * k)
        wins = sum(r["win"] for r in result["matchups"][name])
        print(f"{args.policy} vs {name}: {wins}/{args.rounds} wins in {time.time() - start:.1f}s", flush=True)
    Path(args.out).write_text(json.dumps(result))


if __name__ == "__main__":
    main()
