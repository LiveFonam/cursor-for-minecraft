"""Frozen fighters from other runs, played as opponents in the league.

A rival keeps the rules it trained under: its own experts, scripted stance, charge
input gate and weapons. Only its weights and experts are held in memory, so a full
league of rivals costs a few megabytes per simulator process.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import actions as A
from . import constants as C
from .experts import ExpertRejected, ExpertStore, LoadedExpert, TakeoverInterface, expert_interface
from .obs import OBS_DIM
from .opponents import MAX_RIVALS
from .plans import PLANS
from .policy import NumpyPolicy
from .stance import StanceRules

FIGHTER_FOLDER = "fighter"


@contextmanager
def ready_gate(sim, gate: float):
    """Read the charge input with another fighter's gate for the length of the block."""
    saved = sim.cfg.ready_gate
    sim.cfg.ready_gate = gate
    try:
        yield
    finally:
        sim.cfg.ready_gate = saved


@dataclass
class Rival:
    """A frozen policy with the rules it trained under."""

    name: str
    policy: NumpyPolicy
    experts: dict[str, LoadedExpert] = field(default_factory=dict)
    stance: StanceRules | None = None
    gate: float = C.FULL_CHARGE_THRESHOLD
    weapons: tuple[int, ...] | None = None
    max_ticks: int = 600
    plan: str = "melee"

    def __post_init__(self) -> None:
        self._interface: TakeoverInterface | None = None
        self._allowed: np.ndarray | None = None

    def __getstate__(self) -> dict:
        state = dict(self.__dict__)
        state["_interface"] = None
        state["_allowed"] = None
        return state

    def interface(self) -> TakeoverInterface:
        """Return this rival's inputs and masks, with its own experts loaded."""
        if self._interface is None:
            self._interface = expert_interface(self.max_ticks, stance=self.stance)
            self._interface.experts.install(self.experts)
        return self._interface

    def allowed(self, n: int) -> np.ndarray | None:
        """Return the weapons this rival may select in every arena."""
        if self.weapons is None:
            return None
        if self._allowed is None or len(self._allowed) != n:
            self._allowed = np.zeros((n, C.NUM_WEAPONS), dtype=bool)
            self._allowed[:, list(self.weapons)] = True
        return self._allowed

    def act(self, sim, seat: int, rows: np.ndarray, rng: np.random.Generator) -> np.ndarray:
        """Return the shared action heads of this rival for the selected arenas."""
        interface = self.interface()
        with ready_gate(sim, self.gate):
            obs = np.clip(interface.observe(sim, seat, self.max_ticks, rows), -5.0, 5.0)
            masks = interface.masks(sim, seat, self.allowed(sim.n), rows=rows)
        return self.policy.act(obs, masks, rng)[:, : len(A.NVEC)]

    def megabytes(self) -> float:
        """Return the size of the weights this rival keeps in memory."""
        nets = [self.policy] + [expert.policy for expert in self.experts.values()]
        return sum(w.nbytes + b.nbytes for net in nets for w, b in net.layers) / 1024**2


def _check_shape(policy: NumpyPolicy, where: Path) -> None:
    inputs = policy.layers[0][0].shape[1]
    if inputs != OBS_DIM or not np.array_equal(policy.nvec, A.NVEC):
        raise ExpertRejected(f"{where} does not have {OBS_DIM} inputs and the shared action heads")


def farm_confirmed(root: Path) -> bool:
    """Return whether the farming watcher of a run confirmed a farm or stopped working."""
    try:
        status = json.loads((Path(root) / FIGHTER_FOLDER / "status.json").read_text())
    except (OSError, ValueError):
        return False
    farm = status.get("farm") or {}
    return farm.get("confirmed") is not None or bool(farm.get("watch_error"))


def load_rival(root: str | Path, name: str | None = None) -> Rival:
    """Load the latest clean policy of a run folder without writing anything there."""
    root = Path(root)
    config = json.loads((root / "campaign.json").read_text())
    if farm_confirmed(root):
        raise ExpertRejected(f"{root} has a confirmed reward farm")
    folder = root / FIGHTER_FOLDER
    meta = json.loads((folder / "policy.json").read_text())
    policy = NumpyPolicy.load(folder / "policy.npz")
    _check_shape(policy, root)
    store = ExpertStore(root / "experts")
    experts = {}
    for slot, version in (meta.get("experts") or {}).items():
        if version is None:
            continue
        expert = store.load(slot, int(version))
        if expert.source.get("campaign") != config["id"]:
            raise ExpertRejected(f"{slot} version {version} in {root} was published by another campaign")
        experts[slot] = expert
    plan_name = config.get("plan", "melee")
    plan = PLANS[plan_name]
    return Rival(
        name or root.name,
        policy,
        experts,
        plan.stance,
        plan.ready_gate,
        plan.stages[-1].weapons,
        plan=plan_name,
    )


def load_rivals(roots, skip: str | Path | None = None, log=None) -> list[Rival]:
    """Load up to the league limit of rivals, leaving out unreadable or farmed runs."""
    out: list[Rival] = []
    seen: set[str] = set()
    own = None if skip is None else Path(skip).resolve()
    for root in roots:
        path = Path(root)
        if path.resolve() == own or len(out) == MAX_RIVALS:
            continue
        name = path.name if path.name not in seen else f"{path.parent.name}-{path.name}"
        try:
            out.append(load_rival(path, name))
            seen.add(name)
        except (OSError, ValueError, KeyError) as error:
            if log is not None:
                log("rival skipped", 0, rival=str(path), error=repr(error))
    return out
