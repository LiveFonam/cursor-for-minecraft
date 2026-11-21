"""Tests of observations, masks, opponents and the vector environment."""

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter.env import ArenaVecEnv
from fighter.obs import OBS_DIM, build_masks, build_obs, intercept_angles
from fighter.opponents import SCRIPTED, OpponentPool, sample_masked
from fighter.policy import NumpyPolicy
from fighter.sim import Sim, SimConfig, look_vectors


def make_env(n=8, mix=None, seed=0, max_ticks=200):
    pool = OpponentPool(n, seed=seed, max_ticks=max_ticks)
    pool.set_mix(mix or {"idle": 1.0})
    return ArenaVecEnv(n, pool, SimConfig(), max_ticks=max_ticks, seed=seed)


def test_observation_shape_and_range():
    env = make_env()
    obs = env.reset()
    assert obs.shape == (8, OBS_DIM)
    assert np.isfinite(obs).all()
    assert np.abs(obs).max() <= 5.0


def test_observation_is_egocentric():
    sim = Sim(2, SimConfig(), seed=0)
    sim.pos[:, 0] = [0.0, 0.0, 0.0]
    sim.pos[:, 1] = [0.0, 0.0, 5.0]
    sim.yaw[0] = [0.0, 0.0]
    sim.yaw[1] = [90.0, 0.0]
    obs = build_obs(sim, 0, 600)
    assert obs[0, 26] == pytest.approx(0.0, abs=1e-6)
    assert obs[0, 27] == pytest.approx(1.0, abs=1e-6)
    assert obs[1, 26] == pytest.approx(1.0, abs=1e-3)
    assert obs[1, 27] == pytest.approx(0.0, abs=1e-3)


def test_observation_shows_crossbow_needs_a_release():
    sim = Sim(1, SimConfig(), seed=0)
    sim.weapon[0, 0] = C.CROSSBOW
    sim.loaded[0, 0] = True
    held = A.neutral_actions(sim.weapon.copy())
    held[0, 0, A.USE] = 1
    sim._tick(held, first=True)
    assert sim.events["arrows_fired"][0, 0] == 1
    obs = build_obs(sim, 0, 600)
    use = A.HEAD_OFFSETS[A.USE] + 1
    assert obs[0, 74] == 1.0
    assert obs[0, 22] == 0.0
    assert not build_masks(sim, 0)[0, use]
    released = A.neutral_actions(sim.weapon.copy())
    sim._tick(released, first=True)
    obs = build_obs(sim, 0, 600)
    assert obs[0, 74] == 0.0
    assert build_masks(sim, 0)[0, use]


def test_melee_can_swing_early_and_ranged_weapons_cannot_swing():
    sim = Sim(1, SimConfig(), seed=0)
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 2.0]
    sim.yaw[0] = [90.0, 180.0]
    click = A.HEAD_OFFSETS[A.ATTACK] + A.ATTACK_CLICK
    double = A.HEAD_OFFSETS[A.ATTACK] + A.ATTACK_DOUBLE
    assert not sim.aim_hits()[0, 0]
    assert build_masks(sim, 0)[0, click] and build_masks(sim, 0)[0, double]
    for weapon in (C.BOW, C.CROSSBOW):
        sim.weapon[0, 0] = weapon
        assert not build_masks(sim, 0)[0, click] and not build_masks(sim, 0)[0, double]


def test_jump_is_masked_in_the_air():
    sim = Sim(1, SimConfig(), seed=0)
    sim.on_ground[0, 0] = False
    assert not build_masks(sim, 0)[0, A.HEAD_OFFSETS[A.JUMP] + 1]


def test_use_is_masked_when_shield_is_disabled():
    sim = Sim(1, SimConfig(), seed=0)
    sim.shield_disabled[0, 0] = 50
    assert not build_masks(sim, 0)[0, A.HEAD_OFFSETS[A.USE] + 1]


def test_every_head_always_has_a_legal_choice():
    env = make_env(mix={"random": 1.0})
    env.reset()
    rng = np.random.default_rng(0)
    for _ in range(100):
        masks = env.action_masks()
        for start, size in zip(A.HEAD_OFFSETS, A.NVEC):
            assert masks[:, start : start + size].any(axis=1).all()
        env.step_async(sample_masked(masks, rng))
        env.step_wait()


def test_sampled_actions_respect_masks():
    rng = np.random.default_rng(0)
    sim = Sim(32, SimConfig(), seed=0)
    masks = build_masks(sim, 0)
    actions = sample_masked(masks, rng)
    for head, start in enumerate(A.HEAD_OFFSETS):
        assert masks[np.arange(32), start + actions[:, head]].all()


@pytest.mark.parametrize("name", sorted(SCRIPTED))
def test_scripted_opponents_produce_valid_actions(name):
    sim = Sim(16, SimConfig(), seed=3)
    rng = np.random.default_rng(3)
    for _ in range(80):
        a = SCRIPTED[name](sim, 1, rng)
        assert a.shape == (16, len(A.NVEC))
        assert (a >= 0).all() and (a < A.NVEC).all()
        joined = np.stack([A.neutral_actions(sim.weapon[:, 0].copy()), a], axis=1)
        sim.step(joined)
    assert np.isfinite(sim.pos).all()


def test_swinger_damages_idle_player():
    sim = Sim(8, SimConfig(), seed=1)
    rng = np.random.default_rng(1)
    for _ in range(150):
        joined = np.stack(
            [A.neutral_actions(sim.weapon[:, 0].copy()), SCRIPTED["swinger"](sim, 1, rng)], axis=1
        )
        sim.step(joined)
    assert (sim.hp[:, 0] < C.MAX_HEALTH).all()


def test_intercept_aim_hits_a_moving_target():
    hits = 0
    for seed in range(20):
        sim = Sim(1, SimConfig(armor="none"), seed=seed)
        sim.pos[0, 0] = [0.0, 0.0, -6.0]
        sim.pos[0, 1] = [-3.0, 0.0, 4.0]
        sim.vel[0, 1] = [0.2, 0.0, 0.0]
        sim.body.last_move[0, 1] = [0.2, 0.0, 0.0]
        sim.weapon[0, 0] = C.BOW
        sim.draw_ticks[0, 0] = C.BOW_FULL_DRAW_TICKS
        yaw, pitch, _ = intercept_angles(sim, 0, np.array([C.BOW_MAX_SPEED]))
        sim.yaw[0, 0] = yaw[0]
        sim.pitch[0, 0] = pitch[0]
        walking = A.neutral_actions(sim.weapon.copy())
        walking[0, 0, A.WEAPON] = A.WEAPON_ACTION[C.BOW]
        sim.yaw[0, 1] = -90.0
        walking[0, 1, A.FORWARD] = A.KEY_FORWARD
        for _ in range(12):
            sim._tick(walking, first=True)
        hits += sim.hp[0, 1] < C.MAX_HEALTH
    assert hits == 20


def test_episode_auto_resets_with_terminal_observation():
    env = make_env(n=4, max_ticks=20)
    env.reset()
    idle = A.neutral_actions(env.sim.weapon[:, 0].copy())
    done = np.zeros(4, dtype=bool)
    infos = []
    for _ in range(10):
        env.step_async(idle)
        _, _, done, infos = env.step_wait()
    assert done.all()
    assert all("terminal_observation" in info for info in infos)
    assert all(info["TimeLimit.truncated"] for info in infos)
    assert (env.sim.ticks == 0).all()


def test_knockout_gives_win_reward():
    env = make_env(n=2)
    env.reset()
    env.sim.hp[0, 1] = 0.0
    idle = A.neutral_actions(env.sim.weapon[:, 0].copy())
    env.step_async(idle)
    _, reward, done, infos = env.step_wait()
    assert done[0]
    assert infos[0]["outcome"] == 1
    assert reward[0] > 1.5


def test_numpy_policy_round_trip(tmp_path):
    policy = NumpyPolicy.random(seed=1)
    path = tmp_path / "policy.npz"
    policy.save(path)
    loaded = NumpyPolicy.load(path)
    obs = np.random.default_rng(0).random((4, OBS_DIM), dtype=np.float32)
    assert np.allclose(policy.logits(obs), loaded.logits(obs))


def test_numpy_policy_obeys_masks():
    policy = NumpyPolicy.random(seed=2)
    sim = Sim(16, SimConfig(), seed=0)
    obs = build_obs(sim, 0, 600)
    masks = build_masks(sim, 0)
    actions = policy.act(obs, masks, np.random.default_rng(0))
    for head, start in enumerate(A.HEAD_OFFSETS):
        assert masks[np.arange(16), start + actions[:, head]].all()


def test_pool_samples_snapshots_in_league():
    pool = OpponentPool(32, seed=0)
    pool.add_snapshot(NumpyPolicy.random(seed=0))
    pool.add_snapshot(NumpyPolicy.random(seed=1))
    pool.set_mix({"league": 1.0})
    assert (pool.snapshot_of >= 0).all()
    assert set(pool.snapshot_of.tolist()) == {0, 1}


def test_look_vector_convention():
    forward = look_vectors(np.array(0.0), np.array(0.0))
    assert forward == pytest.approx([0.0, 0.0, 1.0])
    west = look_vectors(np.array(90.0), np.array(0.0))
    assert west == pytest.approx([-1.0, 0.0, 0.0])
    down = look_vectors(np.array(0.0), np.array(90.0))
    assert down == pytest.approx([0.0, -1.0, 0.0], abs=1e-9)
