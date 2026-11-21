"""Damage order, enchantments, food, effects, kits and round rules."""

import numpy as np
import pytest

from fighter import actions as A
from fighter import combat as CB
from fighter import constants as C
from fighter import items as I
from fighter.env import ArenaVecEnv
from fighter.items import Kit, full_set
from fighter.opponents import OpponentPool
from fighter.sim import Sim, SimConfig


def duel(kit=None, second=None, **config):
    kits = (kit or Kit(),) if second is None else (kit, second)
    sim = Sim(1, SimConfig(kits=kits, uneven_rate=0.0, **config))
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 2.0]
    sim.yaw[0] = [0.0, 180.0]
    sim.pitch[0] = 0.0
    return sim


def swing(sim, seat=0):
    sim.attack_ticks[0, seat] = 1000.0
    mask = np.zeros((1, 2), dtype=bool)
    mask[0, seat] = True
    sim._melee(mask)


def idle(sim):
    return A.neutral_actions(sim.weapon.copy())


def test_sharpness_is_added_after_the_crit_and_scaled_by_charge():
    sim = duel(Kit(sharpness=5))
    sim.combat.fall_distance[0, 0] = 1.0
    sim.on_ground[0, 0] = False
    swing(sim)
    assert C.MAX_HEALTH - sim.hp[0, 1] == pytest.approx(7.0 * 1.5 + 3.0)
    weak = duel(Kit(sharpness=5))
    weak.attack_ticks[0, 0] = 2.0
    mask = np.array([[True, False]])
    weak._melee(mask)
    charge = 2.5 / 12.5
    assert C.MAX_HEALTH - weak.hp[0, 1] == pytest.approx(7.0 * (0.2 + 0.8 * charge**2) + 3.0 * charge)


def test_strength_scales_with_charge_and_crit():
    sim = duel()
    sim.combat.add_effect(0, 0, I.STRENGTH, 0, 100)
    sim.combat.fall_distance[0, 0] = 1.0
    sim.on_ground[0, 0] = False
    swing(sim)
    assert C.MAX_HEALTH - sim.hp[0, 1] == pytest.approx((7.0 + 3.0) * 1.5)


def test_protection_applies_after_armor_and_caps_at_twenty_points():
    kit = Kit(armor=full_set("diamond"), protection=(4, 4, 4, 4))
    sim = duel(Kit(), kit)
    sim.combat.kit_id[0] = [0, 1]
    sim.reset()
    sim.pos[0, 0], sim.pos[0, 1] = [0.0, 0.0, 0.0], [0.0, 0.0, 2.0]
    sim.yaw[0] = [0.0, 180.0]
    swing(sim)
    assert C.MAX_HEALTH - sim.hp[0, 1] == pytest.approx(1.89 * (1.0 - 16.0 / 25.0))
    capped = I.Kit(protection=(8, 8, 8, 8))
    points = CB._protection_points(capped, np.ones(4, bool))
    assert points[I.MELEE] == 32.0
    many = duel(capped)
    many.combat.hurt_one(0, 0, 10.0, I.MELEE)
    assert C.MAX_HEALTH - many.hp[0, 0] == pytest.approx(10.0 * (1.0 - 20.0 / 25.0))


def test_typed_protection_and_feather_falling():
    kit = Kit(
        fire_protection=(1, 0, 0, 0),
        projectile_protection=(0, 2, 0, 0),
        blast_protection=(0, 0, 3, 0),
        feather_falling=4,
    )
    points = CB._protection_points(kit, np.ones(4, bool))
    assert points[I.LAVA] == 2.0
    assert points[I.PROJECTILE] == 4.0
    assert points[I.BLAST] == 6.0
    assert points[I.FALL] == 12.0
    assert points[I.MELEE] == 0.0


def test_starvation_ignores_protection():
    points = CB._protection_points(Kit(protection=(4, 4, 4, 4)), np.ones(4, bool))
    assert points[I.STARVE] == 0.0
    assert points[I.ON_FIRE] == 16.0


def test_absorption_is_spent_before_health():
    sim = duel()
    sim.combat.absorption[0, 1] = 4.0
    swing(sim)
    assert sim.combat.absorption[0, 1] == 0.0
    assert sim.hp[0, 1] == pytest.approx(C.MAX_HEALTH - 3.0)
    assert sim.events["damage_dealt"][0, 0] == pytest.approx(3.0)


def test_golden_apple_takes_32_ticks_and_applies_all_effects():
    sim = duel(Kit(stock=((I.GOLDEN_APPLE, 1),)))
    sim.combat.food[0, 0] = 10
    sim.items.input[0, 0] = I.GOLDEN_APPLE
    for _ in range(I.USE_DURATION - 1):
        sim._tick(idle(sim), first=True)
    assert sim.items.count[0, 0, I.GOLDEN_APPLE] == 1
    sim._tick(idle(sim), first=True)
    assert sim.items.count[0, 0, I.GOLDEN_APPLE] == 0
    assert sim.combat.food[0, 0] == 14
    assert sim.combat.saturation[0, 0] == pytest.approx(14.0)
    assert sim.combat.absorption[0, 0] == 4.0
    assert sim.combat.effect_amp[0, 0, I.REGENERATION] == 1


def test_eating_stops_a_swing():
    sim = duel(Kit(stock=((I.GOLDEN_APPLE, 1),)))
    sim.items.input[0, 0] = I.GOLDEN_APPLE
    a = idle(sim)
    a[0, 0, A.ATTACK] = 1
    sim._tick(a, first=True)
    assert sim.events["swings"][0, 0] == 0


def test_regeneration_two_heals_every_25_ticks():
    sim = duel()
    sim.pos[0, 1] = [8.0, 0.0, 0.0]
    sim.hp[0, 0] = 10.0
    sim.combat.add_effect(0, 0, I.REGENERATION, 1, 100)
    for _ in range(100):
        sim._tick(idle(sim), first=True)
    assert sim.hp[0, 0] == pytest.approx(14.0)


def test_poison_stops_at_one_health():
    sim = duel()
    sim.pos[0, 1] = [8.0, 0.0, 0.0]
    sim.hp[0, 0] = 3.0
    sim.combat.add_effect(0, 0, I.POISON, 1, 200)
    for _ in range(200):
        sim._tick(idle(sim), first=True)
    assert sim.hp[0, 0] == 1.0


def test_fire_resistance_blocks_burning():
    sim = duel()
    sim.pos[0, 1] = [8.0, 0.0, 0.0]
    sim.combat.add_effect(0, 0, I.FIRE_RESISTANCE, 0, 200)
    sim.combat.ignite(np.array([0]), 0, np.array([100]))
    for _ in range(60):
        sim._tick(idle(sim), first=True)
    assert sim.hp[0, 0] == C.MAX_HEALTH


def test_weaker_longer_effect_resumes_after_the_stronger_one():
    sim = duel()
    sim.pos[0, 1] = [8.0, 0.0, 0.0]
    sim.combat.add_effect(0, 0, I.SPEED, 0, 50)
    sim.combat.add_effect(0, 0, I.SPEED, 1, 10)
    assert sim.combat.effect_amp[0, 0, I.SPEED] == 1
    for _ in range(11):
        sim._tick(idle(sim), first=True)
    assert sim.combat.effect_amp[0, 0, I.SPEED] == 0
    assert sim.combat.effect_time[0, 0, I.SPEED] > 0


def test_fire_aspect_ignites_for_80_ticks_a_level():
    sim = duel(Kit(fire_aspect=2))
    swing(sim)
    assert sim.combat.fire[0, 1] == 160


def test_fire_protection_shortens_burning():
    sim = duel(Kit(fire_protection=(1, 1, 0, 0)))
    sim.combat.ignite(np.array([0]), 0, np.array([100]))
    assert sim.combat.fire[0, 0] == 70


def test_saturated_regen_heals_every_ten_ticks():
    sim = duel(hunger=True, natural_regen=True)
    sim.pos[0, 1] = [8.0, 0.0, 0.0]
    sim.hp[0, 0] = 10.0
    for _ in range(10):
        sim._tick(idle(sim), first=True)
    assert sim.hp[0, 0] == pytest.approx(10.0 + 5.0 / 6.0)
    assert sim.combat.exhaustion[0, 0] == pytest.approx(5.0)


def test_slow_regen_needs_18_food():
    sim = duel(hunger=True, natural_regen=True)
    sim.pos[0, 1] = [8.0, 0.0, 0.0]
    sim.hp[0, 0] = 10.0
    sim.combat.food[0] = 18
    sim.combat.saturation[0] = 0.0
    for _ in range(80):
        sim._tick(idle(sim), first=True)
    assert sim.hp[0, 0] == pytest.approx(11.0)
    assert sim.combat.exhaustion[0, 0] == pytest.approx(6.0)


def test_natural_regen_switch_off_keeps_health():
    sim = duel(hunger=True, natural_regen=False)
    sim.pos[0, 1] = [8.0, 0.0, 0.0]
    sim.hp[0, 0] = 10.0
    for _ in range(100):
        sim._tick(idle(sim), first=True)
    assert sim.hp[0, 0] == 10.0


def test_exhaustion_spends_saturation_then_food():
    sim = duel(hunger=True)
    sim.pos[0, 1] = [8.0, 0.0, 0.0]
    sim.combat.exhaustion[0, 0] = 4.5
    sim.combat.saturation[0, 0] = 1.0
    sim._tick(idle(sim), first=True)
    assert sim.combat.saturation[0, 0] == 0.0
    assert sim.combat.food[0, 0] == 20
    sim.combat.exhaustion[0, 0] = 4.5
    sim._tick(idle(sim), first=True)
    assert sim.combat.food[0, 0] == 19


def test_starvation_stops_at_one_health():
    sim = duel(hunger=True)
    sim.pos[0, 1] = [8.0, 0.0, 0.0]
    sim.hp[0, 0] = 2.0
    sim.combat.food[0, 0] = 0
    sim.combat.saturation[0, 0] = 0.0
    for _ in range(400):
        sim._tick(idle(sim), first=True)
    assert sim.hp[0, 0] == 1.0


def test_armor_wears_and_a_broken_piece_stops_counting():
    sim = duel(Kit(armor=full_set("diamond")))
    sim.combat.armor_left[0, 0] = [1, 500, 500, 500]
    sim.combat.hurt_one(0, 0, 9.0, I.MELEE)
    assert sim.combat.armor_left[0, 0, 0] == 0
    assert sim.combat.armor_left[0, 0, 1] == 498
    assert sim.combat.armor[0, 0] == 17.0
    assert sim.combat.toughness[0, 0] == 6.0


def test_weapon_wears_and_breaks_to_fist_damage():
    sim = duel()
    sim.weapon[0, 0] = C.AXE
    sim.combat.weapon_left[0, 0, C.AXE] = 2
    swing(sim)
    assert sim.combat.weapon_left[0, 0, C.AXE] == 0
    assert sim.combat.weapon_damage[0, 0, C.AXE] == I.FIST_DAMAGE


def test_shield_needs_the_item():
    sim = duel(Kit(shield=False))
    a = idle(sim)
    a[0, 1, A.USE] = 1
    for _ in range(C.SHIELD_RAISE_TICKS + 1):
        sim._tick(a, first=True)
    assert sim.shield_ticks[0, 1] == 0


def test_blocked_sprint_hit_keeps_sprint():
    sim = duel()
    sim.sprinting[0, 0] = True
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    swing(sim)
    assert sim.sprinting[0, 0]


def test_weak_sprint_hit_keeps_sprint_and_has_no_bonus():
    sim = duel()
    sim.sprinting[0, 0] = True
    sim.attack_ticks[0, 0] = 2.0
    sim._melee(np.array([[True, False]]))
    assert sim.sprinting[0, 0]
    assert sim.vel[0, 1, 2] == pytest.approx(0.4)


@pytest.mark.parametrize("model,scale", [("vanilla", 0.6), ("mineflayer", 1.0)])
def test_attacker_slowdown_depends_on_client(model, scale):
    sim = duel(client_model=model)
    sim.sprinting[0, 0] = True
    sim.vel[0, 0] = [0.0, 0.0, 0.2]
    swing(sim)
    assert sim.vel[0, 0, 2] == pytest.approx(0.2 * scale)


def test_sprint_hit_is_two_pushes():
    sim = duel()
    sim.sprinting[0, 0] = True
    swing(sim)
    assert sim.vel[0, 1] == pytest.approx(np.array([0.0, 0.4, 0.7]))
    assert not sim.sprinting[0, 0]


def test_first_push_follows_positions_and_second_follows_the_view():
    sim = duel()
    sim.yaw[0, 0] = -6.0
    sim.sprinting[0, 0] = True
    swing(sim)
    assert sim.vel[0, 1] == pytest.approx(np.array([0.0523, 0.4, 0.6973]), abs=1e-3)


def test_knockback_starts_from_the_server_copy():
    sim = duel()
    sim.vel[0, 1] = [0.0, 0.0, -0.3]
    sim.combat.server_vel[0, 1] = 0.0
    swing(sim)
    assert sim.vel[0, 1] == pytest.approx(np.array([0.0, 0.4, 0.4]))
    assert sim.combat.server_vel[0, 1] == pytest.approx(np.zeros(3))


def test_airborne_victim_keeps_vertical_speed():
    sim = duel()
    sim.on_ground[0, 1] = False
    sim.combat.server_ground[0, 1] = False
    sim.combat.server_vel[0, 1] = [0.0, 0.25, 0.0]
    swing(sim)
    assert sim.vel[0, 1] == pytest.approx(np.array([0.0, 0.25, 0.4]))


def test_knockback_enchant_adds_its_named_strength():
    sim = duel(Kit(knockback=2))
    swing(sim)
    expected = 0.4 / 2.0 + 2.0 * CB.KNOCKBACK_ENCHANT_STRENGTH
    assert sim.vel[0, 1, 2] == pytest.approx(expected)


@pytest.mark.parametrize("height,damage", [(3.0, 0.0), (4.0, 1.0), (8.0, 5.0), (12.0, 9.0)])
def test_fall_damage_at_whole_heights(height, damage):
    assert CB.fall_damage(np.array(height)) == damage
    sim = duel(Kit(armor=full_set("diamond")))
    sim.pos[0, 0] = [0.0, height, 0.0]
    sim.pos[0, 1] = [8.0, 0.0, 0.0]
    sim.on_ground[0, 0] = False
    sim.combat.server_ground[0, 0] = False
    for _ in range(80):
        sim._tick(idle(sim), first=True)
        if sim.on_ground[0, 0]:
            break
    assert C.MAX_HEALTH - sim.hp[0, 0] == pytest.approx(damage)


def test_netherite_resists_knockback():
    sim = duel(Kit(), Kit(armor=full_set("netherite")))
    sim.combat.kit_id[0] = [0, 1]
    sim.reset()
    sim.pos[0, 0], sim.pos[0, 1] = [0.0, 0.0, 0.0], [0.0, 0.0, 2.0]
    sim.yaw[0] = [0.0, 180.0]
    swing(sim)
    assert sim.vel[0, 1, 2] == pytest.approx(0.4 * 0.6)


def test_knockback_is_delayed_when_configured():
    sim = duel(knockback_delay=1)
    swing(sim)
    assert sim.vel[0, 1, 2] == 0.0
    sim._tick(idle(sim), first=False)
    assert sim.pos[0, 1, 2] == pytest.approx(2.0)
    sim._tick(idle(sim), first=False)
    assert sim.pos[0, 1, 2] == pytest.approx(2.4)


def test_hit_on_a_dead_target_is_skipped():
    sim = duel()
    sim.hp[0, 1] = 0.0
    swing(sim)
    assert sim.events["hits"][0, 0] == 0


def test_dying_attacker_still_lands_the_last_hit():
    sim = duel()
    sim.hp[0] = [1.0, 1.0]
    sim.yaw[0] = [0.0, 180.0]
    sim.attack_ticks[0] = 1000.0
    sim._melee(np.array([[True, True]]))
    assert (sim.hp[0] <= 0.0).all()


def test_sneaking_lowers_eye_and_box():
    sim = duel()
    sim.combat.sneaking[0, 1] = True
    _low, high = sim.combat.body_boxes()
    assert high[0, 1, 1] == pytest.approx(1.5)
    sim.combat.sneaking[0, 0] = True
    assert sim.combat.eye_position(0, 0)[1] == pytest.approx(1.27)


def test_aim_uses_the_delayed_position():
    sim = duel(aim_delay=2)
    sim.combat._history[:] = sim.pos
    sim.pos[0, 1] = [2.0, 0.0, 2.0]
    swing(sim)
    assert sim.events["hits"][0, 0] == 1


def test_delayed_aim_is_refused_past_the_server_reach():
    sim = duel(aim_delay=2)
    sim.combat._history[:] = sim.pos
    sim.pos[0, 1] = [9.0, 0.0, 2.0]
    swing(sim)
    assert sim.events["hits"][0, 0] == 0


def test_second_click_swings_on_the_later_tick():
    sim = duel()
    sim.attack_ticks[0, 0] = 1000.0
    sim.combat.second_click[0, 0] = True
    sim._tick(idle(sim), first=False)
    assert sim.events["swings"][0, 0] == 1


def test_kits_are_sampled_with_uneven_rounds():
    sim = Sim(400, SimConfig(kits=("iron", "diamond", "uhc"), uneven_rate=1.0 / 3.0), seed=3)
    sim.reset()
    differ = (sim.combat.kit_id[:, 0] != sim.combat.kit_id[:, 1]).mean()
    assert 0.1 < differ < 0.35


def test_uhc_kit_contents():
    sim = Sim(1, SimConfig.uhc())
    count = sim.items.count[0, 0]
    assert count[I.GOLDEN_APPLE] == 8
    assert count[I.WATER_BUCKET] == 4
    assert count[I.LAVA_BUCKET] == 2
    assert count[I.COBWEB] == 8
    assert count[I.PEARL] == 2
    assert count[I.ROD] == 1
    assert count[I.BLOCK] == 64
    assert sim.combat.protection[0, 0, I.MELEE] == 8.0
    assert sim.combat.weapon_sharpness[0, 0, C.SWORD] == pytest.approx(1.5)
    distance = np.linalg.norm(sim.pos[0, 0] - sim.pos[0, 1])
    assert 24.0 <= distance <= 28.0


def test_wooden_weapons_use_their_own_stats():
    sim = duel(Kit(sword="wooden", axe="wooden"))
    sim.weapon[0, 0] = C.AXE
    assert sim.combat.attack_speed()[0, 0] == 0.8
    swing(sim)
    assert C.MAX_HEALTH - sim.hp[0, 1] == pytest.approx(7.0)


def test_empty_kit_picks_up_the_ground_axe():
    sim = Sim(1, SimConfig(kits=("empty",)))
    sim.pos[0, 0] = [5.0, 0.0, 0.0]
    sim.pos[0, 1] = [-5.0, 0.0, 0.0]
    assert sim.combat.weapon_damage[0, 0, C.AXE] == I.FIST_DAMAGE
    sim._tick(idle(sim), first=True)
    assert sim.items.ground_on[0]
    sim.pos[0, 0] = [0.5, 0.0, 0.0]
    sim._tick(idle(sim), first=True)
    assert not sim.items.ground_on[0]
    assert sim.combat.weapon_damage[0, 0, C.AXE] == I.AXES["wooden"]
    assert sim.combat.weapon_speed[0, 0, C.AXE] == I.AXE_SPEED["wooden"]
    assert sim.combat.weapon_damage[0, 1, C.AXE] == I.FIST_DAMAGE


def test_speed_multiplier_adds_twenty_percent_a_level():
    sim = duel()
    sim.combat.add_effect(0, 0, I.SPEED, 1, 100)
    assert sim.combat.speed_multiplier()[0].tolist() == pytest.approx([1.4, 1.0])


def test_env_uses_round_rules_when_given():
    pool = OpponentPool(2, seed=1, max_ticks=600)
    env = ArenaVecEnv(2, pool, SimConfig(), round_rules=CB.RoundRules(no_damage_ticks=4), seed=1)
    env.sim.ticks[:] = [3, 4]
    assert env._terminal()[1].tolist() == [False, True]


def test_shield_cooldown_can_carry_across_rounds():
    sim = duel(keep_shield_cooldown=True)
    sim.shield_disabled[0, 1] = 50
    sim.reset()
    assert sim.shield_disabled[0, 1] == 50


def test_round_rules():
    rules = CB.RoundRules()
    hp = np.array([[20.0, 20.0], [5.0, 6.0], [5.0, 6.0]])
    ticks = np.array([2400, 2400, 3600])
    last = np.array([2300, 2300, 3500])
    assert CB.round_timeout(rules, ticks, last, hp).tolist() == [True, False, True]
    quiet = CB.round_timeout(rules, np.array([1200]), np.array([0]), np.array([[20.0, 20.0]]))
    assert quiet.tolist() == [True]


def test_round_starts_with_full_food_and_five_saturation():
    sim = Sim(2, SimConfig(hunger=True))
    assert (sim.combat.food == 20).all()
    assert (sim.combat.saturation == 5.0).all()
    assert (sim.combat.exhaustion == 0.0).all()


@pytest.mark.parametrize("level", [1, 3])
def test_unbreaking_thins_weapon_wear(level):
    sim = Sim(1, SimConfig(kits=(Kit(unbreaking=level),)), seed=4)
    sim.weapon[0, 0] = C.SWORD
    start = int(sim.combat.weapon_left[0, 0, C.SWORD])
    for _ in range(1200):
        sim.combat._wear_weapon(np.array([0]), 0)
    spent = start - int(sim.combat.weapon_left[0, 0, C.SWORD])
    assert spent / 1200 == pytest.approx(1.0 / (level + 1.0), abs=0.05)
