// What the bot does after an explosion close to it. From any blast within NEAR blocks it logs its mode, goal, position,
// held item, dig state and path for the next 30 s: a line whenever one of them changes, and one every 2 s while nothing
// does. It only reads, so it cannot change what the bot does.

const NEAR = 16
const TRACE_MS = 30000
const EVERY_MS = 250
const QUIET_MS = 2000

const fixed = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '?')
const vec = (p, d = 2) => (p ? `${fixed(p.x, d)} ${fixed(p.y, d)} ${fixed(p.z, d)}` : '?')
const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

// The state worth comparing from one moment to the next. Position and speed are logged but do not count as a change
function readState (bot, ctx, path) {
  const m = ctx?.manager
  const pf = bot.pathfinder
  const dig = bot.targetDigBlock
  return {
    mode: m?.active?.name || 'idle',
    doing: m?.status?.() ?? '?',
    plan: ctx?.plan ? `${(ctx.plan.index ?? 0) + 1}/${ctx.plan.steps?.length ?? '?'}` : 'none',
    goal: pf?.goal?.constructor?.name || 'none',
    moving: pf?.isMoving?.() ? 1 : 0,
    mining: pf?.isMining?.() ? 1 : 0,
    building: pf?.isBuilding?.() ? 1 : 0,
    path: path.status ? `${path.status}/${path.length}` : 'none',
    dig: dig ? `${dig.name}@${vec(dig.position, 0)}` : 'none',
    held: bot.heldItem?.name || 'empty',
    window: bot.currentWindow ? 'open' : 'none',
    keys: KEYS.filter(k => bot.getControlState?.(k)).join('+') || 'none',
    ground: bot.entity?.onGround ? 1 : 0,
    water: bot.entity?.isInWater ? 1 : 0
  }
}

const line = s => Object.entries(s).map(([k, v]) => `${k}=${v}`).join(' ')

// getCtx: the bot's context, read fresh since it is made after the bot joins. Returns tick and active, for the tests
function installBlastTrace (bot, getCtx, log, { now = Date.now, timer = true } = {}) {
  let until = 0
  let started = 0
  let last = null
  let lastAt = 0
  const path = { status: null, length: 0 }

  const tick = () => {
    const t = now()
    if (!until) return
    if (t >= until) {
      log(`${bot.username} blast trace ends after ${fixed((t - started) / 1000, 1)} s`)
      until = 0
      last = null
      return
    }
    try {
      const state = readState(bot, getCtx(), path)
      const text = line(state)
      if (text === last && t - lastAt < QUIET_MS) return
      last = text
      lastAt = t
      log(`${bot.username} blast +${fixed((t - started) / 1000, 1)}s ${text} pos=${vec(bot.entity?.position)} vel=${vec(bot.entity?.velocity)} hp=${fixed(bot.health, 1)}`)
    } catch (err) {
      log(`${bot.username} blast trace: ${err.message}`)
    }
  }

  bot.on('path_update', r => {
    path.status = r?.status || null
    path.length = r?.path?.length ?? 0
  })
  bot._client.on('explosion', p => {
    const c = p?.center || p
    const me = bot.entity?.position
    if (!me || !Number.isFinite(c?.x)) return
    const d = Math.hypot(c.x - me.x, c.y - me.y, c.z - me.z)
    if (d > NEAR) return
    const t = now()
    if (!until) started = t
    until = t + TRACE_MS
    last = null
    log(`${bot.username} blast at ${vec(c)}, ${fixed(d, 1)} blocks away, radius ${fixed(p?.radius, 1)}, ${p?.blockCount ?? '?'} blocks, knockback ${vec(p?.playerKnockback)}`)
    tick()
  })
  if (timer) {
    const interval = setInterval(tick, EVERY_MS)
    interval.unref?.()
    bot.once('end', () => clearInterval(interval))
  }
  return { tick, active: () => !!until }
}

module.exports = { installBlastTrace, readState, NEAR, TRACE_MS, QUIET_MS }
