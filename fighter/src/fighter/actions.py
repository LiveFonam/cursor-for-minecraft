"""The multi-head discrete action space, in the order the game client reads it.

Yaw and pitch steps use the client's turn direction. A positive yaw step turns
left and a positive pitch step looks up, so the simulator applies them with the
opposite sign to its own angles.

A network that needs more heads builds its layout with `BASE.extended`. Extra
heads always follow the shared ones, so the shared indices never move.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from . import constants as C

FORWARD, STRAFE, SPRINT, JUMP, YAW, PITCH, ATTACK, USE, WEAPON, SNEAK, LOCK_AIM = range(11)

# Forward head: none, W, S. Strafe head: none, A, D.
FORWARD_VALUES = np.array([0.0, 1.0, -1.0])
STRAFE_VALUES = np.array([0.0, -1.0, 1.0])
KEY_FORWARD = 1
KEY_BACK = 2
KEY_LEFT = 1
KEY_RIGHT = 2

YAW_DELTAS = np.array(
    [-90.0, -45.0, -20.0, -10.0, -4.0, -1.5, 0.0, 1.5, 4.0, 10.0, 20.0, 45.0, 90.0, 180.0, -0.5, 0.5, -0.25, 0.25]
)
PITCH_DELTAS = np.array(
    [-40.0, -20.0, -8.0, -3.0, -1.0, 0.0, 1.0, 3.0, 8.0, 20.0, 40.0, -0.5, 0.5, -0.25, 0.25]
)
SIM_YAW_STEP = -YAW_DELTAS
SIM_PITCH_STEP = -PITCH_DELTAS

# Steps under these sizes are fine turns, allowed only at long range.
FINE_YAW = np.abs(YAW_DELTAS) < 1.0
FINE_YAW[YAW_DELTAS == 0.0] = False
FINE_PITCH = np.abs(PITCH_DELTAS) < 1.0
FINE_PITCH[PITCH_DELTAS == 0.0] = False
FINE_TURN_RANGE = 9.0

# Attack head: none, click, double click. The second click lands one tick later.
ATTACK_CLICK = 1
ATTACK_DOUBLE = 2

# Weapon head: keep, axe, sword, crossbow, bow.
WEAPON_KEEP = 0
WEAPON_CHOICES = np.array([-1, C.AXE, C.SWORD, C.CROSSBOW, C.BOW])
WEAPON_ACTION = np.zeros(C.NUM_WEAPONS, dtype=np.int64)
WEAPON_ACTION[WEAPON_CHOICES[1:]] = np.arange(1, len(WEAPON_CHOICES))

NEUTRAL_FORWARD = 0
NEUTRAL_STRAFE = 0
NEUTRAL_YAW = int(np.flatnonzero(YAW_DELTAS == 0.0)[0])
NEUTRAL_PITCH = int(np.flatnonzero(PITCH_DELTAS == 0.0)[0])


@dataclass(frozen=True)
class Head:
    """One categorical action head.

    mask: optional function of (sim, seat, rows) returning a boolean array of
    shape (arenas, size). A head without one allows every choice.
    """

    name: str
    size: int
    mask: Callable | None = None


class ActionLayout:
    """An ordered list of heads with their sizes and offsets in the flat mask."""

    def __init__(self, heads: tuple[Head, ...]):
        names = [head.name for head in heads]
        if len(set(names)) != len(names):
            raise ValueError("action head names must be unique")
        self.heads = tuple(heads)
        self.names = tuple(names)
        self.nvec = np.array([head.size for head in heads], dtype=np.int64)
        self.mask_size = int(self.nvec.sum())
        self.offsets = np.concatenate([[0], np.cumsum(self.nvec)[:-1]]).astype(np.int64)

    def __len__(self) -> int:
        return len(self.heads)

    def index(self, name: str) -> int:
        """Return the column of a head by name."""
        return self.names.index(name)

    def extended(self, *heads: Head) -> "ActionLayout":
        """Return a layout with extra heads after the existing ones."""
        return ActionLayout(self.heads + tuple(heads))


BASE = ActionLayout(
    (
        Head("forward", len(FORWARD_VALUES)),
        Head("strafe", len(STRAFE_VALUES)),
        Head("sprint", 2),
        Head("jump", 2),
        Head("yaw", len(YAW_DELTAS)),
        Head("pitch", len(PITCH_DELTAS)),
        Head("attack", 3),
        Head("use", 2),
        Head("weapon", len(WEAPON_CHOICES)),
        Head("sneak", 2),
        Head("lock_aim", 2),
    )
)
HEADS = BASE.names
NVEC = BASE.nvec
MASK_SIZE = BASE.mask_size
HEAD_OFFSETS = BASE.offsets


def idle_action() -> np.ndarray:
    """Return the single do-nothing action, which keeps the weapon in hand."""
    action = np.zeros(len(NVEC), dtype=np.int64)
    action[YAW] = NEUTRAL_YAW
    action[PITCH] = NEUTRAL_PITCH
    return action


def neutral_actions(weapons: np.ndarray) -> np.ndarray:
    """Return do-nothing actions that select the given simulator weapons."""
    actions = np.zeros((*weapons.shape, len(NVEC)), dtype=np.int64)
    actions[..., FORWARD] = NEUTRAL_FORWARD
    actions[..., STRAFE] = NEUTRAL_STRAFE
    actions[..., YAW] = NEUTRAL_YAW
    actions[..., PITCH] = NEUTRAL_PITCH
    actions[..., WEAPON] = WEAPON_ACTION[weapons]
    return actions


def nearest_index(values: np.ndarray, targets: np.ndarray) -> np.ndarray:
    """Return the index of the value closest to each target."""
    return np.abs(targets[..., None] - values).argmin(axis=-1)


def turn_indices(yaw_error: np.ndarray, pitch_error: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return the head choices closest to a turn given in simulator angles."""
    return nearest_index(SIM_YAW_STEP, yaw_error), nearest_index(SIM_PITCH_STEP, pitch_error)
