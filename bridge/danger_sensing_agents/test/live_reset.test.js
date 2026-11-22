// The in-place reset between two scenes of one server session, against a fake console. A reset that does not check out
// must throw, so that scene fails at setup and nothing carries over into it.
const test = require('node:test')
const assert = require('node:assert')
const { fightPlot, holdBox, volume, savePlot, resetPlot, checkBot, clearBot, announce, MAX_BLOCKS } = require('../live_reset')
const { runSession } = require('../livetest')

const noWait = async () => {}
const MIDDLE = { x: 32, y: 68, z: 30 }
const KIT = [['diamond_axe', 1], ['shield', 1]]
const AT = { x: 34, y: 68, z: 22 }

function fakeServer (over = {}) {
  const w = {
    sent: [],
    fillReplies: [],
    same: true,
    leftovers: false,
    bot: { Health: '20.0f', foodLevel: '20', Fire: '-20s', XpLevel: '0', total: 2, diamond_axe: 1, shield: 1, armor: 0, offhand: 0, pos: '[34.5d, 68.0d, 22.5d]' },
    ...over
  }
  const count = n => n ? `Test passed, count: ${n}` : 'Test failed'
  w.send = async c => {
    w.sent.push(c)
    if (c.startsWith('fill')) return w.fillReplies.length ? w.fillReplies.shift() : 'Successfully filled 1089 block(s)'
    if (c.startsWith('execute if blocks')) return (w.sameAnswers?.length ? w.sameAnswers.shift() : w.same) ? 'Test passed, count: 19602' : 'Test failed, count: 19000'
    if (c.startsWith('execute if entity')) return w.leftovers ? 'Test passed, count: 2' : 'Test failed'
    let m
    if ((m = c.match(/^data get entity Agent1 (\w+)$/))) return m[1] === 'Pos' ? `Agent1 has the following entity data: ${w.bot.pos}` : `Agent1 has the following entity data: ${w.bot[m[1]]}`
    if (/container\.\* \*$/.test(c)) return count(w.bot.total)
    if ((m = c.match(/container\.\* minecraft:(\w+)$/))) return count(w.bot[m[1]] || 0)
    if (/armor\.\* \*$/.test(c)) return count(w.bot.armor)
    if (/weapon\.offhand \*$/.test(c)) return count(w.bot.offhand)
    return 'ok'
  }
  return w
}

test('the plot covers every arena, fits one compare, and its reference copy is far off in open sky', () => {
  const plot = fightPlot(MIDDLE)
  assert.ok(volume(plot.box) <= MAX_BLOCKS, `${volume(plot.box)} blocks`)
  const copy = holdBox(plot)
  assert.ok(copy.x1 > plot.box.x2)
  assert.ok(copy.y1 > 190 && copy.y2 < 320, `${copy.y1} to ${copy.y2}`)
  assert.equal(volume(copy), volume(plot.box))
  // the widest arena is 9 out, plus a creeper's blast
  assert.ok(plot.box.x2 - MIDDLE.x >= 13 && MIDDLE.y - plot.box.y1 >= 4)
  assert.equal(plot.ground, MIDDLE.y - 1)
})

test('the plot is laid as dirt, one layer of grass at ground level, and air, the same way every time', async () => {
  const w = fakeServer()
  const plot = fightPlot(MIDDLE)
  await resetPlot(w, plot, { sleep: noWait })
  const fills = w.sent.filter(c => c.startsWith('fill'))
  const { x1, y1, z1, x2, y2, z2 } = plot.box
  assert.deepEqual(fills, [
    `fill ${x1} ${y1} ${z1} ${x2} ${plot.ground - 1} ${z2} minecraft:dirt`,
    `fill ${x1} ${plot.ground} ${z1} ${x2} ${plot.ground} ${z2} minecraft:grass_block`,
    `fill ${x1} ${plot.ground + 1} ${z1} ${x2} ${y2} ${z2} minecraft:air`
  ])
})

test('saving lays the reference copy at the same height inside its box, and lets its chunks unload', async () => {
  const w = fakeServer()
  const plot = fightPlot(MIDDLE)
  await savePlot(w, plot, { sleep: noWait })
  const copy = holdBox(plot)
  const groundAt = copy.y1 + plot.ground - plot.box.y1
  assert.ok(w.sent.includes(`fill ${copy.x1} ${groundAt} ${copy.z1} ${copy.x2} ${groundAt} ${copy.z2} minecraft:grass_block`))
  assert.equal(w.sent.filter(c => c.startsWith('forceload add')).length, w.sent.filter(c => c.startsWith('forceload remove')).length)
})

test('a layer that is already right is fine, a fill is retried while chunks load, and any other refusal fails the reset', async () => {
  const same = fakeServer({ fillReplies: ['No blocks were filled'] })
  await resetPlot(same, fightPlot(MIDDLE), { sleep: noWait })
  const w = fakeServer({ fillReplies: ['That position is not loaded', 'That position is not loaded'] })
  await resetPlot(w, fightPlot(MIDDLE), { sleep: noWait })
  assert.equal(w.sent.filter(c => c.startsWith('fill')).length, 5)
  const bad = fakeServer({ fillReplies: ['Too many blocks in the specified area'] })
  await assert.rejects(resetPlot(bad, fightPlot(MIDDLE), { sleep: noWait }), /did not lay/)
  assert.ok(bad.sent.some(c => c.startsWith('forceload remove')), 'the chunks are let go after a failure too')
})

test('the reset clears entities before and after the blocks are laid, and removes the scene\'s tagged mobs anywhere', async () => {
  const w = fakeServer()
  await resetPlot(w, fightPlot(MIDDLE), { sleep: noWait, tag: 'livefight' })
  const first = w.sent.findIndex(c => c.startsWith('fill'))
  const last = w.sent.map(c => c.startsWith('fill')).lastIndexOf(true)
  const kills = w.sent.map((c, i) => c.startsWith('kill @e[type=!minecraft:player') ? i : -1).filter(i => i >= 0)
  assert.ok(kills[0] < first && kills[1] > last)
  assert.ok(w.sent.includes('kill @e[tag=livefight]'))
  assert.ok(!w.sent.some(c => c.startsWith('kill') && !c.includes('type=!minecraft:player') && !c.includes('tag=')), 'players are never killed')
})

test('natural ground settling after the first lay gets a second lay, and the exact compare still decides', async () => {
  const w = fakeServer({ sameAnswers: [false, true] })
  await resetPlot(w, fightPlot(MIDDLE), { sleep: noWait })
  assert.equal(w.sent.filter(c => c.startsWith('fill')).length, 6)
  assert.equal(w.sent.filter(c => c.startsWith('execute if blocks')).length, 2)
})

test('animals well outside the arena are cleared too, or a bot with no food walks out of the fight to hunt them', async () => {
  const w = fakeServer()
  await resetPlot(w, fightPlot(MIDDLE), { sleep: noWait })
  const kill = w.sent.find(c => c.startsWith('kill @e[type=!minecraft:player'))
  const r = Number(kill.match(/distance=\.\.(\d+)/)[1])
  assert.ok(r >= 16 * Math.sqrt(3) + 24, `radius ${r}`)
  assert.ok(kill.includes(`x=${MIDDLE.x},y=${MIDDLE.y},z=${MIDDLE.z}`))
  assert.ok(w.sent.some(c => c.startsWith('execute if entity') && c.includes(`distance=..${r}`)), 'the same area is checked')
})

test('blocks that did not come back, or anything left in the plot, fail the reset', async () => {
  await assert.rejects(resetPlot(fakeServer({ same: false }), fightPlot(MIDDLE), { sleep: noWait }), /did not come back/)
  await assert.rejects(resetPlot(fakeServer({ leftovers: true }), fightPlot(MIDDLE), { sleep: noWait }), /still in the plot/)
})

test('a bot exactly as the scene wants it passes', async () => {
  await checkBot(fakeServer(), 'Agent1', { kit: KIT, at: AT }, { sleep: noWait })
})

for (const [what, change, reason] of [
  ['hurt', b => { b.Health = '19.0f' }, /health 19/],
  ['hungry', b => { b.foodLevel = '19' }, /food 19/],
  ['on fire', b => { b.Fire = '40s' }, /fire 40/],
  ['with experience', b => { b.XpLevel = '3' }, /xp level 3/],
  ['with an extra item', b => { b.total = 3 }, /3 items in the bag/],
  ['missing a kit item', b => { b.shield = 0; b.total = 1 }, /0 of 1 shield/],
  ['wearing armor', b => { b.armor = 1 }, /armor/],
  ['holding something in the off hand', b => { b.offhand = 1 }, /offhand/],
  ['in the wrong place', b => { b.pos = '[90.5d, 68.0d, 22.5d]' }, /at 90\.5/]
]) {
  test(`a bot ${what} fails the reset`, async () => {
    const w = fakeServer()
    change(w.bot)
    await assert.rejects(checkBot(w, 'Agent1', { kit: KIT, at: AT }, { sleep: noWait }), reason)
  })
}

test('an effect that lands a moment late is waited for', async () => {
  const w = fakeServer()
  w.bot.Health = '12.0f'
  let waits = 0
  await checkBot(w, 'Agent1', { kit: KIT, at: AT }, { sleep: async () => { if (++waits === 2) w.bot.Health = '20.0f' } })
  assert.equal(waits, 2)
})

test('a new life starts with an empty bag, no effects and no experience', async () => {
  const w = fakeServer()
  await clearBot(w, 'Agent1')
  for (const c of ['clear Agent1', 'effect clear Agent1', 'xp set Agent1 0 levels', 'xp set Agent1 0 points']) assert.ok(w.sent.includes(c), c)
})

test('the scene name goes to everybody\'s chat as valid JSON', async () => {
  const w = fakeServer()
  await announce(w, 'Next test: net_zombie')
  const json = w.sent[0].replace('tellraw @a ', '')
  assert.equal(JSON.parse(json).text, 'Next test: net_zombie')
})

test('a session refuses a scene it has no reset for, before it touches anything', async () => {
  const before = process.env.AGENTS_IN_PROCESS
  process.env.AGENTS_IN_PROCESS = '1'
  try {
    await assert.rejects(runSession(['net_zombie', 'iron_base'], 1), /only runs fight scenes so far, not iron_base/)
  } finally {
    if (before === undefined) delete process.env.AGENTS_IN_PROCESS
    else process.env.AGENTS_IN_PROCESS = before
  }
})
