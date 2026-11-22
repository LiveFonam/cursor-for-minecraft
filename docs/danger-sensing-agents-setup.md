# Danger sensing agents setup instructions

For a developer setting up the helper bots in `bridge/danger_sensing_agents/`, which fight with a network trained in the Minecraft simulator in `fighter/`.

## Repository rules

- Keep the API key in `ANTHROPIC_API_KEY` or a git-ignored `.env` in the repository root or `bridge/`.
- Do not commit Minecraft game files or `server-agents/`. `bridge/danger_sensing_agents/recipes/all-recipes-1.21.11.json` stays git-ignored.

## Setup

```sh
cd bridge
npm ci
cp danger_sensing_agents/agents.config.example.json danger_sensing_agents/agents.config.json   # then put your player name in "owner"
danger_sensing_agents/scripts/setup-server.sh
danger_sensing_agents/server/start.sh
python3 danger_sensing_agents/tools/generate_recipes.py danger_sensing_agents/server/cache/mojang_1.21.11.jar
node --test danger_sensing_agents/test/*.test.js
```

The first server start creates the game jar in `danger_sensing_agents/server/cache/` and stops until you accept the Minecraft EULA in `danger_sensing_agents/server/eula.txt`. The crafter and most tests need the generated recipe file, which stays on your machine. All tests should pass. `bridge/danger_sensing_agents/agents.config.json` is git-ignored because it holds a player name. The target game version is Minecraft Java 1.21.11. The "Start it" section of `docs/danger-sensing-agents.md` sets up a local agents server bound to 127.0.0.1.

`bridge/danger_sensing_agents/bench.json` is made on your machine and stays git-ignored. With the agents server set up, run `node bridge/danger_sensing_agents/livetest.js bench_setup` once. It starts from `bench.example.json`, makes the bench world from the seed, finds the first flat grass spot around the spawn and saves it in `bench.json`. The live tests refuse a bench world made from another seed, and `bench_setup` replaces it.

## What is in place

1. Comments and docs refer only to files in this repository.
2. `bridge/danger_sensing_agents/translator.js` and `designer.js` use `@anthropic-ai/sdk`. The translator defaults to Claude Haiku.
3. `bridge/danger_sensing_agents/bench.example.json` has a neutral world seed and an empty test spot. `bench_setup` saves the filled copy as `bench.json`, which stays git-ignored.
4. `bridge/danger_sensing_agents/tools/generate_recipes.py` builds the recipe file from a local 1.21.11 server jar.
5. `bridge/danger_sensing_agents/config.js` loads and checks the owner, bot names and other settings from `agents.config.json`, with `agents.config.example.json` as the template and `AGENTS_` environment overrides.
6. `bridge/danger_sensing_agents/test/protocol.test.js` logs a real Mineflayer client and the real agents into an in-process protocol stub. `bridge/danger_sensing_agents/skills/abort.js` holds the shared abort and timeout helpers.

7. The fighting path is connected to the simulator. `bridge/fighter.js` builds the 130 inputs and the masks of the 11 action heads defined in `fighter/src/fighter/obs.py`, `actions.py` and `interface.py`, and `agents_policy.py` loads a saved fighter through the `fighter` package. The default network folder, `weights/fighter`, is not in this repository. Set `fighter_run` in `agents.config.json` or pass `--run` to use a trained one. Without one, a bot told to fight says its fighting network is not running.
8. `bridge/mineflayer_fixes.js` corrects Mineflayer 4.39.0 on 1.21.11: the sprint action, the incoming velocity and the player width. `node --test bridge/realcheck/fighter.test.js` tests those corrections and the parts of `bridge/fighter.js` the simulator cannot reach. The rest of `bridge/realcheck/` compares the Fighter with the simulator and with a real server.

## Proof on a real server

Run each check 2 times. A check passes when both runs pass, judged by what the server reports in the inventory and world. If a run fails, fix the cause and run that check 2 times again.

The test player AgentTester stands in for the owner, and the bot's goal is to give the owner the result. Every check ends with the bot walking to AgentTester and handing over what it gathered, crafted or mined, and passes only when the server, read through RCON, shows it in AgentTester's inventory, on top of the check's own counts. The hut and the farm hand over a sample or are confirmed as built. The bench world is a mostly flat spot with oak trees nearby, iron and coal within reach of strip mining.

- Every scene in `bridge/danger_sensing_agents/tools/crafter_live.js`.
- Gathering wood, cobblestone, iron, diamond and coal.
- `mining_proof`, `small_hut`, `wheat_farm` and `explore` in `bridge/danger_sensing_agents/livetest.js`.
- A mining bot with a zombie, creeper and skeleton summoned nearby.
- The full goal of a diamond pickaxe from an empty inventory.

Training gathering and mining in the simulator comes after these pass.
