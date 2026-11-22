"""Skill experts (put the best shooting and the best shielding into every model).

A skill lives in the weights of the network that learned it and can not be copied into another network. So every
model gets the skills by handing a few of its decisions to an expert network in the moments the skill is for, a
first, rule based version of the selector idea (stage 4 of the plan):

  shooting   a crossbow or bow in hand and the enemy 4.5 blocks or more away: the shooting expert decides the turn,
             the look up or down, the use button (load, draw, shoot) and lock aim. The model still decides when to
             take the crossbow out, how to move and when to put it away.
  shielding  the enemy has a bow or crossbow out or is drawing or loading, 4.5 blocks or more away, and the model
             holds no ranged weapon: the shielding expert decides the turn, the look and the shield. The model still
             decides how to close in.

  shield gate (DEC-116, the shield reflexes brief) while the enemy's shield is raised and faces us 4.5 blocks or more
             away: the shooting expert hands back, the bow and crossbow can not be taken out, and one already in hand
             goes away for the axe (a switch drops a draw or a charge without a shot, a loaded crossbow stays
             loaded). Before, the expert kept a drawn bow aimed at the shield and a blocker that raises its shield
             against a drawn bow stalled the round to the clock (L1-v0010 won 0.9% of the blocker's rounds).
  shield breaker (the brief, the axe swap every good player uses) while the enemy's shield is raised and faces us
             within 4.5 blocks: the expert holds the axe, never swings the sword into the shield, and once the axe
             is out and the crosshair is on them it swings (our own shield goes down for it). The axe hit disables
             their shield for 5 s, their shield drops, the gate closes and every decision is the model's again.
             That disable is the hand off point: FOLLOW_UP rows (their shield on cooldown) go to self.follow_up when
             one is set, the place for idea 47's crossbow follow up. Movement and the aim stay the model's.
             At first it swung at a shield merely up (obs 25) and dropped our own shield for every swing, and
             mineflayer-pvp won 12 to 14 points more rounds (DEC-120, it raises its shield between attacks and
             drops it the tick before each sword swing). A hit on a shield up under 5 ticks is not blocked and
             disables nothing (combat.shield_blocks), so now it swings only at an active shield (obs 26), while
             the shield is still going up it only takes the axe out (unless a charged sword can land first), and
             it keeps our raised shield up against an enemy sword charged to GUARD_CHARGE or more.
             DEC-123 traced the 0.5 to 1.0 health a round it gives mineflayer-pvp: with the axe the breaker put in
             its hand the network had its shield active at 31% to 52% of the hits that came (89% with the sword).
             Holding our shield up while the axe waits (BREAKER_HOLD) ends that cost, but costs 5 to 6 points
             more against custom-pvp (it axes a shield held up 3 ticks), so it stays off.

  preload    (FIND-062, his watching of best against SynthSarcasm, DEMO_PRELOAD) an empty crossbow is loaded
             only out at SAFE_LOAD blocks or more, where a charge was hit 0% to 10% of the time against the copy (36% to
             48% at 6 to 8 blocks, 52% to 69% under 6, docs/reports/crossbow-habits.md): out there with no ranged threat
             the crossbow comes out and charges, in here no new charge starts (the axe comes out, a charge already going
             finishes).
  preload window (DEC-159 item 3, DEMO_PRELOAD_WINDOW, with preload) in the 5 s our axe disables their shield an empty
             crossbow is taken out and charged even inside SAFE_LOAD, since no shield blocks the arrow it makes.
  cb use0    (DEMO_CB_USE0) USE is set to 0 on the row that switches to the crossbow, so a shield press carried over
             cannot fire an unaimed bolt.
  break and shoot (idea 47, DEMO_BREAK_SHOOT) once the enemy has shown a shield this round, a loaded crossbow is
             saved inside SAFE_LOAD (put away, no shot) for the 5 s our axe disables their shield. In that window it comes
             out, LockShooter aims and fires it at once, and an emptied crossbow goes back to the axe. Outside SAFE_LOAD
             the shooting expert still shoots, since a reload out there is free. A letter with no ranged weapons or no
             axe is left alone.

The experts work through the action masks: in those moments the mask of each handed over decision allows only the
expert's choice. So training stays correct (the learner's own choice is the expert's), and the same code runs for
learners, league opponents and tournaments. A letter's own rules win: a letter with no shield never gets the
shielding expert, one with no ranged weapons never gets the shooting expert, and an expert choice the letter's
mask forbids is left to the model.
"""

from pathlib import Path

import numpy as np

import os

from .aim import hold_fire, shield_hold_on
from .strategies import FAMILIES, OBS_ROUND_TIME, OFFSETS

YAW, PITCH, ATTACK, USE, WEAPON, LOCK = 4, 5, 6, 7, 8, 10
AXE_CHOICE, CROSSBOW_CHOICE, BOW_CHOICE = 1, 3, 4  # the weapon decision: 0 keep, 1 axe, 2 sword, 3 crossbow, 4 bow
OBS_CROSSHAIR, OBS_HOLDING_AXE, OBS_MY_SHIELD_UP, OBS_ENEMY_SHIELD_CD = 5, 18, 22, 27
OBS_CHARGE, OBS_ENEMY_CHARGE, OBS_HOLDING_SWORD, OBS_ENEMY_HOLDING_SWORD = 16, 17, 19, 21
OBS_ENEMY_SHIELD_UP, OBS_ENEMY_SHIELD_ACTIVE, OBS_ENEMY_FACING_ANGLE = 25, 26, 29  # up, up 5 ticks, angle over pi
OBS_MY_SHIELD_CD = 24  # our shield's disable cooldown over 100 ticks
FULL_CHARGE = 0.9  # a full hit (brain/sim/world.py swing)
GUARD_CHARGE = 0.8  # the breaker keeps our shield up against a sword at least this charged
# Each stays off until it passes its bar (experiments/shield-reflexes-bar.py), then goes on for every fighter by the step back rule.
# DEMO_SHOOTER_SHIELD_GATE and DEMO_SHIELD_BREAKER set to 1 or 0 win over these
GATE_DEFAULT = True  # DEC-122: passed its bar on passes c and d (DEC-121), on for every fighter
BREAKER_DEFAULT = False
# DEC-123: while the axe waits, "1" holds our shield up, "2" only keeps a raised one up, "3" holds it up until the
# enemy first disables it in the round, "0" leaves it to the network (DEC-121's breaker). DEMO_BREAKER_HOLD wins.
# 600 round smokes against custom-pvp: base 75.8% and 71.7%, "0" 68.3% and 70.0%, "1" 63.3%, "2" 64.0%, "3" 64.8%
# (mineflayer-pvp health taken a round: base 3.4 to 3.6, "0" 4.5, "1" 3.6, "2" 3.7, "3" 3.4), so "0"
BREAKER_HOLD = "0"
# FIND-062: off until their bar (experiments/crossbow-reflexes-bar.py), DEMO_PRELOAD and DEMO_BREAK_SHOOT set to 1 or 0 win
PRELOAD_DEFAULT = False
BREAK_SHOOT_DEFAULT = False
# DEC-159 (3), both off: PRELOAD_WINDOW lets preload charge an empty crossbow inside SAFE_LOAD while the enemy's shield is
# disabled by our axe (preload's near stop covered that window and cut our arrow hits in it by about 70%), CB_USE0 sets USE
# to 0 on the row that switches to the crossbow (break and shoot left it free, FIND-063 item 2)
PRELOAD_WINDOW_DEFAULT = False
CB_USE0_DEFAULT = False
SAFE_LOAD = 8.0  # blocks, measured (docs/reports/crossbow-habits.md), DEMO_SAFE_LOAD wins


def _flag(name, default):
    v = os.environ.get(name)
    return default if v in (None, "") else v == "1"


def shield_gate_on():
    return _flag("DEMO_SHOOTER_SHIELD_GATE", GATE_DEFAULT)


def breaker_on():
    return _flag("DEMO_SHIELD_BREAKER", BREAKER_DEFAULT)


def preload_on():
    return _flag("DEMO_PRELOAD", PRELOAD_DEFAULT)


def break_shoot_on():
    return _flag("DEMO_BREAK_SHOOT", BREAK_SHOOT_DEFAULT)


def preload_window_on():
    return _flag("DEMO_PRELOAD_WINDOW", PRELOAD_WINDOW_DEFAULT)


def cb_use0_on():
    return _flag("DEMO_CB_USE0", CB_USE0_DEFAULT)


def safe_load():
    return float(os.environ.get("DEMO_SAFE_LOAD") or SAFE_LOAD)


def _drop(masks, row, dim, choice):
    """Forbids one choice of decision dim in a row unless it is the only one left."""
    c = OFFSETS[dim] + choice
    if masks[row, c] and masks[row, OFFSETS[dim]:OFFSETS[dim + 1]].sum() > 1:
        masks[row, c] = False


def _force(masks, given, row, dim, choice):
    """Like _only, but over an earlier expert's pick: allowed when the letter's own mask (given) allows the choice."""
    c = OFFSETS[dim] + choice
    if not given[row, c]:
        return False
    masks[row, OFFSETS[dim]:OFFSETS[dim + 1]] = False
    masks[row, c] = True
    return True


def _only(masks, row, dim, choice):
    """Fixes decision dim of a row to choice when its mask allows it. True when it did."""
    c = OFFSETS[dim] + choice
    if not masks[row, c]:
        return False
    masks[row, OFFSETS[dim]:OFFSETS[dim + 1]] = False
    masks[row, c] = True
    return True
OBS_HOLDING_CROSSBOW, OBS_ENEMY_CROSSBOW, OBS_HOLDING_BOW, OBS_ENEMY_BOW, OBS_ENEMY_RANGED_USE = 101, 105, 106, 108, 109
OBS_TRUE_DIST = 110  # distance / 32
OBS_LOADED, OBS_CB_CHARGE, OBS_ARROWS, OBS_LAST_USE = 102, 103, 104, 48
RANGE = 4.5  # within this the fight is melee and the model keeps every decision
BLOCK_RANGE = RANGE  # the block expert's own gate, so a test can move it alone

ROOT = Path(__file__).resolve().parent.parent
# The experts as first measured: the block drill X1 blocks 91% of the archer bot's arrows and 44% of the
# Power III skeleton's (the fighters trained against the mobs blocked 1% to 5%, they won by rushing). For shooting,
# the stage 3 aim drill network hits 95% against zombie- but only 8 of 117 inside a fight against a strafing
# skeleton (it never met one), so the default shooter is LockShooter, "drill" picks the network
SHOOTER = ROOT / "runs/aim-drill-3/Y1"
# Block drill 2 (EXP-010) replaced it: in fights, two seeds, alone 83% / 91% / 91% / 98% against the
# archer bot, skeleton, Power III skeleton and pillager (the first X1: 88% / 32% / 38% / 27%), inside L2 76% / 26% / 31% /
# 11% (71% / 14% / 16% / 9%), and L2 won more rounds against both skeletons
BLOCKER = ROOT / "runs/block-drill-2/X1"


class LockShooter:
    """The scripted shooter (DEC-030's check bot): lock aim always, load whenever empty (let go once loaded, a shot
    needs a fresh press), shoot only when the aim is inside the target's width and the line is clear. Hit 100% of
    predictable targets and 77% of the runner in the simulator, 99% and 100% in real Minecraft. A bow is drawn to
    full power and let go when aimed."""

    OBS_LOADED, OBS_CHARGE, OBS_LAST_USE, OBS_BOW_DRAW, OBS_AIM_WIDTHS, OBS_CLEAR = 102, 103, 48, 107, 113, 116

    def act(self, raw, keys=None):
        raw = np.asarray(raw)
        from .strategies import ACTION_DIMS
        a = np.zeros((len(raw), len(ACTION_DIMS)), dtype=np.int64)
        a[:, YAW] = 6  # no turn (the lock does the aiming)
        a[:, PITCH] = 5
        a[:, LOCK] = 1
        bow = raw[:, OBS_HOLDING_BOW] > 0.5
        loaded = raw[:, self.OBS_LOADED] > 0.5
        charging = raw[:, self.OBS_CHARGE] > 0
        held = raw[:, self.OBS_LAST_USE] > 0.5
        aimed = (raw[:, self.OBS_AIM_WIDTHS] * 5 < 1) & (raw[:, self.OBS_CLEAR] > 0.5)
        if shield_hold_on():
            aimed &= ~hold_fire(raw)  # DEC-091: never into a raised shield that faces us (the bow stays drawn)
        crossbow_use = np.where(~loaded, np.where(held & ~charging, 0, 1),  # charge (a fresh press when stuck)
                                np.where(held, 0, aimed.astype(np.int64)))  # loaded: let go, then press when aimed
        drawn = raw[:, self.OBS_BOW_DRAW] >= 1.0
        bow_use = np.where(drawn & aimed, 0, 1)  # hold to full draw, let go when aimed
        a[:, USE] = np.where(bow, bow_use, crossbow_use)
        return a


def newest(folder):
    """The newest saved version in a run folder's checkpoints."""
    return sorted((Path(folder) / "checkpoints").glob("v*"))[-1]


class Skills:
    def __init__(self, shooter=None, blocker=None):
        from .versions import Player  # versions imports this module
        # DEC-091: DEMO_SHOOTER names a shooting drill version (shooter.py), the learned shooting expert
        from .shooter import shooter_from_env
        learned = shooter_from_env() if shooter is None else None
        self.shooter = learned or (LockShooter() if shooter in (None, "lock") else
                                   Player(newest(SHOOTER) if shooter == "drill" else shooter))
        self.blocker = Player(blocker or newest(BLOCKER))
        self.used = {"shooting": 0, "shielding": 0, "gated": 0, "breaker": 0, "breaker_swings": 0}
        self.axed = {}  # key: (round time, the enemy has disabled our shield this round), for BREAKER_HOLD "3"
        # idea 47's place (not built): an object with apply(raw, masks, rows, keys) gets the rows whose enemy shield
        # an axe has just disabled, after every other expert
        self.follow_up = None
        self.lock = LockShooter()  # break and shoot aims and fires with the scripted shooter (99% to 100% in real Minecraft)
        self.shield_seen = {}  # key: (round time, the enemy has raised a shield this round), for break and shoot
        self.used.update(preload=0, close_load_stops=0, saved=0, break_shots=0, window_loads=0)

    def apply(self, raw, masks, letters, keys):
        """raw observations (n, OBS_DIM) as the model sees them, its masks (n, choices), the letter it plays in each
        row and the keys its runtime uses. Returns the masks with the handed over decisions fixed."""
        raw = np.asarray(raw)
        given = masks.copy()  # the letter's own masks, before any expert (preload may take out a gated empty crossbow)
        dist = raw[:, OBS_TRUE_DIST] * 32
        ranged = (raw[:, OBS_HOLDING_CROSSBOW] > 0.5) | (raw[:, OBS_HOLDING_BOW] > 0.5)
        enemy_ranged = ((raw[:, OBS_ENEMY_CROSSBOW] > 0.5) | (raw[:, OBS_ENEMY_BOW] > 0.5)
                        | (raw[:, OBS_ENEMY_RANGED_USE] > 0.5))
        rules = [FAMILIES[letter].get("rules", {}) for letter in letters]
        shoot = ranged & (dist >= RANGE) & np.array([not r.get("no_ranged") for r in rules], dtype=bool)
        facing_shield = hold_fire(raw)
        if shield_gate_on():
            far = facing_shield & (dist >= RANGE)
            shoot &= ~far
            for row in np.flatnonzero(far):
                self.used["gated"] += 1
                if ranged[row]:
                    _only(masks, row, WEAPON, AXE_CHOICE)
                else:
                    w = masks[row, OFFSETS[WEAPON]:OFFSETS[WEAPON + 1]].copy()
                    masks[row, OFFSETS[WEAPON] + CROSSBOW_CHOICE] = False
                    masks[row, OFFSETS[WEAPON] + BOW_CHOICE] = False
                    if not masks[row, OFFSETS[WEAPON]:OFFSETS[WEAPON + 1]].any():
                        masks[row, OFFSETS[WEAPON]:OFFSETS[WEAPON + 1]] = w  # never leave a decision without a choice
        if breaker_on():
            facing = np.abs(raw[:, OBS_ENEMY_FACING_ANGLE]) <= 0.5
            near = facing & (dist < RANGE) & np.array([not r.get("no_axe") for r in rules], dtype=bool)
            # obs 26: up 5 ticks, so a hit on it is blocked and an axe disables it. Obs 25 without 26: going up, the
            # axe comes out ready unless a charged sword can still land on the open body first
            active = near & (raw[:, OBS_ENEMY_SHIELD_ACTIVE] > 0.5)
            rising = near & (raw[:, OBS_ENEMY_SHIELD_UP] > 0.5) & ~active
            sword_ready = ((raw[:, OBS_HOLDING_SWORD] > 0.5) & (raw[:, OBS_CHARGE] >= FULL_CHARGE)
                           & (raw[:, OBS_CROSSHAIR] > 0.5))
            for row in np.flatnonzero(rising & ~sword_ready):
                if _only(masks, row, WEAPON, AXE_CHOICE):
                    self.used["breaker"] += 1
            # our raised shield stops a charged sword in full, so it stays up against one (an axe would disable it)
            guard = ((raw[:, OBS_MY_SHIELD_UP] > 0.5) & (raw[:, OBS_ENEMY_HOLDING_SWORD] > 0.5)
                     & (raw[:, OBS_ENEMY_CHARGE] >= GUARD_CHARGE))
            hold = os.environ.get("DEMO_BREAKER_HOLD") or BREAKER_HOLD
            keys = list(keys)
            if hold == "3":
                # a foe that has disabled our shield this round breaks raised shields (custom-pvp's axe switch after
                # 3 ticks of our shield up), so a shield held up for it only feeds its axe
                for row, key in enumerate(keys):
                    t = float(raw[row, OBS_ROUND_TIME])
                    last, axed = self.axed.get(key, (t, False))
                    axed = (axed and t >= last) or bool(raw[row, OBS_MY_SHIELD_CD] > 0)
                    self.axed[key] = (t, axed)
            for row in np.flatnonzero(active):
                if not _only(masks, row, WEAPON, AXE_CHOICE):
                    continue  # no axe in this kit or a rule holds the weapon
                self.used["breaker"] += 1
                if raw[row, OBS_HOLDING_AXE] > 0.5 and raw[row, OBS_CROSSHAIR] > 0.5 and not guard[row]:
                    if _only(masks, row, ATTACK, 1):
                        self.used["breaker_swings"] += 1
                        if raw[row, OBS_MY_SHIELD_UP] > 0.5:
                            _only(masks, row, USE, 0)  # a raised shield stops our own swing
                else:
                    _only(masks, row, ATTACK, 0)  # no sword into the shield, no whiff out of reach
                    # DEC-123: with the axe in hand the network had its shield active at only 31% to 52% of the hits
                    # that came (89% with the sword), so mineflayer-pvp's hits within 6 ticks of the breaker taking
                    # the axe out cost 0.67 health each, not 0.30. BREAKER_HOLD keeps our shield up for them
                    if (hold == "1" or (hold == "2" and raw[row, OBS_MY_SHIELD_UP] > 0.5)
                            or (hold == "3" and not self.axed[keys[row]][1])):
                        _only(masks, row, USE, 1)
        shield = ~ranged & enemy_ranged & (dist >= BLOCK_RANGE) & np.array([not r.get("no_shield") for r in rules], dtype=bool)
        keys = list(keys)
        if hasattr(self.shooter, "observe"):
            self.shooter.observe(raw, keys)  # the learned shooter keeps the last steps of every arena
        for gate, expert, dims, name in ((shoot, self.shooter, (YAW, PITCH, USE, LOCK), "shooting"),
                                         (shield, self.blocker, (YAW, PITCH, USE), "shielding")):
            rows = np.flatnonzero(gate)
            if not len(rows):
                continue
            actions = np.asarray(expert.act(raw[rows], keys=[keys[i] for i in rows]))
            self.used[name] += len(rows)
            for row, act in zip(rows, actions):
                for d in dims:
                    choice = OFFSETS[d] + int(act[d])
                    if masks[row, choice]:
                        masks[row, OFFSETS[d]:OFFSETS[d + 1]] = False
                        masks[row, choice] = True
        pre, bs = preload_on(), break_shoot_on()
        if pre or bs:
            self._crossbow(raw, masks, given, rules, enemy_ranged, dist, list(keys), pre, bs)
        if self.follow_up is not None:
            rows = np.flatnonzero(raw[:, OBS_ENEMY_SHIELD_CD] > 0)
            if len(rows):
                self.follow_up.apply(raw, masks, rows, [keys[i] for i in rows])
        return masks

    def _crossbow(self, raw, masks, given, rules, enemy_ranged, dist, keys, pre, bs):
        """FIND-062's reflexes, after every other expert: preload (load far, never near) and break and shoot."""
        safe = safe_load()
        use0, pwin = cb_use0_on(), preload_window_on()
        crossbow = raw[:, OBS_HOLDING_CROSSBOW] > 0.5
        loaded = raw[:, OBS_LOADED] > 0.5
        charging = raw[:, OBS_CB_CHARGE] > 0
        window = raw[:, OBS_ENEMY_SHIELD_CD] > 0  # their shield disabled, only our axe does that
        can = np.array([not r.get("no_ranged") and not r.get("no_axe") for r in rules], dtype=bool)
        can &= given[:, OFFSETS[WEAPON] + CROSSBOW_CHOICE]
        if bs:
            for row, key in enumerate(keys):
                t = float(raw[row, OBS_ROUND_TIME])
                last, seen = self.shield_seen.get(key, (t, False))
                seen = (seen and t >= last) or bool(raw[row, OBS_ENEMY_SHIELD_UP] > 0.5)
                self.shield_seen[key] = (t, seen)
            seen = np.array([self.shield_seen[k][1] for k in keys], dtype=bool)
            fire = can & window & loaded
            if fire.any():
                rows = np.flatnonzero(fire & crossbow)
                acts = np.asarray(self.lock.act(raw[rows])) if len(rows) else []
                for row, act in zip(rows, acts):
                    _force(masks, given, row, WEAPON, 0)  # keep it in hand
                    for d in (YAW, PITCH, USE, LOCK):
                        _force(masks, given, row, d, int(act[d]))
                    self.used["break_shots"] += int(act[USE] == 1 and raw[row, OBS_LAST_USE] <= 0.5)
                for row in np.flatnonzero(fire & ~crossbow):
                    _force(masks, given, row, WEAPON, CROSSBOW_CHOICE)
                    if use0:
                        _force(masks, given, row, USE, 0)  # the switch row never presses USE (a carried shield press)
            # an emptied crossbow in the window goes back to the axe
            for row in np.flatnonzero(can & window & crossbow & ~loaded & ~charging):
                _only(masks, row, WEAPON, AXE_CHOICE)
            # saved for the window: inside SAFE_LOAD against a shield, no shot (out there the reload is free)
            save = can & ~window & loaded & seen & (dist < safe)
            for row in np.flatnonzero(save):
                self.used["saved"] += 1
                if crossbow[row]:
                    _force(masks, given, row, WEAPON, AXE_CHOICE)
                    _force(masks, given, row, USE, 0)
                else:
                    _drop(masks, row, WEAPON, CROSSBOW_CHOICE)
        if pre:
            empty = can & ~loaded  # in the disable window too (a charge started there is a charge inside their reach)
            near = empty & ~charging & (dist < safe)
            if pwin:  # DEC-159 (3): in the disable window a charge inside SAFE_LOAD is allowed and started
                go = near & window & ~enemy_ranged & (raw[:, OBS_ARROWS] > 0)
                for row in np.flatnonzero(go):
                    self.used["window_loads"] += 1
                    if not crossbow[row]:
                        _force(masks, given, row, WEAPON, CROSSBOW_CHOICE)
                        if use0:
                            _force(masks, given, row, USE, 0)
                        continue
                    _force(masks, given, row, WEAPON, 0)
                    stuck = raw[row, OBS_LAST_USE] > 0.5 and not charging[row]
                    _force(masks, given, row, USE, 0 if stuck else 1)
                near &= ~go
            for row in np.flatnonzero(near):
                self.used["close_load_stops"] += 1
                if crossbow[row]:
                    if not _force(masks, given, row, WEAPON, AXE_CHOICE):
                        _force(masks, given, row, USE, 0)
                else:
                    _drop(masks, row, WEAPON, CROSSBOW_CHOICE)
            far = empty & (dist >= safe) & ~enemy_ranged & (raw[:, OBS_ARROWS] > 0)
            for row in np.flatnonzero(far):
                self.used["preload"] += 1
                if not crossbow[row]:
                    _force(masks, given, row, WEAPON, CROSSBOW_CHOICE)
                    if use0:
                        _force(masks, given, row, USE, 0)
                    continue
                _force(masks, given, row, WEAPON, 0)  # keep it in hand (the gate may have picked the axe)
                # charge, with a fresh press when a held button charges nothing (LockShooter's rule)
                stuck = raw[row, OBS_LAST_USE] > 0.5 and not charging[row]
                _force(masks, given, row, USE, 0 if stuck else 1)
        return masks
