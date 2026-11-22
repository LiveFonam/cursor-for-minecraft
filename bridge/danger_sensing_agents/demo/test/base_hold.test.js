// The raid's zombies carry wooden axes, and the agent is inside the base when a raid starts.
const test = require('node:test')
const assert = require('node:assert')
const scene = require('../scene')
const plans = require('../evil_plan')

const STAGE = { x: 100, y: 64, z: 200 }
const AXE = 'equipment:{mainhand:{id:"minecraft:wooden_axe",count:1},head:{id:"minecraft:iron_helmet",count:1}},drop_chances:{mainhand:0.0f,head:0.0f}'
const zombies = lines => lines.filter(l => l.startsWith('summon minecraft:zombie'))

test('the scripted raid has 3 zombies with wooden axes', () => {
  const z = zombies(scene.zombieCommands(STAGE))
  assert.strictEqual(z.length, 3)
  for (const l of z) assert.ok(l.includes(AXE), l)
})

test('a planned raid has 3 zombies with wooden axes', () => {
  const plan = { wall: 'north', approach: 'center', zombies: 'flank', line: 'x' }
  const z = zombies(plans.zombieCommands(STAGE, plan))
  assert.strictEqual(z.length, 3)
  for (const l of z) assert.ok(l.includes(AXE), l)
})

test('only zombies get the axe', () => {
  assert.ok(!scene.creeperCommands(STAGE).some(l => l.includes('wooden_axe')))
})

test('the agent goes to its spot inside the base', () => {
  const a = scene.spots(STAGE).agent
  const b = scene.baseLayout(STAGE)
  assert.ok(Math.abs(a.x - b.center.x) < b.half && Math.abs(a.z - b.center.z) < b.half)
  assert.strictEqual(scene.agentHomeCommand('Agent1', STAGE), `tp Agent1 ${a.x + 0.5} ${a.y} ${a.z + 0.5} 90 0`)
})

test('!pov and !spec are the camera commands, and the old names still work', () => {
  const { parseDemoCommand } = require('../words')
  assert.deepStrictEqual(parseDemoCommand('!pov'), { name: 'follow' })
  assert.deepStrictEqual(parseDemoCommand('!spec'), { name: 'unfollow' })
  assert.deepStrictEqual(parseDemoCommand('!follow'), { name: 'follow' })
  assert.deepStrictEqual(parseDemoCommand('!unfollow'), { name: 'unfollow' })
})

test('plain words can move the camera', () => {
  const { parseCameraWords: cam } = require('../words')
  for (const line of ['lemme see your pov', 'let me see ur pov', 'show me your view', 'can i get your pov', 'what do you see', 'go first person', 'POV']) {
    assert.deepStrictEqual(cam(line), { name: 'follow' }, line)
  }
  for (const line of ['back to spectator', 'go back to spec', 'stop following', 'let me fly around', 'back to my pov', 'exit your pov', 'free cam']) {
    assert.deepStrictEqual(cam(line), { name: 'unfollow' }, line)
  }
})

test('tasks and ordinary chat are not camera commands', () => {
  const { parseCameraWords: cam } = require('../words')
  for (const line of ['make me a diamond pickaxe', 'get me some wood', 'go back to base', 'come here', 'build a hut', 'get iron while i watch your pov', '!pov', '']) {
    assert.strictEqual(cam(line), null, line)
  }
})
