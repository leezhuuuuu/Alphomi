import { copyFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

const sourcePath = path.join(repoRoot, 'packages', 'config', 'defaults', 'config.example.yaml')
const targetPath = path.join(repoRoot, 'config.example.yaml')

const [source, target] = await Promise.all([
  readFile(sourcePath, 'utf8'),
  readFile(targetPath, 'utf8').catch(() => '')
])

if (source === target) {
  console.log('[sync-config-template] root config.example.yaml already matches package source')
  process.exit(0)
}

await copyFile(sourcePath, targetPath)
console.log('[sync-config-template] updated root config.example.yaml from packages/config/defaults/config.example.yaml')
