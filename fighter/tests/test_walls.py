"""The random pillar arena: layout, collision, sight, rays, melee, arrows and opponents."""

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter.obs import ENEMY_IN_SIGHT, RAY_SLOTS, build_masks, build_obs
from fighter.opponents import OPEN_SOURCE_BOTS, SCRIPTED, read_facts
from fighter.pillars import MAX_PILLARS, SPAWN_CLEAR_X, SPAWN_CLEAR_Z, Pillars, draw_layout
from fighter.rays import RAY_COUNT, RAY_RANGE
from fighter.sim import FIGHT_SETUPS, Sim, SimConfig

WALL = (-1, -3, 1, 4, 3)
WALL_TWIN = (-2, -3, 1, 4, 3)


def walled(n=1, seed=0):
    return Sim(n, SimConfig.for_setup("diamond_20_walls"), seed=seed)


def idle(sim):
    return np.tile(A.idle_action(), (sim.n, 2, 1))


def stage(sim, boxes, one, two, yaw_one=None, yaw_two=None):
    """Stand both players at (x, z) spots with these pillars, each facing the other."""
    for env in range(sim.n):
        sim.pillars.set_boxes(env, boxes)
    sim.pos[:, 0] = (one[0], 0.0, one[1])
    sim.pos[:, 1] = (two[0], 0.0, two[1])
    sim.vel[:] = 0.0
    gap = sim.pos[:, 1] - sim.pos[:, 0]
    facing = np.degrees(np.arctan2(-gap[:, 0], gap[:, 2]))
    sim.yaw[:, 0] = facing if yaw_one is None else yaw_one
    sim.yaw[:, 1] = facing + 180.0 if yaw_two is None else yaw_two
    sim.pitch[:] = 0.0
    sim.on_ground[:] = True
    sim.perception.reset(np.arange(sim.n))
    sim.perception.refresh()
    return sim


def boxes_of(sim, env):
    picked = sim.pillars.on[env]
    return sim.pillars.low[env, picked], sim.pillars.high[env, picked]


def test_the_setup_is_diamond_20_with_pillars():
    extra = dict(FIGHT_SETUPS["diamond_20_walls"])
    assert extra.pop("pillars") is True
    assert extra == FIGHT_SETUPS["diamond_20"]
    assert FIGHT_SETUPS["diamond_20"] == {"armor": "diamond", "arena_half": 10.0}
    assert FIGHT_SETUPS["standard"] == {}
    assert Sim(2, SimConfig.for_setup("diamond_20")).pillars is None


def test_pillars_are_refused_outside_the_flat_arena():
    with pytest.raises(ValueError):
        SimConfig(pillars=True, profile="surface")


def test_every_round_has_one_or_two_mirrored_pairs_of_legal_size():
    sim = walled(128, seed=4)
    sizes, counts = set(), set()
    for _ in range(12):
        sim.reset()
        for env in range(sim.n):
            low, high = boxes_of(sim, env)
            counts.add(len(low))
            assert len(low) in (2, 4)
            for k in range(0, len(low), 2):
                assert low[k + 1, 0] == -high[k, 0] and high[k + 1, 0] == -low[k, 0]
                assert low[k + 1, 2] == low[k, 2] and high[k + 1, 2] == high[k, 2]
                assert high[k + 1, 1] == high[k, 1]
                assert high[k, 0] <= low[k + 1, 0] or high[k + 1, 0] <= low[k, 0]
            span = high - low
            sizes |= {(int(w), int(d)) for w, _, d in span}
            assert set(span[:, 1].tolist()) <= {2.0, 3.0}
            assert low[:, [0, 2]].min() >= -9.0 and high[:, [0, 2]].max() <= 10.0
    assert sizes == {(1, 1), (2, 1), (1, 2)}
    assert counts == {2, 4}


def test_layouts_change_every_round():
    sim = walled(4, seed=2)
    first = sim.pillars.low.copy()
    sim.reset()
    assert not np.array_equal(first, sim.pillars.low)


def test_spawns_are_mirrored_and_clear_of_every_pillar():
    sim = walled(128, seed=9)
    for _ in range(12):
        sim.reset()
        assert np.allclose(sim.pos[:, 0, 0], -sim.pos[:, 1, 0])
        assert np.array_equal(sim.pos[:, 0, 2], sim.pos[:, 1, 2])
        for env in range(sim.n):
            low, high = boxes_of(sim, env)
            for seat in (0, 1):
                x, _, z = sim.pos[env, seat]
                gap_x = np.maximum(low[:, 0] - x, x - high[:, 0])
                gap_z = np.maximum(low[:, 2] - z, z - high[:, 2])
                assert ((gap_x >= SPAWN_CLEAR_X) | (gap_z >= SPAWN_CLEAR_Z - 1.0)).all()


def test_a_layout_never_needs_more_than_the_box_slots():
    rng = np.random.default_rng(5)
    for _ in range(300):
        boxes = draw_layout(rng, 10, float(rng.uniform(2.0, 5.0)), float(rng.uniform(-4.5, 4.5)))
        assert 2 <= len(boxes) <= MAX_PILLARS


def test_a_body_stops_at_a_pillar_and_loses_that_speed():
    sim = stage(walled(), [(2, -2, 0, 3, 3)], (0.0, 0.0), (-8.0, 0.0), yaw_one=-90.0)
    action = idle(sim)
    action[0, 0, A.FORWARD] = A.KEY_FORWARD
    for _ in range(30):
        sim.step(action)
    assert sim.pos[0, 0, 0] == pytest.approx(2.0 - C.PLAYER_WIDTH / 2.0, abs=1e-6)
    assert sim.vel[0, 0, 0] == pytest.approx(0.0, abs=0.1)


def test_a_body_slides_along_a_pillar():
    sim = stage(walled(), [(2, -3, 0, 6, 3)], (1.0, 0.0), (-8.0, 0.0), yaw_one=-60.0)
    action = idle(sim)
    action[0, 0, A.FORWARD] = A.KEY_FORWARD
    for _ in range(15):
        sim.step(action)
    assert sim.pos[0, 0, 0] <= 2.0 - C.PLAYER_WIDTH / 2.0 + 1e-6
    assert sim.pos[0, 0, 2] > 0.5


def test_a_wall_hit_ends_a_sprint():
    sim = stage(walled(), [(2, -2, 0, 3, 3)], (0.0, 0.0), (-8.0, 0.0), yaw_one=-90.0)
    action = idle(sim)
    action[0, 0, A.FORWARD] = A.KEY_FORWARD
    action[0, 0, A.SPRINT] = 1
    for _ in range(25):
        sim.step(action)
    assert not sim.sprinting[0, 0]


def test_a_body_lands_on_top_of_a_pillar_and_can_walk_off():
    sim = stage(walled(), [(0, 0, 1, 0, 2)], (-6.0, -6.0), (-8.0, 0.0))
    sim.pos[0, 0] = (1.0, 2.6, 0.5)
    sim.on_ground[0, 0] = False
    for _ in range(12):
        sim.step(idle(sim))
    assert sim.pos[0, 0, 1] == pytest.approx(2.0)
    assert sim.on_ground[0, 0]
    sim.yaw[0, 0] = -90.0
    action = idle(sim)
    action[0, 0, A.FORWARD] = A.KEY_FORWARD
    for _ in range(25):
        sim.step(action)
    assert sim.pos[0, 0, 1] == pytest.approx(0.0)


def test_no_random_fight_ever_puts_a_body_inside_a_pillar():
    sim = walled(32, seed=6)
    rng = np.random.default_rng(1)
    half = C.PLAYER_WIDTH / 2.0 - 1e-5
    for _ in range(250):
        actions = rng.integers(0, A.NVEC, size=(32, 2, len(A.NVEC)))
        actions[..., A.WEAPON] = A.WEAPON_KEEP
        sim.step(actions)
        low = sim.pos[:, :, None] + np.array([-half, 1e-5, -half])
        high = sim.pos[:, :, None] + np.array([half, C.PLAYER_HEIGHT - 1e-5, half])
        wall_low, wall_high = sim.pillars.low[:, None], sim.pillars.high[:, None]
        inside = sim.pillars.on[:, None] & ((high > wall_low) & (low < wall_high)).all(axis=-1)
        assert not inside.any()
        dead = (sim.hp <= 0.0).any(axis=1)
        if dead.any():
            sim.reset(dead)


def test_a_block_ray_stops_at_a_pillar():
    open_sim = stage(walled(), [(8, 8, 0, 0, 2)], (0.0, 0.0), (-8.0, -8.0), yaw_one=-90.0)
    open_rays = build_obs(open_sim, 0)[0, RAY_SLOTS : RAY_SLOTS + RAY_COUNT]
    wall_sim = stage(walled(), [(3, -1, 0, 2, 3)], (0.0, 0.0), (-8.0, -8.0), yaw_one=-90.0)
    wall_rays = build_obs(wall_sim, 0)[0, RAY_SLOTS : RAY_SLOTS + RAY_COUNT]
    flat_ahead = 16
    assert wall_rays[flat_ahead] * RAY_RANGE == pytest.approx(3.0, abs=1e-4)
    assert open_rays[flat_ahead] == pytest.approx(1.0)
    assert (wall_rays <= open_rays + 1e-6).all()


def test_a_pillar_hides_the_enemy_and_its_position_goes_stale():
    sim = stage(walled(), [(-1, -2, 1, 3, 3)], (-4.0, 0.0), (4.0, 0.0))
    obs = build_obs(sim, 0)
    assert obs[0, ENEMY_IN_SIGHT] == 0.0 and obs[0, 37] == 0.0
    known = sim.perception.known_position(0, slice(None)).copy()
    sim.pos[0, 1, 0] = 6.0
    sim.perception.refresh()
    np.testing.assert_array_equal(sim.perception.known_position(0, slice(None)), known)


def test_the_enemy_is_seen_again_past_the_pillar():
    sim = stage(walled(), [(-1, -2, 1, 3, 3)], (-4.0, 0.0), (4.0, 0.0))
    sim.pos[0, 1] = (4.0, 0.0, 6.0)
    sim.perception.refresh()
    obs = build_obs(sim, 0)
    assert obs[0, ENEMY_IN_SIGHT] == 1.0
    np.testing.assert_array_equal(sim.perception.known_position(0, slice(None))[0], sim.pos[0, 1])


def test_a_head_over_a_low_pillar_is_seen():
    sim = stage(walled(), [(-1, -2, 1, 3, 2)], (-4.0, 0.0), (4.0, 0.0))
    assert build_obs(sim, 0)[0, ENEMY_IN_SIGHT] == 0.0
    sim.pos[0, 1, 1] = 1.5
    sim.perception.refresh()
    assert build_obs(sim, 0)[0, ENEMY_IN_SIGHT] == 1.0


def test_melee_and_crosshair_are_blocked_by_a_pillar():
    sim = stage(walled(), [(-1, -2, 1, 3, 3)], (-1.6, 0.0), (1.6, 0.0))
    sim.weapon[:] = C.AXE
    assert not sim.aim_hits()[0, 0]
    obs = build_obs(sim, 0)
    assert obs[0, 35] == 0.0 and obs[0, 36] == 0.0
    action = idle(sim)
    action[0, 0, A.ATTACK] = A.ATTACK_CLICK
    action[0, 0, A.WEAPON] = A.WEAPON_ACTION[C.AXE]
    before = sim.hp[0, 1]
    sim.attack_ticks[:] = 100.0
    sim.step(action)
    assert sim.hp[0, 1] == before


def test_melee_lands_with_the_pillar_out_of_the_way():
    sim = stage(walled(), [(8, 8, 0, 0, 3)], (-1.2, 0.0), (1.2, 0.0))
    sim.weapon[:] = C.AXE
    assert sim.aim_hits()[0, 0]
    action = idle(sim)
    action[0, 0, A.ATTACK] = A.ATTACK_CLICK
    action[0, 0, A.WEAPON] = A.WEAPON_ACTION[C.AXE]
    sim.attack_ticks[:] = 100.0
    sim.step(action)
    assert sim.hp[0, 1] < C.MAX_HEALTH


def shoot(boxes):
    sim = stage(walled(), boxes, (-6.0, 0.0), (6.0, 0.0))
    sim.weapon[:, 0] = C.CROSSBOW
    sim.loaded[:, 0] = True
    sim.yaw[:, 0] = -90.0
    sim.pitch[:, 0] = -1.0
    press = idle(sim)
    press[0, 0, A.WEAPON] = A.WEAPON_KEEP
    press[0, 0, A.USE] = 1
    sim.step(press)
    still = idle(sim)
    still[0, 0, A.WEAPON] = A.WEAPON_KEEP
    for _ in range(20):
        sim.step(still)
    return sim


def test_an_arrow_flies_on_in_the_open():
    sim = shoot([(8, 8, 0, 0, 2)])
    assert sim.hp[0, 1] < C.MAX_HEALTH


def test_an_arrow_sticks_in_a_pillar_and_does_no_damage():
    sim = shoot([(-1, -2, 1, 4, 3)])
    assert sim.hp[0, 1] == C.MAX_HEALTH
    assert sim.stuck_on[0].sum() == 1
    stuck = sim.stuck_pos[0, sim.stuck_on[0]][0]
    assert stuck[0] == pytest.approx(-1.0, abs=0.1)


def test_lock_aim_points_at_the_last_seen_spot_behind_a_pillar():
    sim = stage(walled(), [(-1, -2, 1, 3, 3)], (-5.0, 0.0), (5.0, 0.0))
    sim.pos[0, 1] = (5.0, 0.0, 7.0)
    sim.perception.refresh()
    sim.pos[0, 1] = (5.0, 0.0, -3.0)
    sim.perception.refresh()
    assert build_obs(sim, 0)[0, ENEMY_IN_SIGHT] == 0.0
    sim.weapon[:, 0] = C.CROSSBOW
    action = idle(sim)
    action[0, 0, A.WEAPON] = A.WEAPON_KEEP
    action[0, 0, A.LOCK_AIM] = 1
    sim.step(action)
    assert np.sin(np.radians(sim.yaw[0, 0])) < 0.0
    assert np.cos(np.radians(sim.yaw[0, 0])) > 0.0


def test_scripted_facts_follow_the_last_seen_spot():
    sim = stage(walled(), [(-1, -2, 1, 3, 3)], (-4.0, 0.0), (4.0, 0.0))
    seen_distance = read_facts(sim, 0).distance[0]
    sim.pos[0, 1, 0] = 7.0
    sim.perception.refresh()
    assert read_facts(sim, 0).distance[0] == pytest.approx(seen_distance)
    assert not read_facts(sim, 0).aim[0]


@pytest.mark.parametrize("name", ["pvp_combo", "pvp_sweat", "shield_holder", "archer", *[n for n in OPEN_SOURCE_BOTS if n != "synth"]])
def test_scripted_and_open_bots_play_legally_and_stay_out_of_pillars(name):
    sim = walled(16, seed=3)
    rng = np.random.default_rng(2)
    foe = SCRIPTED["swinger"]
    half = C.PLAYER_WIDTH / 2.0 - 1e-5
    for _ in range(120):
        acts = SCRIPTED[name](sim, 1, rng)
        masks = build_masks(sim, 1)
        for head, offset in enumerate(A.HEAD_OFFSETS):
            if name != "archer":
                assert masks[np.arange(sim.n), offset + acts[:, head]].all(), (name, A.HEADS[head])
        sim.step(np.stack([foe(sim, 0, rng), acts], axis=1))
        low = sim.pos[:, :, None] + np.array([-half, 1e-5, -half])
        high = sim.pos[:, :, None] + np.array([half, C.PLAYER_HEIGHT - 1e-5, half])
        inside = sim.pillars.on[:, None] & ((high > sim.pillars.low[:, None]) & (low < sim.pillars.high[:, None])).all(-1)
        assert not inside.any()
        dead = (sim.hp <= 0.0).any(axis=1)
        if dead.any():
            sim.reset(dead)


def test_a_bot_cannot_hit_through_a_pillar():
    for name in [n for n in ("mineflayer_pvp", "custom_pvp", "sweat_sword", "pvp_combo") if n in SCRIPTED]:
        sim = stage(walled(4), [(-1, -3, 1, 6, 3)], (-1.7, 0.0), (1.7, 0.0))
        rng = np.random.default_rng(1)
        action = idle(sim)
        for _ in range(40):
            acts = SCRIPTED[name](sim, 1, rng)
            sim.pos[:, 0] = (-1.7, 0.0, 0.0)
            sim.step(np.stack([action[:, 0], acts], axis=1))
        assert (sim.hp[:, 0] == C.MAX_HEALTH).all(), name


def test_saved_state_keeps_the_pillars():
    import pickle

    sim = walled(3, seed=1)
    copy = pickle.loads(pickle.dumps(sim))
    np.testing.assert_array_equal(copy.pillars.low, sim.pillars.low)
    np.testing.assert_array_equal(copy.pillars.on, sim.pillars.on)
    copy.step(idle(copy))


def test_pillar_rays_match_a_plain_box_test():
    pillars = Pillars(1, 10.0)
    pillars.set_boxes(0, [(1, 1, 0, 0, 2)])
    start = np.array([[[0.5, 1.0, 1.5]]])
    assert pillars.first_fraction(np.array([0]), start, np.array([[[2.0, 0.0, 0.0]]]))[0, 0] == pytest.approx(0.25)
    assert np.isinf(pillars.first_fraction(np.array([0]), start, np.array([[[-2.0, 0.0, 0.0]]]))[0, 0])
    assert pillars.solid_at(np.array([1.5]), np.array([1.5]), np.array([1.5]))[0]
    assert not pillars.solid_at(np.array([1.5]), np.array([2.5]), np.array([1.5]))[0]
