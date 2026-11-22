// Turns the owner's plain words ("@agents make me a diamond pickaxe") into one small request through the Claude API. The
// model only understands the words: it names a goal or one command, asks when the words are too vague, or says what the
// bots cannot do. It never plans. goal_plan.js works out every step, and every answer goes through the same parser as
// typed commands, so anything that does not parse is dropped.
//
// The key comes from ANTHROPIC_API_KEY in the environment, else from a git-ignored .env in the repository root or
// bridge/. It is never printed or logged.

const fs = require('fs')
const path = require('path')
const { default: Anthropic, APIError, APIConnectionTimeoutError } = require('@anthropic-ai/sdk')
const { COMMANDS, parseMessage } = require('./commands')

const ENV_FILES = [path.join(__dirname, '..', '..', '.env'), path.join(__dirname, '..', '.env')]
const TIMEOUT_MS = 20000
// These reach the bots as a goal, so the planner decides the steps
const GOAL_COMMANDS = new Set(['get', 'craft', 'gather'])

function keyFromEnvFile (file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  for (const raw of text.split('\n')) {
    const k = raw.trim().match(/^(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s]+)/)
    if (k) return k[1]
  }
  return null
}

function loadCredentials (files = ENV_FILES, env = process.env) {
  const key = env.ANTHROPIC_API_KEY || files.map(keyFromEnvFile).find(Boolean)
  return key ? { key } : null
}

// One client per job. SDK logging stays off so a debug setting can never print a request
function makeClient (credentials, timeout) {
  return new Anthropic({ apiKey: credentials.key, authToken: null, timeout, maxRetries: 0, logLevel: 'off' })
}

// A short error line for chat and logs, with the key removed if a message ever carries it
function apiErrorText (err, credentials) {
  let text
  if (err instanceof APIConnectionTimeoutError) text = 'API request failed: timed out'
  else if (err instanceof APIError && err.status) text = `API error ${err.status}: ${err.error?.error?.message || 'unknown'}`
  else text = `API request failed: ${err.message}`
  return credentials?.key ? text.split(credentials.key).join('[key]') : text
}

// Every model call in this process, so the spending shows in the log. Only counts, never the key or the words
const usageTotals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function noteUsage (log, usage, label = 'model') {
  const input = usage?.input_tokens || 0
  const output = usage?.output_tokens || 0
  const cacheRead = usage?.cache_read_input_tokens || 0
  const cacheWrite = usage?.cache_creation_input_tokens || 0
  const t = usageTotals
  t.calls++
  t.input += input
  t.output += output
  t.cacheRead += cacheRead
  t.cacheWrite += cacheWrite
  const cache = (read, write) => read || write ? `, cache read ${read}, cache write ${write}` : ''
  log(`${label} tokens: in ${input}, out ${output}${cache(cacheRead, cacheWrite)} | total ${t.calls} calls, in ${t.input}, out ${t.output}${cache(t.cacheRead, t.cacheWrite)}`)
  return { ...t }
}

function systemPrompt (botNames, blueprints = []) {
  return [
    'You read one chat message from a Minecraft player to their helper bots and say what the player wants. You never plan steps or work out materials, a script does that.',
    `Bots: ${botNames.join(', ')}.`,
    'Reply with exactly one JSON object and nothing else, in one of these four forms:',
    '{"goal": {"item": "<item>", "count": <number or null>}}  the player wants an item made or brought to them',
    '{"command": "<one command>"}  the player wants one of the actions listed below',
    '{"vague": "<one short question>"}  you cannot tell which item or action they mean: ask the one question that settles it',
    '{"impossible": "<short reason>"}  it needs something no bot can do: name that part and why',
    'Goal items: wooden_pickaxe, stone_pickaxe, iron_pickaxe, diamond_pickaxe, furnace, crafting_table, wood (any logs), cobblestone, iron (raw iron or iron ore), diamond, coal. For any other item use its Minecraft item id, for example bread or iron_ingot, and the script checks whether it can be had.',
    'count is the number the player said, null when they said none ("some", "a few").',
    'One message is one request. When it asks for an item and to bring it back, that is just the goal, handing it over is part of every goal. When it asks for two different things, reply vague and ask which comes first.',
    'Actions for "command", exactly this syntax:',
    ...Object.entries(COMMANDS).filter(([name]) => !GOAL_COMMANDS.has(name)).map(([, text]) => text),
    ...(blueprints.length ? [
      'Blueprints the agents can build, use these names with !build and !expand:',
      ...blueprints.map(b => `  ${b.name}: ${b.description || ''}`),
      '"here" means where the player stands. A house, hut or shelter is small_hut, a farm or wheat field is !farm wheat here, a bigger farm or longer wall is !expand.',
      'Only for a structure this list does not have: "!design <new_name> <the player\'s description in a few words>". The script builds it afterwards. Never !design something the list has.'
    ] : []),
    'Impossible means an action no command covers: going to the Nether or the End, trading, enchanting, brewing, fishing, sleeping.',
    'Vague means no clear item or action, for example "help me", "do something", "get me stuff".',
    'A question about the bots themselves is a command, not vague: health, food, where they are or how they are doing is !status, what they are working on is !doing, the steps left is !plan, dangers nearby is !danger.',
    'Examples:',
    '"how much food do you have" {"command": "!status"}',
    '"what are you doing" {"command": "!doing"}',
    '"bring me 5 logs" {"goal": {"item": "wood", "count": 5}}',
    '"I need an iron pick" {"goal": {"item": "iron_pickaxe", "count": 1}}',
    '"stay close to me" {"command": "!follow"}',
    '"put up a small house here" {"command": "!build small_hut here"}',
    '"go on" {"vague": "What should I do?"}',
    '"enchant my sword" {"impossible": "I can\'t enchant items"}'
  ].join('\n')
}

class Translator {
  constructor ({ model, botNames, log = () => {}, credentials, blueprints = () => [] } = {}) {
    this.model = model || 'claude-haiku-5-5'
    this.botNames = botNames
    this.log = log
    this.blueprints = blueprints
    this.creds = credentials === undefined ? loadCredentials() : credentials
    this.client = this.creds ? makeClient(this.creds, TIMEOUT_MS) : null
  }

  get enabled () { return !!this.creds }

  // Returns { lines, parsed: [{ targets, command }], dropped, impossible, vague, error? }. A goal comes back as one
  // !get command. vague and impossible are the two refusals, and each comes with nothing to run
  async translate (text, targets = 'all') {
    if (!this.enabled) return { lines: [], parsed: [], error: 'the translator is off (no ANTHROPIC_API_KEY in the environment or .env)' }
    const who = targets === 'all' ? 'all the agents' : targets.join(', ')
    let reply
    try {
      reply = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        output_config: { effort: 'low' },
        system: systemPrompt(this.botNames, this.blueprints()),
        messages: [{ role: 'user', content: `Message to ${who}: ${text}` }]
      })
    } catch (err) {
      return { lines: [], parsed: [], error: apiErrorText(err, this.creds) }
    }
    noteUsage(this.log, reply.usage, `translator ${this.model}`)
    if (reply.stop_reason === 'refusal') return { lines: [], parsed: [], dropped: [], vague: null, impossible: 'I was not allowed to do that' }
    const out = (reply.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    return this.check(out, targets)
  }

  // Reads the model's one request. A goal becomes a !get line, and every line goes through the normal parser
  check (out, targets = 'all') {
    const none = { lines: [], parsed: [], dropped: [], impossible: null, vague: null }
    let data
    try {
      data = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
    } catch {
      return { ...none, error: 'the translator did not answer in JSON' }
    }
    if (typeof data.vague === 'string' && data.vague.trim()) return { ...none, vague: data.vague.trim() }
    const no = data.impossible || data.reject
    if (no) return { ...none, impossible: String(no) }

    let line
    if (data.goal && typeof data.goal === 'object') {
      const count = Number.isInteger(data.goal.count) && data.goal.count > 0 ? ` ${data.goal.count}` : ''
      line = `!get ${String(data.goal.item || '').trim()}${count}`
    } else if (typeof data.command === 'string') {
      line = data.command.trim()
    } else {
      return { ...none, error: 'the translator did not answer with one request' }
    }

    const p = line.startsWith('!') ? parseMessage(line, this.botNames) : null
    if (!p || p.type !== 'command') {
      this.log(`translator: no such command ${line}`)
      return { ...none, dropped: [line] }
    }
    // a request to one bot stays with that bot (a line for another bot is left out)
    if (targets !== 'all' && p.targets === 'all') p.targets = targets
    if (targets !== 'all' && !targets.includes(p.targets[0])) {
      this.log(`translator: left out ${line}, not for ${targets.join(', ')}`)
      return none
    }
    // the model named a skill instead of a goal: the planner still decides the steps
    if (p.command.name === 'craft') p.command = { name: 'get', args: { item: p.command.args.item, count: 1 } }
    if (p.command.name === 'gather') p.command = { name: 'get', args: { item: p.command.args.kind, count: p.command.args.count } }
    const parsed = [{ targets: p.targets, command: p.command }]
    const lines = [line]
    // a new blueprint is drawn and then built where the owner stands
    if (p.command.name === 'design') {
      const build = `!build ${p.command.args.blueprint} here`
      lines.push(build)
      parsed.push({ targets: p.targets, command: parseMessage(build, this.botNames).command })
    }
    return { ...none, lines, parsed }
  }
}

module.exports = { Translator, loadCredentials, makeClient, apiErrorText, noteUsage, systemPrompt }
