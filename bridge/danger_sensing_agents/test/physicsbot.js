// A fake world bot that moves with the real game physics (prismarine-physics) and the real mineflayer-pathfinder, for
// tests about how a walk looks: stops, replans, jumps and camera turns. Ticks are virtual, so a 30 s walk runs in about
// a second. The look and position sending mirror Mineflayer's physics plugin: a forced look jumps the camera at once,
// any other look reaches the server at physics.yawSpeed.
//
//   const { makePhysicsBot, carveStairs } = require('./physicsbot')
//   const h = makePhysicsBot({ groundY: 63, pos: new Vec3(0.5, 64, 0.5) })
//   await h.until(() => done, 400)
//   h.report()   ->  { seconds, pauses, replans, maxCameraStep, ... }

const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { Physics, PlayerState } = require('prismarine-physics')
const { RaycastIterator } = require('prismarine-world/src/iterators')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { FakeWorld, makeBot, registry } = require('./mockbot')
const { PLAYER_HALF_WIDTH, fixDigTimes } = require('../../mineflayer_fixes')

const TICK_S = 0.05
const PAUSE_SPEED = 0.02       // blocks per tick, below this the bot counts as standing still
const PAUSE_TICKS = 5          // 0.25 s
const PICKUP_DELAY = 10        // ticks before the game lets a player pick up a block's drop
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a))

// realSight: Mineflayer's own canSeeBlock, word for word, instead of the stand-in's forgiving one
// dropLag: ticks before a broken block's drop reaches the client, as on a real server. dropAt(blockPos): where it lands
function makePhysicsBot ({ world = null, pos = null, yaw = 0, food = 20, realSight = false, dropLag = 0, dropAt = null, ...worldOpts } = {}) {
  fixDigTimes(registry)
  world = world || new FakeWorld(worldOpts)
  // blocks are read thousands of times a tick by the physics and the path search
  const cache = new Map()
  const rawGet = world.get.bind(world)
  const rawSet = world.set.bind(world)
  world.get = p => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    let b = cache.get(k)
    if (!b) { b = rawGet(p); cache.set(k, b) }
    return b
  }
  world.set = (p, name, props = null) => {
    const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
    const old = cache.get(k) || rawGet(p)
    cache.delete(k)
    rawSet(p, name, props)
    if (bot) bot.emit('blockUpdate', old, world.get(p))
  }

  const bot = new EventEmitter()
  bot.setMaxListeners(0)
  const start = pos || new Vec3(0.5, world.groundY + 1, 0.5)
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const packets = []
  const wire = { yaw, pitch: 0 }
  Object.assign(bot, {
    username: 'Agent1',
    version: '1.21.11',
    registry,
    food,
    health: 20,
    game: { gameMode: 'survival', minY: -64, height: 384 },
    entities: {},
    players: {},
    jumpTicks: 0,
    jumpQueued: false,
    heldItem: null,
    targetDigBlock: null,
    inventory: { slots: [], items: () => [], emptySlotCount: () => 36, count: () => 0 },
    entity: {
      position: start.clone(),
      velocity: new Vec3(0, 0, 0),
      yaw,
      pitch: 0,
      onGround: true,
      height: 1.8,
      eyeHeight: 1.62,
      effects: {},
      attributes: {}
    },
    supportFeature: () => false,
    blockAt: p => world.get(p),
    world: {
      getBlock: p => world.get(p),
      // prismarine-world's own ray walk
      raycast: (from, direction, range, matcher = null) => {
        const iter = new RaycastIterator(from, direction, range)
        let at = from
        while (at) {
          const position = new Vec3(at.x, at.y, at.z)
          const block = world.get(position)
          if (block) {
            if (matcher) {
              if (matcher(block, iter)) return block
            } else {
              const hit = iter.intersect(block.shapes, position)
              if (hit) {
                block.face = hit.face
                block.intersect = hit.pos
                return block
              }
            }
          }
          at = iter.next()
        }
        return null
      }
    },
    stopDigging: () => {},
    clearControlStates: () => { for (const c of Object.keys(controls)) bot.setControlState(c, false) },
    getControlState: c => controls[c],
    setControlState: (c, v) => {
      if (controls[c] === v) return
      controls[c] = v
      if (c === 'jump' && v) bot.jumpQueued = true
    },
    _client: Object.assign(new EventEmitter(), {
      write: (name, params) => {
        packets.push({ name, ...params })
        // the camera a person watching sees is what goes on the wire
        if ((name === 'look' || name === 'position_look') && params) {
          wire.yaw = Math.PI - (params.yaw * Math.PI) / 180
          wire.pitch = (-params.pitch * Math.PI) / 180
        }
      }
    })
  })
  bot.controlState = controls

  const physics = Physics(registry, { getBlock: p => world.get(p) })
  physics.playerHalfWidth = PLAYER_HALF_WIDTH
  bot.physics = physics
  const physicsWorld = { getBlock: p => world.get(p) }

  // the camera as the server sees it, the same way Mineflayer sends it
  let sentYaw = yaw
  let sentPitch = 0
  let looking = null
  const finishLook = () => { if (looking) { const r = looking; looking = null; r() } }
  bot.look = (y, p, force) => {
    finishLook()
    const unit = (0.15 * Math.PI) / 180
    const dy = Math.round((y - bot.entity.yaw) / unit) * unit
    const dp = Math.round((p - bot.entity.pitch) / unit) * unit
    if (dy === 0 && dp === 0) return Promise.resolve()
    bot.entity.yaw += dy
    bot.entity.pitch += dp
    if (force) {
      sentYaw = y
      sentPitch = p
      return Promise.resolve()
    }
    return new Promise(resolve => { looking = resolve })
  }
  bot.lookAt = (point, force) => {
    const d = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
    return bot.look(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)), force)
  }

  // the bag, block search and placing of the plain fake bot, working on this bot's body
  const plain = makeBot({ world, pos: start }).bot
  plain.entity = bot.entity
  for (const k of ['inventory', 'give', 'take', 'countOf', 'findBlocks', 'canSeeBlock', 'placeBlock', 'unequip']) bot[k] = plain[k]
  bot.equip = async (item, dest) => {
    await plain.equip(item, dest)
    bot.heldItem = plain.heldItem
  }
  Object.defineProperty(plain, 'lookAt', { value: (...a) => bot.lookAt(...a) })
  if (realSight) {
    bot.canSeeBlock = block => {
      const headPos = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
      const range = headPos.distanceTo(block.position)
      const dir = block.position.offset(0.5, 0.5, 0.5).minus(headPos)
      const match = (inputBlock, iter) => {
        const intersect = iter.intersect(inputBlock.shapes, inputBlock.position)
        if (intersect) return true
        return block.position.equals(inputBlock.position)
      }
      const blockAtCursor = bot.world.raycast(headPos, dir.normalize(), range, match)
      return blockAtCursor && blockAtCursor.position.equals(block.position)
    }
  }

  // digging like Mineflayer's: a timer from the block's dig time that any new dig or stopDigging cancels
  let dig = null
  const digs = { started: 0, finished: 0, canceled: 0 }
  bot.digTime = block => block.digTime(bot.heldItem?.type ?? null, false, false, !bot.entity.onGround, [], {})
  bot.dig = async (block, forceLook) => {
    if (forceLook !== 'ignore') await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook)
    if (bot.targetDigBlock) bot.stopDigging()
    digs.started++
    bot._client.write('block_dig', { status: 0, location: block.position, face: 1 })
    return new Promise((resolve, reject) => {
      dig = { block, left: Math.max(1, Math.ceil(bot.digTime(block) / 50)), resolve }
      bot.targetDigBlock = block
      bot.stopDigging = () => {
        if (!dig) return
        dig = null
        bot.targetDigBlock = null
        digs.canceled++
        bot._client.write('block_dig', { status: 1, location: block.position, face: 0 })
        reject(new Error('Digging aborted'))
      }
    })
  }
  const stepDig = () => {
    if (!dig || --dig.left > 0) return
    const { block, resolve } = dig
    dig = null
    bot.targetDigBlock = null
    digs.finished++
    bot._client.write('block_dig', { status: 2, location: block.position, face: 1 })
    const name = world.name(block.position)
    world.set(block.position, 'air')
    const drop = { iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron', coal_ore: 'coal', stone: 'cobblestone' }[name]
    if (drop) {
      const id = nextEntity++
      const at = block.position.clone()
      const land = () => {
        const position = dropAt ? dropAt(at) : at.offset(0.5, 0.1, 0.5)
        if (!position) return  // this drop is lost: it never reaches the client
        bot.entities[id] = { id, name: 'item', position, drop, readyAt: now + PICKUP_DELAY, getDroppedItem: () => ({ name: drop, count: 1 }) }
      }
      if (dropLag > 0) landing.push({ at: now + dropLag, land })
      else land()
    }
    resolve()
  }
  const landing = []
  const stepLanding = () => {
    for (let i = landing.length - 1; i >= 0; i--) {
      if (landing[i].at > now) continue
      landing[i].land()
      landing.splice(i, 1)
    }
  }
  let nextEntity = 1000
  let now = 0
  // the game hands a drop over once the body's box, grown by 1 block sideways and 0.5 up and down, touches the item's box
  const stepPickup = () => {
    const p = bot.entity.position
    for (const [id, e] of Object.entries(bot.entities)) {
      if (e.name !== 'item' || (e.readyAt ?? 0) > now) continue
      if (Math.abs(e.position.x - p.x) <= 1.425 && Math.abs(e.position.z - p.z) <= 1.425 && e.position.y >= p.y - 0.75 && e.position.y <= p.y + 2.3) {
        bot.give(e.drop, 1)
        delete bot.entities[id]
      }
    }
  }

  pathfinder(bot)
  const moves = new Movements(bot)
  bot.pathfinder.setMovements(moves)

  // what the report counts
  const rec = { ticks: 0, pauses: 0, stillTicks: 0, longest: 0, replans: 0, resets: {}, maxCameraStep: 0, jumps: 0, backward: 0, forwardGaps: 0 }
  let wasForward = false
  let lastYaw = yaw
  let lastPitch = 0
  let counting = true
  bot.on('path_update', r => { if (counting && r.status !== 'partial') rec.replans++ })
  bot.on('path_reset', why => { if (counting) rec.resets[why] = (rec.resets[why] || 0) + 1 })

  let tickWaiters = []
  function tick () {
    now++
    const wasGround = bot.entity.onGround
    physics.simulatePlayer(new PlayerState(bot, { ...controls }), physicsWorld).apply(bot)
    stepDig()
    stepLanding()
    stepPickup()
    bot.emit('physicsTick')
    // sending: the look eases to entity.yaw at the physics yaw and pitch speeds
    const dYaw = wrap(bot.entity.yaw - sentYaw)
    const dPitch = bot.entity.pitch - sentPitch
    const maxYaw = TICK_S * physics.yawSpeed
    const maxPitch = TICK_S * physics.pitchSpeed
    sentYaw += Math.max(-maxYaw, Math.min(maxYaw, dYaw))
    sentPitch += Math.max(-maxPitch, Math.min(maxPitch, dPitch))
    bot._client.write('position_look', {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z,
      yaw: ((Math.PI - sentYaw) * 180) / Math.PI,
      pitch: (-sentPitch * 180) / Math.PI,
      onGround: bot.entity.onGround
    })
    if (packets.length > 4) packets.splice(0, packets.length - 4)
    bot.motionTicks = (bot.motionTicks || 0) + 1
    bot.emit('move')
    if (looking && Math.abs(wrap(bot.entity.yaw - sentYaw)) < 0.001) finishLook()

    if (counting) {
      rec.ticks++
      const camera = Math.hypot(wrap(wire.yaw - lastYaw), wire.pitch - lastPitch)
      if (camera > rec.maxCameraStep) rec.maxCameraStep = camera
      const v = bot.entity.velocity
      const speed = Math.hypot(v.x, v.z)
      // a pause is standing still and then moving again, so the wait before a walk and the stop after it do not count
      if (speed < PAUSE_SPEED && !bot.targetDigBlock) rec.stillTicks++
      else {
        if (rec.moved && rec.stillTicks >= PAUSE_TICKS) rec.pauses++
        if (rec.moved && rec.stillTicks > rec.longest) rec.longest = rec.stillTicks
        rec.moved = true
        rec.stillTicks = 0
      }
      if (controls.back) rec.backward++
      if (wasGround && !bot.entity.onGround && v.y > 0.2) rec.jumps++
      if (wasForward && !controls.forward && bot.pathfinder.isMoving()) rec.forwardGaps++
      wasForward = controls.forward
    }
    lastYaw = wire.yaw
    lastPitch = wire.pitch
    const waiters = tickWaiters
    tickWaiters = []
    for (const w of waiters) w()
  }

  bot.waitForTicks = n => new Promise(resolve => {
    let left = Math.max(1, n)
    const next = () => { if (--left <= 0) resolve(); else tickWaiters.push(next) }
    tickWaiters.push(next)
  })

  // pathfinder.goto settles on a 0 ms timer. On a real server that lands well inside the 50 ms tick, here a tick takes far
  // less than a millisecond, so the next tick waits for it, or every walk would seem to end in a stop that is not real
  let settling = false
  for (const ev of ['goal_reached', 'goal_updated', 'path_update', 'path_stop']) bot.on(ev, () => { settling = true })

  // runs ticks until done() is true or the tick limit. True when done() came true
  async function until (done, limit = 1200) {
    for (let i = 0; i < limit; i++) {
      if (done()) return true
      tick()
      if (settling) {
        settling = false
        await new Promise(resolve => setTimeout(resolve, 2))
      } else await new Promise(resolve => setImmediate(resolve))
    }
    return done()
  }

  // runs a promise to its end with the world ticking, up to the limit
  async function drive (promise, limit = 1200) {
    let settled = false
    let error = null
    let value
    promise.then(v => { settled = true; value = v }, e => { settled = true; error = e })
    await until(() => settled, limit)
    if (!settled) throw new Error(`still walking after ${limit} ticks at ${bot.entity.position}`)
    if (error) throw error
    return value
  }

  function report () {
    const minutes = (rec.ticks * TICK_S) / 60 || 1
    return {
      seconds: +(rec.ticks * TICK_S).toFixed(2),
      pauses: rec.pauses,
      pausesPerMinute: +(rec.pauses / minutes).toFixed(1),
      longestStillS: +(rec.longest * TICK_S).toFixed(2),
      replans: rec.replans,
      resets: rec.resets,
      maxCameraStepDeg: +((rec.maxCameraStep * 180) / Math.PI).toFixed(1),
      jumps: rec.jumps,
      backwardTicks: rec.backward,
      forwardGaps: rec.forwardGaps
    }
  }

  return { bot, world, moves, digs, tick, until, drive, report, camera: () => ({ yaw: wire.yaw, pitch: wire.pitch }), setCounting: v => { counting = v } }
}

// Carves the staircase the miner digs: going along +z and down, each column open for 3 blocks. Returns the standing
// cells from the top down. Stone all round, so it is a real one wide tunnel
function carveStairs (world, top, steps) {
  const cells = []
  for (let i = 0; i <= steps; i++) {
    const c = new Vec3(top.x, top.y - i, top.z + i)
    for (let dy = 0; dy <= 2; dy++) world.set(c.offset(0, dy, 0), 'air')
    cells.push(c)
  }
  return cells
}

// A one wide, two high level tunnel along +z. Returns its cells
function carveTunnel (world, from, length) {
  const cells = []
  for (let i = 0; i <= length; i++) {
    const c = from.offset(0, 0, i)
    world.set(c, 'air')
    world.set(c.offset(0, 1, 0), 'air')
    cells.push(c)
  }
  return cells
}

module.exports = { makePhysicsBot, carveStairs, carveTunnel, PAUSE_TICKS, TICK_S }
