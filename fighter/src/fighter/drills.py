"""Skill drills for shooting and blocking, each with a held-out pass test."""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
from stable_baselines3.common.callbacks import BaseCallback

from . import actions as A
from . import arrows
from . import constants as C
from .env import ArenaVecEnv
from .evaluate import HELD_OUT_SEED, wilson_interval
from .obs import build_obs, intercept_angles, view_angles, wrap_degrees
from .opponents import OpponentPool, steer
from .policy import NumpyPolicy
from .sim import SimConfig
from .train import TrainConfig, build_model, limit_threads, peak_rss_gb

DRILL_TICKS = 300
DRILL_ARROWS = 10_000
SHOOT_PASS_RATE = 0.50
SHOOT_LEAD_MARGIN = 0.10
BLOCK_PASS_RATE = 0.85
BLOCK_MAX_UPTIME = 0.70
RAISE_WEIGHT = 0.3
DRILL_STEPS = 2_000_000
DRILL_MINUTES = 30.0
CHECK_EVERY = 100_000
DRILL_MAX_YAW = 45.0
DRILL_MAX_PITCH = 20.0
WIDE_TURNS = np.concatenate(
    [
        A.HEAD_OFFSETS[A.YAW] + np.flatnonzero(np.abs(A.YAW_DELTAS) > DRILL_MAX_YAW),
        A.HEAD_OFFSETS[A.PITCH] + np.flatnonzero(np.abs(A.PITCH_DELTAS) > DRILL_MAX_PITCH),
    ]
)


class DrillEnv(ArenaVecEnv):
    """A fixed-length arena where nobody can die."""

    locked_heads: tuple[tuple[int, int], ...] = ()
    goal_terms: tuple[str, ...] = ()

    def __init__(self, n_envs: int, sim_config: SimConfig, seed: int):
        pool = OpponentPool(n_envs, seed=seed + 1, max_ticks=DRILL_TICKS)
        pool.set_mix({"idle": 1.0})
        self.drill_rng = np.random.default_rng(seed + 2)
        super().__init__(n_envs, pool, sim_config, max_ticks=DRILL_TICKS, seed=seed)

    def action_masks(self) -> np.ndarray:
        mask = super().action_masks()
        for head, keep in self.locked_heads:
            start = A.HEAD_OFFSETS[head]
            mask[:, start : start + A.NVEC[head]] = False
            mask[:, start + keep] = True
        # The target stays in front, so drills leave out the turn steps over these limits.
        mask[:, WIDE_TURNS] = False
        single = self.allowed.sum(axis=1) == 1
        mask[single, A.HEAD_OFFSETS[A.WEAPON] + A.WEAPON_KEEP] = False
        return mask

    def _terminal(self):
        timeout = self.sim.ticks >= self.max_ticks
        return np.zeros(self.num_envs, dtype=bool), timeout

    def _outcome_reward(self, ko, timeout):
        zero = np.zeros(self.num_envs)
        return zero, zero.astype(np.int64)

    def _after_step(self) -> None:
        self.sim.hp[:] = C.MAX_HEALTH
        self.sim.hurt_timer[:] = 0

    def _goal(self, ev: dict[str, np.ndarray], outcome: np.ndarray) -> np.ndarray:
        return np.zeros(self.num_envs)


class ShootingDrill(DrillEnv):
    """Hit a target that runs around the shooter with a bow or crossbow."""

    goal_terms = ("hits",)

    locked_heads = (
        (A.FORWARD, A.NEUTRAL_FORWARD),
        (A.STRAFE, A.NEUTRAL_STRAFE),
        (A.SPRINT, 0),
        (A.JUMP, 0),
        (A.ATTACK, 0),
        (A.SNEAK, 0),
        (A.LOCK_AIM, 0),
    )

    def __init__(self, n_envs: int, seed: int = 0, weapons: tuple[int, ...] = (C.BOW, C.CROSSBOW)):
        self.weapons = np.array(weapons)
        self.side = np.ones(n_envs)
        self.runs = np.zeros(n_envs, dtype=bool)
        config = SimConfig(
            armor="none",
            spawn_min=7.0,
            spawn_max=14.0,
            face_noise_deg=25.0,
            start_arrows=DRILL_ARROWS,
        )
        super().__init__(n_envs, config, seed)
        self._on_reset(np.ones(n_envs, dtype=bool))
        self._phi = self._potential()

    def _on_reset(self, mask: np.ndarray) -> None:
        idx = np.flatnonzero(mask)
        if len(idx) == 0:
            return
        rng = self.drill_rng
        chosen = rng.choice(self.weapons, size=len(idx))
        self.sim.weapon[idx, 0] = chosen
        self.allowed[idx] = False
        self.allowed[idx, chosen] = True
        self.side[idx] = rng.choice([-1.0, 1.0], size=len(idx))
        self.runs[idx] = rng.random(len(idx)) < 0.5

    def _aim_error(self) -> np.ndarray:
        """Return how far the view is from a shot fired now, at the speed the lead inputs use."""
        sim = self.sim
        yaw, pitch, _ = intercept_angles(sim, 0, arrows.aim_speed(sim, 0))
        yaw_error = np.abs(wrap_degrees(yaw - sim.yaw[:, 0]))
        return yaw_error + np.abs(pitch - sim.pitch[:, 0])

    def _charge(self) -> np.ndarray:
        """Return how ready the held weapon is, from 0 to 1."""
        sim = self.sim
        bow = np.minimum(sim.draw_ticks[:, 0] / C.BOW_FULL_DRAW_TICKS, 1.0)
        crossbow = np.where(sim.loaded[:, 0], 1.0, sim.load_ticks[:, 0] / C.CROSSBOW_LOAD_TICKS)
        return np.where(sim.weapon[:, 0] == C.BOW, bow, crossbow)

    def _goal(self, ev: dict[str, np.ndarray], outcome: np.ndarray) -> np.ndarray:
        """Return the arrows that hit the target this step."""
        return ev["arrow_hits"][:, 0].astype(float)

    def _potential(self) -> np.ndarray:
        return 0.5 * np.exp(-self._aim_error() / 8.0) + 0.3 * self._charge()

    def _before_step(self) -> None:
        sim = self.sim
        self.pre_aim = np.exp(-self._aim_error() / 4.0)
        self.pre_ready = (sim.draw_ticks[:, 0] >= C.BOW_FULL_DRAW_TICKS) | sim.loaded[:, 0]

    def _opponent_actions(self) -> np.ndarray:
        sim = self.sim
        flip = self.drill_rng.random(self.num_envs) < 0.03
        self.side[flip] *= -1.0
        delta = sim.pos[:, 0] - sim.pos[:, 1]
        bearing = np.degrees(np.arctan2(-delta[:, 0], delta[:, 2]))
        distance = np.hypot(delta[:, 0], delta[:, 2])
        turn = np.select([distance > 15.0, distance < 7.0], [50.0, 130.0], 90.0)
        heading = bearing + self.side * turn
        edge = sim.cfg.arena_half - 2.0
        near_wall = (np.abs(sim.pos[:, 1, 0]) > edge) | (np.abs(sim.pos[:, 1, 2]) > edge)
        to_center = np.degrees(np.arctan2(sim.pos[:, 1, 0], -sim.pos[:, 1, 2]))
        sim.yaw[:, 1] = np.where(near_wall, to_center, heading)
        a = A.neutral_actions(np.full(self.num_envs, C.SWORD))
        a[:, A.FORWARD] = A.KEY_FORWARD
        a[:, A.SPRINT] = self.runs
        return a

    def _reward(self, ev: dict[str, np.ndarray], actions: np.ndarray) -> np.ndarray:
        phi = self._potential()
        gain = phi - self._phi
        self._phi = phi
        fired = ev["arrows_fired"][:, 0]
        good_shot = fired * self.pre_ready * self.pre_aim
        waiting = self.pre_ready & (fired == 0)
        idle = self._charge() == 0.0
        self.reward_terms = {
            "hits": 1.5 * ev["arrow_hits"][:, 0],
            "good_shot": 0.35 * good_shot,
            "fired": -0.05 * fired,
            "waiting": -0.01 * waiting,
            "idle": -0.01 * idle,
            "aim_charge": gain,
        }
        return (
            1.5 * ev["arrow_hits"][:, 0]
            + 0.35 * good_shot
            - 0.05 * fired
            - 0.01 * waiting
            - 0.01 * idle
            + gain
        )


class BlockingDrill(DrillEnv):
    """Raise the shield in time against a scripted archer."""

    goal_terms = ("blocked", "taken")

    locked_heads = (
        (A.FORWARD, A.NEUTRAL_FORWARD),
        (A.STRAFE, A.NEUTRAL_STRAFE),
        (A.SPRINT, 0),
        (A.JUMP, 0),
        (A.ATTACK, 0),
        (A.SNEAK, 0),
        (A.LOCK_AIM, 0),
    )

    def __init__(self, n_envs: int, seed: int = 0):
        self.hold_for = np.full(n_envs, C.BOW_FULL_DRAW_TICKS, dtype=np.int64)
        self.rest = np.zeros(n_envs, dtype=np.int64)
        self.raise_level = np.zeros(n_envs)
        config = SimConfig(
            armor="none",
            spawn_min=8.0,
            spawn_max=15.0,
            face_noise_deg=45.0,
            start_arrows=DRILL_ARROWS,
        )
        super().__init__(n_envs, config, seed)
        self.allowed[:] = False
        self.allowed[:, C.SWORD] = True
        self._on_reset(np.ones(n_envs, dtype=bool))
        self._phi = self._potential()

    def _new_shot(self, idx: np.ndarray) -> None:
        rng = self.drill_rng
        self.hold_for[idx] = rng.integers(C.BOW_FULL_DRAW_TICKS, 35, size=len(idx))
        self.rest[idx] = rng.integers(0, 16, size=len(idx))

    def _on_reset(self, mask: np.ndarray) -> None:
        idx = np.flatnonzero(mask)
        if len(idx) == 0:
            return
        self.sim.weapon[idx, 1] = C.BOW
        self.raise_level[idx] = 0.0
        self._new_shot(idx)

    def _potential(self) -> np.ndarray:
        sim = self.sim
        delta = sim.pos[:, 1] - sim.pos[:, 0]
        want, _ = view_angles(delta + np.array([0.0, 1e-3, 0.0]))
        return 0.3 * np.cos(np.radians(wrap_degrees(want - sim.yaw[:, 0])))

    def _goal(self, ev: dict[str, np.ndarray], outcome: np.ndarray) -> np.ndarray:
        """Return the arrows blocked this step."""
        return ev["arrows_blocked"][:, 0].astype(float)

    def _opponent_actions(self) -> np.ndarray:
        sim = self.sim
        a = A.neutral_actions(np.full(self.num_envs, C.BOW))
        yaw, pitch, _ = intercept_angles(sim, 1, np.full(self.num_envs, C.BOW_MAX_SPEED))
        steer(a, wrap_degrees(yaw - sim.yaw[:, 1]), pitch - sim.pitch[:, 1])
        resting = self.rest > 0
        release = sim.draw_ticks[:, 1] >= self.hold_for
        a[:, A.USE] = ~resting & ~release
        self.rest = np.maximum(self.rest - C.TICKS_PER_DECISION, 0)
        if release.any():
            self._new_shot(np.flatnonzero(release))
        return a

    def _reward(self, ev: dict[str, np.ndarray], actions: np.ndarray) -> np.ndarray:
        phi = self._potential()
        gain = phi - self._phi
        self._phi = phi
        # Only a shield that can block pays the upkeep. Raising earns a progress term discounted
        # like the potential, so every press and release loop earns less than not pressing.
        level = np.minimum(self.sim.shield_ticks[:, 0] / C.SHIELD_RAISE_TICKS, 1.0)
        progress = RAISE_WEIGHT * (TrainConfig.gamma * level - self.raise_level)
        self.raise_level = level
        ready = self.sim.shield_active[:, 0]
        self.reward_terms = {
            "blocked": ev["arrows_blocked"][:, 0],
            "taken": -ev["arrows_taken"][:, 0],
            "shield_up": -0.06 * ready,
            "facing": gain,
            "raise_progress": progress,
        }
        return (
            ev["arrows_blocked"][:, 0] - ev["arrows_taken"][:, 0] - 0.06 * ready + gain + progress
        )


class _TimeLimit(BaseCallback):
    def __init__(self, minutes: float, max_rss_gb: float):
        super().__init__()
        self.minutes = minutes
        self.max_rss_gb = max_rss_gb
        self.started = time.monotonic()
        self.stop_reason = ""

    def _on_step(self) -> bool:
        if self.minutes > 0 and (time.monotonic() - self.started) / 60.0 >= self.minutes:
            self.stop_reason = "time limit"
            return False
        if self.n_calls % 200 == 0 and peak_rss_gb() > self.max_rss_gb:
            self.stop_reason = "memory limit"
            return False
        return True


def _baseline_shooter(env: ShootingDrill, lead: bool) -> np.ndarray:
    """Aim with or without lead, then fire when fully charged and aligned."""
    sim = env.sim
    a = A.neutral_actions(sim.weapon[:, 0].copy())
    speed = np.where(sim.weapon[:, 0] == C.CROSSBOW, C.CROSSBOW_SPEED, C.BOW_MAX_SPEED)
    yaw, pitch, _ = intercept_angles(sim, 0, speed, lead=lead)
    yaw_error = wrap_degrees(yaw - sim.yaw[:, 0])
    pitch_error = pitch - sim.pitch[:, 0]
    steer(a, yaw_error, pitch_error)
    aligned = (np.abs(yaw_error) < 2.0) & (np.abs(pitch_error) < 2.0)
    bow = sim.weapon[:, 0] == C.BOW
    full = sim.draw_ticks[:, 0] >= C.BOW_FULL_DRAW_TICKS
    load = ~sim.loaded[:, 0] & ~sim.load_wait[:, 0]
    shoot = sim.loaded[:, 0] & aligned & ~sim.use_prev[:, 0]
    a[:, A.USE] = np.where(bow, ~(full & aligned), load | shoot)
    return a


def _count_shots(env: ShootingDrill, act, episodes: int) -> dict:
    obs = env.reset()
    decisions = DRILL_TICKS // C.TICKS_PER_DECISION
    fired = 0.0
    hits = 0.0
    for _ in range(episodes):
        for _ in range(decisions):
            env.step_async(act(obs))
            obs, _, _, _ = env.step_wait()
            fired += env.sim.events["arrows_fired"][:, 0].sum()
            hits += env.sim.events["arrow_hits"][:, 0].sum()
    low, high = wilson_interval(int(min(hits, fired)), int(fired))
    return {
        "shots": int(fired),
        "hits": int(hits),
        "hit_rate": round(hits / max(fired, 1.0), 4),
        "hit_rate_low": round(low, 4),
        "hit_rate_high": round(high, 4),
    }


def shooting_report(policy: NumpyPolicy, seed: int = HELD_OUT_SEED, n_envs: int = 32) -> dict:
    """Score the policy and a no-lead baseline with each weapon."""
    report: dict = {"drill": "shooting", "weapons": {}}
    passed = True
    for name, weapon in (("bow", C.BOW), ("crossbow", C.CROSSBOW)):
        rng = np.random.default_rng(seed + weapon)
        env = ShootingDrill(n_envs, seed=seed + weapon, weapons=(weapon,))
        learned = _count_shots(
            env, lambda o: policy.act(o, env.action_masks(), rng, deterministic=True), 4
        )
        env = ShootingDrill(n_envs, seed=seed + weapon, weapons=(weapon,))
        baseline = _count_shots(env, lambda _: _baseline_shooter(env, lead=False), 4)
        ok = bool(
            learned["shots"] >= 100
            and learned["hit_rate"] >= SHOOT_PASS_RATE
            and learned["hit_rate"] >= baseline["hit_rate"] + SHOOT_LEAD_MARGIN
        )
        passed &= ok
        report["weapons"][name] = {"policy": learned, "no_lead_baseline": baseline, "passed": ok}
    report["passed"] = bool(passed)
    return report


def blocking_report(policy: NumpyPolicy, seed: int = HELD_OUT_SEED, n_envs: int = 32) -> dict:
    """Score how many arrows the policy blocks and how long the shield is up."""
    rng = np.random.default_rng(seed)
    env = BlockingDrill(n_envs, seed=seed)
    obs = env.reset()
    decisions = DRILL_TICKS // C.TICKS_PER_DECISION
    blocked = 0.0
    taken = 0.0
    raised = 0.0
    total = 0
    for _ in range(4 * decisions):
        env.step_async(policy.act(obs, env.action_masks(), rng, deterministic=True))
        obs, _, _, _ = env.step_wait()
        blocked += env.sim.events["arrows_blocked"][:, 0].sum()
        taken += env.sim.events["arrows_taken"][:, 0].sum()
        raised += (env.sim.shield_ticks[:, 0] > 0).sum()
        total += env.num_envs
    arrows = blocked + taken
    rate = blocked / max(arrows, 1.0)
    uptime = raised / max(total, 1)
    low, high = wilson_interval(int(blocked), int(arrows))
    passed = arrows >= 100 and rate >= BLOCK_PASS_RATE and uptime <= BLOCK_MAX_UPTIME
    return {
        "drill": "blocking",
        "arrows": int(arrows),
        "blocked": int(blocked),
        "block_rate": round(rate, 4),
        "block_rate_low": round(low, 4),
        "block_rate_high": round(high, 4),
        "shield_uptime": round(uptime, 4),
        "passed": bool(passed),
    }


DRILLS = {
    "shooting": (ShootingDrill, shooting_report),
    "blocking": (BlockingDrill, blocking_report),
}


def train_drill(
    name: str,
    out: str,
    steps: int = DRILL_STEPS,
    seed: int = 11,
    max_minutes: float = DRILL_MINUTES,
    n_envs: int = 24,
    threads: int = 2,
    max_rss_gb: float = 2.0,
) -> dict:
    """Train one drill from random weights, score it at checkpoints and stop at the first pass."""
    limit_threads(threads)
    env_class, report_fn = DRILLS[name]
    path = Path(out)
    path.mkdir(parents=True, exist_ok=True)
    env = env_class(n_envs, seed=seed)
    cfg = TrainConfig(n_envs=n_envs, n_steps=128, batch_size=1024, n_epochs=4, seed=seed)
    model = build_model(env, cfg)
    callback = _TimeLimit(max_minutes, max_rss_gb)
    started = time.monotonic()
    while True:
        chunk = min(CHECK_EVERY, steps - model.num_timesteps)
        model.learn(chunk, callback=callback, reset_num_timesteps=False)
        policy = NumpyPolicy.from_sb3(model)
        report = report_fn(policy)
        if report["passed"] or callback.stop_reason or model.num_timesteps >= steps:
            break
    elapsed = time.monotonic() - started
    policy.save(path / "policy.npz")
    report["train"] = {
        "steps": int(model.num_timesteps),
        "minutes": round(elapsed / 60.0, 2),
        "peak_rss_gb": round(peak_rss_gb(), 3),
        "stopped_by": callback.stop_reason or ("passed" if report["passed"] else "step budget"),
        "seed": seed,
    }
    (path / "report.json").write_text(json.dumps(report, indent=2))
    return report


__all__ = ["DRILLS", "BlockingDrill", "ShootingDrill", "blocking_report", "build_obs",
           "shooting_report", "train_drill"]
