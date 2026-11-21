"""Body movement rules, and replays of motion recorded on a 1.21.11 server."""

import json
from pathlib import Path

import numpy as np
import pytest
from world_helpers import FLOOR, flat_raw, make, yi

from fighter import actions as A
from fighter import constants as C
from fighter import movement as M
from fighter.sim import Sim, SimConfig
from fighter.world import blocks as B

RECORDED = json.loads((Path(__file__).parent / "data" / "recorded_motion.json").read_text())
KNOCKBACK_TOLERANCE = 1e-6
SERVER_PATH_TOLERANCE = 1e-5
FLUID_TOLERANCE = 1e-6
FLIGHT_TICKS = 70
FLIGHT_TOLERANCE = 1e-3
Y = FLOOR + 1
REST_VY = -C.GRAVITY * C.VERTICAL_DRAG


def flat_sim(distance=500.0, armor="none", **move):
    sim = Sim(1, SimConfig(armor=armor, arena_half=10000.0, move=M.MoveConfig(**move)))
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, distance]
    sim.yaw[0] = [0.0, 180.0]
    return sim


def world_sim(raw=None, at=(8.5, Y, 4.5), model="vanilla", ground=True):
    sim = Sim(1, SimConfig(armor="none", move=M.MoveConfig(client_model=model)))
    sim.world = make(raw, client_model=model)
    sim.pos[0, 0] = at
    sim.pos[0, 1] = [28.5, Y, 28.5]
    sim.yaw[0] = [0.0, 0.0]
    sim.vel[0, :, 1] = REST_VY
    sim.on_ground[0, 0] = ground
    if not ground:
        sim.vel[0, 0, 1] = 0.0
    return sim


def press(sim, **keys):
    a = A.neutral_actions(sim.weapon.copy())
    for name, value in keys.items():
        a[0, 0, A.HEADS.index(name)] = value
    return a


def run(sim, action, ticks):
    for _ in range(ticks):
        sim._tick(action, first=False)


def speed(sim, action, settle=60):
    run(sim, action, settle)
    before = sim.pos[0, 0].copy()
    sim._tick(action, first=False)
    return float(np.linalg.norm((sim.pos[0, 0] - before)[[0, 2]]) * C.TICKS_PER_SECOND)


def sink_speed(sim, action, settle=40):
    run(sim, action, settle)
    before = sim.pos[0, 0, 1]
    sim._tick(action, first=False)
    return float((sim.pos[0, 0, 1] - before) * C.TICKS_PER_SECOND)


def pool(block, top=Y + 16):
    raw = flat_raw()
    raw[:, :, yi(Y) : yi(top)] = block
    return raw


def hit(sim, sprint=False):
    """Land one fully charged melee hit from seat 0 on seat 1."""
    eye = sim.pos[0, 0] + [0.0, C.EYE_HEIGHT, 0.0]
    d = sim.pos[0, 1] + [0.0, 0.9, 0.0] - eye
    sim.yaw[0, 0] = np.degrees(np.arctan2(-d[0], d[2]))
    sim.pitch[0, 0] = -np.degrees(np.arctan2(d[1], np.hypot(d[0], d[2])))
    sim.sprinting[0, 0] = sprint
    sim.sprint_held[0, 0] = sprint
    mask = np.zeros((1, 2), dtype=bool)
    mask[0, 0] = True
    sim._melee(mask)


@pytest.mark.parametrize("case", RECORDED["melee"], ids=lambda c: f"f{c['final'][2]:.3f}_g{int(c['ground'])}")
def test_recorded_melee_knockback(case):
    sim = flat_sim(server_copy=False)
    sim.pos[0, 0] = case["attacker"]
    sim.pos[0, 1] = case["victim"]
    sim.yaw[0, 0] = case["yaw"]
    sim.vel[0, 1] = case["vel"]
    sim.on_ground[0, 1] = case["ground"]
    sim.combat.knockback_resistance[0, 1] = case["resistance"]
    sim.body.knockback_level[0, 0] = case["level"]
    fresh = np.array([True])
    direction = M.melee_direction(sim.pos)[:, 0]
    M.take_knockback(sim, fresh, 1, direction, np.full(1, C.BASE_KNOCKBACK), np.array([case["sprint"]]))
    assert sim.vel[0, 1] == pytest.approx(case["final"], abs=KNOCKBACK_TOLERANCE)


@pytest.mark.parametrize("case", RECORDED["arrows"])
def test_recorded_arrow_knockback_after_one_server_step(case):
    sim = flat_sim(server_copy=False)
    sim.vel[0, 1] = case["vel"]
    sim.on_ground[0, 1] = case["ground"]
    flight = np.array(case["arrow"])
    direction = (flight / np.linalg.norm(flight))[None]
    M.take_knockback(sim, np.array([True]), 1, direction, np.full(1, C.BASE_KNOCKBACK))
    assert sim.vel[0, 1] == pytest.approx(case["sent"], abs=KNOCKBACK_TOLERANCE)


@pytest.mark.parametrize("case", RECORDED["blocked"])
def test_recorded_blocked_hit_moves_only_the_server_copy(case):
    sim = flat_sim(server_copy=True)
    sim.pos[0, 0] = case["attacker"]
    sim.pos[0, 1] = case["victim"]
    sim.vel[0, 1] = case["vel"]
    sim.on_ground[0, 1] = case["ground"]
    combat = sim.combat
    combat.server_vel[0, 1] = case["vel"]
    combat.server_ground[0, 1] = case["ground"]
    client = sim.vel[0, 1].copy()
    M.blocked_knockback(sim, np.array([True]), 1, M.melee_direction(sim.pos)[:, 0])
    assert combat.server_vel[0, 1] == pytest.approx(case["final"], abs=KNOCKBACK_TOLERANCE)
    assert sim.vel[0, 1] == pytest.approx(client)
    sim.on_ground[0, 1] = True
    still = np.zeros((1, 2), dtype=bool)
    ground_ticks = 0
    for vx, vy, vz, ground in case["path"]:
        was_air = not combat.server_ground[0, 1]
        before = combat.server_vel[0, 1, [0, 2]].copy()
        combat._server_tick(still)
        recorded = np.array([vx, vz])
        # The idle recording client can report ground for one airborne tick, which applies ground drag.
        off_path = np.abs(recorded - combat.server_vel[0, 1, [0, 2]]).max() > SERVER_PATH_TOLERANCE
        if was_air and off_path and np.abs(recorded - before * C.GROUND_DRAG).max() <= SERVER_PATH_TOLERANCE:
            combat.server_vel[0, 1, [0, 2]] = before * C.GROUND_DRAG
            ground_ticks += 1
        assert combat.server_vel[0, 1] == pytest.approx([vx, vy, vz], abs=SERVER_PATH_TOLERANCE)
        assert bool(combat.server_ground[0, 1]) == ground
    assert ground_ticks <= 1


@pytest.mark.parametrize("case", RECORDED["flights"], ids=lambda c: c["name"])
def test_recorded_knockback_flight(case):
    sim = flat_sim(client_model="mineflayer", knockback_delay=0)
    sim.pos[0, 0] = [0.0, 0.0, -500.0]
    sim.pos[0, 1] = [0.0, case["y"], 0.0]
    sim.vel[0, 1] = case["launch"]
    sim.on_ground[0, 1] = case["ground"]
    idle = press(sim)
    peak = case["y"]
    for _ in range(FLIGHT_TICKS):
        sim._tick(idle, first=False)
        peak = max(peak, sim.pos[0, 1, 1])
    travel = float(np.abs(sim.pos[0, 1, 2]))
    assert case["travel"][0] - FLIGHT_TOLERANCE <= travel <= case["travel"][1] + FLIGHT_TOLERANCE
    assert case["peak"][0] - FLIGHT_TOLERANCE <= peak - case["y"] <= case["peak"][1] + FLIGHT_TOLERANCE


@pytest.mark.parametrize("case", RECORDED["moving_victims"])
def test_recorded_knockback_ignores_the_clients_own_speed(case):
    sim = flat_sim()
    sim.pos[0, 0] = case["attacker"]
    sim.pos[0, 1] = case["victim"]
    sim.yaw[0, 0] = case["yaw"]
    sim.vel[0, 1] = case["client"]
    sim.on_ground[0, 1] = case["ground"]
    sim.combat.server_vel[0, 1] = case["server"]
    sim.combat.server_ground[0, 1] = case["ground"]
    direction = M.melee_direction(sim.pos)[:, 0]
    M.take_knockback(sim, np.array([True]), 1, direction, np.full(1, C.BASE_KNOCKBACK), np.array([case["sprint"]]))
    assert sim.vel[0, 1] == pytest.approx(case["final"], abs=KNOCKBACK_TOLERANCE)


@pytest.mark.parametrize("height, damage", [(3.5, 0.0), (4.5, 1.0), (10.5, 7.0), (20.5, 17.0)])
def test_fall_damage_ignores_armor(height, damage):
    sim = Sim(1, SimConfig(armor="iron"))
    sim.world = make(flat_raw(floor=-1))
    sim.pos[0, 0] = [20.5, height, 20.5]
    sim.pos[0, 1] = [5.5, 0.0, 5.5]
    sim.vel[0, 1, 1] = REST_VY
    sim.on_ground[0, 0] = False
    idle = A.neutral_actions(sim.weapon.copy())
    for _ in range(200):
        sim._tick(idle, first=False)
        if sim.on_ground[0, 0]:
            break
    assert sim.pos[0, 0, 1] == pytest.approx(0.0)
    assert C.MAX_HEALTH - sim.hp[0, 0] == pytest.approx(damage)
    assert sim.body.fall[0, 0] == 0.0


def test_recorded_lava_sink():
    sim = world_sim(pool(B.LAVA_SOURCE), at=(8.5, Y + 8, 8.5), ground=False)
    idle = press(sim)
    for value in RECORDED["lava_sink"]:
        sim._tick(idle, first=False)
        assert sim.vel[0, 0, 1] == pytest.approx(value, abs=FLUID_TOLERANCE)


def test_recorded_water_sink():
    sim = world_sim(pool(B.WATER_SOURCE), at=(8.5, Y + 8, 8.5), ground=False)
    idle = press(sim)
    for value in RECORDED["water_sink"]:
        sim._tick(idle, first=False)
        assert sim.vel[0, 0, 1] == pytest.approx(value, abs=FLUID_TOLERANCE)


def test_recorded_water_current():
    vel = np.zeros((1, 2, 3))
    flow = np.zeros((1, 2, 3))
    flow[0, 0, 2] = -1.0
    count = np.array([[1, 0]])
    for value in RECORDED["water_current"][:5]:
        M._flow_push(vel, flow, count, M.WATER_FLOW_PUSH, True)
        vel *= M.WATER_DRAG
        assert vel[0, 0, 2] == pytest.approx(value, abs=FLUID_TOLERANCE)


def test_resting_body_holds_gravity_velocity():
    sim = flat_sim()
    run(sim, press(sim), 3)
    assert sim.vel[0, 0, 1] == pytest.approx(REST_VY)
    assert sim.on_ground[0, 0]
    assert sim.pos[0, 0, 1] == 0.0


@pytest.mark.parametrize("keys, expected", [
    ({"forward": A.KEY_FORWARD}, 4.317),
    ({"forward": A.KEY_FORWARD, "sprint": 1}, 5.612),
    ({"forward": A.KEY_BACK}, 4.317),
    ({"forward": A.KEY_FORWARD, "use": 1}, 0.863),
])
def test_flat_speeds(keys, expected):
    sim = flat_sim()
    assert speed(sim, press(sim, **keys)) == pytest.approx(expected, abs=0.002)


def test_sneak_speed_and_box():
    sim = flat_sim()
    sim.body.sneak[0, 0] = True
    assert speed(sim, press(sim, forward=A.KEY_FORWARD)) == pytest.approx(1.295, abs=0.002)
    low, high = sim.boxes()
    assert high[0, 0, 1] - low[0, 0, 1] == pytest.approx(1.5)
    assert sim.eyes()[0, 0, 1] - sim.pos[0, 0, 1] == pytest.approx(1.27)
    assert high[0, 1, 1] - low[0, 1, 1] == pytest.approx(1.8)


def test_speed_effect_scales_ground_speed():
    sim = flat_sim()
    sim.body.speed_level[0, 0] = 2
    assert speed(sim, press(sim, forward=A.KEY_FORWARD)) == pytest.approx(4.317 * 1.4, abs=0.003)


def test_jump_peak():
    sim = flat_sim()
    sim._tick(press(sim, jump=1), first=False)
    peak = sim.pos[0, 0, 1]
    for _ in range(14):
        sim._tick(press(sim), first=False)
        peak = max(peak, sim.pos[0, 0, 1])
    assert peak == pytest.approx(1.2522, abs=0.0002)


def test_jump_cooldown_counts_while_held():
    sim = flat_sim()
    jump = press(sim, jump=1)
    sim._tick(jump, first=False)
    assert sim.body.jump_cooldown[0, 0] == M.JUMP_COOLDOWN
    sim.pos[0, 0, 1] = 0.0
    sim.vel[0, 0, 1] = REST_VY
    sim.on_ground[0, 0] = True
    sim._tick(jump, first=False)
    assert sim.pos[0, 0, 1] == 0.0
    sim._tick(press(sim), first=False)
    assert sim.body.jump_cooldown[0, 0] == 0
    sim._tick(jump, first=False)
    assert sim.pos[0, 0, 1] > 0.0


@pytest.mark.parametrize("sprint, launch_h, launch_v, travel, peak", [
    (False, 0.4, 0.3608, 1.989, 0.9648),
    (True, 0.7, 0.4, 3.616, 1.1531),
])
def test_knockback_from_rest(sprint, launch_h, launch_v, travel, peak):
    sim = flat_sim(distance=2.0)
    sim.vel[0, :, 1] = REST_VY
    hit(sim, sprint)
    assert sim.vel[0, 1, 2] == pytest.approx(launch_h, abs=1e-3)
    assert sim.vel[0, 1, 1] == pytest.approx(launch_v, abs=1e-3)
    assert sim.on_ground[0, 1]
    top = 0.0
    idle = press(sim)
    for _ in range(50):
        sim._tick(idle, first=False)
        top = max(top, sim.pos[0, 1, 1])
    assert sim.pos[0, 1, 2] - 2.0 == pytest.approx(travel, abs=0.01)
    assert top == pytest.approx(peak, abs=0.001)


def test_jump_on_the_hit_tick_keeps_full_height():
    sim = flat_sim(distance=2.0)
    sim.vel[0, :, 1] = REST_VY
    hit(sim)
    jump = press(sim)
    jump[0, 1, A.JUMP] = 1
    sim._tick(jump, first=False)
    top = sim.pos[0, 1, 1]
    idle = press(sim)
    for _ in range(14):
        sim._tick(idle, first=False)
        top = max(top, sim.pos[0, 1, 1])
    assert top == pytest.approx(1.2522, abs=0.0002)


def test_knockback_halves_the_victims_own_motion():
    sim = flat_sim(distance=2.0, server_copy=False)
    sim.vel[0, 1] = [0.2, REST_VY, -0.2]
    hit(sim)
    assert sim.vel[0, 1, 0] == pytest.approx(0.1, abs=1e-9)
    assert sim.vel[0, 1, 2] == pytest.approx(0.3, abs=1e-3)


def test_server_copy_setting_starts_knockback_from_the_server_velocity():
    sim = flat_sim(distance=2.0, server_copy=True)
    sim.vel[0, 1] = [0.2, REST_VY, -0.2]
    hit(sim)
    assert sim.vel[0, 1, 0] == pytest.approx(0.0, abs=1e-9)
    assert sim.vel[0, 1, 2] == pytest.approx(0.4, abs=1e-3)


def test_blocked_hit_leaves_the_client_still_and_feeds_the_next_knockback():
    sim = flat_sim(distance=2.0, server_copy=True)
    sim.vel[0, :, 1] = REST_VY
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    hit(sim)
    assert sim.events["melee_blocked"][0, 0] == 1
    assert sim.vel[0, 1] == pytest.approx([0.0, REST_VY, 0.0])
    assert sim.combat.server_vel[0, 1, 2] == pytest.approx(0.15, abs=1e-6)
    sim.shield_ticks[0, 1] = 0
    sim.hurt_timer[0, 1] = 0
    sim.attack_ticks[0, 0] = 1000.0
    hit(sim)
    assert sim.vel[0, 1, 2] == pytest.approx(0.15 / 2 + 0.4, abs=1e-6)


def test_airborne_victim_keeps_vertical_speed():
    sim = flat_sim(distance=2.0, server_copy=False)
    sim.pos[0, 1, 1] = 0.5
    sim.vel[0, 1, 1] = 0.25
    sim.on_ground[0, 1] = False
    hit(sim)
    assert sim.vel[0, 1, 1] == pytest.approx(0.25)


def test_netherite_resists_knockback():
    sim = flat_sim(distance=2.0, armor="netherite")
    sim.vel[0, :, 1] = REST_VY
    hit(sim)
    assert sim.vel[0, 1, 2] == pytest.approx(0.24, abs=1e-3)


def test_held_key_keeps_running_but_needs_a_new_press_for_a_sprint_hit():
    sim = flat_sim(distance=2.0)
    held = press(sim, forward=A.KEY_FORWARD, sprint=1)
    run(sim, held, 2)
    assert sim.sprinting[0, 0]
    sim.pos[0, 1] = sim.pos[0, 0] + [0.0, 0.0, 2.0]
    hit(sim, sprint=True)
    assert not sim.sprinting[0, 0]
    before = sim.pos[0, 0, 2]
    run(sim, held, 12)
    assert not sim.sprinting[0, 0]
    assert (sim.pos[0, 0, 2] - before) / 12 > 0.25
    sim._tick(press(sim, forward=A.NEUTRAL_FORWARD, sprint=1), first=False)
    sim._tick(held, first=False)
    assert sim.sprinting[0, 0]


def test_sprint_restart_off_keeps_the_body_at_walk_speed():
    sim = flat_sim(distance=2.0, sprint_restart=False)
    held = press(sim, forward=A.KEY_FORWARD, sprint=1)
    run(sim, held, 2)
    sim.pos[0, 1] = sim.pos[0, 0] + [0.0, 0.0, 2.0]
    hit(sim, sprint=True)
    run(sim, held, 40)
    before = sim.pos[0, 0, 2]
    sim._tick(held, first=False)
    assert (sim.pos[0, 0, 2] - before) * C.TICKS_PER_SECOND == pytest.approx(4.317, abs=0.01)


def test_weak_hit_keeps_sprint():
    sim = flat_sim(distance=2.0)
    held = press(sim, forward=A.KEY_FORWARD, sprint=1)
    run(sim, held, 2)
    sim.pos[0, 1] = sim.pos[0, 0] + [0.0, 0.0, 2.0]
    sim.attack_ticks[0, 0] = 0.0
    eye = sim.pos[0, 0] + [0.0, C.EYE_HEIGHT, 0.0]
    d = sim.pos[0, 1] + [0.0, 0.9, 0.0] - eye
    sim.pitch[0, 0] = -np.degrees(np.arctan2(d[1], np.hypot(d[0], d[2])))
    sim._melee(np.array([[True, False]]))
    assert sim.events["hits"][0, 0] == 1
    assert sim.sprinting[0, 0]


def test_item_use_keeps_a_running_sprint_on_the_vanilla_client():
    sim = flat_sim()
    run(sim, press(sim, forward=A.KEY_FORWARD, sprint=1), 3)
    assert sim.sprinting[0, 0]
    sim._tick(press(sim, forward=A.KEY_FORWARD, sprint=1, use=1), first=False)
    assert sim.sprinting[0, 0]


def test_item_use_blocks_a_new_sprint_on_the_vanilla_client():
    sim = flat_sim()
    sim._tick(press(sim, forward=A.KEY_FORWARD, sprint=1, use=1), first=False)
    assert not sim.sprinting[0, 0]


def test_item_use_ends_sprint_on_the_mineflayer_client():
    sim = Sim(1, SimConfig(armor="none", client_model="mineflayer"))
    sim.pos[0, 0] = [0.0, 0.0, -8.0]
    sim.pos[0, 1] = [8.0, 0.0, 8.0]
    sim.yaw[0] = 0.0
    run(sim, press(sim, forward=A.KEY_FORWARD, sprint=1), 3)
    assert sim.sprinting[0, 0]
    sim._tick(press(sim, forward=A.KEY_FORWARD, sprint=1, use=1), first=False)
    assert not sim.sprinting[0, 0]


def test_sprint_needs_more_than_six_food_with_hunger_on():
    sim = Sim(1, SimConfig(armor="none", hunger=True))
    sim.pos[0, 0] = [0.0, 0.0, -8.0]
    sim.pos[0, 1] = [8.0, 0.0, 8.0]
    sim.yaw[0] = 0.0
    sim.combat.food[0, 0] = 6
    run(sim, press(sim, forward=A.KEY_FORWARD, sprint=1), 3)
    assert not sim.sprinting[0, 0]
    sim.combat.food[0, 0] = 7
    run(sim, press(sim, sprint=0), 1)
    run(sim, press(sim, forward=A.KEY_FORWARD, sprint=1), 3)
    assert sim.sprinting[0, 0]


def test_sneak_slowdown_starts_one_tick_after_the_key():
    held = flat_sim()
    free = flat_sim()
    keys = {"forward": A.KEY_FORWARD}
    run(held, press(held, **keys), 4)
    run(free, press(free, **keys), 4)
    held.body.sneak[0, 0] = True
    held._tick(press(held, **keys), first=False)
    free._tick(press(free, **keys), first=False)
    assert held.vel[0, 0, 2] == pytest.approx(free.vel[0, 0, 2])
    held._tick(press(held, **keys), first=False)
    free._tick(press(free, **keys), first=False)
    assert held.vel[0, 0, 2] < free.vel[0, 0, 2]


def test_the_lift_off_rule_applies_only_to_the_flat_arena():
    flat = Sim(1, SimConfig(armor="none"))
    flat.combat._lift_pending[0, 0] = True
    flat.combat._server_tick(np.zeros((1, 2), dtype=bool))
    assert flat.combat.server_vel[0, 0, 1] == pytest.approx(0.42)
    world = Sim(1, SimConfig(armor="none", arena_half=64.0))
    world.attach_world(make(flat_raw()))
    world.combat._lift_pending[0, 0] = True
    world.combat._server_tick(np.zeros((1, 2), dtype=bool))
    assert world.combat.server_vel[0, 0, 1] != pytest.approx(0.42)
    world.close()


@pytest.mark.parametrize("yaw, keeps", [(-5.0, True), (-20.0, False)])
def test_sprint_survives_only_a_glancing_wall(yaw, keeps):
    sim = Sim(1, SimConfig(armor="none", arena_half=12.0))
    sim.pos[0, 0] = [11.65, 0.0, -10.0]
    sim.pos[0, 1] = [-11.0, 0.0, 11.0]
    sim.yaw[0] = [yaw, 0.0]
    run(sim, press(sim, forward=A.KEY_FORWARD, sprint=1), 8)
    assert bool(sim.sprinting[0, 0]) == keeps


@pytest.mark.parametrize("model, velocity, kept", [
    ("vanilla", [0.0025, 0.0, 0.0025], [0.0025, 0.0025]),
    ("vanilla", [0.002, 0.0, 0.0], [0.0, 0.0]),
    ("mineflayer", [0.002, 0.0, 0.004], [0.0, 0.004]),
])
def test_tiny_velocity_is_cut_by_the_client_rule(model, velocity, kept):
    vel = np.zeros((1, 2, 3))
    vel[0, 0] = velocity
    M._cut_tiny(vel, model == "vanilla")
    assert vel[0, 0, [0, 2]] == pytest.approx(kept)


def test_flat_ceiling_stops_a_jump():
    sim = flat_sim(ceiling=2.5)
    sim._tick(press(sim, jump=1), first=False)
    run(sim, press(sim), 6)
    assert sim.pos[0, 0, 1] <= 2.5 - C.PLAYER_HEIGHT + 1e-9


def test_body_push_scales_by_the_larger_axis():
    sim = flat_sim(distance=0.3)
    run(sim, press(sim), 1)
    expected = 0.3 / np.sqrt(0.3) * 0.05
    assert sim.vel[0, 0, 2] == pytest.approx(-expected, abs=1e-9)
    assert sim.vel[0, 1, 2] == pytest.approx(expected, abs=1e-9)


def test_mineflayer_attacker_keeps_speed_and_knockback_arrives_late():
    sim = flat_sim(distance=2.0, client_model="mineflayer")
    sim.vel[0, :, 1] = REST_VY
    sim.vel[0, 0, 2] = 0.2
    hit(sim, sprint=True)
    assert sim.vel[0, 0, 2] == pytest.approx(0.2)
    assert sim.vel[0, 1, 2] == 0.0
    idle = press(sim)
    sim._tick(idle, first=False)
    assert sim.pos[0, 1, 2] == pytest.approx(2.0)
    sim._tick(idle, first=False)
    assert sim.pos[0, 1, 2] == pytest.approx(2.7, abs=1e-6)


def test_vanilla_attacker_slows_on_a_sprint_hit():
    sim = flat_sim(distance=2.0)
    sim.vel[0, 0, 2] = 0.2
    hit(sim, sprint=True)
    assert sim.vel[0, 0, 2] == pytest.approx(0.12)


def test_block_floor_matches_flat_plane():
    flat = flat_sim()
    blocks = world_sim(at=(8.5, Y, 4.5))
    action = press(flat, forward=A.KEY_FORWARD, sprint=1, jump=1)
    for _ in range(40):
        flat._tick(action, first=False)
        blocks._tick(action, first=False)
        moved = blocks.pos[0, 0] - [8.5, Y, 4.5]
        assert moved == pytest.approx(flat.pos[0, 0], abs=1e-4)


def test_full_block_stops_the_body_at_its_face():
    raw = flat_raw()
    raw[:, 12:, yi(Y)] = B.STONE
    sim = world_sim(raw)
    run(sim, press(sim, forward=A.KEY_FORWARD), 60)
    assert sim.pos[0, 0, 2] == pytest.approx(12.0 - C.PLAYER_WIDTH / 2, abs=1e-6)
    assert sim.pos[0, 0, 1] == pytest.approx(Y)


def test_single_pillar_blocks_the_body():
    raw = flat_raw()
    raw[8, 12, yi(Y) : yi(Y) + 2] = B.STONE
    sim = world_sim(raw)
    run(sim, press(sim, forward=A.KEY_FORWARD), 60)
    assert sim.pos[0, 0, 2] == pytest.approx(12.0 - C.PLAYER_WIDTH / 2, abs=1e-6)


@pytest.mark.parametrize("model, x, z", [("vanilla", 9.7, 10.1), ("mineflayer", 9.9, 9.7)])
def test_collision_axis_order_follows_the_client(model, x, z):
    raw = flat_raw()
    raw[10, 10, yi(Y) : yi(Y) + 2] = B.STONE
    sim = world_sim(raw, at=(9.6, Y, 9.6), model=model)
    sim.vel[0, 0] = [0.3, REST_VY, 0.5]
    sim._tick(press(sim), first=False)
    assert sim.pos[0, 0, 0] == pytest.approx(x, abs=1e-6)
    assert sim.pos[0, 0, 2] == pytest.approx(z, abs=1e-6)


def test_slab_is_climbed_without_a_jump():
    raw = flat_raw()
    raw[:, 12:, yi(Y)] = B.OAK_SLAB
    sim = world_sim(raw)
    run(sim, press(sim, forward=A.KEY_FORWARD), 60)
    assert sim.pos[0, 0, 2] > 12.5
    assert sim.pos[0, 0, 1] == pytest.approx(Y + 0.5, abs=1e-6)


def test_body_walks_off_a_ledge_and_falls():
    raw = flat_raw()
    raw[:, 12:, yi(FLOOR - 3) : yi(FLOOR) + 1] = B.AIR
    sim = world_sim(raw)
    run(sim, press(sim, forward=A.KEY_FORWARD), 60)
    assert sim.pos[0, 0, 1] == pytest.approx(FLOOR - 3)
    assert sim.on_ground[0, 0]


def test_sneaking_body_stays_on_the_ledge():
    raw = flat_raw()
    raw[:, 12:, yi(FLOOR - 3) : yi(FLOOR) + 1] = B.AIR
    sim = world_sim(raw)
    sim.body.sneak[0, 0] = True
    run(sim, press(sim, forward=A.KEY_FORWARD), 200)
    assert sim.pos[0, 0, 1] == pytest.approx(Y)
    assert sim.pos[0, 0, 2] <= 12.0 + C.PLAYER_WIDTH / 2


def test_water_landing_takes_no_fall_damage():
    raw = flat_raw()
    raw[:, :, yi(Y) : yi(Y + 2)] = B.WATER_SOURCE
    sim = world_sim(raw, at=(8.5, Y + 15, 8.5), ground=False)
    run(sim, press(sim), 80)
    assert sim.hp[0, 0] == C.MAX_HEALTH


@pytest.mark.parametrize("keys, expected", [({"forward": A.KEY_FORWARD}, 1.96), ({"forward": A.KEY_FORWARD, "sprint": 1}, 3.92)])
def test_water_speeds(keys, expected):
    sim = world_sim(pool(B.WATER_SOURCE))
    assert speed(sim, press(sim, **keys)) == pytest.approx(expected, abs=0.01)


def test_mineflayer_water_sprint_has_no_effect():
    sim = world_sim(pool(B.WATER_SOURCE), model="mineflayer")
    assert speed(sim, press(sim, forward=A.KEY_FORWARD, sprint=1)) == pytest.approx(1.96, abs=0.01)


def test_water_sink_and_swim_up():
    sim = world_sim(pool(B.WATER_SOURCE), at=(8.5, Y + 12, 8.5), ground=False)
    assert sink_speed(sim, press(sim)) == pytest.approx(-0.5, abs=0.01)
    sim = world_sim(pool(B.WATER_SOURCE), at=(8.5, Y + 1, 8.5), ground=False)
    assert sink_speed(sim, press(sim, jump=1), settle=30) == pytest.approx(3.5, abs=0.02)


def test_lava_speeds():
    sim = world_sim(pool(B.LAVA_SOURCE))
    assert speed(sim, press(sim, forward=A.KEY_FORWARD)) == pytest.approx(0.784, abs=0.01)
    sim = world_sim(pool(B.LAVA_SOURCE), at=(8.5, Y + 12, 8.5), ground=False)
    assert sink_speed(sim, press(sim)) == pytest.approx(-0.8, abs=0.01)


def test_lava_halves_fall_distance():
    sim = world_sim(pool(B.LAVA_SOURCE), at=(8.5, Y + 8, 8.5), ground=False)
    sim.body.fall[0, 0] = 8.0
    sim._tick(press(sim), first=False)
    assert sim.body.fall[0, 0] == pytest.approx(4.0, abs=1e-9)


def test_cobweb_slows_walk_and_fall():
    raw = pool(B.COBWEB, top=Y + 6)
    sim = world_sim(raw)
    assert speed(sim, press(sim, forward=A.KEY_FORWARD), settle=10) == pytest.approx(0.49, abs=0.002)
    sim = world_sim(raw, at=(8.5, Y + 3, 8.5), ground=False)
    sim.body.fall[0, 0] = 5.0
    assert sink_speed(sim, press(sim), settle=5) == pytest.approx(-0.0784, abs=0.001)
    assert sim.body.fall[0, 0] == 0.0


def test_water_current_pushes_a_body_downstream():
    raw = flat_raw()
    sim = world_sim(raw, at=(16.5, Y, 19.5))
    sim.world.set(16, Y, 16, B.WATER_SOURCE)
    sim.world.tick(60)
    run(sim, press(sim), 6)
    assert sim.pos[0, 0, 2] > 19.5


def test_hop_out_of_water_at_a_wall():
    raw = flat_raw()
    raw[:, :, yi(Y)] = B.WATER_SOURCE
    raw[:, 12:, yi(Y)] = B.STONE
    sim = world_sim(raw, at=(8.5, Y + 0.3, 11.69), ground=False)
    sim._tick(press(sim, forward=A.KEY_FORWARD), first=False)
    assert sim.vel[0, 0, 1] == pytest.approx(M.HOP_VELOCITY)
