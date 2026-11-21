"""Catch reward farming while training runs.

Every environment keeps a `Ledger` that sums each reward term, the goal and a few
behaviour counters over each episode. A campaign role drains these sums after every
rollout into the open window of its `FarmWatch`. At every checkpoint the watcher
closes the window, compares it with the window before it and reads the actions of
the latest rollout. It flags:

  reward up, goal flat     total reward rose while the goal did not rise
  dominant shaping term    one shaping term earns most of the positive reward
  action loop              most sampled arenas repeat one short action cycle
  counter jump             a behaviour count per minute jumped far past the window before

A flag writes a farm report and replays the suspected loop as a scripted bot on
fresh arenas next to a bot that does nothing. The farm is confirmed when the loop
earns more reward per step than doing nothing, the extra comes from shaping terms
rather than the goal, and those shaping terms pay the loop a net positive amount.
A loop that only avoids a penalty or earns the real goal is reported but not
confirmed. A confirmed farm holds publishing for the rest of the run while training
goes on. Rewards are never changed here.
"""

from __future__ import annotations

import json
import math
import os
import tempfile
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from . import actions as A
from . import constants as C

OTHER = "other"
LABEL_TOLERANCE = 1e-6
REWARD_UP = "reward up, goal flat"
DOMINANT = "dominant shaping term"
LOOP = "action loop"
JUMP = "counter jump"
KEPT_REPORTS = 20


@dataclass(frozen=True)
class WatchSettings:
    """Thresholds of the watcher. Per episode and per minute values are window means."""

    min_episodes: int = 64
    goal_z: float = 2.0
    score_rise: float = 0.02
    reward_z: float = 3.0
    reward_rise: float = 0.1
    earned_share: float = 0.5
    term_share: float = 0.6
    term_min: float = 0.5
    loop_share: float = 0.5
    loop_match: float = 0.9
    max_period: int = 8
    loop_arenas: int = 64
    loop_decisions: int = 64
    counter_ratio: float = 3.0
    counter_min: float = 10.0
    replay_envs: int = 16
    replay_episodes: int = 1
    replay_seed: int = 424_242
    confirm_margin: float = 0.002


def empty_tally(goal_terms=()) -> dict:
    """Return sums over no episodes."""
    return {
        "episodes": 0,
        "decisions": 0,
        "minutes": 0.0,
        "reward": [0.0, 0.0],
        "goal": [0.0, 0.0],
        "terms": {},
        "counters": {},
        "goal_terms": sorted(goal_terms),
    }


def merge_tallies(tallies) -> dict:
    """Add up tallies from several simulator batches or rollouts."""
    out = empty_tally()
    goal_terms: set[str] = set()
    for tally in tallies:
        out["episodes"] += tally["episodes"]
        out["decisions"] += tally["decisions"]
        out["minutes"] += tally["minutes"]
        for key in ("reward", "goal"):
            out[key] = [a + b for a, b in zip(out[key], tally[key])]
        for key in ("terms", "counters"):
            for name, value in tally[key].items():
                out[key][name] = out[key].get(name, 0.0) + value
        goal_terms.update(tally["goal_terms"])
    out["goal_terms"] = sorted(goal_terms)
    return out


class Ledger:
    """Sums of the running episode of every arena: each reward term, the goal and counters."""

    def __init__(self, n: int, goal_terms: tuple[str, ...], minutes_per_decision: float):
        self.n = n
        self.goal_terms = tuple(goal_terms)
        self.minutes_per_decision = minutes_per_decision
        self.reward = np.zeros(n)
        self.goal = np.zeros(n)
        self.length = np.zeros(n, dtype=np.int64)
        self.terms: dict[str, np.ndarray] = {}
        self.counters: dict[str, np.ndarray] = {}
        self.held: dict[str, np.ndarray] = {}
        self.last_reward = np.zeros(n)
        self.last_goal = np.zeros(n)
        self.last_terms: dict[str, np.ndarray] = {}
        self.tally = empty_tally(goal_terms)

    def _add(self, sums: dict[str, np.ndarray], name: str, value) -> None:
        total = sums.get(name)
        if total is None:
            total = sums[name] = np.zeros(self.n)
        total += value

    def step(self, reward, terms: dict, goal, counts: dict, edges: dict) -> None:
        """Add one step. Reward that the named terms do not explain goes to the `other` term."""
        reward = np.asarray(reward, dtype=float)
        terms = {name: np.asarray(value, dtype=float) for name, value in terms.items()}
        rest = reward - sum(terms.values(), np.zeros(self.n))
        if np.abs(rest).max(initial=0.0) > LABEL_TOLERANCE:
            terms[OTHER] = rest
        for name, value in terms.items():
            self._add(self.terms, name, value)
        self.last_reward = reward
        self.last_goal = np.asarray(goal, dtype=float)
        self.last_terms = terms
        self.reward += reward
        self.goal += self.last_goal
        self.length += 1
        for name, value in counts.items():
            self._add(self.counters, name, value)
        for name, state in edges.items():
            state = np.asarray(state, dtype=bool)
            before = self.held.get(name)
            self._add(self.counters, name, state if before is None else state & ~before)
            self.held[name] = state.copy()

    def finish(self, rows) -> list[dict[str, float]]:
        """Close the episodes of the given arenas and return the reward terms of each."""
        rows = np.asarray(rows, dtype=np.int64)
        tally = self.tally
        lengths = self.length[rows]
        tally["episodes"] += len(rows)
        tally["decisions"] += int(lengths.sum())
        tally["minutes"] += float(lengths.sum()) * self.minutes_per_decision
        for key, values in (("reward", self.reward[rows]), ("goal", self.goal[rows])):
            tally[key][0] += float(values.sum())
            tally[key][1] += float((values * values).sum())
        episodes: list[dict[str, float]] = [{} for _ in rows]
        for name, sums in self.terms.items():
            values = sums[rows]
            tally["terms"][name] = tally["terms"].get(name, 0.0) + float(values.sum())
            for record, value in zip(episodes, values):
                record[name] = float(value)
            sums[rows] = 0.0
        for name, sums in self.counters.items():
            tally["counters"][name] = tally["counters"].get(name, 0.0) + float(sums[rows].sum())
            sums[rows] = 0.0
        for state in self.held.values():
            state[rows] = False
        self.reward[rows] = 0.0
        self.goal[rows] = 0.0
        self.length[rows] = 0
        return episodes

    def drain(self) -> dict:
        """Return the sums of the episodes finished since the last call and start new ones."""
        tally, self.tally = self.tally, empty_tally(self.goal_terms)
        return tally


def summarize(tally: dict) -> dict:
    """Turn a tally into means per episode, per step and per minute."""
    n = tally["episodes"]

    def mean_se(pair: list[float]) -> tuple[float, float]:
        if n == 0:
            return 0.0, 0.0
        mean = pair[0] / n
        spread = max(pair[1] / n - mean * mean, 0.0)
        return mean, math.sqrt(spread / max(n - 1, 1))

    reward, reward_se = mean_se(tally["reward"])
    goal, goal_se = mean_se(tally["goal"])
    minutes = tally["minutes"]
    return {
        "episodes": n,
        "decisions": tally["decisions"],
        "reward": reward,
        "reward_se": reward_se,
        "goal": goal,
        "goal_se": goal_se,
        "reward_per_step": tally["reward"][0] / max(tally["decisions"], 1),
        "terms": {name: value / max(n, 1) for name, value in sorted(tally["terms"].items())},
        "per_minute": {
            name: value / minutes if minutes > 0 else 0.0 for name, value in sorted(tally["counters"].items())
        },
        "goal_terms": list(tally["goal_terms"]),
    }


def _z(diff: float, a: float, b: float) -> float:
    spread = math.hypot(a, b)
    if spread > 0.0:
        return diff / spread
    return 0.0 if diff == 0.0 else math.copysign(math.inf, diff)


def _phase_modes(seq: np.ndarray, period: int) -> np.ndarray:
    pattern = np.zeros((period, seq.shape[1]), dtype=np.int64)
    for phase in range(period):
        rows = seq[phase::period]
        for head in range(seq.shape[1]):
            pattern[phase, head] = np.bincount(rows[:, head]).argmax()
    return pattern


def _canonical(pattern: np.ndarray) -> np.ndarray:
    rotations = [np.roll(pattern, -shift, axis=0) for shift in range(len(pattern))]
    return min(rotations, key=lambda rows: tuple(rows.ravel().tolist()))


def is_idle(pattern: np.ndarray) -> bool:
    """Return whether a cycle presses nothing, ignoring the weapon and aim lock heads."""
    idle = A.idle_action()
    heads = [h for h in range(min(len(idle), pattern.shape[1])) if h not in (A.WEAPON, A.LOCK_AIM)]
    return bool((pattern[:, heads] == idle[heads]).all())


def find_loop(actions, settings: WatchSettings | None = None) -> dict | None:
    """Return the short action cycle repeated by the most sampled arenas, or None.

    `actions` holds (decisions, arenas, heads). An arena repeats a cycle of p decisions
    when every head matches its value p decisions earlier at least `loop_match` of the time.
    """
    s = settings or WatchSettings()
    if actions is None:
        return None
    actions = np.asarray(actions, dtype=np.int64)
    if actions.ndim != 3 or len(actions) < 3:
        return None
    sample = np.clip(actions[-s.loop_decisions :, : s.loop_arenas], 0, None)
    steps, arenas, _ = sample.shape
    groups: dict[bytes, list] = {}
    for arena in range(arenas):
        seq = sample[:, arena]
        for period in range(1, s.max_period + 1):
            if steps < 3 * period:
                break
            if (seq[period:] == seq[:-period]).mean(axis=0).min() >= s.loop_match:
                pattern = _canonical(_phase_modes(seq, period))
                key = bytes([period]) + pattern.tobytes()
                groups.setdefault(key, [pattern, 0])[1] += 1
                break
    if not groups:
        return None
    pattern, count = max(groups.values(), key=lambda item: item[1])
    return {
        "source": "repeated cycle",
        "period": len(pattern),
        "pattern": pattern.tolist(),
        "arenas": count,
        "sampled": arenas,
        "share": count / arenas,
        "idle": is_idle(pattern),
        "name": describe(pattern),
    }


def common_action(actions) -> dict | None:
    """Return the most common choice of every head held as a one decision cycle."""
    if actions is None:
        return None
    actions = np.asarray(actions, dtype=np.int64)
    if actions.ndim != 3 or actions.size == 0:
        return None
    flat = np.clip(actions.reshape(-1, actions.shape[-1]), 0, None)
    pattern = np.array([[np.bincount(flat[:, h]).argmax() for h in range(flat.shape[1])]])
    return {
        "source": "most common action",
        "period": 1,
        "pattern": pattern.tolist(),
        "arenas": 0,
        "sampled": int(actions.shape[1]),
        "share": 0.0,
        "idle": is_idle(pattern),
        "name": describe(pattern),
    }


_FORWARD = ("none", "forward", "back")
_STRAFE = ("none", "left", "right")
_ITEMS = ("sword", "axe", "bow", "crossbow")


def _value_name(head: int, value: int) -> str:
    if head == A.YAW and value < len(A.YAW_DELTAS):
        return f"{A.YAW_DELTAS[value]:+g}"
    if head == A.PITCH and value < len(A.PITCH_DELTAS):
        return f"{A.PITCH_DELTAS[value]:+g}"
    if head == A.FORWARD and value < len(_FORWARD):
        return _FORWARD[value]
    if head == A.STRAFE and value < len(_STRAFE):
        return _STRAFE[value]
    if head == A.WEAPON and value < len(A.WEAPON_CHOICES):
        item = int(A.WEAPON_CHOICES[value])
        return "keep" if item < 0 else _ITEMS[item]
    return str(int(value))


def describe(pattern) -> str:
    """Name a cycle by the heads it presses."""
    pattern = np.asarray(pattern, dtype=np.int64)
    idle = A.idle_action()
    parts = []
    for head, name in enumerate(A.HEADS[: pattern.shape[1]]):
        values = pattern[:, head]
        if (values == idle[head]).all():
            continue
        shown = [_value_name(head, int(v)) for v in values]
        parts.append(f"{name} {shown[0]}" if len(set(shown)) == 1 else f"{name} {'/'.join(shown)}")
    body = ", ".join(parts) if parts else "no input"
    return f"{len(pattern)} decision cycle: {body}"


def goal_rose(window: dict, previous: dict, settings: WatchSettings | None = None) -> bool:
    """Return whether the goal per episode or the drill score rose between two windows."""
    s = settings or WatchSettings()
    if _z(window["goal"] - previous["goal"], window["goal_se"], previous["goal_se"]) >= s.goal_z:
        return True
    before, after = previous.get("score"), window.get("score")
    return before is not None and after is not None and after >= before + s.score_rise


def find_flags(window: dict, previous: dict, loop: dict | None, settings: WatchSettings | None = None) -> list[dict]:
    """Compare a closed window with the one before it and return every flag raised."""
    s = settings or WatchSettings()
    goal_terms = set(window["goal_terms"])
    terms, before = window["terms"], previous["terms"]
    shaping = {name: value for name, value in terms.items() if name not in goal_terms}
    flags = []

    rise = window["reward"] - previous["reward"]
    reward_z = _z(rise, window["reward_se"], previous["reward_se"])
    earned = {
        name: value - before.get(name, 0.0)
        for name, value in shaping.items()
        if value > 0.0 and value > before.get(name, 0.0)
    }
    if (
        not goal_rose(window, previous, s)
        and reward_z >= s.reward_z
        and rise >= s.reward_rise * max(abs(previous["reward"]), 1.0)
        and sum(earned.values()) >= s.earned_share * rise
    ):
        flags.append(
            {
                "check": REWARD_UP,
                "reward_per_episode": [round(previous["reward"], 4), round(window["reward"], 4)],
                "z": round(min(reward_z, 999.0), 2),
                "goal_per_episode": [round(previous["goal"], 4), round(window["goal"], 4)],
                "earned_by": {k: round(v, 4) for k, v in sorted(earned.items(), key=lambda kv: -kv[1])},
            }
        )

    gross = sum(value for value in terms.values() if value > 0.0)
    for name, value in shaping.items():
        if value >= s.term_min and gross > 0.0 and value >= s.term_share * gross:
            flags.append(
                {"check": DOMINANT, "term": name, "per_episode": round(value, 4), "share": round(value / gross, 3)}
            )

    net = sum(shaping.values())
    if loop is not None and loop["share"] >= s.loop_share and not loop["idle"] and net > 0.0:
        flags.append(
            {
                "check": LOOP,
                "loop": loop["name"],
                "share": round(loop["share"], 3),
                "shaping_per_episode": round(net, 4),
            }
        )

    for name, rate in window["per_minute"].items():
        old = previous["per_minute"].get(name, 0.0)
        if rate >= s.counter_ratio * old and rate - old >= s.counter_min:
            flags.append({"check": JUMP, "counter": name, "per_minute": [round(old, 2), round(rate, 2)]})
    return flags


def fit_to_mask(actions: np.ndarray, mask: np.ndarray, sizes) -> np.ndarray:
    """Keep each chosen value the mask allows and take the first allowed one otherwise."""
    out = np.array(actions, dtype=np.int64)
    rows = np.arange(len(out))
    start = 0
    for head, size in enumerate(np.asarray(sizes, dtype=np.int64)):
        allowed = mask[:, start : start + size]
        pick = out[:, head]
        inside = (pick >= 0) & (pick < size)
        ok = inside & allowed[rows, np.clip(pick, 0, size - 1)]
        out[:, head] = np.where(ok, pick, allowed.argmax(axis=1))
        start += size
    return out


def idle_pattern(width: int) -> np.ndarray:
    """Return the do-nothing action as a one decision cycle of the given width."""
    pattern = np.zeros((1, width), dtype=np.int64)
    idle = A.idle_action()
    pattern[0, : min(width, len(idle))] = idle[: min(width, len(idle))]
    return pattern


def play(make_env: Callable, pattern, settings: WatchSettings | None = None) -> dict:
    """Play a cycle open loop on fresh arenas and return reward, goal and terms per step."""
    s = settings or WatchSettings()
    env = make_env(s.replay_envs, s.replay_seed)
    env.reset()
    sizes = np.asarray(env.action_space.nvec)
    cycle = np.zeros((len(pattern), len(sizes)), dtype=np.int64)
    width = min(len(sizes), np.asarray(pattern).shape[1])
    cycle[:, :width] = np.asarray(pattern)[:, :width]
    per_episode = round(env.max_ticks * env.sim.cfg.decisions_per_second / C.TICKS_PER_SECOND)
    decisions = max(1, s.replay_episodes * per_episode)
    reward = goal = 0.0
    terms: dict[str, float] = {}
    for t in range(decisions):
        want = np.repeat(cycle[t % len(cycle)][None], env.num_envs, axis=0)
        env.step_async(fit_to_mask(want, env.action_masks(), sizes))
        env.step_wait()
        ledger = env.ledger
        reward += float(ledger.last_reward.sum())
        goal += float(ledger.last_goal.sum())
        for name, value in ledger.last_terms.items():
            terms[name] = terms.get(name, 0.0) + float(value.sum())
    count = decisions * env.num_envs
    goal_terms = list(env.ledger.goal_terms)
    env.close()
    return {
        "reward_per_step": reward / count,
        "goal_per_step": goal / count,
        "terms_per_step": {name: value / count for name, value in sorted(terms.items())},
        "goal_terms": goal_terms,
        "decisions": decisions,
        "arenas": int(env.num_envs),
    }


def judge(loop: dict, nothing: dict, margin: float) -> dict:
    """Confirm a farm when the loop out earns doing nothing through shaping that pays it."""
    goal_terms = set(loop["goal_terms"])
    names = set(loop["terms_per_step"]) | set(nothing["terms_per_step"])
    excess = loop["reward_per_step"] - nothing["reward_per_step"]
    shaping = sum(
        loop["terms_per_step"].get(name, 0.0) - nothing["terms_per_step"].get(name, 0.0)
        for name in names
        if name not in goal_terms
    )
    paid = sum(value for name, value in loop["terms_per_step"].items() if name not in goal_terms)
    earns_more = excess > margin
    confirmed = earns_more and shaping > max(margin, 0.5 * excess) and paid > margin
    return {
        "earns_more": bool(earns_more),
        "shaping_paid_per_step": round(paid, 6),
        "excess_per_step": round(excess, 6),
        "shaping_excess_per_step": round(shaping, 6),
        "goal_per_step": [round(nothing["goal_per_step"], 6), round(loop["goal_per_step"], 6)],
        "confirmed": bool(confirmed),
    }


def name_suspect(flags: list[dict], suspect: dict) -> str:
    """Name the suspected loop by its cycle, the terms it earns and the counts that jumped."""
    terms = [flag["term"] for flag in flags if flag["check"] == DOMINANT]
    for flag in flags:
        if flag["check"] == REWARD_UP:
            terms.extend(list(flag["earned_by"])[:2])
    counters = [flag["counter"] for flag in flags if flag["check"] == JUMP]
    pieces = [suspect["name"]]
    if terms:
        pieces.append("earning " + ", ".join(dict.fromkeys(terms)))
    if counters:
        pieces.append("with " + ", ".join(counters) + " jumping")
    return ", ".join(pieces)


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(handle, "w") as out:
            json.dump(data, out, indent=2)
        os.replace(name, path)
    except BaseException:
        if os.path.exists(name):
            os.unlink(name)
        raise


class FarmWatch:
    """The farming watcher of one campaign role. Its state rides in the role checkpoint."""

    def __init__(
        self,
        folder: Path,
        role: str,
        log: Callable | None = None,
        settings: WatchSettings | None = None,
    ):
        self.folder = Path(folder) / "farm"
        self.role = role
        self.log = log
        self.settings = settings or WatchSettings()
        self.state = self.fresh_state()

    @staticmethod
    def fresh_state() -> dict:
        return {
            "open": empty_tally(),
            "context": None,
            "previous": None,
            "checks": 0,
            "flagged": 0,
            "confirmed": None,
            "last": None,
            "reports": [],
            "score": None,
        }

    def restore(self, state: dict | None) -> None:
        """Continue from a state saved in a checkpoint."""
        if state:
            self.state = state

    @property
    def confirmed(self) -> bool:
        """Return whether a farm was confirmed in this run."""
        return self.state["confirmed"] is not None

    def absorb(self, tally: dict, context) -> None:
        """Add the episodes of one rollout. A new stage or expert set starts a fresh comparison."""
        context = list(context)
        if context != self.state["context"]:
            self.state["context"] = context
            self.state["open"] = empty_tally()
            self.state["previous"] = None
        self.state["open"] = merge_tallies([self.state["open"], tally])

    def note_score(self, score: float) -> None:
        """Record the latest drill score, which counts as the real goal next to the episode goal."""
        self.state["score"] = float(score)

    def _log_window(self, steps: int, window: dict, flags: list[dict]) -> None:
        """Append the mean of every reward term per episode for this window."""
        record = {
            "steps": steps,
            "episodes": window["episodes"],
            "decisions": window["decisions"],
            "reward_per_episode": window["reward"],
            "goal_per_episode": window["goal"],
            "score": window.get("score"),
            "terms_per_episode": window["terms"],
            "counters_per_minute": window["per_minute"],
            "flags": [flag["check"] for flag in flags],
        }
        self.folder.mkdir(parents=True, exist_ok=True)
        with (self.folder / "windows.jsonl").open("a") as handle:
            handle.write(json.dumps(record) + "\n")

    def check(self, steps: int, actions, make_env: Callable) -> dict | None:
        """Close the window when it holds enough episodes, flag farming and investigate it.

        Return the farm report, or None when nothing was flagged.
        """
        s = self.settings
        tally = self.state["open"]
        if tally["episodes"] < s.min_episodes:
            return None
        window = summarize(tally)
        window["score"] = self.state.get("score")
        self.state["open"] = empty_tally(tally["goal_terms"])
        previous = self.state["previous"]
        self.state["previous"] = window
        self.state["checks"] += 1
        loop = find_loop(actions, s)
        flags = [] if previous is None else find_flags(window, previous, loop, s)
        self.state["last"] = {
            "steps": int(steps),
            "episodes": window["episodes"],
            "reward_per_episode": round(window["reward"], 4),
            "goal_per_episode": round(window["goal"], 4),
            "flags": [flag["check"] for flag in flags],
        }
        self._log_window(int(steps), window, flags)
        if not flags:
            return None
        return self._investigate(int(steps), window, previous, loop, actions, flags, make_env)

    def _investigate(self, steps, window, previous, loop, actions, flags, make_env) -> dict:
        s = self.settings
        suspect = loop or common_action(actions)
        report = {
            "role": self.role,
            "steps": steps,
            "flags": flags,
            "suspect": suspect,
            "window": window,
            "previous": previous,
            "rewards_changed": False,
        }
        verdict = {"confirmed": False}
        if suspect is None:
            verdict["error"] = "no actions to replay"
            report["name"] = "unknown loop"
        else:
            report["name"] = name_suspect(flags, suspect)
            pattern = np.asarray(suspect["pattern"], dtype=np.int64)
            try:
                looped = play(make_env, pattern, s)
                nothing = play(make_env, idle_pattern(pattern.shape[1]), s)
                verdict = judge(looped, nothing, s.confirm_margin)
                report["replay"] = {"loop": looped, "nothing": nothing}
            except Exception as error:
                verdict["error"] = repr(error)
        report["verdict"] = verdict
        first = verdict["confirmed"] and not self.confirmed
        held = verdict["confirmed"] or self.confirmed
        report["publishing"] = "held until the reward is fixed and reviewed" if held else "open"
        path = self.folder / f"report-{steps:012d}.json"
        _write_json(path, report)
        shown = f"{self.role}/farm/{path.name}"
        record = {"steps": steps, "name": report["name"], "confirmed": verdict["confirmed"], "report": shown}
        self.state["flagged"] += 1
        self.state["reports"] = (self.state["reports"] + [record])[-KEPT_REPORTS:]
        if first:
            self.state["confirmed"] = {**record, "excess_per_step": verdict.get("excess_per_step")}
        if self.log is not None:
            self.log("farm flagged", steps, checks=[flag["check"] for flag in flags], loop=report["name"], report=shown)
            event = "farm confirmed" if verdict["confirmed"] else "farm not confirmed"
            self.log(event, steps, loop=report["name"], excess_per_step=verdict.get("excess_per_step"), report=shown)
        return report

    def summary(self) -> dict:
        """Return what the progress file shows about farming in this role."""
        state = self.state
        return {
            "checks": state["checks"],
            "flagged": state["flagged"],
            "confirmed": state["confirmed"],
            "publishing": "held" if self.confirmed else "open",
            "last": state["last"],
            "reports": state["reports"][-3:],
        }


__all__ = [
    "FarmWatch",
    "Ledger",
    "WatchSettings",
    "common_action",
    "describe",
    "find_flags",
    "find_loop",
    "fit_to_mask",
    "goal_rose",
    "judge",
    "merge_tallies",
    "play",
    "summarize",
]
