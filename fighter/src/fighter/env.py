"""A Stable Baselines vector environment over the simulator."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import gymnasium as gym
import numpy as np
from stable_baselines3.common.vec_env import VecEnv

from . import actions as A
from . import constants as C
from .obs import OBS_DIM, build_masks, build_obs, view_angles, wrap_degrees
from .opponents import OpponentPool
from .sim import Sim, SimConfig


@dataclass
class RewardConfig:
    """Weights of the fight reward. Shaping terms scale with `shaping`."""

    win: float = 2.0
    damage_dealt: float = 4.0
    damage_taken: float = 3.0
    timeout_margin: float = 0.5
    shaping: float = 1.0
    crit: float = 0.06
    sprint_hit: float = 0.05
    weak_swing: float = 0.02
    shield_block: float = 0.05
    shield_break: float = 0.15
    followup: float = 0.5
    aim: float = 0.02
    spacing: float = 0.5
    strafe: float = 0.002
    best_range: float = 2.7


class ArenaVecEnv(VecEnv):
    """Runs seat 0 as the learner and seat 1 through an opponent pool."""

    render_mode = None

    def __init__(
        self,
        n_envs: int,
        pool: OpponentPool,
        sim_config: SimConfig | None = None,
        reward: RewardConfig | None = None,
        max_ticks: int = 600,
        seed: int = 0,
    ):
        observation_space = gym.spaces.Box(-5.0, 5.0, shape=(OBS_DIM,), dtype=np.float32)
        action_space = gym.spaces.MultiDiscrete(A.NVEC)
        super().__init__(n_envs, observation_space, action_space)
        self.sim = Sim(n_envs, sim_config, seed=seed)
        self.pool = pool
        self.reward_cfg = reward or RewardConfig()
        self.max_ticks = max_ticks
        self.allowed = np.ones((n_envs, C.NUM_WEAPONS), dtype=bool)
        self._actions = np.zeros((n_envs, len(A.NVEC)), dtype=np.int64)
        self.episode_return = np.zeros(n_envs)
        self.episode_length = np.zeros(n_envs, dtype=np.int64)
        self.results: deque[tuple[str, int]] = deque(maxlen=400)
        self._phi = np.zeros(n_envs)
        self.pool.assign(np.ones(n_envs, dtype=bool))
        self._phi = self._potential()

    def _potential(self) -> np.ndarray:
        sim = self.sim
        cfg = self.reward_cfg
        delta = sim.pos[:, 1] - sim.pos[:, 0]
        distance = np.hypot(delta[:, 0], delta[:, 2])
        eye = sim.pos[:, 0] + np.array([0.0, C.EYE_HEIGHT, 0.0])
        chest = sim.pos[:, 1] + np.array([0.0, C.PLAYER_HEIGHT / 2.0, 0.0])
        want_yaw, want_pitch = view_angles(chest - eye)
        yaw_err = np.radians(wrap_degrees(want_yaw - sim.yaw[:, 0]))
        pitch_err = np.radians(want_pitch - sim.pitch[:, 0])
        spacing = -np.abs(distance - cfg.best_range) / (2.0 * sim.cfg.arena_half)
        aim = np.cos(yaw_err) * np.cos(pitch_err)
        return cfg.shaping * (cfg.spacing * spacing + cfg.aim * 5.0 * aim)

    def _opponent_actions(self) -> np.ndarray:
        return self.pool.act(self.sim, 1)

    def _reward(self, ev: dict[str, np.ndarray], actions: np.ndarray) -> np.ndarray:
        cfg = self.reward_cfg
        sim = self.sim
        reward = (
            cfg.damage_dealt * ev["damage_dealt"][:, 0] / C.MAX_HEALTH
            - cfg.damage_taken * ev["damage_taken"][:, 0] / C.MAX_HEALTH
        )
        shaped = (
            cfg.crit * ev["crits"][:, 0]
            + cfg.sprint_hit * ev["sprint_hits"][:, 0]
            + cfg.shield_block * (ev["melee_blocked"][:, 1] + ev["arrows_blocked"][:, 0])
            + cfg.shield_break * ev["shield_breaks"][:, 0]
            + cfg.followup * ev["followup_damage"][:, 0] / C.MAX_HEALTH
        )
        wasted = (ev["swings"][:, 0] > 0) & (ev["hits"][:, 0] == 0)
        shaped = shaped - cfg.weak_swing * (wasted + ev["weak_swings"][:, 0])
        delta = sim.pos[:, 1] - sim.pos[:, 0]
        near = np.hypot(delta[:, 0], delta[:, 2]) < 4.0
        strafing = actions[:, A.STRAFE] != A.NEUTRAL_STRAFE
        shaped = shaped + cfg.strafe * (near & strafing)
        phi = self._potential()
        potential_gain = phi - self._phi
        self._phi = phi
        return reward + cfg.shaping * shaped + potential_gain

    def _terminal(self) -> tuple[np.ndarray, np.ndarray]:
        hp = self.sim.hp
        ko = (hp[:, 0] <= 0.0) | (hp[:, 1] <= 0.0)
        timeout = self.sim.ticks >= self.max_ticks
        return ko, timeout & ~ko

    def _outcome_reward(self, ko: np.ndarray, timeout: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        cfg = self.reward_cfg
        hp = self.sim.hp
        outcome = np.zeros(self.num_envs, dtype=np.int64)
        outcome[ko & (hp[:, 1] <= 0.0) & (hp[:, 0] > 0.0)] = 1
        outcome[ko & (hp[:, 0] <= 0.0) & (hp[:, 1] > 0.0)] = -1
        bonus = cfg.win * outcome.astype(float)
        margin = (hp[:, 0] - hp[:, 1]) / C.MAX_HEALTH
        bonus = bonus + timeout * cfg.timeout_margin * margin
        return bonus, outcome

    def _on_reset(self, mask: np.ndarray) -> None:
        self.pool.assign(mask)

    def _before_step(self) -> None:
        return None

    def _after_step(self) -> None:
        return None

    def observe(self) -> np.ndarray:
        """Return the learner observation."""
        return np.clip(build_obs(self.sim, 0, self.max_ticks), -5.0, 5.0)

    def action_masks(self) -> np.ndarray:
        """Return the learner action masks."""
        return build_masks(self.sim, 0, self.allowed)

    def reset(self) -> np.ndarray:
        mask = np.ones(self.num_envs, dtype=bool)
        self.sim.reset(mask)
        self._on_reset(mask)
        self._phi = self._potential()
        self.episode_return[:] = 0.0
        self.episode_length[:] = 0
        return self.observe()

    def step_async(self, actions: np.ndarray) -> None:
        self._actions = np.asarray(actions, dtype=np.int64)

    def step_wait(self):
        actions = self._actions
        self._before_step()
        opponent = self._opponent_actions()
        joined = np.stack([actions, opponent], axis=1)
        events = self.sim.step(joined)
        reward = self._reward(events, actions)
        self._after_step()
        ko, timeout = self._terminal()
        bonus, outcome = self._outcome_reward(ko, timeout)
        reward = reward + bonus
        self.episode_return += reward
        self.episode_length += 1
        done = ko | timeout
        infos: list[dict] = [{} for _ in range(self.num_envs)]
        if done.any():
            final = self.observe()
            finished = np.flatnonzero(done)
            self.pool.record(finished, outcome[finished] > 0)
            for env in finished:
                info = infos[env]
                info["terminal_observation"] = final[env]
                info["TimeLimit.truncated"] = bool(timeout[env])
                info["outcome"] = int(outcome[env])
                info["opponent"] = self.pool.name_of(env)
                info["episode"] = {
                    "r": float(self.episode_return[env]),
                    "l": int(self.episode_length[env]),
                    "t": 0.0,
                }
                self.results.append((info["opponent"], int(outcome[env])))
            self.sim.reset(done)
            self._on_reset(done)
            phi = self._potential()
            self._phi[done] = phi[done]
            self.episode_return[done] = 0.0
            self.episode_length[done] = 0
        return self.observe(), reward.astype(np.float32), done, infos

    def win_rate(self) -> float:
        """Return the recent knockout win rate."""
        if not self.results:
            return 0.0
        return float(np.mean([outcome > 0 for _, outcome in self.results]))

    def close(self) -> None:
        return None

    def get_attr(self, attr_name, indices=None):
        count = len(self._get_indices(indices))
        return [getattr(self, attr_name)] * count

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
