"""The merged simulator: world profiles, block actions, bow enchantments and shared state."""

import numpy as np
import pytest
from world_helpers import FLOOR, flat_raw, make, yi

from fighter import actions as A
from fighter import arrows
from fighter import constants as C
from fighter import items as I
from fighter import movement as M
from fighter.items import Kit
from fighter.obs import build_masks, build_obs
from fighter.sim import Sim, SimConfig
from fighter.world import blocks as B
from fighter.world.config import FULL, SURFACE
from fighter.world.kernel import CLIENT_MODELS

Y = FLOOR + 1


@pytest.fixture(scope="module")
def cache(tmp_path_factory):
    return str(tmp_path_factory.mktemp("worlds"))


def profile_sim(cache, profile, n=2, **settings):
    return Sim(n, SimConfig(profile=profile, world_size=64, world_cache=cache, **settings), seed=3)


def idle(sim):
    return A.neutral_actions(sim.weapon.copy())


def block_sim(raw=None, **settings):
    sim = Sim(1, SimConfig(armor="none", arena_half=64.0, **settings))
    sim.attach_world(make(flat_raw() if raw is None else raw))
    sim.pos[0, 0] = [16.5, Y, 16.5]
    sim.pos[0, 1] = [24.5, Y, 24.5]
    sim.yaw[0] = 0.0
    sim.pitch[0] = 0.0
    return sim


def shooter(kit, weapon=C.BOW):
    sim = Sim(1, SimConfig(kits=(kit,), uneven_rate=0.0, arena_half=64.0))
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 3.0]
    sim.yaw[0] = [0.0, 180.0]
    sim.weapon[0, 0] = weapon
    return sim


def land_arrow(sim):
    """Fire one arrow from seat 0 and drive it straight into seat 1."""
    arrows.fire(sim, np.array([[True, False]]), np.full((1, 2), 2.0), np.zeros((1, 2), dtype=bool))
    sim.arrow_pos[0, 0] = [0.0, 1.0, 1.5]
    sim.arrow_vel[0, 0] = [0.0, 0.0, 2.0]
    arrows.step_arrows(sim)


def test_arena_profile_has_no_world():
    sim = Sim(2, profile="arena")
    assert sim.world is None
    assert (sim.origin == 0.0).all()


def test_unknown_profile_is_refused():
    with pytest.raises(ValueError):
        SimConfig(profile="caves")


@pytest.mark.parametrize("name,settings", [("surface", SURFACE), ("full", FULL)])
def test_world_profiles_build_their_world(cache, name, settings):
    sim = profile_sim(cache, name)
    assert sim.world.config == settings
    assert sim.world.model == CLIENT_MODELS["vanilla"]
    sim.close()


@pytest.mark.parametrize("model", ["vanilla", "mineflayer"])
def test_client_model_reaches_bodies_and_world(cache, model):
    sim = profile_sim(cache, "surface", client_model=model)
    assert sim.world.model == CLIENT_MODELS[model]
    assert sim.body.cfg.client_model == model
    sim.close()


@pytest.mark.parametrize("name", ["surface", "full"])
def test_players_spawn_on_dry_ground_and_stay_there(cache, name):
    sim = profile_sim(cache, name, n=6)
    width = np.full((6, 2), C.PLAYER_WIDTH)
    height = np.full((6, 2), C.PLAYER_HEIGHT)
    eye = np.full((6, 2), C.EYE_HEIGHT)
    wet = sim.world.fluid_box_many(sim.pos, width, height, eye)
    assert not (wet["in_water"] | wet["in_lava"]).any()
    start = sim.pos[..., 1].copy()
    action = idle(sim)
    for _ in range(10):
        sim.step(action)
    assert sim.on_ground.all()
    assert np.abs(sim.pos[..., 1] - start).max() < 1e-6
    sim.close()


def test_world_runs_once_per_game_tick(cache):
    sim = profile_sim(cache, "full", n=1)
    before = sim.world.now(0)
    action = idle(sim)
    for _ in range(5):
        sim.step(action)
    assert sim.world.now(0) - before == 5 * C.TICKS_PER_DECISION
    sim.close()


def test_tick_runs_world_then_actions_then_bodies():
    sim = block_sim()
    calls = []
    for owner, name, label in (
        (sim.world, "tick", "world"),
        (sim, "_switch_weapons", "weapon"),
        (sim, "_use_items", "use"),
        (sim.items, "tick", "blocks"),
        (sim, "_melee", "melee"),
        (sim, "_move", "bodies"),
        (sim, "_step_arrows", "arrows"),
        (sim, "_advance_timers", "timers"),
    ):
        def spy(*args, inner=getattr(owner, name), label=label, **kwargs):
            calls.append(label)
            return inner(*args, **kwargs)

        setattr(owner, name, spy)
    sim._rotation_ticks = 1
    sim._tick(idle(sim), first=True)
    assert calls == ["world", "weapon", "use", "blocks", "melee", "bodies", "arrows", "timers"]
    sim.close()


def test_bodies_feel_a_fluid_on_the_tick_it_arrives():
    sim = block_sim()
    sim.world.set(17, Y, 16, B.WATER_SOURCE)
    action = idle(sim)
    for _ in range(12):
        sim._tick(action, first=False)
        if sim.world.block(16, Y, 16) != B.AIR:
            break
    assert sim.world.block(16, Y, 16) != B.AIR
    assert sim.vel[0, 0, 1] == pytest.approx(-M.WATER_SINK)
    sim.close()


def test_decision_updates_sight_only_from_the_body(cache):
    sim = profile_sim(cache, "surface", n=1)
    view = sim.world_view()
    first = view.digest(0, 0)
    sim.yaw[0, 0] += 90.0
    sim.step(idle(sim))
    assert view.digest(0, 0) != first
    assert (view.crop(0, 0, 7, 5, 7) != 0).any()
    sim.close()


def test_reset_drops_block_edits(cache):
    sim = profile_sim(cache, "surface", n=1)
    x, y, z = (int(v) for v in np.floor(sim.pos[0, 0]))
    below = sim.world.block(x, y - 1, z, 0)
    sim.world.set(x, y - 1, z, B.AIR)
    sim.reset()
    assert sim.world.block(x, y - 1, z, 0) == below
    sim.close()


def test_placing_and_digging_go_through_the_world():
    stock = ((I.BLOCK, 2),)
    raw = flat_raw()
    raw[16, 17, yi(FLOOR)] = B.BLOCK_ID["dirt"]
    sim = Sim(1, SimConfig(kits=(Kit(stock=stock),), uneven_rate=0.0, arena_half=64.0))
    sim.attach_world(make(raw))
    sim.pos[0, 0] = [16.5, Y, 16.5]
    sim.pos[0, 1] = [24.5, Y, 24.5]
    sim.yaw[0] = 0.0
    sim.pitch[0, 0] = 60.0
    action = idle(sim)
    left = sim.combat.weapon_left[0, 0, C.SWORD]
    sim.items.dig_input[0, 0] = True
    for _ in range(40):
        sim.step(action)
        if sim.world.block(16, FLOOR, 17, 0) == B.AIR:
            break
    assert sim.world.block(16, FLOOR, 17, 0) == B.AIR
    assert sim.combat.weapon_left[0, 0, C.SWORD] == left - 2
    sim.items.dig_input[0, 0] = False
    sim.pos[0, 0] = [16.5, FLOOR, 17.5]
    for _ in range(40):
        sim.step(action)
        if sim.items.picked is not None and sim.items.picked[0, 0, B.ITEM_ID["dirt"]] > 0:
            break
    assert sim.items.picked[0, 0, B.ITEM_ID["dirt"]] == 1
    sim.close()


def test_collected_cobblestone_refills_the_block_stack():
    sim = block_sim()
    sim.world.spawn_item(16.5, Y + 0.2, 16.5, B.ITEM_ID["cobblestone"], 3, delay=0)
    sim.step(idle(sim))
    assert sim.items.count[0, 0, I.BLOCK] == 3
    sim.close()


def test_either_body_can_act_first():
    firsts = set()
    for seed in range(24):
        raw = flat_raw()
        stock = ((I.BLOCK, 4),)
        sim = Sim(1, SimConfig(kits=(Kit(stock=stock),), uneven_rate=0.0, arena_half=64.0), seed=seed)
        sim.attach_world(make(raw))
        sim.pos[0, 0] = [16.5, Y, 13.5]
        sim.pos[0, 1] = [16.5, Y, 19.5]
        sim.yaw[0] = [0.0, 180.0]
        sim.pitch[0] = 40.0
        sim.items.input[0] = I.BLOCK
        sim.step(idle(sim))
        spent = I.Kit(stock=stock).stock[0][1] - sim.items.count[0, :, I.BLOCK]
        firsts.add(tuple(spent.tolist()))
        order = sim.items._body_order()
        assert len(order) == 2
        sim.close()
    orders = set()
    for seed in range(24):
        sim = Sim(1, SimConfig(arena_half=64.0), seed=seed)
        sim.attach_world(make())
        sim.items.input[0] = I.BLOCK
        orders.add(sim.items._body_order()[0][1])
        sim.close()
    assert orders == {0, 1}
    assert firsts


def test_arrow_stops_at_a_world_block_in_a_profile(cache):
    sim = profile_sim(cache, "surface", n=1)
    x, y, z = (int(v) for v in np.floor(sim.pos[0, 0]))
    sim.pos[0, 1] = sim.pos[0, 0] + [12.0, 0.0, 0.0]
    arrows.fire(sim, np.array([[True, False]]), np.full((1, 2), 1.0), np.zeros((1, 2), dtype=bool))
    sim.arrow_pos[0, 0] = [x + 0.5, y - 0.5 + 2.0, z + 0.5]
    sim.arrow_vel[0, 0] = [0.0, -3.0, 0.0]
    for _ in range(3):
        arrows.step_arrows(sim)
    assert not sim.arrow_on[0, 0]
    assert sim.stuck_on[0].any()
    sim.close()


def test_arrow_crosses_many_passable_cells_to_reach_a_block():
    raw = flat_raw()
    raw[16:19, 16:19, yi(Y) : yi(Y + 3)] = B.COBWEB
    raw[18, 18, yi(Y + 2)] = B.STONE
    sim = Sim(1, SimConfig(kits=(Kit(),), uneven_rate=0.0, arena_half=64.0))
    sim.attach_world(make(raw))
    sim.pos[0, 0] = [8.5, Y, 8.5]
    sim.pos[0, 1] = [28.5, Y, 28.5]
    arrows.fire(sim, np.array([[True, False]]), np.full((1, 2), 1.0), np.zeros((1, 2), dtype=bool))
    sim.arrow_pos[0, 0] = [16.5, Y + 0.5, 16.5]
    sim.arrow_vel[0, 0] = [1.7, 1.7, 1.7]
    arrows.step_arrows(sim)
    assert not sim.arrow_on[0, 0]
    assert sim.stuck_on[0].sum() == 1
    assert (sim.stuck_pos[0, sim.stuck_on[0]][0] < [18.0, Y + 2.0, 18.0]).any()
    sim.close()


def test_arrow_stops_at_a_wall_right_behind_a_cobweb():
    raw = flat_raw()
    raw[16, 18, yi(Y)] = B.COBWEB
    raw[16, 19, yi(Y)] = B.STONE
    sim = Sim(1, SimConfig(kits=(Kit(),), uneven_rate=0.0, arena_half=64.0))
    sim.attach_world(make(raw))
    sim.pos[0, 0] = [8.5, Y, 8.5]
    sim.pos[0, 1] = [28.5, Y, 28.5]
    arrows.fire(sim, np.array([[True, False]]), np.full((1, 2), 1.0), np.zeros((1, 2), dtype=bool))
    sim.arrow_pos[0, 0] = [16.5, Y + 0.5, 17.5]
    sim.arrow_vel[0, 0] = [0.0, 0.0, 2.0]
    arrows.step_arrows(sim)
    assert not sim.arrow_on[0, 0]
    assert sim.stuck_pos[0, sim.stuck_on[0]][0, 2] == pytest.approx(19.0 - arrows.STICK_BACKOFF)
    sim.close()


def test_world_edge_stops_a_body():
    sim = block_sim()
    sim.pos[0, 0] = [16.5, Y, sim.world.base.nz - 1.0]
    sim.yaw[0, 0] = 0.0
    action = idle(sim)
    action[0, 0, A.FORWARD] = A.KEY_FORWARD
    for _ in range(20):
        sim.step(action)
    assert sim.pos[0, 0, 2] == pytest.approx(sim.world.base.nz - C.PLAYER_WIDTH / 2.0, abs=1e-6)
    sim.close()


def test_a_world_with_another_client_model_is_refused():
    sim = Sim(1, SimConfig(client_model="mineflayer"))
    with pytest.raises(ValueError):
        sim.attach_world(make())


def test_sneak_input_is_one_array_for_every_module():
    sim = Sim(1)
    sim.sneaking[0, 1] = True
    assert sim.body.sneak[0, 1] and sim.combat.sneaking[0, 1]
    assert arrows.body_heights(sim)[0, 1] == pytest.approx(1.5)
    assert arrows.spawn_heights(sim)[0, 1] == pytest.approx(1.17)
    sim.reset()
    assert not sim.sneaking.any()


def test_sneaking_target_lowers_the_arrow_hitbox():
    sim = shooter(Kit())
    sim.sneaking[0, 1] = True
    arrows.fire(sim, np.array([[True, False]]), np.full((1, 2), 2.0), np.zeros((1, 2), dtype=bool))
    sim.arrow_pos[0, 0] = [0.0, 1.6, 1.5]
    sim.arrow_vel[0, 0] = [0.0, 0.0, 2.0]
    arrows.step_arrows(sim)
    assert sim.hp[0, 1] == C.MAX_HEALTH
    standing = shooter(Kit())
    arrows.fire(standing, np.array([[True, False]]), np.full((1, 2), 2.0), np.zeros((1, 2), dtype=bool))
    standing.arrow_pos[0, 0] = [0.0, 1.6, 1.5]
    standing.arrow_vel[0, 0] = [0.0, 0.0, 2.0]
    arrows.step_arrows(standing)
    assert standing.hp[0, 1] < C.MAX_HEALTH


@pytest.mark.parametrize("power,damage", [(0, 4.0), (1, 6.0), (3, 8.0), (5, 10.0)])
def test_power_adds_to_the_arrow_base(power, damage):
    sim = shooter(Kit(power=power))
    land_arrow(sim)
    assert C.MAX_HEALTH - sim.hp[0, 1] == pytest.approx(damage)


def test_punch_pushes_along_the_arrow_and_up():
    sim = shooter(Kit(punch=2))
    land_arrow(sim)
    drag = C.GROUND_DRAG
    rest = -C.GRAVITY * C.VERTICAL_DRAG
    lifted = min(C.KNOCKBACK_VERTICAL_CAP, rest * 0.5 + C.BASE_KNOCKBACK) + C.PUNCH_LIFT
    assert sim.vel[0, 1, 2] == pytest.approx((C.BASE_KNOCKBACK + 2 * C.PUNCH_PER_LEVEL) * drag)
    assert sim.vel[0, 1, 1] == pytest.approx((lifted - C.GRAVITY) * C.VERTICAL_DRAG)


def test_punch_does_not_push_inside_the_hurt_window():
    sim = shooter(Kit(punch=2))
    sim.hurt_timer[0, 1] = 5
    sim.last_damage[0, 1] = 1.0
    land_arrow(sim)
    assert sim.hp[0, 1] < C.MAX_HEALTH
    assert sim.vel[0, 1, 2] == 0.0


def test_flame_ignites_on_a_landed_hit_only():
    sim = shooter(Kit(flame=1))
    land_arrow(sim)
    assert sim.combat.fire[0, 1] == C.FLAME_TICKS
    guarded = shooter(Kit(flame=1))
    guarded.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    land_arrow(guarded)
    assert guarded.combat.fire[0, 1] < 0


def test_bow_enchantments_do_not_apply_to_a_crossbow():
    sim = shooter(Kit(power=5, punch=2, flame=1), weapon=C.CROSSBOW)
    land_arrow(sim)
    assert C.MAX_HEALTH - sim.hp[0, 1] == pytest.approx(4.0)
    assert sim.combat.fire[0, 1] < 0
    assert sim.vel[0, 1, 2] == pytest.approx(C.BASE_KNOCKBACK * C.GROUND_DRAG)


def test_enchants_survive_a_stuck_arrow_falling_again():
    raw = flat_raw()
    raw[16, 20, yi(Y)] = B.STONE
    sim = Sim(1, SimConfig(kits=(Kit(power=3),), uneven_rate=0.0, arena_half=64.0))
    sim.attach_world(make(raw))
    sim.pos[0, 0] = [16.5, Y, 16.5]
    sim.pos[0, 1] = [28.5, Y, 28.5]
    sim.weapon[0, 0] = C.BOW
    arrows.fire(sim, np.array([[True, False]]), np.full((1, 2), 2.0), np.zeros((1, 2), dtype=bool))
    expected = sim.arrow_damage[0, 0]
    sim.arrow_pos[0, 0] = [16.5, Y + 0.5, 19.5]
    sim.arrow_vel[0, 0] = [0.0, 0.0, 1.0]
    arrows.step_arrows(sim)
    assert sim.stuck_on[0].any()
    sim.world.set(16, Y, 20, B.AIR)
    arrows.step_arrows(sim)
    assert sim.arrow_on[0].any()
    assert sim.arrow_damage[0, np.flatnonzero(sim.arrow_on[0])[0]] == expected
    sim.close()


def test_blocked_arrow_wears_the_shield_and_keeps_health():
    sim = shooter(Kit())
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    left = sim.combat.shield_left[0, 1]
    armor = sim.combat.armor_left[0, 1].copy()
    land_arrow(sim)
    assert sim.hp[0, 1] == C.MAX_HEALTH
    assert sim.combat.shield_left[0, 1] == left - 5
    assert (sim.combat.armor_left[0, 1] == armor).all()
    assert sim.hurt_timer[0, 1] == C.HURT_TICKS


def test_bow_breaks_after_its_last_point():
    sim = shooter(Kit())
    sim.combat.bow_left[0, 0] = 1
    use = np.array([[True, False]])
    for _ in range(5):
        sim._use_items(use)
    sim._use_items(np.zeros((1, 2), dtype=bool))
    assert sim.events["arrows_fired"][0, 0] == 1
    assert not sim.combat.has_bow[0, 0]
    for _ in range(5):
        sim._use_items(use)
    assert sim.draw_ticks[0, 0] == 0
    sim.reset()
    assert sim.combat.has_bow.all()
    assert (sim.combat.bow_left == I.BOW_DURABILITY).all()


@pytest.mark.parametrize("kit,count", [("archer", 16), ("empty", 0), ("iron", 6)])
def test_kits_set_the_quiver(kit, count):
    sim = Sim(3, SimConfig(kits=(kit,)))
    assert (sim.ammo == count).all()


def test_plain_config_uses_start_arrows():
    assert (Sim(2, SimConfig(start_arrows=11)).ammo == 11).all()


def _walked(level):
    sim = Sim(1, SimConfig(armor="none", arena_half=1000.0))
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [50.0, 0.0, 0.0]
    sim.yaw[0] = 0.0
    if level:
        sim.combat.add_effect(0, 0, I.SPEED, level - 1, 400)
    action = idle(sim)
    action[0, 0, A.FORWARD] = A.KEY_FORWARD
    for _ in range(20):
        sim.step(action)
    start = sim.pos[0, 0, 2]
    for _ in range(20):
        sim.step(action)
    return sim.pos[0, 0, 2] - start


@pytest.mark.parametrize("level", [1, 2])
def test_speed_effect_moves_the_body_faster(level):
    assert _walked(level) / _walked(0) == pytest.approx(1.0 + 0.2 * level, rel=0.01)


def test_speed_effect_ends_on_the_body():
    sim = Sim(1)
    sim.combat.add_effect(0, 0, I.SPEED, 1, 3)
    assert sim.body.speed_level[0, 0] == 2
    action = idle(sim)
    for _ in range(3):
        sim.step(action)
    assert sim.body.speed_level[0, 0] == 0


def test_eating_slows_the_body_to_item_use_speed():
    sim = Sim(1, SimConfig(kits=(Kit(stock=((I.GOLDEN_APPLE, 1),)),), uneven_rate=0.0, arena_half=1000.0))
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [50.0, 0.0, 0.0]
    sim.yaw[0] = 0.0
    sim.items.input[0, 0] = I.GOLDEN_APPLE
    action = idle(sim)
    action[0, 0, A.FORWARD] = A.KEY_FORWARD
    for _ in range(10):
        sim.step(action)
    start = sim.pos[0, 0, 2]
    for _ in range(5):
        sim.step(action)
    speed = (sim.pos[0, 0, 2] - start) / (5 * C.TICKS_PER_DECISION) * C.TICKS_PER_SECOND
    assert speed == pytest.approx(0.863, rel=0.02)


def test_placed_cobweb_slows_a_body():
    stock = ((I.COBWEB, 1),)
    sim = Sim(1, SimConfig(kits=(Kit(stock=stock),), uneven_rate=0.0, arena_half=64.0))
    sim.attach_world(make(flat_raw()))
    sim.pos[0, 0] = [16.5, Y, 16.5]
    sim.pos[0, 1] = [24.5, Y, 24.5]
    sim.yaw[0] = 0.0
    sim.pitch[0, 0] = 45.0
    sim.items.input[0, 0] = I.COBWEB
    sim.step(idle(sim))
    sim.items.input[0, 0] = I.NO_ITEM
    webs = np.argwhere((sim.world.dump(0) & 0xFF) == B.COBWEB)
    assert len(webs) == 1
    x, z, yy = webs[0]
    sim.pitch[0, 0] = 0.0
    sim.pos[0, 0] = [x + 0.5, yy + B.Y_MIN, z + 0.1]
    action = idle(sim)
    action[0, 0, A.FORWARD] = A.KEY_FORWARD
    before = sim.pos[0, 0, 2]
    sim.step(action)
    slowed = sim.pos[0, 0, 2] - before
    sim.world.set(int(x), int(yy + B.Y_MIN), int(z), B.AIR)
    sim.vel[0, 0] = 0.0
    before = sim.pos[0, 0, 2]
    sim.step(action)
    assert slowed < (sim.pos[0, 0, 2] - before) * 0.5
    sim.close()


@pytest.mark.parametrize("rate,ticks", [(10, 24), (15, 16), (20, 12)])
def test_decision_rates(rate, ticks):
    sim = Sim(1, SimConfig(decisions_per_second=rate))
    action = idle(sim)
    for _ in range(12):
        sim.step(action)
    assert sim.ticks[0] == ticks


@pytest.mark.parametrize("rate", [10, 15, 20])
def test_a_decision_turns_by_its_full_delta_at_every_rate(rate):
    sim = Sim(1, SimConfig(decisions_per_second=rate))
    sim.yaw[0] = 0.0
    action = idle(sim)
    index = int(np.flatnonzero(A.YAW_DELTAS == 45.0)[0])
    action[0, 0, A.YAW] = index
    sim.step(action)
    assert sim.yaw[0, 0] == pytest.approx(A.SIM_YAW_STEP[index])


def test_unsupported_decision_rate_is_refused():
    with pytest.raises(ValueError):
        SimConfig(decisions_per_second=12)


@pytest.mark.parametrize("name", ["arena", "surface", "full"])
def test_observations_and_masks_work_in_every_profile(cache, name):
    sim = Sim(4, SimConfig(profile=name, world_size=64, world_cache=cache), seed=1)
    rng = np.random.default_rng(2)
    for _ in range(20):
        sim.step(rng.integers(0, A.NVEC, size=(4, 2, len(A.NVEC))))
        for seat in (0, 1):
            assert np.isfinite(build_obs(sim, seat, 600)).all()
            assert build_masks(sim, seat).any()
    sim.close()
