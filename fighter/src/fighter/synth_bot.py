"""SynthSarcasm's trained network as a simulator opponent.

SynthSarcasm/minecraft-pvp-neural-network is MIT licensed. Its code and weights stay outside
this repository. Set SYNTH_HOME to a clone of the project and SYNTH_WEIGHTS to its stage 6
release weights. PyTorch and the project's modules load the first time the bot plays.

The network runs its own feature code on the observation its client mod would build, and it
decides every tick. The simulator decides every 2 ticks, so each decision feeds the network a
frame halfway between the last decision and now, then the current frame. Its camera smoothing,
sprint rule and right click delay follow its client. Its look is written straight onto the view
because its turns are finer than the simulator's look steps.

It plays the flat arena profile only, because its block inputs are built for a flat floor.
Pillars in that arena go into its block grid, height map, sight flags and crosshair.
"""

from __future__ import annotations

import hashlib
import importlib
import os
import sys
import weakref
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import actions as A
from . import combat as CB
from . import constants as C
from .farmwatch import fit_to_mask
from .obs import build_masks, wrap_degrees
from .sim import look_vectors

HOME_VARIABLE = "SYNTH_HOME"
WEIGHTS_VARIABLE = "SYNTH_WEIGHTS"
WEIGHTS_SHA256 = "907d837f525feaf8ad9228b24fef299d2c9e42fca8fb4b92f4217cf70dd51d50"
PROJECT_MODULES = ("bridge", "features", "network")

ARENA_ROOM = 8.0
ROUND_TIME_CAP = 600
RIGHT_CLICK_DELAY = 4
CALM_RANGE = 6.0
# Turn limits in degrees per tick as (top speed, speed up, slow down).
NORMAL_TURN = {"yaw": (20.0, 6.0, 15.0), "pitch": (10.0, 5.0, 10.0)}
CALM_TURN = {"yaw": (8.0, 3.0, 8.0), "pitch": (5.0, 2.0, 5.0)}
CALM_DEAD_ZONE = 3.0
OBSTACLE_CELLS = (42, 47)
KIT_SHIELD = 4
KIT_BOW = 1
KIT_ARROWS_SHOWN = 5
SHIELD_COOLDOWN_SCALE = 100.0
START_SATURATION = 20
OTHER_SATURATION = 5
HELD_CODES = {C.SWORD: 1, C.AXE: 2, C.BOW: 3, C.CROSSBOW: 8}
SLOT_AXE = 1
SLOT_BOW = 2
FIRST_UNUSED_SLOT = 3
LAST_SLOT = 10
HEAD_SLOT = 7
HOP_HEIGHT = 0.3
TELEPORT_RANGE = 3.0


@dataclass
class Brain:
    """The loaded network and the project's modules."""

    torch: Any
    net: Any
    layout: Any
    features: Any
    slot_start: int


_brain: Brain | None = None
_players: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


@contextmanager
def _project_imports(folder: Path):
    """Import the project's modules without leaving its generic names or bytecode behind."""
    saved_modules = {name: sys.modules.pop(name) for name in PROJECT_MODULES if name in sys.modules}
    saved_path = list(sys.path)
    saved_flag = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(folder))
    try:
        yield
    finally:
        sys.path[:] = saved_path
        sys.dont_write_bytecode = saved_flag
        for name in PROJECT_MODULES:
            sys.modules.pop(name, None)
        sys.modules.update(saved_modules)


def load_brain() -> Brain:
    """Load the network once, with a clear error for anything that is missing."""
    global _brain
    if _brain is not None:
        return _brain
    try:
        torch = importlib.import_module("torch")
    except ImportError as error:
        raise RuntimeError("the synth opponent needs PyTorch, which is not installed") from error
    home, weights = os.environ.get(HOME_VARIABLE), os.environ.get(WEIGHTS_VARIABLE)
    if not home or not weights:
        raise RuntimeError(
            f"the synth opponent needs {HOME_VARIABLE} set to a clone of SynthSarcasm's project "
            f"and {WEIGHTS_VARIABLE} set to its stage 6 weights file"
        )
    folder = Path(home) / "training"
    if not (folder / "features.py").is_file():
        raise RuntimeError(f"{HOME_VARIABLE} has no training/features.py: {home}")
    path = Path(weights)
    if not path.is_file():
        raise RuntimeError(f"{WEIGHTS_VARIABLE} is not a file: {weights}")
    if hashlib.sha256(path.read_bytes()).hexdigest() != WEIGHTS_SHA256:
        raise RuntimeError(f"{WEIGHTS_VARIABLE} is not the stage 6 release file: {weights}")
    with _project_imports(folder):
        layout = importlib.import_module("bridge")
        features = importlib.import_module("features")
        network = importlib.import_module("network")
        saved = torch.load(path, map_location="cpu", weights_only=True, mmap=True)
        net = network.Siec(features.WEJSCIE, features.GLOWY)
        state = {name: value.float() for name, value in saved["wagi"].items()}
        net.load_state_dict(network.dopasuj(state, features.WEJSCIE))
    net.eval().requires_grad_(False)
    _brain = Brain(torch, net, layout, features, sum(features.GLOWY[:HEAD_SLOT]))
    return _brain


def _smooth(speed, want, top, speed_up, slow_down):
    """Move a turn speed toward the wanted one, as its client's camera does."""
    want = np.clip(want, -top, top)
    braking = (speed != 0.0) & ((want == 0.0) | (np.sign(want) != np.sign(speed)) | (np.abs(want) < np.abs(speed)))
    step = np.where(braking, slow_down, speed_up)
    return speed + np.clip(want - speed, -step, step)


def _next_ticks(sim) -> int:
    rate = sim.cfg.decisions_per_second
    if rate == 10:
        return C.TICKS_PER_DECISION
    if rate == 20:
        return 1
    phase = sim._decision_phase
    return (phase + 1) * 4 // 3 - phase * 4 // 3


class SynthPlayer:
    """One copy of the network per simulator and seat, with its client's state per arena."""

    def __init__(self, sim, seat: int, rng: np.random.Generator):
        self.brain = load_brain()
        features = self.brain.features
        self._sim = weakref.ref(sim)
        self.seat, self.n = seat, sim.n
        n = sim.n
        self.generator = self.brain.torch.Generator().manual_seed(int(rng.integers(1 << 31)))
        self.judge = features.Sedzia(n, lag=True, rng=np.random.default_rng(int(rng.integers(1 << 31))))
        lag = self.judge.lag
        lag.widok[:] = 0
        lag.akc[:] = 0
        lag.widok[0::2] = 1
        lag.widok_przeciwnika = self._client_view
        self.stack = features.Stos(2 * n)
        self.expected = np.full(n, -1, dtype=np.int64)
        self.center = np.zeros((n, 2))
        self.floor = np.zeros(n)
        self.turn_speed = np.zeros((n, 2))
        self.previous: np.ndarray | None = None
        self.fed: np.ndarray | None = None
        self.running = np.zeros(n, dtype=bool)
        self.sprint_sent = np.zeros(n, dtype=bool)
        self.holding = np.zeros(n, dtype=bool)
        self.click_delay = np.zeros(n, dtype=np.int64)
        self.exhaustion = np.zeros(n)
        self.last_pos: np.ndarray | None = None
        self.last_hp: np.ndarray | None = None
        self.swung = np.zeros(n, dtype=bool)
        self.still = np.zeros(len(features.GLOWY), dtype=np.int64)
        self.still[0] = int(np.flatnonzero((features.RUCH == 0.0).all(axis=1))[0])
        self.still[5] = int(np.flatnonzero(features.YAW_PROGI == 0.0)[0])
        self.still[6] = int(np.flatnonzero(features.PITCH_PROGI == 0.0)[0])

    @property
    def sim(self):
        """Return the simulator without keeping it alive, so a finished one can be freed."""
        return self._sim()

    def _client_view(self, obs, new_players, target):
        """Its client already shows the target as seen, so the current frame is the view."""
        lag = self.judge.lag
        lag.hist_obs = obs[None].copy()
        if new_players.any():
            lag.hist_akc[:, new_players] = 0
        lag.widziany = obs[target]
        return lag.widziany

    def _update_exhaustion(self, fresh: np.ndarray) -> None:
        """Track its saturation, which starts full and falls with sprints, jumps, swings and hits."""
        sim, seat = self.sim, self.seat
        here, hp = sim.pos[:, seat].copy(), sim.hp[:, seat].copy()
        if self.last_pos is not None:
            moved = np.hypot(here[:, 0] - self.last_pos[:, 0], here[:, 2] - self.last_pos[:, 2])
            near = moved < TELEPORT_RANGE
            running = sim.sprint_held[:, seat]
            hopped = (here[:, 1] - self.last_pos[:, 1] > HOP_HEIGHT) & near
            self.exhaustion += (
                np.where(near, CB.EXHAUST_SPRINT * moved * running, 0.0)
                + hopped * np.where(running, CB.EXHAUST_SPRINT_JUMP, CB.EXHAUST_JUMP)
                + CB.EXHAUST_ATTACK * self.swung
                + CB.EXHAUST_ATTACK * (hp < self.last_hp)
            )
        self.exhaustion[fresh] = 0.0
        self.last_pos, self.last_hp = here, hp

    def _row(self, who: int) -> np.ndarray:
        """Build the 249 number observation of one player, as its client mod writes it."""
        sim, layout, n = self.sim, self.brain.layout, self.n
        mine = who == self.seat
        other = 1 - who
        row = np.zeros((n, layout.RAW), np.float32)
        pos, enemy = sim.pos[:, who], sim.pos[:, other]
        row[:, layout.X] = pos[:, 0] - self.center[:, 0]
        row[:, layout.Y] = np.clip(pos[:, 1] - self.floor, -6.0, 8.0)
        row[:, layout.Z] = pos[:, 2] - self.center[:, 1]
        row[:, layout.VX : layout.VZ + 1] = sim.vel[:, who]
        row[:, layout.YAW] = wrap_degrees(sim.yaw[:, who])
        row[:, layout.PITCH] = sim.pitch[:, who]
        row[:, layout.HP] = sim.hp[:, who]
        row[:, layout.JEDZENIE] = C.MAX_HEALTH
        saturation = np.maximum(START_SATURATION - np.floor(self.exhaustion / CB.EXHAUSTION_STEP), 0.0)
        row[:, layout.NASYCENIE] = saturation if mine else OTHER_SATURATION
        row[:, layout.PASEK] = sim.combat.charge()[:, who]
        row[:, layout.HURT] = sim.hurt_timer[:, who]
        row[:, layout.ZIEMIA] = sim.on_ground[:, who]
        row[:, layout.SPRINT] = sim.sprint_held[:, who]
        row[:, layout.ZGINAL] = sim.hp[:, who] <= 0.0
        row[:, layout.ODL] = np.linalg.norm(pos - enemy, axis=1)
        row[:, layout.KUCA] = sim.sneaking[:, who]
        weapon = sim.weapon[:, who]
        if mine:
            row[:, layout.BRON] = np.where(weapon == C.SWORD, 1, 2)
            row[:, layout.SLOT] = weapon == C.BOW
        else:
            row[:, layout.BRON] = np.select([weapon == C.AXE, weapon == C.SWORD], [2, 1], 0)
        row[:, layout.ZBROJA] = sim.combat.armor[:, who]
        row[:, layout.TRZYMA] = np.select([weapon == item for item in HELD_CODES], list(HELD_CODES.values()), 0)
        guard = (sim.shield_ticks[:, who] > 0) & (weapon <= C.AXE)
        drawing, loading = sim.draw_ticks[:, who] > 0, sim.load_ticks[:, who] > 0
        row[:, layout.UZYWA] = guard | drawing | loading
        row[:, layout.UZYCIE] = np.select(
            [guard, drawing, loading], [sim.shield_ticks[:, who], sim.draw_ticks[:, who], sim.load_ticks[:, who]], 0
        )
        row[:, layout.BLOKUJE] = sim.shield_active[:, who] & (weapon <= C.AXE)
        if mine:
            row[:, layout.TARCZA_CD] = np.clip(sim.shield_disabled[:, who] / SHIELD_COOLDOWN_SCALE, 0.0, 1.0)
            row[:, layout.STRZALY] = np.minimum(KIT_ARROWS_SHOWN, sim.ammo[:, who])
            row[:, layout.ZESTAW] = KIT_SHIELD | (KIT_BOW * (sim.ammo[:, who] > 0))
        self._write_arrow(row, who, enemy)
        self._write_blocks(row, pos, row[:, layout.YAW])
        row[:, layout.WIDZI + (1 if mine else 0)] = (
            1.0 if sim.pillars is None else sim.perception.enemy(who, slice(None)).visible
        )
        return row

    def _write_arrow(self, row: np.ndarray, who: int, enemy: np.ndarray) -> None:
        """Write this player's arrow in flight that is nearest the other player."""
        sim, layout, n = self.sim, self.brain.layout, self.n
        live = sim.arrow_on & (sim.arrow_owner == who)
        if not live.any():
            return
        gaps = np.where(live, np.linalg.norm(sim.arrow_pos - enemy[:, None], axis=2), np.inf)
        nearest = gaps.argmin(axis=1)
        arenas = np.arange(n)
        found = np.isfinite(gaps[arenas, nearest])
        where, speed = sim.arrow_pos[arenas, nearest], sim.arrow_vel[arenas, nearest]
        row[:, layout.STRZALA_X] = np.where(found, where[:, 0] - self.center[:, 0], 0.0)
        row[:, layout.STRZALA_Y] = np.where(found, np.clip(where[:, 1] - self.floor, -6.0, 12.0), 0.0)
        row[:, layout.STRZALA_Z] = np.where(found, where[:, 2] - self.center[:, 1], 0.0)
        row[:, layout.STRZALA_VX : layout.STRZALA_VZ + 1] = np.where(found[:, None], speed, 0.0)
        row[:, layout.STRZALA_JEST] = found

    def _write_blocks(self, row: np.ndarray, pos: np.ndarray, yaw_degrees: np.ndarray) -> None:
        """Write the block grid and height map of a flat floor, in the player's own frame."""
        sim, layout, n = self.sim, self.brain.layout, self.n
        yaw = np.radians(yaw_degrees)
        ahead_x, ahead_z, right_x, right_z = -np.sin(yaw), np.cos(yaw), -np.cos(yaw), -np.sin(yaw)
        ahead, right = np.meshgrid(np.arange(-3, 4), np.arange(-3, 4), indexing="ij")
        x = np.floor(pos[:, 0, None, None] + ahead * ahead_x[:, None, None] + right * right_x[:, None, None]) + 0.5
        z = np.floor(pos[:, 2, None, None] + ahead * ahead_z[:, None, None] + right * right_z[:, None, None]) + 0.5
        half = sim.border_half
        inside = (np.abs(x - sim.origin[0]) < half) & (np.abs(z - sim.origin[2]) < half)
        levels = np.floor(pos[:, 1, None] + np.array([-1.0, 0.0, 1.0])) + 0.5
        cells = inside[:, 1:6, 1:6, None] & (levels[:, None, None, :] < 0.0)
        if sim.pillars is not None:
            cells = cells | sim.pillars.solid_at(x[:, 1:6, 1:6, None], levels[:, None, None, :], z[:, 1:6, 1:6, None])
        row[:, layout.VOKSELE : layout.VOKSELE + 75] = cells.transpose(0, 3, 1, 2).reshape(n, 75)
        feet = np.floor(pos[:, 1] + 0.01)
        offsets = np.arange(2, -6, -1)
        heights_at = (feet[:, None] + offsets + 0.5)[:, None, None, :]
        solid = inside[..., None] & (heights_at < 0.0)
        if sim.pillars is not None:
            solid = solid | sim.pillars.solid_at(x[..., None], heights_at, z[..., None])
        heights = np.where(solid.any(axis=-1), offsets[solid.argmax(axis=-1)] + 1, -6.0)
        row[:, layout.MAPA_H : layout.MAPA_H + 49] = heights.reshape(n, 49)

    def _frame(self) -> np.ndarray:
        """Return both players' rows, this bot on even indices, with their crosshair flags."""
        features, layout = self.brain.features, self.brain.layout
        frame = np.empty((2 * self.n, layout.RAW), np.float32)
        frame[0::2] = self._row(self.seat)
        frame[1::2] = self._row(1 - self.seat)
        for side in (0, 1):
            own, enemy = frame[side::2], frame[1 - side::2]
            who = self.seat if side == 0 else 1 - self.seat
            frame[side::2, layout.CELUJE] = self._on_target(own, enemy, own[:, layout.YAW], own[:, layout.PITCH], who)
        return frame

    def _on_target(self, own, enemy, yaw, pitch, who: int) -> np.ndarray:
        """Return whether the crosshair is on the other player with no pillar in between."""
        aimed = self.brain.features.celownik(own, enemy, yaw, pitch)
        sim = self.sim
        if sim.pillars is None:
            return aimed
        low, high = sim.boxes()
        open_view = sim.pillars.view_open(
            np.arange(self.n),
            sim.eyes()[:, who],
            look_vectors(np.asarray(yaw, dtype=np.float64), np.asarray(pitch, dtype=np.float64)),
            low[:, 1 - who],
            high[:, 1 - who],
        )
        return aimed & open_view

    def _halfway(self, frame: np.ndarray, fresh: np.ndarray) -> np.ndarray:
        """Return a frame halfway between the last decision and now, the angle the short way round."""
        layout = self.brain.layout
        middle = frame.copy()
        if self.previous is None:
            return middle
        keep = ~np.repeat(fresh, 2)
        middle[keep] = 0.5 * (self.previous[keep] + frame[keep])
        turned = wrap_degrees(frame[keep, layout.YAW] - self.previous[keep, layout.YAW])
        middle[keep, layout.YAW] = wrap_degrees(self.previous[keep, layout.YAW] + 0.5 * turned)
        return middle

    def _feed(self, frame: np.ndarray, fresh: np.ndarray) -> np.ndarray:
        """Advance its round counters by one tick and return its network input."""
        judge, layout = self.judge, self.brain.layout
        both = np.repeat(fresh, 2)
        before = frame if self.fed is None else self.fed
        lost = np.maximum(0.0, before[:, layout.HP] - frame[:, layout.HP]) * ~both
        judge.straty = np.where(both, 0.0, judge.straty + lost).astype(np.float32)
        swapped = lost.reshape(-1, 2)[:, ::-1].reshape(-1)
        judge.bilans = np.where(both, 0.0, judge.bilans + swapped - lost).astype(np.float32)
        judge.t_ep = np.where(fresh, 0, np.minimum(judge.t_ep + 1, ROUND_TIME_CAP))
        self.fed = frame.copy()
        return judge.wejscie_sieci(self.stack, frame, fresh)

    def _choose(self, inputs: np.ndarray, calm: np.ndarray, own: np.ndarray, rows: np.ndarray):
        """Sample one network decision and return its choices, actions and one tick of turn."""
        brain, sim, n = self.brain, self.sim, self.n
        torch, features, layout = brain.torch, brain.features, brain.layout
        with torch.no_grad():
            logits = brain.net(torch.as_tensor(inputs[0::2][rows]))[0].float()
            logits[:, brain.slot_start + FIRST_UNUSED_SLOT : brain.slot_start + LAST_SLOT] = -1e9
            logits[torch.as_tensor(sim.ammo[rows, self.seat] <= 0), brain.slot_start + SLOT_BOW] = -1e9
            parts = torch.split(logits, brain.net.glowy, dim=-1)
            picks = [torch.multinomial(torch.softmax(part, -1), 1, generator=self.generator)[:, 0] for part in parts]
        chosen = np.tile(self.still, (n, 1))
        chosen[rows] = torch.stack(picks, 1).numpy()
        doubled = np.tile(self.still, (2 * n, 1))
        doubled[0::2] = chosen
        raw = features.akcje_z_indeksow(doubled)
        turn = np.zeros((n, 2))
        for k, (column, name) in enumerate(((5, "yaw"), (6, "pitch"))):
            want = raw[0::2, column].astype(np.float64)
            want = np.where(np.abs(want) <= np.where(calm, CALM_DEAD_ZONE, 0.0), 0.0, want)
            speed = self.turn_speed[:, k]
            self.turn_speed[:, k] = np.where(
                calm, _smooth(speed, want, *CALM_TURN[name]), _smooth(speed, want, *NORMAL_TURN[name])
            )
            turn[:, k] = self.turn_speed[:, k]
            raw[0::2, column] = self.turn_speed[:, k]
        ahead = own[:, [layout.VOKSELE + cell for cell in OBSTACLE_CELLS]] > 0.5
        raw[0::2, 2] = np.where(calm & ~ahead.any(axis=1), 0.0, raw[0::2, 2])
        return chosen, raw, turn

    def _use_tick(self, down: np.ndarray, active: np.ndarray, can: np.ndarray):
        """Play one client tick of the right button and return who released and who raised."""
        self.click_delay = np.where(active, np.maximum(self.click_delay - 1, 0), self.click_delay)
        released = active & self.holding & ~down
        self.holding = self.holding & ~released
        attempt = active & ~self.holding & down & (self.click_delay == 0)
        self.click_delay = np.where(attempt, RIGHT_CLICK_DELAY, self.click_delay)
        raised = attempt & can
        self.holding = self.holding | raised
        return released, raised

    def act(self, rows: np.ndarray) -> np.ndarray:
        """Play one simulator decision for the given arenas."""
        sim, seat, n = self.sim, self.seat, self.n
        brain = self.brain
        features, layout = brain.features, brain.layout
        ticks = _next_ticks(sim)
        fresh = sim.ticks != self.expected
        self.expected = sim.ticks + ticks
        if fresh.any():
            self.center[fresh] = (sim.pos[fresh, 0][:, [0, 2]] + sim.pos[fresh, 1][:, [0, 2]]) / 2.0
            self.floor[fresh] = sim.pos[fresh, seat, 1]
            self.turn_speed[fresh] = 0.0
            self.click_delay[fresh] = 0
        self._update_exhaustion(fresh)
        drift = sim.pos[:, seat][:, [0, 2]] - self.center
        self.center += np.where(np.abs(drift) > ARENA_ROOM, drift - np.sign(drift) * ARENA_ROOM, 0.0)
        rise = sim.pos[:, seat, 1] - self.floor
        self.floor += np.where(rise > 4.0, rise - 4.0, np.where(rise < -3.0, rise + 3.0, 0.0))

        held = sim.weapon[:, seat]
        ranged = held >= C.BOW
        was_up = (sim.shield_ticks[:, seat] > 0) & ~ranged
        self.holding = was_up.copy()
        may_block = ~ranged & sim.combat.has_shield[:, seat]
        can_first = may_block & (sim.shield_disabled[:, seat] <= 0)
        can_second = may_block & (sim.shield_disabled[:, seat] <= 1)

        frame = self._frame()
        own, enemy = frame[0::2], frame[1::2]
        calm = (own[:, layout.ODL] > CALM_RANGE) | (own[:, layout.WIDZI + 1] < 0.5)
        turn = np.zeros((n, 2))
        none = np.zeros(n, dtype=bool)
        click_first, released_first, raised_first = none, none, none
        slot_first = np.zeros(n, dtype=np.int64)
        if ticks == 2:
            counted = ~fresh
            chosen, raw, step = self._choose(self._feed(self._halfway(frame, fresh), none), calm, own, rows)
            raw[0::2, 9][fresh] = 0.0
            self.turn_speed[fresh] = 0.0
            self.judge.akcje(raw)
            free = ~self.holding
            released_first, raised_first = self._use_tick(self.judge.prawy[0::2] > 0.5, counted, can_first)
            turn += np.where(counted[:, None], step, 0.0)
            aimed = self._on_target(
                own, enemy, own[:, layout.YAW] + turn[:, 0], np.clip(own[:, layout.PITCH] + turn[:, 1], -90.0, 90.0), seat
            )
            click_first = counted & (raw[0::2, 4] > 0.5) & aimed & free
            slot_first = np.where(counted, chosen[:, HEAD_SLOT], 0)

        inputs = self._feed(frame, fresh)
        self.previous = frame
        chosen, raw, step = self._choose(inputs, calm, own, rows)
        self.judge.akcje(raw)
        down = self.judge.prawy[0::2] > 0.5
        free = ~self.holding
        _, raised_second = self._use_tick(down, np.ones(n, dtype=bool), can_second)
        turn += step
        aimed = self._on_target(
            own, enemy, own[:, layout.YAW] + turn[:, 0], np.clip(own[:, layout.PITCH] + turn[:, 1], -90.0, 90.0), seat
        )
        click = click_first | ((raw[0::2, 4] > 0.5) & aimed & free)
        keys = raw[0::2]

        owned = np.zeros(n, dtype=bool)
        owned[rows] = True
        dipped = owned & was_up & released_first & raised_second & ~fresh
        sim.shield_ticks[dipped, seat] = 0
        late_raise = owned & raised_second & ~raised_first & ~fresh & (ticks == 2)
        sim.shield_ticks[late_raise & ~click, seat] = -1
        self.click_delay = np.where(click & self.holding & ~ranged, 0, self.click_delay)

        sim.yaw[rows, seat] = wrap_degrees(sim.yaw[rows, seat] + turn[rows, 0])
        sim.pitch[rows, seat] = np.clip(sim.pitch[rows, seat] + turn[rows, 1], -90.0, 90.0)

        slot = np.where(chosen[:, HEAD_SLOT] > 0, chosen[:, HEAD_SLOT], slot_first)
        weapon = np.select([slot == SLOT_AXE, slot == SLOT_BOW], [C.AXE, C.BOW], held)
        weapon = np.where(fresh, C.AXE, weapon)
        forward = keys[:, 0] > 0.5
        busy = was_up | (sim.draw_ticks[:, seat] > 0) | (sim.load_ticks[:, seat] > 0)
        dropped = self.sprint_sent & ~sim.sprinting[:, seat]
        self.running = forward & ~fresh & ((self.running & ~dropped) | ((keys[:, 3] > 0.5) & ~busy))
        sim.sprint_held[owned & dropped & self.running, seat] = False

        out = A.neutral_actions(weapon[rows])
        out[:, A.FORWARD] = np.select([forward[rows], keys[rows, 0] < -0.5], [A.KEY_FORWARD, A.KEY_BACK], 0)
        out[:, A.STRAFE] = np.select([keys[rows, 1] > 0.5, keys[rows, 1] < -0.5], [A.KEY_LEFT, A.KEY_RIGHT], 0)
        out[:, A.SPRINT] = self.running[rows]
        out[:, A.JUMP] = keys[rows, 2] > 0.5
        out[:, A.SNEAK] = keys[rows, 7] > 0.5
        out[:, A.ATTACK] = np.where(click[rows], A.ATTACK_CLICK, 0)
        use = np.where(ranged, down, self.holding & ~click)
        out[:, A.USE] = use[rows]
        out = fit_to_mask(out, build_masks(sim, seat, rows=rows), A.NVEC)
        self.sprint_sent[:] = False
        self.sprint_sent[rows] = out[:, A.SPRINT] == 1
        self.swung[:] = False
        self.swung[rows] = out[:, A.ATTACK] > 0
        return out


def synth(sim, seat, rng, facts=None, rows=None):
    """SynthSarcasm's trained network, sampling its actions as it does in its own client."""
    if sim.world is not None:
        raise ValueError("the synth opponent plays the flat arena profile only")
    picked = np.arange(sim.n) if rows is None else np.asarray(rows)
    players = _players.setdefault(sim, {})
    if seat not in players:
        players[seat] = SynthPlayer(sim, seat, rng)
    return players[seat].act(picked)
