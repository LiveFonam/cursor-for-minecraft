'use strict'

const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { plugin: pvp } = require('mineflayer-pvp')
const { plugin: collectBlock } = require('mineflayer-collectblock')
const { createMovements } = require('./skills/move')
const { configureFight } = require('./combat/fight')
const { createModes } = require('./modes')
const { attachCommands } = require('./commands')

const MAX_DEATHS_PER_JOB = 3
const CHAT_GAP_MS = 1200
const CHAT_QUEUE = 5

// Sends chat at a pace servers accept, and drops the oldest line when backed up.
function createSay (bot, { gapMs = CHAT_GAP_MS, maxQueue = CHAT_QUEUE } = {}) {
  const queue = []
  let timer = null
  const pump = () => {
    const line = queue.shift()
    if (line === undefined) {
      timer = null
      return
    }
    try {
      bot.chat(line)
    } catch {
      // The connection is closing, so the line is dropped.
    }
    timer = setTimeout(pump, gapMs)
    timer.unref?.()
  }
  return text => {
    // A reply must never run as a server command.
    const line = String(text).replace(/\s+/g, ' ').trim().replace(/^\/+/, '')
    if (!line) return
    queue.push(line)
    if (queue.length > maxQueue) queue.shift()
    if (!timer) pump()
  }
}

function createContext (bot, config, log) {
  const movements = createMovements(bot)
  const ctx = {
    bot,
    config,
    log,
    movements,
    say: createSay(bot),
    state: { job: null, fightName: null, retreating: false, lastHurtAt: null, jobDeaths: 0, deathJob: null }
  }
  ctx.modes = createModes(ctx)
  ctx.modes.on('modeError', (name, err) => log(`${name}: ${err.message}`))
  ctx.modes.on('switch', name => log(`mode ${name}`))
  return ctx
}

function onDeath (ctx) {
  const { state } = ctx
  state.fightName = null
  state.retreating = false
  if (state.job && state.deathJob === state.job) state.jobDeaths++
  else if (state.job) {
    state.deathJob = state.job
    state.jobDeaths = 1
  }
  if (state.job && state.jobDeaths >= MAX_DEATHS_PER_JOB) {
    ctx.say(`Dropping ${state.job.name} after ${state.jobDeaths} deaths.`)
    state.job = null
  }
  ctx.modes.pause()
}

function wireHelper (bot, config, log) {
  const ctx = createContext(bot, config, log)
  configureFight(bot, ctx.movements.safe)
  attachCommands(ctx)
  bot.on('entityHurt', entity => {
    if (entity === bot.entity) ctx.state.lastHurtAt = Date.now()
  })
  bot.on('death', () => onDeath(ctx))
  bot.on('spawn', () => ctx.modes.resume())
  bot.on('end', () => ctx.modes.stop())
  ctx.modes.start()
  return ctx
}

function createHelper (config, username, { createBot = mineflayer.createBot, logger = console.log } = {}) {
  const log = message => logger(`[${username}] ${message}`)
  const bot = createBot({
    host: config.host,
    port: config.port,
    username,
    version: config.version,
    auth: config.auth
  })
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(pvp)
  bot.loadPlugin(collectBlock)
  bot.once('spawn', () => {
    wireHelper(bot, config, log)
    log('joined')
  })
  bot.on('kicked', reason => log(`kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
  bot.on('error', err => log(`error: ${err.message}`))
  bot.on('end', reason => log(`left: ${reason}`))
  return bot
}

// Joins the bots one at a time, because servers throttle fast reconnects.
async function startCrew (config, options = {}) {
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const bots = []
  for (const [index, name] of config.bots.entries()) {
    if (index > 0) await wait(config.joinDelayMs)
    bots.push(createHelper(config, name, options))
  }
  return bots
}

module.exports = { createHelper, startCrew, createSay, wireHelper, onDeath }
