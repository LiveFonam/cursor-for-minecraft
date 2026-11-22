# Cursor for Minecraft

AI agents that play Minecraft with you and against you.

## What is here

- [fighter](fighter/README.md): the 1 versus 1 combat simulator and the masked PPO (Proximal Policy Optimization) trainer
- [danger sensing agents](docs/danger-sensing-agents.md): helper bots in `bridge/danger_sensing_agents/` that fight, gather, mine, craft, build, farm and explore from chat commands or plain words
- [director](director/README.md): the mob director, a Paper plugin that turns hostile mobs against one player
- `bridge/fighter.js` connects a trained fighting network to a Mineflayer bot on a real server.
- `agents_policy.py` runs a saved fighting network for the agents.
- `docs/` also covers the agents' setup and the danger assessor, with a plan for the goal agent.

The crafting planner reads a recipe file generated from a local Minecraft server when one exists, and otherwise uses the recipes in minecraft-data.

## Tests

```sh
cd bridge
npm ci
node --test danger_sensing_agents/test/*.test.js
```

## Credits

The agents are built on these npm packages:

- [mineflayer](https://github.com/PrismarineJS/mineflayer) (MIT)
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) (MIT)
- [minecraft-data](https://github.com/PrismarineJS/node-minecraft-data) (MIT)
- [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) (BSD-3-Clause)
- [prismarine-block](https://github.com/PrismarineJS/prismarine-block) (MIT)
- [prismarine-item](https://github.com/PrismarineJS/prismarine-item) (MIT)
- [prismarine-nbt](https://github.com/PrismarineJS/prismarine-nbt) (MIT)
- [prismarine-physics](https://github.com/PrismarineJS/prismarine-physics) (MIT)
- [prismarine-recipe](https://github.com/PrismarineJS/prismarine-recipe) (MIT)
- [prismarine-registry](https://github.com/PrismarineJS/prismarine-registry) (MIT)
- [vec3](https://github.com/PrismarineJS/node-vec3) (BSD)
- [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) (Apache-2.0)

The setup script downloads [Paper](https://papermc.io), which is not part of this repository.

Minecraft is a trademark of Mojang. This project is not affiliated with Mojang or Microsoft.

## License

MIT, see [LICENSE](LICENSE).
