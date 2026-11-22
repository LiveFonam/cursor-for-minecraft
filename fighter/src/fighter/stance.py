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
ENEMY_CLEAR_LINE = 37
AIM_WIDTHS = 79
AIM_WIDTH_SCALE = 5.0
GUN_MIN_RANGE = 4.5
GUN_FORCE_RANGE = 7.0
GUN_REST_DECISIONS = 8
AIM_COS = 27
CHASE_RANGE = 3.5
CHASE_FACING = 0.7
OWN_VERTICAL_ON_GROUND = 4
OWN_SPRINT = 5
OWN_IN_WATER = 8
OWN_FALL = 11
OWN_AXE = 12
OWN_CHARGE = 16
OWN_SHIELD = 19
ENEMY_BODY_DISTANCE = 33
CROSSHAIR_IN_REACH = 35
CRIT_RANGE = 4.0  # a jump started here still comes down with the enemy in reach
CRIT_CHARGE = 0.9
CRIT_JUMP_CHARGE = 0.5  # 8 ticks before the charge is ready, so it is ready when the fall starts
CRIT_LEAVING = 2.7  # a ready swing at a body this far away is taken now, before it leaves the 3 block reach


@dataclass(frozen=True)
class StanceRules:
    """followup: fire right after a shield disable and hold fire in the enemy hurt window.

    range_rules: force the crossbow at range, with aim lock, reloads and clean shots, put it away close in,
    and run at an enemy out of axe reach. These are the range habits of the live client, bridge/fighter.js.
    sword_window: the sword can be selected or kept only while the enemy's shield is disabled.
    crit_rule: with the axe out and the enemy close, jump so the charge is ready in the fall, keep sprint off in the
    air, hold the swing until the fall and take it there. A raised shield facing the fighter is hit at once.
    """

    followup: bool = False
    range_rules: bool = False
    sword_window: bool = False
    crit_rule: bool = False


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


def _apply_range(
    sim,
    seat: int,
    picked: np.ndarray,
    mask: np.ndarray,
    obs: np.ndarray,
    active: np.ndarray,
    weapon: np.ndarray,
    load: np.ndarray,
    can_crossbow: np.ndarray,
    can_axe: np.ndarray,
) -> None:
    """Force the crossbow habits on the rows in `active`.

    A round's rest count falls once per decision, even if the masks are read twice in it.
    """
    if "stance_rest" not in sim.__dict__:
        sim.stance_rest = np.zeros((sim.n, 2), dtype=np.int64)
        sim.stance_stamp = np.full((sim.n, 2), -1, dtype=np.int64)
    rest, stamp = sim.stance_rest, sim.stance_stamp
    rest[picked[sim.ticks[picked] == 0], seat] = 0
    rows = np.flatnonzero(active)
    if len(rows) == 0:
        return
    arenas = picked[rows]
    fresh = stamp[arenas, seat] != sim.ticks[arenas]
    rest[arenas[fresh], seat] = np.maximum(rest[arenas[fresh], seat] - 1, 0)
    stamp[arenas, seat] = sim.ticks[arenas]

    start = int(A.HEAD_OFFSETS[A.WEAPON])
    size = int(A.NVEC[A.WEAPON])
    crossbow = int(A.WEAPON_ACTION[C.CROSSBOW])
    axe = int(A.WEAPON_ACTION[C.AXE])
    seen = obs[rows, ENEMY_IN_SIGHT] > 0.5
    distance = obs[rows, ENEMY_FLAT_DISTANCE] * 32.0
    in_range = distance >= GUN_MIN_RANGE
    guarded = in_range & (obs[rows, ENEMY_SHIELD_UP] > 0.5) & (obs[rows, ENEMY_FACING] > 0.0)
    holding = weapon[rows] == C.CROSSBOW
    loaded = sim.loaded[arenas, seat]
    stocked = sim.ammo[arenas, seat] > 0

    chase = (weapon[rows] == C.AXE) & seen & (distance >= CHASE_RANGE) & (obs[rows, AIM_COS] > CHASE_FACING)
    _fix(mask, rows[chase], A.FORWARD, A.KEY_FORWARD)
    _fix(mask, rows[chase], A.SPRINT, 1)

    rest[arenas[guarded], seat] = GUN_REST_DECISIONS
    sim.stance_opening[arenas[guarded], seat] = False
    away = rows[guarded & ~holding]
    others = mask[away, start : start + size].sum(axis=1) - mask[away, start + crossbow]
    mask[away[others > 0], start + crossbow] = False
    _fix(mask, rows[guarded & holding & (load[rows] == 0) & can_axe[rows]], A.WEAPON, axe)

    force = ~guarded & seen & can_crossbow[rows] & (rest[arenas, seat] == 0) & (loaded | stocked)
    _fix(mask, rows[force & (distance >= GUN_FORCE_RANGE)], A.WEAPON, crossbow)
    gun = ~guarded & holding & seen & in_range
    _fix(mask, rows[gun], A.LOCK_AIM, 1)
    _fix(mask, rows[gun & ~loaded & stocked], A.USE, 1)
    lined_up = (obs[rows, AIM_WIDTHS] * AIM_WIDTH_SCALE < 1.0) & (obs[rows, ENEMY_CLEAR_LINE] > 0.5)
    clean = lined_up & (obs[rows, ENEMY_HURT] <= HURT_WINDOW)
    press = gun & loaded & clean & ~sim.use_prev[arenas, seat]
    _fix(mask, rows[press], A.USE, 1)
    _fix(mask, rows[gun & loaded & ~press], A.USE, 0)


def apply_crit(mask: np.ndarray, obs: np.ndarray, allowed: np.ndarray) -> None:
    """Narrow the jump, sprint and attack heads on the rows where a crit can be set up."""
    active = (
        allowed
        & (obs[:, OWN_AXE] > 0.5)
        & (obs[:, ENEMY_IN_SIGHT] > 0.5)
        & (obs[:, ENEMY_FLAT_DISTANCE] * 32.0 < CRIT_RANGE)
        & (obs[:, OWN_SHIELD] < 0.5)
        & (obs[:, OWN_IN_WATER] < 0.5)
    )
    aimed = obs[:, CROSSHAIR_IN_REACH] > 0.5
    guarded = (obs[:, ENEMY_SHIELD_UP] > 0.5) & (obs[:, ENEMY_FACING] > 0.0)
    _fix(mask, np.flatnonzero(active & guarded & aimed), A.ATTACK, A.ATTACK_CLICK)
    open_play = active & ~guarded
    grounded = obs[:, OWN_VERTICAL_ON_GROUND] > 0.5
    charge = obs[:, OWN_CHARGE]
    soon = charge >= CRIT_JUMP_CHARGE
    can_jump = mask[:, int(A.HEAD_OFFSETS[A.JUMP]) + 1].copy()
    _fix(mask, np.flatnonzero(open_play & grounded & soon & can_jump), A.JUMP, 1)
    _fix(mask, np.flatnonzero(open_play & ~grounded), A.SPRINT, 0)
    # The server reads the sprint flag from before this decision's key change in the simulator, so it must already be off
    strike = (
        ~grounded
        & (obs[:, OWN_FALL] > 0.0)
        & (charge > CRIT_CHARGE)
        & aimed
        & (obs[:, OWN_SPRINT] < 0.5)
        & (obs[:, ENEMY_HURT] <= HURT_WINDOW)
    )
    leaving = (charge > CRIT_CHARGE) & aimed & (obs[:, ENEMY_BODY_DISTANCE] * 4.0 >= CRIT_LEAVING)
    _fix(mask, np.flatnonzero(open_play & strike), A.ATTACK, A.ATTACK_CLICK)
    hold = open_play & soon & ~strike & ~leaving & (~grounded | can_jump)
    _fix(mask, np.flatnonzero(hold), A.ATTACK, 0)


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
    full_obs = None
    closing = np.zeros(len(picked), dtype=bool)
    stop_load = hurt
    if rules.range_rules:
        full_obs = build_obs(sim, seat, 600, picked)
        distance = full_obs[:, ENEMY_FLAT_DISTANCE] * 32.0
        closing = distance < GUN_MIN_RANGE
        guarded = ~closing & (full_obs[:, ENEMY_SHIELD_UP] > 0.5) & (full_obs[:, ENEMY_FACING] > 0.0)
        stop_load = hurt | closing | guarded
    abort = loading & stop_load & (load / C.CROSSBOW_LOAD_TICKS < ABORT_PROGRESS) & can_axe
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
        obs = build_obs(sim, seat, 600, picked[ready]) if full_obs is None else full_obs[ready]
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

    if rules.range_rules:
        _apply_range(sim, seat, picked, mask, full_obs, ~abort & ~window, weapon, load, can_crossbow, can_axe)
    near = np.flatnonzero(free & ~window & can_axe & (closing | _axe_reach(sim, seat, picked)))
    mask[near, start + crossbow] = False
    mask[near[weapon[near] == C.CROSSBOW], start + A.WEAPON_KEEP] = False
    if rules.sword_window:
        closed = sim.shield_disabled[picked, 1 - seat] == 0
        mask[closed, start + int(A.WEAPON_ACTION[C.SWORD])] = False
        can_switch = mask[:, start + 1 : start + int(A.NVEC[A.WEAPON])].any(axis=1)
        mask[closed & (weapon == C.SWORD) & can_switch, start + A.WEAPON_KEEP] = False
    if rules.crit_rule:
        crit_obs = build_obs(sim, seat, 600, picked) if full_obs is None else full_obs
        apply_crit(mask, crit_obs, ~sim.combat.no_crit[picked, seat])
    return mask
