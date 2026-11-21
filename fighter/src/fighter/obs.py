"""Egocentric observations and action masks."""

from __future__ import annotations

import numpy as np

from . import actions as A
from . import constants as C
from .sim import MAX_ARROWS, Sim, look_vectors

OBS_DIM = 84
NEAREST_ARROWS = 2


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
    Returns the yaw, the pitch and the estimated flight time in ticks.
    """
    other = 1 - seat
    eye = sim.pos[:, seat] + np.array([0.0, C.EYE_HEIGHT, 0.0])
    target = sim.pos[:, other] + np.array([0.0, C.PLAYER_HEIGHT / 2.0, 0.0])
    vel = sim.vel[:, other] if lead else np.zeros_like(sim.vel[:, other])
    c = C.ARROW_DRAG
    flight = np.linalg.norm(target - eye, axis=-1) / speed
    aim = target
    for _ in range(4):
        aim = target.copy()
        aim[:, 0] += vel[:, 0] * flight
        aim[:, 2] += vel[:, 2] * flight
        limit = sim.cfg.arena_half - C.PLAYER_WIDTH / 2.0
        aim[:, 0] = np.clip(aim[:, 0], -limit, limit)
        aim[:, 2] = np.clip(aim[:, 2], -limit, limit)
        reach = np.hypot(aim[:, 0] - eye[:, 0], aim[:, 2] - eye[:, 2])
        fraction = np.clip(reach * (1.0 - c) / speed, 0.0, 0.9)
        flight = np.log1p(-fraction) / np.log(c)
    drop = C.ARROW_GRAVITY * (flight - (1.0 - c**flight) / (1.0 - c)) / (1.0 - c)
    aim = aim.copy()
    aim[:, 1] += drop
    yaw, pitch = view_angles(aim - eye)
    return yaw, pitch, flight


def _ego(dx: np.ndarray, dz: np.ndarray, yaw: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    rad = np.radians(yaw)
    sin_y = np.sin(rad)
    cos_y = np.cos(rad)
    return dx * -sin_y + dz * cos_y, dx * -cos_y + dz * -sin_y


def build_obs(sim: Sim, seat: int, max_ticks: int) -> np.ndarray:
    """Build the observation of one seat, shape (n, OBS_DIM)."""
    n = sim.n
    me = seat
    you = 1 - seat
    obs = np.zeros((n, OBS_DIM), dtype=np.float32)
    yaw = sim.yaw[:, me]
    multiplier = sim.attack_multiplier()
    charged = multiplier >= C.FULL_CHARGE_THRESHOLD
    active = sim.shield_active

    forward_v, right_v = _ego(sim.vel[:, me, 0], sim.vel[:, me, 2], yaw)
    obs[:, 0] = sim.hp[:, me] / C.MAX_HEALTH
    obs[:, 1] = forward_v * 2.0
    obs[:, 2] = right_v * 2.0
    obs[:, 3] = sim.vel[:, me, 1] * 2.0
    obs[:, 4] = sim.on_ground[:, me]
    obs[:, 5] = sim.sprinting[:, me]
    obs[:, 6] = sim.sprint_held[:, me]
    obs[:, 7] = np.sin(np.radians(sim.pitch[:, me]))
    obs[:, 8] = multiplier[:, me]
    obs[:, 9] = charged[:, me]
    obs[:, 10] = np.minimum(sim.shield_ticks[:, me] / C.SHIELD_RAISE_TICKS, 1.0)
    obs[:, 11] = active[:, me]
    obs[:, 12] = sim.shield_disabled[:, me] / C.SHIELD_DISABLE_TICKS
    obs[np.arange(n), 13 + sim.weapon[:, me]] = 1.0
    obs[:, 17] = np.minimum(sim.draw_ticks[:, me] / C.BOW_FULL_DRAW_TICKS, 1.0)
    obs[:, 18] = sim.load_ticks[:, me] / C.CROSSBOW_LOAD_TICKS
    obs[:, 19] = sim.loaded[:, me]
    obs[:, 20] = sim.hurt_timer[:, me] / C.HURT_TICKS
    obs[:, 21] = (sim.vel[:, me, 1] < 0.0) & ~sim.on_ground[:, me] & charged[:, me]

    delta = sim.pos[:, you] - sim.pos[:, me]
    forward_d, right_d = _ego(delta[:, 0], delta[:, 2], yaw)
    distance = np.hypot(delta[:, 0], delta[:, 2])
    scale = 2.0 * sim.cfg.arena_half
    chest = sim.pos[:, you] + np.array([0.0, C.PLAYER_HEIGHT / 2.0, 0.0])
    eye = sim.pos[:, me] + np.array([0.0, C.EYE_HEIGHT, 0.0])
    want_yaw, want_pitch = view_angles(chest - eye)
    yaw_error = np.radians(wrap_degrees(want_yaw - yaw))
    aim = sim.aim_hits()[:, me]

    obs[:, 22] = forward_d / scale
    obs[:, 23] = right_d / scale
    obs[:, 24] = delta[:, 1] / 4.0
    obs[:, 25] = distance / scale
    obs[:, 26] = np.minimum(distance / 6.0, 1.0)
    obs[:, 27] = np.sin(yaw_error)
    obs[:, 28] = np.cos(yaw_error)
    obs[:, 29] = (want_pitch - sim.pitch[:, me]) / 90.0
    obs[:, 30] = sim.aim_hits(reach=64.0)[:, me]
    obs[:, 31] = aim

    other_fv, other_rv = _ego(sim.vel[:, you, 0], sim.vel[:, you, 2], yaw)
    obs[:, 32] = other_fv * 2.0
    obs[:, 33] = other_rv * 2.0
    obs[:, 34] = sim.vel[:, you, 1] * 2.0
    obs[:, 35] = sim.hp[:, you] / C.MAX_HEALTH
    obs[:, 36] = active[:, you]
    obs[:, 37] = np.minimum(sim.shield_ticks[:, you] / C.SHIELD_RAISE_TICKS, 1.0)
    obs[:, 38] = sim.shield_disabled[:, you] / C.SHIELD_DISABLE_TICKS
    obs[np.arange(n), 39 + sim.weapon[:, you]] = 1.0
    obs[:, 43] = sim.on_ground[:, you]
    obs[:, 44] = sim.sprinting[:, you]
    obs[:, 45] = multiplier[:, you]
    obs[:, 46] = np.minimum(sim.draw_ticks[:, you] / C.BOW_FULL_DRAW_TICKS, 1.0)
    obs[:, 47] = sim.load_ticks[:, you] / C.CROSSBOW_LOAD_TICKS
    obs[:, 48] = sim.loaded[:, you]
    obs[:, 49] = sim.hurt_timer[:, you] / C.HURT_TICKS
    their_view = look_vectors(sim.yaw[:, you], np.zeros(n))
    safe = np.maximum(distance, 1e-6)
    facing_me = -(their_view[:, 0] * delta[:, 0] + their_view[:, 2] * delta[:, 2]) / safe
    obs[:, 50] = facing_me
    obs[:, 51] = active[:, you] & (facing_me > 0.0)
    obs[:, 52] = sim.ticks / max_ticks

    speed = np.where(sim.weapon[:, me] == C.CROSSBOW, C.CROSSBOW_SPEED, C.BOW_MAX_SPEED)
    lead_yaw, lead_pitch, flight = intercept_angles(sim, me, speed)
    lead_error = np.radians(wrap_degrees(lead_yaw - yaw))
    obs[:, 53] = np.sin(lead_error)
    obs[:, 54] = np.clip((lead_pitch - sim.pitch[:, me]) / 45.0, -2.0, 2.0)
    obs[:, 55] = np.minimum(flight / 40.0, 2.0)

    _arrow_features(sim, me, yaw, obs)

    obs[:, 72], obs[:, 73] = _ego(sim.pos[:, me, 0], sim.pos[:, me, 2], yaw)
    obs[:, 72] /= sim.cfg.arena_half
    obs[:, 73] /= sim.cfg.arena_half
    wall = sim.cfg.arena_half - np.maximum(np.abs(sim.pos[:, me, 0]), np.abs(sim.pos[:, me, 2]))
    obs[:, 74] = wall / sim.cfg.arena_half

    # Fine aim errors give the network a strong signal near the target.
    lead_yaw_deg = wrap_degrees(lead_yaw - yaw)
    lead_pitch_deg = lead_pitch - sim.pitch[:, me]
    obs[:, 75] = np.clip(np.degrees(yaw_error) / 10.0, -1.0, 1.0)
    obs[:, 76] = np.clip((want_pitch - sim.pitch[:, me]) / 10.0, -1.0, 1.0)
    obs[:, 77] = np.clip(lead_yaw_deg / 10.0, -1.0, 1.0)
    obs[:, 78] = np.clip(lead_pitch_deg / 10.0, -1.0, 1.0)
    obs[:, 79] = np.clip(lead_yaw_deg / 2.0, -1.0, 1.0)
    obs[:, 80] = np.clip(lead_pitch_deg / 2.0, -1.0, 1.0)
    obs[:, 81] = (sim.draw_ticks[:, me] >= C.BOW_FULL_DRAW_TICKS) | sim.loaded[:, me]

    # The crossbow acts on a fresh press, so the policy must see the held state.
    obs[:, 82] = sim.use_prev[:, me]
    obs[:, 83] = sim.load_wait[:, me]
    return obs


def _arrow_features(sim: Sim, me: int, yaw: np.ndarray, obs: np.ndarray) -> None:
    """Fill slots 56 to 71 with the two most urgent incoming arrows."""
    incoming = sim.arrow_on & (sim.arrow_owner != me)
    if not incoming.any():
        return
    center = sim.pos[:, me] + np.array([0.0, C.PLAYER_HEIGHT / 2.0, 0.0])
    rel = sim.arrow_pos - center[:, None, :]
    vel = sim.arrow_vel
    speed_sq = np.maximum((vel * vel).sum(axis=-1), 1e-6)
    closest = np.clip(-(rel * vel).sum(axis=-1) / speed_sq, 0.0, 60.0)
    miss = rel + vel * closest[..., None]
    miss_dist = np.linalg.norm(miss, axis=-1)
    urgency = np.where(incoming, closest + miss_dist, np.inf)
    order = np.argsort(urgency, axis=1)[:, :NEAREST_ARROWS]
    rows = np.arange(sim.n)
    for rank in range(NEAREST_ARROWS):
        slot = order[:, rank]
        live = incoming[rows, slot]
        if not live.any():
            continue
        base = 56 + rank * 8
        r = rel[rows, slot]
        v = vel[rows, slot]
        fr, rr = _ego(r[:, 0], r[:, 2], yaw)
        fv, rv = _ego(v[:, 0], v[:, 2], yaw)
        obs[:, base + 0] = live * fr / (2.0 * sim.cfg.arena_half)
        obs[:, base + 1] = live * rr / (2.0 * sim.cfg.arena_half)
        obs[:, base + 2] = live * r[:, 1] / 4.0
        obs[:, base + 3] = live * fv / 3.0
        obs[:, base + 4] = live * rv / 3.0
        obs[:, base + 5] = live * v[:, 1] / 3.0
        obs[:, base + 6] = live * np.minimum(closest[rows, slot] / 20.0, 1.0)
        obs[:, base + 7] = live & (miss_dist[rows, slot] < 1.3)


def build_masks(sim: Sim, seat: int, allowed_weapons: np.ndarray | None = None) -> np.ndarray:
    """Return a flat boolean mask of shape (n, MASK_SIZE)."""
    n = sim.n
    mask = np.ones((n, A.MASK_SIZE), dtype=bool)
    off = A.HEAD_OFFSETS
    weapon = sim.weapon[:, seat]
    melee = weapon <= C.AXE
    using = (melee & (sim.shield_ticks[:, seat] > 0)) | (sim.draw_ticks[:, seat] > 0) | (
        sim.load_ticks[:, seat] > 0
    )
    mask[:, off[A.SPRINT] + 1] = ~using
    mask[:, off[A.JUMP] + 1] = sim.on_ground[:, seat]
    mask[:, off[A.ATTACK] + 1] = melee & sim.aim_hits()[:, seat]
    mask[:, off[A.USE] + 1] = ~melee | (sim.shield_disabled[:, seat] == 0)
    if allowed_weapons is not None:
        mask[:, off[A.WEAPON] : off[A.WEAPON] + C.NUM_WEAPONS] = allowed_weapons
    return mask


__all__ = ["MAX_ARROWS", "OBS_DIM", "build_masks", "build_obs", "intercept_angles", "view_angles"]
