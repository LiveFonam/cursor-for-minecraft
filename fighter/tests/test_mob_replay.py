"""Mob stats and walking speeds against values recorded from a real server."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter import mobs as mob_rules
from fighter.mobs import (
    ARMOR,
    BLAST_RADIUS,
    CREEPER,
    ENDERMAN,
    EYE,
    FOLLOW,
    HEALTH,
    HEIGHT,
    KIND_NAMES,
    MELEE,
    SKELETON,
    SPEED,
    STEP,
    WIDTH,
    ZOMBIE,
    MobSim,
    difficulty_scale,
)
from fighter.obs import view_angles
from fighter.sim import SimConfig

RECORDED = json.loads((Path(__file__).parent / "data" / "recorded_mobs.json").read_text())
SPEEDS = RECORDED["blocks_per_tick"]


def field(kind: int, name: str) -> float:
    return RECORDED["stats"][KIND_NAMES[kind]][name]


@pytest.mark.parametrize("kind", [ZOMBIE, SKELETON, CREEPER, ENDERMAN])
def test_stats_match_the_recording(kind):
    assert WIDTH[kind] == pytest.approx(field(kind, "w"))
    assert HEIGHT[kind] == pytest.approx(field(kind, "h"))
    assert EYE[kind] == pytest.approx(field(kind, "eye"))
    assert HEALTH[kind] == pytest.approx(field(kind, "max_health"))
    assert ARMOR[kind] == pytest.approx(field(kind, "armor"))
    assert SPEED[kind] == pytest.approx(field(kind, "movement_speed"))
    assert FOLLOW[kind] == pytest.approx(field(kind, "follow_range"))
    assert STEP[kind] == pytest.approx(field(kind, "step_height"))
    if kind != CREEPER:
        assert MELEE[kind] == pytest.approx(field(kind, "attack_damage"))


def steady_step(sim, ticks=60, keep=20) -> float:
    idle = A.neutral_actions(np.full(1, C.SWORD))
    joined = np.stack([idle, idle], axis=1)
    steps = []
    for tick in range(ticks):
        sim.pos[:, 0] = (0.0, 0.0, 0.0)
        sim.vel[:, 0] = 0.0
        sim.hp[:, 0] = C.MAX_HEALTH
        before = sim.mobs.pos[0, 0].copy()
        sim.step(joined)
        if tick >= ticks - keep:
            gap = sim.mobs.pos[0, 0] - before
            steps.append(float(np.hypot(gap[0], gap[2])))
    return float(np.median(steps))


def fight(kind: int, distance: float) -> MobSim:
    config = SimConfig(armor="none", arena_half=40.0, decisions_per_second=20)
    sim = MobSim(1, config, seed=0)
    sim.pos[:, 0] = 0.0
    sim.vel[:, 0] = 0.0
    sim.yaw[:, 0] = 180.0
    sim.mobs.spawn(0, 0, kind, 0.0, 0.0, distance)
    sim.mobs.targeting[:, 0] = True
    sim.mobs.goal_on[:, 0] = kind != SKELETON
    sim.mobs.provoked[:, 0] = kind == ENDERMAN
    sim.show_focus()
    return sim


@pytest.mark.parametrize(("kind", "key"), [(ZOMBIE, "walk_zombie"), (CREEPER, "walk_creeper")])
def test_chasing_mob_runs_at_the_recorded_speed(kind, key):
    assert steady_step(fight(kind, 14.0), ticks=40) == pytest.approx(SPEEDS[key], rel=0.002)


def test_angry_enderman_runs_at_the_recorded_speed():
    assert steady_step(fight(ENDERMAN, 15.5), ticks=24, keep=6) == pytest.approx(
        SPEEDS["chase_enderman"], rel=0.005
    )


def test_strafing_skeleton_moves_at_the_recorded_speed():
    sim = fight(SKELETON, 9.0)
    sim.mobs.see_time[:, 0] = 30
    assert steady_step(sim, ticks=18, keep=6) == pytest.approx(SPEEDS["strafe_skeleton"], rel=0.01)


@pytest.mark.parametrize("kind", [SKELETON, ENDERMAN])
def test_walking_speed_formula_matches_the_recording(kind):
    key = f"walk_{KIND_NAMES[kind]}"
    assert SPEED[kind] ** 2 / (1.0 - C.GROUND_DRAG) == pytest.approx(SPEEDS[key], rel=0.001)


@pytest.mark.parametrize(("kind", "range_key"), [(ZOMBIE, "zombie"), (SKELETON, "skeleton"), (CREEPER, "creeper")])
def test_target_range_matches_the_recording(kind, range_key):
    seen, unseen = RECORDED["target_range"][range_key]
    for distance, wanted in ((seen, True), (unseen, False)):
        sim = MobSim(1, SimConfig(armor="none", arena_half=60.0, decisions_per_second=20), seed=1)
        sim.pos[:, 0] = (0.0, 0.0, 0.0)
        sim.mobs.spawn(0, 0, kind, 0.0, 0.0, float(distance))
        for _ in range(90):
            sim.mobs.pos[0, 0] = (0.0, 0.0, float(distance))
            sim.mobs.vel[0, 0] = 0.0
            sim.mobs.tick()
            if sim.mobs.targeting[0, 0]:
                break
        assert bool(sim.mobs.targeting[0, 0]) is wanted


def test_time_to_target_matches_the_recording():
    n = 1024
    sim = MobSim(n, SimConfig(armor="none", decisions_per_second=20), seed=2)
    sim.pos[:, 0] = (0.0, 0.0, 0.0)
    for env in range(n):
        sim.mobs.spawn(env, 0, ZOMBIE, 0.0, 0.0, 8.0)
    first = np.full(n, -1)
    for tick in range(160):
        sim.mobs.pos[:, 0] = (0.0, 0.0, 8.0)
        sim.mobs.vel[:, 0] = 0.0
        sim.mobs.tick()
        first[(first < 0) & sim.mobs.targeting[:, 0]] = tick
    assert (first >= 0).all()
    assert first.mean() == pytest.approx(RECORDED["target_delay"]["mean"], abs=1.0)


@pytest.mark.parametrize("variant", ["plain", "sprint"])
def test_knockback_path_of_a_mob_matches_the_recording(variant, monkeypatch):
    monkeypatch.setattr(mob_rules, "TARGET_CHANCE", 0.0)
    path = RECORDED["knockback_path"][variant]
    sim = MobSim(1, SimConfig(armor="none", decisions_per_second=20), seed=3)
    sim.pos[:, 0] = (0.0, 0.0, 0.0)
    sim.yaw[:, 0] = 0.0
    sim.pitch[:, 0] = 0.0
    sim.weapon[:, 0] = C.AXE
    sim.attack_ticks[:, 0] = 1000.0
    sim.sprinting[:, 0] = variant == "sprint"
    sim.mobs.spawn(0, 0, SKELETON, 0.0, 0.0, 2.0)
    sim.mobs.vel[0, 0, 1] = -C.GRAVITY * C.VERTICAL_DRAG
    sim.mobs.player_melee(np.array([True]))
    sim.mobs.targeting[0, 0] = False
    for along, up in zip(path["along"], path["up"]):
        before = sim.mobs.pos[0, 0].copy()
        sim.mobs.tick()
        step = sim.mobs.pos[0, 0] - before
        assert step[2] == pytest.approx(along, abs=2e-3)
        assert step[1] == pytest.approx(up, abs=2e-3)


def test_mob_hit_sends_the_recorded_velocity():
    sent = RECORDED["mob_hit_sent"]
    sim = fight(ZOMBIE, 1.0)
    sim.mobs._melee_attacks(np.array([0]), np.array([0]), np.array([True]))
    assert np.hypot(sim.vel[0, 0, 0], sim.vel[0, 0, 2]) == pytest.approx(sent["horizontal"], abs=1e-3)
    assert sim.vel[0, 0, 1] == pytest.approx(sent["vertical"], abs=1e-3)


def test_zombie_reach_matches_the_recording():
    hit, miss = RECORDED["zombie_reach"]
    for distance, lands in ((hit, True), (miss, False)):
        sim = fight(ZOMBIE, distance)
        sim.mobs._melee_attacks(np.array([0]), np.array([0]), np.array([True]))
        assert bool(sim.hp[0, 0] < C.MAX_HEALTH) is lands


def test_first_zombie_hit_waits_for_the_goal_check(monkeypatch):
    monkeypatch.setattr(mob_rules, "TARGET_CHANCE", 0.0)
    low, high = RECORDED["first_hit_window"]
    sim = MobSim(1, SimConfig(armor="none", decisions_per_second=20), seed=4)
    sim.pos[:, 0] = (0.0, 0.0, 0.0)
    sim.mobs.spawn(0, 0, ZOMBIE, 0.0, 0.0, 1.0)
    landed = None
    for tick in range(40):
        if tick == 3:
            sim.mobs.targeting[0, 0] = True
        sim.mobs.pos[0, 0] = (0.0, 0.0, 1.0)
        sim.mobs.vel[0, 0] = 0.0
        sim.mobs.tick()
        if sim.hp[0, 0] < C.MAX_HEALTH:
            landed = tick - 3
            break
    assert landed is not None
    assert low - 1 <= landed <= high


@pytest.mark.parametrize("key", sorted(RECORDED["zombie_armor"]))
def test_zombie_damage_through_armor_matches_the_recording(key):
    armor, difficulty = key.split("_")
    sim = MobSim(
        1,
        SimConfig(armor="none", kits=(armor,) if armor != "none" else None, decisions_per_second=20),
        seed=5,
        mobs=mob_rules.MobConfig(difficulty=difficulty),
    )
    sim.pos[:, 0] = (0.0, 0.0, 0.0)
    sim.yaw[:, 0] = 180.0
    sim.mobs.spawn(0, 0, ZOMBIE, 0.0, 0.0, 1.0)
    sim.mobs.targeting[0, 0] = True
    sim.mobs.goal_on[0, 0] = True
    sim.mobs._melee_attacks(np.array([0]), np.array([0]), np.array([True]))
    assert C.MAX_HEALTH - sim.hp[0, 0] == pytest.approx(RECORDED["zombie_armor"][key], abs=2e-3)


def held_still(sim, ticks, distance=None):
    """Step a fight while the player stands still, and yield the events of each tick."""
    idle = A.neutral_actions(np.full(sim.n, C.SWORD))
    joined = np.stack([idle, idle], axis=1)
    for _ in range(ticks):
        sim.pos[:, 0] = 0.0
        sim.vel[:, 0] = 0.0
        sim.hp[:, 0] = C.MAX_HEALTH
        if distance is not None:
            sim.mobs.pos[:, 0] = (0.0, 0.0, distance)
            sim.mobs.vel[:, 0] = 0.0
        yield sim.step(joined)


@pytest.mark.parametrize(("kind", "key"), [(ZOMBIE, "zombie"), (ENDERMAN, "enderman")])
def test_melee_repeat_interval_matches_the_recording(kind, key):
    sim = fight(kind, 1.0)
    hits = [tick for tick, ev in enumerate(held_still(sim, 130, 1.0)) if ev["damage_taken"][0, 0] > 0.0]
    gaps = set(np.diff(hits).tolist())
    assert len(hits) >= 6
    assert gaps <= set(RECORDED["melee_interval"][key])


@pytest.mark.parametrize("distance", [3.0, 9.0, 15.0])
def test_skeleton_shot_timing_matches_the_recording(distance):
    sim = fight(SKELETON, distance)
    shots = [tick for tick, ev in enumerate(held_still(sim, 200, distance)) if ev["arrows_fired"][0, 1] > 0.0]
    low, high = RECORDED["skeleton_first_shot"]
    assert low <= shots[0] + 1 <= high
    assert set(np.diff(shots).tolist()) == set(RECORDED["skeleton_shot_interval"])


@pytest.mark.parametrize("difficulty", ["easy", "normal", "hard"])
def test_skeleton_arrow_damage_is_scaled_after_rounding(difficulty):
    normal = RECORDED["skeleton_arrow_damage"]["normal"]
    allowed = {float(difficulty_scale(value, difficulty)) for value in normal}
    assert set(RECORDED["skeleton_arrow_damage"][difficulty]) <= allowed
    seen = []
    for seed in range(16):
        config = SimConfig(armor="none", arena_half=40.0, decisions_per_second=20)
        sim = MobSim(1, config, seed=seed, mobs=mob_rules.MobConfig(difficulty=difficulty))
        sim.pos[:, 0] = 0.0
        sim.yaw[:, 0] = 180.0
        sim.mobs.spawn(0, 0, SKELETON, 0.0, 0.0, 4.0)
        sim.mobs.targeting[:, 0] = True
        sim.show_focus()
        seen += [float(ev["damage_taken"][0, 0]) for ev in held_still(sim, 150, 4.0) if ev["damage_taken"][0, 0] > 0]
    assert len(seen) >= 6
    assert set(seen) <= allowed


def test_creeper_swell_and_cancel_distances_match_the_recording():
    swells, stays = RECORDED["creeper_swell"]
    for distance, wanted in ((swells, True), (stays, False)):
        sim = fight(CREEPER, distance)
        list(held_still(sim, 5, distance))
        assert bool(sim.mobs.swell[0, 0] > 0) is wanted
    explodes, cancels = RECORDED["creeper_cancel"]
    for distance, wanted in ((explodes, 1), (cancels, 0)):
        sim = fight(CREEPER, 2.0)
        list(held_still(sim, 3, 2.0))
        list(held_still(sim, 40, distance))
        assert int(sim.mobs.blasts[0]) == wanted


def test_creeper_fuse_length_matches_the_recording():
    sim = fight(CREEPER, 2.0)
    first = None
    for tick, _ in enumerate(held_still(sim, 60, 2.0)):
        if first is None and sim.mobs.swell[0, 0] > 0:
            first = tick
        if sim.mobs.blasts[0]:
            break
    assert tick - first + 1 == RECORDED["creeper_fuse"]


@pytest.mark.parametrize("armor", ["none", "iron", "diamond"])
def test_blast_damage_by_distance_and_armor_matches_the_recording(armor):
    table = dict(RECORDED["blast"][armor])
    table.update({str(distance): 0.0 for distance in RECORDED["blast_missed"]})
    for distance, wanted in table.items():
        config = SimConfig(armor="none", kits=(armor,) if armor != "none" else None, decisions_per_second=20)
        sim = MobSim(1, config, seed=6)
        sim.pos[:, 0] = 0.0
        sim.mobs.spawn(0, 0, CREEPER, 0.0, 0.0, float(distance))
        sim.hp[:, 0] = 100.0
        before = sim.vel[0, 0].copy()
        sim.mobs.explode(0, 0)
        assert 100.0 - sim.hp[0, 0] == pytest.approx(wanted, abs=2e-3)
        if armor == "none" and float(distance) <= BLAST_RADIUS:
            push = sim.vel[0, 0] - before
            assert np.hypot(push[0], push[2]) == pytest.approx(RECORDED["blast_knockback"][distance], abs=2e-3)


def test_blast_difficulty_matches_the_recording():
    for difficulty, wanted in RECORDED["blast_difficulty"].items():
        sim = MobSim(1, SimConfig(armor="none", decisions_per_second=20), seed=7, mobs=mob_rules.MobConfig(difficulty=difficulty))
        sim.pos[:, 0] = 0.0
        sim.mobs.spawn(0, 0, CREEPER, 0.0, 0.0, 2.0)
        sim.hp[:, 0] = 100.0
        sim.mobs.explode(0, 0)
        assert 100.0 - sim.hp[0, 0] == pytest.approx(wanted, abs=2e-3)


@pytest.mark.parametrize("key", sorted(RECORDED["enderman_melee"]))
def test_enderman_damage_through_armor_matches_the_recording(key):
    armor, difficulty = key.split("_")
    config = SimConfig(armor="none", kits=(armor,) if armor != "none" else None, decisions_per_second=20)
    sim = MobSim(1, config, seed=8, mobs=mob_rules.MobConfig(difficulty=difficulty))
    sim.pos[:, 0] = 0.0
    sim.yaw[:, 0] = 180.0
    sim.mobs.spawn(0, 0, ENDERMAN, 0.0, 0.0, 1.0)
    sim.mobs.targeting[0, 0] = True
    sim.mobs.goal_on[0, 0] = True
    sim.mobs._melee_attacks(np.array([0]), np.array([0]), np.array([True]))
    assert C.MAX_HEALTH - sim.hp[0, 0] == pytest.approx(RECORDED["enderman_melee"][key], abs=2e-3)


def test_enderman_stare_range_matches_the_recording():
    provokes, ignores = RECORDED["enderman_stare_range"]
    for distance, wanted in ((provokes, True), (ignores, False)):
        sim = MobSim(1, SimConfig(armor="none", arena_half=80.0, decisions_per_second=20), seed=9)
        sim.pos[:, 0] = 0.0
        sim.mobs.spawn(0, 0, ENDERMAN, 0.0, 0.0, float(distance))
        sim.show_focus()
        eye = np.array([[0.0, EYE[ENDERMAN], float(distance)]]) - sim.eyes()[:, 0]
        yaw, pitch = view_angles(eye)
        for _ in held_still(sim, 30, float(distance)):
            sim.yaw[:, 0] = yaw
            sim.pitch[:, 0] = pitch
        assert bool(sim.mobs.provoked[0, 0]) is wanted


def test_enderman_dodges_arrows_and_ignores_melee_as_recorded():
    record = RECORDED["enderman_arrow"]
    assert record["hurt"] == 0
    assert record["teleported"] >= record["traces"] - 1
    assert RECORDED["enderman_melee_teleports"] == 0
    sim = fight(ENDERMAN, 2.0)
    sim.yaw[:, 0] = 0.0
    sim.weapon[:, 0] = C.AXE
    sim.attack_ticks[:, 0] = 1000.0
    start = sim.mobs.pos[0, 0].copy()
    sim.mobs.player_melee(np.array([True]))
    assert sim.mobs.hp[0, 0] < 40.0
    assert np.hypot(*(sim.mobs.pos[0, 0] - start)[[0, 2]]) < 1.0
