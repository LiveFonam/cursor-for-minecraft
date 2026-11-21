#!/usr/bin/env node
'use strict'

const { loadConfig } = require('./config')
const { startCrew } = require('./crew')

async function main () {
  const config = loadConfig()
  console.log(`Connecting ${config.bots.length} bot(s) to ${config.host}:${config.port} on ${config.version}.`)
  await startCrew(config)
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
