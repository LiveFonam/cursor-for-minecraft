"""Targeting, placing, breaking, drops, falling blocks, block states, waterlogging and fire."""

import numpy as np
import pytest
from world_helpers import FLOOR, Body, aim, empty_raw, flat_raw, make, yi

from fighter.world import blocks as B

Y = FLOOR + 1
DOWN = (0.0, -1.0, 0.0)
UP = (0.0, 1.0, 0.0)
OK = 1
COOLDOWN, NO_TARGET, OUT, OCCUPIED, BODY, NO_SUPPORT = -1, -2, -3, -4, -5, -6


def _entry(origin, direction, low, high, reach):
    t0, t1, axis = -1e30, reach, -1
    for i in range(3):
        if abs(direction[i]) < 1e-12:
            if origin[i] < low[i] or origin[i] > high[i]:
                return None
            continue
        a, b = (low[i] - origin[i]) / direction[i], (high[i] - origin[i]) / direction[i]
        if a > b:
            a, b = b, a
        if a > t0:
            t0, axis = a, i
        t1 = min(t1, b)
        if t0 > t1:
            return None
    return None if t0 < 0 else (t0, axis)


def test_target_ray_matches_brute_force_on_random_boxes():
    rng = np.random.default_rng(11)
    raw = empty_raw(16)
    shapes = {}
    for _ in range(90):
        x, y, z = rng.integers(4, 12, 3)
        kind = int(rng.integers(0, 3))
        cell = (int(x), int(y) + 60, int(z))
        raw[cell[0], cell[2], yi(cell[1])] = [B.STONE, B.slab(B.COBBLE_SLAB, 0), B.slab(B.COBBLE_SLAB, 1)][kind]
        low = (0.0, 0.5 if kind == 2 else 0.0, 0.0)
        high = (1.0, 0.5 if kind == 1 else 1.0, 1.0)
        shapes[cell] = (np.add(cell, low), np.add(cell, high))
    world = make(raw)
    count = 3000
    eye = np.column_stack([rng.uniform(3, 13, count), rng.uniform(63, 73, count), rng.uniform(3, 13, count)])
    look = rng.normal(size=(count, 3))
    look /= np.linalg.norm(look, axis=1, keepdims=True)
    hit, cells, faces, dist = world.ray_block_many(eye[None], look[None], 4.5)
    names = {0: (B.FACE_WEST, B.FACE_EAST), 1: (B.FACE_DOWN, B.FACE_UP), 2: (B.FACE_NORTH, B.FACE_SOUTH)}
    hits = 0
    for i in range(count):
        best = None
        for cell, (low, high) in shapes.items():
            found = _entry(eye[i], look[i], low, high, 4.5)
            if found and (best is None or found[0] < best[0]):
                best = (found[0], found[1], cell)
        assert bool(hit[0, i]) == (best is not None)
        if best is not None:
            hits += 1
            assert tuple(cells[0, i]) == best[2]
            assert dist[0, i] == pytest.approx(best[0])
            assert faces[0, i] == names[best[1]][0 if look[i, best[1]] > 0 else 1]
    assert hits > 300


def test_pillar_from_rules():
    world = make(flat_raw())
    body = Body(world, 16.5, Y, 16.5, pitch=90.0)
    placed = 0
    for _ in range(120):
        if placed < 3 and body.p[1] >= Y + placed + 1.0:
            code, cell = world.place(B.COBBLESTONE, body.eye, body.look, body.yaw, [body.box])
            if code == OK:
                assert cell == (16, Y + placed, 16)
                placed += 1
        world.tick(1)
        body.tick(jump=placed < 3, step=0.0)
    assert placed == 3
    assert body.p[1] == pytest.approx(Y + 3.0)


def test_bridge_from_rules():
    raw = empty_raw()
    raw[:21, :, : yi(FLOOR) + 1] = B.STONE
    world = make(raw)
    body = Body(world, 21.2, Y, 16.5, yaw=90.0)
    target = (21.0, FLOOR + 0.5, 16.5)
    code, cell = world.place(B.COBBLESTONE, body.eye, aim(body.eye, target), body.yaw, [body.box])
    assert code == OK and cell == (21, FLOOR, 16)
    for _ in range(4):
        world.tick(1)
    body.pos[0, 0, 0] = 22.2
    code, cell = world.place(B.COBBLESTONE, body.eye, aim(body.eye, (22.0, FLOOR + 0.5, 16.5)), body.yaw, [body.box])
    assert code == OK and cell == (22, FLOOR, 16)
    for _ in range(20):
        body.tick(step=0.0)
    assert body.p[1] == pytest.approx(Y)


def test_clutch_block_while_falling():
    world = make(flat_raw())
    body = Body(world, 16.5, Y + 12.0, 16.5, pitch=90.0, ground=False)
    done = False
    for _ in range(60):
        if not done:
            code, cell = world.place(B.COBBLESTONE, body.eye, body.look, body.yaw, [body.box])
            if code == OK:
                assert not body.ground and cell == (16, Y, 16)
                done = True
        world.tick(1)
        body.tick(step=0.0)
    assert done
    assert body.p[1] == pytest.approx(Y + 1.0)


def test_placing_into_a_body_is_refused():
    world = make()
    body = Body(world, 16.5, Y, 16.5, pitch=90.0)
    code, _ = world.place(B.COBBLESTONE, body.eye, body.look, body.yaw, [body.box])
    assert code == BODY
    assert world.block(16, Y, 16) == B.AIR
    code, _ = world.place(B.TORCH, body.eye, body.look, body.yaw, [body.box])
    assert code == OK


def test_place_cooldown_is_four_ticks():
    world = make()
    eye = (10.5, Y + 2.5, 10.5)
    assert world.place(B.COBBLESTONE, eye, DOWN, 0.0)[0] == OK
    for wait in range(3):
        world.tick(1)
        assert world.place(B.COBBLESTONE, eye, DOWN, 0.0)[0] == COOLDOWN, wait
    world.tick(1)
    assert world.place(B.COBBLESTONE, eye, DOWN, 0.0)[0] == OK


def test_build_limits_and_reach():
    world = make(flat_raw(floor=B.Y_MAX - 1))
    eye = (5.5, B.Y_MAX + 3.0, 5.5)
    assert world.place(B.COBBLESTONE, eye, DOWN, 0.0)[0] == OK
    world.tick(4)
    assert world.place(B.COBBLESTONE, eye, DOWN, 0.0)[0] == OUT
    far = make()
    assert far.place(B.COBBLESTONE, (5.5, Y + 6.0, 5.5), DOWN, 0.0)[0] == NO_TARGET


def _dig_ticks(block, tool, tier, limit=400, **kw):
    world = make()
    world.poke(16, Y, 16, block)
    eye = (16.5, Y + 2.5, 16.5)
    for tick in range(1, limit):
        code, info = world.dig(eye, DOWN, tool, tier, **kw)
        if code == OK:
            return tick, info, world
        assert code == 0
        world.tick(1)
    raise AssertionError("block did not break")


@pytest.mark.parametrize(
    "block,tool,tier,ticks",
    [
        (B.STONE, B.TOOL_NONE, B.TIER_HAND, 150),
        (B.STONE, B.TOOL_PICKAXE, B.TIER_WOOD, 23),
        (B.ORE_IDS["diamond"][0], B.TOOL_PICKAXE, B.TIER_IRON, 15),
        (B.OBSIDIAN, B.TOOL_PICKAXE, B.TIER_DIAMOND, 188),
        (B.DIRT, B.TOOL_NONE, B.TIER_HAND, 15),
    ],
    ids=["hand_stone", "wood_stone", "iron_diamond_ore", "diamond_obsidian", "hand_dirt"],
)
def test_exact_break_ticks(block, tool, tier, ticks):
    assert _dig_ticks(block, tool, tier, limit=500)[0] == ticks


def test_break_modifiers():
    base = _dig_ticks(B.DIRT, B.TOOL_NONE, B.TIER_HAND)[0]
    assert _dig_ticks(B.DIRT, B.TOOL_NONE, B.TIER_HAND, on_ground=False)[0] == base * 5
    assert _dig_ticks(B.STONE, B.TOOL_PICKAXE, B.TIER_DIAMOND, efficiency=5)[0] < 8
    assert _dig_ticks(B.DIRT, B.TOOL_NONE, B.TIER_HAND, haste=2)[0] == 11


def test_wrong_tier_gives_no_drop():
    iron = B.ORE_IDS["iron"][0]
    _, info, world = _dig_ticks(iron, B.TOOL_PICKAXE, B.TIER_WOOD)
    assert info[4] == 0 and len(world.items()) == 0
    _, info, world = _dig_ticks(iron, B.TOOL_PICKAXE, B.TIER_STONE)
    assert info[4] == 1 and world.items()[0, 3] == B.ITEM_ID["raw_iron"]


def test_durability_costs():
    assert _dig_ticks(B.DIRT, B.TOOL_SWORD, B.TIER_IRON)[1][5] == 2
    assert _dig_ticks(B.STONE, B.TOOL_PICKAXE, B.TIER_IRON)[1][5] == 1
    assert _dig_ticks(B.torch(), B.TOOL_PICKAXE, B.TIER_IRON)[1][5] == 0


def test_unbreaking_applies_each_cost_with_its_chance():
    world = make()
    eye = (16.5, Y + 2.5, 16.5)
    costs = []
    for _ in range(2000):
        world.poke(16, Y, 16, B.DIRT)
        while True:
            code, info = world.dig(eye, DOWN, B.TOOL_SHOVEL, B.TIER_GOLD, unbreaking=3)
            world.tick(1)
            if code == OK:
                costs.append(info[5])
                break
    assert np.mean(costs) == pytest.approx(0.25, abs=0.04)


def test_bedrock_cannot_be_dug_and_target_change_resets_progress():
    world = make()
    world.poke(16, Y, 16, B.BEDROCK)
    assert world.dig((16.5, Y + 2.5, 16.5), DOWN)[0] == -3
    world = make()
    world.poke(16, Y, 16, B.DIRT)
    world.poke(18, Y, 16, B.DIRT)
    for _ in range(14):
        assert world.dig((16.5, Y + 2.5, 16.5), DOWN)[0] == 0
    assert world.dig((18.5, Y + 2.5, 16.5), DOWN)[0] == 0
    for _ in range(13):
        assert world.dig((18.5, Y + 2.5, 16.5), DOWN)[0] == 0
    assert world.dig((18.5, Y + 2.5, 16.5), DOWN)[0] == OK


def test_delay_after_a_slow_break():
    world = make()
    world.poke(16, Y, 16, B.DIRT)
    world.poke(16, Y - 1, 16, B.DIRT)
    eye = (16.5, Y + 2.5, 16.5)
    while world.dig(eye, DOWN)[0] != OK:
        world.tick(1)
    world.tick(40)
    for _ in range(5):
        assert world.dig(eye, DOWN)[0] == -1
    assert world.dig(eye, DOWN)[0] == 0


def test_item_pickup_delay_and_box():
    _, _, world = _dig_ticks(B.DIRT, B.TOOL_NONE, B.TIER_HAND)
    assert len(world.items()) == 1
    body = (16.5, Y, 16.5)
    world.tick(9)
    assert world.pickup(body) == []
    world.tick(1)
    assert world.pickup((30.5, Y, 30.5)) == []
    assert world.pickup(body) == [(B.DIRT, 1)]
    assert len(world.items()) == 0


def test_item_pickup_box_edges():
    world = make()
    world.spawn_item(18.0, Y + 0.5, 16.5, B.DIRT, delay=0)
    assert world.pickup((16.5, Y, 16.5)) == []
    assert len(world.items()) == 1
    assert world.pickup((16.7, Y, 16.5)) == [(B.DIRT, 1)]


def test_item_falls_lands_and_despawns():
    world = make()
    world.spawn_item(16.5, Y + 5.0, 16.5, B.DIRT)
    world.tick(60)
    row = world.items()[0]
    assert row[1] == pytest.approx(Y) and row[7] == 1
    world.tick(6000)
    assert len(world.items()) == 0


def test_items_float_in_water_and_die_in_lava():
    raw = flat_raw()
    raw[10:20, 10:20, yi(Y) : yi(Y + 4)] = B.STONE
    raw[11:19, 11:19, yi(Y) : yi(Y + 4)] = B.WATER_SOURCE
    world = make(raw)
    world.spawn_item(15.5, Y + 1.0, 15.5, B.DIRT, delay=0)
    world.tick(100)
    assert world.items()[0, 1] > Y + 1.0
    world = make()
    world.poke(16, Y, 16, B.LAVA_SOURCE)
    world.spawn_item(16.5, Y + 0.2, 16.5, B.DIRT)
    world.tick(2)
    assert len(world.items()) == 0


def test_water_carries_items():
    raw = flat_raw()
    for x in range(10, 17):
        raw[x, 16, yi(Y)] = B.fluid(B.WATER, 17 - x)
    world = make(raw)
    world.spawn_item(12.5, Y + 0.1, 16.5, B.DIRT, delay=0)
    world.tick(10)
    assert world.items()[0, 0] > 12.55


def test_gravel_over_a_dug_cell_falls_and_reforms():
    world = make()
    world.poke(16, Y + 4, 16, B.STONE)
    world.poke(16, Y + 5, 16, B.GRAVEL)
    world.set(16, Y + 4, 16, B.AIR)
    world.tick(2)
    assert world.block(16, Y + 5, 16) == B.AIR
    assert world.falling_count() == 1
    world.tick(60)
    assert world.falling_count() == 0
    assert world.block(16, Y, 16) == B.GRAVEL
    assert len(world.items()) == 0


def test_gravel_landing_on_a_torch_becomes_an_item():
    world = make()
    world.poke(16, Y, 16, B.torch())
    world.poke(16, Y + 4, 16, B.STONE)
    world.poke(16, Y + 5, 16, B.GRAVEL)
    world.set(16, Y + 4, 16, B.AIR)
    world.tick(60)
    assert world.block(16, Y, 16) == B.TORCH
    assert world.falling_count() == 0
    items = world.items()
    assert len(items) == 1 and items[0, 3] == B.GRAVEL


def _side_click(world, block, cell_x, y_hit, yaw=90.0):
    """Click the east face of the wall at x 15 from the east."""
    eye = (cell_x + 2.0, y_hit, 16.5)
    return world.place(block, eye, (-1.0, 0.0, 0.0), yaw)


def _wall():
    raw = flat_raw()
    raw[15, :, yi(Y) : yi(Y + 4)] = B.STONE
    return make(raw)


def test_slab_placement_rules():
    world = make()
    assert world.place(B.COBBLE_SLAB, (16.5, Y + 2.0, 16.5), DOWN, 0.0)[0] == OK
    assert world.get(16, Y, 16) == B.slab(B.COBBLE_SLAB, 0)
    world.tick(4)
    assert world.place(B.COBBLE_SLAB, (16.5, Y + 2.0, 16.5), DOWN, 0.0)[0] == OK
    assert world.get(16, Y, 16) == B.slab(B.COBBLE_SLAB, 2)

    world = _wall()
    assert _side_click(world, B.COBBLE_SLAB, 16, Y + 0.75)[0] == OK
    assert world.get(16, Y, 16) == B.slab(B.COBBLE_SLAB, 1)
    world.tick(4)
    assert _side_click(world, B.COBBLE_SLAB, 16, Y + 1.25)[0] == OK
    assert world.get(16, Y + 1, 16) == B.slab(B.COBBLE_SLAB, 0)

    raw = empty_raw()
    raw[16, 16, yi(Y + 3)] = B.STONE
    world = make(raw)
    assert world.place(B.COBBLE_SLAB, (16.5, Y + 1.0, 16.5), UP, 0.0)[0] == OK
    assert world.get(16, Y + 2, 16) == B.slab(B.COBBLE_SLAB, 1)


def test_slab_shapes_collide():
    raw = flat_raw()
    raw[16, 16, yi(Y)] = B.slab(B.COBBLE_SLAB, 0)
    raw[20, 16, yi(Y + 2)] = B.slab(B.COBBLE_SLAB, 1)
    world = make(raw)
    body = Body(world, 16.5, Y + 3.0, 16.5, ground=False)
    for _ in range(40):
        body.tick(step=0.0)
    assert body.p[1] == pytest.approx(Y + 0.5)
    pos = np.array([[[20.5, Y + 0.0, 16.5]]])
    out, _, _ = world.collide_many(pos, np.array([[[0.0, 2.0, 0.0]]]), np.array([[0.6]]), np.array([[1.8]]))
    assert out[0, 0, 1] == pytest.approx(Y + 2.5 - 1.8)


def test_ladder_placement_rules():
    world = _wall()
    code, cell = _side_click(world, B.LADDER, 16, Y + 0.5)
    assert code == OK and cell == (16, Y, 16)
    assert world.get(16, Y, 16) == B.ladder(B.EAST)
    world.tick(4)
    assert world.place(B.LADDER, (20.5, Y + 2.0, 20.5), DOWN, 0.0)[0] == NO_SUPPORT


def test_ladder_pops_without_support_and_collides_as_a_panel():
    world = _wall()
    _side_click(world, B.LADDER, 16, Y + 0.5)
    pos = np.array([[[17.0, Y + 0.0, 16.5]]])
    out, _, _ = world.collide_many(pos, np.array([[[-1.0, 0.0, 0.0]]]), np.array([[0.6]]), np.array([[1.8]]))
    assert out[0, 0, 0] == pytest.approx(16.0 + 3.0 / 16.0 + 0.3)
    world.set(15, Y, 16, B.AIR)
    world.tick(2)
    assert world.block(16, Y, 16) == B.AIR
    assert world.items()[0, 3] == B.LADDER


def test_torch_placement_rules():
    world = _wall()
    assert world.place(B.TORCH, (20.5, Y + 2.0, 20.5), DOWN, 0.0)[0] == OK
    assert world.get(20, Y, 20) == B.torch(0)
    world.tick(4)
    code, cell = _side_click(world, B.TORCH, 16, Y + 0.5)
    assert code == OK and world.get(*cell) == B.torch(1 + B.EAST)
    raw = empty_raw()
    raw[16, 16, yi(Y + 3)] = B.STONE
    under = make(raw)
    assert under.place(B.TORCH, (16.5, Y + 1.0, 16.5), UP, 0.0)[0] == NO_SUPPORT


def test_torch_has_no_collision_and_pops_when_support_goes():
    world = make()
    world.set(16, Y + 3, 16, B.STONE)
    world.set(16, Y + 4, 16, B.torch())
    pos = np.array([[[16.5, Y + 4.0, 16.5]]])
    out, contact, _ = world.collide_many(pos, np.array([[[0.2, 0.2, 0.2]]]), np.array([[0.6]]), np.array([[1.8]]))
    assert contact[0, 0] == 0
    assert out[0, 0] == pytest.approx([16.7, Y + 4.2, 16.7])
    world.set(16, Y + 3, 16, B.AIR)
    world.tick(2)
    assert world.block(16, Y + 4, 16) == B.AIR


def test_placed_leaves_and_log_axis():
    world = _wall()
    world.place(B.LEAVES, (20.5, Y + 2.0, 20.5), DOWN, 0.0)
    assert world.get(20, Y, 20) == B.leaves(7, placed=True)
    world.tick(4)
    world.place(B.LOG, (22.5, Y + 2.0, 22.5), DOWN, 0.0)
    assert world.get(22, Y, 22) == B.log(1)
    world.tick(4)
    _side_click(world, B.LOG, 16, Y + 0.5)
    assert world.get(16, Y, 16) == B.log(0)


@pytest.mark.parametrize("yaw,facing", [(0.0, B.SOUTH), (90.0, B.WEST), (180.0, B.NORTH), (-90.0, B.EAST)])
def test_stairs_face_the_player(yaw, facing):
    world = make()
    assert world.place(B.COBBLE_STAIRS, (16.5, Y + 2.0, 16.5), DOWN, yaw)[0] == OK
    assert world.get(16, Y, 16) == B.stairs(B.COBBLE_STAIRS, facing)


def test_stairs_upper_half_from_a_high_side_click():
    world = _wall()
    assert _side_click(world, B.COBBLE_STAIRS, 16, Y + 0.75)[0] == OK
    assert world.get(16, Y, 16) == B.stairs(B.COBBLE_STAIRS, B.WEST, upper=True)


def test_stairs_take_corner_shapes_from_neighbours():
    world = make()
    world.set(16, Y, 16, B.stairs(B.COBBLE_STAIRS, B.EAST))
    world.tick(4)
    eye = (17.5, Y + 2.0, 16.5)
    assert world.place(B.COBBLE_STAIRS, eye, DOWN, 0.0)[0] == OK
    assert (world.get(17, Y, 16) >> 8) & 3 == B.SOUTH
    assert (world.get(16, Y, 16) >> 11) & 7 in (3, 4)


def test_stairs_shape_collides():
    raw = flat_raw()
    raw[16, 16, yi(Y)] = B.stairs(B.COBBLE_STAIRS, B.EAST)
    world = make(raw)
    drop = np.array([[[0.0, -3.0, 0.0]]])
    width, height = np.array([[0.2]]), np.array([[1.0]])
    low = np.array([[[16.25, Y + 2.0, 16.5]]])
    high = np.array([[[16.75, Y + 2.0, 16.5]]])
    assert world.collide_many(low, drop, width, height)[0][0, 0, 1] == pytest.approx(Y + 0.5)
    assert world.collide_many(high, drop, width, height)[0][0, 0, 1] == pytest.approx(Y + 1.0)


def test_door_placement_and_shapes():
    world = make()
    assert world.place(B.OAK_DOOR, (16.5, Y + 2.5, 16.5), DOWN, 180.0)[0] == OK
    lower, upper = world.get(16, Y, 16), world.get(16, Y + 1, 16)
    assert lower & 0xFF == B.OAK_DOOR and upper & 0xFF == B.OAK_DOOR
    assert (lower >> 8) & 3 == B.NORTH
    assert not (lower >> 12) & 1 and (upper >> 12) & 1
    pos = np.array([[[16.5, Y + 0.0, 15.5]]])
    delta = np.array([[[0.0, 0.0, 2.0]]])
    width, height = np.array([[0.6]]), np.array([[1.8]])
    out, _, _ = world.collide_many(pos, delta, width, height)
    assert out[0, 0, 2] == pytest.approx(17.0 - 3.0 / 16.0 - 0.3)
    world.poke(16, Y, 16, lower | (1 << 10))
    world.poke(16, Y + 1, 16, upper | (1 << 10))
    out, _, _ = world.collide_many(pos, delta, np.array([[0.2]]), height)
    assert out[0, 0, 2] == pytest.approx(17.5)


def test_door_needs_room_and_support_and_breaks_as_one():
    world = make()
    world.poke(20, Y + 1, 20, B.STONE)
    assert world.place(B.OAK_DOOR, (20.5, Y + 0.9, 20.5), DOWN, 0.0)[0] == OCCUPIED
    raw = empty_raw()
    raw[16, 16, yi(Y)] = B.STONE
    float_world = make(raw)
    code = float_world.place(B.OAK_DOOR, (17.5, Y + 0.5, 16.5), (-1.0, 0.0, 0.0), 0.0)[0]
    assert code == NO_SUPPORT
    world = make()
    world.place(B.OAK_DOOR, (16.5, Y + 2.5, 16.5), DOWN, 0.0)
    world.tick(4)
    eye = (16.5, Y + 3.5, 16.09)
    while True:
        code, _ = world.dig(eye, DOWN)
        if code == OK:
            break
        world.tick(1)
    assert world.block(16, Y, 16) == B.AIR and world.block(16, Y + 1, 16) == B.AIR
    world.tick(2)
    assert len(world.items()) == 1 and world.items()[0, 3] == B.OAK_DOOR


def test_waterlogged_slab_holds_water_and_spreads():
    world = make()
    world.set(16, Y, 16, B.slab(B.COBBLE_SLAB, 0))
    code, cell = world.bucket_empty(B.WATER, (16.5, Y + 2.0, 16.5), DOWN)
    assert code == OK and cell == (16, Y, 16)
    assert world.get(16, Y, 16) == B.slab(B.COBBLE_SLAB, 0, waterlogged=True)
    world.tick(5)
    assert world.block(17, Y, 16) == B.WATER
    assert world.block(16, Y, 16) == B.COBBLE_SLAB


def test_slab_bottom_blocks_downward_flow():
    world = make(flat_raw(floor=50))
    world.set(16, Y + 2, 16, B.slab(B.COBBLE_SLAB, 0, waterlogged=True))
    world.tick(5)
    assert world.block(16, Y + 1, 16) == B.AIR
    other = make(flat_raw(floor=50))
    other.set(16, Y + 2, 16, B.slab(B.COBBLE_SLAB, 1, waterlogged=True))
    other.tick(5)
    assert other.block(16, Y + 1, 16) == B.WATER


def test_breaking_a_waterlogged_slab_leaves_the_water():
    world = make()
    world.poke(16, Y, 16, B.slab(B.OAK_SLAB, 0, waterlogged=True))
    eye = (16.5, Y + 2.5, 16.5)
    while world.dig(eye, DOWN, B.TOOL_AXE, B.TIER_DIAMOND)[0] != OK:
        world.tick(1)
    assert world.get(16, Y, 16) == B.WATER_SOURCE


def test_placing_a_slab_into_water_keeps_it_and_a_flow_does_not_waterlog():
    world = make()
    world.poke(16, Y, 16, B.WATER_SOURCE)
    assert world.place(B.COBBLE_SLAB, (16.5, Y + 2.0, 16.5), DOWN, 0.0)[0] == OK
    assert world.get(16, Y, 16) == B.slab(B.COBBLE_SLAB, 0, waterlogged=True)
    world = make()
    world.set(20, Y, 16, B.slab(B.COBBLE_SLAB, 0))
    world.set(19, Y, 16, B.WATER_SOURCE)
    world.tick(40)
    assert world.get(20, Y, 16) == B.slab(B.COBBLE_SLAB, 0)


def test_water_washes_a_torch_into_an_item():
    world = make()
    world.set(17, Y, 16, B.torch())
    world.set(16, Y, 16, B.WATER_SOURCE)
    world.tick(5)
    assert world.block(17, Y, 16) == B.WATER
    assert any(int(row[3]) == B.TORCH for row in world.items())


def test_fire_on_stone_burns_out():
    world = make()
    world.set(16, Y, 16, B.fire())
    world.tick(1200)
    assert world.block(16, Y, 16) == B.AIR
    assert world.pending() == 0


def test_fire_without_a_solid_top_goes_out_at_once():
    world = make()
    world.set(16, Y + 5, 16, B.fire())
    world.tick(40)
    assert world.block(16, Y + 5, 16) == B.AIR


def test_fire_spreads_to_logs_and_leaves():
    raw = flat_raw()
    raw[14:19, 14:19, yi(Y) : yi(Y + 2)] = B.log(1)
    raw[12:21, 12:21, yi(Y + 2) : yi(Y + 4)] = B.leaves(1)
    raw[16, 16, yi(Y + 1)] = B.AIR
    start = raw.copy()
    world = make(raw, seed=4)
    world.set(16, Y + 1, 16, B.fire())
    world.tick(6000)
    now = world.dump()
    for block in (B.LOG, B.LEAVES):
        assert ((now & 0xFF) == block).sum() < ((start & 0xFF) == block).sum()


def test_water_and_a_placed_block_put_fire_out():
    world = make()
    world.set(16, Y, 16, B.fire())
    world.set(17, Y, 16, B.WATER_SOURCE)
    world.tick(6)
    assert world.block(16, Y, 16) == B.WATER
    world = make()
    world.set(16, Y, 16, B.fire())
    assert world.place(B.COBBLESTONE, (16.5, Y + 2.0, 16.5), DOWN, 0.0)[0] == OK
    assert world.block(16, Y, 16) == B.COBBLESTONE
