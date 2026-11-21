"""Replays of real server recordings through the simulator.

Recorded values are single precision and stored to six decimals, which sets the
tolerances below.
"""

import json
from pathlib import Path

import numpy as np
import pytest

from fighter import actions as A
from fighter import combat as CB
from fighter import constants as C
from fighter.items import Kit, full_set
from fighter.sim import Sim, SimConfig
from fighter.world import blocks as B
from world_helpers import flat_raw, make, yi

DATA = json.loads((Path(__file__).parent / "data" / "recorded_combat.json").read_text())
DAMAGE_TOLERANCE = 1e-4
VELOCITY_TOLERANCE = 1e-5
FIRE_COUNT_TOLERANCE = 6
SLOTS = {"sword": C.SWORD, "axe": C.AXE, "fist": C.BOW}


def duel(material="diamond", armor="none", weapon="sword"):
    material = material or "diamond"
    kit = Kit(armor=full_set(armor), sword=material, axe=material)
    sim = Sim(1, SimConfig(kits=(kit,)))
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 2.0]
    sim.yaw[0] = [0.0, 180.0]
    sim.weapon[0] = SLOTS[weapon]
    return sim


def swing(sim, weapon=None):
    if weapon is not None:
        sim.weapon[0, 0] = SLOTS[weapon]
    sim.attack_ticks[0, 0] = 1000.0
    mask = np.zeros((1, 2), dtype=bool)
    mask[0, 0] = True
    sim._melee(mask)


def advance(sim, ticks):
    for _ in range(ticks):
        sim._advance_timers()


def lost(sim, seat=1):
    return C.MAX_HEALTH - sim.hp[0, seat]


@pytest.mark.parametrize("case", DATA["hits"], ids=lambda c: c["name"])
def test_hit_damage(case):
    sim = duel(case["material"], case["armor"], case["weapon"])
    period = C.TICKS_PER_SECOND / sim.combat.attack_speed()[0, 0]
    sim.attack_ticks[0, 0] = 1000.0 if case["charge"] >= 1.0 else case["charge"] * period - 0.5
    sim.combat.fall_distance[0, 0] = case["fall"]
    sim.on_ground[0, 0] = case["ground"]
    mask = np.zeros((1, 2), dtype=bool)
    mask[0, 0] = True
    sim._melee(mask)
    assert sim.last_damage[0, 1] == pytest.approx(case["raw"], abs=DAMAGE_TOLERANCE)
    assert lost(sim) == pytest.approx(case["final"], abs=DAMAGE_TOLERANCE)
    assert (sim.events["crits"][0, 0] == 1) == case["crit"]


@pytest.mark.parametrize("case", DATA["windows"], ids=lambda c: f'{c["order"]}_{c["gap"]}')
def test_hurt_window(case):
    first, second = {
        "big_then_small": ("axe", "sword"),
        "small_then_big": ("sword", "axe"),
        "equal": ("sword", "sword"),
    }[case["order"]]
    sim = duel()
    swing(sim, first)
    advance(sim, case["gap"])
    swing(sim, second)
    expected = sum(final for _tick, _raw, final in case["dealt"])
    assert lost(sim) == pytest.approx(expected, abs=DAMAGE_TOLERANCE)


@pytest.mark.parametrize("gap,blocked", sorted({(c["gap"], c["blocked"]) for c in DATA["raise"]}))
def test_shield_raise_delay(gap, blocked):
    sim = duel()
    guard = A.neutral_actions(sim.weapon.copy())
    guard[0, 1, A.USE] = 1
    for _ in range(gap):
        sim._tick(guard, first=True)
    strike = guard.copy()
    strike[0, 0, A.ATTACK] = 1
    sim._tick(strike, first=True)
    assert (sim.events["melee_blocked"][0, 0] == 1) == blocked
    assert (lost(sim) == 0.0) == blocked


@pytest.mark.parametrize("angle,blocked", sorted({(c["angle"], c["blocked"]) for c in DATA["arc"]}))
def test_shield_arc(angle, blocked):
    sim = duel()
    sim.yaw[0, 1] = 180.0 + angle
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    swing(sim)
    assert (lost(sim) == 0.0) == blocked


@pytest.mark.parametrize("key", ["blocked", "unblocked"])
def test_second_hit_after_first(key):
    for case in DATA[key]:
        sim = duel()
        if key == "blocked":
            sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
        swing(sim, "sword")
        before = lost(sim)
        sim.shield_ticks[0, 1] = 0
        advance(sim, case["gap"])
        sim.vel[0, 1] = 0.0
        swing(sim, "axe")
        assert lost(sim) - before == pytest.approx(case["final"], abs=DAMAGE_TOLERANCE)
        assert bool(np.abs(sim.vel[0, 1]).sum() > 0.0) == case["knocked"]


@pytest.mark.parametrize("raw,cost", sorted({(c["raw"], c["cost"]) for c in DATA["shield_wear"]}))
def test_shield_durability(raw, cost):
    sim = duel()
    sim.combat.weapon_damage[0, 0, C.SWORD] = raw
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    before = sim.combat.shield_left[0, 1]
    swing(sim, "sword")
    assert before - sim.combat.shield_left[0, 1] == cost


@pytest.mark.parametrize("weapon,ticks", sorted({(c["weapon"], c["ticks"]) for c in DATA["disable"]}))
def test_shield_disable(weapon, ticks):
    sim = duel()
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    swing(sim, weapon)
    assert sim.shield_disabled[0, 1] == ticks


def test_server_velocity_after_blocked_hit():
    sim = duel()
    sim.pos[0, 0] = [0.5, 0.0, 0.5]
    sim.pos[0, 1] = [0.5, 0.0, 2.5]
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    swing(sim)
    assert sim.vel[0, 1] == pytest.approx(np.zeros(3))
    none = np.zeros((1, 2), dtype=bool)
    for expected in DATA["server_copy"]:
        sim.combat._server_tick(none)
        assert sim.combat.server_vel[0, 1] == pytest.approx(np.array(expected), abs=VELOCITY_TOLERANCE)


def hazard_sim(block=None, fire=None):
    raw = flat_raw(floor=-1)
    if block is not None:
        raw[16, 16, yi(0)] = block
    sim = Sim(1, SimConfig(armor="none", arena_half=32.0))
    sim.world = make(raw)
    sim.pos[0, 0] = [16.5, 0.0, 16.5]
    sim.pos[0, 1] = [4.5, 0.0, 4.5]
    if fire is not None:
        sim.combat.fire[0, 0] = fire
        sim.combat._burning = True
    return sim


def damage_ticks(sim, ticks):
    idle = A.neutral_actions(sim.weapon.copy())
    out, fire = [], []
    for tick in range(ticks):
        before = sim.hp[0, 0]
        sim._tick(idle, first=True)
        if sim.hp[0, 0] < before:
            out.append((tick, float(before - sim.hp[0, 0])))
        fire.append(int(sim.combat.fire[0, 0]))
    return out, fire


def recorded_hits(name):
    return [(t, final) for t, _cause, final in DATA["hazards"][name][0]["damage"]]


def test_lava_contact():
    hits, fire = damage_ticks(hazard_sim(B.LAVA_SOURCE), 34)
    assert hits == recorded_hits("lava_contact")
    assert fire[-1] == DATA["hazards"]["lava_contact"][0]["fire"][33]


def test_fire_block():
    hits, fire = damage_ticks(hazard_sim(B.FIRE), 100)
    assert hits == recorded_hits("fire_block")
    series = DATA["hazards"]["fire_block"]
    assert fire[:20] == series[0]["fire"][:20]
    ends = [run["fire"][99] for run in series]
    assert min(ends) - FIRE_COUNT_TOLERANCE <= fire[99] <= max(ends) + FIRE_COUNT_TOLERANCE


def test_burning_without_a_block():
    sim = Sim(1, SimConfig(armor="none"))
    sim.pos[0, 1] = [8.0, 0.0, 0.0]
    sim.combat.fire[0, 0] = 100
    sim.combat._burning = True
    hits, fire = damage_ticks(sim, 120)
    assert hits == recorded_hits("burning_no_block")
    assert fire == DATA["hazards"]["burning_no_block"][0]["fire"][:120]


def test_water_puts_out_fire():
    sim = hazard_sim(B.WATER_SOURCE, fire=199)
    _hits, fire = damage_ticks(sim, 2)
    assert fire[0] == min(DATA["hazards"]["water_extinguish"][0]["fire"])


@pytest.mark.parametrize("drop,damage", [(c["drop"], c["damage"]) for c in DATA["falls"]])
def test_recorded_fall_damage(drop, damage):
    assert CB.fall_damage(np.array(drop)) == damage
    raw = flat_raw(floor=-1)
    sim = Sim(1, SimConfig(armor="iron", arena_half=32.0))
    sim.world = make(raw)
    sim.pos[0, 0] = [16.5, drop, 16.5]
    sim.pos[0, 1] = [4.5, 0.0, 4.5]
    sim.vel[0, 0] = 0.0
    sim.on_ground[0, 0] = False
    idle = A.neutral_actions(sim.weapon.copy())
    for _ in range(200):
        sim._tick(idle, first=False)
        if sim.on_ground[0, 0]:
            break
    assert sim.on_ground[0, 0]
    assert lost(sim, 0) == pytest.approx(damage)
