// Builds the mob director plugin into server-agents/plugins/MobDirector.jar, in the agents' Paper 1.21.11 server. It
// compiles against the Paper API the server already unpacked (server-agents/libraries), so it needs no Gradle and no
// downloads, only a Java Development Kit (JDK) 21: JAVA_HOME or javac on the PATH. MOB_DIRECTOR_SERVER points at
// another server folder.
//
//   node director/scripts/build.js           build and put the jar in server-agents/plugins
//   node director/scripts/build.js --test    also run the shelter and planner tests (no server needed)

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'director')
const OUT = path.join(SRC, 'build')
const SERVER = process.env.MOB_DIRECTOR_SERVER ? path.resolve(process.env.MOB_DIRECTOR_SERVER) : path.join(ROOT, 'server-agents')
const LIBS = path.join(SERVER, 'libraries')
const PLUGINS = path.join(SERVER, 'plugins')
const SEP = process.platform === 'win32' ? ';' : ':'
const EXE = process.platform === 'win32' ? '.exe' : ''

function jdkTool (name) {
  const homes = [process.env.JAVA_HOME].filter(Boolean)
  for (const h of homes) {
    const p = path.join(h, 'bin', name + EXE)
    if (fs.existsSync(p)) return p
  }
  return name
}

function files (dir, ext) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name)
    return d.isDirectory() ? files(p, ext) : (p.endsWith(ext) ? [p] : [])
  })
}

function run (cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`)
  if (r.status !== 0) process.exit(r.status || 1)
}

const libs = files(LIBS, '.jar')
if (!libs.some(j => /paper-api/.test(j))) {
  console.error(`No Paper API in ${LIBS}. Set the server up (bridge/danger_sensing_agents/scripts/setup-server.sh with AGENTS_SERVER_DIR=server-agents) and start it once so it unpacks its libraries there, then build again.`)
  process.exit(1)
}
const cp = libs.join(SEP)
const classes = path.join(OUT, 'classes')
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(classes, { recursive: true })

run(jdkTool('javac'), ['--release', '21', '-Xlint:-options', '-encoding', 'UTF-8', '-cp', cp, '-d', classes, ...files(path.join(SRC, 'src'), '.java')])
for (const f of ['plugin.yml', 'config.yml']) fs.copyFileSync(path.join(SRC, f), path.join(classes, f))
fs.mkdirSync(PLUGINS, { recursive: true })
const jar = path.join(PLUGINS, 'MobDirector.jar')
run(jdkTool('jar'), ['--create', '--file', jar, '-C', classes, '.'])
console.log(`built ${path.relative(ROOT, jar)} (restart the server to load it)`)

if (process.argv.includes('--test')) {
  const tests = path.join(OUT, 'test-classes')
  fs.mkdirSync(tests, { recursive: true })
  run(jdkTool('javac'), ['--release', '21', '-Xlint:-options', '-encoding', 'UTF-8', '-cp', classes + SEP + cp, '-d', tests, ...files(path.join(SRC, 'test'), '.java')])
  for (const t of ['ShelterTest', 'PlannerTest']) run(jdkTool('java'), ['-cp', [tests, classes, cp].join(SEP), 'cursor.director.' + t])
}
