# Mob director

An invisible agent that turns the hostile mobs against one player. It has no body in the world. It takes over the zombies, creepers and skeletons near the player, steers their own pathfinding, and makes them work together. Its first move works end to end: a creeper blows open a wall, gate or roof, then the zombies come through the hole.

It is a Paper plugin, because the agents are players and cannot steer mobs. It runs on the same server as the agents and changes nothing about the bots.

## Build

You need a Java Development Kit (JDK) 21 and the agents' Paper 1.21.11 server, set up with `AGENTS_SERVER_DIR="$PWD/server-agents" bridge/danger_sensing_agents/scripts/setup-server.sh` and started once. The first start unpacks the Paper API into `server-agents/libraries`. The build compiles against that copy, so it needs no Gradle and downloads nothing.

```sh
node director/scripts/build.js --test
```

This writes `server-agents/plugins/MobDirector.jar` and runs the shelter and planner tests. Restart the server to load it. The settings live in `server-agents/plugins/MobDirector/config.yml`, which is copied from `director/config.yml` on the first start. `MOB_DIRECTOR_SERVER` points the build and the live test at a different server folder.

## Commands

Ops can run these in chat, and the server console can run them too.

| Command | What it does |
| --- | --- |
| `/director start <player>` | Takes over the hostile mobs near the player and goes after them |
| `/director stop` | Ends the encounter. The mobs get their own AI back and no more are spawned |
| `/director status` | Shows the target, the tactic and why it was chosen, and what each mob is doing |
| `/director status json` | The same as one JSON line |
| `/director debug` | Shows each mob's path as the server plans it |
| `/director reload` | Reads the config again |

The encounter also stops when the player dies or logs out.

## How it works

Every half second it reads the world again and picks a tactic. If the player opens a gate, walls up the hole or digs deeper, the next tactic changes with them.

1. **Mobs.** Hostile mobs within 32 blocks of the player join first. It directs at most 4 mobs at once. Each encounter may spawn at most 2 more, 8 seconds apart. A spawn spot must be ground a mob can stand on, 14 to 24 blocks away, outside the player's shelter, and out of the player's sight. Directed mobs carry the scoreboard tag `director`.
2. **Assault.** If a zombie's own pathfinder reaches the player, every directed mob attacks the normal way.
3. **Shut in.** If no zombie can reach the player, it maps the space a zombie could walk to from the player's feet. A zombie can step up one block and drop up to three. If that space stays within 12 blocks of the player, the player is shut in. The walls, gates and roof around that space are breach candidates. A breach is at most 2 blocks thick and no block in it is stronger than cobblestone. Gates come first, then the thinnest and weakest walls.
4. **Breach.** One creeper walks to the outside of the first candidate it can really reach. The other mobs hold 8 blocks back. A held mob does not target the player on its own, but it fights back when hit. At the wall, the creeper lights its normal fuse, and the server handles the explosion and the block damage. After the blast the director looks again. If a mob can now reach the player, it attacks. If not, the breach failed and the director waits 30 seconds before trying again. Killing the creeper first also fails the breach.
5. **Wait.** If no breach is possible, the mobs wait by the gate the player shut. That happens when every wall is too thick or too strong, when the creeper cannot reach any candidate, when the `mob_griefing` game rule is off, or during the cooldown.
6. **Skeletons** shoot when they can see the player and stand at least 8 blocks from a lit fuse.

It never changes health, never removes a block itself, never teleports a mob and changes no setting. Every bit of damage comes from a normal mob attack or the game's own explosion, so the player can still run, kill the creeper or rebuild.

## Demo arena

The live test builds a 7 by 7 yard on a flat world around `0 -60 0`. Its cobblestone walls are 3 high, and its oak fence gate sits at `0 -60 -4`. The gate and one wall block are listed in `config.yml`, so the director tries them first. Whether they can be breached is always read from the blocks there now. To build the arena by hand:

```
/fill -4 -60 -4 4 -58 -4 cobblestone
/fill -4 -60 4 4 -58 4 cobblestone
/fill -4 -60 -4 -4 -58 4 cobblestone
/fill 4 -60 -4 4 -58 4 cobblestone
/setblock 0 -60 -4 oak_fence_gate[facing=north,open=false]
/fill 0 -59 -4 0 -58 -4 air
```

## Live test

The live test needs a Paper 1.21.11 server with the plugin and nobody else on it. Its world must be flat (`level-type=minecraft:flat`), and the remote console (RCON) must be on (`enable-rcon=true`, `rcon.port`, `rcon.password` in `server.properties`). The agents' bench world is not flat, so give the test its own server folder with `MOB_DIRECTOR_SERVER`. Run `npm ci` in `bridge/` first, because the test player uses Mineflayer. The host, port and game version come from `bridge/danger_sensing_agents/config.js`, so `AGENTS_PORT` sets the port.

```sh
node director/scripts/live-test.js
node director/scripts/live-test.js gate_closed
```

AgentTester joins as the target player. The test sets the world to normal difficulty with no natural mob spawning and builds each scene over RCON. The director itself only uses mobs.

| Scene | What it checks |
| --- | --- |
| `gate_open` | A zombie finds the way in and attacks |
| `gate_closed` | The creeper blows the gate while the zombies hold back, then they attack |
| `creeper_killed` | Killing the creeper first fails the breach, leaves the gate standing and starts the cooldown |
| `blast_fails` | A blast at a 2 thick wall leaves no way in, so the mobs back off |
| `underground` | A creeper blows the roof of a shallow room |
| `skeleton` | A skeleton shoots the player |
| `stop_spawns` | After a stop, no more mobs spawn and none stay tagged |
| `disconnect` | The encounter ends when the player logs out |
| `death` | The encounter ends when the player dies |

Results go to `runs/agents-tests/director_live.json`, or to the folder named by `AGENTS_TESTS_DIR`.

## Not built yet

- An ambush at an exit the player keeps using.
- Endermen bridging a moat.
- More than one encounter at a time.
