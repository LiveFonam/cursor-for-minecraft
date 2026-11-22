"""The named fight setups: the default stays as it was, and diamond_20 holds the game's real values."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter import evolve as E
from fighter import items as I
from fighter.behaviour import measure
from fighter.campaign import FIGHTER, Runtime, make_runner, prepare_config, read_config
from fighter.combat import shield_wear
from fighter.experts import expert_interface
from fighter.lean import EnvSpec, FIGHT
from fighter.plans import PLANS
from fighter.policy import NumpyPolicy
from fighter.sim import FIGHT_SETUPS, Sim, SimConfig
from test_arena import TINY, fake_run, fast_opponents, small_config

DATA = json.loads((Path(__file__).parent / "data" / "recorded_combat.json").read_text())
DAMAGE_TOLERANCE = 1e-4
SETUP = "diamond_20"

# Read from the classes of the 1.21.11 game: armor material, tool material, combat rules and item data
ARMOR_POINTS = (3, 8, 6, 3)
ARMOR_TOUGHNESS_EACH = 2.0
ARMOR_DURABILITY = (363, 528, 495, 429)
TOOL_DURABILITY = 1561
SHIELD_DURABILITY = 336
BOW_DURABILITY = 384
AXE_DAMAGE, AXE_SPEED = 9.0, 1.0
SWORD_DAMAGE, SWORD_SPEED = 7.0, 1.6
AXE_WEAR, SWORD_WEAR = 2, 1
SHIELD_DISABLE_TICKS = 100
ARROWS = 6
ARENA_HALF = 10.0


def duel(weapon=C.AXE):
    sim = Sim(1, SimConfig.for_setup(SETUP), seed=0)
    sim.pos[0, 0] = [0.0, 0.0, 0.0]
    sim.pos[0, 1] = [0.0, 0.0, 2.0]
    sim.yaw[0] = [0.0, 180.0]
    sim.weapon[0] = weapon
    return sim


def swing(sim):
    sim.attack_ticks[0, 0] = 1000.0
    mask = np.zeros((1, 2), dtype=bool)
    mask[0, 0] = True
    sim._melee(mask)


def test_the_default_setup_is_the_plain_config():
    assert SimConfig.for_setup() == SimConfig()
    assert FIGHT_SETUPS["standard"] == {}
    plain = SimConfig()
    assert (plain.armor, plain.arena_half, plain.kits, plain.start_arrows) == ("iron", 12.0, None, 6)


def test_the_default_setup_plays_the_same_fight_as_the_plain_config():
    one, two = Sim(8, SimConfig(), seed=3), Sim(8, SimConfig.for_setup("standard"), seed=3)
    rng = np.random.default_rng(1)
    for _ in range(30):
        actions = rng.integers(0, A.NVEC, size=(8, 2, len(A.NVEC)))
        actions[..., A.USE] = 0
        one.step(actions)
        two.step(actions)
    np.testing.assert_array_equal(one.pos, two.pos)
    np.testing.assert_array_equal(one.hp, two.hp)


def test_an_unknown_setup_is_refused():
    with pytest.raises(ValueError):
        SimConfig.for_setup("gold")


def test_the_kit_holds_the_real_armor_values():
    sim = duel()
    kit = sim.combat.kits[0]
    assert kit == I.Kit(armor=I.full_set("diamond"))
    assert tuple(I.ARMOR_POINTS["diamond"]) == ARMOR_POINTS
    assert I.ARMOR_TOUGHNESS["diamond"] == ARMOR_TOUGHNESS_EACH
    assert sim.combat.armor[0, 0] == sum(ARMOR_POINTS) == 20
    assert sim.combat.toughness[0, 0] == 4 * ARMOR_TOUGHNESS_EACH == 8.0
    assert tuple(int(v) for v in sim.combat.armor_left[0, 0]) == ARMOR_DURABILITY


def test_the_kit_holds_the_real_weapons_and_no_enchantments():
    sim = duel()
    kit = sim.combat.kits[0]
    assert (kit.sword, kit.axe, kit.shield, kit.arrows) == ("diamond", "diamond", True, ARROWS)
    assert (kit.sharpness, kit.power, kit.punch, kit.knockback, kit.unbreaking) == (0, 0, 0, 0, 0)
    assert sum(kit.protection) == 0 and not kit.stock
    assert sim.combat.weapon_damage[0, 0, C.AXE] == AXE_DAMAGE
    assert sim.combat.weapon_damage[0, 0, C.SWORD] == SWORD_DAMAGE
    assert sim.combat.weapon_speed[0, 0, C.AXE] == AXE_SPEED
    assert sim.combat.weapon_speed[0, 0, C.SWORD] == SWORD_SPEED
    assert sim.combat.weapon_left[0, 0, C.AXE] == sim.combat.weapon_left[0, 0, C.SWORD] == TOOL_DURABILITY
    assert sim.combat.shield_left[0, 0] == SHIELD_DURABILITY
    assert sim.combat.bow_left[0, 0] == BOW_DURABILITY
    assert sim.ammo[0, 0] == ARROWS
    assert sim.combat.has_shield[0, 0] and sim.combat.has_bow[0, 0]


@pytest.mark.parametrize(
    "case",
    [c for c in DATA["hits"] if (c["armor"], c["material"]) == ("diamond", "diamond")],
    ids=lambda c: c["name"],
)
def test_a_hit_on_the_kit_matches_the_real_server(case):
    sim = duel(C.AXE if case["weapon"] == "axe" else C.SWORD)
    swing(sim)
    assert sim.last_damage[0, 1] == pytest.approx(case["raw"], abs=DAMAGE_TOLERANCE)
    assert C.MAX_HEALTH - sim.hp[0, 1] == pytest.approx(case["final"], abs=DAMAGE_TOLERANCE)


@pytest.mark.parametrize("raw,cost", sorted({(c["raw"], c["cost"]) for c in DATA["shield_wear"]}))
def test_shield_wear_matches_the_real_server(raw, cost):
    assert shield_wear(np.array([raw]))[0] == cost


def test_an_axe_hit_disables_the_kit_shield_for_the_real_time():
    assert {c["ticks"] for c in DATA["disable"] if c["weapon"] == "axe"} == {SHIELD_DISABLE_TICKS}
    sim = duel(C.AXE)
    sim.shield_ticks[0, 1] = C.SHIELD_RAISE_TICKS
    swing(sim)
    assert sim.shield_disabled[0, 1] == SHIELD_DISABLE_TICKS
    assert sim.hp[0, 1] == C.MAX_HEALTH


def test_a_hit_wears_each_armor_piece_by_a_quarter_of_the_damage():
    sim = duel(C.AXE)
    swing(sim)
    worn = np.array(ARMOR_DURABILITY) - sim.combat.armor_left[0, 1]
    assert worn.tolist() == [2, 2, 2, 2]  # floor(9 / 4)
    sim = duel(C.SWORD)
    swing(sim)
    assert (np.array(ARMOR_DURABILITY) - sim.combat.armor_left[0, 1]).tolist() == [1, 1, 1, 1]


def test_a_landed_hit_wears_the_weapon_by_the_real_amount():
    sim = duel(C.AXE)
    swing(sim)
    assert TOOL_DURABILITY - sim.combat.weapon_left[0, 0, C.AXE] == AXE_WEAR
    sim = duel(C.SWORD)
    swing(sim)
    assert TOOL_DURABILITY - sim.combat.weapon_left[0, 0, C.SWORD] == SWORD_WEAR


def test_the_arena_is_20_blocks_wide():
    assert SimConfig.for_setup(SETUP).arena_half == ARENA_HALF
    sim = Sim(64, SimConfig.for_setup(SETUP), seed=5)
    for _ in range(20):
        sim.reset()
        assert np.abs(sim.pos[..., [0, 2]]).max() <= ARENA_HALF - C.PLAYER_WIDTH / 2.0
    sim = Sim(1, SimConfig.for_setup(SETUP), seed=0)
    sim.pos[0, 0] = [9.0, 0.0, 0.0]
    sim.pos[0, 1] = [-9.0, 0.0, 0.0]
    sim.yaw[0] = [-90.0, 90.0]  # seat 0 walks toward +x
    a = A.neutral_actions(np.full((1, 2), C.AXE))
    a[0, 0, A.FORWARD] = A.KEY_FORWARD
    for _ in range(30):
        sim.step(a)
    assert sim.pos[0, 0, 0] == pytest.approx(ARENA_HALF - C.PLAYER_WIDTH / 2.0, abs=1e-6)


def test_training_arenas_use_the_setup_only_when_asked():
    plain = EnvSpec(FIGHT, 2, 0, False, "combo").build()
    assert (plain.sim.cfg.armor, plain.sim.cfg.arena_half) == ("iron", 12.0)
    env = EnvSpec(FIGHT, 2, 0, False, "combo", (), SETUP).build()
    assert (env.sim.cfg.armor, env.sim.cfg.arena_half) == ("diamond", ARENA_HALF)
    assert env.sim.cfg.ready_gate == PLANS["combo"].ready_gate
    assert env.sim.border_half == ARENA_HALF


def test_the_trainer_builds_the_setup(tmp_path):
    root = tmp_path / "run"
    prepare_config(root, {**TINY, "plan": "combo", "arena": True, "fight_setup": SETUP})
    cfg = read_config(root)
    assert cfg.fight_setup == SETUP
    (root / FIGHTER).mkdir()
    runner = make_runner(cfg, FIGHTER, root / FIGHTER, Runtime(threads=1, min_free_gb=0.0, fighter_device="cpu"))
    try:
        sim = runner.trainer.host.local.env.sim
        assert (sim.cfg.armor, sim.cfg.arena_half) == ("diamond", ARENA_HALF)
    finally:
        runner.close()


def test_a_saved_campaign_without_the_field_stays_standard(tmp_path):
    root = tmp_path / "old"
    prepare_config(root, TINY)
    saved = json.loads((root / "campaign.json").read_text())
    del saved["fight_setup"]
    (root / "campaign.json").write_text(json.dumps(saved))
    assert read_config(root).fight_setup == "standard"


def test_measure_plays_in_the_setup(monkeypatch):
    seen = {}
    real = SimConfig.for_setup

    def spy(name="standard", **settings):
        seen["name"] = name
        return real(name, **settings)

    monkeypatch.setattr(SimConfig, "for_setup", staticmethod(spy))
    plan = PLANS["combo"]
    interface = expert_interface(600, stance=plan.stance)
    row = measure(NumpyPolicy.random(seed=1), "walker", interface, plan, 11, n_envs=2, games_per_arena=1, fight_setup=SETUP)
    assert seen["name"] == SETUP and row["games"] == 2


def test_evolution_trains_and_tests_children_in_the_setup(tmp_path, monkeypatch):
    fast_opponents(monkeypatch)
    root = tmp_path / "evo"
    root.mkdir()
    parent = fake_run(tmp_path / "parent", "combo", seed=1, blocker=True)
    cfg = small_config([parent], fight_setup=SETUP, controls=1)
    played, trained = [], []
    real_measure, real_build = E.measure, EnvSpec.build

    def spy(*args, **kwargs):
        played.append(kwargs.get("fight_setup"))
        return real_measure(*args, **kwargs)

    def build(spec):
        trained.append(spec.fight_setup)
        return real_build(spec)

    monkeypatch.setattr(E, "measure", spy)
    monkeypatch.setattr(EnvSpec, "build", build)
    driver = E.Evolution(root, cfg, E.EvolveRuntime(threads=1, min_free_gb=0.0))
    assert driver.run() == 0
    assert played and set(played) == {SETUP}
    assert trained and set(trained) == {SETUP}
    for member in ("g00-00", "g01-00"):
        assert read_config(driver.folder(member)).fight_setup == SETUP
    assert all(json.loads(line)["key"] for line in (root / "matches.jsonl").read_text().splitlines())


def test_a_saved_evolution_refuses_another_setup(tmp_path):
    root = tmp_path / "evo"
    E.prepare(root, {"parents": ["/nowhere"], "fight_setup": SETUP})
    assert E.prepare(root, {"fight_setup": SETUP}).fight_setup == SETUP
    with pytest.raises(SystemExit):
        E.prepare(root, {"fight_setup": "standard"})


def test_an_evolution_saved_before_the_setting_stays_standard(tmp_path):
    root = tmp_path / "evo"
    E.prepare(root, {"parents": ["/nowhere"]})
    saved = json.loads((root / "evolve.json").read_text())
    del saved["fight_setup"]
    (root / "evolve.json").write_text(json.dumps(saved))
    assert E.prepare(root, {}).fight_setup == "standard"
    with pytest.raises(SystemExit):
        E.prepare(root, {"fight_setup": SETUP})


def test_a_new_evolution_refuses_an_unknown_setup(tmp_path):
    with pytest.raises(SystemExit):
        E.prepare(tmp_path / "evo", {"parents": ["/nowhere"], "fight_setup": "gold"})


def test_the_command_line_takes_the_setup():
    args = E.build_parser().parse_args(["run", "--out", "x", "--parents", "a", "--fight-setup", SETUP])
    assert args.fight_setup == SETUP
    with pytest.raises(SystemExit):
        E.build_parser().parse_args(["run", "--out", "x", "--fight-setup", "gold"])
    assert E.build_parser().parse_args(["run", "--out", "x"]).fight_setup is None
