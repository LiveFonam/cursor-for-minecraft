"""One definition of a network's inputs and action heads.

The shared 130 inputs and 11 heads are fixed. A network with more adds input
blocks and heads here, after the shared ones, so a policy trained on the shared
layout keeps the same meaning for every shared slot and head.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from . import actions as A
from .obs import OBS_DIM, build_masks, build_obs


@dataclass(frozen=True)
class InputBlock:
    """Extra inputs. `build` takes (sim, seat, rows) and returns shape (arenas, size)."""

    name: str
    size: int
    build: Callable


class Interface:
    """The inputs and heads of one network.

    apply: optional function of (sim, seat, extra_actions, rows) that acts on the
    extra heads before each simulator step. rows is None for every arena.
    """

    def __init__(
        self,
        inputs: tuple[InputBlock, ...] = (),
        heads: tuple[A.Head, ...] = (),
        apply: Callable | None = None,
    ):
        names = [block.name for block in inputs]
        if len(set(names)) != len(names):
            raise ValueError("input block names must be unique")
        self.inputs = tuple(inputs)
        self.layout = A.BASE.extended(*heads)
        self.extra_heads = tuple(heads)
        self.apply = apply
        self.obs_dim = OBS_DIM + sum(block.size for block in inputs)

    @property
    def nvec(self) -> np.ndarray:
        """Return the size of every head."""
        return self.layout.nvec

    @property
    def mask_size(self) -> int:
        """Return the length of the flat action mask."""
        return self.layout.mask_size

    def input_slice(self, name: str) -> slice:
        """Return where a named extra block sits in the observation."""
        start = OBS_DIM
        for block in self.inputs:
            if block.name == name:
                return slice(start, start + block.size)
            start += block.size
        raise KeyError(name)

    def observe(self, sim, seat: int, max_ticks: int, rows: np.ndarray | None = None) -> np.ndarray:
        """Return the shared inputs followed by every extra block."""
        shared = build_obs(sim, seat, max_ticks, rows)
        if not self.inputs:
            return shared
        extra = [np.asarray(block.build(sim, seat, rows), dtype=np.float32) for block in self.inputs]
        return np.concatenate([shared, *extra], axis=1)

    def masks(
        self, sim, seat: int, allowed_weapons: np.ndarray | None = None, rows: np.ndarray | None = None
    ) -> np.ndarray:
        """Return the shared mask followed by the mask of every extra head."""
        shared = build_masks(sim, seat, allowed_weapons, rows)
        if not self.extra_heads:
            return shared
        count = len(shared)
        parts = [shared]
        for head in self.extra_heads:
            if head.mask is None:
                parts.append(np.ones((count, head.size), dtype=bool))
            else:
                parts.append(np.asarray(head.mask(sim, seat, rows), dtype=bool))
        return np.concatenate(parts, axis=1)

    def split(self, actions: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Split actions into the shared heads and the extra heads."""
        shared = len(A.NVEC)
        return actions[..., :shared], actions[..., shared:]


SHARED = Interface()
