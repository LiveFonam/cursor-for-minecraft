"""The first curriculum stages teach the axe before ranged weapons unlock."""

import numpy as np

from fighter import actions as A
from fighter import constants as C
from fighter.env import ArenaVecEnv
from fighter.lean import ActorCritic, LeanConfig, LeanTrainer
from fighter.opponents import LEAGUE, OpponentPool
from fighter.sim import SimConfig
from fighter.train import AXE_ONLY, CURRICULUM, FIGHT_WEAPONS, MAX_TICKS, Stage


def make_env(n: int = 4) -> ArenaVecEnv:
    pool = OpponentPool(n, seed=1, max_ticks=MAX_TICKS)
    pool.set_mix({"idle": 1.0})
    return ArenaVecEnv(n, pool, SimConfig(), max_ticks=MAX_TICKS, seed=2)


def weapon_mask(env: ArenaVecEnv) -> np.ndarray:
    start = int(A.HEAD_OFFSETS[A.WEAPON])
    return env.action_masks()[:, start : start + int(A.NVEC[A.WEAPON])]


def test_axe_stage_makes_the_spawn_sword_switch_to_the_axe():
    env = make_env()
    env.reset()
    env.set_weapons(AXE_ONLY)
    assert (env.sim.weapon[:, 0] == C.SWORD).all()
    expected = np.zeros(int(A.NVEC[A.WEAPON]), dtype=bool)
    expected[A.WEAPON_ACTION[C.AXE]] = True
    assert (weapon_mask(env) == expected).all()


def test_axe_choice_takes_effect_and_can_swing():
    env = make_env()
    env.reset()
    env.set_weapons(AXE_ONLY)
    action = A.neutral_actions(env.sim.weapon[:, 0].copy())
    action[:, A.WEAPON] = A.WEAPON_ACTION[C.AXE]
    env.step_async(action)
    env.step_wait()
    assert (env.sim.weapon[:, 0] == C.AXE).all()
    start = int(A.HEAD_OFFSETS[A.ATTACK])
    assert env.action_masks()[:, start + A.ATTACK_CLICK].all()
    assert weapon_mask(env)[:, A.WEAPON_KEEP].all()


def test_clearing_the_limit_restores_every_weapon():
    env = make_env()
    env.reset()
    before = weapon_mask(env).copy()
    env.set_weapons(AXE_ONLY)
    env.set_weapons(None)
    assert (weapon_mask(env) == before).all()


def test_curriculum_teaches_the_axe_first_and_never_offers_the_sword():
    by_name = {stage.name: stage for stage in CURRICULUM}
    assert by_name["targets"].weapons == AXE_ONLY
    assert by_name["chasers"].weapons == AXE_ONLY
    for stage in CURRICULUM:
        assert C.AXE in stage.weapons and C.SWORD not in stage.weapons
        if "archer" in stage.mix:
            assert stage.weapons == FIGHT_WEAPONS


def test_trainer_applies_the_limit_of_each_stage(tmp_path):
    stages = [
        Stage("first", {"idle": 1.0}, 0.5, 100, weapons=AXE_ONLY),
        Stage("second", {"idle": 1.0}, 2.0, 0),
    ]
    cfg = LeanConfig(
        out=str(tmp_path), total_steps=64, n_envs=4, n_steps=4, batch_size=8, n_epochs=1,
        device="cpu", threads=1, stages=stages,
    )
    trainer = LeanTrainer(cfg)
    try:
        allowed = trainer.host.local.env.allowed
        assert allowed[:, C.AXE].all() and not allowed[:, [C.SWORD, C.BOW, C.CROSSBOW]].any()
        trainer._enter(1)
        assert trainer.host.local.env.allowed.all()
    finally:
        trainer.host.close()


def test_league_snapshots_follow_the_weapon_limit():
    env = make_env()
    model = ActorCritic(env.interface.obs_dim, env.interface.mask_size)
    env.pool.add_snapshot(model.to_policy())
    env.pool.set_mix({LEAGUE: 1.0})
    env.set_weapons(AXE_ONLY)
    env.reset()
    chosen = env.pool.act(env.sim, 1)
    assert (A.WEAPON_CHOICES[chosen[:, A.WEAPON]] == C.AXE).all()


def test_lean_league_batch_follows_the_weapon_limit(tmp_path):
    stages = [Stage("only", {LEAGUE: 1.0}, 2.0, 0, weapons=AXE_ONLY)]
    cfg = LeanConfig(
        out=str(tmp_path), total_steps=64, n_envs=4, n_steps=4, batch_size=8, n_epochs=1,
        device="cpu", threads=1, stagger=False, stages=stages,
    )
    trainer = LeanTrainer(cfg)
    try:
        trainer.add_snapshot()
        trainer.host.call("reset")
        count = trainer.host.call("plan")[0]
        assert count == 4
        start = int(A.HEAD_OFFSETS[A.WEAPON])
        masks = trainer.host.views["opp_masks"][:count, start : start + int(A.NVEC[A.WEAPON])]
        expected = np.zeros(int(A.NVEC[A.WEAPON]), dtype=bool)
        expected[A.WEAPON_ACTION[C.AXE]] = True
        assert (masks == expected).all()
    finally:
        trainer.host.close()
