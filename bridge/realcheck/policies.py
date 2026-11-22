"""Scripted players that read only the 130 inputs and the action mask.

policies.js holds the same rules for the real server, and test_policies.py checks that the two agree.
"""

import numpy as np

from fighter import actions as A

YAW_ERROR_SIN = 26
YAW_ERROR_COS = 27
PITCH_ERROR = 28
PITCH_SCALE = 90.0
DISTANCE = 32
DISTANCE_SCALE = 32.0
HOLDS_AXE = 12
HOLDS_SWORD = 13
CHARGE = 16
READY = 17
SHIELD_UP = 19
ON_TARGET = 35
GUARD_FLIP = 10
FIST_CHARGE = 0.95


def _head(mask, head):
    start = A.HEAD_OFFSETS[head]
    return mask[:, start : start + A.NVEC[head]]


def _nearest(values, wanted, allowed):
    cost = np.abs(values[None, :] - wanted[:, None])
    return np.where(allowed, cost, np.inf).argmin(axis=1)


def _base(obs, mask):
    action = np.zeros((len(obs), len(A.NVEC)), dtype=np.int64)
    yaw_error = np.degrees(np.arctan2(obs[:, YAW_ERROR_SIN], obs[:, YAW_ERROR_COS]))
    action[:, A.YAW] = _nearest(A.YAW_DELTAS, yaw_error, _head(mask, A.YAW))
    action[:, A.PITCH] = _nearest(A.PITCH_DELTAS, obs[:, PITCH_ERROR] * PITCH_SCALE, _head(mask, A.PITCH))
    return action, obs[:, DISTANCE] * DISTANCE_SCALE


def _band(distance, far, near):
    return np.select([distance > far, distance < near], [A.KEY_FORWARD, A.KEY_BACK], 0)


def _pick_weapon(action, obs, mask, slot, holds):
    action[:, A.WEAPON] = np.where((obs[:, holds] < 0.5) & _head(mask, A.WEAPON)[:, slot], slot, 0)


def reach(obs, mask, turn, rng):
    """Walks into reach with the axe and swings on full charge."""
    action, distance = _base(obs, mask)
    _pick_weapon(action, obs, mask, 1, HOLDS_AXE)
    action[:, A.FORWARD] = _band(distance, 2.6, 1.8)
    action[:, A.SPRINT] = (distance > 3.6) & _head(mask, A.SPRINT)[:, 1]
    action[:, A.ATTACK] = (obs[:, ON_TARGET] > 0.5) & (obs[:, READY] > 0.5) & _head(mask, A.ATTACK)[:, 1]
    return action


def duelist(obs, mask, turn, rng):
    """A sword player that keeps close and swings on a full charge."""
    action, distance = _base(obs, mask)
    _pick_weapon(action, obs, mask, 2, HOLDS_SWORD)
    action[:, A.FORWARD] = _band(distance, 2.4, 1.6)
    action[:, A.SPRINT] = (distance > 3.6) & _head(mask, A.SPRINT)[:, 1]
    action[:, A.ATTACK] = (obs[:, ON_TARGET] > 0.5) & (obs[:, CHARGE] >= FIST_CHARGE) & _head(mask, A.ATTACK)[:, 1]
    return action


def guard(obs, mask, turn, rng):
    """An axe player that strafes, holds its shield up close and lowers it to swing."""
    action, distance = _base(obs, mask)
    _pick_weapon(action, obs, mask, 1, HOLDS_AXE)
    action[:, A.FORWARD] = _band(distance, 3.0, 2.2)
    action[:, A.STRAFE] = np.where((turn // GUARD_FLIP) % 2 == 0, A.KEY_LEFT, A.KEY_RIGHT)
    strike = (obs[:, ON_TARGET] > 0.5) & (obs[:, READY] > 0.5)
    action[:, A.ATTACK] = strike & (obs[:, SHIELD_UP] < 0.5) & _head(mask, A.ATTACK)[:, 1]
    action[:, A.USE] = (distance < 4.0) & ~strike & _head(mask, A.USE)[:, 1]
    return action


def uniform(obs, mask, turn, rng):
    """Picks every head at random among the allowed choices."""
    scores = np.where(mask, rng.random(mask.shape), -1.0)
    action = np.zeros((len(obs), len(A.NVEC)), dtype=np.int64)
    for head, (start, size) in enumerate(zip(A.HEAD_OFFSETS, A.NVEC)):
        action[:, head] = scores[:, start : start + size].argmax(axis=1)
    return action


POLICIES = {"scripted": reach, "duelist": duelist, "guard": guard, "random": uniform}
