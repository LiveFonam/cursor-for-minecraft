"""Sight, seen block memory, the view module and the no X-ray guarantee."""

import ast
from pathlib import Path

import numpy as np
import pytest
from world_helpers import FLOOR, flat_raw, look_vector, make, yi

import fighter
from fighter import actions as A
from fighter import constants as C
from fighter.obs import build_masks, build_obs, intercept_angles
from fighter.opponents import SCRIPTED
from fighter.sim import Sim, SimConfig
from fighter.world import blocks as B
from fighter.world import gen, pool, view
from fighter.world.kernel import Arenas, BaseWorld, lib
from fighter.world.view import AIR_CLASS, RAY_BLOCKED, RAY_CLEAR, RAY_UNKNOWN, UNKNOWN, WorldView, block_class

Y = FLOOR + 1
SOURCE_ROOT = Path(fighter.__file__).parent
# Modules that build observations, masks or critic inputs.
RESTRICTED = (
    "obs.py", "env.py", "policy.py", "train.py", "evaluate.py", "drills.py", "cli.py", "actions.py", "opponents.py",
    "perception.py", "rays.py", "interface.py",
)


@pytest.fixture(scope="module")
def cells():
    raw, info = gen.generate(9, 64)
    settled, _ = pool.settle(raw)
    return settled, info


def _viewpoints(cells_array, rng, count):
    ids = cells_array & 0xFF
    air = np.argwhere(ids[2:-2, 2:-2, yi(-50) : yi(100)] == B.AIR)
    picks = air[rng.integers(0, len(air), count)]
    near_ground = []
    for x, z, y in picks.tolist():
        near_ground.append((x + 2 + rng.random(), y + yi(-50) + B.Y_MIN + rng.random(), z + 2 + rng.random()))
    return near_ground


def test_enclosed_blocks_are_never_written_over_1000_viewpoints(cells):
    settled, _ = cells
    world = Arenas(BaseWorld.from_array(settled), 1)
    rng = np.random.default_rng(3)
    points = _viewpoints(settled, rng, 1000)
    seen = 0
    for eye in points:
        seen += world.see(0, eye, float(rng.uniform(-180, 180)), float(rng.uniform(-90, 90)))
        assert lib().view_enclosed(world.handles[0], 0) == 0
    assert seen > 10_000


def test_sight_stops_at_opaque_and_passes_see_through():
    raw = flat_raw()
    raw[16, 20, yi(Y) : yi(Y + 4)] = B.STONE
    raw[16, 22, yi(Y + 1)] = B.ORE_IDS["diamond"][0]
    raw[20, 20, yi(Y + 1)] = B.GLASS
    raw[20, 22, yi(Y + 1)] = B.ORE_IDS["coal"][0]
    world = make(raw)
    v = WorldView(world)
    for _ in range(4):
        v.update(0, 0, (16.5, Y + 1.5, 16.5), 0.0, 0.0)
    crop = v.crop(0, 0, 6, 3, 7)
    assert crop[6, 7 + 4, 3] == block_class(B.STONE)
    assert crop[6, 7 + 6, 3] == UNKNOWN
    for _ in range(4):
        v.update(0, 1, (20.5, Y + 1.5, 16.5), 0.0, 0.0)
    crop = v.crop(0, 1, 6, 3, 7)
    assert crop[6, 7 + 4, 3] == block_class(B.GLASS)
    assert crop[6, 7 + 6, 3] == block_class(B.ORE_IDS["coal"][0])


def test_lava_blocks_sight():
    raw = flat_raw()
    raw[16, 20, yi(Y) : yi(Y + 4)] = B.LAVA_SOURCE
    raw[16, 22, yi(Y + 1)] = B.ORE_IDS["diamond"][0]
    world = make(raw)
    v = WorldView(world)
    for _ in range(4):
        v.update(0, 0, (16.5, Y + 1.5, 16.5), 0.0, 0.0)
    crop = v.crop(0, 0, 6, 3, 7)
    assert crop[6, 7 + 4, 3] == block_class(B.LAVA)
    assert crop[6, 7 + 6, 3] == UNKNOWN


def test_cells_behind_the_body_stay_unknown():
    world = make()
    v = WorldView(world)
    v.update(0, 0, (16.5, Y + 1.62, 16.5), 0.0, 0.0)
    crop = v.crop(0, 0, 3, 2, 6)
    assert (crop[:, :4, :] == UNKNOWN).all()
    assert (crop[:, 8:, :] != UNKNOWN).any()


def test_body_held_still_finds_most_of_a_dense_scan(cells):
    settled, info = cells
    world = Arenas(BaseWorld.from_array(settled), 1)
    v = WorldView(world)
    rng = np.random.default_rng(5)
    shares = []
    for _ in range(12):
        x, z = rng.integers(16, 48, 2)
        eye = np.array([x + 0.5, int(info.height[x, z]) + 2.62, z + 0.5])
        yaw, pitch = float(rng.uniform(-180, 180)), float(rng.uniform(5, 35))
        world.reset()
        for _ in range(4):
            v.update(0, 0, eye, yaw, pitch)
        forward = look_vector(yaw, pitch)
        right = np.array([np.cos(np.radians(yaw)), 0.0, np.sin(np.radians(yaw))])
        up = np.cross(right, forward)
        up = up if up[1] > 0 else -up
        count = 40_000
        u = rng.uniform(-1, 1, count) * np.tan(np.radians(55))
        w = rng.uniform(-1, 1, count) * np.tan(np.radians(35))
        rays = forward[None] + right[None] * u[:, None] + up[None] * w[:, None]
        rays /= np.linalg.norm(rays, axis=1, keepdims=True)
        eyes = np.broadcast_to(eye, rays.shape).copy()
        hit, found, _, _ = world.ray_block_many(eyes[None], rays[None], 8.0)
        unique = np.unique(found[0][hit[0]], axis=0)
        crop = v.crop(0, 0, 15, 15, 15)
        center = np.floor(eye).astype(int)
        offset = unique - center + 15
        keep = (offset >= 0).all(axis=1) & (offset <= 30).all(axis=1)
        offset = offset[keep]
        known = crop[offset[:, 0], offset[:, 2], offset[:, 1]] != UNKNOWN
        shares.append(known.mean())
    assert np.mean(shares) >= 0.55


def test_memory_goes_stale_until_seen_again():
    world = make()
    v = WorldView(world)
    world.set(16, Y, 19, B.COBBLESTONE)
    eye = (16.5, Y + 1.62, 16.5)
    for _ in range(4):
        v.update(0, 0, eye, 0.0, 20.0)
    assert v.crop(0, 0, 4, 2, 4)[4, 7, 1] == block_class(B.COBBLESTONE)
    world.set(16, Y, 19, B.AIR)
    assert v.crop(0, 0, 4, 2, 4)[4, 7, 1] == block_class(B.COBBLESTONE)
    for _ in range(4):
        v.update(0, 0, eye, 0.0, 20.0)
    assert v.crop(0, 0, 4, 2, 4)[4, 7, 1] == AIR_CLASS


def test_ring_clears_the_plane_it_moves_into():
    world = make(flat_raw(64))
    v = WorldView(world)
    v.update(0, 0, (30.5, Y + 1.62, 30.5), 0.0, 30.0)
    before = v.crop(0, 0, 15, 15, 15)
    assert (before != UNKNOWN).any()
    v.update(0, 0, (31.5, Y + 1.62, 30.5), 180.0, 30.0)
    after = v.crop(0, 0, 15, 15, 15)
    kept = before[1:] != UNKNOWN
    assert kept.any()
    assert np.array_equal(after[:-1][kept], before[1:][kept])
    assert (after[-1] == UNKNOWN).all()


def test_batch_sight_and_crop_match_single_calls(cells):
    settled, info = cells
    base = BaseWorld.from_array(settled)
    single, batch = Arenas(base, 3), Arenas(base, 3)
    one, many = WorldView(single), WorldView(batch)
    rng = np.random.default_rng(23)
    for _ in range(25):
        xz = rng.integers(10, 54, (3, 2, 2))
        eyes = np.zeros((3, 2, 3))
        eyes[..., 0] = xz[..., 0] + 0.5
        eyes[..., 2] = xz[..., 1] + 0.5
        eyes[..., 1] = info.height[xz[..., 0], xz[..., 1]] + 2.62
        yaw, pitch = rng.uniform(-180, 180, (3, 2)), rng.uniform(-60, 60, (3, 2))
        many.update_all(eyes, yaw, pitch)
        crops = many.crop_all(2, 5, 3, 5)
        assert crops.shape == (3, 2, 11, 11, 7)
        for arena in range(3):
            for seat in range(2):
                one.update(arena, seat, eyes[arena, seat], yaw[arena, seat], pitch[arena, seat])
                assert np.array_equal(crops[arena, seat], one.crop(arena, seat, 5, 3, 5))
                assert one.digest(arena, seat) == many.digest(arena, seat)


def test_view_ray_reports_blocker_unknown_and_clear():
    raw = flat_raw()
    raw[16, 20, yi(Y + 1)] = B.STONE
    world = make(raw)
    v = WorldView(world)
    eye = (16.5, Y + 1.5, 16.5)
    for _ in range(6):
        v.update(0, 0, eye, 0.0, 0.0)
    dist, kind = v.ray(0, 0, eye, (0.0, 0.0, 1.0), 8.0)
    assert kind == RAY_BLOCKED and dist == pytest.approx(3.5)
    dist, kind = v.ray(0, 0, eye, (0.0, 0.0, -1.0), 8.0)
    assert kind == RAY_UNKNOWN and dist == pytest.approx(0.5)
    dist, kind = v.ray(0, 0, eye, (0.0, 0.0, 1.0), 2.0)
    assert kind == RAY_CLEAR and dist == 2.0
    dirs = np.array([[0.0, 0.0, 1.0], [0.0, 0.0, -1.0]])
    dists, unknown = v.rays(0, 0, eye, dirs, 8.0)
    assert dists == pytest.approx([3.5, 0.5])
    assert unknown.tolist() == [False, True]


def test_view_notable_returns_nearest_of_a_kind():
    raw = flat_raw()
    diamond = B.ORE_IDS["diamond"][0]
    for z in (19, 21, 23):
        raw[16, z, yi(Y)] = diamond
    raw[18, 20, yi(Y)] = B.ORE_IDS["coal"][0]
    world = make(raw)
    v = WorldView(world)
    for _ in range(6):
        v.update(0, 0, (16.5, Y + 2.62, 16.5), 0.0, 25.0)
    rows = v.notable(0, 0, block_class(diamond), 2)
    assert rows[:, 2].tolist() == [19, 21]
    assert (rows[:, 3] == block_class(diamond)).all()
    assert len(v.notable(0, 0, block_class(B.ORE_IDS["gold"][0]), 4)) == 0


def test_view_target_uses_memory_only():
    world = make()
    v = WorldView(world)
    eye = (16.5, Y + 1.62, 16.5)
    down = (0.0, -1.0, 0.0)
    assert v.target(0, 0, eye, down) == UNKNOWN
    for _ in range(3):
        v.update(0, 0, eye, 0.0, 90.0)
    assert v.target(0, 0, eye, down) == block_class(B.STONE)
    assert v.target(0, 0, eye, (0.0, 1.0, 0.0)) in (UNKNOWN, AIR_CLASS)


def _world_imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.startswith("fighter.world"):
                    found.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level == 1 and module == "world":
                found |= {f"fighter.world.{a.name}" for a in node.names}
            elif node.level == 1 and module.startswith("world."):
                found.add(f"fighter.{module}")
            elif module == "fighter.world":
                found |= {f"fighter.world.{a.name}" for a in node.names}
            elif module.startswith("fighter.world."):
                found.add(module)
    return found


@pytest.mark.parametrize("name", RESTRICTED)
def test_inputs_masks_and_critics_import_only_the_view(name):
    assert _world_imports(SOURCE_ROOT / name) <= {"fighter.world.view"}


def test_the_import_check_catches_a_true_block_import(tmp_path):
    bad = tmp_path / "bad.py"
    bad.write_text("from .world import kernel\nfrom fighter.world.gen import generate\nfrom .world.view import WorldView\n")
    found = _world_imports(bad)
    assert "fighter.world.kernel" in found and "fighter.world.gen" in found


def test_view_exposes_no_true_block_call():
    public = {n for n in dir(view) if not n.startswith("_")}
    assert not public & {"Arenas", "BaseWorld", "lib", "kernel", "gen", "pool", "blocks"}
    methods = {n for n in dir(WorldView) if not n.startswith("_")}
    assert methods == {
        "update", "update_all", "update_lines", "crop", "crop_all", "ray", "rays", "rays_many", "lines_seen",
        "notable", "target", "digest", "sight_range",
    }


def _attribute_chains(path: Path) -> set[str]:
    """Return every name read directly from a `.world` attribute in a source file."""
    found = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Attribute) and node.value.attr == "world":
            found.add(node.attr)
    return found


@pytest.mark.parametrize("name", ("obs.py", "perception.py", "rays.py", "interface.py", "policy.py"))
def test_inputs_masks_and_critics_never_call_the_world_object(name):
    assert _attribute_chains(SOURCE_ROOT / name) == set()


def test_the_world_call_check_catches_a_true_block_read(tmp_path):
    bad = tmp_path / "bad.py"
    bad.write_text("def f(sim):\n    return sim.world.ray_block_many(1, 2, 3)\n")
    assert _attribute_chains(bad) == {"ray_block_many"}


class _NoTrueBlocks:
    """Stands in for the world and fails on any attribute read."""

    def __getattr__(self, name):
        raise AssertionError(f"read the world directly through {name}")


def test_inputs_and_masks_run_with_the_world_object_removed(cells):
    settled, _ = cells
    sim = _sim_on(settled)
    script = np.random.default_rng(41)
    for _ in range(12):
        sim.step(script.integers(0, A.NVEC, size=(sim.n, 2, len(A.NVEC))))
    view = sim.world_view()
    world = sim.world
    expected = [build_obs(sim, seat, 600).tobytes() for seat in (0, 1)]
    expected_masks = [build_masks(sim, seat).tobytes() for seat in (0, 1)]
    sim.world = _NoTrueBlocks()
    sim.world_view = lambda: view
    try:
        assert [build_obs(sim, seat, 600).tobytes() for seat in (0, 1)] == expected
        assert [build_masks(sim, seat).tobytes() for seat in (0, 1)] == expected_masks
    finally:
        del sim.world_view
        sim.world = world
    sim.close()


def test_block_inputs_ignore_a_block_the_body_has_not_seen():
    plain = flat_raw()
    changed = flat_raw()
    changed[16, 2, yi(FLOOR) + 1 : yi(FLOOR) + 4] = B.STONE
    results = []
    for raw in (plain, changed):
        sim = Sim(1, SimConfig(armor="none", arena_half=64.0))
        sim.attach_world(make(raw))
        sim.pos[0, 0] = [16.5, Y, 8.5]
        sim.pos[0, 1] = [16.5, Y, 13.5]
        sim.yaw[0] = [0.0, 180.0]
        for _ in range(4):
            sim.update_sight()
        results.append(build_obs(sim, 0, 600)[0, 96:128].tobytes())
        sim.close()
    assert results[0] == results[1]


def test_block_inputs_report_a_block_once_it_is_seen():
    plain = flat_raw()
    changed = flat_raw()
    changed[14:19, 2, yi(FLOOR) + 1 : yi(FLOOR) + 5] = B.STONE
    results = []
    for raw in (plain, changed):
        sim = Sim(1, SimConfig(armor="none", arena_half=64.0))
        sim.attach_world(make(raw))
        sim.pos[0, 0] = [16.5, Y, 8.5]
        sim.pos[0, 1] = [16.5, Y, 13.5]
        sim.yaw[0] = [180.0, 180.0]
        for _ in range(4):
            sim.update_sight()
        results.append(build_obs(sim, 0, 600)[0, 96:128].tobytes())
        sim.close()
    assert results[0] != results[1]


def _hidden_cells(cells_array):
    ids = cells_array & 0xFF
    opaque = np.array([b.opaque for b in B.BLOCKS] + [True] * (256 - len(B.BLOCKS)))[ids]
    inner = opaque[1:-1, 1:-1, 1:-1].copy()
    for axis in range(3):
        for shift in (-2, 0):
            slices = [slice(1, -1)] * 3
            slices[axis] = slice(shift + 2 if shift == 0 else 0, shift if shift else None)
            inner &= opaque[tuple(slices)]
    coords = np.argwhere(inner) + 1
    checker = coords.sum(axis=1) % 2 == 0
    return coords[checker]


def _script(rng, info, steps):
    x, z = 32.0, 32.0
    rows = []
    for _ in range(steps):
        x = float(np.clip(x + rng.uniform(-0.5, 0.5), 8, 55))
        z = float(np.clip(z + rng.uniform(-0.5, 0.5), 8, 55))
        y = int(info.height[int(x), int(z)]) + 1
        rows.append((x, y + 1.62, z, float(rng.uniform(-180, 180)), float(rng.uniform(-60, 60))))
    return rows


def _outputs(v, row):
    eye, yaw, pitch = row[:3], row[3], row[4]
    look = look_vector(yaw, pitch)
    fan = np.array([look_vector(yaw + a, pitch) for a in range(0, 360, 45)])
    dists, unknown = v.rays(0, 0, eye, fan, 8.0)
    return [
        v.crop(0, 0, 7, 5, 7).tobytes(),
        dists.tobytes(),
        unknown.tobytes(),
        v.notable(0, 0, -1, 32).tobytes(),
        int(v.target(0, 0, eye, look)),
        v.digest(0, 0),
    ]


def test_no_xray(cells):
    settled, info = cells
    hidden = _hidden_cells(settled)
    assert len(hidden) > 10_000
    rng = np.random.default_rng(13)
    choices = np.array([B.ORE_IDS["diamond"][0], B.LAVA_SOURCE, B.AIR], dtype=np.uint16)
    other = settled.copy()
    other[hidden[:, 0], hidden[:, 1], hidden[:, 2]] = choices[rng.integers(0, 3, len(hidden))]
    assert (other != settled).sum() > 10_000

    first = Arenas(BaseWorld.from_array(settled), 1)
    second = Arenas(BaseWorld.from_array(other), 1)
    view_a, view_b = WorldView(first), WorldView(second)
    for t, row in enumerate(_script(np.random.default_rng(17), info, 300)):
        for world in (first, second):
            world.tick(2)
            if t % 25 == 0:
                x, z = int(row[0]) + 2, int(row[2]) + 2
                world.set(x, int(info.height[x, z]) + 3, z, B.COBBLESTONE)
        view_a.update(0, 0, row[:3], row[3], row[4])
        view_b.update(0, 0, row[:3], row[3], row[4])
        assert _outputs(view_a, row) == _outputs(view_b, row), t


def _sim_on(cells_array, n=4):
    sim = Sim(n, SimConfig(armor="none", arena_half=20.0, spawn_min=3.0, spawn_max=6.0), seed=21)
    sim.attach_world(Arenas(BaseWorld.from_array(cells_array), n, seed=21))
    sim.reset()
    return sim


def _sim_outputs(sim):
    view = sim.world_view()
    out = [sim.pos.tobytes(), view.crop_all(2, 7, 5, 7).tobytes()]
    for seat in (0, 1):
        out.append(build_obs(sim, seat, 600).tobytes())
        out.append(build_masks(sim, seat).tobytes())
        yaw, pitch, flight = intercept_angles(sim, seat, np.full(sim.n, C.BOW_MAX_SPEED))
        out += [yaw.tobytes(), pitch.tobytes(), flight.tobytes()]
        for name in sorted(SCRIPTED):
            out.append(SCRIPTED[name](sim, seat, np.random.default_rng(5)).tobytes())
    for arena in range(sim.n):
        for seat in (0, 1):
            eye = sim.eyes()[arena, seat]
            look = sim.look()[arena, seat]
            out.append(view.ray(arena, seat, eye, look, 8.0))
            out.append(view.target(arena, seat, eye, look))
            out.append(view.notable(arena, seat, -1, 16).tobytes())
    return out


def test_no_xray_through_the_simulator(cells):
    settled, _ = cells
    hidden = _hidden_cells(settled)
    rng = np.random.default_rng(31)
    choices = np.array([B.ORE_IDS["diamond"][0], B.LAVA_SOURCE, B.AIR], dtype=np.uint16)
    other = settled.copy()
    other[hidden[:, 0], hidden[:, 1], hidden[:, 2]] = choices[rng.integers(0, 3, len(hidden))]
    first, second = _sim_on(settled), _sim_on(other)
    assert _sim_outputs(first) == _sim_outputs(second)
    script = np.random.default_rng(37)
    airborne = 0
    for t in range(250):
        action = script.integers(0, A.NVEC, size=(first.n, 2, len(A.NVEC)))
        first.step(action)
        second.step(action)
        airborne += int((~first.on_ground).sum())
        assert _sim_outputs(first) == _sim_outputs(second), t
    assert airborne > 0
    first.close()
    second.close()


def test_aim_solver_does_not_reveal_an_unseen_floor():
    near = flat_raw()
    pit = flat_raw()
    pit[10:22, 26:32, yi(FLOOR - 20) : yi(FLOOR) + 1] = B.AIR
    aims = []
    for raw in (near, pit):
        sim = Sim(1, SimConfig(armor="none", arena_half=64.0))
        sim.attach_world(make(raw))
        sim.pos[0, 0] = [16.5, Y, 4.5]
        sim.pos[0, 1] = [16.5, Y + 2.0, 28.5]
        sim.vel[0, 1] = [0.0, -0.5, 0.0]
        sim.on_ground[0, 1] = False
        sim.yaw[0, 0] = 180.0
        for _ in range(4):
            sim.update_sight()
        yaw, pitch, flight = intercept_angles(sim, 0, np.array([C.BOW_MAX_SPEED]))
        aims.append((yaw.tobytes(), pitch.tobytes(), flight.tobytes()))
        sim.close()
    assert aims[0] == aims[1]


def test_aim_solver_uses_a_floor_the_shooter_has_seen():
    results = []
    for raw in (flat_raw(), None):
        if raw is None:
            raw = flat_raw()
            raw[10:22, 24:32, yi(FLOOR - 20) : yi(FLOOR) + 1] = B.AIR
        sim = Sim(1, SimConfig(armor="none", arena_half=64.0))
        sim.attach_world(make(raw))
        sim.pos[0, 0] = [16.5, Y + 1.0, 22.5]
        sim.pos[0, 1] = [16.5, Y + 1.0, 27.5]
        sim.vel[0, 1] = [0.0, -1.0, 0.0]
        sim.on_ground[0, 1] = False
        sim.yaw[0, 0] = 0.0
        sim.pitch[0, 0] = 30.0
        for _ in range(8):
            sim.update_sight()
        results.append(float(intercept_angles(sim, 0, np.array([C.BOW_MAX_SPEED]))[1][0]))
        sim.close()
    assert results[0] != results[1]


def test_digging_exposes_only_the_new_faces():
    raw = flat_raw()
    ore = B.ORE_IDS["diamond"][0]
    raw[16, 16, yi(FLOOR - 2)] = ore
    world = make(raw)
    v = WorldView(world)
    eye = (16.5, Y + 1.62, 16.5)
    for _ in range(8):
        v.update(0, 0, eye, 0.0, 90.0)
    before = v.crop(0, 0, 8, 8, 8)
    assert not (before == block_class(ore)).any()
    opened = [(16, FLOOR, 16), (16, FLOOR - 1, 16)]
    for cell in opened:
        world.set(*cell, B.AIR)
    for _ in range(8):
        v.update(0, 0, eye, 0.0, 90.0)
    after = v.crop(0, 0, 8, 8, 8)
    assert (after == block_class(ore)).sum() == 1
    center = (16, int(np.floor(eye[1])), 16)
    fresh = np.argwhere((before == UNKNOWN) & (after != UNKNOWN))
    assert len(fresh) > 0
    for ox, oz, oy in fresh.tolist():
        cell = (center[0] + ox - 8, center[1] + oy - 8, center[2] + oz - 8)
        touching = any(abs(cell[0] - c[0]) + abs(cell[1] - c[1]) + abs(cell[2] - c[2]) <= 1 for c in opened)
        assert touching, cell
