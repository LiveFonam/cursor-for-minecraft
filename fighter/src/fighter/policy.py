"""A small NumPy copy of the actor network for fast opponent inference."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from . import actions as A
from .obs import OBS_DIM


class NumpyPolicy:
    """A ReLU multilayer perceptron with one categorical output per head."""

    def __init__(self, layers: list[tuple[np.ndarray, np.ndarray]]):
        self.layers = layers

    @classmethod
    def from_sb3(cls, model) -> "NumpyPolicy":
        """Copy the actor weights out of a MaskablePPO model."""
        modules = [m for m in model.policy.mlp_extractor.policy_net if hasattr(m, "weight")]
        modules.append(model.policy.action_net)
        layers = [
            (m.weight.detach().cpu().numpy().copy(), m.bias.detach().cpu().numpy().copy())
            for m in modules
        ]
        return cls(layers)

    @classmethod
    def random(cls, seed: int = 0, hidden: int = 256) -> "NumpyPolicy":
        """Build an untrained policy with random weights."""
        rng = np.random.default_rng(seed)
        sizes = [OBS_DIM, hidden, hidden, A.MASK_SIZE]
        layers = []
        for fan_in, fan_out in zip(sizes[:-1], sizes[1:]):
            weight = rng.normal(0.0, 1.0 / np.sqrt(fan_in), size=(fan_out, fan_in)).astype(np.float32)
            layers.append((weight, np.zeros(fan_out, dtype=np.float32)))
        return cls(layers)

    def save(self, path: str | Path) -> None:
        """Write the weights to an npz file."""
        arrays = {}
        for i, (weight, bias) in enumerate(self.layers):
            arrays[f"w{i}"] = weight
            arrays[f"b{i}"] = bias
        np.savez_compressed(path, **arrays)

    @classmethod
    def load(cls, path: str | Path) -> "NumpyPolicy":
        """Read weights from an npz file."""
        with np.load(path) as data:
            count = len(data.files) // 2
            return cls([(data[f"w{i}"], data[f"b{i}"]) for i in range(count)])

    def logits(self, obs: np.ndarray) -> np.ndarray:
        """Return the flat action logits."""
        x = obs
        for weight, bias in self.layers[:-1]:
            x = np.maximum(x @ weight.T + bias, 0.0)
        weight, bias = self.layers[-1]
        return x @ weight.T + bias

    def act(
        self,
        obs: np.ndarray,
        masks: np.ndarray,
        rng: np.random.Generator,
        deterministic: bool = False,
    ) -> np.ndarray:
        """Choose one action per head while respecting the masks."""
        logits = np.where(masks, self.logits(obs), -np.inf)
        if not deterministic:
            logits = logits + rng.gumbel(size=logits.shape)
        out = np.zeros((len(obs), len(A.NVEC)), dtype=np.int64)
        for head, (start, size) in enumerate(zip(A.HEAD_OFFSETS, A.NVEC)):
            out[:, head] = logits[:, start : start + size].argmax(axis=1)
        return out
