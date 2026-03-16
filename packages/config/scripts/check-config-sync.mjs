import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(packageRoot, '..', '..')

const rootConfigPath = path.join(repoRoot, 'config.example.yaml')
const packageConfigPath = path.join(packageRoot, 'defaults', 'config.example.yaml')
const configGuidePath = path.join(repoRoot, 'docs', 'guides', 'configuration.md')

const [rootConfig, packageConfig, guide] = await Promise.all([
  readFile(rootConfigPath, 'utf8'),
  readFile(packageConfigPath, 'utf8'),
  readFile(configGuidePath, 'utf8')
])

if (rootConfig !== packageConfig) {
  throw new Error('Root config.example.yaml must stay in sync with packages/config/defaults/config.example.yaml. Run `pnpm sync:config-template`.')
}

for (const section of ['driver:', 'user_data:', 'brain:', 'desktop:', 'skills:']) {
  if (!rootConfig.includes(section)) {
    throw new Error(`Missing config section in template: ${section}`)
  }
}

for (const phrase of ['LLM_BASE_URL', 'pnpm bootstrap', 'config.yaml']) {
  if (!guide.includes(phrase)) {
    throw new Error(`Configuration guide is missing required phrase: ${phrase}`)
  }
}

console.log('[config] config template and guide are in sync')
