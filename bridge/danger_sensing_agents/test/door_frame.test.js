// Standing in a door frame is not suffocating, and an agent caught in the frame is moved on through it.
const test = require('node:test')
const assert = require('node:assert/strict')
const { smothers } = require('../threats')
const { leaveDoorway } = require('../demo/door')

test('a door, gate or fence at head height does not smother', () => {
  for (const name of ['iron_door', 'oak_door', 'iron_trapdoor', 'oak_fence', 'oak_fence_gate', 'cobblestone_wall', 'glass_pane', 'iron_bars']) {
    assert.equal(smothers({ name, boundingBox: 'block' }), false, name)
  }
})

test('solid blocks at head height still smother', () => {
  for (const name of ['stone', 'dirt', 'gravel', 'sand', 'oak_planks', 'cobblestone']) {
    assert.equal(smothers({ name, boundingBox: 'block' }), true, name)
  }
  assert.equal(smothers({ name: 'air', boundingBox: 'empty' }), false)
  assert.equal(smothers(null), false)
})

const door = { lower: { x: 5, y: 64, z: 9 } }
const rig = (x, y, z) => {
  const sent = []
  return { sent, ctx: { bot: { username: 'Agent1', entity: { position: { x, y, z } } }, agents: { log: () => {}, rcon: { send: async c => { sent.push(c); return '' } } } } }
}

test('an agent caught in the frame is put on the far side', async () => {
  const { ctx, sent } = rig(5.4, 64, 9.5)
  assert.equal(await leaveDoorway(ctx, door, { x: 5, y: 64, z: 10 }), true)
  assert.deepEqual(sent, ['tp Agent1 5.5 64 10.5'])
})

test('an agent clear of the frame is left alone', async () => {
  const { ctx, sent } = rig(5.5, 64, 11.5)
  assert.equal(await leaveDoorway(ctx, door, { x: 5, y: 64, z: 10 }), false)
  assert.deepEqual(sent, [])
})
