"""Block table, storage, the flat path, collision and tick queues."""

import subprocess
import sys
import time

import numpy as np
import pytest
from world_helpers import FLOOR, Body, empty_raw, flat_raw, make, yi

from fighter import actions as A
from fighter.sim import Sim, SimConfig
from fighter.world import blocks as B
from fighter.world.kernel import BaseWorld, lib

PICK, SHOVEL, AXE = B.PICK, B.SHOVEL, B.AXE
ROWS = [
    ("stone", 1.5, PICK, B.NEEDS_WOOD, "cobblestone", 1, 1),
    ("deepslate", 3.0, PICK, B.NEEDS_WOOD, "cobbled_deepslate", 1, 1),
    ("cobblestone", 2.0, PICK, B.NEEDS_WOOD, "cobblestone", 1, 1),
    ("cobbled_deepslate", 3.5, PICK, B.NEEDS_WOOD, "cobbled_deepslate", 1, 1),
    ("granite", 1.5, PICK, B.NEEDS_WOOD, "granite", 1, 1),
    ("tuff", 1.5, PICK, B.NEEDS_WOOD, "tuff", 1, 1),
    ("diorite", 1.5, PICK, B.NEEDS_WOOD, "diorite", 1, 1),
    ("andesite", 1.5, PICK, B.NEEDS_WOOD, "andesite", 1, 1),
    ("dirt", 0.5, SHOVEL, B.NEEDS_ANY, "dirt", 1, 1),
    ("grass_block", 0.6, SHOVEL, B.NEEDS_ANY, "dirt", 1, 1),
    ("sand", 0.5, SHOVEL, B.NEEDS_ANY, "sand", 1, 1),
    ("gravel", 0.6, SHOVEL, B.NEEDS_ANY, "gravel", 1, 1),
    ("oak_log", 2.0, AXE, B.NEEDS_ANY, "oak_log", 1, 1),
    ("oak_planks", 2.0, AXE, B.NEEDS_ANY, "oak_planks", 1, 1),
    ("ladder", 0.4, AXE, B.NEEDS_ANY, "ladder", 1, 1),
    ("torch", 0.0, 0, B.NEEDS_ANY, "torch", 1, 1),
    ("obsidian", 50.0, PICK, B.NEEDS_DIAMOND, "obsidian", 1, 1),
    ("coal_ore", 3.0, PICK, B.NEEDS_WOOD, "coal", 1, 1),
    ("deepslate_coal_ore", 4.5, PICK, B.NEEDS_WOOD, "coal", 1, 1),
    ("copper_ore", 3.0, PICK, B.NEEDS_STONE, "raw_copper", 2, 5),
    ("deepslate_copper_ore", 4.5, PICK, B.NEEDS_STONE, "raw_copper", 2, 5),
    ("iron_ore", 3.0, PICK, B.NEEDS_STONE, "raw_iron", 1, 1),
    ("deepslate_iron_ore", 4.5, PICK, B.NEEDS_STONE, "raw_iron", 1, 1),
    ("lapis_ore", 3.0, PICK, B.NEEDS_STONE, "lapis_lazuli", 4, 9),
    ("deepslate_lapis_ore", 4.5, PICK, B.NEEDS_STONE, "lapis_lazuli", 4, 9),
    ("gold_ore", 3.0, PICK, B.NEEDS_IRON, "raw_gold", 1, 1),
    ("deepslate_gold_ore", 4.5, PICK, B.NEEDS_IRON, "raw_gold", 1, 1),
    ("redstone_ore", 3.0, PICK, B.NEEDS_IRON, "redstone", 4, 5),
    ("deepslate_redstone_ore", 4.5, PICK, B.NEEDS_IRON, "redstone", 4, 5),
    ("diamond_ore", 3.0, PICK, B.NEEDS_IRON, "diamond", 1, 1),
    ("deepslate_diamond_ore", 4.5, PICK, B.NEEDS_IRON, "diamond", 1, 1),
]


@pytest.mark.parametrize("row", ROWS, ids=[r[0] for r in ROWS])
def test_block_table_row(row):
    name, hardness, tools, rank, drop, low, high = row
    block = B.BLOCKS[B.BLOCK_ID[name]]
    assert block.hardness == hardness
    assert block.tools == tools
    assert block.min_rank == rank
    assert block.drop == drop
    assert (block.drop_min, block.drop_max) == (low, high)


def test_special_blocks():
    assert B.BLOCKS[B.BEDROCK].hardness == -1
    web = B.BLOCKS[B.COBWEB]
    assert web.hardness == 4 and web.tools == (B.SWORD | B.SHEARS) and web.needs_tool and web.drop == "string"
    leaves = B.BLOCKS[B.LEAVES]
    assert leaves.hardness == 0.2 and leaves.drop_rule == B.DROP_LEAVES
    assert B.BLOCKS[B.IRON_DOOR].hardness == 5
    assert not any("emerald" in b.name for b in B.BLOCKS)


def test_state_layouts():
    assert B.fluid(B.WATER, 8) == B.WATER_SOURCE
    assert B.fluid(B.LAVA, 3, True) == B.LAVA | (3 << 8) | (1 << 12)
    assert B.slab(B.OAK_SLAB, 2, True) == B.OAK_SLAB | (2 << 8) | (1 << 15)
    assert B.stairs(B.OAK_STAIRS, 3, True, 4, True) == B.OAK_STAIRS | (3 << 8) | (1 << 10) | (4 << 11) | (1 << 15)
    assert B.door(B.OAK_DOOR, 2, True, 1, True) == B.OAK_DOOR | (2 << 8) | (1 << 10) | (1 << 11) | (1 << 12)
    assert B.leaves(5, True, True) == B.LEAVES | (5 << 8) | (1 << 11) | (1 << 15)
    assert B.fire(15) == B.FIRE | (15 << 8)
    assert "B_DIAMOND_ORE" in B.header_text()


def _random_ops(world, mirror, rng, count):
    size = mirror.shape[0]
    hot = rng.random(count) < 0.5
    xs = np.where(hot, rng.integers(0, 16, count), rng.integers(0, size, count)).tolist()
    zs = np.where(hot, rng.integers(0, 16, count), rng.integers(0, size, count)).tolist()
    ys = np.where(hot, rng.integers(0, 16, count), rng.integers(0, B.WORLD_HEIGHT, count)).tolist()
    writes = (rng.random(count) < 0.4).tolist()
    values = rng.integers(0, 60000, count).tolist()
    handle = world.handles[0]
    get, poke = lib().w_get, lib().w_poke
    offset = B.Y_MIN
    for x, y, z, write, value in zip(xs, ys, zs, writes, values):
        if write:
            poke(handle, x, y + offset, z, value)
            mirror[x, z, y] = value
        else:
            assert get(handle, x, y + offset, z) == mirror[x, z, y]


def test_storage_matches_numpy_over_a_million_operations():
    rng = np.random.default_rng(7)
    raw = rng.integers(0, 6, (48, 48, B.WORLD_HEIGHT), dtype=np.uint16)
    raw[:16, :16, 32:48] = np.arange(4096, dtype=np.uint16).reshape(16, 16, 16)
    raw[16:32, :, :] = 3
    world = make(raw, memory_cap=0)
    assert world.base.raw_sections >= 1
    assert world.base.mixed_sections >= 1
    for _ in range(4):
        mirror = raw.copy()
        _random_ops(world, mirror, rng, 250_000)
        assert world.hot_sections() > 0
        assert np.array_equal(world.dump(), mirror)
        world.reset()
        assert world.hot_sections() == 0
        assert np.array_equal(world.dump(), raw)


def test_section_with_more_than_256_values_round_trips():
    raw = empty_raw(16)
    raw[:, :, :16] = np.arange(1, 4097, dtype=np.uint16).reshape(16, 16, 16)
    world = BaseWorld.from_array(raw)
    assert world.raw_sections == 1
    copy = BaseWorld.from_buffer(np.frombuffer(world.to_bytes(), dtype=np.uint8))
    assert copy.raw_sections == 1
    assert np.array_equal(make(raw).dump(), raw)


def test_section_turns_hot_on_its_twelfth_write_and_at_most_four_do():
    world = make(flat_raw(128))
    for i in range(11):
        world.poke(i, FLOOR + 1, 0, B.COBBLESTONE)
    assert world.hot_sections() == 0
    world.poke(11, FLOOR + 1, 0, B.COBBLESTONE)
    assert world.hot_sections() == 1
    for section in range(1, 7):
        for i in range(12):
            world.poke(section * 16 + i, FLOOR + 1, 0, B.DIRT)
    assert world.hot_sections() == 4
    assert world.block(11, FLOOR + 1, 0) == B.COBBLESTONE
    assert world.block(6 * 16 + 11, FLOOR + 1, 0) == B.DIRT


def test_empty_reset_is_under_two_microseconds():
    world = make(flat_raw(128))
    reset, handle = lib().arena_reset, world.handles[0]
    samples = []
    for _ in range(2000):
        t0 = time.perf_counter_ns()
        reset(handle)
        samples.append(time.perf_counter_ns() - t0)
    assert np.median(samples) < 2000


def test_memory_cap_ends_the_round_instead_of_growing():
    world = make(flat_raw(128), memory_cap=32 * 1024)
    for x in range(128):
        for z in range(128):
            world.poke(x, FLOOR + 1 + (x + z) % 64, z, B.COBBLESTONE)
    assert world.overflowed()[0]
    assert world.memory() <= 32 * 1024
    world.reset()
    assert not world.overflowed()[0]


def test_flat_sim_has_no_world():
    assert Sim(2).world is None
    code = "import sys, fighter.sim; print(any(m.startswith('fighter.world') for m in sys.modules))"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"


def _flat_trace(keys, start_y, decisions):
    sim = Sim(1, SimConfig(armor="none", arena_half=500.0), seed=0)
    sim.pos[0, 0] = [0.0, start_y, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 300.0]
    sim.yaw[0] = [0.0, 0.0]
    sim.on_ground[0, 0] = start_y == 0.0
    action = A.neutral_actions(sim.weapon.copy())
    for name, value in keys.items():
        action[0, 0, A.HEADS.index(name)] = value
    rows = []
    for _ in range(decisions):
        sim.step(action)
        rows.append(sim.pos[0, 0].copy())
    return np.array(rows)


@pytest.mark.parametrize(
    "keys,start_y",
    [
        ({"forward": A.KEY_FORWARD}, 0.0),
        ({"forward": A.KEY_FORWARD, "sprint": 1}, 0.0),
        ({"forward": A.KEY_FORWARD, "strafe": A.KEY_RIGHT}, 0.0),
        ({"forward": A.KEY_BACK}, 0.0),
        ({"jump": 1}, 0.0),
        ({"forward": A.KEY_FORWARD, "jump": 1}, 0.0),
        ({"forward": A.KEY_FORWARD, "sprint": 1, "jump": 1}, 0.0),
        ({}, 20.0),
    ],
    ids=["walk", "sprint", "diagonal", "back", "jump", "walk_jump", "sprint_jump", "fall"],
)
def test_block_floor_matches_flat_plane(keys, start_y):
    decisions = 40
    flat = _flat_trace(keys, start_y, decisions)
    world = make(flat_raw(128))
    start = np.array([64.5, FLOOR + 1.0, 40.5])
    body = Body(world, start[0], start[1] + start_y, start[2], ground=start_y == 0.0)
    forward = float(A.FORWARD_VALUES[keys.get("forward", A.NEUTRAL_FORWARD)])
    strafe = float(A.STRAFE_VALUES[keys.get("strafe", A.NEUTRAL_STRAFE)])
    sprint, jump = bool(keys.get("sprint", 0)), bool(keys.get("jump", 0))
    for row in flat:
        body.tick(forward, strafe, sprint, jump, step=0.0)
        body.tick(forward, strafe, sprint, jump, step=0.0)
        assert np.abs(body.p - start - row).max() < 5e-5


def test_collide_stops_at_a_wall_and_reports_axes():
    raw = flat_raw()
    raw[20, :, yi(FLOOR + 1)] = B.STONE
    world = make(raw)
    pos = np.array([[[19.0, FLOOR + 1.0, 16.5]]])
    out, contact, ground = world.collide_many(pos, np.array([[[1.0, -0.1, 0.0]]]), np.array([[0.6]]), np.array([[1.8]]))
    assert out[0, 0, 0] == pytest.approx(19.7)
    assert out[0, 0, 1] == pytest.approx(FLOOR + 1.0)
    assert contact[0, 0] == 3
    assert ground[0, 0]


def test_collision_order_is_y_then_larger_horizontal_axis():
    raw = flat_raw()
    raw[17, 17, yi(FLOOR + 1)] = B.STONE
    world = make(raw)
    pos = np.array([[[16.5, FLOOR + 1.0, 16.5]]])
    delta = np.array([[[0.5, 0.0, 0.9]]])
    width, height = np.array([[0.6]]), np.array([[1.8]])
    out, _, _ = world.collide_many(pos, delta, width, height)
    assert out[0, 0, 2] == pytest.approx(17.4)
    assert out[0, 0, 0] == pytest.approx(16.7)
    other = make(raw, client_model="mineflayer")
    out, _, _ = other.collide_many(pos, delta, width, height)
    assert out[0, 0, 0] == pytest.approx(17.0)
    assert out[0, 0, 2] == pytest.approx(16.7)


def test_step_up_climbs_a_slab_and_not_a_full_block():
    raw = flat_raw()
    raw[18:, :, yi(FLOOR + 1)] = B.slab(B.COBBLE_SLAB)
    world = make(raw)
    body = Body(world, 17.0, FLOOR + 1.0, 16.5, yaw=-90.0)
    for _ in range(30):
        body.tick(1.0)
    assert body.p[0] > 18.0
    assert body.p[1] == pytest.approx(FLOOR + 1.5)

    raw = flat_raw()
    raw[18, :, yi(FLOOR + 1)] = B.STONE
    world = make(raw)
    body = Body(world, 17.0, FLOOR + 1.0, 16.5, yaw=-90.0)
    for _ in range(30):
        body.tick(1.0)
    assert body.p[0] == pytest.approx(17.7)
    assert body.p[1] == pytest.approx(FLOOR + 1.0)


def test_contact_flags():
    raw = flat_raw()
    raw[16, 16, yi(FLOOR + 1)] = B.COBWEB
    raw[20, 16, yi(FLOOR + 1)] = B.fire()
    raw[24, 16, yi(FLOOR + 1)] = B.ladder(B.NORTH)
    world = make(raw, n=1)
    pos = np.array([[[16.5, FLOOR + 1.0, 16.5], [20.5, FLOOR + 1.0, 16.5], [24.5, FLOOR + 1.0, 16.5]]])
    width, height = np.full((1, 3), 0.6), np.full((1, 3), 1.8)
    out = world.contact_many(pos, width, height)
    assert out["cobweb"].tolist() == [[True, False, False]]
    assert out["fire"].tolist() == [[False, True, False]]
    assert out["ladder"].tolist() == [[False, False, True]]


@pytest.mark.parametrize("delay", [1, 2, 5, 30, 64, 120, 127])
def test_tick_runs_exactly_after_its_delay(delay):
    world = make()
    world.trace_on()
    world.tick(3)
    world.schedule(0, 5, FLOOR + 1, 5, delay)
    world.tick(delay - 1)
    assert len(world.trace()) == 0
    world.tick(1)
    rows = world.trace()
    assert len(rows) == 1 and rows[0, 0] == 3 + delay
    world.tick(140)
    assert len(world.trace()) == 1


def test_duplicate_schedules_run_once_and_keep_order():
    world = make()
    world.trace_on()
    for _ in range(5):
        world.schedule(1, 7, FLOOR + 1, 7, 10)
    world.schedule(1, 8, FLOOR + 1, 7, 10)
    world.schedule(1, 9, FLOOR + 1, 7, 10)
    world.schedule(1, 7, FLOOR + 1, 7, 3)
    world.tick(20)
    rows = world.trace()
    assert len(rows) == 3
    assert (rows[:, 0] == 10).all()
    assert rows[0, 1] < rows[1, 1] < rows[2, 1]
    world.schedule(1, 7, FLOOR + 1, 7, 2)
    world.tick(2)
    assert len(world.trace()) == 4


def test_unchanged_write_does_nothing():
    world = make()
    world.set(5, FLOOR + 1, 5, B.WATER_SOURCE)
    writes, pending = world.writes(), world.pending()
    world.set(5, FLOOR + 1, 5, B.WATER_SOURCE)
    assert world.writes() == writes
    assert world.pending() == pending
