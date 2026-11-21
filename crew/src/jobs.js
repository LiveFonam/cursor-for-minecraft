'use strict'

const { goNear, follow } = require('./skills/move')
const { sleep, throwIfAborted } = require('./skills/abort')
const { gather } = require('./skills/gather')
const { mine, newProgress } = require('./skills/mine')
const { craftItem } = require('./skills/craft')
const { buildBlueprint } = require('./skills/build')
const { farmWheat } = require('./skills/farm')
const { countItem } = require('./skills/inventory')

// A job is { name, run(signal) }. Its run can be called again after a fight
// or a survival break, so each job keeps its progress outside run.

function ownerEntity (ctx) {
  return ctx.bot.players[ctx.config.owner]?.entity ?? null
}

function comeJob (ctx) {
  return {
    name: 'come',
    async run (signal) {
      const owner = ownerEntity(ctx)
      if (!owner) throw new Error('I cannot see you')
      await goNear(ctx.bot, owner.position, 2, { movements: ctx.movements.safe, signal })
      return 'Here.'
    }
  }
}

function followJob (ctx) {
  return {
    name: 'follow',
    run: signal => follow(ctx.bot, () => ownerEntity(ctx), { movements: ctx.movements.safe, signal })
  }
}

function guardJob (ctx, anchor) {
  return {
    name: 'guard',
    guardAnchor: anchor,
    async run (signal) {
      while (true) {
        throwIfAborted(signal)
        if (ctx.bot.entity.position.distanceTo(anchor) > 3) {
          await goNear(ctx.bot, anchor, 2, { movements: ctx.movements.safe, signal }).catch(err => {
            if (err.name === 'AbortedError') throw err
          })
        }
        await sleep(500, signal)
      }
    }
  }
}

function mineJob (ctx, target, count) {
  const progress = newProgress()
  return {
    name: `mine ${target.name}`,
    async run (signal) {
      const done = await mine(ctx.bot, target, count, { movements: ctx.movements.dig, signal, progress })
      return done >= count
        ? `Mined ${done} ${target.name}.`
        : `Stopped at ${done} of ${count} ${target.name}. I found no more nearby.`
    }
  }
}

function gatherJob (ctx, target, count) {
  let done = 0
  return {
    name: `gather ${target.name}`,
    async run (signal) {
      const before = countItem(ctx.bot, target.items)
      try {
        await gather(ctx.bot, {
          blockNames: target.blocks,
          itemNames: target.items,
          count: count - done,
          movements: ctx.movements.safe,
          signal
        })
      } finally {
        done += Math.max(0, countItem(ctx.bot, target.items) - before)
      }
      return done >= count
        ? `Gathered ${done} ${target.name}.`
        : `Stopped at ${done} of ${count} ${target.name}. I found no more nearby.`
    }
  }
}

function craftJob (ctx, itemName, count) {
  let crafted = false
  return {
    name: `craft ${itemName}`,
    async run (signal) {
      if (!crafted) {
        await craftItem(ctx.bot, itemName, count, { movements: ctx.movements.safe, signal })
        crafted = true
      }
      return `Crafted ${count} ${itemName}.`
    }
  }
}

function buildJob (ctx, blueprint, origin) {
  return {
    name: `build ${blueprint.name}`,
    async run (signal) {
      const result = await buildBlueprint(ctx.bot, blueprint, origin, { movements: ctx.movements.safe, signal })
      return result.failed === 0
        ? `Built ${blueprint.name}.`
        : `Built ${blueprint.name}, but ${result.failed} of ${result.total} cells are not right.`
    }
  }
}

function farmJob (ctx, anchor) {
  return {
    name: 'farm',
    run: signal => farmWheat(ctx.bot, anchor, { movements: ctx.movements.safe, signal })
  }
}

module.exports = { ownerEntity, comeJob, followJob, guardJob, mineJob, gatherJob, craftJob, buildJob, farmJob }
