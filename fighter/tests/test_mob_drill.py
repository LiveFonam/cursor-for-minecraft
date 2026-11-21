"""Mob rounds, the expert interface, the pass test and the reward farm check."""

from __future__ import annotations

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter.evaluate import HELD_OUT_SEED
from fighter.mob_drill import (
    FARM_BOTS,
    FARM_MIXES,
    GROUP_PASS_WIN_RATE,
    FARM_LOOPS,
    MOB_CURRICULUM,
    PASS_WIN_RATE,
    GROUPS,
    ROSTERS,
    MobExpert,
    MobFightEnv,
    MobReward,
    build_expert_model,
    expert_report,
    farm_report,
    fighter_bot,
    idle_bot,
    mob_extra_dim,
    mob_features,
    play_rounds,
    route_actions,
)
from fighter.mobs import CREEPER, ENDERMAN, KIND_NAMES, SKELETON, ZOMBIE
from fighter.obs import OBS_DIM
from fighter.train import TrainConfig


def only_shaping() -> MobReward:
    return MobReward(kill=0.0, clear=0.0, health_left=0.0, time=0.0, effort=0.0)


def test_observation_size_comes_from_the_environment():
    env = MobFightEnv(2, seed=1)
    assert env.shared_dim == OBS_DIM
    assert env.extra_dim == mob_extra_dim()
    assert env.observation_space.shape == (OBS_DIM + mob_extra_dim(),)
    assert env.reset().shape == (2, OBS_DIM + mob_extra_dim())


def test_shared_part_of_the_input_is_the_main_observation():
    from fighter.obs import build_obs

    env = MobFightEnv(2, seed=1)
    obs = env.reset()
    shared = np.clip(build_obs(env.sim, 0, env.max_ticks), -5.0, 5.0)
    assert np.array_equal(obs[:, : env.shared_dim], shared)


def test_expert_builds_for_a_larger_interface(tmp_path):
    nvec = np.array([3, 3, 2, 2, 9, 7, 2, 2, 4, 3, 2])
    expert = MobExpert.random(130, mob_extra_dim(), nvec, seed=2)
    obs = np.zeros((5, 130 + mob_extra_dim()), dtype=np.float32)
    masks = np.ones((5, int(nvec.sum())), dtype=bool)
    out = expert.act(obs, masks, np.random.default_rng(0))
    assert out.shape == (5, 11)
    assert (out < nvec).all()
    path = tmp_path / "expert.npz"
    expert.save(path)
    loaded = MobExpert.load(path)
    assert loaded.shared_dim == 130
    assert loaded.nvec.tolist() == nvec.tolist()
    assert np.array_equal(loaded.logits(obs), expert.logits(obs))


def test_expert_respects_action_masks():
    env = MobFightEnv(4, seed=3)
    obs = env.reset()
    expert = MobExpert.random(env.shared_dim, env.extra_dim, env.action_space.nvec, seed=4)
    actions = expert.act(obs, env.action_masks(), np.random.default_rng(1), deterministic=False)
    assert np.isin(actions[:, A.WEAPON], [A.WEAPON_KEEP, A.WEAPON_ACTION[C.AXE]]).all()
    env.step(actions)
    assert (env.sim.weapon[:, 0] == C.AXE).all()


def test_mob_features_hide_server_only_state():
    env = MobFightEnv(2, {"skeleton": 1.0}, seed=5)
    env.reset()
    before = mob_features(env.sim).copy()
    mobs = env.sim.mobs
    mobs.attack_wait[:] = 13
    mobs.bow_wait[:] = 17
    mobs.stare[:] = 3
    mobs.toward_time[:] = 9
    mobs.strafe_time[:] = 4
    mobs.resist[:] = 0.04
    assert np.array_equal(mob_features(env.sim), before)


def test_mob_features_show_kind_fuse_anger_and_bow():
    env = MobFightEnv(1, {"creeper": 1.0}, seed=6)
    env.reset()
    mobs = env.sim.mobs
    mobs.swell[0, 0] = 15
    mobs.swell_dir[0, 0] = 1
    out = mob_features(env.sim)[0]
    assert out[0] == 1.0
    assert out[1 + CREEPER] == 1.0
    assert out[12] == pytest.approx(0.5)
    assert out[13] == 1.0

    env = MobFightEnv(1, {"enderman": 1.0}, seed=6)
    env.reset()
    env.sim.mobs.provoked[0, 0] = True
    out = mob_features(env.sim)[0]
    assert out[1 + ENDERMAN] == 1.0
    assert out[14] == 1.0

    env = MobFightEnv(1, {"skeleton": 1.0}, seed=6)
    env.reset()
    env.sim.mobs.draw[0, 0] = 5
    out = mob_features(env.sim)[0]
    assert out[1 + SKELETON] == 1.0
    assert out[15] == 1.0


def test_features_list_the_nearest_mob_first():
    env = MobFightEnv(1, {"creeper_pack": 1.0}, seed=7)
    env.reset()
    mobs = env.sim.mobs
    player = env.sim.pos[0, 0]
    mobs.pos[0, 0] = player + (5.0, 0.0, 0.0)
    mobs.pos[0, 1] = player + (2.0, 0.0, 0.0)
    mobs.pos[0, 2] = player + (8.0, 0.0, 0.0)
    out = mob_features(env.sim)[0]
    assert out[1 + SKELETON] == 1.0
    assert out[17 + 1 + ZOMBIE] == 1.0
    assert out[34 + 1 + CREEPER] == 1.0


@pytest.mark.parametrize("name", KIND_NAMES)
def test_shaping_of_every_round_sums_to_zero(name):
    env = MobFightEnv(8, {name: 1.0}, seed=8, reward=only_shaping())
    result = play_rounds(env, lambda _obs: fighter_bot(env), per_arena=2)
    assert result["rounds"] == 16
    assert result["reward_per_step"] == pytest.approx(0.0, abs=1e-9)


def test_kill_pays_and_a_creeper_blast_does_not():
    reward = MobReward(clear=0.0, health_left=0.0, time=0.0, effort=0.0, shaping=0.0, damage=0.0)
    env = MobFightEnv(8, {"creeper": 1.0}, seed=9, reward=reward)
    blast = play_rounds(env, lambda _obs: idle_bot(env), per_arena=1)
    assert blast["reward_per_step"] == pytest.approx(0.0, abs=1e-9)
    assert blast["wins"] == 0

    env = MobFightEnv(8, {"zombie": 1.0}, seed=9, reward=reward)
    fight = play_rounds(env, lambda _obs: fighter_bot(env), per_arena=1)
    assert fight["wins"] == 8
    assert fight["reward_per_step"] * fight["steps"] == pytest.approx(8 * reward.kill, abs=0.01)


def test_clear_is_paid_by_the_share_of_mobs_the_player_killed():
    env = MobFightEnv(1, {"group3": 1.0}, seed=10)
    env.reset()
    mobs = env.sim.mobs
    cfg = env.reward_cfg
    full = cfg.clear + cfg.health_left * env.sim.hp[0, 0] / C.MAX_HEALTH
    mobs.alive[0] = False
    ko, timeout = env._terminal()
    assert ko[0]
    paid = []
    for kills in (0, 1, 3):
        mobs.kills[0] = kills
        bonus, outcome = env._outcome_reward(ko, timeout)
        assert outcome[0] == 1
        paid.append(float(bonus[0] - (env._phi_start[0] - env._phi[0])))
    assert paid == pytest.approx([0.0, full / 3.0, full])
    mobs.blasts[0] = 1
    bonus, outcome = env._outcome_reward(ko, timeout)
    assert outcome[0] == 0
    assert float(bonus[0] - (env._phi_start[0] - env._phi[0])) == 0.0


def test_random_groups_mix_every_kind_with_repeats():
    env = MobFightEnv(64, {"group2": 1.0, "group3": 1.0, "group4": 1.0}, seed=21)
    env.reset()
    mobs = env.sim.mobs
    sizes = mobs.alive.sum(axis=1)
    assert set(sizes.tolist()) == {2, 3, 4}
    kinds = mobs.kind[mobs.alive]
    assert set(kinds.tolist()) == set(range(len(KIND_NAMES)))
    repeats = [np.bincount(mobs.kind[row][mobs.alive[row]], minlength=4).max() for row in range(64)]
    assert max(repeats) >= 2
    assert (env.round_mobs == sizes).all()


def test_curriculum_keeps_single_mob_rounds_next_to_groups():
    mix = MOB_CURRICULUM[-1].mix
    assert set(GROUPS) <= set(mix)
    singles = sum(mix[name] for name in KIND_NAMES)
    assert 0.3 <= singles / sum(mix.values()) <= 0.7


def test_group_pass_test_reports_every_size_and_keeps_the_single_bar():
    env = MobFightEnv(2, seed=16)
    expert = MobExpert.random(env.shared_dim, env.extra_dim, env.action_space.nvec, seed=17)
    report = expert_report(expert, n_envs=8)
    assert set(report["groups"]["sizes"]) == set(GROUPS)
    assert report["groups"]["pass_win_rate"] == GROUP_PASS_WIN_RATE
    assert report["pass_win_rate"] == PASS_WIN_RATE == 0.80
    assert not report["groups"]["passed"]


def test_round_ends_when_the_player_dies():
    env = MobFightEnv(1, {"zombie": 1.0}, seed=11)
    env.reset()
    env.sim.hp[0, 0] = 0.0
    ko, _ = env._terminal()
    _, outcome = env._outcome_reward(ko, np.zeros(1, dtype=bool))
    assert ko[0]
    assert outcome[0] == -1


def test_packs_spawn_every_mob_of_the_roster():
    env = MobFightEnv(3, {"creeper_pack": 1.0}, seed=12)
    env.reset()
    assert (env.sim.mobs.alive.sum(axis=1) == 3).all()
    assert env.sim.mobs.kind[0, :3].tolist() == list(ROSTERS["creeper_pack"])


def test_attack_mask_follows_aim_at_a_mob():
    env = MobFightEnv(1, {"zombie": 1.0}, seed=13)
    env.reset()
    sim = env.sim
    sim.pos[:, 0] = (0.0, 0.0, 0.0)
    sim.yaw[:, 0] = 0.0
    sim.pitch[:, 0] = 0.0
    sim.mobs.pos[0, 0] = (0.0, 0.0, 2.0)
    attack = A.HEAD_OFFSETS[A.ATTACK] + 1
    assert env.action_masks()[0, attack]
    sim.yaw[:, 0] = 90.0
    assert not env.action_masks()[0, attack]


def test_router_uses_the_expert_only_against_mobs():
    env = MobFightEnv(4, {"zombie": 1.0}, seed=14)
    obs = env.reset()
    env.sim.mobs.alive[2:] = False
    seen = {}

    def main(shared, masks):
        seen["size"] = shared.shape[1]
        out = A.neutral_actions(np.full(len(shared), C.AXE))
        out[:, A.FORWARD] = A.KEY_BACK
        return out

    expert = MobExpert.random(env.shared_dim, env.extra_dim, env.action_space.nvec, seed=15)
    picks = expert.act(obs[:2], env.action_masks()[:2], np.random.default_rng(0))
    out = route_actions(main, expert, env, obs, np.random.default_rng(0))
    assert seen["size"] == env.shared_dim
    assert (out[2:, A.FORWARD] == A.KEY_BACK).all()
    assert np.array_equal(out[:2], picks)


def test_curriculum_stages_name_real_rosters():
    for stage in MOB_CURRICULUM:
        assert set(stage.mix) <= set(ROSTERS) | set(GROUPS)
    assert {"zombie", "skeleton", "creeper", "enderman"} <= set(MOB_CURRICULUM[0].mix)


def test_every_reward_term_has_a_written_farm_loop():
    for term in ("damage", "kill", "clear", "health_left", "shaping"):
        assert FARM_LOOPS[term]


def test_every_farm_loop_earns_less_than_standing_still():
    report = farm_report(seed=HELD_OUT_SEED, n_envs=6, per_arena=1)
    assert set(report["mobs"]) == set(FARM_MIXES)
    for row in report["mobs"].values():
        assert set(row["bots"]) == set(FARM_BOTS)
        for bot in row["bots"].values():
            assert bot["reward_per_step"] < row["idle"]
    assert report["passed"]


@pytest.mark.parametrize("name", KIND_NAMES)
def test_scripted_fighter_clears_the_pass_bar(name):
    env = MobFightEnv(24, {name: 1.0}, seed=HELD_OUT_SEED)
    result = play_rounds(env, lambda _obs: fighter_bot(env), per_arena=2)
    assert result["win_rate"] >= PASS_WIN_RATE


@pytest.mark.parametrize("name", KIND_NAMES)
def test_standing_still_never_wins(name):
    env = MobFightEnv(8, {name: 1.0}, seed=HELD_OUT_SEED)
    assert play_rounds(env, lambda _obs: idle_bot(env), per_arena=1)["wins"] == 0


def test_untrained_expert_fails_the_pass_test():
    env = MobFightEnv(2, seed=16)
    expert = MobExpert.random(env.shared_dim, env.extra_dim, env.action_space.nvec, seed=17)
    report = expert_report(expert, n_envs=8)
    assert set(report["mobs"]) == set(KIND_NAMES)
    assert not report["passed"]


def test_expert_model_trains_on_the_environment():
    env = MobFightEnv(8, seed=18)
    cfg = TrainConfig(n_envs=8, n_steps=16, batch_size=64, n_epochs=1, seed=18)
    model = build_expert_model(env, cfg)
    model.learn(256)
    expert = MobExpert.from_model(model, env)
    obs = env.reset()
    assert expert.logits(obs).shape == (8, int(env.action_space.nvec.sum()))
