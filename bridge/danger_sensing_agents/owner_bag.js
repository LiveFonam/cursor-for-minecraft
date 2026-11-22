// Reading what a player carries. A Mineflayer bot cannot see another player's bag, so this asks the server console
// (RCON) with "data get entity", which only reads. Nothing in this file ever sends a command that changes a player:
// the bot asks in chat and the owner drops the items themselves.

const { withTimeout } = require('./skills/abort')

const SLOTS = 36
const READ_MS = 4000
const NAME = /^\w{1,16}$/

// The entries at the top level of an SNBT list or compound, each as its text. complete is false when the reply was cut
// off before the end (the console splits long replies and this client keeps the first part)
function topLevelEntries (text) {
  const start = text.search(/[[{]/)
  if (start < 0) return { entries: [], complete: false }
  const isList = text[start] === '['
  const entries = []
  let depth = 0
  let from = -1
  let quote = null
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '[' || ch === '{') {
      if (ch === '{' && depth === (isList ? 1 : 0)) from = i
      depth++
    } else if (ch === ']' || ch === '}') {
      depth--
      if (ch === '}' && depth === (isList ? 1 : 0) && from >= 0) {
        entries.push(text.slice(from, i + 1))
        from = -1
      }
      if (depth === 0) return { entries, complete: true }
    }
  }
  return { entries, complete: false }
}

// One item entry's own id, count and slot, not those of items nested inside it (a shulker box holds its own list)
function readEntry (entry) {
  let flat = ''
  let depth = 0
  let quote = null
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i]
    if (quote) {
      if (depth === 1) flat += ch
      if (ch === '\\') { i++; if (depth === 1) flat += entry[i] } else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; if (depth === 1) flat += ch; continue }
    if (ch === '{' || ch === '[') { depth++; continue }
    if (ch === '}' || ch === ']') { depth--; continue }
    if (depth === 1) flat += ch
  }
  const id = flat.match(/(?:^|,)\s*"?id"?\s*:\s*["']?(?:minecraft:)?([a-z0-9_]+)/)
  if (!id) return null
  const count = flat.match(/(?:^|,)\s*"?[cC]ount"?\s*:\s*(\d+)/)
  const slot = flat.match(/(?:^|,)\s*"?Slot"?\s*:\s*(-?\d+)/)
  return { name: id[1], count: count ? parseInt(count[1], 10) : 1, slot: slot ? parseInt(slot[1], 10) : null }
}

// The server's reply to "data get entity <name> Inventory" as { items: [{ name, count, slot }], complete }, or null when
// the reply holds no entity data
function parseInventoryReply (reply) {
  const text = String(reply || '')
  const at = text.indexOf('entity data:')
  if (at < 0) return null
  const { entries, complete } = topLevelEntries(text.slice(at + 'entity data:'.length))
  return { items: entries.map(readEntry).filter(Boolean), complete }
}

const toBag = items => {
  const bag = new Map()
  for (const { name, count } of items) bag.set(name, (bag.get(name) || 0) + count)
  return bag
}

// What the player carries: { bag: Map } or { bag: null, why }. Only ever sends read commands
async function readOwnerBag (rcon, name) {
  if (!rcon) return { bag: null, why: 'no server console' }
  if (!NAME.test(String(name))) return { bag: null, why: 'not a player name' }
  const ask = command => withTimeout(rcon.send(command), READ_MS, { message: 'the console did not answer' })
  try {
    const reply = await ask(`data get entity ${name} Inventory`)
    if (/found no elements/i.test(String(reply))) return { bag: new Map() }
    const first = parseInventoryReply(reply)
    if (!first) return { bag: null, why: 'the server could not find you' }
    if (first.complete) return { bag: toBag(first.items) }
    // a long reply was cut: the slots it did not reach, one at a time
    const items = first.items.slice()
    const seen = new Set(items.map(i => i.slot))
    for (let slot = 0; slot < SLOTS; slot++) {
      if (seen.has(slot)) continue
      const one = parseInventoryReply(await ask(`data get entity ${name} Inventory[{Slot:${slot}b}]`))
      if (one) items.push(...one.items)
    }
    return { bag: toBag(items) }
  } catch (err) {
    return { bag: null, why: err.message }
  }
}

// Where a player stands, read the same way, or null
async function readPlayerPos (rcon, name) {
  if (!rcon || !NAME.test(String(name))) return null
  try {
    const reply = await withTimeout(rcon.send(`data get entity ${name} Pos`), READ_MS, { message: 'the console did not answer' })
    const m = String(reply).match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/)
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null
  } catch {
    return null
  }
}

module.exports = { parseInventoryReply, readOwnerBag, readPlayerPos }
