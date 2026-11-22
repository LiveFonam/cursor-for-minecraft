"""The mob director over a `MobSim`: the server plugin in director/ ported to the simulator.

An invisible agent that turns the mobs of one arena against the player in seat 0.
The simulator's mobs walk straight at the player and sidestep when stuck, so the
director does the pathfinding: it finds a route over the blocks a zombie can walk
on and hands each mob the next waypoint through the steering arrays of `Mobs`.

Tactics, chosen again every half second from the blocks as they are:
  ASSAULT  a route from a zombie to the player exists: mobs walk it and attack
  APPROACH the player is in the open but no mob has a route yet: mobs close in
  BREACH   the player is shut in: one creeper walks to the weakest door, wall or
           roof it can reach, the others hold 8 blocks back, the creeper lights
           its fuse there and the simulator's explosion breaks the blocks. After
           the blast it looks again: a way in means ASSAULT, none means a failed
           breach and a cooldown. Killing the creeper first fails the breach too
  WAIT     shut in and no breach possible: the mobs wait by the way in
Skeletons are never held back from shooting unless they stand near a lit fuse.

It never changes health or blocks itself and never moves a mob except by steering
its walk; damage comes from the mobs' own attacks and the explosion.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

import numpy as np

from . import mobs as MB
from .world import blocks as B

DIRS = ((1, 0), (-1, 0), (0, 1), (0, -1))
NOT_WALKABLE = {B.BLOCK_ID[name] for name in ("lava", "fire", "cobweb") if name in B.BLOCK_ID}
FLOOR_SHAPES = {B.SH_FULL, B.SH_SLAB, B.SH_STAIRS}


class SimGrid:
    """The blocks of one arena, read as a mob would see them."""

    def __init__(self, world, env: int):
        self.world = world
        self.env = env
        self.nx = world.base.nx
        self.nz = world.base.nz

    def cell(self, x: int, y: int, z: int) -> int:
        if not (0 <= x < self.nx and 0 <= z < self.nz and B.Y_MIN <= y <= B.Y_MAX):
            return B.BLOCK_ID["bedrock"]
        return self.world.get(x, y, z, self.env)

    def passable(self, x: int, y: int, z: int) -> bool:
        """A mob's body fits through: air and other open blocks, an open door."""
        cell = self.cell(x, y, z)
        block_id = cell & 0xFF
        if block_id in NOT_WALKABLE:
            return False
        block = B.BLOCKS[block_id]
        if block.shape == B.SH_DOOR:
            return bool((cell >> 8) >> 2 & 1)
        return not block.solid

    def floor(self, x: int, y: int, z: int) -> bool:
        block = B.BLOCKS[self.cell(x, y, z) & 0xFF]
        return block.solid and block.shape in FLOOR_SHAPES

    def blast(self, x: int, y: int, z: int) -> float:
        return float(MB.BLAST_RESISTANCE[self.cell(x, y, z) & 0xFF])

    def gate(self, x: int, y: int, z: int) -> bool:
        return B.BLOCKS[self.cell(x, y, z) & 0xFF].shape == B.SH_DOOR

    def standable(self, x: int, y: int, z: int) -> bool:
        return self.passable(x, y, z) and self.passable(x, y + 1, z) and self.floor(x, y - 1, z)

    def moves(self, x: int, y: int, z: int):
        """The spots a mob reaches in one move: level, a step up of one, a drop of up to three."""
        for dx, dz in DIRS:
            nx, nz = x + dx, z + dz
            if self.standable(nx, y, nz):
                yield nx, y, nz
            elif self.standable(nx, y + 1, nz) and self.passable(x, y + 2, z):
                yield nx, y + 1, nz
            elif self.passable(nx, y, nz) and self.passable(nx, y + 1, nz):
                for k in range(1, 4):
                    if not self.passable(nx, y - k + 1, nz):
                        break
                    if self.standable(nx, y - k, nz):
                        yield nx, y - k, nz
                        break


@dataclass
class Breach:
    kind: str                  # "door", "wall" or "roof"
    block: tuple[int, int, int]
    stand: tuple[int, int, int]
    inside: tuple[int, int, int]
    thickness: int
    blast: float
    out: tuple[int, int, int]

    def __str__(self) -> str:
        x, y, z = self.block
        sx, sy, sz = self.stand
        return f"{self.kind} {self.thickness} thick at {x} {y} {z} (creeper stands at {sx} {sy} {sz})"


@dataclass
class Shelter:
    enclosed: bool
    inside: set = field(default_factory=set)
    breaches: list = field(default_factory=list)
    doors: list = field(default_factory=list)
    why: str = ""


def feet_cell(grid: SimGrid, pos) -> tuple[int, int, int] | None:
    x, y, z = int(np.floor(pos[0])), int(np.floor(pos[1] + 1e-6)), int(np.floor(pos[2]))
    for k in range(3):
        if grid.standable(x, y - k, z):
            return x, y - k, z
    return None


def analyze(grid: SimGrid, pos, radius: int = 12, max_thickness: int = 2, max_blast: float = 6.0) -> Shelter:
    """Is the player shut in, and where could a creeper blast a way in? Same rules as the plugin."""
    start = feet_cell(grid, pos)
    if start is None:
        return Shelter(False, why="the player stands on nothing a mob can walk to")
    px, _, pz = start
    inside = {start}
    queue = deque([start])
    limit = (2 * radius + 1) ** 2 * 6
    while queue:
        c = queue.popleft()
        if max(abs(c[0] - px), abs(c[2] - pz)) > radius:
            return Shelter(False, inside, why=f"a mob can walk in from {radius} blocks out")
        if len(inside) > limit:
            return Shelter(False, inside, why="the space around the player is too big to be a shelter")
        for nxt in grid.moves(*c):
            if nxt not in inside:
                inside.add(nxt)
                queue.append(nxt)
    shelter = Shelter(True, inside)
    by_stand: dict[tuple, Breach] = {}
    for x, y, z in inside:
        for dx, dz in DIRS:
            wx, wz = x + dx, z + dz
            if grid.passable(wx, y, wz) and grid.passable(wx, y + 1, wz):
                continue
            door = grid.gate(wx, y, wz) or grid.gate(wx, y + 1, wz)
            if door and (wx, y, wz) not in shelter.doors:
                shelter.doors.append((wx, y, wz))
            strongest = 0.0
            for t in range(1, max_thickness + 1):
                bx, bz = x + dx * t, z + dz * t
                weak = True
                for dy in (0, 1):
                    if not grid.passable(bx, y + dy, bz):
                        strongest = max(strongest, grid.blast(bx, y + dy, bz))
                        weak &= grid.blast(bx, y + dy, bz) <= max_blast
                if not weak:
                    break
                sx, sz = x + dx * (t + 1), z + dz * (t + 1)
                found = False
                for dy in (0, 1, -1):
                    stand = (sx, y + dy, sz)
                    if grid.standable(*stand) and stand not in inside:
                        b = Breach("door" if door else "wall", (wx, y, wz), stand, (x, y, z), t, strongest, (dx, 0, dz))
                        old = by_stand.get(stand)
                        if old is None or (b.kind == "door" and old.kind != "door") or b.thickness < old.thickness:
                            by_stand[stand] = b
                        found = True
                        break
                if found:
                    break
        if grid.passable(x, y + 2, z):
            continue
        strongest = 0.0
        for t in range(1, max_thickness + 1):
            by = y + 1 + t
            if grid.passable(x, by, z):
                break
            strongest = max(strongest, grid.blast(x, by, z))
            if grid.blast(x, by, z) > max_blast:
                break
            stand = (x, by + 1, z)
            if grid.standable(*stand) and stand not in inside:
                by_stand.setdefault(stand, Breach("roof", (x, y + 2, z), stand, (x, y, z), t, strongest, (0, 1, 0)))
                break
    shelter.breaches = sorted(
        by_stand.values(),
        key=lambda b: (b.kind != "door", b.thickness, b.blast, (b.inside[0] - px) ** 2 + (b.inside[2] - pz) ** 2),
    )
    shelter.why = (f"shut in ({len(inside)} spots), {len(shelter.breaches)} places to blast" if shelter.breaches
                   else f"shut in ({len(inside)} spots), no door, wall or roof thin and weak enough to blast")
    return shelter


def route(grid: SimGrid, start, goal, reach: float = 1.5, box: int = 40, max_nodes: int = 20000):
    """The walk from start to within reach of goal (both cells), as a list of cells, or None."""
    if start is None:
        return None
    gx, gy, gz = goal
    prev = {start: None}
    queue = deque([start])
    while queue and len(prev) < max_nodes:
        c = queue.popleft()
        if abs(c[0] - gx) + abs(c[2] - gz) <= reach and abs(c[1] - gy) <= 1:
            path = []
            while c is not None:
                path.append(c)
                c = prev[c]
            return path[::-1]
        for nxt in grid.moves(*c):
            if nxt in prev or abs(nxt[0] - start[0]) > box or abs(nxt[2] - start[2]) > box:
                continue
            prev[nxt] = c
            queue.append(nxt)
    return None


@dataclass
class DirectorConfig:
    max_active: int = 4
    max_reinforcements: int = 2
    recruit_radius: float = 32.0
    shelter_radius: int = 12
    max_thickness: int = 2
    max_blast: float = 6.0
    cooldown_ticks: int = 600
    breach_timeout_ticks: int = 900
    decide_every: int = 10
    spawn_gap_ticks: int = 160
    hold_back: int = 8


ROLE = {MB.ZOMBIE: "melee", MB.CREEPER: "creeper", MB.SKELETON: "ranged"}


class Director:
    """One encounter in one arena of a MobSim. Call update() once per game tick."""

    def __init__(self, sim, env: int = 0, config: DirectorConfig | None = None):
        self.sim = sim
        self.mobs = sim.mobs
        self.env = env
        self.cfg = config or DirectorConfig()
        self.grid = SimGrid(sim.world, env)
        self.directed: dict[int, str] = {}
        self.state: dict[int, str] = {}
        self.tactic = "STARTING"
        self.reason = "starting"
        self.ticks = 0
        self.stopped = None
        self.reinforcements = 0
        self.last_spawn = -10**9
        self.cooldown_until = 0
        self.last_breach = "none yet"
        self.attempts = 0
        self.breach: Breach | None = None
        self.creeper: int | None = None
        self.ignited = False
        self.blasts_before = 0
        self.check_at: int | None = None
        self.shelter: Shelter | None = None
        self.last_outside = None
        self.history: list[tuple[int, str, str]] = []

    # ---- the loop ----

    def update(self) -> None:
        if self.stopped:
            return
        self.ticks += 1
        if self.sim.hp[self.env, 0] <= 0.0:
            self.stop("the player died")
            return
        self._prune()
        self._recruit()
        if self.breach is not None:
            self._run_breach()
        elif self.check_at is not None:
            if self.ticks >= self.check_at:
                self._after_blast()
        elif self.ticks % self.cfg.decide_every == 1:
            self._decide()
        if self.ticks % self.cfg.decide_every == 1 and not self.stopped:
            self._steer_all()

    def stop(self, why: str) -> None:
        """End the encounter and give every mob back to its own rules."""
        for slot in self.directed:
            self._free(slot)
        self.directed.clear()
        self.tactic = "STOPPED"
        self.stopped = why
        self.reason = why

    # ---- mobs ----

    def _prune(self) -> None:
        for slot in list(self.directed):
            if not self.mobs.alive[self.env, slot]:
                self.directed.pop(slot)
                self.state.pop(slot, None)
                if slot == self.creeper and self.breach is not None:
                    self._creeper_gone()

    def _recruit(self) -> None:
        if len(self.directed) >= self.cfg.max_active:
            return
        player = self.sim.pos[self.env, 0]
        alive = np.flatnonzero(self.mobs.alive[self.env])
        near = sorted(
            (int(s) for s in alive if int(s) not in self.directed and int(self.mobs.kind[self.env, s]) in ROLE),
            key=lambda s: float(np.linalg.norm(self.mobs.pos[self.env, s] - player)),
        )
        for slot in near:
            if len(self.directed) >= self.cfg.max_active:
                break
            if np.linalg.norm(self.mobs.pos[self.env, slot] - player) <= self.cfg.recruit_radius:
                self.directed[slot] = ROLE[int(self.mobs.kind[self.env, slot])]
                self.state[slot] = "joined"

    def _free(self, slot: int) -> None:
        self.mobs.steer_on[self.env, slot] = False
        self.mobs.steer_hold[self.env, slot] = False

    def _of(self, role: str) -> list[int]:
        return [s for s, r in self.directed.items() if r == role and self.mobs.alive[self.env, s]]

    def _cell_of(self, slot: int):
        return feet_cell(self.grid, self.mobs.pos[self.env, slot])

    def _player_cell(self):
        return feet_cell(self.grid, self.sim.pos[self.env, 0])

    # ---- choosing ----

    def _set(self, tactic: str, why: str) -> None:
        if tactic != self.tactic:
            self.history.append((self.ticks, tactic, why))
        self.tactic = tactic
        self.reason = why

    def _decide(self) -> None:
        player = self._player_cell()
        shelter = analyze(self.grid, self.sim.pos[self.env, 0], self.cfg.shelter_radius, self.cfg.max_thickness, self.cfg.max_blast)
        self.shelter = shelter
        if not shelter.enclosed:
            self.last_outside = player
        melee = self._of("melee")
        if not melee and not self._of("creeper") and self._spawn(MB.ZOMBIE, shelter):
            return
        for slot in melee:
            path = route(self.grid, self._cell_of(slot), player) if player else None
            if path:
                self._set("ASSAULT", f"zombie in slot {slot} has an open route to the player ({len(path)} steps)")
                return
        if not shelter.enclosed:
            self._set("APPROACH", f"the player is in the open ({shelter.why}) but no zombie has a route yet, closing in")
            return
        shut = f"the player is shut in ({len(shelter.inside)} spots"
        shut += f", door at {' '.join(map(str, shelter.doors[0]))} closed)" if shelter.doors else ")"
        shut += ", no zombie route"
        if self.ticks < self.cooldown_until:
            left = (self.cooldown_until - self.ticks + 19) // 20
            self._set("WAIT", f"{shut}; waiting by the way in, {left} s cooldown after: {self.last_breach}")
            return
        if not self.mobs.cfg.griefing:
            self._set("WAIT", f"{shut}; mob griefing is off, so a blast breaks no blocks")
            return
        if not shelter.breaches:
            self._set("WAIT", f"{shut}; {shelter.why}")
            return
        creepers = [s for s in self._of("creeper") if not self.mobs.lit[self.env, s]]
        if not creepers:
            if self._spawn(MB.CREEPER, shelter):
                self._set("WAIT", f"{shut}; no creeper near, calling one in")
            else:
                self._set("WAIT", f"{shut}; no creeper to blast with")
            return
        for slot in creepers:
            for breach in shelter.breaches[:8]:
                path = route(self.grid, self._cell_of(slot), breach.stand, reach=0)
                if path:
                    self._start_breach(slot, breach, path, shut)
                    return
        self._set("WAIT", f"{shut}; the creeper can reach none of the {len(shelter.breaches)} places to blast (best: {shelter.breaches[0]})")

    # ---- the breach ----

    def _start_breach(self, slot: int, breach: Breach, path, shut: str) -> None:
        self.breach = breach
        self.creeper = slot
        self.ignited = False
        self.started = self.ticks
        self.blasts_before = int(self.mobs.blasts[self.env])
        self.attempts += 1
        self.state[slot] = "walking to the breach"
        self._set("BREACH", f"{shut}; weakest way in it can reach: {breach}, the creeper walks there ({len(path)} steps), the others hold {self.cfg.hold_back} blocks back")

    def _run_breach(self) -> None:
        slot = self.creeper
        mobs, env = self.mobs, self.env
        if not mobs.alive[env, slot]:
            self._creeper_gone()
            return
        sx, sy, sz = self.breach.stand
        here = mobs.pos[env, slot]
        flat = float(np.hypot(here[0] - (sx + 0.5), here[2] - (sz + 0.5)))
        if self.ignited:
            return
        if flat <= 0.6 and abs(here[1] - sy) < 1.0:
            mobs.steer_on[env, slot] = False
            mobs.steer_hold[env, slot] = True
            mobs.ignite(env, slot)
            self.ignited = True
            self.state[slot] = "fuse lit at the breach"
            self.reason = f"the creeper lit its fuse at the {self.breach}; the others hold back"
            return
        if self.ticks % 5 == 0:
            self._walk(slot, self.breach.stand, reach=0)
        if self.ticks - self.started > self.cfg.breach_timeout_ticks:
            self._fail(f"the creeper could not get to the breach in {self.cfg.breach_timeout_ticks // 20} s")

    def _creeper_gone(self) -> None:
        if int(self.mobs.blasts[self.env]) > self.blasts_before:
            self.blast_at = str(self.breach)
            self.breach = None
            self.creeper = None
            self.check_at = self.ticks + 10
        else:
            self._fail("the creeper was killed before it went off")

    def _after_blast(self) -> None:
        self.check_at = None
        where = self.blast_at
        shelter = analyze(self.grid, self.sim.pos[self.env, 0], self.cfg.shelter_radius, self.cfg.max_thickness, self.cfg.max_blast)
        self.shelter = shelter
        player = self._player_cell()
        path = next((p for p in (route(self.grid, self._cell_of(s), player) for s in self._of("melee")) if p), None) if player else None
        if path or not shelter.enclosed:
            self.last_breach = f"opened: the blast at {where} made a way in"
            self._set("ASSAULT", f"the blast at {where} opened a way in")
        else:
            self._fail(f"the blast at {where} left no way in ({shelter.why})")

    def _fail(self, why: str) -> None:
        self.last_breach = f"failed: {why}"
        self.breach = None
        self.creeper = None
        self.ignited = False
        self.cooldown_until = self.ticks + self.cfg.cooldown_ticks
        self._set("WAIT", f"breach failed: {why}; next try in {self.cfg.cooldown_ticks // 20} s")

    # ---- steering ----

    def _walk(self, slot: int, goal, reach: float = 1.5) -> bool:
        """Steer one mob a few cells along its route to goal. False when there is no route."""
        path = route(self.grid, self._cell_of(slot), goal, reach=reach)
        mobs, env = self.mobs, self.env
        if not path:
            mobs.steer_on[env, slot] = False
            return False
        step = path[min(2, len(path) - 1)]
        mobs.steer_to[env, slot] = (step[0] + 0.5, step[1], step[2] + 0.5)
        mobs.steer_on[env, slot] = True
        return True

    def _hold_point(self):
        if self.breach is not None:
            sx, sy, sz = self.breach.stand
            dx, _, dz = self.breach.out if self.breach.out[1] == 0 else (1, 0, 0)
            want = (sx + dx * self.cfg.hold_back, sy, sz + dz * self.cfg.hold_back)
        elif self.shelter and self.shelter.doors:
            door = next((b for b in self.shelter.breaches if b.kind == "door"), None)
            if door is None:
                return self.last_outside
            want = (door.stand[0] + door.out[0] * 3, door.stand[1], door.stand[2] + door.out[2] * 3)
        else:
            return self.last_outside
        inside = self.shelter.inside if self.shelter else set()
        for r in range(5):
            for dx in range(-r, r + 1):
                for dz in range(-r, r + 1):
                    if max(abs(dx), abs(dz)) != r:
                        continue
                    for dy in (0, 1, -1, 2, -2):
                        c = (want[0] + dx, want[1] + dy, want[2] + dz)
                        if self.grid.standable(*c) and c not in inside:
                            return c
        return None

    def _steer_all(self) -> None:
        mobs, env = self.mobs, self.env
        player = self._player_cell()
        attack = self.tactic in ("ASSAULT", "APPROACH")
        hold = None if attack else self._hold_point()
        for slot, role in self.directed.items():
            if slot == self.creeper and self.breach is not None:
                continue
            if role == "ranged" and (self.breach is None or np.linalg.norm(mobs.pos[env, slot] - np.add(self.breach.stand, 0.5)) >= 8):
                self._free(slot)
                self.state[slot] = "shooting when it sees the player"
                continue
            if attack:
                mobs.steer_hold[env, slot] = False
                near = np.linalg.norm(mobs.pos[env, slot] - self.sim.pos[env, 0]) < 3.0
                if near or not player or not self._walk(slot, player):
                    # close enough for its own attack, or nothing better to do than its own walk
                    mobs.steer_on[env, slot] = False
                    mobs.targeting[env, slot] = True
                    mobs.goal_on[env, slot] = role != "ranged"
                self.state[slot] = "attacking" if self.tactic == "ASSAULT" else "closing in"
                continue
            mobs.steer_hold[env, slot] = True
            if hold is None:
                mobs.steer_on[env, slot] = False
                self.state[slot] = "waiting"
                continue
            self.state[slot] = "holding back from the blast" if self.breach is not None else "waiting by the way in"
            here = self._cell_of(slot)
            if here and abs(here[0] - hold[0]) + abs(here[2] - hold[2]) <= 2:
                mobs.steer_on[env, slot] = False
            else:
                self._walk(slot, hold)

    # ---- reinforcements ----

    def _spawn(self, kind: int, shelter: Shelter) -> bool:
        """One more mob, out of the player's view and outside their shelter, if the encounter may."""
        if (self.stopped or self.reinforcements >= self.cfg.max_reinforcements or len(self.directed) >= self.cfg.max_active
                or self.ticks - self.last_spawn < self.cfg.spawn_gap_ticks):
            return False
        free = np.flatnonzero(~self.mobs.alive[self.env])
        if not len(free):
            return False
        player = self.sim.pos[self.env, 0]
        yaw = np.radians(self.sim.yaw[self.env, 0])
        look = np.array([-np.sin(yaw), np.cos(yaw)])
        rng = self.sim.rng
        for _ in range(80):
            angle = rng.uniform(0.0, 2.0 * np.pi)
            dist = rng.uniform(10.0, 18.0)
            x, z = int(np.floor(player[0] + np.cos(angle) * dist)), int(np.floor(player[2] + np.sin(angle) * dist))
            for y in range(int(player[1]) + 4, int(player[1]) - 6, -1):
                if not self.grid.standable(x, y, z):
                    continue
                if (x, y, z) in shelter.inside:
                    break
                to = np.array([x + 0.5 - player[0], z + 0.5 - player[2]])
                seen = np.dot(to, look) / max(np.linalg.norm(to), 1e-6) > np.cos(np.radians(70))
                if seen and not shelter.enclosed:
                    break
                slot = int(free[0])
                self.mobs.spawn(self.env, slot, kind, x + 0.5, float(y), z + 0.5)
                self.reinforcements += 1
                self.last_spawn = self.ticks
                self.directed[slot] = ROLE[kind]
                self.state[slot] = "called in"
                return True
        return False

    # ---- status ----

    def status(self) -> str:
        mobs = ", ".join(f"{MB.KIND_NAMES[int(self.mobs.kind[self.env, s])]}#{s} {self.state.get(s, '')}" for s in self.directed)
        return (f"tactic {self.tactic}: {self.reason} | mobs {len(self.directed)}/{self.cfg.max_active}: {mobs}"
                f" | reinforcements {self.reinforcements}/{self.cfg.max_reinforcements} | last breach: {self.last_breach}")
