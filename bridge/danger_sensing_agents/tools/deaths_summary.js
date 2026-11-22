#!/usr/bin/env node
// Counts a run folder's deaths.jsonl by cause:  node tools/deaths_summary.js <deaths.jsonl or run folder>

const fs = require('fs')
const path = require('path')
const { summarize } = require('../death_log')

const arg = process.argv[2]
if (!arg) {
  console.error('usage: deaths_summary.js <deaths.jsonl or run folder>')
  process.exit(2)
}
const file = fs.existsSync(arg) && fs.statSync(arg).isDirectory() ? path.join(arg, 'deaths.jsonl') : arg
if (!fs.existsSync(file)) {
  console.log('no deaths recorded')
  process.exit(0)
}
const lines = []
for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!l.trim()) continue
  try { lines.push(JSON.parse(l)) } catch {}  // a line cut short by a crash
}
const out = summarize(lines)
console.log(`${out.total} deaths`)
for (const c of out.causes) {
  const scenes = Object.entries(c.scenes).map(([s, n]) => `${s} ${n}`).join(', ')
  console.log(`${String(c.count).padStart(3)}  ${c.cause.padEnd(12)} ${scenes}`)
}
