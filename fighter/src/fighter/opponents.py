"""Scripted opponents of rising difficulty and the opponent pool."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import actions as A
from . import constants as C
from .interface import SHARED, Interface
from .obs import build_masks, intercept_angles, view_angles, wrap_degrees
from .policy import NumpyPolicy
from .sim import Sim

MAX_SNAPSHOTS = 12
RETREAT_HEALTH = 8.0


def sample_masked(masks: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Pick a uniformly random allowed action on every head."""
    scores = rng.random(masks.shape) * masks
    out = np.zeros((len(masks), len(A.NVEC)), dtype=np.int64)
    for head, (start, size) in enumerate(zip(A.HEAD_OFFSETS, A.NVEC)):
        out[:, head] = scores[:, start : start + size].argmax(axis=1)
    return out


@dataclass
class Facts:
    """Noise free facts about one seat, computed once per step for all its opponents."""

    distance: np.ndarray
    want_yaw: np.ndarray
    want_pitch: np.ndarray
    aim: np.ndarray
    charged: np.ndarray
    grounded: np.ndarray
    falling: np.ndarray


@dataclass
class View:
    """Facts a scripted opponent reads from the simulator, for the arenas it owns."""

    distance: np.ndarray
    yaw_error: np.ndarray
    pitch_error: np.ndarray
    aim: np.ndarray
    charged: np.ndarray
    grounded: np.ndarray
    falling: np.ndarray


def read_facts(sim: Sim, seat: int) -> Facts:
    """Compute the shared facts of one seat."""
    other = 1 - seat
    delta = sim.pos[:, other] - sim.pos[:, seat]
    eye = sim.pos[:, seat] + np.array([0.0, C.EYE_HEIGHT, 0.0])
    chest = sim.pos[:, other] + np.array([0.0, C.PLAYER_HEIGHT / 2.0, 0.0])
    want_yaw, want_pitch = view_angles(chest - eye)
    return Facts(
        distance=np.hypot(delta[:, 0], delta[:, 2]),
        want_yaw=want_yaw,
        want_pitch=want_pitch,
        aim=sim.aim_hits()[:, seat],
        charged=sim.attack_multiplier()[:, seat] >= C.FULL_CHARGE_THRESHOLD,
        grounded=sim.on_ground[:, seat],
        falling=(sim.vel[:, seat, 1] < 0.0) & ~sim.on_ground[:, seat],
    )


def _rows(rows: np.ndarray | None):
    return slice(None) if rows is None else rows


def _count(sim: Sim, rows: np.ndarray | None) -> int:
    return sim.n if rows is None else len(rows)


def read_view(
    sim: Sim,
    seat: int,
    rng: np.random.Generator,
    noise: float,
    facts: Facts | None = None,
    rows: np.ndarray | None = None,
) -> View:
    """Return one opponent's view, drawing aim noise only for the arenas it owns."""
    if facts is None:
        facts = read_facts(sim, seat)
    at = _rows(rows)
    count = _count(sim, rows)
    yaw = facts.want_yaw[at]
    pitch = facts.want_pitch[at]
    if noise > 0.0:
        yaw = yaw + rng.normal(0.0, noise, count)
        pitch = pitch + rng.normal(0.0, noise, count)
    return View(
        distance=facts.distance[at],
        yaw_error=wrap_degrees(yaw - sim.yaw[at, seat]),
        pitch_error=pitch - sim.pitch[at, seat],
        aim=facts.aim[at],
        charged=facts.charged[at],
        grounded=facts.grounded[at],
        falling=facts.falling[at],
    )


def steer(a: np.ndarray, yaw_error: np.ndarray, pitch_error: np.ndarray) -> None:
    """Choose the look steps closest to a turn given in simulator angles."""
    a[:, A.YAW], a[:, A.PITCH] = A.turn_indices(yaw_error, pitch_error)


def chase(a: np.ndarray, view: View, stop: float = 2.4, retreat: float = 1.4) -> None:
    a[:, A.FORWARD] = np.select(
        [view.distance > stop, view.distance < retreat], [A.KEY_FORWARD, A.KEY_BACK], A.NEUTRAL_FORWARD
    )


def base(sim: Sim, seat: int, rng: np.random.Generator, noise: float, facts=None, rows=None):
    at = _rows(rows)
    view = read_view(sim, seat, rng, noise, facts, rows)
    held = sim.weapon[at, seat]
    a = A.neutral_actions(np.where(held <= C.AXE, held, C.SWORD))
    steer(a, view.yaw_error, view.pitch_error)
    return a, view


def idle(sim, seat, rng, facts=None, rows=None):
    return A.neutral_actions(np.full(_count(sim, rows), C.SWORD))


def random_player(sim, seat, rng, facts=None, rows=None):
    return sample_masked(build_masks(sim, seat, rows=rows), rng)


def walker(sim, seat, rng, facts=None, rows=None):
    a, view = base(sim, seat, rng, 6.0, facts, rows)
    chase(a, view)
    return a


def swinger(sim, seat, rng, facts=None, rows=None):
    a, view = base(sim, seat, rng, 4.0, facts, rows)
    chase(a, view)
    a[:, A.ATTACK] = view.aim & view.charged
    return a


def strafer(sim, seat, rng, facts=None, rows=None):
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.5, facts, rows)
    chase(a, view)
    phase = (sim.ticks[at] // 16 + seat) % 2
    near = view.distance < 5.0
    a[:, A.STRAFE] = np.where(near, A.KEY_LEFT + phase, A.NEUTRAL_STRAFE)
    tap = sim.sprint_held[at, seat] & ~sim.sprinting[at, seat]
    a[:, A.SPRINT] = (view.distance > 2.0) & ~tap
    a[:, A.ATTACK] = view.aim & view.charged
    return a


def critter(sim, seat, rng, facts=None, rows=None):
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    chase(a, view, stop=2.2)
    a[:, A.SPRINT] = view.distance > 4.0
    a[:, A.JUMP] = (view.distance < 4.0) & view.grounded & view.charged
    a[:, A.ATTACK] = view.aim & view.charged & (view.falling | (view.distance < 1.6))
    return a


def shielder(sim, seat, rng, facts=None, rows=None):
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    chase(a, view)
    other = 1 - seat
    threat = sim.attack_multiplier()[at, other] >= C.FULL_CHARGE_THRESHOLD
    ready = sim.shield_disabled[at, seat] == 0
    guard = (view.distance < 4.5) & threat & ready & ~(view.charged & view.aim)
    a[:, A.USE] = guard
    a[:, A.ATTACK] = view.aim & view.charged & ~guard
    a[:, A.SPRINT] = (view.distance > 3.0) & ~guard
    return a


def axeman(sim, seat, rng, facts=None, rows=None):
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    chase(a, view)
    other = 1 - seat
    shielded = sim.shield_active[at, other]
    a[:, A.WEAPON] = A.WEAPON_ACTION[np.where(shielded, C.AXE, C.SWORD)]
    holding_axe = sim.weapon[at, seat] == C.AXE
    a[:, A.ATTACK] = view.aim & (view.charged | (holding_axe & shielded))
    a[:, A.SPRINT] = view.distance > 3.0
    return a


def archer(sim, seat, rng, facts=None, rows=None):
    at = _rows(rows)
    view = read_view(sim, seat, rng, 1.0, facts, rows)
    close = view.distance < 3.5
    a = A.neutral_actions(np.where(close, C.SWORD, C.BOW))
    yaw, pitch, _ = intercept_angles(sim, seat, np.full(sim.n, C.BOW_MAX_SPEED))
    bow_yaw = wrap_degrees(yaw[at] - sim.yaw[at, seat])
    bow_pitch = pitch[at] - sim.pitch[at, seat]
    steer(
        a,
        np.where(close, view.yaw_error, bow_yaw),
        np.where(close, view.pitch_error, bow_pitch),
    )
    a[:, A.FORWARD] = np.select(
        [close, view.distance < 8.0, view.distance > 13.0],
        [A.KEY_FORWARD, A.KEY_BACK, A.KEY_FORWARD],
        A.NEUTRAL_FORWARD,
    )
    drawing = sim.weapon[at, seat] == C.BOW
    aimed = (np.abs(bow_yaw) < 3.0) & (np.abs(bow_pitch) < 3.0)
    full = sim.draw_ticks[at, seat] >= C.BOW_FULL_DRAW_TICKS
    a[:, A.USE] = drawing & ~(full & aimed) & ~close
    a[:, A.ATTACK] = close & view.aim & view.charged & ~drawing
    return a


def retreater(sim, seat, rng, facts=None, rows=None):
    """Fights until hurt, then runs, and turns back when caught or against the border."""
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    chase(a, view)
    from_center = np.abs(sim.pos[at, seat][:, [0, 2]] - sim.origin[[0, 2]]).max(axis=1)
    cornered = (sim.border_half - from_center < 1.5) | (view.distance < 2.0)
    hurt = (sim.hp[at, seat] <= RETREAT_HEALTH) & ~cornered
    run = hurt & (view.distance < 9.0)
    wait = hurt & ~run
    steer(
        a,
        np.where(run, wrap_degrees(view.yaw_error + 180.0), view.yaw_error),
        np.where(run, -sim.pitch[at, seat], view.pitch_error),
    )
    a[:, A.FORWARD] = np.select([run, wait], [A.KEY_FORWARD, A.NEUTRAL_FORWARD], a[:, A.FORWARD])
    a[:, A.SPRINT] = run | (~wait & (view.distance > 3.0))
    a[:, A.USE] = wait & (sim.shield_disabled[at, seat] == 0)
    a[:, A.ATTACK] = view.aim & view.charged & ~hurt
    return a


def hit_and_run(sim, seat, rng, facts=None, rows=None):
    """Closes while charged, lands one hit at long reach and backs off to recharge."""
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    closing = view.charged & (view.distance > 2.8)
    backing = ~view.charged & (view.distance < 5.5)
    a[:, A.FORWARD] = np.select([closing, backing], [A.KEY_FORWARD, A.KEY_BACK], A.NEUTRAL_FORWARD)
    a[:, A.SPRINT] = closing
    phase = (sim.ticks[at] // 16 + seat) % 2
    a[:, A.STRAFE] = np.where(view.charged, A.NEUTRAL_STRAFE, A.KEY_LEFT + phase)
    a[:, A.ATTACK] = view.aim & view.charged
    return a


def rusher(sim, seat, rng, facts=None, rows=None):
    """Holds at range and charges whenever the enemy draws a bow or loads a crossbow."""
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    other = 1 - seat
    rush = (sim.load_ticks[at, other] > 0) | (sim.draw_ticks[at, other] > 0) | (view.distance < 3.5)
    a[:, A.FORWARD] = np.select(
        [rush & (view.distance > 2.2), rush & (view.distance < 1.4), ~rush & (view.distance > 7.0), ~rush & (view.distance < 5.0)],
        [A.KEY_FORWARD, A.KEY_BACK, A.KEY_FORWARD, A.KEY_BACK],
        A.NEUTRAL_FORWARD,
    )
    a[:, A.SPRINT] = rush & (view.distance > 2.2)
    phase = (sim.ticks[at] // 16 + seat) % 2
    a[:, A.STRAFE] = np.where(rush, A.NEUTRAL_STRAFE, A.KEY_LEFT + phase)
    a[:, A.ATTACK] = view.aim & view.charged
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
    "retreater": retreater,
    "hit_and_run": hit_and_run,
    "rusher": rusher,
}

LEAGUE = "league"


class OpponentPool:
    """Assigns one opponent per arena and produces its actions."""

    allowed: np.ndarray | None = None

    def __init__(self, n: int, seed: int = 0, max_ticks: int = 600, interface: Interface | None = None):
        self.n = n
        self.interface = interface or SHARED
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
        facts = read_facts(sim, seat)
        for i, name in enumerate(self.names):
            rows = np.flatnonzero(self.assigned == i)
            if len(rows) == 0:
                continue
            if name == LEAGUE:
                self._act_league(sim, seat, rows, out, facts)
            else:
                out[rows] = SCRIPTED[name](sim, seat, self.rng, facts, rows)
        return out

    def _act_league(self, sim: Sim, seat: int, rows: np.ndarray, out: np.ndarray, facts: Facts) -> None:
        fallback = rows[self.snapshot_of[rows] < 0]
        if len(fallback):
            out[fallback] = swinger(sim, seat, self.rng, facts, fallback)
        picked = rows[self.snapshot_of[rows] >= 0]
        if len(picked) == 0:
            return
        obs = np.clip(self.interface.observe(sim, seat, self.max_ticks, picked), -5.0, 5.0)
        masks = self.interface.masks(sim, seat, self.allowed, rows=picked)
        chosen = self.snapshot_of[picked]
        shared = len(A.NVEC)
        for snap in np.unique(chosen):
            here = chosen == snap
            acted = self.snapshots[snap].act(obs[here], masks[here], self.rng)
            out[picked[here]] = acted[:, :shared]
            if self.interface.apply is not None:
                self.interface.apply(sim, seat, acted[:, shared:], picked[here])
