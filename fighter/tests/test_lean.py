"""Tests of the lean trainer against the masked PPO reference code."""

from __future__ import annotations

import json

import numpy as np
import pytest
import torch
from sb3_contrib.common.maskable.buffers import MaskableRolloutBuffer
from sb3_contrib.common.maskable.distributions import MaskableMultiCategoricalDistribution
from gymnasium import spaces

from fighter import actions as A
from fighter.drills import blocking_report
from fighter.evaluate import play_matches
from fighter.lean import (
    ActorCritic,
    EnvSpec,
    Host,
    LeanConfig,
    compute_advantages,
    entropy,
    log_prob,
    masked_log_softmax,
    sample_heads,
    train_lean,
)
from fighter.obs import OBS_DIM
from fighter.policy import NumpyPolicy
from fighter.train import Stage

SIZES = [int(n) for n in A.NVEC]


def random_masks(rng: np.random.Generator, batch: int) -> np.ndarray:
    masks = rng.random((batch, sum(SIZES))) < 0.7
    start = 0
    for size in SIZES:
        masks[np.arange(batch), start + rng.integers(0, size, batch)] = True
        start += size
    return masks


def test_log_prob_and_entropy_match_the_reference_distribution():
    rng = np.random.default_rng(0)
    logits = torch.as_tensor(rng.normal(0.0, 2.0, (64, sum(SIZES))), dtype=torch.float32)
    masks = torch.as_tensor(random_masks(rng, 64))
    parts = masked_log_softmax(logits, masks, SIZES)
    actions = sample_heads(parts)
    reference = MaskableMultiCategoricalDistribution(SIZES)
    reference.proba_distribution(logits)
    reference.apply_masking(masks)
    assert torch.allclose(log_prob(parts, actions), reference.log_prob(actions), atol=1e-4)
    assert torch.allclose(entropy(parts, masks, SIZES), reference.entropy(), atol=1e-4)


def test_sampling_never_picks_a_masked_action():
    rng = np.random.default_rng(1)
    masks = torch.as_tensor(random_masks(rng, 512))
    logits = torch.as_tensor(rng.normal(0.0, 5.0, (512, sum(SIZES))), dtype=torch.float32)
    chosen = sample_heads(masked_log_softmax(logits, masks, SIZES))
    offsets = torch.as_tensor(A.HEAD_OFFSETS)
    assert masks.gather(1, chosen + offsets).all()


def test_advantages_match_the_reference_buffer():
    generator = torch.Generator().manual_seed(3)
    rewards = torch.rand(8, 4, generator=generator)
    values = torch.rand(9, 4, generator=generator)
    dones = (torch.rand(8, 4, generator=generator) < 0.2).float()
    buffer = MaskableRolloutBuffer(
        8,
        spaces.Box(-1, 1, (1,)),
        spaces.Discrete(2),
        device="cpu",
        gamma=0.995,
        gae_lambda=0.95,
        n_envs=4,
    )
    buffer.rewards[:] = rewards.numpy()
    buffer.values[:] = values[:-1].numpy()
    buffer.episode_starts[0] = 0.0
    buffer.episode_starts[1:] = dones[:-1].numpy()
    buffer.compute_returns_and_advantage(values[-1], dones[-1].numpy())
    ours = compute_advantages(rewards, values, dones, 0.995, 0.95)
    assert np.allclose(ours.numpy(), buffer.advantages, atol=1e-5)


def test_sizes_come_from_the_environment():
    host = Host("blocking", 2, 0, 0, False)
    try:
        assert host.n_obs == OBS_DIM
        assert host.sizes == SIZES
    finally:
        host.close()


@pytest.mark.parametrize("workers", [0, 2])
def test_workers_fill_every_array(workers):
    host = Host("fight", 8, workers, 5, True)
    try:
        host.call("reset")
        assert np.abs(host.views["obs"]).sum() > 0.0
        masks = host.views["masks"].copy()
        host.views["actions"][:] = np.tile(A.neutral_actions(np.zeros(1, dtype=np.int64)), (host.total, 1))
        assert masks.any(axis=1).all()
        host.call("step")
        assert np.isfinite(host.views["rewards"]).all()
    finally:
        host.close()


def test_saved_policy_works_with_existing_evaluation(tmp_path):
    cfg = LeanConfig(
        out=str(tmp_path),
        total_steps=256,
        n_envs=16,
        n_steps=8,
        batch_size=64,
        n_epochs=1,
        device="cpu",
        threads=1,
    )
    train_lean(cfg, "blocking")
    policy = NumpyPolicy.load(tmp_path / "policy.npz")
    assert blocking_report(policy, n_envs=4)["drill"] == "blocking"
    assert play_matches(policy, "idle", games_per_arena=1, n_envs=2)["games"] == 2


def test_training_saves_league_and_resumes(tmp_path):
    stages = [
        Stage("targets", {"idle": 1.0}, 0.5, 100),
        Stage("league", {"league": 1.0, "random": 1.0}, 2.0, 0),
    ]
    cfg = LeanConfig(
        out=str(tmp_path),
        total_steps=2048,
        n_envs=16,
        n_steps=8,
        batch_size=64,
        n_epochs=1,
        device="cpu",
        threads=1,
        snapshot_every=512,
        checkpoint_every=1024,
        stages=stages,
    )
    first = train_lean(cfg)
    assert first["steps"] >= 2048
    assert len(list((tmp_path / "league").glob("*.npz"))) >= 1
    state = json.loads((tmp_path / "state.json").read_text())
    assert state["steps"] == first["steps"]
    cfg.total_steps = 3072
    second = train_lean(cfg, resume=True)
    assert second["steps"] >= 3072
    assert second["league"] >= first["league"]


def test_network_export_matches_the_numpy_policy():
    model = ActorCritic(OBS_DIM, sum(SIZES))
    x = torch.randn(16, OBS_DIM)
    logits, _ = model(x)
    exported = model.to_policy().logits(x.numpy())
    assert np.allclose(logits.detach().numpy(), exported, atol=1e-5)


def test_spec_builds_each_task():
    for task in ("fight", "shooting", "blocking"):
        assert EnvSpec(task, 2, 0).build().num_envs == 2
