"""Item and mob rules against values recorded from a real server."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from test_mobs import aim_at, duel, hold, world_duel
from world_helpers import FLOOR, flat_raw, make

from fighter import actions as A
from fighter import items as I
from fighter.items import Kit
from fighter.mobs import ENDERMAN, EYE, HEIGHT, SKELETON, ZOMBIE
from fighter.sim import Sim, SimConfig
from fighter.world import blocks as B

RECORDED = json.loads((Path(__file__).parent / "data" / "recorded_items.json").read_text())
Y = FLOOR + 1
DOWN = (0.0, -1.0, 0.0)
TOOLS = {
    "hand": (B.TOOL_NONE, B.TIER_HAND),
    "wooden_pickaxe": (B.TOOL_PICKAXE, B.TIER_WOOD),
    "stone_pickaxe": (B.TOOL_PICKAXE, B.TIER_STONE),
    "iron_pickaxe": (B.TOOL_PICKAXE, B.TIER_IRON),
    "diamond_pickaxe": (B.TOOL_PICKAXE, B.TIER_DIAMOND),
    "netherite_pickaxe": (B.TOOL_PICKAXE, B.TIER_NETHERITE),
    "diamond_axe": (B.TOOL_AXE, B.TIER_DIAMOND),
    "diamond_shovel": (B.TOOL_SHOVEL, B.TIER_DIAMOND),
    "diamond_sword": (B.TOOL_SWORD, B.TIER_DIAMOND),
    "shears": (B.TOOL_SHEARS, B.TIER_HAND),
}
BREAKS = [
    (name, ticks) for name, ticks in sorted(RECORDED["break_ticks"].items()) if name.split("|")[0] in B.BLOCK_ID
]


def open_sim():
    config = SimConfig(kits=(Kit(stock=((I.PEARL, 2), (I.ROD, 1))),), arena_half=200.0, armor="none")
    sim = Sim(1, config)
    sim.pos[0, 1] = (-150.0, 0.0, -150.0)
    sim.yaw[0] = 0.0
    sim.pitch[0] = 0.0
    return sim


@pytest.mark.parametrize("flight", RECORDED["pearl_flights"], ids=lambda f: f"{f['ticks']}t")
def test_pearl_flight_time_and_landing(flight):
    sim = open_sim()
    sim.pos[0, 0] = (flight["pos"][0], 0.0, flight["pos"][2])
    items = sim.items
    items.pearl_on[0, 0] = True
    items.pearl_pos[0, 0] = flight["pos"]
    items.pearl_vel[0, 0] = flight["vel"]
    ticks = 0
    while items.pearl_on[0, 0] and ticks < 200:
        items._fly_pearls()
        ticks += 1
    assert ticks == flight["ticks"]
    assert sim.pos[0, 0] == pytest.approx(flight["to"], abs=1e-3)


@pytest.mark.parametrize("flight", RECORDED["hook_flights"], ids=range(len(RECORDED["hook_flights"])))
def test_hook_flight_path(flight):
    sim = open_sim()
    sim.pos[0, 0] = (flight["pos"][0], 0.0, flight["pos"][2] - I.ROD_START)
    items = sim.items
    items.hook_on[0, 0] = True
    items.hook_state[0, 0] = I.HOOK_FLYING
    items.hook_pos[0, 0] = flight["pos"]
    items.hook_vel[0, 0] = flight["vel"]
    for point in flight["path"]:
        items._fly_hooks()
        assert items.hook_pos[0, 0] == pytest.approx(point, abs=1e-3)


@pytest.mark.parametrize("pitch", [-10.0, -4.0])
def test_hook_launch_speed_and_start(pitch):
    sim = open_sim()
    sim.pos[0, 0] = (0.0, 0.0, 0.0)
    sim.yaw[0, 0] = 0.0
    sim.pitch[0, 0] = pitch
    sim.items._use_rod(0, 0)
    speed = float(np.linalg.norm(sim.items.hook_vel[0, 0]))
    assert speed == pytest.approx(RECORDED["hook_launch_speed_by_pitch"][str(pitch)]["mean"], abs=0.012)
    assert sim.items.hook_pos[0, 0] == pytest.approx(sim.eyes()[0, 0] + np.array([0.0, 0.0, I.ROD_START]))


def test_new_pearl_and_hook_wait_one_tick():
    sim = open_sim()
    sim.pos[0, 0] = (0.0, 0.0, 0.0)
    sim.items.input[0, 0] = I.PEARL
    sim._tick(A.neutral_actions(sim.weapon.copy()), first=True)
    assert sim.items.pearl_pos[0, 0] == pytest.approx(sim.eyes()[0, 0] - np.array([0.0, I.THROW_DROP, 0.0]))
    assert sim.items.pearl_vel[0, 0] == pytest.approx(I._look(0.0, 0.0) * I.PEARL_SPEED)


@pytest.mark.parametrize("index", [0, 1])
def test_rod_pull_after_one_ground_tick(index):
    gap = RECORDED["hook_pull"]["hook_to_owner"][index]
    sim = open_sim()
    sim.pos[0, 0] = (0.0, 0.0, 0.0)
    sim.pos[0, 1] = (0.0, 0.0, gap)
    sim.on_ground[0] = True
    sim.yaw[0] = (0.0, 180.0)
    items = sim.items
    items.hook_on[0, 0] = True
    items.hook_state[0, 0] = I.HOOK_ON_PLAYER
    items.input[0, 0] = I.ROD
    sim._tick(A.neutral_actions(sim.weapon.copy()), first=True)
    expected = RECORDED["hook_pull"]["velocity_after_one_ground_tick"][index]
    assert -sim.vel[0, 1, 2] == pytest.approx(expected, abs=1e-3)


def test_pearl_cooldown_is_inside_the_recorded_bound():
    bound = RECORDED["pearl_cooldown"]
    assert bound["above"] < I.PEARL_COOLDOWN <= bound["at_most"]


@pytest.mark.parametrize("name,ticks", BREAKS, ids=[name for name, _ in BREAKS])
def test_break_ticks(name, ticks):
    parts = name.split("|")
    efficiency = int(parts[2][3:]) if len(parts) > 2 else 0
    tool, tier = TOOLS[parts[1]]
    world = make()
    world.poke(16, Y, 16, B.BLOCK_ID[parts[0]])
    eye = (16.5, Y + 2.5, 16.5)
    for tick in range(1, ticks + 2):
        code, _info = world.dig(eye, DOWN, tool, tier, efficiency=efficiency)
        if code == 1:
            assert tick == ticks
            return
        world.tick(1)
    raise AssertionError("block did not break")


def test_place_reach_stays_inside_what_the_server_accepts():
    limits = RECORDED["place"]
    assert make().place(B.COBBLESTONE, (5.5, Y + 4.4, 5.5), DOWN, 0.0)[0] == 1
    assert make().place(B.COBBLESTONE, (5.5, Y + 4.6, 5.5), DOWN, 0.0)[0] != 1
    assert 4.5 <= limits["accepted_eye_distance"] < limits["refused_eye_distance"]
    assert make().place(B.COBBLESTONE, (5.5, Y + limits["refused_eye_distance"], 5.5), DOWN, 0.0)[0] != 1


def test_stone_in_empty_air_is_illegal():
    world = make(flat_raw(floor=-1))
    assert world.place(B.COBBLESTONE, (5.5, 30.0, 5.5), (0.0, 1.0, 0.0), 0.0)[0] != 1


@pytest.mark.parametrize("distance", [4.0, 8.0, 16.0, 32.0, 48.0, 62.0])
def test_enderman_anger_delay_from_first_look(distance):
    recorded = {d["look_to_target"] for d in RECORDED["stare_delays"] if d["distance"] == distance}
    sim = duel(ENDERMAN, distance=distance, angry=False)
    aim_at(sim, share=float(EYE[ENDERMAN] / HEIGHT[ENDERMAN]))
    assert sim.mobs.looked_at()[0, 0]
    still = A.neutral_actions(sim.weapon[:, 0].copy())
    for tick in range(10):
        sim.step(np.stack([still, still], axis=1))
        if sim.mobs.provoked[0, 0]:
            break
    assert tick in recorded


@pytest.mark.parametrize("distance,looked", [(8.0, False), (16.0, False), (32.0, True), (62.0, True)])
def test_level_look_meets_enderman_eyes_only_when_far(distance, looked):
    sim = duel(ENDERMAN, distance=distance, angry=False)
    assert bool(sim.mobs.looked_at()[0, 0]) is looked


@pytest.mark.parametrize("distance", [3, 5, 7, 9])
def test_skeleton_first_approach(distance):
    recorded = RECORDED["skeleton_closest_first_approach"][str(distance)]
    sim = duel(SKELETON, distance=float(distance))
    still = A.neutral_actions(sim.weapon[:, 0].copy())
    closest = float(distance)
    for _ in range(40):
        hold(sim)
        sim.step(np.stack([still, still], axis=1))
        closest = min(closest, float(np.hypot(*sim.mobs.pos[0, 0, [0, 2]])))
    assert min(recorded) - 0.3 <= closest <= max(recorded) + 0.3


def test_zombie_walks_through_web_at_the_recorded_speed():
    web = RECORDED["web"]
    sim = world_duel(flat_raw(floor=FLOOR), ZOMBIE, player=(8.5, 3.5), mob=(8.5, 13.5))
    for z in range(5, 15):
        for y in (Y, Y + 1):
            sim.world.poke(8, y, z, B.COBWEB)
    still = A.neutral_actions(sim.weapon[:, 0].copy())
    for _ in range(10):
        sim.step(np.stack([still, still], axis=1))
    start = sim.mobs.pos[0, 0, 2]
    for _ in range(40):
        sim.step(np.stack([still, still], axis=1))
    speed = (start - sim.mobs.pos[0, 0, 2]) / 40.0
    assert speed == pytest.approx(web["zombie_walk_blocks_per_tick"], abs=0.001)


def test_mob_falls_through_web_at_the_recorded_speed():
    web = RECORDED["web"]
    sim = world_duel(flat_raw(floor=FLOOR), ZOMBIE, player=(2.5, 2.5), mob=(12.5, 12.5))
    sim.mobs.targeting[:, 0] = False
    sim.mobs.goal_on[:, 0] = False
    sim.mobs.pos[0, 0, 1] = Y + 5.0
    for y in range(Y, Y + 9):
        sim.world.poke(12, y, 12, B.COBWEB)
    still = A.neutral_actions(sim.weapon[:, 0].copy())
    sim.step(np.stack([still, still], axis=1))
    sim.step(np.stack([still, still], axis=1))
    start = sim.mobs.pos[0, 0, 1]
    sim.step(np.stack([still, still], axis=1))
    assert sim.mobs.pos[0, 0, 1] - start == pytest.approx(web["fall_blocks_per_tick"], abs=2e-4)
