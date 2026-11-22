"""DEC-091 (his playtest): arrows missed a person who kept running or ran around, and went into his shield.

Three switches, each off unless its variable is 1, so every running or restarted process keeps the old behavior:

  DEMO_LEAD          the lead (fighter.js does the same). The old velocity was the movement over the last 3 ticks,
                       but another player's position comes every 2 ticks, so the 3 tick window held 1 or 2 position
                       updates and read 2/3 or 4/3 of the true speed, the same way all round (a bot decides on every
                       second tick). Now the window is 2 whole update periods (4 ticks for a player, 6 for a mob, whose
                       position comes every 3), and the target also moves on for the age of what we see (the ticks
                       since its position last changed) plus lead_latency(), before the flight time starts
  DEMO_SHIELD_HOLD   no shot into a raised shield that faces us (within the 90 degree blocking angle): a loaded
                       crossbow is not fired, a drawn bow stays drawn (strategies.py masks, skills.py LockShooter)
  DEMO_AIM_OFFSET    with lock aim at the shooting expert's range, the fine turn steps (up to 4 degrees sideways and
                       3 up or down) become offsets around the lead solution, so a learned shooter can correct it
                       (world.py client_act, fighter.js act)
"""

import os

import numpy as np

LEAD_PERIODS = 2  # the velocity window in whole position update periods
LEAD_HIST = 8  # ticks of seen positions kept, enough for 2 periods of a mob (6) plus one
PLAYER_PERIOD, MOB_PERIOD = 2, 3  # ticks between position updates (vanilla tracking: players 2, zombies 3)
OFFSET_YAW_MAX, OFFSET_PITCH_MAX = 4.0, 3.0  # degrees, the largest steps used as offsets


def lead_latency():
    """The ticks between what we see and the server tick the arrow leaves on, beyond the age of the last update.
    The default simulator draws 0 or 1 tick of network delay per round (World.update_seen), so its mean 0.5. Under
    DEMO_PLAYER_FIX (part of the v2 profile) the tracker always sends one tick later, so 1 (FIND-034 point 1: a
    fixed 0.5 ran every lead half a tick short there). DEMO_LEAD_LATENCY overrides both. Read when a shot is
    aimed, because the tools set the profile after their imports."""
    raw = os.environ.get("DEMO_LEAD_LATENCY")
    if raw:
        return float(raw)
    from .sim.constants import sim_fix
    return 1.0 if sim_fix("PLAYER_FIX") else 0.5


def lead_on():
    return os.environ.get("DEMO_LEAD") == "1"


def shield_hold_on():
    return os.environ.get("DEMO_SHIELD_HOLD") == "1"


def aim_offset_on():
    return os.environ.get("DEMO_AIM_OFFSET") == "1"


class LeadTracker:
    """The seen positions of the other side for every arena and side (World), one tick at a time."""

    def __init__(self, A):
        self.hist = np.zeros((A, 2, LEAD_HIST, 3))
        self.count = np.zeros((A, 2), dtype=np.int64)
        self.vel = np.zeros((A, 2, 3))
        self.since = np.zeros((A, 2), dtype=np.int64)  # ticks since the seen position last changed

    def reset(self, idx):
        self.hist[idx] = 0.0
        self.count[idx] = 0
        self.vel[idx] = 0.0
        self.since[idx] = 0

    def tick(self, T, seen, other_is_mob, fallback):
        """seen (A, 2, 3) this tick, other_is_mob (A, 2) whether what each side sees is a mob, fallback (A, 2, 3) the
        old 3 tick velocity, used until the window is full."""
        slot = T % LEAD_HIST
        last = self.hist[:, :, (T - 1) % LEAD_HIST]
        moved = np.any(np.abs(seen - last) > 1e-9, axis=-1) | (self.count == 0)
        self.since = np.where(moved, 0, self.since + 1)
        self.hist[:, :, slot] = seen
        self.count = np.minimum(self.count + 1, LEAD_HIST)
        L = LEAD_PERIODS * np.where(other_is_mob, MOB_PERIOD, PLAYER_PERIOD)
        first = np.take_along_axis(self.hist, ((T - L) % LEAD_HIST)[:, :, None, None], axis=2)[:, :, 0]
        full = self.count > L
        self.vel = np.where(full[:, :, None], (seen - first) / L[:, :, None], fallback)

    def extra(self, other_is_mob):
        """Ticks the target moves on before the arrow leaves: the age of the last update (at most a period) plus
        the network delay."""
        period = np.where(other_is_mob, MOB_PERIOD, PLAYER_PERIOD)
        return np.minimum(self.since, period - 1) + lead_latency()


def hold_fire(raw):
    """Rows of raw observations (n, OBS_DIM) whose target holds a raised shield toward us: within the 90 degree
    blocking angle of its look (vanilla blocks a hit from the front half). Slots 25 enemyShieldUp and 29
    enemyFacingAngle (angle over pi, 0 when it looks straight at us)."""
    raw = np.atleast_2d(raw)
    return (raw[:, 25] > 0.5) & (np.abs(raw[:, 29]) <= 0.5)
