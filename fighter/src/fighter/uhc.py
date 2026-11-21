"""UHC rounds: random kits, the item action head, per step masks and the environment."""

from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np

from . import actions as A
from . import constants as C
from . import items as I
from .combat import RoundRules
from .env import ArenaVecEnv, RewardConfig
from .opponents import OpponentPool
from .sim import SimConfig
from .uhc_obs import NUM_ITEM_ACTIONS, UHC_INTERFACE
from .world import pool as world_pool
from .world.config import WorldConfig
from .world.kernel import Arenas, BaseWorld

UHC_WORLD = WorldConfig(fluids=True, fire=True, depth=False, trees=True)
UHC_MAX_TICKS = 2400
BLOCK_REACH = 4.5
RIGHT_CLICK_TICKS = 4
OPPONENT_EAT_HEALTH = 10.0
REPEATING = np.zeros(I.NUM_ITEMS, dtype=bool)
REPEATING[[I.BLOCK, I.COBWEB]] = True
ITEM_HEAD = len(A.NVEC)
GEAR = ("sword", "axe", "bow", "shield")


@dataclass(frozen=True)
class UhcKitRules:
    """How a round's kit is drawn for each player.

    drop_rate: chance that one item type is missing.
    full_rate: chance that a player keeps every item.
    empty_rate: chance that a player has no items at all.
    gear_drop: chance that the sword, axe, bow or shield is missing.
    armor_drop: chance that one armor piece is missing.
    forced: item codes that are always present.
    banned: item codes that are always missing.
    removed_gear: any of "sword", "axe", "bow" and "shield" that are always missing.
    """

    drop_rate: float = 0.35
    full_rate: float = 0.15
    empty_rate: float = 0.10
    gear_drop: float = 0.15
    armor_drop: float = 0.10
    counts: tuple[tuple[int, int, int], ...] = (
        (I.GOLDEN_APPLE, 1, 8),
        (I.WATER_BUCKET, 1, 4),
        (I.LAVA_BUCKET, 1, 2),
        (I.COBWEB, 1, 8),
        (I.PEARL, 1, 2),
        (I.ROD, 1, 1),
        (I.BLOCK, 8, 64),
    )
    forced: tuple[int, ...] = ()
    banned: tuple[int, ...] = ()
    removed_gear: tuple[str, ...] = ()


def _remove_weapon(combat, env: int, seat: int, slot: int) -> None:
    combat.weapon_damage[env, seat, slot] = I.FIST_DAMAGE
    combat.weapon_speed[env, seat, slot] = I.FIST_SPEED
    combat.weapon_sharpness[env, seat, slot] = 0.0
    combat.weapon_left[env, seat, slot] = 0
    combat._uniform_speed = False


def deal_kits(sim, idx: np.ndarray, rules: UhcKitRules, rng: np.random.Generator) -> None:
    """Draw a fresh kit for both players of the selected arenas."""
    items = sim.items
    combat = sim.combat
    for env in np.asarray(idx).tolist():
        for seat in (0, 1):
            items.count[env, seat] = 0
            items.rod_left[env, seat] = 0
            style = rng.random()
            keep_all = style < rules.full_rate
            keep_none = not keep_all and style < rules.full_rate + rules.empty_rate
            for code, low, high in rules.counts:
                if code in rules.banned:
                    continue
                dropped = keep_none or (not keep_all and rng.random() < rules.drop_rate)
                if dropped and code not in rules.forced:
                    continue
                items.count[env, seat, code] = int(rng.integers(low, high + 1))
                if code == I.ROD:
                    items.rod_left[env, seat] = I.ROD_DURABILITY
            lost = {name for name in GEAR if name in rules.removed_gear or rng.random() < rules.gear_drop}
            if "sword" in lost:
                _remove_weapon(combat, env, seat, C.SWORD)
            if "axe" in lost:
                _remove_weapon(combat, env, seat, C.AXE)
            if "bow" in lost:
                combat.has_bow[env, seat] = False
                sim.ammo[env, seat] = 0
            if "shield" in lost:
                combat.has_shield[env, seat] = False
            pieces = rng.random(4) < rules.armor_drop
            if pieces.any():
                combat.armor_left[env, seat, pieces] = 0
                combat._refresh_armor(env, seat)


class UhcHands:
    """What each player holds, with the legality rules recomputed every step."""

    def __init__(self, sim) -> None:
        n = sim.n
        self.sim = sim
        self.held = np.zeros((n, 2), dtype=np.int64)
        self.since = np.zeros((n, 2), dtype=np.int64)
        self.pressed = np.zeros((n, 2), dtype=bool)
        self.crossbow = np.zeros((n, 2), dtype=bool)
        self._last_input = np.zeros((n, 2), dtype=np.int16)
        self.illegal_items = np.zeros(2, dtype=np.int64)
        self.illegal_weapons = np.zeros(2, dtype=np.int64)

    def reset(self, idx: np.ndarray) -> None:
        self.held[idx] = I.NO_ITEM
        self.since[idx] = 0
        self.pressed[idx] = False
        self._last_input[idx] = I.NO_ITEM

    def use_held(self, seat: int) -> np.ndarray:
        """Return whether each player held the use key on an item in the last decision."""
        return self._last_input[:, seat] != I.NO_ITEM

    def legal_items(self, seat: int) -> np.ndarray:
        """Return which item choices each player can make now, shape (n, items)."""
        items = self.sim.items
        out = items.count[:, seat, : NUM_ITEM_ACTIONS] > 0
        out[:, I.NO_ITEM] = True
        out[:, I.PEARL] &= (items.pearl_cooldown[:, seat] == 0) & ~items.pearl_on[:, seat]
        out[:, I.ROD] &= items.rod_left[:, seat] > 0
        return out

    def legal_weapons(self, seat: int) -> np.ndarray:
        """Return which weapon slots are usable. The first slot doubles as the bare hand."""
        sim = self.sim
        combat = sim.combat
        out = np.ones((sim.n, C.NUM_WEAPONS), dtype=bool)
        out[:, C.AXE] = combat.weapon_left[:, seat, C.AXE] > 0
        out[:, C.BOW] = combat.has_bow[:, seat] & (sim.ammo[:, seat] > 0)
        out[:, C.CROSSBOW] = self.crossbow[:, seat] & ((sim.ammo[:, seat] > 0) | sim.loaded[:, seat])
        return out

    def apply(self, seat: int, actions: np.ndarray, codes: np.ndarray) -> np.ndarray:
        """Turn one seat's choices into simulator input and return its legal base actions."""
        sim = self.sim
        rows = np.arange(sim.n)
        base = np.array(actions, dtype=np.int64)
        codes = np.asarray(codes, dtype=np.int64).copy()

        bad_item = ~self.legal_items(seat)[rows, codes]
        if bad_item.any():
            self.illegal_items[seat] += int(bad_item.sum())
            codes[bad_item] = I.NO_ITEM
        chosen = A.WEAPON_CHOICES[base[:, A.WEAPON]]
        bad_weapon = (chosen >= 0) & ~self.legal_weapons(seat)[rows, np.maximum(chosen, 0)]
        if bad_weapon.any():
            self.illegal_weapons[seat] += int(bad_weapon.sum())
            base[bad_weapon, A.WEAPON] = A.WEAPON_ACTION[C.SWORD]

        holding = codes != I.NO_ITEM
        swapped = codes != self.held[:, seat]
        if swapped.any():
            sim.attack_ticks[swapped, seat] = 0.0
        if holding.any():
            sim.draw_ticks[holding, seat] = 0
            sim.load_ticks[holding, seat] = 0
            base[holding, A.WEAPON] = A.WEAPON_KEEP
        use = base[:, A.USE] == 1
        wanted = np.where(use & holding, codes, I.NO_ITEM).astype(np.int16)
        base[holding, A.USE] = 0
        base[holding, A.ATTACK] = 0

        items = sim.items
        items.input[:, seat] = wanted
        same = (wanted != I.NO_ITEM) & (wanted == self._last_input[:, seat])
        ticks = C.TICKS_PER_SECOND // sim.cfg.decisions_per_second
        self.since[:, seat] = np.where(same, self.since[:, seat] + ticks, 0)
        again = same & REPEATING[wanted] & (self.since[:, seat] >= RIGHT_CLICK_TICKS)
        if again.any():
            items.repeat_press(again, seat)
            self.since[again, seat] = 0
        self.pressed[:, seat] = (wanted != I.NO_ITEM) & (~same | again)
        self._last_input[:, seat] = wanted

        lost_hook = items.hook_on[:, seat] & (codes != I.ROD)
        if lost_hook.any():
            items.hook_on[lost_hook, seat] = False

        dig = np.zeros(sim.n, dtype=bool)
        attack = (base[:, A.ATTACK] >= A.ATTACK_CLICK) & ~holding & (sim.weapon[:, seat] <= C.AXE)
        if attack.any() and sim.world is not None:
            eye = sim.eyes()[:, seat : seat + 1].copy()
            look = sim.look()[:, seat : seat + 1].copy()
            hit, _cell, _face, _dist = sim.world.ray_block_many(eye, look, BLOCK_REACH)
            dig = attack & hit[:, 0] & ~sim.aim_hits()[:, seat]
            base[dig, A.ATTACK] = 0
        items.dig_input[:, seat] = dig
        self.held[:, seat] = codes
        return base


def uhc_nvec() -> np.ndarray:
    """Return the shared head sizes followed by the item head."""
    return UHC_INTERFACE.nvec


def uhc_sim_config(**changes) -> SimConfig:
    """Return the round setup with hunger on and natural regeneration off."""
    return replace(SimConfig.uhc(), natural_regen=False, **changes)


def load_uhc_world(seed: int = 0, size: int = 128, cache: str | None = None) -> BaseWorld:
    """Return a surface world with fluids and fire on and depth off."""
    return world_pool.load(seed, size, cache, UHC_WORLD)


@dataclass
class UhcRewardConfig:
    """Reward terms added to the shared fight reward. `uhc_checks.py` tests each one."""

    environment_damage: float = 3.0
    heal: float = 1.0
    lava: float = 0.10
    burning: float = 0.05
    web: float = 0.02
    item_press: float = 0.002


class UhcVecEnv(ArenaVecEnv):
    """A UHC fight in a world with fluids and fire, with a separate item head."""

    def __init__(
        self,
        n_envs: int,
        pool: OpponentPool | None = None,
        base: BaseWorld | None = None,
        rules: UhcKitRules | None = None,
        sim_config: SimConfig | None = None,
        reward: RewardConfig | None = None,
        uhc_reward: UhcRewardConfig | None = None,
        max_ticks: int = UHC_MAX_TICKS,
        round_rules: RoundRules | None = None,
        seed: int = 0,
        world_seed: int = 0,
        world_size: int = 128,
        world_cache: str | None = None,
        opponent_eats: bool = True,
    ):
        config = sim_config or uhc_sim_config()
        if pool is None:
            pool = OpponentPool(n_envs, seed=seed + 1, max_ticks=max_ticks)
        super().__init__(
            n_envs, pool, config, reward, max_ticks=max_ticks, seed=seed,
            round_rules=round_rules if round_rules is not None else RoundRules(), interface=UHC_INTERFACE,
        )
        self.rules = rules or UhcKitRules()
        self.uhc_reward = uhc_reward or UhcRewardConfig()
        self.opponent_eats = opponent_eats
        self.kit_rng = np.random.default_rng(seed + 3)
        world = base if base is not None else load_uhc_world(world_seed, world_size, world_cache)
        self.sim.attach_world(
            Arenas(world, n_envs, seed=seed, client_model=self.sim.cfg.client_model, config=UHC_WORLD)
        )
        self.hands = UhcHands(self.sim)
        self.sim.uhc_hands = self.hands
        self._lost_seen = np.zeros(n_envs)
        self._hp_seen = np.zeros(n_envs)
        self._debt = np.zeros(n_envs)
        self._hazard = np.zeros(n_envs)
        everyone = np.ones(n_envs, dtype=bool)
        self.sim.reset(everyone)
        self._on_reset(everyone)
        self._phi = self._potential()

    def _hazard_potential(self) -> np.ndarray:
        cfg = self.uhc_reward
        combat = self.sim.combat
        return -(
            cfg.lava * combat.in_lava[:, 0]
            + cfg.burning * (combat.fire[:, 0] > 0)
            + cfg.web * combat.in_web[:, 0]
        )

    def _sync_reward_state(self, idx: np.ndarray) -> None:
        self._lost_seen[idx] = self.sim.combat.environment_damage[idx, 0]
        self._hp_seen[idx] = self.sim.hp[idx, 0]
        self._debt[idx] = 0.0
        self._hazard[idx] = self._hazard_potential()[idx]

    def _on_reset(self, mask: np.ndarray) -> None:
        super()._on_reset(mask)
        idx = np.flatnonzero(mask)
        if len(idx) == 0:
            return
        deal_kits(self.sim, idx, self.rules, self.kit_rng)
        self.hands.reset(idx)
        self._sync_reward_state(idx)

    def step_async(self, actions: np.ndarray) -> None:
        joined = np.asarray(actions, dtype=np.int64)
        self._actions = self.hands.apply(0, joined[:, :ITEM_HEAD], joined[:, ITEM_HEAD])

    def _opponent_actions(self) -> np.ndarray:
        sim = self.sim
        base = self.pool.act(sim, 1).copy()
        codes = np.zeros(sim.n, dtype=np.int64)
        if self.opponent_eats:
            low = (sim.hp[:, 1] < OPPONENT_EAT_HEALTH) & (sim.items.count[:, 1, I.GOLDEN_APPLE] > 0)
            codes[low] = I.GOLDEN_APPLE
            base[low, A.USE] = 1
        return self.hands.apply(1, base, codes)

    def _reward(self, ev: dict[str, np.ndarray], actions: np.ndarray) -> np.ndarray:
        reward = super()._reward(ev, actions)
        cfg = self.uhc_reward
        sim = self.sim
        lost_total = sim.combat.environment_damage[:, 0]
        lost = lost_total - self._lost_seen
        self._lost_seen = lost_total.copy()
        taken = ev["damage_taken"][:, 0] + lost
        healed = np.maximum(sim.hp[:, 0] - self._hp_seen + taken, 0.0)
        self._hp_seen = sim.hp[:, 0].copy()
        self._debt += taken
        credit = np.minimum(healed, self._debt)
        self._debt -= credit
        hazard = self._hazard_potential()
        hazard_gain = hazard - self._hazard
        self._hazard = hazard
        return (
            reward
            - cfg.environment_damage * lost / C.MAX_HEALTH
            + cfg.heal * credit / C.MAX_HEALTH
            + hazard_gain
            - cfg.item_press * self.hands.pressed[:, 0]
        )

    def close(self) -> None:
        self.sim.close()
