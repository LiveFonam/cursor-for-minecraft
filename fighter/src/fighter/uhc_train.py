"""Train the UHC network on one drill, on all drills, or in full fights."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
from sb3_contrib import MaskablePPO
from stable_baselines3.common.vec_env import VecEnv

from .evaluate import HELD_OUT_SEED
from .opponents import OpponentPool
from .uhc import UhcKitRules, UhcVecEnv
from .uhc_checks import every_missing_choice, network_missing
from .uhc_drills import DRILLS, PASS_RATE, run_drill
from .uhc_net import build_uhc_model
from .train import limit_threads

FIGHT_MIX = {"idle": 0.5, "random": 0.5, "walker": 1.0, "swinger": 2.0, "strafer": 1.0, "critter": 1.0}


def model_actor(model, deterministic: bool = True):
    """Return an action function that reads the drill's inputs and masks."""

    def act(env) -> np.ndarray:
        action, _ = model.predict(env.observe(), action_masks=env.action_masks(), deterministic=deterministic)
        return action

    return act


def held_out_score(model, name: str, rounds: int = 128, n_envs: int = 16) -> float:
    """Return the model's success rate on the drill's held-out seeds."""
    drill = DRILLS[name](n_envs, seed=HELD_OUT_SEED)
    try:
        return run_drill(drill, model_actor(model), rounds)
    finally:
        drill.close()


def train_drill(name: str, steps: int, n_envs: int = 32, seed: int = 7, out: str | None = None) -> dict:
    """Train on one drill and report its held-out pass test."""
    env = DRILLS[name](n_envs, seed=seed)
    model = build_uhc_model(env, seed=seed, n_steps=128, batch_size=1024)
    started = time.monotonic()
    model.learn(steps)
    elapsed = time.monotonic() - started
    score = held_out_score(model, name)
    row = {
        "drill": name,
        "steps": steps,
        "held_out": round(score, 4),
        "passed": score >= PASS_RATE,
        "steps_per_second": round(steps / max(elapsed, 1e-6), 1),
        "illegal_items": int(env.hands.illegal_items[0]),
        "illegal_weapons": int(env.hands.illegal_weapons[0]),
    }
    if out is not None:
        folder = Path(out)
        folder.mkdir(parents=True, exist_ok=True)
        model.save(folder / f"{name}.zip")
    env.close()
    return row


class DrillMix(VecEnv):
    """Every drill and a block of full fights side by side, so one network learns them all."""

    render_mode = None

    def __init__(self, per_drill: int = 16, fights: int = 32, seed: int = 7, world_cache: str | None = None):
        self.parts: list[UhcVecEnv] = [DRILLS[name](per_drill, seed=seed + 11 * k) for k, name in enumerate(DRILLS)]
        if fights > 0:
            pool = OpponentPool(fights, seed=seed + 101, max_ticks=2400)
            pool.set_mix(FIGHT_MIX)
            self.parts.append(UhcVecEnv(fights, pool, rules=UhcKitRules(), seed=seed + 103, world_cache=world_cache))
        sizes = [part.num_envs for part in self.parts]
        self.cuts = np.cumsum(sizes)[:-1]
        super().__init__(sum(sizes), self.parts[0].observation_space, self.parts[0].action_space)

    def reset(self) -> np.ndarray:
        return np.concatenate([part.reset() for part in self.parts])

    def step_async(self, actions: np.ndarray) -> None:
        for part, chunk in zip(self.parts, np.split(np.asarray(actions), self.cuts)):
            part.step_async(chunk)

    def step_wait(self):
        rows = [part.step_wait() for part in self.parts]
        infos: list[dict] = []
        for row in rows:
            infos += list(row[3])
        return (
            np.concatenate([row[0] for row in rows]),
            np.concatenate([row[1] for row in rows]),
            np.concatenate([row[2] for row in rows]),
            infos,
        )

    def action_masks(self) -> np.ndarray:
        return np.concatenate([part.action_masks() for part in self.parts])

    def close(self) -> None:
        for part in self.parts:
            part.close()

    def get_attr(self, attr_name, indices=None):
        return [getattr(self, attr_name)] * len(self._get_indices(indices))

    def set_attr(self, attr_name, value, indices=None):
        setattr(self, attr_name, value)

    def env_method(self, method_name, *method_args, indices=None, **method_kwargs):
        result = getattr(self, method_name)(*method_args, **method_kwargs)
        if method_name == "action_masks":
            return list(result)
        return [result] * len(self._get_indices(indices))

    def env_is_wrapped(self, wrapper_class, indices=None):
        return [False] * len(self._get_indices(indices))

    def has_attr(self, attr_name):
        return hasattr(self, attr_name)


def missing_report(model, rounds: int = 64, n: int = 16) -> dict:
    """Play the network with the full kit and with each item or piece of gear left out."""
    rows = {"full kit": network_missing(model, None, rounds, n)}
    for missing in every_missing_choice():
        rows[str(missing)] = network_missing(model, missing, rounds, n)
    return rows


def train_mix(
    steps: int, per_drill: int = 16, fights: int = 32, seed: int = 7, out: str | None = None,
    world_cache: str | None = None,
) -> dict:
    """Train one network on all drills and fights, then report each drill and the missing item test."""
    env = DrillMix(per_drill, fights, seed, world_cache)
    model = build_uhc_model(env, seed=seed, n_steps=64, batch_size=2048)
    started = time.monotonic()
    model.learn(steps)
    elapsed = time.monotonic() - started
    row = {
        "seed": seed,
        "steps": steps,
        "steps_per_second": round(steps / max(elapsed, 1e-6), 1),
        "held_out": {name: round(held_out_score(model, name), 4) for name in DRILLS},
    }
    row["passed"] = all(score >= PASS_RATE for score in row["held_out"].values())
    if out is not None:
        folder = Path(out)
        folder.mkdir(parents=True, exist_ok=True)
        model.save(folder / "mix.zip")
    row["missing"] = missing_report(model)
    env.close()
    return row


def train_fight(steps: int, n_envs: int = 32, seed: int = 7, out: str | None = None, world_cache: str | None = None) -> dict:
    """Train in full UHC rounds with random kits."""
    pool = OpponentPool(n_envs, seed=seed + 1, max_ticks=2400)
    pool.set_mix(FIGHT_MIX)
    env = UhcVecEnv(n_envs, pool, rules=UhcKitRules(), seed=seed, world_cache=world_cache)
    model = build_uhc_model(env, seed=seed)
    started = time.monotonic()
    model.learn(steps)
    elapsed = time.monotonic() - started
    row = {
        "steps": steps,
        "win_rate": round(env.win_rate(), 4),
        "steps_per_second": round(steps / max(elapsed, 1e-6), 1),
        "illegal_items": int(env.hands.illegal_items[0]),
        "illegal_weapons": int(env.hands.illegal_weapons[0]),
    }
    if out is not None:
        folder = Path(out)
        folder.mkdir(parents=True, exist_ok=True)
        model.save(folder / "fight.zip")
    env.close()
    return row


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--drill", default=None, help="a drill name or all")
    parser.add_argument("--fight", action="store_true")
    parser.add_argument("--mix", action="store_true", help="one network on every drill and fights")
    parser.add_argument("--per-drill", type=int, default=16)
    parser.add_argument("--fights", type=int, default=32)
    parser.add_argument("--missing", default=None, help="run the missing item test on a saved network")
    parser.add_argument("--steps", type=int, default=600_000)
    parser.add_argument("--envs", type=int, default=32)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--out", default=None)
    parser.add_argument("--world-cache", default=None)
    args = parser.parse_args()
    limit_threads(args.threads)
    if args.missing is not None:
        print(json.dumps(missing_report(MaskablePPO.load(args.missing, device="cpu"))), flush=True)
    if args.mix:
        print(json.dumps(train_mix(args.steps, args.per_drill, args.fights, args.seed, args.out, args.world_cache)), flush=True)
    if args.fight:
        print(json.dumps(train_fight(args.steps, args.envs, args.seed, args.out, args.world_cache)), flush=True)
    if args.drill is not None:
        names = list(DRILLS) if args.drill == "all" else args.drill.split(",")
        for name in names:
            print(json.dumps(train_drill(name, args.steps, args.envs, args.seed, args.out)), flush=True)


if __name__ == "__main__":
    main()
