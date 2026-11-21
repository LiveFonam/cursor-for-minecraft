"""Builds, settles, caches and memory maps base worlds.

A cache file holds one serialized world and is named by seed, size and
generator version. Files are mapped read only, so every worker shares one copy.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

import numpy as np

from . import blocks as B
from . import gen
from .config import FULL, WorldConfig
from .kernel import Arenas, BaseWorld

SETTLE_TICK_LIMIT = 40000
SETTLE_PASSES = 8


def default_cache_dir() -> Path:
    """Return the folder that holds cached worlds."""
    root = os.environ.get("XDG_CACHE_HOME")
    return (Path(root) if root else Path.home() / ".cache") / "fighter-world" / "worlds"


def settle(raw: np.ndarray, config: WorldConfig = FULL) -> tuple[np.ndarray, int]:
    """Run real fluid ticks until no fluid changes. Return the cells and the ticks used."""
    if not config.fluids:
        return raw, 0
    base = BaseWorld.from_array(raw)
    arenas = Arenas(base, 1, memory_cap=0, config=config)
    used = 0
    try:
        for _ in range(SETTLE_PASSES):
            before = arenas.writes()
            arenas.wake_fluids()
            while arenas.pending() and used < SETTLE_TICK_LIMIT:
                arenas.tick(1)
                used += 1
            if arenas.writes() == before:
                return arenas.dump(), used
        raise RuntimeError("fluids did not settle")
    finally:
        arenas.close()
        base.close()


def build(
    seed: int, size: int = 128, config: WorldConfig = FULL, **options
) -> tuple[BaseWorld, gen.WorldInfo]:
    """Generate and settle one world, storing only the surface band when depth is off."""
    raw, info = gen.generate(seed, size, config=config, **options)
    settled, _ = settle(raw, config)
    band = None if config.depth else gen.surface_band(info.height)
    return BaseWorld.from_array(settled, band), info


def _tables_tag() -> str:
    return hashlib.sha256(B.header_text().encode()).hexdigest()[:8]


def cache_path(
    seed: int, size: int, cache_dir: str | Path | None = None, config: WorldConfig = FULL
) -> Path:
    """Return the cache file for a world."""
    folder = Path(cache_dir) if cache_dir is not None else default_cache_dir()
    name = f"world-s{seed}-n{size}-c{config.features:x}-g{gen.GENERATOR_VERSION}-{_tables_tag()}.bin"
    return folder / name


def load(
    seed: int, size: int = 128, cache_dir: str | Path | None = None, config: WorldConfig = FULL
) -> BaseWorld:
    """Map a cached world read only, building and storing it first when needed."""
    path = cache_path(seed, size, cache_dir, config)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        world, _ = build(seed, size, config)
        try:
            handle, temp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
            with os.fdopen(handle, "wb") as stream:
                stream.write(world.to_bytes())
            os.replace(temp, path)
        finally:
            world.close()
    return BaseWorld.from_buffer(np.memmap(path, dtype=np.uint8, mode="r"))


class WorldPool:
    """A fixed set of base worlds shared by arenas and workers."""

    def __init__(
        self,
        count: int,
        size: int = 128,
        seed: int = 0,
        cache_dir: str | Path | None = None,
        config: WorldConfig = FULL,
    ):
        self.size = size
        self.config = config
        self.seeds = [seed + i for i in range(count)]
        self.worlds = [load(s, size, cache_dir, config) for s in self.seeds]

    def __len__(self) -> int:
        return len(self.worlds)

    def __getitem__(self, index: int) -> BaseWorld:
        return self.worlds[index]

    def close(self) -> None:
        """Release every mapped world."""
        for world in self.worlds:
            world.close()
        self.worlds = []
