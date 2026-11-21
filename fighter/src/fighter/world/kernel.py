"""Bindings to the C world kernel and batch calls over numpy arrays.

The shared library is compiled from `kernel.c` and the generated block header
the first time it is needed, and is cached by a hash of its sources.
"""

from __future__ import annotations

import ctypes as ct
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from . import blocks as B
from .config import FULL, WorldConfig

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "kernel.c"
ARENA_MEMORY_CAP = 256 * 1024
CLIENT_MODELS = {"vanilla": 0, "mineflayer": 1}

P = ct.c_void_p
I = ct.c_int
D = ct.c_double
U8 = ct.POINTER(ct.c_uint8)
U16 = ct.POINTER(ct.c_uint16)
U32 = ct.POINTER(ct.c_uint32)
I8 = ct.POINTER(ct.c_int8)
I32 = ct.POINTER(ct.c_int32)
DP = ct.POINTER(ct.c_double)
PP = ct.POINTER(ct.c_void_p)

_SIGNATURES: dict[str, tuple[object, list[object]]] = {
    "base_build": (P, [U16, I, I, I, I]),
    "base_open": (P, [P, ct.c_uint64]),
    "base_blob": (P, [P]),
    "base_bytes": (ct.c_uint64, [P]),
    "base_mixed": (ct.c_uint32, [P]),
    "base_raws": (ct.c_uint32, [P]),
    "base_nx": (I, [P]),
    "base_nz": (I, [P]),
    "base_ylo": (I, [P]),
    "base_yhi": (I, [P]),
    "base_free": (None, [P]),
    "arena_new": (P, [P, ct.c_uint64, ct.c_uint64, I, I]),
    "arena_reset": (None, [P]),
    "arena_free": (None, [P]),
    "arena_bytes": (ct.c_uint64, [P]),
    "arena_full": (I, [P]),
    "arena_edits": (ct.c_uint32, [P]),
    "arena_pending": (ct.c_uint32, [P]),
    "arena_now": (ct.c_uint32, [P]),
    "arena_fluid_ticks": (ct.c_uint64, [P]),
    "arena_block_ticks": (ct.c_uint64, [P]),
    "arena_sets": (ct.c_uint64, [P]),
    "arena_hot": (I, [P]),
    "arena_seed": (None, [P, ct.c_uint64]),
    "w_tick": (None, [P, I]),
    "w_tick_many": (None, [PP, I, I]),
    "w_get": (ct.c_uint16, [P, I, I, I]),
    "w_set": (None, [P, I, I, I, ct.c_uint16]),
    "w_poke": (None, [P, I, I, I, ct.c_uint16]),
    "w_schedule": (None, [P, I, I, I, I, I]),
    "w_flow": (None, [P, I, I, I, DP]),
    "w_fluid_height": (D, [P, I, I, I]),
    "w_trace_on": (None, [P, I]),
    "w_trace_read": (I, [P, U32]),
    "w_wake_all": (None, [P]),
    "w_dump": (None, [P, U16]),
    "w_item_count": (I, [P]),
    "w_items": (None, [P, DP]),
    "w_spawn_item": (None, [P, D, D, D, I, I, I, D, D, D]),
    "w_falling_count": (I, [P]),
    "w_spawn_falling": (None, [P, D, D, D, ct.c_uint16, D, I]),
    "w_falling_vy": (D, [P, I]),
    "w_xp": (ct.c_int32, [P, I]),
    "w_pickup": (I, [P, DP, D, D, I32, I32, I32, I]),
    "pickup_ready_many": (None, [PP, I, I, DP, DP, DP, U8]),
    "collide_many": (None, [PP, I, I, DP, DP, DP, DP, U8, D, DP, U8, U8]),
    "fluid_box_many": (None, [PP, I, I, DP, DP, DP, DP, U8, DP, DP, I32]),
    "contact_many": (None, [PP, I, I, DP, DP, DP, U8]),
    "ray_block_many": (None, [PP, I, I, DP, DP, D, U8, I32, I8, DP]),
    "ray_collide_many": (None, [PP, I, I, DP, DP, D, U8, I32, I8, DP]),
    "w_place": (I, [P, I, I, DP, DP, D, DP, I, I32]),
    "place_many": (None, [PP, I, I, I32, U8, DP, DP, DP, DP, I32]),
    "w_dig": (I, [P, I, I, I, I, I, I, I, I, I, I, I, DP, DP, I32]),
    "w_dig_stop": (None, [P, I]),
    "dig_many": (None, [PP, I, I, U8, I32, I32, U8, DP, DP, I32, I32]),
    "w_bucket_fill": (I, [P, I, DP, DP, I32]),
    "w_bucket_empty": (I, [P, I, I, DP, DP, I32]),
    "sight_table_cells": (I, [I]),
    "w_see": (ct.c_uint64, [P, I, D, D, D, D, D, I]),
    "see_many": (None, [PP, I, I, DP, DP, DP, I]),
    "view_crop": (None, [P, I, U8, I, I, I]),
    "crop_many": (None, [PP, I, I, U8, I, I, I]),
    "view_ray": (I, [P, I, DP, DP, D, DP]),
    "view_rays_many": (None, [PP, I32, I, I, DP, DP, I, D, DP, U8, DP]),
    "see_lines_many": (None, [PP, I32, I, I, DP, DP, DP, DP, I]),
    "view_lines_many": (None, [PP, I32, I, I, I, U8]),
    "view_target": (I, [P, I, DP, DP]),
    "view_notable": (I, [P, I, I, I, I32]),
    "view_digest": (ct.c_uint64, [P, I]),
    "view_enclosed": (ct.c_uint32, [P, I]),
    "w_bench": (D, [P, I, I, D, D, D, I, I, I, DP]),
}


def _library_name(digest: str) -> str:
    suffix = "dylib" if sys.platform == "darwin" else "so"
    return f"libworld-{platform.machine()}-{digest}.{suffix}"


def _build_dirs() -> list[Path]:
    """Return candidate folders for the compiled library, most preferred first."""
    dirs = [HERE / "_build"]
    cache = os.environ.get("XDG_CACHE_HOME")
    dirs.append((Path(cache) if cache else Path.home() / ".cache") / "fighter-world")
    dirs.append(Path(tempfile.gettempdir()) / "fighter-world")
    return dirs


def build_library() -> Path:
    """Compile the kernel if needed and return the path of the shared library."""
    header = B.header_text()
    digest = hashlib.sha256(SOURCE.read_bytes() + header.encode()).hexdigest()[:16]
    name = _library_name(digest)
    for folder in _build_dirs():
        if (folder / name).exists():
            return folder / name
    compiler = os.environ.get("CC") or shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
    if compiler is None:
        raise RuntimeError("the world kernel needs a C compiler (cc, gcc or clang)")
    last_error: Exception | None = None
    for folder in _build_dirs():
        try:
            folder.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=folder) as work:
                (Path(work) / "blocks_gen.h").write_text(header)
                out = Path(work) / name
                cmd = [compiler, "-O2", "-std=c11", "-D_POSIX_C_SOURCE=200809L", "-shared", "-fPIC",
                       f"-I{work}", "-o", str(out), str(SOURCE), "-lm"]
                subprocess.run(cmd, check=True, capture_output=True, text=True)
                os.replace(out, folder / name)
            return folder / name
        except OSError as error:
            last_error = error
        except subprocess.CalledProcessError as error:
            raise RuntimeError(f"building the world kernel failed:\n{error.stderr}") from error
    raise RuntimeError(f"no writable folder for the world kernel: {last_error}")


_lib: ct.CDLL | None = None


def lib() -> ct.CDLL:
    """Return the loaded kernel with every signature declared."""
    global _lib
    if _lib is None:
        loaded = ct.CDLL(str(build_library()))
        for name, (restype, argtypes) in _SIGNATURES.items():
            fn = getattr(loaded, name)
            fn.restype = restype
            fn.argtypes = argtypes
        _lib = loaded
    return _lib


def _ptr(array: np.ndarray, ctype):
    return array.ctypes.data_as(ct.POINTER(ctype))


def _vec(values) -> ct.Array:
    return (ct.c_double * 3)(float(values[0]), float(values[1]), float(values[2]))


class BaseWorld:
    """An immutable block world shared by arenas."""

    def __init__(self, handle: int, owner: object | None = None):
        self.handle = handle
        self._owner = owner
        self._lib = lib()
        self.nx = self._lib.base_nx(handle)
        self.nz = self._lib.base_nz(handle)
        self.y_low = self._lib.base_ylo(handle)
        self.y_high = self._lib.base_yhi(handle)

    @classmethod
    def from_array(cls, raw: np.ndarray, band: tuple[int, int] | None = None) -> "BaseWorld":
        """Build from a uint16 array indexed (x, z, y index), where y index 0 is Y -64.

        A band of (low Y, high Y), both multiples of 16, stores only those layers.
        Cells below it read as bedrock and cells above it read as air.
        """
        raw = np.asarray(raw, dtype=np.uint16)
        if raw.ndim != 3 or raw.shape[2] != B.WORLD_HEIGHT:
            raise ValueError("expected shape (nx, nz, 384)")
        low, high = band if band is not None else (B.Y_MIN, B.Y_MAX + 1)
        if low % 16 or high % 16 or low < B.Y_MIN or high > B.Y_MAX + 1 or low >= high:
            raise ValueError("the band must lie on section boundaries inside the world")
        data = np.ascontiguousarray(raw)
        handle = lib().base_build(_ptr(data, ct.c_uint16), raw.shape[0], raw.shape[1], low, high)
        return cls(handle)

    @classmethod
    def from_buffer(cls, buffer: np.ndarray) -> "BaseWorld":
        """Wrap serialized bytes without copying. The buffer must outlive the world."""
        handle = lib().base_open(buffer.ctypes.data_as(P), int(buffer.size))
        if not handle:
            raise ValueError("not a valid serialized world")
        return cls(handle, owner=buffer)

    def to_bytes(self) -> bytes:
        """Return the serialized world."""
        return ct.string_at(self._lib.base_blob(self.handle), self.size_bytes)

    @property
    def size_bytes(self) -> int:
        return int(self._lib.base_bytes(self.handle))

    @property
    def mixed_sections(self) -> int:
        return int(self._lib.base_mixed(self.handle))

    @property
    def raw_sections(self) -> int:
        return int(self._lib.base_raws(self.handle))

    def close(self) -> None:
        """Release the world. Arenas over it must be closed first."""
        if self.handle:
            self._lib.base_free(self.handle)
            self.handle = None


class Arenas:
    """A batch of private overlays on a base world."""

    def __init__(
        self,
        base: BaseWorld,
        n: int = 1,
        seed: int = 0,
        memory_cap: int = ARENA_MEMORY_CAP,
        client_model: str = "vanilla",
        config: WorldConfig = FULL,
    ):
        self._lib = lib()
        self.base = base
        self.n = n
        self.config = config
        self.model = CLIENT_MODELS[client_model]
        made = [
            self._lib.arena_new(base.handle, (seed * 1000003 + i) & (2**64 - 1), memory_cap, self.model, config.features)
            for i in range(n)
        ]
        self.handles = (ct.c_void_p * n)(*made)

    def close(self) -> None:
        """Free every arena."""
        if self.handles is not None:
            for handle in self.handles:
                self._lib.arena_free(handle)
            self.handles = None

    def __enter__(self) -> "Arenas":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def _h(self, arena: int) -> int:
        return self.handles[arena]

    def reset(self, mask: np.ndarray | None = None) -> None:
        """Drop the edits of the selected arenas, or of all arenas."""
        indices = range(self.n) if mask is None else np.flatnonzero(mask).tolist()
        for i in indices:
            self._lib.arena_reset(self.handles[i])

    def get(self, x: int, y: int, z: int, arena: int = 0) -> int:
        return int(self._lib.w_get(self._h(arena), x, y, z))

    def block(self, x: int, y: int, z: int, arena: int = 0) -> int:
        return self.get(x, y, z, arena) & 0xFF

    def set(self, x: int, y: int, z: int, value: int, arena: int = 0) -> None:
        """Write a cell and wake its neighbours."""
        self._lib.w_set(self._h(arena), x, y, z, value)

    def poke(self, x: int, y: int, z: int, value: int, arena: int = 0) -> None:
        """Write a cell without any tick or neighbour update."""
        self._lib.w_poke(self._h(arena), x, y, z, value)

    def tick(self, ticks: int = 1) -> None:
        self._lib.w_tick_many(self.handles, self.n, ticks)

    def schedule(self, wheel: int, x: int, y: int, z: int, delay: int, arena: int = 0) -> None:
        self._lib.w_schedule(self._h(arena), wheel, x, y, z, delay)

    def wake_fluids(self, arena: int = 0) -> None:
        self._lib.w_wake_all(self._h(arena))

    def dump(self, arena: int = 0) -> np.ndarray:
        """Return every cell of an arena as (nx, nz, 384)."""
        out = np.zeros((self.base.nx, self.base.nz, B.WORLD_HEIGHT), dtype=np.uint16)
        self._lib.w_dump(self._h(arena), _ptr(out, ct.c_uint16))
        return out

    def pending(self, arena: int = 0) -> int:
        return int(self._lib.arena_pending(self._h(arena)))

    def now(self, arena: int = 0) -> int:
        return int(self._lib.arena_now(self._h(arena)))

    def fluid_ticks(self, arena: int = 0) -> int:
        return int(self._lib.arena_fluid_ticks(self._h(arena)))

    def block_ticks(self, arena: int = 0) -> int:
        return int(self._lib.arena_block_ticks(self._h(arena)))

    def writes(self, arena: int = 0) -> int:
        return int(self._lib.arena_sets(self._h(arena)))

    def edits(self, arena: int = 0) -> int:
        return int(self._lib.arena_edits(self._h(arena)))

    def hot_sections(self, arena: int = 0) -> int:
        return int(self._lib.arena_hot(self._h(arena)))

    def memory(self, arena: int = 0) -> int:
        return int(self._lib.arena_bytes(self._h(arena)))

    def overflowed(self) -> np.ndarray:
        """Return which arenas hit the memory cap and must end the round."""
        return np.array([bool(self._lib.arena_full(h)) for h in self.handles])

    def trace_on(self, capacity: int = 3000, arena: int = 0) -> None:
        self._lib.w_trace_on(self._h(arena), capacity)

    def trace(self, arena: int = 0) -> np.ndarray:
        """Return fired ticks as rows of tick, cell id and wheel."""
        out = np.zeros(1 << 16, dtype=np.uint32)
        count = self._lib.w_trace_read(self._h(arena), _ptr(out, ct.c_uint32))
        return out[:count].reshape(-1, 3)

    def flow(self, x: int, y: int, z: int, arena: int = 0) -> np.ndarray:
        out = np.zeros(3)
        self._lib.w_flow(self._h(arena), x, y, z, _ptr(out, ct.c_double))
        return out

    def fluid_height(self, x: int, y: int, z: int, arena: int = 0) -> float:
        return float(self._lib.w_fluid_height(self._h(arena), x, y, z))

    def collide_many(
        self,
        pos: np.ndarray,
        delta: np.ndarray,
        width: np.ndarray,
        height: np.ndarray,
        was_ground: np.ndarray | None = None,
        step: float = 0.0,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Move boxes of shape (n, seats). Return position, axis contact bits and ground flags."""
        seats = pos.shape[1]
        out = np.empty_like(pos)
        contact = np.zeros(pos.shape[:2], dtype=np.uint8)
        ground = np.zeros(pos.shape[:2], dtype=np.uint8)
        prior = None
        if was_ground is not None:
            prior = _ptr(np.ascontiguousarray(was_ground, dtype=np.uint8), ct.c_uint8)
        self._lib.collide_many(
            self.handles, self.n, seats, _ptr(pos, ct.c_double),
            _ptr(np.ascontiguousarray(width, dtype=np.float64), ct.c_double),
            _ptr(np.ascontiguousarray(height, dtype=np.float64), ct.c_double),
            _ptr(np.ascontiguousarray(delta, dtype=np.float64), ct.c_double),
            prior, step, _ptr(out, ct.c_double), _ptr(contact, ct.c_uint8), _ptr(ground, ct.c_uint8),
        )
        return out, contact, ground.astype(bool)

    def fluid_box_many(
        self, pos: np.ndarray, width: np.ndarray, height: np.ndarray, eye_height: np.ndarray
    ) -> dict[str, np.ndarray]:
        """Return in water, in lava, eye flags, depth, summed flow and wet cell counts."""
        seats = pos.shape[1]
        shape = pos.shape[:2]
        flags = np.zeros(shape, dtype=np.uint8)
        depth = np.zeros((*shape, 2))
        flow = np.zeros((*shape, 6))
        count = np.zeros((*shape, 2), dtype=np.int32)
        self._lib.fluid_box_many(
            self.handles, self.n, seats, _ptr(pos, ct.c_double),
            _ptr(np.ascontiguousarray(width, dtype=np.float64), ct.c_double),
            _ptr(np.ascontiguousarray(height, dtype=np.float64), ct.c_double),
            _ptr(np.ascontiguousarray(eye_height, dtype=np.float64), ct.c_double),
            _ptr(flags, ct.c_uint8), _ptr(depth, ct.c_double), _ptr(flow, ct.c_double),
            _ptr(count, ct.c_int32),
        )
        return {
            "in_water": (flags & 1) > 0,
            "in_lava": (flags & 2) > 0,
            "eye_in_water": (flags & 4) > 0,
            "eye_in_lava": (flags & 8) > 0,
            "depth": depth,
            "flow": flow,
            "count": count,
        }

    def contact_many(self, pos: np.ndarray, width: np.ndarray, height: np.ndarray) -> dict[str, np.ndarray]:
        """Return which boxes touch cobweb or fire, and which feet are on a ladder."""
        flags = np.zeros(pos.shape[:2], dtype=np.uint8)
        self._lib.contact_many(
            self.handles, self.n, pos.shape[1], _ptr(pos, ct.c_double),
            _ptr(np.ascontiguousarray(width, dtype=np.float64), ct.c_double),
            _ptr(np.ascontiguousarray(height, dtype=np.float64), ct.c_double),
            _ptr(flags, ct.c_uint8),
        )
        return {"cobweb": (flags & 1) > 0, "fire": (flags & 2) > 0, "ladder": (flags & 4) > 0}

    def ray_block_many(
        self, eye: np.ndarray, direction: np.ndarray, reach: float = 4.5
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Return hit flags, hit cells, faces and distances for rays of shape (n, seats, 3)."""
        shape = eye.shape[:2]
        hit = np.zeros(shape, dtype=np.uint8)
        cell = np.zeros((*shape, 3), dtype=np.int32)
        face = np.zeros(shape, dtype=np.int8)
        dist = np.zeros(shape)
        self._lib.ray_block_many(
            self.handles, self.n, eye.shape[1], _ptr(eye, ct.c_double), _ptr(direction, ct.c_double),
            reach, _ptr(hit, ct.c_uint8), _ptr(cell, ct.c_int32), _ptr(face, ct.c_int8),
            _ptr(dist, ct.c_double),
        )
        return hit.astype(bool), cell, face, dist

    def ray_collide_many(
        self, start: np.ndarray, direction: np.ndarray, reach: float
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Return the first collision box on each ray, as hit flags, cells, faces and distances."""
        shape = start.shape[:2]
        hit = np.zeros(shape, dtype=np.uint8)
        cell = np.zeros((*shape, 3), dtype=np.int32)
        face = np.zeros(shape, dtype=np.int8)
        dist = np.zeros(shape)
        self._lib.ray_collide_many(
            self.handles, self.n, start.shape[1], _ptr(start, ct.c_double), _ptr(direction, ct.c_double),
            reach, _ptr(hit, ct.c_uint8), _ptr(cell, ct.c_int32), _ptr(face, ct.c_int8),
            _ptr(dist, ct.c_double),
        )
        return hit.astype(bool), cell, face, dist

    def place(self, block: int, eye, look, yaw: float, bodies=None, seat: int = 0, arena: int = 0):
        """Place a block from a look ray. Return (code, cell). Code 1 means placed."""
        boxes = np.zeros((0, 6)) if bodies is None else np.asarray(bodies, dtype=np.float64).reshape(-1, 6)
        boxes = np.ascontiguousarray(boxes)
        out = (ct.c_int32 * 3)()
        code = self._lib.w_place(
            self._h(arena), seat, block, _vec(eye), _vec(look), yaw, _ptr(boxes, ct.c_double), len(boxes), out,
        )
        return code, (out[0], out[1], out[2])

    def dig(
        self,
        eye,
        look,
        tool: int = 0,
        tier: int = 0,
        on_ground: bool = True,
        efficiency: int = 0,
        haste: int = 0,
        fatigue: int = 0,
        aqua: bool = False,
        unbreaking: int = 0,
        seat: int = 0,
        arena: int = 0,
        fortune: int = 0,
        silk: bool = False,
    ) -> tuple[int, tuple[int, ...]]:
        """Dig for one tick. Return (code, (x, y, z, block, harvest, durability cost, experience))."""
        out = (ct.c_int32 * 7)()
        code = self._lib.w_dig(
            self._h(arena), seat, tool, tier, efficiency, haste, fatigue, int(aqua), unbreaking,
            fortune, int(silk), int(on_ground), _vec(eye), _vec(look), out,
        )
        return code, tuple(out)

    def dig_stop(self, seat: int = 0, arena: int = 0) -> None:
        self._lib.w_dig_stop(self._h(arena), seat)

    def bucket_fill(self, eye, look, seat: int = 0, arena: int = 0) -> tuple[int, tuple[int, int, int]]:
        """Scoop the first source on the look ray. Return (fluid id or 0, cell)."""
        out = (ct.c_int32 * 3)()
        kind = self._lib.w_bucket_fill(self._h(arena), seat, _vec(eye), _vec(look), out)
        return kind, (out[0], out[1], out[2])

    def bucket_empty(self, kind: int, eye, look, seat: int = 0, arena: int = 0) -> tuple[int, tuple[int, int, int]]:
        """Pour a fluid at the look target. Return (code, cell). Code 1 means poured."""
        out = (ct.c_int32 * 3)()
        code = self._lib.w_bucket_empty(self._h(arena), seat, kind, _vec(eye), _vec(look), out)
        return code, (out[0], out[1], out[2])

    def items(self, arena: int = 0) -> np.ndarray:
        """Return items as rows of x, y, z, item, count, delay, age, ground, vy."""
        n = self._lib.w_item_count(self._h(arena))
        out = np.zeros((n, 9))
        if n:
            self._lib.w_items(self._h(arena), _ptr(out, ct.c_double))
        return out

    def spawn_item(self, x, y, z, item: int, count: int = 1, delay: int = 10, v=(0.0, 0.0, 0.0), arena: int = 0) -> None:
        self._lib.w_spawn_item(self._h(arena), x, y, z, item, count, delay, v[0], v[1], v[2])

    def falling_count(self, arena: int = 0) -> int:
        return int(self._lib.w_falling_count(self._h(arena)))

    def spawn_falling(self, x, y, z, cell: int, vy: float = 0.0, age: int = 0, arena: int = 0) -> None:
        """Add a falling block entity."""
        self._lib.w_spawn_falling(self._h(arena), x, y, z, cell, vy, age)

    def falling_vy(self, index: int = 0, arena: int = 0) -> float:
        return float(self._lib.w_falling_vy(self._h(arena), index))

    def experience(self, seat: int = 0, arena: int = 0) -> int:
        """Return the experience a body has earned from mining this round."""
        return int(self._lib.w_xp(self._h(arena), seat))

    def pickup(
        self, pos, width: float = 0.6, height: float = 1.8, arena: int = 0, room: np.ndarray | None = None
    ) -> list[tuple[int, int]]:
        """Collect items in reach of a body and return (item, count) pairs.

        Room is an int32 array of 256 free counts by item id. What does not fit stays on the ground.
        """
        ids = (ct.c_int32 * 128)()
        counts = (ct.c_int32 * 128)()
        free = None if room is None else _ptr(room, ct.c_int32)
        n = self._lib.w_pickup(self._h(arena), _vec(pos), width, height, free, ids, counts, 128)
        return [(ids[i], counts[i]) for i in range(n)]

    def pickup_ready(self, pos: np.ndarray, width: np.ndarray, height: np.ndarray) -> np.ndarray:
        """Return which bodies of shape (n, seats) have an item ready to collect."""
        out = np.zeros(pos.shape[:2], dtype=np.uint8)
        self._lib.pickup_ready_many(
            self.handles, self.n, pos.shape[1], _ptr(pos, ct.c_double),
            _ptr(np.ascontiguousarray(width, dtype=np.float64), ct.c_double),
            _ptr(np.ascontiguousarray(height, dtype=np.float64), ct.c_double),
            _ptr(out, ct.c_uint8),
        )
        return out.astype(bool)

    def see(self, seat: int, eye, yaw: float, pitch: float, sight_range: int = 8, arena: int = 0) -> int:
        """Update one body's seen block memory and return the number of cells read."""
        return int(self._lib.w_see(self._h(arena), seat, eye[0], eye[1], eye[2], yaw, pitch, sight_range))

    def bench(
        self, decisions: int, sight_range: int, spot, edit_every: int = 0, bucket_every: int = 0, sight: bool = True,
        arena: int = 0, parts: np.ndarray | None = None,
    ) -> float:
        """Return the world cost in microseconds per decision at a spot.

        A six element parts array receives the time of collision, fluid and contact calls,
        world ticks, sight, crop and edits.
        """
        return float(self._lib.w_bench(
            self._h(arena), decisions, sight_range, spot[0], spot[1], spot[2], edit_every, bucket_every, int(sight),
            None if parts is None else _ptr(parts, ct.c_double),
        ))


if __name__ == "__main__":
    print(build_library())
