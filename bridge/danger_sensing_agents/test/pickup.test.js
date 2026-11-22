// The plain walk to items on the ground: the game's real pickup range, past a drop it cannot reach, within one time limit.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { makeBot } = require('./mockbot')
const { inPickupBox } = require('../skills/motion')
const { GoalPickup, pickUpDrops } = require('../skills/pickup')
const { collectDrops } = require('../skills/gather')
const { collectAround } = require('../skills/mine')

let nextId = 7000
function drop (bot, x, y, z) {
  const e = { id: nextId++, name: 'item', type: 'other', position: new Vec3(x, y, z) }
  bot.entities[e.id] = e
  return e
}

// Stands the bot on the goal's cell and lets the game hand over what is in its real pickup box
function handOver (bot) {
  for (const e of Object.values(bot.entities)) {
    if (e.name === 'item' && inPickupBox(bot.entity.position, e.position)) delete bot.entities[e.id]
  }
}

function walker (bot, blocked = () => false) {
  bot.pathfinder.goto = async goal => {
    const p = bot.entity.position.floored()
    for (let r = 0; r <= 6; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const c = new Vec3(p.x + dx, p.y, p.z + dz)
          if (!goal.isEnd(c) || blocked(goal, c)) continue
          bot.entity.position = c.offset(0.5, 0, 0.5)
          handOver(bot)
          return
        }
      }
    }
    throw new Error('No path to the goal!')
  }
}

for (const [name, collect] of [['gather', collectDrops], ['mine', (b, p, t) => collectAround(b, p, t)]]) {
  test(`${name}: a drop in a wall pocket is taken from the nearest cell in the game's pickup range`, async () => {
    const { bot } = makeBot()
    const y = bot.entity.position.y
    const pocket = new Vec3(3.5, y, 0.5)
    const d = drop(bot, pocket.x, pocket.y, pocket.z)
    // the cell of the drop itself cannot be stood in
    walker(bot, (g, c) => c.x === 3 && c.z === 0)
    await collect(bot, pocket, { cancelled: false })
    assert.equal(bot.entities[d.id], undefined, 'picked up')
    assert.ok(inPickupBox(bot.entity.position, pocket))
  })

  test(`${name}: a drop it cannot reach does not stop it collecting the others`, async () => {
    const { bot } = makeBot()
    const y = bot.entity.position.y
    const stuck = drop(bot, 2.5, y, 0.5)
    const other = drop(bot, -2.9, y, 0.5)
    walker(bot, g => g.drop.x === 2.5)
    await collect(bot, new Vec3(0.5, y, 0.5), { cancelled: false })
    assert.ok(bot.entities[stuck.id], 'the one out of reach stays')
    assert.equal(bot.entities[other.id], undefined, 'the other was collected')
  })
}

test('the whole collect ends at its time limit, even with walks that never arrive', async () => {
  const { bot } = makeBot()
  const y = bot.entity.position.y
  for (let i = 0; i < 6; i++) drop(bot, 2.5, y, -2 + i * 0.8)
  bot.pathfinder.goto = () => new Promise(() => {})
  bot.pathfinder.setGoal = () => {}
  const began = Date.now()
  await pickUpDrops(bot, new Vec3(0.5, y, 0.5), { cancelled: false }, { settleMs: 0, limitMs: 200, walkMs: 80 })
  assert.ok(Date.now() - began < 1500, `took ${Date.now() - began} ms`)
})

test('the pickup goal accepts a cell in the game\'s range and refuses one just past it', () => {
  const g = new GoalPickup(new Vec3(3.5, 65, 0.5))
  assert.equal(g.isEnd({ x: 2, y: 65, z: 0 }), true)
  assert.equal(g.isEnd({ x: 1, y: 65, z: 0 }), false)
})
