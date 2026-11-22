// The gatherer's four kinds of raw material, the words for them, and reading a gather request. Pure, so the chat
// parser (commands.js) and its tests use it without Minecraft. The work itself is in skills/gatherer.js.
//
//   wood         any natural log, chopped from trees it can see                       (skills/gather.js)
//   cobblestone  stone it can see, else a short staircase down, needs any pickaxe     (skills/gather.js)
//   iron         iron ore, cave first then branch mining at Y 16, needs stone or better (skills/mine_branch.js)
//   diamond      diamond ore, branch mining at Y -58, needs iron or better            (skills/mine_branch.js)
// coal is a fifth kind the chat command does not offer: the crafter asks for it as furnace fuel.

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
const LOGS = WOODS.map(w => `${w}_log`)

// unit: how chat counts it. items: what in the bag counts toward it. ores: the blocks the miner looks for
const KINDS = {
  wood: { label: 'wood', unit: 'logs', default: 16, max: 256, items: LOGS },
  cobblestone: { label: 'cobblestone', unit: 'cobblestone', default: 32, max: 576, items: ['cobblestone', 'cobbled_deepslate'], pickaxe: true },
  iron: { label: 'iron', unit: 'raw iron', default: 8, max: 128, items: ['raw_iron'], ores: ['iron_ore', 'deepslate_iron_ore'] },
  diamond: { label: 'diamonds', unit: 'diamonds', default: 3, max: 64, items: ['diamond'], ores: ['diamond_ore', 'deepslate_diamond_ore'] },
  coal: { label: 'coal', unit: 'coal', default: 8, max: 128, items: ['coal'], ores: ['coal_ore', 'deepslate_coal_ore'] }
}
const COMMAND_KINDS = ['wood', 'cobblestone', 'iron', 'diamond']

const WORDS = {
  wood: ['wood', 'woods', 'log', 'logs', 'tree', 'trees', 'timber', 'oak', 'oak log', 'oak logs'],
  cobblestone: ['cobblestone', 'cobblestones', 'cobble', 'cobbles', 'stone', 'stones', 'rock', 'rocks'],
  iron: ['iron', 'irons', 'iron ore', 'iron ores', 'raw iron'],
  diamond: ['diamond', 'diamonds', 'diamond ore', 'diamond ores', 'dias']
}

// A few words to one of the four kinds, or null. "oak_log", "Raw-Iron" and "minecraft:diamond" work too
function resolveKind (words) {
  const w = String(words || '').toLowerCase().replace(/^minecraft:/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(some|a few|a bunch of|more|me|us)\s+/, '').replace(/^(some|more)\s+/, '')
  if (!w) return null
  for (const k of COMMAND_KINDS) if (WORDS[k].includes(w)) return k
  if (/^[a-z_ ]+ logs?$/.test(w) && LOGS.includes(w.replace(/s$/, '').replace(/ /g, '_'))) return 'wood'
  return null
}

// The words after "gather": a kind with a count before or after it. { kind, count } or { error }
function parseGatherArgs (words) {
  const rest = words.filter(Boolean)
  let count = null
  const nums = rest.filter(x => /^\d+$/.test(x))
  if (nums.length > 1) return { error: 'gather takes one count' }
  if (nums.length) count = Number(nums[0])
  const kind = resolveKind(rest.filter(x => !/^\d+$/.test(x)).join(' '))
  if (!kind) return { error: `gather takes one of: ${COMMAND_KINDS.map(k => KINDS[k].label).join(', ')}, for example !gather iron 10` }
  const k = KINDS[kind]
  if (count === null) count = k.default
  if (count < 1) return { error: 'gather needs a count of at least 1' }
  if (count > k.max) return { error: `at most ${k.max} ${k.unit} in one go` }
  return { kind, count }
}

// "gather wood", "collect 10 iron", "please gather some diamonds" in plain words. { kind, count }, { error } or null
// (not a gather request, the line goes on to the translator)
function parseGatherRequest (text) {
  const t = String(text || '').toLowerCase().replace(/[!?.,]+/g, ' ').replace(/\s+/g, ' ').trim()
  const m = t.match(/^(?:hey |ok |okay )?(?:(?:can|could|would|will) you |please |pls )*(?:go )?(gather|collect) (?:me |us )?(.*?)(?: (?:for me|please|pls|thanks|thank you))*$/)
  if (!m) return null
  return parseGatherArgs(m[2].split(' '))
}

// The kind an item name belongs to (the crafter's missing materials), or null
function kindOfItem (name) {
  if (/_log$/.test(name)) return 'wood'
  if (['cobblestone', 'cobbled_deepslate', 'blackstone'].includes(name)) return 'cobblestone'
  if (['raw_iron', 'iron_ingot', 'iron_ore', 'deepslate_iron_ore'].includes(name)) return 'iron'
  if (['diamond', 'diamond_ore', 'deepslate_diamond_ore'].includes(name)) return 'diamond'
  if (['coal', 'charcoal', 'coal_ore', 'deepslate_coal_ore'].includes(name)) return 'coal'
  return null
}

// The crafter's order [{ name, count }] as gather tasks, one per kind in the order they come. unknown: what no kind
// covers (the crafter asks the player for those)
function tasksFromItems (items) {
  const tasks = []
  const unknown = []
  for (const { name, count } of items || []) {
    const kind = kindOfItem(name)
    if (!kind) { unknown.push(name); continue }
    const t = tasks.find(x => x.kind === kind)
    if (t) t.count += count
    else tasks.push({ kind, count })
  }
  return { tasks, unknown }
}

// Pickaxes by what they can mine: a golden one only mines what a wooden one does (Minecraft Wiki, Pickaxe)
const PICK_LEVEL = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }
// The pickaxe level each kind needs: cobblestone and coal any pickaxe, iron stone or better, diamonds iron or better
const NEED_LEVEL = { wood: -1, cobblestone: 0, coal: 0, iron: 1, diamond: 2 }
const NEED_TEXT = { cobblestone: 'a pickaxe', coal: 'a pickaxe', iron: 'a stone pickaxe or better', diamond: 'an iron pickaxe or better' }

// The best pickaxe among item names, by mining level: { name: 'stone', level: 1 }, or { name: null, level: -1 }
function bestPickaxeOf (names) {
  let best = null
  for (const n of names) {
    const m = String(n).match(/^([a-z]+)_pickaxe$/)
    if (m && m[1] in PICK_LEVEL && (best === null || PICK_LEVEL[m[1]] > PICK_LEVEL[best])) best = m[1]
  }
  return { name: best, level: best === null ? -1 : PICK_LEVEL[best] }
}

// The strongest pickaxe in the bag as an item, so a wooden one left over never goes back in the hand
function bestPickaxeItem (items) {
  const { name } = bestPickaxeOf(items.map(i => i.name))
  return name ? items.find(i => i.name === `${name}_pickaxe`) : null
}

// The strongest axe in the bag as an item, or null. Gold cuts like wood but wears out far sooner, so it comes last
const AXE_ORDER = ['netherite', 'diamond', 'iron', 'stone', 'wooden', 'golden']
function bestAxeItem (items) {
  for (const tier of AXE_ORDER) {
    const axe = items.find(i => i.name === `${tier}_axe`)
    if (axe) return axe
  }
  return null
}

// How much of a kind the bag holds. items is bot.inventory.items()
function carriedOf (items, kind) {
  const names = KINDS[kind].items
  return items.filter(i => names.includes(i.name)).reduce((n, i) => n + i.count, 0)
}

module.exports = { PICK_LEVEL, NEED_LEVEL, NEED_TEXT, bestPickaxeOf, bestPickaxeItem, bestAxeItem, KINDS, COMMAND_KINDS, LOGS, resolveKind, parseGatherArgs, parseGatherRequest, kindOfItem, tasksFromItems, carriedOf }
