"""Rule based open source PvP bots, ported to play inside the simulator.

mineflayer_pvp follows PrismarineJS/mineflayer-pvp.
sweat_sword follows the Sweat tier of FatihBastan/mc-pvp-bots, MIT license.

These bots run on every game tick while the simulator decides every 2 ticks. So each decision
runs a bot's rules once per tick it covers, on the state at the start of the decision. A swing
that falls on a later tick goes out at the start of the next decision, at most 1 tick late.

The originals send exact look packets and attack packets that the server checks only for
distance. So a port writes its look straight onto the view, and a swing its rules say lands is
aimed at the nearest part of the target. A swing its rules say misses looks straight up for
that decision, so the enemy still sees the arm move.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from types import SimpleNamespace
from typing import NamedTuple

import numpy as np

from . import actions as A
from . import constants as C
from .combat import _ray_entry
from .farmwatch import fit_to_mask
from .obs import build_masks, view_angles, wrap_degrees
from .sim import look_vectors

EYE = np.array([0.0, C.EYE_HEIGHT, 0.0])
HEAD = np.array([0.0, C.PLAYER_HEIGHT, 0.0])
HALF_WIDTH = C.PLAYER_WIDTH / 2.0
AIM_INSET = 0.01
NEVER_TICK = 1 << 60
BOT_REACH = 3.0
FOLLOW_RANGE_SQUARED = 4

# mineflayer_pvp timing, in ticks.
MINEFLAYER_SWORD_TICKS = 12
MINEFLAYER_JITTER_LOW = -2
MINEFLAYER_JITTER_SPAN = 4
MINEFLAYER_HIT_DELAY = 2
MINEFLAYER_GUARD_DELAY = 5

# sweat_sword timing and odds.
SWEAT_ENTER = 4.0
SWEAT_EXIT = 5.5
SWEAT_HEIGHT_GAP = 1.5
SWEAT_REACTION_TICKS = 1.8
SWEAT_TRAIL = 4
SWEAT_CHEST = np.array([0.0, 1.2, 0.0])
SWEAT_CLOSE_TO = 2.6
SWEAT_BACK_OFF = 1.1
SWEAT_LAG_REACH = 3.6
SWEAT_SWING_TICKS = 13
SWEAT_JUMP_LEAD = 6
SWEAT_CRIT_WINDOW = 12
SWEAT_FALL_SPEED = -0.08
SWEAT_STRAFE_CHANCE = 0.85
SWEAT_STRAFE_MIN_MS = 500.0
SWEAT_STRAFE_SPREAD_MS = 900.0
SWEAT_MS_PER_TICK = 50.0
SWEAT_CRIT_CHANCE = 0.75
SWEAT_TAP_CHANCE = 0.8
SWEAT_TAP_TICKS = 2
SWEAT_AIM_JITTER = 0.04
SWEAT_MAX_MISS = 0.9
SWEAT_IDLE, SWEAT_CHASE, SWEAT_MELEE = 0, 1, 2

Spec = dict[str, tuple[type, float, tuple[int, ...]]]

KEY_FIELDS: Spec = {
    name: (bool, False, ())
    for name in ("forward", "back", "left", "right", "sprint", "jump", "shield", "axe", "queued_hit", "queued_whiff")
}


class Memory:
    """What one bot kind remembers between decisions, per arena and seat."""

    def __init__(self, n: int, spec: Spec):
        self.spec = spec
        self.tick = np.full((n, 2), -1, dtype=np.int64)
        self.data = {
            name: np.full((n, 2, *shape), start, dtype=kind) for name, (kind, start, shape) in spec.items()
        }

    def begin(self, now: np.ndarray, picked: np.ndarray, seat: int) -> np.ndarray:
        """Clear rounds that restarted and return which of the picked arenas did."""
        last = self.tick[picked, seat]
        fresh = (now <= last) | (last < 0)
        if fresh.any():
            rows = picked[fresh]
            for name, (_, start, _) in self.spec.items():
                self.data[name][rows, seat] = start
        self.tick[picked, seat] = now
        return fresh

    def load(self, picked: np.ndarray, seat: int) -> SimpleNamespace:
        return SimpleNamespace(**{name: values[picked, seat].copy() for name, values in self.data.items()})

    def save(self, picked: np.ndarray, seat: int, state: SimpleNamespace) -> None:
        for name, values in self.data.items():
            values[picked, seat] = getattr(state, name)


class TickResult(NamedTuple):
    """What one game tick of a bot's rules asked for. A NaN look keeps the current view."""

    hit: np.ndarray
    whiff: np.ndarray
    jump: np.ndarray
    yaw: np.ndarray
    pitch: np.ndarray


@dataclass(frozen=True)
class Bot:
    name: str
    fields: Spec
    start: Callable
    tick: Callable


def _decision_ticks(sim) -> int:
    """Return how many game ticks the next decision covers, without advancing the phase."""
    rate = sim.cfg.decisions_per_second
    if rate == 10:
        return C.TICKS_PER_DECISION
    if rate == 20:
        return 1
    phase = sim._decision_phase
    return (phase + 1) * 4 // 3 - phase * 4 // 3


def _scene(sim, seat: int, picked: np.ndarray) -> SimpleNamespace:
    """Read what a bot's client knows at the start of a decision."""
    other = 1 - seat
    me = sim.pos[picked, seat].copy()
    target = np.array(sim.perception.known_position(seat, picked), dtype=float)
    count = len(picked)
    timer = sim.hurt_timer[picked, seat].copy()
    landed = sim.events["hits"][picked, other] > 0.0
    return SimpleNamespace(
        count=count,
        me=me,
        eye=sim.eyes()[picked, seat],
        top=me + HEAD,
        target=target,
        yaw=sim.yaw[picked, seat].copy(),
        pitch=sim.pitch[picked, seat].copy(),
        vel_y=sim.vel[picked, seat, 1].copy(),
        ground=sim.on_ground[picked, seat].copy(),
        hp=sim.hp[picked, seat].copy(),
        timer=timer,
        landed=landed,
        ticks=_decision_ticks(sim),
        target_yaw=sim.yaw[picked, other].copy(),
        since_swing=sim.perception.since_enemy_swing[picked, seat].copy(),
        enemy_guard=(sim.shield_ticks[picked, other] > 0) & (sim.weapon[picked, other] <= C.AXE),
        disabled=sim.shield_disabled[picked, seat].copy(),
        in_sight=np.broadcast_to(sim.perception.enemy(seat, picked).visible, (count,)).copy(),
        clock=sim.ticks[picked].copy(),
    )


def _box(target: np.ndarray, inset: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    low = target + np.array([-HALF_WIDTH + inset, inset, -HALF_WIDTH + inset])
    high = target + np.array([HALF_WIDTH - inset, C.PLAYER_HEIGHT - inset, HALF_WIDTH - inset])
    return low, high


def _box_distance(point: np.ndarray, target: np.ndarray) -> np.ndarray:
    low, high = _box(target)
    gap = np.maximum(np.maximum(low - point, point - high), 0.0)
    return np.sqrt((gap * gap).sum(axis=1))


def _ray(origin, yaw, pitch, target, reach=BOT_REACH):
    """Return the entry distance, whether the ray meets the target box in reach, and its direction."""
    direction = look_vectors(yaw, pitch)
    low, high = _box(target)
    entry, reached = _ray_entry(origin, direction, low, high, reach)
    return entry, reached, direction


def _js_round(values: np.ndarray) -> np.ndarray:
    return np.floor(values + 0.5)


def _blocks(values: np.ndarray) -> np.ndarray:
    return np.floor(values).astype(np.int64)


def _follow(state, me: np.ndarray, target: np.ndarray, active: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Follow a target to within 2 blocks, in block coordinates, and return who walks and where."""
    block = _blocks(target)
    moved = ((block - state.goal) ** 2).sum(axis=1) > FOLLOW_RANGE_SQUARED
    state.goal = np.where((active & moved)[:, None], block, state.goal)
    walking = active & (((_blocks(me) - state.goal) ** 2).sum(axis=1) > FOLLOW_RANGE_SQUARED)
    heading, _ = view_angles(state.goal + np.array([0.5, 0.0, 0.5]) - me)
    return walking, heading


def _emit(sim, seat, picked, rows, scene, state, hit, whiff, yaw, pitch, jump) -> np.ndarray:
    """Write the look onto the view and turn the held keys into one legal action per arena."""
    swing = hit | whiff
    if hit.any():
        low, high = _box(scene.target, AIM_INSET)
        aim_yaw, aim_pitch = view_angles(np.clip(scene.eye, low, high) - scene.eye)
        yaw = np.where(hit, aim_yaw, yaw)
        pitch = np.where(hit, aim_pitch, pitch)
    if whiff.any():
        pitch = np.where(whiff, -90.0, pitch)
    turned = ~np.isnan(yaw)
    sim.yaw[picked[turned], seat] = wrap_degrees(yaw[turned])
    tilted = ~np.isnan(pitch)
    sim.pitch[picked[tilted], seat] = np.clip(pitch[tilted], -90.0, 90.0)

    a = A.neutral_actions(np.where(state.axe, C.AXE, C.SWORD))
    a[:, A.FORWARD] = np.select([state.forward, state.back], [A.KEY_FORWARD, A.KEY_BACK], A.NEUTRAL_FORWARD)
    a[:, A.STRAFE] = np.select(
        [state.left & ~state.right, state.right & ~state.left], [A.KEY_LEFT, A.KEY_RIGHT], A.NEUTRAL_STRAFE
    )
    a[:, A.SPRINT] = state.sprint & state.forward
    a[:, A.JUMP] = jump | state.jump
    a[:, A.ATTACK] = np.where(swing, A.ATTACK_CLICK, 0)
    a[:, A.USE] = state.shield & ~swing
    return fit_to_mask(a, build_masks(sim, seat, rows=rows), A.NVEC)


def _play(sim, seat: int, rng: np.random.Generator, rows, bot: Bot) -> np.ndarray:
    """Run one decision of a bot for the arenas it owns."""
    picked = np.arange(sim.n) if rows is None else np.asarray(rows)
    if "open_bots" not in sim.__dict__:
        sim.open_bots = {}
    if bot.name not in sim.open_bots:
        sim.open_bots[bot.name] = Memory(sim.n, bot.fields)
    memory = sim.open_bots[bot.name]
    fresh = memory.begin(sim.ticks[picked], picked, seat)
    scene = _scene(sim, seat, picked)
    state = memory.load(picked, seat)
    bot.start(state, scene, fresh)

    hit, whiff = state.queued_hit.copy(), state.queued_whiff.copy()
    state.queued_hit[:] = False
    state.queued_whiff[:] = False
    jump = np.zeros(scene.count, dtype=bool)
    yaw = np.full(scene.count, np.nan)
    pitch = np.full(scene.count, np.nan)
    for tick in range(scene.ticks):
        out = bot.tick(state, scene, rng, tick == 0)
        jump |= out.jump
        yaw = np.where(np.isnan(out.yaw), yaw, out.yaw)
        pitch = np.where(np.isnan(out.pitch), pitch, out.pitch)
        if tick == 0:
            hit |= out.hit
            whiff |= out.whiff & ~hit
        else:
            state.queued_hit |= out.hit
            state.queued_whiff |= out.whiff
    actions = _emit(sim, seat, picked, rows, scene, state, hit, whiff, yaw, pitch, jump)
    memory.save(picked, seat, state)
    return actions


MINEFLAYER_FIELDS: Spec = {
    **KEY_FIELDS,
    "wait": (np.int64, 0, ()),
    "in_range": (bool, False, ()),
    "sequence": (np.int64, -1, ()),
    "goal": (np.int64, 0, (3,)),
}


def _mineflayer_start(state, scene, fresh) -> None:
    state.goal[fresh] = _blocks(scene.target[fresh])


def _mineflayer_gap(rng: np.random.Generator, count: int) -> np.ndarray:
    """Return the ticks to the next attack: the sword cooldown plus a whole number from -2 to 1."""
    jitter = np.floor(rng.random(count) * MINEFLAYER_JITTER_SPAN + MINEFLAYER_JITTER_LOW).astype(np.int64)
    return np.maximum(1, MINEFLAYER_SWORD_TICKS + jitter)


def _mineflayer_tick(s, w, rng, first) -> TickResult:
    """Attack in range on a timer, lowering the shield for the swing and raising it after."""
    count = w.count
    distance = np.linalg.norm(w.target - w.me, axis=1)
    checking = s.wait >= 0
    near = distance <= BOT_REACH
    s.wait = np.where(checking & near & ~s.in_range, 0, s.wait)
    s.in_range = np.where(checking, near, s.in_range)

    s.sequence = np.where(s.sequence >= 0, s.sequence + 1, s.sequence)
    hit = s.sequence == MINEFLAYER_HIT_DELAY
    done = s.sequence == MINEFLAYER_GUARD_DELAY
    s.shield = np.where(done, w.disabled <= 0, s.shield)
    s.wait = np.where(done, _mineflayer_gap(rng, count), s.wait)
    s.sequence = np.where(done, -1, s.sequence)

    s.wait = s.wait - 1
    attempt = s.wait == -1
    s.wait = np.where(attempt & ~s.in_range, _mineflayer_gap(rng, count), s.wait)
    begin = attempt & s.in_range
    s.sequence = np.where(begin, 0, s.sequence)
    s.shield = s.shield & ~begin

    walking, heading = _follow(s, w.me, w.target, np.ones(count, dtype=bool))
    s.forward = walking
    s.sprint = walking
    return TickResult(
        hit,
        np.zeros(count, dtype=bool),
        np.zeros(count, dtype=bool),
        np.where(walking, heading, np.nan),
        np.where(walking, 0.0, np.nan),
    )


SWEAT_FIELDS: Spec = {
    **KEY_FIELDS,
    "clock": (np.int64, 0, ()),
    "mode": (np.int64, SWEAT_IDLE, ()),
    "goal": (np.int64, 0, (3,)),
    "last_attack": (np.int64, -100, ()),
    "strafe": (np.int64, 0, ()),
    "strafe_until": (np.int64, 0, ()),
    "crit_until": (np.int64, -1, ()),
    "crit_planned": (bool, False, ()),
    "sprint_resume": (np.int64, 0, ()),
    "trail": (float, 0.0, (SWEAT_TRAIL, 3)),
    "trail_tick": (np.int64, NEVER_TICK, (SWEAT_TRAIL,)),
}


def _sweat_start(state, scene, fresh) -> None:
    """Remember where the target is and find where it was one reaction time ago."""
    state.goal[fresh] = _blocks(scene.target[fresh])
    state.trail[:, 1:] = state.trail[:, :-1].copy()
    state.trail_tick[:, 1:] = state.trail_tick[:, :-1].copy()
    state.trail[:, 0] = scene.target
    state.trail_tick[:, 0] = scene.clock
    wanted = scene.clock - SWEAT_REACTION_TICKS
    older = state.trail_tick <= wanted[:, None]
    rows = np.arange(scene.count)
    index = older.argmax(axis=1)
    base, base_tick = state.trail[rows, index], state.trail_tick[rows, index]
    newer = np.maximum(index - 1, 0)
    next_pos, next_tick = state.trail[rows, newer], state.trail_tick[rows, newer]
    part = np.clip((wanted - base_tick) / np.maximum(next_tick - base_tick, 1), 0.0, 1.0)
    between = base + (next_pos - base) * part[:, None]
    oldest = (state.trail_tick < NEVER_TICK).sum(axis=1) - 1
    scene.lagged = np.where(older.any(axis=1)[:, None], between, state.trail[rows, oldest])


def _sweat_tick(s, w, rng, first) -> TickResult:
    """Chase, then fight a beat late with strafes, jump crits, sprint resets and some whiffs."""
    count = w.count
    s.clock = s.clock + 1
    now = s.clock
    real = np.linalg.norm(w.target - w.me, axis=1)
    enter = (s.mode != SWEAT_MELEE) & (real <= SWEAT_ENTER) & (np.abs(w.target[:, 1] - w.me[:, 1]) < SWEAT_HEIGHT_GAP)
    leave = (s.mode == SWEAT_MELEE) & (real > SWEAT_EXIT)
    mode = np.where(enter, SWEAT_MELEE, np.where(leave, SWEAT_IDLE, s.mode))
    cleared = enter | leave
    for key in ("forward", "back", "sprint", "left", "right", "jump"):
        setattr(s, key, getattr(s, key) & ~cleared)
    chase = mode != SWEAT_MELEE
    s.goal = np.where((chase & (mode != SWEAT_CHASE))[:, None], _blocks(w.target), s.goal)
    s.mode = np.where(chase, SWEAT_CHASE, mode)

    walking, heading = _follow(s, w.me, w.target, chase)
    s.forward = np.where(chase, walking, s.forward)
    s.sprint = np.where(chase, walking, s.sprint)
    yaw = np.where(chase & walking, heading, np.nan)
    pitch = np.where(chase & walking, 0.0, np.nan)
    none = np.zeros(count, dtype=bool)
    fighting = ~chase
    if not fighting.any():
        return TickResult(none, none.copy(), none.copy(), yaw, pitch)

    lag_distance = np.linalg.norm(w.lagged - w.me, axis=1)
    drift = np.hypot(w.target[:, 0] - w.lagged[:, 0], w.target[:, 2] - w.lagged[:, 2])
    aim_yaw, aim_pitch = view_angles(w.lagged + SWEAT_CHEST - w.eye)
    yaw = np.where(fighting, aim_yaw, yaw)
    pitch = np.where(fighting, aim_pitch, pitch)
    s.forward = np.where(fighting, lag_distance > SWEAT_CLOSE_TO, s.forward)
    s.back = np.where(fighting, lag_distance < SWEAT_BACK_OFF, s.back)
    s.sprint = np.where(fighting & (now >= s.sprint_resume), lag_distance > SWEAT_CLOSE_TO, s.sprint)

    fresh_burst = fighting & (now >= s.strafe_until)
    direction = np.where(rng.random(count) < SWEAT_STRAFE_CHANCE, np.where(rng.random(count) < 0.5, 1, 2), 0)
    s.strafe = np.where(fresh_burst, direction, s.strafe)
    burst = np.round((SWEAT_STRAFE_MIN_MS + rng.random(count) * SWEAT_STRAFE_SPREAD_MS) / SWEAT_MS_PER_TICK)
    s.strafe_until = np.where(fresh_burst, now + burst.astype(np.int64), s.strafe_until)
    s.left = np.where(fighting, s.strafe == 1, s.left)
    s.right = np.where(fighting, s.strafe == 2, s.right)

    since = now - s.last_attack
    pending = s.crit_until
    jump_now = fighting & s.crit_planned & (pending < 0) & (since >= SWEAT_SWING_TICKS - SWEAT_JUMP_LEAD) & w.ground
    s.jump = s.jump | jump_now
    pending = np.where(jump_now, now + SWEAT_CRIT_WINDOW, pending)
    s.jump = s.jump & ~(fighting & ~jump_now & (pending >= 0) & ~w.ground)
    ready = fighting & (since >= SWEAT_SWING_TICKS)
    falling = ~w.ground & (w.vel_y < SWEAT_FALL_SPEED)
    ready = ready & ~((pending >= 0) & ~falling & (now < pending))
    release = ready & (pending >= 0)
    s.jump = s.jump & ~release
    s.crit_until = np.where(release, -1, pending)

    s.last_attack = np.where(ready, now, s.last_attack)
    s.crit_planned = np.where(ready, rng.random(count) < SWEAT_CRIT_CHANCE, s.crit_planned)
    miss = np.minimum(SWEAT_MAX_MISS, SWEAT_AIM_JITTER * (1.0 + drift))
    lands = ready & (real <= BOT_REACH) & (lag_distance <= SWEAT_LAG_REACH) & (rng.random(count) >= miss)
    tap = lands & (rng.random(count) < SWEAT_TAP_CHANCE)
    s.sprint = s.sprint & ~tap
    s.sprint_resume = np.where(tap, now + SWEAT_TAP_TICKS, s.sprint_resume)
    return TickResult(lands, ready & ~lands, none.copy(), yaw, pitch)


MINEFLAYER = Bot("mineflayer_pvp", MINEFLAYER_FIELDS, _mineflayer_start, _mineflayer_tick)
SWEAT = Bot("sweat_sword", SWEAT_FIELDS, _sweat_start, _sweat_tick)


def mineflayer_pvp(sim, seat, rng, facts=None, rows=None):
    """Follows, swings on a jittered sword timer and holds its shield up between swings."""
    return _play(sim, seat, rng, rows, MINEFLAYER)


def sweat_sword(sim, seat, rng, facts=None, rows=None):
    """Sword only. Reacts a beat late, strafes in bursts, jumps for crits and resets its sprint."""
    return _play(sim, seat, rng, rows, SWEAT)
