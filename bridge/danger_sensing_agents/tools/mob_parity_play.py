"""Plays whole mob rounds in the simulator with the network fed by this client's input builder (tools/mob_parity.js).

    OMP_NUM_THREADS=1 PYTHONPATH=<simulator>/src python mob_parity_play.py --expert expert.npz --out play.json

Three feeds on the same held-out seeds, with win rates listed per opponent:

    simulator   the simulator's own inputs, the baseline
    client      what a client sees each tick, built in Node
    server      the same with a modelled server's packet timing, built in Node

This shows whether input differences change how the network fights. It is still the simulator's flat arena and its
mobs, so it says nothing about real terrain or the real game. One thread, inference only.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(name, "1")

import numpy as np  # noqa: E402

from fighter.evaluate import HELD_OUT_SEED, wilson_interval  # noqa: E402
from fighter.mob_drill import MobExpert, MobFightEnv, play_rounds  # noqa: E402
from mob_parity_record import HIT_EVENTS, SCENARIOS, client_frame  # noqa: E402

HERE = Path(__file__).resolve().parent


class NodeFeed:
    """The Node input builder for every arena of one environment."""

    def __init__(self, level: str, env: MobFightEnv, expert: MobExpert):
        self.env = env
        self.expert = expert
        self.rng = np.random.default_rng(0)
        self.proc = subprocess.Popen(
            ["node", "--max-old-space-size=300", str(HERE / "mob_parity.js"), "--serve", level],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1 << 16,
        )
        self.pending = [[] for _ in range(env.num_envs)]
        self.started = [False] * env.num_envs
        sim = env.sim
        hits: list = []
        kicks: set = set()
        hurt = sim.mobs.hurt
        knock = sim.mobs.knock
        after_move = [False]

        def logged(where, slot, raw, by_player=True, armor=True):
            dealt, fresh = hurt(where, slot, raw, by_player, armor)
            for e, s, d, f in zip(where.tolist(), np.asarray(slot).tolist(), dealt.tolist(), fresh.tolist()):
                hits.append({"env": e, "slot": s, "dealt": d, "fresh": f, "byPlayer": bool(by_player)})
            return dealt, fresh

        def logged_knock(where, slot, dx, dz, strength):
            knock(where, slot, dx, dz, strength)
            if after_move[0]:
                kicks.update(zip(np.asarray(where).tolist(), np.asarray(slot).tolist()))

        sim.mobs.hurt = logged
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
            for e in range(env.num_envs):
                self.pending[e].append(client_frame(sim, e, before, hits, kicks))

        sim._tick = tick

    def send(self, msg: dict) -> None:
        self.proc.stdin.write(json.dumps(msg, separators=(",", ":")) + "\n")

    def act(self, _obs) -> np.ndarray:
        env = self.env
        sim = env.sim
        n = env.num_envs
        for e in range(n):
            if sim.ticks[e] == 0 or not self.started[e]:
                self.send({"start": {"arena": e, "frame": client_frame(sim, e, {k: sim.events[k] for k in HIT_EVENTS}, [])}})
                self.started[e] = True
            else:
                for frame in self.pending[e]:
                    self.send({"tick": {"arena": e, "frame": frame}})
            self.pending[e] = []
            self.send({"ask": e})
        self.proc.stdin.flush()
        rows = [json.loads(self.proc.stdout.readline()) for _ in range(n)]
        obs = np.array([r["obs"] for r in rows], dtype=np.float32)
        masks = np.array([r["mask"] for r in rows], dtype=bool)
        actions = self.expert.act(obs, masks, self.rng)
        for e in range(n):
            self.send({"act": {"arena": e, "action": [int(v) for v in actions[e]]}})
        return actions

    def close(self) -> None:
        self.proc.stdin.close()
        self.proc.wait(timeout=10)


def play(expert: MobExpert, feed: str, name: str, seed: int, arenas: int, per_arena: int) -> dict:
    env = MobFightEnv(arenas, {name: 1.0}, seed=seed)
    if feed == "simulator":
        rng = np.random.default_rng(0)
        result = play_rounds(env, lambda obs: expert.act(obs, env.action_masks(), rng), per_arena)
    else:
        node = NodeFeed(feed, env, expert)
        try:
            result = play_rounds(env, node.act, per_arena)
        finally:
            node.close()
    low, high = wilson_interval(result["wins"], result["rounds"])
    return {
        "rounds": result["rounds"], "wins": result["wins"], "deaths": result["deaths"],
        "win_rate": round(result["wins"] / max(result["rounds"], 1), 4),
        "win_low": round(low, 4), "win_high": round(high, 4),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--expert", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--arenas", type=int, default=16)
    parser.add_argument("--per-arena", type=int, default=4)
    parser.add_argument("--feeds", default="simulator,client,server")
    args = parser.parse_args()
    expert = MobExpert.load(args.expert)
    report: dict = {"rounds_per_opponent": args.arenas * args.per_arena, "feeds": {}}
    for feed in args.feeds.split(","):
        report["feeds"][feed] = {}
        for offset, name in enumerate(SCENARIOS):
            row = play(expert, feed, name, HELD_OUT_SEED + offset, args.arenas, args.per_arena)
            report["feeds"][feed][name] = row
            print(f"{feed:10s} {name:9s} wins {row['wins']}/{row['rounds']} = {row['win_rate']:.3f} "
                  f"[{row['win_low']:.3f}, {row['win_high']:.3f}] deaths {row['deaths']}", flush=True)
    Path(args.out).write_text(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
