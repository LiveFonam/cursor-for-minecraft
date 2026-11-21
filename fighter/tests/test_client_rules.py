"""Rules measured on the real game client, each in its smallest setup."""

import numpy as np
import pytest
from world_helpers import FLOOR, flat_raw, make, yi

from fighter import actions as A
from fighter import constants as C
from fighter import items as I
from fighter.sim import Sim, SimConfig
from fighter.world import blocks as B

Y = FLOOR + 1
DOWN = (0.0, -1.0, 0.0)


def duel(distance=2.0):
    sim = Sim(1, SimConfig(armor="none", arena_half=50.0, start_arrows=0), seed=0)
    sim.pos[0, 0] = (0.0, 0.0, 0.0)
    sim.pos[0, 1] = (0.0, 0.0, distance)
    sim.yaw[0] = (0.0, 180.0)
    sim.pitch[0] = 0.0
    return sim


def swing(sim):
    attack = np.array([[True, False]])
    sim.combat.melee(attack)


@pytest.mark.parametrize("server_flag,sprint_hits", [(True, 1), (False, 0)])
def test_charged_hit_slows_a_running_client(server_flag, sprint_hits):
    sim = duel()
    sim.sprint_held[0, 0] = True
    sim.sprinting[0, 0] = server_flag
    sim.vel[0, 0] = (0.0, -0.0784, 0.25)
    swing(sim)
    assert sim.vel[0, 0, 2] == pytest.approx(0.25 * C.ATTACKER_SLOWDOWN)
    assert sim.events["sprint_hits"][0, 0] == sprint_hits
    assert not sim.sprinting[0, 0]
    assert sim.sprint_held[0, 0]


def test_weak_hit_keeps_the_speed_of_a_running_client():
    sim = duel()
    sim.sprint_held[0, 0] = True
    sim.attack_ticks[0, 0] = 2.0
    sim.vel[0, 0] = (0.0, -0.0784, 0.25)
    swing(sim)
    assert sim.events["hits"][0, 0] == 1
    assert sim.vel[0, 0, 2] == pytest.approx(0.25)


def test_charged_hit_keeps_the_speed_of_a_walking_client():
    sim = duel()
    sim.vel[0, 0] = (0.0, -0.0784, 0.1)
    swing(sim)
    assert sim.vel[0, 0, 2] == pytest.approx(0.1)


def crossbow_sim():
    sim = duel(distance=30.0)
    sim.ammo[0, 0] = 6
    sim.melee_only = False
    sim.weapon[0, 0] = C.CROSSBOW
    sim.loaded[0, 0] = True
    held = A.neutral_actions(sim.weapon.copy())
    held[0, 0, A.USE] = 1
    return sim, held


def test_held_key_reloads_a_crossbow_after_the_delay():
    sim, held = crossbow_sim()
    sim._tick(held, first=True)
    assert sim.events["arrows_fired"][0, 0] == 1
    for _ in range(C.CROSSBOW_RELOAD_DELAY - 1):
        sim._tick(held, first=True)
        assert sim.load_ticks[0, 0] == 0
    sim._tick(held, first=True)
    assert sim.load_ticks[0, 0] == 1


def test_early_press_does_not_shorten_the_reload_delay():
    sim, held = crossbow_sim()
    sim._tick(held, first=True)
    free = A.neutral_actions(sim.weapon.copy())
    sim._tick(free, first=True)
    for _ in range(2):
        sim._tick(held, first=True)
        assert sim.load_ticks[0, 0] == 0
    sim._tick(held, first=True)
    assert sim.load_ticks[0, 0] == 1


def test_break_delay_runs_only_while_digging():
    world = make()
    world.poke(16, Y, 16, B.DIRT)
    world.poke(16, Y - 1, 16, B.DIRT)
    eye = (16.5, Y + 2.5, 16.5)
    while world.dig(eye, DOWN)[0] != 1:
        pass
    world.dig_stop()
    world.tick(100)
    for _ in range(5):
        assert world.dig(eye, DOWN)[0] == -1
    assert world.dig(eye, DOWN)[0] == 0


def test_block_that_breaks_at_once_ignores_the_delay():
    world = make()
    world.poke(16, Y, 16, B.DIRT)
    eye = (16.5, Y + 2.5, 16.5)
    while world.dig(eye, DOWN)[0] != 1:
        pass
    world.poke(16, Y, 16, B.TORCH)
    assert world.dig(eye, DOWN)[0] == 1


def channel(level):
    raw = flat_raw(32)
    raw[16, 16, yi(Y)] = B.fluid(B.WATER, level)
    raw[16, 17, yi(Y)] = B.fluid(B.WATER, level - 1)
    return make(raw)


@pytest.mark.parametrize("level", [2, 3, 6])
def test_shallow_current_scales_with_depth(level):
    world = channel(level)
    pos = np.array([[[16.5, float(Y), 16.5]]])
    size = np.array([[0.2]])
    info = world.fluid_box_many(pos, size, np.array([[1.8]]), np.array([[1.62]]))
    depth = info["depth"][0, 0, 0]
    direction = world.flow(16, Y, 16)
    scale = depth if depth < 0.4 else 1.0
    assert info["flow"][0, 0, :3] == pytest.approx(direction * scale, abs=1e-9)


def pool_sim(pitch):
    raw = flat_raw(32)
    raw[:, :, yi(Y) : yi(Y) + 4] = B.WATER_SOURCE
    world = make(raw, n=1)
    sim = Sim(1, SimConfig(armor="none", arena_half=16.0, start_arrows=0), seed=0)
    sim.attach_world(world)
    sim._rotation_ticks = 1
    sim.pos[0, 0] = (16.5, Y + 0.5, 8.5)
    sim.pos[0, 1] = (4.5, Y + 0.5, 4.5)
    sim.vel[0] = 0.0
    sim.on_ground[0] = False
    sim.yaw[0] = 0.0
    sim.pitch[0] = (pitch, 0.0)
    sim.sprint_held[0, 0] = True
    sim.sprinting[0, 0] = True
    sim.body.eye_was_wet[0, 0] = True
    keys = A.neutral_actions(sim.weapon.copy())
    keys[0, 0, A.FORWARD] = A.KEY_FORWARD
    keys[0, 0, A.SPRINT] = 1
    return sim, keys


def test_swimmer_is_pulled_toward_a_downward_look():
    sim, keys = pool_sim(30.0)
    sim._tick(keys, first=True)
    assert sim.body.swimming[0, 0]
    look_y = -np.sin(np.radians(30.0))
    assert sim.vel[0, 0, 1] == pytest.approx((0.0 + (look_y - 0.0) * 0.085) * 0.8)


def test_swimmer_keeps_sprinting_against_a_wall():
    sim, keys = pool_sim(0.0)
    sim.world.set(16, Y, 9, B.STONE)
    sim.world.set(16, Y + 1, 9, B.STONE)
    for _ in range(6):
        sim._tick(keys, first=True)
    assert sim.body.swimming[0, 0]
    assert sim.sprint_held[0, 0]


def test_water_sprint_waits_one_tick_for_the_eye():
    sim, keys = pool_sim(0.0)
    sim.sprint_held[0] = False
    sim.sprinting[0] = False
    sim.body.eye_was_wet[0, 0] = False
    sim._tick(keys, first=True)
    assert not sim.sprint_held[0, 0]
    sim._tick(keys, first=True)
    assert sim.sprint_held[0, 0]


@pytest.mark.parametrize(
    "code,pos,vel,gravity,drag",
    [
        (I.PEARL, "pearl_pos", "pearl_vel", I.PEARL_GRAVITY, I.PEARL_DRAG),
        (I.FIRST_SPLASH, "splash_pos", "splash_vel", I.SPLASH_GRAVITY, I.SPLASH_DRAG),
    ],
)
def test_thrown_item_flight_order(code, pos, vel, gravity, drag):
    sim = duel(distance=30.0)
    sim.pitch[0, 0] = -30.0
    sim.items.count[0, 0, code] = 1
    sim.items.input[0, 0] = code
    idle = A.neutral_actions(sim.weapon.copy())
    sim._tick(idle, first=True)
    sim.items.input[0, 0] = I.NO_ITEM
    start = getattr(sim.items, pos)[0, 0].copy()
    launch = getattr(sim.items, vel)[0, 0].copy()
    assert start == pytest.approx(np.array([0.0, C.EYE_HEIGHT - I.THROW_DROP, 0.0]))
    sim._tick(idle, first=True)
    step = launch - np.array([0.0, gravity, 0.0])
    step *= drag
    assert getattr(sim.items, vel)[0, 0] == pytest.approx(step)
    assert getattr(sim.items, pos)[0, 0] == pytest.approx(start + step)
