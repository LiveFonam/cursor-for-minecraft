"""Body movement: input, jumping, collision, fluids, knockback and falls.

Arrays use the simulator's batch layout, (n, 2, ...). The flat arena moves bodies
over a plane at y = 0 and never calls the world. A world profile moves them through
the kernel's collision, fluid and contact calls.

A body has two sprint states. `sim.sprinting` is the flag the server holds, which
decides sprint hits. It rises when the client starts sprinting and clears when a
sprint hit lands. The client keeps running while the key stays held, so a second
sprint hit needs the key released and pressed again.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import actions as A
from . import constants as C

CLIENT_MODELS = ("vanilla", "mineflayer")

SNEAK_HEIGHT = 1.5
SNEAK_EYE = 1.27
SNEAK_INPUT = C.SNEAK_MULTIPLIER
ITEM_USE_INPUT = 0.2
STEP_HEIGHT = 0.6
JUMP_COOLDOWN = 10
TINY_VELOCITY = 0.003
TINY_HORIZONTAL_SQ = 9.0e-6
MINOR_WALL_COSINE = float(np.cos(0.13962634))
SPEED_PER_LEVEL = 0.2
SPRINT_MIN_FOOD = 6
SWIM_PULL = 0.06
SWIM_PULL_DOWN = 0.085
SWIM_PULL_DOWN_LOOK = -0.2
SWIM_HEAD_PROBE = 0.9
EDGE_STEP = 0.05
EDGE_MAX_STEPS = 80

FLUID_ACCEL = 0.02
FLUID_JUMP = 0.04
FLUID_JUMP_DEPTH = 0.4
WATER_DRAG = 0.8
WATER_SPRINT_DRAG = 0.9
WATER_SINK = 0.005
LAVA_DRAG = 0.5
LAVA_SHALLOW_VERTICAL_DRAG = 0.8
LAVA_SINK = 0.02
HOP_VELOCITY = 0.3
HOP_CLEARANCE = 0.6
WATER_FLOW_PUSH = 0.014
LAVA_FLOW_PUSH = 0.0023333333333333335
MIN_FLOW_PUSH = 0.0045
MINEFLAYER_FLUID_INSET = 0.4
WEB_SCALE = np.array([0.25, 0.05, 0.25])



def _input_tables() -> tuple[np.ndarray, np.ndarray]:
    """Return scaled forward and strafe inputs, indexed by forward, strafe and input mode.

    Mode bit 0 means an item is in use and bit 1 means the body is sneaking.
    """
    forward, strafe = np.meshgrid(A.FORWARD_VALUES, A.STRAFE_VALUES, indexing="ij")
    tables_f, tables_s = [], []
    for mode in range(4):
        move_f = forward * C.INPUT_SCALE
        move_s = strafe * C.INPUT_SCALE
        if mode & 1:
            move_f = move_f * ITEM_USE_INPUT
            move_s = move_s * ITEM_USE_INPUT
        if mode & 2:
            move_f = move_f * SNEAK_INPUT
            move_s = move_s * SNEAK_INPUT
        length = np.sqrt(move_f * move_f + move_s * move_s)
        scale = np.where(length > 1.0, 1.0 / np.maximum(length, 1e-9), 1.0)
        tables_f.append(move_f * scale)
        tables_s.append(move_s * scale)
    return np.stack(tables_f, axis=-1), np.stack(tables_s, axis=-1)


MOVE_FORWARD, MOVE_STRAFE = _input_tables()
GROUND_ACCEL = np.array(
    [[C.AIR_ACCEL, C.AIR_ACCEL_SPRINT], [C.MOVEMENT_SPEED * 1.0, C.MOVEMENT_SPEED * C.SPRINT_MULTIPLIER]]
)

KNOCKBACK_MIN_DIRECTION_SQ = 1.0e-5
REST_VELOCITY = -C.GRAVITY * C.VERTICAL_DRAG
PUSH_STRENGTH = 0.05
PUSH_MIN_AXIS = 0.01


@dataclass
class MoveConfig:
    """Body settings.

    client_model: "vanilla" or "mineflayer", the client that moves the body.
    sprint_restart: a held sprint key keeps the body running after a sprint hit.
    knockback_delay: ticks before knockback reaches the client. None uses the
        client model's value, 0 for vanilla and 1 for mineflayer.
    ceiling: height of a flat arena ceiling, or None for an open arena.
    server_copy: knockback starts from the server's copy of the velocity instead of
        the body's velocity. None uses `constants.KNOCKBACK_FROM_SERVER_COPY`.
    """

    client_model: str = "vanilla"
    sprint_restart: bool = True
    knockback_delay: int | None = None
    ceiling: float | None = None
    server_copy: bool | None = None

    def __post_init__(self) -> None:
        if self.client_model not in CLIENT_MODELS:
            raise ValueError(f"unknown client model {self.client_model!r}, expected one of {CLIENT_MODELS}")

    @property
    def vanilla(self) -> bool:
        return self.client_model == "vanilla"

    @property
    def delay(self) -> int:
        if self.knockback_delay is not None:
            return self.knockback_delay
        return 0 if self.vanilla else C.MINEFLAYER_KNOCKBACK_DELAY

    @property
    def tracks_server(self) -> bool:
        if self.server_copy is not None:
            return self.server_copy
        return C.KNOCKBACK_FROM_SERVER_COPY


class Bodies:
    """Per body movement state that sits beside the simulator's arrays.

    `sneak`, `speed_level` and `knockback_level` are simulator inputs and default to off.
    """

    def __init__(self, n: int, config: MoveConfig):
        shape = (n, 2)
        self.cfg = config
        self.sneak = np.zeros(shape, dtype=bool)
        self.sneak_slow = np.zeros(shape, dtype=bool)
        self.speed_level = np.zeros(shape, dtype=np.int64)
        self.knockback_level = np.zeros(shape, dtype=np.int64)
        self.fall = np.zeros(shape)
        self.jump_cooldown = np.zeros(shape, dtype=np.int64)
        self.cooldown_live = False
        self.wall_block = np.zeros(shape, dtype=bool)
        self.moved_y = np.zeros(shape)
        self.last_move = np.zeros((n, 2, 3))
        self._before = np.zeros((n, 2, 3))
        self.jumped = np.zeros(shape, dtype=bool)
        self.eye_was_wet = np.zeros(shape, dtype=bool)
        self.swimming = np.zeros(shape, dtype=bool)
        self._no_jump = np.zeros(shape, dtype=bool)
        self.pending = np.zeros((n, 2, 3))
        self.pending_ticks = np.zeros(shape, dtype=np.int64)
        self.pending_any = False
        self.width = np.full(shape, C.PLAYER_WIDTH)
        self._height = np.full(shape, C.PLAYER_HEIGHT)
        self._eye = np.full(shape, C.EYE_HEIGHT)

    def reset(self, idx: np.ndarray) -> None:
        """Clear the state of the selected arenas."""
        self.sneak[idx] = False
        self.sneak_slow[idx] = False
        self.fall[idx] = 0.0
        self.jump_cooldown[idx] = 0
        self.wall_block[idx] = False
        self.moved_y[idx] = 0.0
        self.last_move[idx] = 0.0
        self.eye_was_wet[idx] = False
        self.swimming[idx] = False
        self.pending_ticks[idx] = 0

    def heights(self) -> np.ndarray:
        """Return box heights of shape (n, 2)."""
        if self.sneak.any():
            return np.where(self.sneak, SNEAK_HEIGHT, C.PLAYER_HEIGHT)
        return self._height

    def eyes(self) -> np.ndarray:
        """Return eye heights of shape (n, 2)."""
        if self.sneak.any():
            return np.where(self.sneak, SNEAK_EYE, C.EYE_HEIGHT)
        return self._eye


class Sense:
    """What the world reports around each body at the start of a tick."""

    __slots__ = ("water", "lava", "fluid", "eye_water", "depth", "flow", "count", "web", "any_fluid", "any_web")

    def __init__(self, sim) -> None:
        body = sim.body
        world = sim.world
        heights = body.heights()
        self.web = world.contact_many(sim.pos, body.width, heights)["cobweb"]
        self.any_web = bool(self.web.any())
        if not world.config.fluids:
            self.water = self.lava = self.fluid = self.eye_water = body._no_jump
            self.depth = self.flow = self.count = None
            self.any_fluid = False
            return
        if body.cfg.vanilla:
            info = world.fluid_box_many(sim.pos, body.width, heights, body.eyes())
        else:
            lifted = sim.pos.copy()
            lifted[..., 1] += MINEFLAYER_FLUID_INSET
            info = world.fluid_box_many(
                lifted, body.width, heights - 2.0 * MINEFLAYER_FLUID_INSET, body.eyes() - MINEFLAYER_FLUID_INSET
            )
        self.water = info["in_water"]
        self.lava = info["in_lava"] & ~info["in_water"]
        self.fluid = self.water | self.lava
        self.eye_water = info["eye_in_water"]
        self.depth = np.where(self.water, info["depth"][..., 0], info["depth"][..., 1])
        self.any_fluid = bool(self.fluid.any())
        self.flow = info["flow"]
        self.count = info["count"]

    def push(self, vel: np.ndarray, vanilla: bool) -> None:
        """Add the push of water and lava currents to the velocity."""
        if self.any_fluid:
            _flow_push(vel, self.flow[..., :3], self.count[..., 0], WATER_FLOW_PUSH, vanilla)
            _flow_push(vel, self.flow[..., 3:], self.count[..., 1], LAVA_FLOW_PUSH, vanilla)


def _flow_push(vel: np.ndarray, flow: np.ndarray, count: np.ndarray, scale: float, vanilla: bool) -> None:
    """Add the current's push to the velocity of each wet body."""
    live = (count > 0) & (np.abs(flow).sum(axis=-1) > 0.0)
    if not live.any():
        return
    total = flow[live]
    if not vanilla:
        vel[live] += total / np.linalg.norm(total, axis=-1, keepdims=True) * scale
        return
    push = total / count[live][:, None] * scale
    size = np.linalg.norm(push, axis=-1)
    current = vel[live]
    slow = (np.abs(current[:, 0]) < TINY_VELOCITY) & (np.abs(current[:, 2]) < TINY_VELOCITY)
    weak = slow & (size < MIN_FLOW_PUSH) & (size > 0.0)
    if weak.any():
        push[weak] = push[weak] / size[weak][:, None] * MIN_FLOW_PUSH
    vel[live] = current + push


def melee_direction(pos: np.ndarray) -> np.ndarray:
    """Return unit vectors of shape (n, 2, 2) from each attacker toward its victim."""
    dx = pos[:, ::-1, 0] - pos[..., 0]
    dz = pos[:, ::-1, 2] - pos[..., 2]
    size_sq = dx * dx + dz * dz
    valid = size_sq >= KNOCKBACK_MIN_DIRECTION_SQ
    size = np.sqrt(np.where(valid, size_sq, 1.0))
    return np.stack([np.where(valid, dx / size, 0.0), np.where(valid, dz / size, 0.0)], axis=-1)


def _impulse(
    hx: np.ndarray,
    vy: np.ndarray,
    hz: np.ndarray,
    grounded: np.ndarray,
    strength: np.ndarray,
    px: np.ndarray,
    pz: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Apply one knockback call along a unit push direction."""
    on = strength > 0.0
    new_x = np.where(on, hx * 0.5 + px * strength, hx)
    new_z = np.where(on, hz * 0.5 + pz * strength, hz)
    lifted = np.minimum(C.KNOCKBACK_VERTICAL_CAP, vy * 0.5 + strength)
    new_y = np.where(on & grounded, lifted, vy)
    return new_x, new_y, new_z


def _server_base(sim, idx: np.ndarray, victim: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return the velocity and ground flag that knockback starts from."""
    if not sim.body.cfg.tracks_server:
        vel = sim.vel[idx, victim]
        return vel[:, 0], vel[:, 1], vel[:, 2], sim.on_ground[idx, victim]
    vel = sim.combat.server_vel[idx, victim]
    return vel[:, 0], vel[:, 1], vel[:, 2], sim.combat.server_ground[idx, victim]


def _store_server_copy(
    sim, idx: np.ndarray, victim: int, hx: np.ndarray, vy: np.ndarray, hz: np.ndarray, air: np.ndarray
) -> None:
    combat = sim.combat
    combat.server_vel[idx, victim, 0] = hx
    combat.server_vel[idx, victim, 1] = vy
    combat.server_vel[idx, victim, 2] = hz
    combat.server_ground[idx, victim] = ~air
    combat.wake_server_copy()


def blocked_knockback(sim, blocked: np.ndarray, victim: int, direction: np.ndarray) -> None:
    """Update the server velocity of a victim whose shield stopped a melee hit.

    The shield pulls the victim toward the attacker. When the hurt window is closed
    the hit then pushes it away. The server sends neither to the client, so only its
    own copy changes.
    """
    if not sim.body.cfg.tracks_server:
        return
    idx = np.flatnonzero(blocked)
    if len(idx) == 0:
        return
    keep = 1.0 - sim.combat.knockback_resistance[idx, victim]
    px = direction[idx, 0]
    pz = direction[idx, 1]
    hx, vy, hz, grounded = _server_base(sim, idx, victim)
    hx, vy, hz = _impulse(hx, vy, hz, grounded, C.SHIELD_KNOCKBACK * keep, -px, -pz)
    closed = sim.hurt_timer[idx, victim] == 0
    push = np.where(closed, C.BASE_KNOCKBACK * keep, 0.0)
    hx, vy, hz = _impulse(hx, vy, hz, grounded, push, px, pz)
    _store_server_copy(sim, idx, victim, hx, vy, hz, ~grounded)


def take_knockback(
    sim,
    fresh: np.ndarray,
    victim: int,
    direction: np.ndarray,
    strength: np.ndarray,
    sprint: np.ndarray | None = None,
    level: np.ndarray | None = None,
    punch: np.ndarray | None = None,
) -> None:
    """Knock back the selected victims.

    A melee hit passes `sprint` and its result goes straight to the client, leaving
    the server copy unchanged. A projectile hit passes None, can add Punch, takes one
    server travel step and replaces the server copy.
    """
    body = sim.body
    idx = np.flatnonzero(fresh)
    keep = 1.0 - sim.combat.knockback_resistance[idx, victim]
    hx, vy, hz, grounded = _server_base(sim, idx, victim)
    hx, vy, hz = _impulse(hx, vy, hz, grounded, strength[idx] * keep, direction[idx, 0], direction[idx, 1])

    if sprint is not None:
        attacker = 1 - victim
        levels = body.knockback_level[idx, attacker] + (0 if level is None else level[idx])
        bonus = (sprint[idx] * C.SPRINT_KNOCKBACK_BONUS + levels * C.KNOCKBACK_ENCHANT_STRENGTH) * keep
        if (bonus > 0.0).any():
            yaw = np.radians(sim.yaw[idx, attacker])
            hx, vy, hz = _impulse(hx, vy, hz, grounded, bonus, -np.sin(yaw), np.cos(yaw))
    else:
        if punch is not None and punch[idx].any():
            size = punch[idx] * C.PUNCH_PER_LEVEL * keep
            hx = hx + direction[idx, 0] * size
            hz = hz + direction[idx, 1] * size
            vy = vy + np.where(size > 0.0, C.PUNCH_LIFT, 0.0)
        drag = np.where(grounded, C.GROUND_DRAG, C.AIR_DRAG)
        hx = hx * drag
        hz = hz * drag
        vy = (vy - C.GRAVITY) * C.VERTICAL_DRAG
        if body.cfg.tracks_server:
            _store_server_copy(sim, idx, victim, hx, vy, hz, np.ones(len(idx), dtype=bool))

    delay = body.cfg.delay
    if delay > 0:
        body.pending[idx, victim, 0] = hx
        body.pending[idx, victim, 1] = vy
        body.pending[idx, victim, 2] = hz
        body.pending_ticks[idx, victim] = delay + 1
        body.pending_any = True
    else:
        sim.vel[idx, victim, 0] = hx
        sim.vel[idx, victim, 1] = vy
        sim.vel[idx, victim, 2] = hz


def _deliver_pending(body: Bodies, vel: np.ndarray) -> None:
    waiting = body.pending_ticks > 0
    body.pending_ticks[waiting] -= 1
    due = waiting & (body.pending_ticks == 0)
    if due.any():
        vel[due] = body.pending[due]
    body.pending_any = bool((body.pending_ticks > 0).any())


def _cut_tiny(vel: np.ndarray, vanilla: bool) -> None:
    vx = vel[..., 0]
    vy = vel[..., 1]
    vz = vel[..., 2]
    if vanilla:
        moving = vx * vx + vz * vz >= TINY_HORIZONTAL_SQ
        if not moving.all():
            vx *= moving
            vz *= moving
    else:
        vx *= np.abs(vx) >= TINY_VELOCITY
        vz *= np.abs(vz) >= TINY_VELOCITY
    falling = np.abs(vy) >= TINY_VELOCITY
    if not falling.all():
        vy *= falling


def _sprint_state(sim, a: np.ndarray, forward: np.ndarray, using: np.ndarray, sense: Sense | None) -> np.ndarray:
    """Update both sprint states and return which bodies run this tick."""
    body = sim.body
    key = (a[..., A.SPRINT] == 1) & (forward > 0.0) & ~body.wall_block & ~body.sneak
    key &= sim.sprint_held | ~using if body.cfg.vanilla else ~using
    if sim.cfg.hunger and body.cfg.vanilla:
        key &= sim.combat.food > SPRINT_MIN_FOOD
    if sense is not None and sense.any_fluid:
        under = (body.eye_was_wet if body.cfg.vanilla else sense.eye_water) & sense.water
        key &= ~(sense.water & ~under)
    start = key & ~sim.sprint_held
    sim.sprinting = (sim.sprinting | start) & key
    sim.sprint_held = key
    return key if body.cfg.sprint_restart else sim.sprinting


def _swim_pull(sim, jump: np.ndarray, sense: Sense, was_running: np.ndarray) -> None:
    """Update the swimming state and pull a swimmer's vertical speed toward its look."""
    body = sim.body
    stay = body.swimming & was_running & sense.water
    begin = ~body.swimming & was_running & body.eye_was_wet & sense.water
    body.swimming = stay | begin
    if not body.swimming.any():
        return
    look_y = -np.sin(np.radians(sim.pitch))
    rate = np.where(look_y < SWIM_PULL_DOWN_LOOK, SWIM_PULL_DOWN, SWIM_PULL)
    pull = body.swimming & ((look_y <= 0.0) | jump)
    rising = body.swimming & ~pull
    if rising.any():
        head = sim.pos.copy()
        head[..., 1] += SWIM_HEAD_PROBE
        tiny = np.full_like(body.width, 1e-3)
        wet = sim.world.fluid_box_many(head, tiny, tiny, tiny)
        pull |= rising & (wet["in_water"] | wet["in_lava"])
    sim.vel[..., 1] += np.where(pull, (look_y - sim.vel[..., 1]) * rate, 0.0)


def _jump(
    sim,
    held: np.ndarray,
    grounded: np.ndarray,
    run: np.ndarray,
    sin_y: np.ndarray,
    cos_y: np.ndarray,
    sense: Sense | None,
) -> None:
    body = sim.body
    vel = sim.vel
    if not body.cooldown_live and not held.any():
        body.jumped = body._no_jump
        return
    cooldown = np.maximum(body.jump_cooldown - 1, 0)
    takeoff = held & grounded & (cooldown == 0)
    if sense is not None and sense.any_fluid:
        swim = held & sense.fluid & ~(grounded & (sense.depth <= FLUID_JUMP_DEPTH))
        vel[swim, 1] += FLUID_JUMP
        takeoff &= ~swim
    if takeoff.any():
        vel[..., 1] = np.where(takeoff, np.maximum(C.JUMP_VELOCITY, vel[..., 1]), vel[..., 1])
        boost = takeoff & run
        if boost.any():
            vel[..., 0] -= boost * sin_y * C.SPRINT_JUMP_BOOST
            vel[..., 2] += boost * cos_y * C.SPRINT_JUMP_BOOST
    body.jumped = takeoff
    body.jump_cooldown = np.where(takeoff, JUMP_COOLDOWN, np.where(held, cooldown, 0))
    body.cooldown_live = bool(body.jump_cooldown.any())


def _wall_stop(
    sim,
    blocked: np.ndarray,
    moved_x: np.ndarray,
    moved_z: np.ndarray,
    input_x: np.ndarray,
    input_z: np.ndarray,
) -> None:
    """End the sprint of bodies that hit a wall more than 8 degrees off their input.

    A swimmer keeps sprinting against a wall.
    """
    stop = blocked.copy()
    wx = input_x[blocked]
    wz = input_z[blocked]
    mx = moved_x[blocked]
    mz = moved_z[blocked]
    wish = wx * wx + wz * wz
    moved = mx * mx + mz * mz
    aligned = wx * mx + wz * mz > MINOR_WALL_COSINE * np.sqrt(wish * moved)
    stop[blocked] = ~((wish >= 1e-5) & (moved >= 1e-5) & aligned)
    stop &= ~sim.body.swimming
    sim.body.wall_block = stop
    sim.sprinting &= ~stop


def _move_flat(sim, input_x: np.ndarray, input_z: np.ndarray) -> np.ndarray:
    """Move over the flat arena plane and return the vertical move."""
    pos = sim.pos
    vel = sim.vel
    body = sim.body
    old_y = pos[..., 1].copy()
    pos += vel
    landed = (pos[..., 1] <= 0.0) & (vel[..., 1] <= 0.0)
    pos[..., 1] = np.maximum(pos[..., 1], 0.0)
    vel[..., 1] = np.where(landed, 0.0, vel[..., 1])
    sim.on_ground = landed

    ceiling = body.cfg.ceiling
    if ceiling is not None:
        top = ceiling - body.heights()
        bumped = pos[..., 1] > top
        if bumped.any():
            pos[..., 1] = np.where(bumped, top, pos[..., 1])
            vel[..., 1] = np.where(bumped & (vel[..., 1] > 0.0), 0.0, vel[..., 1])

    limit = sim.cfg.arena_half - C.PLAYER_WIDTH / 2.0
    over_x = np.abs(pos[..., 0]) > limit
    over_z = np.abs(pos[..., 2]) > limit
    if over_x.any() or over_z.any():
        clipped_x = np.minimum(np.maximum(pos[..., 0], -limit), limit)
        clipped_z = np.minimum(np.maximum(pos[..., 2], -limit), limit)
        moved_x = vel[..., 0] - (pos[..., 0] - clipped_x)
        moved_z = vel[..., 2] - (pos[..., 2] - clipped_z)
        pos[..., 0] = clipped_x
        pos[..., 2] = clipped_z
        vel[..., 0] = np.where(over_x, 0.0, vel[..., 0])
        vel[..., 2] = np.where(over_z, 0.0, vel[..., 2])
        _wall_stop(sim, over_x | over_z, moved_x, moved_z, input_x, input_z)
    elif body.wall_block.any():
        body.wall_block = np.zeros_like(body.wall_block)
    return pos[..., 1] - old_y


def _edge_guard(sim, delta: np.ndarray, grounded: np.ndarray, heights: np.ndarray) -> None:
    """Shorten the move of sneaking grounded bodies so they stay above a floor."""
    guard = sim.body.sneak & grounded & (delta[..., 1] <= 0.0)
    if not guard.any():
        return
    world = sim.world
    width = sim.body.width
    down = np.zeros_like(delta)
    down[..., 1] = -STEP_HEIGHT
    for axes in ((0,), (2,), (0, 2)):
        for _ in range(EDGE_MAX_STEPS):
            trial = np.zeros_like(delta)
            for axis in axes:
                trial[guard, axis] = delta[guard, axis]
            moving = guard & (np.abs(trial[..., 0]) + np.abs(trial[..., 2]) > 0.0)
            if not moving.any():
                break
            probe = sim.pos + trial
            landed, _, _ = world.collide_many(probe, down, width, heights)
            unsupported = moving & (landed[..., 1] - probe[..., 1] <= -STEP_HEIGHT + 1e-9)
            if not unsupported.any():
                break
            for axis in axes:
                value = delta[..., axis]
                shrunk = np.where(np.abs(value) < EDGE_STEP, 0.0, value - np.sign(value) * EDGE_STEP)
                delta[..., axis] = np.where(unsupported, shrunk, value)


def _hop(sim, wet: np.ndarray, moved_y: np.ndarray, heights: np.ndarray) -> None:
    """Lift bodies at a wall out of a fluid when the space above them is free."""
    world = sim.world
    width = sim.body.width
    offset = np.where(wet[..., None], sim.vel, 0.0)
    offset[..., 1] = np.where(wet, sim.vel[..., 1] + HOP_CLEARANCE - moved_y, 0.0)
    _, contact, _ = world.collide_many(sim.pos, offset, width, heights)
    clear = wet & (contact == 0)
    if not clear.any():
        return
    info = world.fluid_box_many(sim.pos + offset, width, heights, sim.body.eyes())
    clear &= ~(info["in_water"] | info["in_lava"])
    sim.vel[clear, 1] = HOP_VELOCITY


def _move_world(
    sim,
    grounded: np.ndarray,
    input_x: np.ndarray,
    input_z: np.ndarray,
    sense: Sense,
) -> tuple[np.ndarray, np.ndarray]:
    """Move through the world's blocks. Return the vertical move and wall contact."""
    pos = sim.pos
    vel = sim.vel
    body = sim.body
    heights = body.heights()
    delta = vel.copy()
    if sense.any_web:
        delta[sense.web] *= WEB_SCALE
        vel[sense.web] = 0.0
    if body.sneak.any():
        _edge_guard(sim, delta, grounded, heights)
    out, contact, ground = sim.world.collide_many(pos, delta, body.width, heights, grounded, STEP_HEIGHT)
    moved = out - pos
    pos[...] = out
    sim.on_ground = ground
    hit_x = (contact & 1) > 0
    hit_y = (contact & 2) > 0
    hit_z = (contact & 4) > 0
    vel[hit_x, 0] = 0.0
    vel[hit_y, 1] = 0.0
    vel[hit_z, 2] = 0.0
    blocked = hit_x | hit_z
    if blocked.any():
        _wall_stop(sim, blocked, moved[..., 0], moved[..., 2], input_x, input_z)
    elif body.wall_block.any():
        body.wall_block = np.zeros_like(body.wall_block)
    return moved[..., 1], blocked


def _settle(
    sim,
    grounded: np.ndarray,
    run: np.ndarray,
    sense: Sense | None,
    moved_y: np.ndarray,
    blocked: np.ndarray | None,
) -> None:
    """Apply gravity and drag after the move."""
    vel = sim.vel
    drag = np.where(grounded, C.GROUND_DRAG, C.AIR_DRAG)
    if sense is None or not sense.any_fluid:
        vel[..., 1] = (vel[..., 1] - C.GRAVITY) * C.VERTICAL_DRAG
        vel[..., 0] *= drag
        vel[..., 2] *= drag
        return
    vanilla = sim.body.cfg.vanilla
    swimming = run & sense.water & vanilla
    water_h = np.where(swimming, WATER_SPRINT_DRAG, WATER_DRAG)
    shallow = sense.depth <= FLUID_JUMP_DEPTH
    lava_y = np.where(shallow, LAVA_SHALLOW_VERTICAL_DRAG, LAVA_DRAG)
    lava_sink = LAVA_SINK + np.where(shallow, WATER_SINK, 0.0)
    water_y = vel[..., 1] * WATER_DRAG - np.where(swimming, 0.0, WATER_SINK)
    lava_vy = vel[..., 1] * lava_y - lava_sink
    air_y = (vel[..., 1] - C.GRAVITY) * C.VERTICAL_DRAG
    vel[..., 1] = np.where(sense.water, water_y, np.where(sense.lava, lava_vy, air_y))
    horizontal = np.where(sense.water, water_h, np.where(sense.lava, LAVA_DRAG, drag))
    vel[..., 0] *= horizontal
    vel[..., 2] *= horizontal
    if blocked is not None:
        wet = sense.fluid & blocked
        if wet.any():
            _hop(sim, wet, moved_y, sim.body.heights())


def _push_apart(sim) -> None:
    """Push overlapping bodies apart by the larger of their axis offsets."""
    delta = sim.pos[:, 1] - sim.pos[:, 0]
    abs_x = np.abs(delta[:, 0])
    abs_z = np.abs(delta[:, 2])
    near = (abs_x < C.PLAYER_WIDTH) & (abs_z < C.PLAYER_WIDTH)
    if not near.any():
        return
    heights = sim.body.heights()
    above = delta[:, 1] >= 0.0
    reach = np.where(above, heights[:, 0], heights[:, 1])
    largest = np.maximum(abs_x, abs_z)
    close = near & (np.abs(delta[:, 1]) < reach) & (largest >= PUSH_MIN_AXIS)
    if not close.any():
        return
    root = np.sqrt(largest[close])
    scale = np.minimum(1.0, 1.0 / root) / root * PUSH_STRENGTH
    push_x = delta[close, 0] * scale
    push_z = delta[close, 2] * scale
    sim.vel[close, 0, 0] -= push_x
    sim.vel[close, 0, 2] -= push_z
    sim.vel[close, 1, 0] += push_x
    sim.vel[close, 1, 2] += push_z


def move_bodies(sim, a: np.ndarray, using: np.ndarray) -> None:
    """Advance every body by one tick."""
    body = sim.body
    if body.pending_any:
        _deliver_pending(body, sim.vel)
    sense = None
    if sim.world is not None:
        sense = Sense(sim)
        sense.push(sim.vel, body.cfg.vanilla)
    _cut_tiny(sim.vel, body.cfg.vanilla)
    grounded = sim.on_ground.copy()

    forward_index = a[..., A.FORWARD]
    strafe_index = a[..., A.STRAFE]
    forward = A.FORWARD_VALUES[forward_index]
    was_running = sim.sprint_held.copy()
    run = _sprint_state(sim, a, forward, using, sense)

    if body.speed_level.any():
        walk = C.MOVEMENT_SPEED * (1.0 + SPEED_PER_LEVEL * body.speed_level)
        accel = np.where(
            grounded,
            walk * np.where(run, C.SPRINT_MULTIPLIER, 1.0),
            np.where(run, C.AIR_ACCEL_SPRINT, C.AIR_ACCEL),
        )
    else:
        accel = GROUND_ACCEL[grounded.astype(np.intp), run.astype(np.intp)]
    if sense is not None and sense.any_fluid:
        accel = np.where(sense.fluid, FLUID_ACCEL, accel)

    slow = body.sneak_slow if body.cfg.vanilla else body.sneak
    mode = using.astype(np.intp) + 2 * slow.astype(np.intp)
    body.sneak_slow = body.sneak.copy()
    move_f = MOVE_FORWARD[forward_index, strafe_index, mode]
    move_s = MOVE_STRAFE[forward_index, strafe_index, mode]

    yaw = np.radians(sim.yaw)
    sin_y = np.sin(yaw)
    cos_y = np.cos(yaw)
    input_x = -sin_y * move_f - cos_y * move_s
    input_z = cos_y * move_f - sin_y * move_s
    sim.vel[..., 0] += input_x * accel
    sim.vel[..., 2] += input_z * accel
    _jump(sim, a[..., A.JUMP] == 1, grounded, run, sin_y, cos_y, sense)
    if sense is not None and sense.any_fluid and body.cfg.vanilla:
        _swim_pull(sim, a[..., A.JUMP] == 1, sense, was_running)
        body.eye_was_wet = sense.eye_water.copy()
    elif body.eye_was_wet.any() or body.swimming.any():
        body.eye_was_wet = np.zeros_like(body.eye_was_wet)
        body.swimming = np.zeros_like(body.swimming)

    np.copyto(body._before, sim.pos)
    if sense is None:
        moved_y = _move_flat(sim, input_x, input_z)
        blocked = None
    else:
        moved_y, blocked = _move_world(sim, grounded, input_x, input_z, sense)
    np.subtract(sim.pos, body._before, out=body.last_move)
    _settle(sim, grounded, run, sense, moved_y, blocked)
    body.moved_y = moved_y
    _push_apart(sim)
