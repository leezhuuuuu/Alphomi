import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

const checks = []

function pass(message) {
  checks.push({ level: 'PASS', message })
}

function warn(message) {
  checks.push({ level: 'WARN', message })
}

function fail(message) {
  checks.push({ level: 'FAIL', message })
}

function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    return null
  }
  return (result.stdout || result.stderr || '').trim().split('\n')[0]
}

async function fileExists(relativePath) {
  try {
    await access(path.join(repoRoot, relativePath))
    return true
  } catch {
    return false
  }
}

const nodeVersion = process.version.replace(/^v/, '')
const [major, minor] = nodeVersion.split('.').map(Number)
if (major > 18 || (major === 18 && minor >= 18)) {
  pass(`Node.js ${process.version}`)
} else {
  fail(`Node.js ${process.version} is too old; expected >= 18.18.0`)
}

const pnpmVersion = commandVersion('pnpm')
if (pnpmVersion) {
  pass(`pnpm ${pnpmVersion}`)
} else {
  fail('pnpm is not available in PATH')
}

const pythonVersion = commandVersion('python3')
if (pythonVersion) {
  pass(`python3 ${pythonVersion}`)
} else {
  fail('python3 is not available in PATH')
}

const uvVersion = commandVersion('uv')
if (uvVersion) {
  pass(`uv ${uvVersion}`)
} else {
  warn('uv is not installed; bootstrap will fall back to venv + pip')
}

for (const relPath of [
  'config.example.yaml',
  'packages/config/defaults/config.example.yaml',
  'apps/desktop/package.json',
  'apps/driver/package.json',
  'apps/brain/pyproject.toml',
  'docs/guides/development.md'
]) {
  if (await fileExists(relPath)) {
    pass(`found ${relPath}`)
  } else {
    fail(`missing ${relPath}`)
  }
}

if (await fileExists('config.yaml')) {
  pass('found config.yaml')
} else {
  warn('config.yaml is missing; run `pnpm bootstrap` to generate it')
}

if (await fileExists('apps/brain/dist/alphomi-brain')) {
  pass('found bundled Brain binary')
} else {
  warn('Brain binary not built yet; run `pnpm build:brain` when preparing packaged releases')
}

for (const { level, message } of checks) {
  const prefix = level === 'PASS' ? '[pass]' : level === 'WARN' ? '[warn]' : '[fail]'
  console.log(`${prefix} ${message}`)
}

const failures = checks.filter((item) => item.level === 'FAIL').length
if (failures > 0) {
  console.error(`[doctor] found ${failures} blocking issue(s)`)
  process.exit(1)
}

console.log('[doctor] environment looks good')
