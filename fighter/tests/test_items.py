"""Thrown items, potions and items that act on blocks."""

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter import items as I
from fighter.items import Kit
from fighter.sim import Sim, SimConfig
from fighter.world import blocks as B
from world_helpers import flat_raw, make, yi

STOCK = (
    (I.PEARL, 2),
    (I.ROD, 1),
    (I.WATER_BUCKET, 1),
    (I.LAVA_BUCKET, 1),
    (I.COBWEB, 2),
    (I.BLOCK, 2),
    (I.SPLASH["healing"], 1),
    (I.SPLASH["regeneration"], 1),
    (I.DRINK["strength"], 1),
    (I.DRINK["healing_strong"], 1),
)


def sim_with(world=False, distance=2.0):
    sim = Sim(1, SimConfig(kits=(Kit(stock=STOCK),), arena_half=32.0, armor="none"))
    if world:
        sim.world = make(flat_raw(floor=-1))
    sim.pos[0, 0] = [16.5, 0.0, 16.5]
    sim.pos[0, 1] = [16.5, 0.0, 16.5 + distance]
    sim.yaw[0] = [0.0, 180.0]
    sim.pitch[0] = 0.0
    return sim


def idle(sim):
    return A.neutral_actions(sim.weapon.copy())


def tick(sim, ticks=1):
    for _ in range(ticks):
        sim._tick(idle(sim), first=True)


def press(sim, code, seat=0):
    sim.items.input[0, seat] = code
    tick(sim)
    sim.items.input[0, seat] = I.NO_ITEM


def test_item_input_defaults_to_off():
    sim = sim_with()
    tick(sim, 5)
    assert (sim.items.count[0, 0] == sim.items.count[0, 1]).all()
    assert sim.items.count[0, 0, I.PEARL] == 2


def test_pearl_flies_lands_teleports_and_hurts():
    sim = sim_with(distance=20.0)
    sim.pitch[0, 0] = -10.0
    press(sim, I.PEARL)
    assert sim.items.count[0, 0, I.PEARL] == 1
    assert sim.items.pearl_vel[0, 0] == pytest.approx(
        I._look(0.0, -10.0) * I.PEARL_SPEED * I.PEARL_DRAG - np.array([0.0, I.PEARL_GRAVITY, 0.0])
    )
    for _ in range(60):
        tick(sim)
        if not sim.items.pearl_on[0, 0]:
            break
    assert not sim.items.pearl_on[0, 0]
    assert sim.pos[0, 0, 2] > 20.0
    assert sim.hp[0, 0] == pytest.approx(C.MAX_HEALTH - I.PEARL_DAMAGE)


def test_pearl_cooldown_blocks_a_second_throw():
    sim = sim_with(distance=20.0)
    sim.pitch[0, 0] = -60.0
    press(sim, I.PEARL)
    press(sim, I.PEARL)
    assert sim.items.count[0, 0, I.PEARL] == 1


def test_splash_heals_with_distance_falloff():
    sim = sim_with(distance=1.0)
    sim.hp[0] = [10.0, 10.0]
    sim.pitch[0, 0] = 60.0
    press(sim, I.SPLASH["healing"])
    tick(sim, 12)
    assert not sim.items.splash_on[0, 0]
    assert 10.0 < sim.hp[0, 0] <= 14.0


def test_splash_effect_scales_duration():
    sim = sim_with(distance=1.0)
    sim.pitch[0, 0] = 60.0
    press(sim, I.SPLASH["regeneration"])
    tick(sim, 12)
    assert 0 < sim.combat.effect_time[0, 0, I.REGENERATION] < 900


def test_drinking_takes_32_ticks():
    sim = sim_with()
    sim.hp[0, 0] = 5.0
    sim.items.input[0, 0] = I.DRINK["healing_strong"]
    tick(sim, I.USE_DURATION - 1)
    assert sim.hp[0, 0] == 5.0
    tick(sim)
    assert sim.hp[0, 0] == pytest.approx(13.0)


def test_rod_hooks_and_pulls_the_other_player():
    sim = sim_with(distance=4.0)
    sim.pitch[0, 0] = -2.0
    press(sim, I.ROD)
    for _ in range(12):
        tick(sim)
        if sim.items.hook_state[0, 0] == I.HOOK_ON_PLAYER:
            break
    assert sim.items.hook_state[0, 0] == I.HOOK_ON_PLAYER
    press(sim, I.ROD)
    assert not sim.items.hook_on[0, 0]
    assert sim.vel[0, 1, 2] < 0.0
    assert sim.items.rod_left[0, 0] == I.ROD_DURABILITY - I.ROD_COST_PULL


def test_rod_in_the_ground_costs_two():
    sim = sim_with(distance=20.0)
    sim.pitch[0, 0] = 45.0
    press(sim, I.ROD)
    tick(sim, 8)
    assert sim.items.hook_state[0, 0] == I.HOOK_STUCK
    press(sim, I.ROD)
    assert sim.items.rod_left[0, 0] == I.ROD_DURABILITY - I.ROD_COST_GROUND


@pytest.mark.parametrize("code", [I.WATER_BUCKET, I.LAVA_BUCKET, I.COBWEB, I.BLOCK])
def test_block_items_do_nothing_without_a_world(code):
    sim = sim_with()
    sim.pitch[0, 0] = 80.0
    before = int(sim.items.count[0, 0, code])
    press(sim, code)
    assert sim.items.count[0, 0, code] == before


def test_water_bucket_pours_and_scoops_back():
    sim = sim_with(world=True, distance=6.0)
    sim.pitch[0, 0] = 60.0
    press(sim, I.WATER_BUCKET)
    assert sim.items.count[0, 0, I.WATER_BUCKET] == 0
    assert sim.items.count[0, 0, I.EMPTY_BUCKET] == 1
    sim.world.tick(8)
    press(sim, I.EMPTY_BUCKET)
    assert sim.items.count[0, 0, I.WATER_BUCKET] == 1


def test_lava_bucket_pours_through_the_world():
    sim = sim_with(world=True, distance=6.0)
    sim.pitch[0, 0] = 60.0
    press(sim, I.LAVA_BUCKET)
    assert sim.items.count[0, 0, I.LAVA_BUCKET] == 0


def test_placing_a_block_uses_the_world_and_spends_one():
    sim = sim_with(world=True, distance=6.0)
    sim.pitch[0, 0] = 60.0
    press(sim, I.BLOCK)
    assert sim.items.count[0, 0, I.BLOCK] == 1
    cells = sim.world.dump(0)
    assert (cells[:, :, yi(0)] == B.COBBLESTONE).sum() == 1


def test_a_second_press_places_a_second_block():
    sim = sim_with(world=True, distance=6.0)
    sim.pitch[0, 0] = 60.0
    press(sim, I.BLOCK)
    sim.world.tick(8)
    tick(sim)
    sim.pitch[0, 0] = 40.0
    press(sim, I.BLOCK)
    assert sim.items.count[0, 0, I.BLOCK] == 0


def test_cobweb_placement_and_sword_cut():
    sim = sim_with(world=True, distance=6.0)
    sim.pitch[0, 0] = 60.0
    press(sim, I.COBWEB)
    assert sim.items.count[0, 0, I.COBWEB] == 1
    assert (sim.world.dump(0)[:, :, yi(0)] == B.COBWEB).sum() == 1
    sim.items.dig_input[0, 0] = True
    tick(sim, 12)
    assert (sim.world.dump(0)[:, :, yi(0)] == B.COBWEB).sum() == 0


def test_cobweb_contact_clears_fall_distance_and_stops_crits():
    raw = flat_raw(floor=-1)
    raw[16, 16, yi(0)] = B.COBWEB
    sim = sim_with()
    sim.world = make(raw)
    sim.combat.fall_distance[0, 0] = 2.0
    tick(sim)
    assert sim.combat.fall_distance[0, 0] == 0.0
    assert sim.combat.no_crit[0, 0]


def test_blocks_stop_melee():
    raw = flat_raw(floor=-1)
    raw[16, 17, yi(1)] = B.STONE
    sim = sim_with()
    sim.world = make(raw)
    sim.attack_ticks[0, 0] = 1000.0
    sim._melee(np.array([[True, False]]))
    assert sim.events["hits"][0, 0] == 0
