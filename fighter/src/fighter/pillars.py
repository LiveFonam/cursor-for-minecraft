"""Solid pillars in the flat arena, a fresh layout for every arena and round.

A round has 1 or 2 pairs. A pillar covers 1x1, 2x1 or 1x2 blocks and stands 2 or 3 tall. Each
pair is mirrored across the plane x = 0, and the two spawns are mirrored across it too, so both
players start with the same cover. A pillar over blocks x to x+w has its twin over -x-w-1 to -x-1.
"""

from __future__ import annotations

import numpy as np

from . import constants as C

MAX_PILLARS = 4
SPAWN_CLEAR_X = 2.5
SPAWN_CLEAR_Z = 6.0
PLACE_TRIES = 200
CONTACT = 1e-7
SMALLEST_STEP = 1e-12


def draw_layout(rng: np.random.Generator, half: int, spot_x: float, spot_z: float) -> list[tuple[int, int, int, int, int]]:
    """Return (x, z, w, d, h) of every pillar of one round, with spawns at (+-spot_x, spot_z)."""

    def draw(low: int, high: int) -> int:
        return int(rng.integers(low, high + 1))

    def clear(x: int, z: int, w: int, d: int) -> bool:
        return all(
            x + w < spot - SPAWN_CLEAR_X
            or x > spot + SPAWN_CLEAR_X
            or z + d < spot_z - SPAWN_CLEAR_Z
            or z > spot_z + SPAWN_CLEAR_Z
            for spot in (spot_x, -spot_x)
        )

    boxes: list[tuple[int, int, int, int, int]] = []
    for _ in range(draw(1, 2)):
        w = draw(0, 1)
        d = 0 if w else draw(0, 1)
        h = draw(2, 3)
        for _ in range(PLACE_TRIES):
            x = draw(-half + 1, half - 2 - w)
            z = draw(-half + 1, half - 1 - d)
            twin = -x - w - 1
            apart = twin > x + w or twin + w < x
            if apart and clear(x, z, w, d) and clear(twin, z, w, d):
                boxes += [(x, z, w, d, h), (twin, z, w, d, h)]
                break
    return boxes


class Pillars:
    """The pillar boxes of every arena, with the ray, sight and body tests against them."""

    def __init__(self, n: int, arena_half: float):
        self.n = n
        self.half = int(arena_half)
        self.low = np.zeros((n, MAX_PILLARS, 3))
        self.high = np.zeros((n, MAX_PILLARS, 3))
        self.on = np.zeros((n, MAX_PILLARS), dtype=bool)

    def place(self, rng: np.random.Generator, idx: np.ndarray, spot_x: np.ndarray, spot_z: np.ndarray) -> None:
        """Draw a new layout for the selected arenas."""
        self.on[idx] = False
        for env, x_spot, z_spot in zip(idx.tolist(), spot_x.tolist(), spot_z.tolist()):
            self.set_boxes(env, draw_layout(rng, self.half, x_spot, z_spot))

    def set_boxes(self, env: int, boxes: list[tuple[int, int, int, int, int]]) -> None:
        """Install the given (x, z, w, d, h) pillars in one arena."""
        self.on[env] = False
        for slot, (x, z, w, d, h) in enumerate(boxes):
            self.low[env, slot] = (x, 0.0, z)
            self.high[env, slot] = (x + w + 1, h, z + d + 1)
            self.on[env, slot] = True

    def _aligned(self, rows: np.ndarray, ndim: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Return the boxes of the given arenas shaped to broadcast with (arenas, ..., boxes, 3)."""
        shape = (len(rows),) + (1,) * (ndim - 2) + (MAX_PILLARS,)
        return self.low[rows].reshape(shape + (3,)), self.high[rows].reshape(shape + (3,)), self.on[rows].reshape(shape)

    def first_fraction(self, rows: np.ndarray, start: np.ndarray, delta: np.ndarray) -> np.ndarray:
        """Return how far along each segment the first pillar starts, or infinity.

        start and delta have shape (arenas, ..., 3). A segment that starts inside a pillar stops at 0.
        """
        low, high, on = self._aligned(rows, delta.ndim)
        origin = start[..., None, :]
        step = delta[..., None, :]
        safe = np.where(np.abs(step) < SMALLEST_STEP, SMALLEST_STEP, step)
        first = (low - origin) / safe
        second = (high - origin) / safe
        near = np.maximum(np.minimum(first, second).max(axis=-1), 0.0)
        far = np.maximum(first, second).min(axis=-1)
        met = on & (far >= near) & (near <= 1.0)
        return np.where(met, near, np.inf).min(axis=-1)

    def limit_rays(self, rows: np.ndarray, eye: np.ndarray, directions: np.ndarray, free: np.ndarray) -> np.ndarray:
        """Shorten free ray distances of shape (arenas, rays) to the first pillar."""
        length = np.maximum(free, SMALLEST_STEP)
        along = self.first_fraction(rows, eye[:, None, :], directions * length[..., None])
        return np.where(np.isfinite(along), along * length, free)

    def clear_lines(self, rows: np.ndarray, eyes: np.ndarray, targets: np.ndarray) -> np.ndarray:
        """Return which lines from eyes (arenas, seats, 3) to targets (arenas, seats, lines, 3) are open."""
        start = eyes[:, :, None, :]
        return np.isinf(self.first_fraction(rows, start, targets - start))

    def view_open(
        self,
        rows: np.ndarray,
        eye: np.ndarray,
        look: np.ndarray,
        box_low: np.ndarray,
        box_high: np.ndarray,
        reach: float = C.ATTACK_REACH,
    ) -> np.ndarray:
        """Return where no pillar stands before the view ray enters the target box."""
        step = np.where(np.abs(look) < 1e-9, 1e-9, look)
        first = (box_low - eye) / step
        second = (box_high - eye) / step
        entry = np.maximum(np.minimum(first, second).max(axis=-1), 0.0)
        return ~(self.first_fraction(rows, eye, look * reach) * reach < entry)

    def solid_at(self, x: np.ndarray, y: np.ndarray, z: np.ndarray) -> np.ndarray:
        """Return which points of shape (arenas, ...) are inside a pillar."""
        x, y, z = np.broadcast_arrays(x, y, z)
        low, high, on = self._aligned(np.arange(self.n), x.ndim + 1)
        return (
            on
            & (x[..., None] >= low[..., 0])
            & (x[..., None] < high[..., 0])
            & (y[..., None] >= low[..., 1])
            & (y[..., None] < high[..., 1])
            & (z[..., None] >= low[..., 2])
            & (z[..., None] < high[..., 2])
        ).any(axis=-1)

    def floor_under(self, pos: np.ndarray, width: float = C.PLAYER_WIDTH) -> np.ndarray:
        """Return the highest surface at or below each body of shape (arenas, seats, 3)."""
        half = width / 2.0
        low = self.low[:, None]
        high = self.high[:, None]
        spot = pos[:, :, None, :]
        under = (
            self.on[:, None]
            & (spot[..., 0] + half > low[..., 0] + CONTACT)
            & (spot[..., 0] - half < high[..., 0] - CONTACT)
            & (spot[..., 2] + half > low[..., 2] + CONTACT)
            & (spot[..., 2] - half < high[..., 2] - CONTACT)
            & (high[..., 1] <= spot[..., 1] + CONTACT)
        )
        return np.where(under, high[..., 1], 0.0).max(axis=-1)

    def _clip(self, low: np.ndarray, high: np.ndarray, move: np.ndarray, axis: int) -> np.ndarray:
        """Shorten a move along one axis so the body boxes stop at the first pillar."""
        wall_low = self.low[:, None]
        wall_high = self.high[:, None]
        body_low = low[:, :, None, :]
        body_high = high[:, :, None, :]
        facing = np.broadcast_to(self.on[:, None], (len(low), low.shape[1], MAX_PILLARS)).copy()
        for other in (0, 1, 2):
            if other != axis:
                facing &= (body_high[..., other] > wall_low[..., other] + CONTACT) & (
                    body_low[..., other] < wall_high[..., other] - CONTACT
                )
        ahead = wall_low[..., axis] - body_high[..., axis]
        behind = wall_high[..., axis] - body_low[..., axis]
        most = np.where(facing & (ahead >= -CONTACT), ahead, np.inf).min(axis=-1)
        least = np.where(facing & (behind <= CONTACT), behind, -np.inf).max(axis=-1)
        return np.where(
            move > 0.0,
            np.minimum(move, np.maximum(most, 0.0)),
            np.where(move < 0.0, np.maximum(move, np.minimum(least, 0.0)), move),
        )

    def collide(self, pos: np.ndarray, delta: np.ndarray, heights: np.ndarray, width: float = C.PLAYER_WIDTH) -> np.ndarray:
        """Return the part of each body's move that the pillars allow.

        The game resolves the vertical axis first and then the larger horizontal axis.
        """
        half = width / 2.0
        low = pos + np.array([-half, 0.0, -half])
        high = pos + np.array([half, 0.0, half])
        high[..., 1] = pos[..., 1] + heights
        move = delta.copy()
        move[..., 1] = self._clip(low, high, move[..., 1], 1)
        low[..., 1] += move[..., 1]
        high[..., 1] += move[..., 1]
        x_first = np.abs(delta[..., 0]) >= np.abs(delta[..., 2])
        for turn in (True, False):
            for axis in (0, 2):
                picked = x_first if (axis == 0) == turn else ~x_first
                if not picked.any():
                    continue
                clipped = self._clip(low, high, move[..., axis], axis)
                move[..., axis] = np.where(picked, clipped, move[..., axis])
                shift = np.where(picked, move[..., axis], 0.0)
                low[..., axis] += shift
                high[..., axis] += shift
        return move
