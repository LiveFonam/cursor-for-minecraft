// Show match identity. A Minecraft login holds at most 16 characters and no spaces, so the bot logs in as the last word
// of DEMO_DISPLAY_NAME and a scoreboard team puts the words before it in front as a prefix. Its live health shows
// under the name from a health objective on the below_name slot.
//
// Nothing here acts unless DEMO_SHOWMATCH=1. No fighter input reads scoreboards or teams (fair_health.js keeps its own
// estimate), so the human's score, which the bot's client also receives, changes nothing the network observes.

const fs = require('fs')
const os = require('os')
const path = require('path')

const ENABLED = process.env.DEMO_SHOWMATCH === '1'
const DEFAULT_NAME = 'FNNs'
const TEAM = 'showmatch'
const OBJECTIVE = 'showmatch_health'
const TEARDOWN_MS = 400  // the bridge exits right after, a dead RCON must not hold it

let active = false
let tearingDown = null

function identity () {
  const words = (process.env.DEMO_DISPLAY_NAME || DEFAULT_NAME).trim().split(/\s+/)
  const login = words.pop()
  if (!/^[A-Za-z0-9_]{3,16}$/.test(login)) {
    throw new Error(`DEMO_DISPLAY_NAME must end in a valid login (3 to 16 letters, digits or _), got "${login}"`)
  }
  return { login, prefix: words.length ? `${words.join(' ')} ` : '' }
}

// Where the human's ready marker and saved layout live. A show match clone has no runs/ folder, and writing there
// when he typed go killed the bridge
function stateDir (normal) {
  if (!ENABLED) return normal
  const dir = path.join(os.tmpdir(), 'demo-showmatch')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function agentName (index) {
  return ENABLED ? identity().login : `agent${index}`
}

function isLogin (name) {
  return ENABLED && name === identity().login
}

// One login cannot sit in two arenas, and a human with the same name would kick the bot off the server
function check (opts) {
  if (!ENABLED) return
  const { login } = identity()
  if (opts.arenas !== 1) throw new Error(`a show match runs in one arena, got ${opts.arenas}`)
  if (opts.human?.toLowerCase() === login.toLowerCase()) throw new Error(`the human cannot also be named ${login}`)
}

// Runs before the bot logs in. The server only fills a health score when the value changes, so an objective created
// after login would read 0 until the first hit. Joining the team first also puts the full name in the join message
async function setup (rcon) {
  if (!ENABLED) return
  const { login, prefix } = identity()
  active = true
  tearingDown = null
  for (const command of [
    `team add ${TEAM}`,
    `team empty ${TEAM}`,
    `team modify ${TEAM} prefix ${JSON.stringify({ text: prefix })}`,
    `team join ${TEAM} ${login}`,
    `scoreboard objectives remove ${OBJECTIVE}`
  ]) await rcon.send(command)
  // The objective list shows display names only, so the replies to these two commands are the check
  const created = await rcon.send(`scoreboard objectives add ${OBJECTIVE} health ${JSON.stringify({ text: 'HP', color: 'red' })}`)
  const shown = await rcon.send(`scoreboard objectives setdisplay below_name ${OBJECTIVE}`)
  const members = await rcon.send(`team list ${TEAM}`)
  if (!new RegExp(`\\b${login}\\b`).test(members)) throw new Error(`${login} did not join team ${TEAM}: ${members}`)
  if (!/^Created/.test(created)) throw new Error(`objective ${OBJECTIVE} was not created: ${created}`)
  if (!/^Set display slot/.test(shown)) throw new Error(`objective ${OBJECTIVE} is not on below_name: ${shown}`)
}

// Takes the name and health display off the server, so a later run without the show match sees none of it. Safe to
// call twice: the close command and the end of stdin can both arrive
function teardown (rcon) {
  if (!active) return tearingDown ?? Promise.resolve()
  active = false
  const removal = (async () => {
    await rcon.send(`scoreboard objectives remove ${OBJECTIVE}`)
    await rcon.send(`team remove ${TEAM}`)
  })().catch(() => {})
  tearingDown = Promise.race([removal, new Promise(resolve => setTimeout(resolve, TEARDOWN_MS))])
  return tearingDown
}

const FIGHTS_PER_MATCH = 3
const WINS_TO_TAKE_MATCH = 2
const START_WORDS = 'go for axe or go-uhc for UHC'
const START_FOOD = 9  // 4.5 of 10 bars with no saturation. Sprinting stops at 3 bars, so nobody can run forever

// Commands can not set a player's food, so a strong hunger effect drains it and stops at the target
async function lowerFood (player, rcon, waitTicks) {
  if (!ENABLED) return
  await waitTicks(2)  // the round's full refill lands first
  await rcon.send(`effect clear ${player} minecraft:saturation`)
  await rcon.send(`effect give ${player} minecraft:hunger 15 255 true`)
  for (let t = 0; t < 200; t++) {
    const food = Number(/(\d+)\s*$/.exec(await rcon.send(`data get entity ${player} foodLevel`))?.[1])
    if (!(food > START_FOOD)) break
    await waitTicks(1)
  }
  await rcon.send(`effect clear ${player} minecraft:hunger`)
}
// 20 by 20, exactly 5 by 5 floor squares, with the fighters 10 blocks apart. Every other run keeps 31 by 31
const ARENA_HALF = ENABLED ? 10 : 15
const ARENA_MAX = ENABLED ? 9 : 15  // the last floor block on the plus side, the first is -ARENA_HALF
const ARENA_MID = (ARENA_MAX + 1 - ARENA_HALF) / 2  // the floor's true middle
const ARENA_REACH = (ARENA_MAX + 1 + ARENA_HALF) / 2  // from that middle to a wall
const ARENA_SPAWN_X = ENABLED ? 5 : 13
const REMIND_EVERY = ENABLED ? 480 : 60  // in checks of 5 ticks, so every 2 minutes in a show match

// Brings anyone inside to the middle, then removes the old 31 by 31 floor and walls outside the smaller arena
function shrinkCommands (cx) {
  const OLD = 16
  const low = -ARENA_HALF - 1  // the wall on the minus side
  const high = ARENA_MAX + 1  // the wall on the plus side
  return [
    `tp @a[x=${cx},y=100,z=0,distance=..40] ${cx} 100 0`,
    `fill ${cx - OLD} 98 ${-OLD} ${cx + OLD} 105 ${low - 1} air`,
    `fill ${cx - OLD} 98 ${high + 1} ${cx + OLD} 105 ${OLD} air`,
    `fill ${cx - OLD} 98 ${low} ${cx + low - 1} 105 ${high} air`,
    `fill ${cx + high + 1} 98 ${low} ${cx + OLD} 105 ${high} air`,
    // the stone layer is laid again right after, only under the floor, so no ring shows around it
    `fill ${cx + low} 98 ${low} ${cx + high} 98 ${high} air`
  ]
}

function enchanted (id, levels) {
  const list = Object.entries(levels).map(([name, level]) => `"minecraft:${name}":${level}`).join(',')
  return `${id}[enchantments={${list}}]`
}

// The UHC kit's enchantment levels (brain/sim/kits.py), anything else passes through unchanged
function uhcGear (id) {
  if (/_(helmet|chestplate|leggings|boots)$/.test(id)) return enchanted(id, { protection: 2, unbreaking: 3 })
  if (/_(axe|sword)$/.test(id)) return enchanted(id, { sharpness: 2, unbreaking: 3 })
  if (id === 'bow') return enchanted(id, { power: 1, unbreaking: 3 })
  if (id === 'crossbow' || id === 'shield' || id === 'fishing_rod') return enchanted(id, { unbreaking: 3 })
  return id
}

// The fighter keeps its usual slots, because its network was trained on them
const uhcBotKit = kit => kit.map(([slot, item]) => [slot, uhcGear(item)])

// The player's UHC kit (KIT_ITEMS in brain/sim/uhc_env.py). Everyone fights in adventure mode, so anything placed
// carries the blocks it may go on
function uhcHumanKit (placeOn) {
  const place = `[can_place_on=[{blocks:${placeOn}}]]`
  return [
    ['armor.head', uhcGear('diamond_helmet')],
    ['armor.chest', uhcGear('diamond_chestplate')],
    ['armor.legs', uhcGear('diamond_leggings')],
    ['armor.feet', uhcGear('diamond_boots')],
    ['weapon.offhand', uhcGear('shield')],
    ['hotbar.0', uhcGear('diamond_axe')],
    ['hotbar.1', uhcGear('diamond_sword')],
    ['hotbar.2', 'golden_apple 8'],
    ['hotbar.3', `water_bucket${place}`],
    ['hotbar.4', `lava_bucket${place}`],
    ['hotbar.5', `cobweb${place} 8`],
    ['hotbar.6', `cobblestone${place} 64`],
    ['hotbar.7', uhcGear('bow')],
    ['hotbar.8', uhcGear('crossbow')],
    ['inventory.0', 'arrow 6'],
    ['inventory.1', `water_bucket${place}`],
    ['inventory.2', `water_bucket${place}`],
    ['inventory.3', `water_bucket${place}`],
    ['inventory.4', `lava_bucket${place}`],
    ['inventory.5', 'ender_pearl 2'],
    ['inventory.6', uhcGear('fishing_rod')]
  ]
}

// Pearls in flight and dropped items must not carry into the next UHC round
const uhcCleanup = center => ['ender_pearl', 'item', 'fishing_bobber'].map(type =>
  `kill @e[type=minecraft:${type},x=${center.x},y=100,z=${center.z},distance=..40]`)

// A player whose saved mode is spectator gets a normal body, so go can start the fight
async function keepBody (arena, rcon) {
  if (ENABLED && arena.spectating()) await rcon.send(`gamemode adventure ${arena.enemyName}`)
}

const AXE_RANGE = 4  // blocks, inside this the fighter holds its axe
const AXE_RELEASE = 5.5  // wider than the range so it does not flip weapons at the edge
const SLOT_ACTION = 8  // the slot head of an action (fighter.js act)
const AXE_ACTION = 1

// The network keeps every other choice, only its weapon is overruled up close
function axeUpClose (fighter, action) {
  if (!ENABLED || /^opp\d+$/.test(fighter.bot.username)) return action
  const me = fighter.bot.entity
  const foe = fighter.enemy.entity()
  if (!me || !foe) {
    fighter.axeUp = false
    return action
  }
  fighter.axeUp = me.position.distanceTo(foe.position) <= (fighter.axeUp ? AXE_RELEASE : AXE_RANGE)
  if (!fighter.axeUp) return action
  const out = Array.from(action)
  out[SLOT_ACTION] = AXE_ACTION
  return out
}

const SWING_CHARGE = 0.9  // the axe waits for this much charge
const OPENING_CHARGE = 0.95  // at this charge, on target with no shield in the way, it always swings

const SPRINT_ACTION = 2  // the sprint and jump heads of an action (fighter.js act)
const JUMP_ACTION = 3
const CRIT_RANGE = 3.6  // blocks from the eyes, aimed at the enemy, where a jump can still come down on them
const CRIT_JUMP_CHARGE = 0.6  // a jump starts falling after about 0.4 s, so the swing is charged by then
const CRIT_FALL_TICKS = 2  // the server counts a crit after this much falling (fighter.js swing)
const CRIT_HOLD_MAX = 5  // decisions, 0.5 s, the longest a charged swing waits for the fall

// Close, aimed and charging, the fighter jumps. In the air it lets go of sprint, because a sprinting hit is never a crit
function critJump (fighter, action) {
  fighter.critStart = false
  if (!ENABLED || /^opp\d+$/.test(fighter.bot.username)) return action
  if (fighter.weapon() !== 'axe' || fighter.shieldUp || fighter.charging || fighter.drawing) return action
  const me = fighter.bot.entity
  if (!me || !fighter.enemy.entity() || fighter.enemy.shieldActive()) return action
  if (!fighter.crosshairOnEnemy(CRIT_RANGE)) return action
  const out = Array.from(action)
  if (!me.onGround) {
    out[SPRINT_ACTION] = 0
  } else if (fighter.charge() >= CRIT_JUMP_CHARGE) {
    out[JUMP_ACTION] = 1
    fighter.critStart = true
  }
  return out
}

// The axe swings only when the swing can land for real damage, on the way down when it can. A swing at a raised shield
// stays the network's choice, including its double click, so it keeps its shield breaking
function swingChoice (fighter, click) {
  if (!ENABLED || /^opp\d+$/.test(fighter.bot.username)) return click
  if (fighter.weapon() !== 'axe' || fighter.shieldUp || fighter.charging || fighter.drawing) return click
  if (!fighter.crosshairOnEnemy()) {
    fighter.critHeld = 0
    return 0
  }
  if (fighter.enemy.shieldActive()) {
    fighter.critHeld = 0
    return click
  }
  const charge = fighter.charge()
  if (charge < SWING_CHARGE) return 0
  const onGround = fighter.bot.entity.onGround
  const falling = !onGround && fighter.ticksFalling >= CRIT_FALL_TICKS
  const waiting = onGround ? fighter.critStart : !falling
  if (waiting && (fighter.critHeld ?? 0) < CRIT_HOLD_MAX) {
    fighter.critHeld = (fighter.critHeld ?? 0) + 1
    return 0
  }
  fighter.critHeld = 0
  return falling || charge >= OPENING_CHARGE || click > 0 ? 1 : 0
}

const STEPS_PER_SECOND = 10
const CLOCK_WARNING = 10  // seconds, the timer turns red from here

// A double death or a round that runs out of time scores for the bot in a show match. Its saved result stays as it was
function drawGoesToBot (result) {
  return ENABLED && (result === 'draw' || result === 'timeout')
}

// The time left before bridge.js result() calls the round. With no damage yet the short limit applies, and past the
// normal limit the round only goes on while both fighters are low on health
function clockText ({ steps, damaged, quietSteps, maxSteps, low }) {
  const end = !damaged ? Math.min(quietSteps, maxSteps) : steps >= maxSteps && low ? maxSteps * 1.5 : maxSteps
  const left = Math.max(0, Math.ceil((end - steps) / STEPS_PER_SECOND))
  const seconds = String(left % 60).padStart(2, '0')
  return { text: `Draw in ${Math.floor(left / 60)}:${seconds}`, warning: left <= CLOCK_WARNING }
}

// Every round goes to data/showmatch-rounds.jsonl the moment it ends, and every loss also to showmatch-losses.jsonl.
// A failed write must never stop a fight
function recordRound (arena, info) {
  try {
    const dir = process.env.DEMO_SHOWMATCH_DATA || path.join(__dirname, '..', 'data')
    fs.mkdirSync(dir, { recursive: true })
    const width = ARENA_MAX + ARENA_HALF + 1
    const chase = process.env.DEMO_CHASE === '1' ? 'chase' : 'no chase'
    const row = JSON.stringify({
      time: new Date().toLocaleString('sv'),
      fight_of_match: arena.fights,
      kit: arena.kitMode ?? 'axe',
      result: info.result ?? null,
      point_to: info.result === 'win' || drawGoesToBot(info.result) ? 'bot' : info.result === 'loss' ? 'player' : null,
      bot_hp: info.hp ?? null,
      player_hp: info.enemy_hp ?? null,
      steps: info.steps ?? arena.steps ?? null,
      player: arena.enemyName,
      setup: `${chase}, ${width} arena, ${START_FOOD / 2} food bars, top move, swing rule, crit jump`
    }) + '\n'
    fs.appendFileSync(path.join(dir, 'showmatch-rounds.jsonl'), row)
    if (info.result === 'loss') fs.appendFileSync(path.join(dir, 'showmatch-losses.jsonl'), row)
  } catch (err) {
    console.error(`[showmatch] could not record the round: ${err.message}`)
  }
}

// When the best of 3 is decided the score goes back to 0-0 and the next match waits for go
async function afterFight (arena, rcon, info = {}) {
  if (!ENABLED || !arena.score) return
  arena.fights = (arena.fights ?? 0) + 1
  recordRound(arena, info)
  if (info.result === 'win') {
    const hp = Math.round((info.hp ?? 0) * 10) / 10
    const { prefix: before, login: who } = identity()
    const text = `${before}${who} won with ${hp} HP left (${hp / 2} hearts)`
    await rcon.send(`tellraw ${arena.enemyName} ${JSON.stringify({ text, color: 'yellow' })}`)
  }
  if (drawGoesToBot(info.result)) {
    const { prefix: before, login: who } = identity()
    await rcon.send(`tellraw ${arena.enemyName} ${JSON.stringify({ text: `Draw, the point goes to ${before}${who}`, color: 'yellow' })}`)
  }
  // Best of 3, the match ends as soon as one side has 2 wins
  if (Math.max(arena.score.bot, arena.score.you) < WINS_TO_TAKE_MATCH && arena.fights < FIGHTS_PER_MATCH) return
  const { bot, you } = arena.score
  const { prefix, login } = identity()
  const name = `${prefix}${login}`
  const headline = bot === you ? 'Match tied' : bot > you ? `${name} wins the match` : 'You win the match'
  const player = arena.enemyName
  await rcon.send(`title ${player} subtitle ${JSON.stringify({ text: `${name} ${bot} - You ${you}`, color: 'white' })}`)
  await rcon.send(`title ${player} title ${JSON.stringify({ text: headline, color: 'gold' })}`)
  await rcon.send(`tellraw ${player} ${JSON.stringify({ text: `Score reset. Type ${START_WORDS}.`, color: 'aqua' })}`)
  arena.fights = 0
  arena.score = { bot: 0, you: 0 }
  arena.ready = false
  await arena.showStatus()
}

module.exports = {
  ENABLED, TEAM, OBJECTIVE, FIGHTS_PER_MATCH, START_WORDS, ARENA_HALF, ARENA_MAX, ARENA_MID, ARENA_REACH, ARENA_SPAWN_X, REMIND_EVERY, identity, stateDir,
  agentName, isLogin, check, setup, teardown, keepBody, afterFight, uhcBotKit, uhcHumanKit, uhcCleanup, shrinkCommands, lowerFood, START_FOOD, axeUpClose, critJump, swingChoice, drawGoesToBot, clockText
}
