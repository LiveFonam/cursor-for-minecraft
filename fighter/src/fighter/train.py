"""Masked PPO training with a curriculum and a self-play league."""

from __future__ import annotations

import json
import os
import resource
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

for _name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ.setdefault(_name, "2")

import numpy as np
import torch
from sb3_contrib import MaskablePPO
from stable_baselines3.common.callbacks import BaseCallback
from torch import nn

from . import constants as C
from .env import ArenaVecEnv, RewardConfig
from .opponents import LEAGUE, OpponentPool
from .policy import NumpyPolicy
from .sim import SimConfig

MAX_TICKS = 600
AXE_ONLY = (C.AXE,)
FIGHT_WEAPONS = (C.AXE, C.BOW, C.CROSSBOW)


@dataclass
class Stage:
    """One curriculum step with its opponent mix and promotion gate.

    weapons: the only weapons the learner may select, or None for all of them.
    floors: the least win rate needed against each named opponent to advance.
    keep: the least mix weight of named opponents when the final mix adapts.
    """

    name: str
    mix: dict[str, float]
    gate: float
    min_steps: int
    shaping: float = 1.0
    weapons: tuple[int, ...] | None = None
    floors: dict[str, float] | None = None
    keep: dict[str, float] | None = None


CURRICULUM = [
    Stage("targets", {"idle": 1.0, "random": 1.0}, 0.85, 20_000, weapons=AXE_ONLY),
    Stage("chasers", {"walker": 1.0, "swinger": 2.0, "random": 0.5}, 0.70, 60_000, weapons=AXE_ONLY),
    Stage("fighters", {"strafer": 1.0, "critter": 1.0, "swinger": 0.5}, 0.60, 150_000, 0.8, FIGHT_WEAPONS),
    Stage(
        "tactics",
        {"shielder": 1.0, "axeman": 1.0, "archer": 1.0, "critter": 0.5},
        0.55,
        300_000,
        0.6,
        FIGHT_WEAPONS,
    ),
    Stage(
        "league",
        {
            LEAGUE: 3.0,
            "strafer": 0.5,
            "critter": 0.5,
            "shielder": 0.5,
            "axeman": 0.5,
            "archer": 0.5,
            "retreater": 0.5,
            "hit_and_run": 0.5,
            "rusher": 0.5,
            "pvp_basic": 0.5,
            "pvp_combo": 0.5,
            "pvp_sweat": 0.5,
            "shield_holder": 0.5,
        },
        2.0,
        0,
        0.4,
        FIGHT_WEAPONS,
    ),
]


@dataclass
class TrainConfig:
    """Settings of one training run."""

    out: str = "runs/full"
    total_steps: int = 30_000_000
    n_envs: int = 32
    n_steps: int = 256
    batch_size: int = 2048
    n_epochs: int = 4
    learning_rate: float = 3e-4
    gamma: float = 0.995
    gae_lambda: float = 0.95
    clip_range: float = 0.2
    ent_coef: float = 0.01
    seed: int = 7
    threads: int = 2
    snapshot_every: int = 250_000
    checkpoint_every: int = 250_000
    max_minutes: float = 0.0
    max_rss_gb: float = 2.0
    stages: list[Stage] = field(default_factory=lambda: list(CURRICULUM))


def limit_threads(threads: int) -> None:
    """Keep numerical libraries within the thread budget."""
    torch.set_num_threads(threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass


def peak_rss_gb() -> float:
    """Return the peak resident memory of this process in gigabytes."""
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    divisor = 1024**3 if sys.platform == "darwin" else 1024**2
    return peak / divisor


def build_model(env, cfg: TrainConfig) -> MaskablePPO:
    """Create a masked PPO model from random weights."""
    return MaskablePPO(
        "MlpPolicy",
        env,
        learning_rate=cfg.learning_rate,
        n_steps=cfg.n_steps,
        batch_size=cfg.batch_size,
        n_epochs=cfg.n_epochs,
        gamma=cfg.gamma,
        gae_lambda=cfg.gae_lambda,
        clip_range=cfg.clip_range,
        ent_coef=cfg.ent_coef,
        policy_kwargs={
            "net_arch": {"pi": [256, 256], "vf": [256, 256]},
            "activation_fn": nn.ReLU,
        },
        seed=cfg.seed,
        device="cpu",
        verbose=0,
    )


class CurriculumCallback(BaseCallback):
    """Promotes stages, grows the league, saves and enforces limits."""

    def __init__(self, cfg: TrainConfig, env: ArenaVecEnv, out: Path, state: dict):
        super().__init__()
        self.cfg = cfg
        self.arena = env
        self.out = out
        self.state = state
        self.started = time.monotonic()
        self.base_steps = state.get("steps", 0)
        self.stage_start = state.get("stage_start", 0)
        self.last_snapshot = state.get("last_snapshot", self.base_steps)
        self.last_checkpoint = self.base_steps
        self.stop_reason = ""
        self.log_path = out / "progress.jsonl"
        self._enter(state.get("stage", 0), first=True)

    @property
    def steps(self) -> int:
        return self.base_steps + self.num_timesteps

    def _enter(self, index: int, first: bool = False) -> None:
        self.stage_index = index
        stage = self.cfg.stages[index]
        self.arena.reward_cfg.shaping = stage.shaping
        self.arena.set_weapons(stage.weapons)
        self.arena.pool.set_mix(stage.mix)
        if not first:
            self.stage_start = self.steps
            self.arena.results.clear()

    def _on_step(self) -> bool:
        limit = self.cfg.max_minutes
        if limit > 0 and (time.monotonic() - self.started) / 60.0 >= limit:
            self.stop_reason = "time limit"
            return False
        if self.n_calls % 200 == 0 and peak_rss_gb() > self.cfg.max_rss_gb:
            self.stop_reason = "memory limit"
            return False
        return True

    def _on_rollout_end(self) -> None:
        stage = self.cfg.stages[self.stage_index]
        rate = self.arena.win_rate()
        games = len(self.arena.results)
        in_stage = self.steps - self.stage_start
        record = {
            "steps": self.steps,
            "stage": stage.name,
            "win_rate": round(rate, 4),
            "games": games,
            "league": len(self.arena.pool.snapshots),
            "minutes": round((time.monotonic() - self.started) / 60.0, 2),
            "rss_gb": round(peak_rss_gb(), 3),
        }
        with self.log_path.open("a") as handle:
            handle.write(json.dumps(record) + "\n")

        last = self.stage_index == len(self.cfg.stages) - 1
        if not last and games >= 100 and rate >= stage.gate and in_stage >= stage.min_steps:
            self.arena.pool.add_snapshot(NumpyPolicy.from_sb3(self.model))
            self._enter(self.stage_index + 1)
        if self.steps - self.last_snapshot >= self.cfg.snapshot_every:
            self.arena.pool.add_snapshot(NumpyPolicy.from_sb3(self.model))
            self.last_snapshot = self.steps
        if self.steps - self.last_checkpoint >= self.cfg.checkpoint_every:
            self.save()
            self.last_checkpoint = self.steps

    def save(self) -> None:
        """Write the model, the policy, the league and the run state."""
        self.model.save(self.out / "model.zip")
        NumpyPolicy.from_sb3(self.model).save(self.out / "policy.npz")
        league = self.out / "league"
        league.mkdir(exist_ok=True)
        for old in league.glob("*.npz"):
            old.unlink()
        for i, snapshot in enumerate(self.arena.pool.snapshots):
            snapshot.save(league / f"{i:02d}.npz")
        state = {
            "steps": self.steps,
            "stage": self.stage_index,
            "stage_start": self.stage_start,
            "last_snapshot": self.last_snapshot,
        }
        (self.out / "state.json").write_text(json.dumps(state))


def make_env(cfg: TrainConfig) -> ArenaVecEnv:
    """Build the training environment."""
    pool = OpponentPool(cfg.n_envs, seed=cfg.seed + 1, max_ticks=MAX_TICKS)
    return ArenaVecEnv(
        cfg.n_envs, pool, SimConfig(), RewardConfig(), max_ticks=MAX_TICKS, seed=cfg.seed
    )


def train(cfg: TrainConfig, resume: bool = False) -> dict:
    """Run the curriculum and return a summary."""
    limit_threads(cfg.threads)
    out = Path(cfg.out)
    out.mkdir(parents=True, exist_ok=True)
    env = make_env(cfg)
    state: dict = {}
    if resume and (out / "model.zip").exists():
        state = json.loads((out / "state.json").read_text())
        model = MaskablePPO.load(out / "model.zip", env=env, device="cpu")
        for path in sorted((out / "league").glob("*.npz")):
            env.pool.add_snapshot(NumpyPolicy.load(path))
    else:
        model = build_model(env, cfg)
    remaining = max(cfg.total_steps - state.get("steps", 0), 0)
    callback = CurriculumCallback(cfg, env, out, state)
    started = time.monotonic()
    model.learn(remaining, callback=callback, reset_num_timesteps=True)
    callback.save()
    elapsed = time.monotonic() - started
    summary = {
        "steps": callback.steps,
        "stage": cfg.stages[callback.stage_index].name,
        "win_rate": round(env.win_rate(), 4),
        "league": len(env.pool.snapshots),
        "minutes": round(elapsed / 60.0, 2),
        "steps_per_second": round(callback.num_timesteps / max(elapsed, 1e-6), 1),
        "peak_rss_gb": round(peak_rss_gb(), 3),
        "stopped_by": callback.stop_reason or "step budget",
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    config = asdict(cfg)
    config.pop("stages")
    (out / "config.json").write_text(json.dumps(config, indent=2))
    return summary
