"""Kits, item tables, consumables, thrown items and block items.

Held items are driven by `Items.input`, an array of item codes of shape (n, 2).
It defaults to zero, which means no item is in use. Items that change blocks
go through the world API and do nothing when the simulator has no world.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import constants as C

# Damage kinds.
MELEE, PROJECTILE, IN_FIRE, ON_FIRE, LAVA, FALL, STARVE, PEARL_LANDING, MAGIC, BLAST = range(10)
NUM_KINDS = 10

# Status effects.
REGENERATION, ABSORPTION, STRENGTH, SPEED, POISON, FIRE_RESISTANCE = range(6)
NUM_EFFECTS = 6

# Item codes for `Items.input`.
NO_ITEM = 0
GOLDEN_APPLE = 1
WATER_BUCKET = 2
LAVA_BUCKET = 3
EMPTY_BUCKET = 4
COBWEB = 5
BLOCK = 6
PEARL = 7
ROD = 8
FIRST_POTION = 9

# Potion rows: name, effect (or -1 for an instant heal), amplifier, duration.
POTIONS = (
    ("regeneration", REGENERATION, 0, 900),
    ("regeneration_strong", REGENERATION, 1, 450),
    ("swiftness", SPEED, 0, 3600),
    ("swiftness_strong", SPEED, 1, 1800),
    ("strength", STRENGTH, 0, 3600),
    ("strength_strong", STRENGTH, 1, 1800),
    ("poison", POISON, 0, 900),
    ("poison_strong", POISON, 1, 432),
    ("fire_resistance", FIRE_RESISTANCE, 0, 3600),
    ("healing", -1, 0, 0),
    ("healing_strong", -1, 1, 0),
)
NUM_POTIONS = len(POTIONS)
FIRST_SPLASH = FIRST_POTION + NUM_POTIONS
NUM_ITEMS = FIRST_SPLASH + NUM_POTIONS
DRINK = {name: FIRST_POTION + i for i, (name, *_rest) in enumerate(POTIONS)}
SPLASH = {name: FIRST_SPLASH + i for i, (name, *_rest) in enumerate(POTIONS)}

USE_DURATION = 32
GOLDEN_APPLE_FOOD = 4
GOLDEN_APPLE_SATURATION = 9.6
GOLDEN_APPLE_REGEN = (1, 100)
GOLDEN_APPLE_ABSORPTION = (0, 2400)
INSTANT_HEAL = 4.0

PEARL_SPEED = 1.5
PEARL_GRAVITY = 0.03
PEARL_DRAG = 0.99
PEARL_COOLDOWN = 20
PEARL_DAMAGE = 5.0
THROW_DROP = 0.1

SPLASH_SPEED = 0.5
SPLASH_PITCH_UP = 20.0
SPLASH_GRAVITY = 0.05
SPLASH_DRAG = 0.99
SPLASH_RADIUS = 4.0
SPLASH_MIN_TICKS = 20

ROD_BASE_SPEED = 0.6
ROD_EXTRA_SPEED = 0.5
ROD_MAX_SLOPE = 5.0
ROD_START = 0.3
ROD_GRAVITY = 0.03
ROD_DRAG = 0.92
ROD_PULL = 0.1
ROD_DURABILITY = 64
ROD_COST_PULL = 5
ROD_COST_GROUND = 2
HOOK_BODY_FRACTION = 0.8
HOOK_RANGE = 33.0
HOOK_FLYING, HOOK_STUCK, HOOK_ON_PLAYER = range(3)
PROJECTILE_MARGIN = 0.125

ARMOR_POINTS = {
    "none": (0, 0, 0, 0),
    "leather": (1, 3, 2, 1),
    "iron": (2, 6, 5, 2),
    "diamond": (3, 8, 6, 3),
    "netherite": (3, 8, 6, 3),
}
ARMOR_TOUGHNESS = {"none": 0.0, "leather": 0.0, "iron": 0.0, "diamond": 2.0, "netherite": 3.0}
ARMOR_KNOCKBACK_RESISTANCE = {"none": 0.0, "leather": 0.0, "iron": 0.0, "diamond": 0.0, "netherite": 0.1}
ARMOR_DURABILITY = {
    "none": (0, 0, 0, 0),
    "leather": (55, 80, 75, 65),
    "iron": (165, 240, 225, 195),
    "diamond": (363, 528, 495, 429),
    "netherite": (407, 592, 555, 481),
}

SWORDS = {"none": 1.0, "wooden": 4.0, "stone": 5.0, "iron": 6.0, "diamond": 7.0, "netherite": 8.0}
AXES = {"none": 1.0, "wooden": 7.0, "stone": 9.0, "iron": 9.0, "diamond": 9.0, "netherite": 10.0}
AXE_SPEED = {"none": 4.0, "wooden": 0.8, "stone": 0.8, "iron": 0.9, "diamond": 1.0, "netherite": 1.0}
SWORD_SPEED = 1.6
FIST_DAMAGE = 1.0
FIST_SPEED = 4.0
TOOL_DURABILITY = {"none": 0, "wooden": 59, "stone": 131, "iron": 250, "diamond": 1561, "netherite": 2031}
BOW_DURABILITY = 384
SHIELD_DURABILITY = 336
GROUND_PICKUP_REACH = 1.3


@dataclass(frozen=True)
class Kit:
    """The gear one player starts a round with. Armor order: head, chest, legs, feet."""

    armor: tuple[str, str, str, str] = ("none", "none", "none", "none")
    protection: tuple[int, int, int, int] = (0, 0, 0, 0)
    fire_protection: tuple[int, int, int, int] = (0, 0, 0, 0)
    blast_protection: tuple[int, int, int, int] = (0, 0, 0, 0)
    projectile_protection: tuple[int, int, int, int] = (0, 0, 0, 0)
    feather_falling: int = 0
    unbreaking: int = 0
    sword: str = "diamond"
    axe: str = "diamond"
    sharpness: int = 0
    fire_aspect: int = 0
    knockback: int = 0
    power: int = 0
    punch: int = 0
    flame: int = 0
    shield: bool = True
    arrows: int = 6
    ground_axe: str | None = None
    stock: tuple[tuple[int, int], ...] = ()


def full_set(material: str) -> tuple[str, str, str, str]:
    """Return four armor pieces of one material."""
    return (material, material, material, material)


UHC_KIT = Kit(
    armor=full_set("diamond"),
    protection=(2, 2, 2, 2),
    unbreaking=3,
    sharpness=2,
    power=1,
    stock=(
        (GOLDEN_APPLE, 8),
        (WATER_BUCKET, 4),
        (LAVA_BUCKET, 2),
        (COBWEB, 8),
        (PEARL, 2),
        (ROD, 1),
        (BLOCK, 64),
    ),
)

KITS: dict[str, Kit] = {
    "leather": Kit(armor=full_set("leather")),
    "iron": Kit(armor=full_set("iron")),
    "diamond": Kit(armor=full_set("diamond")),
    "netherite": Kit(armor=full_set("netherite")),
    "empty": Kit(sword="none", axe="none", shield=False, arrows=0, ground_axe="wooden"),
    "archer": Kit(armor=full_set("leather"), sword="wooden", axe="wooden", power=1, arrows=16),
    "uhc": UHC_KIT,
}


def kit_named(name: str | Kit | None, armor: str) -> Kit:
    """Return a kit by name, a given kit, or a plain kit in one armor material for None."""
    if isinstance(name, Kit):
        return name
    if name is None:
        return Kit(armor=full_set(armor if armor in ARMOR_POINTS else "none"))
    if name not in KITS:
        raise ValueError(f"unknown kit {name!r}, expected one of {sorted(KITS)}")
    return KITS[name]


class HeldTools:
    """Mining tools and effects of each body, made the first time a tool is given."""

    def __init__(self, n: int) -> None:
        shape = (n, 2)
        self.kind = np.zeros(shape, dtype=np.int8)
        self.tier = np.zeros(shape, dtype=np.int8)
        self.left = np.zeros(shape, dtype=np.int32)
        self.efficiency = np.zeros(shape, dtype=np.int8)
        self.unbreaking = np.zeros(shape, dtype=np.int8)
        self.fortune = np.zeros(shape, dtype=np.int8)
        self.silk = np.zeros(shape, dtype=bool)
        self.haste = np.zeros(shape, dtype=np.int8)
        self.fatigue = np.zeros(shape, dtype=np.int8)
        self.aqua = np.zeros(shape, dtype=bool)

    def clear(self, idx: np.ndarray) -> None:
        """Empty the selected arenas."""
        for values in vars(self).values():
            values[idx] = 0


def _look(yaw: float, pitch: float) -> np.ndarray:
    y = np.radians(yaw)
    p = np.radians(pitch)
    return np.array([-np.sin(y) * np.cos(p), -np.sin(p), np.cos(y) * np.cos(p)])


class Items:
    """Held item input, inventories and thrown objects for a batch of arenas."""

    # A class default, so a saved environment state without tools loads unchanged.
    tools: HeldTools | None = None

    def __init__(self, sim) -> None:
        n = sim.n
        self.sim = sim
        self.input = np.zeros((n, 2), dtype=np.int16)
        self.dig_input = np.zeros((n, 2), dtype=bool)
        self.count = np.zeros((n, 2, NUM_ITEMS), dtype=np.int32)
        self.rod_left = np.zeros((n, 2), dtype=np.int32)
        self._prev = np.zeros((n, 2), dtype=np.int16)
        self.use_ticks = np.zeros((n, 2), dtype=np.int32)
        self.pearl_cooldown = np.zeros((n, 2), dtype=np.int32)
        self.pearl_on = np.zeros((n, 2), dtype=bool)
        self.pearl_pos = np.zeros((n, 2, 3))
        self.pearl_vel = np.zeros((n, 2, 3))
        self.splash_on = np.zeros((n, 2), dtype=bool)
        self.splash_pos = np.zeros((n, 2, 3))
        self.splash_vel = np.zeros((n, 2, 3))
        self.splash_kind = np.zeros((n, 2), dtype=np.int16)
        self.hook_on = np.zeros((n, 2), dtype=bool)
        self.hook_pos = np.zeros((n, 2, 3))
        self.hook_vel = np.zeros((n, 2, 3))
        self.hook_state = np.zeros((n, 2), dtype=np.int8)
        self.ground_on = np.zeros(n, dtype=bool)
        self.ground_material = ["wooden"] * n
        self._live = False
        self._idle = np.zeros((n, 2), dtype=bool)
        self._digging = np.zeros((n, 2), dtype=bool)
        self.picked = None

    def reset(self, idx: np.ndarray, kit_ids: np.ndarray, kits: list[Kit]) -> None:
        """Refill inventories of the selected arenas from their kits."""
        self.input[idx] = NO_ITEM
        self.dig_input[idx] = False
        self._prev[idx] = NO_ITEM
        self.use_ticks[idx] = 0
        self.pearl_cooldown[idx] = 0
        self.pearl_on[idx] = False
        self.splash_on[idx] = False
        self.hook_on[idx] = False
        self.count[idx] = 0
        self.rod_left[idx] = 0
        self.ground_on[idx] = False
        self._digging[idx] = False
        if self.picked is not None:
            self.picked[idx] = 0
        if self.tools is not None:
            self.tools.clear(idx)
        if not any(kit.stock or kit.ground_axe for kit in kits):
            return
        for env, row in zip(idx, kit_ids[idx]):
            for seat, kit_id in enumerate(row):
                kit = kits[int(kit_id)]
                if kit.ground_axe is not None:
                    self.ground_on[env] = True
                    self._live = True
                    self.ground_material[int(env)] = kit.ground_axe
                for code, amount in kit.stock:
                    self.count[env, seat, code] = amount
                    if code == ROD:
                        self.rod_left[env, seat] = ROD_DURABILITY

    def tick(self) -> np.ndarray:
        """Run item input and thrown objects. Return which players are busy using an item."""
        if not (self.input.any() or self.dig_input.any() or self._digging.any() or self._flying()):
            if self._prev.any():
                self._prev[:] = NO_ITEM
                self.use_ticks[:] = 0
            return self._idle
        busy = np.zeros_like(self._idle)
        if self.ground_on.any():
            self._pick_up_ground_axe()
        if self.pearl_on.any():
            self._fly_pearls()
        if self.splash_on.any():
            self._fly_splashes()
        self.pearl_cooldown = np.maximum(self.pearl_cooldown - 1, 0)
        hooks_up = self.hook_on.copy()
        stopped = self.input != self._prev
        if stopped.any():
            self.use_ticks[stopped] = 0
        for env, seat in self._body_order():
            if self.dig_input[env, seat]:
                self._dig(env, seat)
            code = int(self.input[env, seat])
            if code == NO_ITEM or self.count[env, seat, code] <= 0:
                continue
            if code == GOLDEN_APPLE or FIRST_POTION <= code < FIRST_SPLASH:
                busy[env, seat] = True
                self.use_ticks[env, seat] += 1
                if self.use_ticks[env, seat] >= USE_DURATION:
                    self.use_ticks[env, seat] = 0
                    self._consume(env, seat, code)
            elif stopped[env, seat]:
                self._press(env, seat, code)
        self._prev = self.input.copy()
        if self.sim.world is not None:
            released = self._digging & ~self.dig_input
            for env, seat in zip(*np.nonzero(released)):
                self.sim.world.dig_stop(seat=int(seat), arena=int(env))
        self._digging = self.dig_input & (self.sim.world is not None)
        if self.hook_on.any():
            self._fly_hooks(hooks_up)
        return busy

    def _body_order(self) -> list[tuple[int, int]]:
        """Return the acting bodies. In a world, a random body of each arena goes first."""
        acting = (self.input != NO_ITEM) | self.dig_input
        env, seat = np.nonzero(acting)
        if self.sim.world is not None and len(env) > 1:
            both = acting.all(axis=1)
            if both.any():
                first = np.zeros(self.sim.n, dtype=np.int64)
                first[both] = self.sim.rng.integers(0, 2, int(both.sum()))
                order = np.lexsort((seat ^ first[env], env))
                env, seat = env[order], seat[order]
        return list(zip(env.tolist(), seat.tolist()))

    def collect(self) -> None:
        """Move dropped items in reach of each body into its inventory."""
        from .world import blocks as B

        sim = self.sim
        heights = sim.body.heights()
        ready = sim.world.pickup_ready(sim.pos, np.full((sim.n, 2), C.PLAYER_WIDTH), heights) & (sim.hp > 0.0)
        if not ready.any():
            return
        if self.picked is None:
            self.picked = np.zeros((sim.n, 2, B.FIRST_ITEM + len(B.ITEMS)), dtype=np.int32)
        codes = {B.ITEM_ID["cobblestone"]: BLOCK, B.ITEM_ID["cobweb"]: COBWEB}
        room = np.empty(256, dtype=np.int32)
        for env, seat in zip(*(where.tolist() for where in np.nonzero(ready))):
            room[:] = B.MAX_CARRY
            room[: self.picked.shape[2]] -= self.picked[env, seat]
            for item, code in codes.items():
                room[item] = B.MAX_CARRY - self.count[env, seat, code]
            found = sim.world.pickup(sim.pos[env, seat], C.PLAYER_WIDTH, float(heights[env, seat]), env, room)
            for item, amount in found:
                self.picked[env, seat, item] += amount
                if item in codes:
                    self.count[env, seat, codes[item]] += amount

    def _flying(self) -> bool:
        if not self._live:
            return False
        self._live = bool(
            self.pearl_on.any()
            or self.splash_on.any()
            or self.hook_on.any()
            or self.pearl_cooldown.any()
            or self.ground_on.any()
        )
        return self._live

    def _pick_up_ground_axe(self) -> None:
        """Give the axe on the arena center to the first player to reach it."""
        sim = self.sim
        reach = np.hypot(sim.pos[..., 0], sim.pos[..., 2]) <= GROUND_PICKUP_REACH
        for env in np.flatnonzero(self.ground_on & reach.any(axis=1)):
            seat = int(np.argmax(reach[env]))
            sim.combat.give_axe(int(env), seat, self.ground_material[int(env)])
            self.ground_on[env] = False

    def _eye(self, env: int, seat: int) -> np.ndarray:
        return self.sim.combat.eye_position(env, seat)

    def _look_of(self, env: int, seat: int) -> np.ndarray:
        return _look(float(self.sim.yaw[env, seat]), float(self.sim.pitch[env, seat]))

    def _consume(self, env: int, seat: int, code: int) -> None:
        combat = self.sim.combat
        self.count[env, seat, code] -= 1
        if code == GOLDEN_APPLE:
            combat.feed(env, seat, GOLDEN_APPLE_FOOD, GOLDEN_APPLE_SATURATION)
            combat.add_effect(env, seat, REGENERATION, *GOLDEN_APPLE_REGEN)
            combat.add_effect(env, seat, ABSORPTION, *GOLDEN_APPLE_ABSORPTION)
            return
        _name, effect, amp, duration = POTIONS[code - FIRST_POTION]
        if effect < 0:
            combat.heal(env, seat, INSTANT_HEAL * (1 << amp))
        else:
            combat.add_effect(env, seat, effect, amp, duration)

    def _press(self, env: int, seat: int, code: int) -> None:
        if code == PEARL:
            self._throw_pearl(env, seat)
        elif code == ROD:
            self._use_rod(env, seat)
        elif code >= FIRST_SPLASH:
            self._throw_splash(env, seat, code)
        elif self.sim.world is not None:
            self._use_on_blocks(env, seat, code)

    def _bodies(self, env: int) -> np.ndarray:
        low, high = self.sim.combat.body_boxes()
        return np.concatenate([low[env], high[env]], axis=1)

    def _use_on_blocks(self, env: int, seat: int, code: int) -> None:
        from .world import blocks as B

        world = self.sim.world
        eye = self._eye(env, seat)
        look = self._look_of(env, seat)
        if code in (WATER_BUCKET, LAVA_BUCKET):
            kind = B.WATER if code == WATER_BUCKET else B.LAVA
            placed, _cell = world.bucket_empty(kind, eye, look, seat=seat, arena=int(env))
            if placed == 1:
                self.count[env, seat, code] -= 1
                self.count[env, seat, EMPTY_BUCKET] += 1
        elif code == EMPTY_BUCKET:
            kind, _cell = world.bucket_fill(eye, look, seat=seat, arena=int(env))
            if kind == B.WATER or kind == B.LAVA:
                self.count[env, seat, EMPTY_BUCKET] -= 1
                self.count[env, seat, WATER_BUCKET if kind == B.WATER else LAVA_BUCKET] += 1
        elif code in (COBWEB, BLOCK):
            block = B.COBWEB if code == COBWEB else B.COBBLESTONE
            placed, _cell = world.place(
                block, eye, look, float(self.sim.yaw[env, seat]), bodies=self._bodies(env), seat=seat, arena=int(env)
            )
            if placed == 1:
                self.count[env, seat, code] -= 1

    def give_tool(
        self,
        env: int,
        seat: int,
        kind: int,
        tier: int,
        efficiency: int = 0,
        unbreaking: int = 0,
        fortune: int = 0,
        silk: bool = False,
    ) -> None:
        """Put a mining tool in a body's hand. It digs in place of the weapon until it breaks."""
        from .world import blocks as B

        if self.tools is None:
            self.tools = HeldTools(self.sim.n)
        tools = self.tools
        tools.kind[env, seat] = kind
        tools.tier[env, seat] = tier
        tools.left[env, seat] = B.TIER_DURABILITY[tier]
        tools.efficiency[env, seat] = efficiency
        tools.unbreaking[env, seat] = unbreaking
        tools.fortune[env, seat] = fortune
        tools.silk[env, seat] = silk

    def set_mining_effects(
        self, env: int, seat: int, haste: int = 0, fatigue: int = 0, aqua: bool = False
    ) -> None:
        """Set the Haste and Mining Fatigue levels and Aqua Affinity of one body."""
        if self.tools is None:
            self.tools = HeldTools(self.sim.n)
        self.tools.haste[env, seat] = haste
        self.tools.fatigue[env, seat] = fatigue
        self.tools.aqua[env, seat] = aqua

    def experience(self, env: int, seat: int) -> int:
        """Return the experience a body has earned from mining this round."""
        return 0 if self.sim.world is None else self.sim.world.experience(seat, env)

    def _axe_tier(self, env: int, seat: int) -> int:
        from .world import blocks as B

        tiers = {
            "wooden": B.TIER_WOOD, "stone": B.TIER_STONE, "iron": B.TIER_IRON,
            "diamond": B.TIER_DIAMOND, "netherite": B.TIER_NETHERITE,
        }
        combat = self.sim.combat
        material = combat.kits[int(combat.kit_id[env, seat])].axe
        return tiers[self.ground_material[int(env)] if material == "none" else material]

    def _dig(self, env: int, seat: int) -> None:
        from .world import blocks as B

        sim = self.sim
        if sim.world is None:
            return
        combat = sim.combat
        tools = self.tools
        held = tools is not None and tools.left[env, seat] > 0
        holds_sword = not held and sim.weapon[env, seat] == C.SWORD and combat.weapon_left[env, seat, C.SWORD] > 0
        holds_axe = not held and sim.weapon[env, seat] == C.AXE and combat.weapon_left[env, seat, C.AXE] > 0
        kind, tier = B.TOOL_NONE, B.TIER_HAND
        level = int(combat._t_unbreaking[combat.kit_id[env, seat]])
        efficiency = fortune = 0
        silk = False
        if held:
            kind, tier = int(tools.kind[env, seat]), int(tools.tier[env, seat])
            level = int(tools.unbreaking[env, seat])
            efficiency, fortune = int(tools.efficiency[env, seat]), int(tools.fortune[env, seat])
            silk = bool(tools.silk[env, seat])
        elif holds_sword:
            kind, tier = B.TOOL_SWORD, B.TIER_DIAMOND
        elif holds_axe:
            kind, tier = B.TOOL_AXE, self._axe_tier(env, seat)
        haste = fatigue = 0
        aqua = False
        if tools is not None:
            haste, fatigue = int(tools.haste[env, seat]), int(tools.fatigue[env, seat])
            aqua = bool(tools.aqua[env, seat])
        code, out = sim.world.dig(
            self._eye(env, seat),
            self._look_of(env, seat),
            tool=kind,
            tier=tier,
            on_ground=bool(sim.on_ground[env, seat]),
            efficiency=efficiency,
            haste=haste,
            fatigue=fatigue,
            aqua=aqua,
            unbreaking=level,
            seat=seat,
            arena=env,
            fortune=fortune,
            silk=silk,
        )
        if code != 1:
            return
        if held:
            tools.left[env, seat] = max(int(tools.left[env, seat]) - out[5], 0)
        elif holds_sword:
            combat.wear_sword(env, seat, out[5])
        elif holds_axe:
            combat.wear_axe(env, seat, out[5])

    def _throw_pearl(self, env: int, seat: int) -> None:
        if self.pearl_cooldown[env, seat] > 0 or self.pearl_on[env, seat]:
            return
        self.count[env, seat, PEARL] -= 1
        self.pearl_cooldown[env, seat] = PEARL_COOLDOWN
        self.pearl_on[env, seat] = True
        self._live = True
        self.pearl_pos[env, seat] = self._eye(env, seat) - np.array([0.0, THROW_DROP, 0.0])
        carried = self.sim.body.last_move[env, seat].copy()
        if self.sim.on_ground[env, seat]:
            carried[1] = 0.0
        self.pearl_vel[env, seat] = self._look_of(env, seat) * PEARL_SPEED + carried

    def _throw_splash(self, env: int, seat: int, code: int) -> None:
        if self.splash_on[env, seat]:
            return
        self.count[env, seat, code] -= 1
        self.splash_on[env, seat] = True
        self._live = True
        self.splash_kind[env, seat] = code - FIRST_SPLASH
        self.splash_pos[env, seat] = self._eye(env, seat) - np.array([0.0, THROW_DROP, 0.0])
        pitch = float(self.sim.pitch[env, seat]) - SPLASH_PITCH_UP
        self.splash_vel[env, seat] = _look(float(self.sim.yaw[env, seat]), pitch) * SPLASH_SPEED

    def _use_rod(self, env: int, seat: int) -> None:
        if not self.hook_on[env, seat]:
            if self.rod_left[env, seat] <= 0:
                return
            yaw = np.radians(float(self.sim.yaw[env, seat]))
            pitch = np.radians(float(self.sim.pitch[env, seat]))
            flat = np.array([-np.sin(yaw), 0.0, np.cos(yaw)])
            aim = flat + np.array([0.0, np.clip(-np.tan(pitch), -ROD_MAX_SLOPE, ROD_MAX_SLOPE), 0.0])
            self.hook_on[env, seat] = True
            self._live = True
            self.hook_state[env, seat] = HOOK_FLYING
            self.hook_pos[env, seat] = self._eye(env, seat) + flat * ROD_START
            self.hook_vel[env, seat] = aim * (ROD_BASE_SPEED / np.linalg.norm(aim) + ROD_EXTRA_SPEED)
            return
        state = self.hook_state[env, seat]
        if state == HOOK_ON_PLAYER:
            victim = 1 - seat
            owner = self.sim.pos[env, seat]
            hook = self.sim.pos[env, victim].copy()
            hook[1] += HOOK_BODY_FRACTION * float(self.sim.body.heights()[env, victim])
            self.sim.combat.pull(env, victim, (owner - hook) * ROD_PULL)
            self._spend_rod(env, seat, ROD_COST_PULL)
        elif state == HOOK_STUCK:
            self._spend_rod(env, seat, ROD_COST_GROUND)
        self.hook_on[env, seat] = False

    def _spend_rod(self, env: int, seat: int, cost: int) -> None:
        combat = self.sim.combat
        level = int(combat._t_unbreaking[combat.kit_id[env, seat]])
        if level > 0:
            cost = int(self.sim.rng.binomial(cost, 1.0 / (level + 1.0)))
        self.rod_left[env, seat] = max(int(self.rod_left[env, seat]) - cost, 0)
        if self.rod_left[env, seat] == 0:
            self.count[env, seat, ROD] = 0

    def _block_time(self, idx: np.ndarray, start: np.ndarray, vel: np.ndarray) -> np.ndarray:
        """Return the first fraction of this tick's move that meets a block, or inf."""
        sim = self.sim
        out = np.full(len(idx), np.inf)
        if sim.world is None:
            down = vel[:, 1] < 0.0
            out[down] = np.maximum(start[down, 1], 0.0) / -vel[down, 1]
            out[out > 1.0] = np.inf
            end = start + vel
            limit = sim.cfg.arena_half
            wall = (np.abs(end[:, 0]) > limit) | (np.abs(end[:, 2]) > limit)
            out[wall] = np.minimum(out[wall], 1.0)
            return out
        length = np.maximum(np.linalg.norm(vel, axis=1), 1e-9)
        eye = np.zeros((sim.n, 1, 3))
        direction = np.zeros((sim.n, 1, 3))
        direction[:, 0, 1] = -1.0
        eye[idx, 0] = start
        direction[idx, 0] = vel / length[:, None]
        hit, _cell, _face, dist = sim.world.ray_collide_many(eye, direction, float(length.max()))
        got = hit[idx, 0] & (dist[idx, 0] <= length)
        out[got] = dist[idx, 0][got] / length[got]
        return out

    def _body_time(self, idx: np.ndarray, seat: int, start: np.ndarray, vel: np.ndarray) -> np.ndarray:
        """Return the first fraction of this tick's move that meets the other player, or inf."""
        low, high = self.sim.combat.body_boxes()
        other = 1 - seat
        box_low = low[idx, other] - PROJECTILE_MARGIN
        box_high = high[idx, other] + PROJECTILE_MARGIN
        d = np.where(np.abs(vel) < 1e-9, 1e-9, vel)
        t1 = (box_low - start) / d
        t2 = (box_high - start) / d
        near = np.maximum(np.minimum(t1, t2).max(axis=1), 0.0)
        far = np.maximum(t1, t2).min(axis=1)
        out = np.full(len(idx), np.inf)
        got = (far >= near) & (near <= 1.0)
        out[got] = near[got]
        return out

    def _fly_pearls(self) -> None:
        sim = self.sim
        self.pearl_on &= sim.hp > 0.0
        for seat in (0, 1):
            idx = np.flatnonzero(self.pearl_on[:, seat])
            if len(idx) == 0:
                continue
            start = self.pearl_pos[idx, seat].copy()
            vel = self.pearl_vel[idx, seat].copy()
            vel[:, 1] -= PEARL_GRAVITY
            vel *= PEARL_DRAG
            stop = np.minimum(self._block_time(idx, start, vel), self._body_time(idx, seat, start, vel))
            landed = np.isfinite(stop)
            for k in np.flatnonzero(landed):
                env = int(idx[k])
                sim.pos[env, seat] = start[k]
                if sim.world is None:
                    sim.pos[env, seat, 1] = max(start[k, 1], 0.0)
                sim.vel[env, seat] = 0.0
                sim.combat.teleported(env, seat)
                sim.combat.hurt_one(env, seat, PEARL_DAMAGE, PEARL_LANDING)
                self.pearl_on[env, seat] = False
            keep = ~landed
            kept = idx[keep]
            self.pearl_pos[kept, seat] = start[keep] + vel[keep]
            self.pearl_vel[kept, seat] = vel[keep]

    def _fly_splashes(self) -> None:
        for seat in (0, 1):
            idx = np.flatnonzero(self.splash_on[:, seat])
            if len(idx) == 0:
                continue
            start = self.splash_pos[idx, seat].copy()
            vel = self.splash_vel[idx, seat].copy()
            vel[:, 1] -= SPLASH_GRAVITY
            vel *= SPLASH_DRAG
            stop = np.minimum(self._block_time(idx, start, vel), self._body_time(idx, seat, start, vel))
            landed = np.isfinite(stop)
            for k in np.flatnonzero(landed):
                env = int(idx[k])
                at = start[k] + vel[k] * min(float(stop[k]), 1.0)
                self._burst(env, at, int(self.splash_kind[env, seat]))
                self.splash_on[env, seat] = False
            keep = ~landed
            kept = idx[keep]
            self.splash_pos[kept, seat] = start[keep] + vel[keep]
            self.splash_vel[kept, seat] = vel[keep]

    def _burst(self, env: int, at: np.ndarray, potion: int) -> None:
        combat = self.sim.combat
        _name, effect, amp, duration = POTIONS[potion]
        for seat in (0, 1):
            center = self.sim.pos[env, seat] + np.array([0.0, C.PLAYER_HEIGHT / 2.0, 0.0])
            distance = float(np.linalg.norm(center - at))
            if distance >= SPLASH_RADIUS:
                continue
            scale = 1.0 - distance / SPLASH_RADIUS
            if effect < 0:
                combat.heal(env, seat, INSTANT_HEAL * (1 << amp) * scale)
                continue
            ticks = int(duration * scale)
            if ticks > SPLASH_MIN_TICKS:
                combat.add_effect(env, seat, effect, amp, ticks)

    def repeat_press(self, mask: np.ndarray, seat: int) -> None:
        """Make a held use key press again on the next tick."""
        self._prev[mask, seat] = NO_ITEM

    def _fly_hooks(self, ready: np.ndarray | None = None) -> None:
        """Move hooks cast before this tick. A new hook first moves on the next tick."""
        ready = self.hook_on.copy() if ready is None else ready
        anchor = self.hook_pos.copy()
        on_player = self.hook_on & (self.hook_state == HOOK_ON_PLAYER)
        anchor[on_player] = self.sim.pos[:, ::-1][on_player]
        far = np.linalg.norm(anchor - self.sim.pos, axis=-1) > HOOK_RANGE
        self.hook_on &= ~far
        for seat in (0, 1):
            idx = np.flatnonzero(self.hook_on[:, seat] & ready[:, seat] & (self.hook_state[:, seat] == HOOK_FLYING))
            if len(idx) == 0:
                continue
            start = self.hook_pos[idx, seat].copy()
            vel = self.hook_vel[idx, seat].copy()
            vel[:, 1] -= ROD_GRAVITY
            block = self._block_time(idx, start, vel)
            body = self._body_time(idx, seat, start, vel)
            caught = np.isfinite(body) & (body <= block)
            stuck = np.isfinite(block) & ~caught
            self.hook_state[idx[caught], seat] = HOOK_ON_PLAYER
            self.hook_state[idx[stuck], seat] = HOOK_STUCK
            done = caught | stuck
            self.hook_pos[idx[done], seat] = start[done]
            keep = ~done
            kept = idx[keep]
            self.hook_pos[kept, seat] = start[keep] + vel[keep]
            self.hook_vel[kept, seat] = vel[keep] * ROD_DRAG
