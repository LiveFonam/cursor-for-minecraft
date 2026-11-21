"""Surface, underground, ores, settling, the shared cache and world profiles."""

import hashlib
import subprocess
import sys

import numpy as np
import pytest
from world_helpers import FLOOR, Body, flat_raw, make, yi

from fighter.sim import Sim, SimConfig
from fighter.world import blocks as B
from fighter.world import gen, pool
from fighter.world.config import FULL, PROFILES, SURFACE, WorldConfig, profile
from fighter.world.kernel import Arenas, BaseWorld

SEED = 11


@pytest.fixture(scope="module")
def world128():
    return gen.generate(SEED, 128)


def test_same_seed_is_byte_identical_and_another_differs():
    a, _ = gen.generate(5, 64)
    b, _ = gen.generate(5, 64)
    c, _ = gen.generate(6, 64)
    assert a.tobytes() == b.tobytes()
    assert a.tobytes() != c.tobytes()


def test_generator_output_is_pinned():
    raw, _ = gen.generate(5, 64)
    assert hashlib.sha256(raw.tobytes()).hexdigest()[:16] == PINNED_64


@pytest.mark.parametrize("seed", [1, 2, 3, 4])
def test_land_columns_differ_by_at_most_one(seed):
    _, info = gen.generate(seed, 128)
    h, land = info.height, ~info.river
    for axis in (0, 1):
        step = np.abs(np.diff(h, axis=axis))
        both = np.take(land, range(h.shape[axis] - 1), axis) & np.take(land, range(1, h.shape[axis]), axis)
        assert step[both].max() <= 1
    assert h[land].max() - h[land].min() <= 20


def test_surface_holds_only_plain_land(world128):
    raw, info = world128
    allowed = {B.GRASS, B.DIRT, B.SAND, B.LOG, B.LEAVES, B.WATER, B.AIR}
    columns = np.arange(128)
    top = info.height - B.Y_MIN
    ids = set(np.unique(raw[columns[:, None], columns[None, :], top] & 0xFF).tolist())
    ids |= set(np.unique(raw[..., yi(int(info.height.max()) + 1) :] & 0xFF).tolist())
    assert ids <= allowed
    assert not hasattr(info, "biome")
    assert not any(name in b.name for b in B.BLOCKS for name in ("snow", "ice", "emerald", "cactus", "terracotta"))


def test_forest_and_rivers_are_light(world128):
    raw, info = world128
    assert 10 <= info.trees <= 200
    assert 0.005 < info.river.mean() < 0.08
    across = info.river.sum(axis=1)
    assert np.median(across[across > 0]) <= 6


def test_bedrock_and_deepslate_bands(world128):
    raw, _ = world128
    ids = raw & 0xFF
    assert (ids[..., yi(-64)] == B.BEDROCK).all()
    for y, chance in zip(range(-63, -59), (0.8, 0.6, 0.4, 0.2)):
        assert (ids[..., yi(y)] == B.BEDROCK).mean() == pytest.approx(chance, abs=0.05)
    assert not (ids[..., yi(-59) :] == B.BEDROCK).any()
    assert not (ids[..., yi(8) :] == B.DEEPSLATE).any()
    assert not (ids[..., : yi(0) + 1] == B.STONE).any()
    middle = ids[..., yi(4)]
    share = (middle == B.DEEPSLATE).sum() / max(((middle == B.DEEPSLATE) | (middle == B.STONE)).sum(), 1)
    assert share == pytest.approx(0.5, abs=0.08)


def test_deep_cave_air_is_lava(world128):
    raw, _ = world128
    ids = raw & 0xFF
    assert not (ids[..., : yi(-54)] == B.AIR).any()
    assert (ids[..., : yi(-54)] == B.LAVA).sum() > 0


def test_caves_and_pools_exist():
    water, lava, air = 0, 0, 0
    for seed in range(6):
        raw, info = gen.generate(seed, 128)
        ids = raw & 0xFF
        below = np.arange(B.WORLD_HEIGHT)[None, None, :] < (info.height - B.Y_MIN - 5)[..., None]
        air += int(((ids == B.AIR) & below).sum())
        water += int(((ids == B.WATER) & below & ~info.river[..., None]).sum())
        lava += int(((ids == B.LAVA) & (np.arange(B.WORLD_HEIGHT)[None, None, :] >= yi(-54))).sum())
    assert air > 1000 and water > 0 and lava > 0


@pytest.fixture(scope="module")
def ore_histograms():
    totals = {name: np.zeros(B.WORLD_HEIGHT) for name in B.ORE_NAMES}
    for seed in range(100, 112):
        raw, _ = gen.generate(seed, 128)
        ids = raw & 0xFF
        for name in B.ORE_NAMES:
            plain, deep = B.ORE_IDS[name]
            totals[name] += ((ids == plain) | (ids == deep)).sum(axis=(0, 1))
    return totals


@pytest.mark.parametrize(
    "name,expected",
    [("copper", 48), ("iron", 16), ("gold", -16), ("lapis", 0), ("redstone", -59), ("diamond", -59)],
)
def test_ore_height_peaks_over_twelve_worlds_of_64_chunks(ore_histograms, name, expected):
    smooth = np.convolve(ore_histograms[name], np.ones(9) / 9.0, mode="same")
    peak = int(np.argmax(smooth[: yi(80)])) + B.Y_MIN
    assert abs(peak - expected) <= 8


def test_every_ore_exists_with_deep_variants_and_no_emerald(world128):
    raw, _ = world128
    present = set(np.unique(raw & 0xFF).tolist())
    for name in B.ORE_NAMES:
        assert set(B.ORE_IDS[name]) <= present
    assert "emerald_ore" not in B.BLOCK_ID
    ids = raw & 0xFF
    for name in B.ORE_NAMES:
        plain, deep = B.ORE_IDS[name]
        assert not (ids[..., yi(8) :] == deep).any()


@pytest.fixture(scope="module")
def settled():
    raw, info = gen.generate(SEED, 128)
    cells, ticks = pool.settle(raw)
    return raw, cells, info, ticks


def test_settled_world_stays_still_when_every_fluid_wakes(settled):
    _, cells, _, _ = settled
    base = BaseWorld.from_array(cells)
    world = Arenas(base, 1, memory_cap=0)
    world.wake_fluids()
    assert world.pending() > 0
    writes = world.writes()
    world.tick(200)
    assert world.writes() == writes
    assert world.pending() == 0
    assert np.array_equal(world.dump(), cells)


def test_rivers_lose_no_water_to_caves(settled):
    raw, cells, info, _ = settled
    xs, zs = np.nonzero(info.river)
    levels = info.level[xs, zs] - B.Y_MIN
    assert ((cells[xs, zs, levels] & 0xFF) == B.WATER).mean() > 0.98
    bed = info.height[xs, zs] - B.Y_MIN
    assert ((cells[xs, zs, bed] & 0xFF) == B.SAND).all()
    assert all(B.BLOCKS[int(v)].solid for v in np.unique(cells[xs, zs, bed - 1] & 0xFF))
    before = ((raw[xs, zs] & 0xFF) == B.WATER).sum()
    after = ((cells[xs, zs] & 0xFF) == B.WATER).sum()
    assert after >= before


WORKER = """
import hashlib, os, sys
from fighter.world import pool
from fighter.world.kernel import Arenas
seed, size, folder = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
world = pool.load(seed, size, folder)
arenas = Arenas(world, 1)
path = pool.cache_path(seed, size, folder)
digest = hashlib.sha256(arenas.dump().tobytes()).hexdigest()
print(os.stat(path).st_ino, digest, int(world._owner.flags.writeable), flush=True)
sys.stdin.readline()
"""


def test_five_workers_map_one_cache_file(tmp_path):
    workers, lines = [], []
    try:
        for _ in range(5):
            proc = subprocess.Popen(
                [sys.executable, "-c", WORKER, "21", "64", str(tmp_path)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            )
            workers.append(proc)
            lines.append(proc.stdout.readline().split())
        assert all(p.poll() is None for p in workers)
    finally:
        for proc in workers:
            proc.communicate("\n", timeout=30)
    assert len(list(tmp_path.glob("*.bin"))) == 1
    assert len({line[0] for line in lines}) == 1
    assert len({line[1] for line in lines}) == 1
    assert {line[2] for line in lines} == {"0"}


def test_cache_round_trip_and_name(tmp_path):
    world = pool.load(3, 64, tmp_path)
    again = pool.load(3, 64, tmp_path)
    assert world.to_bytes() == again.to_bytes()
    name = pool.cache_path(3, 64, tmp_path).name
    assert "s3" in name and "n64" in name and f"g{gen.GENERATOR_VERSION}" in name
    assert pool.cache_path(3, 64, tmp_path, SURFACE) != pool.cache_path(3, 64, tmp_path, FULL)


def test_profiles_are_exactly_the_approved_three():
    assert set(PROFILES) == {"arena", "surface", "full"}
    assert profile("arena") is None
    surface = profile("surface")
    assert (surface.fluids, surface.fire, surface.depth, surface.trees) == (False, False, False, True)
    full = profile("full")
    assert (full.fluids, full.fire, full.depth, full.trees) == (True, True, True, True)
    with pytest.raises(ValueError):
        profile("other")


def test_fluids_off_costs_no_queue_work():
    config = WorldConfig(fluids=False)
    world = make(flat_raw(), config=config)
    world.set(16, FLOOR + 1, 16, B.WATER_SOURCE)
    world.set(17, FLOOR + 1, 16, B.LAVA_SOURCE)
    assert world.block(16, FLOOR + 1, 16) == B.AIR
    assert world.pending() == 0
    world.schedule(1, 16, FLOOR + 1, 16, 5)
    assert world.pending() == 0
    world.tick(50)
    assert world.fluid_ticks() == 0
    eye, down = (16.5, FLOOR + 3.0, 16.5), (0.0, -1.0, 0.0)
    assert world.bucket_empty(B.WATER, eye, down)[0] == -7
    assert world.bucket_fill(eye, down)[0] == -7
    world.set(18, FLOOR + 1, 16, B.slab(B.COBBLE_SLAB, 0, waterlogged=True))
    assert world.get(18, FLOOR + 1, 16) == B.slab(B.COBBLE_SLAB, 0)
    pos = np.array([[[16.5, FLOOR + 1.0, 16.5]]])
    out = world.fluid_box_many(pos, np.array([[0.6]]), np.array([[1.8]]), np.array([[1.62]]))
    assert not out["in_water"].any() and out["count"].sum() == 0


def test_fire_off_refuses_fire():
    world = make(flat_raw(), config=WorldConfig(fire=False))
    world.set(16, FLOOR + 1, 16, B.fire())
    assert world.block(16, FLOOR + 1, 16) == B.AIR
    assert world.pending() == 0


def test_depth_off_stores_only_a_shallow_band():
    full, _ = pool.build(SEED, 128, FULL)
    shallow, info = pool.build(SEED, 128, SURFACE)
    assert shallow.y_high - shallow.y_low <= 96
    assert shallow.y_low <= int(info.height.min()) - 8
    assert shallow.y_high >= int(info.height.max()) + 40
    assert shallow.size_bytes * 4 < full.size_bytes
    world = Arenas(shallow, 1, config=SURFACE)
    assert world.block(10, shallow.y_low - 1, 10) == B.BEDROCK
    assert world.block(10, shallow.y_high, 10) == B.AIR
    world.set(10, shallow.y_high, 10, B.STONE)
    assert world.block(10, shallow.y_high, 10) == B.AIR
    x, z = 40, 40
    top = int(info.height[x, z])
    world.set(x, top + 2, z, B.COBBLESTONE)
    assert world.block(x, top + 2, z) == B.COBBLESTONE
    world.reset()
    assert world.block(x, top + 2, z) == B.AIR


def test_surface_profile_has_only_gentle_land_and_forest():
    raw, info = gen.generate(SEED, 128, config=SURFACE)
    present = set(np.unique(raw & 0xFF).tolist())
    assert present <= {B.AIR, B.STONE, B.DEEPSLATE, B.BEDROCK, B.DIRT, B.GRASS, B.LOG, B.LEAVES}
    assert info.trees > 0 and not info.river.any() and info.chambers == 0
    above = raw[..., yi(0) :] & 0xFF
    assert set(np.unique(above).tolist()) >= {B.GRASS}
    low, high = gen.surface_band(info.height)
    stored = set(np.unique(raw[..., yi(low) : yi(high)] & 0xFF).tolist())
    assert stored <= {B.AIR, B.STONE, B.DIRT, B.GRASS, B.LOG, B.LEAVES}
    h = info.height
    assert max(np.abs(np.diff(h, axis=0)).max(), np.abs(np.diff(h, axis=1)).max()) <= 1


def test_trees_can_be_switched_off():
    _, info = gen.generate(SEED, 64, config=WorldConfig(trees=False))
    raw, _ = gen.generate(SEED, 64, config=WorldConfig(trees=False))
    assert info.trees == 0
    assert not ((raw & 0xFF) == B.LOG).any()


def test_small_worlds_keep_enough_trees():
    assert min(gen.generate(seed, 64)[1].trees for seed in range(1, 41)) >= gen.MIN_TREES


@pytest.mark.parametrize(("name", "side"), [("surface", 128), ("full", 64)])
def test_profiles_choose_their_world_size(name, side, tmp_path):
    sim = Sim(1, SimConfig(profile=name, world_cache=str(tmp_path)), seed=1)
    assert (sim.world.base.nx, sim.world.base.nz) == (side, side)
    sim.close()


def test_depth_off_with_fluids_on_has_no_underground():
    raw, info = gen.generate(SEED, 64, config=WorldConfig(depth=False))
    ids = raw & 0xFF
    for name in B.ORE_NAMES:
        assert not np.isin(ids, B.ORE_IDS[name]).any()
    assert info.chambers == 0


def test_one_physics_path_for_every_config():
    traces = []
    for config in (FULL, SURFACE, WorldConfig(fluids=False, depth=True), WorldConfig(fire=False)):
        raw = flat_raw(64)
        band = None if config.depth else (48, 112)
        world = Arenas(BaseWorld.from_array(raw, band), 1, config=config)
        body = Body(world, 20.5, FLOOR + 1.0, 20.5, yaw=-30.0)
        rows = []
        for t in range(60):
            body.tick(1.0, 0.0, True, t % 13 == 0)
            rows.append(body.p.copy())
        traces.append(np.array(rows))
    for other in traces[1:]:
        assert np.array_equal(traces[0], other)


def test_band_must_lie_on_section_boundaries():
    with pytest.raises(ValueError):
        BaseWorld.from_array(flat_raw(16), (50, 100))


PINNED_64 = "17dd00737fca9123"
