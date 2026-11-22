// New blueprints from the owner's words or a guide, drawn by Claude Sonnet 5.5 only when the owner asks for something the library
// does not have (the translator sends !design for that). Every answer goes through the same checker as the library
// (skills/blueprint.js checkBlueprint): 1.21.11 block names and states, at most 16 by 12 by 16, blocks the builder
// can place, and the material count. A blueprint that fails gets one more try with the checker's errors.
//
// Uses the same API key and client setup as translator.js. The key is never printed or logged.

const { loadCredentials, makeClient, apiErrorText } = require('./translator')
const bp = require('./skills/blueprint')
const registry = require('prismarine-registry')('1.21.11')

const TIMEOUT_MS = 180000
const TRIES = 2

function systemPrompt () {
  const example = bp.loadBlueprint('small_hut')
  return [
    'You draw Minecraft Java 1.21.11 building blueprints for a helper bot that builds them block by block in survival.',
    'Reply with one JSON object only, no prose, no code fence.',
    'Format:',
    '  name: the name you are given. description: one short line.',
    '  size: [x, y, z] = width (west to east), height, depth (north to south). At most 16 by 12 by 16, keep it small.',
    '  origin: [x, 0, z], the cell that sits on the block under the owner\'s feet. Put it one block outside the front, on the ground layer, so the build stands in front of the owner.',
    '  facing: the side the front (door or entrance) is on: north (row 0), east, south or west.',
    '  palette: one character to a block, "P": "oak_planks" or "D": {"name": "oak_door", "state": {"facing": "south", "half": "lower"}}. "." is air the bot clears, " " leaves the ground as it is.',
    '  layers: bottom up, layer 0 is the ground layer (it replaces grass), each layer a list of rows from north (z = 0) to south, each row a string from west (x = 0) to east.',
    'Blocks the bot can place: full blocks (planks, logs with "axis", cobblestone, stone bricks, glass, wool, dirt), slabs ("type" top or bottom), stairs ("facing", "half"), wooden doors (lower half with "facing" the way a person walking in looks, the upper half as a second symbol with "half": "upper" right above it), beds (the "part": "foot" cell with "facing" toward the head, the head cell next to it), torch on the floor, wall_torch with "facing" pointing away from its wall, chest and furnace ("facing" toward the front of the block), fences, walls and glass panes (no state, they connect by themselves), fence gates, ladders ("facing" away from the wall), lanterns, carpets, crafting_table, farmland, crops (wheat, carrots, potatoes on farmland), water (a source), saplings on dirt.',
    'Not allowed: redstone, signs, banners, buttons, levers, trapdoors, iron doors, anything that needs an item the bot cannot craft or carry, floating blocks with nothing under or beside them.',
    'Prefer cheap survival materials: oak logs and planks, cobblestone, oak slabs, torches. Every block must be supported, doors need floor under them, torches need a wall or floor.',
    'Example (small_hut):',
    JSON.stringify(example)
  ].join('\n')
}

class Designer {
  constructor ({ model = 'claude-sonnet-5-5', log = () => {}, credentials } = {}) {
    this.model = model
    this.log = log
    this.creds = credentials === undefined ? loadCredentials() : credentials
    this.client = this.creds ? makeClient(this.creds, TIMEOUT_MS) : null
  }

  get enabled () { return !!this.creds }

  call (messages) {
    return this.client.messages.create({
      model: this.model,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      system: systemPrompt(),
      messages
    })
  }

  // Returns { blueprint, check, attempts } or { error }
  async design (name, words, { guide = '' } = {}) {
    if (!this.enabled) return { error: 'no ANTHROPIC_API_KEY in the environment or .env' }
    const ask = `Name: ${name}\nWhat the owner asked for: ${words}${guide ? `\nGuide to follow:\n${guide.slice(0, 20000)}` : ''}`
    const messages = [{ role: 'user', content: ask }]
    let lastErrors = []
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      let reply
      try {
        reply = await this.call(messages)
      } catch (err) {
        return { error: apiErrorText(err, this.creds) }
      }
      if (reply.stop_reason === 'refusal') return { error: 'the model declined' }
      const text = (reply.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
      const r = this.check(text, name)
      if (r.blueprint) return { ...r, attempts: attempt }
      lastErrors = r.errors
      this.log(`designer: try ${attempt} for ${name} failed: ${r.errors.join(' | ').slice(0, 300)}`)
      // the whole reply goes back unchanged, then the checker's list
      messages.push({ role: 'assistant', content: reply.content })
      messages.push({ role: 'user', content: `The checker refused it: ${r.errors.join('. ')}. Send the corrected JSON only.` })
    }
    return { error: lastErrors.slice(0, 3).join(', ') || 'no usable blueprint' }
  }

  // Parses the model's JSON and runs the checker. Returns { blueprint, check } or { errors }
  check (text, name) {
    let data
    try {
      data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    } catch {
      return { errors: ['the answer was not JSON'] }
    }
    data.name = name
    data.source = data.source || 'drawn by Claude Sonnet 5.5 from the owner\'s words'
    const check = bp.checkBlueprint(data, registry)
    if (!check.ok) return { errors: check.errors }
    return { blueprint: data, check }
  }
}

module.exports = { Designer, systemPrompt }
