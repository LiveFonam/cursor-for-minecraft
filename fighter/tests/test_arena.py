"""Harder scripted fighters, frozen rivals from other runs and the evolution driver."""

from __future__ import annotations

import json
import pickle
from dataclasses import replace

import numpy as np
import pytest
import torch

from fighter import actions as A
from fighter import constants as C
from fighter import evolve as E
from fighter.behaviour import OPPONENTS, RoundTracker, measure
from fighter.campaign import FIGHTER, Runtime, prepare_config, run_role
from fighter.combat import CHARGE_GATE
from fighter.env import RewardConfig
from fighter.experts import ExpertRejected, ExpertStore
from fighter.lean import ActorCritic, EnvSpec, FIGHT, pack_env, unpack_env
from fighter.obs import OBS_DIM, build_masks, build_obs
from fighter.opponents import AXE_HOLD_TICKS, HARD_SCRIPTED, LEAGUE, MAX_RIVALS, OpponentPool, SCRIPTED
from fighter.plans import PLANS, arena_stage
from fighter.policy import NumpyPolicy
from fighter.rivals import Rival, farm_confirmed, load_rival, load_rivals, ready_gate
from fighter.sim import Sim, SimConfig
from fighter.stance import StanceRules
from fighter.train import CURRICULUM

TINY = {
    "smoke": True,
    "n_envs": 4,
    "n_steps": 8,
    "batch_size": 16,
    "fighter_steps": 64,
    "drill_steps": 64,
    "test_every": 32,
    "checkpoint_every": 32,
    "snapshot_every": 32,
}


def fake_run(root, plan="melee", seed=0, blocker=False):
    """Write a run folder with an untrained policy."""
    cfg = prepare_config(root, {**TINY, "plan": plan, "seed": seed})
    folder = root / FIGHTER
    folder.mkdir(parents=True, exist_ok=True)
    policy = NumpyPolicy.random(seed=seed)
    policy.save(folder / "policy.npz")
    versions = {"mob": None, "shooter": None, "blocker": None}
    if blocker:
        versions["blocker"] = ExpertStore(root / "experts").publish(
            "blocker", NumpyPolicy.random(seed=seed + 50), {"passed": True}, (), {"campaign": cfg.id}
        )
    (folder / "policy.json").write_text(json.dumps({"steps": 100, "experts": versions, "campaign": cfg.id}))
    return root


@pytest.mark.parametrize("name", (*HARD_SCRIPTED, "shield_holder"))
def test_hard_fighters_only_use_actions_the_learner_could_choose(name):
    sim = Sim(16, SimConfig(), seed=5)
    rng = np.random.default_rng(5)
    other = np.random.default_rng(6)
    for _ in range(200):
        masks = build_masks(sim, 1)
        chosen = SCRIPTED[name](sim, 1, rng)
        for head, start in enumerate(A.HEAD_OFFSETS):
            assert masks[np.arange(16), start + chosen[:, head]].all()
        sim.step(np.stack([SCRIPTED["swinger"](sim, 0, other), chosen], axis=1))
        done = (sim.hp <= 0.0).any(axis=1)
        if done.any():
            sim.reset(done)


@pytest.mark.parametrize("name", (*HARD_SCRIPTED, "shield_holder"))
def test_hard_fighters_ignore_the_true_position_of_a_hidden_enemy(name, monkeypatch):
    """They steer from what the seat knows, which the world view keeps behind cover."""
    sim = Sim(4, SimConfig(), seed=2)
    known = sim.pos[:, 0].copy()
    calls = []

    def remembered(seat, at):
        calls.append(seat)
        return known[at]

    monkeypatch.setattr(sim.perception, "known_position", remembered)
    first = SCRIPTED[name](sim, 1, np.random.default_rng(1))
    other = Sim(4, SimConfig(), seed=2)
    other.pos[:, 0, 0] += 6.0
    monkeypatch.setattr(other.perception, "known_position", remembered)
    second = SCRIPTED[name](other, 1, np.random.default_rng(1))
    assert calls
    np.testing.assert_array_equal(first[:, [A.FORWARD, A.YAW]], second[:, [A.FORWARD, A.YAW]])


def test_pvp_basic_raises_the_shield_between_swings_and_lowers_it_to_swing():
    sim = Sim(1, SimConfig(armor="none"), seed=1)
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 2.2]
    sim.yaw[0, 1] = 180.0
    rng = np.random.default_rng(1)
    guarded = swung = 0
    for _ in range(60):
        chosen = SCRIPTED["pvp_basic"](sim, 1, rng)
        assert not (chosen[0, A.USE] and chosen[0, A.ATTACK])
        guarded += int(chosen[0, A.USE])
        swung += int(chosen[0, A.ATTACK] > 0)
        sim.step(np.stack([A.neutral_actions(np.array([C.AXE])), chosen], axis=1))
        sim.hp[0] = C.MAX_HEALTH
    assert guarded > 10 and swung >= 3


def test_pvp_combo_switches_to_the_axe_and_disables_a_raised_shield():
    sim = Sim(1, SimConfig(), seed=3)
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 2.3]
    sim.yaw[0, 0] = 0.0
    sim.yaw[0, 1] = 180.0
    rng = np.random.default_rng(3)
    guard = A.neutral_actions(np.array([C.SWORD]))
    guard[0, A.USE] = 1
    disabled = False
    for _ in range(60):
        chosen = SCRIPTED["pvp_combo"](sim, 1, rng)
        sim.step(np.stack([guard, chosen], axis=1))
        sim.pos[0, 0] = [0.0, 0.0, 0.0]
        sim.yaw[0, 0] = 0.0
        sim.hp[0] = C.MAX_HEALTH
        if sim.shield_disabled[0, 0] > 0:
            disabled = True
            break
    assert disabled and sim.weapon[0, 1] == C.AXE


def test_pvp_combo_opens_with_the_crossbow_at_range():
    sim = Sim(4, SimConfig(), seed=4)
    sim.pos[:, 0] = [0.0, 0.0, 0.0]
    sim.pos[:, 1] = [0.0, 0.0, 10.0]
    sim.yaw[:, 1] = 180.0
    rng = np.random.default_rng(4)
    still = A.neutral_actions(sim.weapon[:, 0].copy())
    fired = 0.0
    for _ in range(30):
        chosen = SCRIPTED["pvp_combo"](sim, 1, rng)
        events = sim.step(np.stack([still, chosen], axis=1))
        fired += events["arrows_fired"][:, 1].sum()
        sim.pos[:, 1] = [0.0, 0.0, 10.0]
    assert fired >= 4


def test_pvp_sweat_reacts_a_decision_late():
    sim = Sim(1, SimConfig(), seed=6)
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 6.0]
    rng = np.random.default_rng(0)
    SCRIPTED["pvp_sweat"](sim, 1, rng)
    memory = sim.pvp_memory
    sim.ticks[0] += 2
    sim.pos[0, 0] = [3.0, 0.0, 0.0]
    SCRIPTED["pvp_sweat"](sim, 1, rng)
    np.testing.assert_array_equal(memory.trail[0, 1, 0], [3.0, 0.0, 0.0])
    np.testing.assert_array_equal(memory.trail[0, 1, 1], [0.0, 0.0, 0.0])


def test_memory_clears_when_a_round_restarts():
    sim = Sim(2, SimConfig(), seed=7)
    rng = np.random.default_rng(0)
    for _ in range(10):
        chosen = SCRIPTED["pvp_sweat"](sim, 1, rng)
        sim.step(np.stack([A.neutral_actions(sim.weapon[:, 0].copy()), chosen], axis=1))
    memory = sim.pvp_memory
    memory.crit_planned[:] = True
    sim.reset(np.array([True, False]))
    SCRIPTED["pvp_sweat"](sim, 1, rng)
    assert not memory.crit_planned[0, 1] and memory.crit_planned[1, 1]
    assert (memory.trail[0, 1] == sim.pos[0, 0]).all()


def test_two_calls_in_one_decision_add_one_trail_entry():
    sim = Sim(1, SimConfig(), seed=8)
    SCRIPTED["pvp_sweat"](sim, 1, np.random.default_rng(0))
    first = sim.pvp_memory.trail.copy()
    SCRIPTED["pvp_sweat"](sim, 1, np.random.default_rng(0))
    np.testing.assert_array_equal(first, sim.pvp_memory.trail)


def test_a_hard_fighter_keeps_the_axe_for_a_while_after_a_shield_drops():
    sim = Sim(1, SimConfig(), seed=3)
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 2.3]
    sim.yaw[0, 0] = 0.0
    sim.yaw[0, 1] = 180.0
    sim.shield_ticks[0, 0] = C.SHIELD_RAISE_TICKS
    rng = np.random.default_rng(0)
    axe, sword = A.WEAPON_ACTION[C.AXE], A.WEAPON_ACTION[C.SWORD]
    assert SCRIPTED["pvp_sweat"](sim, 1, rng)[0, A.WEAPON] == axe
    sim.shield_ticks[0, 0] = 0
    sim.ticks[0] += 2
    assert SCRIPTED["pvp_sweat"](sim, 1, rng)[0, A.WEAPON] == axe
    sim.ticks[0] += AXE_HOLD_TICKS
    assert SCRIPTED["pvp_sweat"](sim, 1, rng)[0, A.WEAPON] == sword


def test_hard_fighters_land_real_crits():
    crits = {}
    for name in ("pvp_combo", "pvp_sweat"):
        sim = Sim(32, SimConfig(), seed=9)
        rng = np.random.default_rng(9)
        total = 0.0
        for _ in range(200):
            one = SCRIPTED["swinger"](sim, 0, rng)
            two = SCRIPTED[name](sim, 1, rng)
            total += sim.step(np.stack([one, two], axis=1))["crits"][:, 1].sum()
            done = (sim.hp <= 0.0).any(axis=1)
            if done.any():
                sim.reset(done)
        crits[name] = total
    assert all(value > 0 for value in crits.values())


def test_early_stages_are_unchanged_and_the_final_league_has_the_hard_fighters():
    expected = {
        "targets": {"idle": 1.0, "random": 1.0},
        "chasers": {"walker": 1.0, "swinger": 2.0, "random": 0.5},
        "fighters": {"strafer": 1.0, "critter": 1.0, "swinger": 0.5},
        "tactics": {"shielder": 1.0, "axeman": 1.0, "archer": 1.0, "critter": 0.5},
    }
    for stage in CURRICULUM[:-1]:
        assert stage.mix == expected[stage.name]
    combo = {stage.name: stage.mix for stage in PLANS["combo"].stages[:-1]}
    assert combo["targets"] == {"idle": 1.0, "random": 1.0}
    assert combo["range"] == {"retreater": 1.0, "archer": 1.0, "hit_and_run": 1.0, "rusher": 1.0, "shield_holder": 0.5}
    for plan in PLANS.values():
        for stage in plan.stages[:-1]:
            assert not set(stage.mix) & set(HARD_SCRIPTED)
        assert set(HARD_SCRIPTED) <= set(plan.stages[-1].mix)


def test_behaviour_report_lists_the_hard_fighters():
    assert set(HARD_SCRIPTED) <= set(OPPONENTS)


@pytest.mark.parametrize("plan", sorted(PLANS))
def test_arena_stage_keeps_the_plan_weapons_and_favors_hard_fighters(plan):
    stage = arena_stage(plan)
    assert stage.weapons == PLANS[plan].stages[-1].weapons
    assert "idle" not in stage.mix and "walker" in stage.mix
    assert all(stage.mix[name] > stage.mix["walker"] for name in HARD_SCRIPTED)


def rival_pool(n=8, count=2, seed=1):
    pool = OpponentPool(n, seed=seed)
    rivals = [Rival(f"r{i}", NumpyPolicy.random(seed=i)) for i in range(count)]
    pool.set_rivals(rivals)
    pool.set_mix({LEAGUE: 1.0})
    return pool, rivals


def test_rivals_fill_the_league_when_there_are_no_snapshots():
    pool, _ = rival_pool()
    assert (pool.rival_of >= 0).all() and (pool.snapshot_of < 0).all()
    assert pool.name_of(0).startswith("rival:r")


def test_rivals_share_the_league_with_snapshots():
    pool, _ = rival_pool(n=400)
    pool.add_snapshot(NumpyPolicy.random(seed=9))
    pool.assign(np.ones(400, dtype=bool))
    assert 120 < int((pool.rival_of >= 0).sum()) < 280
    assert ((pool.rival_of >= 0) ^ (pool.snapshot_of >= 0)).all()


def test_a_pool_without_rivals_draws_the_same_opponents_as_before():
    one, two = OpponentPool(32, seed=4), OpponentPool(32, seed=4)
    two.set_rivals([])
    for pool in (one, two):
        pool.add_snapshot(NumpyPolicy.random(seed=2))
        pool.set_mix({LEAGUE: 1.0, "walker": 1.0})
    np.testing.assert_array_equal(one.assigned, two.assigned)
    np.testing.assert_array_equal(one.snapshot_of, two.snapshot_of)


def test_rival_count_is_bounded():
    pool = OpponentPool(4, seed=1)
    with pytest.raises(ValueError):
        pool.set_rivals([Rival(f"r{i}", NumpyPolicy.random(seed=0)) for i in range(MAX_RIVALS + 1)])


def test_harder_rivals_are_picked_more():
    pool, _ = rival_pool(n=4000)
    pool.rival_games[:2] = 100.0
    pool.rival_wins[:2] = [95.0, 10.0]
    pool.assign(np.ones(4000, dtype=bool))
    assert (pool.rival_of == 1).sum() > 3 * (pool.rival_of == 0).sum()


def test_replacing_rivals_keeps_records_by_name_and_redraws_lost_arenas():
    pool, rivals = rival_pool(n=64)
    pool.rival_games[1], pool.rival_wins[1] = 10.0, 3.0
    pool.set_rivals([rivals[1], Rival("new", NumpyPolicy.random(seed=7))])
    assert pool.rival_names == ["r1", "new"]
    assert pool.rival_games[0] == 10.0 and pool.rival_wins[0] == 3.0 and pool.rival_games[1] == 0.0
    assert (pool.rival_of < 2).all() and (pool.rival_of >= 0).all()


def test_rival_reads_the_charge_input_with_its_own_gate():
    sim = Sim(1, SimConfig(ready_gate=C.FULL_CHARGE_THRESHOLD), seed=1)
    sim.weapon[0, 1] = C.AXE
    sim.attack_ticks[0, 1] = 0.87 * 20.0 - 0.5
    assert build_obs(sim, 1)[0, 17] == 1.0
    with ready_gate(sim, CHARGE_GATE):
        assert build_obs(sim, 1)[0, 17] == 0.0
    assert sim.cfg.ready_gate == C.FULL_CHARGE_THRESHOLD


def test_rival_keeps_its_own_weapons_and_stance():
    rival = Rival("r", NumpyPolicy.random(seed=1), {}, StanceRules(), CHARGE_GATE, (C.AXE, C.CROSSBOW))
    sim = Sim(6, SimConfig(), seed=2)
    rows = np.arange(6)
    chosen = rival.act(sim, 1, rows, np.random.default_rng(0))
    picked = A.WEAPON_CHOICES[chosen[:, A.WEAPON]]
    assert set(picked.tolist()) <= {C.CROSSBOW}
    assert rival.megabytes() < 1.0


def test_load_rival_reads_a_run_and_refuses_a_confirmed_farm(tmp_path):
    root = fake_run(tmp_path / "run", "combo", blocker=True)
    rival = load_rival(root)
    assert rival.plan == "combo" and "blocker" in rival.experts and rival.gate == CHARGE_GATE
    (root / FIGHTER / "status.json").write_text(json.dumps({"farm": {"confirmed": {"steps": 1}}}))
    assert farm_confirmed(root)
    with pytest.raises(ExpertRejected):
        load_rival(root)


def test_load_rival_refuses_an_expert_from_another_campaign(tmp_path):
    root = fake_run(tmp_path / "run", blocker=True)
    config = json.loads((root / "campaign.json").read_text())
    config["id"] = "other"
    (root / "campaign.json").write_text(json.dumps(config))
    with pytest.raises(ExpertRejected):
        load_rival(root)


def test_load_rival_refuses_the_wrong_network_shape(tmp_path):
    root = fake_run(tmp_path / "run")
    NumpyPolicy.random(seed=1, obs_dim=OBS_DIM + 3).save(root / FIGHTER / "policy.npz")
    with pytest.raises(ExpertRejected):
        load_rival(root)


def test_load_rivals_skips_itself_broken_runs_and_stays_bounded(tmp_path):
    roots = [fake_run(tmp_path / f"run{i}", seed=i) for i in range(MAX_RIVALS + 2)]
    broken = tmp_path / "broken"
    broken.mkdir()
    logged = []
    rivals = load_rivals([broken, *roots], skip=roots[0], log=lambda *a, **k: logged.append(a))
    assert len(rivals) == MAX_RIVALS and "run0" not in [rival.name for rival in rivals]
    assert logged


def test_loading_a_rival_writes_nothing_in_its_run(tmp_path):
    root = fake_run(tmp_path / "run", blocker=True)
    before = {path: path.read_bytes() for path in root.rglob("*") if path.is_file()}
    load_rival(root).act(Sim(2, SimConfig(), seed=1), 1, np.arange(2), np.random.default_rng(0))
    after = {path: path.read_bytes() for path in root.rglob("*") if path.is_file()}
    assert before == after


def test_checkpoints_leave_rivals_out_and_restore_them_live():
    env = EnvSpec(FIGHT, 8, 3).build()
    rivals = [Rival("a", NumpyPolicy.random(seed=1)), Rival("b", NumpyPolicy.random(seed=2))]
    env.pool.set_rivals(rivals)
    env.pool.set_mix({LEAGUE: 1.0})
    assigned = env.pool.rival_of.copy()
    blob = pack_env(env)
    assert len(blob) < 1_000_000 and b"Rival" not in blob
    unpack_env(env, blob)
    assert [rival.name for rival in env.pool.rivals] == ["a", "b"]
    np.testing.assert_array_equal(env.pool.rival_of, assigned)


def test_a_pool_saved_before_rivals_existed_still_loads():
    pool = OpponentPool(4, seed=1)
    state = pool.__getstate__()
    for key in ("rival_share", "rivals", "rival_names", "rival_of", "rival_games", "rival_wins"):
        state.pop(key)
    old = OpponentPool.__new__(OpponentPool)
    old.__setstate__(state)
    assert old.rivals == [] and (old.rival_of == -1).all()


def test_campaign_trains_against_rivals_and_resumes_exactly(tmp_path):
    rival = fake_run(tmp_path / "rival", "foundations", seed=3)
    def make(name):
        root = tmp_path / name
        prepare_config(root, {**TINY, "arena": True, "reward": {"crit": 0.08}, "plan": "combo"})
        config = json.loads((root / "campaign.json").read_text())
        config["id"] = "same"
        (root / "campaign.json").write_text(json.dumps(config))
        return root
    rt = {"threads": 1, "min_free_gb": 0.0, "fighter_device": "cpu", "rivals": [str(rival)]}
    whole, parts = make("whole"), make("parts")
    assert run_role(whole, FIGHTER, Runtime(**rt)) == 0
    assert run_role(parts, FIGHTER, Runtime(**rt, max_rollouts=1)) == 3
    assert run_role(parts, FIGHTER, Runtime(**rt)) == 0
    one, two = NumpyPolicy.load(whole / FIGHTER / "policy.npz"), NumpyPolicy.load(parts / FIGHTER / "policy.npz")
    for (w, b), (w2, b2) in zip(one.layers, two.layers):
        np.testing.assert_array_equal(w, w2)
        np.testing.assert_array_equal(b, b2)
    events = [json.loads(line)["event"] for line in (parts / "decisions.jsonl").read_text().splitlines()]
    assert "loaded rivals" in events and "resumed" in events


def test_child_reward_reaches_the_env_and_the_farm_replay():
    spec = EnvSpec(FIGHT, 2, 0, False, "combo", (("crit", 0.33),))
    env = spec.build()
    assert env.reward_cfg.crit == 0.33 and env.reward_cfg.followup == PLANS["combo"].reward["followup"]


def test_start_weights_are_loaded_and_join_the_league(tmp_path):
    root = tmp_path / "child"
    prepare_config(root, {**TINY, "arena": True})
    (root / FIGHTER).mkdir()
    model = ActorCritic(OBS_DIM, int(A.NVEC.sum()))
    for parameter in model.parameters():
        parameter.data.fill_(0.01)
    torch.save({"model": model.state_dict()}, root / FIGHTER / "start.pt")
    seen = {}

    def peek(role):
        seen.setdefault("league", len(role.runner.trainer.snapshots))
        seen.setdefault("weight", float(role.runner.trainer.league.members[0][0][0][0, 0]))

    assert run_role(root, FIGHTER, Runtime(threads=1, min_free_gb=0.0, fighter_device="cpu", max_rollouts=1), after_rollout=peek) == 3
    assert seen["league"] >= 1 and seen["weight"] == pytest.approx(0.01)
    events = [json.loads(line)["event"] for line in (root / "decisions.jsonl").read_text().splitlines()]
    assert "started from parent weights" in events


def row(win, draw=0.0):
    games = 100
    wins, draws = round(win * games), round(draw * games)
    return E.rates(wins, draws, games - wins - draws)


def test_a_draw_scores_below_a_loss():
    assert E.matchup_score(row(0.0, 1.0)) < E.matchup_score(row(0.0, 0.0))


def test_one_easy_opponent_cannot_hide_a_weak_one():
    even = [0.6] * 14
    spiky = [1.0] * 11 + [0.0] * 3
    assert np.mean(spiky) > np.mean(even)
    assert E.worst_share(spiky) < E.worst_share(even)


def test_worst_share_uses_at_least_three_opponents():
    assert E.worst_share([0.0, 1.0, 1.0, 1.0]) == pytest.approx(2 / 3)


def test_draw_heavy_detection():
    assert E.is_draw_heavy({"walker": row(0.0, 1.0), "strafer": row(1.0)})
    assert E.is_draw_heavy({f"o{i}": row(0.7, 0.3) for i in range(4)})
    assert not E.is_draw_heavy({"walker": row(0.9, 0.1), "strafer": row(0.8, 0.1)})


def test_a_draw_heavy_fighter_ranks_below_a_weaker_clean_one():
    names = ["drawer", "clean"]
    named = {
        "drawer": {"walker": row(0.0, 1.0), "strafer": row(0.95), "shielder": row(0.95)},
        "clean": {"walker": row(0.4), "strafer": row(0.4), "shielder": row(0.4)},
    }
    table = E.rank_members(names, named, {("clean", "drawer"): (5, 20, 7)})
    assert [entry["id"] for entry in table] == ["clean", "drawer"]
    assert table[1]["draw_heavy"]


def test_a_farmed_fighter_ranks_last_and_is_never_kept():
    names = ["farmer", "fair"]
    named = {"farmer": {"walker": row(1.0)}, "fair": {"walker": row(0.3)}}
    table = E.rank_members(names, named, {("fair", "farmer"): (0, 0, 32)}, {"farmer"})
    assert table[0]["id"] == "fair"
    assert E.keep_best(table, {"farmer": "a", "fair": "b"}, 2, 2) == ["fair"]


def test_ratings_follow_results_and_are_centered():
    ratings = E.fit_ratings(["a", "b", "c"], {("a", "b"): (24, 0, 8), ("b", "c"): (24, 0, 8), ("a", "c"): (28, 0, 4)})
    assert ratings["a"] > ratings["b"] > ratings["c"]
    assert np.mean(list(ratings.values())) == pytest.approx(1500.0, abs=1.0)


def test_rating_handles_a_clean_sweep():
    ratings = E.fit_ratings(["a", "b"], {("a", "b"): (32, 0, 0)})
    assert np.isfinite(list(ratings.values())).all() and ratings["a"] > ratings["b"]


def test_keep_best_limits_one_founder_but_fills_the_population():
    table = [
        {"id": name, "farm": False} for name in ("a1", "a2", "a3", "b1")
    ]
    founders = {"a1": "a", "a2": "a", "a3": "a", "b1": "b"}
    assert E.keep_best(table, founders, 3, 2) == ["a1", "a2", "b1"]
    assert E.keep_best(table, founders, 4, 2) == ["a1", "a2", "b1", "a3"]


def test_mutation_changes_few_shaping_weights_within_bounds():
    base = RewardConfig(**PLANS["combo"].reward)
    current = {}
    rng = np.random.default_rng(0)
    for _ in range(300):
        current, changes = E.mutate_reward("combo", current, rng, 2, 0.5)
        assert len(changes) == 2
        assert set(changes) <= set(E.MUTABLE)
    for key, value in current.items():
        low, high = E.ABSOLUTE_LIMITS.get(key, (0.5 * getattr(base, key), 2.0 * getattr(base, key)))
        assert low - 1e-9 <= value <= high + 1e-9
    assert not {"win", "damage_dealt", "damage_taken", "timeout_margin"} & set(current)


def test_weight_noise_is_off_by_default_and_only_touches_the_actor():
    model = ActorCritic(OBS_DIM, int(A.NVEC.sum()))
    state = model.state_dict()
    assert E.add_weight_noise(state, 0.0, np.random.default_rng(0)) is state
    noisy = E.add_weight_noise(state, 0.1, np.random.default_rng(0))
    assert not torch.equal(noisy["pi.0.weight"], state["pi.0.weight"])
    assert torch.equal(noisy["vf.0.weight"], state["vf.0.weight"])
    assert torch.equal(noisy["pi.0.bias"], state["pi.0.bias"])


def test_starting_weights_use_the_critic_only_when_the_checkpoint_matches(tmp_path):
    root = tmp_path / "run"
    (root / FIGHTER).mkdir(parents=True)
    model = ActorCritic(OBS_DIM, int(A.NVEC.sum()))
    model.to_policy().save(root / FIGHTER / "policy.npz")
    import io

    nets = io.BytesIO()
    torch.save({"model": model.state_dict(), "optimizer": {}}, nets)
    (root / FIGHTER / "checkpoint.pkl").write_bytes(pickle.dumps({"runner": {"nets": nets.getvalue()}}))
    same = E.starting_weights(root)
    assert torch.equal(same["vf.0.weight"], model.state_dict()["vf.0.weight"])
    other = ActorCritic(OBS_DIM, int(A.NVEC.sum()))
    other.to_policy().save(root / FIGHTER / "policy.npz")
    fresh = E.starting_weights(root)
    assert torch.equal(fresh["pi.0.weight"], other.state_dict()["pi.0.weight"])
    assert not torch.equal(fresh["vf.0.weight"], model.state_dict()["vf.0.weight"])


def small_config(parents, **extra):
    base = dict(
        parents=[str(path) for path in parents],
        generations=1,
        population=2,
        n_parents=1,
        children=1,
        child_steps=64,
        rivals=2,
        test_games=2,
        tournament_games=2,
        n_envs=4,
        n_steps=8,
        batch_size=16,
        checkpoint_every=32,
        snapshot_every=32,
        retest_games=2,
    )
    return E.EvolveConfig(**{**base, **extra})


class FinishedProcess:
    """Stands in for a child process that already ran."""

    def __init__(self, code):
        self.code = code

    def poll(self):
        return self.code

    def send_signal(self, signum):
        return None

    def wait(self, timeout=None):
        return self.code


def fast_opponents(monkeypatch):
    """Test two opponents and run each child inside this one Python process."""

    def run_inline(self, member, rivals):
        runtime = replace(self._child_runtime(rivals), parent=0)
        return FinishedProcess(run_role(self.folder(member), FIGHTER, runtime))

    monkeypatch.setattr(E, "OPPONENTS", ("idle", "walker"))
    monkeypatch.setattr(E.Evolution, "_spawn", run_inline)


def test_founders_are_copied_and_parent_runs_are_left_alone(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    parent = fake_run(tmp_path / "parent", "combo", blocker=True)
    before = {path: path.read_bytes() for path in parent.rglob("*") if path.is_file()}
    driver = E.Evolution(tmp_path / "evo", small_config([parent], generations=0), E.EvolveRuntime(min_free_gb=0.0))
    (tmp_path / "evo").mkdir()
    assert driver.run() == 0
    after = {path: path.read_bytes() for path in parent.rglob("*") if path.is_file()}
    assert before == after
    member = driver.folder("g00-00")
    assert load_rival(member).plan == "combo"
    assert (member / FIGHTER / "final.pt").exists()


def test_a_parent_with_a_confirmed_farm_is_not_imported(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    good = fake_run(tmp_path / "good")
    bad = fake_run(tmp_path / "bad", seed=1)
    (bad / FIGHTER / "status.json").write_text(json.dumps({"farm": {"confirmed": {"steps": 1}}}))
    driver = E.Evolution(tmp_path / "evo", small_config([bad, good], generations=0), E.EvolveRuntime(min_free_gb=0.0))
    (tmp_path / "evo").mkdir()
    assert driver.run() == 0
    assert list(driver.state["members"]) == ["g00-01"]


def test_evolution_runs_logs_each_child_and_resumes_after_a_stop(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    parents = [fake_run(tmp_path / "p0", "combo", seed=1, blocker=True), fake_run(tmp_path / "p1", "melee", seed=2)]
    root = tmp_path / "evo"
    root.mkdir()
    cfg = small_config(parents)
    stopped = E.Evolution(root, cfg, E.EvolveRuntime(threads=1, min_free_gb=0.0, max_rollouts=1))
    assert stopped.run() == 3
    assert stopped.state["phase"] == "train" and not (root / "members" / "g01-00" / FIGHTER / "final.pt").exists()
    played = len((root / "matches.jsonl").read_text().splitlines())

    resumed = E.Evolution(root, cfg, E.EvolveRuntime(threads=1, min_free_gb=0.0))
    assert resumed.run() == 0
    state = json.loads((root / "state.json").read_text())
    assert state["generation"] == 1 and state["phase"] == "done"
    assert len([row for row in state["members"].values() if row["status"] == "alive"]) == 2
    child = state["members"]["g01-00"]
    assert child["parent"] in ("g00-00", "g00-01") and len(child["changes"]) == 2
    logged = [json.loads(line) for line in (root / "log.jsonl").read_text().splitlines()]
    scored = [line for line in logged if line["event"] == "scored" and line["id"] == "g01-00"]
    assert scored and scored[0]["changes"] == child["changes"] and set(scored[0]["win_rates"]) == {"idle", "walker"}
    assert "fitness" in scored[0] and scored[0]["parent"] == child["parent"]
    keys = [json.loads(line)["key"] for line in (root / "matches.jsonl").read_text().splitlines()]
    assert len(keys) == len(set(keys)) and len(keys) > played
    decisions = [json.loads(line)["event"] for line in (root / "members" / "g01-00" / "decisions.jsonl").read_text().splitlines()]
    assert "started from parent weights" in decisions and "resumed" in decisions and "loaded rivals" in decisions


def test_a_child_with_a_confirmed_farm_is_retired_before_ranking(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    parent = fake_run(tmp_path / "parent", seed=1)
    root = tmp_path / "evo"
    root.mkdir()
    driver = E.Evolution(root, small_config([parent]), E.EvolveRuntime(threads=1, min_free_gb=0.0))
    driver.load()
    driver.import_founders()
    driver.rank_generation()
    driver.state["generation"] = 1
    driver.breed()
    folder = driver.folder("g01-00") / FIGHTER
    (folder / "status.json").write_text(
        json.dumps({"state": "done", "steps": 64, "farm": {"confirmed": {"steps": 32}}})
    )
    driver.train_children()
    assert driver.state["members"]["g01-00"]["status"] == "retired"
    assert driver.state["members"]["g01-00"]["reason"] == "confirmed reward farm"
    driver.rank_generation()
    assert "g01-00" not in driver.state["ranking"]


def test_a_crash_in_the_middle_of_a_build_leaves_a_clean_retry(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    parent = fake_run(tmp_path / "parent", seed=1)
    root = tmp_path / "evo"
    root.mkdir()
    driver = E.Evolution(root, small_config([parent]), E.EvolveRuntime(threads=1, min_free_gb=0.0))
    driver.load()
    (root / "members" / ".build-g01-00").mkdir()
    (root / "members" / "g00-00").mkdir()
    driver.load()
    assert not (root / "members" / ".build-g01-00").exists()
    driver.import_founders()
    assert load_rival(driver.folder("g00-00")).name == "g00-00"


def test_the_plan_of_a_generation_is_written_once(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    parent = fake_run(tmp_path / "parent", seed=1)
    root = tmp_path / "evo"
    root.mkdir()
    cfg = small_config([parent], children=2, population=3)
    driver = E.Evolution(root, cfg, E.EvolveRuntime(threads=1, min_free_gb=0.0))
    driver.load()
    driver.import_founders()
    driver.rank_generation()
    driver.state["generation"] = 1
    first = driver._plan_children(1)
    assert first == driver._plan_children(1)
    assert all(child["parent"] == "g00-00" for child in first["children"])


def ranking_driver(tmp_path, monkeypatch, **runtime):
    fast_opponents(monkeypatch)
    parents = [fake_run(tmp_path / "p0", "combo", seed=1, blocker=True), fake_run(tmp_path / "p1", "melee", seed=2)]
    root = tmp_path / "evo"
    root.mkdir()
    cfg = small_config(parents, frozen=[str(fake_run(tmp_path / "r0", "melee", seed=3))], test_games=4, tournament_games=4)
    driver = E.Evolution(root, cfg, E.EvolveRuntime(threads=1, min_free_gb=0.0, **runtime))
    driver.load()
    driver.import_founders()
    return driver


def test_ranking_starts_no_worker_process_by_default(tmp_path, monkeypatch):
    driver = ranking_driver(tmp_path, monkeypatch, parallel=3)

    def refuse(*args, **kwargs):
        raise AssertionError("ranking started a worker pool")

    monkeypatch.setattr(E, "ProcessPoolExecutor", refuse)
    driver.play_all(driver.alive())
    assert len(driver.matches) == 2 * 2 + 1 + 2


def test_ranking_results_do_not_depend_on_workers_or_order(tmp_path, monkeypatch):
    driver = ranking_driver(tmp_path, monkeypatch, rank_parallel=2)
    tasks = driver._tasks(driver.alive())
    inline = {task["key"]: E.play_task(task)["result"] for task in reversed(tasks)}
    driver._run_tasks(tasks)
    assert {key: row["result"] for key, row in driver.matches.items()} == inline


def test_settings_are_fixed_apart_from_generations(tmp_path):
    root = tmp_path / "evo"
    root.mkdir()
    E.prepare(root, {"parents": ["a"], "generations": 2})
    assert E.prepare(root, {"generations": 5}).generations == 5
    with pytest.raises(SystemExit):
        E.prepare(root, {"children": 9})


def test_rival_match_counts_each_side(tmp_path):
    first = load_rival(fake_run(tmp_path / "a", seed=1), "a")
    second = load_rival(fake_run(tmp_path / "b", seed=2), "b")
    report = measure(first.policy, "b", first.interface(), PLANS[first.plan], 11, n_envs=4, games_per_arena=1, rival=second)
    assert report["games"] == 4 and report["win_rate"] + report["draw_rate"] + report["loss_rate"] == pytest.approx(1.0)


def holder_duel(seed=1):
    sim = Sim(1, SimConfig(armor="none"), seed=seed)
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 2.3]
    sim.yaw[0, 0] = 0.0
    sim.yaw[0, 1] = 180.0
    return sim, np.random.default_rng(seed)


def test_shield_holder_keeps_the_shield_up_and_never_swings_until_it_is_disabled():
    sim, rng = holder_duel()
    idle_axe = A.neutral_actions(np.array([C.AXE]))
    for step in range(40):
        chosen = SCRIPTED["shield_holder"](sim, 1, rng)
        assert chosen[0, A.USE] == 1 and chosen[0, A.ATTACK] == 0
        sim.step(np.stack([idle_axe, chosen], axis=1))
        if step >= 3:
            assert sim.shield_active[0, 1]
    assert sim.hp[0, 0] == C.MAX_HEALTH


def test_shield_holder_fights_while_disabled_and_raises_the_shield_after_the_cooldown():
    sim, rng = holder_duel()
    idle_axe = A.neutral_actions(np.array([C.AXE]))
    for _ in range(5):
        sim.step(np.stack([idle_axe, SCRIPTED["shield_holder"](sim, 1, rng)], axis=1))
    assert sim.shield_active[0, 1]
    swing = idle_axe.copy()
    swing[0, A.ATTACK] = A.ATTACK_CLICK
    sim.step(np.stack([swing, SCRIPTED["shield_holder"](sim, 1, rng)], axis=1))
    assert sim.shield_disabled[0, 1] > 0
    swung = False
    while sim.shield_disabled[0, 1] > 0:
        chosen = SCRIPTED["shield_holder"](sim, 1, rng)
        assert chosen[0, A.USE] == 0
        swung |= bool(chosen[0, A.ATTACK] > 0)
        sim.step(np.stack([idle_axe, chosen], axis=1))
        sim.hp[0] = C.MAX_HEALTH
    assert swung
    assert SCRIPTED["shield_holder"](sim, 1, rng)[0, A.USE] == 1


def test_shield_holder_fights_on_once_its_shield_is_gone():
    sim, rng = holder_duel()
    sim.combat.has_shield[0, 1] = False
    sim.attack_ticks[0, 1] = 40.0
    chosen = SCRIPTED["shield_holder"](sim, 1, rng)
    assert chosen[0, A.USE] == 0 and chosen[0, A.ATTACK] > 0


def test_shield_holder_is_in_the_shield_late_and_report_lists_and_shielder_stays():
    assert {"shield_holder", "shielder"} <= set(OPPONENTS)
    combo = {stage.name: stage.mix for stage in PLANS["combo"].stages}
    assert combo["shield_break"]["shield_holder"] > 0.0 and combo["shield_break"]["shielder"] > 0.0
    assert combo["range"]["shield_holder"] > 0.0 and combo["league"]["shield_holder"] > 0.0
    for name in ("melee", "foundations"):
        assert PLANS[name].stages[-1].mix["shield_holder"] > 0.0


@pytest.mark.parametrize("plan", sorted(PLANS))
def test_the_arena_mix_keeps_the_focus_opponents_when_it_adapts(plan):
    stage = arena_stage(plan)
    assert set(stage.keep) == {"shield_holder", "rusher", "axeman", "pvp_combo", "pvp_sweat"}
    assert all(stage.mix[name] == weight for name, weight in stage.keep.items())


def tracker_events(n=1, **values):
    names = ("arrows_fired", "arrow_hits", "shield_breaks", "hits", "arrows_wasted")
    ev = {name: np.zeros((n, 2)) for name in names}
    for name, value in values.items():
        ev[name][:, 0] = value
    return ev


def tracker_step(track, tick, loaded=True, held=C.AXE, load=0, **events):
    live = np.ones(1, dtype=bool)
    track.step(live, np.array([tick]), np.array([loaded]), np.array([load]), np.array([held]), tracker_events(**events))


def test_tracker_counts_a_load_started_in_the_first_two_decisions_and_loaded_by_tick_40():
    early = RoundTracker(1)
    tracker_step(early, 2, loaded=False, held=C.CROSSBOW, load=2)
    tracker_step(early, 38, loaded=True, held=C.CROSSBOW)
    early.finish(np.array([0]), np.ones(1, dtype=bool))
    assert early.totals["load_started_2"] == 1.0 and early.totals["loaded_by_40"] == 1.0
    late = RoundTracker(1)
    for tick in (2, 4):
        tracker_step(late, tick, loaded=False)
    tracker_step(late, 6, loaded=False, held=C.CROSSBOW, load=2)
    tracker_step(late, 42, loaded=True, held=C.CROSSBOW)
    late.finish(np.array([0]), np.ones(1, dtype=bool))
    assert late.totals["load_started_2"] == 0.0 and late.totals["loaded_by_40"] == 0.0


def test_tracker_counts_follow_up_shots_only_inside_their_windows():
    track = RoundTracker(1)
    tracker_step(track, 10, shield_breaks=1)
    tracker_step(track, 14, held=C.CROSSBOW, arrows_fired=1, arrow_hits=1)
    assert track.totals["followup_chances_disable"] == 1.0
    assert track.totals["followup_shots_disable"] == 1.0 and track.totals["followup_hits"] == 1.0
    tracker_step(track, 30, shield_breaks=1)
    tracker_step(track, 60, held=C.CROSSBOW, arrows_fired=1)
    assert track.totals["followup_shots_disable"] == 1.0
    tracker_step(track, 70, hits=1)
    tracker_step(track, 85, held=C.CROSSBOW, arrows_fired=1)
    assert track.totals["followup_chances_knockback"] == 1.0 and track.totals["followup_shots_knockback"] == 1.0


def test_tracker_ignores_a_set_up_without_a_loaded_crossbow_and_clears_between_rounds():
    track = RoundTracker(1)
    tracker_step(track, 10, loaded=False, shield_breaks=1)
    tracker_step(track, 12, held=C.CROSSBOW, arrows_fired=1)
    assert track.totals["followup_chances_disable"] == 0.0 and track.totals["followup_shots_disable"] == 0.0
    tracker_step(track, 20, shield_breaks=1)
    track.finish(np.array([0]), np.ones(1, dtype=bool))
    tracker_step(track, 2, held=C.CROSSBOW, arrows_fired=1)
    assert track.totals["followup_shots_disable"] == 0.0


def test_an_arrow_inside_the_hurt_window_that_removes_nothing_counts_as_wasted():
    sim = Sim(1, SimConfig(armor="none"), seed=4)
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 3.0]
    sim.yaw[0, 0] = 0.0
    sim.pitch[0, 0] = 0.0
    sim.weapon[0, 0] = C.CROSSBOW
    sim.loaded[0, 0] = True
    sim.hurt_timer[0, 1] = C.HURT_TICKS
    sim.last_damage[0, 1] = 1000.0
    hp = sim.hp[0, 1]
    shot = A.neutral_actions(np.array([C.CROSSBOW]))
    shot[0, A.USE] = 1
    still = A.neutral_actions(np.array([C.SWORD]))
    wasted = 0.0
    for action in (shot, A.neutral_actions(np.array([C.CROSSBOW])), A.neutral_actions(np.array([C.CROSSBOW]))):
        wasted += sim.step(np.stack([action, still], axis=1))["arrows_wasted"][0, 0]
    assert wasted == 1.0 and sim.hp[0, 1] == hp


def bar_row(win, disables=0.0, draw=0.0):
    out = row(win, draw)
    out["behaviour"] = {"shield_disables": disables}
    return out


def test_requirement_bars_read_each_named_opponent():
    rows = {"shield_holder": bar_row(0.9, 1.2), "rusher": bar_row(0.5), "axeman": bar_row(0.8)}
    bars = E.requirement_bars(rows)
    assert bars["shield_holder:shield_disables"]["met"] and bars["shield_holder:win"]["met"]
    assert not bars["rusher:win"]["met"] and bars["axeman:win"]["met"]
    assert bars["rusher:win"]["progress"] == pytest.approx(0.5 / 0.85, abs=1e-3)
    assert E.requirement_score({}) == 1.0
    assert E.requirement_score(bars) < 1.0


def test_a_fighter_that_breaks_shields_outranks_one_that_only_beats_easy_opponents():
    base = {name: bar_row(1.0) for name in ("walker", "strafer", "archer")}
    names = ["passive", "breaker"]
    named = {
        "passive": {**base, "shield_holder": bar_row(0.0, 0.0), "rusher": bar_row(1.0), "axeman": bar_row(1.0)},
        "breaker": {**base, "shield_holder": bar_row(0.85, 1.4), "rusher": bar_row(0.86), "axeman": bar_row(0.81)},
    }
    table = E.rank_members(names, named, {("breaker", "passive"): (16, 0, 16)})
    assert table[0]["id"] == "breaker" and table[0]["bars_met"] and not table[1]["bars_met"]


def test_weak_rusher_or_axeman_results_lower_fitness():
    good = {"shield_holder": bar_row(0.9, 1.5), "rusher": bar_row(0.9), "axeman": bar_row(0.9)}
    weak = {**good, "axeman": bar_row(0.4)}
    table = E.rank_members(["good", "weak"], {"good": good, "weak": weak}, {("good", "weak"): (8, 0, 8)})
    scores = {entry["id"]: entry["fitness"] for entry in table}
    assert scores["good"] > scores["weak"] + 0.1


def test_weight_effects_group_children_by_direction_and_keep_controls_apart():
    move = {"walker": {"games": 64, "win": [0.5, 0.75], "shield_disables": [0.0, 1.0]}}
    children = [
        {"id": "c0", "changes": {}, "opponents": move},
        {"id": "up", "changes": {"crit": [0.1, 0.2]}, "opponents": move},
        {"id": "down", "changes": {"crit": [0.2, 0.1]}, "opponents": move},
    ]
    effects = E.weight_effects(children)
    assert effects["control"]["none"]["children"] == ["c0"]
    assert effects["crit"]["up"]["children"] == ["up"] and effects["crit"]["down"]["children"] == ["down"]
    assert effects["crit"]["up"]["screen_mean_move"]["win:walker"] == pytest.approx(0.25)
    assert effects["crit"]["up"]["screen_mean_move"]["shield_disables:walker"] == pytest.approx(1.0)


def test_evolution_logs_weight_moves_with_a_control_and_trains_against_frozen_rivals(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    parent = fake_run(tmp_path / "p0", "combo", seed=1, blocker=True)
    other = fake_run(tmp_path / "other", "foundations", seed=2)
    root = tmp_path / "evo"
    root.mkdir()
    cfg = small_config([parent], children=2, controls=1, changes=1, population=3, frozen=[str(other)])
    driver = E.Evolution(root, cfg, E.EvolveRuntime(threads=1, min_free_gb=0.0))
    assert driver.run() == 0
    state = json.loads((root / "state.json").read_text())
    assert state["members"]["r00-00"]["status"] == "frozen"
    assert "r00-00" not in state["ranking"]
    rows = json.loads((root / "gen-01" / "weights.json").read_text())
    assert sorted(row["control"] for row in rows) == [False, True]
    changed = next(row for row in rows if not row["control"])
    assert len(changed["changes"]) == 1 and set(changed["opponents"]) == {"idle", "walker"}
    assert set(changed["opponents"]["walker"]) >= {"games", "win", "shield_disables", "load_started_2", "shots_wasted_hurt"}
    effects = json.loads((root / "weight_effects.json").read_text())
    assert "control" in effects and next(iter(changed["changes"])) in effects
    report = json.loads((root / "gen-01" / "report.json").read_text())
    assert all("r00-00" in entry["frozen_rivals"] for entry in report["table"])
    decisions = [json.loads(line) for line in (root / "members" / "g01-00" / "decisions.jsonl").read_text().splitlines()]
    loaded = next(line for line in decisions if line["event"] == "loaded rivals")
    assert "r00-00" in loaded["rivals"]


def test_single_change_children_each_test_a_different_weight(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    parent = fake_run(tmp_path / "parent", "combo", seed=1)
    root = tmp_path / "evo"
    root.mkdir()
    size = len(E.MUTABLE) + 1
    cfg = small_config([parent], children=size, controls=1, changes=1, population=size)
    driver = E.Evolution(root, cfg, E.EvolveRuntime(threads=1, min_free_gb=0.0))
    driver.load()
    driver.import_founders()
    driver.rank_generation()
    children = driver._plan_children(1)["children"]
    assert children[0]["changes"] == {}
    tested = [key for child in children[1:] for key in child["changes"]]
    assert sorted(tested) == sorted(E.MUTABLE)


@pytest.mark.parametrize("key", E.MUTABLE)
def test_every_mutation_has_a_meaningful_size_and_stays_in_bounds(key):
    base = RewardConfig(**PLANS["combo"].reward)
    rng = np.random.default_rng(3)
    current = {}
    for _ in range(300):
        current, changes = E.mutate_reward("combo", current, rng, 1, 0.25, (key,))
        old, new = changes[key]
        low, high = E.ABSOLUTE_LIMITS.get(key, (0.5 * getattr(base, key), 2.0 * getattr(base, key)))
        assert low - 1e-9 <= new <= high + 1e-9
        if key in E.MIN_ABSOLUTE:
            assert abs(new - old) >= E.MIN_ABSOLUTE[key] - 1e-6
        else:
            assert max(new / old, old / new) >= 1.0 + E.MIN_CHANGE - 1e-3


def two_line_driver(tmp_path, monkeypatch, children=12, controls=1):
    fast_opponents(monkeypatch)
    parents = [fake_run(tmp_path / "p0", "combo", seed=1), fake_run(tmp_path / "p1", "combo", seed=2)]
    root = tmp_path / "evo"
    root.mkdir()
    cfg = small_config(parents, children=children, controls=controls, changes=1, population=6, n_parents=3, max_per_founder=3)
    driver = E.Evolution(root, cfg, E.EvolveRuntime(threads=1, min_free_gb=0.0))
    driver.load()
    driver.import_founders()
    return driver


def test_children_are_split_between_both_lines_with_one_control_each(tmp_path, monkeypatch):
    driver = two_line_driver(tmp_path, monkeypatch)
    driver.rank_generation()
    children = driver._plan_children(1)["children"]
    for parent in ("g00-00", "g00-01"):
        line = [child for child in children if child["parent"] == parent]
        assert len(line) == 6 and sum(not child["changes"] for child in line) == 1
    tested = [key for child in children for key in child["changes"]]
    assert sorted(tested) == sorted(E.MUTABLE)


def test_a_draw_heavy_founder_keeps_its_line(tmp_path, monkeypatch):
    driver = two_line_driver(tmp_path, monkeypatch)
    monkeypatch.setattr(E, "is_draw_heavy", lambda rows: True)
    driver.rank_generation()
    assert set(driver.state["line_parents"].values()) == {"g00-00", "g00-01"}
    assert {child["parent"] for child in driver._plan_children(1)["children"]} == {"g00-00", "g00-01"}


def retest_row(wins, draws=0, games=256):
    return E.rates(wins, draws, games - wins - draws)


def test_a_small_gain_is_noise_and_a_large_gain_is_credited():
    focus = ("shield_holder", "rusher", "axeman", "pvp_combo", "pvp_sweat")
    control = {name: retest_row(128) for name in focus}
    small = {name: retest_row(133) for name in focus}
    large = {name: retest_row(170) for name in focus}
    assert not E.credit_child(small, control, 4)["credited"]
    judged = E.credit_child(large, control, 4)
    assert judged["credited"] and judged["gain"] > judged["margin"] and not judged["drops"]


def test_a_gain_that_breaks_another_opponent_is_not_credited():
    focus = ("shield_holder", "rusher", "axeman", "pvp_combo", "pvp_sweat")
    control = {**{name: retest_row(128) for name in focus}, "walker": retest_row(256)}
    child = {**{name: retest_row(190) for name in focus}, "walker": retest_row(200)}
    judged = E.credit_child(child, control, 4)
    assert judged["gain"] > judged["margin"] and "walker" in judged["drops"] and not judged["credited"]


def test_more_children_tested_widens_the_margin():
    focus = ("rusher", "axeman")
    control = {name: retest_row(128) for name in focus}
    child = {name: retest_row(140) for name in focus}
    assert E.credit_child(child, control, 10)["margin"] > E.credit_child(child, control, 1)["margin"]


def retest_driver(tmp_path, monkeypatch, wins):
    """Build one line with a parent, a control and two changed children, with made-up retests."""
    monkeypatch.setattr(E, "OPPONENTS", ("rusher", "axeman"))
    root = tmp_path / "evo"
    root.mkdir()
    cfg = small_config(["unused"], retest_games=256, retest_top=2)
    driver = E.Evolution(root, cfg, E.EvolveRuntime(threads=1, min_free_gb=0.0))
    driver.load()
    def member(generation, parent, changes):
        return {"generation": generation, "parent": parent, "founder": "g00-00", "changes": changes, "status": "alive"}
    driver.state["members"] = {
        "g00-00": member(0, None, {}),
        "g01-00": member(1, "g00-00", {}),
        "g01-01": member(1, "g00-00", {"crit": [0.15, 0.3]}),
        "g01-02": member(1, "g00-00", {"aim": [0.02, 0.03]}),
    }
    driver.state["line_parents"] = {"g00-00": "g00-00"}
    tasks = []

    def fake_play(task):
        tasks.append(task)
        return {"key": task["key"], "result": retest_row(wins[task["a"]])}

    monkeypatch.setattr(E, "play_task", fake_play)
    table = [{"id": name} for name in ("g01-01", "g01-02", "g01-00", "g00-00")]
    return driver, table, tasks


def test_retest_uses_fresh_seeds_and_promotes_a_child_only_past_the_margin(tmp_path, monkeypatch):
    wins = {"g00-00": 120, "g01-00": 130, "g01-01": 135, "g01-02": 200}
    driver, table, tasks = retest_driver(tmp_path, monkeypatch, wins)
    chosen, credits = driver._select_parents(1, table)
    assert chosen == {"g00-00": "g01-02"}
    assert not credits["g01-01"]["credited"] and credits["g01-02"]["credited"]
    assert len(tasks) == 8 and all(task["games"] == 256 for task in tasks)
    seeds = {(task["a"], task["scripted"]): task["seed"] for task in tasks}
    assert seeds["g01-00", "rusher"] == seeds["g01-02", "rusher"]
    assert seeds["g01-00", "rusher"] != E.stable_seed(E.SCRIPTED_TAG, "rusher")
    saved = json.loads((driver.gen_dir(1) / "retest.json").read_text())
    assert saved["members"]["g01-02"]["opponents"]["rusher"]["games"] == 256


def test_the_control_takes_over_when_no_child_is_credited(tmp_path, monkeypatch):
    wins = {"g00-00": 120, "g01-00": 130, "g01-01": 135, "g01-02": 132}
    driver, table, _ = retest_driver(tmp_path, monkeypatch, wins)
    assert driver._select_parents(1, table)[0] == {"g00-00": "g01-00"}


def test_the_parent_stays_when_its_control_got_worse(tmp_path, monkeypatch):
    wins = {"g00-00": 150, "g01-00": 110, "g01-01": 115, "g01-02": 112}
    driver, table, _ = retest_driver(tmp_path, monkeypatch, wins)
    assert driver._select_parents(1, table)[0] == {"g00-00": "g00-00"}


def test_keep_parents_holds_a_low_ranked_parent_and_the_population_size():
    assert E.keep_parents(["a", "b", "c"], ["d"], 3) == ["a", "b", "d"]
    assert E.keep_parents(["a", "b"], ["a"], 3) == ["a", "b"]


def test_required_bars_sit_above_both_parents_on_the_hard_fighters():
    bars = {(name, metric): target for name, metric, target in E.REQUIRED}
    assert bars["pvp_combo", "win"] == 0.40 and bars["pvp_sweat", "win"] == 0.70
    assert {("shield_holder", "win"), ("shield_holder", "shield_disables"), ("rusher", "win"), ("axeman", "win")} <= set(bars)


def test_low_windows_memory_stops_the_driver_cleanly(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    monkeypatch.setattr(E, "windows_commit_gb", lambda: 2.9)
    parent = fake_run(tmp_path / "parent", seed=1)
    root = tmp_path / "evo"
    root.mkdir()
    driver = E.Evolution(root, small_config([parent]), E.EvolveRuntime(threads=1, min_free_gb=0.0, min_commit_gb=3.0))
    assert driver.run() == 3
    logged = [json.loads(line)["event"] for line in (root / "log.jsonl").read_text().splitlines()]
    assert "stopped for windows memory" in logged


def test_no_child_starts_without_room_above_the_windows_memory_floor(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    monkeypatch.setattr(E, "windows_commit_gb", lambda: 3.5)
    monkeypatch.setattr(E, "MEMORY_WAIT_SECONDS", 0.0)
    monkeypatch.setattr(E, "POLL_SECONDS", 0.0)
    started = []
    monkeypatch.setattr(E.Evolution, "_spawn", lambda self, member, rivals: started.append(member))
    parent = fake_run(tmp_path / "parent", seed=1)
    root = tmp_path / "evo"
    root.mkdir()
    runtime = E.EvolveRuntime(threads=1, min_free_gb=0.0, max_rss_gb=1.0, min_commit_gb=3.0)
    driver = E.Evolution(root, small_config([parent]), runtime)
    driver.load()
    driver.import_founders()
    driver.rank_generation()
    driver.state["generation"] = 1
    driver.breed()
    with pytest.raises(E.Stopped):
        driver.train_children()
    assert started == []


def test_unreadable_windows_memory_stops_the_driver_cleanly(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    monkeypatch.setattr(E, "windows_commit_gb", lambda: None)
    parent = fake_run(tmp_path / "parent", seed=1)
    root = tmp_path / "evo"
    root.mkdir()
    driver = E.Evolution(root, small_config([parent]), E.EvolveRuntime(threads=1, min_free_gb=0.0, min_commit_gb=3.0))
    assert driver.run() == 3
    logged = [json.loads(line) for line in (root / "log.jsonl").read_text().splitlines()]
    assert any(line["event"] == "stopped for windows memory" and line["free_gb"] == 0.0 for line in logged)


def test_one_failed_memory_read_is_tolerated_and_repeated_failures_count_as_none_free(tmp_path, monkeypatch):
    reads = iter([5.0, None, 5.5, None, None, None, None])
    monkeypatch.setattr(E, "windows_commit_gb", lambda: next(reads))
    monkeypatch.setattr(E, "COMMIT_CHECK_SECONDS", 0.0)
    driver = E.Evolution(tmp_path, small_config(["unused"]), E.EvolveRuntime(min_commit_gb=3.0))
    assert [driver.commit_free() for _ in range(3)] == [5.0, 5.0, 5.5]
    assert [driver.commit_free() for _ in range(4)] == [5.5, 5.5, 5.5, 0.0]


def test_windows_memory_is_read_through_a_socket_that_outlives_the_ssh_session(monkeypatch):
    seen = []

    class Done:
        stdout = "9138204\r\n"

    def fake_run(command, **kwargs):
        seen.append(kwargs["env"]["WSL_INTEROP"])
        assert kwargs["stdin"] == E.subprocess.DEVNULL
        if len(seen) == 1:
            raise OSError("socket gone")
        return Done()

    monkeypatch.setattr(E.subprocess, "run", fake_run)
    assert E.windows_commit_gb() == pytest.approx(9138204 / 1024**2)
    assert seen == list(E.INTEROP_SOCKETS)


def test_windows_memory_read_returns_none_when_every_socket_fails(monkeypatch):
    def fail(command, **kwargs):
        raise OSError("no socket")

    monkeypatch.setattr(E.subprocess, "run", fail)
    assert E.windows_commit_gb() is None


def test_low_disk_stops_the_driver_cleanly(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    parent = fake_run(tmp_path / "parent", seed=1)
    root = tmp_path / "evo"
    root.mkdir()
    driver = E.Evolution(root, small_config([parent]), E.EvolveRuntime(threads=1, min_free_gb=0.0, min_disk_gb=1e9, disk_path=str(tmp_path)))
    assert driver.run() == 3
    logged = [json.loads(line)["event"] for line in (root / "log.jsonl").read_text().splitlines()]
    assert "stopped for disk" in logged
