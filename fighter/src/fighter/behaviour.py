"""Per-opponent win rates and weapon behaviour of a campaign's fighter on held-out seeds."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from . import constants as C
from .campaign import FIGHTER, MAX_TICKS, ExpertStore, NumpyPolicy, load_experts, read_config
from .env import ArenaVecEnv
from .experts import expert_interface
from .opponents import OpponentPool
from .plans import PLANS
from .sim import SimConfig

OPPONENTS = (
    "walker", "strafer", "hit_and_run", "archer", "critter", "rusher",
    "axeman", "swinger", "random", "retreater", "shielder",
)
COUNTS = ("axe_hits", "crits", "shield_disables", "crossbow_loads", "crossbow_shots", "bow_shots", "shots_into_shield")


def measure(policy, opponent, interface, plan, seed: int, n_envs: int = 64, games_per_arena: int = 2) -> dict:
    """Play 2 games per arena and return results, weapon shares and counts per game."""
    pool = OpponentPool(n_envs, seed=seed + 1, max_ticks=MAX_TICKS, interface=interface)
    pool.set_mix({opponent: 1.0})
    config = SimConfig(ready_gate=plan.ready_gate)
    env = ArenaVecEnv(n_envs, pool, config, max_ticks=MAX_TICKS, seed=seed, interface=interface)
    env.set_weapons(plan.stages[-1].weapons)
    rng = np.random.default_rng(seed + 2)
    obs = env.reset()
    sim = env.sim
    seen: dict = {}
    original = sim.step

    def step(actions):
        events = original(actions)
        seen.update(weapon=sim.weapon[:, 0].copy(), loaded=sim.loaded[:, 0].copy(), events=events)
        seen["copy"] = {k: events[k].copy() for k in ("hits", "crits", "shield_breaks", "arrows_fired", "arrows_blocked")}
        return events

    sim.step = step
    played = np.zeros(n_envs, dtype=np.int64)
    results = [0, 0, 0]
    hold = np.zeros(C.NUM_WEAPONS)
    totals = dict.fromkeys(COUNTS, 0.0)
    while (played < games_per_arena).any():
        live = played < games_per_arena
        before = sim.loaded[:, 0].copy()
        actions = policy.act(obs, env.action_masks(), rng)
        env.step_async(actions)
        obs, _, done, infos = env.step_wait()
        held, ev = seen["weapon"], seen["copy"]
        hold += np.bincount(held[live], minlength=C.NUM_WEAPONS)
        totals["axe_hits"] += float(ev["hits"][live & (held == C.AXE), 0].sum())
        totals["crits"] += float(ev["crits"][live, 0].sum())
        totals["shield_disables"] += float(ev["shield_breaks"][live, 0].sum())
        totals["crossbow_loads"] += float((seen["loaded"] & ~before & live).sum())
        totals["crossbow_shots"] += float(ev["arrows_fired"][live & (held == C.CROSSBOW), 0].sum())
        totals["bow_shots"] += float(ev["arrows_fired"][live & (held == C.BOW), 0].sum())
        totals["shots_into_shield"] += float(ev["arrows_blocked"][live, 1].sum())
        for arena in np.flatnonzero(done):
            if played[arena] < games_per_arena:
                results[{1: 0, 0: 1, -1: 2}[infos[arena]["outcome"]]] += 1
            played[arena] += 1
    games = sum(results)
    share = hold / max(hold.sum(), 1.0)
    return {
        "opponent": opponent,
        "games": games,
        "win_rate": round(results[0] / games, 4),
        "draw_rate": round(results[1] / games, 4),
        "loss_rate": round(results[2] / games, 4),
        "hold": {name: round(float(share[i]), 4) for name, i in (("sword", C.SWORD), ("axe", C.AXE), ("bow", C.BOW), ("crossbow", C.CROSSBOW))},
        **{key: round(value / games, 3) for key, value in totals.items()},
    }


def report(root: Path, seed: int) -> list[dict]:
    """Measure the current fighter of a campaign against every named opponent."""
    cfg = read_config(root)
    plan = PLANS[cfg.plan]
    meta = json.loads((root / FIGHTER / "policy.json").read_text())
    policy = NumpyPolicy.load(root / FIGHTER / "policy.npz")
    interface = expert_interface(MAX_TICKS, stance=plan.stance)
    interface.experts.install(load_experts(ExpertStore(root / "experts"), meta["experts"], cfg.id))
    return [measure(policy, name, interface, plan, seed) for name in OPPONENTS]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=1_000_003)
    parser.add_argument("--label", required=True)
    args = parser.parse_args()
    root = Path(args.out)
    rows = report(root, args.seed)
    (root / f"behaviour-{args.label}-{args.seed}.json").write_text(json.dumps(rows))
    for r in rows:
        h = r["hold"]
        print(
            f"{r['opponent']:11s} win {r['win_rate']:.3f} draw {r['draw_rate']:.3f} axe {h['axe']:.2f} "
            f"xbow {h['crossbow']:.2f} bow {h['bow']:.2f} hits {r['axe_hits']:.2f} crits {r['crits']:.2f} "
            f"disables {r['shield_disables']:.2f} loads {r['crossbow_loads']:.2f} shots {r['crossbow_shots']:.2f} "
            f"into_shield {r['shots_into_shield']:.2f}"
        )


if __name__ == "__main__":
    main()
