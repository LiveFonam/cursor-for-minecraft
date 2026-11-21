"""Vectorized simulator of 1 versus 1 Minecraft Java combat.

Every array has a batch axis first. Player arrays have shape (n, 2, ...), one
row per arena and one column per seat. SIM_NOTES.md explains each mechanic.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import actions as A
from . import constants as C

EVENT_NAMES = (
    "damage_dealt",
    "damage_taken",
    "swings",
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
)
MAX_ARROWS = 6
FOLLOWUP_TICKS = 40


@dataclass
class SimConfig:
    """Arena and loadout settings."""

    armor: str = "iron"
    arena_half: float = C.ARENA_HALF_WIDTH
    spawn_min: float = 4.0
    spawn_max: float = 10.0
    face_noise_deg: float = 60.0


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

    def __init__(self, n: int, config: SimConfig | None = None, seed: int = 0):
        self.n = n
        self.cfg = config or SimConfig()
        self.rng = np.random.default_rng(seed)
        self.armor, self.toughness = C.ARMOR_SETS[self.cfg.armor]
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
        self.arrow_on = np.zeros((n, MAX_ARROWS), dtype=bool)
        self.arrow_pos = np.zeros((n, MAX_ARROWS, 3))
        self.arrow_vel = np.zeros((n, MAX_ARROWS, 3))
        self.arrow_owner = np.zeros((n, MAX_ARROWS), dtype=np.int64)
        self.arrow_crit = np.zeros((n, MAX_ARROWS), dtype=bool)
        self.ticks = np.zeros(n, dtype=np.int64)
        self.events = {name: np.zeros((n, 2)) for name in EVENT_NAMES}
        self.reset()

    def reset(self, mask: np.ndarray | None = None) -> None:
        """Respawn the selected arenas, or all arenas when mask is None."""
        if mask is None:
            mask = np.ones(self.n, dtype=bool)
        idx = np.flatnonzero(mask)
        k = len(idx)
        if k == 0:
            return
        cfg = self.cfg
        margin = cfg.spawn_max / 2.0 + 0.5
        room = max(cfg.arena_half - margin, 0.0)
        center = self.rng.uniform(-room, room, size=(k, 2))
        distance = self.rng.uniform(cfg.spawn_min, cfg.spawn_max, size=k)
        angle = self.rng.uniform(0.0, 2.0 * np.pi, size=k)
        offset = np.stack([np.cos(angle), np.sin(angle)], axis=-1) * (distance / 2.0)[:, None]
        for seat, sign in ((0, -1.0), (1, 1.0)):
            xz = center + sign * offset
            self.pos[idx, seat, 0] = xz[:, 0]
            self.pos[idx, seat, 1] = 0.0
            self.pos[idx, seat, 2] = xz[:, 1]
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
        self.shield_disabled[idx] = 0
        self.draw_ticks[idx] = 0
        self.load_ticks[idx] = 0
        self.loaded[idx] = False
        self.load_wait[idx] = False
        self.use_prev[idx] = False
        self.followup[idx] = 0
        self.arrow_on[idx] = False
        self.ticks[idx] = 0

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
        return eyes

    def boxes(self) -> tuple[np.ndarray, np.ndarray]:
        """Return player hitbox corners."""
        half = C.PLAYER_WIDTH / 2.0
        low = self.pos + np.array([-half, 0.0, -half])
        high = self.pos + np.array([half, C.PLAYER_HEIGHT, half])
        return low, high

    def aim_hits(self, reach: float = C.ATTACK_REACH) -> np.ndarray:
        """Return which players' view rays meet the other hitbox within reach."""
        low, high = self.boxes()
        return ray_box(self.eyes(), self.look(), low[:, ::-1], high[:, ::-1], reach)

    def attack_multiplier(self) -> np.ndarray:
        """Return the current melee damage multiplier of each player."""
        return cooldown_multiplier(self.attack_ticks, C.WEAPON_ATTACK_SPEED[self.weapon])

    def step(self, actions: np.ndarray) -> dict[str, np.ndarray]:
        """Advance one decision and return summed events of shape (n, 2)."""
        for values in self.events.values():
            values.fill(0.0)
        for tick in range(C.TICKS_PER_DECISION):
            self._tick(actions, first=tick == 0)
        return self.events

    def _tick(self, a: np.ndarray, first: bool) -> None:
        self.yaw += A.YAW_DELTAS[a[..., A.YAW]] / C.TICKS_PER_DECISION
        self.yaw = (self.yaw + 180.0) % 360.0 - 180.0
        self.pitch = np.clip(
            self.pitch + A.PITCH_DELTAS[a[..., A.PITCH]] / C.TICKS_PER_DECISION, -90.0, 90.0
        )
        self._switch_weapons(a[..., A.WEAPON])
        using = self._use_items(a[..., A.USE] == 1)
        if first:
            self._melee(a[..., A.ATTACK] == 1)
        self._move(a, using)
        self._step_arrows()
        self._advance_timers()

    def _switch_weapons(self, wanted: np.ndarray) -> None:
        changed = wanted != self.weapon
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
        can_block = melee & use & (self.shield_disabled == 0)
        self.shield_ticks = np.where(can_block, self.shield_ticks + 1, 0)

        holding_bow = self.weapon == C.BOW
        released = holding_bow & ~use & (self.draw_ticks >= C.BOW_MIN_DRAW_TICKS)
        if released.any():
            speed = bow_speed(self.draw_ticks.astype(float))
            crit = self.draw_ticks >= C.BOW_FULL_DRAW_TICKS
            self._fire(released, speed, crit)
        self.draw_ticks = np.where(holding_bow & use, self.draw_ticks + 1, 0)

        holding_crossbow = self.weapon == C.CROSSBOW
        rising = use & ~self.use_prev
        fire = holding_crossbow & rising & self.loaded
        if fire.any():
            self._fire(fire, np.full(fire.shape, C.CROSSBOW_SPEED), np.ones(fire.shape, bool))
            self.loaded[fire] = False
            self.load_wait[fire] = True
        self.load_wait &= use
        loading = holding_crossbow & use & ~self.loaded & ~self.load_wait
        self.load_ticks = np.where(loading, self.load_ticks + 1, 0)
        done = self.load_ticks >= C.CROSSBOW_LOAD_TICKS
        if done.any():
            self.loaded[done] = True
            self.load_wait[done] = True
            self.load_ticks[done] = 0
        self.use_prev = use.copy()
        return can_block | (holding_bow & use) | loading

    def _fire(self, mask: np.ndarray, speed: np.ndarray, crit: np.ndarray) -> None:
        look = self.look()
        eyes = self.eyes()
        for env, seat in zip(*np.nonzero(mask)):
            free = np.flatnonzero(~self.arrow_on[env])
            if len(free) == 0:
                continue
            slot = free[0]
            self.arrow_on[env, slot] = True
            self.arrow_pos[env, slot] = eyes[env, seat]
            self.arrow_vel[env, slot] = look[env, seat] * speed[env, seat]
            self.arrow_owner[env, slot] = seat
            self.arrow_crit[env, slot] = crit[env, seat]
            self.events["arrows_fired"][env, seat] += 1.0

    def _melee(self, attack: np.ndarray) -> None:
        if not attack.any():
            return
        multiplier = self.attack_multiplier()
        charged = multiplier >= C.FULL_CHARGE_THRESHOLD
        lands = attack & self.aim_hits()
        sprint_hit = lands & self.sprinting & charged
        falling = (self.vel[..., 1] < 0.0) & ~self.on_ground
        crit = lands & charged & falling & ~self.sprinting
        raw = C.WEAPON_DAMAGE[self.weapon] * multiplier * np.where(crit, C.CRIT_MULTIPLIER, 1.0)
        kb = C.BASE_KNOCKBACK + np.where(sprint_hit, C.SPRINT_KNOCKBACK_BONUS, 0.0)
        yaw_rad = np.radians(self.yaw)
        push = np.stack([-np.sin(yaw_rad), np.cos(yaw_rad)], axis=-1)
        to_attacker = self.pos[:, ::-1] - self.pos
        victim_look = look_vectors(self.yaw, np.zeros_like(self.pitch))
        front = (victim_look[..., 0] * to_attacker[..., 0]
                 + victim_look[..., 2] * to_attacker[..., 2]) > 0.0
        guarded = self.shield_active & front
        blocked = lands & guarded[:, ::-1]
        breaks = blocked & (self.weapon == C.AXE)

        self.events["swings"] += attack
        self.events["hits"] += lands & ~blocked
        self.events["crits"] += crit & ~blocked
        self.events["sprint_hits"] += sprint_hit & ~blocked
        self.events["melee_blocked"] += blocked
        self.events["shield_breaks"] += breaks

        self.attack_ticks[attack] = 0.0
        slowed = sprint_hit & ~blocked
        self.vel[slowed, 0] *= C.ATTACKER_SLOWDOWN
        self.vel[slowed, 2] *= C.ATTACKER_SLOWDOWN
        self.sprinting[lands] = False

        for attacker in (0, 1):
            victim = 1 - attacker
            broke = breaks[:, attacker]
            self.shield_disabled[broke, victim] = C.SHIELD_DISABLE_TICKS
            self.shield_ticks[broke, victim] = 0
            self.followup[broke, attacker] = FOLLOWUP_TICKS
            hit = lands[:, attacker] & ~blocked[:, attacker]
            dealt = self._hurt(hit, victim, raw[:, attacker], push[:, attacker], kb[:, attacker])
            self.events["damage_dealt"][:, attacker] += dealt
            self.events["damage_taken"][:, victim] += dealt
            self.events["followup_damage"][:, attacker] += dealt * (self.followup[:, attacker] > 0)

    def _hurt(
        self,
        mask: np.ndarray,
        victim: int,
        raw: np.ndarray,
        direction: np.ndarray,
        knockback: np.ndarray,
    ) -> np.ndarray:
        """Apply damage with the hurt window and return health removed."""
        dealt = np.zeros(self.n)
        if not mask.any():
            return dealt
        in_window = self.hurt_timer[:, victim] > 0
        amount = np.where(in_window, raw - self.last_damage[:, victim], raw)
        lands = mask & (amount > 0.0)
        if not lands.any():
            return dealt
        reduced = armor_reduce(amount, self.armor, self.toughness)
        dealt[lands] = np.minimum(reduced[lands], self.hp[lands, victim])
        self.hp[lands, victim] -= dealt[lands]
        self.last_damage[lands, victim] = raw[lands]
        fresh = lands & ~in_window
        self.hurt_timer[fresh, victim] = C.HURT_TICKS
        if fresh.any():
            vel = self.vel[fresh, victim]
            vel[:, 0] = vel[:, 0] * 0.5 + direction[fresh, 0] * knockback[fresh]
            vel[:, 2] = vel[:, 2] * 0.5 + direction[fresh, 1] * knockback[fresh]
            grounded = self.on_ground[fresh, victim]
            vel[grounded, 1] = np.minimum(
                vel[grounded, 1] * 0.5 + C.BASE_KNOCKBACK, C.KNOCKBACK_VERTICAL_CAP
            )
            self.vel[fresh, victim] = vel
            self.on_ground[fresh, victim] &= ~grounded
        return dealt

    def _move(self, a: np.ndarray, using: np.ndarray) -> None:
        forward = A.FORWARD_VALUES[a[..., A.FORWARD]]
        strafe = A.STRAFE_VALUES[a[..., A.STRAFE]]
        wants_sprint = (a[..., A.SPRINT] == 1) & (forward > 0.0) & ~using
        start = wants_sprint & ~self.sprint_held
        self.sprinting = (self.sprinting | start) & wants_sprint
        self.sprint_held = wants_sprint

        grounded = self.on_ground.copy()
        ground_accel = C.MOVEMENT_SPEED * np.where(self.sprinting, C.SPRINT_MULTIPLIER, 1.0)
        air_accel = np.where(self.sprinting, C.AIR_ACCEL_SPRINT, C.AIR_ACCEL)
        accel = np.where(grounded, ground_accel, air_accel)

        move_f = forward * C.INPUT_SCALE
        move_s = strafe * C.INPUT_SCALE
        if using.any():
            move_f = np.where(using, move_f * C.SNEAK_MULTIPLIER, move_f)
            move_s = np.where(using, move_s * C.SNEAK_MULTIPLIER, move_s)
        length = np.sqrt(move_f * move_f + move_s * move_s)
        scale = np.where(length > 1.0, 1.0 / np.maximum(length, 1e-9), 1.0)
        move_f = move_f * scale * accel
        move_s = move_s * scale * accel

        yaw_rad = np.radians(self.yaw)
        sin_y = np.sin(yaw_rad)
        cos_y = np.cos(yaw_rad)
        self.vel[..., 0] += -sin_y * move_f - cos_y * move_s
        self.vel[..., 2] += cos_y * move_f - sin_y * move_s

        jumping = (a[..., A.JUMP] == 1) & grounded
        if jumping.any():
            self.vel[..., 1] = np.where(jumping, C.JUMP_VELOCITY, self.vel[..., 1])
            boost = jumping & self.sprinting
            self.vel[..., 0] -= boost * sin_y * C.SPRINT_JUMP_BOOST
            self.vel[..., 2] += boost * cos_y * C.SPRINT_JUMP_BOOST

        self._push_apart()
        self.pos += self.vel

        below = self.pos[..., 1] <= 0.0
        landed = below & (self.vel[..., 1] <= 0.0)
        self.pos[..., 1] = np.maximum(self.pos[..., 1], 0.0)
        self.vel[..., 1] = np.where(landed, 0.0, self.vel[..., 1])
        self.on_ground = landed

        limit = self.cfg.arena_half - C.PLAYER_WIDTH / 2.0
        for axis in (0, 2):
            over = np.abs(self.pos[..., axis]) > limit
            if over.any():
                self.pos[..., axis] = np.clip(self.pos[..., axis], -limit, limit)
                self.vel[..., axis] = np.where(over, 0.0, self.vel[..., axis])
                self.sprinting &= ~over

        airborne = ~self.on_ground
        self.vel[..., 1] = np.where(
            airborne, (self.vel[..., 1] - C.GRAVITY) * C.VERTICAL_DRAG, self.vel[..., 1]
        )
        drag = np.where(grounded, C.GROUND_DRAG, C.AIR_DRAG)
        self.vel[..., 0] *= drag
        self.vel[..., 2] *= drag

    def _push_apart(self) -> None:
        delta = self.pos[:, 1] - self.pos[:, 0]
        dist = np.hypot(delta[:, 0], delta[:, 2])
        close = dist < C.PLAYER_WIDTH
        if not close.any():
            return
        safe = np.maximum(dist[close], 1e-3)
        push_x = delta[close, 0] / safe * 0.05
        push_z = delta[close, 2] / safe * 0.05
        self.vel[close, 0, 0] -= push_x
        self.vel[close, 0, 2] -= push_z
        self.vel[close, 1, 0] += push_x
        self.vel[close, 1, 2] += push_z

    def _step_arrows(self) -> None:
        if not self.arrow_on.any():
            return
        low, high = self.boxes()
        pad = np.array([C.ARROW_HALF_SIZE] * 3)
        view = look_vectors(self.yaw, np.zeros_like(self.pitch))
        for slot in range(MAX_ARROWS):
            live = self.arrow_on[:, slot]
            if not live.any():
                continue
            idx = np.flatnonzero(live)
            owner = self.arrow_owner[idx, slot]
            victim = 1 - owner
            start = self.arrow_pos[idx, slot]
            vel = self.arrow_vel[idx, slot]
            box_low = low[idx, victim] - pad
            box_high = high[idx, victim] + pad
            hit = ray_box(start, vel, box_low, box_high, 1.0)
            if hit.any():
                self._arrow_impact(idx[hit], slot, owner[hit], victim[hit], vel[hit], view)
            end = start + vel
            limit = self.cfg.arena_half
            gone = hit | (end[:, 1] <= 0.0) | (np.abs(end[:, 0]) > limit) | (np.abs(end[:, 2]) > limit)
            self.arrow_on[idx[gone], slot] = False
            keep = ~gone
            kept = idx[keep]
            new_vel = vel[keep] * C.ARROW_DRAG
            new_vel[:, 1] -= C.ARROW_GRAVITY
            self.arrow_pos[kept, slot] = end[keep]
            self.arrow_vel[kept, slot] = new_vel

    def _arrow_impact(
        self,
        idx: np.ndarray,
        slot: int,
        owner: np.ndarray,
        victim: np.ndarray,
        vel: np.ndarray,
        view: np.ndarray,
    ) -> None:
        speed = np.linalg.norm(vel, axis=-1)
        base = np.ceil(C.ARROW_BASE_DAMAGE * speed)
        crit = self.arrow_crit[idx, slot]
        extra = self.rng.integers(0, np.floor(base / 2.0).astype(np.int64) + 2)
        raw = base + extra * crit
        facing = view[idx, victim]
        front = facing[:, 0] * -vel[:, 0] + facing[:, 2] * -vel[:, 2] > 0.0
        blocked = self.shield_active[idx, victim] & front
        self.events["arrows_blocked"][idx[blocked], victim[blocked]] += 1.0
        hit = ~blocked
        if not hit.any():
            return
        hit_idx = idx[hit]
        hit_owner = owner[hit]
        hit_victim = victim[hit]
        horizontal = np.maximum(np.hypot(vel[hit, 0], vel[hit, 2]), 1e-6)
        for seat in (0, 1):
            pick = hit_victim == seat
            if not pick.any():
                continue
            mask = np.zeros(self.n, dtype=bool)
            mask[hit_idx[pick]] = True
            full_raw = np.zeros(self.n)
            full_raw[hit_idx[pick]] = raw[hit][pick]
            direction = np.zeros((self.n, 2))
            direction[hit_idx[pick], 0] = vel[hit, 0][pick] / horizontal[pick]
            direction[hit_idx[pick], 1] = vel[hit, 2][pick] / horizontal[pick]
            knockback = np.full(self.n, C.BASE_KNOCKBACK)
            dealt = self._hurt(mask, seat, full_raw, direction, knockback)
            self.events["damage_taken"][:, seat] += dealt
            self.events["damage_dealt"][:, 1 - seat] += dealt
            self.events["arrow_hits"][:, 1 - seat] += mask
            self.events["arrows_taken"][:, seat] += mask
            self.events["followup_damage"][:, 1 - seat] += dealt * (self.followup[:, 1 - seat] > 0)

    def _advance_timers(self) -> None:
        self.attack_ticks += 1.0
        self.hurt_timer = np.maximum(self.hurt_timer - 1, 0)
        self.shield_disabled = np.maximum(self.shield_disabled - 1, 0)
        self.followup = np.maximum(self.followup - 1, 0)
        self.ticks += 1
