"""Named training setups: stages, reward weights and scripted rules."""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from . import constants as C
from .combat import CHARGE_GATE
from .opponents import LEAGUE, SCRIPTED
from .stance import StanceRules
from .train import AXE_ONLY, CURRICULUM, Stage

AXE_CROSSBOW = (C.AXE, C.CROSSBOW)
FOUNDATION_REWARD = {"weak_swing": 0.002, "exact_miss": True}
COMBO_REWARD = {**FOUNDATION_REWARD, "followup": 1.5, "followup_unfaded": True, "crit": 0.15}


@dataclass(frozen=True)
class Plan:
    """stages, reward overrides, scripted rules, charge input gate and adaptive final mix."""

    stages: tuple[Stage, ...]
    reward: dict = field(default_factory=dict)
    stance: StanceRules | None = None
    ready_gate: float = C.FULL_CHARGE_THRESHOLD
    adaptive: bool = False


FOUNDATION_STAGES = tuple(
    replace(stage, weapons=AXE_ONLY if stage.weapons == AXE_ONLY else AXE_CROSSBOW) for stage in CURRICULUM
)
COMBO_STAGES = (
    Stage("targets", {"idle": 1.0, "random": 1.0}, 0.0, 20_000, 1.0, AXE_ONLY, {"random": 0.85}),
    Stage(
        "chasers",
        {"walker": 1.0, "swinger": 1.0, "random": 1.0},
        0.0,
        60_000,
        1.0,
        AXE_ONLY,
        {"walker": 0.85, "swinger": 0.60},
    ),
    Stage(
        "crits",
        {"critter": 1.0, "strafer": 1.0, "swinger": 1.0},
        0.0,
        150_000,
        0.8,
        AXE_ONLY,
        {"critter": 0.50, "strafer": 0.60},
    ),
    Stage(
        "shield_break",
        {"shielder": 2.0, "axeman": 1.0, "walker": 0.5},
        0.0,
        300_000,
        0.6,
        AXE_CROSSBOW,
        {"shielder": 0.40, "axeman": 0.40},
    ),
    Stage(
        "range",
        {"retreater": 1.0, "archer": 1.0, "hit_and_run": 1.0, "rusher": 1.0},
        0.0,
        300_000,
        0.6,
        AXE_CROSSBOW,
        {"retreater": 0.45, "archer": 0.45, "hit_and_run": 0.45, "rusher": 0.45},
    ),
    Stage(
        "league",
        {LEAGUE: 3.0, **{name: 1.0 for name in SCRIPTED if name != "idle"}},
        2.0,
        0,
        0.4,
        AXE_CROSSBOW,
    ),
)
PLANS = {
    "melee": Plan(tuple(CURRICULUM)),
    "foundations": Plan(FOUNDATION_STAGES, FOUNDATION_REWARD, StanceRules(), CHARGE_GATE),
    "combo": Plan(COMBO_STAGES, COMBO_REWARD, StanceRules(followup=True), CHARGE_GATE, True),
}
