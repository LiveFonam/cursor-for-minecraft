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
from .opponents import LEAGUE, OpponentPool
from .plans import PLANS
from .sim import SimConfig

OPPONENTS = (
    "walker", "strafer", "hit_and_run", "archer", "critter", "rusher",
    "axeman", "swinger", "random", "retreater", "shielder",
    "pvp_basic", "pvp_combo", "pvp_sweat", "shield_holder",
)
COUNTS = ("axe_hits", "crits", "shield_disables", "crossbow_loads", "crossbow_shots", "bow_shots", "shots_into_shield")
ROUND_SHARES = ("load_started_2", "loaded_by_40")
FOLLOWUPS = (
    "followup_chances_disable",
    "followup_shots_disable",
    "followup_chances_knockback",
    "followup_shots_knockback",
    "followup_hits",
    "shots_wasted_hurt",
)
OPENING_DECISIONS = 2
LOADED_BY_TICK = 40
FOLLOWUP_DISABLE_TICKS = 10
FOLLOWUP_KNOCKBACK_TICKS = C.HURT_TICKS + 10
FOLLOWUP_FLIGHT_TICKS = 20


class RoundTracker:
    """Follows the crossbow opening and follow-up shots of the measured fighter in every arena.

    A chance is a shield disable or a landed axe hit with the crossbow loaded. A shot counts
    as its follow-up if it leaves within the window, which after an axe hit includes the
    enemy hurt window. A follow-up hit is an arrow that lands within the flight window.
    """

    def __init__(self, n: int):
        self.decisions = np.zeros(n, dtype=np.int64)
        self.started = np.zeros(n, dtype=bool)
        self.loaded_early = np.zeros(n, dtype=bool)
        self.disable_until = np.full(n, -1, dtype=np.int64)
        self.knockback_until = np.full(n, -1, dtype=np.int64)
        self.flight_until = np.full(n, -1, dtype=np.int64)
        self.totals = dict.fromkeys(ROUND_SHARES + FOLLOWUPS, 0.0)

    def step(self, live, ticks, loaded, load_ticks, held, ev) -> None:
        """Update every arena from the state and events at the end of one decision."""
        early = self.decisions < OPENING_DECISIONS
        self.started |= early & ((load_ticks > 0) | loaded)
        self.loaded_early |= loaded & (ticks <= LOADED_BY_TICK)

        fired = (ev["arrows_fired"][:, 0] > 0) & (held == C.CROSSBOW)
        after_disable = fired & (ticks <= self.disable_until)
        after_knockback = fired & ~after_disable & (ticks <= self.knockback_until)
        followed = after_disable | after_knockback
        self.flight_until[followed] = ticks[followed] + FOLLOWUP_FLIGHT_TICKS
        self.disable_until[followed] = -1
        self.knockback_until[followed] = -1
        landed = (ev["arrow_hits"][:, 0] > 0) & (ticks <= self.flight_until)
        self.flight_until[landed] = -1

        broke = (ev["shield_breaks"][:, 0] > 0) & loaded
        knocked = (ev["hits"][:, 0] > 0) & (held == C.AXE) & loaded & ~broke
        self.disable_until[broke] = ticks[broke] + FOLLOWUP_DISABLE_TICKS
        self.knockback_until[knocked] = ticks[knocked] + FOLLOWUP_KNOCKBACK_TICKS

        self.totals["followup_shots_disable"] += float((after_disable & live).sum())
        self.totals["followup_shots_knockback"] += float((after_knockback & live).sum())
        self.totals["followup_hits"] += float((landed & live).sum())
        self.totals["followup_chances_disable"] += float((broke & live).sum())
        self.totals["followup_chances_knockback"] += float((knocked & live).sum())
        self.totals["shots_wasted_hurt"] += float(ev["arrows_wasted"][live, 0].sum())
        self.decisions += 1

    def finish(self, arenas: np.ndarray, counted: np.ndarray) -> None:
        """Close the rounds that ended and clear those arenas."""
        rows = arenas[counted[arenas]]
        self.totals["load_started_2"] += float(self.started[rows].sum())
        self.totals["loaded_by_40"] += float(self.loaded_early[rows].sum())
        self.decisions[arenas] = 0
        self.started[arenas] = False
        self.loaded_early[arenas] = False
        self.disable_until[arenas] = -1
        self.knockback_until[arenas] = -1
        self.flight_until[arenas] = -1


def measure(
    policy,
    opponent,
    interface,
    plan,
    seed: int,
    n_envs: int = 64,
    games_per_arena: int = 2,
    rival=None,
    fight_setup: str = "standard",
) -> dict:
    """Play games in every arena and return results, weapon shares and counts per game.

    With `rival` set, every arena plays that frozen fighter and `opponent` is only its label.
    `fight_setup` names the kit and arena from sim.FIGHT_SETUPS.
    """
    pool = OpponentPool(n_envs, seed=seed + 1, max_ticks=MAX_TICKS, interface=interface)
    if rival is None:
        pool.set_mix({opponent: 1.0})
    else:
        pool.rival_share = 1.0
        pool.set_rivals([rival])
        pool.set_mix({LEAGUE: 1.0})
    config = SimConfig.for_setup(fight_setup, ready_gate=plan.ready_gate)
    env = ArenaVecEnv(n_envs, pool, config, max_ticks=MAX_TICKS, seed=seed, interface=interface)
    env.set_weapons(plan.stages[-1].weapons)
    rng = np.random.default_rng(seed + 2)
    obs = env.reset()
    sim = env.sim
    seen: dict = {}
    original = sim.step

    def step(actions):
        events = original(actions)
        seen.update(
            weapon=sim.weapon[:, 0].copy(),
            loaded=sim.loaded[:, 0].copy(),
            load_ticks=sim.load_ticks[:, 0].copy(),
            ticks=sim.ticks.copy(),
            events=events,
        )
        seen["copy"] = {
            k: events[k].copy()
            for k in ("hits", "crits", "shield_breaks", "arrows_fired", "arrows_blocked", "arrow_hits", "arrows_wasted")
        }
        return events

    sim.step = step
    played = np.zeros(n_envs, dtype=np.int64)
    results = [0, 0, 0]
    hold = np.zeros(C.NUM_WEAPONS)
    totals = dict.fromkeys(COUNTS, 0.0)
    tracker = RoundTracker(n_envs)
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
        tracker.step(live, seen["ticks"], seen["loaded"], seen["load_ticks"], held, ev)
        tracker.finish(np.flatnonzero(done), live)
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
        **{key: round(value / games, 3) for key, value in tracker.totals.items()},
    }


def report(root: Path, seed: int) -> list[dict]:
    """Measure the current fighter of a campaign against every named opponent."""
    cfg = read_config(root)
    plan = PLANS[cfg.plan]
    meta = json.loads((root / FIGHTER / "policy.json").read_text())
    policy = NumpyPolicy.load(root / FIGHTER / "policy.npz")
    interface = expert_interface(MAX_TICKS, stance=plan.stance)
    interface.experts.install(load_experts(ExpertStore(root / "experts"), meta["experts"], cfg.id))
    return [measure(policy, name, interface, plan, seed, fight_setup=cfg.fight_setup) for name in OPPONENTS]


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
            f"into_shield {r['shots_into_shield']:.2f} load<=2 {r['load_started_2']:.2f} "
            f"loaded@40 {r['loaded_by_40']:.2f} follow_disable {r['followup_shots_disable']:.2f}/{r['followup_chances_disable']:.2f} "
            f"follow_knock {r['followup_shots_knockback']:.2f}/{r['followup_chances_knockback']:.2f} "
            f"follow_hits {r['followup_hits']:.2f} wasted_hurt {r['shots_wasted_hurt']:.2f} of {r['games']}"
        )


if __name__ == "__main__":
    main()
