"""UHC inputs: inventory, body state and what the body has seen nearby.

Block inputs come only from each body's seen block memory. A cell the body has
never seen reads as unknown, so nothing behind a wall can reach the network.
"""

from __future__ import annotations

import numpy as np

from . import actions as A
from . import constants as C
from . import items as I
from . import obs as shared
from .interface import InputBlock, Interface
from .sim import Sim
from .world.view import (
    AIR_CLASS,
    COBWEB_CLASS,
    FIRE_CLASS,
    LAVA_CLASS,
    SOLID_BY_CLASS,
    UNKNOWN,
    WATER_CLASS,
)

ITEM_CODES = (
    I.NO_ITEM,
    I.GOLDEN_APPLE,
    I.WATER_BUCKET,
    I.LAVA_BUCKET,
    I.EMPTY_BUCKET,
    I.COBWEB,
    I.BLOCK,
    I.PEARL,
    I.ROD,
)
NUM_ITEM_ACTIONS = len(ITEM_CODES)
KIT_ITEMS = ITEM_CODES[1:]
COUNT_SCALE = {
    I.GOLDEN_APPLE: 8.0,
    I.WATER_BUCKET: 4.0,
    I.LAVA_BUCKET: 2.0,
    I.EMPTY_BUCKET: 4.0,
    I.COBWEB: 8.0,
    I.BLOCK: 64.0,
    I.PEARL: 2.0,
    I.ROD: 1.0,
}

CROP_RADIUS = 3
NUM_DIRECTIONS = 8
TARGET_KINDS = 7
FULL_ARMOR_DURABILITY = float(sum(I.ARMOR_DURABILITY["diamond"]))
FIRE_SCALE = 300.0
FALL_SCALE = 8.0
REGEN_SCALE = 100.0
ABSORPTION_SCALE = 2400.0
ARROW_SCALE = 16.0
ABSORPTION_HEALTH = 4.0

INVENTORY_DIM = 2 * len(KIT_ITEMS) + 4 + C.NUM_WEAPONS
STATUS_DIM = 16
HANDS_DIM = NUM_ITEM_ACTIONS + 2
ENEMY_DIM = NUM_ITEM_ACTIONS + 3
BODY_DIM = INVENTORY_DIM + STATUS_DIM + HANDS_DIM + ENEMY_DIM
WORLD_DIM = 4 * NUM_DIRECTIONS + 4 + TARGET_KINDS + 3 + NUM_DIRECTIONS
EXTRA_DIM = BODY_DIM + WORLD_DIM

_DIR_X = np.array([0, -1, -1, -1, 0, 1, 1, 1])
_DIR_Z = np.array([1, 1, 0, -1, -1, -1, 0, 1])
_STEPS = np.arange(1, CROP_RADIUS + 1)
_AXIS = np.arange(-CROP_RADIUS, CROP_RADIUS + 1)
_GRID = np.sqrt((np.stack(np.meshgrid(_AXIS, _AXIS, _AXIS, indexing="ij")) ** 2).sum(axis=0))


def shared_dim() -> int:
    """Return the current size of the shared inputs."""
    return int(shared.OBS_DIM)


def total_dim() -> int:
    """Return the size of the whole UHC input."""
    return shared_dim() + EXTRA_DIM


def layout() -> dict[str, slice]:
    """Return where each input block sits in the full vector."""
    start = shared_dim()
    return {
        "shared": slice(0, start),
        "body": slice(start, start + BODY_DIM),
        "world": slice(start + BODY_DIM, start + EXTRA_DIM),
    }


def _fan(crop: np.ndarray, shift: np.ndarray, dy: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Walk eight body relative directions through the seen cells of one layer."""
    n = len(crop)
    rows = np.arange(n)[:, None, None]
    world = (np.arange(NUM_DIRECTIONS)[None, :] + shift[:, None]) % NUM_DIRECTIONS
    x = CROP_RADIUS + _DIR_X[world][..., None] * _STEPS
    z = CROP_RADIUS + _DIR_Z[world][..., None] * _STEPS
    y = np.clip(CROP_RADIUS + dy, 0, 2 * CROP_RADIUS)[:, None, None]
    cells = crop[rows, x, z, y]
    stops = SOLID_BY_CLASS[cells] | (cells == UNKNOWN)
    hit = stops.any(axis=2)
    first = stops.argmax(axis=2)
    free = np.where(hit, first, CROP_RADIUS) / CROP_RADIUS
    stop_cell = np.take_along_axis(cells, first[..., None], axis=2)[..., 0]
    return free, hit & (stop_cell == UNKNOWN), cells


def _column(crop: np.ndarray, start: np.ndarray, step: int) -> tuple[np.ndarray, np.ndarray]:
    """Walk up or down the seen column through the body and report the free run."""
    n = len(crop)
    offsets = start[:, None] + step * np.arange(CROP_RADIUS)[None, :]
    inside = (offsets >= -CROP_RADIUS) & (offsets <= CROP_RADIUS)
    y = np.clip(offsets + CROP_RADIUS, 0, 2 * CROP_RADIUS)
    cells = crop[np.arange(n)[:, None], CROP_RADIUS, CROP_RADIUS, y]
    cells = np.where(inside, cells, UNKNOWN)
    stops = SOLID_BY_CLASS[cells] | (cells == UNKNOWN)
    hit = stops.any(axis=1)
    first = stops.argmax(axis=1)
    free = np.where(hit, first, CROP_RADIUS) / CROP_RADIUS
    stop_cell = cells[np.arange(n), first]
    return free, hit & (stop_cell == UNKNOWN)


def _nearest(crop: np.ndarray, kind: int) -> np.ndarray:
    """Return the distance to the nearest seen cell of a class, scaled to at most 1."""
    limit = float(_GRID.max())
    return np.where(crop == kind, _GRID, limit).min(axis=(1, 2, 3)) / limit


def _crosshair(sim: Sim, seat: int, rows: np.ndarray | None = None) -> np.ndarray:
    """Return the seen class under the crosshair as one of seven kinds."""
    picked = np.arange(sim.n) if rows is None else np.asarray(rows)
    out = np.zeros((len(picked), TARGET_KINDS), dtype=np.float32)
    view = sim.world_view()
    eyes = sim.eyes()[:, seat]
    looks = sim.look()[:, seat]
    for row, env in enumerate(picked.tolist()):
        kind = view.target(env, seat, eyes[env], looks[env])
        if kind == UNKNOWN:
            slot = 0
        elif kind == AIR_CLASS:
            slot = 1
        elif kind == WATER_CLASS:
            slot = 2
        elif kind == LAVA_CLASS:
            slot = 3
        elif kind == COBWEB_CLASS:
            slot = 4
        elif kind == FIRE_CLASS:
            slot = 5
        else:
            slot = 6
        out[row, slot] = 1.0
    return out


def world_features(sim: Sim, seat: int, rows: np.ndarray | None = None) -> np.ndarray:
    """Return the block inputs of one seat, read from its seen memory."""
    at = slice(None) if rows is None else np.asarray(rows)
    count = sim.n if rows is None else len(at)
    out = np.zeros((count, WORLD_DIM), dtype=np.float32)
    if sim.world is None or count == 0:
        return out
    crop = sim.world_view().crop_all(2, CROP_RADIUS, CROP_RADIUS, CROP_RADIUS)[at, seat]
    eyes = sim.eyes()[at, seat, 1]
    feet = np.floor(sim.pos[at, seat, 1]).astype(np.int64) - np.floor(eyes).astype(np.int64)
    shift = np.rint(sim.yaw[at, seat] / 45.0).astype(np.int64)
    free_feet, unknown_feet, cells = _fan(crop, shift, feet)
    free_eye, unknown_eye, _ = _fan(crop, shift, np.zeros(count, dtype=np.int64))
    at = 0
    for block in (free_feet, unknown_feet, free_eye, unknown_eye):
        out[:, at : at + NUM_DIRECTIONS] = block
        at += NUM_DIRECTIONS
    down, down_unknown = _column(crop, feet - 1, -1)
    up, up_unknown = _column(crop, np.ones(count, dtype=np.int64), 1)
    out[:, at] = down
    out[:, at + 1] = down_unknown
    out[:, at + 2] = up
    out[:, at + 3] = up_unknown
    at += 4
    out[:, at : at + TARGET_KINDS] = _crosshair(sim, seat, rows)
    at += TARGET_KINDS
    for kind in (WATER_CLASS, LAVA_CLASS, COBWEB_CLASS):
        out[:, at] = _nearest(crop, kind)
        at += 1
    first = cells[:, :, 0]
    bad = (first == LAVA_CLASS) | (first == COBWEB_CLASS) | (first == FIRE_CLASS) | (first == UNKNOWN)
    out[:, at : at + NUM_DIRECTIONS] = ~bad & ~SOLID_BY_CLASS[first]
    return out


def body_features(sim: Sim, hands, seat: int, rows: np.ndarray | None = None) -> np.ndarray:
    """Return inventory, body state, held item and visible enemy state of one seat."""
    out = _all_body_features(sim, hands, seat)
    return out if rows is None else out[np.asarray(rows)]


def _all_body_features(sim: Sim, hands, seat: int) -> np.ndarray:
    n = sim.n
    you = 1 - seat
    rows = np.arange(n)
    items = sim.items
    combat = sim.combat
    out = np.zeros((n, BODY_DIM), dtype=np.float32)
    at = 0
    for code in KIT_ITEMS:
        count = items.count[:, seat, code]
        out[:, at] = count > 0
        out[:, at + 1] = np.minimum(count / COUNT_SCALE[code], 1.0)
        at += 2
    weapons = hands.legal_weapons(seat)
    out[:, at] = items.rod_left[:, seat] / I.ROD_DURABILITY
    out[:, at + 1] = np.minimum(sim.ammo[:, seat] / ARROW_SCALE, 1.0)
    out[:, at + 2 : at + 2 + C.NUM_WEAPONS] = weapons[:, : C.NUM_WEAPONS]
    out[:, at + 2 + C.NUM_WEAPONS] = combat.has_shield[:, seat]
    out[:, at + 3 + C.NUM_WEAPONS] = np.minimum(combat.armor_left[:, seat].sum(axis=1) / FULL_ARMOR_DURABILITY, 1.0)
    at += INVENTORY_DIM - 2 * len(KIT_ITEMS)

    fire = combat.fire[:, seat]
    out[:, at] = combat.absorption[:, seat] / ABSORPTION_HEALTH
    out[:, at + 1] = combat.food[:, seat] / 20.0
    out[:, at + 2] = combat.saturation[:, seat] / 20.0
    out[:, at + 3] = fire > 0
    out[:, at + 4] = np.maximum(fire, 0) / FIRE_SCALE
    out[:, at + 5] = combat.in_water[:, seat]
    out[:, at + 6] = combat.in_lava[:, seat]
    out[:, at + 7] = combat.in_web[:, seat]
    out[:, at + 8] = np.minimum(combat.fall_distance[:, seat] / FALL_SCALE, 1.0)
    out[:, at + 9] = combat.effect_time[:, seat, I.REGENERATION] / REGEN_SCALE
    out[:, at + 10] = combat.effect_time[:, seat, I.ABSORPTION] / ABSORPTION_SCALE
    out[:, at + 11] = items.pearl_cooldown[:, seat] / I.PEARL_COOLDOWN
    out[:, at + 12] = items.pearl_on[:, seat]
    out[:, at + 13] = items.hook_on[:, seat]
    out[:, at + 14] = items.hook_on[:, seat] & (items.hook_state[:, seat] == I.HOOK_ON_PLAYER)
    out[:, at + 15] = np.minimum(items.use_ticks[:, seat] / I.USE_DURATION, 1.0)
    at += STATUS_DIM

    out[rows, at + hands.held[:, seat]] = 1.0
    out[:, at + NUM_ITEM_ACTIONS] = np.minimum(hands.since[:, seat] / 4.0, 1.0)
    out[:, at + NUM_ITEM_ACTIONS + 1] = hands.use_held(seat)
    at += HANDS_DIM

    out[rows, at + hands.held[:, you]] = 1.0
    out[:, at + NUM_ITEM_ACTIONS] = combat.fire[:, you] > 0
    out[:, at + NUM_ITEM_ACTIONS + 1] = items.use_ticks[:, you] > 0
    out[:, at + NUM_ITEM_ACTIONS + 2] = items.pearl_on[:, you]
    return out


def build_uhc_obs(sim: Sim, hands, seat: int, max_ticks: int, rows: np.ndarray | None = None) -> np.ndarray:
    """Return the shared inputs followed by the UHC inputs."""
    base = np.clip(shared.build_obs(sim, seat, max_ticks, rows), -5.0, 5.0)
    return np.concatenate([base, body_features(sim, hands, seat, rows), world_features(sim, seat, rows)], axis=1)


def uhc_masks(
    sim, hands, seat: int, allowed: np.ndarray | None = None, rows: np.ndarray | None = None
) -> np.ndarray:
    """Return shared head masks followed by the item head mask, for this step's inventory."""
    at = slice(None) if rows is None else np.asarray(rows)
    mask = shared.build_masks(sim, seat, allowed, rows)
    off = A.HEAD_OFFSETS
    combat = sim.combat
    weapons = hands.legal_weapons(seat)[at]
    mask[:, off[A.WEAPON] + A.WEAPON_ACTION] &= weapons
    items = hands.legal_items(seat)[at]

    weapon = sim.weapon[at, seat]
    melee = weapon <= C.AXE
    shield = melee & combat.has_shield[at, seat] & (sim.shield_disabled[at, seat] == 0)
    bow = (weapon == C.BOW) & weapons[:, C.BOW]
    crossbow = (weapon == C.CROSSBOW) & weapons[:, C.CROSSBOW]
    held_use = (shield | bow | crossbow) & ~sim.load_wait[at, seat]
    mask[:, off[A.USE] + 1] = held_use | items[:, 1:].any(axis=1)
    mask[:, off[A.JUMP] + 1] |= combat.in_water[at, seat] | combat.in_lava[at, seat] | combat.in_web[at, seat]
    if sim.world is not None:
        target = _crosshair(sim, seat, rows)
        mask[:, off[A.ATTACK] + A.ATTACK_CLICK] |= melee & (target[:, 4:].sum(axis=1) > 0)
    return np.concatenate([mask, items], axis=1)


class UhcInterface(Interface):
    """The shared inputs and heads plus the UHC blocks and the item head.

    The simulator it reads must carry its hands as `sim.uhc_hands`.
    """

    def __init__(self) -> None:
        super().__init__(
            inputs=(
                InputBlock("uhc_body", BODY_DIM, lambda sim, seat, rows: body_features(sim, sim.uhc_hands, seat, rows)),
                InputBlock("uhc_world", WORLD_DIM, world_features),
            ),
            heads=(A.Head("item", NUM_ITEM_ACTIONS),),
        )

    def masks(
        self, sim, seat: int, allowed_weapons: np.ndarray | None = None, rows: np.ndarray | None = None
    ) -> np.ndarray:
        """Return the masks for this step's inventory, including the item head."""
        return uhc_masks(sim, sim.uhc_hands, seat, allowed_weapons, rows)


UHC_INTERFACE = UhcInterface()
