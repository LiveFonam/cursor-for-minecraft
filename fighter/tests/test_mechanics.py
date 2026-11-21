"""Unit tests of the simulated combat mechanics against wiki values."""

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter.sim import Sim, SimConfig, armor_reduce, bow_speed, cooldown_multiplier


def make_sim(armor="none", distance=2.0, seed=0):
    sim = Sim(1, SimConfig(armor=armor), seed=seed)
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, distance]
    sim.yaw[0] = [0.0, 180.0]
    sim.pitch[0] = [0.0, 0.0]
    return sim


def idle(sim):
    return A.neutral_actions(sim.weapon.copy())


def press(sim, seat=0, **keys):
    a = idle(sim)
    for name, value in keys.items():
        a[0, seat, A.HEADS.index(name)] = value
    return a


def aim_at_chest(sim, seat=0):
    """Point a seat straight at the other player's chest."""
    other = 1 - seat
    eye = sim.pos[0, seat] + [0.0, C.EYE_HEIGHT, 0.0]
    chest = sim.pos[0, other] + [0.0, 0.9, 0.0]
    d = chest - eye
    sim.yaw[0, seat] = np.degrees(np.arctan2(-d[0], d[2]))
    sim.pitch[0, seat] = -np.degrees(np.arctan2(d[1], np.hypot(d[0], d[2])))


def run_ticks(sim, action, ticks):
    for _ in range(ticks):
        sim._tick(action, first=True)


def steady_speed(forward=A.KEY_FORWARD, sprint=0, use=0, ticks=200):
    sim = make_sim(distance=20.0)
    sim.cfg.arena_half = 10000.0
    sim.pos[0, 1] = [500.0, 0.0, 0.0]
    a = press(sim, forward=forward, sprint=sprint, use=use)
    run_ticks(sim, a, ticks)
    before = sim.pos[0, 0].copy()
    sim._tick(a, first=True)
    return float(np.linalg.norm((sim.pos[0, 0] - before)[[0, 2]]) * C.TICKS_PER_SECOND)


def test_walk_speed_matches_wiki():
    assert steady_speed() == pytest.approx(4.317, rel=0.002)


def test_sprint_speed_matches_wiki():
    assert steady_speed(sprint=1) == pytest.approx(5.612, rel=0.002)


def test_shield_slows_to_item_use_speed():
    assert steady_speed(use=1) == pytest.approx(0.863, rel=0.01)


def test_jump_apex_matches_wiki():
    sim = make_sim(distance=20.0)
    a = press(sim, jump=1)
    sim._tick(a, first=True)
    released = idle(sim)
    apex = sim.pos[0, 0, 1]
    for _ in range(20):
        sim._tick(released, first=True)
        apex = max(apex, sim.pos[0, 0, 1])
    assert apex == pytest.approx(1.2522, abs=0.001)


def test_sprint_jump_speed_near_wiki():
    sim = make_sim(distance=50.0)
    sim.cfg.arena_half = 10000.0
    a = press(sim, forward=A.KEY_FORWARD, sprint=1, jump=1)
    run_ticks(sim, a, 120)
    start = sim.pos[0, 0].copy()
    run_ticks(sim, a, 240)
    speed = np.linalg.norm((sim.pos[0, 0] - start)[[0, 2]]) / 240 * C.TICKS_PER_SECOND
    assert speed == pytest.approx(7.127, rel=0.02)


def test_fall_reaches_terminal_velocity():
    sim = make_sim(distance=20.0)
    sim.pos[0, 0, 1] = 5000.0
    sim.on_ground[0, 0] = False
    run_ticks(sim, idle(sim), 600)
    assert sim.vel[0, 0, 1] == pytest.approx(-3.92, abs=0.01)


def test_walls_stop_player_and_sprint():
    sim = make_sim(distance=3.0)
    sim.pos[0, 0] = [0.0, 0.0, C.ARENA_HALF_WIDTH - 1.0]
    sim.pos[0, 1] = [0.0, 0.0, 0.0]
    a = press(sim, forward=A.KEY_FORWARD, sprint=1)
    run_ticks(sim, a, 40)
    assert sim.pos[0, 0, 2] == pytest.approx(C.ARENA_HALF_WIDTH - C.PLAYER_WIDTH / 2)
    assert not sim.sprinting[0, 0]


def test_cooldown_formula():
    speed = np.array(1.6)
    assert cooldown_multiplier(np.array(0.0), speed) == pytest.approx(0.2 + (0.5 / 12.5) ** 2 * 0.8)
    assert cooldown_multiplier(np.array(6.0), speed) == pytest.approx(0.2 + (6.5 / 12.5) ** 2 * 0.8)
    assert cooldown_multiplier(np.array(13.0), speed) == 1.0


@pytest.mark.parametrize(
    "damage,armor,toughness,expected",
    [
        (7.0, 20.0, 8.0, 7.0 * (1 - 18.25 / 25)),
        (7.0, 15.0, 0.0, 7.0 * (1 - 11.5 / 25)),
        (50.0, 20.0, 8.0, 50.0 * (1 - 7.5 / 25)),
        (200.0, 20.0, 8.0, 200.0 * (1 - 4.0 / 25)),
        (1.0, 20.0, 12.0, 1.0 * (1 - 19.8 / 25)),
        (5.0, 0.0, 0.0, 5.0),
    ],
)
def test_armor_formula(damage, armor, toughness, expected):
    assert armor_reduce(np.array(damage), armor, toughness) == pytest.approx(expected)


def test_armor_reduction_is_capped_at_80_percent():
    assert armor_reduce(np.array(1.0), 40.0, 20.0) == pytest.approx(0.2)


def test_full_sword_hit_damage():
    sim = make_sim()
    aim_at_chest(sim)
    sim._tick(press(sim, attack=1), first=True)
    assert sim.hp[0, 1] == pytest.approx(C.MAX_HEALTH - 7.0)


def test_axe_damage_and_attack_speed():
    sim = make_sim()
    sim.weapon[0, 0] = C.AXE
    aim_at_chest(sim)
    sim._tick(press(sim, attack=1, weapon=A.WEAPON_ACTION[C.AXE]), first=True)
    assert sim.hp[0, 1] == pytest.approx(C.MAX_HEALTH - 9.0)
    assert C.TICKS_PER_SECOND / C.WEAPON_ATTACK_SPEED[C.AXE] == 20.0


def test_missed_swing_deals_no_damage():
    sim = make_sim()
    sim.yaw[0, 0] = 90.0
    sim._tick(press(sim, attack=1), first=True)
    assert sim.hp[0, 1] == C.MAX_HEALTH
    assert sim.events["swings"][0, 0] == 1


def test_reach_limits_melee():
    sim = make_sim(distance=4.0)
    aim_at_chest(sim)
    sim._tick(press(sim, attack=1), first=True)
    assert sim.hp[0, 1] == C.MAX_HEALTH


def test_critical_hit_needs_falling_and_multiplies():
    sim = make_sim()
    sim.pos[0, 0, 1] = 0.5
    aim_at_chest(sim)
    sim.on_ground[0, 0] = False
    sim.vel[0, 0, 1] = -0.2
    sim.combat.fall_distance[0, 0] = 0.2
    sim._tick(press(sim, attack=1), first=True)
    assert sim.hp[0, 1] == pytest.approx(C.MAX_HEALTH - 7.0 * 1.5)
    assert sim.events["crits"][0, 0] == 1


def test_rising_attacker_does_not_crit():
    sim = make_sim()
    sim.pos[0, 0, 1] = 0.5
    aim_at_chest(sim)
    sim.on_ground[0, 0] = False
    sim.vel[0, 0, 1] = 0.2
    sim._tick(press(sim, attack=1), first=True)
    assert sim.hp[0, 1] == pytest.approx(C.MAX_HEALTH - 7.0)


def test_uncharged_hit_cannot_crit():
    sim = make_sim()
    sim.pos[0, 0, 1] = 0.5
    aim_at_chest(sim)
    sim.on_ground[0, 0] = False
    sim.vel[0, 0, 1] = -0.2
    sim.combat.fall_distance[0, 0] = 0.2
    sim.attack_ticks[0, 0] = 2.0
    sim._tick(press(sim, attack=1), first=True)
    assert sim.events["crits"][0, 0] == 0


def test_sprint_hit_adds_knockback_and_stops_sprint():
    plain = make_sim()
    aim_at_chest(plain)
    plain._tick(press(plain, attack=1), first=True)

    sprint = make_sim()
    aim_at_chest(sprint)
    sprint.sprinting[0, 0] = True
    sprint.sprint_held[0, 0] = True
    sprint._tick(press(sprint, attack=1, forward=A.KEY_FORWARD, sprint=1), first=True)

    assert sprint.events["sprint_hits"][0, 0] == 1
    assert not sprint.sprinting[0, 0]
    assert sprint.pos[0, 1, 2] > plain.pos[0, 1, 2]


def test_sprint_hit_takes_priority_over_crit():
    sim = make_sim()
    sim.pos[0, 0, 1] = 0.5
    aim_at_chest(sim)
    sim.on_ground[0, 0] = False
    sim.vel[0, 0, 1] = -0.2
    sim.combat.fall_distance[0, 0] = 0.2
    sim.sprinting[0, 0] = True
    sim.sprint_held[0, 0] = True
    sim._tick(press(sim, attack=1, forward=A.KEY_FORWARD, sprint=1), first=True)
    assert sim.events["crits"][0, 0] == 0
    assert sim.events["sprint_hits"][0, 0] == 1


def test_w_tap_is_needed_to_sprint_again():
    sim = make_sim(distance=2.0)
    aim_at_chest(sim)
    sim.sprinting[0, 0] = True
    sim.sprint_held[0, 0] = True
    held = press(sim, forward=A.KEY_FORWARD, sprint=1)
    sim._tick(press(sim, attack=1, forward=A.KEY_FORWARD, sprint=1), first=True)
    run_ticks(sim, held, 3)
    assert not sim.sprinting[0, 0]
    sim._tick(press(sim, forward=A.NEUTRAL_FORWARD, sprint=1), first=True)
    sim._tick(held, first=True)
    assert sim.sprinting[0, 0]


def test_hurt_window_ignores_weaker_hit():
    sim = make_sim()
    aim_at_chest(sim)
    sim._tick(press(sim, attack=1), first=True)
    hp = sim.hp[0, 1]
    sim.pos[0, 1] = [0.0, 0.0, 2.0]
    aim_at_chest(sim)
    sim.attack_ticks[0, 0] = 2.0
    sim._tick(press(sim, attack=1), first=True)
    assert sim.hp[0, 1] == hp


def test_hurt_window_deals_only_the_difference():
    sim = make_sim()
    sim._hurt(np.array([True]), 1, np.array([7.0]), np.array([[0.0, 1.0]]), np.array([0.4]))
    timer = sim.hurt_timer[0, 1]
    sim._hurt(np.array([True]), 1, np.array([12.0]), np.array([[0.0, 1.0]]), np.array([0.4]))
    assert sim.hp[0, 1] == pytest.approx(C.MAX_HEALTH - 12.0)
    assert sim.hurt_timer[0, 1] == timer


def test_hurt_window_lasts_ten_ticks():
    sim = make_sim()
    direction = np.array([[0.0, 1.0]])
    knock = np.array([0.0])
    sim._hurt(np.array([True]), 1, np.array([3.0]), direction, knock)
    sim._advance_timers()
    for _ in range(8):
        sim._advance_timers()
    sim._hurt(np.array([True]), 1, np.array([3.0]), direction, knock)
    assert sim.hp[0, 1] == pytest.approx(C.MAX_HEALTH - 3.0)
    sim._advance_timers()
    sim._hurt(np.array([True]), 1, np.array([3.0]), direction, knock)
    assert sim.hp[0, 1] == pytest.approx(C.MAX_HEALTH - 6.0)


def test_shield_blocks_only_after_raise_delay():
    sim = make_sim()
    aim_at_chest(sim, 0)
    guard = press(sim, seat=1, use=1)
    run_ticks(sim, guard, C.SHIELD_RAISE_TICKS - 1)
    assert not sim.shield_active[0, 1]
    sim._tick(guard, first=True)
    assert sim.shield_active[0, 1]


def test_shield_blocks_front_hit():
    sim = make_sim()
    aim_at_chest(sim, 0)
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    a = press(sim, attack=1)
    a[0, 1, A.USE] = 1
    sim._tick(a, first=True)
    assert sim.hp[0, 1] == C.MAX_HEALTH
    assert sim.events["melee_blocked"][0, 0] == 1


def test_shield_does_not_block_from_behind():
    sim = make_sim()
    aim_at_chest(sim, 0)
    sim.yaw[0, 1] = 0.0
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    a = press(sim, attack=1)
    a[0, 1, A.USE] = 1
    sim._tick(a, first=True)
    assert sim.hp[0, 1] < C.MAX_HEALTH


def test_axe_disables_shield_for_five_seconds():
    sim = make_sim()
    sim.weapon[0, 0] = C.AXE
    aim_at_chest(sim, 0)
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    a = press(sim, attack=1, weapon=A.WEAPON_ACTION[C.AXE])
    a[0, 1, A.USE] = 1
    sim._tick(a, first=True)
    assert sim.events["shield_breaks"][0, 0] == 1
    assert sim.hp[0, 1] == C.MAX_HEALTH
    assert sim.shield_disabled[0, 1] == C.SHIELD_DISABLE_TICKS - 1
    guard = press(sim, seat=1, use=1, weapon=A.WEAPON_ACTION[C.AXE])
    guard[0, 0, A.WEAPON] = A.WEAPON_ACTION[C.AXE]
    run_ticks(sim, guard, C.SHIELD_DISABLE_TICKS - 1)
    assert sim.shield_ticks[0, 1] == 0
    run_ticks(sim, guard, 1)
    assert sim.shield_ticks[0, 1] == 1


def test_no_swing_while_holding_shield_up():
    sim = make_sim()
    aim_at_chest(sim, 0)
    sim._tick(press(sim, attack=1, use=1), first=True)
    assert sim.events["swings"][0, 0] == 0
    assert sim.hp[0, 1] == C.MAX_HEALTH


def test_axe_cannot_disable_a_shield_still_rising():
    sim = make_sim()
    sim.weapon[0, 0] = C.AXE
    aim_at_chest(sim, 0)
    sim.shield_ticks[0, 1] = 1
    a = press(sim, attack=1, weapon=A.WEAPON_ACTION[C.AXE])
    a[0, 1, A.USE] = 1
    sim._tick(a, first=True)
    assert sim.events["shield_breaks"][0, 0] == 0
    assert sim.hp[0, 1] < C.MAX_HEALTH


def test_arrow_motion_per_tick():
    sim = make_sim(distance=20.0)
    sim.arrow_on[0, 0] = True
    sim.arrow_pos[0, 0] = [5.0, 5.0, 0.0]
    sim.arrow_vel[0, 0] = [1.0, 0.0, 0.0]
    sim.arrow_owner[0, 0] = 1
    sim._step_arrows()
    assert sim.arrow_pos[0, 0] == pytest.approx([6.0, 5.0, 0.0])
    assert sim.arrow_vel[0, 0] == pytest.approx([0.99, -0.05, 0.0])


def test_arrow_terminal_velocity():
    sim = make_sim(distance=20.0)
    sim.arrow_on[0, 0] = True
    sim.arrow_pos[0, 0] = [5.0, 1.0e6, 0.0]
    sim.arrow_vel[0, 0] = [0.0, 0.0, 0.0]
    sim.arrow_owner[0, 0] = 1
    for _ in range(3000):
        sim._step_arrows()
    assert sim.arrow_vel[0, 0, 1] == pytest.approx(-5.0, abs=0.01)


def test_bow_speed_curve():
    assert bow_speed(np.array(20.0)) == pytest.approx(3.0)
    assert np.ceil(2.0 * bow_speed(np.array(18.0))) == 6.0
    assert np.ceil(2.0 * bow_speed(np.array(16.0))) == 5.0
    assert np.ceil(2.0 * bow_speed(np.array(2.0))) == 1.0


def fire_bow(sim, draw):
    sim.weapon[0, 0] = C.BOW
    aim_at_chest(sim, 0)
    hold = press(sim, use=1, weapon=A.WEAPON_ACTION[C.BOW])
    run_ticks(sim, hold, draw)
    sim._tick(press(sim, use=0, weapon=A.WEAPON_ACTION[C.BOW]), first=True)


def test_full_bow_shot_damage_range():
    seen = []
    for seed in range(60):
        sim = make_sim(distance=6.0, seed=seed)
        fire_bow(sim, C.BOW_FULL_DRAW_TICKS)
        run_ticks(sim, A.neutral_actions(sim.weapon.copy()), 6)
        seen.append(C.MAX_HEALTH - sim.hp[0, 1])
    assert min(seen) >= 6.0
    assert max(seen) <= 11.0
    assert len(set(seen)) > 1


def test_short_bow_draw_fires_nothing():
    sim = make_sim(distance=6.0)
    fire_bow(sim, 1)
    assert not sim.arrow_on.any()


def test_crossbow_needs_full_load_then_a_new_press():
    sim = make_sim(distance=6.0)
    sim.weapon[0, 0] = C.CROSSBOW
    aim_at_chest(sim, 0)
    hold = press(sim, use=1, weapon=A.WEAPON_ACTION[C.CROSSBOW])
    run_ticks(sim, hold, C.CROSSBOW_LOAD_TICKS - 1)
    assert not sim.loaded[0, 0]
    run_ticks(sim, hold, 1)
    assert sim.loaded[0, 0]
    run_ticks(sim, hold, 3)
    assert not sim.arrow_on.any()
    release = press(sim, use=0, weapon=A.WEAPON_ACTION[C.CROSSBOW])
    sim._tick(release, first=True)
    sim._tick(hold, first=True)
    assert sim.events["arrows_fired"][0, 0] == 1
    assert not sim.loaded[0, 0]


def test_crossbow_damage_range():
    seen = []
    for seed in range(60):
        sim = make_sim(distance=6.0, seed=seed)
        sim.weapon[0, 0] = C.CROSSBOW
        sim.loaded[0, 0] = True
        aim_at_chest(sim, 0)
        sim._tick(press(sim, use=1, weapon=A.WEAPON_ACTION[C.CROSSBOW]), first=True)
        run_ticks(sim, A.neutral_actions(sim.weapon.copy()), 6)
        seen.append(C.MAX_HEALTH - sim.hp[0, 1])
    assert min(seen) >= 7.0
    assert max(seen) <= 11.0


def test_shield_blocks_arrow_from_front_only():
    for facing, blocked in ((180.0, True), (0.0, False)):
        sim = make_sim(distance=6.0)
        sim.yaw[0, 1] = facing
        sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
        sim.arrow_on[0, 0] = True
        sim.arrow_pos[0, 0] = [0.0, 1.0, 4.0]
        sim.arrow_vel[0, 0] = [0.0, 0.0, 3.0]
        sim.arrow_owner[0, 0] = 0
        guard = press(sim, seat=1, use=1)
        sim._tick(guard, first=True)
        assert (sim.events["arrows_blocked"][0, 1] == 1) == blocked
        assert (sim.hp[0, 1] == C.MAX_HEALTH) == blocked


def test_weapon_switch_resets_cooldown():
    sim = make_sim()
    sim._tick(press(sim, weapon=A.WEAPON_ACTION[C.AXE]), first=True)
    assert sim.weapon[0, 0] == C.AXE
    assert sim.attack_ticks[0, 0] == 1.0


def test_batch_arenas_are_independent():
    sim = Sim(3, SimConfig(armor="none"), seed=1)
    sim.pos[:, 0] = [0.0, 0.0, 0.0]
    sim.pos[:, 1] = [0.0, 0.0, 2.0]
    sim.yaw[:] = [0.0, 180.0]
    d = np.array([0.0, 0.9 - C.EYE_HEIGHT, 2.0])
    sim.pitch[:, 0] = -np.degrees(np.arctan2(d[1], d[2]))
    a = A.neutral_actions(sim.weapon.copy())
    a[1, 0, A.ATTACK] = 1
    sim._tick(a, first=True)
    assert sim.hp[0, 1] == C.MAX_HEALTH
    assert sim.hp[1, 1] == pytest.approx(C.MAX_HEALTH - 7.0)
    assert sim.hp[2, 1] == C.MAX_HEALTH
