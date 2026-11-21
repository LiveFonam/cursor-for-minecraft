"""Shared builders and a reference body for the world tests."""

from __future__ import annotations

import math

import numpy as np

from fighter import constants as C
from fighter.world import blocks as B
from fighter.world.config import FULL
from fighter.world.kernel import Arenas, BaseWorld

FLOOR = 64


def yi(y: int) -> int:
    """Return the array index of a real Y."""
    return y - B.Y_MIN


def empty_raw(size: int = 32) -> np.ndarray:
    return np.zeros((size, size, B.WORLD_HEIGHT), dtype=np.uint16)


def flat_raw(size: int = 32, floor: int = FLOOR, block: int = B.STONE) -> np.ndarray:
    """Return a world that is solid up to and including the floor layer."""
    raw = empty_raw(size)
    raw[:, :, : yi(floor) + 1] = block
    return raw


def make(raw: np.ndarray | None = None, n: int = 1, config=FULL, **kw) -> Arenas:
    """Return arenas over a world built from cells."""
    base = BaseWorld.from_array(flat_raw() if raw is None else raw)
    return Arenas(base, n, config=config, **kw)


def look_vector(yaw: float, pitch: float) -> np.ndarray:
    y, p = math.radians(yaw), math.radians(pitch)
    return np.array([-math.sin(y) * math.cos(p), -math.sin(p), math.cos(y) * math.cos(p)])


def aim(eye, target) -> np.ndarray:
    """Return the unit vector from an eye to a point."""
    d = np.asarray(target, dtype=float) - np.asarray(eye, dtype=float)
    return d / np.linalg.norm(d)


class Body:
    """One body following the movement rules, over the world calls."""

    WIDTH = C.PLAYER_WIDTH
    HEIGHT = C.PLAYER_HEIGHT
    EYE = C.EYE_HEIGHT

    def __init__(self, world: Arenas, x: float, y: float, z: float, yaw: float = 0.0, pitch: float = 0.0,
                 ground: bool = True):
        self.world = world
        self.pos = np.array([[[x, y, z]]], dtype=float)
        self.vel = np.zeros((1, 1, 3))
        if ground:
            self.vel[0, 0, 1] = -C.GRAVITY * C.VERTICAL_DRAG
        self.yaw = yaw
        self.pitch = pitch
        self.ground = ground
        self.fall = 0.0
        self.damage = 0.0
        self.w = np.array([[self.WIDTH]])
        self.h = np.array([[self.HEIGHT]])
        self.e = np.array([[self.EYE]])

    @property
    def p(self) -> np.ndarray:
        return self.pos[0, 0]

    @property
    def v(self) -> np.ndarray:
        return self.vel[0, 0]

    @property
    def eye(self) -> np.ndarray:
        return self.p + np.array([0.0, self.EYE, 0.0])

    @property
    def look(self) -> np.ndarray:
        return look_vector(self.yaw, self.pitch)

    @property
    def box(self) -> list[float]:
        half = self.WIDTH / 2
        x, y, z = self.p
        return [x - half, y, z - half, x + half, y + self.HEIGHT, z + half]

    def tick(self, forward: float = 0.0, strafe: float = 0.0, sprint: bool = False, jump: bool = False,
             step: float = 0.6) -> None:
        fluid = self.world.fluid_box_many(self.pos, self.w, self.h, self.e)
        in_water = bool(fluid["in_water"][0, 0])
        in_lava = bool(fluid["in_lava"][0, 0])
        grounded = self.ground
        if in_water or in_lava:
            accel = 0.02
        elif grounded:
            accel = C.MOVEMENT_SPEED * (C.SPRINT_MULTIPLIER if sprint else 1.0)
        else:
            accel = C.AIR_ACCEL_SPRINT if sprint else C.AIR_ACCEL
        f, s = forward * C.INPUT_SCALE, strafe * C.INPUT_SCALE
        length = math.hypot(f, s)
        scale = 1.0 / length if length > 1.0 else 1.0
        f, s = f * scale * accel, s * scale * accel
        ry = math.radians(self.yaw)
        sin_y, cos_y = math.sin(ry), math.cos(ry)
        v = self.vel[0, 0]
        v[0] += -sin_y * f - cos_y * s
        v[2] += cos_y * f - sin_y * s
        if in_water or in_lava:
            if jump:
                v[1] += 0.04
        elif jump and grounded:
            v[1] = C.JUMP_VELOCITY
            if sprint:
                v[0] -= sin_y * C.SPRINT_JUMP_BOOST
                v[2] += cos_y * C.SPRINT_JUMP_BOOST
        if in_water and fluid["count"][0, 0, 0] > 0:
            push = fluid["flow"][0, 0, :3] / fluid["count"][0, 0, 0]
            norm = np.linalg.norm(push)
            if norm > 0:
                v[:3] += push / norm * 0.014
        before = self.pos.copy()
        out, contact, ground = self.world.collide_many(
            self.pos, self.vel, self.w, self.h, np.array([[grounded]], dtype=np.uint8), step,
        )
        moved_y = out[0, 0, 1] - before[0, 0, 1]
        self.pos = out
        bits = int(contact[0, 0])
        if bits & 1:
            v[0] = 0.0
        if bits & 2:
            v[1] = 0.0
        if bits & 4:
            v[2] = 0.0
        self.ground = bool(ground[0, 0])
        after = self.world.fluid_box_many(self.pos, self.w, self.h, self.e)
        wet = bool(after["in_water"][0, 0])
        if moved_y < 0:
            self.fall -= moved_y
        if wet:
            self.fall = 0.0
        elif self.ground:
            self.damage += max(math.floor(self.fall - 3.0), 0)
            self.fall = 0.0
        if in_water:
            drag = 0.9 if sprint else 0.8
            v[0] *= drag
            v[2] *= drag
            v[1] = v[1] * 0.8 - 0.005
        elif in_lava:
            v[0] *= 0.5
            v[2] *= 0.5
            v[1] = v[1] * 0.5 - 0.02
        else:
            v[1] = (v[1] - C.GRAVITY) * C.VERTICAL_DRAG
            drag = C.GROUND_DRAG if grounded else C.AIR_DRAG
            v[0] *= drag
            v[2] *= drag
