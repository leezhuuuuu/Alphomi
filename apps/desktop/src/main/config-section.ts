import fs from 'fs'
import path from 'path'
import { parse } from 'yaml'

const CONFIG_NAMES = ['config.yaml', 'config.yml']

function findConfigPath(startDir: string): string | null {
  let current = startDir
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(current, name)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

export function readConfigSection(sectionName: string): {
  section: Record<string, unknown>
  configDir: string | null
} {
  const configPath = findConfigPath(process.cwd())
  if (!configPath) {
    return { section: {}, configDir: null }
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { section: {}, configDir: path.dirname(configPath) }
    }

    const section = (parsed as Record<string, unknown>)[sectionName]
    return {
      section: section && typeof section === 'object' ? (section as Record<string, unknown>) : {},
      configDir: path.dirname(configPath)
    }
  } catch {
    return { section: {}, configDir: path.dirname(configPath) }
  }
}
