// Builds a Fighter around a stub client from simulator states, for the parity test in test_parity.py.
// Reads {states, acts} as JSON on stdin and prints the inputs, masks and decoded actions.

const path = require('path')
const { Vec3 } = require('vec3')
const client = require(path.join(__dirname, '..', 'fighter.js'))
const { Fighter, EnemyView, SeenBlocks } = client

const v3 = a => new Vec3(a[0], a[1], a[2])
const held = name => (name === 'none' ? null : { name, components: [] })
const ME = 1
const THEM = 2

function stubBot (s) {
  const hotbar = {}
  for (const [slot, name] of Object.entries(s.hotbar)) hotbar[36 + Number(slot)] = { name, components: [] }
  const me = {
    id: ME,
    type: 'player',
    yaw: s.yaw,
    pitch: s.pitch,
    onGround: s.on_ground,
    position: v3(s.pos),
    velocity: v3(s.vel),
    isInWater: s.in_water,
    metadata: {}
  }
  const them = {
    id: THEM,
    type: 'player',
    name: 'player',
    position: v3(s.enemy_pos),
    yaw: s.enemy_yaw,
    heldItem: held(s.enemy_weapon),
    equipment: [held(s.enemy_weapon), { name: 'shield', components: [] }],
    metadata: { 0: s.enemy_sprinting ? 0x08 : 0, 6: s.enemy_sneaking ? 5 : 0, 8: s.enemy_hand, 9: s.enemy_hp }
  }
  if (s.enemy_loaded) them.heldItem.components = [{ type: 'charged_projectiles', data: { projectiles: [{}] } }]
  const controls = { sprint: s.sprinting, sneak: s.sneaking }
  return {
    entity: me,
    entities: { [ME]: me, [THEM]: them },
    players: { rival: { entity: them } },
    health: s.hp,
    heldItem: held(s.weapon),
    quickBarSlot: -1,
    inventory: { hotbarStart: 36, slots: hotbar, items: () => [] },
    getControlState: k => !!controls[k],
    setControlState: (k, v) => { controls[k] = v },
    blockAt: p => (s.eyes_in_water && Math.floor(p.y) === Math.floor(me.position.y + (s.sneaking ? 1.27 : 1.62)) ? { name: 'water' } : null),
    controls
  }
}

function observing (s) {
  const bot = stubBot(s)
  const f = Object.create(Fighter.prototype)
  const e = Object.create(EnemyView.prototype)
  e.bot = bot
  e.username = 'rival'
  e.lookup = null
  e.history = [v3(s.enemy_pos), v3(s.enemy_pos)]
  e.vel = { x: s.enemy_move[0], y: s.enemy_move[1], z: s.enemy_move[2] }
  e.ticksSinceSwing = s.enemy_attack_ticks
  e.ticksSinceSwitch = 100000
  e.ticksSinceHurt = 1000
  e.hurtTimer = s.enemy_hurt
  e.shieldCooldown = s.enemy_shield_cooldown
  e.shieldTicks = Math.max(s.enemy_shield_ticks - 1, 0)
  e.useTicks = s.enemy_use_ticks
  e.damageTaken = 20 - s.enemy_health_known
  e.airborne = () => !s.enemy_on_ground
  f.bot = bot
  f.enemy = e
  f.arena = { x: 0, y: 0, z: 0, half: s.arena_half }
  f.borderHalf = s.border_half
  f.allowedWeapons = null
  f.memory = new SeenBlocks(bot)
  f.fairHealth = false
  f.arrowsSeen = new Map()
  f.arrowOwner = new Map()
  s.arrows.forEach((a, i) => {
    const id = 100 + i
    f.arrowOwner.set(id, a.mine ? ME : THEM)
    f.arrowsSeen.set(id, { pos: v3(a.pos), vel: { x: a.vel[0], y: a.vel[1], z: a.vel[2] }, grounded: false, groundAge: 0 })
  })
  s.stuck.forEach((a, i) => {
    const id = 500 + i
    f.arrowOwner.set(id, ME)
    f.arrowsSeen.set(id, { pos: v3(a.pos), vel: { x: 0, y: 0, z: 0 }, grounded: true, groundAge: a.age })
  })
  f.myShots = new Map()
  f.ticks = s.ticks
  f.ticksSinceSwing = s.attack_ticks
  f.sprintFlag = s.sprinting
  f.shieldUp = s.shield_ticks > 0
  f.shieldTicks = Math.max(s.shield_ticks - 1, 0)
  f.shieldCooldown = s.shield_cooldown
  f.hurtTimer = s.hurt
  f.fall = s.fall
  f.ticksSinceHit = s.since_hit
  f.ticksSinceHurt = s.since_hurt
  f.ticksSinceDisabled = s.since_disabled
  f.ticksSinceWhiff = s.since_whiff
  e.ticksSinceSwing = s.enemy_attack_ticks
  f.enemySwing = s.since_enemy_swing
  f.combo = s.combo
  f.loaded = s.loaded
  f.charging = s.load_ticks > 0
  f.loadTicks = s.load_ticks
  f.loadWait = s.load_wait
  f.drawing = s.draw_ticks > 0
  f.drawTicks = s.draw_ticks
  f.arrows = s.ammo
  f.prevAction = s.last_action
  f.lastMove = { x: s.last_move[0], y: s.last_move[1], z: s.last_move[2] }
  f.sight = { pos: null, move: null, visible: false, chestClear: false, crosshairClear: false, seen: false }
  return f
}

function acting (start) {
  const out = { controls: {}, slot: null, swings: 0, second: false }
  const f = Object.create(Fighter.prototype)
  f.bot = {
    entity: { yaw: start.yaw, pitch: start.pitch, onGround: true, position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0) },
    heldItem: held(start.item),
    quickBarSlot: -1,
    setControlState: (k, v) => { out.controls[k] = v },
    look: (y, p) => { out.yaw = y; out.pitch = p },
    setQuickBarSlot: s => { out.slot = s },
    activateItem: () => {},
    deactivateItem: () => {}
  }
  f.prevAction = client.IDLE_ACTION
  f.shieldUp = false
  f.charging = false
  f.drawing = false
  f.shieldCooldown = 0
  f.sight = { seen: false }
  f.useCrossbow = () => {}
  f.useBow = () => {}
  f.swing = () => { out.swings++ }
  Object.defineProperty(f, 'secondClick', { set (v) { out.second = v }, get () { return out.second } })
  return { f, out }
}

const input = JSON.parse(require('fs').readFileSync(0, 'utf8'))
const reply = { dims: client.ACTION_DIMS, yaw: client.YAW_STEPS, pitch: client.PITCH_STEPS, idle: client.IDLE_ACTION, obsDim: client.OBS_DIM, maskSize: client.MASK_SIZE }
reply.acts = (input.acts || []).map(a => {
  const { f, out } = acting(a.start)
  f.act(a.action)
  return out
})
reply.obs = []
reply.masks = []
for (const s of input.states || []) {
  const f = observing(s)
  // The enemy's swing age is what slot 64 reads and its charge reads the attack ticks
  const charge = f.enemy.ticksSinceSwing
  f.enemy.charge = () => Math.min(Math.max((charge + 0.5) / s.enemy_charge_ticks, 0), 1)
  f.enemy.ticksSinceSwing = s.since_enemy_swing
  reply.obs.push(f.observe())
  reply.masks.push(f.masks().map(Boolean))
}
console.log(JSON.stringify(reply))
