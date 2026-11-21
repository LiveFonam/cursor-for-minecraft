# Crew

Helper bots for Minecraft Java 1.21. They join a server, take chat commands from one owner, and do jobs like mining, building and farming.

## Setup

You need Node 22 or newer. To host the server yourself you also need Java 21.

```sh
cd crew
npm install
cp crew.config.example.json crew.config.json
```

Put your Minecraft name in `owner` in `crew.config.json`.

To download a local Paper 1.21.4 server:

```sh
scripts/setup-server.sh
```

The script downloads Paper into `crew/server/`, checks its checksum, and tells you what to install if Java is missing. It does not start the server. It does not accept the Minecraft EULA. Read the [EULA](https://aka.ms/MinecraftEULA), and if you agree, create `server/eula.txt` yourself with the line `eula=true`. Then run `server/start.sh`.

With the server running, start the bots:

```sh
npm start
```

## Config

Settings come from the defaults, then `crew.config.json`, then environment variables.

| Key | Variable | Default | Meaning |
| --- | --- | --- | --- |
| `owner` | `CREW_OWNER` | none, required | The only player who can command the bots |
| `host` | `CREW_HOST` | `127.0.0.1` | Server address |
| `port` | `CREW_PORT` | `25565` | Server port |
| `version` | `CREW_VERSION` | `1.21.4` | Minecraft 1.21 release |
| `auth` | `CREW_AUTH` | `offline` | `offline` or `microsoft` |
| `bots` | `CREW_BOTS` | `CrewHelper1,CrewHelper2` | Bot names |
| `joinDelayMs` | `CREW_JOIN_DELAY_MS` | `5000` | Wait between bot joins |

`CREW_CONFIG` points to a different config file.

## Commands

Start a line with `@crew` to talk to every bot, or with `@BotName` to talk to one.

| Command | What it does |
| --- | --- |
| `come` | Walks to you |
| `follow` | Follows you until told otherwise |
| `mine <block> [n]` | Mines ore or blocks, digging tunnels and placing torches |
| `gather <block> [n]` | Collects blocks it can walk to, without digging a path |
| `craft <item> [n]` | Crafts an item and everything it needs along the way |
| `craft me a <tool>` | The crafter: makes one and hands it to you (see below) |
| `build <name>` | Builds a blueprint next to you |
| `farm` | Harvests and replants wheat around you |
| `guard` | Holds this spot and attacks hostile mobs nearby |
| `fight <name>` | Attacks a player or mob by name |
| `status` | Reports mode, job, health and food |
| `stop` | Drops the job and the fight |
| `help` | Lists the commands |

`mine` and `gather` default to 8 items. Counts go up to 256.

## Crafter

`@crew craft me a stone pickaxe` asks the crafter for one item, handed to you. It knows the wooden, stone, iron and diamond pickaxe, the furnace and the crafting table, and common names like wood pickaxe, cobblestone pickaxe and workbench. Any other item still goes to the plain `craft <item> [n]`.

1. It plans from what it really holds, using what it has first: logs become planks and sticks. It uses a crafting table in reach, or crafts and places one, and the wood for it is counted.
2. For an iron pickaxe it uses the ingots it holds first. With raw iron it crafts a furnace if none is near, smelts only the ingots it lacks with coal or spare wood, and checks the ingots are in the bag before crafting.
3. If something is missing it says exactly what, for example "I need 1 cobblestone". It gathers logs or mines the stone, ore or coal itself, which needs a pickaxe for stone. Whatever it still lacks, it asks you for. Drop it by the bot and the job carries on without a second command.
4. A fight or a meal can cut in. The job keeps its progress and picks up again after, and it never makes a second copy, not even on a repeat request.
5. It walks up and drops the item at your feet, and counts it given only when the server says you picked it up. If you are out of reach it keeps the item, says it is ready, and brings it when you come close.

It crafts the way a player does: one item per cell, then a shift click on the result. On a real server, Mineflayer's own `bot.craft` sometimes left a log stuck in the crafting grid and made nothing.

To try it on a server from `scripts/setup-server.sh` (a flat world, with RCON on), run `node scripts/crafter-live.js`. It plays the demo and all six items through chat.

## How it works

Each bot has four modes, highest priority first:

1. **survive** eats when hungry and retreats when hurt or near a creeper.
2. **fight** handles a named target, guard duty and self defense.
3. **job** runs the current command.
4. **idle** waits.

The mode manager checks four times a second and runs the highest mode that wants to run. Switching aborts the running mode. A job keeps its progress outside its run, so it picks up again after a fight or a meal.

All combat goes through one function in `src/combat/fight.js`:

```js
const outcome = await fight(bot, target)
```

It resolves to `defeated`, `gone`, `lost`, `died`, `timeout` or `aborted`. It takes an optional third argument with an abort `signal`. It is the only code that touches mineflayer-pvp, and a test enforces that.

## Blueprints

Blueprints are JSON files in `blueprints/`. This repository has `hut` and `pen`.

```json
{
  "format": "crew-blueprint-1",
  "name": "shed",
  "palette": { "#": "oak_planks", "D": "oak_door" },
  "layers": [
    ["###", "###"],
    ["#D#", "#_#"],
    ["#D#", "#.#"]
  ]
}
```

- `layers` go from the bottom up.
- Each layer is a list of rows from north to south.
- Each character in a row is one block from west to east.
- `palette` maps one character to a block name.
- `_` means the cell must be air.
- `.` means leave the cell alone.
- A door takes the same symbol in two stacked cells.

The build starts 2 blocks east and 2 blocks south of you. Blocks in the way are dug out first. If materials are short, the bot crafts what it can and otherwise lists what is missing.

## Safety

- Commands are accepted only from chat packets whose sender UUID matches the owner. The text of a message is never trusted to say who sent it.
- On an offline mode server, the server cannot prove who a player is, so anyone who joins with the owner's name counts as the owner. The setup script binds the server to `127.0.0.1` for this reason.
- The bots refuse to fight the owner or each other.
- Walking never breaks blocks. Only `mine` digs a path, and it can dig through anything between the bot and the ore, including builds.
- Mining skips blocks that touch lava or water.

## Limits

- Crafting does not smelt. Items like iron ingots must already be in the inventory.
- Blueprints are not rotated, and doors face the way the bot is looking.
- Tilling only happens when the area has no farmland at all.
- Bots do not reconnect after a disconnect.
- Each bot runs an `@crew` command on its own. Two bots do not share a build or its materials, so use `@BotName` to give a build to one bot.
- Servers with chat plugins that resend player chat as system messages will not deliver commands.

## Tests

```sh
npm test
```

Most tests run against the mock bot in `test/helpers/mock-bot.js`. `test/protocol.test.js` connects a real mineflayer client to a small in-process protocol stub, which checks login, plugin loading, the owner check and chat replies. The stub has no world. No test uses a real Minecraft server, so movement, digging, placing, combat and farming have only run on the mock.

## Credits

Built on these npm packages:

- [mineflayer](https://github.com/PrismarineJS/mineflayer) (MIT)
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) (MIT)
- [mineflayer-pvp](https://github.com/PrismarineJS/mineflayer-pvp) (MIT)
- [mineflayer-collectblock](https://github.com/PrismarineJS/mineflayer-collectblock) (MIT)
- [minecraft-data](https://github.com/PrismarineJS/minecraft-data) (MIT)
- [vec3](https://github.com/PrismarineJS/node-vec3) (BSD)

Tests also use [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) (BSD-3-Clause), [prismarine-block](https://github.com/PrismarineJS/prismarine-block) (MIT), [prismarine-recipe](https://github.com/PrismarineJS/prismarine-recipe) (MIT) and [prismarine-registry](https://github.com/PrismarineJS/prismarine-registry) (MIT).

The setup script downloads [Paper](https://papermc.io), which is not part of this repository.

Minecraft is a trademark of Mojang. This project is not affiliated with Mojang or Microsoft.
