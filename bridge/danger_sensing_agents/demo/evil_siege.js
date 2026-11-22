// The evil god's night attack, once per !evil: it takes command of the mobs already near the base, a creeper opens a
// wall, an enderman carries ground into whatever gap is left, and the zombies walk the checked path to the player.

const scene = require('./scene')
const plans = require('./evil_plan')
const { STOPPED, ENDERMAN, Guard, PathBuilder, readMoat, scoreSides, pathOn, menuSides, groundSources } = require('./evil_moat')

const RECRUIT_RADIUS = 48
const TAKE = Object.freeze({ zombie: 6, creeper: 1, enderman: 1, skeleton: 2 }) // the most of each it takes command of
const NEED = Object.freeze({ zombie: 3, creeper: 1, enderman: 1 })              // the least it can attack with
const HIDDEN_OUT = 12       // missing mobs land this far past the wall, out of his sight
const BLAST_POLLS = 8
const BLAST_POLL_MS = 500
const SETTLE_MS = 500       // the blast's block changes reach the reader
const MARCH_MS = 350
const WALKER = 'demo_walker'
const SPARE_SOURCES = 3
const ZOMBIES = `@e[tag=${scene.TAG_EVIL},type=minecraft:zombie]`
const walker = i => `${WALKER}_${i}`

class EvilSiege {
  constructor (host, brain, raid, blockAt) {
    Object.assign(this, { host, brain, raid, blockAt })
    this.guard = new Guard(host)
    this.walkers = 0
    this.done = null
  }

  end () {
    this.guard.end()
    this.raid.end()
  }

  // Reads the world once, before anything moves. False means no side is reachable: the scripted breach takes over
  async prepare () {
    try {
      const { host, guard: g } = this
      const L = plans.layoutOf(host.stage)
      const player = plans.parsePos(await g.send(`data get entity ${host.s.player} Pos`))
      if (!L || !player) return false
      const goal = { x: Math.floor(player.x), y: Math.floor(player.y), z: Math.floor(player.z) }
      const moat = readMoat({ blockAt: this.blockAt, layout: L })
      const sides = scoreSides({ blockAt: this.blockAt, layout: L, goal })
      host.log(`evil: moat ${moat.verdict}, ${sides.map(s => `${s.side} water ${s.water} blocks ${s.blocks.length}`).join(', ') || 'no side reachable'}`)
      if (!sides.length) return false
      if (sides[0].water > 0) host.log(`evil: every side has water near it, the driest has ${sides[0].water}`)
      this.view = { L, goal, moat, sides }
      return true
    } catch (err) {
      if (err !== STOPPED) this.host.log(`evil: ${err.message}`)
      return false
    }
  }

  // A failed step lets the mobs go and ends here, so it can never hold anything up
  async run () {
    try {
      await this.attack()
    } catch (err) {
      if (err === STOPPED) return
      this.host.log(`evil: ${err.message}`)
      await this.letGo().catch(() => {})
    }
  }

  async attack () {
    const { host, guard: g } = this
    const { L, goal, moat, sides } = this.view
    const menu = menuSides(sides)
    const scripted = { wall: menu[0].side, approach: 'center', zombies: 'breach', line: null }
    await this.raid.planSiege(scripted, { moat: moat.verdict, sides: menu.map(s => ({ side: s.side, water: s.water, blocks: s.blocks.length })) })
    g.check()
    const plan = this.raid.plan
    const first = menu.find(s => s.side === plan.wall) || menu[0]
    await this.recruit(L, first)
    await this.holdZombies(first)
    await this.blowWall()
    await g.pause(SETTLE_MS)
    const prefer = plans.APPROACH[plan.approach] ?? 0
    const path = pathOn({ blockAt: this.blockAt, layout: L, side: first.side, goal, prefer })
    if (!path) {
      host.log(`evil: no route on the ${first.side} side after the blast, zombies let go where they stand`)
      return this.finish()
    }
    if (path.blocks.length) {
      if (!plans.parseCount(await g.send(`execute if entity @e[tag=${scene.TAG_EVIL},type=minecraft:enderman]`))) {
        host.log('evil: no route, there is no enderman to build it, zombies let go where they stand')
        return this.finish()
      }
      await g.send(`execute as ${ENDERMAN} run data merge entity @s {NoAI:1b,Invulnerable:1b,PersistenceRequired:1b}`)
      await g.send(`tp ${ENDERMAN} ${path.from.x + 0.5} ${path.from.y} ${path.from.z + 0.5}`)
      const sources = groundSources(this.blockAt, L, path, path.blocks.length + SPARE_SOURCES)
      const built = await new PathBuilder(host, g, path, sources).run()
      await this.freeEnderman()
      if (built !== 'done') {
        host.log('evil: no route, the path was not finished, zombies let go where they stand')
        return this.finish()
      }
    } else {
      host.log('evil path: nothing to fill, the way in is open')
      await this.freeEnderman()
    }
    await g.pause(SETTLE_MS)
    const check = pathOn({ blockAt: this.blockAt, layout: L, side: first.side, goal, prefer: path.along, maxBlocks: 0 })
    if (!check) {
      host.log('evil: no route when checked again, zombies let go where they stand')
      return this.finish()
    }
    await this.march(check.route)
    host.log(`evil: ${this.walkers} zombies crossed on the ${first.side} side`)
    return this.finish()
  }

  // Takes command of what is already near. Only a role nothing can fill is summoned, out of sight, and logged
  async recruit (L, side) {
    const { host, guard: g } = this
    const near = `x=${L.x},y=${L.y},z=${L.z},distance=..${RECRUIT_RADIUS}`
    const made = []
    for (const [kind, most] of Object.entries(TAKE)) {
      await g.send(`tag @e[type=minecraft:${kind},${near},tag=!${scene.TAG_EVIL},limit=${most},sort=nearest] add ${scene.TAG_EVIL}`)
      const have = plans.parseCount(await g.send(`execute if entity @e[tag=${scene.TAG_EVIL},type=minecraft:${kind}]`)) ?? 0
      for (let i = have; i < (NEED[kind] || 0); i++) {
        const spot = plans.wallPoint(L, side.side, L.half + HIDDEN_OUT, side.along + i - 1)
        await g.send(plans.surfaceSummon(kind, spot, [scene.TAG_EVIL]))
        made.push(kind)
      }
    }
    if (made.length) host.log(`evil: summoned ${made.join(', ')}, none near enough`)
    await g.send(`tag @e[tag=${scene.TAG_EVIL},type=minecraft:creeper,limit=1] add ${scene.TAG_EVIL_CREEPER}`)
    await g.send(`tag @e[tag=${scene.TAG_EVIL},type=minecraft:enderman,limit=1] add ${scene.TAG_EVIL_BRIDGE}`)
    await g.send(`execute as ${ZOMBIES} run item replace entity @s weapon.mainhand with minecraft:wooden_axe`)
    await g.send(`execute as ${ZOMBIES} run item replace entity @s armor.head with minecraft:iron_helmet`)
    await g.send(`execute as ${ZOMBIES} run data merge entity @s {drop_chances:{mainhand:0.0f,head:0.0f}}`)
    await g.send(`effect give @e[tag=${scene.TAG_EVIL}] minecraft:fire_resistance infinite 0 true`)
    this.walkers = Math.min(TAKE.zombie, plans.parseCount(await g.send(`execute if entity ${ZOMBIES}`)) ?? 0)
    host.log(`evil: took command of ${this.walkers} zombies`)
  }

  // The zombies stand still on the far side of the attack until the path is ready
  async holdZombies (side) {
    const g = this.guard
    await g.send(`execute as ${ZOMBIES} run data merge entity @s {NoAI:1b}`)
    for (let i = 0; i < this.walkers; i++) {
      await g.send(`tag @e[tag=${scene.TAG_EVIL},type=minecraft:zombie,tag=!${WALKER},limit=1] add ${walker(i)}`)
      await g.send(`tag @e[tag=${walker(i)}] add ${WALKER}`)
      const lane = i % 2 ? (i + 1) / 2 : -i / 2
      const p = { x: side.from.x + (side.side === 'north' ? lane : 0), y: side.from.y, z: side.from.z + (side.side === 'north' ? 0 : lane) }
      await g.send(`execute as @e[tag=${walker(i)},limit=1] run tp @s ${p.x + 0.5} ${p.y} ${p.z + 0.5}`)
    }
  }

  async blowWall () {
    const { host, guard: g, raid } = this
    for (const c of plans.igniteCommands(host.stage, raid.plan)) await g.send(c)
    host.log(`evil: creeper lit at the ${raid.plan.wall} wall`)
    for (let i = 0; i < BLAST_POLLS; i++) {
      await g.pause(BLAST_POLL_MS)
      if (/failed/i.test(await g.send(`execute if entity @e[tag=${scene.TAG_EVIL_CREEPER}]`))) return
    }
    host.log('evil: the creeper never went off')
  }

  async freeEnderman () {
    const g = this.guard
    await g.send(`data remove entity ${ENDERMAN} carriedBlockState`)
    await g.send(`execute as ${ENDERMAN} run data merge entity @s {NoAI:0b,Invulnerable:0b}`)
  }

  // In single file along the checked route
  async march (route) {
    const g = this.guard
    const last = route.length - 1
    for (let t = 0; t <= last + (this.walkers - 1) * 2; t++) {
      for (let i = 0; i < this.walkers; i++) {
        const at = t - i * 2
        if (at < 0 || at > last) continue
        await g.send(`tp @e[tag=${walker(i)},limit=1] ${route[at].x + 0.5} ${route[at].y} ${route[at].z + 0.5}`)
      }
      await g.pause(MARCH_MS)
    }
  }

  async letGo () {
    const g = this.guard
    await g.send(`execute as ${ZOMBIES} run data merge entity @s {NoAI:0b}`)
    await g.send(`tag @e[tag=${WALKER}] remove ${WALKER}`)
    for (let i = 0; i < this.walkers; i++) await g.send(`tag @e[tag=${walker(i)}] remove ${walker(i)}`)
  }

  async finish () {
    await this.letGo()
    this.raid.zombiesOut = true
    return true
  }
}

module.exports = { EvilSiege, NEED, TAKE }
