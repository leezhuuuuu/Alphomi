import fs from 'fs'
import path from 'path'

export type LocalStorageMap = Record<string, Record<string, string>>

export type StorageStateFile = {
  version: number
  profileId: string
  updatedAt: string
  cookies: any[]
  localStorage: LocalStorageMap
  visitedOrigins: string[]
}

const CURRENT_VERSION = 1

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function safeParseJson(raw: string): any | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function loadStorageState(storagePath: string, profileId: string): StorageStateFile | null {
  if (!fs.existsSync(storagePath)) return null
  try {
    const raw = fs.readFileSync(storagePath, 'utf8')
    const parsed = safeParseJson(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.version !== CURRENT_VERSION) return null
    if (parsed.profileId && parsed.profileId !== profileId) return null

    return {
      version: CURRENT_VERSION,
      profileId,
      updatedAt: String(parsed.updatedAt || new Date().toISOString()),
      cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
      localStorage: parsed.localStorage && typeof parsed.localStorage === 'object' ? parsed.localStorage : {},
      visitedOrigins: Array.isArray(parsed.visitedOrigins) ? parsed.visitedOrigins : []
    }
  } catch {
    return null
  }
}

export function buildStorageState(payload: {
  profileId: string
  cookies: any[]
  localStorage: LocalStorageMap
  visitedOrigins: string[]
}): StorageStateFile {
  return {
    version: CURRENT_VERSION,
    profileId: payload.profileId,
    updatedAt: new Date().toISOString(),
    cookies: payload.cookies,
    localStorage: payload.localStorage,
    visitedOrigins: payload.visitedOrigins
  }
}

export function saveStorageState(storagePath: string, state: StorageStateFile): void {
  ensureDir(storagePath)
  const tmpPath = `${storagePath}.tmp`
  const backupPath = `${storagePath}.bak`
  const data = JSON.stringify(state, null, 2)
  fs.writeFileSync(tmpPath, data, 'utf8')
  if (fs.existsSync(storagePath)) {
    try {
      fs.copyFileSync(storagePath, backupPath)
    } catch {
      // ignore backup failure
    }
  }
  fs.renameSync(tmpPath, storagePath)
}
