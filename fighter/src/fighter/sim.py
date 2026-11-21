"""Vectorized simulator of 1 versus 1 Minecraft Java combat.

Every array has a batch axis first. Player arrays have shape (n, 2, ...), one
row per arena and one column per seat. SIM_NOTES.md explains each mechanic.

The `arena` profile is a flat fight with no world object. The `surface` and
`full` profiles run the same physics through a block world.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np

from . import actions as A
from . import arrows
from . import combat as CB
from . import constants as C
from . import items as IT
from . import movement as M
from .arrows import MAX_ARROWS
from .perception import Perception

EVENT_NAMES = (
    "damage_dealt",
    "damage_taken",
    "swings",
    "weak_swings",
    "hits",
    "crits",
    "sprint_hits",
    "melee_blocked",
    "shield_breaks",
    "followup_damage",
    "arrows_fired",
    "arrow_hits",
    "arrows_blocked",
    "arrows_taken",
    "arrows_picked",
)
DECISION_RATES = (10, 15, 20)
PROFILES = ("arena", "surface", "full")
SPAWN_TRIES = 8
SPAWN_SCAN_STEP = 48
SPAWN_CORNER_INSET = 1e-4


@dataclass
class SimConfig:
    """Arena, loadout, body and world settings.

    profile: "arena", "surface" or "full".
    client_model: the client that moves the bodies, shared with the world.
    decisions_per_second: 10, 15 or 20 policy decisions in each 20 game ticks.
    world_size: side length of the world in blocks, or None for the profile's size.
    """

    armor: str = "iron"
    arena_half: float = C.ARENA_HALF_WIDTH
    spawn_min: float = 4.0
    spawn_max: float = 10.0
    face_noise_deg: float = 60.0
    move: M.MoveConfig = field(default_factory=M.MoveConfig)
    start_arrows: int = arrows.START_ARROWS
    kits: tuple[str | IT.Kit, ...] | None = None
    uneven_rate: float = 1.0 / 3.0
    hunger: bool = False
    natural_regen: bool = False
    client_model: str | None = None
    knockback_delay: int | None = None
    aim_delay: int = 0
    keep_shield_cooldown: bool = False
    decisions_per_second: int = 10
    profile: str = "arena"
    world_size: int | None = None
    world_seed: int = 0
    world_cache: str | None = None

    def __post_init__(self) -> None:
        if self.profile not in PROFILES:
            raise ValueError(f"unknown world profile {self.profile!r}, expected one of {PROFILES}")
        if self.decisions_per_second not in DECISION_RATES:
            raise ValueError(f"decisions_per_second must be one of {DECISION_RATES}")
        changes: dict[str, object] = {}
        if self.client_model is None:
            self.client_model = self.move.client_model
        elif self.client_model != self.move.client_model:
            changes["client_model"] = self.client_model
        if self.knockback_delay is not None:
            changes["knockback_delay"] = self.knockback_delay
        if changes:
            self.move = replace(self.move, **changes)

    @classmethod
    def uhc(cls) -> "SimConfig":
        """Return the long range UHC round setup."""
        return cls(kits=("uhc",), arena_half=15.5, spawn_min=24.0, spawn_max=28.0, hunger=True)


def look_vectors(yaw: np.ndarray, pitch: np.ndarray) -> np.ndarray:
    """Return unit view vectors. Yaw 0 faces +Z and positive pitch looks down."""
    y = np.radians(yaw)
    p = np.radians(pitch)
    cp = np.cos(p)
    return np.stack([-np.sin(y) * cp, -np.sin(p), np.cos(y) * cp], axis=-1)


def ray_box(
    origin: np.ndarray,
    direction: np.ndarray,
    box_min: np.ndarray,
    box_max: np.ndarray,
    max_t: float | np.ndarray,
) -> np.ndarray:
    """Return which rays reach the box within max_t units of the direction."""
    d = np.where(np.abs(direction) < 1e-9, 1e-9, direction)
    t1 = (box_min - origin) / d
    t2 = (box_max - origin) / d
    near = np.minimum(t1, t2).max(axis=-1)
    far = np.maximum(t1, t2).min(axis=-1)
    entry = np.maximum(near, 0.0)
    return (far >= entry) & (entry <= max_t)


def armor_reduce(damage: np.ndarray, armor: float, toughness: float) -> np.ndarray:
    """Apply the Java armor damage formula."""
    effective = np.minimum(
        20.0,
        np.maximum(armor / 5.0, armor - 4.0 * damage / (min(toughness, 20.0) + 8.0)),
    )
    return damage * (1.0 - effective / 25.0)


def cooldown_multiplier(ticks: np.ndarray, attack_speed: np.ndarray) -> np.ndarray:
    """Return the melee damage multiplier after ticks since the last swing."""
    period = C.TICKS_PER_SECOND / attack_speed
    return np.clip(0.2 + ((ticks + 0.5) / period) ** 2 * 0.8, 0.2, 1.0)


def bow_speed(draw_ticks: np.ndarray) -> np.ndarray:
    """Return arrow launch speed in blocks per tick for a draw length."""
    f = np.minimum(draw_ticks / C.BOW_FULL_DRAW_TICKS, 1.0)
    return C.BOW_MAX_SPEED * np.minimum((f * f + 2.0 * f) / 3.0, 1.0)


class Sim:
    """A batch of independent arenas with two players each."""

    def __init__(
        self, n: int, config: SimConfig | None = None, seed: int = 0, profile: str | None = None
    ):
        self.n = n
        self.cfg = config or SimConfig()
        if profile is not None:
            self.cfg = replace(self.cfg, profile=profile)
        self.world = None
        self.view = None
        self.origin = np.zeros(3)
        self.rng = np.random.default_rng(seed)
        self.armor, self.toughness = C.ARMOR_SETS[self.cfg.armor]
        self.body = M.Bodies(n, self.cfg.move)
        self.pos = np.zeros((n, 2, 3))
        self.vel = np.zeros((n, 2, 3))
        self.yaw = np.zeros((n, 2))
        self.pitch = np.zeros((n, 2))
        self.on_ground = np.ones((n, 2), dtype=bool)
        self.sprinting = np.zeros((n, 2), dtype=bool)
        self.sprint_held = np.zeros((n, 2), dtype=bool)
        self.hp = np.full((n, 2), C.MAX_HEALTH)
        self.weapon = np.zeros((n, 2), dtype=np.int64)
        self.attack_ticks = np.full((n, 2), 1000.0)
        self.hurt_timer = np.zeros((n, 2), dtype=np.int64)
        self.last_damage = np.zeros((n, 2))
        self.shield_ticks = np.zeros((n, 2), dtype=np.int64)
        self.shield_disabled = np.zeros((n, 2), dtype=np.int64)
        self.draw_ticks = np.zeros((n, 2), dtype=np.int64)
        self.load_ticks = np.zeros((n, 2), dtype=np.int64)
        self.loaded = np.zeros((n, 2), dtype=bool)
        self.load_wait = np.zeros((n, 2), dtype=bool)
        self.use_prev = np.zeros((n, 2), dtype=bool)
        self.followup = np.zeros((n, 2), dtype=np.int64)
        arrows.init_state(self)
        self.ticks = np.zeros(n, dtype=np.int64)
        self.events = {name: np.zeros((n, 2)) for name in EVENT_NAMES}
        self.combat = CB.Combat(self)
        self.items = IT.Items(self)
        self.perception = Perception(self)
        self.border_half = float(self.cfg.arena_half)
        if self.cfg.kits is None:
            self.melee_only = self.cfg.start_arrows == 0
        else:
            self.melee_only = all(kit.arrows == 0 for kit in self.combat.kits)
        self._sneak_key = np.zeros((n, 2), dtype=bool)
        self._locked_pitch = np.zeros((n, 2), dtype=bool)
        self._rotation_ticks = C.TICKS_PER_DECISION
        self._decision_phase = 0
        if self.cfg.profile != "arena":
            self._load_world(seed)
        self.reset()

    def _load_world(self, seed: int) -> None:
        from .world import config as world_config
        from .world import pool
        from .world.kernel import Arenas

        cfg = self.cfg
        settings = world_config.profile(cfg.profile)
        size = cfg.world_size or world_config.WORLD_SIZES[cfg.profile]
        base = pool.load(cfg.world_seed, size, cfg.world_cache, settings)
        self.attach_world(Arenas(base, self.n, seed=seed, client_model=cfg.client_model, config=settings))

    def attach_world(self, world) -> None:
        """Use a world object and center the fight on it."""
        from .world.kernel import CLIENT_MODELS

        if world.model != CLIENT_MODELS[self.cfg.client_model]:
            raise ValueError("the world and the bodies must use the same client model")
        self.world = world
        self.view = None
        self.origin = np.array([world.base.nx / 2.0, 0.0, world.base.nz / 2.0])
        self.border_half = min(world.base.nx, world.base.nz) / 2.0

    def close(self) -> None:
        """Release the world, if there is one."""
        if self.world is not None:
            self.world.close()
            self.world = None
            self.view = None

    def world_view(self):
        """Return the seen block memory of the current world."""
        from .world.view import WorldView

        if self.view is None or self.view._arenas is not self.world:
            self.view = WorldView(self.world)
        return self.view

    def update_sight(self) -> None:
        """Refresh every body's seen block memory from its eye."""
        self.world_view().update_all(self.eyes(), self.yaw, self.pitch)
        self.perception.refresh()

    @property
    def sneaking(self) -> np.ndarray:
        """Return the sneak input of each player, a simulator input that defaults to off."""
        return self.body.sneak

    @sneaking.setter
    def sneaking(self, value: np.ndarray) -> None:
        self.body.sneak[...] = value

    def reset(self, mask: np.ndarray | None = None) -> None:
        """Respawn the selected arenas, or all arenas when mask is None."""
        if mask is None:
            mask = np.ones(self.n, dtype=bool)
        idx = np.flatnonzero(mask)
        k = len(idx)
        if k == 0:
            return
        cfg = self.cfg
        if self.world is not None:
            self.world.reset(mask)
        margin = cfg.spawn_max / 2.0 + 0.5
        room = max(cfg.arena_half - margin, 0.0)
        center = self.rng.uniform(-room, room, size=(k, 2))
        distance = self.rng.uniform(cfg.spawn_min, cfg.spawn_max, size=k)
        angle = self.rng.uniform(0.0, 2.0 * np.pi, size=k)
        offset = np.stack([np.cos(angle), np.sin(angle)], axis=-1) * (distance / 2.0)[:, None]
        for seat, sign in ((0, -1.0), (1, 1.0)):
            xz = center + sign * offset
            self.pos[idx, seat, 0] = xz[:, 0] + self.origin[0]
            self.pos[idx, seat, 1] = 0.0
            self.pos[idx, seat, 2] = xz[:, 1] + self.origin[2]
        if self.world is not None:
            self._spawn_on_ground(idx, room, distance)
        delta = self.pos[idx, 1] - self.pos[idx, 0]
        facing = np.degrees(np.arctan2(-delta[:, 0], delta[:, 2]))
        noise = self.rng.uniform(-cfg.face_noise_deg, cfg.face_noise_deg, size=(k, 2))
        self.yaw[idx, 0] = facing + noise[:, 0]
        self.yaw[idx, 1] = facing + 180.0 + noise[:, 1]
        self.pitch[idx] = 0.0
        self.vel[idx] = 0.0
        self.on_ground[idx] = True
        self.sprinting[idx] = False
        self.sprint_held[idx] = False
        self.hp[idx] = C.MAX_HEALTH
        self.weapon[idx] = C.SWORD
        self.attack_ticks[idx] = 1000.0
        self.hurt_timer[idx] = 0
        self.last_damage[idx] = 0.0
        self.shield_ticks[idx] = 0
        if not cfg.keep_shield_cooldown:
            self.shield_disabled[idx] = 0
        self.draw_ticks[idx] = 0
        self.load_ticks[idx] = 0
        self.loaded[idx] = False
        self.load_wait[idx] = False
        self.use_prev[idx] = False
        self.followup[idx] = 0
        arrows.reset_state(self, idx)
        self.ticks[idx] = 0
        self.body.reset(idx)
        self.combat.reset(idx)
        self.items.reset(idx, self.combat.kit_id, self.combat.kits)
        if cfg.kits is not None:
            self.ammo[idx] = self.combat.kit_arrows(idx)
        if self.world is not None:
            view = self.world_view()
            eyes = self.eyes()
            for env in idx.tolist():
                for seat in (0, 1):
                    view.update(env, seat, eyes[env, seat], self.yaw[env, seat], self.pitch[env, seat])
        self._sneak_key[idx] = False
        self._locked_pitch[idx] = False
        self.perception.reset(idx)
        self.perception.refresh(idx)

    def _ground_under(self, pending: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Scan down the four corner columns of each body in the selected arenas.

        Return which bodies found ground, the height of their highest corner, and
        which of them stand on a tree.
        """
        from .world import blocks as B

        world = self.world
        half = C.PLAYER_WIDTH / 2.0 - SPAWN_CORNER_INSET
        corners = np.array([[-half, -half], [-half, half], [half, -half], [half, half]])
        start = np.zeros((self.n, 8, 3))
        start[pending, :, 0] = np.repeat(self.pos[pending, :, 0], 4, axis=1) + np.tile(corners[:, 0], 2)
        start[pending, :, 2] = np.repeat(self.pos[pending, :, 2], 4, axis=1) + np.tile(corners[:, 1], 2)
        start[pending, :, 1] = min(float(world.base.y_high), float(B.Y_MAX)) + 0.5
        down = np.zeros((self.n, 8, 3))
        down[pending, :, 1] = -1.0
        found = np.zeros((self.n, 8), dtype=bool)
        heights = np.full((self.n, 8), -np.inf)
        cells = np.zeros((self.n, 8, 3), dtype=np.int64)
        wanted = np.zeros(self.n, dtype=bool)
        wanted[pending] = True
        for _ in range(B.WORLD_HEIGHT // SPAWN_SCAN_STEP + 1):
            hit, cell, _, dist = world.ray_block_many(start, down, float(SPAWN_SCAN_STEP))
            fresh = hit & ~found & wanted[:, None]
            heights[fresh] = start[fresh][:, 1] - dist[fresh]
            cells[fresh] = cell[fresh]
            found |= fresh
            if found[pending].all():
                break
            start[~found & wanted[:, None], 1] -= SPAWN_SCAN_STEP
        trees = (B.BLOCK_ID["oak_log"], B.BLOCK_ID["oak_leaves"])
        on_tree = np.zeros((self.n, 2), dtype=bool)
        for env in pending.tolist():
            for k in np.flatnonzero(found[env]).tolist():
                if world.block(*cells[env, k].tolist(), env) in trees:
                    on_tree[env, k // 4] = True
        return found.reshape(self.n, 2, 4).all(axis=2), heights.reshape(self.n, 2, 4).max(axis=2), on_tree

    def _spawn_on_ground(self, idx: np.ndarray, room: float, distance: np.ndarray) -> None:
        """Stand both players of each selected arena on dry open ground."""
        world = self.world
        width = np.full((self.n, 2), C.PLAYER_WIDTH)
        height = np.full((self.n, 2), C.PLAYER_HEIGHT)
        eye = np.full((self.n, 2), C.EYE_HEIGHT)
        where = {int(env): i for i, env in enumerate(idx)}
        pending = idx
        for attempt in range(SPAWN_TRIES):
            found, ground, on_tree = self._ground_under(pending)
            self.pos[pending, :, 1] = np.where(found[pending], ground[pending], 0.0)
            wet = world.fluid_box_many(self.pos, width, height, eye)
            soaked = wet["in_water"] | wet["in_lava"]
            bad = ~found | soaked | on_tree
            retry = [env for env in pending.tolist() if bad[env].any()]
            if not retry or attempt == SPAWN_TRIES - 1:
                return
            pending = np.array(retry)
            center = self.rng.uniform(-room, room, size=(len(pending), 2))
            angle = self.rng.uniform(0.0, 2.0 * np.pi, size=len(pending))
            half = np.array([distance[where[env]] / 2.0 for env in retry])
            offset = np.stack([np.cos(angle), np.sin(angle)], axis=-1) * half[:, None]
            for seat, sign in ((0, -1.0), (1, 1.0)):
                xz = center + sign * offset
                self.pos[pending, seat, 0] = xz[:, 0] + self.origin[0]
                self.pos[pending, seat, 2] = xz[:, 1] + self.origin[2]

    @property
    def shield_active(self) -> np.ndarray:
        """Return which players have a fully raised shield."""
        return self.shield_ticks >= C.SHIELD_RAISE_TICKS

    def look(self) -> np.ndarray:
        """Return view vectors of shape (n, 2, 3)."""
        return look_vectors(self.yaw, self.pitch)

    def eyes(self) -> np.ndarray:
        """Return eye positions of shape (n, 2, 3)."""
        eyes = self.pos.copy()
        eyes[..., 1] += C.EYE_HEIGHT
        if self.body.sneak.any():
            eyes[..., 1] = self.pos[..., 1] + self.body.eyes()
        return eyes

    def boxes(self) -> tuple[np.ndarray, np.ndarray]:
        """Return player hitbox corners."""
        half = C.PLAYER_WIDTH / 2.0
        low = self.pos + np.array([-half, 0.0, -half])
        high = self.pos + np.array([half, C.PLAYER_HEIGHT, half])
        if self.body.sneak.any():
            high[..., 1] = self.pos[..., 1] + self.body.heights()
        return low, high

    def aim_hits(self, reach: float = C.ATTACK_REACH) -> np.ndarray:
        """Return which players' view rays meet the other hitbox within reach."""
        low, high = self.boxes()
        return ray_box(self.eyes(), self.look(), low[:, ::-1], high[:, ::-1], reach)

    def attack_multiplier(self) -> np.ndarray:
        """Return the current melee damage multiplier of each player."""
        return cooldown_multiplier(self.attack_ticks, self.combat.attack_speed())

    def _decision_ticks(self) -> int:
        """Return how many game ticks the next decision covers."""
        rate = self.cfg.decisions_per_second
        if rate == 10:
            return C.TICKS_PER_DECISION
        if rate == 20:
            return 1
        phase = self._decision_phase
        self._decision_phase = (phase + 1) % 3
        return (phase + 1) * 4 // 3 - phase * 4 // 3

    def step(self, actions: np.ndarray) -> dict[str, np.ndarray]:
        """Advance one decision and return summed events of shape (n, 2)."""
        for values in self.events.values():
            values.fill(0.0)
        count = self._decision_ticks()
        self._rotation_ticks = count
        for tick in range(count):
            self._tick(actions, first=tick == 0)
        if self.world is not None:
            self.update_sight()
        self.perception.after_step(actions, count)
        return self.events

    def _tick(self, a: np.ndarray, first: bool) -> None:
        if self.world is not None:
            self.world.tick(1)
        self._turn(a, first)
        self._press_sneak(a[..., A.SNEAK] == 1)
        self._switch_weapons(A.WEAPON_CHOICES[a[..., A.WEAPON]])
        using = self._use_items(a[..., A.USE] == 1) | self.items.tick()
        clicks = a[..., A.ATTACK]
        if first:
            self._melee(((clicks > 0) | self.combat.second_click) & ~using)
            self.combat.second_click[...] = clicks == A.ATTACK_DOUBLE
        elif self.combat.second_click.any():
            self._melee(self.combat.second_click & ~using)
            self.combat.second_click[...] = False
        self._move(a, using)
        self.combat.after_move(self.body.jumped)
        if self.world is not None:
            self.items.collect()
        self._step_arrows()
        self._advance_timers()

    def _turn(self, a: np.ndarray, first: bool) -> None:
        """Apply the look heads. Lock aim replaces the turn on a held bow or crossbow."""
        yaw_step = A.SIM_YAW_STEP[a[..., A.YAW]] / self._rotation_ticks
        pitch_step = A.SIM_PITCH_STEP[a[..., A.PITCH]] / self._rotation_ticks
        lock = a[..., A.LOCK_AIM] == 1
        if lock.any():
            lock = lock & (self.weapon >= C.BOW)
            if first:
                self._locked_pitch[...] = False
                for seat in (0, 1):
                    self._lock_aim(np.flatnonzero(lock[:, seat]), seat)
            yaw_step = np.where(lock, 0.0, yaw_step)
            pitch_step = np.where(lock & self._locked_pitch, 0.0, pitch_step)
        self.yaw += yaw_step
        self.yaw = (self.yaw + 180.0) % 360.0 - 180.0
        self.pitch = np.clip(self.pitch + pitch_step, -90.0, 90.0)

    def _lock_aim(self, rows: np.ndarray, seat: int) -> None:
        """Look where an arrow fired now would meet the target."""
        if len(rows) == 0:
            return
        speed = arrows.aim_speed(self, seat, rows)
        yaw, pitch, flight = arrows.intercept(self, seat, speed, rows=rows)
        reach = (C.ARROW_DRAG**flight > arrows.AIM_MIN_REACH) & (-np.radians(pitch) < arrows.AIM_MAX_LOFT)
        self.yaw[rows, seat] = yaw
        self.pitch[rows[reach], seat] = pitch[reach]
        self._locked_pitch[rows[reach], seat] = True

    def _press_sneak(self, key: np.ndarray) -> None:
        """Hold sneak while the head is pressed. Sneak set directly on the body is left alone."""
        if not key.any() and not self._sneak_key.any():
            return
        self.body.sneak[key] = True
        self.body.sneak[self._sneak_key & ~key] = False
        self._sneak_key = key.copy()

    def no_ranged(self) -> bool:
        """Return whether no bow, crossbow or arrow can matter in the current state."""
        return (
            self.melee_only
            and not self.ammo.any()
            and not self.loaded.any()
            and not self.arrow_on.any()
            and not self.stuck_on.any()
        )

    def _switch_weapons(self, wanted: np.ndarray) -> None:
        changed = (wanted >= 0) & (wanted != self.weapon)
        if not changed.any():
            return
        self.weapon[changed] = wanted[changed]
        self.attack_ticks[changed] = 0.0
        self.draw_ticks[changed] = 0
        self.load_ticks[changed] = 0
        self.shield_ticks[changed] = 0
        self.load_wait[changed] = False

    def _use_items(self, use: np.ndarray) -> np.ndarray:
        melee = self.weapon <= C.AXE
        can_block = melee & use & (self.shield_disabled == 0) & self.combat.has_shield
        self.shield_ticks = np.where(can_block, self.shield_ticks + 1, 0)
        if self.no_ranged():
            self.load_wait &= use
            self.use_prev = use.copy()
            return can_block

        holding_bow = (self.weapon == C.BOW) & self.combat.has_bow
        stocked = self.ammo > 0
        released = holding_bow & ~use & (self.draw_ticks >= C.BOW_MIN_DRAW_TICKS) & stocked
        if released.any():
            speed = bow_speed(self.draw_ticks.astype(float))
            crit = self.draw_ticks >= C.BOW_FULL_DRAW_TICKS
            arrows.fire(self, released, speed, crit)
            self.ammo[released] -= 1
            self.combat.wear_bow(released)
        drawing = holding_bow & use & (self.ammo > 0)
        self.draw_ticks = np.where(drawing, self.draw_ticks + 1, 0)

        holding_crossbow = self.weapon == C.CROSSBOW
        rising = use & ~self.use_prev
        shoot = holding_crossbow & rising & self.loaded
        if shoot.any():
            arrows.fire(self, shoot, np.full(shoot.shape, C.CROSSBOW_SPEED), np.ones(shoot.shape, bool))
            self.loaded[shoot] = False
            self.load_wait[shoot] = True
        self.load_wait &= use
        loading = holding_crossbow & use & ~self.loaded & ~self.load_wait & (self.ammo > 0)
        self.load_ticks = np.where(loading, self.load_ticks + 1, 0)
        done = self.load_ticks >= C.CROSSBOW_LOAD_TICKS
        if done.any():
            self.loaded[done] = True
            self.load_wait[done] = True
            self.load_ticks[done] = 0
            self.ammo[done] -= 1
        self.use_prev = use.copy()
        return can_block | drawing | loading

    def _melee(self, attack: np.ndarray) -> None:
        self.combat.melee(attack)

    def _hurt(
        self,
        mask: np.ndarray,
        victim: int,
        raw: np.ndarray,
        direction: np.ndarray,
        knockback: np.ndarray,
        punch: np.ndarray | None = None,
    ) -> np.ndarray:
        """Apply projectile damage with the hurt window and return health removed."""
        return self.combat.hurt(mask, victim, raw, direction, knockback, punch=punch)

    def _move(self, a: np.ndarray, using: np.ndarray) -> None:
        M.move_bodies(self, a, using)

    def _step_arrows(self) -> None:
        if not self.no_ranged():
            arrows.step_arrows(self)

    def _advance_timers(self) -> None:
        self.attack_ticks += 1.0
        self.hurt_timer = np.maximum(self.hurt_timer - 1, 0)
        self.shield_disabled = np.maximum(self.shield_disabled - 1, 0)
        self.followup = np.maximum(self.followup - 1, 0)
        self.ticks += 1
