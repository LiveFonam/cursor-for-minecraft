"""The spaced axe plan: a long start, the sword window, and rewards for jump crits and clean crossbow shots."""

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter import evolve as E
from fighter.combat import CHARGE_GATE
from fighter.env import ArenaVecEnv, RewardConfig
from fighter.experts import expert_interface
from fighter.opponents import OpponentPool
from fighter.plans import AXE_CROSSBOW, PLANS, arena_stage
from fighter.sim import FIGHT_SETUPS, Sim, SimConfig
from fighter.stance import StanceRules
from fighter.train import MAX_TICKS
from test_arena import fake_run, small_config

ALL_MELEE = (C.AXE, C.SWORD, C.CROSSBOW)
WINDOW = StanceRules(followup=True, sword_window=True)


def make_env(rules=WINDOW, weapons=ALL_MELEE, reward=None, n=4, setup="diamond_20"):
    interface = expert_interface(MAX_TICKS, stance=rules)
    pool = OpponentPool(n, seed=1, max_ticks=MAX_TICKS, interface=interface)
    pool.set_mix({"idle": 1.0})
    config = SimConfig.for_setup(setup)
    env = ArenaVecEnv(n, pool, config, reward, max_ticks=MAX_TICKS, seed=2, interface=interface)
    env.set_weapons(weapons)
    env.reset()
    return env


def weapons(env):
    start = int(A.HEAD_OFFSETS[A.WEAPON])
    return env.action_masks()[:, start : start + int(A.NVEC[A.WEAPON])]


def past_opening(env, weapon, gap=2.0):
    sim = env.sim
    sim.ticks[:] = 5
    sim.stance_opening = np.zeros((sim.n, 2), dtype=bool)
    sim.pos[:, 0] = [0.0, sim.pos[0, 0, 1], 0.0]
    sim.pos[:, 1] = [0.0, sim.pos[0, 0, 1], gap]
    sim.weapon[:, 0] = weapon
    sim.loaded[:, 0] = False
    sim.load_ticks[:, 0] = 0
    sim.use_prev[:, 0] = False


SWORD = int(A.WEAPON_ACTION[C.SWORD])
AXE = int(A.WEAPON_ACTION[C.AXE])
BOW = int(A.WEAPON_ACTION[C.BOW])


def test_the_far_setup_starts_15_to_17_blocks_apart_inside_the_walls():
    sim = Sim(512, SimConfig.for_setup("diamond_20_far"), seed=3)
    for _ in range(4):
        sim.reset()
        gap = sim.pos[:, 1] - sim.pos[:, 0]
        distance = np.hypot(gap[:, 0], gap[:, 2])
        assert distance.min() >= 15.0 and distance.max() <= 17.0
        limit = sim.cfg.arena_half - C.PLAYER_WIDTH / 2.0
        assert np.abs(sim.pos[:, :, [0, 2]] - np.array(sim.origin)[[0, 2]]).max() <= limit


def test_the_near_setup_keeps_its_start():
    plain = SimConfig.for_setup("diamond_20")
    assert (plain.spawn_min, plain.spawn_max) == (4.0, 10.0)
    assert FIGHT_SETUPS["diamond_20"] == {"armor": "diamond", "arena_half": 10.0}
    far = SimConfig.for_setup("diamond_20_far")
    assert (far.armor, far.arena_half) == (plain.armor, plain.arena_half)


def test_the_sword_is_closed_until_the_enemy_shield_is_disabled():
    env = make_env()
    past_opening(env, C.AXE)
    assert not weapons(env)[:, SWORD].any()
    env.sim.shield_disabled[:, 1] = 40
    assert weapons(env)[:, SWORD].all()


def test_the_players_own_disabled_shield_does_not_open_the_sword():
    env = make_env()
    past_opening(env, C.AXE)
    env.sim.shield_disabled[:, 0] = 40
    assert not weapons(env)[:, SWORD].any()


def test_a_sword_in_hand_must_be_put_away_when_the_window_ends():
    env = make_env()
    past_opening(env, C.SWORD)
    env.sim.shield_disabled[:, 1] = 1
    assert weapons(env)[:, A.WEAPON_KEEP].all()
    env.sim.shield_disabled[:, 1] = 0
    closed = weapons(env)
    assert not closed[:, A.WEAPON_KEEP].any()
    assert not closed[:, SWORD].any()
    assert closed[:, AXE].all()


def test_the_sword_never_lands_outside_the_window_in_play():
    env = make_env(n=16)
    rng = np.random.default_rng(4)
    from fighter.policy import NumpyPolicy

    policy = NumpyPolicy.random(seed=5)
    obs = env.reset()
    for _ in range(300):
        before = env.sim.shield_disabled[:, 1].copy()
        actions = policy.act(obs, env.action_masks(), rng)
        chosen = A.WEAPON_CHOICES[actions[:, A.WEAPON]]
        assert ((chosen != C.SWORD) | (before > 0)).all()
        env.step_async(actions)
        obs, _, _, _ = env.step_wait()


def test_without_the_rule_the_sword_stays_open():
    env = make_env(rules=StanceRules(followup=True))
    past_opening(env, C.AXE)
    assert weapons(env)[:, SWORD].all()


def test_the_plan_trains_with_the_rule_and_without_the_bow():
    plan = PLANS["spaced_axe"]
    assert plan.stance == WINDOW
    assert plan.ready_gate == CHARGE_GATE
    assert plan.adaptive
    for stage in (*plan.stages, arena_stage("spaced_axe")):
        assert C.BOW not in stage.weapons
    assert C.SWORD in arena_stage("spaced_axe").weapons
    assert PLANS["combo"].stance == StanceRules(followup=True)
    assert PLANS["combo"].stages[-1].weapons == AXE_CROSSBOW


def spacing_gain(reward, weapon, start, end):
    env = make_env(reward=reward)
    past_opening(env, weapon, start)
    env._phi = env._potential()
    before = env._phi.copy()
    env.sim.pos[:, 1, 2] = env.sim.pos[:, 0, 2] + end
    return (env._potential() - before)[0]


def test_backing_off_pays_with_the_crossbow_and_closing_in_pays_with_the_axe():
    reward = RewardConfig(**PLANS["spaced_axe"].reward)
    assert spacing_gain(reward, C.CROSSBOW, 3.0, 6.0) > 0.0
    assert spacing_gain(reward, C.AXE, 6.0, 3.0) > 0.0
    assert spacing_gain(reward, C.CROSSBOW, 6.0, 3.0) < 0.0


def test_the_load_range_is_off_by_default():
    assert RewardConfig().load_range == 0.0
    assert spacing_gain(RewardConfig(), C.CROSSBOW, 6.0, 3.0) > 0.0


def fight_reward(reward, **events):
    env = make_env(reward=reward)
    ev = {key: np.zeros_like(value) for key, value in env.sim.events.items()}
    for key, seats in events.items():
        ev[key][:, seats[0]] = seats[1]
    env._phi = env._potential()
    actions = np.zeros((env.num_envs, len(A.NVEC)), dtype=np.int64)
    return env._reward(ev, actions), env.reward_terms


def test_a_clean_arrow_pays_and_an_arrow_into_a_shield_costs():
    reward = RewardConfig(shaping=1.0, clean_shot=0.3, blocked_shot=0.15)
    plain = fight_reward(reward)[0][0]
    hit, terms = fight_reward(reward, arrow_hits=(0, 1.0))
    assert hit[0] - plain == pytest.approx(0.3)
    assert terms["clean_shot"][0] == pytest.approx(0.3)
    blocked, terms = fight_reward(reward, arrows_blocked=(1, 1.0))
    assert blocked[0] - plain == pytest.approx(-0.15)
    assert terms["blocked_shot"][0] == pytest.approx(-0.15)


def test_a_timeout_costs_only_with_the_new_weight():
    env = make_env(reward=RewardConfig(timeout_cost=0.5))
    env.sim.hp[:] = 10.0
    ko = np.zeros(env.num_envs, dtype=bool)
    bonus, _ = env._outcome_reward(ko, ~ko)
    assert bonus == pytest.approx(-0.5)
    plain = make_env()
    plain.sim.hp[:] = 10.0
    assert plain._outcome_reward(ko, ~ko)[0] == pytest.approx(0.0)


def test_mutations_stay_on_the_weights_the_fight_data_points_at():
    plan = PLANS["spaced_axe"]
    assert {"crit", "clean_shot", "blocked_shot", "load_range", "timeout_cost"} <= set(plan.mutable)
    rng = np.random.default_rng(1)
    for _ in range(40):
        reward, changes = E.mutate_reward("spaced_axe", dict(plan.reward), rng, 1, 0.25)
        assert set(changes) <= set(plan.mutable)
        low, high = E.ABSOLUTE_LIMITS["load_range"]
        assert low <= reward["load_range"] <= high


def test_older_plans_keep_their_mutation_list():
    assert PLANS["combo"].mutable is None
    rng = np.random.default_rng(1)
    _, changes = E.mutate_reward("combo", {}, rng, 1, 0.25)
    assert set(changes) <= set(E.MUTABLE)


def test_an_evolution_can_move_its_founders_to_a_new_plan(tmp_path):
    parent = fake_run(tmp_path / "parent", plan="combo", seed=1)
    rival = fake_run(tmp_path / "rival", plan="combo", seed=2)
    root = tmp_path / "evo"
    root.mkdir()
    cfg = small_config([parent], frozen=[str(rival)], plan="spaced_axe", fight_setup="diamond_20_far")
    driver = E.Evolution(root, cfg, E.EvolveRuntime(threads=1, min_free_gb=0.0))
    driver.load()
    driver.import_founders()
    assert driver.state["members"]["g00-00"]["plan"] == "spaced_axe"
    assert driver.state["members"]["r00-00"]["plan"] == "combo"


def test_an_unknown_plan_is_refused(tmp_path):
    with pytest.raises(SystemExit):
        E.prepare(tmp_path, {"parents": ["x"], "plan": "nope"})


def test_the_command_line_takes_the_plan():
    args = E.build_parser().parse_args(["run", "--out", "x", "--plan", "spaced_axe", "--fight-setup", "diamond_20_far"])
    assert args.plan == "spaced_axe"
    assert args.fight_setup == "diamond_20_far"
