"""The UHC fighter network, with its own branches for body state and seen blocks."""

from __future__ import annotations

import gymnasium as gym
import torch
from sb3_contrib import MaskablePPO
from stable_baselines3.common.torch_layers import BaseFeaturesExtractor
from torch import nn

from .uhc_obs import layout

SHARED_UNITS = (384, 256)
BODY_UNITS = (128, 96)
WORLD_UNITS = (192, 128)
MERGE_UNITS = 512
POLICY_UNITS = (384, 256)
VALUE_UNITS = (512, 256)


def _branch(size: int, units: tuple[int, ...]) -> nn.Sequential:
    layers: list[nn.Module] = []
    for width in units:
        layers += [nn.Linear(size, width), nn.ReLU()]
        size = width
    return nn.Sequential(*layers)


class UhcExtractor(BaseFeaturesExtractor):
    """Encodes shared inputs, body state and seen blocks apart, then merges them."""

    def __init__(self, observation_space: gym.spaces.Box):
        super().__init__(observation_space, MERGE_UNITS)
        parts = layout()
        self.shared_slice = parts["shared"]
        self.body_slice = parts["body"]
        self.world_slice = parts["world"]
        self.shared = _branch(self.shared_slice.stop - self.shared_slice.start, SHARED_UNITS)
        self.body = _branch(self.body_slice.stop - self.body_slice.start, BODY_UNITS)
        self.world = _branch(self.world_slice.stop - self.world_slice.start, WORLD_UNITS)
        joined = SHARED_UNITS[-1] + BODY_UNITS[-1] + WORLD_UNITS[-1]
        self.merge = nn.Sequential(nn.Linear(joined, MERGE_UNITS), nn.ReLU())

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        return self.merge(
            torch.cat(
                [
                    self.shared(obs[:, self.shared_slice]),
                    self.body(obs[:, self.body_slice]),
                    self.world(obs[:, self.world_slice]),
                ],
                dim=1,
            )
        )


def uhc_policy_kwargs() -> dict:
    """Return the network settings of the UHC fighter."""
    return {
        "features_extractor_class": UhcExtractor,
        "net_arch": {"pi": list(POLICY_UNITS), "vf": list(VALUE_UNITS)},
        "activation_fn": nn.ReLU,
    }


def build_uhc_model(env, seed: int = 7, device: str = "cpu", **ppo) -> MaskablePPO:
    """Create a masked PPO model with the UHC network."""
    settings = {
        "learning_rate": 3e-4,
        "n_steps": 256,
        "batch_size": 2048,
        "n_epochs": 4,
        "gamma": 0.995,
        "gae_lambda": 0.95,
        "clip_range": 0.2,
        "ent_coef": 0.01,
    }
    settings.update(ppo)
    return MaskablePPO(
        "MlpPolicy", env, policy_kwargs=uhc_policy_kwargs(), seed=seed, device=device, verbose=0, **settings
    )
