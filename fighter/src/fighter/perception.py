"""What each player knows about the fight, kept per seat from what a client can observe."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import actions as A
from . import constants as C

NEVER = 100
WHIFF_PUNISH_WINDOW = 20
CHEST_HEIGHT = 1.2
FEET_HEIGHT = 0.1
BODY_LINES = 3
SIGHT_LINES = 4
CROSSHAIR_REACH = 64.0


@dataclass
class EnemySight:
    """Where one seat believes the enemy is, for the selected arenas."""

    pos: np.ndarray
    move: np.ndarray
    visible: np.ndarray | bool
    chest_clear: np.ndarray | bool
    crosshair_clear: np.ndarray | bool


class Perception:
    """Event counters and the last place each seat saw the other."""

    def __init__(self, sim) -> None:
        n = sim.n
        self.sim = sim
        self.seen_pos = np.zeros((n, 2, 3))
        self.seen_move = np.zeros((n, 2, 3))
        self.since_hit = np.full((n, 2), NEVER, dtype=np.int64)
        self.since_hurt = np.full((n, 2), NEVER, dtype=np.int64)
        self.since_disabled = np.full((n, 2), NEVER, dtype=np.int64)
        self.since_enemy_swing = np.full((n, 2), NEVER, dtype=np.int64)
        self.since_whiff = np.full((n, 2), NEVER, dtype=np.int64)
        self.combo = np.zeros((n, 2), dtype=np.int64)
        self.fresh_combo = np.ones((n, 2), dtype=bool)
        self.enemy_health = np.full((n, 2), C.MAX_HEALTH)
        self.last_action = np.tile(A.idle_action(), (n, 2, 1))

    def reset(self, idx: np.ndarray) -> None:
        """Forget the selected arenas at round start."""
        sim = self.sim
        self.seen_pos[idx] = sim.pos[idx][:, ::-1]
        self.seen_move[idx] = 0.0
        self.since_hit[idx] = NEVER
        self.since_hurt[idx] = NEVER
        self.since_disabled[idx] = NEVER
        self.since_enemy_swing[idx] = NEVER
        self.since_whiff[idx] = NEVER
        self.combo[idx] = 0
        self.fresh_combo[idx] = True
        self.enemy_health[idx] = C.MAX_HEALTH
        self.last_action[idx] = A.idle_action()

    def after_step(self, actions: np.ndarray, ticks: int) -> None:
        """Update the counters from one decision's events."""
        events = self.sim.events
        for counter in (
            self.since_hit, self.since_hurt, self.since_disabled, self.since_enemy_swing, self.since_whiff,
        ):
            counter += ticks
        hurt = events["damage_taken"] > 0.0
        hit = (events["hits"] + events["arrow_hits"]) > 0.0
        swung = events["swings"][:, ::-1] > 0.0
        landed = (events["hits"] + events["melee_blocked"])[:, ::-1] > 0.0
        self.since_disabled[events["shield_breaks"][:, ::-1] > 0.0] = 0
        self.since_enemy_swing[swung] = 0
        if hurt.any():
            self.since_hurt[hurt] = 0
            self.combo[hurt] = 0
            self.fresh_combo[hurt] = True
        if hit.any():
            self.since_hit[hit] = 0
            self.combo[hit] = np.where(self.fresh_combo[hit], 1, self.combo[hit] + 1)
            self.fresh_combo[hit] = False
            self.since_whiff[hit & (self.since_whiff <= WHIFF_PUNISH_WINDOW)] = NEVER
        self.since_whiff[swung & ~landed] = 0
        self.enemy_health = np.maximum(self.enemy_health - events["damage_dealt"], 0.0)
        np.copyto(self.last_action, actions[..., : len(A.NVEC)])

    def refresh(self, rows: np.ndarray | None = None) -> None:
        """Run the sight lines of the selected arenas, as part of the sight update."""
        sim = self.sim
        if sim.world is None:
            return
        picked = np.arange(sim.n) if rows is None else np.asarray(rows)
        if len(picked) == 0:
            return
        eyes = sim.eyes()[picked]
        feet = sim.pos[picked][:, ::-1]
        heads = np.broadcast_to(sim.body.eyes(), (sim.n, 2))[picked][:, ::-1]
        look = sim.look()[picked]
        low, high = sim.boxes()
        step = np.where(np.abs(look) < 1e-9, 1e-9, look)
        first = (low[picked][:, ::-1] - eyes) / step
        second = (high[picked][:, ::-1] - eyes) / step
        entry = np.maximum(np.minimum(first, second).max(axis=-1), 0.0)
        aimed = (np.maximum(first, second).min(axis=-1) >= entry) & (entry <= CROSSHAIR_REACH)
        targets = np.repeat(feet[:, :, None, :], SIGHT_LINES, axis=2)
        targets[..., 0, 1] += CHEST_HEIGHT
        targets[..., 1, 1] += heads
        targets[..., 2, 1] += FEET_HEIGHT
        targets[..., 3, 1] += CHEST_HEIGHT
        hit_point = eyes + look * entry[..., None]
        targets[:, :, 3] = np.where(aimed[..., None], hit_point, targets[:, :, 3])
        view = sim.world_view()
        view.update_lines(picked, eyes, sim.yaw[picked], sim.pitch[picked], targets)
        for seat in (0, 1):
            shown = picked[view.lines_seen(picked, seat, BODY_LINES).any(axis=1)]
            self.seen_pos[shown, seat] = sim.pos[shown, 1 - seat]
            self.seen_move[shown, seat] = sim.body.last_move[shown, 1 - seat]

    def enemy(self, seat: int, at) -> EnemySight:
        """Return the enemy as this seat knows it, from its last sight update."""
        sim = self.sim
        you = 1 - seat
        if sim.world is None:
            return EnemySight(sim.pos[at, you], sim.body.last_move[at, you], True, True, True)
        rows = np.arange(sim.n)[at]
        clear = sim.world_view().lines_seen(rows, seat, SIGHT_LINES)
        visible = clear[:, :BODY_LINES].any(axis=1)
        return EnemySight(
            self.seen_pos[rows, seat].copy(), self.seen_move[rows, seat].copy(), visible, clear[:, 0], clear[:, 3]
        )

    def known_position(self, seat: int, at) -> np.ndarray:
        """Return the last known enemy feet without refreshing sight."""
        sim = self.sim
        if sim.world is None:
            return sim.pos[at, 1 - seat]
        return self.seen_pos[at, seat]
