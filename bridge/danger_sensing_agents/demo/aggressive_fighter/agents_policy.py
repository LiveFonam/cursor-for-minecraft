"""The agents' fighting brain: runs a fighter saved by a training campaign for every agent that is fighting.

    python agents_policy.py --run <campaign folder>

bridge/danger_sensing_agents/agents.js starts this on its own. It reads one JSON line per decision on stdin,
{"id": 7, "key": "Agent1", "obs": [130 numbers], "mask": [57 flags]}, and writes
{"id": 7, "action": [11 numbers]} on stdout. The first line it writes is
{"hello": {"name": ..., "rate": ..., "kind": ..., "fair": ...}} once the network is loaded.

--run takes a campaign folder or its fighter folder. The experts the fighter trained with take over their action
heads through the same rule training uses. The `fighter` package comes from PYTHONPATH, or from fighter/src here.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
DEFAULT_RUN = "weights/fighter"
INPUT_LIMIT = 5.0


def reply(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def campaign_folders(run):
    """Return the campaign folder and the fighter folder for a --run path."""
    run = Path(run)
    if (run / "fighter" / "policy.npz").exists():
        return run, run / "fighter"
    if (run / "policy.npz").exists() and (run.parent / "campaign.json").exists():
        return run.parent, run
    raise FileNotFoundError(f"no saved fighter at {run}")


def takeover(experts, obs, mask):
    """Fix the heads of each active expert in `mask`, in slot order, from the inputs alone.

    This is ExpertSet.constrain for a client, which has inputs and no simulator. The simulator filter there can only
    widen a situation, so the situation test decides the same arenas.
    """
    taken = np.zeros(len(obs), dtype=bool)
    for spec in experts.specs:
        expert = experts.loaded.get(spec.name)
        if expert is None and not spec.claims_when_empty:
            continue
        here = np.flatnonzero(~taken & spec.active(obs))
        taken[here] = True
        if expert is not None and len(here):
            experts._fix_heads(spec, expert, obs[here], mask, here)
    return mask


class Player:
    """One saved fighter with its experts."""

    def __init__(self, run, skills=True, sample=False, seed=0):
        from fighter import actions as A
        from fighter import constants as C
        from fighter.experts import SPECS, ExpertRejected, ExpertSet, ExpertStore
        from fighter.obs import OBS_DIM
        from fighter.policy import NumpyPolicy

        root, folder = campaign_folders(run)
        config = json.loads((root / "campaign.json").read_text())
        meta = json.loads((folder / "policy.json").read_text())
        self.policy = NumpyPolicy.load(folder / "policy.npz")
        inputs = self.policy.layers[0][0].shape[1]
        if inputs != OBS_DIM or not np.array_equal(self.policy.nvec, A.NVEC):
            raise ValueError(f"expected {OBS_DIM} inputs and the shared heads, the network has {inputs} inputs")
        self.obs_dim = OBS_DIM
        self.mask_size = int(A.MASK_SIZE)
        self.experts = ExpertSet(600, SPECS)
        if skills:
            store = ExpertStore(root / "experts")
            loaded = {}
            for name, version in meta.get("experts", {}).items():
                if version is None:
                    continue
                expert = store.load(name, int(version))
                if expert.source.get("campaign") != config.get("id"):
                    raise ExpertRejected(f"{name} version {version} was published by another campaign")
                loaded[name] = expert
            self.experts.install(loaded)
        self.sample = sample
        self.rng = np.random.default_rng(seed)
        self.name = f"{root.name}-{meta.get('steps', 0)}"
        self.rate = C.TICKS_PER_SECOND // C.TICKS_PER_DECISION
        self.versions = self.experts.versions()

    def act(self, obs, mask):
        """Return one action per row."""
        obs = np.clip(np.asarray(obs, dtype=np.float32), -INPUT_LIMIT, INPUT_LIMIT)
        mask = np.array(mask, dtype=bool)
        if obs.shape[1] != self.obs_dim or mask.shape[1] != self.mask_size:
            raise ValueError(f"expected {self.obs_dim} inputs and {self.mask_size} mask values")
        takeover(self.experts, obs, mask)
        return self.policy.act(obs, mask, self.rng, deterministic=not self.sample)


class MobPlayer:
    """The mob network saved by the mob drills, 182 inputs and the shared action heads. It needs numpy and nothing else."""

    SHARED = 130
    EXTRA = 52
    HEADS = (3, 3, 2, 2, 18, 15, 3, 2, 5, 2, 2)

    def __init__(self, path):
        with np.load(path, allow_pickle=False) as data:
            count = int(data["count"])
            self.layers = [(data[f"w{i}"], data[f"b{i}"]) for i in range(count)]
            shared, extra, nvec = int(data["shared_dim"]), int(data["extra_dim"]), data["nvec"]
        if shared != self.SHARED or extra != self.EXTRA or tuple(int(v) for v in nvec) != self.HEADS:
            raise ValueError(f"expected {self.SHARED} + {self.EXTRA} inputs and the shared heads, got {shared} + {extra}")
        if self.layers[0][0].shape[1] != shared + extra or self.layers[-1][0].shape[0] != sum(self.HEADS):
            raise ValueError("the saved layers do not fit the input and action sizes")
        self.obs_dim = shared + extra
        self.mask_size = sum(self.HEADS)
        self.offsets = np.concatenate([[0], np.cumsum(self.HEADS)[:-1]])

    def act(self, obs, mask):
        """Return the most likely allowed action of each head, for one row of inputs."""
        x = np.clip(np.asarray(obs, dtype=np.float32), -INPUT_LIMIT, INPUT_LIMIT)
        allowed = np.asarray(mask, dtype=bool)
        if x.shape != (self.obs_dim,) or allowed.shape != (self.mask_size,):
            raise ValueError(f"expected {self.obs_dim} inputs and {self.mask_size} mask values")
        for weight, bias in self.layers[:-1]:
            x = np.maximum(x @ weight.T + bias, 0.0)
        weight, bias = self.layers[-1]
        logits = np.where(allowed, x @ weight.T + bias, -np.inf)
        return [int(logits[start : start + size].argmax()) for start, size in zip(self.offsets, self.HEADS)]


def serve_mob(path):
    """Answer decisions for the mob network on stdin and stdout, the same way the fighter does."""
    path = Path(path)
    if not path.is_absolute():
        path = ROOT / path
    try:
        player = MobPlayer(path)
    except Exception as err:  # a missing or wrong file is reported to the bots, which keep their scripted fighter
        reply({"error": f"could not load the mob network {path}: {err}"})
        return
    reply({"hello": {"name": f"mob-{path.stem}", "rate": 10, "kind": "mob", "fair": False, "inputs": player.obs_dim}})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = {}
        try:
            msg = json.loads(line)
            reply({"id": msg["id"], "action": player.act(msg["obs"], msg["mask"])})
        except Exception as err:
            reply({"id": msg.get("id"), "error": str(err)})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", default=DEFAULT_RUN, help="a campaign folder or its fighter folder")
    ap.add_argument("--mob", help="serve this saved mob network (expert.npz) instead of the fighter")
    ap.add_argument("--no-skills", action="store_true", help="without the shooter and blocker experts")
    ap.add_argument("--sample", action="store_true", help="sample actions instead of taking the most likely")
    args = ap.parse_args()
    if args.mob:
        serve_mob(args.mob)
        return

    run = Path(args.run)
    if not run.is_absolute():
        run = ROOT / run
    if "PYTHONPATH" not in __import__("os").environ:
        sys.path.insert(0, str(ROOT / "fighter" / "src"))
    try:
        player = Player(run, skills=not args.no_skills, sample=args.sample)
    except Exception as err:  # a broken install or an unreadable folder, reported to the bots
        reply({"error": f"could not load {args.run}: {err}"})
        return
    # The simulator's enemy health input is what this fighter dealt, which fair health estimates on a real client
    reply({"hello": {"name": player.name, "rate": player.rate, "kind": False, "fair": True, "experts": player.versions}})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = {}
        try:
            msg = json.loads(line)
            action = player.act([msg["obs"]], [msg["mask"]])[0]
            reply({"id": msg["id"], "action": [int(x) for x in action]})
        except Exception as err:
            reply({"id": msg.get("id"), "error": str(err)})


if __name__ == "__main__":
    main()
