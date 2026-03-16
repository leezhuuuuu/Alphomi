import { app } from 'electron'
import fs from 'fs'
import path from 'path'

export type ThemeMode = 'light' | 'dark' | 'system'

export type AppSettings = {
  themeMode: ThemeMode
  newTabUrl: string
}

const SETTINGS_FILENAME = 'app-settings.json'
const DEFAULT_NEW_TAB_URL = process.env.NEW_TAB_URL || 'https://www.google.com'

const DEFAULT_SETTINGS: AppSettings = {
  themeMode: 'light',
  newTabUrl: DEFAULT_NEW_TAB_URL
}

let cachedSettings: AppSettings | null = null

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILENAME)
}

function ensureSettingsDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

function normalizeThemeMode(value: unknown): ThemeMode {
  return isThemeMode(value) ? value : DEFAULT_SETTINGS.themeMode
}

function normalizeStoredNewTabUrl(value: unknown): string {
  try {
    return validateNewTabUrl(value)
  } catch {
    return DEFAULT_SETTINGS.newTabUrl
  }
}

export function validateNewTabUrl(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) {
    throw new Error('请输入新建标签页地址。')
  }

  if (raw === 'about:blank') {
    return raw
  }

  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) ? raw : `https://${raw}`

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('地址格式无效，请输入可打开的网址。')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('目前只支持 http、https 或 about:blank。')
  }

  return parsed.toString()
}

function sanitizeStoredSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_SETTINGS }
  }

  const record = value as Partial<AppSettings>
  return {
    themeMode: normalizeThemeMode(record.themeMode),
    newTabUrl: normalizeStoredNewTabUrl(record.newTabUrl)
  }
}

export function loadAppSettings(): AppSettings {
  if (cachedSettings) {
    return cachedSettings
  }

  const filePath = getSettingsPath()
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    cachedSettings = sanitizeStoredSettings(JSON.parse(raw))
  } catch {
    cachedSettings = { ...DEFAULT_SETTINGS }
  }

  return cachedSettings
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadAppSettings()
  const next: AppSettings = {
    themeMode: Object.prototype.hasOwnProperty.call(patch, 'themeMode')
      ? normalizeThemeMode(patch.themeMode)
      : current.themeMode,
    newTabUrl: Object.prototype.hasOwnProperty.call(patch, 'newTabUrl')
      ? validateNewTabUrl(patch.newTabUrl)
      : current.newTabUrl
  }

  const filePath = getSettingsPath()
  ensureSettingsDir(filePath)
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8')
  cachedSettings = next
  return next
}
