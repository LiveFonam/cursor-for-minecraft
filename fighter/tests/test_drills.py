"""Tests of the skill drills and the training pipeline."""

import json

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter.drills import BlockingDrill, ShootingDrill, _baseline_shooter, _count_shots
from fighter.evaluate import wilson_interval
from fighter.obs import view_angles, wrap_degrees
from fighter.opponents import steer
from fighter.policy import NumpyPolicy
from fighter.train import Stage, TrainConfig, train


def test_shooting_masks_lock_movement_and_weapon():
    env = ShootingDrill(8, seed=0, weapons=(C.CROSSBOW,))
    env.reset()
    masks = env.action_masks()
    start = A.HEAD_OFFSETS[A.FORWARD]
    assert masks[:, start : start + 3].sum(axis=1).tolist() == [1] * 8
    weapon = A.HEAD_OFFSETS[A.WEAPON]
    assert masks[:, weapon + A.WEAPON_ACTION[C.CROSSBOW]].all()
    assert masks[:, weapon : weapon + A.NVEC[A.WEAPON]].sum(axis=1).tolist() == [1] * 8


def test_target_moves_during_shooting_drill():
    env = ShootingDrill(8, seed=1, weapons=(C.BOW,))
    env.reset()
    idle = A.neutral_actions(env.sim.weapon[:, 0].copy())
    path = np.zeros(8)
    for _ in range(20):
        before = env.sim.pos[:, 1].copy()
        env.step_async(idle)
        env.step_wait()
        path += np.linalg.norm((env.sim.pos[:, 1] - before)[:, [0, 2]], axis=1)
    # Targets reverse direction at random, so path length is the fair measure.
    assert (path > 5.0).all()


def test_leading_beats_aiming_at_the_body():
    for weapon in (C.BOW, C.CROSSBOW):
        env = ShootingDrill(24, seed=9, weapons=(weapon,))
        with_lead = _count_shots(env, lambda _: _baseline_shooter(env, lead=True), 3)
        env = ShootingDrill(24, seed=9, weapons=(weapon,))
        without = _count_shots(env, lambda _: _baseline_shooter(env, lead=False), 3)
        assert with_lead["shots"] > 50
        assert with_lead["hit_rate"] > without["hit_rate"]


def blocking_run(raise_shield):
    env = BlockingDrill(16, seed=2)
    env.reset()
    blocked = taken = 0.0
    for _ in range(300):
        sim = env.sim
        a = A.neutral_actions(sim.weapon[:, 0].copy())
        want, _ = view_angles(sim.pos[:, 1] - sim.pos[:, 0])
        steer(a, wrap_degrees(want - sim.yaw[:, 0]), -sim.pitch[:, 0])
        a[:, A.USE] = raise_shield
        env.step_async(a)
        env.step_wait()
        blocked += sim.events["arrows_blocked"][:, 0].sum()
        taken += sim.events["arrows_taken"][:, 0].sum()
    return blocked, taken


def test_raised_shield_blocks_the_archer():
    blocked, taken = blocking_run(1)
    assert blocked > 50
    assert blocked > 10 * taken


def test_lowered_shield_takes_the_arrows():
    blocked, taken = blocking_run(0)
    assert blocked == 0
    assert taken > 50


def test_wilson_interval_bounds():
    low, high = wilson_interval(50, 100)
    assert 0.39 < low < 0.5 < high < 0.61
    assert wilson_interval(0, 0) == (0.0, 1.0)


def test_training_saves_and_resumes(tmp_path):
    stages = [
        Stage("targets", {"idle": 1.0}, 0.5, 100),
        Stage("league", {"league": 1.0, "random": 1.0}, 2.0, 0),
    ]
    cfg = TrainConfig(
        out=str(tmp_path / "run"),
        total_steps=1024,
        n_envs=4,
        n_steps=64,
        batch_size=128,
        n_epochs=1,
        snapshot_every=256,
        checkpoint_every=512,
        stages=stages,
    )
    first = train(cfg)
    assert first["steps"] >= 1024
    assert (tmp_path / "run" / "model.zip").exists()
    assert (tmp_path / "run" / "policy.npz").exists()
    NumpyPolicy.load(tmp_path / "run" / "policy.npz")
    state = json.loads((tmp_path / "run" / "state.json").read_text())
    assert state["steps"] == first["steps"]

    cfg.total_steps = first["steps"] + 512
    second = train(cfg, resume=True)
    assert second["steps"] >= first["steps"] + 512


class SilentArcher(BlockingDrill):
    def _opponent_actions(self):
        return A.neutral_actions(np.full(self.num_envs, C.BOW))


def shield_loop_reward(hold, rest):
    env = SilentArcher(8, seed=3)
    env.reset()
    total = 0.0
    for tick in range(300):
        a = A.neutral_actions(env.sim.weapon[:, 0].copy())
        a[:, A.USE] = hold > 0 and tick % (hold + rest) < hold
        env.step_async(a)
        _, reward, _, _ = env.step_wait()
        total += float(reward.mean())
    return total / 300


@pytest.mark.parametrize("hold, rest", [(1, 1), (2, 1), (3, 1), (6, 1), (3, 3), (1, 0)])
def test_shield_loops_earn_less_than_doing_nothing(hold, rest):
    assert shield_loop_reward(hold, rest) < shield_loop_reward(0, 1)


def test_drills_leave_out_the_widest_turns():
    from fighter.drills import DRILL_MAX_PITCH, DRILL_MAX_YAW

    for env in (ShootingDrill(4, seed=0), BlockingDrill(4, seed=0)):
        mask = env.action_masks()
        yaw = mask[:, A.HEAD_OFFSETS[A.YAW] : A.HEAD_OFFSETS[A.YAW] + A.NVEC[A.YAW]]
        pitch = mask[:, A.HEAD_OFFSETS[A.PITCH] : A.HEAD_OFFSETS[A.PITCH] + A.NVEC[A.PITCH]]
        assert not yaw[:, np.abs(A.YAW_DELTAS) > DRILL_MAX_YAW].any()
        assert not pitch[:, np.abs(A.PITCH_DELTAS) > DRILL_MAX_PITCH].any()
        assert yaw[:, A.NEUTRAL_YAW].all() and pitch[:, A.NEUTRAL_PITCH].all()
