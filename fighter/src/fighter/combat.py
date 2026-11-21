"""Melee, damage, knockback, shields, hunger, effects, fire and falls.

`Combat` holds the per player state that the batch simulator reads and writes.
A hit runs on the server copy of velocity. `knockback_step` is the one place
that computes a push, and `Combat.send_velocity` is the one place that hands
the result to the body.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import constants as C
from . import items as I
from . import movement as M

CHARGE_GATE = 0.9
KNOCKBACK_ENCHANT_STRENGTH = C.KNOCKBACK_ENCHANT_STRENGTH
SHIELD_MIN_DAMAGE = 3.0
TINY_SPEED_SQUARED = 9e-6
JUMP_MIN_SPEED = 0.42
FOLLOWUP_TICKS = 40
DIRECTION_EPSILON = 1e-5

SNEAK_EYE_HEIGHT = M.SNEAK_EYE
SNEAK_HEIGHT = M.SNEAK_HEIGHT
SERVER_REACH = 6.0

SAFE_FALL = C.SAFE_FALL
FALL_EPSILON = C.FALL_EPSILON

FIRE_REST = -20
FIRE_PERIOD = 20
LAVA_DAMAGE = 4.0
LAVA_IGNITE = 300
FIRE_BLOCK_DAMAGE = 1.0
FIRE_BLOCK_IGNITE = 160
BURN_DAMAGE = 1.0
FIRE_ASPECT_TICKS = 80
FIRE_PROTECTION_CUT = 0.15

START_FOOD = 20
START_SATURATION = 5.0
EXHAUSTION_STEP = 4.0
EXHAUST_SPRINT = 0.1
EXHAUST_SWIM = 0.01
EXHAUST_JUMP = 0.05
EXHAUST_SPRINT_JUMP = 0.2
EXHAUST_ATTACK = 0.1
FAST_REGEN_TICKS = 10
SLOW_REGEN_TICKS = 80
SLOW_REGEN_FOOD = 18
SLOW_REGEN_EXHAUSTION = 6.0
STARVE_TICKS = 80

REGEN_PERIOD = 50
POISON_PERIOD = 25
ABSORPTION_PER_LEVEL = 4.0
SPEED_PER_LEVEL = M.SPEED_PER_LEVEL

USES_ARMOR = np.zeros(I.NUM_KINDS, dtype=bool)
USES_ARMOR[[I.MELEE, I.PROJECTILE, I.IN_FIRE, I.LAVA, I.BLAST]] = True
IS_FIRE = np.zeros(I.NUM_KINDS, dtype=bool)
IS_FIRE[[I.IN_FIRE, I.ON_FIRE, I.LAVA]] = True
HURT_EXHAUSTION = np.zeros(I.NUM_KINDS)
HURT_EXHAUSTION[[I.MELEE, I.PROJECTILE, I.IN_FIRE, I.LAVA, I.BLAST]] = 0.1


@dataclass(frozen=True)
class RoundRules:
    """Round length rules, in ticks."""

    no_damage_ticks: int = 1200
    limit_ticks: int = 2400
    overtime_ticks: int = 3600
    overtime_health: float = 6.0


def round_timeout(
    rules: RoundRules, ticks: np.ndarray, last_hit: np.ndarray, hp: np.ndarray
) -> np.ndarray:
    """Return which rounds have run out of time."""
    quiet = ticks - last_hit >= rules.no_damage_ticks
    low = (hp <= rules.overtime_health).all(axis=1)
    limit = np.where(low, rules.overtime_ticks, rules.limit_ticks)
    return quiet | (ticks >= limit)


def fall_damage(distance: np.ndarray) -> np.ndarray:
    """Return whole hit points of damage for a fall distance."""
    return np.maximum(np.floor(distance + FALL_EPSILON - SAFE_FALL), 0.0)


def shield_wear(amount: np.ndarray) -> np.ndarray:
    """Return shield durability spent on blocking an amount of damage."""
    return np.where(amount >= SHIELD_MIN_DAMAGE, 1 + np.floor(amount), 0).astype(np.int64)


def armor_scale(damage: np.ndarray, armor: np.ndarray, toughness: np.ndarray) -> np.ndarray:
    """Return damage after armor points and toughness."""
    effective = np.minimum(
        20.0, np.maximum(armor / 5.0, armor - 4.0 * damage / (np.minimum(toughness, 20.0) + 8.0))
    )
    return damage * (1.0 - effective / 25.0)


def _unit(dx: np.ndarray, dz: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    squared = dx * dx + dz * dz
    length = np.sqrt(np.maximum(squared, 1e-12))
    valid = squared >= DIRECTION_EPSILON
    return np.where(valid, dx / length, 0.0), np.where(valid, dz / length, 0.0)


def _protection_points(kit: I.Kit, live: np.ndarray) -> np.ndarray:
    """Return enchantment protection points per damage kind for the pieces still worn."""
    protection = float((np.array(kit.protection) * live).sum())
    fire = float((np.array(kit.fire_protection) * live).sum())
    blast = float((np.array(kit.blast_protection) * live).sum())
    projectile = float((np.array(kit.projectile_protection) * live).sum())
    feather = float(kit.feather_falling * live[3])
    points = np.full(I.NUM_KINDS, protection)
    points[I.STARVE] = 0.0
    points[IS_FIRE] += 2.0 * fire
    points[I.PROJECTILE] += 2.0 * projectile
    points[I.BLAST] += 2.0 * blast
    points[[I.FALL, I.PEARL_LANDING]] += C.FEATHER_FALLING_POINTS * feather
    return points


class Combat:
    """Per player combat state for a batch of arenas."""

    def __init__(self, sim) -> None:
        n = sim.n
        cfg = sim.cfg
        self.sim = sim
        self.kits = [I.kit_named(name, cfg.armor) for name in (cfg.kits or (None,))]
        self._build_tables()
        self.kit_id = np.zeros((n, 2), dtype=np.int64)
        self.armor = np.zeros((n, 2))
        self.toughness = np.zeros((n, 2))
        self.knockback_resistance = np.zeros((n, 2))
        self.protection = np.zeros((n, 2, I.NUM_KINDS))
        self.fire_levels = np.zeros((n, 2))
        self.armor_left = np.zeros((n, 2, 4), dtype=np.int64)
        self.has_shield = np.ones((n, 2), dtype=bool)
        self.shield_left = np.zeros((n, 2), dtype=np.int64)
        self.weapon_damage = np.zeros((n, 2, C.NUM_WEAPONS))
        self.weapon_speed = np.zeros((n, 2, C.NUM_WEAPONS))
        self.weapon_sharpness = np.zeros((n, 2, C.NUM_WEAPONS))
        self.weapon_left = np.zeros((n, 2, 2), dtype=np.int64)

        self.server_vel = np.zeros((n, 2, 3))
        self.server_ground = np.ones((n, 2), dtype=bool)
        self._lift_pending = np.zeros((n, 2), dtype=bool)
        self._was_ground = np.ones((n, 2), dtype=bool)
        self._was_still = np.ones((n, 2), dtype=bool)
        self.fall_distance = sim.body.fall
        self._last_xz = np.zeros((n, 2, 2))
        self.no_crit = np.zeros((n, 2), dtype=bool)
        self.in_water = np.zeros((n, 2), dtype=bool)
        self.eyes_in_water = np.zeros((n, 2), dtype=bool)
        self.second_click = np.zeros((n, 2), dtype=bool)

        self.absorption = np.zeros((n, 2))
        self.fire = np.full((n, 2), FIRE_REST, dtype=np.int64)
        self.food = np.full((n, 2), START_FOOD, dtype=np.int64)
        self.saturation = np.full((n, 2), START_SATURATION)
        self.exhaustion = np.zeros((n, 2))
        self.food_timer = np.zeros((n, 2), dtype=np.int64)
        self.effect_amp = np.full((n, 2, I.NUM_EFFECTS), -1, dtype=np.int64)
        self.effect_time = np.zeros((n, 2, I.NUM_EFFECTS), dtype=np.int64)
        self.stored_amp = np.full((n, 2, I.NUM_EFFECTS), -1, dtype=np.int64)
        self.stored_time = np.zeros((n, 2, I.NUM_EFFECTS), dtype=np.int64)
        self.last_hit_tick = np.zeros(n, dtype=np.int64)
        self.environment_damage = np.zeros((n, 2))

        self._applied = np.zeros(n, dtype=bool)
        self._copy_sliding = False
        self._uniform_speed = len(self.kits) == 1
        self._effects_live = False
        self._burning = False
        self.has_bow = np.ones((n, 2), dtype=bool)
        self.bow_left = np.full((n, 2), I.BOW_DURABILITY, dtype=np.int64)
        self._none = np.zeros((n, 2), dtype=bool)
        delay = int(cfg.aim_delay)
        self._history = np.zeros((delay, n, 2, 3)) if delay > 0 else None
        self._history_at = 0

    def _build_tables(self) -> None:
        kits = self.kits
        count = len(kits)
        self._t_points = np.array([[I.ARMOR_POINTS[m][i] for i, m in enumerate(k.armor)] for k in kits], float)
        self._t_tough = np.array([[I.ARMOR_TOUGHNESS[m] for m in k.armor] for k in kits])
        self._t_resist = np.array([[I.ARMOR_KNOCKBACK_RESISTANCE[m] for m in k.armor] for k in kits])
        self._t_left = np.array([[I.ARMOR_DURABILITY[m][i] for i, m in enumerate(k.armor)] for k in kits])
        self._t_fire = np.array([k.fire_protection for k in kits], float)
        self._t_protection = np.stack([_protection_points(k, np.ones(4, bool)) for k in kits])
        self._t_shield = np.array([k.shield for k in kits], bool)
        self._t_arrows = np.array([k.arrows for k in kits], np.int64)
        self._t_power = np.array([k.power for k in kits], np.int64)
        self._t_punch = np.array([k.punch for k in kits], np.int64)
        self._t_flame = np.array([k.flame for k in kits], np.int64)
        self._t_unbreaking = np.array([k.unbreaking for k in kits], np.int64)
        self._t_knockback = np.array([k.knockback for k in kits], float)
        self._t_fire_aspect = np.array([k.fire_aspect for k in kits], np.int64)
        self._t_damage = np.full((count, C.NUM_WEAPONS), I.FIST_DAMAGE)
        self._t_speed = np.full((count, C.NUM_WEAPONS), I.FIST_SPEED)
        self._t_sharp = np.zeros((count, C.NUM_WEAPONS))
        self._t_weapon_left = np.zeros((count, 2), np.int64)
        for i, kit in enumerate(kits):
            self._t_damage[i, C.SWORD] = I.SWORDS[kit.sword]
            self._t_damage[i, C.AXE] = I.AXES[kit.axe]
            self._t_speed[i, C.SWORD] = I.SWORD_SPEED if kit.sword != "none" else I.FIST_SPEED
            self._t_speed[i, C.AXE] = I.AXE_SPEED[kit.axe]
            bonus = 0.5 * (kit.sharpness + 1) if kit.sharpness > 0 else 0.0
            self._t_sharp[i, [C.SWORD, C.AXE]] = bonus
            self._t_weapon_left[i] = (I.TOOL_DURABILITY[kit.sword], I.TOOL_DURABILITY[kit.axe])
        self._has_armor = bool(self._t_left.any())
        self._t_weapons = np.zeros((count, C.NUM_WEAPONS), dtype=bool)
        for i, kit in enumerate(kits):
            self._t_weapons[i, C.SWORD] = kit.sword != "none"
            self._t_weapons[i, C.AXE] = kit.axe != "none"
            self._t_weapons[i, [C.BOW, C.CROSSBOW]] = kit.arrows > 0

    def reset(self, idx: np.ndarray) -> None:
        """Restore the selected arenas to round start."""
        sim = self.sim
        cfg = sim.cfg
        k = len(idx)
        if len(self.kits) > 1:
            first = sim.rng.integers(0, len(self.kits), size=k)
            second = first.copy()
            uneven = sim.rng.random(k) < cfg.uneven_rate
            second[uneven] = sim.rng.integers(0, len(self.kits), size=int(uneven.sum()))
            self.kit_id[idx, 0] = first
            self.kit_id[idx, 1] = second
        kit = self.kit_id[idx]
        self.armor[idx] = self._t_points[kit].sum(axis=2)
        self.toughness[idx] = self._t_tough[kit].sum(axis=2)
        self.knockback_resistance[idx] = self._t_resist[kit].sum(axis=2)
        self.protection[idx] = self._t_protection[kit]
        self.fire_levels[idx] = self._t_fire[kit].sum(axis=2)
        self.armor_left[idx] = self._t_left[kit]
        self.has_shield[idx] = self._t_shield[kit]
        self.shield_left[idx] = I.SHIELD_DURABILITY
        self.weapon_damage[idx] = self._t_damage[kit]
        self.weapon_speed[idx] = self._t_speed[kit]
        self.weapon_sharpness[idx] = self._t_sharp[kit]
        self.weapon_left[idx] = self._t_weapon_left[kit]

        self.server_vel[idx] = 0.0
        self.server_vel[idx, :, 1] = -C.GRAVITY * C.VERTICAL_DRAG
        self.server_ground[idx] = True
        self._lift_pending[idx] = False
        self._was_ground[idx] = True
        self._was_still[idx] = True
        self.fall_distance[idx] = 0.0
        self.has_bow[idx] = True
        self.bow_left[idx] = I.BOW_DURABILITY
        self._last_xz[idx] = sim.pos[idx][..., [0, 2]]
        self.no_crit[idx] = False
        self.in_water[idx] = False
        self.eyes_in_water[idx] = False
        self.second_click[idx] = False
        self.absorption[idx] = 0.0
        self.fire[idx] = FIRE_REST
        self.food[idx] = START_FOOD
        self.saturation[idx] = START_SATURATION
        self.exhaustion[idx] = 0.0
        self.food_timer[idx] = 0
        self.effect_amp[idx] = -1
        self.effect_time[idx] = 0
        self.stored_amp[idx] = -1
        self.stored_time[idx] = 0
        self.last_hit_tick[idx] = 0
        self.environment_damage[idx] = 0.0
        if self._history is not None:
            self._history[:, idx] = sim.pos[idx]

    @property
    def sneaking(self) -> np.ndarray:
        """Return the sneak input held by the bodies."""
        return self.sim.body.sneak

    def weapons_held(self, at, seat: int) -> np.ndarray:
        """Return which weapons each selected player's kit contains, shape (arenas, weapons)."""
        return self._t_weapons[self.kit_id[at, seat]]

    def kit_arrows(self, idx: np.ndarray) -> np.ndarray:
        """Return the starting arrows of each player in the selected arenas."""
        return self._t_arrows[self.kit_id[idx]]

    def bow_enchants(self, env: np.ndarray, seat: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Return the Power, Punch and Flame levels of the selected players."""
        kit = self.kit_id[env, seat]
        return self._t_power[kit], self._t_punch[kit], self._t_flame[kit]

    def wear_bow(self, fired: np.ndarray) -> None:
        """Spend one point of bow durability per shot, after Unbreaking."""
        cost = fired.astype(np.int64)
        level = self._t_unbreaking[self.kit_id]
        if level.any():
            cost = self.sim.rng.binomial(cost, 1.0 / (level + 1.0))
        self.bow_left -= cost
        self.has_bow &= self.bow_left > 0

    def wear_sword(self, env: int, seat: int, cost: int) -> None:
        """Spend sword durability on a block broken with it."""
        if cost <= 0 or self.weapon_left[env, seat, C.SWORD] <= 0:
            return
        self.weapon_left[env, seat, C.SWORD] -= cost
        if self.weapon_left[env, seat, C.SWORD] <= 0:
            self.weapon_damage[env, seat, C.SWORD] = I.FIST_DAMAGE
            self.weapon_speed[env, seat, C.SWORD] = I.FIST_SPEED
            self.weapon_sharpness[env, seat, C.SWORD] = 0.0
            self._uniform_speed = False

    def wake_server_copy(self) -> None:
        """Mark the server copy as moving."""
        self._copy_sliding = True

    def _pick(self, table: np.ndarray) -> np.ndarray:
        return np.take_along_axis(table, self.sim.weapon[..., None], axis=2)[..., 0]

    def attack_speed(self) -> np.ndarray:
        """Return the attack speed of each player's held weapon."""
        if self._uniform_speed:
            return self._t_speed[0][self.sim.weapon]
        return self._pick(self.weapon_speed)

    def charge(self) -> np.ndarray:
        """Return the attack charge of each player, from 0 to 1."""
        period = C.TICKS_PER_SECOND / self.attack_speed()
        return np.clip((self.sim.attack_ticks + 0.5) / period, 0.0, 1.0)

    def speed_multiplier(self) -> np.ndarray:
        """Return each player's movement speed factor from the Speed effect."""
        level = self.effect_amp[..., I.SPEED] + 1
        return 1.0 + SPEED_PER_LEVEL * np.where(self.effect_time[..., I.SPEED] > 0, level, 0)

    def give_axe(self, env: int, seat: int, material: str) -> None:
        """Put an axe of a material in one player's axe slot."""
        self.weapon_damage[env, seat, C.AXE] = I.AXES[material]
        self.weapon_speed[env, seat, C.AXE] = I.AXE_SPEED[material]
        self._uniform_speed = False
        self.weapon_left[env, seat, 1] = I.TOOL_DURABILITY[material]

    def eye_position(self, env: int, seat: int) -> np.ndarray:
        """Return one player's eye position."""
        eye = self.sim.pos[env, seat].copy()
        eye[1] += SNEAK_EYE_HEIGHT if self.sneaking[env, seat] else C.EYE_HEIGHT
        return eye

    def body_boxes(self, pos: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
        """Return hitbox corners, using the short box for sneaking players."""
        at = self.sim.pos if pos is None else pos
        half = C.PLAYER_WIDTH / 2.0
        low = at + np.array([-half, 0.0, -half])
        high = at + np.array([half, C.PLAYER_HEIGHT, half])
        if self.sneaking.any():
            high[..., 1] = at[..., 1] + np.where(self.sneaking, SNEAK_HEIGHT, C.PLAYER_HEIGHT)
        return low, high

    def _aim(self) -> np.ndarray:
        sim = self.sim
        if sim.world is None and self._history is None and not self.sneaking.any():
            return sim.aim_hits()
        eye = sim.pos.copy()
        eye[..., 1] += np.where(self.sneaking, SNEAK_EYE_HEIGHT, C.EYE_HEIGHT)
        look = sim.look()
        seen = sim.pos if self._history is None else self._history[self._history_at]
        low, high = self.body_boxes(seen)
        entry, reached = _ray_entry(eye, look, low[:, ::-1], high[:, ::-1], C.ATTACK_REACH)
        if self._history is not None:
            true_low, true_high = self.body_boxes()
            nearest = np.clip(eye, true_low[:, ::-1], true_high[:, ::-1])
            reached &= np.linalg.norm(nearest - eye, axis=-1) <= SERVER_REACH
        if sim.world is not None:
            hit, _cell, _face, dist = sim.world.ray_block_many(eye, look, C.ATTACK_REACH)
            reached &= ~(hit & (dist < entry))
        return reached

    def melee(self, attack: np.ndarray) -> None:
        """Resolve one round of melee swings."""
        if not attack.any():
            return
        sim = self.sim
        events = sim.events
        charge = self.charge()
        multiplier = 0.2 + 0.8 * charge * charge
        charged = charge > CHARGE_GATE
        lands = attack & self._aim() & (sim.hp[:, ::-1] > 0.0)
        sprint_hit = lands & sim.sprinting & charged
        falling = (self.fall_distance > 0.0) & ~sim.on_ground & ~self.no_crit
        crit = lands & charged & falling & ~sim.sprinting
        base = self._pick(self.weapon_damage)
        if self._effects_live:
            base = base + 3.0 * (self.effect_amp[..., I.STRENGTH] + 1)
        raw = base * multiplier * np.where(crit, C.CRIT_MULTIPLIER, 1.0)
        raw = raw + self._pick(self.weapon_sharpness) * charge

        yaw = np.radians(sim.yaw)
        gap = sim.pos[:, ::-1] - sim.pos
        front = -np.sin(yaw) * gap[..., 0] + np.cos(yaw) * gap[..., 2] > 0.0
        blocked = lands & (sim.shield_active & front)[:, ::-1]
        breaks = blocked & (sim.weapon == C.AXE)

        events["swings"] += attack
        events["weak_swings"] += attack & ~charged
        events["hits"] += lands & ~blocked
        events["crits"] += crit & ~blocked
        events["sprint_hits"] += sprint_hit & ~blocked
        events["melee_blocked"] += blocked
        events["shield_breaks"] += breaks
        sim.attack_ticks[attack] = 0.0

        for attacker in (0, 1):
            victim = 1 - attacker
            broke = breaks[:, attacker]
            if broke.any():
                sim.shield_disabled[broke, victim] = C.SHIELD_DISABLE_TICKS
                sim.shield_ticks[broke, victim] = 0
                sim.followup[broke, attacker] = FOLLOWUP_TICKS
            guarded = blocked[:, attacker]
            if guarded.any():
                self._blocked_hit(np.flatnonzero(guarded), attacker, victim, raw[:, attacker])
            hit = lands[:, attacker] & ~guarded
            if not hit.any():
                continue
            dealt = self._strike(hit, attacker, victim, raw[:, attacker], sprint_hit[:, attacker])
            events["damage_dealt"][:, attacker] += dealt
            events["damage_taken"][:, victim] += dealt
            events["followup_damage"][:, attacker] += dealt * (sim.followup[:, attacker] > 0)

    def _away(self, idx: np.ndarray, attacker: int, victim: int) -> tuple[np.ndarray, np.ndarray]:
        away = self.sim.pos[idx, victim] - self.sim.pos[idx, attacker]
        return _unit(away[:, 0], away[:, 2])

    def _blocked_hit(self, idx: np.ndarray, attacker: int, victim: int, raw: np.ndarray) -> None:
        sim = self.sim
        dx, dz = self._away(idx, attacker, victim)
        mask = np.zeros(sim.n, dtype=bool)
        mask[idx] = True
        direction = np.zeros((sim.n, 2))
        direction[idx, 0] = dx
        direction[idx, 1] = dz
        M.blocked_knockback(sim, mask, victim, direction)
        opened = idx[sim.hurt_timer[idx, victim] == 0]
        sim.hurt_timer[opened, victim] = C.HURT_TICKS
        sim.last_damage[opened, victim] = 0.0
        self._wear_shield(idx, victim, raw[idx])

    def block_arrow(
        self, idx: np.ndarray, victim: int, raw: np.ndarray, direction: np.ndarray, knockback: np.ndarray
    ) -> None:
        """Resolve arrows stopped by a shield: knockback, hurt window and shield wear."""
        sim = self.sim
        opened = idx[sim.hurt_timer[idx, victim] == 0]
        if len(opened):
            fresh = np.zeros(sim.n, dtype=bool)
            fresh[opened] = True
            M.take_knockback(sim, fresh, victim, direction, knockback)
            sim.hurt_timer[opened, victim] = C.HURT_TICKS
            sim.last_damage[opened, victim] = 0.0
        self._wear_shield(idx, victim, raw)

    def _wear_shield(self, idx: np.ndarray, victim: int, amount: np.ndarray) -> None:
        sim = self.sim
        wear = shield_wear(amount)
        level = self._t_unbreaking[self.kit_id[idx, victim]]
        if level.any():
            wear = sim.rng.binomial(wear, 1.0 / (level + 1.0))
        self.shield_left[idx, victim] -= wear
        gone = idx[self.shield_left[idx, victim] <= 0]
        if len(gone):
            self.has_shield[gone, victim] = False
            sim.shield_ticks[gone, victim] = 0

    def _strike(
        self, mask: np.ndarray, attacker: int, victim: int, raw: np.ndarray, sprint: np.ndarray
    ) -> np.ndarray:
        sim = self.sim
        closed = sim.hurt_timer[:, victim] == 0
        dealt = self.hurt(mask, victim, raw, kind=I.MELEE)
        idx = np.flatnonzero(self._applied)
        if len(idx) == 0:
            return dealt
        kit = self.kit_id[idx, attacker]
        level = self._t_knockback[kit]
        fresh = closed[idx]
        if fresh.any():
            self._push(idx[fresh], attacker, victim, sprint[idx[fresh]], level[fresh])
        if sprint[idx].any():
            pushed = idx[sprint[idx]]
            sim.sprinting[pushed, attacker] = False
            if sim.cfg.client_model == "vanilla":
                sim.vel[pushed, attacker, 0] *= C.ATTACKER_SLOWDOWN
                sim.vel[pushed, attacker, 2] *= C.ATTACKER_SLOWDOWN
        aspect = self._t_fire_aspect[kit]
        if aspect.any():
            lit = aspect > 0
            self.ignite(idx[lit], victim, FIRE_ASPECT_TICKS * aspect[lit])
        self._wear_weapon(idx, attacker)
        if sim.cfg.hunger:
            self.exhaustion[idx, attacker] += EXHAUST_ATTACK
        return dealt

    def _push(self, idx: np.ndarray, attacker: int, victim: int, sprint: np.ndarray, level: np.ndarray) -> None:
        sim = self.sim
        dx, dz = self._away(idx, attacker, victim)
        fresh = np.zeros(sim.n, dtype=bool)
        fresh[idx] = True
        direction = np.zeros((sim.n, 2))
        direction[idx, 0] = dx
        direction[idx, 1] = dz
        sprints = np.zeros(sim.n, dtype=bool)
        sprints[idx] = sprint
        levels = np.zeros(sim.n)
        levels[idx] = level
        M.take_knockback(sim, fresh, victim, direction, np.full(sim.n, C.BASE_KNOCKBACK), sprints, levels)

    def hurt(
        self,
        mask: np.ndarray,
        victim: int,
        raw: np.ndarray,
        direction: np.ndarray | None = None,
        knockback: np.ndarray | None = None,
        kind: int = I.PROJECTILE,
        punch: np.ndarray | None = None,
    ) -> np.ndarray:
        """Apply damage through the hurt window and return health removed."""
        sim = self.sim
        dealt = np.zeros(sim.n)
        self._applied = np.zeros(sim.n, dtype=bool)
        idx = np.flatnonzero(mask)
        if len(idx) and IS_FIRE[kind] and self._effects_live:
            idx = idx[self.effect_time[idx, victim, I.FIRE_RESISTANCE] <= 0]
        if len(idx) == 0:
            return dealt
        amount = raw[idx]
        in_window = sim.hurt_timer[idx, victim] > 0
        effective = np.where(in_window, amount - sim.last_damage[idx, victim], amount)
        go = effective > 0.0
        if not go.any():
            return dealt
        idx, amount, effective, in_window = idx[go], amount[go], effective[go], in_window[go]
        self._applied[idx] = True
        sim.last_damage[idx, victim] = amount
        sim.hurt_timer[idx[~in_window], victim] = C.HURT_TICKS
        reduced = effective
        if USES_ARMOR[kind]:
            reduced = armor_scale(reduced, self.armor[idx, victim], self.toughness[idx, victim])
            if self._has_armor:
                self._wear_armor(idx, victim, effective)
        points = self.protection[idx, victim, kind]
        if points.any():
            reduced = reduced * (1.0 - np.minimum(points, 20.0) / 25.0)
        dealt[idx] = self._take(idx, victim, reduced)
        self.last_hit_tick[idx] = sim.ticks[idx]
        if sim.cfg.hunger:
            self.exhaustion[idx, victim] += HURT_EXHAUSTION[kind]
        if direction is not None and knockback is not None:
            fresh = idx[~in_window]
            if len(fresh):
                mask = np.zeros(sim.n, dtype=bool)
                mask[fresh] = True
                M.take_knockback(sim, mask, victim, direction, knockback, punch=punch)
        return dealt

    def hurt_one(self, env: int, seat: int, amount: float, kind: int) -> float:
        """Apply environment damage to one player."""
        mask = np.zeros(self.sim.n, dtype=bool)
        mask[env] = True
        raw = np.zeros(self.sim.n)
        raw[env] = amount
        dealt = self.hurt(mask, seat, raw, kind=kind)
        self.environment_damage[env, seat] += dealt[env]
        return float(dealt[env])

    def _hurt_many(self, mask: np.ndarray, amount: float, kind: int) -> None:
        raw = np.full(self.sim.n, amount)
        for seat in (0, 1):
            column = mask[:, seat]
            if column.any():
                self.environment_damage[:, seat] += self.hurt(column, seat, raw, kind=kind)

    def _take(self, idx: np.ndarray, victim: int, amount: np.ndarray) -> np.ndarray:
        hp = self.sim.hp
        shield = self.absorption[idx, victim]
        soaked = np.minimum(shield, amount)
        self.absorption[idx, victim] = shield - soaked
        removed = np.minimum(amount - soaked, hp[idx, victim])
        hp[idx, victim] -= removed
        return removed

    def _wear_armor(self, idx: np.ndarray, victim: int, amount: np.ndarray) -> None:
        cost = np.maximum(np.floor(amount / 4.0), 1.0).astype(np.int64)[:, None]
        cost = np.repeat(cost, 4, axis=1)
        level = self._t_unbreaking[self.kit_id[idx, victim]]
        if level.any():
            keep = 1.0 - 2.0 * level / (5.0 * level + 5.0)
            cost = self.sim.rng.binomial(cost, keep[:, None])
        left = self.armor_left[idx, victim]
        worn = left > 0
        after = np.where(worn, np.maximum(left - cost, 0), 0)
        self.armor_left[idx, victim] = after
        gone = worn & (after == 0)
        if gone.any():
            for k in np.flatnonzero(gone.any(axis=1)):
                self._refresh_armor(int(idx[k]), victim)

    def _refresh_armor(self, env: int, seat: int) -> None:
        kit = int(self.kit_id[env, seat])
        live = self.armor_left[env, seat] > 0
        self.armor[env, seat] = float((self._t_points[kit] * live).sum())
        self.toughness[env, seat] = float((self._t_tough[kit] * live).sum())
        self.knockback_resistance[env, seat] = float((self._t_resist[kit] * live).sum())
        self.fire_levels[env, seat] = float((self._t_fire[kit] * live).sum())
        self.protection[env, seat] = _protection_points(self.kits[kit], live)

    def _wear_weapon(self, idx: np.ndarray, attacker: int) -> None:
        sim = self.sim
        held = sim.weapon[idx, attacker]
        tool = held <= C.AXE
        if not tool.any():
            return
        idx, held = idx[tool], held[tool]
        owned = self.weapon_left[idx, attacker, held] > 0
        if not owned.any():
            return
        idx, held = idx[owned], held[owned]
        cost = np.where(held == C.AXE, 2, 1)
        level = self._t_unbreaking[self.kit_id[idx, attacker]]
        if level.any():
            cost = sim.rng.binomial(cost, 1.0 / (level + 1.0))
        self.weapon_left[idx, attacker, held] -= cost
        gone = self.weapon_left[idx, attacker, held] <= 0
        if gone.any():
            broken, slot = idx[gone], held[gone]
            self.weapon_damage[broken, attacker, slot] = I.FIST_DAMAGE
            self.weapon_speed[broken, attacker, slot] = I.FIST_SPEED
            self._uniform_speed = False
            self.weapon_sharpness[broken, attacker, slot] = 0.0

    def after_move(self, jumped: np.ndarray) -> None:
        """Run the per tick server state after bodies have moved."""
        sim = self.sim
        self._server_tick(jumped)
        self.fall_distance -= np.minimum(sim.body.moved_y, 0.0)
        in_lava = in_fire = self._none
        if sim.world is not None:
            in_lava, in_fire = self._world_contacts()
        if self._burning or in_fire is not self._none:
            self._burn(in_lava, in_fire)
        grounded = sim.on_ground
        landed = grounded & (self.fall_distance > SAFE_FALL)
        if landed.any():
            self._land(landed)
        self.fall_distance *= ~grounded
        if sim.cfg.hunger:
            self._food_tick(jumped)
        if self._effects_live:
            self._effects_tick()
        if self._history is not None:
            self._history[self._history_at] = sim.pos
            self._history_at = (self._history_at + 1) % len(self._history)

    def _server_tick(self, jumped: np.ndarray) -> None:
        vel = self.server_vel
        was_ground = self.server_ground
        body = self.sim.on_ground
        vy = vel[..., 1]
        settled = (was_ground & (vy <= 0.0)) | (body & (vy < 0.0))
        if self._copy_sliding:
            vx, vz = vel[..., 0], vel[..., 2]
            moving = vx * vx + vz * vz >= TINY_SPEED_SQUARED
            drag = np.where(was_ground, C.GROUND_DRAG, C.AIR_DRAG) * moving
            vel[..., 0] = vx * drag
            vel[..., 2] = vz * drag
            self._copy_sliding = bool(moving.any())
        flat_vanilla = self.sim.body.cfg.vanilla and self.sim.world is None
        if flat_vanilla:
            reaches_floor = self.sim.body._before[..., 1] + vy <= 1e-9
            settled = (was_ground & (vy <= 0.0)) | (body & reaches_floor & (vy < 0.0))
        y = np.where(settled, 0.0, vy)
        if flat_vanilla:
            lifted = was_ground & self._was_ground & ~body & (self.sim.body.moved_y > 0.0)
            late = jumped & self._was_still
            due = (lifted & ~late) | self._lift_pending
            self._lift_pending = late
            new_y = (y - C.GRAVITY) * C.VERTICAL_DRAG
            vel[..., 1] = np.where(due, np.maximum(y, JUMP_MIN_SPEED), new_y)
            self.server_ground = (settled & ~due) & (body | late)
            self._was_ground = body.copy()
            self._was_still = (self.sim.body.last_move ** 2).sum(axis=-1) < 1e-12
            return
        if jumped.any():
            y = np.where(jumped, np.maximum(y, JUMP_MIN_SPEED), y)
            settled = settled & ~jumped
        vel[..., 1] = (y - C.GRAVITY) * C.VERTICAL_DRAG
        self.server_ground = settled & body

    def _world_contacts(self) -> tuple[np.ndarray, np.ndarray]:
        sim = self.sim
        height = np.where(self.sneaking, SNEAK_HEIGHT, C.PLAYER_HEIGHT)
        eye = np.where(self.sneaking, SNEAK_EYE_HEIGHT, C.EYE_HEIGHT)
        width = np.full((sim.n, 2), C.PLAYER_WIDTH)
        fluid = sim.world.fluid_box_many(sim.pos, width, height, eye)
        contact = sim.world.contact_many(sim.pos, width, height)
        in_water = fluid["in_water"]
        in_lava = fluid["in_lava"]
        web = contact["cobweb"]
        in_fire = contact["fire"] & ~in_water & ~in_lava
        self.in_water = in_water
        self.eyes_in_water = fluid["eye_in_water"]
        self.no_crit = in_water | web
        self.fall_distance[self.no_crit] = 0.0
        if in_lava.any():
            self.fall_distance[in_lava] *= 0.5
        if in_water.any():
            self.fire[in_water] = FIRE_REST
        return in_lava, in_fire

    def _burn(self, in_lava: np.ndarray, in_fire: np.ndarray) -> None:
        fire = self.fire
        lit = fire > 0
        if lit.any():
            due = lit & (fire % FIRE_PERIOD == 0) & ~in_lava
            if due.any():
                self._hurt_many(due, BURN_DAMAGE, I.ON_FIRE)
            running = lit & ~in_lava & ~in_fire
            fire[running] -= 1
            fire[running & (fire == 0)] = FIRE_REST
        if in_lava.any():
            self._hurt_many(in_lava, LAVA_DAMAGE, I.LAVA)
            for seat in (0, 1):
                column = np.flatnonzero(in_lava[:, seat])
                if len(column):
                    self.ignite(column, seat, np.full(len(column), LAVA_IGNITE))
        if in_fire.any():
            self._hurt_many(in_fire, FIRE_BLOCK_DAMAGE, I.IN_FIRE)
            rising = in_fire & (fire < 0)
            growing = in_fire & (fire > 0) & (self.sim.ticks[:, None] % 2 == 1)
            fire[rising] += 1
            fire[growing] += 1
            for seat in (0, 1):
                column = np.flatnonzero(rising[:, seat] & (fire[:, seat] == 0))
                if len(column):
                    self.ignite(column, seat, np.full(len(column), FIRE_BLOCK_IGNITE))
        self._burning = bool((fire > 0).any())

    def ignite(self, idx: np.ndarray, seat: int, ticks: np.ndarray) -> None:
        """Set players on fire for at least the given ticks, after Fire Protection."""
        cut = np.maximum(1.0 - FIRE_PROTECTION_CUT * self.fire_levels[idx, seat], 0.0)
        scaled = np.floor(np.asarray(ticks) * cut).astype(np.int64)
        current = self.fire[idx, seat]
        self.fire[idx, seat] = np.where(scaled > 0, np.maximum(current, scaled), np.minimum(current, FIRE_REST))
        self._burning = True

    def _land(self, landed: np.ndarray) -> None:
        amount = fall_damage(self.fall_distance)
        for seat in (0, 1):
            column = landed[:, seat] & (amount[:, seat] > 0.0)
            if column.any():
                self.environment_damage[:, seat] += self.hurt(column, seat, amount[:, seat], kind=I.FALL)

    def _food_tick(self, jumped: np.ndarray) -> None:
        sim = self.sim
        xz = sim.pos[..., [0, 2]]
        step = np.linalg.norm(xz - self._last_xz, axis=-1)
        self._last_xz[...] = xz
        exhaustion = self.exhaustion
        exhaustion += sim.sprinting * EXHAUST_SPRINT * step
        if sim.world is not None:
            exhaustion += self.in_water * EXHAUST_SWIM * step
        if jumped.any():
            exhaustion += jumped * np.where(sim.sprinting, EXHAUST_SPRINT_JUMP, EXHAUST_JUMP)
        over = exhaustion > EXHAUSTION_STEP
        if over.any():
            exhaustion[over] -= EXHAUSTION_STEP
            has = self.saturation > 0.0
            self.saturation[over & has] = np.maximum(self.saturation[over & has] - 1.0, 0.0)
            hungry = over & ~has
            self.food[hungry] = np.maximum(self.food[hungry] - 1, 0)
        alive = sim.hp > 0.0
        injured = alive & (sim.hp < C.MAX_HEALTH)
        natural = bool(sim.cfg.natural_regen)
        fast = natural & injured & (self.saturation > 0.0) & (self.food >= START_FOOD)
        slow = natural & injured & ~fast & (self.food >= SLOW_REGEN_FOOD)
        starving = ~fast & ~slow & (self.food <= 0)
        ticking = fast | slow | starving
        self.food_timer = np.where(ticking, self.food_timer + 1, 0)
        due = fast & (self.food_timer >= FAST_REGEN_TICKS)
        if due.any():
            spent = np.minimum(self.saturation[due], 6.0)
            sim.hp[due] = np.minimum(sim.hp[due] + spent / 6.0, C.MAX_HEALTH)
            exhaustion[due] += spent
            self.food_timer[due] = 0
        due = slow & (self.food_timer >= SLOW_REGEN_TICKS)
        if due.any():
            sim.hp[due] = np.minimum(sim.hp[due] + 1.0, C.MAX_HEALTH)
            exhaustion[due] += SLOW_REGEN_EXHAUSTION
            self.food_timer[due] = 0
        due = starving & (self.food_timer >= STARVE_TICKS)
        if due.any():
            self.food_timer[due] = 0
            self._hurt_many(due & (sim.hp > 1.0), 1.0, I.STARVE)

    def feed(self, env: int, seat: int, food: int, saturation: float) -> None:
        """Add food points and saturation to one player."""
        self.food[env, seat] = min(int(self.food[env, seat]) + food, START_FOOD)
        self.saturation[env, seat] = min(
            float(self.saturation[env, seat]) + saturation, float(self.food[env, seat])
        )

    def heal(self, env: int, seat: int, amount: float) -> None:
        """Restore health to one living player."""
        hp = self.sim.hp
        if hp[env, seat] > 0.0:
            hp[env, seat] = min(float(hp[env, seat]) + amount, C.MAX_HEALTH)

    def pull(self, env: int, seat: int, delta: np.ndarray) -> None:
        """Add a velocity change to one player's body and server copy."""
        self.sim.vel[env, seat] += delta
        self.server_vel[env, seat] += delta
        self._copy_sliding = True
        if delta[1] > 0.0:
            self.sim.on_ground[env, seat] = False
            self.server_ground[env, seat] = False

    def teleported(self, env: int, seat: int) -> None:
        """Clear motion state after a player is moved directly."""
        self.fall_distance[env, seat] = 0.0
        self.sim.body.last_move[env, seat] = 0.0
        self.server_vel[env, seat] = (0.0, -C.GRAVITY * C.VERTICAL_DRAG, 0.0)

    def add_effect(self, env: int, seat: int, effect: int, amp: int, ticks: int) -> None:
        """Apply a status effect with the stronger, longer and stored rules."""
        amp_now = int(self.effect_amp[env, seat, effect])
        time_now = int(self.effect_time[env, seat, effect])
        active = time_now > 0
        if not active or amp > amp_now:
            if active and time_now > ticks:
                self.stored_amp[env, seat, effect] = amp_now
                self.stored_time[env, seat, effect] = time_now
            self.effect_amp[env, seat, effect] = amp
            self.effect_time[env, seat, effect] = ticks
        elif amp == amp_now:
            self.effect_time[env, seat, effect] = max(time_now, ticks)
        elif ticks > time_now and ticks > int(self.stored_time[env, seat, effect]):
            self.stored_amp[env, seat, effect] = amp
            self.stored_time[env, seat, effect] = ticks
        if effect == I.ABSORPTION:
            amount = ABSORPTION_PER_LEVEL * (amp + 1)
            self.absorption[env, seat] = max(float(self.absorption[env, seat]), amount)
        if effect == I.SPEED:
            self._sync_speed()
        self._effects_live = True

    def _sync_speed(self) -> None:
        """Give the bodies the level of their active Speed effect."""
        level = self.effect_amp[..., I.SPEED] + 1
        self.sim.body.speed_level = np.where(self.effect_time[..., I.SPEED] > 0, level, 0)

    def _effects_tick(self) -> None:
        sim = self.sim
        time = self.effect_time
        amp = np.maximum(self.effect_amp, 0)
        regen = time[..., I.REGENERATION]
        if regen.any():
            period = np.maximum(REGEN_PERIOD >> amp[..., I.REGENERATION], 1)
            due = (regen > 0) & (regen % period == 0) & (sim.hp > 0.0)
            if due.any():
                sim.hp[due] = np.minimum(sim.hp[due] + 1.0, C.MAX_HEALTH)
        poison = time[..., I.POISON]
        if poison.any():
            period = np.maximum(POISON_PERIOD >> amp[..., I.POISON], 1)
            due = (poison > 0) & (poison % period == 0) & (sim.hp > 1.0)
            if due.any():
                self._hurt_many(due, 1.0, I.MAGIC)
        running = time > 0
        time[running] -= 1
        self.stored_time[self.stored_time > 0] -= 1
        ended = running & (time == 0)
        if ended.any():
            for env, seat, effect in zip(*np.nonzero(ended)):
                if effect == I.ABSORPTION:
                    amount = ABSORPTION_PER_LEVEL * (int(self.effect_amp[env, seat, effect]) + 1)
                    self.absorption[env, seat] = max(float(self.absorption[env, seat]) - amount, 0.0)
                self.effect_amp[env, seat, effect] = self.stored_amp[env, seat, effect]
                time[env, seat, effect] = self.stored_time[env, seat, effect]
                self.stored_amp[env, seat, effect] = -1
                self.stored_time[env, seat, effect] = 0
            if ended[..., I.SPEED].any():
                self._sync_speed()
        self._effects_live = bool(time.any())


def _ray_entry(
    origin: np.ndarray, direction: np.ndarray, box_min: np.ndarray, box_max: np.ndarray, reach: float
) -> tuple[np.ndarray, np.ndarray]:
    """Return ray entry distances and which rays reach the box."""
    d = np.where(np.abs(direction) < 1e-9, 1e-9, direction)
    t1 = (box_min - origin) / d
    t2 = (box_max - origin) / d
    near = np.minimum(t1, t2).max(axis=-1)
    far = np.maximum(t1, t2).min(axis=-1)
    entry = np.maximum(near, 0.0)
    return entry, (far >= entry) & (entry <= reach)
