"""Release checks for the UHC fighter: reward farming and missing items.

Each reward term has a cheapest repeatable loop listed in `FARM_LOOPS`. A loop
passes when a scripted bot running it earns less per step than a bot that holds
the same pose and does nothing.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import actions as A
from . import constants as C
from . import items as I
from . import opponents as O
from .combat import RoundRules
from .opponents import OpponentPool
from .uhc import GEAR, ITEM_HEAD, UhcKitRules, UhcVecEnv, uhc_nvec, uhc_sim_config
from .uhc_drills import flat_base
from .uhc_obs import KIT_ITEMS

FARM_TICKS = 1200
FARM_WARMUP = 20
EAT_HEALTH = 10.0


@dataclass(frozen=True)
class FarmLoop:
    """A repeating schedule of (item, use, attack) choices at a fixed pitch."""

    target: str
    pitch: float
    schedule: tuple[tuple[int, int, int], ...]


FARM_LOOPS: dict[str, FarmLoop] = {
    "water_place_scoop": FarmLoop(
        "item press",
        90.0,
        ((I.WATER_BUCKET, 1, 0), (I.WATER_BUCKET, 0, 0), (I.EMPTY_BUCKET, 1, 0), (I.EMPTY_BUCKET, 0, 0)),
    ),
    "lava_place_scoop": FarmLoop(
        "lava and burning",
        90.0,
        ((I.LAVA_BUCKET, 1, 0), (I.LAVA_BUCKET, 0, 0), (I.EMPTY_BUCKET, 1, 0), (I.EMPTY_BUCKET, 0, 0)),
    ),
    "burn_then_douse": FarmLoop(
        "burning potential",
        90.0,
        (
            (I.LAVA_BUCKET, 1, 0),
            (I.LAVA_BUCKET, 0, 0),
            (I.EMPTY_BUCKET, 1, 0),
            (I.EMPTY_BUCKET, 0, 0),
            (I.WATER_BUCKET, 1, 0),
            (I.WATER_BUCKET, 0, 0),
            (I.EMPTY_BUCKET, 1, 0),
            (I.EMPTY_BUCKET, 0, 0),
        ),
    ),
    "hurt_then_eat": FarmLoop(
        "heal credit",
        90.0,
        ((I.LAVA_BUCKET, 1, 0), (I.LAVA_BUCKET, 0, 0), (I.EMPTY_BUCKET, 1, 0), (I.EMPTY_BUCKET, 0, 0))
        + ((I.GOLDEN_APPLE, 1, 0),) * 17,
    ),
    "eat_at_full_health": FarmLoop("heal credit", 0.0, ((I.GOLDEN_APPLE, 1, 0),)),
    "web_place_cut": FarmLoop(
        "web potential",
        60.0,
        ((I.COBWEB, 1, 0), (I.COBWEB, 0, 0)) + ((I.NO_ITEM, 0, 1),) * 8,
    ),
    "block_place_break": FarmLoop(
        "item press",
        60.0,
        ((I.BLOCK, 1, 0), (I.BLOCK, 0, 0)) + ((I.NO_ITEM, 0, 1),) * 90,
    ),
    "pearl_at_feet": FarmLoop("item press", 60.0, ((I.PEARL, 1, 0),) + ((I.PEARL, 0, 0),) * 20),
    "rod_cast_reel": FarmLoop(
        "item press", 45.0, ((I.ROD, 1, 0),) + ((I.ROD, 0, 0),) * 6 + ((I.ROD, 1, 0), (I.ROD, 0, 0))
    ),
}


def _farm_env(n: int, seed: int) -> UhcVecEnv:
    pool = OpponentPool(n, seed=seed + 1, max_ticks=FARM_TICKS)
    pool.set_mix({"idle": 1.0})
    rules = UhcKitRules(full_rate=1.0, empty_rate=0.0, gear_drop=0.0, armor_drop=0.0)
    rounds = RoundRules(no_damage_ticks=10 * FARM_TICKS, limit_ticks=FARM_TICKS, overtime_ticks=FARM_TICKS)
    return UhcVecEnv(
        n, pool, flat_base(), rules, uhc_sim_config(), max_ticks=FARM_TICKS,
        round_rules=rounds, seed=seed, opponent_eats=False,
    )


def _run_loop(loop: FarmLoop, steps: int, seed: int, n: int, active: bool) -> float:
    env = _farm_env(n, seed)
    try:
        env.reset()
        total = 0.0
        counted = 0
        for step in range(steps):
            sim = env.sim
            base = A.neutral_actions(sim.weapon[:, 0].copy())
            base[:, A.PITCH] = A.nearest_index(A.SIM_PITCH_STEP, loop.pitch - sim.pitch[:, 0])
            codes = np.zeros(sim.n, dtype=np.int64)
            if active and step >= FARM_WARMUP:
                code, use, attack = loop.schedule[(step - FARM_WARMUP) % len(loop.schedule)]
                codes[:] = code
                base[:, A.USE] = use
                base[:, A.ATTACK] = attack
                legal = env.hands.legal_items(0)[np.arange(sim.n), codes]
                codes[~legal] = I.NO_ITEM
                base[~legal, A.USE] = 0
            _obs, reward, _done, _info = env.step(np.concatenate([base, codes[:, None]], axis=1))
            if step >= FARM_WARMUP:
                total += float(reward.sum())
                counted += n
        return total / max(counted, 1)
    finally:
        env.close()


def farm_report(steps: int = 400, seed: int = 11, n: int = 8) -> dict[str, dict[str, float]]:
    """Return reward per step of each farming loop and of holding its pose."""
    out = {}
    for name, loop in FARM_LOOPS.items():
        out[name] = {
            "loop": _run_loop(loop, steps, seed, n, True),
            "idle": _run_loop(loop, steps, seed, n, False),
        }
    return out


ROD_FARM_LOOPS = {
    "hook_and_hold": "cast onto the other player and keep the hook there without a reel",
    "hook_and_drop": "cast onto the other player, release, then drop the hook by changing item, repeat",
    "cast_and_retract": "cast and pull the hook back while it flies, repeat",
}


def _rod_loop_action(env, name: str, clock: int) -> np.ndarray:
    """Aim the cast that lands, then run one rod farming loop or none."""
    sim = env.sim
    items = sim.items
    base, codes = env._plan()
    aimed = env.aim(base)
    codes[:] = I.ROD
    out = items.hook_on[:, 0]
    hooked = out & (items.hook_state[:, 0] == I.HOOK_ON_PLAYER)
    fresh = ~env.last_use
    if name == "hook_and_hold":
        base[:, A.USE] = ~out & aimed & fresh
    elif name == "hook_and_drop":
        base[:, A.USE] = ~out & aimed & fresh
        codes[hooked & ~env.last_use & (clock % 4 == 3)] = I.NO_ITEM
    elif name == "cast_and_retract":
        base[:, A.USE] = (aimed | out) & fresh
    return env._join(base, codes)


def rod_farm_report(rounds: int = 64, n: int = 16, seed: int = 13) -> dict[str, dict[str, float]]:
    """Return reward per step of each rod loop and of aiming the same way without a cast."""
    from .uhc_drills import RodPull

    def run(name: str) -> float:
        env = RodPull(n, seed=seed)
        try:
            env.reset()
            total, steps, finished = 0.0, 0, 0
            for clock in range(rounds // n * env.limit):
                _obs, reward, _done, infos = env.step(_rod_loop_action(env, name, clock))
                total += float(reward.sum())
                steps += n
                finished += sum("outcome" in info for info in infos)
                if finished >= rounds:
                    break
            return total / max(steps, 1)
        finally:
            env.close()

    idle = run("aim_only")
    return {name: {"loop": run(name), "idle": idle} for name in ROD_FARM_LOOPS}


def scripted_fighter(env: UhcVecEnv) -> np.ndarray:
    """Chase and swing, and eat when low if an apple is in the kit."""
    sim = env.sim
    base, view = O.base(sim, 0, env.kit_rng, 3.0)
    O.chase(base, view)
    base[:, A.SPRINT] = view.distance > 3.0
    base[:, A.ATTACK] = view.aim & view.charged
    base[:, A.WEAPON] = np.where(env.hands.legal_weapons(0)[:, C.SWORD], base[:, A.WEAPON], A.WEAPON_ACTION[C.SWORD])
    codes = np.zeros(sim.n, dtype=np.int64)
    eat = (sim.hp[:, 0] < EAT_HEALTH) & (sim.items.count[:, 0, I.GOLDEN_APPLE] > 0)
    codes[eat] = I.GOLDEN_APPLE
    base[eat, A.USE] = 1
    base[eat, A.ATTACK] = 0
    return np.concatenate([base, codes[:, None]], axis=1)


def sample_masked(mask: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Pick a uniformly random allowed choice on every head, including the item head."""
    sizes = uhc_nvec()
    scores = rng.random(mask.shape) * mask
    out = np.zeros((len(mask), len(sizes)), dtype=np.int64)
    start = 0
    for head, size in enumerate(sizes):
        out[:, head] = scores[:, start : start + size].argmax(axis=1)
        start += size
    return out


def _gate_env(n: int, seed: int, missing: int | str | None, mix: dict[str, float]) -> UhcVecEnv:
    pool = OpponentPool(n, seed=seed + 1, max_ticks=600)
    pool.set_mix(mix)
    banned = (missing,) if isinstance(missing, int) else ()
    if missing == I.EMPTY_BUCKET:
        banned = (I.EMPTY_BUCKET, I.WATER_BUCKET, I.LAVA_BUCKET)
    gear = (missing,) if isinstance(missing, str) else ()
    rules = UhcKitRules(full_rate=1.0, empty_rate=0.0, gear_drop=0.0, armor_drop=0.0, banned=banned, removed_gear=gear)
    rounds = RoundRules(no_damage_ticks=300, limit_ticks=600, overtime_ticks=600)
    return UhcVecEnv(n, pool, flat_base(), rules, uhc_sim_config(), max_ticks=600, round_rules=rounds, seed=seed)


def _mask_leaks(env: UhcVecEnv, mask: np.ndarray) -> int:
    """Count allowed choices that the player's inventory cannot back."""
    sim = env.sim
    first = int(A.MASK_SIZE)
    leaks = 0
    for code in KIT_ITEMS:
        leaks += int((mask[:, first + code] & (sim.items.count[:, 0, code] <= 0)).sum())
    start = int(A.HEAD_OFFSETS[A.WEAPON])
    leaks += int((mask[:, start + A.WEAPON_ACTION[C.AXE]] & (sim.combat.weapon_left[:, 0, C.AXE] <= 0)).sum())
    bow_ready = sim.combat.has_bow[:, 0] & (sim.ammo[:, 0] > 0)
    leaks += int((mask[:, start + A.WEAPON_ACTION[C.BOW]] & ~bow_ready).sum())
    leaks += int(mask[:, start + A.WEAPON_ACTION[C.CROSSBOW]].sum())
    return leaks


def _gear_leaks(env: UhcVecEnv, missing: int | str) -> int:
    """Count players using a piece of gear the kit left out."""
    sim = env.sim
    if missing == "shield":
        return int((sim.shield_ticks[:, 0] > 0).sum())
    if missing == "sword":
        return int((sim.combat.weapon_damage[:, 0, C.SWORD] != I.FIST_DAMAGE).sum())
    if missing == "axe":
        return int((sim.combat.weapon_damage[:, 0, C.AXE] != I.FIST_DAMAGE).sum())
    if missing == "bow":
        return int((sim.draw_ticks[:, 0] > 0).sum() + sim.events["arrows_fired"][:, 0].sum())
    return 0


def _reach(action: np.ndarray, missing: int | str) -> None:
    """Point an action at the missing choice, ignoring the mask."""
    if isinstance(missing, int):
        action[:, ITEM_HEAD] = missing
        action[:, A.USE] = 1
    elif missing == "axe":
        action[:, A.WEAPON] = A.WEAPON_ACTION[C.AXE]
    elif missing == "bow":
        action[:, A.WEAPON] = A.WEAPON_ACTION[C.BOW]
    else:
        action[:, A.WEAPON] = A.WEAPON_ACTION[C.SWORD]
        action[:, ITEM_HEAD] = I.NO_ITEM
        action[:, A.USE] = 1


def check_missing(missing: int | str, steps: int = 150, n: int = 8, seed: int = 21) -> dict[str, int]:
    """Run masked random play, then a bot that ignores the mask and reaches for the item."""
    env = _gate_env(n, seed, missing, {"walker": 1.0})
    rng = np.random.default_rng(seed)
    leaks = 0
    stock = 0
    gear = 0
    try:
        env.reset()
        for _ in range(steps):
            mask = env.action_masks()
            leaks += _mask_leaks(env, mask)
            env.step(sample_masked(mask, rng))
            gear += _gear_leaks(env, missing)
            if isinstance(missing, int):
                stock += int(env.sim.items.count[:, 0, missing].sum())
        illegal = int(env.hands.illegal_items[0] + env.hands.illegal_weapons[0])
        env.reset()
        before = int(env.hands.illegal_items[0] + env.hands.illegal_weapons[0])
        for _ in range(20):
            action = sample_masked(env.action_masks(), rng)
            _reach(action, missing)
            env.step(action)
            gear += _gear_leaks(env, missing)
            if isinstance(missing, int):
                stock += int(env.sim.items.count[:, 0, missing].sum())
        reached = int(env.hands.illegal_items[0] + env.hands.illegal_weapons[0]) - before
        return {
            "mask_leaks": leaks,
            "illegal_choices": illegal,
            "stock_seen": stock,
            "gear_used": gear,
            "blocked_reaches": reached,
        }
    finally:
        env.close()


def fight_rate(missing: int | str | None, rounds: int = 64, n: int = 16, seed: int = 31) -> float:
    """Return the scripted fighter's win rate against a swinger with one item missing."""
    env = _gate_env(n, seed, missing, {"swinger": 1.0})
    results: list[int] = []
    try:
        env.reset()
        for _ in range(4000):
            _obs, _reward, _done, infos = env.step(scripted_fighter(env))
            results += [info["outcome"] for info in infos if "outcome" in info]
            if len(results) >= rounds:
                break
        return float(np.mean(np.array(results[:rounds]) > 0))
    finally:
        env.close()


def network_missing(model, missing: int | str | None, rounds: int = 64, n: int = 16, seed: int = 31) -> dict:
    """Play a network against a swinger with one item left out and count every illegal use."""
    env = _gate_env(n, seed, missing, {"swinger": 1.0})
    results: list[int] = []
    landed: list[bool] = []
    dealt = np.zeros(n)
    leaks = gear = stock = 0
    try:
        obs = env.reset()
        for _ in range(rounds * 600 // n + 1200):
            mask = env.action_masks()
            leaks += _mask_leaks(env, mask)
            action, _ = model.predict(obs, action_masks=mask, deterministic=True)
            obs, _reward, done, infos = env.step(action)
            if missing is not None:
                gear += _gear_leaks(env, missing)
            if isinstance(missing, int):
                stock += int(env.sim.items.count[:, 0, missing].sum())
            dealt += env.sim.events["damage_taken"][:, 1]
            for i, info in enumerate(infos):
                if "outcome" in info:
                    results.append(int(info["outcome"]))
                    landed.append(bool(dealt[i] > 0.0))
            dealt[done] = 0.0
            if len(results) >= rounds:
                break
        return {
            "rounds": len(results[:rounds]),
            "win_rate": round(float(np.mean(np.array(results[:rounds]) > 0)), 4) if results else 0.0,
            "landed_a_hit": round(float(np.mean(landed[:rounds])), 4) if landed else 0.0,
            "mask_leaks": leaks,
            "illegal_choices": int(env.hands.illegal_items[0] + env.hands.illegal_weapons[0]),
            "stock_seen": stock,
            "gear_used": gear,
        }
    finally:
        env.close()


def every_missing_choice() -> list[int | str]:
    """Return every kit item and piece of gear."""
    return [*KIT_ITEMS, *GEAR]


__all__ = [
    "FARM_LOOPS",
    "ROD_FARM_LOOPS",
    "check_missing",
    "every_missing_choice",
    "farm_report",
    "fight_rate",
    "network_missing",
    "rod_farm_report",
    "sample_masked",
    "scripted_fighter",
]
