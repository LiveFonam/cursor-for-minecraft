"""Train a shooting expert, a blocking expert and the axe fighter at the same time.

Each training is a role with its own folder, checkpoint and lock. Drill roles run
their pass test on held-out seeds and publish the network to the expert store
only when it passes. The fighter polls the store at every rollout boundary and
loads new experts there. Every network starts from random weights, and the
fighter loads only experts published by its own campaign.

A campaign folder holds:
  campaign.json    settings and the campaign id
  progress.json    every role and expert, rewritten while training runs
  decisions.jsonl  one line per decision: tests, published experts, loads and stops
  STOP             asks every role to stop at its next rollout boundary
  experts/         the expert store
  <role>/          checkpoint.pkl, status.json, progress.jsonl, policy.npz, log.txt
  <role>/farm/     one report per farming flag, see farmwatch.py

Run it again with the same folder to continue exactly where it stopped.
"""

from __future__ import annotations

import argparse
import fcntl
import io
import json
import os
import pickle
import random
import signal
import subprocess
import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, fields
from pathlib import Path

import numpy as np
import torch
from sb3_contrib import MaskablePPO
from stable_baselines3.common.callbacks import BaseCallback

from .drills import DRILLS
from .env import ArenaVecEnv, RewardConfig
from .evaluate import play_matches
from .experts import (
    BLOCKER,
    EXPERT_NAMES,
    SHOOTER,
    ExpertRejected,
    ExpertSet,
    ExpertStore,
    LoadedExpert,
    expert_interface,
    write_atomic,
)
from .farmwatch import FarmWatch, WatchSettings, merge_tallies
from .lean import EnvSpec, FIGHT, LeanConfig, LeanTrainer, free_memory_gb, pack_env, unpack_env
from .opponents import SCRIPTED, OpponentPool
from .policy import NumpyPolicy
from .sim import SimConfig
from .plans import PLANS
from .train import MAX_TICKS, CurriculumCallback, TrainConfig, build_model, limit_threads, peak_rss_gb

FIGHTER = "fighter"
ROLES = (SHOOTER, BLOCKER, FIGHTER)
DRILL_OF = {SHOOTER: "shooting", BLOCKER: "blocking"}
ROLE_SEED = {SHOOTER: 1_000, BLOCKER: 2_000, FIGHTER: 0}
TRAINERS = ("lean", "sb3")
NEVER = 10**15

EXIT_DONE = 0
EXIT_CRASHED = 1
EXIT_STOPPED = 3
EXIT_MEMORY = 4
EXIT_BUSY = 5

STATUS_SECONDS = 5.0
PROGRESS_SECONDS = 10.0
STOP_WAIT_SECONDS = 600.0
RECENT_DECISIONS = 30


@dataclass
class CampaignConfig:
    """Settings fixed for the life of a campaign, apart from the step budgets.

    Sizes left as None take the proven defaults of the chosen trainer.
    """

    trainer: str = "lean"
    seed: int = 7
    smoke: bool = False
    n_envs: int | None = None
    n_steps: int | None = None
    batch_size: int | None = None
    n_epochs: int = 4
    fighter_steps: int = 30_000_000
    drill_steps: int = 4_000_000
    test_every: int = 500_000
    checkpoint_every: int = 250_000
    snapshot_every: int = 250_000
    plan: str = "melee"
    id: str = ""


SMOKE = {
    "fighter_steps": 8_192,
    "drill_steps": 4_096,
    "test_every": 2_048,
    "checkpoint_every": 2_048,
    "snapshot_every": 2_048,
}
GROWABLE = ("fighter_steps", "drill_steps")


@dataclass
class Runtime:
    """Settings of one run of the command, free to change between pieces."""

    max_minutes: float = 0.0
    max_rollouts: int = 0
    max_rss_gb: float = 3.0
    min_free_gb: float = 2.0
    fighter_device: str = "auto"
    drill_device: str = "cpu"
    threads: int = 2
    workers: int = 0
    max_restarts: int = 3
    parent: int = 0


def role_sizes(cfg: CampaignConfig, role: str) -> dict[str, int]:
    """Return arenas, steps per rollout and minibatch size of one role."""
    if cfg.smoke:
        sizes = {"n_envs": 8, "n_steps": 16, "batch_size": 64}
    elif cfg.trainer == "lean":
        sizes = {"n_envs": 192, "n_steps": 32, "batch_size": 1024}
    elif role == FIGHTER:
        sizes = {"n_envs": 32, "n_steps": 256, "batch_size": 2048}
    else:
        sizes = {"n_envs": 24, "n_steps": 128, "batch_size": 1024}
    for key in sizes:
        if getattr(cfg, key) is not None:
            sizes[key] = int(getattr(cfg, key))
    return sizes


def read_config(root: Path) -> CampaignConfig:
    """Read the settings of an existing campaign."""
    return CampaignConfig(**json.loads((Path(root) / "campaign.json").read_text()))


def prepare_config(root: Path, given: dict) -> CampaignConfig:
    """Create the campaign settings, or check given ones against a saved campaign."""
    root = Path(root)
    path = root / "campaign.json"
    if path.exists():
        cfg = read_config(root)
        for key, value in given.items():
            if key in GROWABLE:
                setattr(cfg, key, int(value))
            elif getattr(cfg, key) != value:
                raise SystemExit(f"{key} is fixed for this campaign at {getattr(cfg, key)!r}")
    else:
        if given.get("trainer", "lean") not in TRAINERS:
            raise SystemExit(f"trainer must be one of {TRAINERS}")
        base = dict(SMOKE) if given.get("smoke") else {}
        base.update(given)
        cfg = CampaignConfig(**base, id=uuid.uuid4().hex)
    root.mkdir(parents=True, exist_ok=True)
    write_atomic(path, json.dumps(asdict(cfg), indent=2).encode())
    return cfg


class Decisions:
    """Appends one JSON line per decision to the shared log."""

    def __init__(self, root: Path, role: str):
        self.path = Path(root) / "decisions.jsonl"
        self.role = role

    def __call__(self, event: str, steps: int, **detail) -> None:
        record = {"time": _now(), "role": self.role, "steps": int(steps), "event": event, **detail}
        with self.path.open("a") as handle:
            handle.write(json.dumps(record) + "\n")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


_SIGNALLED = {"stop": False}


def _on_signal(signum, frame) -> None:
    _SIGNALLED["stop"] = True


def install_signal_handlers() -> None:
    """Turn SIGTERM and SIGINT into a stop at the next rollout boundary."""
    _SIGNALLED["stop"] = False
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)


class RoleBusy(RuntimeError):
    """Another process already runs this role."""


class RoleLock:
    """An exclusive lock on a role folder, released when the process ends."""

    def __init__(self, folder: Path):
        self.handle = open(folder / "lock", "a+")
        try:
            fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.handle.close()
            raise RoleBusy(str(folder)) from None

    def release(self) -> None:
        fcntl.flock(self.handle, fcntl.LOCK_UN)
        self.handle.close()


class _Plain(BaseCallback):
    def _on_step(self) -> bool:
        return True


class LeanRunner:
    """One role trained by the lean loop, one rollout at a time."""

    def __init__(self, task: str, folder: Path, cfg: CampaignConfig, rt: Runtime, seed: int, takeover: bool):
        sizes = role_sizes(cfg, FIGHTER if task == FIGHT else SHOOTER)
        lean = LeanConfig(
            out=str(folder),
            n_envs=sizes["n_envs"],
            n_steps=sizes["n_steps"],
            batch_size=sizes["batch_size"],
            n_epochs=cfg.n_epochs,
            seed=seed,
            device=rt.fighter_device if task == FIGHT else rt.drill_device,
            workers=rt.workers,
            threads=rt.threads,
            snapshot_every=cfg.snapshot_every,
            checkpoint_every=NEVER,
            max_rss_gb=rt.max_rss_gb,
            min_free_gb=rt.min_free_gb,
            stages=list(PLANS[cfg.plan].stages),
            plan=cfg.plan,
            adaptive=PLANS[cfg.plan].adaptive,
        )
        self.task = task
        self.trainer = LeanTrainer(lean, task, takeover=takeover)

    @property
    def steps(self) -> int:
        return self.trainer.steps

    @property
    def stop_reason(self) -> str:
        return self.trainer.stop_reason

    def rollout(self) -> None:
        self.trainer.collect()
        self.trainer.update()
        self.trainer._after_rollout()

    def policy(self) -> NumpyPolicy:
        return self.trainer.model.to_policy()

    def set_experts(self, loaded: dict[str, LoadedExpert]) -> None:
        self.trainer.host.call("set_experts", loaded)

    def farm_tally(self) -> dict:
        return merge_tallies(self.trainer.host.call("farm_tally"))

    def recent_actions(self) -> np.ndarray:
        return self.trainer.actions.detach().cpu().numpy()

    def info(self) -> dict:
        t = self.trainer
        rows = t.host.call("stats")
        games = sum(row[1] for row in rows)
        wins = sum(row[0] for row in rows)
        stage = t.cfg.stages[t.stage_index].name if self.task == FIGHT else self.task
        return {
            "stage": stage,
            "win_rate": round(wins / games, 4) if games else 0.0,
            "games": games,
            "league": len(t.snapshots),
            "device": str(t.device),
        }

    def state(self) -> dict:
        t = self.trainer
        nets = io.BytesIO()
        torch.save({"model": t.model.state_dict(), "optimizer": t.optimizer.state_dict()}, nets)
        cuda = torch.cuda.get_rng_state_all() if t.device.type == "cuda" else None
        return {
            "nets": nets.getvalue(),
            "torch_rng": torch.get_rng_state(),
            "cuda_rng": cuda,
            "steps": t.steps,
            "stage": t.stage_index,
            "stage_start": t.stage_start,
            "last_snapshot": t.last_snapshot,
            "snapshots": list(t.snapshots),
            "slots": t.host.call("get_state"),
        }

    def restore(self, saved: dict) -> None:
        t = self.trainer
        nets = torch.load(io.BytesIO(saved["nets"]), map_location=t.device, weights_only=True)
        t.model.load_state_dict(nets["model"])
        t.optimizer.load_state_dict(nets["optimizer"])
        t.steps = saved["steps"]
        t.stage_index = saved["stage"]
        t.stage_start = saved["stage_start"]
        t.last_snapshot = saved["last_snapshot"]
        t.snapshots = []
        t.league.members = []
        for policy in saved["snapshots"]:
            t.snapshots.append(policy)
            t.league.add(policy)
        t.host.call_each("set_state", saved["slots"])
        torch.set_rng_state(saved["torch_rng"])
        if saved["cuda_rng"] is not None and t.device.type == "cuda":
            torch.cuda.set_rng_state_all(saved["cuda_rng"])

    def close(self) -> None:
        self.trainer.host.close()


class SB3Runner:
    """One role trained by Stable Baselines masked PPO, one rollout at a time."""

    def __init__(self, task: str, folder: Path, cfg: CampaignConfig, rt: Runtime, seed: int, takeover: bool):
        limit_threads(rt.threads)
        sizes = role_sizes(cfg, FIGHTER if task == FIGHT else SHOOTER)
        n = sizes["n_envs"]
        self.task = task
        self.rt = rt
        self.stop_reason = ""
        if task == FIGHT:
            interface = expert_interface(MAX_TICKS) if takeover else None
            pool = OpponentPool(n, seed=seed + 1, max_ticks=MAX_TICKS, interface=interface)
            self.env = ArenaVecEnv(
                n, pool, SimConfig(), RewardConfig(), max_ticks=MAX_TICKS, seed=seed, interface=interface
            )
        else:
            self.env = DRILLS[task][0](n, seed=seed)
        self.tcfg = TrainConfig(
            out=str(folder),
            n_envs=n,
            n_steps=sizes["n_steps"],
            batch_size=sizes["batch_size"],
            n_epochs=cfg.n_epochs,
            seed=seed,
            threads=rt.threads,
            snapshot_every=cfg.snapshot_every,
            checkpoint_every=NEVER,
            max_rss_gb=float("inf"),
        )
        self.model = build_model(self.env, self.tcfg)
        self.callback = CurriculumCallback(self.tcfg, self.env, folder, {}) if task == FIGHT else _Plain()

    @property
    def steps(self) -> int:
        return int(self.model.num_timesteps)

    def rollout(self) -> None:
        self.model.learn(self.tcfg.n_steps * self.tcfg.n_envs, callback=self.callback, reset_num_timesteps=False)
        if peak_rss_gb() > self.rt.max_rss_gb or free_memory_gb() < self.rt.min_free_gb:
            self.stop_reason = "memory limit"

    def policy(self) -> NumpyPolicy:
        return NumpyPolicy.from_sb3(self.model)

    def set_experts(self, loaded: dict[str, LoadedExpert]) -> None:
        self.env.interface.experts.install(loaded)

    def farm_tally(self) -> dict:
        return self.env.farm_tally()

    def recent_actions(self) -> np.ndarray:
        return np.rint(self.model.rollout_buffer.actions).astype(np.int64)

    def info(self) -> dict:
        fight = self.task == FIGHT
        stage = self.tcfg.stages[self.callback.stage_index].name if fight else self.task
        return {
            "stage": stage,
            "win_rate": round(self.env.win_rate(), 4),
            "games": len(self.env.results),
            "league": len(self.env.pool.snapshots),
            "device": "cpu",
        }

    def state(self) -> dict:
        blob = io.BytesIO()
        self.model.save(blob)
        callback = {}
        if self.task == FIGHT:
            cb = self.callback
            callback = {"stage": cb.stage_index, "stage_start": cb.stage_start, "last_snapshot": cb.last_snapshot}
        return {
            "model": blob.getvalue(),
            "env": pack_env(self.env),
            "last_obs": self.model._last_obs,
            "last_starts": self.model._last_episode_starts,
            "callback": callback,
            "rng": (random.getstate(), np.random.get_state(), torch.get_rng_state()),
        }

    def restore(self, saved: dict) -> None:
        self.model = MaskablePPO.load(io.BytesIO(saved["model"]), env=self.env, device="cpu")
        unpack_env(self.env, saved["env"])
        self.model._last_obs = saved["last_obs"]
        self.model._last_episode_starts = saved["last_starts"]
        if self.task == FIGHT:
            cb = self.callback
            cb.stage_index = saved["callback"]["stage"]
            cb.stage_start = saved["callback"]["stage_start"]
            cb.last_snapshot = saved["callback"]["last_snapshot"]
        random.setstate(saved["rng"][0])
        np.random.set_state(saved["rng"][1])
        torch.set_rng_state(saved["rng"][2])

    def close(self) -> None:
        return None


def make_runner(cfg: CampaignConfig, role: str, folder: Path, rt: Runtime):
    """Build the trainer of one role from random weights."""
    if cfg.plan != "melee" and cfg.trainer != "lean":
        raise SystemExit("training plans need the lean trainer")
    task = FIGHT if role == FIGHTER else DRILL_OF[role]
    kind = LeanRunner if cfg.trainer == "lean" else SB3Runner
    return kind(task, folder, cfg, rt, cfg.seed + ROLE_SEED[role], role == FIGHTER)


def drill_pass_test(role: str) -> Callable[[NumpyPolicy], dict]:
    """Return the held-out pass test of a drill role."""
    return DRILLS[DRILL_OF[role]][1]


def drill_score(report: dict) -> float:
    """Return one number to compare passing versions: the worst hit rate or the block rate."""
    if "score" in report:
        return float(report["score"])
    if "weapons" in report:
        return float(min(entry["policy"]["hit_rate"] for entry in report["weapons"].values()))
    return float(report.get("block_rate", 0.0))


def load_experts(store: ExpertStore, versions: dict, campaign: str) -> dict[str, LoadedExpert]:
    """Load the given versions, refusing any expert another campaign published."""
    loaded = {}
    for name, version in versions.items():
        if version is None:
            continue
        expert = store.load(name, int(version))
        if expert.source.get("campaign") != campaign:
            raise ExpertRejected(f"{name} version {version} was published by another campaign")
        loaded[name] = expert
    return loaded


def _save_policy(folder: Path, policy: NumpyPolicy, meta: dict) -> None:
    blob = io.BytesIO()
    policy.save(blob)
    write_atomic(folder / "policy.npz", blob.getvalue())
    write_atomic(folder / "policy.json", json.dumps(meta, indent=2).encode())


class RoleRun:
    """The loop of one role: rollouts, pass tests or expert loads, checkpoints and stops."""

    def __init__(
        self,
        root: Path,
        role: str,
        rt: Runtime,
        pass_test: Callable[[NumpyPolicy], dict] | None = None,
        after_rollout: Callable[["RoleRun"], None] | None = None,
        farm_source=None,
        watch_settings: WatchSettings | None = None,
    ):
        self.root = Path(root)
        self.role = role
        self.rt = rt
        self.cfg = read_config(self.root)
        self.folder = self.root / role
        self.folder.mkdir(parents=True, exist_ok=True)
        self.store = ExpertStore(self.root / "experts")
        self.log = Decisions(self.root, role)
        self.fighter = role == FIGHTER
        self.budget = self.cfg.fighter_steps if self.fighter else self.cfg.drill_steps
        self.pass_test = pass_test or (None if self.fighter else drill_pass_test(role))
        self.locks = () if self.fighter else tuple(DRILLS[DRILL_OF[role]][0].locked_heads)
        self.after_rollout = after_rollout
        self.started = time.monotonic()
        self.rollouts = 0
        self.loaded: dict[str, LoadedExpert] = {}
        self.last_status = 0.0
        self.runner = None
        self.state: dict = {}
        self.watch = FarmWatch(self.folder, role, self.log, watch_settings)
        self.farm_source = farm_source
        self.farm_context: list = []
        self.watch_error = ""

    def stop_requested(self) -> str:
        """Return why this role should stop now, or an empty string."""
        if _SIGNALLED["stop"]:
            return "signal"
        if (self.root / "STOP").exists():
            return "stop request"
        if self.rt.parent and os.getppid() != self.rt.parent:
            return "parent ended"
        if self.rt.max_minutes > 0 and (time.monotonic() - self.started) / 60.0 >= self.rt.max_minutes:
            return "time limit"
        if self.rt.max_rollouts and self.rollouts >= self.rt.max_rollouts:
            return "rollout limit"
        return self.runner.stop_reason

    def run(self) -> int:
        """Train until the budget or a stop and return the exit code."""
        try:
            lock = RoleLock(self.folder)
        except RoleBusy:
            self.log("already running", 0)
            return EXIT_BUSY
        try:
            return self._run()
        except Exception as error:
            steps = self.runner.steps if self.runner is not None else 0
            self.log("crashed", steps, error=repr(error))
            self._status("crashed", repr(error), force=True)
            raise
        finally:
            if self.runner is not None:
                self.runner.close()
            lock.release()

    def _run(self) -> int:
        self.runner = make_runner(self.cfg, self.role, self.folder, self.rt)
        path = self.folder / "checkpoint.pkl"
        if path.exists():
            saved = pickle.loads(path.read_bytes())
            self.state = saved["role"]
            if self.fighter:
                self._reload(self.state["experts"])
            self.runner.restore(saved["runner"])
            self.watch.restore(self.state.get("farm"))
            self.log("resumed", self.runner.steps, trainer=self.cfg.trainer)
        else:
            self.state = {
                "next_test": self.cfg.test_every,
                "next_checkpoint": self.cfg.checkpoint_every,
                "experts": {name: None for name in EXPERT_NAMES},
                "rejected": {},
                "tests": [],
                "published": [],
                "best": None,
                "last_test": -1,
            }
            self.log("started from random weights", 0, trainer=self.cfg.trainer)
        if self.fighter:
            self._poll()
        self.farm_context = self._context()
        reason = ""
        while self.runner.steps < self.budget:
            reason = self.stop_requested()
            if reason:
                break
            self.runner.rollout()
            self.rollouts += 1
            self._boundary()
        done = self.runner.steps >= self.budget
        if done and not self.fighter and self.state["last_test"] != self.runner.steps:
            self._test()
        self._checkpoint()
        if done:
            self.log("finished", self.runner.steps)
            self._status("done", "", force=True)
            return EXIT_DONE
        self.log("stopped", self.runner.steps, reason=reason)
        self._status("stopped", reason, force=True)
        return EXIT_MEMORY if reason == "memory limit" else EXIT_STOPPED

    def farm_tally(self) -> dict:
        return self.runner.farm_tally()

    def recent_actions(self) -> np.ndarray:
        return self.runner.recent_actions()

    def replay_env(self, n: int, seed: int) -> ArenaVecEnv:
        """Build fresh arenas with the task, stage and experts this role trains on now."""
        env = EnvSpec(FIGHT if self.fighter else DRILL_OF[self.role], n, seed, self.fighter, self.cfg.plan).build()
        if self.fighter:
            name = self.runner.info()["stage"]
            stage = next(item for item in PLANS[self.cfg.plan].stages if item.name == name)
            env.reward_cfg.shaping = stage.shaping
            env.set_weapons(stage.weapons)
            env.pool.set_mix(stage.mix)
            env.interface.experts.install(dict(self.loaded))
        return env

    def _context(self) -> list:
        """Return what must stay the same for two windows to be compared."""
        if not self.fighter:
            return [self.role]
        return [self.runner.info()["stage"], sorted((k, v) for k, v in self.state["experts"].items() if v)]

    def publishing_held(self) -> bool:
        """Return whether this run may not publish, after a confirmed farm or a broken watcher."""
        return self.watch.confirmed or bool(self.watch_error)

    def _watch(self, steps: int) -> None:
        """Feed the watcher after a rollout and run its checks when a checkpoint is due."""
        source = self.farm_source or self
        try:
            self.watch.absorb(source.farm_tally(), self.farm_context)
            if steps >= self.state["next_checkpoint"]:
                self.watch.check(steps, source.recent_actions(), source.replay_env)
        except Exception as error:
            if not self.watch_error:
                self.log("farm watch failed, publishing held", steps, error=repr(error))
            self.watch_error = repr(error)

    def _boundary(self) -> None:
        steps = self.runner.steps
        self._watch(steps)
        if not self.fighter and steps >= self.state["next_test"]:
            self._test()
            while self.state["next_test"] <= steps:
                self.state["next_test"] += self.cfg.test_every
        if self.fighter:
            self._poll()
        if steps >= self.state["next_checkpoint"]:
            self._checkpoint()
            while self.state["next_checkpoint"] <= steps:
                self.state["next_checkpoint"] += self.cfg.checkpoint_every
        self.farm_context = self._context()
        self._status("running", "")
        if self.after_rollout is not None:
            self.after_rollout(self)

    def _test(self) -> None:
        """Run the pass test on the current network and publish it only if it passes."""
        steps = self.runner.steps
        policy = self.runner.policy()
        report = self.pass_test(policy)
        passed = report.get("passed") is True
        score = drill_score(report)
        self.watch.note_score(score)
        self.state["last_test"] = steps
        self.state["tests"] = (self.state["tests"] + [{"steps": steps, "passed": passed, "score": score}])[-20:]
        if not passed:
            self.log("pass test failed", steps, score=score)
            return
        best = self.state["best"]
        if best is not None and score < best:
            self.log("passed below the live version, kept it", steps, score=score, live=best)
            return
        if self.publishing_held():
            self.log("publishing held", steps, score=score, farm=self.watch.summary()["confirmed"])
            return
        source = {"campaign": self.cfg.id, "role": self.role, "steps": steps, "trainer": self.cfg.trainer}
        version = self.store.publish(self.role, policy, report, self.locks, source)
        self.state["best"] = score
        self.state["published"].append({"version": version, "steps": steps, "score": score})
        self.log("published", steps, version=version, score=score)

    def _reload(self, versions: dict) -> None:
        try:
            self.loaded = load_experts(self.store, versions, self.cfg.id)
        except (ExpertRejected, OSError, ValueError, KeyError) as error:
            self.log("could not reload the recorded experts", 0, error=repr(error))
            self.loaded = {}
            self.state["experts"] = {name: None for name in EXPERT_NAMES}
        self.runner.set_experts(self.loaded)

    def _poll(self) -> None:
        """Load every newly published expert, so the next rollout uses it."""
        steps = self.runner.steps
        changed = False
        for name in EXPERT_NAMES:
            try:
                record = self.store.current(name)
            except (OSError, ValueError) as error:
                self.log("unreadable expert pointer", steps, expert=name, error=repr(error))
                continue
            if record is None:
                continue
            version = int(record["version"])
            if version == self.state["experts"].get(name) or self.state["rejected"].get(name) == version:
                continue
            try:
                expert = load_experts(self.store, {name: version}, self.cfg.id)[name]
                ExpertSet().install({name: expert})
            except (ExpertRejected, OSError, ValueError, KeyError) as error:
                self.state["rejected"][name] = version
                self.log("rejected expert", steps, expert=name, version=version, error=repr(error))
                continue
            self.loaded[name] = expert
            self.state["experts"][name] = version
            changed = True
            self.log("loaded expert", steps, expert=name, version=version)
        if changed:
            self.runner.set_experts(dict(self.loaded))

    def _checkpoint(self) -> None:
        steps = self.runner.steps
        self.state["farm"] = self.watch.state
        saved = {"role": self.state, "runner": self.runner.state(), "steps": steps}
        write_atomic(self.folder / "checkpoint.pkl", pickle.dumps(saved, protocol=5))
        info = self.runner.info()
        meta = {"steps": steps, "stage": info["stage"], "trainer": self.cfg.trainer, "campaign": self.cfg.id}
        if self.fighter:
            meta["experts"] = dict(self.state["experts"])
        if self.publishing_held():
            meta["held"] = True
            self.log("checkpoint policy held", steps)
        else:
            _save_policy(self.folder, self.runner.policy(), meta)
        with (self.folder / "checkpoints.jsonl").open("a") as handle:
            handle.write(json.dumps({"time": _now(), **meta}) + "\n")

    def _status(self, state: str, reason: str, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self.last_status < STATUS_SECONDS:
            return
        self.last_status = now
        status = {"role": self.role, "trainer": self.cfg.trainer, "state": state, "reason": reason}
        status["farm"] = {**self.watch.summary(), "watch_error": self.watch_error}
        if self.runner is not None:
            status.update(
                steps=self.runner.steps,
                budget=self.budget,
                peak_rss_gb=round(peak_rss_gb(), 3),
                minutes=round((now - self.started) / 60.0, 2),
                updated=_now(),
            )
            try:
                status.update(self.runner.info())
            except Exception:
                pass
        if self.fighter:
            status["experts"] = dict(self.state.get("experts", {}))
        else:
            status["tests"] = self.state.get("tests", [])[-3:]
            status["published"] = self.state.get("published", [])
        write_atomic(self.folder / "status.json", json.dumps(status, indent=2).encode())


def run_role(
    root: Path,
    role: str,
    rt: Runtime | None = None,
    pass_test: Callable[[NumpyPolicy], dict] | None = None,
    after_rollout: Callable[[RoleRun], None] | None = None,
    farm_source=None,
    watch_settings: WatchSettings | None = None,
) -> int:
    """Run one role in this process and return its exit code."""
    return RoleRun(root, role, rt or Runtime(), pass_test, after_rollout, farm_source, watch_settings).run()


def write_progress(root: Path) -> dict:
    """Merge every role status, the live experts and the latest decisions into progress.json."""
    root = Path(root)
    cfg = read_config(root)
    roles = {}
    for role in ROLES:
        path = root / role / "status.json"
        try:
            roles[role] = json.loads(path.read_text())
        except (FileNotFoundError, ValueError):
            roles[role] = {"state": "not started"}
    store = ExpertStore(root / "experts")
    experts = {}
    for name in EXPERT_NAMES:
        try:
            record = store.current(name)
        except (OSError, ValueError):
            record = None
        experts[name] = {"published": record["version"] if record else None}
    decisions = []
    log = root / "decisions.jsonl"
    if log.exists():
        lines = log.read_text().splitlines()[-RECENT_DECISIONS:]
        decisions = [json.loads(line) for line in lines if line.strip()]
    progress = {
        "campaign": cfg.id,
        "trainer": cfg.trainer,
        "smoke": cfg.smoke,
        "updated": _now(),
        "stop_requested": (root / "STOP").exists(),
        "roles": roles,
        "experts": experts,
        "farm": {role: roles[role].get("farm") for role in ROLES},
        "decisions": decisions,
    }
    write_atomic(root / "progress.json", json.dumps(progress, indent=2).encode())
    return progress


class Child:
    """One role run in its own process."""

    def __init__(self, root: Path, role: str, rt: Runtime):
        self.root = root
        self.role = role
        self.rt = rt
        self.restarts = 0
        self.code: int | None = None
        self.signalled = False
        self.proc = self._spawn()

    def _spawn(self) -> subprocess.Popen:
        folder = self.root / self.role
        folder.mkdir(parents=True, exist_ok=True)
        runtime = json.dumps(asdict(self.rt))
        command = [sys.executable, "-m", "fighter.campaign", "role", self.role, "--out", str(self.root)]
        with (folder / "log.txt").open("ab") as log:
            return subprocess.Popen(command + ["--runtime", runtime], stdout=log, stderr=subprocess.STDOUT)


class Supervisor:
    """Watches the role processes, restarts crashed ones and keeps progress.json current."""

    def __init__(self, root: Path, roles: list[str], rt: Runtime):
        self.root = root
        self.rt = rt
        self.log = Decisions(root, "campaign")
        child_rt = Runtime(**{**asdict(rt), "parent": os.getpid()})
        self.children = [Child(root, role, child_rt) for role in roles]
        self.last_progress = 0.0
        self.stopping_since: float | None = None

    def tick(self, force: bool = False) -> None:
        stopping = _SIGNALLED["stop"] or (self.root / "STOP").exists()
        if stopping and self.stopping_since is None:
            self.stopping_since = time.monotonic()
        for child in self.children:
            if child.code is not None:
                continue
            code = child.proc.poll()
            if code is None:
                if _SIGNALLED["stop"] and not child.signalled:
                    child.proc.send_signal(signal.SIGTERM)
                    child.signalled = True
                continue
            if code in (EXIT_DONE, EXIT_STOPPED, EXIT_MEMORY, EXIT_BUSY) or stopping:
                child.code = code
                self.log("role ended", 0, role=child.role, code=code)
            elif child.restarts < self.rt.max_restarts:
                child.restarts += 1
                self.log("restarting crashed role", 0, role=child.role, code=code, restart=child.restarts)
                child.proc = child._spawn()
            else:
                child.code = code
                self.log("role crashed too often", 0, role=child.role, code=code)
        now = time.monotonic()
        if force or now - self.last_progress >= PROGRESS_SECONDS:
            self.last_progress = now
            write_progress(self.root)

    def wait(self) -> list[int]:
        while any(child.code is None for child in self.children):
            self.tick()
            if self.stopping_since is not None and time.monotonic() - self.stopping_since > STOP_WAIT_SECONDS:
                for child in self.children:
                    if child.code is None:
                        child.proc.kill()
                        child.proc.wait()
                        child.code = EXIT_STOPPED
                        self.log("role killed after the stop wait", 0, role=child.role)
            time.sleep(1.0)
        self.tick(force=True)
        return [child.code for child in self.children]


def combine(codes: list[int]) -> int:
    """Return 0 when every role finished, 1 on a crash and 3 when work is left."""
    if any(code not in (EXIT_DONE, EXIT_STOPPED, EXIT_MEMORY, EXIT_BUSY) for code in codes):
        return EXIT_CRASHED
    return EXIT_DONE if all(code == EXIT_DONE for code in codes) else EXIT_STOPPED


def run_campaign(root: Path, given: dict, rt: Runtime, roles: list[str], serial: bool = False) -> int:
    """Run the chosen roles, in parallel processes or one after another in this process."""
    root = Path(root)
    prepare_config(root, given)
    log = Decisions(root, "campaign")
    stop = root / "STOP"
    if stop.exists():
        stop.unlink()
        log("cleared an old stop request", 0)
    install_signal_handlers()
    ordered = [role for role in ROLES if role in roles]
    log("run", 0, roles=ordered, serial=serial, runtime=asdict(rt))
    codes = []
    if serial:
        for role in ordered:
            if _SIGNALLED["stop"] or stop.exists():
                codes.append(EXIT_STOPPED)
                continue
            codes.append(run_role(root, role, rt))
            write_progress(root)
        return combine(codes)
    supervisor = Supervisor(root, [role for role in ordered if role != FIGHTER], rt)
    if FIGHTER in ordered:
        codes.append(run_role(root, FIGHTER, rt, after_rollout=lambda _: supervisor.tick()))
    codes.extend(supervisor.wait())
    return combine(codes)


def evaluate_fighter(root: Path, opponents: list[str], games: int = 8) -> list[dict]:
    """Play the latest fighter checkpoint on held-out seeds with the experts it trained with."""
    root = Path(root)
    cfg = read_config(root)
    meta = json.loads((root / FIGHTER / "policy.json").read_text())
    policy = NumpyPolicy.load(root / FIGHTER / "policy.npz")
    plan = PLANS[cfg.plan]
    interface = expert_interface(MAX_TICKS, stance=plan.stance)
    interface.experts.install(load_experts(ExpertStore(root / "experts"), meta["experts"], cfg.id))
    results = []
    for name in opponents:
        result = play_matches(
            policy,
            name,
            games_per_arena=games,
            interface=interface,
            weapons=plan.stages[-1].weapons,
            sim_config=SimConfig(ready_gate=plan.ready_gate),
        )
        result["experts"] = meta["experts"]
        results.append(result)
    return results


def _runtime(args: argparse.Namespace) -> Runtime:
    rt = Runtime()
    for item in fields(Runtime):
        value = getattr(args, item.name, None)
        if value is not None:
            setattr(rt, item.name, value)
    return rt


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fighter campaign", description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)

    p = commands.add_parser("run", help="start or continue a campaign")
    p.add_argument("--out", required=True)
    p.add_argument("--trainer", choices=TRAINERS, default=None)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--smoke", action="store_true", default=None)
    p.add_argument("--plan", choices=tuple(PLANS), default=None)
    p.add_argument("--serial", action="store_true", help="run the roles one after another in one process")
    p.add_argument("--roles", default=",".join(ROLES))
    p.add_argument("--envs", dest="n_envs", type=int, default=None)
    p.add_argument("--rollout-steps", dest="n_steps", type=int, default=None)
    p.add_argument("--batch", dest="batch_size", type=int, default=None)
    p.add_argument("--fighter-steps", type=int, default=None)
    p.add_argument("--drill-steps", type=int, default=None)
    p.add_argument("--test-every", type=int, default=None)
    p.add_argument("--checkpoint-every", type=int, default=None)
    p.add_argument("--snapshot-every", type=int, default=None)
    p.add_argument("--max-minutes", type=float, default=None, help="length of this piece, 0 for no limit")
    p.add_argument("--max-rollouts", type=int, default=None)
    p.add_argument("--max-rss-gb", type=float, default=None, help="memory limit of each process")
    p.add_argument("--min-free-gb", type=float, default=None)
    p.add_argument("--fighter-device", default=None)
    p.add_argument("--drill-device", default=None)
    p.add_argument("--threads", type=int, default=None)
    p.add_argument("--workers", type=int, default=None)
    p.add_argument("--max-restarts", type=int, default=None)

    p = commands.add_parser("role", help="run one role, as started by `run`")
    p.add_argument("name", choices=ROLES)
    p.add_argument("--out", required=True)
    p.add_argument("--runtime", default="{}")

    for name, text in (("status", "rewrite and print progress.json"), ("stop", "stop every role cleanly")):
        p = commands.add_parser(name, help=text)
        p.add_argument("--out", required=True)

    p = commands.add_parser("eval", help="evaluate the fighter with its experts on held-out seeds")
    p.add_argument("--out", required=True)
    p.add_argument("--opponent", default="all")
    p.add_argument("--games", type=int, default=8)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.out)
    if args.command == "run":
        keys = [item.name for item in fields(CampaignConfig) if item.name != "id"]
        given = {key: getattr(args, key) for key in keys if getattr(args, key, None) is not None}
        roles = [role.strip() for role in args.roles.split(",") if role.strip()]
        unknown = set(roles) - set(ROLES)
        if unknown:
            raise SystemExit(f"unknown roles {sorted(unknown)}")
        return run_campaign(root, given, _runtime(args), roles, serial=args.serial)
    if args.command == "role":
        install_signal_handlers()
        rt = Runtime(**json.loads(args.runtime))
        return run_role(root, args.name, rt)
    if args.command == "status":
        print(json.dumps(write_progress(root), indent=2))
        return 0
    if args.command == "stop":
        (root / "STOP").touch()
        print(f"stop requested in {root}")
        return 0
    names = sorted(SCRIPTED) if args.opponent == "all" else [args.opponent]
    print(json.dumps(evaluate_fighter(root, names, args.games), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
