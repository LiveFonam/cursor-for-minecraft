"""Fluid order, buckets, fire, random ticks, drops, stacks, falling blocks, pockets and held tools."""

import pickle
from dataclasses import replace

import numpy as np
import pytest
from world_helpers import FLOOR, aim, empty_raw, flat_raw, make, yi

from fighter import actions as A
from fighter import constants as C
from fighter.sim import Sim, SimConfig
from fighter.world import blocks as B
from fighter.world import gen, pool
from fighter.world.config import FULL, SURFACE, WorldConfig

Y = FLOOR + 1
DOWN = (0.0, -1.0, 0.0)
OK = 1
W_BLOCK, W_FLUID = 0, 1
NO_RANDOM = WorldConfig(random_ticks=False)
DIAMOND = B.ORE_IDS["diamond"][0]
REST_VY = -C.GRAVITY * C.VERTICAL_DRAG


def _floor(**kw):
    return make(flat_raw(), config=kw.pop("config", NO_RANDOM), **kw)


# Fluid order and shapes.


def test_fluid_falls_before_it_spreads_sideways():
    world = _floor()
    world.set(16, Y + 4, 16, B.WATER_SOURCE)
    world.tick(5)
    assert world.get(16, Y + 3, 16) == B.fluid(B.WATER, 8, True)
    for side in ((17, 16), (15, 16), (16, 17), (16, 15)):
        assert world.block(side[0], Y + 4, side[1]) == B.AIR


@pytest.mark.parametrize("east,west,wet_east,wet_west", [(2, 3, True, False), (3, 2, False, True), (2, 2, True, True)])
def test_flow_takes_only_the_nearest_drops(east, west, wet_east, wet_west):
    raw = flat_raw()
    raw[16 + east, 16, yi(FLOOR)] = B.AIR
    raw[16 - west, 16, yi(FLOOR)] = B.AIR
    world = make(raw, config=NO_RANDOM)
    world.set(16, Y, 16, B.WATER_SOURCE)
    world.tick(5)
    assert (world.block(17, Y, 16) == B.WATER) == wet_east
    assert (world.block(15, Y, 16) == B.WATER) == wet_west
    assert world.block(16, Y, 15) == B.AIR
    assert world.block(16, Y, 17) == B.AIR


def test_block_ticks_run_before_fluid_ticks_in_schedule_order():
    world = _floor()
    world.poke(10, Y, 10, B.WATER_SOURCE)
    world.poke(12, Y, 10, B.WATER_SOURCE)
    world.poke(20, Y, 20, B.SAND)
    world.poke(22, Y, 20, B.SAND)
    world.trace_on()
    world.schedule(W_FLUID, 12, Y, 10, 3)
    world.schedule(W_FLUID, 10, Y, 10, 3)
    world.schedule(W_BLOCK, 22, Y, 20, 3)
    world.schedule(W_BLOCK, 20, Y, 20, 3)
    world.tick(3)
    rows = world.trace()
    assert rows[:, 2].tolist() == [W_BLOCK, W_BLOCK, W_FLUID, W_FLUID]
    size = world.base.nz * B.WORLD_HEIGHT
    assert (rows[:, 1] // size).tolist() == [22, 20, 12, 10]


def test_full_faces_block_flow_and_open_sides_pass():
    world = _floor()
    world.poke(16, Y, 16, B.stairs(B.COBBLE_STAIRS, B.NORTH, waterlogged=True))
    world.schedule(W_FLUID, 16, Y, 16, 1)
    world.tick(1)
    assert world.block(16, Y, 15) == B.AIR
    assert world.block(16, Y, 17) == B.WATER
    assert world.block(17, Y, 16) == B.WATER
    assert world.block(15, Y, 16) == B.WATER


@pytest.mark.parametrize("cell", [
    B.door(B.OAK_DOOR, B.NORTH),
    B.ladder(B.NORTH),
    B.COBBLESTONE,
    B.GLASS,
    B.slab(B.COBBLE_SLAB),
    B.leaves(1),
], ids=["door", "ladder", "solid", "glass", "slab", "leaves"])
def test_fluid_cannot_enter_these_blocks(cell):
    world = _floor()
    world.poke(17, Y, 16, cell)
    world.poke(17, Y, 17, B.STONE)
    if cell & 0xFF == B.OAK_DOOR:
        world.poke(17, Y + 1, 16, B.door(B.OAK_DOOR, B.NORTH, upper=True))
    world.set(16, Y, 16, B.WATER_SOURCE)
    world.tick(12)
    assert world.get(17, Y, 16) == cell


@pytest.mark.parametrize("cell", [B.torch(), B.COBWEB], ids=["torch", "cobweb"])
def test_lava_destroys_thin_blocks_without_a_drop(cell):
    world = _floor()
    world.poke(17, Y, 16, cell)
    world.set(16, Y, 16, B.LAVA_SOURCE)
    world.tick(30)
    assert world.block(17, Y, 16) == B.LAVA
    assert len(world.items()) == 0


@pytest.mark.parametrize("amount,lava_above,replaced", [(6, False, True), (4, False, True), (2, False, False), (2, True, True)])
def test_water_replaces_only_thick_lava(amount, lava_above, replaced):
    world = _floor()
    world.poke(16, Y, 16, B.WATER_SOURCE)
    world.poke(17, Y, 16, B.fluid(B.LAVA, amount))
    if lava_above:
        world.poke(17, Y + 1, 16, B.fluid(B.LAVA, 2))
    world.schedule(W_FLUID, 16, Y, 16, 1)
    world.tick(1)
    assert (world.block(17, Y, 16) == B.WATER) == replaced
    if not replaced:
        assert world.get(17, Y, 16) == B.fluid(B.LAVA, amount)


# Buckets.


@pytest.mark.parametrize("kind,flow,block", [
    (B.WATER, B.fluid(B.WATER, 5), B.WATER),
    (B.LAVA, B.fluid(B.LAVA, 4), B.LAVA),
    (B.WATER, B.fluid(B.LAVA, 4), B.WATER),
], ids=["water_on_water", "lava_on_lava", "water_on_lava"])
def test_bucket_over_a_flow_makes_a_source(kind, flow, block):
    world = _floor()
    world.poke(16, Y, 16, flow)
    code, cell = world.bucket_empty(kind, (16.5, Y + 2.5, 16.5), DOWN)
    assert code == OK and cell == (16, Y, 16)
    assert world.get(16, Y, 16) == B.fluid(block)


def test_water_bucket_fills_a_waterloggable_block_and_lava_does_not():
    world = _floor()
    world.poke(16, Y, 16, B.slab(B.COBBLE_SLAB))
    code, cell = world.bucket_empty(B.WATER, (16.5, Y + 2.5, 16.5), DOWN)
    assert code == OK and cell == (16, Y, 16)
    assert world.get(16, Y, 16) == B.slab(B.COBBLE_SLAB, waterlogged=True)
    other = _floor()
    other.poke(16, Y, 16, B.slab(B.COBBLE_SLAB))
    code, cell = other.bucket_empty(B.LAVA, (16.5, Y + 2.5, 16.5), DOWN)
    assert code == OK and cell == (16, Y + 1, 16)
    assert other.get(16, Y, 16) == B.slab(B.COBBLE_SLAB)


# Fire.


def test_flammability_table():
    table = {b.name: (b.ignite, b.burn) for b in B.BLOCKS}
    assert table["oak_log"] == (5, 5)
    assert table["oak_planks"] == (5, 20)
    assert table["oak_leaves"] == (30, 60)
    assert table["stone"] == (0, 0)


def test_fire_ticks_every_30_to_39_ticks():
    world = _floor(seed=3)
    world.poke(17, Y, 16, B.LOG)
    world.trace_on(30000)
    world.set(16, Y, 16, B.fire())
    world.tick(1500)
    size = world.base.nz * B.WORLD_HEIGHT
    target = 16 * size + 16 * B.WORLD_HEIGHT + yi(Y)
    rows = world.trace()
    fired = rows[(rows[:, 1] == target) & (rows[:, 2] == W_BLOCK), 0]
    gaps = np.diff(fired)
    assert len(gaps) > 10
    assert gaps.min() >= 30 and gaps.max() <= 39


def test_fire_age_rises_with_chance_one_third():
    n = 400
    world = make(flat_raw(), n=n, seed=5, config=NO_RANDOM)
    for arena in range(n):
        world.poke(17, Y, 16, B.LOG, arena)
        world.set(16, Y, 16, B.fire(), arena)
    world.tick(40)
    ages = [(world.get(16, Y, 16, arena) >> 8) & 15 for arena in range(n) if world.block(16, Y, 16, arena) == B.FIRE]
    assert len(ages) > 300
    assert np.mean(ages) == pytest.approx(1 / 3, abs=0.08)


def test_fire_burns_a_plank_away():
    raw = flat_raw()
    raw[17, 16, yi(Y)] = B.PLANKS
    world = make(raw, seed=2, config=NO_RANDOM)
    world.set(16, Y, 16, B.fire())
    for _ in range(40000):
        world.tick(1)
        if world.block(17, Y, 16) != B.PLANKS:
            break
        if world.block(16, Y, 16) != B.FIRE:
            world.set(16, Y, 16, B.fire())
    assert world.block(17, Y, 16) != B.PLANKS


def _lava_beside_log(config):
    raw = flat_raw()
    raw[12:20, 12:20, yi(Y)] = B.LAVA_SOURCE
    raw[15:17, 15:17, yi(Y + 2)] = B.LOG
    return make(raw, seed=7, config=config)


def test_lava_lights_air_beside_a_flammable_block():
    world = _lava_beside_log(FULL)
    for _ in range(6000):
        world.tick(1)
        if ((world.dump() & 0xFF) == B.FIRE).any():
            break
    assert ((world.dump() & 0xFF) == B.FIRE).any()


def test_lava_lights_nothing_with_fire_off():
    world = _lava_beside_log(WorldConfig(fire=False))
    world.tick(3000)
    assert not ((world.dump() & 0xFF) == B.FIRE).any()


def test_items_burn_in_fire_and_lava():
    world = _floor()
    world.poke(16, Y, 16, B.fire())
    world.spawn_item(16.5, Y + 0.1, 16.5, B.ITEM_ID["coal"])
    world.spawn_item(20.5, Y + 0.1, 20.5, B.ITEM_ID["coal"])
    world.tick(4)
    assert len(world.items()) == 2
    world.tick(1)
    rows = world.items()
    assert len(rows) == 1 and rows[0, 0] == pytest.approx(20.5)
    lava = _floor()
    lava.poke(16, Y, 16, B.LAVA_SOURCE)
    lava.spawn_item(16.5, Y + 0.1, 16.5, B.ITEM_ID["coal"])
    lava.tick(1)
    assert len(lava.items()) == 0


# Placing.


@pytest.mark.parametrize("eye,target,placed", [
    ((16.5, Y + 5.0, 16.5), (16.5, Y + 3.0, 16.5), (16, Y + 3, 16)),
    ((16.5, Y + 0.5, 16.5), (16.5, Y + 2.0, 16.5), (16, Y + 1, 16)),
    ((16.5, Y + 2.5, 13.5), (16.5, Y + 2.5, 16.0), (16, Y + 2, 15)),
    ((16.5, Y + 2.5, 19.5), (16.5, Y + 2.5, 17.0), (16, Y + 2, 17)),
    ((13.5, Y + 2.5, 16.5), (16.0, Y + 2.5, 16.5), (15, Y + 2, 16)),
    ((19.5, Y + 2.5, 16.5), (17.0, Y + 2.5, 16.5), (17, Y + 2, 16)),
], ids=["top", "bottom", "north", "south", "west", "east"])
def test_any_face_accepts_a_block(eye, target, placed):
    world = _floor()
    world.poke(16, Y + 2, 16, B.STONE)
    code, cell = world.place(B.COBBLESTONE, eye, aim(eye, target), 0.0)
    assert code == OK and cell == placed
    assert world.block(*placed) == B.COBBLESTONE


@pytest.mark.parametrize("cell", [B.WATER_SOURCE, B.LAVA_SOURCE, B.fluid(B.WATER, 3), B.fire()],
                         ids=["water", "lava", "flow", "fire"])
def test_fluids_and_fire_are_replaced_by_a_placed_block(cell):
    world = _floor()
    world.poke(16, Y, 16, cell)
    code, target = world.place(B.COBBLESTONE, (16.5, Y + 2.5, 16.5), DOWN, 0.0)
    assert code == OK and target == (16, Y, 16)
    assert world.block(16, Y, 16) == B.COBBLESTONE


def test_a_log_keeps_its_axis_and_full_collision():
    world = _floor()
    for axis in range(3):
        world.poke(16, Y, 16 + axis * 2, B.log(axis))
    pos = np.array([[[16.5, Y + 2.0, 16.5]]])
    width, height = np.array([[0.6]]), np.array([[1.8]])
    out, _, ground = world.collide_many(pos, np.array([[[0.0, -3.0, 0.0]]]), width, height)
    assert ground[0, 0] and out[0, 0, 1] == pytest.approx(Y + 1.0)
    for axis in range(3):
        assert (world.get(16, Y, 16 + axis * 2) >> 8) & 3 == axis


# Breaking.


def _break_ticks(block, tool, tier, **kw):
    world = _floor()
    world.poke(16, Y, 16, block)
    eye = (16.5, Y + 2.5, 16.5)
    for tick in range(1, 400):
        code, _ = world.dig(eye, DOWN, tool, tier, **kw)
        if code == OK:
            return tick
        world.tick(1)
    raise AssertionError("block did not break")


@pytest.mark.parametrize("kw,ticks", [
    ({"efficiency": 5}, 2),
    ({"efficiency": 1}, 5),
    ({"haste": 2}, 5),
    ({"fatigue": 1}, 19),
    ({"fatigue": 2}, 63),
], ids=["efficiency_5", "efficiency_1", "haste_2", "fatigue_1", "fatigue_2"])
def test_enchantment_and_effect_break_times(kw, ticks):
    assert _break_ticks(B.STONE, B.TOOL_PICKAXE, B.TIER_DIAMOND, **kw) == ticks


def test_instant_break_needs_one_tick_and_leaves_no_delay():
    world = _floor()
    eye = (16.5, Y + 2.5, 16.5)
    fast = dict(tool=B.TOOL_PICKAXE, tier=B.TIER_DIAMOND, efficiency=5, haste=2)
    world.poke(16, Y, 16, B.STONE)
    assert world.dig(eye, DOWN, **fast)[0] == OK
    world.tick(1)
    assert world.dig(eye, DOWN, **fast)[0] == OK


def test_shears_break_leaves_at_once_as_recorded():
    assert _break_ticks(B.leaves(1), B.TOOL_SHEARS, B.TIER_HAND) == 1


def _mean_drop(block, samples=2500, **kw):
    world = _floor(seed=11)
    eye = (16.5, Y + 2.5, 16.5)
    total = 0
    for _ in range(samples):
        world.reset()
        world.poke(16, Y, 16, block)
        code, _info = world.dig(eye, DOWN, B.TOOL_PICKAXE, B.TIER_DIAMOND, efficiency=40, **kw)
        assert code == OK
        total += world.items()[:, 4].sum()
    return total / samples


@pytest.mark.parametrize("level,mean", [(0, 1.0), (1, 4 / 3), (2, 1.75), (3, 2.2)])
def test_fortune_on_a_single_drop_ore(level, mean):
    assert _mean_drop(DIAMOND, fortune=level) == pytest.approx(mean, abs=0.09)


@pytest.mark.parametrize("level,mean", [(1, 5.0), (3, 6.0)])
def test_fortune_on_redstone_adds_to_the_maximum(level, mean):
    assert _mean_drop(B.ORE_IDS["redstone"][0], fortune=level) == pytest.approx(mean, abs=0.12)


def test_fortune_on_lapis_multiplies_the_range():
    assert _mean_drop(B.ORE_IDS["lapis"][0], fortune=3) == pytest.approx(14.3, abs=0.6)


def test_fortune_three_always_gives_flint_from_gravel():
    world = _floor(seed=4)
    eye = (16.5, Y + 2.5, 16.5)
    for _ in range(50):
        world.reset()
        world.poke(16, Y, 16, B.GRAVEL)
        world.dig(eye, DOWN, B.TOOL_SHOVEL, B.TIER_DIAMOND, efficiency=40, fortune=3)
        assert world.items()[0, 3] == B.ITEM_ID["flint"]


@pytest.mark.parametrize("block,item", [
    (B.STONE, "stone"),
    (DIAMOND, "diamond_ore"),
    (B.GRASS, "grass_block"),
], ids=["stone", "ore", "grass"])
def test_silk_touch_drops_the_block_itself(block, item):
    world = _floor()
    world.poke(16, Y, 16, block)
    tool = B.TOOL_SHOVEL if block == B.GRASS else B.TOOL_PICKAXE
    code, info = world.dig((16.5, Y + 2.5, 16.5), DOWN, tool, B.TIER_DIAMOND, efficiency=40, silk=True)
    assert code == OK and info[6] == 0
    rows = world.items()
    assert rows[0, 3] == B.ITEM_ID[item] and rows[0, 4] == 1


@pytest.mark.parametrize("cell,item", [(B.leaves(1), "oak_leaves"), (B.COBWEB, "cobweb")], ids=["leaves", "cobweb"])
def test_shears_keep_leaves_and_cobweb(cell, item):
    world = _floor()
    world.poke(16, Y, 16, cell)
    eye = (16.5, Y + 2.5, 16.5)
    for _ in range(30):
        code, _info = world.dig(eye, DOWN, B.TOOL_SHEARS, B.TIER_HAND)
        if code == OK:
            break
        world.tick(1)
    assert world.items()[0, 3] == B.ITEM_ID[item]


@pytest.mark.parametrize("name,low,high", [("coal", 0, 2), ("lapis", 2, 5), ("redstone", 1, 5), ("diamond", 3, 7)])
def test_ores_give_their_experience_range(name, low, high):
    for block in B.ORE_IDS[name]:
        world = _floor(seed=9)
        seen = set()
        for _ in range(250):
            world.reset()
            world.poke(16, Y, 16, block)
            _code, info = world.dig((16.5, Y + 2.5, 16.5), DOWN, B.TOOL_PICKAXE, B.TIER_DIAMOND, efficiency=40)
            seen.add(info[6])
            assert world.experience() == info[6]
        assert seen == set(range(low, high + 1))


@pytest.mark.parametrize("name", ["iron", "gold", "copper"])
def test_raw_metal_ores_give_no_experience(name):
    world = _floor()
    world.poke(16, Y, 16, B.ORE_IDS[name][0])
    _code, info = world.dig((16.5, Y + 2.5, 16.5), DOWN, B.TOOL_PICKAXE, B.TIER_DIAMOND, efficiency=40)
    assert info[6] == 0


# Stacks and merging.


def test_items_merge_close_together_every_40_ticks():
    world = _floor()
    coal = B.ITEM_ID["coal"]
    world.spawn_item(16.3, Y, 16.5, coal, 3, delay=0)
    world.spawn_item(16.7, Y, 16.5, coal, 5, delay=0)
    world.tick(39)
    assert len(world.items()) == 2
    world.tick(1)
    rows = world.items()
    assert len(rows) == 1 and rows[0, 4] == 8
    assert rows[0, 0] == pytest.approx(16.7)


def test_items_apart_or_of_another_kind_do_not_merge():
    world = _floor()
    world.spawn_item(16.2, Y, 16.5, B.ITEM_ID["coal"], 1, delay=0)
    world.spawn_item(16.8, Y, 16.5, B.ITEM_ID["coal"], 1, delay=0)
    world.spawn_item(20.3, Y, 20.5, B.ITEM_ID["coal"], 1, delay=0)
    world.spawn_item(20.5, Y, 20.5, B.ITEM_ID["diamond"], 1, delay=0)
    world.tick(40)
    assert len(world.items()) == 4


def test_a_merged_stack_stops_at_64():
    world = _floor()
    coal = B.ITEM_ID["coal"]
    world.spawn_item(16.4, Y, 16.5, coal, 40, delay=0)
    world.spawn_item(16.6, Y, 16.5, coal, 40, delay=0)
    world.tick(40)
    assert sorted(world.items()[:, 4].tolist()) == [16.0, 64.0]


def test_pickup_takes_only_what_fits_and_leaves_the_rest():
    world = _floor()
    coal = B.ITEM_ID["coal"]
    world.spawn_item(16.5, Y, 16.5, coal, 10, delay=0)
    room = np.full(256, B.MAX_CARRY, dtype=np.int32)
    room[coal] = 4
    assert world.pickup((16.5, Y, 16.5), room=room) == [(coal, 4)]
    assert world.items()[0, 4] == 6
    room[coal] = 0
    assert world.pickup((16.5, Y, 16.5), room=room) == []
    assert world.pickup((16.5, Y, 16.5)) == [(coal, 6)]


def test_a_body_carries_at_most_36_stacks():
    sim = _sim()
    sim.items.picked = np.zeros((1, 2, B.FIRST_ITEM + len(B.ITEMS)), dtype=np.int32)
    coal = B.ITEM_ID["coal"]
    sim.items.picked[0, 0, coal] = B.MAX_CARRY - 1
    sim.world.spawn_item(16.5, Y, 16.5, coal, 5, delay=0)
    sim.items.collect()
    assert sim.items.picked[0, 0, coal] == B.MAX_CARRY
    assert sim.world.items()[0, 4] == 4
    sim.close()


def test_a_body_collects_drops_it_did_not_cause():
    sim = _sim()
    coal = B.ITEM_ID["coal"]
    sim.world.spawn_item(16.5, Y, 16.5, coal, 3, delay=0)
    sim.items.collect()
    assert sim.items.picked[0, 0, coal] == 3
    assert len(sim.world.items()) == 0
    sim.close()


def test_a_body_out_of_reach_collects_nothing():
    sim = _sim()
    sim.world.spawn_item(22.5, Y, 16.5, B.ITEM_ID["coal"], 3, delay=0)
    sim.items.collect()
    assert sim.items.picked is None
    assert len(sim.world.items()) == 1
    sim.close()


# Falling blocks.


def test_sand_waits_two_ticks_before_it_falls():
    world = _floor()
    world.set(16, Y + 4, 16, B.SAND)
    world.tick(1)
    assert world.block(16, Y + 4, 16) == B.SAND and world.falling_count() == 0
    world.tick(1)
    assert world.block(16, Y + 4, 16) == B.AIR and world.falling_count() == 1


def test_fluid_does_not_slow_a_falling_block():
    dry = _floor()
    wet = _floor()
    for y in range(Y, Y + 16):
        wet.poke(16, y, 16, B.WATER_SOURCE)
    for world in (dry, wet):
        world.spawn_falling(16.5, Y + 14.0, 16.5, B.SAND)
    for _ in range(12):
        dry.tick(1)
        wet.tick(1)
        assert wet.falling_vy() == dry.falling_vy()


def test_falling_block_turns_into_an_item_at_600_ticks():
    world = _floor()
    world.spawn_falling(16.5, Y + 30.0, 16.5, B.SAND, age=599)
    world.tick(1)
    assert world.falling_count() == 0
    assert world.items()[0, 3] == B.ITEM_ID["sand"]


def test_falling_block_at_the_world_floor_turns_into_an_item_at_100_ticks():
    raw = empty_raw()
    world = make(raw, config=NO_RANDOM)
    world.spawn_falling(16.5, B.Y_MIN + 0.5, 16.5, B.SAND, age=98)
    world.tick(1)
    assert world.falling_count() == 1
    world.spawn_falling(16.5, B.Y_MIN + 0.5, 18.5, B.SAND, age=99)
    world.tick(1)
    assert world.items()[:, 3].tolist().count(B.ITEM_ID["sand"]) >= 1


# Random ticks.


def _tree_raw():
    raw = flat_raw()
    raw[16, 16, yi(Y) : yi(Y + 4)] = B.log(1)
    raw[14:19, 14:19, yi(Y + 4)] = B.leaves(1)
    raw[16, 16, yi(Y + 4)] = B.log(1)
    return raw


def _count(world, block):
    return int(((world.dump() & 0xFF) == block).sum())


def test_connected_leaves_stay():
    world = make(_tree_raw(), seed=1)
    before = _count(world, B.LEAVES)
    world.tick(4000)
    assert _count(world, B.LEAVES) == before


def test_leaves_decay_after_the_log_is_cut():
    world = make(_tree_raw(), seed=1)
    for y in range(Y, Y + 5):
        world.set(16, y, 16, B.AIR)
    world.tick(20000)
    assert _count(world, B.LEAVES) == 0


def test_decaying_leaves_can_drop_saplings_and_sticks():
    raw = flat_raw()
    raw[4:28, 4:28, yi(Y + 2)] = B.leaves(7)
    world = make(raw, seed=8)
    seen = set()
    for _ in range(3000):
        world.tick(1)
        seen |= {int(item) for item in world.items()[:, 3]}
    assert B.ITEM_ID["oak_sapling"] in seen
    assert B.ITEM_ID["stick"] in seen


def test_a_leaf_six_steps_from_a_log_stays_and_seven_decays():
    raw = flat_raw()
    raw[8, 16, yi(Y + 3)] = B.log(1)
    raw[9:16, 16, yi(Y + 3)] = B.leaves(1)
    world = make(raw, seed=2)
    world.tick(30000)
    assert world.block(14, Y + 3, 16) == B.LEAVES
    assert world.block(15, Y + 3, 16) == B.AIR


def test_player_placed_leaves_never_decay():
    raw = flat_raw()
    raw[10:14, 10:14, yi(Y + 2)] = B.leaves(7, placed=True)
    world = make(raw, seed=2)
    world.tick(6000)
    assert _count(world, B.LEAVES) == 16


def test_grass_spreads_to_open_dirt():
    raw = flat_raw(block=B.DIRT)
    raw[16, 16, yi(FLOOR)] = B.GRASS
    world = make(raw, seed=3)
    world.tick(12000)
    assert world.block(17, FLOOR, 16) == B.GRASS
    assert world.block(15, FLOOR, 16) == B.GRASS


def test_grass_does_not_spread_under_a_roof():
    raw = flat_raw(block=B.DIRT)
    raw[:, :, yi(Y + 3)] = B.STONE
    raw[16, 16, yi(FLOOR)] = B.GRASS
    world = make(raw, seed=3)
    world.tick(6000)
    assert _count(world, B.GRASS) <= 1


@pytest.mark.parametrize("cover", [B.STONE, B.slab(B.COBBLE_SLAB), B.WATER_SOURCE], ids=["stone", "slab", "water"])
def test_covered_grass_turns_to_dirt(cover):
    raw = flat_raw()
    raw[8:24, 8:24, yi(FLOOR)] = B.GRASS
    raw[8:24, 8:24, yi(Y)] = cover
    world = make(raw, seed=3, config=WorldConfig(fluids=False, fire=False)) if cover != B.WATER_SOURCE else make(raw, seed=3)
    world.tick(12000)
    assert _count(world, B.GRASS) == 0


def test_grass_under_leaves_survives():
    raw = flat_raw()
    raw[12:20, 12:20, yi(FLOOR)] = B.GRASS
    raw[12:20, 12:20, yi(Y)] = B.leaves(7, placed=True)
    world = make(raw, seed=3)
    world.tick(4000)
    assert _count(world, B.GRASS) == 64


def test_each_section_gets_three_random_ticks():
    raw = empty_raw(16)
    raw[:, :, yi(64) : yi(64) + 16] = B.leaves(7)
    world = make(raw, seed=6)
    start = _count(world, B.LEAVES)
    ticks = 40
    world.tick(ticks)
    removed = start - _count(world, B.LEAVES)
    assert 0.9 * 3 * ticks <= removed <= 3 * ticks


def test_an_unedited_section_ticks_each_cell_with_the_same_chance():
    raw = empty_raw(16)
    raw[:8, :, yi(64) : yi(64) + 4] = B.leaves(7)
    arenas = 3000
    world = make(raw, n=arenas, seed=12)
    world.tick(1)
    removed = sum(world.edits(arena) for arena in range(arenas))
    expected = arenas * 3 * (8 * 16 * 4) / 4096
    assert removed == pytest.approx(expected, rel=0.08)


def _mixed_raw():
    raw = flat_raw(block=B.DIRT)
    raw[4:12, 4:12, yi(FLOOR)] = B.GRASS
    raw[20:26, 20:26, yi(FLOOR)] = B.GRASS
    raw[20:26, 20:26, yi(Y)] = B.STONE
    raw[8, 24, yi(Y) : yi(Y + 4)] = B.log(1)
    raw[6:11, 22:27, yi(Y + 4)] = B.leaves(1)
    raw[24:28, 4:8, yi(Y + 6)] = B.leaves(7)
    raw[14:16, 14:16, yi(Y + 8)] = B.leaves(7, placed=True)
    return raw


def test_listed_cells_settle_like_a_full_read_of_every_cell():
    listed = make(_mixed_raw(), seed=21)
    live = make(_mixed_raw(), seed=22)
    for x in range(0, 32, 16):
        for z in range(0, 32, 16):
            live.poke(x, Y + 20, z, B.AIR)
    listed.tick(200000)
    live.tick(200000)
    assert np.array_equal(listed.dump() & 0xFF, live.dump() & 0xFF)


def test_an_unedited_forest_does_no_random_tick_writes():
    raw = _tree_raw()
    raw[:, :, yi(FLOOR)] = B.GRASS
    raw[16, 16, yi(FLOOR)] = B.DIRT
    world = make(raw, seed=4)
    world.tick(5000)
    assert world.writes() == 0 and world.edits() == 0


def test_an_edit_wakes_grass_in_the_next_chunk():
    raw = flat_raw()
    raw[15, 16, yi(FLOOR)] = B.GRASS
    world = make(raw, seed=4)
    world.tick(100)
    assert world.writes() == 0
    world.set(16, FLOOR, 16, B.DIRT)
    world.tick(200000)
    assert world.block(16, FLOOR, 16) == B.GRASS


def test_random_ticks_can_be_switched_off():
    world = make(_tree_raw(), seed=1, config=NO_RANDOM)
    for y in range(Y, Y + 5):
        world.set(16, y, 16, B.AIR)
    before = _count(world, B.LEAVES)
    world.tick(4000)
    assert _count(world, B.LEAVES) == before


def test_placed_blocks_join_the_random_tick_list_until_reset():
    world = make(flat_raw(), seed=5)
    world.set(10, Y + 40, 10, B.leaves(7))
    world.tick(40000)
    assert world.block(10, Y + 40, 10) == B.AIR
    world.reset()
    assert world.block(10, Y + 40, 10) == B.AIR
    world.set(10, Y + 40, 10, B.leaves(7, placed=True))
    world.tick(2000)
    assert world.block(10, Y + 40, 10) == B.LEAVES


# Generated pockets.


@pytest.fixture(scope="module")
def terrain():
    return gen.generate(7, 128)


def test_dirt_and_gravel_pockets_lie_in_their_bands(terrain):
    raw, info = terrain
    ids = raw & 0xFF
    soil_top = (info.height - B.Y_MIN - 4)[..., None]
    depth = np.arange(B.WORLD_HEIGHT)[None, None, :] < soil_top
    dirt_y = np.flatnonzero(((ids == B.DIRT) & depth).any(axis=(0, 1))) + B.Y_MIN
    gravel_y = np.flatnonzero(((ids == B.GRAVEL) & depth).any(axis=(0, 1))) + B.Y_MIN
    assert len(dirt_y) and dirt_y.min() >= -5
    assert len(gravel_y) and gravel_y.min() < -30 and gravel_y.max() > 30


def test_rock_pockets_lie_in_their_bands(terrain):
    raw, _info = terrain
    ids = raw & 0xFF
    for block in (B.GRANITE, B.DIORITE, B.ANDESITE):
        ys = np.flatnonzero((ids == block).any(axis=(0, 1))) + B.Y_MIN
        assert len(ys) and ys.min() >= -5
    tuff = np.flatnonzero((ids == B.TUFF).any(axis=(0, 1))) + B.Y_MIN
    assert len(tuff) and tuff.max() <= 5


@pytest.mark.parametrize("neighbour,touches", [(B.AIR, False), (B.WATER_SOURCE, True), (B.LAVA_SOURCE, True)],
                         ids=["air", "water", "lava"])
def test_full_discard_skips_only_cells_beside_air(neighbour, touches):
    placed_beside = False
    for seed in range(12):
        raw = np.full((24, 24, 48), B.STONE, dtype=np.uint16)
        raw[12, 12, 24] = neighbour
        gen._blob(raw, gen.Stream(seed), B.ORE_IDS["coal"][0], None, 17, 12, 24, 12, discard=1.0)
        ore = raw == B.ORE_IDS["coal"][0]
        beside = ore[11, 12, 24] | ore[13, 12, 24] | ore[12, 11, 24] | ore[12, 13, 24] | ore[12, 12, 23] | ore[12, 12, 25]
        placed_beside |= bool(beside)
        assert ore.any()
    assert placed_beside == touches


def test_settling_a_world_runs_no_random_ticks():
    raw, _info = gen.generate(3, 64)
    ticking, _ = pool.settle(raw.copy(), FULL)
    quiet, _ = pool.settle(raw.copy(), replace(FULL, random_ticks=False))
    assert np.array_equal(ticking, quiet)


# Work done per change.


def test_one_edit_writes_one_cell_and_wakes_only_its_neighbours():
    raw = flat_raw()
    raw[8:24, 8:24, yi(Y)] = B.WATER_SOURCE
    world = make(raw, config=NO_RANDOM)
    world.set(16, Y + 3, 16, B.COBBLESTONE)
    assert world.edits() == 1 and world.writes() == 1 and world.pending() == 0
    world.set(16, Y, 16, B.AIR)
    assert world.edits() == 2 and world.pending() <= 6


def test_quiet_fluids_cost_no_ticks():
    raw = flat_raw()
    raw[8:24, 8:24, yi(Y)] = B.WATER_SOURCE
    world = make(raw, config=NO_RANDOM)
    world.tick(500)
    assert world.fluid_ticks() == 0 and world.block_ticks() == 0 and world.pending() == 0


# Held tools through the simulator.


def _sim(raw=None, **kw):
    sim = Sim(1, SimConfig(armor="none", arena_half=64.0, **kw))
    sim.attach_world(make(flat_raw() if raw is None else raw, config=NO_RANDOM))
    sim.pos[0, 0] = [16.5, Y, 16.5]
    sim.pos[0, 1] = [28.5, Y, 28.5]
    sim.vel[0] = [0.0, REST_VY, 0.0]
    sim.yaw[0] = 0.0
    sim.pitch[0] = [90.0, 0.0]
    sim.on_ground[0] = True
    return sim


def _dig_until_broken(sim, x, y, z, limit=400):
    idle = np.tile(A.idle_action(), (1, 2, 1))
    sim.items.dig_input[0, 0] = True
    for tick in range(1, limit):
        sim.pitch[0, 0] = 90.0
        sim._tick(idle, first=True)
        if sim.world.block(x, y, z) == B.AIR:
            sim.items.dig_input[0, 0] = False
            return tick
    raise AssertionError("block did not break")


def test_a_held_pickaxe_digs_wears_out_and_breaks():
    sim = _sim()
    sim.items.give_tool(0, 0, B.TOOL_PICKAXE, B.TIER_IRON)
    assert sim.items.tools.left[0, 0] == 250
    assert _dig_until_broken(sim, 16, FLOOR, 16) == 8
    assert sim.items.tools.left[0, 0] == 249
    sim.items.tools.left[0, 0] = 1
    sim.world.set(16, FLOOR, 16, B.STONE)
    sim.pos[0, 0] = [16.5, Y, 16.5]
    sim.vel[0, 0] = [0.0, REST_VY, 0.0]
    sim.on_ground[0, 0] = True
    _dig_until_broken(sim, 16, FLOOR, 16)
    assert sim.items.tools.left[0, 0] == 0
    sim.close()


def test_a_held_axe_cuts_logs_at_its_tier():
    raw = flat_raw()
    raw[16, 16, yi(FLOOR)] = B.log(1)
    sim = _sim(raw)
    sim.weapon[0, 0] = C.AXE
    before = int(sim.combat.weapon_left[0, 0, C.AXE])
    assert _dig_until_broken(sim, 16, FLOOR, 16) == 8
    assert sim.combat.weapon_left[0, 0, C.AXE] == before - 1
    sim.close()


def test_held_tool_enchantments_reach_the_drop():
    raw = flat_raw()
    raw[16, 16, yi(FLOOR)] = DIAMOND
    sim = _sim(raw)
    sim.items.give_tool(0, 0, B.TOOL_PICKAXE, B.TIER_DIAMOND, efficiency=5, silk=True)
    _dig_until_broken(sim, 16, FLOOR, 16)
    assert sim.world.items()[0, 3] == DIAMOND
    assert sim.items.experience(0, 0) == 0
    sim.close()


def test_mining_effects_change_the_break_time():
    sim = _sim()
    sim.items.give_tool(0, 0, B.TOOL_PICKAXE, B.TIER_IRON)
    sim.items.set_mining_effects(0, 0, haste=2)
    assert _dig_until_broken(sim, 16, FLOOR, 16) == 6
    sim.close()


def test_tools_clear_on_reset():
    sim = _sim()
    sim.items.give_tool(0, 0, B.TOOL_PICKAXE, B.TIER_IRON, fortune=3)
    sim.items.set_mining_effects(0, 0, haste=1)
    sim.items.reset(np.array([0]), sim.combat.kit_id, sim.combat.kits)
    tools = sim.items.tools
    assert tools.left[0, 0] == 0 and tools.fortune[0, 0] == 0 and tools.haste[0, 0] == 0
    sim.close()


def test_the_flat_arena_makes_no_tool_state():
    sim = Sim(2, SimConfig())
    sim.step(np.tile(A.idle_action(), (2, 2, 1)))
    assert sim.items.tools is None
    assert "tools" not in vars(sim.items)
    assert sim.items.experience(0, 0) == 0


def test_a_saved_state_without_tool_fields_still_resets():
    sim = Sim(2, SimConfig())
    state = pickle.loads(pickle.dumps(sim.items.__dict__.copy() | {"sim": None}))
    assert "tools" not in state
    sim.items.__dict__.update({k: v for k, v in state.items() if k != "sim"})
    sim.reset()
    assert sim.items.tools is None


# Server copy lift-off on terrain.


def _lift_pair(raw, floor_y):
    flat = Sim(1, SimConfig(armor="none", arena_half=10000.0))
    flat.pos[0, 0] = [0.0, 0.0, -6.0]
    flat.pos[0, 1] = [0.0, 0.0, 6.0]
    terrain = Sim(1, SimConfig(armor="none", arena_half=10000.0))
    terrain.attach_world(make(raw, config=NO_RANDOM))
    terrain.pos[0, 0] = [16.5, floor_y, 10.5]
    terrain.pos[0, 1] = [16.5, floor_y, 22.5]
    for sim in (flat, terrain):
        sim.yaw[0] = [0.0, 180.0]
        sim.vel[0] = [0.0, REST_VY, 0.0]
    return flat, terrain


def _copy_paths(flat, terrain, script, kick=None):
    """Run both simulators on one script and return their server vertical speeds."""
    paths = ([], [])
    for tick, jump in enumerate(script):
        action = np.tile(A.idle_action(), (1, 2, 1))
        action[0, 0, A.JUMP] = int(jump)
        for out, sim in zip(paths, (flat, terrain)):
            if kick is not None and tick == kick:
                sim.vel[0, 0, 1] = 0.4
            sim._tick(action, first=True)
            out.append(float(sim.combat.server_vel[0, 0, 1]))
    return np.array(paths[0]), np.array(paths[1])


SLAB_RAW = flat_raw()
SLAB_RAW[:, :, yi(Y)] = B.slab(B.COBBLE_SLAB)


@pytest.mark.parametrize("raw,floor_y", [(flat_raw(), float(Y)), (SLAB_RAW, Y + 0.5)], ids=["block_floor", "slab_floor"])
@pytest.mark.parametrize("script,kick", [
    ([0] * 6 + [1] + [0] * 30, None),
    ([0] * 6 + [1] * 45, None),
    ([0] * 40, 6),
], ids=["standing_jump", "held_jump", "knockback_lift"])
def test_terrain_lift_off_matches_the_flat_arena(raw, floor_y, script, kick):
    flat, terrain = _lift_pair(raw, floor_y)
    flat_path, terrain_path = _copy_paths(flat, terrain, script, kick)
    assert terrain_path == pytest.approx(flat_path, abs=1e-6)
    assert np.isclose(terrain_path, 0.42, atol=1e-9).any()
    terrain.close()


def test_a_standing_jump_reaches_the_copy_two_ticks_later_on_terrain():
    _flat, terrain = _lift_pair(flat_raw(), float(Y))
    action = np.tile(A.idle_action(), (1, 2, 1))
    for _ in range(4):
        terrain._tick(action, first=True)
    action[0, 0, A.JUMP] = 1
    terrain._tick(action, first=True)
    assert terrain.combat.server_vel[0, 0, 1] != pytest.approx(0.42)
    action[0, 0, A.JUMP] = 0
    terrain._tick(action, first=True)
    assert terrain.combat.server_vel[0, 0, 1] == pytest.approx(0.42)
    terrain.close()


def test_the_copy_lands_on_a_raised_block():
    raw = flat_raw()
    raw[16, 10, yi(Y)] = B.STONE
    _flat, terrain = _lift_pair(raw, Y + 1.0)
    terrain.pos[0, 0, 1] = Y + 2.0
    terrain.on_ground[0, 0] = False
    action = np.tile(A.idle_action(), (1, 2, 1))
    for _ in range(25):
        terrain._tick(action, first=True)
    assert terrain.on_ground[0, 0]
    assert terrain.pos[0, 0, 1] == pytest.approx(Y + 1.0)
    assert terrain.combat.server_ground[0, 0]
    assert terrain.combat.server_vel[0, 0, 1] == pytest.approx(-C.GRAVITY * C.VERTICAL_DRAG)
    terrain.close()


@pytest.mark.parametrize("name", ["surface", "full"])
def test_named_profiles_use_the_lift_off_rule(name, tmp_path):
    sim = Sim(1, SimConfig(armor="none", profile=name, world_size=64, world_cache=str(tmp_path)))
    action = np.tile(A.idle_action(), (1, 2, 1))
    for _ in range(6):
        sim._tick(action, first=True)
    assert sim.on_ground[0, 0]
    action[0, 0, A.JUMP] = 1
    sim._tick(action, first=True)
    action[0, 0, A.JUMP] = 0
    assert sim.combat.server_vel[0, 0, 1] != pytest.approx(0.42)
    sim._tick(action, first=True)
    assert sim.combat.server_vel[0, 0, 1] == pytest.approx(0.42)
    sim.close()


def test_profile_flags_turn_random_ticks_on():
    assert FULL.random_ticks and SURFACE.random_ticks
