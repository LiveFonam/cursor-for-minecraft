"""Evaluation of a policy on held-out seeds."""

from __future__ import annotations

import math

import numpy as np

from .env import ArenaVecEnv
from .interface import Interface
from .opponents import OpponentPool
from .policy import NumpyPolicy
from .sim import SimConfig

HELD_OUT_SEED = 1_000_003
MAX_TICKS = 600


def wilson_interval(wins: int, games: int, z: float = 1.96) -> tuple[float, float]:
    """Return the Wilson score interval of a win rate."""
    if games == 0:
        return 0.0, 1.0
    p = wins / games
    denom = 1.0 + z * z / games
    center = (p + z * z / (2.0 * games)) / denom
    margin = z * math.sqrt(p * (1.0 - p) / games + z * z / (4.0 * games * games)) / denom
    return max(center - margin, 0.0), min(center + margin, 1.0)


def play_matches(
    policy: NumpyPolicy,
    opponent: str,
    games_per_arena: int = 8,
    n_envs: int = 25,
    seed: int = HELD_OUT_SEED,
    deterministic: bool = False,
    interface: Interface | None = None,
    weapons: tuple[int, ...] | None = None,
    sim_config: SimConfig | None = None,
) -> dict:
    """Play a fixed number of games in every arena and count the results.

    interface: the learner's inputs and masks, such as one with experts loaded.
    weapons: the only weapons the learner may select, or None for all of them.
    """
    pool = OpponentPool(n_envs, seed=seed + 1, max_ticks=MAX_TICKS, interface=interface)
    pool.set_mix({opponent: 1.0})
    env = ArenaVecEnv(n_envs, pool, sim_config or SimConfig(), max_ticks=MAX_TICKS, seed=seed, interface=interface)
    env.set_weapons(weapons)
    rng = np.random.default_rng(seed + 2)
    obs = env.reset()
    played = np.zeros(n_envs, dtype=np.int64)
    outcomes: list[int] = []
    while (played < games_per_arena).any():
        actions = policy.act(obs, env.action_masks(), rng, deterministic=deterministic)
        env.step_async(actions)
        obs, _, done, infos = env.step_wait()
        for arena in np.flatnonzero(done):
            if played[arena] < games_per_arena:
                outcomes.append(infos[arena]["outcome"])
            played[arena] += 1
    games = len(outcomes)
    wins = sum(o > 0 for o in outcomes)
    losses = sum(o < 0 for o in outcomes)
    low, high = wilson_interval(wins, games)
    return {
        "opponent": opponent,
        "games": games,
        "wins": wins,
        "losses": losses,
        "draws": games - wins - losses,
        "win_rate": round(wins / games, 4),
        "win_rate_low": round(low, 4),
        "win_rate_high": round(high, 4),
    }
