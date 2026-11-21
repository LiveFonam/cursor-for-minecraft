# Simulator notes

The simulator models 1 versus 1 Minecraft Java 1.21 combat on a flat walled arena.
It runs 20 game ticks per second and the agent decides every 2 ticks.
All values live in `src/fighter/constants.py`.

Source pages are on the [Minecraft Wiki](https://minecraft.wiki). A value marked
"model choice" was not stated on the pages read. Those values are listed with the
reason for each one, and with the wiki figure they were checked against when there is one.

## Constants from the wiki

| Constant | Value | Source page |
| --- | --- | --- |
| Player width | 0.6 blocks | [Player](https://minecraft.wiki/w/Player) |
| Player height | 1.8 blocks | [Player](https://minecraft.wiki/w/Player) |
| Eye height | 1.62 blocks | [Player](https://minecraft.wiki/w/Player) |
| Max health | 20 HP | [Player](https://minecraft.wiki/w/Player) |
| Attack reach | 3 blocks | [Melee attack](https://minecraft.wiki/w/Melee_attack) |
| Movement speed attribute | 0.1 | [Player](https://minecraft.wiki/w/Player) |
| Walking speed | 4.317 m/s (test target) | [Walking](https://minecraft.wiki/w/Walking) |
| Sprinting speed | 5.612 m/s, 1.3 times walking | [Sprinting](https://minecraft.wiki/w/Sprinting) |
| Sprint jumping speed | 7.127 m/s (test target) | [Sprinting](https://minecraft.wiki/w/Sprinting) |
| Sneaking speed multiplier | 0.3 | [Attribute](https://minecraft.wiki/w/Attribute) |
| Sneaking speed | about 1.3 m/s (test target) | [Sneaking](https://minecraft.wiki/w/Sneaking) |
| Gravity | 0.08 blocks per tick squared | [Entity](https://minecraft.wiki/w/Entity) |
| Vertical drag | 0.98 | [Entity](https://minecraft.wiki/w/Entity) |
| Horizontal air drag | 0.91 | [Entity](https://minecraft.wiki/w/Entity) |
| Ground friction | 0.6, so ground drag is 0.546 | [Entity](https://minecraft.wiki/w/Entity) |
| Terminal fall speed | 3.92 blocks per tick (test target) | [Entity](https://minecraft.wiki/w/Entity) |
| Jump strength | 0.42 blocks per tick | [Attribute](https://minecraft.wiki/w/Attribute) |
| Jump height | 1.2522 blocks (test target) | [Jumping](https://minecraft.wiki/w/Jumping) |
| Attack cooldown length | 20 / attack speed ticks | [Damage](https://minecraft.wiki/w/Damage) |
| Cooldown damage multiplier | 0.2 + ((t + 0.5) / T)^2 * 0.8, clamped to 0.2 to 1 | [Damage](https://minecraft.wiki/w/Damage) |
| Charge needed for crit and sprint hit | 84.8% | [Damage](https://minecraft.wiki/w/Damage) |
| Critical multiplier | 1.5 | [Damage](https://minecraft.wiki/w/Damage) |
| Hurt window | 10 ticks | [Damage](https://minecraft.wiki/w/Damage) |
| Knockback halves target speed | 0.5 | [Melee attack](https://minecraft.wiki/w/Melee_attack) |
| Vertical knockback cap | 0.4 blocks per tick | [Melee attack](https://minecraft.wiki/w/Melee_attack) |
| Attacker slowdown after a sprint hit | 0.6 | [Melee attack](https://minecraft.wiki/w/Melee_attack) |
| Armor formula | damage * (1 - min(20, max(a / 5, a - 4 * damage / (min(t, 20) + 8))) / 25) | [Armor](https://minecraft.wiki/w/Armor) |
| Iron armor set | 15 armor, 0 toughness | [Armor](https://minecraft.wiki/w/Armor) |
| Diamond armor set | 20 armor, 8 toughness | [Armor](https://minecraft.wiki/w/Armor) |
| Netherite armor set | 20 armor, 12 toughness | [Armor](https://minecraft.wiki/w/Armor) |
| Diamond sword | 7 damage, 1.6 attack speed | [Sword](https://minecraft.wiki/w/Sword) |
| Diamond axe | 9 damage, 1.0 attack speed | [Axe](https://minecraft.wiki/w/Axe) |
| Empty hand attack speed | 4 | [Attribute](https://minecraft.wiki/w/Attribute) |
| Shield raise delay | 5 ticks | [Shield](https://minecraft.wiki/w/Shield) |
| Shield arc | the half circle in front, pitch ignored | [Shield](https://minecraft.wiki/w/Shield) |
| Axe disables shield | 100 ticks | [Shield](https://minecraft.wiki/w/Shield) |
| Arrow gravity | 0.05 blocks per tick squared | [Arrow](https://minecraft.wiki/w/Arrow) |
| Arrow drag | 0.99 | [Arrow](https://minecraft.wiki/w/Arrow) |
| Arrow terminal speed | 5.00 blocks per tick (test target) | [Entity](https://minecraft.wiki/w/Entity) |
| Arrow base damage | 2 times speed, rounded up | [Arrow](https://minecraft.wiki/w/Arrow) |
| Arrow hitbox | 0.5 blocks | [Arrow](https://minecraft.wiki/w/Arrow) |
| Bow full speed | 3 blocks per tick | [Arrow](https://minecraft.wiki/w/Arrow) |
| Bow critical draw | 20 ticks | [Bow](https://minecraft.wiki/w/Bow) |
| Bow minimum draw | 2 ticks | [Bow](https://minecraft.wiki/w/Bow) |
| Crossbow arrow speed | 3.15 blocks per tick | [Arrow](https://minecraft.wiki/w/Arrow) |
| Crossbow load time | 25 ticks | [Crossbow](https://minecraft.wiki/w/Crossbow) |

## Model choices

| Value | Choice | Reason |
| --- | --- | --- |
| Base knockback speed | 0.4 | The wiki describes the procedure but no base number on the pages read. |
| Sprint knockback bonus | 0.5 added to the speed | Follows the wiki rule that speed is half of strength, with a bonus strength of 1. |
| Air acceleration | 0.02, or 0.026 while sprinting | Checked against the wiki sprint jump speed of 7.127 m/s, within 2%. |
| Sprint jump boost | 0.2 blocks per tick along the view | Checked against the same 7.127 m/s figure. |
| Bow speed curve | 3 * min((f^2 + 2f) / 3, 1), f = ticks / 20 | Reproduces the 1 HP, 5 HP and 6 HP draw tiers at 2, 16 and 18 ticks. |
| Critical arrow bonus | random whole number from 0 up to floor(base / 2) + 1 | The wiki text was hard to read here. This gives the 7 to 11 HP crossbow range. |
| Hit charge for crits | the damage multiplier must reach 0.848 | The wiki states the 84.8% figure without saying which quantity it applies to. |
| Diagonal movement | input is scaled to length 1 | Not stated on the pages read. |
| Item use slowdown | the sneak multiplier of 0.3 | The wiki says players move at sneaking speed. |
| Sprint restart | sprint needs a fresh press of forward or sprint | Makes W tapping and sprint resets meaningful in the simulator. |
| Knockback inside the hurt window | only the first hit pushes | Not stated on the pages read. |
| Player collision | a 0.05 push apart when bodies overlap | A small separation that keeps the two bodies from stacking. |
| Arrow launch | no random spread and no inherited shooter speed | A simplification. |

## Tick order

Each tick runs these steps.

1. Rotate the view.
2. Switch weapons. A switch resets the attack cooldown and cancels item use.
3. Update shields, bow draw and crossbow loading. Fire arrows.
4. Resolve melee on the first tick of each decision. A player holding up an item cannot swing.
5. Move players. Horizontal order is acceleration, position, drag. Vertical order is position, gravity, drag.
6. Move arrows. The order is position, drag, gravity, which gives the wiki terminal speed of 5.00.
7. Advance timers.

## Not modeled

Sweep attacks, enchantments, potions, hunger, food, durability, blocks other than the
floor and walls, sneaking as an action, and network latency.
