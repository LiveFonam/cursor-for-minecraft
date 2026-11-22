"""The mob director in the simulator: the same cases the server plugin passed live."""

from __future__ import annotations

import numpy as np
import pytest
from world_helpers import flat_raw, make, yi

from fighter import actions as A
from fighter import constants as C
from fighter.director import Director, DirectorConfig, SimGrid, analyze
from fighter.mobs import CREEPER, SKELETON, ZOMBIE, MobConfig, MobSim
from fighter.sim import SimConfig
from fighter.world import blocks as B

FLOOR = 64
SIZE = 48
MID = 24
FEET = FLOOR + 1
PLAYER = (MID + 0.5, float(FEET), MID + 0.5)
DOOR = (MID, FEET, MID - 4)


def ground() -> np.ndarray:
    """Stone with three layers of dirt on top, grass level at y 64."""
    raw = flat_raw(SIZE, FLOOR, B.STONE)
    raw[:, :, yi(FLOOR - 2): yi(FLOOR) + 1] = B.DIRT
    return raw


def ring(raw, half, block=B.COBBLESTONE, height=3):
    lo, hi = MID - half, MID + half
    for y in range(FEET, FEET + height):
        raw[lo:hi + 1, lo, yi(y)] = block
        raw[lo:hi + 1, hi, yi(y)] = block
        raw[lo, lo:hi + 1, yi(y)] = block
        raw[hi, lo:hi + 1, yi(y)] = block


def yard(door="closed", walls=(4,), block=B.COBBLESTONE, door_block=B.OAK_DOOR) -> np.ndarray:
    """The demo yard: a 7 by 7 inside, walls 3 high, an oak door in the north wall."""
    raw = ground()
    for half in walls:
        ring(raw, half, block)
    if door != "none":
        x, y, z = DOOR
        is_open = door == "open"
        raw[x, z, yi(y)] = B.door(door_block, 0, is_open)
        raw[x, z, yi(y + 1)] = B.door(door_block, 0, is_open, upper=True)
    return raw


def encounter(raw, mobs, player=PLAYER, seed=0, **config):
    sim = MobSim(1, SimConfig(armor="none", decisions_per_second=20, profile="arena"), seed=seed, mobs=MobConfig(max_mobs=4))
    sim.attach_world(make(raw))
    sim.pos[:, 0] = player
    sim.vel[:, 0] = 0.0
    sim.yaw[:, 0] = 0.0
    for slot, (kind, x, y, z) in enumerate(mobs):
        sim.mobs.spawn(0, slot, kind, x + 0.5, float(y), z + 0.5)
    sim.show_focus()
    return sim, Director(sim, 0, DirectorConfig(**config))


def play(sim, director, ticks, until=None, player=PLAYER):
    """Run the sim with the player standing still; stop early when until() holds."""
    one = A.neutral_actions(np.full(sim.n, C.SWORD))
    idle = np.stack([one, one], axis=1)
    for _ in range(ticks):
        director.update()
        sim.step(idle)
        sim.pos[:, 0, 0] = player[0]
        sim.pos[:, 0, 2] = player[2]
        if until is not None and until():
            return True
    return False


def outside_mobs():
    return [(ZOMBIE, MID, FEET, MID - 14), (ZOMBIE, MID + 6, FEET, MID - 15), (CREEPER, MID - 7, FEET, MID - 13)]


def door_cell(sim):
    x, y, z = DOOR
    return sim.world.block(x, y, z, 0)


# ---- the shelter analysis on its own ----

def test_open_door_is_not_a_shelter():
    sim, _ = encounter(yard("open"), [])
    assert not analyze(SimGrid(sim.world, 0), PLAYER).enclosed


def test_closed_door_is_a_shelter_and_the_door_goes_first():
    sim, _ = encounter(yard("closed"), [])
    shelter = analyze(SimGrid(sim.world, 0), PLAYER)
    assert shelter.enclosed
    assert len(shelter.inside) == 49
    assert shelter.doors == [DOOR]
    first = shelter.breaches[0]
    assert first.kind == "door" and first.block == DOOR and first.stand == (MID, FEET, MID - 5)


def test_obsidian_and_thick_walls_leave_no_breach():
    sim, _ = encounter(yard("none", block=B.OBSIDIAN), [])
    assert analyze(SimGrid(sim.world, 0), PLAYER).breaches == []
    sim, _ = encounter(yard("none", walls=(3, 4, 5)), [], player=PLAYER)
    shelter = analyze(SimGrid(sim.world, 0), PLAYER)
    assert shelter.enclosed and shelter.breaches == []


def test_two_thick_wall_is_still_tried():
    sim, _ = encounter(yard("none", walls=(4, 5)), [])
    shelter = analyze(SimGrid(sim.world, 0), PLAYER)
    assert shelter.breaches and shelter.breaches[0].thickness == 2


# ---- whole encounters ----

def test_open_door_zombies_walk_in_and_attack():
    sim, director = encounter(yard("open"), outside_mobs())
    play(sim, director, 20)
    assert director.tactic == "ASSAULT", director.reason
    assert play(sim, director, 600, until=lambda: sim.hp[0, 0] < 20.0), director.status()


def test_closed_door_creeper_blows_it_open_then_the_zombies_attack():
    sim, director = encounter(yard("closed"), outside_mobs())
    play(sim, director, 20)
    assert director.tactic == "BREACH", director.reason
    assert "door" in director.reason
    assert play(sim, director, 600, until=lambda: director.ignited), director.status()
    # the zombies hold back from the fuse
    for slot in (0, 1):
        assert sim.mobs.steer_hold[0, slot]
        assert np.linalg.norm(sim.mobs.pos[0, slot] - np.add(director.breach.stand, 0.5)) > 4.0
    assert play(sim, director, 100, until=lambda: sim.mobs.blasts[0] > 0)
    assert play(sim, director, 40, until=lambda: director.tactic != "BREACH")
    assert director.last_breach.startswith("opened"), director.status()
    assert B.BLOCKS[door_cell(sim)].shape != B.SH_DOOR
    assert director.tactic == "ASSAULT"
    assert play(sim, director, 600, until=lambda: sim.hp[0, 0] < 20.0), director.status()


def test_creeper_killed_before_it_goes_off_fails_the_breach():
    sim, director = encounter(yard("closed"), [(ZOMBIE, MID, FEET, MID - 14), (CREEPER, MID - 10, FEET, MID - 16)])
    play(sim, director, 20)
    assert director.tactic == "BREACH" and not director.ignited
    sim.mobs.hurt(np.array([0]), np.array([director.creeper]), np.array([100.0]), by_player=True)
    play(sim, director, 10)
    assert director.last_breach == "failed: the creeper was killed before it went off"
    assert director.tactic == "WAIT"
    assert director.cooldown_until > director.ticks
    assert B.BLOCKS[door_cell(sim)].shape == B.SH_DOOR
    assert sim.mobs.blasts[0] == 0


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_blast_at_a_two_thick_wall_is_judged_by_the_blocks_after(seed):
    sim, director = encounter(yard("none", walls=(4, 5)), [(ZOMBIE, MID, FEET, MID - 14), (CREEPER, MID - 3, FEET, MID - 12)], seed=seed)
    play(sim, director, 20)
    assert director.tactic == "BREACH" and "2 thick" in director.reason, director.reason
    assert play(sim, director, 700, until=lambda: director.breach is None and director.check_at is None), director.status()
    still = analyze(SimGrid(sim.world, 0), PLAYER).enclosed
    if director.last_breach.startswith("opened"):
        assert not still or director.tactic == "ASSAULT"
    else:
        assert "left no way in" in director.last_breach
        assert still and director.tactic == "WAIT" and director.cooldown_until > director.ticks


def test_shallow_underground_room_gets_its_roof_blasted():
    raw = ground()
    raw[MID - 1:MID + 2, MID - 1:MID + 2, yi(FLOOR - 2):yi(FLOOR - 1) + 1] = B.AIR   # feet at 62, roof at 64
    room = (MID + 0.5, float(FLOOR - 2), MID + 0.5)
    sim, director = encounter(raw, [(CREEPER, MID - 8, FEET, MID), (ZOMBIE, MID + 6, FEET, MID + 6)], player=room)
    play(sim, director, 20, player=room)
    assert director.tactic == "BREACH" and "roof" in director.reason, director.reason
    assert play(sim, director, 600, until=lambda: sim.mobs.blasts[0] > 0, player=room), director.status()
    play(sim, director, 30, player=room)
    assert director.last_breach.startswith(("opened", "failed")), director.status()
    assert sim.world.block(MID, FLOOR, MID, 0) == B.AIR or director.last_breach.startswith("failed")


def test_no_breach_means_waiting_by_the_door():
    # obsidian walls and an iron door (blast resistance 5 still passes, so the door is iron in obsidian
    # with the breach limit at 4): nothing the creeper can open
    raw = yard("closed", block=B.OBSIDIAN, door_block=B.IRON_DOOR)
    sim, director = encounter(raw, [(ZOMBIE, MID, FEET, MID - 14), (CREEPER, MID - 7, FEET, MID - 13)], max_blast=4.0)
    play(sim, director, 200)
    assert director.tactic == "WAIT", director.reason
    assert "thin and weak enough" in director.reason
    assert sim.mobs.blasts[0] == 0
    assert all(sim.mobs.steer_hold[0, s] for s in (0, 1))


def test_skeleton_shoots_through_the_open_door():
    sim, director = encounter(yard("open"), [(SKELETON, MID, FEET, MID - 12), (ZOMBIE, MID + 6, FEET, MID - 14)])
    hit = play(sim, director, 600, until=lambda: sim.hp[0, 0] < 20.0)
    assert hit, director.status()
    assert not sim.mobs.steer_hold[0, 0]


def test_reinforcements_are_capped_and_stop_ends_them():
    sim, director = encounter(yard("closed"), [], max_reinforcements=2, spawn_gap_ticks=40)
    play(sim, director, 30)
    assert director.reinforcements >= 1
    director.stop("stopped by hand")
    alive = int(sim.mobs.alive[0].sum())
    play(sim, director, 400)
    assert director.tactic == "STOPPED"
    assert director.reinforcements <= 2
    assert int(sim.mobs.alive[0].sum()) <= alive
    assert not sim.mobs.steer_on[0].any() and not sim.mobs.steer_hold[0].any()


def test_the_encounter_ends_when_the_player_dies():
    sim, director = encounter(yard("open"), outside_mobs())
    play(sim, director, 20)
    sim.hp[0, 0] = 0.0
    director.update()
    assert director.tactic == "STOPPED" and director.stopped == "the player died"
    assert not sim.mobs.steer_on[0].any()
