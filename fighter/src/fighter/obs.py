"""The 130 egocentric inputs and the action masks.

Angle errors use the game client's frame: a positive yaw error means the target
is to the left and a positive pitch error means it is above the view. Blocks are
read only through the view module. Networks that need more inputs add them with
`fighter.interface`, after these slots.
"""

from __future__ import annotations

import numpy as np

from . import actions as A
from . import arrows
from . import constants as C
from . import rays as R
from .perception import CHEST_HEIGHT
from .sim import MAX_ARROWS, Sim, look_vectors

OBS_DIM = 130
NEAREST_ARROWS = 2
ARROW_SLOTS = 81
PICKUP_SLOTS = 93
RAY_SLOTS = 96
HAZARD_SLOTS = 122
WATER_SLOTS = 125
BORDER_SLOT = 128
TRACKING_SLOT = 129
ENEMY_IN_SIGHT = 38

PICKUP_SEEN_AGE = 20
PICKUP_SEE_RANGE = 4.0
TRACKING_RANGE = 160.0
ON_TARGET_MISS = 1.3
STILL_SPEED = 0.02
GROUND_SPEED = 0.005
FAR_REACH = 64.0
ROUND_SCALE = 1200.0
ARROW_TARGET_MARGIN = 0.6
LOG_ARROW_DRAG = np.log(C.ARROW_DRAG)
NO_REACH_WIDTHS = 99.0
MAX_LOFT = 1.4
MIN_REACH_FRACTION = 0.05


def wrap_degrees(angle: np.ndarray) -> np.ndarray:
    """Wrap an angle to the range from -180 to 180 degrees."""
    return (angle + 180.0) % 360.0 - 180.0


def view_angles(delta: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return the yaw and pitch that look along a vector."""
    yaw = np.degrees(np.arctan2(-delta[..., 0], delta[..., 2]))
    pitch = -np.degrees(np.arctan2(delta[..., 1], np.hypot(delta[..., 0], delta[..., 2])))
    return yaw, pitch


def intercept_angles(
    sim: Sim, seat: int, speed: np.ndarray, lead: bool = True
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Solve the view angles that hit the other player with an arrow.

    With lead on, the aim point moves with the target during the flight.
    Returns the yaw, the pitch and the flight time in ticks.
    """
    return arrows.intercept(sim, seat, speed, lead)


def _ego(dx: np.ndarray, dz: np.ndarray, sin_y: np.ndarray, cos_y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return dx * -sin_y + dz * cos_y, dx * -cos_y + dz * -sin_y


def build_obs(sim: Sim, seat: int, max_ticks: int = 600, rows: np.ndarray | None = None) -> np.ndarray:
    """Build the inputs of one seat, shape (arenas, OBS_DIM), for all or the selected arenas."""
    at = slice(None) if rows is None else np.asarray(rows)
    count = sim.n if rows is None else len(at)
    obs = np.zeros((count, OBS_DIM), dtype=np.float32)
    if count == 0:
        return obs
    me = seat
    you = 1 - seat
    index = np.arange(count)
    memory = sim.perception
    pos = sim.pos[at, me]
    vel = sim.vel[at, me]
    yaw = sim.yaw[at, me]
    pitch = sim.pitch[at, me]
    rad = np.radians(yaw)
    sin_y = np.sin(rad)
    cos_y = np.cos(rad)
    charge = sim.combat.charge()
    weapon = sim.weapon[at, me]
    enemy_weapon = sim.weapon[at, you]

    forward_v, right_v = _ego(vel[:, 0], vel[:, 2], sin_y, cos_y)
    own_charge = charge[at, me]
    ready = own_charge >= C.FULL_CHARGE_THRESHOLD
    obs[:, 0] = sim.hp[at, me] / C.MAX_HEALTH
    obs[:, 1] = np.clip(forward_v * 3.0, -3.0, 3.0)
    obs[:, 2] = np.clip(right_v * 3.0, -3.0, 3.0)
    obs[:, 3] = np.clip(vel[:, 1] * 3.0, -3.0, 3.0)
    obs[:, 4] = sim.on_ground[at, me]
    obs[:, 5] = sim.sprinting[at, me]
    obs[:, 6] = sim.body.sneak[at, me]
    obs[:, 7] = np.sin(np.radians(pitch))
    obs[:, 8] = sim.combat.in_water[at, me]
    obs[:, 9] = sim.combat.eyes_in_water[at, me]
    obs[:, 10] = sim.hurt_timer[at, me] / C.HURT_TICKS
    obs[:, 11] = np.minimum(sim.body.fall[at, me] / 4.0, 1.0)
    obs[:, 12] = weapon == C.AXE
    obs[:, 13] = weapon == C.SWORD
    obs[:, 14] = weapon == C.CROSSBOW
    obs[:, 15] = weapon == C.BOW
    obs[:, 16] = own_charge
    obs[:, 17] = ready
    obs[:, 18] = (vel[:, 1] < 0.0) & ~sim.on_ground[at, me] & ready
    obs[:, 19] = sim.shield_ticks[at, me] > 0
    obs[:, 20] = sim.shield_ticks[at, me] >= C.SHIELD_RAISE_TICKS
    obs[:, 21] = sim.shield_disabled[at, me] / C.SHIELD_DISABLE_TICKS
    obs[:, 22] = sim.loaded[at, me]
    obs[:, 23] = sim.load_ticks[at, me] / C.CROSSBOW_LOAD_TICKS
    obs[:, 24] = np.minimum(sim.draw_ticks[at, me] / C.BOW_FULL_DRAW_TICKS, 1.0)
    obs[:, 25] = np.minimum(sim.ammo[at, me], arrows.START_ARROWS) / arrows.START_ARROWS

    sight = memory.enemy(seat, at)
    target = sight.pos
    eye = sim.eyes()[at, me]
    gap = target + np.array([0.0, CHEST_HEIGHT, 0.0]) - eye
    flat = np.hypot(gap[:, 0], gap[:, 2])
    want_yaw, want_pitch = view_angles(gap)
    yaw_error = wrap_degrees(yaw - want_yaw)
    pitch_error = pitch - want_pitch
    yaw_error_rad = np.radians(yaw_error)
    obs[:, 26] = np.sin(yaw_error_rad)
    obs[:, 27] = np.cos(yaw_error_rad)
    obs[:, 28] = np.clip(pitch_error / 90.0, -1.0, 1.0)
    obs[:, 29] = np.clip(yaw_error / 10.0, -1.0, 1.0)
    obs[:, 30] = np.clip(pitch_error / 10.0, -1.0, 1.0)
    obs[:, 31] = np.minimum(flat / 8.0, 2.0)
    obs[:, 32] = np.minimum(flat / 32.0, 1.5)
    half = C.PLAYER_WIDTH / 2.0
    low = target + np.array([-half, 0.0, -half])
    high = target + np.array([half, C.PLAYER_HEIGHT, half])
    nearest = np.minimum(np.maximum(eye, low), high)
    obs[:, 33] = np.minimum(np.linalg.norm(nearest - eye, axis=1) / 4.0, 2.0)
    obs[:, 34] = np.clip((target[:, 1] - pos[:, 1]) / 3.0, -2.0, 2.0)

    near_aim, far_aim = _crosshair(sim, seat, at, eye, yaw, pitch, sight)
    obs[:, 35] = near_aim
    obs[:, 36] = far_aim
    obs[:, 37] = sight.chest_clear
    obs[:, ENEMY_IN_SIGHT] = sight.visible

    move = sight.move
    enemy_f, enemy_r = _ego(move[:, 0], move[:, 2], sin_y, cos_y)
    obs[:, 39] = np.clip(enemy_f * 3.0, -3.0, 3.0)
    obs[:, 40] = np.clip(enemy_r * 3.0, -3.0, 3.0)
    obs[:, 41] = np.clip(move[:, 1] * 3.0, -3.0, 3.0)
    live_move = sim.body.last_move[at, you]
    obs[:, 42] = np.abs(live_move[:, 1]) < GROUND_SPEED
    obs[:, 43] = sim.sprinting[at, you]
    obs[:, 44] = np.hypot(live_move[:, 0], live_move[:, 2]) < STILL_SPEED
    obs[:, 45] = memory.enemy_health[at, me] / C.MAX_HEALTH
    obs[:, 46] = sim.hurt_timer[at, you] / C.HURT_TICKS
    period = C.TICKS_PER_SECOND / C.WEAPON_ATTACK_SPEED[enemy_weapon]
    obs[:, 47] = np.clip((sim.attack_ticks[at, you] + 0.5) / period, 0.0, 1.0)
    obs[:, 48] = enemy_weapon == C.AXE
    obs[:, 49] = enemy_weapon == C.SWORD
    obs[:, 50] = enemy_weapon == C.CROSSBOW
    obs[:, 51] = enemy_weapon == C.BOW
    obs[:, 52] = sim.shield_ticks[at, you] > 0
    obs[:, 53] = sim.shield_ticks[at, you] >= C.SHIELD_RAISE_TICKS
    obs[:, 54] = sim.shield_disabled[at, you] / C.SHIELD_DISABLE_TICKS
    to_me = pos - target
    span = np.maximum(np.hypot(to_me[:, 0], to_me[:, 2]), 1e-6)
    their_view = look_vectors(sim.yaw[at, you], np.zeros(count))
    obs[:, 55] = (their_view[:, 0] * to_me[:, 0] + their_view[:, 2] * to_me[:, 2]) / span
    bearing = np.degrees(np.arctan2(-to_me[:, 0], to_me[:, 2]))
    obs[:, 56] = wrap_degrees(sim.yaw[at, you] - bearing) / 180.0
    draw = sim.draw_ticks[at, you]
    load = sim.load_ticks[at, you]
    obs[:, 57] = (draw > 0) | (load > 0)
    obs[:, 58] = np.minimum(np.maximum(draw, load), C.CROSSBOW_LOAD_TICKS) / C.CROSSBOW_LOAD_TICKS
    obs[:, 59] = sim.loaded[at, you] & (enemy_weapon == C.CROSSBOW)

    obs[:, 61] = np.minimum(memory.since_hit[at, me], 40) / 40.0
    obs[:, 62] = np.minimum(memory.since_hurt[at, me], 40) / 40.0
    obs[:, 63] = np.minimum(memory.since_disabled[at, me], 40) / 40.0
    obs[:, 64] = np.minimum(memory.since_enemy_swing[at, me], 40) / 40.0
    obs[:, 65] = np.minimum(memory.since_whiff[at, me], 40) / 40.0
    obs[:, 66] = np.minimum(memory.combo[at, me], 5) / 5.0
    obs[:, 67] = np.minimum(sim.ticks[at] / ROUND_SCALE, 1.0)
    last = memory.last_action[at, me]
    obs[:, 68] = A.FORWARD_VALUES[last[:, A.FORWARD]]
    obs[:, 69] = A.STRAFE_VALUES[last[:, A.STRAFE]]
    obs[:, 70] = last[:, A.SPRINT]
    obs[:, 71] = last[:, A.JUMP]
    obs[:, 72] = A.YAW_DELTAS[last[:, A.YAW]] / 90.0
    obs[:, 73] = last[:, A.ATTACK] / 2.0
    obs[:, 74] = sim.use_prev[at, me]

    if not sim.no_ranged():
        _lead_slots(sim, seat, at, rows, yaw, pitch, sight, obs)
        _arrow_slots(sim, me, at, pos, sin_y, cos_y, index, obs)
    _pickup_slots(sim, at, pos, sin_y, cos_y, index, obs)
    _block_slots(sim, seat, at, eye, yaw, obs)

    from_center = pos - sim.origin
    border = sim.border_half - np.maximum(np.abs(from_center[:, 0]), np.abs(from_center[:, 2]))
    obs[:, BORDER_SLOT] = np.clip(border / 16.0, 0.0, 1.0)
    true_gap = sim.pos[at, you] - pos
    obs[:, TRACKING_SLOT] = np.hypot(true_gap[:, 0], true_gap[:, 2]) <= TRACKING_RANGE
    return obs


def _crosshair(sim: Sim, seat: int, at, eye, yaw, pitch, sight) -> tuple[np.ndarray, np.ndarray]:
    """Return whether the view ray meets the enemy in reach and to 64 blocks, stopped by blocks."""
    you = 1 - seat
    look = look_vectors(yaw, pitch)
    low, high = sim.boxes()
    box_low = low[at, you]
    box_high = high[at, you]
    step = np.where(np.abs(look) < 1e-9, 1e-9, look)
    first = (box_low - eye) / step
    second = (box_high - eye) / step
    entry = np.maximum(np.minimum(first, second).max(axis=1), 0.0)
    meets = (np.maximum(first, second).min(axis=1) >= entry) & sight.crosshair_clear
    return meets & (entry <= C.ATTACK_REACH), meets & (entry <= FAR_REACH)


def _lead_slots(sim: Sim, seat: int, at, rows, yaw, pitch, sight, obs: np.ndarray) -> None:
    """Fill slots 75 to 80 from a shot at where the enemy is known to be."""
    speed = arrows.aim_speed(sim, seat, at)
    seen = None
    if sim.world is not None:
        visible = sight.visible
        velocity = np.where(visible[:, None], arrows.target_motion(sim, 1 - seat, at), sight.move)
        seen = (sight.pos, velocity, visible)
    lead_yaw, lead_pitch, flight = arrows.intercept(sim, seat, speed, rows=rows, seen=seen)
    yaw_error = wrap_degrees(yaw - lead_yaw)
    pitch_error = pitch - lead_pitch
    obs[:, 75] = np.clip(yaw_error / 30.0, -2.0, 2.0)
    obs[:, 76] = np.clip(pitch_error / 30.0, -2.0, 2.0)
    obs[:, 77] = np.clip(yaw_error / 2.0, -1.0, 1.0)
    obs[:, 78] = np.clip(pitch_error / 2.0, -1.0, 1.0)
    loft = -np.radians(lead_pitch)
    left = np.exp(LOG_ARROW_DRAG * flight)
    reach = (left > MIN_REACH_FRACTION) & (loft < MAX_LOFT)
    across = np.maximum(100.0 * speed * np.cos(loft) * (1.0 - left), 0.5)
    widths = np.where(reach, np.abs(np.radians(yaw_error)) / np.arctan(ARROW_TARGET_MARGIN / across), NO_REACH_WIDTHS)
    obs[:, 79] = np.minimum(widths, 5.0) / 5.0
    obs[:, 80] = np.minimum(flight / 20.0, 2.0)


def _arrow_slots(sim: Sim, me: int, at, pos, sin_y, cos_y, index, obs: np.ndarray) -> None:
    """Fill slots 81 to 92 with the two most urgent incoming arrows."""
    incoming = sim.arrow_on[at] & (sim.arrow_owner[at] != me)
    if not incoming.any():
        return
    columns = np.flatnonzero(incoming.any(axis=0))
    incoming = incoming[:, columns]
    center = pos + np.array([0.0, C.PLAYER_HEIGHT / 2.0, 0.0])
    rel = sim.arrow_pos[at][:, columns] - center[:, None, :]
    vel = sim.arrow_vel[at][:, columns]
    speed_sq = np.maximum((vel * vel).sum(axis=-1), 1e-6)
    closest = np.clip(-(rel * vel).sum(axis=-1) / speed_sq, 0.0, 60.0)
    miss = rel + vel * closest[..., None]
    miss_dist = np.linalg.norm(miss, axis=-1)
    urgency = np.where(incoming, closest + miss_dist, np.inf)
    order = np.argsort(urgency, axis=1)[:, :NEAREST_ARROWS]
    for rank in range(order.shape[1]):
        slot = order[:, rank]
        live = incoming[index, slot]
        if not live.any():
            continue
        base = ARROW_SLOTS + rank * 6
        r = rel[index, slot]
        forward, right = _ego(r[:, 0], r[:, 2], sin_y, cos_y)
        obs[:, base + 0] = live * forward / 16.0
        obs[:, base + 1] = live * right / 16.0
        obs[:, base + 2] = live * r[:, 1] / 4.0
        obs[:, base + 3] = live * np.minimum(closest[index, slot] / 20.0, 3.0)
        obs[:, base + 4] = live * np.minimum(miss_dist[index, slot] / 2.0, 1.0)
        obs[:, base + 5] = live & (miss_dist[index, slot] < ON_TARGET_MISS)


def _pickup_slots(sim: Sim, at, pos, sin_y, cos_y, index, obs: np.ndarray) -> None:
    """Fill slots 93 to 95 with the nearest landed arrow a player could collect."""
    if not sim.stuck_on.any():
        return
    known = sim.stuck_on[at] & sim.stuck_pickup[at] & (sim.stuck_age[at] >= PICKUP_SEEN_AGE)
    if not known.any():
        return
    delta = sim.stuck_pos[at] - pos[:, None, :]
    across = np.hypot(delta[..., 0], delta[..., 2])
    near = (
        known
        & (across <= PICKUP_SEE_RANGE)
        & (delta[..., 1] >= -arrows.PICKUP_BELOW)
        & (delta[..., 1] <= C.PLAYER_HEIGHT + arrows.PICKUP_ABOVE_HEAD)
    )
    best = np.where(near, across, np.inf).argmin(axis=1)
    found = near[index, best]
    if not found.any():
        return
    d = delta[index, best]
    forward, right = _ego(d[:, 0], d[:, 2], sin_y, cos_y)
    obs[:, PICKUP_SLOTS] = found
    obs[:, PICKUP_SLOTS + 1] = found * forward / PICKUP_SEE_RANGE
    obs[:, PICKUP_SLOTS + 2] = found * right / PICKUP_SEE_RANGE


def _block_slots(sim: Sim, seat: int, at, eye, yaw, obs: np.ndarray) -> None:
    """Fill slots 96 to 127 from the 26 rays, with the hazards those rays reached."""
    directions = R.world_directions(yaw)
    obs[:, HAZARD_SLOTS] = 1.0
    obs[:, HAZARD_SLOTS + 2] = 1.0
    obs[:, WATER_SLOTS] = 1.0
    obs[:, WATER_SLOTS + 2] = 1.0
    if sim.world is None:
        free = R.flat_distances(eye - sim.origin, directions, sim.cfg.arena_half)
        obs[:, RAY_SLOTS : RAY_SLOTS + R.RAY_COUNT] = free / R.RAY_RANGE
        return
    rows = np.arange(sim.n)[at]
    free, hazard, water = sim.world_view().rays_many(rows, seat, eye, directions, R.RAY_RANGE)
    obs[:, RAY_SLOTS : RAY_SLOTS + R.RAY_COUNT] = np.minimum(free / R.RAY_RANGE, 1.0)
    _nearest_hit(np.where(hazard, free, np.inf), obs, HAZARD_SLOTS)
    _nearest_hit(np.where(water >= 0.0, water, np.inf), obs, WATER_SLOTS)


def _nearest_hit(distance: np.ndarray, obs: np.ndarray, base: int) -> None:
    best = distance.argmin(axis=1)
    value = distance[np.arange(len(distance)), best]
    found = np.isfinite(value)
    if not found.any():
        return
    obs[found, base] = np.minimum(value[found] / R.RAY_RANGE, 1.0)
    obs[found, base + 1] = R.RAY_SIN[best[found]]
    obs[found, base + 2] = R.RAY_COS[best[found]]


def build_masks(
    sim: Sim, seat: int, allowed_weapons: np.ndarray | None = None, rows: np.ndarray | None = None
) -> np.ndarray:
    """Return a flat boolean mask of shape (arenas, MASK_SIZE)."""
    at = slice(None) if rows is None else np.asarray(rows)
    count = sim.n if rows is None else len(at)
    mask = np.ones((count, A.MASK_SIZE), dtype=bool)
    if count == 0:
        return mask
    off = A.HEAD_OFFSETS
    weapon = sim.weapon[at, seat]
    melee = weapon <= C.AXE
    draw = sim.draw_ticks[at, seat]
    load = sim.load_ticks[at, seat]
    using = (melee & (sim.shield_ticks[at, seat] > 0)) | (draw > 0) | (load > 0)
    mask[:, off[A.SPRINT] + 1] = ~using
    mask[:, off[A.JUMP] + 1] = sim.on_ground[at, seat] | sim.combat.in_water[at, seat]
    mask[:, off[A.ATTACK] + A.ATTACK_CLICK] = melee
    mask[:, off[A.ATTACK] + A.ATTACK_DOUBLE] = melee
    stocked = sim.ammo[at, seat] > 0
    crossbow = weapon == C.CROSSBOW
    can_use = np.where(melee, sim.shield_disabled[at, seat] == 0, stocked | (crossbow & sim.loaded[at, seat]))
    mask[:, off[A.USE] + 1] = can_use & ~sim.load_wait[at, seat]

    held = sim.combat.weapons_held(at, seat)
    if allowed_weapons is not None:
        held = held & allowed_weapons[at]
    mask[:, off[A.WEAPON] + A.WEAPON_ACTION] = held
    mask[:, off[A.LOCK_AIM] + 1] = ~melee

    known = sim.perception.known_position(seat, at)
    gap = known - sim.pos[at, seat]
    close = np.hypot(gap[:, 0], gap[:, 2]) < A.FINE_TURN_RANGE
    if close.any():
        fine_yaw = off[A.YAW] + np.flatnonzero(A.FINE_YAW)
        fine_pitch = off[A.PITCH] + np.flatnonzero(A.FINE_PITCH)
        mask[np.ix_(close, fine_yaw)] = False
        mask[np.ix_(close, fine_pitch)] = False
    return mask


__all__ = ["MAX_ARROWS", "OBS_DIM", "build_masks", "build_obs", "intercept_angles", "view_angles"]
