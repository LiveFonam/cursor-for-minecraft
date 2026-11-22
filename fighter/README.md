# Fighter

A vectorized simulator of 1 versus 1 Minecraft Java 1.21 combat and a masked PPO
trainer that learns to fight in it. All networks start from random weights.

[SIM_NOTES.md](SIM_NOTES.md) lists every game constant with its source page.

## Setup

Fighter uses Python 3.12 through [uv](https://docs.astral.sh/uv/).

```sh
cd fighter
uv sync
uv run pytest
```

## Commands

Run these from the `fighter` folder. The `nice` prefix keeps training polite on a
shared machine. Training uses at most 2 threads and stops itself if its peak memory
passes 2 GB. Outputs go to `runs/`, which git ignores.

Smoke train. Runs a short curriculum, then must beat a random opponent on held-out seeds.

```sh
nice -n 10 uv run fighter smoke
```

Full train. Runs the whole curriculum and the self-play league. It saves a checkpoint
every 250,000 steps. Add `--resume` to continue from the last one.

```sh
nice -n 10 uv run fighter train --out runs/full --steps 30000000
```

Drill train. Trains one skill from random weights and runs its pass test.

```sh
nice -n 10 uv run fighter drill shooting
nice -n 10 uv run fighter drill blocking
```

Evaluation. Plays a saved policy on held-out seeds against one or all scripted opponents,
or reruns a drill pass test.

```sh
nice -n 10 uv run fighter evaluate --policy runs/full/policy.npz --opponent all
nice -n 10 uv run fighter evaluate --policy runs/drill-shooting/policy.npz --drill shooting
```

## Actions

The policy picks one value on each of 11 discrete heads every decision, in the order the
game client reads them.

| Head | Choices |
| --- | --- |
| forward | none, forward, back |
| strafe | none, left, right |
| sprint | off, on |
| jump | off, on |
| yaw | 18 turn sizes from 0.25 to 180 degrees |
| pitch | 15 turn sizes from 0.25 to 40 degrees |
| attack | none, click, double click |
| use | off, on (shield, bow draw, crossbow load and fire) |
| weapon | keep, axe, sword, crossbow, bow |
| sneak | off, on |
| lock aim | off, on (look at the solved shot with a bow or crossbow) |

A positive yaw step turns left and a positive pitch step looks up.

Action masks remove choices that cannot act. Sprinting is not legal while using an item.
Jumping needs the ground or water. Bows and crossbows cannot swing. Use is blocked with a
disabled shield, with no arrows, and until the key is released after a crossbow load.
Weapons outside the kit are blocked. Lock aim needs a ranged weapon. Turns under 1 degree
are blocked within 9 blocks of the enemy.

## Observations

Each observation has 130 numbers in the player's own frame, in every profile.

| Slots | Inputs |
| --- | --- |
| 0 to 25 | Own body, held item, charge, shield and ammunition |
| 26 to 38 | Aim errors, distances, crosshair and sight of the enemy |
| 39 to 60 | Enemy motion, health estimate, charge estimate, items and facing |
| 61 to 74 | Event timers, combo, round time and the last keys pressed |
| 75 to 80 | Lead errors and flight time for the held ranged weapon |
| 81 to 95 | Two incoming arrows and the nearest landed arrow |
| 96 to 121 | 26 block rays from the eye |
| 122 to 127 | Nearest lava or fire and nearest water reached by those rays |
| 128, 129 | World border distance and whether the client tracks the enemy |

Block inputs come only from what the body has seen. An enemy behind cover is hidden, and
its slots hold the last place it was seen.

`fighter.interface.Interface` builds a larger network. Extra input blocks and action heads
follow the shared ones, so the shared slots and heads never move.

## Training

Training uses `MaskablePPO` from sb3-contrib. The policy and value networks each have 2
hidden layers of 256 units.

The curriculum moves to the next stage when the recent win rate passes a gate.

| Stage | Opponents |
| --- | --- |
| targets | idle, random |
| chasers | walker, swinger, random |
| fighters | strafer, critter, swinger |
| tactics | shielder, axeman, archer, critter |
| league | past versions of the policy plus the harder scripted opponents |

The league keeps 12 past versions and picks more often the ones the policy loses to.

The reward pays for damage and wins. Smaller shaping terms encourage crit jumps, sprint hits,
W tapping, strafing, spacing, blocking, shield breaks and axe follow-up damage. Shaping
shrinks in later stages.

A fight setup names the kit and arena of a run. It is fixed for the life of a campaign or an
evolution, and its children train and are tested in it.

| Setup | Kit | Arena |
| --- | --- | --- |
| `standard` (default) | iron armor, diamond axe and sword, shield, crossbow, bow, 6 arrows | 24 blocks wide |
| `diamond_20` | unenchanted diamond armor, diamond axe and sword, shield, crossbow, bow, 6 arrows | 20 blocks wide |

```sh
nice -n 10 uv run python -m fighter.evolve run --out runs/evolve --parents runs/a,runs/b --fight-setup diamond_20
```

Ranking matches run one at a time inside the driver, so ranking loads no extra copy of
PyTorch. `--rank-parallel N` plays them in N worker processes instead. Each match has its
own seed, so the results are the same either way.

## Drills

Each drill trains from random weights and has a pass test on held-out seeds.

A drill trains for up to 2 million decisions, scores the policy every 100,000 and stops at
the first pass. Drills allow turn steps up to 45 degrees of yaw and 20 of pitch.

Shooting. The policy stands still with a bow or crossbow while a target runs around it. To
pass, it must hit at least 50% of its shots with each weapon and beat a scripted shooter that
aims without lead by at least 10 points.

Blocking. A scripted archer shoots at the policy. To pass, the policy must block at least 85%
of arrows while keeping the shield up at most 70% of the time.

## Mob director

`src/fighter/director.py` is the mob director from `director/` (the Paper plugin) running in the simulator. It is an invisible agent that turns the mobs of an arena against the player in seat 0. The simulator's mobs walk straight at the player, so the director does the pathfinding. It finds a route over the blocks a zombie can walk on, and hands each mob its next waypoint through three opt-in arrays on `Mobs`:

- `steer_on` and `steer_to` send a mob somewhere other than the player.
- `steer_hold` stops it from targeting the player.
- `ignite()` lights a creeper's fuse where it stands.

All of these are off unless a director sets them, so plain mob fights behave exactly as before.

```python
director = Director(sim, env=0)
for _ in range(ticks):
    director.update()
    sim.step(actions)
print(director.status())
```

When the player is shut in, it reads the blocks for the weakest door, wall or roof: at most 2 blocks thick, and no stronger than cobblestone. One creeper walks there while the others hold 8 blocks back, and the creeper lights its fuse at the wall. After the simulator's explosion breaks the blocks, the director looks again. A way in releases the mobs. No way in, or a creeper killed before it goes off, fails the breach and starts a 30 second cooldown.

`tests/test_director.py` plays the same cases the plugin passed on a real server: an open door, a closed door, the creeper killed first, a blast at a 2 thick wall, a shallow underground room, obsidian, a skeleton, reinforcements with a stop, and the player's death.

## Credits

Fighter depends on these public libraries, installed through uv:
[NumPy](https://numpy.org),
[PyTorch](https://pytorch.org),
[Gymnasium](https://gymnasium.farama.org),
[Stable-Baselines3](https://github.com/DLR-RM/stable-baselines3),
[SB3-Contrib](https://github.com/Stable-Baselines-Team/stable-baselines3-contrib) and
[pytest](https://pytest.org).

Game constants come from the [Minecraft Wiki](https://minecraft.wiki). This project contains
no Minecraft game files or decompiled code.

Three practice opponents come from open source projects. `src/fighter/open_bots.py` rewrites the
rules of [mineflayer-pvp](https://github.com/PrismarineJS/mineflayer-pvp) (MIT) and the Sweat tier of
[mc-pvp-bots](https://github.com/FatihBastan/mc-pvp-bots) (MIT). `src/fighter/synth_bot.py` runs
the trained network of
[minecraft-pvp-neural-network](https://github.com/SynthSarcasm/minecraft-pvp-neural-network)
by SynthSarcasm (MIT). Its code and weights stay outside this repository, found through `SYNTH_HOME` and
`SYNTH_WEIGHTS`. Their license notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT, see [LICENSE](../LICENSE).
