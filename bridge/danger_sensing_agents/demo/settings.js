// The live demo's settings, from the environment on top of the agents' config. Nothing about a person lives in source:
//
//   DEMO_PLAYER          the one player who may drive the demo (falls back to the agents' owner)
//   DEMO_AGENT           the agent in the scene (falls back to the first configured bot)
//   DEMO_FIGHTER_NAME    the login of the 1v1 fighter (default Fighter)
//   DEMO_FIGHTER_RUN     the fighter network to load for the 1v1 (falls back to AGENTS_FIGHTER_RUN)
//   DEMO_AGENT_RUN       the network the agent fights mobs with (falls back to DEMO_FIGHTER_RUN, then the agents' config)
//   DEMO_FIGHTER_CLIENT  the fighter client file (default bridge/fighter.js)
//   DEMO_POLICY          the policy loader file (default agents_policy.py)
//   DEMO_PYTHON          the Python that runs the policy loader
//   DEMO_STAGE           x,y,z of the scene, feet level (default: where the agent stands when the demo starts)
//   DEMO_METRICS         the demo's job log. Every death goes to deaths.jsonl beside it (default runs/demo/metrics.jsonl)
//   DEMO_FIGHT_SECONDS   longest 1v1 (default 180)
//   DEMO_CUE_MOB         seconds into a task before a mob is sent at the agent, 0 for never (default 60)
//   DEMO_CUE_ANIMAL      seconds into a task before an animal appears by the agent, 0 for never (default 120)

const path = require('path')
const { loadConfig } = require('../config')

const USERNAME = /^[A-Za-z0-9_]{3,16}$/
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..')

// Every limit of the always-on evil mode
const EVIL_LIMITS = Object.freeze({
  maxAlive: 8,          // evil mobs alive at once, never more
  startZombies: 3,      // zombies in the first waves, one more every second wave
  maxZombies: 6,        // zombies in the biggest wave
  waveGapMs: 15000,     // the pause after a wave is cleared
  waveMaxMs: 75000,     // a wave still alive after this is topped up to the cap
  graceMs: 8000,        // after a respawn, before the hunt goes on
  pollMs: 2500,         // how often the hunt looks at the world
  modelPerMinute: 4,    // model calls in any one minute
  modelPerHour: 40,     // model calls in any one hour
  modelPerRun: 150      // model calls until the demo is restarted
})

function checkName (label, name) {
  if (!USERNAME.test(String(name))) throw new Error(`${label} must be a Minecraft name, got "${name}"`)
  return name
}

function wholeNumber (env, key, fallback) {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a whole number of seconds`)
  return Number(raw)
}

function parseStage (text) {
  if (!text) return null
  const parts = String(text).split(',').map(s => s.trim())
  if (parts.length !== 3 || parts.some(p => !/^-?\d+$/.test(p))) throw new Error('DEMO_STAGE must be x,y,z in whole blocks')
  const [x, y, z] = parts.map(Number)
  return { x, y, z }
}

function loadSettings (env = process.env, config = loadConfig({ env, ownerRequired: false })) {
  const player = env.DEMO_PLAYER || config.owner
  if (!player) throw new Error('Set DEMO_PLAYER to the player who drives the demo')
  if (!LOCAL_HOSTS.has(config.host)) throw new Error('The demo only runs against a server on this machine')
  const run = env.DEMO_FIGHTER_RUN || config.fighter_run
  const settings = {
    player: checkName('DEMO_PLAYER', player),
    agent: checkName('DEMO_AGENT', env.DEMO_AGENT || config.bots[0]),
    fighterName: checkName('DEMO_FIGHTER_NAME', env.DEMO_FIGHTER_NAME || 'Fighter'),
    fighterRun: path.resolve(SOURCE_ROOT, run),
    agentRun: path.resolve(SOURCE_ROOT, env.DEMO_AGENT_RUN || run),
    fighterClient: path.resolve(env.DEMO_FIGHTER_CLIENT || path.join(SOURCE_ROOT, 'bridge', 'fighter.js')),
    policyScript: path.resolve(env.DEMO_POLICY || path.join(SOURCE_ROOT, 'agents_policy.py')),
    python: env.DEMO_PYTHON || env.AGENTS_POLICY_PYTHON || 'python3',
    stage: parseStage(env.DEMO_STAGE),
    metrics: path.resolve(SOURCE_ROOT, env.DEMO_METRICS || path.join('runs', 'demo', 'metrics.jsonl')),
    fightSeconds: wholeNumber(env, 'DEMO_FIGHT_SECONDS', 180),
    cueMobSeconds: wholeNumber(env, 'DEMO_CUE_MOB', 60),
    cueAnimalSeconds: wholeNumber(env, 'DEMO_CUE_ANIMAL', 120),
    host: config.host,
    port: config.port,
    version: config.version,
    sourceRoot: SOURCE_ROOT
  }
  const names = [settings.player, settings.agent, settings.fighterName].map(n => n.toLowerCase())
  if (new Set(names).size !== names.length) throw new Error('The player, agent and fighter need three different names')
  return settings
}

// A folder of a trained network, as the policy loader reads it
function hasNetwork (run, exists = require('fs').existsSync) {
  return exists(path.join(run, 'fighter', 'policy.npz')) || exists(path.join(run, 'policy.npz'))
}

// The files a 1v1 needs, as a list of what is missing
function missingFighterFiles (settings, exists = require('fs').existsSync) {
  const dir = path.dirname(settings.fighterClient)
  const files = [settings.fighterClient, path.join(dir, 'fair_health.js'), path.join(dir, 'mineflayer_fixes.js'), settings.policyScript, settings.fighterRun]
  return files.filter(f => !exists(f))
}

module.exports = { EVIL_LIMITS, loadSettings, parseStage, missingFighterFiles, hasNetwork }
