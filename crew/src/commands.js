'use strict'

const jobs = require('./jobs')
const { resolveMineTarget } = require('./skills/mine')
const { loadBlueprint, listBlueprints } = require('./skills/blueprint')
const { findNamedTarget } = require('./combat/targets')

const HELP = 'Commands: come, follow, mine <block> [n], gather <block> [n], craft <item> [n], build <name>, farm, guard, fight <name>, status, stop'
const MAX_COUNT = 256
const DEFAULT_GATHER = 8
const BUILD_OFFSET = 2

// Reads a chat line. Returns null when it is not addressed to this bot.
function parseCommand (text, botName) {
  if (typeof text !== 'string') return null
  const words = text.trim().split(/\s+/)
  const address = words[0]?.toLowerCase()
  if (address !== '@crew' && address !== `@${botName.toLowerCase()}`) return null
  const [verb = 'help', ...args] = words.slice(1)
  return { verb: verb.toLowerCase(), args }
}

function parseCount (raw, fallback) {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) return null
  const count = Number(raw)
  return count >= 1 && count <= MAX_COUNT ? count : null
}

// True only for a chat packet the server attributes to the owner's UUID.
function isFromOwner (bot, owner, senderUuid) {
  const uuid = bot.players?.[owner]?.uuid
  return Boolean(senderUuid && uuid && senderUuid === uuid)
}

function setJob (ctx, job) {
  ctx.state.job = job
  ctx.modes.interrupt('job')
}

function anchorPosition (ctx) {
  const owner = jobs.ownerEntity(ctx)
  return (owner ?? ctx.bot.entity).position.floored()
}

function startCollect (ctx, verb, args, makeJob) {
  const [name, rawCount] = args
  if (!name) return ctx.say(`Usage: ${verb} <block> [count]`)
  const count = parseCount(rawCount, DEFAULT_GATHER)
  if (count === null) return ctx.say(`Count must be from 1 to ${MAX_COUNT}.`)
  const target = resolveMineTarget(ctx.bot.registry, name)
  if (!target) return ctx.say(`I do not know how to ${verb} that.`)
  setJob(ctx, makeJob(ctx, target, count))
  ctx.say(`On it: ${verb} ${count} ${target.name}.`)
}

function startCraft (ctx, args) {
  const [rawName, rawCount] = args
  if (!rawName) return ctx.say('Usage: craft <item> [count]')
  const name = rawName.toLowerCase().replace(/^minecraft:/, '')
  const count = parseCount(rawCount, 1)
  if (count === null) return ctx.say(`Count must be from 1 to ${MAX_COUNT}.`)
  const item = ctx.bot.registry.itemsByName[name]
  if (!item || !ctx.bot.registry.recipes[item.id]) return ctx.say('I do not know how to craft that.')
  setJob(ctx, jobs.craftJob(ctx, name, count))
  ctx.say(`On it: craft ${count} ${name}.`)
}

function startBuild (ctx, args) {
  const name = args[0]?.toLowerCase()
  if (!name) return ctx.say(`Usage: build <name>. I know: ${listBlueprints().join(', ')}`)
  let blueprint
  try {
    blueprint = loadBlueprint(name, ctx.bot.registry)
  } catch {
    return ctx.say(`I have no blueprint for that. I know: ${listBlueprints().join(', ')}`)
  }
  const origin = anchorPosition(ctx).offset(BUILD_OFFSET, 0, BUILD_OFFSET)
  setJob(ctx, jobs.buildJob(ctx, blueprint, origin))
  ctx.say(`On it: build ${blueprint.name}.`)
}

function startFight (ctx, args) {
  const name = args[0]
  if (!name) return ctx.say('Usage: fight <name>')
  const lowered = name.toLowerCase()
  const friends = [ctx.config.owner, ...ctx.config.bots].map(friend => friend.toLowerCase())
  if (friends.includes(lowered)) return ctx.say('I will not fight my own crew.')
  if (!findNamedTarget(ctx.bot, name)) return ctx.say('I cannot see that target.')
  ctx.state.fightName = name
  ctx.modes.interrupt('fight')
  ctx.say(`Fighting ${name}.`)
}

function stopAll (ctx) {
  ctx.state.job = null
  ctx.state.fightName = null
  ctx.state.retreating = false
  ctx.modes.interrupt('job')
  ctx.modes.interrupt('fight')
  ctx.bot.pathfinder?.setGoal(null)
  ctx.say('Stopped.')
}

function status (ctx) {
  const job = ctx.state.job?.name ?? 'none'
  const mode = ctx.modes.current ?? 'idle'
  ctx.say(`Mode ${mode}, job ${job}, health ${Math.round(ctx.bot.health)}, food ${ctx.bot.food}.`)
}

function runCommand (ctx, { verb, args }) {
  switch (verb) {
    case 'come': return requireOwnerVisible(ctx, () => { setJob(ctx, jobs.comeJob(ctx)); ctx.say('Coming.') })
    case 'follow': return requireOwnerVisible(ctx, () => { setJob(ctx, jobs.followJob(ctx)); ctx.say('Following you.') })
    case 'guard': setJob(ctx, jobs.guardJob(ctx, anchorPosition(ctx))); return ctx.say('Guarding this spot.')
    case 'farm': setJob(ctx, jobs.farmJob(ctx, anchorPosition(ctx))); return ctx.say('Farming wheat here.')
    case 'mine': return startCollect(ctx, 'mine', args, jobs.mineJob)
    case 'gather': return startCollect(ctx, 'gather', args, jobs.gatherJob)
    case 'craft': return startCraft(ctx, args)
    case 'build': return startBuild(ctx, args)
    case 'fight': return startFight(ctx, args)
    case 'status': return status(ctx)
    case 'stop': return stopAll(ctx)
    case 'help': return ctx.say(HELP)
    default: return ctx.say(`Unknown command. ${HELP}`)
  }
}

function requireOwnerVisible (ctx, start) {
  if (!jobs.ownerEntity(ctx)) return ctx.say('I cannot see you. Come closer.')
  start()
}

// Handles one player chat packet. The sender comes from the packet itself,
// never from the message text, so a typed name cannot pass as the owner.
function handleChat (ctx, packet) {
  if (!isFromOwner(ctx.bot, ctx.config.owner, packet?.sender)) return false
  const command = parseCommand(packet.plainMessage, ctx.bot.username)
  if (!command) return false
  try {
    runCommand(ctx, command)
  } catch (err) {
    ctx.log(`command failed: ${err.message}`)
    ctx.say('That command failed.')
  }
  return true
}

function attachCommands (ctx) {
  const listener = packet => handleChat(ctx, packet)
  ctx.bot._client.on('playerChat', listener)
  return () => ctx.bot._client.removeListener('playerChat', listener)
}

module.exports = { parseCommand, parseCount, isFromOwner, handleChat, attachCommands, runCommand, HELP }
