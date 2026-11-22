// The agents' settings. Values come from the defaults below, then agents.config.json (or the file named by AGENTS_CONFIG),
// then the AGENTS_ environment variables. Everything is checked before a bot starts.
//
//   AGENTS_CONFIG            path of the config file (it must exist when set)
//   AGENTS_OWNER             the player who commands the agents
//   AGENTS_BOTS              bot names, comma separated
//   AGENTS_FRIENDS           friend names, comma separated (an empty value clears the list)
//   AGENTS_HOST              server address
//   AGENTS_PORT              server port
//   AGENTS_RCON_PORT         remote console port
//   AGENTS_SERVER_MEMORY     server heap for the live tests, for example 1G
//   AGENTS_HUMAN             off, light or full
//   AGENTS_KILL_RADIUS       default radius of !kill
//   AGENTS_GUARD_RADIUS      default radius of !guard
//   AGENTS_FIGHTER_RUN       folder of the fighting network
//   AGENTS_TRANSLATOR_MODEL  model of the plain words translator

const fs = require('fs')
const path = require('path')

const DEFAULT_FILE = path.join(__dirname, 'agents.config.json')
const VERSION = '1.21.11'
const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 25566,
  rcon_port: 25576,
  version: VERSION,
  server_memory: '1G',
  owner: null,
  bots: Object.freeze(['Agent1', 'Agent2']),
  friends: Object.freeze([]),
  human: 'light',
  kill_radius: 50,
  guard_radius: 16,
  fighter_run: 'weights/fighter',
  translator_model: 'claude-haiku-5-5'
})
const USERNAME = /^[A-Za-z0-9_]{3,16}$/
const MEMORY = /^[1-9]\d*[MG]$/
const HUMAN_LEVELS = new Set(['off', 'light', 'full'])

const nameList = text => text.split(',').map(name => name.trim()).filter(Boolean)

function readFile (file, required) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`Config file not found: ${file}`)
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`Config file is not valid JSON: ${file}: ${err.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file must hold one JSON object: ${file}`)
  }
  for (const key of Object.keys(parsed)) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown setting in ${file}: ${key}`)
  }
  return parsed
}

function readEnv (env) {
  const out = {}
  const text = { AGENTS_OWNER: 'owner', AGENTS_HOST: 'host', AGENTS_SERVER_MEMORY: 'server_memory', AGENTS_HUMAN: 'human', AGENTS_FIGHTER_RUN: 'fighter_run', AGENTS_TRANSLATOR_MODEL: 'translator_model' }
  const numbers = { AGENTS_PORT: 'port', AGENTS_RCON_PORT: 'rcon_port', AGENTS_KILL_RADIUS: 'kill_radius', AGENTS_GUARD_RADIUS: 'guard_radius' }
  for (const [name, key] of Object.entries(text)) if (env[name]) out[key] = env[name].trim()
  for (const [name, key] of Object.entries(numbers)) if (env[name]) out[key] = Number(env[name])
  if (env.AGENTS_BOTS) out.bots = nameList(env.AGENTS_BOTS)
  if (env.AGENTS_FRIENDS !== undefined) out.friends = nameList(env.AGENTS_FRIENDS)
  return out
}

function checkPort (label, value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be a whole number from 1 to 65535: ${value}`)
  }
}

function checkRadius (label, value) {
  if (!Number.isFinite(value) || value <= 0 || value > 256) {
    throw new Error(`${label} must be a number above 0 and at most 256: ${value}`)
  }
}

function checkName (label, name) {
  if (typeof name !== 'string' || !USERNAME.test(name)) throw new Error(`${label} is not a valid Minecraft name: ${name}`)
}

function requireOwner (owner) {
  if (!owner) throw new Error('Set the owner name with AGENTS_OWNER or in bridge/danger_sensing_agents/agents.config.json (see agents.config.example.json).')
  checkName('Owner name', owner)
  return owner
}

function validate (config, { ownerRequired = true } = {}) {
  if (ownerRequired) requireOwner(config.owner)
  else if (config.owner !== null && config.owner !== undefined) checkName('Owner name', config.owner)
  if (typeof config.host !== 'string' || !config.host) throw new Error(`Host must be a server address: ${config.host}`)
  checkPort('Port', config.port)
  checkPort('RCON port', config.rcon_port)
  if (config.port === config.rcon_port) throw new Error(`Port and RCON port must differ: ${config.port}`)
  if (config.version !== VERSION) throw new Error(`Version must be ${VERSION}, the game the agents' recipes come from: ${config.version}`)
  if (typeof config.server_memory !== 'string' || !MEMORY.test(config.server_memory)) {
    throw new Error(`server_memory must look like 1G or 800M: ${config.server_memory}`)
  }
  if (!HUMAN_LEVELS.has(config.human)) throw new Error(`human must be off, light or full: ${config.human}`)
  checkRadius('kill_radius', config.kill_radius)
  checkRadius('guard_radius', config.guard_radius)
  for (const key of ['fighter_run', 'translator_model']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`${key} must be a non-empty text: ${config[key]}`)
  }
  if (!Array.isArray(config.bots) || config.bots.length === 0) throw new Error('List at least one bot name.')
  if (!Array.isArray(config.friends)) throw new Error('friends must be a list of names.')

  const seen = new Set(config.owner ? [config.owner.toLowerCase()] : [])
  for (const name of config.bots) {
    checkName('Bot name', name)
    const key = name.toLowerCase()
    if (seen.has(key)) throw new Error(`Bot name must be unique and differ from the owner: ${name}`)
    seen.add(key)
  }
  for (const name of config.friends) checkName('Friend name', name)
  return config
}

// ownerRequired false: for a run that names its owner another way (agents.js --owner, the live tests)
function loadConfig ({ env = process.env, file, ownerRequired = true } = {}) {
  const chosen = file ?? env.AGENTS_CONFIG
  const fromFile = readFile(chosen ?? DEFAULT_FILE, Boolean(chosen))
  const merged = { ...DEFAULTS, ...fromFile, ...readEnv(env) }
  merged.bots = Array.isArray(merged.bots) ? [...merged.bots] : merged.bots
  merged.friends = Array.isArray(merged.friends) ? [...merged.friends] : merged.friends
  return validate(merged, { ownerRequired })
}

module.exports = { loadConfig, validate, requireOwner, DEFAULTS }
