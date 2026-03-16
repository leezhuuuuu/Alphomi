import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { is } from '@electron-toolkit/utils'
import { parse } from 'yaml'

type LocalStorageScope = 'visited-origins' | 'active-only'
type LocalStorageMerge = 'merge' | 'overwrite' | 'replace_origin'

export type UserDataConfig = {
  enabled: boolean
  mode: 'cookies-only' | 'browser-profile'
  storagePath: string
  profileId: string
  saveIntervalSec: number
  saveDebounceMs: number
  saveMinIntervalSec: number
  saveOnNavigation: boolean
  localStorageScope: LocalStorageScope
  localStorageMerge: LocalStorageMerge
  encrypt: boolean
  maxOrigins: number
}

const CONFIG_NAMES = ['config.yaml', 'config.yml']

const DEFAULTS: UserDataConfig = {
  enabled: false,
  mode: 'cookies-only',
  storagePath: '',
  profileId: 'default',
  saveIntervalSec: 60,
  saveDebounceMs: 3000,
  saveMinIntervalSec: 5,
  saveOnNavigation: true,
  localStorageScope: 'visited-origins',
  localStorageMerge: 'merge',
  encrypt: false,
  maxOrigins: 200
}

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
    if (parent === current) return null
    current = parent
  }
}

function findWorkspaceRoot(startDir: string): string {
  let current = startDir
  while (true) {
    const hasPnpmWorkspace = fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))
    const hasTurbo = fs.existsSync(path.join(current, 'turbo.json'))
    if (hasPnpmWorkspace || hasTurbo) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return startDir
    }
    current = parent
  }
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
  }
  return fallback
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function resolveStoragePath(value: unknown, fallback: string, baseDir: string | null): string {
  if (!value) return fallback
  let raw = String(value)
  if (raw.startsWith('~')) {
    raw = path.join(os.homedir(), raw.slice(1))
  }
  if (path.isAbsolute(raw)) return raw
  const base = baseDir || process.cwd()
  return path.resolve(base, raw)
}

function pickScope(value: unknown, fallback: LocalStorageScope): LocalStorageScope {
  if (value === 'active-only') return 'active-only'
  if (value === 'visited-origins') return 'visited-origins'
  return fallback
}

function pickMergePolicy(value: unknown, fallback: LocalStorageMerge): LocalStorageMerge {
  if (value === 'overwrite') return 'overwrite'
  if (value === 'replace_origin') return 'replace_origin'
  if (value === 'merge') return 'merge'
  return fallback
}

function readUserDataSection(): { section: Record<string, unknown>; configDir: string | null } {
  const configPath = findConfigPath(process.cwd())
  if (!configPath) return { section: {}, configDir: null }
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { section: {}, configDir: path.dirname(configPath) }
    }
    const section = (parsed as Record<string, unknown>)['user_data']
    return {
      section: section && typeof section === 'object' ? (section as Record<string, unknown>) : {},
      configDir: path.dirname(configPath)
    }
  } catch {
    return { section: {}, configDir: path.dirname(configPath) }
  }
}

let cachedConfig: UserDataConfig | null = null

export function loadUserDataConfig(): UserDataConfig {
  if (cachedConfig) return cachedConfig

  const { section, configDir } = readUserDataSection()
  const fallbackStorage = (() => {
    if (is.dev) {
      const root = findWorkspaceRoot(process.cwd())
      return path.join(root, 'temp', 'user-data', 'state.json')
    }
    const userDataDir = app.getPath('userData')
    return path.join(userDataDir, 'state.json')
  })()

  const env = process.env

  const enabled = parseBoolean(env.USER_DATA_ENABLED ?? section.enabled, DEFAULTS.enabled)
  const storagePath = resolveStoragePath(
    env.USER_DATA_STORAGE_PATH ?? section.storage_path,
    fallbackStorage,
    configDir ?? (is.dev ? findWorkspaceRoot(process.cwd()) : null)
  )
  const modeRaw = String(env.USER_DATA_MODE ?? section.mode ?? DEFAULTS.mode)
  const mode: UserDataConfig['mode'] = modeRaw === 'browser-profile' ? 'browser-profile' : 'cookies-only'
  const profileId = String(env.USER_DATA_PROFILE_ID ?? section.profile_id ?? DEFAULTS.profileId)
  const saveIntervalSec = Math.max(0, parseNumber(env.USER_DATA_SAVE_INTERVAL_SEC ?? section.save_interval_sec, DEFAULTS.saveIntervalSec))
  const saveDebounceMs = Math.max(0, parseNumber(env.USER_DATA_SAVE_DEBOUNCE_MS ?? section.save_debounce_ms, DEFAULTS.saveDebounceMs))
  const saveMinIntervalSec = Math.max(
    0,
    parseNumber(env.USER_DATA_SAVE_MIN_INTERVAL_SEC ?? section.save_min_interval_sec, DEFAULTS.saveMinIntervalSec)
  )
  const saveOnNavigation = parseBoolean(
    env.USER_DATA_SAVE_ON_NAVIGATION ?? section.save_on_navigation,
    DEFAULTS.saveOnNavigation
  )
  const localStorageScope = pickScope(env.USER_DATA_LOCAL_STORAGE_SCOPE ?? section.local_storage_scope, DEFAULTS.localStorageScope)
  const localStorageMerge = pickMergePolicy(env.USER_DATA_LOCAL_STORAGE_MERGE ?? section.local_storage_merge, DEFAULTS.localStorageMerge)
  const encrypt = parseBoolean(env.USER_DATA_ENCRYPT ?? section.encrypt, DEFAULTS.encrypt)
  const maxOrigins = Math.max(1, parseNumber(env.USER_DATA_MAX_ORIGINS ?? section.max_origins, DEFAULTS.maxOrigins))

  cachedConfig = {
    enabled,
    mode,
    storagePath,
    profileId,
    saveIntervalSec,
    saveDebounceMs,
    saveMinIntervalSec,
    saveOnNavigation,
    localStorageScope,
    localStorageMerge,
    encrypt,
    maxOrigins
  }

  return cachedConfig
}
