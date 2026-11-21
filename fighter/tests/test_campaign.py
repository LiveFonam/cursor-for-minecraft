"""The campaign runner: resume, publishing, hot loading, stops and a run of all three roles."""

from __future__ import annotations

import json

import numpy as np
import pytest

from fighter import campaign as K
from fighter.campaign import BLOCKER, FIGHTER, SHOOTER, RoleLock, Runtime, prepare_config, run_role
from fighter.drills import blocking_report
from fighter.experts import ExpertStore
from fighter.policy import NumpyPolicy

TINY = {
    "smoke": True,
    "n_envs": 4,
    "n_steps": 8,
    "batch_size": 16,
    "fighter_steps": 128,
    "drill_steps": 64,
    "test_every": 32,
    "checkpoint_every": 32,
    "snapshot_every": 64,
}


def passing(policy):
    return {"passed": True, "score": 0.9}


def failing(policy):
    return {"passed": False, "score": 0.95}


def runtime(**extra) -> Runtime:
    return Runtime(threads=1, min_free_gb=0.0, fighter_device="cpu", **extra)


def campaign(root, trainer="lean", **extra):
    return prepare_config(root, {**TINY, "trainer": trainer, **extra})


def decisions(root) -> list[dict]:
    return [json.loads(line) for line in (root / "decisions.jsonl").read_text().splitlines()]


def same_policy(a, b) -> None:
    first = NumpyPolicy.load(a / "policy.npz")
    second = NumpyPolicy.load(b / "policy.npz")
    for (w, bias), (w2, bias2) in zip(first.layers, second.layers):
        np.testing.assert_array_equal(w, w2)
        np.testing.assert_array_equal(bias, bias2)


def training_log(folder) -> list[tuple]:
    path = folder / "progress.jsonl"
    if not path.exists():
        return []
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    return [(row["steps"], row["stage"], row["win_rate"], row["games"]) for row in rows]


@pytest.mark.parametrize(
    "trainer,role", [("lean", FIGHTER), ("lean", SHOOTER), ("sb3", FIGHTER), ("sb3", BLOCKER)]
)
def test_resume_gives_the_same_result_as_an_uninterrupted_run(tmp_path, trainer, role):
    whole, pieces = tmp_path / "whole", tmp_path / "pieces"
    campaign(whole, trainer, drill_steps=128)
    campaign(pieces, trainer, drill_steps=128)
    test = None if role == FIGHTER else passing
    assert run_role(whole, role, runtime(), test) == K.EXIT_DONE
    assert run_role(pieces, role, runtime(max_rollouts=1), test) == K.EXIT_STOPPED
    assert run_role(pieces, role, runtime(max_rollouts=2), test) == K.EXIT_STOPPED
    assert run_role(pieces, role, runtime(), test) == K.EXIT_DONE
    same_policy(whole / role, pieces / role)
    assert training_log(whole / role) == training_log(pieces / role)
    if role != FIGHTER:
        assert ExpertStore(whole / "experts").current(role)["weights"] == (
            ExpertStore(pieces / "experts").current(role)["weights"]
        )


def test_a_failed_expert_is_never_published(tmp_path):
    campaign(tmp_path, test_every=10**9)
    assert run_role(tmp_path, BLOCKER, runtime(), failing) == K.EXIT_DONE
    assert run_role(tmp_path, BLOCKER, runtime(), blocking_report) == K.EXIT_DONE
    root = tmp_path / "pieces"
    campaign(root, test_every=10**9)
    assert run_role(root, BLOCKER, runtime(), blocking_report) == K.EXIT_DONE
    for folder in (tmp_path, root):
        assert ExpertStore(folder / "experts").current(BLOCKER) is None
        assert not list((folder / "experts").glob("*/v*"))
    events = [d["event"] for d in decisions(root)]
    assert "pass test failed" in events and "published" not in events


def test_the_fighter_loads_a_new_expert_at_the_next_rollout_boundary(tmp_path):
    cfg = campaign(tmp_path)
    store = ExpertStore(tmp_path / "experts")
    seen = []

    def hook(run):
        seen.append(run.runner.trainer.host.local.env.interface.experts.versions()[SHOOTER])
        if run.rollouts == 2:
            store.publish(SHOOTER, NumpyPolicy.random(seed=1), passing(None), source={"campaign": cfg.id})
            store.publish(BLOCKER, NumpyPolicy.random(seed=2), passing(None), source={"campaign": "other"})

    assert run_role(tmp_path, FIGHTER, runtime(), after_rollout=hook) == K.EXIT_DONE
    assert seen == [None, None, 1, 1]
    history = [json.loads(line) for line in (tmp_path / FIGHTER / "checkpoints.jsonl").read_text().splitlines()]
    assert [(h["steps"], h["experts"][SHOOTER], h["experts"][BLOCKER]) for h in history] == [
        (32, None, None),
        (64, None, None),
        (96, 1, None),
        (128, 1, None),
        (128, 1, None),
    ]
    events = [(d["event"], d.get("expert")) for d in decisions(tmp_path)]
    assert ("loaded expert", SHOOTER) in events
    assert ("rejected expert", BLOCKER) in events
    assert json.loads((tmp_path / FIGHTER / "policy.json").read_text())["experts"][SHOOTER] == 1


def test_a_stop_request_ends_at_a_boundary_with_a_checkpoint(tmp_path):
    campaign(tmp_path)

    def hook(run):
        (tmp_path / "STOP").touch()

    assert run_role(tmp_path, FIGHTER, runtime(), after_rollout=hook) == K.EXIT_STOPPED
    status = json.loads((tmp_path / FIGHTER / "status.json").read_text())
    assert status["state"] == "stopped" and status["reason"] == "stop request" and status["steps"] == 32
    assert (tmp_path / FIGHTER / "checkpoint.pkl").exists()


def test_a_second_process_cannot_run_the_same_role(tmp_path):
    campaign(tmp_path)
    folder = tmp_path / SHOOTER
    folder.mkdir()
    lock = RoleLock(folder)
    try:
        assert run_role(tmp_path, SHOOTER, runtime(), passing) == K.EXIT_BUSY
    finally:
        lock.release()


def test_fixed_settings_cannot_change_but_budgets_can_grow(tmp_path):
    cfg = campaign(tmp_path)
    with pytest.raises(SystemExit):
        prepare_config(tmp_path, {"trainer": "sb3"})
    grown = prepare_config(tmp_path, {"fighter_steps": 256})
    assert grown.fighter_steps == 256 and grown.id == cfg.id


def test_smoke_run_of_all_three_roles(tmp_path):
    campaign(tmp_path)
    tests = {SHOOTER: passing, BLOCKER: failing}
    for role in (SHOOTER, BLOCKER):
        assert run_role(tmp_path, role, runtime(), tests[role]) == K.EXIT_DONE
    assert run_role(tmp_path, FIGHTER, runtime()) == K.EXIT_DONE
    progress = K.write_progress(tmp_path)
    assert {role: progress["roles"][role]["state"] for role in K.ROLES} == {
        SHOOTER: "done",
        BLOCKER: "done",
        FIGHTER: "done",
    }
    live = progress["experts"][SHOOTER]["published"]
    assert live >= 1 and progress["experts"][BLOCKER]["published"] is None
    assert progress["roles"][FIGHTER]["experts"] == {"mob": None, SHOOTER: live, BLOCKER: None}
    results = K.evaluate_fighter(tmp_path, ["idle"], games=1)
    assert results[0]["games"] == 25 and results[0]["experts"][SHOOTER] == live
