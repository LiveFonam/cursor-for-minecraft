"""What each body has seen. The only world module observations, masks and critics may import.

Every answer comes from a body's seen block memory. A remembered block can be
stale, and a cell never seen reads as unknown.
"""

from __future__ import annotations

import ctypes as ct

import numpy as np

from .blocks import AIR as _AIR
from .blocks import BLOCKS as _BLOCKS
from .blocks import COBWEB as _COBWEB
from .blocks import FIRE as _FIRE
from .blocks import LAVA as _LAVA
from .blocks import WATER as _WATER
from .blocks import BLOCK_ID as _BLOCK_ID
from .kernel import Arenas as _Arenas
from .kernel import lib as _lib

UNKNOWN = 0
AIR_CLASS = _AIR + 1
WATER_CLASS = _WATER + 1
LAVA_CLASS = _LAVA + 1
COBWEB_CLASS = _COBWEB + 1
FIRE_CLASS = _FIRE + 1
SOLID_BY_CLASS = np.zeros(256, dtype=bool)
SOLID_BY_CLASS[1 : len(_BLOCKS) + 1] = [_block.solid for _block in _BLOCKS]
RAY_CLEAR = 0
RAY_BLOCKED = 1
RAY_UNKNOWN = 2
DEFAULT_SIGHT_RANGE = 8
_LAVA_CLASS = _BLOCK_ID["lava"] + 1
_FIRE_CLASS = _BLOCK_ID["fire"] + 1


def block_class(block: int) -> int:
    """Return the memory class of a block id."""
    return block + 1


def _vec(values) -> ct.Array:
    return (ct.c_double * 3)(float(values[0]), float(values[1]), float(values[2]))


class WorldView:
    """Seen block memory of every body in a batch of arenas."""

    __slots__ = ("_arenas", "_lib", "sight_range")

    def __init__(self, arenas: _Arenas, sight_range: int = DEFAULT_SIGHT_RANGE):
        self._arenas = arenas
        self._lib = _lib()
        self.sight_range = sight_range

    def update(self, arena: int, seat: int, eye, yaw: float, pitch: float) -> None:
        """Refresh one body's memory from its eye, once per decision."""
        self._lib.w_see(
            self._arenas.handles[arena], seat, float(eye[0]), float(eye[1]), float(eye[2]),
            float(yaw), float(pitch), self.sight_range,
        )

    def update_all(self, eyes: np.ndarray, yaw: np.ndarray, pitch: np.ndarray) -> None:
        """Refresh every body from arrays of shape (n, seats, ...)."""
        double = ct.POINTER(ct.c_double)
        eyes = np.ascontiguousarray(eyes, dtype=np.float64)
        yaw = np.ascontiguousarray(yaw, dtype=np.float64)
        pitch = np.ascontiguousarray(pitch, dtype=np.float64)
        self._lib.see_many(
            self._arenas.handles, eyes.shape[0], eyes.shape[1], eyes.ctypes.data_as(double),
            yaw.ctypes.data_as(double), pitch.ctypes.data_as(double), self.sight_range,
        )

    def crop(self, arena: int, seat: int, rx: int, ry: int, rz: int) -> np.ndarray:
        """Return classes around the body as (2rx+1, 2rz+1, 2ry+1), with 0 as unknown."""
        out = np.zeros((2 * rx + 1, 2 * rz + 1, 2 * ry + 1), dtype=np.uint8)
        self._lib.view_crop(
            self._arenas.handles[arena], seat, out.ctypes.data_as(ct.POINTER(ct.c_uint8)), rx, ry, rz,
        )
        return out

    def crop_all(self, seats: int, rx: int, ry: int, rz: int) -> np.ndarray:
        """Return every body's crop as (n, seats, 2rx+1, 2rz+1, 2ry+1)."""
        out = np.zeros((self._arenas.n, seats, 2 * rx + 1, 2 * rz + 1, 2 * ry + 1), dtype=np.uint8)
        self._lib.crop_many(
            self._arenas.handles, self._arenas.n, seats, out.ctypes.data_as(ct.POINTER(ct.c_uint8)), rx, ry, rz,
        )
        return out

    def ray(self, arena: int, seat: int, origin, direction, max_distance: float) -> tuple[float, int]:
        """Return the distance to the first remembered blocker or unknown cell, and the stop kind."""
        dist = ct.c_double(0.0)
        kind = self._lib.view_ray(
            self._arenas.handles[arena], seat, _vec(origin), _vec(direction), max_distance, ct.byref(dist),
        )
        return float(dist.value), int(kind)

    def rays(self, arena: int, seat: int, origin, directions: np.ndarray, max_distance: float) -> tuple[np.ndarray, np.ndarray]:
        """Answer a fan of rays. Return distances and an unknown flag per ray."""
        dist = np.zeros(len(directions))
        unknown = np.zeros(len(directions), dtype=bool)
        for i, direction in enumerate(directions):
            d, kind = self.ray(arena, seat, origin, direction, max_distance)
            dist[i] = d
            unknown[i] = kind == RAY_UNKNOWN
        return dist, unknown

    def rays_many(
        self, rows: np.ndarray, seat: int, eyes: np.ndarray, directions: np.ndarray, max_distance: float
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Answer one fan of rays per selected arena in a single call.

        Return the free distance, whether the ray stopped at lava or fire, and the
        distance to the first water surface, or -1. Rays stop at unknown cells.
        """
        double = ct.POINTER(ct.c_double)
        picked = np.ascontiguousarray(rows, dtype=np.int32)
        eyes = np.ascontiguousarray(eyes, dtype=np.float64)
        directions = np.ascontiguousarray(directions, dtype=np.float64)
        count, fan = directions.shape[:2]
        dist = np.empty((count, fan))
        kind = np.empty((count, fan), dtype=np.uint8)
        water = np.empty((count, fan))
        self._lib.view_rays_many(
            self._arenas.handles, picked.ctypes.data_as(ct.POINTER(ct.c_int32)), count, seat,
            eyes.ctypes.data_as(double), directions.ctypes.data_as(double), fan, max_distance,
            dist.ctypes.data_as(double), kind.ctypes.data_as(ct.POINTER(ct.c_uint8)), water.ctypes.data_as(double),
        )
        return dist, (kind == _LAVA_CLASS) | (kind == _FIRE_CLASS), water

    def update_lines(
        self, rows: np.ndarray, eyes: np.ndarray, yaw: np.ndarray, pitch: np.ndarray, targets: np.ndarray
    ) -> None:
        """Record which sight lines to points are open, as part of the sight update.

        Arrays have shape (arenas, seats, ...), and targets (arenas, seats, lines, 3).
        Inside the field of view a line stops at the first opaque block the eye
        meets. Outside it only remembered opaque blocks stop the line.
        """
        double = ct.POINTER(ct.c_double)
        picked = np.ascontiguousarray(rows, dtype=np.int32)
        eyes = np.ascontiguousarray(eyes, dtype=np.float64)
        yaw = np.ascontiguousarray(yaw, dtype=np.float64)
        pitch = np.ascontiguousarray(pitch, dtype=np.float64)
        targets = np.ascontiguousarray(targets, dtype=np.float64)
        self._lib.see_lines_many(
            self._arenas.handles, picked.ctypes.data_as(ct.POINTER(ct.c_int32)), targets.shape[0], targets.shape[1],
            eyes.ctypes.data_as(double), yaw.ctypes.data_as(double), pitch.ctypes.data_as(double),
            targets.ctypes.data_as(double), targets.shape[2],
        )

    def lines_seen(self, rows: np.ndarray, seat: int, lines: int) -> np.ndarray:
        """Return the lines this seat found open at its last sight update, shape (arenas, lines)."""
        picked = np.ascontiguousarray(rows, dtype=np.int32)
        out = np.zeros((len(picked), lines), dtype=np.uint8)
        self._lib.view_lines_many(
            self._arenas.handles, picked.ctypes.data_as(ct.POINTER(ct.c_int32)), len(picked), seat, lines,
            out.ctypes.data_as(ct.POINTER(ct.c_uint8)),
        )
        return out.astype(bool)

    def notable(self, arena: int, seat: int, kind: int, k: int) -> np.ndarray:
        """Return the nearest k remembered blocks of a class as rows of x, y, z, class, tick."""
        out = np.zeros((k, 5), dtype=np.int32)
        n = self._lib.view_notable(
            self._arenas.handles[arena], seat, kind, k, out.ctypes.data_as(ct.POINTER(ct.c_int32)),
        )
        return out[:n]

    def target(self, arena: int, seat: int, eye, look) -> int:
        """Return the class under the crosshair if seen, 0 if unknown and air if nothing is in reach."""
        return int(self._lib.view_target(self._arenas.handles[arena], seat, _vec(eye), _vec(look)))

    def digest(self, arena: int, seat: int) -> int:
        """Return a hash of the body's whole memory."""
        return int(self._lib.view_digest(self._arenas.handles[arena], seat))
