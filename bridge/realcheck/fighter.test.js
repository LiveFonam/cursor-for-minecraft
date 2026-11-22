// The parts of the real client that the simulator parity test cannot reach: sight through blocks and the
// Mineflayer corrections.

const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { Physics, PlayerState } = require('prismarine-physics')
const { Fighter, OBS_DIM, MASK_SIZE, IDLE_ACTION } = require('../fighter')
const { applyMineflayerFixes } = require('../mineflayer_fixes')

const AIR = { name: 'air', boundingBox: 'empty', transparent: true }
const STONE = { name: 'stone', boundingBox: 'block', transparent: false }
const IN_SIGHT = 38
const FLAT_DISTANCE = 31
const FIRST_RAY = 96
const RAYS = 26
const USE = 7
const WEAPON = 8
const VERSION = '1.21.11'
const RESTING_FALL = -0.0784  // the vertical speed of a body standing on the ground

// Floor below y 0, with a wall across x = 3 for z from -5 to 5
const world = p => {
  const [x, y, z] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
  if (y < 0) return STONE
  return x === 3 && y <= 5 && z >= -5 && z <= 5 ? STONE : AIR
}

function stubBot (enemyAt) {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.entity = { id: 1, type: 'player', position: new Vec3(0.5, 0, 0.5), velocity: new Vec3(0, 0, 0), yaw: -Math.PI / 2, pitch: 0, onGround: true, metadata: {} }
  const enemy = { id: 2, type: 'player', name: 'player', position: enemyAt.clone(), yaw: 0, metadata: {}, equipment: [] }
  bot.entities = { 1: bot.entity, 2: enemy }
  bot.players = { Rival: { entity: enemy } }
  bot.health = 20
  bot.heldItem = { name: 'diamond_axe', components: [] }
  bot.inventory = { hotbarStart: 36, slots: {}, items: () => [] }
  bot.getControlState = () => false
  bot.setControlState = () => {}
  bot.clearControlStates = () => {}
  bot.blockAt = world
  return { bot, enemy }
}

test('an enemy behind cover is hidden and keeps its last seen place', () => {
  const { bot, enemy } = stubBot(new Vec3(2.5, 0, 0.5))
  const f = new Fighter(bot, 'Rival')
  const seen = f.observe()
  assert.strictEqual(seen.length, OBS_DIM)
  assert.strictEqual(seen[IN_SIGHT], 1)
  enemy.position = new Vec3(6.5, 0, 0.5)
  const hidden = f.observe()
  assert.strictEqual(hidden[IN_SIGHT], 0)
  assert.ok(Math.abs(hidden[FLAT_DISTANCE] - seen[FLAT_DISTANCE]) < 1e-9, 'the distance input holds the last seen place')
  assert.strictEqual(f.masks().length, MASK_SIZE)
})

test('block rays stop at cells the bot has not seen, and reach further once it has looked', () => {
  const { bot } = stubBot(new Vec3(2.5, 0, 0.5))
  const f = new Fighter(bot, 'Rival')
  const before = f.observe().slice(FIRST_RAY, FIRST_RAY + RAYS)
  for (let i = 0; i < 8; i++) {
    bot.entity.yaw += Math.PI / 4
    f.observe()
  }
  const after = f.observe().slice(FIRST_RAY, FIRST_RAY + RAYS)
  const total = a => a.reduce((n, v) => n + v, 0)
  assert.ok(total(after) > total(before), 'looking around opens more of the rays')
})

test('a known arena reads its floor and walls without any memory', () => {
  const { bot } = stubBot(new Vec3(2.5, 0, 0.5))
  const f = new Fighter(bot, 'Rival', { arena: { x: 0, y: 0, z: 0, half: 12 } })
  const obs = f.observe()
  assert.strictEqual(obs[IN_SIGHT], 1)
  assert.strictEqual(f.memory.cells.size, 0)
  assert.ok(obs[FIRST_RAY + 16] > 0.99, 'a level ray runs its full range')
})

test('the block memory forgets cells outside the window around the eye', () => {
  const { bot } = stubBot(new Vec3(2.5, 0, 0.5))
  const f = new Fighter(bot, 'Rival')
  f.memory.remember(10, 1, 0, { solid: true, opaque: true, water: false, stop: true })
  f.memory.remember(16, 1, 0, { solid: true, opaque: true, water: false, stop: true })
  f.memory.remember(-16, 1, 0, { solid: true, opaque: true, water: false, stop: true })
  f.memory.remember(-17, 1, 0, { solid: true, opaque: true, water: false, stop: true })
  f.memory.recenter(0, 1, 0)
  assert.ok(f.memory.known(10, 1, 0))
  assert.ok(f.memory.known(-16, 1, 0), '16 behind stays')
  assert.strictEqual(f.memory.known(16, 1, 0), undefined, '16 ahead goes')
  assert.strictEqual(f.memory.known(-17, 1, 0), undefined, '17 behind goes')
})

test('the sprint action is rewritten and other actions pass through', () => {
  const sent = []
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.write = (name, params) => sent.push([name, params])
  bot.entities = {}
  applyMineflayerFixes(bot)
  applyMineflayerFixes(bot)
  bot._client.write('entity_action', { entityId: 1, actionId: 3, jumpBoost: 0 })
  bot._client.write('entity_action', { entityId: 1, actionId: 4, jumpBoost: 0 })
  bot._client.write('entity_action', { entityId: 1, actionId: 0, jumpBoost: 0 })
  bot._client.write('look', { yaw: 1 })
  assert.deepStrictEqual(sent.map(s => s[1].actionId), ['start_sprinting', 'stop_sprinting', 0, undefined])
})

test('on 1.21.11 the corrected sprint packets carry the sprint ids, and the old ids mean riding jump', () => {
  const mc = require('minecraft-protocol')
  const serializer = mc.createSerializer({ state: 'play', version: '1.21.11', isServer: false })
  const actionByte = actionId => serializer.createPacketBuffer({ name: 'entity_action', params: { entityId: 7, actionId, jumpBoost: 0 } })[2]
  assert.strictEqual(actionByte('start_sprinting'), 1)
  assert.strictEqual(actionByte('stop_sprinting'), 2)
  const names = require('minecraft-data')('1.21.11').protocol.play.toServer.types.packet_entity_action[1][1].type[1].mappings
  assert.strictEqual(names[3], 'start_riding_jump')
  assert.strictEqual(names[4], 'stop_riding_jump')
})

function runner () {
  const { bot, enemy } = stubBot(new Vec3(0.5, 0, 2.5))
  const sent = []
  const controls = {}
  bot.yaw = 0
  bot.entity.yaw = Math.PI
  bot.getControlState = k => !!controls[k]
  bot.setControlState = (k, v) => { if (!!controls[k] !== !!v) sent.push([k, !!v]); controls[k] = v }
  bot.look = () => {}
  bot.attack = () => {}
  bot.swingArm = () => {}
  bot.world = { raycast: () => null }
  const f = new Fighter(bot, 'Rival', { arena: { x: 0, y: 0, z: 0, half: 12 } })
  const action = sprint => { const a = [...IDLE_ACTION]; a[0] = 1; a[2] = sprint; return a }
  return { bot, enemy, f, sent, action }
}

test('a charged hit slows a running client and a held key needs a new press for the next sprint hit', () => {
  const { bot, f, sent, action } = runner()
  f.act(action(1))
  assert.strictEqual(f.sprintFlag, true)
  bot.entity.velocity.set(0.2, -0.0784, 0.25)
  f.ticksSinceSwing = 100
  f.swing()
  assert.ok(Math.abs(bot.entity.velocity.z - 0.15) < 1e-9, 'slowed to 0.6')
  assert.strictEqual(bot.entity.velocity.y, -0.0784)
  assert.strictEqual(f.sprintFlag, false, 'the server flag ended')
  f.act(action(1))
  assert.strictEqual(f.sprintFlag, false, 'holding the key does not start it again')
  assert.deepStrictEqual(sent.filter(s => s[0] === 'sprint'), [['sprint', true]], 'no sprint packet after the first press')
  f.act(action(0))
  f.act(action(1))
  assert.strictEqual(f.sprintFlag, true, 'a new press starts it')
})

test('a weak hit keeps the speed, and so does a hit on a raised shield', () => {
  const { bot, enemy, f, action } = runner()
  f.act(action(1))
  bot.entity.velocity.set(0, 0, 0.25)
  f.ticksSinceSwing = 2
  f.swing()
  assert.strictEqual(bot.entity.velocity.z, 0.25, 'weak hit')
  assert.strictEqual(f.sprintFlag, true)
  enemy.yaw = 0
  enemy.heldItem = { name: 'diamond_axe', components: [] }
  enemy.equipment = [enemy.heldItem, { name: 'shield' }]
  enemy.metadata[8] = 3
  f.enemy.shieldTicks = 10
  f.ticksSinceSwing = 100
  f.swing()
  assert.strictEqual(bot.entity.velocity.z, 0.25, 'blocked hit')
  assert.strictEqual(f.sprintFlag, true)
})

test('incoming velocity keeps its value in blocks per tick', () => {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.write = () => {}
  const velocity = new Vec3(0, 0, 0)
  bot.entities = { 7: { velocity } }
  bot._client.on('entity_velocity', p => velocity.set(p.velocity.x / 8000, p.velocity.y / 8000, p.velocity.z / 8000))
  applyMineflayerFixes(bot)
  assert.strictEqual(bot._client.listenerCount('entity_velocity'), 2)
  bot._client.emit('entity_velocity', { entityId: 7, velocity: { x: 0.4, y: 0.36, z: -0.2 } })
  assert.deepStrictEqual([velocity.x, velocity.y, velocity.z], [0.4, 0.36, -0.2])
})

// A fighter with a loaded kit, recording the use packets it sends
function user (held = 'diamond_axe') {
  const { bot } = stubBot(new Vec3(0.5, 0, 6.5))
  const sent = []
  bot.look = () => {}
  bot.attack = () => {}
  bot.swingArm = () => {}
  bot.quickBarSlot = 0
  bot.usingHeldItem = false
  bot.heldItem = { name: held, components: [] }
  bot.activateItem = offHand => { bot.usingHeldItem = true; sent.push(offHand ? 'use off hand' : 'use') }
  bot.deactivateItem = () => { bot.usingHeldItem = false; sent.push('release') }
  bot.setQuickBarSlot = s => { bot.quickBarSlot = s; sent.push(`slot ${s}`) }
  const f = new Fighter(bot, 'Rival', { arena: { x: 0, y: 0, z: 0, half: 12 } })
  const press = on => { const a = [...IDLE_ACTION]; a[USE] = on ? 1 : 0; f.act(a) }
  return { bot, f, sent, press }
}

// The server's copy of the crossbow in the kit's slot, loaded or not
function setCrossbow (bot, loaded) {
  const item = { name: 'crossbow', components: loaded ? [{ type: 'charged_projectiles', data: { projectiles: [{}] } }] : [] }
  bot.heldItem = item
  bot.inventory.slots[bot.inventory.hotbarStart + 2] = item
}

test('the item use flag follows a raised shield and a disable', () => {
  const { bot, f, press } = user()
  assert.strictEqual(bot.fighterUsingItem, false)
  press(true)
  assert.strictEqual(bot.fighterUsingItem, true, 'on from the press, before the next move')
  press(false)
  assert.strictEqual(bot.fighterUsingItem, false, 'off at the release')
  press(true)
  bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:shield', cooldownTicks: 100 })
  assert.strictEqual(bot.fighterUsingItem, false, 'a disabled shield is down')
  assert.strictEqual(f.shieldCooldown, 100)
})

test('a bow draw counts as item use until it is let go', () => {
  const { bot, f, press } = user('bow')
  f.arrows = 6
  press(true)
  assert.strictEqual(bot.fighterUsingItem, true)
  f.drawTicks = 10
  bot._client.write = () => {}
  press(false)
  assert.strictEqual(bot.fighterUsingItem, false)
})

test('a crossbow stays in use after it loads, and the key release reaches the server', () => {
  const { bot, f, sent, press } = user('crossbow')
  setCrossbow(bot, false)
  bot.inventory.items = () => [{ name: 'arrow', count: 6 }]
  press(true)
  assert.strictEqual(bot.fighterUsingItem, true, 'loading')
  f.loadTicks = 30
  f.awaitLoad = 10
  setCrossbow(bot, true)
  f.confirmLoad()
  assert.strictEqual(f.loaded, true)
  assert.strictEqual(f.charging, false)
  assert.strictEqual(bot.fighterUsingItem, true, 'the game keeps it in use while the key is held')
  sent.length = 0
  press(false)
  assert.deepStrictEqual(sent, ['release'])
  assert.strictEqual(bot.fighterUsingItem, false)
  sent.length = 0
  press(false)
  assert.deepStrictEqual(sent, [], 'one release only')
})

test('a crossbow shot leaves no item use behind', () => {
  const { bot, f, sent, press } = user('crossbow')
  setCrossbow(bot, true)
  bot.inventory.items = () => [{ name: 'arrow', count: 5 }]
  f.loaded = true
  f.arrows = 5
  press(true)
  assert.deepStrictEqual(sent, ['use'])
  assert.strictEqual(f.loaded, false)
  assert.strictEqual(bot.usingHeldItem, false)
  assert.strictEqual(bot.fighterUsingItem, false)
})

test('a weapon switch lets go of a raised shield, since the server keeps it up otherwise', () => {
  const { bot, f, sent, press } = user()
  press(true)
  sent.length = 0
  const a = [...IDLE_ACTION]
  a[WEAPON] = 2
  f.act(a)
  assert.deepStrictEqual(sent, ['release', 'slot 1'])
  assert.strictEqual(bot.fighterUsingItem, false)
})

test('a weapon switch with use held raises the shield again, restarting its delay', () => {
  const { bot, f, sent, press } = user()
  press(true)
  f.shieldTicks = 8
  sent.length = 0
  const a = [...IDLE_ACTION]
  a[WEAPON] = 2
  a[USE] = 1
  f.act(a)
  assert.deepStrictEqual(sent, ['release', 'slot 1', 'use off hand'])
  assert.strictEqual(bot.fighterUsingItem, true)
  assert.strictEqual(f.shieldTicks, 0)
})

test('switching away from a held load ends the use with no release packet', () => {
  const { bot, f, sent, press } = user('crossbow')
  setCrossbow(bot, false)
  bot.inventory.items = () => [{ name: 'arrow', count: 6 }]
  press(true)
  f.awaitLoad = 10
  setCrossbow(bot, true)
  f.confirmLoad()
  sent.length = 0
  f.selectSlot(0)
  assert.deepStrictEqual(sent, ['slot 0'], 'the server ends a main hand use on a slot change')
  assert.strictEqual(bot.fighterUsingItem, false)
  assert.strictEqual(bot.usingHeldItem, false)
})

// Forty ticks on the patched client physics over a flat floor, one key held
function walk (control, using) {
  const mcData = require('minecraft-data')(VERSION)
  const Block = require('prismarine-block')(VERSION)
  const stone = mcData.blocksByName.stone.defaultState
  const air = mcData.blocksByName.air.defaultState
  const world = {
    getBlock (p) {
      const cell = p.floored()
      const b = Block.fromStateId(cell.y < 0 ? stone : air, 0)
      b.position = cell
      return b
    }
  }
  const physics = Physics(mcData, world)
  const bot = {
    version: VERSION,
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    fighterUsingItem: using,
    inventory: { slots: [] },
    entity: { position: new Vec3(0.5, 0, 0.5), velocity: new Vec3(0, RESTING_FALL, 0), onGround: true, yaw: 0, pitch: 0, effects: {}, attributes: {} }
  }
  const keys = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, ...control }
  for (let t = 0; t < 40; t++) physics.simulatePlayer(new PlayerState(bot, keys), world).apply(bot)
  return Math.hypot(bot.entity.position.x - 0.5, bot.entity.position.z - 0.5)
}

test('the patched physics moves a client using an item as far as the simulator does', () => {
  // Distances of the same 40 ticks in the simulator's vanilla body
  const SIM_FREE = 8.37476
  const SIM_USING = 1.674952
  const free = walk({ right: true }, false)
  const using = walk({ right: true }, true)
  assert.ok(Math.abs(free - SIM_FREE) < 1e-4, `free ${free}`)
  assert.ok(Math.abs(using - SIM_USING) < 1e-4, `using ${using}`)
  assert.ok(Math.abs(walk({ forward: true }, true) - SIM_USING) < 1e-4)
  assert.ok(Math.abs(using / free - 0.2) < 1e-3, 'exactly a fifth of the speed')
})
