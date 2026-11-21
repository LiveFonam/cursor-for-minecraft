'use strict'

const fs = require('node:fs')
const path = require('node:path')

const FORMAT = 'crew-blueprint-1'
const KEEP = '.'
const CLEAR = '_'
const BLUEPRINT_DIR = path.join(__dirname, '..', '..', 'blueprints')
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

function isTallDoor (name) {
  return name.endsWith('_door')
}

function validateBlueprint (data, registry) {
  const fail = message => { throw new Error(`Bad blueprint: ${message}`) }
  if (!data || typeof data !== 'object') fail('not an object')
  if (data.format !== FORMAT) fail(`format must be ${FORMAT}`)
  if (typeof data.name !== 'string' || !SAFE_NAME.test(data.name)) fail('name must be lowercase letters, digits, _ or -')
  if (!data.palette || typeof data.palette !== 'object') fail('palette is missing')
  if (!Array.isArray(data.layers) || data.layers.length === 0) fail('layers must be a non-empty list')

  for (const [symbol, block] of Object.entries(data.palette)) {
    if ([...symbol].length !== 1) fail(`palette key must be one character: ${symbol}`)
    if (symbol === KEEP || symbol === CLEAR) fail(`palette key ${symbol} is reserved`)
    if (typeof block !== 'string') fail(`palette value must be a block name: ${symbol}`)
    if (registry && !registry.blocksByName[block]) fail(`unknown block: ${block}`)
    if (registry && !registry.itemsByName[block]) fail(`block has no item: ${block}`)
  }

  const depth = data.layers[0]?.length
  const width = data.layers[0]?.[0]?.length
  if (!depth || !width) fail('layers must not be empty')
  data.layers.forEach((layer, y) => {
    if (!Array.isArray(layer) || layer.length !== depth) fail(`layer ${y} must have ${depth} rows`)
    layer.forEach((row, z) => {
      if (typeof row !== 'string' || row.length !== width) fail(`layer ${y} row ${z} must have ${width} cells`)
      for (const symbol of row) {
        if (symbol !== KEEP && symbol !== CLEAR && !(symbol in data.palette)) fail(`unknown symbol ${symbol} in layer ${y}`)
      }
    })
  })
  return data
}

// Lists the cells bottom layer first. A door's upper half is marked auto,
// because the game places it along with the lower half.
function expandBlueprint (data) {
  const cells = []
  data.layers.forEach((layer, y) => {
    layer.forEach((row, z) => {
      [...row].forEach((symbol, x) => {
        if (symbol === KEEP) return
        const block = symbol === CLEAR ? 'air' : data.palette[symbol]
        const below = y > 0 ? data.layers[y - 1][z][x] : null
        const auto = isTallDoor(block) && below === symbol
        cells.push({ x, y, z, block, auto })
      })
    })
  })
  return cells
}

function countMaterials (cells) {
  const totals = {}
  for (const cell of cells) {
    if (cell.block === 'air' || cell.auto) continue
    totals[cell.block] = (totals[cell.block] ?? 0) + 1
  }
  return totals
}

function loadBlueprint (name, registry, directory = BLUEPRINT_DIR) {
  if (!SAFE_NAME.test(name)) throw new Error(`Bad blueprint name: ${name}`)
  const file = path.join(directory, `${name}.json`)
  if (!fs.existsSync(file)) throw new Error(`No blueprint named ${name}`)
  return validateBlueprint(JSON.parse(fs.readFileSync(file, 'utf8')), registry)
}

function listBlueprints (directory = BLUEPRINT_DIR) {
  return fs.readdirSync(directory)
    .filter(file => file.endsWith('.json'))
    .map(file => file.slice(0, -5))
    .sort()
}

module.exports = { FORMAT, validateBlueprint, expandBlueprint, countMaterials, loadBlueprint, listBlueprints, isTallDoor }
