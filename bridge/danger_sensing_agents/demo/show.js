// The start and the look of a 1v1: both players held still, 3, 2, 1 on a boss bar, and live health under each name.
// Everything goes through the server console, so no fighter input can read it.

const BAR = 'demo:countdown'
const HEALTH = 'demo_health'
const HOLD = 'demo:countdown_hold'
const HELD = ['movement_speed', 'jump_strength']
const STEP_MS = 1000
const SEED_MS = 150        // long enough for the server to see the health change
const PIN_MS = 100         // how often the count puts each player back on their spot
const FIGHT_TEXT_MS = 1500

const barText = (text, color) => `bossbar set ${BAR} name ${JSON.stringify({ text, color })}`

// The server only fills a health score when the value changes, so this runs before the fighter logs in
function healthCommands () {
  return [
    `scoreboard objectives remove ${HEALTH}`,
    `scoreboard objectives add ${HEALTH} health ${JSON.stringify({ text: 'HP', color: 'red' })}`,
    `scoreboard objectives setdisplay below_name ${HEALTH}`
  ]
}

// A player who was online before the objective has no score until their health changes. A moment of absorption changes
// it with no damage, no flash and no sound
async function seedHealth ({ send, sleep, name }) {
  await send(`effect give ${name} minecraft:absorption 1 0 true`)
  await sleep(SEED_MS)
  await send(`effect clear ${name} minecraft:absorption`)
}

function holdCommands (names, on) {
  const out = []
  for (const name of names) {
    for (const a of HELD) {
      out.push(on
        ? `attribute ${name} minecraft:${a} modifier add ${HOLD} -1 add_multiplied_total`
        : `attribute ${name} minecraft:${a} modifier remove ${HOLD}`)
    }
    out.push(on ? `effect give ${name} minecraft:resistance infinite 255 true` : `effect clear ${name} minecraft:resistance`)
  }
  return out
}

function barCommands (viewer) {
  return [`bossbar add ${BAR} ""`, `bossbar set ${BAR} players ${viewer}`, `bossbar set ${BAR} color yellow`, `bossbar set ${BAR} visible true`]
}

// Nobody can move or be hurt until it reaches Fight. The attributes stop a normal game client, and pins put anyone whose
// client ignores them back on their spot, keeping the way they face. Returns false when the fight was called off
async function countdown ({ send, sleep, viewer, names, pins = [], live = () => true }) {
  const hold = async () => {
    if (!pins.length) return sleep(STEP_MS)
    for (let left = STEP_MS; left > 0 && live(); left -= PIN_MS) {
      for (const p of pins) await send(`tp ${p.name} ${p.x} ${p.y} ${p.z}`)
      await sleep(PIN_MS)
    }
  }
  for (const c of [...holdCommands(names, false), ...holdCommands(names, true), `bossbar remove ${BAR}`, ...barCommands(viewer)]) await send(c)
  for (const n of ['3', '2', '1']) {
    await send(barText(n, 'yellow'))
    await hold()
    if (!live()) return false
  }
  for (const c of holdCommands(names, false)) await send(c)
  await send(`bossbar set ${BAR} color red`)
  await send(barText('Fight!', 'red'))
  return true
}

// Safe to run twice, and after a fight that never started
function clearCommands (names) {
  return [...holdCommands(names, false), `bossbar remove ${BAR}`, `scoreboard objectives remove ${HEALTH}`]
}

module.exports = { healthCommands, seedHealth, holdCommands, countdown, clearCommands, BAR, HEALTH, FIGHT_TEXT_MS }
