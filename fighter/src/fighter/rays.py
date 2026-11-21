"""The 26 block rays cast from the eye, turned with the body's yaw."""

from __future__ import annotations

import numpy as np

RAY_COUNT = 26
RAY_RANGE = 8.0
RING_PITCHES = (55.0, 20.0, 0.0)
RING_DIRECTIONS = 8
MIN_STEP = 1e-12


def _local_directions() -> np.ndarray:
    """Return unit rays as (forward, right, up) columns, in slot order."""
    rows = []
    for pitch in np.radians(RING_PITCHES):
        for k in range(RING_DIRECTIONS):
            angle = 2.0 * np.pi * k / RING_DIRECTIONS
            rows.append((np.cos(angle) * np.cos(pitch), np.sin(angle) * np.cos(pitch), -np.sin(pitch)))
    rows.append((0.0, 0.0, 1.0))
    rows.append((0.0, 0.0, -1.0))
    return np.array(rows)


LOCAL_DIRECTIONS = _local_directions()
LOCAL_ANGLES = np.arctan2(LOCAL_DIRECTIONS[:, 1], LOCAL_DIRECTIONS[:, 0])
RAY_SIN = np.sin(LOCAL_ANGLES)
RAY_COS = np.cos(LOCAL_ANGLES)


def world_directions(yaw: np.ndarray) -> np.ndarray:
    """Return ray directions of shape (arenas, 26, 3) for body yaws in degrees."""
    rad = np.radians(yaw)
    sin_y = np.sin(rad)[:, None]
    cos_y = np.cos(rad)[:, None]
    forward = LOCAL_DIRECTIONS[:, 0]
    right = LOCAL_DIRECTIONS[:, 1]
    out = np.empty((len(rad), RAY_COUNT, 3))
    out[..., 0] = forward * -sin_y + right * -cos_y
    out[..., 1] = LOCAL_DIRECTIONS[:, 2]
    out[..., 2] = forward * cos_y + right * -sin_y
    return out


def flat_distances(eye: np.ndarray, directions: np.ndarray, half: float) -> np.ndarray:
    """Return free distance along each ray in a walled flat arena centered on the origin.

    The floor is the plane y = 0 and the walls are the planes x and z = +-half.
    """
    down = np.maximum(-directions[..., 1], MIN_STEP)
    best = np.minimum(RAY_RANGE, eye[:, 1, None] / down)
    for axis in (0, 2):
        step = directions[..., axis]
        origin = eye[:, axis, None]
        room = np.where(step > 0.0, half - origin, origin + half)
        best = np.minimum(best, room / np.maximum(np.abs(step), MIN_STEP))
    return np.maximum(best, 0.0)
