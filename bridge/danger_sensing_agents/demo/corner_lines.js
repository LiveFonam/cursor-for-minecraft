// Turns what the agent carries and the demo log into the short text for the corner of the screen.
const READY = {
  bread: 5, cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_chicken: 6, cooked_rabbit: 5, cooked_cod: 5,
  cooked_salmon: 6, baked_potato: 5, apple: 4, golden_apple: 4, enchanted_golden_apple: 4, golden_carrot: 6, carrot: 3,
  pumpkin_pie: 8, cookie: 2, melon_slice: 2, sweet_berries: 2, glow_berries: 2, dried_kelp: 1, beetroot: 1,
  mushroom_stew: 6, beetroot_soup: 6, rabbit_stew: 10
}
// raw points, points once cooked
const RAW = {
  beef: [3, 8], porkchop: [3, 8], mutton: [2, 6], chicken: [2, 6], rabbit: [3, 5], cod: [2, 5], salmon: [2, 6], potato: [1, 5]
}
const TIERS = { wooden: 59, stone: 131, iron: 250, golden: 32, diamond: 1561, netherite: 2031 }
const OTHER_TOOLS = { shield: 336, bow: 384, crossbow: 465, shears: 238, flint_and_steel: 64, fishing_rod: 64 }
const BUILD = new Set(['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'deepslate', 'andesite', 'diorite', 'granite',
  'tuff', 'netherrack', 'sandstone', 'gravel', 'sand'])
const ITEM_WIDTH = 30

function maxDurability (id) {
  if (OTHER_TOOLS[id]) return OTHER_TOOLS[id]
  const m = /^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|axe|shovel|hoe|sword)$/.exec(id)
  return m ? TIERS[m[1]] : 0
}

const isBuild = id => BUILD.has(id) || id.endsWith('_planks')
const nice = id => id.replace(/_/g, ' ')

function hudLines (items) {
  let ready = 0
  let raw = 0
  let cooked = 0
  let blocks = 0
  const tools = []
  const rest = new Map()
  for (const { id, count, damage } of items) {
    const max = maxDurability(id)
    if (max) {
      tools.push(`${nice(id)} ${Math.max(0, max - (damage || 0))}/${max}`)
      continue
    }
    if (isBuild(id)) {
      blocks += count
      continue
    }
    if (READY[id]) ready += READY[id] * count
    if (RAW[id]) {
      raw += RAW[id][0] * count
      cooked += RAW[id][1] * count
    }
    rest.set(id, (rest.get(id) || 0) + count)
  }
  const lines = [`Ready food ${ready} pts`, `Raw food   ${raw} pts (${cooked} cooked)`, `Blocks     ${blocks}`]
  if (tools.length) lines.push('Tools', ...tools.map(t => ` ${t}`))
  if (rest.size) {
    lines.push('Items')
    let row = ''
    for (const [id, count] of [...rest].sort((a, b) => a[0].localeCompare(b[0]))) {
      const part = `${nice(id)} ${count}`
      if (row && row.length + part.length + 2 > ITEM_WIDTH) {
        lines.push(` ${row}`)
        row = part
      } else {
        row = row ? `${row}, ${part}` : part
      }
    }
    if (row) lines.push(` ${row}`)
  }
  return lines
}

const clock = text => { const [h, m, s] = text.split(':').map(Number); return h * 3600 + m * 60 + s }
const mmss = secs => { const d = ((secs % 86400) + 86400) % 86400; return `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}` }

// How long the agent has been out on its current job, or how long its last job took, read from the job log
function jobLine (logText, nowSeconds, bot = 'Agent1') {
  let start = null
  let item = null
  let end = null
  for (const line of logText.split('\n')) {
    const goal = new RegExp(`^\\[agents (\\d\\d:\\d\\d:\\d\\d)\\] ${bot} goal \\d+ ([a-z_]+):`).exec(line)
    if (goal) {
      start = clock(goal[1])
      item = goal[2]
      end = null
      continue
    }
    const idle = new RegExp(`^\\[agents (\\d\\d:\\d\\d:\\d\\d)\\] ${bot}: \\w+ to idle`).exec(line)
    if (idle && start !== null && end === null) end = clock(idle[1])
  }
  if (start === null) return []
  const name = nice(item)
  return end === null ? [`Gone for   ${mmss(nowSeconds - start)} (${name})`] : [`Last job   ${mmss(end - start)} (${name})`]
}

// Claude Haiku 5.5 standard prices per million tokens, for prompts up to 100,000 tokens
const PRICE = { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 }
const short = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

// What the model has used since the agents started, from the last running total in the job log
function apiLines (logText) {
  const totals = [...logText.matchAll(/tokens: in \d+, out \d+(?:, cache read \d+, cache write \d+)? \| total (\d+) calls, in (\d+), out (\d+)(?:, cache read (\d+), cache write (\d+))?/g)]
  if (!totals.length) return []
  const [calls, input, output, read, write] = totals[totals.length - 1].slice(1).map(v => Number(v || 0))
  const cost = (input * PRICE.input + output * PRICE.output + read * PRICE.cacheRead + write * PRICE.cacheWrite) / 1e6
  return [`Haiku      ${calls} ${calls === 1 ? 'call' : 'calls'}, ${short(input + read + write)} in, ${short(output)} out`,
    `API cost   $${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)} this run`]
}

module.exports = { hudLines, maxDurability, jobLine, apiLines }
