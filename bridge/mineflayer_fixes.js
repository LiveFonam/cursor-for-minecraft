// Four corrections for Mineflayer 4.39.0 on Minecraft 1.21.11.
//
// Width: the game's player is 0.6F wide, a float slightly over 0.6, and prismarine-physics uses exactly 0.3 for half of
// it. Pressed against a wall, the bot then reports a spot 0.00000001 blocks inside the wall. Paper sends it back every
// tick, which cancels its jump, so it can never climb a one block step.
// Sprint: Mineflayer writes entity_action with the numeric ids 3 and 4, which this protocol reads as riding jump
// actions, so the server never starts the sprint. They are rewritten to the named sprint actions.
// Velocity: entity_velocity already holds blocks per tick on this protocol and Mineflayer divides it by 8000. A
// listener registered after Mineflayer's own sets the real value on the entity.
// Dig time: the 1.21.11 data files give every ore that needs a better pickaxe the material incorrect_for_wooden_tool, which
// only lists wooden tools, so a stone pickaxe counts as a bare hand and iron ore takes 4.55 s instead of the game's
// 1.15 s. The crack finishes on the server and the bot keeps standing there until its own timer ends. All 108 blocks
// with this material are mined with a pickaxe, so it gets the pickaxe speeds.

const SPRINT_ACTIONS = { 3: 'start_sprinting', 4: 'stop_sprinting' }
const PLAYER_HALF_WIDTH = Math.fround(0.6) / 2

function fixSprint (bot) {
  const client = bot._client
  const write = client.write.bind(client)
  client.write = (name, params) => {
    if (name === 'entity_action' && params && SPRINT_ACTIONS[params.actionId]) {
      params = { ...params, actionId: SPRINT_ACTIONS[params.actionId] }
    }
    return write(name, params)
  }
}

function fixVelocity (bot) {
  bot._client.on('entity_velocity', p => {
    const e = bot.entities[p.entityId]
    if (e) e.velocity.set(p.velocity.x, p.velocity.y, p.velocity.z)
  })
}

function fixDigTimes (registry) {
  const wrong = registry?.materials?.incorrect_for_wooden_tool
  const pickaxe = registry?.materials?.['mineable/pickaxe']
  if (!wrong || !pickaxe) return
  for (const id of Object.keys(wrong)) delete wrong[id]
  Object.assign(wrong, pickaxe)
}

// Safe to call more than once on a bot. Call it on spawn, after Mineflayer has added its own packet listeners
function applyMineflayerFixes (bot) {
  if (bot.mineflayerFixes) return
  bot.mineflayerFixes = true
  if (bot.physics) bot.physics.playerHalfWidth = PLAYER_HALF_WIDTH
  fixDigTimes(bot.registry)
  fixSprint(bot)
  fixVelocity(bot)
}

module.exports = { applyMineflayerFixes, fixDigTimes, PLAYER_HALF_WIDTH }
