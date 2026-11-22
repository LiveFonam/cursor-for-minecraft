"""The open source bot ports and the trained network opponent."""

from __future__ import annotations

import gc
import importlib
import os
import pickle
import sys
import weakref
from types import SimpleNamespace

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter import synth_bot
from fighter.obs import build_masks, view_angles
from fighter.opponents import HARD_SCRIPTED, OPEN_SOURCE_BOTS, SCRIPTED, OpponentPool
from fighter.plans import PLANS, arena_stage
from fighter.sim import Sim, SimConfig

PORTS = tuple(name for name in ("mineflayer_pvp", "custom_pvp", "sweat_sword") if name in SCRIPTED)
needs_custom = pytest.mark.skipif("custom_pvp" not in SCRIPTED, reason="the optional local opponent is not installed")


def face_off(distance: float, n: int = 1, armor: str = "diamond", seed: int = 1) -> Sim:
    """Return an arena with the two players standing at a distance, looking at each other."""
    sim = Sim(n, SimConfig(armor=armor), seed=seed)
    sim.pos[:, 0] = [0.5, 0.0, 0.5]
    sim.pos[:, 1] = [0.5, 0.0, 0.5 + distance]
    sim.yaw[:, 0], sim.pitch[:, 0] = view_angles(sim.pos[0, 1] - sim.pos[0, 0])
    sim.yaw[:, 1], sim.pitch[:, 1] = view_angles(sim.pos[0, 0] - sim.pos[0, 1])
    sim.perception.reset(np.arange(n))
    return sim


def still(sim: Sim, use: bool = False) -> np.ndarray:
    action = A.neutral_actions(sim.weapon[:, 0].copy())
    action[:, A.USE] = use
    return action


def swing_ticks(sim: Sim, name: str, decisions: int, seed: int = 3, use: bool = False, hold: bool = True):
    """Play a bot against a player who stands still and return the ticks it swung on."""
    rng = np.random.default_rng(seed)
    ticks = []
    start = sim.pos[:, 0].copy()
    for _ in range(decisions):
        chosen = SCRIPTED[name](sim, 1, rng)
        now = int(sim.ticks[0])
        events = sim.step(np.stack([still(sim, use), chosen], axis=1))
        if events["swings"][0, 1] > 0:
            ticks.append(now)
        sim.hp[:] = C.MAX_HEALTH
        if hold:
            sim.pos[:, 0] = start
            sim.vel[:, 0] = 0.0
    return ticks


def test_the_bots_are_registered_but_stay_out_of_training():
    assert set(OPEN_SOURCE_BOTS) == {*PORTS, "synth"}
    assert set(OPEN_SOURCE_BOTS) <= set(SCRIPTED)
    assert not set(OPEN_SOURCE_BOTS) & set(HARD_SCRIPTED)
    for name, plan in PLANS.items():
        if name == "combo_walls":
            assert set(OPEN_SOURCE_BOTS) <= set(arena_stage(name).mix)
            continue
        for stage in (*plan.stages, arena_stage(name)):
            assert not set(OPEN_SOURCE_BOTS) & set(stage.mix)


@pytest.mark.parametrize("name", PORTS)
def test_ports_only_use_actions_the_learner_could_choose(name):
    sim = Sim(16, SimConfig(armor="diamond", arena_half=10.0), seed=5)
    rng, other = np.random.default_rng(5), np.random.default_rng(6)
    for _ in range(200):
        masks = build_masks(sim, 1)
        chosen = SCRIPTED[name](sim, 1, rng)
        for head, start in enumerate(A.HEAD_OFFSETS):
            assert masks[np.arange(16), start + chosen[:, head]].all()
        sim.step(np.stack([SCRIPTED["swinger"](sim, 0, other), chosen], axis=1))
        done = (sim.hp <= 0.0).any(axis=1)
        if done.any():
            sim.reset(done)
    assert np.isfinite(sim.yaw).all() and np.isfinite(sim.pitch).all() and np.isfinite(sim.pos).all()


@pytest.mark.parametrize("name", PORTS)
def test_ports_change_only_the_arenas_they_own(name):
    sim = Sim(6, SimConfig(), seed=4)
    yaw, pitch = sim.yaw.copy(), sim.pitch.copy()
    rows = np.array([1, 4])
    out = SCRIPTED[name](sim, 1, np.random.default_rng(0), None, rows)
    assert out.shape == (2, len(A.NVEC))
    others = np.setdiff1d(np.arange(6), rows)
    np.testing.assert_array_equal(sim.yaw[others], yaw[others])
    np.testing.assert_array_equal(sim.pitch[others], pitch[others])
    np.testing.assert_array_equal(sim.yaw[:, 0], yaw[:, 0])


@pytest.mark.parametrize("name", PORTS)
def test_ports_forget_a_finished_round(name):
    used = face_off(2.4, n=2)
    rng = np.random.default_rng(1)
    for _ in range(60):
        used.step(np.stack([still(used), SCRIPTED[name](used, 1, rng)], axis=1))
    used.reset()
    new = face_off(2.4, n=2)
    for field in ("pos", "yaw", "pitch"):
        getattr(used, field)[:] = getattr(new, field)
    used.perception.reset(np.arange(2))
    np.testing.assert_array_equal(
        SCRIPTED[name](used, 1, np.random.default_rng(9)), SCRIPTED[name](new, 1, np.random.default_rng(9))
    )


@pytest.mark.parametrize("name", PORTS)
def test_ports_steer_from_what_the_seat_knows(name, monkeypatch):
    first = face_off(7.0, n=2)
    second = face_off(7.0, n=2)
    known = first.pos[:, 0].copy()
    second.pos[:, 0, 0] += 3.0
    for sim in (first, second):
        monkeypatch.setattr(sim.perception, "known_position", lambda seat, at: known[at])
    one = SCRIPTED[name](first, 1, np.random.default_rng(1))
    two = SCRIPTED[name](second, 1, np.random.default_rng(1))
    np.testing.assert_array_equal(one[:, A.FORWARD], two[:, A.FORWARD])
    np.testing.assert_allclose(first.yaw[:, 1], second.yaw[:, 1])


@pytest.mark.parametrize("name", PORTS)
def test_ports_land_swings_on_a_target_in_reach(name):
    sim = face_off(2.4, armor="none")
    start = sim.pos[:, 0].copy()
    rng = np.random.default_rng(2)
    landed = 0.0
    for _ in range(120):
        chosen = SCRIPTED[name](sim, 1, rng)
        landed += sim.step(np.stack([still(sim), chosen], axis=1))["hits"][0, 1]
        sim.hp[:] = C.MAX_HEALTH
        sim.pos[:, 0] = start
        sim.vel[:, 0] = 0.0
    assert landed >= 5


@pytest.mark.parametrize("name", PORTS)
def test_ports_survive_a_checkpoint(name):
    sim = face_off(2.4, n=2)
    rng = np.random.default_rng(1)
    for _ in range(20):
        sim.step(np.stack([still(sim), SCRIPTED[name](sim, 1, rng)], axis=1))
    copy = pickle.loads(pickle.dumps(sim))
    np.testing.assert_array_equal(
        SCRIPTED[name](sim, 1, np.random.default_rng(4)), SCRIPTED[name](copy, 1, np.random.default_rng(4))
    )


def test_mineflayer_swings_on_its_jittered_timer():
    sim = face_off(2.2)
    ticks = swing_ticks(sim, "mineflayer_pvp", 400)
    gaps = np.diff(ticks)
    assert len(gaps) > 20
    assert gaps.min() >= 14 and gaps.max() <= 20
    assert len(set(gaps.tolist())) > 1


def test_mineflayer_lowers_its_shield_to_swing_and_raises_it_after():
    sim = face_off(2.2)
    rng = np.random.default_rng(3)
    raised = 0
    for _ in range(200):
        chosen = SCRIPTED["mineflayer_pvp"](sim, 1, rng)
        if chosen[0, A.ATTACK] > 0:
            assert chosen[0, A.USE] == 0
        raised += int(chosen[0, A.USE])
        sim.step(np.stack([still(sim), chosen], axis=1))
        sim.hp[:] = C.MAX_HEALTH
    assert raised > 50


def test_mineflayer_waits_for_range():
    sim = face_off(9.0)
    rng = np.random.default_rng(1)
    for _ in range(100):
        chosen = SCRIPTED["mineflayer_pvp"](sim, 1, rng)
        distance = np.linalg.norm(sim.pos[0, 1] - sim.pos[0, 0])
        if chosen[0, A.ATTACK] > 0:
            assert distance <= C.ATTACK_REACH + 0.6
            return
        sim.step(np.stack([still(sim), chosen], axis=1))
    pytest.fail("it never reached the target")


@needs_custom
def test_custom_keeps_the_sword_timer():
    sim = face_off(2.6)
    gaps = np.diff(swing_ticks(sim, "custom_pvp", 300))
    assert len(gaps) > 15
    assert np.median(gaps) == 12


@needs_custom
def test_custom_uses_the_axe_to_disable_a_raised_shield():
    sim = face_off(2.6)
    rng = np.random.default_rng(1)
    for _ in range(80):
        chosen = SCRIPTED["custom_pvp"](sim, 1, rng)
        guard = still(sim, use=sim.shield_disabled[0, 0] == 0)
        events = sim.step(np.stack([guard, chosen], axis=1))
        if events["shield_breaks"][0, 1] > 0:
            assert sim.weapon[0, 1] == C.AXE
            break
        sim.hp[:] = C.MAX_HEALTH
    else:
        pytest.fail("the shield was never disabled")
    for _ in range(40):
        chosen = SCRIPTED["custom_pvp"](sim, 1, rng)
        sim.step(np.stack([still(sim), chosen], axis=1))
        sim.hp[:] = C.MAX_HEALTH
    assert sim.weapon[0, 1] == C.SWORD


def test_sweat_swings_about_every_13_ticks_with_the_sword_only():
    sim = face_off(2.4)
    rng = np.random.default_rng(1)
    ticks = []
    for _ in range(400):
        chosen = SCRIPTED["sweat_sword"](sim, 1, rng)
        assert chosen[0, A.USE] == 0
        assert A.WEAPON_CHOICES[chosen[0, A.WEAPON]] == C.SWORD
        now = int(sim.ticks[0])
        if sim.step(np.stack([still(sim), chosen], axis=1))["swings"][0, 1] > 0:
            ticks.append(now)
        sim.hp[:] = C.MAX_HEALTH
    gaps = np.diff(ticks)
    assert gaps.min() >= 12
    assert 12.5 <= gaps.mean() <= 15.0


def test_sweat_lands_falling_crits():
    sim = face_off(2.4)
    rng = np.random.default_rng(1)
    crits = 0.0
    for _ in range(300):
        chosen = SCRIPTED["sweat_sword"](sim, 1, rng)
        crits += sim.step(np.stack([still(sim), chosen], axis=1))["crits"][0, 1]
        sim.hp[:] = C.MAX_HEALTH
    assert crits >= 3


def test_a_whiff_cannot_land():
    sim = face_off(2.4, armor="none")
    rng = np.random.default_rng(0)
    swings = hits = 0.0
    for _ in range(600):
        chosen = SCRIPTED["sweat_sword"](sim, 1, rng)
        events = sim.step(np.stack([still(sim), chosen], axis=1))
        swings += events["swings"][0, 1]
        hits += events["hits"][0, 1]
        sim.hp[:] = C.MAX_HEALTH
    assert 0.8 * swings <= hits < swings


def test_a_ported_bot_plays_through_the_pool():
    sim = Sim(8, SimConfig(), seed=2)
    pool = OpponentPool(8, seed=1)
    pool.set_mix({name: 1.0 for name in PORTS})
    for _ in range(30):
        out = pool.act(sim, 1)
        sim.step(np.stack([still(sim), out], axis=1))
    assert np.isfinite(sim.pos).all()


def test_the_left_key_moves_the_way_the_network_expects():
    sim = face_off(6.0)
    sim.yaw[:, 1] = 0.0
    sim.pos[:, 1] = [0.5, 0.0, 6.0]
    action = A.neutral_actions(sim.weapon[:, 1].copy())
    action[:, A.STRAFE] = A.KEY_LEFT
    for _ in range(5):
        sim.step(np.stack([still(sim), action], axis=1))
    assert sim.pos[0, 1, 0] > 0.6


def test_synth_names_what_is_missing(monkeypatch):
    monkeypatch.setattr(synth_bot, "_brain", None)
    monkeypatch.delenv("SYNTH_HOME", raising=False)
    monkeypatch.delenv("SYNTH_WEIGHTS", raising=False)
    with pytest.raises(RuntimeError, match="SYNTH_HOME.*SYNTH_WEIGHTS"):
        synth_bot.load_brain()


def test_synth_names_missing_torch(monkeypatch):
    monkeypatch.setattr(synth_bot, "_brain", None)
    real = importlib.import_module

    def without_torch(name, *args):
        if name == "torch":
            raise ImportError(name)
        return real(name, *args)

    monkeypatch.setattr(synth_bot.importlib, "import_module", without_torch)
    with pytest.raises(RuntimeError, match="PyTorch"):
        synth_bot.load_brain()


def test_synth_refuses_other_weights(monkeypatch, tmp_path):
    (tmp_path / "training").mkdir()
    (tmp_path / "training" / "features.py").write_text("")
    weights = tmp_path / "other.pt"
    weights.write_bytes(b"not the release")
    monkeypatch.setattr(synth_bot, "_brain", None)
    monkeypatch.setenv("SYNTH_HOME", str(tmp_path))
    monkeypatch.setenv("SYNTH_WEIGHTS", str(weights))
    with pytest.raises(RuntimeError, match="release"):
        synth_bot.load_brain()


def test_synth_imports_leave_no_trace(tmp_path):
    (tmp_path / "features.py").write_text("VALUE = 1\n")
    marker = object()
    sys.modules["bridge"] = marker
    path = list(sys.path)
    try:
        with synth_bot._project_imports(tmp_path):
            assert importlib.import_module("features").VALUE == 1
            assert "bridge" not in sys.modules
        assert "features" not in sys.modules
        assert sys.modules["bridge"] is marker
        assert sys.path == path
        assert not (tmp_path / "__pycache__").exists()
    finally:
        sys.modules.pop("bridge", None)


def test_synth_refuses_a_block_world():
    with pytest.raises(ValueError, match="flat arena"):
        synth_bot.synth(SimpleNamespace(world=object()), 1, np.random.default_rng(0))


@pytest.mark.skipif(
    not (os.environ.get("SYNTH_HOME") and os.environ.get("SYNTH_WEIGHTS")), reason="the network is not available"
)
def test_synth_plays_legal_actions_for_its_arenas():
    sim = Sim(6, SimConfig.for_setup("diamond_20"), seed=3)
    rng = np.random.default_rng(3)
    rows = np.array([0, 2, 5])
    others = np.array([1, 3, 4])
    for _ in range(40):
        before = sim.yaw[others, 1].copy()
        masks = build_masks(sim, 1, rows=rows)
        chosen = synth_bot.synth(sim, 1, rng, None, rows)
        for head, start in enumerate(A.HEAD_OFFSETS):
            assert masks[np.arange(3), start + chosen[:, head]].all()
        np.testing.assert_array_equal(sim.yaw[others, 1], before)
        full = A.neutral_actions(sim.weapon.copy())
        full[rows, 1] = chosen
        sim.step(full)
    assert np.isfinite(sim.yaw).all()
    pickle.dumps(sim)
    alive = weakref.ref(sim)
    del sim
    gc.collect()
    assert alive() is None
