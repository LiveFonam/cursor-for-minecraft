"""Expert takeover through the action masks, and the expert store."""

from __future__ import annotations

import threading

import numpy as np
import pytest
import torch

from fighter import actions as A
from fighter import constants as C
from fighter import experts as E
from fighter.env import ArenaVecEnv
from fighter.evaluate import play_matches
from fighter.experts import (
    BLOCKER,
    SHOOTER,
    ExpertRejected,
    ExpertSet,
    ExpertSpec,
    ExpertStore,
    LoadedExpert,
    expert_interface,
    publish_if_passed,
)
from fighter.lean import FIGHT, Host, entropy, log_prob, masked_log_softmax, sample_heads
from fighter.obs import OBS_DIM, build_masks
from fighter.opponents import LEAGUE, OpponentPool
from fighter.policy import NumpyPolicy
from fighter.sim import SimConfig

SIZES = [int(n) for n in A.NVEC]
PASSED = {"passed": True, "score": 0.9}

# Own weapon, enemy weapon, distance, enemy shield raised, enemy faces us, enemy drawing, slot.
CASES = [
    (C.BOW, C.SWORD, 8.0, False, True, False, SHOOTER),
    (C.BOW, C.SWORD, 8.0, True, True, False, None),
    (C.BOW, C.SWORD, 8.0, True, False, False, SHOOTER),
    (C.BOW, C.SWORD, 3.0, False, True, False, None),
    (C.SWORD, C.BOW, 8.0, False, True, False, BLOCKER),
    (C.AXE, C.CROSSBOW, 8.0, False, True, False, BLOCKER),
    (C.SWORD, C.BOW, 3.0, False, True, True, None),
    (C.SWORD, C.SWORD, 8.0, False, True, False, None),
    (C.CROSSBOW, C.BOW, 8.0, False, True, True, SHOOTER),
    (C.AXE, C.SWORD, 3.0, False, True, False, None),
]


def expert(name: str, seed: int, version: int = 1) -> LoadedExpert:
    return LoadedExpert(name, version, NumpyPolicy.random(seed=seed))


def staged_env(interface, seat: int = 0) -> ArenaVecEnv:
    """An arena per case, with `seat` in the role of the player in the case."""
    n = len(CASES)
    pool = OpponentPool(n, seed=2, interface=interface)
    env = ArenaVecEnv(n, pool, SimConfig(), seed=3, interface=interface)
    env.reset()
    stage(env.sim, seat)
    return env


def stage(sim, seat: int = 0) -> None:
    me, you = seat, 1 - seat
    for row, (mine, theirs, distance, shield, facing, drawing, _) in enumerate(CASES):
        sim.pos[row, you] = sim.pos[row, me] + np.array([0.0, 0.0, distance])
        sim.weapon[row, me] = mine
        sim.weapon[row, you] = theirs
        sim.shield_ticks[row, you] = C.SHIELD_RAISE_TICKS if shield else 0
        sim.yaw[row, you] = 180.0 if facing else 0.0
        sim.draw_ticks[row, you] = 5 if drawing else 0
        sim.draw_ticks[row, me] = 0
        sim.shield_ticks[row, me] = 0


def expected(name: str) -> np.ndarray:
    return np.array([case[-1] == name for case in CASES])


@pytest.mark.parametrize("seat", [0, 1])
def test_takeover_applies_only_in_its_situation(seat):
    interface = expert_interface()
    env = staged_env(interface, seat)
    found = interface.experts.situations(env.sim, seat)
    for name in (SHOOTER, BLOCKER):
        np.testing.assert_array_equal(found[name], expected(name), err_msg=name)
    assert not found[E.MOB].any()


def test_masks_fix_only_the_expert_heads_and_stay_legal():
    interface = expert_interface()
    env = staged_env(interface)
    plain = build_masks(env.sim, 0, env.allowed)
    np.testing.assert_array_equal(interface.masks(env.sim, 0, env.allowed), plain)
    interface.experts.install({SHOOTER: expert(SHOOTER, 1), BLOCKER: expert(BLOCKER, 2)})
    masks = interface.masks(env.sim, 0, env.allowed)
    owners = {SHOOTER: E.SHOOTER_SPEC.heads, BLOCKER: E.BLOCKER_SPEC.heads}
    for row, case in enumerate(CASES):
        heads = owners.get(case[-1], ())
        for head in range(len(SIZES)):
            part = slice(A.HEAD_OFFSETS[head], A.HEAD_OFFSETS[head] + SIZES[head])
            if head in heads:
                assert masks[row, part].sum() == 1, (row, head)
                assert (masks[row, part] <= plain[row, part]).all(), (row, head)
            else:
                np.testing.assert_array_equal(masks[row, part], plain[row, part], err_msg=f"{row} {head}")


def test_fixed_heads_add_nothing_to_log_probability_or_entropy():
    interface = expert_interface()
    env = staged_env(interface)
    interface.experts.install({SHOOTER: expert(SHOOTER, 1), BLOCKER: expert(BLOCKER, 2)})
    masks = torch.from_numpy(interface.masks(env.sim, 0, env.allowed))
    torch.manual_seed(0)
    logits = torch.randn(len(CASES), sum(SIZES))
    parts = masked_log_softmax(logits, masks, SIZES)
    chosen = sample_heads(parts)
    total = log_prob(parts, chosen)
    head_masks = masks.split(SIZES, dim=1)
    free = torch.zeros(len(CASES))
    for head, part in enumerate(parts):
        single = head_masks[head].sum(dim=1) == 1
        picked = part.gather(1, chosen[:, head : head + 1]).squeeze(1)
        assert head_masks[head][torch.arange(len(CASES)), chosen[:, head]].all()
        assert torch.all(picked[single].abs() < 1e-6)
        head_entropy = -torch.where(head_masks[head], part.exp() * part, 0.0).sum(dim=1)
        assert torch.all(head_entropy[single].abs() < 1e-6)
        free = free + torch.where(single, 0.0, picked)
    torch.testing.assert_close(total, free)
    assert torch.isfinite(entropy(parts, masks, SIZES)).all()


def test_league_opponents_get_the_takeover_in_both_trainers():
    interface = expert_interface()
    env = staged_env(interface, seat=1)
    interface.experts.install({SHOOTER: expert(SHOOTER, 1), BLOCKER: expert(BLOCKER, 2)})
    pool = env.pool
    pool.set_mix({LEAGUE: 1.0})
    pool.add_snapshot(NumpyPolicy.random(seed=9))
    pool.assign(np.ones(len(CASES), dtype=bool))
    stage(env.sim, 1)
    masks = interface.masks(env.sim, 1)
    acted = pool.act(env.sim, 1)
    for row, case in enumerate(CASES):
        heads = {SHOOTER: E.SHOOTER_SPEC.heads, BLOCKER: E.BLOCKER_SPEC.heads}.get(case[-1], ())
        for head in heads:
            start = A.HEAD_OFFSETS[head]
            assert masks[row, start + acted[row, head]], (row, head)
            assert masks[row, start : start + SIZES[head]].sum() == 1

    host = Host(FIGHT, len(CASES), 0, 5, False, takeover=True)
    try:
        slot = host.local
        slot.env.pool.set_mix({LEAGUE: 1.0})
        slot.add_snapshot(NumpyPolicy.random(seed=9))
        slot.env.pool.assign(np.ones(len(CASES), dtype=bool))
        host.call("set_experts", {SHOOTER: expert(SHOOTER, 1), BLOCKER: expert(BLOCKER, 2)})
        stage(slot.env.sim, 1)
        count = slot.plan()
        rows = slot.arenas
        assert count == len(CASES)
        wanted = slot.env.interface.masks(slot.env.sim, 1, rows=rows)
        np.testing.assert_array_equal(host.views["opp_masks"][:count], wanted)
        fixed = host.views["opp_masks"][:count, A.HEAD_OFFSETS[A.USE] : A.HEAD_OFFSETS[A.USE] + 2].sum(axis=1)
        np.testing.assert_array_equal(fixed == 1, expected(SHOOTER)[rows] | expected(BLOCKER)[rows])
    finally:
        host.close()


def test_hot_load_refreshes_the_masks_of_the_next_decision():
    host = Host(FIGHT, len(CASES), 0, 5, False, takeover=True)
    try:
        env = host.local.env
        stage(env.sim, 0)
        before = env.action_masks()
        host.call("set_experts", {SHOOTER: expert(SHOOTER, 1)})
        np.testing.assert_array_equal(host.views["masks"], env.action_masks())
        assert env.interface.experts.versions()[SHOOTER] == 1
        changed = (host.views["masks"] != before).any(axis=1)
        assert not changed[~expected(SHOOTER)].any()
    finally:
        host.close()


class Recorder:
    def __init__(self):
        self.inner = NumpyPolicy.random(seed=4)
        self.masks = []

    def act(self, obs, masks, rng, deterministic=False):
        self.masks.append(masks.copy())
        return self.inner.act(obs, masks, rng, deterministic)


def test_evaluation_uses_the_takeover():
    always = ExpertSpec(SHOOTER, (A.YAW, A.PITCH), lambda obs: np.ones(len(obs), dtype=bool), E.every_row)
    interface = expert_interface(specs=(always,))
    interface.experts.install({SHOOTER: expert(SHOOTER, 1)})
    recorder = Recorder()
    play_matches(recorder, "idle", games_per_arena=1, n_envs=2, interface=interface)
    assert recorder.masks
    for masks in recorder.masks:
        for head in (A.YAW, A.PITCH):
            part = masks[:, A.HEAD_OFFSETS[head] : A.HEAD_OFFSETS[head] + SIZES[head]]
            assert (part.sum(axis=1) == 1).all()


def test_install_rejects_a_network_that_does_not_fit_and_keeps_the_old_set():
    experts = ExpertSet()
    experts.install({SHOOTER: expert(SHOOTER, 1)})
    wrong = LoadedExpert(BLOCKER, 1, NumpyPolicy.random(seed=1, obs_dim=OBS_DIM + 7))
    with pytest.raises(ExpertRejected):
        experts.install({SHOOTER: expert(SHOOTER, 1, 2), BLOCKER: wrong})
    assert experts.versions() == {E.MOB: None, SHOOTER: 1, BLOCKER: None}
    with pytest.raises(ExpertRejected):
        experts.install({"healer": expert(SHOOTER, 1)})


def test_mob_slot_stays_empty_until_a_mob_block_is_named():
    spec = E.mob_spec()
    assert spec.name == E.MOB and not spec.claims_when_empty
    assert not spec.active(np.ones((3, OBS_DIM), dtype=np.float32)).any()


def test_store_refuses_a_failed_report():
    store = ExpertStore("unused")
    with pytest.raises(ExpertRejected):
        store.publish(SHOOTER, NumpyPolicy.random(seed=1), {"passed": False})
    with pytest.raises(ExpertRejected):
        store.publish(SHOOTER, NumpyPolicy.random(seed=1), {"passed": 1})


def test_publish_if_passed_runs_the_test_on_the_exact_policy(tmp_path):
    store = ExpertStore(tmp_path)
    policy = NumpyPolicy.random(seed=1)
    seen = []

    def failing(candidate):
        seen.append(candidate)
        return {"passed": False}

    assert publish_if_passed(store, SHOOTER, policy, failing)[0] is None
    assert seen == [policy]
    assert store.current(SHOOTER) is None
    assert not list(tmp_path.glob("*/v*"))
    version, _ = publish_if_passed(store, SHOOTER, policy, lambda _: PASSED)
    assert version == 1 and store.latest(SHOOTER).version == 1


def test_versions_count_up_and_the_same_weights_keep_their_version(tmp_path):
    store = ExpertStore(tmp_path)
    first = NumpyPolicy.random(seed=1)
    second = NumpyPolicy.random(seed=2)
    assert store.publish(SHOOTER, first, PASSED) == 1
    assert store.publish(SHOOTER, second, PASSED) == 2
    assert store.publish(SHOOTER, second, PASSED) == 2
    loaded = store.latest(SHOOTER)
    assert loaded.version == 2
    for (w, b), (w2, b2) in zip(loaded.policy.layers, second.layers):
        np.testing.assert_array_equal(w, w2)
        np.testing.assert_array_equal(b, b2)


def test_a_publish_that_fails_midway_leaves_the_live_version(tmp_path, monkeypatch):
    store = ExpertStore(tmp_path)
    store.publish(SHOOTER, NumpyPolicy.random(seed=1), PASSED)

    def broken_rename(*args):
        raise OSError("disk full")

    with monkeypatch.context() as patch:
        patch.setattr(E.os, "rename", broken_rename)
        with pytest.raises(OSError):
            store.publish(SHOOTER, NumpyPolicy.random(seed=2), PASSED)
    assert store.latest(SHOOTER).version == 1
    assert sorted(p.name for p in (tmp_path / SHOOTER).iterdir()) == ["CURRENT.json", "v0001"]

    real = E.write_atomic

    def no_pointer(path, data):
        if path.name == "CURRENT.json":
            raise OSError("stopped")
        real(path, data)

    with monkeypatch.context() as patch:
        patch.setattr(E, "write_atomic", no_pointer)
        with pytest.raises(OSError):
            store.publish(SHOOTER, NumpyPolicy.random(seed=3), PASSED)
    assert store.latest(SHOOTER).version == 1


def test_tampered_weights_are_refused(tmp_path):
    store = ExpertStore(tmp_path)
    store.publish(BLOCKER, NumpyPolicy.random(seed=1), PASSED)
    path = tmp_path / BLOCKER / "v0001" / "policy.npz"
    data = bytearray(path.read_bytes())
    data[-40] ^= 0xFF
    path.write_bytes(bytes(data))
    with pytest.raises(ExpertRejected):
        store.latest(BLOCKER)


def test_readers_see_whole_versions_while_publishing(tmp_path):
    store = ExpertStore(tmp_path)
    policies = [NumpyPolicy.random(seed=s, hidden=32) for s in range(8)]
    errors = []
    seen = set()
    done = threading.Event()

    def read():
        while not done.is_set():
            try:
                loaded = store.latest(SHOOTER)
                if loaded is not None:
                    seen.add(loaded.version)
                    wanted = policies[loaded.version - 1].layers
                    pairs = zip(loaded.policy.layers, wanted)
                    assert all(np.array_equal(w, w2) for (w, _), (w2, _) in pairs)
            except Exception as error:
                errors.append(error)
                return

    reader = threading.Thread(target=read)
    reader.start()
    for policy in policies:
        store.publish(SHOOTER, policy, PASSED)
    done.set()
    reader.join()
    assert not errors
    assert store.latest(SHOOTER).version == len(policies)
