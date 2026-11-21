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

The policy picks one value on each of 9 discrete heads every 2 ticks.

| Head | Choices |
| --- | --- |
| forward | back, none, forward |
| strafe | left, none, right |
| sprint | off, on |
| jump | off, on |
| yaw | 9 turn sizes up to 40 degrees |
| pitch | 7 turn sizes up to 20 degrees |
| attack | off, on |
| use | off, on (shield, bow draw, crossbow load and fire) |
| weapon | sword, axe, bow, crossbow |

Action masks remove choices that do nothing. A swing is only legal when the aim ray meets
the opponent hitbox within reach. Jumping is only legal on the ground. Sprinting is not
legal while using an item. Using the shield is not legal while it is disabled.

## Observations

Each observation has 84 numbers in the player's own frame: its body state, the opponent's
body and item state, the two most urgent incoming arrows, wall distances and aim errors.
The aim errors include a computed intercept point for the held ranged weapon, so the
shooting drill teaches the policy to act on a lead solution and does not ask it to derive
one from raw positions.

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

## Drills

Each drill trains from random weights and has a pass test on held-out seeds.

Shooting. The policy stands still with a bow or crossbow while a target runs around it. To
pass, it must hit at least 50% of its shots with each weapon and beat a scripted shooter that
aims without lead by at least 10 points.

Blocking. A scripted archer shoots at the policy. To pass, the policy must block at least 85%
of arrows while keeping the shield up at most 70% of the time.

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

## License

MIT, see [LICENSE](../LICENSE).
