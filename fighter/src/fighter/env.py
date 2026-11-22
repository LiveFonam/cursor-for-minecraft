"""A Stable Baselines vector environment over the simulator."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import gymnasium as gym
import numpy as np
from stable_baselines3.common.vec_env import VecEnv

from . import actions as A
from . import constants as C
from .combat import RoundRules, round_timeout
from .farmwatch import Ledger
from .interface import SHARED, Interface
from .obs import view_angles, wrap_degrees
from .opponents import OpponentPool
from .sim import Sim, SimConfig

ITEM_NAMES = ("sword", "axe", "bow", "crossbow")
OUT_OF_REACH_BAND = 1.5


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
    exact_miss: bool = False
    followup_unfaded: bool = False
    load_range: float = 0.0
    clean_shot: float = 0.0
    blocked_shot: float = 0.0
    timeout_cost: float = 0.0


class ArenaVecEnv(VecEnv):
    """Runs seat 0 as the learner and seat 1 through an opponent pool."""

    render_mode = None
    goal_terms: tuple[str, ...] = ("damage_dealt", "damage_taken", "win", "timeout_margin")

    def __init__(
        self,
        n_envs: int,
        pool: OpponentPool,
        sim_config: SimConfig | None = None,
        reward: RewardConfig | None = None,
        max_ticks: int = 600,
        seed: int = 0,
        round_rules: RoundRules | None = None,
        interface: Interface | None = None,
    ):
        self.interface = interface or SHARED
        observation_space = gym.spaces.Box(-5.0, 5.0, shape=(self.interface.obs_dim,), dtype=np.float32)
        action_space = gym.spaces.MultiDiscrete(self.interface.nvec)
        super().__init__(n_envs, observation_space, action_space)
        self.sim = Sim(n_envs, sim_config, seed=seed)
        self.pool = pool
        self.reward_cfg = reward or RewardConfig()
        self.max_ticks = max_ticks
        self.round_rules = round_rules
        self.allowed = np.ones((n_envs, C.NUM_WEAPONS), dtype=bool)
        self._actions = np.zeros((n_envs, len(self.interface.nvec)), dtype=np.int64)
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
        target = cfg.best_range
        if cfg.load_range > 0.0:
            target = np.where(sim.weapon[:, 0] == C.CROSSBOW, cfg.load_range, cfg.best_range)
        spacing = -np.abs(distance - target) / (2.0 * sim.cfg.arena_half)
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
            + cfg.clean_shot * ev["arrow_hits"][:, 0]
            - cfg.blocked_shot * ev["arrows_blocked"][:, 1]
        )
        followup = cfg.followup * ev["followup_damage"][:, 0] / C.MAX_HEALTH
        if cfg.followup_unfaded:
            reward = reward + followup
        else:
            shaped = shaped + followup
        delta = sim.pos[:, 1] - sim.pos[:, 0]
        distance = np.hypot(delta[:, 0], delta[:, 2])
        wasted = (ev["swings"][:, 0] > 0) & (ev["hits"][:, 0] == 0)
        weak = ev["weak_swings"][:, 0]
        if cfg.exact_miss:
            blocked = ev["melee_blocked"][:, 0] > 0
            wasted = wasted & ~blocked & (distance > C.ATTACK_REACH + 0.5)
            weak = weak * ~blocked
        fined = wasted + weak
        shaped = shaped - cfg.weak_swing * fined
        near = distance < 4.0
        strafing = actions[:, A.STRAFE] != A.NEUTRAL_STRAFE
        shaped = shaped + cfg.strafe * (near & strafing)
        phi = self._potential()
        potential_gain = phi - self._phi
        self._phi = phi
        scale = cfg.shaping
        self.reward_terms = {
            "damage_dealt": cfg.damage_dealt * ev["damage_dealt"][:, 0] / C.MAX_HEALTH,
            "damage_taken": -cfg.damage_taken * ev["damage_taken"][:, 0] / C.MAX_HEALTH,
            "crit": scale * cfg.crit * ev["crits"][:, 0],
            "sprint_hit": scale * cfg.sprint_hit * ev["sprint_hits"][:, 0],
            "shield_block": scale * cfg.shield_block * (ev["melee_blocked"][:, 1] + ev["arrows_blocked"][:, 0]),
            "shield_break": scale * cfg.shield_break * ev["shield_breaks"][:, 0],
            "clean_shot": scale * cfg.clean_shot * ev["arrow_hits"][:, 0],
            "blocked_shot": -scale * cfg.blocked_shot * ev["arrows_blocked"][:, 1],
            "followup": followup if cfg.followup_unfaded else scale * followup,
            "weak_swing": -scale * cfg.weak_swing * fined,
            "strafe": scale * cfg.strafe * (near & strafing),
            "aim_spacing": potential_gain,
        }
        return reward + cfg.shaping * shaped + potential_gain

    def _terminal(self) -> tuple[np.ndarray, np.ndarray]:
        hp = self.sim.hp
        ko = (hp[:, 0] <= 0.0) | (hp[:, 1] <= 0.0)
        if self.round_rules is None:
            timeout = self.sim.ticks >= self.max_ticks
        else:
            timeout = round_timeout(self.round_rules, self.sim.ticks, self.sim.combat.last_hit_tick, hp)
        if self.sim.world is not None:
            timeout = timeout | self.sim.world.overflowed()
        return ko, timeout & ~ko

    def _outcome_reward(self, ko: np.ndarray, timeout: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        cfg = self.reward_cfg
        hp = self.sim.hp
        outcome = np.zeros(self.num_envs, dtype=np.int64)
        outcome[ko & (hp[:, 1] <= 0.0) & (hp[:, 0] > 0.0)] = 1
        outcome[ko & (hp[:, 0] <= 0.0) & (hp[:, 1] > 0.0)] = -1
        bonus = cfg.win * outcome.astype(float)
        margin = (hp[:, 0] - hp[:, 1]) / C.MAX_HEALTH
        on_timeout = timeout * (cfg.timeout_margin * margin - cfg.timeout_cost)
        self.outcome_terms = {"win": bonus, "timeout_margin": on_timeout}
        bonus = bonus + on_timeout
        return bonus, outcome

    def _goal(self, ev: dict[str, np.ndarray], outcome: np.ndarray) -> np.ndarray:
        """Return the progress on the real goal this step, here a won fight."""
        return (outcome > 0).astype(float)

    def _behaviour(self, actions: np.ndarray, ev: dict[str, np.ndarray]) -> tuple[dict, dict]:
        """Return per step counts and the states whose rising edges are counted."""
        sim = self.sim
        delta = sim.pos[:, 1] - sim.pos[:, 0]
        distance = np.hypot(delta[:, 0], delta[:, 2])
        counts = {
            "arrows_fired": ev["arrows_fired"][:, 0],
            "arrows_picked": ev["arrows_picked"][:, 0],
            "weapon_switches": actions[:, A.WEAPON] != A.WEAPON_KEEP,
            "out_of_reach": (distance > C.ATTACK_REACH) & (distance <= C.ATTACK_REACH + OUT_OF_REACH_BAND),
        }
        use = actions[:, A.USE] > 0
        held = sim.weapon[:, 0]
        edges = {f"use_{name}": use & (held == item) for item, name in enumerate(ITEM_NAMES)}
        edges["shield_raises"] = sim.shield_ticks[:, 0] > 0
        return counts, edges

    def _ledger(self) -> Ledger:
        if "ledger" not in self.__dict__:
            minutes = 1.0 / (60.0 * self.sim.cfg.decisions_per_second)
            self.ledger = Ledger(self.num_envs, self.goal_terms, minutes)
        return self.ledger

    def farm_tally(self) -> dict:
        """Return and clear the reward terms, goal and counters of the episodes finished so far."""
        return self._ledger().drain()

    def set_weapons(self, weapons: tuple[int, ...] | None) -> None:
        """Limit the weapons the learner and its league may select. None allows all of them."""
        self.allowed[:] = weapons is None
        if weapons is not None:
            self.allowed[:, list(weapons)] = True
        self.pool.allowed = self.allowed

    def _on_reset(self, mask: np.ndarray) -> None:
        self.pool.assign(mask)

    def _before_step(self) -> None:
        return None

    def _after_step(self) -> None:
        return None

    def observe(self, rows: np.ndarray | None = None) -> np.ndarray:
        """Return the learner observation of all or the selected arenas."""
        return np.clip(self.interface.observe(self.sim, 0, self.max_ticks, rows), -5.0, 5.0)

    def action_masks(self) -> np.ndarray:
        """Return the learner action masks."""
        return self.interface.masks(self.sim, 0, self.allowed)

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
        actions, extra = self.interface.split(self._actions)
        self._before_step()
        opponent = self._opponent_actions()
        if self.interface.apply is not None:
            self.interface.apply(self.sim, 0, extra, None)
        joined = np.stack([actions, opponent], axis=1)
        events = self.sim.step(joined)
        counts, edges = self._behaviour(actions, events)
        self.reward_terms = {}
        reward = self._reward(events, actions)
        self._after_step()
        ko, timeout = self._terminal()
        self.outcome_terms = {}
        bonus, outcome = self._outcome_reward(ko, timeout)
        reward = reward + bonus
        ledger = self._ledger()
        terms = {**self.reward_terms, **self.outcome_terms}
        ledger.step(reward, terms, self._goal(events, outcome), counts, edges)
        self.episode_return += reward
        self.episode_length += 1
        done = ko | timeout
        infos: list[dict] = [{} for _ in range(self.num_envs)]
        obs = self.observe()
        if done.any():
            finished = np.flatnonzero(done)
            self.pool.record(finished, outcome[finished] > 0)
            terms_of = ledger.finish(finished)
            for env, episode_terms in zip(finished, terms_of):
                info = infos[env]
                info["reward_terms"] = episode_terms
                info["terminal_observation"] = obs[env].copy()
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
            obs[finished] = self.observe(finished)
        return obs, reward.astype(np.float32), done, infos

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
