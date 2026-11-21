"""UHC kits, item rules, inputs, masks, drills, reward loops and missing items."""

import ast
from pathlib import Path

import numpy as np
import pytest

import fighter
from fighter import actions as A
from fighter import constants as C
from fighter import items as I
from fighter import obs as shared
from fighter import uhc_obs
from fighter.opponents import OpponentPool
from fighter.uhc import ITEM_HEAD, UHC_WORLD, UhcKitRules, UhcVecEnv, deal_kits, load_uhc_world, uhc_nvec, uhc_sim_config
from fighter.uhc_checks import (
    FARM_LOOPS,
    ROD_FARM_LOOPS,
    check_missing,
    every_missing_choice,
    farm_report,
    fight_rate,
    rod_farm_report,
    sample_masked,
)
from fighter.uhc_drills import DRILLS, FLOOR_Y, IDLE_LIMIT, PASS_RATE, WORLD_BAND, WORLD_SIZE, flat_base, held_out_rate
from fighter.uhc_net import POLICY_UNITS, UhcExtractor, build_uhc_model
from fighter.world import blocks as B
from fighter.world.kernel import BaseWorld

FULL = UhcKitRules(full_rate=1.0, empty_rate=0.0, gear_drop=0.0, armor_drop=0.0)
TOP = FLOOR_Y + 1.0


def make_env(n=1, rules=FULL, base=None, seed=0, max_ticks=600):
    pool = OpponentPool(n, seed=seed + 1, max_ticks=max_ticks)
    pool.set_mix({"idle": 1.0})
    return UhcVecEnv(
        n, pool, base if base is not None else flat_base(), rules, uhc_sim_config(),
        max_ticks=max_ticks, seed=seed, opponent_eats=False,
    )


def stand(env, x=32.5, z=32.5, yaw=0.0, pitch=0.0, other=(50.5, 50.5)):
    sim = env.sim
    for seat, (px, pz) in enumerate(((x, z), other)):
        sim.pos[:, seat] = (px, TOP, pz)
        sim.vel[:, seat] = (0.0, -C.GRAVITY * C.VERTICAL_DRAG, 0.0)
        sim.on_ground[:, seat] = True
        sim.body.last_move[:, seat] = 0.0
        sim.combat._last_xz[:, seat] = (px, pz)
    sim.yaw[:, 0] = yaw
    sim.pitch[:, 0] = pitch
    sim.update_sight()


def act(env, item=I.NO_ITEM, use=0, attack=0, **heads):
    sim = env.sim
    base = A.neutral_actions(sim.weapon[:, 0].copy())
    base[:, A.USE] = use
    base[:, A.ATTACK] = attack
    for name, value in heads.items():
        base[:, getattr(A, name)] = value
    codes = np.full((sim.n, 1), item, dtype=np.int64)
    return env.step(np.concatenate([base, codes], axis=1))


def give(env, code, amount):
    env.sim.items.count[:, 0, code] = amount
    if code == I.ROD:
        env.sim.items.rod_left[:, 0] = I.ROD_DURABILITY


def test_kits_are_random_within_limits_and_redrawn_each_round():
    env = make_env(64, UhcKitRules())
    seen = []
    for _ in range(4):
        env.reset()
        seen.append(env.sim.items.count[:, :, : uhc_obs.NUM_ITEM_ACTIONS].copy())
    stack = np.concatenate(seen)
    for code, _low, high in env.rules.counts:
        assert stack[..., code].max() <= high
        assert (stack[..., code] == 0).any()
        assert (stack[..., code] > 0).any()
    assert not np.array_equal(seen[0], seen[1])
    env.close()


def test_forced_and_banned_items_are_respected():
    env = make_env(8, UhcKitRules(forced=(I.PEARL,), banned=(I.ROD,)))
    deal_kits(env.sim, np.arange(8), env.rules, np.random.default_rng(1))
    assert (env.sim.items.count[:, :, I.PEARL] > 0).all()
    assert (env.sim.items.count[:, :, I.ROD] == 0).all()
    env.close()


def test_natural_regeneration_is_off():
    env = make_env()
    stand(env)
    env.sim.hp[:, 0] = 10.0
    for _ in range(60):
        act(env)
    assert env.sim.hp[0, 0] == 10.0
    assert env.sim.cfg.hunger
    assert not env.sim.cfg.natural_regen
    env.close()


def test_golden_apple_takes_32_ticks_and_gives_its_effects():
    env = make_env()
    stand(env)
    give(env, I.GOLDEN_APPLE, 2)
    env.sim.hp[:, 0] = 10.0
    for _ in range(15):
        act(env, I.GOLDEN_APPLE, use=1)
    assert env.sim.items.count[0, 0, I.GOLDEN_APPLE] == 2
    act(env, I.GOLDEN_APPLE, use=1)
    assert env.sim.items.count[0, 0, I.GOLDEN_APPLE] == 1
    assert env.sim.combat.absorption[0, 0] == pytest.approx(4.0)
    assert env.sim.combat.effect_amp[0, 0, I.REGENERATION] == 1
    assert env.sim.combat.effect_time[0, 0, I.ABSORPTION] > 2300
    env.close()


def test_letting_go_of_use_restarts_eating():
    env = make_env()
    stand(env)
    give(env, I.GOLDEN_APPLE, 1)
    for _ in range(10):
        act(env, I.GOLDEN_APPLE, use=1)
    act(env, I.GOLDEN_APPLE, use=0)
    for _ in range(10):
        act(env, I.GOLDEN_APPLE, use=1)
    assert env.sim.items.count[0, 0, I.GOLDEN_APPLE] == 1
    env.close()


def test_water_bucket_puts_out_fire_and_scoops_back():
    env = make_env()
    stand(env, pitch=90.0)
    give(env, I.WATER_BUCKET, 1)
    env.sim.items.count[:, 0, I.EMPTY_BUCKET] = 0
    env.sim.combat.fire[:, 0] = 100
    env.sim.combat._burning = True
    act(env, I.WATER_BUCKET, use=1)
    act(env, I.WATER_BUCKET, use=0)
    assert env.sim.combat.fire[0, 0] <= 0
    assert env.sim.items.count[0, 0, I.EMPTY_BUCKET] == 1
    act(env, I.NO_ITEM)
    act(env, I.EMPTY_BUCKET, use=1)
    assert env.sim.items.count[0, 0, I.WATER_BUCKET] == 1
    env.close()


def test_lava_bucket_burns_and_scoops_back():
    env = make_env()
    stand(env, pitch=90.0)
    give(env, I.LAVA_BUCKET, 1)
    act(env, I.LAVA_BUCKET, use=1)
    act(env, I.LAVA_BUCKET, use=0)
    assert env.sim.combat.in_lava[0, 0]
    assert env.sim.combat.fire[0, 0] > 0
    act(env, I.NO_ITEM)
    act(env, I.EMPTY_BUCKET, use=1)
    assert env.sim.items.count[0, 0, I.LAVA_BUCKET] == 1
    env.close()


def test_cobweb_slows_a_walking_body():
    free = make_env()
    stand(free)
    webbed = make_env()
    stand(webbed)
    webbed.sim.world.poke(32, FLOOR_Y + 1, 32, B.COBWEB, 0)
    webbed.sim.world.poke(32, FLOOR_Y + 2, 32, B.COBWEB, 0)
    for _ in range(4):
        act(free, FORWARD=A.KEY_FORWARD)
        act(webbed, FORWARD=A.KEY_FORWARD)
    assert webbed.sim.combat.in_web[0, 0]
    moved_free = free.sim.pos[0, 0, 2] - 32.5
    moved_web = webbed.sim.pos[0, 0, 2] - 32.5
    assert 0.0 < moved_web < 0.4 * moved_free
    free.close()
    webbed.close()


def test_pearl_carries_the_thrower_motion():
    env = make_env()
    stand(env)
    give(env, I.PEARL, 1)
    env.sim.body.last_move[0, 0] = (0.2, 0.1, -0.1)
    env.sim.on_ground[0, 0] = False
    env.sim.items._throw_pearl(0, 0)
    expected = I._look(0.0, 0.0) * I.PEARL_SPEED + np.array([0.2, 0.1, -0.1])
    assert env.sim.items.pearl_vel[0, 0] == pytest.approx(expected)
    env.close()


def test_pearl_flies_through_a_cobweb_and_stops_on_stone():
    env = make_env()
    stand(env)
    world = env.sim.world
    world.poke(40, FLOOR_Y + 4, 40, B.COBWEB, 0)
    start = np.array([[40.5, FLOOR_Y + 4.8, 40.5]])
    vel = np.array([[0.0, -1.0, 0.0]])
    assert not np.isfinite(env.sim.items._block_time(np.array([0]), start, vel))[0]
    world.poke(40, FLOOR_Y + 4, 40, B.STONE, 0)
    assert np.isfinite(env.sim.items._block_time(np.array([0]), start, vel))[0]
    env.close()


def test_pearl_vanishes_when_the_thrower_dies():
    env = make_env()
    stand(env, pitch=-40.0)
    give(env, I.PEARL, 1)
    env.sim.items._throw_pearl(0, 0)
    before = env.sim.pos[0, 0].copy()
    env.sim.hp[0, 0] = 0.0
    env.sim.items._fly_pearls()
    assert not env.sim.items.pearl_on[0, 0]
    assert env.sim.pos[0, 0] == pytest.approx(before)
    env.close()


def test_rod_pull_starts_from_the_hook_on_the_body():
    env = make_env()
    stand(env, other=(32.5, 38.5))
    give(env, I.ROD, 1)
    items = env.sim.items
    items.hook_on[0, 0] = True
    items.hook_state[0, 0] = I.HOOK_ON_PLAYER
    before = env.sim.vel[0, 1].copy()
    items._use_rod(0, 0)
    gap = env.sim.pos[0, 0] - env.sim.pos[0, 1]
    gap[1] -= I.HOOK_BODY_FRACTION * C.PLAYER_HEIGHT
    assert env.sim.vel[0, 1] - before == pytest.approx(gap * I.ROD_PULL)
    env.close()


def test_hook_is_lost_when_the_rod_leaves_the_hand():
    env = make_env()
    stand(env, pitch=-5.0)
    give(env, I.ROD, 1)
    act(env, I.ROD, use=1)
    assert env.sim.items.hook_on[0, 0]
    act(env, I.ROD, use=0)
    assert env.sim.items.hook_on[0, 0]
    act(env, I.NO_ITEM)
    assert not env.sim.items.hook_on[0, 0]
    env.close()


def test_hook_is_lost_out_of_range():
    env = make_env()
    stand(env)
    items = env.sim.items
    items.hook_on[0, 0] = True
    items.hook_state[0, 0] = I.HOOK_STUCK
    items.hook_pos[0, 0] = env.sim.pos[0, 0] + np.array([I.HOOK_RANGE + 1.0, 0.0, 0.0])
    items._fly_hooks()
    assert not items.hook_on[0, 0]
    env.close()


def test_hook_on_a_player_is_lost_when_that_player_runs_out_of_range():
    env = make_env()
    stand(env, other=(32.5, 38.5))
    items = env.sim.items
    items.hook_on[0, 0] = True
    items.hook_state[0, 0] = I.HOOK_ON_PLAYER
    items.hook_pos[0, 0] = env.sim.pos[0, 1]
    items._fly_hooks()
    assert items.hook_on[0, 0]
    env.sim.pos[0, 1, 2] = 32.5 + I.HOOK_RANGE + 1.0
    items._fly_hooks()
    assert not items.hook_on[0, 0]
    env.close()


def test_holding_use_places_a_block_every_four_ticks():
    env = make_env()
    stand(env, pitch=30.0)
    give(env, I.BLOCK, 10)
    for _ in range(8):
        act(env, I.BLOCK, use=1)
    placed = 10 - int(env.sim.items.count[0, 0, I.BLOCK])
    assert 2 <= placed <= 4
    env.close()


def test_taking_an_item_cancels_a_bow_draw_without_a_shot():
    env = make_env()
    stand(env)
    give(env, I.BLOCK, 4)
    env.sim.weapon[:, 0] = C.BOW
    env.sim.ammo[:, 0] = 5
    env.sim.draw_ticks[:, 0] = 12
    act(env, I.BLOCK, use=0, WEAPON=A.WEAPON_ACTION[C.BOW])
    assert env.sim.events["arrows_fired"][0, 0] == 0
    assert env.sim.draw_ticks[0, 0] == 0
    env.close()


def test_sizes_follow_the_shared_interface(monkeypatch):
    env = make_env()
    assert env.observation_space.shape == (shared.OBS_DIM + uhc_obs.EXTRA_DIM,)
    assert list(env.action_space.nvec) == [*A.NVEC.tolist(), uhc_obs.NUM_ITEM_ACTIONS]
    assert env.observe().shape == (1, shared.OBS_DIM + uhc_obs.EXTRA_DIM)
    assert env.action_masks().shape == (1, int(uhc_nvec().sum()))
    env.close()
    monkeypatch.setattr(shared, "OBS_DIM", shared.OBS_DIM + 46)
    parts = uhc_obs.layout()
    assert parts["shared"].stop == shared.OBS_DIM
    assert parts["world"].stop == shared.OBS_DIM + uhc_obs.EXTRA_DIM


def test_masks_match_the_inventory_on_every_step():
    env = make_env(16, UhcKitRules())
    rng = np.random.default_rng(3)
    env.reset()
    first = int(A.MASK_SIZE)
    for _ in range(120):
        mask = env.action_masks()
        for code in uhc_obs.KIT_ITEMS:
            assert not (mask[:, first + code] & (env.sim.items.count[:, 0, code] <= 0)).any()
        assert mask[:, first + I.NO_ITEM].all()
        env.step(sample_masked(mask, rng))
    assert env.hands.illegal_items[0] == 0
    assert env.hands.illegal_weapons[0] == 0
    env.close()


@pytest.mark.parametrize("code", [I.PEARL, I.WATER_BUCKET, I.LAVA_BUCKET, I.COBWEB, I.BLOCK, I.GOLDEN_APPLE])
def test_an_item_used_up_is_masked_on_the_next_step(code):
    env = make_env()
    env.sim.items.count[:, :, : uhc_obs.NUM_ITEM_ACTIONS] = 0
    stand(env, pitch=60.0)
    give(env, code, 1)
    slot = int(A.MASK_SIZE) + code
    assert env.action_masks()[0, slot]
    for _ in range(I.USE_DURATION // 2 + 1):
        if env.sim.items.count[0, 0, code] == 0:
            break
        act(env, code, use=1)
    assert env.sim.items.count[0, 0, code] == 0
    assert not env.action_masks()[0, slot]
    env.close()


def test_pearl_is_masked_during_its_cooldown():
    env = make_env()
    stand(env, pitch=-30.0)
    give(env, I.PEARL, 2)
    act(env, I.PEARL, use=1)
    assert not env.action_masks()[0, int(A.MASK_SIZE) + I.PEARL]
    env.close()


@pytest.mark.parametrize("missing", every_missing_choice(), ids=str)
def test_missing_item_is_never_reached_for(missing):
    report = check_missing(missing)
    assert report["mask_leaks"] == 0
    assert report["illegal_choices"] == 0
    assert report["stock_seen"] == 0
    assert report["gear_used"] == 0
    if missing not in ("sword", "shield"):
        assert report["blocked_reaches"] > 0


@pytest.mark.parametrize("missing", [None, *every_missing_choice()], ids=str)
def test_a_round_finishes_with_any_item_missing(missing):
    assert 0.0 <= fight_rate(missing, rounds=16, n=8) <= 1.0


def _sealed_raw(hidden: int) -> np.ndarray:
    raw = np.zeros((WORLD_SIZE, WORLD_SIZE, B.WORLD_HEIGHT), dtype=np.uint16)
    raw[:, :, : FLOOR_Y - B.Y_MIN + 1] = B.STONE
    raw[:, 36:39, : WORLD_BAND[1] - B.Y_MIN] = B.STONE
    raw[33, 37, FLOOR_Y + 1 - B.Y_MIN] = hidden
    return raw


def test_blocks_behind_a_wall_never_change_inputs_or_masks():
    envs = [
        make_env(base=BaseWorld.from_array(_sealed_raw(cell), WORLD_BAND))
        for cell in (B.STONE, B.LAVA_SOURCE)
    ]
    for env in envs:
        env.reset()
        stand(env, x=32.5, z=34.5, other=(10.5, 10.5))
    for _ in range(12):
        assert np.array_equal(envs[0].observe(), envs[1].observe())
        assert np.array_equal(envs[0].action_masks(), envs[1].action_masks())
        for env in envs:
            act(env, YAW=A.NEUTRAL_YAW + 1)
    for env in envs:
        env.close()


def test_uhc_inputs_and_masks_import_only_the_view():
    assert uhc_obs.uhc_masks.__module__ == "fighter.uhc_obs"
    tree = ast.parse((Path(fighter.__file__).parent / "uhc_obs.py").read_text())
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("world"):
            found.add(node.module)
    assert found == {"world.view"}


def test_a_seen_block_reaches_the_inputs():
    env = make_env()
    stand(env)
    before = env.observe().copy()
    env.sim.world.poke(32, FLOOR_Y + 2, 33, B.STONE, 0)
    env.sim.update_sight()
    assert not np.array_equal(before, env.observe())
    env.close()


@pytest.mark.parametrize("name", list(DRILLS))
def test_drill_scripted_solution_passes_on_held_out_seeds(name):
    assert held_out_rate(name, "expert") >= PASS_RATE


@pytest.mark.parametrize("name", list(DRILLS))
def test_drill_is_failed_by_doing_nothing(name):
    assert held_out_rate(name, "idle") <= IDLE_LIMIT


def test_the_pearl_drill_cannot_be_won_on_foot():
    from fighter.uhc_drills import PearlCross

    ticks = PearlCross.limit
    sprint_jump_blocks_per_tick = 7.127 / C.TICKS_PER_SECOND
    assert ticks * sprint_jump_blocks_per_tick < 24.0 - PearlCross.reach


def test_every_reward_loop_earns_less_than_doing_nothing():
    report = farm_report(steps=300, n=4)
    assert set(report) == set(FARM_LOOPS)
    for name, row in report.items():
        assert row["loop"] < row["idle"], name


def test_every_rod_drill_loop_earns_less_than_aiming_without_a_cast():
    report = rod_farm_report(rounds=32, n=8)
    assert set(report) == set(ROD_FARM_LOOPS)
    for name, row in report.items():
        assert row["loop"] < row["idle"], name


def test_the_use_key_input_follows_the_held_item_press():
    env = make_env(1, FULL)
    stand(env)
    give(env, I.ROD, 1)
    held = uhc_obs.layout()["body"].start + uhc_obs.INVENTORY_DIM + uhc_obs.STATUS_DIM + uhc_obs.NUM_ITEM_ACTIONS + 1
    act(env, I.ROD, use=1)
    assert env.observe()[0, held] == 1.0
    act(env, I.ROD, use=0)
    assert env.observe()[0, held] == 0.0
    env.close()


def test_the_network_is_its_own_and_takes_a_training_step():
    env = make_env(4, UhcKitRules())
    model = build_uhc_model(env, n_steps=32, batch_size=64, n_epochs=1)
    assert isinstance(model.policy.features_extractor, UhcExtractor)
    assert model.policy.action_dist.action_dims == uhc_nvec().tolist()
    assert model.policy.net_arch["pi"] == list(POLICY_UNITS)
    size = sum(p.numel() for p in model.policy.parameters())
    assert size > 300_000
    model.learn(128)
    env.close()


def test_env_runs_in_a_generated_world_with_depth_off(tmp_path):
    assert UHC_WORLD.fluids and UHC_WORLD.fire and not UHC_WORLD.depth
    base = load_uhc_world(3, 64, str(tmp_path))
    env = make_env(4, UhcKitRules(), base=base)
    rng = np.random.default_rng(1)
    env.reset()
    for _ in range(30):
        env.step(sample_masked(env.action_masks(), rng))
    assert env.hands.illegal_items[0] == 0
    assert ITEM_HEAD == len(A.NVEC)
    env.close()
