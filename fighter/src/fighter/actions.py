"""The multi-head discrete action space."""

from __future__ import annotations

import numpy as np

HEADS = ("forward", "strafe", "sprint", "jump", "yaw", "pitch", "attack", "use", "weapon")
FORWARD, STRAFE, SPRINT, JUMP, YAW, PITCH, ATTACK, USE, WEAPON = range(9)

FORWARD_VALUES = np.array([-1.0, 0.0, 1.0])
STRAFE_VALUES = np.array([-1.0, 0.0, 1.0])
YAW_DELTAS = np.array([-40.0, -15.0, -5.0, -1.5, 0.0, 1.5, 5.0, 15.0, 40.0])
PITCH_DELTAS = np.array([-20.0, -6.0, -1.5, 0.0, 1.5, 6.0, 20.0])

NVEC = np.array(
    [
        len(FORWARD_VALUES),
        len(STRAFE_VALUES),
        2,
        2,
        len(YAW_DELTAS),
        len(PITCH_DELTAS),
        2,
        2,
        4,
    ]
)
MASK_SIZE = int(NVEC.sum())
HEAD_OFFSETS = np.concatenate([[0], np.cumsum(NVEC)[:-1]])

NEUTRAL_FORWARD = 1
NEUTRAL_STRAFE = 1
NEUTRAL_YAW = int(np.argmin(np.abs(YAW_DELTAS)))
NEUTRAL_PITCH = int(np.argmin(np.abs(PITCH_DELTAS)))


def neutral_actions(weapons: np.ndarray) -> np.ndarray:
    """Return do-nothing actions that keep the given weapons in hand."""
    actions = np.zeros((*weapons.shape, len(NVEC)), dtype=np.int64)
    actions[..., FORWARD] = NEUTRAL_FORWARD
    actions[..., STRAFE] = NEUTRAL_STRAFE
    actions[..., YAW] = NEUTRAL_YAW
    actions[..., PITCH] = NEUTRAL_PITCH
    actions[..., WEAPON] = weapons
    return actions


def nearest_index(values: np.ndarray, targets: np.ndarray) -> np.ndarray:
    """Return the index of the value closest to each target."""
    return np.abs(targets[..., None] - values).argmin(axis=-1)
