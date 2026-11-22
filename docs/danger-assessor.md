# Danger assessor

Unit tested on the fake world, not yet tried on a live server.

## What it is

`bridge/danger_sensing_agents/threats.js` looks at the bot and everything around it 5 times a second (every 4 game ticks) and gives every danger a score and a response. Seven survival modes act on that report with no order needed. They pause whatever job is running, and the job carries on after, through the mode manager that already handled a fight pausing a mining job.

All the judgement is in `threats.js`, and each mode only asks the report one question ("is there something to fight?"). So the scoring can be tuned, or later swapped for a small learned network, without touching the modes.

## Every danger it takes into account

### Dangers to its body and bag

| Danger | When | Score | Response |
|---|---|---|---|
| Lava | standing in lava | 8 | escape |
| Suffocation | its head is inside a solid block (gravel or sand fell on it) | 6 | escape |
| Fire | burning | 5 | escape |
| Drowning | in water with less than 10 of 20 air | 4 to 9 | swim up |
| Starving | food bar at 0, losing health | 5 | eat |
| Hunger | food below 14 of 20 | 1 to 3 | eat |
| Low food supply | **less food in the bag than the job's plan, and never less than 2 full hunger bars, 40 food points** | 0.5 to 1.5 | get more food |
| Low health | below 10 health with nothing hurting it for 3 s | up to 2 | eat to heal |

Food points are counted from the bag with the game's own food values. Rotten flesh, spider eyes, poisonous potatoes, pufferfish, chorus fruit and suspicious stew don't count.

### Mobs and players

Every entity within 64 blocks is checked. Each kind has a danger value and an attack type:

| Kind | Mobs (danger value) |
|---|---|
| Melee | zombie 1, husk 1.1, drowned 1.1, zombie villager 1, spider 1.2, cave spider 1.5, silverfish 0.5, endermite 0.5, slime 1, magma cube 1.5, vindicator 2.5, ravager 4, hoglin 2.5, zoglin 3, piglin brute 3.5, wither skeleton 3, giant 3, creaking 2 |
| Flying melee | phantom 1.3, vex 1.5 |
| Ranged (range) | skeleton 1.5 (15), stray 1.6 (15), bogged 1.6 (15), parched 1.6 (15), pillager 1.6 (16), witch 2 (10), evoker 2.5 (12), illusioner 2 (15), shulker 1.5 (16), guardian 2 (15), elder guardian 4 (15) |
| Flying ranged | blaze 2 (16), breeze 2 (16), ghast 2 (50) |
| Exploder | creeper 3 |
| Boss | warden 10, wither 10 |
| Neutral (only after it hits the bot) | enderman 2.5, zombified piglin 2, piglin 1.5 (neutral only while the bot wears gold), players who are not friends 2 (2.6 holding a sword or axe, ranged when holding a bow or crossbow) |

Slime, magma cube, phantom, ghast and shulker are filed as "mob" in the 1.21.11 game data, and hoglin as "animal", so the agents' basic enemy check (`targets.js`) never saw them. The assessor adds them. Friends (the owner, agents, names in `friends`) and animals are never dangers.

### What changes a mob's score

```
score = danger value × how close × coming at me × looking at me × height × how weak I am
```

| Factor | Effect |
|---|---|
| How close | Melee: 1 within reach + 1 block, falling to 0 at 24 blocks. Ranged with a clear line: 0.8 to 1 anywhere in range. Ranged behind a wall: at most 0.4. Creeper: 1 within 3 blocks, 0 at 16. Boss: 0 at 48 |
| Line of sight | for shooters, a ray from its eyes to the mob's head through the blocks. Any full block in the way counts |
| Coming at me | moving toward it faster than 0.5 blocks a second: ×1.5. Moving away: ×0.7 |
| Looking at me | its head points within 30° of the bot: ×1.2 |
| Height | a walking melee mob more than 5 blocks above or below: ×0.5 |
| How weak I am | health: ×1 at full, up to ×3 near death. Armor: ×0.8 with 15+ armor points, ×1 with 8+, ×1.3 with less. No sword, axe, mace or trident: ×1.2 |
| Attacking the owner | a mob within 8 blocks of the owner (when the owner is within 16 of the bot) is also scored by its distance to the owner, ×1.6, and the higher score counts |
| In reach | a non-neutral enemy within reach + 1 block always scores at least 1.5, the fight threshold. Armor can't talk the bot out of answering a zombie hitting it |
| Hit me | when health drops, the nearest enemy in reach takes the blame, else the nearest shooter with a clear line. That enemy scores at least 2 for 3 s. A neutral mob or player that hit it counts as an enemy for 30 s |
| Neutral | not yet provoked: score ×0.2, never fought or avoided |
| Several at once | the scores add up to a total that decides fleeing |

### How it picks a response

Checked in this order:

1. **Flee** from:
   - a warden or wither within 32 blocks,
   - or 6 health or less with an enemy within 10 (it keeps running until it is above 10 health or 16 blocks clear),
   - or a total score of 8 or more below 14 health (it keeps running while the total is 4 or more below 16 health).
2. **Avoid** a creeper within 6 blocks: back off until it is 9 away. If the same creeper keeps following for 15 s, it is fought for 30 s instead, since a hit knocks it back and stops the fuse.
3. **Fight** the enemy with the highest score, if that score is 1.5 or more.
   - It keeps the same target while its score stays above 0.6. Another enemy only takes over with 1.5 times the score.
   - An enemy it fights for 20 s without ever getting within reach + 1.5 blocks is marked out of reach for 60 s (a skeleton on a cliff, a zombie across water), unless it comes into reach and hits.
   - Creepers outside the 15 s rule and bosses are never fought.
4. **Watch** everything else.

## The modes that act on it

Priority order, highest first. New modes in bold:

| Mode | Does |
|---|---|
| **escape** | In lava or on fire: water on its feet if it carries a bucket (then picks the water back up). Without a bucket: back to the last solid ground it stood on (lava), or into water within 6 blocks (fire). Head in a block: digs it, or jumps |
| kill | the owner's `!kill` order, unchanged |
| retreat | uses the assessor's flee decision. From a boss it runs to 40 blocks |
| **avoid** | backs off from the creeper |
| guard | the owner's `!guard` order, unchanged |
| **mobfight** | fights a mob the assessor picked with the scripted mob fighter, using what it carries, no console kit |
| **defend** | fights a player the assessor picked with the trained network |
| eat | under 14 food whatever the danger, and under 18 while safe |
| give, come | the owner's orders, unchanged |
| **resupply** | under the job's food plan (at least 40 points): the agents' farm within 96 blocks first, then up to 4 rounds of hunting (each up to 3 grown animals within 24 blocks), cooking the meat when it can. A run that comes back short waits 3 minutes unless it meets an animal it can see. Deep in a job only an animal it meets starts a run, the miner turns back by itself. Not while told to `!stay` |
| craft, gather, build, mine, explore, farm, follow, idle | the jobs, unchanged |

The miner's own "under 10 food points, hunt 3 animals first" check is gone, because resupply runs above mining.

`!danger` says the top 3 dangers in chat, for example `Dangers: creeper avoid 3.6 (5.0 blocks, coming at me, looking at me); low food supply resupply 1.3 (10 food points in the bag, want 40 (2 full hunger bars))`. The full list goes to the log.

The bot says in chat what it does:
- "Zombie close, fighting it"
- "Protecting you from zombie"
- "Creeper close, backing off"
- "Warden nearby, getting away"
- "In lava, getting out"
- "Only 10 food points on me, getting more (want 40)"

## Choices I made that you may want to change

1. **"2 full hunger bars" is 40 food points.** The hunger bar holds 20 points, so 2 full bars are 40, which is 8 bread or 5 steaks. If you meant 2 drumsticks (4 points), change `FOOD_RESERVE` at the top of `threats.js`.
2. **Mobs get scripted melee, players get the network.** The mob fighting mode uses what the bot carries and asks the console for nothing. Defend, which now only answers players, still gets the axe kit through the server console, because the trained network only knows the axe kit's slots.
3. **Players are never attacked first.** A non-friend player is only fought after hitting the bot. `!kill` and `!guard` do attack them.
4. **Resupply runs even when the bot is idle or following you.** A bot that joins with an empty bag goes hunting right away. Only `!stay` holds it back.
5. **Creepers get fought after 15 s of backing off,** so a creeper that keeps following can't stall the job forever.

## Not covered yet

| Gap | Why |
|---|---|
| A skeleton out of reach keeps shooting | after 20 s it gives up and goes back to work under fire. It needs a "get out of its line of sight" move |
| A creeper's fuse | the game sends whether a creeper is swelling, but I didn't read it. It goes by distance only |
| Damage to the owner | it can't see the owner's health, so it defends the owner by mob distance, not by hits |
| Falling, the void, night | falls and lava next to the tunnel are handled inside the miner and the pathfinder (drops of 3 blocks or less, lava gets a block), not by the assessor. Night is not a danger by itself |
| Tool durability, armor breaking | not dangers yet. The planner's tool check (from the task queue plan) is where these belong |
| Searching for food | resupply only hunts animals within 24 blocks, it does not walk off to look for more |
| Guard and kill on endermen | `!guard` and `!kill` use the basic enemy check, so they will attack an enderman that hasn't attacked. The owner's orders stay as given |

## Tests

`node --test bridge/danger_sensing_agents/test/*.test.js` runs the agents' offline tests. The 20 in `test/threats.test.js` cover:

- The food rule: 35 points is a danger, 40 is not, and rotten flesh doesn't count.
- Hunger and starving.
- A zombie coming at it versus one standing far off looking away.
- A zombie in reach is answered even in full diamond.
- The creeper: avoided at 5 blocks, still avoided at 7.5, free at 11, and fought after 15 s.
- A skeleton in the open versus behind a stone wall.
- A warden.
- Fleeing at 5 health, still fleeing at 8, and fighting again at 11.
- 4 zombies at 12 health (flee) versus at full health (fight).
- An enderman before and after it hits.
- A stranger before and after hitting, and the owner never counted.
- Slime and hoglin counted, cows not.
- Keeping its target unless a ravager shows up.
- Giving up on an out-of-reach zombie after 20 s.
- A zombie next to the owner.
- Lava, fire, gravel on its head, and drowning.
- The `!danger` line.
- The mode order, defend taking the pick, and resupply waiting on `!stay`.

## Live tests to run next

None of this has run in the real game. Suggested checks on the bench world, using RCON `summon` next to a bot that is mining:

1. Summon a zombie 8 blocks away. The bot fights it and is mining again within 30 s.
2. Summon a creeper 5 blocks away. The bot backs off, then deals with it.
3. Summon 4 zombies with the bot at 10 health. It runs.
4. Summon an enderman. Nothing happens until it is hit.
5. Start a bot with no food near cows. It hunts until it carries 40 points.
6. Run the live tests. `mining_proof` (no food in its kit) and `translate` (4 bread) start with a food run.

## Files

| File | Role |
|---|---|
| `bridge/danger_sensing_agents/threats.js` | the assessor |
| `bridge/danger_sensing_agents/test/threats.test.js` | its tests |
| `bridge/danger_sensing_agents/behaviors.js` | the escape, avoid, mobfight, defend, retreat and resupply modes |
| `bridge/danger_sensing_agents/agents.js` | runs the assessor every 4 ticks and resets it on death |
| `bridge/danger_sensing_agents/commands.js` | the `!danger` command |
