"""Game constants. SIM_NOTES.md lists the source page for each value."""

from __future__ import annotations

import numpy as np

TICKS_PER_SECOND = 20
TICKS_PER_DECISION = 2

# Player body.
PLAYER_WIDTH = 0.6
PLAYER_HEIGHT = 1.8
EYE_HEIGHT = 1.62
MAX_HEALTH = 20.0
ATTACK_REACH = 3.0

# Living entity motion, in blocks and ticks.
GRAVITY = 0.08
VERTICAL_DRAG = 0.98
AIR_DRAG = 0.91
GROUND_FRICTION = 0.6
GROUND_DRAG = AIR_DRAG * GROUND_FRICTION
MOVEMENT_SPEED = 0.1
SPRINT_MULTIPLIER = 1.3
SNEAK_MULTIPLIER = 0.3
INPUT_SCALE = 0.98
JUMP_VELOCITY = 0.42
SPRINT_JUMP_BOOST = 0.2
AIR_ACCEL = 0.02
AIR_ACCEL_SPRINT = 0.026

# Melee.
FULL_CHARGE_THRESHOLD = 0.848
CRIT_MULTIPLIER = 1.5
HURT_TICKS = 10

# Knockback and falls. Every value fitted to knockback or fall recordings is here.
BASE_KNOCKBACK = 0.4
SPRINT_KNOCKBACK_BONUS = 0.5
KNOCKBACK_ENCHANT_STRENGTH = 0.5
KNOCKBACK_VERTICAL_CAP = 0.4
KNOCKBACK_FROM_SERVER_COPY = True
MINEFLAYER_KNOCKBACK_DELAY = 1
ATTACKER_SLOWDOWN = 0.6
SHIELD_KNOCKBACK = 0.5
SAFE_FALL = 3.0
FALL_EPSILON = 1e-6
FEATHER_FALLING_POINTS = 3.0

# Shield. The raise count includes the tick of the press, so a shield blocks
# from the fifth tick after it.
SHIELD_RAISE_TICKS = 6
SHIELD_DISABLE_TICKS = 100

# Arrows.
ARROW_GRAVITY = 0.05
ARROW_DRAG = 0.99
ARROW_BASE_DAMAGE = 2.0
BOW_MAX_SPEED = 3.0
BOW_FULL_DRAW_TICKS = 20
BOW_MIN_DRAW_TICKS = 3
CROSSBOW_SPEED = 3.15
CROSSBOW_LOAD_TICKS = 25
CROSSBOW_RELOAD_DELAY = 4
POWER_DAMAGE_PER_LEVEL = 0.5
PUNCH_PER_LEVEL = 0.6
PUNCH_LIFT = 0.1
FLAME_TICKS = 100

# Weapon indices, in the order of the weapon action head.
SWORD = 0
AXE = 1
BOW = 2
CROSSBOW = 3
NUM_WEAPONS = 4

# Melee stats per weapon index. Ranged weapons hit like an empty hand.
WEAPON_DAMAGE = np.array([7.0, 9.0, 1.0, 1.0])
WEAPON_ATTACK_SPEED = np.array([1.6, 1.0, 4.0, 4.0])

# Armor sets as (armor points, toughness).
ARMOR_SETS = {
    "none": (0.0, 0.0),
    "iron": (15.0, 0.0),
    "diamond": (20.0, 8.0),
    "netherite": (20.0, 12.0),
}

# Arena half width in blocks. The floor is at y = 0.
ARENA_HALF_WIDTH = 12.0
