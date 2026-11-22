"""The forced crossbow rules, the combo_walls plan and proof that older plans keep their behaviour."""

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter.evolve import EvolveConfig, Evolution, EvolveRuntime, prepare, rank_members, rates
from fighter.behaviour import OPPONENTS
from fighter.campaign import CampaignConfig
from fighter.obs import build_masks
from fighter.opponents import LEAGUE, OPEN_SOURCE_BOTS, SCRIPTED
from fighter.plans import PLANS, arena_stage
from fighter.sim import Sim, SimConfig
from fighter.stance import GUN_REST_DECISIONS, StanceRules, apply_stance

RULES = StanceRules(followup=True, range_rules=True)
WEAPON_START = int(A.HEAD_OFFSETS[A.WEAPON])
USE_START = int(A.HEAD_OFFSETS[A.USE])
LOCK_START = int(A.HEAD_OFFSETS[A.LOCK_AIM])
CROSSBOW = int(A.WEAPON_ACTION[C.CROSSBOW])
AXE = int(A.WEAPON_ACTION[C.AXE])


def duel(distance, weapon=C.AXE, loaded=False, load=0, ammo=6):
    sim = Sim(1, SimConfig.for_setup("diamond_20", ready_gate=PLANS["combo"].ready_gate), seed=0)
    sim.pos[0, 0] = (-distance / 2.0, 0.0, 0.0)
    sim.pos[0, 1] = (distance / 2.0, 0.0, 0.0)
    sim.yaw[0, 0] = -90.0
    sim.yaw[0, 1] = 90.0
    sim.pitch[:] = 0.0
    sim.weapon[0, 0] = weapon
    sim.weapon[0, 1] = C.AXE
    sim.loaded[0, 0] = loaded
    sim.load_ticks[0, 0] = load
    sim.ammo[0, 0] = ammo
    sim.ticks[:] = 40
    sim.perception.reset(np.arange(1))
    return sim


def raise_shield(sim):
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS


def masks(sim, rules=RULES):
    return apply_stance(rules, sim, 0, build_masks(sim, 0))[0]


def only(mask, head):
    start = int(A.HEAD_OFFSETS[head])
    return np.flatnonzero(mask[start : start + int(A.NVEC[head])]).tolist()


def test_the_rules_default_off_and_only_the_new_plan_has_them():
    assert StanceRules() == StanceRules(followup=False, range_rules=False)
    assert PLANS["combo"].stance == StanceRules(followup=True)
    assert PLANS["foundations"].stance == StanceRules()
    assert PLANS["melee"].stance is None
    assert PLANS["combo_walls"].stance == RULES


@pytest.mark.parametrize("load", [1, 18])
def test_a_load_under_75_percent_stops_when_hurt(load):
    sim = duel(8.0, C.CROSSBOW, load=load)
    sim.hurt_timer[0, 0] = 5
    mask = masks(sim)
    assert only(mask, A.WEAPON) == [AXE] and only(mask, A.USE) == [0]


def test_a_load_past_75_percent_carries_on_when_hurt():
    sim = duel(8.0, C.CROSSBOW, load=19)
    sim.hurt_timer[0, 0] = 5
    mask = masks(sim)
    assert only(mask, A.WEAPON) == [CROSSBOW] and only(mask, A.USE) == [1]


def test_a_load_stops_when_the_enemy_is_close():
    mask = masks(duel(4.4, C.CROSSBOW, load=10))
    assert only(mask, A.WEAPON) == [AXE] and only(mask, A.USE) == [0]


def test_a_load_stops_when_guarded_at_range():
    sim = duel(6.0, C.CROSSBOW, load=10)
    raise_shield(sim)
    mask = masks(sim)
    assert only(mask, A.WEAPON) == [AXE] and only(mask, A.USE) == [0]


def test_a_shield_that_faces_away_does_not_count_as_guarded():
    sim = duel(6.0, C.CROSSBOW, load=10)
    raise_shield(sim)
    sim.yaw[0, 1] = -90.0
    assert only(masks(sim), A.WEAPON) == [CROSSBOW]


def test_a_rising_shield_already_counts_as_guarded_like_the_client():
    sim = duel(6.0, C.CROSSBOW, load=10)
    sim.shield_ticks[0, 1] = 1
    assert only(masks(sim), A.WEAPON) == [AXE]


def test_guarded_with_another_weapon_removes_the_crossbow():
    sim = duel(8.0, C.AXE)
    raise_shield(sim)
    mask = masks(sim)
    assert not mask[WEAPON_START + CROSSBOW]
    assert mask[WEAPON_START + AXE]


def test_guarded_with_an_idle_crossbow_switches_to_the_axe():
    sim = duel(8.0, C.CROSSBOW, loaded=True)
    raise_shield(sim)
    assert only(masks(sim), A.WEAPON) == [AXE]


def test_guarded_ends_the_opening_load():
    sim = duel(8.0, C.AXE)
    sim.ticks[:] = 0
    raise_shield(sim)
    masks(sim)
    assert not sim.stance_opening[0, 0]


def test_the_crossbow_is_not_forced_during_the_rest():
    sim = duel(8.0, C.AXE)
    raise_shield(sim)
    masks(sim)
    assert sim.stance_rest[0, 0] == GUN_REST_DECISIONS == 8
    sim.shield_ticks[0, 1] = 0
    waited = 0
    while len(only(masks_at_next(sim), A.WEAPON)) != 1:
        waited += 1
        assert waited < 20
    assert waited == GUN_REST_DECISIONS - 1


def masks_at_next(sim):
    sim.ticks[:] += C.TICKS_PER_DECISION
    return masks(sim)


def test_reading_the_masks_twice_counts_one_decision():
    sim = duel(8.0, C.AXE)
    raise_shield(sim)
    masks(sim)
    sim.shield_ticks[0, 1] = 0
    masks_at_next(sim)
    left = sim.stance_rest[0, 0]
    masks(sim)
    masks(sim)
    assert sim.stance_rest[0, 0] == left


def test_a_new_round_clears_the_rest():
    sim = duel(8.0, C.AXE)
    raise_shield(sim)
    masks(sim)
    sim.shield_ticks[0, 1] = 0
    sim.ticks[:] = 0
    sim.loaded[0, 0] = True
    assert only(masks(sim), A.WEAPON) == [CROSSBOW]
    assert sim.stance_rest[0, 0] == 0


@pytest.mark.parametrize("loaded,ammo", [(True, 0), (False, 3)])
def test_far_away_with_a_shot_forces_the_crossbow(loaded, ammo):
    assert only(masks(duel(7.0, C.AXE, loaded=loaded, ammo=ammo)), A.WEAPON) == [CROSSBOW]


def test_far_away_with_nothing_to_shoot_is_free():
    mask = masks(duel(8.0, C.AXE, ammo=0))
    assert len(only(mask, A.WEAPON)) > 1


def test_just_under_seven_blocks_is_not_forced():
    mask = masks(duel(6.8, C.AXE))
    assert len(only(mask, A.WEAPON)) > 1


def test_an_unseen_enemy_is_not_forced():
    sim = Sim(1, SimConfig.for_setup("diamond_20_walls"), seed=0)
    sim.pillars.set_boxes(0, [(-1, -3, 1, 6, 3)])
    sim.pos[0, 0] = (-5.0, 0.0, 0.0)
    sim.pos[0, 1] = (5.0, 0.0, 0.0)
    sim.weapon[0, 0] = C.AXE
    sim.ticks[:] = 40
    sim.perception.reset(np.arange(1))
    sim.perception.refresh()
    assert len(only(masks(sim), A.WEAPON)) > 1


def test_holding_it_in_range_locks_aim_and_loads_when_empty():
    mask = masks(duel(5.0, C.CROSSBOW))
    assert only(mask, A.LOCK_AIM) == [1] and only(mask, A.USE) == [1]


def aimed_duel(distance=6.0, **kwargs):
    sim = duel(distance, C.CROSSBOW, loaded=True, **kwargs)
    sim.yaw[0, 0], sim.pitch[0, 0] = aim_at(sim)
    return sim


def aim_at(sim):
    from fighter.arrows import intercept

    yaw, pitch, _ = intercept(sim, 0, np.full(1, C.CROSSBOW_SPEED))
    return yaw[0], pitch[0]


def test_loaded_and_lined_up_fires_on_a_fresh_press():
    mask = masks(aimed_duel())
    assert only(mask, A.USE) == [1] and only(mask, A.LOCK_AIM) == [1]


def test_loaded_with_use_held_releases_first():
    sim = aimed_duel()
    sim.use_prev[0, 0] = True
    assert only(masks(sim), A.USE) == [0]


def test_loaded_off_target_holds_fire():
    sim = aimed_duel()
    sim.yaw[0, 0] += 25.0
    assert only(masks(sim), A.USE) == [0]


def test_loaded_holds_fire_in_the_enemy_hurt_window():
    sim = aimed_duel()
    sim.hurt_timer[0, 1] = 3
    assert only(masks(sim), A.USE) == [0]
    sim = aimed_duel()
    sim.hurt_timer[0, 1] = 2
    assert only(masks(sim), A.USE) == [1]


def test_loaded_with_a_blocked_line_holds_fire():
    sim = Sim(1, SimConfig.for_setup("diamond_20_walls", ready_gate=PLANS["combo"].ready_gate), seed=0)
    sim.pillars.set_boxes(0, [(-1, -1, 1, 1, 2)])
    sim.pos[0, 0] = (-4.0, 0.0, 0.0)
    sim.pos[0, 1] = (4.0, 1.3, 0.0)
    sim.weapon[0, 0] = C.CROSSBOW
    sim.loaded[0, 0] = True
    sim.ticks[:] = 40
    sim.perception.reset(np.arange(1))
    sim.perception.refresh()
    sim.yaw[0, 0], sim.pitch[0, 0] = aim_at(sim)
    sim.perception.refresh()
    from fighter.obs import build_obs

    obs = build_obs(sim, 0)[0]
    assert obs[38] == 1.0 and obs[37] == 0.0
    assert only(masks(sim), A.USE) == [0]


def test_the_axe_runs_at_a_seen_enemy_out_of_reach():
    mask = masks(duel(5.0, C.AXE, ammo=0))
    assert only(mask, A.FORWARD) == [A.KEY_FORWARD] and only(mask, A.SPRINT) == [1]


def test_the_axe_does_not_chase_inside_reach_or_when_facing_away():
    assert len(only(masks(duel(3.4, C.AXE, ammo=0)), A.FORWARD)) > 1
    sim = duel(5.0, C.AXE, ammo=0)
    sim.yaw[0, 0] += 60.0
    assert len(only(masks(sim), A.FORWARD)) > 1


def test_the_crossbow_does_not_chase():
    assert len(only(masks(duel(5.0, C.CROSSBOW, loaded=True)), A.FORWARD)) > 1


def test_inside_range_removes_the_crossbow():
    sim = duel(4.4, C.CROSSBOW, loaded=True)
    mask = masks(sim)
    assert not mask[WEAPON_START + CROSSBOW]
    assert not mask[WEAPON_START + A.WEAPON_KEEP]


def test_the_follow_up_window_keeps_the_crossbow_close_in():
    sim = duel(3.5, C.AXE, loaded=True)
    sim.shield_disabled[0, 1] = C.SHIELD_DISABLE_TICKS
    assert only(masks(sim), A.WEAPON) == [CROSSBOW]


def test_every_head_keeps_a_legal_choice_in_random_states():
    sim = Sim(64, SimConfig.for_setup("diamond_20_walls", ready_gate=PLANS["combo"].ready_gate), seed=8)
    rng = np.random.default_rng(3)
    for _ in range(200):
        mask = apply_stance(RULES, sim, 0, build_masks(sim, 0))
        for start, size in zip(A.HEAD_OFFSETS, A.NVEC):
            assert mask[:, int(start) : int(start + size)].any(axis=1).all()
        actions = rng.integers(0, A.NVEC, size=(64, 2, len(A.NVEC)))
        scores = rng.random(mask.shape) * mask
        for head, (start, size) in enumerate(zip(A.HEAD_OFFSETS, A.NVEC)):
            actions[:, 0, head] = scores[:, int(start) : int(start + size)].argmax(axis=1)
        sim.step(actions)
        dead = (sim.hp <= 0.0).any(axis=1)
        if dead.any():
            sim.reset(dead)


def test_the_new_plan_uses_the_walls_and_a_synth_led_mix():
    plan = PLANS["combo_walls"]
    assert plan.fight_setup == "diamond_20_walls"
    assert not plan.adaptive
    stage = arena_stage("combo_walls")
    total = sum(stage.mix.values())
    share = {name: weight / total for name, weight in stage.mix.items()}
    assert share["synth"] == pytest.approx(0.5)
    assert share[LEAGUE] >= 0.05
    named = [n for n in ("mineflayer_pvp", "custom_pvp", "sweat_sword", "pvp_combo", "pvp_sweat") if n in SCRIPTED]
    assert set(named) <= set(share)
    rest = 1.0 - share["synth"] - share[LEAGUE]
    top = sum(share[name] for name in named)
    assert top / rest > 0.7
    assert CampaignConfig(plan="combo_walls").fight_setup == "diamond_20_walls"


def test_older_plans_keep_their_setup_and_their_mixes():
    for name in ("melee", "foundations", "combo"):
        plan = PLANS[name]
        assert (plan.fight_setup, plan.arena_mix, plan.named_opponents) == (None, None, ())
        assert not set(arena_stage(name).mix) & set(OPEN_SOURCE_BOTS)
        assert not set(plan.stages[-1].mix) & set(OPEN_SOURCE_BOTS)
        assert CampaignConfig(plan=name).fight_setup == "standard"


def row(win, draw=0.0, games=64):
    wins, draws = round(win * games), round(draw * games)
    return rates(wins, draws, games - wins - draws)


def table(synth_win):
    named = {name: row(0.95) for name in OPPONENTS}
    named["shield_holder"]["behaviour"] = {"shield_disables": 2.0}
    named["synth"] = row(synth_win)
    return named


def test_a_fighter_that_loses_to_synth_cannot_rank_well():
    ranked = rank_members(["loser", "balanced"], {"loser": table(0.05), "balanced": table(0.65)}, {("balanced", "loser"): (8, 0, 8)})
    assert ranked[0]["id"] == "balanced"
    assert ranked[1]["fitness"] < ranked[0]["fitness"] - 0.3
    assert not ranked[1]["bars_met"]


def test_ranking_without_synth_has_no_synth_bar():
    named = {name: row(0.95) for name in OPPONENTS}
    ranked = rank_members(["only"], {"only": named}, {})
    assert not any(key.startswith("synth") for key in ranked[0]["bars"])


def test_an_evolution_counts_the_plan_opponents(tmp_path):
    cfg = EvolveConfig(parents=["x"], plan="combo_walls", fight_setup="diamond_20_walls")
    evolution = Evolution(tmp_path, cfg, EvolveRuntime())
    assert set(OPEN_SOURCE_BOTS) <= set(evolution.opponents)
    assert evolution.opponents[: len(OPPONENTS)] == tuple(OPPONENTS)
    plain = Evolution(tmp_path, EvolveConfig(parents=["x"]), EvolveRuntime())
    assert plain.opponents == tuple(OPPONENTS)


def test_an_evolution_refuses_the_plan_in_the_wrong_setup(tmp_path):
    with pytest.raises(SystemExit):
        prepare(tmp_path / "run", {"parents": ["x"], "plan": "combo_walls", "fight_setup": "diamond_20"})
