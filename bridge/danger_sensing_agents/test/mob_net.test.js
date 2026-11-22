// The mob network path with no server and no Python: the inputs against situations recorded from the simulator, when
// the network may run, the fallback to the scripted fighter, and stop and cancel.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { Vec3 } = require('vec3')
const { makeBot, registry } = require('./mockbot')
const { MobFighter } = require('../skills/mob_fight')
const { MobNet, MobNetDriver, checkParity, unsafeStep } = require('../skills/mob_net')
const { buildMobInputs, buildMobMask, MobTracker, INPUTS, MASK } = require('../skills/mob_inputs')
const { PolicyClient } = require('../skills/policy')
const { YAW_STEPS, PITCH_STEPS } = require('../../fighter')

const Item = require('prismarine-item')(registry)
const IDLE = [0, 0, 0, 0, YAW_STEPS.indexOf(0), PITCH_STEPS.indexOf(0), 0, 0, 0, 0, 0]
const SWING = IDLE.map((v, i) => (i === 6 ? 1 : v))
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const pause = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)) }

function mob (bot, name, dz = 2, hp = 20) {
  const p = bot.entity.position
  const e = { id: 700 + Object.keys(bot.entities).length, type: 'hostile', name, position: new Vec3(p.x, p.y, p.z + dz), velocity: new Vec3(0, 0, 0), yaw: 0, height: 1.95, metadata: { 9: hp } }
  bot.entities[e.id] = e
  return e
}

function fakeNet (answer = () => SWING) {
  return { asked: 0, ready: async () => ({ ok: true }), act: async function () { this.asked++; return answer(this.asked) } }
}

function armed (name = 'iron_axe') {
  const { bot } = makeBot()
  bot.give(name, 1)
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  return bot
}

// Looks straight at the mob, which the crosshair needs (Mineflayer yaw PI faces +z)
const facing = bot => { bot.entity.yaw = Math.PI; bot.entity.pitch = 0 }

test('every input slot and mask value matches the recorded simulator situations', () => {
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'mob_parity_sample.json.gz'))))
  assert.ok(rows.length >= 60)
  for (const r of rows) {
    const obs = buildMobInputs(r.state)
    const mask = buildMobMask(r.state)
    assert.equal(obs.length, INPUTS)
    assert.equal(mask.length, MASK)
    for (let i = 0; i < INPUTS; i++) assert.ok(Math.abs(obs[i] - r.obs[i]) <= 1e-4, `slot ${i}: ${obs[i]} against ${r.obs[i]}`)
    assert.deepEqual(mask, r.mask)
  }
})

test('the tracker counts a hit once per decision and a teleport is not speed', () => {
  const frame = (z, hp, extra = {}) => ({ me: { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0, pitch: 0, onGround: true, hp: 20 }, mobs: [{ id: 1, kind: 3, pos: [0, 0, z], hp, yaw: 0, swellDir: -1 }], arrows: [], ...extra })
  const t = new MobTracker({ arena: { x: 0, z: 0, half: 12 } })
  t.reset(frame(5, 40))
  t.tick(frame(5, 31, { swung: true, hitMobs: [1], hurtMobs: [1] }), IDLE)
  t.tick(frame(5, 31), IDLE)
  t.endDecision(SWING, 2)
  const s = t.state()
  assert.equal(s.memory.sinceHit, 0)
  assert.equal(s.memory.combo, 1)
  assert.equal(s.memory.enemyHealth, 11)
  assert.equal(s.mobs[0].hurtTimer, 8)
  t.tick(frame(11, 31), IDLE)
  assert.deepEqual(t.state().mobs[0].vel, [0, 0, 0])
})

test('the network may run only on the exact file and input code the parity check passed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobnet-'))
  const file = path.join(dir, 'expert.npz')
  const code = path.join(__dirname, '..', 'skills', 'mob_inputs.js')
  assert.match(checkParity(file).why, /no mob network/)
  fs.writeFileSync(file, 'weights')
  assert.match(checkParity(file).why, /has not been run/)
  const write = r => fs.writeFileSync(path.join(dir, 'parity.json'), JSON.stringify(r))
  write({ passed: false, expert_sha256: sha(file), code_sha256: sha(code) })
  assert.match(checkParity(file).why, /did not pass/)
  write({ passed: true, expert_sha256: 'other', code_sha256: sha(code) })
  assert.match(checkParity(file).why, /different network/)
  write({ passed: true, expert_sha256: sha(file), code_sha256: 'other' })
  assert.match(checkParity(file).why, /input code changed/)
  write({ passed: true, expert_sha256: sha(file), code_sha256: sha(code) })
  assert.equal(checkParity(file).ok, true)
  fs.rmSync(dir, { recursive: true })
})

test('with the network available it fights with an axe and says so', async () => {
  const bot = armed()
  bot.give('bread', 3)
  facing(bot)
  const z = mob(bot, 'zombie')
  const logs = []
  bot.attack = e => { assert.equal(bot.heldItem.name, 'iron_axe'); e.metadata[9] -= 10; if (e.metadata[9] <= 0) delete bot.entities[e.id] }
  const net = fakeNet()
  const r = await new MobFighter(bot, { log: m => logs.push(m) }).start(z, { net })
  assert.equal(r, 'dead')
  assert.ok(net.asked > 0)
  assert.ok(logs.some(l => /trained network/.test(l)), logs.join(' | '))
})

test('it falls back to the scripted fighter and logs why', async () => {
  const cases = [
    ['the network is unavailable', () => armed(), 'zombie', { ready: async () => ({ ok: false, why: 'the policy process is unavailable: gone' }) }, /policy process is unavailable/],
    ['a mob it never fought', () => armed(), 'spider', fakeNet(), /never fought a spider/],
    ['no axe', () => armed('diamond_sword'), 'zombie', fakeNet(), /no axe/]
  ]
  for (const [label, make, name, net, why] of cases) {
    const bot = make()
    const e = mob(bot, name)
    const logs = []
    bot.attack = t => { t.metadata[9] -= 20; delete bot.entities[t.id] }
    const r = await new MobFighter(bot, { log: m => logs.push(m) }).start(e, { net })
    assert.equal(r, 'dead', label)
    assert.ok(logs.some(l => why.test(l)), `${label}: ${logs.join(' | ')}`)
  }
})

test('a network that stops answering hands the same fight to the scripted fighter', async () => {
  const bot = armed()
  facing(bot)
  const z = mob(bot, 'zombie')
  const logs = []
  bot.attack = e => { e.metadata[9] -= 20; delete bot.entities[e.id] }
  const net = fakeNet(() => null)
  const r = await new MobFighter(bot, { log: m => logs.push(m) }).start(z, { net })
  assert.equal(r, 'dead')
  assert.equal(net.asked, 5)
  assert.ok(logs.some(l => /stopped answering/.test(l)), logs.join(' | '))
})

test('a policy process that fails counts as no answer instead of ending the fight', async () => {
  const net = new MobNet(() => {}, { file: 'x', gate: () => ({ ok: true }), policy: { start: async () => {}, act: async () => { throw new Error('gone') }, close () {} } })
  assert.equal(await net.act('Agent1', [], []), null)
})

test('stop ends a network fight at once: keys clear, no more swings or decisions', async () => {
  const bot = armed()
  bot.inventory.slots[45] = new Item(registry.itemsByName.shield.id, 1)
  facing(bot)
  const z = mob(bot, 'zombie')
  let swings = 0
  bot.attack = () => { swings++ }
  const walk = IDLE.map((v, i) => (i === 0 ? 1 : i === 6 ? 1 : v))
  const net = fakeNet(() => walk)
  const f = new MobFighter(bot)
  const done = f.start(z, { net })
  await pause(40)
  assert.ok(net.asked > 0)
  assert.equal(bot.getControlState('forward'), true)
  f.stop()
  assert.equal(bot.getControlState('forward'), false, 'keys clear in the same call')
  const [asked, swung] = [net.asked, swings]
  assert.equal(await done, 'stopped')
  await pause(20)
  assert.equal(net.asked, asked)
  assert.equal(swings, swung)
  assert.equal(bot.getControlState('forward'), false)
})

test('the movement guard drops a key that walks into lava or off a drop', async () => {
  const { bot, world } = makeBot({ groundY: 63 })
  const at = bot.entity.position
  assert.equal(unsafeStep(bot, 0, 1), false)
  world.set(new Vec3(Math.floor(at.x), 64, Math.floor(at.z) + 1), 'lava')
  assert.equal(unsafeStep(bot, 0, 1), true)
  for (let y = 63; y >= 58; y--) world.set(new Vec3(Math.floor(at.x) + 1, y, Math.floor(at.z)), 'air')
  assert.equal(unsafeStep(bot, 1, 0), true)
})

test('the driver reads a real entity the way the tracker expects', () => {
  const bot = armed()
  const c = mob(bot, 'creeper', 3)
  c.metadata[16] = 1
  c.yaw = Math.PI / 2
  const en = mob(bot, 'enderman', 4, 33)
  en.metadata[17] = true
  const sk = mob(bot, 'bogged', 5, 12)
  sk.metadata[8] = 1
  mob(bot, 'spider', 2)
  const dead = mob(bot, 'zombie', 2, 0)
  const f = new MobFighter(bot)
  const d = new MobNetDriver(bot, f)
  const frame = d.frame()
  const by = id => frame.mobs.find(m => m.id === id)
  assert.equal(frame.mobs.length, 3, 'no spider, no dead zombie')
  assert.equal(by(dead.id), undefined)
  assert.deepEqual([by(c.id).kind, by(c.id).swellDir], [2, 1])
  assert.ok(Math.abs(by(c.id).yaw - 90) < 1e-9, 'Mineflayer yaw turned into simulator yaw')
  assert.deepEqual([by(en.id).kind, by(en.id).angry, by(en.id).hp], [3, true, 33])
  assert.deepEqual([by(sk.id).kind, by(sk.id).drawing, by(sk.id).maxHp], [1, true, 16])
})

test('the policy client keeps its command line unless told otherwise', () => {
  const started = []
  const spawnProcess = (_py, args) => { started.push(args.slice(1)); throw new Error('no process in this test') }
  new PolicyClient('run', () => {}, { spawnProcess }).start().catch(() => {})
  new PolicyClient('x', () => {}, { spawnProcess, args: ['--mob', 'file'] }).start().catch(() => {})
  assert.deepEqual(started, [['--run', 'run'], ['--mob', 'file']])
})
