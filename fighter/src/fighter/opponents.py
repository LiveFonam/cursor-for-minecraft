"""Scripted opponents of rising difficulty and the opponent pool."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import actions as A
from . import constants as C
from .obs import build_masks, build_obs, intercept_angles, view_angles, wrap_degrees
from .policy import NumpyPolicy
from .sim import Sim

MAX_SNAPSHOTS = 12


def sample_masked(masks: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Pick a uniformly random allowed action on every head."""
    scores = rng.random(masks.shape) * masks
    out = np.zeros((len(masks), len(A.NVEC)), dtype=np.int64)
    for head, (start, size) in enumerate(zip(A.HEAD_OFFSETS, A.NVEC)):
        out[:, head] = scores[:, start : start + size].argmax(axis=1)
    return out


@dataclass
class View:
    """Facts a scripted opponent reads from the simulator."""

    distance: np.ndarray
    yaw_error: np.ndarray
    pitch_error: np.ndarray
    aim: np.ndarray
    charged: np.ndarray
    grounded: np.ndarray
    falling: np.ndarray


def read_view(sim: Sim, seat: int, rng: np.random.Generator, noise: float) -> View:
    other = 1 - seat
    delta = sim.pos[:, other] - sim.pos[:, seat]
    eye = sim.pos[:, seat] + np.array([0.0, C.EYE_HEIGHT, 0.0])
    chest = sim.pos[:, other] + np.array([0.0, C.PLAYER_HEIGHT / 2.0, 0.0])
    yaw, pitch = view_angles(chest - eye)
    if noise > 0.0:
        yaw = yaw + rng.normal(0.0, noise, sim.n)
        pitch = pitch + rng.normal(0.0, noise, sim.n)
    return View(
        distance=np.hypot(delta[:, 0], delta[:, 2]),
        yaw_error=wrap_degrees(yaw - sim.yaw[:, seat]),
        pitch_error=pitch - sim.pitch[:, seat],
        aim=sim.aim_hits()[:, seat],
        charged=sim.attack_multiplier()[:, seat] >= C.FULL_CHARGE_THRESHOLD,
        grounded=sim.on_ground[:, seat],
        falling=(sim.vel[:, seat, 1] < 0.0) & ~sim.on_ground[:, seat],
    )


def steer(a: np.ndarray, yaw_error: np.ndarray, pitch_error: np.ndarray) -> None:
    a[:, A.YAW] = A.nearest_index(A.YAW_DELTAS, yaw_error)
    a[:, A.PITCH] = A.nearest_index(A.PITCH_DELTAS, pitch_error)


def chase(a: np.ndarray, view: View, stop: float = 2.4, retreat: float = 1.4) -> None:
    a[:, A.FORWARD] = np.select([view.distance > stop, view.distance < retreat], [2, 0], 1)


def base(sim: Sim, seat: int, rng: np.random.Generator, noise: float):
    view = read_view(sim, seat, rng, noise)
    a = A.neutral_actions(sim.weapon[:, seat].copy())
    a[:, A.WEAPON] = np.where(sim.weapon[:, seat] <= C.AXE, sim.weapon[:, seat], C.SWORD)
    steer(a, view.yaw_error, view.pitch_error)
    return a, view


def idle(sim, seat, rng):
    return A.neutral_actions(np.full(sim.n, C.SWORD))


def random_player(sim, seat, rng):
    return sample_masked(build_masks(sim, seat), rng)


def walker(sim, seat, rng):
    a, view = base(sim, seat, rng, 6.0)
    chase(a, view)
    return a


def swinger(sim, seat, rng):
    a, view = base(sim, seat, rng, 4.0)
    chase(a, view)
    a[:, A.ATTACK] = view.aim & view.charged
    return a


def strafer(sim, seat, rng):
    a, view = base(sim, seat, rng, 2.5)
    chase(a, view)
    phase = (sim.ticks // 16 + seat) % 2
    near = view.distance < 5.0
    a[:, A.STRAFE] = np.where(near, phase * 2, A.NEUTRAL_STRAFE)
    tap = sim.sprint_held[:, seat] & ~sim.sprinting[:, seat]
    a[:, A.SPRINT] = (view.distance > 2.0) & ~tap
    a[:, A.ATTACK] = view.aim & view.charged
    return a


def critter(sim, seat, rng):
    a, view = base(sim, seat, rng, 2.0)
    chase(a, view, stop=2.2)
    a[:, A.SPRINT] = view.distance > 4.0
    a[:, A.JUMP] = (view.distance < 4.0) & view.grounded & view.charged
    a[:, A.ATTACK] = view.aim & view.charged & (view.falling | (view.distance < 1.6))
    return a


def shielder(sim, seat, rng):
    a, view = base(sim, seat, rng, 2.0)
    chase(a, view)
    other = 1 - seat
    threat = sim.attack_multiplier()[:, other] >= C.FULL_CHARGE_THRESHOLD
    ready = sim.shield_disabled[:, seat] == 0
    guard = (view.distance < 4.5) & threat & ready & ~(view.charged & view.aim)
    a[:, A.USE] = guard
    a[:, A.ATTACK] = view.aim & view.charged & ~guard
    a[:, A.SPRINT] = (view.distance > 3.0) & ~guard
    return a


def axeman(sim, seat, rng):
    a, view = base(sim, seat, rng, 2.0)
    chase(a, view)
    other = 1 - seat
    shielded = sim.shield_active[:, other]
    a[:, A.WEAPON] = np.where(shielded, C.AXE, C.SWORD)
    holding_axe = sim.weapon[:, seat] == C.AXE
    a[:, A.ATTACK] = view.aim & (view.charged | (holding_axe & shielded))
    a[:, A.SPRINT] = view.distance > 3.0
    return a


def archer(sim, seat, rng):
    view = read_view(sim, seat, rng, 1.0)
    a = A.neutral_actions(sim.weapon[:, seat].copy())
    close = view.distance < 3.5
    a[:, A.WEAPON] = np.where(close, C.SWORD, C.BOW)
    yaw, pitch, _ = intercept_angles(sim, seat, np.full(sim.n, C.BOW_MAX_SPEED))
    bow_yaw = wrap_degrees(yaw - sim.yaw[:, seat])
    bow_pitch = pitch - sim.pitch[:, seat]
    steer(
        a,
        np.where(close, view.yaw_error, bow_yaw),
        np.where(close, view.pitch_error, bow_pitch),
    )
    a[:, A.FORWARD] = np.select([close, view.distance < 8.0, view.distance > 13.0], [2, 0, 2], 1)
    drawing = sim.weapon[:, seat] == C.BOW
    aimed = (np.abs(bow_yaw) < 3.0) & (np.abs(bow_pitch) < 3.0)
    full = sim.draw_ticks[:, seat] >= C.BOW_FULL_DRAW_TICKS
    a[:, A.USE] = drawing & ~(full & aimed) & ~close
    a[:, A.ATTACK] = close & view.aim & view.charged & ~drawing
    return a


SCRIPTED = {
    "idle": idle,
    "random": random_player,
    "walker": walker,
    "swinger": swinger,
    "strafer": strafer,
    "critter": critter,
    "shielder": shielder,
    "axeman": axeman,
    "archer": archer,
}

LEAGUE = "league"


class OpponentPool:
    """Assigns one opponent per arena and produces its actions."""

    def __init__(self, n: int, seed: int = 0, max_ticks: int = 600):
        self.n = n
        self.rng = np.random.default_rng(seed)
        self.max_ticks = max_ticks
        self.names: list[str] = ["idle"]
        self.probs = np.array([1.0])
        self.assigned = np.zeros(n, dtype=np.int64)
        self.snapshot_of = np.full(n, -1, dtype=np.int64)
        self.snapshots: list[NumpyPolicy] = []
        self.games = np.zeros(MAX_SNAPSHOTS)
        self.wins = np.zeros(MAX_SNAPSHOTS)

    def set_mix(self, mix: dict[str, float]) -> None:
        """Set the opponent names and their sampling weights."""
        self.names = list(mix)
        weights = np.array([mix[name] for name in self.names], dtype=float)
        self.probs = weights / weights.sum()
        self.assign(np.ones(self.n, dtype=bool))

    def add_snapshot(self, policy: NumpyPolicy) -> None:
        """Add a past version, dropping the oldest when the league is full."""
        if len(self.snapshots) == MAX_SNAPSHOTS:
            self.snapshots.pop(0)
            self.games = np.append(self.games[1:], 0.0)
            self.wins = np.append(self.wins[1:], 0.0)
            self.snapshot_of = np.maximum(self.snapshot_of - 1, -1)
        self.snapshots.append(policy)

    def _snapshot_probs(self) -> np.ndarray:
        count = len(self.snapshots)
        rate = (self.wins[:count] + 1.0) / (self.games[:count] + 2.0)
        weight = (1.0 - rate) ** 2 + 0.05
        return weight / weight.sum()

    def assign(self, mask: np.ndarray) -> None:
        """Draw a new opponent for the selected arenas."""
        idx = np.flatnonzero(mask)
        if len(idx) == 0:
            return
        self.assigned[idx] = self.rng.choice(len(self.names), size=len(idx), p=self.probs)
        self.snapshot_of[idx] = -1
        if self.snapshots and LEAGUE in self.names:
            league = self.names.index(LEAGUE)
            picks = idx[self.assigned[idx] == league]
            if len(picks):
                self.snapshot_of[picks] = self.rng.choice(
                    len(self.snapshots), size=len(picks), p=self._snapshot_probs()
                )

    def record(self, idx: np.ndarray, won: np.ndarray) -> None:
        """Update league win rates for finished games."""
        for env, result in zip(idx, won):
            snap = self.snapshot_of[env]
            if snap >= 0:
                self.games[snap] += 1.0
                self.wins[snap] += float(result)

    def name_of(self, env: int) -> str:
        """Return the opponent name of one arena."""
        return self.names[self.assigned[env]]

    def act(self, sim: Sim, seat: int) -> np.ndarray:
        """Return one action per arena for the opponent seat."""
        out = A.neutral_actions(sim.weapon[:, seat].copy())
        for i, name in enumerate(self.names):
            mask = self.assigned == i
            if not mask.any():
                continue
            if name == LEAGUE:
                self._act_league(sim, seat, mask, out)
            else:
                out[mask] = SCRIPTED[name](sim, seat, self.rng)[mask]
        return out

    def _act_league(self, sim: Sim, seat: int, mask: np.ndarray, out: np.ndarray) -> None:
        fallback = mask & (self.snapshot_of < 0)
        if fallback.any():
            out[fallback] = swinger(sim, seat, self.rng)[fallback]
        chosen = self.snapshot_of[mask & (self.snapshot_of >= 0)]
        if len(chosen) == 0:
            return
        obs = build_obs(sim, seat, self.max_ticks)
        masks = build_masks(sim, seat)
        for snap in np.unique(chosen):
            pick = mask & (self.snapshot_of == snap)
            out[pick] = self.snapshots[snap].act(obs[pick], masks[pick], self.rng)
