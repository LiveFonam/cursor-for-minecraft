"""Bow, crossbow and arrow physics, replayed against recorded server shots."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest
from world_helpers import FLOOR, flat_raw, make, yi

from fighter import actions as A
from fighter import arrows as R
from fighter import constants as C
from fighter.drills import ShootingDrill
from fighter.env import ArenaVecEnv
from fighter.obs import intercept_angles
from fighter.opponents import OpponentPool
from fighter.sim import Sim, SimConfig, bow_speed, look_vectors
from fighter.world import blocks as B

DATA = json.loads((Path(__file__).parent / "data" / "recorded_arrows.json").read_text())
SHOTS = DATA["shots"]
CARRY_TOLERANCE = 0.025
FIRED = [s for s in SHOTS if s["fired"]]

PATH_TOLERANCE = 1e-3
CONTACT_TOLERANCE = 1e-5
SPREAD_STD = R.LAUNCH_SPREAD / math.sqrt(6.0)
FAR = 400.0


class NoSpread:
    """A random source that centers the launch spread."""

    def random(self, shape):
        return np.full(shape, 0.5)

    def integers(self, low, high=None, size=None):
        return np.zeros_like(high if size is None else np.empty(size), dtype=np.int64)


def idle(sim):
    return np.stack(
        [A.neutral_actions(sim.weapon[:, seat].copy()) for seat in (0, 1)], axis=1
    )


def holding(sim, weapon, use):
    a = idle(sim)
    a[:, 0, A.WEAPON] = A.WEAPON_ACTION[weapon]
    a[:, 0, A.USE] = use
    return a


def open_sim(n=1, seed=0, **config):
    settings = {"armor": "none", "arena_half": FAR}
    settings.update(config)
    sim = Sim(n, SimConfig(**settings), seed=seed)
    sim.pos[:, 0] = [0.5, 0.0, 0.5]
    sim.pos[:, 1] = [100.5, 0.0, 100.5]
    sim.yaw[:] = 0.0
    sim.pitch[:] = 0.0
    return sim


def pose(sim, shot):
    x, y, z, yaw, pitch = shot["shooter"]
    sim.pos[:, 0] = [x, y, z]
    sim.yaw[:, 0] = yaw
    sim.pitch[:, 0] = pitch
    tx, ty, tz, target_yaw = shot["target"]
    sim.pos[:, 1] = [tx, ty, tz]
    sim.yaw[:, 1] = target_yaw


def inject(sim, state, age=1, crit=False, slot=0):
    sim.arrow_on[:, slot] = True
    sim.arrow_pos[:, slot] = state[:3]
    sim.arrow_vel[:, slot] = state[3:]
    sim.arrow_owner[:, slot] = 0
    sim.arrow_age[:, slot] = age
    sim.arrow_crit[:, slot] = crit
    sim.arrow_bounced[:, slot] = False
    sim.arrow_pickup[:, slot] = True


def release_shot(sim, weapon, hold):
    sim.weapon[:, 0] = weapon
    for _ in range(hold):
        sim._tick(holding(sim, weapon, 1), first=True)
    sim._tick(holding(sim, weapon, 0), first=True)


def test_recording_covers_every_group():
    groups = {s["group"] for s in SHOTS}
    assert groups == {"draw", "hit", "shield_block", "stuck_pickup", "crossbow_charge", "crossbow_hit"}
    assert len(FIRED) >= 140


@pytest.mark.parametrize("hold", sorted({s["hold"] for s in SHOTS if s["group"] == "draw"}))
def test_recorded_bow_draws_fire_from_three_ticks(hold):
    recorded = {s["fired"] for s in SHOTS if s["group"] == "draw" and s["hold"] == hold}
    assert len(recorded) == 1
    sim = open_sim()
    release_shot(sim, C.BOW, hold)
    assert bool(sim.events["arrows_fired"][0, 0]) == recorded.pop()


def test_recorded_critical_needs_a_full_draw():
    for shot in (s for s in FIRED if s["group"] == "draw"):
        assert shot["crit"] == (shot["hold"] >= C.BOW_FULL_DRAW_TICKS)


def test_recorded_crossbow_load_time():
    for row in DATA["crossbow_loads"]:
        sim = open_sim()
        sim.weapon[:, 0] = C.CROSSBOW
        for _ in range(row["hold"]):
            sim._tick(holding(sim, C.CROSSBOW, 1), first=True)
        assert bool(sim.loaded[0, 0]) == row["loaded_on_first_hold"]


def test_recorded_launch_within_the_spread():
    for shot in (s for s in FIRED if s["group"] == "draw"):
        sim = open_sim()
        sim.rng = NoSpread()
        pose(sim, shot)
        release_shot(sim, C.BOW, shot["hold"])
        assert sim.arrow_on[0, 0]
        speed = float(bow_speed(np.array(float(shot["hold"]))))
        bound = R.LAUNCH_SPREAD * speed + 1e-4
        recorded = np.array(shot["path"][0])
        assert np.abs(sim.arrow_vel[0, 0] - recorded[3:]).max() <= bound
        assert np.abs(sim.arrow_pos[0, 0] - recorded[:3]).max() <= bound


def test_recorded_spawn_point_is_below_the_eye():
    for shot in FIRED:
        if not shot["path"]:
            continue
        first = np.array(shot["path"][0])
        launch = (first[3:] + [0.0, C.ARROW_GRAVITY, 0.0]) / C.ARROW_DRAG
        spawn = first[:3] - launch
        x, y, z = shot["shooter"][:3]
        assert spawn == pytest.approx([x, y + C.EYE_HEIGHT - R.SPAWN_BELOW_EYE, z], abs=1e-4)


def test_recorded_spread_size():
    residuals = []
    for shot in FIRED:
        if shot["group"] != "draw" and not shot["group"].startswith("crossbow"):
            continue
        if not shot["path"]:
            continue
        first = np.array(shot["path"][0])
        launch = (first[3:] + [0.0, C.ARROW_GRAVITY, 0.0]) / C.ARROW_DRAG
        nominal = (
            C.CROSSBOW_SPEED if shot["weapon"] == "crossbow" else float(bow_speed(np.array(float(shot["hold"]))))
        )
        look = look_vectors(np.array(shot["shooter"][3]), np.array(shot["shooter"][4]))
        residuals.append(launch / nominal - look)
    residuals = np.array(residuals)
    assert len(residuals) >= 90
    assert np.abs(residuals).max() <= R.LAUNCH_SPREAD
    assert residuals.std() == pytest.approx(SPREAD_STD, rel=0.15)


def test_recorded_flight_paths():
    worst = 0.0
    for shot in FIRED:
        path = shot["path"]
        end = shot["strike"]["after"] if "strike" in shot else len(path)
        if end < 2:
            continue
        sim = open_sim()
        pose(sim, shot)
        inject(sim, path[0])
        for row in path[1:end]:
            sim._step_arrows()
            assert sim.arrow_on[0, 0]
            worst = max(worst, float(np.abs(sim.arrow_pos[0, 0] - row[:3]).max()))
            worst = max(worst, float(np.abs(sim.arrow_vel[0, 0] - row[3:]).max()))
    assert 0.0 < worst <= PATH_TOLERANCE


def test_recorded_landings():
    checked = 0
    for shot in FIRED:
        if "stuck" not in shot or not shot["path"] or "strike" in shot and not shot["strike"]["blocked"]:
            continue
        sim = open_sim()
        pose(sim, shot)
        sim.pos[:, 1] = [100.5, 0.0, 100.5]
        inject(sim, shot["path"][-1])
        sim._step_arrows()
        assert not sim.arrow_on[0, 0]
        assert sim.stuck_on[0, 0]
        assert sim.stuck_pos[0, 0] == pytest.approx(shot["stuck"], abs=CONTACT_TOLERANCE)
        checked += 1
    assert checked >= 90


def test_recorded_blocked_arrows_turn_back():
    blocked = [s for s in FIRED if s.get("strike", {}).get("blocked")]
    assert len(blocked) == 8
    for shot in blocked:
        sim = open_sim()
        pose(sim, shot)
        sim.shield_ticks[:, 1] = C.SHIELD_RAISE_TICKS
        inject(sim, shot["path"][0], crit=True)
        for row in shot["path"][1:]:
            sim._step_arrows()
            assert sim.arrow_on[0, 0]
            assert sim.arrow_pos[0, 0] == pytest.approx(row[:3], abs=CONTACT_TOLERANCE)
            assert sim.arrow_vel[0, 0] == pytest.approx(row[3:], abs=CONTACT_TOLERANCE)
        assert sim.events["arrows_blocked"][0, 1] == 1
        assert sim.hp[0, 1] == C.MAX_HEALTH
        assert sim.hurt_timer[0, 1] > 0
        assert sim.last_damage[0, 1] == 0.0
        assert sim.vel[0, 1, 2] > 0.0
        sim._step_arrows()
        assert sim.stuck_on[0, 0]
        assert sim.stuck_pos[0, 0] == pytest.approx(shot["stuck"], abs=CONTACT_TOLERANCE)


def test_recorded_hits_land_on_the_recorded_tick_with_recorded_damage():
    hits = [s for s in FIRED if "strike" in s and not s["strike"]["blocked"]]
    assert len(hits) >= 30
    copies = 64
    for shot in hits:
        sim = open_sim(copies, seed=len(shot["path"]))
        pose(sim, shot)
        inject(sim, shot["path"][0], crit=shot["crit"])
        for _ in range(shot["strike"]["after"] - 1):
            sim._step_arrows()
            assert sim.arrow_on[:, 0].all()
        sim._step_arrows()
        assert not sim.arrow_on.any()
        dealt = sim.events["damage_taken"][:, 1]
        base = math.ceil(C.ARROW_BASE_DAMAGE * shot["strike"]["speed"])
        top = base + (base // 2 + 1 if shot["crit"] else 0)
        assert dealt.min() >= base and dealt.max() <= top
        assert base <= shot["strike"]["raw"] <= top


def test_recorded_shake_delays_pickup_by_seven_ticks():
    delayed = [s for s in FIRED if "pickup_after" in s]
    assert len(delayed) == 6
    for shot in delayed:
        assert shot["pickup_after"] == R.SHAKE_TICKS
        assert shot["pickup_dz"] <= R.PICKUP_HALF_WIDTH
        sim = open_sim()
        pose(sim, shot)
        sim.ammo[:] = 0
        inject(sim, shot["path"][-1])
        sim._step_arrows()
        assert sim.stuck_on[0, 0]
        for _ in range(R.SHAKE_TICKS - 1):
            sim._step_arrows()
            assert sim.ammo[0, 1] == 0
        sim._step_arrows()
        assert sim.ammo[0, 1] == 1
        assert sim.ammo[0, 0] == 0
        assert not sim.stuck_on.any()


def test_recorded_arrow_out_of_reach_stays_in_the_ground():
    for shot in (s for s in FIRED if s["group"] == "stuck_pickup"):
        sim = open_sim()
        pose(sim, shot)
        sim.pos[:, 1] = [100.5, 0.0, 100.5]
        sim.stuck_on[0, 0] = True
        sim.stuck_pos[0, 0] = shot["stuck"]
        before = sim.ammo.copy()
        for _ in range(14):
            sim._step_arrows()
        assert sim.stuck_on[0, 0]
        assert (sim.ammo == before).all()
        sim.pos[0, 1, 0] = shot["stuck"][0]
        sim.pos[0, 1, 2] = shot["stuck"][2]
        sim._step_arrows()
        assert not sim.stuck_on.any()
        assert sim.ammo[0, 1] == before[0, 1] + 1


def test_launch_spread_distribution():
    sim = open_sim(4096, seed=3)
    sim.pitch[:] = -30.0
    sim.draw_ticks[:, 0] = C.BOW_FULL_DRAW_TICKS
    mask = np.zeros((sim.n, 2), dtype=bool)
    mask[:, 0] = True
    R.fire(sim, mask, np.full((sim.n, 2), 1.0), np.zeros((sim.n, 2), dtype=bool))
    look = look_vectors(np.array(0.0), np.array(-30.0))
    spread = sim.arrow_vel[:, 0] - look
    assert np.abs(spread).max() <= R.LAUNCH_SPREAD
    assert spread.std(axis=0) == pytest.approx([SPREAD_STD] * 3, rel=0.05)
    assert spread.mean(axis=0) == pytest.approx([0.0] * 3, abs=5e-4)


def test_full_draw_can_exceed_three_blocks_per_tick():
    sim = open_sim(4096, seed=1)
    mask = np.zeros((sim.n, 2), dtype=bool)
    mask[:, 0] = True
    speed = np.full((sim.n, 2), C.BOW_MAX_SPEED)
    R.fire(sim, mask, speed, np.ones((sim.n, 2), dtype=bool))
    assert np.linalg.norm(sim.arrow_vel[:, 0], axis=-1).max() > C.BOW_MAX_SPEED


def test_bow_carries_shooter_movement_and_crossbow_does_not():
    for weapon, carries in ((C.BOW, True), (C.CROSSBOW, False)):
        for grounded in (True, False):
            sim = open_sim()
            sim.rng = NoSpread()
            sim.weapon[:, 0] = weapon
            sim.vel[:, 0] = [0.9, 0.9, 0.9]
            sim.body.last_move[:, 0] = [0.2, -0.3, 0.1]
            sim.on_ground[:, 0] = grounded
            mask = np.zeros((1, 2), dtype=bool)
            mask[0, 0] = True
            R.fire(sim, mask, np.full((1, 2), 3.0), np.zeros((1, 2), dtype=bool))
            expected = np.array([0.0, 0.0, 3.0])
            if carries:
                expected += [0.2, 0.0 if grounded else -0.3, 0.1]
            assert sim.arrow_vel[0, 0] == pytest.approx(expected)


@pytest.mark.parametrize("case", DATA["carry"], ids=lambda c: f'{c["weapon"]}_{c["move"]}')
def test_recorded_launch_carries_the_last_move(case):
    sim = open_sim()
    sim.rng = NoSpread()
    sim.weapon[:, 0] = C.BOW if case["weapon"] == "bow" else C.CROSSBOW
    sim.body.last_move[:, 0] = case["moved"]
    sim.on_ground[:, 0] = case["grounded"]
    mask = np.zeros((1, 2), dtype=bool)
    mask[0, 0] = True
    R.fire(sim, mask, np.full((1, 2), 3.0), np.zeros((1, 2), dtype=bool))
    carried = sim.arrow_vel[0, 0] - [0.0, 0.0, 3.0]
    assert carried == pytest.approx(case["extra"], abs=CARRY_TOLERANCE)


def test_walking_shot_carries_one_tick_of_walking():
    sim = open_sim()
    sim.rng = NoSpread()
    sim.cfg.arena_half = 1000.0
    sim.weapon[:, 0] = C.BOW
    sim.pos[:, 1] = [40.0, 0.0, 0.0]
    action = A.neutral_actions(sim.weapon.copy())
    action[0, 0, A.FORWARD] = A.KEY_FORWARD
    for _ in range(40):
        sim._tick(action, first=False)
    before = sim.pos[0, 0].copy()
    sim._tick(action, first=False)
    step = sim.pos[0, 0] - before
    mask = np.zeros((1, 2), dtype=bool)
    mask[0, 0] = True
    R.fire(sim, mask, np.full((1, 2), 3.0), np.zeros((1, 2), dtype=bool))
    assert step[2] == pytest.approx(0.2159, abs=2e-4)
    assert sim.arrow_vel[0, 0, 2] - 3.0 == pytest.approx(step[2])


def test_quiver_is_shared_and_paid_when_each_weapon_commits():
    sim = open_sim()
    assert sim.ammo[0, 0] == R.START_ARROWS
    release_shot(sim, C.BOW, 2)
    assert sim.ammo[0, 0] == R.START_ARROWS
    release_shot(sim, C.BOW, 5)
    assert sim.ammo[0, 0] == R.START_ARROWS - 1
    sim.weapon[:, 0] = C.CROSSBOW
    for _ in range(C.CROSSBOW_LOAD_TICKS - 1):
        sim._tick(holding(sim, C.CROSSBOW, 1), first=True)
    assert sim.ammo[0, 0] == R.START_ARROWS - 1
    sim._tick(holding(sim, C.CROSSBOW, 1), first=True)
    assert sim.loaded[0, 0]
    assert sim.ammo[0, 0] == R.START_ARROWS - 2


def test_empty_quiver_cannot_draw_or_load():
    sim = open_sim()
    sim.ammo[:] = 0
    release_shot(sim, C.BOW, 25)
    assert sim.events["arrows_fired"][0, 0] == 0
    sim.weapon[:, 0] = C.CROSSBOW
    for _ in range(30):
        sim._tick(holding(sim, C.CROSSBOW, 1), first=True)
    assert not sim.loaded[0, 0]
    assert sim.load_ticks[0, 0] == 0


def test_loaded_crossbow_fires_with_an_empty_quiver():
    sim = open_sim()
    sim.weapon[:, 0] = C.CROSSBOW
    sim.loaded[:, 0] = True
    sim.ammo[:] = 0
    sim._tick(holding(sim, C.CROSSBOW, 1), first=True)
    assert sim.events["arrows_fired"][0, 0] == 1


def test_full_side_replaces_its_oldest_arrow():
    sim = open_sim()
    sim.arrow_on[0, : R.ARROWS_PER_SIDE] = True
    sim.arrow_owner[0, : R.ARROWS_PER_SIDE] = 0
    sim.arrow_age[0, : R.ARROWS_PER_SIDE] = [5, 9, 3, 1, 8, 2]
    sim.arrow_pos[0, : R.ARROWS_PER_SIDE] = [0.0, 50.0, 0.0]
    mask = np.zeros((1, 2), dtype=bool)
    mask[0, 0] = True
    R.fire(sim, mask, np.full((1, 2), 3.0), np.zeros((1, 2), dtype=bool))
    assert sim.arrow_on[0].sum() == R.ARROWS_PER_SIDE
    assert sim.arrow_age[0, 1] == 0
    assert sim.arrow_pos[0, 1, 1] == pytest.approx(C.EYE_HEIGHT - R.SPAWN_BELOW_EYE)


def test_sides_keep_separate_flight_slots():
    sim = open_sim()
    sim.arrow_on[0, : R.ARROWS_PER_SIDE] = True
    sim.arrow_owner[0, : R.ARROWS_PER_SIDE] = 0
    mask = np.zeros((1, 2), dtype=bool)
    mask[0, 1] = True
    R.fire(sim, mask, np.full((1, 2), 3.0), np.zeros((1, 2), dtype=bool))
    assert sim.arrow_on[0].sum() == R.ARROWS_PER_SIDE + 1


def test_hit_margin_grows_with_age():
    assert R.hit_margin(np.array([1, 2, 3, 8, 50])) == pytest.approx([0.0, 0.0, 0.05, 0.3, 0.3])


def test_young_arrow_needs_the_bare_box_and_old_arrow_gets_the_margin():
    for age, hits in ((1, False), (10, True)):
        sim = open_sim()
        sim.pos[:, 1] = [0.0, 0.0, 5.0]
        inject(sim, [0.45, 1.0, 3.0, 0.0, 0.0, 3.0], age=age)
        sim._step_arrows()
        assert bool(sim.events["arrow_hits"][0, 0]) == hits


def test_segment_starting_inside_a_box_does_not_enter_it():
    start = np.array([[0.0, 1.0, 0.0]])
    assert np.isinf(
        R.entry_fraction(
            start, np.array([[0.0, 0.0, 1.0]]), np.array([[-1.0, 0.0, -1.0]]), np.array([[1.0, 2.0, 1.0]])
        )
    ).all()


def test_nearer_wall_stops_the_arrow_before_the_player():
    sim = open_sim(arena_half=6.0)
    sim.pos[:, 1] = [0.0, 0.0, 5.9]
    inject(sim, [0.0, 1.0, 5.0, 0.0, 0.0, 3.0], age=10)
    sim.pos[:, 1] = [0.0, 0.0, 7.0]
    sim._step_arrows()
    assert sim.events["arrow_hits"][0, 0] == 0
    assert sim.stuck_pos[0, 0] == pytest.approx([0.0, 1.0, 5.95])


def test_player_in_front_of_the_wall_takes_the_arrow():
    sim = open_sim(arena_half=6.0)
    sim.pos[:, 1] = [0.0, 0.0, 5.6]
    inject(sim, [0.0, 1.0, 4.0, 0.0, 0.0, 3.0], age=2)
    sim._step_arrows()
    assert sim.events["arrow_hits"][0, 0] == 1
    assert not sim.stuck_on.any()


def test_shield_uses_the_arrow_position_for_its_arc():
    for yaw, blocked in ((180.0, True), (0.0, False)):
        sim = open_sim()
        sim.pos[:, 1] = [0.0, 0.0, 5.0]
        sim.yaw[:, 1] = yaw
        sim.shield_ticks[:, 1] = C.SHIELD_RAISE_TICKS
        inject(sim, [0.0, 1.0, 3.0, 0.0, 0.0, 3.0], age=2)
        sim._step_arrows()
        assert bool(sim.events["arrows_blocked"][0, 1]) == blocked
        assert bool(sim.events["arrow_hits"][0, 0]) != blocked


def test_hit_during_the_hurt_window_bounces_off():
    sim = open_sim()
    sim.pos[:, 1] = [0.0, 0.0, 5.0]
    sim.hurt_timer[:, 1] = 5
    sim.last_damage[:, 1] = 100.0
    inject(sim, [0.0, 1.0, 3.0, 0.0, 0.0, 3.0], age=2)
    sim._step_arrows()
    assert sim.arrow_on[0, 0]
    assert sim.arrow_vel[0, 0, 2] == pytest.approx(3.0 * R.DEFLECT_FACTOR * C.ARROW_DRAG)
    assert sim.events["arrow_hits"][0, 0] == 0
    assert sim.hp[0, 1] == C.MAX_HEALTH


def test_an_arrow_counts_as_blocked_only_once():
    sim = open_sim()
    sim.pos[:, 1] = [0.0, 0.0, 5.0]
    sim.yaw[:, 1] = 180.0
    sim.shield_ticks[:, 1] = C.SHIELD_RAISE_TICKS
    inject(sim, [0.0, 1.0, 3.0, 0.0, 0.0, 3.0], age=2)
    sim._step_arrows()
    assert sim.events["arrows_blocked"][0, 1] == 1
    sim.hurt_timer[:, 1] = 0
    sim.arrow_pos[0, 0] = [0.0, 1.0, 3.0]
    sim.arrow_vel[0, 0] = [0.0, 0.0, 3.0]
    sim._step_arrows()
    assert sim.arrow_bounced[0, 0]
    assert sim.events["arrows_blocked"][0, 1] == 1


def test_arrow_sticks_in_the_arena_floor_and_wall():
    sim = open_sim(arena_half=10.0)
    inject(sim, [0.0, 0.5, 0.0, 0.5, -1.0, 0.0])
    inject(sim, [9.0, 3.0, 2.0, 2.0, 0.0, 0.0], slot=1)
    sim._step_arrows()
    assert not sim.arrow_on.any()
    stuck = sim.stuck_pos[0, sim.stuck_on[0]]
    found = {tuple(np.round(row, 6)) for row in stuck}
    assert found == {(0.2, 0.05, 0.0), (9.95, 3.0, 2.0)}


def test_ground_slots_replace_the_oldest():
    sim = open_sim()
    sim.stuck_on[0] = True
    sim.stuck_pos[0] = [50.0, 0.05, 50.0]
    sim.stuck_age[0] = np.arange(R.MAX_STUCK)
    inject(sim, [0.0, 0.5, 0.0, 0.0, -1.0, 0.0])
    sim._step_arrows()
    assert sim.stuck_on[0].all()
    replaced = sim.stuck_age[0].argmin()
    assert sim.stuck_pos[0, replaced] == pytest.approx([0.0, 0.05, 0.0])


def test_arrow_has_no_flight_time_limit():
    sim = open_sim()
    inject(sim, [0.5, 5000.0, 0.5, 0.0, 0.0, 0.0])
    for _ in range(400):
        R.step_arrows(sim)
    assert sim.arrow_on[0, 0]
    assert sim.arrow_age[0, 0] > 300


def test_stuck_arrow_despawns():
    sim = open_sim()
    sim.stuck_on[0, 0] = True
    sim.stuck_pos[0, 0] = [50.0, 0.05, 50.0]
    sim.stuck_age[0, 0] = R.DESPAWN_TICKS - 2
    sim._step_arrows()
    assert sim.stuck_on[0, 0]
    sim._step_arrows()
    assert not sim.stuck_on[0, 0]


@pytest.mark.parametrize(
    "offset, picked",
    [
        ((1.55, 0.05, 0.0), True),
        ((1.56, 0.05, 0.0), False),
        ((0.0, 0.05, -1.55), True),
        ((0.0, 2.3, 0.0), True),
        ((0.0, 2.31, 0.0), False),
        ((0.0, -1.0, 0.0), True),
        ((0.0, -1.01, 0.0), False),
    ],
)
def test_pickup_box(offset, picked):
    sim = open_sim()
    sim.pos[:, 1] = [0.0, 5.0, 50.0]
    sim.stuck_on[0, 0] = True
    sim.stuck_pos[0, 0] = sim.pos[0, 1] + offset
    sim.stuck_age[0, 0] = R.SHAKE_TICKS
    before = sim.ammo[0, 1]
    sim._step_arrows()
    assert (sim.ammo[0, 1] == before + 1) == picked


def test_dead_player_and_unpickable_arrow_do_not_collect():
    sim = open_sim()
    sim.pos[:, 1] = [20.0, 0.0, 20.0]
    sim.hp[:, 1] = 0.0
    sim.stuck_on[0, 0] = True
    sim.stuck_pos[0, 0] = [20.0, 0.05, 20.0]
    sim.stuck_age[0, 0] = R.SHAKE_TICKS
    sim._step_arrows()
    assert sim.stuck_on[0, 0]
    sim.hp[:, 1] = C.MAX_HEALTH
    sim.stuck_pickup[0, 0] = False
    sim._step_arrows()
    assert sim.stuck_on[0, 0]
    sim.stuck_pickup[0, 0] = True
    sim._step_arrows()
    assert not sim.stuck_on[0, 0]


def test_sneaking_lowers_the_spawn_and_the_target():
    sim = open_sim()
    sim.sneaking = np.zeros((1, 2), dtype=bool)
    sim.sneaking[:, :] = True
    assert R.spawn_heights(sim)[0, 0] == pytest.approx(1.17)
    sim.pos[:, 1] = [0.0, 0.0, 5.0]
    inject(sim, [0.0, 1.6, 3.0, 0.0, 0.0, 3.0], age=2)
    sim._step_arrows()
    assert sim.events["arrow_hits"][0, 0] == 0
    sim.sneaking[:, :] = False
    inject(sim, [0.0, 1.6, 3.0, 0.0, 0.0, 3.0], age=2)
    sim._step_arrows()
    assert sim.events["arrow_hits"][0, 0] == 1


@pytest.mark.parametrize("distance", [5.0, 10.0, 20.0, 30.0, 40.0])
@pytest.mark.parametrize("speed", [C.BOW_MAX_SPEED, C.CROSSBOW_SPEED])
def test_aim_solver_reaches_its_point(distance, speed):
    sim = open_sim()
    sim.weapon[:, 0] = C.CROSSBOW
    sim.pos[:, 0] = [0.0, 0.0, 0.0]
    sim.pos[:, 1] = [distance * 0.6, 1.0, distance * 0.8]
    yaw, pitch, flight = intercept_angles(sim, 0, np.array([speed]))
    velocity = look_vectors(yaw, pitch)[0] * speed
    position = np.array([0.0, C.EYE_HEIGHT - R.SPAWN_BELOW_EYE, 0.0])
    aim = sim.pos[0, 1] + [0.0, R.AIM_POINT_HEIGHT, 0.0]
    best = np.inf
    for _ in range(int(flight[0]) + 3):
        fraction = np.clip(np.dot(aim - position, velocity) / np.dot(velocity, velocity), 0.0, 1.0)
        best = min(best, float(np.linalg.norm(position + velocity * fraction - aim)))
        position = position + velocity
        velocity = velocity * C.ARROW_DRAG - [0.0, C.ARROW_GRAVITY, 0.0]
    assert best <= 0.01


def test_aim_solver_includes_the_bow_carry():
    sim = open_sim()
    sim.weapon[:, 0] = C.BOW
    sim.pos[:, 0] = [0.0, 0.0, 0.0]
    sim.pos[:, 1] = [0.0, 0.0, 25.0]
    sim.body.last_move[:, 0] = [0.25, 0.0, 0.0]
    yaw, pitch, flight = intercept_angles(sim, 0, np.array([C.BOW_MAX_SPEED]))
    velocity = look_vectors(yaw, pitch)[0] * C.BOW_MAX_SPEED + [0.25, 0.0, 0.0]
    position = np.array([0.0, C.EYE_HEIGHT - R.SPAWN_BELOW_EYE, 0.0])
    for _ in range(int(round(float(flight[0])))):
        position = position + velocity
        velocity = velocity * C.ARROW_DRAG - [0.0, C.ARROW_GRAVITY, 0.0]
    assert abs(position[0]) < 0.5
    assert 0.0 < position[1] < C.PLAYER_HEIGHT


def test_aim_solver_stops_a_falling_target_at_the_floor():
    sim = open_sim()
    sim.pos[:, 0] = [0.0, 0.0, 0.0]
    sim.pos[:, 1] = [0.0, 0.5, 30.0]
    sim.vel[:, 1] = [0.0, -1.0, 0.0]
    sim.on_ground[:, 1] = False
    _, falling, _ = intercept_angles(sim, 0, np.array([C.BOW_MAX_SPEED]))
    sim.pos[:, 1] = [0.0, 0.0, 30.0]
    sim.vel[:, 1] = 0.0
    sim.on_ground[:, 1] = True
    _, grounded, _ = intercept_angles(sim, 0, np.array([C.BOW_MAX_SPEED]))
    assert falling[0] == pytest.approx(grounded[0], abs=0.02)


def block_world(raw, n=1):
    world = make(raw, n)
    sim = Sim(n, SimConfig(armor="none", arena_half=FAR), seed=0)
    sim.world = world
    sim.pos[:, 0] = [1.5, FLOOR + 1.0, 1.5]
    sim.pos[:, 1] = [30.5, FLOOR + 1.0, 30.5]
    return sim


def test_world_block_stops_an_arrow():
    raw = flat_raw()
    raw[10, 10, yi(FLOOR + 2)] = B.STONE
    sim = block_world(raw)
    y = FLOOR + 2.5
    inject(sim, [8.5, y, 10.5, 2.0, 0.0, 0.0])
    sim._step_arrows()
    assert not sim.arrow_on[0, 0]
    assert sim.stuck_pos[0, 0] == pytest.approx([9.95, y, 10.5], abs=1e-6)
    sim.world.close()


def test_world_floor_stops_an_arrow():
    sim = block_world(flat_raw())
    inject(sim, [8.5, FLOOR + 1.5, 8.5, 0.0, -2.0, 0.0])
    sim._step_arrows()
    assert sim.stuck_pos[0, 0] == pytest.approx([8.5, FLOOR + 1.05, 8.5], abs=1e-6)
    sim.world.close()


def test_world_arrow_passes_blocks_with_no_collision_box():
    raw = flat_raw()
    raw[10, 10, yi(FLOOR + 2)] = B.TORCH
    raw[12, 10, yi(FLOOR + 2)] = B.STONE
    sim = block_world(raw)
    y = FLOOR + 2.1
    inject(sim, [9.2, y, 10.5, 2.5, 0.0, 0.0])
    sim._step_arrows()
    assert sim.arrow_on[0, 0] or sim.stuck_on[0, 0]
    if sim.arrow_on[0, 0]:
        sim._step_arrows()
    assert sim.stuck_pos[0, 0, 0] == pytest.approx(11.95, abs=1e-5)
    sim.world.close()


def test_water_slows_an_arrow():
    raw = flat_raw()
    raw[:, :, yi(FLOOR + 1) : yi(FLOOR + 4)] = B.WATER_SOURCE
    sim = block_world(raw)
    inject(sim, [8.5, FLOOR + 2.0, 8.5, 1.0, 0.0, 0.0])
    sim._step_arrows()
    assert sim.arrow_vel[0, 0, 0] == pytest.approx(R.WATER_DRAG)
    sim.world.close()


def test_air_does_not_slow_an_arrow_like_water():
    sim = block_world(flat_raw())
    inject(sim, [8.5, FLOOR + 2.0, 8.5, 1.0, 0.0, 0.0])
    sim._step_arrows()
    assert sim.arrow_vel[0, 0, 0] == pytest.approx(C.ARROW_DRAG)
    sim.world.close()


def test_arrow_falls_when_its_block_is_removed():
    raw = flat_raw()
    raw[10, 10, yi(FLOOR + 3)] = B.STONE
    sim = block_world(raw)
    inject(sim, [8.5, FLOOR + 3.5, 10.5, 2.0, 0.0, 0.0])
    sim._step_arrows()
    assert sim.stuck_on[0].sum() == 1
    sim._step_arrows()
    assert sim.stuck_on[0].sum() == 1
    sim.world.set(10, FLOOR + 3, 10, 0)
    sim._step_arrows()
    assert not sim.stuck_on[0].any()
    assert sim.arrow_on[0].sum() == 1
    sim.world.close()


def test_arrow_past_the_world_edge_is_removed():
    sim = block_world(flat_raw())
    inject(sim, [30.5, FLOOR + 10.0, 8.5, 3.0, 0.0, 0.0])
    sim._step_arrows()
    assert not sim.arrow_on[0, 0]
    assert not sim.stuck_on[0, 0]
    sim.world.close()


def test_aim_solver_finds_the_ground_under_a_falling_target():
    sim = block_world(flat_raw())
    sim.pos[:, 0] = [2.5, FLOOR + 1.0, 22.5]
    sim.pos[:, 1] = [2.5, FLOOR + 1.5, 28.5]
    sim.yaw[:, 0] = 0.0
    sim.pitch[:, 0] = 20.0
    for _ in range(4):
        sim.update_sight()
    sim.vel[:, 1] = [0.0, -1.0, 0.0]
    sim.on_ground[:, 1] = False
    _, falling, _ = intercept_angles(sim, 0, np.array([C.BOW_MAX_SPEED]))
    sim.pos[:, 1] = [2.5, FLOOR + 1.0, 28.5]
    sim.vel[:, 1] = 0.0
    sim.on_ground[:, 1] = True
    _, grounded, _ = intercept_angles(sim, 0, np.array([C.BOW_MAX_SPEED]))
    assert falling[0] == pytest.approx(grounded[0], abs=0.02)
    sim.world.close()


def test_reset_refills_the_quiver_and_clears_arrows():
    sim = open_sim()
    sim.ammo[:] = 0
    inject(sim, [0.0, 5.0, 0.0, 0.0, 0.0, 1.0])
    sim.stuck_on[0, 3] = True
    sim.reset()
    assert (sim.ammo == R.START_ARROWS).all()
    assert not sim.arrow_on.any()
    assert not sim.stuck_on.any()


def test_same_seed_repeats_the_same_shots():
    runs = []
    for _ in range(2):
        sim = open_sim(8, seed=21)
        release_shot(sim, C.BOW, 22)
        for _ in range(5):
            sim._tick(holding(sim, C.BOW, 0), first=True)
        runs.append((sim.arrow_pos.copy(), sim.arrow_vel.copy()))
    assert np.array_equal(runs[0][0], runs[1][0])
    assert np.array_equal(runs[0][1], runs[1][1])


def scripted_pickup_loop(env, steps):
    """Fire minimum power shots at the feet and collect them, repeating forever."""
    sim = env.sim
    env.reset()
    phase = np.zeros(env.num_envs, dtype=np.int64)
    total = 0.0
    picked = 0.0
    for _ in range(steps):
        a = A.neutral_actions(np.full(env.num_envs, C.BOW))
        a[:, A.PITCH] = np.where(sim.pitch[:, 0] < 89.0, A.SIM_PITCH_STEP.argmax(), a[:, A.PITCH])
        a[:, A.USE] = (phase % 6) < 2
        env.step_async(a)
        _, reward, _, _ = env.step_wait()
        phase += 1
        total += float(reward.mean())
        picked += float(sim.events["arrows_picked"][:, 0].mean())
    return total / steps, picked


def scripted_idle(env, steps):
    env.reset()
    total = 0.0
    for _ in range(steps):
        a = A.neutral_actions(env.sim.weapon[:, 0].copy())
        env.step_async(a)
        _, reward, _, _ = env.step_wait()
        total += float(reward.mean())
    return total / steps


def arena_env():
    pool = OpponentPool(32, seed=5, max_ticks=600)
    pool.set_mix({"idle": 1.0})
    return ArenaVecEnv(32, pool, SimConfig(), max_ticks=600, seed=5)


@pytest.mark.parametrize("make_env", [arena_env, lambda: ShootingDrill(32, seed=5, weapons=(C.BOW,))])
def test_fire_and_collect_loop_earns_less_than_idling(make_env):
    steps = 600
    loop, picked = scripted_pickup_loop(make_env(), steps)
    still = scripted_idle(make_env(), steps)
    assert picked > 1.0
    assert loop < still
