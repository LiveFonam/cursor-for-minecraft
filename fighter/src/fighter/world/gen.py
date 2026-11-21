"""Seeded terrain: plain land, light forest, very small rivers, caves, pools and ores.

Cells are uint16 and indexed (x, z, y index), where y index 0 is Y -64. Every
random number comes from a 64 bit generator defined here, and trigonometry
comes from a rounded table, so a seed names the same world on any machine.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from . import blocks as B
from .config import BAND_ABOVE, BAND_BELOW, FULL, WorldConfig

GENERATOR_VERSION = 1
SIZES = (64, 128, 256)
Y0 = B.Y_MIN
HEIGHT = B.WORLD_HEIGHT
MASK = (1 << 64) - 1
GAMMA = 0x9E3779B97F4A7C15

HOST = np.zeros(256, dtype=bool)
HOST[[B.STONE, B.DEEPSLATE, B.GRANITE, B.DIORITE, B.ANDESITE, B.TUFF]] = True

# Largest cell count of a blob for each ore size.
BLOB_CELLS = {4: 5, 7: 10, 8: 10, 9: 13, 10: 16, 12: 23, 17: 37, 33: 33, 64: 64}
BLOB_RADIUS = {s: round(max((c * 0.75 / math.pi) ** (1 / 3) * 1.18, 0.7), 4) for s, c in BLOB_CELLS.items()}

# name, size, tries per chunk, low Y, high Y, triangle shape, discard chance next to air
ORE_BATCHES = (
    ("coal", 17, 20, 0, 192, True, 0.5),
    ("coal", 17, 30, 136, 320, False, 0.0),
    ("iron", 4, 10, -64, 72, False, 0.0),
    ("iron", 9, 10, -24, 56, True, 0.0),
    ("iron", 9, 90, 80, 384, True, 0.0),
    ("copper", 10, 16, -16, 112, True, 0.0),
    ("gold", 9, 4, -64, 32, True, 0.5),
    ("gold", 9, 0.5, -64, -48, False, 0.5),
    ("redstone", 8, 4, -64, 15, False, 0.0),
    ("redstone", 8, 8, -96, -32, True, 0.0),
    ("lapis", 7, 2, -32, 32, True, 0.0),
    ("lapis", 7, 4, -64, 64, False, 1.0),
    ("diamond", 4, 7, -144, 16, True, 0.5),
    ("diamond", 8, 4, -144, 16, True, 1.0),
    ("diamond", 12, 1 / 9, -144, 16, True, 0.7),
    ("diamond", 8, 2, -64, -4, False, 0.5),
)

# block, size, tries per chunk, low Y, high Y
POCKETS = (
    (B.DIRT, 33, 7, 0, 160),
    (B.GRAVEL, 33, 14, -64, 320),
    (B.GRANITE, 64, 2, 0, 60),
    (B.GRANITE, 64, 1 / 6, 64, 128),
    (B.DIORITE, 64, 2, 0, 60),
    (B.DIORITE, 64, 1 / 6, 64, 128),
    (B.ANDESITE, 64, 2, 0, 60),
    (B.ANDESITE, 64, 1 / 6, 64, 128),
    (B.TUFF, 64, 2, -64, 0),
)

_ANGLES = 4096
_SIN = np.round(np.sin(2.0 * np.pi * np.arange(_ANGLES) / _ANGLES) * 65536.0) / 65536.0


def _sin(angle: float) -> float:
    return float(_SIN[int(math.floor(angle * _ANGLES / (2.0 * math.pi))) % _ANGLES])


def _cos(angle: float) -> float:
    return float(_SIN[(int(math.floor(angle * _ANGLES / (2.0 * math.pi))) + _ANGLES // 4) % _ANGLES])


class Stream:
    """A SplitMix64 random stream with scalar and array draws."""

    def __init__(self, seed: int):
        self.state = seed & MASK

    def u64(self) -> int:
        self.state = (self.state + GAMMA) & MASK
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
        return z ^ (z >> 31)

    def random(self) -> float:
        return (self.u64() >> 11) * (1.0 / (1 << 53))

    def integers(self, low: int, high: int) -> int:
        """Return an integer in low to high, excluding high."""
        return low + (self.u64() >> 11) % (high - low)

    def uniform(self, low: float, high: float) -> float:
        return low + (high - low) * self.random()

    def normal(self, sd: float = 1.0) -> float:
        """Return a near normal value from a sum of twelve uniforms."""
        return (sum(self.random() for _ in range(12)) - 6.0) * sd

    def array(self, shape) -> np.ndarray:
        """Return uniform doubles in 0 to 1 with the given shape."""
        size = int(np.prod(shape))
        steps = np.arange(1, size + 1, dtype=np.uint64)
        z = np.uint64(self.state) + steps * np.uint64(GAMMA)
        self.state = (self.state + size * GAMMA) & MASK
        z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        z = z ^ (z >> np.uint64(31))
        return ((z >> np.uint64(11)).astype(np.float64) * (1.0 / (1 << 53))).reshape(shape)


def _streams(seed: int, count: int) -> list[Stream]:
    root = Stream(seed ^ 0x5EED5EED5EED5EED)
    return [Stream(root.u64()) for _ in range(count)]


def _lattice(rng: Stream, size: int, cell: float) -> np.ndarray:
    n = int(size / cell) + 3
    grid = rng.array((n, n)) * 2.0 - 1.0
    c = (np.arange(size) + rng.random() * cell) / cell
    i = c.astype(np.int64)
    f = c - i
    f = f * f * (3.0 - 2.0 * f)
    a, b = i[:, None], i[None, :]
    u, v = f[:, None], f[None, :]
    return (
        grid[a, b] * (1 - u) * (1 - v)
        + grid[a + 1, b] * u * (1 - v)
        + grid[a, b + 1] * (1 - u) * v
        + grid[a + 1, b + 1] * u * v
    )


def _fbm(rng: Stream, size: int, cell: float, octaves: int) -> np.ndarray:
    out = np.zeros((size, size))
    amp, total = 1.0, 0.0
    for _ in range(octaves):
        out += _lattice(rng, size, cell) * amp
        total += amp
        amp *= 0.5
        cell = max(cell / 2.0, 2.0)
    return out / total


def limit_slope(h: np.ndarray) -> np.ndarray:
    """Lower columns so that side by side columns differ by at most one block."""
    for axis in (0, 1):
        n = h.shape[axis]
        shape = [1, 1]
        shape[axis] = n
        idx = np.arange(n).reshape(shape)
        h = np.minimum(h, np.minimum.accumulate(h - idx, axis=axis) + idx)
        h = np.minimum(h, np.flip(np.minimum.accumulate(np.flip(h + idx, axis), axis=axis), axis) - idx)
    return h


def _river_paths(rng: Stream, size: int, count: int) -> list[list[tuple[int, int]]]:
    paths = []
    for _ in range(count):
        z = rng.integers(size // 4, 3 * size // 4)
        heading = 0.0
        path: list[tuple[int, int]] = []
        for x in range(size):
            heading = min(max(heading * 0.92 + rng.normal(0.16), -0.8), 0.8)
            target = min(max(int(math.floor(z + heading + 0.5)), 4), size - 5)
            for zz in range(z, target, 1 if target > z else -1):
                path.append((x, zz))
            z = target
            path.append((x, z))
        paths.append(path)
    return paths


def _carve(b, cx, cy, cz, r, protect, ceiling=None):
    W = b.shape[0]
    R = int(math.ceil(r))
    x0, x1 = max(cx - R, 0), min(cx + R + 1, W)
    z0, z1 = max(cz - R, 0), min(cz + R + 1, W)
    y0, y1 = max(cy - R, 5), min(cy + R + 1, HEIGHT)
    if x0 >= x1 or z0 >= z1 or y0 >= y1:
        return
    gx, gz, gy = np.ogrid[x0 - cx : x1 - cx, z0 - cz : z1 - cz, y0 - cy : y1 - cy]
    m = gx * gx + gz * gz + (gy * gy) * 1.3 <= r * r
    m = m & ~protect[x0:x1, z0:z1][..., None]
    if ceiling is not None:
        ys = np.arange(y0, y1)[None, None, :]
        m = m & (ys <= ceiling[x0:x1, z0:z1][..., None])
    w = b[x0:x1, z0:z1, y0:y1]
    w[m & (w != B.BEDROCK)] = B.AIR


def _blob(b, rng: Stream, code, deep_code, size, cx, cy, cz, discard=0.0):
    """Place a rough ellipsoid of up to the size's cell count, replacing host rock only."""
    W = b.shape[0]
    r = BLOB_RADIUS[size]
    limit = BLOB_CELLS[size]
    R = int(math.ceil(r)) + 1
    x0, x1 = max(cx - R, 0), min(cx + R + 1, W)
    z0, z1 = max(cz - R, 0), min(cz + R + 1, W)
    y0, y1 = max(cy - R, 0), min(cy + R + 1, HEIGHT)
    if x0 >= x1 or z0 >= z1 or y0 >= y1:
        return 0
    sx, sy, sz = rng.uniform(0.7, 1.3), rng.uniform(0.7, 1.3), rng.uniform(0.7, 1.3)
    gx, gz, gy = np.ogrid[x0 - cx : x1 - cx, z0 - cz : z1 - cz, y0 - cy : y1 - cy]
    d = (gx / sx) ** 2 + (gz / sz) ** 2 + (gy / sy) ** 2
    w = b[x0:x1, z0:z1, y0:y1]
    m = (d <= r * r) & (rng.array(d.shape) < 0.82) & HOST[w & 0xFF]
    idx = np.argwhere(m)
    if len(idx) == 0:
        return 0
    if len(idx) > limit:
        idx = idx[np.argsort(d[m], kind="stable")[:limit]]
    xs, zs, ys = idx[:, 0] + x0, idx[:, 1] + z0, idx[:, 2] + y0
    if discard > 0:
        near = (
            (b[np.minimum(xs + 1, W - 1), zs, ys] == B.AIR)
            | (b[np.maximum(xs - 1, 0), zs, ys] == B.AIR)
            | (b[xs, np.minimum(zs + 1, W - 1), ys] == B.AIR)
            | (b[xs, np.maximum(zs - 1, 0), ys] == B.AIR)
            | (b[xs, zs, np.minimum(ys + 1, HEIGHT - 1)] == B.AIR)
            | (b[xs, zs, np.maximum(ys - 1, 0)] == B.AIR)
        )
        keep = ~(near & (rng.array(near.shape) < discard))
        xs, zs, ys = xs[keep], zs[keep], ys[keep]
    if deep_code is None:
        b[xs, zs, ys] = code
    else:
        cur = b[xs, zs, ys]
        deep = (cur == B.DEEPSLATE) | ((cur == B.TUFF) & (ys + Y0 < 0))
        b[xs, zs, ys] = np.where(deep, deep_code, code)
    return len(xs)


def _tries(rng: Stream, tries: float) -> int:
    whole = int(tries)
    return whole + int(rng.random() < tries - whole)


def _sample_y(rng: Stream, low: int, high: int, triangle: bool) -> int:
    if triangle:
        value = low + (high - low) * (rng.random() + rng.random()) / 2.0
        return int(math.floor(value + 0.5))
    return rng.integers(low, high + 1)


@dataclass
class WorldInfo:
    """Facts about a generated world, for tests and spawn placement."""

    seed: int
    size: int
    height: np.ndarray
    river: np.ndarray
    level: np.ndarray
    trees: int = 0
    ore_cells: dict[str, int] = field(default_factory=dict)
    chambers: int = 0


def surface_band(height: np.ndarray) -> tuple[int, int]:
    """Return the section aligned layers kept when underground depth is off."""
    low = (int(height.min()) - BAND_BELOW) // 16 * 16
    high = -((-(int(height.max()) + BAND_ABOVE)) // 16) * 16
    return max(low, B.Y_MIN), min(high, B.Y_MAX + 1)


def generate(
    seed: int,
    size: int = 128,
    rivers: int | None = None,
    caves: bool = True,
    ores: bool = True,
    trees: bool = True,
    config: WorldConfig = FULL,
) -> tuple[np.ndarray, WorldInfo]:
    """Return the unsettled cell array and facts about the world.

    Turning a feature off in the config removes it from the world.
    """
    W = size
    caves = caves and config.depth
    ores = ores and config.depth
    trees = trees and config.trees
    if not config.fluids:
        rivers = 0
    s = _streams(seed, 8)
    h = np.rint(70.0 + 6.5 * _fbm(s[0], W, 72.0, 3)).astype(np.int32)
    h = limit_slope(h)

    river = np.zeros((W, W), dtype=bool)
    level = np.full((W, W), -999, dtype=np.int32)
    bed = np.zeros((W, W), dtype=np.int32)
    count = max(1, round(2 * W * W / (128 * 128))) if rivers is None else rivers
    for path in _river_paths(s[1], W, count):
        width = s[1].integers(1, 4)
        current = 10**6
        for x, z in path:
            reach = width + 1
            current = min(current, int(h[max(x - reach, 0) : x + reach + 1, max(z - reach, 0) : z + reach + 1].min()) - 1)
            half = width // 2
            for i in range(max(x - half, 0), min(x + half + (width % 2), W)):
                for j in range(max(z - half, 0), min(z + half + (width % 2), W)):
                    if not river[i, j] or current < level[i, j]:
                        river[i, j] = True
                        level[i, j] = current
                        bed[i, j] = current - 1 - int(width > 1 and s[1].random() < 0.5)
    if river.any():
        limit = limit_slope(np.where(river, level, 10**6))
        h = np.minimum(h, limit + 1)
        h = np.where(river, bed, h)
        high = limit_slope(np.where(river, level + 1, 10**6))
        h = np.where(river, h, np.minimum(h, high))

    ix = np.arange(HEIGHT)[None, None, :]
    yy = np.arange(HEIGHT) + Y0
    b = np.full((W, W, HEIGHT), B.STONE, dtype=np.uint16)
    b[..., yy <= 0] = B.DEEPSLATE
    band = np.flatnonzero((yy > 0) & (yy < 8))
    chance = (8.0 - yy[band]) / 8.0
    b[..., band] = np.where(s[2].array((W, W, len(band))) < chance, B.DEEPSLATE, B.STONE)
    b[..., 0] = B.BEDROCK
    for layer, p in zip(range(1, 5), (0.8, 0.6, 0.4, 0.2)):
        b[..., layer] = np.where(s[2].array((W, W)) < p, B.BEDROCK, b[..., layer])

    top = h - Y0
    t = top[..., None]
    b[ix > t] = B.AIR
    soil = (ix <= t) & (ix > t - 4)
    b[soil] = B.DIRT
    b[(ix == t) & ~river[..., None]] = B.GRASS
    b[(ix == t) & river[..., None]] = B.SAND

    protect = river.copy()
    for _ in range(3):
        grown = protect.copy()
        grown[1:] |= protect[:-1]
        grown[:-1] |= protect[1:]
        grown[:, 1:] |= protect[:, :-1]
        grown[:, :-1] |= protect[:, 1:]
        protect = grown

    chunks = (W // 16) ** 2
    rng = s[3]
    chambers: list[tuple[int, int, int, float]] = []
    if caves:
        ceiling = top - 5
        for _ in range(int(chunks * 1.1)):
            x, y, z = rng.uniform(0, W), rng.uniform(6, 125), rng.uniform(0, W)
            yaw, pitch = rng.uniform(0, 2.0 * math.pi), rng.uniform(-0.4, 0.4)
            base = rng.uniform(1.3, 2.8)
            for k in range(rng.integers(50, 170)):
                yaw += rng.normal(0.22)
                pitch = min(max(pitch * 0.92 + rng.normal(0.09), -0.8), 0.8)
                x += _cos(yaw) * _cos(pitch)
                z += _sin(yaw) * _cos(pitch)
                y += _sin(pitch)
                ci, cj, cy = int(x), int(z), int(y)
                if not (0 <= ci < W and 0 <= cj < W) or x < 0 or z < 0:
                    break
                radius = base * (0.8 + 0.4 * _sin(k * 0.21))
                near_top = cy + radius >= top[ci, cj] - 4
                if near_top and rng.random() > 0.015:
                    continue
                _carve(b, ci, cy, cj, radius, protect, None if near_top else ceiling)
        for _ in range(int(chunks * 0.16)):
            ci, cj = rng.integers(0, W), rng.integers(0, W)
            cy = rng.integers(8, 100)
            r = rng.uniform(4.5, 8.5)
            _carve(b, ci, cy, cj, r, protect, ceiling)
            chambers.append((ci, cy, cj, r))

        if config.fluids:
            deep = np.flatnonzero(yy <= -55)
            low = b[..., deep]
            low[low == B.AIR] = B.LAVA_SOURCE
            b[..., deep] = low
        for ci, cy, cj, r in chambers if config.fluids else ():
            if cy + Y0 <= -55 or rng.random() >= 0.3:
                continue
            fill = B.WATER_SOURCE
            if cy + Y0 < 0 and rng.random() < 0.35:
                fill = B.LAVA_SOURCE
            R = int(math.ceil(r))
            x0, x1 = max(ci - R, 0), min(ci + R + 1, W)
            z0, z1 = max(cj - R, 0), min(cj + R + 1, W)
            y0, y1 = max(cy - R, 5), cy - int(r * 0.25) + 1
            if y0 >= y1:
                continue
            gx, gz, gy = np.ogrid[x0 - ci : x1 - ci, z0 - cj : z1 - cj, y0 - cy : y1 - cy]
            inside = gx * gx + gz * gz + (gy * gy) * 1.3 <= r * r
            w = b[x0:x1, z0:z1, y0:y1]
            w[inside & (w == B.AIR)] = fill

    rng = s[4]
    for code, blob_size, tries, low_y, high_y in POCKETS if config.depth else ():
        for cx in range(W // 16):
            for cz in range(W // 16):
                for _ in range(_tries(rng, tries)):
                    wy = rng.integers(low_y, high_y + 1)
                    x, z = cx * 16 + rng.integers(0, 16), cz * 16 + rng.integers(0, 16)
                    if wy < Y0 or wy > h[x, z]:
                        continue
                    _blob(b, rng, code, None, blob_size, x, wy - Y0, z)

    ore_cells = {n: 0 for n in B.ORE_NAMES}
    if ores:
        rng = s[5]
        for name, blob_size, tries, low_y, high_y, triangle, discard in ORE_BATCHES:
            plain, deep_id = B.ORE_IDS[name]
            for cx in range(W // 16):
                for cz in range(W // 16):
                    for _ in range(_tries(rng, tries)):
                        wy = _sample_y(rng, low_y, high_y, triangle)
                        x, z = cx * 16 + rng.integers(0, 16), cz * 16 + rng.integers(0, 16)
                        if wy < Y0 or wy > h[x, z]:
                            continue
                        ore_cells[name] += _blob(b, rng, plain, deep_id, blob_size, x, wy - Y0, z, discard)

    placed = 0
    if trees:
        forest = _fbm(s[6], W, 48.0, 2)
        rng = s[7]
        columns = np.arange(W)
        surface = b[columns[:, None], columns[None, :], top]
        spots = np.argwhere((surface == B.GRASS) & ~protect)
        spots = spots[np.argsort(rng.array(len(spots)), kind="stable")]
        taken = np.zeros((W, W), dtype=bool)
        leaf = B.leaves(1)
        for x, z in spots.tolist():
            if rng.random() > (0.028 if forest[x, z] > 0.08 else 0.0015):
                continue
            if x < 3 or z < 3 or x > W - 4 or z > W - 4 or taken[x - 3 : x + 4, z - 3 : z + 4].any():
                continue
            taken[x, z] = True
            base_y = int(top[x, z]) + 1
            tall = rng.integers(4, 7)
            b[x, z, base_y - 1] = B.DIRT
            for dy in range(tall + 2):
                r = 2 if dy in (tall - 2, tall - 1) else 1 if dy >= tall else 0
                if r:
                    w = b[x - r : x + r + 1, z - r : z + r + 1, base_y + dy]
                    keep = rng.array(w.shape) < 0.9
                    w[(w == B.AIR) & keep] = leaf
            b[x, z, base_y : base_y + tall] = B.log(1)
            placed += 1

    if river.any():
        water = (ix > t) & (ix <= (level - Y0)[..., None]) & river[..., None]
        b[water] = B.WATER_SOURCE

    info = WorldInfo(seed, W, h, river, level, placed, ore_cells, len(chambers))
    return b, info
