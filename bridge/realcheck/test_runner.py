"""Checks the policy runner against training's takeover, its JavaScript copy, and its reply time."""

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest

from fighter import actions as A
from fighter import constants as C
from fighter.experts import BLOCKER, SHOOTER, ExpertStore, TakeoverInterface, ExpertSet
from fighter.obs import OBS_DIM, build_masks, build_obs
from fighter.policy import NumpyPolicy
from fighter.sim import Sim, SimConfig

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(HERE))

from agents_policy import Player, takeover  # noqa: E402
from export_policy import export  # noqa: E402

NODE = shutil.which("node")
CAMPAIGN = "test-campaign"


@pytest.fixture(scope="module")
def saved(tmp_path_factory):
    root = tmp_path_factory.mktemp("campaign")
    (root / "campaign.json").write_text(json.dumps({"id": CAMPAIGN}))
    store = ExpertStore(root / "experts")
    source = {"campaign": CAMPAIGN}
    shooter = store.publish(SHOOTER, NumpyPolicy.random(1), {"passed": True}, ((A.SPRINT, 0),), source)
    blocker = store.publish(BLOCKER, NumpyPolicy.random(2), {"passed": True}, (), source)
    folder = root / "fighter"
    folder.mkdir()
    NumpyPolicy.random(3).save(folder / "policy.npz")
    (folder / "policy.json").write_text(json.dumps({"steps": 10, "experts": {"mob": None, SHOOTER: shooter, BLOCKER: blocker}}))
    return root


def ranged_states(seed=21, n=128):
    sim = Sim(n, SimConfig(), seed=seed)
    rng = np.random.default_rng(seed)
    for _ in range(50):
        masks = np.stack([build_masks(sim, 0), build_masks(sim, 1)], axis=1)
        scores = np.where(masks, rng.random(masks.shape), -1.0)
        action = np.zeros((n, 2, len(A.NVEC)), dtype=np.int64)
        for head, (start, size) in enumerate(zip(A.HEAD_OFFSETS, A.NVEC)):
            action[..., head] = scores[..., start : start + size].argmax(axis=-1)
        sim.step(action)
        done = (sim.hp <= 0.0).any(axis=1)
        if done.any():
            sim.reset(done)
    sim.weapon[: n // 2, 0] = C.BOW
    sim.weapon[n // 2 :, 1] = C.CROSSBOW
    return sim


def test_takeover_matches_training(saved):
    player = Player(saved)
    sim = ranged_states()
    interface = TakeoverInterface(ExpertSet(600))
    interface.experts.install(dict(player.experts.loaded))
    trained = interface.masks(sim, 0)
    obs = np.clip(build_obs(sim, 0, 600), -5.0, 5.0)
    ours = takeover(player.experts, obs, build_masks(sim, 0))
    assert np.array_equal(trained, ours)
    assert (trained.sum(axis=1) < build_masks(sim, 0).sum(axis=1)).any()


@pytest.mark.skipif(NODE is None, reason="Node is not installed")
def test_javascript_copy_acts_alike(saved, tmp_path):
    player = Player(saved)
    file = tmp_path / "policy.json"
    file.write_text(json.dumps(export(saved)))
    sim = ranged_states(seed=22)
    obs = np.clip(build_obs(sim, 0, 600), -5.0, 5.0).astype(float)
    masks = build_masks(sim, 0)
    script = """
    const { loadTrained } = require(process.argv[2])
    const net = loadTrained(process.argv[3])
    const input = JSON.parse(require('fs').readFileSync(0, 'utf8'))
    console.log(JSON.stringify(input.obs.map((o, i) => net.act(o, input.masks[i]))))
    """
    out = subprocess.run([NODE, "-e", script, "x", str(HERE / "net.js"), str(file)],
                         input=json.dumps({"obs": obs.tolist(), "masks": masks.astype(int).tolist()}),
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    assert np.array_equal(player.act(obs, masks), np.array(json.loads(out.stdout)))


def test_runner_answers_within_two_ticks(saved):
    env = {"PYTHONPATH": ":".join(p for p in sys.path if p), "PATH": "/usr/bin:/bin"}
    proc = subprocess.Popen([sys.executable, str(REPO / "agents_policy.py"), "--run", str(saved)], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, bufsize=1, env=env)
    try:
        hello = json.loads(proc.stdout.readline())
        assert hello["hello"]["rate"] == 10
        rng = np.random.default_rng(0)
        times = []
        for i in range(1000):
            line = json.dumps({"id": i, "key": "Agent1", "obs": rng.uniform(-1, 1, OBS_DIM).tolist(), "mask": [1] * int(A.MASK_SIZE)})
            start = time.perf_counter()
            proc.stdin.write(line + "\n")
            proc.stdin.flush()
            answer = json.loads(proc.stdout.readline())
            times.append(time.perf_counter() - start)
            assert answer["id"] == i and len(answer["action"]) == len(A.NVEC)
        ms = np.array(times) * 1000
        print(f"reply ms: median {np.median(ms):.2f}, p99 {np.percentile(ms, 99):.2f}, max {ms.max():.2f}")
        assert np.percentile(ms, 99) < 100.0
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
