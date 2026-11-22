// Keeps a small text file up to date for the corner of the screen: the agent's health and food, how far it is from the
// base, its time on the job, the model's use and cost, and what it carries.
//
//   DEMO_PLAYER=<name> DEMO_HUD_FILE=<text file> DEMO_JOB_LOG=<the demo's log> node bridge/danger_sensing_agents/demo/corner_display.js
//
// DEMO_STAGE measures the distance from the base. Without it, the distance is from the player.

const fs = require('fs')
const { Rcon } = require('../../rcon')
const { agentsRconSettings } = require('../agents')
const { loadSettings } = require('./settings')
const scene = require('./scene')
const { hudLines, jobLine, apiLines, maxDurability } = require('./corner_lines')

const EVERY_MS = 2500
const LOG_TAIL = 300000
const BAG_SLOTS = 36

// The game cuts long data replies, so everything is read one field at a time
const field = reply => {
  const m = /has the following entity data: (.*)$/s.exec(String(reply))
  return m ? m[1].trim() : null
}

function number (reply) {
  const value = parseFloat(field(reply))
  return Number.isFinite(value) ? value : null
}

async function readItem (send, bot, at) {
  const raw = field(await send(`data get entity ${bot} ${at}.id`))
  if (!raw) return null
  const id = raw.replace(/"/g, '').replace('minecraft:', '')
  const count = parseInt(field(await send(`data get entity ${bot} ${at}.count`)) ?? '1', 10) || 1
  let damage = 0
  if (maxDurability(id)) damage = parseInt(field(await send(`data get entity ${bot} ${at}.components."minecraft:damage"`)) ?? '0', 10) || 0
  return { id, count, damage }
}

async function readBag (send, bot) {
  const items = []
  for (let i = 0; i < BAG_SLOTS; i++) {
    const item = await readItem(send, bot, `Inventory[${i}]`)
    if (!item) break
    items.push(item)
  }
  const off = await readItem(send, bot, 'equipment.offhand')
  if (off) items.push(off)
  return items
}

async function positionOf (send, name) {
  const out = []
  for (const axis of [0, 1, 2]) {
    const value = number(await send(`data get entity ${name} Pos[${axis}]`))
    if (value === null) return null
    out.push(value)
  }
  return out
}

// The whole readout, or nothing while the agent is not in the world
async function cornerLines ({ send, bot, player, home = null, logText = '', nowSeconds = 0 }) {
  const hp = number(await send(`data get entity ${bot} Health`))
  const food = number(await send(`data get entity ${bot} foodLevel`))
  if (hp === null || food === null) return []
  const lines = [bot, `HP   ${hp.toFixed(1)} / 20`, `Food ${food} / 20`]
  const at = await positionOf(send, bot)
  const from = home ? [home.x, home.y, home.z] : await positionOf(send, player)
  if (at && from) {
    const label = home ? 'Base       ' : 'Player     '
    lines.push(`${label}${Math.round(Math.hypot(at[0] - from[0], at[1] - from[1], at[2] - from[2]))} blocks away`)
  }
  lines.push(...jobLine(logText, nowSeconds, bot), ...apiLines(logText), ...hudLines(await readBag(send, bot)))
  return lines
}

function logTail (file) {
  if (!file) return ''
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const { size } = fs.fstatSync(fd)
      const length = Math.min(size, LOG_TAIL)
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

function writeLines (file, lines) {
  const next = `${file}.tmp`
  fs.writeFileSync(next, lines.join('\r\n'))
  fs.renameSync(next, file)
}

async function main (env = process.env) {
  const file = env.DEMO_HUD_FILE
  if (!file) throw new Error('Set DEMO_HUD_FILE to the text file the display reads')
  const settings = loadSettings(env)
  const rc = agentsRconSettings()
  if (!rc) throw new Error('The display needs RCON on the agents server')
  let rcon = null
  for (;;) {
    try {
      if (!rcon) {
        rcon = new Rcon(settings.host, rc.port, rc.password)
        await rcon.connect()
      }
      const now = new Date()
      const lines = await cornerLines({
        send: c => rcon.send(c),
        bot: settings.agent,
        player: settings.player,
        home: settings.stage ? scene.spots(settings.stage).player : null,
        logText: logTail(env.DEMO_JOB_LOG),
        nowSeconds: now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
      })
      if (lines.length) writeLines(file, lines)
    } catch {
      try { rcon?.close() } catch {}
      rcon = null
    }
    await new Promise(resolve => setTimeout(resolve, EVERY_MS))
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}

module.exports = { cornerLines, readBag, writeLines }
