"""Zombies, skeletons, creepers and endermen over the arrays of a `Sim`.

`Mobs` holds up to `max_mobs` mobs per arena in arrays of shape (n, m, ...).
`MobSim` runs them beside the player in seat 0. Seat 1 has no body of its own in
a mob fight. Between decisions it shows the nearest living mob, so the shared
observation reads that mob as the enemy. During a tick it waits out of play.

One mob tick, in order: targets, movement intent, motion, pushing, attacks, then
water and sunlight. A walking mob feeds its speed in twice, once as the
acceleration and once as the forward input, so it settles at speed squared over
(1 - 0.546). The recorded zombie runs 0.11652 blocks per tick, or 2.33 per second.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import arrows
from . import combat as CB
from . import constants as C
from . import items as I
from . import movement as M
from .sim import Sim
from .world import blocks as B

ZOMBIE, SKELETON, CREEPER, ENDERMAN = range(4)
KIND_NAMES = ("zombie", "skeleton", "creeper", "enderman")
NUM_MOB_KINDS = len(KIND_NAMES)
NO_MOB = -1

HEALTH = np.array([20.0, 20.0, 20.0, 40.0])
ARMOR = np.array([2.0, 0.0, 0.0, 0.0])
SPEED = np.array([0.23, 0.25, 0.25, 0.30])
WIDTH = np.array([0.6, 0.6, 0.6, 0.6])
HEIGHT = np.array([1.95, 1.99, 1.7, 2.9])
EYE = np.array([1.74, 1.74, 1.445, 2.55])
FOLLOW = np.array([35.0, 16.0, 16.0, 64.0])
MELEE = np.array([3.0, 2.0, 0.0, 7.0])
STEP = np.array([0.6, 0.6, 0.6, 1.0])

MOB_FRICTION_DRAG = C.GROUND_DRAG
MOVE_INPUT = 1.0
MELEE_INTERVAL = 20
MELEE_REACH = np.sqrt(2.04) - 0.6
MOB_KNOCKBACK = C.BASE_KNOCKBACK
SHIELD_RECOIL = C.SHIELD_KNOCKBACK
TARGET_CHANCE = 0.125
GOAL_CHECK_TICKS = 20
UNSEEN_LIMIT = 60
ANGER_UNSEEN_LIMIT = 800
STUCK_TICKS = 10
DETOUR_TICKS = 20
DETOUR_DEGREES = 60.0
DETOUR_MAX_ROUNDS = 6
DETOUR_CLEAR_TICKS = 40
DETOUR_LIMIT_TICKS = 120
STUCK_MOVE = 0.02
ENGAGED_RANGE = 2.0
HOP_CLEARANCE = 1.1

BOW_RANGE = 15.0
BOW_DRAW = 20
BOW_REST = {"easy": 40, "normal": 40, "hard": 20}
BOW_ERROR = {"easy": 10.0, "normal": 6.0, "hard": 2.0}
DIFFICULTY_ID = {"easy": 1, "normal": 2, "hard": 3}
ARROW_SPEED = 1.6
ARROW_LIFT = 0.2
ARROW_SPREAD_SCALE = 0.57425
BOW_APPROACH_STOP = 1.3
STRAFE_MODIFIER = 0.25
STRAFE_INPUT = 0.5
STRAFE_FLIP_TICKS = 20
STRAFE_FLIP_CHANCE = 0.3
LOST_SIGHT_TICKS = 60

STEER_ARRIVE = 0.35
SWELL_START = 3.0
SWELL_CANCEL = 7.0
FUSE_TICKS = 30
BLAST_POWER = 3.0
BLAST_RADIUS = 2.0 * BLAST_POWER
BLAST_DAMAGE_SCALE = 7.0
BLAST_PROTECTION_KNOCKBACK = 0.15

STARE_TICKS = 5
STARE_TOLERANCE = 0.025
FREEZE_RANGE = 16.0
TELEPORT_AWAY_RANGE = 4.0
TELEPORT_TRIES = 64
TELEPORT_SPREAD = 64.0
TELEPORT_DROP = 32
TOWARD_DISTANCE = 16.0
TOWARD_SPREAD = 8.0
TOWARD_DROP = 8
TOWARD_DELAY = 30
ANGRY_SPEED_BONUS = 0.15
WEB_SCALE = np.array([0.25, 0.05, 0.25])
WATER_DAMAGE = 1.0
WATER_TELEPORT_CHANCE = 0.9
WATER_DRAG = 0.8
WATER_LIFT = 0.04

BURN_TICKS = 160
BURN_PERIOD = 20
BURN_DAMAGE = 1.0

BLOCK_RAY_GRID = 16
BLOCK_RAY_STEP = 0.3
BLOCK_RAY_DECAY = 0.22500001
BLOCK_RAY_STEPS = 18
PARK_HEIGHT = 1000.0

SOLID = np.array([block.solid for block in B.BLOCKS], dtype=bool)


def _blast_table() -> np.ndarray:
    """Return the blast resistance of each block id."""
    named = {
        "dirt": 0.5, "grass_block": 0.6, "sand": 0.5, "gravel": 0.6, "oak_log": 2.0,
        "oak_planks": 3.0, "oak_leaves": 0.2, "ladder": 0.4, "torch": 0.0, "cobweb": 4.0,
        "obsidian": 1200.0, "bedrock": 3_600_000.0, "water": 100.0, "lava": 100.0, "fire": 0.0,
        "barrier": 3_600_000.0, "glass": 0.3, "oak_slab": 3.0, "oak_stairs": 3.0, "oak_door": 3.0,
        "iron_door": 5.0, "air": 0.0,
    }
    table = np.full(len(B.BLOCKS), 6.0)
    for i, block in enumerate(B.BLOCKS):
        if block.name in named:
            table[i] = named[block.name]
        elif block.name.endswith("_ore"):
            table[i] = 3.0
    return table


BLAST_RESISTANCE = _blast_table()


def _blast_rays() -> np.ndarray:
    """Return the unit directions to the outer shell of a 16 by 16 by 16 grid."""
    size = BLOCK_RAY_GRID
    axis = np.arange(size)
    grid = np.stack(np.meshgrid(axis, axis, axis, indexing="ij"), axis=-1).reshape(-1, 3)
    shell = grid[((grid == 0) | (grid == size - 1)).any(axis=1)]
    rays = shell / (size - 1) * 2.0 - 1.0
    return rays / np.linalg.norm(rays, axis=1, keepdims=True)


BLAST_RAYS = _blast_rays()


def difficulty_scale(damage: np.ndarray | float, difficulty: str) -> np.ndarray:
    """Return mob damage to a player on a difficulty."""
    value = np.asarray(damage, dtype=float)
    if difficulty == "easy":
        return np.minimum(value / 2.0 + 1.0, value)
    if difficulty == "hard":
        return value * 1.5
    return value


def blast_damage(distance: np.ndarray | float, exposure: np.ndarray | float = 1.0) -> np.ndarray:
    """Return explosion damage on normal difficulty for a distance and an exposure."""
    near = np.maximum(1.0 - np.asarray(distance, dtype=float) / BLAST_RADIUS, 0.0)
    impact = near * np.asarray(exposure, dtype=float)
    damage = (impact * impact + impact) / 2.0 * BLAST_DAMAGE_SCALE * BLAST_RADIUS + 1.0
    return np.where(np.asarray(distance, dtype=float) <= BLAST_RADIUS, damage, 0.0)


@dataclass(frozen=True)
class MobConfig:
    """How many mobs an arena holds and the rules they follow."""

    max_mobs: int = 4
    difficulty: str = "normal"
    daylight: bool = False
    griefing: bool = True
    spawn_min: float = 6.0
    spawn_max: float = 14.0

    def __post_init__(self) -> None:
        if self.difficulty not in DIFFICULTY_ID:
            raise ValueError(f"unknown difficulty {self.difficulty!r}")
        if self.max_mobs < 1:
            raise ValueError("max_mobs must be at least 1")


class Mobs:
    """The state and rules of every mob in a batch of arenas."""

    def __init__(self, sim, config: MobConfig):
        self.sim = sim
        self.cfg = config
        n = sim.n
        m = config.max_mobs
        self.n = n
        self.m = m
        shape = (n, m)
        self.kind = np.zeros(shape, dtype=np.int64)
        self.alive = np.zeros(shape, dtype=bool)
        self.pos = np.zeros((n, m, 3))
        self.vel = np.zeros((n, m, 3))
        self.seen_pos = np.zeros((n, m, 3))
        self.seen_vel = np.zeros((n, m, 3))
        self.in_sight = np.ones(shape, dtype=bool)
        self.yaw = np.zeros(shape)
        self.hp = np.zeros(shape)
        self.hurt_timer = np.zeros(shape, dtype=np.int64)
        self.last_damage = np.zeros(shape)
        self.on_ground = np.ones(shape, dtype=bool)
        self.resist = np.zeros(shape)
        self.targeting = np.zeros(shape, dtype=bool)
        self.goal_on = np.zeros(shape, dtype=bool)
        self.goal_wait = np.zeros(shape, dtype=np.int64)
        self.unseen = np.zeros(shape, dtype=np.int64)
        self.attack_wait = np.zeros(shape, dtype=np.int64)
        self.see_time = np.zeros(shape, dtype=np.int64)
        self.strafe_time = np.full(shape, -1, dtype=np.int64)
        self.strafe_cw = np.zeros(shape, dtype=bool)
        self.strafe_back = np.zeros(shape, dtype=bool)
        self.draw = np.zeros(shape, dtype=np.int64)
        self.bow_wait = np.zeros(shape, dtype=np.int64)
        self.swell = np.zeros(shape, dtype=np.int64)
        self.swell_dir = np.full(shape, -1, dtype=np.int64)
        self.provoked = np.zeros(shape, dtype=bool)
        self.stare = np.zeros(shape, dtype=np.int64)
        self.toward_time = np.zeros(shape, dtype=np.int64)
        self.fire = np.zeros(shape, dtype=np.int64)
        self.stuck = np.zeros(shape, dtype=np.int64)
        self.webbed = np.zeros(shape, dtype=bool)
        self.detour = np.zeros(shape, dtype=np.int64)
        self.detour_side = np.ones(shape)
        self.detour_rounds = np.zeros(shape, dtype=np.int64)
        self.free_run = np.zeros(shape, dtype=np.int64)
        self.detour_age = np.zeros(shape, dtype=np.int64)
        self.blocked = np.zeros(shape, dtype=bool)
        self.shooter = np.full((n, sim.arrow_on.shape[1]), -1, dtype=np.int64)
        self.kills = np.zeros(n, dtype=np.int64)
        self.blasts = np.zeros(n, dtype=np.int64)
        # An outside director (director.py) may steer a mob: walk to steer_to
        # instead of the player, hold it from targeting the player, or light a
        # creeper's fuse where it stands. All off unless a director sets them.
        self.steer_on = np.zeros(shape, dtype=bool)
        self.steer_to = np.zeros((n, m, 3))
        self.steer_hold = np.zeros(shape, dtype=bool)
        self.lit = np.zeros(shape, dtype=bool)
        self.damage_done = np.zeros(n)
        self.damage_fraction = np.zeros(n)

    def clear(self, idx: np.ndarray) -> None:
        """Remove every mob from the selected arenas."""
        self.alive[idx] = False
        self.targeting[idx] = False
        self.goal_on[idx] = False
        self.goal_wait[idx] = 0
        self.provoked[idx] = False
        self.swell[idx] = 0
        self.swell_dir[idx] = -1
        self.draw[idx] = 0
        self.fire[idx] = 0
        self.kills[idx] = 0
        self.blasts[idx] = 0
        self.steer_on[idx] = False
        self.steer_hold[idx] = False
        self.lit[idx] = False
        self.damage_done[idx] = 0.0
        self.damage_fraction[idx] = 0.0

    def spawn(self, env: int, slot: int, kind: int, x: float, y: float, z: float) -> None:
        """Put a fresh mob of a kind in one slot."""
        self.kind[env, slot] = kind
        self.alive[env, slot] = True
        self.pos[env, slot] = (x, y, z)
        self.vel[env, slot] = 0.0
        self.seen_pos[env, slot] = (x, y, z)
        self.seen_vel[env, slot] = 0.0
        self.in_sight[env, slot] = True
        self.yaw[env, slot] = 0.0
        self.hp[env, slot] = HEALTH[kind]
        self.hurt_timer[env, slot] = 0
        self.last_damage[env, slot] = 0.0
        self.on_ground[env, slot] = True
        high = 0.05 if kind == ZOMBIE else 0.0
        self.resist[env, slot] = self.sim.rng.uniform(0.0, high) if high else 0.0
        self.targeting[env, slot] = False
        self.goal_on[env, slot] = False
        self.goal_wait[env, slot] = 0
        self.unseen[env, slot] = 0
        self.attack_wait[env, slot] = 0
        self.see_time[env, slot] = 0
        self.strafe_time[env, slot] = -1
        self.strafe_cw[env, slot] = False
        self.strafe_back[env, slot] = False
        self.draw[env, slot] = 0
        self.bow_wait[env, slot] = 0
        self.swell[env, slot] = 0
        self.swell_dir[env, slot] = -1
        self.provoked[env, slot] = False
        self.stare[env, slot] = 0
        self.toward_time[env, slot] = 0
        self.fire[env, slot] = 0
        self.stuck[env, slot] = 0
        self.detour[env, slot] = 0
        self.detour_rounds[env, slot] = 0
        self.free_run[env, slot] = 0
        self.detour_age[env, slot] = 0
        self.blocked[env, slot] = False
        self.steer_on[env, slot] = False
        self.steer_hold[env, slot] = False
        self.lit[env, slot] = False

    def spawn_roster(self, idx: np.ndarray, kinds: np.ndarray) -> None:
        """Spawn a roster of shape (len(idx), m) around each selected player. -1 leaves a slot empty."""
        sim = self.sim
        cfg = self.cfg
        half = sim.cfg.arena_half - C.PLAYER_WIDTH
        for row, env in enumerate(idx.tolist()):
            player = sim.pos[env, 0]
            for slot, kind in enumerate(kinds[row].tolist()):
                if kind == NO_MOB:
                    continue
                angle = sim.rng.uniform(0.0, 2.0 * np.pi)
                radius = sim.rng.uniform(cfg.spawn_min, cfg.spawn_max)
                x = player[0] + radius * np.cos(angle)
                z = player[2] + radius * np.sin(angle)
                x = float(np.clip(x, sim.origin[0] - half, sim.origin[0] + half))
                z = float(np.clip(z, sim.origin[2] - half, sim.origin[2] + half))
                y = self._ground_height(env, x, z, float(player[1]))
                self.spawn(env, slot, int(kind), x, y, z)

    def _ground_height(self, env: int, x: float, z: float, near_y: float) -> float:
        world = self.sim.world
        if world is None:
            return 0.0
        cx, cz = int(np.floor(x)), int(np.floor(z))
        top = min(int(near_y) + 12, B.Y_MAX)
        for y in range(top, max(int(near_y) - 32, B.Y_MIN), -1):
            if SOLID[world.block(cx, y, cz, env)]:
                return float(y + 1)
        return near_y

    def boxes(self) -> tuple[np.ndarray, np.ndarray]:
        """Return mob hitbox corners of shape (n, m, 3)."""
        half = WIDTH[self.kind] / 2.0
        low = self.pos.copy()
        high = self.pos.copy()
        low[..., 0] -= half
        low[..., 2] -= half
        high[..., 0] += half
        high[..., 2] += half
        high[..., 1] += HEIGHT[self.kind]
        return low, high

    def aim(self, reach: float) -> tuple[np.ndarray, np.ndarray]:
        """Return which players aim at a mob within reach, and the first mob on the ray."""
        sim = self.sim
        rows = np.arange(self.n)
        eye = sim.eyes()[:, 0]
        look = sim.look()[:, 0]
        low, high = self.boxes()
        safe = np.where(np.abs(look) < 1e-9, 1e-9, look)[:, None]
        t1 = (low - eye[:, None]) / safe
        t2 = (high - eye[:, None]) / safe
        near = np.minimum(t1, t2).max(axis=-1)
        far = np.maximum(t1, t2).min(axis=-1)
        entry = np.maximum(near, 0.0)
        reached = self.alive & (far >= entry) & (entry <= reach)
        distance = np.where(reached, entry, np.inf)
        who = distance.argmin(axis=1)
        hit = reached.any(axis=1)
        if sim.world is not None and hit.any():
            block_hit, _, _, block_at = sim.world.ray_block_many(eye[:, None], look[:, None], float(reach))
            hit &= ~(block_hit[:, 0] & (block_at[:, 0] < distance[rows, who]))
        return hit, who

    def nearest(self) -> tuple[np.ndarray, np.ndarray]:
        """Return the nearest living mob slot of each arena and which arenas have one."""
        gap = self.pos - self.sim.pos[:, 0, None]
        distance = np.where(self.alive, (gap * gap).sum(axis=-1), np.inf)
        return distance.argmin(axis=1), self.alive.any(axis=1)

    def update_seen(self) -> None:
        """Refresh what the player can see of each mob. A mob behind blocks keeps its last place."""
        if self.sim.world is None:
            self.in_sight[:] = True
        else:
            env, slot = np.nonzero(self.alive)
            self.in_sight[:] = False
            if len(env):
                self.in_sight[env, slot] = self._line_of_sight(env, slot, self.sim.eyes()[env, 0])
        self.seen_pos[self.in_sight] = self.pos[self.in_sight]
        self.seen_vel[self.in_sight] = self.vel[self.in_sight]

    def looked_at(self) -> np.ndarray:
        """Return which mobs the player is looking at in the eyes, ignoring blocks."""
        sim = self.sim
        eye = sim.eyes()[:, 0, None]
        look = sim.look()[:, 0, None]
        to_eye = self.pos - eye
        to_eye[..., 1] += EYE[self.kind]
        length = np.maximum(np.linalg.norm(to_eye, axis=-1), 1e-6)
        dot = (to_eye * look).sum(axis=-1) / length
        return dot > 1.0 - STARE_TOLERANCE / length

    def tick(self) -> None:
        """Advance every living mob by one game tick."""
        if not self.alive.any():
            return
        env, slot = np.nonzero(self.alive)
        gap, dist_sq, sight = self._sense(env, slot)
        self._update_targets(env, slot, dist_sq, sight)
        move_f, move_s, speed = self._intent(env, slot, gap, dist_sq, sight)
        walk = self._steer(env, slot, gap, move_f, move_s, speed)
        self._motion(env, slot, walk, move_f, move_s, speed)
        self._push()
        self._melee_attacks(env, slot, sight)
        self._bow_attacks(env, slot, sight)
        self._fuses(env, slot, dist_sq, sight)
        if self.alive.any():
            self._surroundings()
        self.hurt_timer = np.maximum(self.hurt_timer - 1, 0)
        self.attack_wait = np.maximum(self.attack_wait - 1, 0)
        self.goal_wait = np.maximum(self.goal_wait - 1, 0)

    def ignite(self, env: int, slot: int) -> None:
        """Light a creeper's normal fuse where it stands, as flint and steel would."""
        if self.alive[env, slot] and self.kind[env, slot] == CREEPER:
            self.lit[env, slot] = True

    def _steer(
        self, env: np.ndarray, slot: np.ndarray, gap: np.ndarray, move_f: np.ndarray, move_s: np.ndarray, speed: np.ndarray
    ) -> np.ndarray:
        """Point steered mobs at their spot instead of the player. Return the walking gap."""
        steered = self.steer_on[env, slot]
        if not steered.any():
            return gap
        walk = gap.copy()
        to = self.steer_to[env, slot] - self.pos[env, slot]
        walk[steered] = to[steered]
        near = np.hypot(to[:, 0], to[:, 2]) < STEER_ARRIVE
        lit = self.swell_dir[env, slot] > 0
        go = steered & ~near & ~lit
        move_f[steered] = np.where(go[steered], speed[steered] * MOVE_INPUT, 0.0)
        move_s[steered] = 0.0
        return walk

    def _sense(self, env: np.ndarray, slot: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        sim = self.sim
        here = self.pos[env, slot]
        gap = sim.pos[env, 0] - here
        dist_sq = (gap * gap).sum(axis=-1)
        sight = self._line_of_sight(env, slot, sim.eyes()[env, 0])
        return gap, dist_sq, sight

    def _line_of_sight(self, env: np.ndarray, slot: np.ndarray, target: np.ndarray) -> np.ndarray:
        """Return which mobs have a clear line from their eyes to a point."""
        world = self.sim.world
        if world is None:
            return np.ones(len(env), dtype=bool)
        eye = self.pos[env, slot].copy()
        eye[:, 1] += EYE[self.kind[env, slot]]
        delta = target - eye
        length = np.maximum(np.linalg.norm(delta, axis=-1), 1e-6)
        start = np.zeros((self.n, self.m, 3))
        heading = np.zeros((self.n, self.m, 3))
        start[env, slot] = eye
        heading[env, slot] = delta / length[:, None]
        hit, _, _, dist = world.ray_collide_many(start, heading, float(length.max()) + 1e-6)
        return ~(hit[env, slot] & (dist[env, slot] < length))

    def _update_targets(self, env: np.ndarray, slot: np.ndarray, dist_sq: np.ndarray, sight: np.ndarray) -> None:
        sim = self.sim
        kind = self.kind[env, slot]
        player_alive = sim.hp[env, 0] > 0.0
        near = dist_sq <= FOLLOW[kind] ** 2
        unseen = np.where(sight, 0, self.unseen[env, slot] + 1)
        self.unseen[env, slot] = unseen

        hostile = kind != ENDERMAN
        roll = sim.rng.random(len(env)) < TARGET_CHANCE
        target = self.targeting[env, slot] | (hostile & near & sight & roll)
        target &= player_alive & (near | ~hostile) & (unseen <= UNSEEN_LIMIT)
        # a mob a director steers or holds back does not pick the player itself
        target &= ~(self.steer_on[env, slot] | self.steer_hold[env, slot])

        calm = ~hostile
        if calm.any():
            looking = self.looked_at()[env, slot] & sight & player_alive & near
            stare = np.where(looking & ~self.provoked[env, slot], self.stare[env, slot] + 1, 0)
            self.stare[env, slot] = stare
            provoked = self.provoked[env, slot] | (calm & (stare >= STARE_TICKS))
            provoked &= player_alive & (unseen <= ANGER_UNSEEN_LIMIT)
            self.provoked[env, slot] = provoked & calm
            target = np.where(calm, provoked, target)
        self.targeting[env, slot] = target

        melee = kind != SKELETON
        running = self.goal_on[env, slot]
        wait = self.goal_wait[env, slot]
        due = melee & ~running & (wait == 0)
        self.goal_on[env, slot] = melee & target & (running | due)
        self.goal_wait[env, slot] = np.where(due, GOAL_CHECK_TICKS, wait)

    def _intent(
        self, env: np.ndarray, slot: np.ndarray, gap: np.ndarray, dist_sq: np.ndarray, sight: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        kind = self.kind[env, slot]
        target = self.targeting[env, slot]
        speed = SPEED[kind] + ANGRY_SPEED_BONUS * (kind == ENDERMAN) * self.provoked[env, slot]
        chasing = target & (self.goal_on[env, slot] | (kind == SKELETON))
        move_f = np.where(chasing, speed * MOVE_INPUT, 0.0)
        move_s = np.zeros(len(env))

        creeper = kind == CREEPER
        if creeper.any():
            holding = creeper & ((self.swell_dir[env, slot] > 0) | (target & (dist_sq < SWELL_START**2)))
            move_f[holding] = 0.0

        ender = (kind == ENDERMAN) & target
        if ender.any():
            looked = self.looked_at()[env, slot] & sight
            frozen = ender & looked & (dist_sq <= FREEZE_RANGE**2)
            move_f[frozen] = 0.0
            self._ender_teleports(env, slot, ender, looked, dist_sq)

        archer = kind == SKELETON
        if archer.any():
            self._skeleton_intent(env, slot, archer, target, dist_sq, sight, speed, move_f, move_s)
        return move_f, move_s, speed

    def _ender_teleports(
        self, env: np.ndarray, slot: np.ndarray, ender: np.ndarray, looked: np.ndarray, dist_sq: np.ndarray
    ) -> None:
        close = ender & looked & (dist_sq < TELEPORT_AWAY_RANGE**2)
        for i in np.flatnonzero(close).tolist():
            self.teleport(int(env[i]), int(slot[i]))
        wait = self.toward_time[env, slot]
        far = ender & ~looked & (dist_sq > FREEZE_RANGE**2)
        self.toward_time[env, slot] = np.where(far, wait + 1, np.where(ender & looked, 0, wait))
        ready = far & (wait >= TOWARD_DELAY)
        for i in np.flatnonzero(ready).tolist():
            if self.teleport_toward(int(env[i]), int(slot[i])):
                self.toward_time[env[i], slot[i]] = 0

    def _skeleton_intent(
        self,
        env: np.ndarray,
        slot: np.ndarray,
        archer: np.ndarray,
        target: np.ndarray,
        dist_sq: np.ndarray,
        sight: np.ndarray,
        speed: np.ndarray,
        move_f: np.ndarray,
        move_s: np.ndarray,
    ) -> None:
        rng = self.sim.rng
        see = self.see_time[env, slot]
        see = np.where(sight != (see > 0), 0, see)
        see = see + np.where(sight, 1, -1)
        see = np.where(target, see, 0)
        self.see_time[env, slot] = np.where(archer, see, self.see_time[env, slot])

        settled = archer & target & (dist_sq <= BOW_RANGE**2) & (see >= BOW_DRAW)
        strafe = self.strafe_time[env, slot]
        strafe = np.where(settled, strafe + 1, np.where(archer, -1, strafe))
        flip = archer & (strafe >= STRAFE_FLIP_TICKS)
        if flip.any():
            count = int(flip.sum())
            at = np.flatnonzero(flip)
            turn = rng.random(count) < STRAFE_FLIP_CHANCE
            back = rng.random(count) < STRAFE_FLIP_CHANCE
            self.strafe_cw[env[at[turn]], slot[at[turn]]] ^= True
            self.strafe_back[env[at[back]], slot[at[back]]] ^= True
            strafe[flip] = 0
        self.strafe_time[env, slot] = strafe
        move_f[archer & (strafe < 0) & (dist_sq < BOW_APPROACH_STOP**2)] = 0.0

        moving = archer & target & (strafe > -1)
        if moving.any():
            back = self.strafe_back[env, slot].copy()
            back = np.where(dist_sq > 0.75 * BOW_RANGE**2, False, back)
            back = np.where(dist_sq < 0.25 * BOW_RANGE**2, True, back)
            self.strafe_back[env[moving], slot[moving]] = back[moving]
            clockwise = self.strafe_cw[env, slot]
            speed[moving] = SPEED[SKELETON] * STRAFE_MODIFIER
            move_f[moving] = np.where(back[moving], -STRAFE_INPUT, STRAFE_INPUT) * MOVE_INPUT
            move_s[moving] = np.where(clockwise[moving], STRAFE_INPUT, -STRAFE_INPUT) * MOVE_INPUT

    def _motion(
        self,
        env: np.ndarray,
        slot: np.ndarray,
        gap: np.ndarray,
        move_f: np.ndarray,
        move_s: np.ndarray,
        speed: np.ndarray,
    ) -> None:
        sim = self.sim
        length = np.maximum(np.hypot(gap[:, 0], gap[:, 2]), 1e-6)
        fx = gap[:, 0] / length
        fz = gap[:, 2] / length
        turning = self.detour[env, slot] > 0
        if turning.any():
            angle = np.radians(DETOUR_DEGREES) * self.detour_side[env, slot] * turning
            cos_a, sin_a = np.cos(angle), np.sin(angle)
            fx, fz = fx * cos_a - fz * sin_a, fx * sin_a + fz * cos_a
        facing = self.targeting[env, slot]
        self.yaw[env, slot] = np.where(facing, np.degrees(np.arctan2(-fx, fz)), self.yaw[env, slot])

        before = self.pos[env, slot].copy()
        grounded = self.on_ground[env, slot]
        accel = np.where(grounded, speed, C.AIR_ACCEL)
        vel = self.vel[env, slot]
        vel[:, 0] += (fx * move_f - fz * move_s) * accel
        vel[:, 2] += (fz * move_f + fx * move_s) * accel

        wants = (np.abs(move_f) + np.abs(move_s)) > 0.0
        hop = grounded & self.blocked[env, slot] & wants
        if hop.any() and sim.world is not None:
            hop &= self._can_hop(env, slot, vel)
        vel[hop, 1] = C.JUMP_VELOCITY

        if sim.world is None:
            moved = self.pos[env, slot] + vel
            landed = (moved[:, 1] <= 0.0) & (vel[:, 1] <= 0.0)
            moved[:, 1] = np.maximum(moved[:, 1], 0.0)
            vel[landed, 1] = 0.0
            limit = sim.cfg.arena_half - WIDTH[self.kind[env, slot]] / 2.0
            for axis in (0, 2):
                over = np.abs(moved[:, axis]) > limit
                if over.any():
                    moved[over, axis] = np.clip(moved[over, axis], -limit[over], limit[over])
                    vel[over, axis] = 0.0
            self.pos[env, slot] = moved
            self.on_ground[env, slot] = landed
            in_water = np.zeros(len(env), dtype=bool)
        else:
            in_water = self._move_in_world(env, slot, vel, grounded)

        drag = np.where(grounded, MOB_FRICTION_DRAG, C.AIR_DRAG)
        vel[:, 0] *= drag
        vel[:, 2] *= drag
        vel[:, 1] = (vel[:, 1] - C.GRAVITY) * C.VERTICAL_DRAG
        if in_water.any():
            vel[in_water, 0] *= WATER_DRAG
            vel[in_water, 2] *= WATER_DRAG
            vel[in_water, 1] = vel[in_water, 1] * WATER_DRAG + WATER_LIFT + C.GRAVITY * C.VERTICAL_DRAG
        self.vel[env, slot] = vel

        step = self.pos[env, slot] - before
        still = np.hypot(step[:, 0], step[:, 2]) < np.where(self.webbed[env, slot], STUCK_MOVE * WEB_SCALE[0], STUCK_MOVE)
        stuck = np.where(wants & still & (length > ENGAGED_RANGE), self.stuck[env, slot] + 1, 0)
        free = np.where(self.blocked[env, slot], 0, self.free_run[env, slot] + 1)
        self.free_run[env, slot] = free
        clear = free >= DETOUR_CLEAR_TICKS
        self.detour_rounds[env[clear], slot[clear]] = 0
        start = (stuck >= STUCK_TICKS) & (self.detour[env, slot] == 0)
        if start.any():
            at = np.flatnonzero(start)
            first = self.detour_rounds[env[at], slot[at]] == 0
            sides = sim.rng.choice([-1.0, 1.0], size=len(at))
            self.detour_side[env[at[first]], slot[at[first]]] = sides[first]
            rounds = np.minimum(self.detour_rounds[env[at], slot[at]] + 1, DETOUR_MAX_ROUNDS)
            self.detour_rounds[env[at], slot[at]] = rounds
            self.detour[env[at], slot[at]] = DETOUR_TICKS * rounds
            stuck[at] = 0
        self.stuck[env, slot] = stuck
        left = self.detour[env, slot]
        age = np.where(left > 0, self.detour_age[env, slot] + 1, 0)
        self.detour_age[env, slot] = age
        left = np.maximum(left - ~self.blocked[env, slot], 0)
        self.detour[env, slot] = np.where(age >= DETOUR_LIMIT_TICKS, 0, left)

    def _can_hop(self, env: np.ndarray, slot: np.ndarray, vel: np.ndarray) -> np.ndarray:
        """Return which mobs would clear the obstacle ahead after a jump."""
        lifted = self.pos.copy()
        lifted[env, slot, 1] += HOP_CLEARANCE
        delta = np.zeros((self.n, self.m, 3))
        delta[env, slot, 0] = vel[:, 0]
        delta[env, slot, 2] = vel[:, 2]
        _, contact, _ = self.sim.world.collide_many(lifted, delta, WIDTH[self.kind], HEIGHT[self.kind])
        return (contact[env, slot] & 5) == 0

    def _move_in_world(self, env: np.ndarray, slot: np.ndarray, vel: np.ndarray, grounded: np.ndarray) -> np.ndarray:
        world = self.sim.world
        kind = self.kind[env, slot]
        width = WIDTH[self.kind]
        height = HEIGHT[self.kind]
        wet = world.fluid_box_many(self.pos, width, height, EYE[self.kind])["in_water"][env, slot]
        was_ground = np.zeros((self.n, self.m), dtype=bool)
        was_ground[env, slot] = grounded
        webbed = world.contact_many(self.pos, width, height)["cobweb"][env, slot]
        self.webbed[env, slot] = webbed
        scale = np.where(webbed[:, None], WEB_SCALE, 1.0)
        for step in np.unique(STEP[kind]).tolist():
            pick = STEP[kind] == step
            delta = np.zeros((self.n, self.m, 3))
            delta[env[pick], slot[pick]] = vel[pick] * scale[pick]
            out, contact, ground = world.collide_many(self.pos, delta, width, height, was_ground, step)
            e, s = env[pick], slot[pick]
            self.pos[e, s] = out[e, s]
            self.on_ground[e, s] = ground[e, s]
            bits = contact[e, s]
            hit_x = (bits & 1) > 0
            hit_y = (bits & 2) > 0
            hit_z = (bits & 4) > 0
            part = vel[pick]
            part[hit_x, 0] = 0.0
            part[hit_y, 1] = 0.0
            part[hit_z, 2] = 0.0
            vel[pick] = part
            self.blocked[e, s] = hit_x | hit_z
        vel[webbed] = 0.0
        return wet

    def _push(self) -> None:
        """Push overlapping bodies apart, player against mob and mob against mob."""
        sim = self.sim
        gap = self.pos - sim.pos[:, 0, None]
        near = self.alive & (np.abs(gap[..., 0]) < C.PLAYER_WIDTH) & (np.abs(gap[..., 2]) < C.PLAYER_WIDTH)
        near &= (gap[..., 1] < C.PLAYER_HEIGHT) & (-gap[..., 1] < HEIGHT[self.kind])
        if near.any():
            env, slot = np.nonzero(near)
            push_x, push_z = _push_amount(gap[env, slot, 0], gap[env, slot, 2])
            np.add.at(sim.vel[..., 0], (env, np.zeros(len(env), dtype=np.int64)), -push_x)
            np.add.at(sim.vel[..., 2], (env, np.zeros(len(env), dtype=np.int64)), -push_z)
            self.vel[env, slot, 0] += push_x
            self.vel[env, slot, 2] += push_z
        if self.m < 2:
            return
        for a in range(self.m - 1):
            for b in range(a + 1, self.m):
                both = self.alive[:, a] & self.alive[:, b]
                if not both.any():
                    continue
                delta = self.pos[:, b] - self.pos[:, a]
                close = both & (np.abs(delta[:, 0]) < WIDTH[self.kind[:, a]])
                close &= np.abs(delta[:, 2]) < WIDTH[self.kind[:, a]]
                close &= np.abs(delta[:, 1]) < HEIGHT[self.kind[:, a]]
                if not close.any():
                    continue
                push_x, push_z = _push_amount(delta[close, 0], delta[close, 2])
                self.vel[close, a, 0] -= push_x
                self.vel[close, a, 2] -= push_z
                self.vel[close, b, 0] += push_x
                self.vel[close, b, 2] += push_z

    def _melee_attacks(self, env: np.ndarray, slot: np.ndarray, sight: np.ndarray) -> None:
        sim = self.sim
        kind = self.kind[env, slot]
        ready = (
            self.alive[env, slot]
            & self.targeting[env, slot]
            & self.goal_on[env, slot]
            & (MELEE[kind] > 0.0)
            & (kind != SKELETON)
            & (self.attack_wait[env, slot] == 0)
            & sight
            & (sim.hp[env, 0] > 0.0)
        )
        if not ready.any():
            return
        at = np.flatnonzero(ready)
        e, s = env[at], slot[at]
        here = self.pos[e, s]
        player = sim.pos[e, 0]
        reach = WIDTH[self.kind[e, s]] / 2.0 + MELEE_REACH + C.PLAYER_WIDTH / 2.0
        heights = sim.body.heights()[e, 0]
        touching = (
            (np.abs(here[:, 0] - player[:, 0]) <= reach)
            & (np.abs(here[:, 2] - player[:, 2]) <= reach)
            & (here[:, 1] <= player[:, 1] + heights)
            & (player[:, 1] <= here[:, 1] + HEIGHT[self.kind[e, s]])
        )
        if not touching.any():
            return
        e, s = e[touching], s[touching]
        self.attack_wait[e, s] = MELEE_INTERVAL
        for value in np.unique(s).tolist():
            pick = s == value
            self._strike_player(e[pick], value)

    def _strike_player(self, env: np.ndarray, slot: int) -> None:
        """Land one melee hit from one mob slot on the players of the given arenas."""
        sim = self.sim
        combat = sim.combat
        kind = self.kind[env, slot]
        raw = difficulty_scale(MELEE[kind], self.cfg.difficulty)
        away = sim.pos[env, 0] - self.pos[env, slot]
        length = np.maximum(np.hypot(away[:, 0], away[:, 2]), 1e-6)
        dx = away[:, 0] / length
        dz = away[:, 2] / length
        yaw = np.radians(sim.yaw[env, 0])
        front = -np.sin(yaw) * -away[:, 0] + np.cos(yaw) * -away[:, 2] > 0.0
        blocked = sim.shield_active[env, 0] & front
        direction = np.zeros((self.n, 2))
        direction[env, 0] = dx
        direction[env, 1] = dz

        guarded = env[blocked]
        if len(guarded):
            mask = np.zeros(self.n, dtype=bool)
            mask[guarded] = True
            M.blocked_knockback(sim, mask, 0, direction)
            opened = guarded[sim.hurt_timer[guarded, 0] == 0]
            sim.hurt_timer[opened, 0] = C.HURT_TICKS
            sim.last_damage[opened, 0] = 0.0
            combat._wear_shield(guarded, 0, raw[blocked])
            sim.events["melee_blocked"][guarded, 1] += 1.0
            self.knock(guarded, np.full(len(guarded), slot), -dx[blocked], -dz[blocked], SHIELD_RECOIL)

        open_hit = env[~blocked]
        if len(open_hit) == 0:
            return
        mask = np.zeros(self.n, dtype=bool)
        mask[open_hit] = True
        full = np.zeros(self.n)
        full[open_hit] = raw[~blocked]
        dealt = combat.hurt(mask, 0, full, direction, np.full(self.n, MOB_KNOCKBACK), kind=I.MELEE)
        sim.events["damage_taken"][:, 0] += dealt
        sim.events["damage_dealt"][:, 1] += dealt
        sim.events["hits"][:, 1] += dealt > 0.0

    def knock(self, env: np.ndarray, slot: np.ndarray, dx: np.ndarray, dz: np.ndarray, strength: float) -> None:
        """Apply one knockback impulse to mobs along a unit direction."""
        if len(env) == 0:
            return
        keep = 1.0 - self.resist[env, slot]
        vel = self.vel[env, slot]
        hx, vy, hz = M._impulse(
            vel[:, 0], vel[:, 1], vel[:, 2], self.on_ground[env, slot], strength * keep, dx, dz
        )
        self.vel[env, slot, 0] = hx
        self.vel[env, slot, 1] = vy
        self.vel[env, slot, 2] = hz

    def _bow_attacks(self, env: np.ndarray, slot: np.ndarray, sight: np.ndarray) -> None:
        archer = self.alive[env, slot] & (self.kind[env, slot] == SKELETON) & self.targeting[env, slot]
        idle = self.alive[env, slot] & (self.kind[env, slot] == SKELETON) & ~self.targeting[env, slot]
        if idle.any():
            self.draw[env[idle], slot[idle]] = 0
        if not archer.any():
            return
        at = np.flatnonzero(archer)
        e, s = env[at], slot[at]
        seen = sight[at]
        see = self.see_time[e, s]
        drawing = self.draw[e, s] > 0
        give_up = drawing & ~seen & (see < -LOST_SIGHT_TICKS)
        self.draw[e[give_up], s[give_up]] = 0
        keep = drawing & ~give_up
        self.draw[e[keep], s[keep]] += 1
        release = keep & seen & (self.draw[e, s] > BOW_DRAW)
        for i in np.flatnonzero(release).tolist():
            self._shoot(int(e[i]), int(s[i]))
        if release.any():
            self.draw[e[release], s[release]] = 0
            self.bow_wait[e[release], s[release]] = BOW_REST[self.cfg.difficulty]
        waiting = ~drawing
        if waiting.any():
            left = self.bow_wait[e, s] - 1
            self.bow_wait[e[waiting], s[waiting]] = left[waiting]
            begin = waiting & (left <= 0) & (see >= -LOST_SIGHT_TICKS)
            self.draw[e[begin], s[begin]] = 1

    def _shoot(self, env: int, slot: int) -> None:
        """Launch one skeleton arrow through the shared arrow arrays."""
        sim = self.sim
        rng = sim.rng
        difficulty = self.cfg.difficulty
        start = self.pos[env, slot].copy()
        start[1] += EYE[SKELETON] - arrows.SPAWN_BELOW_EYE
        target = sim.pos[env, 0]
        dx = target[0] - start[0]
        dy = target[1] + sim.body.heights()[env, 0] / 3.0 - start[1]
        dz = target[2] - start[2]
        flat = float(np.hypot(dx, dz))
        aim = np.array([dx, dy + flat * ARROW_LIFT, dz])
        aim /= max(float(np.linalg.norm(aim)), 1e-9)
        error = arrows.LAUNCH_SPREAD * BOW_ERROR[difficulty]
        aim += error * (rng.random(3) - rng.random(3))
        velocity = aim * ARROW_SPEED

        own = sim.arrow_on[env] & (sim.arrow_owner[env] == 1)
        if own.sum() >= arrows.ARROWS_PER_SIDE:
            target_slot = int(np.where(own, sim.arrow_age[env], -1).argmax())
        else:
            target_slot = int((~sim.arrow_on[env]).argmax())
        level = DIFFICULTY_ID[difficulty]
        base = 2.0 + level * 0.11 + ARROW_SPREAD_SCALE * float(rng.random() - rng.random())
        sim.arrow_on[env, target_slot] = True
        sim.arrow_pos[env, target_slot] = start
        sim.arrow_vel[env, target_slot] = velocity
        sim.arrow_owner[env, target_slot] = 1
        self.shooter[env, target_slot] = slot
        sim.arrow_crit[env, target_slot] = False
        sim.arrow_age[env, target_slot] = 0
        sim.arrow_bounced[env, target_slot] = False
        sim.arrow_pickup[env, target_slot] = False
        sim.arrow_damage[env, target_slot] = base
        sim.arrow_punch[env, target_slot] = 0
        sim.arrow_flame[env, target_slot] = False
        sim.events["arrows_fired"][env, 1] += 1.0

    def _fuses(self, env: np.ndarray, slot: np.ndarray, dist_sq: np.ndarray, sight: np.ndarray) -> None:
        live = self.alive[env, slot] & (self.kind[env, slot] == CREEPER)
        if not live.any():
            return
        target = self.targeting[env, slot]
        swell = self.swell[env, slot]
        lit = self.lit[env, slot]
        active = live & ((self.swell_dir[env, slot] > 0) | (target & (dist_sq < SWELL_START**2)) | lit)
        # a lit fuse burns down whatever the creeper sees, like flint and steel
        rising = active & ((target & (dist_sq <= SWELL_CANCEL**2) & sight) | lit)
        direction = np.where(rising, 1, -1)
        self.swell_dir[env[live], slot[live]] = direction[live]
        after = np.clip(swell + direction, 0, FUSE_TICKS)
        self.swell[env[live], slot[live]] = after[live]
        ready = live & (after >= FUSE_TICKS)
        for i in np.flatnonzero(ready).tolist():
            self.explode(int(env[i]), int(slot[i]))

    def explode(self, env: int, slot: int) -> None:
        """Detonate one creeper: damage, knockback, then broken blocks."""
        sim = self.sim
        center = self.pos[env, slot].copy()
        self.alive[env, slot] = False
        self.swell[env, slot] = 0
        self.blasts[env] += 1
        self._blast_player(env, center)
        for other in np.flatnonzero(self.alive[env]).tolist():
            self._blast_mob(env, other, center)
        if sim.world is not None and self.cfg.griefing:
            self._break_blocks(env, center)

    def _exposure(self, env: int, center: np.ndarray, low: np.ndarray, high: np.ndarray) -> float:
        """Return the share of sample points on a box that the blast center can reach."""
        world = self.sim.world
        if world is None:
            return 1.0
        size = high - low
        step = 1.0 / (2.0 * size + 1.0)
        off_x = (1.0 - np.floor(1.0 / step[0]) * step[0]) / 2.0
        off_z = (1.0 - np.floor(1.0 / step[2]) * step[2]) / 2.0
        grid = [
            low + size * np.array([off_x + i, j, off_z + k])
            for i in np.arange(0.0, 1.0, step[0])
            for j in np.arange(0.0, 1.0 + 1e-9, step[1])
            for k in np.arange(0.0, 1.0, step[2])
        ]
        points = np.array(grid)
        delta = center - points
        length = np.maximum(np.linalg.norm(delta, axis=1), 1e-6)
        start = np.zeros((self.n, len(points), 3))
        heading = np.zeros((self.n, len(points), 3))
        start[env] = points
        heading[env] = delta / length[:, None]
        hit, _, _, dist = world.ray_collide_many(start, heading, float(length.max()) + 1e-6)
        blocked = hit[env] & (dist[env] < length)
        return float((~blocked).mean())

    def _blast_player(self, env: int, center: np.ndarray) -> None:
        sim = self.sim
        combat = sim.combat
        if sim.hp[env, 0] <= 0.0:
            return
        feet = sim.pos[env, 0]
        distance = float(np.linalg.norm(feet - center))
        if distance > BLAST_RADIUS:
            return
        low, high = sim.boxes()
        exposure = self._exposure(env, center, low[env, 0], high[env, 0])
        raw = float(difficulty_scale(blast_damage(distance, exposure), self.cfg.difficulty))
        yaw = np.radians(sim.yaw[env, 0])
        to_blast = center - feet
        front = -np.sin(yaw) * to_blast[0] + np.cos(yaw) * to_blast[2] > 0.0
        if sim.shield_active[env, 0] and front:
            combat._wear_shield(np.array([env]), 0, np.array([raw]))
            sim.events["melee_blocked"][env, 1] += 1.0
        else:
            mask = np.zeros(self.n, dtype=bool)
            mask[env] = True
            full = np.zeros(self.n)
            full[env] = raw
            dealt = combat.hurt(mask, 0, full, kind=I.BLAST)
            sim.events["damage_taken"][:, 0] += dealt
            sim.events["damage_dealt"][:, 1] += dealt
        eye = feet + np.array([0.0, float(sim.body.eyes()[env, 0]), 0.0])
        to_eye = eye - center
        size = float(np.linalg.norm(to_eye))
        if size < 1e-6:
            return
        levels = float(np.sum(combat.kits[combat.kit_id[env, 0]].blast_protection))
        keep = max(1.0 - BLAST_PROTECTION_KNOCKBACK * levels, 0.0)
        strength = (1.0 - distance / BLAST_RADIUS) * exposure * keep
        combat.pull(env, 0, to_eye / size * strength)

    def _blast_mob(self, env: int, slot: int, center: np.ndarray) -> None:
        feet = self.pos[env, slot]
        distance = float(np.linalg.norm(feet - center))
        if distance > BLAST_RADIUS:
            return
        low, high = self.boxes()
        exposure = self._exposure(env, center, low[env, slot], high[env, slot])
        raw = float(blast_damage(distance, exposure))
        self.hurt(np.array([env]), np.array([slot]), np.array([raw]), by_player=False)
        kind = int(self.kind[env, slot])
        eye = feet + np.array([0.0, EYE[kind], 0.0])
        to_eye = eye - center
        size = float(np.linalg.norm(to_eye))
        if size > 1e-6 and self.alive[env, slot]:
            self.vel[env, slot] += to_eye / size * (1.0 - distance / BLAST_RADIUS) * exposure
            self.on_ground[env, slot] = False

    def _break_blocks(self, env: int, center: np.ndarray) -> None:
        """Cast the explosion rays and clear every block they break."""
        world = self.sim.world
        rng = self.sim.rng
        reach = int(np.ceil(BLOCK_RAY_STEP * BLOCK_RAY_STEPS)) + 1
        origin = np.floor(center).astype(np.int64)
        span = 2 * reach + 1
        cells = np.zeros((span, span, span), dtype=np.int64)
        base = world.base
        for ix in range(span):
            x = int(origin[0]) - reach + ix
            if not 0 <= x < base.nx:
                continue
            for iy in range(span):
                y = int(origin[1]) - reach + iy
                if not B.Y_MIN <= y <= B.Y_MAX:
                    continue
                for iz in range(span):
                    z = int(origin[2]) - reach + iz
                    if 0 <= z < base.nz:
                        cells[ix, iy, iz] = world.block(x, y, z, env)
        power = BLAST_POWER * (0.7 + rng.random(len(BLAST_RAYS)) * 0.6)
        marked = np.zeros((span, span, span), dtype=bool)
        corner = origin - reach
        for step in range(BLOCK_RAY_STEPS):
            where = np.floor(center + BLAST_RAYS * BLOCK_RAY_STEP * step).astype(np.int64) - corner
            inside = ((where >= 0) & (where < span)).all(axis=1)
            ids = np.zeros(len(where), dtype=np.int64)
            ids[inside] = cells[where[inside, 0], where[inside, 1], where[inside, 2]]
            full = ids != B.AIR
            power = power - full * (BLAST_RESISTANCE[ids] + BLOCK_RAY_STEP) * BLOCK_RAY_STEP
            hit = full & (power > 0.0) & inside
            marked[where[hit, 0], where[hit, 1], where[hit, 2]] = True
            power = power - BLOCK_RAY_DECAY
            if (power <= 0.0).all():
                break
        for ix, iy, iz in np.argwhere(marked).tolist():
            world.set(int(corner[0]) + ix, int(corner[1]) + iy, int(corner[2]) + iz, B.AIR, env)

    def hurt(
        self, env: np.ndarray, slot: np.ndarray, raw: np.ndarray, by_player: bool = True, armor: bool = True
    ) -> tuple[np.ndarray, np.ndarray]:
        """Damage mobs through the hurt window. Return health removed and which hits opened it."""
        dealt = np.zeros(len(env))
        fresh = np.zeros(len(env), dtype=bool)
        in_window = self.hurt_timer[env, slot] > 0
        effective = np.where(in_window, raw - self.last_damage[env, slot], raw)
        go = effective > 0.0
        if not go.any():
            return dealt, fresh
        e, s = env[go], slot[go]
        self.last_damage[e, s] = raw[go]
        opened = ~in_window[go]
        self.hurt_timer[e[opened], s[opened]] = C.HURT_TICKS
        kind = self.kind[e, s]
        amount = effective[go]
        if armor:
            amount = CB.armor_scale(amount, ARMOR[kind], np.zeros(len(e)))
        removed = np.minimum(amount, self.hp[e, s])
        self.hp[e, s] -= removed
        dealt[go] = removed
        fresh[go] = opened
        if by_player:
            np.add.at(self.damage_done, e, removed)
            np.add.at(self.damage_fraction, e, removed / HEALTH[kind])
            self.targeting[e, s] = True
            calm = kind == ENDERMAN
            self.provoked[e[calm], s[calm]] = True
        dead = self.hp[e, s] <= 0.0
        if dead.any():
            self.alive[e[dead], s[dead]] = False
            if by_player:
                np.add.at(self.kills, e[dead], 1)
        return dealt, fresh

    def player_melee(self, attack: np.ndarray) -> None:
        """Resolve the swings of the players in seat 0 against their mobs."""
        if not attack.any():
            return
        sim = self.sim
        combat = sim.combat
        events = sim.events
        charge = combat.charge()[:, 0]
        multiplier = 0.2 + 0.8 * charge * charge
        charged = charge > CB.CHARGE_GATE
        aimed, who = self.aim(C.ATTACK_REACH)
        lands = attack & aimed
        sprinting = sim.sprinting[:, 0]
        sprint_hit = lands & sprinting & charged
        falling = (combat.fall_distance[:, 0] > 0.0) & ~sim.on_ground[:, 0] & ~combat.no_crit[:, 0]
        crit = lands & charged & falling & ~sprinting
        base = combat._pick(combat.weapon_damage)[:, 0]
        if combat._effects_live:
            base = base + 3.0 * (combat.effect_amp[:, 0, I.STRENGTH] + 1)
        raw = base * multiplier * np.where(crit, C.CRIT_MULTIPLIER, 1.0)
        raw = raw + combat._pick(combat.weapon_sharpness)[:, 0] * charge

        events["swings"][:, 0] += attack
        events["weak_swings"][:, 0] += attack & ~charged
        sim.attack_ticks[attack, 0] = 0.0
        env = np.flatnonzero(lands)
        if len(env) == 0:
            return
        slot = who[env]
        dealt, fresh = self.hurt(env, slot, raw[env])
        applied = dealt > 0.0
        events["hits"][env, 0] += applied
        events["crits"][env, 0] += crit[env] & applied
        events["sprint_hits"][env, 0] += sprint_hit[env] & applied
        events["damage_dealt"][env, 0] += dealt
        events["damage_taken"][env, 1] += dealt
        events["followup_damage"][env, 0] += dealt * (sim.followup[env, 0] > 0)
        if fresh.any():
            e, s = env[fresh], slot[fresh]
            away = self.pos[e, s] - sim.pos[e, 0]
            length = np.maximum(np.hypot(away[:, 0], away[:, 2]), 1e-6)
            self.knock(e, s, away[:, 0] / length, away[:, 2] / length, C.BASE_KNOCKBACK)
            bonus = sprint_hit[e]
            level = combat._t_knockback[combat.kit_id[e, 0]]
            strength = bonus * C.SPRINT_KNOCKBACK_BONUS + level * C.KNOCKBACK_ENCHANT_STRENGTH
            if (strength > 0.0).any():
                yaw = np.radians(sim.yaw[e, 0])
                self.knock(e, s, -np.sin(yaw), np.cos(yaw), strength)
        pushed = env[sprint_hit[env] & applied]
        if len(pushed):
            sim.sprinting[pushed, 0] = False
            if sim.cfg.client_model == "vanilla":
                sim.vel[pushed, 0, 0] *= C.ATTACKER_SLOWDOWN
                sim.vel[pushed, 0, 2] *= C.ATTACKER_SLOWDOWN
        hit_env = env[applied]
        if len(hit_env):
            combat._wear_weapon(hit_env, 0)
            if sim.cfg.hunger:
                combat.exhaustion[hit_env, 0] += CB.EXHAUST_ATTACK

    def catch_arrows(self) -> None:
        """Resolve arrows that reach a mob during this tick.

        Player arrows can hit any mob. A skeleton arrow can hit any mob but the
        skeleton that shot it, unless the player stands earlier on its path.
        """
        sim = self.sim
        env, slot = np.nonzero(sim.arrow_on & ((sim.arrow_owner == 0) | (sim.arrow_owner == 1)))
        if len(env) == 0:
            return
        keep = self.alive[env].any(axis=1)
        env, slot = env[keep], slot[keep]
        if len(env) == 0:
            return
        start = sim.arrow_pos[env, slot]
        vel = sim.arrow_vel[env, slot]
        if sim.world is None:
            block_at = arrows._arena_contact(sim, start, vel, env)
        else:
            block_at = arrows._world_contact(sim, env, slot, start, vel)
        margin = arrows.hit_margin(sim.arrow_age[env, slot] + 1)[:, None]
        low_all, high_all = self.boxes()
        best = np.full(len(env), np.inf)
        who = np.zeros(len(env), dtype=np.int64)
        from_mob = sim.arrow_owner[env, slot] == 1
        shooter = np.where(from_mob, self.shooter[env, slot], -1)
        for mob in range(self.m):
            live = self.alive[env, mob] & (shooter != mob)
            if not live.any():
                continue
            fraction = arrows.entry_fraction(start, vel, low_all[env, mob] - margin, high_all[env, mob] + margin)
            fraction = np.where(live, fraction, np.inf)
            closer = fraction < best
            best[closer] = fraction[closer]
            who[closer] = mob
        struck = np.isfinite(best) & (best <= block_at)
        if from_mob.any():
            low, high = sim.boxes()
            player = arrows.entry_fraction(start, vel, low[env, 0] - margin, high[env, 0] + margin)
            struck &= ~(from_mob & (sim.hp[env, 0] > 0.0) & (player <= best))
        for i in np.flatnonzero(struck).tolist():
            self._arrow_hit(int(env[i]), int(slot[i]), int(who[i]))

    def _arrow_hit(self, env: int, arrow: int, mob: int) -> None:
        sim = self.sim
        if not self.alive[env, mob]:
            return
        by_player = int(sim.arrow_owner[env, arrow]) == 0
        if self.kind[env, mob] == ENDERMAN:
            if by_player:
                self.provoked[env, mob] = True
                self.targeting[env, mob] = True
            for _ in range(TELEPORT_TRIES):
                if self.teleport(env, mob, tries=1):
                    break
            return
        vel = sim.arrow_vel[env, arrow].copy()
        speed = float(np.linalg.norm(vel))
        base = float(np.ceil(sim.arrow_damage[env, arrow] * speed))
        extra = int(sim.rng.integers(0, int(base // 2) + 2)) if sim.arrow_crit[env, arrow] else 0
        dealt, fresh = self.hurt(np.array([env]), np.array([mob]), np.array([base + extra]), by_player=by_player)
        if dealt[0] <= 0.0:
            sim.arrow_vel[env, arrow] = vel * arrows.DEFLECT_FACTOR
            sim.arrow_bounced[env, arrow] = True
            return
        sim.arrow_on[env, arrow] = False
        if by_player:
            sim.events["arrow_hits"][env, 0] += 1.0
            sim.events["damage_dealt"][env, 0] += dealt[0]
            sim.events["damage_taken"][env, 1] += dealt[0]
        if fresh[0]:
            flat = max(float(np.hypot(vel[0], vel[2])), 1e-6)
            self.knock(
                np.array([env]), np.array([mob]), np.array([vel[0] / flat]), np.array([vel[2] / flat]),
                C.BASE_KNOCKBACK,
            )

    def teleport(self, env: int, slot: int, tries: int = TELEPORT_TRIES) -> bool:
        """Move an enderman to a random free spot. Return whether it landed."""
        rng = self.sim.rng
        here = self.pos[env, slot]
        for _ in range(tries):
            x = float(here[0] + (rng.random() - 0.5) * TELEPORT_SPREAD)
            y = float(here[1] + rng.integers(-TELEPORT_DROP, TELEPORT_DROP))
            z = float(here[2] + (rng.random() - 0.5) * TELEPORT_SPREAD)
            if self._land(env, slot, x, y, z):
                return True
        return False

    def teleport_toward(self, env: int, slot: int) -> bool:
        """Jump an enderman about 16 blocks toward the player. Return whether it landed."""
        sim = self.sim
        rng = sim.rng
        here = self.pos[env, slot]
        kind = int(self.kind[env, slot])
        eye = sim.eyes()[env, 0]
        away = np.array([here[0] - eye[0], here[1] + HEIGHT[kind] / 2.0 - eye[1], here[2] - eye[2]])
        away /= max(float(np.linalg.norm(away)), 1e-6)
        x = float(here[0] + (rng.random() - 0.5) * TOWARD_SPREAD - away[0] * TOWARD_DISTANCE)
        y = float(here[1] + rng.integers(-TOWARD_DROP, TOWARD_DROP) - away[1] * TOWARD_DISTANCE)
        z = float(here[2] + (rng.random() - 0.5) * TOWARD_SPREAD - away[2] * TOWARD_DISTANCE)
        return self._land(env, slot, x, y, z)

    def _land(self, env: int, slot: int, x: float, y: float, z: float) -> bool:
        """Place a mob at a spot if it is free. Return whether it landed."""
        sim = self.sim
        kind = int(self.kind[env, slot])
        half = WIDTH[kind] / 2.0
        if sim.world is None:
            limit = sim.cfg.arena_half - half
            if abs(x) > limit or abs(z) > limit:
                return False
            y = 0.0
        else:
            found = self._landing_height(env, x, y, z, half, HEIGHT[kind])
            if found is None:
                return False
            y = found
        self.pos[env, slot] = (x, y, z)
        self.vel[env, slot] = 0.0
        self.on_ground[env, slot] = True
        self.swell[env, slot] = 0
        return True

    def _landing_height(
        self, env: int, x: float, y: float, z: float, half: float, height: float
    ) -> float | None:
        world = self.sim.world
        base = world.base
        margin = half + 1.0
        if not (margin <= x < base.nx - margin and margin <= z < base.nz - margin):
            return None
        cx, cz = int(np.floor(x)), int(np.floor(z))
        cy = int(np.clip(np.floor(y), B.Y_MIN + 1, B.Y_MAX - 4))
        while cy > B.Y_MIN and not SOLID[world.block(cx, cy, cz, env)]:
            cy -= 1
        if not SOLID[world.block(cx, cy, cz, env)]:
            return None
        floor = cy + 1
        top = int(np.ceil(floor + height))
        for px, pz in ((x - half, z - half), (x - half, z + half), (x + half, z - half), (x + half, z + half)):
            ix, iz = int(np.floor(px)), int(np.floor(pz))
            for iy in range(floor, top):
                block = world.block(ix, iy, iz, env)
                if SOLID[block] or block in (B.WATER, B.LAVA):
                    return None
        return float(floor)

    def _surroundings(self) -> None:
        """Apply water to endermen and sunlight to zombies and skeletons."""
        sim = self.sim
        wet = None
        if sim.world is not None and sim.world.config.fluids:
            found = sim.world.fluid_box_many(self.pos, WIDTH[self.kind], HEIGHT[self.kind], EYE[self.kind])
            wet = found["in_water"] & self.alive
            soaked = wet & (self.kind == ENDERMAN)
            if soaked.any():
                self._water_damage(*np.nonzero(soaked))
        if self.cfg.daylight:
            self._sunburn(wet)
        burning = self.alive & (self.fire > 0)
        if burning.any():
            env, slot = np.nonzero(burning)
            due = self.fire[env, slot] % BURN_PERIOD == 0
            if due.any():
                self.hurt(env[due], slot[due], np.full(int(due.sum()), BURN_DAMAGE), by_player=False, armor=False)
            self.fire[env, slot] -= 1

    def _water_damage(self, env: np.ndarray, slot: np.ndarray) -> None:
        dealt, _ = self.hurt(env, slot, np.full(len(env), WATER_DAMAGE), by_player=False, armor=False)
        rng = self.sim.rng
        for i in np.flatnonzero(dealt > 0.0).tolist():
            if self.alive[env[i], slot[i]] and rng.random() < WATER_TELEPORT_CHANCE:
                self.teleport(int(env[i]), int(slot[i]))

    def _sunburn(self, wet: np.ndarray | None) -> None:
        sim = self.sim
        undead = self.alive & ((self.kind == ZOMBIE) | (self.kind == SKELETON))
        if wet is not None:
            undead &= ~wet
            self.fire[wet] = 0
        if not undead.any():
            return
        if sim.world is not None:
            start = self.pos.copy()
            start[..., 1] += EYE[self.kind]
            up = np.zeros((self.n, self.m, 3))
            up[..., 1] = 1.0
            hit, _, _, _ = sim.world.ray_block_many(start, up, 64.0)
            undead &= ~hit
        self.fire[undead] = np.maximum(self.fire[undead], BURN_TICKS)


def _push_amount(dx: np.ndarray, dz: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return the push along a gap, using the larger axis offset."""
    largest = np.maximum(np.abs(dx), np.abs(dz))
    valid = largest >= M.PUSH_MIN_AXIS
    root = np.sqrt(np.where(valid, largest, 1.0))
    scale = np.minimum(1.0, 1.0 / root) / root * M.PUSH_STRENGTH * valid
    return dx * scale, dz * scale


class MobSim(Sim):
    """A simulator where seat 0 fights mobs and seat 1 shows the nearest one."""

    def __init__(
        self,
        n: int,
        config=None,
        seed: int = 0,
        profile: str | None = None,
        mobs: MobConfig | None = None,
    ):
        self.mob_config = mobs or MobConfig()
        self.mobs: Mobs | None = None
        super().__init__(n, config, seed=seed, profile=profile)
        self._seat_idle = None

    def reset(self, mask: np.ndarray | None = None) -> None:
        """Respawn the selected arenas with no mobs in them."""
        super().reset(mask)
        if self.mobs is None:
            self.mobs = Mobs(self, self.mob_config)
        chosen = np.ones(self.n, dtype=bool) if mask is None else mask
        idx = np.flatnonzero(chosen)
        self.mobs.clear(idx)
        self._park_seat()
        self.show_focus()

    def _park_height(self) -> float:
        return PARK_HEIGHT if self.world is None else float(B.Y_MAX - 8)

    def _park_seat(self) -> None:
        """Hold seat 1 out of play so it cannot touch anything during a tick."""
        self.pos[:, 1, 0] = self.origin[0]
        self.pos[:, 1, 1] = self._park_height()
        self.pos[:, 1, 2] = self.origin[2]
        self.vel[:, 1] = 0.0
        self.hp[:, 1] = C.MAX_HEALTH
        self.weapon[:, 1] = C.SWORD
        self.draw_ticks[:, 1] = 0
        self.sprinting[:, 1] = False
        self.on_ground[:, 1] = True
        self.combat.fall_distance[:, 1] = 0.0

    def show_focus(self) -> None:
        """Write the nearest living mob into seat 1 for the shared observation."""
        mobs = self.mobs
        slot, present = mobs.nearest()
        rows = np.arange(self.n)
        self.pos[:, 1] = mobs.pos[rows, slot]
        self.vel[:, 1] = mobs.vel[rows, slot]
        self.yaw[:, 1] = mobs.yaw[rows, slot]
        self.pitch[:, 1] = 0.0
        kind = mobs.kind[rows, slot]
        share = mobs.hp[rows, slot] / HEALTH[kind]
        self.hp[:, 1] = np.where(present, share * C.MAX_HEALTH, 0.0)
        self.hurt_timer[:, 1] = mobs.hurt_timer[rows, slot]
        self.on_ground[:, 1] = mobs.on_ground[rows, slot]
        self.sprinting[:, 1] = False
        self.weapon[:, 1] = np.where(present & (kind == SKELETON), C.BOW, C.SWORD)
        self.draw_ticks[:, 1] = mobs.draw[rows, slot] * (present & (kind == SKELETON))
        mobs.update_seen()
        if self.world is not None:
            self.perception.refresh()

    def aim_hits(self, reach: float = C.ATTACK_REACH) -> np.ndarray:
        """Return which view rays meet a target, with seat 0 aiming at the mobs."""
        out = super().aim_hits(reach)
        out[:, 0] = self.mobs.aim(reach)[0]
        return out

    def step(self, actions: np.ndarray) -> dict[str, np.ndarray]:
        """Advance one decision. Any action given for seat 1 is ignored."""
        from . import actions as A

        joined = np.array(actions, copy=True)
        joined[:, 1] = A.neutral_actions(np.full(self.n, C.SWORD))
        self._park_seat()
        events = super().step(joined)
        self.show_focus()
        return events

    def _melee(self, attack: np.ndarray) -> None:
        self.mobs.player_melee(attack[:, 0])

    def arrow_hit_damage(self, raw: np.ndarray, env: np.ndarray, slot: np.ndarray | int) -> np.ndarray:
        """Scale mob arrows by difficulty after rounding, as for any mob damage."""
        shot = self.arrow_owner[env, slot] == 1
        return np.where(shot, difficulty_scale(raw, self.mob_config.difficulty), raw)

    def _step_arrows(self) -> None:
        self.mobs.catch_arrows()
        super()._step_arrows()

    def _advance_timers(self) -> None:
        super()._advance_timers()
        self.mobs.tick()
        self._park_seat()


__all__ = [
    "CREEPER",
    "ENDERMAN",
    "KIND_NAMES",
    "NO_MOB",
    "NUM_MOB_KINDS",
    "SKELETON",
    "ZOMBIE",
    "MobConfig",
    "MobSim",
    "Mobs",
    "blast_damage",
    "difficulty_scale",
]
