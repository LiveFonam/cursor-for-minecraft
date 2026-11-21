"""The farming watcher: planted loops, honest skill, normal learning and held publishing."""

from __future__ import annotations

import json

import numpy as np

from fighter import actions as A
from fighter import campaign as K
from fighter.campaign import BLOCKER, Runtime, prepare_config, run_role
from fighter.drills import BlockingDrill, ShootingDrill
from fighter.experts import ExpertStore
from fighter.farmwatch import (
    DOMINANT,
    FarmWatch,
    Ledger,
    WatchSettings,
    empty_tally,
    find_flags,
    find_loop,
    fit_to_mask,
    goal_rose,
    idle_pattern,
    judge,
    play,
    summarize,
)

FAST = WatchSettings(min_episodes=8, replay_envs=4)


class PlantedDrill(BlockingDrill):
    """A blocking drill that pays a shaping bonus for holding the use key."""

    def _reward(self, ev, actions):
        base = super()._reward(ev, actions)
        bonus = 0.25 * (actions[:, A.USE] > 0)
        self.reward_terms["planted"] = bonus
        return base + bonus


def planted_env(n: int, seed: int) -> PlantedDrill:
    return PlantedDrill(n, seed=seed)


def plain_env(n: int, seed: int) -> BlockingDrill:
    return BlockingDrill(n, seed=seed)


def hold_use() -> np.ndarray:
    pattern = idle_pattern(len(A.NVEC))
    pattern[0, A.USE] = 1
    return pattern


def tally(episodes=100, reward=0.0, goal=0.0, terms=None, counters=None) -> dict:
    out = empty_tally(("blocked", "taken"))
    out["episodes"] = episodes
    out["decisions"] = episodes * 10
    out["minutes"] = episodes / 10.0
    out["reward"] = [reward * episodes, (reward * reward + 0.01) * episodes]
    out["goal"] = [goal * episodes, (goal * goal + 0.01) * episodes]
    out["terms"] = {name: value * episodes for name, value in (terms or {}).items()}
    out["counters"] = {name: value * episodes / 10.0 for name, value in (counters or {}).items()}
    return out


def play_scripted(env, pattern, rollouts: int, steps: int) -> np.ndarray:
    """Step an environment with one action cycle and return the actions taken."""
    sizes = np.asarray(env.action_space.nvec)
    taken = []
    for t in range(rollouts * steps):
        want = np.repeat(pattern[t % len(pattern)][None], env.num_envs, axis=0)
        chosen = fit_to_mask(want, env.action_masks(), sizes)
        env.step_async(chosen)
        env.step_wait()
        taken.append(chosen)
    return np.stack(taken)


def test_ledger_terms_add_up_to_the_reward():
    env = plain_env(4, 3)
    env.reset()
    play_scripted(env, hold_use(), 1, 700)
    drained = env.farm_tally()
    assert drained["episodes"] > 0
    assert abs(sum(drained["terms"].values()) - drained["reward"][0]) < 1e-6
    assert "other" not in drained["terms"]


def test_ledger_reports_terms_per_episode():
    ledger = Ledger(2, ("goal",), 1.0)
    ledger.step(np.array([1.0, 2.0]), {"goal": np.array([1.0, 0.0]), "bonus": np.array([0.0, 2.0])},
                np.array([1.0, 0.0]), {}, {})
    episodes = ledger.finish([0, 1])
    assert episodes[0]["goal"] == 1.0
    assert episodes[1]["bonus"] == 2.0


def test_planted_loop_is_confirmed(tmp_path):
    env = planted_env(8, 5)
    env.reset()
    watch = FarmWatch(tmp_path, "blocker", settings=FAST)
    idle = idle_pattern(len(A.NVEC))
    play_scripted(env, idle, 1, 700)
    watch.absorb(env.farm_tally(), ["blocking"])
    assert watch.check(5_600, None, planted_env) is None
    actions = play_scripted(env, hold_use(), 1, 700)
    watch.absorb(env.farm_tally(), ["blocking"])
    report = watch.check(11_200, actions, planted_env)
    assert report is not None
    assert report["verdict"]["confirmed"] is True
    assert report["rewards_changed"] is False
    assert any(flag["check"] == DOMINANT and flag["term"] == "planted" for flag in report["flags"])
    assert watch.confirmed
    assert watch.summary()["publishing"] == "held"


def test_real_blocking_skill_is_not_a_farm():
    looped = play(plain_env, hold_use(), FAST)
    nothing = play(plain_env, idle_pattern(len(A.NVEC)), FAST)
    verdict = judge(looped, nothing, FAST.confirm_margin)
    assert verdict["earns_more"] is True
    assert verdict["confirmed"] is False


def test_avoiding_a_penalty_is_not_a_farm():
    make = lambda n, seed: ShootingDrill(n, seed=seed)
    looped = play(make, hold_use(), FAST)
    nothing = play(make, idle_pattern(len(A.NVEC)), FAST)
    verdict = judge(looped, nothing, FAST.confirm_margin)
    assert verdict["earns_more"] is True
    assert verdict["confirmed"] is False


def test_rising_goal_raises_no_flags():
    before = summarize(tally(reward=1.0, goal=1.0, terms={"blocked": 1.0}))
    after = summarize(tally(reward=3.0, goal=3.0, terms={"blocked": 3.0}))
    assert goal_rose(after, before)
    assert find_flags(after, before, None, FAST) == []


def test_rising_drill_score_counts_as_goal():
    before = {**summarize(tally(reward=1.0)), "score": 0.2}
    after = {**summarize(tally(reward=3.0, terms={"facing": 3.0})), "score": 0.6}
    checks = {flag["check"] for flag in find_flags(after, before, None, FAST)}
    assert "reward up, goal flat" not in checks


def test_reward_up_with_flat_goal_is_flagged():
    before = summarize(tally(reward=1.0, terms={"facing": 1.0}))
    after = summarize(tally(reward=3.0, terms={"facing": 3.0}))
    checks = {flag["check"] for flag in find_flags(after, before, None, FAST)}
    assert "reward up, goal flat" in checks
    assert DOMINANT in checks


def test_counter_jump_is_flagged():
    before = summarize(tally(counters={"shield_raises": 5.0}))
    after = summarize(tally(counters={"shield_raises": 60.0}))
    assert [flag["check"] for flag in find_flags(after, before, None, FAST)] == ["counter jump"]


def test_short_cycle_is_found():
    pattern = np.repeat(idle_pattern(len(A.NVEC)), 3, axis=0)
    pattern[1, A.USE] = 1
    actions = np.repeat(np.tile(pattern, (12, 1))[:, None, :], 8, axis=1)
    loop = find_loop(actions, FAST)
    assert loop["period"] == 3
    assert loop["share"] == 1.0
    assert not loop["idle"]


def test_varied_actions_are_not_a_cycle():
    rng = np.random.default_rng(1)
    actions = np.stack([rng.integers(0, A.NVEC, size=(48, len(A.NVEC))) for _ in range(8)], axis=1)
    assert find_loop(actions, FAST) is None


class PlantedSource:
    """Feeds a role tallies that look like a farm and replays the planted drill."""

    def __init__(self):
        self.calls = 0

    def farm_tally(self) -> dict:
        self.calls += 1
        share = 0.5 if self.calls <= 2 else 5.0
        return tally(reward=share, terms={"planted": share})

    def recent_actions(self) -> np.ndarray:
        return np.repeat(np.repeat(hold_use(), 32, axis=0)[:, None, :], 8, axis=1)

    def replay_env(self, n: int, seed: int) -> PlantedDrill:
        return planted_env(n, seed)


def test_confirmed_farm_stops_publishing_and_keeps_training(tmp_path):
    root = tmp_path / "run"
    prepare_config(
        root,
        {
            "smoke": True,
            "n_envs": 4,
            "n_steps": 8,
            "batch_size": 16,
            "drill_steps": 256,
            "test_every": 32,
            "checkpoint_every": 32,
            "snapshot_every": 64,
        },
    )
    published_before = []

    def passing(policy):
        return {"passed": True, "score": 0.9}

    def note(role_run):
        if role_run.watch.confirmed and not published_before:
            published_before.append(len(role_run.state["published"]))

    code = run_role(
        root,
        BLOCKER,
        Runtime(threads=1, min_free_gb=0.0, fighter_device="cpu"),
        pass_test=passing,
        after_rollout=note,
        farm_source=PlantedSource(),
        watch_settings=FAST,
    )
    assert code == K.EXIT_DONE
    status = json.loads((root / BLOCKER / "status.json").read_text())
    assert status["steps"] >= 256
    assert status["farm"]["publishing"] == "held"
    assert status["farm"]["confirmed"]["confirmed"] is True
    assert published_before
    assert len(status["published"]) == published_before[0]
    lines = [json.loads(line) for line in (root / BLOCKER / "checkpoints.jsonl").read_text().splitlines()]
    assert lines[-1]["held"] is True
    current = ExpertStore(root / "experts").current("blocker")
    assert current is None or current["version"] <= published_before[0]
    progress = K.write_progress(root)
    assert progress["farm"][BLOCKER]["publishing"] == "held"


def test_normal_learning_raises_no_false_alarm(tmp_path):
    root = tmp_path / "run"
    prepare_config(
        root,
        {
            "n_envs": 64,
            "n_steps": 32,
            "batch_size": 512,
            "drill_steps": 40_960,
            "test_every": 10_240,
            "checkpoint_every": 10_240,
            "snapshot_every": 20_480,
        },
    )
    code = run_role(
        root,
        BLOCKER,
        Runtime(threads=1, min_free_gb=0.0, fighter_device="cpu"),
        pass_test=lambda policy: {"passed": False, "score": 0.0},
    )
    assert code == K.EXIT_DONE
    status = json.loads((root / BLOCKER / "status.json").read_text())
    assert status["farm"]["checks"] >= 2
    assert status["farm"]["confirmed"] is None
    assert status["farm"]["publishing"] == "open"
    assert (root / BLOCKER / "farm" / "windows.jsonl").exists()
