// Checks a plan the translator made before any of it runs, and fills in the pickaxes the plan needs.
//
// The translator (Claude Haiku) turns the owner's words into a queue of agents commands. A model can miss a step or
// ask for something no skill does, so this walks the queue the way the bot would, keeping track of what decides
// whether a step can work at all:
//   the best pickaxe it will carry   a gather, a mine or the materials of a craft need a pickaxe of some level. One
//                                    it lacks is added in front as "!craft <pickaxe> keep" steps, wooden up to iron
//                                    (or diamond), each one possible with the pickaxe before it
//   the dimension it is in           ancient debris, nether quartz and nether gold are only in the Nether, and no
//                                    skill travels there: impossible
//   the blueprints it knows          a build of a blueprint it has not got, with no !design for it earlier: impossible
// Everything else a step needs (the logs for planks, the raw iron for ingots) the crafter and the builder get
// themselves through the gatherer, so they are not checked here.
//
// Pure, no Minecraft: test/plan.test.js runs it. checkPlan returns
//   { commands: [{ name, args }], added: [{ command, why }], impossible: null or the reason for the owner }

const { planCraft, TARGETS, LABEL } = require('./skills/crafter_plan')
const { PICK_LEVEL, NEED_LEVEL, NEED_TEXT, bestPickaxeOf, kindOfItem, KINDS } = require('./skills/gather_kinds')

const PICKS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']  // the crafter makes these
const NETHER_ONLY = new Set(['ancient_debris', 'nether_quartz_ore', 'nether_gold_ore'])
const LEVEL_TEXT = ['any pickaxe', 'a stone pickaxe', 'an iron pickaxe', 'a diamond pickaxe']

// The pickaxe level a block needs (minecraft-data's harvest tools), -1 for none, null when its tool is not a pickaxe
function blockLevel (registry, name) {
  const b = registry.blocksByName[name]
  if (!b || !b.harvestTools) return -1
  const tools = Object.keys(b.harvestTools).map(id => registry.items[id]?.name).filter(Boolean)
  const picks = tools.map(n => n.match(/^([a-z]+)_pickaxe$/)?.[1]).filter(m => m in PICK_LEVEL)
  if (!picks.length) return null
  return Math.min(...picks.map(m => PICK_LEVEL[m]))
}

// bag: a Map of item name to count (the bot's real bag). options:
//   registry     minecraft-data for 1.21.11 (harvest tools of blocks)
//   dimension    the bot's dimension, 'overworld', 'the_nether' or 'the_end' (a 'minecraft:' prefix is fine)
//   blueprints   the names of the blueprints the agents can build
function checkPlan (commands, bag, { registry, dimension = 'overworld', blueprints = [] } = {}) {
  const have = new Map(bag)
  const designed = new Set()
  const out = []
  const added = []
  const dim = String(dimension || 'overworld').replace(/^minecraft:/, '')
  const level = () => bestPickaxeOf([...have.keys()].filter(n => have.get(n) > 0)).level

  // the pickaxe steps that bring the bag up to need, each one possible with the one before it
  const ensure = (need, why) => {
    while (level() < need) {
      const next = PICKS[level() + 1]
      if (!next) return `that needs ${LEVEL_TEXT[need]}, more than I can make`
      const command = { name: 'craft', args: { item: next, keep: true } }
      out.push(command)
      added.push({ command, why })
      have.set(next, (have.get(next) || 0) + 1)
    }
    return null
  }

  for (const c of commands) {
    const a = c.args || {}
    if (c.name === 'gather') {
      const need = NEED_LEVEL[a.kind] ?? -1
      const no = ensure(need, `${KINDS[a.kind]?.label || a.kind} needs ${NEED_TEXT[a.kind] || 'a pickaxe'}`)
      if (no) return { commands: out, added, impossible: `I can't gather ${a.kind}: ${no}` }
      for (const item of KINDS[a.kind]?.items.slice(0, 1) || []) have.set(item, (have.get(item) || 0) + a.count)
    } else if (c.name === 'mine') {
      const blocks = a.blocks || []
      if (blocks.length && blocks.every(b => NETHER_ONLY.has(b)) && dim !== 'the_nether') {
        return { commands: out, added, impossible: `${blocks[0].replace(/_ore$/, ' ore').replace(/_/g, ' ')} is only in the Nether, and I can't travel there yet` }
      }
      if (registry) {
        const levels = blocks.map(b => blockLevel(registry, b)).filter(l => l !== null)
        if (levels.length) {
          const no = ensure(Math.min(...levels), `mining ${a.block.replace(/_/g, ' ')} needs ${LEVEL_TEXT[Math.max(0, Math.min(...levels))]}`)
          if (no) return { commands: out, added, impossible: `I can't mine ${a.block}: ${no}` }
        }
      }
    } else if (c.name === 'craft') {
      if (!TARGETS.includes(a.item)) return { commands: out, added, impossible: `I can't craft ${String(a.item).replace(/_/g, ' ')} yet` }
      // the crafter gathers what the bag lacks: the pickaxe for those materials comes first
      const plan = planCraft(a.item, have, { tableNear: false })
      let need = -1
      for (const [name] of plan.missing) {
        const kind = kindOfItem(name)
        if (!kind) return { commands: out, added, impossible: `the ${LABEL[a.item]} needs ${name.replace(/_/g, ' ')}, and I can't get that yet` }
        need = Math.max(need, NEED_LEVEL[kind])
      }
      const no = ensure(need, `the ${LABEL[a.item]} needs materials that take ${LEVEL_TEXT[Math.max(0, need)]}`)
      if (no) return { commands: out, added, impossible: `I can't craft the ${LABEL[a.item]}: ${no}` }
      // a pickaxe it was already going to make for itself: no second one
      if (a.keep && PICKS.includes(a.item) && (have.get(a.item) || 0) > (bag.get(a.item) || 0)) continue
      if (a.keep) have.set(a.item, (have.get(a.item) || 0) + 1)
    } else if (c.name === 'design') {
      designed.add(a.blueprint)
    } else if (c.name === 'build') {
      const name = a.blueprint
      if (name && !blueprints.includes(name) && !designed.has(name)) {
        return { commands: out, added, impossible: `I have no blueprint called ${name}` }
      }
    }
    out.push(c)
  }
  return { commands: out, added, impossible: null }
}

module.exports = { checkPlan, blockLevel, NETHER_ONLY, PICKS }
