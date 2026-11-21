'use strict'

// Connects a real mineflayer client to a small in-process protocol stub.
// The stub only speaks enough of the protocol to log in and send packets.
// It is not a Minecraft server and has no world, blocks or mobs.

const test = require('node:test')
const assert = require('node:assert')
const { once } = require('node:events')
const mc = require('minecraft-protocol')
const mineflayer = require('mineflayer')
const minecraftData = require('minecraft-data')
const { attachCommands } = require('../src/commands')
const { createHelper } = require('../src/crew')
const { createContext } = require('./helpers/mock-bot')

const VERSION = '1.21.4'
const OWNER_UUID = '11111111-1111-3111-8111-111111111111'
const STRANGER_UUID = '22222222-2222-3222-8222-222222222222'
const STEP_LIMIT_MS = 8000
const data = minecraftData(VERSION)

function within (promise, label) {
  let timer
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), STEP_LIMIT_MS)
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

function nbtText (text) {
  return { type: 'compound', value: { text: { type: 'string', value: text } } }
}

function playerInfo (uuid, name) {
  return { uuid, player: { name, properties: [] }, gamemode: 0, listed: 1, latency: 0 }
}

function chatPacket (senderUuid, name, plainMessage) {
  return {
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

function addPlayers (client) {
  client.write('player_info', {
    action: { add_player: true, update_listed: true, update_game_mode: true, update_latency: true },
    data: [playerInfo(OWNER_UUID, 'TestOwner'), playerInfo(STRANGER_UUID, 'Stranger')]
  })
}

async function waitForPlayers (bot) {
  while (!bot.players.TestOwner || !bot.players.Stranger) {
    await within(once(bot, 'playerJoined'), 'the player list')
  }
}

test('real chat packets: only the owner UUID can command the bot', { timeout: 30000 }, async () => {
  const server = await startStub()
  const { port } = server.socketServer.address()
  const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port,
    username: 'CrewHelper1',
    version: VERSION,
    auth: 'offline',
    physicsEnabled: false
  })
  bot.on('error', () => {})

  try {
    const loggedIn = once(bot, 'login')
    const [client] = await within(once(server, 'playerJoin'), 'the bot to join')
    client.write('login', { ...data.loginPacket, entityId: 1, enforcesSecureChat: false })
    await within(loggedIn, 'login')

    const ctx = createContext(bot, { config: { owner: 'TestOwner', bots: ['CrewHelper1'] } })
    const replies = []
    ctx.modes = { interrupt: () => {}, current: 'idle' }
    ctx.say = line => replies.push(line)
    attachCommands(ctx)

    const joined = waitForPlayers(bot)
    addPlayers(client)
    await joined
    assert.equal(bot.players.TestOwner.uuid, OWNER_UUID)

    const send = async (uuid, name, text) => {
      const seen = once(bot._client, 'playerChat')
      client.write('player_chat', chatPacket(uuid, name, text))
      return (await within(seen, 'a chat packet'))[0]
    }

    await send(STRANGER_UUID, 'Stranger', '@crew status')
    await send(STRANGER_UUID, 'Stranger', 'TestOwner: @crew status')
    assert.deepEqual(replies, [])

    // The library's default chat pattern reads this system line as owner chat.
    const chatEvent = once(bot, 'chat')
    client.write('system_chat', { content: nbtText('* Al TestOwner: @crew status'), isActionBar: false })
    const [patternName] = await within(chatEvent, 'the pattern match')
    assert.equal(patternName, 'TestOwner')
    assert.deepEqual(replies, [])

    const packet = await send(OWNER_UUID, 'TestOwner', '@crew status')
    assert.equal(packet.sender, OWNER_UUID)
    assert.equal(packet.plainMessage, '@crew status')
    assert.equal(replies.length, 1)
    assert.match(replies[0], /^Mode idle/)
  } finally {
    bot.end()
    server.close()
  }
})

test('the full helper starts with real plugins and answers its owner', { timeout: 30000 }, async () => {
  const server = await startStub()
  const { port } = server.socketServer.address()
  const config = {
    owner: 'TestOwner',
    host: '127.0.0.1',
    port,
    version: VERSION,
    auth: 'offline',
    bots: ['CrewHelper1'],
    joinDelayMs: 0
  }
  const logs = []
  const bot = createHelper(config, 'CrewHelper1', { logger: line => logs.push(line) })

  try {
    const spawned = once(bot, 'spawn')
    const [client] = await within(once(server, 'playerJoin'), 'the bot to join')
    const lines = []
    client.on('chat_message', packet => lines.push(packet.message))

    client.write('login', { ...data.loginPacket, entityId: 1, enforcesSecureChat: false })
    client.write('position', {
      teleportId: 1, x: 0.5, y: 64, z: 0.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {}
    })
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
    await within(spawned, 'spawn')
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(logs.some(line => line.endsWith('joined')), logs.join(' | '))
    assert.ok(bot.pathfinder, 'pathfinder loaded')
    assert.ok(bot.pvp, 'pvp loaded')
    assert.ok(bot.collectBlock, 'collect plugin loaded')
    assert.ok(bot.tool, 'tool plugin loaded')
    assert.equal(bot.pvp.attackRange, 3)

    const joined = waitForPlayers(bot)
    addPlayers(client)
    await joined

    const reply = async (uuid, name, text) => {
      const count = lines.length
      client.write('player_chat', chatPacket(uuid, name, text))
      const deadline = Date.now() + 3000
      while (lines.length === count && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return lines.length > count ? lines.at(-1) : null
    }

    assert.equal(await reply(STRANGER_UUID, 'Stranger', '@crew guard'), null)
    assert.equal(await reply(OWNER_UUID, 'TestOwner', '@crew guard'), 'Guarding this spot.')
    await new Promise(resolve => setTimeout(resolve, 1300))
    assert.match(await reply(OWNER_UUID, 'TestOwner', '@crew status'), /^Mode job, job guard/)
    await new Promise(resolve => setTimeout(resolve, 1300))
    assert.equal(await reply(OWNER_UUID, 'TestOwner', '@crew stop'), 'Stopped.')
    await new Promise(resolve => setTimeout(resolve, 1300))
    assert.match(await reply(OWNER_UUID, 'TestOwner', '@crew status'), /^Mode idle, job none/)
  } finally {
    bot.end()
    server.close()
  }
})
