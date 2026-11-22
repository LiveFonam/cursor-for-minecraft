"""Scripted opponents of rising difficulty and the opponent pool."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import actions as A
from . import constants as C
from .combat import CHARGE_GATE
from .farmwatch import fit_to_mask
from .interface import SHARED, Interface
from .obs import build_masks, intercept_angles, view_angles, wrap_degrees
from .policy import NumpyPolicy
from .sim import Sim

MAX_SNAPSHOTS = 12
MAX_RIVALS = 12
RIVAL_SHARE = 0.5
RETREAT_HEALTH = 8.0

TRAIL_DECISIONS = 6
STRAFE_RANGE = 5.0
GUARD_RANGE = 5.0
GUARD_DROP_TICKS = 2.0
ENEMY_READY = 0.75
AXE_SWAP_RANGE = 4.0
CROSSBOW_OPEN_RANGE = 6.5
CROSSBOW_KEEP_RANGE = 4.5
AXE_HOLD_TICKS = 40
CRIT_RANGE_MARGIN = 0.2
SPRINT_RANGE = 2.0
CRIT_LEAD_TICKS = 6.0
CRIT_WAIT_TICKS = 8.0
WHIFF_MAX = 0.9
WHIFF_TURN = 45.0


def sample_masked(masks: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Pick a uniformly random allowed action on every head."""
    scores = rng.random(masks.shape) * masks
    out = np.zeros((len(masks), len(A.NVEC)), dtype=np.int64)
    for head, (start, size) in enumerate(zip(A.HEAD_OFFSETS, A.NVEC)):
        out[:, head] = scores[:, start : start + size].argmax(axis=1)
    return out


@dataclass
class Facts:
    """Noise free facts about one seat, computed once per step for all its opponents."""

    distance: np.ndarray
    want_yaw: np.ndarray
    want_pitch: np.ndarray
    aim: np.ndarray
    charged: np.ndarray
    grounded: np.ndarray
    falling: np.ndarray


@dataclass
class View:
    """Facts a scripted opponent reads from the simulator, for the arenas it owns."""

    distance: np.ndarray
    yaw_error: np.ndarray
    pitch_error: np.ndarray
    aim: np.ndarray
    charged: np.ndarray
    grounded: np.ndarray
    falling: np.ndarray


def read_facts(sim: Sim, seat: int) -> Facts:
    """Compute the shared facts of one seat."""
    other = 1 - seat
    delta = sim.pos[:, other] - sim.pos[:, seat]
    eye = sim.pos[:, seat] + np.array([0.0, C.EYE_HEIGHT, 0.0])
    chest = sim.pos[:, other] + np.array([0.0, C.PLAYER_HEIGHT / 2.0, 0.0])
    want_yaw, want_pitch = view_angles(chest - eye)
    return Facts(
        distance=np.hypot(delta[:, 0], delta[:, 2]),
        want_yaw=want_yaw,
        want_pitch=want_pitch,
        aim=sim.aim_hits()[:, seat],
        charged=sim.attack_multiplier()[:, seat] >= C.FULL_CHARGE_THRESHOLD,
        grounded=sim.on_ground[:, seat],
        falling=(sim.vel[:, seat, 1] < 0.0) & ~sim.on_ground[:, seat],
    )


def _rows(rows: np.ndarray | None):
    return slice(None) if rows is None else rows


def _count(sim: Sim, rows: np.ndarray | None) -> int:
    return sim.n if rows is None else len(rows)


def read_view(
    sim: Sim,
    seat: int,
    rng: np.random.Generator,
    noise: float,
    facts: Facts | None = None,
    rows: np.ndarray | None = None,
) -> View:
    """Return one opponent's view, drawing aim noise only for the arenas it owns."""
    if facts is None:
        facts = read_facts(sim, seat)
    at = _rows(rows)
    count = _count(sim, rows)
    yaw = facts.want_yaw[at]
    pitch = facts.want_pitch[at]
    if noise > 0.0:
        yaw = yaw + rng.normal(0.0, noise, count)
        pitch = pitch + rng.normal(0.0, noise, count)
    return View(
        distance=facts.distance[at],
        yaw_error=wrap_degrees(yaw - sim.yaw[at, seat]),
        pitch_error=pitch - sim.pitch[at, seat],
        aim=facts.aim[at],
        charged=facts.charged[at],
        grounded=facts.grounded[at],
        falling=facts.falling[at],
    )


def steer(a: np.ndarray, yaw_error: np.ndarray, pitch_error: np.ndarray) -> None:
    """Choose the look steps closest to a turn given in simulator angles."""
    a[:, A.YAW], a[:, A.PITCH] = A.turn_indices(yaw_error, pitch_error)


def chase(a: np.ndarray, view: View, stop: float = 2.4, retreat: float = 1.4) -> None:
    a[:, A.FORWARD] = np.select(
        [view.distance > stop, view.distance < retreat], [A.KEY_FORWARD, A.KEY_BACK], A.NEUTRAL_FORWARD
    )


def base(sim: Sim, seat: int, rng: np.random.Generator, noise: float, facts=None, rows=None):
    at = _rows(rows)
    view = read_view(sim, seat, rng, noise, facts, rows)
    held = sim.weapon[at, seat]
    a = A.neutral_actions(np.where(held <= C.AXE, held, C.SWORD))
    steer(a, view.yaw_error, view.pitch_error)
    return a, view


def idle(sim, seat, rng, facts=None, rows=None):
    return A.neutral_actions(np.full(_count(sim, rows), C.SWORD))


def random_player(sim, seat, rng, facts=None, rows=None):
    return sample_masked(build_masks(sim, seat, rows=rows), rng)


def walker(sim, seat, rng, facts=None, rows=None):
    a, view = base(sim, seat, rng, 6.0, facts, rows)
    chase(a, view)
    return a


def swinger(sim, seat, rng, facts=None, rows=None):
    a, view = base(sim, seat, rng, 4.0, facts, rows)
    chase(a, view)
    a[:, A.ATTACK] = view.aim & view.charged
    return a


def strafer(sim, seat, rng, facts=None, rows=None):
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.5, facts, rows)
    chase(a, view)
    phase = (sim.ticks[at] // 16 + seat) % 2
    near = view.distance < 5.0
    a[:, A.STRAFE] = np.where(near, A.KEY_LEFT + phase, A.NEUTRAL_STRAFE)
    tap = sim.sprint_held[at, seat] & ~sim.sprinting[at, seat]
    a[:, A.SPRINT] = (view.distance > 2.0) & ~tap
    a[:, A.ATTACK] = view.aim & view.charged
    return a


def critter(sim, seat, rng, facts=None, rows=None):
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    chase(a, view, stop=2.2)
    a[:, A.SPRINT] = view.distance > 4.0
    a[:, A.JUMP] = (view.distance < 4.0) & view.grounded & view.charged
    a[:, A.ATTACK] = view.aim & view.charged & (view.falling | (view.distance < 1.6))
    return a


def shielder(sim, seat, rng, facts=None, rows=None):
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    chase(a, view)
    other = 1 - seat
    threat = sim.attack_multiplier()[at, other] >= C.FULL_CHARGE_THRESHOLD
    ready = sim.shield_disabled[at, seat] == 0
    guard = (view.distance < 4.5) & threat & ready & ~(view.charged & view.aim)
    a[:, A.USE] = guard
    a[:, A.ATTACK] = view.aim & view.charged & ~guard
    a[:, A.SPRINT] = (view.distance > 3.0) & ~guard
    return a


def axeman(sim, seat, rng, facts=None, rows=None):
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    chase(a, view)
    other = 1 - seat
    shielded = sim.shield_active[at, other]
    a[:, A.WEAPON] = A.WEAPON_ACTION[np.where(shielded, C.AXE, C.SWORD)]
    holding_axe = sim.weapon[at, seat] == C.AXE
    a[:, A.ATTACK] = view.aim & (view.charged | (holding_axe & shielded))
    a[:, A.SPRINT] = view.distance > 3.0
    return a


def archer(sim, seat, rng, facts=None, rows=None):
    at = _rows(rows)
    view = read_view(sim, seat, rng, 1.0, facts, rows)
    close = view.distance < 3.5
    a = A.neutral_actions(np.where(close, C.SWORD, C.BOW))
    yaw, pitch, _ = intercept_angles(sim, seat, np.full(sim.n, C.BOW_MAX_SPEED))
    bow_yaw = wrap_degrees(yaw[at] - sim.yaw[at, seat])
    bow_pitch = pitch[at] - sim.pitch[at, seat]
    steer(
        a,
        np.where(close, view.yaw_error, bow_yaw),
        np.where(close, view.pitch_error, bow_pitch),
    )
    a[:, A.FORWARD] = np.select(
        [close, view.distance < 8.0, view.distance > 13.0],
        [A.KEY_FORWARD, A.KEY_BACK, A.KEY_FORWARD],
        A.NEUTRAL_FORWARD,
    )
    drawing = sim.weapon[at, seat] == C.BOW
    aimed = (np.abs(bow_yaw) < 3.0) & (np.abs(bow_pitch) < 3.0)
    full = sim.draw_ticks[at, seat] >= C.BOW_FULL_DRAW_TICKS
    a[:, A.USE] = drawing & ~(full & aimed) & ~close
    a[:, A.ATTACK] = close & view.aim & view.charged & ~drawing
    return a


def retreater(sim, seat, rng, facts=None, rows=None):
    """Fights until hurt, then runs, and turns back when caught or against the border."""
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    chase(a, view)
    from_center = np.abs(sim.pos[at, seat][:, [0, 2]] - sim.origin[[0, 2]]).max(axis=1)
    cornered = (sim.border_half - from_center < 1.5) | (view.distance < 2.0)
    hurt = (sim.hp[at, seat] <= RETREAT_HEALTH) & ~cornered
    run = hurt & (view.distance < 9.0)
    wait = hurt & ~run
    steer(
        a,
        np.where(run, wrap_degrees(view.yaw_error + 180.0), view.yaw_error),
        np.where(run, -sim.pitch[at, seat], view.pitch_error),
    )
    a[:, A.FORWARD] = np.select([run, wait], [A.KEY_FORWARD, A.NEUTRAL_FORWARD], a[:, A.FORWARD])
    a[:, A.SPRINT] = run | (~wait & (view.distance > 3.0))
    a[:, A.USE] = wait & (sim.shield_disabled[at, seat] == 0)
    a[:, A.ATTACK] = view.aim & view.charged & ~hurt
    return a


def hit_and_run(sim, seat, rng, facts=None, rows=None):
    """Closes while charged, lands one hit at long reach and backs off to recharge."""
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    closing = view.charged & (view.distance > 2.8)
    backing = ~view.charged & (view.distance < 5.5)
    a[:, A.FORWARD] = np.select([closing, backing], [A.KEY_FORWARD, A.KEY_BACK], A.NEUTRAL_FORWARD)
    a[:, A.SPRINT] = closing
    phase = (sim.ticks[at] // 16 + seat) % 2
    a[:, A.STRAFE] = np.where(view.charged, A.NEUTRAL_STRAFE, A.KEY_LEFT + phase)
    a[:, A.ATTACK] = view.aim & view.charged
    return a


def rusher(sim, seat, rng, facts=None, rows=None):
    """Holds at range and charges whenever the enemy draws a bow or loads a crossbow."""
    at = _rows(rows)
    a, view = base(sim, seat, rng, 2.0, facts, rows)
    other = 1 - seat
    rush = (sim.load_ticks[at, other] > 0) | (sim.draw_ticks[at, other] > 0) | (view.distance < 3.5)
    a[:, A.FORWARD] = np.select(
        [rush & (view.distance > 2.2), rush & (view.distance < 1.4), ~rush & (view.distance > 7.0), ~rush & (view.distance < 5.0)],
        [A.KEY_FORWARD, A.KEY_BACK, A.KEY_FORWARD, A.KEY_BACK],
        A.NEUTRAL_FORWARD,
    )
    a[:, A.SPRINT] = rush & (view.distance > 2.2)
    phase = (sim.ticks[at] // 16 + seat) % 2
    a[:, A.STRAFE] = np.where(rush, A.NEUTRAL_STRAFE, A.KEY_LEFT + phase)
    a[:, A.ATTACK] = view.aim & view.charged
    return a


@dataclass(frozen=True)
class PvpStyle:
    """How one of the harder scripted fighters plays.

    lag: decisions between the enemy moving and this fighter's footwork reacting to it.
    The view follows the known position, and `whiff` stands in for the aim error of the lag.
    swing_delay: most extra ticks it waits after a full charge.
    strafe_ticks: shortest and longest strafe burst.
    blind_side: strafe toward the side the enemy is not looking at.
    crit_chance: share of swings it tries to land while falling.
    tap_chance: share of swings followed by a sprint reset when they land.
    whiff: base chance that a swing misses, higher against a moving target.
    guard: "between" holds the shield between swings, "react" raises it when the
    enemy's swing is nearly ready, "hold" keeps it up until it is disabled or gone,
    and "none" never uses it.
    axe_shields: switch to the axe to disable a raised shield.
    crossbow: open with crossbow shots while the enemy is far away.
    """

    noise: float = 1.5
    lag: int = 0
    stop: float = 2.4
    back: float = 1.2
    swing_delay: int = 0
    strafe_chance: float = 0.0
    strafe_ticks: tuple[int, int] = (10, 28)
    blind_side: bool = False
    crit_chance: float = 0.0
    tap_chance: float = 0.0
    whiff: float = 0.0
    guard: str = "none"
    axe_shields: bool = False
    crossbow: bool = False


PVP_BASIC = PvpStyle(noise=1.5, stop=2.4, back=1.3, swing_delay=2, guard="between")
PVP_COMBO = PvpStyle(
    noise=1.2,
    strafe_chance=1.0,
    strafe_ticks=(5, 25),
    blind_side=True,
    crit_chance=0.6,
    tap_chance=0.8,
    guard="react",
    axe_shields=True,
    crossbow=True,
)
PVP_SWEAT = PvpStyle(
    noise=1.0,
    lag=1,
    back=1.1,
    strafe_chance=0.85,
    crit_chance=0.75,
    tap_chance=0.8,
    whiff=0.04,
    axe_shields=True,
)
SHIELD_HOLDER = PvpStyle(noise=1.5, stop=2.4, back=1.3, guard="hold")


class PvpMemory:
    """What the harder scripted fighters remember between decisions, per arena and seat."""

    def __init__(self, n: int):
        self.tick = np.full((n, 2), -1, dtype=np.int64)
        self.trail = np.zeros((n, 2, TRAIL_DECISIONS, 3))
        self.strafe = np.zeros((n, 2), dtype=np.int64)
        self.strafe_until = np.zeros((n, 2), dtype=np.int64)
        self.swing_wait = np.zeros((n, 2), dtype=np.int64)
        self.axe_until = np.zeros((n, 2), dtype=np.int64)
        self.crit_planned = np.zeros((n, 2), dtype=bool)
        self.tap_armed = np.zeros((n, 2), dtype=bool)

    def update(self, ticks: np.ndarray, seat: int, picked: np.ndarray, target: np.ndarray) -> None:
        """Clear rounds that restarted and add the enemy position once per decision."""
        last = self.tick[picked, seat]
        restart = (ticks < last) | (last < 0)
        if restart.any():
            rows = picked[restart]
            self.trail[rows, seat] = target[restart][:, None, :]
            for field in (self.strafe, self.strafe_until, self.swing_wait, self.axe_until):
                field[rows, seat] = 0
            self.crit_planned[rows, seat] = False
            self.tap_armed[rows, seat] = False
        moved = ticks > last
        if moved.any():
            rows = picked[moved]
            self.trail[rows, seat, 1:] = self.trail[rows, seat, :-1]
            self.trail[rows, seat, 0] = target[moved]
        self.tick[picked, seat] = ticks


def _pvp_memory(sim: Sim) -> PvpMemory:
    if "pvp_memory" not in sim.__dict__:
        sim.pvp_memory = PvpMemory(sim.n)
    return sim.pvp_memory


def _steer_legal(a: np.ndarray, masks: np.ndarray, yaw_error: np.ndarray, pitch_error: np.ndarray) -> None:
    """Choose the allowed look steps closest to a turn given in simulator angles."""
    for head, error, steps in ((A.YAW, yaw_error, A.SIM_YAW_STEP), (A.PITCH, pitch_error, A.SIM_PITCH_STEP)):
        start = int(A.HEAD_OFFSETS[head])
        gap = np.abs(error[:, None] - steps)
        gap[~masks[:, start : start + len(steps)]] = np.inf
        a[:, head] = gap.argmin(axis=1)


def _blind_side(sim: Sim, seat: int, picked: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Return the strafe key that moves away from where the enemy is looking."""
    other = 1 - seat
    enemy_yaw = np.radians(sim.yaw[picked, other])
    view_x, view_z = -np.sin(enemy_yaw), np.cos(enemy_yaw)
    to_me = sim.pos[picked, seat] - target
    along = to_me[:, 0] * view_x + to_me[:, 2] * view_z
    side_x, side_z = to_me[:, 0] - along * view_x, to_me[:, 2] - along * view_z
    own_yaw = np.radians(sim.yaw[picked, seat])
    right = side_x * -np.cos(own_yaw) + side_z * -np.sin(own_yaw)
    return np.where(right >= 0.0, A.KEY_RIGHT, A.KEY_LEFT)


def _facing(sim: Sim, seat: int, picked: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Return where the enemy's view points toward this fighter."""
    enemy_yaw = np.radians(sim.yaw[picked, 1 - seat])
    to_me = sim.pos[picked, seat] - target
    return -np.sin(enemy_yaw) * to_me[:, 0] + np.cos(enemy_yaw) * to_me[:, 2] > 0.0


def _pvp_fight(sim: Sim, seat: int, rng: np.random.Generator, style: PvpStyle, facts=None, rows=None) -> np.ndarray:
    """Play one decision of a harder fighter through the same masks as the learner."""
    picked = np.arange(sim.n) if rows is None else np.asarray(rows)
    count = len(picked)
    if facts is None:
        facts = read_facts(sim, seat)
    other = 1 - seat
    now = sim.ticks[picked]
    target = sim.perception.known_position(seat, picked)
    memory = _pvp_memory(sim)
    memory.update(now, seat, picked, target)
    seen = memory.trail[picked, seat, style.lag]
    chest = np.array([0.0, C.PLAYER_HEIGHT / 2.0, 0.0])
    eyes = sim.eyes()[picked, seat]
    late = seen + chest - eyes
    distance = np.hypot(late[:, 0], late[:, 2])
    want_yaw, want_pitch = view_angles(target + chest - eyes)
    if style.noise > 0.0:
        want_yaw = want_yaw + rng.normal(0.0, style.noise, count)
        want_pitch = want_pitch + rng.normal(0.0, style.noise, count)
    yaw_error = wrap_degrees(want_yaw - sim.yaw[picked, seat])
    pitch_error = want_pitch - sim.pitch[picked, seat]

    held = sim.weapon[picked, seat]
    melee_held = held <= C.AXE
    shield_faces = sim.shield_active[picked, other] & _facing(sim, seat, picked, target)
    choice = np.full(count, C.SWORD)
    if style.axe_shields:
        disabled = sim.shield_disabled[picked, other] > 0
        wants_axe = (shield_faces & (distance < AXE_SWAP_RANGE)) | disabled
        memory.axe_until[picked[wants_axe], seat] = now[wants_axe] + AXE_HOLD_TICKS
        choice[now < memory.axe_until[picked, seat]] = C.AXE
    ranged = np.zeros(count, dtype=bool)
    if style.crossbow:
        stocked = (sim.ammo[picked, seat] > 0) | sim.loaded[picked, seat]
        ranged = stocked & ((distance > CROSSBOW_OPEN_RANGE) | ((held == C.CROSSBOW) & (distance > CROSSBOW_KEEP_RANGE)))
        choice[ranged] = C.CROSSBOW

    holding_up = np.zeros(count, dtype=bool)
    if style.guard == "hold":
        holding_up = (sim.shield_disabled[picked, seat] == 0) & sim.combat.has_shield[picked, seat]

    a = A.neutral_actions(choice)
    a[:, A.FORWARD] = np.select(
        [distance > style.stop, distance < style.back], [A.KEY_FORWARD, A.KEY_BACK], A.NEUTRAL_FORWARD
    )
    if style.strafe_chance > 0.0:
        due = now >= memory.strafe_until[picked, seat]
        if due.any():
            lo, hi = style.strafe_ticks
            chosen = picked[due]
            memory.strafe_until[chosen, seat] = now[due] + rng.integers(lo, hi + 1, len(chosen))
            if style.blind_side:
                side = _blind_side(sim, seat, chosen, target[due])
            else:
                side = rng.integers(A.KEY_LEFT, A.KEY_RIGHT + 1, len(chosen))
            moves = rng.random(len(chosen)) < style.strafe_chance
            memory.strafe[chosen, seat] = np.where(moves, side, A.NEUTRAL_STRAFE)
        a[:, A.STRAFE] = np.where(distance < STRAFE_RANGE, memory.strafe[picked, seat], A.NEUTRAL_STRAFE)

    period = C.TICKS_PER_SECOND / sim.combat.attack_speed()[picked, seat]
    left = CHARGE_GATE * period - 0.5 - sim.attack_ticks[picked, seat]
    grounded = facts.grounded[picked]
    falling = facts.falling[picked]
    planned = memory.crit_planned[picked, seat]
    crit_near = distance < style.stop + CRIT_RANGE_MARGIN
    a[:, A.JUMP] = planned & crit_near & grounded & (left <= CRIT_LEAD_TICKS)
    rising = ~grounded & ~falling
    wait_for_fall = planned & rising & (left > -CRIT_WAIT_TICKS)
    ready = facts.charged[picked] & (now >= memory.swing_wait[picked, seat]) & ~wait_for_fall
    breaks_shield = style.axe_shields & (held == C.AXE) & shield_faces
    swing = melee_held & ~ranged & facts.aim[picked] & (ready | breaks_shield) & ~holding_up

    spent = sim.sprint_held[picked, seat] & ~sim.sprinting[picked, seat]
    tap = spent & memory.tap_armed[picked, seat]
    memory.tap_armed[picked[tap], seat] = False
    a[:, A.SPRINT] = (distance > SPRINT_RANGE) & ~tap & ~(planned & ~grounded) & ~holding_up

    use = holding_up.copy()
    if style.guard not in ("none", "hold"):
        free = (sim.shield_disabled[picked, seat] == 0) & ~ranged & (distance < GUARD_RANGE) & (left > GUARD_DROP_TICKS)
        if style.guard == "between":
            use = free
        else:
            enemy_period = C.TICKS_PER_SECOND / C.WEAPON_ATTACK_SPEED[sim.weapon[picked, other]]
            enemy_charge = np.clip((sim.attack_ticks[picked, other] + 0.5) / enemy_period, 0.0, 1.0)
            use = free & (enemy_charge >= ENEMY_READY)
    if style.crossbow:
        holding = held == C.CROSSBOW
        loaded = sim.loaded[picked, seat]
        load = holding & ranged & ~loaded & ~sim.load_wait[picked, seat]
        shoot = holding & ranged & loaded & ~sim.use_prev[picked, seat] & ~shield_faces
        use = np.where(ranged, load | shoot, use)
        a[:, A.LOCK_AIM] = holding & ranged & loaded
    a[:, A.USE] = use & ~swing
    a[:, A.ATTACK] = swing

    if style.whiff > 0.0 and swing.any():
        drift = np.linalg.norm(target[:, [0, 2]] - seen[:, [0, 2]], axis=1)
        miss = swing & (rng.random(count) < np.minimum(WHIFF_MAX, style.whiff * (1.0 + drift)))
        yaw_error = np.where(miss, yaw_error + WHIFF_TURN * rng.choice((-1.0, 1.0), count), yaw_error)
    fired = picked[swing]
    if len(fired):
        memory.crit_planned[fired, seat] = rng.random(len(fired)) < style.crit_chance
        memory.tap_armed[fired, seat] = rng.random(len(fired)) < style.tap_chance
        extra = rng.integers(0, style.swing_delay + 1, len(fired))
        memory.swing_wait[fired, seat] = now[swing] + np.ceil(CHARGE_GATE * period[swing]).astype(np.int64) + extra

    masks = build_masks(sim, seat, rows=rows)
    _steer_legal(a, masks, yaw_error, pitch_error)
    return fit_to_mask(a, masks, A.NVEC)


def pvp_basic(sim, seat, rng, facts=None, rows=None):
    """Swings on a full sword charge and holds the shield up between swings."""
    return _pvp_fight(sim, seat, rng, PVP_BASIC, facts, rows)


def pvp_combo(sim, seat, rng, facts=None, rows=None):
    """Mixes crits, sprint resets, blind side strafing, shield timing, axe disables and crossbow openers."""
    return _pvp_fight(sim, seat, rng, PVP_COMBO, facts, rows)


def pvp_sweat(sim, seat, rng, facts=None, rows=None):
    """Reacts a beat late, strafes in bursts, jumps for crits, resets sprint and sometimes whiffs."""
    return _pvp_fight(sim, seat, rng, PVP_SWEAT, facts, rows)


def shield_holder(sim, seat, rng, facts=None, rows=None):
    """Keeps the shield raised toward the enemy until it is disabled, fights, then raises it again."""
    return _pvp_fight(sim, seat, rng, SHIELD_HOLDER, facts, rows)


SCRIPTED = {
    "idle": idle,
    "random": random_player,
    "walker": walker,
    "swinger": swinger,
    "strafer": strafer,
    "critter": critter,
    "shielder": shielder,
    "axeman": axeman,
    "archer": archer,
    "retreater": retreater,
    "hit_and_run": hit_and_run,
    "rusher": rusher,
    "pvp_basic": pvp_basic,
    "pvp_combo": pvp_combo,
    "pvp_sweat": pvp_sweat,
    "shield_holder": shield_holder,
}
HARD_SCRIPTED = ("pvp_basic", "pvp_combo", "pvp_sweat")

LEAGUE = "league"


class OpponentPool:
    """Assigns one opponent per arena and produces its actions."""

    allowed: np.ndarray | None = None

    def __init__(self, n: int, seed: int = 0, max_ticks: int = 600, interface: Interface | None = None):
        self.n = n
        self.interface = interface or SHARED
        self.rng = np.random.default_rng(seed)
        self.max_ticks = max_ticks
        self.names: list[str] = ["idle"]
        self.probs = np.array([1.0])
        self.assigned = np.zeros(n, dtype=np.int64)
        self.snapshot_of = np.full(n, -1, dtype=np.int64)
        self.snapshots: list[NumpyPolicy] = []
        self.games = np.zeros(MAX_SNAPSHOTS)
        self.wins = np.zeros(MAX_SNAPSHOTS)
        self.rival_share = RIVAL_SHARE
        self.rivals: list = []
        self.rival_names: list[str] = []
        self.rival_of = np.full(n, -1, dtype=np.int64)
        self.rival_games = np.zeros(MAX_RIVALS)
        self.rival_wins = np.zeros(MAX_RIVALS)

    def __getstate__(self) -> dict:
        """Leave the frozen rivals out of checkpoints, they are reloaded from their runs."""
        state = dict(self.__dict__)
        state["rivals"] = []
        return state

    def __setstate__(self, state: dict) -> None:
        self.__dict__.update(state)
        if "rival_of" not in state:
            self.rival_share = RIVAL_SHARE
            self.rivals = []
            self.rival_names = []
            self.rival_of = np.full(self.n, -1, dtype=np.int64)
            self.rival_games = np.zeros(MAX_RIVALS)
            self.rival_wins = np.zeros(MAX_RIVALS)

    def set_rivals(self, rivals: list) -> None:
        """Install frozen rivals, keeping the record of each one that stays by name."""
        if len(rivals) > MAX_RIVALS:
            raise ValueError(f"at most {MAX_RIVALS} rivals fit in the league")
        names = [rival.name for rival in rivals]
        if len(set(names)) != len(names):
            raise ValueError("rival names must be unique")
        old = {name: i for i, name in enumerate(self.rival_names)}
        keep = np.array([old.get(name, -1) for name in names], dtype=np.int64)
        games, wins = np.zeros(MAX_RIVALS), np.zeros(MAX_RIVALS)
        kept = np.flatnonzero(keep >= 0)
        games[kept], wins[kept] = self.rival_games[keep[kept]], self.rival_wins[keep[kept]]
        moved = np.full(len(self.rival_names) + 1, -1, dtype=np.int64)
        moved[keep[kept]] = kept
        lost = self.rival_of >= 0
        self.rival_of[lost] = moved[self.rival_of[lost]]
        self.rivals = list(rivals)
        self.rival_names = names
        self.rival_games, self.rival_wins = games, wins
        orphaned = lost & (self.rival_of < 0)
        if orphaned.any():
            self.assign(orphaned)

    def set_mix(self, mix: dict[str, float]) -> None:
        """Set the opponent names and their sampling weights."""
        self.names = list(mix)
        weights = np.array([mix[name] for name in self.names], dtype=float)
        self.probs = weights / weights.sum()
        self.assign(np.ones(self.n, dtype=bool))

    def add_snapshot(self, policy: NumpyPolicy) -> None:
        """Add a past version, dropping the oldest when the league is full."""
        if len(self.snapshots) == MAX_SNAPSHOTS:
            self.snapshots.pop(0)
            self.games = np.append(self.games[1:], 0.0)
            self.wins = np.append(self.wins[1:], 0.0)
            self.snapshot_of = np.maximum(self.snapshot_of - 1, -1)
        self.snapshots.append(policy)

    def _snapshot_probs(self) -> np.ndarray:
        count = len(self.snapshots)
        rate = (self.wins[:count] + 1.0) / (self.games[:count] + 2.0)
        weight = (1.0 - rate) ** 2 + 0.05
        return weight / weight.sum()

    def _rival_probs(self) -> np.ndarray:
        count = len(self.rivals)
        rate = (self.rival_wins[:count] + 1.0) / (self.rival_games[:count] + 2.0)
        weight = (1.0 - rate) ** 2 + 0.05
        return weight / weight.sum()

    def assign(self, mask: np.ndarray) -> None:
        """Draw a new opponent for the selected arenas."""
        idx = np.flatnonzero(mask)
        if len(idx) == 0:
            return
        self.assigned[idx] = self.rng.choice(len(self.names), size=len(idx), p=self.probs)
        self.snapshot_of[idx] = -1
        self.rival_of[idx] = -1
        if LEAGUE not in self.names:
            return
        league = self.names.index(LEAGUE)
        picks = idx[self.assigned[idx] == league]
        if self.rivals and len(picks):
            share = self.rival_share if self.snapshots else 1.0
            to_rival = self.rng.random(len(picks)) < share
            chosen = picks[to_rival]
            if len(chosen):
                self.rival_of[chosen] = self.rng.choice(len(self.rivals), size=len(chosen), p=self._rival_probs())
            picks = picks[~to_rival]
        if self.snapshots and len(picks):
            self.snapshot_of[picks] = self.rng.choice(
                len(self.snapshots), size=len(picks), p=self._snapshot_probs()
            )

    def record(self, idx: np.ndarray, won: np.ndarray) -> None:
        """Update league win rates for finished games."""
        for env, result in zip(idx, won):
            snap = self.snapshot_of[env]
            if snap >= 0:
                self.games[snap] += 1.0
                self.wins[snap] += float(result)
            rival = self.rival_of[env]
            if rival >= 0:
                self.rival_games[rival] += 1.0
                self.rival_wins[rival] += float(result)

    def name_of(self, env: int) -> str:
        """Return the opponent name of one arena, with the rival's name for a frozen rival."""
        rival = self.rival_of[env]
        if rival >= 0:
            return f"rival:{self.rival_names[rival]}"
        return self.names[self.assigned[env]]

    def act(self, sim: Sim, seat: int) -> np.ndarray:
        """Return one action per arena for the opponent seat."""
        out = A.neutral_actions(sim.weapon[:, seat].copy())
        facts = read_facts(sim, seat)
        for i, name in enumerate(self.names):
            rows = np.flatnonzero(self.assigned == i)
            if len(rows) == 0:
                continue
            if name == LEAGUE:
                self._act_league(sim, seat, self._act_rivals(sim, seat, rows, out), out, facts)
            else:
                out[rows] = SCRIPTED[name](sim, seat, self.rng, facts, rows)
        return out

    def _act_rivals(self, sim: Sim, seat: int, rows: np.ndarray, out: np.ndarray) -> np.ndarray:
        """Play the arenas held by frozen rivals and return the other league arenas."""
        if not self.rivals:
            return rows
        chosen = self.rival_of[rows]
        for rival in np.unique(chosen[chosen >= 0]):
            here = rows[chosen == rival]
            out[here] = self.rivals[rival].act(sim, seat, here, self.rng)
        return rows[chosen < 0]

    def _act_league(self, sim: Sim, seat: int, rows: np.ndarray, out: np.ndarray, facts: Facts) -> None:
        fallback = rows[self.snapshot_of[rows] < 0]
        if len(fallback):
            out[fallback] = swinger(sim, seat, self.rng, facts, fallback)
        picked = rows[self.snapshot_of[rows] >= 0]
        if len(picked) == 0:
            return
        obs = np.clip(self.interface.observe(sim, seat, self.max_ticks, picked), -5.0, 5.0)
        masks = self.interface.masks(sim, seat, self.allowed, rows=picked)
        chosen = self.snapshot_of[picked]
        shared = len(A.NVEC)
        for snap in np.unique(chosen):
            here = chosen == snap
            acted = self.snapshots[snap].act(obs[here], masks[here], self.rng)
            out[picked[here]] = acted[:, :shared]
            if self.interface.apply is not None:
                self.interface.apply(sim, seat, acted[:, shared:], picked[here])
