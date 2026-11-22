"""Bow, crossbow and arrow physics over the arrays of a `Sim`.

One game tick for an arrow in flight, in order: find the first block and the
first player on the segment from `p` to `p + v`, resolve what it touched, move,
multiply `v` by the drag, then subtract gravity. With no world object the arena
floor and walls stand in for blocks.
"""

from __future__ import annotations

import numpy as np

from . import constants as C

ARROWS_PER_SIDE = 6
MAX_ARROWS = 2 * ARROWS_PER_SIDE
MAX_STUCK = 24
START_ARROWS = 6

SPAWN_BELOW_EYE = 0.1
LAUNCH_SPREAD = 0.0172275
AIM_POINT_HEIGHT = 1.2
AIM_MIN_POWER = 0.1
AIM_MIN_REACH = 0.05
AIM_MAX_LOFT = 1.4

WATER_DRAG = 0.6
DEFLECT_FACTOR = -0.1
STICK_BACKOFF = 0.05
HIT_MARGIN_MAX = 0.3
HIT_MARGIN_START_AGE = 2
HIT_MARGIN_PER_TICK = 0.05

SHAKE_TICKS = 7
DESPAWN_TICKS = 1200
PICKUP_HALF_WIDTH = 1.55
PICKUP_BELOW = 1.0
PICKUP_ABOVE_HEAD = 0.5

ARROW_BOX = 0.5
ARROW_EYE = 0.13
BELOW_WORLD = 64.0
NEGLIGIBLE_DAMAGE = 1e-9
SOLVER_ITERATIONS = 4
GROUND_SEARCH = 48.0
BODY_TERMINAL = C.GRAVITY * C.VERTICAL_DRAG / (1.0 - C.VERTICAL_DRAG)
LOG_BODY_DRAG = float(np.log(C.VERTICAL_DRAG))
LOG_ARROW_DRAG = float(np.log(C.ARROW_DRAG))


def init_state(sim) -> None:
    """Create the arrow arrays of a simulator."""
    n = sim.n
    sim.ammo = np.zeros((n, 2), dtype=np.int64)
    sim.arrow_on = np.zeros((n, MAX_ARROWS), dtype=bool)
    sim.arrow_pos = np.zeros((n, MAX_ARROWS, 3))
    sim.arrow_vel = np.zeros((n, MAX_ARROWS, 3))
    sim.arrow_owner = np.zeros((n, MAX_ARROWS), dtype=np.int64)
    sim.arrow_crit = np.zeros((n, MAX_ARROWS), dtype=bool)
    sim.arrow_age = np.zeros((n, MAX_ARROWS), dtype=np.int64)
    sim.arrow_bounced = np.zeros((n, MAX_ARROWS), dtype=bool)
    sim.arrow_pickup = np.ones((n, MAX_ARROWS), dtype=bool)
    sim.arrow_damage = np.full((n, MAX_ARROWS), C.ARROW_BASE_DAMAGE)
    sim.arrow_punch = np.zeros((n, MAX_ARROWS), dtype=np.int64)
    sim.arrow_flame = np.zeros((n, MAX_ARROWS), dtype=bool)
    sim.stuck_on = np.zeros((n, MAX_STUCK), dtype=bool)
    sim.stuck_pos = np.zeros((n, MAX_STUCK, 3))
    sim.stuck_into = np.zeros((n, MAX_STUCK, 3))
    sim.stuck_age = np.zeros((n, MAX_STUCK), dtype=np.int64)
    sim.stuck_owner = np.zeros((n, MAX_STUCK), dtype=np.int64)
    sim.stuck_pickup = np.ones((n, MAX_STUCK), dtype=bool)
    sim.stuck_damage = np.full((n, MAX_STUCK), C.ARROW_BASE_DAMAGE)
    sim.stuck_punch = np.zeros((n, MAX_STUCK), dtype=np.int64)
    sim.stuck_flame = np.zeros((n, MAX_STUCK), dtype=bool)


def reset_state(sim, idx: np.ndarray) -> None:
    """Clear the arrows of the given arenas and refill their quivers."""
    sim.ammo[idx] = sim.cfg.start_arrows
    sim.arrow_on[idx] = False
    sim.stuck_on[idx] = False


def body_heights(sim) -> np.ndarray:
    """Return the hitbox height of each player."""
    return sim.body.heights()


def spawn_heights(sim) -> np.ndarray:
    """Return the height above the feet at which each player's arrows appear."""
    return sim.body.eyes() - SPAWN_BELOW_EYE


def carried_velocity(sim, env: np.ndarray, seat: int) -> np.ndarray:
    """Return the shooter's last tick of movement that a launch keeps. Only a bow carries it."""
    carried = sim.body.last_move[env, seat].copy()
    carried[sim.on_ground[env, seat], 1] = 0.0
    carried[sim.weapon[env, seat] != C.BOW] = 0.0
    return carried


def fire(sim, mask: np.ndarray, speed: np.ndarray, crit: np.ndarray) -> None:
    """Launch one arrow for each selected player."""
    look = sim.look()
    heights = spawn_heights(sim)
    for seat in (0, 1):
        env = np.flatnonzero(mask[:, seat])
        if env.size == 0:
            continue
        own = sim.arrow_on[env] & (sim.arrow_owner[env] == seat)
        oldest = np.where(own, sim.arrow_age[env], -1).argmax(axis=1)
        free = (~sim.arrow_on[env]).argmax(axis=1)
        slot = np.where(own.sum(axis=1) >= ARROWS_PER_SIDE, oldest, free)

        noise = sim.rng.random((env.size, 6))
        spread = LAUNCH_SPREAD * (noise[:, :3] - noise[:, 3:])
        velocity = (look[env, seat] + spread) * speed[env, seat][:, None]
        velocity += carried_velocity(sim, env, seat)
        start = sim.pos[env, seat].copy()
        start[:, 1] += heights[env, seat]

        sim.arrow_on[env, slot] = True
        sim.arrow_pos[env, slot] = start
        sim.arrow_vel[env, slot] = velocity
        sim.arrow_owner[env, slot] = seat
        sim.arrow_crit[env, slot] = crit[env, seat]
        sim.arrow_age[env, slot] = 0
        sim.arrow_bounced[env, slot] = False
        sim.arrow_pickup[env, slot] = True
        power, punch, flame = sim.combat.bow_enchants(env, seat)
        bow = sim.weapon[env, seat] == C.BOW
        bonus = np.where(bow & (power > 0), C.POWER_DAMAGE_PER_LEVEL * (power + 1), 0.0)
        sim.arrow_damage[env, slot] = C.ARROW_BASE_DAMAGE + bonus
        sim.arrow_punch[env, slot] = punch * bow
        sim.arrow_flame[env, slot] = (flame > 0) & bow
        sim.events["arrows_fired"][env, seat] += 1.0


def entry_fraction(
    start: np.ndarray, delta: np.ndarray, low: np.ndarray, high: np.ndarray
) -> np.ndarray:
    """Return where each segment enters its box, as a fraction, or infinity.

    A segment that starts inside a box never enters it.
    """
    safe = np.where(np.abs(delta) < 1e-12, 1e-12, delta)
    t1 = (low - start) / safe
    t2 = (high - start) / safe
    near = np.minimum(t1, t2).max(axis=-1)
    far = np.maximum(t1, t2).min(axis=-1)
    enters = (near <= far) & (near > 0.0) & (near <= 1.0)
    return np.where(enters, near, np.inf)


def hit_margin(age: np.ndarray) -> np.ndarray:
    """Return how far a target box grows for an arrow that has lived `age` ticks."""
    grown = (age - HIT_MARGIN_START_AGE) * HIT_MARGIN_PER_TICK
    return np.minimum(np.maximum(grown, 0.0), HIT_MARGIN_MAX)


def _arena_contact(sim, start: np.ndarray, vel: np.ndarray) -> np.ndarray:
    """Return the fraction of the step at which an arrow meets the floor or a wall."""
    half = sim.cfg.arena_half
    fraction = np.full(len(start), np.inf)
    down = vel[:, 1] < 0.0
    fraction[down] = -start[down, 1] / vel[down, 1]
    for axis in (0, 2):
        moving = vel[:, axis] != 0.0
        wall = np.where(vel[:, axis] > 0.0, half, -half)
        crossing = np.full(len(start), np.inf)
        crossing[moving] = (wall[moving] - start[moving, axis]) / vel[moving, axis]
        fraction = np.minimum(fraction, crossing)
    fraction = np.maximum(fraction, 0.0)
    return np.where(fraction <= 1.0, fraction, np.inf)


def _world_contact(
    sim, env: np.ndarray, slot: np.ndarray, start: np.ndarray, vel: np.ndarray
) -> np.ndarray:
    """Return the fraction of the step at which an arrow meets a collision box."""
    speed = np.linalg.norm(vel, axis=-1)
    moving = speed > 1e-9
    origin = np.zeros((sim.n, MAX_ARROWS, 3))
    heading = np.zeros((sim.n, MAX_ARROWS, 3))
    origin[env, slot] = start
    heading[env[moving], slot[moving]] = vel[moving] / speed[moving, None]
    hit, _, _, dist = sim.world.ray_collide_many(origin, heading, float(speed.max()) + 1e-6)
    along = dist[env, slot]
    found = hit[env, slot] & moving & (along <= speed)
    fraction = np.full(len(env), np.inf)
    fraction[found] = along[found] / speed[found]
    return fraction


def _in_water(sim, env: np.ndarray, slot: np.ndarray) -> np.ndarray:
    """Return which arrows are touching water."""
    shape = (sim.n, MAX_ARROWS)
    width = np.full(shape, ARROW_BOX)
    eye = np.full(shape, ARROW_EYE)
    found = sim.world.fluid_box_many(sim.arrow_pos, width, width, eye)
    return found["in_water"][env, slot]


def step_arrows(sim) -> None:
    """Advance every arrow in flight and every arrow in the ground by one tick."""
    if sim.stuck_on.any():
        _update_stuck(sim)
    if not sim.arrow_on.any():
        return
    env, slot = np.nonzero(sim.arrow_on)
    drag = np.full(len(env), C.ARROW_DRAG)
    if sim.world is not None:
        drag[_in_water(sim, env, slot)] = WATER_DRAG
    age = sim.arrow_age[env, slot] + 1
    sim.arrow_age[env, slot] = age
    start = sim.arrow_pos[env, slot]
    vel = sim.arrow_vel[env, slot]
    owner = sim.arrow_owner[env, slot]
    victim = 1 - owner

    if sim.world is None:
        block_at = _arena_contact(sim, start, vel)
    else:
        block_at = _world_contact(sim, env, slot, start, vel)

    half = C.PLAYER_WIDTH / 2.0
    margin = hit_margin(age)[:, None]
    feet = sim.pos[env, victim]
    low = feet - margin
    low[:, [0, 2]] -= half
    high = feet + margin
    high[:, [0, 2]] += half
    high[:, 1] += body_heights(sim)[env, victim]
    body_at = entry_fraction(start, vel, low, high)

    strikes = np.isfinite(body_at) & (body_at <= block_at)
    lands = np.isfinite(block_at) & ~strikes
    end = start + vel
    gone = np.zeros(len(env), dtype=bool)

    if strikes.any():
        at = np.flatnonzero(strikes)
        entry = start[at] + vel[at] * body_at[at, None]
        survives = _strike(sim, env[at], slot[at], victim[at], vel[at], entry)
        gone[at[~survives]] = True
        bounced = at[survives]
        end[bounced] = entry[survives]
        vel = vel.copy()
        vel[bounced] *= DEFLECT_FACTOR

    if lands.any():
        at = np.flatnonzero(lands)
        contact = start[at] + vel[at] * block_at[at, None]
        _stick(sim, env[at], slot[at], contact - STICK_BACKOFF * np.sign(vel[at]), vel[at])
        gone[at] = True

    if sim.world is not None:
        gone |= _left_world(sim, end)

    sim.arrow_on[env[gone], slot[gone]] = False
    keep = ~gone
    new_vel = vel[keep] * drag[keep, None]
    new_vel[:, 1] -= C.ARROW_GRAVITY
    sim.arrow_pos[env[keep], slot[keep]] = end[keep]
    sim.arrow_vel[env[keep], slot[keep]] = new_vel


def _left_world(sim, pos: np.ndarray) -> np.ndarray:
    """Return which positions are past the sides or below the bottom of the world."""
    from .world import blocks as B

    base = sim.world.base
    return (
        (pos[:, 0] < 0.0)
        | (pos[:, 0] >= base.nx)
        | (pos[:, 2] < 0.0)
        | (pos[:, 2] >= base.nz)
        | (pos[:, 1] < B.Y_MIN - BELOW_WORLD)
    )


def _strike(
    sim,
    env: np.ndarray,
    slot: np.ndarray,
    victim: np.ndarray,
    vel: np.ndarray,
    entry: np.ndarray,
) -> np.ndarray:
    """Resolve arrows reaching a player. Return which stay alive and bounce back."""
    survives = np.zeros(len(env), dtype=bool)
    for value in np.unique(slot):
        at = np.flatnonzero(slot == value)
        survives[at] = _strike_slot(sim, env[at], int(value), victim[at], vel[at], entry[at])
    return survives


def _strike_slot(
    sim,
    env: np.ndarray,
    slot: int,
    victim: np.ndarray,
    vel: np.ndarray,
    entry: np.ndarray,
) -> np.ndarray:
    speed = np.sqrt((vel * vel).sum(axis=-1))
    base = np.ceil(sim.arrow_damage[env, slot] * speed)
    extra = sim.rng.integers(0, np.floor(base / 2.0).astype(np.int64) + 2)
    raw = sim.arrow_hit_damage(base + extra * sim.arrow_crit[env, slot], env, slot)

    yaw = np.radians(sim.yaw[env, victim])
    to_arrow = entry - sim.pos[env, victim]
    front = -np.sin(yaw) * to_arrow[:, 0] + np.cos(yaw) * to_arrow[:, 2] > 0.0
    blocked = sim.shield_active[env, victim] & front
    first = blocked & ~sim.arrow_bounced[env, slot]
    sim.events["arrows_blocked"][env[first], victim[first]] += 1.0

    horizontal = np.maximum(np.hypot(vel[:, 0], vel[:, 2]), 1e-6)
    push = np.stack([vel[:, 0] / horizontal, vel[:, 2] / horizontal], axis=-1)
    survives = blocked.copy()
    for seat in (0, 1):
        pick = victim == seat
        if not pick.any():
            continue
        mask = np.zeros(sim.n, dtype=bool)
        direction = np.zeros((sim.n, 2))
        direction[env[pick]] = push[pick]
        knockback = np.full(sim.n, C.BASE_KNOCKBACK)

        guarded = pick & blocked
        if guarded.any():
            sim.combat.block_arrow(env[guarded], seat, raw[guarded], direction, knockback)

        open_hit = pick & ~blocked
        if not open_hit.any():
            continue
        mask[env[open_hit]] = True
        full_raw = np.zeros(sim.n)
        full_raw[env[open_hit]] = raw[open_hit]
        punch = np.zeros(sim.n, dtype=np.int64)
        punch[env[open_hit]] = sim.arrow_punch[env[open_hit], slot]
        in_window = sim.hurt_timer[:, seat] > 0
        first_touch = np.zeros(sim.n, dtype=bool)
        first_touch[env[open_hit]] = ~sim.arrow_bounced[env[open_hit], slot]
        dealt = sim._hurt(mask, seat, full_raw, direction, knockback, punch)
        landed = mask & (dealt > 0.0)
        sim.events["arrows_wasted"][:, 1 - seat] += mask & first_touch & in_window & ~landed
        lit = env[open_hit][landed[env[open_hit]] & sim.arrow_flame[env[open_hit], slot]]
        if len(lit):
            sim.combat.ignite(lit, seat, np.full(len(lit), C.FLAME_TICKS))
        survives[open_hit] = ~landed[env[open_hit]]
        sim.events["damage_taken"][:, seat] += dealt
        sim.events["damage_dealt"][:, 1 - seat] += dealt
        sim.events["arrow_hits"][:, 1 - seat] += landed
        sim.events["arrows_taken"][:, seat] += landed
        sim.events["followup_damage"][:, 1 - seat] += dealt * (sim.followup[:, 1 - seat] > 0)
    sim.arrow_bounced[env[survives], slot] = True
    return survives


def _stick(
    sim, env: np.ndarray, slot: np.ndarray, where: np.ndarray, vel: np.ndarray
) -> None:
    """Move landed arrows into ground slots, replacing the oldest when full."""
    owner = sim.arrow_owner[env, slot]
    pickup = sim.arrow_pickup[env, slot]
    damage = sim.arrow_damage[env, slot]
    punch = sim.arrow_punch[env, slot]
    flame = sim.arrow_flame[env, slot]
    into = np.sign(vel)
    into /= np.maximum(np.linalg.norm(into, axis=-1, keepdims=True), 1e-9)
    remaining = np.arange(len(env))
    while remaining.size:
        _, first = np.unique(env[remaining], return_index=True)
        now = remaining[first]
        e = env[now]
        full = sim.stuck_on[e].all(axis=1)
        free = (~sim.stuck_on[e]).argmax(axis=1)
        target = np.where(full, sim.stuck_age[e].argmax(axis=1), free)
        sim.stuck_on[e, target] = True
        sim.stuck_pos[e, target] = where[now]
        sim.stuck_into[e, target] = into[now]
        sim.stuck_age[e, target] = 0
        sim.stuck_owner[e, target] = owner[now]
        sim.stuck_pickup[e, target] = pickup[now]
        sim.stuck_damage[e, target] = damage[now]
        sim.stuck_punch[e, target] = punch[now]
        sim.stuck_flame[e, target] = flame[now]
        remaining = np.delete(remaining, first)


def _update_stuck(sim) -> None:
    env, slot = np.nonzero(sim.stuck_on)
    age = sim.stuck_age[env, slot] + 1
    sim.stuck_age[env, slot] = age
    expired = age >= DESPAWN_TICKS
    if expired.any():
        sim.stuck_on[env[expired], slot[expired]] = False
    if sim.world is not None:
        _drop_unsupported(sim)
    ready = (age >= SHAKE_TICKS) & ~expired & sim.stuck_pickup[env, slot]
    ready &= sim.stuck_on[env, slot]
    if ready.any():
        _pick_up(sim, env[ready], slot[ready])


def _pick_up(sim, env: np.ndarray, slot: np.ndarray) -> None:
    """Give arrows to living players whose pickup box reaches them."""
    delta = sim.stuck_pos[env, slot][:, None, :] - sim.pos[env]
    above = delta[..., 1]
    near = (
        (np.abs(delta[..., 0]) <= PICKUP_HALF_WIDTH)
        & (np.abs(delta[..., 2]) <= PICKUP_HALF_WIDTH)
        & (above >= -PICKUP_BELOW)
        & (above <= body_heights(sim)[env] + PICKUP_ABOVE_HEAD)
        & (sim.hp[env] > 0.0)
    )
    taken = near.any(axis=1)
    if not taken.any():
        return
    env = env[taken]
    slot = slot[taken]
    near = near[taken]
    first_seat = sim.rng.integers(0, 2, size=len(env))
    both = near.all(axis=1)
    seat = np.where(both, first_seat, near.argmax(axis=1))
    sim.stuck_on[env, slot] = False
    np.add.at(sim.ammo, (env, seat), 1)
    np.add.at(sim.events["arrows_picked"], (env, seat), 1.0)


def _drop_unsupported(sim) -> None:
    """Put arrows back in flight when the block holding them is gone."""
    origin = np.where(sim.stuck_on[..., None], sim.stuck_pos, 0.0)
    heading = np.where(sim.stuck_on[..., None], sim.stuck_into, 0.0)
    hit, _, _, _ = sim.world.ray_collide_many(origin, heading, 2.0 * STICK_BACKOFF * np.sqrt(3.0))
    loose = sim.stuck_on & ~hit
    if not loose.any():
        return
    for e, s in zip(*np.nonzero(loose)):
        sim.stuck_on[e, s] = False
        free = np.flatnonzero(~sim.arrow_on[e])
        if free.size == 0:
            continue
        target = free[0]
        sim.arrow_on[e, target] = True
        sim.arrow_pos[e, target] = sim.stuck_pos[e, s]
        sim.arrow_vel[e, target] = 0.0
        sim.arrow_owner[e, target] = sim.stuck_owner[e, s]
        sim.arrow_crit[e, target] = False
        sim.arrow_age[e, target] = HIT_MARGIN_START_AGE
        sim.arrow_bounced[e, target] = True
        sim.arrow_pickup[e, target] = sim.stuck_pickup[e, s]
        sim.arrow_damage[e, target] = sim.stuck_damage[e, s]
        sim.arrow_punch[e, target] = sim.stuck_punch[e, s]
        sim.arrow_flame[e, target] = sim.stuck_flame[e, s]


def _target_ground(sim, seat: int, viewer: int) -> np.ndarray:
    """Return the height a falling player will land on, as far as the viewer has seen.

    A column the viewer has not seen gives no floor, so the target keeps falling.
    """
    if sim.world is None:
        return np.zeros(sim.n)
    from .world.view import RAY_BLOCKED

    view = sim.world_view()
    ground = np.full(sim.n, -np.inf)
    down = (0.0, -1.0, 0.0)
    for env in np.flatnonzero(~sim.on_ground[:, seat]).tolist():
        start = sim.pos[env, seat] + (0.0, 0.01, 0.0)
        dist, kind = view.ray(env, viewer, start, down, GROUND_SEARCH)
        if kind == RAY_BLOCKED:
            ground[env] = start[1] - dist
    return ground


def aim_speed(sim, seat: int, at=slice(None)) -> np.ndarray:
    """Return the launch speed a shot would have now, with a full draw assumed until drawing."""
    draw = sim.draw_ticks[at, seat]
    pull = np.where(draw > 0, np.minimum(draw / C.BOW_FULL_DRAW_TICKS, 1.0), 1.0)
    power = np.minimum((pull * pull + 2.0 * pull) / 3.0, 1.0)
    return np.where(
        sim.weapon[at, seat] == C.BOW, C.BOW_MAX_SPEED * np.maximum(power, AIM_MIN_POWER), C.CROSSBOW_SPEED
    )


def target_motion(sim, seat: int, at=slice(None)) -> np.ndarray:
    """Return the motion to lead a player by.

    `sim.vel` already has this tick's friction applied, so a walking player's
    reads about 0.55 of its real speed. Sideways motion comes from the last tick
    of movement, which is also what the game client tracks.
    """
    motion = sim.body.last_move[at, seat].copy()
    motion[:, 1] = sim.vel[at, seat, 1]
    return motion


def intercept(
    sim, seat: int, speed: np.ndarray, lead: bool = True, rows: np.ndarray | None = None, seen=None
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Solve the view angles that put an arrow on the other player.

    After `k` ticks an arrow has moved `100 * v * (1 - 0.99^k)` sideways and
    `(vy + 5) * 100 * (1 - 0.99^k) - 5 * k` upward. With lead on, the aim point
    follows the target for the flight time and a falling target stops at its
    ground height. Returns the yaw, the pitch and the flight time in ticks.

    rows limits the solve to some arenas. seen replaces the target with a known
    position, velocity and visible flag, for a shooter that cannot see it.
    """
    at = slice(None) if rows is None else rows
    other = 1 - seat
    height = spawn_heights(sim)[at, seat]
    from_x = sim.pos[at, seat, 0]
    from_y = sim.pos[at, seat, 1] + height
    from_z = sim.pos[at, seat, 2]
    bow = sim.weapon[at, seat] == C.BOW
    moved = sim.body.last_move[at, seat]
    carry_x = moved[:, 0] * bow
    carry_y = moved[:, 1] * (bow & ~sim.on_ground[at, seat])
    carry_z = moved[:, 2] * bow
    target = sim.pos[at, other] if seen is None else seen[0]
    target_vel = target_motion(sim, other, at) if seen is None else seen[1]
    to_x = target[:, 0]
    to_y = target[:, 1]
    to_z = target[:, 2]
    lead_x = target_vel[:, 0] * lead
    lead_z = target_vel[:, 2] * lead
    airborne = ~sim.on_ground[at, other] & lead
    if seen is not None:
        airborne = airborne & seen[2]
    falling = airborne.any()
    ground = _target_ground(sim, other, seat)[at] if falling else to_y
    limit = sim.cfg.arena_half - C.PLAYER_WIDTH / 2.0
    keep_inside = sim.world is None

    terminal = BODY_TERMINAL
    log_body = LOG_BODY_DRAG
    log_drag = LOG_ARROW_DRAG
    rate = 1.0 / np.maximum(speed, 1e-6)
    gap_x = to_x - from_x
    gap_z = to_z - from_z
    first = np.sqrt(gap_x * gap_x + gap_z * gap_z) * rate * (1.0 - C.ARROW_DRAG)
    flight = np.maximum(np.log1p(-np.minimum(first, 0.98)) / log_drag, 0.5)
    for _ in range(SOLVER_ITERATIONS):
        aim_x = to_x + lead_x * flight
        aim_z = to_z + lead_z * flight
        if keep_inside:
            aim_x = np.minimum(np.maximum(aim_x, -limit), limit)
            aim_z = np.minimum(np.maximum(aim_z, -limit), limit)
        aim_y = to_y
        if falling:
            fall = (target_vel[:, 1] + terminal) * -np.expm1(log_body * flight) / (
                1.0 - C.VERTICAL_DRAG
            ) - terminal * flight
            aim_y = np.where(airborne, np.maximum(to_y + fall, ground), to_y)
        reach = -100.0 * np.expm1(log_drag * flight)
        need_x = (aim_x - from_x) / reach - carry_x
        need_y = (aim_y + AIM_POINT_HEIGHT - from_y + 5.0 * flight) / reach - 5.0 - carry_y
        need_z = (aim_z - from_z) / reach - carry_z
        size = np.sqrt(need_x * need_x + need_y * need_y + need_z * need_z)
        scaled = np.minimum(np.maximum(reach * size * rate * 0.01, 1e-4), 0.98)
        flight = np.maximum(np.log1p(-scaled) / log_drag, 0.5)
    yaw = np.degrees(np.arctan2(-need_x, need_z))
    pitch = -np.degrees(np.arctan2(need_y, np.sqrt(need_x * need_x + need_z * need_z)))
    return yaw, pitch, flight
