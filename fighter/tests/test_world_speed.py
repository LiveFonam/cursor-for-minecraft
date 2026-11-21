"""Speed gates. Run with `pytest -m speed` on an otherwise quiet machine."""

import pytest

from fighter.world import bench


@pytest.mark.speed
def test_every_world_profile_meets_its_speed_gate():
    results = bench.run(decisions=6000)
    assert results["profiles"]["full"]["passed"], results["profiles"]["full"]
    assert results["profiles"]["surface"]["passed"], results["profiles"]["surface"]
