"""Speed gates for each world profile, measured against the flat arena on this machine.

Run with `python -m fighter.world.bench`. The exit code is 1 when a gate fails.
Pass `--baseline-src DIR` to compare the flat path with another source tree.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time

import numpy as np

from .. import actions as A
from .. import rays as R
from ..obs import build_obs
from ..sim import Sim
from . import blocks as B
from . import gen, pool
from .config import FULL, SURFACE, WorldConfig
from .kernel import Arenas, BaseWorld
from .view import WorldView

# World cost budgets in microseconds per decision, for a flat cost of FLAT_REFERENCE_US.
FLAT_REFERENCE_US = 30.1
BUDGET_US = {
    "block fight": 0.7,
    "bucket fight": 17.1,
    "mining range 8": 6.5,
    "mining range 12": 13.4,
    "surface range 8": 18.1,
    "surface range 12": 43.4,
    "batched surface": 22.6,
    "travelling surface": 31.7,
}
BATCH_ARENAS = 256
BATCH_DECISIONS = 120
TRAVEL_SPEED = 0.5
JITTER = 0.25
TURN_PER_DECISION = 7.0
MAX_SLOWDOWN = 1.25
MAX_FLAT_SLOWDOWN = 1.03
PARTS = ("collision", "fluid and contact", "world ticks", "sight", "crop", "edits")

FLAT_CODE = """
import hashlib, json, time
import numpy as np
from fighter import actions as A
from fighter.obs import build_obs
from fighter.sim import Sim
steps = {steps}
sim = Sim(64, seed=1)
rng = np.random.default_rng(1)
acts = np.stack([rng.integers(0, A.NVEC, size=(64, 2, len(A.NVEC))) for _ in range(32)])
digest = hashlib.sha256()
start = time.perf_counter()
for k in range(steps):
    sim.step(acts[k % 32])
    build_obs(sim, 0, 600)
    build_obs(sim, 1, 600)
seconds = time.perf_counter() - start
for array in (sim.pos, sim.vel, sim.yaw, sim.pitch, sim.hp, sim.arrow_pos, sim.arrow_vel):
    digest.update(array.tobytes())
print(json.dumps({{"us": seconds / (64 * steps) * 1e6, "digest": digest.hexdigest()}}))
"""


def flat_us(steps: int = 600) -> float:
    """Return microseconds per arena decision for the flat simulator with both observations."""
    sim = Sim(64, seed=1)
    rng = np.random.default_rng(1)
    acts = np.stack([rng.integers(0, A.NVEC, size=(64, 2, len(A.NVEC))) for _ in range(32)])
    start = time.perf_counter()
    for k in range(steps):
        sim.step(acts[k % 32])
        build_obs(sim, 0, 600)
        build_obs(sim, 1, 600)
    return (time.perf_counter() - start) / (64 * steps) * 1e6


def _flat_run(source: str, steps: int) -> dict:
    env = {**os.environ, "PYTHONPATH": source, "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}
    out = subprocess.run(
        [sys.executable, "-c", FLAT_CODE.format(steps=steps)],
        env=env, check=True, capture_output=True, text=True,
    )
    return json.loads(out.stdout)


def compare_flat(baseline_src: str, rounds: int = 7, steps: int = 800) -> dict:
    """Alternate runs of a baseline tree and this tree. Return timing and bit identity."""
    here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    base_runs, new_runs = [], []
    for i in range(rounds):
        order = ((baseline_src, base_runs), (here, new_runs))
        for source, runs in order if i % 2 == 0 else order[::-1]:
            runs.append(_flat_run(source, steps))
    base_us = statistics.median(r["us"] for r in base_runs)
    new_us = statistics.median(r["us"] for r in new_runs)
    digests = {r["digest"] for r in base_runs + new_runs}
    return {
        "baseline_us": round(base_us, 3),
        "current_us": round(new_us, 3),
        "slowdown": round(new_us / base_us, 4),
        "bit_identical": len(digests) == 1,
        "passed": len(digests) == 1 and new_us / base_us <= MAX_FLAT_SLOWDOWN,
    }


def _measure(base, config, spot, sight_range, edit, bucket, sight, decisions) -> tuple[float, np.ndarray, int]:
    runs = []
    for _ in range(3):
        arenas = Arenas(base, 1, config=config)
        runs.append(arenas.bench(decisions, sight_range, spot, edit, bucket, sight))
        arenas.close()
    arenas = Arenas(base, 1, config=config)
    parts = np.zeros(len(PARTS))
    arenas.bench(decisions, sight_range, spot, edit, bucket, sight, parts=parts)
    memory = arenas.memory()
    arenas.close()
    return float(np.median(runs)), parts, memory


def _cave_spot(cells: np.ndarray) -> tuple[float, float, float]:
    """Return the first standing spot inside a cave."""
    ids = cells & 0xFF
    low, high = -24 - B.Y_MIN, 46 - B.Y_MIN
    open_here = (ids[..., low:high] == B.AIR) & (ids[..., low + 1 : high + 1] == B.AIR)
    floor = np.array([b.solid for b in B.BLOCKS] + [False] * (256 - len(B.BLOCKS)))[ids[..., low - 1 : high - 1]]
    x, z, y = np.argwhere(open_here & floor)[0]
    return x + 0.5, float(y + low + B.Y_MIN), z + 0.5


def _scene(name, flat_cost, world_cost, parts, memory) -> dict:
    budget = BUDGET_US[name]
    allowed = flat_cost * (1.0 + budget / FLAT_REFERENCE_US) * MAX_SLOWDOWN
    total = flat_cost + world_cost
    return {
        "world_us": round(world_cost, 2),
        "total_us": round(total, 2),
        "allowed_total_us": round(allowed, 2),
        "share_of_flat": round(flat_cost / total, 3),
        "arena_bytes": memory,
        "parts_us": {p: round(float(v), 2) for p, v in zip(PARTS, parts)},
        "passed": total <= allowed,
    }


def _batch_cost(base, config, heights, travel: bool, arenas: int = BATCH_ARENAS) -> tuple[float, int]:
    """Return microseconds per arena decision for sight and the 26 rays of both bodies."""
    world = Arenas(base, arenas, config=config)
    view = WorldView(world)
    rng = np.random.default_rng(3)
    size = heights.shape[0]
    margin = 12.0
    xz = rng.uniform(margin, size - margin, size=(arenas, 2, 2))
    angle = rng.uniform(0.0, 2.0 * np.pi, size=(arenas, 2))
    heading = np.stack([np.cos(angle), np.sin(angle)], axis=-1)
    yaw = rng.uniform(-180.0, 180.0, size=(arenas, 2))
    pitch = np.zeros((arenas, 2))
    rows = np.arange(arenas)
    eyes = np.zeros((arenas, 2, 3))
    start = time.perf_counter()
    for _ in range(BATCH_DECISIONS):
        if travel:
            xz += heading * TRAVEL_SPEED
            out = (xz < margin) | (xz > size - margin)
            heading[out] *= -1.0
            xz = np.clip(xz, margin, size - margin)
            at = xz
        else:
            at = xz + rng.uniform(-JITTER, JITTER, size=xz.shape)
        cells = at.astype(np.int64)
        eyes[..., 0] = at[..., 0]
        eyes[..., 1] = heights[cells[..., 0], cells[..., 1]] + 2.62
        eyes[..., 2] = at[..., 1]
        yaw = (yaw + TURN_PER_DECISION + 180.0) % 360.0 - 180.0
        view.update_all(eyes, yaw, pitch)
        for seat in (0, 1):
            view.rays_many(rows, seat, eyes[:, seat], R.world_directions(yaw[:, seat]), R.RAY_RANGE)
    seconds = time.perf_counter() - start
    memory = world.memory()
    world.close()
    return seconds / (arenas * BATCH_DECISIONS) * 1e6, memory


def run(decisions: int = 6000, seed: int = 5, size: int = 128, flat_cost: float | None = None) -> dict:
    """Measure every profile and return the results with pass flags."""
    flat_cost = flat_us() if flat_cost is None else flat_cost
    results: dict = {"flat_us": round(flat_cost, 2), "profiles": {}}

    world, info = pool.build(seed, size, FULL)
    mid = size // 2
    land = (mid + 0.0, float(info.height[mid, mid] + 1), mid + 0.0)
    cells = Arenas(world, 1, memory_cap=0)
    cave = _cave_spot(cells.dump())
    cells.close()
    floor_raw = np.zeros((64, 64, B.WORLD_HEIGHT), dtype=np.uint16)
    floor_raw[..., : 37 - B.Y_MIN] = B.STONE
    floor = BaseWorld.from_array(floor_raw)
    fight = (32.0, 37.0, 32.0)

    scenes = {
        "block fight": (floor, fight, 8, 20, 0, False),
        "bucket fight": (floor, fight, 8, 20, 40, False),
        "mining range 8": (world, cave, 8, 8, 0, True),
        "mining range 12": (world, cave, 12, 8, 0, True),
        "surface range 8": (world, land, 8, 0, 0, True),
        "surface range 12": (world, land, 12, 0, 0, True),
    }
    full = {}
    for name, (base, spot, sight_range, edit, bucket, sight) in scenes.items():
        cost, parts, memory = _measure(base, FULL, spot, sight_range, edit, bucket, sight, decisions)
        full[name] = _scene(name, flat_cost, cost, parts, memory)
    results["profiles"]["full"] = {"passed": all(s["passed"] for s in full.values()), "scenes": full}

    shallow, shallow_info = pool.build(seed, size, SURFACE)
    spot = (mid + 0.0, float(shallow_info.height[mid, mid] + 1), mid + 0.0)
    cost, parts, memory = _measure(shallow, SURFACE, spot, 8, 0, 0, True, decisions)
    scene = _scene("surface range 8", flat_cost, cost, parts, memory)
    scene["base_bytes"] = shallow.size_bytes
    scene["full_base_bytes"] = world.size_bytes
    scene["sight_share_of_world"] = round(float(parts[3] / max(parts.sum(), 1e-9)), 3)
    scenes_surface = {"surface range 8": scene}
    for name, travel in (("batched surface", False), ("travelling surface", True)):
        batch, batch_memory = _batch_cost(shallow, SURFACE, shallow_info.height, travel)
        parts_batch = np.zeros(len(PARTS))
        parts_batch[PARTS.index("sight")] = batch
        scenes_surface[name] = _scene(name, flat_cost, batch, parts_batch, batch_memory)
    results["profiles"]["surface"] = {
        "passed": all(s["passed"] for s in scenes_surface.values()),
        "scenes": scenes_surface,
    }
    results["passed"] = all(p["passed"] for p in results["profiles"].values())
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="World speed gates")
    parser.add_argument("--baseline-src", help="source folder of the flat simulator to compare with")
    parser.add_argument("--decisions", type=int, default=6000)
    parser.add_argument("--output", help="write the results to this JSON file")
    args = parser.parse_args(argv)
    results = run(args.decisions)
    if args.baseline_src:
        arena = compare_flat(args.baseline_src)
        results["profiles"]["arena"] = arena
        results["passed"] = results["passed"] and arena["passed"]
    text = json.dumps(results, indent=1)
    print(text)
    if args.output:
        with open(args.output, "w") as stream:
            stream.write(text)
    return 0 if results["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
