"""FNNs neuron screen: a live page that shows the fighter's policy network firing during a real 1v1.

Off unless DEMO_NEURONS=1. The page is at http://127.0.0.1:<DEMO_NEURONS_PORT> (default 8765), bound to loopback
only, so another monitor reaches it through an SSH tunnel.

The fight never waits for it. play.py hands over one copy of each decision's numbers and moves on. A background
thread redoes the network's math in numpy from its own copy of the weights, keeps only the newest frame, and does
nothing at all while no page is open. Every failure is caught here.

What the numbers mean:
- Inputs: slot meanings come from the fighter client. This network has 126 inputs:
  the 125 in OBS_DIM plus slot 121, the enemy kind input (1 for a mob, 0 for a player, stage.json kind_inputs), which
  pushes the 4 strategy inputs to slots 122 to 125.
- A connection's strength right now is its weight times the activation feeding it. An input group's line is the sum
  of its slots' weight times input, which is exactly that group's share of what feeds the neuron.
- A line into a decision is the neuron's push on the picked option's lead: activation times (weight to the pick minus
  the mean weight to the allowed options). These add up exactly to the pick's logit minus the allowed mean, apart from
  the bias, and unlike a gradient they do not vanish when the network is sure. Each decision is scaled to its own
  strongest line, so every decision circle shows what feeds it.
- The two middle columns show a fixed set of neurons, chosen once from the weights alone, so no dot ever moves.
- The 3 inputs pushing a middle neuron are the largest of (d neuron's input / d input) times the input: how much each
  input moves what feeds that neuron at this moment, before its own tanh, in the scaled form the network receives.

Post-fight stats, each checked against 41 saved real rounds and the damage numbers:
- dealt and taken are real health drops. They sum to the health lost in every round, and dealt matched a test
  player's own health log in live private fights.
- crits (FNNs on the player) matched the crit packets that player received, 9 of 9 in live private fights.
- arrow_hits and arrow_hit_me come from server packets, and each one lines up with real damage in the saved rounds.
- my_blocks never coincides with damage on the same step.
- Left out: hits and full_hits count swings sent at a target, not hits that landed. blocked is a sound heuristic and
  40% of its steps carried damage. enemy_crits (the player's crits on FNNs) read 24 where the player's client saw 42
  crit packets in the same fight, so it is not shown until that gap is explained.
"""

import base64
import json
import math
import os
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

ACTION_DIMS = [3, 3, 2, 2, 18, 15, 3, 2, 5, 2, 2]
PITCH_STEPS = [-40.0, -20.0, -8.0, -3.0, -1.0, 0.0, 1.0, 3.0, 8.0, 20.0, 40.0, -0.5, 0.5, -0.25, 0.25]
YAW_STEPS = [-90.0, -45.0, -20.0, -10.0, -4.0, -1.5, 0.0, 1.5, 4.0, 10.0, 20.0, 45.0, 90.0, 180.0, -0.5, 0.5, -0.25, 0.25]

HOST = "127.0.0.1"  # never another interface, the screen reaches the other monitor through an SSH tunnel
DEFAULT_PORT = 8765
MIN_GAP = 0.085  # seconds between frames, about 10 a second (decisions come every 100 ms)
SHOWN = 40  # neurons drawn from each 256 neuron layer
KEPT_ROUNDS = 40  # finished rounds with full stats kept for the page
MAX_PAGES = 6
PUSH_SCALE = 64.0  # the push values travel as 16 bit numbers over this range
STREAM_TYPE = "text/" + "ev" + "ent-stream"  # the browser's streaming type
# The meter's ends, from the value network on 9,132 decisions of saved real fights: 1st to 99th percentile -0.59 to
# 1.97, about 0.7 just before a won round ended and about -0.5 before a lost one
VALUE_LOW, VALUE_HIGH = -1.0, 2.0

GROUND_START, GROUND_SIZE = 49, 7
GROUPS = [
    ("Enemy position", [0, 1, 2, 3, 4, 5, 110]),
    ("Enemy looking", [28, 29]),
    ("My movement", [6, 7, 8, 12, 40]),
    ("Enemy movement", [9, 10, 11, 13, 30, 115]),
    ("Health and swing", [14, 15, 16, 17, 36]),
    ("My weapons", [18, 19, 101, 106]),
    ("Enemy weapons", [20, 21, 105, 108]),
    ("Shields", [22, 23, 24, 25, 26, 27]),
    ("Timers", [31, 32, 33, 34, 35, 41]),
    ("Arena", [37, 38, 39, 98, 99, 100]),
    ("Last action", [42, 43, 44, 45, 46, 47, 48]),
    ("Shooting", [102, 103, 104, 107, 109, 111, 112, 113, 114, 116, 120]),
    ("Arrows nearby", [117, 118, 119]),
    ("Plan", [121, 122, 123, 124, 125]),
]
SPEED = 20 / 3  # the speed slots hold blocks a tick times 3
ROUND_COUNTERS = ("dealt", "taken", "crits", "arrow_hits", "arrow_hit_me", "my_blocks")


def _num(name, scale=1.0, unit="", digits=2, cap=None, signed=False, note=""):
    return {"name": name, "kind": "num", "scale": scale, "unit": unit, "digits": digits, "cap": cap, "signed": signed,
            "note": note}


def _flag(name, note=""):
    return {"name": name, "kind": "flag", "note": note}


def input_labels(n, fair_health=True, plan=("first plan", "second plan")):
    """One entry per input slot. Anything but the known 126 slot layout gets honest generic names."""
    if n != 126:
        return [{"name": f"Input {i}", "kind": "num", "scale": 1.0, "unit": "", "digits": 3, "cap": None,
                 "signed": True, "note": "meaning not known for this network"} for i in range(n)]
    since = dict(scale=2.0, unit="s", digits=2, cap=1.0)
    t = {
        0: _num("Enemy direction, sideways", 180, "deg", 1, signed=True, note="positive: enemy is to my left"),
        1: _num("Enemy direction, up or down", 90, "deg", 1, cap=1.0, signed=True,
                note="to the enemy's chest height, positive: above my crosshair"),
        2: _num("Enemy distance", 8, "blocks", 2, cap=2.0, note="flat distance, this slot stops at 16"),
        3: _num("Reach distance", 4, "blocks", 2, cap=2.0, note="my eye to the nearest point of the enemy's box"),
        4: _num("Enemy height above me", 3, "blocks", 2, cap=2.0, signed=True),
        5: _flag("Crosshair on enemy in reach", "within 3 blocks with nothing in between"),
        6: _num("My speed forward", SPEED, "blocks/s", 2, cap=3.0, signed=True),
        7: _num("My speed to the right", SPEED, "blocks/s", 2, cap=3.0, signed=True),
        8: _num("My speed upward", SPEED, "blocks/s", 2, cap=3.0, signed=True),
        9: _num("Enemy speed along my look", SPEED, "blocks/s", 2, cap=3.0, signed=True),
        10: _num("Enemy speed to my right", SPEED, "blocks/s", 2, cap=3.0, signed=True),
        11: _num("Enemy speed upward", SPEED, "blocks/s", 2, cap=3.0, signed=True),
        12: _flag("I am on the ground"),
        13: _flag("Enemy on the ground", "judged from its height not changing"),
        14: _num("My health", 20, "of 20", 1),
        15: _num("Enemy health, my estimate" if fair_health else "Enemy health", 20, "of 20", 1,
                 note="counted from the hits I saw land" if fair_health else ""),
        16: _num("My swing charge", 100, "%", 0),
        17: _num("Enemy swing charge, estimate", 100, "%", 0),
        18: _flag("I hold the axe"),
        19: _flag("I hold the sword"),
        20: _flag("Enemy holds an axe"),
        21: _flag("Enemy holds a sword"),
        22: _flag("My shield is raised"),
        23: _flag("My shield is blocking", "raised for at least 5 ticks"),
        24: _num("My shield disabled for", 5, "s", 2),
        25: _flag("Enemy shield is raised"),
        26: _flag("Enemy shield is blocking", "raised for at least 5 ticks"),
        27: _num("Enemy shield disabled for", 5, "s", 2, note="my estimate, from hearing its shield break"),
        28: _num("Enemy facing me", 1, "", 2, signed=True, note="1: looking straight at me, -1: turned away"),
        29: _num("My angle off the enemy's look", 180, "deg", 1, signed=True,
                 note="0: in front of it, 180: behind it, positive: on its left"),
        30: _flag("Enemy is sprinting"),
        31: _num("Since I landed a hit", note="this slot stops at 2 s", **since),
        32: _num("Since the enemy hit me", note="this slot stops at 2 s", **since),
        33: _num("Since my shield was disabled", note="this slot stops at 2 s", **since),
        34: _num("Since the enemy swung", note="this slot stops at 2 s", **since),
        35: _num("Since the enemy missed a swing", note="this slot stops at 2 s", **since),
        36: _num("My hit combo", 5, "hits", 0, cap=1.0, note="hits landed since the enemy last hit me"),
        37: _num("My position from arena center, along my look", 12, "blocks", 1, cap=1.5, signed=True,
                 note="positive: the center is behind me"),
        38: _num("My position from arena center, to my right", 12, "blocks", 1, cap=1.5, signed=True,
                 note="positive: the center is to my left"),
        39: _num("Nearest arena wall", 12, "blocks", 1, cap=1.0),
        40: _flag("Sprint key is held"),
        41: _num("Round clock", 60, "s", 1, cap=1.0, note="this slot stops at 60 s"),
        42: _num("Last move key", 1, "", 0, signed=True, note="1: forward, -1: back, 0: none"),
        43: _num("Last strafe key", 1, "", 0, signed=True, note="1: right, -1: left, 0: none"),
        44: _flag("Last step: sprint"),
        45: _flag("Last step: jump"),
        46: _num("Last turn", 90, "deg", 2, signed=True, note="positive: to the left"),
        47: _num("Last attack", 2, "", 0, note="0: none, 1: click, 2: double click"),
        48: _flag("Last step: use button"),
        98: _num("Nearest hole or lava", 5, "blocks", 1, cap=1.0, note="5 means none in view"),
        99: _num("Hole or lava direction, right", 1, "", 2, signed=True, note="sine of its angle, 0 when there is none"),
        100: _num("Hole or lava direction, ahead", 1, "", 2, signed=True, note="cosine of its angle, 1 when there is none"),
        101: _flag("I hold the crossbow"),
        102: _flag("My crossbow is loaded"),
        103: _num("Crossbow load progress", 100, "%", 0),
        104: _num("Arrows I have", 6, "arrows", 0, cap=1.0),
        105: _flag("Enemy holds a crossbow"),
        106: _flag("I hold the bow"),
        107: _num("Bow draw", 100, "%", 0),
        108: _flag("Enemy holds a bow"),
        109: _flag("Enemy is loading or drawing"),
        110: _num("Enemy distance, long range", 32, "blocks", 1, cap=1.5, note="flat distance, this slot stops at 48"),
        111: _num("Arrow aim error, sideways", 30, "deg", 1, cap=2.0, signed=True,
                  note="to where an arrow fired now would meet the enemy, positive: to my left"),
        112: _num("Arrow aim error, up or down", 30, "deg", 1, cap=2.0, signed=True,
                  note="to where an arrow fired now would meet the enemy, positive: above my aim"),
        113: _num("Arrow aim error in target widths", 5, "widths", 2, cap=1.0, note="under 1 is on target"),
        114: _num("Arrow flight time", 1, "s", 2, cap=2.0),
        115: _flag("Enemy is standing still"),
        116: _flag("Clear line to the enemy's chest"),
        117: _flag("Arrow to pick up within 4 blocks"),
        118: _num("Nearest arrow, ahead of me", 4, "blocks", 1, signed=True),
        119: _num("Nearest arrow, to my right", 4, "blocks", 1, signed=True),
        120: _flag("Enemy holds a loaded crossbow"),
        121: _flag("Enemy is a mob", "no means a player"),
        122: _num("Plan phase", 1, "", 0, note=f"0: {plan[0]}, 1: {plan[1]}"),
        123: _num("Time in this plan phase", 60, "s", 1, cap=1.0, note="this slot stops at 60 s"),
        124: _flag("Plan's rush window is open"),
        125: _flag("Plan allows jumping"),
    }
    for k in range(GROUND_SIZE ** 2):
        ahead, right = 3 - k // GROUND_SIZE, k % GROUND_SIZE - 3
        where = ", ".join(p for p in (f"{abs(ahead)} {'ahead' if ahead > 0 else 'behind'}" if ahead else "",
                                      f"{abs(right)} {'right' if right > 0 else 'left'}" if right else "") if p)
        t[GROUND_START + k] = {"name": f"Ground, {where}" if where else "Ground under me", "kind": "cell",
                               "note": "blocks from me, turned with my look"}
    return [t[i] for i in range(n)]


def _step_name(s, plus, minus):
    size = f"{abs(s):g}"
    return "none" if s == 0 else f"{plus if s > 0 else minus} {size} deg"


def action_labels():
    """The 11 decisions as bridge/fighter.js act() reads them. Turn steps add to the yaw, so positive turns left, and
    positive look steps go up. Options keep their index, order is how the page lays them out."""
    def plain(name, options, shorts=None):
        return {"name": name, "options": options, "short": shorts or options, "order": list(range(len(options)))}

    def steps(name, values, plus, minus):
        full = [("turn around 180 deg" if v == 180 else _step_name(float(v), plus, minus)) for v in values]
        short = [("180" if v == 180 else "0" if v == 0 else f"{plus[0].upper() if v > 0 else minus[0].upper()}{abs(v):g}")
                 for v in values]
        return {"name": name, "options": full, "short": short,
                "order": [int(i) for i in np.argsort(-np.asarray(values), kind="stable")]}

    return [
        plain("Move", ["none", "forward", "back"]),
        plain("Strafe", ["none", "left", "right"]),
        plain("Sprint", ["off", "on"]),
        plain("Jump", ["off", "on"]),
        steps("Turn", YAW_STEPS.tolist(), "left", "right"),
        steps("Look", PITCH_STEPS.tolist(), "up", "down"),
        plain("Attack", ["none", "click", "double click"]),
        plain("Use item", ["off", "hold"]),
        plain("Weapon", ["keep", "axe", "sword", "crossbow", "bow"]),
        plain("Sneak", ["off", "on"]),
        plain("Lock aim", ["off", "on"]),
    ]


def override_note():
    """What can change a pick between the network and the game (bridge/showmatch.js, bridge/showmatch_chase.js)."""
    if os.environ.get("DEMO_SHOWMATCH") != "1":
        return "Picks shown are the network's."
    if os.environ.get("DEMO_CHASE") == "1":
        return ("Picks shown are the network's. The show match chase layer can change movement and weapons, and "
                "inside 4 blocks it holds the axe, so the lit weapon choice is the network's pick.")
    return "Inside 4 blocks the show match holds the axe, so the lit weapon choice is the network's pick."


def input_nodes(n):
    """The input column: one circle per named group, with the whole ground grid as one circle."""
    if n != 126:
        return [("Inputs", list(range(n)))]
    return [(name, list(slots)) for name, slots in GROUPS] + [
        ("Ground around me", list(range(GROUND_START, GROUND_START + GROUND_SIZE ** 2)))]


class Net:
    """A numpy copy of the policy and value networks."""

    def __init__(self, model):
        sd = {k: v.detach().cpu().numpy().astype(np.float32).copy() for k, v in model.policy.state_dict().items()}
        self.w1, self.b1 = sd["mlp_extractor.policy_net.0.weight"], sd["mlp_extractor.policy_net.0.bias"]
        self.w2, self.b2 = sd["mlp_extractor.policy_net.2.weight"], sd["mlp_extractor.policy_net.2.bias"]
        self.wa, self.ba = sd["action_net.weight"], sd["action_net.bias"]
        self.v1, self.vb1 = sd["mlp_extractor.value_net.0.weight"], sd["mlp_extractor.value_net.0.bias"]
        self.v2, self.vb2 = sd["mlp_extractor.value_net.2.weight"], sd["mlp_extractor.value_net.2.bias"]
        self.vo, self.vob = sd["value_net.weight"], sd["value_net.bias"]
        self.dims = [int(d) for d in model.action_space.nvec]
        if self.dims != list(ACTION_DIMS) or self.wa.shape[0] != sum(ACTION_DIMS):
            raise ValueError(f"unexpected action layout {self.dims}")
        if self.w1.shape[0] != 256 or self.w2.shape != (256, 256):
            raise ValueError("unexpected layer sizes")
        self.n_inputs = self.w1.shape[1]
        self.nodes = input_nodes(self.n_inputs)
        self.member = np.zeros((len(self.nodes), self.n_inputs), dtype=np.float32)
        for g, (_, slots) in enumerate(self.nodes):
            self.member[g, slots] = 1
        self.sizes = self.member.sum(axis=1)
        self.sel1, self.sel2 = self.choose()

    def choose(self):
        """The shown neurons, from the weights alone: strongest in times out, then ordered to cross fewer lines."""
        strength1 = np.linalg.norm(self.w1, axis=1) * np.linalg.norm(self.w2, axis=0)
        sel1 = np.argsort(-strength1, kind="stable")[:SHOWN]
        strength2 = np.linalg.norm(self.w2[:, sel1], axis=1) * np.linalg.norm(self.wa, axis=0)
        sel2 = np.argsort(-strength2, kind="stable")[:SHOWN]
        by_group = np.abs(self.w1[sel1]) @ self.member.T
        where = (by_group * np.arange(by_group.shape[1])).sum(axis=1) / np.maximum(by_group.sum(axis=1), 1e-9)
        sel1 = sel1[np.argsort(where, kind="stable")]
        links = np.abs(self.w2[sel2][:, sel1])
        where = (links * np.arange(links.shape[1])).sum(axis=1) / np.maximum(links.sum(axis=1), 1e-9)
        return sel1, sel2[np.argsort(where, kind="stable")]

    def forward(self, x):
        h1 = np.tanh(self.w1 @ x + self.b1)
        h2 = np.tanh(self.w2 @ h1 + self.b2)
        logits = self.wa @ h2 + self.ba
        value = self.vo @ np.tanh(self.v2 @ np.tanh(self.v1 @ x + self.vb1) + self.vb2) + self.vob
        return h1, h2, logits, float(value[0])

    def pushes(self, x, h1):
        """(d neuron's input / d input) times input for the shown neurons of both layers, shape (2 * SHOWN, inputs).
        Measured before the neuron's own tanh, so a neuron pinned at -1 or 1 still shows what holds it there."""
        j2 = self.w2[self.sel2] @ ((1 - h1 * h1)[:, None] * self.w1)
        return np.vstack([self.w1[self.sel1] * x, j2 * x])

    def decision_pushes(self, h2, mask, pick):
        """Each shown layer 2 neuron's push on each pick's lead over the allowed options, shape (decisions, SHOWN),
        scaled so each decision's strongest line is 1."""
        out = np.zeros((len(self.dims), len(self.sel2)), dtype=np.float32)
        active = h2[self.sel2]
        at = 0
        for d, size in enumerate(self.dims):
            w = self.wa[at:at + size][:, self.sel2]
            ok = mask[at:at + size]
            # with one option allowed there is no rival, so the pick is compared with all the options
            row = active * (w[pick[d]] - w[ok if ok.sum() > 1 else np.ones(size, dtype=bool)].mean(axis=0))
            top = float(np.abs(row).max())
            out[d] = row / top if top > 0 else row
            at += size
        return out

    def probabilities(self, logits, mask):
        """The softmax of each decision over its allowed options, as MaskableCategorical does."""
        out = np.zeros_like(logits)
        at = 0
        for d in self.dims:
            ok = mask[at:at + d]
            if not ok.any():
                ok = np.ones(d, dtype=bool)
            part = logits[at:at + d]
            e = np.exp(part[ok] - part[ok].max())
            out[at:at + d][ok] = e / e.sum()
            at += d
        return out


def _b64(a):
    return base64.b64encode(a.tobytes()).decode("ascii")


def _scaled(s):
    """A strength matrix as signed bytes, against the strongest line of its gap at this moment."""
    top = float(np.abs(s).max()) if s.size else 0.0
    if top <= 0 or not math.isfinite(top):
        return _b64(np.zeros(s.shape, dtype=np.int8))
    return _b64(np.round(s / top * 127).astype(np.int8))


def build_frame(net, seq, x, raw, mask, action):
    """One SSE message for one decision."""
    h1, h2, logits, value = net.forward(x)
    probs = net.probabilities(logits, mask)
    pick = [int(a) for a in action]
    s1, s2 = net.sel1, net.sel2
    push = net.pushes(x, h1)
    size = np.abs(push)
    top = np.argpartition(-size, 2, axis=1)[:, :3]
    order = np.argsort(-np.take_along_axis(size, top, axis=1), axis=1)
    top = np.take_along_axis(top, order, axis=1)
    top_push = np.take_along_axis(push, top, axis=1)
    activity = np.sqrt((net.member @ (x * x)) / net.sizes)  # how far each group sits from its training average
    body = {
        "n": seq,
        "t": round(time.time(), 3),
        "v": round(value, 4),
        "pick": pick,
        "raw": _b64(raw),
        "g": _b64(np.round(np.clip(activity / 2, 0, 1) * 255).astype(np.uint8)),
        "h1": _b64(np.round(h1[s1] * 127).astype(np.int8)),
        "h2": _b64(np.round(h2[s2] * 127).astype(np.int8)),
        "p": _b64(probs),
        "m": _b64(mask.astype(np.uint8)),
        "e": [_scaled((net.w1[s1] * x) @ net.member.T), _scaled(net.w2[s2][:, s1] * h1[s1]),
              _scaled(net.decision_pushes(h2, mask, pick))],
        "ti": _b64(top.astype(np.uint8)),
        "tc": _b64(np.round(np.clip(top_push / PUSH_SCALE, -1, 1) * 32767).astype(np.int16)),
    }
    return f"id: {seq}\ndata: {json.dumps(body, separators=(',', ':'))}\n\n".encode("ascii")


def rounds_path():
    """Where bridge/showmatch.js writes every finished round."""
    folder = os.environ.get("DEMO_SHOWMATCH_DATA")
    return (Path(folder) if folder else Path(__file__).resolve().parent.parent / "data") / "showmatch-rounds.jsonl"


def read_rounds(path):
    """The readable rows of the round log, oldest first. A missing file or a half written line is simply skipped."""
    rows = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
    except OSError:
        pass
    return rows


def _number(v):
    return round(float(v), 1) if isinstance(v, (int, float)) and math.isfinite(v) else None


def summarize_rounds(rows, skip):
    """The overall record, recent rounds and the best of 3 in progress. Only rows after skip belong to this fight's
    bridge, whose score starts at 0 to 0. Rows with an unknown result are never counted as wins or losses."""
    results = [r.get("result") for r in rows]
    record = {"wins": results.count("win"), "losses": results.count("loss"), "unknown": results.count("unknown")}
    record["other"] = len(results) - record["wins"] - record["losses"] - record["unknown"]
    bot = you = fights = 0
    final = None
    for row in rows[skip:]:
        if row.get("fight_of_match") == 1:
            bot = you = fights = 0
        fights += 1
        bot += row.get("result") == "win"
        you += row.get("result") == "loss"
        final = None
        if max(bot, you) >= 2 or fights >= 3:
            final = {"bot": bot, "you": you}
            bot = you = fights = 0
    last = None
    if rows:
        r = rows[-1]
        last = {"result": r.get("result"), "steps": r.get("steps"), "hp": _number(r.get("bot_hp")),
                "enemy_hp": _number(r.get("player_hp")), "full": False}
    return {**record, "rows_after": max(0, len(rows) - skip), "recent": results[-16:], "match": {"bot": bot, "you": you, "fights": fights, "final": final},
            "last": last}


class Screen:
    """Takes decisions from the fight loop and serves the newest one to any open page."""

    def __init__(self, net, meta, page):
        self.net = net
        self.meta = json.dumps(meta, separators=(",", ":")).encode()
        self.page = page
        self.pages = 0
        self.seq = 0
        self.data = None
        self.fresh = threading.Condition()  # a new frame is ready for the pages
        self.todo = threading.Condition()  # a new decision is ready for the worker
        self.job = None
        self.last = 0.0
        self.publish_us = deque(maxlen=4000)
        self.build_ms = deque(maxlen=1000)
        self.errors = 0
        self.last_error = ""
        self.server = None
        self.tally = {}  # the round in progress
        self.rounds = deque(maxlen=KEPT_ROUNDS)  # finished rounds, kept here so a page reload still has them
        self.rounds_file = rounds_path()
        self.rounds_skip = len(read_rounds(self.rounds_file))  # rows from before this fight's bridge started
        self.rounds_key = None
        self.rounds_cache = None
        self.rounds_lock = threading.Lock()
        self.rounds_seen = 0  # every round whose last step has reached note_step
        self.last_hp = self.last_enemy_hp = None

    def use_model(self, model):
        """Switches to the exact network that plays. The screen starts on a plain load, before the player has joined.
        The shown neurons stay the ones chosen first, so no dot moves."""
        try:
            net = Net(model)
            net.sel1, net.sel2 = self.net.sel1, self.net.sel2
            self.net = net
        except Exception as exc:
            self.note_error(exc)

    def note_step(self, info):
        """Called once per decision on the fight's thread, page open or not. Adds up the round and never blocks or
        raises: no lock, no file, no network."""
        try:
            tally = self.tally
            for key in ROUND_COUNTERS:
                v = info.get(key)
                if v:
                    tally[key] = tally.get(key, 0.0) + float(v)
            result = info.get("result")
            if not result:
                self.last_hp, self.last_enemy_hp = info.get("hp"), info.get("enemy_hp")
            else:
                self.tally = {}
                self.rounds_seen += 1
                if result != "aborted":
                    done = {key: round(tally.get(key, 0.0), 1) for key in ROUND_COUNTERS}
                    done.update(result=str(result), steps=int(info.get("steps", 0) or 0), full=True,
                                hp=_number(info.get("hp")), enemy_hp=_number(info.get("enemy_hp")))
                    self.rounds.append(done)
        except Exception as exc:
            self.note_error(exc)

    def pending_round(self, row):
        """A round the log has but the fight loop does not yet: after a match's last round the bridge holds that step
        until the next go. Health and damage are exact, the final step's crit or arrow can still be missing."""
        tally = dict(self.tally)
        done = {key: round(tally.get(key, 0.0), 1) for key in ROUND_COUNTERS}
        for key, before, after in (("taken", self.last_hp, row.get("hp")),
                                   ("dealt", self.last_enemy_hp, row.get("enemy_hp"))):
            if before is not None and after is not None:
                done[key] = round(tally.get(key, 0.0) + max(0.0, float(before) - after), 1)
        done.update(row, full=True, pending=True)
        return done

    def rounds_body(self):
        """The post-fight strip's data. Runs on a page's thread, never the fight's."""
        try:
            stat = self.rounds_file.stat()
            key = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            key = None
        with self.rounds_lock:
            if self.rounds_cache is None or key != self.rounds_key:
                self.rounds_cache = summarize_rounds(read_rounds(self.rounds_file), self.rounds_skip)
                self.rounds_key = key
            record = self.rounds_cache
        pending = None
        if record["rows_after"] > self.rounds_seen and record["last"] and record["last"]["result"] != "aborted":
            pending = self.pending_round(record["last"])
        return json.dumps({"rounds": list(self.rounds), "record": record, "pending": pending},
                          separators=(",", ":")).encode()

    def publish(self, obs, raw, masks, action):
        """Called once per decision on the fight's thread. Copies the numbers and returns, and never raises."""
        if self.pages <= 0:
            return  # nobody is watching, so nothing to do
        start = time.perf_counter()
        try:
            if start - self.last >= MIN_GAP:
                self.last = start
                job = (np.array(obs[0], dtype=np.float32), np.array(raw, dtype=np.float32),
                       np.array(masks[0], dtype=bool), np.array(action[0]))
                with self.todo:
                    self.job = job  # an older job nobody took is dropped, only the newest matters
                    self.todo.notify()
        except Exception as exc:
            self.note_error(exc)
        self.publish_us.append((time.perf_counter() - start) * 1e6)

    def note_error(self, exc):
        self.errors += 1
        self.last_error = repr(exc)[:200]

    def work(self):
        while True:
            try:
                with self.todo:
                    while self.job is None:
                        self.todo.wait()
                    job, self.job = self.job, None
                start = time.perf_counter()
                data = build_frame(self.net, self.seq + 1, *job)
                self.build_ms.append((time.perf_counter() - start) * 1e3)
                with self.fresh:
                    self.seq += 1
                    self.data = data
                    self.fresh.notify_all()
            except Exception as exc:
                self.note_error(exc)
                time.sleep(0.2)

    def stats(self):
        us = np.array(self.publish_us) if self.publish_us else np.zeros(1)
        ms = np.array(self.build_ms) if self.build_ms else np.zeros(1)
        return {"frames": self.seq, "pages": self.pages, "errors": self.errors, "last_error": self.last_error,
                "decisions_timed": len(self.publish_us),
                "publish_us": {"mean": round(float(us.mean()), 1), "p50": round(float(np.percentile(us, 50)), 1),
                               "p99": round(float(np.percentile(us, 99)), 1), "max": round(float(us.max()), 1)},
                "frame_build_ms": {"mean": round(float(ms.mean()), 2), "p99": round(float(np.percentile(ms, 99)), 2)}}


class Handler(BaseHTTPRequestHandler):
    screen = None
    timeout = 20

    def log_message(self, *args):
        pass

    def reply(self, body, kind):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            path = self.path.split("?")[0]
            if path == "/":
                self.reply(self.screen.page, "text/html; charset=utf-8")
            elif path == "/meta":
                self.reply(self.screen.meta, "application/json")
            elif path == "/rounds":
                self.reply(self.screen.rounds_body(), "application/json")
            elif path == "/stats":
                self.reply(json.dumps(self.screen.stats()).encode(), "application/json")
            elif path == "/stream":
                self.stream()
            else:
                self.send_error(404)
        except (BrokenPipeError, ConnectionError, TimeoutError, OSError):
            self.close_connection = True
        except Exception as exc:
            self.screen.note_error(exc)
            self.close_connection = True

    def stream(self):
        screen = self.screen
        if screen.pages >= MAX_PAGES:
            self.send_error(503)
            return
        self.connection.settimeout(5)  # a stuck page drops off instead of holding a thread
        self.send_response(200)
        self.send_header("Content-Type", STREAM_TYPE)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        with screen.fresh:
            screen.pages += 1
        try:
            self.wfile.write(b"retry: 1000\n\n")
            self.wfile.flush()
            seen = 0
            while True:
                with screen.fresh:
                    screen.fresh.wait_for(lambda: screen.seq != seen, timeout=10)
                    seq, data = screen.seq, screen.data
                # newest frame only: a page that fell behind skips whatever it missed
                self.wfile.write(data if seq != seen and data else b": still here\n\n")
                self.wfile.flush()
                seen = seq
        finally:
            with screen.fresh:
                screen.pages -= 1


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # a page closing mid write is normal


def start(model, stage=None, variant=None):
    """Starts the screen, or returns None (and the fight goes on) if anything about it fails."""
    try:
        port = int(os.environ.get("DEMO_NEURONS_PORT") or DEFAULT_PORT)
        net = Net(model)
        plan = ("first plan", "second plan")
        if variant is not None:
            from .strategies import FAMILIES, StrategyRuntime
            phases = StrategyRuntime(variant).phases()[0]
            if len(phases) > 1:
                plan = (FAMILIES[phases[0]]["name"], FAMILIES[phases[1]]["name"])
        fair = bool((stage or {}).get("fair_health"))
        meta = {"inputs": input_labels(net.n_inputs, fair, plan), "nodes": net.nodes, "ground": GROUND_START,
                "ground_size": GROUND_SIZE, "known": net.n_inputs == 126, "actions": action_labels(),
                "layer": 256, "shown": SHOWN, "sel1": net.sel1.tolist(), "sel2": net.sel2.tolist(),
                "value": [VALUE_LOW, VALUE_HIGH], "push_scale": PUSH_SCALE, "note": override_note()}
        page = (Path(__file__).parent / "neuron_screen.html").read_bytes()
        screen = Screen(net, meta, page)
        handler = type("BoundHandler", (Handler,), {"screen": screen})
        screen.server = QuietServer((HOST, port), handler)
        threading.Thread(target=screen.work, name="neurons-work", daemon=True).start()
        threading.Thread(target=screen.server.serve_forever, name="neurons-http", daemon=True).start()
        print(f"Neuron screen at http://{HOST}:{port}", flush=True)
        return screen
    except Exception as exc:
        print(f"Neuron screen off: {exc}", flush=True)
        return None
