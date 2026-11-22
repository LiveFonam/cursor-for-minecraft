# Danger sensing agents

Helper bots on their own survival server that do what the owner types in chat. They fight players with the project's trained fighting network, and they fight mobs, mine, build, farm, explore, follow and fetch with scripts.

## Start it

The agents server has its own folder (`server-agents/`, git-ignored), its own world, port 25566 and RCON (remote console) port 25576. The setup script downloads Paper there. It never accepts the Minecraft EULA for you.

```sh
AGENTS_SERVER_DIR="$PWD/server-agents" bridge/danger_sensing_agents/scripts/setup-server.sh
cp server-agents/paper-*.jar server-agents/paper.jar
```

Then finish `server-agents/` by hand:

1. Read the EULA at https://aka.ms/MinecraftEULA. If you agree, create `server-agents/eula.txt` with the line `eula=true`.
2. In `server-agents/server.properties`, keep `server-ip=127.0.0.1` and `online-mode=false`, and set `server-port=25566`, `enable-rcon=true`, `rcon.port=25576`, `rcon.password=<a password you choose>`, `white-list=true` and `spawn-protection=0`.
3. Start the server, then add the owner and the bots in its console: `whitelist add <name>` for each, and `op <owner>`.

```sh
server-agents/start.sh             # runs the server in this terminal, type stop to save and stop it
node bridge/danger_sensing_agents/agents.js         # the bots join (Agent1 and Agent2)
```

Settings live in `bridge/danger_sensing_agents/agents.config.json`, which is git-ignored because it holds your player name. Copy `bridge/danger_sensing_agents/agents.config.example.json` to it and set `owner`. Values come from the defaults, then that file (or the file named by `AGENTS_CONFIG`), then the environment: `AGENTS_OWNER`, `AGENTS_BOTS`, `AGENTS_FRIENDS`, `AGENTS_HOST`, `AGENTS_PORT`, `AGENTS_RCON_PORT`, `AGENTS_SERVER_MEMORY`, `AGENTS_HUMAN`, `AGENTS_KILL_RADIUS`, `AGENTS_GUARD_RADIUS`, `AGENTS_FIGHTER_RUN` and `AGENTS_TRANSLATOR_MODEL`. `bridge/danger_sensing_agents/config.js` checks them all and stops with a clear message on a bad name, port, level or unknown setting.

`start.sh` gives the server 1 to 2 GB of heap. The bots need about 120 MB and the fighting network about 230 MB.

Join `localhost:25566` in Minecraft with the `owner` name from `bridge/danger_sensing_agents/agents.config.json`. Spawn protection is off because the bots are not operators, and the default protection silently undoes every block they break near spawn. Server commands go in the server console, for example `give Agent1 iron_pickaxe`.

Other options for the bots: `--bots 3` starts Agent1 to Agent3, `--names A,B` uses other names (add them to `bridge/danger_sensing_agents/agents.config.json` and to the server whitelist), `--run runs/<version>` fights with another saved version, `--no-translator` turns plain words off.

## Commands

Only the owner's chat counts, checked by the sender's UUID in the chat packet, so a `/say` or plugin line made to look like the owner is ignored. Commands start with "!" because "/" is the server's own. Put a bot name right after the "!" to talk to one bot, otherwise every bot does it.

```
!kill [radius] [name]     attack every non-friend within the radius (default 50), or only the player or mob named, all bots on one shared target
!guard [radius]           hold this spot: attack hostile mobs and non-friend players within the radius (default 16), then walk back to it
!stop                     drop everything at once
!come                     walk to you once
!follow                   keep following you
!stay                     stop following or mining and stand still
!mine <block> [count]     mine a resource, default 5, for example !mine diamond 5
!gather <kind> [count]    get more wood, cobblestone, iron or diamonds and keep it in the bag (see The gatherer)
!status                   say what it is doing, its health, food, position and pickaxe
!doing                    say the task, the step and how long it has been on each
!plan                     say the steps left of the plan it is running
!danger                   say the dangers it sees around it and what it does about each (docs/danger-assessor.md)
!give                     walk to you and drop everything it collected (keeps tools, weapons, armor, arrows, torches)
!human off|light|full     how human its mining looks
!quiet                    only the important news in chat (say it again for normal)
!verbose                  every bit of news in chat (say it again for normal)
!build <blueprint> [here | x y z] [north|east|south|west]
                          build a blueprint where you stand or at x y z, its front toward you unless you name a side
!farm [wheat|carrot|potato] [here]
                          with here: build the village wheat farm where you stand and keep it going, without: tend the nearest farm
!expand <build>           add one module to a farm or a wall the agents built (the small wheat farm becomes the large one)
!explore [radius]         scout around (default 64), report finds with coordinates, then come back
!design <name> <words>    have Claude Sonnet draw a new blueprint from your words (the translator does this for you)
!blueprints               list what it can build
!craft <item> [keep]      craft a wooden, stone, iron or diamond pickaxe, a furnace or a crafting table and hand it to you (keep: the bot keeps it)
!help [command]           list the commands, or say how one works
```

Examples: `!Agent1 mine iron 10`, `!kill 30`, `!kill 20 Steve`, `!kill 20 zombie`, `!Agent2 come`, `!all stop`, `!build small_hut here`, `!build wall 120 64 -40 east`, `!farm wheat here`, `!expand wheat_farm`, `!explore 96`.

Build, farm, expand, explore and design go to one bot when you ask all the agents (two bots on one site get in each other's way): the first one with nothing to do takes it.

Ore names work as you would say them: diamond, iron, coal, gold, copper, redstone, lapis, emerald, quartz, debris. Each covers the normal and the deepslate ore. Plurals work too ("diamonds"), and "wood" or "log" means any log. Anything else is taken as a block name, for example `!mine oak_log 8`.

## The gatherer

`!gather wood`, `!gather cobblestone`, `!gather iron` and `!gather diamonds` each run their own scripted skill, and keep what they get in the bag (no chest), ready for the crafter or a `!give`. A count says how many more than the bag holds now: `!gather iron 10`. Plain words work too, with no translator: `gather wood`, `collect 10 iron`, `Agent1, gather some diamonds`.

| kind | default | how | needs |
|---|---|---|---|
| wood | 16 logs | the nearest natural tree it can see, log by log (any wood counts). No tree in sight: walks 12 to 22 blocks and looks again, up to 6 times, within 48 blocks of the start. Never a log without natural leaves above it | nothing |
| cobblestone | 32 | stone it can see, else a short staircase down (cobbled deepslate counts too) | any pickaxe |
| iron | 8 raw iron | the miner: caves it can see first, then branch mining at Y 16, then back to where it started | a stone pickaxe or better |
| diamonds | 3 | the miner: branch mining at Y -58, then back to where it started | an iron pickaxe or better |

Without the right pickaxe it says which one it needs and digs nothing ("For diamonds I need an iron pickaxe or better, I only have a stone one"). Gold counts as wood for this, the way the game has it. It ends with "Gathered 10 raw iron", or says how far it got and why ("I got 4 of 10 logs: I couldn't find more wood nearby"). A fight, a meal or a food run pauses it, and it carries on to the same target after. Like `!mine`, starting a gather ends a mine, build or explore job, and `!stay` and `!stop` end it.

The crafter uses it for missing materials (see The gatherer integration point below), and asks for coal as furnace fuel the same way: the gatherer mines coal ore for it, though `!gather` itself only offers the four kinds.

## Plain words

A line that starts with "@agents", or with a bot name and no "!", goes to the translator. Claude Haiku 5.5 (the cheapest model) only reads the words and answers with one small request. It never plans:

- a goal, an item and how many (`{"goal": {"item": "diamond_pickaxe", "count": 1}}`), which runs as `!get diamond_pickaxe 1`
- one command (`{"command": "!guard"}`), checked by the same parser as typed ones
- too vague (`{"vague": "What should I do?"}`): the bot says "Too vague for me:" and the question, and does nothing
- cannot do it (`{"impossible": "I can't travel to the Nether"}`): the bot says "That's impossible for me right now:" and why, and does nothing

"make me an iron pickaxe" and `!get <item> [count]` reach the same planner with no model and no API key. "craft me ..." and "gather ..." in plain words stay the crafter's and the gatherer's own commands, except that "craft me" goes to the planner when a material needs a better pickaxe than the bot has. The key comes from `ANTHROPIC_API_KEY` in the environment, or from a git-ignored `.env` in the repository root or `bridge/`. Without it the translator is off and says so.

### The goal planner

`bridge/danger_sensing_agents/goal_plan.js` is a pure script that turns a goal into ordered steps. It uses the cheapest source first and skips every step they cover:

1. **The bot's bag.**
2. **Chests**, nearest first, when the walk is shorter than getting the item another way. The agents remember every chest they open, per world, with its contents and when they last looked (`bridge/danger_sensing_agents/chest_memory.js`, saved as `agents-chests.json` next to `agents-builds.json`). Chests close by that it has never opened are checked when a plan needs materials, and a chest that is gone is forgotten. The bot says "Taking 3 iron ingots from the chest at x y z".
3. **The owner's bag**, read at the start of each plan through the server console with `data get entity <owner> Inventory`, which only reads. The bot says "You have 3 diamonds, drop them to me", waits 20 seconds, and gets the rest itself. It never removes anything by command, and never asks for the owner's tools or the item they asked for. With no console it says it can't see the bag and carries on.
4. **Gathering**, with the pickaxe each material needs made first.

From an empty bag "make me a diamond pickaxe" becomes

```
gather 5 logs, craft wooden pickaxe, craft wooden axe to keep, gather 11 cobblestone, craft stone pickaxe,
gather 3 raw iron, smelt 3 raw iron and craft iron pickaxe, gather 3 diamonds, craft diamond pickaxe,
walk to you, hand over diamond pickaxe
```

Any plan that crafts a wooden pickaxe also makes a wooden axe right after it for fighting, unless the bot already carries an axe or a sword. The bot keeps it. After taking from chests and asking the owner, the bot plans again from what really arrived.

The bot says the steps in chat ("On it: 1) ... 2) ..."), runs each to its end, and says "Done with the plan". A step that did not get it done stops the plan there and says so. `!plan` says the steps left. A typed order replaces the plan, but a question (`!status`, `!plan`, `!danger`) does not. A one command answer such as `!mine` still goes through `bridge/danger_sensing_agents/plan_check.js`, which adds the pickaxes it needs and refuses what no skill can do.

A friend from `agents.config.json` can ask for the items the agents craft. Those plans use only the bot's bag and gathering, never the owner's chests or bag.

## The crafter

Type `craft me a stone pickaxe` or `craft a furnace` in chat (no "!" needed, no translator, works without an API key, and `!craft stone pickaxe`, `@agents craft ...` and `Agent1, craft ...` work too). It knows the wooden, stone, iron and diamond pickaxe, the furnace and the crafting table, and common names: wood pickaxe, cobblestone pickaxe, cobble pick, workbench. Friends in `agents.config.json` may ask too, and the item goes to whoever asked.

What it does, all with survival actions:

1. Remembers who asked and what, reads its real bag (as the server has it) and plans from Mojang's own 1.21.11 recipes (`bridge/danger_sensing_agents/recipes/all-recipes-1.21.11.json`, item tags expanded). The copies of the item it already carries are its own: it makes a new one.
2. Uses what it carries first: logs become planks and sticks, any wood and any of cobblestone, cobbled deepslate or blackstone work. It uses a crafting table within 6 blocks, or crafts and places one (the 4 planks are counted in the plan) and picks it back up after.
3. Iron pickaxe: ingots it carries first. With raw iron it smelts only the ingots it lacks, in a furnace within reach or one it crafts from 8 cobblestone and places, with coal, or spare planks, logs or sticks as fuel, and checks the ingots are in the bag before crafting.
4. Short of something, it asks for the exact amounts ("For the stone pickaxe I need 1 cobblestone more") and keeps the request. Hand it over (drop it by the bot) or let the gatherer bring it: it looks at its bag every second and carries on by itself, no second command.
5. A fight takes control like it does from any job. When the fight ends it looks at the bag again and carries on. Only one mode runs the bot at a time (the mode manager).
6. It walks up to you and drops the item at your feet, and counts it given only when the server says you picked it up. Out of reach (more than 48 blocks, or out of sight), it keeps it, says it is ready, and brings it when you come close. A repeated request, a fight or a retry never makes a second copy: asking again while it waits is "already on it", asking again while it holds the item brings that one.

Its priority sits below the survival modes (escape, retreat, avoid, defend, eat, resupply) and the kill, guard, give and come orders, above build and mine. `!stop` ends its jobs (an item it made stays in its bag). `!status` says what it is waiting for.

### The gatherer integration point

The gatherer above is this mode (`GatherMode` in `bridge/danger_sensing_agents/behaviors.js`, below craft).

The crafter asks the gatherer role through one mode name. Register a mode called `gather` in `makeModes` (`bridge/danger_sensing_agents/behaviors.js`, anywhere below eat). When materials are missing the crafter calls

```
manager.setOn('gather', { items: [{ name: 'cobblestone', count: 1 }], for: 'craft', requester: 'YourName' })
```

`items` are the exact missing amounts (item names: `oak_log`, `cobblestone`, `raw_iron`, `diamond`, `coal`). The gather mode gets them and calls `this.finish('done')` (or `this.finish('error')`), which settles the promise `setOn` returned. The crafter then looks at the bag again: done and complete means it carries on, still short means it asks the gatherer once more, then asks the player in chat. Without a `gather` mode (the crafter's own tests take it out) it asks the player straight away. The crafter does not wait inside its own mode, so the gather mode has control while it works.

## News in chat

The bots tell you what matters, briefly, and the same news from the same bot at most once every 10 seconds. Always said: "I died at x y z", "My pickaxe broke", "Inventory full, coming back" (then it walks over and drops its haul), "I am low on food and have none", and how a job ended ("Got 5 coal", "I couldn't find any more diamond nearby"). Said unless you typed !quiet: "Killed Steve", "Taking damage, retreating", "Low on food, eating", "Little food on me, getting some first", "Found diamond (2/5)" for diamonds, emeralds, gold and ancient debris. Only with !verbose: every block a job mines. Building, farming and exploring say what they are doing ("Building wheat_farm at x y z, front to the north", "Getting 2 oak_log first", "Crafting oak_planks, oak_slab, composter", "Farming wheat at x y z"), how they ended ("Built small_hut at x y z in 6.2 min", "For small_hut I still need 1 white_bed. Give me those or put them in a chest near the site", "I won't build there: oak planks at x y z could be yours") and every find while exploring ("Iron ore x3 at x y z").

The announcer (`bridge/danger_sensing_agents/announcer.js`) puts all of this in one place, so a watcher always knows what a bot is doing. It says every change of mode or task at once ("mining iron 0/3", "zombie close, fighting", "eating, food at 6", "back to mining iron 1/3"), major steps ("digging down to Y 16", "stuck, trying another path"), "done: mining iron 3/3", and "stalled 20 s: <task>, <why>" when a bot with a task has not moved or changed its bag for 20 seconds. At most one line every 5 seconds per bot, except a change of task or mode and key news (a death, a broken pickaxe, how a job ended), which go out at once, at most 3 lines in any 5 seconds. The same line is never said twice within 30 seconds, and a step that waited more than 15 seconds is dropped. Direct answers to a command are not limited.

## Staying alive

A danger assessor (`bridge/danger_sensing_agents/threats.js`, see docs/danger-assessor.md) looks at the bot and everything around it 5 times a second and scores each danger. Survival modes act on its report with no order needed, pausing whatever job runs, and the job carries on after:

- In lava, on fire or with its head in a block, it gets out: water on its feet when it carries a bucket, else back to the last solid ground or into water nearby, and it digs the block at its head. Out of air in water, it swims up.
- A warden or a wither within 32 blocks, 6 health or less with an enemy within 10, or too many enemies at once below 14 health: it runs, until it is above 10 health or 16 blocks clear.
- A creeper within 6 blocks: it backs off to 9. One that keeps following for 15 seconds gets fought.
- A mob coming at it, in reach, shooting at it with a clear line, or attacking the owner nearby gets the mob fighting mode, with what it carries and no console kit (see The mob fighter). A player who is not a friend and hit it gets the trained network, with the axe kit through the console. Endermen, zombified piglins, piglins while it wears gold, and players who are not friends are only fought once they hit it. It keeps one target until it dies or stops mattering, and gives up on one it cannot get close to in 20 seconds.
- Safe (nothing to fight or run from, no enemy that matters within 12 blocks, not hurt for 3 seconds) with the food bar under 18, it eats before it gets low, picking food that fits under 20 without waste. Health only comes back at 18 or more. Below 14 food (of 20), or below 14 health while not fighting, it eats the best food it carries whatever the danger. Raw meat counts, but raw chicken, rotten flesh, spider eyes and other risky food do not, and golden apples and golden carrots are never eaten or taken from a chest because they stay for the owner. In a food emergency with the bar at 6 or less and nothing better, it eats raw chicken and then rotten flesh as a last resort. With no food at all and a farm the agents built within 96 blocks, it walks there, harvests what is ripe, takes bread, wheat, carrots or potatoes from the farm chest, bakes bread from 3 wheat on a crafting table it places and picks back up, and eats (plan step B5).
- With less food in its bag than the job needs (see Food planning), and never less than 2 full hunger bars (40 food points), it gets more: the agents' farm first, then hunting grown cows, pigs, sheep, chickens and rabbits within 24 blocks, cooking the meat when it can, until it carries enough. A run that comes back short waits 3 minutes, unless it meets an animal it can see within 16 blocks. Not while told to !stay.

### Food planning

`bridge/danger_sensing_agents/skills/food_plan.js` works out the food a job needs before it starts, from the game's hunger rules (4 exhaustion is one food point, a block dug 0.005, a jump 0.05, sprinting 0.1 per meter, 1 health healed 6). Healing is most of the cost, so the plan budgets the health a trip is likely to lose, more underground and more the longer it lasts. From the surface, 3 diamonds need about 42 points and 10 diamonds about 60. The figures for blocks dug per ore and health lost per minute are planning guesses, to be tuned from live runs.

During a trip underground the miner keeps enough for the way home (the climb and one fight's healing, about 21 points from Y -58). Below that it walks home along its own path, gets food, and goes back down to the same tunnel. If home has no food either, it stops there with result `food` and says so, instead of starving at the face.

### Hunting and cooking

A hunt skips baby animals (they drop nothing) and leaves an animal it could not reach alone for 3 minutes. Raw meat goes in a furnace whenever it can (`bridge/danger_sensing_agents/skills/cook.js`): an empty furnace it can see within 24 blocks, the furnace in its bag, or one it crafts from 8 cobblestone. A furnace holding anything is somebody's work and is left alone. Fuel is coal or charcoal first, then planks, sticks and logs (it keeps 2 logs). A furnace it placed goes back in its bag after.

## How it works

Each bot runs a mode manager (`bridge/danger_sensing_agents/modes.js`) ticked every game tick. Highest priority first: escape, kill, retreat, avoid, guard, mobfight, defend, findfood, eat, give, come, resupply, craft, gather, build, mine, explore, farm, follow, guardpost, idle. Escape, retreat, avoid, mobfight, defend, findfood, eat and resupply are always on and act on the danger assessor's report. Build, mine, explore and gather are one shot jobs, starting one ends the others. The farm keeps going underneath them and comes back when they end. The highest mode that is on and wants control runs. A fight pauses a mining job, and the job carries on afterwards. Stop is checked before any mode on every tick and always wins: it turns every mode off, clears the pathfinder goal, the movement keys, digging and any fight.

Every mode belongs to one skill profile, and the manager switches profiles as control moves between modes: fight (kill, guard and defend, the trained network), mobfight (the mob fighter), survive (escape, retreat, avoid, findfood, eat and resupply), mine, build (build and farm), and move (give, come, explore, follow, guardpost). Leaving the fight profile puts the network's keys away, leaving the mine profile stops digging. Each profile can be swapped for a learned one on its own.

Friends are the owner, every agent and the names in `friends` in `agents.config.json`. The bots never attack a friend. Every attack goes through a guard that blocks the swing when the target is a friend or a friend stands in the line of the swing, and a bow or crossbow holds its shot while a friend is in the line. In kill mode all bots share one focus target (`targets.js` Blackboard): the player or the kind of mob the owner named, else the enemy nearest the owner, kept until it dies or leaves the radius. When nobody is left a bot says "Area clear" and goes idle. Kill and guard attack hostile mobs and non-friend players, and animals only when `!kill` names them.

`!guard` holds the spot where it was given. Enemies within the radius of that spot get fought, one that runs further is left alone, and the bot walks back once nothing else needs it. Any job, `!follow` or a meal comes before the walk back, and with a job running or after `!stay` the radius moves with the bot. The always-on modes keep protecting the owner as usual.

### Fighting is the trained network

`fight(bot, target)` in `bridge/danger_sensing_agents/skills/fight.js` is the one entry point. Behind it each bot has a Fighter (`bridge/fighter.js`) aimed at the target. Ten times a second it builds the simulator's 130 inputs and the action mask from what this client receives, `agents_policy.py` picks an action (the trained network, with the skill experts it trained with taking over their action heads), and `Fighter.act` turns it into keys. A decision slower than 100 ms is dropped and the bot idles for that step. The default version is `weights/fighter`, which is not in this repository. Without a saved network a bot told to fight says its fighting network is not running. Set `fighter_run` in `agents.config.json` or pass `--run` to use another one without touching the agents code.

Two things differ from the arena. In open terrain the Fighter works from the blocks this bot has seen: block rays stop at cells it never saw, and an enemy behind cover keeps its last seen place and motion. There are no arena walls, so the border input stays where the middle of an arena would put it. Until the fight has started (nobody hit yet, or nobody hit for 5 s) the bot walks to the target with pathfinder and hands it to the network within 5 blocks, aggressive to start a fight, then whatever works best. Training starts 25 to 27 blocks apart and every opponent walks in by itself, so the network never learned to open a fight against a mob or player that waits, and in the simulator its melee hits land at 2.7 to 3.8 blocks. Once anyone is hit, pathfinder only for a target further than 16 blocks, the network takes over within 10, so it can keep range and shoot.

The network was trained with the axe kit: diamond armor, a diamond axe in slot 1, a diamond sword in slot 2, a crossbow in slot 3, a bow in slot 4, a shield in the offhand and 6 arrows. When kill or guard starts, a bot that lacks any of it gets it through the server console. Whatever was in those slots is moved to the backpack first (and given back by the console if the move fails), and armor is only added to empty armor slots. Other inventories come with the general fighter later.

### The mob fighter

`bridge/danger_sensing_agents/skills/mob_fight.js` answers mobs with what the bot carries, with the trained mob network when it can run (`skills/mob_net.js`) and otherwise with scripted melee: the weapon with the most damage per second, swings only once the weapon has recharged, a hit and a step back from a creeper (and straight away from one that swells within 4 blocks), and a shield in the offhand raised against a skeleton drawing from range. The danger assessor decides what to fight and when to run. When the mob is dead, the job it interrupted carries on.

The mob network takes 182 inputs (the shared 130 plus 52 mob inputs, built in `skills/mob_inputs.js`) and runs through `agents_policy.py --mob`. It takes a fight only when its file exists, `tools/mob_parity.js` passed on that exact file and that exact input code, the policy process answers, the bot carries an axe, and the target is a zombie, skeleton, creeper or enderman or a variant that moves and hits the same way. In any other case the scripted melee takes the fight and the log says why. The network file is not in this repository, so a fresh checkout fights mobs with the scripted melee.

### Walking

Every walk has a time limit and stays off magma and campfires and out of fire, berry bushes, wither roses, powder snow and cobwebs. `walkTo` in `bridge/danger_sensing_agents/skills/move.js` also recovers: 4 seconds with no progress (digging counts as progress) ends the try, it gets unstuck (digs its head free, swims up, digs natural ground in its way, or backs off with a jump) and tries again. The last try can dig through natural ground and pillar up with dirt or cobblestone, and it never breaks a block a player could have placed. Coming to the owner, giving items and the last stretch of the way home use it.

### Mining is scripted

The miner (`bridge/danger_sensing_agents/skills/mine_branch.js`) mines the way a careful player does in 1.21. It only goes for ore it could plausibly know about: ore with an open face on a tunnel or cave cell it has stood in or dug, or ore it can see from where it stands. Ore buried in rock is never found, so there is no X-ray.

For iron, coal and copper it first looks for caves: rays from its eyes find dark open air it can see, it walks to the far end of the cave, torches it and mines the ore in the walls. With no cave in sight, and always for diamonds (since 1.18 many diamonds next to air are never generated), it branch mines: a staircase down to the ore's best depth, then a 2 high main tunnel with a 12 block branch to each side every 3 blocks (2 solid blocks between branches, so every block between them shows a face), back to the main tunnel after each branch. Logs, sand and dirt it finds by walking on the surface.

The best depths come from the Minecraft wiki's ore pages (cited in the code): diamond and redstone Y -58, lapis 0, gold -16, iron 16, copper 48, coal 96 (so it mines just under the surface, it never climbs), emerald 90 in mountains, ancient debris 16 in the Nether.

Safety like a player: lava behind a wall it is about to open makes it turn, lava it can see next to it or under its next step gets a block (it keeps 32 cobblestone or dirt for that), a hole gets a bridge block or is only stepped into when the fall is 3 blocks or less, gravel and sand above a block are waited out before it steps under them, a water bucket goes on its feet when it burns, torches go on the right wall going in (with few left it crafts more from coal and wood in its bag), and it records its path. When the job is done or the bag is full it walks home along that path (home is where the job started) and puts the haul in a chest within 8 blocks of home, keeping tools, armor, torches, food, buckets and 32 blocks. A full bag sends it back down to finish. With no chest at home and none carried it walks to you and drops the haul. It picks the fastest tool it carries that can harvest the block, says "I have no pickaxe" or "My pickaxe is too weak" when it cannot, and counts blocks dug and ore mined for the benchmark.

The tunnel miner (one tunnel with the odd turn, plus anything within 4 blocks) is in `skills/mine.js` as the baseline for the mining benchmark: `node bridge/danger_sensing_agents/agents.js --miner tunnel`.

The human setting adds random short pauses, eased looks around, small sideways detours on the way to an ore, a wobble on every head turn, and torches in dark places when it carries them. Off has none of it, light is the default, full pauses longer (1 to 6 seconds) and more often.

### Building from blueprints

A blueprint is a JSON (JavaScript Object Notation) file in `bridge/danger_sensing_agents/blueprints/` (`skills/blueprint.js` has the full format): a size of at most 16 by 12 by 16, an origin (the cell that sits on the block under your feet, one block outside the front, so the build stands in front of you), a facing (the side its front is on), a palette of one character per block with block states such as facing, half and axis, and layers bottom up, each a list of rows from north to south. Layer 0 is the ground layer and replaces the grass. "." is air it clears and " " leaves the ground as it is. `!build` turns the blueprint to face you, or to the side you name, turning every facing and axis with it.

| blueprint | size | what it is | takes |
|---|---|---|---|
| wheat_farm | 7 by 9 | the plains village small farm, read from the vanilla 1.21.11 structure file (plains_small_farm_1.nbt): oak log border, a water channel down the middle, farmland rows on each side, wheat, a composter as the farmer's job site | 28 oak logs, 27 wheat seeds, 2 water buckets, a composter (7 slabs), a hoe |
| wheat_farm_large | 13 by 9 | the village large farm (plains_large_farm_1.nbt), two channels and two composters | 47 oak logs, 54 seeds, 2 water buckets, 2 composters, a hoe |
| small_hut | 5 by 5, 5 high | plank floor and walls, log corners, an oak door, a white bed, 2 wall torches, a slab roof | 59 planks, 25 slabs, 12 logs, a door, a bed, 2 torches (about 34 logs in all) |
| storage_room | 7 by 5, 5 high | cobblestone floor, oak walls, a door, 2 double chests on the back wall, 2 torches, a slab roof | 35 cobblestone, 46 planks, 35 slabs, 12 logs, 4 chests, a door, 2 torches |
| tree_farm | 9 by 9 | 4 oak saplings 4 apart on cleared ground, 5 torches | 4 saplings, 5 torches |
| wall | 9 long, 4 high | cobblestone with oak log posts at both ends and a cobblestone wall cap | 23 cobblestone, 7 cobblestone walls, 6 logs |

A build goes like a player's (`skills/build.js`):

1. The site. Every cell is checked before anything is touched. It only clears natural blocks: grass, dirt, stone, sand, gravel, flowers, leaves the game placed and logs of natural trees (a trunk that reaches natural leaves). Anything you could have placed (planks, glass, chests, beds, farmland, crops, logs without natural leaves) stops the job with one chat line naming the block and where it is, so a bot never wrecks one of your builds. Water or lava in the way stops it too. A cell that already holds the right block is left alone, so a build can be finished later or run again safely.
2. Materials. What the cells still need, from its bag, then from the chests within 16 blocks of the site (it takes only what the build needs). It fills empty buckets at water it can see. It says exactly what is missing and stops when something is out of its reach (a bed, a water bucket). The simple raw ones it gets itself (`skills/gather.js`): logs from natural trees it can see, cobblestone from stone it can see or a short staircase down, dirt, sand, coal (through the miner), seeds from grass. The simple ones it crafts (`skills/craft.js`, from the 1.21.11 recipes): planks, sticks, slabs, doors, torches, chests, fences, a hoe, a composter, on a crafting table it places off the site and picks back up. Crops start with the seeds it has, the harvest fills the rest.
3. Clearing, top down, digging again when gravel or sand falls in.
4. Placing, layer by layer, bottom up and outside in, a block with something to rest on before an overhang, a dirt scaffold under a block with nothing next to it (removed after, unless it fills a dip under the ground layer). Blocks with a facing (doors, beds, stairs, chests, fence gates) are placed while looking the right way, logs against the face of their axis, slabs and stairs against the right half. Farmland gets tilled with the hoe, water poured from buckets (two sources with a gap between make a third, so 2 buckets fill a channel of any length), then everything that hangs on others: doors, beds, torches, crops.
5. It walks with a pathfinder that never digs and never places stray blocks, prefers to stand outside the footprint, and opens doors. The job keeps its progress, so a fight or a meal can pause it and it carries on after.

What the agents built goes into `server-agents/agents-builds.json` (blueprint, where, facing, modules, crop), so `!farm` and `!expand` find it again. `!expand wheat_farm` adds one module (a divider of logs and another channel with its farmland), turning the small farm into the large one, and `!expand wall` adds 8 blocks of wall. The cells already built count as done.

### Farming

`!farm wheat here` builds the village wheat farm where you stand (unless the agents already have a farm within 24 blocks) and then tends it. `!farm wheat` tends the nearest farm the agents built. Tending (`skills/farm.js`) walks the rows, harvests wheat at age 7, replants, tills trampled farmland again, and once it carries 16 wheat puts the wheat (and seeds beyond the 32 it keeps for replanting) in a chest by the farm, placing one it carries or can craft when there is none. Then it waits by the entrance until something is ripe again. It never ends on its own, `!stop` or `!stay` ends it, and other jobs pause it. Carrots and potatoes use the same farm with their crop.

### Exploring

`!explore 64` (`skills/explore.js`) walks rings of waypoints within the radius, starting the way the bot faces, and a little way into caves it can see (at most 16 blocks below the start, never digging, at most 2 caves a trip). The same only what it can see rule as mining: blocks need a line of sight, animals and villagers count within 32 blocks with a clear line. Each find is said once with coordinates: a village (a bell, villagers, or several village blocks), a cave entrance, exposed ores grouped by kind, lava, water (at most 3 a trip) and animals for food with a count. After a time cap of 5 seconds per block of radius (90 seconds to 10 minutes) it walks back and sums up in one line.

### New blueprints from your words

When the translator finds no blueprint for what you ask, `!design <name> <words>` asks Claude Sonnet 5.5 (`bridge/danger_sensing_agents/designer.js`, model claude-sonnet-5-5, the same API key as the translator) for the blueprint JSON. The answer goes through the same checker as the library: 1.21.11 block names and states, at most 16 by 12 by 16, only blocks the builder can place, and the material count. A blueprint that fails gets one more try with the checker's errors. The bot says the size and the material list in chat before it builds, and the blueprint is saved in `server-agents/blueprints/` for next time. A reply takes up to a minute.

### Live tests

`node bridge/danger_sensing_agents/livetest.js <test>` runs one live test from start to end on the frozen bench world (`bridge/danger_sensing_agents/bench.json`): a world made once from the seed in that file, in `server-agents/bench/`, a pristine copy restored before every test, the same flat grass spot every time (the first flat grass around the world spawn, which `bench_setup` finds and saves in that file). `AGENTS_SPOT=x,y,z` runs a test at another spot of the same world. The bot starts on the real ground 2 blocks east and 2 north of the spot, never on leaves or logs. It starts the agents server on it with `--config bench.properties --world-dir bench` (the normal agents world is never touched), joins a test owner named AgentTester (whitelisted for the test, removed after), gives the kit over RCON, types the commands, saves a top-down picture built from block colors as a PNG (Portable Network Graphics) image to `runs/agents-tests/<test>.png` with the results in `<test>.json`, and stops the server by its PID. Tests: wheat_farm (build the farm, then one harvest, replant and store round with crops growing 100 times faster in the bench world only), mining_proof (a fresh bot with a stone pickaxe mines 5 iron then 10 coal), bench_tunnel and bench_branch (the mining benchmark below), small_hut, explore, translate. `node bridge/danger_sensing_agents/livetest.js all` runs them in that order.

More tests run by name and pass on what the server counts, not on what the bot says: gather_wood, gather_cobblestone, gather_iron, gather_diamond and gather_coal (`!gather` offers four kinds, so coal goes through `!mine`), mining_mobs (a zombie, a creeper and a skeleton summoned next to a bot that starts mining) and diamond_goal (a diamond pickaxe from an empty inventory through the typed commands `!craft wooden pickaxe keep`, `!craft stone pickaxe keep`, `!craft iron pickaxe keep`, `!gather diamonds 3` and `!craft diamond pickaxe keep`, in order). `AGENTS_IN_PROCESS=1` runs the bot inside the test process.

The survival tests pass on the server's own item counts, food bar, position and statistics: food_long (a diamond trip with 10 food points in the bag, cows nearby and a mild hunger effect: at least 40 points before it goes down, a food bar that never falls below 6, and the diamond), hunt_food (no food, animals nearby, a furnace it has to craft: at least 40 points with cooked food in the bag), strip_diamonds (3 diamonds from the surface: Y -54 to -60, branches, torches, and back within 6 blocks of the start) and danger_zombie (a zombie next to a bot that starts mining: the server counts the kill, no console kit, and the job finishes).

The mining benchmark mines 8 iron from the same spot with the same kit (an iron pickaxe, 48 torches, bread, 32 cobblestone, a water bucket) for at most 15 minutes, once with `--miner tunnel` and once with the branch miner, twice each, and writes ores per 100 blocks dug, minutes per ore, deaths, stuck events and the spot to `runs/agents-tests/bench.csv`. A benchmark that mines 0 ores is not passed. Blocks dug and ores come from the server's own player statistics, so both miners are measured the same way.

## Files

```
bridge/danger_sensing_agents/agents.js              starts the bots, reads the owner's chat, runs commands and plans
bridge/danger_sensing_agents/commands.js          the chat parser and the command list
bridge/danger_sensing_agents/modes.js             the priority mode manager
bridge/danger_sensing_agents/behaviors.js         the agents' modes
bridge/danger_sensing_agents/targets.js           friends, enemies, the shared focus, the friendly fire guard
bridge/danger_sensing_agents/threats.js           the danger assessor: every danger scored, and what to do about it
bridge/danger_sensing_agents/announcer.js         says in chat what each bot is doing, the !doing answer, stall news
bridge/danger_sensing_agents/translator.js        plain words to one small request through the Claude API
bridge/danger_sensing_agents/goal_plan.js         the pure planner: a goal and what is available to ordered steps
bridge/danger_sensing_agents/chest_memory.js      what is in the chests the agents have seen, per world
bridge/danger_sensing_agents/owner_bag.js         reads the owner's bag through the console, read only
bridge/danger_sensing_agents/skills/goal_steps.js the planner's own steps: chests, asking, walking over, handing over
bridge/danger_sensing_agents/plan_check.js        checks a single command before it runs: adds the pickaxes it needs, finds the impossible
bridge/danger_sensing_agents/skills/fight.js      fight(bot, target), the kit
bridge/danger_sensing_agents/skills/mob_fight.js  the mob fighter: the mob network when it can run, else scripted melee
bridge/danger_sensing_agents/skills/mob_net.js    runs the trained mob network, after its checks
bridge/danger_sensing_agents/skills/mob_inputs.js  the mob network's 182 inputs
bridge/danger_sensing_agents/skills/policy.js     talks to agents_policy.py
bridge/danger_sensing_agents/skills/mine.js       the tunnel miner for the benchmark, and the shared digging helpers
bridge/danger_sensing_agents/skills/mine_branch.js  the miner: caves, branch mining, safety, home and the chest
bridge/danger_sensing_agents/skills/human.js      the human-like touches
bridge/danger_sensing_agents/skills/food.js       eating, hunting and getting the bag back up to a target
bridge/danger_sensing_agents/skills/food_plan.js  how much food a job needs, when to eat, the food for the way home
bridge/danger_sensing_agents/skills/cook.js       cooking raw food in a furnace
bridge/danger_sensing_agents/skills/blueprint.js  the blueprint format, checker, turning and expanding
bridge/danger_sensing_agents/skills/build.js      building: the site check, materials, clearing, placing
bridge/danger_sensing_agents/skills/craft.js      crafting plans and the crafting table
bridge/danger_sensing_agents/skills/crafter_plan.js  the crafter's planner on the 1.21.11 recipes, the craft request parser
bridge/danger_sensing_agents/skills/crafter.js    a craft job: crafting by hand, smelting, handing the item over
bridge/danger_sensing_agents/skills/gather.js     logs, cobblestone, dirt, sand, seeds, saplings, water
bridge/danger_sensing_agents/skills/gather_kinds.js  the gatherer's four kinds, their words and the gather request parser
bridge/danger_sensing_agents/skills/gatherer.js   the gatherer: one skill per kind (wood, cobblestone, iron, diamonds, coal)
bridge/danger_sensing_agents/skills/farm.js       tending a farm, food from the farm
bridge/danger_sensing_agents/skills/explore.js    scouting
bridge/danger_sensing_agents/skills/storage.js    chests: finding, reading, taking, storing
bridge/danger_sensing_agents/skills/move.js       walking with a time limit, hazards, getting unstuck
bridge/danger_sensing_agents/designer.js          new blueprints through Claude Sonnet 5.5
bridge/danger_sensing_agents/blueprints/          the blueprint library
bridge/danger_sensing_agents/tools/village_farm.js  turns a vanilla village farm structure file into a blueprint
bridge/danger_sensing_agents/tools/crafter_live.js  the crafter end to end on a running agents server (AgentTester plays the player)
bridge/danger_sensing_agents/livetest.js          the live tests and the mining benchmark
bridge/danger_sensing_agents/bench.example.json   the neutral bench world template: seed, empty spot, benchmark kit
bridge/danger_sensing_agents/bench.json           the frozen bench world made from it by bench_setup (git-ignored)
bridge/danger_sensing_agents/config.js            loads and checks the settings: defaults, config file, AGENTS_ environment
bridge/danger_sensing_agents/agents.config.example.json  the template for agents.config.json
bridge/danger_sensing_agents/agents.config.json     owner, bot names, friends, ports, the fighter version (git-ignored)
bridge/danger_sensing_agents/skills/abort.js      shared helpers for ending a job: time limits and sleeps that wake on cancel
agents_policy.py                   runs the trained network for the bots
bridge/fighter.js                  the fighter on a real client: the 130 inputs, the masks, actions to keys
bridge/realcheck/                  checks the Fighter against the simulator and a real server
server-agents/agents-builds.json     what the agents built (not in git, it belongs to the world)
```

Tests that need no server: `node --test bridge/danger_sensing_agents/test/*.test.js` (a fake 1.21.11 world in `test/mockbot.js`, the crafter's in `test/crafter.test.js`, the danger assessor's in `test/threats.test.js`, the gatherer's in `test/gather.test.js`, plain words to a plan in `test/plan.test.js`). `node --test bridge/realcheck/fighter.test.js` tests the parts of `bridge/fighter.js` the simulator cannot reach.

The crafter on a real server: start the agents server with nobody on it, then `node bridge/danger_sensing_agents/tools/crafter_live.js` (or one scene: demo, six, iron, notable, far, twice). It starts Agent1 obeying AgentTester, logs AgentTester in, sets each scene up over RCON and types the requests in chat. Results go to `runs/agents-tests/crafter_live.json`.

## Later phases

Next: more fighters (the memory network, then the general fighter for any inventory) behind `fight(bot, target)`, teammates in the fighter's inputs for 2 against 1 and 2 against 2, mining and building learned from the owner's own recorded play in place of the human-like knobs, and a small learned dig chooser on top of the scripted miner.
