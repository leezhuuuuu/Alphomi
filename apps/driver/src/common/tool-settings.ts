import fs from 'fs'
import path from 'path'

type SharedToolSettingsPayload = {
  version?: number
  updatedAt?: string
  tools?: Record<string, unknown>
}

let cachedPath: string | null = null
let cachedMtimeMs = -1
let cachedToolStates: Record<string, boolean> = {}

function findWorkspaceRoot(startDir: string): string | null {
  let current = startDir
  while (true) {
    const hasWorkspace = fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))
    const hasTurbo = fs.existsSync(path.join(current, 'turbo.json'))
    if (hasWorkspace || hasTurbo) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

export function resolveToolSettingsPath(): string | null {
  const fromEnv = process.env.ALPHOMI_TOOL_SETTINGS_PATH?.trim()
  if (fromEnv) {
    return path.resolve(fromEnv)
  }

  const workspaceRoot = findWorkspaceRoot(process.cwd())
  if (!workspaceRoot) {
    return null
  }

  return path.join(workspaceRoot, 'temp', 'tool-settings.json')
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(lowered)) return true
    if (['false', '0', 'no', 'n', 'off'].includes(lowered)) return false
  }
  return null
}

export function loadToolStates(): Record<string, boolean> {
  const filePath = resolveToolSettingsPath()
  if (!filePath || !fs.existsSync(filePath)) {
    cachedPath = filePath
    cachedMtimeMs = -1
    cachedToolStates = {}
    return cachedToolStates
  }

  const stat = fs.statSync(filePath)
  if (cachedPath === filePath && cachedMtimeMs === stat.mtimeMs) {
    return cachedToolStates
  }

  let parsed: SharedToolSettingsPayload | null = null
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SharedToolSettingsPayload
  } catch {
    parsed = null
  }

  const next: Record<string, boolean> = {}
  const tools = parsed?.tools
  if (tools && typeof tools === 'object') {
    for (const [name, value] of Object.entries(tools)) {
      const normalized = normalizeBoolean(value)
      if (normalized !== null) {
        next[name] = normalized
      }
    }
  }

  cachedPath = filePath
  cachedMtimeMs = stat.mtimeMs
  cachedToolStates = next
  return cachedToolStates
}

export function isToolEnabled(name: string): boolean {
  const states = loadToolStates()
  return states[name] !== false
}
