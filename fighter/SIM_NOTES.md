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
| Charge needed for crit and sprint hit | charge above 0.9, a damage multiplier of 84.8% | [Damage](https://minecraft.wiki/w/Damage) |
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
| Shield raise delay | blocks from the 5th tick after the press | [Shield](https://minecraft.wiki/w/Shield) |
| Shield arc | the half circle in front, pitch ignored | [Shield](https://minecraft.wiki/w/Shield) |
| Axe disables shield | 100 ticks | [Shield](https://minecraft.wiki/w/Shield) |
| Arrow gravity | 0.05 blocks per tick squared | [Arrow](https://minecraft.wiki/w/Arrow) |
| Arrow drag | 0.99 | [Arrow](https://minecraft.wiki/w/Arrow) |
| Arrow terminal speed | 5.00 blocks per tick (test target) | [Entity](https://minecraft.wiki/w/Entity) |
| Arrow base damage | 2 times speed, rounded up | [Arrow](https://minecraft.wiki/w/Arrow) |
| Arrow hitbox | 0.5 blocks | [Arrow](https://minecraft.wiki/w/Arrow) |
| Bow full speed | 3 blocks per tick | [Arrow](https://minecraft.wiki/w/Arrow) |
| Bow critical draw | 20 ticks | [Bow](https://minecraft.wiki/w/Bow) |
| Bow minimum draw | 3 ticks, a shorter release fires nothing and spends nothing | Recorded server shots |
| Crossbow arrow speed | 3.15 blocks per tick | [Arrow](https://minecraft.wiki/w/Arrow) |
| Crossbow load time | 25 ticks | [Crossbow](https://minecraft.wiki/w/Crossbow) |

## Model choices

| Value | Choice | Reason |
| --- | --- | --- |
| Base knockback speed | 0.4 along the line from attacker to victim | From rest on the ground this launches at 0.4 and 0.3608. |
| Sprint knockback bonus | a second knockback call of 0.5 along the attacker's view | From rest on the ground the two calls launch at 0.7 and 0.4. |
| Air acceleration | 0.02, or 0.026 while sprinting | Checked against the wiki sprint jump speed of 7.127 m/s, within 2%. |
| Sprint jump boost | 0.2 blocks per tick along the view | Checked against the same 7.127 m/s figure. |
| Bow speed curve | 3 * min((f^2 + 2f) / 3, 1), f = ticks / 20 | Reproduces the 1 HP, 5 HP and 6 HP draw tiers at 2, 16 and 18 ticks. |
| Critical arrow bonus | random whole number from 0 up to floor(base / 2) + 1 | The wiki text was hard to read here. This gives the 7 to 11 HP crossbow range. |
| Hit charge for crits | charge must be above 0.9 | Matches the 84.8% damage multiplier on the wiki. |
| Diagonal movement | input is scaled to length 1 | Not stated on the pages read. |
| Item use slowdown | input times 0.2 | Gives 0.863 m/s while a shield, bow or crossbow is in use. |
| Sprint restart | a held key keeps the body running after a sprint hit, and the next sprint hit needs a new press | The server clears its sprint flag on the hit and sets it again only when the client starts a new sprint. Each later charged hit still slows the running client by 0.6, with no sprint knockback. `MoveConfig.sprint_restart` turns the running part off. |
| Knockback inside the hurt window | only the hit that opens the window pushes | Matches recorded hits at every gap from 1 to 12 ticks. |
| Player collision | overlapping boxes push apart by 0.05, scaled by the larger axis offset | Applied after drag. |
| Arrow launch | no random spread and no inherited shooter speed | A simplification. |
| Arrow launch point | feet plus eye height minus 0.1 | Matches recorded server shots. |
| Arrow launch spread | each axis of the unit look gains 0.0172275 * (U1 - U2) before scaling by speed | Matches the spread of recorded server shots. |
| Shooter movement in a launch | a bow adds the shooter's x and z speed, and y speed when airborne. A crossbow adds nothing | Matches recorded shots from walking, strafing, sprinting and jumping shooters. |
| Ammunition | 6 arrows shared by both weapons. A bow pays when it fires, a crossbow when it finishes loading | Drills use a large quiver so that they measure aim and timing. |
| Arrows in flight | 6 per side, a new shot replaces that side's oldest | Keeps the batch arrays a fixed size. |
| Hit margin | the target box grows by (age - 2) / 20 on each side, at most 0.3 | Recorded blocked arrows stop on the bare box at age 2. Larger ages are not separated by the recordings. |
| Segment entry | a segment that starts inside a box does not hit it | Recorded blocked arrows fly out of the grown box without a second hit. |
| Blocked or undamaging hit | the arrow stays at the contact point and continues with velocity times -0.1 | Matches recorded blocked arrows. |
| Blocked hit on the player | knockback and the hurt window apply, remembered damage stays 0 | Matches recorded blocked arrows. |
| Landing | the arrow stops at the contact point minus 0.05 times the sign of each velocity axis | Matches 103 recorded landings. |
| Arrows in the ground | 24 per arena, the oldest is replaced, removed after 1200 ticks | The limit is a batch size. The lifetime follows the wiki. |
| Shake before pickup | 7 ticks | Matches recorded pickups. |
| Pickup box | 1.55 sideways, from 1.0 below the feet to 0.5 over the head | Recorded pickups succeed at 1.54 and miss at 1.56. |
| Water drag | 0.6 instead of 0.99 | From the wiki. Applies only with a world object. |
| Block contact | the first collision box on the arrow segment. With no world object, the arena floor and walls | Torches, fire and cobwebs have no collision box and do not stop arrows. |

## Combat rules

`src/fighter/combat.py` and `src/fighter/items.py` hold these rules. `tests/test_recorded_combat.py`
replays real server recordings stored in `tests/data/recorded_combat.json`.

| Rule | Value |
| --- | --- |
| Knockback push | x and z halve, then add strength along the push. On the ground y becomes min(0.4, y / 2 + strength) |
| Melee knockback | 0.4 from attacker to victim, then a push along the attacker view of 0.5 for a sprint hit plus the Knockback enchantment strength |
| Server velocity | Each player has a server copy that knockback starts from. A player hit restores it afterward |
| Server copy lift-off | In `arena` with the vanilla client, a key jump from standing reaches the copy 2 ticks later, and a knockback lift or a jump right after landing reaches it after 1 tick. The copy takes 0.42 with no gravity step on that tick. `surface` and `full` apply a jump to the copy on its own tick |
| Sprint and items | On the vanilla client a running sprint continues through item use, and item use blocks a new sprint start |
| Sprint in water | Starting a sprint needs the eye under water on the previous tick. A swimmer keeps sprinting against a wall and its vertical speed is pulled toward its look |
| Crossbow reload | After a shot, loading can start 4 ticks later, with the key held or pressed again |
| Sprint and food | With hunger on, the vanilla client needs more than 6 food to sprint |
| Sneak timing | Box and eye height change with the key. The vanilla slowdown starts one tick later |
| Blocked hit | Pulls the server copy 0.5 toward the attacker, pushes it 0.4 away, and opens the hurt window with stored damage 0 |
| Shield durability | 1 + floor(damage) for a blocked hit of 3 or more, out of 336 |
| Crit | Charge above 0.9, fall distance above 0, off the ground, not sprinting, not in water or a web |
| Damage order | Weapon and Strength, charge, crit, Sharpness, hurt window, armor, Protection, absorption, health |
| Protection | 4% a point, at most 20 points |
| Thrown pearl and potion | Start 0.1 under the eye and first move on the next tick. Each tick applies gravity, then drag, then moves |
| Break delay | 5 ticks after a slow break, counted only on ticks spent digging at a block. A block that breaks at once ignores it |
| Shallow current | Below 0.4 blocks of fluid, the push is scaled by the depth |
| Fall damage | floor(distance - 3), ignoring armor |
| Lava | 4 damage through armor, burning for 300 ticks |
| Fire block | 1 damage, burning for 160 ticks once the fire count reaches 0 |
| Burning | 1 damage whenever the fire count is divisible by 20, ignoring armor |
| Hunger | Food 20, saturation 5, spent 1 for every 4 exhaustion |
| Golden apple | 32 ticks, food 4, saturation 9.6, Regeneration II for 100 ticks, Absorption I for 2400 ticks |

Item use goes through `Sim.items.input`, an array of item codes that defaults to no item.
Items that change blocks call the world API and do nothing when the simulator has no world.

## Tick order

Each tick runs these steps.

1. Run the world when there is one: block ticks, fluid ticks, random ticks, then falling blocks and items.
2. Rotate the view.
3. Switch weapons. A switch resets the attack cooldown and cancels item use.
4. Update shields, bow draw and crossbow loading. Fire arrows.
5. Run held items and thrown objects. Block actions run one body after the other, with the first body chosen at random.
6. Resolve melee on the first tick of each decision. The second click of a double click lands on the next tick. A player holding up an item cannot swing.
7. Move players through `movement.py`. Horizontal order is acceleration, position, drag. Vertical order is position, gravity, drag. A body at rest holds a vertical velocity of -0.0784.
8. Update the server velocity copy, fall distance, hazards, hunger and effects.
9. Collect dropped items in reach.
10. Move arrows. The order is contact test, position, drag, gravity, which gives the wiki terminal speed of 5.00. Arrows in the ground age and can be picked up.
11. Advance timers.
12. On the last tick of a decision, update what each body has seen. Observations and masks read only that memory.

## World profiles

`SimConfig.profile` selects `arena` (a flat fight with no world object), `surface` (gentle terrain and light forest) or `full` (terrain, caves, ores and fluids). `client_model` goes to both the bodies and the world, and `vanilla` is the default.

## Inputs and sight

| Rule | Value |
| --- | --- |
| Block rays | 26 rays from the eye, turned with the body's yaw: 8 directions at 55 degrees down, 20 degrees down and level, then straight up and down. Range 8 |
| Ray answers | A ray stops at a remembered solid block, lava, fire or an unknown cell. Water is reported at its surface and does not stop it |
| `arena` rays | Computed from the floor and walls, equal to the kernel on a flat walled world |
| Enemy sight | Lines from the eye to the head, chest and feet. Inside the 110 by 70 degree view a line stops at the first opaque block. Outside it only remembered opaque blocks stop the line |
| Hidden enemy | Aim errors, distances, height, speed and lead slots use the last seen position and motion |
| Masks | Read inventory, body state and the last known enemy position |

## Not modeled

Sweep attacks, and the Resistance, Slowness, Weakness and Harming effects. Digging and held items are simulator inputs that default to off, because the shared action heads have no choice for them.
