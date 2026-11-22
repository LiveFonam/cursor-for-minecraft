// Sprint packet fix (BUG-111, DEC-088).
//
// Mineflayer 4.39 sends the sprint toggle as entity_action with the numeric ids 3 (start) and 4 (stop), the ids of
// Minecraft 1.8 to 1.21.5. Since 1.21.6 sneaking moved to the player_input packet and the entity_action ids shifted:
// 0 stop_sleeping, 1 start_sprinting, 2 stop_sprinting, 3 start_riding_jump, 4 stop_riding_jump. So on this 1.21.11
// server our bots asked for riding jumps and the server never set their sprint flag: a full charge sprint hit pushed
// the enemy 0.4 like a walking hit instead of 0.7 (measured on a still zombie apex), and the client still
// ran at sprint speed. The names below go through the protocol's own mapper, which exists in every version Mineflayer
// supports, so the fix is right for older servers too.
//
//   node bridge/sprint_fix.js      runs the self test

function fixSprintPackets (bot) {
  const client = bot._client
  const write = client.write.bind(client)
  client.write = (name, params) => {
    if (name === 'entity_action' && params && typeof params.actionId === 'number') {
      if (params.actionId === 3) params = { ...params, actionId: 'start_sprinting' }
      else if (params.actionId === 4) params = { ...params, actionId: 'stop_sprinting' }
    }
    return write(name, params)
  }
}

function selfTest () {
  const sent = []
  const bot = { _client: { write (name, params) { sent.push([name, params]) } } }
  fixSprintPackets(bot)
  bot._client.write('entity_action', { entityId: 7, actionId: 3, jumpBoost: 0 })
  bot._client.write('entity_action', { entityId: 7, actionId: 4, jumpBoost: 0 })
  bot._client.write('entity_action', { entityId: 7, actionId: 'start_sprinting', jumpBoost: 0 })
  bot._client.write('player_input', { inputs: { shift: true } })
  const ids = sent.filter(([n]) => n === 'entity_action').map(([, p]) => p.actionId)
  if (JSON.stringify(ids) !== JSON.stringify(['start_sprinting', 'stop_sprinting', 'start_sprinting'])) {
    throw new Error(`sprint fix sent ${JSON.stringify(ids)}`)
  }
  if (sent[3][0] !== 'player_input' || sent[3][1].inputs.shift !== true) throw new Error('other packets changed')
  console.log('sprint fix: 3 and 4 become start_sprinting and stop_sprinting, other packets untouched')
}

module.exports = { fixSprintPackets }

if (require.main === module) selfTest()
