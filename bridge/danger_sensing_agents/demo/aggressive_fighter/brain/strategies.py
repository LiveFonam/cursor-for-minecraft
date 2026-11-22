"""Strategy letters and their variants.

A family (one letter) is a game plan: what the bot earns bonus points for, and hard rules it can not
break (enforced by masking actions, so the network never even picks them). A variant (A1, A2, ...)
is a family with its own settings: when it may start jumping, whether it rushes in, when it gives
up on the plan and falls back to another letter, how much it cares about dealing or avoiding damage.
Evolution makes new variants by changing those settings and the bonus sizes, and now and then by
switching the letter.

Every family also gets the base rewards in reward.py, including the penalty for leaving an opponent
who stands still alive and for missed crossbow shots.

Agents are named <variant>-v<version>, like A2-v0031. Families get compared by tournament wins,
never by reward totals, since each letter is paid for different things on purpose.

M (Mix) is several letters at once, to test whether the strongest bot uses almost every plan with
only a few left out. Every variant also records its mutation depth (mutations since its seed) and,
per letter, how many mutations that letter has been part of its line (letter_age), so the
experiment log can check whether a letter only pays off after many mutations.
"""

import copy
import json
import random
import re
from pathlib import Path

import numpy as np

from .aim import hold_fire, shield_hold_on

# Must match bridge/fighter.js
# weapon: 0 keep, 1 axe, 2 sword, 3 crossbow, 4 bow, turns end in 4 fine, lock aim last (DEC-030)
ACTION_DIMS = [3, 3, 2, 2, 18, 15, 3, 2, 5, 2, 2]
OFFSETS = np.concatenate([[0], np.cumsum(ACTION_DIMS)]).astype(int)
JUMP, YAW, PITCH, ATTACK, USE, WEAPON, LOCK = 3, 4, 5, 6, 7, 8, 10
FINE_STEPS, FINE_AIM_BLOCKS = 4, 9  # sim/constants.py: the last 4 turn steps are fine ones, used beyond 9 blocks
OBS_TRUE_DIST = 110  # distance / 32
AXE, SWORD, CROSSBOW, BOW = 1, 2, 3, 4
OBS_DIST, OBS_MY_SHIELD_CD, OBS_ENEMY_SHIELD_CD, OBS_ROUND_TIME, OBS_HOLDING_CROSSBOW = 2, 24, 27, 41, 101
OBS_CROSSBOW_LOADED, OBS_CROSSBOW_CHARGE, OBS_ARROWS = 102, 103, 104
OBS_LAST_USE = 48  # the use button in the previous action
OBS_HOLDING_BOW, OBS_BOW_DRAW, OBS_ENEMY_BOW, OBS_ENEMY_RANGED_USE = 106, 107, 108, 109
# every bot uses the crossbow every match. In 800 simulator rounds the top versions fired
# 0 times, loading takes holding the button over a second with the crossbow out, so the network never found
# it by chance. Opening rule for every letter: in the first 2 s, while the opponent is over 6 blocks away,
# hold the crossbow and load it (a load started while far is finished). Firing stays the network's choice,
# paid by the shot rewards in reward.py
OPENING_LOAD_STEPS = 20
OPENING_LOAD_BLOCKS = 6

N_STRATEGY_INPUTS = 4  # reserved at the end of every observation
# Bonuses paid for a state that lasts, every step it holds (the others pay per event). At 20 decisions a second there
# are twice as many steps, so these are paid times the step's length (info step_time, in 100 ms steps) and a second
# of the state earns the same at every rate. A new bonus on a state belongs here
PER_STEP_BONUS = {"shield_up", "crosshair", "enemy_shield_active", "sprinting", "airborne", "looking_at", "finisher",
                  "shield_idle"}
SHIELD_IDLE = -0.02  # reward.py WEIGHTS shield_idle (importing reward here is circular)
ARROWS = 6  # the kit's arrows, same as sim/constants.py ARROWS and fighter.js ARROWS (importing them here is circular)
# The last arrow before the switch to melee settles under the letter that fired it (bonus below): an arrow is
# settled within 2 s (SHOT_MISS_TICKS 40, 20 steps), plus slack
ARROW_SETTLE_STEPS = 25
ARROW_TERMS = {"arrow_hits", "arrow_misses", "ranged_hits", "cover_loads", "cover_hits"}
# Wall shooter (W): a load counts as behind cover when the bot was covered on at least 3 in 4 of its steps and on the
# step it finished. Leaving cover counts after 5 steps (0.5 s) in it, so standing on a pillar's edge does not make an
# exit every step, and a hit pays cover_hits within 15 steps (1.5 s) of leaving
COVER_LOAD_SHARE = 0.75
COVER_MIN_STEPS = 5
COVER_HIT_STEPS = 15

FAMILIES = {
    "Z": dict(name="All-rounder", idea="No fixed plan. Paid only for damage, winning and the base rules.",
              bonus={}),
    "A": dict(name="Auto crit", idea="Shield up, keep jumping and clicking. When their axe breaks your shield, "
                                     "the first click lands, as a crit if you are falling.",
              bonus={"auto_hits": 3.0, "auto_crits": 4.0, "my_blocks": 0.3, "crits": 0.5, "shield_vs_axe": 0.01},
              # the auto crit plan keeps the shield up, so no shield_idle cost for it
              rules={"shield_free": True}),
    "B": dict(name="Sword runner", idea="No shield at all. Sword out, strafe, sprint hits with W taps, jump crits.",
              bonus={"crits": 1.0, "combo_hits": 0.5, "whiff_punish": 1.0},
              rules={"no_shield": True, "no_axe": True}),
    "C": dict(name="Shield then sword", idea="Play Auto crit until the first shield break on either side, then drop "
                                             "the shield for good and play Sword runner.",
              phases=["A", "B"], switch_on="shield_break"),
    "D": dict(name="Momentum breaker", idea="Sprint jump in from about 5 blocks, break their shield just after the "
                                            "peak, jump reset their reply, switch to the sword and crit.",
              bonus={"shield_breaks": 3.0, "punish_dealt": 0.6, "jump_resets": 0.5, "crits": 0.5}),
    "E": dict(name="Corner crit", idea="trick: back into a corner and jump crit over and over.",
              bonus={"crits": 1.5, "corner": 0.01}),
    "F": dict(name="Spacer", idea="Hover around 4.5 blocks, make them swing at air, punish the miss.",
              bonus={"whiff_punish": 2.5, "spacing": 0.01, "taken": -0.3}),
    "G": dict(name="Three block disabler", idea="Break their shield from max reach, back out, then punish with the "
                                                "sword in the 5 second window.",
              bonus={"shield_breaks": 2.0, "punish_dealt": 1.0, "too_close": -0.005}),
    "H": dict(name="Backstabber", idea="Get around their shield and hit their back.",
              bonus={"back_hits": 2.0, "crits": 0.5}),
    "I": dict(name="Crossbow combo", idea="Load the crossbow early. Land a melee hit, then shoot them right after so "
                                          "the arrow sends them flying. Missing is expensive.",
              bonus={"arrow_combos": 4.0, "arrow_hits": 1.5, "arrow_misses": -1.0}),
    "J": dict(name="Switch hitter", idea="rule: axe while their shield is up, sword the moment it is down, "
                                         "back to the axe when it comes back. Knowing which weapon to hold is the plan.",
              bonus={"right_weapon_hits": 0.3, "sword_into_shield": -0.5, "shield_breaks": 2.0, "punish_dealt": 0.6}),
    "K": dict(name="Break and push", idea="counter to Auto crit: when they block, break the shield with the "
                                          "axe and shoot right away, so the arrow pushes them out of reach of their reply.",
              bonus={"break_push": 5.0, "shield_breaks": 2.0, "early_load": 1.0, "arrow_hits": 1.0}),
    "L": dict(name="Sharpshooter", idea="shooting is a plan only paired with melee, arrows run out. Load early "
                                        "and land arrows from range, then play the melee letter in its 'then' setting "
                                        "(Switch hitter at first, evolution can change it) once the arrows are gone.",
              switch_on="out_of_arrows",
              bonus={"ranged_hits": 3.0, "arrow_hits": 1.0, "arrow_misses": -0.5, "early_load": 2.0}),
    # shoot with the crossbow from cover so they can not hit you back. Cover is a pillar between
    # the bot's eyes and the enemy's (the "covered" info field, sim/observe.py and fighter.js). Both bonuses need an
    # arrow that lands, so hiding forever or stepping in and out without shooting earns nothing (DEC-062 farm check)
    "W": dict(name="Wall shooter", idea="load the crossbow behind a pillar, out of their sight, step out to "
                                        "shoot, step back into cover. Once the arrows are gone, play the melee letter "
                                        "in its 'then' setting (Switch hitter at first), like Sharpshooter.",
              switch_on="out_of_arrows",
              # cover_loads: a load finished behind cover, paid when its arrow leaves from out of cover as an aimed
              # shot and taken back when that arrow misses. cover_hits: an arrow hit within 1.5 s of leaving cover,
              # once per exit
              bonus={"cover_loads": 0.5, "cover_hits": 1.0, "arrow_hits": 1.0, "arrow_misses": -0.5}),
    "Y": dict(name="Aim drill", idea="Not a fighting plan. Crossbow only, no melee, reload whenever it is empty, shoot a lot: a "
                                     "hit pays 3, a miss costs 0.3. Trains the aim every version gets (aim_drill.py).",
              # reward shots from out of close range, missing does not matter much, it is practice
              bonus={"arrow_hits": 3.0, "range_shots": 1.0, "aimed_shot": 0.5},
              # aim_wait 6 (0.6 s) after each load: the plan asked for about 5,000 arrows where it fired 6,444 (FIND-006),
              # the replay gave 4,936 at 6 steps
              rules={"auto_reload": True, "no_melee": True, "crossbow_only": True, "aim_wait": 6}),
    "X": dict(name="Block drill", idea="Not a fighting plan. learn to block arrows when aimed at. Axe or sword "
                                       "only, no swings, no crossbow opening. An arrow blocked pays 1, one taken costs 1.5, "
                                       "every step with the shield up costs 0.02, so it blocks when it should, not always.",
              bonus={"arrows_blocked": 1.0, "arrow_hit_me": -1.5, "shield_up": -0.02},
              rules={"no_melee": True, "no_ranged": True, "no_opening": True}),
    "M": dict(name="Mix", idea="Several letters at once. Every included letter's bonuses count, hard rules are "
                               "dropped so letters can not block each other."),
}

# Letters evolution never switches to or falls back on (the Mix is built on purpose, the aim drill is not a plan)
# B (sword runner) never raises a shield by its rules, which does not fit the final bot that shoots, shields and
# attacks , so evolution makes no new B children. Its versions stay for tournaments
NOT_EVOLVED = {"M", "Y", "X", "B"}

# Letters a Mix can hold. Z has no bonuses of its own and C is A then B, so both are left out
MIX_POOL = "ABDEFGHI"

KNOBS = {
    "jump_after": 0,  # steps into the round before it may jump
    "rush": 0,  # steps at the start of the round where closing in earns a bonus
    "patience": 0,  # if the enemy never came within 5 blocks by this step, fall back (0 means never)
    "fallback": "Z",  # the letter it falls back to
    "then": "J",  # L and W only: the melee letter it plays once the arrows are gone
    # Arrows the bow may not use, kept for the crossbow knockback combo (melee hit, then shoot). keep 1 or 2,
    # maybe 3, and test which is best. Mutated by evolution and compared in EXP-006
    "arrow_reserve": 1,
    "aggression": 1.0,  # multiplies the reward for damage dealt
    "caution": 1.0,  # multiplies the penalty for damage taken
}

VARIANT_ID = re.compile(r"^([A-Z])(\d+)$")


class Variant:
    def __init__(self, vid, knobs=None, bonus=None, parent=None, note="", mix=None, depth=None, letter_age=None,
                 reward=None):
        m = VARIANT_ID.match(vid)
        if not m or m.group(1) not in FAMILIES:
            raise ValueError(f"unknown strategy {vid}, use a letter from {''.join(FAMILIES)} and a number, like A1")
        self.id = vid
        self.family = m.group(1)
        self.mix = sorted(mix if mix is not None else MIX_POOL) if self.family == "M" else None
        self.knobs = {**KNOBS, **(knobs or {})}
        self.bonus = {**self.active_bonus(self.family), **(bonus or {})}
        self.parent = parent
        self.note = note
        self.depth = depth  # None until the registry works it out from the parent chain
        self.letter_age = letter_age or {}
        # base reward weights in place of reward.py WEIGHTS, set by evolve.py --reward-sigma (None for every older
        # variant, which trains on WEIGHTS as before)
        self.reward = reward

    @property
    def letters(self):
        """The plans this variant uses, like ['A', 'B'] for C or the mix letters for M."""
        if self.family == "M":
            return list(self.mix)
        return list(FAMILIES[self.family].get("phases", [self.family]))

    def active_bonus(self, letter):
        if letter == "M":
            return mix_bonus(self.mix if self.mix is not None else MIX_POOL)
        return family_bonus(letter)

    @property
    def name(self):
        return FAMILIES[self.family]["name"]

    def to_dict(self):
        d = {"id": self.id, "family": self.family, "name": self.name, "knobs": self.knobs, "bonus": self.bonus,
             "parent": self.parent, "note": self.note, "depth": self.depth, "letter_age": self.letter_age}
        if self.mix is not None:
            d["mix"] = self.mix
        if self.reward is not None:
            d["reward"] = self.reward
        return d

    @classmethod
    def from_dict(cls, d):
        return cls(d["id"], d.get("knobs"), d.get("bonus"), d.get("parent"), d.get("note", ""), d.get("mix"),
                   d.get("depth"), d.get("letter_age"), d.get("reward"))

    def describe(self):
        changed = {k: v for k, v in self.knobs.items() if KNOBS[k] != v}
        extra = f" settings {changed}" if changed else ""
        mix = f" ({'+'.join(self.mix)})" if self.mix is not None else ""
        return f"{self.id} {self.name}{mix}: {FAMILIES[self.family]['idea']}{extra}"


def family_bonus(letter):
    fam = FAMILIES[letter]
    if "phases" in fam:
        merged = {}
        for p in fam["phases"]:
            merged.update(FAMILIES[p].get("bonus", {}))
        return merged
    return dict(fam.get("bonus", {}))


def mix_bonus(letters):
    """Every letter's bonuses. When two letters pay for the same thing (crits), the larger default
    wins, so a shared skill counts like it does for the letter that cares most, not once per letter."""
    merged = {}
    for letter in letters:
        for k, w in family_bonus(letter).items():
            merged[k] = w if k not in merged or abs(w) > abs(merged[k]) else merged[k]
    return merged


def cover_events(st, info):
    """The wall shooter's two events, written into the step's info so the bonus loop pays them at their sizes and the
    stats can count them. st is the arena's runtime state (charging comes from the observation before the step).
      cover_loads   +1 when an aimed shot leaves from out of cover with a load finished behind cover, -1 when that
                    arrow misses (so a miss nets 0 whatever size evolution gives the bonus)
      cover_hits    1 for an arrow hit within COVER_HIT_STEPS of leaving cover, once per exit"""
    covered = bool(info.get("covered"))
    steps = float(info.get("steps", 0))  # round time in 100 ms steps
    dt = info.get("step_time", 1)  # this step's length in 100 ms steps (EXP-012), the streaks below count time
    hits = int(info.get("arrow_hits", 0)) - int(info.get("arrow_hits_weak_bow", 0))  # bow taps never pay (BUG-095)
    misses, shots = int(info.get("arrow_misses", 0)), int(info.get("shots", 0))
    info["cover_loads"] = info["cover_hits"] = 0
    # the arrow of a paid shot lands: a hit keeps the payment, a miss takes it back
    if st.get("cover_paid") and (hits or misses):
        info["cover_loads"] -= int(not hits)
        st["cover_paid"] = False
    # how much of the load ran behind cover
    if st.get("charging"):
        st["load_steps"] = st.get("load_steps", 0) + dt
        st["load_covered"] = st.get("load_covered", 0) + int(covered) * dt
    if int(info.get("loads", 0)):
        n = st.get("load_steps", 0)
        st["cover_load"] = covered and n > 0 and st.get("load_covered", 0) >= COVER_LOAD_SHARE * n
        st["load_steps"] = st["load_covered"] = 0
    if shots:
        if st.get("cover_load") and info.get("aimed_shot") and not covered:
            info["cover_loads"] += 1
            st["cover_paid"] = not hits  # an arrow that hits on the step it leaves (point blank) is already settled
        st["cover_load"] = False  # that arrow is gone, paid or not
    # leaving cover after at least COVER_MIN_STEPS in it, then one paid hit per exit
    streak = st.get("cover_streak", 0)
    if covered:
        st["cover_streak"] = streak + dt
    else:
        if streak >= COVER_MIN_STEPS:
            st["exit_at"], st["exit_paid"] = steps, False
        st["cover_streak"] = 0
    if hits and not st.get("exit_paid", True) and steps - st.get("exit_at", -999) <= COVER_HIT_STEPS:
        info["cover_hits"] = 1
        st["exit_paid"] = True


class Registry:
    """Every variant in a league, saved in strategies.json so mutations survive restarts."""

    def __init__(self, league_dir):
        self.path = Path(league_dir) / "strategies.json"
        raw = json.loads(self.path.read_text()) if self.path.exists() else {}
        # A letter this code does not know (a newer process added it) is kept as it was and skipped, so an old
        # process neither stops (BUG-084: W1 ended the real L1) nor drops it when it saves
        self.unknown = {k: v for k, v in raw.items() if k[:1] not in FAMILIES}
        if self.unknown:
            print(f"strategies: skipping {', '.join(self.unknown)}, letters this code does not know")
        self.variants = {k: Variant.from_dict(v) for k, v in raw.items() if k not in self.unknown}
        for v in self.variants.values():
            self.fill_lineage(v)

    def fill_lineage(self, v, seen=()):
        """Depth and letter ages for variants saved before they were tracked, from the parent chain."""
        if v.depth is not None:
            return
        parent = self.variants.get(v.parent) if v.parent else None
        if parent is None or v.id in seen:
            v.depth, v.letter_age = 0, {x: 0 for x in v.letters}
            return
        self.fill_lineage(parent, seen + (v.id,))
        v.depth = parent.depth + 1
        v.letter_age = {x: parent.letter_age.get(x, -1) + 1 for x in v.letters}

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        out = {**getattr(self, "unknown", {}), **{k: v.to_dict() for k, v in self.variants.items()}}
        self.path.write_text(json.dumps(out, indent=1) + "\n")

    def get(self, vid):
        if vid not in self.variants:
            self.variants[vid] = Variant(vid, note="starting settings")
            self.save()
        return self.variants[vid]

    def next_id(self, letter):
        used = [int(VARIANT_ID.match(v).group(2)) for v in self.variants if v.startswith(letter)]
        return f"{letter}{max(used, default=0) + 1}"

    def add(self, letter, parent=None, mix=None, knobs=None, bonus=None, note=""):
        """A hand made child (experiments): this letter or mix, the parent's settings unless given."""
        knobs = knobs if knobs is not None else (copy.deepcopy(parent.knobs) if parent else None)
        if bonus is None and parent is not None and letter == parent.family and mix == parent.mix:
            bonus = dict(parent.bonus)
        child = Variant(self.next_id(letter), knobs, bonus, parent=parent.id if parent else None, note=note, mix=mix)
        self._age(child, parent)
        self.variants[child.id] = child
        self.save()
        return child

    @staticmethod
    def _age(child, parent):
        child.depth = parent.depth + 1 if parent else 0
        ages = parent.letter_age if parent else {}
        child.letter_age = {x: ages.get(x, -1) + 1 for x in child.letters}

    def mutate(self, parent, rng=random, switch_chance=0.15, letter=None, mix_change=0.35):
        """A child of parent with nudged settings and bonus sizes. Sometimes it tries another letter
        (keeping the parent's network, so the skills carry over). A Mix may instead gain or lose a letter."""
        if letter is None:
            letter = parent.family
            if rng.random() < switch_chance and parent.family != "M":
                letter = rng.choice([f for f in FAMILIES if f != parent.family and f not in NOT_EVOLVED])
        knobs = copy.deepcopy(parent.knobs)
        changes = []
        mix = None
        if letter == "M":
            mix = list(parent.mix) if parent.family == "M" else list(MIX_POOL)
            missing = [x for x in MIX_POOL if x not in mix]
            if rng.random() < mix_change:
                if missing and (len(mix) <= 2 or rng.random() < 0.5):
                    x = rng.choice(missing)
                    mix.append(x)
                    changes.append(f"added {x}")
                elif len(mix) > 1:
                    x = rng.choice(mix)
                    mix.remove(x)
                    changes.append(f"dropped {x}")
        if rng.random() < 0.4:
            knobs["jump_after"] = rng.choice([0, 0, 10, 20, 40])
            changes.append(f"jump after {knobs['jump_after']} steps")
        if rng.random() < 0.4:
            knobs["rush"] = rng.choice([0, 20, 50])
            changes.append(f"rush {knobs['rush']} steps")
        if rng.random() < 0.3:
            knobs["patience"] = rng.choice([0, 50, 100])
            knobs["fallback"] = rng.choice([f for f in FAMILIES if f not in NOT_EVOLVED])
            changes.append(f"patience {knobs['patience']} then {knobs['fallback']}")
        if rng.random() < 0.3:
            knobs["arrow_reserve"] = rng.choice([0, 1, 2, 3])
            changes.append(f"arrow reserve {knobs['arrow_reserve']}")
        if letter in ("L", "W") and rng.random() < 0.3:
            knobs["then"] = rng.choice([f for f in "ABDEGHIJK" if f != knobs.get("then")])
            changes.append(f"then {knobs['then']}")
        for k in ("aggression", "caution"):
            if rng.random() < 0.5:
                knobs[k] = round(knobs[k] * rng.uniform(0.7, 1.4), 2)
                changes.append(f"{k} {knobs[k]}")
        if letter == "M":
            # sizes the parent already tuned carry over, a newly added letter starts at its defaults
            bonus = {**mix_bonus(mix), **{k: w for k, w in parent.bonus.items() if k in mix_bonus(mix)}}
        else:
            bonus = family_bonus(letter) if letter != parent.family else dict(parent.bonus)
        for k in bonus:
            if rng.random() < 0.5:
                bonus[k] = round(bonus[k] * rng.uniform(0.6, 1.6), 4)
        if letter != parent.family:
            changes.insert(0, f"switched to {FAMILIES[letter]['name']}")
        child = Variant(self.next_id(letter), knobs, bonus, parent=parent.id, note=", ".join(changes) or "bonus sizes",
                        mix=mix)
        self._age(child, parent)
        self.variants[child.id] = child
        self.save()
        return child


class StrategyRuntime:
    """Per round state of one variant, keyed by arena: which phase of the plan it is in, the 4
    strategy inputs added to the observation, the action mask, and the bonus reward."""

    def __init__(self, variant, max_steps=600):
        self.v = variant
        # the time input is on the 60 s scale (constants.CLOCK_STEPS) whatever the round length, so this is too
        self.max_steps = 600
        self.state = {}
        # the length of a decision in 100 ms steps (the env sets it every step, a Player from its rate), for loaded_for
        self.step_time = 1

    def phases(self):
        fam = FAMILIES[self.v.family]
        if "phases" in fam:
            return fam["phases"], fam["switch_on"]
        if fam.get("switch_on") == "out_of_arrows":
            return [self.v.family, self.v.knobs.get("then", "J")], "out_of_arrows"
        if self.v.knobs["patience"]:
            return [self.v.family, self.v.knobs["fallback"]], "patience"
        return [self.v.family], None

    def step(self, key, obs_row):
        """Update from the newest observation and return (inputs, mask) for the next action."""
        t = float(obs_row[OBS_ROUND_TIME]) * self.max_steps
        st = self.state.get(key)
        if st is None or t < st["t"] - 1:
            st = {"phase": 0, "switched_at": 0.0, "min_dist": 99.0, "dist": None, "t": t, "loaded_for": 0}
            self.state[key] = st
        st["t"] = t
        # 100 ms steps the crossbow has been loaded, for the aim_wait rule
        st["loaded_for"] = st.get("loaded_for", 0) + self.step_time if obs_row[OBS_CROSSBOW_LOADED] >= 0.5 else 0
        st["charging"] = bool(obs_row[OBS_CROSSBOW_CHARGE] > 0)  # the wall shooter's cover load count
        dist = float(obs_row[OBS_DIST]) * 8
        st["prev_dist"], st["dist"] = st["dist"], dist
        st["min_dist"] = min(st["min_dist"], dist)
        phases, switch_on = self.phases()
        if st["phase"] == 0 and len(phases) > 1:
            broke = obs_row[OBS_MY_SHIELD_CD] > 0 or obs_row[OBS_ENEMY_SHIELD_CD] > 0
            gave_up = t >= self.v.knobs["patience"] > 0 and st["min_dist"] > 5
            # no arrows left and nothing loaded: the ranged part is over, melee from here 
            empty = obs_row[OBS_ARROWS] <= 0 and obs_row[OBS_CROSSBOW_LOADED] < 0.5
            if ((switch_on == "shield_break" and broke) or (switch_on == "patience" and gave_up)
                    or (switch_on == "out_of_arrows" and empty)):
                st["phase"] = 1
                st["switched_at"] = t
        letter = phases[st["phase"]]
        st["letter"], st["first_letter"] = letter, phases[0]
        inputs = np.array([
            st["phase"],
            min((t - st["switched_at"]) / self.max_steps, 1.0),
            1.0 if t < self.v.knobs["rush"] else 0.0,
            1.0 if t >= self.v.knobs["jump_after"] else 0.0,
        ], dtype=np.float32)
        return inputs, self.mask(letter, t, obs_row, st["loaded_for"])

    def mask(self, letter, t, obs_row, loaded_for=0):
        m = np.ones(OFFSETS[-1], dtype=bool)
        rules = FAMILIES[letter].get("rules", {})
        holding_crossbow = obs_row[OBS_HOLDING_CROSSBOW] > 0.5
        holding_bow = obs_row[OBS_HOLDING_BOW] > 0.5
        if rules.get("no_shield") and not (holding_crossbow or holding_bow):
            m[OFFSETS[USE] + 1] = False
        if rules.get("no_axe"):
            m[OFFSETS[WEAPON] + AXE] = False
        if t < self.v.knobs["jump_after"]:
            m[OFFSETS[JUMP] + 1] = False
        if float(obs_row[OBS_TRUE_DIST]) * 32 <= FINE_AIM_BLOCKS:
            # fine turns only for far targets , close up the normal steps are fine enough
            m[OFFSETS[YAW + 1] - FINE_STEPS:OFFSETS[YAW + 1]] = False
            m[OFFSETS[PITCH + 1] - FINE_STEPS:OFFSETS[PITCH + 1]] = False
        drawing = obs_row[OBS_BOW_DRAW] > 0
        if holding_bow and not drawing and round(float(obs_row[OBS_ARROWS]) * ARROWS) <= self.v.knobs.get("arrow_reserve", 1):
            m[OFFSETS[USE] + 1] = False  # the last arrows are for the crossbow knockback combo
        if not (holding_crossbow or holding_bow):
            m[OFFSETS[LOCK] + 1] = False  # lock aim only with something to shoot
        if holding_crossbow or holding_bow:
            # never hit someone with the bow or crossbow in hand, it is a fist hit (1 damage).
            # Shoot, or switch to the axe or sword (a swing right after a switch is weak anyway, the charge restarts)
            m[OFFSETS[ATTACK] + 1:OFFSETS[ATTACK + 1]] = False
        if rules.get("no_melee"):
            # the aim drill: arrows are the only way to win, or it just walks up and axes zombie-
            m[OFFSETS[ATTACK] + 1:OFFSETS[ATTACK + 1]] = False
        if rules.get("crossbow_only"):
            m[OFFSETS[WEAPON]:OFFSETS[WEAPON + 1]] = False
            m[OFFSETS[WEAPON] + CROSSBOW] = True
            m[OFFSETS[WEAPON]] = bool(holding_crossbow)
        dist = float(obs_row[OBS_DIST]) * 8
        charging = obs_row[OBS_CROSSBOW_CHARGE] > 0
        # starts while they are over 6 blocks away, and once charging it finishes even as they close in
        # (rounds start 10 blocks apart, a load takes 1.25 s and slows the bot, so a rusher arrives first)
        if rules.get("no_ranged"):
            m[OFFSETS[WEAPON] + CROSSBOW] = False
            m[OFFSETS[WEAPON] + BOW] = False
        if holding_crossbow and obs_row[OBS_CROSSBOW_LOADED] >= 0.5 and 0 < loaded_for <= rules.get("aim_wait", 0):
            # aim_wait: no shot for this many steps after the load, time to aim (FIND-006: the drill bot fired the
            # instant it could, about 6,400 arrows per 128,000 decisions, the plan asked for about 5,000)
            m[OFFSETS[USE] + 1] = False
        if holding_crossbow and obs_row[OBS_CROSSBOW_LOADED] >= 0.5 and charging:
            # loaded while use is still held (1.21.11 loads at full charge without letting go): let go, a shot needs
            # a fresh press. Before, letting go was what loaded it, so the forced load below always ended released
            m[OFFSETS[USE]:OFFSETS[USE + 1]] = False
            m[OFFSETS[USE]] = True
        reload = rules.get("auto_reload") and obs_row[OBS_CROSSBOW_LOADED] < 0.5 and obs_row[OBS_ARROWS] > 0
        if not rules.get("no_opening") and (reload or (t < OPENING_LOAD_STEPS and obs_row[OBS_CROSSBOW_LOADED] < 0.5 and obs_row[OBS_ARROWS] > 0
                      and (dist > OPENING_LOAD_BLOCKS or charging))):
            # weapon: the crossbow (or keep it if it is already out)
            m[OFFSETS[WEAPON]:OFFSETS[WEAPON + 1]] = False
            m[OFFSETS[WEAPON] + CROSSBOW] = True
            m[OFFSETS[WEAPON]] = bool(holding_crossbow)
            # use: hold to charge once it is out (it loads at full charge, the rule above then lets go)
            m[OFFSETS[USE]:OFFSETS[USE + 1]] = False
            charged = obs_row[OBS_CROSSBOW_CHARGE] >= 1.0
            # a load only starts on a fresh press: if the button is still held from before (a shot, or a training
            # pause dropped the charge), let go for one step first, or the bot holds it forever (found by an audit)
            stale_hold = not charging and obs_row[OBS_LAST_USE] >= 0.5
            m[OFFSETS[USE] + (1 if holding_crossbow and not charged and not stale_hold else 0)] = True
        if (holding_crossbow or holding_bow) and shield_hold_on() and hold_fire(obs_row)[0]:
            # DEC-091 DEMO_SHIELD_HOLD: their shield is up and faces us, so a shot now is wasted. A loaded crossbow
            # gets no fresh press, a drawn bow stays drawn (until the shield drops, they turn, or the axe comes out)
            use = m[OFFSETS[USE]:OFFSETS[USE + 1]].copy()
            if holding_crossbow and obs_row[OBS_CROSSBOW_LOADED] >= 0.5 and obs_row[OBS_LAST_USE] < 0.5:
                m[OFFSETS[USE] + 1] = False
            if holding_bow and obs_row[OBS_BOW_DRAW] > 0:
                m[OFFSETS[USE]] = False
            if not m[OFFSETS[USE]:OFFSETS[USE + 1]].any():
                m[OFFSETS[USE]:OFFSETS[USE + 1]] = use  # never leave the use button without a choice
        return m

    def bonus(self, key, info):
        st = self.state.get(key, {})
        letter = st.get("letter", self.v.family)
        # The switch to melee comes the step after the last shot, while that arrow still flies (from an audit), so it
        # was settled under the melee letter: L's arrow_hits never paid on it and W's miss and take back never
        # charged. Arrows fired in the first phase settle under it, for at most ARROW_SETTLE_STEPS after the switch
        hits, misses = int(info.get("arrow_hits", 0)), int(info.get("arrow_misses", 0))
        out = st.get("arrows_out", 0)
        arrow_letter = letter
        if (st.get("phase") == 1 and out > 0 and "first_letter" in st
                and st.get("t", 0) - st.get("switched_at", 0) <= ARROW_SETTLE_STEPS):
            arrow_letter = st["first_letter"]
        shots = int(info.get("shots", 0)) if st.get("phase", 0) == 0 else 0
        st["arrows_out"] = max(0, out + shots - hits - misses)
        # only the arrow terms take the first letter's sizes, the rest stay the melee letter's (an audit found the whole
        # bonus switched back, so J's shield break and punish terms went unpaid for up to 2.5 s)
        active = {k: w for k, w in self.v.active_bonus(letter).items() if k not in ARROW_TERMS}
        active.update({k: w for k, w in self.v.active_bonus(arrow_letter).items() if k in ARROW_TERMS})
        # after a fallback the letter can be one this variant has no sizes for, use that letter's defaults
        weights = {**active, **self.v.bonus}
        if "cover_loads" in active or "cover_hits" in active:
            cover_events(st, info)
        dt = info.get("step_time", 1)  # per step bonuses below are per 100 ms of the state
        r = 0.0
        for k, w in weights.items():
            if k not in active:
                continue
            if k in info and isinstance(info[k], (int, float)):
                v = info[k] - info.get("arrow_hits_weak_bow", 0) if k == "arrow_hits" else info[k]  # BUG-093
                r += w * v * (dt if k in PER_STEP_BONUS else 1)
        d = info.get("dist", 9)
        if "shield_vs_axe" in active and info.get("shield_up") and info.get("enemy_weapon") == "axe" and d < 4:
            r += weights["shield_vs_axe"] * dt
        if "corner" in active and info.get("corner_dist", 99) < 2.5:
            r += weights["corner"] * dt
        if "spacing" in active and 3.3 <= d <= 4.8:
            r += weights["spacing"] * dt
        if "too_close" in active and d < 2.2:
            r += weights["too_close"] * dt
        t = st.get("t", 0)
        if t < self.v.knobs["rush"] and st.get("prev_dist") is not None:
            r += 0.02 * max(0.0, st["prev_dist"] - st["dist"])
        if not FAMILIES[letter].get("rules", {}).get("shield_free"):
            r += SHIELD_IDLE * info.get("shield_idle", 0) * dt  # a raised shield with nothing to block (reward.py)
        r += (self.v.knobs["aggression"] - 1.0) * info.get("dealt", 0)
        r -= (self.v.knobs["caution"] - 1.0) * info.get("taken", 0)
        return r
