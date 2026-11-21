'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const {
  validateBlueprint, expandBlueprint, countMaterials, loadBlueprint, listBlueprints, FORMAT
} = require('../src/skills/blueprint')
const { buildBlueprint, findReference, standSpots } = require('../src/skills/build')
const { createMockBot, registry } = require('./helpers/mock-bot')

const small = () => ({
  format: FORMAT,
  name: 'small',
  palette: { '#': 'oak_planks' },
  layers: [['##', '##'], ['#.', '_#']]
})

function give (materials) {
  return Object.fromEntries(Object.entries(materials).map(([name, count]) => [name, count + 2]))
}

test('ships the two blueprints and both validate', () => {
  assert.deepEqual(listBlueprints(), ['hut', 'pen'])
  for (const name of listBlueprints()) {
    const blueprint = loadBlueprint(name, registry)
    assert.equal(blueprint.name, name)
    assert.ok(expandBlueprint(blueprint).length > 0)
  }
})

test('rejects malformed blueprints', () => {
  const bad = [
    { ...small(), format: 'other' },
    { ...small(), name: 'Bad Name' },
    { ...small(), palette: { '#': 'not_a_block' } },
    { ...small(), palette: { '##': 'oak_planks' } },
    { ...small(), palette: { '.': 'oak_planks' } },
    { ...small(), layers: [] },
    { ...small(), layers: [['##', '#']] },
    { ...small(), layers: [['##', '##'], ['##']] },
    { ...small(), layers: [['#?', '##']] }
  ]
  for (const blueprint of bad) assert.throws(() => validateBlueprint(blueprint, registry), /Bad blueprint/)
})

test('blueprint names cannot leave the blueprint folder', () => {
  assert.throws(() => loadBlueprint('../package', registry), /Bad blueprint name/)
  assert.throws(() => loadBlueprint('missing', registry), /No blueprint/)
})

test('expands symbols, keeps and clears', () => {
  const cells = expandBlueprint(small())
  assert.equal(cells.length, 7)
  assert.ok(cells.some(c => c.x === 0 && c.y === 1 && c.z === 1 && c.block === 'air'))
  assert.ok(!cells.some(c => c.x === 1 && c.y === 1 && c.z === 0))
})

test('counts a door once and marks its top as automatic', () => {
  const hut = loadBlueprint('hut', registry)
  const cells = expandBlueprint(hut)
  assert.equal(cells.filter(c => c.block === 'oak_door').length, 2)
  assert.equal(cells.filter(c => c.block === 'oak_door' && c.auto).length, 1)
  assert.equal(countMaterials(cells).oak_door, 1)
})

for (const name of ['hut', 'pen']) {
  test(`builds the ${name} on flat ground`, async () => {
    const blueprint = loadBlueprint(name, registry)
    const materials = countMaterials(expandBlueprint(blueprint))
    const bot = createMockBot({ items: give(materials), position: new Vec3(-2, 64, -2) })
    const origin = new Vec3(0, 64, 0)
    const result = await buildBlueprint(bot, blueprint, origin, { movements: {} })
    assert.equal(result.failed, 0)
    for (const cell of expandBlueprint(blueprint)) {
      const actual = bot.blockAt(origin.offset(cell.x, cell.y, cell.z)).name
      assert.equal(actual, cell.block, `cell ${cell.x},${cell.y},${cell.z}`)
    }
  })
}

test('stops with a list when materials are missing', async () => {
  const blueprint = loadBlueprint('hut', registry)
  const bot = createMockBot({ items: { oak_planks: 3 } })
  await assert.rejects(buildBlueprint(bot, blueprint, new Vec3(0, 64, 0), { movements: {} }), /Missing/)
  assert.equal(bot.calls.placed.length, 0)
})

test('crafts missing materials when it can', async () => {
  const blueprint = { format: FORMAT, name: 'row', palette: { '#': 'oak_planks' }, layers: [['####']] }
  const bot = createMockBot({ items: { oak_log: 1 }, position: new Vec3(0, 64, 2) })
  const result = await buildBlueprint(bot, blueprint, new Vec3(0, 64, 0), { movements: {} })
  assert.equal(result.failed, 0)
})

test('resumes after an abort without redoing finished cells', async () => {
  const blueprint = loadBlueprint('pen', registry)
  const materials = countMaterials(expandBlueprint(blueprint))
  const bot = createMockBot({ items: give(materials), position: new Vec3(-2, 64, -2) })
  const origin = new Vec3(0, 64, 0)

  const controller = new AbortController()
  const place = bot.placeBlock
  let placed = 0
  bot.placeBlock = async (...args) => {
    await place(...args)
    if (++placed === 5) controller.abort()
  }
  await assert.rejects(buildBlueprint(bot, blueprint, origin, { movements: {}, signal: controller.signal }), { name: 'AbortedError' })
  assert.equal(bot.calls.placed.length, 5)

  bot.placeBlock = place
  const result = await buildBlueprint(bot, blueprint, origin, { movements: {} })
  assert.equal(result.failed, 0)
  const spots = bot.calls.placed.map(entry => entry.at)
  assert.equal(new Set(spots).size, spots.length)
})

test('clears blocks that are in the way', async () => {
  const blueprint = { format: FORMAT, name: 'clear', palette: { '#': 'oak_planks' }, layers: [['#_']] }
  const bot = createMockBot({ items: { oak_planks: 2 }, position: new Vec3(0, 64, 2) })
  bot.setBlock(new Vec3(0, 64, 0), 'dirt')
  bot.setBlock(new Vec3(1, 64, 0), 'cobblestone')
  const result = await buildBlueprint(bot, blueprint, new Vec3(0, 64, 0), { movements: {} })
  assert.equal(result.failed, 0)
  assert.equal(bot.blockAt(new Vec3(0, 64, 0)).name, 'oak_planks')
  assert.equal(bot.blockAt(new Vec3(1, 64, 0)).name, 'air')
})

test('places into water without trying to dig it', async () => {
  const blueprint = { format: FORMAT, name: 'wet', palette: { '#': 'oak_planks' }, layers: [['#']] }
  const bot = createMockBot({ items: { oak_planks: 1 }, position: new Vec3(0, 64, 2) })
  bot.setBlock(new Vec3(0, 64, 0), 'water')
  const place = bot.placeBlock
  bot.placeBlock = async (reference, face) => {
    bot.setBlock(reference.position.plus(face), 'air')
    await place(reference, face)
  }
  const result = await buildBlueprint(bot, blueprint, new Vec3(0, 64, 0), { movements: {} })
  assert.equal(result.failed, 0)
  assert.equal(bot.calls.dug.length, 0)
})

test('reports cells it could not place', async () => {
  const blueprint = { format: FORMAT, name: 'float', palette: { '#': 'oak_planks' }, layers: [['_'], ['_'], ['#']] }
  const bot = createMockBot({ items: { oak_planks: 1 }, position: new Vec3(0, 64, 2) })
  const result = await buildBlueprint(bot, blueprint, new Vec3(0, 64, 0), { movements: {} })
  assert.equal(result.failed, 1)
})

test('torches and doors only use the block below as support', () => {
  const bot = createMockBot()
  bot.setBlock(new Vec3(1, 66, 0), 'oak_planks')
  const cell = { block: 'torch', position: new Vec3(0, 66, 0) }
  assert.equal(findReference(bot, cell), null)
  assert.ok(findReference(bot, { block: 'oak_planks', position: new Vec3(0, 66, 0) }))
})

test('never clicks a block that opens a screen', () => {
  const bot = createMockBot()
  bot.setBlock(new Vec3(0, 65, 0), 'crafting_table')
  assert.equal(findReference(bot, { block: 'oak_planks', position: new Vec3(0, 66, 0) }), null)
})

test('stand spots avoid the target and reserved cells', () => {
  const bot = createMockBot()
  const target = new Vec3(0, 64, 0)
  const reserved = new Set(['1,64,0'])
  const spots = standSpots(bot, target, reserved)
  assert.ok(spots.length > 0)
  for (const spot of spots) {
    assert.notEqual(`${spot.x},${spot.y},${spot.z}`, '0,64,0')
    assert.notEqual(`${spot.x},${spot.y},${spot.z}`, '1,64,0')
  }
})
