"""Evolve fighters from finished runs.

Each generation ranks the living fighters in a rated round robin and a test against
every named scripted opponent. The best become parents. Each child starts from a
parent's network with small changes to its shaping reward, trains against the top
fighters and the hard scripted opponents, and joins the next ranking. The best stay.

Ranking rules:
  A draw counts against a fighter in its score for that opponent.
  Fitness weighs the worst third of the named opponents, so an easy one hides nothing.
  Fitness loses points for every missed bar in REQUIRED, each judged on one named opponent.

Parents:
  Every founder keeps its own line, with one parent and an equal share of the children.
  A draw lowers fitness but never removes a line. Each line has an unchanged control child.
  The incumbent, the control and the top changed children are retested on fresh seeds.
  A changed child becomes a parent only if it beats its line's control by the error margin.
  A draw heavy fighter or one with a confirmed reward farm ranks below every clean one.

An evolution folder holds:
  evolve.json      fixed settings
  state.json       generation, phase and every member
  matches.jsonl    finished matches, never replayed
  log.jsonl        one line per decision, with each child's parent, changes and score
  weight_effects.json  how each changed reward weight moved each behaviour, with controls
  STOP             asks the driver and its children to stop cleanly
  gen-NN/          plan.json (the children), report.json (the ranking), retest.json (the
                   retest and credit of each candidate) and weights.json (each child's
                   weight changes and behaviour moves)
  members/<id>/    a run folder, usable as a rival or as a parent. Ids starting with r are
                   frozen rivals: children train against them, and they never breed.

Run it again with the same folder to continue where it stopped. Parent run folders
are only read.
"""

from __future__ import annotations

import argparse
import fcntl
import gc
import io
import json
import math
import os
import pickle
import shutil
import signal
import subprocess
import sys
import time
import uuid
import zlib
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field, fields
from multiprocessing import get_context
from pathlib import Path
from statistics import NormalDist

import numpy as np
import torch

from .behaviour import OPPONENTS, measure
from .campaign import EXIT_BUSY, EXIT_DONE, EXIT_MEMORY, EXIT_STOPPED, FIGHTER, CampaignConfig, Runtime
from .env import RewardConfig
from .experts import EXPERT_NAMES, ExpertStore, write_atomic
from .lean import THREAD_VARS, ActorCritic, free_memory_gb
from .obs import OBS_DIM
from .opponents import MAX_RIVALS
from .plans import PLANS
from .policy import NumpyPolicy
from .rivals import farm_confirmed, load_rival
from .sim import FIGHT_SETUPS

HELD_OUT_SEED = 3_000_017
SEED_SPREAD = 1_000_000
SCRIPTED_TAG = "scripted:"
DRAW_COST = 0.25
FLOOR_WEIGHT = 0.6
DRAW_LIMIT = 0.5
MEAN_DRAW_LIMIT = 0.25
MIN_WORST = 3
ELO_SCALE = 400.0
ELO_ROUNDS = 200
MUTABLE = ("crit", "sprint_hit", "weak_swing", "shield_block", "shield_break", "followup", "aim", "spacing", "strafe", "best_range")
CHANGE_LOW = 0.5
CHANGE_HIGH = 2.0
ABSOLUTE_LIMITS = {"best_range": (2.2, 3.0)}
POLL_SECONDS = 2.0
STOP_WAIT_SECONDS = 600.0
MEMORY_WAIT_SECONDS = 1800.0
MAX_CHILD_RESTARTS = 3
BUSY_WAIT_SECONDS = 10.0
START_GAP_SECONDS = 60.0
MAX_BUSY_WAITS = 60
DISK_CHECK_SECONDS = 30.0
COMMIT_CHECK_SECONDS = 15.0
COMMIT_READ_FAILURES = 4
WINDOWS_SHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
INTEROP_SOCKETS = ("/run/WSL/1_interop", "/run/WSL/2_interop")
REQUIRED = (
    ("shield_holder", "shield_disables", 1.0),
    ("shield_holder", "win", 0.80),
    ("rusher", "win", 0.85),
    ("axeman", "win", 0.80),
    ("pvp_combo", "win", 0.40),
    ("pvp_sweat", "win", 0.70),
    ("synth", "win", 0.60),
)
REQUIRED_PENALTY = 1.0
MIN_CHANGE = 0.25
MIN_ABSOLUTE = {"best_range": 0.2}
CREDIT_LEVEL = 0.05
OPPONENT_Z = 1.96
REGRESSION_LIMIT = 0.05
RETEST_TAG = "retest:"
MOVE_KEYS = (
    "shield_disables",
    "axe_hits",
    "crits",
    "crossbow_loads",
    "crossbow_shots",
    "shots_into_shield",
    "load_started_2",
    "loaded_by_40",
    "followup_chances_disable",
    "followup_shots_disable",
    "followup_chances_knockback",
    "followup_shots_knockback",
    "followup_hits",
    "shots_wasted_hurt",
)


@dataclass
class EvolveConfig:
    """Settings fixed for the life of an evolution, apart from the number of generations."""

    parents: list[str]
    seed: int = 101
    generations: int = 5
    population: int = 6
    n_parents: int = 3
    children: int = 3
    child_steps: int = 2_000_000
    rivals: int = 6
    test_games: int = 64
    tournament_games: int = 32
    changes: int = 2
    change_scale: float = 0.2
    weight_noise: float = 0.0
    max_per_founder: int = 3
    n_envs: int = 192
    n_steps: int = 32
    batch_size: int = 1024
    checkpoint_every: int = 250_000
    snapshot_every: int = 250_000
    controls: int = 0
    frozen: list[str] = field(default_factory=list)
    retest_games: int = 256
    retest_top: int = 2
    fight_setup: str = "standard"
    plan: str = ""


@dataclass
class EvolveRuntime:
    """Settings of one run of the command, free to change between runs."""

    parallel: int = 1
    threads: int = 2
    max_rss_gb: float = 1.0
    min_free_gb: float = 2.5
    device: str = "cpu"
    max_rollouts: int = 0
    min_disk_gb: float = 0.0
    disk_path: str = "/"
    min_commit_gb: float = 0.0
    rank_parallel: int = 1


class Stopped(Exception):
    """The driver was asked to stop."""


_SIGNALLED = {"stop": False}


def _on_signal(signum, frame) -> None:
    _SIGNALLED["stop"] = True


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def windows_commit_gb() -> float | None:
    """Return the free Windows commit memory in gigabytes, or None when it cannot be read.

    A detached job's own interop socket dies with its SSH session, so this uses the sockets
    of the WSL init process, which stay up.
    """
    command = "[int64](Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory"
    for socket in INTEROP_SOCKETS:
        try:
            done = subprocess.run(
                [WINDOWS_SHELL, "-NoProfile", "-Command", command],
                env={**os.environ, "WSL_INTEROP": socket},
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=20,
            )
            return int(done.stdout.strip()) / 1024**2
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
    return None


def write_json(path: Path, data) -> None:
    """Replace a JSON file in one step."""
    write_atomic(path, json.dumps(data, indent=2).encode())


def stable_seed(*parts: str) -> int:
    """Return a held-out seed that depends only on the given names."""
    return HELD_OUT_SEED + zlib.crc32("|".join(parts).encode()) % SEED_SPREAD


def rates(wins: int, draws: int, losses: int) -> dict:
    """Return a result row with its rates."""
    games = wins + draws + losses
    share = max(games, 1)
    return {
        "games": games,
        "wins": wins,
        "draws": draws,
        "losses": losses,
        "win": round(wins / share, 4),
        "draw": round(draws / share, 4),
        "loss": round(losses / share, 4),
    }


def matchup_score(row: dict) -> float:
    """Return the score against one opponent. A draw is worth less than a loss."""
    return row["win"] - DRAW_COST * row["draw"]


def worst_share(values: list[float]) -> float:
    """Return the mean of the worst third of the values, at least the worst three."""
    if not values:
        return 0.0
    count = min(len(values), max(MIN_WORST, math.ceil(len(values) / 3)))
    return float(np.mean(sorted(values)[:count]))


def is_draw_heavy(named: dict[str, dict]) -> bool:
    """Return whether a fighter draws too often against one opponent or overall."""
    draws = [row["draw"] for row in named.values()]
    return bool(draws) and (max(draws) >= DRAW_LIMIT or float(np.mean(draws)) >= MEAN_DRAW_LIMIT)


def fit_ratings(names: list[str], pairs: dict[tuple[str, str], tuple[int, int, int]]) -> dict[str, float]:
    """Fit Elo style ratings with mean 1500. A draw counts half and one virtual draw steadies each fighter."""
    index = {name: i for i, name in enumerate(names)}
    size = len(names)
    if size == 0:
        return {}
    games = np.zeros((size, size))
    score = np.zeros(size)
    for (a, b), (wins_a, draws, wins_b) in pairs.items():
        i, j = index[a], index[b]
        total = wins_a + draws + wins_b
        games[i, j] += total
        games[j, i] += total
        score[i] += wins_a + draws / 2.0
        score[j] += wins_b + draws / 2.0
    strength = np.ones(size)
    for _ in range(ELO_ROUNDS):
        spread = (games / np.maximum(strength[:, None] + strength[None, :], 1e-12)).sum(axis=1) + 2.0 / (strength + 1.0)
        strength = (score + 1.0) / spread
        strength /= np.exp(np.mean(np.log(strength)))
    elo = ELO_SCALE * np.log10(strength)
    return {name: round(float(1500.0 + elo[index[name]]), 1) for name in names}


def expected_score(rating: float, others: list[float]) -> float:
    """Return the mean expected score of a rating against the other ratings."""
    if not others:
        return 0.5
    return float(np.mean([1.0 / (1.0 + 10.0 ** ((other - rating) / ELO_SCALE)) for other in others]))


def requirement_bars(rows: dict[str, dict]) -> dict[str, dict]:
    """Return progress toward each required bar on the named opponents that were played."""
    bars = {}
    for opponent, metric, target in REQUIRED:
        row = rows.get(opponent)
        if row is None:
            continue
        value = row[metric] if metric in row else float((row.get("behaviour") or {}).get(metric, 0.0))
        bars[f"{opponent}:{metric}"] = {
            "value": round(float(value), 4),
            "target": target,
            "met": bool(value >= target),
            "progress": round(min(float(value) / target, 1.0), 4),
        }
    return bars


def requirement_score(bars: dict[str, dict]) -> float:
    """Return 1.0 when every bar is met. The weakest bar counts as much as all of them together."""
    if not bars:
        return 1.0
    progress = [bar["progress"] for bar in bars.values()]
    return 0.5 * min(progress) + 0.5 * float(np.mean(progress))


def rank_members(
    names: list[str],
    named: dict[str, dict[str, dict]],
    pairs: dict[tuple[str, str], tuple[int, int, int]],
    farmed: set[str] | None = None,
) -> list[dict]:
    """Score every member and return them best first."""
    farmed = farmed or set()
    ratings = fit_ratings(names, pairs)
    table = []
    for name in names:
        rows = named.get(name, {})
        floor = worst_share([matchup_score(row) for row in rows.values()])
        rating_score = expected_score(ratings[name], [ratings[other] for other in names if other != name])
        heavy = is_draw_heavy(rows)
        bars = requirement_bars(rows)
        required = requirement_score(bars)
        blended = FLOOR_WEIGHT * floor + (1.0 - FLOOR_WEIGHT) * rating_score
        rivals = {}
        for (a, b), (wins_a, draws, wins_b) in pairs.items():
            if a == name:
                rivals[b] = rates(wins_a, draws, wins_b)
            elif b == name:
                rivals[a] = rates(wins_b, draws, wins_a)
        table.append(
            {
                "id": name,
                "fitness": round(blended - REQUIRED_PENALTY * (1.0 - required), 4),
                "floor": round(floor, 4),
                "required": round(required, 4),
                "bars": bars,
                "bars_met": all(bar["met"] for bar in bars.values()),
                "rating": ratings[name],
                "rating_score": round(rating_score, 4),
                "draw_heavy": heavy,
                "farm": name in farmed,
                "clean": not heavy and name not in farmed,
                "opponents": rows,
                "rivals": rivals,
            }
        )
    table.sort(key=lambda row: (row["clean"], row["fitness"], row["rating"]), reverse=True)
    return table


def keep_best(table: list[dict], founders: dict[str, str], population: int, max_per_founder: int) -> list[str]:
    """Return the survivors, best first, with at most `max_per_founder` from one founder."""
    kept: list[str] = []
    count: dict[str, int] = {}
    for row in table:
        if row["farm"] or len(kept) == population:
            continue
        line = founders[row["id"]]
        if count.get(line, 0) < max_per_founder:
            kept.append(row["id"])
            count[line] = count.get(line, 0) + 1
    for row in table:
        if len(kept) == population:
            break
        if not row["farm"] and row["id"] not in kept:
            kept.append(row["id"])
    return kept


def retest_fitness(rows: dict[str, dict]) -> float:
    """Score a retest: the worst third of the opponents, less the penalty for missed bars."""
    floor = worst_share([matchup_score(row) for row in rows.values()])
    return floor - REQUIRED_PENALTY * (1.0 - requirement_score(requirement_bars(rows)))


def score_variance(row: dict) -> float:
    """Return the variance of a matchup score, with one extra win and loss so 100% is not certain."""
    games = row["games"] + 2
    win = (row["wins"] + 1) / games
    draw = row["draws"] / games
    return (win + DRAW_COST**2 * draw - (win - DRAW_COST * draw) ** 2) / games


def credit_child(child: dict[str, dict], control: dict[str, dict], tests: int) -> dict:
    """Judge a changed child against its line's control on the same retest.

    The gain is the mean score change over the required opponents. It must pass an error
    margin corrected for the number of children tested, and no named opponent may fall by
    more than the larger of 5 points and its own 95% margin.
    """
    names = [name for name in child if name in control]
    focus = sorted({name for name, _, _ in REQUIRED} & set(names)) or names
    gain = float(np.mean([matchup_score(child[name]) - matchup_score(control[name]) for name in focus]))
    variance = sum(score_variance(child[name]) + score_variance(control[name]) for name in focus) / len(focus) ** 2
    z = NormalDist().inv_cdf(1.0 - CREDIT_LEVEL / (2.0 * max(tests, 1)))
    margin = z * math.sqrt(variance)
    drops = {}
    for name in names:
        drop = matchup_score(control[name]) - matchup_score(child[name])
        limit = max(REGRESSION_LIMIT, OPPONENT_Z * math.sqrt(score_variance(child[name]) + score_variance(control[name])))
        if drop > limit:
            drops[name] = round(drop, 4)
    return {
        "gain": round(gain, 4),
        "margin": round(margin, 4),
        "z": round(z, 3),
        "focus": focus,
        "drops": drops,
        "credited": bool(gain > margin and not drops),
    }


def keep_parents(kept: list[str], parents, population: int) -> list[str]:
    """Add the chosen parents to the survivors and drop the lowest others to fit."""
    parents = list(parents)
    out = list(kept) + [name for name in parents if name not in kept]
    while len(out) > population:
        spare = next((name for name in reversed(out) if name not in parents), None)
        if spare is None:
            break
        out.remove(spare)
    return out


def sized_change(key: str, old: float, low: float, high: float, rng: np.random.Generator, scale: float) -> float:
    """Move a weight by at least its minimum size, going the other way when a limit is too close."""
    grow = (1.0 + MIN_CHANGE) * math.exp(abs(float(rng.normal(0.0, scale))))
    if key in MIN_ABSOLUTE:
        step = MIN_ABSOLUTE[key] * grow / (1.0 + MIN_CHANGE)
        options = [old + step, old - step]
        big_enough = lambda value: abs(value - old) >= MIN_ABSOLUTE[key] - 1e-9
    else:
        options = [old * grow, old / grow]
        big_enough = lambda value: max(value / old, old / value) >= 1.0 + MIN_CHANGE - 1e-9
    if rng.random() < 0.5:
        options.reverse()
    for option in options:
        value = float(np.clip(option, low, high))
        if big_enough(value):
            return round(value, 6)
    raise ValueError(f"{key} has no room for a change of the minimum size")


def mutate_reward(
    plan: str, current: dict, rng: np.random.Generator, count: int, scale: float, keys: tuple[str, ...] | None = None
) -> tuple[dict, dict]:
    """Change a few shaping weights, or exactly `keys`, kept near the plan's own values."""
    base = asdict(RewardConfig(**PLANS[plan].reward))
    reward = dict(current)
    changes: dict[str, list[float]] = {}
    if keys is None:
        picks = rng.choice(len(MUTABLE), size=min(count, len(MUTABLE)), replace=False)
        keys = tuple(MUTABLE[pick] for pick in sorted(int(item) for item in picks))
    for key in keys:
        old = float(reward.get(key, base[key]))
        low, high = ABSOLUTE_LIMITS.get(key, (CHANGE_LOW * base[key], CHANGE_HIGH * base[key]))
        new = sized_change(key, old, low, high, rng, scale)
        reward[key] = new
        changes[key] = [old, new]
    return reward, changes


def child_moves(child: dict[str, dict], parent: dict[str, dict]) -> dict[str, dict]:
    """Return parent and child values of the win rate and every behaviour, per named opponent."""
    out = {}
    for opponent, row in child.items():
        before = parent.get(opponent)
        if before is None:
            continue
        entry = {"games": row["games"], "win": [before["win"], row["win"]], "draw": [before["draw"], row["draw"]]}
        new, old = row.get("behaviour") or {}, before.get("behaviour") or {}
        for key in MOVE_KEYS:
            if key in new and key in old:
                entry[key] = [old[key], new[key]]
        out[opponent] = entry
    return out


def weight_effects(children: list[dict]) -> dict:
    """Group children by which weight they raised or lowered.

    Children with no change are controls and show how far training alone moves a behaviour.
    A child that changed two weights is counted under both, so only single changes separate them.
    `screen_mean_move` comes from the short first test and is a lead only. Only `credited`
    children beat their control on the retest by more than the error margin.
    """
    groups: dict[tuple[str, str], list[dict]] = {}
    for child in children:
        if not child["changes"]:
            groups.setdefault(("control", "none"), []).append(child)
        for weight, (old, new) in child["changes"].items():
            if new == old:
                continue
            groups.setdefault((weight, "up" if new > old else "down"), []).append(child)
    out: dict[str, dict] = {}
    for (weight, direction), members in sorted(groups.items()):
        totals: dict[str, list[float]] = {}
        for child in members:
            for opponent, entry in child["opponents"].items():
                for key, value in entry.items():
                    if key != "games":
                        totals.setdefault(f"{key}:{opponent}", []).append(value[1] - value[0])
        out.setdefault(weight, {})[direction] = {
            "children": [child["id"] for child in members],
            "retested": [child["id"] for child in members if child.get("credit")],
            "credited": [
                {"id": child["id"], "gain": child["credit"]["gain"], "margin": child["credit"]["margin"]}
                for child in members
                if (child.get("credit") or {}).get("credited")
            ],
            "screen_mean_move": {key: round(float(np.mean(values)), 4) for key, values in sorted(totals.items())},
        }
    return out


def add_weight_noise(state: dict, scale: float, rng: np.random.Generator) -> dict:
    """Add noise to the actor weights, sized to each layer's own spread."""
    if scale <= 0.0:
        return state
    out = {}
    for key, value in state.items():
        if key.startswith(("pi.", "action.")) and key.endswith("weight"):
            noise = rng.normal(0.0, scale * float(value.std()), value.shape)
            value = value + torch.as_tensor(noise, dtype=value.dtype)
        out[key] = value
    return out


def _same_actor(model: ActorCritic, policy: NumpyPolicy) -> bool:
    for (weight, bias), (other_weight, other_bias) in zip(model.to_policy().layers, policy.layers):
        if not (np.array_equal(weight, other_weight) and np.array_equal(bias, other_bias)):
            return False
    return True


def starting_weights(root: Path) -> dict:
    """Return actor and critic weights of a run, with a fresh critic when only the actor is saved."""
    folder = Path(root) / FIGHTER
    policy = NumpyPolicy.load(folder / "policy.npz")
    model = ActorCritic(OBS_DIM, int(np.sum(policy.nvec)))
    final = folder / "final.pt"
    if final.exists():
        return torch.load(final, map_location="cpu", weights_only=True)["model"]
    checkpoint = folder / "checkpoint.pkl"
    if checkpoint.exists():
        try:
            saved = pickle.loads(checkpoint.read_bytes())
            nets = torch.load(io.BytesIO(saved["runner"]["nets"]), map_location="cpu", weights_only=True)
            model.load_state_dict(nets["model"])
            if _same_actor(model, policy):
                return model.state_dict()
            model = ActorCritic(OBS_DIM, int(np.sum(policy.nvec)))
        except (OSError, KeyError, ValueError, RuntimeError, pickle.UnpicklingError):
            model = ActorCritic(OBS_DIM, int(np.sum(policy.nvec)))
    modules = [m for m in model.pi if isinstance(m, torch.nn.Linear)] + [model.action]
    with torch.no_grad():
        for module, (weight, bias) in zip(modules, policy.layers):
            module.weight.copy_(torch.from_numpy(np.array(weight)))
            module.bias.copy_(torch.from_numpy(np.array(bias)))
    return model.state_dict()


def _read_policy_meta(root: Path) -> dict:
    """Read a run's policy record, trying again if the run replaces it during the read."""
    path = Path(root) / FIGHTER / "policy.json"
    for _ in range(5):
        before = path.read_bytes()
        NumpyPolicy.load(path.with_name("policy.npz"))
        if path.read_bytes() == before:
            return json.loads(before)
        time.sleep(0.2)
    return json.loads(path.read_bytes())


def _copy_experts(source: Path, target: Path, versions: dict, campaign: str, origin: str) -> dict:
    """Publish a run's experts into a new member under the member's own campaign id."""
    store, new = ExpertStore(source / "experts"), ExpertStore(target / "experts")
    out: dict[str, int | None] = {name: None for name in EXPERT_NAMES}
    for name, version in versions.items():
        if version is None:
            continue
        expert = store.load(name, int(version))
        report = {"passed": True, "inherited_from": origin, "version": int(version)}
        source_note = {"campaign": campaign, "inherited_from": origin}
        out[name] = new.publish(name, expert.policy, report, expert.locks, source_note)
    return out


class Evolution:
    """The driver: it ranks, breeds, trains and resumes from its state file."""

    def __init__(self, root: Path, cfg: EvolveConfig, rt: EvolveRuntime):
        self.root = Path(root)
        self.cfg = cfg
        self.rt = rt
        self.members_dir = self.root / "members"
        self.state_path = self.root / "state.json"
        self.matches_path = self.root / "matches.jsonl"
        self.state: dict = {}
        self.matches: dict[str, dict] = {}
        self._disk_checked = -math.inf
        self._commit_checked = -math.inf
        self._commit_free = 0.0
        self._commit_failures = 0
        extra = PLANS[cfg.plan].named_opponents if cfg.plan else ()
        self.opponents = tuple(OPPONENTS) + tuple(name for name in extra if name not in OPPONENTS)

    def log(self, event: str, **detail) -> None:
        with (self.root / "log.jsonl").open("a") as handle:
            handle.write(json.dumps({"time": _now(), "event": event, **detail}) + "\n")

    def save(self) -> None:
        write_json(self.state_path, self.state)

    def check_stop(self) -> None:
        if _SIGNALLED["stop"] or (self.root / "STOP").exists():
            raise Stopped
        if self.rt.min_disk_gb > 0.0 and time.monotonic() - self._disk_checked >= DISK_CHECK_SECONDS:
            self._disk_checked = time.monotonic()
            free = shutil.disk_usage(self.rt.disk_path).free / 1024**3
            if free < self.rt.min_disk_gb:
                self.log("stopped for disk", free_gb=round(free, 2), limit_gb=self.rt.min_disk_gb)
                raise Stopped
        if self.commit_free() < self.rt.min_commit_gb:
            self.log(
                "stopped for windows memory",
                free_gb=round(self._commit_free, 2),
                limit_gb=self.rt.min_commit_gb,
                failed_reads=self._commit_failures,
            )
            raise Stopped

    def commit_free(self) -> float:
        """Return free Windows commit memory, read at most once per check interval.

        Memory that cannot be read counts as none free: nothing starts before the first good
        read, and a run of failed reads stops the evolution.
        """
        if self.rt.min_commit_gb <= 0.0:
            return math.inf
        if time.monotonic() - self._commit_checked >= COMMIT_CHECK_SECONDS:
            self._commit_checked = time.monotonic()
            value = windows_commit_gb()
            if value is None:
                self._commit_failures += 1
                if self._commit_failures >= COMMIT_READ_FAILURES:
                    self._commit_free = 0.0
            else:
                self._commit_failures = 0
                self._commit_free = value
        return self._commit_free

    def folder(self, member: str) -> Path:
        return self.members_dir / member

    def gen_dir(self, generation: int) -> Path:
        path = self.root / f"gen-{generation:02d}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def alive(self) -> list[str]:
        return [name for name, row in self.state["members"].items() if row["status"] == "alive"]

    def frozen(self) -> list[str]:
        return [name for name, row in self.state["members"].items() if row["status"] == "frozen"]

    def load(self) -> None:
        self.members_dir.mkdir(parents=True, exist_ok=True)
        for stale in self.members_dir.glob(".build-*"):
            shutil.rmtree(stale, ignore_errors=True)
        if self.state_path.exists():
            self.state = json.loads(self.state_path.read_text())
        else:
            self.state = {"generation": 0, "phase": "import", "members": {}}
            self.save()
        if self.matches_path.exists():
            for line in self.matches_path.read_text().splitlines():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                self.matches[row["key"]] = row

    def run(self) -> int:
        self.load()
        try:
            while True:
                self.check_stop()
                phase = self.state["phase"]
                if phase == "import":
                    self.import_founders()
                elif phase == "rank":
                    self.rank_generation()
                elif phase == "breed":
                    self.breed()
                elif phase == "train":
                    self.train_children()
                elif phase == "done":
                    if self.state["generation"] < self.cfg.generations:
                        self.state["generation"] += 1
                        self.state["phase"] = "breed"
                        self.save()
                        continue
                    self.log("finished", generation=self.state["generation"])
                    return EXIT_DONE
        except Stopped:
            self.log("stopped", generation=self.state["generation"], phase=self.state["phase"])
            return EXIT_STOPPED

    def import_founders(self) -> None:
        """Copy each parent run once, so later changes to that run do not matter."""
        for index, source in enumerate(self.cfg.parents):
            member = f"g00-{index:02d}"
            if member in self.state["members"]:
                continue
            source = Path(source)
            if farm_confirmed(source):
                self.log("parent skipped", parent=str(source), reason="confirmed reward farm")
                continue
            try:
                self._import_one(member, source)
            except (OSError, ValueError, KeyError) as error:
                self.log("parent skipped", parent=str(source), reason=repr(error))
        if not self.alive():
            raise SystemExit("no usable parent run")
        for index, source in enumerate(self.cfg.frozen):
            member = f"r00-{index:02d}"
            if member in self.state["members"]:
                continue
            source = Path(source)
            if farm_confirmed(source):
                self.log("rival skipped", rival=str(source), reason="confirmed reward farm")
                continue
            try:
                self._import_one(member, source, status="frozen")
            except (OSError, ValueError, KeyError) as error:
                self.log("rival skipped", rival=str(source), reason=repr(error))
        self.state["phase"] = "rank"
        self.save()

    def _import_one(self, member: str, source: Path, status: str = "alive") -> None:
        config = json.loads((source / "campaign.json").read_text())
        meta = _read_policy_meta(source)
        build = self.members_dir / f".build-{member}"
        shutil.rmtree(build, ignore_errors=True)
        (build / FIGHTER).mkdir(parents=True)
        campaign = uuid.uuid4().hex
        experts = _copy_experts(source, build, meta.get("experts") or {}, campaign, str(source))
        policy = NumpyPolicy.load(source / FIGHTER / "policy.npz")
        policy.save(build / FIGHTER / "policy.npz")
        torch.save({"model": starting_weights(source)}, build / FIGHTER / "final.pt")
        write_json(build / FIGHTER / "policy.json", {"steps": meta.get("steps"), "experts": experts, "campaign": campaign})
        plan = self.cfg.plan if self.cfg.plan and status == "alive" else config.get("plan", "melee")
        settings = CampaignConfig(plan=plan, id=campaign, reward=config.get("reward"), fight_setup=self.cfg.fight_setup)
        write_json(build / "campaign.json", asdict(settings))
        record = {
            "id": member,
            "generation": 0,
            "parent": None,
            "founder": member,
            "source": str(source),
            "source_steps": meta.get("steps"),
            "plan": plan,
            "reward": config.get("reward") or {},
            "changes": {},
            "status": status,
        }
        self._install(build, member, record)
        self.save()
        self.log("founder" if status == "alive" else "frozen rival", id=member, source=str(source), plan=plan, steps=meta.get("steps"))

    def _install(self, build: Path, member: str, record: dict) -> None:
        """Move a finished build into place, replacing what a crash left before the state was saved."""
        write_json(build / "member.json", {key: value for key, value in record.items() if key != "status"})
        shutil.rmtree(self.folder(member), ignore_errors=True)
        os.rename(build, self.folder(member))
        self.state["members"][member] = record

    def _tasks(self, names: list[str]) -> list[dict]:
        cfg = self.cfg
        tasks = []
        for name in names:
            for opponent in self.opponents:
                key = f"{name}|{SCRIPTED_TAG}{opponent}"
                if key not in self.matches:
                    tasks.append(
                        {
                            "key": key,
                            "root": str(self.root),
                            "a": name,
                            "scripted": opponent,
                            "games": cfg.test_games,
                            "seed": stable_seed(SCRIPTED_TAG, opponent),
                            "fight_setup": cfg.fight_setup,
                        }
                    )
        ordered = sorted(names)
        for i, a in enumerate(ordered):
            for b in ordered[i + 1 :]:
                key = f"{a}|{b}"
                if key not in self.matches:
                    tasks.append(
                        {
                            "key": key,
                            "root": str(self.root),
                            "a": a,
                            "b": b,
                            "games": cfg.tournament_games,
                            "seed": stable_seed(a, b),
                            "fight_setup": cfg.fight_setup,
                        }
                    )
        for name in names:
            for rival in self.frozen():
                key = f"{name}|{rival}"
                if key not in self.matches:
                    tasks.append(
                        {
                            "key": key,
                            "root": str(self.root),
                            "a": name,
                            "b": rival,
                            "games": cfg.tournament_games,
                            "seed": stable_seed(name, rival),
                            "fight_setup": cfg.fight_setup,
                        }
                    )
        return tasks

    def _record(self, row: dict) -> None:
        self.matches[row["key"]] = row
        with self.matches_path.open("a") as handle:
            handle.write(json.dumps(row) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def play_all(self, names: list[str]) -> None:
        """Play every missing match. Finished ones are on disk and are never replayed."""
        tasks = self._tasks(names)
        if not tasks:
            return
        self.log("matches", generation=self.state["generation"], count=len(tasks))
        self._run_tasks(tasks)

    def _run_tasks(self, tasks: list[dict]) -> None:
        """Play the given matches and record each one as it finishes.

        By default they run one at a time in this process, because each worker would load
        its own PyTorch. Every match has its own seed, so the results do not depend on this.
        """
        if self.rt.rank_parallel <= 1:
            for task in tasks:
                self.check_stop()
                self._record(play_task(task))
                gc.collect()
            return
        saved = {name: os.environ.get(name) for name in THREAD_VARS}
        os.environ.update({name: "1" for name in THREAD_VARS})
        try:
            with ProcessPoolExecutor(max_workers=self.rt.rank_parallel, mp_context=get_context("spawn")) as pool:
                pending = [pool.submit(play_task, task) for task in tasks]
                try:
                    for future in as_completed(pending):
                        self._record(future.result())
                        self.check_stop()
                except Stopped:
                    for future in pending:
                        future.cancel()
                    raise
        finally:
            for name, value in saved.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def rank_generation(self) -> None:
        generation = self.state["generation"]
        for name in self.alive():
            if farm_confirmed(self.folder(name)):
                self._reject_farm(name)
        self.save()
        names = self.alive()
        self.play_all(names)
        named = {
            name: {
                opponent: self.matches[f"{name}|{SCRIPTED_TAG}{opponent}"]["result"] for opponent in self.opponents
            }
            for name in names
        }
        pairs = {}
        ordered = sorted(names)
        for i, a in enumerate(ordered):
            for b in ordered[i + 1 :]:
                row = self.matches[f"{a}|{b}"]["result"]
                pairs[(a, b)] = (row["wins"], row["draws"], row["losses"])
        table = rank_members(names, named, pairs)
        for row in table:
            row["frozen_rivals"] = {rival: self.matches[f"{row['id']}|{rival}"]["result"] for rival in self.frozen()}
        founders = {name: self.state["members"][name]["founder"] for name in names}
        chosen, credits = self._select_parents(generation, table)
        kept = keep_best(table, founders, self.cfg.population, self.cfg.max_per_founder)
        kept = keep_parents(kept, chosen.values(), self.cfg.population)
        for row in table:
            member = self.state["members"][row["id"]]
            member.update(
                fitness=row["fitness"],
                floor=row["floor"],
                rating=row["rating"],
                draw_heavy=row["draw_heavy"],
                farm=row["farm"],
                required=row["required"],
                bars_met=row["bars_met"],
            )
            self.log(
                "scored",
                generation=generation,
                id=row["id"],
                parent=member["parent"],
                changes=member["changes"],
                fitness=row["fitness"],
                floor=row["floor"],
                rating=row["rating"],
                draw_heavy=row["draw_heavy"],
                farm=row["farm"],
                kept=row["id"] in kept,
                win_rates={name: result["win"] for name, result in row["opponents"].items()},
                draw_rates={name: result["draw"] for name, result in row["opponents"].items()},
                rival_win_rates={name: result["win"] for name, result in row["rivals"].items()},
                frozen_win_rates={name: result["win"] for name, result in row["frozen_rivals"].items()},
                required=row["required"],
                bars=row["bars"],
                shield_disables={
                    name: (result.get("behaviour") or {}).get("shield_disables") for name, result in row["opponents"].items()
                },
            )
            if row["id"] not in kept:
                self._retire(row["id"], "ranked out")
        self.state["ranking"] = kept
        self.state["line_parents"] = chosen
        write_json(self.gen_dir(generation) / "report.json", {"generation": generation, "kept": kept, "table": table})
        self._write_weight_report(generation, names, credits)
        self.state["phase"] = "done"
        self.save()

    def _select_parents(self, generation: int, table: list[dict]) -> tuple[dict[str, str], dict[str, dict]]:
        """Retest each line's candidates on fresh seeds and return its next parent and the credits."""
        members = self.state["members"]
        ranked = [row["id"] for row in table]
        previous = self.state.get("line_parents", {})
        lines: dict[str, dict] = {}
        for name in ranked:
            row = members[name]
            founder = row["founder"]
            if founder not in lines:
                current = previous.get(founder)
                lines[founder] = {"parent": current if current in ranked else name, "control": None, "top": []}
            line = lines[founder]
            if row["generation"] != generation or row["parent"] is None:
                continue
            if not row["changes"]:
                line["control"] = line["control"] or name
            elif len(line["top"]) < self.cfg.retest_top:
                line["top"].append(name)
        candidates = sorted(
            {name for line in lines.values() for name in (line["parent"], line["control"], *line["top"]) if name}
        )
        tasks = []
        for name in candidates:
            for opponent in self.opponents:
                key = f"{name}|{RETEST_TAG}{generation}:{opponent}"
                if key not in self.matches:
                    tasks.append(
                        {
                            "key": key,
                            "root": str(self.root),
                            "a": name,
                            "scripted": opponent,
                            "games": self.cfg.retest_games,
                            "seed": stable_seed(RETEST_TAG, str(generation), opponent),
                            "fight_setup": self.cfg.fight_setup,
                        }
                    )
        if tasks:
            self.log("retest", generation=generation, count=len(tasks), games=self.cfg.retest_games)
            self._run_tasks(tasks)
        results = {
            name: {opponent: self.matches[f"{name}|{RETEST_TAG}{generation}:{opponent}"]["result"] for opponent in self.opponents}
            for name in candidates
        }
        scores = {name: retest_fitness(rows) for name, rows in results.items()}
        tests = sum(len(line["top"]) for line in lines.values() if line["control"])
        credits: dict[str, dict] = {}
        chosen: dict[str, str] = {}
        for founder, line in lines.items():
            control = line["control"]
            best = control if control and scores[control] >= scores[line["parent"]] else line["parent"]
            if control:
                for child in line["top"]:
                    credits[child] = credit_child(results[child], results[control], tests)
                    if credits[child]["credited"] and scores[child] > scores[best]:
                        best = child
            chosen[founder] = best
        write_json(
            self.gen_dir(generation) / "retest.json",
            {
                "generation": generation,
                "games": self.cfg.retest_games,
                "parents": chosen,
                "lines": lines,
                "credits": credits,
                "members": {
                    name: {
                        "fitness": round(scores[name], 4),
                        "bars": requirement_bars(results[name]),
                        "opponents": results[name],
                    }
                    for name in candidates
                },
            },
        )
        self.log("parents chosen", generation=generation, parents=chosen, credited=[k for k, v in credits.items() if v["credited"]])
        return chosen, credits

    def _named_results(self, member: str) -> dict[str, dict]:
        out = {}
        for opponent in self.opponents:
            row = self.matches.get(f"{member}|{SCRIPTED_TAG}{opponent}")
            if row is not None:
                out[opponent] = row["result"]
        return out

    def _write_weight_report(self, generation: int, names: list[str], credits: dict[str, dict]) -> None:
        """Record what each child changed and how it moved, then refresh the summary of all children."""
        rows = []
        for name in names:
            member = self.state["members"][name]
            if member["generation"] != generation or member["parent"] is None:
                continue
            row = {
                "id": name,
                "parent": member["parent"],
                "generation": generation,
                "control": not member["changes"],
                "changes": member["changes"],
                "credit": credits.get(name),
                "opponents": child_moves(self._named_results(name), self._named_results(member["parent"])),
            }
            rows.append(row)
            self.log("child moved", **row)
        if generation > 0:
            write_json(self.gen_dir(generation) / "weights.json", rows)
        everyone = []
        for path in sorted(self.root.glob("gen-*/weights.json")):
            everyone.extend(json.loads(path.read_text()))
        write_json(self.root / "weight_effects.json", weight_effects(everyone))

    def _retire(self, member: str, reason: str) -> None:
        self.state["members"][member]["status"] = "retired"
        self.state["members"][member]["reason"] = reason
        folder = self.folder(member) / FIGHTER
        for name in ("final.pt", "start.pt", "checkpoint.pkl"):
            (folder / name).unlink(missing_ok=True)
        self.log("retired", id=member, reason=reason)

    def _reject_farm(self, member: str) -> None:
        row = self.state["members"][member]
        row["farm"] = True
        self.log("farm confirmed", id=member, parent=row["parent"], changes=row["changes"])
        self._retire(member, "confirmed reward farm")

    def breed(self) -> None:
        """Write the plan of this generation once, then build each child."""
        generation = self.state["generation"]
        plan_path = self.gen_dir(generation) / "plan.json"
        if plan_path.exists():
            plan = json.loads(plan_path.read_text())
        else:
            plan = self._plan_children(generation)
            write_json(plan_path, plan)
        for child in plan["children"]:
            if child["id"] not in self.state["members"]:
                self._build_child(child, generation)
        self.state["phase"] = "train"
        self.save()

    def _plan_children(self, generation: int) -> dict:
        cfg = self.cfg
        chosen = set(self.state["line_parents"].values())
        ranking = [name for name in self.state["ranking"] if self.state["members"][name]["status"] == "alive"]
        parents = [name for name in ranking if name in chosen][: cfg.n_parents]
        rng = np.random.default_rng([cfg.seed, generation])
        order = [MUTABLE[int(item)] for item in rng.permutation(len(MUTABLE))] if cfg.changes == 1 else []
        shares = [cfg.children // len(parents) + int(line < cfg.children % len(parents)) for line in range(len(parents))]
        assigned = [(parent, slot) for parent, share in zip(parents, shares) for slot in range(share)]
        children = []
        changed = 0
        for index, (parent, slot) in enumerate(assigned):
            row = self.state["members"][parent]
            if slot < cfg.controls:
                reward, changes = dict(row["reward"]), {}
            else:
                keys = (order[changed % len(order)],) if order else None
                changed += 1
                reward, changes = mutate_reward(row["plan"], row["reward"], rng, cfg.changes, cfg.change_scale, keys)
            children.append(
                {
                    "id": f"g{generation:02d}-{index:02d}",
                    "parent": parent,
                    "founder": row["founder"],
                    "plan": row["plan"],
                    "reward": reward,
                    "changes": changes,
                    "seed": cfg.seed * 1000 + generation * 100 + index,
                    "noise_seed": int(rng.integers(0, 2**31)),
                }
            )
        return {"generation": generation, "parents": parents, "children": children}

    def _build_child(self, child: dict, generation: int) -> None:
        cfg = self.cfg
        parent_dir = self.folder(child["parent"])
        build = self.members_dir / f".build-{child['id']}"
        shutil.rmtree(build, ignore_errors=True)
        (build / FIGHTER).mkdir(parents=True)
        campaign = uuid.uuid4().hex
        meta = json.loads((parent_dir / FIGHTER / "policy.json").read_text())
        _copy_experts(parent_dir, build, meta.get("experts") or {}, campaign, child["parent"])
        weights = add_weight_noise(
            starting_weights(parent_dir), cfg.weight_noise, np.random.default_rng(child["noise_seed"])
        )
        torch.save({"model": weights}, build / FIGHTER / "start.pt")
        config = CampaignConfig(
            seed=child["seed"],
            n_envs=cfg.n_envs,
            n_steps=cfg.n_steps,
            batch_size=cfg.batch_size,
            fighter_steps=cfg.child_steps,
            checkpoint_every=cfg.checkpoint_every,
            snapshot_every=cfg.snapshot_every,
            plan=child["plan"],
            id=campaign,
            arena=True,
            reward=child["reward"],
            fight_setup=cfg.fight_setup,
        )
        write_json(build / "campaign.json", asdict(config))
        record = {
            "id": child["id"],
            "generation": generation,
            "parent": child["parent"],
            "founder": child["founder"],
            "plan": child["plan"],
            "reward": child["reward"],
            "changes": child["changes"],
            "weight_noise": cfg.weight_noise,
            "seed": child["seed"],
            "status": "training",
        }
        self._install(build, child["id"], record)
        self.save()
        self.log("child", generation=generation, id=child["id"], parent=child["parent"], changes=child["changes"])

    def _child_runtime(self, rivals: list[str]) -> Runtime:
        """Return the settings of one child process."""
        rt = self.rt
        return Runtime(
            max_rss_gb=rt.max_rss_gb,
            min_free_gb=rt.min_free_gb,
            fighter_device=rt.device,
            threads=rt.threads,
            workers=0,
            parent=os.getpid(),
            max_rollouts=rt.max_rollouts,
            rivals=rivals,
        )

    def _spawn(self, member: str, rivals: list[str]) -> subprocess.Popen:
        rt = self.rt
        runtime = self._child_runtime(rivals)
        env = dict(os.environ)
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
        env.update({name: str(rt.threads) for name in THREAD_VARS})
        folder = self.folder(member)
        command = [sys.executable, "-m", "fighter.campaign", "role", FIGHTER, "--out", str(folder)]
        command += ["--runtime", json.dumps(asdict(runtime))]
        with (folder / FIGHTER / "log.txt").open("ab") as log:
            return subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=env)

    def _rival_paths(self) -> list[str]:
        ranking = [name for name in self.state.get("ranking", []) if self.state["members"][name]["status"] == "alive"]
        frozen = self.frozen()
        ranked = ranking[: min(self.cfg.rivals, MAX_RIVALS - len(frozen))]
        return [str(self.folder(name)) for name in ranked + frozen]

    def _finished(self, member: str) -> bool:
        try:
            status = json.loads((self.folder(member) / FIGHTER / "status.json").read_text())
        except (OSError, ValueError):
            return False
        return status.get("state") == "done" and status.get("steps", 0) >= self.cfg.child_steps

    def _seal(self, member: str) -> None:
        """Keep the trained weights in a small file and drop the bulky checkpoint.

        A child with a confirmed farm is retired here and never reaches the ranking.
        """
        if farm_confirmed(self.folder(member)):
            self._reject_farm(member)
            self.save()
            return
        folder = self.folder(member) / FIGHTER
        weights = starting_weights(self.folder(member))
        write_buffer = io.BytesIO()
        torch.save({"model": weights}, write_buffer)
        write_atomic(folder / "final.pt", write_buffer.getvalue())
        (folder / "checkpoint.pkl").unlink(missing_ok=True)
        (folder / "start.pt").unlink(missing_ok=True)
        self.state["members"][member]["status"] = "alive"
        self.save()

    def _fail(self, member: str, reason: str) -> None:
        self.state["members"][member]["status"] = "failed"
        self.state["members"][member]["reason"] = reason
        self.save()
        self.log("child failed", id=member, reason=reason)

    def train_children(self) -> None:
        generation = self.state["generation"]
        plan = json.loads((self.gen_dir(generation) / "plan.json").read_text())
        queue = [c["id"] for c in plan["children"] if self.state["members"][c["id"]]["status"] == "training"]
        rivals = self._rival_paths()
        running: dict[str, subprocess.Popen] = {}
        restarts: dict[str, int] = {}
        busy: dict[str, int] = {}
        waiting_since: float | None = None
        last_start = -math.inf
        try:
            while queue or running:
                self.check_stop()
                for member, proc in list(running.items()):
                    code = proc.poll()
                    if code is None:
                        continue
                    del running[member]
                    if code == EXIT_DONE and self._finished(member):
                        self._seal(member)
                        self.log("child trained", id=member)
                        continue
                    if code == EXIT_BUSY and busy.get(member, 0) < MAX_BUSY_WAITS:
                        busy[member] = busy.get(member, 0) + 1
                        time.sleep(BUSY_WAIT_SECONDS)
                        queue.append(member)
                        continue
                    if code == EXIT_MEMORY and free_memory_gb() < self.rt.min_free_gb + self.rt.max_rss_gb:
                        self.log("child waiting for memory", id=member, free_gb=round(free_memory_gb(), 2))
                        queue.append(member)
                        continue
                    restarts[member] = restarts.get(member, 0) + 1
                    self.log("child ended early", id=member, code=code, restart=restarts[member])
                    if self.rt.max_rollouts and code == EXIT_STOPPED:
                        raise Stopped
                    if restarts[member] > MAX_CHILD_RESTARTS:
                        self._fail(member, f"exit code {code}")
                    else:
                        queue.append(member)
                can_start = len(running) < max(self.rt.parallel, 1) and queue
                settled = not running or time.monotonic() - last_start >= START_GAP_SECONDS
                room = free_memory_gb() >= self.rt.min_free_gb + self.rt.max_rss_gb
                if can_start and settled and room and self.commit_free() >= self.rt.min_commit_gb + self.rt.max_rss_gb:
                    waiting_since = None
                    member = queue.pop(0)
                    if self._finished(member):
                        self._seal(member)
                        continue
                    last_start = time.monotonic()
                    running[member] = self._spawn(member, rivals)
                    commit = self.commit_free()
                    self.log(
                        "child started",
                        id=member,
                        rivals=[Path(path).name for path in rivals],
                        windows_free_gb=None if math.isinf(commit) else round(commit, 2),
                    )
                    continue
                if can_start and not running:
                    waiting_since = waiting_since or time.monotonic()
                    if time.monotonic() - waiting_since > MEMORY_WAIT_SECONDS:
                        self.log("waiting for memory timed out", free_gb=round(free_memory_gb(), 2))
                        raise Stopped
                time.sleep(POLL_SECONDS)
        except Stopped:
            self._stop_children(running)
            raise
        self.state["phase"] = "rank"
        self.save()

    def _stop_children(self, running: dict[str, subprocess.Popen]) -> None:
        for proc in running.values():
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
        deadline = time.monotonic() + STOP_WAIT_SECONDS
        for proc in running.values():
            try:
                proc.wait(timeout=max(deadline - time.monotonic(), 0.1))
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


def play_task(task: dict) -> dict:
    """Play one match in this process and return its result row."""
    torch.set_num_threads(1)
    members = Path(task["root"]) / "members"
    first = load_rival(members / task["a"], task["a"])
    games = int(task["games"])
    setup = task.get("fight_setup", "standard")
    if "scripted" in task:
        row = measure(
            first.policy,
            task["scripted"],
            first.interface(),
            PLANS[first.plan],
            task["seed"],
            n_envs=games,
            games_per_arena=1,
            fight_setup=setup,
        )
        wins = round(row["win_rate"] * row["games"])
        draws = round(row["draw_rate"] * row["games"])
        result = rates(wins, draws, row["games"] - wins - draws)
        result["behaviour"] = {
            key: value for key, value in row.items() if key not in ("opponent", "games", "win_rate", "draw_rate", "loss_rate")
        }
    else:
        second = load_rival(members / task["b"], task["b"])
        half = max(games // 2, 1)
        one = measure(
            first.policy,
            task["b"],
            first.interface(),
            PLANS[first.plan],
            task["seed"],
            n_envs=half,
            games_per_arena=1,
            rival=second,
            fight_setup=setup,
        )
        two = measure(
            second.policy,
            task["a"],
            second.interface(),
            PLANS[second.plan],
            task["seed"] + 7,
            n_envs=half,
            games_per_arena=1,
            rival=first,
            fight_setup=setup,
        )
        wins = round(one["win_rate"] * one["games"]) + round(two["loss_rate"] * two["games"])
        losses = round(one["loss_rate"] * one["games"]) + round(two["win_rate"] * two["games"])
        draws = one["games"] + two["games"] - wins - losses
        result = rates(wins, draws, losses)
    return {"key": task["key"], "result": result}


class DriverLock:
    """Keeps a second driver out of one evolution folder."""

    def __init__(self, root: Path):
        self.handle = open(root / "lock", "a+")
        fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def release(self) -> None:
        fcntl.flock(self.handle, fcntl.LOCK_UN)
        self.handle.close()


def prepare(root: Path, given: dict) -> EvolveConfig:
    """Create the settings, or check given ones against the saved evolution."""
    path = root / "evolve.json"
    if path.exists():
        cfg = EvolveConfig(**json.loads(path.read_text()))
        for key, value in given.items():
            if key == "generations":
                cfg.generations = int(value)
            elif getattr(cfg, key) != value:
                raise SystemExit(f"{key} is fixed for this evolution at {getattr(cfg, key)!r}")
    else:
        if not given.get("parents"):
            raise SystemExit("--parents is required for a new evolution")
        cfg = EvolveConfig(**given)
        if cfg.fight_setup not in FIGHT_SETUPS:
            raise SystemExit(f"unknown fight setup {cfg.fight_setup!r}, expected one of {sorted(FIGHT_SETUPS)}")
        if cfg.plan and cfg.plan not in PLANS:
            raise SystemExit(f"unknown plan {cfg.plan!r}, expected one of {sorted(PLANS)}")
        needed = PLANS[cfg.plan].fight_setup if cfg.plan else None
        if needed and cfg.fight_setup != needed:
            raise SystemExit(f"plan {cfg.plan} plays in the fight setup {needed}")
        if cfg.n_parents < 1 or cfg.population < cfg.n_parents or cfg.children < 1:
            raise SystemExit("need at least one parent, one child and a population of at least the parents")
    root.mkdir(parents=True, exist_ok=True)
    write_json(path, asdict(cfg))
    return cfg


def print_status(root: Path) -> None:
    """Print the latest ranking with the win rate against every named opponent."""
    state = json.loads((root / "state.json").read_text())
    print(f"generation {state['generation']}, phase {state['phase']}")
    reports = sorted(root.glob("gen-*/report.json"))
    if not reports:
        return
    report = json.loads(reports[-1].read_text())
    for row in report["table"]:
        flags = " ".join(flag for flag, on in (("draw-heavy", row["draw_heavy"]), ("farm", row["farm"])) if on)
        kept = "kept" if row["id"] in report["kept"] else "out"
        print(
            f"{row['id']} {kept} fitness {row['fitness']:.3f} floor {row['floor']:.3f} "
            f"required {row['required']:.3f} rating {row['rating']:.0f} {flags}".rstrip()
        )
        for bar, values in row["bars"].items():
            print(f"  bar {bar:32s} {values['value']:.3f} of {values['target']:.2f} {'met' if values['met'] else 'missed'}")
        for name, result in row["opponents"].items():
            disables = (result.get("behaviour") or {}).get("shield_disables", 0.0)
            print(
                f"  {name:13s} win {result['win']:.3f} draw {result['draw']:.3f} loss {result['loss']:.3f} "
                f"of {result['games']} disables {disables:.2f}"
            )
        for name, result in row["rivals"].items():
            print(f"  vs {name:9s} win {result['win']:.3f} draw {result['draw']:.3f} loss {result['loss']:.3f} of {result['games']}")
        for name, result in row.get("frozen_rivals", {}).items():
            print(f"  vs frozen {name:6s} win {result['win']:.3f} draw {result['draw']:.3f} loss {result['loss']:.3f} of {result['games']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fighter evolve", description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("run", help="start or continue an evolution")
    p.add_argument("--out", required=True)
    p.add_argument("--parents", default=None, help="comma separated run folders")
    p.add_argument("--frozen", default=None, help="comma separated run folders played as frozen rivals")
    for item in fields(EvolveConfig):
        if item.name in ("parents", "frozen", "fight_setup", "plan"):
            continue
        kind = float if item.type == "float" else int
        p.add_argument("--" + item.name.replace("_", "-"), type=kind, default=None)
    p.add_argument("--fight-setup", choices=sorted(FIGHT_SETUPS), default=None, help="the kit and arena to train and test in")
    p.add_argument("--plan", choices=sorted(PLANS), default=None, help="train every founder and child under this plan")
    p.add_argument("--parallel", type=int, default=None, help="children trained at once")
    p.add_argument("--rank-parallel", type=int, default=None, help="worker processes for ranking matches, 1 plays them in the driver")
    p.add_argument("--threads", type=int, default=None)
    p.add_argument("--max-rss-gb", type=float, default=None)
    p.add_argument("--min-free-gb", type=float, default=None)
    p.add_argument("--device", default=None)
    p.add_argument("--max-rollouts", type=int, default=None, help="stop each child after this many rollouts, for tests")
    p.add_argument("--min-disk-gb", type=float, default=None, help="stop cleanly when the disk has less free space")
    p.add_argument("--disk-path", default=None, help="a path on the disk that --min-disk-gb watches")
    p.add_argument("--min-commit-gb", type=float, default=None, help="stop cleanly below this much free Windows commit memory")
    for name, text in (("status", "print the latest ranking"), ("stop", "stop the driver and its children cleanly")):
        p = commands.add_parser(name, help=text)
        p.add_argument("--out", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.out)
    if args.command == "status":
        print_status(root)
        return 0
    if args.command == "stop":
        (root / "STOP").touch()
        print(f"stop requested in {root}")
        return 0
    given = {}
    for item in fields(EvolveConfig):
        value = getattr(args, item.name, None)
        if value is not None:
            given[item.name] = value
    for key in ("parents", "frozen"):
        if isinstance(given.get(key), str):
            given[key] = [str(Path(path.strip()).resolve()) for path in given[key].split(",") if path.strip()]
    root.mkdir(parents=True, exist_ok=True)
    cfg = prepare(root, given)
    rt = EvolveRuntime()
    for item in fields(EvolveRuntime):
        value = getattr(args, item.name, None)
        if value is not None:
            setattr(rt, item.name, value)
    try:
        lock = DriverLock(root)
    except BlockingIOError:
        print(f"another driver is running in {root}")
        return EXIT_BUSY
    (root / "STOP").unlink(missing_ok=True)
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    _SIGNALLED["stop"] = False
    try:
        return Evolution(root, cfg, rt).run()
    finally:
        lock.release()


__all__ = [
    "DRAW_COST",
    "REQUIRED",
    "EvolveConfig",
    "EvolveRuntime",
    "Evolution",
    "fit_ratings",
    "is_draw_heavy",
    "keep_best",
    "main",
    "matchup_score",
    "mutate_reward",
    "rank_members",
    "requirement_bars",
    "requirement_score",
    "child_moves",
    "credit_child",
    "keep_parents",
    "retest_fitness",
    "sized_change",
    "weight_effects",
    "worst_share",
]


if __name__ == "__main__":
    raise SystemExit(main())
