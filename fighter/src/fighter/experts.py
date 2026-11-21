"""Expert networks that take over a few action heads in their own situation.

An expert acts by narrowing the action masks of the network it helps. Each head
it controls keeps exactly one allowed choice, so the fighter samples that choice
with probability one and adds nothing to its log probability or entropy.

Situations are read only from the inputs a client can see. The takeover lives in
`TakeoverInterface.masks`, the one place the learner, league opponents and
evaluation all get their masks from.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path

import numpy as np

from . import actions as A
from . import constants as C
from .interface import SHARED, Interface
from .obs import ENEMY_IN_SIGHT, OBS_DIM
from .policy import NumpyPolicy
from .stance import StanceRules, apply_stance

TAKEOVER_RANGE = 4.5
RANGE_SCALE = 32.0

OWN_CROSSBOW = 14
OWN_BOW = 15
ENEMY_DISTANCE = 32
ENEMY_CROSSBOW = 50
ENEMY_BOW = 51
ENEMY_SHIELD_RAISED = 53
ENEMY_FACING = 55
ENEMY_USING_RANGED = 57

SHOOTER = "shooter"
BLOCKER = "blocker"
MOB = "mob"
ALL_HEADS = tuple(range(len(A.NVEC)))


class ExpertRejected(ValueError):
    """An expert failed its pass test or does not fit its slot."""


def holds_ranged(obs: np.ndarray) -> np.ndarray:
    """Return where this player holds a bow or crossbow."""
    return (obs[:, OWN_CROSSBOW] > 0.5) | (obs[:, OWN_BOW] > 0.5)


def enemy_ranged(obs: np.ndarray) -> np.ndarray:
    """Return where the enemy holds or is using a bow or crossbow."""
    return (obs[:, ENEMY_CROSSBOW] > 0.5) | (obs[:, ENEMY_BOW] > 0.5) | (obs[:, ENEMY_USING_RANGED] > 0.5)


def enemy_far(obs: np.ndarray) -> np.ndarray:
    """Return where the enemy is at least the takeover range away."""
    return obs[:, ENEMY_DISTANCE] * RANGE_SCALE >= TAKEOVER_RANGE


def shield_facing(obs: np.ndarray) -> np.ndarray:
    """Return where the enemy's raised shield faces this player."""
    return (obs[:, ENEMY_SHIELD_RAISED] > 0.5) & (obs[:, ENEMY_FACING] > 0.0)


def shooter_active(obs: np.ndarray) -> np.ndarray:
    """Return where the shooter controls its heads."""
    return holds_ranged(obs) & enemy_far(obs) & ~shield_facing(obs)


def blocker_active(obs: np.ndarray) -> np.ndarray:
    """Return where the blocker controls its heads."""
    return ~holds_ranged(obs) & enemy_ranged(obs) & enemy_far(obs)


def ranged_in_play(sim, seat: int, rows: np.ndarray) -> np.ndarray:
    """Return arenas where either player holds a ranged weapon, a cheap filter before inputs."""
    return (sim.weapon[rows] >= C.BOW).any(axis=1)


def no_rows(sim, seat: int, rows: np.ndarray) -> np.ndarray:
    """Return no arenas."""
    return np.zeros(len(rows), dtype=bool)


def every_row(sim, seat: int, rows: np.ndarray) -> np.ndarray:
    """Return every arena."""
    return np.ones(len(rows), dtype=bool)


def never(obs: np.ndarray) -> np.ndarray:
    """Return a situation that never holds."""
    return np.zeros(len(obs), dtype=bool)


def input_positive(column: int, obs: np.ndarray) -> np.ndarray:
    """Return where one input column is above zero."""
    return obs[:, column] > 0.0


@dataclass(frozen=True)
class ExpertSpec:
    """One expert slot.

    active: situation test over the expert's inputs.
    candidates: cheap filter of (sim, seat, rows) that may only widen the situation.
    inputs: the interface that builds the expert's inputs.
    claims_when_empty: the situation keeps later slots out even with no expert loaded.
    """

    name: str
    heads: tuple[int, ...]
    active: Callable[[np.ndarray], np.ndarray]
    candidates: Callable = ranged_in_play
    inputs: Interface = SHARED
    claims_when_empty: bool = False


def mob_spec(
    inputs: Interface = SHARED, block: str | None = None, heads: tuple[int, ...] = ALL_HEADS
) -> ExpertSpec:
    """Build the mob slot. Its situation is a positive last input of the named block.

    With no block the slot stays empty and never acts.
    """
    if block is None:
        return ExpertSpec(MOB, heads, never, no_rows, inputs)
    column = inputs.input_slice(block).stop - 1
    return ExpertSpec(MOB, heads, partial(input_positive, column), every_row, inputs, True)


SHOOTER_SPEC = ExpertSpec(SHOOTER, (A.YAW, A.PITCH, A.USE, A.LOCK_AIM), shooter_active)
BLOCKER_SPEC = ExpertSpec(BLOCKER, (A.YAW, A.PITCH, A.USE), blocker_active)
SPECS = (mob_spec(), SHOOTER_SPEC, BLOCKER_SPEC)
EXPERT_NAMES = tuple(spec.name for spec in SPECS)


@dataclass(frozen=True)
class LoadedExpert:
    """A published expert. `locks` holds (head, choice) pairs fixed in its drill."""

    name: str
    version: int
    policy: NumpyPolicy
    locks: tuple[tuple[int, int], ...] = ()
    source: dict = field(default_factory=dict, compare=False)


def weights_digest(policy: NumpyPolicy) -> str:
    """Return a hash of the weights alone, the same for every save of one network."""
    digest = hashlib.sha256(np.asarray(policy.nvec, dtype=np.int64).tobytes())
    for weight, bias in policy.layers:
        digest.update(np.ascontiguousarray(weight, dtype=np.float32).tobytes())
        digest.update(np.ascontiguousarray(bias, dtype=np.float32).tobytes())
    return digest.hexdigest()


def _check_fit(spec: ExpertSpec, expert: LoadedExpert) -> None:
    inputs = expert.policy.layers[0][0].shape[1]
    if inputs != spec.inputs.obs_dim:
        raise ExpertRejected(f"{spec.name} expects {spec.inputs.obs_dim} inputs, network has {inputs}")
    sizes = np.asarray(expert.policy.nvec)
    shared = sizes[: len(A.NVEC)]
    if len(shared) != len(A.NVEC) or not np.array_equal(shared, A.NVEC):
        raise ExpertRejected(f"{spec.name} network does not have the shared action heads")


class ExpertSet:
    """The active experts of one environment. Earlier slots win when situations overlap."""

    def __init__(self, max_ticks: int = 600, specs: tuple[ExpertSpec, ...] = SPECS):
        self.max_ticks = max_ticks
        self.specs = tuple(specs)
        self.by_name = {spec.name: spec for spec in self.specs}
        self.loaded: dict[str, LoadedExpert] = {}

    def install(self, loaded: dict[str, LoadedExpert]) -> None:
        """Replace the active experts all at once, after checking each one fits."""
        for name, expert in loaded.items():
            if name not in self.by_name:
                raise ExpertRejected(f"unknown expert slot {name!r}")
            _check_fit(self.by_name[name], expert)
        self.loaded = dict(loaded)

    def versions(self) -> dict[str, int | None]:
        """Return the active version of every slot."""
        return {
            spec.name: self.loaded[spec.name].version if spec.name in self.loaded else None
            for spec in self.specs
        }

    def _inputs(self, spec: ExpertSpec, sim, seat: int, rows: np.ndarray) -> np.ndarray:
        return np.clip(spec.inputs.observe(sim, seat, self.max_ticks, rows), -5.0, 5.0)

    def situations(self, sim, seat: int, rows: np.ndarray | None = None) -> dict[str, np.ndarray]:
        """Return which slot holds each arena, whether or not its expert is loaded."""
        picked = np.arange(sim.n) if rows is None else np.asarray(rows)
        out: dict[str, np.ndarray] = {}
        taken = np.zeros(len(picked), dtype=bool)
        for spec in self.specs:
            here = np.zeros(len(picked), dtype=bool)
            near = np.flatnonzero(~taken & spec.candidates(sim, seat, picked))
            if len(near):
                here[near[spec.active(self._inputs(spec, sim, seat, picked[near]))]] = True
            taken |= here
            out[spec.name] = here
        return out

    def constrain(self, sim, seat: int, mask: np.ndarray, rows: np.ndarray | None = None) -> np.ndarray:
        """Fix the heads of each active expert in `mask`, which holds one row per picked arena."""
        if not self.loaded:
            return mask
        picked = np.arange(sim.n) if rows is None else np.asarray(rows)
        taken = np.zeros(len(picked), dtype=bool)
        for spec in self.specs:
            expert = self.loaded.get(spec.name)
            if expert is None and not spec.claims_when_empty:
                continue
            near = np.flatnonzero(~taken & spec.candidates(sim, seat, picked))
            if len(near) == 0:
                continue
            inputs = self._inputs(spec, sim, seat, picked[near])
            active = spec.active(inputs)
            here = near[active]
            taken[here] = True
            if expert is not None and len(here):
                self._fix_heads(spec, expert, inputs[active], mask, here)
        return mask

    @staticmethod
    def _fix_heads(
        spec: ExpertSpec, expert: LoadedExpert, inputs: np.ndarray, mask: np.ndarray, here: np.ndarray
    ) -> None:
        offsets = expert.policy.offsets
        sizes = expert.policy.nvec
        allowed = mask[here][:, : int(np.sum(sizes))].copy()
        for head, keep in expert.locks:
            start = offsets[head]
            legal = allowed[:, start + keep]
            allowed[legal, start : start + sizes[head]] = False
            allowed[legal, start + keep] = True
        if A.LOCK_AIM in spec.heads:
            hidden = inputs[:, ENEMY_IN_SIGHT] <= 0.5
            allowed[hidden, offsets[A.LOCK_AIM] + 1] = False
            allowed[hidden, offsets[A.LOCK_AIM]] = True
        chosen = expert.policy.act(inputs, allowed, None, deterministic=True)
        count = np.arange(len(here))
        for head in spec.heads:
            start = int(A.HEAD_OFFSETS[head])
            size = int(A.NVEC[head])
            fixed = np.zeros((len(here), size), dtype=bool)
            fixed[count, chosen[:, head]] = True
            mask[here, start : start + size] = fixed


class TakeoverInterface(Interface):
    """An interface whose masks hand some heads to the active experts."""

    def __init__(self, experts: ExpertSet, inputs=(), heads=(), apply=None, stance: StanceRules | None = None):
        super().__init__(inputs, heads, apply)
        self.experts = experts
        self.stance = stance

    def masks(self, sim, seat, allowed_weapons=None, rows=None) -> np.ndarray:
        """Return the normal masks with expert heads fixed and the scripted rules applied."""
        mask = self.experts.constrain(sim, seat, super().masks(sim, seat, allowed_weapons, rows), rows)
        return mask if self.stance is None else apply_stance(self.stance, sim, seat, mask, rows)


def expert_interface(
    max_ticks: int = 600, specs: tuple[ExpertSpec, ...] = SPECS, stance: StanceRules | None = None
) -> TakeoverInterface:
    """Build the fighter's interface with empty expert slots."""
    return TakeoverInterface(ExpertSet(max_ticks, specs), stance=stance)


def _sync_dir(path: Path) -> None:
    handle = os.open(path, os.O_RDONLY)
    try:
        os.fsync(handle)
    finally:
        os.close(handle)


def write_atomic(path: Path, data: bytes) -> None:
    """Write a file so readers see the old content or the new content, never a part."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    except BaseException:
        if os.path.exists(name):
            os.unlink(name)
        raise
    _sync_dir(path.parent)


class ExpertStore:
    """Published experts on disk. Version folders never change after they appear.

    `CURRENT.json` names the live version, and replacing it is the publish step.
    """

    def __init__(self, root: str | Path):
        self.root = Path(root)

    def _slot(self, name: str) -> Path:
        if name not in EXPERT_NAMES:
            raise ExpertRejected(f"unknown expert slot {name!r}")
        return self.root / name

    def current(self, name: str) -> dict | None:
        """Return the live version record of a slot, or None."""
        pointer = self._slot(name) / "CURRENT.json"
        try:
            return json.loads(pointer.read_text())
        except FileNotFoundError:
            return None

    def load(self, name: str, version: int) -> LoadedExpert:
        """Read one version and verify its weights against the recorded hash."""
        folder = self._slot(name) / f"v{version:04d}"
        meta = json.loads((folder / "meta.json").read_text())
        data = (folder / "policy.npz").read_bytes()
        if hashlib.sha256(data).hexdigest() != meta["sha256"]:
            raise ExpertRejected(f"{name} version {version} does not match its hash")
        policy = NumpyPolicy.load(io.BytesIO(data))
        locks = tuple((int(head), int(keep)) for head, keep in meta["locks"])
        return LoadedExpert(name, int(meta["version"]), policy, locks, meta.get("source", {}))

    def latest(self, name: str) -> LoadedExpert | None:
        """Return the live version of a slot, or None."""
        record = self.current(name)
        return None if record is None else self.load(name, int(record["version"]))

    def _next_version(self, slot: Path) -> int:
        taken = [int(path.name[1:]) for path in slot.glob("v[0-9]*") if path.is_dir()]
        return max(taken, default=0) + 1

    def publish(
        self,
        name: str,
        policy: NumpyPolicy,
        report: dict,
        locks: tuple[tuple[int, int], ...] = (),
        source: dict | None = None,
    ) -> int:
        """Publish an expert whose pass test passed and return its version.

        Publishing the weights that are already live returns the live version.
        """
        if report.get("passed") is not True:
            raise ExpertRejected(f"{name} did not pass its test")
        weights = weights_digest(policy)
        live = self.current(name)
        if live is not None and live.get("weights") == weights:
            return int(live["version"])
        slot = self._slot(name)
        slot.mkdir(parents=True, exist_ok=True)
        for stale in slot.glob(".build-*"):
            shutil.rmtree(stale, ignore_errors=True)
        build = Path(tempfile.mkdtemp(dir=slot, prefix=".build-"))
        try:
            policy.save(build / "policy.npz")
            data = (build / "policy.npz").read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            version = self._next_version(slot)
            meta = {
                "name": name,
                "version": version,
                "sha256": digest,
                "weights": weights,
                "locks": [[int(head), int(keep)] for head, keep in locks],
                "report": report,
                "source": source or {},
            }
            (build / "meta.json").write_text(json.dumps(meta, indent=2))
            for item in build.iterdir():
                with item.open("rb") as handle:
                    os.fsync(handle.fileno())
            _sync_dir(build)
            final = slot / f"v{version:04d}"
            os.rename(build, final)
            _sync_dir(slot)
        except BaseException:
            shutil.rmtree(build, ignore_errors=True)
            raise
        pointer = {"version": version, "sha256": digest, "weights": weights}
        write_atomic(slot / "CURRENT.json", json.dumps(pointer).encode())
        return version


def publish_if_passed(
    store: ExpertStore,
    name: str,
    policy: NumpyPolicy,
    pass_test: Callable[[NumpyPolicy], dict],
    locks: tuple[tuple[int, int], ...] = (),
    source: dict | None = None,
) -> tuple[int | None, dict]:
    """Run the pass test on this exact policy and publish only if it passes."""
    report = pass_test(policy)
    if report.get("passed") is not True:
        return None, report
    return store.publish(name, policy, report, locks, source), report


__all__ = [
    "BLOCKER",
    "EXPERT_NAMES",
    "MOB",
    "OBS_DIM",
    "SHOOTER",
    "SPECS",
    "ExpertRejected",
    "ExpertSet",
    "ExpertSpec",
    "ExpertStore",
    "LoadedExpert",
    "TakeoverInterface",
    "expert_interface",
    "mob_spec",
    "publish_if_passed",
    "weights_digest",
    "write_atomic",
]
