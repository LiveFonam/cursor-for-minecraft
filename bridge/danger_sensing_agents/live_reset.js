// One server for a whole session of live scenes: what puts the world and the bot back between two scenes, in place, so the
// owner's Minecraft stays connected with the camera on the bot. Everything is read back from the server, and a reset that
// does not check out throws, so that scene fails at setup instead of carrying state into the next one.

const MAX_BLOCKS = 32768       // the game's limit for one fill or compare
const HOLD_OFFSET = 3072       // the reference copy of a plot lies this far east
const HOLD_UP = 140            // and this far up, in open sky, so no water or terrain next to it can change it
const PLOT_HALF = 16           // blocks around the middle of a fight: every arena, mob ring and creeper blast
const PLOT_BELOW = 6
const PLOT_ABOVE = 11
const LOAD_TRIES = 20
const LOAD_WAIT_MS = 500
const LAY_TRIES = 3
const LAY_WAIT_MS = 500
const BOT_TRIES = 8
const BOT_WAIT_MS = 500
const POS_TOLERANCE = 1.5
const CLEAR_RADIUS = 72        // no animal left within this: a bot with no food would walk out of the arena to hunt it

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The box of one fight arena around its middle, its ground level, and where its reference copy is kept. A copy of natural
// ground cannot be compared exactly (leaves and vines change with their neighbours at the edge of the box), so a plot is
// always laid the same way: dirt, one layer of grass at the ground level, air above
function fightPlot ({ x, y, z }) {
  const box = { x1: x - PLOT_HALF, y1: y - PLOT_BELOW, z1: z - PLOT_HALF, x2: x + PLOT_HALF, y2: y + PLOT_ABOVE, z2: z + PLOT_HALF }
  return { box, middle: { x, y, z }, ground: y - 1, hold: { x: box.x1 + HOLD_OFFSET, y: box.y1 + HOLD_UP, z: box.z1 } }
}

const volume = b => (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) * (b.z2 - b.z1 + 1)
const holdBox = ({ box, hold }) => ({ x1: hold.x, y1: hold.y, z1: hold.z, x2: hold.x + box.x2 - box.x1, y2: hold.y + box.y2 - box.y1, z2: hold.z + box.z2 - box.z1 })
const corners = b => `${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2}`
const around = ({ x, y, z }) => `x=${x},y=${y},z=${z},distance=..${CLEAR_RADIUS}`
const passed = reply => /passed/i.test(String(reply))

// The chunks of a box stay loaded only while it is being worked on
async function withLoaded (rcon, boxes, fn) {
  for (const b of boxes) await rcon.send(`forceload add ${b.x1} ${b.z1} ${b.x2} ${b.z2}`)
  try {
    return await fn()
  } finally {
    for (const b of boxes) { try { await rcon.send(`forceload remove ${b.x1} ${b.z1} ${b.x2} ${b.z2}`) } catch {} }
  }
}

// A console command, retried while its chunks are still loading
async function whenLoaded (rcon, command, sleep) {
  let reply = ''
  for (let i = 0; i < LOAD_TRIES; i++) {
    reply = String(await rcon.send(command))
    if (!/not loaded/i.test(reply)) return reply
    await sleep(LOAD_WAIT_MS)
  }
  return reply
}

// Lays a box the one fixed way. "No blocks were filled" means that layer was already right
async function layBox (rcon, b, groundOffset, sleep) {
  const g = b.y1 + groundOffset
  for (const [from, to, block] of [[b.y1, g - 1, 'dirt'], [g, g, 'grass_block'], [g + 1, b.y2, 'air']]) {
    const reply = await whenLoaded(rcon, `fill ${b.x1} ${from} ${b.z1} ${b.x2} ${to} ${b.z2} minecraft:${block}`, sleep)
    if (!/filled/i.test(reply)) throw new Error(`the server did not lay the plot: ${reply.slice(0, 120)}`)
  }
}

const sameBlocks = async (rcon, a, b, sleep) => passed(await whenLoaded(rcon, `execute if blocks ${corners(a)} ${b.x1} ${b.y1} ${b.z1} all`, sleep))

// Lays the reference copy, once, before the first scene
async function savePlot (rcon, plot, { sleep = defaultSleep } = {}) {
  if (volume(plot.box) > MAX_BLOCKS) throw new Error(`the plot has ${volume(plot.box)} blocks, the game compares at most ${MAX_BLOCKS}`)
  const copy = holdBox(plot)
  await withLoaded(rcon, [copy], () => layBox(rcon, copy, plot.ground - plot.box.y1, sleep))
  return plot
}

// Everything but players out of the plot, its blocks laid again, and proof from the server that both happened
async function resetPlot (rcon, plot, { sleep = defaultSleep, tag = null } = {}) {
  const copy = holdBox(plot)
  const area = around(plot.middle)
  await withLoaded(rcon, [plot.box, copy], async () => {
    if (tag) await rcon.send(`kill @e[tag=${tag}]`)
    await rcon.send(`kill @e[type=!minecraft:player,${area}]`)
    // natural ground around a plot can still run or fall into it right after the first lay, so it may take a second one.
    // Only an exact match with the reference copy ends this
    let same = false
    for (let i = 0; i < LAY_TRIES && !same; i++) {
      if (i) await sleep(LAY_WAIT_MS)
      await layBox(rcon, plot.box, plot.ground - plot.box.y1, sleep)
      // what the old blocks dropped as they were replaced
      await rcon.send(`kill @e[type=!minecraft:player,${area}]`)
      same = await sameBlocks(rcon, copy, plot.box, sleep)
    }
    if (!same) throw new Error('the plot\'s blocks did not come back')
    if (passed(await rcon.send(`execute if entity @e[type=!minecraft:player,${area}]`))) throw new Error('mobs, drops or projectiles are still in the plot')
  })
}

const dataNumber = reply => {
  const m = String(reply).match(/entity data: (-?\d+(?:\.\d+)?)/)
  return m ? Number(m[1]) : null
}
const itemCount = reply => {
  if (!passed(reply)) return 0
  const m = String(reply).match(/count: (\d+)/i)
  return m ? Number(m[1]) : 1
}
const posOf = reply => {
  const m = String(reply).match(/\[(-?[\d.]+)d?, (-?[\d.]+)d?, (-?[\d.]+)d?\]/)
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null
}

// What is wrong with the bot right now, as a list of reasons
async function botProblems (rcon, name, { kit, at }) {
  const problems = []
  const number = async key => dataNumber(await rcon.send(`data get entity ${name} ${key}`))
  const health = await number('Health')
  if (health !== 20) problems.push(`health ${health}`)
  const food = await number('foodLevel')
  if (food !== 20) problems.push(`food ${food}`)
  const fire = await number('Fire')
  if (fire === null || fire > 0) problems.push(`fire ${fire}`)
  const level = await number('XpLevel')
  if (level !== 0) problems.push(`xp level ${level}`)
  const want = kit.reduce((n, [, c]) => n + c, 0)
  const total = itemCount(await rcon.send(`execute if items entity ${name} container.* *`))
  if (total !== want) problems.push(`${total} items in the bag, the kit is ${want}`)
  for (const [item, count] of kit) {
    const have = itemCount(await rcon.send(`execute if items entity ${name} container.* minecraft:${item}`))
    if (have !== count) problems.push(`${have} of ${count} ${item}`)
  }
  for (const slots of ['armor.*', 'weapon.offhand']) {
    const worn = itemCount(await rcon.send(`execute if items entity ${name} ${slots} *`))
    if (worn) problems.push(`${worn} items in ${slots}`)
  }
  // put back first: a bot that just joined may already have taken a step toward something it wants
  await rcon.send(`tp ${name} ${at.x + 0.5} ${at.y} ${at.z + 0.5}`)
  const p = posOf(await rcon.send(`data get entity ${name} Pos`))
  if (!p) problems.push('no position')
  else if (Math.hypot(p.x - (at.x + 0.5), p.y - at.y, p.z - (at.z + 0.5)) > POS_TOLERANCE) problems.push(`at ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`)
  return problems
}

// The bot exactly as the scene starts it, read from the server. Effects and the bag can take a moment to land
async function checkBot (rcon, name, want, { sleep = defaultSleep } = {}) {
  let problems = []
  for (let i = 0; i < BOT_TRIES; i++) {
    problems = await botProblems(rcon, name, want)
    if (!problems.length) return
    await sleep(BOT_WAIT_MS)
  }
  throw new Error(`${name} did not reset: ${problems.join(', ')}`)
}

// Everything a new life must not inherit, before the kit goes in
async function clearBot (rcon, name) {
  for (const c of [`clear ${name}`, `effect clear ${name}`, `xp set ${name} 0 levels`, `xp set ${name} 0 points`]) await rcon.send(c)
}

// The next scene's name in everybody's chat
const announce = (rcon, text) => rcon.send(`tellraw @a ${JSON.stringify({ text, color: 'gold', bold: true })}`)

module.exports = { fightPlot, holdBox, volume, savePlot, resetPlot, checkBot, clearBot, announce, botProblems, MAX_BLOCKS }
