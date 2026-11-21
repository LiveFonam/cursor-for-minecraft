"""Fluid spread, reactions, currents and buckets."""

import numpy as np
import pytest
from world_helpers import FLOOR, Body, flat_raw, make, yi

from fighter.world import blocks as B

Y = FLOOR + 1
DOWN = (0.0, -1.0, 0.0)


def arrivals(world, cells, ticks):
    first = {c: None for c in cells}
    for t in range(1, ticks + 1):
        world.tick(1)
        for c in cells:
            if first[c] is None and world.block(*c) in (B.WATER, B.LAVA):
                first[c] = t
    return first


def test_water_reaches_block_k_at_tick_5k_and_no_further():
    world = make(flat_raw(48))
    world.set(24, Y, 24, B.WATER_SOURCE)
    cells = [(24 + k, Y, 24) for k in range(1, 9)]
    first = arrivals(world, cells, 120)
    for k in range(1, 8):
        assert first[(24 + k, Y, 24)] == 5 * k
    assert first[(32, Y, 24)] is None


def test_lava_reaches_block_k_at_tick_30k_and_no_further():
    world = make(flat_raw(48))
    world.set(24, Y, 24, B.LAVA_SOURCE)
    cells = [(24 + k, Y, 24) for k in range(1, 5)]
    first = arrivals(world, cells, 300)
    for k in range(1, 4):
        assert first[(24 + k, Y, 24)] == 30 * k
    assert first[(28, Y, 24)] is None


def test_hole_three_blocks_east_draws_only_the_east_arm():
    raw = flat_raw(48)
    raw[27, 24, yi(FLOOR - 2) : yi(FLOOR) + 1] = B.AIR
    world = make(raw)
    world.set(24, Y, 24, B.WATER_SOURCE)
    world.tick(25)
    for x in (25, 26, 27):
        assert world.block(x, Y, 24) == B.WATER
    for cell in ((23, Y, 24), (24, Y, 23), (24, Y, 25)):
        assert world.block(*cell) == B.AIR


def test_falling_column_advances_one_block_per_five_ticks():
    world = make(flat_raw(32, floor=0))
    top = 40
    world.set(16, top, 16, B.WATER_SOURCE)
    cells = [(16, top - k, 16) for k in range(1, 8)]
    first = arrivals(world, cells, 60)
    for k in range(1, 8):
        assert first[(16, top - k, 16)] == 5 * k


def test_two_sources_make_a_third_on_solid_ground():
    world = make()
    world.set(15, Y, 16, B.WATER_SOURCE)
    world.set(17, Y, 16, B.WATER_SOURCE)
    world.tick(20)
    assert world.get(16, Y, 16) == B.WATER_SOURCE


def test_no_infinite_lava():
    world = make()
    world.set(15, Y, 16, B.LAVA_SOURCE)
    world.set(17, Y, 16, B.LAVA_SOURCE)
    world.tick(200)
    assert world.get(16, Y, 16) != B.LAVA_SOURCE


def test_one_side_source_and_one_above_make_no_source():
    world = make()
    world.set(16, Y, 17, B.WATER_SOURCE)
    world.set(16, Y + 1, 16, B.WATER_SOURCE)
    world.tick(60)
    assert world.get(16, Y, 16) == B.fluid(B.WATER, 8, falling=True)


@pytest.mark.parametrize("source_x", [17, 19])
def test_flowing_water_leaves_a_bottom_slab_dry(source_x):
    raw = flat_raw()
    raw[16, 16, yi(Y)] = B.slab(B.OAK_SLAB, 0)
    world = make(raw)
    world.set(source_x, Y, 16, B.WATER_SOURCE)
    world.tick(80)
    assert world.get(16, Y, 16) == B.slab(B.OAK_SLAB, 0)


def _basin():
    raw = flat_raw(32)
    raw[10:16, 10:16, yi(Y)] = B.STONE
    raw[11:15, 11:15, yi(Y)] = B.WATER_SOURCE
    return raw


def test_settled_pool_makes_no_fluid_updates():
    world = make(_basin())
    world.wake_fluids()
    world.tick(30)
    assert world.pending() == 0
    before = world.fluid_ticks()
    world.tick(100)
    assert world.fluid_ticks() == before


def test_water_on_lava_source_gives_obsidian():
    world = make()
    world.set(16, Y, 16, B.LAVA_SOURCE)
    world.set(16, Y + 1, 16, B.WATER_SOURCE)
    assert world.block(16, Y, 16) == B.OBSIDIAN


def test_water_on_flowing_lava_gives_cobblestone():
    world = make()
    world.poke(16, Y, 16, B.fluid(B.LAVA, 4))
    world.set(16, Y + 1, 16, B.WATER_SOURCE)
    assert world.block(16, Y, 16) == B.COBBLESTONE


def test_lava_falling_onto_water_gives_stone():
    world = make(_basin())
    world.set(12, Y + 3, 12, B.LAVA_SOURCE)
    world.tick(100)
    assert world.block(12, Y, 12) == B.STONE


def test_water_under_lava_changes_nothing():
    world = make(flat_raw(32))
    world.poke(16, Y, 16, B.WATER_SOURCE)
    world.poke(16, Y + 1, 16, B.STONE)
    world.set(16, Y + 1, 16, B.LAVA_SOURCE)
    assert world.get(16, Y + 1, 16) == B.LAVA_SOURCE
    assert world.get(16, Y, 16) == B.WATER_SOURCE


def test_flows_drain_after_their_source_hardens():
    world = make(flat_raw(48))
    world.set(24, Y, 24, B.LAVA_SOURCE)
    world.tick(100)
    assert world.block(25, Y, 24) == B.LAVA
    world.set(24, Y + 1, 24, B.WATER_SOURCE)
    assert world.block(24, Y, 24) == B.OBSIDIAN
    world.set(24, Y + 1, 24, B.AIR)
    world.tick(400)
    assert not (world.dump()[..., yi(Y)] & 0xFF == B.LAVA).any()


def _ledge(east_block, model="vanilla"):
    raw = flat_raw()
    raw[17, 16, yi(FLOOR)] = B.WATER_SOURCE
    raw[17, 16, yi(Y)] = east_block
    raw[16, 16, yi(Y)] = B.fluid(B.WATER, 5)
    return make(raw, client_model=model)


def test_open_neighbour_with_water_below_pulls_toward_it():
    flow = _ledge(B.AIR).flow(16, Y, 16)
    assert flow[0] > 0.9


def test_solid_neighbour_does_not_pull():
    flow = _ledge(B.STONE).flow(16, Y, 16)
    assert flow[0] <= 0.0


def test_client_model_reverses_the_ledge_rule():
    assert _ledge(B.AIR, "mineflayer").flow(16, Y, 16)[0] <= 0.0
    assert _ledge(B.STONE, "mineflayer").flow(16, Y, 16)[0] > 0.9


def test_falling_water_beside_a_wall_points_mostly_down():
    raw = flat_raw()
    raw[15, 16, yi(Y)] = B.STONE
    raw[16, 16, yi(Y)] = B.fluid(B.WATER, 8, True)
    raw[17, 16, yi(Y)] = B.fluid(B.WATER, 7)
    flow = make(raw).flow(16, Y, 16)
    assert flow[1] < -0.95


def test_fluid_height_rule():
    raw = flat_raw()
    raw[16, 16, yi(Y)] = B.fluid(B.WATER, 6)
    raw[20, 16, yi(Y)] = B.WATER_SOURCE
    raw[20, 16, yi(Y + 1)] = B.WATER_SOURCE
    world = make(raw)
    assert world.fluid_height(16, Y, 16) == pytest.approx(6 / 9)
    assert world.fluid_height(20, Y, 16) == 1.0
    assert world.fluid_height(20, Y + 1, 16) == pytest.approx(8 / 9)


def test_body_in_steady_current_reaches_about_1_40_metres_per_second():
    raw = flat_raw(64)
    for x in range(16, 40):
        raw[x, 32, yi(Y)] = B.fluid(B.WATER, 7 - (x % 7))
    for x in range(16, 40):
        raw[x, 31, yi(Y)] = B.STONE
        raw[x, 33, yi(Y)] = B.STONE
    start = next(x for x in range(20, 30) if x % 7 == 1)
    world = make(raw)
    body = Body(world, start + 0.7, Y, 32.5)
    speeds = []
    for _ in range(120):
        before = body.p[0]
        body.tick(step=0.0)
        speeds.append((body.p[0] - before) * 20.0)
        if body.p[0] > start + 1.2:
            body.pos[0, 0, 0] -= 0.5
    assert np.mean(speeds[-30:]) == pytest.approx(1.40, abs=0.03)


def test_bucket_fills_only_from_a_source():
    world = make()
    world.poke(16, Y, 16, B.fluid(B.WATER, 5))
    eye = (16.5, Y + 2.0, 16.5)
    assert world.bucket_fill(eye, DOWN)[0] == 0
    assert world.block(16, Y, 16) == B.WATER
    world.poke(16, Y, 16, B.LAVA_SOURCE)
    kind, cell = world.bucket_fill(eye, DOWN)
    assert kind == B.LAVA and cell == (16, Y, 16)
    assert world.block(16, Y, 16) == B.AIR


def test_scooped_source_in_a_two_wide_channel_refills():
    raw = flat_raw()
    raw[8:25, 14:18, yi(Y)] = B.STONE
    raw[9:24, 15:17, yi(Y)] = B.WATER_SOURCE
    world = make(raw)
    kind, cell = world.bucket_fill((16.5, Y + 2.0, 15.5), DOWN)
    assert kind == B.WATER and cell == (16, Y, 15)
    assert world.block(16, Y, 15) == B.AIR
    world.tick(20)
    assert world.get(16, Y, 15) == B.WATER_SOURCE


def _fall(with_water):
    world = make(flat_raw(32))
    body = Body(world, 16.5, Y + 20.0, 16.5, pitch=90.0, ground=False)
    poured = False
    for _ in range(80):
        if with_water and not poured and body.p[1] - Y < 3.0:
            code, cell = world.bucket_empty(B.WATER, body.eye, body.look)
            assert code == 1 and cell == (16, Y, 16)
            poured = True
        body.tick(step=0.0)
    return body, poured


def test_water_clutch_from_twenty_blocks_gives_no_fall_damage():
    dry, _ = _fall(False)
    assert dry.damage == 17
    wet, poured = _fall(True)
    assert poured
    assert wet.damage == 0
