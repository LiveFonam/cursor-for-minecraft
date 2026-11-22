"""Scripted crossbow and axe rules applied to the action masks after the experts."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import actions as A
from . import constants as C
from .obs import ENEMY_IN_SIGHT, build_obs

ABORT_PROGRESS = 0.75
AXE_RANGE = 3.0
FAR_SHOT_RANGE = 6.0
JUST_DISABLED = 0.9
HURT_WINDOW = 0.2
ENEMY_FLAT_DISTANCE = 32
ENEMY_HURT = 46
ENEMY_SHIELD_UP = 52
ENEMY_SHIELD_DISABLED = 54
ENEMY_FACING = 55


@dataclass(frozen=True)
class StanceRules:
    """followup: fire right after a shield disable and hold fire in the enemy hurt window.

    sword_window: the sword can be selected or kept only while the enemy's shield is disabled.
    """

    followup: bool = False
    sword_window: bool = False


def _fix(mask: np.ndarray, rows: np.ndarray, head: int, choice: int) -> None:
    """Leave one legal choice on a head in the given mask rows."""
    if len(rows) == 0:
        return
    start = int(A.HEAD_OFFSETS[head])
    mask[rows, start : start + int(A.NVEC[head])] = False
    mask[rows, start + choice] = True


def _axe_reach(sim, seat: int, picked: np.ndarray) -> np.ndarray:
    """Return where the enemy body is within axe range of the eye."""
    eye = sim.pos[picked, seat] + np.array([0.0, C.EYE_HEIGHT, 0.0])
    target = sim.pos[picked, 1 - seat]
    half = C.PLAYER_WIDTH / 2.0
    low = target + np.array([-half, 0.0, -half])
    high = target + np.array([half, C.PLAYER_HEIGHT, half])
    nearest = np.minimum(np.maximum(eye, low), high)
    return np.linalg.norm(nearest - eye, axis=1) <= AXE_RANGE


def apply_stance(
    rules: StanceRules, sim, seat: int, mask: np.ndarray, rows: np.ndarray | None = None
) -> np.ndarray:
    """Narrow `mask`, which holds one row per picked arena, with the scripted rules."""
    picked = np.arange(sim.n) if rows is None else np.asarray(rows)
    if len(picked) == 0:
        return mask
    if "stance_opening" not in sim.__dict__:
        sim.stance_opening = np.zeros((sim.n, 2), dtype=bool)
    opening = sim.stance_opening
    opening[picked[sim.ticks[picked] == 0], seat] = True

    weapon = sim.weapon[picked, seat]
    loaded = sim.loaded[picked, seat]
    load = sim.load_ticks[picked, seat]
    start = int(A.HEAD_OFFSETS[A.WEAPON])
    crossbow = int(A.WEAPON_ACTION[C.CROSSBOW])
    axe = int(A.WEAPON_ACTION[C.AXE])
    can_crossbow = mask[:, start + crossbow].copy()
    can_axe = mask[:, start + axe].copy()
    opening[picked[loaded | (sim.ammo[picked, seat] <= 0) | ~can_crossbow], seat] = False

    loading = opening[picked, seat] | (load > 0)
    hurt = sim.hurt_timer[picked, seat] > 0
    abort = loading & hurt & (load / C.CROSSBOW_LOAD_TICKS < ABORT_PROGRESS) & can_axe
    opening[picked[abort], seat] = False
    carry = loading & ~abort & can_crossbow
    _fix(mask, np.flatnonzero(abort), A.WEAPON, axe)
    _fix(mask, np.flatnonzero(abort), A.USE, 0)
    _fix(mask, np.flatnonzero(carry), A.WEAPON, crossbow)
    _fix(mask, np.flatnonzero(carry), A.USE, 1)

    free = ~(abort | carry)
    window = np.zeros(len(picked), dtype=bool)
    ready = np.flatnonzero(free & loaded)
    if len(ready):
        obs = build_obs(sim, seat, 600, picked[ready])
        holding = weapon[ready] == C.CROSSBOW
        fresh = ~sim.use_prev[picked[ready], seat]
        seen = obs[:, ENEMY_IN_SIGHT] > 0.5
        shield = obs[:, ENEMY_SHIELD_UP] > 0.5
        disabled = obs[:, ENEMY_SHIELD_DISABLED] >= JUST_DISABLED
        here = disabled if rules.followup else np.zeros(len(ready), dtype=bool)
        window[ready[here]] = True
        _fix(mask, ready[here], A.WEAPON, crossbow)
        _fix(mask, ready[here & holding & fresh], A.USE, 1)
        _fix(mask, ready[here & ~(holding & fresh)], A.USE, 0)
        _fix(mask, ready[here & holding & seen], A.LOCK_AIM, 1)
        hold = holding & fresh & shield & (obs[:, ENEMY_FACING] > 0.0)
        if rules.followup:
            hold = hold | (holding & fresh & (obs[:, ENEMY_HURT] > HURT_WINDOW))
        _fix(mask, ready[hold & ~here], A.USE, 0)
        far = obs[:, ENEMY_FLAT_DISTANCE] * 32.0 >= FAR_SHOT_RANGE
        shot = far & seen & ~shield & ~here
        _fix(mask, ready[shot], A.WEAPON, crossbow)
        _fix(mask, ready[shot & holding], A.LOCK_AIM, 1)

    near = np.flatnonzero(free & ~window & can_axe & _axe_reach(sim, seat, picked))
    mask[near, start + crossbow] = False
    mask[near[weapon[near] == C.CROSSBOW], start + A.WEAPON_KEEP] = False
    if rules.sword_window:
        closed = sim.shield_disabled[picked, 1 - seat] == 0
        mask[closed, start + int(A.WEAPON_ACTION[C.SWORD])] = False
        can_switch = mask[:, start + 1 : start + int(A.NVEC[A.WEAPON])].any(axis=1)
        mask[closed & (weapon == C.SWORD) & can_switch, start + A.WEAPON_KEEP] = False
    return mask
