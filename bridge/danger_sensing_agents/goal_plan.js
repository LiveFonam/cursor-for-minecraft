// The goal planner: one goal ("a diamond pickaxe", "16 wood") plus what is available becomes the ordered steps. The
// language model only names the goal, every step comes from here. Pure, no Minecraft: test/goal_plan.test.js runs it.
//
// Where things come from, cheapest first:
//   the bag          what the bot already carries costs nothing
//   chests           remembered or nearby ones, nearest first, when the walk is shorter than getting the item another
//                    way (TRIP below)
//   the owner's bag  the bot asks in chat and the owner drops them. Never the owner's tools or the thing they asked for
//   gathering        wood, cobblestone, iron and diamonds, with the pickaxe each one needs made first
//
// The wooden pickaxe is a throwaway step: it digs exactly the 3 cobblestone of the stone pickaxe, and every other block
// of cobblestone is dug with the stone pickaxe. From an empty bag an iron pickaxe is: wood, wooden pickaxe, wooden axe,
// 3 cobblestone, stone pickaxe, the furnace's 8 cobblestone plus 3 spare for a new stone pickaxe, iron, smelt, craft.
//
// Recipes, tags and fuel come from the crafter's planner (skills/crafter_plan.js), the same one that runs the craft, so
// a plan never disagrees with what the crafter will do.
//
//   const plan = planGoal({ item: 'diamond_pickaxe', count: 1 }, { bag, chests, owner })
//   plan.impossible   null, or what cannot be done and why
//   plan.steps        take, ask, gather, prep, smelt, craft, walk, hand

const { planCraft, TARGETS, LABEL, craftingRecipes, resolveTarget } = require('./skills/crafter_plan')
const { KINDS, NEED_LEVEL, resolveKind, kindOfItem, bestPickaxeOf } = require('./skills/gather_kinds')

const PICKS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']
const MAX_CRAFTED = 8
const STONE_PICK_COBBLE = 3  // what a stone pickaxe takes, all the wooden pickaxe ever digs
const SPARE_COBBLE = 3       // carried on a trip for ore, so a stone pickaxe that breaks underground can be replaced
const COBBLE = ['cobblestone', 'cobbled_deepslate', 'blackstone']
// How many blocks a chest is worth walking to, by what is in it: past this, getting the item another way is cheaper
const TRIP = { wood: 48, cobblestone: 48, coal: 96, iron: 160, diamond: 320 }
const OTHER_TRIP = 96
// What stays with the owner even when it would help: their gear
const OWNER_KEEPS = /(_pickaxe|_axe|_sword|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots)$|^(shield|bow|crossbow|arrow|torch)$/
const MASS = /^(raw_|coal$|charcoal$|cobblestone$|cobbled_deepslate$|blackstone$|.*_planks$|wood$|iron$)/

const add = (m, k, n) => m.set(k, (m.get(k) || 0) + n)
const total = (m, names) => names.reduce((t, n) => t + (m.get(n) || 0), 0)
const without = (m, name) => { const c = new Map(m); c.delete(name); return c }
const words = name => String(name).replace(/_/g, ' ')
const tripLimit = name => { const k = kindOfItem(name); return k ? TRIP[k] : OTHER_TRIP }
const namesOf = item => KINDS[item]?.items || [item]
// Any axe or sword in the bag means it can already fight ("_axe" does not match a pickaxe)
const hasWeapon = bag => [...bag].some(([name, n]) => n > 0 && /_(axe|sword)$/.test(name))

// "3 diamonds", "2 raw iron"
function qty (name, n) {
  const text = words(name)
  return `${n} ${text}${n > 1 && !MASS.test(name) && !text.endsWith('s') ? 's' : ''}`
}

// "3 diamonds and 2 sticks"
function listText (items) {
  const parts = items.map(([name, n]) => qty(name, n))
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

// A few words to a goal item with its usual count, or null. A kind ("wood", "iron") counts every item of that kind,
// anything else is taken as an item id and the planner decides whether it can be had
function resolveGoal (text) {
  const w = String(text || '').toLowerCase().trim().replace(/^minecraft:/, '')
  if (!w) return null
  const target = resolveTarget(w)
  if (target) return { item: target, count: 1 }
  if (w === 'coal' || w === 'coal ore') return { item: 'coal', count: KINDS.coal.default }
  const kind = resolveKind(w)
  if (kind) return { item: kind, count: KINDS[kind].default }
  const id = w.replace(/[\s-]+/g, '_')
  return /^[a-z0-9_]{1,48}$/.test(id) ? { item: id, count: 1 } : null
}

// Takes one crafter plan out of a stock: the ingredients and fuel go, the results come in. A crafting table it placed
// comes back to the bag, a furnace it placed stays in the world. Returns what was used, name to count
function applyPlan (stock, plan) {
  const used = new Map()
  const take = (name, n) => {
    if (n <= 0) return
    stock.set(name, Math.max(0, (stock.get(name) || 0) - n))
    add(used, name, n)
  }
  for (const s of plan.steps) {
    if (s.kind === 'smelt') {
      take(s.input, s.count)
      for (const [fuel, n] of s.fuel || []) take(fuel, n)
      add(stock, s.output, s.count)
      continue
    }
    const recipes = craftingRecipes(s.name)
    const fits = r => Object.entries(r.key).every(([k, items]) => items.some(i => (stock.get(i) || 0) >= r.uses[k] * s.times))
    const r = recipes.find(fits) || recipes[0]
    if (r) {
      for (const [k, items] of Object.entries(r.key)) {
        const n = r.uses[k] * s.times
        const item = items.find(i => (stock.get(i) || 0) >= n) || items.slice().sort((a, b) => (stock.get(b) || 0) - (stock.get(a) || 0))[0]
        take(item, n)
      }
    }
    add(stock, s.name, s.count)
  }
  if (plan.placeFurnace) take('furnace', 1)
  return used
}

// The crafter feeds the furnace before it does the crafts listed after the smelt, so fuel it would only craft later
// is not there yet. Returns the first such fuel as { name, short }, or null
function lateFuel (plan, stock) {
  const sim = new Map(stock)
  for (const s of plan.steps) {
    if (s.kind === 'smelt') {
      for (const [name, n] of s.fuel || []) {
        const have = sim.get(name) || 0
        if (have < n) return { name, short: n - have }
        sim.set(name, have - n)
      }
    } else {
      add(sim, s.name, s.count)
    }
  }
  return null
}

// All the gathering of one kind in one trip, at the place of the first (the pickaxe it needs is made before that). The
// cobblestone dug with the wooden pickaxe stays its own short trip, the rest waits for the stone pickaxe
function mergeGathers (work) {
  const out = []
  const first = new Map()
  for (const s of work) {
    const key = s.kind === 'gather' ? `${s.what}${s.withWood ? ':wooden' : ''}` : null
    if (key && first.has(key)) {
      first.get(key).count += s.count
      continue
    }
    const copy = { ...s }
    if (key) first.set(key, copy)
    out.push(copy)
  }
  return out
}

// goal: { item, count }. sources:
//   bag      Map of item name to count
//   chests   [{ pos: { x, y, z }, items: Map, distance }]
//   owner    Map of what the owner carries, or null when it could not be read
// options: dimension ('overworld' by default, gathering only works there)
function planGoal (goal, sources = {}, { dimension = 'overworld' } = {}) {
  const item = goal.item
  const want = goal.count ?? 1
  const names = namesOf(item)
  const isTarget = TARGETS.includes(item)
  const stock = new Map(sources.bag || [])
  const chests = (sources.chests || [])
    .map(c => ({ pos: c.pos, items: new Map(c.items), distance: c.distance ?? 0 }))
    .sort((a, b) => a.distance - b.distance)
  const owner = sources.owner ? new Map(sources.owner) : null
  const takes = new Map()
  const asks = new Map()
  const work = []
  const dim = String(dimension || 'overworld').replace(/^minecraft:/, '')
  let failure = null

  const fail = text => { failure = failure || text; return false }
  const level = () => bestPickaxeOf([...stock.keys()].filter(n => stock.get(n) > 0)).level
  const askable = name => !OWNER_KEEPS.test(name) && !names.includes(name)

  // Moves up to n of an item into the stock from the chests, then (when allowed) from the owner's bag
  const pull = (name, n, fromOwner = false) => {
    let left = n
    for (const c of chests) {
      if (left <= 0) break
      if (c.distance > tripLimit(name)) continue
      const m = Math.min(c.items.get(name) || 0, left)
      if (m <= 0) continue
      c.items.set(name, c.items.get(name) - m)
      const key = `${c.pos.x},${c.pos.y},${c.pos.z}`
      if (!takes.has(key)) takes.set(key, { kind: 'take', pos: c.pos, items: new Map() })
      add(takes.get(key).items, name, m)
      add(stock, name, m)
      left -= m
    }
    if (fromOwner && owner && left > 0 && askable(name)) {
      const m = Math.min(owner.get(name) || 0, left)
      if (m > 0) {
        owner.set(name, owner.get(name) - m)
        add(asks, name, m)
        add(stock, name, m)
        left -= m
      }
    }
    return n - left
  }

  // Before gathering anything for a craft: what the chests, then the owner, can add to it. Only what the craft uses
  const fillFromSources = target => {
    if (!planCraft(target, without(stock, target)).missing.size) return
    for (const fromOwner of [false, true]) {
      if (fromOwner && !owner) break
      const pile = without(stock, target)
      for (const c of chests) {
        for (const [name, n] of c.items) if (n > 0 && c.distance <= tripLimit(name) && name !== target) add(pile, name, n)
      }
      if (fromOwner) for (const [name, n] of owner) if (n > 0 && askable(name)) add(pile, name, n)
      const used = applyPlan(new Map(pile), planCraft(target, pile))
      for (const [name, n] of used) {
        const short = n - (stock.get(name) || 0)
        if (short > 0) pull(name, short, fromOwner)
      }
      if (!planCraft(target, without(stock, target)).missing.size) return
    }
  }

  const addGather = (what, n, into) => {
    if (dim !== 'overworld') return fail(`I can only gather ${KINDS[what]?.label || what} in the overworld, and I'm in ${words(dim)}`)
    work.push({ kind: 'gather', what, count: n, ...(what === 'cobblestone' && level() < 1 ? { withWood: true } : {}) })
    add(stock, into, n)
    return true
  }

  // A pickaxe of at least this level: in the bag, in a chest, or made
  const ensurePick = (need, depth) => {
    if (need < 0 || level() >= need) return true
    // a stone pickaxe in a chest beats making a wooden one to throw away
    for (let l = Math.max(need, 1); l < PICKS.length; l++) if (pull(PICKS[l], 1)) return true
    if (need === 0 && pull(PICKS[0], 1)) return true
    return craftTarget(PICKS[need], depth)
  }

  // Real planks in the bag before the furnace needs them (see lateFuel)
  const prepareFuel = late => {
    const plank = /_planks$/.test(late.name) ? late.name : 'oak_planks'
    const log = plank.replace(/_planks$/, '_log')
    if (!(stock.get(log) > 0) && !addGather('wood', 1, log)) return false
    const times = Math.max(1, Math.ceil(late.short / 4))
    if ((stock.get(log) || 0) < times && !addGather('wood', times - (stock.get(log) || 0), log)) return false
    applyPlan(stock, { steps: [{ kind: 'craft', name: plank, times, count: times * 4 }] })
    work.push({ kind: 'prep', item: plank, times })
    return true
  }

  // A wooden axe to fight with, made right after the first wooden pickaxe. Extra wood from a chest, else gathered
  const addAxe = () => {
    for (let round = 0; round < 8; round++) {
      const p = planCraft('wooden_axe', stock)
      if (!p.missing.size) {
        applyPlan(stock, p)
        work.push({ kind: 'axe' })
        return true
      }
      if (!KINDS.wood.items.some(log => pull(log, 1)) && !addGather('wood', 1, 'oak_log')) return false
    }
    return fail('I could not work out the wood for a wooden axe')
  }

  // One more of a craftable item, with everything it takes before it in the work list
  function craftTarget (target, depth = 0) {
    if (failure) return false
    if (depth > 6) return fail(`the ${LABEL[target]} takes too many steps`)
    fillFromSources(target)
    for (let round = 0; round < 24; round++) {
      const p = planCraft(target, without(stock, target))
      if (!p.missing.size) {
        // the crafter may find a table standing nearby, which changes the order of its crafts, so both are checked
        const base = without(stock, target)
        const late = lateFuel(p, base) || lateFuel(planCraft(target, base, { tableNear: true }), base)
        if (late) {
          if (!prepareFuel(late)) return false
          continue
        }
        applyPlan(stock, p)
        for (const s of p.steps) {
          if (s.kind === 'smelt') work.push({ kind: 'smelt', input: s.input, output: s.output, count: s.count, fuel: s.fuel })
        }
        work.push({ kind: 'craft', item: target })
        if (target === 'wooden_pickaxe' && !hasWeapon(stock)) return addAxe()
        return true
      }
      let tool = -1
      for (const name of p.missing.keys()) {
        const k = kindOfItem(name)
        if (!k) return fail(`the ${LABEL[target]} needs ${words(name)}, and I can't get that`)
        if (name !== 'coal') tool = Math.max(tool, NEED_LEVEL[k])
      }
      if (level() < tool) {
        if (!ensurePick(tool, depth + 1)) return false
        continue
      }
      // with only a wooden pickaxe, the stone pickaxe comes before any other cobblestone
      const isCobble = name => kindOfItem(name) === 'cobblestone'
      if (target !== 'stone_pickaxe' && level() === 0 && [...p.missing.keys()].some(isCobble)) {
        if (!craftTarget('stone_pickaxe', depth + 1)) return false
        continue
      }
      // the cobblestone before the trip for ore, so the stone pickaxe digs it on the way
      for (const [name, n] of [...p.missing].sort((a, b) => isCobble(b[0]) - isCobble(a[0]))) {
        // fuel nobody has: a log burns too, and wood needs no trip underground
        if (name === 'coal') {
          if (!addGather('wood', 1, 'oak_log')) return false
          continue
        }
        const k = kindOfItem(name)
        const into = KINDS[k].items.includes(name) ? name : KINDS[k].items[0]
        if (!addGather(k, n, into)) return false
      }
    }
    return fail(`I could not work out the materials for the ${LABEL[target]}`)
  }

  // The goal itself: first what is already there, then the rest
  if (!Number.isInteger(want) || want < 1) {
    fail('that needs a count of at least 1')
  } else if (isTarget && want > MAX_CRAFTED) {
    fail(`I can make at most ${MAX_CRAFTED} ${words(item)}s in one go`)
  } else if (KINDS[item] && want > KINDS[item].max) {
    fail(`I can get at most ${KINDS[item].max} ${KINDS[item].unit} in one go`)
  } else {
    for (const name of names) {
      const short = want - total(stock, names)
      if (short > 0) pull(name, short)
    }
    const short = want - total(stock, names)
    if (short > 0) {
      if (isTarget) {
        while (!failure && total(stock, names) < want) craftTarget(item)
      } else if (KINDS[item]) {
        // more cobblestone than one stone pickaxe takes is dug with a stone pickaxe
        const need = item === 'cobblestone' && short > STONE_PICK_COBBLE ? 1 : NEED_LEVEL[item]
        if (ensurePick(need, 0)) addGather(item, want - total(stock, names), names[0])
      } else {
        fail(total(stock, names) > 0
          ? `I only found ${qty(item, total(stock, names))} and I can't make more`
          : `I can't make or gather ${words(item)}, and I found none in my bag or the chests I know`)
      }
    }
  }

  // Before the first block it digs for ore or stone it has an axe to fight and chop with, whatever else the bag holds
  const armForMining = () => {
    if (hasWeapon(stock)) return
    const at = work.findIndex(s => s.kind === 'gather' && s.what !== 'wood')
    if (at < 0) return
    const tail = work.splice(at)
    const isWood = s => s.kind === 'gather' && s.what === 'wood'
    work.push(...tail.filter(isWood))
    const p = planCraft('wooden_axe', stock)
    if (!p.missing.size) {
      applyPlan(stock, p)
      work.push({ kind: 'axe' })
    } else {
      // no wood to spare: logs from a tree in sight when there is one. It is never a step the goal can fail on, since a
      // bot already underground with a good pickaxe has no tree to walk to
      const table = stock.get('crafting_table') > 0 ? [['crafting_table', 1]] : []
      let chop = 1
      while (chop < 4 && planCraft('wooden_axe', new Map([['oak_log', chop], ...table])).missing.size) chop++
      work.push({ kind: 'axe', chop })
    }
    work.push(...tail.filter(s => !isWood(s)))
  }

  // A trip for ore on a stone pickaxe carries the cobblestone for another one, on top of what the plan will use up
  const carrySpareCobble = () => {
    const at = work.findIndex(s => s.kind === 'gather' && (s.what === 'iron' || s.what === 'diamond'))
    if (at < 0) return
    const before = [...(sources.bag || new Map()).entries()].filter(([, n]) => n > 0).map(([n]) => n)
    for (const t of takes.values()) before.push(...t.items.keys())
    before.push(...work.slice(0, at).filter(s => s.kind === 'craft').map(s => s.item))
    if (bestPickaxeOf(before).level !== 1) return
    const short = SPARE_COBBLE - total(stock, COBBLE)
    if (short <= 0) return
    add(stock, 'cobblestone', short)
    const dug = work.slice(0, at).reverse().find(s => s.kind === 'gather' && s.what === 'cobblestone' && !s.withWood)
    if (dug) dug.count += short
    else work.splice(at, 0, { kind: 'gather', what: 'cobblestone', count: short })
  }

  if (!failure) armForMining()
  if (!failure) carrySpareCobble()
  if (failure) return { goal, steps: [], impossible: failure, ownerSeen: !!sources.owner }
  const takeSteps = [...takes.values()].map(t => ({ kind: 'take', pos: t.pos, items: [...t.items] }))
  const askSteps = asks.size ? [{ kind: 'ask', items: [...asks] }] : []
  const steps = [...takeSteps, ...askSteps, ...mergeGathers(work), { kind: 'walk' }, { kind: 'hand', item, names, count: want }]
  return { goal, steps, impossible: null, ownerSeen: !!sources.owner }
}

// One step in a few words, for chat and !plan
function stepText (s) {
  switch (s.kind) {
    case 'take': return `take ${listText(s.items)} from the chest at ${s.pos.x} ${s.pos.y} ${s.pos.z}`
    case 'ask': return `ask you for ${listText(s.items)}`
    case 'gather': {
      const unit = KINDS[s.what]?.unit || s.what
      return `gather ${s.count} ${s.count === 1 ? unit.replace(/s$/, '') : unit}`
    }
    case 'prep': return `make ${words(s.item)} for fuel`
    case 'smelt': return `smelt ${qty(s.input, s.count)}`
    case 'craft': return `craft ${words(s.item)}`
    case 'axe': return 'craft wooden axe to keep'
    case 'walk': return 'walk to you'
    case 'hand': return `hand over ${KINDS[s.item] ? `${s.count} ${KINDS[s.item].unit}` : s.count > 1 ? qty(s.item, s.count) : words(s.item)}`
  }
  return s.kind
}

function stepCommand (s, requester) {
  switch (s.kind) {
    case 'take': return { name: 'take', args: { pos: s.pos, items: s.items } }
    case 'ask': return { name: 'ask', args: { items: s.items } }
    case 'gather': return { name: 'gather', args: { kind: s.what, count: s.count } }
    case 'prep': return { name: 'prep', args: { item: s.item, times: s.times } }
    case 'craft': return { name: 'craft', args: { item: s.item, keep: true, requester } }
    case 'axe': return { name: 'axe', args: s.chop ? { chop: s.chop } : {} }
    case 'walk': return { name: 'walk', args: { to: requester } }
    case 'hand': return { name: 'hand', args: { to: requester, item: s.item, names: s.names, count: s.count } }
  }
  return null
}

// The plan as commands the agents run, each with its label. Smelting happens inside the crafter's job for the item
// after it, so it is part of that step's label
function goalCommands (plan, requester) {
  const out = []
  let before = ''
  for (const s of plan.steps) {
    if (s.kind === 'smelt') {
      before += `${stepText(s)}, `
      continue
    }
    out.push({ command: stepCommand(s, requester), label: before + stepText(s), kind: s.kind })
    before = ''
  }
  return out
}

// True when the crafter alone would stall on this item: a material it lacks needs a pickaxe better than the bag holds
function needsToolChain (item, bag) {
  if (!TARGETS.includes(item)) return false
  const best = bestPickaxeOf([...bag.keys()].filter(n => bag.get(n) > 0)).level
  return [...planCraft(item, without(bag, item)).missing.keys()].some(name => {
    const k = kindOfItem(name)
    return !!k && NEED_LEVEL[k] >= 1 && NEED_LEVEL[k] > best
  })
}

// A queue of commands from elsewhere (a !mine whose pickaxes plan_check.js added): the wooden axe goes right after the
// wooden pickaxe, unless the bag already holds an axe or a sword
function withAxe (commands, bag) {
  if (hasWeapon(bag)) return commands
  const at = commands.findIndex(c => c.name === 'craft' && c.args?.item === 'wooden_pickaxe')
  if (at < 0) return commands
  return [...commands.slice(0, at + 1), { name: 'axe', args: {} }, ...commands.slice(at + 1)]
}

module.exports = { planGoal, goalCommands, resolveGoal, applyPlan, lateFuel, needsToolChain, withAxe, hasWeapon, stepText, listText, qty, namesOf, MAX_CRAFTED, TRIP }
