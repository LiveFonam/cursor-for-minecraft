"""Rules of the four hostile mobs."""

from __future__ import annotations

import numpy as np
import pytest
from world_helpers import FLOOR, flat_raw, make, yi

from fighter import actions as A
from fighter import constants as C
from fighter.mobs import (
    ARMOR,
    BLAST_RADIUS,
    CREEPER,
    ENDERMAN,
    EYE,
    FOLLOW,
    FUSE_TICKS,
    HEALTH,
    HEIGHT,
    MELEE_REACH,
    SKELETON,
    SPEED,
    WIDTH,
    ZOMBIE,
    MobConfig,
    MobSim,
    blast_damage,
    difficulty_scale,
)
from fighter.sim import Sim, SimConfig
from fighter.world import blocks as B


def duel(kind=ZOMBIE, distance=5.0, armor="none", n=1, seed=0, angry=True, **mob_settings):
    """Return a one tick per decision fight with a player at the origin facing +Z."""
    config = SimConfig(armor=armor, decisions_per_second=20)
    sim = MobSim(n, config, seed=seed, mobs=MobConfig(**mob_settings))
    sim.pos[:, 0] = 0.0
    sim.vel[:, 0] = 0.0
    sim.yaw[:, 0] = 0.0
    sim.pitch[:, 0] = 0.0
    for env in range(n):
        sim.mobs.spawn(env, 0, kind, 0.0, 0.0, distance)
    if angry:
        sim.mobs.targeting[:, 0] = True
        sim.mobs.goal_on[:, 0] = kind != SKELETON
        sim.mobs.provoked[:, 0] = kind == ENDERMAN
    sim.show_focus()
    return sim


def idle(sim, weapon=C.SWORD):
    one = A.neutral_actions(np.full(sim.n, weapon))
    return np.stack([one, one], axis=1)


def run(sim, ticks, weapon=C.SWORD):
    for _ in range(ticks):
        sim.step(idle(sim, weapon))


def hold(sim, x=0.0, z=0.0):
    """Keep the player in place."""
    sim.pos[:, 0, 0] = x
    sim.pos[:, 0, 2] = z
    sim.vel[:, 0] = 0.0


def swing(sim, weapon=C.AXE):
    a = idle(sim, weapon)
    a[:, 0, A.ATTACK] = 1
    return sim.step(a)


def aim_at(sim, slot=0, share=0.4):
    target = sim.mobs.pos[0, slot].copy()
    target[1] += HEIGHT[sim.mobs.kind[0, slot]] * share
    delta = target - sim.eyes()[0, 0]
    sim.yaw[:, 0] = np.degrees(np.arctan2(-delta[0], delta[2]))
    sim.pitch[:, 0] = -np.degrees(np.arctan2(delta[1], np.hypot(delta[0], delta[2])))


def world_duel(raw, kind=ZOMBIE, player=(8.5, 8.5), mob=(8.5, 12.5), **mob_settings):
    config = SimConfig(armor="none", decisions_per_second=20, profile="arena")
    sim = MobSim(1, config, seed=0, mobs=MobConfig(**mob_settings))
    sim.attach_world(make(raw))
    y = float(FLOOR + 1)
    sim.pos[:, 0] = (player[0], y, player[1])
    sim.vel[:, 0] = 0.0
    sim.yaw[:, 0] = 0.0
    sim.pitch[:, 0] = 0.0
    sim.mobs.spawn(0, 0, kind, mob[0], y, mob[1])
    sim.mobs.targeting[:, 0] = True
    sim.mobs.goal_on[:, 0] = kind != SKELETON
    sim.mobs.provoked[:, 0] = kind == ENDERMAN
    sim.show_focus()
    return sim


def test_mob_table_values():
    assert HEALTH.tolist() == [20.0, 20.0, 20.0, 40.0]
    assert ARMOR[ZOMBIE] == 2.0
    assert SPEED.tolist() == [0.23, 0.25, 0.25, 0.30]
    assert WIDTH.tolist() == [0.6, 0.6, 0.6, 0.6]
    assert HEIGHT.tolist() == [1.95, 1.99, 1.7, 2.9]
    assert EYE[ENDERMAN] == 2.55
    assert FOLLOW.tolist() == [35.0, 16.0, 16.0, 64.0]


@pytest.mark.parametrize("kind", [ZOMBIE, CREEPER])
def test_walking_mob_settles_at_speed_squared(kind):
    sim = duel(kind, distance=11.0)
    sim.pos[:, 0] = (0.0, 0.0, -4.0)
    run(sim, 20)
    start = float(sim.mobs.pos[0, 0, 2])
    run(sim, 20)
    moved = start - float(sim.mobs.pos[0, 0, 2])
    speed = SPEED[kind]
    expected = speed * speed / (1.0 - C.GROUND_DRAG) * 20.0
    assert moved == pytest.approx(expected, rel=0.01)


def test_mob_ignores_player_beyond_follow_range():
    sim = MobSim(1, SimConfig(arena_half=30.0, decisions_per_second=20), seed=0)
    sim.pos[:, 0] = (0.0, 0.0, -10.0)
    sim.mobs.spawn(0, 0, CREEPER, 0.0, 0.0, 10.0)
    run(sim, 40)
    assert not sim.mobs.targeting[0, 0]


def test_mob_acquires_a_visible_player():
    sim = duel(ZOMBIE, distance=8.0, angry=False)
    run(sim, 60)
    assert sim.mobs.targeting[0, 0]


def test_zombie_reach_is_the_inflated_box():
    reach = 0.3 + MELEE_REACH + 0.3
    for gap, lands in ((reach - 0.01, True), (reach + 0.01, False)):
        sim = duel(ZOMBIE, distance=gap)
        env, slot = np.array([0]), np.array([0])
        sim.mobs._melee_attacks(env, slot, np.array([True]))
        assert bool(sim.hp[0, 0] < C.MAX_HEALTH) is lands


def test_zombie_attacks_every_twenty_ticks():
    sim = duel(ZOMBIE, distance=1.0)
    times = []
    for tick in range(70):
        hold(sim)
        sim.mobs.pos[0, 0] = (0.0, 0.0, 1.0)
        before = float(sim.hp[0, 0])
        run(sim, 1)
        if sim.hp[0, 0] < before:
            times.append(tick)
    assert len(times) >= 3
    assert set(np.diff(times).tolist()) == {20}


@pytest.mark.parametrize(
    ("difficulty", "kind", "expected"),
    [
        ("easy", ZOMBIE, 2.5),
        ("normal", ZOMBIE, 3.0),
        ("hard", ZOMBIE, 4.5),
        ("easy", ENDERMAN, 4.5),
        ("normal", ENDERMAN, 7.0),
        ("hard", ENDERMAN, 10.5),
    ],
)
def test_melee_damage_by_difficulty(difficulty, kind, expected):
    sim = duel(kind, distance=1.0, difficulty=difficulty)
    sim.yaw[:, 0] = 180.0
    sim.mobs._melee_attacks(np.array([0]), np.array([0]), np.array([True]))
    assert C.MAX_HEALTH - sim.hp[0, 0] == pytest.approx(expected)


def test_player_armor_reduces_mob_melee():
    sim = duel(ZOMBIE, distance=1.0, armor="iron")
    sim.yaw[:, 0] = 180.0
    sim.mobs._melee_attacks(np.array([0]), np.array([0]), np.array([True]))
    effective = max(15.0 / 5.0, 15.0 - 4.0 * 3.0 / 8.0)
    assert C.MAX_HEALTH - sim.hp[0, 0] == pytest.approx(3.0 * (1.0 - effective / 25.0))


def test_mob_hit_knocks_player_away():
    sim = duel(ZOMBIE, distance=1.0)
    sim.yaw[:, 0] = 180.0
    sim.mobs._melee_attacks(np.array([0]), np.array([0]), np.array([True]))
    assert sim.vel[0, 0, 2] == pytest.approx(-C.BASE_KNOCKBACK * C.GROUND_DRAG)
    assert sim.vel[0, 0, 1] == pytest.approx((0.3608 - C.GRAVITY) * C.VERTICAL_DRAG)


def test_shield_blocks_mob_melee_and_pushes_the_mob():
    sim = duel(ZOMBIE, distance=1.0)
    sim.shield_ticks[:, 0] = C.SHIELD_RAISE_TICKS
    sim.mobs._melee_attacks(np.array([0]), np.array([0]), np.array([True]))
    assert sim.hp[0, 0] == C.MAX_HEALTH
    assert sim.events["melee_blocked"][0, 1] == 1.0
    assert sim.mobs.vel[0, 0, 2] > 0.3


def test_shield_does_not_cover_the_back():
    sim = duel(ZOMBIE, distance=1.0)
    sim.yaw[:, 0] = 180.0
    sim.shield_ticks[:, 0] = C.SHIELD_RAISE_TICKS
    sim.mobs._melee_attacks(np.array([0]), np.array([0]), np.array([True]))
    assert sim.hp[0, 0] < C.MAX_HEALTH


def test_wall_blocks_melee_line_of_sight():
    raw = flat_raw()
    raw[:, 10, yi(FLOOR + 1) : yi(FLOOR + 5)] = B.STONE
    sim = world_duel(raw, ZOMBIE, player=(8.5, 8.5), mob=(8.5, 12.5))
    env, slot = np.array([0]), np.array([0])
    assert not sim.mobs._line_of_sight(env, slot, sim.eyes()[env, 0])[0]
    open_field = world_duel(flat_raw(), ZOMBIE, player=(8.5, 8.5), mob=(8.5, 12.5))
    assert open_field.mobs._line_of_sight(env, slot, open_field.eyes()[env, 0])[0]
    close = duel(ZOMBIE, distance=1.0)
    close.mobs._melee_attacks(env, slot, np.array([False]))
    assert close.hp[0, 0] == C.MAX_HEALTH


def test_axe_damage_on_zombie_uses_armor():
    sim = duel(ZOMBIE, distance=2.0)
    sim.weapon[:, 0] = C.AXE
    aim_at(sim)
    sim.attack_ticks[:, 0] = 1000.0
    swing(sim)
    effective = max(2.0 / 5.0, 2.0 - 4.0 * 9.0 / 8.0)
    assert 20.0 - sim.mobs.hp[0, 0] == pytest.approx(9.0 * (1.0 - effective / 25.0))


def test_mob_hurt_window_pays_only_the_difference():
    sim = duel(SKELETON, distance=3.0, angry=False)
    env, slot = np.array([0]), np.array([0])
    sim.mobs.hurt(env, slot, np.array([5.0]))
    sim.mobs.hurt(env, slot, np.array([3.0]))
    assert sim.mobs.hp[0, 0] == 15.0
    sim.mobs.hurt(env, slot, np.array([9.0]))
    assert sim.mobs.hp[0, 0] == 11.0


def test_swing_needs_aim_and_reach():
    sim = duel(SKELETON, distance=2.0, angry=False)
    sim.weapon[:, 0] = C.AXE
    sim.attack_ticks[:, 0] = 1000.0
    sim.yaw[:, 0] = 90.0
    swing(sim)
    assert sim.mobs.hp[0, 0] == 20.0
    far = duel(SKELETON, distance=4.0, angry=False)
    far.weapon[:, 0] = C.AXE
    far.attack_ticks[:, 0] = 1000.0
    aim_at(far)
    swing(far)
    assert far.mobs.hp[0, 0] == 20.0


def test_sprint_hit_knocks_a_mob_further():
    plain = duel(SKELETON, distance=2.0, angry=False)
    plain.weapon[:, 0] = C.AXE
    plain.attack_ticks[:, 0] = 1000.0
    aim_at(plain)
    plain.mobs.player_melee(np.array([True]))
    running = duel(SKELETON, distance=2.0, angry=False)
    running.weapon[:, 0] = C.AXE
    running.attack_ticks[:, 0] = 1000.0
    running.sprinting[:, 0] = True
    aim_at(running)
    running.mobs.player_melee(np.array([True]))
    assert plain.mobs.vel[0, 0, 2] == pytest.approx(C.BASE_KNOCKBACK, abs=1e-6)
    assert running.mobs.vel[0, 0, 2] == pytest.approx(0.5 * C.BASE_KNOCKBACK + C.SPRINT_KNOCKBACK_BONUS)


def test_falling_hit_is_a_critical():
    sim = duel(SKELETON, distance=2.0, angry=False)
    sim.weapon[:, 0] = C.AXE
    sim.attack_ticks[:, 0] = 1000.0
    aim_at(sim)
    sim.on_ground[:, 0] = False
    sim.combat.fall_distance[:, 0] = 1.0
    sim.mobs.player_melee(np.array([True]))
    assert 20.0 - sim.mobs.hp[0, 0] == pytest.approx(13.5)


def test_swing_hits_the_first_mob_on_the_ray():
    sim = duel(SKELETON, distance=2.9, angry=False)
    sim.mobs.spawn(0, 1, SKELETON, 0.0, 0.0, 1.5)
    sim.weapon[:, 0] = C.AXE
    sim.attack_ticks[:, 0] = 1000.0
    aim_at(sim, slot=1)
    sim.mobs.player_melee(np.array([True]))
    assert sim.mobs.hp[0, 1] < 20.0
    assert sim.mobs.hp[0, 0] == 20.0


def test_killing_a_mob_counts_for_the_player():
    sim = duel(SKELETON, distance=2.0, angry=False)
    sim.mobs.hp[0, 0] = 1.0
    sim.weapon[:, 0] = C.AXE
    sim.attack_ticks[:, 0] = 1000.0
    aim_at(sim)
    sim.mobs.player_melee(np.array([True]))
    assert not sim.mobs.alive[0, 0]
    assert sim.mobs.kills[0] == 1


def test_player_arrow_damages_a_mob():
    sim = duel(SKELETON, distance=6.0, angry=False)
    sim.arrow_on[0, 0] = True
    sim.arrow_owner[0, 0] = 0
    sim.arrow_pos[0, 0] = (0.0, 1.0, 3.0)
    sim.arrow_vel[0, 0] = (0.0, 0.0, 3.0)
    sim.arrow_damage[0, 0] = 2.0
    sim.arrow_crit[0, 0] = False
    sim.mobs.catch_arrows()
    sim.arrow_pos[0, 0] = (0.0, 1.0, 5.6)
    sim.mobs.catch_arrows()
    assert sim.mobs.hp[0, 0] == pytest.approx(14.0)
    assert not sim.arrow_on[0, 0]
    assert sim.events["arrow_hits"][0, 0] == 1.0


def test_skeleton_fires_on_the_difficulty_interval():
    for difficulty, period in (("normal", 60), ("hard", 40)):
        sim = duel(SKELETON, distance=9.0, difficulty=difficulty)
        sim.mobs.see_time[:, 0] = 30
        shots = []
        for tick in range(200):
            hold(sim)
            sim.hp[:, 0] = C.MAX_HEALTH
            events = sim.step(idle(sim))
            if events["arrows_fired"][0, 1] > 0:
                shots.append(tick)
        assert len(shots) >= 3
        assert set(np.diff(shots).tolist()) == {period}


def test_skeleton_arrow_leaves_at_bow_speed_and_cannot_be_picked_up():
    sim = duel(SKELETON, distance=9.0)
    sim.mobs._shoot(0, 0)
    slot = int(np.flatnonzero(sim.arrow_on[0])[0])
    assert np.linalg.norm(sim.arrow_vel[0, slot]) == pytest.approx(1.6, rel=0.1)
    assert sim.arrow_owner[0, slot] == 1
    assert not sim.arrow_pickup[0, slot]
    assert sim.arrow_pos[0, slot, 1] == pytest.approx(EYE[SKELETON] - 0.1)


def test_skeleton_arrow_damage_on_normal():
    sim = duel(SKELETON, distance=9.0, n=1)
    seen = []
    for _ in range(300):
        sim.mobs._shoot(0, 0)
        slot = int(np.flatnonzero(sim.arrow_on[0])[0])
        seen.append(float(np.ceil(sim.arrow_damage[0, slot] * 1.6)))
        sim.arrow_on[0] = False
    assert min(seen) >= 3.0
    assert max(seen) <= 5.0


def test_skeleton_arrow_is_stopped_by_a_raised_shield():
    sim = duel(SKELETON, distance=6.0)
    sim.shield_ticks[:, 0] = C.SHIELD_RAISE_TICKS
    sim.mobs._shoot(0, 0)
    a = idle(sim)
    a[:, 0, A.USE] = 1
    blocked = 0.0
    for _ in range(15):
        hold(sim)
        blocked += sim.step(a)["arrows_blocked"][0, 0]
    assert blocked == 1.0
    assert sim.hp[0, 0] == C.MAX_HEALTH


def test_skeleton_backs_away_inside_a_quarter_of_its_range():
    sim = duel(SKELETON, distance=4.0)
    sim.mobs.see_time[:, 0] = 30
    sim.mobs.strafe_time[:, 0] = 0
    start = float(sim.mobs.pos[0, 0, 2])
    for _ in range(15):
        hold(sim)
        sim.hp[:, 0] = C.MAX_HEALTH
        run(sim, 1)
    assert sim.mobs.pos[0, 0, 2] > start


def test_skeleton_strafes_at_range():
    sim = duel(SKELETON, distance=9.0)
    sim.mobs.see_time[:, 0] = 30
    for _ in range(15):
        hold(sim)
        sim.hp[:, 0] = C.MAX_HEALTH
        run(sim, 1)
    assert abs(sim.mobs.pos[0, 0, 0]) > 0.2


def test_skeleton_walks_in_when_out_of_range():
    sim = duel(SKELETON, distance=15.8)
    sim.pos[:, 0] = (0.0, 0.0, -4.0)
    sim.mobs.pos[0, 0] = (0.0, 0.0, 11.8)
    start = float(sim.mobs.pos[0, 0, 2])
    run(sim, 10)
    assert sim.mobs.pos[0, 0, 2] < start


def test_creeper_stays_calm_outside_three_blocks():
    sim = duel(CREEPER, distance=3.5)
    sim.mobs.vel[:, 0] = 0.0
    sim.mobs._fuses(np.array([0]), np.array([0]), np.array([3.5**2]), np.array([True]))
    assert sim.mobs.swell[0, 0] == 0


def test_creeper_fuse_takes_thirty_ticks():
    sim = duel(CREEPER, distance=2.0)
    ticks = 0
    while sim.mobs.alive[0, 0] and ticks < 60:
        hold(sim)
        run(sim, 1)
        ticks += 1
    assert ticks == FUSE_TICKS
    assert sim.mobs.blasts[0] == 1


def test_creeper_stops_walking_while_it_swells():
    sim = duel(CREEPER, distance=2.5)
    run(sim, 3)
    assert sim.mobs.swell[0, 0] > 0
    for _ in range(5):
        hold(sim)
        before = sim.mobs.pos[0, 0].copy()
        run(sim, 1)
    assert np.linalg.norm(sim.mobs.pos[0, 0] - before) < 0.05


def test_creeper_keeps_swelling_up_to_seven_blocks():
    sim = duel(CREEPER, distance=2.5)
    run(sim, 3)
    level = int(sim.mobs.swell[0, 0])
    sim.pos[:, 0] = (0.0, 0.0, sim.mobs.pos[0, 0, 2] - 6.5)
    sim.vel[:, 0] = 0.0
    run(sim, 2)
    assert sim.mobs.swell[0, 0] == level + 2


def test_creeper_cancels_past_seven_blocks():
    sim = duel(CREEPER, distance=2.5)
    run(sim, 10)
    level = int(sim.mobs.swell[0, 0])
    sim.pos[:, 0] = (0.0, 0.0, sim.mobs.pos[0, 0, 2] - 7.5)
    sim.vel[:, 0] = 0.0
    run(sim, 4)
    assert sim.mobs.swell[0, 0] == level - 4
    assert sim.mobs.alive[0, 0]


def test_creeper_cancels_without_line_of_sight():
    raw = flat_raw()
    raw[:, 10, yi(FLOOR + 1) : yi(FLOOR + 5)] = B.STONE
    sim = world_duel(raw, CREEPER, player=(8.5, 9.0), mob=(8.5, 11.0))
    sim.mobs.swell[0, 0] = 10
    sim.mobs.swell_dir[0, 0] = 1
    run(sim, 3)
    assert sim.mobs.swell[0, 0] < 10


@pytest.mark.parametrize(("distance", "expected"), [(0.0, 43.0), (3.0, 16.75), (5.0, 5.0833)])
def test_blast_damage_formula(distance, expected):
    near = 1.0 - distance / 6.0
    formula = (near * near + near) / 2.0 * 7.0 * 6.0 + 1.0
    assert float(blast_damage(distance)) == pytest.approx(formula)
    assert float(blast_damage(distance)) == pytest.approx(expected, abs=0.35)


def test_blast_has_no_damage_past_its_radius():
    assert float(blast_damage(BLAST_RADIUS)) == pytest.approx(1.0)
    assert float(blast_damage(BLAST_RADIUS + 1e-6)) == 0.0
    assert float(blast_damage(BLAST_RADIUS + 1.0)) == 0.0


def test_blast_difficulty_scaling():
    assert float(difficulty_scale(43.0, "easy")) == pytest.approx(22.5)
    assert float(difficulty_scale(43.0, "normal")) == pytest.approx(43.0)
    assert float(difficulty_scale(43.0, "hard")) == pytest.approx(64.5)


def test_blast_damages_the_player_through_armor():
    for armor, points in (("none", 0.0), ("iron", 15.0)):
        sim = duel(CREEPER, distance=4.0, armor=armor)
        sim.yaw[:, 0] = 180.0
        sim.mobs.explode(0, 0)
        raw = float(blast_damage(4.0))
        scaled = raw * (1.0 - max(points / 5.0, points - 4.0 * raw / 8.0) / 25.0)
        assert C.MAX_HEALTH - sim.hp[0, 0] == pytest.approx(scaled)


def test_blast_knocks_the_player_away_from_the_center():
    sim = duel(CREEPER, distance=3.0)
    sim.yaw[:, 0] = 180.0
    sim.mobs.explode(0, 0)
    eye_gap = np.array([0.0, C.EYE_HEIGHT, -3.0])
    size = 0.5 * eye_gap / np.linalg.norm(eye_gap)
    assert sim.vel[0, 0, 2] == pytest.approx(size[2], abs=1e-6)
    assert sim.vel[0, 0, 1] > 0.0


def test_shield_blocks_a_blast_but_not_its_push():
    sim = duel(CREEPER, distance=3.0)
    sim.shield_ticks[:, 0] = C.SHIELD_RAISE_TICKS
    sim.mobs.explode(0, 0)
    assert sim.hp[0, 0] == C.MAX_HEALTH
    assert sim.vel[0, 0, 2] < -0.2


def test_blast_removes_the_creeper_without_a_kill():
    sim = duel(CREEPER, distance=3.0)
    sim.mobs.explode(0, 0)
    assert not sim.mobs.alive[0, 0]
    assert sim.mobs.kills[0] == 0


def test_blast_hurts_other_mobs_without_credit():
    sim = duel(CREEPER, distance=5.0)
    sim.mobs.spawn(0, 1, ZOMBIE, 0.0, 0.0, 7.0)
    sim.mobs.explode(0, 0)
    assert sim.mobs.hp[0, 1] < 20.0
    assert sim.mobs.damage_done[0] == 0.0


def test_blast_breaks_blocks_only_in_a_world():
    raw = flat_raw(size=32, block=B.DIRT)
    sim = world_duel(raw, CREEPER, player=(4.5, 4.5), mob=(20.5, 20.5))
    before = sim.world.block(20, FLOOR, 20, 0)
    sim.mobs.explode(0, 0)
    assert before == B.DIRT
    assert sim.world.block(20, FLOOR, 20, 0) == B.AIR

    flat = duel(CREEPER, distance=3.0)
    flat.mobs.explode(0, 0)
    assert flat.world is None


def test_blast_keeps_bedrock_and_can_be_switched_off():
    raw = flat_raw(size=32, block=B.BEDROCK)
    sim = world_duel(raw, CREEPER, player=(4.5, 4.5), mob=(20.5, 20.5))
    sim.mobs.explode(0, 0)
    assert sim.world.block(20, FLOOR, 20, 0) == B.BEDROCK

    raw = flat_raw(size=32, block=B.DIRT)
    calm = world_duel(raw, CREEPER, player=(4.5, 4.5), mob=(20.5, 20.5), griefing=False)
    calm.mobs.explode(0, 0)
    assert calm.world.block(20, FLOOR, 20, 0) == B.DIRT


def test_wall_shields_the_player_from_most_of_a_blast():
    raw = flat_raw()
    raw[:, 10, yi(FLOOR + 1) : yi(FLOOR + 8)] = B.OBSIDIAN
    sim = world_duel(raw, CREEPER, player=(8.5, 8.5), mob=(8.5, 12.5), griefing=False)
    sim.yaw[:, 0] = 180.0
    sim.mobs.explode(0, 0)
    assert C.MAX_HEALTH - sim.hp[0, 0] == pytest.approx(1.0)


def test_enderman_ignores_a_player_who_does_not_look():
    sim = duel(ENDERMAN, distance=8.0, angry=False)
    sim.yaw[:, 0] = 90.0
    run(sim, 60)
    assert not sim.mobs.provoked[0, 0]
    assert sim.hp[0, 0] == C.MAX_HEALTH


def look_at_eyes(sim):
    aim_at(sim, share=EYE[ENDERMAN] / HEIGHT[ENDERMAN])


def test_enderman_is_provoked_after_five_ticks_of_eye_contact():
    sim = duel(ENDERMAN, distance=8.0, angry=False)
    look_at_eyes(sim)
    run(sim, 4)
    assert not sim.mobs.provoked[0, 0]
    run(sim, 1)
    assert sim.mobs.provoked[0, 0]


def test_looking_at_the_legs_does_not_provoke_up_close():
    sim = duel(ENDERMAN, distance=5.0, angry=False)
    aim_at(sim, share=0.2)
    run(sim, 30)
    assert not sim.mobs.provoked[0, 0]


def test_enderman_stare_needs_a_clear_view():
    raw = flat_raw()
    raw[:, 10, yi(FLOOR + 1) : yi(FLOOR + 6)] = B.STONE
    sim = world_duel(raw, ENDERMAN, player=(8.5, 8.5), mob=(8.5, 13.5))
    sim.mobs.targeting[:, 0] = False
    sim.mobs.provoked[:, 0] = False
    look_at_eyes(sim)
    run(sim, 20)
    assert not sim.mobs.provoked[0, 0]


def test_hitting_an_enderman_provokes_it():
    sim = duel(ENDERMAN, distance=2.0, angry=False)
    sim.weapon[:, 0] = C.AXE
    sim.attack_ticks[:, 0] = 1000.0
    aim_at(sim, share=0.3)
    sim.mobs.player_melee(np.array([True]))
    assert sim.mobs.provoked[0, 0]
    assert sim.mobs.hp[0, 0] == pytest.approx(31.0)


def test_angry_enderman_runs_faster():
    sim = duel(ENDERMAN, distance=11.0)
    sim.pos[:, 0] = (0.0, 0.0, -9.0)
    sim.yaw[:, 0] = 180.0
    run(sim, 10)
    start = float(sim.mobs.pos[0, 0, 2])
    run(sim, 5)
    moved = (start - float(sim.mobs.pos[0, 0, 2])) / 5.0
    assert moved == pytest.approx(0.45 * 0.45 / (1.0 - C.GROUND_DRAG), rel=0.03)


def test_enderman_freezes_while_looked_at():
    sim = duel(ENDERMAN, distance=10.0)
    look_at_eyes(sim)
    start = sim.mobs.pos[0, 0].copy()
    for _ in range(10):
        hold(sim)
        look_at_eyes(sim)
        run(sim, 1)
    assert np.linalg.norm(sim.mobs.pos[0, 0] - start) < 0.05


def test_enderman_teleports_when_looked_at_up_close():
    sim = duel(ENDERMAN, distance=3.0)
    look_at_eyes(sim)
    start = sim.mobs.pos[0, 0].copy()
    run(sim, 1)
    assert np.linalg.norm(sim.mobs.pos[0, 0] - start) > 1.0


def test_enderman_teleports_toward_a_far_player():
    sim = MobSim(1, SimConfig(armor="none", arena_half=30.0, decisions_per_second=20), seed=3)
    sim.pos[:, 0] = (0.0, 0.0, -20.0)
    sim.vel[:, 0] = 0.0
    sim.yaw[:, 0] = 180.0
    sim.mobs.spawn(0, 0, ENDERMAN, 0.0, 0.0, 20.0)
    sim.mobs.provoked[:, 0] = True
    sim.mobs.targeting[:, 0] = True
    assert sim.mobs.teleport_toward(0, 0)
    assert sim.mobs.pos[0, 0, 2] < 10.0


def test_enderman_dodges_arrows():
    sim = duel(ENDERMAN, distance=6.0, angry=False)
    start = sim.mobs.pos[0, 0].copy()
    sim.arrow_on[0, 0] = True
    sim.arrow_owner[0, 0] = 0
    sim.arrow_pos[0, 0] = (0.0, 1.0, 5.6)
    sim.arrow_vel[0, 0] = (0.0, 0.0, 3.0)
    sim.mobs.catch_arrows()
    assert sim.mobs.hp[0, 0] == 40.0
    assert sim.mobs.provoked[0, 0]
    assert np.linalg.norm(sim.mobs.pos[0, 0] - start) > 0.5


def test_enderman_teleport_stays_inside_the_arena():
    sim = duel(ENDERMAN, distance=4.0)
    for _ in range(100):
        assert sim.mobs.teleport(0, 0)
        assert np.abs(sim.mobs.pos[0, 0, [0, 2]]).max() <= sim.cfg.arena_half
        assert sim.mobs.pos[0, 0, 1] == 0.0


def test_water_hurts_an_enderman_and_makes_it_teleport():
    raw = flat_raw()
    raw[8, 12, yi(FLOOR + 1)] = B.WATER_SOURCE
    sim = world_duel(raw, ENDERMAN, player=(8.5, 4.5), mob=(8.5, 12.5))
    sim.mobs.targeting[:, 0] = False
    sim.mobs.provoked[:, 0] = False
    sim.yaw[:, 0] = 180.0
    sim.mobs.tick()
    assert sim.mobs.hp[0, 0] == 39.0


def test_water_does_not_hurt_a_zombie():
    raw = flat_raw()
    raw[8, 12, yi(FLOOR + 1)] = B.WATER_SOURCE
    sim = world_duel(raw, ZOMBIE, player=(8.5, 4.5), mob=(8.5, 12.5))
    sim.mobs.targeting[:, 0] = False
    sim.mobs.tick()
    assert sim.mobs.hp[0, 0] == 20.0


@pytest.mark.parametrize("kind", [ZOMBIE, SKELETON])
def test_undead_burn_in_daylight(kind):
    sim = duel(kind, distance=10.0, angry=False, daylight=True)
    run(sim, 45)
    assert sim.mobs.hp[0, 0] < 20.0


def test_undead_do_not_burn_at_night_or_under_cover():
    night = duel(ZOMBIE, distance=10.0, angry=False)
    run(night, 45)
    assert night.mobs.hp[0, 0] == 20.0

    raw = flat_raw()
    raw[:, :, yi(FLOOR + 6)] = B.STONE
    covered = world_duel(raw, ZOMBIE, player=(4.5, 4.5), mob=(8.5, 12.5), daylight=True)
    covered.mobs.targeting[:, 0] = False
    run(covered, 45)
    assert covered.mobs.hp[0, 0] == 20.0


def test_creeper_does_not_burn_in_daylight():
    sim = duel(CREEPER, distance=10.0, angry=False, daylight=True)
    run(sim, 45)
    assert sim.mobs.hp[0, 0] == 20.0


def test_mob_climbs_a_one_block_step():
    raw = flat_raw()
    raw[:, 12:, yi(FLOOR + 1)] = B.STONE
    sim = world_duel(raw, ZOMBIE, player=(8.5, 16.5), mob=(8.5, 9.5))
    sim.pos[:, 0, 1] = FLOOR + 2.0
    for _ in range(90):
        sim.pos[:, 0] = (8.5, FLOOR + 2.0, 16.5)
        sim.vel[:, 0] = 0.0
        sim.hp[:, 0] = C.MAX_HEALTH
        run(sim, 1)
    assert sim.mobs.pos[0, 0, 1] >= FLOOR + 2.0 - 1e-6


def test_mob_finds_a_way_around_a_short_wall():
    raw = flat_raw()
    raw[7:10, 12, yi(FLOOR + 1) : yi(FLOOR + 4)] = B.STONE
    sim = world_duel(raw, ZOMBIE, player=(8.5, 15.5), mob=(8.5, 10.5))
    best = 0.0
    for _ in range(400):
        sim.pos[:, 0] = (8.5, FLOOR + 1.0, 15.5)
        sim.vel[:, 0] = 0.0
        sim.hp[:, 0] = C.MAX_HEALTH
        run(sim, 1)
        best = max(best, float(sim.mobs.pos[0, 0, 2]))
    assert best > 12.5


def test_mobs_stay_inside_the_flat_arena():
    sim = duel(ZOMBIE, distance=10.0)
    sim.mobs.vel[0, 0] = (8.0, 0.0, 8.0)
    run(sim, 3)
    assert np.abs(sim.mobs.pos[0, 0, [0, 2]]).max() <= sim.cfg.arena_half


def test_overlapping_mobs_push_apart():
    sim = duel(ZOMBIE, distance=8.0, angry=False)
    sim.mobs.spawn(0, 1, ZOMBIE, 0.1, 0.0, 8.0)
    run(sim, 10)
    gap = abs(float(sim.mobs.pos[0, 1, 0] - sim.mobs.pos[0, 0, 0]))
    assert gap > 0.1


def test_several_mobs_can_hit_one_player_within_the_hurt_window_rules():
    sim = duel(ZOMBIE, distance=1.0)
    sim.mobs.spawn(0, 1, ENDERMAN, 1.0, 0.0, 0.0)
    sim.mobs.targeting[:, :] = True
    sim.mobs.goal_on[:, :] = True
    sim.mobs.provoked[0, 1] = True
    sim.yaw[:, 0] = 90.0
    sim.mobs._melee_attacks(np.array([0, 0]), np.array([0, 1]), np.array([True, True]))
    assert C.MAX_HEALTH - sim.hp[0, 0] == pytest.approx(7.0)


def test_seat_one_shows_the_nearest_living_mob():
    sim = duel(ZOMBIE, distance=8.0, angry=False)
    sim.mobs.spawn(0, 1, SKELETON, 0.0, 0.0, 4.0)
    sim.mobs.draw[0, 1] = 7
    sim.show_focus()
    assert sim.pos[0, 1, 2] == 4.0
    assert sim.weapon[0, 1] == C.BOW
    assert sim.draw_ticks[0, 1] == 7
    sim.mobs.alive[0, 1] = False
    sim.show_focus()
    assert sim.pos[0, 1, 2] == 8.0
    assert sim.weapon[0, 1] == C.SWORD


def test_seat_one_health_is_the_share_of_the_mob():
    sim = duel(ENDERMAN, distance=8.0, angry=False)
    sim.mobs.hp[0, 0] = 10.0
    sim.show_focus()
    assert sim.hp[0, 1] == pytest.approx(5.0)


def test_seat_one_never_acts():
    sim = duel(SKELETON, distance=9.0)
    a = idle(sim)
    a[:, 1, A.ATTACK] = 1
    a[:, 1, A.FORWARD] = A.KEY_FORWARD
    a[:, 1, A.USE] = 1
    fired = 0.0
    for _ in range(25):
        fired += sim.step(a)["swings"][0, 1]
    assert fired == 0.0
    assert sim.hp[0, 0] == C.MAX_HEALTH


def test_reset_clears_the_mobs():
    sim = duel(ZOMBIE, distance=5.0, n=2)
    sim.reset(np.array([True, False]))
    assert not sim.mobs.alive[0].any()
    assert sim.mobs.alive[1, 0]


def test_mob_rules_run_in_a_block_world():
    sim = MobSim(2, SimConfig(armor="iron", world_size=64), seed=4, profile="surface")
    kinds = np.full((2, 4), -1)
    kinds[:, :3] = (ZOMBIE, SKELETON, CREEPER)
    sim.mobs.spawn_roster(np.arange(2), kinds)
    sim.show_focus()
    for _ in range(40):
        sim.step(np.stack([A.neutral_actions(np.full(2, C.SWORD))] * 2, axis=1))
    assert np.isfinite(sim.mobs.pos).all()
    sim.close()


def test_plain_simulator_is_unchanged_by_the_mob_module():
    first = Sim(4, SimConfig(), seed=9)
    second = Sim(4, SimConfig(), seed=9)
    action = np.stack([A.neutral_actions(np.full(4, C.SWORD))] * 2, axis=1)
    action[..., A.FORWARD] = A.KEY_FORWARD
    for _ in range(30):
        first.step(action)
        second.step(action)
    assert np.array_equal(first.pos, second.pos)
    assert not hasattr(first, "mobs")


def mob_arrow_toward_the_player(skeleton_z: float, other: int, other_z: float, player_z: float = 0.0):
    sim = MobSim(1, SimConfig(armor="none", arena_half=40.0, decisions_per_second=20), seed=31)
    sim.pos[:, 0] = (0.0, 0.0, player_z)
    sim.mobs.spawn(0, 0, SKELETON, 0.0, 0.0, skeleton_z)
    sim.mobs.spawn(0, 1, other, 0.0, 0.0, other_z)
    sim.arrow_on[0, 0] = True
    sim.arrow_owner[0, 0] = 1
    sim.mobs.shooter[0, 0] = 0
    sim.arrow_pos[0, 0] = (0.0, 1.0, skeleton_z - 0.5)
    sim.arrow_vel[0, 0] = (0.0, 0.0, -1.5)
    return sim


def test_skeleton_arrow_hurts_another_mob_without_player_credit():
    sim = mob_arrow_toward_the_player(12.0, ZOMBIE, 11.0)
    sim.mobs.catch_arrows()
    assert sim.mobs.hp[0, 1] < HEALTH[ZOMBIE]
    assert sim.mobs.hp[0, 0] == HEALTH[SKELETON]
    assert not sim.arrow_on[0, 0]
    assert sim.mobs.damage_done[0] == 0.0
    assert sim.events["damage_dealt"][0, 0] == 0.0


def test_skeleton_arrow_skips_its_shooter_and_a_mob_behind_the_player():
    sim = mob_arrow_toward_the_player(12.0, ZOMBIE, 10.2, player_z=10.9)
    sim.mobs.pos[0, 0] = (0.0, 0.0, 11.4)
    sim.mobs.catch_arrows()
    assert sim.mobs.hp[0, 0] == HEALTH[SKELETON]
    assert sim.mobs.hp[0, 1] == HEALTH[ZOMBIE]
    assert sim.arrow_on[0, 0]


def test_skeleton_arrow_does_not_provoke_an_enderman():
    sim = MobSim(1, SimConfig(armor="none", arena_half=40.0, decisions_per_second=20), seed=32)
    sim.pos[:, 0] = (0.0, 0.0, 0.0)
    sim.mobs.spawn(0, 0, SKELETON, 0.0, 0.0, 12.0)
    sim.mobs.spawn(0, 1, ENDERMAN, 0.0, 0.0, 6.0)
    start = sim.mobs.pos[0, 1].copy()
    sim.arrow_on[0, 0] = True
    sim.arrow_owner[0, 0] = 1
    sim.mobs.shooter[0, 0] = 0
    sim.arrow_pos[0, 0] = (0.0, 1.0, 7.0)
    sim.arrow_vel[0, 0] = (0.0, 0.0, -1.5)
    sim.mobs.catch_arrows()
    assert not sim.mobs.provoked[0, 1]
    assert sim.mobs.hp[0, 1] == HEALTH[ENDERMAN]
    assert np.linalg.norm(sim.mobs.pos[0, 1] - start) > 0.5


def test_creeper_blast_hurts_every_nearby_mob_without_player_credit():
    sim = MobSim(1, SimConfig(armor="none", arena_half=40.0, decisions_per_second=20), seed=33)
    sim.pos[:, 0] = (0.0, 0.0, 0.0)
    sim.mobs.spawn(0, 0, CREEPER, 0.0, 0.0, 10.0)
    sim.mobs.spawn(0, 1, ZOMBIE, 1.0, 0.0, 10.0)
    sim.mobs.spawn(0, 2, SKELETON, -2.0, 0.0, 10.0)
    sim.mobs.spawn(0, 3, ENDERMAN, 0.0, 0.0, 30.0)
    sim.mobs.explode(0, 0)
    assert sim.mobs.hp[0, 1] < HEALTH[ZOMBIE]
    assert sim.mobs.hp[0, 2] < HEALTH[SKELETON]
    assert sim.mobs.hp[0, 3] == HEALTH[ENDERMAN]
    assert not sim.mobs.provoked[0, 3]
    assert sim.mobs.kills[0] == 0
    assert sim.mobs.damage_done[0] == 0.0
