"""A lean masked PPO trainer that keeps tensors on the device and runs large arena batches.

Input size and action heads are read from the environment. Simulator batches run in this
process or in worker processes that exchange arrays with one learner through shared memory.
"""

from __future__ import annotations

import json
import math
import multiprocessing as mp
import os
import pickle
import shutil
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from multiprocessing.shared_memory import SharedMemory
from pathlib import Path

import numpy as np
import torch
from torch import nn

from . import constants as C
from .drills import DRILLS
from .env import ArenaVecEnv, RewardConfig
from .experts import expert_interface
from .interface import Interface
from .opponents import LEAGUE, MAX_SNAPSHOTS, OpponentPool, swinger
from .policy import NumpyPolicy
from .sim import SimConfig
from .plans import PLANS
from .train import CURRICULUM, MAX_TICKS, Stage, limit_threads, peak_rss_gb

HUGE_NEGATIVE = -1e8
THREAD_VARS = ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS")
FIGHT = "fight"


FLOOR_GAMES = 30
ADAPT_EVERY = 200_000


@dataclass
class LeanConfig:
    """Settings of one lean training run. `n_envs` counts arenas per simulator process.

    Keep arenas times workers times steps near 6,144 decisions per update. Rollouts of 16,384
    decisions do not learn the crossbow drill.
    """

    out: str = "runs/lean"
    total_steps: int = 30_000_000
    n_envs: int = 192
    n_steps: int = 32
    batch_size: int = 1024
    n_epochs: int = 4
    learning_rate: float = 3e-4
    gamma: float = 0.995
    gae_lambda: float = 0.95
    clip_range: float = 0.2
    ent_coef: float = 0.01
    vf_coef: float = 0.5
    max_grad_norm: float = 0.5
    hidden: tuple[int, ...] = (256, 256)
    seed: int = 7
    device: str = "auto"
    workers: int = 0
    threads: int = 2
    stagger: bool = True
    snapshot_every: int = 250_000
    checkpoint_every: int = 250_000
    max_minutes: float = 0.0
    max_rss_gb: float = 2.0
    min_free_gb: float = 2.0
    stages: list[Stage] = field(default_factory=lambda: list(CURRICULUM))
    plan: str = "melee"
    adaptive: bool = False


def resolve_device(name: str) -> torch.device:
    """Pick the device. `auto` means CUDA when present and the CPU otherwise."""
    if name == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    return torch.device(name)


def free_memory_gb() -> float:
    """Return the available system memory in gigabytes, or infinity when unknown."""
    try:
        with open("/proc/meminfo") as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1024**2
    except OSError:
        pass
    return math.inf


class ActorCritic(nn.Module):
    """Separate policy and value networks with one flat logit output."""

    def __init__(self, n_obs: int, n_logits: int, hidden: tuple[int, ...] = (256, 256)):
        super().__init__()
        self.pi = self._body(n_obs, hidden)
        self.vf = self._body(n_obs, hidden)
        self.action = nn.Linear(hidden[-1], n_logits)
        self.value = nn.Linear(hidden[-1], 1)
        for body in (self.pi, self.vf):
            for layer in body:
                if isinstance(layer, nn.Linear):
                    self._init(layer, math.sqrt(2.0))
        self._init(self.action, 0.01)
        self._init(self.value, 1.0)

    @staticmethod
    def _body(n_obs: int, hidden: tuple[int, ...]) -> nn.Sequential:
        layers: list[nn.Module] = []
        size = n_obs
        for width in hidden:
            layers += [nn.Linear(size, width), nn.ReLU()]
            size = width
        return nn.Sequential(*layers)

    @staticmethod
    def _init(layer: nn.Linear, gain: float) -> None:
        nn.init.orthogonal_(layer.weight, gain=gain)
        nn.init.zeros_(layer.bias)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        return self.action(self.pi(x)), self.value(self.vf(x)).squeeze(-1)

    def values(self, x: torch.Tensor) -> torch.Tensor:
        return self.value(self.vf(x)).squeeze(-1)

    def to_policy(self) -> NumpyPolicy:
        """Copy the actor into the array format used for evaluation and the league."""
        modules = [m for m in self.pi if isinstance(m, nn.Linear)] + [self.action]
        return NumpyPolicy(
            [
                (m.weight.detach().cpu().numpy().copy(), m.bias.detach().cpu().numpy().copy())
                for m in modules
            ]
        )


def masked_log_softmax(
    logits: torch.Tensor, masks: torch.Tensor, sizes: list[int]
) -> list[torch.Tensor]:
    """Return one masked log softmax per action head."""
    return [
        torch.log_softmax(torch.where(mask, part, HUGE_NEGATIVE), dim=1)
        for part, mask in zip(logits.split(sizes, dim=1), masks.split(sizes, dim=1))
    ]


def sample_heads(parts: list[torch.Tensor]) -> torch.Tensor:
    """Draw one action per head with Gumbel noise."""
    picks = []
    for part in parts:
        noise = torch.rand_like(part).clamp_(min=1e-10)
        picks.append((part - torch.log(-torch.log(noise))).argmax(dim=1))
    return torch.stack(picks, dim=1)


def log_prob(parts: list[torch.Tensor], actions: torch.Tensor) -> torch.Tensor:
    """Sum the log probability of the chosen action over the heads."""
    total = 0.0
    for head, part in enumerate(parts):
        total = total + part.gather(1, actions[:, head : head + 1]).squeeze(1)
    return total


def entropy(parts: list[torch.Tensor], masks: torch.Tensor, sizes: list[int]) -> torch.Tensor:
    """Sum the entropy of the allowed actions over the heads."""
    total = 0.0
    for part, mask in zip(parts, masks.split(sizes, dim=1)):
        total = total - torch.where(mask, part.exp() * part, 0.0).sum(dim=1)
    return total


def compute_advantages(
    rewards: torch.Tensor, values: torch.Tensor, dones: torch.Tensor, gamma: float, lam: float
) -> torch.Tensor:
    """Return generalized advantages. `values` holds one more step than `rewards`."""
    advantages = torch.zeros_like(rewards)
    last = torch.zeros_like(rewards[0])
    for t in reversed(range(len(rewards))):
        alive = 1.0 - dones[t]
        delta = rewards[t] + gamma * values[t + 1] * alive - values[t]
        last = delta + gamma * lam * alive * last
        advantages[t] = last
    return advantages


class LeaguePool(OpponentPool):
    """An opponent pool whose league arenas read actions planned in one outside batch."""

    def __init__(
        self, n: int, seed: int = 0, max_ticks: int = MAX_TICKS, interface: Interface | None = None
    ):
        super().__init__(n, seed=seed, max_ticks=max_ticks, interface=interface)
        self.planned: np.ndarray | None = None

    def league_arenas(self) -> np.ndarray:
        """Return the arenas whose opponent is a stored policy."""
        if not self.snapshots or LEAGUE not in self.names:
            return np.empty(0, dtype=np.int64)
        league = self.names.index(LEAGUE)
        return np.flatnonzero((self.assigned == league) & (self.snapshot_of >= 0))

    def _act_league(self, sim, seat, rows, out, facts) -> None:
        if self.planned is None:
            super()._act_league(sim, seat, rows, out, facts)
            return
        fallback = rows[self.snapshot_of[rows] < 0]
        if len(fallback):
            out[fallback] = swinger(sim, seat, self.rng, facts, fallback)
        chosen = rows[self.snapshot_of[rows] >= 0]
        if len(chosen):
            out[chosen] = self.planned[chosen]


class League:
    """Past policies evaluated in one batch on the learner device."""

    def __init__(self, sizes: list[int], device: torch.device):
        self.sizes = sizes
        self.device = device
        self.members: list[list[tuple[torch.Tensor, torch.Tensor]]] = []

    def add(self, policy: NumpyPolicy) -> None:
        if len(self.members) == MAX_SNAPSHOTS:
            self.members.pop(0)
        self.members.append(
            [
                (torch.from_numpy(w).to(self.device), torch.from_numpy(b).to(self.device))
                for w, b in policy.layers
            ]
        )

    @torch.no_grad()
    def act(self, obs: torch.Tensor, masks: torch.Tensor, ids: torch.Tensor) -> torch.Tensor:
        """Return sampled actions for arenas that play stored policies."""
        out = torch.zeros(len(obs), len(self.sizes), dtype=torch.long, device=self.device)
        for snapshot in ids.unique().tolist():
            pick = (ids == snapshot).nonzero().squeeze(1)
            x = obs[pick]
            layers = self.members[snapshot]
            for weight, bias in layers[:-1]:
                x = torch.relu(x @ weight.T + bias)
            weight, bias = layers[-1]
            parts = masked_log_softmax(x @ weight.T + bias, masks[pick], self.sizes)
            out[pick] = sample_heads(parts)
        return out


@dataclass(frozen=True)
class EnvSpec:
    """What one simulator process should build."""

    task: str
    n_envs: int
    seed: int
    takeover: bool = False
    plan: str = "melee"

    def build(self) -> ArenaVecEnv:
        if self.task == FIGHT:
            plan = PLANS[self.plan]
            interface = expert_interface(MAX_TICKS, stance=plan.stance) if self.takeover else None
            pool = LeaguePool(self.n_envs, seed=self.seed + 1, max_ticks=MAX_TICKS, interface=interface)
            return ArenaVecEnv(
                self.n_envs,
                pool,
                SimConfig(ready_gate=plan.ready_gate),
                RewardConfig(**plan.reward),
                max_ticks=MAX_TICKS,
                seed=self.seed,
                interface=interface,
            )
        return DRILLS[self.task][0](self.n_envs, seed=self.seed)


def pack_env(env: ArenaVecEnv) -> bytes:
    """Serialize the full state of an environment, without its interfaces."""
    interfaces = env.interface, env.pool.interface
    env.interface = env.pool.interface = None
    try:
        return pickle.dumps(env.__dict__, protocol=5)
    finally:
        env.interface, env.pool.interface = interfaces


def unpack_env(env: ArenaVecEnv, blob: bytes) -> None:
    """Restore a state from `pack_env` in place, keeping the live interfaces."""
    interfaces = env.interface, env.pool.interface
    saved = pickle.loads(blob)
    env.__dict__.clear()
    env.__dict__.update(saved)
    env.interface, env.pool.interface = interfaces


class ArenaSlot:
    """One simulator batch that reads and writes fixed arrays."""

    def __init__(self, spec: EnvSpec, views: dict[str, np.ndarray], stagger: bool):
        self.env = spec.build()
        self.views = views
        self.stagger = stagger
        self.rng = np.random.default_rng(spec.seed + 5)
        self.arenas = np.empty(0, dtype=np.int64)
        if isinstance(self.env.pool, LeaguePool):
            self.env.pool.planned = np.zeros_like(views["actions"])

    def _publish(self, obs: np.ndarray) -> None:
        self.views["obs"][:] = obs
        self.views["masks"][:] = self.env.action_masks()

    def reset(self) -> None:
        env = self.env
        env.reset()
        if self.stagger:
            step = C.TICKS_PER_DECISION
            env.sim.ticks[:] = self.rng.integers(0, env.max_ticks // step, env.num_envs) * step
        self._publish(env.observe())

    def plan(self) -> int:
        """Write the inputs of league opponents and return how many there are."""
        pool = self.env.pool
        if not isinstance(pool, LeaguePool):
            return 0
        self.arenas = pool.league_arenas()
        count = len(self.arenas)
        if count:
            sim = self.env.sim
            seen = pool.interface.observe(sim, 1, pool.max_ticks, self.arenas)
            self.views["opp_obs"][:count] = np.clip(seen, -5.0, 5.0)
            self.views["opp_masks"][:count] = pool.interface.masks(sim, 1, pool.allowed, rows=self.arenas)
            self.views["opp_ids"][:count] = pool.snapshot_of[self.arenas]
        return count

    def step(self) -> None:
        env = self.env
        if len(self.arenas):
            env.pool.planned[self.arenas] = self.views["opp_actions"][: len(self.arenas)]
        env.step_async(self.views["actions"])
        obs, reward, done, infos = env.step_wait()
        self.views["rewards"][:] = reward
        self.views["dones"][:] = done
        self.views["truncated"][:] = False
        for arena in np.flatnonzero(done):
            info = infos[arena]
            self.views["terminal"][arena] = info["terminal_observation"]
            self.views["truncated"][arena] = bool(info.get("TimeLimit.truncated", False))
        self._publish(obs)

    def set_stage(
        self, mix: dict[str, float], shaping: float, clear: bool, weapons: tuple[int, ...] | None = None
    ) -> None:
        self.env.reward_cfg.shaping = shaping
        self.env.set_weapons(weapons)
        self.env.pool.set_mix(mix)
        if clear:
            self.env.results.clear()

    def add_snapshot(self, policy: NumpyPolicy) -> None:
        self.env.pool.add_snapshot(policy)

    def set_experts(self, loaded: dict) -> None:
        """Swap the active experts and refresh the masks the next decision will read."""
        experts = getattr(self.env.interface, "experts", None)
        if experts is not None:
            experts.install(loaded)
            self.views["masks"][:] = self.env.action_masks()

    def get_state(self) -> bytes:
        """Return everything needed to continue this batch exactly."""
        return pickle.dumps(
            {
                "env": pack_env(self.env),
                "rng": self.rng,
                "arenas": self.arenas,
                "obs": np.array(self.views["obs"]),
                "masks": np.array(self.views["masks"]),
            },
            protocol=5,
        )

    def set_state(self, blob: bytes) -> None:
        """Continue from a state written by `get_state`."""
        saved = pickle.loads(blob)
        unpack_env(self.env, saved["env"])
        self.rng = saved["rng"]
        self.arenas = saved["arenas"]
        self.views["obs"][:] = saved["obs"]
        self.views["masks"][:] = saved["masks"]

    def farm_tally(self) -> dict:
        """Return and clear the reward term sums of the episodes finished in this batch."""
        return self.env.farm_tally()

    def rates(self) -> dict[str, tuple[int, int]]:
        """Return the recent wins and games against each opponent."""
        out: dict[str, tuple[int, int]] = {}
        for name, outcome in self.env.results:
            wins, games = out.get(name, (0, 0))
            out[name] = (wins + int(outcome > 0), games + 1)
        return out

    def stats(self) -> tuple[int, int, float]:
        results = self.env.results
        wins = sum(1 for _, outcome in results if outcome > 0)
        return wins, len(results), peak_rss_gb()


def _worker(conn, blocks: dict, spec: EnvSpec, start: int, stagger: bool) -> None:
    torch.set_num_threads(1)
    shared = {key: SharedMemory(name=name) for key, (name, _, _) in blocks.items()}
    try:
        views = {
            key: np.ndarray(shape, dtype=dtype, buffer=shared[key].buf)[start : start + spec.n_envs]
            for key, (_, shape, dtype) in blocks.items()
        }
        slot = ArenaSlot(spec, views, stagger)
        conn.send("ready")
        while True:
            name, args = conn.recv()
            if name == "close":
                break
            conn.send(getattr(slot, name)(*args))
    except (EOFError, KeyboardInterrupt):
        pass
    finally:
        views = {}
        slot = None
        for block in shared.values():
            try:
                block.close()
            except BufferError:
                pass


class Host:
    """Runs all simulator batches and exposes their joined arrays."""

    def __init__(
        self, task: str, n_envs: int, workers: int, seed: int, stagger: bool, takeover: bool = False, plan: str = "melee"
    ):
        probe = EnvSpec(task, 1, seed, takeover, plan).build()
        self.n_obs = int(np.prod(probe.observation_space.shape))
        self.sizes = [int(n) for n in probe.action_space.nvec]
        self.max_ticks = int(probe.max_ticks)
        del probe
        self.parts = max(workers, 1)
        self.n_each = n_envs
        self.total = n_envs * self.parts
        n_logits = sum(self.sizes)
        n_heads = len(self.sizes)
        layout = {
            "obs": ((self.total, self.n_obs), np.float32),
            "masks": ((self.total, n_logits), np.bool_),
            "actions": ((self.total, n_heads), np.int64),
            "rewards": ((self.total,), np.float32),
            "dones": ((self.total,), np.bool_),
            "truncated": ((self.total,), np.bool_),
            "terminal": ((self.total, self.n_obs), np.float32),
            "opp_obs": ((self.total, self.n_obs), np.float32),
            "opp_masks": ((self.total, n_logits), np.bool_),
            "opp_actions": ((self.total, n_heads), np.int64),
            "opp_ids": ((self.total,), np.int64),
        }
        self.blocks: list[SharedMemory] = []
        self.conns: list = []
        self.procs: list = []
        self.local: ArenaSlot | None = None
        if workers <= 0:
            self.views = {key: np.zeros(shape, dtype=dtype) for key, (shape, dtype) in layout.items()}
            self.local = ArenaSlot(EnvSpec(task, n_envs, seed, takeover, plan), self.views, stagger)
            return
        names = {}
        self.views = {}
        for key, (shape, dtype) in layout.items():
            size = int(np.prod(shape)) * np.dtype(dtype).itemsize
            block = SharedMemory(create=True, size=size)
            self.blocks.append(block)
            names[key] = (block.name, shape, np.dtype(dtype).str)
            self.views[key] = np.ndarray(shape, dtype=dtype, buffer=block.buf)
        context = mp.get_context("spawn")
        saved = {name: os.environ.get(name) for name in THREAD_VARS}
        os.environ.update({name: "1" for name in THREAD_VARS})
        try:
            for i in range(workers):
                ours, theirs = context.Pipe()
                spec = EnvSpec(task, n_envs, seed + 100_003 * i, takeover, plan)
                proc = context.Process(
                    target=_worker, args=(theirs, names, spec, i * n_envs, stagger), daemon=True
                )
                proc.start()
                theirs.close()
                self.conns.append(ours)
                self.procs.append(proc)
        finally:
            for name, value in saved.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
        for conn in self.conns:
            conn.recv()

    def call(self, name: str, *args) -> list:
        """Run one slot method on every simulator batch and collect the results."""
        if self.local is not None:
            return [getattr(self.local, name)(*args)]
        for conn in self.conns:
            conn.send((name, args))
        return [conn.recv() for conn in self.conns]

    def call_each(self, name: str, values: list) -> list:
        """Run one slot method with a different argument on each simulator batch."""
        if self.local is not None:
            return [getattr(self.local, name)(values[0])]
        for conn, value in zip(self.conns, values):
            conn.send((name, (value,)))
        return [conn.recv() for conn in self.conns]

    def close(self) -> None:
        for conn in self.conns:
            try:
                conn.send(("close", ()))
            except (BrokenPipeError, OSError):
                pass
        for proc in self.procs:
            proc.join(timeout=5.0)
            if proc.is_alive():
                proc.terminate()
                proc.join(timeout=2.0)
        for conn in self.conns:
            conn.close()
        self.conns, self.procs = [], []
        self.views = {}
        for block in self.blocks:
            try:
                block.close()
            except BufferError:
                pass
            block.unlink()
        self.blocks = []


class LeanTrainer:
    """Collects rollouts, runs PPO updates and manages the curriculum and the league."""

    def __init__(
        self, cfg: LeanConfig, task: str = FIGHT, resume: bool = False, takeover: bool = False
    ):
        self.cfg = cfg
        self.task = task
        limit_threads(cfg.threads)
        torch.manual_seed(cfg.seed)
        self.device = resolve_device(cfg.device)
        self.out = Path(cfg.out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.log_path = self.out / "progress.jsonl"
        self.host = Host(task, cfg.n_envs, cfg.workers, cfg.seed, cfg.stagger, takeover, cfg.plan)
        self.sizes = self.host.sizes
        self.total_envs = self.host.total
        dev = self.device
        self.model = ActorCritic(self.host.n_obs, sum(self.sizes), tuple(cfg.hidden)).to(dev)
        self.optimizer = torch.optim.Adam(self.model.parameters(), lr=cfg.learning_rate, eps=1e-5)
        steps, n = cfg.n_steps, self.total_envs
        self.obs = torch.zeros(steps, n, self.host.n_obs, device=dev)
        self.masks = torch.zeros(steps, n, sum(self.sizes), dtype=torch.bool, device=dev)
        self.actions = torch.zeros(steps, n, len(self.sizes), dtype=torch.long, device=dev)
        self.logps = torch.zeros(steps, n, device=dev)
        self.values = torch.zeros(steps + 1, n, device=dev)
        self.rewards = torch.zeros(steps, n, device=dev)
        self.dones = torch.zeros(steps, n, device=dev)
        self.league = League(self.sizes, dev)
        self.steps = 0
        self.stage_index = 0
        self.stage_start = 0
        self.last_snapshot = 0
        self.last_checkpoint = 0
        self.last_adapt = 0
        self.stop_reason = ""
        self.started = time.monotonic()
        self.snapshots: list[NumpyPolicy] = []
        if resume and (self.out / "lean.pt").exists():
            self._load()
        if task == FIGHT:
            self._enter(self.stage_index, clear=False)
        self.host.call("reset")

    def _tensor(self, key: str) -> torch.Tensor:
        return torch.from_numpy(self.host.views[key])

    def _enter(self, index: int, clear: bool = True) -> None:
        self.stage_index = index
        stage = self.cfg.stages[index]
        self.host.call("set_stage", stage.mix, stage.shaping, clear, stage.weapons)
        if clear:
            self.stage_start = self.steps

    def add_snapshot(self) -> None:
        policy = self.model.to_policy()
        if len(self.snapshots) == MAX_SNAPSHOTS:
            self.snapshots.pop(0)
        self.snapshots.append(policy)
        self.league.add(policy)
        self.host.call("add_snapshot", policy)

    def _plan_league(self) -> None:
        counts = self.host.call("plan")
        if not any(counts):
            return
        views = self.host.views
        starts = [i * self.host.n_each for i in range(self.host.parts)]
        spans = [(start, start + count) for start, count in zip(starts, counts) if count]
        obs = torch.cat([torch.from_numpy(views["opp_obs"][a:b]) for a, b in spans]).to(self.device)
        masks = torch.cat([torch.from_numpy(views["opp_masks"][a:b]) for a, b in spans]).to(self.device)
        ids = torch.cat([torch.from_numpy(views["opp_ids"][a:b]) for a, b in spans]).to(self.device)
        chosen = self.league.act(obs, masks, ids).cpu().numpy()
        at = 0
        for a, b in spans:
            views["opp_actions"][a:b] = chosen[at : at + b - a]
            at += b - a

    @torch.no_grad()
    def collect(self) -> None:
        cfg = self.cfg
        for t in range(cfg.n_steps):
            obs, masks = self.obs[t], self.masks[t]
            obs.copy_(self._tensor("obs"))
            masks.copy_(self._tensor("masks"))
            logits, value = self.model(obs)
            parts = masked_log_softmax(logits, masks, self.sizes)
            chosen = sample_heads(parts)
            self.actions[t], self.logps[t], self.values[t] = chosen, log_prob(parts, chosen), value
            self.host.views["actions"][:] = chosen.cpu().numpy()
            if self.task == FIGHT and self.snapshots:
                self._plan_league()
            self.host.call("step")
            reward = self.rewards[t]
            reward.copy_(self._tensor("rewards"))
            self.dones[t].copy_(self._tensor("dones"))
            cut = self.host.views["truncated"]
            if cut.any():
                arenas = torch.from_numpy(np.flatnonzero(cut)).to(self.device)
                final = self._tensor("terminal").to(self.device)[arenas]
                reward[arenas] += cfg.gamma * self.model.values(final)
        self.values[cfg.n_steps] = self.model.values(self._tensor("obs").to(self.device))
        self.steps += cfg.n_steps * self.total_envs

    def update(self) -> dict[str, float]:
        cfg = self.cfg
        with torch.no_grad():
            advantages = compute_advantages(
                self.rewards, self.values, self.dones, cfg.gamma, cfg.gae_lambda
            )
            returns = (advantages + self.values[:-1]).flatten()
            advantages = advantages.flatten()
        obs = self.obs.flatten(0, 1)
        masks = self.masks.flatten(0, 1)
        actions = self.actions.flatten(0, 1)
        old_logps = self.logps.flatten()
        total = len(obs)
        policy_sum, value_sum, count = 0.0, 0.0, 0
        for _ in range(cfg.n_epochs):
            order = torch.randperm(total, device=self.device)
            for start in range(0, total, cfg.batch_size):
                index = order[start : start + cfg.batch_size]
                if len(index) < 2:
                    continue
                logits, value = self.model(obs[index])
                parts = masked_log_softmax(logits, masks[index], self.sizes)
                logp = log_prob(parts, actions[index])
                gain = advantages[index]
                gain = (gain - gain.mean()) / (gain.std() + 1e-8)
                ratio = torch.exp(logp - old_logps[index])
                clipped = ratio.clamp(1.0 - cfg.clip_range, 1.0 + cfg.clip_range)
                policy_loss = -torch.min(gain * ratio, gain * clipped).mean()
                value_loss = torch.mean((returns[index] - value) ** 2)
                loss = (
                    policy_loss
                    + cfg.vf_coef * value_loss
                    - cfg.ent_coef * entropy(parts, masks[index], self.sizes).mean()
                )
                self.optimizer.zero_grad(set_to_none=True)
                loss.backward()
                nn.utils.clip_grad_norm_(self.model.parameters(), cfg.max_grad_norm)
                self.optimizer.step()
                policy_sum += float(policy_loss.detach())
                value_sum += float(value_loss.detach())
                count += 1
        return {"policy_loss": policy_sum / max(count, 1), "value_loss": value_sum / max(count, 1)}

    def _opponent_rates(self) -> dict[str, tuple[int, int]]:
        total: dict[str, tuple[int, int]] = {}
        for part in self.host.call("rates"):
            for name, (wins, games) in part.items():
                old = total.get(name, (0, 0))
                total[name] = (old[0] + wins, old[1] + games)
        return total

    def _floors_met(self, stage: Stage) -> bool:
        """Return whether every named opponent meets its floor over enough recent games."""
        if not stage.floors:
            return True
        rates = self._opponent_rates()
        for name, floor in stage.floors.items():
            wins, games = rates.get(name, (0, 0))
            if games < FLOOR_GAMES or wins / games < floor:
                return False
        return True

    def _adapt_mix(self, stage: Stage) -> None:
        """Weight scripted opponents toward the ones the fighter beats least."""
        rates = self._opponent_rates()
        mix = dict(stage.mix)
        for name in mix:
            if name != LEAGUE and rates.get(name, (0, 0))[1]:
                wins, games = rates[name]
                mix[name] = (1.0 - wins / games) ** 2 + 0.05
        self.host.call("set_stage", mix, stage.shaping, False, stage.weapons)

    def _after_rollout(self) -> None:
        cfg = self.cfg
        rows = self.host.call("stats")
        wins = sum(row[0] for row in rows)
        games = sum(row[1] for row in rows)
        rss = max([peak_rss_gb()] + [row[2] for row in rows])
        rate = wins / games if games else 0.0
        stage_name = self.task
        if self.task == FIGHT:
            stage = cfg.stages[self.stage_index]
            stage_name = stage.name
            in_stage = self.steps - self.stage_start
            arena_ticks = in_stage / self.total_envs * C.TICKS_PER_DECISION
            last = self.stage_index == len(cfg.stages) - 1
            if (
                not last
                and games >= 100
                and rate >= stage.gate
                and in_stage >= stage.min_steps
                and arena_ticks >= self.host.max_ticks
                and self._floors_met(stage)
            ):
                self.add_snapshot()
                self._enter(self.stage_index + 1)
            elif last and cfg.adaptive and self.steps - self.last_adapt >= ADAPT_EVERY:
                self._adapt_mix(stage)
                self.last_adapt = self.steps
            if self.steps - self.last_snapshot >= cfg.snapshot_every:
                self.add_snapshot()
                self.last_snapshot = self.steps
        record = {
            "steps": self.steps,
            "stage": stage_name,
            "win_rate": round(rate, 4),
            "games": games,
            "league": len(self.snapshots),
            "minutes": round((time.monotonic() - self.started) / 60.0, 2),
            "rss_gb": round(rss, 3),
        }
        with self.log_path.open("a") as handle:
            handle.write(json.dumps(record) + "\n")
        if self.steps - self.last_checkpoint >= cfg.checkpoint_every:
            self.save()
            self.last_checkpoint = self.steps
        if cfg.max_minutes > 0 and (time.monotonic() - self.started) / 60.0 >= cfg.max_minutes:
            self.stop_reason = "time limit"
        elif rss > cfg.max_rss_gb or free_memory_gb() < cfg.min_free_gb:
            self.stop_reason = "memory limit"

    def run(self, hook: Callable[["LeanTrainer"], None] | None = None) -> dict:
        """Train until the step budget or a limit is reached and return a summary."""
        started = time.monotonic()
        first = self.steps
        try:
            while self.steps < self.cfg.total_steps and not self.stop_reason:
                self.collect()
                self.update()
                self._after_rollout()
                if hook is not None:
                    hook(self)
            self.save()
        finally:
            self.host.close()
        elapsed = time.monotonic() - started
        summary = {
            "steps": self.steps,
            "stage": self.cfg.stages[self.stage_index].name if self.task == FIGHT else self.task,
            "league": len(self.snapshots),
            "minutes": round(elapsed / 60.0, 2),
            "steps_per_second": round((self.steps - first) / max(elapsed, 1e-6), 1),
            "peak_rss_gb": round(peak_rss_gb(), 3),
            "device": str(self.device),
            "stopped_by": self.stop_reason or "step budget",
        }
        (self.out / "summary.json").write_text(json.dumps(summary, indent=2))
        config = asdict(self.cfg)
        config.pop("stages")
        (self.out / "config.json").write_text(json.dumps(config, indent=2))
        return summary

    def save(self) -> None:
        """Write the model, the policy, the league and the run state atomically."""
        target = self.out / "lean.pt"
        partial = self.out / "lean.pt.partial"
        torch.save(
            {"model": self.model.state_dict(), "optimizer": self.optimizer.state_dict()}, partial
        )
        os.replace(partial, target)
        partial_policy = self.out / "policy.partial.npz"
        self.model.to_policy().save(partial_policy)
        os.replace(partial_policy, self.out / "policy.npz")
        league = self.out / "league"
        fresh = self.out / "league.partial"
        shutil.rmtree(fresh, ignore_errors=True)
        fresh.mkdir()
        for i, snapshot in enumerate(self.snapshots):
            snapshot.save(fresh / f"{i:02d}.npz")
        shutil.rmtree(league, ignore_errors=True)
        os.replace(fresh, league)
        state = {
            "steps": self.steps,
            "stage": self.stage_index,
            "stage_start": self.stage_start,
            "last_snapshot": self.last_snapshot,
        }
        partial_state = self.out / "state.partial.json"
        partial_state.write_text(json.dumps(state))
        os.replace(partial_state, self.out / "state.json")

    def _load(self) -> None:
        saved = torch.load(self.out / "lean.pt", map_location=self.device)
        self.model.load_state_dict(saved["model"])
        self.optimizer.load_state_dict(saved["optimizer"])
        state = json.loads((self.out / "state.json").read_text())
        self.steps = state["steps"]
        self.stage_index = state["stage"]
        self.stage_start = state["stage_start"]
        self.last_snapshot = state["last_snapshot"]
        self.last_checkpoint = self.steps
        for path in sorted((self.out / "league").glob("*.npz")):
            policy = NumpyPolicy.load(path)
            self.snapshots.append(policy)
            self.league.add(policy)
            self.host.call("add_snapshot", policy)


def train_lean(
    cfg: LeanConfig,
    task: str = FIGHT,
    resume: bool = False,
    hook: Callable[[LeanTrainer], None] | None = None,
) -> dict:
    """Train the fight curriculum or one drill with the lean loop."""
    return LeanTrainer(cfg, task, resume).run(hook)


def train_lean_drill(cfg: LeanConfig, name: str, resume: bool = False) -> dict:
    """Train one drill and run its pass test."""
    summary = train_lean(cfg, name, resume=resume)
    policy = NumpyPolicy.load(Path(cfg.out) / "policy.npz")
    report = DRILLS[name][1](policy)
    report["train"] = summary
    (Path(cfg.out) / "report.json").write_text(json.dumps(report, indent=2))
    return report
