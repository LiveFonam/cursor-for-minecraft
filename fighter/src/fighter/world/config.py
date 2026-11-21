"""World feature flags and the named profiles built from them.

Every profile runs the same physics code. A flag only removes work.
"""

from __future__ import annotations

from dataclasses import dataclass

FEATURE_FLUIDS = 1
FEATURE_FIRE = 2
FEATURE_DEPTH = 4
FEATURE_TREES = 8

BAND_BELOW = 8
BAND_ABOVE = 40


@dataclass(frozen=True)
class WorldConfig:
    """Switches for the optional parts of a world.

    fluids: water and lava, with their tick queue, rivers and pools.
    fire: fire blocks and their ticks.
    depth: caves, ores, deepslate and everything below the surface band.
    trees: the light forest.
    """

    fluids: bool = True
    fire: bool = True
    depth: bool = True
    trees: bool = True

    @property
    def features(self) -> int:
        """Return the flags as a bit mask."""
        return (
            FEATURE_FLUIDS * self.fluids
            | FEATURE_FIRE * self.fire
            | FEATURE_DEPTH * self.depth
            | FEATURE_TREES * self.trees
        )


FULL = WorldConfig()
SURFACE = WorldConfig(fluids=False, fire=False, depth=False, trees=True)

# The arena profile is a flat fight and has no world object.
PROFILES: dict[str, WorldConfig | None] = {"arena": None, "surface": SURFACE, "full": FULL}

# Side length in blocks of a generated world for each profile.
WORLD_SIZES: dict[str, int] = {"surface": 128, "full": 64}


def profile(name: str) -> WorldConfig | None:
    """Return the config of a named profile, or None for the flat arena."""
    if name not in PROFILES:
        raise ValueError(f"unknown world profile {name!r}, expected one of {sorted(PROFILES)}")
    return PROFILES[name]
