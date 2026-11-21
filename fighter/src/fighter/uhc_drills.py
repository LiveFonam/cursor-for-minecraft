"""One drill per UHC skill, each with a scripted solution and a held-out pass test."""

from __future__ import annotations

import numpy as np

from . import actions as A
from . import constants as C
from . import items as I
from .env import RewardConfig
from .evaluate import HELD_OUT_SEED
from .obs import view_angles, wrap_degrees
from .opponents import OpponentPool
from .sim import SimConfig
from .uhc import ITEM_HEAD, UhcKitRules, UhcRewardConfig, UhcVecEnv
from .world import blocks as B
from .world.kernel import BaseWorld

FLOOR_Y = 64
WORLD_SIZE = 64
WORLD_BAND = (48, 128)
PASS_RATE = 0.90
IDLE_LIMIT = 0.10
WIN_BONUS = 2.0
SETTLED_DEGREES = 2.0
STEP_COST = 0.002
HOOK_WAIT_COST = 0.03


def flat_base(size: int = WORLD_SIZE) -> BaseWorld:
    """Return a stone world with its top layer at the drill floor."""
    raw = np.zeros((size, size, B.WORLD_HEIGHT), dtype=np.uint16)
    raw[:, :, : FLOOR_Y - B.Y_MIN + 1] = B.STONE
    return BaseWorld.from_array(raw, WORLD_BAND)


def _flight(
    pitch: float, speed: float, gravity: float, drag: float, height: float, drag_first: bool, ticks: int = 120
):
    """Return the horizontal and vertical path of a thrown object.

    Gravity always comes first. Pearls then take drag before they move, and hooks after.
    """
    p = np.radians(pitch)
    x, y = 0.0, height
    vx, vy = speed * np.cos(p), -speed * np.sin(p)
    path = []
    for _ in range(ticks):
        vy -= gravity
        if drag_first:
            vx *= drag
            vy *= drag
        x += vx
        y += vy
        path.append((x, y))
        if not drag_first:
            vx *= drag
            vy *= drag
    return np.array(path)


def throw_pitch(distance: float, rise: float, speed: float, gravity: float, drag: float, drag_first: bool) -> float:
    """Return the flattest pitch whose path passes closest to a point."""
    best, best_miss = 0.0, np.inf
    for pitch in np.arange(10.0, -45.5, -0.5):
        path = _flight(float(pitch), speed, gravity, drag, 0.0, drag_first)
        past = np.flatnonzero(path[:, 0] >= distance)
        if len(past) == 0:
            continue
        miss = abs(float(path[past[0], 1]) - rise)
        if miss < best_miss - 1e-6:
            best, best_miss = float(pitch), miss
    return best


class UhcDrill(UhcVecEnv):
    """A short scenario that ends when the skill is shown."""

    needs: tuple[int, ...] = ()
    limit = 100
    locked_heads: tuple[tuple[int, int], ...] = ()
    pain = UhcRewardConfig.environment_damage
    press = 0.0

    def __init__(self, n_envs: int, seed: int = 0, base: BaseWorld | None = None):
        pool = OpponentPool(n_envs, seed=seed + 1, max_ticks=self.limit)
        pool.set_mix({"idle": 1.0})
        rules = UhcKitRules(forced=self.needs, gear_drop=0.0, armor_drop=0.0, full_rate=0.0)
        config = SimConfig.uhc()
        self._won = np.zeros(n_envs, dtype=bool)
        self.goal = np.zeros((n_envs, 3))
        self.start_y = np.zeros(n_envs)
        self.drill_rng = np.random.default_rng(seed + 5)
        self.last_use = np.zeros(n_envs, dtype=bool)
        super().__init__(
            n_envs, pool, base if base is not None else flat_base(), rules, config,
            reward=RewardConfig(shaping=0.0), uhc_reward=UhcRewardConfig(item_press=self.press, environment_damage=self.pain),
            max_ticks=self.limit, seed=seed, opponent_eats=False,
        )

    def _put(self, env: int, seat: int, x: float, y: float, z: float, ground: bool = True) -> None:
        sim = self.sim
        rest = -C.GRAVITY * C.VERTICAL_DRAG if ground else 0.0
        sim.pos[env, seat] = (x, y, z)
        sim.vel[env, seat] = (0.0, rest, 0.0)
        sim.on_ground[env, seat] = ground
        sim.body.last_move[env, seat] = 0.0
        sim.combat.server_vel[env, seat] = (0.0, -C.GRAVITY * C.VERTICAL_DRAG, 0.0)
        sim.combat.server_ground[env, seat] = ground
        sim.combat.fall_distance[env, seat] = 0.0
        sim.combat._last_xz[env, seat] = (x, z)

    def _place_bodies(self, idx: np.ndarray) -> None:
        center = WORLD_SIZE // 2
        top = FLOOR_Y + 1.0
        for env in idx.tolist():
            x = center + int(self.drill_rng.integers(-3, 4)) + 0.5
            z = center + int(self.drill_rng.integers(-3, 4)) + 0.5
            angle = float(self.drill_rng.uniform(0.0, 2.0 * np.pi))
            self._put(env, 0, x, top, z)
            self._put(env, 1, x + 12.0 * np.cos(angle), top, z + 12.0 * np.sin(angle))
            self.sim.yaw[env, 0] = float(self.drill_rng.uniform(-180.0, 180.0))
            self.sim.pitch[env, 0] = 0.0
            self.start_y[env] = top

    def setup(self, idx: np.ndarray) -> None:
        """Build the scenario of the selected arenas."""

    def progress(self) -> np.ndarray:
        """Return a potential that rises as the skill gets closer to done."""
        return np.zeros(self.num_envs)

    def _potential(self) -> np.ndarray:
        return self.progress()

    def action_masks(self) -> np.ndarray:
        mask = super().action_masks()
        for head, keep in self.locked_heads:
            start = A.HEAD_OFFSETS[head]
            mask[:, start : start + A.NVEC[head]] = False
            mask[:, start + keep] = True
        return mask

    def _reward(self, ev, actions):
        return super()._reward(ev, actions) - STEP_COST

    def _facing(self, target: np.ndarray) -> np.ndarray:
        """Return the cosine of the yaw error toward a point."""
        yaw, _ = view_angles(target - self.sim.pos[:, 0])
        return np.cos(np.radians(wrap_degrees(yaw - self.sim.yaw[:, 0])))

    def success(self) -> np.ndarray:
        raise NotImplementedError

    def expert(self) -> np.ndarray:
        raise NotImplementedError

    def _on_reset(self, mask: np.ndarray) -> None:
        idx = np.flatnonzero(mask)
        super()._on_reset(mask)
        if len(idx) == 0:
            return
        self._won[idx] = False
        self.last_use[idx] = False
        self._place_bodies(idx)
        self.setup(idx)
        self.sim.update_sight()
        self._sync_reward_state(idx)

    def _terminal(self):
        self._won = self.success() & (self.sim.hp[:, 0] > 0.0)
        lost = self.sim.hp[:, 0] <= 0.0
        timeout = self.sim.ticks >= self.max_ticks
        ended = self._won | lost
        return ended, timeout & ~ended

    def _outcome_reward(self, ko, timeout):
        outcome = np.where(self._won, 1, np.where(ko, -1, 0))
        return WIN_BONUS * outcome.astype(float), outcome.astype(np.int64)

    def _plan(self) -> tuple[np.ndarray, np.ndarray]:
        sim = self.sim
        return A.neutral_actions(sim.weapon[:, 0].copy()), np.zeros(sim.n, dtype=np.int64)

    def _steer(self, base: np.ndarray, yaw: np.ndarray, pitch: np.ndarray) -> np.ndarray:
        sim = self.sim
        yaw_error = wrap_degrees(yaw - sim.yaw[:, 0])
        pitch_error = pitch - sim.pitch[:, 0]
        base[:, A.YAW], base[:, A.PITCH] = A.turn_indices(yaw_error, pitch_error)
        return (np.abs(yaw_error) < SETTLED_DEGREES) & (np.abs(pitch_error) < SETTLED_DEGREES)

    def _join(self, base: np.ndarray, codes: np.ndarray) -> np.ndarray:
        self.last_use = base[:, A.USE] == 1
        return np.concatenate([base, codes[:, None]], axis=1)

    def idle(self) -> np.ndarray:
        """Return actions that do nothing."""
        base, codes = self._plan()
        return np.concatenate([base, codes[:, None]], axis=1)


STAND_STILL = (
    (A.FORWARD, A.NEUTRAL_FORWARD),
    (A.STRAFE, A.NEUTRAL_STRAFE),
    (A.SPRINT, 0),
    (A.JUMP, 0),
)


class EatWhenLow(UhcDrill):
    """Eat a golden apple at low health."""

    needs = (I.GOLDEN_APPLE,)
    limit = 80

    def setup(self, idx):
        self.sim.hp[idx, 0] = self.drill_rng.uniform(3.0, 8.0, len(idx))

    def progress(self):
        sim = self.sim
        return sim.items.use_ticks[:, 0] / I.USE_DURATION + (sim.combat.absorption[:, 0] > 0.0)

    def success(self):
        return self.sim.combat.absorption[:, 0] > 0.0

    def expert(self):
        base, codes = self._plan()
        codes[:] = I.GOLDEN_APPLE
        base[:, A.USE] = 1
        return self._join(base, codes)


class FireOut(UhcDrill):
    """Put out fire with a water bucket."""

    needs = (I.WATER_BUCKET,)
    limit = 60

    def setup(self, idx):
        self.sim.combat.fire[idx, 0] = 200
        self.sim.combat._burning = True

    def success(self):
        return (self.sim.combat.fire[:, 0] <= 0) & (self.sim.ticks > 0)

    def expert(self):
        base, codes = self._plan()
        ready = self._steer(base, self.sim.yaw[:, 0], np.full(self.num_envs, 90.0))
        codes[:] = I.WATER_BUCKET
        base[:, A.USE] = ready & ~self.last_use
        return self._join(base, codes)


class WaterClutch(UhcDrill):
    """Land in water placed just before hitting the ground."""

    needs = (I.WATER_BUCKET,)
    limit = 80

    def setup(self, idx):
        sim = self.sim
        top = FLOOR_Y + 1.0
        for env in idx.tolist():
            drop = float(self.drill_rng.uniform(8.0, 16.0))
            x, z = sim.pos[env, 0, 0], sim.pos[env, 0, 2]
            self._put(env, 0, x, top + drop, z, ground=False)
            sim.pitch[env, 0] = float(self.drill_rng.uniform(40.0, 80.0))

    def success(self):
        sim = self.sim
        down = sim.on_ground[:, 0] | sim.combat.in_water[:, 0]
        return down & (sim.combat.environment_damage[:, 0] == 0.0) & (sim.ticks > 0)

    def expert(self):
        sim = self.sim
        base, codes = self._plan()
        ready = self._steer(base, sim.yaw[:, 0], np.full(self.num_envs, 90.0))
        codes[:] = I.WATER_BUCKET
        eye_height = sim.pos[:, 0, 1] + C.EYE_HEIGHT - (FLOOR_Y + 1.0)
        base[:, A.USE] = ready & (eye_height <= 4.4) & ~self.last_use
        return self._join(base, codes)


class LavaEscape(UhcDrill):
    """Climb out of a lava pit."""

    limit = 140

    def setup(self, idx):
        sim = self.sim
        for env in idx.tolist():
            cx, cz = int(np.floor(sim.pos[env, 0, 0])), int(np.floor(sim.pos[env, 0, 2]))
            for x in range(cx - 1, cx + 2):
                for z in range(cz - 1, cz + 2):
                    sim.world.poke(x, FLOOR_Y, z, B.LAVA_SOURCE, env)
            self._put(env, 0, cx + 0.5, float(FLOOR_Y), cz + 0.5)
            self.goal[env] = (cx + 0.5, FLOOR_Y + 1.0, cz + 2.5)
            self.start_y[env] = float(FLOOR_Y)

    def success(self):
        sim = self.sim
        out = sim.on_ground[:, 0] & ~sim.combat.in_lava[:, 0]
        return out & (sim.pos[:, 0, 1] >= FLOOR_Y + 1.0 - 1e-6) & (sim.ticks > 0)

    def expert(self):
        sim = self.sim
        base, codes = self._plan()
        delta = self.goal - sim.pos[:, 0]
        yaw, _ = view_angles(delta)
        self._steer(base, yaw, np.zeros(self.num_envs))
        wet = sim.combat.in_lava[:, 0]
        base[:, A.FORWARD] = np.where(
            wet | (np.hypot(delta[:, 0], delta[:, 2]) > 0.5), A.KEY_FORWARD, A.NEUTRAL_FORWARD
        )
        base[:, A.JUMP] = wet
        return self._join(base, codes)


class WebEscape(UhcDrill):
    """Get out of a cobweb."""

    limit = 100

    def setup(self, idx):
        sim = self.sim
        for env in idx.tolist():
            x, z = int(np.floor(sim.pos[env, 0, 0])), int(np.floor(sim.pos[env, 0, 2]))
            sim.world.poke(x, FLOOR_Y + 1, z, B.COBWEB, env)
            sim.world.poke(x, FLOOR_Y + 2, z, B.COBWEB, env)
            self.goal[env] = (x + 0.5, FLOOR_Y + 1.0, z + 0.5)

    def progress(self):
        gap = self.sim.pos[:, 0] - self.goal
        return np.minimum(np.hypot(gap[:, 0], gap[:, 2]), 1.0)

    def success(self):
        return ~self.sim.combat.in_web[:, 0] & (self.sim.ticks > 1)

    def expert(self):
        base, codes = self._plan()
        base[:, A.FORWARD] = A.KEY_FORWARD
        return self._join(base, codes)


class PearlCross(UhcDrill):
    """Reach the other player, too far away to sprint to in time, with a pearl."""

    needs = (I.PEARL,)
    limit = 50
    reach = 3.5
    locked_heads = STAND_STILL
    pain = 0.0

    def setup(self, idx):
        sim = self.sim
        sim.items.count[idx, 0, I.PEARL] = 1
        for env in idx.tolist():
            distance = float(self.drill_rng.uniform(24.0, 27.0))
            angle = float(self.drill_rng.uniform(0.0, 2.0 * np.pi))
            self.goal[env] = sim.pos[env, 0] + (distance * np.cos(angle), 0.0, distance * np.sin(angle))
            self._put(env, 1, *self.goal[env])

    def progress(self):
        gap = self.sim.pos[:, 0] - self.goal
        return 0.2 * self._facing(self.goal) - np.hypot(gap[:, 0], gap[:, 2]) / 30.0

    def success(self):
        sim = self.sim
        gap = sim.pos[:, 0] - self.goal
        return (np.hypot(gap[:, 0], gap[:, 2]) <= self.reach) & sim.on_ground[:, 0]

    def expert(self):
        sim = self.sim
        base, codes = self._plan()
        delta = self.goal - sim.pos[:, 0]
        yaw, _ = view_angles(delta)
        flat = np.hypot(delta[:, 0], delta[:, 2])
        pitch = np.array(
            [
                throw_pitch(float(d), -(C.EYE_HEIGHT - I.THROW_DROP), I.PEARL_SPEED, I.PEARL_GRAVITY, I.PEARL_DRAG, True)
                for d in flat
            ]
        )
        ready = self._steer(base, yaw, pitch)
        holds = sim.items.count[:, 0, I.PEARL] > 0
        waiting = ~sim.items.pearl_on[:, 0] & holds & (sim.items.pearl_cooldown[:, 0] == 0)
        codes[waiting] = I.PEARL
        base[:, A.USE] = ready & waiting & ~self.last_use
        return self._join(base, codes)


class RodPull(UhcDrill):
    """Hook the other player with a rod and reel them in."""

    needs = (I.ROD,)
    limit = 100
    locked_heads = STAND_STILL
    press = UhcRewardConfig.item_press

    def __init__(self, n_envs: int, seed: int = 0, base: BaseWorld | None = None):
        self._was_hooked = np.zeros(n_envs, dtype=bool)
        super().__init__(n_envs, seed, base)

    def setup(self, idx):
        sim = self.sim
        self._was_hooked[idx] = False
        for env in idx.tolist():
            distance = float(self.drill_rng.uniform(5.0, 9.0))
            angle = float(self.drill_rng.uniform(0.0, 2.0 * np.pi))
            x, y, z = sim.pos[env, 0]
            self._put(env, 1, x + distance * np.cos(angle), y, z + distance * np.sin(angle))

    def progress(self):
        sim = self.sim
        items = sim.items
        hooked = items.hook_on[:, 0] & (items.hook_state[:, 0] == I.HOOK_ON_PLAYER)
        released = items.input[:, 0] == I.NO_ITEM
        chest = sim.pos[:, 1] + np.array([0.0, C.PLAYER_HEIGHT / 2.0, 0.0])
        eye = sim.pos[:, 0] + np.array([0.0, C.EYE_HEIGHT, 0.0])
        _, want_pitch = view_angles(chest - eye)
        level = np.cos(np.radians(want_pitch - sim.pitch[:, 0]))
        return 0.3 * self._facing(sim.pos[:, 1]) + 0.3 * level + 0.5 * hooked + 0.2 * (hooked & released)

    def _before_step(self):
        items = self.sim.items
        self._was_hooked = items.hook_on[:, 0] & (items.hook_state[:, 0] == I.HOOK_ON_PLAYER)

    def _reward(self, ev, actions):
        """Charge every decision the hook sits on the other player without a reel."""
        items = self.sim.items
        waiting = items.hook_on[:, 0] & (items.hook_state[:, 0] == I.HOOK_ON_PLAYER)
        return super()._reward(ev, actions) - HOOK_WAIT_COST * waiting

    def success(self):
        return self._was_hooked & ~self.sim.items.hook_on[:, 0] & (self.hands.held[:, 0] == I.ROD)

    def aim(self, base: np.ndarray) -> np.ndarray:
        """Turn toward the cast that lands on the other player and return where it is set."""
        sim = self.sim
        delta = sim.pos[:, 1] - sim.pos[:, 0]
        yaw, _ = view_angles(delta)
        flat = np.hypot(delta[:, 0], delta[:, 2])
        rise = C.PLAYER_HEIGHT / 2.0 - C.EYE_HEIGHT
        pitch = np.array(
            [
                throw_pitch(
                    max(float(d) - I.ROD_START, 0.5),
                    rise,
                    I.ROD_BASE_SPEED + I.ROD_EXTRA_SPEED,
                    I.ROD_GRAVITY,
                    I.ROD_DRAG,
                    False,
                )
                for d in flat
            ]
        )
        return self._steer(base, yaw, pitch)

    def expert(self):
        sim = self.sim
        items = sim.items
        base, codes = self._plan()
        codes[:] = I.ROD
        aimed = self.aim(base)
        out = items.hook_on[:, 0]
        landed = out & (items.hook_state[:, 0] != I.HOOK_FLYING)
        base[:, A.USE] = ((~out & aimed) | landed) & ~self.last_use
        return self._join(base, codes)


class BlockPillar(UhcDrill):
    """Jump and place blocks underfoot to stand two blocks higher."""

    needs = (I.BLOCK,)
    limit = 120
    climb = 2.0

    def progress(self):
        sim = self.sim
        return (sim.pos[:, 0, 1] - self.start_y) / self.climb + 0.2 * sim.pitch[:, 0] / 90.0

    def success(self):
        sim = self.sim
        return sim.on_ground[:, 0] & (sim.pos[:, 0, 1] >= self.start_y + self.climb - 1e-6)

    def expert(self):
        sim = self.sim
        base, codes = self._plan()
        ready = self._steer(base, sim.yaw[:, 0], np.full(self.num_envs, 90.0))
        codes[:] = I.BLOCK
        ground = np.floor(sim.pos[:, 0, 1] + 1e-6)
        above = sim.pos[:, 0, 1] - ground
        base[:, A.JUMP] = ready & sim.on_ground[:, 0]
        base[:, A.USE] = ready & ~sim.on_ground[:, 0] & (above >= 0.0) & (sim.vel[:, 0, 1] < 0.25) & ~self.last_use
        return self._join(base, codes)


DRILLS: dict[str, type[UhcDrill]] = {
    "eat_when_low": EatWhenLow,
    "fire_out": FireOut,
    "water_clutch": WaterClutch,
    "lava_escape": LavaEscape,
    "web_escape": WebEscape,
    "pearl_cross": PearlCross,
    "rod_pull": RodPull,
    "block_pillar": BlockPillar,
}


def run_drill(drill: UhcDrill, act, rounds: int = 128) -> float:
    """Return the success rate of an action function over finished rounds."""
    drill.reset()
    results: list[int] = []
    guard = (rounds // drill.num_envs + 2) * drill.limit
    for _ in range(guard):
        _obs, _reward, _done, infos = drill.step(act(drill))
        results += [info["outcome"] for info in infos if "outcome" in info]
        if len(results) >= rounds:
            break
    return float(np.mean(np.array(results[:rounds]) > 0)) if results else 0.0


def held_out_rate(name: str, act_name: str = "expert", rounds: int = 128, n_envs: int = 16) -> float:
    """Run a drill on held-out seeds with its expert or idle actions."""
    drill = DRILLS[name](n_envs, seed=HELD_OUT_SEED)
    try:
        return run_drill(drill, lambda env: getattr(env, act_name)(), rounds)
    finally:
        drill.close()


__all__ = ["DRILLS", "ITEM_HEAD", "IDLE_LIMIT", "PASS_RATE", "UhcDrill", "flat_base", "held_out_rate", "run_drill"]
