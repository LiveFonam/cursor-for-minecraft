// The fighter's crossbow and sword rules, and where its aim sends an arrow
const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')
const { EventEmitter } = require('node:events')

class Vec3 {
  constructor (x, y, z) { this.x = x; this.y = y; this.z = z }
  offset (x, y, z) { return new Vec3(this.x + x, this.y + y, this.z + z) }
  clone () { return new Vec3(this.x, this.y, this.z) }
  equals (o) { return this.x === o.x && this.y === o.y && this.z === o.z }
  distanceTo (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) }
}
const STUBS = {
  vec3: { Vec3 },
  'mineflayer/lib/conversions': { toNotchianYaw: y => (Math.PI - y) * 180 / Math.PI, toNotchianPitch: p => -p * 180 / Math.PI }
}
const load = Module._load
Module._load = function (request, parent, main) {
  return request in STUBS ? STUBS[request] : load.call(this, request, parent, main)
}
const { Fighter, HEAD_OFFSETS, ACTION_DIMS, OBS_DIM, SLOT_OF } = require('../fighter')
Module._load = load

const WEAPON = 8
const USE = 7
const LOCK_AIM = 10
const [KEEP, AXE, SWORD, CROSSBOW, BOW] = [0, 1, 2, 3, 4]
const ENEMY_DISTANCE = 32
const ENEMY_IN_SIGHT = 38
const ENEMY_HURT = 46
const ENEMY_SHIELD_UP = 52
const ENEMY_SHIELD_DISABLED = 54
const ENEMY_FACING = 55

function fakeBot (gap = 8) {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.entity = { id: 7, yaw: 0, pitch: 0, onGround: true, position: new Vec3(0, 100, 0), velocity: new Vec3(0, 0, 0), metadata: {}, height: 1.8 }
  bot.health = 20
  const slots = []
  slots[36] = { name: 'diamond_axe', components: [] }
  slots[37] = { name: 'diamond_sword', components: [] }
  slots[38] = { name: 'crossbow', components: [] }
  slots[39] = { name: 'bow', components: [] }
  bot.inventory = { hotbarStart: 36, slots, items: () => [{ name: 'arrow', count: 6 }] }
  bot.quickBarSlot = 0
  Object.defineProperty(bot, 'heldItem', { get: () => slots[36 + bot.quickBarSlot] })
  bot.setQuickBarSlot = s => { bot.quickBarSlot = s }
  bot.players = { Rival: { entity: { id: 9, type: 'player', yaw: 0, position: new Vec3(0, 100, gap), metadata: {}, equipment: [], heldItem: slots[36], width: 0.6, height: 1.8 } } }
  bot.uses = 0
  bot.activateItem = () => { bot.uses++ }
  bot.deactivateItem = () => {}
  bot.setControlState = () => {}
  bot.getControlState = () => false
  bot.clearControlStates = () => {}
  bot.look = () => {}
  bot.swingArm = () => {}
  bot.attack = () => {}
  bot.blockAt = () => null
  bot.world = new EventEmitter()
  return bot
}

function arenaFighter (gap = 8) {
  const bot = fakeBot(gap)
  const f = new Fighter(bot, 'Rival', { arena: { x: 0, y: 100, z: 0, half: 10 } })
  f.sight = { pos: bot.players.Rival.entity.position, move: { x: 0, y: 0, z: 0 }, visible: true, chestClear: true, crosshairClear: true, seen: true }
  return { f, bot }
}

function inputs (values = {}, gap = 8) {
  const obs = new Array(OBS_DIM).fill(0)
  obs[ENEMY_DISTANCE] = gap / 32
  obs[ENEMY_IN_SIGHT] = 1
  for (const [k, v] of Object.entries(values)) obs[k] = v
  return obs
}

const head = (mask, h) => mask.slice(HEAD_OFFSETS[h], HEAD_OFFSETS[h] + ACTION_DIMS[h])
const only = (mask, h) => head(mask, h).flatMap((v, i) => (v ? [i] : []))
const masked = (f, values, gap) => { f.lastObs = inputs(values, gap); return f.masks() }
function afterOpening (f) { f.openingLoad = false }

test('a fight opens by loading the crossbow, from the axe', () => {
  const { f } = arenaFighter(16)
  const mask = masked(f, {}, 16)
  assert.deepStrictEqual(only(mask, WEAPON), [CROSSBOW])
  assert.deepStrictEqual(only(mask, USE), [1])
})

test('the opening load is dropped when hurt early, and kept once it is almost done', () => {
  const early = arenaFighter()
  early.f.bot.setQuickBarSlot(SLOT_OF.crossbow)
  early.f.charging = true
  early.f.loadTicks = 10
  early.f.hurtTimer = 5
  const mask = masked(early.f, {})
  assert.deepStrictEqual(only(mask, WEAPON), [AXE])
  assert.deepStrictEqual(only(mask, USE), [0])
  assert.strictEqual(early.f.openingLoad, false)

  const late = arenaFighter()
  late.f.bot.setQuickBarSlot(SLOT_OF.crossbow)
  late.f.charging = true
  late.f.loadTicks = 20
  late.f.hurtTimer = 5
  const kept = masked(late.f, {})
  assert.deepStrictEqual(only(kept, WEAPON), [CROSSBOW])
  assert.deepStrictEqual(only(kept, USE), [1])
})

test('the bow can never be selected', () => {
  const { f } = arenaFighter()
  afterOpening(f)
  assert.strictEqual(head(masked(f, {}), WEAPON)[BOW], 0)
  f.enemy.shieldCooldown = 50
  assert.strictEqual(head(masked(f, {}), WEAPON)[BOW], 0)
})

test('the sword is closed until the enemy shield is disabled', () => {
  const { f } = arenaFighter(2)
  afterOpening(f)
  assert.strictEqual(head(masked(f, {}, 2), WEAPON)[SWORD], 0)
  f.enemy.shieldCooldown = 60
  assert.strictEqual(head(masked(f, { [ENEMY_SHIELD_DISABLED]: 0.6 }, 2), WEAPON)[SWORD], 1)
})

test('holding the sword when the window ends forces a switch away', () => {
  const { f, bot } = arenaFighter(2)
  afterOpening(f)
  bot.setQuickBarSlot(SLOT_OF.sword)
  f.enemy.shieldCooldown = 1
  assert.strictEqual(head(masked(f, { [ENEMY_SHIELD_DISABLED]: 0.01 }, 2), WEAPON)[KEEP], 1)
  f.enemy.shieldCooldown = 0
  const closed = head(masked(f, {}, 2), WEAPON)
  assert.strictEqual(closed[KEEP], 0)
  assert.strictEqual(closed[SWORD], 0)
  assert.strictEqual(closed[AXE], 1)
})

test('the window opens from the shield break sound at the enemy and runs out', () => {
  const { f, bot } = arenaFighter(2)
  afterOpening(f)
  bot._client.emit('sound_effect', { sound: { data: { soundName: 'item.shield.break' } }, x: 0, y: 800, z: 16 })
  assert.strictEqual(f.enemy.shieldCooldown, 100)
  for (let t = 0; t < 100; t++) f.enemy.tick()
  assert.strictEqual(f.enemy.shieldCooldown, 0)
})

test('a loaded crossbow holds fire at a raised shield that faces the shooter', () => {
  const { f, bot } = arenaFighter()
  afterOpening(f)
  bot.setQuickBarSlot(SLOT_OF.crossbow)
  f.loaded = true
  const mask = masked(f, { [ENEMY_SHIELD_UP]: 1, [ENEMY_FACING]: 1 })
  assert.deepStrictEqual(only(mask, USE), [0])
})

test('a loaded crossbow may fire at a raised shield that faces away', () => {
  const { f, bot } = arenaFighter()
  afterOpening(f)
  bot.setQuickBarSlot(SLOT_OF.crossbow)
  f.loaded = true
  const mask = masked(f, { [ENEMY_SHIELD_UP]: 1, [ENEMY_FACING]: -1 })
  assert.strictEqual(head(mask, USE)[1], 1)
})

test('a loaded crossbow holds fire during the enemy hurt window', () => {
  const { f, bot } = arenaFighter()
  afterOpening(f)
  bot.setQuickBarSlot(SLOT_OF.crossbow)
  f.loaded = true
  assert.deepStrictEqual(only(masked(f, { [ENEMY_HURT]: 0.5 }), USE), [0])
})

test('a far visible target brings the loaded crossbow out with lock aim', () => {
  const { f, bot } = arenaFighter(10)
  afterOpening(f)
  f.loaded = true
  assert.deepStrictEqual(only(masked(f, {}, 10), WEAPON), [CROSSBOW])
  bot.setQuickBarSlot(SLOT_OF.crossbow)
  assert.deepStrictEqual(only(masked(f, {}, 10), LOCK_AIM), [1])
})

test('right after a shield disable a loaded crossbow fires with one fresh press', () => {
  const { f, bot } = arenaFighter(3.5)
  afterOpening(f)
  bot.setQuickBarSlot(SLOT_OF.crossbow)
  f.loaded = true
  const pressed = masked(f, { [ENEMY_SHIELD_DISABLED]: 0.95 }, 3.5)
  assert.deepStrictEqual(only(pressed, WEAPON), [CROSSBOW])
  assert.deepStrictEqual(only(pressed, USE), [1])
  f.useHeld = true
  assert.deepStrictEqual(only(masked(f, { [ENEMY_SHIELD_DISABLED]: 0.95 }, 3.5), USE), [0])
})

test('inside axe reach the crossbow is closed and cannot be kept', () => {
  const { f, bot } = arenaFighter(2)
  afterOpening(f)
  bot.setQuickBarSlot(SLOT_OF.crossbow)
  const weapons = head(masked(f, {}, 2), WEAPON)
  assert.strictEqual(weapons[CROSSBOW], 0)
  assert.strictEqual(weapons[KEEP], 0)
  assert.strictEqual(weapons[AXE], 1)
})

test('the ready input waits for a swing strong enough to crit', () => {
  const { f } = arenaFighter()
  assert.strictEqual(f.swingReady(0.85), false)
  assert.strictEqual(f.swingReady(0.9), true)
  const plain = Object.create(Fighter.prototype)
  assert.strictEqual(plain.swingReady(0.85), true)
})

test('a client without an arena keeps every weapon open', () => {
  const f = new Fighter(fakeBot(), 'Rival')
  f.sight = { pos: null, visible: false }
  f.lastObs = inputs()
  const weapons = head(f.masks(), WEAPON)
  assert.deepStrictEqual(weapons, [1, 1, 1, 1, 1])
})

function critFighter (values) {
  const bot = fakeBot(2)
  const f = new Fighter(bot, 'Rival', { arena: { x: 0, y: 100, z: 0, half: 10 }, critRule: true })
  f.sight = { pos: bot.players.Rival.entity.position, move: { x: 0, y: 0, z: 0 }, visible: true, chestClear: true, crosshairClear: true, seen: true }
  afterOpening(f)
  return { f, bot, mask: masked(f, { 12: 1, 33: 0.4, 35: 1, ...values }, 2) }
}

test('the crit rule is off unless asked for', () => {
  const { f } = arenaFighter(2)
  afterOpening(f)
  assert.strictEqual(f.critRule, false)
  const mask = masked(f, { 4: 1, 12: 1, 16: 1, 35: 1 }, 2)
  assert.deepStrictEqual(only(mask, 3).length, 2)
  assert.deepStrictEqual(only(mask, 6).length, 3)
})

test('on the ground near a ready charge the crit rule jumps and holds the swing', () => {
  const { mask } = critFighter({ 4: 1, 16: 0.95 })
  assert.deepStrictEqual(only(mask, 3), [1])
  assert.deepStrictEqual(only(mask, 6), [0])
})

test('falling with a ready charge and sprint off the crit rule swings', () => {
  const { mask } = critFighter({ 11: 0.05, 16: 0.95 })
  assert.deepStrictEqual(only(mask, 2), [0])
  assert.deepStrictEqual(only(mask, 6), [1])
})

test('a raised shield facing the fighter is hit at once', () => {
  const { mask } = critFighter({ 4: 1, 16: 0.3, [ENEMY_SHIELD_UP]: 1, [ENEMY_FACING]: 1 })
  assert.deepStrictEqual(only(mask, 6), [1])
})

test('a ready swing at an enemy leaving reach is not held', () => {
  const { mask } = critFighter({ 16: 0.95, 33: 0.7 })
  assert.ok(head(mask, 6)[1] === 1)
})

test('the sprint release is sent before the attack in one action', () => {
  const { f, bot } = arenaFighter(2)
  const order = []
  bot.setControlState = (k, v) => { if (k === 'sprint') order.push(`sprint:${v}`) }
  bot.attack = () => order.push('attack')
  f.crosshairOnEnemy = () => true
  f.ticksSinceSwing = 20
  const action = [1, 0, 0, 0, 6, 5, 1, 0, 0, 0, 0]
  f.act(action)
  assert.deepStrictEqual(order, ['sprint:false', 'attack'])
})

// One crossbow arrow: it moves, then slows, then falls
function arrowPasses (from, yawDeg, pitchDeg, target) {
  const y = yawDeg * Math.PI / 180
  const p = pitchDeg * Math.PI / 180
  const v = { x: -Math.sin(y) * Math.cos(p) * 3.15, y: -Math.sin(p) * 3.15, z: Math.cos(y) * Math.cos(p) * 3.15 }
  const at = { ...from }
  for (let t = 0; t < 40; t++) {
    const steps = 20
    for (let s = 1; s <= steps; s++) {
      const x = at.x + v.x * s / steps
      const h = at.y + v.y * s / steps
      const z = at.z + v.z * s / steps
      if (Math.abs(x - target.x) <= 0.3 && Math.abs(z - target.z) <= 0.3 && h >= target.y && h <= target.y + 1.8) return true
    }
    at.x += v.x; at.y += v.y; at.z += v.z
    v.x *= 0.99; v.y = v.y * 0.99 - 0.05; v.z *= 0.99
  }
  return false
}

test('lock aim puts a crossbow arrow on a still target at every fight range', () => {
  for (const gap of [4, 8, 12, 16]) {
    const { f, bot } = arenaFighter(gap)
    bot.setQuickBarSlot(SLOT_OF.crossbow)
    const shot = f.solveShot()
    const from = { x: 0, y: 100 + f.eyeHeight() - 0.1, z: 0 }
    assert.ok(arrowPasses(from, shot.yaw, shot.pitch, bot.players.Rival.entity.position), `missed at ${gap} blocks`)
  }
})
