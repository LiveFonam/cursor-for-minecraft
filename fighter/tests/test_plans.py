"""Scripted crossbow rules, reward settings and named training plans."""

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter.env import ArenaVecEnv, RewardConfig
from fighter.experts import expert_interface
from fighter.opponents import OpponentPool
from fighter.plans import AXE_CROSSBOW, PLANS
from fighter.sim import EVENT_NAMES, SimConfig
from fighter.stance import StanceRules
from fighter.train import AXE_ONLY, MAX_TICKS


def make_env(rules=StanceRules(), weapons=AXE_CROSSBOW, reward=None, n=4):
    interface = expert_interface(MAX_TICKS, stance=rules)
    pool = OpponentPool(n, seed=1, max_ticks=MAX_TICKS, interface=interface)
    pool.set_mix({"idle": 1.0})
    env = ArenaVecEnv(n, pool, SimConfig(), reward, max_ticks=MAX_TICKS, seed=2, interface=interface)
    env.set_weapons(weapons)
    env.reset()
    return env


def head(env, index):
    start = int(A.HEAD_OFFSETS[index])
    return env.action_masks()[:, start : start + int(A.NVEC[index])]


def only(index, choice):
    out = np.zeros(int(A.NVEC[index]), dtype=bool)
    out[choice] = True
    return out


def stand(env, gap, weapon=C.CROSSBOW, loaded=True):
    sim = env.sim
    sim.ticks[:] = 5
    sim.pos[:, 0] = [0.0, sim.pos[0, 0, 1], 0.0]
    sim.pos[:, 1] = [0.0, sim.pos[0, 0, 1], gap]
    sim.yaw[:, 0] = 0.0
    sim.yaw[:, 1] = 180.0
    sim.pitch[:] = 0.0
    sim.weapon[:, 0] = weapon
    sim.loaded[:, 0] = loaded
    sim.use_prev[:, 0] = False


def test_opening_forces_a_crossbow_load():
    env = make_env()
    assert (head(env, A.WEAPON) == only(A.WEAPON, A.WEAPON_ACTION[C.CROSSBOW])).all()
    assert (head(env, A.USE) == only(A.USE, 1)).all()


def test_opening_waits_for_the_crossbow_to_be_allowed():
    env = make_env(weapons=AXE_ONLY)
    assert (head(env, A.WEAPON) == only(A.WEAPON, A.WEAPON_ACTION[C.AXE])).all()


def test_hit_during_an_early_load_drops_to_the_axe():
    env = make_env()
    env.sim.hurt_timer[:, 0] = 5
    assert (head(env, A.WEAPON) == only(A.WEAPON, A.WEAPON_ACTION[C.AXE])).all()
    assert (head(env, A.USE) == only(A.USE, 0)).all()


def test_started_load_is_committed():
    env = make_env()
    stand(env, 5.0, loaded=False)
    env.sim.load_ticks[:, 0] = 5
    assert (head(env, A.WEAPON) == only(A.WEAPON, A.WEAPON_ACTION[C.CROSSBOW])).all()
    assert (head(env, A.USE) == only(A.USE, 1)).all()


def test_holds_fire_into_a_raised_shield():
    env = make_env()
    stand(env, 5.0)
    env.sim.shield_ticks[:, 1] = 1
    assert (head(env, A.USE) == only(A.USE, 0)).all()


def test_enemy_in_axe_range_removes_the_crossbow():
    env = make_env()
    stand(env, 2.0)
    weapon = head(env, A.WEAPON)
    assert not weapon[:, A.WEAPON_ACTION[C.CROSSBOW]].any()
    assert not weapon[:, A.WEAPON_KEEP].any()
    assert weapon[:, A.WEAPON_ACTION[C.AXE]].all()


def test_far_loaded_shot_selects_the_crossbow():
    env = make_env()
    stand(env, 10.0, weapon=C.AXE)
    assert (head(env, A.WEAPON) == only(A.WEAPON, A.WEAPON_ACTION[C.CROSSBOW])).all()


def test_followup_fires_after_a_shield_disable():
    env = make_env(StanceRules(followup=True))
    stand(env, 2.0)
    env.sim.shield_disabled[:, 1] = C.SHIELD_DISABLE_TICKS
    assert (head(env, A.WEAPON) == only(A.WEAPON, A.WEAPON_ACTION[C.CROSSBOW])).all()
    assert (head(env, A.USE) == only(A.USE, 1)).all()


def test_followup_holds_fire_in_the_hurt_window():
    env = make_env(StanceRules(followup=True))
    stand(env, 5.0)
    env.sim.hurt_timer[:, 1] = C.HURT_TICKS
    assert (head(env, A.USE) == only(A.USE, 0)).all()


def fine(env, **events):
    ev = {name: np.zeros((env.num_envs, 2)) for name in EVENT_NAMES}
    for name, value in events.items():
        ev[name][:, 0] = value
    env._reward(ev, A.neutral_actions(env.sim.weapon[:, 0].copy()))
    return env.reward_terms["weak_swing"]


@pytest.mark.parametrize(
    ("gap", "events", "fined"),
    [
        (2.0, {"swings": 1.0, "melee_blocked": 1.0, "weak_swings": 1.0}, False),
        (3.2, {"swings": 1.0}, False),
        (8.0, {"swings": 1.0}, True),
    ],
)
def test_exact_miss_fines_only_real_misses(gap, events, fined):
    env = make_env(reward=RewardConfig(weak_swing=0.1, exact_miss=True))
    stand(env, gap)
    assert (fine(env, **events) < 0.0).all() == fined


def test_unfaded_followup_ignores_the_shaping_scale():
    env = make_env(reward=RewardConfig(shaping=0.4, followup=1.5, followup_unfaded=True))
    fine(env, followup_damage=C.MAX_HEALTH)
    assert env.reward_terms["followup"] == pytest.approx(1.5)


def test_plans_keep_sword_and_bow_out_of_the_new_arms():
    for name in ("foundations", "combo"):
        for stage in PLANS[name].stages:
            assert stage.weapons in (AXE_ONLY, AXE_CROSSBOW)
    assert PLANS["melee"].stance is None
    assert PLANS["melee"].reward == {}
    assert PLANS["combo"].stages[-1].mix["shielder"] > 0.0
