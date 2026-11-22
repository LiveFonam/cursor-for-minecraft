// Confirms the two Mineflayer corrections on a real server, with one bot that has them and one that does not.
//
//   node probe.js --rcon-file rcon.pw
//
// Sprint: a third bot watches whether the server shows each runner as sprinting. Velocity: the same bot hits each one,
// and the velocity the client holds is compared with the packet.

require('../patch-physics')
const fs = require('fs')
const mineflayer = require('mineflayer')
const { Rcon } = require('../rcon')
const { applyMineflayerFixes } = require('../mineflayer_fixes')

const SPRINT_FLAG = 0x08
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const opt = { host: '127.0.0.1', port: 25594, rconPort: 25595 }
const a = process.argv.slice(2)
for (let i = 0; i < a.length; i += 2) opt[a[i].slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = a[i + 1]

async function join (name, fixed) {
  const bot = mineflayer.createBot({ host: opt.host, port: Number(opt.port), username: name, version: '1.21.11', auth: 'offline', viewDistance: 'short' })
  bot.on('error', e => console.log(`bot error ${name}: ${e.message}`))
  await new Promise((resolve, reject) => {
    bot.once('spawn', resolve)
    bot.once('end', r => reject(new Error(`ended ${name}: ${r}`)))
  })
  if (fixed) applyMineflayerFixes(bot)
  return bot
}

async function sprintCheck (rcon, runner, watcher, x) {
  await rcon.send(`tp ${runner.username} ${x}.5 0 4.5 0 0`)
  await rcon.send(`tp ${watcher.username} ${x + 2}.5 0 10.5 180 0`)
  await runner.waitForTicks(30)
  let shown = 0
  let ticks = 0
  const start = runner.entity.position.clone()
  runner.setControlState('forward', true)
  runner.setControlState('sprint', true)
  await runner.waitForTicks(6)
  for (let i = 0; i < 20; i++) {
    await runner.waitForTicks(1)
    const seen = watcher.players[runner.username]?.entity
    ticks++
    if (((seen?.metadata?.[0] ?? 0) & SPRINT_FLAG) !== 0) shown++
  }
  runner.clearControlStates()
  const moved = runner.entity.position.distanceTo(start) / 26
  return { shownSprinting: `${shown}/${ticks}`, blocksPerTick: Number(moved.toFixed(3)) }
}

async function velocityCheck (rcon, victim, hitter, x) {
  await rcon.send(`tp ${victim.username} ${x}.5 0 -8.5 0 0`)
  await rcon.send(`tp ${hitter.username} ${x}.5 0 -10.5 0 0`)
  await victim.waitForTicks(30)
  await hitter.lookAt(victim.entity.position.offset(0, 1.2, 0), true)
  await hitter.waitForTicks(25)
  const packet = new Promise(resolve => {
    const on = p => {
      if (p.entityId !== victim.entity.id) return
      victim._client.removeListener('entity_velocity', on)
      setImmediate(() => resolve({ raw: p.velocity, held: { x: victim.entity.velocity.x, y: victim.entity.velocity.y, z: victim.entity.velocity.z } }))
    }
    victim._client.on('entity_velocity', on)
  })
  hitter.attack(hitter.players[victim.username].entity)
  const got = await Promise.race([packet, sleep(3000).then(() => null)])
  if (!got) return { error: 'no velocity packet' }
  const size = v => Math.hypot(v.x, v.y, v.z)
  return { packet: Number(size(got.raw).toFixed(4)), clientHolds: Number(size(got.held).toFixed(6)) }
}

async function main () {
  const rcon = new Rcon(opt.host, Number(opt.rconPort), fs.readFileSync(opt.rconFile, 'utf8').trim())
  await rcon.connect()
  await rcon.send('forceload add -32 -32 64 32')
  const fixed = await join('RcFixed', true)
  await sleep(500)
  const raw = await join('RcPlain', false)
  await sleep(500)
  const watcher = await join('RcWatch', true)
  await sleep(1000)
  for (const b of [fixed, raw, watcher]) await rcon.send(`effect give ${b.username} minecraft:saturation 5 20 true`)
  const out = {
    sprint: { withFix: await sprintCheck(rcon, fixed, watcher, 0), without: await sprintCheck(rcon, raw, watcher, 12) },
    velocity: { withFix: await velocityCheck(rcon, fixed, watcher, 24), without: await velocityCheck(rcon, raw, watcher, 36) }
  }
  console.log('PROBE ' + JSON.stringify(out))
  for (const b of [fixed, raw, watcher]) b.quit()
  await sleep(500)
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
