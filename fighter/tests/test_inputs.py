"""Tests of the 130 inputs, the 11 action heads, their masks and the extension interface."""

import numpy as np
import pytest
from world_helpers import FLOOR, flat_raw, make, yi

from fighter import actions as A
from fighter import arrows as R
from fighter import constants as C
from fighter import rays
from fighter.env import ArenaVecEnv
from fighter.interface import SHARED, InputBlock, Interface
from fighter.items import Kit
from fighter.obs import OBS_DIM, build_masks, build_obs
from fighter.opponents import SCRIPTED, OpponentPool, read_facts
from fighter.policy import NumpyPolicy
from fighter.sim import Sim, SimConfig
from fighter.world import bench
from fighter.world import blocks as B
from fighter.world.config import FULL
from fighter.world.kernel import BaseWorld
from fighter.world.view import WorldView

Y = FLOOR + 1.0


def duel(distance=4.0, **config):
    sim = Sim(1, SimConfig(armor="none", face_noise_deg=0.0, **config), seed=0)
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, distance]
    sim.yaw[0] = [0.0, 180.0]
    sim.pitch[0] = 0.0
    return sim


def world_duel(raw=None):
    sim = Sim(1, SimConfig(armor="none", arena_half=64.0), seed=0)
    sim.attach_world(make(flat_raw() if raw is None else raw))
    sim.pos[0, 0] = [16.5, Y, 10.5]
    sim.pos[0, 1] = [16.5, Y, 13.5]
    sim.yaw[0] = [0.0, 180.0]
    sim.pitch[0] = 0.0
    sim.perception.reset(np.array([0]))
    for _ in range(4):
        sim.update_sight()
    return sim


def idle(sim):
    return A.neutral_actions(sim.weapon.copy())


def test_the_shared_layout_has_130_inputs_and_11_heads():
    assert OBS_DIM == 130
    assert A.HEADS == (
        "forward", "strafe", "sprint", "jump", "yaw", "pitch", "attack", "use", "weapon", "sneak", "lock_aim",
    )
    assert A.NVEC.tolist() == [3, 3, 2, 2, 18, 15, 3, 2, 5, 2, 2]
    assert A.MASK_SIZE == 57
    assert SHARED.obs_dim == 130 and SHARED.mask_size == 57


@pytest.mark.parametrize("profile", ["arena", "surface", "full"])
def test_every_profile_fills_all_inputs_within_range(profile):
    sim = Sim(4, SimConfig(profile=profile, world_size=64), seed=2)
    rng = np.random.default_rng(2)
    for _ in range(12):
        sim.step(rng.integers(0, A.NVEC, size=(4, 2, len(A.NVEC))))
        obs = build_obs(sim, 0, 600)
        assert obs.shape == (4, 130)
        assert np.isfinite(obs).all()
        assert np.abs(obs).max() <= 5.0
        masks = build_masks(sim, 0)
        for start, size in zip(A.HEAD_OFFSETS, A.NVEC):
            assert masks[:, start : start + size].any(axis=1).all()
    sim.close()


def test_own_body_slots():
    sim = duel()
    sim.hp[0, 0] = 10.0
    sim.vel[0, 0] = [0.0, 0.2, 0.5]
    sim.on_ground[0, 0] = False
    sim.sprinting[0, 0] = True
    sim.body.sneak[0, 0] = True
    sim.pitch[0, 0] = 30.0
    sim.hurt_timer[0, 0] = 5
    sim.body.fall[0, 0] = 2.0
    obs = build_obs(sim, 0)[0]
    assert obs[0] == pytest.approx(0.5)
    assert obs[1] == pytest.approx(1.5)
    assert obs[2] == pytest.approx(0.0, abs=1e-6)
    assert obs[3] == pytest.approx(0.6)
    assert (obs[4], obs[5], obs[6]) == (0.0, 1.0, 1.0)
    assert obs[7] == pytest.approx(0.5)
    assert (obs[8], obs[9]) == (0.0, 0.0)
    assert obs[10] == pytest.approx(0.5)
    assert obs[11] == pytest.approx(0.5)


def test_own_speed_is_clipped():
    sim = duel()
    sim.vel[0, 0] = [0.0, 5.0, 5.0]
    obs = build_obs(sim, 0)[0]
    assert obs[1] == 3.0 and obs[3] == 3.0


@pytest.mark.parametrize("weapon, slot, enemy_slot", [
    (C.AXE, 12, 48), (C.SWORD, 13, 49), (C.CROSSBOW, 14, 50), (C.BOW, 15, 51),
])
def test_weapon_slots(weapon, slot, enemy_slot):
    sim = duel()
    sim.weapon[0] = weapon
    obs = build_obs(sim, 0)[0]
    assert obs[12:16].sum() == 1.0 and obs[slot] == 1.0
    assert obs[48:52].sum() == 1.0 and obs[enemy_slot] == 1.0


def test_charge_and_crit_slots():
    sim = duel()
    sim.attack_ticks[0, 0] = 0.0
    obs = build_obs(sim, 0)[0]
    assert obs[16] == pytest.approx(0.5 / 12.5)
    assert obs[17] == 0.0
    sim.attack_ticks[0, 0] = 100.0
    sim.on_ground[0, 0] = False
    sim.vel[0, 0, 1] = -0.2
    obs = build_obs(sim, 0)[0]
    assert (obs[16], obs[17], obs[18]) == (1.0, 1.0, 1.0)


def test_shield_and_ranged_slots():
    sim = duel()
    sim.shield_ticks[0, 0] = C.SHIELD_RAISE_TICKS
    sim.shield_disabled[0, 0] = 50
    sim.loaded[0, 0] = True
    sim.load_ticks[0, 0] = 5
    sim.draw_ticks[0, 0] = 10
    sim.ammo[0, 0] = 3
    obs = build_obs(sim, 0)[0]
    assert (obs[19], obs[20]) == (1.0, 1.0)
    assert obs[21] == pytest.approx(0.5)
    assert obs[22] == 1.0
    assert obs[23] == pytest.approx(0.2)
    assert obs[24] == pytest.approx(0.5)
    assert obs[25] == pytest.approx(0.5)
    sim.ammo[0, 0] = 40
    assert build_obs(sim, 0)[0, 25] == 1.0


def test_aim_error_slots_use_the_client_turn_direction():
    sim = duel()
    sim.yaw[0, 0] = 30.0
    obs = build_obs(sim, 0)[0]
    assert obs[26] == pytest.approx(np.sin(np.radians(30.0)), abs=1e-5)
    assert obs[27] == pytest.approx(np.cos(np.radians(30.0)), abs=1e-5)
    assert obs[29] == 1.0
    sim.yaw[0, 0] = 0.0
    sim.pitch[0, 0] = 5.0
    want = np.degrees(np.arctan2(1.2 - C.EYE_HEIGHT, 4.0))
    obs = build_obs(sim, 0)[0]
    assert obs[28] == pytest.approx((want + 5.0) / 90.0, abs=1e-5)
    assert obs[30] == pytest.approx((want + 5.0) / 10.0, abs=1e-5)


def test_distance_slots():
    sim = duel(distance=8.0)
    sim.pos[0, 1, 1] = 1.5
    obs = build_obs(sim, 0)[0]
    assert obs[31] == pytest.approx(1.0)
    assert obs[32] == pytest.approx(0.25)
    assert obs[33] == pytest.approx(7.7 / 4.0, abs=1e-5)
    assert obs[34] == pytest.approx(0.5)


def test_crosshair_and_sight_slots_on_a_flat_arena():
    sim = duel(distance=2.0)
    sim.pitch[0, 0] = 5.0
    obs = build_obs(sim, 0)[0]
    assert (obs[35], obs[36], obs[37], obs[38]) == (1.0, 1.0, 1.0, 1.0)
    sim.pos[0, 1, 2] = 10.0
    obs = build_obs(sim, 0)[0]
    assert obs[35] == 0.0 and obs[36] == 1.0


def test_enemy_state_slots():
    sim = duel()
    sim.body.last_move[0, 1] = [0.0, 0.1, -0.2]
    sim.sprinting[0, 1] = True
    sim.hurt_timer[0, 1] = 5
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    sim.shield_disabled[0, 1] = 25
    sim.attack_ticks[0, 1] = 0.0
    sim.perception.enemy_health[0, 0] = 15.0
    obs = build_obs(sim, 0)[0]
    assert obs[39] == pytest.approx(-0.6)
    assert obs[40] == pytest.approx(0.0, abs=1e-6)
    assert obs[41] == pytest.approx(0.3)
    assert (obs[42], obs[43], obs[44]) == (0.0, 1.0, 0.0)
    assert obs[45] == pytest.approx(0.75)
    assert obs[46] == pytest.approx(0.5)
    assert obs[47] == pytest.approx(0.5 / 12.5)
    assert (obs[52], obs[53]) == (1.0, 1.0)
    assert obs[54] == pytest.approx(0.25)
    assert obs[55] == pytest.approx(1.0)
    assert obs[56] == pytest.approx(0.0, abs=1e-6)
    assert obs[60] == 0.0


def test_enemy_ranged_slots_show_only_the_held_crossbow():
    sim = duel()
    sim.weapon[0, 1] = C.BOW
    sim.draw_ticks[0, 1] = 10
    sim.loaded[0, 1] = True
    obs = build_obs(sim, 0)[0]
    assert (obs[57], obs[59]) == (1.0, 0.0)
    assert obs[58] == pytest.approx(10.0 / 25.0)
    sim.weapon[0, 1] = C.CROSSBOW
    sim.draw_ticks[0, 1] = 0
    obs = build_obs(sim, 0)[0]
    assert (obs[57], obs[59]) == (0.0, 1.0)


def test_event_timer_slots():
    sim = duel(distance=2.0)
    assert build_obs(sim, 0)[0, 61:66].tolist() == [1.0] * 5
    assert build_obs(sim, 0)[0, 66] == 0.0
    sim.pitch[0, 0] = 10.0
    sim.attack_ticks[0, 0] = 1000.0
    action = idle(sim)
    action[0, 0, A.ATTACK] = A.ATTACK_CLICK
    sim.step(action)
    me = build_obs(sim, 0)[0]
    other = build_obs(sim, 1)[0]
    assert me[61] == 0.0
    assert me[66] == pytest.approx(0.2)
    assert other[62] == 0.0
    assert other[64] == 0.0
    sim.step(idle(sim))
    assert build_obs(sim, 0)[0, 61] == pytest.approx(2.0 / 40.0)
    assert build_obs(sim, 1)[0, 62] == pytest.approx(2.0 / 40.0)


def test_a_whiff_sets_the_whiff_timer():
    sim = duel(distance=8.0)
    action = idle(sim)
    action[0, 1, A.ATTACK] = A.ATTACK_CLICK
    sim.step(action)
    assert build_obs(sim, 0)[0, 65] == 0.0
    sim.step(idle(sim))
    assert build_obs(sim, 0)[0, 65] == pytest.approx(2.0 / 40.0)


def test_round_time_and_last_key_slots():
    sim = duel()
    action = idle(sim)
    action[0, 0, A.FORWARD] = A.KEY_BACK
    action[0, 0, A.STRAFE] = A.KEY_RIGHT
    action[0, 0, A.SPRINT] = 1
    action[0, 0, A.JUMP] = 1
    action[0, 0, A.YAW] = int(np.flatnonzero(A.YAW_DELTAS == 45.0)[0])
    action[0, 0, A.ATTACK] = A.ATTACK_DOUBLE
    action[0, 0, A.USE] = 1
    sim.step(action)
    obs = build_obs(sim, 0)[0]
    assert obs[67] == pytest.approx(2.0 / 1200.0)
    assert obs[68:72].tolist() == [-1.0, 1.0, 1.0, 1.0]
    assert obs[72] == pytest.approx(0.5)
    assert (obs[73], obs[74]) == (1.0, 1.0)


def test_lead_slots_point_at_the_solved_shot():
    sim = duel(distance=12.0)
    sim.weapon[0, 0] = C.BOW
    yaw, pitch, flight = R.intercept(sim, 0, R.aim_speed(sim, 0))
    sim.yaw[0, 0] = yaw[0]
    sim.pitch[0, 0] = pitch[0]
    obs = build_obs(sim, 0)[0]
    assert obs[75:79] == pytest.approx([0.0] * 4, abs=1e-5)
    assert obs[79] == pytest.approx(0.0, abs=1e-5)
    assert obs[80] == pytest.approx(flight[0] / 20.0, abs=1e-5)
    sim.yaw[0, 0] = yaw[0] + 1.0
    obs = build_obs(sim, 0)[0]
    assert obs[75] == pytest.approx(1.0 / 30.0, abs=1e-5)
    assert obs[77] == pytest.approx(0.5, abs=1e-5)


def test_incoming_arrow_slots():
    sim = duel()
    assert not build_obs(sim, 0)[0, 81:93].any()
    sim.arrow_on[0, 0] = True
    sim.arrow_owner[0, 0] = 1
    sim.arrow_pos[0, 0] = [0.0, 0.9, 8.0]
    sim.arrow_vel[0, 0] = [0.0, 0.0, -2.0]
    obs = build_obs(sim, 0)[0]
    assert obs[81] == pytest.approx(0.5)
    assert obs[82] == pytest.approx(0.0, abs=1e-6)
    assert obs[83] == pytest.approx(0.0, abs=1e-6)
    assert obs[84] == pytest.approx(4.0 / 20.0)
    assert obs[85] == pytest.approx(0.0, abs=1e-6)
    assert obs[86] == 1.0
    assert not obs[87:93].any()
    sim.arrow_on[0, 1] = True
    sim.arrow_owner[0, 1] = 1
    sim.arrow_pos[0, 1] = [3.0, 0.9, 12.0]
    sim.arrow_vel[0, 1] = [0.0, 0.0, -2.0]
    obs = build_obs(sim, 0)[0]
    assert obs[87] == pytest.approx(0.75)
    assert obs[89] == pytest.approx(0.0, abs=1e-6)
    assert obs[91] == 1.0 and obs[92] == 0.0


def test_own_arrows_are_not_incoming():
    sim = duel()
    sim.arrow_on[0, 0] = True
    sim.arrow_owner[0, 0] = 0
    sim.arrow_pos[0, 0] = [0.0, 0.9, 8.0]
    sim.arrow_vel[0, 0] = [0.0, 0.0, -2.0]
    assert not build_obs(sim, 0)[0, 81:93].any()


def test_pickup_slots_wait_until_an_arrow_is_seen_landed():
    sim = duel()
    sim.stuck_on[0, 0] = True
    sim.stuck_pickup[0, 0] = True
    sim.stuck_pos[0, 0] = [-2.0, 0.1, 2.0]
    sim.stuck_age[0, 0] = 19
    assert not build_obs(sim, 0)[0, 93:96].any()
    sim.stuck_age[0, 0] = 20
    obs = build_obs(sim, 0)[0]
    assert obs[93] == 1.0
    assert obs[94] == pytest.approx(0.5)
    assert obs[95] == pytest.approx(0.5)
    sim.stuck_pos[0, 0] = [5.0, 0.1, 0.0]
    assert build_obs(sim, 0)[0, 93] == 0.0


def test_ray_slots_read_the_floor_and_walls_in_order():
    sim = duel()
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.yaw[0, 0] = 0.0
    obs = build_obs(sim, 0)[0]
    down = C.EYE_HEIGHT / np.sin(np.radians(55.0))
    assert obs[96:104] == pytest.approx([down / 8.0] * 8, abs=1e-5)
    assert obs[104:112] == pytest.approx([C.EYE_HEIGHT / np.sin(np.radians(20.0)) / 8.0] * 8, abs=1e-5)
    assert obs[112:120] == pytest.approx([1.0] * 8)
    assert obs[120] == 1.0
    assert obs[121] == pytest.approx(C.EYE_HEIGHT / 8.0, abs=1e-5)
    sim.pos[0, 0] = [0.0, 0.0, 9.0]
    obs = build_obs(sim, 0)[0]
    assert obs[112] == pytest.approx(3.0 / 8.0, abs=1e-5)
    assert obs[116] == 1.0


def test_rays_turn_with_the_body():
    sim = duel()
    sim.pos[0, 0] = [9.0, 0.0, 0.0]
    sim.yaw[0, 0] = -90.0
    assert build_obs(sim, 0)[0, 112] == pytest.approx(3.0 / 8.0, abs=1e-5)
    sim.yaw[0, 0] = 0.0
    assert build_obs(sim, 0)[0, 114] == pytest.approx(1.0)
    assert build_obs(sim, 0)[0, 118] == pytest.approx(3.0 / 8.0, abs=1e-5)


def test_hazard_slots_are_constant_in_the_arena():
    obs = build_obs(duel(), 0)[0]
    assert obs[122:125].tolist() == [1.0, 0.0, 1.0]
    assert obs[125:128].tolist() == [1.0, 0.0, 1.0]


def test_border_and_tracking_slots():
    sim = duel()
    sim.pos[0, 0] = [8.0, 0.0, 0.0]
    obs = build_obs(sim, 0)[0]
    assert obs[128] == pytest.approx(4.0 / 16.0)
    assert obs[129] == 1.0


def _room(block, cells):
    raw = flat_raw()
    for x, y, z in cells:
        raw[x, z, yi(int(Y) + y)] = block
    return raw


def test_lava_seen_ahead_fills_the_hazard_slots():
    raw = flat_raw()
    raw[14:19, 13:16, yi(FLOOR)] = B.LAVA_SOURCE
    sim = world_duel(raw)
    sim.pos[0, 1] = [28.5, Y, 28.5]
    sim.pitch[0, 0] = 35.0
    for _ in range(6):
        sim.update_sight()
    sim.pitch[0, 0] = 0.0
    obs = build_obs(sim, 0)[0]
    assert obs[122] < 1.0
    assert abs(obs[123]) < 0.8
    assert obs[124] > 0.5
    sim.close()


def test_water_is_reported_at_its_surface_and_does_not_stop_the_ray():
    raw = flat_raw()
    raw[14:19, 12:16, yi(FLOOR)] = B.WATER
    sim = world_duel(raw)
    sim.pos[0, 1] = [28.5, Y, 28.5]
    sim.pitch[0, 0] = 35.0
    for _ in range(6):
        sim.update_sight()
    view = sim.world_view()
    eye = sim.eyes()[:, 0]
    direction = rays.world_directions(sim.yaw[:, 0])
    free, hazard, water = view.rays_many(np.array([0]), 0, eye, direction, rays.RAY_RANGE)
    wet = water[0] >= 0.0
    assert wet.any()
    assert (free[0][wet] > water[0][wet]).all()
    assert not hazard.any()
    sim.pitch[0, 0] = 0.0
    assert build_obs(sim, 0)[0, 125] < 1.0
    sim.close()


def test_rays_stop_at_unknown_cells():
    sim = world_duel()
    view = sim.world_view()
    eye = sim.eyes()[:, 0]
    behind = rays.world_directions(sim.yaw[:, 0])[:, [20]]
    free, _, _ = view.rays_many(np.array([0]), 0, eye, behind, rays.RAY_RANGE)
    assert free[0, 0] < rays.RAY_RANGE
    sim.close()


def test_an_enemy_behind_cover_is_held_at_its_last_seen_place():
    sim = world_duel()
    first = build_obs(sim, 0)[0].copy()
    assert first[38] == 1.0 and first[37] == 1.0
    for x in range(32):
        for up in range(5):
            sim.world.set(x, int(Y) + up, 16, B.STONE)
    sim.pos[0, 1] = [16.5, Y, 24.5]
    sim.body.last_move[0, 1] = [0.3, 0.0, 0.3]
    for _ in range(3):
        sim.update_sight()
    hidden = build_obs(sim, 0)[0]
    assert hidden[38] == 0.0 and hidden[37] == 0.0
    assert hidden[35] == 0.0 and hidden[36] == 0.0
    assert hidden[26:35].tobytes() == first[26:35].tobytes()
    assert hidden[39:42].tobytes() == first[39:42].tobytes()
    sim.pos[0, 1] = [2.5, Y, 30.5]
    for _ in range(2):
        sim.update_sight()
    assert build_obs(sim, 0)[0, 26:35].tobytes() == first[26:35].tobytes()
    sim.close()


def test_a_hidden_enemy_does_not_move_the_lead_slots():
    sim = world_duel()
    sim.weapon[0, 0] = C.BOW
    first = build_obs(sim, 0)[0, 75:81].copy()
    for x in range(32):
        for up in range(5):
            sim.world.set(x, int(Y) + up, 16, B.STONE)
    sim.pos[0, 1] = [16.5, Y, 24.5]
    for _ in range(3):
        sim.update_sight()
    assert build_obs(sim, 0)[0, 75:81] == pytest.approx(first, abs=1e-5)
    sim.pos[0, 1] = [4.5, Y, 28.5]
    sim.update_sight()
    assert build_obs(sim, 0)[0, 75:81] == pytest.approx(first, abs=1e-5)
    sim.close()


def test_an_enemy_comes_back_when_seen_again():
    sim = world_duel()
    for x in range(32):
        for up in range(5):
            sim.world.set(x, int(Y) + up, 16, B.STONE)
    sim.pos[0, 1] = [16.5, Y, 24.5]
    sim.update_sight()
    assert build_obs(sim, 0)[0, 38] == 0.0
    sim.pos[0, 1] = [18.5, Y, 13.5]
    sim.update_sight()
    obs = build_obs(sim, 0)[0]
    assert obs[38] == 1.0
    assert obs[31] == pytest.approx(np.hypot(2.0, 3.0) / 8.0, abs=1e-5)
    sim.close()


def test_closed_form_rays_equal_the_kernel_on_a_flat_walled_world():
    half = 12
    center = 16
    raw = flat_raw()
    raw[: center - half, :, yi(FLOOR) : yi(FLOOR + 14)] = B.STONE
    raw[center + half :, :, yi(FLOOR) : yi(FLOOR + 14)] = B.STONE
    raw[:, : center - half, yi(FLOOR) : yi(FLOOR + 14)] = B.STONE
    raw[:, center + half :, yi(FLOOR) : yi(FLOOR + 14)] = B.STONE
    world = make(raw, n=64)
    rng = np.random.default_rng(4)
    body = rng.uniform(-half + 0.3, half - 0.3, size=(64, 2))
    eye_local = np.column_stack([body[:, 0], np.full(64, C.EYE_HEIGHT), body[:, 1]])
    yaw = rng.uniform(-180.0, 180.0, size=64)
    directions = rays.world_directions(yaw)
    closed = rays.flat_distances(eye_local, directions, float(half))
    origin = eye_local + np.array([center, FLOOR + 1.0, center])
    start = np.repeat(origin[:, None, :], rays.RAY_COUNT, axis=1)
    hit, _, _, dist = world.ray_block_many(start, directions, rays.RAY_RANGE)
    kernel = np.where(hit, dist, rays.RAY_RANGE)
    assert np.abs(kernel - closed).max() < 1e-9
    world.close()


def test_batched_rays_equal_single_calls():
    raw = flat_raw()
    rng = np.random.default_rng(5)
    for _ in range(40):
        x, z = rng.integers(4, 28, size=2)
        raw[x, z, yi(FLOOR + 1) : yi(FLOOR + 1) + int(rng.integers(1, 4))] = B.STONE
    world = make(raw, n=8)
    view = WorldView(world)
    eyes = np.zeros((8, 2, 3))
    eyes[..., [0, 2]] = rng.uniform(6.0, 26.0, size=(8, 2, 2))
    eyes[..., 1] = FLOOR + 3.62
    yaw = rng.uniform(-180.0, 180.0, size=(8, 2))
    pitch = rng.uniform(-30.0, 30.0, size=(8, 2))
    for _ in range(4):
        view.update_all(eyes, yaw, pitch)
    for seat in (0, 1):
        directions = rays.world_directions(yaw[:, seat])
        free, _, _ = view.rays_many(np.arange(8), seat, eyes[:, seat], directions, rays.RAY_RANGE)
        for arena in range(8):
            single, _ = view.rays(arena, seat, eyes[arena, seat], directions[arena], rays.RAY_RANGE)
            assert free[arena] == pytest.approx(single)
    world.close()


def test_a_seat_that_never_builds_inputs_still_tracks_the_enemy():
    sim = world_duel()
    sim.pos[0, 0] = [14.5, Y, 13.5]
    sim.update_sight()
    assert sim.perception.seen_pos[0, 1].tolist() == [14.5, Y, 13.5]


def test_batched_and_travelling_speed_scenes_run():
    raw = flat_raw(64)
    heights = np.full((64, 64), FLOOR)
    for travel in (False, True):
        cost, memory = bench._batch_cost(BaseWorld.from_array(raw), FULL, heights, travel, arenas=4)
        assert cost > 0.0 and memory > 0


def test_forward_and_strafe_heads_move_the_body():
    for key, axis, sign in ((A.KEY_FORWARD, 2, 1.0), (A.KEY_BACK, 2, -1.0)):
        sim = duel(distance=10.0)
        action = idle(sim)
        action[0, 0, A.FORWARD] = key
        sim.step(action)
        assert np.sign(sim.pos[0, 0, axis]) == sign
    for key, sign in ((A.KEY_LEFT, 1.0), (A.KEY_RIGHT, -1.0)):
        sim = duel(distance=10.0)
        action = idle(sim)
        action[0, 0, A.STRAFE] = key
        sim.step(action)
        assert np.sign(sim.pos[0, 0, 0]) == sign


@pytest.mark.parametrize("index", range(len(A.YAW_DELTAS)))
def test_yaw_head_turns_opposite_to_the_simulator_angle(index):
    sim = duel()
    sim.yaw[0, 0] = 10.0
    action = idle(sim)
    action[0, 0, A.YAW] = index
    sim.step(action)
    expected = (10.0 - A.YAW_DELTAS[index] + 180.0) % 360.0 - 180.0
    assert sim.yaw[0, 0] == pytest.approx(expected)


@pytest.mark.parametrize("index", range(len(A.PITCH_DELTAS)))
def test_pitch_head_turns_opposite_to_the_simulator_angle(index):
    sim = duel()
    sim.pitch[0, 0] = 5.0
    action = idle(sim)
    action[0, 0, A.PITCH] = index
    sim.step(action)
    assert sim.pitch[0, 0] == pytest.approx(np.clip(5.0 - A.PITCH_DELTAS[index], -90.0, 90.0))


def test_click_swings_once_and_double_click_twice_on_consecutive_ticks():
    sim = duel(distance=8.0)
    action = idle(sim)
    action[0, 0, A.ATTACK] = A.ATTACK_CLICK
    sim.step(action)
    assert sim.events["swings"][0, 0] == 1
    sim = duel(distance=8.0)
    action = idle(sim)
    action[0, 0, A.ATTACK] = A.ATTACK_DOUBLE
    sim._rotation_ticks = 2
    sim._tick(action, first=True)
    assert sim.events["swings"][0, 0] == 1
    sim._tick(action, first=False)
    assert sim.events["swings"][0, 0] == 2
    assert not sim.combat.second_click.any()


def test_a_second_click_carries_to_the_next_decision_at_one_tick_per_decision():
    sim = duel(distance=8.0, decisions_per_second=20)
    action = idle(sim)
    action[0, 0, A.ATTACK] = A.ATTACK_DOUBLE
    sim.step(action)
    assert sim.events["swings"][0, 0] == 1
    sim.step(idle(sim))
    assert sim.events["swings"][0, 0] == 1
    sim.step(idle(sim))
    assert sim.events["swings"][0, 0] == 0


@pytest.mark.parametrize("weapon", [C.AXE, C.SWORD, C.CROSSBOW, C.BOW])
def test_weapon_head_selects_and_keeps(weapon):
    sim = duel()
    action = idle(sim)
    action[0, 0, A.WEAPON] = A.WEAPON_ACTION[weapon]
    sim.step(action)
    assert sim.weapon[0, 0] == weapon
    action[0, 0, A.WEAPON] = A.WEAPON_KEEP
    sim.step(action)
    assert sim.weapon[0, 0] == weapon


def test_sneak_head_holds_only_while_pressed():
    sim = duel()
    action = idle(sim)
    action[0, 0, A.SNEAK] = 1
    sim.step(action)
    assert sim.body.sneak[0, 0] and not sim.body.sneak[0, 1]
    assert build_obs(sim, 0)[0, 6] == 1.0
    sim.step(idle(sim))
    assert not sim.body.sneak[0, 0]


def test_sneak_set_on_the_body_survives_an_idle_head():
    sim = duel()
    sim.body.sneak[0, 0] = True
    sim.step(idle(sim))
    assert sim.body.sneak[0, 0]


def test_lock_aim_looks_at_the_solved_shot_with_a_ranged_weapon():
    sim = duel(distance=12.0)
    sim.weapon[0, 0] = C.BOW
    sim.yaw[0, 0] = 25.0
    want_yaw, want_pitch, _ = R.intercept(sim, 0, R.aim_speed(sim, 0))
    action = idle(sim)
    action[0, 0, A.LOCK_AIM] = 1
    action[0, 0, A.YAW] = int(np.flatnonzero(A.YAW_DELTAS == 45.0)[0])
    sim.step(action)
    assert sim.yaw[0, 0] == pytest.approx(want_yaw[0])
    assert sim.pitch[0, 0] == pytest.approx(want_pitch[0])


def test_lock_aim_does_nothing_with_a_melee_weapon():
    sim = duel(distance=12.0)
    sim.yaw[0, 0] = 25.0
    action = idle(sim)
    action[0, 0, A.LOCK_AIM] = 1
    sim.step(action)
    assert sim.yaw[0, 0] == pytest.approx(25.0)


def test_lock_aim_keeps_the_chosen_pitch_when_the_shot_cannot_reach():
    sim = Sim(1, SimConfig(armor="none", arena_half=200.0), seed=0)
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 190.0]
    sim.weapon[0, 0] = C.BOW
    sim.draw_ticks[0, 0] = 1
    sim.pitch[0, 0] = 5.0
    action = idle(sim)
    action[0, 0, A.LOCK_AIM] = 1
    action[0, 0, A.USE] = 1
    sim.step(action)
    assert sim.pitch[0, 0] == pytest.approx(5.0)


def mask_of(sim, head, choice=1, seat=0):
    return build_masks(sim, seat)[0, A.HEAD_OFFSETS[head] + choice]


def test_sprint_is_masked_while_using_an_item():
    sim = duel()
    assert mask_of(sim, A.SPRINT)
    sim.shield_ticks[0, 0] = 1
    assert not mask_of(sim, A.SPRINT)


def test_jump_is_allowed_on_the_ground_or_in_water():
    sim = duel()
    sim.on_ground[0, 0] = False
    assert not mask_of(sim, A.JUMP)
    sim.combat.in_water[0, 0] = True
    assert mask_of(sim, A.JUMP)


@pytest.mark.parametrize("weapon", [C.BOW, C.CROSSBOW])
def test_use_is_blocked_with_no_arrows(weapon):
    sim = duel()
    sim.weapon[0, 0] = weapon
    sim.ammo[0, 0] = 1
    assert mask_of(sim, A.USE)
    sim.ammo[0, 0] = 0
    assert not mask_of(sim, A.USE)


def test_a_loaded_crossbow_can_fire_with_no_arrows_left():
    sim = duel()
    sim.weapon[0, 0] = C.CROSSBOW
    sim.ammo[0, 0] = 0
    sim.loaded[0, 0] = True
    assert mask_of(sim, A.USE)


def test_release_is_forced_after_a_load():
    sim = duel()
    sim.weapon[0, 0] = C.CROSSBOW
    sim.load_wait[0, 0] = True
    assert not mask_of(sim, A.USE)
    assert mask_of(sim, A.USE, choice=0)


def test_weapons_the_kit_lacks_are_blocked():
    sim = duel(kits=(Kit(sword="none", arrows=0),))
    weapon = A.HEAD_OFFSETS[A.WEAPON]
    masks = build_masks(sim, 0)[0]
    assert masks[weapon + A.WEAPON_KEEP]
    assert masks[weapon + A.WEAPON_ACTION[C.AXE]]
    assert not masks[weapon + A.WEAPON_ACTION[C.SWORD]]
    assert not masks[weapon + A.WEAPON_ACTION[C.BOW]]
    assert not masks[weapon + A.WEAPON_ACTION[C.CROSSBOW]]


def test_lock_aim_is_blocked_without_a_ranged_weapon():
    sim = duel()
    assert not mask_of(sim, A.LOCK_AIM)
    sim.weapon[0, 0] = C.BOW
    assert mask_of(sim, A.LOCK_AIM)


def test_fine_turns_are_blocked_within_nine_blocks():
    sim = duel(distance=8.9, arena_half=40.0)
    masks = build_masks(sim, 0)[0]
    assert not masks[A.HEAD_OFFSETS[A.YAW] + np.flatnonzero(A.FINE_YAW)].any()
    assert not masks[A.HEAD_OFFSETS[A.PITCH] + np.flatnonzero(A.FINE_PITCH)].any()
    assert masks[A.HEAD_OFFSETS[A.YAW] + np.flatnonzero(~A.FINE_YAW)].all()
    sim.pos[0, 1, 2] = 9.1
    masks = build_masks(sim, 0)[0]
    assert masks[A.HEAD_OFFSETS[A.YAW] : A.HEAD_OFFSETS[A.YAW] + A.NVEC[A.YAW]].all()
    assert masks[A.HEAD_OFFSETS[A.PITCH] : A.HEAD_OFFSETS[A.PITCH] + A.NVEC[A.PITCH]].all()


def test_observing_some_arenas_equals_the_full_build():
    sim = Sim(16, SimConfig(), seed=6)
    rng = np.random.default_rng(6)
    for _ in range(40):
        sim.step(rng.integers(0, A.NVEC, size=(16, 2, len(A.NVEC))))
    rows = np.array([1, 5, 11])
    for seat in (0, 1):
        assert build_obs(sim, seat, 600, rows).tobytes() == build_obs(sim, seat, 600)[rows].tobytes()
        assert build_masks(sim, seat, rows=rows).tobytes() == build_masks(sim, seat)[rows].tobytes()


def test_observing_some_world_arenas_equals_the_full_build():
    sim = Sim(6, SimConfig(profile="surface", world_size=64), seed=7)
    rng = np.random.default_rng(7)
    for _ in range(10):
        sim.step(rng.integers(0, A.NVEC, size=(6, 2, len(A.NVEC))))
    rows = np.array([0, 4])
    assert build_obs(sim, 1, 600, rows).tobytes() == build_obs(sim, 1, 600)[rows].tobytes()
    sim.close()


def _env(n=8, seed=3, max_ticks=40):
    pool = OpponentPool(n, seed=seed, max_ticks=max_ticks)
    pool.set_mix({"swinger": 1.0, "random": 1.0})
    return ArenaVecEnv(n, pool, SimConfig(), max_ticks=max_ticks, seed=seed)


def test_reset_observations_are_built_only_for_arenas_that_ended(monkeypatch):
    env = _env()
    env.reset()
    calls = []
    real = env.interface.observe

    class Counting:
        obs_dim = env.interface.obs_dim
        nvec = env.interface.nvec

        @staticmethod
        def observe(sim, seat, max_ticks, rows=None):
            calls.append(None if rows is None else len(rows))
            return real(sim, seat, max_ticks, rows)

        masks = staticmethod(env.interface.masks)
        split = staticmethod(env.interface.split)
        apply = None

    env.interface = Counting
    idle_action = A.neutral_actions(env.sim.weapon[:, 0].copy())
    env.step_async(idle_action)
    env.step_wait()
    assert calls == [None]
    calls.clear()
    env.sim.hp[2, 1] = 0.0
    env.step_async(A.neutral_actions(env.sim.weapon[:, 0].copy()))
    _, _, done, infos = env.step_wait()
    assert done[2] and done.sum() == 1
    assert calls == [None, 1]
    assert infos[2]["terminal_observation"].shape == (130,)


def test_returned_observations_match_a_fresh_build_after_a_reset():
    env = _env(max_ticks=20)
    env.reset()
    for _ in range(25):
        env.step_async(A.neutral_actions(env.sim.weapon[:, 0].copy()))
        obs, _, _, _ = env.step_wait()
        fresh = np.clip(build_obs(env.sim, 0, env.max_ticks), -5.0, 5.0)
        assert obs.tobytes() == fresh.tobytes()


def test_opponent_facts_are_computed_once_per_step(monkeypatch):
    import fighter.opponents as O

    count = {"n": 0}
    real = O.read_facts

    def counted(sim, seat):
        count["n"] += 1
        return real(sim, seat)

    monkeypatch.setattr(O, "read_facts", counted)
    sim = Sim(32, SimConfig(), seed=1)
    pool = OpponentPool(32, seed=1)
    pool.set_mix({"walker": 1.0, "swinger": 1.0, "strafer": 1.0, "critter": 1.0, "axeman": 1.0})
    pool.act(sim, 1)
    assert count["n"] == 1


@pytest.mark.parametrize("name", sorted(set(SCRIPTED) - {"synth"}))
def test_scripted_opponents_act_only_for_their_arenas(name):
    sim = Sim(12, SimConfig(), seed=4)
    rows = np.array([2, 7, 9])
    out = SCRIPTED[name](sim, 1, np.random.default_rng(0), read_facts(sim, 1), rows)
    assert out.shape == (3, len(A.NVEC))
    assert (out >= 0).all() and (out < A.NVEC).all()


def _melee_run(fast):
    kit = Kit(arrows=0)
    sim = Sim(16, SimConfig(kits=(kit,)), seed=8)
    assert sim.melee_only
    sim.melee_only = fast
    rng = np.random.default_rng(8)
    digest = []
    for _ in range(120):
        action = rng.integers(0, A.NVEC, size=(16, 2, len(A.NVEC)))
        action[..., A.WEAPON] = rng.integers(0, 3, size=(16, 2))
        sim.step(action)
        digest.append(sim.pos.tobytes() + sim.hp.tobytes() + build_obs(sim, 0)[:, :75].tobytes())
    return digest


def test_melee_fast_path_gives_the_same_game():
    assert _melee_run(True) == _melee_run(False)


def test_melee_path_keeps_ranged_slots_at_zero():
    sim = Sim(4, SimConfig(kits=(Kit(arrows=0),)), seed=9)
    assert sim.no_ranged()
    obs = build_obs(sim, 0)
    assert not obs[:, 75:93].any()


def test_melee_path_stops_when_arrows_exist():
    sim = Sim(1, SimConfig(kits=(Kit(arrows=0),)), seed=9)
    sim.ammo[0, 0] = 1
    assert not sim.no_ranged()


def _extra_block(sim, seat, rows):
    at = slice(None) if rows is None else rows
    return np.column_stack([sim.hp[at, seat] / 40.0, sim.ticks[at] / 100.0])


def _item_mask(sim, seat, rows):
    count = sim.n if rows is None else len(rows)
    out = np.ones((count, 3), dtype=bool)
    out[:, 2] = False
    return out


def test_an_extended_interface_adds_inputs_and_heads_after_the_shared_ones():
    seen = []
    interface = Interface(
        inputs=(InputBlock("mob", 2, _extra_block),),
        heads=(A.Head("item", 3, _item_mask),),
        apply=lambda sim, seat, extra, rows: seen.append(extra.copy()),
    )
    assert interface.obs_dim == 132 and interface.mask_size == 60
    assert interface.nvec.tolist() == A.NVEC.tolist() + [3]
    assert interface.input_slice("mob") == slice(130, 132)
    pool = OpponentPool(4, seed=0, interface=interface)
    pool.set_mix({"idle": 1.0})
    env = ArenaVecEnv(4, pool, SimConfig(), seed=0, interface=interface)
    obs = env.reset()
    assert obs.shape == (4, 132)
    assert obs[:, :130].tobytes() == np.clip(build_obs(env.sim, 0, env.max_ticks), -5, 5).tobytes()
    masks = env.action_masks()
    assert masks.shape == (4, 60)
    assert masks[:, 57:59].all() and not masks[:, 59].any()
    action = np.zeros((4, 12), dtype=np.int64)
    action[:, :11] = A.neutral_actions(env.sim.weapon[:, 0].copy())
    action[:, 11] = 1
    env.step_async(action)
    next_obs, _, _, _ = env.step_wait()
    assert next_obs.shape == (4, 132)
    assert seen[0].tolist() == [[1]] * 4


def test_an_extended_policy_runs_in_the_league():
    applied = []
    interface = Interface(
        inputs=(InputBlock("uhc", 2, _extra_block),),
        heads=(A.Head("item", 3),),
        apply=lambda sim, seat, extra, rows: applied.append(seat),
    )
    pool = OpponentPool(6, seed=2, interface=interface)
    pool.add_snapshot(NumpyPolicy.random(seed=1, obs_dim=interface.obs_dim, nvec=interface.nvec))
    pool.set_mix({"league": 1.0})
    env = ArenaVecEnv(6, pool, SimConfig(), seed=2, interface=interface)
    env.reset()
    action = np.zeros((6, 12), dtype=np.int64)
    action[:, :11] = A.neutral_actions(env.sim.weapon[:, 0].copy())
    env.step_async(action)
    env.step_wait()
    assert 1 in applied


def test_extended_policies_save_their_head_sizes(tmp_path):
    nvec = np.append(A.NVEC, 4)
    policy = NumpyPolicy.random(seed=3, obs_dim=134, nvec=nvec)
    path = tmp_path / "policy.npz"
    policy.save(path)
    loaded = NumpyPolicy.load(path)
    assert loaded.nvec.tolist() == nvec.tolist()
    obs = np.zeros((2, 134), dtype=np.float32)
    masks = np.ones((2, int(nvec.sum())), dtype=bool)
    assert loaded.act(obs, masks, np.random.default_rng(0)).shape == (2, 12)


def test_duplicate_extension_names_are_refused():
    with pytest.raises(ValueError):
        A.BASE.extended(A.Head("yaw", 2))
    with pytest.raises(ValueError):
        Interface(inputs=(InputBlock("a", 1, _extra_block), InputBlock("a", 1, _extra_block)))
