// Logs a real Mineflayer client, and the real agents, into a small in-process protocol stub. The stub speaks just enough
// of the 1.21.11 protocol to log in and send packets. It has no world, blocks or mobs.

const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const mc = require('minecraft-protocol')
const mineflayer = require('mineflayer')
const minecraftData = require('minecraft-data')

const VERSION = '1.21.11'
const OWNER_UUID = '11111111-1111-3111-8111-111111111111'
const STRANGER_UUID = '22222222-2222-3222-8222-222222222222'
const STEP_MS = 8000
const data = minecraftData(VERSION)

function within (promise, label) {
  let timer
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), STEP_MS)
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

const nbtText = text => ({ type: 'compound', value: { text: { type: 'string', value: text } } })

function chatPacket (senderUuid, name, plainMessage) {
  return {
    globalIndex: 0,
    senderUuid,
    index: 0,
    signature: undefined,
    plainMessage,
    timestamp: BigInt(Date.now()),
    salt: 0n,
    previousMessages: [],
    unsignedChatContent: undefined,
    filterType: 0,
    filterTypeMask: undefined,
    type: { chatType: 0 },
    networkName: nbtText(name),
    networkTargetName: undefined
  }
}

async function startStub () {
  const registryCodec = Object.entries(data.loginPacket.dimensionCodec)
    .map(([id, entry]) => entry.id ? entry : { id, entries: entry })
  const server = mc.createServer({
    'online-mode': false,
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    keepAlive: false,
    registryCodec
  })
  if (!server.socketServer?.listening) await within(once(server, 'listening'), 'the stub to listen')
  return server
}

function sendWorld (client) {
  client.write('login', { ...data.loginPacket, entityId: 1, enforcesSecureChat: false })
  client.write('position', {
    teleportId: 1, x: 0.5, y: 64, z: 0.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {}
  })
  client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
}

function addPlayers (client) {
  const entry = (uuid, name) => ({ uuid, player: { name, properties: [] }, gamemode: 0, listed: 1, latency: 0 })
  client.write('player_info', {
    action: { add_player: true, update_listed: true, update_game_mode: true, update_latency: true },
    data: [entry(OWNER_UUID, 'TestOwner'), entry(STRANGER_UUID, 'Stranger')]
  })
}

test('a real Mineflayer client logs in on 1.21.11 and spawns', { timeout: 30000 }, async () => {
  const server = await startStub()
  const { port } = server.socketServer.address()
  const bot = mineflayer.createBot({ host: '127.0.0.1', port, username: 'Agent1', version: VERSION, auth: 'offline', physicsEnabled: false })
  bot.on('error', () => {})
  try {
    const spawned = once(bot, 'spawn')
    const [client] = await within(once(server, 'playerJoin'), 'the bot to join')
    assert.equal(client.username, 'Agent1')
    sendWorld(client)
    await within(spawned, 'spawn')
    assert.equal(bot.game.minY !== undefined, true)
    assert.equal(bot.health, 20)
    assert.equal(bot.entity.position.y, 64)
  } finally {
    bot.end()
    server.close()
  }
})

test('the agents obey their owner on real chat packets and ignore a stranger', { timeout: 30000 }, async () => {
  const server = await startStub()
  const { port } = server.socketServer.address()
  // node --test runs each file in its own process, so the agents loads this port from the environment
  Object.assign(process.env, { AGENTS_PORT: String(port), AGENTS_OWNER: 'TestOwner', AGENTS_BOTS: 'Agent1', AGENTS_FRIENDS: '' })
  const { Agents } = require('../agents')
  const agents = new Agents({ names: ['Agent1'], owner: 'TestOwner', run: 'weights/fighter', translator: false, builds: '/nonexistent/agents-builds.json' })
  agents.builds.save = () => {}
  try {
    const joining = agents.connect('Agent1')
    const [client] = await within(once(server, 'playerJoin'), 'the agent to join')
    const lines = []
    client.on('chat_message', p => lines.push(p.message))
    sendWorld(client)
    const bot = await within(joining, 'the agent to spawn')
    assert.ok(bot, 'the agent spawned')
    assert.ok(bot.pathfinder, 'pathfinder loaded')
    assert.ok(agents.ctxs.get('Agent1')?.manager, 'the mode manager is running')

    const players = once(bot, 'playerJoined')
    addPlayers(client)
    await within(players, 'the player list')

    const say = async (uuid, name, text) => {
      const before = lines.length
      client.write('player_chat', chatPacket(uuid, name, text))
      const until = Date.now() + 2000
      while (lines.length === before && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25))
      return lines.slice(before)
    }

    assert.deepEqual(await say(STRANGER_UUID, 'Stranger', '!status'), [])
    const reply = await say(OWNER_UUID, 'TestOwner', '!status')
    assert.equal(reply.length, 1)
    assert.match(reply[0], /health/i)

    // lines made to look like the owner, then one real order: only the real one gets an answer
    const seen = []
    bot.on('messagestr', text => seen.push(text))
    const sayType = bot.registry.chatFormattingByName['minecraft:say_command'] ?? bot.registry.chatFormattingByName.say_command
    const before = lines.length
    client.write('player_chat', { ...chatPacket(STRANGER_UUID, 'Stranger', '<TestOwner> !status'), type: { chatType: sayType.id } })
    client.write('player_chat', { ...chatPacket(OWNER_UUID, 'TestOwner', '<TestOwner> !status'), type: { chatType: sayType.id } })
    client.write('player_chat', chatPacket(STRANGER_UUID, 'TestOwner', '!status'))
    client.write('system_chat', { content: nbtText('<TestOwner> !status'), isActionBar: false })
    client.write('profileless_chat', { message: nbtText('!status'), type: { chatType: 0 }, name: nbtText('TestOwner'), target: undefined })
    const real = await say(OWNER_UUID, 'TestOwner', '!doing')
    assert.ok(seen.includes('[Stranger] <TestOwner> !status'), seen.join(' | '))
    assert.equal(seen.filter(t => t === '<TestOwner> !status').length, 3, 'copied name, system line and profileless chat all arrived')
    assert.equal(lines.length - before, 1, lines.slice(before).join(' | '))
    assert.equal(real.length, 1)
    assert.doesNotMatch(real[0], /health/i, 'the answer is to the real !doing, not to a forged !status')
  } finally {
    agents.close()
    server.close()
  }
})
