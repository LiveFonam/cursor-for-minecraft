"""Mob rounds, the mob expert network, its pass test and the reward farm check.

The expert is a small network of its own. Its input is the shared observation
followed by mob inputs that a real client can see: kind, position, motion,
health, creeper fuse, enderman anger, a drawn bow and whether the player is
looking at the mob's eyes. Every size comes from the environment, so the expert
follows the shared observation and the action heads when they change.

Reward farm check. Each reward term is listed in `FARM_LOOPS` with the cheapest
repeatable loop that could farm it. `farm_report` runs each loop as a scripted
bot and compares its reward per step with a player who stands still.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sb3_contrib import MaskablePPO
from torch import nn

from . import actions as A
from . import constants as C
from .env import ArenaVecEnv
from .interface import InputBlock, Interface
from .evaluate import HELD_OUT_SEED, wilson_interval
from .mobs import (
    CREEPER,
    ENDERMAN,
    EYE,
    FUSE_TICKS,
    HEALTH,
    HEIGHT,
    KIND_NAMES,
    NO_MOB,
    NUM_MOB_KINDS,
    SKELETON,
    ZOMBIE,
    MobConfig,
    MobSim,
)
from .obs import OBS_DIM, _ego, view_angles, wrap_degrees
from .opponents import OpponentPool, steer
from .sim import SimConfig
from .train import CurriculumCallback, Stage, TrainConfig, limit_threads, peak_rss_gb

ROUND_TICKS = 600
NEAREST_MOBS = 3
FEATURES_PER_MOB = 17
EXPERT_HIDDEN = 128
PASS_WIN_RATE = 0.80
PASS_MIN_ROUNDS = 200
PASS_ROUNDS_PER_ARENA = 4
BEST_RANGE = 3.0
CHEST_SHARE = 0.4

ROSTERS: dict[str, tuple[int, ...]] = {
    "zombie": (ZOMBIE,),
    "skeleton": (SKELETON,),
    "creeper": (CREEPER,),
    "enderman": (ENDERMAN,),
    "creeper_pack": (ZOMBIE, SKELETON, CREEPER),
}
GROUPS = {"group2": 2, "group3": 3, "group4": 4}
SINGLES = {name: 1.0 for name in KIND_NAMES}
MOB_CURRICULUM = [
    Stage("single", dict(SINGLES), 0.75, 300_000),
    Stage("groups", {**SINGLES, "group2": 2.0, "group3": 1.5, "group4": 1.0}, 2.0, 0, 0.6),
]
GROUP_PASS_WIN_RATE = 0.60

FARM_LOOPS = {
    "damage": "land one hit each round, then stand still. Damage is shaping that a round without the kill pays back.",
    "kill": "only paid for a kill by the player. A creeper that blows itself up pays nothing.",
    "clear": "only paid when the player killed every mob of the round.",
    "health_left": "only paid with the clear.",
    "group share": "the clear and health bonus scale with the share of the round's mobs the player killed. A round where a creeper exploded is never a clear, so letting a blast or a stray skeleton arrow kill the other mobs pays nothing.",
    "shaping": "walk in and out of range while aiming. The shaping of a round sums to exactly zero.",
    "no reward for": "fuse cancels, dodged arrows, stares or survival, so baiting them pays nothing.",
}


@dataclass
class MobReward:
    """Weights of the mob round reward."""

    damage: float = 1.0
    kill: float = 1.5
    clear: float = 1.0
    health_left: float = 1.0
    time: float = 0.002
    effort: float = 0.001
    shaping: float = 1.0
    aim: float = 0.05
    spacing: float = 0.1


class MobPool(OpponentPool):
    """Chooses a roster of mobs per arena. The mobs act inside the simulator."""

    def act(self, sim, seat: int) -> np.ndarray:
        return A.neutral_actions(np.full(sim.n, C.SWORD))

    def add_snapshot(self, policy) -> None:
        return None


def mob_extra_dim(nearest: int = NEAREST_MOBS) -> int:
    """Return the number of expert inputs added to the shared observation."""
    return FEATURES_PER_MOB * nearest + 1


def mob_features(sim: MobSim, nearest: int = NEAREST_MOBS) -> np.ndarray:
    """Return what a client can see about the nearest mobs, shape (n, mob_extra_dim).

    A mob behind cover keeps the place and motion it last showed. Health, fuse,
    anger and a drawn bow stay live, as a tracking client receives them.
    """
    mobs = sim.mobs
    n = sim.n
    out = np.zeros((n, mob_extra_dim(nearest)), dtype=np.float32)
    out[:, -1] = mobs.alive.sum(axis=1) / mobs.m
    shown = np.where(mobs.in_sight[..., None], mobs.pos, mobs.seen_pos)
    moving = np.where(mobs.in_sight[..., None], mobs.vel, mobs.seen_vel)
    gap = shown - sim.pos[:, 0, None]
    order = np.argsort(np.where(mobs.alive, (gap * gap).sum(axis=-1), np.inf), axis=1)
    rows = np.arange(n)
    rad = np.radians(sim.yaw[:, 0])
    sin_y = np.sin(rad)
    cos_y = np.cos(rad)
    scale = 2.0 * sim.cfg.arena_half
    looked = mobs.looked_at() & mobs.in_sight
    for rank in range(min(nearest, mobs.m)):
        slot = order[:, rank]
        live = mobs.alive[rows, slot]
        if not live.any():
            break
        base = rank * FEATURES_PER_MOB
        kind = mobs.kind[rows, slot]
        offset = gap[rows, slot]
        forward, right = _ego(offset[:, 0], offset[:, 2], sin_y, cos_y)
        vel = moving[rows, slot]
        forward_v, right_v = _ego(vel[:, 0], vel[:, 2], sin_y, cos_y)
        out[:, base] = live
        out[rows[live], base + 1 + kind[live]] = 1.0
        out[:, base + 5] = live * forward / scale
        out[:, base + 6] = live * right / scale
        out[:, base + 7] = live * offset[:, 1] / 4.0
        out[:, base + 8] = live * np.minimum(np.hypot(offset[:, 0], offset[:, 2]) / 8.0, 2.0)
        out[:, base + 9] = live * forward_v * 2.0
        out[:, base + 10] = live * right_v * 2.0
        out[:, base + 11] = live * mobs.hp[rows, slot] / HEALTH[kind]
        out[:, base + 12] = live * mobs.swell[rows, slot] / FUSE_TICKS
        out[:, base + 13] = live & (kind == CREEPER) & (mobs.swell_dir[rows, slot] > 0)
        out[:, base + 14] = live & mobs.provoked[rows, slot]
        out[:, base + 15] = live & (mobs.draw[rows, slot] > 0)
        out[:, base + 16] = live & looked[rows, slot]
    return out


def _mob_block(sim: MobSim, seat: int, rows: np.ndarray | None) -> np.ndarray:
    """Return the mob inputs of the fighting seat for all or the selected arenas."""
    if seat != 0:
        raise ValueError("only seat 0 fights mobs")
    out = mob_features(sim)
    return out if rows is None else out[np.asarray(rows)]


class MobInterface(Interface):
    """The shared inputs and heads plus the mob block. A swing is allowed only with a mob under the crosshair."""

    def __init__(self) -> None:
        super().__init__(inputs=(InputBlock("mobs", mob_extra_dim(), _mob_block),))

    def masks(
        self, sim, seat: int, allowed_weapons: np.ndarray | None = None, rows: np.ndarray | None = None
    ) -> np.ndarray:
        mask = super().masks(sim, seat, allowed_weapons, rows)
        at = slice(None) if rows is None else np.asarray(rows)
        start = A.HEAD_OFFSETS[A.ATTACK]
        aimed = sim.aim_hits()[at, seat]
        mask[:, start + A.ATTACK_CLICK] &= aimed
        mask[:, start + A.ATTACK_DOUBLE] &= aimed
        return mask


MOB_INTERFACE = MobInterface()


class MobFightEnv(ArenaVecEnv):
    """Seat 0 fights a roster of mobs with an axe and a shield."""

    def __init__(
        self,
        n_envs: int,
        mix: dict[str, float] | None = None,
        seed: int = 0,
        sim_config: SimConfig | None = None,
        mob_config: MobConfig | None = None,
        reward: MobReward | None = None,
        max_ticks: int = ROUND_TICKS,
    ):
        self._ready = False
        pool = MobPool(n_envs, seed=seed + 1, max_ticks=max_ticks)
        pool.set_mix(mix or dict(SINGLES))
        config = sim_config or SimConfig(armor="iron")
        super().__init__(n_envs, pool, config, max_ticks=max_ticks, seed=seed, interface=MOB_INTERFACE)
        self.sim.close()
        self.sim = MobSim(n_envs, config, seed=seed, mobs=mob_config or MobConfig())
        self.reward_cfg = reward or MobReward()
        self.shared_dim = OBS_DIM
        self.extra_dim = mob_extra_dim()
        self.allowed[:] = False
        self.allowed[:, C.AXE] = True
        self.round_mobs = np.zeros(n_envs, dtype=np.int64)
        self.roster_rng = np.random.default_rng(seed + 7)
        self._paid_kills = np.zeros(n_envs, dtype=np.int64)
        self._phi_start = np.zeros(n_envs)
        self._ready = True
        self.reset()

    def _rosters(self, idx: np.ndarray) -> np.ndarray:
        table = np.full((len(idx), self.sim.mobs.m), NO_MOB, dtype=np.int64)
        for row, env in enumerate(idx.tolist()):
            name = self.pool.name_of(env)
            if name in GROUPS:
                kinds = self.roster_rng.integers(0, NUM_MOB_KINDS, GROUPS[name])
            else:
                kinds = ROSTERS[name]
            table[row, : len(kinds)] = kinds
        return table

    def _on_reset(self, mask: np.ndarray) -> None:
        self.pool.assign(mask)
        if not self._ready:
            return
        idx = np.flatnonzero(mask)
        if len(idx) == 0:
            return
        sim = self.sim
        sim.weapon[idx, 0] = C.AXE
        table = self._rosters(idx)
        sim.mobs.spawn_roster(idx, table)
        sim.show_focus()
        self.round_mobs[idx] = (table != NO_MOB).sum(axis=1)
        self._paid_kills[idx] = 0
        self._phi_start[idx] = self._potential()[idx]

    def _potential(self) -> np.ndarray:
        if not self._ready:
            return np.zeros(self.num_envs)
        sim = self.sim
        cfg = self.reward_cfg
        mobs = sim.mobs
        slot, present = mobs.nearest()
        rows = np.arange(self.num_envs)
        target = mobs.pos[rows, slot].copy()
        target[:, 1] += HEIGHT[mobs.kind[rows, slot]] * CHEST_SHARE
        delta = target - sim.eyes()[:, 0]
        want_yaw, want_pitch = view_angles(delta)
        yaw_error = np.radians(wrap_degrees(want_yaw - sim.yaw[:, 0]))
        pitch_error = np.radians(want_pitch - sim.pitch[:, 0])
        distance = np.hypot(delta[:, 0], delta[:, 2])
        spacing = -np.abs(distance - BEST_RANGE) / (2.0 * sim.cfg.arena_half)
        aim = np.cos(yaw_error) * np.cos(pitch_error)
        position = cfg.shaping * present * (cfg.spacing * spacing + cfg.aim * aim)
        return position + cfg.damage * mobs.damage_fraction

    def _opponent_actions(self) -> np.ndarray:
        return A.neutral_actions(np.full(self.num_envs, C.SWORD))

    def _before_step(self) -> None:
        self._fighting = self.sim.mobs.alive.any(axis=1)

    def _reward(self, ev: dict[str, np.ndarray], actions: np.ndarray) -> np.ndarray:
        cfg = self.reward_cfg
        mobs = self.sim.mobs
        kills = mobs.kills - self._paid_kills
        self._paid_kills = mobs.kills.copy()
        moving = (
            (actions[:, A.FORWARD] != A.NEUTRAL_FORWARD)
            | (actions[:, A.STRAFE] != A.NEUTRAL_STRAFE)
            | (actions[:, A.SPRINT] == 1)
            | (actions[:, A.JUMP] == 1)
        )
        phi = self._potential()
        gain = phi - self._phi
        self._phi = phi
        return (
            cfg.kill * kills
            - cfg.time * self._fighting
            - cfg.effort * moving
            + gain
        )

    def _terminal(self) -> tuple[np.ndarray, np.ndarray]:
        sim = self.sim
        dead = sim.hp[:, 0] <= 0.0
        cleared = ~sim.mobs.alive.any(axis=1)
        ko = dead | cleared
        timeout = sim.ticks >= self.max_ticks
        if sim.world is not None:
            timeout = timeout | sim.world.overflowed()
        return ko, timeout & ~ko

    def _outcome_reward(self, ko: np.ndarray, timeout: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        cfg = self.reward_cfg
        sim = self.sim
        dead = sim.hp[:, 0] <= 0.0
        won = ko & ~dead & ~sim.mobs.alive.any(axis=1) & (sim.mobs.blasts == 0)
        outcome = np.zeros(self.num_envs, dtype=np.int64)
        outcome[won] = 1
        outcome[dead] = -1
        share = sim.mobs.kills / np.maximum(self.round_mobs, 1)
        bonus = won * share * (cfg.clear + cfg.health_left * sim.hp[:, 0] / C.MAX_HEALTH)
        finished = ko | timeout
        return bonus + finished * (self._phi_start - self._phi), outcome


class MobExpert:
    """A small ReLU network with one categorical output per action head."""

    def __init__(
        self, layers: list[tuple[np.ndarray, np.ndarray]], shared_dim: int, extra_dim: int, nvec: np.ndarray
    ):
        self.layers = layers
        self.shared_dim = int(shared_dim)
        self.extra_dim = int(extra_dim)
        self.nvec = np.asarray(nvec, dtype=np.int64)
        self.offsets = np.concatenate([[0], np.cumsum(self.nvec)[:-1]])

    @classmethod
    def random(
        cls, shared_dim: int, extra_dim: int, nvec: np.ndarray, hidden: int = EXPERT_HIDDEN, seed: int = 0
    ) -> "MobExpert":
        """Build an untrained expert for the given interface."""
        rng = np.random.default_rng(seed)
        sizes = [shared_dim + extra_dim, hidden, hidden, int(np.sum(nvec))]
        layers = []
        for fan_in, fan_out in zip(sizes[:-1], sizes[1:]):
            weight = rng.normal(0.0, 1.0 / np.sqrt(fan_in), size=(fan_out, fan_in)).astype(np.float32)
            layers.append((weight, np.zeros(fan_out, dtype=np.float32)))
        return cls(layers, shared_dim, extra_dim, nvec)

    @classmethod
    def from_model(cls, model, env: MobFightEnv) -> "MobExpert":
        """Copy the actor weights out of a masked PPO model."""
        modules = [m for m in model.policy.mlp_extractor.policy_net if hasattr(m, "weight")]
        modules.append(model.policy.action_net)
        layers = [
            (m.weight.detach().cpu().numpy().copy(), m.bias.detach().cpu().numpy().copy()) for m in modules
        ]
        return cls(layers, env.shared_dim, env.extra_dim, env.action_space.nvec)

    def save(self, path: str | Path) -> None:
        """Write the weights and the interface sizes to an npz file."""
        arrays: dict[str, np.ndarray] = {
            "shared_dim": np.array(self.shared_dim),
            "extra_dim": np.array(self.extra_dim),
            "nvec": self.nvec,
            "count": np.array(len(self.layers)),
        }
        for i, (weight, bias) in enumerate(self.layers):
            arrays[f"w{i}"] = weight
            arrays[f"b{i}"] = bias
        np.savez_compressed(path, **arrays)

    @classmethod
    def load(cls, path: str | Path) -> "MobExpert":
        """Read an expert from an npz file."""
        with np.load(path) as data:
            count = int(data["count"])
            layers = [(data[f"w{i}"], data[f"b{i}"]) for i in range(count)]
            return cls(layers, int(data["shared_dim"]), int(data["extra_dim"]), data["nvec"])

    def logits(self, obs: np.ndarray) -> np.ndarray:
        """Return the flat action logits."""
        x = obs
        for weight, bias in self.layers[:-1]:
            x = np.maximum(x @ weight.T + bias, 0.0)
        weight, bias = self.layers[-1]
        return x @ weight.T + bias

    def act(
        self, obs: np.ndarray, masks: np.ndarray, rng: np.random.Generator, deterministic: bool = True
    ) -> np.ndarray:
        """Choose one action per head while respecting the masks."""
        logits = np.where(masks, self.logits(obs), -np.inf)
        if not deterministic:
            logits = logits + rng.gumbel(size=logits.shape)
        out = np.zeros((len(obs), len(self.nvec)), dtype=np.int64)
        for head, (start, size) in enumerate(zip(self.offsets, self.nvec)):
            out[:, head] = logits[:, start : start + size].argmax(axis=1)
        return out


def load_mob_expert(path: str | Path) -> MobExpert:
    """Read a saved expert and check that it fits the current mob interface."""
    expert = MobExpert.load(path)
    fits = (
        expert.shared_dim == OBS_DIM
        and expert.extra_dim == mob_extra_dim()
        and np.array_equal(expert.nvec, MOB_INTERFACE.nvec)
    )
    if not fits:
        raise ValueError("the saved mob expert does not match the current interface")
    return expert


def expert_actions(expert: MobExpert, sim: MobSim, max_ticks: int, rng, deterministic: bool = True) -> np.ndarray:
    """Return the expert's action for every arena, from client inputs and the axe mask."""
    allowed = np.zeros((sim.n, C.NUM_WEAPONS), dtype=bool)
    allowed[:, C.AXE] = True
    obs = np.clip(MOB_INTERFACE.observe(sim, 0, max_ticks), -5.0, 5.0)
    return expert.act(obs, MOB_INTERFACE.masks(sim, 0, allowed), rng, deterministic)


def route_actions(main_act, expert: MobExpert, env: MobFightEnv, obs: np.ndarray, rng) -> np.ndarray:
    """Use the expert where a mob is alive and the main network everywhere else.

    `main_act` takes the shared observation and the masks, and returns actions.
    """
    masks = env.action_masks()
    out = np.asarray(main_act(obs[:, : env.shared_dim], masks)).copy()
    fighting = env.sim.mobs.alive.any(axis=1)
    if fighting.any():
        out[fighting] = expert.act(obs[fighting], masks[fighting], rng)
    return out


def _bot_view(env: MobFightEnv, creeper_first: bool = False):
    sim = env.sim
    mobs = sim.mobs
    rows = np.arange(env.num_envs)
    slot, _ = mobs.nearest()
    if creeper_first:
        gap = mobs.pos - sim.pos[:, 0, None]
        creepers = mobs.alive & (mobs.kind == CREEPER)
        nearest_creeper = np.where(creepers, (gap * gap).sum(axis=-1), np.inf).argmin(axis=1)
        slot = np.where(creepers.any(axis=1), nearest_creeper, slot)
    kind = mobs.kind[rows, slot]
    chest = mobs.pos[rows, slot].copy()
    chest[:, 1] += HEIGHT[kind] * CHEST_SHARE
    delta = chest - sim.eyes()[:, 0]
    yaw, pitch = view_angles(delta)
    distance = np.hypot(delta[:, 0], delta[:, 2])
    a = A.neutral_actions(np.full(env.num_envs, C.AXE))
    return sim, mobs, rows, slot, kind, yaw, pitch, distance, a


def idle_bot(env: MobFightEnv) -> np.ndarray:
    """Stand still and do nothing."""
    return A.neutral_actions(np.full(env.num_envs, C.AXE))


def fighter_bot(env: MobFightEnv) -> np.ndarray:
    """A plain scripted fighter that walks up, aims at the chest and swings when charged."""
    sim, mobs, rows, slot, kind, yaw, pitch, distance, a = _bot_view(env)
    steer(a, wrap_degrees(yaw - sim.yaw[:, 0]), pitch - sim.pitch[:, 0])
    creeper = kind == CREEPER
    lit = creeper & (mobs.swell_dir[rows, slot] > 0)
    near_band = np.select([distance > 2.6, distance < 1.8], [A.KEY_FORWARD, A.KEY_BACK], A.NEUTRAL_FORWARD)
    far_band = np.select(
        [lit, distance > 3.3, distance < 3.1], [A.KEY_BACK, A.KEY_FORWARD, A.KEY_BACK], A.NEUTRAL_FORWARD
    )
    a[:, A.FORWARD] = np.where(creeper, far_band, near_band)
    a[:, A.SPRINT] = (distance > 3.6) & ~lit
    a[:, A.ATTACK] = sim.aim_hits()[:, 0] & (sim.combat.charge()[:, 0] > 0.95)
    return a


class _LoopBot:
    """Base for the farming loops."""

    def __init__(self, env: MobFightEnv):
        self.env = env
        self.leaving = np.zeros(env.num_envs, dtype=bool)
        self.clock = 0


class CreeperBaitBot(_LoopBot):
    """Step inside the swell distance, run past the cancel distance, repeat."""

    def __call__(self, _obs=None) -> np.ndarray:
        sim, _, _, _, _, yaw, pitch, distance, a = _bot_view(self.env)
        self.leaving = (self.leaving | (distance < 2.9)) & (distance < 7.5)
        heading = np.where(self.leaving, yaw + 180.0, yaw)
        steer(a, wrap_degrees(heading - sim.yaw[:, 0]), pitch - sim.pitch[:, 0])
        a[:, A.FORWARD] = A.KEY_FORWARD
        a[:, A.SPRINT] = self.leaving
        return a


class KiteBot(_LoopBot):
    """Run from the nearest mob for the whole round."""

    def __call__(self, _obs=None) -> np.ndarray:
        sim, _, _, _, _, yaw, pitch, distance, a = _bot_view(self.env)
        from_center = sim.pos[:, 0] - sim.origin
        home = np.degrees(np.arctan2(from_center[:, 0], -from_center[:, 2]))
        edge = np.maximum(np.abs(from_center[:, 0]), np.abs(from_center[:, 2])) > sim.cfg.arena_half - 2.0
        heading = np.where(edge, home, yaw + 180.0)
        steer(a, wrap_degrees(heading - sim.yaw[:, 0]), pitch - sim.pitch[:, 0])
        a[:, A.FORWARD] = np.where(distance < 9.0, A.KEY_FORWARD, A.NEUTRAL_FORWARD)
        a[:, A.SPRINT] = distance < 9.0
        return a


class CircleBot(_LoopBot):
    """Strafe around the nearest mob at range while aiming at it."""

    def __call__(self, _obs=None) -> np.ndarray:
        sim, _, _, _, _, yaw, pitch, distance, a = _bot_view(self.env)
        steer(a, wrap_degrees(yaw - sim.yaw[:, 0]), pitch - sim.pitch[:, 0])
        a[:, A.FORWARD] = np.select([distance > 6.0, distance < 4.5], [A.KEY_FORWARD, A.KEY_BACK], A.NEUTRAL_FORWARD)
        a[:, A.STRAFE] = A.KEY_RIGHT
        return a


class StareBot(_LoopBot):
    """Look an enderman in the eyes to anger it, keep walking backward."""

    def __call__(self, _obs=None) -> np.ndarray:
        sim, mobs, rows, slot, kind, _, _, _, a = _bot_view(self.env)
        eyes = mobs.pos[rows, slot].copy()
        eyes[:, 1] += EYE[kind]
        want_yaw, want_pitch = view_angles(eyes - sim.eyes()[:, 0])
        steer(a, wrap_degrees(want_yaw - sim.yaw[:, 0]), want_pitch - sim.pitch[:, 0])
        a[:, A.FORWARD] = A.KEY_BACK
        return a


class YoyoBot(_LoopBot):
    """Walk in and out of the best range while aiming, to collect shaping."""

    def __call__(self, _obs=None) -> np.ndarray:
        sim, _, _, _, _, yaw, pitch, _, a = _bot_view(self.env)
        steer(a, wrap_degrees(yaw - sim.yaw[:, 0]), pitch - sim.pitch[:, 0])
        self.clock += 1
        a[:, A.FORWARD] = A.KEY_FORWARD if (self.clock // 10) % 2 == 0 else A.KEY_BACK
        return a


class ChipBot(_LoopBot):
    """Land one hit each round, then stand still until the round ends."""

    def __call__(self, _obs=None) -> np.ndarray:
        sim, mobs, _, _, _, yaw, pitch, distance, a = _bot_view(self.env)
        fresh = mobs.damage_done == 0.0
        steer(a, wrap_degrees(yaw - sim.yaw[:, 0]), pitch - sim.pitch[:, 0])
        a[:, A.FORWARD] = np.where(fresh & (distance > 2.6), A.KEY_FORWARD, A.NEUTRAL_FORWARD)
        a[:, A.ATTACK] = fresh & sim.aim_hits()[:, 0] & (sim.combat.charge()[:, 0] > 0.95)
        return a


class BlastDodgeBot(_LoopBot):
    """Set a creeper off, then wait just outside the blast until the round ends."""

    def __call__(self, _obs=None) -> np.ndarray:
        sim, _, _, _, _, yaw, pitch, distance, a = _bot_view(self.env)
        self.leaving = (self.leaving | (distance < 2.9)) & (distance < 6.6)
        heading = np.where(self.leaving, yaw + 180.0, yaw)
        steer(a, wrap_degrees(heading - sim.yaw[:, 0]), pitch - sim.pitch[:, 0])
        hold = ~self.leaving & (distance >= 6.2) & (sim.mobs.swell.max(axis=1) > 0)
        a[:, A.FORWARD] = np.where(hold, A.NEUTRAL_FORWARD, A.KEY_FORWARD)
        a[:, A.SPRINT] = self.leaving
        return a


class GroupBlastBot(_LoopBot):
    """Light the nearest creeper, then wait just outside its blast while the other mobs close in."""

    def __call__(self, _obs=None) -> np.ndarray:
        sim, _, _, _, _, yaw, pitch, distance, a = _bot_view(self.env, creeper_first=True)
        self.leaving = (self.leaving | (distance < 2.9)) & (distance < 6.6)
        heading = np.where(self.leaving, yaw + 180.0, yaw)
        steer(a, wrap_degrees(heading - sim.yaw[:, 0]), pitch - sim.pitch[:, 0])
        hold = ~self.leaving & (distance >= 6.2) & (sim.mobs.swell.max(axis=1) > 0)
        a[:, A.FORWARD] = np.where(hold, A.NEUTRAL_FORWARD, A.KEY_FORWARD)
        a[:, A.SPRINT] = self.leaving
        return a


FARM_BOTS = {
    "creeper_bait": CreeperBaitBot,
    "kite": KiteBot,
    "circle": CircleBot,
    "stare": StareBot,
    "yoyo": YoyoBot,
    "blast_dodge": BlastDodgeBot,
    "chip": ChipBot,
    "group_blast": GroupBlastBot,
}
FARM_MIXES = (*KIND_NAMES, "creeper_pack", *GROUPS)


def play_rounds(env: MobFightEnv, act, per_arena: int = PASS_ROUNDS_PER_ARENA) -> dict:
    """Play the first rounds of every arena so short rounds are not counted more often."""
    obs = env.reset()
    counts = np.zeros(env.num_envs, dtype=np.int64)
    total = 0.0
    steps = 0
    wins = 0
    deaths = 0
    limit = (per_arena + 1) * (env.max_ticks // C.TICKS_PER_DECISION + 1)
    for _ in range(limit):
        if (counts >= per_arena).all():
            break
        env.step_async(act(obs))
        obs, _, done, infos = env.step_wait()
        for arena in np.flatnonzero(done).tolist():
            if counts[arena] >= per_arena:
                continue
            counts[arena] += 1
            info = infos[arena]
            total += info["episode"]["r"]
            steps += info["episode"]["l"]
            wins += info["outcome"] > 0
            deaths += info["outcome"] < 0
    games = int(counts.sum())
    low, high = wilson_interval(wins, games)
    return {
        "rounds": games,
        "wins": int(wins),
        "deaths": int(deaths),
        "win_rate": round(wins / max(games, 1), 4),
        "win_low": round(low, 4),
        "win_high": round(high, 4),
        "reward_per_step": round(total / max(steps, 1), 6),
        "steps": int(steps),
    }


def farm_report(seed: int = HELD_OUT_SEED, n_envs: int = 32, per_arena: int = 3) -> dict:
    """Run every farming loop on every mob and compare it with standing still."""
    report: dict = {"loops": FARM_LOOPS, "mobs": {}}
    passed = True
    for name in FARM_MIXES:
        env = MobFightEnv(n_envs, {name: 1.0}, seed=seed)
        idle = play_rounds(env, lambda _obs: idle_bot(env), per_arena)["reward_per_step"]
        row = {"idle": idle, "bots": {}}
        for bot_name, bot_class in FARM_BOTS.items():
            env = MobFightEnv(n_envs, {name: 1.0}, seed=seed)
            bot = bot_class(env)
            earned = play_rounds(env, bot, per_arena)["reward_per_step"]
            below = bool(earned < idle)
            passed &= below
            row["bots"][bot_name] = {"reward_per_step": earned, "below_idle": below}
        report["mobs"][name] = row
    report["passed"] = bool(passed)
    return report


def expert_report(expert: MobExpert, seed: int = HELD_OUT_SEED, n_envs: int = 64) -> dict:
    """Run the pass test for each mob on held-out seeds."""
    report: dict = {"mobs": {}, "pass_win_rate": PASS_WIN_RATE}
    passed = True
    for offset, name in enumerate(KIND_NAMES):
        rng = np.random.default_rng(seed + offset)
        env = MobFightEnv(n_envs, {name: 1.0}, seed=seed + offset)
        result = play_rounds(env, lambda obs: expert.act(obs, env.action_masks(), rng))
        env = MobFightEnv(n_envs, {name: 1.0}, seed=seed + offset)
        idle = play_rounds(env, lambda _obs: idle_bot(env))
        ok = bool(result["rounds"] >= PASS_MIN_ROUNDS and result["win_rate"] >= PASS_WIN_RATE)
        passed &= ok
        report["mobs"][name] = {"expert": result, "idle_win_rate": idle["win_rate"], "passed": ok}
    report["singles_passed"] = bool(passed)
    report["groups"] = group_report(expert, seed, n_envs)
    report["passed"] = bool(passed and report["groups"]["passed"])
    return report


def group_report(expert: MobExpert, seed: int = HELD_OUT_SEED, n_envs: int = 64) -> dict:
    """Run the group pass test on held-out seeds, with every mix size reported apart."""
    report: dict = {"sizes": {}, "pass_win_rate": GROUP_PASS_WIN_RATE}
    wins = 0
    games = 0
    for offset, name in enumerate(GROUPS, start=len(KIND_NAMES)):
        rng = np.random.default_rng(seed + offset)
        env = MobFightEnv(n_envs, {name: 1.0}, seed=seed + offset)
        result = play_rounds(env, lambda obs: expert.act(obs, env.action_masks(), rng))
        report["sizes"][name] = result
        wins += result["wins"]
        games += result["rounds"]
    low, high = wilson_interval(wins, games)
    rate = wins / max(games, 1)
    report["win_rate"] = round(rate, 4)
    report["win_low"] = round(low, 4)
    report["win_high"] = round(high, 4)
    report["passed"] = bool(games >= PASS_MIN_ROUNDS and rate >= GROUP_PASS_WIN_RATE)
    return report


def build_expert_model(env: MobFightEnv, cfg: TrainConfig) -> MaskablePPO:
    """Create the expert's masked PPO model from random weights."""
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
            "net_arch": {"pi": [EXPERT_HIDDEN, EXPERT_HIDDEN], "vf": [256, 256]},
            "activation_fn": nn.ReLU,
        },
        seed=cfg.seed,
        device="cpu",
        verbose=0,
    )


def train_expert(
    out: str,
    steps: int = 3_000_000,
    seed: int = 21,
    n_envs: int = 64,
    threads: int = 4,
    max_minutes: float = 9.0,
    max_rss_gb: float = 2.0,
    resume: bool = False,
) -> dict:
    """Train the expert through the mob curriculum and run its pass test."""
    limit_threads(threads)
    path = Path(out)
    path.mkdir(parents=True, exist_ok=True)
    cfg = TrainConfig(
        out=out,
        total_steps=steps,
        n_envs=n_envs,
        n_steps=128,
        batch_size=2048,
        seed=seed,
        threads=threads,
        max_minutes=max_minutes,
        max_rss_gb=max_rss_gb,
        stages=list(MOB_CURRICULUM),
    )
    env = MobFightEnv(n_envs, cfg.stages[0].mix, seed=seed)
    state: dict = {}
    if resume and (path / "model.zip").exists():
        state = json.loads((path / "state.json").read_text())
        model = MaskablePPO.load(path / "model.zip", env=env, device="cpu")
    else:
        model = build_expert_model(env, cfg)
    remaining = max(steps - state.get("steps", 0), 0)
    callback = CurriculumCallback(cfg, env, path, state)
    started = time.monotonic()
    if remaining > 0:
        model.learn(remaining, callback=callback, reset_num_timesteps=True)
    callback.model = model
    callback.save()
    expert = MobExpert.from_model(model, env)
    expert.save(path / "expert.npz")
    report = expert_report(expert)
    report["train"] = {
        "steps": callback.steps,
        "stage": cfg.stages[callback.stage_index].name,
        "minutes": round((time.monotonic() - started) / 60.0, 2),
        "peak_rss_gb": round(peak_rss_gb(), 3),
        "stopped_by": callback.stop_reason or "step budget",
        "seed": seed,
    }
    (path / "report.json").write_text(json.dumps(report, indent=2))
    return report


def main() -> int:
    """Train the expert, or run the farm check or the pass test."""
    parser = argparse.ArgumentParser(prog="fighter-mobs")
    commands = parser.add_subparsers(dest="command", required=True)
    train = commands.add_parser("train")
    train.add_argument("--out", required=True)
    train.add_argument("--steps", type=int, default=3_000_000)
    train.add_argument("--seed", type=int, default=21)
    train.add_argument("--envs", type=int, default=64)
    train.add_argument("--threads", type=int, default=4)
    train.add_argument("--minutes", type=float, default=9.0)
    train.add_argument("--max-rss-gb", type=float, default=2.0)
    train.add_argument("--resume", action="store_true")
    commands.add_parser("farm")
    check = commands.add_parser("pass")
    check.add_argument("--expert", required=True)
    args = parser.parse_args()
    if args.command == "train":
        result = train_expert(
            args.out, args.steps, args.seed, args.envs, args.threads, args.minutes, args.max_rss_gb, args.resume
        )
    elif args.command == "farm":
        result = farm_report()
    else:
        result = expert_report(MobExpert.load(args.expert))
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "FARM_BOTS",
    "FARM_LOOPS",
    "GROUPS",
    "GROUP_PASS_WIN_RATE",
    "MOB_CURRICULUM",
    "NUM_MOB_KINDS",
    "ROSTERS",
    "MobExpert",
    "MobFightEnv",
    "MobPool",
    "MOB_INTERFACE",
    "MobReward",
    "expert_actions",
    "expert_report",
    "farm_report",
    "fighter_bot",
    "group_report",
    "idle_bot",
    "load_mob_expert",
    "mob_extra_dim",
    "mob_features",
    "play_rounds",
    "route_actions",
    "train_expert",
]
