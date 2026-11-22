// The demo's chat commands. Any other "!" line goes on to the agents, and plain words are a task for the agent.

const MOBS = Object.freeze(['zombie', 'skeleton', 'enderman', 'creeper'])
const ANIMALS = Object.freeze(['cow', 'pig', 'sheep', 'chicken'])

const HELP_LINES = Object.freeze([
  'Demo commands:',
  '!reset (or !start): clean scene, agent with shield, axe and 6 bread',
  '!1v1: fight the trained axe fighter in the arena',
  `!evil: build your base, then a creeper breaches it and 3 zombies invade`,
  `!mob [${MOBS.join('|')}]: send a mob at the agent`,
  `!animal [${ANIMALS.join('|')}]: put an animal by the agent`,
  '!stop: stop everything and come back',
  '!help: this list',
  'Or say a task in plain words: make me a diamond pickaxe'
])

function kindOf (word, kinds, command) {
  if (word === undefined) return { kind: kinds[0] }
  if (kinds.includes(word)) return { kind: word }
  return { error: `!${command} takes one of: ${kinds.join(', ')}` }
}

// null when the line is not one of the demo's commands
function parseDemoCommand (text) {
  const line = String(text ?? '').trim()
  if (!line.startsWith('!')) return null
  const [word, arg, extra] = line.slice(1).trim().toLowerCase().split(/\s+/)
  const noArgs = name => (arg === undefined ? { name } : { error: `!${word} takes no options` })
  switch (word) {
    case 'start':
    case 'reset': return noArgs('reset')
    case '1v1': return noArgs('duel')
    case 'evil': return noArgs('evil')
    case 'stop': return noArgs('stop')
    case 'help': return noArgs('help')
    case 'mob':
    case 'animal': {
      if (extra !== undefined) return { error: `!${word} takes one kind` }
      const r = kindOf(arg, word === 'mob' ? MOBS : ANIMALS, word)
      return r.error ? { error: r.error } : { name: word, kind: r.kind }
    }
    default: return null
  }
}

module.exports = { parseDemoCommand, HELP_LINES, MOBS, ANIMALS }
