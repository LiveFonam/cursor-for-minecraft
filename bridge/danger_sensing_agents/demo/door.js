// The base's one way in: an iron door worked by a lever on each side. The pathfinder sees the door as a wall, so crossing
// it is a scripted step: stand in front, flip the lever on, check the door opened, walk through, flip that lever back off.
// Either lever on holds the door open, so a door that is already open is the owner's: walk through, touch nothing.

const { Vec3 } = require('vec3')
const { goals, Movements } = require('mineflayer-pathfinder')
const scene = require('./scene')
const { walkTo } = require('../skills/move')

const TRIES = 4
const WAITS = Object.freeze({ open: 500, cross: 2500, reset: 300, stand: 15000, line: 800, poll: 40 })
const REACH = 4.5        // the game's block reach, measured from the eyes. It goes by distance, so a wall between is fine
const EYES = 1.62
const PANEL = 0.8        // the closed door's panel lies along the south edge of its block
const CLOSE = 0.25
const NEAR_STAND = 2.5
const REST_MS = 20000    // after a door that stayed shut, a job's next walks do not try it again straight away

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const middle = p => ({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 })
const blockOf = (bot, p) => bot.blockAt(new Vec3(p.x, p.y, p.z))
const isOpen = block => String(block?.getProperties?.().open) === 'true'
const isOn = block => String(block?.getProperties?.().powered) === 'true'
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

// 'in' for the room and the door's own cell up to its panel, 'out' for everything else, roof and mines included
function sideOf (stage, pos) {
  const b = scene.baseLayout(stage)
  const x = Math.floor(pos.x)
  const inX = x > b.center.x - b.half && x < b.center.x + b.half
  const inZ = pos.z >= b.center.z - b.half + 1 && pos.z < b.door.lower.z + PANEL
  const inY = pos.y >= b.center.y - 1 && pos.y <= b.wallTop + 1
  return inX && inZ && inY ? 'in' : 'out'
}

async function until (check, ms, poll, token) {
  const end = Date.now() + ms
  for (;;) {
    if (check()) return true
    if (token.cancelled || Date.now() >= end) return false
    await sleep(poll)
  }
}

// Straight at a point, without the pathfinder. True once there
async function walkLine (bot, to, ms, poll, token) {
  const end = Date.now() + ms
  const aim = () => bot.lookAt(new Vec3(to.x, bot.entity.position.y + 1.6, to.z), true)
  if (flat(bot.entity.position, to) <= CLOSE) return true
  try {
    await aim()
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    while (Date.now() < end && !token.cancelled) {
      if (flat(bot.entity.position, to) <= CLOSE) return true
      await aim()
      await sleep(poll)
    }
    return flat(bot.entity.position, to) <= CLOSE
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
  }
}

async function toStand (ctx, stand, token, { waits, walk }) {
  const { bot, agents } = ctx
  const spot = middle(stand)
  if (flat(bot.entity.position, spot) > NEAR_STAND) {
    try {
      // no rescue moves: they would dig through the wall the door is there to keep whole
      await walk(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), token, { ms: waits.stand, tries: 1, log: agents.log })
    } catch (err) {
      agents.log(`${bot.username} walk to the door: ${err.message}`)
      return false
    }
  }
  if (token.cancelled) return false
  return walkLine(bot, spot, waits.line, waits.poll, token)
}

// Puts the lever in state `on`, and waits to see it there. A flip toggles, so it reads the lever first
async function setLever (ctx, lever, face, on, token, waits) {
  const { bot, agents } = ctx
  const block = blockOf(bot, lever)
  if (block?.name !== 'lever') {
    agents.log(`${bot.username} door: no lever at ${lever.x} ${lever.y} ${lever.z}`)
    return false
  }
  if (isOn(block) === on) return true
  try {
    await bot.activateBlock(block, new Vec3(0, 0, face), new Vec3(0.5, 0.5, 0.5))
  } catch (err) {
    agents.log(`${bot.username} door: lever failed, ${err.message}`)
    return false
  }
  return until(() => isOn(blockOf(bot, lever)) === on, waits.open, waits.poll, token)
}

// Turns on the lever and waits for the door. On with the door shut means it is out of step, so it goes off first
async function openWith (ctx, door, lever, face, token, waits) {
  const { bot } = ctx
  if (isOn(blockOf(bot, lever)) && !await setLever(ctx, lever, face, false, token, waits)) return false
  if (!await setLever(ctx, lever, face, true, token, waits)) return false
  return until(() => isOpen(blockOf(bot, door.lower)), waits.open, waits.poll, token)
}

// One try at shutting the door behind it, from where it landed. It never holds up the task
async function closeBehind (ctx, door, lever, face, token, waits) {
  const { bot, agents } = ctx
  const p = bot.entity.position
  const far = Math.hypot(p.x - lever.x - 0.5, p.y + EYES - lever.y - 0.5, p.z - lever.z - 0.5) > REACH
  const off = !far && await setLever(ctx, lever, face, false, token, waits)
  const shut = off && await until(() => !isOpen(blockOf(bot, door.lower)), waits.open, waits.poll, token)
  if (!shut) agents.log(`${bot.username} door: left open behind it, carrying on`)
}

// Takes the agent to side `to` ('in' or 'out'). 'done', 'shut' after a few tries, or 'cancelled'
// Caught standing in the frame: it is put on the far side instead of waiting there
async function leaveDoorway (ctx, door, far) {
  const { bot, agents } = ctx
  const p = bot.entity?.position
  if (!p || !agents.rcon) return false
  if (Math.floor(p.x) !== door.lower.x || Math.floor(p.z) !== door.lower.z || Math.floor(p.y) !== door.lower.y) return false
  await agents.rcon.send(`tp ${bot.username} ${far.x + 0.5} ${far.y} ${far.z + 0.5}`)
  agents.log(`${bot.username} door: moved on out of the door frame`)
  return true
}

async function passDoor (ctx, stage, to, token, { tries = TRIES, waits = WAITS, walk = walkTo } = {}) {
  const { bot, agents } = ctx
  const door = scene.baseLayout(stage).door
  const leaving = to === 'out'
  const [stand, far] = leaving ? [door.inside, door.outside] : [door.outside, door.inside]
  const lever = leaving ? door.insideLever : door.outsideLever
  const face = leaving ? -1 : 1
  const arrived = () => sideOf(stage, bot.entity.position) === to
  let mine = false    // this agent turned its lever on, so it is the one to turn it off
  const through = async () => {
    if (mine) await closeBehind(ctx, door, lever, face, token, waits)
    return 'done'
  }

  for (let i = 0; i < tries; i++) {
    if (token.cancelled) return 'cancelled'
    if (arrived()) return through()
    try { bot.pathfinder?.setGoal?.(null) } catch {}
    const ready = await toStand(ctx, stand, token, { waits, walk })
    if (token.cancelled) return 'cancelled'
    if (arrived()) return through()
    if (!ready) {
      await sleep(waits.reset)
      continue
    }
    const lower = blockOf(bot, door.lower)
    const gap = !!lower && lower.name !== 'iron_door'    // a blast took it
    if (!gap && !isOpen(lower)) {
      const opened = await openWith(ctx, door, lever, face, token, waits)
      if (token.cancelled) return 'cancelled'
      mine = opened
      if (!opened) {
        agents.log(`${bot.username} door: still shut after flip ${i + 1}`)
        await setLever(ctx, lever, face, false, token, waits)
        await sleep(waits.reset)
        continue
      }
    }
    await walkLine(bot, middle(far), waits.cross, waits.poll, token)
    if (token.cancelled) return 'cancelled'
    if (arrived()) return through()
    if (await leaveDoorway(ctx, door, far)) {
      await sleep(waits.poll)
      if (arrived()) return through()
    }
    agents.log(`${bot.username} door: did not get through, try ${i + 1}`)
    await sleep(waits.reset)
  }
  if (arrived()) return through()
  if (mine) await setLever(ctx, lever, face, false, token, waits)    // still on the side it started, so the lever is at hand
  return 'shut'
}

// What mining, gathering or a path must never take: the door, its levers, the block they hang on, the floor under the door
function doorBlocks (stage) {
  const d = scene.baseLayout(stage).door
  return [d.lower, d.upper, d.insideLever, d.outsideLever, d.leverWall, { ...d.lower, y: d.lower.y - 1 }]
}

// Every path plan asks safeToBreak, whichever moves it uses. Only a bot with agentsKeepBlock is affected
const safeToBreak = Movements.prototype.safeToBreak
Movements.prototype.safeToBreak = function (block) {
  return !this.bot?.agentsKeepBlock?.(block?.position) && safeToBreak.call(this, block)
}

// Guards both ways a block gets dug: the path planner, and the skills' direct bot.dig
function keepDoorWhole (bot, stageOf) {
  bot.agentsKeepBlock = pos => {
    const stage = stageOf()
    return !!stage && !!pos && doorBlocks(stage).some(p => p.x === pos.x && p.y === pos.y && p.z === pos.z)
  }
  const wrap = () => {
    if (!bot.dig || bot.dig.keepsDoor) return
    const dig = bot.dig
    bot.dig = function (block, ...rest) {
      if (bot.agentsKeepBlock(block?.position)) return Promise.reject(new Error('that block is part of the door'))
      return dig.call(this, block, ...rest)
    }
    bot.dig.keepsDoor = true
  }
  wrap()
  bot.once?.('spawn', wrap)    // mineflayer may add dig after this runs
}

// Run before a walk: a goal on the other side of the wall means going through the door first. stageOf gives null when
// the door is none of the walk's business, which is any time outside a task
function doorGate (ctx, stageOf, opts = {}) {
  let busy = false
  let restUntil = 0
  return async (goal, token) => {
    const stage = stageOf()
    if (!stage || busy || !Number.isFinite(goal?.x) || !Number.isFinite(goal?.z) || Date.now() < restUntil) return
    const floor = scene.baseLayout(stage).center.y
    const want = sideOf(stage, { x: goal.x + 0.5, y: goal.y ?? floor, z: goal.z + 0.5 })
    if (want === sideOf(stage, ctx.bot.entity.position)) return
    busy = true
    try {
      if (await passDoor(ctx, stage, want, token, opts) === 'shut') restUntil = Date.now() + REST_MS
    } catch (err) {
      ctx.agents.log(`${ctx.bot.username} door: ${err.message}`)
    } finally {
      busy = false
    }
  }
}

module.exports = { leaveDoorway, passDoor, sideOf, doorGate, doorBlocks, keepDoorWhole, WAITS, REACH }
