"""A numpy stand-in for the saved-version Player, used here only for the blocking expert inside skills.py."""

import numpy as np

from .strategies import N_STRATEGY_INPUTS, StrategyRuntime, Variant


class Net:
    """The actor: dense layers with Tanh, then one linear layer of action scores, in float32 like the original."""

    def __init__(self, weights, biases, nvec):
        self.weights = [np.asarray(w, dtype=np.float32) for w in weights]
        self.biases = [np.asarray(b, dtype=np.float32) for b in biases]
        self.nvec = [int(n) for n in nvec]
        self.offsets = np.concatenate([[0], np.cumsum(self.nvec)]).astype(int)

    def logits(self, x):
        x = np.asarray(x, dtype=np.float32)
        for w, b in zip(self.weights[:-1], self.biases[:-1]):
            x = np.tanh(x @ w.T + b)
        return x @ self.weights[-1].T + self.biases[-1]

    def top(self, x, masks):
        scores = np.where(masks, self.logits(x), -np.inf)
        return np.stack([scores[:, a:b].argmax(axis=1) for a, b in zip(self.offsets[:-1], self.offsets[1:])], axis=1)

    def sample(self, x, masks, rng):
        scores = np.where(masks, self.logits(x), -np.inf)
        out = []
        for a, b in zip(self.offsets[:-1], self.offsets[1:]):
            part = scores[:, a:b]
            noise = rng.gumbel(size=part.shape)
            out.append(np.where(np.isfinite(part), part + noise, -np.inf).argmax(axis=1))
        return np.stack(out, axis=1)


class Player:
    """Takes the loaded export of one saved version (see brain.load_part)."""

    def __init__(self, part, max_steps=600, skills=False):
        if skills:
            raise ValueError("the blocking expert plays without experts of its own")
        self.part = part
        self.net = Net(part["weights"], part["biases"], part["nvec"])
        self.mean, self.var = part["mean"], part["var"]
        self.clip, self.eps = float(part["clip"]), float(part["eps"])
        self.keep = part["keep"]
        self.variant = Variant.from_dict(part["variant"]) if part["variant"] else None
        self.runtime = StrategyRuntime(self.variant, max_steps) if self.variant else None
        if self.runtime:
            self.runtime.step_time = part["step_time"]
        self.deterministic = False  # the original samples, the agreement test turns this on to compare exactly
        self.rng = np.random.default_rng(part.get("seed", 0))

    def act(self, raw_obs, keys=None):
        raw = np.array(raw_obs, dtype=np.float32)
        if self.keep is not None:
            raw = raw[:, self.keep]
        keys = keys if keys is not None else range(len(raw))
        masks = np.ones((len(raw), int(sum(self.net.nvec))), dtype=bool)
        if self.runtime:
            rows = []
            for row, key in zip(raw, keys):
                inputs, mask = self.runtime.step(key, row)
                row[-N_STRATEGY_INPUTS:] = inputs
                rows.append(mask)
            masks = np.stack(rows)
        obs = np.clip((raw - self.mean) / np.sqrt(self.var + self.eps), -self.clip, self.clip).astype(np.float32)
        return self.net.top(obs, masks) if self.deterministic else self.net.sample(obs, masks, self.rng)
