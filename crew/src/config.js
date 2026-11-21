'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_FILE = path.join(__dirname, '..', 'crew.config.json')
const DEFAULTS = {
  host: '127.0.0.1',
  port: 25565,
  version: '1.21.4',
  auth: 'offline',
  bots: ['CrewHelper1', 'CrewHelper2'],
  joinDelayMs: 5000
}
const USERNAME = /^[A-Za-z0-9_]{3,16}$/
const AUTH_MODES = new Set(['offline', 'microsoft'])

function readFile (file, required) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`Config file not found: ${file}`)
    return {}
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`Config file is not valid JSON: ${file}: ${err.message}`)
  }
}

function readEnv (env) {
  const out = {}
  if (env.CREW_OWNER) out.owner = env.CREW_OWNER
  if (env.CREW_HOST) out.host = env.CREW_HOST
  if (env.CREW_PORT) out.port = Number(env.CREW_PORT)
  if (env.CREW_VERSION) out.version = env.CREW_VERSION
  if (env.CREW_AUTH) out.auth = env.CREW_AUTH
  if (env.CREW_BOTS) out.bots = env.CREW_BOTS.split(',').map(name => name.trim()).filter(Boolean)
  if (env.CREW_JOIN_DELAY_MS) out.joinDelayMs = Number(env.CREW_JOIN_DELAY_MS)
  return out
}

function validate (config) {
  if (!config.owner) throw new Error('Set the owner name with CREW_OWNER or in crew.config.json.')
  if (!USERNAME.test(config.owner)) throw new Error(`Owner name is not a valid Minecraft name: ${config.owner}`)
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Port must be a whole number from 1 to 65535: ${config.port}`)
  }
  if (!AUTH_MODES.has(config.auth)) throw new Error(`Auth must be offline or microsoft: ${config.auth}`)
  if (typeof config.version !== 'string' || !/^1\.21(\.\d+)?$/.test(config.version)) {
    throw new Error(`Version must be a Minecraft 1.21 release: ${config.version}`)
  }
  if (!Number.isInteger(config.joinDelayMs) || config.joinDelayMs < 0) {
    throw new Error(`joinDelayMs must be a whole number of at least 0: ${config.joinDelayMs}`)
  }
  if (!Array.isArray(config.bots) || config.bots.length === 0) throw new Error('List at least one bot name.')

  const seen = new Set([config.owner.toLowerCase()])
  for (const name of config.bots) {
    if (typeof name !== 'string' || !USERNAME.test(name)) throw new Error(`Bot name is not a valid Minecraft name: ${name}`)
    const key = name.toLowerCase()
    if (seen.has(key)) throw new Error(`Bot name must be unique and differ from the owner: ${name}`)
    seen.add(key)
  }
  return config
}

// Values come from the defaults, then the config file, then the environment.
function loadConfig ({ env = process.env, file } = {}) {
  const chosen = file ?? env.CREW_CONFIG
  const fromFile = readFile(chosen ?? DEFAULT_FILE, Boolean(chosen))
  return validate({ ...DEFAULTS, ...fromFile, ...readEnv(env) })
}

module.exports = { loadConfig, validate, DEFAULTS }
