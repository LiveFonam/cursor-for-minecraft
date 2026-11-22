"""Checks that the scripted players act alike in Python and in JavaScript on the same inputs and masks."""

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from fighter import actions as A
from fighter.obs import OBS_DIM

from policies import POLICIES

NODE = shutil.which("node")
HERE = Path(__file__).parent
SCRIPT = """
const { POLICIES } = require(process.argv[2])
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'))
const out = {}
for (const name of input.names) out[name] = input.obs.map((o, i) => POLICIES[name](o, input.masks[i], input.turns[i]))
console.log(JSON.stringify(out))
"""


@pytest.mark.skipif(NODE is None, reason="Node is not installed")
def test_scripted_players_match():
    rng = np.random.default_rng(5)
    count = 2000
    obs = rng.uniform(-1.0, 1.0, (count, OBS_DIM))
    obs[:, 32] = rng.uniform(0.0, 0.5, count)
    obs[:, [12, 13, 17, 19, 35]] = rng.integers(0, 2, (count, 5))
    obs[:, 16] = rng.uniform(0.0, 1.0, count)
    masks = rng.random((count, A.MASK_SIZE)) < 0.8
    for head, (start, size) in enumerate(zip(A.HEAD_OFFSETS, A.NVEC)):
        masks[:, start] = True
    turns = rng.integers(0, 300, count)
    names = ["scripted", "duelist", "guard"]
    payload = {"names": names, "obs": obs.tolist(), "masks": masks.astype(int).tolist(), "turns": turns.tolist()}
    out = subprocess.run([NODE, "-e", SCRIPT, "x", str(HERE / "policies.js")], input=json.dumps(payload),
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    theirs = json.loads(out.stdout)
    for name in names:
        ours = POLICIES[name](obs, masks, turns, rng)
        assert np.array_equal(ours, np.array(theirs[name])), name
