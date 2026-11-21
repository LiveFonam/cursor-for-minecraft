'use strict'

// The crafter on a real server, through chat. Needs the server from
// scripts/setup-server.sh running on a flat world with RCON on, and nobody
// else on it. It starts the crew with CrewTester as the owner, logs CrewTester
// in, sets each scene up over RCON and types the requests in chat.
//
//   node scripts/crafter-live.js            every scene
//   node scripts/crafter-live.js demo       one scene (demo, six, iron, notable)

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const mineflayer = require('mineflayer')
const { Rcon } = require('../../director/scripts/rcon')

const ROOT = path.join(__dirname, '..')
const SERVER = process.env.CREW_SERVER_DIR ? path.resolve(process.env.CREW_SERVER_DIR) : path.join(ROOT, 'server')
const TESTER = 'CrewTester'
const BOT = 'CrewHelper1'
const HOST = process.env.CREW_HOST || '127.0.0.1'
const PORT = Number(process.env.CREW_PORT || 25565)
const VERSION = process.env.CREW_VERSION || '1.21.4'
const Y = -60

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (...args) => console.log(`[crafter ${new Date().toTimeString().slice(0, 8)}]`, ...args)

function rconSettings () {
  const props = Object.fromEntries(fs.readFileSync(path.join(SERVER, 'server.properties'), 'utf8').split('\n')
    .filter(line => line.includes('=') && !line.startsWith('#'))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]))
  return { port: Number(props['rcon.port']), password: props['rcon.password'] }
}

// What the bot says, and a way to wait for a line
function watchChat (player) {
  const lines = []
  const waiters = []
  player.on('messagestr', text => {
    const match = String(text).match(/^<([^>]+)> (.*)$/)
    if (!match || match[1] !== BOT) return
    lines.push(match[2])
    log(`  ${BOT}: ${match[2]}`)
    for (const w of waiters.slice()) if (w.re.test(match[2])) { waiters.splice(waiters.indexOf(w), 1); w.resolve(match[2]) }
  })
  return {
    lines,
    mark () { this.from = lines.length },
    wait (re, ms) {
      const seen = lines.slice(this.from ?? 0).find(line => re.test(line))
      if (seen) return Promise.resolve(seen)
      return new Promise((resolve, reject) => {
        const w = { re, resolve }
        waiters.push(w)
        setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`no "${re}" within ${ms / 1000} s`)) } }, ms)
      })
    }
  }
}

const held = (player, name) => player.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0)

async function serverCount (rcon, who, item) {
  const reply = String(await rcon.send(`clear ${who} ${item} 0`))
  const match = reply.match(/Found (\d+)/i)
  return match ? Number(match[1]) : 0
}

async function scene (rcon, { bot = {}, tester = {}, table = true }) {
  for (const command of [
    `fill -10 ${Y} -10 10 ${Y + 4} 10 air`, `fill -10 ${Y - 1} -10 10 ${Y - 1} 10 grass_block`,
    'kill @e[type=item]', `clear ${BOT}`, `clear ${TESTER}`,
    `tp ${BOT} 0.5 ${Y} 0.5`, `tp ${TESTER} 4.5 ${Y} 0.5`
  ]) await rcon.send(command)
  if (table) await rcon.send(`setblock 0 ${Y} 2 crafting_table`)
  for (const [item, n] of Object.entries(bot)) await rcon.send(`give ${BOT} ${item} ${n}`)
  for (const [item, n] of Object.entries(tester)) await rcon.send(`give ${TESTER} ${item} ${n}`)
  await sleep(1500)
}

async function one ({ rcon, player, chat }, item, opts, ms = 60000) {
  await scene(rcon, opts)
  chat.mark()
  const before = held(player, item)
  player.chat(`@crew craft me a ${item.replace(/_/g, ' ')}`)
  await chat.wait(new RegExp(`Here is your ${item.replace(/_/g, ' ')}`), ms)
  await sleep(1500)
  return { item, tester: held(player, item) - before, bot: await serverCount(rcon, BOT, item) }
}

const SCENES = {
  // 1 oak log and 2 cobblestone by a table: exactly 1 cobblestone short. The
  // flat world has no stone to mine, so after trying it asks, and the player
  // drops the block
  async demo ({ rcon, player, chat }) {
    await scene(rcon, { bot: { oak_log: 1, cobblestone: 2 }, tester: { cobblestone: 1 } })
    chat.mark()
    player.chat('@crew craft me a stone pickaxe')
    const need = await chat.wait(/still need .* Bring it/, 90000)
    if (!/still need 1 cobblestone\./.test(need)) throw new Error(`expected exactly 1 cobblestone, got "${need}"`)
    await rcon.send(`tp ${TESTER} 2.5 ${Y} 0.5`)
    await sleep(500)
    const bot = player.players[BOT]?.entity
    if (bot) await player.lookAt(bot.position.offset(0, 0.5, 0), true)
    await player.toss(player.registry.itemsByName.cobblestone.id, null, 1)
    log('  CrewTester dropped 1 cobblestone, no second command')
    await chat.wait(/Here is your stone pickaxe/, 90000)
    await sleep(1500)
    return { item: 'stone_pickaxe', tester: held(player, 'stone_pickaxe'), bot: await serverCount(rcon, BOT, 'stone_pickaxe'), asked: need }
  },
  async six (ctx) {
    const bags = {
      wooden_pickaxe: { oak_log: 2 },
      stone_pickaxe: { oak_log: 1, cobblestone: 3 },
      iron_pickaxe: { oak_log: 1, iron_ingot: 3 },
      diamond_pickaxe: { oak_log: 1, diamond: 3 },
      furnace: { cobblestone: 8 },
      crafting_table: { oak_log: 1 }
    }
    const out = []
    for (const [item, bot] of Object.entries(bags)) out.push(await one(ctx, item, { bot }))
    return out
  },
  async iron (ctx) {
    return one(ctx, 'iron_pickaxe', { bot: { raw_iron: 3, coal: 1, cobblestone: 8, oak_log: 1 } }, 120000)
  },
  async notable (ctx) {
    return one(ctx, 'stone_pickaxe', { bot: { oak_log: 2, cobblestone: 3 }, table: false })
  }
}

async function main () {
  const pick = process.argv[2] ? process.argv[2].split(',') : Object.keys(SCENES)
  const { port, password } = rconSettings()
  const rcon = new Rcon(HOST, port, password)
  await rcon.connect()
  for (const command of ['time set day', 'weather clear', 'difficulty peaceful']) await rcon.send(command)

  const crew = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, CREW_OWNER: TESTER, CREW_BOTS: BOT, CREW_HOST: HOST, CREW_PORT: String(PORT), CREW_VERSION: VERSION },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let joined
  const ready = new Promise(resolve => { joined = resolve })
  const show = data => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      console.log(`  crew| ${line}`)
      if (/joined/.test(line)) joined()
    }
  }
  crew.stdout.on('data', show)
  crew.stderr.on('data', show)
  await Promise.race([ready, sleep(30000)])

  const player = mineflayer.createBot({ host: HOST, port: PORT, username: TESTER, version: VERSION, auth: 'offline' })
  await new Promise((resolve, reject) => { player.once('spawn', resolve); player.once('error', reject) })
  const chat = watchChat(player)
  await sleep(2000)

  let failed = 0
  for (const name of pick) {
    log(`scene ${name}`)
    try {
      const result = await SCENES[name]({ rcon, player, chat })
      const list = [].concat(result)
      const ok = list.every(r => r.tester === 1 && r.bot === 0)
      if (!ok) failed++
      log(`scene ${name}: ${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(list)}`)
    } catch (err) {
      failed++
      log(`scene ${name}: FAIL ${err.message}`)
    }
  }
  log(`${pick.length - failed}/${pick.length} scenes passed`)
  player.quit()
  crew.kill('SIGINT')
  rcon.close()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500)
}

main().catch(err => { console.error(err); process.exit(1) })
