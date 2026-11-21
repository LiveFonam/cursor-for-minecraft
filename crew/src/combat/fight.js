'use strict'

const { isLive } = require('./targets')

const MATERIALS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']

function weaponScore (name) {
  const match = /^(wooden|golden|stone|iron|diamond|netherite)_(sword|axe)$/.exec(name)
  if (!match) return -1
  return MATERIALS.indexOf(match[1]) * 2 + (match[2] === 'sword' ? 1 : 0)
}

function bestWeapon (bot) {
  let best = null
  let bestScore = -1
  for (const item of bot.inventory.items()) {
    const score = weaponScore(item.name)
    if (score > bestScore) {
      best = item
      bestScore = score
    }
  }
  return best
}

// Every attack in the crew goes through this function, and it is the only
// code that touches mineflayer-pvp. It resolves to one outcome string:
// defeated, gone, lost, died, timeout or aborted.
async function fight (bot, target, { signal, timeoutMs = 60000, pollMs = 250, loseDistance = 32 } = {}) {
  if (signal?.aborted) return 'aborted'
  if (!isLive(target)) return 'gone'

  const weapon = bestWeapon(bot)
  if (weapon && bot.heldItem?.type !== weapon.type) {
    await bot.equip(weapon, 'hand').catch(() => {})
    if (signal?.aborted) return 'aborted'
    if (!isLive(target)) return 'gone'
  }

  // Clear any earlier target first, so its stop event cannot end this fight.
  if (bot.pvp.target) bot.pvp.forceStop()

  return new Promise(resolve => {
    let done = false
    const onDead = entity => { if (entity === target) finish('defeated') }
    const onGone = entity => { if (entity === target) finish('gone') }
    const onStopped = () => finish('gone')
    const onDeath = () => finish('died')
    const onAbort = () => finish('aborted')
    const poll = setInterval(() => {
      if (!isLive(target)) finish('gone')
      else if (target.position.distanceTo(bot.entity.position) > loseDistance) finish('lost')
    }, pollMs)
    const timer = setTimeout(() => finish('timeout'), timeoutMs)

    function finish (outcome) {
      if (done) return
      done = true
      clearInterval(poll)
      clearTimeout(timer)
      bot.removeListener('entityDead', onDead)
      bot.removeListener('entityGone', onGone)
      bot.removeListener('stoppedAttacking', onStopped)
      bot.removeListener('death', onDeath)
      signal?.removeEventListener('abort', onAbort)
      if (bot.pvp.target === target) bot.pvp.forceStop()
      resolve(outcome)
    }

    bot.on('entityDead', onDead)
    bot.on('entityGone', onGone)
    bot.on('stoppedAttacking', onStopped)
    bot.on('death', onDeath)
    signal?.addEventListener('abort', onAbort, { once: true })

    Promise.resolve(bot.pvp.attack(target)).catch(() => finish('lost'))
  })
}

// Applies the combat settings. Called once when a bot joins.
function configureFight (bot, movements) {
  bot.pvp.movements = movements
  bot.pvp.viewDistance = 32
  bot.pvp.attackRange = 3
}

module.exports = { fight, configureFight, bestWeapon, weaponScore }
