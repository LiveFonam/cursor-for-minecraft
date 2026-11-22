"""The whole reference best in numpy: raw 126 inputs in, one action of 11 heads out.

The order is the one its play loop uses: plan rules and their 4 inputs, then the experts through the masks, then the
scaled inputs through the network, taking the top allowed choice of every head (the show match setting).
"""

import json

import numpy as np

from .skills import Skills
from .strategies import N_STRATEGY_INPUTS, StrategyRuntime, Variant
from .versions import Net, Player


def load_part(data, prefix):
    count = int(data[f"{prefix}count"])
    keep = data[f"{prefix}keep"]
    meta = json.loads(str(data[f"{prefix}meta"]))
    return {
        "weights": [data[f"{prefix}w{i}"] for i in range(count)],
        "biases": [data[f"{prefix}b{i}"] for i in range(count)],
        "nvec": data[f"{prefix}nvec"],
        "mean": data[f"{prefix}mean"],
        "var": data[f"{prefix}var"],
        "clip": data[f"{prefix}clip"],
        "eps": data[f"{prefix}eps"],
        "keep": None if keep.size == 0 else keep,
        "variant": meta["variant"],
        "step_time": meta["step_time"],
    }


class BestBrain:
    MAX_STEPS = 1200  # the play loop's round length, which its plan rules are built with

    def __init__(self, path, seed=0):
        with np.load(path, allow_pickle=False) as data:
            top, blocker = load_part(data, "top_"), load_part(data, "blk_")
        blocker["seed"] = seed
        self.net = Net(top["weights"], top["biases"], top["nvec"])
        self.mean, self.var = top["mean"], top["var"]
        self.clip, self.eps = float(top["clip"]), float(top["eps"])
        self.runtime = StrategyRuntime(Variant.from_dict(top["variant"]), self.MAX_STEPS)
        self.skills = Skills(shooter="lock", blocker=blocker)
        self.dim = int(self.mean.shape[0])
        self.mask_size = int(sum(self.net.nvec))

    def set_blocker_top_choice(self, on=True):
        self.skills.blocker.deterministic = on

    def new_round(self, key=0):
        self.runtime.state.pop(key, None)
        self.skills.blocker.runtime.state.pop(key, None)

    def prepare(self, raw_row, key=0):
        """Plan rules and experts for one raw row: returns the finished row and its mask."""
        raw = np.array(raw_row, dtype=np.float32)[None]
        if raw.shape[1] != self.dim:
            raise ValueError(f"the best takes {self.dim} inputs, got {raw.shape[1]}")
        inputs, mask = self.runtime.step(key, raw[0])
        raw[0, -N_STRATEGY_INPUTS:] = inputs
        masks = mask[None].copy()
        letters = [self.runtime.state[key]["letter"]]
        masks = self.skills.apply(raw, masks, letters, [key])
        return raw, masks

    def scaled(self, raw):
        return np.clip((raw - self.mean) / np.sqrt(self.var + self.eps), -self.clip, self.clip).astype(np.float32)

    def act(self, raw_row, key=0):
        raw, masks = self.prepare(raw_row, key)
        return [int(v) for v in self.net.top(self.scaled(raw), masks)[0]]
