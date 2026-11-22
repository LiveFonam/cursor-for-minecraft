// The demo's chat commands. Any other "!" line goes on to the agents, and plain words are a task for the agent.

const MOBS = Object.freeze(['zombie', 'skeleton', 'enderman', 'creeper'])
const ANIMALS = Object.freeze(['cow', 'pig', 'sheep', 'chicken'])

const HELP_LINES = Object.freeze([
  'Demo commands:',
  '!reset (or !start): back to your base with an empty chest, agent with shield, axe and 6 bread',
  '!chest: the same, with the chest stocked for a diamond pickaxe',
  '!pov: during a task, see through the agent\'s eyes. !spec to go back to flying free',
  '!haste [on|off]: give the agent Haste for faster mining, or take it away',
  '!1v1: fight the trained axe fighter in the arena',
  `!evil: the evil god hunts you in waves until a task, !reset or !stop`,
  `!mob [${MOBS.join('|')}]: send a mob at the agent`,
  `!animal [${ANIMALS.join('|')}]: put an animal by the agent`,
  '!stop: stop everything and go back to the base',
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
    case 'chest': return noArgs('chest')
    case 'pov':
    case 'follow': return noArgs('follow')
    case 'spec':
    case 'unfollow': return noArgs('unfollow')
    case 'haste': {
      if (extra !== undefined || (arg !== undefined && arg !== 'on' && arg !== 'off')) return { error: '!haste takes on or off' }
      return arg === undefined ? { name: 'haste' } : { name: 'haste', on: arg === 'on' }
    }
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

// Plain words about the camera, like "lemme see your pov" or "back to spectator". A line that names something to make
// or fetch is a task, so "get me iron while I watch your view" still goes to the agent
const TASK_THING = /\b(pickaxe|axe|sword|shovel|iron|diamonds?|wood|logs?|coal|stone|cobblestone|torch(es)?|food|furnace|chest|house|hut|farm)\b/
const TO_SPECTATOR = /\b(spectator|spectate|spec|free ?cam|fly(ing)? (free|around)|my (own )?(pov|view|camera|cam)|stop (following|watching)|unfollow|(leave|exit|get out of) (your|ur|the agent'?s?) (pov|view|eyes|camera|cam))\b/
const TO_AGENT = /\b((your|ur|the agent'?s?|agent'?s?|bot'?s?) (pov|view|perspective|eyes|camera|cam)|pov|point of view|first person|through (your|ur) eyes|what (do |are )?(you|u) (see|seeing|are seeing|r seeing))\b/

function parseCameraWords (text) {
  const line = String(text ?? '').trim().toLowerCase()
  if (!line || line.startsWith('!') || TASK_THING.test(line)) return null
  if (TO_SPECTATOR.test(line)) return { name: 'unfollow' }
  if (TO_AGENT.test(line)) return { name: 'follow' }
  return null
}

// Plain words about Haste, like "use haste" or "turn off haste". A line that also asks for something stays a task too
const FASTER = /\b(mine|dig|mining|digging) (a lot |way |much )?faster\b/
const HASTE_OFF = /\b(off|stop|no|without|remove|disable|lose|drop|don'?t|quit|end)\b/

function parseHasteWords (text) {
  const line = String(text ?? '').trim().toLowerCase()
  if (!line || line.startsWith('!') || !(/\bhaste\b/.test(line) || FASTER.test(line))) return null
  return { name: 'haste', on: !HASTE_OFF.test(line), alsoTask: TASK_THING.test(line) }
}

module.exports = { parseDemoCommand, parseCameraWords, parseHasteWords, HELP_LINES, MOBS, ANIMALS }
