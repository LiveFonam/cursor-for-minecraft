// The recipe generator reads a server jar, directly or from inside a bundler jar:  node --test bridge/danger_sensing_agents/test/

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SCRIPT = path.join(__dirname, '..', 'tools', 'generate_recipes.py')
const HAS_PYTHON = spawnSync('python3', ['--version']).status === 0

const MAKE_JARS = `
import io, json, sys, zipfile
inner = io.BytesIO()
with zipfile.ZipFile(inner, "w") as z:
    z.writestr("version.json", json.dumps({"id": "1.21.11"}))
    z.writestr("data/minecraft/recipe/stick.json", json.dumps({"result": {"id": "minecraft:stick", "count": 4}}))
    z.writestr("data/minecraft/tags/item/planks.json", json.dumps({"values": ["minecraft:oak_planks", "#minecraft:logs"]}))
open(sys.argv[1], "wb").write(inner.getvalue())
with zipfile.ZipFile(sys.argv[2], "w") as z:
    z.writestr("META-INF/versions/1.21.11/server-1.21.11.jar", inner.getvalue())
`

test('builds the recipe file from a plain jar and a bundler jar', { skip: !HAS_PYTHON }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recipes-'))
  const plain = path.join(dir, 'server.jar')
  const bundler = path.join(dir, 'bundler.jar')
  assert.equal(spawnSync('python3', ['-c', MAKE_JARS, plain, bundler]).status, 0)
  for (const jar of [plain, bundler]) {
    const out = path.join(dir, `${path.basename(jar)}.json`)
    const run = spawnSync('python3', [SCRIPT, jar, '--out', out], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const data = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.equal(data.version, '1.21.11')
    assert.equal(data.recipes.stick.result.count, 4)
    assert.deepEqual(data.item_tags.planks, ['minecraft:oak_planks', '#minecraft:logs'])
  }
  fs.rmSync(dir, { recursive: true })
})

test('refuses a file that is not a server jar', { skip: !HAS_PYTHON }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-recipes-'))
  const jar = path.join(dir, 'other.jar')
  const make = 'import sys, zipfile; zipfile.ZipFile(sys.argv[1], "w").writestr("a.txt", "a")'
  assert.equal(spawnSync('python3', ['-c', make, jar]).status, 0)
  const run = spawnSync('python3', [SCRIPT, jar, '--out', path.join(dir, 'out.json')], { encoding: 'utf8' })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /not a Minecraft server jar/)
  fs.rmSync(dir, { recursive: true })
})
