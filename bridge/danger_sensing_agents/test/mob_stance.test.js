// Two faults seen in a live game, no server needed: the bot flipping between fighting and running from a small group
// until it died, and the bot hitting mobs with the food in its hand.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot, registry } = require('./mockbot')
const { Friends } = require('../targets')
const { DangerAssessor } = require('../threats')
const { MobFighter } = require('../skills/mob_fight')

const Item = require('prismarine-item')(registry)
const STEP_MS = 200   // the agents looks 5 times a second

function arena ({ hp = 12, names, gear = false, radius = 7 }) {
  const { bot } = makeBot({ groundY: 63 })
  bot.give('bread', 8)
  if (gear) {
    bot.give('iron_axe', 1)
    bot.inventory.slots[45] = new Item(registry.itemsByName.shield.id, 1)
  }
  bot.health = hp
  const clock = { t: 1000000 }
  const a = new DangerAssessor(bot, { friends: new Friends('Owner', ['Agent1']), owner: 'Owner', now: () => clock.t })
  const mobs = names.map((name, i) => {
    const angle = i * 2.1
    const e = { id: i + 1, type: 'hostile', name, height: 1.95, position: new Vec3(0.5 + radius * Math.cos(angle), 64, 0.5 + radius * Math.sin(angle)) }
    bot.entities[e.id] = e
    return e
  })
  return { bot, a, mobs, clock }
}

// Plays the chase of the live log: the bot runs while told to flee and closes in while told to fight, the mobs walk
// after it. Returns the times the choice changed between fighting and running
function chase (s, seconds = 27, { hits = false } = {}) {
  const { bot, a, mobs, clock } = s
  const me = bot.entity.position
  const changes = []
  let last = null
  for (let step = 0; step < seconds * 1000 / STEP_MS && bot.health > 0; step++) {
    for (const e of mobs) e.yaw = Math.atan2(-(me.x - e.position.x), -(me.z - e.position.z))
    const r = a.update()
    const now = r.flee ? 'run' : r.fight ? 'fight' : 'idle'
    if (now !== 'idle' && now !== last) {
      if (last) changes.push(clock.t)
      last = now
    }
    const near = mobs.slice().sort((p, q) => p.position.distanceTo(me) - q.position.distanceTo(me))[0]
    const to = near.position.minus(me)
    to.y = 0
    const len = Math.max(to.norm(), 1e-6)
    if (r.flee) {
      me.x -= to.x / len * 1.12
      me.z -= to.z / len * 1.12
    } else if (r.fight && len > 2.5) {
      me.x += to.x / len * 0.86
      me.z += to.z / len * 0.86
    }
    for (const e of mobs) {
      const d = me.minus(e.position)
      d.y = 0
      const l = Math.max(d.norm(), 1e-6)
      if (l > 1.5) {
        e.position.x += d.x / l * 0.46
        e.position.z += d.z / l * 0.46
      } else if (hits && step % 5 === 0) bot.health = Math.max(1, bot.health - 0.5)
    }
    clock.t += STEP_MS
  }
  return changes
}

test('2 zombies at 12 health with only bread: it stands and fights, no flipping', () => {
  const s = arena({ names: ['zombie', 'zombie'] })
  assert.deepEqual(chase(s), [])
  assert.ok(s.a.report.fight, 'still fighting at the end')
})

test('a zombie and a skeleton at 13 health: no flipping', () => {
  assert.deepEqual(chase(arena({ hp: 13, names: ['zombie', 'skeleton'] })), [])
})

test('with an axe and a shield it stands against 4 of the trained mobs', () => {
  const s = arena({ names: ['zombie', 'skeleton', 'creeper', 'zombie'], gear: true })
  for (let i = 0; i < 40; i++) {
    const r = s.a.update()
    assert.equal(r.flee, null, `ran at look ${i}, total ${r.total}`)
    s.clock.t += STEP_MS
  }
})

test('3 mobs with no gear: when it does run, each choice holds for seconds', () => {
  // a run may end before its 6 s hold when every mob is more than 16 blocks behind, so the floor here is 4 s
  const changes = chase(arena({ hp: 9, names: ['zombie', 'zombie', 'skeleton'] }))
  for (let i = 1; i < changes.length; i++) {
    assert.ok(changes[i] - changes[i - 1] >= 4000, `changed after ${changes[i] - changes[i - 1]} ms`)
  }
  assert.ok(changes.length <= 5, `${changes.length} changes in 27 s`)
})

test('a stand does not hold through low health: at 6 it runs at once', () => {
  const s = arena({ names: ['zombie', 'zombie'] })
  assert.equal(s.a.update().flee, null)
  s.clock.t += STEP_MS
  s.bot.health = 6
  assert.ok(s.a.update().flee, 'runs inside the hold')
})

test('a run ends early once nothing is near, or it has healed', () => {
  const s = arena({ hp: 5, names: ['zombie', 'zombie'] })
  assert.ok(s.a.update().flee)
  s.clock.t += STEP_MS
  for (const e of s.mobs) e.position.x += 40
  assert.equal(s.a.update().flee, null, 'nothing near')

  const q = arena({ hp: 5, names: ['zombie', 'zombie'] })
  assert.ok(q.a.update().flee)
  q.clock.t += STEP_MS
  q.bot.health = 11
  assert.equal(q.a.update().flee, null, 'healed past 10')
})

test('a run holds while the score drops, a death forgets it', () => {
  const s = arena({ hp: 9, names: ['zombie', 'zombie', 'skeleton'], radius: 4 })
  assert.ok(s.a.update().flee)
  for (const e of s.mobs) { e.position.x *= 2; e.position.z *= 2 }
  s.clock.t += 1000
  assert.ok(s.a.update().flee, 'further off, still inside the hold')
  s.a.reset()
  s.bot.health = 20
  s.clock.t += STEP_MS
  assert.equal(s.a.update().flee, null)
})

// ---------- what it holds ----------

function mobIn (bot) {
  const p = bot.entity.position
  const e = { id: 500, type: 'hostile', name: 'skeleton', position: new Vec3(p.x, p.y, p.z + 2), height: 1.99, metadata: { 9: 20 } }
  bot.entities[e.id] = e
  return e
}

async function fightBriefly (bot, e) {
  const f = new MobFighter(bot)
  const done = f.start(e)
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve))
  f.stop()
  await done
}

test('no weapon in the bag: bread leaves the hand before the first swing', async () => {
  const { bot } = makeBot()
  bot.give('bread', 4)
  await bot.equip(bot.inventory.items()[0], 'hand')
  assert.equal(bot.heldItem.name, 'bread')
  const heldAtSwing = []
  bot.attack = () => heldAtSwing.push(bot.heldItem?.name ?? 'fist')
  await fightBriefly(bot, mobIn(bot))
  assert.ok(heldAtSwing.length > 0, 'it swung')
  assert.ok(heldAtSwing.every(n => n === 'fist'), heldAtSwing.join(' '))
  assert.equal(bot.inventory.count(registry.itemsByName.bread.id), 4, 'the bread is still in the bag')
})

test('a weapon in the bag replaces the bread', async () => {
  const { bot } = makeBot()
  bot.give('bread', 4)
  bot.give('iron_axe', 1)
  await bot.equip(bot.inventory.items()[0], 'hand')
  const heldAtSwing = []
  bot.attack = () => heldAtSwing.push(bot.heldItem?.name)
  await fightBriefly(bot, mobIn(bot))
  assert.ok(heldAtSwing.length > 0 && heldAtSwing.every(n => n === 'iron_axe'), heldAtSwing.join(' '))
})

test('a full bag: nothing is thrown away, it moves to a slot without food, and never swings food', async () => {
  const { bot } = makeBot()
  bot.give('bread', 4)
  await bot.equip(bot.inventory.items()[0], 'hand')
  const bread = bot.heldItem
  bot.inventory.emptySlotCount = () => 0
  bot.unequip = async () => assert.fail('unequip would throw the stack on the ground')
  bot.inventory.slots[36] = bread
  bot.inventory.slots[37] = new Item(registry.itemsByName.cobblestone.id, 1)
  bot.setQuickBarSlot = i => { bot.heldItem = bot.inventory.slots[36 + i] }
  const heldAtSwing = []
  bot.attack = () => heldAtSwing.push(bot.heldItem?.name)
  await fightBriefly(bot, mobIn(bot))
  assert.ok(heldAtSwing.length > 0 && heldAtSwing.every(n => n === 'cobblestone'), heldAtSwing.join(' '))

  // every hotbar slot holds food: it does not swing at all
  const q = makeBot().bot
  q.give('bread', 4)
  await q.equip(q.inventory.items()[0], 'hand')
  q.inventory.emptySlotCount = () => 0
  q.unequip = async () => assert.fail('unequip would throw the stack on the ground')
  for (let i = 0; i < 9; i++) q.inventory.slots[36 + i] = q.heldItem
  q.setQuickBarSlot = () => {}
  q.attack = () => assert.fail('swung food')
  await fightBriefly(q, mobIn(q))
})
